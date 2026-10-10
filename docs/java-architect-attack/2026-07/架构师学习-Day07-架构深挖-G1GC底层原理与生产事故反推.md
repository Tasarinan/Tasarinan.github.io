# Day 7：架构深挖 - G1 GC 底层原理与生产事故反推

> 日期：2026年08月02日（周日）
> 周主题：JVM 专题第 1 周 - JVM 基础与核心
> 深挖日：Day07 - G1 GC 底层原理与生产事故反推（Region / RSet / SATB / Mixed GC / Humongous / 调优参数体系）

---

## 一、今日主题

本周 Day01-Day06 完成了 JVM 5 大支柱的系统学习：

```text
Day01：JVM 内存模型与对象生命周期（堆 / 栈 / 方法区 / 元空间 / 直接内存、对象内存布局、可达性分析、三色标记）
Day02：GC 算法与分代收集理论（标记清除 / 复制 / 标记整理、Card Table、写屏障 SATB vs 增量更新、Safepoint）
Day03：GC 收集器全谱系（Serial / ParNew / Parallel / CMS / G1 / ZGC / Shenandoah、Region 模型、染色指针）
Day04：类加载机制与字节码（双亲委派、SPI 打破、CGLIB 字节码增强、javap 字节码、栈帧结构）
Day05：JIT 编译优化（分层编译 5 层、C1/C2/Graal、方法内联、逃逸分析、退优化）
Day06：串联整合 - IM 网关全链路 JVM 调优实战（5w -> 15w QPS）
```

Day06 把 5 大支柱用在了 IM 网关的全链路调优上，QPS 从 5w 提到 15w，P99 &lt; 50ms。但 Day06 用 G1 时只讲了"怎么调参"：

```text
-Xms4g -Xmx4g
-XX:+UseG1GC
-XX:G1HeapRegionSize=4m
-XX:MaxGCPauseMillis=50
-XX:InitiatingHeapOccupancyPercent=45
-XX:G1NewSizePercent=30 / G1MaxNewSizePercent=50
-XX:G1ReservePercent=15
-XX:G1MixedGCCountTarget=8
-XX:G1MixedGCLiveThresholdPercent=65
-XX:SurvivorRatio=8 / MaxTenuringThreshold=15
-XX:ParallelGCThreads=4 / ConcGCThreads=1
```

这些参数背后 G1 内部到底在做什么，我们一直回避了。Day07 把这个问题彻底深挖：

```text
为什么 Region 是 G1 的基本单位，而不是"代"？
为什么 G1 用 SATB 而不是增量更新做并发标记？
Remembered Set 到底记的是什么？为什么需要它？
Mixed GC 怎么决定回收哪些 Region？"回收价值"怎么算？
Evacuation Failure 为什么会引发 Full GC？怎么预防？
Humongous Object 怎么影响 GC 频率？
G1 调优参数有几十个，背后是哪几个机制在驱动？
```

这道题考察的不是"会不会调 G1 参数"，而是你能不能把背后的：

```text
Region 模型 + 跨代引用 + 写屏障 + SATB + Remembered Set + Mixed GC + 调优参数体系
```

讲清楚。结合用户业务背景：在线问诊 IM 网关 5w -> 15w QPS 调优后，上线第 7 天凌晨突发一次 G1 异常事件。

---

## 二、题目：G1 GC 底层原理深挖与生产事故反推

Day06 把 IM 网关的 G1 调优参数全部用上了，QPS 从 5w 提到 15w，P99 &lt; 50ms，平稳运行 6 天。**第 7 天凌晨 03:00 突发 4 个异常现象**：

```text
现象1：Mixed GC 频繁触发，每 30s 1 次（正常每 5 分钟 1 次），
       但 Old 区使用率从 70% 不降，反而缓慢上升到 78%。
       GC 日志显示 "Mixed GC pause (G1 Evacuation Pause) (mixed) Young + Old"
       单次 Mixed GC 回收的 Old Region 数量从 50 个降到 5 个。

现象2：Concurrent Mark 阶段 CPU 持续 100%（4 core 全占），
       但 STW 时长正常（< 50ms）。
       jstack 显示 1 个 "Concurrent Mark Thread"，
       top -H 显示该线程 CPU 占用 400%（4 核满载）。
       应用线程 CPU 几乎为 0%，业务消息处理延迟。

现象3：凌晨 03:12 突发 Evacuation Failure，
       日志显示 "Evacuation Failure: cannot allocate space in to-region"
       紧接着触发 Full GC (Serial Full)，停顿 2.3s。
       10w 长连接 30% 因心跳超时断线，业务报警 500+ 条。
       Full GC 后 Old 区使用率从 92% 降到 65%，但 5 分钟后又涨回 85%。

现象4：jstat -gc 显示 5 个 Humongous Region，
       占用 20MB（5 × 4MB），都是凌晨 02:55 突发分配的。
       每个对象大小约 4.2MB（略大于 Region 一半 = 2MB）。
       每分配 1 个 Humongous Object 就触发 1 次并发标记。
       溯源发现是"健康报告 PDF"功能在凌晨批量生成报告。
```

现在要求你：

```text
从 G1 内部机制（Region / Remembered Set / SATB / Mixed GC / Humongous Allocation）
出发，解释清楚上述四个现象的根因，并给出架构师视角的"四防闭环"设计与替代方案。
```

---

## 三、需要回答的问题

### 1. G1 Region 模型与跨代引用底层

请说明：

```text
Region 模型底层：
- 为什么 G1 用 Region 而不是"连续的代"作为基本单位？
- Region 大小如何选择（1/2/4/8/16/32MB）？为什么是 2 的幂？
- 一块 Region 在运行时如何"动态切换"角色（Eden / Survivor / Old / Humongous）？
- 为什么 G1 不需要"分代"的物理连续性？
- 4MB Region 中，对象如何分配？TLAB 与 Region 的关系？

跨代引用底层：
- Card Table（卡表）的粒度与写屏障
- 卡表如何被 G1 用来快速定位"跨 Region 引用"
- Write Barrier 的两种实现（精度 / 性能权衡）
- 为什么 G1 用 "Remembered Set" 而不是"全堆扫描"找跨代引用？

Remembered Set 底层：
- RSet 记的是什么？（谁引用我，而不是我引用谁）
- RSet 的数据结构（hash 表 + Per-Region 卡表）
- RSet 的更新流程（写屏障 -> 卡表脏标记 -> 并发更新 RSet）
- RSet 的内存开销（占堆的 1%-20%）
- 为什么"RSet 越精确，GC 越快，但内存开销越大"？
```

### 2. SATB 与并发标记四阶段

请说明：

```text
并发标记的核心难题：
- 为什么"标记存活对象"不能 STW？（IM 网关 4GB 堆，STW 标记要 1s+）
- 并发标记时，应用线程还在修改对象引用，怎么办？
- "Snapshot At The Beginning"（SATB）的"快照"是什么？
- SATB vs 增量更新（Incremental Update）的本质区别？
- 为什么 G1 选 SATB，CMS 选增量更新？

并发标记四阶段：
- 阶段1：初始标记（Initial Mark，STW，借 Young GC 的车）
- 阶段2：并发标记（Concurrent Mark，与应用并发，扫描整个堆）
- 阶段3：最终标记（Remark，STW，处理 SATB 缓冲区）
- 阶段4：筛选回收（Cleanup，部分 STW，统计回收价值）

每个阶段的 STW 时长？为什么阶段 1 可以"借 Young GC 的车"？
为什么阶段 3 要 STW？处理的是什么？
为什么阶段 4 不直接回收（要等下一次 Mixed GC）？

SATB 的"重新标记"为什么比 CMS 的 Remark 短？
SATB 的"floating garbage"问题是什么？怎么缓解？
```

### 3. Mixed GC 触发条件与回收价值计算

请说明：

```text
为什么现象1中"Mixed GC 频繁触发，但 Old 区使用率不降"？

Mixed GC 触发条件：
- IHOP（InitiatingHeapOccupancyPercent=45）触发并发标记
- 并发标记完成后，G1 计算"每个 Region 的回收价值"
- 回收价值 = Region 中垃圾占比 + RSet 精度
- G1MixedGCLiveThresholdPercent=65（存活率 < 65% 才参与回收）
- G1MixedGCCountTarget=8（分 8 次回收完）

回收价值计算底层：
- 存活对象大小怎么算？（并发标记扫描出来）
- RSet 精度怎么算？（Card Table 脏标记比例）
- 为什么"存活率高"的 Region 不参与回收？
- 为什么"分 8 次"而不是"1 次回收完"？（停顿目标）

现象1根因深挖：
- 为什么 Mixed GC 频繁触发但 Old 区不降？
- 可能的根因：存活率 > 65% 的 Region 太多
- 为什么存活率高？凌晨业务低峰期，缓存对象没有失效
- 为什么回收的 Region 数量从 50 降到 5？回收价值阈值提高？
```

### 4. Evacuation Failure / Humongous Allocation / Full GC 的根因与防护

请说明：

```text
Evacuation Failure（疏散失败）底层：
- 什么是 Evacuation？（把存活对象从 from-region 复制到 to-region）
- 什么时候失败？（to-region 没空间了）
- 失败后的退化路径：疏散失败 -> To-space exhausted -> Full GC
- 为什么 Full GC 用 Serial Full（单线程）？停顿 2.3s？
- 为什么 Full GC 后 Old 区使用率 5 分钟又涨回 85%？

Evacuation Failure 的根因：
- 大对象分配失败
- 碎片化严重（to-region 找不到连续空间）
- Survivor 不够（Young GC 晋升率高）
- Mixed GC 回收速度跟不上分配速度

防护方案：
- G1ReservePercent=15（保留 15% 应对疏散失败）
- 启动期 -XX:+AlwaysPreTouch（预触摸，避免运行时缺页）
- 监控预警：Old 区使用率 > 80% 告警
- 紧急扩容：K8s HPA 触发副本扩容

Humongous Allocation 底层：
- 大对象阈值：Region 的一半（4MB Region -> 2MB）
- 大对象独占 Humongous Region，不参与 Young GC
- 大对象在并发标记阶段被回收
- 频繁分配大对象 -> 频繁触发并发标记

现象4根因深挖：
- 健康报告 PDF 单个 4.2MB，略超 2MB 阈值 -> Humongous
- 5 个 PDF 占用 5 × 4MB = 20MB（每个独占一个 Region）
- 每分配 1 个触发 1 次并发标记 -> Concurrent Mark CPU 100%

防护方案：
- Region 大小调整：4MB -> 16MB（阈值变 8MB，PDF 不再是 Humongous）
- 大对象分块：PDF 流式生成，避免一次性分配
- 大对象池化：复用 ByteBuf
- 业务错峰：PDF 生成从凌晨 03:00 改到 04:00
```

### 5. G1 调优参数体系与生产诊断工具链

请说明：

```text
G1 调优参数体系：
- 内存布局参数（Region / NewSizePercent / ReservePercent）
- 触发时机参数（IHOP / G1PeriodicGCInterval）
- 停顿控制参数（MaxGCPauseMillis / MixedGCCountTarget）
- 回收效率参数（MixedGCLiveThresholdPercent / TenuringThreshold）
- 容器化参数（ParallelGCThreads / ConcGCThreads / CICompilerCount）

为什么"调一个参数可能引发 3 个新问题"？
- MaxGCPauseMillis 太小 -> Mixed GC 分多次 -> 频繁触发
- IHOP 太低 -> 频繁并发标记 -> CPU 100%
- MixedGCLiveThresholdPercent 太低 -> 回收不动 -> Old 区不降
- Region 太小 -> Humongous 多 -> 频繁并发标记

生产诊断工具链：
- GC 日志解析（Xlog / gc.log）
- jstat -gc 实时监控各区使用率
- jcmd GC.heap_info 查看 Region 状态
- JFR + async-profiler 火焰图
- Arthas 在线诊断（监控 RSet / Card Table）
- Prometheus + Grafana 监控大盘

如何用上述工具反推现象1-4的根因？
```

---

## 四、问题逐题深挖

### 4.1 G1 Region 模型与跨代引用底层

#### 4.1.1 为什么 G1 用 Region 而不是"连续的代"

**CMS / Parallel 的"连续代"模型**：

```
┌─────────────────────────────────────────────┐
│  Heap（连续）                                │
│  ┌────────────┬─────────────┬────────────┐  │
│  │  Eden      │  Survivor   │  Old       │  │
│  │  (1.6GB)   │  (0.4GB)    │  (2GB)     │  │
│  └────────────┴─────────────┴────────────┘  │
└─────────────────────────────────────────────┘

问题：
1. Old 区必须整体回收，回收时长与 Old 区大小成正比
2. Old 区碎片化无法局部整理（只能 Full GC 整理）
3. 4GB Old 区的 Full GC 停顿 > 1s
```

**G1 的"Region 模型"**：

```
┌──────────────────────────────────────────────────────────────┐
│  Heap（逻辑上 2048 个 Region，每个 4MB）                       │
│                                                              │
│  ┌──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┐     │
│  │E │E │E │S │O │O │H │O │E │O │S │O │O │E │O │H │O │..│     │
│  └──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┘     │
│   E=Eden  S=Survivor  O=Old  H=Humongous                    │
│                                                              │
│  逻辑上分代（Eden / Survivor / Old 集合），物理上不连续        │
└──────────────────────────────────────────────────────────────┘

优势：
1. 回收单位是 Region（不是整个 Old 区），回收时长可控
2. 选择回收价值高的 Region，停顿目标可达
3. 局部整理（疏散），避免全堆 Full GC
```

**核心思想**：把"分代"从"物理布局"变成"逻辑标签"。每个 Region 在运行时被赋予角色（Eden / Survivor / Old / Humongous），可以动态切换。

#### 4.1.2 Region 大小选择

**Region 大小约束**：

| Region 大小 | 大对象阈值（一半） | 适合场景 | 缺点 |
|------------|------------------|---------|------|
| 1MB | 512KB | 小对象密集型 | Region 数量多，扫描开销大 |
| 2MB | 1MB | 通用 | 大对象多 |
| 4MB | 2MB | 中等对象（推荐） | 4.2MB 对象变 Humongous |
| 8MB | 4MB | 大对象多 | RSet 内存开销大 |
| 16MB | 8MB | PDF / 大缓冲 | 单 Region 回收慢 |
| 32MB | 16MB | 极大对象 | 单 Region 回收停顿长 |

**为什么是 2 的幂**：

```text
1. 位运算快速定位 Region ID：region_id = (address - heap_base) >> log2(region_size)
2. TLAB / Card Table 对齐：硬件 cache line 64B 对齐友好
3. Humongous 阈值计算：region_size / 2 = 2^(n-1)，整数运算
4. OS 页对齐：4KB / 2MB / 1GB huge page 友好
```

**G1 自动选择规则**（不指定 `G1HeapRegionSize` 时）：

```text
Region 大小 = max(1MB, min(32MB, heap_size / 2048))

IM 网关 4GB 堆：
  heap_size / 2048 = 4GB / 2048 = 2MB
  但 G1 倾向于向上取整到 2 的幂附近的"标准值"
  实际选 2MB（默认）或 4MB（指定）

如果堆是 32GB：
  heap_size / 2048 = 16MB
  G1 选 16MB Region
```

**IM 网关选 4MB Region 的原因**：

```text
对象大小分布：
  - IM 消息对象（JSON）：1-10KB
  - 业务对象（用户 / 医生 / 处方）：5-50KB
  - PDF 附件：4-10MB（罕见）
  - 缓存对象（Redis 序列化）：50-200KB

4MB Region 的 trade-off：
  - Region 数量 = 4GB / 4MB = 1024 个（扫描开销适中）
  - Humongous 阈值 = 2MB（PDF 会触发，但 PDF 罕见）
  - 单 Region 回收停顿 ≈ 1-3ms（1024 个 Region 全回收 < 3s）
```

#### 4.1.3 Region 角色动态切换

**Region 的"角色标签"机制**：

```text
每个 Region 在 G1 内部有一个 HeapRegionType 字段：

enum HeapRegionType {
  Free,           // 未分配
  Eden,           // Young Eden
  Survivor,       // Young Survivor
  Old,            // Old
  Humongous,      // 大对象（连续多个 Region）
  Pinned,         // 不可移动（JNI / NIO DirectByteBuffer 关键期）
  Archive         // CDS 归档（AppCDS）
}

切换流程（运行时）：
  Free --[分配 Eden]--> Eden --[Young GC 存活]--> Survivor --[多次存活]--> Old
  Old --[并发标记为垃圾]--> [Mixed GC 回收]--> Free
  Free --[大对象分配]--> Humongous --[并发标记回收]--> Free
```

**为什么不需要"物理连续的代"**：

```text
传统 CMS：
  Young GC：复制 Eden+Survivor 存活对象到 Old 区末尾（连续）
  Old GC：标记清除，碎片化无法整理

G1：
  Young GC：复制 Eden+Survivor 存活对象到任意 Survivor Region（不连续）
  Mixed GC：选择回收价值高的 Old Region，复制存活对象到任意空 Region
  通过"复制 + 任意目标 Region"实现碎片整理，不需要物理连续
```

**关键洞察**：G1 把"代"从"物理布局"降级为"角色标签"，回收单位从"整个代"变成"Region 集合"，所以能选择性地回收高价值 Region，控制停顿时长。

#### 4.1.4 4MB Region 中对象如何分配

**TLAB（Thread Local Allocation Buffer）与 Region 的关系**：

```text
Region 内部布局（4MB Region）：
┌────────────────────────────────────────────────┐
│  Region 4MB                                    │
│  ┌─────────┬─────────┬─────────┬─────────┐     │
│  │ TLAB-1  │ TLAB-2  │ TLAB-3  │  Free   │     │
│  │ 512KB   │ 512KB   │ 512KB   │ 2.5MB   │     │
│  └─────────┴─────────┴─────────┴─────────┘     │
│  TLAB 属于某个线程，线程内分配无锁               │
└────────────────────────────────────────────────┘

分配流程：
  1. 线程首次分配：向 G1 申请一个 TLAB（默认 512KB，可动态调整）
  2. G1 从当前 Eden Region 切一块 512KB 给该线程
  3. 线程在 TLAB 内分配对象：指针碰撞（bump pointer）
  4. TLAB 用完：再申请一块（可能切换到下一个 Eden Region）
  5. Eden Region 耗尽：触发 Young GC

为什么 TLAB 默认 512KB 而不是更大：
  - 太小：频繁申请 TLAB，与 G1 交互开销
  - 太大：TLAB 内部碎片化（最后一个对象放不下）
  - 512KB：单线程 1ms 内分配 5000 个对象（够用）
```

**TLAB 与 Region 的关键约束**：

```text
1. TLAB 不能跨 Region：一个 TLAB 只在一个 Region 内
2. 多个线程的 TLAB 可以在同一 Region：并发分配
3. TLAB 耗尽 Region 后，Region 转为"满"，等待 Young GC
4. 大对象（> TLAB 一半）：跳过 TLAB，直接在 Region 上分配（或走 Humongous 路径）
```

**对象分配的完整决策树**：

```text
新对象分配请求（如 new Object()）
  │
  ├─[对象大小 > Region/2]──> Humongous 路径
  │                          ├─ 分配连续 Humongous Region
  │                          └─ 触发并发标记（如果超过 IHOP）
  │
  ├─[对象大小 > TLAB/2]─────> 直接在 Eden Region 分配（绕过 TLAB）
  │
  └─[对象大小 <= TLAB/2]────> TLAB 内指针碰撞分配
                              ├─ TLAB 够：bump pointer
                              └─ TLAB 不够：申请新 TLAB
                                          ├─ 当前 Region 够：切一块
                                          └─ 当前 Region 不够：新 Eden Region
```

#### 4.1.5 Card Table（卡表）与写屏障

**Card Table 的粒度**：

```text
堆被划分为 Card（默认 512B），Card Table 是字节数组，每个 Card 对应 1 字节：

堆地址：  0x0000   0x0200   0x0400   0x0600   ...
          │        │        │        │
Card ID:  Card 0   Card 1   Card 2   Card 3   ...
          │        │        │        │
Card表:  [0x01]   [0x00]   [0x01]   [0x00]   ...
        dirty    clean   dirty    clean

写屏障触发：当应用线程修改对象字段引用时
  write(obj.field, value) {
    obj.field = value;                    // 实际写入
    card_id = (address_of(obj.field)) >> 9;  // 512B 粒度
    card_table[card_id] = 0x01;            // 标记 dirty
  }
```

**Card Table 在 G1 中的作用**：

```text
问题：Old Region 引用 Young Region，Young GC 时怎么找？

方案1（无 Card Table）：扫描整个 Old 区 - O(2GB) - 不可接受
方案2（Card Table）：只扫描 dirty card - O(dirty_cards × 512B)

G1 的 Card Table 使用：
  1. 应用写 old_obj.young_ref = young_obj 时，写屏障标记 Card dirty
  2. Young GC 时，扫描所有 dirty card（精确到 512B），找到跨代引用
  3. Young GC 后，清理 Card Table（clean）
```

#### 4.1.6 Write Barrier 的两种实现

**精度对比**：

| 维度 | 精确写屏障（Card 粒度） | 粗粒度写屏障（Region 粒度） |
|------|----------------------|--------------------------|
| 写入触发 | 每次引用写入 | 每次引用写入 |
| 标记粒度 | 512B Card | 4MB Region |
| 内存开销 | Card 表 = 堆 / 512 = 8MB/4GB | Region 表 = 堆 / 4MB = 1KB/4GB |
| 扫描开销 | 小（只扫 512B） | 大（扫整个 4MB Region） |
| G1 选择 | 精确 | 否 |

**G1 的写屏障实现（精确 + 高效）**：

```text
G1 写屏障伪代码：

void write_barrier(oop* field, oop value) {
    // 1. 实际写入（先写入，再标记，避免漏标）
    *field = value;

    // 2. SATB 处理（如果 field 原来不为 null）
    if (*field != NULL) {
        satb_queue.enqueue(*field);  // 加入 SATB 队列，并发标记用
    }

    // 3. Card Table 标记
    CardID card = (address_of(field) - heap_base) >> 9;
    if (card_table[card] != dirty) {
        card_table[card] = dirty;
        dcqs.enqueue(card);  // 加入 DCQS（Dirty Card Queue Set），并发更新 RSet
    }
}

写屏障开销：约 5-10% 性能损失（HotSpot 实测）
```

**关键洞察**：G1 的写屏障同时服务两个机制 - **SATB 队列**（并发标记）和 **DCQS**（RSet 更新）。一次写屏障完成两件事，这是 G1 工程上的精妙之处。

#### 4.1.7 Remembered Set（RSet）数据结构与原理

**RSet 的核心思想：谁引用我**

```text
问题：Old Region A 引用 Young Region B
  Young GC 回收 B 时，怎么知道 A 引用了 B？

方案1（无 RSet）：扫描所有 Old Region 找引用 B 的对象 - O(2GB)
方案2（RSet）：B 的 RSet 记录"A 引用了我"，扫描 B 的 RSet - O(B 的引用者)

RSet 的"反向索引"：
  传统：A -> B（正向，找 B 的引用者要扫全堆）
  RSet：B -> A（反向，B 自己记录"谁引用我"）
```

**RSet 的数据结构（Per-Region Hash 表）**：

```text
每个 Region 有 1 个 RSet，RSet 是一个 hash 表：

Region B 的 RSet：
  ┌─────────────────────────────────────────┐
  │  Hash 表                                 │
  │  ┌──────────┬──────────────────────┐    │
  │  │  Key     │  Value               │    │
  │  │  Region-A │ [Card-12, Card-56]  │    │  <- A 的哪些 Card 引用了 B
  │  │  Region-C │ [Card-3]            │    │  <- C 的哪个 Card 引用了 B
  │  │  Region-D │ [Card-88, Card-102] │    │
  │  └──────────┴──────────────────────┘    │
  └─────────────────────────────────────────┘

回收 B 时：
  扫描 B 的 RSet，找到引用 B 的 Card（精确到 512B）
  扫描这些 Card 内的对象，找引用 B 的对象
  把这些对象作为 GC Roots，扫描 B 内的存活对象
```

**RSet 的更新流程（异步）**：

```text
应用线程                  GC 线程
   │                        │
   ├─ write(obj.field, val) │
   │   ├─ 实际写入           │
   │   ├─ SATB 入队         │
   │   └─ Card 入 DCQS      │
   │                        │
   │                        ├─ Refine 线程（ConcGCThreads=1）
   │                        │   └─ 从 DCQS 取 Card
   │                        │       └─ 更新目标 Region 的 RSet
   │                        │
   │                        ├─ GC 安全点
   │                        │   └─ 处理剩余 DCQS（确保 RSet 一致）
   │                        │
   │                        └─ GC 开始
   │                            └─ RSet 已就绪，扫描 B 的 RSet
```

**DCQS（Dirty Card Queue Set）**：

```text
每个应用线程有 1 个 Dirty Card Queue，写入 dirty card 后继续执行（不阻塞）。
GC 启动前，Refine 线程会处理完所有 Queue，确保 RSet 一致。

性能权衡：
  - DCQS 让写屏障很快（O(1) 入队）
  - RSet 更新是异步的，不阻塞应用
  - 但如果 Refine 线程跟不上，DCQS 会满，应用被强制处理（造成毛刺）
```

#### 4.1.8 RSet 的内存开销与精度权衡

**RSet 内存开销估算**：

```text
IM 网关 4GB 堆，1024 个 Region：

最坏情况（每个 Region 被所有其他 Region 引用）：
  每个 RSet：1023 个 Entry × 8B（hash 表节点）= 8KB
  1024 个 RSet：8MB（占堆 0.2%）

实际生产经验：
  - 低引用密度（缓存型）：RSet 占堆 1-3%
  - 中引用密度（业务型）：RSet 占堆 5-10%
  - 高引用密度（图计算）：RSet 占堆 15-20%

IM 网关 RSet 实测：~6%（240MB）
  - 主要是消息分发的跨 Region 引用
  - 缓存对象生命周期短，RSet 更新频繁
```

**RSet 精度的三档**：

```text
G1 RSet 精度（-XX:G1SummarizeRSetStats 可观测）：

1. Precise（精确）：每个 Card 单独记录
   - 内存开销大，扫描开销小
   - 适合"被引用密集"的 Region

2. Coarse（粗粒度）：整个 Region 标记为"有引用"
   - 内存开销小（1 bit），扫描开销大（扫整个 Region）
   - 适合"被引用稀疏"的 Region

3. Sparse（稀疏）：只记录有引用的 Region ID
   - 内存开销中等
   - 适合"被引用中等"的 Region

G1 自动选择精度：
  - 初始用 Sparse
  - 引用增多升级到 Precise
  - 引用爆表降级到 Coarse（避免 RSet 内存失控）
```

**RSet 失控的危害**：

```text
如果 RSet 占堆 20%（800MB）：
  - 4GB 堆实际可用 3.2GB
  - RSet 自身成为 GC 负担（扫描 RSet 也要时间）
  - Refine 线程跟不上，DCQS 满，应用毛刺

RSet 失控的常见原因：
  - 大量"老对象引用新对象"（缓存设计错误）
  - 双向链表 / 树结构（每个节点互相引用）
  - ThreadLocal 持有大对象（线程不销毁，引用不释放）
  - 监听器未注销（事件源持有监听者）
```

#### 4.1.9 小结

```text
G1 Region 模型的核心创新：
  1. Region 作为基本单位（不是"代"），回收单位变小，停顿可控
  2. Region 角色动态切换（Eden / Survivor / Old / Humongous），不需要物理连续
  3. Card Table（512B 粒度）+ Write Barrier 高效捕获跨 Region 引用
  4. RSet 反向索引（"谁引用我"）避免全堆扫描
  5. DCQS 异步更新 RSet，写屏障 O(1)，不阻塞应用

代价：
  - RSet 内存开销（1%-20%）
  - 写屏障性能损失（5-10%）
  - 实现复杂度高（4 万行 C++ 代码）
```

---

### 4.2 SATB 与并发标记四阶段

#### 4.2.1 并发标记的核心难题

**为什么"标记存活对象"不能 STW**：

```text
IM 网关 4GB 堆：
  - 单线程标记扫描速度：约 500MB/s（每秒 500MB）
  - 4GB 全堆扫描：8s（单线程）
  - 4 线程并发：2s（理论，实际 3s+）
  - STW 3s：10w 长连接 100% 断线（心跳超时 200ms×15 次）

必须并发标记：让应用线程继续跑，GC 线程标记
```

**并发标记的"对象消失"问题**：

```text
经典图示：

       GC 线程                  应用线程
         │                        │
         ├─ 标记 A（black）        │
         │                        ├─ A.field = null（断开 A->B）
         │                        ├─ C.field = B（建立 C->B）
         │                        └─ C 还是 white（未标记）
         ├─ 标记 B（漏标！）
         │   └─ B 被误判为垃圾，回收
         └─ B 还在被 C 引用，但已被回收 - 严重 BUG

问题：GC 标记时，应用线程修改了引用关系，导致"存活对象被误回收"

解决方案：
  1. 增量更新（Incremental Update）：CMS 用
  2. SATB（Snapshot At The Beginning）：G1 用
```

#### 4.2.2 SATB 的"快照"本质

**SATB 的核心思想**：

```text
"在并发标记开始的那一刻，拍一张引用关系快照"
"快照时刻存活的对象，最终一定被标记为存活"
"快照时刻死亡的对象，可能被标记为存活（floating garbage）"
"但绝不会漏标（不会误回收存活对象）"

为什么"快照时刻存活"= 安全：
  - 快照时刻存活：被某个 GC Root 引用，或被其他存活对象引用
  - 并发期间引用关系变化：新引用必然来自"快照存活对象"或"新对象"
  - 新对象在并发标记期间分配，本身被特殊处理（标记为 implicitly alive）

SATB 的"快照"不是真的拍一张图，而是通过"写屏障"维持：
  - 应用线程修改引用 A.field = null（断开 A->B）
  - 写屏障捕获这个修改，把 B 加入 SATB 队列
  - 最终标记阶段，处理 SATB 队列：B 当作"快照存活"标记

效果：等于"假装引用关系没变"，按快照时刻标记
```

**SATB 的写屏障实现**：

```text
G1 SATB 写屏障（伪代码）：

void satb_write_barrier(oop* field) {
    // 在 *field 被覆盖前，先把"原来的引用对象"入队
    oop old_value = *field;
    if (old_value != NULL) {
        satb_queue.enqueue(old_value);  // 加入当前线程的 SATB 队列
    }
    // 实际写入新值由调用方完成
}

为什么是"前置"写屏障：
  - 增量更新是"后置"：写入后，把"新引用"入队
  - SATB 是"前置"：写入前，把"原引用"入队
  - 区别：
    * 增量更新：关心"新增的引用"（黑变灰）
    * SATB：关心"消失的引用"（按快照存活）
```

#### 4.2.3 SATB vs 增量更新的本质区别

| 维度 | SATB（G1） | 增量更新（CMS） |
|------|-----------|---------------|
| 快照时机 | 标记开始时 | 标记过程中（流式） |
| 写屏障 | 前置（记旧值） | 后置（记新值） |
| 标记对象 | 快照存活（含 floating garbage） | 实际存活（无 floating garbage） |
| 重新标记 | 短（处理 SATB 队列） | 长（重新扫描根 + dirty card） |
| 漏标风险 | 无 | 无 |
| 误标风险 | 有（floating garbage） | 无 |
| 适用场景 | 标记对象多，引用变化频繁 | 标记对象少，引用变化少 |

**为什么 G1 选 SATB**：

```text
1. 重新标记短：
   - SATB：处理 SATB 队列（O(队列长度)）- 通常 10-50ms
   - 增量更新：重新扫描根 + dirty card - 通常 100-500ms
   - G1 追求低停顿，SATB 的"短重新标记"更友好

2. 引用变化频繁场景：
   - IM 网关每秒 5w 消息处理，引用变化极频繁
   - 增量更新会记录大量"新引用"，重新标记要全扫
   - SATB 只记"消失的引用"，量更可控

3. floating garbage 可接受：
   - SATB 会产生 5-10% 的 floating garbage（本可回收但没回收）
   - 但下一轮并发标记会回收，不会累积
   - G1 接受这个 trade-off
```

**为什么 CMS 选增量更新**：

```text
1. CMS 老年代为主，引用变化少：
   - Old 区主要是长期存活对象，引用关系稳定
   - 增量更新记录的"新引用"少，重新标记开销可控

2. CMS 不追求极致低停顿：
   - CMS 重新标记 100-500ms 可接受
   - 不需要 SATB 的"短重新标记"优势

3. CMS 担心 floating garbage 累积：
   - CMS 没有 Mixed GC，Old 区只能 Full GC 回收
   - floating garbage 累积会触发 Full GC，灾难
```

#### 4.2.4 并发标记四阶段详解

```
┌────────────────────────────────────────────────────────────────┐
│  阶段1：初始标记（Initial Mark）                                 │
│  - STW，借 Young GC 的车                                         │
│  - 标记 GC Roots 直接引用的对象                                   │
│  - 时长：< 50ms（与 Young GC 合并，几乎无额外开销）                │
│                                                                │
│  阶段2：并发标记（Concurrent Mark）                              │
│  - 与应用并发，1 个 Concurrent Mark Thread                       │
│  - 从 GC Roots 遍历整个堆的对象图                                │
│  - 处理 SATB 队列（保持快照语义）                                 │
│  - 时长：2-5s（不 STW，但占 1 个 CPU）                            │
│                                                                │
│  阶段3：最终标记（Remark）                                       │
│  - STW，处理剩余 SATB 队列                                       │
│  - 重新标记未被处理的引用                                         │
│  - 时长：10-50ms                                                │
│                                                                │
│  阶段4：筛选回收（Cleanup）                                      │
│  - 部分 STW（统计部分），部分并发                                 │
│  - 统计每个 Region 的存活对象大小                                 │
│  - 排序 Region 按回收价值                                        │
│  - 标记完全为空的 Region 为"可回收"                                │
│  - 时长：10-30ms                                                │
│                                                                │
│  ─────── 等待下一次 Mixed GC ───────                            │
│                                                                │
│  Mixed GC：实际回收 Old Region                                   │
│  - STW，按回收价值排序选择 Region                                 │
│  - 疏散存活对象到空 Region                                        │
│  - 时长：50ms（MaxGCPauseMillis 控制）                            │
└────────────────────────────────────────────────────────────────┘
```

#### 4.2.5 阶段1 为什么能"借 Young GC 的车"

**初始标记的标记范围**：

```text
初始标记只标记 GC Roots 直接引用的对象：
  - 栈帧中的局部变量
  - 全局变量 / 静态字段
  - JNI 全局引用
  - 同步监视器（synchronized 持有的对象）

为什么"借 Young GC 的车"：
  Young GC 必须 STW（复制存活对象到 Survivor）
  Young GC 时所有线程进入 Safepoint
  Young GC 时本来就要扫描 GC Roots（找跨代引用）
  - 这两个操作完全重叠，可以合并

效果：
  - 单独初始标记：STW 50ms
  - 合并到 Young GC：几乎无额外开销（Young GC 50ms 不变）
  - G1 的"initial mark piggybacking"优化
```

**触发条件**：

```text
-XX:InitiatingHeapOccupancyPercent=45  # Old 区 45% 触发

当 Young GC 后 Old 区使用率 >= 45%：
  - 下一次 Young GC 自动升级为"Initial Mark Young GC"
  - 在 Young GC 后多一步：标记 GC Roots 直接引用的对象
  - 标记完成后，启动 Concurrent Mark Thread（阶段2）

日志特征：
  [GC pause (G1 Evacuation Pause) (young) (initial-mark)]
  ──────────────────────────────                ────────────
        普通的 Young GC                          额外的初始标记
```

#### 4.2.6 阶段3 为什么 STW

**最终标记处理什么**：

```text
并发标记期间，应用线程持续写入 SATB 队列：
  Thread-1 的 SATB 队列：[obj_a, obj_b, obj_c, ...]
  Thread-2 的 SATB 队列：[obj_d, obj_e, ...]
  ...

并发标记线程扫描时，可能没扫到这些"被覆盖前的旧引用"
  - 这些对象按 SATB 语义应标记为存活
  - 但并发标记可能已经过去，没回头标记

最终标记 STW：
  1. 所有应用线程进入 Safepoint
  2. 处理所有 SATB 队列的剩余元素
  3. 重新扫描根（少量）
  4. 标记完成

为什么必须 STW：
  - 如果不 STW，处理 SATB 队列时应用还在写入新元素
  - 永远追不上，无法收敛
  - STW 后队列不再增长，可以完整处理
```

**SATB 重新标记 vs CMS 重新标记**：

```text
CMS 重新标记（增量更新）：
  1. 重新扫描 GC Roots（栈 / 全局变量）
  2. 扫描所有 dirty card（增量更新记录的"新引用"）
  3. 重新标记未处理的对象
  时长：100-500ms（dirty card 多）

SATB 重新标记：
  1. 处理 SATB 队列（被覆盖的旧引用）
  2. 重新扫描根（少量，主要处理 JNI 引用）
  时长：10-50ms（SATB 队列长度有限）

SATB 重新标记短的根因：
  - SATB 队列每线程有上限（默认 1KB ≈ 128 个引用）
  - 满了会触发"主动 SATB 处理"（应用线程同步处理）
  - 最终标记只需处理"残余"部分
```

#### 4.2.7 阶段4 为什么不直接回收

**筛选回收做什么**：

```text
1. 统计每个 Region 的存活对象大小（liveness）
   - 并发标记扫描时记录每个 Region 的"被标记对象数"
   - 计算 Region 存活率 = 存活对象大小 / Region 大小

2. 排序 Region 按回收价值
   - 回收价值 = Region 大小 × (1 - 存活率) - RSet 扫描开销
   - 高回收价值的 Region 优先回收

3. 标记完全为空的 Region 为"可立即回收"
   - 存活率 = 0 的 Region 加入"立即回收列表"
   - 这些 Region 在 Cleanup 阶段直接回收（不进 Mixed GC）

4. 选择 CSet（Collection Set）候选
   - 根据 MaxGCPauseMillis 和 G1MixedGCCountTarget
   - 选择 8 批 Region 作为后续 Mixed GC 的目标
```

**为什么不直接回收**：

```text
筛选回收阶段是"部分 STW"（统计部分 STW，排序部分并发）
如果直接回收：
  - 需要疏散存活对象，时间长
  - 突破 MaxGCPauseMillis 目标
  - 与应用并发会有竞态

G1 的设计：
  筛选回收 = "做计划"（统计 + 排序 + 选 CSet）
  Mixed GC = "执行计划"（疏散 + 回收）

这样：
  - 筛选回收 STW 短（10-30ms，只统计）
  - Mixed GC 可控（50ms，按计划执行）
  - 计划可调整（如果期间有新分配，下次重新计划）
```

#### 4.2.8 SATB 的 floating garbage 问题

**floating garbage 的产生**：

```text
并发标记开始时刻：T0
  - 对象 X 被 A 引用（X 存活）
  - 快照语义：X 标记为存活

并发标记期间：T1
  - A.field = null（A 不再引用 X）
  - X 实际成为垃圾
  - 但 SATB 写屏障捕获了"X 被覆盖前"的引用
  - X 仍然被标记为存活

并发标记结束：T2
  - X 被标记为存活（按快照）
  - 实际 X 是垃圾（floating garbage）
  - X 不会被这次 GC 回收

下一轮并发标记：T3
  - 如果 X 仍然无引用，X 被标记为垃圾，回收
  - floating garbage 存活 1 轮 GC 周期
```

**floating garbage 的影响**：

```text
对 IM 网关：
  - 4GB 堆，5-10% floating garbage = 200-400MB
  - 不影响正确性，只影响内存利用率
  - 下一轮 GC 会回收（不会累积）

如果 floating garbage 过多：
  - Old 区使用率虚高
  - 频繁触发并发标记（IHOP）
  - 实际可回收的 Region 少（Mixed GC 没东西可回收）
```

**缓解方案**：

```text
1. 缩短并发标记周期：
   - 降低 IHOP（45% -> 35%）：更早触发并发标记
   - 但更频繁的并发标记增加 CPU 开销

2. G1PeriodicGCInterval（JDK 12+）：
   - 定时触发并发标记（即使没到 IHOP）
   - 如 -XX:G1PeriodicGCInterval=30m，每 30 分钟一次
   - 清理 floating garbage

3. 业务层避免：
   - 减少长生命周期对象的引用变更
   - 缓存用 WeakReference / SoftReference
   - 大对象用对象池（减少创建销毁）
```

#### 4.2.9 小结

```text
SATB 与并发标记四阶段的核心：
  1. SATB 通过"前置写屏障 + 快照语义"避免漏标
  2. 牺牲准确性（floating garbage），换重新标记短
  3. 四阶段分工：
     - 初始标记：借 Young GC 的车，几乎免费
     - 并发标记：占 1 CPU，2-5s，不 STW
     - 最终标记：STW 10-50ms，处理 SATB 队列
     - 筛选回收：STW 10-30ms，做计划不执行
  4. Mixed GC 是"执行计划"，与并发标记分离
  5. floating garbage 不累积，下一轮回收
```

---

### 4.3 Mixed GC 触发条件与回收价值计算

#### 4.3.1 Mixed GC 的完整触发链路

```
┌──────────────────────────────────────────────────────────────────┐
│  Step 1：Young GC 后检查 Old 区使用率                              │
│    if (old_used_rate >= IHOP=45%) {                                │
│        触发并发标记                                                 │
│    }                                                               │
├──────────────────────────────────────────────────────────────────┤
│  Step 2：并发标记四阶段（详见 4.2）                                │
│    初始标记 -> 并发标记 -> 最终标记 -> 筛选回收                     │
│    输出：每个 Region 的存活对象大小 + 回收价值排序                   │
├──────────────────────────────────────────────────────────────────┤
│  Step 3：选择 Mixed GC 候选 CSet                                   │
│    for each Old Region:                                            │
│      if (存活率 < G1MixedGCLiveThresholdPercent=65%) {             │
│          加入候选 CSet                                              │
│      }                                                             │
│    按 MaxGCPauseMillis=50 切分为 G1MixedGCCountTarget=8 批          │
├──────────────────────────────────────────────────────────────────┤
│  Step 4：后续 8 次 Young GC 升级为 Mixed GC                        │
│    每次Mixed GC = Young GC + 回收 1 批 Old Region                   │
│    每次Mixed GC 时长 <= MaxGCPauseMillis=50ms                       │
├──────────────────────────────────────────────────────────────────┤
│  Step 5：8 次Mixed GC 完成后                                       │
│    回到普通 Young GC                                                │
│    等待下一轮 IHOP 触发                                             │
└──────────────────────────────────────────────────────────────────┘
```

#### 4.3.2 IHOP 触发并发的精细逻辑

**静态 IHOP vs 自适应 IHOP**：

```text
静态 IHOP（JDK 8 默认）：
  -XX:InitiatingHeapOccupancyPercent=45
  - Old 区使用率 >= 45% 触发并发标记
  - 简单粗暴，但不适配业务负载

自适应 IHOP（JDK 9+ 默认）：
  -XX:+G1UseAdaptiveIHOP  # 默认开
  - G1 根据历史"标记时长 + 回收时长"动态调整 IHOP
  - 目标：让并发标记在"刚好不晚"的时机启动
  - 范围：[10%, 70%]

自适应 IHOP 的算法：
  - 如果上一轮标记 + 回收耗时长，IHOP 降低（更早启动）
  - 如果上一轮标记 + 回收耗时短，IHOP 升高（更晚启动）
  - 避免"过早并发标记"（浪费 CPU）和"过晚并发标记"（来不及回收）
```

**IM 网关的 IHOP 实测**：

```text
配置：-XX:InitiatingHeapOccupancyPercent=45 -XX:+G1UseAdaptiveIHOP

实测（JDK 17）：
  启动期：IHOP = 45%
  运行 1 小时后：IHOP = 38%（标记耗时长，降低）
  运行 1 天后：IHOP = 42%（稳定）
  凌晨低峰：IHOP = 50%（标记快，升高）
  白天高峰：IHOP = 35%（标记慢，降低）

效果：自适应 IHOP 让并发标记在"业务负载允许时"启动
```

#### 4.3.3 回收价值的精确计算

**回收价值公式**：

```text
回收价值（garbage reclaim value）=
  Region 大小 × (1 - 存活率) - RSet 扫描开销 - 疏散开销

具体计算：
  - Region 大小：4MB
  - 存活率：并发标记扫描出的"标记对象总大小" / 4MB
  - RSet 扫描开销：RSet Entry 数 × 单 Entry 扫描时间（约 100ns）
  - 疏散开销：存活对象数 × 单对象复制时间（约 1μs）

举例（Region A，存活率 30%）：
  回收价值 = 4MB × 70% - 200 entries × 100ns - 1000 obj × 1μs
          = 2.8MB - 20μs - 1ms
          ≈ 2.8MB（扫描和疏散开销可忽略）

举例（Region B，存活率 80%）：
  回收价值 = 4MB × 20% - 200 entries × 100ns - 4000 obj × 1μs
          = 0.8MB - 20μs - 4ms
          ≈ 0.8MB（回收价值低，但疏散开销高）
```

**G1MixedGCLiveThresholdPercent 的作用**：

```text
-XX:G1MixedGCLiveThresholdPercent=65

含义：存活率 < 65% 的 Region 才参与 Mixed GC
原因：
  - 存活率 > 65% 的 Region 回收价值低
  - 疏散开销大（要复制大量存活对象）
  - 不如不回收，等下一次（存活率可能降低）

IM 网关默认 65%：
  - 凌晨低峰：缓存对象没失效，存活率高，65% 阈值合理
  - 业务高峰：缓存频繁失效，存活率低，65% 阈值可放宽
```

#### 4.3.4 G1MixedGCCountTarget 的"分批回收"

**为什么分 8 次**：

```text
假设 Old 区有 100 个 Region 符合回收条件（存活率 < 65%）

方案1：1 次回收完
  - 疏散 100 个 Region 的存活对象
  - 时长：500ms（突破 MaxGCPauseMillis=50）
  - 不可接受

方案2：分 8 次回收
  - 每次疏散 12-13 个 Region
  - 时长：50ms（符合目标）
  - 总耗时：8 次 × 5 分钟 = 40 分钟

方案3：分 16 次回收
  - 每次疏散 6-7 个 Region
  - 时长：25ms（更短）
  - 总耗时：16 次 × 5 分钟 = 80 分钟（太慢）

8 次是 trade-off：单次停顿可控 + 总周期不太长
```

**分批的"贪心 + 停顿目标"算法**：

```text
G1 选择每批 CSet 的算法：

输入：候选 Region 列表（按回收价值降序）
     MaxGCPauseMillis=50ms
     G1MixedGCCountTarget=8

算法：
  1. 估算第一批的目标回收 Region 数 = 总候选数 / 8
  2. 从回收价值最高的开始选，累加"疏散时长估算"
  3. 当"疏散时长估算" > 50ms 时停止
  4. 这就是第一批 CSet
  5. 下一次 Mixed GC 从剩余候选继续选

效果：
  - 高价值 Region 优先回收
  - 单次停顿 < 50ms
  - 8 次完成所有候选（如果业务稳定）
```

#### 4.3.5 现象1根因深挖：Mixed GC 频繁但 Old 区不降

**现象回顾**：

```text
现象1：
  - Mixed GC 每 30s 触发 1 次（正常 5 分钟 1 次）
  - Old 区使用率从 70% 不降反升到 78%
  - 单次 Mixed GC 回收的 Region 数从 50 降到 5
```

**根因分析**：

```text
Step 1：为什么 Mixed GC 频繁触发（30s 1 次）？
  - Mixed GC 由 Young GC 升级而来
  - Young GC 触发条件：Eden 满
  - Eden 大小 = 4GB × 40% = 1.6GB
  - 凌晨低峰，IM 消息每秒 1k 条，每条 1KB
  - 1.6GB / (1k × 1KB) = 1600s = 26 分钟（理论）
  - 实际 30s 触发，说明 Eden 远小于 1.6GB

  可能原因：
  - Survivor 不够，提前晋升 Old
  - 大对象直接进 Old
  - 业务分配速率异常

Step 2：为什么回收的 Region 数从 50 降到 5？
  - 回收价值排序后，前 5 个 Region 已经"达标"50ms 停顿
  - 说明前 5 个 Region 疏散开销大（存活对象多）
  - 存活对象多 = 存活率高
  - 存活率高 = 凌晨缓存对象没失效

Step 3：为什么 Old 区使用率不降反升？
  - Mixed GC 回收 5 个 Region = 20MB
  - 但 Young GC 每次晋升到 Old 的对象 > 20MB
  - 净增 = 晋升 - 回收 > 0
  - Old 区持续增长
```

**完整因果链**：

```text
凌晨 02:00：
  - 业务低峰，IM 消息量从 5w QPS 降到 1k QPS
  - 但缓存预热任务开始（健康报告 PDF 生成 + 数据同步）
  - 缓存对象大量分配，进入 Eden

凌晨 02:30：
  - 缓存对象经历多次 Young GC，晋升到 Old
  - Old 区使用率从 50% 升到 70%
  - 触发 IHOP，启动并发标记

凌晨 03:00：
  - 并发标记完成，统计 Region 存活率
  - 凌晨缓存对象还没失效，存活率 70-80%
  - 大部分 Region 存活率 > 65% 阈值，不参与回收
  - 只有 5 个 Region 存活率 < 65%，进入 CSet

凌晨 03:00-03:12：
  - 每次 Young GC 升级为 Mixed GC
  - 但每次只能回收 5 个 Region（候选少）
  - 而缓存对象持续晋升 Old
  - Old 区净增长，使用率升到 78%

凌晨 03:12：
  - Old 区使用率 92%，触发 Evacuation Failure
  - 现象3 发生
```

**防护方案**：

```text
方案1：调整 G1MixedGCLiveThresholdPercent
  - 65% -> 80%（允许回收存活率高的 Region）
  - 优点：Mixed GC 回收更多 Region
  - 缺点：疏散开销大，停顿可能突破 50ms

方案2：调整 IHOP
  - 45% -> 35%（更早触发并发标记）
  - 优点：更早开始 Mixed GC，避免 Old 区涨上去
  - 缺点：并发标记更频繁，CPU 占用高

方案3：业务层优化
  - 凌晨缓存预热改为"预热到 Eden"（短生命周期）
  - 用 WeakReference / SoftReference 包装缓存
  - 缓存设置 TTL，凌晨低峰主动失效

方案4：监控预警
  - Old 区使用率 > 75% 告警
  - Mixed GC 频率 > 1/分钟 告警
  - 单次 Mixed GC 回收 Region < 10 告警
```

#### 4.3.6 小结

```text
Mixed GC 触发与回收价值的核心：
  1. IHOP（45%）触发并发标记，自适应 IHOP 根据历史调整
  2. 并发标记统计每个 Region 的存活率
  3. 存活率 < 65% 的 Region 进入候选 CSet
  4. 按 MaxGCPauseMillis 分 8 批回收
  5. 回收价值 = Region 大小 × (1 - 存活率) - 扫描和疏散开销
  6. 现象1 根因：凌晨缓存对象存活率高，候选 Region 少，回收 < 晋升
```

---

### 4.4 Evacuation Failure / Humongous Allocation / Full GC 的根因与防护

#### 4.4.1 Evacuation（疏散）的底层机制

**Evacuation 的核心动作**：

```text
"把存活对象从 from-region 复制到 to-region，原 from-region 整体回收"

Young GC 的 Evacuation：
  from: Eden Region + Survivor Region
  to:   新 Survivor Region + Old Region（晋升的对象）

Mixed GC 的 Evacuation：
  from: Eden Region + Survivor Region + 部分 Old Region
  to:   新 Survivor Region + Old Region + 空 Region

Evacuation 的步骤：
  Step 1：扫描 GC Roots，找到直接引用的对象
  Step 2：扫描 RSet，找到跨 Region 引用的对象
  Step 3：复制存活对象到 to-region（含 forwarded header）
  Step 4：更新所有引用指向新地址
  Step 5：from-region 整体标记为 Free
```

**To-space 的概念**：

```text
Evacuation 需要"目标空间"（to-space）：
  - Young GC：Survivor Region + 部分晋升的 Old Region
  - Mixed GC：上述 + 空Region（接收疏散的 Old 存活对象）

To-space 不足 = Evacuation Failure
```

#### 4.4.2 Evacuation Failure 的触发条件

**四种触发场景**：

```text
场景1：晋升率突增
  - Survivor 不够装晋升对象
  - 触发"promote failure"
  - 例：凌晨缓存对象大量晋升

场景2：Humongous 占用 to-space
  - 大对象独占多个 Region
  - 这些 Region 不能作为 to-space
  - 可用 to-space 减少

场景3：碎片化
  - to-region 有空闲但不连续
  - 大对象放不下
  - 例：缓存对象的 Region 内部碎片

场景4：Mixed GC 速度跟不上分配速度
  - Mixed GC 回收 5 个 Region
  - 但业务分配 + 晋升消耗 10 个 Region
  - 净亏 5 个 Region，最终 to-space 耗尽
```

**Evacuation Failure 的退化路径**：

```text
Evacuation Failure
       │
       ├─ 1. 放弃疏散，已经疏散的对象回滚
       │
       ├─ 2. 当前 GC 转为"标记清除"（不疏散，只标记）
       │     - 已标记的存活对象保持原位
       │     - 未标记的对象直接标记为"可回收"
       │     - 但 Region 不立即释放
       │
       ├─ 3. 触发 Full GC（Serial Full）
       │     - 单线程标记整个堆
       │     - 单线程整理整个堆（压缩碎片）
       │     - 时长：2-5s（4GB 堆）
       │
       └─ 4. Full GC 完成，堆被压缩，但业务已受影响
```

#### 4.4.3 为什么 Full GC 用 Serial Full

**Serial Full 的"单线程"原因**：

```text
G1 的 Full GC 是"兜底"机制，不是常规路径：
  - 设计目标：尽量不触发
  - 触发条件：Evacuation Failure / 元空间 OOM / 等
  - 实现：复用 JDK 1.0 的 Serial Full（Serial Old Collector）

为什么不用多线程：
  1. 历史原因：G1 Full GC 是"应急"，开发优先级低
  2. 单线程简单可靠：应急机制不需要性能优化
  3. 多线程整理需要额外同步：复杂度高
  4. JDK 12 优化：G1 Full GC 改为多线程（JEP 344）
     - 但仍比 G1 的常规 GC 慢 10 倍以上

JDK 17 的 G1 Full GC：
  - 多线程标记（ParallelGCThreads=4）
  - 多线程整理（ParallelGCThreads=4）
  - 但仍是"全堆 STW"
  - 时长：500ms-1s（4GB 堆）
```

**IM 网关的 2.3s 停顿分析**：

```text
JDK 8 的 Serial Full（单线程）：
  - 4GB 堆整理：2-3s
  - 单 CPU 满载
  - STW 期间所有应用线程暂停

JDK 17 的多线程 Full GC：
  - 4GB 堆整理：500ms-1s
  - 4 CPU 满载
  - 仍有 STW，但短

IM 网关在 JDK 8 上：2.3s 停顿（符合 JDK 8 Serial Full 特征）
升级 JDK 17 后预期：500ms-1s（10x 改善，但仍致命）
```

#### 4.4.4 Full GC 后 Old 区使用率 5 分钟又涨回 85% 的原因

**现象分析**：

```text
03:12 Full GC 完成，Old 区使用率 92% -> 65%
03:17 Old 区使用率 65% -> 85%（5 分钟涨 20%）

可能原因：
1. 业务分配速率异常
   - 凌晨 03:17 应该是低峰
   - 但缓存预热可能还在跑
   - 每秒分配 100MB，5 分钟 30GB（远超 4GB 堆，不合理）

2. 晋升率突增
   - Survivor 不够，对象直接晋升 Old
   - 5 分钟晋升 800MB（20% × 4GB）

3. 大对象直接进 Old
   - 5 个 PDF 4.2MB = 21MB（远小于 800MB）
   - 不是主因

4. floating garbage 累积
   - Full GC 不清理 floating garbage（按 SATB 语义）
   - 但 5 分钟不足以累积 800MB

最可能的根因：
  - 缓存预热任务持续运行
  - 缓存对象经历 Young GC 晋升 Old
  - 5 分钟晋升 800MB（约 2.7MB/s 晋升率）
  - 配合"Survivor 不够"导致晋升率突增
```

**完整的 Evacuation Failure 因果链**：

```text
凌晨 02:00：缓存预热任务启动（健康报告 PDF + 数据同步）
   │
   ├─ 缓存对象分配速率 10MB/s（远超业务正常 1MB/s）
   ├─ Eden 快速填满（1.6GB / 10MB/s = 160s）
   ├─ Young GC 频率从 1/分钟升到 1/30秒
   │
凌晨 02:30：
   ├─ 缓存对象经历多次 Young GC，Survivor 不够
   ├─ 晋升到 Old，Old 区使用率 50% -> 70%
   ├─ 触发 IHOP，启动并发标记
   │
凌晨 03:00：
   ├─ 并发标记完成
   ├─ 但缓存对象存活率高（仍在用），存活率 > 65%
   ├─ 候选 CSet 只有 5 个 Region
   ├─ Mixed GC 每次回收 5 个 = 20MB，但晋升 50MB
   ├─ Old 区净增长 30MB / 次
   │
凌晨 03:12：
   ├─ Old 区使用率达 92%
   ├─ Mixed GC 疏散时 to-space 不足
   ├─ 触发 Evacuation Failure
   ├─ 退化为 Full GC，停顿 2.3s
   ├─ 10w 长连接 30% 断线
   │
凌晨 03:12-03:17：
   ├─ Full GC 后 Old 区 65%
   ├─ 但缓存预热任务还在跑
   ├─ 5 分钟内又晋升 800MB
   ├─ Old 区使用率回升到 85%
```

#### 4.4.5 Evacuation Failure 的防护方案

**四层防护**：

```text
L1：内存预留层
  - G1ReservePercent=15（保留 15% 内存应对突发）
  - -XX:+AlwaysPreTouch（启动预触摸，避免运行时缺页）
  - 堆固定 -Xms4g -Xmx4g（避免动态扩展）

L2：监控预警层
  - Old 区使用率 > 75% 告警（提前 15 分钟）
  - 晋升率 > 50MB/s 告警
  - Mixed GC 频率 > 1/分钟告警
  - 单次 Mixed GC 回收 Region < 10 告警

L3：自动处置层
  - K8s HPA 触发副本扩容
  - 业务限流（Sentinel 降级非核心功能）
  - 缓存预热任务自动暂停

L4：兜底层
  - 多副本分散流量（避免单副本 Full GC 影响全部）
  - 客户端重试 + 心跳超时延长
  - 故障演练（每月一次 Evacuation Failure 演练）
```

**G1ReservePercent 的精算**：

```text
-XX:G1ReservePercent=15

含义：保留 15% 堆内存（600MB）作为"应急 to-space"
  - 不参与常规分配
  - Evacuation 时优先使用

精算：
  - IM 网关 4GB 堆，15% = 600MB
  - 单次 Young GC 晋升峰值 200MB
  - 600MB / 200MB = 3 倍冗余
  - 应对 3 次突发晋升

调整建议：
  - 业务稳定：10%（400MB）
  - 业务波动大：15-20%（600-800MB）
  - 极端场景：25%（1GB）
```

#### 4.4.6 Humongous Allocation 的底层机制

**Humongous Object 的判定**：

```text
Humongous Object 阈值 = Region 大小 / 2

Region 4MB → Humongous 阈值 = 2MB
Region 16MB → Humongous 阈值 = 8MB

判定规则：
  - 对象大小 > Region/2：Humongous
  - 对象大小 = 4.2MB，Region 4MB → 4.2MB > 2MB → Humongous

分配规则：
  - 找连续 N 个空 Region（N = ceil(对象大小 / Region 大小))
  - 4.2MB 对象 → 2 个 Region（4MB + 0.2MB 占用 2 个 Region）
  - 实际占用 8MB（4MB + 4MB，第二个 Region 浪费 3.8MB）
```

**Humongous Object 的回收时机**：

```text
普通 Young GC：
  - 不回收 Humongous Object
  - 因为 Young GC 只看 Eden / Survivor

并发标记阶段：
  - 标记 Humongous Object 的存活状态
  - 如果 Humongous Object 无引用，标记为"可回收"

筛选回收阶段（并发标记阶段4）：
  - 完全无引用的 Humongous Region 直接回收
  - 不进 Mixed GC（因为 Humongous 不参与疏散）

Mixed GC：
  - 不回收 Humongous Object
  - Humongous Object 只在并发标记后的 Cleanup 阶段回收

效果：
  - Humongous Object 必须等并发标记才能回收
  - 如果频繁分配 Humongous，会频繁触发并发标记
```

#### 4.4.7 现象4根因深挖：5 个 PDF 触发 5 次并发标记

**现象回顾**：

```text
现象4：
  - 5 个 Humongous Region，每个 4MB
  - 每个对象 4.2MB（略超 2MB 阈值）
  - 每分配 1 个触发 1 次并发标记
  - 凌晨 02:55 突发分配（健康报告 PDF）
```

**为什么"每分配 1 个 Humongous 触发 1 次并发标记"**：

```text
G1 的 Humongous 分配策略：
  - 每次分配 Humongous Object，检查 Old 区使用率
  - 如果 Old 区 + 新 Humongous > IHOP，触发并发标记
  - IHOP=45%，Old 区当前 70%，新 Humongous 8MB
  - 70% + 8MB/4GB = 70.2% > 45%，触发并发标记

更精确：G1 的"主动并发标记"
  - 如果连续分配 Humongous，每次都检查
  - 即使没超过 IHOP，也可能触发
  - 设计意图：Humongous 通常生命周期长，提前标记

5 个 PDF 分配：
  PDF-1 分配 → 检查 → 触发并发标记 1
  PDF-2 分配 → 检查 → 触发并发标记 2
  ...
  PDF-5 分配 → 检查 → 触发并发标记 5

5 次并发标记叠加：
  - 1 个 Concurrent Mark Thread，CPU 400%
  - 标记 4GB 堆需要 2-5s，5 次叠加 = 10-25s
  - 期间应用线程 CPU 几乎为 0
  - 业务消息处理延迟
```

**防护方案**：

```text
方案1：调整 Region 大小（最直接）
  - 4MB -> 16MB（Humongous 阈值 = 8MB）
  - PDF 4.2MB < 8MB，不再 Humongous
  - 走普通 Young GC 路径
  - 优点：根治
  - 缺点：Region 数量减少（4GB / 16MB = 256 个），扫描开销略增

  调整后：
  -XX:G1HeapRegionSize=16m
  - Region 数量：256
  - 单 Region 回收停顿：5-10ms
  - 总回收停顿：256 × 8ms = 2s（理论，实际 50ms 内）

方案2：大对象分块
  - PDF 流式生成：每 1MB 写一次，避免一次性分配 4.2MB
  - 用 ByteArrayOutputStream 分块
  - 优点：不依赖 Region 调整
  - 缺点：业务代码改动

方案3：大对象池化
  - 预分配 4.2MB ByteBuf 池
  - 复用，避免反复分配
  - 优点：性能最好
  - 缺点：内存常驻

方案4：业务错峰
  - PDF 生成从凌晨 03:00 改到 04:00
  - 避开业务低峰 + 缓存预热的"叠加效应"
  - 优点：零代码改动
  - 缺点：依赖业务调度

方案5：JDK 17 + G1 优化
  - JDK 12+ G1 优化：Humongous Object 可在 Young GC 回收（部分场景）
  - JDK 17 进一步优化：减少 Humongous 触发的并发标记
```

#### 4.4.8 现象2根因深挖：Concurrent Mark CPU 100%

**现象回顾**：

```text
现象2：
  - Concurrent Mark Thread CPU 400%（4 核满载）
  - STW 时长正常（< 50ms）
  - 应用线程 CPU 0%
  - 业务消息处理延迟
```

**根因分析**：

```text
正常情况：
  - Concurrent Mark Thread 1 个，占 1 CPU
  - 标记 4GB 堆需要 2-5s
  - CPU 占用 100%（1 核满载）
  - 应用线程可用 3 核

异常情况（CPU 400%）：
  - 1 个线程 CPU 400%？
  - 不可能（1 线程最多 1 CPU 时间片）
  - 除非：ConcGCThreads > 1

  -XX:ConcGCThreads=1 配置，但实际可能有多个线程
  - JDK 17 的 G1 并发标记可能多线程（-XX:ConcGCThreads=4）
  - 配置错误：ConcGCThreads=4 但没改

或者：
  - 5 次并发标记叠加（现象4 触发）
  - 每次标记 1 个线程，但 5 次连续触发
  - top -H 看到的是"累计"CPU（4 核都曾被占用）
  - 实际是"5 次 1 线程"被误认为"1 线程 4 核"

最可能的根因：
  - 现象4 的 5 个 PDF 触发 5 次并发标记
  - 每次并发标记 1 线程，占 1 CPU
  - 5 次连续触发，CPU 累计 5 倍
  - top 显示 1 个"Concurrent Mark Thread"CPU 400%（监控统计误差）
  - 实际是 5 次 1 线程的累积
```

**ConcGCThreads 的设置**：

```text
默认：ConcGCThreads = max(1, ParallelGCThreads / 4)
  - ParallelGCThreads=4 → ConcGCThreads=1
  - ParallelGCThreads=8 → ConcGCThreads=2

调整建议：
  - 4 core 容器：ConcGCThreads=1（默认，够用）
  - 8 core 容器：ConcGCThreads=2
  - 16 core 容器：ConcGCThreads=4

为什么不开多：
  - 并发标记占 CPU，应用线程减少
  - IM 网关业务敏感，CPU 优先给应用
  - 1 个 Concurrent Mark Thread 标记 2-5s，可接受
```

#### 4.4.9 小结

```text
Evacuation Failure / Humongous / Full GC 的核心：
  1. Evacuation 是"复制存活对象"的过程，需要 to-space
  2. To-space 不足 = Evacuation Failure = 退化为 Full GC
  3. Full GC 用 Serial Full（JDK 8）或多线程 Full GC（JDK 12+）
  4. Humongous Object 是"超过 Region/2 的大对象"，独占 Region
  5. Humongous 频繁分配 → 频繁触发并发标记 → CPU 占用
  6. 防护：内存预留 + 监控预警 + 自动处置 + 兜底
```

---

### 4.5 G1 调优参数体系与生产诊断工具链

#### 4.5.1 G1 调优参数体系全景

```
┌────────────────────────────────────────────────────────────────┐
│  G1 调优参数五层金字塔                                            │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  Layer 1：内存布局参数（基础）                                   │
│    -XX:G1HeapRegionSize=4m              # Region 大小            │
│    -XX:G1NewSizePercent=30              # Young 代最小           │
│    -XX:G1MaxNewSizePercent=50           # Young 代最大           │
│    -XX:G1ReservePercent=15              # 应急预留               │
│                                                                │
│  Layer 2：触发时机参数（启动 GC）                                 │
│    -XX:InitiatingHeapOccupancyPercent=45  # Old 区 45% 触发      │
│    -XX:+G1UseAdaptiveIHOP                # 自适应 IHOP            │
│    -XX:G1PeriodicGCInterval=0            # 周期性 GC（JDK 12+）   │
│                                                                │
│  Layer 3：停顿控制参数（用户体验）                                 │
│    -XX:MaxGCPauseMillis=50              # 目标停顿 50ms          │
│    -XX:G1MixedGCCountTarget=8           # Mixed GC 分 8 次       │
│    -XX:G1RSetUpdatingPauseTimePercent=5 # RSet 更新占 GC 5%      │
│                                                                │
│  Layer 4：回收效率参数（吞吐）                                    │
│    -XX:G1MixedGCLiveThresholdPercent=65 # 存活率阈值             │
│    -XX:MaxTenuringThreshold=15          # 晋升阈值               │
│    -XX:SurvivorRatio=8                  # Eden:Survivor=8:1      │
│    -XX:+G1EnableAdaptiveSizePolicy      # 自适应调整              │
│                                                                │
│  Layer 5：容器化参数（K8s 友好）                                   │
│    -XX:ParallelGCThreads=4              # STW GC 线程数          │
│    -XX:ConcGCThreads=1                  # 并发标记线程数         │
│    -XX:+AlwaysPreTouch                   # 预触摸堆内存           │
│    -XX:+UseStringDeduplication          # 字符串去重             │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

#### 4.5.2 参数之间的耦合关系

**关键耦合矩阵**：

| 调参 | 副作用 | 引发新问题 | 缓解 |
|------|--------|----------|------|
| MaxGCPauseMillis ↓（50→20） | Mixed GC 分更多次 | 频繁触发，Old 区不降 | 调大 G1MixedGCCountTarget |
| IHOP ↓（45→30） | 更早触发并发标记 | Concurrent Mark CPU 占用高 | 减少 Humongous 分配 |
| G1MixedGCLiveThresholdPercent ↓（65→50） | 候选 Region 少 | Mixed GC 回收不动 | 调整 G1MixedGCCountTarget |
| G1HeapRegionSize ↓（4→2MB） | Humongous 阈值降（2→1MB） | 更多 Humongous | 避免大对象分配 |
| G1HeapRegionSize ↑（4→16MB） | Humongous 阈值升（8MB） | Region 数减少，扫描开销增 | 平衡 |
| SurvivorRatio ↑（8→16） | Survivor 减小 | 晋升率突增 | 调整 MaxTenuringThreshold |
| ConcGCThreads ↑（1→4） | 并发标记快 | 应用 CPU 减少 | 容器化场景慎用 |

**经典"调一个引发三个"案例**：

```text
案例1：追求更低停顿
  原：MaxGCPauseMillis=50, G1MixedGCCountTarget=8
  调：MaxGCPauseMillis=20
  副作用：Mixed GC 分更多次（G1 自动调整 G1MixedGCCountTarget=20）
  新问题1：Mixed GC 频率从 5 分钟 1 次到 1 分钟 1 次
  新问题2：Old 区回收速度跟不上，使用率上升
  新问题3：触发 Evacuation Failure，Full GC

案例2：追求更高吞吐
  原：IHOP=45, MaxGCPauseMillis=50
  调：IHOP=70（更晚触发并发标记）
  副作用：并发标记更晚，Old 区涨到 70% 才开始
  新问题1：Mixed GC 来不及回收，Old 区继续涨
  新问题2：触发 Evacuation Failure
  新问题3：Full GC，业务受影响

案例3：追求内存利用率
  原：G1ReservePercent=15, G1MixedGCLiveThresholdPercent=65
  调：G1ReservePercent=5（减少预留）
  副作用：应急 to-space 减少
  新问题1：Evacuation Failure 概率上升
  新问题2：Full GC 频率上升
  新问题3：业务毛刺增多
```

#### 4.5.3 生产诊断工具链

**工具矩阵**：

| 工具 | 用途 | 使用场景 | 优缺点 |
|------|------|---------|--------|
| GC 日志（Xlog） | 离线分析 GC 行为 | 故障回放、调优验证 | 信息全，但需解析 |
| jstat -gc | 实时监控各区使用率 | 在线巡检 | 简单，但信息有限 |
| jcmd GC.heap_info | 查看 Region 状态 | 排查 Humongous / RSet | 信息全，但 STW |
| JFR | 持续录制 + 火焰图 | 故障回放、性能分析 | 低开销，但需 JDK 11+ |
| async-profiler | 火焰图、内存分析 | 深度性能分析 | 精确，但需 root |
| Arthas | 在线诊断 | 热更新、watch / trace | 强大，但有性能损失 |
| Prometheus + Grafana | 监控大盘 | 长期趋势、告警 | 持久，但需采集器 |

**GC 日志解析**：

```bash
# JDK 9+ 统一日志（推荐）
-Xlog:gc*=info,gc+heap=debug,gc+age=trace,gc+task=trace:\
      file=/var/log/gc/gc.log:time,level,tags:filecount=10,filesize=100m

# 关键日志解析
# 1. Young GC
[2026-08-02T03:00:00.123+0800] GC(123) Pause Young (Normal) (G1 Evacuation Pause)
  Eden regions: 320->0(320)
  Survivor regions: 32->32(32)
  Old regions: 800->805
  Humongous regions: 5->5
  Metaspace: 120MB->125MB(256MB)
  Pause time: 35ms

# 2. 并发标记阶段
[2026-08-02T03:00:01.456+0800] GC(124) Concurrent Mark Cycle
  Phase 1: Initial Mark (STW) - 5ms
  Phase 2: Concurrent Mark - 2345ms (非 STW)
  Phase 3: Remark (STW) - 25ms
  Phase 4: Cleanup (STW) - 18ms

# 3. Mixed GC
[2026-08-02T03:00:05.789+0800] GC(125) Pause Young (Mixed) (G1 Evacuation Pause)
  Eden regions: 320->0(320)
  Survivor regions: 32->32(32)
  Old regions: 805->800
  Mixed regions: 5->5
  Pause time: 42ms

# 4. Evacuation Failure
[2026-08-02T03:12:00.123+0800] GC(150) Pause Young (Mixed) (G1 Evacuation Pause) (to-space exhausted)
  Evacuation Failure!
  ...
  [2026-08-02T03:12:02.456+0800] GC(151) Full GC (Ergonomics)
  Pause time: 2300ms
```

**GC 日志分析工具**：

```bash
# 1. GCEasy（在线）
  上传 gc.log，自动分析停顿、吞吐、内存分布
  URL: https://gceasy.io/

# 2. GCViewer（本地）
  java -jar gcviewer.jar gc.log gc.png
  可视化 GC 时序图

# 3. 自研脚本（推荐）
  # 提取所有 GC 事件
  grep "GC(" gc.log | awk '{print $2, $4, $NF}'

  # 统计停顿分布
  grep "Pause time" gc.log | awk '{print $NF}' | sort -n

  # 找出超过 100ms 的 GC
  awk -F'Pause time: ' '/Pause time/ {split($2, a, "ms"); if (a[1]+0 > 100) print}' gc.log
```

**jstat -gc 实时监控**：

```bash
# 每秒采样
jstat -gc <pid> 1000

# 输出
 S0C    S1C    S0U    S1U    EC     EU     OC     OU       MC     MU     CCSC   CCSU  YGC  YGCT  FGC  FGCT  GCT
 20480  20480  0      12345  163840 98765  2097152 1509949 122880 115000 14336 13000  150 5.234  2   2.300  7.534

字段含义：
  S0C/S1C：Survivor 0/1 Capacity（KB）- G1 中无意义
  EC/EU：Eden Capacity/Used（KB）
  OC/OU：Old Capacity/Used（KB）
  MC/MU：Metaspace Capacity/Used（KB）
  YGC/YGCT：Young GC Count/Time
  FGC/FGCT：Full GC Count/Time

关键监控：
  OU/OC > 75%：Old 区告警
  FGC > 0：Full GC 告警
  YGCT / YGC > 50ms：单次 Young GC 停顿告警
```

**jcmd GC.heap_info 查看 Region 状态**：

```bash
jcmd <pid> GC.heap_info

# 输出
 garbage-first heap   total 4194304K, used 3145728K [0x0000000080000000, 0x0000000100000000)
  region size 4096K, 1024 young (4194304K), 0 survivors (0K)
  Metaspace       used 125K, capacity 256M, committed 256M, reserved 1G
  class space    used 12K, capacity 128M, committed 128M, reserved 1G

# 关键信息：
  region size 4096K：Region 大小 4MB
  1024 young：Young Region 数量（= Eden + Survivor）
  0 survivors：Survivor Region 数量

# 查看 Humongous
jcmd <pid> GC.class_histogram | head -20
```

**JFR（Java Flight Recorder）**：

```bash
# 启动 JFR 录制（持续 5 分钟）
jcmd <pid> JFR.start duration=5m filename=/tmp/recording.jfr

# 或者启动期开启（JDK 17 默认开启）
-XX:StartFlightRecording=duration=5m,filename=/tmp/recording.jfr

# 分析 JFR
# 1. JDK Mission Control（GUI）
# 2. jfr print（命令行）
jfr print --events jdk.GCPhasePause recording.jfr | head -20

# 关键事件：
  jdk.GCPhasePause：GC 停顿详情
  jdk.GarbageCollection：GC 概要
  jdk.OldObjectSample：长生命周期对象
  jdk.ObjectAllocationSample：分配热点
```

**async-profiler 火焰图**：

```bash
# 下载
wget https://github.com/async-profiler/async-profiler/releases/download/v2.9/async-profiler-2.9-linux-x64.tar.gz

# CPU 火焰图
./profiler.sh -d 60 -f /tmp/cpu.html <pid>

# 内存分配火焰图
./profiler.sh -d 60 -e alloc -f /tmp/alloc.html <pid>

# 查看火焰图
# 浏览器打开 /tmp/cpu.html
# 找出"宽墙"（占用 CPU 多的函数）
```

**Arthas 在线诊断**：

```bash
# 启动 Arthas
java -jar arthas-boot.jar <pid>

# 1. 监控 GC
[arthas@1234]$ dashboard
# 实时显示 GC 次数、停顿、各区使用率

# 2. 查看 JVM 信息
[arthas@1234]$ jvm
# 显示 GC 配置、内存池、Region 大小等

# 3. 监控方法调用
[arthas@1234]$ watch com.example.Service method '{params, returnObj}' -x 2

# 4. 追踪方法耗时
[arthas@1234]$ trace com.example.Service method

# 5. 反编译类
[arthas@1234]$ jad com.example.Service
```

**Prometheus + Grafana 监控大盘**：

```yaml
# Prometheus 采集 JVM 指标（micrometer）
management:
  endpoints:
    web:
      exposure:
        include: prometheus,health,info
  metrics:
    export:
      prometheus:
        enabled: true

# 关键指标
jvm_gc_pause_seconds_max{action="end of major GC", cause="Allocation Failure"}
jvm_gc_pause_seconds_max{action="end of minor GC"}
jvm_memory_used_bytes{area="heap", id="G1 Old Gen"}
jvm_memory_used_bytes{area="heap", id="G1 Eden"}
jvm_memory_used_bytes{area="heap", id="G1 Survivor"}
jvm_threads_states_threads{state="runnable"}
process_cpu_usage
```

#### 4.5.4 工具链反推现象根因

**现象1（Mixed GC 频繁但 Old 区不降）的反推流程**：

```text
Step 1：jstat -gc 观察 Old 区使用率
  发现：OU/OC 持续 70%-78%，Mixed GC 后不降

Step 2：GC 日志解析
  grep "Mixed" gc.log
  发现：单次 Mixed GC 回收 Region 从 50 降到 5

Step 3：jcmd GC.heap_info 查看 Region 状态
  发现：Old Region 数量 800+，存活率高

Step 4：JFR 分析
  发现：长生命周期对象主要是 Cache 对象（凌晨缓存预热）

Step 5：业务层定位
  Arthas trace CacheService.preload
  发现：缓存预热任务在凌晨 02:00 启动

根因：凌晨缓存对象存活率高，Mixed GC 候选 Region 少
```

**现象2（Concurrent Mark CPU 100%）的反推流程**：

```text
Step 1：top -H 观察线程
  发现：Concurrent Mark Thread CPU 400%

Step 2：jstack 观察线程状态
  发现："Concurrent Mark Thread" 在 RUNNABLE 状态

Step 3：GC 日志解析
  grep "Concurrent Mark" gc.log
  发现：5 分钟内 5 次并发标记

Step 4：jstat -gc 观察 Humongous
  发现：Humongous Region 数量 5

Step 5：jcmd GC.heap_info
  发现：5 个 Humongous Object，每个 4.2MB

Step 6：业务层定位
  Arthas watch PDFService.generate
  发现：每次 PDF 生成分配 4.2MB ByteBuf

根因：5 个 PDF 触发 5 次并发标记
```

**现象3（Evacuation Failure → Full GC）的反推流程**：

```text
Step 1：GC 日志解析
  grep "Evacuation Failure" gc.log
  发现：03:12 触发，to-space exhausted

Step 2：jstat -gc 历史数据
  发现：03:00-03:12 Old 区使用率 70% -> 92%

Step 3：JFR 分析
  发现：晋升率突增（200MB/s），缓存对象大量晋升

Step 4：业务层定位
  发现：缓存预热任务 + 凌晨低峰叠加

Step 5：JFR 内存分析
  发现：晋升对象主要是 Cache.Entry（每个 5KB）

根因：缓存对象大量晋升，Mixed GC 来不及回收，Old 区涨爆
```

**现象4（5 个 Humongous Region）的反推流程**：

```text
Step 1：jstat -gc
  发现：Humongous Region 数量 5

Step 2：jcmd GC.heap_info
  发现：每个 Humongous 4.2MB

Step 3：JFR 对象分配采样
  发现：4.2MB 对象来自 PDFService.generate

Step 4：Arthas watch
  watch PDFService.generate '{params, returnObj.size}' -x 2
  发现：每次生成 PDF 返回 4.2MB ByteBuf

Step 5：业务层定位
  发现：PDF 一次性生成 4.2MB，未分块

根因：PDF 4.2MB 略超 2MB 阈值，触发 Humongous
```

#### 4.5.5 小结

```text
G1 调优参数体系与诊断工具链的核心：
  1. 参数五层金字塔：内存布局 / 触发时机 / 停顿控制 / 回收效率 / 容器化
  2. 参数耦合：调一个参数可能引发 3 个新问题
  3. 诊断工具链：GC 日志 / jstat / jcmd / JFR / async-profiler / Arthas / Prometheus
  4. 反推流程：现象 → 工具定位 → 数据验证 → 业务根因
  5. 生产实践：监控大盘 + 告警 + 故障预案 + 演练
```

---

## 五、四个现象的根因深挖与四防闭环

### 5.1 现象1：Mixed GC 频繁但 Old 区不降

**根因**：

```text
凌晨 02:00 缓存预热任务启动
   ↓
缓存对象分配速率 10MB/s（远超业务正常 1MB/s）
   ↓
Eden 快速填满，Young GC 频率 1/30秒
   ↓
缓存对象经历多次 Young GC，Survivor 不够，晋升 Old
   ↓
Old 区使用率 50% -> 70%，触发 IHOP
   ↓
并发标记完成，但缓存对象存活率高（仍在用）
   ↓
存活率 > 65% 的 Region 不参与 Mixed GC
   ↓
候选 CSet 只有 5 个 Region
   ↓
Mixed GC 回收 20MB，但晋升 50MB
   ↓
Old 区净增长 30MB / 次，使用率升到 78%
```

**防护方案**：

```text
L1 调参：
  - G1MixedGCLiveThresholdPercent=65 -> 75（放宽存活率阈值）
  - IHOP=45 -> 35（更早触发并发标记）
  - G1ReservePercent=15 -> 20（增加应急预留）

L2 业务优化：
  - 缓存预热改用 WeakReference（短生命周期）
  - 缓存预热分批，避免一次性大量分配
  - 凌晨低峰主动失效缓存（释放 Old 区）

L3 监控告警：
  - Old 区使用率 > 75% 告警
  - 单次 Mixed GC 回收 Region < 10 告警
  - Mixed GC 频率 > 1/分钟告警

L4 兜底：
  - K8s HPA 扩容
  - 业务限流（暂停缓存预热）
```

### 5.2 现象2：Concurrent Mark CPU 100%

**根因**：

```text
凌晨 02:55 健康报告 PDF 生成任务启动
   ↓
PDFService.generate 一次性分配 4.2MB ByteBuf
   ↓
4.2MB > Region/2 = 2MB，触发 Humongous Allocation
   ↓
G1 检查 Old 区使用率，超过 IHOP，触发并发标记
   ↓
5 个 PDF 连续分配，5 次并发标记叠加
   ↓
Concurrent Mark Thread 持续占用 CPU
   ↓
应用线程 CPU 减少，业务消息处理延迟
```

**防护方案**：

```text
L1 调参：
  - G1HeapRegionSize=4m -> 16m（Humongous 阈值 8MB）
  - PDF 4.2MB < 8MB，不再 Humongous

L2 业务优化：
  - PDF 流式生成（每 1MB 写一次）
  - PDF 对象池化（复用 ByteBuf）
  - PDF 生成错峰（避开凌晨低峰）

L3 监控告警：
  - Humongous Region 数量 > 0 告警
  - Concurrent Mark CPU > 50% 告警
  - 并发标记频率 > 1/分钟告警

L4 兜底：
  - 业务限流（PDF 生成降级）
  - 异步生成（PDF 任务进 MQ）
```

### 5.3 现象3：Evacuation Failure → Full GC

**根因**：

```text
现象1 + 现象2 叠加
   ↓
Old 区使用率 78%（Mixed GC 不回收）+ 5 个 Humongous Region
   ↓
缓存预热 + PDF 生成持续分配
   ↓
Old 区使用率 92%
   ↓
Mixed GC 疏散时 to-space 不足
   ↓
Evacuation Failure，退化为 Full GC
   ↓
Serial Full（JDK 8）单线程整理 4GB 堆，停顿 2.3s
   ↓
10w 长连接 30% 心跳超时断线
   ↓
Full GC 后 Old 区 65%，但缓存预热继续，5 分钟涨回 85%
```

**防护方案**：

```text
L1 调参：
  - G1ReservePercent=15 -> 20（增加应急预留）
  - 升级 JDK 17（多线程 Full GC，停顿 500ms-1s）
  - 切换 ZGC（停顿 < 10ms）

L2 业务优化：
  - 缓存预热分批 + 限速
  - PDF 错峰 + 流式生成
  - 业务降级（凌晨非核心任务暂停）

L3 监控告警：
  - Old 区使用率 > 80% 告警
  - Evacuation Failure > 0 告警
  - Full GC > 0 立即告警

L4 兜底：
  - 多副本分散流量
  - 客户端心跳超时延长（60s -> 120s）
  - 故障演练（每月一次）
```

### 5.4 现象4：5 个 Humongous Region

**根因**：

```text
PDFService.generate 一次性返回 4.2MB ByteBuf
   ↓
4.2MB > Region/2 = 2MB，触发 Humongous
   ↓
每个 PDF 独占 2 个 Region（4MB + 0.2MB 占用 2 个 Region）
   ↓
实际占用 8MB / PDF（第二个 Region 浪费 3.8MB）
   ↓
5 个 PDF 占用 40MB（5 × 8MB）
   ↓
频繁触发并发标记（每个 Humongous 触发一次）
```

**防护方案**：

```text
L1 调参：
  - G1HeapRegionSize=4m -> 16m（最直接，根治）

L2 业务优化：
  - PDF 流式生成（推荐）
    ```java
    try (OutputStream os = new FileOutputStream(file);
         PdfWriter writer = new PdfWriter(os)) {
        // 流式写入，避免一次性分配 4.2MB
    }
    ```
  - PDF 对象池化
    ```java
    private static final ByteBufPool PDF_POOL = new ByteBufPool(16 * 1024 * 1024); // 16MB 池
    ByteBuf buf = PDF_POOL.acquire();
    // 使用 buf
    PDF_POOL.release(buf);
    ```
  - PDF 生成错峰

L3 监控告警：
  - Humongous 分配频率 > 1/分钟告警
  - Humongous Region 总数 > 10 告警

L4 兜底：
  - PDF 生成降级（异步生成）
  - PDF 任务限流（单副本最多 1 个并发）
```

### 5.5 四防闭环设计

**四防闭环全景**：

```text
┌──────────────────────────────────────────────────────────────┐
│  四防闭环：预判 / 监控 / 处置 / 兜底                            │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  防层1：预判（事前）                                           │
│    - 业务架构评审：JVM 约束 Checklist                          │
│    - 容量规划：基于业务峰值反推 JVM 参数                        │
│    - 故障预案：每类故障的处置流程                              │
│    - 故障演练：每月一次（Evacuation Failure / Full GC）        │
│                                                              │
│  防层2：监控（事中）                                           │
│    - JVM 指标：GC 次数 / 停顿 / 各区使用率                    │
│    - 业务指标：QPS / P99 / 心跳超时率                         │
│    - 关联指标：JVM + K8s + 业务关联分析                       │
│    - 告警：分级告警（普通 / 重要 / 紧急）                      │
│                                                              │
│  防层3：处置（事中）                                           │
│    - 自动处置：K8s HPA / 业务限流 / 任务暂停                  │
│    - 半自动：告警 + 一键处置脚本                              │
│    - 人工：值班 SRE 排查                                      │
│                                                              │
│  防层4：兜底（事后）                                           │
│    - 多副本：避免单点故障                                     │
│    - 客户端重试：心跳超时延长 / 断线重连                       │
│    - 故障回放：JFR 录制 + 日志归档                            │
│    - 复盘：每次故障 24h 内复盘，更新预案                       │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

**IM 网关的四防闭环落地**：

```text
防层1（预判）：
  - 业务架构评审：禁止一次性分配 > 2MB 对象（PDF / 大缓冲）
  - 容量规划：4 core / 8GB 容器，4GB 堆 + 2GB Direct + 256MB Metaspace
  - 故障预案：Evacuation Failure / Full GC / Direct OOM 各一份
  - 故障演练：每月一次，模拟 Evacuation Failure

防层2（监控）：
  - JVM 指标：Prometheus + Micrometer 采集 GC / 内存 / 线程
  - 业务指标：QPS / P99 / 心跳超时率 / 长连接数
  - 关联指标：GC 停顿 vs P99 毛刺 / Direct 内存 vs 心跳超时
  - 告警：Old 区 > 75% / Full GC > 0 / Direct > 80%

防层3（处置）：
  - 自动：K8s HPA（CPU > 70% 扩容）
  - 半自动：一键扩容脚本 / 一键限流脚本
  - 人工：值班 SRE 30 分钟内介入

防层4（兜底）：
  - 多副本：3 副本 + 跨可用区
  - 客户端：心跳超时 90s + 重试 3 次
  - JFR：持续录制，最近 24h 可回放
  - 复盘：每次故障 24h 内复盘
```

---

## 六、与往周专题的衔接

| 往周专题 | 与本日 Day07 的关联 |
|---------|------------------|
| 5月第3周 CAP / 分布式事务 | TCC 分布式事务的"补偿日志"对象生命周期长，易晋升 Old，是 Mixed GC 的"高存活率"主因 |
| 5月第4周 消息队列 | Kafka 消费者的"消息缓冲"对象生命周期短，正常进 Young GC；但 offset 缓存可能晋升 Old，触发 Mixed GC |
| 5月第5周 微服务 | Nacos 服务发现的"实例列表"缓存长生命周期，是 RSet 失控的常见原因 |
| 6月第1周 MySQL | HikariCP 连接池的"Connection 对象"长生命周期，每个 Connection 持有 Socket Direct Memory，与 Direct OOM 相关 |
| 6月第2周 Redis | Lettuce 客户端的 Netty ByteBuf 与 IM 网关 ByteBuf 共享 Direct Memory，是 Direct OOM 的隐藏触发点 |
| 6月第3周 ES | ES 客户端的"SearchResponse 解析对象"瞬时分配大，可能触发 Humongous |
| 6月第4周 限流降级 | Sentinel 的 QPS 统计滑动窗口对象长生命周期，是 Mixed GC"高存活率"的隐藏原因 |
| 6月第5周 支付系统 | 支付回调的"对账数据"长生命周期，易晋升 Old，Mixed GC 时存活率高 |
| 7月第1-2周 医疗信息化 | 健康报告 PDF（本日现象4 的真实业务来源）、HL7/FHIR 解析的大对象 |
| 7月第3周 K8s | K8s 容器化资源限制（4 core / 8GB）与 JVM 参数（ParallelGCThreads=4 / ConcGCThreads=1）协同；CPU Throttling 影响 Concurrent Mark |
| 7月第4周 简历项目 | 本日场景直接是简历项目"在线问诊 IM 网关"的 G1 调优延伸 |
| 本周 Day01-Day06 | 本日 Day07 是 Day06 的"深挖"延伸，从"会用 G1"到"理解 G1 内部" |

---

## 七、能力差距梳理

### 差距 1：G1 内部机制（Region / RSet / SATB）的源码级理解不足
> Day7发现

- **现状**：能讲清 G1 的 5 大机制（Region / RSet / SATB / Mixed GC / Humongous），但源码级（HotSpot `g1CollectedHeap.cpp` / `g1RemSet.cpp` / `g1SATBMarkQueueSet.cpp`）未深读
- **架构师水平**：能从源码回答"RSet 的 Coarse 精度何时触发"、"SATB 队列满了如何处理"、"并发标记的 work stealing 机制"
- **补足方向**：读 HotSpot G1 源码（`src/hotspot/share/gc/g1/`）；跟踪一次 GC 的完整流程（jcmd + 日志 + 源码）

### 差距 2：G1 调优参数的耦合关系实战经验不足
> Day7发现，延续 Day06 差距1

- **现状**：知道"调一个参数可能引发 3 个新问题"，但实战中"调参 → 副作用 → 再调参"的迭代经验不足
- **架构师水平**：能在 30 分钟内画出"G1 调参耦合矩阵"；能根据业务特征预判哪些参数最关键
- **补足方向**：第 2 周 Day04-05 实战时建立"调参矩阵"；调研 Netflix / LinkedIn 的 G1 调优案例

### 差距 3：JFR + async-profiler 的生产使用不熟
> Day7发现，延续 Day06 差距5

- **现状**：知道 JFR / async-profiler 的存在，但生产中"录制 → 分析 → 反推根因"的实战经验不足
- **架构师水平**：能用 JFR 在 5 分钟内定位"哪个对象分配最多"、"哪个方法占 CPU 最多"
- **补足方向**：第 2 周 Day02 监控诊断工具链时深入；调研 Datadog APM / Dynatrace 的火焰图产品

### 差距 4：Evacuation Failure / Full GC 的实战处置不深
> Day7发现

- **现状**：知道 Evacuation Failure 的退化路径，但实战中"Evacuation Failure → 业务降级 → 紧急扩容 → 根因定位"的处置链不熟
- **架构师水平**：能在 5 分钟内完成"Evacuation Failure 告警 → 业务限流 → 扩容 → 根因定位"
- **补足方向**：每月一次 Evacuation Failure 故障演练；调研 Google SRE 的"故障注入"实践

### 差距 5：Humongous Allocation 的业务层防护不足
> Day7发现

- **现状**：知道 Humongous 的触发条件，但"业务层如何避免一次性分配大对象"的工程实践不足
- **架构师水平**：能在业务架构评审时识别"PDF 生成 / 报表导出 / 大文件传输"等 Humongous 风险点
- **补足方向**：把"禁止一次性分配 > Region/2 对象"写入架构评审 Checklist；调研流式处理最佳实践

### 差距 6：四防闭环的工程化落地不足
> Day7发现，延续第1周差距

- **现状**：能设计"四防闭环"，但"预判 / 监控 / 处置 / 兜底"的工程化落地（自动化脚本 + 告警分级 + 演练机制）不深
- **架构师水平**：能搭建完整的四防闭环体系（自动化工具链 + SRE 流程 + 演练机制）
- **补足方向**：调研 Google SRE / Meta SRE 的故障预案体系；搭建 IM 网关的四防闭环 PoC

### 差距 7：G1 vs ZGC vs Shenandoah 的对比深度不足
> Day7发现，延续 Day03 差距

- **现状**：知道 G1 的内部机制，但 ZGC / Shenandoah 的内部机制（染色指针 / 读屏障 / Brooks Pointer）对比深度不足
- **架构师水平**：能根据业务特征（停顿 / 吞吐 / 内存）选择合适的 GC；能设计 G1 -> ZGC 的迁移方案
- **补足方向**：第 2 周深挖 ZGC；调研 Azul Zing / Prime 的"No Pause"GC 实践

### 差距 8：JVM 调优与业务架构的协同设计深度不足
> Day7发现，延续 Day06 差距7

- **现状**：JVM 调优偏向"事后救火"，业务架构设计阶段未充分考虑 JVM 约束（如缓存设计引发 Mixed GC、PDF 生成引发 Humongous）
- **架构师水平**：能在业务架构评审时提出 JVM 约束（缓存用 WeakReference / PDF 流式生成 / 大对象分块）
- **补足方向**：把 JVM 约束写入架构评审 Checklist；调研 Google SRE 的"性能预算"实践

---

## 八、本周总结

### 8.1 本周学习路径回顾

```text
Day01：JVM 内存模型与对象生命周期
        - 堆 / 栈 / 方法区 / 元空间 / 直接内存
        - 对象创建流程 / TLAB / 对象内存布局
        - 可达性分析 / 三色标记 / 逃逸分析基础

Day02：GC 算法与分代收集理论
        - 标记清除 / 复制 / 标记整理
        - 跨代引用 / Card Table / 写屏障（SATB vs 增量更新）
        - Safepoint / 并发标记四阶段

Day03：GC 收集器全谱系
        - Serial / ParNew / Parallel / CMS / G1 / ZGC / Shenandoah
        - Region 模型 / Mixed GC / 染色指针 / 读屏障
        - GC 收集器选型决策树

Day04：类加载机制与字节码
        - 双亲委派 / SPI 打破 / TCCL
        - Tomcat WebappClassLoader / Spring Boot LaunchedURLClassLoader
        - javap 字节码 / 栈帧结构 / CGLIB 字节码增强 / JDK 17 强封装

Day05：JIT 编译优化
        - 解释器 + JIT 混合模式 / 分层编译 5 层
        - C1 / C2 / Graal / 方法内联 / 逃逸分析
        - 循环优化 / 退优化 / JIT 诊断工具链

Day06：串联整合 - IM 网关全链路 JVM 调优实战
        - 5 大支柱协同工作流
        - 启动参数完整版
        - 性能压测回归

Day07：架构深挖 - G1 GC 底层原理与生产事故反推
        - Region 模型 / RSet / SATB / Mixed GC / Humongous
        - 四个生产现象的根因深挖
        - 四防闭环设计
```

### 8.2 本周核心收获

```text
1. JVM 5 大支柱的系统认识：
   - 内存（Day01）+ GC（Day02-03）+ 类加载（Day04）+ JIT（Day05）+ 协同（Day06）
   - 5 大支柱互相耦合，任何一环调优不到位，整体性能就上不去

2. G1 GC 的内部机制：
   - Region 模型 + 跨代引用 + 写屏障 + SATB + RSet + Mixed GC + Humongous
   - 7 个机制合起来构成 G1 的"心脏"

3. JVM 调优的工程化思维：
   - 调参 → 监控 → 告警 → 处置 → 复盘
   - 调一个参数可能引发 3 个新问题（耦合矩阵）
   - 四防闭环：预判 / 监控 / 处置 / 兜底

4. 生产事故的反推能力：
   - 现象 → 工具定位 → 数据验证 → 业务根因
   - 工具链：GC 日志 / jstat / jcmd / JFR / async-profiler / Arthas / Prometheus

5. 架构师视角的演进规划：
   - 短期：JDK 8 + G1 调优
   - 中期：JDK 17 + ZGC
   - 长期：GraalVM Native Image 评估
```

### 8.3 第 2 周预告

```text
第 2 周（2026年08月第2周）：JVM 专题第 2 周 - 调优实战与生产排查

Day01：JVM 调优工具链实战（jstat / jcmd / JFR / async-profiler / Arthas）
Day02：JVM 监控与告警体系（Prometheus + Grafana + Micrometer）
Day03：CPU 飙高排查实战（火焰图 / 线程分析 / JIT 退优化）
Day04：内存泄漏排查实战（Heap Dump / MAT / 支配树 / 8 种泄漏模式）
Day05：GC 调优实战（G1 / ZGC 参数调优 + 7 种 GC 问题排查）
Day06：串联整合 - 在线问诊 IM 网关 JVM 调优完整案例
Day07：架构深挖 - ZGC 底层原理（染色指针 / 读屏障 / 并发整理）

与简历项目强结合：
- 在线问诊 IM 网关的 JVM 调优案例（Day06）
- 医疗信息化场景的 JVM 问题排查
- JDK 8 -> JDK 17 升级路径
```

---

## 九、今日复盘

### 9.1 今日核心收获

```text
1. G1 GC 的 7 个核心机制（Region / Card Table / Write Barrier / RSet / SATB / Mixed GC / Humongous）合起来构成 G1 的"心脏"

2. SATB 的"快照语义"是 G1 选择"重新标记短 + 接受 floating garbage"的工程权衡

3. Mixed GC 的"回收价值计算 + 分批回收"是 G1 控制停顿的核心算法

4. Evacuation Failure 是 G1 的"噩梦"，触发 Serial Full（JDK 8）的 2-5s 停顿

5. Humongous Allocation 是 G1 的"陷阱"，4.2MB 对象 + 4MB Region = 频繁并发标记

6. 四防闭环（预判 / 监控 / 处置 / 兜底）是生产级 JVM 调优的工程化保障
```

### 9.2 与架构师水平的差距

```text
差距1：G1 内部机制的源码级理解不足
差距2：调参耦合关系的实战经验不足
差距3：JFR + async-profiler 的生产使用不熟
差距4：Evacuation Failure 的实战处置不深
差距5：Humongous Allocation 的业务层防护不足
差距6：四防闭环的工程化落地不足
差距7：G1 vs ZGC vs Shenandoah 的对比深度不足
差距8：JVM 调优与业务架构的协同设计深度不足
```

### 9.3 补足方向

```text
1. 读 HotSpot G1 源码（src/hotspot/share/gc/g1/）
2. 第 2 周建立"调参矩阵" + "监控大盘"
3. 每月一次 Evacuation Failure 故障演练
4. 把 JVM 约束写入架构评审 Checklist
5. 第 2 周 Day07 深挖 ZGC（染色指针 / 读屏障 / 并发整理）
6. 调研 Netflix / LinkedIn / 阿里 / 美团的 JVM 调优实践
```

### 9.4 一句话总结

```text
"会用 G1 是工程师，理解 G1 内部是架构师，能在生产中反推根因并设计四防闭环是 SRE 架构师。
Day07 从'会用 G1'到'理解 G1 内部'，第 2 周从'理解 G1'到'生产实战'。"
```

---

## 附：今日学习清单

- [x] G1 Region 模型与跨代引用底层（Region / Card Table / Write Barrier / RSet）
- [x] SATB 与并发标记四阶段（初始标记 / 并发标记 / 最终标记 / 筛选回收）
- [x] Mixed GC 触发条件与回收价值计算（IHOP / 回收价值 / 分批回收）
- [x] Evacuation Failure / Humongous Allocation / Full GC 的根因与防护
- [x] G1 调优参数体系与生产诊断工具链（五层金字塔 / 工具链 / 反推流程）
- [x] 四个现象的根因深挖与四防闭环设计
- [x] 与往周专题的衔接（11 个专题关联）
- [x] 能力差距梳理（8 个差距）
- [x] 本周总结与第 2 周预告
- [x] 今日复盘与补足方向
