# 架构师学习-Day03-GC 收集器全谱系

> 日期：2026年07月29日（周三）
> 周主题：JVM 专题第 1 周 - JVM 基础与核心
> 出题日：Day03 - GC 收集器全谱系

---

## 背景

Day02 讲了 GC 算法与分代收集理论--标记清除 / 复制 / 标记整理三种基础算法、跨代引用、Card Table、写屏障、Safepoint、并发标记。这些是"算法层面"，回答的是"GC 应该怎么做"。

Day03 进入"工程层面"--具体的 GC 收集器实现，回答的是"实际生产中用哪种 GC"。从 JDK 1.3 的 Serial 到 JDK 15+ 的 ZGC，GC 收集器演进 25 年，每一代都解决前一代的痛点：

1. **Serial（JDK 1.3）**：单线程 GC，Client 模式默认
2. **Parallel（JDK 1.4+）**：多线程并行，吞吐优先
3. **CMS（JDK 1.5+）**：并发收集，低停顿（JDK 9 弃用，JDK 14 移除）
4. **G1（JDK 1.7+）**：Region 模型，可预测停顿（JDK 9+ 默认）
5. **ZGC（JDK 11+）**：染色指针 + 读屏障，&lt; 10ms 停顿（JDK 15+ 生产可用）
6. **Shenandoah（JDK 12+）**：并发整理，RedHat 主导

Day03 全面对比 7 种收集器的设计哲学、适用场景、调优参数。这是 Day07 深挖 G1 底层、第 2 周调优实战的基础。

**与 Day02 的衔接**：
- Day02 讲了"分代假说"，Day03 讲"具体收集器如何实现分代"
- Day02 讲了"标记-清除 vs 标记-整理"，Day03 讲"CMS 用标记-清除、G1 用 Region 间复制"
- Day02 讲了"写屏障（SATB vs 增量更新）"，Day03 讲"CMS 用增量更新、G1 用 SATB"
- Day02 讲了"并发标记的四阶段"，Day03 讲"具体收集器的标记流程"

**与往周专题的衔接点**：

- **MySQL 存储引擎演进** vs **JVM GC 演进**：MyISAM -> InnoDB，Serial -> G1，都是"从简单到复杂，从单线程到并发"（6月第1周）
- **Redis 单线程 vs 多线程** vs **Serial vs Parallel GC**：都是"单线程简单 vs 多线程复杂"的权衡（6月第2周）
- **ES Lucene Near Real-Time** vs **CMS 并发标记**：都是"后台并发处理，前台低延迟"（6月第3周）
- **Sentinel 滑动窗口 vs LeapArray** vs **G1 Region 模型**：都是"分片处理 + 局部回收"（6月第4周）
- **K8s 容器化资源限制** vs **JVM GC 在容器中的行为**：JVM 在容器中如何感知 cgroup 限制（7月第3周）

**与简历项目的衔接点**：

在线问诊系统的不同服务应该用不同的 GC 收集器：

1. **IM 网关**：低停顿（100ms 目标），用 G1
2. **视频问诊 SFU**：极低停顿（20ms 目标），用 ZGC 或 G1
3. **业务服务（订单）**：均衡，用 G1
4. **内部管理后台**：吞吐优先，用 Parallel
5. **MongoDB 大文档服务**：低停顿 + 大对象处理，用 G1

Day03 会针对每个服务给出具体 GC 收集器选型与配置建议。第 2 周 Day05 在线问诊 JVM 实战时深入。

---

## 题目一（原理深挖题）：GC 收集器全谱系

请详细回答以下问题：

1. **Serial 与 Parallel 系列收集器**：Serial / Serial Old / ParNew / Parallel Scavenge / Parallel Old 五种收集器的设计哲学与适用场景？为什么 Parallel Scavenge 不能与 CMS 搭配（要用 ParNew）？Parallel Scavenge 与 ParNew 的核心区别（吞吐优先 vs 停顿优先）？为什么 JDK 9 之前默认 Parallel Scavenge + Parallel Old？
2. **CMS 收集器**：CMS 的四个阶段（初始标记 / 并发标记 / 重新标记 / 并发清除）？为什么 CMS 用标记-清除（不整理）？CMS 的三大问题（碎片化 / Concurrent Mode Failure / 浮动垃圾）？为什么 JDK 9 弃用 CMS，JDK 14 移除？CMS 的 `-XX:CMSInitiatingOccupancyFraction` 调优陷阱？
3. **G1 收集器**：G1 的 Region 模型（Eden / Survivor / Old / Humongous）？G1 的四种 GC 类型（Young GC / Mixed GC / Full GC / Concurrent Marking）？G1 的可预测停顿是如何实现的（MaxGCPauseMillis + Region 选择策略）？G1 的 Mixed GC 触发条件与回收策略？G1 vs CMS 的核心改进？为什么 G1 是 JDK 9+ 默认？
4. **ZGC 收集器**：ZGC 的染色指针（Colored Pointer）是什么？读屏障（Load Barrier）是什么？为什么 ZGC 能做到 &lt; 10ms 停顿？ZGC 的并发整理如何实现（多视图映射）？ZGC 的 Region 设计（Small / Medium / Large）？为什么 ZGC 在 JDK 15 才生产可用？ZGC 的吞吐代价有多大？
5. **Shenandoah 与收集器选型**：Shenandoah 的 Brooks 转发指针是什么？Shenandoah 与 ZGC 的核心差异？7 种收集器的选型决策树？不同业务场景（吞吐优先 / 低延迟 / 大堆 / 容器化）的选型建议？JDK 版本与默认收集器的对应关系？为什么 ZGC / Shenandoah 是"下一代 GC"？

### 作答区

#### 1. Serial 与 Parallel 系列收集器

**5 种收集器的关系图**：

```
新生代            老年代            配对关系
─────────────────────────────────────────────
Serial      ←→   Serial Old      单线程，Client 模式
ParNew      ←→   CMS             多线程 + 低停顿
Parallel    ←→   Parallel Old    多线程 + 吞吐优先
Scavenge

特殊：G1 不分代配对，ZGC / Shenandoah 也不分代
```

**Serial / Serial Old**：

- **设计哲学**：单线程 GC，最简单，最稳定
- **适用场景**：Client 模式（桌面应用）、微服务启动期、嵌入式设备
- **优点**：单线程无并发开销；冷启动快
- **缺点**：STW 时长 = GC 时间（无并发）
- **参数**：`-XX:+UseSerialGC`

**ParNew**：

- **设计哲学**：Serial 的多线程版本，与 CMS 搭配
- **适用场景**：与 CMS 配对，新生代并行收集
- **关键限制**：只能与 CMS 搭配，不能与 Parallel Scavenge 搭配
- **参数**：`-XX:+UseParNewGC`（与 CMS 一起用）

**Parallel Scavenge / Parallel Old**：

- **设计哲学**：吞吐优先（Throughput First），JDK 8 默认
- **适用场景**：批处理、后台计算、对停顿不敏感的业务
- **核心参数**：
  - `-XX:MaxGCPauseMillis`：最大停顿时间（目标）
  - `-XX:GCTimeRatio`：GC 时间占比（默认 99，即 GC 占 1%）
  - `-XX:+UseAdaptiveSizePolicy`：自适应调整新生代 / 老年代大小

**Parallel Scavenge vs ParNew 的核心区别**：

| 维度 | ParNew | Parallel Scavenge |
|------|--------|------------------|
| 设计目标 | 停顿优先（与 CMS 配合） | 吞吐优先 |
| 自适应调整 | 无 | 有（UseAdaptiveSizePolicy） |
| 搭配 Old 代 | CMS | Parallel Old |
| 参数 | -XX:UseParNewGC | -XX:UseParallelGC |
| 重点 | 配合 CMS 低停顿 | 最大化业务吞吐 |

**为什么 Parallel Scavenge 不能与 CMS 搭配**：

- Parallel Scavenge 的"自适应调整"会动态改变新生代大小
- CMS 的并发标记依赖稳定的代边界
- 两者冲突，JDK 8 中显式配对会报错

**为什么 JDK 9 之前默认 Parallel Scavenge + Parallel Old**：

- JDK 6-8 时代，服务器以"批处理 + 高吞吐"为主
- 互联网应用对延迟不敏感，吞吐更重要
- Parallel 系列最稳定，调优简单
- JDK 9 后默认改为 G1（互联网应用延迟敏感）

**5 种收集器的对比**：

| 收集器 | 新生代 / 老年代 | 线程模型 | 算法 | 停顿 | 吞吐 | 适用场景 |
|--------|---------------|---------|------|------|------|---------|
| Serial / Serial Old | 分代 | 单线程 | 复制 / 标记整理 | 长 | 中 | Client |
| ParNew + CMS | 分代 | ParNew 多线程 + CMS 并发 | 复制 / 标记清除 | 短 | 中 | 低延迟（已弃用） |
| Parallel Scavenge + Parallel Old | 分代 | 多线程 | 复制 / 标记整理 | 中 | 高 | 吞吐优先 |
| G1 | 逻辑分代 | 多线程 + 并发 | Region 间复制 | 可预测 | 中高 | 通用 |
| ZGC | 不分代 | 并发 | 染色指针 + 读屏障 | &lt; 10ms | 中 | 极低延迟 |
| Shenandoah | 不分代 | 并发 | Brooks 转发指针 | &lt; 10ms | 中 | 极低延迟 |

#### 2. CMS 收集器

**CMS 的四个阶段**：

```
阶段 1：初始标记（Initial Mark） - STW
   - 标记 GC Roots 直接引用的对象
   - 时间短（毫秒级）
   - 单线程或并行（CMS Parallel Initial Mark）

阶段 2：并发标记（Concurrent Mark） - 与应用并发
   - 从 GC Roots 遍历整个对象图
   - 使用增量更新（post-write barrier）
   - 时间长（秒级），但不阻塞应用

阶段 3：重新标记（Remark） - STW
   - 处理并发标记期间的引用变更
   - 扫描脏 Card（Card Table）
   - 时间中等（百毫秒级）

阶段 4：并发清除（Concurrent Sweep） - 与应用并发
   - 清除未标记对象
   - 不移动对象（标记-清除）
   - 时间长（秒级），不阻塞应用
```

**为什么 CMS 用标记-清除（不整理）**：

1. **避免 STW 整理**：标记-整理需要移动对象，必须 STW
2. **追求低停顿**：CMS 的设计目标是 STW &lt; 200ms
3. **代价是碎片化**：长期运行后碎片严重，最终触发 Full GC

**CMS 的三大问题**：

**问题 1：碎片化**：

```
CMS 运行后 Old 代状态：
┌────┬──┬────┬─┬────┬──┬────┐
│obj1│  │obj2│ │obj3│  │obj4│  ← 大量碎片
└────┴──┴────┴─┴────┴──┴────┘

分配大对象时找不到连续空间 -> 触发 Full GC
```

**问题 2：Concurrent Mode Failure**：

```
场景：CMS 并发标记 / 清除期间，Old 代满了
   - 应用线程要分配 Old 代空间（晋升）
   - Old 代无空间，CMS 还没回收到
   -> 触发 Concurrent Mode Failure
   -> 退化为 Serial Old 单线程 Full GC
   -> STW 时间 = 数秒到数十秒
```

**问题 3：浮动垃圾**：

```
CMS 标记期间，应用线程产生新的垃圾：
   - 对象 A 被标记为黑色（存活）
   - 应用线程删除 A 的所有引用
   - A 实际死亡，但 CMS 已标记为存活
   -> 浮动垃圾，下次 GC 才能回收
```

**为什么 JDK 9 弃用 CMS、JDK 14 移除**：

1. **CMS 的内在矛盾无法解决**：标记-清除产生碎片，最终退化
2. **G1 已经成熟**：G1 解决了 CMS 的所有痛点，且更稳定
3. **维护成本高**：CMS 代码复杂，与 G1 重叠
4. **未来是 ZGC / Shenandoah**：低延迟 GC 是趋势

**CMSInitiatingOccupancyFraction 调优陷阱**：

```bash
-XX:CMSInitiatingOccupancyFraction=70   # Old 代 70% 满时触发 CMS
-XX:+UseCMSInitiatingOccupancyOnly      # 不动态调整（固定 70%）
```

**陷阱**：
- 设太高（如 80%）：Old 代容易满，触发 Concurrent Mode Failure
- 设太低（如 50%）：CMS 频繁触发，浪费 CPU
- 不设 UseCMSInitiatingOccupancyOnly：JVM 动态调整，行为不可预测

**CMS 的参数调优清单**（已弃用，但理解有助于理解 G1）：

```bash
-XX:+UseConcMarkSweepGC                   # 启用 CMS（JDK 14 移除）
-XX:CMSInitiatingOccupancyFraction=70     # Old 代 70% 触发
-XX:+UseCMSInitiatingOccupancyOnly        # 固定阈值
-XX:+CMSClassUnloadingEnabled             # 启用 Metaspace 回收
-XX:+CMSParallelRemarkEnabled             # 并行重新标记
-XX:+CMSScavengeBeforeRemark              # 重新标记前先 Minor GC
-XX:ConcGCThreads=4                       # 并发标记线程数
-XX:ParallelCMSThreads=8                  # 并行 STW 线程数
```

#### 3. G1 收集器

**G1 的 Region 模型**：

```
堆被划分为 ~2048 个 Region（默认 1-32MB）

┌─────┬─────┬─────┬─────┬─────┬─────┬─────┬─────┐
│  E  │  E  │  S  │  O  │  O  │  H  │  H  │  O  │
├─────┼─────┼─────┼─────┼─────┼─────┼─────┼─────┤
│  O  │  E  │  O  │  O  │  H  │ --  │  E  │  S  │
├─────┼─────┼─────┼─────┼─────┼─────┼─────┼─────┤
│  H  │  O  │  O  │  E  │  O  │  O  │  O  │ --  │
└─────┴─────┴─────┴─────┴─────┴─────┴─────┴─────┘

E = Eden Region（新生代）
S = Survivor Region（幸存区）
O = Old Region（老年代）
H = Humongous Region（大对象）
-- = Free Region（空闲）

特点：
1. Region 角色动态切换（不是物理分代）
2. 逻辑分代，物理上 Region 散布在堆中
3. 大对象（> Region/2）独占 Humongous Region
4. G1 跟踪每个 Region 的"存活对象量"，回收价值高的优先
```

**G1 的四种 GC 类型**：

**1. Young GC（Minor GC）**：

```
触发：Eden 满
流程：
  - 复制 Eden + Survivor 存活对象到新 Survivor
  - 清空原 Eden / Survivor Region
  - Region 角色切换
STW：通常 10-100ms
```

**2. Concurrent Marking（并发标记）**：

```
触发：Old 代占用率达到 IHOP（默认 45%）
流程：
  - 初始标记（STW，借道一次 Young GC）
  - 并发标记（SATB 写屏障）
  - 重新标记（STW，处理 SATB 队列）
  - 清理（STW 短暂，统计 Region 存活对象）
```

**3. Mixed GC**：

```
触发：并发标记完成后，选择"回收价值高"的 Region
流程：
  - 回收全部新生代 Region
  + 回收部分 Old Region（基于回收价值）
STW：通常 50-200ms（取决于回收 Region 数）
```

**4. Full GC**：

```
触发：Mixed GC 来不及 / 大对象分配失败 / 显式 System.gc()
流程：
  - 退化为 Serial Single-Threaded Full GC（JDK 10 之前）
  - JDK 10+ 改为并行 Full GC
STW：数秒到数十秒
```

**G1 的可预测停顿是如何实现的**：

```
MaxGCPauseMillis = 200（默认 200ms）

G1 的 Region 选择策略（用于 Mixed GC）：
1. 维护每个 Region 的"回收价值"
   - 回收价值 = Region 中死亡对象大小 / 预计回收时间
2. 按"回收价值"从高到低排序
3. 选择 Region，直到累计回收时间达到 MaxGCPauseMillis
4. 只回收选中的 Region

实现细节：
   - G1 用历史数据预测每个 Region 的回收时间
   - 用户设置 MaxGCPauseMillis，G1 自动选择 Region 数
   - 这是"可预测停顿"的本质
```

**Mixed GC 触发条件**：

1. **并发标记完成**：Old 代占用率超过 IHOP，触发并发标记
2. **G1 选择 Mixed GC 候选 Region**：标记完成后，统计每个 Old Region 的存活对象量
3. **下次 Young GC 升级为 Mixed GC**：在 Young GC 基础上，额外回收部分 Old Region
4. **回收比例**：`-XX:G1MixedGCCountTarget=8`（默认 8 次 Mixed GC 回收完所有候选 Old Region）

**G1 vs CMS 的核心改进**：

| 维度 | CMS | G1 |
|------|-----|-----|
| 算法 | 标记-清除 | Region 间复制（局部整理） |
| 碎片化 | 严重 | 无 |
| 停顿可控 | 不可预测 | 可预测（MaxGCPauseMillis） |
| 大对象 | 直接 Old 代 | Humongous Region |
| 跨代引用 | 全堆 Card Table | Region 级 RS |
| 写屏障 | 增量更新（post） | SATB（pre） |
| Full GC | Serial Old 兜底 | JDK 10+ 并行 Full GC |

**为什么 G1 是 JDK 9+ 默认**：

1. **CMS 维护成本高**：内在矛盾无法解决
2. **G1 更稳定**：无碎片化，无 Concurrent Mode Failure
3. **G1 可预测停顿**：满足现代互联网应用需求
4. **G1 调优简单**：只需设 MaxGCPauseMillis，无需精细调参
5. **G1 适合大堆**：6GB+ 堆 G1 表现优于 CMS

**G1 的关键参数**：

```bash
-XX:+UseG1GC                            # 启用 G1（JDK 9+ 默认）
-XX:MaxGCPauseMillis=200                # 目标停顿 200ms
-XX:G1HeapRegionSize=16m                # Region 大小（1-32MB，自动选择）
-XX:InitiatingHeapOccupancyPercent=45   # Old 代 45% 触发并发标记
-XX:G1NewSizePercent=5                  # 新生代占比下限
-XX:G1MaxNewSizePercent=60              # 新生代占比上限
-XX:G1MixedGCCountTarget=8              # Mixed GC 次数目标
-XX:G1MixedGCLiveThresholdPercent=85    # Region 存活对象 > 85% 不回收
-XX:ConcGCThreads=4                     # 并发标记线程数
-XX:ParallelGCThreads=16                # STW 并行线程数
```

#### 4. ZGC 收集器

**ZGC 的染色指针（Colored Pointer）**：

```
64 位指针布局（ZGC）：
┌─────────────────────────────────────────────────────────────────┐
│ 63  62  61  60  59  58  57  56  55   ...   4  3  2  1  0       │
│ unused│ F | R | M | M |             地址位                  │
└─────────────────────────────────────────────────────────────────┘

- bits 0-41：实际地址（42 位，可寻址 4TB）
- bits 42-45：Finalizable 标记位
- bits 46-49：Remapped 标记位
- bits 50-53：Marked 标记位
- bits 54-57：保留

染色指针的作用：
1. 把"标记信息"放在指针里，而不是对象头
2. GC 修改指针的染色位，不需要修改对象
3. 多视图映射：同一物理地址有多个"染色视图"
```

**ZGC 的读屏障（Load Barrier）**：

```
应用线程读取引用时：
1. 检查指针的染色位
2. 如果指针"过期"（指向已移动对象的旧地址）
   -> 触发读屏障
   -> 通过多视图映射找到新地址
   -> 修正指针
3. 返回新地址

读屏障的实现：
- JIT 在每次对象引用读取后插入检查
- 开销：约 5-10% 性能损失
- 优势：GC 移动对象无需 STW
```

**ZGC 的并发整理**：

```
传统 GC 整理：
   1. 移动对象
   2. 更新所有引用
   - 必须在 STW 中完成（引用更新一致性）

ZGC 并发整理：
   1. GC 线程移动对象（复制到新 Region）
   2. 旧地址保留（多视图映射）
   3. 应用线程读引用时，读屏障检查
   4. 如果读的是旧地址，读屏障修正为新地址
   5. GC 后台逐步修正所有引用

关键：读屏障让"引用更新"可以并发进行
```

**为什么 ZGC 能做到 &lt; 10ms 停顿**：

1. **初始标记 / 重新标记 STW 极短**：只标记 GC Roots 直接引用，毫秒级
2. **并发标记 / 并发整理**：与应用线程并发
3. **读屏障替代部分 STW**：引用修正并发进行
4. **染色指针避免修改对象**：GC 修改指针，不动对象

**ZGC 的 Region 设计**：

```
ZGC 的 Region 大小动态：
- Small Region：2MB（普通对象）
- Medium Region：32MB（中等对象）
- Large Region：动态（大对象独占）

与 G1 的差异：
- G1 Region 固定（1-32MB）
- ZGC Region 动态，更适合大对象
- ZGC 不分代（JDK 21 才有分代 ZGC）
```

**ZGC 的演进历史**：

| JDK 版本 | ZGC 状态 |
|---------|---------|
| JDK 11 | 实验性（-XX:+UnlockExperimentalVMOptions） |
| JDK 13 | 改进，支持类卸载 |
| JDK 14 | macOS / Windows 支持 |
| JDK 15 | 生产可用（移除 Experimental 标志） |
| JDK 16 | 改进吞吐量 |
| JDK 21 | 分代 ZGC（重大改进） |

**ZGC 的吞吐代价**：

- **停顿时间**：&lt; 10ms（堆大小无关）
- **吞吐量损失**：约 10-15%（读屏障开销）
- **CPU 占用**：高（并发 GC 线程多）
- **内存开销**：染色指针占用 4 位地址空间，堆上限 4TB（JDK 15）/ 16TB（JDK 17+）

**ZGC 的参数**：

```bash
-XX:+UseZGC                  # JDK 15+ 直接使用
-XX:+UnlockExperimentalVMOptions -XX:+UseZGC  # JDK 11-14
-XX:ConcGCThreads=4          # 并发线程数
-XX:ParallelGCThreads=16     # STW 线程数
-XX:ZCollectionInterval=120  # 强制 GC 间隔（秒）
-XX:ZAllocationSpikeTolerance=2  # 分配峰值容忍度
```

#### 5. Shenandoah 与收集器选型

**Shenandoah 的 Brooks 转发指针**：

```
每个对象头多一个"转发指针"（Brooks Pointer）：

普通对象布局：
┌────────────────────────┐
│ Mark Word    (8 bytes) │
│ Klass Pointer (4 bytes)│
│ 实例数据               │
└────────────────────────┘

Shenandoah 对象布局：
┌────────────────────────┐
│ Brooks Pointer (8 bytes)│  ← 指向自己（未移动）或新地址（已移动）
│ Mark Word    (8 bytes) │
│ Klass Pointer (4 bytes)│
│ 实例数据               │
└────────────────────────┘

GC 移动对象时：
1. 复制对象到新地址
2. 旧对象的 Brooks Pointer 指向新地址
3. 应用线程访问旧对象 -> 读 Brooks -> 找到新对象

与 ZGC 的差异：
- ZGC 用染色指针 + 多视图映射
- Shenandoah 用对象头多一个指针
- ZGC 读屏障检查指针染色位
- Shenandoah 读屏障读 Brooks Pointer

Shenandoah 的 Brooks Pointer 开销：
- 每个对象多 8 字节
- 内存开销约 5-10%
- 读屏障开销约 10-15%
```

**Shenandoah 与 ZGC 的核心差异**：

| 维度 | ZGC | Shenandoah |
|------|-----|-----------|
| 引用修正 | 染色指针 + 多视图映射 | Brooks 转发指针 |
| 对象头 | 标准 | 多 8 字节 |
| 内存开销 | 染色位（小） | Brooks Pointer（大） |
| 主导方 | Oracle | RedHat |
| JDK 版本 | JDK 11+ | JDK 12+ |
| 默认 | 无 | 无 |
| 停顿 | &lt; 10ms | &lt; 10ms |

**7 种收集器的选型决策树**：

```
是否单核或内存 < 100MB？
   └─ 是 -> Serial
   └─ 否
       |
是否对延迟极敏感（< 10ms）？
   └─ 是
   |   ├─ JDK 15+ 且堆 > 16GB -> ZGC
   |   ├─ JDK 12+ 且 RedHat 系 -> Shenandoah
   |   └─ 其他 -> G1（适当调小 Region）
   └─ 否
       |
是否吞吐优先（批处理 / 后台计算）？
   └─ 是 -> Parallel Scavenge + Parallel Old
   └─ 否
       |
堆大小？
   ├─ < 4GB -> Parallel 或 G1
   ├─ 4-32GB -> G1
   ├─ 32GB-16TB -> ZGC
   └─ > 16TB -> ZGC（JDK 17+）
```

**不同业务场景的选型建议**：

| 场景 | 推荐 GC | 原因 |
|------|--------|------|
| 互联网业务（响应敏感） | G1 | 平衡吞吐与停顿 |
| 实时游戏 / 视频 | ZGC | &lt; 10ms 停顿 |
| 批处理 / 大数据 | Parallel | 吞吐优先 |
| 微服务（小堆） | G1 | 简单稳定 |
| 大堆（> 32GB） | ZGC | 停顿不随堆增长 |
| 容器化（K8s） | G1 | 适配 cgroup |
| 内部管理后台 | Parallel | 不敏感 |
| 启动期 | Serial | 冷启动快 |

**JDK 版本与默认收集器对应**：

| JDK 版本 | 默认 GC | 备注 |
|---------|--------|------|
| JDK 8 | Parallel Scavenge + Parallel Old | 服务端默认 |
| JDK 9-10 | G1 | 改默认为 G1 |
| JDK 11-17 | G1 | ZGC 实验性（JDK 11）/ 生产（JDK 15） |
| JDK 17 | G1 | ZGC 生产可用 |
| JDK 21 | G1 | 分代 ZGC（JEP 439） |
| JDK 25+ | G1 / ZGC | ZGC 越来越主流 |

**为什么 ZGC / Shenandoah 是"下一代 GC"**：

1. **停顿与堆大小无关**：传统 GC 停顿随堆增长，ZGC / Shenandoah 始终 &lt; 10ms
2. **并发整理**：彻底解决"对象移动必须 STW"的问题
3. **读屏障替代部分 STW**：让 GC 与应用真正并发
4. **适合大堆 / 容器化**：现代云原生应用的关键需求
5. **染色指针 / Brooks 转发指针**：是 GC 设计的范式转移

---

## 题目二（实战场景题）：在线问诊系统的 GC 收集器选型

结合在线问诊系统的实际场景，回答以下问题：

1. **IM 网关的 GC 选型与调优**：IM 长连接网关承载 12w 长连接，峰值 15w，每秒处理 5w 心跳包。GC 选型应该选什么？为什么 G1 比 CMS 更适合 IM 网关？MaxGCPauseMillis 设多少？为什么不能设太小（如 10ms）？如何估算 IM 网关的 GC 频率与停顿？JDK 8 vs JDK 17 的 IM 网关 GC 配置差异？
2. **视频问诊 SFU 的 GC 选型与调优**：视频问诊 SFU 峰值 5800 路并发，每路 750 包/秒，对象创建速率 278MB/秒。GC 应该选 G1 还是 ZGC？MaxGCPauseMillis 设多少？如果用 ZGC，吞吐代价能否承受？ZGC 在视频问诊场景的优缺点？JDK 版本对 ZGC 选型的影响？
3. **问诊业务服务的 GC 选型**：问诊订单 / 处方 / 医师服务等业务服务，QPS 中等（2000-5000），有本地 Caffeine 缓存（100w 订单）。GC 选型？为什么 Parallel 不适合业务服务？G1 的 IHOP 调优？如果出现 Mixed GC 频繁，怎么排查？
4. **MongoDB 大文档服务的 GC 调优**：问诊诊疗事件 JSON 文档最大 5MB，IM 消息存档 16MB。G1 的 Humongous Region 如何处理这些大对象？为什么 G1 的 Humongous Region 容易引发问题？如何避免大对象进入 Humongous Region？G1HeapRegionSize 怎么设？
5. **JDK 升级与 GC 迁移**：在线问诊系统从 JDK 8（CMS）升级到 JDK 17（G1），GC 迁移需要注意什么？CMS 参数在 G1 中的对应？哪些 CMS 参数在 G1 中无效？如何验证 G1 的实际表现？JDK 8 -> 11 -> 17 的渐进升级路径？是否值得上 ZGC？

### 作答区

#### 1. IM 网关的 GC 选型与调优

**IM 网关的 GC 选型**：

推荐 **G1 收集器**（JDK 11+ 默认）。

**为什么 G1 比 CMS 更适合 IM 网关**：

| 维度 | CMS | G1 | IM 网关需求 |
|------|-----|-----|------------|
| 停顿可控 | 不可预测 | 可预测 | 必须可预测（实时性敏感） |
| 碎片化 | 严重 | 无 | 长连接服务长期运行，碎片致命 |
| 大对象 | 进 Old 代 | Humongous Region | IM 大消息（如图片）需处理 |
| Full GC | Serial Old 兜底 | 并行 Full GC | Full GC 影响所有连接 |
| 维护 | 已弃用 | 长期支持 | 避免技术债 |

**MaxGCPauseMillis 设置**：

```bash
-XX:MaxGCPauseMillis=100
```

**为什么不能设太小（如 10ms）**：

1. **G1 选择的 Region 数过少**：每次 GC 回收量小，GC 频率上升
2. **频繁 GC 反而增加总 STW 时间**：100 次 10ms vs 10 次 100ms，总时间相同，但频繁 GC 增加业务毛刺
3. **Idleness 浪费**：GC 太频繁，应用线程 CPU 时间减少
4. **回收价值评估失真**：G1 用历史数据预测回收时间，目标过小导致数据不准

**IM 网关 GC 频率与停顿估算**：

```
堆配置：-Xms8g -Xmx8g
新生代：~3GB（G1 自适应，NewRatio 不直接控制）
Eden：~2.4GB
每秒对象创建：17.5MB（5w 心跳 × 350B）

Young GC 频率：
   2.4GB / 17.5MB = 137 秒/次

每次 Young GC 回收：
   - 90% 对象死亡，回收 2.16GB
   - STW 时间：~50-100ms（取决于 Region 数和存活对象）

Mixed GC 频率：
   - Old 代 45% 触发并发标记
   - 假设晋升速率 1MB/秒（10% 存活 0.1 秒）
   - Old 代 3.6GB（45% of 8GB）= 3600MB
   - 时间：3600 / 1 = 3600 秒（1 小时）
   - 即每小时一次 Mixed GC
```

**JDK 8 vs JDK 17 的 IM 网关 GC 配置差异**：

```bash
# JDK 8（G1 已可用，但部分参数不支持）
-Xms8g -Xmx8g
-XX:+UseG1GC
-XX:MaxGCPauseMillis=100
-XX:InitiatingHeapOccupancyPercent=45
-XX:G1HeapRegionSize=16m
-XX:+ParallelRefProcEnabled

# JDK 17（G1 改进，新增参数）
-Xms8g -Xmx8g
-XX:+UseG1GC
-XX:MaxGCPauseMillis=100
-XX:InitiatingHeapOccupancyPercent=45
-XX:G1HeapRegionSize=16m
-XX:+ParallelRefProcEnabled
-XX:+UnlockExperimentalVMOptions  # 不需要，JDK 17 已稳定
# JDK 17 新特性：
-XX:+UseStringDeduplication       # 字符串去重（IM 消息有大量重复）
-XX:G1PeriodicGCInterval=30m      # 周期性 GC（30 分钟）
-XX:+G1UseAdaptiveIHOP            # 自适应 IHOP（JDK 12+）
```

**IM 网关完整 JVM 配置（JDK 17）**：

```bash
-Xms8g -Xmx8g                          # 堆 8GB
-XX:MaxDirectMemorySize=8g              # 直接内存 8GB（Netty 用）
-XX:MetaspaceSize=256M
-XX:MaxMetaspaceSize=512M
-XX:+UseG1GC
-XX:MaxGCPauseMillis=100
-XX:InitiatingHeapOccupancyPercent=45
-XX:G1HeapRegionSize=16m
-XX:+ParallelRefProcEnabled
-XX:+UseStringDeduplication
-XX:+HeapDumpOnOutOfMemoryError
-XX:HeapDumpPath=/data/heapdump/
-Xlog:gc*:file=/var/log/gc.log:time,level,tags:filecount=10,filesize=100M
-Dio.netty.allocator.type=pooled
-Dio.netty.leakDetection.level=SIMPLE
```

#### 2. 视频问诊 SFU 的 GC 选型与调优

**SFU 的 GC 选型分析**：

**选项 A：G1（保守稳定）**

```bash
-XX:+UseG1GC
-XX:MaxGCPauseMillis=20  # 目标 20ms（视频实时性极高）
```

**选项 B：ZGC（极致低延迟）**

```bash
-XX:+UseZGC  # JDK 15+
```

**G1 vs ZGC 在 SFU 场景的对比**：

| 维度 | G1 | ZGC |
|------|-----|-----|
| 停顿时间 | 20-50ms | &lt; 10ms |
| 吞吐损失 | 5-10% | 10-15% |
| 内存开销 | 标准 | 染色指针 |
| JDK 版本 | JDK 9+ | JDK 15+ |
| 稳定性 | 长期生产验证 | JDK 15+ 较新 |
| 大对象 | Humongous Region | Large Region |
| 调优复杂度 | 中（MaxGCPauseMillis） | 低（基本无需调） |

**SFU 用 ZGC 的吞吐代价分析**：

```
SFU 单路视频 CPU 占用：
- 媒体解码 / 编码：~5% CPU
- RTP 处理：~2% CPU
- 网络收发：~3% CPU
- 总计：~10% CPU / 路

5800 路总 CPU：5800 × 10% = 580 CPU 核（理论值，实际需考虑并发）

ZGC 吞吐损失 10-15%：
- 多消耗 CPU：5800 × 10% × 10% = 58 核
- 实际部署需多配 58 核 / 32（单机核数）= ~2 台机器

G1 吞吐损失 5-10%：
- 多消耗 CPU：5800 × 10% × 5% = 29 核
- 实际部署需多配 ~1 台机器

权衡：
- G1 停顿 20-50ms，视频可能卡顿
- ZGC 停顿 < 10ms，视频流畅，但多花 1 台机器
- 视频问诊对流畅性要求高，多花 1 台机器可接受
```

**SFU 用 ZGC 的优缺点**：

**优点**：
- 停顿 &lt; 10ms，视频流畅
- 无需精细调参（MaxGCPauseMillis 等）
- 大堆（> 32GB）停顿不变
- 适合视频问诊的高对象创建速率

**缺点**：
- JDK 15+ 才生产可用（升级成本）
- 吞吐损失 10-15%（机器成本）
- CPU 占用高（并发 GC 线程多）
- 缺少长期生产案例（相对 G1）

**JDK 版本对 ZGC 选型的影响**：

| JDK 版本 | ZGC 状态 | 选型建议 |
|---------|---------|---------|
| JDK 11 | 实验 | 不推荐生产 |
| JDK 13 | 改进 | 谨慎试用 |
| JDK 14 | macOS / Windows | 跨平台可用 |
| JDK 15 | 生产可用 | 推荐生产 |
| JDK 16 | 吞吐改进 | 推荐 |
| JDK 21 | 分代 ZGC | 强烈推荐（重大改进） |

**SFU 推荐方案**：

```bash
# 方案 1：保守稳定（JDK 17 + G1）
-Xms16g -Xmx16g
-XX:MaxDirectMemorySize=8g
-XX:+UseG1GC
-XX:MaxGCPauseMillis=20
-XX:G1HeapRegionSize=16m
-XX:InitiatingHeapOccupancyPercent=40
-XX:G1NewSizePercent=30
-XX:G1MaxNewSizePercent=50
-XX:+ParallelRefProcEnabled

# 方案 2：极致低延迟（JDK 21 + 分代 ZGC）
-Xms16g -Xmx16g
-XX:MaxDirectMemorySize=8g
-XX:+UseZGC
-XX:ConcGCThreads=8
-XX:ParallelGCThreads=16
-XX:SoftMaxHeapSize=12g  # 软上限，触发并发 GC
```

#### 3. 问诊业务服务的 GC 选型

**业务服务的特征**：

- QPS 中等（2000-5000）
- 有本地 Caffeine 缓存（100w 订单 × 1KB = 1GB Old 代）
- 长生命周期对象多（缓存、连接池）
- 短生命周期对象（请求处理）少

**GC 选型：G1**

**为什么 Parallel 不适合业务服务**：

1. **Parallel 追求吞吐，停顿长**：业务服务对延迟敏感，单次 GC 停顿 > 500ms 不可接受
2. **Parallel 无并发标记**：Old 代满才 Full GC，STW 时间长
3. **Parallel 不适合大堆**：8GB+ 堆表现差
4. **Parallel 无 Mixed GC**：Old 代只能 Full GC 回收
5. **Parallel 是 JDK 8 默认**：JDK 9+ 已改 G1

**G1 的 IHOP 调优**：

```bash
-XX:InitiatingHeapOccupancyPercent=45  # 默认 45%
```

**IHOP 调优原理**：

```
IHOP 太低（如 30%）：
   - Old 代 30% 触发并发标记
   - Mixed GC 频繁
   - CPU 浪费在并发标记上

IHOP 太高（如 70%）：
   - Old 代 70% 才触发
   - Mixed GC 来不及回收
   - 容易 Full GC

JDK 12+ 引入 Adaptive IHOP：
   - G1 根据历史数据自动调整 IHOP
   - 默认开启（-XX:+G1UseAdaptiveIHOP）
   - 手动设置 IHOP 会被忽略
```

**Mixed GC 频繁的排查**：

```
症状：每小时多次 Mixed GC，STW 50-200ms

排查步骤：
1. 看 GC 日志中 Mixed GC 频率
   - 正常：每小时 1-2 次
   - 异常：每分钟多次

2. 看老年代增长速率
   - jstat -gcutil <pid> 1000
   - 观察 OU（Old Used）增长

3. 看晋升速率
   - GC 日志中 "Allocation Failure" 频率
   - 高晋升速率 = Survivor 太小 / 对象存活时间长

4. 看大对象分配
   - GC 日志中 "Humongous Regions" 数量
   - 大对象多 = 业务代码有大数组 / 大字符串

5. 看缓存填充
   - 业务是否有大量对象进 Caffeine
   - 缓存 TTL 是否合理

解决方案：
   - 增大堆 / 减少缓存
   - 调整 IHOP（关闭 Adaptive，手动设 50%）
   - 调整 G1MixedGCCountTarget=8（更多次回收）
   - 优化业务代码（减少大对象分配）
```

**问诊业务服务的 GC 配置**：

```bash
-Xms4g -Xmx4g                          # 堆 4GB
-XX:MaxDirectMemorySize=1g
-XX:MetaspaceSize=256M
-XX:MaxMetaspaceSize=512M
-XX:+UseG1GC
-XX:MaxGCPauseMillis=200               # 业务服务容忍 200ms
-XX:InitiatingHeapOccupancyPercent=45
-XX:G1HeapRegionSize=8m
-XX:+ParallelRefProcEnabled
-XX:+HeapDumpOnOutOfMemoryError
-XX:HeapDumpPath=/data/heapdump/
-Xlog:gc*:file=/var/log/gc.log:time,level,tags:filecount=10,filesize=100M
```

#### 4. MongoDB 大文档服务的 GC 调优

**G1 Humongous Region 的工作机制**：

```
G1HeapRegionSize=16m（默认）
- 普通对象：< 8MB（Region/2），在 Eden / Survivor / Old Region 分配
- 大对象：>= 8MB，进 Humongous Region

5MB 问诊 JSON 文档：
- 5MB < 8MB，是普通对象
- 但加上 ByteBuf + POJO 转换，瞬时分配可能 > 8MB
- 进入 Humongous Region

16MB IM 消息存档：
- 16MB > 8MB，直接进 Humongous Region
- 占用 2 个连续 Region
```

**为什么 G1 的 Humongous Region 容易引发问题**：

1. **Humongous 不在新生代**：
   - 大对象直接进 Humongous Region（不在 Eden）
   - 即使短期死亡，也要等并发标记才回收
   - 占用 Old 代配额

2. **Humongous 分配需要连续 Region**：
   - 找连续 N 个空闲 Region
   - 堆碎片化时分配失败
   - 触发 Full GC

3. **Humongous 回收依赖并发标记**：
   - 必须等并发标记完成
   - 标记期间 Humongous 占用内存
   - 大量 Humongous 导致 Old 代快速膨胀

4. **Humongous 不被 Mixed GC 优先回收**：
   - Mixed GC 选择"回收价值高"的 Region
   - Humongous 通常存活对象占比高（整个对象要么活要么死）
   - 可能不被选中

**避免大对象进入 Humongous Region 的策略**：

1. **流式解析**：
   ```java
   // 用 BsonReader 流式解析，避免一次性构造大对象
   BsonReader reader = doc.getBsonReader();
   while (reader.readBsonType() != BsonType.END_OF_DOCUMENT) {
       // 逐字段处理
   }
   ```

2. **字段投影**：
   ```java
   // 只查询需要的字段
   collection.find(eq("_id", id))
       .projection(Projections.include("patientId", "diagnosis"))
       .first();
   ```

3. **拆分大文档**：
   ```java
   // 把 5MB 大文档拆分为多个小文档
   // diagnosis 子文档单独存储
   // prescription 子文档单独存储
   ```

4. **限制并发**：
   ```java
   // 限制同时读取大文档的请求数
   Semaphore semaphore = new Semaphore(10);
   ```

**G1HeapRegionSize 设置**：

```
G1HeapRegionSize 的选择：
- 太小（如 1MB）：大对象多，Humongous Region 多，问题严重
- 太大（如 32MB）：Region 数量少，G1 选择策略精度差
- 默认：G1 自动选择（1/8MB 到 32MB，基于堆大小）

推荐：
- 堆 < 4GB：4MB 或 8MB
- 堆 4-16GB：8MB 或 16MB（默认）
- 堆 > 16GB：16MB 或 32MB

针对问诊大文档场景：
- 5MB 文档 + 16MB Region = 1 个 Region（5MB < 8MB 阈值，仍是普通对象）
- 5MB 文档 + 8MB Region = 1 个 Region（5MB > 4MB 阈值，是 Humongous）
- 设 16MB Region 让 5MB 文档成为普通对象
```

**MongoDB 大文档服务的 GC 配置**：

```bash
-Xms8g -Xmx8g
-XX:+UseG1GC
-XX:MaxGCPauseMillis=200
-XX:G1HeapRegionSize=16m               # 16MB Region，5MB 文档不算 Humongous
-XX:InitiatingHeapOccupancyPercent=40   # 提前触发并发标记
-XX:G1MixedGCCountTarget=4              # 4 次 Mixed GC 回收候选
-XX:+ParallelRefProcEnabled
```

#### 5. JDK 升级与 GC 迁移

**JDK 8（CMS）升级到 JDK 17（G1）的注意事项**：

**1. CMS 参数在 G1 中的对应**：

| CMS 参数 | G1 对应 | 备注 |
|---------|--------|------|
| -XX:+UseConcMarkSweepGC | -XX:+UseG1GC | 改用 G1 |
| -XX:CMSInitiatingOccupancyFraction=70 | -XX:InitiatingHeapOccupancyPercent=45 | 触发阈值 |
| -XX:+UseCMSInitiatingOccupancyOnly | -XX:-G1UseAdaptiveIHOP | 关闭自适应 |
| -XX:+CMSClassUnloadingEnabled | 默认开启 | G1 默认回收 Metaspace |
| -XX:+CMSParallelRemarkEnabled | 默认开启 | G1 默认并行 Remark |
| -XX:+CMSScavengeBeforeRemark | 不需要 | G1 自行处理 |
| -XX:ConcGCThreads=4 | -XX:ConcGCThreads=4 | 一致 |
| -XX:ParallelCMSThreads=8 | -XX:ParallelGCThreads=16 | 一致 |

**2. CMS 参数在 G1 中无效**：

```
-XX:+UseConcMarkSweepGC            # JDK 14 移除，启动报错
-XX:CMSInitiatingOccupancyFraction # 无效
-XX:+UseCMSInitiatingOccupancyOnly # 无效
-XX:+CMSClassUnloadingEnabled      # 无效（G1 默认开启）
-XX:+CMSParallelRemarkEnabled      # 无效（G1 默认开启）
-XX:+CMSScavengeBeforeRemark       # 无效
-XX:+UseParNewGC                   # 无效（与 CMS 一起移除）
```

**3. 验证 G1 实际表现**：

```bash
# Step 1：JDK 17 + G1，CMS 参数清理
java -XX:+UseG1GC -XX:MaxGCPauseMillis=200 ...

# Step 2：开启 GC 日志
-Xlog:gc*:file=/var/log/gc.log:time,level,tags:filecount=10,filesize=100M

# Step 3：压测对比
# 工具：JMeter / wrk / Gatling
# 指标：
#   - 吞吐量（QPS）
#   - P99 延迟
#   - GC 停顿时间
#   - GC 频率
#   - CPU 占用

# Step 4：分析 GC 日志
# 工具：GCEasy / GCViewer
# 关注：
#   - 吞吐量（> 95% 为健康）
#   - 平均停顿（< 200ms）
#   - 最大停顿（< 500ms）
#   - Mixed GC 频率

# Step 5：与 JDK 8 + CMS 对比
# 同样压测，对比指标
# 如果 G1 不如 CMS，找原因：
#   - MaxGCPauseMillis 是否合适
#   - IHOP 是否合适
#   - Region 大小是否合适
#   - 是否有大对象进 Humongous
```

**JDK 8 -> 11 -> 17 的渐进升级路径**：

```
阶段 1：JDK 8 -> JDK 11
- 最低风险升级
- 主要变化：
  - 默认 GC 仍是 G1（JDK 9 改）
  - 移除 JavaFX、CORBA
  - HTTP Client（标准库）
  - var 局部变量类型推断
- 风险：低
- 收益：长期支持版本（LTS）

阶段 2：JDK 11 -> JDK 17
- 重大升级
- 主要变化：
  - 默认 G1（已经是）
  - Sealed Classes、Records
  - Pattern Matching
  - ZGC 生产可用
- 风险：中
- 收益：最新 LTS，性能改进

阶段 3：JDK 17 -> JDK 21
- 增量升级
- 主要变化：
  - Virtual Threads（虚拟线程）
  - 分代 ZGC（JEP 439）
  - Pattern Matching for switch
- 风险：中
- 收益：虚拟线程对 IM 网关有重大改进
```

**是否值得上 ZGC**：

**值得上的场景**：
- 堆 > 32GB（G1 停顿随堆增长，ZGC 不变）
- 极低延迟要求（&lt; 10ms）
- JDK 21+（分代 ZGC）
- 视频 / 实时游戏服务

**不值得上的场景**：
- 堆 &lt; 8GB（G1 已足够）
- 延迟要求不严格（> 100ms 可接受）
- JDK 17 以下（ZGC 不稳定）
- 业务服务（QPS 不高，G1 足够）

**在线问诊系统的升级建议**：

```
短期（6 个月）：
- IM 网关：JDK 8 -> JDK 17，GC 从 CMS -> G1
- 业务服务：JDK 8 -> JDK 17，GC 从 Parallel -> G1
- SFU：JDK 8 -> JDK 17，GC 从 G1 -> G1（保留）
- 内部管理：JDK 8 -> JDK 17，GC 从 Parallel -> G1

中期（1 年）：
- SFU：JDK 17 -> JDK 21，GC 从 G1 -> ZGC（分代）
- IM 网关：评估是否上 ZGC

长期（2 年）：
- 全面 JDK 21+
- ZGC 在 SFU / IM 网关
- G1 在业务服务
```

---

## 本日能力差距与补足方向

### 差距 1：G1 的 Mixed GC 触发与调优不深
> Day3发现

- **现状**：知道 G1 的四种 GC 类型，但 Mixed GC 的触发条件、Region 选择策略、`G1MixedGCCountTarget` 和 `G1MixedGCLiveThresholdPercent` 的调优不深
- **架构师水平**：能根据 Old 代增长速率精确调优 Mixed GC；能用 `-XX:+PrintAdaptiveSizePolicy` 验证 G1 的 Region 选择；能讲清 Adaptive IHOP 的工作机制
- **补足方向**：阅读 G1 论文《Garbage-First Garbage Collection》；阅读 OpenJDK `g1Policy.cpp` 源码；Day07 深挖 G1 时深入

### 差距 2：ZGC 染色指针与读屏障的工程理解不足
> Day3发现

- **现状**：知道 ZGC 用染色指针 + 读屏障做到 &lt; 10ms 停顿，但染色位布局、多视图映射、读屏障的 JIT 插入逻辑不深
- **架构师水平**：能讲清 ZGC 的染色位 4 位布局、多视图映射的 OS 层支持（mmap）、读屏障在 JIT 中的实现、分代 ZGC（JDK 21）的改进
- **补足方向**：阅读 ZGC 设计文档《The Z Garbage Collector》；阅读 OpenJDK `zBarrier.cpp`、`zPointer.cpp` 源码；第 2 周 Day07 深挖 ZGC

### 差距 3：GC 收集器选型缺乏实战经验
> Day3发现

- **现状**：能讲清 7 种收集器的差异，但缺生产选型实战--如何在压测中对比 G1 / ZGC / Shenandoah，如何根据业务指标选 GC
- **架构师水平**：能根据业务特征（QPS、延迟、堆大小、JDK 版本）快速选 GC；能用 JMH + JFR 做对比压测；能讲清 ZGC / Shenandoah 的真实生产案例
- **补足方向**：第 2 周 Day01 调优参数全解；调研 LinkedIn、Netflix 的 GC 选型实践；用 JMH 实测 G1 vs ZGC 的吞吐与停顿

### 差距 4：JDK 8 升级 JDK 17 的工程经验不足
> Day3发现

- **现状**：知道 JDK 8 -> 17 的主要变化，但缺升级实战--CMS 参数迁移、依赖兼容性、JVM 行为差异
- **架构师水平**：能完整规划 JDK 升级路径（评估 / 试点 / 全量）；能讲清 JVM 内存模型、GC、类加载在 JDK 8 vs 17 的差异；能解决依赖反射、Unsafe、序列化的兼容性问题
- **补足方向**：调研阿里、美团、字节的 JDK 升级实践；阅读 JEP 261（模块系统）、JEP 310（类共享）；尝试在测试环境升级在线问诊系统

### 差距 5：大对象处理与 Humongous Region 调优不熟
> Day3发现

- **现状**：知道 G1 的 Humongous Region 是大对象专用，但什么时候触发、如何避免、`G1HeapRegionSize` 怎么选不深
- **架构师水平**：能根据业务大对象分布精确调优 `G1HeapRegionSize`；能用 JFR 分析大对象分配热点；能讲清 Humongous Region 在 Mixed GC 中的回收策略
- **补足方向**：用 JFR 分析在线问诊系统的大对象分配；调研 MongoDB Driver 的大对象处理；第 2 周 Day05 在线问诊实战时深入

### 差距 6：Shenandoah 与 ZGC 的对比不深
> Day3发现

- **现状**：知道 Shenandoah 用 Brooks 转发指针、ZGC 用染色指针，但两者具体差异、性能对比、选型建议不深
- **架构师水平**：能讲清 Brooks Pointer 与染色指针的内存开销、读屏障开销、并发整理实现差异；能根据业务场景选择 ZGC 还是 Shenandoah
- **补足方向**：阅读 Shenandoah 设计文档《Shenandoah: An Open-Source Concurrent Compacting Garbage Collector》；第 2 周 Day07 深挖 ZGC 与 Shenandoah

### 差距 7：GC 与容器化的协同不熟
> Day3发现，延续第1周差距

- **现状**：知道 JVM 在容器中要感知 cgroup 限制，但 JDK 8 vs 11+ 的容器化支持差异、GC 在容器中的行为调整不深
- **架构师水平**：能讲清 JDK 8u191+ 的容器支持、JDK 10+ 的 `+UseContainerSupport`、K8s limit 与 JVM 参数的协同；能解决容器中 GC 异常（如 OOM Killed）
- **补足方向**：第 2 周 Day01 调优参数全解；调研 Netflix、阿里云的 JVM 容器化实践
