# 架构师学习-Day02-synchronized 锁升级-梳理

> 日期：2026年08月11日（周二）
> 周主题：并发编程专题 - JMM / synchronized 锁升级 / AQS / 并发容器 / 线程池 / 虚拟线程
> 梳理日：Day02 - 架构师视角梳理

---

## 一、架构师视角下的 synchronized 锁升级

### 1.1 不只是"4 个状态"，是"自适应优化哲学"

很多工程师把 synchronized 锁升级当成"4 个状态记一记"就完了。架构师视角下，synchronized 锁升级是**自适应优化哲学**：

| 设计哲学 | synchronized 实现 |
|---------|------------------|
| 乐观假设 | 多数情况下无竞争 -> 偏向锁直接比较 ThreadID |
| 渐进升级 | 竞争出现 -> 偏向锁升级为轻量级锁（CAS 自旋） |
| 兜底保障 | 高竞争 -> 升级为重量级锁（OS Mutex） |
| 自适应调整 | 自旋次数根据历史成功率动态调整 |
| JIT 智能优化 | 锁消除（逃逸分析）+ 锁粗化（循环外提） |

如果不懂这套哲学，synchronized 在你眼里就是"加了锁就行"，根本不知道为什么 JDK 6+ 的 synchronized 性能已经接近 ReentrantLock。

### 1.2 锁升级的本质：用 CPU 时间换系统调用

synchronized 锁升级的核心 trade-off 是**用 CPU 时间换系统调用**：

```
偏向锁：纯 CPU 比较，0 系统调用（最快）
  ↓ 竞争出现
轻量级锁：CAS 自旋，0 系统调用（消耗 CPU）
  ↓ 自旋失败
重量级锁：OS Mutex，1-10 μs 系统调用（不消耗 CPU，但切换慢）
```

**关键认知**：

- **偏向锁**：假设"无竞争"，用最便宜的 CPU 操作
- **轻量级锁**：假设"短竞争"，用 CPU 自旋换"不阻塞"
- **重量级锁**：高竞争下，让线程阻塞（不消耗 CPU），但付出系统调用开销

**架构师思维**：锁升级不是"自动选最快"，是"按竞争强度选最优"。

### 1.3 synchronized 与 JVM 的深度耦合

synchronized 是**JVM 内置锁**，与 JVM 多个机制深度耦合：

| JVM 机制 | 与 synchronized 的耦合 |
|---------|----------------------|
| 对象头 Mark Word | 存锁状态 / 线程 ID / hashCode |
| JIT 编译器 | 锁消除 / 锁粗化 / 逃逸分析 |
| Safepoint | 偏向锁撤销需要 STW |
| ObjectMonitor | 重量级锁的实现 |
| GC 标记 | GC 时锁状态重置 |

**关键认知**：synchronized 不只是"语法"，是 JVM 整体设计的一部分。**这就是为什么 synchronized 性能优化必须从 JVM 层做**（JIT 锁消除 / 锁粗化 / 锁升级），不能在应用层做。

### 1.4 synchronized 的"零成本抽象"理想

synchronized 设计的初心是"零成本抽象"--**让程序员写最简单的代码，JVM 自动优化**：

```java
// 程序员写的代码（简单）
synchronized (lock) {
    counter++;
}

// JVM 实际执行（复杂）
1. 检查 Mark Word，判断锁状态
2. 偏向锁？比较 ThreadID
3. 轻量级锁？CAS 替换 Mark Word
4. 重量级锁？进入 EntryList 阻塞
5. JIT 检查：能否锁消除？能否锁粗化？
6. 释放锁：CAS 还原 Mark Word / 唤醒 EntryList
```

**关键认知**：synchronized 让程序员"不需要懂锁升级也能写并发代码"，但架构师必须懂--否则在性能调优时无从下手。

---

## 二、Mark Word 与对象头：Java 对象的"身份证"

### 2.1 对象头的工程价值

每个 Java 对象都有对象头，存储"对象的元信息"：

```
┌────────────────────────────────────┐
│  Object Header                     │
│  ┌──────────────────────────────┐  │
│  │  Mark Word（8 字节）         │  │
│  ├──────────────────────────────┤  │
│  │  Klass Pointer（4/8 字节）   │  │
│  ├──────────────────────────────┤  │
│  │  数组长度（仅数组对象，4 字节）│  │
│  └──────────────────────────────┘  │
└────────────────────────────────────┘
```

**Mark Word 的"信息密度"**：

64 bit 存了 5 类信息（互斥状态）：

- 无锁状态：hashCode (31) + age (4) + biased (1) + lock (2)
- 偏向锁状态：threadId (54) + epoch (2) + age (4) + biased (1) + lock (2)
- 轻量级锁：Lock Record 指针 (62) + lock (2)
- 重量级锁：ObjectMonitor 指针 (62) + lock (2)
- GC 标记：lock (2) = 11

**关键认知**：Mark Word 是"信息密度极高"的数据结构，5 种状态共享 64 bit，每种状态都有 trade-off。

### 2.2 小对象的"对象头膨胀"问题

Java 对象头至少 12 字节（指针压缩 + 8 字节对齐到 16 字节）：

| 对象 | 数据大小 | 对象头 | 总大小 | 对象头占比 |
|------|---------|--------|--------|-----------|
| Integer | 4 字节 | 16 字节 | 16 字节 | 75% |
| Long | 8 字节 | 16 字节 | 24 字节 | 67% |
| Date | 8 字节（long millis） | 16 字节 | 24 字节 | 67% |
| String（空） | 0 字节 | 16 字节 + 4 字节 hash + 4 字节 coder | 24 字节 | 67% |

**架构师经验**：小对象的"对象头膨胀"导致内存浪费。**百万级 Integer 列表占用 16 MB**（实际数据仅 4 MB）。这是为什么：

1. 高性能库（如 Eclipse Collections / Agrona）用原始类型数组替代包装类
2. Project Valhalla（值类型）旨在消除小对象的对象头
3. Project Lilliput 旨在缩小对象头到 64 bit（4-8 字节）

### 2.3 Mark Word 与 GC 分代年龄

Mark Word 的 4 bit 存 GC 分代年龄（最大 15）：

```
age: 4 bit
  - 0000: 0 岁（Eden）
  - 0001: 1 岁（Survivor 1）
  - ...
  - 1111: 15 岁（晋升老年代）
```

**关键认知**：

- 4 bit 上限是 15，所以 `-XX:MaxTenuringThreshold` 最大只能设 15
- G1 默认 15，Parallel 默认 15，CMS 默认 6
- 设 `-XX:MaxTenuringThreshold=16` 会报错（超出 4 bit 范围）

**架构师经验**：Mark Word 4 bit 限制是历史包袱。Project Lilliput 计划用更多 bit 存其他信息，分代年龄可能压缩到 3 bit（最大 7）。

### 2.4 Mark Word 与 hashCode 的关系

Mark Word 的 31 bit 存"identity hash code"（不是 `hashCode()` 重写后的值）：

- **identity hash code**：`System.identityHashCode(obj)` 返回的值，JVM 自动生成
- **hashCode()**：可以被重写，返回任意值

**Mark Word 存储 identity hash code 的时机**：

1. 对象创建时：不存 hash
2. 首次调用 `System.identityHashCode(obj)`：计算 hash 并存入 Mark Word
3. 后续调用：直接从 Mark Word 读

**关键认知**：

- 一旦存了 identity hash code，**偏向锁必须撤销**（Mark Word 没空间同时存 hash 和 ThreadID）
- 这是为什么"在 synchronized 之前调用 hashCode 会影响偏向锁优化"

**架构师经验**：避免在 synchronized 块前调用 `System.identityHashCode()`，否则偏向锁会被强制撤销。

---

## 三、锁升级链：从无锁到重量级锁

### 3.1 锁升级的"5 个阶段"

```
创建对象（无锁）
  ↓ 首次有线程访问
偏向锁（CAS 都省，直接比较 ThreadID）
  ↓ 其他线程竞争
撤销偏向 + 升级轻量级锁（CAS 自旋）
  ↓ 自旋失败（自适应阈值）
重量级锁（OS Mutex，线程阻塞）
  ↓ GC 来临
GC 标记（标记位 11）
  ↓ GC 完成
重置为无锁
```

### 3.2 锁升级的"代价曲线"

| 锁状态 | 加锁开销 | 释放开销 | 适用场景 |
|--------|---------|---------|---------|
| 无锁 | 0 | 0 | 无并发访问 |
| 偏向锁 | 1-3 ns | 1-3 ns | 单线程长期持有 |
| 轻量级锁 | 100-300 ns | 100-300 ns | 多线程交替，无实际竞争 |
| 重量级锁 | 1-10 μs | 1-10 μs | 高竞争 |

**关键认知**：

- 偏向锁 -> 轻量级锁：~100 倍开销
- 轻量级锁 -> 重量级锁：~30 倍开销
- 重量级锁加锁 ≈ 1000 倍偏向锁

**架构师经验**：锁升级带来"性能断崖"，从微秒级降到纳秒级。**避免升级到重量级锁是 synchronized 优化的核心目标**。

### 3.3 偏向锁的"撤销成本"陷阱

偏向锁本身开销极低，但**撤销成本高**：

| 撤销场景 | 开销 |
|---------|------|
| 其他线程首次竞争 | STW Safepoint + 撤销 |
| 调用 hashCode | STW Safepoint + 撤销 |
| 调用 wait/notify | STW Safepoint + 撤销（直接升级重量级） |

**关键认知**：偏向锁撤销需要 STW，每次撤销约 10-100 μs。**高竞争场景下偏向锁频繁撤销，反而比直接轻量级锁更慢**。

**架构师经验**：

- 高竞争场景考虑 `-XX:-UseBiasedLocking`（JDK 14+ 默认关闭）
- 避免在 synchronized 块前调用 hashCode
- 避免在偏向锁场景下使用 wait/notify

### 3.4 轻量级锁的"自旋消耗"陷阱

轻量级锁用 CAS 自旋避免系统调用，但**自旋消耗 CPU**：

```
CAS 自旋 100 次：
  - 每次 CAS 约 100 ns
  - 100 次 = 10 μs
  - 期间 CPU 100% 占用

OS Mutex 阻塞：
  - 加锁 1-10 μs
  - 阻塞期间 CPU 0% 占用
  - 唤醒 1-10 μs
```

**关键认知**：

- 持有时间 &lt; 10 μs：自旋更优
- 持有时间 > 100 μs：阻塞更优
- 持有时间 10-100 μs：自适应自旋（动态调整）

**架构师经验**：自适应自旋（JDK 6+）会根据历史成功率调整自旋次数，但仍可能误判。**临界区超过 1ms 的同步块，应该避免依赖轻量级锁自旋**。

### 3.5 重量级锁的"用户态-内核态切换"

重量级锁的核心开销是**用户态-内核态切换**：

```
线程 A 持有锁
  ↓
线程 B 尝试加锁，失败
  ↓
线程 B 调用 park()，进入内核态（用户态 -> 内核态切换）
  ↓
内核把线程 B 加入等待队列，标记为 BLOCKED
  ↓
线程 A 释放锁，调用 unpark(B)
  ↓
内核唤醒线程 B，B 进入就绪队列
  ↓
调度器选中 B，B 从内核态返回用户态（内核态 -> 用户态切换）
  ↓
线程 B 拿到锁，继续执行
```

**关键认知**：每次 park/unpark 涉及 2 次状态切换，约 1-10 μs 开销。

**减少切换的方法**：

1. **减少锁竞争**：分段锁 / 并发容器
2. **缩短临界区**：同步块内只放必要代码
3. **用 CAS 替代锁**：Atomic* / LongAdder

### 3.6 锁不能降级的设计权衡

synchronized 只能升级，**不能降级**：

- **设计原因**：降级需要 STW，开销大；高竞争时降级，下次又要升级，反复开销
- **GC 时的"伪降级"**：GC 标记阶段会重置 Mark Word，GC 完成后回到无锁状态
- **架构师经验**：不要期望"竞争缓解后锁会降级"。高竞争场景应该用并发容器或分段锁，而不是依赖 synchronized 自动降级

---

## 四、JIT 锁优化：锁消除与锁粗化

### 4.1 锁消除（Lock Elision）的逃逸分析

JIT 通过逃逸分析判断"对象是否逃逸出当前线程"，对不逃逸的对象自动消除锁：

```java
// 原代码
public String concat(String s1, String s2) {
    StringBuffer sb = new StringBuffer();  // sb 不逃逸
    sb.append(s1);  // synchronized 方法
    sb.append(s2);  // synchronized 方法
    return sb.toString();
}

// JIT 锁消除后（等价于）
public String concat(String s1, String s2) {
    StringBuilder sb = new StringBuilder();  // 用非同步版本
    sb.append(s1);
    sb.append(s2);
    return sb.toString();
}
```

**逃逸分析的精度**：

| 场景 | 是否逃逸 | 能否消除 |
|------|---------|---------|
| 局部变量，不返回 | 不逃逸 | 能 |
| 局部变量，作为参数传给非逃逸方法 | 不逃逸 | 能 |
| 字段（成员变量） | 可能逃逸 | 不能 |
| 作为返回值 | 逃逸 | 不能 |
| 传入未知方法 | 逃逸 | 不能 |

**关键认知**：锁消除只对"局部变量 + 不逃逸"有效。**字段加锁不能消除**。

### 4.2 锁粗化（Lock Coarsening）的循环外提

JIT 识别"循环内多次加锁解锁同一对象"，自动把锁提到循环外：

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

**锁粗化的触发条件**：

1. 同一对象多次加锁解锁
2. JIT 能识别循环模式
3. 锁粗化后语义不变（中间无其他线程可见操作）

**架构师经验**：锁粗化是 JIT 自动优化，但不要依赖。**手写时应该把锁提到循环外**，更清晰。

### 4.3 JIT 优化与手写优化的边界

| 优化 | JIT 自动 | 手写 |
|------|---------|------|
| 锁消除（局部变量） | 是 | 用非同步类（StringBuilder） |
| 锁粗化（循环内） | 是 | 手动把锁提到循环外 |
| 减少临界区 | 否 | 把 IO / 长计算移出同步块 |
| 分段锁 | 否 | 用 ConcurrentHashMap / 自己分段 |
| 锁分离（读写分离） | 否 | 用 ReentrantReadWriteLock / StampedLock |

**架构师经验**：JIT 锁消除 / 锁粗化是"自动优化"，但不能完全依赖。架构师需要：

1. 字段优先用并发容器，不依赖 JIT 消除
2. 同步块内只放必要的临界区操作
3. 高并发场景用 CAS / 分段锁替代 synchronized

### 4.4 逃逸分析与 `-XX:+DoEscapeAnalysis`

JDK 6+ 默认开启逃逸分析：

```bash
# 查看逃逸分析是否开启
-XX:+PrintFlagsFinal | grep DoEscapeAnalysis
# 默认值：true（JDK 6+）

# 关闭逃逸分析（用于测试）
-XX:-DoEscapeAnalysis
```

**关闭后的影响**：

- StringBuffer 局部变量不会消除锁，性能降低 2-3 倍
- 对象不会标量替换（拆解为基本类型），内存占用增加

**架构师经验**：测试环境关闭逃逸分析可以"还原真实生产环境"，但生产环境必须开启。

---

## 五、synchronized vs Lock 选型决策树

### 5.1 三大锁的"功能矩阵"

| 功能 | synchronized | ReentrantLock | StampedLock |
|------|--------------|---------------|-------------|
| 自动释放 | 是 | 否（finally） | 否（finally） |
| 可中断 | 否 | 是 | 是 |
| 超时 | 否 | 是（tryLock） | 是（tryLock） |
| 公平锁 | 否 | 是 | 否 |
| 多 Condition | 否 | 是 | 否 |
| 重入 | 是 | 是 | 否 |
| 乐观读 | 否 | 否 | 是 |
| 性能（低并发） | 高 | 高 | 高 |
| 性能（高并发读） | 中 | 中 | 高（5-10 倍） |
| 性能（高并发写） | 中 | 中 | 中 |

### 5.2 选型决策树

```
是否需要锁？
  ├─ 是 -> 是否需要可中断 / 超时 / 公平 / 多 Condition？
  │       ├─ 是 -> ReentrantLock
  │       └─ 否 -> 是否读多写少？
  │               ├─ 是 -> 读比例 > 90%？
  │                       ├─ 是 -> StampedLock（乐观读）
  │                       └─ 否 -> ReentrantReadWriteLock
  │               └─ 否 -> synchronized
  └─ 否 -> 是否需要原子操作？
          ├─ 是 -> Atomic* / LongAdder
          └─ 否 -> 无锁（volatile / final）
```

### 5.3 选型的"3 大原则"

**原则 1：能用 synchronized 就用 synchronized**

- 语法简单，自动释放
- JVM 内置，性能优化持续
- 90% 场景够用

**原则 2：需要高级功能才用 ReentrantLock**

- 可中断：`lockInterruptibly()`
- 超时：`tryLock(timeout)`
- 公平：`new ReentrantLock(true)`
- 多 Condition：`newCondition()`

**原则 3：读多写少才用 StampedLock**

- 读比例 > 90%
- 不需要重入 / Condition
- 程序员能正确使用 validate + retry

### 5.4 JDK 17 偏向锁废弃后的影响

JDK 15 废弃偏向锁（JEP 374）后：

| 场景 | JDK 8/11（偏向锁开启） | JDK 17（偏向锁废弃） |
|------|---------------------|---------------------|
| 单线程长期持有 | 偏向锁，1-3 ns | 轻量级锁，100-300 ns |
| 多线程交替 | 轻量级锁，100-300 ns | 轻量级锁，100-300 ns |
| 高竞争 | 重量级锁，1-10 μs | 重量级锁，1-10 μs |

**关键认知**：

- 单线程场景性能下降约 100 倍（但仍只有 100-300 ns，可接受）
- 多线程 / 高竞争场景无影响

**架构师经验**：JDK 17+ 应用不应该再用"单线程长期持有"模式依赖偏向锁。**如果性能瓶颈在 synchronized，应该用并发容器或 CAS**，而不是依赖偏向锁。

### 5.5 ReentrantLock 的"陷阱"

ReentrantLock 的常见陷阱：

**陷阱 1：忘记 finally unlock**

```java
// 反例
lock.lock();
doSomething();  // 抛异常，锁不释放
lock.unlock();

// 正例
lock.lock();
try {
    doSomething();
} finally {
    lock.unlock();
}
```

**陷阱 2：lockInterruptibly 的 InterruptedException**

```java
// 反例
lock.lockInterruptibly();  // 抛 InterruptedException，但调用方未处理
doSomething();
lock.unlock();

// 正例
try {
    lock.lockInterruptibly();
    try {
        doSomething();
    } finally {
        lock.unlock();
    }
} catch (InterruptedException e) {
    Thread.currentThread().interrupt();
    // 处理中断
}
```

**陷阱 3：tryLock 误用**

```java
// 反例
if (lock.tryLock()) {
    // 拿到锁，但 tryLock 不可重入，可能误判
    doSomething();
    lock.unlock();
}

// 正例
if (lock.tryLock()) {
    try {
        doSomething();
    } finally {
        lock.unlock();
    }
}
```

**架构师经验**：ReentrantLock 的"功能丰富"也是"心智负担"。**能 synchronized 就 synchronized**，把复杂度留给真正需要的场景。

---

## 六、在线问诊系统的锁升级实战

### 6.1 IM 网关 SessionManager 的锁退化事故

**场景**：IM 网关 10w+ 长连接，SessionManager 用 HashMap + synchronized 保护用户会话。

**反例代码**：

```java
public class SessionManager {
    private final Map<String, Session> sessions = new HashMap<>();
    private final Object lock = new Object();

    public Session get(String userId) {
        synchronized (lock) {
            return sessions.get(userId);
        }
    }

    public void put(String userId, Session session) {
        synchronized (lock) {
            sessions.put(userId, session);
        }
    }
}
```

**问题**：10w 长连接下，每秒上万次 get/put，所有线程争抢同一把锁，升级到重量级锁，吞吐骤降到 1k QPS。

**优化方案 1：用 ConcurrentHashMap**

```java
public class SessionManager {
    private final ConcurrentHashMap<String, Session> sessions = new ConcurrentHashMap<>();

    public Session get(String userId) {
        return sessions.get(userId);  // 无锁（CAS）
    }

    public void put(String userId, Session session) {
        sessions.put(userId, session);  // 分段锁
    }
}
```

**优化方案 2：分段锁**

```java
public class SessionManager {
    private final Segment<Session>[] segments;

    public Session get(String userId) {
        int hash = userId.hashCode();
        int idx = (hash >>> 28) & 0x0F;  // 16 个段
        return segments[idx].get(userId);
    }
}
```

**性能对比**：

| 方案 | 10w QPS 吞吐 | CPU 占用 |
|------|-------------|---------|
| synchronized + HashMap | 1k QPS（重量级锁） | 100% |
| ConcurrentHashMap | 12w QPS（分段锁） | 40% |
| 分段锁（16 段） | 10w QPS（接近线性扩展） | 50% |

**架构师经验**：高并发场景下，**synchronized 升级到重量级锁是性能杀手**。优先用并发容器（ConcurrentHashMap / ConcurrentLinkedQueue）。

### 6.2 问诊订单状态机的锁选型

**场景**：问诊订单状态机（待支付 / 已支付 / 问诊中 / 已完成 / 已取消），多线程读写。

**方案 1：synchronized**

```java
public class OrderService {
    private final Object lock = new Object();
    private OrderStatus status = OrderStatus.PENDING;

    public boolean pay() {
        synchronized (lock) {
            if (status != OrderStatus.PENDING) return false;
            status = OrderStatus.PAID;
            return true;
        }
    }
}
```

**方案 2：ReentrantLock**

```java
public class OrderService {
    private final ReentrantLock lock = new ReentrantLock();
    private OrderStatus status = OrderStatus.PENDING;

    public boolean pay() {
        lock.lock();
        try {
            if (status != OrderStatus.PENDING) return false;
            status = OrderStatus.PAID;
            return true;
        } finally {
            lock.unlock();
        }
    }
}
```

**方案 3：AtomicReference + CAS（推荐）**

```java
public class OrderService {
    private final AtomicReference<OrderStatus> status =
        new AtomicReference<>(OrderStatus.PENDING);

    public boolean pay() {
        return status.compareAndSet(OrderStatus.PENDING, OrderStatus.PAID);
    }
}
```

**性能对比**：

| 方案 | 单线程 | 10 线程 | 100 线程 |
|------|--------|---------|---------|
| synchronized | 100 ns | 1 μs | 10 μs |
| ReentrantLock | 200 ns | 1.5 μs | 15 μs |
| AtomicReference + CAS | 50 ns | 200 ns | 1 μs |

**架构师经验**：状态机用 CAS（AtomicReference）比锁高效 10-100 倍。**锁适合"复合操作"，CAS 适合"状态切换"**。

### 6.3 监管上报服务的批量发送锁

**场景**：监管消息批量发送，多线程生产消息，单线程批量消费。

**反例**：

```java
public class SupervisorReporter {
    private final List<Message> buffer = new ArrayList<>();
    private final Object lock = new Object();

    public void send(Message msg) {
        synchronized (lock) {
            buffer.add(msg);
            if (buffer.size() >= 100) {
                flush();
            }
        }
    }

    private void flush() {
        // 批量发送
        for (Message msg : buffer) {
            sendToSupervisor(msg);
        }
        buffer.clear();
    }
}
```

**问题**：同步块内调用 `sendToSupervisor`（网络 IO），临界区过长，所有线程阻塞。

**优化方案 1：缩短临界区**

```java
public void send(Message msg) {
    List<Message> toFlush = null;
    synchronized (lock) {
        buffer.add(msg);
        if (buffer.size() >= 100) {
            toFlush = new ArrayList<>(buffer);
            buffer.clear();
        }
    }
    if (toFlush != null) {
        flush(toFlush);  // 异步发送
    }
}
```

**优化方案 2：用 BlockingQueue**

```java
public class SupervisorReporter {
    private final BlockingQueue<Message> queue = new LinkedBlockingQueue<>(10000);

    public void send(Message msg) {
        queue.put(msg);  // 无锁（CAS + 队列）
    }

    // 单线程消费
    public void startConsumer() {
        new Thread(() -> {
            while (!Thread.currentThread().isInterrupted()) {
                List<Message> batch = new ArrayList<>(100);
                queue.drainTo(batch, 100);
                if (!batch.isEmpty()) {
                    flush(batch);
                }
            }
        }).start();
    }
}
```

**架构师经验**：**同步块内不要做 IO / 长计算**。把耗时操作移出同步块，或用 BlockingQueue 解耦生产消费。

### 6.4 视频问诊房间号的读写锁选型

**场景**：视频问诊房间号管理，读多写少（查询房间 100w QPS，创建房间 100 QPS）。

**方案 1：synchronized**

```java
public class RoomManager {
    private final Map<Long, Room> rooms = new HashMap<>();
    private final Object lock = new Object();

    public Room get(long roomId) {
        synchronized (lock) {
            return rooms.get(roomId);
        }
    }

    public void create(Room room) {
        synchronized (lock) {
            rooms.put(room.getId(), room);
        }
    }
}
```

**问题**：读多写少场景，synchronized 让所有读串行化，吞吐极低。

**方案 2：ReentrantReadWriteLock**

```java
public class RoomManager {
    private final Map<Long, Room> rooms = new HashMap<>();
    private final ReentrantReadWriteLock rwLock = new ReentrantReadWriteLock();

    public Room get(long roomId) {
        rwLock.readLock().lock();
        try {
            return rooms.get(roomId);
        } finally {
            rwLock.readLock().unlock();
        }
    }

    public void create(Room room) {
        rwLock.writeLock().lock();
        try {
            rooms.put(room.getId(), room);
        } finally {
            rwLock.writeLock().unlock();
        }
    }
}
```

**方案 3：StampedLock 乐观读（推荐）**

```java
public class RoomManager {
    private final Map<Long, Room> rooms = new HashMap<>();
    private final StampedLock stampedLock = new StampedLock();

    public Room get(long roomId) {
        long stamp = stampedLock.tryOptimisticRead();  // 乐观读
        Room room = rooms.get(roomId);
        if (!stampedLock.validate(stamp)) {  // 校验
            stamp = stampedLock.readLock();  // 升级为悲观读
            try {
                room = rooms.get(roomId);
            } finally {
                stampedLock.unlockRead(stamp);
            }
        }
        return room;
    }

    public void create(Room room) {
        long stamp = stampedLock.writeLock();
        try {
            rooms.put(room.getId(), room);
        } finally {
            stampedLock.unlockWrite(stamp);
        }
    }
}
```

**方案 4：ConcurrentHashMap（最优）**

```java
public class RoomManager {
    private final ConcurrentHashMap<Long, Room> rooms = new ConcurrentHashMap<>();

    public Room get(long roomId) {
        return rooms.get(roomId);  // 无锁
    }

    public void create(Room room) {
        rooms.put(room.getId(), room);  // CAS
    }
}
```

**性能对比**：

| 方案 | 100w 读 QPS | 100 写 QPS |
|------|-------------|-----------|
| synchronized | 1w QPS（串行） | 1w QPS |
| ReentrantReadWriteLock | 50w QPS（读共享） | 50w QPS |
| StampedLock 乐观读 | 100w QPS（乐观读无锁） | 100w QPS |
| ConcurrentHashMap | 100w+ QPS | 100w+ QPS |

**架构师经验**：读多写少场景优先用 ConcurrentHashMap。**只有需要"复合操作"（如 check-then-act）才用 StampedLock / ReadWriteLock**。

### 6.5 在线问诊系统锁选型 Checklist

| 场景 | 推荐 | 原因 |
|------|------|------|
| 单例模式 | 静态内部类（无需锁） | JVM 类加载保证 |
| 状态标志位 | volatile | 单读单写 |
| 状态机切换 | AtomicReference + CAS | 单变量原子操作 |
| 计数器（低并发） | AtomicLong | CAS |
| 计数器（高并发） | LongAdder | Cell 分散 |
| Map 多线程读写 | ConcurrentHashMap | 分段锁 |
| 队列生产消费 | BlockingQueue | 内置锁 + Condition |
| 列表多线程读写 | CopyOnWriteArrayList | 写时复制 |
| 复合操作 | ReentrantLock / synchronized | 临界区 |
| 读多写少 | StampedLock 乐观读 | 乐观读无锁 |
| 分布式场景 | Redisson / Zookeeper | 分布式锁 |

---

## 七、本日核心认知

1. **synchronized 是 JVM 内置锁，与对象头 Mark Word 深度耦合**：架构师必须懂 Mark Word 5 状态位布局
2. **锁升级是"自适应优化哲学"**：用 CPU 时间换系统调用，按竞争强度选最优
3. **偏向锁在 JDK 15 废弃（JEP 374）**：维护成本高 + 现代硬件 CAS 已极快 + 应用场景变化
4. **轻量级锁适合短临界区 + 低竞争**：自旋消耗 CPU，长临界区应该用重量级锁阻塞
5. **重量级锁的核心开销是用户态-内核态切换**：1-10 μs/次，减少切换是优化的核心
6. **JIT 锁消除依赖逃逸分析，只对局部变量有效**：字段加锁不能消除
7. **JIT 锁粗化对循环内多次加锁有效**：但不要依赖，手写时应该把锁提到循环外
8. **锁不能降级**：高竞争场景应该用并发容器，不依赖 synchronized 自动降级
9. **synchronized vs ReentrantLock 性能已接近**：选型看功能需求，不看性能
10. **StampedLock 是"特种兵"，不是"通用锁"**：读多写少 + 不需重入 + 不需 Condition 才用
11. **架构师视角：能用 synchronized 就 synchronized，能用 CAS 就 CAS，能用并发容器就并发容器**--同步机制成本递增，按需选择
