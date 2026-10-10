# 架构师学习-Day05-线程池与虚拟线程

> 日期：2026年08月14日（周五）
> 周主题：并发编程专题 - JMM / synchronized 锁升级 / AQS / 并发容器 / 线程池 / 虚拟线程
> 出题日：Day05 - 线程池与虚拟线程

---

## 背景

经过 Day01 JMM、Day02 synchronized 锁升级、Day03 AQS 核心原理、Day04 并发容器，本周进入线程池与虚拟线程专题。Day03 讲完 AQS 后自然的追问是：**ReentrantLock / Semaphore / CountDownLatch 解决的是"多个线程怎么协作"，那"线程本身从哪来、用完去哪"？** 答案就是线程池。

**线程池是 JUC 的"集大成者"**：Worker 类继承 AQS（Day03 串联点）；ctl 的位打包思想与 ReentrantReadWriteLock 的 state 打包同源（Day03）；workQueue 就是 Day04 的 BlockingQueue；getTask 用 LockSupport.park 挂起空闲线程（Day02/Day03 的 park/unpark）。理解线程池等于把本周前四天的知识全部串起来复习一遍。

同时，线程池还有一个"范式级"的挑战者：**虚拟线程（JDK21 JEP 444）**。它把"线程是稀缺资源"这一线程池存在的前提直接推翻--线程变廉价了，"池化"还成立吗？架构师必须同时掌握两者，并能回答"什么时候仍然用线程池，什么时候应该切虚拟线程"。

架构师面试官最爱问的不是"线程池参数怎么配"，而是：

> "execute 的执行顺序为什么是 core -> 队列 -> max -> 拒绝，而不是 core -> max -> 队列？这个反直觉设计踩过什么坑？"
> "ThreadPoolExecutor 的 5 个状态为什么和线程数打包在一个 AtomicInteger（ctl）里？"
> "Worker 为什么继承 AQS 且故意用'不可重入'独占锁？用 ReentrantLock 不行吗？"
> "你们线程池参数怎么定的？用公式算的吗？出过什么事故？"
> "JDK21 虚拟线程上线了吗？synchronized 导致 pinning 怎么排查？虚拟线程为什么不要池化？"

这些问题答不出来，等于"用了十年线程池但没读过一次源码"，线程池打满、无界队列 OOM 这类 Top 级生产事故就无法复盘和预防。本周 Day05 把线程池与虚拟线程一次性梳理清楚，Day06 串联整合，Day07 深挖 AQS 源码与生产事故反推。

**Day05 为什么是"线程池与虚拟线程"而不是"并发工具类"**：

1. **线程池是生产事故重灾区**：无界队列 OOM、线程打满服务假死，是仅次于慢 SQL、缓存击穿的高频事故源
2. **线程池是本周知识的串联点**：Worker 继承 AQS + workQueue 是 BlockingQueue + ctl 是 state 打包，一天的题目复习四天的内容
3. **参数配置是架构师"治理能力"的分水岭**：公式法 / Little's Law / 压测法 / 动态线程池，是初级与架构师的分界线
4. **虚拟线程是 JDK 近十年最大并发变革**（JEP 444），2024+ 面试新高频，与 Day02/Day03 的锁选型直接联动（pinning 问题）
5. **与简历项目强绑定**：监管上报 1300 QPS、IM 网关 10w+ 长连接、医保外呼，全部是线程池/虚拟线程场景

**与往周专题的衔接点**：

- **Day03 AQS** vs **ThreadPoolExecutor.Worker**：Worker 继承 AQS 实现"不可重入独占锁"，是 AQS 在 JDK 内部的真实继承用例（本周最重要串联点）
- **Day03 state 打包（ReentrantReadWriteLock 高 16 位读 / 低 16 位写）** vs **ctl 打包（高 3 位状态 + 低 29 位线程数）**：同一个位打包思想在不同组件的应用
- **Day04 BlockingQueue** vs **workQueue**：LinkedBlockingQueue（newFixedThreadPool）/ SynchronousQueue（newCachedThreadPool）/ DelayedWorkQueue（newScheduledThreadPool）--队列选型直接决定线程池行为
- **Day02 synchronized / Day03 ReentrantLock** vs **虚拟线程 pinning**：JDK21 虚拟线程在 synchronized 内阻塞会"钉住"载体线程，锁选型从"性能问题"升级为"架构问题"
- **限流降级（2026年06月第4周）舱壁模式** vs **线程池隔离**：同一个 Bulkhead 思想在 Sentinel 线程池隔离与业务自建线程池隔离中的两种落地
- **JVM 第1周 Day01（线程栈）** vs **平台线程 1MB 栈 vs 虚拟线程堆上栈**：线程数上限的物理约束（-Xss 与 unable to create new native thread）
- **JVM 第2周 Day05（生产排查）** vs **线程池打满排查**：jstack / jmap / 大盘指标的分析方法直接复用

**与简历项目的衔接点**：

在线问诊系统的线程池三大重灾区：

1. **监管上报服务（1300 QPS）**：早期用 `Executors.newFixedThreadPool(20)`，下游监管平台接口变慢时无界队列堆积导致 OOM--案例 1（有界化 + 自定义拒绝落库改造）
2. **IM 网关（10w+ 长连接）**：IO 线程池被慢 RPC 打满，心跳处理排队超时，长连接"假死"--案例 2（线程池隔离 + 监控）
3. **医保外部调用**：单次 RT 1-3s 的 IO 密集外呼，平台线程池排队严重，虚拟线程改造与 JDK21 升级评估--案例 3

---

## 题目一（ThreadPoolExecutor 全解题）：线程池核心原理全解

请详细回答以下问题：

1. **7 参数与 execute 执行流程全解**：ThreadPoolExecutor 构造函数 7 个参数（corePoolSize / maximumPoolSize / keepAliveTime / unit / workQueue / threadFactory / handler）各自语义？execute 的完整执行流程（workerCount &lt; core -> addWorker -> workQueue.offer -> 双重校验 recheck -> addWorker(非核心) -> reject）？为什么是"队列在前、最大线程在后"而不是"先扩满线程再排队"（设计权衡 + 踩坑：core == max 时 maximumPoolSize 永不生效 / Tomcat TaskQueue 重写 offer 的 hack）？
2. **拒绝策略全解**：4 种内置拒绝策略（AbortPolicy / CallerRunsPolicy / DiscardPolicy / DiscardOldestPolicy）各自行为与适用场景？CallerRunsPolicy 的"背压"价值与陷阱（调用者线程执行阻塞上游 / shutdown 后行为）？如何自定义拒绝策略实现"降级落库 + 告警 + 定时补偿"（监管上报场景，数据不能丢）？
3. **5 状态状态机与 ctl 打包全解**：RUNNING / SHUTDOWN / STOP / TIDYING / TERMINATED 各自语义与转换条件？ctl 为什么用"高 3 位状态 + 低 29 位线程数"打包进一个 AtomicInteger（一次 CAS 同时管两件事 / Day03 state 打包呼应）？RUNNING 为什么是负数（数值比较 runStateAtLeast）？terminated 钩子与 termination Condition 的作用？
4. **Worker 与 AQS 不可重入独占锁全解**：Worker 为什么继承 AbstractQueuedSynchronizer（Day03 串联点）？为什么"故意不可重入"（判断空闲 / 防止任务代码内间接中断正在运行的自己）？构造函数 setState(-1) 的意图（runWorker 之前禁止中断）？runWorker 中 w.unlock() 的作用？interruptIdleWorkers 的 tryLock 判空闲逻辑？
5. **execute -> addWorker -> runWorker -> getTask 源码链路全解**：addWorker 的"CAS 线程数 + 加锁入 workers 集 + 启动线程"三段式与重试？runWorker 的循环取任务（firstTask / getTask）、beforeExecute / afterExecute 钩子、异常处理（completedAbruptly）？getTask 的 timed 判断（allowCoreThreadTimeOut || wc > corePoolSize）与 poll/take 分支--核心线程如何"常驻"、非核心线程如何"超时回收"？processWorkerExit 的补员逻辑？
6. **优雅关闭与阿里规约全解**：shutdown（不接新任务 / 中断空闲线程）vs shutdownNow（中断所有线程 / 返回未执行任务 drainQueue）vs awaitTermination（等待终止）"三件套"如何配合？为什么要注册 Runtime shutdown hook？Executors.newFixedThreadPool / newCachedThreadPool 被阿里规约禁止的确切原因（LinkedBlockingQueue 无界 OOM / Integer.MAX_VALUE 线程 OOM）？正确的手动创建姿势？

### 作答区

#### 1. 7 参数与 execute 执行流程全解

**7 参数各自语义**：

```java
public ThreadPoolExecutor(int corePoolSize,          // 1. 核心线程数：常驻线程下限
                          int maximumPoolSize,       // 2. 最大线程数：线程上限（含核心）
                          long keepAliveTime,        // 3. 非核心线程空闲存活时间
                          TimeUnit unit,             // 4. keepAliveTime 的时间单位
                          BlockingQueue<Runnable> workQueue,  // 5. 任务队列（Day04 BlockingQueue）
                          ThreadFactory threadFactory,        // 6. 线程工厂：命名/守护/优先级/uncaughtHandler
                          RejectedExecutionHandler handler)   // 7. 拒绝策略：队列满且线程满时触发
```

| 参数 | 语义 | 配错后果 |
|------|------|---------|
| corePoolSize | 核心线程数（默认不回收，除非 allowCoreThreadTimeOut） | 过小：突发流量直接进队列，RT 上升 |
| maximumPoolSize | 最大线程数（弹性上限） | 过大：线程爆炸；core==max：弹性失效 |
| keepAliveTime | 非核心线程空闲多久后回收 | 过短：频繁建销线程；过长：峰值后资源滞留 |
| workQueue | 提交任务的缓冲区 | 无界队列：堆积 OOM（阿里规约核心问题） |
| threadFactory | 线程创建工厂 | 不命名：jstack 无法定位业务 |
| handler | 满载时的处理策略 | Abort 直接抛异常：上游未捕获则丢任务 |

**execute 执行流程完整版**（JDK 源码）：

```java
public void execute(Runnable command) {
    if (command == null) throw new NullPointerException();
    int c = ctl.get();
    if (workerCountOf(c) < corePoolSize) {           // ① 线程数 < core
        if (addWorker(command, true))                //    直接创建核心线程执行
            return;
        c = ctl.get();                               //    CAS 失败（并发）重读
    }
    if (isRunning(c) && workQueue.offer(command)) {  // ② 入队（队列在前！）
        int recheck = ctl.get();                     //    双重校验
        if (!isRunning(recheck) && remove(command))  //    入队后池子关闭了 -> 拒绝
            reject(command);
        else if (workerCountOf(recheck) == 0)        //    入队后没有线程了（都被回收）
            addWorker(null, false);                  //    补一个非核心线程来消费
    }
    else if (!addWorker(command, false))             // ③ 队列满 -> 尝试非核心线程
        reject(command);                             // ④ 也满 -> 拒绝
}
```

**ASCII 流程图**：

```
execute(command)
      │
      ▼
workerCount < corePoolSize ?──是──> addWorker(command, core) ──> 成功返回
      │否                                    │失败（并发/池关闭）
      ▼                                     ▼
workQueue.offer(command) ──成功──> recheck（防入队后池关闭/无线程）
      │队满失败                              │
      ▼                                     ▼
addWorker(command, max) ──成功──> 返回      否则 reject
      │失败（线程数已达 max）
      ▼
reject(command)  ←── 拒绝策略
```

**"队列在前、最大线程在后"的设计权衡**：

| 维度 | 队列在前（JDK 默认） | 先扩线程再排队（直觉设计） |
|------|--------------------|------------------------|
| 线程资源 | 线程是昂贵资源（1MB 栈 + 调度开销），先榨干既有线程 | 突发流量立即创建大量线程 |
| 内存 | 队列存引用，单任务内存小 | 每线程约 1MB 栈，内存暴涨 |
| 语义 | "弹性扩容是兜底，不是常态" | 弹性扩容成为常态 |
| 风险 | 队列先满，max 可能永远轮不到 | 线程数对突发敏感 |

**踩坑 1：core == max 时 maximumPoolSize 永不生效**。

```
new ThreadPoolExecutor(10, 20, 60s, new LinkedBlockingQueue<>(1000))
现象：负载高峰时队列快速堆积，但线程数始终是 10，max=20 从未达到
原因：流程① 线程数到 10 后不再创建；流程② 队列未满（1000 容量）一直成功；
      流程③ 永远走不到
结论：队列容量大 + core==max 的配置，maximumPoolSize 是"摆设"
```

**踩坑 2：想"先扩线程再排队"要学 Tomcat 重写 offer**。

```java
// Tomcat org.apache.tomcat.util.threads.TaskQueue（简化）
public boolean offer(Runnable runnable) {
    if (parent == null) return super.offer(runnable);
    int poolSize = parent.getPoolSize();
    if (poolSize == parent.getMaximumPoolSize()) return super.offer(runnable); // 已满，正常入队
    if (parent.getSubmittedCount() < poolSize)   return super.offer(runnable); // 有空闲线程，入队即可
    if (poolSize < parent.getMaximumPoolSize())  return false;  // 关键：返回 false"骗"execute
    return super.offer(runnable);                                // 走 addWorker 创建非核心线程
}
```

**关键认知**：Tomcat 的连接器线程池要的是"请求优先被线程处理而不是排队"（Web 请求对延迟敏感），所以用"队列返回 false"的方式反转了 JDK 的顺序。**自定义队列可以改变线程池行为，这是队列选型的进阶玩法**。

**架构师经验**：面试讲清"队列在前"至少要讲到三层--(1) 线程是昂贵资源，先榨干再扩容；(2) 配 core==max + 大队列会让 max 失效，这是最常见的线上"隐性配置错误"；(3) Tomcat 通过重写 offer 反转顺序。讲到第三层才是读过源码的人。

#### 2. 拒绝策略全解

**4 种内置拒绝策略**：

| 策略 | 行为 | 适用场景 | 陷阱 |
|------|------|---------|------|
| AbortPolicy（默认） | 抛 RejectedExecutionException | 快速失败，让上游感知 | 上游未 catch 则任务"静默丢失"+异常日志刷屏 |
| CallerRunsPolicy | 由提交任务的线程自己执行 | 背压降速：拖慢生产者 | 调用者被阻塞（可能是 Tomcat 线程）；shutdown 后任务被 discard |
| DiscardPolicy | 静默丢弃新任务 | 允许丢的旁路任务（如指标采样） | 无感知无日志，出问题查无可查 |
| DiscardOldestPolicy | 丢队首最老任务再重试 offer | 只要最新值的场景（如行情推送） | 老任务无日志被丢；配合优先级队列语义混乱 |

**CallerRunsPolicy 的"背压"价值与陷阱**：

```
价值：
  消费速度 < 生产速度 -> 队列满 -> 生产者线程被拉去干活
  -> 生产者速度被动下降 -> 系统自动达到供需平衡（背压 backpressure）

陷阱 1：调用者是 Tomcat 工作线程 -> Web 线程被占住，整个接口 RT 飙升
陷阱 2：调用者是定时任务单线程 -> 执行期间新触发全部排队
陷阱 3：executor.isShutdown() 时，CallerRuns 直接丢弃（源码里有判断）
```

**自定义拒绝策略：降级落库 + 告警 + 定时补偿（监管上报场景）**：

```java
/**
 * 监管上报拒绝策略：数据是合规数据，绝不能丢
 * 降级链路：内存队列满 -> 落补偿表 -> 定时任务补偿重投 -> 落库也失败 -> 本地文件兜底
 */
public class ReportRejectHandler implements RejectedExecutionHandler {
    @Override
    public void rejectedExecution(Runnable r, ThreadPoolExecutor executor) {
        if (!(r instanceof ReportTask)) {
            throw new RejectedExecutionException("unexpected task: " + r);
        }
        ReportTask task = (ReportTask) r;
        try {
            // 1. 降级：任务快照落补偿表（而不是丢或抛）
            compensationMapper.insert(task.toSnapshot());
            // 2. 告警：带上池子核心指标快照，值班能一眼定位
            alarmClient.send(String.format(
                "[监管上报拒绝] queue=%d/%d, active=%d/%d, bizId=%s",
                executor.getQueue().size(), queueCapacity,
                executor.getActiveCount(), executor.getMaximumPoolSize(),
                task.getBizId()));
            // 3. 打点：拒绝数是大盘核心指标
            metrics.counter("report.pool.reject").increment();
        } catch (Exception e) {
            // 4. 兜底：落库也失败 -> 本地文件 + 最高级告警
            localFileAppender.append(task);
            alarmClient.critical("监管上报补偿落库失败，已转本地文件", e);
        }
    }
}
// 配套：@Scheduled 每 30s 扫补偿表，池子空闲水位低于 50% 时重投
```

**关键认知**：拒绝策略是线程池的"背压阀门"，**选哪种策略取决于"任务能不能丢"**：能丢（指标采样）-> Discard；不能丢但能拖（日志清洗）-> CallerRuns；不能丢也不能拖（监管/交易）-> 自定义落库 + 补偿。

**架构师经验**：生产上最忌讳"默认 Abort + 上游不 catch"和"静默 Discard 无日志"两种配置。**自定义拒绝策略必须做三件事：留数据（落库/落文件）、发告警、打指标**。监管上报案例 1 正是这一改造（Day06 串联会完整展开）。

#### 3. 5 状态状态机与 ctl 打包全解

**ctl 打包**（JDK 源码）：

```java
private final AtomicInteger ctl = new AtomicInteger(ctlOf(RUNNING, 0));
private static final int COUNT_BITS = Integer.SIZE - 3;      // 32 - 3 = 29
private static final int CAPACITY   = (1 << COUNT_BITS) - 1; // 最大线程数 536870911（约 5.36 亿）

// runState 存高 3 位；workerCount 存低 29 位
private static final int RUNNING    = -1 << COUNT_BITS;  // -536870912（111）
private static final int SHUTDOWN   =  0 << COUNT_BITS;  //          0（000）
private static final int STOP       =  1 << COUNT_BITS;  //  536870912（001）
private static final int TIDYING    =  2 << COUNT_BITS;  // 1073741824（010）
private static final int TERMINATED =  3 << COUNT_BITS;  // 1610612736（011）

// 打包与拆包
private static int runStateOf(int c)     { return c & ~CAPACITY; } // 取高 3 位
private static int workerCountOf(int c)  { return c & CAPACITY; }  // 取低 29 位
private static int ctlOf(int rs, int wc) { return rs | wc; }       // 打包
```

```
ctl（32 bit AtomicInteger）
┌─────────────┬───────────────────────────────────┐
│ 高 3 位：runState │ 低 29 位：workerCount          │
│ RUNNING(111)     │ 最大 536870911 个 Worker        │
└─────────────┴───────────────────────────────────┘
一次 CAS（compareAndSetState 式的 ctl CAS）可以同时原子地改状态和线程数
```

**为什么要打包成一个 AtomicInteger**：

1. **原子性**：状态转换往往伴随线程数变化（如 addWorker：先 CAS 线程数 +1 再检查状态），分开存需要两次 CAS，中间有竞态窗口
2. **一次 volatile 读写拿到全貌**：execute / getTask 等热路径只读一次 ctl 就同时知道"状态 + 线程数"
3. **与 Day03 呼应**：ReentrantReadWriteLock 用"高 16 位读 / 低 16 位写"打包一个 int，ThreadPoolExecutor 用"高 3 位状态 / 低 29 位线程数"打包--**JDK 源码反复使用位打包压缩 volatile 变量数量，减少 CAS 竞争面**

**RUNNING 为什么是负数**：状态常量用于 `runStateAtLeast(c, SHUTDOWN)`（即 `c >= SHUTDOWN`）这类数值比较，RUNNING(-536870912) &lt; SHUTDOWN(0) &lt; STOP &lt; TIDYING &lt; TERMINATED，负数 RUNNING 让所有比较都能用 `>=` 一套逻辑表达："数值越大，关闭越深"。

**5 状态状态机**：

```
                    shutdown()                 shutdownNow()
   RUNNING ──────────────────────> SHUTDOWN ────────────────> STOP
      │ 接新任务 + 处理队列任务        │ 不接新 + 处理完队列      │ 不接新 + 不处理队列
      │                            │ 中断"空闲"线程           │ 中断"所有"线程
      │                                 │                        │
      │                                 │ 队列空 且 workerCount==0 │ workerCount==0
      │                                 ▼                        │
      │                              TIDYING <───────────────────┘
      │                                 │ terminated() 钩子执行完毕
      ▼                                 ▼
   （唯一入口）                      TERMINATED
                                     （awaitTermination 返回）
```

| 状态 | 接收新任务 | 处理队列任务 | 中断行为 | 转出条件 |
|------|-----------|-------------|---------|---------|
| RUNNING | 是 | 是 | - | shutdown / shutdownNow |
| SHUTDOWN | 否 | 是（处理完） | 中断空闲 Worker | 队列空 + 线程数 0 -> TIDYING |
| STOP | 否 | 否（drainQueue 取出返回） | 中断所有 Worker | 线程数 0 -> TIDYING |
| TIDYING | 否 | 否 | - | terminated() 钩子执行完 -> TERMINATED |
| TERMINATED | 否 | 否 | - | 终态，termination.signalAll |

**termination Condition（Day03 Condition 串联）**：awaitTermination 在 mainLock 保护下 `termination.awaitNanos(...)`，tryTerminate 成功进入 TERMINATED 前 `termination.signalAll()` 唤醒所有等待者--这正是 Day03 ConditionObject 的标准用法（对应 Object.wait/notify 的升级版）。

**关键认知**：线程池没有"显式 setState(stop)"这种 API，**状态推进靠"事件 + 空闲检测"协作完成**：shutdown 只是改状态 + 中断空闲线程，真正的状态迁移（TIDYING/TERMINATED）由最后一个退出的 Worker 在 processWorkerExit -> tryTerminate 里完成。**关闭是"协商"出来的，不是"命令"出来的**。

#### 4. Worker 与 AQS 不可重入独占锁全解（Day03 串联点）

**Worker 类源码骨架**：

```java
private final class Worker extends AbstractQueuedSynchronizer
                            implements Runnable {
    final Thread thread;            // 工厂创建的线程，执行 this.run()
    Runnable firstTask;             // 首个任务（可能为 null，纯消费型 Worker）
    volatile long completedTasks;

    Worker(Runnable firstTask) {
        setState(-1);               // 关键：初始 state = -1，禁止中断
        this.firstTask = firstTask;
        this.thread = getThreadFactory().newThread(this);
    }

    public void run() { runWorker(this); }

    // ---- 下面就是 Day03 讲的 AQS 模板方法的"子类实现" ----
    protected boolean isHeldExclusively() { return getState() != 0; }

    protected boolean tryAcquire(int unused) {      // 独占获取
        if (compareAndSetState(0, 1)) {
            setExclusiveOwnerThread(Thread.currentThread());
            return true;
        }
        return false;
    }
    protected boolean tryRelease(int unused) {      // 独占释放
        setExclusiveOwnerThread(null);
        setState(0);
        return true;
    }
    public void lock()        { acquire(1); }
    public boolean tryLock()  { return tryAcquire(1); }
    public boolean isLocked() { return isHeldExclusively(); }

    void interruptIfStarted() {   // state >= 0 才允许中断
        Thread t;
        if (getState() >= 0 && (t = thread) != null && !t.isInterrupted()) {
            try { t.interrupt(); } catch (SecurityException ignore) {}
        }
    }
}
```

**Worker 是 Day03 AQS 模板方法的直接应用**：Worker 没有重写 acquire/release 框架方法（那些是 final 的），只重写了 tryAcquire / tryRelease / isHeldExclusively 三个钩子，与 ReentrantLock 的 Sync 写法几乎一致--**"队列 + park + 取消"全部复用 AQS 框架**。

**为什么"故意不可重入"**：

| 角度 | 不可重入（现状） | 可重入（ReentrantLock 方案） |
|------|----------------|---------------------------|
| 空闲判断 | Worker 在执行任务时持锁（state=1）；空闲（在 getTask 的 take/poll 中阻塞）时不持锁（state=0） | 同样可以设计成"任务期持锁" |
| 任务内间接调用 | 任务代码（运行在 Worker 线程里）调用 pool.shutdown() -> interruptIdleWorkers -> w.tryLock()：不可重入锁在同一线程 tryLock **必然失败** -> 正在执行的任务不会被中断 | ReentrantLock 可重入：同线程 tryLock 成功 -> **自己中断了自己正在执行的任务** |
| shutdown 语义 | shutdown 只中断"空闲"Worker，正在执行的任务安全跑完（优雅关闭） | 语义被破坏，shutdown 变相成为 shutdownNow |

**关键认知**：Worker 锁的唯一用途是**表达"忙/闲"状态**，锁本身不保护任何共享数据。`interruptIdleWorkers` 用 `w.tryLock()` 成功与否区分空闲/忙碌，tryLock 成功才 interrupt。不可重入保证了"即使中断请求来自 Worker 自己线程（任务代码里调了 shutdown / setCorePoolSize），正在执行的任务也不会被误中断"。**这是 AQS 不可重入独占语义在 JDK 内部的教科书级应用**（Day03 讲过 AQS 框架本身不限制可重入性，重入是子类实现的语义）。

**setState(-1) 的意图**：Worker 创建时 state = -1（不是 0），`interruptIfStarted` 里 `getState() >= 0` 为 false，**在 runWorker 真正开始执行前，任何 interruptIfStarted 都是空操作**。runWorker 第一行 `w.unlock()` 把 state 从 -1 恢复为 0，从此该 Worker 才"可中断"。这防止"线程刚创建还没开始跑任务就被 shutdown 中断"的窗口期问题。

**架构师经验**：面试被问"Worker 为什么继承 AQS"要答出四层--(1) 复用 AQS 的独占锁语义表达忙/闲；(2) 故意不可重入，防止任务代码内间接触发对自身的中断；(3) state 初值 -1 屏蔽启动前的中断；(4) 这是 AQS"锁语义由子类定义"的灵活性证明。只答"为了用锁"等于没读过源码。

#### 5. execute -> addWorker -> runWorker -> getTask 源码链路全解

**addWorker（三段式：CAS 线程数 -> 加锁入集合 -> 启动线程）**（简化）：

```java
private boolean addWorker(Runnable firstTask, boolean core) {
    retry:
    for (;;) {                              // 外层：检查状态 + CAS 线程数
        int c = ctl.get();
        int rs = runStateOf(c);
        if (rs >= SHUTDOWN &&
            !(rs == SHUTDOWN && firstTask == null && !workQueue.isEmpty()))
            return false;                   // SHUTDOWN 后不接新任务（除非纯消费 Worker）
        for (;;) {
            int wc = workerCountOf(c);
            if (wc >= (core ? corePoolSize : maximumPoolSize) || wc >= CAPACITY)
                return false;               // 超过 core/max 上限
            if (compareAndIncrementWorkerCount(c))   // CAS：线程数 +1（此时线程还没建！）
                break retry;
            // CAS 失败 -> 重读 ctl，状态变了回外层，否则内层重试
        }
    }

    boolean workerStarted = false, workerAdded = false;
    Worker w = new Worker(firstTask);        // 创建 Worker（此时 state=-1）
    final Thread t = w.thread;
    if (t != null) {
        final ReentrantLock mainLock = this.mainLock;   // 全局锁（保护 workers HashSet）
        mainLock.lock();
        try {
            if (workerAdded = 成功入 workers 集合) { ... }
        } finally {
            mainLock.unlock();
        }
        if (workerAdded) {
            t.start();                      // 启动线程 -> runWorker(w)
            workerStarted = true;
        }
    }
    return workerStarted;                   // 失败则回滚线程数（decrementWorkerCount）
}
```

**关键认知**：addWorker "先 CAS 线程数、后真正创建线程"，占住名额再干活，失败回滚--**名额是稀缺资源的预占式管理**。全局 mainLock 只保护 workers HashSet 的入队/出队，热路径（execute/getTask）全靠无锁 CAS。

**runWorker（Worker 的主循环）**（简化）：

```java
final void runWorker(Worker w) {
    Thread wt = Thread.currentThread();
    Runnable task = w.firstTask;
    w.firstTask = null;
    w.unlock();                             // state: -1 -> 0，允许中断（见上文）
    boolean completedAbruptly = true;       // 默认"异常退出"
    try {
        while (task != null || (task = getTask()) != null) {   // 核心循环：取任务
            w.lock();                       // 关键：任务执行期间持不可重入锁 = 标记"忙"
            // 如果池子已 STOP，确保线程被中断（补偿 shutdownNow 语义）
            if (runStateAtLeast(ctl.get(), STOP) && !wt.isInterrupted())
                wt.interrupt();
            try {
                beforeExecute(wt, task);    // 钩子 1（监控埋点入口）
                try {
                    task.run();             // 真正执行任务（不是 start！）
                    afterExecute(task, null);   // 钩子 2
                } catch (Throwable ex) {
                    afterExecute(task, ex);     // 钩子 2（异常路径）
                    throw ex;
                }
            } finally {
                task = null;
                w.completedTasks++;
                w.unlock();                 // 释放锁 = 标记"闲"
            }
        }
        completedAbruptly = false;          // getTask 返回 null，正常退出
    } finally {
        processWorkerExit(w, completedAbruptly);   // 退出处理（可能补员）
    }
}
```

**关键认知**：

1. Worker 线程执行的是 `task.run()`（同步调用），不是 `new Thread(task).start()`--**线程池的线程是"常驻打工人"，任务只是它要跑的一段代码**
2. 任务抛异常 -> runWorker 向上抛 -> Worker 线程死亡 -> processWorkerExit(completedAbruptly=true) -> **池子会补一个新 Worker**（这就是"任务异常导致线程重建"的机制，也是 execute 提交任务异常会打印堆栈、submit 不会的原因：submit 把任务包成 FutureTask，异常存在 Future 里）
3. beforeExecute / afterExecute 是监控扩展点（题目二会用来做 RT 统计）

**getTask（核心线程常驻与非核心回收的分岔口）**（简化）：

```java
private Runnable getTask() {
    boolean timedOut = false;
    for (;;) {
        int c = ctl.get();
        int rs = runStateOf(c);
        if (rs >= SHUTDOWN && (rs >= STOP || workQueue.isEmpty())) {
            decrementWorkerCount();         // 池子关闭且无需处理队列 -> Worker 退出
            return null;
        }
        int wc = workerCountOf(c);

        // ★ 关键判断：本 Worker 是否"可超时回收"
        boolean timed = allowCoreThreadTimeOut || wc > corePoolSize;

        // 超额（wc > max）或（可回收且已超时）且（还有别的 Worker 或队列空）-> 退出
        if ((wc > maximumPoolSize || (timed && timedOut))
                && (wc > 1 || workQueue.isEmpty())) {
            decrementWorkerCount();
            return null;
        }
        try {
            Runnable r = timed
                ? workQueue.poll(keepAliveTime, TimeUnit.NANOSECONDS) // 限时等待 -> 超时返回 null
                : workQueue.take();                                  // 无限阻塞 -> 核心线程"常驻"
            if (r != null) return r;
            timedOut = true;                 // poll 超时 -> 下轮循环走退出分支
        } catch (InterruptedException retry) {
            timedOut = false;                // 被 shutdown/setCorePoolSize 唤醒 -> 重查状态
        }
    }
}
```

**核心线程"常驻"与非核心"超时回收"的实现**：

```
timed = allowCoreThreadTimeOut || workerCount > corePoolSize

场景 A：core=10，当前 10 线程，allowCoreThreadTimeOut=false
        -> timed=false -> 全部 take() 无限阻塞（不耗 CPU，Day03 park）
        -> 核心线程"常驻"（BLOCKED 在 take 上等任务）

场景 B：峰值扩到 20 线程，回落后当前 15 线程（15 > 10）
        -> 5 个"超额"线程走 poll(60s)
        -> 60s 没等到任务 -> poll 返回 null -> timedOut=true -> 下轮 return null
        -> Worker 退出，线程数收缩回 10

场景 C：allowCoreThreadTimeOut=true
        -> 连核心线程也走 poll -> 全池可收缩到 0（低负载省资源，突发时重建）
```

**关键认知**：**"核心/非核心线程"不是两类线程，而是同一个 Worker 在不同 workerCount 下的两种行为**。getTask 每次取任务前都重新计算 timed，线程数一旦回落到 core 以内，剩的都是"事实上的核心"。** interrupt 它们（interruptIdleWorkers 的 tryLock 成功者）会让 take/poll 抛 InterruptedException，getTask 捕获后不是退出而是重查状态--这就是 setCorePoolSize 动态调参能"立即生效"的底层机制（题目二详述）。

**processWorkerExit 的补员逻辑**：Worker 退出时，如果 `completedAbruptly`（异常退出）或当前线程数 &lt; corePoolSize（且队列非空），会 `addWorker(null, false)` 补一个纯消费 Worker--保证池子不会因为一个任务异常而"漏气"。

#### 6. 优雅关闭与阿里规约全解

**shutdown vs shutdownNow vs awaitTermination**：

| 维度 | shutdown() | shutdownNow() | awaitTermination(t, u) |
|------|-----------|---------------|----------------------|
| 状态 | -> SHUTDOWN | -> STOP | 不改状态 |
| 新任务 | 拒绝（isRunning false -> reject） | 拒绝 | - |
| 队列任务 | 继续处理完 | drainQueue 取出并返回（放弃执行） | - |
| 中断 | 仅空闲 Worker（tryLock 成功） | 所有 Worker（interruptIfStarted） | - |
| 返回 | void | List\&lt;Runnable\>（未执行任务） | boolean（是否终止） |
| 场景 | 优雅关闭（默认选择） | 快速放弃（故障止损） | 等待关闭完成 |

**优雅关闭三件套标准姿势**：

```java
// 反例：直接 shutdown 就完事
runtime.addShutdownHook(new Thread(() -> executor.shutdown()));
// 问题：不等待任务完成，进程直接退出，在跑任务被拦腰截断

// 正例：三件套（K8s preStopHook / Spring @PreDestroy 同理）
runtime.addShutdownHook(new Thread(() -> {
    executor.shutdown();                              // 1. 停止接新任务
    try {
        if (!executor.awaitTermination(30, TimeUnit.SECONDS)) {  // 2. 等存量
            List<Runnable> dropped = executor.shutdownNow();     // 3. 超时强关
            log.warn("强制关闭，放弃任务数: {}", dropped.size());
            if (!executor.awaitTermination(10, TimeUnit.SECONDS))
                log.error("线程池未终止");
        }
    } catch (InterruptedException ie) {
        executor.shutdownNow();
        Thread.currentThread().interrupt();
    }
}));
```

**架构师经验**：发布/K8s 滚动更新时，**没做三件套的服务 = 每次发布都在随机丢任务**。监管上报这类"数据不能丢"的服务，强关后还必须把 drainQueue 返回的任务落补偿表。这也是 Day06 串联整合的关键一环。

**Executors 四个工厂被阿里规约禁止的确切原因**：

| 工厂方法 | 隐患配置 | 事故模式 |
|---------|---------|---------|
| newFixedThreadPool(n) | LinkedBlockingQueue（容量 Integer.MAX_VALUE，**无界**） | 下游变慢 -> 生产 > 消费 -> 队列无限堆积 -> **堆内存 OOM**（案例 1 原型） |
| newSingleThreadExecutor | 同上（1 线程 + 无界队列） | 同上，且单线程死亡后有短暂重建窗口 |
| newCachedThreadPool | maximumPoolSize = **Integer.MAX_VALUE** | 突发流量 -> 队列是 SynchronousQueue（不存）-> 无限建线程 -> **线程爆炸**（每线程约 1MB 栈 -> OOM: unable to create new native thread / 栈内存耗尽） |
| newScheduledThreadPool(n) | maximumPoolSize = Integer.MAX_VALUE | 同上 |

**正确姿势（手动 new，全部显式）**：

```java
// 反例（阿里规约禁止）：
ExecutorService pool = Executors.newFixedThreadPool(20);

// 正例：参数显式、队列有界、线程命名、拒绝策略业务化
ThreadPoolExecutor pool = new ThreadPoolExecutor(
        32, 64, 60L, TimeUnit.SECONDS,
        new ArrayBlockingQueue<>(2000),                     // 有界！
        new ThreadFactory() {                               // 命名！jstack 可定位
            private final AtomicInteger seq = new AtomicInteger();
            public Thread newThread(Runnable r) {
                Thread t = new Thread(r, "report-pool-" + seq.incrementAndGet());
                t.setDaemon(false);
                t.setUncaughtExceptionHandler((tt, e) ->
                    log.error("uncaught in {}", tt.getName(), e));
                return t;
            }
        },
        new ReportRejectHandler());                         // 业务化拒绝策略
```

**关键认知**：阿里规约的本质不是"Executors 有 bug"，而是**它替你做了三个必须由业务决策的决定**：队列多大有界、线程上限多少、满了怎么办。这三个参数是**容量治理问题**，不该由工具类用"无限"兜底。

---

## 题目二（线程池参数配置与治理题）：参数配置与治理实战

请详细回答以下问题：

1. **公式法与局限**：CPU 密集 N+1、IO 密集 N*(1+等待时间/计算时间) 两个公式怎么来的？为什么它们在生产上经常失灵（任务异构 / 等待比难估 / 混合负载 / 内存与下游容量约束 / 公式只看 CPU 不看队列）？
2. **Little's Law 与压测法**：Little's Law（L = λ × W）怎么推导线程数（监管上报 1300 QPS × 200ms RT = 260 并发）？压测法定参的标准步骤（逐步加压 -> 观察拐点 -> 关注 RT/线程数/队列水位/下游容量四条曲线）？
3. **动态线程池**：setCorePoolSize / setMaximumPoolSize 运行时生效的原理（增大时的预启动与消费唤醒 / 减小时 interruptIdleWorkers -> getTask 重算 timed -> 超时回收）？为什么先调 max 再调 core（避免 core > max 抛 IllegalArgumentException 的中间态）？结合美团动态线程池实践（配置中心 + 监控 + 告警 + 权限审批）讲讲落地架构？LinkedBlockingQueue 容量是 final 的，动态队列怎么实现（自定义 ResizableCapacityLinkedBlockingQueue）？
4. **队列选型与有界化**：ArrayBlockingQueue vs LinkedBlockingQueue vs SynchronousQueue vs PriorityBlockingQueue vs DelayQueue 在线程池中的行为差异（呼应 Day04）？容量怎么定（放负责的延迟 vs 放不放得住的内存）？
5. **监控核心指标与钩子**：线程池监控的 5 个核心指标（活跃线程数 / 队列水位 / 任务 RT / 拒绝数 / 完成 vs 提交速率）？beforeExecute / afterExecute / terminated 三个钩子怎么用（RT 统计 / submit 任务异常吞没问题）？
6. **线程池隔离**：为什么核心业务与非核心业务必须物理隔离（IM 心跳 vs 消息下发案例）？隔离粒度怎么定？ThreadFactory 命名规范？
7. **线程池打满排查**：jstack 里怎么识别"线程池打满"（getTask 的 take/poll WAITING = 空闲；业务调用栈 BLOCKED/TIMED_WAITING = 任务慢）？排查 SOP（确认画像 -> 定位慢点 -> 判断容量 vs 慢 SQL/下游 -> 扩容或熔断）？

### 作答区

#### 1. 公式法与局限

**两个经典公式**：

```
CPU 密集：threads = NCPU + 1
  （+1：某线程因缺页/偶发暂停时，CPU 不空转）

IO 密集：threads = NCPU * (1 + W/C)
  W = 任务等待时间（IO/锁等待），C = 任务计算时间
  例：8 核，任务 10ms 计算 + 40ms IO 等待
      threads = 8 * (1 + 40/10) = 8 * 5 = 40
```

**公式为什么经常失灵**：

| 局限 | 说明 |
|------|------|
| 任务异构 | 一个池子里混着 5ms 的 Redis 调用和 3s 的医保外呼，W/C 用哪个？算出来的是"平均幻觉" |
| W 难估 | 等待时间随下游负载波动（医保中心高峰 RT 从 1s 涨到 10s），公式定参跟不上 |
| 只管线程不管队列 | 公式只算线程数，队列容量、拒绝策略才是 OOM 的直接开关 |
| 忽略下游容量 | 算出 500 线程，下游 DB 连接池只有 50，多出的 450 全在等连接，线程白白占用 |
| 忽略内存 | 1000 线程 × 1MB 栈 = 1GB 栈内存，加上任务对象堆积，堆外/堆内都可能炸 |

**关键认知**：公式是**起点不是终点**--它给出数量级（IO 密集是 CPU 密集的数倍），最终参数必须由 Little's Law 估 + 压测验证 + 动态调整闭环。

**架构师经验**：面试回答"参数怎么定"直接背公式是初级答案；架构师答案 = "公式估数量级 -> Little's Law 按目标 QPS/RT 算并发 -> 压测找拐点 -> 动态线程池留运营口子 -> 监控 + 告警兜底"五连。

#### 2. Little's Law 与压测法

**Little's Law：L = λ × W**（系统中平均请求数 = 到达速率 × 平均停留时间）：

```
监管上报服务：峰值 λ = 1300 QPS，单任务平均 W = 200ms = 0.2s
-> 需要的并发执行容量 L = 1300 × 0.2 = 260 个"同时在执行的任务"
-> 若每线程同时只执行 1 个任务，则至少需要 260 个线程（不含排队缓冲）

反推验证：core 32 + max 64 + 队列 2000 的池子
-> 最大吞吐 = 线程数 / RT = 64 / 0.2s = 320 QPS << 1300 QPS
-> 结论：靠这个池子扛不住峰值，要么扩线程、要么降 RT（异步化/批量）、要么削峰（MQ）
```

**关键认知**：Little's Law 把"线程数"从拍脑袋变成**由业务指标（QPS × RT）决定**的推导值。同样的公式反过来用：**线程池最大吞吐 = maxThreads / RT**，这就是容量规划的核心恒等式。

**压测法定参标准步骤**：

```
1. 基线：生产流量模型回放（任务类型按比例混合），初始参数用公式/Little 估
2. 逐步加压：QPS 阶梯 25% -> 50% -> 75% -> 100% -> 120% 峰值
3. 每档记录四条曲线：
   a. 任务 RT（P99）          -- 是否陡增（拐点信号）
   b. 活跃线程数              -- 是否长期贴 max
   c. 队列水位                -- 是否持续上涨不回落
   d. 下游指标（DB 连接等待/医保接口 RT/GC） -- 是否被打穿
4. 拐点判定：RT 陡增且队列不落 -> 达到容量上限
5. 定参：取拐点前 70% 负载对应的配置，留 30% 余量
6. 上线后：动态线程池 + 水位告警（70% 预警 / 90% 严重）
```

**架构师经验**：压测最大的坑是**只看自己的 RT 不看下游容量**--单服务压测 5000 QPS 全绿，上线把医保中心/共享 DB 打挂。压测必须在隔离环境或有影子库，且盯下游四件套（连接池 / 中间件 RT / GC / CPU）。

#### 3. 动态线程池

**setCorePoolSize 运行时生效原理**（JDK 源码）：

```java
public void setCorePoolSize(int corePoolSize) {
    if (corePoolSize < 0) throw new IllegalArgumentException();
    if (corePoolSize > this.maximumPoolSize)   // 注意：core 不允许超过 max
        throw new IllegalArgumentException();
    int delta = corePoolSize - this.corePoolSize;
    this.corePoolSize = corePoolSize;
    if (workerCountOf(ctl.get()) > corePoolSize)
        interruptIdleWorkers();                // 变小：中断空闲 Worker
    else if (delta > 0) {
        // 变大：按 min(增量, 队列长度) 预启动 Worker 来消费积压
        int k = Math.min(delta, workQueue.size());
        while (k-- > 0 && addWorker(null, true)) {
            if (workQueue.isEmpty()) break;
        }
    }
}
```

**变大的生效链路**：

```
core 10 -> 32
  ├─ 队列有积压 -> addWorker(null, true) 预启动新 Worker -> 直接开始消费队列
  └─ 队列空    -> 不预启动（避免空转），等流量来时 execute 自然建到新 core
```

**变小的生效链路**（核心：不杀正在干活的线程，靠"自然收缩"）：

```
core 32 -> 10，当前 32 线程
  └─ interruptIdleWorkers()
       ├─ 空闲 Worker（阻塞在 getTask 的 take/poll）被中断
       │    -> InterruptedException -> getTask 捕获 -> timedOut=false 但下轮重算
       │    -> wc(32) > core(10) -> timed=true -> poll(keepAlive) 等待
       │    -> 超时无任务 -> return null -> Worker 退出
       └─ 忙碌 Worker（持 Worker 锁）tryLock 失败 -> 不打断 -> 干完手头再收缩
```

**关键认知**：**动态调参不破坏"正在执行的任务"**--缩小靠"空闲中断 + 超时自然回收"，扩大靠"预启动 + 后续 execute 自然创建"。这背后正是题目一 Worker 锁 + getTask timed 的协作（Day03 park/unpark 机制的工程价值）。

**先调 max 再调 core**：

```java
// 反例：core 从 10 调到 64，但当前 max 还是 32
pool.setCorePoolSize(64);   // IllegalArgumentException! core > max 直接拒绝

// 正例：先抬上限，再抬下限；缩小时反向：先降 core，再降 max
if (newMax > pool.getMaximumPoolSize()) pool.setMaximumPoolSize(newMax);
pool.setCorePoolSize(newCore);
if (newMax < pool.getMaximumPoolSize()) pool.setMaximumPoolSize(newMax);
```

**美团动态线程池实践落地架构**（配置中心 + 监控 + 告警）：

```
┌──────────┐   监听变更    ┌──────────────────┐
│  Nacos    │ ──────────> │ DynamicPoolManager │
│ (线程池配置)│             │  setMax -> setCore │
└──────────┘              │  -> setQueueCap    │
      ↑                   └──────────────────┘
      │ 变更走审批流（防止误操作把 core 调到 10000）
┌──────────┐  5s 采集      ┌──────────────────┐
│ 大盘/告警  │ <────────── │ Metrics（active/  │
│ 70%预警    │              │ queue/reject/RT） │
│ 90%严重    │              └──────────────────┘
└──────────┘
```

**动态队列问题**：LinkedBlockingQueue 的 capacity 是 final，运行时不可改。两种方案：(1) 自定义 ResizableCapacityLinkedBlockingQueue（把 capacity 改为 volatile AtomicInteger，美团开源思路）；(2) 用信号量在入队前限流（伪队列容量）。**注意队列容量改大只是"多放得住"，消费速度不变，改大要同时评估内存和延迟**。

#### 4. 队列选型与有界化（呼应 Day04 BlockingQueue）

| 队列 | 行为 | 在线程池中的效果 | 适用 |
|------|------|----------------|------|
| ArrayBlockingQueue(n) | 有界数组，单锁 | 队列满前不扩线程（JDK 默认语义），满后扩到 max | 通用，内存可控（案例 1 改造选择） |
| LinkedBlockingQueue(n) | 有界链表，两把锁（读写分离） | 同上，吞吐略高于 Array | 高吞吐场景；**必须传 n，不传 = 无界** |
| SynchronousQueue | 0 容量，直交 | 不排队：有空闲线程直接交付，否则立即建线程到 max | "响应优先"（newCachedThreadPool） |
| PriorityBlockingQueue | 无界优先级 | 按优先级执行而非 FIFO | 任务有 SLA 分级（监控告警类） |
| DelayQueue / DelayedWorkQueue | 延迟取出 | 定时/周期任务（ScheduledThreadPoolExecutor 专用） | 重试/定时上报 |

**容量怎么定**：

```
队列容量 = 削峰需要的缓冲量，且必须同时满足：
  1. 内存约束：n × 平均任务对象大小 < 预算（如 2000 × 2KB = 4MB，安全）
  2. 延迟约束：排队延迟 ≈ (队列长度 / 消费速率)，队列越长 P99 越差
     例：64 线程、单任务 200ms -> 消费 320/s -> 队列 2000 意味着最长排队 6.25s
  3. 语义约束：监管上报可容忍分钟级延迟（补偿兜底），IM 心跳几乎不能容忍（几秒即踢线）
```

**关键认知**：**队列容量本质是"延迟换稳定"的旋钮**--容量大抗抖动但延迟差、OOM 风险高；容量小延迟好但易触发拒绝。没有正确答案，只有与拒绝策略联动的选择：**小队列 + 好的拒绝策略（落库补偿）通常优于大队列硬扛**。

#### 5. 监控核心指标与钩子

**5 个核心指标**：

| 指标 | 来源 API | 告警参考 |
|------|---------|---------|
| 活跃线程数 | getActiveCount() / getMaximumPoolSize() | 持续 > 90% max 预警 |
| 队列水位 | getQueue().size() / capacity | > 70% 预警，> 90% 严重 |
| 任务 RT（P99） | before/afterExecute 埋点 | RT 超基线 3 倍 |
| 拒绝数 | 自定义 handler 打点 | > 0 即告警（监管场景） |
| 提交 vs 完成速率 | getTaskCount / getCompletedTaskCount | 持续背离 = 消费不动 |

**钩子实现（RT 统计 + submit 异常吞没问题）**：

```java
public class MonitoredPool extends ThreadPoolExecutor {
    private final ConcurrentHashMap<Runnable, Long> startTime = new ConcurrentHashMap<>();

    @Override
    protected void beforeExecute(Thread t, Runnable r) {
        startTime.put(r, System.nanoTime());
    }

    @Override
    protected void afterExecute(Runnable r, Throwable t) {
        try {
            long rtMs = (System.nanoTime() - startTime.remove(r)) / 1_000_000;
            metrics.timer("pool.rt").update(rtMs);
            if (t == null && r instanceof Future<?>) {
                // 关键坑：submit 提交的任务异常被包进 Future，afterExecute 的 t 永远是 null
                try { ((Future<?>) r).get(0, TimeUnit.MILLISECONDS); }
                catch (ExecutionException ee) { t = ee.getCause(); }   // 拿到真异常
                catch (InterruptedException | TimeoutException ignore) {}
            }
            if (t != null) log.error("task failed in pool", t);
        } finally {
            super.afterExecute(r, t);
        }
    }

    @Override
    protected void terminated() { metrics.unregister("pool.rt"); }  // 关闭时清理
}
```

**关键认知**：**execute 抛出的异常走 afterExecute(task, ex)，submit 抛出的异常藏在 Future 里**（FutureTask.run 捕获后 setException）--不写 `Future.get` 的检查，submit 的异常会"静默消失"，这是生产排障最常见的坑之一（Day07 事故反推会再遇到）。

**架构师经验**：线程池上线"三无"（无命名、无监控、无拒绝告警）等于裸奔。最低标准：jstack 可按名字定位 + 大盘有水位曲线 + 拒绝数 > 0 告警。

#### 6. 线程池隔离

**为什么必须隔离（IM 网关案例 2 原型）**：

```
反例：IM 网关共用一个 IO 线程池（fixed 50）
  消息下发（含调用户服务 RPC，RT 波动 5ms~3s）
  心跳处理（纯内存操作，1ms）
      ↓
  用户服务抖动 RT -> 3s
      ↓
  50 线程全部阻塞在 RPC（active=50=max）
      ↓
  心跳任务进队列排队 -> 心跳超时（服务端 15s 无心跳判定掉线）
      ↓
  服务端批量踢连接 / 客户端重连风暴 -> 长连接"假死"
```

```java
// 正例：按"重要性 + 行为特征"物理隔离
消息下发池：core 32 / max 64 / queue 1000 / 命名 im-push-*
心跳池：    core 4  / max 8  / queue 200  / 命名 im-heartbeat-*（小而快）
系统通知池：core 2  / max 4  / queue 500  / 命名 im-sys-*
// 用户服务 RPC 另加超时(500ms) + 熔断（呼应限流降级周），不让慢下游占住线程
```

**隔离维度**：

| 维度 | 示例 |
|------|------|
| 按重要性 | 核心链路（问诊会话）vs 非核心（数据同步、统计） |
| 按行为特征 | CPU 密集（编解码、报文解析）vs IO 密集（推送、外呼） |
| 按下游 | DB 池 / Redis 池 / 医保外呼池（下游故障不互相传染） |
| 按延迟要求 | 心跳（毫秒级）vs 批量上报（分钟级可容忍） |

**架构师经验**：隔离的本质是**舱壁模式（Bulkhead，呼应 2026年06月第4周限流降级专题）**--故障被限制在一个舱室，不沉整条船。粒度不是越细越好：每个池都有内存/管理成本，按"故障传播路径"切，通常 3~6 个池足够。

#### 7. 线程池打满排查

**jstack 两种典型画像**：

```
画像 A：线程"空闲"（问题不在池子）
"report-pool-3" #41 daemon prio=5 ... waiting on condition
   java.lang.Thread.State: WAITING (parking)
        at jdk.internal.misc.Unsafe.park(Native Method)
        at java.util.concurrent.locks.LockSupport.park(LockSupport.java:342)
        at java.util.concurrent.locks.AbstractQueuedSynchronizer$ConditionObject.await(...)
        at java.util.concurrent.LinkedBlockingQueue.take(LinkedBlockingQueue.java:472)
        at java.util.concurrent.ThreadPoolExecutor.getTask(ThreadPoolExecutor.java:1076)
  -> 线程在 getTask 的 take() 等任务：池子没打满，是上游没流量/提交链路断了

画像 B：线程"全忙且卡在业务调用"（打满实锤）
"im-push-7" #57 prio=5 ... TIMED_WAITING
   java.lang.Thread.State: TIMED_WAITING (parking)
        at jdk.internal.misc.Unsafe.park(Native Method)
        ... SocketRead / httpClient 同步等待
        at com.xxx.user.service.UserServiceClient.getUser(...)   <- 卡在下游 RPC
        at com.xxx.im.push.MessagePushTask.run(MessagePushTask.java:88)
  -> 同类栈帧出现 50 次（= max）且队列水位高：线程被慢下游占满
```

**排查 SOP**：

```
1. 确认画像：jstack / arthas thread | grep 池名
   - 全在 getTask.take/poll -> 空闲，看上游
   - 全在业务栈（RPC/DB/锁）-> 打满，进 2
2. 定位慢点：同类栈帧聚集在哪个调用？-> RPC/慢 SQL/锁竞争（结合 Day02/Day03 分析锁栈）
3. 判断容量 vs 故障：
   - 下游 RT 正常，只是流量涨 -> 容量问题：动态扩 max / 扩容机器
   - 下游 RT 异常 -> 故障问题：加超时 + 熔断降级（呼应限流降级周），扩线程只会打穿下游
4. 应急：非核心池 shutdownNow 止损 + 补偿表回放；核心池扩容
5. 复盘：水位告警为什么没提前触发？-> 补监控
```

**关键认知**：**线程池打满 90% 的根因不是"线程不够"，而是"任务变慢"**（下游抖动/慢 SQL/死锁）。此时盲目调大 max 是最危险的响应--等于对故障中的下游加压。先治慢（超时/熔断），再谈容量（Little's Law）。

---

## 题目三（虚拟线程全解题）：虚拟线程核心原理全解

请详细回答以下问题：

1. **平台线程 vs 虚拟线程全解**：平台线程 1:1 映射内核线程的代价（每线程约 1MB 栈 + 内核调度实体，万级即到顶）？虚拟线程 N:M 模型（N 个虚拟线程复用 M 个载体线程 carrier）？虚拟线程的栈为什么在堆上（初始几百字节~几 KB，按需增长，百万级可行）？JEP 444 的演进史（JDK19 预览 -> JDK21 定稿）？虚拟线程的限制（daemon 不可改 / 优先级固定）？
2. **专用调度器全解**：为什么虚拟线程不用 ForkJoinPool.commonPool（并行流的坑）而用专用调度器？FIFO 模式（asyncMode=true）为什么适合虚拟线程（无剥夺、协作式）？并行度默认 NCPU、maxPoolSize 默认 256、minRunnable，三个参数怎么调（jdk.virtualThreadScheduler.* 系统属性）？载体被钉住时的补偿机制？
3. **mount / unmount 机制全解**：虚拟线程在载体上运行（mount，栈帧在载体线程栈）-> 阻塞点（IO/park/LockSupport）JVM 如何把栈帧"整个搬到堆上的 Continuation/StackChunk 对象"（unmount）-> 载体线程被释放去跑别的虚拟线程 -> 就绪后重新 mount（栈拷回）？这个 Continuation.yield 机制与 Day03 park 的关系？为什么说"虚拟线程把阻塞 IO 的成本从'占一个内核线程'降为'一个堆上对象'"？
4. **pinning（钉住）全解**：什么时候发生 pinning--synchronized 块内阻塞（JDK21 大坑，载体线程被钉住无法释放）与 native/JNI 调用？JDK21 的规避手段（-Djdk.tracePinnedThreads=full 诊断 / synchronized 换 ReentrantLock--呼应 Day02/Day03）？JDK24 JEP 491 如何修复（监视器实现改造，synchronized 不再 pin）？pinning 的实际危害（载体耗尽 -> 全部虚拟线程卡死，比平台线程池打满更隐蔽）？
5. **"不要池化"与 ThreadLocal 全解**：为什么虚拟线程不要池化（池化的前提是"资源昂贵需要复用"，虚拟线程廉价用完即弃，池化反而人为限制并发）？正确姿势 newVirtualThreadPerTaskExecutor + 用 Semaphore 限流保护下游？ThreadLocal 为什么在虚拟线程下要慎用（每个虚拟线程一份 ThreadLocalMap -> 百万线程内存放大；ThreadLocal 缓冲区如 SimpleDateFormat/编解码器复制百万份）？替代方案（无状态工具类 / ScopedValue）？
6. **适用场景与选型决策树**：虚拟线程适合 IO 密集（医保接口外呼、HTTP 并发聚合）不适合 CPU 密集的原因？平台线程 vs 虚拟线程选型决策树（JDK 版本 / 阻塞点是否在 synchronized / 是否需要严格控制资源）？
7. **JDK8 -> JDK21 升级评估**：升级评估要点（依赖链与内部 API 封装 / Spring Boot 3.x / GC 变化 G1/ZGC / 虚拟线程专项改造清单：synchronized 长阻塞扫描、ThreadLocal 审计、池化假设重构 / 回归压测与灰度）？

### 作答区

#### 1. 平台线程 vs 虚拟线程全解

**对比总表**：

| 维度 | 平台线程 | 虚拟线程（JDK21 JEP 444） |
|------|---------|--------------------------|
| 与内核线程关系 | 1:1（每个 Thread 对应一个内核调度实体） | N:M（N 个虚拟线程由 JVM 调度到 M 个载体平台线程） |
| 栈位置 | 线程栈，独立内存区域 | **堆上**（Continuation 挂着的 StackChunk 对象） |
| 栈大小 | 默认约 1MB（-Xss），固定 | 初始几百字节~几 KB，**按需增长收缩** |
| 创建成本 | 微秒级 + 系统调用 | 纳秒~微秒级（普通 Java 对象） |
| 数量级 | 单机数千~一万（受栈内存与内核限制） | **百万级**可行（100w × 几 KB ≈ 几 GB 堆） |
| 调度 | OS 内核抢占式调度 | JVM 协作式（阻塞/让出点切换） |
| daemon / 优先级 | 可设置 | 恒为 daemon、恒 NORM_PRIORITY，不可改 |
| CPU 密集 | 适合 | 无收益（瓶颈在核数，多一层调度反而亏） |
| 典型用法 | 线程池复用 | 每任务新建，用完即弃 |

**演进史**：Project Loom 孵化多年 -> JDK19 JEP 425（首次预览）-> JDK20 JEP 436（二次预览）-> **JDK21 JEP 444（定稿）**；JDK24 JEP 491 解决 synchronized pinning（见下文）。

**创建方式三种**：

```java
// 1. 直接启动
Thread.startVirtualThread(() -> medicareCall());

// 2. Builder（可命名，便于诊断）
Thread vt = Thread.ofVirtual().name("medicare-", 0).start(() -> medicareCall());

// 3. ExecutorService（推荐入口，与现有代码兼容）
ExecutorService vts = Executors.newVirtualThreadPerTaskExecutor();
vts.submit(() -> medicareCall());
```

**关键认知**：虚拟线程的本质是**把"栈"从稀缺的线程栈内存搬到了廉价的堆上，把"调度"从内核搬到 JVM**。线程从"重资源"变成"轻对象"，这是它一切特性的根源。

**架构师经验**：不要把虚拟线程理解为"更快的线程"--单个任务它并不更快（甚至略有开销），它提升的是**吞吐（并发阻塞任务数不再受线程数限制）与代码可读性（同步写法获得异步吞吐）**。

#### 2. 专用调度器全解

**为什么不用 commonPool**：并行流用的 ForkJoinPool.commonPool 是 **LIFO 模式**（工作窃取适合分治计算，子任务最后生成最先执行），而虚拟线程之间无父子关系，需要 **FIFO 排队**；共用会互相干扰（并行流任务与虚拟线程抢载体）。因此 JVM 为虚拟线程创建**专用 ForkJoinPool**：

```java
// 语义等价于（JVM 内部实现）：
ForkJoinPool virtualThreadScheduler = new ForkJoinPool(
        parallelism,          // 默认 NCPU（可用 jdk.virtualThreadScheduler.parallelism 调）
        carrierFactory,       // 载体线程工厂（平台线程，默认命名 "ForkJoinPool-1-worker-*"）
        null,
        true /* asyncMode */  // ★ FIFO 模式：队列任务先进先出，适合独立的虚拟线程
);
// maxPoolSize 默认 256（jdk.virtualThreadScheduler.maxPoolSize）
// minRunnable 默认 1（jdk.virtualThreadScheduler.minRunnable，保证可用性）
```

**协作式调度（无时间片剥夺）**：

```
虚拟线程不会在"计算中途"被调度器抢占--只在明确的切换点让出载体：
  - 阻塞 IO（socket read/write）
  - LockSupport.park / j.u.c 锁等待
  - Thread.sleep / 阻塞队列 take
  - Thread.yield / Continuation.yield
危害：一个死循环计算的虚拟线程会一直占着载体（CPU 密集任务无收益的原因之一）
```

**载体补偿机制**：当载体线程自身被阻塞（如 pinning 场景下载体跟着阻塞在 synchronized 的监视器上），调度器通过 ForkJoinPool 的补偿机制临时创建新载体（受 maxPoolSize=256 上限约束）--这就是 pinning 严重时"256 个载体全部被钉死"的来源。

**关键认知**：**虚拟线程调度器的并行度 = NCPU**，但系统里同时"活着的虚拟线程"可以是百万级--因为在 IO 上阻塞的虚拟线程不占载体（unmount 了）。这正好呼应"IO 密集赚、CPU 密集不赚"：CPU 任务从哪都需要真实核，虚拟线程只是多一层转发。

#### 3. mount / unmount 机制全解

```
mount / unmount 全景图：

虚拟线程 A（执行医保调用）
      │
      ▼ mount：Continuation 的栈帧装载到载体线程 T1 的栈上
┌─────────────────────────────────────────────┐
│ 载体 T1（平台线程）                           │
│   [A 的栈帧：run -> call -> httpRead 阻塞]   │
└─────────────────────────────────────────────┘
      │
      ▼ httpRead 阻塞：JVM 拦截阻塞点
      │ 1. 把 A 的整段栈帧拷贝到堆上的 Continuation/StackChunk 对象（unmount）
      │ 2. 注册"socket 可读事件 -> A 就绪"到轮询器（Poller）
      │ 3. 载体 T1 立即释放，从调度队列取虚拟线程 B mount 执行
      ▼
堆：[A 的 StackChunk（几 KB）]   <-- A"挂起"但只占堆内存，不占任何线程
      │
      ▼ socket 可读事件到达 -> A 入调度队列
      │ 载体 T2（或 T1）mount A：栈帧从堆拷回载体栈，从 httpRead 处继续
      ▼
A 继续执行（对代码完全透明，线程对象还是那个 Thread）
```

**与 Day03 park 的关系**：LockSupport.park 的虚拟线程版本底层就是 `Continuation.yield` + 重新调度--Day03 讲的 AQS 里所有 park 等待（ReentrantLock / Semaphore / 阻塞队列）在虚拟线程上自动变成"yield 出载体"，**j.u.c 全家桶零改造兼容**（这也是 synchronized 之外锁体系反而适合虚拟线程的原因）。

**关键认知**：**虚拟线程把"阻塞"的成本从"占住一个 1MB 的内核线程"降为"一个几 KB 的堆对象 + 一个事件注册"**。这就是百万并发阻塞成为可能的算术基础：100w 阻塞任务 × 几 KB = 几 GB 堆（可控），而不是 100w × 1MB = 1TB 栈（不可能）。

**架构师经验**：理解 mount/unmount 后就能推理出虚拟线程的全部行为边界--什么操作能让它 unmount（j.u.c 阻塞、NIO 改造过的阻塞 API）、什么操作不能（synchronized 内阻塞、native 调用 -> pinning）、为什么 CPU 密集不赚（没有阻塞点就没有 unmount，百万虚拟线程排队在 NCPU 个载体上）。

#### 4. pinning（钉住）全解

**什么时候 pinning**：

```
JDK21 发生 pinning 的两大场景：
  1. synchronized 块/方法内部发生阻塞（含 Object.wait）
     -> 虚拟线程无法 unmount，整个载体线程跟着阻塞在监视器上
  2. native / JNI 调用期间（栈上有本地帧，无法迁移）
```

```java
// 反例（JDK21）：synchronized 内做 IO —— 经典 pinning
Object lock = new Object();
Callable<String> task = () -> {
    synchronized (lock) {
        return httpClient.send(request, BodyHandlers.ofString());  // 阻塞在 synchronized 内
    }   // -> 载体被钉住：这个载体线程无法服务其他虚拟线程
};

// 正例：ReentrantLock 替代（Day03 的锁在虚拟线程时代"翻案"）
ReentrantLock lock = new ReentrantLock();
Callable<String> task = () -> {
    lock.lock();
    try {
        return httpClient.send(request, BodyHandlers.ofString());  // 正常 unmount
    } finally {
        lock.unlock();
    }
};
```

**诊断**：`-Djdk.tracePinnedThreads=full`（打印完整钉住栈）或 `=short`（精简）。JDK24 起改为 `-Djdk.virtualThreadPinningTimeout=...`（超时记录并计时器解除钉住）。

**JDK24 JEP 491 修复**：改造虚拟线程对监视器的获取/等待实现，使 synchronized 不再引起 pinning（虚拟线程可直接在监视器上 unmount/重挂）。JDK21~23 期间只能靠"换 ReentrantLock"规避。

**pinning 的实际危害**：

```
危害链条（比平台线程池打满更隐蔽）：
  医保外呼热路径 5 处 synchronized 内 HTTP 调用
  -> 高峰大量虚拟线程在这些块内阻塞
  -> 载体被钉住，调度器补偿新建载体
  -> 载体到 maxPoolSize(256) 后不再补偿
  -> 后续虚拟线程全部排队等载体
  -> 表现：没有线程爆炸、没有 OOM、没有拒绝，就是"集体变慢"（隐性吞吐塌方）
```

**关键认知**：**平台线程池打满会拒绝/告警（有显性信号），pinning 是"静默劣化"**--所有指标看起来只是 RT 变高，必须靠 tracePinnedThreads 或压测才能发现。这也是"锁选型从性能问题升级为架构问题"的含义（Day02 synchronized vs Day03 ReentrantLock 的对比在 JDK21 语境下有了新的裁决）。

**架构师经验**：JDK21 上虚拟线程前必须做**全量 synchronized 长阻塞扫描**（在 synchronized 块内有 IO/锁等待的代码点），逐个替换为 ReentrantLock 或缩小同步范围。旧的"synchronized 性能已够用"结论在虚拟线程语境下失效。

#### 5. "不要池化"与 ThreadLocal 全解

**为什么不要池化**：

```
池化的前提：资源昂贵（创建开销大 / 数量受限） -> 复用摊薄成本
虚拟线程的现实：创建是普通对象分配（廉价） -> 复用无收益
池化的反作用：
  - 人为限制并发（池大小 = 并发上限，又回到线程数困境）
  - ThreadLocal 残留：复用线程 -> 上一个任务的 ThreadLocal 忘清理 -> 数据串号
正确姿势：
  ExecutorService vts = Executors.newVirtualThreadPerTaskExecutor();  // 每任务一个新虚拟线程
  // "限流"需求不靠池化，靠 Semaphore 保护下游：
  Semaphore medicareLimit = new Semaphore(50);   // 医保中心只允许 50 并发
  vts.submit(() -> {
      medicareLimit.acquire();                   // 阻塞的虚拟线程 unmount，不占载体
      try { return medicareClient.settle(req); }
      finally { medicareLimit.release(); }
  });
```

**关键认知**：**池化线程和限制并发是两件事**。平台线程时代被迫用"池大小"同时承担两个职责（复用 + 限流）；虚拟线程把复用职责废掉，**限流职责交还给 Semaphore**（Day03：state 剩余许可数的那个 AQS 实现）--语义反而更清晰。

**ThreadLocal 为什么慎用**：

```java
// 反例：ThreadLocal 缓冲区在虚拟线程下的内存放大
static final ThreadLocal<SimpleDateFormat> DF =
        ThreadLocal.withInitial(() -> new SimpleDateFormat("yyyy-MM-dd HH:mm:ss"));
// 平台线程池 200 线程 -> 200 份 SimpleDateFormat，没问题
// 虚拟线程 100w 个（每个线程一份 ThreadLocalMap）-> 100w 份 SimpleDateFormat
//   + 100w 个 ThreadLocalMap（每份至少一个 Entry 数组）
//   -> 堆内存放大数 GB，OOM 风险

// 正例 1：无状态线程安全工具
static final DateTimeFormatter DF = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss");

// 正例 2：共享池化缓冲（池化"缓冲区"而不是"线程"）
static final SimplePool<ByteBuffer> BUF_POOL = ...;  // 按需借用归还

// 正例 3（JDK21+ 预览）：ScopedValue -- 绑定作用域，任务结束自动失效，不可变
private static final ScopedValue<UserCtx> CTX = ScopedValue.newInstance();
ScopedValue.where(CTX, userCtx).run(() -> business());  // 作用域内可读，出作用域自动清理
```

**关键认知**：ThreadLocal 的两种用法要分开审视--**"传参上下文"用法（traceId/用户上下文）在虚拟线程下功能仍可用但要防内存放大；"缓冲区复用"用法是明确反模式**（百万线程各复制一份缓冲区），必须改成无状态工具或显式缓冲池。ScopedValue 是官方给的上下文传递替代方向（不可变 + 作用域绑定 + 自动清理）。

**架构师经验**：虚拟线程改造清单里，**ThreadLocal 审计与 synchronized 扫描同等重要**。日志 MDC、日期格式化、编码缓冲区是最常见的三类隐患点。

#### 6. 适用场景与选型决策树

**为什么 IO 密集赚、CPU 密集不赚**：

```
IO 密集（医保外呼，RT 1-3s，其中计算 <5ms）：
  平台线程池：200 线程 -> 吞吐上限 = 200 / 2s = 100 QPS（线程全在等）
  虚拟线程：1000 并发调用同时挂起（unmount），载体只需 NCPU
          -> 吞吐只受下游容量限制（配合 Semaphore 限流 50 并发 = 医保给的配额）

CPU 密集（报文解析，单任务 100ms 纯计算）：
  无论多少虚拟线程，真实并行度 = NCPU
  -> 虚拟线程只是"排队容器"，还多一层 mount/unmount 开销
  -> 结论：平台线程池 threads=NCPU+1 更直接
```

**选型决策树**：

```
任务是否 CPU 密集？
  ├─ 是 -> 平台线程池（threads ≈ NCPU+1）
  └─ 否（IO 密集）-> JDK >= 21 且框架依赖就绪？
          ├─ 否 -> 平台线程池 + Little's Law 定参 + 动态调参治理（题目二方案）
          └─ 是 -> 已扫描 synchronized 长阻塞与 ThreadLocal？
                   ├─ 否 -> 先改造（ReentrantLock / 无状态化）再评估
                   └─ 是 -> 并发规模是否真的需要百万级 / 队列排队严重？
                            ├─ 是 -> 虚拟线程（newVirtualThreadPerTaskExecutor
                            │        + Semaphore 限流下游 + pinning 监控）
                            └─ 否（几十并发内）-> 平台线程池足够，别为新技术加复杂度
```

**架构师经验**：虚拟线程不是银弹，它的收益区间是**"高并发阻塞任务 + 需要同步代码可读性"**。几十并发的场景强行上虚拟线程 + 全套改造，是拿生产系统练手。

#### 7. JDK8 -> JDK21 升级评估

**评估要点清单**：

| 维度 | 检查项 | 风险 |
|------|-------|------|
| 语言/字节码 | JDK11 移除 JavaEE 模块（JAXB/JAX-WS）、内部 API 强封装（JDK17 JEP 403） | 老依赖编译报错；需加依赖或 --add-opens |
| 框架 | Spring Boot 2.x（部分支持到 17）vs 3.x（要求 17+，原生支持虚拟线程） | 升级链：Boot 3 牵动 Spring 6 / Jakarta EE 命名空间（javax->jakarta） |
| 三方库 | cglib/ASM/Javassist/Lombok 的字节码版本、反射神器对内部 API 的依赖 | 运行时 NoSuchMethodError / IllegalAccessError |
| GC | JDK8 默认 Parallel -> JDK21 默认 G1；ZGC 生产可选（呼应 JVM 专题） | 停顿模型变化，参数要重做基线（-XX:+UseG1GC 起步压测） |
| 容器 | cgroup 感知（JDK10+ 原生支持，JDK8 需 8u191+ 且有限） | 容器内存/CPU 限额识别差异 -> 堆/线程数配置漂移 |
| 虚拟线程专项 | synchronized 长阻塞扫描 / ThreadLocal 审计 / 池化假设重构 / pinning 监控 | 不改造就切换 = 静默劣化 |
| 观测 | arthas/线上 agent 对 21 的支持、jstack 对虚拟线程的展示（默认聚合） | 排障工具链要提前演练 |

**灰度路径建议**：非核心服务（如医保外呼网关这类旁路）先升 -> 观测一个容量周期 -> 核心链路灰度按机房/按租户 -> 全量。虚拟线程从"每任务线程"试点模块开始，而不是整站切换。

**关键认知**：JDK8 -> 21 是**跨 13 个大版本**的升级，成本主要不在 JDK 本身，而在**生态链（Boot 3 / Jakarta / 字节码库）与运行时假设（GC 默认值 / 容器感知 / 线程模型）**。虚拟线程只是升级收益之一，评估时要打包决策。

---

## 本日能力差距与补足方向

### 差距 1：execute"队列在前最大线程在后"的设计权衡与踩坑不熟
> Day5发现，延续 Day03 差距2（acquire/release 源码细节不熟）

- **现状**：背得出"core -> 队列 -> max -> 拒绝"四步，但讲不透"为什么队列在前"的设计权衡（线程是昂贵资源先榨干再扩容）；不知道 core==max + 大队列会让 maximumPoolSize 永不生效；没读过 Tomcat TaskQueue 重写 offer 的 hack
- **架构师水平**：能白板写出 execute 完整流程含入队后双重校验（recheck 关闭与零线程补员）；能讲清 Tomcat 反转顺序的动机与实现；能一眼识别"配了 max 但永远不扩"的隐性错误配置
- **补足方向**：精读 ThreadPoolExecutor.execute 源码并写 demo 验证 core=10/max=20/LinkedBlockingQueue(100) 时 max 是否生效；读 Tomcat TaskQueue 源码；整理自己项目里所有线程池配置逐个检查

### 差距 2：ctl 打包与 5 状态状态机转换不熟
> Day5发现，延续 Day03 差距1（AQS 队列与 state 语义）

- **现状**：知道线程池有关闭状态，但 ctl 高 3 位状态 + 低 29 位线程数的打包细节、RUNNING 为负数的比较技巧、TIDYING 的存在意义、"关闭是协商出来的"（tryTerminate 由最后退出的 Worker 推进）都不熟
- **架构师水平**：能默写 ctl 五常量与 runStateOf/workerCountOf/ctlOf；能画出完整状态机图并标注每条边的触发方法；能讲清与 ReentrantReadWriteLock state 打包的同一思想
- **补足方向**：精读 ThreadPoolExecutor 头部注释与 ctl 相关源码；用 jshell 实验位运算；结合 awaitTermination 的 termination Condition（Day03）串讲关闭流程

### 差距 3：Worker 继承 AQS 不可重入锁的设计意图不深
> Day5发现，延续 Day03 差距1（AQS 模板方法与 state）

- **现状**：知道 Worker 继承 AQS，但"故意不可重入"的深意（任务代码内间接 shutdown 时防止中断正在运行的自己）、setState(-1) 屏蔽启动前中断、interruptIdleWorkers 的 tryLock 判空闲逻辑讲不出来
- **架构师水平**：能四层递进讲清 Worker 与 AQS 的关系（复用独占语义/不可重入防自中断/state=-1 屏蔽窗口/锁语义由子类定义）；能用 Worker 的例子反讲 Day03 模板方法模式的灵活性
- **补足方向**：精读 Worker / runWorker / interruptIdleWorkers 源码；写测试复现"任务内调用 shutdown 不会中断当前任务"；把 Worker 作为 Day07 AQS 深挖的重点案例

### 差距 4：线程池参数配置停留在公式层
> Day5发现，延续第4周简历项目差距

- **现状**：参数基本靠"参考别处配置 + 拍脑袋"，CPU 密集 N+1 / IO 密集 N*(1+W/C) 背得出但说不清局限；不会用 Little's Law（L=λ×W）从 QPS 和 RT 推导并发；压测定参没有标准步骤和四条曲线意识
- **架构师水平**：能对监管上报 1300 QPS × 200ms 现场推导 L=260 并发并反推池子最大吞吐=max/RT；能讲清公式五个失灵场景；能主持一次完整的线程池压测定参
- **补足方向**：对问诊系统三个池子（上报/推送/外呼）逐个用 Little's Law 复核现配参数；补一次阶梯压测拿到拐点数据；把"公式->Little->压测->动态调整"四步写成团队规范

### 差距 5：动态线程池与监控治理实践不足
> Day5发现，延续第4周简历项目差距

- **现状**：知道美团有动态线程池文章，但 setCorePoolSize 运行时生效的原理（减小时 interruptIdleWorkers -> getTask 重算 timed -> 超时回收 / 增大时预启动消费积压）讲不清；先调 max 再调 core 的顺序、LinkedBlockingQueue 容量 final 的限制不知道；监控只有零星日志，没有水位/拒绝数/RT 指标
- **架构师水平**：能画出动态线程池落地架构（配置中心+审批+监控+告警）；能讲清 setCorePoolSize/setMaximumPoolSize 生效链路与 Worker 锁/getTask 的配合；能给任意池子 30 分钟内接上五指标监控
- **补足方向**：精读 setCorePoolSize/setMaximumPoolSize 源码；在测试环境实操 Nacos 动态改参并 jstack 观察线程收缩；落地一个 ResizableCapacityLinkedBlockingQueue；把 beforeExecute/afterExecute 埋点接入现有池子

### 差距 6：虚拟线程 pinning 与升级评估深度不足
> Day5发现，延续 Day02 差距6（synchronized vs ReentrantLock 选型）

- **现状**：知道 JDK21 有虚拟线程，但 mount/unmount 的 Continuation 机制、pinning 两大场景（synchronized 内阻塞/native 调用）、-Djdk.tracePinnedThreads 诊断、JDK24 JEP 491 修复内容都停留在名词层；"为什么不要池化"和 ThreadLocal 内存放大讲不透
- **架构师水平**：能画 mount/unmount 全景图讲清"阻塞成本从 1MB 内核线程降到几 KB 堆对象"；能讲清 pinning 的静默劣化链条（载体补偿到 256 后集体变慢）；能输出 JDK8->21 升级评估清单（依赖链/GC/虚拟线程专项/灰度）
- **补足方向**：JDK21 环境写 pinning 复现 demo（synchronized 内 IO + tracePinnedThreads）；读 JEP 444/491 原文；对问诊系统医保外呼模块输出一份虚拟线程改造试点方案（Semaphore 限流 50 并发保护医保中心）

### 差距 7：与简历项目线程池实战的 STAR 结合不足
> Day5发现，延续 Day03 差距7（简历项目 AQS 实战结合深度）

- **现状**：三个核心案例（监管上报无界队列 OOM / IM 网关 IO 池打满长连接假死 / 医保外呼虚拟线程改造评估）只有碎片记忆，没有完整的 S-T-A-R 结构化故事；jstack 画像、应急止损、复盘改进链讲不连贯
- **架构师水平**：每个案例 5 分钟能讲完且经得起三层追问（怎么发现的->根因是什么->为什么这样改->怎么验证的->沉淀了什么规范）；能与 Day02 锁升级、Day03 AQS、Day04 容器、限流降级周的熔断隔离自由串联
- **补足方向**：按梳理文档第六节的三段 STAR 每个演练 5 遍；把案例中的 jstack 片段、参数前后对照表整理进面试速查卡；Day06 串联日把三个案例与全周知识点串成完整场景

---

## 附录：本日关键认知速查

```text
ThreadPoolExecutor 7 参数：
  core / max / keepAlive+unit / workQueue / threadFactory / handler
  阿里规约禁止 Executors 的原因：无界队列 OOM + Integer.MAX_VALUE 线程 OOM

execute 执行顺序（反直觉）：
  workerCount < core -> addWorker(core)
  -> workQueue.offer（队列在前！）
  -> 队列满 -> addWorker(max) -> 仍失败 -> reject
  踩坑：core==max + 大队列 -> maximumPoolSize 永不生效
  Tomcat TaskQueue 重写 offer 返回 false -> 反转顺序（先扩线程再排队）

ctl 打包：一个 AtomicInteger 管两件事
  高 3 位 runState + 低 29 位 workerCount（最大 536870911）
  RUNNING(-536870912) < SHUTDOWN(0) < STOP < TIDYING < TERMINATED
  （数值比较统一用 >=，RUNNING 是负数）

5 状态状态机：
  RUNNING：接新任务 + 处理队列
  SHUTDOWN（shutdown()）：不接新 + 处理完队列 + 中断空闲线程
  STOP（shutdownNow()）：不接新 + 放弃队列（drainQueue）+ 中断所有线程
  TIDYING：队列空且线程数 0
  TERMINATED：terminated() 钩子完成（termination.signalAll）
  关闭是"协商"出来的：最后退出的 Worker 在 tryTerminate 推进状态

Worker 与 AQS（Day03 串联点）：
  Worker 继承 AQS 实现不可重入独占锁，锁不保护数据，只表达"忙/闲"
  不可重入：任务代码内间接 shutdown -> tryLock 失败 -> 不会中断正在跑的自己
  setState(-1)：runWorker 之前禁止中断；w.unlock() 恢复 0
  interruptIdleWorkers：tryLock 成功（空闲）才 interrupt

runWorker 主循环：
  while (firstTask != null || (task = getTask()) != null)
    w.lock() -> beforeExecute -> task.run() -> afterExecute -> w.unlock()
  任务异常 -> Worker 死亡 -> processWorkerExit 补员
  submit 的异常藏在 Future 里，afterExecute 需 Future.get 才拿得到

getTask 关键：
  timed = allowCoreThreadTimeOut || wc > corePoolSize
  timed -> poll(keepAlive)（超时回收）；非 timed -> take()（核心常驻）
  核心/非核心不是两类线程，是同一 Worker 的两种状态
  setCorePoolSize 缩小 -> interruptIdleWorkers -> take 被中断 -> 重算 timed -> 自然收缩

优雅关闭三件套：
  shutdown() -> awaitTermination(30s) -> 超时 shutdownNow() + drainQueue 落补偿

参数配置方法论：
  公式（CPU:N+1 / IO:N*(1+W/C)）-> 只能给数量级
  Little's Law：L = λ × W（1300 QPS × 0.2s = 260 并发）
  反推吞吐：maxThreads / RT = 最大 QPS
  压测四曲线：RT / active / 队列水位 / 下游指标；定参留 30% 余量
  动态调参顺序：先抬 max 再抬 core（core > max 抛 IllegalArgumentException）

线程池治理：
  五指标：active / 队列水位 / RT / 拒绝数 / 提交完成速率
  三无裸奔：无命名、无监控、无拒绝告警
  隔离 = 舱壁模式：按重要性/行为/下游/延迟切，3~6 个池
  打满排查：90% 根因是"任务变慢"不是"线程不够"，先治慢再扩容
  jstack 画像：getTask.take/park = 空闲；业务栈 TIMED_WAITING 聚集 = 被下游占满

虚拟线程（JDK21 JEP 444）：
  平台线程 1:1 内核线程（1MB 栈）vs 虚拟线程 N:M 载体（堆上栈几 KB）
  专用 ForkJoinPool 调度器：FIFO 模式（asyncMode=true），并行度=NCPU，max 256
  mount/unmount：阻塞点把栈帧搬到堆上 Continuation，载体立即释放
    阻塞成本：1MB 内核线程 -> 几 KB 堆对象
  pinning（JDK21 大坑）：synchronized 内阻塞 / native 调用
    诊断 -Djdk.tracePinnedThreads=full；规避换 ReentrantLock
    JDK24 JEP 491 修复（synchronized 不再 pin）
  不要池化：线程廉价用完即弃；限流交给 Semaphore（保护下游）
  ThreadLocal 慎用：百万线程内存放大；缓冲区复用是反模式
  IO 密集赚（外呼/HTTP 聚合），CPU 密集无收益（真实并行度=NCPU）
  决策树：CPU 密集->平台池；IO 密集+JDK21+已扫描 pinning->虚拟线程
```
