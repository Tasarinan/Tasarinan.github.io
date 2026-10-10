# 架构师学习-Day04-AOP与动态代理

> 日期：2026年09月10日（周四）
> 周主题：Spring 核心源码第1周 - IoC 容器启动流程 / Bean 生命周期与扩展点 / 循环依赖三级缓存 / AOP 与动态代理 / 实战综合
> 出题日：Day04 - AOP 与动态代理

---

## 背景

Day02 指出 AOP 代理生成在 initializeBean 的最后一步（BPP afterInitialization），Day03 指出第三级缓存必须是 ObjectFactory 的唯一充分理由就是代理的延迟创建。今天把代理本身讲透——**代理是 Spring 一切声明式能力的载体**：@Transactional、@Async、@Cacheable、@Lazy、MyBatis Mapper、OpenFeign，全部构建在"对象被换成了代理"这一个事实之上。

**理解了代理，就理解了 Spring 的一半失效问题**。面试官最爱的不是"AOP 怎么用"，而是：

> "JDK 动态代理和 CGLIB 的实现原理与选型？"
> "@EnableAspectJAutoProxy 之后容器里多了什么？代理是谁在什么时机创建的？"
> "自调用为什么失效？画出 this 和代理的内存图。"
> "把 @Transactional 的失效场景一网打尽——你们处方服务那个资损事故，根因是哪个？"（Day06 串联复盘的事故 2）
> "切面执行顺序怎么控？@Around 写了不调用 proceed() 会怎样？"

**与往周专题的衔接点**：

- **并发周 Day02 动态代理**：JDK 代理与 CGLIB 的"怎么造"（InvocationHandler/MethodInterceptor、$Proxy0 生成）已讲过，今天补"**Spring 怎么组织代理**"——Advisor/Advice/Pointcut 的概念三角、拦截链的责任链执行
- **Day03 三级缓存**：getEarlyBeanReference 与 earlyProxyReferences 的记账——代理创建时机的"循环依赖分支"
- **Day01 BPP 提前实例化陷阱**：`not eligible for getting processed by all BeanPostProcessors` 的直接后果就是 AbstractAutoProxyCreator 没跑到——事务/切面失效三大根因之一
- **Netty 周 Pipeline**：Netty 的 handler 链（入站正序/出站逆序）与 Spring 的拦截链（ReflectiveMethodInvocation.proceed 递归）是**责任链模式的两种实现**——一个按方向分层，一个按递归嵌套
- **支付周 @Transactional 实战**：事务传播、隔离级别是支付周的老朋友，今天的视角是"事务的载体——代理——是怎么失效的"

**与简历项目的衔接点**：

1. **处方服务资损事故（Day06 事故 2）**：续方扣库存自调用绕过事务代理，未回滚——今天给出完整失效地图与修复方案
2. **审计日志/敏感脱敏切面**：问诊系统病历导出的横切需求——自定义切面的生产级设计
3. **Feign/Mapper 代理**：在线问诊系统每天在用的两个代理体系，说得出"它们和 AOP 代理的区别"

---

## 热身题（HTTP 版本演进）

### 热身题1：HTTP/1.0 → 1.1 → 2 → 3——队头阻塞的两次搬家

**HTTP/1.0**：每个请求一条 TCP 连接（请求-响应-关闭）。问题：每次都付 TCP 握手 + 慢启动的成本，高延迟场景下吞吐惨不忍睹。

**HTTP/1.1（1997，长连接时代）**：

- **keep-alive 默认开启**：一条连接串行跑多个请求——摊薄握手与慢启动成本
- **管线化（pipelining）的失败**：允许"连发多个请求、按序收响应"，但响应必须按请求顺序返回——**队头阻塞（HOL）首次登场**：第一个响应慢，后面全部排队。加上代理兼容性灾难，浏览器默认禁用——**一个"理论上对、工程上死"的协议设计样本**
- **并发靠多连接**：浏览器对同域名开 6 条连接并行——本质是"用连接数量换并行度"，连接成本（内存、握手、慢启动 ×6）转嫁给传输层
- 基础设施增强：Host 头（虚拟主机）、chunked 分块传输、缓存控制（Cache-Control/ETag）

**HTTP/2（2015，二进制分帧）**：

```
二进制分帧层：报文切成 FRAME（HEADERS/DATA...），帧带 stream id
  → 一条连接上多个 stream 交错传输 —— 多路复用
  → 帧粒度交错 → HTTP 层队头阻塞解决
  → HPACK 头部压缩（静态表+动态表+哈夫曼）：头几百字节压到几十
  → 服务器推送 / 流优先级
```

**但队头阻塞只是搬家了**：HTTP 层不堵了，**TCP 层还堵**——TCP 是字节流协议，stream 2 的帧丢了，内核必须等重传补齐才能把后续字节交给应用层（哪怕 stream 3 的字节已经全部到达）。多路复用把 N 条连接的独立排队合并成 1 条连接的统一排队——**丢包时全部 stream 一起等**。这是"把并行问题下沉一层，又被下层的顺序语义卡住"的典型案例。

**HTTP/3（QUIC over UDP）**：

- 传输层换成 UDP 之上的 QUIC：**stream 之间在传输层就独立**——stream 2 丢包只阻塞 stream 2，stream 3 照常交付（队头阻塞二次搬家后的终解）
- 1-RTT/0-RTT 建连（TLS 1.3 内建，握手与传输协商合并——热身题 Day03 的延续）
- **连接迁移**：连接标识是 Connection ID 而非四元组——手机从 WiFi 切 4G，四元组变了、连接不断（衔接 Netty 周 Day05 连接迁移：**TCP 世界的"连接迁移"只能靠上层重建，QUIC 在协议层原生支持**）
- 代价：UDP 在部分中间设备/防火墙被限速或丢弃；内核态加速不如 TCP 成熟（现在有 eBPF/gSOAP 优化）

**架构师读法**：HTTP 二十年演进的主线就一条——**把"串行的隐式约束"一层层显式化并拆除**（串行请求→分帧交错→传输层独立流）。系统演进同理：找到最深的那个"全局锁"，拆掉它，性能台阶就上一级——这与 JVM 周"G1 拆 CMS 的整堆停顿"、并发周"拆全局锁换粒度更细的锁"是同一个叙事。

### 热身题2：正向代理、反向代理与网关——"代理"一词的三个语义

**辨析（面试高频混淆）**：

| | 正向代理 | 反向代理 | API 网关 |
|---|---|---|---|
| 部署位置 | 客户端侧 | 服务端侧 | 服务端边界 |
| 谁知道它存在 | 客户端知道、服务端不知道真实客户端 | 客户端不知道真实服务端 | 双方都知道 |
| 核心职责 | 代客户端出海（翻墙/缓存/审计/出口收敛） | 代服务端接客（LB/SSL 终结/缓存/防护） | 南向流量治理（路由/鉴权/限流/协议转换） |
| 典型实现 | Squid、Shadowsocks、企业出口代理 | Nginx、HAProxy、云 LB | Kong、APISIX、Spring Cloud Gateway |

**与 Spring AOP 的"代理"对照（本日正题的引子）**：网络代理拦截的是**网络请求**，AOP 代理拦截的是**方法调用**——都是"在真实对象之前插一层，控制访问并织入横切逻辑"。**代理模式的本质从未变过：客户端不直接接触真实对象，通过中间层获得可插拔的控制点。** 面试时能把网络代理、Spring AOP、MyBatis Mapper 代理统一到"代理=受控的间接层"一句话上，是抽象能力的直接展示。

**正向代理的经典工程问题——出口 IP 收敛**：企业内网全部流量走出口代理 → 目标服务看到的全部是同一个 IP → 限流/风控误杀。同构问题：NAT 后所有客户端共享公网 IP（tcp_tw_recycle 被 NAT 误杀的历史——Day01 热身题）、SNAT 后长连接风暴（Netty 周）。**"共享出口身份"的系统必须在出口层做身份还原（X-Forwarded-For/PROXY protocol）——否则上游的封禁粒度只能到整个出口**。

---

## 题目一（AOP 与动态代理全解题）：从 @EnableAspectJAutoProxy 到失效地图

### 作答区

#### 1. AOP 概念体系与织入时机——Spring AOP 在 AOP 光谱上的位置

**概念三角（用"一句话+谁实现"记）**：

```
Aspect（切面）     = 横切关注点的模块化载体（一个 @Aspect 类）
  ├─ Pointcut（切点）= 在哪织（表达式：execution/within/annotation...）
  └─ Advice（通知）  = 织什么（@Before/@After/@AfterReturning/@AfterThrowing/@Around）
JoinPoint（连接点） = 程序执行的点（Spring 只支持方法级；AspectJ 还有字段/构造器）
Advisor            = Pointcut + Advice 的最小完整单元（Spring 内部的组织形态）
Weaving（织入）    = 把 Advice 挂到 JoinPoint 的过程
```

**织入时机的三档（架构师选型题）**：

| 织入时机 | 实现 | 能力边界 | 典型场景 |
|---|---|---|---|
| **编译期** | AspectJ ajc 编译器 | 方法、字段、构造器、静态方法全覆盖 | 刚性监控 SDK、代码不能改的遗留系统 |
| **类加载期** | AspectJ LTW（javaagent） | 同上 + 运行时无侵入 | 生产环境诊断（衔接 10 月 Java Agent 专题） |
| **运行期** | **Spring AOP（动态代理）** | **只能拦截 public 方法调用**（通过代理对象进入） | 业务系统的声明式事务/缓存/异步 |

**Spring AOP 的本质定位**：不是"阉割版 AspectJ"，而是**"IoC 容器与 AOP 的集成层"**——它解决的核心问题不是"最强的织入能力"，而是"代理对象交给容器管理、与依赖注入天然融合"。AspectJ 处理"类级别的刚性织入"，Spring AOP 处理"Bean 级别的声明式增强"——**两者可以在一个系统里共存**（@EnableLoadTimeWeaving）。选型判据：**要拦截"非方法调用"（构造、字段访问、静态）或"非 Spring 管理的对象"，才需要真上 AspectJ；99% 的业务诉求（事务/日志/审计）Spring AOP 够用**。

#### 2. JDK 动态代理 vs CGLIB——原理与 Spring 的选型

**JDK 动态代理**（并发周已讲生成原理，这里补 Spring 视角）：

```
前提：目标类实现了接口
机制：运行时生成 $Proxy0 extends Proxy implements 业务接口
     方法调用 → invoke(Object proxy, Method m, Object[] args) → 分发到 InvocationHandler
调用：反射 Method.invoke(target, args) —— 反射开销是每次调用的固定税
```

**CGLIB（Code Generation Library）**：

```
机制：运行时生成目标类的子类（Enhancer + MethodInterceptor）
     方法调用 → 子类覆盖方法 → intercept(Object obj, Method m, Object[] args, MethodProxy proxy)
优化：FastClass 机制——为代理类和目标类各生成一个索引类，
     MethodProxy.invokeSuper 用 int 索引直接定位方法，**绕开反射**
限制：final 类/方法无法代理（不能继承/覆盖）；构造器会被调用两次（一次父类、
     一次代理类——Spring 用 Objenesis 绕开）；不能拦截 private/static
```

**Spring 的选型逻辑**：

- `ProxyFactory` 逐个判断：有接口且 proxyTargetClass=false → JDK；否则 CGLIB
- **Boot 2.x 起 `spring.aop.proxy-target-class` 默认 true——一律 CGLIB**：统一行为（注入按类型不再要求接口存在）、避免" JDK 代理注入具体类型失败"的坑（proxy 只实现了接口，注入具体类就 ClassCastException）
- JDK17+ 模块系统的暗坑：JDK 代理生成在 java.lang.reflect.Proxy 的保护域没有新问题，但 CGLIB 生成类访问同包/私有成员受模块边界约束——**升级 JDK 前查 CGLIB 兼容性**（Spring 6 用了重写的 CGLIB 适配）

**代理类的成本账（衔接 JVM 周 Metaspace）**：每个被代理类生成一个代理类（JDK：接口组合一个；CGLIB：每个目标类一个），**进 Metaspace 常驻**。几千个 Bean 全被切面覆盖 = 几千个动态生成类——Day01"CGLIB 增强类是 Metaspace 隐性大头"的落点。**切面 Pointcut 收敛（按注解切而不是 execution(* com..*.*(..))）不仅是行为洁癖，是内存账**。

#### 3. Spring AOP 实现链路——从注解到代理对象

**@EnableAspectJAutoProxy 的真身**：

```
@EnableAspectJAutoProxy
  → @Import(AspectJAutoProxyRegistrar.class)
  → 注册 AnnotationAwareAspectJAutoProxyCreator 的 BeanDefinition
     —— 它是 AbstractAutoProxyCreator 的子类
     —— AbstractAutoProxyCreator implements BeanPostProcessor（在 after 阶段生成代理）
                              + InstantiationAwareBeanPostProcessor（before 实例化阶段有个
                                TargetSource 特殊路径——自定义 TargetSource 提前短路，极少用）
                              + SmartInstantiationAwareBeanPostProcessor
                                （getEarlyBeanReference——Day03 循环依赖的代理提前创建！）
```

**代理创建的完整链路（每个 Bean 初始化后）**：

```
postProcessAfterInitialization(bean, name)
  → wrapIfNecessary(bean, name, cacheKey)：
    ① shouldSkip：AspectJ 切面自身的 Bean 跳过（切面对象不代理）
    ② getAdvicesAndAdvisorsForBean：
       findCandidateAdvisors —— 找出容器里全部 Advisor Bean
         + 解析 @Aspect 类：每个 @Before/@Around... 方法包成
           InstantiationModelAwarePointcutAdvisorImpl（注解→Advisor 的翻译）
       findAdvisorsThatCanApply —— canApply(Advisor, targetClass)：
         AspectJExpressionPointcut.matches 类级/方法级匹配
         （精确匹配算法：先方法后类型、考虑桥方法——泛型接口实现的方法匹配）
    ③ 有匹配 → createProxy：
       ProxyFactory 组装（targetSource + advisors + exposeProxy 设置 +
         冷冻标志 frozen）
       → chooseProxyFactory → JdkDynamicAopProxy 或 ObjenesisCglibAopProxy
       → 代理对象放入缓存（proxyTypes）
```

**方法调用的执行链（责任链模式的标准实现）**：

```
proxy.method(args)                          // 客户端只见到代理
  → JdkDynamicAopProxy.invoke(...)          // 或 CglibAopProxy 动态 intercept
    ① 目标方法上的拦截链获取（按 Method 维度缓存 advisor 链——匹配一次，复用）
    ② 链为空 → 直接反射调目标
    ③ 链非空 → ReflectiveMethodInvocation(mi)：
       proceed() 递归推进索引 —— 每层 Advice 是链上的一个环节
         @Before → MethodBeforeAdviceInterceptor.invoke之前执行
         @Around → 环绕包裹后续全部环节（proceed 前后夹逻辑，不调 proceed = 链断裂！）
         @After → 在 finally 语义里
       最深处 invokeJoinpoint() → 反射调用真实方法
```

**四个源码级细节（高区分度）**：

1. **Advisor 链按 Method 缓存**——切点匹配（尤其表达式匹配）昂贵，匹配结果缓存在 advised 的缓存结构里；**这是"解析一次执行多次"在 AOP 的重现**（Day02 注入元数据同款手法）
2. **@Around 不调 proceed() = 吞掉目标方法和后续所有环节**——切面能改写行为也能吞掉行为，review 环绕切面必查 proceed
3. **拦截链的顺序 = Advisor 的 @Order 升序**（数值小先执行/在外层）——事务 Advisor 默认 Ordered.LOWEST_PRECEDENCE，自定义切面不给 @Order 就是"最内层、时序漂移"
4. **与 Netty Pipeline 的对照**：Netty 链按"方向"分入站/出站两条；Spring 链是**单向递归嵌套**（洋葱模型）——**方向感知的双链 vs 洋葱单链**是责任链的两种形态；洋葱模型里"@Around 的前半段=出站方向、后半段=入站方向"（思想对应，方向相反）

#### 4. @Transactional 失效全图——从"this 的内存图"讲起

**失效的第一性原理（一张内存图）**：

```
容器里的 prescriptionService（代理对象，含事务 Advisor）
        ↑ 被注入到其他 Bean 的引用
        │
prescriptionService.renew(...)   ← 外部调用走代理 → 事务拦截链生效 ✅

this（原始对象，无任何 Advisor）——代理内部持有的 target
        ↓
this.doRenew(...)                ← 自调用：方法体内 this 指向原始对象
                                      直接调目标方法，不经过代理 → 事务失效 ❌
```

**为什么 this 是原始对象**：代理的实现方式是"代理持 target 引用、拦截后反射调 target"——**目标方法内部的 this 永远是 target 本身**，语言层面无法改变（除非字节码织入——AspectJ 没有这个失效问题，因为它直接改写类本身）。**一切"代理型 AOP"的失效都源于这条语言级事实。**

**失效全图（三大族十二式）**：

| 族 | 失效场景 | 根因 | 修复 |
|---|---|---|---|
| **代理绕过族** | 1. 自调用（this.method()） | this=原始对象 | 拆 Bean / 自注入 / AopContext.currentProxy |
| | 2. new 出来的对象调用 | 根本不是容器 Bean | 交给容器管理 |
| | 3. BPP 提前实例化连坐 | 错过 AbstractAutoProxyCreator | Day01 陷阱日志；BPP 不依赖业务 Bean |
| | 4. 非 public 方法 | Spring 事务默认仅 public（代理拦截语义） | 改 public / TransactionTemplate |
| | 5. final/static 方法 | CGLIB 无法覆盖 | 去 final；换设计 |
| **配置语义族** | 6. rollbackFor 不匹配 | 默认只回滚 RuntimeException+Error | rollbackFor = Exception.class |
| | 7. try-catch 吞异常 | 拦截器看不到异常，正常提交 | catch 后手动 setRollbackOnly 或抛出 |
| | 8. 传播行为误用 | REQUIRES_NEW 内外两事务、NOT_SUPPORTED 挂起 | 语义表重学（支付周） |
| | 9. 多线程调用 | 事务上下文绑定 ThreadLocal（TransactionSynchronizationManager） | 线程池内手动传递/独立事务 |
| | 10. 引擎不支持 | MyISAM 无事务 | InnoDB |
| **环境族** | 11. 数据源没纳入事务管理器 | @EnableTransactionManagement / Boot 自动装配缺失 | 检查自动配置报告 |
| | 12. @Async 与事务叠加 | 异步方法在新线程，事务上下文断链 | 异步方法内部自建事务 |

**处方服务资损事故的定位路径（Day06 完整复盘的预演）**：续方操作 `renew()` 内部 this 调 `deductInventory()`（扣库存，REQUIRES 传播）→ renew 外层抛异常回滚了主事务，但 deductInventory 的事务**根本没开启**（自调用）→ 库存扣了、续方失败了 → 对账发现"库存流水与订单状态不一致"。**注意自调用的隐蔽性：日志里没有任何报错，SQL 正常执行——失效是静默的，只能靠对账发现**（支付周对账体系的又一次救场）。

**三种修复姿势的权衡**：

| 姿势 | 写法 | 适合 | 代价 |
|---|---|---|---|
| 拆 Bean（推荐） | deductInventory 抽到 InventoryService | 一切场景的默认答案 | 多一个类（这本来就是对的设计信号） |
| 自注入 | `@Autowired private InventoryService self;` | 不想拆 | 循环自引用（能被容器处理但别扭）、可读性 |
| AopContext.currentProxy | `((InventoryService) AopContext.currentProxy()).deduct()` | 框架内部/极少数 | 需要 @EnableAspectJAutoProxy(exposeProxy=true)（ThreadLocal 暴露——**有上下文泄漏隐患，治理清单级慎用**） |

#### 5. @Async 与代理——另一个失效家族 + 一个循环依赖地雷

**@Async 的实现与失效**：AsyncAnnotationBeanPostProcessor（AbstractAdvisingBeanPostProcessor 子类）在 BPP after 阶段给 Bean 织入异步 Advisor——方法调用被拦截 → 提交到 executor → 立即返回。

**与 @Transactional 失效的共性**：一切"代理织入的声明式能力"共享自调用/非 public/BPP 连坐失效——**失效地图的复用性就在这：学会一族，覆盖 @Transactional/@Async/@Cacheable 全家**。

**@Async 独有的三个坑**：

1. **返回值语义**：非 Future 返回值 → 调用方拿不到结果也拿不到异常（异常被吞，日志 Unknown）——必须返回 CompletableFuture 并在调用侧 join/compose
2. **默认线程池**：Boot 自动配 applicationTaskExecutor；**纯 @EnableAsync 无 Boot → SimpleAsyncTaskExecutor——不池化、每次新建线程，流量一高线程爆炸**（并发周线程池事故的 AOP 版）
3. **循环依赖地雷（衔接 Day03，Day07 完整反推）**：@Async 的 Bean 卷进循环依赖时，早期暴露的对象与最终对象**不一致**（AsyncAnnotationBPP 不是 SmartInstantiationAwareBPP，不会在 getEarlyBeanReference 里提前织入）→ Spring 检测后直接抛 `BeanCurrentlyInCreationException: ... has been injected into other beans ... in its raw version as part of a circular reference`——**@Transactional 不炸而 @Async 炸，差异就在有没有实现 getEarlyBeanReference**（TransactionAdvisor 的代理生成走 AbstractAutoProxyCreator，有提前暴露能力）。

#### 6. Spring 失效地图（Day01 预告、今天收官的交付物）

**三大失效家族 + 一张地图（建议贴在团队 wiki）**：

```
Spring 失效地图
├── 代理失效族（一切基于代理的声明式能力：@Transactional/@Async/@Cacheable/@Retryable）
│     自调用（this） · new 对象 · 非 public · final/static · BPP 提前实例化连坐
│     统一根因：调用没有经过代理对象
│     统一检测：AopUtils.isAopProxy(bean) 断言 / 日志搜 "not eligible for getting processed"
├── 作用域失效族
│     prototype 注入单例失活（只注入一次） · prototype 无人销毁（资源泄漏）
│     request/session Bean 注入单例（需要 scoped proxy）
│     统一根因：作用域语义与注入时点冲突（注入发生在创建时，作用域要的是运行时语义）
│     统一修复：ObjectProvider / @Lookup / scoped proxy
├── 顺序失效族
│     BPP 提前实例化（错过后续 BPP） · Bean 赌定义顺序（@DependsOn 缺失）
│     · ContextRefreshedEvent 多次触发（父子容器）
│     · Runner 里才该做的预热放进了 @PostConstruct
│     统一根因：正确性建立在隐式顺序上
│     统一修复：显式声明顺序（@DependsOn/@Order/构造器注入）/ 挂点选型表（Day02 第 5 问）
└── 循环依赖族（Day03）
      构造器环 · prototype 环 · @Async 卷入环的报错
      统一根因：依赖需求时点早于可暴露时点
      统一修复：抽中介/事件解耦；@Lazy 过渡；Boot 2.6 闸门
```

**面试讲法（30 秒版）**：Spring 的声明式能力全部构建在"代理 + 生命周期挂点"两个机制上，所以失效也集中在四族：代理被绕过（自调用）、作用域被注入时点固化（prototype 失活）、顺序被隐式依赖（BPP 连坐）、依赖图有环（构造器循环）。每族都有统一根因和统一检测手段——**失效地图的本质是把"散落的八股"收敛成"机制的推论"**。

#### 7. 架构师视角——代理是"声明式基础设施"的通用底座

**为什么代理能承载一切声明式能力**：把"每个方法都要写的样板逻辑"（开事务/打日志/异步提交）从**代码内**搬到**代码外的中间层**——条件是"这段逻辑只依赖方法调用的元信息"（方法名、参数、注解）。**代理 = 方法调用层面的"流量中间层"**——与网络栈的"请求中间层"（过滤器/网关/Service Mesh sidecar）同构：

| 层 | 中间层 | 织入的东西 |
|---|---|---|
| 方法调用层 | Spring AOP 代理 | 事务/审计/缓存/异步 |
| 进程内请求层 | Filter/Interceptor | 鉴权/trace/编码 |
| 网络请求层 | 反向代理/网关 | LB/SSL 终结/限流 |
| 网络报文层 | Service Mesh sidecar | 熔断/重试/mTLS |

**四层是同一个模式（拦截+织入）在不同粒度的复制**——Istio 之于网络 ≈ Spring AOP 之于方法。**架构师看到任何"横切需求"，第一反应就是问：它应该织在哪一层？** 判据：横切逻辑需要什么粒度的上下文（方法参数？请求头？报文？）+ 侵入成本。

**切面治理的生产纪律（团队级）**：

1. **切面清单注册制**：每个切面在 wiki 登记（名称/Pointcut/Order/Owner）——切面是全局行为，散落即失控
2. **@Order 必须显式**：与事务 Advisor 的相对顺序要写清（如"脱敏在内、事务在外：脱敏数据已落库前"）
3. **切面耗时纳入观测**：@Around 里埋点（executeTime → Micrometer），**切面自身成为性能劣化的隐蔽来源**（每个请求多几 ms × 深链路）
4. **Pointcut 收敛**：注解切（@Mask）优于表达式宽切（execution(* com..*.*(..))）——既是行为洁癖也是 Metaspace 账
5. **Around 必查 proceed()**：不调用即吞链——code review 硬规则

**简历叙事（审计脱敏切面，问诊系统）**：病历导出需要敏感字段脱敏（患者姓名/身份证/手机号）——@Mask 注解 + AbstractAnnotationAdvisor（注解切，只影响标注的 Bean）；Order 排在事务内层（导出查询结果脱敏，不影响落库原文——**原文落库、导出脱敏，合规与功能的平衡**）；脱敏规则从配置中心热更新（切面只持规则引用）。这个叙事同时展示了：自定义 Advisor、顺序治理、切面性能意识、合规思维——四层架构师能力。

---

## 本日能力差距与补足方向

### 差距1：Spring AOP 实现链路讲不出——从注解到代理对象是黑盒

- **现状**：知道"@EnableAspectJAutoProxy 开启 AOP"，说不出它 Import 的 Registrar 注册了什么、AnnotationAwareAspectJAutoProxyCreator 是 BPP、wrapIfNecessary 的三步（找候选/匹配/建代理）、@Aspect 方法怎么变成 Advisor
- **架构师水平**：白板默写"注解→后置处理器→Advisor 翻译→Pointcut 匹配→ProxyFactory→拦截链"全链路，并标出 Day03 的 getEarlyBeanReference 挂在哪
- **补足方向**：读 AbstractAutoProxyCreator.wrapIfNecessary 与 AnnotationAwareAspectJAutoProxyCreator.findCandidateAdvisors

### 差距2：拦截链执行机制模糊——proceed 递归与 Order 排序

- **现状**：不知道 Advisor 链按 Method 缓存、ReflectiveMethodInvocation.proceed 是递归推进索引、@Around 不调 proceed 会吞链；Order 数值与内外层的关系说不清
- **架构师水平**：讲洋葱模型执行序；解释"两个 Order"（Day02 遗留问题：BPP 的 Ordered vs Advisor 的 @Order——代理外壳层 vs 拦截链内层）
- **补足方向**：断点跟一次 ReflectiveMethodInvocation.proceed；写两个 @Around 切面打印前后日志验证嵌套序

### 差距3：失效场景只会背自调用，没有"三大族"的结构化地图

- **现状**：@Transactional 失效只会答"自调用失效"；rollbackFor 默认值、多线程 ThreadLocal 断链、MyISAM 这些散点答不全，更没有族级归纳
- **架构师水平**：30 秒讲四族失效地图（代理/作用域/顺序/循环依赖），每族统一根因+统一检测；把散落八股收敛成机制推论
- **补足方向**：默写第 4 问失效全图；在问诊系统代码里找三个失效隐患（自调用 try-catch 吞异常的最常见）

### 差距4："this 是原始对象"的内存图画不出——第一性原理没建立

- **现状**：知道自调用失效，讲不出"代理持 target 引用、方法体内 this 永远是 target"这条语言级事实；也就推不出"为什么 AspectJ 没有这个问题"
- **架构师水平**：画内存图解释；延伸讲"字节码织入改写类本身 vs 代理包外壳"的本质差异
- **补足方向**：把第 4 问内存图抄进笔记；跑 demo 用 AopUtils.isAopProxy(this) 验证

### 差距5：@Async 的坑没系统认知——默认线程池事故与循环依赖地雷

- **现状**：不知道非 Future 返回值异常被吞、SimpleAsyncTaskExecutor 不池化的爆炸、@Async 卷入循环依赖会报 "raw version" 异常而 @Transactional 不会——最后这个差异（有没有实现 getEarlyBeanReference）完全空白
- **架构师水平**：讲清三类坑的机制与修复；@Async vs @Transactional 在循环依赖下的分歧行为是面试天花板题
- **补足方向**：Day07 会完整反推，先记结论；检查问诊系统的 @Async 线程池配置是否显式

### 差距6：切面治理没有纪律——全局行为散落即失控

- **现状**：自己写的切面没登记、没有 @Order、没埋耗时点；Pointcut 用宽表达式；没意识到切面是 Metaspace 和运行时耗时的双重成本
- **架构师水平**：落地五条纪律（注册制/显式 Order/耗时观测/Pointcut 收敛/proceed 必查），并把脱敏切面写成简历叙事
- **补足方向**：给问诊系统建切面清单；审计现有切面的 Order 与表达式宽度

### 差距7：HTTP 演进主线抓不住——队头阻塞两次搬家讲不清

- **现状**：知道 HTTP/2 多路复用，说不出 1.1 管线化为什么失败、HTTP/2 的 HOL 搬到了 TCP 层、QUIC 怎么在传输层解决；连接迁移的四元组 vs Connection ID 没概念
- **架构师水平**：用"串行约束的显式化拆除"一条主线讲二十年演进；对照 Netty 周 TCP 语义的局限
- **补足方向**：重读热身题 1；把"层与层之间的约束搬家"画成一张四层图

### 差距8：代理的抽象统一没建立——网络代理/AOP/Mapper 是三个孤立概念

- **现状**：正向/反向代理、Spring AOP、MyBatis Mapper 代理在脑子里是三回事；"拦截+织入"的统一模式和"横切需求织在哪层"的判据没有
- **架构师水平**：一张表统一四层中间层（方法/进程内/网络请求/报文 sidecar）；对任意横切需求 30 秒判定织入层
- **补足方向**：把第 7 问四层对照表抄进笔记；用"织在哪层"重新审视问诊系统的鉴权与 trace 链路

---

## 附录：本日关键认知速查

| 认知点 | 关键结论 |
|---|---|
| Spring AOP 定位 | IoC 与 AOP 的集成层：Bean 级声明式增强；拦截非方法调用才需要 AspectJ |
| JDK vs CGLIB | JDK 反射调用（接口）；CGLIB 子类 + FastClass 索引直调；Boot 2.x 默认 CGLIB；final 是 CGLIB 天敌 |
| 实现链路 | @Enable 注解 → Registrar 注册 AbstractAutoProxyCreator（BPP）→ after 阶段 wrapIfNecessary（找 Advisor→匹配→ProxyFactory） |
| 概念三角 | Aspect = Pointcut（在哪）+ Advice（织什么）；Advisor 是 Spring 内部最小单元 |
| 执行链 | ReflectiveMethodInvocation.proceed 递归（洋葱模型）；Advisor 链按 Method 缓存；@Around 不调 proceed = 吞链 |
| 失效第一性原理 | 代理持 target，方法体内 this 永远是原始对象——一切代理型 AOP 失效的源头 |
| @Transactional 失效 | 三族十二式：代理绕过（自调用/new/非public/final/连坐）+ 配置语义（rollbackFor/吞异常/传播/多线程）+ 环境 |
| @Async 三坑 | 返回值吞异常 / SimpleAsyncTaskExecutor 不池化 / 循环依赖报 "raw version" 异常 |
| 失效地图 | 四族：代理失效 × 作用域失效 × 顺序失效 × 循环依赖——每族统一根因+统一检测 |
| 两个 Order | BPP 的 Ordered=代理外壳层数；Advisor 的 @Order=链内执行序（数值小在外层） |
| 切面纪律 | 注册制 / 显式 Order / 耗时观测 / Pointcut 收敛（Metaspace 账）/ proceed 必查 |
| 代理统一观 | 方法层代理 ≈ 网络层中间层：拦截+织入的模式在不同粒度复制（AOP→Filter→网关→sidecar） |
| HTTP 演进主线 | 串行约束显式化拆除：串行请求→分帧（H2）→传输层独立流（H3/QUIC） |
| HOL 两次搬家 | 1.1 响应按序（管线化死）→ H2 帧交错但 TCP 字节流仍堵 → QUIC stream 独立终解 |
| 正反代理辨析 | 正向=客户端出海（身份收敛问题）；反向=服务端接客（LB/SSL 终结）；网关=南向治理 |