# 架构师学习-Day03-循环依赖与三级缓存

> 日期：2026年09月09日（周三）
> 周主题：Spring 核心源码第1周 - IoC 容器启动流程 / Bean 生命周期与扩展点 / 循环依赖三级缓存 / AOP 与动态代理 / 实战综合
> 出题日：Day03 - 循环依赖与三级缓存

---

## 背景

Day02 走完了 doCreateBean 总装线，其中第 ③ 步 `addSingletonFactory` 当时被标记为"为循环依赖开的窗口、Day03 主角"。今天把这个窗口讲透——它是 Spring 源码里被面试问得最深、误解也最多的 200 行代码。

**为什么三级缓存值得一整天**：

1. **它是全周知识的枢纽**：向上连 Day01 的两阶段设计（"先收图纸后实例化"是循环依赖可解的前提）、向内连 Day02 的流水线（暴露点在实例化与填充之间）、向旁连 Day04 的 AOP（第三级必须是 ObjectFactory 的唯一充分理由就是代理的延迟创建）
2. **它是"设计取舍"的最佳教学样本**：Spring 本可以"检测到循环就报错"（Boot 2.6+ 实际上就是这么默认的），却选择花三级缓存去兼容它——理解"为什么兼容、为什么又默认禁止"，比记住"怎么解决"重要得多
3. **它是失效事故的重灾区**：构造器注入循环、@Async 撞上循环依赖、prototype 循环——报错形态各异，根因同一族，判别是硬功夫（Day07 反推）

架构师面试官的经典问法：

> "三级缓存分别存什么？拿掉第三级行不行？"（99% 的人答不出"为什么不行"的正确理由）
> "A、B 互相注入，走一遍完整时序，A 什么时候把自己暴露出去的？"
> "Spring Boot 2.6 为什么默认禁止循环依赖？Spring 一边解决它一边禁止它，矛盾吗？"
> "@Async 的 Bean 卷进循环依赖为什么报错，@Transactional 却没事？"（Day07）

**与往周专题的衔接点**：

- **热身题 TLS 会话复用**：TLS 1.3 的 0-RTT resumption 与三级缓存的"早期引用复用"同构——**用"提前暴露的部分状态"换取一次完整握手/创建的成本**，两者都要回答"提前暴露的东西和最终成品不一致怎么办"
- **JVM 第1周 Day05 G1 的 SATB**：原始快照标记里"引用变更打标"与三级缓存"earlyProxyReferences 记录已提前创建代理"同构——**并发/交错场景下"以记录换一致"的手法**
- **并发周 Day01 JMM 安全发布**：三级缓存 earlySingletonObjects 是 HashMap（非线程安全），为什么可以？因为**读它的时候必然持有 singletonObjects 的锁**（getSingleton 同步块内）——锁的范围覆盖了所有共享结构的访问，这是"锁保护的不变量"的教科书案例
- **Netty Day04 引用计数**：earlyProxyReferences 的"是否已提前创建过代理"记录，防止二次代理——一次性动作的去重标记

**与简历项目的衔接点**：

1. **问诊系统续方模块**：PrescriptionRenewalService ↔ MedicationService 的真实循环依赖隐患（Day06 串联复盘的事故 1）
2. **升级 Boot 2.6+ 的迁移决策**：allow-circular-references 从 true 到 false，存量循环依赖怎么办——架构师要主导这个治理（第 6 问）

---

## 热身题（HTTPS 与 TLS）

### 热身题1：TLS 1.2 握手——混合加密与证书验证

**为什么对称 + 非对称混合**：非对称（RSA/ECDHE）解决**密钥交换**（不用预共享、可防窃听），但慢 2~3 个数量级，撑不住业务流量；对称（AES-GCM/ChaCha20）快但双方要先有同一个密钥。所以 TLS 的设计是：**非对称算法只用来协商/保护一个随机会话密钥，后续全部流量用对称密钥**——重武器用一次，轻武器打全程。

**TLS 1.2 完整握手（RSA 版，先讲最简模型）**：

```
① ClientHello：支持的 TLS 版本/密码套件列表 + 客户端随机数
② ServerHello + Certificate + ServerHelloDone：选定套件 + 服务端随机数 + 证书链
③ 客户端验证证书 → 生成预主密钥（pre-master）→ 用服务端证书公钥加密发送
   + ChangeCipherSpec + Finished
④ 服务端解密拿到预主密钥 → ChangeCipherSpec + Finished
   ⇒ 双方用 (客户端随机数 + 服务端随机数 + 预主密钥) 派生会话密钥
```

**为什么派生要掺两个随机数**：防**重放**——即使会话密钥推导算法公开，每次握手的随机数不同，旧握手的密钥不能复用；且服务端随机数由服务端贡献，客户端无法预谋。

**证书链验证（面试重灾区）**：浏览器验证的不是"域名匹配"这一层，而是逐级上溯的信任链——叶子证书（域名）→ 中间 CA → 根 CA（内置在操作系统/浏览器信任库）。每一级验证：**签名（上级私钥签的，用上级公钥验）、有效期、吊销状态（CRL/OCSP）、域名匹配（SAN）**。根证书为什么可信？不是密码学保证，是**分发渠道保证**（随 OS 一起送达）——信任的锚点最终是物理/供应链问题，这一步想通了才能理解证书体系（衔接医疗周"如何信任一份医保数字证书"）。

**RSA 密钥交换的致命缺陷与 ECDHE**：RSA 版会话密钥只能由客户端生成、公钥加密传输——**服务端私钥一旦泄露，历史流量的会话密钥全部可被解出（不具备前向保密）**。ECDHE：每次握手双方生成**临时**椭圆曲线密钥对做 Diffie-Hellman 交换，会话密钥不经过传输、私钥用完即弃——**长期私钥泄露也解不了历史流量（前向保密 PFS）**。TLS 1.3 已直接废除 RSA 密钥交换——**"密钥不落线、私钥不重放"是安全协议演进的主线**。

### 热身题2：TLS 1.3 与会话复用——"提前暴露"的经济学

**TLS 1.3 为什么握手从 2-RTT 降到 1-RTT**：TLS 1.2 要先协商完密钥才能发数据（2 个来回）；1.3 的 ClientHello 直接**带上密钥交换材料**（key_share），服务端一个来回就能同时完成协商并返回加密数据——把"协商"和"首次数据"合并了。

**0-RTT 会话复用（与三级缓存同构的精华）**：复用此前会话的 PSK（预共享密钥，由上一次会话的 resumption secret 派生），客户端在**第一个包**就携带应用数据（early data）：

```
完整握手（1-RTT）：双发两往才能发数据 —— 类比"完整创建 Bean 再使用"
0-RTT 复用：客户端拿着 PSK 直接发加密数据 —— 类比"三级缓存提前暴露早期引用"
```

**0-RTT 的代价（提前暴露的通病）**：

1. **重放风险**：early data 没有新鲜度保证，攻击者可以原样重发——所以 0-RTT 只允许幂等请求（GET），**网关和业务必须显式声明能接受重放**（支付/下单绝不允许）
2. **复用状态与"新成品"的偏差**：PSK 绑定的是旧会话的派生材料，若证书/配置变了，复用必须失效（防降级）

**同构映射到三级缓存**：

| TLS 0-RTT | Spring 三级缓存 |
|---|---|
| PSK 提前派生，首包带数据 | ObjectFactory 提前暴露早期引用，B 不等 A 完工 |
| early data 有重放风险 → 限幂等 | 早期引用是半成品 → 限定"只作为引用暂存，不保证完全初始化" |
| 旧 PSK 绑定旧状态，配置变更必须失效 | earlySingletonObjects 的引用必须与最终暴露对象一致性核对（Day07） |
| 没有复用场景就付全握手成本 | **没有循环依赖时工厂从不被调用，零开销** |

**架构通则**：所有"提前暴露部分状态换时间"的设计（TLS 0-RTT、三级缓存、读写锁的读优先、CPU 乱序执行的 speculation），都要回答同一组问题——**暴露什么、给谁用、和最终态不一致怎么办、没有这个场景时有没有额外成本**。面试时能把三级缓存和 0-RTT 放在一起对照讲，就是"设计感"的直接证据。

---

## 题目一（循环依赖全解题）：三级缓存的源码、边界与治理

### 作答区

#### 1. 问题定义与可解域

**什么是循环依赖**：A 依赖 B、B 又依赖 A（或更长的环 A→B→C→A）。本质是**对象图有环**——构造每个节点都需要另一个节点"已经存在"，鸡生蛋问题。

**Spring 的可解域（一张表说清）**：

| 依赖形态 | 可否化解 | 原因 |
|---|---|---|
| 单例 + setter/字段注入 | ✅ | 实例化与注入分离——先 new 出壳，注入可以晚点补 |
| 单例 + 构造器注入 | ❌ | 实例化本身就需要依赖——壳都造不出来，暴露点在实例化**之后**，来不及 |
| 单例 + @Lazy 标注入点 | ✅（绕过） | 注入的是代理，首次使用才真正 getBean——环被代理剪断 |
| prototype 任何形态 | ❌ | 没有缓存暂存点（容器不缓存 prototype），无法"放半成品" |
| BeanFactoryAware 手动 getBean | ✅（绕过） | 延迟到使用时拉取，等价于 @Lazy 的手工版 |
| @Async 卷入的循环 | ❌（报错） | 早期暴露的对象与最终对象不一致，Spring 主动报错（Day07 深挖） |
| Spring MVC Controller ↔ Service | ✅/❌ 取决于注入形态 | Controller 是普通单例 Bean，规则同上 |

**可解性的第一性原理（架构师版答案）**：循环依赖可解 **当且仅当**"依赖需求的时点"晚于"可暴露时点"。setter 注入的依赖需求在 populateBean（壳已存在）；构造器注入的依赖需求在 createBeanInstance（壳还不存在）。**三级缓存只是把"可暴露的半成品"管理起来的机制，它改变不了时序本身**——这就是为什么注入形态决定生死。

#### 2. 三级缓存的数据结构与读取路径（源码级）

```java
// DefaultSingletonBeanRegistry
/** 一级：成品单例。beanName → bean instance */
private final Map<String, Object> singletonObjects = new ConcurrentHashMap<>(256);
/** 三级：单例工厂。beanName → ObjectFactory（能生产早期引用） */
private final Map<String, ObjectFactory<?>> singletonFactories = new HashMap<>(16);
/** 二级：早期引用。beanName → bean instance（从三级工厂生产出来后暂存） */
private final Map<String, Object> earlySingletonObjects = new HashMap<>(16);
```

**读取路径 getSingleton(beanName, allowEarlyReference)**——注意整个方法在 `synchronized (this.singletonObjects)` 内：

```java
protected Object getSingleton(String beanName, boolean allowEarlyReference) {
    Object singletonObject = this.singletonObjects.get(beanName);       // ① 一级：成品直取
    if (singletonObject == null && isSingletonCurrentlyInCreation(beanName)) {
        singletonObject = this.earlySingletonObjects.get(beanName);     // ② 二级：早期引用
        if (singletonObject == null && allowEarlyReference) {
            synchronized (this.singletonObjects) {                      // ③ 锁保护二三级
                // 双检之后从工厂生产，并"升级"到二级
                ObjectFactory<?> singletonFactory = this.singletonFactories.get(beanName);
                if (singletonFactory != null) {
                    singletonObject = singletonFactory.getObject();      // 调 getEarlyBeanReference（可能提前建代理）
                    this.earlySingletonObjects.put(beanName, singletonObject);  // 升二级
                    this.singletonFactories.remove(beanName);           // 删三级（一次性）
                }
            }
        }
    }
    return singletonObject;
}
```

**三个源码级细节（面试区分度）**：

1. **一级缓存是 ConcurrentHashMap，二级三级是 HashMap**——因为一二三级的访问模式不同：一级运行期高并发读（getBean 热路径），二三级只在启动期"正在创建中"的 Bean 上被访问，且都在 synchronized 块内（写三级在 addSingletonFactory 的同步块、读三级在 getSingleton 的同步块）——**锁保护的不变量覆盖了非线程安全容器，这是"锁的 scope 大于数据结构本身"的设计**
2. **工厂是一次性的**：调用后立刻"升级到二级、删除三级"——保证 getEarlyBeanReference 全局只调一次（代理只提前创建一次，后续依赖从二级拿同一个引用）
3. **allowEarlyReference 参数**：`getSingleton(name, false)` 只查一二不碰三级——doCreateBean 结尾的"最终暴露一致性核对"用它（`false`：不能再触发工厂，只能看"是否曾被提前暴露过"），这是 Day07 事故反推的关键开关

#### 3. A↔B setter 循环依赖完整时序（白板必默）

设 A、B 均为单例、字段注入（@Autowired），preInstantiateSingletons 先遍历到 A：

```
 1. getBean(A)：三级全无 → 进入创建流程
 2. getSingleton(A, factory)：
    beforeSingletonCreation(A)：把 A 记入 singletonsCurrentlyInCreation（❗环检测的记号）
    → createBean(A) → doCreateBean(A)
 3. A 实例化完成（createBeanInstance：壳已存在，字段全空）
 4. addSingletonFactory(A, () -> getEarlyBeanReference(A))   ← 暴露窗口开启（同步块内写三级）
 5. populateBean(A)：注入字段 → 发现依赖 B → getBean(B)
 6. getBean(B)：三级全无 → beforeSingletonCreation(B) → doCreateBean(B)
 7. B 实例化完成 → addSingletonFactory(B, ...)
 8. populateBean(B)：注入字段 → 发现依赖 A → getBean(A)
 9. getBean(A)（递归进入）→ getSingleton(A, true)：
    一级无；A 在创建中；二级无；三级有工厂 → 工厂执行
      → getEarlyBeanReference(A)：若 A 需要 AOP 代理 → 此时创建代理并记录 earlyProxyReferences
      → 早期引用（可能是代理）放入二级，删除三级
    → B 的字段拿到 A 的早期引用 ✅
10. initializeBean(B)：B 走完初始化（含 B 自己的 AOP 代理生成）
11. B 完工：afterSingletonCreation(B)（从 inCreation 移除）
    → addSingleton(B)：一级放入 B 成品，删除 B 的二三级行 ✅ B 就绪
12. 回到 A 的 populateBean：字段 B 注入完成 → initializeBean(A)
    ⚠ 注意：initializeBean 返回的代理对象（若有）赋给 exposedObject
13. doCreateBean(A) 结尾的一致性核对：
    earlySingletonReference = getSingleton(A, false)   // 只查一二
    if (earlySingletonReference != null) {             // 说明第 9 步发生过提前暴露
        if (exposedObject == bean) {                   // 初始化没有替换对象（代理没在这里生成）
            exposedObject = earlySingletonReference;   // ❗最终暴露 = 二级里的早期引用（提前生成的代理）
        } // 若初始化阶段替换了对象（exposedObject != bean）且被提前暴露过
          // 且 allowRawInjectionDespiteWrapping=false → 抛 BeanCurrentlyInCreationException（@Async 事故，Day07）
    }
14. afterSingletonCreation(A) → addSingleton(A)：一级放 A 的最终对象，清二三级 ✅
```

**时序里的三个灵魂考点**：

- **A 是被"提前暴露"的，B 是被"正常创建"的**——B 在第 11 步就已完整就绪，A 拖到最后才完工
- **第 13 步的一致性核对**是防止"B 拿到的 A"与"容器最终的 A"是两个不同对象——AOP 场景下如果 initializeBean 又生成了新代理，B 手里那个就不是容器里的，Spring 要么统一（exposedObject = 早期引用）、要么报错
- **inCreation 集合（singletonsCurrentlyInCreation）就是环检测器**：beforeSingletonCreation 发现已在集合中 → BeanCurrentlyInCreationException——构造器循环依赖报错就是它检测出来的（第 6 问）

#### 4. 灵魂拷问：为什么第三级必须是 ObjectFactory，两级为什么不行

**先给结论**：第三级的 ObjectFactory 是为了**AOP 代理的延迟决策**——没有 AOP（或不需要提前代理）的世界里，两级缓存就够了。

**反证法推演**（面试满分答案的骨架）：

```
假设只留两级：singletonObjects + earlySingletonObjects（直接放"实例化后的壳"）

场景：A 需要被 AOP 代理（@Transactional），且 A ↔ B 循环依赖

两级方案的问题：B 在第 9 步从二级拿到的是 A 的"原始壳"（没代理）
  → B 调 A 的事务方法 → this 直调无事务（Day04 失效）
  → 而 Spring 的设计承诺：注入给别人的必须是代理

补救方案 A：实例化后立刻生成代理放进二级
  → 所有 Bean 一创建就被代理（不管有没有循环依赖）
  → 违背"代理在初始化完成后生成"的设计（Day02：代理要包装最终对象，
    @Transactional 的属性可能来自初始化过程中的修改；过早代理会让
    初始化逻辑作用在"代理壳"上，self-invocation 语义复杂化）
  → 且绝大多数 Bean 根本没有循环依赖，为极端场景付出全量代价

补救方案 B：三级缓存 + ObjectFactory（Spring 的选择）
  → 工厂里包的是 getEarlyBeanReference："被逼无奈要提前暴露时，才决定给什么"
    - 不需要代理 → 返回原始壳
    - 需要代理 → 此刻创建代理（提前暴露的就是代理，B 拿到的正确）
  → 没有循环依赖时，工厂从未被调用，代理仍在正常时点（初始化后）生成
    ——零成本兼容极端场景
```

**一句话总结**：**第三级缓存存的不是对象，是"还没做的决定"**。ObjectFactory 把"要不要提前生成代理"这个决策延迟到"确实有别的 Bean 需要提前引用我"的那一刻——延迟决策（lazy decision）+ 按需执行 + 一次性升级。这与 Netty 的懒加载 ChannelHandler、JVM 的类延迟加载、K8s 的按需调度是同一种智慧：**为少数场景准备的能力，不能让多数场景买单**。

**加分句**：Spring 5.2 之后 getEarlyBeanReference 的默认实现（AbstractAutoProxyCreator）会记录 earlyProxyReferences，保证后续 initializeBean 阶段不会二次创建代理——"提前创建过的，正式流程就复用"，这是**保证代理全局唯一**的记账机制。

#### 5. 为什么构造器与 prototype 解不了（报错机制）

**构造器注入循环**：

```
getBean(A) → beforeSingletonCreation(A)（A 入 inCreation 集合）
→ createBeanInstance(A) 需要构造参数 B → getBean(B)
→ beforeSingletonCreation(B) → createBeanInstance(B) 需要构造参数 A → getBean(A)
→ getSingleton(A)：三级全无（A 还没实例化，工厂都没注册）
  但 isSingletonCurrentlyInCreation(A) == true（第 2 步入的集合）
  → doGetBean 里"只有 inCreation 判断"分支 → 抛
    BeanCurrentlyInCreationException: Requested bean is currently in creation
```

**根因**：A 的暴露点（addSingletonFactory）在实例化**之后**，而构造器注入的依赖需求在实例化**之中**——需求先于暴露，缓存里永远是空的。**三级缓存解决不了时序问题**。

**prototype 循环**：isPrototypeCurrentlyInCreation（ThreadLocal 的 PrototypeObjectsCurrentlyInCreation）检测后同样抛异常。根因：prototype 容器**根本不缓存实例**，连"一级缓存"都没有，更没有地方放半成品——**没有暂存点就没有提前暴露**。

**@Lazy 为什么能剪断环**：注入 A 的地方拿到的是 `ObjectFactory` 派生的**代理**（LazyResolutionProxy），不是 A 本身——B 的创建不需要 A 存在；首次真正调用 A 的方法时才 getBean(A)，那时 B 早已就绪。**环的边从"B 创建时需要 A"松弛成了"B 运行时需要 A"——创建期与使用期的解耦**。这把钥匙后面还会开两扇门：构造器循环的官方解法、循环依赖治理的过渡手段。

#### 6. Boot 2.6 默认禁止循环依赖——架构态度与治理

**事实**：Spring Boot 2.6 起 `spring.main.allow-circular-references` 默认 **false**——检测到循环依赖直接启动失败，要求显式打开才放行（Spring Framework 本身的能力没删，是 Boot 关了默认闸门）。

**为什么一边解决一边禁止（面试必考的"矛盾题"）**：

1. **解决是兼容能力，禁止是架构态度**：三级缓存让"历史遗留的环"不至于崩掉（升级平滑），但环本身是**模块边界不清的坏味道**——A、B 互相依赖意味着两者在概念上是一个模块却拆成了两块，或者有一个"第三概念"没有被抽出来
2. **循环依赖的隐性成本**：Bean 创建顺序变得隐晦（谁先被扫到谁先创建）、初始化时序依赖不可推理（A 的 afterPropertiesSet 时 B 是半成品）、三级缓存的早期引用是"未完全初始化的对象"这个事实容易被遗忘（在 init 回调里使用被提前注入的依赖 → 半成品 NPE）
3. **框架替你兜底久了，你就不会去修**：默认报错是把"设计债"显性化为启动失败——fail-fast 理念在依赖图上的应用（与 Day02 @PostConstruct 抛异常 fail-fast 同一哲学）

**架构师治理路线图（四步）**：

```
第一步 摸底：升级前用 allow-circular-references=false 试跑 CI；
        IDEA 循环依赖检查 / Spring Boot 启动报错清单 / ArchUnit 规则
        @ArchTest static final ArchRule noCycles =
            slices().matching("com.zhuomuniao..(**)").should().beFreeOfCycles()
第二步 归因：每个环归入三类——
        ① 概念未抽出（A、B 其实共同依赖一个隐藏概念）→ 抽中介者/领域服务
        ② 双向读写（A 调 B 查询，B 回调 A 通知）→ 事件解耦（ApplicationEvent，医疗周处方开立通知的同款手法）
        ③ 工具方法误依赖（公共层反向依赖业务层）→ 下沉到独立模块
第三步 过渡：改不动的存量用 @Lazy 标注入点（显式、局部、留 TODO）
第四步 熔断：CI 加 ArchUnit 规则 + Boot 闸门保持 false——防止新增
```

**问诊系统落地叙事**：医保对接模块 HealthInsuranceGateway ↔ PolicySyncService 的循环（网关调同步服务查参保状态、同步服务回调网关上报结果）——归因②，用事件解耦：上报走 `PolicySyncEvent`，监听器调网关，**环变 DAG**。这个叙事在 Day06 串联复盘里作为修复 PR1 完整展开。

#### 7. 架构师视角——从"缓存三级"到"状态发布协议"

把三级缓存抽象到系统设计层，它是一套**对象状态的受控发布协议**：

```
状态机：定义（图纸）→ 实例化（壳）→ 早期可引用（工厂可生产）→ 完全初始化（成品）→ 就绪发布（一级）
发布规则：
  ① 成品发布一次性、不可变（addSingleton 后不再变）
  ② 半成品只在"对方也处于创建中"时可见（allowEarlyReference + inCreation 双条件）
  ③ 半成品的形态由工厂延迟决定（代理决策不提前做）
  ④ 半成品如果被消费过，最终发布物必须与消费物一致（一致性核对，Day07）
```

**同构系统**：

| 系统 | "半成品受控发布"机制 |
|---|---|
| 读写锁的"可重入降级" | 写锁持有中读者看到的旧值快照——读者永远拿到自洽状态 |
| Raft（分布式周） | leader 当选但还没提交日志前不算"就绪"，提交后才对外服务 |
| 数据库 MVCC | 事务中数据对外不可见（回滚可能），提交后一次性可见 |
| K8s | Pod 就绪探针通过才进 Service endpoints——半成品不接流量 |

**架构师落点**：问诊系统的"医生在线状态"推送（医生签到但资料未同步完）就是自己的"早期暴露"问题——**要么等完全就绪再发布（简单但慢），要么设计受控的半成品协议（快但必须管一致性）**。Spring 三级缓存给出的是后者的参考实现：条件可见 + 延迟决策 + 一次性升级 + 一致性核对，四件套一个不能少。

---

## 本日能力差距与补足方向

### 差距1：三级缓存数据结构说不全，"一级 CHM、二三级 HashMap"的锁设计不知道

- **现状**：只背得出三个 Map 名字；不知道二三级是 HashMap 且被 singletonObjects 的锁整体保护——"锁 scope 覆盖非线程安全结构"的设计手法没识别
- **架构师水平**：讲清三个 Map 的访问模式差异（运行期热读 vs 启动期受控写）与锁的不变量设计
- **补足方向**：读 DefaultSingletonBeanRegistry 的三个字段声明与 getSingleton/addSingletonFactory/addSingleton 三个同步方法

### 差距2：完整时序走不下来——第 13 步一致性核对完全空白

- **现状**：A↔B 时序讲到"B 拿到 A 的引用"就断了；getSingleton(name, false) 的语义、exposedObject == bean 的判断、最终暴露对象为什么可能变成"二级里那个"——全部没概念
- **架构师水平**：白板默写 14 步时序，指出两个灵魂考点（谁先完工、一致性核对在防什么）
- **补足方向**：对照第 3 问时序抄写一遍；断点跑一个 AOP + 循环依赖的 demo 观察第 13 步

### 差距3："为什么不能两级"答不到点上——没有 AOP 延迟决策的推理

- **现状**：只会说"为了效率/为了代理"，推不出"直接放壳 → B 拿到原始对象事务失效 / 提前代理 → 全量 Bean 买单"的两难，以及工厂如何解开两难
- **架构师水平**：用反证法三段论作答（两级的问题 → 补救方案 A 的代价 → 工厂=延迟决策零成本兼容），并给出"第三级存的是还没做的决定"这句话
- **补足方向**：把第 4 问反证法抄成笔记并给自己讲一遍；延伸对照 TLS 0-RTT 的同构表

### 差距4：可解域的第一性原理讲不出——"依赖需求时点 vs 可暴露时点"

- **现状**：背"setter 能解构造器不能"，说不出"构造器的依赖需求发生在实例化之中、暴露点在实例化之后"这个时序本质
- **架构师水平**：用"可解当且仅当依赖需求时点晚于可暴露时点"一句话统一全部形态（含 prototype 为什么连暂存点都没有）
- **补足方向**：重读第 1 问 + 第 5 问，把三个"为什么不能"都归约到同一原理

### 差距5：@Lazy 剪环的机制模糊

- **现状**：知道"@Lazy 能解决循环依赖"，说不出注入的是 LazyResolutionProxy、首次调用才 getBean——"创建期依赖松弛成运行期依赖"的本质没抓住
- **架构师水平**：讲清代理剪环的机制，并区分"过渡手段（存量代码）"与"目标手段（抽中介/事件解耦）"的使用边界
- **补足方向**：写一个构造器循环 + @Lazy 的 demo，断点看 ContextAnnotationAutowireCandidateResolver.getLazyResolutionProxyIfNecessary

### 差距6：Boot 2.6 禁止循环依赖的"矛盾题"没准备

- **现状**：不知道 allow-circular-references 默认值变更；"一边解决一边禁止"的架构叙事（兼容能力 vs 设计态度）答不出；治理只有"加 @Lazy"一招，没有四步路线图
- **架构师水平**：给出摸底（CI 试跑/ArchUnit）→ 归因三类 → 过渡（@Lazy 留 TODO）→ 熔断（规则+闸门）的治理方案
- **补足方向**：给问诊系统跑一次 ArchUnit 循环检测；把第 6 问四步路线抄进治理手册

### 差距7：循环依赖报错的判别力为零

- **现状**：分不清 BeanCurrentlyInCreationException 的两种语义（构造器环 vs @Async 提前暴露不一致）、BeanNotOfRequiredTypeException（早期引用是壳导致）——报错出来只能瞎猜
- **架构师水平**：拿报错栈 30 秒定位环的位置与形态（Day07 出判别表，本日先建意识）
- **补足方向**：Day07 深挖时补全四种报错形态判别表；本日先记住 inCreation 集合是环检测器

### 差距8：TLS 证书链验证与前向保密讲不清

- **现状**：只会"HTTPS = http + ssl"；证书链逐级验证的四个要素（签名/有效期/吊销/域名）说不全；RSA 密钥交换为什么没有前向保密、ECDHE 为什么有——没概念
- **架构师水平**：讲清混合加密的理由、证书信任锚的供应链本质、PFS 的"私钥用完即弃"机制——医疗数据传输合规叙事的地基
- **补足方向**：第 1 问重读；对照医保数字证书对接经历梳理一遍证书校验清单

---

## 附录：本日关键认知速查

| 认知点 | 关键结论 |
|---|---|
| 可解域第一性原理 | 可解 ⟺ 依赖需求时点晚于可暴露时点——注入形态决定生死 |
| 三级缓存 | 一级成品（CHM）/ 二级早期引用（HashMap）/ 三级工厂（HashMap）；二三级被 singletonObjects 锁整体保护 |
| 读取路径 | 一级 → 二级 → 三级工厂执行 → 升二级删三级（工厂一次性，代理只提前创建一次） |
| 时序灵魂 | A 被提前暴露、B 被正常创建；doCreateBean 结尾 getSingleton(name,false) 做最终一致性核对 |
| 为什么必须三级 | 工厂=延迟决策（要不要提前建代理）；无循环时工厂不调用零开销——两级则"B 拿原始壳（事务失效）"或"全量提前代理"两难 |
| 一句话 | 第三级缓存存的不是对象，是"还没做的决定" |
| 构造器环 | 暴露点在实例化后、需求在实例化中——inCreation 集合检测报 BeanCurrentlyInCreationException |
| prototype 环 | 无缓存暂存点，无提前暴露——直接报错 |
| @Lazy 剪环 | 注入 LazyResolutionProxy，创建期依赖松弛为运行期依赖 |
| Boot 2.6+ | allow-circular-references 默认 false——兼容能力 vs 设计态度；治理四步：摸底→归因→过渡→熔断 |
| TLS 混合加密 | 非对称只护密钥交换，对称打全程；随机数掺派生防重放 |
| 前向保密 | ECDHE 临时密钥用完即弃，长期私钥泄露解不了历史流量；TLS 1.3 废 RSA 交换 |
| 0-RTT 同构 | 提前暴露部分状态换时间——暴露什么/给谁用/与终态不一致怎么办/无场景是否零成本，四问通用 |