# 架构师学习-Day02-synchronized 锁升级

> 日期：2026年08月11日（周二）
> 周主题：并发编程专题 - JMM / synchronized 锁升级 / AQS / 并发容器 / 线程池 / 虚拟线程
> 出题日：Day02 - synchronized 锁升级

---

## 背景

经过 Day01 的 JMM 基础，本周进入 synchronized 锁升级专题。JMM 讲的是"跨线程可见性的契约"，synchronized 是这个契约在 Java 层最直接的实现--**synchronized 块既保证原子性，又保证可见性，又保证有序性**，是 JMM 三大特性的"全能选手"。

但 synchronized 不是"一个机制"，而是**4 种状态构成的升级链**：

```
无锁 -> 偏向锁 -> 轻量级锁 -> 重量级锁
```

JDK 6 之前 synchronized 是"重量级锁"代名词，性能差，大家用 ConcurrentHashMap / ReentrantLock 替代。JDK 6 引入"锁升级"机制后，synchronized 在低并发场景性能已接近 Lock，甚至在某些场景更优。

架构师面试官最爱问的不是"synchronized 怎么用"，而是：

> "synchronized 锁升级的 4 个状态是什么？触发条件是什么？"
> "偏向锁为什么在 JDK 15 被废弃（JEP 374）？"
> "Mark Word 在 64 位 JVM 上的布局？锁状态如何标记？"
> "synchronized 与 ReentrantLock 的区别？生产中怎么选？"

这些问题答不出来，AQS（Day03）和并发容器（Day04）就失去了对比基准。本周 Day02 把 synchronized 锁升级一次性梳理清楚，为 Day03 AQS 对比打下基础。

**Day02 为什么是"synchronized 锁升级"而不是"AQS"**：

1. **synchronized 是 Java 内置锁**：每个 Java 对象都能做锁，无需显式 Lock 对象；AQS 是显式 Lock 的底层
2. **锁升级是 JDK 6+ 的核心优化**：从"重量级锁"到"4 状态升级"是 JVM 工程的杰作，理解后能讲清"synchronized 性能已不输 Lock"
3. **Mark Word 是对象头的核心**：与 JVM 第1周 Day01（JVM 内存模型）的对象头布局衔接，是 Java 对象的"元信息载体"
4. **JDK 15 偏向锁废弃（JEP 374）**：是近年 JVM 演进的重大事件，架构师必须了解原因

**与往周专题的衔接点**：

- **JVM 内存模型（第1周 Day01）** vs **synchronized Mark Word**：JVM 对象头包含 Mark Word + Klass Pointer，Mark Word 存锁状态、hashCode、GC 分代年龄--与 JVM 第1周衔接
- **JMM happens-before（Day01）** vs **synchronized 监视器锁规则**：JMM 的"unlock hb 后续 lock"规则就是 synchronized 的内存语义
- **JVM GC 分代年龄（第1周 Day02）** vs **Mark Word**：Mark Word 4 bit 存 GC 分代年龄（最大 15），与 G1 调优相关
- **JIT 锁消除（JVM 第2周 Day01）** vs **synchronized 优化**：JIT 的逃逸分析可以做锁消除（lock elision），与 synchronized 锁升级协同

**与简历项目的衔接点**：

在线问诊系统的 synchronized 三大重灾区：

1. **IM 网关 SessionManager 的 ConcurrentHashMap 分段锁退化**：10w+ 长连接的 SessionMap，用 synchronized 块保护 put/get 操作，高并发下升级到重量级锁，吞吐骤降
2. **问诊订单状态机的 synchronized 同步块**：订单状态变更用 synchronized，但状态机在分布式场景下失效（多 JVM 不共享锁），需要分布式锁
3. **监管上报服务的批量发送锁**：监管消息批量发送用 synchronized 保护 List，高并发下退化成串行

---

## 题目一（synchronized 锁升级全解题）：synchronized 锁升级全解

请详细回答以下问题：

1. **对象头与 Mark Word 全解**：Java 对象头在 32 位 vs 64 位 JVM 上的布局？指针压缩（`+UseCompressedOops`）对对象头的影响？Mark Word 的 5 种状态（无锁 / 偏向锁 / 轻量级锁 / 重量级锁 / GC 标记）在 64 位 JVM 上的位布局？为什么 Mark Word 要存 hashCode / 分代年龄 / 锁状态 / 线程 ID / epoch？Mark Word 的锁标记位（2 bit vs 3 bit）与状态映射？为什么 64 位 JVM 上偏向锁需要 23 bit 存线程 ID？
2. **偏向锁全解**：偏向锁的"偏向"含义（CAS 都省，直接比较 ThreadID）？偏向锁的获取流程（检查 ThreadID / CAS ThreadID / 撤销偏向）？偏向锁的撤销流程（其他线程竞争时撤销，触发 STW safepoint）？为什么偏向锁"启动 4 秒后"才启用（JVM 启动期高竞争不值得偏向）？为什么 JDK 15 废弃偏向锁（JEP 374）？废弃后 Mark Word 的 23 bit 线程 ID 怎么用？
3. **轻量级锁全解**：轻量级锁的"轻量"含义（CAS 替换 Mark Word，无系统调用）？轻量级锁的加锁流程（栈帧 Lock Record / CAS 替换 Mark Word / 失败自旋）？轻量级锁的解锁流程（CAS 还原 Mark Word / 失败升级）？自适应自旋（JDK 6 引入）的原理与作用？什么场景下轻量级锁比偏向锁更优（多线程交替执行，无实际竞争）？
4. **重量级锁全解**：重量级锁的"重量"含义（操作系统 Mutex 互斥量，涉及用户态 / 内核态切换）？ObjectMonitor 的核心数据结构（Owner / WaitSet / EntryList / count / recursions）？weightpemaphore 与 ParkEvent 的关系？为什么重量级锁需要 park/unpark（线程阻塞 / 唤醒）？EntryList 与 WaitSet 的区别（阻塞队列 vs 等待队列）？
5. **锁消除 / 锁粗化 / 锁降级**：锁消除（Lock Elision）的 JIT 逃逸分析原理？什么样的代码会被锁消除（如 `StringBuffer.append` 局部变量）？锁粗化（Lock Coarsening）的 JIT 优化原理？什么样的循环会被锁粗化？为什么 synchronized 不能锁降级（只能升级不能降级）？JIT 锁消除 / 锁粗化与代码层手写优化的关系？
6. **synchronized vs ReentrantLock**：synchronized 与 ReentrantLock 的 10 大差异（语法 / 可中断 / 公平锁 / 多 Condition / 锁释放 / 锁绑定 / 死锁恢复 / 性能 / JVM 内置 / 功能丰富度）？JDK 6 后 synchronized 性能是否真的不如 ReentrantLock？什么场景该用 synchronized，什么场景该用 ReentrantLock？为什么 StampedLock 不适合做"通用锁"？

### 作答区

#### 1. 对象头与 Mark Word 全解

**Java 对象头布局（64 位 JVM）**：

```
┌──────────────────────────────────────────────────────────────┐
│  Object Header（对象头）                                     │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Mark Word（64 bit / 8 字节）                          │  │
│  ├────────────────────────────────────────────────────────┤  │
│  │  Klass Pointer（64 bit / 8 字节，指针压缩后 4 字节）   │  │
│  ├────────────────────────────────────────────────────────┤  │
│  │  数组长度（4 字节，仅数组对象有）                      │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

**指针压缩对对象头的影响**：

| 配置 | Mark Word | Klass Pointer | 对象头总大小 |
|------|-----------|---------------|-------------|
| 32 位 JVM | 4 字节 | 4 字节 | 8 字节 |
| 64 位 JVM 不开指针压缩 | 8 字节 | 8 字节 | 16 字节 |
| 64 位 JVM 开指针压缩（默认，堆 &lt; 32GB） | 8 字节 | 4 字节 | 12 字节（对齐后 16 字节） |

**Mark Word 的 5 种状态（64 位 JVM，开指针压缩）**：

```
|----------------------------------------------------------------------|
|                        Mark Word (64 bit)                            |
|----------------------------------------------------------------------|
|  无锁     | unused:25 | hash:31 | unused:1 | age:4 | biased:0 | 01  |
|  偏向锁   | thread:54 | epoch:2  | unused:1 | age:4 | biased:1 | 01  |
|  轻量级锁 | ptr_to_lock_record:62                              | 00  |
|  重量级锁 | ptr_to_heavyweight_monitor:62                      | 10  |
|  GC 标记  |                                                 | 11  |
|----------------------------------------------------------------------|
                                                              ↑
                                                       锁标记位（2 bit）
```

**关键认知**：64 位 JVM 上 Mark Word 只有 64 bit，需要存"hashCode + 分代年龄 + 锁状态 + 线程 ID + epoch"，所以各状态有 trade-off：

- **无锁状态**：31 bit 存 hashCode（够用，标准 hashCode 是 31 bit）
- **偏向锁状态**：54 bit 存线程 ID（够用，Java 线程 ID 是 long）
- **轻量级锁状态**：62 bit 存 Lock Record 指针（栈帧中）
- **重量级锁状态**：62 bit 存 ObjectMonitor 指针（堆中）

**为什么 Mark Word 要存这些信息**：

| 字段 | 作用 | 来源 |
|------|------|------|
| hashCode | `System.identityHashCode()` 的缓存 | 首次调用时计算并缓存 |
| 分代年龄 | GC 晋升老年代的依据（最大 15） | 每次 Minor GC +1 |
| 锁状态 | 当前锁的状态（无锁 / 偏向 / 轻量 / 重量 / GC） | 锁升级时修改 |
| 线程 ID | 偏向锁持有线程的 ID | 偏向锁获取时写入 |
| epoch | 偏向锁的时间戳（批量撤销用） | 类的 epoch 更新时同步 |

**Mark Word 锁标记位与状态映射**：

| 锁状态 | biased 位 | 锁标记位（2 bit） | 含义 |
|--------|----------|-------------------|------|
| 无锁 | 0 | 01 | 未加锁 |
| 偏向锁 | 1 | 01 | 偏向某线程 |
| 轻量级锁 | - | 00 | CAS 自旋 |
| 重量级锁 | - | 10 | OS Mutex |
| GC 标记 | - | 11 | GC 标记 |

**关键认知**：偏向锁和无锁共享"01"标记，通过 biased 位区分。这是 JDK 6 设计的精巧之处--偏向锁"看起来像无锁"，性能接近无锁。

**为什么 64 位 JVM 上偏向锁需要 54 bit 存线程 ID**：

- Java 线程 ID 是 long 类型（64 bit）
- 但实际线程 ID 不会超过 2^54（千万亿），54 bit 够用
- 留 2 bit 给 epoch（批量撤销用），7 bit 给 age + biased + lock 标记
- 64 - 54 - 2 - 7 = 1 bit unused

**架构师经验**：Mark Word 是 Java 对象的"身份证"，每个对象都占用 12-16 字节的对象头。**小对象（如 Integer）的对象头比数据还大**（Integer 数据 4 字节，对象头 16 字节，总 20 字节）。这是为什么"用 int 比 Integer 性能高 5 倍"。

#### 2. 偏向锁全解

**偏向锁的"偏向"含义**：

假设**多数情况下锁不仅不存在多线程竞争，而且总是由同一个线程多次获得**，那么连 CAS 都可以省--直接比较 ThreadID 即可：

```
首次获取：
  1. 检查 Mark Word 是否无锁（biased=0, lock=01）
  2. CAS 替换 Mark Word：写入 ThreadID，biased=1, lock=01
  3. 成功 -> 偏向成功，无 CAS 开销

后续获取（同一线程）：
  1. 检查 Mark Word 的 ThreadID 是否是自己
  2. 是 -> 直接进入同步块，无 CAS
  3. 否 -> 撤销偏向
```

**偏向锁的获取流程**：

```
1. 检查 Mark Word
   - biased=0, lock=01（无锁）-> 走偏向流程
   - biased=1, lock=01（已偏向）-> 检查 ThreadID
     - ThreadID == 当前线程 -> 直接进入
     - ThreadID != 当前线程 -> 撤销偏向

2. 偏向流程（无锁状态）
   - 检查是否允许偏向（JVM 启动 4 秒后启用，-XX:+UseBiasedLocking）
   - CAS 替换 Mark Word：写入 ThreadID, biased=1
   - 成功 -> 偏向成功
   - 失败 -> 其他线程竞争，撤销偏向
```

**偏向锁的撤销流程**：

```
1. 其他线程竞争偏向锁
2. 等待全局安全点（Safepoint）
3. 暂停拥有偏向锁的线程
4. 检查原持有线程是否存活
   - 不存活 -> 直接重置为无锁
   - 存活 -> 检查是否仍在同步块内
     - 不在 -> 撤销偏向，重置为无锁
     - 在 -> 升级为轻量级锁，原线程继续执行
5. 唤醒暂停的线程
```

**关键认知**：偏向锁撤销需要 STW Safepoint，开销不小。**高竞争场景下偏向锁撤销频繁，反而比直接轻量级锁更慢**。

**为什么偏向锁"启动 4 秒后"才启用**：

```bash
# JVM 默认参数
-XX:+UseBiasedLocking
-XX:BiasedLockingStartupDelay=4000  # 4 秒延迟
```

**原因**：

1. JVM 启动期有大量初始化代码，多线程竞争激烈
2. 启动期偏向锁会被频繁撤销，开销大
3. 启动稳定后（4 秒后）才进入"长期单线程"状态，此时偏向锁收益最大

**架构师经验**：测试环境跑短任务（&lt; 4 秒）时，偏向锁根本没启用。性能测试时要预热 5 秒以上，否则数据不准。

**为什么 JDK 15 废弃偏向锁（JEP 374）**：

JEP 374：Disable and Deprecate Biased Locking

**废弃原因**：

1. **维护成本高**：偏向锁在 HotSpot 源码中散布在 1000+ 处，维护代价大
2. **现代硬件变化**：CAS 指令（cmpxchg）在现代 CPU 上开销已极低（&lt; 10 周期），偏向锁的"CAS 都省"优势变小
3. **应用场景变化**：现代应用大量用并发容器（ConcurrentHashMap）和显式 Lock，synchronized 多数场景不再是"单线程长期持有"
4. **撤销成本高**：高并发下偏向锁撤销频繁，反而拖累性能
5. **未来方向**：HotSpot 团队精力转向 Project Lilliput（缩小对象头）+ Valhalla（值类型）

**废弃过程**：

- JDK 13：`-XX:+UseBiasedLocking` 默认 false
- JDK 14：废弃警告
- JDK 15：JEP 374 Disable
- JDK 18：完全移除

**废弃后 Mark Word 的 23 bit 线程 ID 怎么用**：

- Project Lilliput（JDK 24+）计划用这部分空间缩小对象头到 64 bit（4 字节 vs 8 字节）
- 移除 biased 位后，无锁状态可以多 1 bit 存 hashCode（32 bit hash）
- 但短期内 Mark Word 仍是 64 bit，多余 bit 暂时闲置

**架构师经验**：JDK 17+ 的应用不应该再依赖偏向锁。如果 synchronized 性能是瓶颈，应该考虑：

1. 用并发容器替代 synchronized 块
2. 用 ReentrantLock / StampedLock
3. 用 LongAdder 替代 synchronized ++

#### 3. 轻量级锁全解

**轻量级锁的"轻量"含义**：

轻量级锁用 CAS（用户态指令）替代 OS Mutex（用户态-内核态切换），避免系统调用开销：

| 机制 | 开销 |
|------|------|
| OS Mutex 加锁 | 1-10 μs（用户态-内核态切换） |
| CAS 自旋 | 100-300 ns（用户态指令） |
| 偏向锁直接比较 | 1-3 ns（普通读） |

**轻量级锁的加锁流程**：

```
1. 在当前栈帧中创建 Lock Record（锁记录）
2. 把对象头的 Mark Word 拷贝到 Lock Record 中（Displaced Mark Word）
3. CAS 尝试把对象头的 Mark Word 替换为指向 Lock Record 的指针
   - 成功 -> 当前线程持有轻量级锁，lock=00
   - 失败 -> 自旋等待

4. 自旋达到阈值（自适应）-> 升级为重量级锁
```

**轻量级锁的解锁流程**：

```
1. 取出 Lock Record 中的 Displaced Mark Word
2. CAS 把对象头的 Mark Word 还原为 Displaced Mark Word
   - 成功 -> 释放完成，无竞争
   - 失败 -> 已升级为重量级锁，唤醒被阻塞的线程
```

**自适应自旋（JDK 6 引入）**：

| 自旋策略 | 原理 |
|---------|------|
| 固定自旋（JDK 5） | 自旋固定次数（如 10 次），不成功就升级 |
| 自适应自旋（JDK 6+） | 根据历史成功率动态调整 |

**自适应自旋的动态调整**：

- 上次自旋成功 -> 这次自旋更久（更可能成功）
- 上次自旋失败 -> 这次自旋更短或直接升级（避免空转浪费 CPU）

**轻量级锁适用场景**：

- **多线程交替执行，无实际竞争**：线程 A 释放锁后，线程 B 才来获取，CAS 一次成功
- **同步块执行非常快**：CAS 自旋等待比 OS Mutex 切换便宜
- **不适用高竞争场景**：自旋会消耗 CPU，且 CAS 失败率高

**架构师经验**：轻量级锁"轻量"的前提是"持有时间短 + 无竞争"。如果同步块内有 IO / 长计算，自旋会变成"忙等"，反而比重量级锁更差。

#### 4. 重量级锁全解

**重量级锁的"重量"含义**：

重量级锁通过 OS Mutex（互斥量）实现，涉及用户态-内核态切换：

| 操作 | 用户态 / 内核态 | 开销 |
|------|---------------|------|
| Mutex 加锁（无竞争） | 用户态 | 100 ns |
| Mutex 加锁（有竞争） | 用户态 -> 内核态 | 1-10 μs |
| 线程阻塞 park | 用户态 -> 内核态 | 1-10 μs |
| 线程唤醒 unpark | 内核态 -> 用户态 | 1-10 μs |

**ObjectMonitor 的核心数据结构**：

```cpp
class ObjectMonitor {
    void*       _owner;          // 持有锁的线程
    ObjectWaiter* _EntryList;    // 阻塞队列（等锁的线程）
    ObjectWaiter* _WaitSet;      // 等待队列（wait() 的线程）
    int         _count;          // 等待线程总数
    int         _recursions;     // 重入次数
    void*       _StackLock;      // 轻量级锁的 Lock Record 指针
};
```

**EntryList 与 WaitSet 的区别**：

```
┌─────────────────────────────────────┐
│  ObjectMonitor                      │
│  ┌─────────┐                        │
│  │ _owner  │ <- 当前持有锁的线程    │
│  └─────────┘                        │
│                                     │
│  EntryList（阻塞队列）：             │
│  ┌─────────────────────────────┐    │
│  │ Thread B -> Thread C -> ... │    │
│  │ (等锁的线程，notify 后进入)  │    │
│  └─────────────────────────────┘    │
│                                     │
│  WaitSet（等待队列）：                │
│  ┌─────────────────────────────┐    │
│  │ Thread D -> Thread E -> ... │    │
│  │ (wait() 的线程，需要 notify) │    │
│  └─────────────────────────────┘    │
└─────────────────────────────────────┘
```

**关键认知**：

- **EntryList**：等锁的线程队列，notify / unlock 后从这里唤醒
- **WaitSet**：调用 `wait()` 的线程队列，需要 `notify()` 才能进入 EntryList

**完整流程**：

```
线程 A 持有锁
  ↓
线程 B 尝试加锁 -> 失败 -> 进入 EntryList 阻塞
  ↓
线程 A 调用 wait() -> 释放锁，进入 WaitSet
  ↓
线程 A 调用 notify() -> 唤醒 WaitSet 中的某个线程，转移到 EntryList
  ↓
线程 A 释放锁 -> 唤醒 EntryList 中的线程
  ↓
线程 B 拿到锁
```

**重量级锁加锁流程**：

```
1. CAS 替换 Mark Word 为 ObjectMonitor 指针
   - 成功 -> 持有锁，lock=10
   - 失败 -> 已被其他线程持有

2. 已被持有 -> 进入 EntryList 阻塞（park）
3. 持有锁的线程释放 -> 唤醒 EntryList 一个线程（unpark）
4. 被唤醒的线程 -> 重新尝试 CAS 加锁
```

**ParkEvent 与 park/unpark**：

HotSpot 用 ParkEvent 实现线程阻塞：

- `park()`：阻塞当前线程，进入内核态等待
- `unpark(Thread t)`：唤醒指定线程，使其从 park() 返回

**关键认知**：`unpark` 是"许可"机制--`unpark` 给目标线程发一个许可，`park` 时如果有许可就消费返回，否则阻塞。**`unpark` 在 `park` 之前调用不会丢失**（这就是为什么 LockSupport.unpark 不会"丢失唤醒"）。

**架构师经验**：重量级锁性能差的根本原因是**用户态-内核态切换**。减少切换的方法：

1. 减少锁竞争（分段锁 / 并发容器）
2. 缩短临界区（同步块内只放必要代码）
3. 用 CAS 替代锁（Atomic* / LongAdder）

#### 5. 锁消除 / 锁粗化 / 锁降级

**锁消除（Lock Elision）**：

JIT 逃逸分析发现"对象不会逃逸出当前线程"，自动消除 synchronized 块：

```java
// 反例：StringBuffer 是线程安全，但局部变量不逃逸
public String concat(String s1, String s2) {
    StringBuffer sb = new StringBuffer();
    sb.append(s1);  // synchronized 方法，但 JIT 消除
    sb.append(s2);  // synchronized 方法，但 JIT 消除
    return sb.toString();
}
```

**JIT 优化后等价于**：

```java
public String concat(String s1, String s2) {
    StringBuilder sb = new StringBuilder();  // 锁消除后用非同步版本
    sb.append(s1);
    sb.append(s2);
    return sb.toString();
}
```

**关键认知**：锁消除让"用 StringBuffer 局部变量"性能等同"用 StringBuilder"。但**字段（成员变量）不能用锁消除**，因为字段可能被其他线程访问。

**锁粗化（Lock Coarsening）**：

JIT 发现"循环内多次加锁解锁同一对象"，自动把锁粗化到循环外：

```java
// 原代码
for (int i = 0; i < 1000; i++) {
    synchronized (lock) {
        list.add(i);
    }
}

// JIT 锁粗化后
synchronized (lock) {
    for (int i = 0; i < 1000; i++) {
        list.add(i);
    }
}
```

**锁粗化的适用条件**：

1. 同一对象多次加锁解锁
2. JIT 能识别循环模式
3. 锁粗化后语义不变（中间无其他线程可见操作）

**为什么 synchronized 不能锁降级**：

synchronized 只能升级（无锁 -> 偏向 -> 轻量 -> 重量），**不能降级**。原因是：

1. **降级需要全局安全点**：与偏向锁撤销类似，降级需要暂停所有线程，开销大
2. **降级收益小**：高竞争时降级，下次又要升级，反复开销大
3. **GC 时会重置**：GC 标记阶段（Mark Word 状态 11）后，对象回到无锁状态，相当于"GC 时的降级"

**JIT 锁优化与手写优化的关系**：

| 优化 | JIT 自动 | 手写 |
|------|---------|------|
| 锁消除 | 是（局部变量） | 用非同步类（StringBuilder） |
| 锁粗化 | 是（循环内） | 手动把锁提到循环外 |
| 减少临界区 | 否 | 把 IO / 长计算移出同步块 |
| 分段锁 | 否 | 用 ConcurrentHashMap / 自己分段 |

**架构师经验**：JIT 锁消除 / 锁粗化是"自动优化"，但不能完全依赖。架构师需要：

1. 字段（成员变量）优先用并发容器，不依赖 JIT 消除
2. 同步块内只放必要的临界区操作
3. 高并发场景用 CAS / 分段锁替代 synchronized

#### 6. synchronized vs ReentrantLock

**10 大差异对比**：

| 维度 | synchronized | ReentrantLock |
|------|--------------|---------------|
| 语法 | 关键字（块 / 方法） | 类（API） |
| 锁释放 | 自动（出块即释放） | 手动（finally unlock） |
| 可中断 | 否 | 是（lockInterruptibly） |
| 公平锁 | 否（非公平） | 可选（new ReentrantLock(true)） |
| 多 Condition | 否（wait / notify 单队列） | 是（newCondition） |
| 锁绑定 | 任意对象 | Lock 对象 |
| 死锁恢复 | 难（jstack 检测） | 易（lockInterruptibly + tryLock） |
| 性能（低并发） | 接近 ReentrantLock | 接近 synchronized |
| 性能（高并发） | 略差 | 略优 |
| 功能丰富度 | 少 | 多（tryLock / lockInterruptibly / Condition） |

**JDK 6 后 synchronized 性能是否真的不如 ReentrantLock**：

**JDK 5 时代**：synchronized 性能远不如 ReentrantLock（约 2-3 倍差距）
**JDK 6+**：synchronized 引入锁升级，性能接近 ReentrantLock（差距 &lt; 20%）
**JDK 17+**：偏向锁废弃后，低并发场景 synchronized 性能略降，但仍可接受

**关键认知**：性能已不是 synchronized vs ReentrantLock 的主要矛盾。选型应该看**功能需求**：

- **简单同步**：synchronized（语法简单，自动释放）
- **需要可中断 / 超时 / 公平**：ReentrantLock
- **需要多 Condition**：ReentrantLock
- **读多写少**：ReentrantReadWriteLock
- **乐观读**：StampedLock

**StampedLock 为什么不适合做"通用锁"**：

StampedLock 是 JDK 8 引入的"乐观读锁"，性能比 ReentrantReadWriteLock 高 5-10 倍，但：

1. **不可重入**：同一线程重复加锁会死锁
2. **不支持 Condition**：无法 wait / notify
3. **乐观读可能失败**：需要 validate + retry 逻辑
4. **代码复杂**：错误使用容易出 bug

**适用场景**：

- 读多写少的高并发场景（如配置缓存）
- 不需要重入和 Condition
- 程序员能正确使用 validate + retry

**架构师经验**：StampedLock 是"特种兵"，不是"通用锁"。生产中 90% 场景用 synchronized / ReentrantLock，10% 高并发读场景用 StampedLock。

---

## 本日能力差距与补足方向

### 差距 1：Mark Word 在 64 位 JVM 上的位布局不熟
> Day2发现，延续 JVM 第1周 Day01 差距（对象头）

- **现状**：知道对象头包含 Mark Word + Klass Pointer，但 Mark Word 在 64 位 JVM 上的 5 种状态位布局（无锁 / 偏向 / 轻量 / 重量 / GC）记不熟；54 bit 线程 ID + 31 bit hashCode + 4 bit age 的分配记不清；指针压缩对对象头的影响（12 字节 vs 16 字节）模糊
- **架构师水平**：能不查文档画出 64 位 JVM 的 Mark Word 5 状态位布局图；能从 Mark Word 反推对象头总大小（12 / 16 字节）；能用 JOL（Java Object Layout）实测对象头布局
- **补足方向**：精读 OpenJDK `markWord.hpp` 源码；用 JOL 实测 Integer / String / HashMap 的对象头；阅读 JEP 374（偏向锁废弃）

### 差距 2：偏向锁撤销机制的工程影响不深
> Day2发现，延续 Day01 差距5（happens-before）

- **现状**：知道偏向锁的"偏向"含义，但偏向锁撤销需要 STW Safepoint、4 秒延迟启动、JDK 15 废弃（JEP 374）等工程影响不深；高竞争场景下偏向锁撤销频繁导致性能下降的实战经验不足
- **架构师水平**：能讲清 JEP 374 废弃偏向锁的 5 大原因；能根据 JDK 版本（13 / 14 / 15 / 17）反推偏向锁状态；能为 JDK 17+ 应用设计"不依赖偏向锁"的同步策略
- **补足方向**：精读 JEP 374；调研 Project Lilliput（缩小对象头）；用 JCStress 实测偏向锁撤销开销

### 差距 3：轻量级锁 CAS 与自适应自旋的实战经验不足
> Day2发现，延续 JVM 第2周 Day04 差距4.4（JIT 退优化）

- **现状**：知道轻量级锁用 CAS + 自旋，但 Lock Record 在栈帧中的位置、Displaced Mark Word 还原逻辑、自适应自旋（JDK 6 引入）的动态调整策略不深；"自旋消耗 CPU"在工程上的影响认识不足
- **架构师水平**：能用 `-XX:+PrintAssembly` 看 synchronized 的 CAS 指令；能诊断"自旋锁导致 CPU 100%"事故；能为短临界区设计轻量级锁优化策略
- **补足方向**：阅读 OpenJDK `synchronizer.cpp` 源码；调研 ObjectWaiter 队列实现；用 JMH 实测不同临界区长度下的锁性能

### 差距 4：重量级锁 ObjectMonitor 数据结构不熟
> Day2发现，延续 Day01 差距2（8 大原子操作）

- **现状**：知道重量级锁用 OS Mutex，但 ObjectMonitor 的核心字段（Owner / EntryList / WaitSet / count / recursions）不熟；EntryList 与 WaitSet 的区别（阻塞队列 vs 等待队列）模糊；park/unpark 的"许可机制"原理不深
- **架构师水平**：能画 ObjectMonitor 完整数据结构图；能讲清 wait/notify/notifyAll 在 ObjectMonitor 中的流转；能用 jstack 实测 BLOCKED / WAITING 状态线程
- **补足方向**：阅读 OpenJDK `objectMonitor.cpp` 源码；调研 ParkEvent 实现；用 jstack + jcmd Thread.print 实战 BLOCKED 线程分析

### 差距 5：锁消除 / 锁粗化的 JIT 优化边界不深
> Day2发现，延续 JVM 第2周 Day01 差距1.5（JIT 参数）

- **现状**：知道 JIT 能做锁消除和锁粗化，但逃逸分析的精度（字段不能消除 / 跨方法不能消除）、锁粗化的触发条件（循环模式识别）、JIT 优化与手写优化的边界不深
- **架构师水平**：能用 `-XX:+DoEscapeAnalysis` + `-XX:+PrintAssembly` 看锁消除；能识别"JIT 不能消除"的反模式（字段 / 跨方法 / 共享）；能在 Code Review 中识别"依赖 JIT 锁消除但实际不会消除"的代码
- **补足方向**：阅读 OpenJDK `escapeBarrier.cpp`；调研 JIT 逃逸分析精度；用 JMH 实测 StringBuffer vs StringBuilder 在局部变量下的性能差异

### 差距 6：synchronized vs ReentrantLock 选型决策不精
> Day2发现，延续第4周简历项目差距

- **现状**：知道 synchronized 和 ReentrantLock 的区别，但生产中"什么场景该用哪个"的决策不精；StampedLock 的适用边界（不可重入 / 不支持 Condition / 乐观读）模糊；JDK 17 偏向锁废弃后 synchronized 性能变化不深
- **架构师水平**：能为不同业务场景（IM / 视频 / 监管 / 归档）选合适锁；能用 JMH 实测 synchronized vs ReentrantLock vs StampedLock 性能；能讲清 JDK 6 -> 17 synchronized 性能演进
- **补足方向**：用 JMH 实测 3 种锁在 4 / 8 / 16 线程下的性能；调研 LinkedIn / Netflix 的锁选型实践；阅读《Java Concurrency in Practice》第 13 章

### 差距 7：与简历项目 synchronized 实战结合的深度不足
> Day2发现，延续第4周简历项目差距

- **现状**：能讲 synchronized 锁升级，但与简历项目（在线问诊系统）3 个 synchronized 场景（IM SessionManager 锁退化 / 问诊订单状态机 / 监管批量发送锁）的完整 STAR 故事不熟；IM 网关 SessionMap 高并发下退化到重量级锁的事故故事讲不生动
- **架构师水平**：能用 STAR 法则结构化讲述 3 个 synchronized 案例；能从案例反推架构改进点（如用 ConcurrentHashMap / 分段锁 / CAS）；能在面试中 10 分钟讲清 2 个案例
- **补足方向**：本周 Day05 实战日产出 3 个完整 synchronized 案例；用 jstack 实测 IM 网关 BLOCKED 线程；用 STAR 法则演练 5 次面试讲述

---

## 附录：本日关键认知速查

```text
对象头（64 位 JVM）：
  - Mark Word：8 字节
  - Klass Pointer：4 字节（指针压缩）/ 8 字节（不压缩）
  - 总大小：12 字节（压缩）/ 16 字节（不压缩）

Mark Word 5 种状态（64 位 JVM）：
  - 无锁：hash:31 + age:4 + biased:0 + 01
  - 偏向锁：thread:54 + epoch:2 + age:4 + biased:1 + 01
  - 轻量级锁：ptr_to_lock_record:62 + 00
  - 重量级锁：ptr_to_heavyweight_monitor:62 + 10
  - GC 标记：11

锁升级链：
  无锁 -> 偏向锁 -> 轻量级锁 -> 重量级锁
  （只能升级，不能降级）

偏向锁：
  - CAS 都省，直接比较 ThreadID
  - JDK 15 废弃（JEP 374）
  - 启动 4 秒后启用
  - 撤销需要 STW Safepoint

轻量级锁：
  - CAS 替换 Mark Word（无系统调用）
  - 自适应自旋（JDK 6 引入）
  - 适用：短临界区 + 低竞争

重量级锁：
  - OS Mutex（用户态-内核态切换）
  - ObjectMonitor（Owner / EntryList / WaitSet）
  - EntryList：阻塞队列
  - WaitSet：等待队列（wait() 的线程）

JIT 锁优化：
  - 锁消除（Lock Elision）：逃逸分析
  - 锁粗化（Lock Coarsening）：循环外提

synchronized vs ReentrantLock：
  - synchronized：自动释放 / 不可中断 / 单 Condition
  - ReentrantLock：手动释放 / 可中断 / 多 Condition / 公平锁
  - JDK 6+ 性能接近，选型看功能需求

StampedLock：
  - 乐观读，性能高 5-10 倍
  - 不可重入 / 不支持 Condition
  - 不适合做"通用锁"
```
