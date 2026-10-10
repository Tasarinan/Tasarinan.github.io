# 架构师学习-Day05-线程池与虚拟线程-梳理

> 日期：2026年08月14日（周五）
> 周主题：并发编程专题 - JMM / synchronized 锁升级 / AQS / 并发容器 / 线程池 / 虚拟线程
> 梳理日：Day05 - 架构师视角梳理

---

## 一、架构师视角下的线程池：资源治理问题

### 1.1 不只是"池子"，是"资源治理系统"

很多工程师把线程池当成"new 一个池子然后 submit"的工具。架构师视角下，线程池是一个**资源治理系统**--它管理的从来不只是线程，而是三级资源：

```
┌────────────────────────────────────────────────────┐
│  线程池治理的三级资源                                │
│                                                    │
│  第一级：本机线程（CPU / 栈内存 / 调度开销）          │
│          core / max / keepAlive 是这一级的阀门       │
│                                                    │
│  第二级：队列（堆内存 / 排队延迟）                    │
│          workQueue 容量是这一级的阀门                │
│                                                    │
│  第三级：下游容量（DB 连接 / RPC 依赖 / 医保中心配额） │
│          max 线程数 × 下游 RT = 对下游的压强         │
│          这一级池子本身管不了，但参数配置必须考虑      │
└────────────────────────────────────────────────────┘
```

**关键认知**：线程池事故的根因大多不在第一级（线程不够），而在第二级（无界队列堆积）和第三级（下游被打穿后任务变慢占满线程）。**只盯着线程数调参的，是程序员视角；三级资源一起看参数的，才是架构师视角**。

### 1.2 线程池的"背压"哲学

线程池本质是一个**有界资源 + 显式溢出策略**的背压（backpressure）系统：

| 背压组件 | 对应线程池构件 | 作用 |
|---------|--------------|------|
| 容量边界 | core / max / queue | 定义"最多放多少" |
| 缓冲区 | workQueue | 吸收速率抖动（削峰） |
| 溢出阀门 | 拒绝策略 | 满了之后的显式决策点 |
| 反馈通道 | CallerRuns / 监控告警 | 把压力传回上游 |

**关键认知**：**无界队列不是"没有背压"，而是"把背压推迟到 OOM 那一刻"**--压力没有消失，只是从"可控的拒绝决策"变成了"不可控的进程死亡"。这就是阿里规约禁止 Executors 的哲学本质：**满载时的行为必须显式设计，不能由工具类用"无限"兜底**。

### 1.3 线程池与其他治理手段的对比

| 治理手段 | 管什么 | 与线程池的关系 |
|---------|-------|--------------|
| 线程池隔离（自建池） | 本机并发与故障传播 | 舱壁模式的进程内实现 |
| Sentinel 线程池隔离规则 | 线程池的并发占用 | 在自建池之上的规则化管控（呼应 2026年06月第4周限流降级） |
| 信号量（Semaphore） | 并发许可数 | 无队列、纯计数；虚拟线程时代承担"限流"职责 |
| 连接池（DB/Redis） | 下游连接资源 | 第三级资源的直接阀门，与线程池参数必须联动 |
| MQ 削峰 | 跨服务的请求缓冲 | 把"进程内队列"升级为"分布式队列"，容量与补偿能力质变 |

**架构师经验**：**线程数 ≈ 下游连接数 × 下游 RT / 本任务 RT** 这类联动关系要在容量规划时显式推演。监管上报案例里，上报池 max=64 而下游监管平台给了 50 并发配额--多出的 14 个线程高峰时就是在队列里干等配额，这 14 个线程就是浪费的栈内存。

### 1.4 线程池是本周知识的"集大成闭环"

```
Day01 JMM        -> Worker 的 state、ctl 的 volatile 读、可见性保证
Day02 synchronized / park -> getTask 用 LockSupport.park 挂起空闲线程
Day03 AQS        -> Worker 继承 AQS 不可重入独占锁（今日核心串联点）
Day04 BlockingQueue -> workQueue 选型直接决定线程池行为
Day05 线程池     -> 全部串起来；虚拟线程再反过来挑战"池化"前提
```

**关键认知**：讲线程池能顺手带出 JMM / synchronized / AQS / BlockingQueue，是面试"并发能力链"的最佳展示位--这也是 Day06 串联整合的主线。

### 1.5 线程池治理"六问"自检清单

架构师评审任何一个线程池（无论自己写的还是接手的），按六个问题过一遍：

| # | 问题 | 检查点 | 不合格的典型表现 |
|---|------|-------|----------------|
| 1 | 队列有界吗 | workQueue 容量是否显式且有依据 | `new LinkedBlockingQueue<>()`（无界）/ Executors 工厂方法 |
| 2 | 满了去哪 | 拒绝策略是否业务化（落库/降级/告警） | 默认 Abort 且上游不 catch；静默 Discard 无日志 |
| 3 | 线程叫什么 | ThreadFactory 是否命名 | Thread-0/Thread-1，jstack 无法定位 |
| 4 | 参数怎么来的 | 能否说出 QPS × RT 推导过程 | "参考别的服务配的"/"拍脑袋" |
| 5 | 出事谁知道 | 五指标监控 + 告警分级 | 无监控，出事靠用户反馈发现 |
| 6 | 关闭怎么办 | 三件套 + 任务善后（补偿/落库） | 无 shutdown hook，发布随机丢任务 |

**架构师经验**：这份清单在代码评审里可以机械执行--六问里答不上两问的池子，就是潜在的案例 1 / 案例 2。**治理能力不是"出事能救"，而是"让事出不了"**。

---

## 二、ThreadPoolExecutor 源码设计哲学

### 2.1 ctl 打包：一次 CAS 管两件事（Day03 state 打包的呼应）

```java
private final AtomicInteger ctl = new AtomicInteger(ctlOf(RUNNING, 0));
// 高 3 位：runState（RUNNING/SHUTDOWN/STOP/TIDYING/TERMINATED）
// 低 29 位：workerCount（最大 536870911）
private static int runStateOf(int c)     { return c & ~CAPACITY; }
private static int workerCountOf(int c)  { return c & CAPACITY;  }
private static int ctlOf(int rs, int wc) { return rs | wc;       }
```

与 Day03 的对照：

| 组件 | 打包方式 | 打包的收益 |
|------|---------|-----------|
| ReentrantReadWriteLock | state 高 16 位读 / 低 16 位写 | 读写计数一次 CAS 原子变更 |
| ThreadPoolExecutor ctl | 高 3 位状态 / 低 29 位线程数 | 状态 + 线程数一次 volatile 读写全知，转换路径原子 |
| StampedLock（Day03） | 64 位：高 56 版本 / 低 8 锁状态 | 版本校验与锁状态合并 |

**关键认知**：JDK 并发源码反复使用"位打包压缩 volatile 变量"的手法，核心动机是**减少 CAS 竞争面、消除多变量间的竞态窗口**。这是架构师读源码时应该提炼的"可迁移设计模式"。

### 2.2 Worker 与 AQS 串联：不可重入独占锁（本周最重要串联点）

Worker 继承 AQS 的四层理解（Day03 模板方法模式的直接应用）：

```
第一层：复用
  Worker 只重写 tryAcquire / tryRelease / isHeldExclusively 三个钩子，
  "队列 + park + 取消"全部复用 AQS 框架（与 ReentrantLock 的 Sync 同构）

第二层：锁语义重定义
  Worker 锁不保护任何共享数据，state 的语义被重定义为"忙/闲"：
    state=0  空闲（阻塞在 getTask 的 take/poll 上，未持锁）
    state=1  忙碌（runWorker 执行任务中，已持锁）

第三层：故意不可重入
  interruptIdleWorkers 用 w.tryLock() 判空闲：成功才 interrupt。
  不可重入保证：任务代码里调用 pool.shutdown() / setCorePoolSize()
  -> interruptIdleWorkers -> 当前 Worker 的 tryLock 必然失败
  -> 正在执行的任务永远不会被"自己引发的中断"打断（shutdown 保持优雅语义）

第四层：state=-1 的启动保护
  构造时 setState(-1)：interruptIfStarted 里 getState() >= 0 为 false，
  Worker 线程真正开始跑之前，任何中断请求都是空操作；
  runWorker 第一行 w.unlock() 把 state 恢复为 0，此后才可中断。
```

**架构师经验**：Worker 是"锁语义由子类定义"的最佳教材--AQS 框架本身不限制可重入性，**可重入是 ReentrantLock 的实现语义，不是 AQS 的属性**。面试里用 Worker 反证 Day03 的这一结论，是高分信号。

### 2.3 "队列在前最大线程在后"的设计权衡

JDK 默认顺序：core -> 队列 -> max -> 拒绝。直觉顺序应该是 core -> max -> 队列 -> 拒绝。差异的根源是**对"线程"这一资源的定价**：

| | JDK（队列在前） | Tomcat（TaskQueue hack 后近似"线程在前"） |
|---|---|---|
| 资源定价 | 线程昂贵（1MB 栈 + 调度），内存换线程要保守 | Web 请求延迟敏感，排队成本高于线程成本 |
| 行为 | 先榨干既有线程 + 用队列削峰，扩容是兜底 | 有空闲则入队，否则优先建线程 |
| 实现 | workQueue.offer 默认语义 | 重写 offer：线程未达 max 时返回 false，"骗"execute 走 addWorker |

**关键认知**：**线程池的执行顺序是由队列的 offer 行为决定的，而不是 execute 写死的**--execute 只调用 `workQueue.offer`，自定义队列可以改变整个池的行为。这是"组合优于硬编码"的设计范例，也是架构师做"定制化线程池"的正确切入点。

**踩坑必背**：`core == max + 大容量队列` 的配置下，maximumPoolSize 永远不生效（offer 总是成功，走不到非核心 addWorker 分支）。这是线上最常见的"隐性配置错误"。

### 2.4 getTask 的"弹性收缩"设计

```java
boolean timed = allowCoreThreadTimeOut || wc > corePoolSize;
Runnable r = timed ? workQueue.poll(keepAliveTime, NANOSECONDS)   // 超时回收
                   : workQueue.take();                            // 常驻等待
```

三个精妙点：

1. **"核心/非核心"不是两类线程**，而是同一个 Worker 在不同 workerCount 下的行为--每次取任务前重算 timed，回落到 core 以内后剩的都是"事实核心"
2. **空闲核心线程的成本几乎为零**：take() 阻塞在 LockSupport.park 上（Day02/Day03 的 park 机制），不占 CPU，只占栈内存
3. **动态调参的生效通道**：setCorePoolSize 缩小 -> interruptIdleWorkers -> take/poll 抛 InterruptedException -> getTask 捕获后不退出而是**重查状态重算 timed** -> 超时后自然收缩。**参数变更"立即传导"到每个 Worker 的下一次取任务**

**架构师经验**：线程池是"弹性系统"的微缩模型--**扩容靠流量自然驱动（execute 建 Worker），缩容靠超时自然回收（poll 超时退出），两条路径都无锁、无中心控制**。设计任何弹性资源池（连接池/协程池/实例池）都可以借鉴这个模式。

### 2.5 优雅关闭：状态机与中断的协作

```
shutdown()                  shutdownNow()
    │                           │
    ▼                           ▼
SHUTDOWN：不接新任务          STOP：不接新任务
    │ 继续处理完队列              │ drainQueue 放弃队列任务（返回给调用方）
    │ interruptIdleWorkers        │ interruptWorkers（所有线程，包括正在执行的）
    ▼                           ▼
队列空 && workerCount==0（由最后退出的 Worker 在 processWorkerExit -> tryTerminate 推进）
    ▼
TIDYING -> terminated() 钩子 -> TERMINATED -> termination.signalAll
    ▼
awaitTermination 返回 true
```

**关键认知**：**关闭是"协商"出来的，不是"命令"出来的**--shutdown/shutdownNow 只设置状态 + 发中断，真正的状态推进由最后一个退出的 Worker 完成。这就是为什么优雅关闭必须"三件套"（shutdown -> awaitTermination 带超时 -> shutdownNow 止损），单调用 shutdown 无法保证完成。

### 2.6 execute 入队后的"双重校验"：防御性设计的范本

```java
if (isRunning(c) && workQueue.offer(command)) {
    int recheck = ctl.get();                          // ① 入队成功后再读一次 ctl
    if (!isRunning(recheck) && remove(command))       // ② 池子刚好被关闭 -> 出队并拒绝
        reject(command);
    else if (workerCountOf(recheck) == 0)             // ③ 入队后一个线程都不剩了
        addWorker(null, false);                       //    补一个纯消费 Worker
}
```

两个校验各防一个竞态：

| 竞态 | 画面 | 防御 |
|------|------|------|
| offer 与 shutdown 并发 | 任务刚入队，另一个线程执行了 shutdown，如果不再检查，这个任务会被留在队列里"无人问津"（SHUTDOWN 虽然处理队列，但 STOP 不处理） | recheck 状态，非 RUNNING 则 remove + reject |
| offer 与线程回收并发 | 入队瞬间所有 Worker 恰好超时退出（allowCoreThreadTimeOut=true 或极端时序），任务入队却没人消费 | workerCount==0 则 addWorker(null) 补消费线程 |

**架构师经验**：**"操作成功后再校验一次前提"**（check-act-recheck）是多线程代码防御性设计的通用模式--单线程思维觉得"刚检查过还查什么"，并发世界里两次检查之间世界已经变了。AQS 的 acquireQueued 自旋重试（Day03）、数据库乐观锁的版本号校验，都是同一思想。

### 2.7 addWorker 三段式与 processWorkerExit 补员：弹性闭环

**addWorker 的三段式**（名额预占 -> 加锁登记 -> 启动线程）：

```
第一段（无锁重试）：状态检查 + CAS 线程数 +1
   ★ 此时线程还没创建！"名额"先占住，失败可回滚（decrementWorkerCount）
第二段（mainLock）：Worker 对象入 workers HashSet（全局锁只保护集合读写）
第三段：t.start() 启动线程 -> runWorker(w)
   任何一步失败 -> 回滚线程数，保证名额与线程最终一致
```

**processWorkerExit 的补员逻辑**（Worker 退出的 finally）：

```
Worker 退出（getTask 返回 null 正常退出 / 任务异常导致死亡）
  ├─ completedAbruptly（异常死亡）-> 直接 addWorker 补员（不管 core 上限的判断细节）
  ├─ 正常退出但 当前线程数 < corePoolSize -> addWorker(null) 补员（保持 core 水位）
  └─ 正常退出且已到 core 水位 -> 不补（这是"收缩"的正常路径）
  最后尝试 tryTerminate()（最后一个退出的 Worker 负责推进池子状态）
```

**关键认知**：execute 建 Worker（扩容）、getTask 超时退 Worker（缩容）、processWorkerExit 补 Worker（自愈），三处协作构成**无中心控制的弹性闭环**--没有"管理线程"统筹，全靠状态字段 + CAS + 中断协商。**这是分布式"自组织"设计在单机并发组件里的预演，与 Raft 的"任期状态推进"（2026年05月第3周）在思想上同构：状态由参与者推进，而非命令者下发**。

### 2.8 源码阅读地图（面试前 10 分钟速览版）

```
ThreadPoolExecutor 源码主线（按调用顺序）：

execute(command)                          ← 提交入口（四步分流）
  ├─ workerCountOf < core?
  │    └─> addWorker(command, true)       ← 核心线程
  ├─ workQueue.offer?
  │    ├─ recheck（关闭/零线程双重校验）
  │    └─ 队列满 -> addWorker(command, false)  ← 非核心线程
  │              └─ 失败 -> reject(command)    ← 拒绝策略
  │
  addWorker(firstTask, core)
  ├─ 外层：CAS workerCount+1（名额预占）
  ├─ 内层：mainLock 下入 workers 集合
  └─ t.start() -> Worker.run()
        │
        ▼
  runWorker(w)                            ← 线程主循环
  ├─ w.unlock()（state -1 -> 0）
  └─ while ((task = getTask()) != null)
       ├─ w.lock()（标记"忙"）
       ├─ beforeExecute / task.run() / afterExecute
       └─ w.unlock()（标记"闲"）
             │
             ▼
       getTask()                          ← 取任务 + 生死决策
       ├─ timed = allowCoreThreadTimeOut || wc > core
       ├─ timed ? poll(keepAlive) : take()
       └─ 返回 null -> processWorkerExit（退出/补员/tryTerminate）
```

**架构师经验**：面试讲线程池源码，按这张地图从 execute 讲到 getTask 约 3 分钟，每个节点能展开一层细节（如 2.2 的 Worker 锁、2.6 的双重校验）。**能画出地图的是读过源码的人，能讲清每个"为什么这样设计"的才是架构师**。

---

---

## 三、参数配置方法论

### 3.1 方法论金字塔：公式 -> Little's Law -> 压测 -> 动态治理

```
            ┌─────────────────┐
            │ 动态线程池 + 监控  │  ← 运营层：参数可调 + 水位告警兜底
            └─────────────────┘
          ┌─────────────────────┐
          │ 压测验证（找拐点留余量）│  ← 验证层：四条曲线（RT/active/队列/下游）
          └─────────────────────┘
        ┌───────────────────────────┐
        │ Little's Law：L = λ × W     │  ← 推导层：从 QPS×RT 算并发
        └───────────────────────────┘
      ┌───────────────────────────────────┐
      │ 公式法：CPU 密集 N+1 / IO 密集 N*(1+W/C)│  ← 估层：只给数量级
      └───────────────────────────────────┘
```

### 3.2 Little's Law 的两种用法

```
正用（定参）：需要多少线程？
  监管上报：λ = 1300 QPS，W = 0.2s
  L = 1300 × 0.2 = 260 个并发执行槽位
  -> 线程数（或虚拟线程并发数）>= 260 才扛得住峰值

反用（验容）：这个池子最大多少吞吐？
  最大吞吐 = maxThreads / RT
  例：max=64，RT=0.2s -> 320 QPS 上限，扛 1300 QPS 必然排队/拒绝
```

**关键认知**：Little's Law 把线程池参数从"技术参数"变成"业务指标（QPS × RT）的函数"。**架构师做容量规划时说的不是"我配了 64 个线程"，而是"按峰值 1300 QPS × 200ms RT，需要 260 并发，我配了 core 96 / max 128 留了下游保护"**。

### 3.3 压测法的纪律

四条曲线缺一不可：任务 RT（P99）、活跃线程数、队列水位、下游指标（DB 连接等待 / 依赖服务 RT / GC）。拐点判定：RT 陡增且队列不回落。定参取拐点前 70% 负载对应配置。

**架构师经验**：压测最大的坑是**只看自己服务的绿、不看下游的死活**。单服务压出 5000 QPS 全绿、上线把医保中心打挂的案例比比皆是。压测环境必须影子化下游或按下游配额限流。

### 3.4 动态线程池落地架构（美团思路）

```
Nacos 配置（core/max/queueCap，变更走审批）
    │ 监听
    ▼
DynamicPoolManager
    ├─ 先 setMaximumPoolSize（抬上限）
    ├─ 再 setCorePoolSize（抬下限；缩小则 interruptIdleWorkers 自然收缩）
    └─ 自定义 ResizableQueue.setCapacity（LinkedBlockingQueue 的 capacity 是 final，需自研）
    ▲
    │ 5s 采集
Metrics（active / 队列水位 / RT / 拒绝数 / 提交完成速率）
    │
    ▼
大盘 + 告警（水位 70% 预警 / 90% 严重 / 拒绝数 > 0 即告警）
```

**关键认知**：动态线程池的价值不是"改参数不用重启"，而是**把参数从"发布时的猜想"变成"运营中的实验"**--配合监控闭环，每次调参都能验证效果。调参顺序（先 max 后 core）和队列 final 的限制是实现的两个细节深水区。

### 3.5 在线问诊系统三池配置基线（方法论落地示例）

用第 3.2 节的方法论，对问诊系统三个核心池子给出配置推导基线（数字为推导示例，实际以压测修正）：

| 池子 | 业务指标 | Little 推导 | 配置基线 | 拒绝策略 |
|------|---------|-----------|---------|---------|
| 监管上报池 report-pool | 峰值 1300 QPS，RT 200ms，下游配额 50 并发 + 批量接口 20 条/批 | 1300×0.2=260 并发；配额×批量=有效吞吐 50×20/0.2s=5000 条/s 覆盖峰值 | core 32 / max 64 / ArrayBlockingQueue(2000) / 60s | 落补偿表+告警（案例 1） |
| IM 消息下发池 im-push | 10w 连接，高峰消息 3000 QPS，含 RPC RT 波动 5ms~3s（已加 500ms 超时） | 3000×0.05≈150 并发，但下游抖动时按 500ms 算需 1500 -- 靠熔断+隔离兜底而非无限扩线程 | core 32 / max 64 / queue 1000 | 落库重投（消息不能丢） |
| IM 心跳池 im-heartbeat | 10w 连接 / 30s 心跳 ≈ 3300 QPS，纯内存 1ms | 3300×0.001≈4 并发 | core 4 / max 8 / queue 200 | 拒绝即告警（生命线） |
| 医保外呼（虚拟线程试点） | 批量上传数千次外呼，RT 1-3s，医保配额 50 并发 | 并发=配额 50（瓶颈在下游不在线程） | newVirtualThreadPerTaskExecutor + Semaphore(50) | 不需要（信号量前置） |

**架构师经验**：这张表的每一行都能讲出"业务指标 -> 并发推导 -> 参数 -> 拒绝策略"的完整链路，**这才是"参数怎么定"的架构师级答案**。注意最后一行：虚拟线程池没有 core/max/queue 三件套，"容量"的约束点从线程参数前移到了信号量--治理对象从"线程"变成了"下游配额"，这是范式转换的直观体现。

### 3.6 队列选型与容量：有界化决策（呼应 Day04）

| 队列 | 线程池行为 | 容量建议 | 问诊系统对应 |
|------|-----------|---------|-------------|
| ArrayBlockingQueue | 队列满前不扩线程（JDK 语义），预分配内存 | 2000（4MB 级，延迟 ~6s） | 监管上报池（案例 1 改造选择：内存可控 + 强制有界） |
| LinkedBlockingQueue | 同上，吞吐略高（读写两把锁） | **必须传容量**，不传即无界（案例 1 事故根源） | -（教训：要么显式容量要么不用） |
| SynchronousQueue | 不排队，直接扩线程到 max | 0（无缓冲） | IM 心跳池备选（最终选小队列：心跳突发可缓冲） |
| PriorityBlockingQueue | 按优先级消费 | 无界（要自控入队速率） | 告警类任务（P1 告警优先于统计） |
| DelayedWorkQueue | 延迟/周期取出 | 无界 | 定时补偿重投（30s 扫描的替代方案） |

**容量三约束**：内存（n × 任务对象大小 &lt; 预算）、延迟（排队延迟 ≈ 队列长 / 消费速率）、语义（监管可容忍分钟级、心跳不能容忍秒级）。

**关键认知**：**队列容量是"延迟换稳定"的旋钮，没有最优解，只有与拒绝策略联动的选择**--小队列 + 落库补偿（监管上报）通常优于大队列硬扛；生命线链路（心跳）宁可小队列快拒绝也别排队。

---

## 四、线程池治理与监控

### 4.1 五指标 + 三钩子

| 指标 | 获取方式 | 告警线 |
|------|---------|-------|
| 活跃线程数 / max | getActiveCount / getMaximumPoolSize | 持续 > 90% |
| 队列水位 | getQueue().size / capacity | 70% / 90% |
| 任务 RT（P99） | beforeExecute / afterExecute 埋点 | 基线 3 倍 |
| 拒绝数 | 自定义 handler 打点 | > 0（监管场景） |
| 提交 vs 完成速率 | getTaskCount / getCompletedTaskCount 差值 | 持续背离 |

钩子的三个必知：afterExecute 的 Throwable 参数**拿不到 submit 任务的异常**（藏在 Future 里，要 Future.get 补捞）；beforeExecute 的开始时间要用 Runnable 做 key 存 Map（注意重入/包装）；terminated 是清理资源的收口点。

### 4.2 线程池隔离规范

```
隔离维度四把刀：
  1. 重要性：核心链路 vs 非核心（问诊会话 vs 数据统计）
  2. 行为：CPU 密集 vs IO 密集（编解码 vs 外呼推送）
  3. 下游：按依赖方切池（DB 池 / Redis 池 / 医保外呼池）
  4. 延迟容忍：心跳（毫秒级）vs 批量上报（分钟级可容忍）

配套纪律：
  - ThreadFactory 必须命名（pool 名 + 序号），jstack 按名定位
  - 每个池必须有自己的拒绝策略（能不能丢、丢到哪，按业务定）
  - 池数量控制在 3~6 个，按"故障传播路径"切而不是按代码模块切
```

**架构师经验**：隔离的本质是舱壁模式（Bulkhead，呼应限流降级周）。**隔离解决的是"非核心故障传染核心"的问题，不是性能问题**--IM 网关案例里心跳池只有 4~8 个线程，比共用大池更小，但它保住了长连接。

### 4.3 线程池打满排查 SOP（jstack 画像法）

```
第一步：jstack / arthas thread | grep 池名，看线程在哪儿
  画像 A：大量线程在 getTask 的 take/poll WAITING
        -> 线程空闲，池子没打满，查上游提交链路
  画像 B：active == max，线程栈聚集在业务调用（RPC/SQL/锁）
        -> 打满实锤，定位慢点

第二步：区分"容量问题"还是"故障问题"
  下游 RT 正常 + 流量增长     -> 容量：动态扩 max / 扩容
  下游 RT 异常（抖动/打穿）   -> 故障：加超时 + 熔断降级，扩线程 = 给下游加压

第三步：应急止损
  非核心池 shutdownNow + drainQueue 任务落补偿表
  核心池动态扩容 + 下游配额限流

第四步：复盘
  为什么水位告警没提前触发？-> 补监控
  为什么慢任务没有超时？    -> 补超时/熔断（限流降级周的知识点）
```

**关键认知**：**线程池打满 90% 的根因是"任务变慢"而不是"线程不够"**。看到打满就调大 max，是最常见的错误响应--等于给已经病危的下游继续加压。

### 4.4 告警分级与应急处置手册

| 级别 | 触发条件 | 响应动作 | 时限 |
|------|---------|---------|------|
| P3 预警 | 队列水位 > 70% 或 active > 90% 持续 5min | 值班查看趋势，确认是流量上涨还是下游抖动 | 30min 内 |
| P2 严重 | 队列水位 > 90% 或 RT 超基线 3 倍 | 动态扩容 max（容量型）/ 对慢下游加熔断（故障型） | 10min 内 |
| P1 事故 | 拒绝数 > 0（核心池）/ 服务不可用 | 非核心池 shutdownNow 止损 + 补偿表接管；核心池扩容+限流 | 立即 |

**应急处置口诀**：先看 jstack 画像（空闲 or 打满），再分容量 or 故障，容量走扩容、故障走熔断，非核心可弃、核心必补偿。

**排查工具速查**：

```bash
# 1. 线程画像（哪个池、卡在哪）
jstack <pid> | grep -A 15 "report-pool"
arthas: thread --state TIMED_WAITING | thread <id>   # 交互式看单线程栈

# 2. 池子运行时指标（不经 JMX 直接看）
arthas: ognl '@com.xxx.ReportPool@INSTANCE.getActiveCount()'
# 或 micrometer /actuator/metricsexecutor.metrics（接了的话）

# 3. 队列内存画像（堆积的是什么）
jmap -histo <pid> | grep -i "LinkedBlockingQueue"
jmap -dump:live,format=b,file=heap.hprof <pid>   # MAT 分析队列内容（什么任务积压）

# 4. 线程数趋势（是否线程泄漏）
ps -T -p <pid> | wc -l 或 /proc/<pid>/status | grep Threads
```

**架构师经验**：应急手册的价值在**"提前写好"**--事故现场没人能冷静推理"该 shutdownNow 还是该扩容"。把第 4.3 节 SOP 变成值班系统里的可点击文档，是团队治理成熟度的标志。

### 4.5 团队线程池代码模板（规约落地）

规约要能落地，必须给"抄就能用"的模板。问诊系统团队模板（脱敏）：

```java
/**
 * 团队线程池模板：六问全覆盖
 * 1 有界 2 业务化拒绝 3 命名 4 参数有推导注释 5 监控 6 优雅关闭
 */
@Component
public class ReportThreadPool implements DisposableBean {

    private final ThreadPoolExecutor executor = new ThreadPoolExecutor(
            32, 64, 60L, TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(2000),                    // 1 有界：4MB 级，最长排队 ~6s
            new NamedThreadFactory("report-pool"),             // 3 命名：jstack 可定位
            new CompensationRejectHandler(compensationMapper, alarmClient));  // 2 落库+告警

    // 4 参数推导注释：峰值 1300 QPS × 200ms = 260 并发；
    //    下游配额 50 × 批量 20 条 = 有效吞吐覆盖峰值，故 max=64 而非 260
    // 5 监控：启动时注册 Micrometer 指标（active/queue/reject/RT 五件套）

    public CompletableFuture<Void> submit(ReportTask task) {
        return CompletableFuture.runAsync(task, executor);
    }

    @Override
    public void destroy() throws InterruptedException {        // 6 优雅关闭三件套
        executor.shutdown();
        if (!executor.awaitTermination(30, TimeUnit.SECONDS)) {
            List<Runnable> dropped = executor.shutdownNow();
            log.warn("关闭放弃任务 {} 个，已转补偿扫描", dropped.size());
        }
    }
}
```

**关键认知**：规约的落地形态不是文档，是**模板类 + 代码评审 checklist**。新人抄模板起池子，六问默认全过--这比"培训 + 考试"有效一个数量级。

---

## 五、虚拟线程架构意义

### 5.1 从"线程稀缺"到"线程廉价"：异步范式的终结者

```
平台线程时代的三难选择：
  1. 同步阻塞写法（一请求一线程）    -> 代码简单，但线程数扛不住并发
  2. 线程池 + 阻塞                  -> 折中，但排队/隔离/参数治理复杂（题目二全部内容）
  3. 异步回调 / CompletableFuture    -> 吞吐高，但回调地狱 / 栈撕裂 / 调试困难

虚拟线程：用 1 的写法拿到接近 3 的吞吐
  同步阻塞代码 + 阻塞点自动 unmount -> 线程不再稀缺 -> 不需要异步化
```

**关键认知**：虚拟线程的架构意义不是"更快"，而是**"消灭为了吞吐而牺牲可读性的异步范式"**--Thread-per-request 模型在百万并发下重新成立。CompletableFuture 链式回调存在的唯一理由（线程太贵）被抽掉了。

### 5.2 N:M 调度的本质：把"等待"从线程上剥离

```
mount/unmount 本质：
  阻塞发生时（IO/park），JVM 把虚拟线程的栈帧整体搬到堆上的
  Continuation/StackChunk 对象 -> 载体线程立即释放
  就绪后栈帧拷回载体（可能是另一个载体）继续执行

算术基础：
  平台线程：100w 阻塞任务 × 1MB 栈 = 1TB（不可能）
  虚拟线程：100w 阻塞任务 × 几 KB 堆 = 几 GB（可行）
  -> "阻塞的成本"从"占一个内核线程"降为"一个堆对象 + 一个事件注册"
```

调度器细节：专用 ForkJoinPool（与并行流 commonPool 隔离），FIFO 模式（asyncMode=true），并行度 = NCPU，载体上限 256（补偿机制），协作式调度（无时间片剥夺，CPU 死循环会一直占载体）。

**架构师经验**：CPU 密集任务在虚拟线程下无收益甚至倒退（无阻塞点无 unmount，百万虚拟线程排队在 NCPU 个载体上，还多一层调度开销）--**虚拟线程是"等待密集型"（IO 密集）任务的解药，不是万能加速器**。

### 5.3 pinning：虚拟线程的阿喀琉斯之踵

| 场景 | JDK21 | JDK24（JEP 491） |
|------|-------|------------------|
| synchronized 块内阻塞（含 Object.wait） | pin（载体被钉住） | 已修复（监视器实现改造，不再 pin） |
| native / JNI 调用 | pin | 仍 pin |

危害链条：synchronized 内阻塞 -> 载体被钉 -> 调度器补偿建载体 -> 到 256 上限 -> 后续虚拟线程集体排队 -> **没有 OOM、没有拒绝、没有线程爆炸，只有 RT 静默劣化**。这比线程池打满（有拒绝/告警信号）更隐蔽。

治理三件套：上线前全量扫描 synchronized 长阻塞点（换 ReentrantLock 或缩小同步范围）；压测开 `-Djdk.tracePinnedThreads=full`；监控载体池活跃度。

**关键认知**：**Day02 的"synchronized 性能已够用"结论在虚拟线程语境下被推翻**--锁选型（Day02 vs Day03）从性能问题升级为架构问题。这是本周知识互相咬合的最佳例证。

### 5.4 "不要池化"与 ThreadLocal 的再审视

```
池化线程的消解：
  池化前提（资源昂贵需复用）被推翻 -> newVirtualThreadPerTaskExecutor
  池化的两个职责被拆开：
    复用职责 -> 消失（线程廉价）
    限流职责 -> 交还 Semaphore（保护下游，语义更清晰）

ThreadLocal 的再审视：
  "传上下文"用法：功能仍可用，但百万线程 = 百万份 ThreadLocalMap（内存放大）
  "缓冲区复用"用法（SimpleDateFormat/编解码器）：明确反模式，改无状态工具或显式缓冲池
  官方方向：ScopedValue（不可变 + 作用域绑定 + 自动清理，JDK21 预览）
```

**架构师经验**：虚拟线程改造清单 = **synchronized 长阻塞扫描 + ThreadLocal 审计 + 池化假设重构 + pinning 监控**。四项做完才谈切换，否则是拿生产系统赌运气。

### 5.5 选型决策树（平台线程 vs 虚拟线程）

```
任务 CPU 密集？
  ├─ 是 -> 平台线程池（≈ NCPU+1）
  └─ IO 密集 -> JDK >= 21 且框架（Boot 3.x）就绪？
        ├─ 否 -> 平台线程池 + Little's Law + 动态治理
        └─ 是 -> synchronized 长阻塞 / ThreadLocal 已扫描改造？
              ├─ 否 -> 先改造再评估
              └─ 是 -> 并发规模需要 > 数百 / 队列排队严重？
                    ├─ 是 -> 虚拟线程 + Semaphore 限流下游 + pinning 监控
                    └─ 否 -> 平台线程池足够（几十并发内别加复杂度）
```

### 5.6 JDK8 -> JDK21 升级评估清单（架构师视角）

升级不是"换个 JDK 版本号"，而是四个层面的系统性评估：

| 层面 | 评估项 | 问诊系统的具体答案 |
|------|-------|------------------|
| 依赖层 | Boot 2.x -> 3.x（要求 17+）、javax -> jakarta、cglib/ASM/Lombok/Javassist 版本 | 三个中间件依赖需升级；javax.servlet 全量替换为 jakarta |
| 运行时层 | GC 默认 Parallel -> G1、内部 API 强封装（--add-opens）、cgroup 感知差异 | G1 参数重新基线（复用 JVM 专题压测法）；两处 sun.misc.Unsafe 依赖需替换 |
| 并发层 | synchronized 长阻塞扫描、ThreadLocal 审计、池化假设重构、pinning 监控 | 外呼路径 5 处 synchronized 内 IO 改 ReentrantLock；剔除 2 类 ThreadLocal 缓冲用法 |
| 运维层 | arthas/agent 对 21 支持、jstack 虚拟线程展示（默认聚合）、灰度路径 | 非核心服务先升 -> 灰度机房 -> 全量；试点从医保外呼模块开始 |

**关键认知**：JDK8 -> 21 跨 13 个大版本，**成本主要在生态链与运行时假设，不在 JDK 本身**。虚拟线程只是收益之一，必须与 G1/ZGC（JVM 专题）、Records/文本块等语言改进打包评估--单为虚拟线程而升级，ROI 说服力不足。

### 5.7 虚拟线程时代的线程池：共存图景

虚拟线程不会"消灭"线程池，两者将在长期内分工共存：

| 维度 | 平台线程池 | 虚拟线程 |
|------|-----------|---------|
| 角色定位 | **CPU 资源的调度器**（NCPU 个工人分派计算任务） | **阻塞等待的容器**（百万并发挂起等 IO） |
| 典型场景 | 编解码/报文解析/批量计算 | 外呼/HTTP 聚合/爬取/批量上传 |
| 容量约束 | 线程数（栈内存 + 调度） | 下游配额（Semaphore）+ 堆内存 |
| 治理重点 | 五指标 + 拒绝策略 + 动态调参 | pinning 监控 + ThreadLocal 审计 + 配额限流 |
| 失效模式 | 打满拒绝（显性） | pinning 静默劣化（隐性） |

**架构师经验**：迁移期系统里最常见的形态是**混合模型**--平台线程池跑 CPU 任务，虚拟线程执行器跑 IO 任务，两者通过阻塞队列衔接。不要追求"一刀切换虚拟线程"，按任务画像逐模块改造（案例 3 的试点路径），每一步都可回滚。

### 5.8 虚拟线程常见误区速查表

| 误区 | 真相 | 纠正 |
|------|------|------|
| "虚拟线程更快" | 单任务不更快（甚至多一层调度），提升的是并发吞吐与代码可读性 | 按"等待型任务"识别收益场景 |
| "虚拟线程也要池化" | 池化前提（线程昂贵）不成立，池化反成并发瓶颈 | newVirtualThreadPerTaskExecutor + Semaphore 限下游 |
| "synchronized 随便用" | JDK21 synchronized 内阻塞会 pin 载体（静默劣化） | 换 ReentrantLock / 缩小同步范围 / 升 JDK24 |
| "ThreadLocal 照常用" | 百万线程 = 百万份 ThreadLocalMap，内存放大 | 无状态工具 / 显式缓冲池 / ScopedValue |
| "CPU 密集也换虚拟线程" | 真实并行度仍 = NCPU，白多一层调度 | CPU 任务留在平台线程池 |
| "用了虚拟线程就不需要线程池治理" | pinning 监控、配额限流、下游保护一个不能少 | 治理对象从线程参数转向下游配额与 pinning |
| "Thread.sleep 会 pin" | 不会--sleep/park 是标准 unmount 点 | 只需警惕 synchronized 内阻塞与 native 调用 |

---

---

## 六、在线问诊系统实战（3 个 STAR 完整案例）

### 6.1 案例 1：监管上报服务无界队列堆积 OOM -> 有界化 + 拒绝落库改造

**S（情境）**：在线问诊系统的监管上报服务，负责把处方/诊断/问诊订单数据上报监管平台，峰值 1300 QPS，数据是合规数据、一条不能丢。早期实现图省事用了 `Executors.newFixedThreadPool(20)` 做异步上报，上线前半年平稳。

**T（任务）**：体检高峰期监管平台侧接口劣化（RT 从 50ms 涨到 5s 以上），随后上报服务频繁 Full GC 直至 OOM 重启。要求定位根因、完成不丢数据的改造，并保证同类问题不再发生。

**A（行动）**：

1. **定位**：OOM 后先拉 jmap histogram，发现 `LinkedBlockingQueue$Node` 实例数 300w+，占堆 60% 以上；jstack 显示 20 个上报线程全部 TIMED_WAITING 在监管平台 HTTP 调用上。根因链条清晰：FixedThreadPool 的 LinkedBlockingQueue 无界（容量 Integer.MAX_VALUE）-> 下游变慢后消费速率 20/5s=4 QPS，生产 1300 QPS -> 队列无限堆积 -> OOM
2. **参数重定**：用 Little's Law 复核：峰值 1300 QPS × 正常 RT 0.2s 需要 260 并发；考虑监管平台配额（50 并发）与批量接口（一次带 20 条）折算，定为 core 32 / max 64 / ArrayBlockingQueue(2000) / keepAlive 60s，ThreadFactory 命名 `report-pool-*`
3. **拒绝策略业务化**：自定义 RejectHandler--满载时任务快照落补偿表 + 告警（带队列水位/活跃数快照）+ 拒绝数打点；落库失败再降级本地文件 + 最高级告警
4. **补偿闭环**：30s 定时任务扫补偿表重投，池子空闲水位低于 50% 才投，避免二次打满
5. **监控**：接入五指标（active/队列水位 70%、90% 两档告警/RT P99/拒绝数/提交完成速率）

**R（结果）**：改造后两个月再遇监管平台一次 40 分钟劣化--服务全程稳定：队列打满触发拒绝 1.2w 次、全部落补偿表零丢失，恢复后 8 分钟完成回放，全程无 OOM 无重启；此后 OOM 零复发。沉淀了团队"线程池必须手动 new + 有界 + 命名 + 业务化拒绝"的规约（阿里规约在团队真正落地的开端）。

**面试追问预演**：为什么不用 MQ 削峰？-> 当时上报链路对"分钟级回放"可接受，补偿表方案更轻；量级再上一个数量级应演进为 MQ（Day06 串联方向）。为什么 max 定 64 不是 260？-> 医保/监管侧配额是硬约束，线程数超过下游配额只是把等待从队列挪到连接里，配合批量接口（64×20 条/批）实际吞吐满足峰值。

### 6.2 案例 2：IM 网关 IO 线程池打满导致长连接假死 -> 线程池隔离 + 监控

**S（情境）**：IM 在线客服网关，单机 10w+ 长连接，消息下发、心跳处理、系统通知共用一个 FixedThreadPool(50) 的 IO 线程池。消息下发链路里有一步同步调用用户服务 RPC（查用户在线状态与偏好）。

**T（任务）**：某次用户服务抖动（RT 5ms -> 3s）后，客服侧大面积反馈"消息发不出去、页面显示在线但收不到消息"，长连接出现"假死"。要求止血并根治。

**A（行动）**：

1. **定位**：jstack 看 IO 池--50 个线程全部 TIMED_WAITING 聚集在用户服务 RPC 的 SocketRead 上（active=50=max），队列里堆着数千个任务，其中混着心跳处理任务；心跳超时判定是 15s，排队超过 15s 后服务端把连接判定掉线、客户端开始重连风暴，表象即"假死"
2. **止血**：当晚对用户服务 RPC 加 500ms 超时 + 降级（读本地缓存的用户画像），长连接恢复
3. **根治（线程池隔离）**：按"延迟容忍 + 行为特征"拆池--心跳池 `im-heartbeat-*`（core 4 / max 8 / queue 200，纯内存操作毫秒级）、消息下发池 `im-push-*`（core 32 / max 64 / queue 1000）、系统通知池 `im-sys-*`（core 2 / max 4 / queue 500）；每池独立拒绝策略（心跳拒绝直接记日志报警、下发拒绝进补偿表）
4. **依赖加固**：所有外呼加超时与熔断（呼应限流降级专题），确保"下游慢"不再等于"线程被占死"
5. **监控**：jstack 可按池名定位；三池分别接 active/水位/拒绝告警；心跳处理 RT 超过 50ms 即告警（心跳是网关生命线）

**R（结果）**：此后用户服务又抖动过三次，每次只表现为消息下发延迟上升（P99 3~5s），心跳零受影响、零掉线、零假死；重连风暴问题消失。沉淀团队规范："核心与非核心必须物理隔离 + 线程命名 + 生命线链路独立小池"。

**面试追问预演**：为什么心跳池这么小（4~8 线程）反而更安全？-> 心跳任务是纯内存毫秒级操作，8 线程理论吞吐 8/0.001s = 8000/s，远超 10w 连接的心跳频率（心跳间隔 30s，单机约 3300/s）；小池 + 独立队列避免了和大流量任务互相干扰，"隔离解决的是传染问题，不是性能问题"。

### 6.3 案例 3：医保外部调用的虚拟线程改造评估（JDK21 升级试点）

**S（情境）**：医保对接服务负责调用医保中心接口（结算/明细上传/目录查询），单次 RT 1~3s 且医保中心配额仅允许 50 并发。公卫体检高峰需要批量明细上传（一个任务聚合数千次外呼），原实现用平台线程池（core 50 / max 100），批量任务排队严重、任务完成时间不可控，而服务器 CPU 利用率不到 15%--典型的"线程等 IO、CPU 闲着"。

**T（任务）**：评估 JDK8 -> JDK21 升级与虚拟线程改造的可行性、收益与风险，并给出落地路径。

**A（行动）**：

1. **收益测算**：Little's Law 验证瓶颈--批量上传需要数百并发等待，平台线程 100 个上限锁死吞吐；虚拟线程下等待不占载体，瓶颈回归到医保配额 50 并发，理论上批量任务墙钟时间取决于配额而非线程数
2. **升级评估清单**：依赖链（Spring Boot 2.x -> 3.x，javax -> jakarta 命名空间、cglib/ASM 升级）、GC 基线重做（Parallel -> G1，复用 JVM 专题压测方法）、容器 cgroup 感知差异、观测工具对 21 的支持
3. **虚拟线程专项扫描**：静态扫描 + 压测开 `-Djdk.tracePinnedThreads=full`，发现外呼热路径 5 处 synchronized 内 HTTP 调用（老代码用 synchronized 做幂等防重）--逐一改为 ReentrantLock（Day03）+ 幂等键收敛到 Redis SETNX；审计 ThreadLocal，剔除日期格式化与编码缓冲的 ThreadLocal 用法（改无状态 DateTimeFormatter）
4. **试点改造**：外呼模块切 `Executors.newVirtualThreadPerTaskExecutor`，用 Semaphore(50) 对齐医保配额（阻塞的虚拟线程自动 unmount，不占载体）；批量子任务每明细一个虚拟线程，聚合用 CompletableFuture.allOf 收口
5. **压测对比**：同 1000 条明细批量上传--平台线程池墙钟约 40s（受 100 线程上限与排队拖累）、虚拟线程约 22s（受 50 配额限制的理论下限附近）；线程内存从 100×1MB 降到 NCPU 个载体 + 按需虚拟线程

**R（结果）**：试点模块完成虚拟线程改造并灰度一个容量周期，批量任务耗时下降约 45%、线程栈内存下降 90%+、CPU 利用率小幅上升（等待减少带来的吞吐回收）；输出《JDK21 升级评估报告》与虚拟线程改造 checklist（synchronized 扫描 / ThreadLocal 审计 / 池化假设重构 / pinning 监控四件套），全量升级列入下季度路线图。

**面试追问预演**：为什么还要配额限流，虚拟线程不是很快吗？-> 虚拟线程提升的是"我们这边等待的并发容量"，下游医保中心 50 并发配额是硬约束，无限并发只会把医保接口打挂然后被限流封禁；Semaphore(50) 正是把"下游容量"显式化的正确姿势（池化线程时代 maxThreads 兼任的限流职责，回归到它该在的地方）。CPU 利用率为什么反而升了？--等待减少 -> 单位时间完成的外呼更多 -> 编解码/报文构造等计算总量上升，这正是"IO 密集任务虚拟线程化释放 CPU"的直接证据。

### 6.4 三个案例的面试串联讲法（叙事弧）

三个案例单独讲是三个故事，串起来讲是一个架构师成长弧，面试建议按"事故 -> 治理 -> 演进"三段推进：

```
第一段（事故认知）：案例 1 监管上报 OOM
  "我最早对线程池的认知是一次 OOM 教的：newFixedThreadPool 的无界队列
   在下游变慢时堆积了 300w 任务。那次我真正理解了阿里规约背后的哲学--
   满载行为必须显式设计。"

第二段（治理体系）：案例 2 IM 网关假死
  "有了有界化还不够，故障会在池子间传染。IM 心跳被慢 RPC 拖死教会我
   隔离--线程池治理是三级资源问题，隔离解决的是传染不是性能。"

第三段（范式演进）：案例 3 医保虚拟线程
  "治理做到头，平台线程的物理上限还在。医保外呼等待密集、CPU 闲着，
   虚拟线程把阻塞成本从 1MB 内核线程降到几 KB 堆对象，我用 Semaphore
   对齐下游配额，批量耗时降 45%。这也是我评估 JDK21 升级的切入点。"

收尾（方法论提炼）：
  "回头看，线程池的答案从'配几个参数'变成了三层：显式设计满载行为（拒绝策略）、
   按故障传播路径隔离（舱壁）、按任务画像选择并发模型（平台 vs 虚拟线程）。"
```

**架构师经验**：面试官问"讲一个你解决过的并发问题"时，按这个叙事弧推进，每个案例都有 jstack 证据、参数推导、量化结果，且方法论逐层递进--**单案例证明你解决过问题，叙事弧证明你有体系**。

---

## 七、本日核心认知

1. **线程池是三级资源治理系统**：本机线程 / 队列内存 / 下游容量--只盯线程数调参是程序员视角，三级联动才是架构师视角
2. **无界队列是把背压推迟到 OOM**：满载行为必须显式设计（有界 + 业务化拒绝），这是阿里规则禁止 Executors 的哲学本质
3. **execute 顺序是"core -> 队列 -> max -> 拒绝"**：队列在前 = 线程昂贵先榨干再扩容；core==max + 大队列会让 max 永不生效；Tomcat 重写 offer 反转顺序证明"队列决定池行为"
4. **ctl 用一个 AtomicInteger 打包状态与线程数**：高 3 位状态 / 低 29 位线程数，一次 CAS 管两件事--与 ReadWriteLock 的 state 打包同源思想
5. **关闭是协商出来的**：shutdown 只设状态 + 中断，状态推进由最后退出的 Worker 完成；优雅关闭三件套（shutdown -> awaitTermination -> shutdownNow）缺一不可
6. **Worker 继承 AQS 且故意不可重入**：锁语义重定义为"忙/闲"，不可重入保证任务代码内间接 shutdown 不会中断正在执行的自己；state=-1 屏蔽启动前中断--Day03 AQS 的教科书级应用
7. **核心/非核心线程是同一 Worker 的两种状态**：getTask 按 timed = allowCoreThreadTimeOut || wc > core 分岔 poll/take；动态调参靠"中断空闲 + 重算 timed + 超时自然收缩"生效，永不打断在跑任务
8. **参数配置四层方法论**：公式估数量级 -> Little's Law（L=λ×W，吞吐=max/RT）从业务指标推导 -> 压测找拐点留余量 -> 动态线程池运营闭环
9. **线程池打满 90% 根因是任务变慢不是线程不够**：jstack 画像区分空闲（getTask 等待）与被打满（业务栈聚集）；先治慢（超时/熔断）再谈扩容
10. **隔离是舱壁不是性能优化**：核心/非核心物理隔离 + 命名 + 生命线独立小池（IM 心跳案例），解决的是故障传染
11. **虚拟线程把阻塞成本从 1MB 内核线程降到几 KB 堆对象**：N:M 载体 + mount/unmount；IO 密集赚、CPU 密集不赚；不要池化，限流职责交还 Semaphore
12. **pinning 是虚拟线程时代的隐性架构风险**：JDK21 synchronized 内阻塞钉住载体（静默劣化，比线程池打满更隐蔽），换 ReentrantLock 或升 JDK24（JEP 491）；Day02 的锁选型结论因此改写
