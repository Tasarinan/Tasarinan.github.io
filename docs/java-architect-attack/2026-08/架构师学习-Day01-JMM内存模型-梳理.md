# 架构师学习-Day01-JMM 内存模型-梳理

> 日期：2026年08月10日（周一）
> 周主题：并发编程专题 - JMM / synchronized 锁升级 / AQS / 并发容器 / 线程池 / 虚拟线程
> 梳理日：Day01 - 架构师视角梳理

---

## 一、架构师视角下的 JMM

### 1.1 不只是"可见性 / 原子性 / 有序性"，是"跨线程契约"

很多工程师把 JMM 当成"八股文"--背完三大特性、volatile、happens-before 就完了。架构师视角下，JMM 是**跨线程契约**：

| 架构决策 | 受 JMM 约束的具体点 |
|---------|--------------------|
| 单例用什么实现（DCL / 静态内部类 / 枚举） | DCL 必须 volatile，否则半构造对象被读 |
| 状态标志位用什么（boolean / volatile / AtomicBoolean） | boolean 不行，volatile 行，AtomicBoolean 性能差但功能强 |
| 长整型计数器用什么（long / volatile long / AtomicLong / LongAdder） | long 不行，volatile 不行（不保证 ++），低并发 AtomicLong，高并发 LongAdder |
| 不可变类怎么设计（普通类 / final 字段 / record） | final 字段享受 JMM 安全发布，普通类不享受 |
| 跨线程共享对象怎么发布（构造函数内启动线程 / this 引用泄漏 / 安全发布） | 构造函数内启动线程要确保 happens-before，this 引用泄漏是反模式 |

如果不懂 JMM 背后的契约逻辑，并发编程就是"碰运气"--碰巧某个场景下没出问题就以为写对了，下次换个 JVM / 换个 CPU 架构 / 换个负载就崩了。

### 1.2 JMM 的本质：抽象跨硬件的可见性保证

JMM 本质是**抽象层**，屏蔽硬件差异：

```
┌─────────────────────────────────────────────┐
│  Java 代码（volatile / synchronized / final）│
├─────────────────────────────────────────────┤
│  JMM 抽象（主内存 vs 工作内存 + 8 大操作）  │
├─────────────────────────────────────────────┤
│  JIT 编译器（根据目标 CPU 插入屏障）        │
├─────────────────────────────────────────────┤
│  硬件内存模型（x86 强 / ARM 弱）            │
├─────────────────────────────────────────────┤
│  CPU Cache + MESI + Store Buffer + InvQueue │
├─────────────────────────────────────────────┤
│  物理内存（DRAM）                           │
└─────────────────────────────────────────────┘
```

**关键认知**：程序员写一份 Java 代码，JMM 通过 JIT 在不同 CPU 上插入不同的屏障，保证语义一致。架构师不需要关心 x86 vs ARM 的差异，但需要理解 JMM 屏障的硬件开销。

### 1.3 JMM 的"契约"哲学：程序员 vs JVM

JMM 是**程序员与 JVM 的契约**：

| 程序员义务 | JVM 保证 |
|-----------|---------|
| 写 volatile / synchronized / Lock 建立跨线程 happens-before | 跨线程可见性 |
| 不写 volatile / synchronized | **不保证**可见性（JIT 可激进优化） |
| 用 final 修饰不可变字段 | 安全发布（对象发布即就绪） |
| 用 Atomic* / LongAdder | 原子操作 + 跨线程可见性 |
| 不用任何同步机制 | as-if-serial（单线程语义）+ 跨线程不确定 |

**架构师思维**：JMM 的契约是"程序员显式建立关系，JVM 才保证可见性"。这与社会契约类似--"你不签合同，法律不保护你"。架构师 Code Review 时要识别"跨线程共享但无显式同步"的反模式。

### 1.4 JMM 与 JVM 内存的命名陷阱

JMM 的"主内存 vs 工作内存"与 JVM 的"堆 vs 栈"是**两个不同维度**，容易混淆：

| 概念 | 维度 | 含义 |
|------|------|------|
| JMM 主内存 | 抽象 | 所有线程共享的内存区域 |
| JMM 工作内存 | 抽象 | 线程私有的内存副本 |
| JVM 堆 | 物理 | 对象存储区域（共享） |
| JVM 栈 | 物理 | 线程私有（局部变量 / 操作数栈） |
| JVM 方法区 | 物理 | 类信息 / 常量 / 静态变量（共享） |

**对应关系**：

- 主内存 ≈ 堆 + 方法区（共享部分）
- 工作内存 ≈ 栈 + CPU Cache + 寄存器（线程私有部分）

**架构师经验**：面试官常问"JMM 主内存对应 JVM 什么"答"堆"只对一半，完整答案是"堆 + 方法区"，因为静态变量也在主内存。

---

## 二、JMM 的本质：跨线程可见性的契约

### 2.1 可见性的"传播链"

跨线程可见性不是"瞬间生效"，而是**传播链**：

```
线程 A 修改变量
  ↓
线程 A 工作内存 assign
  ↓
线程 A 工作内存 store
  ↓
主内存 write
  ↓
线程 B 工作内存 read
  ↓
线程 B 工作内存 load
  ↓
线程 B use
```

**关键认知**：每个箭头都是一次内存操作，可能被优化（Store Buffer / Cache / 乱序执行）打断。volatile / synchronized 通过屏障强制刷主内存 + 强制从主内存取，缩短传播链。

### 2.2 可见性的"延迟"特性

跨线程可见性不是"实时"，而是**有延迟**：

| 同步机制 | 延迟（x86） | 原因 |
|---------|------------|------|
| 无同步 | 不确定（可能永远不可见） | JIT 优化成 while(true) |
| volatile | 100-300 ns | StoreLoad 屏障等 Store Buffer 排空 |
| synchronized | 1-10 μs | 加锁 + 上下文切换 |
| Lock | 1-10 μs | CAS + AQS 队列 |
| Atomic* | 100-500 ns | CAS（volatile 语义） |

**架构师经验**：volatile 的可见性延迟约 100-300 纳秒，对绝大多数业务可忽略。但**对超高频交易（10w+ QPS）可能影响 P99**，需要权衡"volatile 可见性 vs 性能"。

### 2.3 有序性的"重排序源"

有序性问题来自**多层重排序**：

| 重排序源 | 层级 | 是否可优化 |
|---------|------|-----------|
| 编译器重排序 | javac | 极少（保守） |
| JIT 重排序 | JVM | 激进（基于 Profile） |
| CPU 重排序 | 硬件 | 激进（Store Buffer / InvQueue） |
| Cache 重排序 | 硬件 | MESI 协议 |

**关键认知**：JMM 通过 4 类屏障（LoadLoad / StoreStore / LoadStore / StoreLoad）禁止特定重排序，但**不能完全消除**--JMM 只保证"程序员可见的有序性"，不保证"硬件层无重排序"。

### 2.4 原子性的"粒度"

原子性是**粒度问题**：

| 操作 | 原子粒度 | 多线程安全 |
|------|---------|-----------|
| int / 引用读写 | 单次读写原子 | 否（读-改-写不原子） |
| long / double 读写 | 32 位 JVM 不保证原子 | 否 |
| volatile 读写 | 单次读写原子 | 否（i++ 仍不原子） |
| synchronized 块 | 整块原子 | 是 |
| Atomic* | 单次 CAS 原子 | 是 |
| LongAdder | 分片 + 合并原子 | 是（高并发更优） |

**架构师经验**：原子性不是"非黑即白"，而是"粒度选择"。架构师需要根据业务场景（读多写少 / 读少写多 / 读-改-写频繁）选择合适的原子粒度。

---

## 三、volatile vs synchronized vs final 选型决策树

### 3.1 选型矩阵

| 场景 | 推荐 | 原因 |
|------|------|------|
| 状态标志位（running / stopped） | volatile | 单读单写，无复合操作 |
| DCL 单例 | volatile | 禁止指令重排序 |
| i++ / i-- | AtomicLong / LongAdder | 复合操作需 CAS |
| 复合操作（check-then-act） | synchronized / Lock | 需要临界区 |
| 不可变配置类 | final 字段 | 安全发布 |
| 长字符串共享 | String（final） | 不可变 + 安全发布 |
| 集合多线程读写 | ConcurrentHashMap / CopyOnWriteArrayList | 并发容器 |
| 阻塞队列 | ArrayBlockingQueue / LinkedBlockingQueue | 内置锁 + Condition |

### 3.2 决策树

```
跨线程共享？
  ├─ 否 -> 普通变量（线程栈隔离）
  └─ 是 -> 单读单写？
          ├─ 是 -> volatile
          └─ 否 -> 读-改-写？
                  ├─ 是 -> 单变量？
                          ├─ 是 -> AtomicLong / LongAdder
                          └─ 否 -> synchronized / Lock
                  └─ 否 -> 复合操作？
                          ├─ 是 -> synchronized / Lock
                          └─ 否 -> 不可变？
                                  ├─ 是 -> final 字段
                                  └─ 否 -> 并发容器（ConcurrentHashMap 等）
```

### 3.3 volatile 的"甜蜜区"与"陷阱区"

**甜蜜区**（volatile 适合）：

```java
// 状态标志位
private volatile boolean running = true;
public void stop() { running = false; }
public void run() { while (running) { ... } }

// DCL 单例
private static volatile SessionManager instance;

// 一次性发布
private volatile AppConfig config;
public void init() { config = new AppConfig(); }
public AppConfig get() { return config; }
```

**陷阱区**（volatile 不适合）：

```java
// 反例 1：i++ 不是原子
private volatile int count = 0;
count++;  // 不安全

// 反例 2：复合操作
private volatile Map<String, User> userMap = new HashMap<>();
userMap.put("k", user);  // 不安全（HashMap 本身非线程安全）

// 反例 3：check-then-act
private volatile boolean initialized = false;
if (!initialized) {  // 多线程同时通过此判断
    init();
    initialized = true;
}
```

**架构师经验**：volatile 的核心是"单读单写"，一旦涉及"读-改-写"或"check-then-act"，必须升级到 Atomic / synchronized / Lock。

### 3.4 final 的"安全发布"工程价值

final 的工程价值常被低估。**final 不是"语法糖"，是 JMM 的安全发布机制**：

```java
// 反例：不安全发布
public class UnsafeConfig {
    private int timeout;  // 非 final
    private String name;  // 非 final

    public UnsafeConfig(int t, String n) {
        timeout = t;
        name = n;
    }
    // 其他线程可能读到 timeout=0, name=null（半构造）
}

// 正例：安全发布
public class SafeConfig {
    private final int timeout;    // final
    private final String name;    // final

    public SafeConfig(int t, String n) {
        timeout = t;
        name = n;
    }
    // 其他线程读到的一定是完整对象
}
```

**final 的 5 大工程价值**：

1. **安全发布**：JMM 保证 final 字段在构造函数返回前完成
2. **不可变**：final 字段不可修改，天然线程安全
3. **hashCode 缓存**：不可变对象的 hashCode 计算一次后缓存（如 String）
4. **字段内存语义**：final 字段的读不需要 volatile / synchronized
5. **架构清晰**：final 表达"设计意图"（不可变配置 / DTO / 值对象）

**架构师经验**：能 final 的字段尽量 final。Code Review Checklist 应包含"所有可 final 的字段是否加了 final"。

---

## 四、happens-before 工程价值

### 4.1 happens-before 不是"时间先后"

很多工程师误以为"happens-before = 时间先后"，**这是误解**：

```java
// 线程 A
int x = 1;     // A1，时间 0
int y = 2;     // A2，时间 1

// 线程 B
int b = y;     // B1，时间 2，可能读到 0 或 2
int a = x;     // B2，时间 3，可能读到 0 或 1
```

**关键认知**：即使 A1 在时间上先于 B2，B2 仍可能读到 x=0。因为 A1 和 B2 之间没有 happens-before 关系，JMM 不保证可见性。

### 4.2 happens-before 是"可见性保证"

happens-before 是**可见性保证**，不是"时间顺序"：

| 关系 | 时间先后 | happens-before | 可见性 |
|------|---------|---------------|--------|
| A1 → B2 | A1 先 B2 后 | 无 | B2 不一定看到 A1 |
| A1 → A2 → B2 | A1 → A2 → B2 | A1 hb A2（程序顺序），A2 hb B2（volatile） | B2 看到 A1（传递性） |
| A unlock → B lock | A 先 B 后 | A unlock hb B lock | B 看到 A 的修改 |

### 4.3 建立跨线程 happens-before 的 5 种方法

1. **volatile**：写 hb 后续读
2. **synchronized / Lock**：unlock hb 后续 lock
3. **线程启动**：start() hb 子线程内任意操作
4. **线程终止**：子线程操作 hb 主线程 join() 返回
5. **并发容器**：ConcurrentHashMap / BlockingQueue 内部用 volatile + CAS

### 4.4 happens-before 的传递性工程价值

传递性是 happens-before 最有用的工程价值：

```java
// 线程 A
data = 42;              // A1，普通写
ready = true;            // A2，volatile 写

// 线程 B
if (ready) {             // B1，volatile 读
    int x = data;        // B2，普通读
    // x 一定 = 42（A1 hb A2 hb B1 hb B2，传递性）
}
```

**关键认知**：通过 volatile 中转，可以把普通写的可见性"传递"给其他线程的普通读。这是 DCL 单例、状态机、配置发布的核心机制。

### 4.5 happens-before 反模式

**反模式 1：Thread.start 之前在主线程做的修改**

```java
// 错误理解：以为 start() 之前的修改都会被子线程看到
int x = 1;  // 主线程
Thread t = new Thread(() -> {
    // 子线程一定能看到 x=1（因为 start() hb 子线程内任意操作）
});
x = 2;  // 主线程，在 start 之后修改
t.start();
// 子线程可能看到 x=1 或 x=2（x=2 没有 hb 子线程内操作）
```

**反模式 2：构造函数内启动新线程**

```java
public class BadPattern {
    private int x;

    public BadPattern() {
        x = 1;
        new Thread(() -> {
            // 子线程可能读到 x=0（构造函数未完成）
            System.out.println(x);
        }).start();
    }
}
```

**修复**：用 final 修饰 x，或把新线程启动移到构造函数外。

**反模式 3：this 引用泄漏**

```java
public class ThisEscape {
    private int x;

    public ThisEscape(EventSource source) {
        source.registerListener(new EventListener() {
            public void onEvent() {
                // 这里持有 ThisEscape.this，可能读到半构造对象
                doSomething(x);
            }
        });
        x = 1;
    }
}
```

**修复**：用"工厂模式"或"静态内部类"避免 this 泄漏。

---

## 五、JMM 陷阱与生产实践

### 5.1 5 类 JMM 反模式识别清单

| 反模式 | 典型代码 | 修复方案 |
|--------|---------|---------|
| 状态标志位不加 volatile | `private boolean running = true;` | 加 volatile |
| DCL 不加 volatile | `private static Singleton instance;` | 加 volatile 或用静态内部类 |
| long ++ 用 volatile | `private volatile long count; count++;` | AtomicLong / LongAdder |
| 复合操作用 volatile | `if (!inited) { init(); inited = true; }` | synchronized / Lock |
| 不安全发布 | 构造函数内启动新线程 / this 引用泄漏 | final 字段 / 工厂模式 |

### 5.2 long 计数器的选型决策

在线问诊系统的 RTP 包计数器选型：

| 并发度 | 推荐 | 原因 |
|--------|------|------|
| &lt; 1k QPS | AtomicLong | CAS 简单高效 |
| 1k-10k QPS | AtomicLong | CAS 仍可承受 |
| 10k-100k QPS | LongAdder | Cell 分散减少 CAS 冲突 |
| > 100k QPS | LongAdder | AtomicLong CAS 冲突严重 |

**LongAdder 原理**：

```
AtomicLong：
  - 单个 volatile long value
  - CAS 自旋，高并发下 CAS 失败率高

LongAdder：
  - base value + Cell[] 数组
  - 不同线程 hash 到不同 Cell，减少 CAS 冲突
  - sum() 时合并 base + 所有 Cell
```

**架构师经验**：10w QPS 的 RTP 包计数器，AtomicLong 在 8 核机器上 CAS 冲突率约 60%，吞吐降低 5 倍；LongAdder 冲突率 &lt; 5%，吞吐接近线性扩展。

### 5.3 单例的 4 种实现与选型

| 实现 | 线程安全 | 懒加载 | 性能 | 推荐度 |
|------|---------|--------|------|--------|
| 饿汉式 | 是（JVM 类加载保证） | 否 | 高 | 中 |
| DCL | 是（volatile） | 是 | 中 | 低（心智负担） |
| 静态内部类 | 是（JVM 类加载保证） | 是 | 高 | 高 |
| 枚举 | 是（JVM 类加载保证） | 否 | 高 | 高（防反射） |

**DCL 的复杂心智**：

```java
// DCL 看起来简单，实际容易写错
private static volatile SessionManager instance;  // 必须 volatile
public static SessionManager getInstance() {
    if (instance == null) {                      // 第一次检查（无锁）
        synchronized (SessionManager.class) {
            if (instance == null) {              // 第二次检查（加锁）
                instance = new SessionManager();
            }
        }
    }
    return instance;
}
```

**架构师推荐**：用静态内部类（同样懒加载 + 同样高性能 + 心智简单）：

```java
public class SessionManager {
    private static class Holder {
        private static final SessionManager INSTANCE = new SessionManager();
    }
    public static SessionManager getInstance() {
        return Holder.INSTANCE;
    }
}
```

**原理**：JVM 类加载机制保证 Holder 类在第一次被引用时初始化，且类加载是线程安全的（JVM 内部锁）。

### 5.4 volatile 的性能成本

volatile 不是"免费"的：

| 操作 | x86 时钟周期 | 相对成本 |
|------|------------|---------|
| 普通读 | 1-3 | 1x |
| volatile 读 | 1-3 | 1x（x86 强模型，几乎免费） |
| 普通写 | 1-3 | 1x |
| volatile 写 | 100-300 | 50-100x（StoreLoad 屏障） |
| synchronized 加锁 | 1000-10000 | 500-5000x（上下文切换） |

**架构师经验**：volatile 读在 x86 上几乎免费，但 volatile 写较贵（100-300 周期）。**高频写场景要慎用 volatile**，可以用 Atomic* 或 LongAdder 替代。

### 5.5 JMM 与硬件架构的关系

不同硬件架构下 JMM 的性能差异：

| 硬件 | 内存模型 | volatile 写开销 | volatile 读开销 |
|------|---------|----------------|----------------|
| x86 | 强 | 100-300 周期（lock 前缀） | 1-3 周期（几乎免费） |
| ARM | 弱 | 200-500 周期（dmb） | 50-100 周期（dmb） |
| POWER | 弱 | 200-500 周期 | 50-100 周期 |

**架构师经验**：

- x86 服务端：volatile 几乎免费，可以多用
- ARM 移动端：volatile 开销大，要慎用，优先用 final
- 跨平台服务：JMM 抽象保证语义一致，但性能差异需考虑

---

## 六、在线问诊系统的 JMM 决策实战

### 6.1 IM 网关 SessionManager 单例选型

**场景**：IM 网关 10w+ 长连接，SessionManager 管理所有用户会话，必须单例。

**选型对比**：

| 方案 | 优点 | 缺点 | 选择 |
|------|------|------|------|
| 饿汉式 | 简单 | 启动即初始化，可能没用 | 否 |
| DCL + volatile | 懒加载 | 心智复杂 | 否 |
| 静态内部类 | 懒加载 + 简单 | 无 | **是** |
| 枚举 | 简单 + 防反射 | 不能懒加载 | 否（需懒加载） |

**最终方案**：静态内部类。

```java
public class SessionManager {
    private static class Holder {
        private static final SessionManager INSTANCE = new SessionManager();
    }
    public static SessionManager getInstance() {
        return Holder.INSTANCE;
    }
}
```

### 6.2 视频问诊 RTP 包计数器选型

**场景**：单机 10w+ QPS 的 RTP 包计数器，多线程 ++ 统计总包数。

**选型对比**：

| 方案 | 10w QPS 吞吐 | CPU 占用 | 选择 |
|------|-------------|---------|------|
| long ++ | 不可用（丢失更新） | - | 否 |
| volatile long ++ | 不可用（不原子） | - | 否 |
| AtomicLong | 2w QPS（CAS 冲突） | 80% | 否 |
| LongAdder | 12w QPS（线性扩展） | 30% | **是** |

**最终方案**：LongAdder。

```java
private final LongAdder rtpCount = new LongAdder();

public void onRtpPacket() {
    rtpCount.increment();
}

public long getRtpCount() {
    return rtpCount.sum();
}
```

### 6.3 问诊订单状态机设计

**场景**：问诊订单状态机（待支付 / 已支付 / 问诊中 / 已完成 / 已取消），多线程读写。

**选型对比**：

| 方案 | 优点 | 缺点 | 选择 |
|------|------|------|------|
| volatile OrderStatus | 可见性 | 不保证 CAS | 否 |
| synchronized + OrderStatus | 完整原子 | 性能差 | 中（备选） |
| AtomicReference&lt;OrderStatus> | CAS 原子 | 中等 | **是** |

**最终方案**：AtomicReference + CAS。

```java
private final AtomicReference<OrderStatus> status =
    new AtomicReference<>(OrderStatus.PENDING);

public boolean pay() {
    return status.compareAndSet(OrderStatus.PENDING, OrderStatus.PAID);
}

public boolean startConsult() {
    return status.compareAndSet(OrderStatus.PAID, OrderStatus.IN_PROGRESS);
}
```

**关键认知**：CAS + 状态机是"乐观锁"思维，比 synchronized 性能高 5-10 倍。

### 6.4 监管上报服务的优雅停机

**场景**：监管上报服务 24h 必达，优雅停机时正在处理的消息必须发完。

**反例**（不加 volatile）：

```java
private boolean running = true;  // 不加 volatile

public void shutdown() {
    running = false;  // 主线程修改
}

public void run() {
    while (running) {  // 工作线程可能看不到
        Message msg = queue.take();
        sendToSupervisor(msg);
    }
}
```

**正例**（加 volatile）：

```java
private volatile boolean running = true;  // volatile

public void shutdown() {
    running = false;
    // 唤醒可能阻塞在 queue.take() 的工作线程
    queue.put(Message.POISON);
}

public void run() {
    while (running) {
        Message msg = queue.take();
        if (msg == Message.POISON) break;
        sendToSupervisor(msg);
    }
}
```

**架构师经验**：volatile 是必要但不充分条件。`queue.take()` 阻塞时，工作线程不会检查 running，必须用 POISON 消息唤醒。

### 6.5 IM 网关心跳配置类

**场景**：IM 网关心跳配置（间隔 / 超时 / 重试次数），全局共享。

**选型**：final 字段 + 静态内部类（不可变 + 安全发布）。

```java
public final class HeartbeatConfig {
    private final int interval;      // 心跳间隔（ms）
    private final int timeout;       // 心跳超时（ms）
    private final int retryCount;    // 重试次数

    public HeartbeatConfig(int interval, int timeout, int retryCount) {
        this.interval = interval;
        this.timeout = timeout;
        this.retryCount = retryCount;
    }

    public int getInterval() { return interval; }
    public int getTimeout() { return timeout; }
    public int getRetryCount() { return retryCount; }
}

// 使用
private static final HeartbeatConfig CONFIG =
    new HeartbeatConfig(30000, 60000, 3);
```

**关键认知**：final 字段 + 不可变类，享受 JMM 安全发布，无需 volatile / synchronized。

---

## 七、本日核心认知

1. **JMM 是跨线程契约，不是"八股文"**：架构师需要从"可见性 / 原子性 / 有序性"升华到"跨线程可见性保证"的工程思维
2. **JMM 是抽象层，屏蔽硬件差异**：JIT 根据目标 CPU 自动插入屏障，程序员写一份代码跨平台运行
3. **happens-before 不是时间先后，是可见性保证**：即使 A 在时间上先于 B，无 happens-before 关系则不可见
4. **volatile 适合单读单写，不适合复合操作**：i++ / check-then-act 必须升级到 Atomic / synchronized
5. **final 是 JMM 的安全发布机制**：final 字段保证"对象发布即就绪"，是不可变类的基石
6. **DCL 心智负担重，优先用静态内部类**：静态内部类同样懒加载 + 高性能 + 心智简单
7. **long 计数器在高并发用 LongAdder**：AtomicLong 在 10w+ QPS 下 CAS 冲突严重，LongAdder Cell 分散近线性扩展
8. **JMM 与硬件架构相关**：x86 强模型 volatile 读几乎免费，ARM 弱模型 volatile 开销大
9. **5 类 JMM 反模式识别是 Code Review 必备**：状态标志位 / DCL / long++ / 复合操作 / 不安全发布
10. **架构师视角：能用 final 就不用 volatile，能用 volatile 就不用 synchronized**：同步机制成本递增，按需选择
