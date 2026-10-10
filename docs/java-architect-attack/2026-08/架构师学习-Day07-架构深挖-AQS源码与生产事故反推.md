# Day07：架构深挖 - AQS 源码与生产事故反推

> 日期：2026年08月16日（周日）
> 周主题：并发编程专题 - JMM / synchronized 锁升级 / AQS / 并发容器 / 线程池 / 虚拟线程
> 深挖日：Day07 - AQS 源码级深挖与生产事故反推（cancelAcquire / 竞态窗口 / 中断语义 / JDK15+ 重写 / 四防闭环）

---

## 一、今日主题

本周 Day01-Day06 完成了并发编程专题的 6 大支柱学习：

```text
Day01：JMM 内存模型（happens-before / volatile / CAS / final 语义 / DCL）
Day02：synchronized 锁升级（无锁->偏向->轻量级->重量级 / ObjectMonitor / 锁消除锁粗化）
Day03：AQS 核心原理（state / CLH 变体 / acquire-release / Condition / 公平非公平 / 三大锁）
Day04：并发容器（ConcurrentHashMap / CopyOnWriteArrayList / BlockingQueue / ConcurrentLinkedQueue）
Day05：线程池与虚拟线程（ThreadPoolExecutor / Worker / 参数调优 / 虚拟线程 / 结构化并发）
Day06：串联整合 - 一次完整的并发故障复盘（JMM->锁->AQS->容器->线程池全链路）
```

Day06 把 Day01-Day05 串成"并发体系全链路"，但有一个维度我们一直停留在"流程层"：**AQS 源码里的取消、竞态、中断与重写**。

回顾本周 5 个技术日，每个知识点都"知道一点"，但从未讲透：

```text
Day03 提到了 cancelAcquire，但只讲了"超时/中断会取消节点"——
      没讲取消的 3 种触发路径、自链接 help GC、为什么清理是"惰性"的
Day03 提到了 shouldParkAfterFailedAcquire，但只讲了"设置前驱 SIGNAL"——
      没讲 SIGNAL 的"承诺-兑现"语义、CAS 失败为什么返回 false 重新自旋
Day03 提到了 parkAndCheckInterrupt，但只讲了"清除并返回中断状态"——
      没讲 acquire 的 selfInterrupt"延迟响应"设计、Condition 的中断三态
Day03 提到了 transferForSignal，但只讲了"转移到同步队列"——
      没讲 CAS(CONDITION->0) 这个"唯一裁决点"、isOnSyncQueue/findNodeFromTail
Day03 提到了公平 vs 非公平，但只讲了"hasQueuedPredecessors 检查"——
      没讲公平锁吞吐跌 5 倍的量化拆解、P99 周期性尖刺的唤醒 convoy
```

更关键的是：**AQS 在 2020 年（JDK 15）被 Doug Lea 团队整体重写过（JDK-8229442）**。如果我们只会背 JDK 8 的 acquire 4 步流程，面试官一句"JDK 15 重写知道吗"就会暴露知识停留在 2014 年。

结合用户业务背景做"二次复发"叙事：**Day03 中我们对在线问诊系统做了三大 AQS 改造（IM 网关 UserMap 读写锁、视频问诊 SFU Semaphore 限流、批量订单 CountDownLatch），改造上线平稳运行 30 天**。修复后的代码在功能上完全正确——30 天的平稳证明了这一点。但第 31 天流感季高峰的凌晨，三个改造**同时**爆发 4 个异常现象。

这一次的根因与 Day03 里的"选型问题"完全不同：

```text
现象1 的根因在 cancelAcquire 的"惰性清理"：超时风暴产生 CANCELLED 尸体
现象2 的根因在"异常路径未 countDown"+ await 超时后仍要重新 acquire 的语义
现象3 的根因在"tryAcquire 成功后异常路径未 release"的许可泄漏
现象4 的根因在公平锁"每次获取都排队+唤醒"的 convoy 开销
```

**4 个现象，4 个不同的 AQS 源码机制**。如果不能从源码层面理解 cancelAcquire / 竞态窗口 / 中断语义 / 公平性开销，"二次复发"永远无法定位。Day07 把这些问题彻底深挖。

---

## 二、题目：AQS 生产事故场景（第 31 天凌晨）

### 2.1 背景：Day03 三大 AQS 改造回顾

```text
改造点 1（IM 网关）：10w+ 在线用户 UserMap，读多写少
  -> ReentrantReadWriteLock（当时为防写锁饥饿，第 25 天评审后改成公平锁）
改造点 2（视频问诊）：SFU 单机最大 1000 路并发通话
  -> new Semaphore(1000)，进房 tryAcquire，挂断 release
改造点 3（批量订单）：夜间批量生成问诊订单，1000 单/批次
  -> CountDownLatch(1000)，主线程 await(30s) 等全部完成
```

上线后平稳运行 30 天。**第 31 天（2026-08-16）流感季高峰，凌晨 03:00 突发 4 个异常现象**：

### 2.2 现象1：300+ 线程 WAITING，锁 state=0，队列挂满 CANCELLED 节点

```text
03:00 告警：批量订单接口 P99 从 800ms 飙到 12s，上游网关大量超时重试。

jstack 连续抓 3 次快照，每次都有 300+ 个相同栈的线程：

"batch-order-worker-207" #1876 daemon prio=5 os_prio=0 tid=0x00007f... nid=0x9c3c waiting on condition
   java.lang.Thread.State: WAITING (parking)
        at sun.misc.Unsafe.park(Native Method)
        at java.util.concurrent.locks.LockSupport.park(LockSupport.java:175)
        at java.util.concurrent.locks.AbstractQueuedSynchronizer.parkAndCheckInterrupt(AQS.java:836)
        at java.util.concurrent.locks.AbstractQueuedSynchronizer.doAcquireSharedNanos(AQS.java:813)
        at java.util.concurrent.locks.AbstractQueuedSynchronizer.tryAcquireSharedNanos(AQS.java:1110)
        at java.util.concurrent.CountDownLatch$Sync.tryAcquireSharedNanos(CountDownLatch.java:283)
        at java.util.concurrent.CountDownLatch.await(CountDownLatch.java:...)
        at com.health.order.BatchOrderService.batchCreate(BatchOrderService.java:88)

诡异点 A：连续 3 次快照（间隔 10s），300+ 线程中 40% 是新线程 ID——不是死锁，是"慢醒"
诡异点 B：Arthas vmtool 反射 dump 批量订单锁的 AQS 队列：
           queue length = 823 个 Node
           waitStatus 分布 = CANCELLED(1) x 516 / SIGNAL(-1) x 301 / 0 x 6
诡异点 C：相关读写锁的 state = 0（没有任何线程持有锁），但队列里挂着 823 个节点
```

### 2.3 现象2：await(30s) 全部超时，但业务日志显示"所有任务已完成"

```text
03:12 批次告警：当夜所有批次的 latch.await(30, SECONDS) 全部返回 false（超时）。

业务日志检索（全批次 1000 个任务）：
03:12:44.101 [worker-3]  INFO BatchTask - 订单生成完成 orderId=OD20260816000997
03:12:44.102 [worker-7]  INFO BatchTask - 订单生成完成 orderId=OD20260816000998
03:12:44.105 [worker-9]  INFO BatchTask - 订单生成完成 orderId=OD20260816001000
-- grep "订单生成完成" 恰好 1000 条，一条不差
-- 但自研监控打点 latch 剩余计数 remaining = 1（差 1 个 countDown）

更诡异的次生现象：await 超时后线程并没有在 30s 附近返回：
03:13:14.101 [batch-api-12] WARN BatchOrderService - 批次等待超时 timeout=30s
03:13:22.4xx  [alert-watcher-1] WARN BatchAlert - 批次完成信号等待超时，8.2s 后才拿回锁返回
告警线程用的是 Condition.awaitNanos(30s)，超时时刻 03:13:14，实际返回 03:13:22
——"超时了为什么还要再等 8 秒才能返回"？
```

### 2.4 现象3：视频问诊全线"系统繁忙"，许可=0 但无人在通话

```text
03:40 视频问诊全量故障：用户点击视频问诊，100% 返回"系统繁忙，请稍后再试"。

监控面板对照：
  sfuSemaphore.availablePermits() = 0     （1000 路许可耗尽）
  callRegistry.activeCalls()      = 0     （实际在通话 0 路）
  SFU 服务侧 join 成功率 = 100%           （下游无任何压力）

审计日志回溯前 1 小时：
  03:05-03:40 期间 "SFU join 失败（弱网超时）" 共 137 次
  每次失败的用户请求都返回了"系统繁忙"（注意：是异常被 catch 后转换的 BUSY）
  1000 许可 - 137 泄漏 = 863？但 availablePermits 显示 0——
  03:00-03:05 流感季流量本身吃掉了剩余许可的正常份额，之后只还不进
```

### 2.5 现象4：读写锁改公平后吞吐跌 5 倍、P99 规律性尖刺

```text
背景：第 25 天（流感季前夕）评审会上，团队担心 UserMap 写锁饥饿，
     将 ReentrantReadWriteLock 从非公平改为公平（new ReentrantReadWriteLock(true)）。

02:30 流感季预热流量（读 QPS 8.2w，写 QPS 5/s）叠加后：

指标            非公平（改前基线）      公平（改后实测）      变化
------------------------------------------------------------------
读吞吐          8.2w QPS              1.6w QPS             跌 5.1 倍
读 P99 延迟     0.9μs                 38μs                 42 倍
P99 尖刺        无                    每 ~200ms 一次 6-9ms  与写锁 QPS(5/s) 同频
上下文切换 cs   1.2w/s                61w/s                50 倍
CPU sys 占比    8%                    47%                  调度开销吃满

JMH 复测（4C8G，8 线程 100% 读）：
  非公平 RRWL 读锁：23,500,000 ops/s
  公平   RRWL 读锁： 4,720,000 ops/s   （5.0 倍差距，与线上吻合）
```

### 2.6 要求

```text
从 AQS 源码底层机制（cancelAcquire 取消清理 / park-unpark 竞态窗口 / 中断三态语义 /
Condition 转移竞态 / 公平性排队开销）出发，解释清楚上述四个现象的根因，
并给出架构师视角的"四防闭环"设计与同步器使用契约。
```

---

## 三、需要回答的问题

### 1. cancelAcquire 全解

```text
- 取消的 3 种触发路径（中断 / 超时 / 异常）分别对应哪些源码入口？
- cancelAcquire 完整源码的 3 个清理分支（队尾自摘 / 责任转移 / unparkSuccessor）？
- node.next = node 自链接为什么能 help GC？不写会怎样？
- 为什么说 AQS 的取消清理是"惰性"的？CANCELLED 尸体什么情况下会滞留队列？
- 为什么 head 的直接后继被取消时，要 unparkSuccessor 主动唤醒后继？
```

### 2. park/unpark 的竞态窗口

```text
- unpark 先于 park 执行，唤醒为什么会不丢？（许可机制，对比 Object.wait/notify）
- SIGNAL 的"承诺-兑现"语义：为什么 park 前必须让前驱置 SIGNAL？
- shouldParkAfterFailedAcquire 的 CAS 失败为什么返回 false 重新自旋？兜底链条？
- 为什么 park 可能"无故"返回（spurious wakeup）？AQS 用什么防线？
```

### 3. 中断语义全解

```text
- acquire 为什么"不响应"中断却要 selfInterrupt 补标志？这是"延迟响应"设计
- acquireInterruptibly 的 throwIfInterrupted 与 doAcquireInterruptibly 的差异
- Condition 的 interruptMode 三态（0 / THROW_IE / REINTERRUPT）分别什么含义？
- checkInterruptWhileWaiting 如何用一次 CAS 裁决"中断发生在 signal 前还是后"？
- parkAndCheckInterrupt 为什么用 Thread.interrupted()（清除并返回）而不是 isInterrupted()？
```

### 4. AQS 的"私有穿透"API

```text
- isOnSyncQueue / findNodeFromTail 为什么必须从尾找？（入队 CAS 的中间态）
- transferForSignal 与 transferAfterCancelledWait 的 CAS(CONDITION->0) 竞态：
  谁 CAS 成功谁负责转移，另一方怎么收场？
- isOwnedBy / hasWaiters / getWaitQueueLength 等查询 API 的运维价值
```

### 5. JDK 15+ AQS 重写差异

```text
- JDK-8229442 的重写动机是什么？旧实现有什么已知问题？
- 新 Node 的状态设计（WAITING/CANCELLED/COND）与旧 waitStatus 的差异？
- 什么是 locked 队列（tail 到 head 的锁定链）？替代了什么？
- cleanQueue / rewindStacks / signalNext 等新方法做什么？
- 重写后 unparkSuccessor"从尾找"的逻辑去哪了？
- 面试讲 JDK 8 还是 JDK 21？怎么答最加分？
```

### 6. 生产事故反推

```text
逐现象：从 jstack/日志/监控证据 -> AQS 源码机制 -> 根因 -> 修复代码对照
```

### 7. 四防闭环

```text
- 防误用：同步器使用契约清单（countDown in finally / release in finally / 超时兜底）
- 防泄漏：Semaphore/lease 的 finally + availablePermits 监控 + 定时对账
- 防饥饿：公平性监控指标与切换评估
- 防卡死：await 超时 + 降级开关
- jcstress 怎么写并发正确性测试？
```

### 8. AQS 生态延伸

```text
- JDK 9 VarHandle 替代 Unsafe 的原因与差异
- AQS 在 JUC 生态的使用全景图（线程池 Worker / ReentrantLock / Semaphore / ...）
- 自己实现一个基于 AQS 的同步器（TwoPhaseLatch 双人闸）+ 测试
```

---

## 四、作答区：逐模块源码级深挖

> 以下 JDK 8 源码摘自 OpenJDK 8u `AbstractQueuedSynchronizer.java`（保留主干与注释）。
> Day03 已讲过的 state 含义、acquire 4 步、Condition 5 步、公平非公平基础差异，本文直接引用不重复，聚焦"取消 / 竞态 / 中断 / 重写 / 反推"五个深挖点。

### 4.1 cancelAcquire 全解——取消的 3 种触发与惰性清理

#### 4.1.1 取消的 3 种触发路径

Day03 只提到"超时/中断会取消节点"，没讲触发入口。实际上所有取消都收敛到一个私有方法 `cancelAcquire(node)`，但有 **3 类完全不同的触发路径**：

```text
触发路径 1：超时（doAcquireNanos / doAcquireSharedNanos）
  剩余时间 <= 0 -> return false
  注意：failed 仍是 true -> finally 走 cancelAcquire   <-- 现象1 的元凶入口

触发路径 2：中断（doAcquireInterruptibly / doAcquireSharedInterruptibly）
  park 醒来发现 Thread.interrupted() == true -> throw InterruptedException
  异常抛出 -> finally 走 cancelAcquire                <-- 现象2 的 await 超时兄弟路径

触发路径 3：异常（tryAcquire 子类实现抛异常 / fullyRelease 失败）
  acquireQueued / doAcquire* 的 try 块中任何异常 -> failed 仍 true -> finally 走 cancelAcquire
```

源码证据（超时路径为什么必走取消）：

```java
private boolean doAcquireNanos(int arg, long nanosTimeout)
        throws InterruptedException {
    if (nanosTimeout <= 0L)
        return false;
    final long deadline = System.nanoTime() + nanosTimeout;
    final Node node = addWaiter(Node.EXCLUSIVE);
    boolean failed = true;                          // <-- 初始 true
    try {
        for (;;) {
            final Node p = node.predecessor();
            if (p == head && tryAcquire(arg)) {
                setHead(node);
                p.next = null;                      // help GC
                failed = false;                     // <-- 只有成功才置 false
                return true;
            }
            nanosTimeout = deadline - System.nanoTime();
            if (nanosTimeout <= 0L)
                return false;                       // <-- 超时返回，failed 仍为 true！
            if (shouldParkAfterFailedAcquire(p, node) &&
                nanosTimeout > spinForTimeoutThreshold)
                LockSupport.parkNanos(this, nanosTimeout);
            if (Thread.interrupted())
                throw new InterruptedException();    // <-- 中断抛出，failed 仍为 true
        }
    } finally {
        if (failed)
            cancelAcquire(node);                    // <-- 超时/中断都走到这里
    }
}
```

**关键认知**：`latch.await(30s)` 超时返回 false 的那一瞬间，线程并没有"干净地离开"——它在同步队列里的 Node 会被标记 CANCELLED 并触发一次清理尝试。**每一次超时 = 一次取消 = 一次队列写操作**。这是理解现象1（取消风暴）的源码起点。

#### 4.1.2 cancelAcquire 完整源码逐行剖析

```java
private void cancelAcquire(Node node) {
    if (node == null)
        return;

    node.thread = null;                    // [1] 立刻切断线程引用：此后唤醒逻辑
                                           //     对本节点的 thread 判空即跳过

    Node pred = node.prev;
    while (pred.waitStatus > 0)            // [2] 跳过已取消的前驱（>0 即 CANCELLED）
        node.prev = pred = pred.prev;      //     顺带清理：把 prev 指向第一个有效前驱

    Node predNext = pred.next;             // [3] 记录前驱的 next 快照——接下来所有 CAS
                                           //     都以 predNext 为期望值，防止覆盖并发修改

    node.waitStatus = Node.CANCELLED;      // [4] 无条件写（不用 CAS）：
                                           //     取消是单线程动作（只有 node 的宿主线程调用），
                                           //     且 CANCELLED 是"吸收态"，任何人读到都只是跳过

    // ---------- 分支 A：node 是队尾 ----------
    if (node == tail && compareAndSetTail(node, pred)) {
        compareAndSetNext(pred, predNext, null);   // [5] 队尾自摘：pred.next = null
    }                                    //       CAS 失败（pred.next 已变）也无妨，
                                           //       说明别人已经改了 pred 的 next

    // ---------- 分支 B/C：node 不是队尾 ----------
    else {
        int ws;
        if (pred != head &&
            ((ws = pred.waitStatus) == Node.SIGNAL ||
             (ws <= 0 && compareAndSetWaitStatus(pred, ws, Node.SIGNAL))) &&
            pred.thread != null) {                 // [6] 判定：pred 能承接唤醒责任吗？
                                                  //     条件：非 head + 可置 SIGNAL + 未取消
            Node next = node.next;
            if (next != null && next.waitStatus <= 0)
                compareAndSetNext(pred, predNext, next);
                                                  // [7] 责任转移：把 node 的后继
                                                  //     直接挂到 pred 上（pred.next = node.next）
                                                  //     之后 pred 释放时自然唤醒 node 的后继
        } else {
            unparkSuccessor(node);                 // [8] 无法转移责任（pred==head /
                                                  //     pred 取消中 / 置 SIGNAL 失败）
                                                  //     -> 自己动手唤醒有效后继
        }
        node.next = node;                          // [9] 自链接 help GC（见 4.1.3）
    }
}
```

**分支 B 的深意（唤醒责任转移）**：正常语义下，node 被 release 唤醒、抢到锁、成为新 head、离开队列时，会由"释放它的人"负责唤醒它的后继（SIGNAL 承诺链，见 4.2）。node 取消后永远不会走这套流程，**它对后继的唤醒承诺必须有人接盘**：

```text
分支 B（pred 可靠）：pred.next -> node.next，承诺转移给 pred
                    pred 被 release 时 unparkSuccessor(pred) 自然惠及新后继
分支 C（pred 不可靠）：pred == head（head 即将释放但时机不确定，且 head 是哨兵
                    永远不会"取消"也最该立即让位）或 pred 也在取消中
                    -> 取消者直接 unparkSuccessor(node)，立刻唤醒有效后继去抢锁
```

**为什么 head 的直接后继取消要走分支 C 主动唤醒**：head 后继是"下一个就该拿锁的线程"。如果只做责任转移（把后继挂到 head 上），还要等下一次 release 才有人 unpark——而此刻锁可能早已空闲（state=0，非公平下人人可抢）。主动 unparkSuccessor 让有效后继**立刻**参与竞争，把取消对吞吐的影响降到最低。这正是现象1 里"锁 state=0 但队列巨长"时，AQS 仍能保证不死锁的机制——**但它每次都要从尾遍历，这正是性能雪崩点（见 4.6.1）**。

#### 4.1.3 node.next = node 自链接为什么能 help GC

```java
node.next = node; // help GC
```

这是 AQS 源码里最著名的一行"魔法"。原因拆解：

```text
背景：AQS 队列是双向链表，GC 通过可达性分析回收 Node。
     队列本身的可达链：head -> ... -> tail（next 方向）+ tail -> ... -> head（prev 方向）

取消后的理想状态：node 从链上物理摘除，没有任何指针指向它 -> GC 回收

现实：并发取消下（分支 B 的 CAS(pred.next, predNext, next) 可能失败），
     node 可能仍被 pred.next 或 node.next 指向，无法完全摘干净。

如果不做自链接：
  node.next 仍指向后继 N2
  -> node 只要有任何一条外部引用残留（比如某个线程的局部变量、某次遍历的游标），
     N2 以及 N2 之后的一整串节点全部跟着可达 -> 无法回收 -> 队列"看似"越积越长

自链接后：
  node.next = node（指向自己）
  -> node 对外部只暴露一个"指向自己的环"
  -> 一旦其他指向 node 的引用消失，node 自环成为孤岛，GC 直接回收
  -> 后继 N2 不再经由 node 可达，阻断"取消节点拖住整条后链"的 GC 风险
```

**架构师经验**：这是"无锁数据结构 + 分代 GC"协同设计的教科书案例——**并发代码里 help GC 不是玄学，是把"可能残留的引用"收敛为"可孤立的环"**。类似手法在 ConcurrentLinkedQueue（删除节点自链接 next=this）中同样出现。面试提到这一点，能体现"并发 + GC 双视角"。

#### 4.1.4 为什么说取消清理是"惰性"的——CANCELLED 尸体的成因

**关键认知**：cancelAcquire 只保证"我取消我自己时尽力摘除"，**不保证队列里其他 CANCELLED 节点被物理清除**。物理清除只发生在三个"顺带"时机：

```text
惰性清理时机 1：shouldParkAfterFailedAcquire 的跳前驱循环
  新等待者发现 pred.waitStatus > 0 -> node.prev = pred.prev（只改自己的 prev）
  -> 注意：这只是"逻辑跳过"，被跳过的节点仍留在链上！

惰性清理时机 2：cancelAcquire 自己（分支 A 队尾自摘 / 分支 B 责任转移）
  只清理"取消者自己 + 它与前驱的连接"，队中中部的尸体动不了

惰性清理时机 3：unparkSuccessor 从尾遍历时"逻辑跳过" ws>0 的节点
  同样只是遍历时跳过，不做物理摘除
```

于是在**取消风暴**（大量线程同时超时/中断）下会出现：

```text
T1..T1000 排队 -> 流感季下游变慢 -> 上游统一 30s 超时，无退避
-> 每秒上千线程同时到 deadline，并发调用 cancelAcquire
-> 竞争点 1：CAS tail 失败（多个队尾节点同时自摘，只有一个成功）
-> 竞争点 2：pred 链上多个节点同时取消（pred.thread == null 判定竞态，
            predNext 快照过期导致 CAS(pred.next,...) 失败）
-> 结果：大量节点只完成了 [4]（标记 CANCELLED），没完成物理摘除
-> CANCELLED 尸体滞留在队列中部，无人主动清扫（惰性！）
-> 后果：unparkSuccessor 的从尾遍历从 O(1) 退化 O(n)
```

**架构师经验**：AQS 用"允许尸体存在 + 遍历时跳过"换取了无锁实现的简单性—— Doug Lea 在注释里明确这是设计取舍。**低取消率下这个代价可以忽略；高取消率（超时风暴）下它会放大唤醒延迟**。这正是现象1 的根因模型，也解释了为什么 JDK 15 重写要把取消清理改成 locked 队列协议（见 4.5）。

#### 4.1.5 取消 vs 释放的竞态时序图

```text
T1（等待者 node，准备超时取消）          T2（持锁者，准备 release）

deadline 到，return false
进入 finally -> cancelAcquire(node)
node.thread = null
跳过取消前驱，标记 CANCELLED
                                         tryRelease 成功（state=0）
                                         h = head
                                         h.waitStatus == SIGNAL(!=0)
                                         unparkSuccessor(head):
                                           s = head.next
                                           s == node 且 ws>0(CANCELLED)
                                           -> 从尾向前找第一个 ws<=0
                                           -> unpark(有效后继 T3)
CAS(tail, node->pred) ...                
分支 B：CAS(pred.next -> node.next)
node.next = node（自链接）

结果：T3 被 T2 唤醒；node 的后继挂到 pred 上；
     T3 醒来后 shouldParkAfterFailedAcquire 顺带跳过 node 尸体（逻辑清理）
——三方（取消者/释放者/被唤醒者）各清理一块，没有任何中心协调，最终收敛
```

```text
小结：
关键认知 1：超时/中断/异常 3 类路径全部收敛到 cancelAcquire，超时返回前必取消
关键认知 2：CANCELLED 是"吸收态"（ws>0），所有人读到只需跳过，所以标记可无条件写
关键认知 3：node.next = node 自链接把残留引用收敛为"可孤立的环"，阻断拖住后链
关键认知 4：取消清理是惰性的——尸体靠后续线程"顺带"清理，风暴下会堆积
关键认知 5：head 后继取消时主动 unparkSuccessor，是"让最该拿锁的人立刻竞争"
```

### 4.2 park/unpark 的竞态窗口——为什么唤醒不会丢

#### 4.2.1 unpark 先于 park 为什么不丢（许可机制）

Day02 讲 synchronized 时提到过 park/unpark 与 wait/notify 的对比，这里从 HotSpot 实现层面深挖。

Object.wait/notify 的死穴——唤醒会丢：

```text
T1: 判断条件不满足
T2:                    修改条件，notify()      <- 此时 T1 还没进 WaitSet
T1: wait()             <- 进入 WaitSet 等一个永远不会来的 notify -> 永久等待
```

LockSupport 的解法——**许可（permit）先存后用**：

```text
每个线程关联一个 Parker 对象（HotSpot: Parker._counter，取值 0/1）

unpark(T)：拿到 T 的 Parker mutex
           若 _counter == 0 -> 置 1
           若 T 正阻塞在 cond 上 -> pthread_cond_signal 唤醒它
           （counter=1 的状态下再 unpark 不累积，上限就是 1）

park()：   拿到自己 Parker mutex
           若 _counter == 1 -> 置 0，立即返回（消费许可）
           若 _counter == 0 -> pthread_cond_wait 阻塞，等 unpark 来 signal

时序验证（unpark 先于 park）：
T1: 判断条件不满足（还没 park）
T2: unpark(T1)  -> _counter = 1（许可存入）
T1: park()      -> 发现 _counter == 1 -> 消费并立即返回   <- 唤醒不丢！
```

**关键认知**：park/unpark 把 wait/notify 的"瞬时事件"模型改成了"持久许可"模型（一个 0/1 的信号量），**unpark 可以提前发放**。这是 AQS 敢做"无锁入队 + 阻塞等待"的底层前提。许可不累积（上限 1）是有意为之：多次 unpark 只需保证"至少唤醒一次"的语义，避免计数带来的内存管理负担。

#### 4.2.2 SIGNAL 的"承诺-兑现"语义——为什么 park 前必须握手

许可机制保证了"unpark 不丢"，但**没有保证"该 unpark 的人会被 unpark"**。丢唤醒的另一半风险在"唤醒者找不到/不负责唤醒睡着的线程"：

```text
反例（假设没有 SIGNAL 握手，直接 park）：

T1（等待者）                              T2（持锁者 head）
tryAcquire 失败
（还在 addWaiter 的路上...）
                                          tryRelease 成功（state=0）
                                          h.waitStatus == 0（无人承诺过要唤醒谁）
                                          -> 不调用 unparkSuccessor，直接返回
T1 完成 addWaiter（prev=head）
park()  <- 睡着了
                                          此后：T2 已离开，head 不再变，
                                          没有任何线程有义务 unpark T1
                                          -> T1 永久 park（丢失唤醒）
```

AQS 的解法是 SIGNAL 握手——Day03 已讲 shouldParkAfterFailedAcquire 的三分支，此处深挖它的**语义本质**：

```text
SIGNAL(-1) 的语义 = "前驱对后继的承诺（promise）"：
  "我（前驱）离开队列/释放锁时，一定会 unpark 你"

unparkSuccessor 的语义 = "兑现承诺"：
  release 时看到 head.waitStatus != 0（有承诺未兑现）才触发

握手流程（shouldParkAfterFailedAcquire，Day03 已讲分支，这里标注承诺视角）：
  pred.ws == SIGNAL   -> 承诺已建立，可以放心 park（返回 true）
  pred.ws > 0         -> 前驱取消了，承诺作废 -> 跳过它找新前驱重新握手
  pred.ws == 0/PROPAGATE -> CAS(->SIGNAL) 建立承诺；无论成败都返回 false（先不 park）
```

**为什么 CAS 建立承诺后还要返回 false 再自旋一次**（Day03 没讲的兜底链）：

```java
} else {
    // 前驱是 0 或 PROPAGATE，CAS 置 SIGNAL
    compareAndSetWaitStatus(pred, ws, Node.SIGNAL);
}
return false;   // <-- 注意：即使 CAS 成功也返回 false，本轮绝不 park
```

```text
返回 false -> acquireQueued 的 for(;;) 回到顶部重新判断：
  1. 若此刻前驱是 head 且 tryAcquire 成功 -> 直接拿锁走人（省一次 park/unpark）
  2. 若 CAS 置 SIGNAL 与前驱的 release 撞车（前驱刚好在清状态唤醒）：
     -> 本轮自旋重新握手，下一轮再看到 SIGNAL 才 park
     -> 双保险：状态可能瞬变，但"park 前必有承诺"这个不变式永不破坏
```

**架构师经验**：把 SIGNAL 理解成"承诺"后，AQS 所有状态操作都可读成一句话——**入队者建立承诺，离队者兑现承诺，取消者转移承诺，兑现失败者（分支 C）代理兑现**。面试时用"承诺-兑现"模型讲 AQS，比背流程高一个层次。

#### 4.2.3 完整竞态时序图（现象1 的微观基础）

```text
T1（等待者 node）                         T2（持锁者 = head）          T3（插队者）

tryAcquire 失败
addWaiter：node.prev = head
                                          tryRelease 成功（state=0）
                                          h.waitStatus == 0
                                          -- 无人承诺，不 unpark --
                                          return true
shouldParkAfterFailedAcquire:
  CAS(head: 0 -> SIGNAL) 成功
  返回 false（本轮不 park，再自旋）
                                          (T2 已离开)
                                                                          tryAcquire
                                                                          CAS(0->1) 成功
tryAcquire 又失败（被 T3 插队，非公平）
shouldParkAfterFailedAcquire:
  head.ws == SIGNAL（承诺还在）-> 返回 true
park()  <- 睡眠
                                                                          ...临界区...
                                                                          release:
                                                                          h=head=T3node
                                                                          ws=SIGNAL(!=0)
                                                                          unparkSuccessor:
                                                                          unpark(T1)
T1 醒来（许可到） -> 回到 for(;;) 顶部重新竞争
```

注意图中 T3 的非公平插队发生在 T2 释放与 T1 被唤醒之间——这正是 Day03 讲过的"非公平锁插队窗口"，而本图补全了**T1 为什么没有被丢下**：head 上的 SIGNAL 承诺由新的持锁者 T3 兑现。

#### 4.2.4 spurious wakeup（虚假唤醒）与 while 循环防线

LockSupport.park 的 Javadoc 明确警告：

```text
"The call spuriously (that is, for no reason) returns."
（park 可能毫无理由地返回）
```

底层原因：HotSpot 的 park 建立在 `pthread_cond_timedwait` 上，而 POSIX 规范**允许**条件变量虚假唤醒（futex 重试、信号、多核内存序实现细节等）。这不是 bug，是规范留的实现自由度。

AQS 的防线就是 `acquireQueued` 的 `for(;;)` 结构：

```java
for (;;) {                                    // 防线：醒来后绝不"信任"唤醒理由
    final Node p = node.predecessor();
    if (p == head && tryAcquire(arg)) { ... }  // 每次醒来重新竞争
    if (shouldParkAfterFailedAcquire(p, node)  // 每次睡前重新握手
        && parkAndCheckInterrupt())
        interrupted = true;                    // park 醒来只带回答案：是否被中断
}
```

```text
park 醒来只有 3 种可能，醒来后一律回到循环顶部重新判断条件：
  1. 被 unpark（承诺兑现）-> 重新 tryAcquire
  2. 被中断 -> 记录标志，重新 tryAcquire（acquire 语义）
  3. 虚假唤醒（无理由）-> 重新 tryAcquire，失败重新握手再睡

对比业务代码常见错误：
  错误：if (条件不满足) condition.await();      // 虚假唤醒一次就穿透
  正确：while (条件不满足) condition.await();   // JDK 文档与 Effective Java 一致要求
——AQS 源码本身就是"用 while 防虚假唤醒"的最高范本
```

```text
小结：
关键认知 1：park/unpark 是 0/1 许可模型，unpark 可先于 park 发放，天然不丢唤醒
关键认知 2：SIGNAL = 前驱的唤醒承诺；park 前必须完成握手，否则可能永久 park
关键认知 3：置 SIGNAL 成功也返回 false 再自旋一次——防与 release 撞车的兜底
关键认知 4：park 允许虚假唤醒（POSIX 规范），醒来必须 while 循环重判条件
```

### 4.3 中断语义全解——acquire 为什么"不响应"中断

#### 4.3.1 acquire 的"延迟响应"设计：selfInterrupt

Day03 讲过 acquireQueued 返回"是否被中断"，但没讲透这个设计。完整链条：

```java
public final void acquire(int arg) {
    if (!tryAcquire(arg) &&
        acquireQueued(addWaiter(Node.EXCLUSIVE), arg))
        selfInterrupt();                       // <-- 拿到锁之后，补上中断标志
}

private final boolean parkAndCheckInterrupt() {
    LockSupport.park(this);
    return Thread.interrupted();               // <-- 清除标志并返回"是否被中断过"
}

static void selfInterrupt() {
    Thread.currentThread().interrupt();        // <-- 再把标志补回去
}
```

为什么绕一圈"清除再补回"？因为 acquire 的语义是**"我不响应中断，一定要拿到锁"**：

```text
设计目标：ReentrantLock.lock() 不抛 InterruptedException，
         但又不能"吞掉"中断（上层可能依赖中断做取消，如线程池 shutdown）

实现手法：
  1. park 被中断唤醒 -> Thread.interrupted() 清除标志（必须清除，
     否则下一次 park 会立即返回，变成忙等自旋）
  2. 继续 tryAcquire 直到成功 -> 拿到锁，acquireQueued 返回 interrupted=true
  3. selfInterrupt() 把中断标志补回 -> 上层代码在临界区后能感知到中断

效果：中断被"延迟响应"——不阻止获取锁，但绝不丢失中断信号
```

**架构师经验**：这是"语义正确性优先于实现便利"的范本。如果不清除标志，park 会立刻返回导致自旋烧 CPU；如果清除后不补回，中断信号被吞，破坏上层取消机制（如 Future.cancel / 线程池 shutdownNow 的语义链）。**一个中断位，两条语义线（获取成功 + 信号不丢），AQS 用 3 行代码同时满足**。

#### 4.3.2 acquireInterruptibly：真响应中断的兄弟版本

```java
public final void acquireInterruptibly(int arg)
        throws InterruptedException {
    if (Thread.interrupted())                  // [1] 入口快速检查（throwIfInterrupted 语义）
        throw new InterruptedException();      //     连队都还没排，先看有没有"预置中断"
    if (!tryAcquire(arg))
        doAcquireInterruptibly(arg);           // [2] 排队版：park 醒来发现中断直接抛
}
```

doAcquireInterruptibly 与 acquireQueued 的唯一差异：

```java
if (shouldParkAfterFailedAcquire(p, node) &&
    parkAndCheckInterrupt())
    throw new InterruptedException();          // <-- acquireQueued 这里是 interrupted = true
```

```text
对照表（独占获取的 4 个变体）：
--------------------------------------------------------------------
方法                中断语义              超时语义      取消触发
--------------------------------------------------------------------
acquire             忽略（selfInterrupt   无            异常
                    延迟补回）
acquireInterruptibly 立即抛 Interrupted   无            中断 + 异常
                    Exception
tryAcquireNanos      立即抛                超时返回     中断 + 超时 + 异常
                    false
lockInterruptibly    = acquireInterruptibly（ReentrantLock 门面）
tryLock(timeout)     = tryAcquireNanos（ReentrantLock 门面）   <-- 现象1 的调用入口
```

#### 4.3.3 Condition 的中断三态：0 / THROW_IE / REINTERRUPT

Condition.await 的中断语义比 acquire 复杂得多，因为**中断可能落在两个队列的两个时间窗**（条件队列等待期 / 已被 signal 转移到同步队列后）。JDK 8 用一个 int 表达三态：

```java
/** Mode meaning to reinterrupt on exit from wait */
private static final int REINTERRUPT =  1;    // 中断发生在 signal 之后 -> 退出前自我中断
/** Mode meaning to throw InterruptedException on exit from wait */
private static final int THROW_IE    = -1;    // 中断发生在 signal 之前 -> 退出时抛异常
// interruptMode == 0：等待期间没有被中断
```

**为什么必须区分两态**——语义正确性：

```text
THROW_IE（中断先于 signal）：
  这是一次"有效的取消等待"——signal 从没发生过，
  await 应该像普通可中断方法一样抛 InterruptedException，调用方知道"没等到"

REINTERRUPT（中断后于 signal）：
  signal 已经发生，唤醒"契约"已履行，
  此时中断只是"顺带"打了一下；await 不能抛异常假装没等到，
  只能在拿到锁返回前 selfInterrupt 把标志还给上层
```

#### 4.3.4 checkInterruptWhileWaiting：一次 CAS 裁决"中断在前还是在后"

```java
private int checkInterruptWhileWaiting(Node node) {
    return Thread.interrupted() ?
        (transferAfterCancelledWait(node) ? THROW_IE : REINTERRUPT) :
        0;
}
```

裁决的核心在 transferAfterCancelledWait（**与 signal 路径共用的裁决点**）：

```java
final boolean transferAfterCancelledWait(Node node) {
    if (compareAndSetWaitStatus(node, Node.CONDITION, 0)) {
        // [1] CAS(CONDITION -> 0) 成功：
        //     说明此刻 signal 还没碰过这个节点（signal 的第一步也是这个 CAS）
        //     -> 中断发生在 signal 之前 -> 自己负责入队
        enq(node);
        return true;                           // -> THROW_IE
    }
    // [2] CAS 失败：signal 已经先一步把状态改了，正在执行 enq 转移
    while (!isOnSyncQueue(node))
        Thread.yield();                        //     等 signal 的 enq 完成（不能抢）
    // [3] 若 signal 期间节点又被取消（ws 已变），也当作"signal 已发生"
    if (node.waitStatus == Node.CONDITION)
        node.waitStatus = 0;                   //     （超时+取消竞态的兜底）
    return false;                              // -> REINTERRUPT
}
```

```text
裁决时序图（signal vs 中断 的竞态）：

T_wait（条件队列 park 中）          T_signal（持锁 signal）           任意线程 interrupt(T_wait)

                                   signal() -> doSignal
                                   transferForSignal(node):
                                   CAS(CONDITION -> 0) 成功  [A]
                                   enq(node) 入同步队列...
                                                                     interrupt(T_wait)
T_wait park 醒来（中断）
Thread.interrupted() == true
checkInterruptWhileWaiting:
  transferAfterCancelledWait:
    CAS(CONDITION -> 0) 失败  [B≠CONDITION]
    -> "signal 先动了手" [A 在 B 之前]
    -> 自旋等 isOnSyncQueue(node)==true（signal 的 enq 收尾）
    -> return false -> REINTERRUPT（返回前 selfInterrupt）

若时序对调（中断先醒，先执行 CAS 成功）：
    -> "signal 还没来" -> 自己 enq -> return true -> THROW_IE（抛异常）
```

**关键认知**：`CAS(CONDITION -> 0)` 是**唯一裁决点**——signal 的 transferForSignal 和取消的 transferAfterCancelledWait 都以它为第一步，**谁 CAS 成功谁负责把节点转移进同步队列**（详见 4.4）。中断与 signal 的先后关系不需要任何时间戳/锁，由这一次原子操作天然裁决。这是整个 AQS 里最优雅的竞态设计之一。

#### 4.3.5 parkAndCheckInterrupt 为什么用 Thread.interrupted()

```java
return Thread.interrupted();    // 清除并返回
// 而不是 Thread.currentThread().isInterrupted()    // 只查不清
```

```text
必须清除的两个理由：
  1. 死循环风险：park 对"中断标志已置位"的线程立即返回。
     若只查不清，acquireQueued 每次 parkAndCheckInterrupt 都立即返回
     -> for(;;) 变成忙等自旋，烧满 CPU（这正是大量"消失的中断"造成的经典事故模式）
  2. 语义分派：清除后返回 true，让调用方自己决定怎么"表达"这次中断：
     - acquireQueued：interrupted = true（记下来，拿锁后 selfInterrupt 补回）
     - doAcquireInterruptibly：直接抛异常（标志已清，异常本身就是表达）
     - await：进入三态裁决（THROW_IE 用异常表达，REINTERRUPT 用补回表达）
```

```text
小结：
关键认知 1：acquire = 忽略中断但 selfInterrupt 补回，"延迟响应、绝不丢失"
关键认知 2：Condition 中断三态由"中断相对 signal 的位置"决定，语义上必须区分
关键认知 3：CAS(CONDITION->0) 是 signal 与取消的共享裁决点，谁成功谁负责转移
关键认知 4：Thread.interrupted() 必须清除标志，否则 park 退化成自旋
```

### 4.4 AQS 的"私有穿透"API——Condition 与同步队列的桥

#### 4.4.1 isOnSyncQueue / findNodeFromTail：为什么必须从尾找

await 的 park 醒来后第一件事是问"我还在条件队列吗，还是已被 signal 转到同步队列了"：

```java
final boolean isOnSyncQueue(Node node) {
    if (node.waitStatus == Node.CONDITION || node.prev == null)
        return false;                    // [1] 状态还是 CONDITION、或没有 prev
                                        //     -> 一定还在条件队列（条件队列用 nextWaiter，无 prev）
    if (node.next != null)               // [2] 有 next -> 一定已在同步队列
        return true;                     //     （入队最后一步 t.next = node 已完成）
    /*
     * node.prev can be non-null, but not yet on the queue because
     * the CAS to place it on the queue may have failed.
     */
    return findNodeFromTail(node);       // [3] prev 已指、next 还没接 -> 入队进行中！
                                        //     只能从尾确认
}

private boolean findNodeFromTail(Node node) {
    Node t = tail;
    for (;;) {
        if (t == node) return true;      // 从 tail 沿 prev 反向找
        if (t == null) return false;     // 找到头都没 -> 确实不在同步队列
        t = t.prev;
    }
}
```

为什么存在"prev 已指、next 未接"的中间态？回看 enq（Day03 已讲，标注重点）：

```java
} else {                          // 加入尾部
    node.prev = t;                // [a] 先接 prev（普通写，立即可见性弱）
    if (compareAndSetTail(t, node)) {   // [b] 再 CAS tail（入队"提交点"）
        t.next = node;            // [c] 最后接 next —— [b][c] 之间就是中间态！
        return t;
    }
}
```

```text
中间态窗口（入队进行中）：
      tail
       |
      [t] ---next 还没改--> (node.prev = t 已生效)
       ↑__________prev__________|

此刻 node.prev != null（[a] 完成）但 node.next == null（[c] 未完成）
isOnSyncQueue 必须判"true"（它马上就是正式队员），而唯一可靠的验证方式：
从 tail 沿 prev 链找——prev 链在 [a] 之后永远完整（与 unparkSuccessor 从尾找同根同源，
Day03 已讲后者，此处补充：这是 AQS 里"prev 可信、next 滞后"的总原则的第二个体现）
```

**架构师经验**："**next 指针存在滞后窗口，prev 指针写入即有效**"是读 AQS 源码的总钥匙——unparkSuccessor 从尾找、findNodeFromTail 从尾找、cancelAcquire 跳前驱用 prev 链，全部由这一条原则统摄。面试遇到任何"为什么从尾遍历"问题，答案都是它。

#### 4.4.2 transferForSignal vs transferAfterCancelledWait：共享裁决点的对偶

两个方法分别由 signal 线程和"取消等待"线程（超时/中断）调用，**第一步完全相同**：

```java
// signal 路径（持锁线程调用）
final boolean transferForSignal(Node node) {
    if (!compareAndSetWaitStatus(node, Node.CONDITION, 0))   // [裁决 CAS]
        return false;          // 失败：节点已被取消 -> doSignal 换下一个等待者
    Node p = enq(node);        // 成功者负责：转入同步队列
    int ws = p.waitStatus;
    if (ws > 0 || !compareAndSetWaitStatus(p, ws, Node.SIGNAL))
        LockSupport.unpark(node.thread);   // 前驱取消/置 SIGNAL 失败 -> 直接唤醒，
                                          // 否则等前驱 release 时统一唤醒
    return true;
}

// 取消路径（等待者自己调用：超时 transferAfterCancelledWait，见 4.3.4）
// CAS 成功 -> 自己 enq；CAS 失败 -> yield 等 signal 的 enq 收尾
```

```text
对偶关系表：
--------------------------------------------------------------------
                    transferForSignal       transferAfterCancelledWait
调用者              signal 线程（持锁）       等待者自己（超时/中断醒来）
裁决 CAS           CAS(CONDITION -> 0)      同一个 CAS
CAS 成功           负责 enq 转移             负责 enq 转移
CAS 失败           换下一个等待者            yield 等对方转移完成
后续唤醒           尽量交给前驱 release      自己已在跑，直接去 acquireQueued
--------------------------------------------------------------------
设计效果：signal / 超时 / 中断 三方任意并发，
         每个节点恰好被一方转移一次——无锁下的"恰好一次"语义
```

顺带补一个 Day03 没讲的条件队列细节——条件队列的取消也是惰性清理：

```java
// addConditionWaiter 入队前，发现队尾已取消 -> 顺手清扫整条条件队列
private Node addConditionWaiter() {
    Node t = lastWaiter;
    if (t != null && t.waitStatus != Node.CONDITION) {
        unlinkCancelledWaiters();       // 摘除所有非 CONDITION 节点（类似 GC 标记清扫）
        t = lastWaiter;
    }
    Node node = new Node(Thread.currentThread(), Node.CONDITION);
    if (t == null) firstWaiter = node; else t.nextWaiter = node;
    lastWaiter = node;
    return node;
}
```

#### 4.4.3 查询/审计类 API 的运维价值（isOwnedBy 与队列观测）

```java
// Condition 是否属于某把锁（await 前校验，防止跨锁用条件的编码错误）
final boolean isOwnedBy(AbstractQueuedSynchronizer sync) {
    return sync == AbstractQueuedSynchronizer.this;
}
```

公开的观测类 API 在生产排障时价值极大（现象1/3 的定位就靠它们）：

```text
API                              作用                          事故中的用法
--------------------------------------------------------------------------------
getQueueLength()                 同步队列长度估计              现象1：823 -> 告警阈值
hasQueuedThreads()               是否有人在排队                现象1：state=0 但 true
getQueuedThreads()               队列线程快照（保护性拷贝）    jstack 之外的二次证据
availablePermits()（Semaphore）  剩余许可                      现象3：=0 且通话=0 -> 泄漏
hasWaiters(Condition)            条件队列是否非空              现象2：await 超时后仍排队
getWaitQueueLength(Condition)    条件队列长度                  同上
hasQueuedPredecessors()          公平性判断依据                现象4：公平锁热路径开销
```

**架构师经验**：**选同步器时就要问"它暴露哪些观测面"**。ReentrantLock/Semaphore 的队列长度、许可数都是天然的业务指标——把 `availablePermits` 接进 Prometheus，现象3 这类泄漏 3 分钟就能定位，而不是等用户报障。可观测性不是事后补的，是选型的一部分。

```text
小结：
关键认知 1：next 滞后 / prev 即时，是一切"从尾找"的总原则
关键认知 2：isOnSyncQueue 的三分支覆盖了"条件队列/同步队列/入队中间态"三种形态
关键认知 3：signal 与取消共享 CAS(CONDITION->0) 裁决，谁成功谁转移，恰好一次
关键认知 4：AQS 自带观测 API，同步器选型时把"可观测面"纳入评估
```

### 4.5 JDK 15+ AQS 重写差异——JDK-8229442

#### 4.5.1 重写动机：旧实现"能跑，但没人敢动"

```text
JDK-8229442：AQS and lock classes: rewrite or decompose
时间：2019 提出，2020 落地 JDK 15（Martin Buchholz 主笔，Doug Lea 审校）

动机 1：复杂度失控
  旧实现经 JDK5->14 十几年补丁式演化：
  acquireQueued / doAcquireInterruptibly / doAcquireNanos / doAcquireShared /
  doAcquireSharedInterruptibly / doAcquireSharedNanos —— 6 个 90% 相似的循环
  cancelAcquire 的"乐观 CAS + 部分失败容忍"极难推理（4.1 深挖过的惰性尸体）

动机 2：已知竞态与修复成本
  取消/释放/转移交错下存在若干"延迟唤醒/重复唤醒"边界竞态（如 JDK-8229441 一类
  missed signal 报告），逐个打补丁的验证成本越来越高

动机 3：可维护性与可验证性
  重写目标排序：正确性 > 简单性 > 性能（结果性能持平或略升）
  新实现用"串行化队列变更"替代"全并发变更 + 容错"，正确性论证变得可行
```

#### 4.5.2 新 Node：状态语义翻转

JDK 17 主干摘录（有删减）：

```java
static final class Node {
    static final int WAITING   = 1;           // 必须为正：已 park 等待，可能需要 signal
    static final int CANCELLED = 0x80000000;  // 必须为负：取消（吸收态）
    static final int COND      = 2;           // 正：在条件等待

    Node prev, next;          // 同步队列双向链表
    volatile Thread waiter;   // 原来的 thread 字段改名 waiter
    volatile int status;
}
```

与 JDK 8 的结构性差异：

```text
JDK 8                                     JDK 15+
--------------------------------------------------------------------
waitStatus: CANCELLED(1)/SIGNAL(-1)/      status: CANCELLED(负)/WAITING(1)/
            CONDITION(-2)/PROPAGATE(-3)/0          COND(2)/0
            （正数=取消，负数=有效）        （正数=有效，负数=取消——语义翻转）
thread / nextWaiter 字段                   waiter；nextWaiter 被删除
SHARED / EXCLUSIVE 节点模式标记             删除（共享/独占由获取方法自身区分）
PROPAGATE 状态                             删除（传播改为头部轮转重查）
Node 里复用 nextWaiter 兼作模式标记          条件等待改用独立的 Treiber 栈
```

**关键认知**：状态语义从"负数才有效"翻转为"正数才有效"，重写后 `status < 0` 一律表示取消，判断更直觉，也让 CANCELLED 可以携带更多信息位（0x80000000 是符号位掩码）。

#### 4.5.3 locked 队列：从尾到头的"锁定链"

旧实现的队列变更是**全并发乐观**的（CAS 失败就认了，尸体留着）；新实现引入**串行化协议**：

```text
locked 队列核心思想（源自重写后的类文档注释）：

队列变更（摘除节点、改 next 指针）前，先"锁住"相关节点——
通过 CAS 该节点的 status（如把 WAITING 改成中间态）获得节点"所有权"；
同一时刻一个节点只可能被一个线程"持有"，持有者独占地修改它的链接。

效果：形成一条从 tail 向 head 传播的"锁定链"：
      tail 的摘除者锁 tail -> 操作完成释放 -> 顺链向前...
      所有物理摘除都串行化，摘除后的链表永远"干净"（无尸体）

替代了旧版的：
  cancelAcquire 乐观 CAS + 失败容忍 + node.next=node 自链接 + 惰性清扫
```

#### 4.5.4 新方法速览与 unparkSuccessor 的去向

```text
新方法（JDK 15+ 源码可见）                    职责
--------------------------------------------------------------------
enqueue(Node)                 替代 addWaiter + enq（快速路径 + 自旋合并）
tryInitializeHead()           惰性初始化头哨兵
cleanQueue()                  替代 cancelAcquire 的物理清理：反复从尾扫描，
                              在锁定链保护下 unsplice 所有 CANCELLED 节点，
                              直到扫不到为止（对比 JDK8 的"各扫门前雪"）
signalNext(Node h)            替代 unparkSuccessor 的"兑现承诺"角色：
                              只看 h.next，直接 unpark（见下）
signalNextIfShared(...)       共享版唤醒（传播路径）
rewindStacks()                条件栈修复：转移条件等待者时发现已取消节点，
                              把栈"倒带"重整（配合 Treiber 栈）
findNodeFromTail(Node)        保留（isOnSyncQueue 的兜底，从尾找原则不变）
isOnSyncQueue(Node)           保留（语义与 JDK 8 一致）
acquire(node, arg, shared,    6 个 doAcquire* 合一 + 自适应自旋
        interruptible, timed, nanos)          （park 前先有限自旋，短等待零 park）
```

**unparkSuccessor"从尾找"的去向**（面试高频追问）：

```text
JDK 8：unparkSuccessor 里 s = node.next 无效/为空时，从 tail 反向找第一个有效节点
       ——因为 next 有滞后窗口且尸体未物理清除，从 head 方向找不可靠

JDK 15+：release 路径只剩 signalNext(head)，只看 head.next，不再有从尾扫描！
       可行的原因：
         1. 取消节点在 cleanQueue 的锁定链保护下被及时物理 unsplice，
            head 附近的 next 链恢复可信
         2. 若 head.next 恰处于入队中间态（next 未接上），新入队线程会在
            acquire 的自旋/握手协议里自行重查前驱，唤醒责任闭环不依赖释放者扫描
         3. 从尾扫描的热路径开销（现象1 的 O(n)）随之消失——重写顺带消灭了
            "取消风暴拖慢 release"这个我们在现象1 里踩的坑

注意：从尾遍历并没有绝迹——findNodeFromTail 依然从尾找（入队中间态判定），
     只是退出了 release 热路径
```

#### 4.5.5 面试怎么答：讲 JDK 8 还是 JDK 21

```text
推荐答题框架（30 秒版）：
"我源码精读的是 JDK 8 版本，acquire/cancelAcquire/Condition 的机制我能逐行讲。
 同时我知道 JDK 15 按 JDK-8229442 整体重写过：Node 状态语义翻转成
 正数有效，PROPAGATE 和 SIGNAL 被取消，6 个 doAcquire 合并成一个带自适应自旋的
 acquire，队列变更改成从尾到头的 locked 链串行化，cleanQueue 替代了旧的
 惰性取消清理，release 路径的 unparkSuccessor 从尾扫描被 signalNext 取代。
 两版的共性是 CLH 变体双向队列 + state + 模板方法这些骨架不变。"

加分点：
1. 能说出重写动机是"正确性 > 简单性 > 性能"的取舍，而不是性能
2. 能对比 cancelAcquire(惰性) vs cleanQueue(锁定链主动清扫) —— 呼应现象1
3. 知道 isOnSyncQueue/findNodeFromTail 跨版本保留，"从尾找"原则源于
   next 滞后窗口——这是两版共同的不变量
```

```text
小结：
关键认知 1：JDK 15 重写（JDK-8229442）目标是正确性与可维护性，性能持平
关键认知 2：locked 队列把"乐观并发 + 容忍尸体"换成"锁定链串行变更 + 干净链表"
关键认知 3：signalNext 只看 head.next，从尾扫描退出 release 热路径
关键认知 4：面试以 JDK 8 为主线逐行讲，用重写差异收尾，展示知识有"版本维度"
```

### 4.6 生产事故反推——逐现象：证据 -> 机制 -> 根因 -> 修复

#### 4.6.1 现象1 反推：取消风暴下的 CANCELLED 尸体堆积与唤醒雪崩

```text
证据链：
E1  300+ 线程 WAITING(parking)，栈顶 doAcquireSharedNanos -> CountDownLatch.await
E2  连续 3 次快照线程 ID 换了 40% -> 不是死锁，是"极慢的醒来 + 上游重试补充"
E3  AQS 队列 dump：823 节点，516 个 CANCELLED -> 队列 63% 是尸体
E4  锁 state=0 -> 没有持锁者，队列却在排队 -> 唤醒链路出了问题

机制反推（用到本文 4.1 / 4.2）：
M1  doAcquireSharedNanos 超时 return false 时 failed 仍为 true
    -> 每个超时的 await(30s) 都触发一次 cancelAcquire（4.1.1）
M2  流感季下游变慢 + 上游统一 30s 超时且无退避 -> 每秒上千线程同时到 deadline
    -> 取消风暴：CAS(tail) 竞争 + pred 链并发取消 -> 大量节点只被标记未摘除（4.1.4）
M3  尸体堆积 516 个，惰性清理速度 < 生产速度
    -> 每次 release 的 unparkSuccessor：head.next 无效 -> 从尾遍历 823 个节点
    -> 唤醒延迟从 μs 级变 ms 级（4.1.2 分支 C + 4.2.2）
M4  唤醒变慢 -> 上游更多超时 -> 更多取消 -> 队列更长：正反馈雪崩
M5  state=0 仍有排队：非公平下新线程持续 CAS 插队成功（Day03 讲过的插队窗口），
    队列中被承诺唤醒的老线程醒来又抢不过 -> 快照呈现"锁空闲但 300 人 WAITING"

根因：
R1  业务侧：上游 30s 硬超时 + 无退避重试，制造整批同时取消的风暴
R2  认知侧：团队把"await 超时返回 false"当成零成本，不知道每次超时都是一次
    队列写操作（cancelAcquire），高并发下有 O(n) 级清理/遍历代价

修复（分三层）：
```

```java
// 修复 1（止血）：超时与上游对齐 + 随机化，打散"整批同刻超时"
boolean done = latch.await(45, TimeUnit.SECONDS);   // 与网关超时对齐，避免级联
// 上游重试加抖动：backoff = base * random(0.5~1.5)，消除同步到期

// 修复 2（止血）：批量接口熔断降级，超时比例 > 50% 直接切换逐单模式
if (timeoutRatio.gauge() > 0.5) {
    return batchFallbackService.createSequential(tasks);  // 降级开关
}

// 修复 3（长效）：把 AQS 队列长度纳入监控——CANCELLED 无法直接观测，
// 但"state 空闲 + 队列长"的组合就是尸体堆积的代理指标
@Scheduled(fixedDelay = 1000)
public void monitor() {
    Metrics.gauge("order.batch.queue.length", batchLock.getQueueLength());
    // 阈值经验值：读写锁队列 > 200 持续 30s 告警
}
```

```text
面试讲述模板（STAR 30 秒）：
"流感季凌晨，300 线程 park 着、锁 state=0、队列 823 节点 63% 是 CANCELLED。
 我从 jstack 栈顶的 doAcquireSharedNanos 判断这是 CountDownLatch 超时路径——
 JDK8 里超时返回前必走 cancelAcquire，而取消清理是惰性的，风暴下尸体堆积，
 每次 release 的 unparkSuccessor 要从尾遍历跳过它们，唤醒延迟 μs->ms，
 上游更多超时更多取消，正反馈雪崩。修复是超时对齐+随机退避+熔断降级，
 并把 getQueueLength 纳入监控。这件事让我把 await 超时当成一种'
 有代价的队列写操作'来审视。"
```

#### 4.6.2 现象2 反推：异常路径未 countDown + await 超时后的"重新排队"语义

```text
证据链：
E1  grep "订单生成完成" 恰好 1000 条 -> 所有任务都执行到了"完成日志"
E2  监控打点 latch 剩余计数 = 1 -> 差 1 个 countDown
E3  await(30s) 全批次超时 -> state 永远 > 0
E4  次生现象：Condition.awaitNanos 超时后 8.2s 才返回

机制反推（用到 4.1.1 / 4.3.4 / 4.4）：
M1  出事批次代码（第 31 天凌晨前的变更）：
      worker: try {
          Order o = orderService.create(t);        // 成功
          log.info("订单生成完成 orderId={}", ...); // <- 日志在这里打了！
          auditClient.report(o);                   // 第 30 天新增：监管审计上报
          latch.countDown();                       // countDown 在最后
      } catch (Exception e) { log.error(...); }    // 异常路径没有 countDown！
    流感季凌晨审计服务抖动 -> 1/1000 个任务在"打完完成日志"之后、countDown 之前
    抛 IOException -> "日志显示完成"与"没有 countDown"同时成立，E1/E2 矛盾解释清
M2  CountDownLatch.tryAcquireShared = (getState()==0) ? 1 : -1（Day03 已讲）
    -> state=1 永不归零 -> 所有 await(30s) 超时 -> 又反向加剧现象1 的取消风暴
M3  次生现象（8.2s 才返回）的 AQS 语义：
    Condition.awaitNanos 超时路径：
      transferAfterCancelledWait(node)            // 自己 CAS 转移节点回同步队列（4.3.4）
      -> acquireQueued(node, savedState)          // !! 必须重新拿锁 !!
    为什么必须拿锁：await 入口 fullyRelease 把"全部重入次数"都还了（Day03 讲过 5 步），
    await 返回时必须恢复持锁不变式（"从 await 返回时必然持有锁"是 Condition 契约），
    所以超时 ≠ 立即返回——超时后还要排队重新 acquire，锁竞争激烈时（正是当晚）
    这个"补充排队"耗了 8.2s
M4  而普通 CountDownLatch.await(30s) 超时没有"重新拿锁"一说（它不持锁），
    它走 doAcquireSharedNanos 超时 -> cancelAcquire 出队（4.1.1），直接返回 false

根因：
R1  业务侧：countDown 不在 finally——"任务成功"与"任务结束"两个概念被混用
R2  认知侧：团队不知道 Condition.await 超时的完整语义是
    "取消等待 + 转移回同步队列 + 重新获取锁"，把 await 超时当成"到点必返"
```

修复代码对照：

```java
// 修复前（根因代码）
executor.submit(() -> {
    try {
        Order o = orderService.create(t);
        log.info("订单生成完成 orderId={}", o.getId());
        auditClient.report(o);          // 抖动抛 IOException
        latch.countDown();              // 永远走不到
    } catch (Exception e) {
        log.error("订单生成失败", e);    // 吞掉异常，也没 countDown
    }
});

// 修复后 1：countDown 进 finally，"结束即计数"（成功失败都算"到达"）
executor.submit(() -> {
    try {
        Order o = orderService.create(t);
        log.info("订单生成完成 orderId={}", o.getId());
        auditClient.report(o);
        successCount.incrementAndGet();
    } catch (Exception e) {
        failedCount.incrementAndGet();   // 失败单独记账，业务语义不丢
        log.error("订单生成失败 taskId={}", t.getId(), e);
    } finally {
        latch.countDown();               // 契约 C2：countDown in finally
    }
});

// 修复后 2（更现代）：整体换成 CompletableFuture，把"计数"交回框架
List<CompletableFuture<Order>> fs = tasks.stream()
    .map(t -> CompletableFuture.supplyAsync(() -> create(t), executor)
        .exceptionally(ex -> fallbackOrder(t, ex)))     // 异常转默认值，不丢
    .collect(toList());
CompletableFuture.allOf(fs.toArray(new CompletableFuture[0]))
    .get(45, TimeUnit.SECONDS);                          // 超时语义与降级集中在这一处

// 修复后 3：监控对账——"任务结束数"与"countDown 数"必须相等
Metrics.counter("batch.task.finished");
Metrics.counter("batch.latch.counted");   // 两者差值 != 0 立即告警（E2 证据的常态化）
```

```text
关键认知：await 超时的完整链路 = 取消等待 -> CAS 转移回同步队列 -> 重新 acquire
（可能再阻塞）-> 持锁返回。Condition 超时返回的耗时上限 = 超时时间 + 重新拿锁时间。
给 Condition 超时做 SLO 时必须把后者算进去。
```

#### 4.6.3 现象3 反推：tryAcquire 成功后异常路径未 release 的许可泄漏

```text
证据链：
E1  availablePermits() = 0，activeCalls() = 0 —— "许可没了但没人用"
E2  1000 路许可，1 小时 137 次 join 失败（弱网超时）
E3  失败请求全部返回"系统繁忙"（异常被 catch 后转 BUSY）

机制反推：
M1  出事代码：
      if (!sfuSemaphore.tryAcquire()) return CallTicket.busy("系统繁忙");
      SfuChannel ch = sfuClient.join(roomId, userId);   // 弱网超时抛异常
      callRegistry.register(roomId, userId, ch);
      return CallTicket.ok(ch);
      // join 抛异常 -> 一路抛出 -> release 无人调用 -> state 少 1（永久）
M2  AQS 层：Semaphore.release -> tryReleaseShared(state CAS +1) -> doReleaseShared
    唤醒等待者（Day03 已讲共享释放）。release 从未被调用 -> state 单调不减
M3  为什么"泄漏的信号"这么隐蔽：
    - lock/unlock 有强制的 try-finally 编码惯例（IDE/编译器检查、CR 肌肉记忆）
    - tryAcquire 返回 boolean + release 是独立方法，二者之间隔着业务代码，
      没有"结构性配对"，异常路径一多必漏
    - Semaphore 是 fail-closed：许可耗尽后所有 tryAcquire 返回 false，
      业务表现为"容量满"而非"崩溃"，监控上像正常限流 —— 最坏的静默故障
M4  E1 的"0 许可 0 通话"就是泄漏的铁证：正常状态下
    availablePermits + activeCalls ≈ 总许可（容差为在途请求）

根因：
R1  业务侧：acquire 与 release 没有用同一把 try 结构包住
R2  架构侧：租赁型资源（许可）没有对账机制——资源账本与使用台账从不核对
```

修复代码对照（含"责任转移"模式）：

```java
// 修复前（根因代码，见 M1）

// 修复后：handedOff 责任转移模式——只有"交接成功"才不还许可
public CallTicket startCall(String roomId, String userId) {
    if (!sfuSemaphore.tryAcquire()) {
        return CallTicket.busy("系统繁忙");
    }
    boolean handedOff = false;                 // 许可责任标记
    try {
        SfuChannel ch = sfuClient.join(roomId, userId);
        callRegistry.register(roomId, userId, ch);
        handedOff = true;                      // 注册成功：许可生命周期移交给挂断逻辑
        return CallTicket.ok(ch);
    } finally {
        if (!handedOff) {
            sfuSemaphore.release();            // 契约 C3：没交接成功就必须还
        }
    }
}
// 挂断逻辑：callRegistry.unregister + semaphore.release()（同样在 finally）

// 对账监控（架构侧根治）：
@Scheduled(fixedDelay = 30_000)
public void reconcile() {
    int active = callRegistry.activeCalls();
    int leaked = TOTAL_PERMITS - sfuSemaphore.availablePermits() - active;
    leakGauge.set(leaked);
    if (leaked > 5) {                          // 容忍少量在途
        alert.fire("SFU 许可泄漏 %d 路，请检查 startCall 异常路径", leaked);
    }
}
```

```text
关键认知：Semaphore/lease 类"租约型"同步器的三条铁律——
1. acquire 后第一件事就是写 try-finally（先立契约再写业务）
2. "交接成功才算出借"，用 handedOff 标记区分"还回来"与"移交出去"
3. availablePermits 是对账字段不是状态字段——账实核对（permits + inUse = total）
   才能发现静默泄漏
```

#### 4.6.4 现象4 反推：公平读写锁的排队+唤醒 convoy

```text
证据链：
E1  吞吐跌 5.1 倍，与 JMH 复测的 5.0 倍吻合 -> 系统性开销，非偶发
E2  cs（上下文切换）50 倍，CPU sys 47% -> 瓶颈在调度不在业务
E3  P99 每 ~200ms 一次尖刺，写 QPS 恰为 5/s -> 尖刺与写锁到达完全同频

机制反推：
M1  公平 RRWL 的 readerShouldBlock/writerShouldBlock 都指向 hasQueuedPredecessors：
      （JDK8 RRWL.FairSync）
      final boolean writerShouldBlock() { return hasQueuedPredecessors(); }
      final boolean readerShouldBlock() { return hasQueuedPredecessors(); }
    -> 每次读锁获取都要"看一眼队列"：h != t 时几乎必真 -> 读者也去排队
    -> 高读并发（8.2w QPS）下队列永不空 -> 100% 读者入队
M2  入队者的完整代价（本文 4.2 的握手协议 + Day03 的流程）：
    addWaiter CAS + SIGNAL 握手 CAS + park（线程睡眠）
    + 持锁者 unpark + OS 唤醒调度（μs~ms）+ 醒来重试
    -> 单次读锁成本从 ~40ns（非公平 CAS 快路径）涨到 10μs+ 级（含两次上下文切换）
    -> cs 50 倍、sys 47% 的直接来源
M3  尖刺同频的解释——唤醒 convoy（车队效应）：
    写锁到达（每 200ms 一次）-> 读者必须让位排队 -> 队列瞬间积压一串读者
    -> 写锁释放 -> doReleaseShared 传播唤醒一串读者（Day03 讲过的传播机制）
    -> 一串线程同时苏醒抢同一个核 -> 调度排队 -> P99 出现 6-9ms 尖刺
    -> 写到达规律 -> 尖刺规律（E3）
M4  非公平 RRWL 为什么不饿死写锁（评审会当时的担忧其实是错的）：
      （JDK8 RRWL.NonfairSync）
      final boolean writerShouldBlock() { return false; }   // 写者可闯入
      final boolean readerShouldBlock() {
          return apparentlyFirstQueuedIsExclusive();         // 队首是写者时读者让路
      }
    -> apparentlyFirstQueuedIsExclusive 就是 RRWL 自带的"防写饿"补丁：
       一旦有写者排在队首，新读者主动不插队 -> 写者最多等"队首前的一小批"
    -> 当初改公平锁防的"写饿"，非公平模式已经用更便宜的方式防了

根因：
R1  决策侧：把"公平锁"当成写饿的解药，没有量化非公平 RRWL 的内置防饿机制
R2  流程侧：锁公平性这种全局部署参数，改动没有 JMH 基准 + 灰度就直接全量
```

修复与量化：

```java
// 修复：回退非公平（默认），写饿问题用"数据说话"重新评估
private final ReentrantReadWriteLock userMapLock =
        new ReentrantReadWriteLock(false);          // 非公平 + apparentlyFirstQueuedIsExclusive

// 写饿评估指标（灰度期间观察）：
//   writeAcquireWaitP99：写锁获取等待 P99（超 50ms 才考虑干预）
//   writerBypassCount：  apparentlyFirstQueuedIsExclusive 命中次数（让路是否生效）

// 若读路径确认 98% 无写竞争 -> 进一步评估 StampedLock 乐观读
// （读路径完全无 CAS、无入队，Day03 已讲，此处是落地决策链）
```

```text
公平性切换评估表（沉淀为团队 SOP）：
--------------------------------------------------------------------
维度            非公平（默认）              公平
--------------------------------------------------------------------
吞吐            高（插队省去唤醒 convoy）    低 3-10 倍（高并发下）
延迟分布        方差大（可能饥饿）           方差小、P99 有 convoy 尖刺
上下文切换      少                          多（排队+唤醒成对发生）
饥饿风险        理论存在（RRWL 有防写饿补丁） 无
适用            吞吐优先的绝大多数场景       严格 FIFO/资源公平分配语义
切换前提        -                           JMH 基准 + 灰度 + 饥饿实证
--------------------------------------------------------------------
```

```text
四现象总复盘（一页纸）：
现象    表象                        AQS 机制                     根因性质
--------------------------------------------------------------------------------
1       300 线程慢醒+队列 63% 尸体   cancelAcquire 惰性清理 +      超时风暴（配置）
                                    unparkSuccessor O(n) 从尾扫
2       await 全超时+超时后 8s 才返  异常路径漏 countDown +        使用契约缺失
                                    await 超时后须重新 acquire
3       许可=0 通话=0                release 缺失 + fail-closed    使用契约缺失+无对账
4       吞吐跌 5 倍+同频尖刺         hasQueuedPredecessors 全排队  决策无量化
                                    + 唤醒 convoy
共性：三个改造功能上都"正确"（30 天平稳），但都没经受住
     "高并发 + 取消风暴 + 异常路径"的考验——正确性正确，鲁莽性不正确。
```

### 4.7 四防闭环——同步器使用契约与防御体系

上周 JVM Day07 的四防是"监控/限流/告警/演练"，本周针对同步器特性换成"防误用 / 防泄漏 / 防饥饿 / 防卡死"。

#### 4.7.1 防误用：同步器使用契约清单（Code Review 硬卡点）

```text
C1. lock/unlock、acquire/release 必须 try-finally 配对（lock 在 try 外，Day03 已讲写法）
C2. countDown 必须放 finally——"任务结束"计数，而非"任务成功"计数（现象2）
C3. Semaphore/lease 的 acquire 成功后，所有异常路径必须 release（handedOff 模式）（现象3）
C4. 禁止裸 await()/acquire() 无限等待——一律带超时（现象1 的取消风暴也源于
    "没有超时只能靠外层杀"的历史设计）
C5. 超时/失败必须有降级路径：批量降逐单、强一致降最终一致（现象1 修复 2）
C6. CountDownLatch 一次性，禁止复用——需要循环用 CyclicBarrier/Phaser
C7. Condition.await 必须在持锁 + while(条件不满足) 中（4.2.4 虚假唤醒）
C8. 每个同步器实例必须暴露观测面：queueLength/availablePermits/
    getWaitQueueLength 进监控（4.4.3）
C9. 公平性、许可数、队列相关参数变更 = 全局变更：JMH 基准 + 灰度（现象4）
C10. 上游超时必须与下游对齐并加抖动——整批同刻超时 = 取消风暴（现象1）
```

#### 4.7.2 防泄漏：租约型资源的对账体系

```text
防泄漏三件套（以 SFU Semaphore 为例）：

1. 结构防：acquire 后立即 try-finally + handedOff 责任转移（4.6.3 修复代码）
2. 指标防：availablePermits 接 Prometheus，低水位告警
     sfu_permits_available < 总量的 20% 且 activeCalls < 容量的 50% -> 疑似泄漏
3. 对账防：定时核对 账实等式
     leaked = totalPermits - availablePermits - activeCalls（容忍在途窗口）
     leaked 持续 > 阈值 -> 告警 + 自动 dump 最近 100 次 startCall 异常栈

推广：所有"租约型"资源（连接池 permit、分布式锁 lease、限流令牌）
     都适用同一条等式：总租约 = 在用 + 闲置 + 泄漏，监控把第三项做成一等指标
```

#### 4.7.3 防饥饿：公平性监控指标与切换评估

```text
指标（非公平模式下持续采集，作为切公平的"证据链"）：
  writeAcquireWaitP99   写锁/独占获取等待 P99
  maxAcquireWaitMs      单次获取最长等待（饥饿的直接体现）
  queueLength 高水位    队列积压（现象1 的代理指标）

切换决策（对应 4.6.4 评估表）：
  只有"饥饿实证（P99/最大等待持续超 SLO）+ 业务有公平语义（排队叫号类）"
  两条同时成立才切公平；吞吐型场景优先用结构性方案（RRWL 防写饿补丁 /
  StampedLock 乐观读 / 队列削峰）替代公平锁
```

#### 4.7.4 防卡死：await 超时 + 降级开关 + 看门狗

```text
1. 所有等待有界：latch.await(45s) / condition.awaitNanos / lock.tryLock(3s)
   ——超时不是失败，是"把无界风险变成有界"的第一道闸
2. 超时后有路可走：降级开关（批量->逐单）/ 补偿队列（失败任务转异步重试）
3. 看门狗：独立线程池周期检查关键同步器的 queueLength + hasQueuedThreads，
   state 空闲但队列非空持续 N 秒 -> 自动告警（现象1 的 E4 组合常态化）
4. 记住 AQS 的两个"有界性"细节：
   - Condition.await 超时后还要重新拿锁——SLO 要算上这段（现象2 M3）
   - parkNanos 剩余时间 < spinForTimeoutThreshold(1μs) 时改自旋——
     超短超时的"精度"是忙等换的，别拿它做精确计时
```

#### 4.7.5 jcstress：并发正确性测试怎么写

单测（起两个线程 sleep 断言）验证不了内存可见性与竞态——那正是 jcstress 存在的意义：让竞态交错被系统地枚举。

以 4.8 的 TwoPhaseLatch 为被测对象，验证"开闸的 happens-before"：

```java
@JCStressTest
@Description("验证 TwoPhaseLatch：arrive 前的写，在 await 返回后必须可见")
@Outcome(id = "42",  expect = ACCEPTABLE, desc = "开闸且数据可见（正确）")
@Outcome(id = "-1",  expect = ACCEPTABLE, desc = "中断兜底（理论不出现）")
@Outcome(            expect = FORBIDDEN,  desc = "其他值=可见性破坏/开闸丢失")
@State
public class TwoPhaseLatchVisibilityTest {

    static final class Latch { /* 4.8 的 TwoPhaseLatch 内部类，略 */ }

    final TwoPhaseLatch latch = new TwoPhaseLatch();
    int data;                       // 非 volatile：正确性完全依赖同步器建立的 happens-before

    @Actor
    public void writer() {
        data = 42;                  // 开闸前的普通写
        latch.arrive();
        latch.arrive();             // 双人闸：两次 arrive 开闸
    }

    @Actor
    public void waiter(IntResult1 r) {
        try {
            latch.await();
            r.r1 = data;            // 若 releaseShared->acquireShared 的
        } catch (InterruptedException e) {   // happens-before 成立，必见 42
            r.r1 = -1;
        }
    }
}
```

```text
写 jcstress 的三个要点：
1. @State 每次迭代新建实例，被测对象是无共享历史的"一次生命周期"
2. 共享字段故意不写 volatile——就是要让"可见性只能来自同步器"成为被测命题
   （Day01 讲过的 release/acquire 内存语义在这里变成可执行断言）
3. @Outcome 必须穷举并标注 ACCEPTABLE/FORBIDDEN——出现 FORBIDDEN 即找到 bug，
   每个结果附带出现次数，可复现交错频率

工程落地：核心自研同步器进 CI 跑 jcstress（分钟级），
业务正确性用 TestNG 并发组 + 断言超时兜底（本文 4.8 的测试示例）
```

### 4.8 AQS 生态延伸——VarHandle / JUC 全景 / 自定义同步器实战

#### 4.8.1 JDK 9 VarHandle 替代 Unsafe

```java
// JDK 8：Unsafe + 手工字段偏移
private static final Unsafe U = Unsafe.getUnsafe();
private static final long STATE;
static {
    try {
        STATE = U.objectFieldOffset(
            AbstractQueuedSynchronizer.class.getDeclaredField("state"));
    } catch (Exception e) { throw new Error(e); }
}
protected final boolean compareAndSetState(int expect, int update) {
    return U.compareAndSwapInt(this, STATE, expect, update);
}

// JDK 9+：VarHandle（方法句柄视角的字段引用）
private static final VarHandle STATE;
static {
    try {
        MethodHandles.Lookup l = MethodHandles.lookup();
        STATE = l.findVarHandle(
            AbstractQueuedSynchronizer.class, "state", int.class);
    } catch (ReflectiveOperationException e) {
        throw new ExceptionInInitializerError(e);
    }
}
protected final boolean compareAndSetState(int expect, int update) {
    return STATE.compareAndSet(this, expect, update);
}
```

```text
替换原因（面试 3 点答全）：
1. 官方支持 vs 内部 API：sun.misc.Unsafe 一直是"JDK 内部 + 灰色地带"，
   JEP 260 起逐步收紧外部访问；VarHandle 是 java.lang.invoke 正式 API
2. 性能不降反升：VarHandle 是"签名多态方法"（signature-polymorphic），
   JIT 拿到精确的参数静态类型，直接内联为底层内存指令，
   避免 Unsafe 调用点的装箱/long 偏移量等抽象开销
3. 表达力更强：提供细粒度内存序的 access mode——getAcquire/setRelease/
   compareAndSet/compareAndExchange/weakCompareAndSet...，
   Day01 讲的 happen-before 半边（release/acquire）第一次有了显式编程接口
```

#### 4.8.2 AQS 在 JUC 生态的使用全景图

```text
                      AbstractQueuedSynchronizer（state + CLH 变体队列 + 模板方法）
                                        │
     ┌──────────────┬───────────────────┼────────────────────┬──────────────────┐
     │              │                   │                    │                  │
 ReentrantLock  ReentrantRead-      Semaphore          CountDownLatch    ThreadPool-
 (独占,重入)     WriteLock           (共享,许可,        (共享,一次性       Executor.Worker
 ConditionObject (共享+独占,          可批量 acquire)    计数)             (独占,不可重入,
 多条件队列      state 高16读                    tryAcquireShared:  tryAcquireShared:  判断"是否空闲
 支持)          /低16写)               state-1>=0         state==0?1:-1     可被中断"的核心)
     │              │                   │                    │                  │
     └── Sync(Nonfair/Fair) 三兄弟共享一套父类实现，只差 shouldBlock 判定（现象4）

生态演变注脚：
  FutureTask：JDK 8 还基于 AQS（state 0..5 表示生命周期），
              JDK 9 起改用 VarHandle + WaitNode 自实现，脱离 AQS —— AQS 不是终点，
              "state 状态机 + 队列"才是可复用思想
  ForkJoinPool：自带 Treiber 栈 + 相似唤醒协议，JDK 17 起直接复用新 AQS 的 Node
  线程池 Worker 细节（衔接 Day05）：Worker extends AQS，
  lock 成功=空闲，shutdown() 时 tryLock 成功的 worker 才 interruptIdleWorkers——
  一个"不可重入独占锁"的教科书用法（防止 runTask 内部调用 setCorePoolSize
  等需要拿 worker 锁的方法时被误中断）
```

#### 4.8.3 自定义同步器实战：TwoPhaseLatch（双人同时到达才开闸的门闸）

需求：问诊双医生会诊场景——两名医生都"签到"（arrive）后，等待方（await）才能放行进入会诊室。本质是"一次性栅栏"，重点演示**共享模式 + 一次性状态迁移**的标准写法。

```java
import java.util.concurrent.locks.AbstractQueuedSynchronizer;

/**
 * 双人闸：两名参与者都 arrive() 后，所有 await() 的线程被放行。
 * 语义要点：
 *  - 一次性（开闸后永远开着，重复 arrive 幂等）
 *  - await 用共享模式：开闸可同时放行任意多等待者（doReleaseShared 传播）
 */
public class TwoPhaseLatch {

    private final Sync sync = new Sync();

    /** 等待开闸（可中断；开闸瞬间返回） */
    public void await() throws InterruptedException {
        sync.acquireSharedInterruptibly(1);     // 走 4.3.2 的可中断共享获取
    }

    /** 参与者到达；第二人到达即开闸 */
    public void arrive() {
        sync.releaseShared(-1);                 // 参数仅触发 release 协议，语义在 tryReleaseShared
    }

    /** 测试/监控用：当前未到达人数（0 = 已开闸） */
    int pendingCount() { return sync.getState(); }

    private static final class Sync extends AbstractQueuedSynchronizer {
        private static final long serialVersionUID = 1L;

        Sync() { setState(2); }                  // state = 未到达的参与者数（2 人）

        /** 开闸条件：state == 0（全部到达） */
        @Override
        protected int tryAcquireShared(int acquires) {
            return (getState() == 0) ? 1 : -1;  // 1=成功且传播；-1=失败入队（Day03 已讲语义）
        }

        /** 一次性状态迁移：2 -> 0（不逐个减，原子归零） */
        @Override
        protected boolean tryReleaseShared(int releases) {
            for (;;) {
                int c = getState();
                if (c == 0)
                    return false;               // 已开闸：幂等，不再触发唤醒
                if (compareAndSetState(c, 0))   // 第二个 arrive 原子开闸
                    return true;                // true -> doReleaseShared 传播唤醒全部等待者
            }                                   // （唤醒链即 Day03 讲的 setHeadAndPropagate）
        }
    }
}
```

设计对照（面试可用）：

```text
与 CountDownLatch(N) 的差异：
  相同：state==0 才放行的共享语义（Day03 讲过其 tryAcquireShared）
  差异：countDown 是逐个 -1，arrive 是"首个到达即归零"——展示"state 迁移规则
       完全由子类定义"的模板方法威力：框架不管 state 的业务含义，只管队列与唤醒
写法要点（3 条契约）：
  1. tryAcquireShared 只读 state 做判断，绝不修改（写留给 release 侧，避免竞态）
  2. tryReleaseShared 自旋 CAS 直到成功或确认无需迁移（共享释放可能多方并发）
  3. 幂等性自己保证（c==0 返回 false）——AQS 不提供"只执行一次"的保证
```

测试（常规并发测试 + 契约断言）：

```java
public class TwoPhaseLatchTest {

    @Test
    public void 两人到齐才开闸_一人不到永不开() throws Exception {
        TwoPhaseLatch latch = new TwoPhaseLatch();
        AtomicBoolean passed = new AtomicBoolean(false);

        Thread waiter = new Thread(() -> {
            try { latch.await(); passed.set(true); }
            catch (InterruptedException ignored) { }
        }, "会诊等待者");
        waiter.start();
        Thread.sleep(100);                       // 等待者已 park
        assertFalse(passed.get());               // 无人到达：不开闸

        latch.arrive();                          // 第 1 名医生到达
        Thread.sleep(100);
        assertFalse(passed.get());               // 只到 1 人：仍不开闸
        assertEquals(1, latch.pendingCount());   // state: 2 -> 1

        latch.arrive();                          // 第 2 名医生到达 -> state=0 -> 开闸
        waiter.join(1000);
        assertTrue(passed.get());                // 等待者被 doReleaseShared 传播唤醒

        latch.arrive();                          // 开闸后重复 arrive：幂等不炸
        assertEquals(0, latch.pendingCount());
    }

    @Test(timeOut = 2000)                        // 契约 C4：测试也要有界
    public void 开闸后的新等待者不阻塞() throws Exception {
        TwoPhaseLatch latch = new TwoPhaseLatch();
        latch.arrive(); latch.arrive();          // 先开闸
        latch.await();                           // 后到的人直接过（state==0 快路径）
    }
}
```

附：独占式最小实现 Mutex（对照记忆，10 行核心）：

```java
class Mutex {
    private final Sync sync = new Sync();
    public void lock()   { sync.acquire(1); }
    public void unlock() { sync.release(1); }

    private static class Sync extends AbstractQueuedSynchronizer {
        @Override protected boolean tryAcquire(int acquires) {
            if (compareAndSetState(0, 1)) {                       // CAS 抢占
                setExclusiveOwnerThread(Thread.currentThread());  // 记录持有者（可重入的基础）
                return true;
            }
            return false;
        }
        @Override protected boolean tryRelease(int releases) {
            if (getState() == 0) throw new IllegalMonitorStateException(); // 未持锁 unlock
            setExclusiveOwnerThread(null);
            setState(0);          // 只有持锁者会走到这里（独占语义），普通写即可，无需 CAS
            return true;
        }
        @Override protected boolean isHeldExclusively() {
            return getExclusiveOwnerThread() == Thread.currentThread();
        }
    }
}
```

```text
关键认知：独占式 tryRelease 无需 CAS（天然单写者），共享式 tryReleaseShared
必须自旋 CAS（多写者并发）——这一对差异在 Day03 的读写锁段落埋过，此处亲手实现闭环。
```

---

## 五、本日能力差距与补足方向

### 差距 1：cancelAcquire 取消清理链路不熟，不知道"超时=一次队列写操作"
> Day7发现，延续 Day3 差距2（acquire/release 源码细节）

- **现状**：知道超时/中断会取消节点，但取消的 3 类触发入口（doAcquireNanos 超时返回时 failed 仍 true / doAcquireInterruptibly 抛异常 / tryAcquire 子类异常）、cancelAcquire 的 3 个清理分支、`node.next = node` 自链接 help GC 的原理、"惰性清理导致尸体堆积"的取舍全部不熟
- **架构师水平**：能白板画出 cancelAcquire 三分支决策树并解释"责任转移 vs 代理唤醒"；能讲清取消风暴下 unparkSuccessor 从尾遍历退化为 O(n) 的链路（现象1 根因）；能解释自链接为何是"把残留引用收敛为可孤立的环"
- **补足方向**：精读 JDK 8 `cancelAcquire` + `unparkSuccessor` 并写逐行注释博客；用 jcstress 复现"多线程并发超时取消"观察队列尸体；对照 JDK 17 `cleanQueue` 理解锁定链如何消灭惰性尸体

### 差距 2：park/unpark 许可机制与"承诺-兑现"模型不深，防丢唤醒设计讲不出
> Day7发现，延续 Day3 差距2

- **现状**：知道 LockSupport.park/unpark 是阻塞/唤醒，但不清楚 HotSpot Parker 的 0/1 许可模型为什么 unpark 可先于 park、SIGNAL 的"承诺-兑现"语义、置 SIGNAL 成功后为什么还返回 false 再自旋、spurious wakeup 的 POSIX 根源与 while 循环防线
- **架构师水平**：能用"承诺-兑现-转移承诺-代理兑现"四句话讲完 AQS 状态协议；能画出"释放与握手撞车"的完整竞态时序图；能解释为什么不清中断标志会让 park 退化成自旋
- **补足方向**：读 HotSpot `LockSupport.park` -> `Parker::park` 的 native 实现；对照 Object.wait/notify 的丢失唤醒反例写示例代码；把 Day02 的 synchronized park/unpark 与本文 AQS 握手协议整理成一张对比表

### 差距 3：Condition 中断三态与转移竞态不熟
> Day7发现，延续 Day3 差距4（Condition await/signal）

- **现状**：会背 await 5 步，但 THROW_IE/REINTERRUPT 的判定语义、`CAS(CONDITION->0)` 作为 signal 与取消的共享裁决点、`transferAfterCancelledWait` 失败方 yield 等待的收尾协议、`await 超时后必须重新 acquire` 的完整语义（现象2 的 8 秒谜团）都不熟
- **架构师水平**：能讲清"中断发生在 signal 前还是后"为什么必须语义区分（一个是有效取消、一个是顺带打断）；能解释裁决 CAS 如何在无锁下保证"每个节点恰好被转移一次"；给 Condition 超时做 SLO 时能算上"重新拿锁"的耗时
- **补足方向**：精读 `awaitNanos`/`await(long,TimeUnit)`/`transferForSignal`/`transferAfterCancelledWait` 四个方法；写一个"signal 与中断赛跑"的测试程序打印三态分布；整理"独占获取 4 变体 + Condition 三态"的中断语义全景表

### 差距 4：JDK 15+ AQS 重写（JDK-8229442）认知空白
> Day7发现

- **现状**：知识停留在 JDK 8 版本，完全不知道 JDK 15 重写过 AQS；不知道 locked 队列（从尾到头的锁定链）、cleanQueue/rewindStacks/signalNext、Node 状态语义翻转（正数有效）、PROPAGATE 删除、6 个 doAcquire 合一、自适应自旋
- **架构师水平**：能讲出重写动机是"正确性 > 简单性 > 性能"；能对比 cancelAcquire（惰性）与 cleanQueue（锁定链主动清扫）并联系现象1；能回答"unparkSuccessor 从尾找去哪了"（signalNext 只看 head.next，从尾扫描退出 release 热路径但活在 findNodeFromTail）
- **补足方向**：精读 JDK 17 `AbstractQueuedSynchronizer` 类头注释与 Node/cleanQueue/signalNext；跟踪 JDK-8229442 与 JDK-8229441 的邮件列表讨论；用同一段基准代码在 JDK 8/17/21 三版本跑对比，把"讲 JDK 8 收尾重写差异"的面试话术演练 3 遍

### 差距 5：同步器使用契约与租约对账没有工程化沉淀
> Day7发现，延续 Day3 差距7（简历项目 AQS 实战结合）

- **现状**：能正确使用同步器的"快乐路径"，但 try-finally 配对、countDown in finally、handedOff 责任转移、availablePermits 对账等只凭个人习惯，没有团队级契约清单；现象2/现象3 这类"异常路径泄漏"在团队 CR 中没有硬卡点
- **架构师水平**：能输出像 4.7.1 的 C1-C10 契约清单并落到 CR 模板/静态检查（如 Error Prone 自定义规则）；能把"总租约=在用+闲置+泄漏"做成通用监控组件；能设计现象3 那样的三方对账定时任务并设定容差
- **补足方向**：把 C1-C10 改造成团队 CR checklist 试点一个月；为现有系统的 Semaphore/连接池/分布式锁补齐对账监控；调研 Alibaba P3C/Error Prone 中与锁相关的自动检查项

### 差距 6：自定义同步器与 jcstress 并发正确性验证能力缺失
> Day7发现，延续 Day3 差距3（共享传播）/差距7

- **现状**：没有从零实现过基于 AQS 的自定义同步器；对"tryAcquireShared 只读不写、tryReleaseShared 自旋 CAS、幂等自己保证"这三条子类契约没有肌肉记忆；没用 jcstress 写过可见性/竞态测试，并发正确性还停留在"跑 1000 次单测没挂"
- **架构师水平**：能在 30 分钟内实现 TwoPhaseLatch 这类共享同步器并说清与 CountDownLatch 的 state 迁移差异；能写 jcstress 的 @Outcome 穷举测试验证 happens-before 假设；能区分"独占 tryRelease 无需 CAS / 共享必须自旋 CAS"并解释原因
- **补足方向**：完成 TwoPhaseLatch + Mutex + 一个"三态门"自定义同步器；把 TwoPhaseLatch 的 jcstress 用例跑进 CI；读 jcstress 官方 samples 的 @Actor/@Arbiter 组合用法

---

## 附录：AQS 源码速查（核心方法链路图）

```text
【独占获取（JDK 8）】
acquire(arg)
 ├─ tryAcquire ──────────────── 成功 -> 直接返回（乐观快路径）
 └─ 失败
    ├─ addWaiter(EXCLUSIVE)：CAS tail 快路径 -> enq 自旋入队（先 init head）
    └─ acquireQueued(node, arg)：for(;;)
        ├─ p==head && tryAcquire 成功 -> setHead + p.next=null(help GC) + 返回
        ├─ shouldParkAfterFailedAcquire：SIGNAL 握手
        │    ├─ pred=SIGNAL -> 返回 true（承诺已建立）
        │    ├─ pred 取消 -> 沿 prev 跳过（逻辑清理）
        │    └─ 0/PROPAGATE -> CAS 置 SIGNAL，仍返回 false 再自旋一轮（防撞车兜底）
        ├─ parkAndCheckInterrupt：park；Thread.interrupted() 清除并返回
        └─ finally：failed -> cancelAcquire（异常路径）
 最后：acquireQueued 返回 true -> selfInterrupt() 补中断标志（延迟响应）

【独占释放】
release(arg)
 ├─ tryRelease（独占语义：普通写 state 即可）失败 -> return false
 └─ 成功 -> h=head；h!=null && h.waitStatus!=0（有承诺未兑现）
     -> unparkSuccessor(h)
        ├─ CAS 清 head 负状态
        ├─ s=h.next 有效 -> unpark(s.thread)
        └─ s 空/取消 -> 从 tail 沿 prev 找第一个 ws<=0 -> unpark
           （原因：next 有滞后窗口，prev 写入即有效——"从尾找"总原则）

【取消（3 类触发收敛点）】
触发：doAcquireNanos 超时 return false（failed 仍 true）/ doAcquireInterruptibly
     抛 InterruptedException / try 块任何异常
cancelAcquire(node)
 ├─ node.thread=null；沿 prev 跳过取消前驱；无条件标记 CANCELLED（吸收态）
 ├─ 分支 A 队尾：CAS(tail->pred) + CAS(pred.next->null) 自摘
 ├─ 分支 B 前驱可靠：置 pred SIGNAL + CAS(pred.next -> node.next) 责任转移
 ├─ 分支 C 前驱不可靠（pred==head/pred 取消中/置 SIGNAL 失败）：
 │        unparkSuccessor(node) 代理兑现（让最该拿锁的后继立刻竞争）
 └─ node.next = node 自链接 help GC（残留引用收敛为可孤立的环）

【条件等待（await）】
await
 ├─ addConditionWaiter（CONDITION 节点入条件单链表；队尾有尸体先 unlinkCancelledWaiters）
 ├─ fullyRelease（归还全部重入，失败则节点标 CANCELLED）
 ├─ while(!isOnSyncQueue(node))
 │    ├─ park
 │    └─ checkInterruptWhileWaiting（被中断时）
 │         └─ transferAfterCancelledWait：CAS(CONDITION->0) 裁决
 │              ├─ 成功：中断先于 signal -> 自己 enq -> THROW_IE（抛异常）
 │              └─ 失败：signal 先行 -> yield 等对方 enq 完成 -> REINTERRUPT（补中断）
 ├─ acquireQueued(node, savedState)   <- 超时/被转移后也必须重新拿锁（现象2 的 8 秒）
 └─ reportInterruptAfterWait：THROW_IE 抛 / REINTERRUPT 补 selfInterrupt

【条件通知（signal，必须持锁）】
signal -> doSignal(firstWaiter)
 └─ transferForSignal(node)
     ├─ CAS(CONDITION->0) 失败 -> 节点已取消 -> 换下一个等待者
     └─ 成功 -> enq 入同步队列（signal 线程负责转移）
          ├─ 前驱置 SIGNAL 成功 -> 留给 release 统一唤醒
          └─ 前驱取消/置 SIGNAL 失败 -> 直接 unpark(node.thread)

【JDK 8 -> JDK 17 方法对照（JDK-8229442）】
 acquireQueued/doAcquireInterruptibly/doAcquireNanos/... 6 个循环
   -> acquire(node, arg, shared, interruptible, timed, nanos) 合一 + 自适应自旋
 addWaiter + enq        -> enqueue(node) + tryInitializeHead()
 cancelAcquire 惰性清理 -> status=CANCELLED + cleanQueue() 锁定链主动清扫
 unparkSuccessor 从尾扫 -> signalNext(head) 只看 head.next（从尾扫描退出热路径）
 setHeadAndPropagate+PROPAGATE -> head 轮转重查（PROPAGATE 状态删除）
 Node{thread,nextWaiter,waitStatus} -> Node{waiter,status}（正数有效；条件改 Treiber 栈
                                      + rewindStacks 栈修复）
 Unsafe 字段偏移        -> VarHandle（签名多态 + 细粒度内存序 access mode）
 跨版本不变量：CLH 变体双向队列 / state / 模板方法 /
              "next 滞后、prev 即时 -> 从尾找" / CAS(CONDITION->0) 转移裁决
```

---

## 本日总结

```text
Day07 深挖日完成了 AQS 从"会用会背"到"源码级反推"的跨越：

1. cancelAcquire：3 类触发收敛一处；三分支清理（自摘/责任转移/代理唤醒）；
   自链接 help GC；惰性清理与尸体堆积（现象1 根因）
2. park/unpark：0/1 许可模型（unpark 可先发）；SIGNAL 承诺-兑现协议；
   置 SIGNAL 后再自旋一轮的兜底；spurious wakeup 与 while 防线
3. 中断语义：acquire 延迟响应（selfInterrupt 补回）；Condition 三态
   （0/THROW_IE/REINTERRUPT）；CAS(CONDITION->0) 唯一裁决点；
   Thread.interrupted() 必须清除（否则 park 退化自旋）
4. 私有穿透：isOnSyncQueue/findNodeFromTail 从尾找的根因（next 滞后）；
   signal 与取消共享裁决 CAS，恰好一次转移
5. JDK 15+ 重写：JDK-8229442；locked 队列锁定链；cleanQueue/rewindStacks/
   signalNext；从尾扫描退出 release 热路径；面试"JDK8 主线+重写差异收尾"
6. 四现象反推：取消风暴/漏 countDown+超时重排队/许可泄漏 fail-closed/
   公平 convoy——证据->机制->根因->修复四段式
7. 四防闭环：防误用（C1-C10 契约）/防泄漏（handedOff+对账等式）/防饥饿
   （公平性指标与切换评估）/防卡死（超时+降级+看门狗）；jcstress 正确性验证
8. 生态延伸：VarHandle 替代 Unsafe；JUC 全景（Worker/FutureTask 演变）；
   TwoPhaseLatch/Mutex 自定义同步器完整实现与测试

核心认知：
- await 超时不是免费的：每次超时都是一次 cancelAcquire 队列写操作
- SIGNAL 是前驱的承诺，AQS 的全部状态操作=建立/兑现/转移/代理兑现承诺
- Semaphore 是 fail-closed 的：泄漏的表现是"正常限流"，必须靠对账发现
- 公平锁的代价是排队+唤醒 convoy，切换要有饥饿实证 + JMH 基准
- 讲 AQS 要有版本维度：JDK 8 逐行 + JDK 15 重写差异，才是 2026 年的答案
```

并发编程专题 1 周（2026年08月第2周）至此完整闭环：Day01 JMM 打底 -> Day02 synchronized 锁升级 -> Day03 AQS 核心原理 -> Day04 并发容器 -> Day05 线程池与虚拟线程 -> Day06 串联整合 -> Day07 AQS 源码深挖与生产事故反推。与简历项目（在线问诊系统）的三大 AQS 改造深度结合，形成可复用的"源码机制 -> 事故反推 -> 四防闭环"方法论。
