# 架构师学习-Day02-Netty核心架构与线程模型-梳理

> 日期：2026年09月04日（周五）
> 周主题：网络编程与Netty专题 - 模型演进与epoll / 核心架构与线程模型 / 协议设计与编解码 / 高性能原理 / IM网关实战
> 梳理日：Day02 - 架构师视角梳理

---

## 一、架构师视角下的 Netty 组件体系

### 1.1 组件不是"功能"，是"角色分工"

把 Netty 组件当 API 背是初学者学法。架构师视角：Netty 用组件切出了四个**正交的关注点**：

| 关注点 | 组件 | 一句话职责 |
|---|---|---|
| 我是谁 | Channel | 连接的全权代表（连接+状态+config+pipeline+unsafe） |
| 谁伺候我 | EventLoop / Group | 绑定的单线程执行器 + 选择器（终身的） |
| 我怎么被处理 | Pipeline / Handler | 事件总线 + 业务逻辑单元 |
| 结果何时可知 | Future / Promise | 异步操作的完成通知 |

**组件图（装配视角）**：

```
ServerBootstrap（装配器，用完即弃）
   ├── boss EventLoopGroup ── EventLoop ×1 ── Selector ── [ServerSocketChannel]
   │                                            pipeline: [Head → Acceptor → Tail]
   └── worker EventLoopGroup ── EventLoop ×N ── Selector ── [SocketChannel × 每Loop一批]
                                                 pipeline: [Head → Decoder → Biz → Encoder → Exception → Tail]
```

### 1.2 启动流程的架构解读：一切异步操作的两段式

`bind → initAndRegister → register → doBind0` 的链路里最重要的模式是 **"操作发起线程 ≠ 执行线程"**：

```java
if (eventLoop.inEventLoop()) {
    doSomething();                    // 已在绑定线程：直接执行
} else {
    eventLoop.execute(() -> doSomething());  // 否则：投递成任务，让owner线程执行
}
```

这个模式贯穿 Netty 所有跨线程操作（register/bind/write/attr 设置）。**架构师认知**：这是"线程封闭（thread confinement）"的标准实现——**不是给资源加锁，而是给资源指定唯一 owner，其他线程只发消息**。对比并发周的结论：锁是低效的共享，消息是高效的串行。整个 Netty 的无锁性都建立在这个模式上。

### 1.3 interestOps=0 → OP_ACCEPT 的两段式：时序正确性设计

注册（挂上 epoll 红黑树）与开启事件（ops 置位）分离，保证"端口绑定成功"与"开始接收连接"的时序一致。这类"先挂载、再启用"的两段式在架构上反复出现：K8s 的 readiness probe（先启动、就绪才接流量）、注册中心的上下线（先注册、再推订阅）、网关的连接迁移（先 drain、再关闭）。**识别这个模式 = 理解"状态迁移的原子性边界"**。

---

## 二、Pipeline：一条链上的两种流动

### 2.1 双向链表 + 方向语义 = 数据流的自然映射

inbound（内核 → 业务）正序、outbound（业务 → 内核）逆序，这不是设计癖好，是**数据流方向决定的处理顺序**：

```
读路径（inbound）：  字节流 → 解码 → 业务          （Head → Tail）
写路径（outbound）： 业务对象 → 编码 → 字节流      （调用点 → Head）
```

推论（高频陷阱）：
- **Encoder 加在 Decoder 之后也能被走到**——因为 write 从调用点向 Head 走
- **handler 内 `ctx.write()` 只走自己前面的 outbound handler**；`channel.write()` 从 Tail 走全程（可能二次经过自己的 Encoder）
- **inbound 事件不自动流动**：fireChannelRead 是显式的——Netty 把"是否继续传播"的控制权给了业务（消费 vs 透传）

### 2.2 @Sharable：状态归属决定共享性

判定标准一句话：**成员变量里有没有"属于某一条连接"的数据**。

| handler | 可否 @Sharable | 原因 |
|---|---|---|
| 协议编解码器（状态在 per-channel 的 cumulator 里，由框架管） | ✓ | handler 自身无连接状态 |
| 全局统计（在线数、QPS） | ✓（内部用并发容器） | 状态是全局的，且并发安全 |
| 存"半包缓冲""会话进度"的 handler | ✗ | 连接级状态，共享=污染 |

**架构师认知**：@Sharable 的判定练习，本质是"状态归属分析"——这条状态属于连接、属于全局、还是属于一次请求？归属错了，并发 bug 就来了（对照并发周 ThreadLocal 串号案例：把"请求级"状态放进了"线程级"容器）。

### 2.3 异常传播与"终结者"规约

未处理的异常默认只打 WARN 不关连接——框架把决定权留给业务，但业务经常忘了接。**规约化解法：pipeline 末位固定挂异常终结者**，按异常类型三分类处置（协议错→关、网络错→关、业务错→回错误帧）。这与 K8s 周的"controller 不吞 reconcile 错误、由上层退避重试"是同一思想：**错误必须有一个明确的最终责任人**。

---

## 三、EventLoop：把 Reactor 和线程池熔成一个原语

### 3.1 三合一的架构价值

```
EventLoop = 1 个线程 + 1 个 Selector + 1 个 MpscQueue + 1 个定时队列
            （事件循环）（IO 多路复用）（任务）    （延迟任务）
```

传统写法里"IO 线程 / 任务线程 / 定时线程"三套东西被熔成一个原语，且 Channel 与它是**终身绑定**。收益：

| 维度 | 传统线程池 | EventLoop |
|---|---|---|
| 连接内保序 | 要自己加锁/串行队列 | 天然串行（单线程） |
| 线程安全 | 每处访问都要考虑 | inEventLoop 一判即知 |
| 定时任务 | 独立 ScheduledExecutor | schedule 直接挂（select deadline 联动保证不饿死） |
| 心跳/重连退避 | 全局定时器 | IdleStateHandler + schedule 天然在同一线程，无竞态 |

### 3.2 EventLoop 阻塞：网关最经典的"一损俱损"

```
单连接的影响半径 = 该 EventLoop 上挂着的全部连接 ≈ 总连接数 / worker 数
```

10w 连接 / 32 worker ≈ 每个 EventLoop 3000+ 连接。一次 3 秒的同步 RPC：
- 直接影响：3000+ 连接 3 秒无响应
- 放大链：心跳包无人读 → 读空闲累计 → IdleStateHandler 误杀 → 批量断连 → 客户端重连风暴 → 其他节点也被打挂

**架构师认知**：EventLoop 是"共享资源"，但它共享的不是 CPU，是**整个事件处理能力**。任何阻塞都伤害半径内所有连接。这就是"EventLoop 内禁止阻塞"规约的数学来源。配套的监控是 EventLoop 排队延迟指标（`execute(()->采样())` 定时打点）——**能监控才能执法**。

### 3.3 业务线程组：分界线画在哪

```
留在 EventLoop：编解码、路由、转发、内存 Session 操作（网关主业）
移出 EventLoop：同步 RPC、DB、阻塞 Redis、重计算（加解密/批量转换）、锁等待
```

判定的经济学：切线程的代价（一次投递 + 上下文切换 + 保序排队）几乎恒定且小；EventLoop 阻塞的代价随影响半径线性放大。**当操作耗时的量级超过 0.1~1ms 或含阻塞，就值得切**。这不是教条，是代价函数的比大小。

---

## 四、无锁化：Netty 的第一性原理

### 4.1 四个手段，一个思想

| 手段 | 挤掉了什么锁 | 本质 |
|---|---|---|
| Channel 终身绑定 EventLoop | 连接状态的锁 | 线程封闭 |
| MpscQueue | 任务队列的互斥锁 | 单消费者消解竞争 |
| FastThreadLocal | ThreadLocalMap 探测 | 空间换时间（数组下标） |
| inEventLoop 投递 | Selector/Channel 的跨线程访问锁 | 消息驱动替代共享调用 |

**一句话总结**：Netty 的无锁不是"用了更高级的锁"，而是**重新划分了数据的可见域，让绝大多数数据只被一个线程看见**——并发周"减少锁竞争的最佳方式是不共享"的框架级践行。

### 4.2 FastThreadLocal：为什么能快

JDK ThreadLocal：每线程一个 ThreadLocalMap（开放寻址，hash 冲突线性探测）→ 读一次要 hash+探测。
FastThreadLocal：每个 FastThreadLocal 实例注册时拿到**全局唯一数组下标**，读取 = `array[index]` 一次取。FastThreadLocalThread 直接持有数组字段（不经 JDK ThreadLocal 中转）。

**适用前提**：FastThreadLocal 实例数量可控（下标数组有限）、线程是长命单线程。普通业务线程滥用 FastThreadLocal 反而退化（慢路径还多一层）。**启示：优化只在特定结构下成立——把前提讲清楚比把优化讲漂亮更架构师**。

### 4.3 优雅关闭与连接迁移的同构性

`shutdownGracefully(quietPeriod, timeout)`：先停输入（不再接新任务）→ 等存量（quietPeriod 内无新任务才算静默）→ 关闭（timeout 兜底）。

Day05 要讲的网关滚动发布连接迁移（摘注册 → 不接新连接 → drain 老连接 → 通知重连 → 关闭）与它**完全同构**。这是"优雅下线"的一般范式：**先摘流量、再等存量、超时兜底**——把这句话迁移到任何组件（JVM shutdown hook、MQ consumer、K8s preStop + terminationGracePeriod）都是对的。

---

## 五、本日核心认知

1. **Netty 组件四关注点**：我是谁（Channel）/ 谁伺候我（EventLoop）/ 怎么处理（Pipeline）/ 结果何时可知（Future）
2. **一切跨线程操作的两段式**：inEventLoop 直行，否则投递成任务——线程封闭 + 消息驱动，Netty 无锁性的根基
3. **启动链路四步**：initAndRegister（含 Acceptor 装配）→ register（ops=0）→ doBind0 → fireChannelActive 才置 OP_ACCEPT；"先挂载、再启用"是时序正确性的通用模式
4. **Pipeline 方向 = 数据流方向**：inbound 正序（解码→业务）、outbound 逆序（业务→编码）；ctx.write 从当前位置走，channel.write 从 Tail 走全程
5. **inbound 不自动传播**，fireChannelRead 是显式控制点；@Sharable 的判定 = 状态归属分析
6. **EventLoop 三合一**：执行器 + 定时器 + 事件循环；定时任务靠 select deadline 联动保证不被 IO 等待饿死
7. **EventLoop 阻塞的影响半径 = 总连接/worker 数**；后果链是"停摆 → 心跳误杀 → 重连风暴"的雪崩放大
8. **业务线程分界**：编解码路由留 EventLoop，阻塞与重 CPU 移出；判定是代价函数比大小，不是教条
9. **异常必须有终结者**：未处理异常默认只打日志不关连接；末位 handler 按类型三分类处置
10. **无锁四手段一个思想**：让数据只被一个线程看见；FastThreadLocal 快在数组下标，前提是长命单线程
11. **优雅下线三段式**：先停输入、等存量、超时兜底——从 shutdownGracefully 到网关连接迁移同构
