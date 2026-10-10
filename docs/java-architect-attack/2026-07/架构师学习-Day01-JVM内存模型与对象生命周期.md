# 架构师学习-Day01-JVM 内存模型与对象生命周期

> 日期：2026年07月27日（周一）
> 周主题：JVM 专题第 1 周 - JVM 基础与核心
> 出题日：Day01 - JVM 内存模型与对象生命周期

---

## 背景

经过 11 周专题训练（CAP/MQ/微服务/MySQL/Redis/ES/限流降级/支付/医疗×2/K8s）+ 1 周简历项目打磨，本周（2026年07月第5周）启动 **JVM 专题 2 周计划**。JVM 是高级 Java / 架构师面试超高频必考，且是用户能力地图上的底层短板。

JVM 专题之所以"必考"，原因有三：

1. **架构师必备底层能力**：架构师做技术选型（如缓存中间件、消息中间件、数据库连接池）必须理解 JVM 内存模型与 GC 行为对吞吐与延迟的影响
2. **线上故障根因 80% 在 JVM**：OOM、CPU 飙高、Full GC 频繁、类加载冲突、线程死锁--这些是 Java 服务最常见的生产事故
3. **面试深挖天花板**：JVM 是面试官最爱深挖的领域之一，从"内存模型"一直可以追问到"G1 SATB 算法"、"ZGC 染色指针"、"JIT 逃逸分析"--深度无止境

本周 Day01-Day05 覆盖 JVM 五大核心：内存模型与对象生命周期 / GC 算法与分代收集 / GC 收集器全谱系 / 类加载与字节码 / JIT 编译优化。Day06 串联、Day07 深挖 G1 底层。第 2 周（8月第1周）进入调优实战与生产排查。

**与往周专题的衔接点**：

- **MySQL InnoDB 缓冲池** vs **JVM 堆**：缓冲池在 OS 层，JVM 堆在用户态，两者协同（6月第1周）
- **Redis 单线程模型** vs **JVM GC STW**：Redis 单线程避免锁竞争，JVM GC STW 是吞吐杀手（6月第2周）
- **ES Lucene MMAP** vs **JVM 直接内存**：ES 用 mmap 把索引映射到用户态，JVM 直接内存走类似思路（6月第3周）
- **Sentinel 限流** vs **JVM GC 停顿**：GC STW 会引发请求堆积，触发 Sentinel 限流误判（6月第4周）
- **K8s cgroup 资源限制** vs **JVM 容器化**：JVM 在容器中如何感知 cgroup 限制（7月第3周 Day05）

**与简历项目的衔接点**：

在线问诊系统的 JVM 重灾区有三个：

1. **IM 长连接网关**：10w+ 长连接，每条连接占用的直接内存（Netty ByteBuf）需要精确估算
2. **视频问诊 SFU**：每路视频通话的对象创建速率（RTP 包解析、SRTP 解密、SFU 转发对象）很高，Eden 区压力极大
3. **MongoDB 大文档存档**：问诊诊疗事件 JSON 文档可能几 MB，读取时容易触发 OOM

本周 Day01 聚焦 **JVM 内存模型与对象生命周期**，从"内存区域划分"到"对象创建"再到"对象回收"，建立完整的 JVM 内存视图。Day02 进入 GC 算法与分代收集理论，Day03 讲 GC 收集器全谱系，Day04 类加载与字节码，Day05 JIT 编译优化。

---

## 题目一（原理深挖题）：JVM 内存模型与对象生命周期

请详细回答以下问题：

1. **JVM 运行时数据区全谱系**：JVM 运行时数据区有哪些？哪些是线程私有，哪些是线程共享？堆/方法区/永久代/元空间的演进历史（JDK 7 -> 8 -> 9+）是怎样的？JDK 8 为什么用元空间替换永久代？元空间在物理上存在哪里？为什么元空间默认只设上限不设下限？
2. **对象创建的完整流程**：一个对象从 `new` 关键字到内存分配完成，需要哪些步骤？指针碰撞（Bump the Pointer）vs 空闲列表（Free List）两种内存分配方式有什么区别？为什么需要 TLAB（Thread Local Allocation Buffer）？TLAB 的 refill 与浪费比例如何控制？
3. **对象内存布局**：一个 Java 对象在内存中是怎样布局的？对象头（Mark Word + 类型指针 + 数组长度）各部分的作用？64 位 JVM 下对象头多大？指针压缩（-XX:+UseCompressedOops）是什么？为什么开启指针压缩后堆上限是 32GB？
4. **对象存活判定**：JVM 如何判断对象可以被回收？可达性分析算法的 GC Roots 有哪些？为什么不用引用计数法（循环引用问题）？三色标记算法是什么？SATB（Snapshot At The Beginning）与增量标记的区别？写屏障（Write Barrier）的作用？
5. **逃逸分析与优化**：逃逸分析是什么？方法逃逸 vs 线程逃逸的区别？栈上分配、标量替换、同步消除三种优化的原理？为什么 HotSpot JVM 默认开启逃逸分析但栈上分配实际很少触发？如何用 `-XX:+DoEscapeAnalysis -XX:+PrintEscapeAnalysis` 验证？

### 作答区

#### 1. JVM 运行时数据区全谱系

**JVM 运行时数据区**（JDK 8+）共 6 个区域：

| 区域 | 线程私有 | 物理位置 | 存储内容 | OOM 类型 |
|------|---------|---------|---------|---------|
| 程序计数器（PC Register） | ✅ | JVM 内部 | 当前线程执行的字节码行号 | 不会 OOM |
| 虚拟机栈（VM Stack） | ✅ | JVM 内部 | 栈帧（局部变量表、操作数栈、动态链接、返回地址） | StackOverflowError / OOM |
| 本地方法栈（Native Method Stack） | ✅ | JVM 内部 | Native 方法的栈帧 | StackOverflowError / OOM |
| 堆（Heap） | ❌ 共享 | JVM 内部 | 对象实例、数组 | java.lang.OutOfMemoryError: Java heap space |
| 方法区（Method Area） | ❌ 共享 | JDK 7 永久代 / JDK 8+ 元空间 | 类信息、常量池、静态变量、JIT 编译后的本地代码 | OOM: Metaspace |
| 直接内存（Direct Memory） | ❌ 共享 | OS 内存（不在 JVM 堆内） | NIO Buffer、Netty ByteBuf、JVM 内部 | OOM: Direct buffer memory |

**堆的内部结构**（JDK 8+ 默认 G1 收集器视角）：

```
┌─────────────────────────────────────────────────────────┐
│  堆（Heap）- 物理上不连续，逻辑上分代                    │
│                                                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │
│  │  Young 代   │  │  Old 代     │  │  大对象区   │     │
│  │  Eden + S0  │  │  长期存活   │  │  Humongous  │     │
│  │  + S1       │  │  对象       │  │  Region     │     │
│  └─────────────┘  └─────────────┘  └─────────────┘     │
└─────────────────────────────────────────────────────────┘
```

**G1 的 Region 模型**：堆被划分为 2048 个左右的 Region（每个 1-32MB），每个 Region 可以动态切换为 Eden / Survivor / Old / Humongous 角色。

**永久代 vs 元空间演进**：

| 版本 | 方法区实现 | 物理位置 | 默认大小 |
|------|-----------|---------|---------|
| JDK 6 及之前 | 永久代（PermGen） | JVM 堆的一部分 | -XX:PermSize=16M / -XX:MaxPermSize=64M |
| JDK 7 | 永久代（开始迁移） | 字符串常量池、静态变量迁移到堆 | 同上 |
| JDK 8 | 元空间（Metaspace） | 本地内存（Native Memory） | -XX:MetaspaceSize=12M / -XX:MaxMetaspaceSize=无上限 |
| JDK 9+ | 元空间（同 JDK 8） | 本地内存 | 同上 |

**JDK 8 为什么用元空间替换永久代**：

1. **永久代容易 OOM**：永久代大小固定，部署大量动态生成类的应用（如 Spring AOP、CGLIB、Groovy 脚本、JSP 重编译）容易 `java.lang.OutOfMemoryError: PermGen space`
2. **元空间用本地内存**：元空间不在 JVM 堆内，使用 OS 的本地内存，上限受物理内存限制，不容易 OOM
3. **方便 GC 优化**：永久代的 GC 与 Old 代绑定（Full GC 才清理永久代），元空间独立 GC（独立扫描类元数据）
4. **JRockit / J9 的方案融合**：JRockit 没有永久代，类元数据直接放本地内存。HotSpot 与 JRockit 融合后采用类似方案

**元空间在物理上存在哪里**：元空间使用 **C Heap**（C 语言 malloc 分配的本地内存），不在 JVM 堆内，也不在 JNI Critical 区域。可以通过 NMT（Native Memory Tracking）观察：

```bash
jcmd <pid> VM.native_memory summary
# 输出包含：
#  Class (reserved=1085603KB, committed=45163KB)
#                (classes #6543)
#                (  instance classes #6000, array classes #543)
```

**元空间默认只设上限不设下限的原因**：

- 元空间的大小取决于加载的类数量，难以预估
- 默认 `MaxMetaspaceSize` 无上限，使用到机器物理内存上限才会 OOM
- 但 `CompressedClassSpaceSize`（压缩类指针空间，默认 1GB）有上限
- 生产环境建议显式设置 `MaxMetaspaceSize`（如 256MB），防止类加载泄漏耗尽物理内存

#### 2. 对象创建的完整流程

**对象创建 5 步**（`new` 关键字触发的底层流程）：

```
new Foo()
   │
   ▼
1. 类加载检查
   │  - 检查 Foo 类是否已被加载、解析、初始化
   │  - 未加载则触发类加载（双亲委派）
   │
   ▼
2. 分配内存
   │  - 在堆中划分出对象大小的内存
   │  - 两种分配方式：指针碰撞 / 空闲列表
   │  - 线程安全：TLAB / CAS + 失败重试
   │
   ▼
3. 初始化零值
   │  - 内存分配后，将分配空间初始化为零值（不包括对象头）
   │  - 保证实例字段无需初始化即可使用（Java 默认值语义）
   │
   ▼
4. 设置对象头
   │  - 设置 Mark Word（哈希码、GC 分代年龄、锁状态）
   │  - 设置类型指针（指向 Foo.class 的元数据）
   │  - 如果是数组，还要设置数组长度
   │
   ▼
5. 执行 <init>
   │  - 执行构造函数（程序员写的初始化代码）
   │  - 此时对象才真正"可用"
```

**指针碰撞 vs 空闲列表**：

| 分配方式 | 适用场景 | 实现 | 优点 | 缺点 |
|---------|---------|------|------|------|
| 指针碰撞（Bump the Pointer） | 堆内存绝对规整（Serial / ParNew 等带压缩的收集器） | 维护一个指针，分配时把指针向空闲方向移动对象大小的距离 | 极快（O(1)） | 要求堆绝对规整，否则指针碰撞会覆盖已分配对象 |
| 空闲列表（Free List） | 堆内存不规整（CMS 等不带压缩的收集器） | 维护一个列表记录哪些内存块空闲，分配时找一块够大的，更新列表 | 适应不规整堆 | 慢（O(n) 查找）+ 容易产生碎片 |

**为什么需要 TLAB**：

堆是线程共享的，多线程同时分配对象时指针碰撞会有竞争。最朴素的解决方案是 CAS + 失败重试，但性能差。TLAB 的思路是**给每个线程预分配一块私有内存**，线程在 TLAB 内分配无需同步：

```
┌──────────────────────────────────────────────────────────────┐
│  Eden 区                                                     │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐         │
│  │ TLAB 1  │  │ TLAB 2  │  │ TLAB 3  │  │ 共享区  │         │
│  │ 线程 A  │  │ 线程 B  │  │ 线程 C  │  │ CAS 竞争│         │
│  └─────────┘  └─────────┘  └─────────┘  └─────────┘         │
└──────────────────────────────────────────────────────────────┘
```

- 线程 A 在 TLAB 1 内分配对象，无需同步
- TLAB 1 用完后，线程 A 申请新的 TLAB（CAS 申请一块新的 Eden 区）
- 共享区是 TLAB 用完后的兜底，CAS + 失败重试

**TLAB 的 refill 与浪费比例**：

- TLAB 大小由 JVM 动态调整（`-XX:+UseTLAB` 默认开启）
- 默认浪费比例 1%（`-XX:TLABWasteTargetPercent=1`）
- 当 TLAB 剩余空间不足以分配当前对象，且剩余空间 &lt; TLAB 大小 × 1% 时，申请新 TLAB；否则在共享区分配
- TLAB 大小动态调整公式：`TLAB_size = (Eden_free / threads) × 1%`，保证 Eden 用完前所有线程都能拿到 TLAB

#### 3. 对象内存布局

**Java 对象内存布局**（64 位 JVM）：

```
┌──────────────────────────────────────────────────────────┐
│  对象头（Object Header）                                 │
│  ┌──────────────────────────────────────────────────┐    │
│  │  Mark Word（8 字节，64 位 JVM）                  │    │
│  │  - 哈希码（25 位） + 年龄（4 位） + 偏向位（1）   │    │
│  │    + 锁标志位（2） + 分代年龄（4） ...           │    │
│  ├──────────────────────────────────────────────────┤    │
│  │  类型指针（Klass Pointer，4 字节 压缩 / 8 字节） │    │
│  │  - 指向 Class 元数据（方法区 / 元空间）          │    │
│  ├──────────────────────────────────────────────────┤    │
│  │  数组长度（4 字节，仅数组对象有）                │    │
│  └──────────────────────────────────────────────────┘    │
├──────────────────────────────────────────────────────────┤
│  实例数据（Instance Data）                               │
│  - 父类字段 + 子类字段（按类型宽度排列，long/double 在前）│
│  - 字段之间可能有对齐填充                                │
├──────────────────────────────────────────────────────────┤
│  对齐填充（Padding）                                     │
│  - 保证对象大小是 8 字节的整数倍                         │
└──────────────────────────────────────────────────────────┘
```

**Mark Word 在不同锁状态下的变化**（64 位 JVM）：

| 锁状态 | 25bit | 31bit | 1bit | 4bit | 1bit 偏向 | 2bit 锁标志 |
|--------|-------|-------|------|------|-----------|------------|
| 无锁 | unused | hashCode | unused | 分代年龄 | 0 | 01 |
| 偏向锁 | 线程ID（54bit） + Epoch（2bit） | - | - | 分代年龄 | 1 | 01 |
| 轻量级锁 | 指向栈中锁记录的指针（62bit） | - | - | - | - | 00 |
| 重量级锁 | 指向 Monitor 的指针（62bit） | - | - | - | - | 10 |
| GC 标记 | - | - | - | - | - | 11 |

**指针压缩（-XX:+UseCompressedOops）**：

- 64 位 JVM 默认指针 8 字节，对象头类型指针 8 字节
- 开启指针压缩后，指针用 32 位表示，但能寻址 32GB（因为对象 8 字节对齐，32 位指针 × 8 = 32GB 寻址空间）
- 节省内存：纯对象引用从 8 字节降到 4 字节
- **为什么堆上限是 32GB**：32 位指针最多寻址 4GB（2^32），但对象 8 字节对齐，所以可寻址 32GB（2^32 × 8）。超过 32GB 指针压缩自动失效

**对象头大小**（64 位 JVM，开启指针压缩）：
- 普通对象：Mark Word(8) + Klass Pointer(4) = 12 字节，对齐到 16 字节
- 数组对象：Mark Word(8) + Klass Pointer(4) + 数组长度(4) = 16 字节

#### 4. 对象存活判定

**可达性分析算法**（JVM 选用）：

从 GC Roots 出发，沿引用链向下搜索，搜索过的路径称为"存活"，不可达的对象即为"可回收"。

```
GC Roots
   │
   ├─ 虚拟机栈中的引用对象（方法局部变量、参数）
   ├─ 方法区中的类静态变量引用的对象
   ├─ 方法区中的常量引用的对象
   ├─ 本地方法栈中 JNI 引用的对象
   ├─ JVM 内部引用（如基本类型对应的 Class 对象、常驻的异常对象）
   ├─ 同步锁（synchronized 关键字）持有的对象
   └─ JMXBean、JVMTI 等 JVM 内部数据结构引用的对象
```

**为什么不用引用计数法**：

- 引用计数法（Reference Counting）：对象被引用时计数+1，引用失效时计数-1，计数为 0 即回收
- **致命缺陷**：循环引用（A 引用 B，B 引用 A）会导致两者计数永远不为 0，无法回收
- Python 用引用计数 + 后备标记-清除解决；JVM 直接放弃引用计数，用可达性分析

**引用的 4 种强度**：

| 类型 | 回收时机 | 应用场景 |
|------|---------|---------|
| 强引用（Strong） | 永不回收（除非主动置 null） | 普通变量赋值 `Object o = new Object()` |
| 软引用（Soft） | 内存不足时回收 | 内存敏感缓存 `SoftReference<Cache>` |
| 弱引用（Weak） | 下次 GC 必回收 | ThreadLocal 的 Entry key、`WeakHashMap` |
| 虚引用（Phantom） | 不影响对象生命周期，仅做回收通知 | 跟踪对象被 GC 的时机，配合 ReferenceQueue |

**三色标记算法**（现代并发收集器基础）：

- **白色**：尚未被标记（候选回收对象）
- **黑色**：已被标记，且所有引用都已扫描（确认存活）
- **灰色**：已被标记，但还有引用未扫描

**标记流程**：

```
初始：所有对象都是白色，GC Roots 是灰色
循环：从灰色集合取出一个对象，将其引用的白色对象标灰，自己标黑
结束：灰色集合为空，剩余白色对象即为可回收
```

**并发标记的"漏标"问题**：

并发标记期间，业务线程可能修改引用关系，导致"漏标"（原本存活的对象被误判为白色）：

```
业务线程: A.field = C;  // A 已是黑色，C 原本白色
业务线程: B.field = null;  // B 是灰色，C 失去唯一灰色引用
结果: C 被误判白色，回收 -> 灾难性 bug
```

**两种解决方案**：

| 方案 | 实现 | 收集器 |
|------|------|--------|
| **增量标记更新（Incremental Update）** | 黑色对象新增引用时，记录到队列，重新标灰 | CMS |
| **SATB（Snapshot At The Beginning）** | 灰色对象删除引用前，记录被删引用到队列，标记开始时存活的对象都视为存活 | G1 |

**写屏障（Write Barrier）**：

- 写屏障不是内存屏障，而是 JVM 在对象引用赋值时插入的一段代码（AOP 思想）
- 用于在并发标记期间记录引用变化，保证三色标记正确性
- SATB 写屏障：`A.field = C` 时，把 C 加入 SATB 队列
- 增量更新写屏障：`A.field = C` 时，把 A 加入队列（重新标灰）

#### 5. 逃逸分析与优化

**逃逸分析（Escape Analysis）**：

JVM 在 JIT 编译阶段分析对象的"动态作用域"，判断对象是否会被外部方法或线程引用。

**逃逸程度**（从低到高）：

1. **未逃逸（NoEscape）**：对象只在方法内使用，未传出方法
2. **方法逃逸（ArgEscape）**：对象作为参数传出，但未被外部方法修改
3. **线程逃逸（GlobalEscape）**：对象被其他线程访问（如赋值给静态变量、被存入共享集合）

**三种优化**：

**栈上分配（Stack Allocation）**：

- 未逃逸的对象可以直接分配在栈帧上，方法结束时随栈帧销毁
- 优势：无需 GC，减少堆压力
- **HotSpot JVM 实际上没有真正实现栈上分配**，而是用标量替换替代

**标量替换（Scalar Replacement）**：

- 标量：不可再分解为字段的数据（如 int、long、引用）
- 聚合量：可再分解的对象（如 POJO）
- 若对象未逃逸且可被分解，JIT 把对象拆解为若干标量，分配在栈上或寄存器
- 等价于"虚拟的栈上分配"

```java
// 原始代码
public int calc() {
    Point p = new Point(1, 2);
    return p.x + p.y;
}

// 标量替换后
public int calc() {
    int x = 1;  // p.x 标量化
    int y = 2;  // p.y 标量化
    return x + y;  // 不再创建 Point 对象
}
```

**同步消除（Elimination of Synchronization）**：

- 若对象未逃逸（即不会有其他线程访问），其上的同步措施可以消除
- StringBuffer.append 的 synchronized 在单线程下会被消除

```java
// 原始代码
public String concat(String a, String b) {
    StringBuffer sb = new StringBuffer();
    sb.append(a);  // synchronized
    sb.append(b);  // synchronized
    return sb.toString();
}

// 同步消除后
public String concat(String a, String b) {
    StringBuffer sb = new StringBuffer();
    sb.append(a);  // synchronized 已消除
    sb.append(b);  // synchronized 已消除
    return sb.toString();
}
```

**为什么 HotSpot 默认开启逃逸分析但栈上分配实际很少触发**：

- `-XX:+DoEscapeAnalysis` 默认开启（JDK 8+）
- HotSpot 没有真正实现栈上分配，而是用标量替换替代
- 标量替换需要对象"完全可分解"且未逃逸，条件比想象中苛刻
- 实际项目中，能触发标量替换的对象多是局部临时对象（如 Point、Pair 这种小对象）

**验证逃逸分析**：

```bash
# 打印逃逸分析结果
-XX:+DoEscapeAnalysis -XX:+PrintEscapeAnalysis

# 打印标量替换
-XX:+EliminateAllocations -XX:+PrintInlining

# JIT 编译日志
-XX:+UnlockDiagnosticVMOptions -XX:+PrintCompilation -XX:+LogCompilation
```

**在线问诊系统中的逃逸分析场景**：

- 视频问诊 RTP 包解析的临时对象（未逃逸，可标量替换）
- IM 消息解析的临时对象（未逃逸，可标量替换）
- 问诊订单的 ConsultOrder 对象（会传给其他方法，逃逸，无法标量替换）

---

## 题目二（实战场景题）：在线问诊系统中的 JVM 内存设计

结合在线问诊系统的实际场景，回答以下问题：

1. **IM 长连接 Netty 直接内存估算**：在线问诊日均 5.2w 订单，IM 长连接网关日均承载 12w 长连接，峰值 15w。每条 Netty 长连接占用多少直接内存？10w 长连接场景下 Netty 的堆外内存总占用估算？为什么 Netty 用直接内存而不是堆内存？PooledDirectByteBuf 池化的意义？如何监控 Netty 的直接内存泄漏？
2. **视频问诊 SFU 对象创建压力**：每路视频问诊每秒接收 30 帧 RTP 包，每帧约 5 个包，每个包解析后产生 3-5 个临时对象。峰值 5800 路视频问诊时，每秒对象创建速率是多少？Eden 区大小如何规划？Minor GC 频率如何控制？为什么 SFU 服务要单独部署，不与业务服务混部？
3. **MongoDB 大文档读取的 OOM 风险**：问诊诊疗事件 JSON 文档最大 5MB，IM 消息存档集合单文档最大 16MB。读取时如果用 `BSON.parse()` 直接解析为 POJO，会发生什么？为什么用 `BsonReader` 流式解析更省内存？如何在 JVM 层面控制 MongoDB 大文档读取的内存峰值？
4. **问诊订单对象内存估算**：ConsultOrder 对象有 25 个字段（含基本类型、引用、List），每条订单占多少内存？100w 订单在 JVM 中（如缓存场景）占多少？如何用对象池（ObjectPool）减少内存占用？对象池的代价是什么？为什么大部分场景不建议用对象池？
5. **在线问诊 OOM 排查**：在线问诊系统如果出现 OOM，可能的根因有哪些（至少 5 类）？怎么排查？堆 OOM vs 元空间 OOM vs 直接内存 OOM 的现象差异？GC overhead limit exceeded 是什么？如何配置 -XX:+HeapDumpOnOutOfMemoryError 让 OOM 时自动 dump？

### 作答区

#### 1. IM 长连接 Netty 直接内存估算

**单条 Netty 长连接的内存占用**：

| 组件 | 堆内 | 堆外（直接内存） | 备注 |
|------|------|----------------|------|
| NioSocketChannel | ~1KB | ~1KB | Channel 对象 + 内部 buffer |
| ChannelPipeline | ~2KB | 0 | 处理器链 |
| 编解码器 ByteBuf（PooledDirect） | 0 | 16KB | 默认 PooledByteBufAllocatorL4 |
| 业务 ChannelHandler 状态 | ~4KB | 0 | 用户会话状态（医师/患者 ID 等） |
| 接收缓冲区 SO_RCVBUF | 0 | 默认 32KB（可调） | OS 级别 socket buffer |
| 发送缓冲区 SO_SNDBUF | 0 | 默认 32KB（可调） | OS 级别 socket buffer |
| **合计** | **~7KB** | **~80KB** | 单条连接 |

**10w 长连接的内存占用估算**：

- 堆内：7KB × 10w = **700MB**（业务对象、Channel、Pipeline 等）
- 堆外（直接内存）：80KB × 10w = **8GB**（ByteBuf + Socket Buffer）
- JVM 进程总内存（堆 + 直接内存 + 元空间 + JIT 等）：~10GB

**为什么 Netty 用直接内存而不是堆内存**：

1. **零拷贝**：堆内 ByteBuf 写 socket 时需要先拷贝到直接内存（JVM 堆不受 OS 直接管理，GC 移动对象会导致 socket 引用失效）。直接内存直接写 socket，省一次拷贝
2. **避免 GC 压力**：堆内 ByteBuf 是 JVM 堆对象，会被 GC 扫描。10w 长连接如果每条连接的 ByteBuf 都在堆内，会显著增加 GC 耗时
3. **大块内存分配**：直接内存不受 JVM 堆大小限制，可以分配大块（如 1MB 的 ByteBuf 用于视频流）

**PooledDirectByteBuf 池化的意义**：

- Netty 4 默认使用 `PooledByteBufAllocator`，内部维护 ByteBuf 池（类似 jemalloc）
- 优势：
  - 避免频繁 malloc/free 系统调用（直接内存的 malloc 比堆分配慢）
  - 减少内存碎片
  - 复用 ByteBuf 对象，减少 GC 压力（虽然直接内存不直接受 GC 管理，但 ByteBuf 的包装对象是堆内对象）
- 关键配置：
  - `-Dio.netty.allocator.type=unpooled` 关闭池化（调试用）
  - `-Dio.netty.leakDetection.level=PARANOID` 严格泄漏检测（生产用 SIMPLE）

**Netty 直接内存泄漏监控**：

1. **ResourceLeakDetector**：Netty 内置泄漏检测
   - `DISABLED`：关闭
   - `SIMPLE`：默认，1% 抽样
   - `ADVANCED`：100% 抽样
   - `PARANOID`：100% + 访问记录
2. **NMT（Native Memory Tracking）**：JVM 工具，跟踪所有本地内存
   ```bash
   jcmd &lt;pid> VM.native_memory baseline
   jcmd &lt;pid> VM.native_memory detail.diff
   ```
3. **直接内存监控**：
   - `-XX:MaxDirectMemorySize=8g` 设置直接内存上限
   - JMX `BufferPoolMXBean` 监控 `direct` 池使用量
4. **Netty 自带指标**：
   - `PooledByteBufAllocatorMetric` 暴露到 Micrometer / Prometheus
   - 监控指标：`activeDirectArenas`、`directArenas`、`numDirectAllocations`

**IM 长连接网关 JVM 配置参考**：

```bash
-Xms8g -Xmx8g                          # 堆 8GB
-XX:MaxDirectMemorySize=8g              # 直接内存上限 8GB
-XX:MetaspaceSize=256M
-XX:MaxMetaspaceSize=512M
-XX:+UseG1GC                            # G1 收集器
-XX:MaxGCPauseMillis=100                # 目标停顿 100ms（IM 实时性敏感）
-XX:+ParallelRefProcEnabled             # 并行引用处理
-Dio.netty.allocator.type=pooled        # ByteBuf 池化
-Dio.netty.leakDetection.level=SIMPLE   # 泄漏检测
```

#### 2. 视频问诊 SFU 对象创建压力

**对象创建速率估算**：

- 单路视频：30 帧/秒 × 5 包/帧 = 150 包/秒
- 每包解析产生临时对象：5 个（RtpPacket、SrtpPacket、SrtcpPacket、Payload、统计对象）
- 单路对象创建：150 × 5 = 750 个/秒
- 峰值 5800 路并发：750 × 5800 = **435w 个/秒**

按每个临时对象 64 字节计算：435w × 64B = **278MB/秒** 的对象创建速率。

**Eden 区大小规划**：

- 默认 Eden : Survivor = 8 : 1 : 1，Eden 占新生代 80%
- 假设 Minor GC 间隔 1 秒（容忍 100ms STW）：
  - 1 秒内创建对象 278MB
  - Eden 大小至少 350MB（留 20% 余量）
  - 新生代总大小 350 / 0.8 = 437MB
- 实际配置：新生代 2GB（Eden 1.6GB + 2 个 Survivor 各 200MB），Minor GC 间隔约 5-7 秒

**Minor GC 频率控制**：

- 目标：Minor GC 间隔 > 5 秒，单次 STW &lt; 50ms
- 配置：
  ```bash
  -Xmn2g                                # 新生代 2GB
  -XX:SurvivorRatio=8                   # Eden:Survivor = 8:1:1
  -XX:MaxTenuringThreshold=15           # 晋升 Old 年龄阈值
  -XX:+UseG1GC
  -XX:MaxGCPauseMillis=50               # 目标停顿 50ms（视频实时性要求高）
  -XX:G1HeapRegionSize=16m              # Region 大小 16MB（视频对象较大）
  ```

**为什么 SFU 服务要单独部署**：

1. **JVM 调优方向冲突**：
   - SFU：高对象创建速率，需要大新生代、低 GC 停顿（&lt; 50ms）
   - 业务服务：低对象创建速率，长生命周期对象多（缓存、连接池），需要大老年代
2. **资源隔离**：SFU 是 CPU 密集型（媒体处理）+ 网络密集型，业务服务是 IO 密集型。混部会互相影响
3. **故障隔离**：SFU 故障（如 Full GC）不应影响业务下单
4. **伸缩独立**：SFU 按并发路数伸缩，业务服务按 QPS 伸缩，伸缩策略不同
5. **JVM 参数差异**：SFU 用 G1 或 ZGC（低延迟），业务服务可用 G1（吞吐）

**SFU 服务 JVM 配置参考**：

```bash
-Xms16g -Xmx16g                        # 堆 16GB
-XX:MaxDirectMemorySize=8g              # 视频流 ByteBuf 用直接内存
-XX:+UseZGC                            # ZGC 低延迟（STW < 10ms）
-XX:ZAllocationSpikeTolerance=2        # 高对象分配容忍
-XX:ConcGCThreads=4                    # 并发 GC 线程
-XX:ParallelGCThreads=8                # STW 阶段 GC 线程
```

#### 3. MongoDB 大文档读取的 OOM 风险

**`BSON.parse()` 直接解析的问题**：

- `BSON.parse()` 把整个文档加载到内存，构造完整的 BSON Document 树
- 5MB 文档解析后 BSON Document 树占 10-15MB（中间对象膨胀 2-3 倍）
- 如果同时读取 100 个 5MB 文档，瞬时内存占用 1-1.5GB，容易 OOM
- 实测：MongoDB Java Driver 在读取 16MB 文档时，瞬时内存峰值可达 50MB（含 BSON Document、Java Map、字符串解码后的 char[]）

**BsonReader 流式解析**：

```java
// 错误示范：BSON.parse 全量加载
Document doc = collection.find(eq("_id", id)).first();
String content = doc.getString("content");  // 整个文档已在内存

// 正确示范：BsonReader 流式解析
collection.find(eq("_id", id))
    .map(document -> {
        BsonReader reader = document.getBsonReader();
        reader.readStartDocument();
        while (reader.readBsonType() != BsonType.END_OF_DOCUMENT) {
            String fieldName = reader.readName();
            if ("content".equals(fieldName)) {
                // 流式读取大字段，分块处理
                return readLargeContent(reader);
            } else {
                reader.skipValue();  // 跳过其他字段
            }
        }
        reader.readEndDocument();
        return null;
    })
    .first();

private static String readLargeContent(BsonReader reader) {
    // 大字段分块读取，避免一次性加载
    StringBuilder sb = new StringBuilder();
    char[] buffer = new char[8192];
    try (Reader r = reader.asReader()) {
        int n;
        while ((n = r.read(buffer)) != -1) {
            sb.append(buffer, 0, n);
            // 边读边处理，不一次性持有完整内容
            processChunk(buffer, n);
        }
    }
    return sb.toString();
}
```

**BsonReader 的优势**：

1. **流式读取**：不一次性构造完整 Document 树，按字段顺序读
2. **跳过无用字段**：`skipValue()` 不分配内存
3. **大字段分块**：用 Reader 接口分块读取大字符串
4. **节省 50%+ 内存**：实测对比 BSON.parse，5MB 文档 BsonReader 内存峰值 3MB

**JVM 层面控制 MongoDB 大文档读取的内存峰值**：

1. **限制单次查询返回数**：`batchSize=100`，避免一次返回大量文档
2. **投影（Projection）**：只查需要的字段，减少传输与内存
   ```java
   collection.find(eq("_id", id))
       .projection(Projections.fields(
           Projections.include("orderId", "patientId"),
           Projections.exclude("content")  // 大字段不查
       ));
   ```
3. **游标（Cursor）逐条处理**：避免 `into(new ArrayList<>())` 一次性收集
   ```java
   try (MongoCursor&lt;Document> cursor = collection.find().iterator()) {
       while (cursor.hasNext()) {
           process(cursor.next());  // 逐条处理
       }
   }
   ```
4. **大字段单独查询**：业务流程拆分，先查元数据，需要时再查大字段
5. **分页查询**：避免一次性返回大量文档
6. **JVM 监控**：监控 `BufferPoolMXBean` 的 direct 池（MongoDB Driver 用直接内存做 IO buffer）

#### 4. 问诊订单对象内存估算

**ConsultOrder 对象内存估算**：

假设 ConsultOrder 有 25 个字段：

```java
public class ConsultOrder {
    private Long orderId;          // 8 字节（包装类，含对象头）
    private Long patientId;        // 8 字节
    private Long doctorId;         // 8 字节
    private Long hospitalId;       // 8 字节
    private String deptCode;       // 32 字节（String 对象头 + char[] 引用）
    private Integer consultType;   // 16 字节
    private Integer status;        // 16 字节
    private Integer subStatus;     // 16 字节
    private BigDecimal amount;     // 32 字节
    private Date payTime;          // 24 字节
    private Date acceptTime;       // 24 字节
    private Date endTime;          // 24 字节
    private String imSessionId;    // 32 字节
    private String videoRoomId;    // 32 字节
    private String revisitToken;   // 32 字节
    private Integer refundStatus;  // 16 字节
    private Integer riskLevel;     // 16 字节
    private Integer version;       // 16 字节
    private Date createTime;       // 24 字节
    private Date updateTime;       // 24 字节
    private List<ConsultEvent> events;  // 32 字节（引用）
    private List<Prescription> prescriptions;  // 32 字节
    private Map<String, Object> ext;  // 32 字节
    private byte[] signature;      // 32 字节
    private String remark;         // 32 字节
}
```

**单对象内存计算**（64 位 JVM，开启指针压缩）：

- 对象头：12 字节（Mark Word 8 + Klass Pointer 4）
- 实例数据（25 字段）：约 540 字节
- 对齐填充：到 8 的倍数
- **单对象总大小**：约 552 字节，对齐到 **552 字节**（实际 JVM 对齐到 8 字节，552 已是 8 倍数）

可以用 `jol-core`（Java Object Layout）库精确测量：

```java
<dependency>
    <groupId>org.openjdk.jol</groupId>
    <artifactId>jol-core</artifactId>
    <version>0.17</version>
</dependency>

System.out.println(ClassLayout.parseClass(ConsultOrder.class).toPrintable());
```

**100w 订单占用内存**：

- 单对象 552 字节 × 100w = **552MB**
- 加上 HashMap 节点开销（每个 Entry 约 32 字节）：100w × 32 = 32MB
- **总计约 584MB**

如果用 `ConcurrentHashMap` 缓存：约 600-650MB。

**对象池（ObjectPool）的使用与代价**：

**Apache Commons Pool2 示例**：

```java
GenericObjectPool<ConsultOrder> pool = new GenericObjectPool<>(
    new BasePooledObjectFactory<>() {
        @Override
        public ConsultOrder create() {
            return new ConsultOrder();
        }

        @Override
        public PooledObject<ConsultOrder> wrap(ConsultOrder obj) {
            return new DefaultPooledObject<>(obj);
        }

        @Override
        public void passivateObject(PooledObject<ConsultOrder> p) {
            // 归还时清理状态
            ConsultOrder o = p.getObject();
            o.setOrderId(null);
            o.setPatientId(null);
            // ... 清理 25 个字段
        }
    }
);
pool.setMaxTotal(1000);  // 池大小 1000
```

**对象池的代价**：

1. **归还时清理成本高**：每个字段重置为 null/0，25 个字段的开销不可忽视
2. **线程同步开销**：池的 borrow/return 需要同步
3. **对象池本身的内存占用**：池数据结构、PooledObject 包装
4. **GC 压力未必降低**：现代 JVM 的年轻代 GC 非常快（&lt; 10ms），对象池反而延长对象寿命（进入老年代），增加 Full GC

**为什么大部分场景不建议用对象池**：

- JVM 的年轻代 GC 远比对象池的高效（标量替换 + TLAB + 复制算法）
- 对象池适用于"对象创建/销毁成本高"的场景，如：
  - 数据库连接（建立 TCP + 认证，成本秒级）
  - 线程（创建栈、内核对象）
  - 大对象（如 byte[1024] 以上，避免内存碎片）
- 普通业务对象（如 ConsultOrder）用对象池反而劣化性能

**在线问诊系统的对象池实践**：

- **不池化**：ConsultOrder、ConsultEvent、ConsultMessage 等业务对象
- **池化**：数据库连接（HikariCP）、HTTP 连接（OkHttp ConnectionPool）、Netty ByteBuf（PooledByteBufAllocator）
- **复用**：StringBuilder 用 `ThreadLocal<StringBuilder>`（避免反复创建大 char[]）

#### 5. 在线问诊 OOM 排查

**OOM 可能根因（至少 5 类）**：

| OOM 类型 | 错误信息 | 常见根因 |
|---------|---------|---------|
| 堆 OOM | `java.lang.OutOfMemoryError: Java heap space` | 内存泄漏（缓存无淘汰）、大对象（如读取 100MB 文件到内存）、对象创建速率过高 |
| 元空间 OOM | `java.lang.OutOfMemoryError: Metaspace` | 类加载泄漏（动态生成类不释放，如 CGLIB、Groovy 脚本、JSP 重编译） |
| 直接内存 OOM | `java.lang.OutOfMemoryError: Direct buffer memory` | Netty ByteBuf 泄漏、NIO Channel 未关闭、未释放的 MappedByteBuffer |
| GC overhead | `java.lang.OutOfMemoryError: GC overhead limit exceeded` | 98% 时间做 GC，回收 &lt; 2% 堆内存（实质是堆 OOM 的预警） |
| 栈 OOM | `java.lang.OutOfMemoryError: unable to create new native thread` | 线程数过多（每线程 1MB 栈，1000 线程占 1GB） |
| 元空间类元数据 OOM | `java.lang.OutOfMemoryError: Compressed class space` | 加载类数量超过 1GB 压缩类空间（极罕见） |

**排查流程**：

```
告警触发（OOM 或 Full GC 频繁）
   │
   ▼
1. 现象定位
   │  - jstat -gc <pid> 1s 看 GC 频率与各区使用量
   │  - jcmd <pid> VM.native_memory summary 看本地内存
   │  - top -Hp <pid> 看线程 CPU
   │
   ▼
2. 类型判断
   │  - 看 OOM 错误信息（heap space / Metaspace / Direct buffer）
   │  - 看 GC 日志（Full GC 频繁 + Old 区不下降 = 堆泄漏）
   │
   ▼
3. Heap dump 分析
   │  - jmap -dump:format=b,file=heap.hprof <pid>
   │  - MAT (Eclipse Memory Analyzer) 打开
   │  - 看 Dominator Tree 找最大对象
   │  - 看 Leak Suspects 报告找泄漏点
   │  - 看 Histogram 按类型统计
   │
   ▼
4. 根因定位
   │  - 大对象：可能是缓存、大 List、大 Map
   │  - 类加载泄漏：看 ClassLoader 数量，看动态代理类
   │  - 直接内存泄漏：看 Netty ByteBuf、JVM BufferPool
   │
   ▼
5. 修复
   │  - 缓存加淘汰策略（Caffeine maxSize/TTL）
   │  - 大对象改流式处理
   │  - 动态代理类用 WeakReference 缓存
   │  - ByteBuf 用 try-with-resources 确保释放
```

**堆 OOM vs 元空间 OOM vs 直接内存 OOM 现象差异**：

| 维度 | 堆 OOM | 元空间 OOM | 直接内存 OOM |
|------|--------|-----------|-------------|
| 错误信息 | Java heap space | Metaspace | Direct buffer memory |
| 前兆 | Full GC 频繁，Old 区不降 | 类加载日志暴涨 | RSS 持续上涨，堆使用正常 |
| 监控指标 | jvm.gc.full / jvm.memory.heap | jvm.classes.loaded | jvm.buffer.direct.used |
| 排查工具 | jmap + MAT | jcmd class_stats + ClassLoader 查询 | NMT + Netty 泄漏检测 |
| 常见根因 | 缓存泄漏 / 大对象 | 动态代理 / Groovy / JSP | ByteBuf 泄漏 / NIO 未关闭 |

**GC overhead limit exceeded 是什么**：

- JVM 默认开启（`-XX:+UseGCOverheadLimit`）
- 触发条件：连续 5 次 GC 98% 时间做 GC，且回收 &lt; 2% 堆内存
- 实质是"堆 OOM 的预警"，告诉程序"继续 GC 已无意义"
- 可以关闭（`-XX:-UseGCOverheadLimit`），但**不推荐**--隐藏了真实问题

**配置 HeapDumpOnOutOfMemoryError**：

```bash
-XX:+HeapDumpOnOutOfMemoryError
-XX:HeapDumpPath=/data/dumps/
-XX:OnOutOfMemoryError="kill -9 %p"  # OOM 后杀进程（避免僵尸状态）
```

**生产环境配置建议**：

```bash
# 必备
-XX:+HeapDumpOnOutOfMemoryError
-XX:HeapDumpPath=/data/dumps/
-XX:+PrintGCDetails
-XX:+PrintGCDateStamps
-Xloggc:/data/logs/gc.log
-XX:+UseGCLogFileRotation
-XX:NumberOfGCLogFiles=10
-XX:GCLogFileSize=100M

# JDK 11+ 改用 Xlog
-Xlog:gc*:file=/data/logs/gc.log:time,uptime:filecount=10,filesize=100m
```

**在线问诊系统 OOM 排查实战案例**：

**案例 1：IM 长连接服务直接内存 OOM**
- 现象：高峰期直接内存从 4GB 飙升到 8GB，触发 OOM
- 排查：Netty 泄漏检测发现 `ByteBuf.release()` 未调用
- 根因：自定义 ChannelHandler 在异常分支未释放 ByteBuf
- 修复：用 `ReferenceCountUtil.release()` 在 finally 块释放

**案例 2：监管上报服务堆 OOM**
- 现象：Full GC 频繁，Old 区不降
- 排查：jmap dump 后 MAT 分析，发现 `Map<String, RegulatorRecord>` 占用 4GB
- 根因：幂等表未设置 TTL，3 年累积 4750w 条记录
- 修复：幂等表加 7 天 TTL，过期归档 OSS

**案例 3：视频问诊 SFU 元空间 OOM**
- 现象：SFU 服务运行 7 天后元空间从 200MB 涨到 2GB
- 排查：jcmd class_stats 发现大量 `org.mediasoup.$Proxy` 类
- 根因：mediasoup-client 动态代理类未复用，每次创建新代理
- 修复：代理类缓存（ConcurrentHashMap），复用已生成的代理

---

## 本日能力差距与补足方向

### 差距 1：JVM 内存模型的版本演进细节不清
> Day1发现

- **现状**：知道 JDK 8 用元空间替换永久代，但具体哪些数据从永久代迁移到哪（字符串常量池、静态变量、Class 元数据）模糊
- **架构师水平**：能讲清 JDK 6/7/8/9/10/11/17 各版本 JVM 内存模型的变化，能根据 JDK 版本选择合适的 GC 参数
- **补足方向**：精读《深入理解 Java 虚拟机》第 2 章版本演进；阅读 OpenJDK 内存模型演进官方文档；用 `jcmd <pid> VM.native_memory` 观察 JDK 8 vs 11 vs 17 的差异

### 差距 2：对象头 Mark Word 在不同锁状态下的变化不熟
> Day1发现

- **现状**：知道 Mark Word 8 字节，但锁升级（无锁 -> 偏向锁 -> 轻量级锁 -> 重量级锁）时 Mark Word 的位变化不熟
- **架构师水平**：能画出 Mark Word 在 5 种锁状态下的位布局，能根据锁升级路径理解 synchronized 的性能演进
- **补足方向**：精读《Java 并发编程的艺术》第 2 章 Java 对象头；用 `jol-core` 实际打印对象在不同锁状态下的内存布局

### 差距 3：三色标记与 SATB 的工程理解不深
> Day1发现

- **现状**：知道三色标记与 SATB 概念，但 SATB 在 G1 中具体如何实现、与 CMS 增量更新的差异对生产调优的影响不深
- **架构师水平**：能讲清 SATB 写屏障的代码级实现、SATB 队列在 GC 中的作用、为什么 G1 用 SATB 而不用增量更新
- **补足方向**：阅读 G1 论文《Garbage-First Garbage Collection》；阅读 OpenJDK G1 源码 `g1SATBCardTableModRefBS.cpp`；Day07 深挖 G1 时深入

### 差距 4：逃逸分析的实战经验不足
> Day1发现

- **现状**：知道逃逸分析的三种优化（栈上分配/标量替换/同步消除），但实际项目中如何验证、如何写出利于逃逸分析的代码不深
- **架构师水平**：能用 `-XX:+PrintEscapeAnalysis` 验证逃逸分析结果，能指导团队写出利于 JIT 优化的代码
- **补足方向**：用 JMH 实测逃逸分析前后的性能差异；阅读 JIT 编译日志（`-XX:+LogCompilation`）理解优化决策

### 差距 5：在线问诊系统的 JVM 内存规划缺少实战
> Day1发现

- **现状**：能估算 Netty 长连接、SFU 对象、MongoDB 大文档的内存占用，但实际生产压测调优经验不足
- **架构师水平**：能根据业务规模精确规划堆/直接内存/元空间大小，能用 JFR（Java Flight Recorder）做生产压测分析
- **补足方向**：第 2 周实战；用 JMH + JFR 做问诊系统核心链路压测；调研 Netflix、Linkedin 的 JVM 容量规划方法论
