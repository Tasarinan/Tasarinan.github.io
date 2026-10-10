# 架构师学习-Day02-Bean生命周期与扩展点

> 日期：2026年09月08日（周二）
> 周主题：Spring 核心源码第1周 - IoC 容器启动流程 / Bean 生命周期与扩展点 / 循环依赖三级缓存 / AOP 与动态代理 / 实战综合
> 出题日：Day02 - Bean 生命周期与扩展点

---

## 背景

Day01 讲清了容器的启动两阶段：refresh 第 5 步收齐全部 BeanDefinition（图纸），第 11 步 preInstantiateSingletons 批量实例化（产品）。今天进入**产品生产的流水线本体**——`getBean(beanName)` 从图纸到一个"完全就绪、可注入、可代理"的单例，中间的每一步。

**Day02 为什么是全周的枢纽**：

1. **循环依赖（Day03）发生在流水线中段**：实例化与属性填充之间有一个"提前暴露工厂"的窗口（addSingletonFactory）——不知道流水线的步骤顺序，就说不清暴露点为什么在那、A 和 B 各自走到哪一步时发生了交接
2. **AOP 代理（Day04）挂在流水线的尾部**：`initializeBean` 的最后一步 BPP afterInitialization——代理是流水线的"出厂贴花"工序
3. **启动耗时（Day01 第 5 问、Day05 实战）消耗在流水线上**：每个"启动即连远端"的 Bean 都是在某个生命周期环节里阻塞的——不知道环节就无法定位

架构师面试官问生命周期从不问"有哪些回调"，而是：

> "一个 Bean 从 BeanDefinition 到可销毁，完整经过哪些步骤？每一步谁能介入？"
> "@PostConstruct、afterPropertiesSet、init-method 谁先谁后？为什么 Spring 要同时提供三个？"
> "SmartInitializingSingleton、ApplicationRunner、ContextRefreshedEvent 三个都'容器就绪后执行'，你上线预热代码该放哪个？放错会怎样？"
> "你们项目 @PostConstruct 里预热了 20 万条缓存，启动 8 分钟，怎么治理？"（Day01 衔接）

**与往周专题的衔接点**：

- **Netty 周 Day02 启动链路**：bind → register → doBind0 的三段异步编排 vs Spring 的 doCreateBean 三大步（实例化 → 填充 → 初始化）——同为"多阶段构造 + 状态机推进"的框架内部流程，对比着读源码效率翻倍
- **JVM 第1周 Day04 类加载**：实例化步骤触发 loadClass（Day01 的"实例化才加载"落地点）；@PostConstruct 抛异常 = 类初始化链路上的失败传播
- **并发周 Day01 JMM**：安全发布（Day01 第 6 问）发生在流水线的终点 addSingleton——流水线每一步的写都在 put 之前
- **支付周幂等三防**：销毁阶段的"逆序 + 分层"（Lifecycle 先停、Bean 再销毁）与支付系统"先停止新请求、再冲正存量"的优雅停机同构

**与简历项目的衔接点**：

1. **在线问诊系统启动预热**：医保渠道客户端在 @PostConstruct 里建 SSL 连接——今天要回答"这段代码该放生命周期哪个环节、怎么改"
2. **处方服务优雅停机**：发布时的存量处方请求处理完再下线——销毁顺序与 shutdown hook 的实战
3. **初始化顺序依赖**：配置中心 Bean 必须先于渠道客户端就绪——@DependsOn 与"用生命周期阶段表达依赖"

---

## 热身题（TCP 可靠传输）

### 热身题1：超时重传、快速重传与 RTO 自适应

**为什么需要重传**：IP 层不保证送达（路由器丢包、链路误码校验丢弃），TCP 的"可靠"全靠**确认 + 重传**闭环：接收方回 ACK（累积确认，ack=n 表示 n 之前全部收到）；发送方发出去的字节若迟迟没有确认，就重传。

**RTO 为什么不能是固定值**：RTT 随网络状况波动（同城 2ms、跨省 30ms、弱网抖动 500ms）。RTO 太短 → 大量**不必要的重传**（原包还在路上又发一份，带宽翻倍恶化拥塞）；太长 → 丢包后恢复等待久，连接吞吐塌陷。所以 RTO 必须**自适应跟踪 RTT**：

```
经典算法（RFC 6298）：
SRTT = (1-α)·SRTT + α·RTT_sample          # 平滑往返时间，α=1/8
RTTVAR = (1-β)·RTTVAR + β·|RTT_sample-SRTT|  # RTT 方差，β=1/4
RTO = SRTT + max(G, 4·RTTVAR)             # G 是时钟粒度
Karn 算法：重传的包不计入 RTT 采样（分不清 ACK 对应哪次发送）
```

**快速重传（为什么不等超时）**：超时是"最贵"的信号（RTO 通常几百 ms 起，且触发拥塞控制剧烈收缩）。接收方收到失序报文会**重复确认最后一个连续字节**——发送方连续收到 **3 个冗余 ACK**，基本可断定"下一个包丢了而后续包都到了"，立即重传，不等超时。配合**SACK（选择性确认）**，接收方还能告知哪些区间已收到，发送方只补缺口。

**面试深水区：重传风暴与幂等**。重传意味着"同一份数据可能到达多次"——TCP 层靠序列号去重，应用层毫无感知。但**跨了 TCP 边界就没有这个保证**：MQ 至少一次投递、HTTP 超时重试、RPC 自动 failover，都是"应用层的重传"，却没有应用层的序列号——所以需要业务幂等（支付周三防闭环）。**TCP 教会我们的架构通则：可靠传输 = 重传（补送达）+ 去重（防重复）+ 排序（防乱序），三件缺一不可，协议层没做的，业务层必须自己做。**

### 热身题2：滑动窗口、流量控制与拥塞控制

**滑动窗口的本质**：停等协议（发一个等一个 ACK）吞吐 = 窗口1 ÷ RTT，完全被延迟锁死。滑动窗口允许"已发送未确认"的报文段填满一个窗口，**把吞吐从 RTT 限制解放为带宽限制**。发送窗口 = min(接收方通告窗口 rwnd, 拥塞窗口 cwnd)——两把锁：对面收不收得下（流控），网络扛不扛得住（拥塞控制）。

**流量控制（端到端）**：接收方在每个 ACK 里通告自己剩余缓冲区（rwnd）。rwnd=0 时发送方停发，启动**零窗口探测**（ persist 定时器，周期发 1 字节探测，防"窗口恢复通告丢失"造成的互相死等——与 Netty 周 Day04 的水位背压同构：**生产者感知消费者能力的闭环**，Netty 是 channelWritabilityChanged，TCP 是 rwnd 通告）。**糊涂窗口综合症**（接收方每次腾出几个字节就通告、发送方就发几个字节，头部开销 40 字节比载荷还大）的治理：接收方 Clark 算法（缓存不足一半不放通告）+ Nagle 算法（小包攒批）——**"攒批"是吞吐与延迟的经典权衡**，与 Netty write→flush 聚合、Kafka 攒批 Producer 同构。

**拥塞控制（对网络，全局视角）**——四阶段状态机：

```
慢启动：cwnd 从 1 MSS 起，每 RTT 翻倍（指数增长——"慢"指起点低不是涨得慢）
    ↓ cwnd ≥ ssthresh
拥塞避免：每 RTT 加 1 MSS（线性增长，探测网络上界）
    ↓ 超时（严重信号）
    ssthresh = cwnd/2，cwnd 重置回 1，重回慢启动（剧烈收缩）
    ↓ 3 个冗余 ACK（轻度信号，快速重传）
快速恢复：ssthresh = cwnd/2，cwnd = ssthresh+3，进入拥塞避免（温和收缩——
          判断"网络还有能力送达后续包"，只丢了一个不必推倒重来）
```

**为什么丢包要降窗**：路由器队列溢出 = 网络过载信号，若发送方无动于衷，重传雪上加霜 → 更多丢包 → 全局崩溃（拥塞崩溃，1986 年经典事故：吞吐从 32kbps 跌到 40bps）。拥塞控制是**分布式系统全局最优的自私版本**：每个连接只看本地信号（丢包/时延），却共同收敛到公平分享——与限流周（客户端限流 vs 集群限流）互为镜像：**TCP 用端侧信号近似全局拥塞，集群限流用中心配额精确全局控制**。

**BBR vs 经典算法（加分项）**：经典把"丢包"当拥塞信号，在深缓冲（BDP 大、路由器缓存深）下会**填满缓冲区制造 RTT 虚高**（bufferbloat）；BBR 直接测量瓶颈带宽与最小 RTT，按 BDP 定窗，不靠丢包。呼应 Netty 周 Day04 的容量账：**窗口大小要匹配带宽时延积（BDP = 带宽 × RTT），窗口小于 BDP 就是白白闲置带宽**——跨地域专线（医保结算通道）调优的核心公式。

---

## 题目一（Bean 生命周期全解题）：从 getBean() 到 destroy()

### 作答区

#### 1. 生命周期的"总装线"——doCreateBean 三大步

一个单例 Bean 的创建入口在 `AbstractAutowireCapableBeanFactory`，总装线只有三大步：

```java
// doGetBean → getSingleton(beanName, () -> createBean(...)) → doCreateBean
protected Object doCreateBean(String beanName, RootBeanDefinition mbd, Object[] args) {
    BeanWrapper instanceWrapper = createBeanInstance(beanName, mbd, args);  // ① 实例化
    Object exposedObject = bean = instanceWrapper.getWrappedInstance();

    applyMergedBeanDefinitionPostProcessors(mbd, beanType, beanName);       // ② 注入元数据解析

    addSingletonFactory(beanName, () -> getEarlyBeanReference(...));        // ③ 提前暴露工厂（Day03 主角）

    populateBean(beanName, mbd, instanceWrapper);                           // ④ 属性填充（依赖注入发生在这）
    exposedObject = initializeBean(beanName, exposedObject, mbd);           // ⑤ 初始化（Aware/init方法/AOP代理）

    registerDisposableBeanIfNecessary(beanName, bean, mbd);                 // ⑥ 注册销毁回调
    return exposedObject;
}
```

| 步骤 | 发生什么 | 谁能介入 |
|---|---|---|
| ① createBeanInstance | **推断构造器 → 反射实例化**。顺序：Supplier → factoryMethodName（@Bean 方法）→ 构造器解析 | SmartInstantiationAwareBPP.determineCandidateConstructors |
| ② applyMergedBeanDefinitionPostProcessors | 解析**注入元数据**并缓存（@Autowired/@Value/@Resource 字段与方法清单） | MergedBeanDefinitionPostProcessor |
| ③ addSingletonFactory | 把 ObjectFactory 放入三级缓存——**为循环依赖开的窗口**（Day03） | SmartInstantiationAwareBPP.getEarlyBeanReference |
| ④ populateBean | **依赖注入真正发生**：先 InstantiationAwareBPP.postProcessProperties（@Autowired 家族在此注入），后 XML 式 byName/byType 兜底 | InstantiationAwareBeanPostProcessor |
| ⑤ initializeBean | 四个子步骤（下问展开）：Aware 回调 → BPP before → init 方法 → BPP after（**AOP 代理在这生成**） | 全部 BPP |
| ⑥ registerDisposableBeanIfNecessary | 有销毁回调的 Bean 包装成 DisposableBeanAdapter 注册进 disposableBeans | —— |

**两处"实例"辨析（源码级细节，高区分度）**：`bean` 与 `exposedObject` 两个变量，初始化后 `exposedObject` 可能**不再是原始 bean**——AOP 代理替换了它。如果 Bean 在循环依赖中被提前暴露，doCreateBean 结尾还要做"最终暴露对象与早期引用一致性"的核对（Day07 深挖的正是这一段的完整源码）。

**架构师读法**：三大步是**对象世界 vs 元数据世界的两趟遍历**——② 是"把图纸上的注解翻译成待注入清单"（纯元数据操作），④ 才是"按清单真正动手"（触发依赖 Bean 的创建，可能递归整棵依赖树）。注解解析与注入执行分离 + 元数据按类缓存（InjectionMetadata），是反射密集型框架的通用优化姿势——**解析一次，注入多次**。

#### 2. initializeBean 内部四子步与三类初始化回调的顺序

```
initializeBean:
  ① invokeAwareMethods          —— BeanNameAware / BeanClassLoaderAware / BeanFactoryAware（容器直调，Day01 已讲）
  ② applyBeanPostProcessorsBeforeInitialization
       ├─ ApplicationContextAwareProcessor → ApplicationContext 级 Aware 回调
       └─ CommonAnnotationBeanPostProcessor → @PostConstruct 在这执行！
  ③ invokeInitMethods
       ├─ InitializingBean.afterPropertiesSet()
       └─ 自定义 init-method（@Bean(initMethod=...) / XML init-method）
  ④ applyBeanPostProcessorsAfterInitialization
       ├─ AbstractAutoProxyCreator → AOP 代理生成（Day04 主角）
       └─ AbstractAdvisingBeanPostProcessor → @Async 顾问织入
```

**三类初始化回调的顺序**：`@PostConstruct → afterPropertiesSet → init-method`。

**为什么是这个顺序（架构师必答的三层理由）**：

1. **@PostConstruct（BPP before 阶段）**：JSR-250 标准注解，由 CommonAnnotationBPP 执行——它必须早于 Spring 自己的接口回调，否则"标准协议的钩子"会被"框架私有钩子"抢跑，生态互操作就无从谈起（标准先于实现细节）
2. **afterPropertiesSet（接口回调）先于 init-method（元数据方法）**：接口是"框架与类的编译期契约"，方法是"部署期配置"——**契约的确定性优先于配置的灵活性**；且 init-method 是用户自定义入口，理应拿到"框架已经做完一切"的对象
3. **BPP after（代理生成）必须最后**：代理要包装的是"完全初始化的最终对象"——若先代理后初始化，初始化逻辑作用在代理上，嵌套自调用/this 逃逸问题会复杂一个数量级（Day04 展开）

**@PostConstruct 抛异常会怎样**：BeanCreationException 包装向上抛 → 该 Bean 创建失败 → 依赖它的 Bean 连锁失败 → refresh 第 11 步失败 → destroyBeans + cancelRefresh → **启动失败（fail-fast）**。这是特性不是缺陷：带病初始化的 Bean 与其苟活不如死在启动期（Day01 fail-fast vs 降级启动的分层决策在 Bean 粒度的体现）。

#### 3. 推断构造器——"实例化"不是无脑 new

`createBeanInstance` 内部的构造器选择（候选优先级）：

```
1. BeanDefinition 有 constructorArgumentValues（XML 指定参数）→ 按参数匹配
2. @Autowired 标注的构造器：
   - 恰好一个 required=true → 直接用（无需无参构造器存在）
   - 多个 → primary 候选取 required=true 那个，否则报错（No qualifying bean / 模糊）
3. Kotlin primary constructor / @PersistenceConstructor
4. Spring 5.0+：只有一个非默认构造器（且无 @Autowired）→ 自动用它（无需注解——
   这是"构造器注入成为推荐姿势"的源码级支撑：单构造器类零注解即可注入）
5. 以上皆无 → 无参构造器
```

解析结果缓存在 RootBeanDefinition 的 `resolvedConstructorOrFactoryMethod`（含 argumentsHolder），**同一定义只解析一次**——又一个"解析与执行分离"的样本。

**面试陷阱题**：两个构造器都没标 @Autowired，Spring 用哪个？——无参那个（没有唯一性可推断就退回默认）。要显式选构造器：@Autowired 标在目标构造器上（Spring 4.3+ 单构造器连标注都省了）。**架构师纪律：Service 类保持单构造器（final 字段 + 构造器注入），既 immutable 又零歧义**——这也是 Spring 团队官方推荐（字段注入无法构造不可变对象、无法脱离容器测试、隐藏真实依赖面）。

#### 4. 销毁阶段——顺序、分层与 prototype 的放养

**销毁回调的执行顺序**（与初始化镜像对称）：

```
容器关闭 doClose():
  ① 发布 ContextClosedEvent（还来得及监听）
  ② LiveBeansView 注销 / LifecycleProcessor.onClose:
       SmartLifecycle.stop() —— 按 phase 降序、带 graceful 超时（WebServer 在这停止接收新请求）
  ③ destroyBeans(): 逐个销毁全部单例 —— 按"依赖的反向图"逆序销毁（被依赖的最后死）
       每个Bean内部顺序：
       a. DestructionAwareBeanPostProcessor.postProcessBeforeDestruction
            → CommonAnnotationBPP 执行 @PreDestroy
       b. DisposableBean.destroy()
       c. 自定义 destroy-method（@Bean(destroyMethod=...) / inferred 默认推测 close/shutdown）
  ④ active = false
```

**三个生产级细节**：

1. **shutdown hook**：纯 Spring 要手动 `context.registerShutdownHook()`；**Boot 自动注册**（JVM runtime hook → doClose）。SIGTERM（K8s pod 终止、systemctl stop）触发 hook，**SIGKILL 不触发**——所以 K8s 的 terminationGracePeriodSeconds 必须 ≥ 应用 graceful 停机耗时（衔接 K8s 周 Day02 与 Netty 周 Day05 的连接迁移 drain）
2. **destroyMethod 推测**：@Bean 不指定时，Spring 会推测名为 close/shutdown 的公开无参方法自动调用——**第三方类没有 Spring 接口也能被优雅关闭**（对修改关闭的插件式兼容）。副作用：方法叫 close 但语义不是关闭（如生成器）会误关，`@Bean(destroyMethod = "")` 显式排除
3. **prototype 不进销毁名单**：容器只负责"生产"，出生后引用交给你，**销毁完全自理**（DisposableBeanAdapter 只包装 singleton）。资源型 prototype（每次 new 一个带连接的对象）= 泄漏隐患——这是"prototype 失活陷阱"的镜像问题：**单例注入 prototype 失活在'注入一次'，prototype 资源泄漏在'无人回收'**。解法：prototype 不该持有需要容器生命周期管理的资源，改成 ObjectProvider + try-with-resources 自管

**优雅停机的完整时序（问诊系统发布时刻）**：

```
SIGTERM → shutdown hook → ContextClosedEvent（日志："closing"）
  → SmartLifecycle.stop(phase 高先停)：WebServer 停止 accept → 排空存量请求
  → Spring Bean 逆序销毁（数据源最后关——持有连接的 Bean 先结束业务）
  → JVM 退出
K8s 侧：preStop sleep(摘流生效) + terminationGracePeriodSeconds=90 兜底强杀
```

**为什么数据源要"最后死"**：销毁顺序 = 依赖反向图逆序——业务 Bean 依赖数据源，所以业务先销毁、数据源垫底，保证销毁期任何"最后一笔"的 SQL 仍有连接可用。**这个"按依赖拓扑排序做启停"的思想与 K8s initContainer/容器组的启停顺序、SystemService 的依赖编排完全同构。**

#### 5. "就绪"的四层语义——扩展点选型表（架构师核心题）

"Bean 都好了之后做点事"有至少四个挂点，**粒度与语义完全不同**——放错位置的代价从"没执行"到"Web 还没起来就执行"不等：

| 挂点 | 时机（refresh 舞台） | 看得见什么 | 典型用途 | 放错的代价 |
|---|---|---|---|---|
| @PostConstruct | 单个 Bean 初始化期（② before） | 只有这个 Bean 自己（**依赖未必就绪**） | Bean 自检、本地资源初始化 | 依赖另一个"稍后创建"的 Bean → NPE/失败 |
| SmartInitializingSingleton.afterSingletonsInstantiated | 第 11 步 preInstantiateSingletons **循环结束之后**（全部单例就绪） | 全部单例 | 依赖"所有 Bean 都在"的一次性装配（事件监听器核对、本地缓存骨架） | 在 Bean 里做 → 拿到未就绪协作者 |
| ContextRefreshedEvent / ApplicationListener | 第 12 步 finishRefresh 发布 | 容器级就绪（含 SmartLifecycle.start 完成后？否——事件在 start 后发布） | 容器刷新完成后的广播（注意：**父子容器刷新会收到多次**，要判 `context == event.getApplicationContext()`——经典坑） | 忽略多次触发 → 预热跑两遍 |
| ApplicationRunner / CommandLineRunner | **Boot 特有**：run() 里 refreshContext 之后 callRunners | 全容器 + WebServer 已启动 | **线上预热标准位置**（缓存预热、连接池压测、租户加载） | 放 @PostConstruct → 阻塞启动（Day01 第 5 问事故） |

**SmartLifecycle.start 与 ContextRefreshedEvent 的先后**（源码级）：finishRefresh 内部顺序是 `lifecycleProcessor.onRefresh()`（SmartLifecycle.start，WebServer 启动在这）→ `publishEvent(new ContextRefreshedEvent(...))`。所以监听 ContextRefreshedEvent 时**端口已经开了**——想赶在端口开之前做事，用 SmartLifecycle(phase 较小) 或 @PostConstruct。**这道时序题是"启动事故排查"的基本功：预热代码到底跑在端口开放之前还是之后，决定了发布窗口里有没有'半就绪流量'。**

**Boot 的完整就绪链**（收口 Day01 第 3 步）：

```
refresh() 第 11 步全部单例就绪 → SmartInitializingSingleton 回调
  → 第 12 步 SmartLifecycle.start（WebServer start，端口开放）
  → ContextRefreshedEvent
  → Boot: callRunners（ApplicationRunner/CommandLineRunner）
  → Boot: runners 全部成功 → ApplicationReadyEvent（ readiness 语义的"应用级"信号）
  → （K8s readiness 探针应指向 actuator/health 或自定义 readiness 状态）
```

**架构师纪律（三条）**：

1. **重活放 Runner，轻活放 @PostConstruct**：网络 IO / 大批量数据加载一律 ApplicationRunner（必要时异步化 + 就绪标志位，启动不等它）
2. **强依赖顺序用 @DependsOn 或构造器注入显式表达**，不赌 Bean 定义注册顺序（preInstantiateSingletons 按定义顺序实例化，而定义顺序受扫描顺序影响——**把正确性建立在顺序上就是埋雷**）
3. **ContextRefreshedEvent 监听必须防重**（父子容器/多次 refresh），或者干脆改用 ApplicationRunner 语义更干净

#### 6. 编写生产级 BeanPostProcessor——纪律与反模式

**BPP 影响力极大，写错伤害面也大**（它作用于**每一个 Bean**）。生产纪律清单：

| 纪律 | 理由 | 违反后果 |
|---|---|---|
| 构造器注入 / BeanFactoryAware，**不注入业务 Bean** | BPP 在第 6 步提前实例化，其依赖 Bean 会被连坐提前创建，错过后续 BPP | Day01 陷阱日志：`not eligible for getting processed by all BeanPostProcessors` → 切面/事务失效 |
| 实现 Ordered（或用 @Order） | 多个 BPP 的执行顺序影响结果（如"脱敏 BPP"应在"审计 BPP"之前） | 顺序随扫描漂移，行为不可复现 |
| 尽快 return 原对象（匹配失败立即放行） | BPP 在**每个 Bean 的创建热路径**上 | 全量 Bean 创建变慢（启动耗时放大器） |
| 不在 BPP 里做远端调用/重计算 | 同上 + 启动阻塞 | 启动 8 分钟的隐性来源 |
| BPP 的 Bean 不再套 BPP 增强逻辑要幂等 | 可能被回调多次（不同路径） | 重复增强/重复代理 |

**实战样例——敏感字段脱敏 BPP（问诊系统病历导出）**：

```java
public class SensitiveMaskBpp implements BeanPostProcessor, Ordered {
    @Override
    public Object postProcessAfterInitialization(Object bean, String beanName) {
        Class<?> target = AopUtils.isAopProxy(bean)
                ? AopUtils.getTargetClass(bean) : bean.getClass();   // 注意：拿到代理要看目标类
        List<Field> fields = findMaskFields(target);                  // @Mask 注解字段，元数据按类缓存
        if (fields.isEmpty()) return bean;                            // 热路径尽快放行
        return ProxyFactory.getProxy(bean, new MaskAdvisor(fields));  // 只增强有标注的 Bean
    }
    @Override public int getOrder() { return Ordered.LOWEST_PRECEDENCE - 10; } // 晚于 AOP 基础代理？——留思考
}
```

**思考点的答案**：脱敏若要在"事务代理之后、业务执行之中"生效，Advisor 的 @Order 要与事务 Advisor 协调（同一代理内的拦截链顺序，Day04 展开）；BPP 自身的 Ordered 决定的是"代理外壳套几层"的顺序，两层顺序是不同的轴——**分不清这两个 Order 是切面治理混乱的头号来源**。

**反模式集（code review checklist）**：

1. `@PostConstruct` 里 `new Thread(...).start()`——线程没名、没异常处理器、没纳管（正确姿势：TaskExecutor Bean / SmartLifecycle）
2. BPP 字段注入业务 Service——触发提前实例化连坐
3. afterPropertiesSet 里发起 HTTP 预热——阻塞流水线（放 Runner + 异步）
4. 监听 ContextRefreshedEvent 不防重——预热数据双倍
5. 在 init-method 里改 BeanDefinition 的值——图纸已冻结（freezeConfiguration），不生效且静默

#### 7. 架构师视角——生命周期是"多阶段构造"的通用范式

把 Spring Bean 生命周期抽象到软件设计层，它是**多阶段构造 + 钩子协议**的标准实现：

```
阶段化构造：        实例化 → 元数据解析 → 依赖装配 → 初始化 → 服役 → 停止 → 销毁
钩子协议：          每个阶段间都有标准接口（Aware/InitializingBean/BPP/Lifecycle/Disposable）
不可变推进：        阶段单向推进，不允许回退（除循环依赖的"半成品提前暴露"——受控的例外）
失败的阶段语义：    未服役失败 = 清理后重来（destroyBeans）；服役中失败 = 停机序列
```

**同构系统对照**：

| 系统 | 阶段化构造 | 钩子 |
|---|---|---|
| Servlet 规范 | init → service → destroy | ServletContextListener |
| Netty Channel | handlerAdded → channelActive → channelRead... → channelInactive | ChannelInboundHandler 全是钩子 |
| K8s Pod | Pending → ContainerCreating → Running → Terminating | postStart/preStop（探针） |
| MySQL | 参数加载 → redo/undo 恢复 → binlog 回放 → 服役 → shutdown purge | —— |

**架构师的价值不是背下 Spring 的阶段，而是掌握"设计一个带生命周期的容器"的范式**：当你在问诊系统里设计"渠道连接管理器"（初始化建连 → 健康检查服役 → 发布排空 → 关闭），直接套用：**两阶段提交式状态机 + 每阶段钩子 + 单向推进 + 失败分阶段语义**。Spring 的生命周期就是这套范式的参考实现——这就是"读源码学设计"的正确姿势（区别于背八股）。

---

## 本日能力差距与补足方向

### 差距1：doCreateBean 三大步讲不出源码级顺序与介入者

- **现状**：生命周期只会背"实例化→填充→初始化"，说不出 createBeanInstance/applyMergedBeanDefinitionPostProcessors/populateBean/initializeBean 的源码顺序、每步谁能介入、注入元数据缓存在哪
- **架构师水平**：白板默写总装线，标出 ③ addSingletonFactory（Day03 入口）和 ④ BPP after（Day04 代理入口）在全线的位置——两天的深挖都挂在这条线上
- **补足方向**：精读 AbstractAutowireCapableBeanFactory.doCreateBean 一遍（约 200 行），抄写三大步与注释

### 差距2：三类 init 回调顺序知道结果，说不出设计理由

- **现状**：背得出 @PostConstruct → afterPropertiesSet → init-method，但"标准优先于实现、契约优先于配置、代理必须最后"三层理由讲不出
- **架构师水平**：用"生态互操作 / 确定性优先 / 代理包装最终对象"三句话讲清顺序的必然性
- **补足方向**：把第 2 问三层理由内化；给自己讲一遍直到不看笔记

### 差距3："就绪四层语义"分不清，预热代码放错位置

- **现状**：@PostConstruct / SmartInitializingSingleton / ContextRefreshedEvent / ApplicationRunner 的时机差别说不全；不知道 SmartLifecycle.start 在 ContextRefreshedEvent **之前**（端口已开）；监听 ContextRefreshedEvent 不防重（父子容器多次触发）
- **架构师水平**：给任意一段"就绪后逻辑"30 秒内判定挂点；讲清"预热跑在端口开放前还是后"的发布窗口含义
- **补足方向**：把第 5 问选型表抄进笔记；在问诊系统里审查全部 @PostConstruct，列出迁移到 Runner 的清单

### 差距4：推断构造器机制空白

- **现状**：不知道多构造器时 Spring 怎么选、@Autowired 构造器优先级、5.0+ 单构造器自动推断；"为什么推荐构造器注入"答不出源码级理由
- **架构师水平**：讲清单构造器零注解即可推断的设计动机（构造器注入成为一等公民）；对"构造器注入 vs 字段注入"给出不可变性/测试性/依赖显性化的三连论据
- **补足方向**：读 determineConstructorsFromBeanPostProcessors 与 autowireConstructor

### 差距5：销毁阶段知识几乎空白

- **现状**：说不全 @PreDestroy → destroy() → destroy-method 顺序；不知道 SmartLifecycle.stop 先于 Bean 销毁、销毁按依赖反向图逆序、Boot 自动注册 shutdown hook、destroyMethod 自动推测 close/shutdown；prototype 不管销毁的连带风险没概念
- **架构师水平**：画出优雅停机全时序（SIGTERM → 事件 → Lifecycle 停 → 逆序销毁 → JVM 退出），并把它对到 K8s 的 preStop/terminationGracePeriodSeconds 上
- **补足方向**：读 AbstractApplicationContext.doClose 与 DisposableBeanAdapter；对着问诊系统发布流程画一遍停机时序图

### 差距6：@PostConstruct 滥用没有纪律——启动事故的高发源头

- **现状**：自己就在 @PostConstruct 里写过建连/预热代码；不知道"重活放 Runner、轻活放 @PostConstruct"的界线；不知道强依赖顺序必须显式表达（@DependsOn/构造器注入）而不是赌定义顺序
- **架构师水平**：把第 5 问三条纪律 + 第 6 问反模式集变成团队的 code review checklist
- **补足方向**：审查问诊系统全部 @PostConstruct（IDEA Structural Search），产出整改清单

### 差距7：BPP 的两个 Order 分不清

- **现状**：写 BPP/切面时分不清"BPP 的 Ordered（决定代理外壳套几层）"与"Advisor 的 @Order（决定同一代理内拦截链顺序）"——切面治理混乱的头号来源
- **架构师水平**：讲清两个轴的区别并给出"脱敏在事务之后执行"这类需求的正确落点
- **补足方向**：写一个含两个 Advisor 的 demo，断点观察 ReflectiveMethodInvocation 拦截链顺序

### 差距8：生命周期没有上升到"多阶段构造范式"

- **现状**：把生命周期当 Spring 特有八股，看不到与 Servlet/Netty Channel/K8s Pod 的同构——"读源码学设计"停留在"读源码背流程"
- **架构师水平**：用"阶段化构造+钩子协议+单向推进+失败分阶段语义"四要素分析任意带生命周期的系统，并在自研组件（渠道连接管理器）里复用该范式
- **补足方向**：把第 7 问同构表内化；给问诊系统的渠道连接管理器写一页"生命周期设计 ADR"

---

## 附录：本日关键认知速查

| 认知点 | 关键结论 |
|---|---|
| 总装线三大步 | 实例化（推断构造器）→ 注入元数据解析 → **addSingletonFactory → populateBean → initializeBean**；解析一次注入多次 |
| init 顺序 | @PostConstruct（BPP before）→ afterPropertiesSet（接口契约）→ init-method（配置）；BPP after（代理）必须最后 |
| 注入发生点 | populateBean 的 InstantiationAwareBPP.postProcessProperties——@Autowired 真正动手处 |
| 构造器推断 | @Autowired 唯一构造器优先；5.0+ 单非默认构造器自动用；退回无参 |
| 就绪四层 | 单 Bean（@PostConstruct）→ 全单例（SmartInitializingSingleton）→ 容器+端口（SmartLifecycle.start → ContextRefreshedEvent）→ 应用（Runner → Ready） |
| 端口开放时机 | SmartLifecycle.start 在 ContextRefreshedEvent **之前**——监听事件时端口已开 |
| 销毁顺序 | ContextClosedEvent → SmartLifecycle.stop（phase 降序）→ Bean 按依赖反向图逆序：@PreDestroy → destroy() → destroy-method |
| prototype 销毁 | 容器不管——资源型 prototype = 泄漏隐患 |
| shutdown hook | Boot 自动注册；SIGTERM 触发、SIGKILL 不触发；terminationGracePeriodSeconds ≥ 停机耗时 |
| BPP 纪律 | 不注入业务 Bean / 实现 Ordered / 热路径尽快放行 / 不做远端调用 |
| 两个 Order | BPP 的 Ordered = 代理外壳层数轴；Advisor 的 @Order = 拦截链内部轴 |
| @PostConstruct 抛异常 | fail-fast：Bean 创建失败连锁 → refresh 失败 → 启动失败 |
| TCP 重传启示 | 可靠 = 重传 + 去重 + 排序；协议层没做的业务层必须自己做（幂等） |
| 拥塞控制 | 慢启动指数 → 拥塞避免线性；超时剧烈收缩 / 3 冗余 ACK 温和收缩；BBR 按 BDP 定窗 |
| 流控同构 | rwnd 通告 ↔ Netty writability 背压：生产者感知消费者能力的闭环 |