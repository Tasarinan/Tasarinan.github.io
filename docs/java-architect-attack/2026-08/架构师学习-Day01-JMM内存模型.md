# 架构师学习-Day01-JMM 内存模型

> 日期：2026年08月10日（周一）
> 周主题：并发编程专题 - JMM / synchronized 锁升级 / AQS / 并发容器 / 线程池 / 虚拟线程
> 出题日：Day01 - JMM 内存模型

---

## 背景

经过 13 周专题训练（CAP/MQ/微服务/MySQL/Redis/ES/限流降级/支付/医疗×2/K8s + 1 周简历项目打磨 + JVM 专题 2 周），从本周（2026年08月第2周）进入 **并发编程专题**。

JVM 专题讲完"内存模型与对象生命周期 / GC / 类加载 / JIT / 调优实战 / ZGC"后，自然的下一个问题是：**多个线程同时操作 JVM 堆里的对象时，到底会发生什么？** 这就是 JMM（Java Memory Model）要解答的问题。JMM 是并发编程的"地基"--synchronized / volatile / final / AQS / 线程池都建立在 JMM 之上。

架构师面试官最爱问的不是"volatile 是什么"，而是：

> "你简历里写 IM 网关用了双重检查锁单例，为什么 volatile 修饰的引用还要再判空？不加 volatile 会怎样？"
> "happens-before 8 大规则你能脱口而出吗？它们在工程上有什么用？"
> "long 型变量在 32 位 JVM 上为什么不是原子操作？JMM 怎么解决？"

这些问题答不出来，synchronized 锁升级、AQS、线程池等后续专题都是"沙上城堡"。本周 Day01 把 JMM 一次性梳理清楚，Day02 进入 synchronized 锁升级，Day03 进 AQS，Day04 并发容器，Day05 线程池，Day06 串联整合，Day07 深挖 AQS 源码与生产事故反推。

**Day01 为什么是"JMM 内存模型"而不是"synchronized 锁升级"**：

1. **JMM 是并发编程的"语法"**：synchronized / volatile / final 都是 JMM 的语法糖，不理解 JMM 直接学锁升级就是"背八股"
2. **JMM 是最常被追问的底层**：面试官问"volatile 可见性原理"，答"内存屏障"差一个段位，答"JMM 的 happens-before 规则 + LoadLoad/StoreStore 屏障"才是架构师水平
3. **JMM 与硬件强绑定**：CPU 高速缓存（L1/L2/L3）、MESI 协议、乱序执行、Store Buffer、Invalidate Queue，是 JMM 设计的硬件背景
4. **JMM 与 JVM 专题衔接**：JMM 的主内存 vs 工作内存，对应 JVM 的堆 vs 线程栈；JMM 的 happens-before，对应 JIT 的指令重排序

**与往周专题的衔接点**：

- **JVM 内存模型（第1周 Day01）** vs **JMM**：JVM 内存模型讲"堆 / 栈 / 方法区 / 程序计数器"的物理布局，JMM 讲"主内存 vs 工作内存 + 同步规则"的抽象模型--两者名相似但完全不同
- **JIT 退优化（JVM 第2周 Day04）** vs **JMM 有序性**：JIT 的"指令重排序"是 JMM"有序性"的根源，happens-before 是程序员对抗 JIT 重排序的工具
- **Safepoint（JVM 第2周 Day04）** vs **JMM 可见性**：Safepoint 是 JVM 全局安全点，JMM 可见性是"线程本地缓存何时刷新到主内存"的规则，两者协同决定"线程间状态一致性"
- **DirectByteBuffer（JVM 第2周 Day05）** vs **JMM final 域**：DirectByteBuffer 用构造函数确保"对象发布即就绪"，依赖 JMM final 域语义（final 域写禁止重排序到构造函数外）

**与简历项目的衔接点**：

在线问诊系统的 JMM 三大重灾区：

1. **IM 网关 SessionManager 双重检查锁单例**：10w+ 长连接的 SessionManager 必须单例，DCL 不加 volatile 在高并发下会"半构造对象被读"（部分线程看到 null，部分看到已构造，部分看到半构造）
2. **视频问诊 RTP 包统计的 long 计数器**：单机 10w+ QPS 的 RTP 包计数器是 long 型，多线程 ++ 不是原子操作，需要 AtomicLong 或 LongAdder（高并发下 LongAdder 性能高 5-10 倍）
3. **问诊订单状态机的 volatile 状态字段**：订单状态用 volatile 修饰保证可见性，但 volatile 不保证 ++ 原子性，需要 AtomicReference + CAS

本周 Day05 线程池日会产出"在线问诊系统并发编程实战"，今日先把 JMM 基础打好。

---

## 题目一（JMM 全解题）：JMM 内存模型全解

请详细回答以下问题：

1. **三大特性全解**：JMM 的可见性、原子性、有序性分别是什么？各自对应的经典反例（可见性反例：while 循环不退出；原子性反例：long ++；有序性反例：指令重排序）？为什么 32 位 JVM 上 long/double 的读写不是原子操作？JMM 如何允许虚拟机把 64 位读写拆成两个 32 位？为什么实践中很少遇到这个问题？
2. **主内存与工作内存的交互**：JMM 抽象的主内存 vs 工作内存对应 JVM 的什么物理结构？8 大原子操作（lock / unlock / read / load / use / assign / store / write）的职责与顺序约束？为什么 read-load、use-assign、store-write 必须成对出现？8 大操作有哪些规则约束（不允许 read-load 单独出现、不允许线程丢弃最近的 assign、不允许线程把数据从工作内存同步回主内存而无 assign 等）？
3. **volatile 全解**：volatile 的三大语义（可见性 / 有序性 / 不保证原子性）？volatile 写读建立的 happens-before 关系？volatile 的内存屏障（StoreStore + StoreLoad / LoadLoad + LoadStore）？volatile 写为什么比读贵（StoreLoad 屏障开销大）？volatile 不适合的场景（i++、复合操作）？volatile 与 synchronized 的边界？DCL 单例为什么必须 volatile？
4. **final 域的内存语义**：JMM 对 final 域的特殊重排序规则是什么？为什么 final 域写必须在构造函数返回前完成（写 final 域禁止重排序到构造函数外）？为什么读 final 域禁止重排序到初次读引用之后（保证"读引用 -> 读 final 域"的有序性）？为什么 final 字段能保证"对象发布即就绪"（safe publication）？为什么 String 是 final 的（不可变 + 安全发布）？
5. **happens-before 8 大规则**：程序顺序规则（同一线程内前操作 hb 后操作）、监视器锁规则（unlock hb 后续 lock）、volatile 规则（写 hb 后续读）、线程启动规则（start() hb 线程内任意操作）、线程终止规则（线程内任意操作 hb 其他线程检测到线程终止）、线程中断规则（interrupt() hb 被中断线程检测到中断）、对象终结规则（构造函数结束 hb finalize 开始）、传递性（A hb B 且 B hb C 则 A hb C）？happens-before 与 as-if-serial 的区别？为什么 happens-before 不是"时间先后"而是"可见性保证"？
6. **内存屏障与硬件协同**：JMM 的 4 类屏障（LoadLoad / StoreStore / LoadStore / StoreLoad）的硬件实现（x86 的 lfence / sfence / mfence）？为什么 StoreLoad 屏障开销最大（需要等 Store Buffer 排空 + 让其他 CPU 看到）？MESI 协议与 JMM 的对应（M 修改 / E 独占 / S 共享 / I 失效）？为什么 x86 是"强内存模型"而 ARM/POWER 是"弱内存模型"？JMM 如何在强 / 弱硬件上保持一致语义？

### 作答区

#### 1. 三大特性全解

**JMM 三大特性与经典反例**：

| 特性 | 含义 | 经典反例 | 解决方案 |
|------|------|---------|---------|
| 可见性 | 一个线程修改了共享变量，其他线程能立即看到 | while(flag) 循环不退出 | volatile / synchronized / Lock |
| 原子性 | 一个或多个操作要么全做要么全不做，中间不可分 | long ++（读-改-写 3 步） | synchronized / Lock / Atomic* |
| 有序性 | 程序执行顺序与代码顺序一致（编译器 / JIT / CPU 都可能重排序） | DCL 单例返回半构造对象 | volatile / synchronized / final |

**可见性反例（IM 网关心跳检测）**：

```java
public class HeartbeatMonitor {
    private boolean running = true;  // 不加 volatile

    public void stop() {
        running = false;  // 主线程修改
    }

    public void monitor() {
        while (running) {  // 监控线程可能永远看不到 running=false
            // ... 心跳检测逻辑
        }
    }
}
```

**为什么看不到**：JIT 编译器发现 `running` 在循环内没被修改，把 `while(running)` 优化成 `while(true)`，监控线程永远不退出。这是真实生产事故--IM 网关优雅停机失败，老进程不退出，新进程起不来。

**原子性反例（视频问诊 RTP 包计数）**：

```java
public class RtpCounter {
    private long count = 0;  // long ++ 不是原子操作

    public void increment() {
        count++;  // 读 count -> +1 -> 写 count（3 步）
    }
}
```

**为什么 long ++ 不原子**：`count++` 字节码层是 3 条指令（getfield / iadd / putfield），多线程并发执行会丢失更新。10w QPS 下每秒可能丢失几百次计数。

**有序性反例（DCL 单例）**：

```java
public class SessionManager {
    private static SessionManager instance;  // 不加 volatile

    public static SessionManager getInstance() {
        if (instance == null) {                  // 1. 第一次检查
            synchronized (SessionManager.class) {
                if (instance == null) {           // 2. 第二次检查
                    instance = new SessionManager();  // 3. 构造对象
                }
            }
        }
        return instance;
    }
}
```

**问题**：步骤 3 `instance = new SessionManager()` 在字节码层是 3 步：
1. 分配对象内存
2. 调用构造方法初始化对象
3. 把 instance 引用指向内存地址

JIT 可能把 2 和 3 重排序（先 3 后 2），其他线程在步骤 3 之后、步骤 2 之前读到 instance != null，但对象还没初始化，使用时 NPE。

**修复**：`private static volatile SessionManager instance;`--volatile 通过 StoreStore 屏障禁止步骤 2 重排序到步骤 3 之后。

**为什么 32 位 JVM 上 long/double 读写不是原子操作**：

JMM 允许虚拟机把 64 位 long/double 的读写拆成两个 32 位操作：

```
long x = 0xFFFFFFFF00000000L;
线程 A 写高 32 位: 0xFFFFFFFF
线程 A 写低 32 位: 0x00000000

线程 B 读 x:
  - 读高 32 位: 0xFFFFFFFF（A 已写）
  - 读低 32 位: 0xFFFFFFFF（A 未写，旧值）
  - 拼成: 0xFFFFFFFFFFFFFFFF  <- 完全错误的值
```

**为什么实践中很少遇到**：

1. 64 位 JVM 几乎是标配，64 位 JVM 上的 long 读写是原子的
2. JLS 规定"鼓励"虚拟机实现 64 位原子读写，HotSpot 在 32 位 JVM 上也实现了原子读写（但不是规范保证）
3. 商业 JVM（HotSpot / OpenJ9 / GraalVM）都实现了 64 位原子读写

**架构师经验**：32 位 JVM 已基本不用，但面试官会问"为什么 long 不是原子操作"--答"JMM 允许 64 位读写拆成两个 32 位"才是架构师水平。

#### 2. 主内存与工作内存的交互

**JMM 抽象与 JVM 物理结构的对应**：

| JMM 抽象 | JVM 物理结构 | 硬件对应 |
|---------|------------|---------|
| 主内存 | 堆 / 方法区 / 元空间 | 物理内存（DRAM） |
| 工作内存 | 线程栈（局部变量 / 操作数栈） | CPU 寄存器 / L1/L2/L3 Cache |

**关键认知**：JMM 是抽象模型，与硬件不是 1:1 对应--工作内存可能是 CPU Cache，也可能是寄存器，JMM 不区分。

**8 大原子操作**：

| 操作 | 作用于 | 职责 |
|------|-------|------|
| lock | 主内存 | 把变量标识为线程独占 |
| unlock | 主内存 | 解除独占，其他线程可 lock |
| read | 主内存 | 把变量值从主内存传输到工作内存 |
| load | 工作内存 | 把 read 读到的值放入工作内存变量副本 |
| use | 工作内存 | 把变量值传给执行引擎 |
| assign | 工作内存 | 把执行引擎返回的值赋给变量副本 |
| store | 工作内存 | 把变量值从工作内存传输到主内存 |
| write | 主内存 | 把 store 传来的值写入主内存变量 |

**8 大操作的成对约束**：

```
read ─── load    （主内存 -> 工作内存）
use ─── assign   （工作内存 <-> 执行引擎）
store ── write   （工作内存 -> 主内存）

不允许 read 单独出现（必须紧跟 load）
不允许 store 单独出现（必须紧跟 write）
```

**8 大操作的规则约束**：

1. 不允许 read / load / store / write 单独出现
2. 不允许线程丢弃最近的 assign（变量改了必须同步回主内存）
3. 不允许线程把数据从工作内存同步回主内存而无 assign（没改就别写）
4. 一个变量只能在主内存诞生（不允许工作内存 use 一个未初始化的变量）
5. 一个变量同一时刻只允许一个线程 lock（但 lock 可重入）
6. lock 操作会清空工作内存该变量的值，使用前需重新 load / assign
7. 不允许 unlock 没被 lock 的变量
8. unlock 前必须把变量同步回主内存（store + write）

**关键认知**：8 大操作是 JMM 的"汇编层规范"，程序员不直接接触，但面试官会问"volatile 的可见性是怎么实现的"--答"volatile 写触发 store + write，volatile 读触发 read + load + use，且不允许 read-load 之间插入其他操作"是架构师水平。

#### 3. volatile 全解

**volatile 的三大语义**：

| 语义 | 实现机制 | 工程意义 |
|------|---------|---------|
| 可见性 | 写后刷主内存 + 读前从主内存取 | 状态标志位（running / stopped） |
| 有序性 | 内存屏障禁止重排序 | DCL 单例、状态机 |
| 不保证原子性 | 读 / 写各自原子，但读-改-写不原子 | i++ 不能用 volatile |

**volatile 写读建立的 happens-before**：

```
线程 A：
  x = 1;           // 普通写
  v = true;        // volatile 写（StoreStore + StoreLoad）

线程 B：
  if (v) {         // volatile 读（LoadLoad + LoadStore）
      int y = x;   // 普通读，y 一定 = 1
  }
```

**happens-before 链**：A 的 `x=1` hb A 的 `v=true`（程序顺序规则），A 的 `v=true` hb B 的 `if(v)`（volatile 规则），B 的 `if(v)` hb B 的 `y=x`（程序顺序规则），传递性得 A 的 `x=1` hb B 的 `y=x`，所以 y 一定 = 1。

**volatile 的内存屏障**：

| 操作 | 屏障 | 作用 |
|------|------|------|
| volatile 写前 | StoreStore | 禁止前面普通写与 volatile 写重排序 |
| volatile 写后 | StoreLoad | 禁止 volatile 写与后面 volatile 读 / 写重排序（最贵） |
| volatile 读前 | LoadLoad | 禁止后面普通读与 volatile 读重排序 |
| volatile 读后 | LoadStore | 禁止后面普通写与 volatile 读重排序 |

**为什么 volatile 写比读贵**：

- volatile 写需要 StoreLoad 屏障，等待 Store Buffer 排空，让所有 CPU 看到这次写
- StoreLoad 屏障开销 ≈ 100-300 个时钟周期（x86 上是 mfence 或 lock 前缀指令）
- volatile 读只需 LoadLoad + LoadStore，开销小（x86 上直接读，因为 x86 是强内存模型）

**volatile 不适合的场景**：

```java
// 反例：i++ 用 volatile 不行
private volatile int count = 0;
public void increment() {
    count++;  // 仍是读-改-写 3 步，多线程下丢失更新
}

// 正确方案 1：AtomicInteger
private final AtomicInteger count = new AtomicInteger();
public void increment() {
    count.incrementAndGet();  // CAS 原子操作
}

// 正确方案 2：synchronized
private int count = 0;
public synchronized void increment() {
    count++;
}

// 正确方案 3（高并发）：LongAdder
private final LongAdder count = new LongAdder();
public void increment() {
    count.increment();  // Cell 分散，比 AtomicLong 高 5-10 倍
}
```

**volatile 与 synchronized 的边界**：

| 维度 | volatile | synchronized |
|------|---------|--------------|
| 原子性 | 单次读 / 写原子，读-改-写不原子 | 完整原子 |
| 可见性 | 是 | 是 |
| 有序性 | 是 | 是 |
| 阻塞 | 否 | 是 |
| 性能 | 高（读几乎免费，写 100-300 周期） | 低（加锁 + 上下文切换） |
| 适用场景 | 状态标志位 / DCL 单例 | 复合操作 / 临界区 |

**DCL 单例为什么必须 volatile**：

```java
public class SessionManager {
    private static volatile SessionManager instance;  // 必须 volatile

    public static SessionManager getInstance() {
        if (instance == null) {
            synchronized (SessionManager.class) {
                if (instance == null) {
                    instance = new SessionManager();
                }
            }
        }
        return instance;
    }
}
```

**原因**：`instance = new SessionManager()` 字节码 3 步（分配内存 / 初始化 / 赋值），JIT 可能把"初始化"和"赋值"重排序，导致其他线程看到 instance != null 但对象未初始化。volatile 的 StoreStore 屏障禁止"初始化"重排序到"赋值"之后，确保"读到的对象一定已初始化"。

**架构师经验**：DCL 是经典面试题，但生产中推荐用"静态内部类"或"枚举"实现单例，避免 DCL 的复杂心智：

```java
// 推荐 1：静态内部类（JVM 类加载保证线程安全 + 懒加载）
public class SessionManager {
    private static class Holder {
        private static final SessionManager INSTANCE = new SessionManager();
    }
    public static SessionManager getInstance() {
        return Holder.INSTANCE;
    }
}

// 推荐 2：枚举（《Effective Java》推荐，防反射攻击）
public enum SessionManager {
    INSTANCE;
}
```

#### 4. final 域的内存语义

**JMM 对 final 域的特殊重排序规则**：

| 规则 | 含义 | 目的 |
|------|------|------|
| 写 final 域禁止重排序到构造函数外 | final 域的写必须在构造函数返回前完成 | 保证对象构造完成时 final 域已就绪 |
| 读 final 域禁止重排序到初次读引用之后 | 先读引用，再读 final 域 | 保证读到引用时 final 域已就绪 |

**为什么 final 域写必须在构造函数返回前完成**：

```java
public class AppConfig {
    private final int timeout;  // final

    public AppConfig() {
        timeout = 5000;  // 写 final
    }
}

// JMM 保证：其他线程读到 AppConfig 引用时，timeout 一定是 5000
```

**原理**：在构造函数返回前，编译器插入 StoreStore 屏障，禁止 `timeout = 5000` 重排序到构造函数外。如果允许重排序，其他线程可能读到未初始化的 timeout（默认值 0）。

**为什么读 final 域禁止重排序到初次读引用之后**：

```java
AppConfig config = new AppConfig();  // 读引用
int t = config.timeout;              // 读 final 域
```

**原理**：JMM 禁止"读 final 域"重排序到"初次读引用"之前，保证先读到引用，再读 final 域。如果不禁止，可能读到"半构造"对象的 final 域。

**为什么 final 能保证"安全发布"**：

```java
// 不安全发布：对象未完全构造就被其他线程读
public class UnsafePublication {
    private AppConfig config;

    public void init() {
        config = new AppConfig();  // 普通字段，可能"半构造"被读
    }

    public AppConfig getConfig() {
        return config;  // 其他线程可能读到半构造对象
    }
}

// 安全发布：用 final 保证就绪
public class SafePublication {
    private final AppConfig config;  // final

    public SafePublication() {
        config = new AppConfig();  // 构造函数完成 = config 就绪
    }

    public AppConfig getConfig() {
        return config;  // 其他线程读到的一定是完整对象
    }
}
```

**为什么 String 是 final 的**：

1. **不可变**：String 内部 `final char[] value`，不可修改
2. **安全发布**：String 在多线程间共享不需要同步
3. **hashCode 缓存**：String 的 hashCode 计算一次后缓存，不可变保证缓存有效
4. **字符串常量池**：String 池依赖不可变性，相同字面量指向同一对象
5. **安全性**：String 用作类加载器、网络连接参数，不可变防止被篡改

**关键认知**：final 不是"语法糖"，是 JMM 提供的"安全发布"机制。架构师设计不可变类（如配置类 / DTO）时，应该把所有字段设为 final，享受 JMM 的安全发布保证。

#### 5. happens-before 8 大规则

**happens-before 8 大规则全解**：

| 规则 | 含义 | 工程示例 |
|------|------|---------|
| 程序顺序规则 | 同一线程内，前操作 hb 后操作 | `a=1; b=2;` -> a=1 hb b=2 |
| 监视器锁规则 | unlock hb 后续 lock | 线程 A unlock 后，线程 B lock 能看到 A 的修改 |
| volatile 规则 | volatile 写 hb 后续 volatile 读 | A 写 volatile 后，B 读 volatile 能看到 |
| 线程启动规则 | start() hb 线程内任意操作 | 主线程 start() 前的修改，子线程能看到 |
| 线程终止规则 | 线程内操作 hb 其他线程检测到终止 | 子线程的修改，主线程 join() 后能看到 |
| 线程中断规则 | interrupt() hb 被中断线程检测到中断 | interrupt() 之前的修改，被中断线程能看到 |
| 对象终结规则 | 构造函数结束 hb finalize 开始 | finalize 能看到构造函数的修改 |
| 传递性 | A hb B 且 B hb C 则 A hb C | 链式推导可见性 |

**happens-before 与 as-if-serial 的区别**：

| 概念 | 含义 | 范围 |
|------|------|------|
| as-if-serial | 单线程内指令重排序不能改变程序语义 | 单线程 |
| happens-before | 跨线程的可见性保证 | 多线程 |

**关键认知**：as-if-serial 是"单线程语义保证"，happens-before 是"多线程可见性保证"。JIT 重排序只要不违反 as-if-serial 就可以，但跨线程的可见性必须由程序员通过 volatile / synchronized / Lock 显式建立 happens-before 关系。

**为什么 happens-before 不是"时间先后"而是"可见性保证"**：

```java
// 线程 A
int x = 1;     // A1
int y = 2;     // A2

// 线程 B
int b = y;     // B1，可能读到 0 或 2
int a = x;     // B2，可能读到 0 或 1
```

**反直觉**：即使 A1 在时间上先于 B2，B2 仍可能读到 x=0。因为 A1 和 B2 之间没有 happens-before 关系，JMM 不保证可见性。

**建立 happens-before 的方法**：

1. 用 volatile 修饰 y：A2 hb B1，再由传递性，A1 hb B2，B2 一定能读到 x=1
2. 用 synchronized 包裹：A1 / A2 在 A.unlock 前，B1 / B2 在 B.lock 后，由监视器锁规则建立 hb

**架构师经验**：happens-before 是"程序员与 JMM 的契约"--程序员写 volatile / synchronized，JMM 保证可见性；程序员不写，JMM 不保证。架构师 Code Review 时要识别"跨线程共享但无 happens-before 关系"的反模式。

#### 6. 内存屏障与硬件协同

**JMM 的 4 类屏障**：

| 屏障 | 含义 | x86 指令 | 开销 |
|------|------|---------|------|
| LoadLoad | Load1; LoadLoad; Load2 - Load2 必须等 Load1 完成 | lfence（x86 强模型常省略） | 低 |
| StoreStore | Store1; StoreStore; Store2 - Store2 必须等 Store1 完成 | sfence（x86 强模型常省略） | 低 |
| LoadStore | Load1; LoadStore; Store2 - Store2 必须等 Load1 完成 | 无（x86 自动保证） | 低 |
| StoreLoad | Store1; StoreLoad; Load2 - Load2 必须等 Store1 全局可见 | mfence 或 lock 前缀 | 高（100-300 周期） |

**为什么 StoreLoad 屏障开销最大**：

```
1. 等 Store Buffer 排空（让 Store 真正写入 Cache）
2. 等 Invalidate Queue 处理完毕（让其他 CPU 失效缓存）
3. 等 MESI 协议完成缓存同步
4. 然后才能执行后续 Load
```

x86 上 StoreLoad 通常用 `lock addl $0, 0(%rsp)`（lock 前缀 + 空操作）实现，比 mfence 性能更好（兼容性强 + CPU 优化好）。

**MESI 协议与 JMM 的对应**：

| MESI 状态 | 含义 | JMM 对应 |
|----------|------|---------|
| M (Modified) | 缓存行被修改，与主内存不一致 | 工作内存的 assign 后未 store-write |
| E (Exclusive) | 缓存行独占，与主内存一致 | 工作内存的 load 后未修改 |
| S (Shared) | 缓存行共享，多个 CPU 有副本，与主内存一致 | 多个工作内存的 load 后未修改 |
| I (Invalid) | 缓存行失效 | 工作内存的变量被 lock 后清空 |

**MESI 协议的核心机制**：

1. CPU 写缓存行：先发 Invalidate 消息给其他 CPU，等其他 CPU 回复 Acknowledge
2. 其他 CPU 把缓存行标记为 I，回复 Ack
3. 发起 CPU 收到所有 Ack 后，把缓存行改为 M，写入新值
4. CPU 读缓存行：如果状态是 I，从主内存或其它 CPU 的 Cache 取（Cache-to-Cache Transfer）

**Store Buffer 与 Invalidate Queue**：

为了不阻塞 CPU 等 MESI 消息，硬件引入两个缓冲区：

- **Store Buffer**：CPU 写时先写 Store Buffer，继续执行，异步等 Invalidate Ack
- **Invalidate Queue**：CPU 收到 Invalidate 消息时，先入队列，立即回复 Ack，异步处理

**副作用**：Store Buffer + Invalidate Queue 引入了"重排序"（CPU 看到的写顺序与实际主内存顺序不一致），这就是 JMM"有序性"问题的硬件根源。

**为什么 x86 是"强内存模型"而 ARM/POWER 是"弱内存模型"**：

| 维度 | x86（强） | ARM/POWER（弱） |
|------|---------|----------------|
| Store-Load 重排序 | 不允许（StoreLoad 屏障自动插入） | 允许 |
| Load-Load 重排序 | 不允许 | 允许 |
| Store-Store 重排序 | 不允许 | 允许 |
| Load-Store 重排序 | 不允许 | 允许 |
| 程序员心智 | 简单（少写屏障） | 复杂（多写屏障） |
| 性能 | 略低（屏障开销） | 高（异步优化） |

**JMM 如何在强 / 弱硬件上保持一致语义**：

- x86 上：JMM 的 LoadLoad / StoreStore / LoadStore 屏障多数被 JIT 优化掉（x86 自动保证）
- ARM 上：JMM 的所有屏障都要显式插入（dmb / dsb / isb 指令）
- 程序员写一份 Java 代码，JIT 根据目标 CPU 自动调整屏障插入策略

**架构师经验**：开发 Android（ARM）服务时，JMM 的有序性问题更敏感；开发 x86 服务端时，多数有序性问题被硬件屏蔽。但生产事故仍可能发生--JIT 重排序 + CPU 重排序叠加后，x86 也会出现"可见性问题"。

---

## 本日能力差距与补足方向

### 差距 1：JMM 三大特性的工程反例识别能力不足
> Day1发现，延续 JVM 第2周 Day04 差距4.4（JIT 退优化）

- **现状**：知道可见性 / 原子性 / 有序性的概念，但生产中"while 循环不退出"、"long ++ 丢失更新"、"DCL 返回半构造对象"等反例的识别能力不足；JIT 优化导致的可见性问题在测试环境难以复现（测试环境 JIT 不激进优化），生产环境偶发难定位
- **架构师水平**：能从 Code Review 中识别 5 类 JMM 反模式（共享状态无 volatile / DCL 不加 volatile / long ++ / 复合操作用 volatile / 不安全发布）；能在 30 分钟内复现 DCL 半构造问题（用 JCStress 压测）；能在生产事故中识别"JIT 优化导致可见性丢失"
- **补足方向**：用 JCStress 实测 5 个 JMM 反例；阅读《Java Concurrency in Practice》第 3 章；调研 OpenJ9 / GraalVM 的 JIT 优化差异

### 差距 2：8 大原子操作的工程价值认知不足
> Day1发现，延续 JVM 第1周 Day01 差距（JVM 内存模型）

- **现状**：知道主内存 vs 工作内存的概念，但 8 大原子操作（lock / unlock / read / load / use / assign / store / write）的成对约束、规则约束不熟；面试官追问"volatile 写触发哪些操作"答不上来
- **架构师水平**：能脱口而出 volatile 写触发 assign + store + write，volatile 读触发 read + load + use；能讲清 lock-unlock 与 read-load / store-write 的关系；能从 8 大操作反推 synchronized 的实现
- **补足方向**：精读《Java Language Specification》第 17 章（JMM）；阅读 OpenJDK `orderAccess.cpp` 源码；用 `-XX:+PrintAssembly` 看 volatile 的汇编层屏障

### 差距 3：volatile 内存屏障的硬件实现不深
> Day1发现，延续 JVM 第2周 Day04 差距4.5（Safepoint）

- **现状**：知道 volatile 有 StoreStore / StoreLoad / LoadLoad / LoadStore 4 类屏障，但 x86 上具体用什么指令（lfence / sfence / mfence / lock 前缀）、为什么 StoreLoad 最贵、ARM 与 x86 的屏障差异不深
- **架构师水平**：能讲清 StoreLoad 屏障的硬件开销（等 Store Buffer 排空 + Invalidate Queue 处理）；能用 `-XX:+PrintAssembly -XX:+UnlockDiagnosticVMOptions` 看 volatile 写的 lock 指令；能讲清 ARM 上 JMM 屏障如何影响 Android 服务性能
- **补足方向**：阅读《Java Concurrency in Practice》第 16 章（JMM 内幕）；调研 Intel SDM Vol 3 第 8 章（内存排序）；用 JCStress 在 x86 vs ARM 上对比 volatile 性能

### 差距 4：final 域安全发布的工程实践不足
> Day1发现，延续 JVM 第1周 Day04 差距（类加载与对象生命周期）

- **现状**：知道 final 不可变，但 final 域的 JMM 重排序规则（写禁止重排序到构造函数外、读禁止重排序到初次读引用之后）、final 域在"安全发布"中的作用、为什么 String 是 final 的等深度理解不足
- **架构师水平**：能从 Code Review 中识别"不安全发布"反模式（构造函数内启动新线程 / this 引用泄漏 / 双重检查锁不加 volatile）；能用 final 替代 volatile 设计不可变类（如配置类、DTO）；能讲清 final 域与 AQS 队列节点（Node）的安全发布关系
- **补足方向**：精读《Java Concurrency in Practice》第 3.5 节（安全发布）；调研 JDK 17 的 record 类（深度不可变）；在 IM 网关的 SessionManager 重构中应用 final 域安全发布

### 差距 5：happens-before 8 大规则的实战应用不足
> Day1发现

- **现状**：能背 8 大规则，但生产中"建立 happens-before 关系"的工程能力不足；面试官追问"start() 之前的修改，子线程能看到吗"需要思考；传递性推导 3 层以上的可见性链容易出错
- **架构师水平**：能在 Code Review 中快速判断"两个操作是否有 happens-before 关系"；能用 8 大规则推导"线程 A 的修改通过 volatile 中转给线程 B"的完整链路；能识别"看似有 happens-before 实际没有"的反模式（如 Thread.start 之前不在主线程做的修改）
- **补足方向**：用 JCStress 实测 happens-before 8 大规则；整理团队"并发可见性 Checklist"（10 条规则）；阅读《Java Concurrency in Practice》第 16 章

### 差距 6：MESI 协议与 JMM 协同的硬件认知不足
> Day1发现，延续 JVM 第1周 Day01 差距

- **现状**：知道 MESI 协议的 4 个状态，但 Store Buffer / Invalidate Queue 如何引入重排序、x86 vs ARM 的强弱内存模型差异、JMM 屏障在不同硬件上的实现策略不深
- **架构师水平**：能讲清 MESI 协议的"无效化消息往返"开销与 Store Buffer / Invalidate Queue 的优化；能讲清 x86 强内存模型为什么仍有 StoreLoad 重排序；能为 Android（ARM）服务设计更保守的 JMM 策略
- **补足方向**：阅读 Intel SDM Vol 3 第 8 章（内存排序）；调研 ARM 内存模型（ARMv8）；阅读《A Primer on Memory Consistency and Cache Coherence》

### 差距 7：与简历项目 JMM 实战结合的深度不足
> Day1发现，延续第4周简历项目差距

- **现状**：能讲 JMM 概念，但与简历项目（在线问诊系统）3 个 JMM 场景（IM 网关 DCL 单例 / 视频 RTP 包 long 计数器 / 问诊订单状态机 volatile）的完整 STAR 故事不熟；IM 网关 10w 长连接的 SessionManager DCL 不加 volatile 在生产偶发 NPE 的事故故事讲不生动
- **架构师水平**：能用 STAR 法则结构化讲述 3 个 JMM 案例；能从案例反推架构改进点（如用静态内部类替代 DCL / 用 LongAdder 替代 AtomicLong）；能在面试中 10 分钟讲清 2 个案例
- **补足方向**：本周 Day05 实战日产出 3 个完整 JMM 案例文档；用 JCStress 复现 IM 网关 DCL 半构造问题；用 STAR 法则演练 5 次面试讲述

---

## 附录：本日关键认知速查

```text
JMM 三大特性：
  - 可见性：volatile / synchronized / Lock
  - 原子性：synchronized / Lock / Atomic*
  - 有序性：volatile / synchronized / final

volatile 三大语义：
  - 可见性（写刷主内存，读从主内存取）
  - 有序性（4 类屏障）
  - 不保证原子性（i++ 仍需 AtomicLong）

volatile 屏障：
  - 写前 StoreStore（禁止前面普通写与 volatile 写重排序）
  - 写后 StoreLoad（最贵，等 Store Buffer 排空）
  - 读前 LoadLoad（禁止后面普通读与 volatile 读重排序）
  - 读后 LoadStore（禁止后面普通写与 volatile 读重排序）

final 域：
  - 写禁止重排序到构造函数外（保证对象构造完成时 final 已就绪）
  - 读禁止重排序到初次读引用之后（保证读到引用时 final 已就绪）
  - 实现"安全发布"机制

happens-before 8 大规则：
  - 程序顺序 / 监视器锁 / volatile / 线程启动 / 线程终止 / 线程中断 / 对象终结 / 传递性

内存屏障 4 类：
  - LoadLoad / StoreStore / LoadStore / StoreLoad（最贵）

x86 强内存模型：
  - 仅禁止 StoreLoad 重排序（其他自动保证）
  - StoreLoad 用 lock 前缀或 mfence 实现

ARM 弱内存模型：
  - 4 类重排序都允许
  - 用 dmb / dsb / isb 屏障
```
