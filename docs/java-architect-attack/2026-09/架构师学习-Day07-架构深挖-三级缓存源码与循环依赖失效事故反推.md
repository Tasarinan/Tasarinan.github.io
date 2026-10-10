# Day07：架构深挖 - 三级缓存源码级深挖与循环依赖失效事故反推

> 日期：2026年09月13日（周日）
> 周主题：Spring 核心源码第1周 - IoC 容器启动流程 / Bean 生命周期与扩展点 / 循环依赖三级缓存 / AOP 与动态代理 / 实战综合
> 深挖日：Day07 - 三级缓存源码级深挖与 @Async 撞环失效事故反推（earlySingletonExposure / getEarlyBeanReference / earlyProxyReferences 记账 / 一致性核对 / 四形态判别 / 四防闭环）

---

## 一、今日主题

本周 Day01-Day06 完成了 Spring 核心源码专题的完整学习：

```text
Day01：IoC 容器启动流程（两阶段设计 / refresh 12 步 / BFPP-BPP 分层 / 启动三笔账）
Day02：Bean 生命周期与扩展点（doCreateBean 三大步 / 就绪四层 / 销毁逆序 / BPP 纪律）
Day03：循环依赖与三级缓存（可解性第一性原理 / 14 步时序 / ObjectFactory 延迟决策 / 闸门治理）
Day04：AOP 与动态代理（实现链路 / 拦截链洋葱模型 / @Transactional 失效全图 / 失效地图收官）
Day05：实战综合（启动画像与提速 / 三类报错排查 / 自调用资损 STAR / 三防线）
Day06：串联整合 - 续方功能发布三连事故全链路复盘（循环依赖 + 自调用资损 + 窗口放大）
```

Day06 把五天知识串成了完整事故线，但有一个维度我们一直停留在"结论层"：**三级缓存与代理创建的源码级联动，以及它失效时的报错形态判别**。回顾本周，每个点都"知道结论"，但从未讲透：

```text
Day03 讲了"三级缓存三级查找"，但只讲了读路径——
      没讲写路径的开关条件（earlySingletonExposure 三条件）：
      Boot 2.6 闸门的实现不是"检测器"，而是釜底抽薪的"关闭暴露窗口"——
      闸门 false 时工厂根本不注册，这个设计选择本身就是考点
Day03 讲了"第 13 步一致性核对"，但只讲了它防什么——
      没讲它的完整源码分支（exposedObject == bean / allowRawInjectionDespiteWrapping /
      hasDependentBean 三重条件）与它在什么组合下抛出哪种异常
Day04 讲了"@Async 撞环报错、@Transactional 免疫"，但只给了结论——
      没讲分歧点的源码（getEarlyBeanReference 的实现者与未实现者）、
      earlyProxyReferences 的记账机制、"为什么事务代理时初始化阶段反而返回原始对象"
Day06 事故1 只覆盖了构造器环的报错形态——
      而"raw version ... eventually wrapped"这种报错，团队的排查走了 2 小时弯路
```

更关键的是：**循环依赖家族的报错有四种形态，形态之间面目迥异，但源码层的分叉点只有两三处**。判别力 = 对分叉点的掌握。结合用户业务背景做"三次复发"叙事：**Day06 的三连事故修复后 30 天，问诊系统的另一个老服务（notification-service）在"审核结果异步通知"需求中再次撞上循环依赖**——这次的环是能解的字段环、注解是看似无害的 @Async，报错文案与上次完全不同，团队排查走偏两小时。**同一个知识缺陷，换一件马甲就再次收费**——这就是为什么必须深挖到源码分叉点。

---

## 二、题目：@Async 撞环失效事故场景（第 31 天）

### 2.1 背景：Day06 修复后的现状

```text
notification-service（通知服务，老服务，5 实例）——问诊系统的通知出口
  - 审核结果通知新需求：ReviewResultNotifier.push() 推送医生端+患者端，
    推送量大（审核高峰 2000+ TPS），加 @Async 异步化——看起来人畜无害的一行注解
  - 该服务存在存量字段环（历史遗留，治理未完成）：
      ReviewResultNotifier ──@Autowired──→ TemplateRenderService（查通知模板）
      TemplateRenderService ──@Autowired──→ ReviewResultNotifier（触发模板预热）
    双方字段注入 → 三级缓存本可化解 → 服务此前一直正常启动
  - allow-circular-references=true（存量遗留——闸门治理只完成了 prescription-service）
```

### 2.2 现象1：启动失败，报错文案"看不懂"

```text
周一 21:40 发布，第一台 CrashLoopBackOff：

org.springframework.beans.factory.BeanCurrentlyInCreationException:
Error creating bean 'reviewResultNotifier':
Bean with name 'reviewResultNotifier' has been injected into other beans
[templateRenderService] in its raw version as part of a circular reference,
but has eventually been wrapped. This means that said other beans do not use
the final version of the bean. This is often the result of over-eager type
matching - consider using 'getBeanNamesOfType' with the 'allowEagerInit' flag
turned off, or in case of a factory method, with the 'allowRawInjectionDespiteWrapping'
flag set to true.
```

**团队的反应链**：报错里没有一个 "@Async" 字样；提到的 templateRenderService 看起来毫无嫌疑（三天没改过）——**报错指向的是"环的另一方"，而不是"被注解改变行为的这一方"**。

### 2.3 现象2：三组对照实验，疑惑加深

```text
实验A：删掉 @Async → 启动成功（相关性确认，机制不明）
实验B：@Async 换成 @Transactional → 启动成功（"同样是代理增强，凭什么你行"）
实验C：保留 @Async，把 TemplateRenderService 注入点加 @Lazy → 启动成功（能用但没人说清为什么）
```

### 2.4 现象3：有人开了 allowRawInjectionDespiteWrapping

```text
有人按报错提示尝试 allowRawInjectionDespiteWrapping=true → 启动"成功"了。
但 reviewResultNotifier 的 @Async 在"经 TemplateRenderService 的调用路径上"全部失效——
通知在请求线程里同步执行，高峰期拖慢了模板渲染接口。
强扭的瓜不但不甜，还有毒：报错消失 ≠ 问题解决，只是把"不一致"静默化了。
```

### 2.5 要求

1. 从源码层解释四个现象（为什么字段环+@Async 必炸、@Transactional 为什么免疫、@Lazy 为什么能解、allowRawInjectionDespiteWrapping 为什么危险）
2. 给出正确的修复方案（按优先级）
3. 产出循环依赖家族报错的**四形态判别表**
4. 把本次事故纳入四防闭环（防产生/防暴露/防失效/防误诊）

---

## 三、需要回答的问题

1. earlySingletonExposure 的三个条件分别是什么？Boot 2.6 闸门的实现为什么是"关闭暴露"而不是"增加检测"？
2. doCreateBean 结尾一致性核对的完整源码分支？什么组合抛 BeanCurrentlyInCreationException、什么组合静默放过？
3. AbstractAutoProxyCreator 的 earlyProxyReferences 记账如何保证"代理全局唯一且提前/正式只创建一次"？为什么事务代理场景 initializeBean 阶段反而"什么都不做"？
4. AsyncAnnotationBeanPostProcessor 为什么没有 getEarlyBeanReference？这如何一步步导致 raw version 报错？
5. @Lazy 剪环的源码机制（LazyResolutionProxy 何时解析依赖）？
6. 四种报错形态的判别表与"30 秒定位法"？

---

## 四、作答区：逐模块源码级深挖

### 4.1 暴露窗口的开关：earlySingletonExposure 三条件

```java
// AbstractAutowireCapableBeanFactory.doCreateBean（节选）
boolean earlySingletonExposure =
        (mbd.isSingleton()                    // 条件1：单例（prototype 无缓存体系）
      && this.allowCircularReferences         // 条件2：全局开关（Boot 2.6 闸门在这生效！）
      && isSingletonCurrentlyInCreation(beanName)); // 条件3：正在创建中（只有环场景才需要暴露）

if (earlySingletonExposure) {
    addSingletonFactory(beanName, () -> getEarlyBeanReference(beanName, mbd, bean));
    //                          ↑ 工厂捕获的正是"SmartInstantiationAwareBPP 链的咨询结果"
}
```

**三个源码级认知**：

1. **闸门的实现是釜底抽薪**：allowCircularReferences=false 时，**工厂根本不注册**——不是加了什么"环检测器"，而是让"提前暴露"这个能力整体不存在。环走到 getSingleton 时三级缓存永远是空的 → inCreation 集合兜底报错。**Spring 没有为"禁止"写新代码，只是拒绝了"通融"**——最小实现达成最大语义变化，这是 API 设计的高级手法（对比"加一个 detectCircularReferences 开关+检测算法"的笨重方案）
2. **条件3 保证零成本**：只有"正在创建中"的 Bean 才注册工厂——正常（无环）路径下，addSingletonFactory 注册的工厂永远不会被消费，第 11 步 addSingleton 时顺手清掉。**为极端场景准备的能力对正常路径零开销**（Day03"工厂存的是还没做的决定"的源码落点）
3. **工厂里的 getEarlyBeanReference 是 BPP 链**：`getEarlyBeanReference(beanName, mbd, bean)` 会遍历**所有 SmartInstantiationAwareBeanPostProcessor** 依次调用（返回值链式传递）——谁实现谁参与"提前形态决策"。**@Async 与 @Transactional 的命运分叉，就在"谁是 SmartInstantiationAwareBPP"这一点上**（4.4 展开）

### 4.2 一致性核对：doCreateBean 结尾的完整分支

```java
// doCreateBean 尾部（决定"最终暴露谁"的 12 行）
if (earlySingletonExposure) {
    Object earlySingletonReference = getSingleton(beanName, false);  // 只查一二级，绝不碰三级
    if (earlySingletonReference != null) {          // 非null = 曾被提前消费过（环发生过）
        if (exposedObject == bean) {
            // 分支①：初始化阶段没有替换对象 → 统一用早期引用（可能是提前生成的代理）
            exposedObject = earlySingletonReference;
        }
        else if (!this.allowRawInjectionDespiteWrapping && hasDependentBean(beanName)) {
            // 分支②：初始化阶段替换了对象（被 wrap 了），且确实有依赖者拿到了早期版本
            //   且不允许"裸注入被包装 Bean" → 检查依赖者们是否还在用早期版本
            for (String dependentBean : getDependentBeans(beanName)) {
                if (!removeSingletonIfCreatedForTypeCheckOnly(dependentBean)) {
                    // 依赖者是真实依赖（不是类型检查临时建的）→ 抛错！
                    throw new BeanCurrentlyInCreationException(beanName,
                        "Bean with name '" + beanName + "' has been injected into other beans ["
                        + dependentBean + "] in its raw version as part of a circular reference, "
                        + "but has eventually been wrapped. ...");
                }
            }
        }
    }
}
// exposedObject 最终 addSingleton 进一级缓存
```

**分支决策表（这张表就是事故的判别核心）**：

| earlySingletonReference | exposedObject == bean？ | allowRawInjectionDespiteWrapping | 结果 |
|---|---|---|---|
| null（没被提前消费） | 任意 | 任意 | 正常：暴露 initializeBean 的产物（含正式代理） |
| 非 null（环发生过） | 是（初始化没换对象） | 任意 | **统一**：暴露早期引用（提前生成的代理）——事务场景走这条 |
| 非 null | 否（初始化换了对象） | false（默认） | **抛 raw version 异常**——@Async 场景走这条 |
| 非 null | 否 | true（用户强开） | **静默不一致**：环里注入的是 raw，容器里的是代理——现象3 的毒瓜 |

**getSingleton(beanName, false) 的深意**：`false` 表示"不允许再触发三级工厂"——一致性核对只是**回头看**"有没有人提前消费过我"，绝不能在此刻自己生产一个新引用出来。一个 boolean 参数区分了两个语义完全不同的调用场景（Day03 埋的伏笔在此收口）。

### 4.3 earlyProxyReferences：代理全局唯一的记账机制

AbstractAutoProxyCreator（事务/AOP 代理的创建者）同时实现了两个角色：

```java
// 角色1：SmartInstantiationAwareBeanPostProcessor（循环依赖时被工厂调用）
private final Map<Object, Boolean> earlyProxyReferences = new ConcurrentHashMap<>(16);

@Override
public Object getEarlyBeanReference(Object bean, String beanName) {
    Object cacheKey = getCacheKey(bean.getClass(), beanName);
    this.earlyProxyReferences.put(cacheKey, Boolean.TRUE);   // ★ 记账：这个Bean的代理已提前创建
    return wrapIfNecessary(bean, beanName, cacheKey);        // 此刻生成代理（提前暴露的就是代理）
}

// 角色2：普通 BeanPostProcessor（正常流程的初始化后阶段）
@Override
public Object postProcessAfterInitialization(Object bean, String beanName) {
    if (bean != null) {
        Object cacheKey = getCacheKey(bean.getClass(), beanName);
        if (this.earlyProxyReferences.remove(cacheKey) != Boolean.TRUE) {
            return wrapIfNecessary(bean, beanName, cacheKey); // 没提前过 → 正常时点创建代理
        }
        // ★ 提前过 → 什么都不做，返回原 bean
    }
    return bean;
}
```

**记账机制的双重效果（事务代理免疫的完整解释）**：

1. **代理只创建一次**：提前创建过（earlyProxyReferences 有记录），正式初始化阶段就跳过——不会出现"早期一个代理、正式又一个代理"的双代理
2. **初始化阶段返回原始对象** → `exposedObject == bean` 成立 → 一致性核对走**分支①** → 最终暴露二级缓存里的早期代理。**环里注入的（TemplateRenderService 拿到的）与容器里的是同一个代理对象**——一致性达成，静默通过

**这不是专门为循环依赖写的补丁逻辑吗？** 是，而且它优雅地复用了同一个 Map：`put` 是提前创建时的登记，`remove` 是正式创建时的核销——**一进一出，天然幂等**。"以记录换一致"的手法与 G1 的 SATB、Netty 的 leakDetector 记录同构（Day03 连接表的再确认）。

### 4.4 事故反推：@Async 为什么必炸——一个接口的实现差距

**分叉点**：AsyncAnnotationBeanPostProcessor 继承自 **AbstractAdvisingBeanPostProcessor**——它**只实现了 BeanPostProcessor，没有实现 SmartInstantiationAwareBeanPostProcessor**（没有 getEarlyBeanReference）。

**逐步还原（ReviewResultNotifier = N，TemplateRenderService = T）**：

```text
1. getBean(N) → 实例化 N（raw）→ earlySingletonExposure=true → 注册工厂
   工厂 = getEarlyBeanReference：遍历 SmartInstantiationAwareBPP——
   本场景 N 没有 AOP 切面（只有 @Async），AbstractAutoProxyCreator 不会被触发
   → 工厂调用结果 = N 本身（raw，无任何提前包装）→ 放二级、删三级
2. populateBean(N)：注入 T → getBean(T) → T 实例化 → 注册工厂 → populateBean(T)
   → 注入 N → getBean(N) → 二级缓存命中 → T 拿到 N 的 raw 引用 ★
3. initializeBean(T) → T 完工 → addSingleton(T)
4. 回到 N：populateBean 完成 → initializeBean(N)：
   BPP afterInitialization 阶段 → AsyncAnnotationBeanPostProcessor 织入异步 Advisor
   → 返回 N 的代理 → exposedObject = N$proxy ≠ bean(N raw) ★★
5. 一致性核对：earlySingletonReference = raw N（非null，第1步被消费过）
   exposedObject(N$proxy) != bean(N raw) → 走分支②
   依赖者 T 是真实 Bean（不是类型检查临时货）→ 抛 raw version 异常 ★★★
```

**报错文案逐句翻译**（读报错的能力）：

| 文案 | 对应源码事实 |
|---|---|
| "injected into other beans [templateRenderService] in its raw version" | 第 2 步：T 拿到的是 raw N（二级缓存里的） |
| "as part of a circular reference" | earlySingletonReference != null 的原因：环发生过 |
| "but has eventually been wrapped" | 第 4 步：初始化后 N 被 Async BPP 换成了代理 |
| "other beans do not use the final version" | T 手里的 raw 与容器里的 proxy **不是同一个对象**——若放过，T 调 N 的异步语义全失效（现象3 毒瓜的机理） |
| "consider allowRawInjectionDespiteWrapping" | 分支②的逃生门——官方不建议（静默不一致比启动失败更贵） |

**实验B（@Transactional 免疫）的源码解释**：事务代理由 AbstractAutoProxyCreator 创建（4.3 的记账机制）——提前暴露时就是代理、正式阶段跳过、exposedObject == bean、走分支①统一。**同一个环、同样被 wrap，差别只在"wrap 它的 BPP 有没有实现 getEarlyBeanReference"**——即"代理创建者是否具备提前暴露的自我意识"。

**实验C（@Lazy 能解）的源码解释**：注入点加 @Lazy 后，T 注入的是 LazyResolutionProxy（JDK 代理）——T 的创建**不再需要 N 存在**（首次调用代理方法才 doResolveDependency 真解析），环的根本没被走到，N 的创建没有"提前消费"发生，一致性核对 earlySingletonReference == null，正常通过。

**为什么 Spring 不给 AsyncAnnotationBPP 也实现 getEarlyBeanReference**（设计层面的追问）：提前暴露代理的本质是"代理形态在初始化前就固定"。AOP 代理（事务/切面）的形态只依赖 Advisor 匹配，初始化过程不改变它，提前创建安全；而 Advising 型增强（@Async）语义上更贴近"初始化后的行为织入"，且 AbstractAdvisingBeanPostProcessor 作为通用父类要服务多种增强（Async/自定义），统一提前化会把"未初始化对象被增强"的面扩大——**Spring 选择了"报错"而不是"凑合"：宁可 fail-fast 也不放任不一致**（与 Day06 静默资损的教训形成对照——框架在它能控制的边界上替你把住了关）。

### 4.5 判别方法论：循环依赖家族报错四形态判别表

| 形态 | 报错特征 | 源码分叉点 | 30 秒定位动作 |
|---|---|---|---|
| ① 构造器/prototype 环 | `Requested bean is currently in creation: Is there an unresolvable circular reference?` | createBeanInstance 期间 getSingleton 落空 + inCreation 命中 | 看报错栈顶在 createBeanInstance → 环上找构造器注入边（Day06 事故1） |
| ② Advising 增强撞环 | `injected into other beans [...] in its raw version ... eventually been wrapped` | 一致性核对分支②（本日事故） | 报错 Bean 上找 @Async/自定义 Advising BPP 增强注解；删注解验证（现象1 实验A 的正确用法） |
| ③ 强开毒瓜的静默失效 | 无报错；声明式能力在部分调用路径失效 | allowRawInjectionDespiteWrapping=true 走分支④ | 特征：**同 Bean 的增强"有的路径生效有的不生效"**（走环注入路径的失效）——AopUtils.isAopProxy(injectedField) 断言 |
| ④ 类型不匹配变体 | BeanNotOfRequiredTypeException / 注入的字段行为异常 | 早期暴露的 raw/早期代理与注入点期望类型在泛型或具体类上的错位 | 检查环注入点的类型声明与实际暴露形态 |

**判别的元方法论**：四形态共享一个源码真相——**"提前暴露的形态"与"最终暴露的形态"是否一致**。①是"暴露都来不及"；②是"暴露了 raw、最终是 proxy"；③是"不一致但强行放过"；④是"不一致在类型上现形"。**拿到任何循环依赖报错，先问：暴露发生在什么形态、最终是什么形态、谁消费了哪个形态**——三问定位，不看注解猜。

### 4.6 正确修复方案（按优先级）与 @Lazy 剪环源码

| 优先级 | 方案 | 评价 |
|---|---|---|
| 1 | **异步边界独立 Bean**：push 拆到 ReviewResultPushWorker（@Async 方法+纯出站职责），Notifier 只做编排调用 | **目标解**：异步发送器本就该是独立生命周期单元（线程池资源、失败重试、监控归它管）；环上的两个 Bean 都不再被 Advising 增强 |
| 2 | 事件解耦：模板预热回调改 ApplicationEvent（Day06 PR1 同款） | 目标解（当反向边是通知语义时） |
| 3 | @Lazy 标注入点 | 过渡手段（能解但环还在；显式 TODO 进治理清单） |
| ✗ | allowRawInjectionDespiteWrapping=true | **禁止**：把 fail-fast 换成静默失效——Day06 已证明静默失效的代价（17 笔资损 vs 启动失败） |

**@Lazy 剪环的源码机制**（补 Day03 的欠账）：

```java
// ContextAnnotationAutowireCandidateResolver
@Override
public Object getLazyResolutionProxyIfNecessary(DependencyDescriptor descriptor, String beanName) {
    return (isLazy(descriptor) ? buildLazyResolutionProxy(descriptor, beanName) : null);
}

private Object buildLazyResolutionProxy(DependencyDescriptor descriptor, String beanName) {
    // JDK 代理，TargetSource 的 getTarget() 里包着"延迟到首次调用的解析"：
    //   beanFactory.doResolveDependency(...)  ← 第一次方法调用才真正找 Bean
    return new ProxyFactory(..., new TargetSource() {
        @Override public Object getTarget() {
            Object target = beanFactory.doResolveDependency(descriptor, beanName, null, null);
            if (target == null) throw new NoSuchBeanDefinitionException(...);
            return target;
        }}).getProxy(beanClassLoader);
}
```

**三个源码细节**：注入的是**只有 TargetSource 的空壳代理**（连真正的目标都没持有）；首次调用才解析，此时被依赖 Bean 大概率已是成品（拿到的是代理版）；解析失败在**首次调用时**抛 NoSuchBeanDefinitionException——**又是一次"失败时点后移"，这就是 @Lazy 只配当过渡手段的源码级理由**（与 Day06"优化不能把错误挪到更贵的时点"同一条纪律）。

### 4.7 四防闭环（防产生 / 防暴露 / 防失效 / 防误诊）

```text
防产生（依赖图健康）：
  依赖方向设计规范（通知语义→事件、编排语义→中介、查询语义→下沉）
  + ArchUnit noCycles 规则进 CI（Day06 已建——但只覆盖 prescription-service，
    本次事故的 notification-service 不在规则扫描范围内 ✗ → 修复：规则升到全仓库）

防暴露（闸门体系）：
  allow-circular-references=false 逐服务推进（本次事故服务是遗留 true）
  + 高危配置清单（Day06 建的清单要包含 allowRawInjectionDespiteWrapping——
    本次事故证明报错文案会"教唆"开危险开关，配置告警要在人被文案带偏之前拦住）

防失效（编码规约）：
  @Async 方法独立 Bean（异步边界规约）——从"个人习惯"升为团队规约
  + review checklist 增补："给存量环上的 Bean 加 Advising 注解（@Async/自定义）= 触发形态②"

防误诊（判别能力）：
  四形态判别表进团队 wiki + "三问定位法"（暴露形态/最终形态/谁消费了哪个）
  + 删注解对照实验的正确解读（确认相关性后必须回到源码机制，
    "能启动了"不是终点——现象3 的毒瓜就是停在"能启动"的代价）
```

**闭环检验**：本次事故四道防线的现状——防产生（规则覆盖不全 ✗）、防暴露（闸门未推进到该服务 ✗）、防失效（无异步边界规约 ✗）、防误诊（无判别表，走了 2 小时弯路 ✗）——**四道全空**。对比 Day06 事故（四道里活了一道对账）：**防线建设永远落后于失效形态的演化，闭环的意义就是把每次新形态补进防线的覆盖面**。

---

## 五、本日能力差距与补足方向

### 差距1：earlySingletonExposure 三条件与"闸门=关闭暴露"的实现机制不知道

- **现状**：以为 Boot 2.6 闸门是加了"循环检测器"；不知道 allowCircularReferences=false 时工厂根本不注册——最小实现达成最大语义变化的设计手法没识别
- **架构师水平**：讲清三条件各自排除什么（prototype/全局开关/非环场景），以及"拒绝通融"式 API 设计的价值
- **补足方向**：读 doCreateBean 开头 10 行；对比"假如让你实现禁止循环依赖，你会怎么写"

### 差距2：一致性核对的分支决策表没建立——raw version 报错只能瞎猜

- **现状**：不知道 exposedObject == bean / allowRawInjectionDespiteWrapping / hasDependentBean 三重条件；报错文案（injected into other beans / raw version / eventually wrapped）逐句对应不到源码事实
- **架构师水平**：背下四行分支决策表；任何循环依赖报错先走"三问定位法"（暴露形态/最终形态/谁消费了哪个形态）
- **补足方向**：把 4.2 分支表抄进笔记；对 4.4 报错文案翻译表做一次默写

### 差距3：earlyProxyReferences 记账机制与"事务免疫"的完整链路讲不出

- **现状**：记得"@Transactional 没事 @Async 有事"的结论，推不出完整链路（put 记账 → 正式阶段 remove 命中跳过 → 返回原 bean → exposedObject == bean → 分支①统一）
- **架构师水平**：白板推演两条链（事务/异步）直到分叉点（getEarlyBeanReference 的实现者），并讲出"put/remove 一进一出天然幂等"的记账美感
- **补足方向**：对照 4.3 源码抄写两遍；写 demo（环+@Transactional vs 环+@Async）断点验证

### 差距4：@Lazy 剪环停留在"能用"，源码机制与"失败时点后移"的代价没掌握

- **现状**：不知道注入的是只含 TargetSource 的空壳代理、首次调用才 doResolveDependency、解析失败在调用时抛——"@Lazy 只是过渡"的判断缺源码支撑
- **架构师水平**：讲清 LazyResolutionProxy 机制，并把它归入"失败时点后移"家族（与全局 lazy、allowRawInjectionDespiteWrapping 同族——都是把问题挪到更贵的时点）
- **补足方向**：读 buildLazyResolutionProxy（20 行）；给"失败时点后移家族"建一张对照表

### 差距5：四形态判别表没有内化——判别靠试错

- **现状**：面对形态②的报错走了 2 小时弯路（按报错指向的 Bean 排查）；"删注解对照实验"停在确认相关性，没回到机制
- **架构师水平**：30 秒形态定位 + 按表直取修复优先级（独立 Bean/事件解耦 > @Lazy > 禁止强开开关）
- **补足方向**：把 4.5 判别表贴进团队 wiki；下次任何 Spring 启动报错先过一遍表

### 差距6：防线覆盖面的"演化意识"缺失

- **现状**：Day06 建的防线（ArchUnit 规则/闸门）只覆盖了治理过的服务——**防线不是一次建成而是随失效形态演化**的意识没有；也没有"高危配置清单"包含 allowRawInjectionDespiteWrapping 这类"报错文案会教唆打开的开关"
- **架构师水平**：每次新失效形态复盘时问"四道防线哪几道是空的、为什么"；高危配置清单维护成活文档（含"为什么危险"一句话）
- **补足方向**：把 ArchUnit 规则扫到全仓库；给高危配置清单补 3 个开关（allowRawInjectionDespiteWrapping/exposeProxy/spring.main.lazy-initialization）

---

## 附录：三级缓存与循环依赖速查（机制 → 报错映射）

| 机制点 | 关键结论 |
|---|---|
| 暴露开关 | earlySingletonExposure = 单例 && allowCircularReferences && inCreation——闸门 false 时工厂不注册（拒绝通融式设计） |
| 工厂内容 | getEarlyBeanReference 是 SmartInstantiationAwareBPP 链的咨询结果——谁实现谁参与提前形态决策 |
| 记账 | earlyProxyReferences：put（提前创建登记）→ remove（正式核销跳过）——代理全局唯一、一进一出幂等 |
| 事务免疫链 | 提前暴露代理 → 正式阶段跳过 → exposedObject == bean → 分支①统一早期代理 → 环内外同一对象 |
| @Async 必炸链 | AbstractAdvisingBeanPostProcessor 无 getEarlyBeanReference → 提前暴露 raw → 正式阶段换代理 → 分支② → raw version 异常 |
| 毒瓜开关 | allowRawInjectionDespiteWrapping=true → 分支③静默不一致——增强在环注入路径上失效 |
| @Lazy 机制 | 空壳 TargetSource 代理，首次调用 doResolveDependency——失败时点后移，只配过渡 |
| 形态① | 构造器/prototype 环：inCreation 命中，栈顶 createBeanInstance |
| 形态② | Advising 增强撞环：raw version 报错，删注解可确认相关性 |
| 形态③ | 静默失效：同 Bean 增强按调用路径选择性失效——isAopProxy 断言检测 |
| 形态④ | 类型错位：BeanNotOfRequiredType 变体 |
| 三问定位 | 暴露发生在什么形态？最终是什么形态？谁消费了哪个形态？ |
| 修复优先级 | 异步边界独立 Bean / 事件解耦 > @Lazy（显式 TODO）> 禁止强开开关 |

---

## 本日总结

Day07 把本周最深的两个伏笔（三级缓存源码、@Async 与 @Transactional 的命运分叉）挖到了源码分叉点。核心收获三层：

1. **机制层**：循环依赖家族的一切行为——可解性、四种报错、事务免疫、毒瓜静默——共享同一个源码真相：**"提前暴露的形态"与"最终暴露的形态"是否一致**。分叉点只有三处：暴露开关（三条件）、形态决策（getEarlyBeanReference 实现者）、一致性核对（分支表）
2. **设计层**：三个可迁移的设计手法——"拒绝通融"式开关（闸门）、"一进一出幂等"的记账（earlyProxyReferences）、"宁可报错不放任不一致"的边界守护（分支②抛异常）
3. **工程层**：四形态判别表 + 三问定位法把"试错排查"变成"看表定位"；四防闭环的覆盖面要随失效形态演化——本次事故四道防线全空，正是"防线建成≠防线有效"的警示

下周（9月第3周）进入 Spring 核心源码第2周：自动装配与 Boot 启动链路、事务体系与传播行为、Spring MVC 与参数解析、事件机制与监听器、Boot 实战——本周的容器/生命周期/代理地基将全部复用。