# 架构师学习-Day02-GC 算法与分代收集理论

> 日期：2026年07月29日（周三）
> 周主题：JVM 专题第 1 周 - JVM 基础与核心
> 出题日：Day02 - GC 算法与分代收集理论

---

## 背景

Day01 建立了 JVM 内存模型与对象生命周期的完整视图：内存区域划分、对象创建、对象布局、对象存活判定、逃逸分析。其中"对象存活判定"已经触及 GC 的核心——**如何判断对象可回收**。但"判定"只是 GC 的第一步，**真正回收**才涉及算法选择与工程实现。

本周 Day02 进入 GC 算法与分代收集理论。这是 JVM 调优的"内功心法"——很多生产事故的根因都能追溯到对 GC 算法理解的偏差：

1. **为什么 Survivor 区太小会导致对象过早晋升？** —— 复制算法与分代假说的工程权衡
2. **为什么 CMS 会"Concurrent Mode Failure"？** —— 标记清除碎片化 + 并发标记浮动垃圾
3. **为什么 G1 用 SATB 而不用增量更新？** —— 写屏障与并发标记的取舍
4. **为什么 Full GC 是吞吐杀手？** —— 跨代引用 + 全堆扫描的成本
5. **为什么 Safepoint 不及时会让 GC 延迟？** —— 安全点机制与 JIT 优化冲突

Day02 不讲具体收集器（Day03 详讲），只讲 GC 算法本身与分代收集理论。这是 Day03 收集器选型、Day07 G1 深挖、第 2 周调优实战的理论基础。

**与 Day01 的衔接**：
- Day01 讲了"对象存活判定"（可达性分析、三色标记、SATB 概念），Day02 深入"标记之后怎么清理"
- Day01 讲了"对象创建在 TLAB 中"，Day02 讲"对象回收时如何处理跨代引用"
- Day01 讲了"逃逸分析决定对象是否栈上分配"，Day02 讲"未栈上分配的对象如何被 GC 处理"

**与往周专题的衔接点**：

- **MySQL InnoDB 的脏页刷新** vs **JVM GC 的标记清除**：两者都是"找出脏数据 + 清理"，但 InnoDB 是原地更新，JVM 是回收内存（6月第1周）
- **Redis 的惰性删除 + 定期删除** vs **JVM 的标记清除 + 分代回收**：两者都是"被动 + 主动"组合（6月第2周）
- **ES Lucene Segment Merge** vs **JVM Mark-Compact**：两者都是"碎片整理"，但触发时机不同（6月第3周）
- **Sentinel 滑动窗口** vs **JVM Card Table**：两者都是"用粗粒度数据结构降低精度换性能"（6月第4周）
- **K8s Pod 调度的反亲和** vs **JVM 分代隔离**：两者都是"按生命周期分离存储以减少干扰"（7月第3周）

**与简历项目的衔接点**：

在线问诊系统的 GC 重灾区与 Day02 算法直接相关：

1. **问诊订单本地缓存（Caffeine）**：100w 订单对象进入 Old 代，是 Mark-Compact 的主战场
2. **IM 心跳包临时对象**：每秒 5w 心跳 × 5 临时对象，是 Minor GC 的核心压力源
3. **视频 RTP 包与 VideoStreamSession**：短生命周期对象被长生命周期对象引用，是跨代引用典型
4. **MongoDB 5MB 大文档读取**：临时大对象分配，是 G1 Humongous Region 的设计动机
5. **Full GC 后 STW 1.2 秒**：是 GC 日志分析方法论的实战场景

Day02 聚焦 GC 算法与分代收集理论，Day03 进入收集器全谱系（Serial/ParNew/Parallel/CMS/G1/ZGC/Shenandoah）。

---

## 题目一（原理深挖题）：GC 算法与分代收集理论

请详细回答以下问题：

1. **GC 基础算法全谱系**：标记-清除（Mark-Sweep）、复制（Copying）、标记-整理（Mark-Compact）三种基础算法的原理？各自的优缺点？分代收集为什么把这三种组合起来？分代假说的两个前提是什么？为什么新生代用复制算法、老年代用标记整理（或标记清除）？
2. **跨代引用问题**：什么是跨代引用？为什么跨代引用是 GC 的性能杀手？解决跨代引用的方案有哪些（全堆扫描、记忆集、卡表）？Remembered Set（记忆集）与 Card Table（卡表）的区别？Card Table 的粒度如何选择？为什么 Card Table 是"用精度换性能"？
3. **写屏障（Write Barrier）**：写屏障是什么？为什么需要写屏障（并发标记时的漏标问题）？pre-write barrier 与 post-write barrier 的区别？为什么 CMS 用 post-write barrier（增量更新）而 G1 用 pre-write barrier（SATB）？写屏障对性能的影响有多大？为什么 G1 的 SATB 写屏障比 CMS 的增量更新开销大？
4. **安全点与安全区域**：Safepoint 是什么？为什么 GC 需要等待所有线程到达 Safepoint？Safepoint 是如何实现的（轮询机制、JIT 优化点）？Safe Region 是什么？为什么需要 Safe Region（线程处于 Sleep 或 Blocked 时无法到达 Safepoint）？JNI 状态下的 Safepoint 问题？为什么 JDK 12 引入并发栈扫描后 Safepoint 仍不能完全取消？
5. **并发标记的核心问题**：并发标记的根本难点是什么（应用线程修改对象引用导致漏标/多标）？三色标记算法是什么？漏标问题的两种解决方案（增量更新 vs SATB）？多标引发的"浮动垃圾"是什么？为什么并发标记必然产生浮动垃圾？为什么"重新标记"阶段不能完全消除浮动垃圾？并发标记与初始标记、最终标记的协作关系？

### 作答区

#### 1. GC 基础算法全谱系

**三种基础 GC 算法**：

| 算法 | 原理 | 优点 | 缺点 | 适用场景 |
|------|------|------|------|---------|
| **标记-清除（Mark-Sweep）** | 1. 从 GC Roots 出发标记存活对象；2. 清除未标记对象 | 实现简单；不需要移动对象 | 碎片化严重；分配慢（空闲列表）；大对象效率低 | CMS（Old 代） |
| **复制（Copying）** | 1. 将存活对象从 From 区复制到 To 区；2. 清空 From 区；3. From/To 角色互换 | 无碎片；分配快（指针碰撞）；适合大量短生命周期对象 | 浪费一半内存；存活对象多时复制开销大 | Serial / ParNew / Parallel Scavenge（Young 代） |
| **标记-整理（Mark-Compact）** | 1. 标记存活对象；2. 将存活对象向一端移动；3. 清理边界外的内存 | 无碎片；不浪费内存 | 移动对象耗时；需更新所有引用；STW 长 | Parallel Old / G1（Old 代 Region） |

**分代收集的核心思想**：

**分代假说（Generational Hypothesis）**——绝大多数对象都是朝生夕死的，熬过越多次 GC 的对象越难以回收。两个前提：

1. **弱分代假说**：新生代中的对象 90% 以上都是朝生夕死
2. **强分代假说**：熬过多次 GC 仍存活的对象，更可能继续存活

基于这两个假说，JVM 把堆分为新生代（Young）和老年代（Old）：
- 新生代用**复制算法**：90% 对象都死，复制存活的 10% 到 Survivor，效率高
- 老年代用**标记-整理或标记-清除**：存活率高，复制开销大，原地整理更合适

**为什么新生代用复制算法**：

1. **存活率低，复制开销小**：新生代 90% 对象死亡，复制 10% 比标记整理整个区域快
2. **无碎片，分配快**：复制后内存规整，可用指针碰撞，O(1) 分配
3. **TLAB 友好**：规整内存让 TLAB 的指针碰撞更高效
4. **避免内存碎片**：新生代对象创建频繁，碎片会让分配变慢

新生代复制算法的具体实现（Eden + 2 个 Survivor）：

```
┌─────────────────────────────────────────┐
│  新生代（Young）                         │
│  ┌────────┬────────┬────────┐           │
│  │ Eden   │ S0     │ S1     │           │
│  │ 80%    │ 10%    │ 10%    │           │
│  └────────┴────────┴────────┘           │
└─────────────────────────────────────────┘

Minor GC 过程：
1. Eden + S0 中存活对象复制到 S1（S0 清空）
2. Eden 清空
3. S0 与 S1 角色互换
4. 下一轮 GC 时，Eden + S1 中存活对象复制到 S0

为什么不是 Eden + 1 个 Survivor：
- 如果只有 1 个 Survivor，复制后 Survivor 内的对象需要再次复制到 Eden 或其他地方
- 2 个 Survivor 让"From"和"To"角色轮换，避免对象在 Survivor 与 Eden 之间反复横跳
```

**为什么 Survivor 区只占 10%**：因为新生代 90% 对象死亡，存活的 10% 刚好放进 Survivor。如果 Survivor 太大浪费内存；太小则存活对象放不下，会过早晋升到 Old 代。

**为什么老年代用标记-整理（或标记-清除）**：

1. **存活率高，复制开销大**：老年代对象长期存活，复制需要拷贝大量数据
2. **没有额外空间做复制**：复制算法需要一块空闲区域，老年代无 Survivor 配对
3. **避免碎片**：标记-整理无碎片，分配快（虽然整理耗时）

CMS 用标记-清除（追求低停顿，不整理），G1 用标记-整理（Region 间复制整理）。这是 Day03 的内容。

**分代收集的完整流程**：

```
新建对象 → Eden 区分配（TLAB）
              │
              ▼ Minor GC（Eden 满）
        ┌───────────────────┐
        │ 存活对象复制到 S0  │
        │ Eden 清空         │
        │ 年龄 +1           │
        └───────────────────┘
              │
              ▼ 多次 Minor GC（年龄 >= 15）
        ┌───────────────────┐
        │ 晋升到 Old 代     │
        └───────────────────┘
              │
              ▼ Old 代满 / Metaspace 满 / 显式 System.gc()
        ┌───────────────────┐
        │ Full GC           │
        │ - 新生代 + 老年代  │
        │ - 整堆标记整理     │
        │ - STW 时间最长     │
        └───────────────────┘
```

**对象晋升 Old 代的条件**：

1. **年龄达到阈值**（`-XX:MaxTenuringThreshold=15`，默认 15）
2. **大对象直接进入 Old 代**（`-XX:PretenureSizeThreshold`，仅 Serial / ParNew 生效）
3. **动态年龄计算**：Survivor 中相同年龄对象大小总和超过 Survivor 空间的 50%，年龄 >= 该年龄的对象全部晋升
4. **Survivor 空间不足**：Minor GC 后存活对象放不下 Survivor，直接晋升 Old 代（过早晋升的根因）

#### 2. 跨代引用问题

**什么是跨代引用**：

新生代对象引用老年代对象（New → Old），或老年代对象引用新生代对象（Old → New）。后者是 GC 性能杀手。

```
┌──────────────────────────────────────────┐
│  Old 代                                  │
│  ┌─────────────────┐                     │
│  │  长生命周期对象  │ ───────┐            │
│  │  (缓存、单例)    │        │ 跨代引用   │
│  └─────────────────┘        ▼            │
│                       ┌─────────────┐    │
│                       │  新生代对象  │    │
│                       │  (临时对象)  │    │
│                       └─────────────┘    │
│  Young 代                                │
└──────────────────────────────────────────┘
```

**为什么跨代引用是性能杀手**：

新生代 GC（Minor GC）只扫描新生代，但要确认新生代对象是否存活，必须扫描所有引用新生代的对象——**包括 Old 代**。如果不做特殊处理，每次 Minor GC 都要扫描整个 Old 代，分代收集的意义就被破坏了。

**跨代引用的几种解决方案**：

| 方案 | 原理 | 优点 | 缺点 |
|------|------|------|------|
| **全堆扫描** | Minor GC 时扫描 Old + Young | 实现简单 | Minor GC 退化为 Full GC，性能差 |
| **记忆集（Remembered Set）** | 记录"Old 代中指向 Young 代的对象"，Minor GC 只扫描这些 | 精确，扫描开销小 | 内存开销大，每个引用都要记录 |
| **卡表（Card Table）** | 把 Old 代划分为固定大小卡片，记录"哪些卡包含跨代引用" | 内存开销小（粗粒度）；扫描快 | 粒度粗，可能扫描到非跨代引用对象 |

**Remembered Set 与 Card Table 的区别**：

```
精确到对象级别（Remembered Set）       精确到内存块级别（Card Table）

Old 代                                Old 代
┌──────────────┐                     ┌──────────────┐
│ obj1 ──→ new │ ← 记录 obj1         │ Card 0       │ ← 标脏
├──────────────┤                     ├──────────────┤
│ obj2         │                     │ Card 1       │
├──────────────┤                     ├──────────────┤
│ obj3 ──→ new │ ← 记录 obj3         │ Card 2       │ ← 标脏（包含 obj3）
└──────────────┘                     └──────────────┘
RS = {obj1, obj3}                    CT = [脏, 干净, 脏]
扫描 obj1, obj3                       扫描 Card 0 和 Card 2 中的所有对象
```

**Card Table 的实现细节**：

1. **卡片大小**：通常 512 字节（HotSpot 默认）
2. **数据结构**：字节数组（byte[]），每个字节对应一个 Card
3. **状态**：CLEAN（干净，无跨代引用）/ DIRTY（脏，可能有跨代引用）
4. **写屏障维护**：每次 Old 代对象写引用到 Young 代时，对应 Card 标脏
5. **Minor GC 时**：扫描 Card Table，找出所有脏 Card，扫描脏 Card 中的对象

**Card Table 粒度选择的权衡**：

| 卡片大小 | 内存开销 | 精度 | 扫描开销 | 适用场景 |
|---------|---------|------|---------|---------|
| 128 字节 | 大（每 128B 1 字节） | 高 | 小 | 引用密集场景 |
| **512 字节（默认）** | 中（每 512B 1 字节） | 中 | 中 | 通用 |
| 1KB / 2KB | 小 | 低 | 大 | 内存紧张场景

为什么选 512 字节：1 字节记录 512 字节，内存开销约 0.2%（512MB Old 代 → 1MB Card Table）。如果卡片内有 1 个跨代引用，整个 512B（约 8-16 个对象）都要扫描，是可接受的开销。

**Card Table 的"用精度换性能"**：

- 不精确：卡片标脏后，扫描整个卡片的所有对象（可能其中并没有跨代引用）
- 性能收益：写屏障只更新字节数组，O(1)；不需要维护对象级引用列表

**HotSpot 的 Card Table 实现**（精度细节）：

```c
// 简化的 Card Table 写屏障（伪代码）
void oop_write_barrier(oop* field, oop new_value) {
    *field = new_value;
    // 计算 field 地址对应的 Card 索引
    size_t card_index = ((char*)field - heap_start) >> 9;  // 512B = 2^9
    // 标脏
    card_table[card_index] = DIRTY;
}
```

**Card Table 与 G1 的关系**：G1 的每个 Region 都有自己的 Card Table（实际上是"Remembered Set 集合"），记录"其他 Region 指向本 Region"的引用。这是 Day07 深挖 G1 的核心。

#### 3. 写屏障（Write Barrier）

**写屏障是什么**：

写屏障是 JVM 在对象引用字段被赋值时触发的钩子函数。不是"内存屏障"（Memory Barrier，CPU 指令），是 JVM 层面的"引用写钩子"。

```
普通对象字段写入：
    obj.field = new_value;

带写屏障的写入：
    pre_write_barrier(obj, field, *field);   // 写之前
    *field = new_value;                       // 实际写入
    post_write_barrier(obj, field, new_value); // 写之后
```

**为什么需要写屏障**：

并发标记时，GC 线程在标记对象图，应用线程同时在修改对象图。如果不记录这些修改，会漏标——把存活对象当垃圾回收，导致程序崩溃。

**漏标问题的产生**（三色标记视角）：

```
初始状态：
    A (黑) → B (灰) → C (白)

应用线程操作：
    1. 删除 A → B 引用（A 还是黑，B 还是灰）
    2. 新增 B → C 的反向引用（C 的引用者从 B 变成 ... 不，是新增引用）
    
等等，重新看漏标条件：
漏标成立的充要条件（Wilson-Möller）：
    1. 黑色对象新增到白色对象的引用
    2. 灰色对象到白色对象的引用断开
    3. 两个条件同时成立，且没有其他灰色对象到该白色对象的引用

具体场景：
    A (黑) → B (灰) → C (白)
    
应用线程：
    A.c = C;        // 黑色对象 A 新增到白色对象 C 的引用（满足条件1）
    B.c = null;     // 灰色对象 B 到白色对象 C 的引用断开（满足条件2）
    
此时 C 实际上被 A 引用（存活），但 GC 标记线程已经走过 B（灰色 → 黑色），
不会再扫描 B，C 被漏标，错误回收。
```

**两种解决方案**：

| 方案 | 原理 | 写屏障类型 | 实现 | 收集器 |
|------|------|----------|------|--------|
| **增量更新（Incremental Update）** | 黑色对象新增到白色对象的引用时，记录这个黑色对象为灰色（重新扫描） | post-write barrier | 写之后记录新引用 | CMS |
| **SATB（Snapshot At The Beginning）** | GC 开始时拍快照，并发标记期间删除的引用（灰→白断开）记录下来，最终标记时处理 | pre-write barrier | 写之前记录旧值 | G1 |

**pre-write barrier vs post-write barrier**：

```
pre-write barrier（SATB）：
    old_value = *field;            // 先读旧值
    satb_queue.push(old_value);    // 旧值入队（标记结束前处理）
    *field = new_value;            // 再写入新值

post-write barrier（增量更新）：
    *field = new_value;            // 先写入新值
    if (is_black(obj) && is_white(new_value)) {
        dirty_card_queue.push(obj); // 把黑色对象标脏，重新扫描
    }
```

**为什么 CMS 用增量更新、G1 用 SATB**：

| 维度 | CMS（增量更新） | G1（SATB） |
|------|---------------|-----------|
| 写屏障开销 | 小（只记录黑→白） | 大（记录所有引用变更） |
| 重新标记耗时 | 长（要重新扫描所有标脏的黑色对象） | 短（只处理 SATB 队列） |
| 标记准确性 | 较低（可能漏标，需重新标记兜底） | 较高（快照保证不漏标） |
| 浮动垃圾 | 较少（重新标记能扫到一部分） | 较多（快照时刻存活的，标记结束前死了也算存活） |
| 设计目标 | 低停顿（重新标记尽量短） | 可预测停顿（标记准确，Mixed GC 可控） |

**CMS 用增量更新的原因**：
- CMS 追求极低停顿，写屏障要尽量轻
- 增量更新只记录"黑→白"，写屏障开销小
- 重新标记阶段稍微长一点可接受（CMS 的 remark 阶段通常 50-200ms）

**G1 用 SATB 的原因**：
- G1 的 Region 模型需要"快照"语义，Mixed GC 才能可控
- SATB 让标记结果与开始时刻一致，便于预测停顿
- 写屏障开销大但可接受（G1 设计目标是均衡，不是极致低停顿）

**写屏障对性能的影响**：

- **CMS 的 post-write barrier**：约 5-10% 性能开销
- **G1 的 SATB pre-write barrier**：约 10-20% 性能开销
- **写屏障无法关闭**：JVM 强制开启，是并发标记的必要代价

**写屏障队列的处理**：

```
应用线程                GC 线程

修改 obj.field
   │
   ▼
写屏障触发
   │
   ▼
入队 SATB 队列 / Dirty Card 队列
   │
   ▼ 队列满
   ▼
移交 GC 线程处理（在下一次 Safepoint）
```

#### 4. 安全点与安全区域

**Safepoint 是什么**：

Safepoint 是程序执行过程中的特定位置，在这些位置上，**所有线程的内部状态是确定的**（栈、寄存器内容与字节码对应），GC 可以安全地进行堆扫描和对象移动。

**为什么 GC 需要等待所有线程到达 Safepoint**：

1. **栈扫描一致性**：GC 需要遍历线程栈找 GC Roots，如果线程正在执行字节码中间，栈帧状态不确定，扫描会出错
2. **对象移动一致性**：GC 移动对象后，所有指向该对象的引用都要更新，如果线程正在用对象引用（如已加载到寄存器），更新会出错
3. **Card Table 一致性**：写屏障在 Safepoint 处理队列，确保 Card Table 反映最新状态

**Safepoint 的实现机制**：

HotSpot 使用**轮询（Polling）**机制：

1. JIT 编译后的代码在**方法返回、循环回边、方法调用**等位置插入"轮询指令"
2. 轮询指令检查"全局 Safepoint 标志位"
3. GC 触发时，设置全局 Safepoint 标志位
4. 线程执行到轮询点时发现标志位被设置，主动阻塞自己

```
JIT 编译后的循环：
for (int i = 0; i < n; i++) {
    // 业务代码
    process(arr[i]);
    
    // 轮询点（JIT 插入）
    if (safepoint_flag) {
        enter_safepoint();
    }
}
```

**Safepoint 的关键问题**：

1. **JIT 不优化（解释执行）的方法**：解释器也有轮询机制，但比 JIT 慢
2. **大循环没有方法调用**：JIT 在循环回边插入轮询，避免长循环卡住 GC
3. **Counted Loop 陷阱**：`for (int i = 0; i < Integer.MAX_VALUE; i++)` 这种 int 计数循环，JIT 可能不做循环回边轮询，导致 GC 长时间等待

```
// 经典 Safepoint 陷阱
long start = System.currentTimeMillis();
for (int i = 0; i < Integer.MAX_VALUE; i++) {
    // 空循环，没有方法调用，没有对象分配
}
long end = System.currentTimeMillis();
// 如果 GC 触发，这个循环会卡住所有线程，导致 STW 时间很长
// 因为 int 计数循环不会触发轮询

// 修复：用 long 计数
for (long i = 0; i < Integer.MAX_VALUE; i++) {
    // long 计数循环会触发轮询
}
```

**Safe Region 是什么**：

线程处于 Sleep、Blocked、JNI 执行状态时，无法到达 Safepoint（因为不在执行 Java 代码）。这时需要 Safe Region——一段"线程在此区域内，引用关系不会变化"的代码区域。

**Safe Region 的处理**：

1. 线程进入 Sleep / Blocked / JNI 时，标记自己进入 Safe Region
2. GC 触发时，不需要等待这些线程
3. 线程离开 Safe Region 前，检查"GC 是否完成"，未完成则阻塞自己

```
线程状态与 Safepoint：

执行 Java 字节码（JIT 编译）：
   → 在轮询点进入 Safepoint
   
执行 Native 方法（JNI）：
   → 进入 Safe Region（引用不变）
   → 但 native 代码可能持有 Java 对象引用，需要 GC 锁
   
Sleep / Blocked / Wait：
   → 进入 Safe Region
   
正在分配 TLAB：
   → 在分配前进入 Safepoint
```

**JNI 状态下的 Safepoint 问题**：

- JNI 代码不在 JVM 控制下，无法插入轮询
- JNI 持有 Java 对象引用时（通过 `JNIEnv*`），JVM 需要确保这些引用不被 GC 移动
- 解决方案：JNI 用**句柄（Handle）**而非直接指针，GC 移动对象时更新句柄

**JDK 12 的并发栈扫描（JEP 376）**：

- 之前：GC 需要扫描所有线程栈，必须在 Safepoint
- JDK 12+（ZGC）：并发扫描线程栈，无需等待所有线程到 Safepoint
- 但**对象移动**仍需 Safepoint（或读屏障）
- 所以 Safepoint 不能完全取消，但可以大幅缩短

#### 5. 并发标记的核心问题

**并发标记的根本难点**：

GC 线程标记对象图的同时，应用线程修改对象图。这导致两个问题：

1. **漏标**：存活对象被错误地认为死亡，回收后程序崩溃（致命错误）
2. **多标**：死亡对象被错误地认为存活，本该回收的没回收（浮动垃圾，可接受）

**三色标记算法**：

| 颜色 | 含义 | 状态 |
|------|------|------|
| **白（White）** | 未被标记 | 初始状态，GC 结束时仍为白则被回收 |
| **灰（Gray）** | 已标记，但子节点未扫描 | 待处理队列 |
| **黑（Black）** | 已标记，且子节点已扫描 | 存活，不回收 |

```
三色标记流程：

初始：所有对象白色，GC Roots 灰色

循环：
    从灰色集合取出一个对象
    扫描其所有引用对象，引用对象白→灰
    当前对象灰→黑

结束：黑色 = 存活，白色 = 死亡
```

**漏标问题的充要条件（Wilson-Möller）**：

漏标当且仅当同时满足：
1. 黑色对象新增到白色对象的引用
2. 灰色对象到该白色对象的引用全部断开
3. 没有其他灰色对象到该白色对象的引用

破坏其中任意一条即可避免漏标：
- **增量更新**：破坏条件 1（黑色对象新增到白色引用时，黑色变灰，重新扫描）
- **SATB**：破坏条件 2（灰色对象到白色引用断开时，记录白色对象，标记结束前扫描）

**多标与浮动垃圾**：

```
GC 开始时刻：A (黑) → B (灰)
应用线程：A.b = null（A 不再引用 B）
GC 标记：B 已经被标记为灰色，继续扫描 B 的子节点，B 最终变黑

结果：B 实际在 GC 开始后已死亡，但被标记为存活
      → 浮动垃圾（下次 GC 才能回收）
```

**为什么并发标记必然产生浮动垃圾**：

- SATB 拍快照时存活的，标记期间死亡，仍是"存活"
- 增量更新中黑→白的引用，可能很快又被删除，但已记录为"待重新扫描"
- 浮动垃圾是并发标记的代价，下次 GC 才能回收

**为什么"重新标记"不能完全消除浮动垃圾**：

- 重新标记（Remark）阶段处理 SATB 队列和脏 Card
- 但重新标记是 STW 的，时间有限，只能处理"已记录"的变更
- 重新标记之后到 GC 结束之间的引用变更，仍会产生浮动垃圾

**并发标记的四个阶段**（CMS / G1 共有）：

```
1. 初始标记（Initial Mark）
   - STW，标记 GC Roots 直接引用的对象
   - 时间短（毫秒级）

2. 并发标记（Concurrent Mark）
   - 与应用线程并发执行
   - 从 GC Roots 开始遍历整个对象图
   - 写屏障记录引用变更
   - 时间长（秒级），但不阻塞应用

3. 重新标记（Remark）
   - STW，处理并发标记期间的引用变更
   - 处理 SATB 队列 / 脏 Card 队列
   - 时间中等（百毫秒级）

4. 清理（Cleanup / Sweep）
   - STW 或部分并发
   - 统计存活对象，回收白色对象
   - CMS 直接清除，G1 统计 Region 选择 Mixed GC 候选
```

**初始标记与重新标记的协作**：

- 初始标记：用 GC Roots 直接引用做种子
- 并发标记：从种子开始遍历
- 重新标记：补齐并发标记期间的变更
- 清理：根据标记结果回收

---

## 题目二（实战场景题）：在线问诊系统中的 GC 算法应用

结合在线问诊系统的实际场景，回答以下问题：

1. **问诊订单缓存的 Old 代压力**：在线问诊系统在 Caffeine 本地缓存中缓存了 100w 问诊订单对象（每个约 1KB），订单对象生命周期怎样？为什么本地缓存会进入 Old 代？Old 代碎片化如何影响后续 GC？为什么 CMS 的碎片化最终会触发 Full GC（Serial Old 兜底）？如何用 Mark-Compact 思路缓解？
2. **IM 心跳包的 Minor GC 频率**：IM 网关每秒处理 5w 心跳包，每个心跳产生 5 个临时对象（HeartbeatPacket、ChannelContext、ByteBuf 解码对象、统计对象、AckPacket）。如何估算 Minor GC 频率？如果 Minor GC 频率过高（如 100ms 一次），怎么优化？为什么 Survivor 区太小会导致对象过早晋升？如何用 `-XX:SurvivorRatio` 和 `-XX:TargetSurvivorRatio` 调优？
3. **视频问诊 SFU 的跨代引用问题**：视频 RTP 包是短生命周期对象（每秒创建 750 个），但被长生命周期的 VideoStreamSession（Old 代）引用。这种跨代引用如何处理？Card Table 在 SFU 场景下的写入屏障开销有多大？如何减少跨代引用（Session 引用结构优化）？为什么 G1 在这个场景下比 CMS 更合适？
4. **MongoDB 大文档的 Mark-Compact 触发**：读取 5MB 问诊 JSON 文档时，BsonReader 流式解析仍会产生临时大对象（如中间 Map、List）。这些大对象如何影响 GC？为什么 G1 把大对象放入 Humongous Region？Humongous Region 的 GC 策略（什么时候回收）？大对象何时触发 Full GC？如何避免大对象进入 Old 代？
5. **GC 日志分析方法论**：在线问诊系统一次 Full GC 后 STW 1.2 秒，怎么定位根因？GC 日志的关键指标（吞吐、停顿、频率、晋升速率）？如何用 GCEasy / GCViewer 分析？如何与监控指标（CPU、内存、QPS）关联？Full GC 触发的几种根因（Old 代满、Metaspace 满、System.gc()、显式 dump、CMS Concurrent Mode Failure）？如何用 JFR + Async-Profiler 做全链路归因？

### 作答区

#### 1. 问诊订单缓存的 Old 代压力

**问诊订单对象的生命周期**：

```
对象创建                  → 进入 Eden
   ↓ Minor GC × 1        → 进入 Survivor，年龄 1
   ↓ Minor GC × N        → 在 Survivor 中年龄递增
   ↓ 年龄 >= 15 或动态年龄 → 晋升 Old 代
   
如果在 Caffeine 缓存中：
   ↓ 缓存 TTL 30 分钟    → 30 分钟内一直存活
   ↓ Minor GC × 100+    → 早于年龄阈值晋升（动态年龄规则）
   ↓ 进入 Old 代          → 长期占用 Old 代
```

**为什么本地缓存会进入 Old 代**：

1. **Caffeine 的 W-TinyLFU 策略**：缓存对象长期被引用，年龄远超晋升阈值
2. **动态年龄规则**：Survivor 中相同年龄对象总和超过 Survivor 空间 50% 时，年龄 >= 该年龄的对象全部晋升
3. **缓存对象数量大**：100w 订单 × 1KB = 1GB，远超 Survivor 容量（默认几 MB ~ 几十 MB），动态年龄规则必然触发

**Old 代碎片化的影响**：

```
CMS（标记-清除）的碎片化：

Old 代（Old）
┌─────┬─────┬─┬─────┬─┬─────┬─┬─────┐
│ obj1│ obj2│ │ obj3│ │ obj4│ │ obj5│  ← 空洞（碎片）
└─────┴─────┘─┴─────┘─┴─────┘─┴─────┘
                 ↑       ↑       ↑
              空闲块   空闲块   空闲块

问题：
1. 分配大对象时找不到连续空间 → 提前 Full GC
2. 空闲列表扫描慢（O(n)）→ 分配延迟
3. CPU cache 不友好（对象分散）→ 访问延迟
```

**为什么 CMS 碎片化最终触发 Full GC（Serial Old 兜底）**：

CMS 的并发收集用标记-清除，不整理。当碎片严重到无法分配新对象时，触发 **Concurrent Mode Failure**（晋升失败 / 显式 GC），退化为 Serial Old 单线程 Full GC，整理全堆，STW 时间可达数秒。

```
CMS 失败兜底流程：

正常 CMS:
   1. 初始标记（STW）
   2. 并发标记
   3. 重新标记（STW）
   4. 并发清除

碎片化严重时：
   → 晋升失败（Old 代无连续空间放晋升对象）
   → Concurrent Mode Failure
   → 退化为 Serial Old Full GC（单线程，整理全堆）
   → STW 时间 = 几秒到几十秒
```

**用 Mark-Compact 思路缓解**：

1. **改用 G1**：G1 用 Region 间复制实现"局部整理"，避免全堆整理的长 STW
2. **定期触发 Full GC**：`-XX:+ExplicitGCInvokesConcurrent` + 周期性 `System.gc()`，让 G1 整理 Old 代
3. **压缩 Caffeine 配置**：减少缓存大小，让对象更早被淘汰
4. **对象池化（不推荐）**：复用对象，减少 Old 代分配——但对象池本身也是 Old 代对象，且增加代码复杂度

**问诊订单缓存的优化建议**：

```java
// 问题配置：100w 订单 × 1KB = 1GB 全在 Old 代
Caffeine.newBuilder()
    .maximumSize(1_000_000)  // 100w
    .expireAfterWrite(30, TimeUnit.MINUTES)
    .build();

// 优化方案 1：减少缓存大小
Caffeine.newBuilder()
    .maximumSize(100_000)  // 10w， Old 代压力降低 10 倍
    .expireAfterWrite(10, TimeUnit.MINUTES)  // 缩短 TTL
    .build();

// 优化方案 2：分片缓存
Map<Integer, Cache<String, Order>> shards = new HashMap<>();
for (int i = 0; i < 16; i++) {
    shards.put(i, Caffeine.newBuilder()
        .maximumSize(62_500)  // 100w / 16
        .build());
}
// 分片减少单缓存 Old 代压力，且 TTL 错开

// 优化方案 3：用 Redis 替代本地缓存
// 仅缓存热点数据在本地，全量在 Redis
```

#### 2. IM 心跳包的 Minor GC 频率

**对象创建速率估算**：

```
IM 心跳：
- 每秒 5w 心跳包
- 每个心跳产生 5 个对象
  - HeartbeatPacket（~64B）
  - ChannelContext 引用（~32B，引用复用）
  - ByteBuf 解码对象（~128B）
  - 统计对象（~64B）
  - AckPacket（~64B）
- 每个心跳总对象大小：约 350B
- 每秒对象创建：5w × 350B = 17.5MB/秒
```

**Minor GC 频率估算**：

```
假设新生代配置：
- -Xmn2g（新生代 2GB）
- Eden : S0 : S1 = 8 : 1 : 1
- Eden = 1.6GB

Minor GC 频率 = Eden 大小 / 每秒对象创建速率
             = 1.6GB / 17.5MB
             ≈ 91 秒/次

实际频率可能更短（对象分布不均、TLAB refill 等），约 60-90 秒一次
```

**Minor GC 频率过高的优化方法**：

1. **增大新生代**：
   ```bash
   -Xmn4g  # 新生代 4GB
   # 但要注意：新生代过大会占用 Old 代空间，需平衡
   # G1 直接用 -XX:G1MaxNewSizePercent
   ```

2. **降低对象创建速率**：
   ```java
   // 问题：每次心跳都新建 5 个对象
   public void onHeartbeat(Channel ctx) {
       HeartbeatPacket pkt = new HeartbeatPacket(...);  // 新对象
       Stats stats = new Stats(...);                     // 新对象
       AckPacket ack = new AckPacket(...);               // 新对象
   }
   
   // 优化：复用对象（如 Netty 的 ByteBuf 池化）
   public void onHeartbeat(Channel ctx) {
       HeartbeatPacket pkt = pktThreadLocal.get();  // ThreadLocal 复用
       pkt.reset(...);
       // ...
   }
   ```

3. **使用 G1 替代 Parallel**：G1 的 Region 模型更适合心跳这种"对象创建稳定、生命周期短"的场景

**为什么 Survivor 区太小会导致对象过早晋升**：

```
场景：心跳包处理时，部分对象生命周期 > 1 个 Minor GC 间隔

假设某心跳的 ChannelContext 需要存活 5 秒（等待业务处理）
   - 5 秒内可能经历 5 次 Minor GC
   - 每次 Minor GC，对象从 S0 复制到 S1，年龄 +1
   - 5 次后年龄 = 5

如果 Survivor 太小（如 10MB）：
   - 5w 心跳中 10% 需要等待业务 → 5000 个对象 × 350B = 1.75MB
   - 但加上其他业务对象，Survivor 可能放不下
   - 放不下的对象直接晋升 Old 代（过早晋升）
   - Old 代快速膨胀 → 频繁 Full GC

正常情况：
   - Survivor 大小够放 1 个 Minor GC 间隔的存活对象
   - 对象在 Survivor 中年龄递增到 15 才晋升
   - Old 代增长缓慢
```

**SurvivorRatio 和 TargetSurvivorRatio 调优**：

```bash
# SurvivorRatio: Eden 与 Survivor 的比例
-XX:SurvivorRatio=8  # Eden:Survivor = 8:1:1（默认）
-XX:SurvivorRatio=6  # Eden:Survivor = 6:1:1，Survivor 更大

# TargetSurvivorRatio: Survivor 目标使用率
-XX:TargetSurvivorRatio=50  # 默认 50%，Survivor 50% 满时启用动态年龄
-XX:TargetSurvivorRatio=70  # 70% 满才启用动态年龄，减少过早晋升

# MaxTenuringThreshold: 晋升年龄阈值
-XX:MaxTenuringThreshold=15  # 默认 15
-XX:MaxTenuringThreshold=30  # 提高阈值，让对象更长时间留在 Survivor
```

**IM 心跳场景的 JVM 配置建议**：

```bash
-Xms8g -Xmx8g
-XX:NewSize=4g               # 新生代 4GB
-XX:MaxNewSize=4g
-XX:SurvivorRatio=6           # Survivor 占比更大
-XX:TargetSurvivorRatio=70    # 减少过早晋升
-XX:MaxTenuringThreshold=15
-XX:+UseG1GC                  # G1 收集器
-XX:MaxGCPauseMillis=50       # 目标停顿 50ms（IM 实时性敏感）
-XX:G1HeapRegionSize=16m
-XX:+ParallelRefProcEnabled
```

#### 3. 视频问诊 SFU 的跨代引用问题

**SFU 场景的跨代引用**：

```
Old 代                              Young 代
┌──────────────────────────┐       ┌──────────────────────────┐
│ VideoStreamSession       │       │ RtpPacket (每秒 750 个)   │
│   - sessionId            │ ─────→│   - payload              │
│   - currentPackets: List │       │   - timestamp            │
│   - stats: SessionStats  │ ─────→│   - sequenceNumber       │
└──────────────────────────┘       └──────────────────────────┘

问题：
- VideoStreamSession 长期存活（一次问诊 30 分钟），在 Old 代
- RtpPacket 每秒创建 750 个，是新生代主力
- VideoStreamSession.currentPackets 引用 RtpPacket（跨代引用）
- 每次 Minor GC 都要扫描 VideoStreamSession 所在 Card
```

**Card Table 写入屏障开销**：

```
每次 VideoStreamSession.currentPackets.add(packet) 触发写屏障：
1. 计算字段地址对应 Card 索引
2. 标脏 Card Table[index]

开销估算：
- 单次写屏障约 10-50ns
- 每秒 750 次 add → 7.5us - 37.5us
- 单路视频开销可忽略

但峰值 5800 路并发：
- 750 × 5800 = 435w 次/秒写屏障
- 435w × 30ns = 130ms/秒
- 约 13% CPU 用于写屏障开销

更严重的问题：
- 5800 个 VideoStreamSession 散落在多个 Card
- 每个 Card 512B，可能包含 5-10 个 Session
- Minor GC 时要扫描所有脏 Card
- 扫描开销远大于写屏障本身
```

**减少跨代引用的优化**：

1. **Session 引用结构优化**：
   ```java
   // 问题：currentPackets 是 List&lt;RtpPacket>，每次 add 都触发写屏障
   class VideoStreamSession {
       List&lt;RtpPacket> currentPackets = new ArrayList&lt;>();
       void onPacket(RtpPacket pkt) {
           currentPackets.add(pkt);  // 触发写屏障
       }
   }
   
   // 优化 1：批量处理
   class VideoStreamSession {
       RtpPacket[] buffer = new RtpPacket[64];  // 预分配数组
       int index = 0;
       void onPacket(RtpPacket pkt) {
           buffer[index++ & 63] = pkt;  // 数组写仍触发写屏障，但只一次
       }
   }
   
   // 优化 2：用 RingBuffer 在 Young 代
   class VideoStreamSession {
       // RingBuffer 是 Young 代对象，引用 Young 代对象，无跨代引用
       RingBuffer&lt;RtpPacket> buffer = new RingBuffer&lt;>(64);
   }
   // 但 RingBuffer 本身会晋升 Old 代，治标不治本
   ```

2. **使用 Netty 的 Recycler**：
   ```java
   // RtpPacket 用 Recycler 池化，减少对象创建
   private static final Recycler&lt;RtpPacket> RECYCLER = new Recycler&lt;RtpPacket>() {
       @Override
       protected RtpPacket newObject(Handle&lt;RtpPacket> handle) {
           return new RtpPacket(handle);
       }
   };
   
   RtpPacket pkt = RECYCLER.get();
   // 使用
   pkt.recycle();
   ```

3. **使用 G1 替代 CMS**：G1 的 Region 级 Remembered Set 比 CMS 的全堆 Card Table 更精确，扫描开销更小

**为什么 G1 在 SFU 场景比 CMS 更合适**：

| 维度 | CMS | G1 |
|------|-----|-----|
| 跨代引用处理 | 全堆 Card Table | Region 级 RS（更精确） |
| Old 代碎片 | 严重（标记-清除） | 无（Region 间复制整理） |
| 停顿可控 | 偶尔长 STW（Concurrent Mode Failure） | 可预测（MaxGCPauseMillis） |
| 大对象处理 | 直接进 Old 代，难回收 | Humongous Region，专门处理 |
| Mixed GC | 不支持 | 支持（增量回收 Old 代） |

**SFU 服务的 GC 调优建议**：

```bash
-Xms16g -Xmx16g
-XX:+UseG1GC
-XX:MaxGCPauseMillis=20        # 视频实时性要求极高，目标 20ms
-XX:G1HeapRegionSize=16m       # 大 Region 减少跨 Region 引用
-XX:InitiatingHeapOccupancyPercent=45  # 提前触发并发标记
-XX:G1NewSizePercent=30        # 新生代占比下限 30%
-XX:G1MaxNewSizePercent=50     # 新生代占比上限 50%
-XX:ParallelGCThreads=16
-XX:ConcGCThreads=4
```

#### 4. MongoDB 大文档的 Mark-Compact 触发

**大文档读取的内存影响**：

```
读取 5MB 问诊 JSON 文档：
1. MongoDB Driver 接收 → ByteBuf（直接内存 5MB）
2. BsonReader 流式解析 → 临时 Map / List（堆内 ~3-5MB）
3. 业务对象构造 → POJO（堆内 ~2MB）

总内存峰值：直接内存 5MB + 堆内 7MB = 12MB（瞬时）

如果用 BSON.parse() 直接解析：
- 一次性构造整个文档树 → 堆内 10-15MB
- 多个并发请求可能瞬间分配 100MB+ 大对象
- 大对象直接进 Old 代（> Region/2 = 8MB for 16MB Region）
- Old 代碎片化严重
```

**为什么 G1 把大对象放入 Humongous Region**：

```
G1 的 Region 大小（如 16MB）：
- 普通对象：在 Eden / Survivor / Old Region 中分配
- 大对象（> Region/2 = 8MB）：直接分配到 Humongous Region

Humongous Region 特点：
1. 一个大对象独占一个或多个连续 Region
2. 不在新生代 / 老年代，是独立的"Humongous"分类
3. 在并发标记阶段被标记
4. 在 Cleanup 阶段或 Mixed GC 中回收

为什么这样设计：
- 大对象在新生代复制开销大（5MB 复制很慢）
- 大对象如果分散在多个 Region，扫描开销大
- 独占 Region 让大对象分配和回收都简单
```

**Humongous Region 的 GC 策略**：

```
1. 分配时：
   - 找连续 N 个空闲 Region（N = ceil(对象大小 / Region 大小)）
   - 第一个 Region 标记为 Humongous Start
   - 后续 Region 标记为 Humongous Continue
   - 对象起始地址在第一个 Region

2. 标记时：
   - 并发标记阶段扫描 Humongous 对象
   - 如果 Humongous 对象无引用 → 标记为可回收

3. 回收时：
   - 在 Cleanup 阶段或 Mixed GC 中
   - 整个 Humongous Region 一起回收
   - 不需要复制（独占 Region，回收就是释放 Region）
```

**大对象何时触发 Full GC**：

```
触发 Full GC 的场景：
1. Humongous 分配失败（找不到连续 N 个空闲 Region）
   - Old 代碎片化严重
   - 触发 Full GC 整理全堆

2. Humongous 对象在 Old 代占比过高
   - IHOP（InitiatingHeapOccupancyPercent）阈值触发并发标记
   - 但 Mixed GC 来不及回收，Old 代继续涨
   - 触发 Full GC

3. 大对象创建速率 > 回收速率
   - 高峰期并发读取大文档
   - Humongous Region 占满堆
   - Full GC
```

**避免大对象进入 Old 代的策略**：

1. **流式解析**：
   ```java
   // 问题：BSON.parse() 一次性构造整个文档树
   Document doc = collection.find(eq("_id", id)).first();  // 大对象
   
   // 优化：BsonReader 流式解析
   collection.find(eq("_id", id)).forEach(doc -> {
       BsonReader reader = doc.getBsonReader();
       reader.readStartDocument();
       while (reader.readBsonType() != BsonType.END_OF_DOCUMENT) {
           String name = reader.readName();
           if ("patientId".equals(name)) {
               String patientId = reader.readString();
           } else if ("diagnosis".equals(name)) {
               String diagnosis = reader.readString();
           } else {
               reader.skipValue();  // 跳过不需要的字段
           }
       }
       reader.readEndDocument();
   });
   ```

2. **字段投影**：
   ```java
   // 只查询需要的字段，避免拉取整个文档
   collection.find(eq("_id", id))
       .projection(Projections.include("patientId", "diagnosis", "prescription"))
       .first();
   ```

3. **分页查询**：
   ```java
   // 大文档拆分为多个小文档
   // diagnosis 子文档单独存储
   // prescription 子文档单独存储
   ```

4. **限制并发数**：
   ```java
   // 限制同时读取大文档的请求数
   Semaphore semaphore = new Semaphore(10);  // 最多 10 个并发
   public Document readLargeDoc(String id) throws InterruptedException {
       semaphore.acquire();
       try {
           return collection.find(eq("_id", id)).first();
       } finally {
           semaphore.release();
       }
   }
   ```

#### 5. GC 日志分析方法论

**Full GC STW 1.2 秒的根因定位流程**：

```
1. 拿到 GC 日志
   - 启动参数加 -Xlog:gc*:file=/var/log/gc.log:time,level,tags
   - 或 JDK 8: -XX:+PrintGCDetails -XX:+PrintGCDateStamps -Xloggc:/var/log/gc.log

2. 定位 Full GC 类型
   - Full GC (System.gc()) → 显式触发
   - Full GC (Allocation Failure) → Old 代满
   - Full GC (Metaspace) → Metaspace 满
   - Full GC (CMS Mode Failure) → CMS 退化
   - Full GC (GCLocker Initiated GC) → JNI Critical 区域

3. 分析 Full GC 前的 Old 代使用情况
   - 看 GC 日志中 Full GC 前 5-10 次 Minor GC 的晋升速率
   - 晋升速率过高 → Old 代快速膨胀
   - 晋升速率正常 → 大对象直接进 Old 代

4. 关联监控指标
   - GC 时间点 vs QPS 突增 → 流量峰值
   - GC 时间点 vs 业务事件 → 大批量操作（如对账）
   - GC 时间点 vs 部署 → 新代码引入

5. dump 分析
   - -XX:+HeapDumpOnOutOfMemoryError 自动 dump
   - jcmd <pid> GC.heap_dump /tmp/heap.hprof 手动 dump
   - MAT 分析 Old 代对象类型分布
```

**GC 日志的关键指标**：

```
G1 GC 日志示例（解析）：

[2026-07-29 10:23:45.123] GC pause (G1 Evacuation Pause) (young) (initial-mark)
  [GC Worker (id=0): 23.4ms]
  [GC Worker (id=1): 24.1ms]
  [Eden: 1024.0M(1024.0M)->0.0B(1024.0M) Survivors: 32.0M->32.0M Heap: 12.3G(16.0G)->11.5G(16.0G)]
  [Times: user=0.18 sys=0.02, real=0.02 secs]

关键指标：
- real time: 0.02 secs = 20ms（实际 STW 时间）
- user time: 0.18 secs（CPU 时间，并行多线程累加）
- Heap before: 12.3G → after: 11.5G（本次回收 800MB）
- Eden: 1024M → 0（清空 Eden）
- Survivors: 32M → 32M（不变，已晋升）
```

**GC 吞吐、停顿、频率的定义**：

| 指标 | 定义 | 计算 | 健康值 |
|------|------|------|--------|
| **吞吐量** | 应用时间占总时间比例 | 1 - (GC 时间 / 总时间) | > 95% |
| **停顿时间** | 单次 GC STW 时长 | real time | &lt; 200ms |
| **GC 频率** | 单位时间 GC 次数 | 次数 / 分钟 | Minor GC > 30 秒/次 |
| **晋升速率** | 单位时间晋升 Old 代大小 | MB/秒 | &lt; 10MB/秒 |
| **回收效率** | 单次 GC 回收 / GC 时间 | MB/秒 | > 100MB/秒 |

**GCEasy / GCViewer 分析方法**：

```
GCEasy (https://gceasy.io):
1. 上传 GC 日志文件
2. 关键图表：
   - Throughput（吞吐量）：> 95% 为健康
   - Avg Pause GC Time（平均停顿）：< 200ms
   - Max Pause GC Time（最大停顿）：< 500ms
   - Young / Old / Humongous 分布
3. 关键问题提示：
   - Frequent Full GCs（频繁 Full GC）
   - Long Pauses（长停顿）
   - High Object Promotion（高晋升速率）
   - Inconsistent GC Duration（GC 时间波动大）

GCViewer:
- 本地工具，离线分析
- 关键指标：吞吐量、停顿时间分布、堆使用率
- 适合大量 GC 日志分析
```

**与监控指标关联**：

```
Prometheus + Grafana 关联：

1. JVM 指标（jvm_gc_pause_seconds, jvm_gc_pause_seconds_max）
   - 通过 Micrometer 暴露
   - 与 GC 日志对照

2. 业务指标（QPS, RT）
   - GC 时间点 vs QPS 突降 → STW 影响
   - GC 时间点 vs RT 飙升 → STW 影响

3. 系统指标（CPU, Memory, Network）
   - GC 时间点 vs CPU 飙升 → GC 占 CPU
   - GC 时间点 vs 内存下降 → GC 回收内存

4. 中间件指标（DB, Redis, MQ）
   - GC 时间点 vs DB 慢查询 → 连接超时
   - GC 时间点 vs Redis 超时 → 连接断开
```

**Full GC 触发的几种根因**：

```
1. System.gc() 显式触发
   - 应用代码或第三方库调用
   - 修复：-XX:+DisableExplicitGC 禁用

2. Old 代满
   - 晋升速率 > 回收速率
   - 修复：增大 Old 代 / 减少晋升

3. Metaspace 满
   - 动态生成类（CGLIB, Groovy）
   - 修复：-XX:MaxMetaspaceSize=512M + 排查类泄漏

4. CMS Concurrent Mode Failure
   - Old 代碎片化 + 晋升失败
   - 修复：改用 G1 或定期整理

5. 显式 dump
   - jcmd GC.heap_dump
   - 触发 Full GC

6. Heap Dump On OOM
   - -XX:+HeapDumpOnOutOfMemoryError
   - 触发 Full GC

7. GCLocker Initiated GC
   - JNI Critical 区域占用内存
   - 修复：减少 JNI Critical 使用
```

**JFR + Async-Profiler 全链路归因**：

```bash
# JFR（Java Flight Recorder）
jcmd <pid> JFR.start name=profile duration=60s filename=/tmp/profiler.jfr
# 分析：
#   - JDK Mission Control (JMC) 打开 .jfr 文件
#   - 查看 GC 事件、对象分配热点、方法调用热点

# Async-Profiler
./profiler.sh -d 60 -f /tmp/flame.html <pid>
# 分析：
#   - 火焰图查看 CPU 占用
#   - 找到对象分配热点
#   - 关联 GC 触发时间
```

---

## 本日能力差距与补足方向

### 差距 1：分代假说与晋升规则的工程理解不深
> Day2发现

- **现状**：知道新生代用复制、老年代用标记整理，但动态年龄规则、过早晋升、Survivor 大小调优等工程细节模糊
- **架构师水平**：能根据对象创建速率、存活时间精确规划新生代大小、SurvivorRatio、MaxTenuringThreshold；能用 `-XX:+PrintAdaptiveSizePolicy` 验证 JVM 的动态调整
- **补足方向**：精读《深入理解 Java 虚拟机》第 3 章分代收集；用 JMH 实测不同 SurvivorRatio 下的晋升速率；阅读 HotSpot `ageTable.cpp` 源码

### 差距 2：Card Table 与 Remembered Set 的精度权衡不熟
> Day2发现

- **现状**：知道 Card Table 是 512B 卡片，但精度选择、多精度 Card Table（HotSpot 实际有 3 种精度）、G1 的 Region 级 RS 设计不深
- **架构师水平**：能讲清 Card Table 的 3 种精度（CARD_VERBOSE / CARD_SUMMARY / CARD_DIRTY）、G1 的 RS 哈希表实现、为什么 G1 不用全堆 Card Table
- **补足方向**：阅读 HotSpot `cardTableRS.cpp`、`g1RemSet.cpp` 源码；对比 CMS 全堆 Card Table 与 G1 Region 级 RS 的实测开销

### 差距 3：写屏障的两种实现细节不清
> Day2发现

- **现状**：知道 CMS 用增量更新、G1 用 SATB，但 pre-write barrier 与 post-write barrier 的具体执行流程、SATB 队列处理时机、写屏障对 JIT 优化的影响不深
- **架构师水平**：能讲清 SATB 写屏障的代码级实现、SATB 队列在 Remark 阶段的处理、为什么 SATB 不能用于移动对象（需要读屏障）
- **补足方向**：阅读 G1 论文《Garbage-First Garbage Collection》；阅读 OpenJDK `g1SATBCardTableModRefBS.cpp`；Day07 深挖 G1 时深入

### 差距 4：Safepoint 的实现机制与陷阱不熟
> Day2发现

- **现状**：知道 Safepoint 是"所有线程暂停的位置"，但轮询机制、Counted Loop 陷阱、Safe Region、JNI 状态下的 Safepoint 问题不深
- **架构师水平**：能用 `-XX:+PrintSafepointStatistics` 分析 Safepoint 等待时间；能识别 Counted Loop 导致的 STW 延迟；能讲清 JDK 12+ 并发栈扫描与 ZGC 的关系
- **补足方向**：阅读 Aleksey Shipilev 的《Safepoints Are Real》；用 JMH 实测 Counted Loop 与非 Counted Loop 的 Safepoint 行为差异

### 差距 5：GC 日志分析方法论缺少实战
> Day2发现，延续第1周差距

- **现状**：能看懂 GC 日志的格式，但缺生产实战——如何从一次 Full GC 日志快速定位根因、如何关联监控指标、如何用 JFR + Async-Profiler 做全链路归因
- **架构师水平**：能在 30 分钟内从 GC 日志 + 监控指标定位 Full GC 根因；能用 JFR 分析对象分配热点；能用 Async-Profiler 火焰图找到 GC 触发的代码路径
- **补足方向**：第 2 周 Day04 实战；用 GCEasy 分析生产 GC 日志；调研 Netflix、LinkedIn 的 GC 排障方法论

### 差距 6：跨代引用的实战优化经验不足
> Day2发现

- **现状**：知道跨代引用要靠 Card Table，但在 SFU 这种"高频跨代引用"场景下如何减少跨代引用、如何优化 Session 引用结构、如何用对象池替代频繁分配，缺乏实战经验
- **架构师水平**：能根据业务场景设计低跨代引用的对象图；能用 JFR 的对象分配热点指导代码优化；能讲清 Recycler / ThreadLocal / 对象池的取舍
- **补足方向**：调研 Netty Recycler 实现；用 JFR 分析 SFU 服务的对象分配热点；第 2 周 Day05 在线问诊实战时深入
