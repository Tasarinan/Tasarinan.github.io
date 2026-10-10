# 架构师学习-Day02-Netty核心架构与线程模型

> 日期：2026年09月04日（周五）
> 周主题：网络编程与Netty专题 - 模型演进与epoll / 核心架构与线程模型 / 协议设计与编解码 / 高性能原理 / IM网关实战
> 出题日：Day02 - Netty 核心架构与线程模型

---

## 背景

Day01 把地基打完了：BIO/NIO/AIO 三代模型、select/poll/epoll、Buffer/Channel/Selector、Reactor 三形态、原生 NIO 六大痛点。结论是"原生 NIO 是引擎零件，Netty 是整车"。今天拆这辆整车。

架构师面试官在 Netty 架构层的最爱问法不是"Pipeline 有哪些组件"，而是：

> "Netty 服务端从 `bind()` 到收到第一个请求，中间经过了哪些步骤？`register` 为什么要扔进 EventLoop 的任务队列？"
> "一个 handler 里 `ctx.write(msg)` 和 `channel.write(msg)` 有什么区别？写事件从哪个节点开始传播？"
> "线上 10w 连接的网关，突然 1/4 连接批量断开，jstack 看 EventLoop 线程都在 RUNNABLE 但 CPU 不高——你怀疑什么？"

这些问题答不出来，说明只把 Netty 当"更好用的 NIO 库"在用，没有把它当"一个并发框架"在理解。Day02 的主线：**Netty 的每个组件都是 Day01 某个痛点的解药，而组件间的协作规则全部由线程模型决定**。

**今日衔接点**：

- **Day01 的主从 Reactor** → 今天落地为 boss/worker EventLoopGroup 的源码级流程（bind → initAndRegister → accept → 分配 worker）
- **Day01 的"Selector 非线程安全"** → 今天落地为 EventLoop 的 `inEventLoop()` 判断 + 任务队列串行化（把线程安全问题转化为单线程消息驱动）
- **并发周 Day05 线程池** → EventLoop 与 ThreadPoolExecutor 的对照：为什么 EventLoop 是"绑定的单线程执行器"而不是"池"
- **并发周 ThreadLocal** → Netty FastThreadLocal 为什么比 JDK ThreadLocal 快（数组下标 vs 开放寻址）
- **简历项目 IM 在线客服** → "业务到底在哪个线程执行"是网关代码规约的第一条，也是 Day06 串联复盘的事故高发点

---

## 题目一（Netty 核心架构全解题）：Netty 核心架构与线程模型

请详细回答以下问题：

1. **核心组件全景与启动流程**：Bootstrap/ServerBootstrap、Channel、EventLoop/EventLoopGroup、ChannelHandler/ChannelPipeline、ChannelFuture/ChannelPromise 各自的职责与相互关系？Netty 服务端从 `ServerBootstrap.bind(port)` 到接收并处理第一个请求，完整的源码级流程（initAndRegister → init(channel) → group().register → register0 → doBind0 → fireChannelActive → OP_ACCEPT → ServerBootstrapAcceptor → child register）？其中"register 被投递到 EventLoop 任务队列"这个细节体现了什么设计？
2. **ChannelPipeline 事件传播机制**：Pipeline 的双向链表结构（Head/Tail 哨兵）？inbound 事件与 outbound 事件的传播方向？为什么 inbound handler 要按添加顺序处理、outbound handler 要按逆序处理？`ctx.write()` 与 `channel.write()` 的本质区别（传播起点）？`fireChannelRead` 手动传播的意义？@Sharable 的作用与陷阱？
3. **EventLoop 源码级运行机制**：NioEventLoop.run 的三层循环（select → processSelectedKeys → runAllTasks）？select 的 deadline 计算（为什么要看 scheduledTaskQueue 最近一个任务）？ioRatio 的作用？wakeup 机制的触发时机？为什么说"EventLoop 既是单线程执行器又是任务队列"（Executor + scheduled task + 事件循环三合一）？
4. **线程模型与业务线程划分**：handler 默认在哪个线程执行？什么时候需要 `pipeline.addLast(businessGroup, handler)` 挂独立线程池？跨 EventExecutorGroup 切换时 Netty 如何保证有序性？EventLoop 被阻塞的后果链（同 EventLoop 上所有连接停摆 → 心跳超时误杀 → 批量断连）？如何用 jstack 和指标发现"EventLoop 里混进了阻塞操作"？
5. **异常处理与生命周期**：exceptionCaught 的传播方向与默认终点（Tail/Head 的兜底行为）？channelRegistered/Active/Read/ReadComplete/Inactive/Unregistered 的完整生命周期与触发时机？ChannelFutureListener 的使用场景？`shutdownGracefully` 的 quietPeriod 设计为什么比直接 shutdown 更安全？
6. **架构师视角：无锁化设计总结**：Netty 如何把"锁"从框架里挤出去（Channel 终身绑定 EventLoop、MpscQueue、FastThreadLocal、串行化无锁）？FastThreadLocal 与 JDK ThreadLocal 的实现差异与性能来源？把 Netty 线程模型映射回 Reactor 三角色，设计"事件循环内禁止阻塞"的团队代码规约应该包含哪些条款？

### 作答区

#### 1. 核心组件全景与服务端启动流程

**组件职责表**：

| 组件 | 职责 | 关键认知 |
|---|---|---|
| ServerBootstrap | 服务端装配器（链式配置） | 只管"组装"，不参与运行——把组件拼成整体后即可丢弃 |
| Channel | 生命周期容器 + 配置载体 + IO 执行入口 | 不是"连接"本身，是连接在 Java 世界的**全权代表**（连接 + 状态 + Pipeline + config + unsafe） |
| EventLoopGroup | EventLoop 的集合 + 选择器 | 顺序化选择器 `next()` 轮询分配 Channel |
| EventLoop | 单线程执行器 + 事件循环 | **一个 EventLoop = 一个线程 + 一个 Selector + 一个任务队列**，终身伺候一批 Channel |
| ChannelHandler | 业务逻辑单元 | 无状态可复用（@Sharable），有状态每连接一个 |
| ChannelPipeline | handler 的双向链表 + 事件总线 | 编解码、业务、异常处理全部挂在这条链上 |
| ChannelFuture/Promise | 异步结果 | Netty 所有操作都是异步的，Future 是"完成通知"的标准载体 |

**服务端启动完整流程（源码级）**：

```java
ServerBootstrap b = new ServerBootstrap();
b.group(boss, worker)                          // ① 两个 group
 .channel(NioServerSocketChannel.class)        // ② Channel 工厂类型
 .option(ChannelOption.SO_BACKLOG, 1024)       // ③ 服务端 socket 选项
 .childOption(ChannelOption.TCP_NODELAY, true) // ④ 子 channel 选项
 .handler(new LoggingHandler())                // ⑤ boss pipeline 的 handler
 .childHandler(new ChannelInitializer<SocketChannel>() {  // ⑥ 子 pipeline 装配器
     protected void initChannel(SocketChannel ch) {
         ch.pipeline().addLast(new EchoHandler());
     }
 });
b.bind(8080).sync();
```

`bind()` 之后的源码链路（简化）：

```java
// AbstractBootstrap.doBind
final ChannelFuture regFuture = initAndRegister();     // A 阶段：创建+初始化+注册
// ...
doBind0(regFuture, channel, localAddress, promise);    // C 阶段：绑定

// A. initAndRegister
channel = channelFactory.newChannel();   // 1. 反射创建 NioServerSocketChannel
init(channel);                           // 2. 初始化（见下）
config().group().register(channel)       // 3. boss group 注册
    // MultithreadEventLoopGroup.next() → SingleThreadEventLoop.register
    // → eventLoop.execute(() -> unsafe.register(...))  ★ 关键：投递到任务队列

// init(channel) 做了什么：
//   a. set options / attrs
//   b. pipeline.addLast(new ChannelInitializer() {
//          initChannel() 时把用户 childHandler 加入
//          再 addLast(ServerBootstrapAcceptor)        ★ accept 分发器
//      })

// B. register0（在 EventLoop 线程上执行）
javaChannel().register(selector, 0, this)  // 4. 注册到 epoll，interestOps=0（什么都不关心！）
pipeline.fireChannelRegistered()

// C. doBind0（register 完成后回调，同样投递到 EventLoop）
unsafe.bind() → javaChannel().bind(localAddress, backlog)  // 5. 系统 bind，backlog 生效
pipeline.fireChannelActive() → beginRead()
selectionKey.interestOps(OP_ACCEPT)          // 6. 此刻才开始关心 ACCEPT
```

**三个必须讲得出的细节**：

1. **register 为什么要扔进任务队列**：`register` 的调用方是用户线程（main），而 Selector 非线程安全（Day01 痛点四）。Netty 的解法：`if (!eventLoop.inEventLoop()) eventLoop.execute(task)`——所有对 Channel/Selector 的操作，如果在非绑定线程上发起，一律包装成任务投递到该 EventLoop 的队列，**让唯一有权触碰 Selector 的线程自己执行**。这就是"把线程安全问题转化为单线程消息驱动"。
2. **interestOps 从 0 到 OP_ACCEPT 的两段式**：注册时 ops=0（只挂到红黑树，不收事件），bind 成功 fireChannelActive 后才置 OP_ACCEPT。保证"监听端口成功"与"开始收连接"的时序一致——不会出现"端口还没 bind 成功就已经收到连接"的竞态。
3. **ChannelInitializer 的延迟装配**：用户在 `childHandler` 里给的 initializer，在 **channel 注册完成后**（`initChannel` 回调）才把真正的 handler 链装进去——因为装配时 pipeline 已经在 EventLoop 上运行了。

**第一个连接到来之后**：

```java
// NioEventLoop.processSelectedKey → unsafe.read()
int readBufSize = ...; doReadMessages(readBuf)   // accept() 返回 NioSocketChannel
pipeline.fireChannelRead(readBuf.get(i))          // 传播给 pipeline
// → ServerBootstrapAcceptor.channelRead():
//     child.config().setOptions(childOptions)    // 应用 childOption
//     child.pipeline().addLast(childHandler)     // 装配用户子 pipeline
//     childGroup.register(child)                 // ★ 注册到 worker（轮询选一个）
// → 子 channel 走同样的 register0 → fireChannelRegistered → fireChannelActive → OP_READ
```

**ServerBootstrapAcceptor 就是主从 Reactor 的"从主到从"的那根线**：boss 的 pipeline 上只有一个用户 handler（一般不用）+ Acceptor；新连接被 Acceptor 从 boss 摘下来，交给 worker 的 EventLoop 终身伺候。

#### 2. ChannelPipeline 事件传播机制

**双向链表结构**：

```
        事件传播方向
inbound  ──────────────────────────────▶
[Head] ⇄ [Decoder(in)] ⇄ [Business(in)] ⇄ [Encoder(out)] ⇄ [Tail]
        ◀────────────────────────────── outbound
```

- **Head**：链头哨兵，也是 outbound 事件的终点（head 后面就是 unsafe，真正执行 IO）
- **Tail**：链尾哨兵，inbound 事件的终点（兜底：未消费的消息打 warn 日志并 release、未处理的异常打日志）
- 每个 `ChannelHandlerContext` 包装一个 handler + 前后指针 + 该 handler 的 `skip` 标记（`@Skip` 注解 + `isSharable` 在注册时通过反射的方法覆盖检测预计算，跳过不关心该事件的 handler，避免逐个调用）

**两类事件、两个方向**：

| 事件类型 | 触发源 | 方向 | 典型事件 |
|---|---|---|---|
| inbound（入站） | 内核 IO 事件（unsafe 触发） | **Head → Tail** | channelRegistered / channelActive / channelRead / channelReadComplete / channelInactive / exceptionCaught |
| outbound（出站） | 用户主动调用 | **Tail → Head**（或从调用点向 Head） | bind / connect / write / flush / read / close |

**为什么 inbound 正序、outbound 逆序**：这是**数据流的自然方向**。数据进来：先过协议解码（把字节变对象），再进业务处理——所以 Decoder 在前、Business 在后。数据出去：业务产生对象，先经 Encoder（对象变字节）再交给 IO——从 Tail 向 Head 走，Encoder 添加在 Business **之后**反而先被执行：

```java
pipeline.addLast(new Decoder());    // in
pipeline.addLast(new Business());   // in
pipeline.addLast(new Encoder());    // out
// 读：Head → Decoder → Business → (Encoder 不动) → Tail
// 写：Business 里 ctx.write(msg) → 从 Business 位置向 Head 找 outbound → Encoder → Head → IO
```

**`ctx.write()` vs `channel.write()`（高频考点）**：

```java
ctx.write(msg);       // 从【当前 handler 的位置】向 Head 传播——前面的 outbound handler 被跳过
channel.write(msg);   // 从 Tail 开始传播——全部 outbound handler 都会经过
pipeline.write(msg);  // 同 channel.write()
```

陷阱：handler 里写 `channel.write(msg)` 会导致消息从 Tail 重新走一遍整条链（可能再次经过同一个 Encoder）。**规约：handler 内部一律用 `ctx.writeAndFlush()`**，语义是"从我这儿往外走"。

**`fireChannelRead(msg)` 手动传播**：inbound 事件**不会自动流动**，每个 handler 处理完必须显式 `ctx.fireChannelRead(msg)` 才到下一个——这是 Netty 给业务留的控制点（不传播 = 消费掉）。忘写 fireChannelRead 是"消息只被第一个 handler 处理"的根因。

**@Sharable 的作用与陷阱**：

- 作用：标记该 handler **无状态、可被多个 Channel 的 pipeline 共享**（一个实例挂 N 条链），省去每连接 new 一个对象的开销。编解码器、全局统计 handler 通常是 @Sharable
- 陷阱一：有状态的 handler 标 @Sharable = 灾难。例如 handler 里有个成员变量 `byteBuf` 存半包，多个连接共享时数据互相污染——**正确的半包累积由框架（ByteToMessageDecoder 内部 per-channel 的 cumulator）完成，业务 handler 不该存连接状态**
- 陷阱二：@Sharable 实例内部如果要跨连接共享状态，必须自己做并发控制（回到并发周：ConcurrentHashMap / LongAdder）
- 判定标准一句话：**成员变量里有没有"属于某一条连接"的数据，有就不能 Sharable**

#### 3. EventLoop 源码级运行机制

**NioEventLoop.run 的三层循环（简化源码）**：

```java
protected void run() {
    for (;;) {                                    // ① 外层：永动机
        int strategy = selectStrategy.calculateStrategy(selectNowSupplier, hasTasks());
        // 有任务时 selectNow()（非阻塞立刻返回），没任务才 select(deadline)
        switch (strategy) {
            case SelectStrategy.CONTINUE: continue;
            case SelectStrategy.SELECT:
                select(deadline);                 // ② 带截止时间的 select
                // deadline = scheduledTaskQueue 最近一个定时任务的执行时间
                // 因为 select 期间只有任务到来会 wakeup，定时任务不会被 select 阻塞错过
        }
        processSelectedKeys();                    // ③ 处理就绪 IO 事件
        runAllTasks(...);                         // ④ 执行任务队列（含定时任务转普通队列）
    }
}
```

四个必须讲得出的机制：

1. **select 的 deadline 计算**：EventLoop 身上挂着一个 `scheduledTaskQueue`（优先级队列，`schedule()` 提交的定时/延迟任务在这里）。进入 select 前先看它最近的任务还要多久执行，`select(timeout)` 最多睡这么久——**保证定时任务不被 IO 等待饿死**。这就是 Netty 不需要"额外定时线程"就能实现 `eventLoop.schedule()` 的原因。
2. **wakeup 机制**：其他线程 `eventLoop.execute(task)` 投递任务时，如果 EventLoop 正阻塞在 select，需要 `selector.wakeup()` 把它捅醒（Netty 用原子布尔 + "唤醒票"机制避免重复 wakeup 的系统调用开销——wakeup 是有成本的）。selectNow vs select 的选择：**有任务绝不阻塞**（任务延迟也是 SLA）。
3. **processSelectedKeys 的优化**：Netty 用反射把 JDK Selector 的 `selectedKeys` 集合替换成自己实现的**数组结构**（`SelectedSelectionKeySet`，add 永远追加不扩容），避免 HashSet 的迭代与装箱开销；同时以"就绪 key 的 attachment 就是 NioChannel 的 unsafe"的方式，把事件处理收敛到 `unsafe.read()` 一个入口。
4. **ioRatio**：默认 50，含义是"执行任务的时间 ≈ IO 时间 × (100-ioRatio)/ioRatio"。ioRatio=100 时任务执行不受限（容易导致 IO 饥饿），调小则任务单轮限量。**背压的另一面：任务队列积压时，EventLoop 用时间片控制两类工作的公平性**。

**EventLoop = 三合一**：

| 身份 | 提供能力 | 对应 API |
|---|---|---|
| 单线程执行器（Executor） | 串行执行任意任务 | `execute(Runnable)` |
| 定时调度器（ScheduledExecutorService） | 延迟/周期任务 | `schedule(Runnable, delay)` |
| 事件循环（Reactor） | epoll 等待 + IO 事件分发 | run() 内层逻辑 |

与 ThreadPoolExecutor 的本质差异（衔接并发周 Day05）：

| | ThreadPoolExecutor | EventLoop |
|---|---|---|
| 线程与任务关系 | N 个等价线程抢一个队列（任务与线程无固定关系） | **Channel 终身绑定一个线程**（任务按 Channel 归属投递） |
| 锁竞争 | 队列锁（任务入队出队） | Mpsc 无锁队列 + 每线程独立队列 |
| 语义 | "并行处理一批无状态任务" | "串行处理一个连接的所有事件"（保序、无锁） |

#### 4. 线程模型与业务线程划分

**handler 默认在哪个线程执行**：**Channel 绑定的 EventLoop 线程**。Pipeline 的每次回调（channelRead / write / exceptionCaught）都发生在该 Channel 的 EventLoop 上——这就是 Day01 讲过的"串行化无锁"的落地。

**什么时候需要独立业务线程池**：

```java
EventExecutorGroup businessGroup = new DefaultEventExecutorGroup(32);
pipeline.addLast(businessGroup, "bizHandler", new BizHandler());  // 指定执行器
```

判定标准——handler 逻辑中是否有以下任何一项：
- **同步 RPC / HTTP 调用**（等下游超时即阻塞 EventLoop）
- **DB / Redis 阻塞客户端**访问
- **重 CPU 计算**（大报文加解密、大批量数据转换、复杂规则引擎）
- **锁等待 / Thread.sleep / CountDownLatch.await**

纯内存的编解码、路由、转发（网关的主业）留在 EventLoop——**切换线程组是有代价的**（上下文切换 + Netty 为保序引入的排队开销）。

**跨 EventExecutorGroup 的有序性保证**：同一个 handler 的所有事件都路由到 businessGroup 里**同一个**线程（按 Channel 哈希绑定），所以连接内仍然串行有序；跨线程的数据传递由 Netty 保证 happens-before。**代价**：业务线程池阻塞时，该 Channel 后续事件在业务队列排队，且 IO 线程与业务线程之间多一次投递。

**EventLoop 被阻塞的后果链（事故级）**：

```
handler 里一次同步 RPC（超时 500ms，下游抖动到 3s）
 → 该 EventLoop 线程阻塞 3s
 → 同一 EventLoop 上的所有连接（单机 worker 32 个，10w 连接 ≈ 每 EventLoop 3000+）全部停摆
 → 这 3000 连接的心跳包无人处理
 → IdleStateHandler（服务端读空闲 90s）… 若阻塞反复出现累计超时 → 误判客户端假死
 → 批量关闭连接 → 客户端重连风暴 → 雪崩放大
```

**怎么发现"EventLoop 里混进了阻塞操作"**：
1. **jstack**：EventLoop 线程栈出现 `SocketRead0 / lockSupport.park / await` 等——正常时它只该在 `epollWait` 或纯 Java 计算栈
2. **指标**：EventLoop 任务队列深度、单轮 runAllTasks 耗时（Netty 可通过自建 monitor 定时 `execute(()->recordCost())` 采样任务排队延迟，排队 > 100ms 即告警）
3. **日志特征**："处理一条消息耗时 Xms" 的花名册打点（EventLoop 内打点成本极低，值得开）

#### 5. 异常处理与生命周期

**exceptionCaught 传播**：inbound 异常从发生点**向 Tail** 逐个传播（outbound 异常则向 Head 传播并通过 Promise 通知）。**没有任何 handler 处理时的兜底**：Tail 打 `WARN ... An exceptionCaught() event was fired...` 日志。**陷阱**：兜底只是打日志，连接不会关——所以规约：**pipeline 末位必须有"异常终结者"handler**（打日志 + metrics + 按异常类型决定 close）。

```java
@Override
public void exceptionCaught(ChannelHandlerContext ctx, Throwable cause) {
    metric.counter("gateway.exception", tag(type(cause)));
    if (cause instanceof TooLongFrameException || cause instanceof CorruptedFrameException) {
        ctx.close();            // 协议层异常：对端可能是攻击/不兼容版本，直接断
    } else if (cause instanceof IOException) {
        ctx.close();            // 网络异常：断链由重连机制兜底
    } else {
        ctx.writeAndFlush(errorResponse);  // 业务异常：回错误帧，连接保留
    }
}
```

**Channel 生命周期**（inbound 事件按序）：

```
channelRegistered（注册到 EventLoop）
  → channelActive（连接建立/绑定完成，OP_READ 开启）
    → channelRead / channelReadComplete（循环）
    → channelInactive（连接断开）
  → channelUnregistered（从 EventLoop 摘除）
```

注意两点：① `channelInactive` 是清理连接级资源（Session 摘除、缓存释放）的**唯一可靠钩子**——但它不保证一定被调用（进程被 kill -9），所以还要有 `ChannelFutureListener.CLOSE` 与启动时僵尸 Session 清扫兜底；② `channelReadComplete` 默认会自动尝试读下一次（autoRead=true 时）。

**ChannelFutureListener**：Netty 一切异步操作返回 Future，**`addListener` 是唯一推荐的回调姿势**（`sync()` 只用于启动/测试）：

```java
ctx.writeAndFlush(resp).addListener(ChannelFutureListener.FIRE_EXCEPTION_ON_FAILURE);
// 或关闭链：写完即关
ctx.writeAndFlush(lastMsg).addListener(ChannelFutureListener.CLOSE);
```

**shutdownGracefully 的 quietPeriod**：

```java
group.shutdownGracefully(2, 15, TimeUnit.SECONDS).sync();
// quietPeriod=2s：每 2s 检查一次"这期间有没有新任务提交"
//   有 → 重置计时（说明还有活没干完，再等等）
//   没有 → 认为安全，关闭
// timeout=15s：最长等 15s，无论如何都关（防任务自续命）
```

对比直接 shutdown：quietPeriod 解决"关闭瞬间恰好有任务在路上"的竞态——**优雅关闭的本质是"先停输入、等存量、再关"**，这个思想与 Day05 要讲的网关连接迁移（摘流量 → drain → 关）完全同构。

#### 6. 架构师视角：无锁化设计总结

**Netty 把锁挤出去的四个手段**：

| 手段 | 机制 | 替代了什么 |
|---|---|---|
| Channel 终身绑定 EventLoop | 连接内串行 | 对连接状态的锁 |
| MpscQueue | 多生产者单消费者无锁队列（CAS 尾追加 + 单线程消费） | 任务队列的 ReentrantLock（LinkedBlockingQueue） |
| FastThreadLocal | 数组下标直取 | ThreadLocalMap 开放寻址（hash 冲突探测） |
| 串行化无锁（inEventLoop 判断） | 非 EventLoop 线程的操作一律投递成任务 | 跨线程调用 Selector/Channel 的锁 |

**FastThreadLocal vs JDK ThreadLocal（衔接并发周）**：

| | JDK ThreadLocal | FastThreadLocal |
|---|---|---|
| 存储结构 | ThreadLocalMap（开放寻址，冲突线性探测） | InternalThreadLocalMap（**数组，下标 = 全局注册的 index**） |
| 访问成本 | 哈希 + 可能探测 | `array[index]` 一次取 |
| Map 归属 | 每个 Thread 自带 | FastThreadLocalThread 直接持有字段（省一次 JDK ThreadLocal 查找）；普通线程退化为慢路径 |
| 清理 | remove 手动 / 线程死亡 | 同样要 remove，且 `removeAll()`/ObjectCleaner 兜底 |

前提：线程必须复用（Netty 线程全是长命单线程）。**启示：无锁化的本质不是"用更好的锁"，是"让数据只被一个线程看见"——并发周"减少共享"思想在框架级的应用**。

**Netty 线程模型 ↔ Reactor 映射**：

```
Acceptor  = boss EventLoopGroup（默认 1 个线程）+ ServerBootstrapAcceptor
Reactor   = 每个 EventLoop（独立的 epoll + 循环）
Handler   = Pipeline 上的 handler 链（IO 层）+ 可选 businessGroup（业务层）
```

**"事件循环内禁止阻塞"团队规约（六条）**：

1. EventLoop 内**禁止**：同步 RPC / DB / Redis 阻塞客户端 / sleep / await / 重 IO 文件读写 / 大对象序列化（>1ms 量级 CPU 也应移出）
2. 需要阻塞 → `addLast(businessGroup, handler)` 或 `eventLoop.execute` 投递后异步回写
3. handler 内写回一律 `ctx.writeAndFlush`，禁止 `channel.write`
4. pipeline 末位必须有异常终结者 handler；异常分类处置（协议错误关、业务错误回、网络错误关）
5. 每连接状态不放 handler 成员变量（除非非 @Sharable 且每连接新实例）；跨连接共享状态用并发容器
6. EventLoop 打点：任务排队延迟 / 单事件处理耗时进 metrics，超阈值告警

---

## 本日能力差距与补足方向

### 差距1：启动流程停留在"会写 Bootstrap"

- **现状**：会写 ServerBootstrap 链式配置，但 `initAndRegister → register0 → doBind0 → fireChannelActive → OP_ACCEPT` 的源码链讲不全，说不出"register 为什么要投递到任务队列""interestOps 为什么先 0 后 ACCEPT"两个细节
- **架构师水平**：白板画出 bind 到第一个请求的时序图，并指出每一步在哪个线程上执行（main 还是 EventLoop）
- **补足方向**：对着 Netty 源码把 AbstractBootstrap.doBind 单步走一遍，重点标注线程切换点

### 差距2：Pipeline 传播方向答成"都是从头到尾"

- **现状**：inbound/outbound 的方向和"outbound 逆序"经常混淆；`ctx.write` 与 `channel.write` 的区别说不出"传播起点"这个本质
- **架构师水平**：给定一条 pipeline（Decoder/Business/Encoder 顺序），秒答读写路径各经过哪些 handler；能解释 Head/Tail 哨兵的兜底行为
- **补足方向**：把第 2 问的双向链路图手画一遍；写一个 5 handler 的 demo 打印进出顺序验证

### 差距3：EventLoop 只知道"单线程"，讲不出三合一与调度细节

- **现状**：说不出 select deadline 与 scheduledTaskQueue 的联动、wakeup 的成本、ioRatio 的作用；"EventLoop 既是执行器又是定时器"这个归纳没有
- **架构师水平**：从 run() 三层循环出发，讲清 IO 与任务的时间片分配逻辑，以及任务队列延迟的监控手段
- **补足方向**：读 NioEventLoop.run 与 SingleThreadEventExecutor.execute 源码；给网关补"EventLoop 排队延迟"指标

### 差距4：业务线程划分靠"感觉"

- **现状**：什么 handler 挂 businessGroup 说不出判定标准（阻塞/CPU 重才移出）；不知道跨线程组的有序性保证机制与代价
- **架构师水平**：按"阻塞操作清单"逐条判定；能权衡"切线程的开销 vs EventLoop 阻塞的后果"
- **补足方向**：把第 4 问的判定清单变成代码评审 checklist；复盘简历项目里 IM 网关的 handler 哪些该移出 EventLoop

### 差距5：EventLoop 阻塞的事故链没有量化敏感度

- **现状**：知道"不能阻塞 EventLoop"，但算不出"worker 32 线程挂 10w 连接，阻塞 3s 影响多少连接"（约 3000+ 连接停摆 × 心跳超时 × 批量误杀的放大链）
- **架构师水平**：把后果链推演成容量数字：每 EventLoop 连接数 = 总连接 / worker 数，阻塞时长 vs 心跳超时阈值的比值决定是否误杀
- **补足方向**：给 IM 网关做一个"EventLoop 阻塞 → 影响连接数"的沙盘推演，写进项目预案

### 差距6：无锁化四手段与 FastThreadLocal 原理空白

- **现状**：FastThreadLocal 只知道"更快"，说不出数组下标 vs 开放寻址的实现差异；"串行化无锁"作为 Netty 的核心设计哲学没有体系化认知
- **架构师水平**：从"让数据只被一个线程看见"的第一性原理出发，把四个无锁手段串成一句话讲给面试官
- **补足方向**：读 FastThreadLocal 与 InternalThreadLocalMap 源码；对照并发周 ThreadLocal 内存泄漏案例看 Netty 的 removeAll 兜底

---

## 附录：本日关键认知速查

| 认知点 | 关键结论 |
|---|---|
| 组件关系 | Bootstrap 装配 / Channel 全权代表连接 / EventLoop=线程+Selector+任务队列 / Pipeline=handler 双向链 |
| 启动链路 | initAndRegister → init(pipeline+Acceptor) → register（投递任务）→ register0（ops=0）→ doBind0 → fireChannelActive → OP_ACCEPT |
| register 细节 | 非 EventLoop 线程发起的操作一律 execute() 投递；Selector 线程安全问题的解法是"单线程消息驱动" |
| accept 分发 | ServerBootstrapAcceptor：childOptions + childHandler + childGroup.register(child) |
| 传播方向 | inbound：Head→Tail 正序；outbound：Tail→Head 逆序（数据流自然方向） |
| ctx.write vs channel.write | 从当前 handler 位置向 Head / 从 Tail 走全程；handler 内规约用 ctx |
| inbound 事件 | 不自动流动，必须显式 fireChannelRead；忘 fire = 消息被吞 |
| @Sharable | 无状态才可共享；有连接级状态的 handler 共享 = 数据污染 |
| EventLoop 三合一 | Executor + ScheduledExecutorService + 事件循环；定时任务靠 select deadline 联动 |
| ioRatio | 默认 50；IO 与任务执行的时间片配比 |
| handler 默认线程 | Channel 绑定的 EventLoop；阻塞/CPU 重 → addLast(businessGroup, handler) |
| EventLoop 阻塞后果 | 一个 EventLoop 停摆 = 总连接/worker 数的连接停摆 → 心跳误杀 → 重连风暴 |
| 异常兜底 | 未处理异常只打 WARN 不关连接；末位必须有异常终结者 handler |
| 优雅关闭 | shutdownGracefully(quietPeriod=2s, timeout=15s)：先停输入、等存量、再关 |
| 无锁四手段 | Channel 绑定 / MpscQueue / FastThreadLocal / inEventLoop 投递 |
| FastThreadLocal | 数组下标直取 vs JDK 开放寻址；FastThreadLocalThread 直接持有 map |
