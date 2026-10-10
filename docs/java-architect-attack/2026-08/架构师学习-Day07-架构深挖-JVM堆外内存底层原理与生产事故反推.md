# Day 7：架构深挖 - JVM 堆外内存底层原理与生产事故反推

> 日期：2026年08月09日（周日）
> 周主题：JVM 专题第 2 周 - 调优实战与生产排查
> 深挖日：Day07 - JVM 堆外内存底层原理与生产事故反推（Direct ByteBuffer / MappedByteBuffer / JNI Memory / Metaspace / Thread Stack / Code Cache / NMT / 四防闭环）

---

## 一、今日主题

本周 Day01-Day06 完成了 JVM 调优实战与生产排查的 6 大支柱学习：

```text
Day01：JVM 调优参数全解（堆 / GC / JIT / 容器化 / -XX 陷阱、参数版本演进、MaxGCPauseMillis 陷阱、指针压缩、容器化 cgroup、生产配置模板）
Day02：JVM 诊断工具链实战（jps/jstat/jmap/jstack/jcmd + Arthas + MAT + async-profiler + JFR + GC 日志、K8s 容器内工具链）
Day03：OOM 排查实战（8 种 OOM 类型 / 5 种 dump 方式 / MAT 支配树 / 5 类泄漏模式 / 5 分钟定位 / 大 dump 处理）
Day04：CPU 飙高排查实战（6 种 CPU 高类型 / 5 步法 / async-profiler 4 模式 / JIT 退优化 / Safepoint / 工具副作用）
Day05：在线问诊系统 JVM 实战（5 个 STAR 案例：IM 网关 ByteBuf OOM / 视频 RTP 包堆积 / 监管上报 Map OOM / 问诊订单缓存膨胀 / MongoDB 大文档 Humongous）
Day06：串联整合 - 一次完整的 JVM 故障复盘（5 分钟止血 / 1 小时根因 / 24 小时修复 / 1 周预防体系）
```

Day06 把 Day01-Day05 串成"故障复盘全链路"，但有一个维度我们一直回避了：**堆外内存**。

回顾本周 5 个 STAR 案例：

```text
案例一：IM 网关 ByteBuf 直接内存 OOM     <- 堆外内存
案例二：视频问诊 RTP 包堆积 Full GC      <- 堆内 + GC
案例三：监管上报 Map 累积 heap OOM       <- 堆内
案例四：问诊订单缓存 100w Key GC CPU 高  <- 堆内 + GC
案例五：MongoDB 大文档 G1 Humongous      <- 堆内 + GC
```

5 个案例中 **4 个是堆内 + GC**，只有 1 个是堆外内存。但堆内 + GC 的 4 个案例我们上周（07月第5周 Day07）已经深挖了 G1GC 底层原理，本周 Day03 也覆盖了 OOM 排查。**唯独堆外内存（案例一）只在 Day05 走了排查流程，从未深挖底层原理**。

更关键的是：

```text
Day01 提到了 -XX:MaxDirectMemorySize，但只讲了"参数本身"
Day02 提到了 NMT（Native Memory Tracking），但只讲了"工具用法"
Day03 提到了 Direct ByteBuffer OOM，但只讲了"8 种 OOM 类型之一"
Day05 案例一用了 NMT + MAT 排查，但只讲了"5 分钟定位流程"
```

每个知识点都"知道一点"，但从未把背后的：

```text
堆外内存 6 大区域（Direct Memory / MappedByteBuffer / JNI Memory / Metaspace / Thread Stack / Code Cache）
Direct ByteBuffer 的 Cleaner / PhantomReference / Deallocator 机制
-XX:MaxDirectMemorySize 的真实含义与"不显式设置时的默认值"
NMT 为什么"抓不全"（不跟踪 JNI 内部分配 / 不跟踪第三方 native 库）
Metaspace 的 Class Space vs Non-Class Space 与"Metaspace OOM 排查"
Thread Stack 的隐式 OOM（线程数爆炸）
Code Cache 满了引发 JIT 退优化 -> CPU 飙高的链路
```

讲清楚。Day07 把这个问题彻底深挖。

结合用户业务背景：**Day05 案例一 IM 网关 ByteBuf OOM 修复后，上线第 30 天凌晨突发"二次复发"事故**。第一次故障（Day05 案例）我们用"业务侧修复 ByteBuf 引用计数 Bug + -XX:MaxDirectMemorySize=2g 上限"止血，但二次复发的根因与第一次完全不同——这次不是业务代码 Bug，而是 **JVM 自身的堆外内存机制在特定业务场景下的"必然副作用"**。如果不能从底层原理理解堆外内存，"二次复发"永远无法根除。

---

## 二、题目：JVM 堆外内存底层原理深挖与生产事故反推

Day05 案例一 IM 网关 ByteBuf OOM 故障修复方案：

```text
1. 业务侧：修复 ByteBuf 引用计数 Bug（漏 release -> 引用计数归零后 Deallocator 释放）
2. JVM 侧：-XX:MaxDirectMemorySize=2g（限制直接内存上限）
3. 监控侧：NMT + JMX 监控 direct memory 池
4. 容量侧：Pod limit 内存 4g -> 6g（为堆外预留 2g 空间）
```

上线后平稳运行 30 天，**第 31 天凌晨 03:00 突发 4 个异常现象**：

```text
现象1：Direct Memory 涨到 1.9g（接近 -XX:MaxDirectMemorySize=2g 上限），
       但 jmap -heap 显示堆只用了 1.2g（Old 600m + Young 600m）。
       JMX 监控 java.nio.BufferPool 直接内存统计 = 1.9g，
       NMT Internal 内存 = 1.5g。
       业务日志无 OOM，但 IM 消息发送 P99 从 30ms 飙到 800ms。

现象2：Arthas heapdump 抓 dump 后用 MAT 分析，
       按"Retained Size"排序前 100 个对象都是 DirectByteBuffer 对象，
       但每个 DirectByteBuffer 的"占用字节数"只有 100KB（业务正常大小）。
       全局 grep DirectByteBuffer 实例数 = 1.8w 个，
       按每个 100KB 算应该是 1.8g，与 NMT 1.5g 接近，但"为什么 1.8w 个 DirectByteBuffer 没被 GC 回收"？

现象3：jcmd PID VM.native_memory summary 显示：
       Internal 内存 1.5g（正常应该 200-500m）
       进一步 jcmd PID VM.native_memory baseline + diff，
       发现 30 分钟内 Internal 增长 800m，但堆内 Old 区只增长 50m。
       NMT diff 中 "Internal" 项下没有"对应的 Java 线程栈帧"，只有 "[Anonymous]" 标记。

现象4：jstack 抓栈发现 1800 个线程（正常 800 个），
       每个线程默认 1MB 栈，1800 * 1MB = 1.8g 线程栈内存。
       top -p PID 显示 RSS = 5.2g（Pod limit 6g），
       其中堆 1.2g + Direct 1.9g + 线程栈 1.8g + Metaspace 200m + Code Cache 150m + JVM 自身 = 5.2g。
       凌晨 03:15 突发 OOMKilled（K8s 杀 Pod），10w 长连接 100% 断线。
```

现在要求你：

```text
从 JVM 堆外内存底层机制（6 大区域 / Direct ByteBuffer 生命周期 / Cleaner 机制 /
NMT 原理 / Metaspace 结构 / Thread Stack / Code Cache）
出发，解释清楚上述四个现象的根因，并给出架构师视角的"四防闭环"设计与替代方案。
```

---

## 三、需要回答的问题

### 1. 堆外内存 6 大区域全解

请说明：

```text
- JVM 进程的内存布局：堆 / 堆外 / Native / 共享库 / 文件映射，分别在哪一段？
- 堆外内存的 6 大区域是哪 6 个？各自的 JVM 参数是什么？
  - Direct Memory（Direct ByteBuffer）
  - MappedByteBuffer（文件映射）
  - JNI Memory（native 代码 malloc）
  - Metaspace（元空间，JDK 8+ 替代永久代）
  - Thread Stack（线程栈）
  - Code Cache（JIT 编译后的机器码）
- 这 6 大区域哪几个受 -Xmx 控制？哪几个不受？哪几个受 Pod limit 控制？
- 为什么 GC 不能回收堆外内存？GC 与 Cleaner 的关系？
- 在线问诊 IM 网关中，这 6 大区域的典型占用比例是多少？
```

### 2. Direct ByteBuffer 生命周期与 Cleaner 机制

请说明：

```text
- Direct ByteBuffer 的创建链路：ByteBuffer.allocateDirect() -> Unsafe.allocateMemory() -> malloc()
- DirectByteBuffer 对象本身在堆内，但其背后的 buffer 在堆外，怎么理解这种"对象在内存在堆外"的设计？
- Cleaner 机制：PhantomReference + ReferenceQueue + Cleaner.Cleanable
- DirectByteBuffer 的 Deallocator 是如何被触发的？
  - GC 时发现 DirectByteBuffer 没有 Strong/Soft/Weak 引用，进入 Phantom Reference Queue
  - ReferenceHandler 线程（Reference$ReferenceHandler）轮询 ReferenceQueue，调用 Cleaner.clean()
  - Cleaner.clean() 调用 Deallocator.run() -> Unsafe.freeMemory()
- 为什么"DirectByteBuffer 对象被 GC 回收了，但堆外内存没释放"？这种状态怎么产生？
- 为什么 System.gc() 能"加速"Direct Memory 释放？-XX:+DisableExplicitGC 的副作用是什么？
- Netty 的 ByteBuf 为什么不用 DirectByteBuffer 而是自己用 Unsafe.allocateMemory() 实现？
```

### 3. -XX:MaxDirectMemorySize 的真实含义与"不显式设置时的默认值"

请说明：

```text
- -XX:MaxDirectMemorySize 的真实含义是什么？限制的是"DirectByteBuffer 对象数"还是"Unsafe.allocateMemory 的总字节数"？
- 不显式设置 -XX:MaxDirectMemorySize 时，默认值是多少？（答案：等于 -Xmx）
- 这个"等于 -Xmx"的默认值有什么陷阱？（Pod limit 6g，-Xmx 4g，则 Direct Memory 默认能用到 4g，但 Pod 实际只剩 2g）
- -XX:MaxDirectMemorySize 与 Netty 的 -Dio.netty.allocator.maxDirectMemory 的关系？谁优先？
- 为什么"业务代码没显式调用 ByteBuffer.allocateDirect()"，Direct Memory 也会涨？（答案：JDK 自身的 NIO / GZIP / ImageIO / CharsetEncoder 都会用）
- Direct Memory 涨到上限会抛什么 OOM？是 "java.lang.OutOfMemoryError: Direct buffer memory"
- 业务代码能 catch 这个 OOM 后继续运行吗？为什么？
```

### 4. NMT（Native Memory Tracking）的底层原理与"为什么抓不全"

请说明：

```text
- NMT 的底层原理：JVM 在每次 malloc/free 时记录"调用栈 + 字节数"，定期汇总
- NMT 的开关：-XX:NativeMemoryTracking=summary / detail，开 detail 的开销有多大？
- NMT 的 8 大分类：Java Heap / Class / Thread / Code / GC / Compiler / Internal / Other
- 现象3 中"Internal 内存 1.5g 但显示 [Anonymous]"是什么意思？为什么 NMT 抓不到对应的 Java 栈帧？
  - 答案：JNI 第三方库（Netty Native epoll / RocksJava / JNI 调用 libssl）的 malloc 不走 JVM 的 malloc wrapper
  - NMT 只跟踪 JVM 自己的 malloc，第三方 native 库的 malloc "看不见"
- NMT 的 baseline + diff 模式怎么用？为什么 diff 比单次 summary 更有诊断价值？
- NMT 跟踪不到的堆外内存怎么排查？（pmap / smaps / gdb / async-profiler native 模式）
- NMT 本身的内存开销：开 summary 约 1-5% 进程内存，开 detail 可能 5-15%
```

### 5. Metaspace 的底层结构与 OOM 排查

请说明：

```text
- Metaspace 的分层结构：Class Space（存放 klass 元数据）vs Non-Class Space（存放 method 元数据、常量池、运行时常量池）
- 为什么 JDK 8 用 Metaspace 替代永久代？永久代的什么问题被解决了？
- Metaspace 的内存来源：堆外（malloc + mmap），不是堆内
- Metaspace 的释放条件：ClassLoader 被 GC 回收时，其加载的所有 Class 元数据被释放
- Metaspace OOM 的根因 5 类：
  - 类加载器泄漏（动态生成 Class 但 ClassLoader 没释放，如 CGLIB / Javassist）
  - 类加载器爆炸（每次请求 new ClassLoader，如 OSGi 动态加载）
  - Spring Boot DevTools 热部署频繁
  - JSP 重新编译（JSP -> Class）
  - Groovy / Jython 动态脚本
- -XX:MaxMetaspaceSize 的默认值是多少？（答案：无上限，受 Pod limit 限制）
- Metaspace OOM 怎么排查？（jcmd PID GC.class_stats / Arthas classloader / NMT Class 项）
```

### 6. Thread Stack 的内存占用与"线程数爆炸引发的隐式 OOM"

请说明：

```text
- Thread Stack 的内存来源：每个线程在 OS 层面分配的栈空间（默认 1MB），由 pthread 分配
- -XX:ThreadStackSize 的默认值：Linux 1MB / Windows 1MB / macOS 1MB
- -Xss 与 -XX:ThreadStackSize 的关系？哪个是 alias？
- Thread Stack 算堆内还是堆外？算 Pod limit 还是 -Xmx？
- 现象4 中"1800 个线程 * 1MB = 1.8g 线程栈"，为什么没触发 -Xmx 限制却触发了 OOMKilled？
- 线程数为什么会爆炸？常见原因：
  - Tomcat / Jetty 工作线程配置过大（maxThreads=2000）
  - HTTP Client 连接池每个连接一个线程
  - 定时任务 / 异步任务滥用 new Thread()
  - ForkJoinPool 并发度过高
  - 第三方 SDK 每次调用 new Thread
- 线程数爆炸的"5 分钟定位法"：jstack | grep "java.lang.Thread.State" | wc -l
- 线程栈 OOM 怎么预防？（-XX:ThreadStackSize=512k + 线程池上限 + 监控线程数）
```

### 7. Code Cache 的分层结构与"Code Cache 满了引发 JIT 退优化"

请说明：

```text
- Code Cache 的分层结构：C1 编译的代码 / C2 编译的代码 / 解释执行的字节码
- -XX:ReservedCodeCacheSize 的默认值：JDK 8 48m / JDK 11+ 240m
- Code Cache 满了会怎样？
  - JIT 停止编译新方法
  - 已编译的方法"退优化"回解释执行
  - 应用 CPU 飙高（解释执行比 C2 慢 5-20 倍）
- 现象：Code Cache 240m 满 -> 大量方法退优化 -> CPU 飙高 95% -> 业务 P99 飙到 1s
- 怎么排查？（jcmd PID Compiler.codecache / JITWatch / -XX:+PrintCompilation）
- Code Cache 为什么会满？
  - 方法数过多（巨型应用 + 反射 / 动态代理生成大量 method）
  - JIT 编译阈值过低（-XX:CompileThreshold=100，导致大量方法被编译）
  - 分层编译开启（TieredCompilation 默认开启，5 层编译占用更多 Code Cache）
- Code Cache OOM 的预防：增大 -XX:ReservedCodeCacheSize / 关闭分层编译（不推荐）
```

### 8. 堆外内存排查的完整工具链

请说明：

```text
- JDK 自带工具：
  - jcmd PID VM.native_memory summary / detail / baseline / diff
  - jcmd PID GC.heap_info（含 Direct ByteBuffer 池）
  - jstat -gc PID（含 Metaspace 使用）
  - JMX MBean：java.nio.BufferPool（Direct / Mapped）
- Arthas 命令：
  - dashboard（线程数 / 直接内存）
  - vmtool --action getInstances --className java.nio.DirectByteBuffer
  - profiler start --event alloc / --event cpu / --event native
- 系统级工具：
  - top -p PID（RSS 总内存）
  - pmap -x PID（详细内存映射）
  - smaps（按段统计 RSS / PSS）
  - /proc/PID/status（VmRSS / VmSize / Threads）
  - gdb（attach 后 dump 内存段）
- async-profiler native 模式：
  - ./profiler.sh -e malloc PID（跟踪 malloc 调用）
  - ./profiler.sh -e free PID（跟踪 free 调用）
- 大堆外内存 dump 怎么处理？
  - NMT detail 模式：jcmd PID VM.native_memory.detail > nmt.txt
  - 结合 async-profiler native 火焰图定位调用栈
- K8s 容器内排查：
  - kubectl exec 进入 Pod
  - JVM 自身工具无需 hostpid
  - 系统级工具（pmap / gdb）需要 privileged 容器
```

---

## 四、问题逐题深挖

### 4.1 堆外内存 6 大区域全解

#### 4.1.1 JVM 进程的内存布局

很多开发者以为"JVM 内存 = 堆 + 元空间"，实际远远不止。一个 JVM 进程的虚拟内存布局：

```text
进程虚拟内存（VSS）：
├── 堆（Heap）：-Xmx 控制，受 GC 管理
│   ├── Young（Eden + S0 + S1）
│   └── Old
├── 堆外（Off-Heap / Native Memory）：
│   ├── Direct Memory（Direct ByteBuffer，受 -XX:MaxDirectMemorySize 限制）
│   ├── MappedByteBuffer（mmap 文件映射，受 OS 文件大小限制）
│   ├── JNI Memory（native 代码 malloc，无 JVM 限制，受 Pod limit 限制）
│   ├── Metaspace（-XX:MaxMetaspaceSize）
│   ├── Thread Stack（-XX:ThreadStackSize × 线程数）
│   ├── Code Cache（-XX:ReservedCodeCacheSize）
│   ├── GC 内部数据结构（Card Table / RSet / Mark Bitmap）
│   └── JVM 自身（C++ 对象 / 字符串 / JIT 编译器中间数据）
├── 共享库（.so / .dll）：所有 Java 进程共享，但 RSS 只算一份
└── 文件映射（jar / class 文件）：mmap，共享
```

实际 RSS（Resident Set Size，物理内存占用）= 堆使用量 + 堆外使用量 + 共享库 + JVM 自身。**Pod limit 限制的是 RSS，不是 -Xmx**。

#### 4.1.2 6 大堆外区域详解

| 区域 | JVM 参数 | 默认值 | 受 GC 管理 | 受 Pod limit 限制 | 监控方式 |
|------|----------|--------|------------|-------------------|----------|
| Direct Memory | -XX:MaxDirectMemorySize | = -Xmx | 否（Cleaner 触发） | 是 | JMX BufferPool / NMT |
| MappedByteBuffer | 无 | 无限制 | 否（munmap 触发） | 是 | NMT Internal |
| JNI Memory | 无 | 无限制 | 否（手动 free） | 是 | NMT 抓不到 |
| Metaspace | -XX:MaxMetaspaceSize | 无上限 | 间接（ClassLoader GC 时） | 是 | jstat -gc / NMT Class |
| Thread Stack | -XX:ThreadStackSize | 1MB × 线程数 | 否 | 是 | jstack 线程数 × ThreadStackSize |
| Code Cache | -XX:ReservedCodeCacheSize | JDK8 48m / JDK11+ 240m | 否 | 是 | jcmd Compiler.codecache |

#### 4.1.3 为什么 GC 不能回收堆外内存

GC 的设计目标是回收"堆内对象"，而堆外内存的"对象"不在堆内：

```text
DirectByteBuffer 对象本身：在堆内，受 GC 管理
DirectByteBuffer 背后的 buffer：在堆外（malloc 分配），不受 GC 管理

GC 回收 DirectByteBuffer 对象时：
  - 发现 DirectByteBuffer 没有 Strong/Soft/Weak 引用
  - 进入 Phantom Reference Queue
  - ReferenceHandler 线程调用 Cleaner.clean()
  - Cleaner 调用 Deallocator.run() -> Unsafe.freeMemory()
  - 堆外内存被释放
```

**关键点**：GC 不直接回收堆外内存，但 GC 触发 Cleaner 间接回收。如果 GC 不发生（堆还很满，没触发 GC），DirectByteBuffer 对象即使没引用也不会被回收，堆外内存持续累积。

这就是为什么"业务流量低时 Direct Memory 反而持续涨"——流量低 = 堆没涨 = GC 不发生 = Cleaner 不触发 = 堆外内存不释放。

#### 4.1.4 在线问诊 IM 网关的典型占用比例

IM 网关 4 core / 8GB Pod 的典型内存占用（10w 长连接）：

```text
Pod limit = 6g（K8s limit）
└── RSS 实际占用 = 5.2g
    ├── 堆 = 1.5g（-Xmx 2g，Old 1g + Young 0.5g）
    ├── Direct Memory = 1.9g（Netty ByteBuf 池）
    ├── Thread Stack = 1.0g（1000 线程 × 1MB）
    ├── Metaspace = 200m
    ├── Code Cache = 150m
    ├── GC 内部 = 100m（Card Table + RSet）
    ├── JVM 自身 = 200m
    └── 共享库 = 150m（共享，只算 RSS 一份）
```

可以看到：**堆 1.5g 只占 RSS 的 29%，堆外 3.4g（Direct + Stack + Metaspace + Code Cache）占 65%**。如果只盯着堆调优，永远调不好 IM 网关。

#### 4.1.5 小结

```text
关键认知 1：Pod limit 限制的是 RSS，不是 -Xmx
关键认知 2：-Xmx 只管堆，6 大堆外区域各管各的
关键认知 3：GC 不直接回收堆外内存，只触发 Cleaner 间接回收 Direct
关键认知 4：JNI / Mapped / Metaspace 的释放机制各不相同
关键认知 5：堆外内存是"隐式 OOM"的温床——不抛 OOM 但 RSS 涨到 Pod limit 被 OOMKilled
```

### 4.2 Direct ByteBuffer 生命周期与 Cleaner 机制

#### 4.2.1 创建链路：从 allocateDirect 到 malloc

```java
ByteBuffer.allocateDirect(1024 * 1024) // 1MB
```

底层调用链：

```text
1. ByteBuffer.allocateDirect(int cap)
   -> new DirectByteBuffer(cap)

2. DirectByteBuffer(int cap)
   -> super(-1, 0, cap, cap)  // mark/position/limit/capacity
   -> boolean pa = VM.isDirectMemoryPageAligned()  // 是否页对齐
   -> Bits.reserveMemory(size, cap)  // 检查是否超 MaxDirectMemorySize
   -> long base = unsafe.allocateMemory(size)  // 调用 Unsafe 分配堆外内存
   -> unsafe.setMemory(base, size, (byte) 0)  // 清零
   -> cleaner = Cleaner.create(this, new Deallocator(base, size, cap))  // 注册 Cleaner

3. Unsafe.allocateMemory(long size)
   -> 调用 native malloc()
   -> 返回堆外内存地址
```

`Bits.reserveMemory` 是关键的"额度检查"：

```text
- Bits 类有一个静态计数器 totalCapacity，记录当前所有 DirectByteBuffer 的总字节数
- reserveMemory 检查 totalCapacity + size 是否超过 MaxDirectMemorySize
- 超过则触发 System.gc() 期望 GC 回收部分 DirectByteBuffer
- System.gc() 后还超则抛 OOM: Direct buffer memory
```

#### 4.2.2 Cleaner 机制：PhantomReference + ReferenceQueue

Cleaner 的本质是一个 PhantomReference：

```java
public class Cleaner extends PhantomReference<Object> {
    private static final ReferenceQueue<Object> dummyQueue = new ReferenceQueue<>();
    private Cleaner next, prev;  // 双向链表
    private final Runnable thunk;  // 实际清理逻辑

    public static Cleaner create(Object obj, Runnable thunk) {
        if (thunk == null) return null;
        Cleaner c = new Cleaner(thunk, obj);  // obj 是 referent
        // 加入 Cleaner 双向链表
        return c;
    }

    public void clean() {
        // 从双向链表移除
        // 调用 thunk.run()
    }
}
```

DirectByteBuffer 创建时传入的 `Deallocator` 就是 thunk：

```java
private static class Deallocator implements Runnable {
    private long address;
    private long size;
    private int capacity;

    public void run() {
        if (address == 0) return;
        unsafe.freeMemory(address);  // 释放堆外内存
        address = 0;
        Bits.unreserveMemory(size, capacity);  // 减少计数器
    }
}
```

#### 4.2.3 Cleaner 触发的完整链路

```text
1. DirectByteBuffer 对象失去所有 Strong 引用
   ↓
2. GC 发生（Young GC 或 Full GC）
   ↓
3. DirectByteBuffer 对象被标记为"无引用"
   ↓
4. 由于它是 PhantomReference，进入 ReferenceQueue
   ↓
5. Reference$ReferenceHandler 线程（优先级 MAX_PRIORITY）轮询 ReferenceQueue
   ↓
6. ReferenceHandler 检测到是 Cleaner，调用 Cleaner.clean()
   ↓
7. Cleaner.clean() 调用 Deallocator.run()
   ↓
8. Deallocator 调用 Unsafe.freeMemory() 释放堆外内存
   ↓
9. Bits.unreserveMemory() 减少全局计数器
```

**关键点**：步骤 5 是异步的，由 ReferenceHandler 线程在后台执行。如果 ReferenceHandler 线程被阻塞（CPU 抢占不到 / 死锁），堆外内存即使该释放也不会释放。

#### 4.2.4 现象2 根因：为什么 1.8w 个 DirectByteBuffer 没被 GC 回收

回到现象2：MAT 分析显示 1.8w 个 DirectByteBuffer 实例，每个 100KB，总计 1.8g，"为什么没被 GC 回收"？

可能原因：

```text
原因1：DirectByteBuffer 对象仍有 Strong 引用
  - 业务代码维护了一个 List<ByteBuffer> 缓存池，但忘了从池中 remove
  - Netty ByteBuf 池的 chunk 还在引用 DirectByteBuffer
  - ThreadLocal 中残留 DirectByteBuffer

原因2：GC 没发生（最常见）
  - 堆内只用了 1.2g，-Xmx 4g，堆使用率 30%
  - Young GC 不频繁（IM 网关业务对象小，Young 区没满）
  - DirectByteBuffer 在 Old 区，Full GC 没发生
  - Cleaner 一直等不到 GC 触发

原因3：ReferenceHandler 线程阻塞
  - jstack 查看 Reference Handler 线程状态
  - 如果是 BLOCKED，可能锁竞争
  - 如果是 RUNNABLE 但 CPU 0%，可能 native 调用阻塞

原因4：DirectByteBuffer 是"虚引用 + Cleaner"模式，必须等 GC 才能进 ReferenceQueue
  - 即使业务代码 obj = null，也只是断开 Strong 引用
  - 不调用 System.gc() 不会立即触发 Cleaner
```

诊断方法：

```bash
# 1. 看 DirectByteBuffer 总数与 Retained Size
jcmd PID GC.class_histogram | grep DirectByteBuffer

# 2. 看 ReferenceHandler 线程状态
jstack PID | grep -A 5 "Reference Handler"

# 3. 手动触发 GC 看是否释放
jcmd PID GC.run

# 4. 看是否是 Netty ByteBuf 池的引用
arthas: vmtool --action getInstances --className io.netty.buffer.PoolArena
```

#### 4.2.5 System.gc() 的作用与 -XX:+DisableExplicitGC 的副作用

System.gc() 的语义："建议 JVM 立即做一次 Full GC"。

- JDK 8 默认行为：触发 Full GC（Serial Full / Parallel Full / G1 Full）
- JDK 9+ 默认行为：触发 Concurrent GC（G1 / ZGC）的并发周期
- -XX:+DisableExplicitGC：让 System.gc() 变成 no-op

`Bits.reserveMemory` 在检测到超额时会主动调用 System.gc()：

```java
// 源码：java.nio.Bits
static void reserveMemory(long size, int cap) {
    if (totalCapacity + size > MAX_MEMORY) {
        System.gc();  // 期望触发 Cleaner
        try {
            Thread.sleep(100);  // 等 ReferenceHandler 处理
        } catch (InterruptedException e) {}
        // 再检查
        if (totalCapacity + size > MAX_MEMORY) {
            throw new OutOfMemoryError("Direct buffer memory");
        }
    }
}
```

`-XX:+DisableExplicitGC` 的副作用：

```text
正面：避免业务代码乱调 System.gc() 导致 STW
负面：Bits.reserveMemory 调 System.gc() 也变成 no-op
     -> Direct Memory 涨到上限直接抛 OOM，不给自己"自救"机会
```

**生产建议**：用 `-XX:+ExplicitGCInvokesConcurrently`（让 System.gc() 触发并发 GC，而不是 STW Full GC），既保留自救机制又降低 STW 影响。

#### 4.2.6 Netty ByteBuf 为什么不用 DirectByteBuffer

Netty 的 PooledByteBufAllocator 自己管理堆外内存，不用 JDK 的 DirectByteBuffer：

```text
原因1：性能
  - JDK DirectByteBuffer 每次创建都 malloc + 清零，性能差
  - Netty 用池化，预分配大块（chunk）后切分，避免反复 malloc

原因2： Cleaner 的"延迟释放"问题
  - JDK DirectByteBuffer 依赖 GC 触发 Cleaner，不可控
  - Netty 用引用计数（refCnt），release 后立即 free

原因3：内存对齐与零拷贝
  - Netty 支持 CompositeByteBuf 多块合并，无需拷贝
  - JDK DirectByteBuffer 不支持

原因4：堆外内存监控
  - Netty 的 PoolArena 内存统计精细（chunk / page / subpage）
  - JDK DirectByteBuffer 只有粗粒度 BufferPool
```

但 Netty 也"借用" JDK 的 Cleaner 机制作为"最终兜底"：

```text
Netty 的 PoolArena 分配的内存：
  - 主路径：refCnt 归零 -> release() -> free()
  - 兜底路径：ByteBuf 对象本身被 GC 时，Cleaner 兜底释放
  - 但 PoolChunk 的内存不是 DirectByteBuffer，是自己用 Unsafe.allocateMemory() 分配
  - Netty 用 PlatformDependent.freeDirectBuffer() 手动释放
```

#### 4.2.7 小结

```text
关键认知 1：DirectByteBuffer 对象在堆内，buffer 在堆外
关键认知 2：Cleaner = PhantomReference + ReferenceQueue + Runnable
关键认知 3：Cleaner 异步触发，依赖 GC + ReferenceHandler 线程
关键认知 4：GC 不发生 = Cleaner 不触发 = 堆外内存不释放
关键认知 5：-XX:+DisableExplicitGC 有副作用，建议用 ExplicitGCInvokesConcurrently
关键认知 6：Netty 用 Unsafe.allocateMemory() + 引用计数，不依赖 Cleaner
```

### 4.3 -XX:MaxDirectMemorySize 的真实含义与"不显式设置时的默认值"

#### 4.3.1 真实含义：限制的是"Bits 计数器"，不是"实际堆外内存"

`-XX:MaxDirectMemorySize` 的真实含义：

```text
表面理解：限制直接内存字节数
实际含义：限制 java.nio.Bits.totalCapacity 计数器

具体：
  - 每次 ByteBuffer.allocateDirect() 调用 Bits.reserveMemory(size, cap)
  - Bits.reserveMemory 检查 totalCapacity + size <= MaxDirectMemorySize
  - 超过则 System.gc() 后再检查，还超则抛 OOM
  - 实际堆外内存由 Unsafe.allocateMemory 分配，由 malloc 管理
```

**关键陷阱**：

```text
1. 不通过 ByteBuffer.allocateDirect() 分配的堆外内存不受此限制
   - Unsafe.allocateMemory() 直接调用，不走 Bits.reserveMemory
   - JNI native 代码 malloc 完全不经过 JVM
   - Netty 池化内存通过反射 / Unsafe 直接分配，部分版本不进入 Bits 计数

2. MaxDirectMemorySize 限制的是"承诺分配"的容量，不是"已使用"的字节
   - DirectByteBuffer 创建时 cap = 1MB，则 Bits.totalCapacity += 1MB
   - 即使实际只用了 100KB，Bits 也按 1MB 计数
```

#### 4.3.2 默认值：等于 -Xmx

不显式设置时，`-XX:MaxDirectMemorySize` 默认等于 `-Xmx`：

```text
JVM 源码：hotspot/share/prims/unsafe.cpp
  if (MaxDirectMemorySize == 0) {
    MAX_MEMORY = (jlong)MaxDirectMemorySize;  // 用户设置
  } else {
    MAX_MEMORY = Universe::heap()->max_capacity();  // 默认 = -Xmx
  }
```

陷阱场景：

```text
Pod limit 6g，JVM 参数 -Xms2g -Xmx4g
未设置 -XX:MaxDirectMemorySize
默认 MaxDirectMemorySize = 4g

实际可用堆外内存 = Pod limit - 堆 - 其他 = 6g - 4g - 1g = 1g
但 JVM 以为有 4g 可用
结果：Direct Memory 涨到 2g 时，Pod 已 OOMKilled（堆 1g + Direct 2g + 其他 1g + JVM 0.5g > 6g - 系统预留）
```

**生产建议**：必须显式设置 -XX:MaxDirectMemorySize，且考虑 Pod limit - 堆 - 其他堆外 = Direct Memory 上限。

#### 4.3.3 与 Netty 的 -Dio.netty.allocator.maxDirectMemory 的关系

Netty 的参数：

```text
-Dio.netty.allocator.maxDirectMemory = 0  -> 默认 = JVM MaxDirectMemorySize
-Dio.netty.allocator.maxDirectMemory = X  -> Netty 自己的限制

Netty 的逻辑：
  - 如果 maxDirectMemory = 0，使用 JVM 的 MaxDirectMemorySize
  - 如果 maxDirectMemory > 0，使用 Netty 自己的限制（不经过 Bits）
```

**关键差异**：

```text
JVM 的 Bits 计数器：覆盖所有 ByteBuffer.allocateDirect()
Netty 的 PoolArena 内存：不走 Bits，走 Netty 自己的计数器

如果业务只用 Netty（不用 JDK DirectByteBuffer）：
  - JVM 的 Bits 计数器始终为 0
  - MaxDirectMemorySize 形同虚设
  - Netty 的 maxDirectMemory 才是真实限制

如果业务混用 Netty + JDK DirectByteBuffer：
  - 两套计数器各自计数
  - 总堆外内存可能超过任一限制
```

**生产建议**：要么全用 Netty（设置 Netty maxDirectMemory，不设 JVM MaxDirectMemorySize），要么全用 JDK DirectByteBuffer（设 JVM MaxDirectMemorySize，不用 Netty 池化）。混用要分别设上限，且总上限要考虑 Pod limit。

#### 4.3.4 为什么"业务没显式调用 ByteBuffer.allocateDirect()"也会涨

很多业务开发者困惑："我代码里没写 ByteBuffer.allocateDirect()，Direct Memory 怎么涨到 1.9g？"

JDK 自身大量使用 DirectByteBuffer：

```text
1. NIO SocketChannel / ServerSocketChannel：
   - 每次 read/write 用临时 DirectByteBuffer
   - JVM 内部维护一个 buffer cache（避免反复创建）

2. GZIP / Deflater / Inflater：
   - java.util.zip.Deflater 用 DirectByteBuffer
   - 解压大数据时分配

3. ImageIO：
   - javax.imageio 的 PNG / JPEG 解码用 DirectByteBuffer

4. CharsetEncoder / CharsetDecoder：
   - String.getBytes("UTF-8") 内部用 DirectByteBuffer

5. JVM 自身：
   - JNI 调用栈
   - Direct ByteBuffer 用于 JNI 参数传递

6. 第三方库：
   - Netty 的 PooledByteBufAllocator 默认分配堆外
   - Kafka 客户端的 NetworkClient
   - gRPC / Protobuf 的 IO
   - Log4j2 的 AsyncLogger
```

诊断方法：

```bash
# 看哪些 DirectByteBuffer 是 JDK 内部分配的
arthas: vmtool --action getInstances --className java.nio.DirectByteBuffer \
        --express 'instances.stream().map(i -> i.toString()).collect(java.util.stream.Collectors.toList())'

# 看 Netty 的 PoolArena 占用
arthas: vmtool --action getInstances --className io.netty.buffer.PoolArena
```

#### 4.3.5 OOM 类型与"能否 catch 后继续"

`java.lang.OutOfMemoryError: Direct buffer memory` 抛出后：

```text
抛出位置：Bits.reserveMemory() 内
抛出条件：System.gc() 后 totalCapacity 仍超 MaxDirectMemorySize

能否 catch：能（继承自 Throwable）
catch 后能否继续：能，但下一次 allocateDirect 还会抛

业务影响：
  - 抛 OOM 的线程会丢失这次分配
  - 业务逻辑可能因 buffer 没拿到而失败
  - 但其他线程不受影响
```

**关键认知**：Direct buffer OOM 不像 Heap OOM 那样"进程必死"。Heap OOM 时 GC 自救失败，进程通常被 JVM 主动 -XX:+HeapDumpOnOutOfMemoryError 后退出；Direct OOM 只是分配失败，进程仍可运行。

但生产中**不要 catch 后继续**——堆外内存已经满了，业务必然大规模失败，应该立即告警 + 重启 Pod。

#### 4.3.6 小结

```text
关键认知 1：MaxDirectMemorySize 限制 Bits.totalCapacity 计数器，不是实际堆外内存
关键认知 2：默认值 = -Xmx，是常见陷阱（Pod limit 不够会 OOMKilled）
关键认知 3：Netty 池化内存不走 Bits，需用 Netty 自己的限制
关键认知 4：JDK 自身大量用 DirectByteBuffer，业务不显式调用也会涨
关键认知 5：Direct OOM 不杀进程，但生产中应立即重启 Pod
关键认知 6：-XX:MaxDirectMemorySize 必须显式设置，公式：Pod limit - 堆 - 其他堆外
```

### 4.4 NMT（Native Memory Tracking）的底层原理与"为什么抓不全"

#### 4.4.1 NMT 的底层原理

NMT 的本质：JVM 把自己的 malloc/free 调用包了一层，记录"调用栈 + 字节数"。

```text
原生 malloc：
  void* p = malloc(size);  // OS 分配，JVM 看不见

NMT 模式：
  void* p = os::malloc(size, flag);  // JVM 的 wrapper
  // 内部：
  //   1. 调用真实 malloc
  //   2. 记录 [调用栈 + 字节数 + flag]
  //   3. 返回指针

  os::free(p);
  // 内部：
  //   1. 查找 p 对应的记录
  //   2. 减少计数
  //   3. 调用真实 free
```

JVM 内部所有 malloc 都走 `os::malloc`，所以 NMT 能跟踪到：

```text
- 堆（Heap，但 NMT 显示的 Heap 不算到 Internal）
- Metaspace（Class 元数据）
- Thread Stack（pthread 分配的栈）
- Code Cache（JIT 编译的代码）
- GC 内部数据结构（Card Table / RSet / Mark Bitmap）
- JVM 自身 C++ 对象（符号表 / 字符串表 / 内部数据结构）
- Direct Memory（部分版本会跟踪）
```

#### 4.4.2 NMT 的 8 大分类

`jcmd PID VM.native_memory summary` 输出：

```text
Total: reserved=5000MB, committed=4200MB
-                 Java Heap (reserved=2048MB, committed=1500MB)
-                     Class (reserved=1080MB, committed=120MB)  <- Metaspace
-                    Thread (reserved=10000MB, committed=1000MB)  <- 线程栈
-                      Code (reserved=245MB, committed=45MB)  <- Code Cache
-                        GC (reserved=500MB, committed=200MB)  <- GC 数据结构
-                  Compiler (reserved=100MB, committed=20MB)  <- JIT 编译器
-                  Internal (reserved=200MB, committed=100MB)  <- JVM 内部
-                    Symbol (reserved=50MB, committed=50MB)  <- 符号表
-    Native Memory Tracking (reserved=50MB, committed=50MB)  <- NMT 自身
-               Shared class space (reserved=0MB, committed=0MB)
-               Arena (reserved=50MB, committed=50MB)  <- C++ Arena
-                   Logging (reserved=10MB, committed=10MB)
-                 Arguments (reserved=10MB, committed=10MB)
-                    Module (reserved=10MB, committed=10MB)
-                 Safepoint (reserved=10MB, committed=10MB)
-                 Synchronization (reserved=10MB, committed=10MB)
```

#### 4.4.3 现象3 根因：为什么 NMT 显示 [Anonymous]

现象3 中 NMT 显示 Internal 内存 1.5g，但 diff 显示 `[Anonymous]` 标记，没有对应的 Java 栈帧。

根因：**NMT 只跟踪 JVM 自己的 os::malloc，第三方 native 库的 malloc 看不见**。

```text
JVM 的 malloc：
  os::malloc() -> NMT 记录 -> 真实 malloc
  NMT 能跟踪

第三方 native 库的 malloc：
  libssl.so 内部直接调用 malloc() -> OS
  JVM 看不见，NMT 抓不到

JNI 代码的 malloc：
  Java 调 native 方法 -> JNI native code 调 malloc()
  NMT 抓不到
```

`[Anonymous]` 标记的含义：NMT 发现这段内存"在 JVM 进程地址空间内，但不在 NMT 跟踪范围"。

可能来源：

```text
1. 第三方 native 库（Netty Native epoll / RocksJava / JNI 调用 libssl）
2. JNI 业务代码（Java 调 C++ 代码的 malloc）
3. JVM 自身的某些 mmap（如 DirectByteBuffer 在某些版本用 mmap 而非 malloc）
4. OS 的 dlopen 加载的共享库 .data / .bss 段
5. JVM 启动时分配的"临时内存"
```

#### 4.4.4 NMT 的 baseline + diff 模式

```bash
# 1. 建立基线
jcmd PID VM.native_memory baseline
# 输出：Baseline created

# 2. 等待一段时间（如 30 分钟），观察增长
jcmd PID VM.native_memory summary.diff

# 输出：
Total: reserved=5000MB +50MB, committed=4200MB +800MB
-                 Java Heap (reserved=2048MB, committed=1500MB +50MB)
-                    Thread (reserved=10000MB, committed=1000MB +0MB)
-                  Internal (reserved=200MB, committed=100MB +750MB)  <- 增长 750MB
                      ...
```

diff 模式比单次 summary 更有诊断价值：

```text
单次 summary：只看当前快照，无法定位"什么时候涨的"
diff 模式：能精确看到 30 分钟内哪一类增长了，定位到"增长源"

实际排查流程：
  1. 发现 RSS 持续增长（top -p PID）
  2. jcmd PID VM.native_memory baseline 建立基线
  3. 等 30 分钟
  4. jcmd PID VM.native_memory summary.diff
  5. 找出"增长最快"的类别
  6. 针对性排查
```

#### 4.4.5 NMT 抓不到的堆外内存怎么排查

当 NMT 显示 `[Anonymous]` 时，需要用系统级工具：

```bash
# 1. pmap 看内存映射
pmap -x PID | sort -k 3 -n -r | head -30
# 输出按"实际占用 RSS"排序，找出最大段

# 2. /proc/PID/smaps 看详细段信息
cat /proc/PID/smaps | grep -A 5 "anon"

# 3. strace 跟踪系统调用
strace -p PID -f -e trace=brk,mmap,munmap -o strace.log

# 4. async-profiler native 模式跟踪 malloc
./profiler.sh -e malloc PID -f malloc.html
./profiler.sh -e free PID -f free.html

# 5. gdb attach 后 dump 内存段（生产慎用，会 STW）
gdb -p PID
(gdb) info proc mappings
(gdb) dump memory /tmp/dump.bin 0x7f0000000000 0x7f0000100000

# 6. lsof 看文件映射
lsof -p PID | grep -i "mem"
```

#### 4.4.6 NMT 自身的开销

```text
-XX:NativeMemoryTracking=off（默认）：无开销
-XX:NativeMemoryTracking=summary：约 1-5% 进程内存开销
  - 记录每个 malloc 的调用栈（默认 4-8 帧）
  - 维护 hash 表
  - 内存开销 = malloc 总量 × 5% 左右
-XX:NativeMemoryTracking=detail：约 5-15% 开销
  - 记录完整调用栈（不限帧数）
  - 用于深度诊断

CPU 开销：
  - 每次 malloc/free 多一次 hash 表操作
  - 约 1-3% CPU 开销

生产建议：
  - 长期开 summary：可接受（5% 内存换 1-3% CPU）
  - 短期开 detail：故障时排查用
  - 不开：故障时只能用 pmap / gdb
```

#### 4.4.7 小结

```text
关键认知 1：NMT 是 JVM malloc wrapper 的"账本"，不是真实内存
关键认知 2：第三方 native 库的 malloc 不走 NMT，显示 [Anonymous]
关键认知 3：baseline + diff 比单次 summary 诊断价值高
关键认知 4：NMT 抓不到的内存用 pmap / smaps / async-profiler native
关键认知 5：summary 模式 5% 开销，detail 模式 15% 开销，生产长期开 summary 可接受
关键认知 6：NMT 不能替代 RSS 监控，两者互补
```

### 4.5 Metaspace 的底层结构与 OOM 排查

#### 4.5.1 Metaspace 的分层结构

Metaspace 不是"一大块内存"，而是分两部分：

```text
Metaspace 总内存（受 -XX:MaxMetaspaceSize 限制）
├── Class Space（Compressed Class Space）
│   - 存放：klass 元数据（C++ 的 Klass 对象）
│   - 受 -XX:CompressedClassSpaceSize 限制（默认 1g）
│   - 启用指针压缩时使用（堆 < 32g）
│   - 不启用指针压缩时（堆 >= 32g），klass 放在 Non-Class Space
│
└── Non-Class Space
    - 存放：method 元数据（ConstMethod）
    - 存放：常量池（ConstantPool）
    - 存放：运行时常量池（ConstantPoolCache）
    - 存放：方法字节码
    - 存放：符号表（Symbol）
    - 存放：annotations
```

为什么这么分？指针压缩的 klass 指针要"连续 32 位寻址"，所以 klass 必须在固定大小的空间内。

#### 4.5.2 Metaspace 的内存来源

Metaspace 的内存来自堆外（malloc + mmap）：

```text
JDK 7 永久代：在堆内（PermGen）
JDK 8+ Metaspace：在堆外（C-Heap / Native Memory）

为什么改：
1. 永久代大小固定，难以调优（-XX:MaxPermSize 调小了 OOM，调大了浪费）
2. 永久代 GC 与 Old GC 耦合，频繁 Full GC
3. 字符串常量池在永久代，导致永久代 OOM 频发
4. 元数据增长难以预测，需要"按需分配"的机制
```

Metaspace 的分配策略：

```text
1. 每个 ClassLoader 维护自己的 Metaspace
2. ClassLoader 加载 Class 时，从自己的 Metaspace 分配
3. ClassLoader 之间的 Metaspace 隔离
4. ClassLoader 被 GC 回收时，其 Metaspace 释放
```

#### 4.5.3 Metaspace 的释放条件

```text
触发条件：ClassLoader 被 GC 回收
  - ClassLoader 没有任何强引用
  - ClassLoader 加载的所有 Class 没有任何强引用

GC 流程：
  1. Class 失去所有引用
  2. ClassLoader 失去所有引用
  3. Full GC（Metaspace 只在 Full GC / Concurrent Cycle 时回收）
  4. ClassLoader 被回收
  5. Metaspace 释放对应内存
```

**关键陷阱**：Metaspace 不会在 Young GC 时回收。如果 ClassLoader 一直在 Old 区，需要 Full GC 才能触发 Metaspace 回收。

#### 4.5.4 Metaspace OOM 的 5 类根因

```text
1. 类加载器泄漏（最常见）
   - 动态生成 Class（CGLIB / Javassist / ByteBuddy）但 ClassLoader 没释放
   - Spring AOP 每次代理生成新 Class
   - Hibernate 动态实体
   - Groovy 脚本动态编译

2. 类加载器爆炸
   - 每次请求 new ClassLoader（如 OSGi 动态加载）
   - 自定义 ClassLoader 没复用
   - JSP 重新编译（每次修改 JSP 重新生成 Class）

3. Spring Boot DevTools 热部署
   - 每次热部署重启 ClassLoader
   - 旧 ClassLoader 没释放（持有引用）
   - 频繁热部署导致 Metaspace 累积

4. JSP 重新编译
   - JSP 改动触发重新编译
   - 编译产物 .class 加载到 Metaspace
   - 旧 .class 不释放

5. Groovy / Jython 动态脚本
   - 每次执行脚本编译为 Class
   - GroovyClassLoader 没释放
   - Metaspace 持续增长
```

#### 4.5.5 -XX:MaxMetaspaceSize 的默认值

```text
JDK 8 默认：无上限（受 OS 内存限制）
JDK 11 默认：无上限（受 OS 内存限制）

为什么默认无上限：
  - 历史原因：永久代有上限（-XX:MaxPermSize），用户调优困难
  - 改为 Metaspace 后，默认不限，避免重蹈覆辙
  - 但生产环境必须显式设置，否则 Metaspace OOM 会"涨到 Pod limit 被 OOMKilled"

生产建议：
  - -XX:MaxMetaspaceSize=256m（小型应用）
  - -XX:MaxMetaspaceSize=512m（中型应用，Spring Boot 单体）
  - -XX:MaxMetaspaceSize=1g（大型应用，微服务 + 大量动态代理）
  - 监控 Metaspace 使用率，超 70% 告警
```

#### 4.5.6 Metaspace OOM 怎么排查

```bash
# 1. 看 Metaspace 使用情况
jstat -gcutil PID 1000
# 输出列：M（Metaspace 使用率），CCSC（Compressed Class Space 使用率）

# 2. NMT 看类别
jcmd PID VM.native_memory summary | grep -A 5 "Class"

# 3. Arthas 看 ClassLoader
arthas: classloader -t  # 树形结构
arthas: classloader -l  # 列表

# 4. jcmd 看类加载统计
jcmd PID GC.class_stats | head -50

# 5. 看是否有"重复加载"的 Class（同名不同 ClassLoader）
jcmd PID GC.class_histogram | grep -E "^\s+\d+\s+\d+\s+\d+\s+.*"

# 6. 看 ClassLoader 数量
arthas: vmtool --action getInstances --className java.lang.ClassLoader | wc -l
```

定位流程：

```text
1. jstat -gcutil 看 M 使用率
2. jcmd GC.class_stats 看哪些 Class 占用大
3. Arthas classloader 看 ClassLoader 数量
4. 找异常 ClassLoader（数量 > 期望 / 重复加载同类）
5. dump 看引用链
6. 业务代码定位（哪个组件创建 ClassLoader）
```

#### 4.5.7 小结

```text
关键认知 1：Metaspace 分 Class Space（klass）和 Non-Class Space（其他元数据）
关键认知 2：Metaspace 在堆外，不在堆内（JDK 8+ 替代永久代）
关键认知 3：Metaspace 释放条件：ClassLoader 被 GC 回收（Full GC 时）
关键认知 4：Metaspace OOM 5 类根因：类加载器泄漏 / 爆炸 / DevTools / JSP / Groovy
关键认知 5：默认无上限，生产必须显式设 -XX:MaxMetaspaceSize
关键认知 6：Metaspace OOM 排查用 jstat + jcmd + Arthas classloader
```

### 4.6 Thread Stack 的内存占用与"线程数爆炸引发的隐式 OOM"

#### 4.6.1 Thread Stack 的内存来源

```text
Java 线程的本质：
  - 每个 Java 线程 = 1 个 OS 线程（1:1 模型，HotSpot 实现）
  - 每个 OS 线程 = pthread_create 创建
  - pthread 分配独立的栈空间（默认 1MB，由 -Xss 控制）

栈空间分配：
  - Linux：pthread 默认 8MB，但 JVM 用 -Xss 覆盖（默认 1MB）
  - Windows：默认 1MB
  - macOS：默认 8MB，JVM 用 -Xss 覆盖为 1MB

栈空间算哪：
  - 不算堆（-Xmx 不管）
  - 算堆外（Native Memory）
  - 算 Pod limit（RSS 内）
  - 算 NMT 的 Thread 类别
```

#### 4.6.2 -Xss 与 -XX:ThreadStackSize 的关系

```text
-Xss512k          : 设置线程栈 512KB
-XX:ThreadStackSize=512  : 同上（单位 KB）

两者是 alias：
  - HotSpot 源码中 ThreadStackSize 接受 KB
  - -Xss 是 -XX:ThreadStackSize 的别名，接受带单位（k/m）

默认值：
  - JDK 8 Linux x64：1MB
  - JDK 11 Linux x64：1MB
  - JDK 17 Linux x64：1MB

生产建议：
  - 普通业务：-Xss512k（够用，节省内存）
  - 深递归业务：-Xss1m（默认值，避免栈溢出）
  - 特殊业务（JSON 解析深度大）：-Xss2m（慎用，会成倍增加内存）
```

#### 4.6.3 现象4 根因：线程数爆炸

现象4 中 1800 个线程 * 1MB = 1.8g 线程栈，是 OOMKilled 的直接原因。

线程数爆炸的常见原因：

```text
1. Tomcat / Jetty 工作线程配置过大
   - server.tomcat.max-threads=2000（误以为越大越好）
   - 实际：每个线程 1MB，2000 线程 = 2GB 线程栈

2. HTTP Client 连接池每个连接一个线程
   - Apache HttpClient 老版本默认每连接一个线程
   - OkHttp 默认连接池 5 个连接，但有 Dispatcher executor

3. 定时任务 / 异步任务滥用 new Thread()
   - 业务代码 new Thread(() -> {...}).start()
   - 没用线程池，每次 new Thread 创建新线程

4. ForkJoinPool 并发度过高
   - parallelStream() 默认用 ForkJoinPool.commonPool
   - 并发度 = CPU 核数，但业务自己 new ForkJoinPool(100)

5. 第三方 SDK 每次调用 new Thread
   - 某些日志库（异步日志）每次 new Thread
   - 某些 RPC 框架（Dubbo 老版本）

6. 线程泄漏
   - 线程池 shutdown 失败
   - 线程死锁（持有锁不释放）
   - 线程 BLOCKED 状态（IO 阻塞 / 锁等待）
```

#### 4.6.4 为什么"没触发 -Xmx 限制却触发 OOMKilled"

```text
-Xmx 控制：堆大小，不管堆外
Pod limit 控制：RSS 总和，包含堆 + 堆外

1800 线程的内存构成：
  - 堆：1.2g（受 -Xmx 4g 限制，远没满）
  - Direct Memory：1.9g（受 -XX:MaxDirectMemorySize 2g 限制，接近满）
  - 线程栈：1.8g（不受 -Xmx 限制，但算 RSS）
  - Metaspace：200m
  - Code Cache：150m
  - JVM 自身：200m
  - 共享库：150m
  - 总 RSS：5.6g（Pod limit 6g，超限 OOMKilled）

OOMKilled 触发条件：
  - RSS > Pod limit
  - K8s cgroup 发送 SIGKILL
  - Pod 被杀，应用直接死（不是 OOM 异常，是进程被杀）

诊断方法：
  - dmesg | grep -i "killed process"  # 看 OOMKiller 日志
  - kubectl describe pod xxx  # 看 Last State
  - /proc/PID/status 的 VmRSS  # 看实时 RSS
```

#### 4.6.5 线程数爆炸的"5 分钟定位法"

```bash
# 1. 看线程总数
jstack PID | grep "java.lang.Thread.State" | wc -l

# 2. 看线程状态分布
jstack PID | grep "java.lang.Thread.State" | awk -F: '{print $2}' | sort | uniq -c
# 输出：
#    500 RUNNABLE
#   1200 BLOCKED
#    100 WAITING

# 3. 看哪个线程组占比大
jstack PID | grep -E "Thread-" | awk -F"\"" '{print $2}' | awk -F"-" '{print $1}' | sort | uniq -c | sort -n -r
# 输出：
#   1200 http-nio-8080-exec
#    500 async-dispatcher
#    100 scheduling-

# 4. 看线程池配置
arthas: getstatic com.example.Config threadPool
arthas: ognl '@java.util.concurrent.ThreadPoolExecutor@getPoolSize()'

# 5. 看锁竞争（BLOCKED 线程）
jstack PID | grep -B 2 "BLOCKED" | head -50
```

#### 4.6.6 线程栈 OOM 的预防

```text
1. 限制线程数
   - Tomcat: server.tomcat.max-threads=200（默认 200，不要乱调）
   - HTTP Client: 用连接池，限制 maxTotal = 50
   - 业务线程池: corePoolSize = N CPU，maxPoolSize = 2*N CPU

2. 降低单线程栈大小
   - -Xss512k（节省一半内存）
   - 深递归业务慎用

3. 监控线程数
   - JMX: java.lang:type=Threading 的 ThreadCount
   - 告警阈值：> 1000 告警，> 2000 严重

4. 线程泄漏检测
   - 每天 dump 一次 jstack，对比线程数
   - 线程数持续增长告警

5. 线程命名规范化
   - 用 ThreadFactory 命名（如 "biz-pool-%d"）
   - 便于排查时快速定位
```

#### 4.6.7 小结

```text
关键认知 1：每个 Java 线程 = 1 个 OS 线程 + 1MB 栈（默认）
关键认知 2：-Xss 是 -XX:ThreadStackSize 的 alias
关键认知 3：线程栈不算 -Xmx，但算 Pod limit
关键认知 4：线程数爆炸是"隐式 OOM"的常见原因
关键认知 5：1800 线程 * 1MB = 1.8g，足够把 Pod 撑爆
关键认知 6：定位用 jstack + grep + awk，5 分钟出结果
关键认知 7：预防靠"限制 maxThreads + 降 -Xss + 监控线程数"
```

### 4.7 Code Cache 的分层结构与"Code Cache 满了引发 JIT 退优化"

#### 4.7.1 Code Cache 的分层结构

Code Cache 是存放 JIT 编译后机器码的内存区域。JDK 8+ 开启分层编译后，Code Cache 分 3 段：

```text
Code Cache（受 -XX:ReservedCodeCacheSize 限制）
├── CodeHeap 'non-profiled' (C2 代码)
│   - 存放：C2 编译的方法（性能最高）
│   - 大小：约 1/3 Code Cache
│
├── CodeHeap 'profiled' (C1 代码)
│   - 存放：C1 编译的方法 + profile 数据
│   - 大小：约 1/3 Code Cache
│
└── CodeHeap 'non-nmethods' (非方法代码)
    - 存放：解释器 / 运行时 stubs / adapter
    - 大小：约 1/3 Code Cache（实际用得少）
```

#### 4.7.2 -XX:ReservedCodeCacheSize 的默认值

```text
JDK 8 默认：48MB（开启分层编译后实际 96MB）
JDK 11 默认：240MB
JDK 17 默认：240MB
JDK 21 默认：240MB

为什么 JDK 11+ 提到 240MB：
  - 分层编译开启后占用更多 Code Cache
  - 大型应用方法数多，48MB 不够
  - 240MB 实测够 99% 应用使用

生产建议：
  - 不显式设置（用默认 240MB）
  - 监控 Code Cache 使用率，超 70% 告警
  - 极端场景（巨型应用 + 反射 / 动态代理）显式设 -XX:ReservedCodeCacheSize=512m
```

#### 4.7.3 Code Cache 满了会发生什么

```text
阶段1：Code Cache 接近满
  - JIT 编译新方法时发现没空间
  - 触发 CodeCache GC（清理未使用的代码）
  - 部分非热点方法被淘汰

阶段2：Code Cache 满
  - JIT 停止编译新方法
  - 所有未编译的方法走解释执行
  - 应用性能下降（解释执行比 C2 慢 5-20 倍）

阶段3：已编译方法"退优化"
  - JIT 内存压力增大，主动退优化部分方法
  - C2 代码退化为 C1 代码（性能下降 2-3 倍）
  - C1 代码退化为解释执行（性能下降 5-20 倍）

阶段4：业务感知
  - CPU 飙高 95%+
  - P99 延迟从 30ms 飙到 1s
  - 业务大规模超时
```

#### 4.7.4 现象：Code Cache 满引发 CPU 飙高的链路

```text
触发条件：
  - 应用方法数 > 10w（巨型应用）
  - 大量反射 / 动态代理（CGLIB / Spring AOP）
  - 分层编译开启 + 编译阈值低
  - Code Cache 设得小（如 -XX:ReservedCodeCacheSize=64m）

现象链路：
  1. 应用启动 30 分钟后，Code Cache 涨到 60MB
  2. JIT 编译新方法失败，部分方法走解释执行
  3. 业务请求 CPU 时间增加 10 倍
  4. CPU 飙高 95%，触发告警
  5. jstack 看线程都在 interpret 状态（没有 JIT 编译版本）
  6. jcmd PID Compiler.codecache 看 Code Cache 已满

诊断：
  jcmd PID Compiler.codecache
  # 输出：
  # CodeHeap 'non-profiled' size=80MB used=78MB (97%)
  # CodeHeap 'profiled' size=80MB used=75MB (93%)
  # CodeHeap 'non-nmethods' size=80MB used=5MB (6%)
  # total_blobs=50000, nmethods=48000, adapters=1900
  # compilation: enabled

  jcmd PID Compiler.queue
  # 输出：编译队列堆积 1000+ 方法
```

#### 4.7.5 Code Cache 满的原因

```text
1. 方法数过多（巨型应用）
   - 微服务架构，一个应用依赖 100+ 第三方库
   - 每个库的方法数 1000+
   - 总方法数 > 10w，Code Cache 不够

2. 反射 / 动态代理生成大量 method
   - Spring AOP 每个切面生成代理类
   - CGLIB 每次代理生成新方法
   - 反射调用 Method.invoke 生成 accessor

3. JIT 编译阈值过低
   - -XX:CompileThreshold=100（默认 10000）
   - 大量方法被判定为"热点"，触发编译
   - Code Cache 撑爆

4. 分层编译开启（默认）
   - TieredCompilation 默认开启
   - 5 层编译：解释 -> C1(无 profile) -> C1(有 profile) -> C1(更多 profile) -> C2
   - 同一方法可能在 Code Cache 中有 4 个版本
   - 占用 4 倍 Code Cache

5. Graal 编译器（JDK 10+）
   - -XX:+UseGraalCompiler 启用 Graal
   - Graal 编译更激进，Code Cache 占用更大
```

#### 4.7.6 Code Cache OOM 的排查与预防

```bash
# 1. 看 Code Cache 使用情况
jcmd PID Compiler.codecache

# 2. 看编译历史
jcmd PID Compiler.perflog

# 3. 打印编译日志
# JVM 参数：-XX:+PrintCompilation
# 输出：每行表示一次编译
#   1234  100 % b   com.example.Foo::bar @ 12 (24 bytes)

# 4. JITWatch 可视化分析
# 下载 JITWatch，加载 PrintCompilation 输出

# 5. Arthas 看 JIT 状态
arthas: dashboard  # 顶部有 CodeCache 信息
```

预防方案：

```text
1. 增大 Code Cache（首选）
   - -XX:ReservedCodeCacheSize=512m（默认 240m 不够时）
   - 极端场景 -XX:ReservedCodeCacheSize=1g

2. 关闭分层编译（不推荐）
   - -XX:-TieredCompilation
   - 只用 C2，Code Cache 占用减半
   - 但启动慢，预热时间长

3. 调高编译阈值
   - -XX:CompileThreshold=10000（默认值，不要降低）
   - 减少被编译的方法数

4. 减少反射 / 动态代理
   - Spring AOP 用 CGLIB 时，缓存代理类
   - 避免每次调用都创建代理

5. 监控 Code Cache 使用率
   - JMX: java.lang:type=MemoryPool name=CodeHeap
   - 告警阈值：> 70% 告警，> 85% 严重
```

#### 4.7.7 小结

```text
关键认知 1：Code Cache 分 3 段（non-profiled / profiled / non-nmethods）
关键认知 2：JDK 11+ 默认 240MB，JDK 8 默认 48MB
关键认知 3：Code Cache 满会引发 JIT 退优化 -> CPU 飙高
关键认知 4：分层编译开启时同一方法有多个版本，占用更多 Code Cache
关键认知 5：排查用 jcmd Compiler.codecache + PrintCompilation
关键认知 6：预防靠"增大 ReservedCodeCacheSize + 减少反射 + 监控"
```

### 4.8 堆外内存排查的完整工具链

#### 4.8.1 JDK 自带工具

```bash
# 1. NMT（最强大，但需 -XX:NativeMemoryTracking=summary）
jcmd PID VM.native_memory summary
jcmd PID VM.native_memory detail
jcmd PID VM.native_memory baseline
jcmd PID VM.native_memory summary.diff

# 2. jcmd 看堆内 + Direct 池
jcmd PID GC.heap_info
# 输出包含：
#  heap = 1500MB
#  ...
#  Direct buffer pool = 1900MB

# 3. jstat 看 Metaspace
jstat -gcutil PID 1000
# 输出列：M（Metaspace），CCSC（Compressed Class Space），CCSU（使用率）

# 4. JMX MBean
# java.nio.BufferPool[name=direct] 的 Count / MemoryUsed / TotalCapacity
# java.lang:type=MemoryPool[name=Metaspace] 的 Used / Committed / Max

# 5. jcmd 看线程数
jcmd PID Thread.print | grep "java.lang.Thread.State" | wc -l
```

#### 4.8.2 Arthas 命令

```bash
# 1. dashboard 看总览
arthas: dashboard
# 顶部显示：线程数 / 直接内存 / Metaspace / Code Cache

# 2. vmtool 直接查 DirectByteBuffer 实例
arthas: vmtool --action getInstances --className java.nio.DirectByteBuffer \
        --express 'instances.size()'
arthas: vmtool --action getInstances --className java.nio.DirectByteBuffer \
        --express 'instances.stream().map(i -> i.capacity()).collect(java.util.stream.Collectors.toList())'

# 3. classloader 看 Metaspace
arthas: classloader -t  # 树形
arthas: classloader -l  # 列表

# 4. profiler native 模式
arthas: profiler start --event alloc
arthas: profiler start --event cpu
# 注：Arthas 的 profiler 主要走 async-profiler

# 5. heapdump 看 DirectByteBuffer
arthas: heapdump --live /tmp/heap.bin
# 然后用 MAT 分析 DirectByteBuffer 实例
```

#### 4.8.3 系统级工具

```bash
# 1. top 看 RSS
top -p PID
# 看 RES 列（实际物理内存）

# 2. pmap 看内存映射
pmap -x PID | sort -k 3 -n -r | head -30
# 按 RSS 排序，找最大段

# 3. /proc/PID/status
cat /proc/PID/status | grep -E "VmRSS|VmSize|Threads|VmHWM"
# VmRSS：当前物理内存
# VmHWM：历史最高物理内存
# Threads：线程数

# 4. /proc/PID/smaps
cat /proc/PID/smaps | grep -A 5 "anon"
# 按段统计

# 5. lsof 看文件映射
lsof -p PID | grep -E "mem|REG"

# 6. strace 跟踪系统调用（生产慎用，开销大）
strace -p PID -f -e trace=brk,mmap,munmap -o strace.log

# 7. gdb（生产慎用，会 STW）
gdb -p PID
(gdb) info proc mappings
```

#### 4.8.4 async-profiler native 模式

async-profiler 是排查堆外内存的"杀手锏"：

```bash
# 1. 跟踪 malloc 调用
./profiler.sh -e malloc PID -f malloc.html
# 采样所有 malloc 调用，生成火焰图

# 2. 跟踪 free 调用
./profiler.sh -e free PID -f free.html
# 采样所有 free 调用

# 3. 组合分析
# malloc 火焰图 - free 火焰图 = 未释放的内存调用栈

# 4. 跟踪特定库
./profiler.sh -e malloc --lib libnet.so PID -f netty.html

# 5. 持续采样
./profiler.sh -e malloc PID -d 600 -f malloc-10min.html
```

**实战场景**：NMT 显示 `[Anonymous]` 1.5g，用 async-profiler malloc 模式采样 10 分钟，火焰图显示 `Netty PoolArena.allocate()` 占 80%。

#### 4.8.5 大堆外内存 dump 怎么处理

堆外内存无法像堆内一样 dump，需要特殊方法：

```bash
# 1. NMT detail 模式
jcmd PID VM.native_memory.detail > nmt-detail.txt
# 文件包含所有 NMT 跟踪的内存段

# 2. async-profiler native 火焰图
./profiler.sh -e malloc PID -d 300 -f native.html
# 5 分钟采样，火焰图定位调用栈

# 3. pmap + grep 找最大段
pmap -x PID | awk '$3 > 100000 {print}' | sort -k 3 -n -r
# 找出 > 100MB 的内存段

# 4. gdb dump 特定段
gdb -p PID
(gdb) info proc mappings
# 找到要 dump 的段地址
(gdb) dump memory /tmp/dump.bin 0x7f0000000000 0x7f0000100000

# 5. strings 看段内容
strings /tmp/dump.bin | head -100
# 看 strings 内容判断是什么类型的数据
```

#### 4.8.6 K8s 容器内排查

```bash
# 1. kubectl exec 进入 Pod
kubectl exec -it pod-name -- bash

# 2. JVM 自身工具
jcmd PID VM.native_memory summary
# JVM 工具无需 hostpid，无需 privileged

# 3. 系统级工具（pmap / gdb）需要 privileged 容器
# 在 Pod spec 加：
#   securityContext:
#     privileged: true
# 或：
#   spec:
#     containers:
#       - name: app
#         securityContext:
#           capabilities:
#             add: ["SYS_PTRACE"]

# 4. 用 sidecar 模式部署诊断容器
# 主容器跑业务，sidecar 跑 pmap / gdb 工具
# 共享 PID namespace

# 5. Pod limit 是"硬限制"，超过会被 OOMKilled
# 排查时先用 kubectl describe pod 看是否被 OOMKilled
kubectl describe pod pod-name | grep -A 5 "Last State"
```

#### 4.8.7 排查工具链选型矩阵

| 场景 | 首选工具 | 备选工具 | 注意事项 |
|------|----------|----------|----------|
| Direct Memory 涨 | NMT + JMX BufferPool | Arthas vmtool | NMT summary 模式即可 |
| Metaspace OOM | jstat + Arthas classloader | jcmd GC.class_stats | 重点看 ClassLoader 数量 |
| Thread Stack 涨 | jstack + top -H | jcmd Thread.print | 看线程数 + 状态分布 |
| Code Cache 满 | jcmd Compiler.codecache | -XX:+PrintCompilation | JDK 11+ 默认 240m 够用 |
| Native 内存涨 | NMT diff + async-profiler native | pmap / smaps | NMT 抓不到的用 async-profiler |
| OOMKilled | kubectl describe + dmesg | /proc/PID/status | 看 RSS 是否超 Pod limit |

#### 4.8.8 小结

```text
关键认知 1：JDK 自带工具（jcmd / jstat / JMX）能覆盖 60% 场景
关键认知 2：Arthas vmtool 直接查对象实例，定位 DirectByteBuffer
关键认知 3：系统级工具（pmap / smaps）看真实内存映射
关键认知 4：async-profiler native 模式是排查"匿名堆外内存"的杀手锏
关键认知 5：K8s 容器内 JVM 工具可用，系统级工具需 privileged
关键认知 6：NMT + async-profiler + pmap 三件套，覆盖 95% 堆外内存排查
```

---

## 五、四防闭环设计与替代方案

### 5.1 四防闭环设计

```text
一防：监控防（看见堆外内存）
  1. NMT 长期开 summary（5% 开销可接受）
  2. JMX 监控：
     - java.nio.BufferPool[name=direct] 的 MemoryUsed
     - java.lang:type=MemoryPool[name=Metaspace] 的 Used
     - java.lang:type=Threading 的 ThreadCount
  3. 业务监控：
     - Netty PoolArena 的 chunk 数 / page 数
     - 业务线程池的 active / poolSize
  4. 系统监控：
     - Pod RSS（top / /proc/PID/status）
     - K8s OOMKiller 计数
  5. 告警阈值：
     - Direct Memory > 80% MaxDirectMemorySize
     - Metaspace > 70% MaxMetaspaceSize
     - Thread Count > 1000
     - RSS > 90% Pod limit

二防：限流防（控制堆外内存上限）
  1. JVM 参数：
     - -XX:MaxDirectMemorySize 显式设置（不要用默认 = -Xmx）
     - -XX:MaxMetaspaceSize=512m（不要无上限）
     - -XX:ReservedCodeCacheSize=240m（默认即可）
     - -XX:ThreadStackSize=512k（节省一半栈内存）
  2. Netty 参数：
     - -Dio.netty.allocator.maxDirectMemory=1073741824（1g）
     - -Dio.netty.allocator.numDirectMemoryArenas=4
  3. 业务参数：
     - Tomcat max-threads=200（不要乱调大）
     - HTTP Client maxTotal=50
     - 业务线程池 corePoolSize = N CPU

三防：告警防（提前预警）
  1. 实时告警：
     - Direct Memory 5 分钟内涨 200MB
     - Metaspace 1 小时内涨 100MB
     - Thread Count 5 分钟内涨 200
  2. 趋势告警：
     - Direct Memory 持续 24 小时增长不下降（泄漏嫌疑）
     - Metaspace 持续 7 天增长（动态 Class 加载）
  3. 容量告警：
     - RSS > 80% Pod limit（预警，距 OOMKilled 还有 20% 空间）
     - RSS > 90% Pod limit（紧急，立即扩容或重启）

四防：演练防（验证应急能力）
  1. 每月一次堆外内存故障演练：
     - 注入 DirectByteBuffer 泄漏（业务代码不停分配不释放）
     - 注入线程数爆炸（不停 new Thread）
     - 注入类加载器泄漏（不停 new ClassLoader）
  2. 演练目标：
     - 5 分钟内识别堆外内存故障（不是堆 OOM）
     - 10 分钟内定位到具体堆外区域（Direct / Metaspace / Stack / Code Cache）
     - 15 分钟内止血（扩容 / 限流 / 重启）
  3. 演练记录：
     - 演练前 NMT baseline
     - 演练后 NMT diff
     - 验证告警是否触发
     - 验证应急预案是否生效
```

### 5.2 替代方案

#### 5.2.1 Direct Memory 替代方案

```text
方案1：Netty 池化 ByteBuf（推荐）
  - 用 PooledByteBufAllocator.DEFAULT
  - 引用计数管理，release 后立即释放
  - 不依赖 GC / Cleaner
  - 监控：PoolArena 的 chunk 数 / page 数

方案2：堆内 ByteBuffer（保守）
  - 用 ByteBuffer.allocate() 而非 allocateDirect()
  - 受 GC 管理，无堆外内存风险
  - 性能稍差（多一次拷贝）
  - 适合小数据量场景

方案3：Netty ByteBuf 堆内版本
  - UnpooledHeapByteBuf / PooledHeapByteBuf
  - 与 JDK ByteBuffer.allocate 等价
  - Netty API 一致，迁移成本低

方案4：Off-Heap 池化库
  - 用 Chronicle Bytes / Agrona DirectBuffer
  - 更精细的池化管理
  - 适合低延迟场景
```

#### 5.2.2 MappedByteBuffer 替代方案

```text
方案1：Netty FileRegion（推荐）
  - 用 NIO FileChannel.transferTo 实现零拷贝
  - 不需要 MappedByteBuffer
  - 适合文件传输场景

方案2：堆内 byte[]
  - 小文件直接读入 byte[]
  - 受 GC 管理
  - 性能不如 mmap，但可控

方案3：RocksJava
  - RocksDB 的 Java 绑定
  - 用 mmap + 引用计数管理
  - 适合大数据存储
```

#### 5.2.3 JNI Memory 替代方案

```text
方案1：避免 JNI（首选）
  - 用纯 Java 实现等价功能
  - 例如：用 BouncyCastle 替代 OpenSSL JNI

方案2：JNI 引用计数管理
  - 全局引用表（GlobalRef）跟踪每个 JNI 分配
  - 业务代码显式 free
  - 监控 GlobalRef 数量

方案3：JNA / JNR-FFI
  - 用 JNA 自动管理 native 内存
  - 性能稍差但更安全
  - 适合不需要极致性能的场景
```

#### 5.2.4 Metaspace 替代方案

```text
方案1：避免动态生成 Class
  - 用静态代理代替 CGLIB
  - 缓存代理类（Spring AOP 默认缓存）
  - Groovy 脚本预编译

方案2：复用 ClassLoader
  - 自定义 ClassLoader 时复用实例
  - 不要每次请求 new ClassLoader
  - 用 OSGi 时合理管理 Bundle 生命周期

方案3：JDK 11+ 的 -XX:MetaspaceReclaimPolicy
  - balanced（默认）：平衡回收与性能
  - aggressive：激进回收，适合动态 Class 多
  - full：完全关闭 Metaspace 回收（不推荐）
```

#### 5.2.5 Thread Stack 替代方案

```text
方案1：降低 -Xss
  - -Xss512k（默认 1MB，节省一半）
  - 普通业务够用
  - 深递归业务慎用

方案2：限制线程数
  - Tomcat max-threads=200
  - HTTP Client 用连接池，maxTotal=50
  - 业务用线程池，corePoolSize = N CPU

方案3：虚拟线程（JDK 21+）
  - Thread.ofVirtual() 创建虚拟线程
  - 虚拟线程栈在堆内（不是堆外）
  - 单 Pod 可承载 10w+ 虚拟线程
  - 适合高并发 IO 场景

方案4：异步化
  - 用 CompletableFuture / Reactor
  - 减少线程数
  - 提升单线程吞吐
```

#### 5.2.6 Code Cache 替代方案

```text
方案1：增大 Code Cache（首选）
  - -XX:ReservedCodeCacheSize=512m
  - 适合方法数多的应用

方案2：减少反射 / 动态代理
  - Spring AOP 用 CGLIB 时缓存代理类
  - 用接口编程代替反射
  - 避免每次调用 Method.invoke

方案3：AOT 编译（JDK 17+）
  - jaotc 提前编译为机器码
  - 不占用 Code Cache
  - 适合启动慢的应用

方案4：GraalVM Native Image
  - 编译为原生可执行文件
  - 完全脱离 JVM
  - 启动快，但失去 JIT 优化
  - 适合 Serverless / CLI 场景
```

### 5.3 生产配置模板

针对在线问诊系统 4 个核心服务的堆外内存配置模板：

#### 5.3.1 IM 网关（10w 长连接）

```bash
# Pod limit 6g
-Xms2g -Xmx2g                              # 堆
-XX:MaxDirectMemorySize=2g                  # Direct Memory（Netty ByteBuf）
-XX:MaxMetaspaceSize=256m                   # Metaspace
-XX:ReservedCodeCacheSize=240m              # Code Cache（默认）
-XX:ThreadStackSize=512k                    # 线程栈（降一半）
-XX:NativeMemoryTracking=summary            # NMT summary 模式

# Netty 参数
-Dio.netty.allocator.maxDirectMemory=2147483648
-Dio.netty.allocator.numDirectMemoryArenas=4
-Dio.netty.noPreferDirect=false             # 优先堆外（性能）

# GC 参数
-XX:+UseG1GC
-XX:MaxGCPauseMillis=50

# 内存预算
# 堆 2g + Direct 2g + Metaspace 256m + Code Cache 240m +
# Thread Stack 1g（2000 线程 * 512k）+ JVM 自身 300m + 共享库 200m = 6g（Pod limit）
```

#### 5.3.2 视频问诊 SFU（高吞吐）

```bash
# Pod limit 8g
-Xms3g -Xmx3g                              # 堆（视频包缓存大）
-XX:MaxDirectMemorySize=3g                  # Direct Memory（RTP 包缓冲）
-XX:MaxMetaspaceSize=256m
-XX:ReservedCodeCacheSize=240m
-XX:ThreadStackSize=512k
-XX:NativeMemoryTracking=summary

# 内存预算
# 堆 3g + Direct 3g + 其他 1g = 7g（Pod limit 8g，留 1g 余量）
```

#### 5.3.3 监管上报服务（高频 Kafka 消费）

```bash
# Pod limit 4g
-Xms1.5g -Xmx1.5g                          # 堆（监管报文缓存）
-XX:MaxDirectMemorySize=1g                  # Direct Memory（Kafka Client）
-XX:MaxMetaspaceSize=256m
-XX:ReservedCodeCacheSize=240m
-XX:ThreadStackSize=512k
-XX:NativeMemoryTracking=summary

# 内存预算
# 堆 1.5g + Direct 1g + 其他 1g = 3.5g（Pod limit 4g）
```

#### 5.3.4 消息存档服务（大文件存储）

```bash
# Pod limit 8g
-Xms2g -Xmx2g                              # 堆（不大，存档业务轻量）
-XX:MaxDirectMemorySize=1g                  # Direct Memory（不需要大）
-XX:MaxMetaspaceSize=256m
-XX:ReservedCodeCacheSize=240m
-XX:ThreadStackSize=512k
-XX:NativeMemoryTracking=summary

# 大文件用 MappedByteBuffer 而非堆内
# 监控 MappedByteBuffer 总量（NMT Internal）
```

---

## 六、能力差距提示

### 6.1 堆外内存 6 大区域的体系化认知不足

- **现状**：知道 Direct Memory / Metaspace / Thread Stack，但 6 大区域的"完整边界 + JVM 参数 + 默认值 + 监控方式"成体系输出困难；Code Cache / MappedByteBuffer / JNI Memory 的细节模糊
- **架构师水平**：能不查文档直接写出 6 大区域的"参数 + 默认值 + 监控方式 + 释放机制"矩阵；能在容量规划阶段精确预算 Pod limit = 堆 + 6 大堆外 + JVM 自身
- **补足方向**：精读 JEP 254（Compact Strings）/ JEP 280（Indify String Concatenation）；阅读 OpenJDK `metaspace.cpp` / `codeCache.cpp` 源码；为在线问诊系统设计"Pod 内存预算模板"

### 6.2 Direct ByteBuffer 的 Cleaner 机制底层不深

- **现状**：知道 PhantomReference + ReferenceQueue + Cleaner，但 Cleaner 的"触发时机 / ReferenceHandler 线程 / GC 与 Cleaner 协同"链条模糊；"为什么 DirectByteBuffer 没被 GC 回收"的 4 类原因没成体系
- **架构师水平**：能画出 Cleaner 触发的完整时序图（GC -> ReferenceQueue -> ReferenceHandler -> Cleaner.clean -> Deallocator.run -> Unsafe.freeMemory）；能 5 分钟内定位"Direct Memory 不释放"的根因
- **补足方向**：阅读 OpenJDK `reference.cpp` / `cleaner.cpp` 源码；在测试环境复现"Direct Memory 涨但堆没涨"场景；调研 Netty 的引用计数 vs JDK Cleaner 的对比

### 6.3 -XX:MaxDirectMemorySize 的"默认 = -Xmx"陷阱不熟

- **现状**：知道这个参数，但"不显式设置默认 = -Xmx"的陷阱没意识到；"Netty maxDirectMemory 与 JVM MaxDirectMemorySize 谁优先"的细节模糊；"JDK 自身大量用 DirectByteBuffer"导致业务没显式调用也涨的原因不熟
- **架构师水平**：能在 JVM 参数评审时一眼看出"没设 MaxDirectMemorySize"的陷阱；能根据 Pod limit 反推 MaxDirectMemorySize 应该设多少；能区分 Netty 池化内存与 JDK DirectByteBuffer 的计数器
- **补足方向**：精读 OpenJDK `bits.cpp` 的 reserveMemory 源码；调研 5 个主流框架（Netty / Kafka / gRPC / Log4j2 / Spring）的 Direct Memory 使用情况

### 6.4 NMT 的"抓不到 JNI / 第三方 native"局限不深

- **现状**：知道 NMT 是堆外内存排查工具，但"NMT 只跟踪 JVM 自己的 malloc"的本质不深；"NMT 显示 [Anonymous]"的含义 / "为什么 diff 比单次 summary 更有诊断价值"模糊；async-profiler native 模式作为 NMT 补充的使用经验不足
- **架构师水平**：能讲清 NMT 的底层（os::malloc wrapper + 调用栈记录 + hash 表）；能在 NMT 抓不到时立即切到 async-profiler native + pmap + smaps；能为团队制定"NMT summary 长期开 + detail 故障时开"的策略
- **补足方向**：阅读 OpenJDK `nmt.cpp` / `memTracker.cpp` 源码；实测 async-profiler native 模式在 IM 网关的火焰图；调研 5 个 JNI 库（Netty Native / RocksJava / JNI SSL / JNA / JNR-FFI）的内存管理

### 6.5 Metaspace 的 Class Space vs Non-Class Space 边界模糊

- **现状**：知道 Metaspace 替代永久代，但"Class Space（klass）/ Non-Class Space（其他元数据）"的分层模糊；"Metaspace OOM 5 类根因"成体系输出困难；"Metaspace 默认无上限"的陷阱没意识到
- **架构师水平**：能讲清 Metaspace 的分层结构 + 内存来源 + 释放条件；能 5 分钟内定位 Metaspace OOM 的根因（类加载器泄漏 / 爆炸 / DevTools / JSP / Groovy）；能制定团队的 -XX:MaxMetaspaceSize 标准化模板
- **补足方向**：阅读 OpenJDK `metaspace.cpp` 源码；调研 Spring Boot DevTools / Groovy / JSP 在生产环境的 ClassLoader 管理最佳实践；实测 Arthas classloader 命令在大型应用的使用

### 6.6 Thread Stack 的"线程数爆炸 -> 隐式 OOM"链路不深

- **现状**：知道 -Xss 控制线程栈大小，但"线程栈不算 -Xmx 但算 Pod limit"的边界不深；"1800 线程 * 1MB = 1.8g 线程栈 -> OOMKilled"的链路没成体系；"线程数爆炸的 6 类原因"模糊
- **架构师水平**：能在容量规划阶段精确预算 Thread Stack 占用 = 线程数 × -Xss；能 5 分钟内用 jstack + grep + awk 定位线程数爆炸根因；能为团队制定"Tomcat max-threads + HTTP Client maxTotal + 业务线程池"的标准化配置
- **补足方向**：调研 5 个高并发应用的线程池配置；实测 -Xss512k vs 1m 在深递归业务的性能差异；调研 JDK 21 虚拟线程在 IM 网关的可行性

### 6.7 Code Cache 满引发 JIT 退优化的链路不熟

- **现状**：知道 Code Cache 是 JIT 编译的机器码存储，但"分层编译 + Code Cache 分段 + JIT 退优化"链路模糊；"Code Cache 满了 -> JIT 停止 -> 退优化 -> CPU 飙高"的现象链不熟
- **架构师水平**：能讲清 Code Cache 的 3 段结构（non-profiled / profiled / non-nmethods）；能 5 分钟内用 jcmd Compiler.codecache 定位 Code Cache 是否满；能区分"分层编译占用多 vs 反射 / 动态代理生成大量 method"的根因
- **补足方向**：阅读 OpenJDK `codeCache.cpp` / `compileBroker.cpp` 源码；实测 JITWatch 在大型应用的火焰图；调研 GraalVM Native Image 在 Serverless 场景的可行性

### 6.8 堆外内存排查工具链的"组合使用"经验不足

- **现状**：知道 NMT / jcmd / Arthas / async-profiler / pmap 各自用法，但"NMT 抓不到的切 async-profiler native / async-profiler 抓不到的切 pmap + gdb"的组合策略不熟；K8s 容器内系统级工具需要的 privileged 配置不熟
- **架构师水平**：能为团队制定"堆外内存排查 SOP"（NMT summary -> NMT diff -> async-profiler native -> pmap -> gdb）；能在 K8s 集群部署 sidecar 诊断容器；能为不同故障类型（Direct / Metaspace / Stack / Code Cache / Native）选对应工具链
- **补足方向**：整理团队堆外内存排查 SOP；调研 5 家大厂（阿里 / 美团 / 字节 / Netflix / LinkedIn）的堆外内存排查实践；实测在 K8s privileged 容器内使用 pmap / gdb

### 6.9 堆外内存的"四防闭环"设计经验不足

- **现状**：能调单次故障，但"监控防 + 限流防 + 告警防 + 演练防"成体系输出困难；"每月堆外内存故障演练"的实践经验为零；不同堆外区域（Direct / Metaspace / Stack / Code Cache）的告警阈值不成体系
- **架构师水平**：能为团队设计堆外内存"四防闭环"方案；能制定标准化的告警阈值（Direct 80% / Metaspace 70% / Thread 1000 / RSS 90%）；能组织月度故障演练
- **补足方向**：调研 Chaos Engineering 在 JVM 堆外内存的实践；在测试环境复现 5 类堆外内存故障（Direct 泄漏 / Metaspace 爆炸 / 线程爆炸 / Code Cache 满 / Native 泄漏）

### 6.10 与简历项目（在线问诊系统）的"二次复发"防御经验不足

- **现状**：Day05 案例一已修复 IM 网关 ByteBuf OOM，但"修复后 30 天二次复发"的防御经验为零；"第一次故障根因 vs 二次复发根因"的差异分析能力不足
- **架构师水平**：能为简历项目设计"二次复发防御"方案（修复后立即设计监控 + 演练 + 替代方案）；能在面试时讲清"Day05 案例一修复后 30 天，又发生了一次不同根因的故障，我是如何从底层原理反推根因的"
- **补足方向**：为简历项目补充"二次复发"案例（基于本 Day07 的 4 个现象）；在面试预演时练习"两次故障根因对比"的讲法；调研业界"二次复发"的经典案例（如 Netflix 2012 年的 Direct Memory 泄漏 -> 2015 年的 Metaspace 泄漏）

---

## 七、Day07 与本周知识点闭环

```text
Day01 JVM 调优参数全解
  - -XX:MaxDirectMemorySize / MaxMetaspaceSize / ReservedCodeCacheSize / ThreadStackSize
  - Day07 深挖：这 4 个参数背后的堆外区域是哪 4 个？默认值陷阱是什么？
  - 闭环：Day01 讲参数，Day07 讲"参数背后的机制"

Day02 JVM 诊断工具链实战
  - jcmd VM.native_memory / jstat -gc / Arthas vmtool
  - Day07 深挖：NMT 的底层原理 / 为什么抓不到 JNI / async-profiler native 模式
  - 闭环：Day02 讲工具用法，Day07 讲"工具背后的原理 + 抓不到时的替代方案"

Day03 OOM 排查实战
  - 8 种 OOM 类型，其中 Direct buffer memory / Metaspace / Unable to create new native thread
  - Day07 深挖：Direct OOM 与 Cleaner 机制 / Metaspace OOM 与 ClassLoader / Thread OOM 与栈
  - 闭环：Day03 讲"OOM 怎么排查"，Day07 讲"OOM 背后的堆外机制"

Day04 CPU 飙高排查实战
  - JIT 退优化 / Safepoint 引发 CPU 飙高
  - Day07 深挖：Code Cache 满 -> JIT 退优化 -> CPU 飙高的链路
  - 闭环：Day04 讲"JIT 退优化现象"，Day07 讲"Code Cache 满的根本原因"

Day05 在线问诊系统 JVM 实战
  - 案例一 IM 网关 ByteBuf OOM 排查
  - Day07 深挖：修复后 30 天二次复发的根因 + 4 个现象
  - 闭环：Day05 讲"第一次故障排查"，Day07 讲"二次复发防御 + 底层原理"

Day06 串联整合 - 完整 JVM 故障复盘
  - 5 分钟止血 / 1 小时根因 / 24 小时修复 / 1 周预防体系
  - Day07 深挖：堆外内存"四防闭环"是"1 周预防体系"的具体落地
  - 闭环：Day06 讲"故障复盘方法论"，Day07 讲"堆外内存具体预防方案"

07月第5周 Day07 G1GC 底层原理与生产事故反推
  - G1 GC 的 Region / RSet / SATB / Mixed GC / Humongous
  - Day07 深挖：GC 不回收堆外内存，本 Day07 是 G1GC 深挖的"互补"
  - 闭环：上周讲"GC 回收堆内"，本周讲"堆外怎么管理"
```

---

## 八、今日能力差距汇总（10 项）

```text
差距 7.1：堆外内存 6 大区域的体系化认知不足
差距 7.2：Direct ByteBuffer 的 Cleaner 机制底层不深
差距 7.3：-XX:MaxDirectMemorySize 的"默认 = -Xmx"陷阱不熟
差距 7.4：NMT 的"抓不到 JNI / 第三方 native"局限不深
差距 7.5：Metaspace 的 Class Space vs Non-Class Space 边界模糊
差距 7.6：Thread Stack 的"线程数爆炸 -> 隐式 OOM"链路不深
差距 7.7：Code Cache 满引发 JIT 退优化的链路不熟
差距 7.8：堆外内存排查工具链的"组合使用"经验不足
差距 7.9：堆外内存的"四防闭环"设计经验不足
差距 7.10：与简历项目（在线问诊系统）的"二次复发"防御经验不足
```

本周累计新增差距：Day01 7 + Day02 10 + Day03 8 + Day04 9 + Day05 8 + Day06 8 + Day07 10 = **60 项**

累计差距：截至第5周末 117+ 项 + 本周 60 项 = **177+ 项**

---

## 九、Day07 与简历项目（在线问诊系统）的强结合

```text
简历项目核心模块（截至 2026年07月第4周）：
- 简历项目-在线问诊系统-架构文档.md
- 简历项目-在线问诊系统-技术亮点与难点拆解.md
- 简历项目-在线问诊系统-面试问答预演.md
- 简历项目-在线问诊系统-JVM调优案例.md（5 个 STAR 故障故事）
- 简历项目-在线问诊系统-核心模块-医保对接.md
- 简历项目-在线问诊系统-核心模块-处方开具.md

本 Day07 可补充：
- 简历项目-在线问诊系统-JVM 调优案例.md 增补"案例六：IM 网关二次复发 - 堆外内存 6 大区域"
- 面试问答预演增补"Q：你的 IM 网关 ByteBuf OOM 修复后，30 天后二次复发，根因是什么？"
- 技术亮点与难点拆解增补"堆外内存 6 大区域的体系化监控方案"

面试加分点：
- 能讲清"GC 不回收堆外内存，Cleaner 是间接机制"
- 能讲清"MaxDirectMemorySize 默认 = -Xmx 的陷阱"
- 能讲清"NMT 抓不到 JNI 的局限 + async-profiler native 补充"
- 能讲清"1800 线程 * 1MB = 1.8g 线程栈 -> OOMKilled 的链路"
- 能讲清"Code Cache 满 -> JIT 退优化 -> CPU 飙高的链路"
- 能讲清"四防闭环：监控 / 限流 / 告警 / 演练"

面试讲故事模板：
"Day05 我讲过的 IM 网关 ByteBuf OOM 是第一次故障，根因是业务代码 Bug。
但修复后第 31 天，又发生了二次复发。这次根因完全不同——
不是业务代码 Bug，而是 JVM 堆外内存的 6 大区域中的'线程栈 + Direct Memory'
同时涨满，触发 OOMKilled。
我从 NMT diff 看到 Internal 内存 1.5g 但显示 [Anonymous]，
意识到是 JNI / 第三方 native 库的 malloc，NMT 抓不到。
切换到 async-profiler native 模式，10 分钟火焰图显示是 Netty PoolArena
分配未释放。最终用'四防闭环'方案防御：
1. 监控防：NMT summary 长期开 + JMX BufferPool
2. 限流防：MaxDirectMemorySize + Netty maxDirectMemory 双限制
3. 告警防：Direct > 80% / Metaspace > 70% / RSS > 90%
4. 演练防：每月一次堆外内存故障演练
这次二次复发让我意识到：第一次故障排查只看了'冰山一角'，
没有从底层原理深挖堆外内存 6 大区域，必然会有'二次复发'。"
```

---

## 十、本日总结

Day07 深挖日完成了 JVM 堆外内存底层原理的体系化梳理：

```text
1. 堆外内存 6 大区域：Direct / Mapped / JNI / Metaspace / Thread Stack / Code Cache
2. Direct ByteBuffer 生命周期：allocateDirect -> Cleaner -> Deallocator -> freeMemory
3. -XX:MaxDirectMemorySize 陷阱：默认 = -Xmx，必须显式设置
4. NMT 局限：只跟踪 JVM 自己的 malloc，第三方 native / JNI 抓不到
5. Metaspace 底层：Class Space + Non-Class Space，ClassLoader GC 时释放
6. Thread Stack 隐式 OOM：线程数 * 1MB 涨到 Pod limit 触发 OOMKilled
7. Code Cache 满：JIT 退优化 -> CPU 飙高的链路
8. 堆外内存排查工具链：NMT + async-profiler native + pmap 三件套
9. 四防闭环：监控防 / 限流防 / 告警防 / 演练防
10. 与简历项目强结合：Day05 案例一"二次复发"防御方案

核心认知：
- GC 只回收堆内，堆外内存各管各的
- -Xmx 不等于 Pod limit，必须考虑 6 大堆外区域
- NMT 是"账本"，不是"真实内存"，第三方 native 看不见
- 堆外内存是"隐式 OOM"的温床——不抛 OOM 但 RSS 涨到 Pod limit 被 OOMKilled
- 架构师必须能从"6 大区域 + 4 防闭环"体系化设计堆外内存管理

与上周 Day07（G1GC 底层原理）互补：
- GC 是"堆内回收"维度，本周是"堆外管理"维度
- 两者合一构成 JVM 内存的"完整图景"
```

JVM 专题第 2 周完成。本周（08月第1周）Day01-Day07 完整覆盖了 JVM 调优实战与生产排查的 6 大支柱 + 1 个架构深挖，与简历项目（在线问诊系统）深度结合，形成可复用的故障排查 SOP + 四防闭环方案。
