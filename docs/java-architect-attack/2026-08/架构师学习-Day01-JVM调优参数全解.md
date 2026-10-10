# 架构师学习-Day01-JVM 调优参数全解

> 日期：2026年08月03日（周一）
> 周主题：JVM 专题第 2 周 - 调优实战与生产排查
> 出题日：Day01 - JVM 调优参数全解

---

## 背景

经过 12 周专题训练（CAP/MQ/微服务/MySQL/Redis/ES/限流降级/支付/医疗×2/K8s + 1 周简历项目打磨 + JVM 第 1 周基础与核心），本周（2026年08月第1周）进入 **JVM 专题第 2 周 - 调优实战与生产排查**。

第 1 周建立了 JVM 五大支柱的知识体系：内存模型 / GC 算法 / GC 收集器 / 类加载 / JIT 编译。但**知道理论与能调优生产**之间还差一层——参数级别的工程经验。架构师面试官最爱问的不是"GC 算法有哪些"，而是：

> "你这套服务线上用的什么 GC？堆多大？为什么？参数怎么调的？调完前后量化对比？"

这些问题答不出来，第 1 周的理论就白学了。本周 Day01 把所有调优参数一次性梳理清楚，Day02 进入工具链，Day03-04 是 OOM 与 CPU 飙高排查，Day05 落到在线问诊系统实战，Day06 串联故障复盘，Day07 深挖 ZGC。

**Day01 为什么是"参数全解"而不是"工具链实战"**：

1. **参数是调优的"语法"**：工具链（jstack/jmap/Arthas）是"诊断器"，参数是"处方"——开错处方再多诊断也没用
2. **参数是最常被追问的细节**：面试官问"你线上 G1 怎么调的"，答 `-XX:MaxGCPauseMillis=50` 还是不调，差一个段位
3. **参数与版本强绑定**：JDK 8 vs 11 vs 17 的参数差异（CMS 移除、ZGC 转正、AppCDS 默认开启），是 JDK 升级项目必踩的坑
4. **参数与容器化强耦合**：K8s limit 4C8G 的 Pod 里，JVM 该开 `+UseContainerSupport` 还是手动设 `-Xmx`？这是 7 月第 3 周 K8s 专题遗留的差距

**与往周专题的衔接点**：

- **MySQL InnoDB 缓冲池大小** vs **JVM 堆大小**：缓冲池 50% 物理内存、JVM 堆 50% 物理内存，谁先调？冲突怎么办（6月第1周）
- **Redis maxmemory** vs **JVM -Xmx**：Redis 用 maxmemory 控制上限，JVM 用 -Xmx，但 JVM 还有堆外内存（Netty/直接内存/NMT）容易超 limit（6月第2周）
- **ES circuit breaker** vs **JVM 堆 OOM**：ES 用熔断器预防 OOM，JVM 需要在业务层加保护（如限流降级），呼应 6 月第 4 周
- **K8s resources.limits** vs **JVM 容器感知**：JDK 8u191+ 才真正支持容器，之前 `Runtime.availableProcessors()` 会返回宿主机 CPU 数（7月第3周 Day05）

**与简历项目的衔接点**：

在线问诊系统的 JVM 参数三大重灾区：

1. **IM 长连接网关**：10w+ 长连接，每条 Netty ByteBuf 占用直接内存，需精确设置 `-XX:MaxDirectMemorySize`，否则会"堆没用完，直接内存 OOM"
2. **视频问诊 SFU**：每路视频通话高对象创建速率，Eden 区压力极大，需调 `-XX:SurvivorRatio` / `-XX:MaxTenuringThreshold` 避免过早晋升
3. **监管上报服务**：24h 必达，对 GC 停顿敏感（P99 &lt; 100ms），需 G1 调 `MaxGCPauseMillis` + `G1NewSizePercent`

本周 Day05 实战日会产出 `2026年07月第4周/简历项目-在线问诊系统-JVM调优案例.md`，今日先把参数基础打好。

---

## 题目一（参数全解题）：JVM 调优参数全解

请详细回答以下问题：

1. **堆与内存参数全解**：`-Xms` / `-Xmx` / `-Xmn` / `-XX:NewRatio` / `-XX:SurvivorRatio` / `-XX:MaxMetaspaceSize` / `-XX:MaxDirectMemorySize` / `-XX:ThreadStackSize` 各自的作用？为什么生产环境推荐 `-Xms` 与 `-Xmx` 设为相同？`-Xmn` 与 `-XX:NewRatio` 的关系？指针压缩（`-XX:+UseCompressedOops`）的 32GB 边界是什么？为什么不开启指针压缩堆上限就降到 4GB？
2. **GC 参数全解**：JDK 8 默认 GC 是什么？JDK 9+ 默认 GC 是什么？CMS 在 JDK 9 被废弃、JDK 14 移除的演进？G1 的 7 个核心参数（`MaxGCPauseMillis` / `G1HeapRegionSize` / `InitiatingHeapOccupancyPercent` / `G1NewSizePercent` / `G1MaxNewSizePercent` / `G1MixedGCCountTarget` / `G1ReservePercent`）分别什么作用？ZGC 的关键参数（`ZCollectionInterval` / `ZAllocationSpikeTolerance`）？如何选择 GC？
3. **JIT 参数全解**：`-XX:+TieredCompilation`（分层编译）/ `-XX:CompileThreshold`（编译阈值）/ `-XX:CICompilerCount`（编译线程数）/ `-XX:+UseOnStackReplacement`（OSR）/ `-XX:+PrintCompilation`（编译日志）的作用？为什么 JDK 8 默认 `CompileThreshold=10000`，分层编译开启后实际触发 C1/C2 的阈值是多少？JIT 与 CPU 的关系（编译线程占多少 CPU）？GraalVM Native Image 与 JIT 的取舍？
4. **容器化 cgroup 与 JVM**：JDK 8u191 之前 JVM 在容器中的两个经典问题是什么？JDK 8u191+ 的 `+UseContainerSupport` 做了什么？JDK 10+ 的 `+UseContainerSupport` 默认开启后还有哪些坑（如 cgroup v2 / CPU 隔离）？K8s Pod `requests=2C4G / limits=4C8G`，JVM 参数怎么设？为什么 `XX:ParallelGCThreads` 在容器中要手动设？CPU Throttling 对 JVM 的影响？
5. **-XX 陷阱与生产配置模板**：哪些 `-XX` 参数是"开关型"（`+`/`-`）、哪些是"赋值型"（`=`）？哪些参数在 JDK 8 有效、JDK 11+ 已废弃？生产 GC 日志参数（JDK 8 vs JDK 11+ 的 Xlog 区别）？`-XX:+HeapDumpOnOutOfMemoryError` + `-XX:HeapDumpPath` 的最佳实践？`-XX:+DisableExplicitGC` 真的推荐吗？`-XX:+UseStringDeduplication` 什么时候用？OOM 时 `kill -9` vs `kill -15`？

### 作答区

#### 1. 堆与内存参数全解

**JVM 内存参数全景**：

| 参数 | 作用 | 默认值（JDK 11） | 生产建议 |
|------|------|----------------|---------|
| `-Xms` | 初始堆大小 | 物理内存 / 64 | 与 `-Xmx` 相同 |
| `-Xmx` | 最大堆大小 | 物理内存 / 4 | 物理内存的 50%-60% |
| `-Xmn` | 新生代大小 | 堆的 1/3 | 一般不显式设，用 NewRatio |
| `-XX:NewRatio` | Old:Young = N:1 | 2（即 Young=1/3） | 2 或不设 |
| `-XX:SurvivorRatio` | Eden:Survivor = N:1 | 8（即 S=1/10） | 8-12 |
| `-XX:MaxMetaspaceSize` | 元空间上限 | 无上限 | 256M-512M |
| `-XX:MaxDirectMemorySize` | 直接内存上限 | ≈ Xmx | 显式设，避免被堆外吃掉 |
| `-Xss` | 线程栈大小 | 512K-1M | 512K（高频线程）/ 1M（普通） |
| `-XX:MaxTenuringThreshold` | 晋升老年代年龄 | 15（G1 默认 15） | 6-15 |
| `-XX:PretenureSizeThreshold` | 大对象直接进老年代 | 0（无） | 1M-10M（视场景） |

**为什么生产环境 `-Xms` 与 `-Xmx` 设为相同**：

1. **避免堆动态扩展收缩的开销**：堆扩展时需要向 OS 申请内存（mmap），可能触发 GC；收缩时需要归还内存，引发额外 Full GC
2. **启动即稳定**：服务启动后堆大小固定，避免启动初期因堆扩张导致的延迟抖动（对延迟敏感型业务如交易、IM 重要）
3. **便于监控告警**：堆使用率 = used / max，固定 max 后监控曲线更平稳，不会因 max 变化导致告警阈值失效
4. **避免内存碎片**：堆扩展时新分配的内存可能是物理不连续的，影响 GC 性能

**反例（什么时候不设相同）**：

- **测试环境**：希望快速启动，可以设 `-Xms` 小，让 JVM 按需扩展
- **沙箱/低优先级服务**：让出物理内存给关键服务，`-Xms` 设小
- **云函数/Serverless**：按使用计费，`-Xms` 设小

**`-Xmn` 与 `-XX:NewRatio` 的关系**：

两者都是控制新生代大小，但用法不同：

```
-Xmn512M              # 直接设新生代大小为 512M
-XX:NewRatio=2        # Old:Young = 2:1，即 Young = 堆 / 3

# 假设 -Xmx2G：
# -Xmn512M   -> Young=512M, Old=1.5G
# NewRatio=2 -> Young=683M, Old=1.34G
```

**优先用 NewRatio 的原因**：

1. `-Xmn` 是绝对值，调堆大小时新生代不变（绝对值固定），可能比例失衡
2. `NewRatio` 是比例，堆大小调整时新生代自动按比例调整
3. **G1 不要设 `-Xmn`**：G1 的 Region 是动态的，`-Xmn` 会破坏 G1 的自适应调整，JDK 10 后官方明确不推荐

**指针压缩（UseCompressedOops）**：

| 堆大小 | 指针压缩 | 对象引用大小 | 对象头 |
|--------|---------|------------|--------|
| &lt; 32GB | 开启（默认） | 4 字节 | 12 字节（Mark Word 8 + Klass 4） |
| ≥ 32GB | 关闭 | 8 字节 | 16 字节（Mark Word 8 + Klass 8） |

**为什么 32GB 是边界**：

- 64 位 JVM 用 32 位指针 + 偏移，可以寻址 2^32 × 8 = 32GB（每个对象 8 字节对齐）
- 超过 32GB 后 32 位指针不够用，必须用 64 位指针
- 关闭指针压缩后对象引用从 4 字节变 8 字节，对象头从 12 字节变 16 字节

**关闭指针压缩的实际影响**：

- 堆内存多消耗 5%-10%（对象引用 + 对象头变大）
- 缓存命中率下降（指针变大，CPU cache line 容纳的对象引用变少）
- **32GB 堆的实测性能反而比 30GB 堆差**——这就是为什么很多大内存服务选择"30GB 堆 + 多实例"而不是"32GB 堆 + 单实例"

**为什么不开启指针压缩堆上限就降到 4GB**：

这是误解。**不开指针压缩堆上限没有 4GB 限制**，64 位 JVM 可以寻址 TB 级内存。4GB 限制来自 32 位 JVM（地址空间只有 4GB）。但 JDK 8 之后 32 位 JVM 几乎不用了。

**生产内存规划示例（在线问诊 IM 网关，物理机 32C 64G）**：

```
堆：-Xms24g -Xmx24g         # 38% 物理内存
直接内存：-XX:MaxDirectMemorySize=16g   # 25%，Netty ByteBuf
元空间：-XX:MaxMetaspaceSize=512m
线程栈：-Xss512k              # 1000 线程 = 500M
Code Cache：-XX:ReservedCodeCacheSize=256m
GC 日志 + Heap Dump 预留：2G
OS + 其他进程：5G
合计：48G + 16G = 64G ✓
```

**关键认知**：堆不是越大越好。32G 堆的 GC 停顿比 24G 堆长很多（标记阶段时间与堆大小成正比）。**架构师需要平衡"堆大小"与"GC 停顿"**，而不是无脑拉大。

#### 2. GC 参数全解

**JDK 各版本默认 GC**：

| JDK 版本 | 默认 GC | 备注 |
|---------|--------|------|
| JDK 8 | Parallel Scavenge + Parallel Old（吞吐优先） | Server 模式默认；Client 模式默认 Serial |
| JDK 9-10 | G1 | JEP 291：CMS 标记为 Deprecated |
| JDK 11-13 | G1 | 仍为默认 |
| JDK 14 | G1 | JEP 363：CMS 移除 |
| JDK 15+ | G1 | ZGC 转正（JDK 15 Production），但默认仍是 G1 |
| JDK 21 | G1 | 分代 ZGC（JEP 439）可作为选项 |

**CMS 演进历史**：

- JDK 5：CMS 引入（HotSpot 1.5）
- JDK 6-7：CMS 主流低延迟 GC
- JDK 9（2017）：JEP 291 标记 Deprecated，原因是"维护成本高 + 难以与 ZGC/Shenandoah 兼容"
- JDK 14（2020）：JEP 363 移除 CMS，参数 `-XX:+UseConcMarkSweepGC` 失效

**G1 的 7 个核心参数**：

| 参数 | 作用 | 默认值 | 调优建议 |
|------|------|--------|---------|
| `-XX:MaxGCPauseMillis` | 目标停顿时间 | 200ms | 50-200ms，过小会牺牲吞吐 |
| `-XX:G1HeapRegionSize` | Region 大小 | 1-32M（堆 / 2048 自动算） | 1-32M，避免 Humongous |
| `-XX:InitiatingHeapOccupancyPercent` | 触发并发标记的堆占用率 | 45% | 35-50%，根据 Old 增长速率 |
| `-XX:G1NewSizePercent` | 新生代最小比例 | 5% | 一般不动 |
| `-XX:G1MaxNewSizePercent` | 新生代最大比例 | 60% | 一般不动 |
| `-XX:G1MixedGCCountTarget` | Mixed GC 分多少次回收 Old | 8 | 4-16，过大回收慢，过小单次久 |
| `-XX:G1ReservePercent` | 预留内存比例（防止疏散失败） | 10% | 10-20% |

**MaxGCPauseMillis 的陷阱**：

> "我设了 `-XX:MaxGCPauseMillis=50`，为什么 GC 停顿还是 200ms？"

**原因**：

1. `MaxGCPauseMillis` 是**目标**，不是上限。G1 会根据历史数据预测下次 GC 停顿，如果预测超过目标会调整 Region 数量
2. 但 G1 不能"无中生有"地降低停顿——如果 Eden 区太大、晋升太多，单次 GC 必然停顿长
3. 真正控制停顿需要**配合其他参数**：减小 `G1NewSizePercent` / `G1MaxNewSizePercent`、降低 `InitiatingHeapOccupancyPercent`

**正确调法**：

```
# 50ms 停顿目标
-XX:MaxGCPauseMillis=50
-XX:G1NewSizePercent=10        # 新生代最小 10%（默认 5%）
-XX:G1MaxNewSizePercent=40     # 新生代最大 40%（默认 60%）
-XX:InitiatingHeapOccupancyPercent=35   # 提前触发并发标记
-XX:G1ReservePercent=15        # 多预留防疏散失败
```

**InitiatingHeapOccupancyPercent（IHOP）**：

- 控制"何时开始并发标记"
- 默认 45%，即 Old 区使用率达到 45% 时启动并发标记
- 调低（如 35%）：更早开始标记，Mixed GC 更频繁但单次压力小
- 调高（如 55%）：晚开始，吞吐高但可能 Mixed GC 来不及做，触发 Full GC
- JDK 9+ 支持**自适应 IHOP**（`-XX:+G1UseAdaptiveIHOP`，默认开启）——JVM 根据历史 GC 数据自动调整

**ZGC 关键参数**：

| 参数 | 作用 | 默认值 |
|------|------|--------|
| `-XX:+UseZGC` | 启用 ZGC | JDK 15+ Production |
| `-XX:ZCollectionInterval` | 强制 GC 间隔 | 0（不强制） |
| `-XX:ZAllocationSpikeTolerance` | 分配尖峰容忍度 | 2.0 |
| `-XX:SoftMaxHeapSize` | 软上限（尽力不超过，但可达 Xmx） | = Xmx |
| `-XX:ConcGCThreads` | 并发 GC 线程数 | CPU / 4 |
| `-XX:ParallelGCThreads` | STW 阶段线程数 | CPU / 2 |

**ZGC 的关键认知**：

1. ZGC 不需要分代假设（JDK 21 之前不分代）
2. ZGC 停顿 &lt; 10ms（堆大小不影响停顿），但吞吐比 G1 低 5%-15%
3. JDK 21 的**分代 ZGC**（`-XX:+ZGenerational`）大幅降低开销，吞吐接近 G1

**如何选择 GC（决策树）**：

```
堆 < 4GB？
  ├─ 是 → JDK 8 用 Parallel（吞吐）或 CMS（低延迟）
  │       JDK 11+ 用 G1
  └─ 否 → 堆 4-32GB？
          ├─ 是 → G1（默认推荐）
          │       低延迟场景（金融/IM）用 ZGC（JDK 17+）
          └─ 否 → 堆 > 32GB？
                  ├─ 是 → ZGC（JDK 17+ 推荐）
                  │       或 Shenandoah
                  └─ 极端 → Azul Zing / Prime（商业）
```

**在线问诊系统 GC 选型实战**：

| 服务 | 堆 | GC | 原因 |
|------|----|----|------|
| IM 网关 | 24G | G1（MaxGCPauseMillis=50） | 长连接敏感，10w 连接触发 GC 停顿会导致批量心跳超时 |
| 视频问诊 SFU | 16G | G1（MaxGCPauseMillis=100） | 实时音视频对延迟敏感但相对宽容 |
| 监管上报 | 8G | G1（默认） | 24h 必达，对吞吐要求高 |
| MongoDB 大文档存档 | 32G | ZGC（JDK 17+） | 堆大，停顿敏感 |
| 历史归档（批处理） | 8G | Parallel | 批处理吞吐优先 |

**关键认知**：GC 选型不是"一刀切"，同一系统不同服务可以选不同 GC。架构师需要按业务特征（延迟敏感 / 吞吐敏感 / 堆大小）分别选型。

#### 3. JIT 参数全解

**JIT 编译参数全景**：

| 参数 | 作用 | 默认值（JDK 11） | 备注 |
|------|------|----------------|------|
| `-XX:+TieredCompilation` | 分层编译 | 开启 | JDK 10+ 默认开启，关闭后只用 C2 |
| `-XX:CompileThreshold` | C2 编译阈值 | 10000 | 分层编译开启时此参数无效 |
| `-XX:CICompilerCount` | 编译线程数 | max(2, CPU/4) | 太少会"编译慢"，太多占 CPU |
| `-XX:+UseOnStackReplacement` | OSR（栈上替换） | 开启 | 把解释执行的循环替换为编译版本 |
| `-XX:+PrintCompilation` | 打印编译日志 | 关闭 | 排查 JIT 问题必备 |
| `-XX:+LogCompilation` | 详细编译日志 | 关闭 | 用 JMH 分析时开 |
| `-XX:ReservedCodeCacheSize` | Code Cache 大小 | 240M | 不足会停止 JIT |
| `-XX:+UseNUMA` | NUMA 亲和 | 关闭 | 多 socket 服务器开 |

**分层编译的 5 层（JDK 11）**：

| Tier | 解释器 / 编译器 | 用途 |
|------|----------------|------|
| 0 | 解释器 | 启动初期，逐字节码解释 |
| 1 | C1（无 profiling） | 简单方法快速编译，无 Profile |
| 2 | C1（带方法级 profiling） | 中等优化，带方法调用计数 |
| 3 | C1（带完整 profiling） | 完整 Profile（调用频率、分支、类型） |
| 4 | C2 | 最高优化（逃逸分析、内联、向量化） |

**分层编译开启后的实际触发阈值**：

- `CompileThreshold=10000` 在分层编译开启时**基本无效**
- 实际触发 C1（Tier 3）的阈值：约 200 次（`Tier3InvocationThreshold`）
- 实际触发 C2（Tier 4）的阈值：约 10000-15000 次（综合 `Tier4InvocationThreshold` 与 `Tier4BackThreshold`）
- 可以用 `-XX:+PrintFlagsFinal` 查看所有阈值

**JIT 与 CPU 的关系**：

- 编译线程数 = `CICompilerCount`，默认 `max(2, CPU/4)`
- 4C 机器：2 个编译线程（1 C1 + 1 C2）
- 8C 机器：2 个编译线程（1 C1 + 1 C2）
- 16C 机器：4 个编译线程（2 C1 + 2 C2）
- 编译线程占用 CPU，会与业务线程争抢
- **容器化场景特别注意**：JDK 8u191 之前 `CICompilerCount` 看的是宿主机 CPU，可能开 16 个编译线程，浪费内存

**Code Cache 不足的后果**：

- JIT 停止编译（"CodeCache is full. Compiler has been disabled"）
- 服务性能骤降（5-10 倍慢）
- 监控指标：`jvm.compilation.code_cache.used` / `jvm.compilation.code_cache.max`

**调优 Code Cache**：

```bash
-XX:ReservedCodeCacheSize=256M   # JDK 11 默认 240M，大服务建议 256-512M
-XX:InitialCodeCacheSize=16M     # 初始大小
```

**GraalVM Native Image 与 JIT 的取舍**：

| 维度 | JIT（C1/C2） | GraalVM Native Image |
|------|-------------|---------------------|
| 启动时间 | 秒级（需预热） | 毫秒级（AOT 编译） |
| 峰值性能 | 高（C2 优化充分） | 中（AOT 无法做推测性优化） |
| 内存占用 | 大（Code Cache + JIT 数据） | 小（无 Code Cache） |
| 反射/动态代理 | 自动支持 | 需要 `reflect-config.json` |
| 适用场景 | 长运行服务 | Serverless / CLI / 边缘 |

**关键认知**：GraalVM Native Image 不是"JIT 的替代"，而是"补充"。长运行服务用 JIT，短运行用 Native Image。Spring Boot 3 + GraalVM 让 Native Image 在 Spring 生态可用，但反射配置仍是痛点。

#### 4. 容器化 cgroup 与 JVM

**JDK 8u191 之前容器中的两个经典问题**：

**问题 1：堆大小看宿主机内存**

```
容器 limit：4GB
JDK 8u191 之前：
  -Xmx 默认 = 物理内存 / 4
  JVM 看到的是宿主机 64GB
  → -Xmx = 16GB（远超容器 limit）
  → OOMKilled
```

**问题 2：GC 线程数看宿主机 CPU**

```
容器 limit：2 CPU
JDK 8u191 之前：
  ParallelGCThreads 默认 = CPU / 8 (rounded)
  JVM 看到的是宿主机 32 CPU
  → ParallelGCThreads = 8（远超容器 limit）
  → GC 时 8 个线程争抢 2 CPU，业务线程被饿死
```

**JDK 8u191+ 的 `+UseContainerSupport` 做了什么**：

1. **感知 cgroup v1 内存限制**：`-Xmx` 默认值 = 容器 limit / 4（不是宿主机 / 4）
2. **感知 cgroup v1 CPU 限制**：`ParallelGCThreads` / `CICompilerCount` 按容器 CPU 算
3. **默认开启**：JDK 8u191+ 默认开启，无需手动加

**JDK 10+ 的 `+UseContainerSupport` 增强与遗留坑**：

- JDK 10+：默认开启，且支持 cgroup v1 + v2
- JDK 11+：支持 cgroup v2
- **遗留坑 1：CPU 隔离**：容器 `cpuset=0-1`（绑定到 CPU 0 和 1）时，JVM `availableProcessors()` 返回的是 2，但 `cpuset` 在某些 K8s 配置下 JVM 看不到
- **遗留坑 2：cgroup v2**：JDK 11 早期版本对 cgroup v2 支持不完整，JDK 15+ 才稳定
- **遗留坑 3：CPU Throttling**：JVM 看到的是 `limits.cpu=4`，但实际可能被 cgroup 限流到 200ms/100ms 周期——JVM 不知道，仍按 4 CPU 调 GC 线程数

**K8s Pod `requests=2C4G / limits=4C8G` 的 JVM 参数设置**：

```bash
# 容器 limit 4C8G，但 requests 2C4G（典型 K8s 配置）

# 推荐参数（按 limits 算，但考虑 throttling 风险）：
-Xmx4g                              # limits 内存 8G 的一半（留堆外）
-Xms4g
-XX:MaxDirectMemorySize=1g
-XX:MaxMetaspaceSize=256m
-XX:+UseG1GC
-XX:MaxGCPauseMillis=100
-XX:ParallelGCThreads=2             # 手动设，避免按 limits 4 CPU 算成 2 但实际 requests 2 CPU
-XX:ConcGCThreads=1
-XX:CICompilerCount=2               # 手动设
-Xss512k
```

**为什么 `ParallelGCThreads` 在容器中要手动设**：

- JVM 默认按 `availableProcessors()` 算，容器中可能返回 limits 值（4 CPU）
- 但 K8s 的 CPU limit 是"时间片限流"，不是"独占"——4 CPU 限流时实际可用可能只有 2 CPU 的时间
- GC 线程 4 个争抢 2 CPU 的时间片，反而比 2 个 GC 线程慢（线程切换开销）
- **架构师经验**：`ParallelGCThreads = 容器 CPU / 4`（向下取整，最小 1），而不是按 limits 算

**CPU Throttling 对 JVM 的影响**：

- K8s CPU limit 是 CFS quota 限流：默认 100ms 周期，limit=2 CPU 表示 200ms quota/100ms 周期
- 业务线程用满 quota 后被内核 throttle，等到下个周期才能继续
- **GC 线程也会被 throttle**：GC 本来 50ms 完成，因为 throttle 拉长到 200ms+，业务感知"GC 停顿变长"
- **JIT 编译线程被 throttle**：编译慢，预热期变长
- **Safepoint 等待被放大**：JVM 进入 Safepoint 需要所有线程到达，被 throttle 的线程迟迟不到，Safepoint 等待时间暴涨

**诊断 CPU Throttling**：

```bash
# 在 Pod 内
cat /sys/fs/cgroup/cpu/cpu.stat
# 输出：
# nr_periods 12345
# nr_throttled 6789       # 被限流的周期数
# throttled_time 567890123  # 累计被限流的时间（ns）
```

**避免 CPU Throttling 的方法**：

1. `limits.cpu` 设为 `requests.cpu` 的 2-3 倍（避免过紧）
2. CPU 密集型服务用 `cpuset`（绑定 CPU，不用 CFS quota）
3. JVM 参数手动调小 GC 线程数

#### 5. -XX 陷阱与生产配置模板

**`-XX` 参数的两种形态**：

```bash
# 开关型（Boolean）：+ 开启，- 关闭
-XX:+UseG1GC              # 开启 G1
-XX:-UseAdaptiveSizePolicy  # 关闭自适应调整

# 赋值型（Key-Value）：= 赋值
-XX:MaxGCPauseMillis=100
-XX:ParallelGCThreads=4
```

**JDK 版本兼容陷阱**：

| 参数 | JDK 8 | JDK 11 | JDK 17 |
|------|-------|--------|--------|
| `-XX:+UseConcMarkSweepGC` | ✅ | ⚠️ Deprecated | ❌ 失效 |
| `-XX:+UseParNewGC` | ✅ | ⚠️ Deprecated | ❌ 失效 |
| `-XX:PermSize` / `-XX:MaxPermSize` | ❌ 已移除（JDK 8） | - | - |
| `-XX:+UseBiasedLocking` | ✅ | ⚠️ Deprecated | ❌ 失效（JEP 374） |
| `-XX:+UseZGC` | ❌ | ⚠️ Experimental | ✅ Production（JDK 15） |
| `-XX:+PrintGCDetails` | ✅ | ⚠️ Deprecated | ❌ 失效（改用 Xlog） |
| `-Xloggc:` | ✅ | ⚠️ Deprecated | ❌ 失效（改用 Xlog） |

**GC 日志参数（JDK 8 vs JDK 11+）**：

```bash
# JDK 8 风格
-XX:+PrintGCDetails
-XX:+PrintGCDateStamps
-XX:+PrintGCApplicationStoppedTime   # 打印 Safepoint 停顿
-XX:+PrintGCApplicationConcurrentTime
-XX:+PrintTenuringDistribution
-XX:+PrintAdaptiveSizePolicy
-Xloggc:/data/logs/gc.log
-XX:+UseGCLogFileRotation
-XX:NumberOfGCLogFiles=10
-XX:GCLogFileSize=100M

# JDK 11+ 统一 Xlog（推荐）
-Xlog:gc*:file=/data/logs/gc.log:time,uptime,level,tags:filecount=10,filesize=100m
# gc* 表示所有 gc 相关 tag
# time,uptime,level,tags 是日志格式
# filecount=10 filesize=100m 是滚动策略
```

**JDK 11+ Xlog 的优势**：

1. **统一日志框架**：GC、JIT、类加载、Safepoint 都用 Xlog
2. **tag 过滤**：可以只看 `gc` tag，过滤噪音
3. **level 控制**：`error` / `warning` / `info` / `debug` / `trace`

**HeapDumpOnOutOfMemoryError 的最佳实践**：

```bash
-XX:+HeapDumpOnOutOfMemoryError
-XX:HeapDumpPath=/data/dumps/                 # 目录（自动用 pid 命名）
-XX:HeapDumpPath=/data/dumps/im-gateway.hprof # 文件（固定名）
-XX:OnOutOfMemoryError="kill -9 %p"           # OOM 后杀进程
```

**坑**：

1. **HeapDump 路径要预留足够空间**：24G 堆 dump 出来 24G 文件，目录至少 30G
2. **OOM 后杀进程**：JVM OOM 后状态不稳定，可能"半死不活"占用资源，最好 `OnOutOfMemoryError="kill -9 %p"` 立即杀掉，让 K8s 重启
3. **不要在 OOM 时自动重启**：用 `kill -9` 后让 K8s livenessProbe 探测失败自动重启，不要在 JVM 内部重启

**`-XX:+DisableExplicitGC` 真的推荐吗**：

- 作用：禁用 `System.gc()` 调用
- **优点**：防止业务代码误调 `System.gc()` 触发 Full GC
- **缺点**：
  1. `DirectByteBuffer` 依赖 `System.gc()` 触发 Cleaner 回收直接内存，禁用后可能堆外内存泄漏
  2. RMI 框架默认每小时调一次 `System.gc()`（`sun.rmi.dgc.client/server.gcInterval`），禁用后需手动调长间隔

**结论**：

- 不推荐 `DisableExplicitGC`
- 推荐 `-XX:+ExplicitGCInvokesConcurrent`：把 `System.gc()` 转为并发 GC（G1 的 Concurrent Mark），避免 Full GC

**`-XX:+UseStringDeduplication` 什么时候用**：

- 作用：G1 自动识别重复字符串（同一个值），让多个 String 引用指向同一个 char[]
- **适用场景**：堆中大量重复字符串（如缓存 key、配置项、日志字符串）
- **不适用场景**：String 大多不重复（如 UUID、用户输入）
- 开销：增加 GC 标记阶段时间 5%-10%
- 实测：在线问诊 IM 网关开启后，堆使用降低 8%（消息内容大量重复模板）

**OOM 时 `kill -9` vs `kill -15`**：

| 信号 | 含义 | JVM 行为 |
|------|------|---------|
| `kill -15` / `SIGTERM` | 优雅停止 | 触发 ShutdownHook，等 Spring 销毁 Bean，可能 30s+ |
| `kill -9` / `SIGKILL` | 强制杀 | 立即停止，无 ShutdownHook，可能丢数据 |

**生产实践**：

- **正常发布**：`kill -15` + 等 30s + K8s preStop hook
- **OOM 紧急处置**：`kill -9`，不要等 ShutdownHook（可能卡死）
- **OOM 后处理**：JVM 已 `OnOutOfMemoryError="kill -9 %p"`，自动杀

**生产配置模板（在线问诊 IM 网关，JDK 17，K8s 4C8G）**：

```bash
# JVM 启动参数（生产模板）
-Xms4g
-Xmx4g
-Xss512k
-XX:MaxDirectMemorySize=1g
-XX:MaxMetaspaceSize=256m
-XX:ReservedCodeCacheSize=256m

# GC（G1）
-XX:+UseG1GC
-XX:MaxGCPauseMillis=50
-XX:G1HeapRegionSize=4m
-XX:InitiatingHeapOccupancyPercent=35
-XX:G1ReservePercent=15
-XX:ParallelGCThreads=2
-XX:ConcGCThreads=1

# JIT
-XX:+TieredCompilation
-XX:CICompilerCount=2

# 容器化
-XX:+UseContainerSupport

# GC 日志（JDK 11+ Xlog）
-Xlog:gc*:file=/data/logs/gc.log:time,uptime,level,tags:filecount=10,filesize=100m
-Xlog:safepoint:file=/data/logs/safepoint.log:time,uptime,level,tags:filecount=5,filesize=50m
-Xlog:classload:file=/data/logs/classload.log:time,uptime,level,tags:filecount=5,filesize=20m

# OOM 处置
-XX:+HeapDumpOnOutOfMemoryError
-XX:HeapDumpPath=/data/dumps/
-XX:OnOutOfMemoryError="kill -9 %p"

# 其他
-XX:+ExplicitGCInvokesConcurrent
-XX:+UseStringDeduplication
-XX:+AlwaysPreTouch                    # 启动时预触碰内存，避免运行时缺页
-Djava.security.egd=file:/dev/./urandom  # 加速 SecureRandom
-Dfile.encoding=UTF-8
-Duser.timezone=Asia/Shanghai
```

**`-XX:+AlwaysPreTouch` 的作用**：

- 启动时把 `-Xmx` 的所有内存页"触碰"一遍，触发缺页中断，建立虚拟地址到物理内存的映射
- 启动时间增加 5-30s（视堆大小）
- **好处**：运行时不再有缺页中断抖动，对延迟敏感型业务（IM/交易）重要
- **大堆必开**：32G 堆不开 AlwaysPreTouch，运行时缺页可能引发秒级抖动

---

## 本日能力差距与补足方向

### 差距 1：JDK 8 vs 11 vs 17 的参数差异体系不熟
> Day1发现，延续第1周Day03差距3.4 / Day04差距4.5

- **现状**：知道 CMS 在 JDK 14 被移除，但具体哪些参数失效（`UseConcMarkSweepGC` / `UseParNewGC` / `PrintGCDetails` / `Xloggc` / `UseBiasedLocking`）模糊；JDK 升级项目里容易踩坑
- **架构师水平**：能完整列出 JDK 8/11/17 的参数差异表，能预判升级风险；能用 `jdeps` 扫描 JVM 参数兼容性
- **补足方向**：精读 JEP 291（CMS Deprecated）、JEP 363（CMS Removed）、JEP 374（Biased Locking Deprecated）；第 2 周末写 IM 网关 JDK 17 升级 RFC

### 差距 2：G1 调优参数的耦合关系实战经验不足
> Day1发现，延续第1周Day03差距3.1 / Day07差距7.2

- **现状**：知道 7 个 G1 参数，但"调一个引发 3 个副作用"的实战经验不足；如调 `MaxGCPauseMillis=50` 后是否要同步调 `G1NewSizePercent` / `IHOP`
- **架构师水平**：能在 30 分钟内画出 G1 调参耦合矩阵；能根据业务特征（吞吐/延迟/堆大小）预判关键参数
- **补足方向**：Day05 实战；调研 Netflix / LinkedIn 的 G1 调优案例；用 JMH + JFR 实测 G1 不同参数组合

### 差距 3：容器化 cgroup 与 JVM 协同的工程经验不足
> Day1发现，延续第1周Day03差距3.7 / Day06差距6.2 / 7月第3周K8s差距

- **现状**：知道 `+UseContainerSupport` 默认开启，但 CPU Throttling 对 GC/JIT/Safepoint 的影响、cgroup v2 兼容性、cpuset 与 limits 的取舍实战不深
- **架构师水平**：能根据 K8s resources.limits/requests 精确反推 JVM 参数；能诊断 CPU Throttling 引发的 GC 停顿叠加；能讲清 cgroup v1 vs v2 在 JVM 11 vs 17 的差异
- **补足方向**：调研 Azul / OpenJDK 容器化最佳实践；用 `cpu.stat` 监控 IM 网关的 Throttling 比例；Day05 实战时验证

### 差距 4：JIT 参数与业务性能的关联不深
> Day1发现，延续第1周Day05差距5.1 / 5.2

- **现状**：知道分层编译 5 层，但 `CICompilerCount` / `ReservedCodeCacheSize` / `CompileThreshold` 的调优实战经验不足；Code Cache 不足导致 JIT 停止的真实案例没遇到过
- **架构师水平**：能用 `-XX:+PrintCompilation` + `-XX:+LogCompilation` 量化 JIT 行为；能根据预热时长反推 CICompilerCount；能诊断 Code Cache 不足
- **补足方向**：用 JMH 测试 IM 网关预热 5/10/30 分钟的吞吐差异；阅读 R大博客关于 JIT 调优的 5 篇文章

### 差距 5：生产 JVM 参数模板缺少标准化
> Day1发现，延续简历项目差距

- **现状**：能写出 IM 网关的 JVM 参数，但缺统一的"生产参数模板"——不同服务的堆/直接内存/GC 参数应该按什么规则推导，没有方法论
- **架构师水平**：能输出团队/公司的《JVM 参数配置规范》文档；能根据服务类型（API/MQ 消费/批处理/长连接）选不同模板；能把规范集成到 CI/CD 流水线自动校验
- **补足方向**：第 2 周末输出《在线问诊系统 JVM 参数规范》；调研阿里 / 美团的 JVM 参数规范文档；用 spring-boot-startup-report 工具分析启动期
