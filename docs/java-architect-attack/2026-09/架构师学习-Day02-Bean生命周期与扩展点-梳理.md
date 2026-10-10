# 架构师学习-Day02-Bean生命周期与扩展点-梳理

> 日期：2026年09月08日（周二）
> 周主题：Spring 核心源码第1周 - IoC 容器启动流程 / Bean 生命周期与扩展点 / 循环依赖三级缓存 / AOP 与动态代理 / 实战综合
> 梳理日：Day02 - 架构师视角梳理

---

## 一、流水线的架构师读法：一条"多阶段构造"参考实现

Day02 的核心是 AbstractAutowireCapableBeanFactory.doCreateBean 的总装线。架构师读它的方式不是背步骤，而是识别出三个通用设计手法：

1. **解析与执行分离**：注入元数据（InjectionMetadata）在 applyMergedBeanDefinitionPostProcessors 一次解析、按类缓存，populateBean 反复消费——反射密集型框架的性能通用姿势（与 Netty Week 的"编解码器复用"、Kafka 的"schema 缓存"同构）
2. **受控的例外**：流水线单向推进，唯一的例外是 addSingletonFactory 的"半成品提前暴露"——它不是破坏设计，而是**为循环依赖精心开的一个窗口**，且暴露的是 ObjectFactory（延迟决策）而非对象本身（Day03 全部内容）
3. **代理放最后**：BPP afterInitialization 才生成代理——代理包装的是最终对象。这个"位置决策"决定了 Day04 一整族失效问题的形状（自调用、this 逃逸）

**多阶段构造范式的四要素**（可迁移到任何自研组件）：

```
阶段化构造（实例化→装配→初始化→服役→停机→销毁）
  + 每阶段间标准钩子（Aware / InitializingBean / BPP / Lifecycle）
  + 单向推进（受控例外：提前暴露）
  + 失败分阶段语义（未服役=清理重来；服役中=停机序列）
```

同构：Servlet（init/service/destroy）、Netty Channel（handlerAdded→active→read→inactive）、K8s Pod（Pending→Running→Terminating + postStart/preStop 钩子）。**Spring 的价值是给了这套范式一个工业级的参考实现**。

---

## 二、钩子体系的全景地图：按"看得见什么"分层

Day02 最容易乱的十几个回调接口，按**作用域**分四层记忆：

| 层 | 看得见什么 | 接口 | 时机 |
|---|---|---|---|
| Bean 私有层 | 只有自己 | @PostConstruct / afterPropertiesSet / init-method | 自己初始化期 |
| Bean 级横切层 | 每一个 Bean | BeanPostProcessor（before/after） | 每个 Bean 初始化前后 |
| 全量就绪层 | 全部单例 | SmartInitializingSingleton | preInstantiateSingletons 循环后 |
| 容器/应用层 | 整个容器（+端口/命令行） | SmartLifecycle.start → ContextRefreshedEvent → ApplicationRunner → ApplicationReadyEvent | finishRefresh 之后 |

**两条时序铁律**（启动排查基本功）：

1. **SmartLifecycle.start 在 ContextRefreshedEvent 之前**——监听事件时端口已开。想赶在端口开放前做事，只能用更小的 phase 或 Bean 私有钩子
2. **预热重活放 ApplicationRunner**，且必要时异步化 + 就绪标志位——@PostConstruct 是启动耗时的头号污染源（Day01 第 5 问的 Bean 粒度根因）

**选型决策树**：

```
这段逻辑需要其他 Bean 吗？
 ├─ 不需要且只涉及自己 → @PostConstruct（保持轻）
 ├─ 需要全部 Bean 就绪 → SmartInitializingSingleton（Bean 层收口）
 ├─ 需要容器+端口就绪 → ContextRefreshedEvent（防重！）或 SmartLifecycle（要相位控制时）
 └─ 需要"应用级就绪"（Boot 语义，含 runners 顺序）→ ApplicationRunner（@Order 控制多 Runner 顺序）
```

---

## 三、销毁阶段：与初始化的镜像对称，加上拓扑排序

初始化是"按依赖图正序"（依赖先就绪），销毁是"按依赖反向图逆序"（被依赖的最后死）——**同一个图，两种遍历方向，保证任何时刻"还活着的 Bean 的依赖都还活着"**。这与 K8s initContainer 正序 / 容器终止逆序、操作系统驱动加载/卸载顺序完全同构。

**优雅停机的工程链路（问诊系统发布时刻的完整翻译）**：

```
K8s: preStop(sleep 摘流生效) + SIGTERM
  → JVM shutdown hook → doClose
  → ContextClosedEvent（监听器还能跑）
  → SmartLifecycle.stop（phase 降序，WebServer 停 accept → drain 存量）
  → Bean 逆序销毁（@PreDestroy → destroy() → destroy-method；数据源垫底）
  → JVM 退出；terminationGracePeriodSeconds=90 兜底 SIGKILL
```

**架构师落点**：发布窗口 = 启动时间 + readiness 确认 + drain 时间（Day01 公式）里的 drain，就是 SmartLifecycle 停止到 Bean 销毁完成这段——**优雅停机做得越确定，gracePeriod 可以设得越紧，发布越快**。

**prototype 的放养**：容器不管理其销毁——资源型 prototype 是泄漏隐患。与"prototype 注入失活"合成 prototype 的两面坑（注入面：语义失效；资源面：无人回收）。

---

## 四、初始化三回调的顺序设计：一次"标准/契约/配置"的分层教学

@PostConstruct（JSR-250 标准）→ afterPropertiesSet（框架接口契约）→ init-method（部署配置），顺序背后是三条设计原则：

1. **标准协议先于框架私有实现**——生态互操作的前提（换一家的容器，标准注解的钩子依然先跑）
2. **编译期契约先于部署期配置**——确定性优先于灵活性
3. **用户自定义入口最后**——用户代码拿到"框架已做完一切"的对象

这三条原则的适用远超 Spring：API 设计中 SPI 回调、生命周期事件、拦截器链的排序，都可以直接套用。**"为什么是这个顺序"比"顺序是什么"值钱十倍**——面试官在前者上区分背八股的和读源码的。

---

## 五、BPP 编写纪律：影响力与伤害面成正比

BPP 作用于每一个 Bean——它是 AOP、注入、Aware 的载体，也是最容易被写坏的一层。五条生产纪律（不注入业务 Bean / 实现 Ordered / 热路径尽快放行 / 不做远端调用 / 幂等），核心是**把 BPP 当基础设施对待，而不是当业务代码对待**。

**两个 Order 的区分**是切面治理的认知地基：

```
BPP 的 Ordered：决定"代理外壳套几层"的顺序（多个 BPP 各自包一层代理时）
Advisor 的 @Order：决定"同一代理内部拦截链"的执行顺序
两个不同的轴——前者是"洋葱的皮"，后者是"洋葱内圈圈的先后"
```

分不清这两个轴，"脱敏应该在事务之后执行"这类需求就永远说不清落点（Day04 第 4 问展开拦截链顺序）。

---

## 六、热身题的架构回响：TCP 可靠传输的通则

TCP 三件套——重传（补送达）+ 序列号去重 + 排序——跨出 TCP 边界就没有了任何等价物：MQ 至少一次、HTTP 超时重试、RPC failover，都是"应用层重传"却没有应用层序列号。**所以业务层必须自带三件套**：重试机制、幂等键、顺序保障（版本号/状态机）——支付周三防闭环、MQ 周顺序性与幂等，全部是这条通则的实例。

**拥塞控制是"分布式系统全局最优的自私版本"**：每个端只看本地信号（丢包/RTT），共同收敛到公平分享——与集群限流（中心配额）互为镜像。窗口必须匹配 BDP（带宽×RTT）的公式，是医保专线、跨地域机房调优的核心账——**窗口小于 BDP 就是花钱买闲置**。

---

## 七、与往周专题的同构连接表

| 往周主题 | 本周连接点 | 同构本质 |
|---|---|---|
| Netty Day02 启动链路 | bind→register→doBind0 三段异步 vs doCreateBean 三大步 | 多阶段构造 + 状态机推进的两种实现 |
| Netty Day04 水位背压 | rwnd 通告 / 零窗口探测 / 糊涂窗口攒批 | 生产者感知消费者能力的闭环 + 攒批权衡 |
| Netty Day05 连接迁移 drain | SmartLifecycle 停止 → 排空 → 销毁 | 优雅停机的分层排空 |
| K8s Day02 发布工程 | shutdown hook vs SIGKILL、terminationGracePeriodSeconds | 停机确定性与发布窗口 |
| K8s Pod 生命周期 | postStart/preStop 钩子、探针 | 多阶段构造 + 健康信号分层 |
| 支付幂等三防 | TCP 重传+去重+排序 vs 业务幂等 | 协议层没做的，业务层必须自己做 |
| JMM（并发周） | 流水线每一步的写都在 addSingleton put 之前 | 安全发布的 happens-before 链 |
| JVM 类加载 | createBeanInstance 触发 loadClass | Day01"实例化才加载"的落地点 |
| 限流周 | TCP 拥塞控制（端侧信号近似全局）vs 集群限流（中心配额） | 全局控制的两种信息结构 |

---

## 八、本日核心认知

1. **总装线三大步**：实例化（推断构造器）→ 注入元数据解析（一次解析缓存复用）→ addSingletonFactory → populateBean（注入真正发生）→ initializeBean → 注册销毁
2. **initializeBean 四子步**：Aware 直调 → BPP before（@PostConstruct 在这）→ init 方法（接口先于配置）→ BPP after（**AOP 代理生成点**）
3. **三 init 顺序的三层理由**：标准先于实现、契约先于配置、代理包装最终对象
4. **就绪四层语义**：单 Bean → 全单例 → 容器+端口 → 应用；**SmartLifecycle.start 在 ContextRefreshedEvent 之前（端口已开）**；预热放 ApplicationRunner 且异步化
5. **销毁 = 依赖反向图逆序 + 镜像对称三回调**；SmartLifecycle.stop 先于 Bean 销毁；Boot 自动注册 hook，SIGKILL 是天敌
6. **prototype 无人管理销毁**——资源型 prototype = 泄漏隐患，与注入失活合成"prototype 两面坑"
7. **BPP 是基础设施**：五条纪律（无业务依赖/Ordered/快进/无 IO/幂等）；两个 Order 是两个轴（代理皮 vs 拦截链内圈）
8. **生命周期是范式不是八股**：阶段化构造 + 钩子 + 单向推进 + 失败分阶段语义——设计渠道连接管理器直接套用
9. **TCP 通则**：可靠=重传+去重+排序；跨协议边界后业务层必须自带三件套（幂等的底层理由）
10. **窗口匹配 BDP**：rwnd/cwnd 两把锁、四阶段拥塞状态机、BBR 思想——跨地域链路调优的核心账