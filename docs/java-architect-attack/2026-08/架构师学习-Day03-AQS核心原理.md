# 架构师学习-Day03-AQS 核心原理

> 日期：2026年08月12日（周三）
> 周主题：并发编程专题 - JMM / synchronized 锁升级 / AQS / 并发容器 / 线程池 / 虚拟线程
> 出题日：Day03 - AQS 核心原理

---

## 背景

经过 Day01 JMM 和 Day02 synchronized 锁升级，本周进入 AQS（AbstractQueuedSynchronizer）核心原理专题。Day02 讲完 synchronized 后，自然的对比是：**ReentrantLock / ReentrantReadWriteLock / Semaphore / CountDownLatch / CyclicBarrier 这些"显式同步器"是怎么实现的？** 答案就是 AQS。

AQS 是 Doug Lea 在 JDK 5 引入的"同步器框架"，是 Java 并发包（JUC）的基石。理解 AQS 后，所有 JUC 同步器（ReentrantLock / ReentrantReadWriteLock / StampedLock 不基于 AQS / Semaphore / CountDownLatch / CyclicBarrier / ReentrantLock 等）的源码都能贯通。

架构师面试官最爱问的不是"AQS 是什么"，而是：

> "AQS 的 CLH 队列为什么用变体（MCS -> CLH 变体）？传统 CLH 有什么问题？"
> "AQS 独占模式的 acquire 流程？为什么先 tryAcquire 再入队？"
> "AQS 的 Condition 等待队列与 EntryList 的关系？为什么 await/signal 必须持锁？"
> "ReentrantLock 的公平 vs 非公平在 AQS 层的差异？为什么默认非公平？"

这些问题答不出来，ReentrantLock / Semaphore / CountDownLatch 的"功能"会用，但"原理"是黑盒，无法在性能调优和故障排查时定位问题。本周 Day03 把 AQS 一次性梳理清楚，Day04 进入并发容器（基于 AQS），Day05 线程池（基于 AQS），Day06 串联整合，Day07 深挖 AQS 源码与生产事故反推。

**Day03 为什么是"AQS 核心原理"而不是"并发容器"**：

1. **AQS 是 JUC 的基石**：ReentrantLock / Semaphore / CountDownLatch / CyclicBarrier / ReentrantReadWriteLock 都基于 AQS；并发容器（ConcurrentHashMap）也有 AQS 思想
2. **AQS 是面试高频**：BAT 等大厂面试必问 AQS 源码，CLH 队列 / state / CAS / Condition 是标准追问
3. **AQS 设计模式是架构师必修**：AQS 用"模板方法模式"分离"同步状态管理"与"同步器语义"，是设计模式与并发编程结合的经典案例
4. **AQS 与 Day02 synchronized 对比**：synchronized 是 JVM 内置锁，AQS 是 Java 层框架；对比两者是理解"显式锁"的关键

**与往周专题的衔接点**：

- **Day01 JMM happens-before** vs **AQS 监视器锁规则**：AQS 的 unlock 操作 happens-before 后续 lock 操作，与 synchronized 一样遵循 JMM
- **Day02 synchronized ObjectMonitor** vs **AQS CLH 队列**：synchronized 用 ObjectMonitor（EntryList / WaitSet），AQS 用 CLH 队列 + Condition 队列--两者结构相似但实现不同
- **JVM GC（第1周 Day03）** vs **AQS Node 节点**：AQS Node 用 next / prev 指针构成双向链表，与 G1 SATB 在 GC 标记阶段的处理有关
- **Day02 park/unpark** vs **AQS LockSupport**：AQS 用 LockSupport.park / unpark 阻塞 / 唤醒线程，与 synchronized 的 park/unpark 同源

**与简历项目的衔接点**：

在线问诊系统的 AQS 三大重灾区：

1. **IM 网关在线用户列表的读写锁选型**：10w+ 用户的 UserMap，读多写少（查询 100w QPS，上下线 100 QPS），用 ReentrantReadWriteLock 还是 StampedLock？
2. **视频问诊房间号限流的 Semaphore**：视频问诊 SFU 单机最大 1000 路，用 Semaphore 控制并发路数
3. **问诊订单批量生成的 CountDownLatch**：批量生成 1000 个订单，用 CountDownLatch 等所有订单生成完成

---

## 题目一（AQS 全解题）：AQS 核心原理全解

请详细回答以下问题：

1. **AQS 设计全解**：AQS 的核心思想是什么（同步队列 + state + 模板方法模式）？AQS 的 state 字段为什么用 volatile int（CAS + volatile 保证原子 + 可见性）？state 在 ReentrantLock / Semaphore / CountDownLatch 中分别表示什么？AQS 的 CLH 队列变体与传统 CLH 的差异（双向链表 / 显式 park 而非自旋）？Node 节点的 waitStatus 5 种状态（CANCELLED / SIGNAL / CONDITION / PROPAGATE / 0）的含义？为什么 AQS 是"模板方法模式"（子类重写 tryAcquire / tryRelease / tryAcquireShared / tryReleaseShared）？
2. **独占模式 acquire / release 全解**：acquire(int arg) 的完整流程（tryAcquire -> addWaiter -> acquireQueued -> selfInterrupt）？为什么先 tryAcquire 再入队（乐观假设：可能直接成功，避免队列开销）？addWaiter 的"快速尝试 + 自旋入队"逻辑？acquireQueued 的自旋逻辑（前驱是 head 则再试 tryAcquire，否则 park）？shouldParkAfterFailedAcquire 的作用（设置前驱 waitStatus=SIGNAL）？parkAndCheckInterrupt 的 park 与中断响应？release 的流程（tryRelease -> unparkSuccessor）？为什么 release 要从尾到头找第一个有效节点（next 指针可能未设置）？
3. **共享模式 acquireShared / releaseShared 全解**：acquireShared 的流程（tryAcquireShared -> doAcquireShared）？tryAcquireShared 返回值的 3 种含义（负数失败 / 0 成功但不传播 / 正数成功且传播）？doAcquireShared 与 acquireQueued 的差异（传播逻辑 setHeadAndPropagate）？为什么共享模式需要"传播"（唤醒后继共享节点，如 Semaphore 多个许可）？releaseShared 的流程（tryReleaseShared -> doReleaseShared）？CountDownLatch 的 tryAcquireShared 实现（state == 0 才返回 1）？Semaphore 的 tryAcquireShared 实现（state > 0 则 CAS 减 1）？
4. **Condition 全解**：Condition 与 Object.wait/notify 的区别（多个等待队列 / 可中断 / 超时 / 不要求持锁）？ConditionObject 的数据结构（firstWaiter / lastWaiter 单链表）？await 的流程（addConditionWaiter -> release fully -> park -> 检查 SIGNAL / 在同步队列则 acquire）？signal 的流程（firstWaiter -> transferForSignal -> 入同步队列 -> unpark）？为什么 await/signal 必须持锁（操作 Condition 队列需线程安全）？awaitNanos 的超时精度（精度约 1ms）？为什么 Condition 队列是单链表而同步队列是双向链表（Condition 队列只需 FIFO，不需要反向遍历）？
5. **公平 vs 非公平全解**：ReentrantLock 的公平 vs 非公平在 AQS 层的差异（hasQueuedPredecessors 检查）？为什么默认非公平（性能高 5-10 倍 + 避免唤醒开销）？非公平锁的"插队"行为（新线程直接 tryAcquire，不检查队列）？公平锁的"严格 FIFO"（hasQueuedPredecessors 检查队列是否有前驱）？什么场景必须用公平锁（防止饥饿 / 严格顺序）？ReentrantReadWriteLock 的公平 vs 非公平（写锁饥饿问题）？
6. **三大锁对比 ReentrantLock / ReentrantReadWriteLock / StampedLock**：ReentrantLock 的实现（state 高 16 位无 / 低 16 位重入数）？ReentrantReadWriteLock 的实现（state 高 16 位读 / 低 16 位写）？读锁释放的难点（多个读者各自减 1，CAS 失败重试）？写锁饥饿问题（读多写少时写锁可能永远拿不到）？StampedLock 为什么不基于 AQS（性能优化 / 乐观读不阻塞）？StampedLock 的 state 64 bit 用法（高 56 位版本号 / 低 8 位锁状态）？

### 作答区

#### 1. AQS 设计全解

**AQS 的核心思想**：

AQS = AbstractQueuedSynchronizer，用"同步队列 + state 字段 + 模板方法模式"构建同步器：

```
┌────────────────────────────────────────────────┐
│  AQS                                            │
│                                                │
│  state（volatile int）                         │
│    - ReentrantLock：重入次数                   │
│    - Semaphore：剩余许可数                     │
│    - CountDownLatch：未完成计数                │
│    - ReentrantReadWriteLock：高16位读 / 低16位写│
│                                                │
│  CLH 队列变体（双向链表）                      │
│    - head（哨兵节点）                          │
│    - tail                                      │
│                                                │
│  模板方法模式                                  │
│    - 子类重写 tryAcquire / tryRelease 等       │
│    - AQS 负责 acquire / release 框架           │
└────────────────────────────────────────────────┘
```

**state 为什么用 volatile int**：

```java
private volatile int state;
```

- **volatile**：保证可见性（一个线程修改 state，其他线程立即可见）
- **int**：32 位足够存储大多数同步器状态（重入次数 / 许可数 / 计数）
- **CAS**：通过 `Unsafe.compareAndSwapInt` 保证原子更新

**state 在各同步器中的含义**：

| 同步器 | state 含义 | 初值 |
|--------|----------|------|
| ReentrantLock | 重入次数（0 未锁 / N 重入 N 次） | 0 |
| Semaphore | 剩余许可数 | N（构造传入） |
| CountDownLatch | 未完成计数（减到 0 才放行） | N（构造传入） |
| ReentrantReadWriteLock | 高 16 位读锁数 / 低 16 位写锁重入数 | 0 |
| CyclicBarrier | 不基于 AQS（用 ReentrantLock + Generation） | - |

**AQS 的 CLH 队列变体**：

传统 CLH 队列（Craig, Landin, Hagersten）：

```
单向链表 + 自旋等待前驱
Thread A -> Thread B -> Thread C
  ↑          ↑
  自旋等待   自旋等待
```

**问题**：

1. 自旋消耗 CPU
2. 单向链表无法反向遍历
3. 节点只能"隐式"传递状态

**AQS 的 CLH 变体**：

```
双向链表 + park 阻塞（不自旋）
head <-> Thread A <-> Thread B <-> Thread C <- tail
                                    ↑
                                  park
```

**关键差异**：

| 维度 | 传统 CLH | AQS CLH 变体 |
|------|---------|-------------|
| 链表方向 | 单向 | 双向 |
| 等待方式 | 自旋 | park 阻塞 |
| 节点状态 | 隐式（看前驱） | 显式（waitStatus） |
| 取消处理 | 难 | Node.cancelled 标记 |

**Node 节点的 waitStatus 5 种状态**：

```java
static final class Node {
    static final int CANCELLED =  1;  // 节点因超时 / 中断被取消
    static final int SIGNAL    = -1;  // 后继节点需要 unpark
    static final int CONDITION = -2;  // 在 Condition 等待队列
    static final int PROPAGATE = -3;  // 共享模式传播
    static final int INITIAL    =  0;  // 初始状态
}
```

| 状态 | 含义 | 设置时机 |
|------|------|---------|
| CANCELLED (1) | 节点取消 | 超时 / 中断 |
| SIGNAL (-1) | 后继需 unpark | 入队时设置前驱 |
| CONDITION (-2) | 在 Condition 队列 | await 时 |
| PROPAGATE (-3) | 共享传播 | releaseShared 时 |
| 0 | 初始 | 节点创建 |

**关键认知**：正数表示"已取消"，负数表示"有效状态"。`waitStatus <= 0` 是有效节点。

**为什么 AQS 是"模板方法模式"**：

AQS 把"同步器"分成两部分：

| AQS 负责（不变部分） | 子类负责（可变部分） |
|--------------------|-------------------|
| 队列管理（入队 / 出队） | tryAcquire（独占获取） |
| 阻塞 / 唤醒（park / unpark） | tryRelease（独占释放） |
| 中断响应 | tryAcquireShared（共享获取） |
| 超时处理 | tryReleaseShared（共享释放） |
| 取消处理 | isHeldExclusively（是否独占） |

**架构师经验**：AQS 的"模板方法模式"是设计模式教科书级别的实践。子类只需实现"如何获取 / 释放"，不需要管"队列 + 阻塞 + 中断 + 取消"。**架构师设计自己的同步器时，可以继承 AQS 而非从零实现**。

#### 2. 独占模式 acquire / release 全解

**acquire(int arg) 完整流程**：

```java
public final void acquire(int arg) {
    if (!tryAcquire(arg) &&
        acquireQueued(addWaiter(Node.EXCLUSIVE), arg))
        selfInterrupt();
}
```

**4 个步骤**：

```
1. tryAcquire(arg)
   - 子类实现的"快速获取"
   - 成功 -> 直接返回，不入队
   - 失败 -> 进入步骤 2

2. addWaiter(Node.EXCLUSIVE)
   - 创建独占模式 Node，加入队列尾部

3. acquireQueued(node, arg)
   - 自旋获取（前驱是 head 则再试 tryAcquire）
   - 失败 -> park 阻塞
   - 被唤醒 -> 重试

4. selfInterrupt()
   - 如果 acquireQueued 期间被中断，补上中断标志
   - AQS 不响应中断（acquire），但保留中断状态
```

**为什么先 tryAcquire 再入队**：

```java
// AQS 的设计
if (!tryAcquire(arg) && acquireQueued(...))

// 反例（错误设计）：先入队
acquireQueued(addWaiter(...), arg)
```

**原因**：

1. **乐观假设**：多数情况下锁可能直接获取成功（如刚释放），入队开销大
2. **避免队列开销**：tryAcquire 是 CAS，成功只需 100 ns；入队需要创建 Node + CAS tail，约 1 μs
3. **性能优化**：非公平锁的设计核心--新线程先抢，抢不到再入队

**addWaiter 的"快速尝试 + 自旋入队"逻辑**：

```java
private Node addWaiter(Node mode) {
    Node node = new Node(Thread.currentThread(), mode);
    // 快速尝试：直接 CAS 加入尾部
    Node pred = tail;
    if (pred != null && compareAndSetTail(pred, node)) {
        pred.next = node;
        return node;
    }
    enq(node);  // 快速失败 -> 自旋入队
    return node;
}

private Node enq(final Node node) {
    for (;;) {  // 自旋
        Node t = tail;
        if (t == null) {  // 队列为空，初始化 head
            if (compareAndSetHead(new Node()))
                tail = head;
        } else {  // 加入尾部
            node.prev = t;
            if (compareAndSetTail(t, node)) {
                t.next = node;
                return t;
            }
        }
    }
}
```

**关键认知**：addWaiter 用"乐观 + 自旋"模式，快速路径 CAS 成功率高（>90%），失败回退到自旋。

**acquireQueued 的自旋逻辑**：

```java
final boolean acquireQueued(final Node node, int arg) {
    boolean failed = true;
    try {
        boolean interrupted = false;
        for (;;) {
            final Node p = node.predecessor();  // 前驱
            if (p == head && tryAcquire(arg)) {  // 前驱是 head 且获取成功
                setHead(node);
                p.next = null;  // help GC
                failed = false;
                return interrupted;
            }
            if (shouldParkAfterFailedAcquire(p, node) &&  // 决定是否 park
                parkAndCheckInterrupt())  // park
                interrupted = true;
        }
    } finally {
        if (failed)
            cancelAcquire(node);
    }
}
```

**关键认知**：

1. 只有"前驱是 head"才尝试 tryAcquire（FIFO 顺序）
2. 失败后 shouldParkAfterFailedAcquire 决定是否 park
3. park 后被唤醒，重新进入自旋

**shouldParkAfterFailedAcquire 的作用**：

```java
private static boolean shouldParkAfterFailedAcquire(Node pred, Node node) {
    int ws = pred.waitStatus;
    if (ws == Node.SIGNAL)
        // 前驱已设 SIGNAL，可以安全 park
        return true;
    if (ws > 0) {
        // 前驱取消，跳过所有取消节点
        do {
            node.prev = pred = pred.prev;
        } while (pred.waitStatus > 0);
        pred.next = node;
    } else {
        // 前驱是 0 或 PROPAGATE，设为 SIGNAL
        compareAndSetWaitStatus(pred, ws, Node.SIGNAL);
    }
    return false;
}
```

**关键认知**：park 前必须确保前驱 waitStatus = SIGNAL，否则可能"park 后无人唤醒"。

**parkAndCheckInterrupt 的 park 与中断响应**：

```java
private final boolean parkAndCheckInterrupt() {
    LockSupport.park(this);  // 阻塞
    return Thread.interrupted();  // 返回中断状态并清除
}
```

**关键认知**：

- park 会被"unpark / 中断 / 超时"唤醒
- 返回 Thread.interrupted() 清除中断标志，所以需要 selfInterrupt() 补上
- acquire 不响应中断（继续等待），acquireInterruptibly 才响应

**release 的流程**：

```java
public final boolean release(int arg) {
    if (tryRelease(arg)) {  // 子类实现的释放
        Node h = head;
        if (h != null && h.waitStatus != 0)
            unparkSuccessor(h);  // 唤醒后继
        return true;
    }
    return false;
}

private void unparkSuccessor(Node node) {
    int ws = node.waitStatus;
    if (ws < 0)
        compareAndSetWaitStatus(node, ws, 0);  // 清除状态

    Node s = node.next;
    if (s == null || s.waitStatus > 0) {
        // next 为空或取消，从尾到头找第一个有效节点
        s = null;
        for (Node t = tail; t != null && t != node; t = t.prev)
            if (t.waitStatus <= 0)
                s = t;
    }
    if (s != null)
        LockSupport.unpark(s.thread);  // 唤醒
}
```

**为什么 release 要从尾到头找第一个有效节点**：

```java
// 反例（错误）：从头找
Node s = node.next;
if (s != null && s.waitStatus <= 0)
    LockSupport.unpark(s.thread);

// 正例：从尾到头找
for (Node t = tail; t != null && t != node; t = t.prev)
    if (t.waitStatus <= 0)
        s = t;
```

**原因**：addWaiter 中 `compareAndSetTail(pred, node)` 后才设置 `pred.next = node`，中间有窗口期，next 可能未设置。从尾到头遍历 prev（双向链表的 prev 一定设置完整），避免遗漏。

**架构师经验**：AQS 的设计充满了"双向链表"的工程考量。**双向链表的核心价值是支持"从尾遍历"，这是单向链表做不到的**。

#### 3. 共享模式 acquireShared / releaseShared 全解

**acquireShared 的流程**：

```java
public final void acquireShared(int arg) {
    if (tryAcquireShared(arg) < 0)
        doAcquireShared(arg);
}
```

**tryAcquireShared 返回值的 3 种含义**：

| 返回值 | 含义 |
|--------|------|
| 负数 | 获取失败，需要入队 |
| 0 | 获取成功，但不传播（无后续许可 / 计数） |
| 正数 | 获取成功，且需要传播（有更多许可 / 计数） |

**关键认知**：独占模式 tryAcquire 只返回 boolean，共享模式 tryAcquireShared 返回 int 表示"传播"信息。

**doAcquireShared 与 acquireQueued 的差异**：

```java
private void doAcquireShared(int arg) {
    final Node node = addWaiter(Node.SHARED);  // 共享节点
    boolean failed = true;
    try {
        boolean interrupted = false;
        for (;;) {
            final Node p = node.predecessor();
            if (p == head) {
                int r = tryAcquireShared(arg);
                if (r >= 0) {
                    setHeadAndPropagate(node, r);  // 关键：传播
                    p.next = null;
                    if (interrupted)
                        selfInterrupt();
                    failed = false;
                    return;
                }
            }
            if (shouldParkAfterFailedAcquire(p, node) &&
                parkAndCheckInterrupt())
                interrupted = false;
        }
    } finally {
        if (failed)
            cancelAcquire(node);
    }
}
```

**关键差异**：setHeadAndPropagate 替代 setHead，多了"传播唤醒"逻辑。

**setHeadAndPropagate 的传播逻辑**：

```java
private void setHeadAndPropagate(Node node, int propagate) {
    Node h = head;
    setHead(node);
    if (propagate > 0 || h == null || h.waitStatus < 0 ||
        (h = head) == null || h.waitStatus < 0) {
        Node s = node.next;
        if (s == null || s.isShared())
            doReleaseShared();  // 唤醒后继共享节点
    }
}
```

**为什么共享模式需要"传播"**：

Semaphore 的场景：100 个许可，1000 个线程等待

```
线程 A 释放 1 个许可
  ↓
唤醒线程 B（acquireShared 成功，剩 0 个许可）
  ↓
线程 B 不传播（剩余 0，propagate = 0）
  ↓
其他 998 个线程继续 park

线程 A 释放 100 个许可
  ↓
唤醒线程 B（acquireShared 成功，剩 99 个许可）
  ↓
线程 B 传播（propagate > 0），唤醒线程 C
  ↓
线程 C 传播（propagate > 0），唤醒线程 D
  ↓
... 直到 propagate = 0
```

**关键认知**：传播机制让"批量释放"高效，避免每次释放都从头唤醒。

**releaseShared 的流程**：

```java
public final boolean releaseShared(int arg) {
    if (tryReleaseShared(arg)) {
        doReleaseShared();
        return true;
    }
    return false;
}

private void doReleaseShared() {
    for (;;) {
        Node h = head;
        if (h != null && h != tail) {
            int ws = h.waitStatus;
            if (ws == Node.SIGNAL) {
                if (!compareAndSetWaitStatus(h, Node.SIGNAL, 0))
                    continue;
                unparkSuccessor(h);  // 唤醒后继
            } else if (ws == 0 &&
                       !compareAndSetWaitStatus(h, 0, Node.PROPAGATE))
                continue;
        }
        if (h == head)  // head 未变，退出
            break;
    }
}
```

**CountDownLatch 的 tryAcquireShared 实现**：

```java
// CountDownLatch.Sync
protected int tryAcquireShared(int acquires) {
    return (getState() == 0) ? 1 : -1;
    // state == 0（计数清零）才返回 1（成功 + 传播）
    // 否则返回 -1（失败，入队）
}
```

**Semaphore 的 tryAcquireShared 实现**：

```java
// Semaphore.NonfairSync
protected int tryAcquireShared(int acquires) {
    return nonfairTryAcquireShared(acquires);
}

final int nonfairTryAcquireShared(int acquires) {
    for (;;) {
        int available = getState();
        int remaining = available - acquires;
        if (remaining < 0 ||
            compareAndSetState(available, remaining))
            return remaining;
        // remaining >= 0 返回剩余许可（成功 + 传播）
        // remaining < 0 返回负数（失败，入队）
    }
}
```

**架构师经验**：CountDownLatch 与 Semaphore 的 tryAcquireShared 实现差异，体现了 AQS 框架的灵活性--同一框架，不同语义。

#### 4. Condition 全解

**Condition 与 Object.wait/notify 的区别**：

| 维度 | Object.wait/notify | Condition |
|------|-------------------|-----------|
| 依赖 | synchronized（任意对象） | Lock（显式锁） |
| 等待队列数 | 1（对象的 WaitSet） | 多（每个 Condition 一个队列） |
| 中断响应 | 是（抛 InterruptedException） | 可选（await vs awaitUninterruptibly） |
| 超时 | wait(ms) | awaitNanos / await(time, unit) / awaitUntil |
| 截止时间 | 不支持 | awaitUntil(date) |
| 不要求持锁 | 否（必须先 synchronized） | 否（必须先 lock） |

**ConditionObject 的数据结构**：

```java
public class ConditionObject implements Condition {
    private transient Node firstWaiter;  // 队首
    private transient Node lastWaiter;   // 队尾
    // 单链表：firstWaiter -> ... -> lastWaiter
}
```

**await 的流程**：

```java
public final void await() throws InterruptedException {
    if (Thread.interrupted())
        throw new InterruptedException();
    Node node = addConditionWaiter();          // 1. 加入 Condition 队列
    int savedState = fullyRelease(node);       // 2. 完全释放锁（重入次数清零）
    int interruptMode = 0;
    while (!isOnSyncQueue(node)) {             // 3. 不在同步队列则 park
        LockSupport.park(this);
        if ((interruptMode = checkInterruptWhileWaiting(node)) != 0)
            break;
    }
    if (acquireQueued(node, savedState) &&     // 4. 重新获取锁
        interruptMode != THROW_IE)
        interruptMode = REINTERRUPT;
    if (node.nextWaiter != null)
        unlinkCancelledWaiters();
    if (interruptMode != 0)
        reportInterruptAfterWait(interruptMode);
}
```

**5 个步骤**：

1. **addConditionWaiter**：创建 Node（CONDITION 状态），加入 Condition 队列尾部
2. **fullyRelease**：完全释放锁（包括重入次数），保存 savedState
3. **park**：阻塞，等待 signal 或中断
4. **acquireQueued**：被 signal 后，进入同步队列，重新获取锁
5. **reportInterruptAfterWait**：处理中断

**signal 的流程**：

```java
public final void signal() {
    if (!isHeldExclusively())
        throw new IllegalMonitorStateException();  // 必须持锁
    Node first = firstWaiter;
    if (first != null)
        doSignal(first);
}

private void doSignal(Node first) {
    do {
        if ((firstWaiter = first.nextWaiter) == null)
            lastWaiter = null;
        first.nextWaiter = null;
    } while (!transferForSignal(first) &&  // 转移到同步队列
             (first = firstWaiter) != null);
}

final boolean transferForSignal(Node node) {
    if (!compareAndSetWaitStatus(node, Node.CONDITION, 0))
        return false;
    Node p = enq(node);  // 加入同步队列
    int ws = p.waitStatus;
    if (ws > 0 || !compareAndSetWaitStatus(p, ws, Node.SIGNAL))
        LockSupport.unpark(node.thread);  // 唤醒
    return true;
}
```

**为什么 await/signal 必须持锁**：

```java
// signal 必须持锁
public final void signal() {
    if (!isHeldExclusively())
        throw new IllegalMonitorStateException();
    // ...
}
```

**原因**：

1. **线程安全**：操作 Condition 队列（firstWaiter / lastWaiter）需要线程安全
2. **避免丢失唤醒**：如果不持锁，await 在"判断条件 + park"之间可能被 signal 唤醒，但 park 还没开始，造成"丢失唤醒"
3. **业务语义**：signal 通常基于条件（如"队列非空"），检查条件需要持锁保证一致性

**awaitNanos 的超时精度**：

```java
public final long awaitNanos(long nanosTimeout) throws InterruptedException {
    long deadline = System.nanoTime() + nanosTimeout;
    // ...
    while (!isOnSyncQueue(node)) {
        if (nanosTimeout <= 0L) {
            transferAfterCancelledWait(node);  // 超时，转移到同步队列
            break;
        }
        if (nanosTimeout > spinForTimeoutThreshold)  // 1000 ns
            LockSupport.parkNanos(this, nanosTimeout);
        // ...
    }
}
```

**精度约 1ms**：

- spinForTimeoutThreshold = 1000 ns（1 μs）
- 小于 1 μs 时自旋，避免 park 开销大于等待时间
- 实际精度受 OS 调度器影响，约 1-10 ms

**为什么 Condition 队列是单链表而同步队列是双向链表**：

| 维度 | 同步队列 | Condition 队列 |
|------|---------|---------------|
| 链表类型 | 双向 | 单向 |
| 反向遍历 | 需要（unparkSuccessor 从尾找） | 不需要 |
| 取消处理 | 复杂（CAS prev/next） | 简单（unlink nextWaiter） |
| 节点状态 | 多种（SIGNAL / PROPAGATE / CANCELLED） | 单一（CONDITION / CANCELLED） |

**关键认知**：Condition 队列只需 FIFO 入队 + signal 出队，不需要反向遍历，单链表更简单高效。

#### 5. 公平 vs 非公平全解

**ReentrantLock 的公平 vs 非公平在 AQS 层的差异**：

```java
// 非公平锁
static final class NonfairSync extends Sync {
    final void lock() {
        if (compareAndSetState(0, 1))  // 直接 CAS 抢
            setExclusiveOwnerThread(Thread.currentThread());
        else
            acquire(1);
    }

    protected final boolean tryAcquire(int acquires) {
        return nonfairTryAcquire(acquires);
    }
}

final boolean nonfairTryAcquire(int acquires) {
    final Thread current = Thread.currentThread();
    int c = getState();
    if (c == 0) {
        if (compareAndSetState(0, acquires)) {  // 不检查队列，直接 CAS
            setExclusiveOwnerThread(current);
            return true;
        }
    } else if (current == getExclusiveOwnerThread()) {
        int nextc = c + acquires;
        if (nextc < 0) throw new Error("Maximum lock count exceeded");
        setState(nextc);  // 重入
        return true;
    }
    return false;
}

// 公平锁
static final class FairSync extends Sync {
    final void lock() {
        acquire(1);  // 不直接 CAS，走 acquire 流程
    }

    protected final boolean tryAcquire(int acquires) {
        final Thread current = Thread.currentThread();
        int c = getState();
        if (c == 0) {
            if (!hasQueuedPredecessors() &&  // 关键：检查队列
                compareAndSetState(0, acquires)) {
                setExclusiveOwnerThread(current);
                return true;
            }
        } else if (current == getExclusiveOwnerThread()) {
            int nextc = c + acquires;
            if (nextc < 0) throw new Error("Maximum lock count exceeded");
            setState(nextc);
            return true;
        }
        return false;
    }
}
```

**核心差异**：公平锁 tryAcquire 多了 `hasQueuedPredecessors()` 检查。

**hasQueuedPredecessors 的实现**：

```java
public final boolean hasQueuedPredecessors() {
    Node t = tail;
    Node h = head;
    Node s;
    return h != t &&
           ((s = h.next) == null || s.thread != Thread.currentThread());
}
```

**3 种返回 false 的情况**（无前驱）：

1. `h == t`：队列为空（或仅 head 哨兵）
2. `h.next.thread == currentThread`：当前线程就是队列第一个

**为什么默认非公平**：

1. **性能高 5-10 倍**：非公平锁新线程直接 CAS，避免入队 + park + unpark 开销
2. **避免唤醒开销**：公平锁必须等队首线程被唤醒（1-10 μs），非公平锁新线程直接抢（100 ns）
3. **吞吐优先**：业务场景中"严格 FIFO"通常不是必需，吞吐更重要

**非公平锁的"插队"行为**：

```
时刻 T1：线程 A 持有锁
时刻 T2：线程 B 尝试 acquire，失败，入队，park
时刻 T3：线程 A 释放锁，unpark(B)
时刻 T4：线程 C 尝试 acquire，直接 CAS 成功（插队）
时刻 T5：线程 B 被唤醒，发现锁又被 C 拿了，重新 park
```

**关键认知**：非公平锁的"插队"在 T3-T4 之间发生--B 还没被唤醒（unpark 有延迟），C 直接 CAS 抢走。

**公平锁的"严格 FIFO"**：

```
时刻 T1：线程 A 持有锁
时刻 T2：线程 B 尝试 acquire，hasQueuedPredecessors 返回 false（队列空），但 CAS 失败（A 持有），入队，park
时刻 T3：线程 A 释放锁，unpark(B)
时刻 T4：线程 C 尝试 acquire，hasQueuedPredecessors 返回 true（B 在队列），不入队直接失败，acquire 流程入队，park
时刻 T5：线程 B 被唤醒，CAS 成功，拿到锁
```

**什么场景必须用公平锁**：

1. **防止饥饿**：长任务场景，避免某线程永远拿不到锁
2. **严格顺序**：业务要求按申请顺序处理（如交易系统）
3. **可预测性**：调试 / 测试场景需要可预测的锁分配

**ReentrantReadWriteLock 的公平 vs 非公平**：

```java
// 公平锁：写锁饥饿问题
// 如果队列中有读线程等待，新写线程必须等待
// 如果队列中有写线程等待，新读线程必须等待
// 结果：读多写少时，写锁可能永远拿不到

// 非公平锁：写锁可"插队"
// 如果队列中没有写线程等待，新读线程可以插队
// 但仍可能写锁饥饿（持续有读线程插队）
```

**架构师经验**：ReentrantReadWriteLock 的"公平 vs 非公平"选择更复杂。**多数场景用非公平，但要注意写锁饥饿**。如果写锁饥饿严重，用 StampedLock 替代。

#### 6. 三大锁对比 ReentrantLock / ReentrantReadWriteLock / StampedLock

**ReentrantLock 的实现**：

state 高 16 位无 / 低 16 位重入数：

```
state (32 bit)
┌─────────────────────────────────┐
│  高 16 位（未用）│ 低 16 位（重入数）│
└─────────────────────────────────┘

- state == 0：未锁
- state == 1：持有 1 次
- state == 2：重入 2 次
- state == N：重入 N 次
```

**ReentrantReadWriteLock 的实现**：

state 高 16 位读 / 低 16 位写：

```
state (32 bit)
┌─────────────────────────────────┐
│  高 16 位（读锁数）│ 低 16 位（写锁重入数）│
└─────────────────────────────────┘

- 写锁：state & 0xFFFF（低 16 位）
- 读锁：state >>> 16（高 16 位）
- 写锁独占，读锁共享
```

**读锁释放的难点**：

```java
// 读锁释放
protected final boolean tryReleaseShared(int unused) {
    Thread current = Thread.currentThread();
    ThreadLocalHoldCounter rh = cachedHoldCounter;
    if (rh == null || rh.tid != getThreadId(current))
        rh = readHolds.get();
    if (rh.count == 0)
        readHolds.remove();
    if (rh.decrementAndGet() == 0)
        return false;
    for (;;) {
        int c = getState();
        int nextc = c - SHARED_UNIT;  // 高 16 位减 1
        if (compareAndSetState(c, nextc))  // CAS 可能失败
            return nextc == 0;  // 完全释放才返回 true
    }
}
```

**难点**：

1. 多个读者各自减 1，CAS 可能失败（其他读者同时释放）
2. 失败后重试，直到 CAS 成功
3. 与独占锁的"单线程修改 state"不同，读锁释放涉及多线程

**写锁饥饿问题**：

```
读多写少场景（读 100w QPS，写 100 QPS）：
  - 写线程 A 申请写锁
  - 队列中有读线程 B / C / D
  - 公平锁：A 等 B / C / D 释放
  - 但新读线程 E / F / G 不断到来（非公平可插队）
  - A 可能永远拿不到写锁（饥饿）
```

**解决方案**：

1. 用 StampedLock（乐观读不阻塞写）
2. 用写锁优先策略（如 WriteLockFirst）
3. 用读写分离设计（如 CopyOnWriteArrayList）

**StampedLock 为什么不基于 AQS**：

1. **性能优化**：AQS 的 Node 入队 + park 开销大，StampedLock 乐观读无需入队
2. **乐观读不阻塞**：AQS 不支持"乐观读"语义
3. **state 64 bit**：StampedLock 用 64 bit state（高 56 位版本号 / 低 8 位锁状态），AQS 是 32 bit

**StampedLock 的 state 64 bit 用法**：

```
state (64 bit)
┌──────────────────────────────────────────────┐
│  高 56 位（版本号）  │  低 8 位（锁状态）    │
└──────────────────────────────────────────────┘

低 8 位：
  - 第 0 位：写锁（WBIT）
  - 第 7 位：乐观读标志（OBIT）
  - 其他位：读锁计数

版本号：每次写锁释放 +1，乐观读 validate 时检查版本号是否变化
```

**关键认知**：StampedLock 用版本号实现"乐观读"--读时记录版本号，使用前 validate 检查版本号是否变化，变化则升级为悲观读。

**架构师经验**：三大锁各有适用场景：

- **ReentrantLock**：通用独占锁
- **ReentrantReadWriteLock**：读多写少 + 需要重入 / Condition
- **StampedLock**：读多写少 + 不需要重入 / Condition + 性能优先

---

## 本日能力差距与补足方向

### 差距 1：AQS CLH 队列变体与传统 CLH 的差异不熟
> Day3发现，延续 Day02 差距4（ObjectMonitor）

- **现状**：知道 AQS 用 CLH 队列，但 AQS 的 CLH 变体与传统 CLH 的差异（双向链表 / park 阻塞 / 显式 waitStatus）不熟；Node 的 waitStatus 5 种状态（CANCELLED / SIGNAL / CONDITION / PROPAGATE / 0）的设置时机不深
- **架构师水平**：能不查文档画出 AQS 双向链表结构图；能讲清 CLH 变体的 4 大改进（双向 / park / 显式状态 / 取消处理）；能用 jstack 实测 AQS 队列状态
- **补足方向**：精读 OpenJDK `AbstractQueuedSynchronizer.java` 源码；调研 MCS 锁与传统 CLH 的差异；用 JOL 实测 AQS Node 内存布局

### 差距 2：acquire / release 源码细节不熟
> Day3发现，延续 Day02 差距3（轻量级锁 CAS）

- **现状**：知道 acquire 流程，但 addWaiter 的"快速尝试 + 自旋入队"、acquireQueued 的自旋逻辑、shouldParkAfterFailedAcquire 的作用、release 从尾到头找的工程原因不深
- **架构师水平**：能背出 acquire 的 4 步流程；能讲清 shouldParkAfterFailedAcquire 的 3 种情况（SIGNAL / CANCELLED / 其他）；能讲清 release 从尾到头找的原因（next 指针可能未设置）
- **补足方向**：精读 OpenJDK `acquire.java` 源码；用 jstack 实测 BLOCKED 线程的 AQS 队列状态；用 jcstress 复现 AQS 入队竞态

### 差距 3：共享模式"传播"机制不深
> Day3发现

- **现状**：知道共享模式与独占模式的区别，但 tryAcquireShared 返回值的 3 种含义、setHeadAndPropagate 的传播逻辑、CountDownLatch vs Semaphore 的 tryAcquireShared 实现差异不深
- **架构师水平**：能讲清"传播"机制的工程价值（批量释放高效）；能讲清 CountDownLatch 的 tryAcquireShared（state == 0 返回 1）vs Semaphore 的（state > 0 CAS 减 1）；能为不同业务场景设计同步器
- **补足方向**：精读 CountDownLatch / Semaphore / CyclicBarrier 源码；实现自定义同步器（如 SimpleSemaphore）；用 jcstress 测试传播机制

### 差距 4：Condition 的 await/signal 实现不熟
> Day3发现，延续 Day02 差距4（ObjectMonitor WaitSet）

- **现状**：知道 Condition 替代 Object.wait/notify，但 ConditionObject 的数据结构（单链表 firstWaiter / lastWaiter）、await 的 5 步流程、signal 的 transferForSignal 实现不熟；"为什么 await/signal 必须持锁"的工程原因不深
- **架构师水平**：能画 ConditionObject 单链表结构图；能讲清 await 的 5 步（addConditionWaiter / fullyRelease / park / acquireQueued / reportInterrupt）；能讲清为什么 Condition 队列是单链表而同步队列是双向链表
- **补足方向**：精读 OpenJDK `ConditionObject.java` 源码；用 ReentrantLock + Condition 实现生产者-消费者；调研 awaitNanos 的超时精度

### 差距 5：公平 vs 非公平的工程权衡不深
> Day3发现，延续 Day02 差距6（synchronized vs ReentrantLock 选型）

- **现状**：知道公平锁 vs 非公平锁的区别，但 AQS 层的差异（hasQueuedPredecessors）、非公平锁"插队"的具体时机（unpark 延迟期间）、ReentrantReadWriteLock 的写锁饥饿问题不深
- **架构师水平**：能讲清 hasQueuedPredecessors 的 3 种返回 false 情况；能讲清非公平锁性能高 5-10 倍的原因（避免唤醒开销）；能为不同业务场景选公平 / 非公平锁
- **补足方向**：用 JMH 实测公平 vs 非公平锁在 4 / 8 / 16 线程下的性能；调研 LinkedIn 公平锁实践；实现自定义公平锁

### 差距 6：StampedLock 的 64 bit state 与版本号机制不深
> Day3发现，延续 Day02 差距6（synchronized vs ReentrantLock 选型）

- **现状**：知道 StampedLock 性能比 ReentrantReadWriteLock 高 5-10 倍，但 StampedLock 为什么不基于 AQS、64 bit state 的分配（高 56 位版本号 / 低 8 位锁状态）、乐观读 validate 的实现机制不深
- **架构师水平**：能讲清 StampedLock 不基于 AQS 的 3 大原因（性能 / 乐观读语义 / 64 bit state）；能讲清乐观读 validate 的版本号机制；能用 StampedLock 重构 IM 网关的 UserMap
- **补足方向**：精读 OpenJDK `StampedLock.java` 源码；用 jcstress 测试 StampedLock 乐观读的可见性；调研 StampedLock 在生产中的坑（不可重入 / 不支持 Condition）

### 差距 7：与简历项目 AQS 实战结合的深度不足
> Day3发现，延续第4周简历项目差距

- **现状**：能讲 AQS 概念，但与简历项目（在线问诊系统）3 个 AQS 场景（IM UserMap 读写锁 / 视频 SFU Semaphore / 订单批量 CountDownLatch）的完整 STAR 故事不熟；IM 网关 10w UserMap 用 ReentrantReadWriteLock 写锁饥饿的事故故事讲不生动
- **架构师水平**：能用 STAR 法则结构化讲述 3 个 AQS 案例；能从案例反推架构改进点（如 StampedLock 替代 ReadWriteLock / 用 LongAdder 替代 AtomicLong）；能在面试中 10 分钟讲清 2 个案例
- **补足方向**：本周 Day05 实战日产出 3 个完整 AQS 案例；用 JMH 实测 IM UserMap 的 ReentrantReadWriteLock vs StampedLock 性能；用 STAR 法则演练 5 次面试讲述

---

## 附录：本日关键认知速查

```text
AQS 三大核心：
  - state（volatile int + CAS）
  - CLH 队列变体（双向链表 + park）
  - 模板方法模式（子类重写 tryAcquire / tryRelease）

state 在各同步器中的含义：
  - ReentrantLock：重入次数（0 / N）
  - Semaphore：剩余许可数
  - CountDownLatch：未完成计数
  - ReentrantReadWriteLock：高 16 位读 / 低 16 位写

Node waitStatus 5 种状态：
  - CANCELLED (1)：取消
  - SIGNAL (-1)：后继需 unpark
  - CONDITION (-2)：在 Condition 队列
  - PROPAGATE (-3)：共享传播
  - 0：初始

独占模式 acquire 流程：
  tryAcquire -> addWaiter -> acquireQueued -> selfInterrupt

独占模式 release 流程：
  tryRelease -> unparkSuccessor（从尾到头找有效节点）

共享模式 tryAcquireShared 返回值：
  - 负数：失败，入队
  - 0：成功，不传播
  - 正数：成功，传播

Condition await 5 步：
  addConditionWaiter -> fullyRelease -> park -> acquireQueued -> reportInterrupt

公平 vs 非公平：
  - 公平：hasQueuedPredecessors 检查
  - 非公平：直接 CAS（默认，性能高 5-10 倍）

三大锁：
  - ReentrantLock：state 低 16 位重入数
  - ReentrantReadWriteLock：state 高 16 位读 / 低 16 位写
  - StampedLock：不基于 AQS，64 bit state（高 56 版本 / 低 8 锁状态）

StampedLock：
  - 乐观读，性能高 5-10 倍
  - 不可重入 / 不支持 Condition
  - 适用：读多写少 + 不需重入
```
