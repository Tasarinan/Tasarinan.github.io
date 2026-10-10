# 架构师学习-Day03-AQS 核心原理-梳理

> 日期：2026年08月12日（周三）
> 周主题：并发编程专题 - JMM / synchronized 锁升级 / AQS / 并发容器 / 线程池 / 虚拟线程
> 梳理日：Day03 - 架构师视角梳理

---

## 一、架构师视角下的 AQS

### 1.1 不只是"框架"，是"同步器设计语言"

很多工程师把 AQS 当成"ReentrantLock 的实现细节"就完了。架构师视角下，AQS 是**同步器设计语言**：

| 架构决策 | AQS 提供的能力 |
|---------|--------------|
| 自定义同步器 | 继承 AQS + 重写 tryAcquire / tryRelease |
| 独占 vs 共享 | acquire / acquireShared 两套流程 |
| 公平 vs 非公平 | hasQueuedPredecessors 模板方法 |
| 等待 / 唤醒 | Condition + LockSupport.park/unpark |
| 中断响应 | acquireInterruptibly / acquire 与中断状态 |
| 超时 | tryAcquireNanos / doAcquireNanos |

如果不懂 AQS 的设计语言，所有 JUC 同步器（ReentrantLock / Semaphore / CountDownLatch / CyclicBarrier）都是"黑盒"，无法自定义同步器。

### 1.2 AQS 的本质：把"同步器"抽象成"状态机"

AQS 把同步器抽象成**状态机**：

```
state（状态字段）
  ↓ CAS 修改
  ↓
队列管理（CLH 队列）
  ↓ acquire / release
  ↓
阻塞 / 唤醒（LockSupport.park/unpark）
  ↓
中断 / 超时（响应式 API）
```

**关键认知**：所有同步器都是"状态机 + 队列 + 阻塞"的组合，AQS 把这些不变部分抽取出来，子类只实现"如何修改状态"。

### 1.3 AQS 与 synchronized 的对比哲学

AQS（显式锁）与 synchronized（内置锁）是**两种哲学**：

| 维度 | synchronized | AQS（ReentrantLock） |
|------|--------------|--------------------|
| 实现层 | JVM 内置（C++） | Java 层（JDK） |
| 状态存储 | 对象头 Mark Word | AQS 的 state 字段 |
| 队列 | ObjectMonitor EntryList | AQS CLH 队列 |
| 阻塞 | ObjectMonitor park | LockSupport.park |
| 优化 | JVM 自动（锁升级 / 锁消除） | 程序员显式（tryLock / 超时） |
| 扩展性 | 无法自定义 | 模板方法模式 |
| 性能 | JDK 6+ 接近 AQS | JDK 6+ 接近 synchronized |

**架构师思维**：synchronized 是"JVM 优化优先"，AQS 是"程序员控制优先"。**两者不是替代关系，是互补关系**。

### 1.4 AQS 的"零成本抽象"理想

AQS 设计的初心是"零成本抽象"--**让框架处理通用部分，子类只写语义**：

```java
// 子类只需写这 5 个方法
protected boolean tryAcquire(int arg);
protected boolean tryRelease(int arg);
protected int tryAcquireShared(int arg);
protected boolean tryReleaseShared(int arg);
protected boolean isHeldExclusively();

// AQS 框架处理
acquire / acquireInterruptibly / acquireNanos
acquireShared / acquireSharedInterruptibly / tryAcquireSharedNanos
release / releaseShared
队列管理 / 阻塞唤醒 / 中断响应 / 超时处理
```

**架构师经验**：AQS 是设计模式教科书级别的"模板方法模式"实践。**架构师设计自己的框架时，可以借鉴 AQS 的"不变 + 可变"分离思路**。

---

## 二、AQS 设计：模板方法模式的工程价值

### 2.1 模板方法模式的工程实现

AQS 的模板方法模式：

```
┌─────────────────────────────────────────────┐
│  AQS（抽象类）                              │
│                                             │
│  模板方法（final，不可重写）：              │
│    acquire / acquireShared                  │
│    release / releaseShared                  │
│    acquireInterruptibly / acquireNanos      │
│                                             │
│  钩子方法（protected，子类重写）：          │
│    tryAcquire / tryRelease                  │
│    tryAcquireShared / tryReleaseShared      │
│    isHeldExclusively                        │
└─────────────────────────────────────────────┘
              ↑
              │ extends
┌─────────────────────────────────────────────┐
│  Sync（自定义同步器）                       │
│    重写 tryAcquire / tryRelease            │
│    实现 state 语义                          │
└─────────────────────────────────────────────┘
```

**关键认知**：模板方法是 final（不可重写），保证框架不变；钩子方法是 protected（可重写），让子类定制语义。

### 2.2 AQS 与子类的"契约"

AQS 与子类有明确的"契约"：

| AQS 负责 | 子类负责 |
|---------|---------|
| 队列管理（入队 / 出队 / 取消） | tryAcquire：如何获取锁 |
| 阻塞 / 唤醒（park / unpark） | tryRelease：如何释放锁 |
| 中断响应 | tryAcquireShared：共享获取 |
| 超时处理 | tryReleaseShared：共享释放 |
| CAS state（提供 getState / setState / compareAndSetState） | isHeldExclusively：是否独占 |
| LockSupport.park / unpark | 业务逻辑（条件判断 / 状态更新） |

**架构师经验**：AQS 的契约让"同步器设计"变成"业务语义实现"。**架构师设计自定义同步器时，只需思考"如何修改 state"，不需要管"队列 + 阻塞"**。

### 2.3 AQS 的"乐观假设"设计

AQS 的 acquire 流程体现"乐观假设"设计：

```java
public final void acquire(int arg) {
    if (!tryAcquire(arg) &&              // 1. 乐观：先尝试直接获取
        acquireQueued(addWaiter(...), arg))  // 2. 失败才入队
        selfInterrupt();
}
```

**关键认知**：

- 多数情况下 tryAcquire 直接成功（如刚释放的锁）
- 入队是"失败回退"，不是"必经路径"
- 这种"乐观 + 回退"设计是高性能框架的常见模式

### 2.4 AQS 的"双向链表"工程价值

AQS 用双向链表而非单向链表，工程价值在于：

| 场景 | 单向链表 | 双向链表 |
|------|---------|---------|
| 入队（tail 追加） | O(1) | O(1) |
| 出队（head 移除） | O(1) | O(1) |
| 取消节点（中间删除） | O(n)（从头找前驱） | O(1)（直接通过 prev） |
| 反向遍历 | 不支持 | 支持（unparkSuccessor 从尾找） |
| 内存开销 | 1 个指针 | 2 个指针 |

**关键认知**：AQS 双向链表的核心价值是"取消节点 + 反向遍历"。**unparkSuccessor 从尾到头找"是为了避免"next 指针未设置"的竞态**。

### 2.5 AQS 的"内存语义"与 JMM

AQS 通过 volatile state + CAS 建立 happens-before 关系：

```java
// state 是 volatile
private volatile int state;

// CAS 修改 state
protected final boolean compareAndSetState(int expect, int update) {
    return unsafe.compareAndSwapInt(this, stateOffset, expect, update);
}
```

**内存语义**：

1. **tryAcquire 成功**：CAS 修改 state，建立 happens-before（前序修改可见）
2. **tryRelease 成功**：volatile 写 state，刷主内存
3. **后续 tryAcquire 读 state**：volatile 读，从主内存取

**架构师经验**：AQS 的内存语义遵循 JMM 的"监视器锁规则"--unlock hb 后续 lock。**这就是为什么 ReentrantLock 与 synchronized 在 JMM 层面等价**。

---

## 三、CLH 队列变体：双向链表的工程考量

### 3.1 传统 CLH vs AQS CLH 变体

| 维度 | 传统 CLH | AQS CLH 变体 |
|------|---------|-------------|
| 链表方向 | 单向 | 双向 |
| 等待方式 | 自旋（看前驱状态） | park 阻塞 |
| 节点状态 | 隐式（看前驱） | 显式（waitStatus 字段） |
| 取消处理 | 难（单向链表难删除中间节点） | 简单（双向链表 O(1)） |
| 适用场景 | 短临界区（自旋开销小） | 长临界区（避免 CPU 浪费） |
| 公平性 | 严格 FIFO | 严格 FIFO（公平锁） |

**关键认知**：AQS CLH 变体的核心改进是"park 阻塞 + 双向链表"，让长临界区场景不浪费 CPU。

### 3.2 AQS 队列的"哨兵节点"设计

AQS 的 head 是哨兵节点，不存线程：

```
┌────────────────────────────────────────────────┐
│  AQS 队列                                      │
│                                                │
│  head（哨兵） <-> Thread A <-> Thread B <- tail│
│   ↑                                             │
│   不存线程，仅占位                             │
└────────────────────────────────────────────────┘
```

**为什么需要哨兵节点**：

1. **简化边界处理**：head.next 一定是第一个等待线程，不需要特判
2. **状态传递**：head.waitStatus = SIGNAL 表示"后继需要 unpark"
3. **取消处理**：head 不会取消（哨兵无业务含义）

**架构师经验**：哨兵节点是链表设计的常见技巧，**用空间换简单**。

### 3.3 acquireQueued 的"前驱是 head 才尝试"设计

```java
final boolean acquireQueued(final Node node, int arg) {
    boolean failed = true;
    try {
        boolean interrupted = false;
        for (;;) {
            final Node p = node.predecessor();
            if (p == head && tryAcquire(arg)) {  // 关键：前驱是 head
                setHead(node);
                p.next = null;
                failed = false;
                return interrupted;
            }
            // ...
        }
    } finally {
        if (failed)
            cancelAcquire(node);
    }
}
```

**为什么"前驱是 head 才尝试"**：

1. **FIFO 保证**：只有队首线程才能获取锁
2. **避免无谓 CAS**：非队首线程 tryAcquire 注定失败（公平锁）
3. **非公平锁的折中**：非公平锁的 tryAcquire 不检查队列，但 acquireQueued 仍只让队首尝试

**架构师经验**：AQS 在 acquireQueued 层面是"严格 FIFO"，在 tryAcquire 层面是"非公平插队"。**这种"分层设计"兼顾公平与性能**。

### 3.4 shouldParkAfterFailedAcquire 的"SIGNAL 设置"

```java
private static boolean shouldParkAfterFailedAcquire(Node pred, Node node) {
    int ws = pred.waitStatus;
    if (ws == Node.SIGNAL)
        return true;  // 前驱已设 SIGNAL，可以安全 park
    if (ws > 0) {
        // 前驱取消，跳过
        do {
            node.prev = pred = pred.prev;
        } while (pred.waitStatus > 0);
        pred.next = node;
    } else {
        // 设前驱为 SIGNAL
        compareAndSetWaitStatus(pred, ws, Node.SIGNAL);
    }
    return false;
}
```

**为什么 park 前要设前驱 SIGNAL**：

```
反例（不设 SIGNAL）：
  线程 A 释放锁，unpark 后继
  ↓
  线程 A 看 head.next.waitStatus == 0，不 unpark（以为没人等待）
  ↓
  线程 B 已经 park，但无人唤醒
  ↓
  死锁

正例（设 SIGNAL）：
  线程 B 入队后，设前驱（head）waitStatus = SIGNAL
  ↓
  线程 A 释放锁，看 head.waitStatus == SIGNAL，unpark 后继
  ↓
  线程 B 被唤醒
```

**架构师经验**：SIGNAL 是"park 前的安全网"--确保前驱释放时会唤醒自己。

### 3.5 release 从尾到头找的工程考量

```java
private void unparkSuccessor(Node node) {
    int ws = node.waitStatus;
    if (ws < 0)
        compareAndSetWaitStatus(node, ws, 0);

    Node s = node.next;
    if (s == null || s.waitStatus > 0) {
        // next 不可用，从尾到头找
        s = null;
        for (Node t = tail; t != null && t != node; t = t.prev)
            if (t.waitStatus <= 0)
                s = t;
    }
    if (s != null)
        LockSupport.unpark(s.thread);
}
```

**为什么从头找不够**：

addWaiter 的入队流程：

```java
private Node enq(final Node node) {
    for (;;) {
        Node t = tail;
        if (t == null) {
            if (compareAndSetHead(new Node()))
                tail = head;
        } else {
            node.prev = t;             // 1. 先设 prev
            if (compareAndSetTail(t, node)) {  // 2. CAS tail
                t.next = node;         // 3. 再设 next
                return t;
            }
        }
    }
}
```

**竞态窗口**：步骤 2 完成后，步骤 3 完成前，`node.prev` 已设但 `t.next` 未设。此时如果从头找（head.next），可能找不到刚入队的 node。

**从尾找的安全性**：`node.prev` 一定已设，从 tail 反向遍历 prev 一定能找到。

**架构师经验**：AQS 的双向链表不是"对称"的--prev 比 next 更"可靠"。**这是 AQS 工程实现的精髓**。

---

## 四、Condition vs wait/notify：等待队列的设计哲学

### 4.1 两种等待机制的本质差异

| 维度 | Object.wait/notify | Condition |
|------|-------------------|-----------|
| 锁依赖 | synchronized | Lock（ReentrantLock 等） |
| 等待队列数 | 1（对象的 WaitSet） | 多（每个 Condition 一个） |
| 入队 / 出队 | ObjectMonitor 内部 | ConditionObject |
| 中断响应 | wait 抛 InterruptedException | await / awaitUninterruptibly |
| 超时 | wait(ms) | awaitNanos / await(time, unit) / awaitUntil |
| 截止时间 | 不支持 | awaitUntil(date) |
| 不要求持锁 | 否 | 否（必须先 lock） |

**关键认知**：Condition 的核心改进是"多等待队列"和"更灵活的中断 / 超时"。

### 4.2 多等待队列的工程价值

synchronized 只有 1 个 WaitSet，所有 wait 的线程都在一个队列：

```java
// 反例：生产者消费者用 synchronized
synchronized (lock) {
    while (queue.isEmpty()) {
        lock.wait();  // 消费者等待
    }
    // 消费
}

synchronized (lock) {
    while (queue.isFull()) {
        lock.wait();  // 生产者也等待，与消费者混在一起
    }
    // 生产
}
```

**问题**：notify 时无法精确唤醒"生产者"还是"消费者"，可能误唤醒。

**Condition 的多队列解决方案**：

```java
private final ReentrantLock lock = new ReentrantLock();
private final Condition notEmpty = lock.newCondition();  // 消费者队列
private final Condition notFull = lock.newCondition();   // 生产者队列

public void produce(T item) throws InterruptedException {
    lock.lock();
    try {
        while (queue.isFull()) {
            notFull.await();  // 生产者等待
        }
        queue.add(item);
        notEmpty.signal();  // 精确唤醒消费者
    } finally {
        lock.unlock();
    }
}

public T consume() throws InterruptedException {
    lock.lock();
    try {
        while (queue.isEmpty()) {
            notEmpty.await();  // 消费者等待
        }
        T item = queue.poll();
        notFull.signal();  // 精确唤醒生产者
        return item;
    } finally {
        lock.unlock();
    }
}
```

**架构师经验**：多 Condition 是"精确唤醒"的基础。**生产者-消费者模型必须用多 Condition**，避免误唤醒。

### 4.3 await 的"完全释放"设计

```java
public final void await() throws InterruptedException {
    // ...
    int savedState = fullyRelease(node);  // 完全释放锁（重入次数清零）
    // ...
    if (acquireQueued(node, savedState) && ...)  // 重新获取时恢复重入次数
        // ...
}
```

**为什么 await 要"完全释放"**：

```
线程 A 重入锁 3 次：
  state = 3
  ↓
  await()
  ↓
  如果只释放 1 次（state = 2），其他线程拿不到锁
  ↓
  必须完全释放（state = 0），其他线程才能获取
  ↓
  被唤醒后，重新 acquire savedState（state = 3）
```

**架构师经验**：await 的"完全释放"是 ReentrantLock 重入语义的工程实现。**synchronized 也有类似机制（ObjectMonitor recursions）**。

### 4.4 signal 的"转移节点"设计

```java
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

**3 个步骤**：

1. CAS 修改 waitStatus：CONDITION -> 0
2. 加入同步队列（enq）
3. 设置前驱 SIGNAL + unpark

**关键认知**：signal 不是"立即唤醒"，而是"把节点从 Condition 队列转移到同步队列"。**线程被唤醒后仍需 acquire 同步队列**。

### 4.5 awaitNanos 的超时精度

```java
public final long awaitNanos(long nanosTimeout) throws InterruptedException {
    long deadline = System.nanoTime() + nanosTimeout;
    // ...
    while (!isOnSyncQueue(node)) {
        if (nanosTimeout <= 0L) {
            transferAfterCancelledWait(node);
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

**架构师经验**：超时锁的精度受 OS 调度器限制。**1ms 以下的超时不靠谱，应该用 CAS 自旋**。

---

## 五、三大锁选型决策树

### 5.1 ReentrantLock / ReentrantReadWriteLock / StampedLock 选型

```
是否需要锁？
  ├─ 是 -> 是否需要独占？
  │       ├─ 是 -> ReentrantLock
  │       └─ 否 -> 读多写少？
  │               ├─ 是 -> 读比例 > 90%？
  │                       ├─ 是 -> StampedLock（乐观读）
  │                       └─ 否 -> ReentrantReadWriteLock
  │               └─ 否 -> ReentrantLock（独占）
  └─ 否 -> 是否需要原子操作？
          ├─ 是 -> Atomic* / LongAdder
          └─ 否 -> 无锁（volatile / final）
```

### 5.2 三大锁的性能矩阵

| 场景 | ReentrantLock | ReentrantReadWriteLock | StampedLock |
|------|--------------|----------------------|-------------|
| 单线程读 | 100 ns | 100 ns | 50 ns（乐观读） |
| 多线程读（4 线程） | 1 μs | 200 ns（共享读） | 100 ns（乐观读） |
| 多线程读（16 线程） | 5 μs | 1 μs（共享读） | 300 ns（乐观读） |
| 单线程写 | 100 ns | 100 ns | 100 ns |
| 多线程写 | 1-10 μs | 1-10 μs | 1-10 μs |
| 读多写少（10w:1） | 5 μs | 200 ns | 50 ns |

**关键认知**：

- StampedLock 乐观读最快（无锁，版本号校验）
- ReentrantReadWriteLock 共享读次之（需加读锁）
- ReentrantLock 读串行化（独占锁）

### 5.3 StampedLock 的"乐观读"工程价值

StampedLock 的乐观读：

```java
public T read(long key) {
    long stamp = stampedLock.tryOptimisticRead();  // 1. 乐观读（无锁）
    T value = map.get(key);
    if (!stampedLock.validate(stamp)) {  // 2. 校验
        // 3. 乐观读失败，升级为悲观读
        stamp = stampedLock.readLock();
        try {
            value = map.get(key);
        } finally {
            stampedLock.unlockRead(stamp);
        }
    }
    return value;
}
```

**关键认知**：

- 乐观读不加锁，性能接近"无锁读"
- validate 校验版本号，确保读期间无写
- 失败回退到悲观读，保证正确性

**架构师经验**：StampedLock 的"乐观读"是"乐观锁"思想在 Java 层的实现。**读多写少场景性能提升 5-10 倍**。

### 5.4 StampedLock 的"陷阱"

**陷阱 1：不可重入**

```java
// 反例：同一线程重复加锁会死锁
stampedLock.writeLock();
stampedLock.writeLock();  // 死锁
```

**陷阱 2：不支持 Condition**

```java
// 反例：StampedLock 不能 newCondition
// stampedLock.newCondition();  // 不存在
```

**陷阱 3：乐观读失败处理**

```java
// 反例：不处理 validate 失败
long stamp = stampedLock.tryOptimisticRead();
T value = map.get(key);
if (!stampedLock.validate(stamp)) {
    // 不处理，value 可能是脏数据
}
return value;

// 正例：升级为悲观读
long stamp = stampedLock.tryOptimisticRead();
T value = map.get(key);
if (!stampedLock.validate(stamp)) {
    stamp = stampedLock.readLock();
    try {
        value = map.get(key);
    } finally {
        stampedLock.unlockRead(stamp);
    }
}
return value;
```

**陷阱 4：不要用 interrupt**

```java
// 反例：StampedLock 的 readLock / writeLock 在阻塞时不响应中断
// 可能导致死锁
```

**架构师经验**：StampedLock 是"特种兵"，**不要做通用锁**。生产中 90% 场景用 ReentrantLock / ReentrantReadWriteLock，10% 高并发读场景才用 StampedLock。

### 5.5 公平 vs 非公平的工程权衡

| 维度 | 公平锁 | 非公平锁 |
|------|--------|---------|
| 吞吐 | 低 | 高（5-10 倍） |
| 延迟分布 | 均匀 | 抖动大 |
| 饥饿风险 | 无 | 有 |
| 适用场景 | 严格顺序 / 防饥饿 | 高吞吐 |

**关键认知**：默认非公平锁是性能优先的选择。**只有业务明确要求"严格顺序"或"防止饥饿"才用公平锁**。

---

## 六、在线问诊系统的 AQS 实战

### 6.1 IM 网关 UserMap 的读写锁选型

**场景**：IM 网关 10w+ 用户的 UserMap，读多写少（查询 100w QPS，上下线 100 QPS）。

**方案 1：ReentrantReadWriteLock**

```java
public class UserManager {
    private final Map<Long, User> users = new HashMap<>();
    private final ReentrantReadWriteLock rwLock = new ReentrantReadWriteLock();

    public User get(long userId) {
        rwLock.readLock().lock();
        try {
            return users.get(userId);
        } finally {
            rwLock.readLock().unlock();
        }
    }

    public void online(User user) {
        rwLock.writeLock().lock();
        try {
            users.put(user.getId(), user);
        } finally {
            rwLock.writeLock().unlock();
        }
    }
}
```

**问题**：100w 读 QPS 下，readLock 仍有 CAS 开销；写锁可能饥饿（持续读时写拿不到）。

**方案 2：StampedLock 乐观读**

```java
public class UserManager {
    private final Map<Long, User> users = new HashMap<>();
    private final StampedLock stampedLock = new StampedLock();

    public User get(long userId) {
        long stamp = stampedLock.tryOptimisticRead();  // 乐观读
        User user = users.get(userId);
        if (!stampedLock.validate(stamp)) {  // 校验
            stamp = stampedLock.readLock();  // 升级为悲观读
            try {
                user = users.get(userId);
            } finally {
                stampedLock.unlockRead(stamp);
            }
        }
        return user;
    }

    public void online(User user) {
        long stamp = stampedLock.writeLock();
        try {
            users.put(user.getId(), user);
        } finally {
            stampedLock.unlockWrite(stamp);
        }
    }
}
```

**方案 3：ConcurrentHashMap（最优）**

```java
public class UserManager {
    private final ConcurrentHashMap<Long, User> users = new ConcurrentHashMap<>();

    public User get(long userId) {
        return users.get(userId);  // 无锁
    }

    public void online(User user) {
        users.put(user.getId(), user);  // CAS
    }
}
```

**性能对比**：

| 方案 | 100w 读 QPS | 100 写 QPS | 写锁饥饿 |
|------|-------------|-----------|---------|
| ReentrantReadWriteLock | 50w QPS | 50w QPS | 有 |
| StampedLock 乐观读 | 100w QPS | 100w QPS | 无 |
| ConcurrentHashMap | 100w+ QPS | 100w+ QPS | 无 |

**架构师经验**：单纯读写场景优先用 ConcurrentHashMap。**只有需要"复合操作"（如 check-then-act）才用 StampedLock / ReadWriteLock**。

### 6.2 视频问诊 SFU 的 Semaphore 限流

**场景**：视频问诊 SFU 单机最大 1000 路视频，用 Semaphore 控制并发路数。

**实现**：

```java
public class VideoSFU {
    private final Semaphore semaphore = new Semaphore(1000);

    public boolean startVideoSession() {
        if (semaphore.tryAcquire()) {  // 非阻塞获取
            try {
                // 启动视频会话
                return true;
            } catch (Exception e) {
                semaphore.release();
                return false;
            }
        }
        return false;  // 超出限制，拒绝
    }

    public void endVideoSession() {
        semaphore.release();  // 释放许可
    }
}
```

**关键认知**：

- Semaphore 的 state = 剩余许可数
- tryAcquire 非阻塞（CAS 减 1）
- release 增 1，可能唤醒等待线程

**架构师经验**：Semaphore 适合"限流"场景，比" synchronized + 计数器"高效 10-100 倍。

### 6.3 订单批量生成的 CountDownLatch

**场景**：批量生成 1000 个订单，并行处理，等所有订单生成完成。

**实现**：

```java
public class OrderBatchGenerator {
    public List<Order> generateBatch(List<OrderRequest> requests) throws InterruptedException {
        int count = requests.size();
        CountDownLatch latch = new CountDownLatch(count);
        List<Order> orders = new ArrayList<>(count);

        for (int i = 0; i < count; i++) {
            final int idx = i;
            executor.submit(() -> {
                try {
                    Order order = generateOrder(requests.get(idx));
                    orders.set(idx, order);  // 并行写入不同位置，线程安全
                } finally {
                    latch.countDown();  // 计数减 1
                }
            });
        }

        latch.await(10, TimeUnit.SECONDS);  // 等待所有完成
        return orders;
    }
}
```

**关键认知**：

- CountDownLatch 的 state = 未完成计数
- countDown 是 releaseShared（state 减 1）
- await 是 acquireShared（state == 0 才放行）

**架构师经验**：CountDownLatch 适合"等待 N 个并行任务完成"场景。**注意 countDown 必须在 finally 中，否则任务异常会"卡死" await**。

### 6.4 IM 网关优雅停机的 CyclicBarrier

**场景**：IM 网关优雅停机，等所有长连接处理完才退出。

**实现**：

```java
public class GracefulShutdown {
    private final CyclicBarrier barrier;
    private final ExecutorService executor;

    public GracefulShutdown(int connectionCount) {
        this.barrier = new CyclicBarrier(connectionCount + 1);  // +1 主线程
        this.executor = Executors.newFixedThreadPool(connectionCount);
    }

    public void shutdown() throws InterruptedException {
        for (int i = 0; i < connectionCount; i++) {
            executor.submit(() -> {
                try {
                    processConnection();  // 处理剩余消息
                } finally {
                    barrier.await();  // 等待其他线程
                }
            });
        }

        barrier.await();  // 主线程等待
        executor.shutdown();
    }
}
```

**关键认知**：

- CyclicBarrier 基于 ReentrantLock + Condition（不直接基于 AQS）
- 与 CountDownLatch 区别：可重置（cyclic）+ 多方等待（含主线程）

**架构师经验**：CyclicBarrier 适合"多方相互等待"场景。**注意 await 超时配置，避免单线程异常导致整体卡死**。

### 6.5 监管上报服务的生产者-消费者模型

**场景**：监管消息生产者-消费者，多 Condition 精确唤醒。

**实现**：

```java
public class SupervisorReporter {
    private final ReentrantLock lock = new ReentrantLock();
    private final Condition notEmpty = lock.newCondition();
    private final Condition notFull = lock.newCondition();
    private final Queue<Message> queue = new LinkedList<>();
    private final int capacity = 10000;

    public void produce(Message msg) throws InterruptedException {
        lock.lock();
        try {
            while (queue.size() == capacity) {
                notFull.await();  // 生产者等待
            }
            queue.offer(msg);
            notEmpty.signal();  // 精确唤醒消费者
        } finally {
            lock.unlock();
        }
    }

    public Message consume() throws InterruptedException {
        lock.lock();
        try {
            while (queue.isEmpty()) {
                notEmpty.await();  // 消费者等待
            }
            Message msg = queue.poll();
            notFull.signal();  // 精确唤醒生产者
            return msg;
        } finally {
            lock.unlock();
        }
    }
}
```

**架构师经验**：多 Condition 是"精确唤醒"的基础。**生产者-消费者模型必须用多 Condition**，避免误唤醒。

---

## 七、本日核心认知

1. **AQS 是同步器设计语言，不只是 ReentrantLock 实现**：架构师必须能基于 AQS 设计自定义同步器
2. **AQS 的核心是"状态机 + 队列 + 阻塞"**：state（volatile int + CAS）+ CLH 队列变体（双向链表 + park）+ 模板方法模式
3. **模板方法模式分离"不变"与"可变"**：AQS 处理队列 / 阻塞 / 中断 / 超时，子类只实现 tryAcquire / tryRelease
4. **CLH 队列变体的核心改进是双向链表 + park**：避免单向链表删除难题 + 避免自旋浪费 CPU
5. **双向链表的"非对称设计"**：prev 比 next 更可靠，unparkSuccessor 从尾到头找避免 next 未设置竞态
6. **独占模式 acquire 4 步**：tryAcquire -> addWaiter -> acquireQueued -> selfInterrupt
7. **共享模式"传播"机制**：tryAcquireShared 返回正数时传播唤醒后继，避免批量释放时多次从头唤醒
8. **Condition 多等待队列是"精确唤醒"基础**：生产者-消费者必须用多 Condition，避免误唤醒
9. **公平 vs 非公平的核心差异是 hasQueuedPredecessors**：默认非公平，性能高 5-10 倍
10. **StampedLock 不基于 AQS**：64 bit state + 乐观读版本号机制，性能高 5-10 倍但不可重入 / 不支持 Condition
11. **架构师视角：能用 synchronized 就 synchronized，能用 CAS 就 CAS，能用 AQS 同步器就 AQS 同步器**--按需选择，避免过度设计
