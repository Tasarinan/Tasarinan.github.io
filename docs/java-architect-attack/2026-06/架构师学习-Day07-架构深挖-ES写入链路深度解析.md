# Day 7：架构深挖 —— ES 写入链路深度解析

## 一、今日主题

本周 ES 专题已经完成了从底层原理到中台架构的完整串联：

```text
Day1：核心概念与倒排索引原理
Day2：Mapping 深入与字段类型陷阱
Day3：查询 DSL 与聚合分析
Day4：性能优化与生产集群运维
Day5：业务系统集成与典型场景
Day6：企业级搜索中台架构设计
```

今天不再泛泛讲 ES 整体架构，而是深挖一个架构师必须讲清楚的问题：

```text
一条文档从写入到可见、到落盘、到宕机恢复，完整经历了什么？
```

这道题重点考察的不是"会不会写 ES"，而是你能不能把写入链路中的：

```text
内存态（In-memory Buffer）
磁盘态（OS Cache / Translog）
持久态（fsync 后的 Segment）
可见态（refresh 后可搜索）
一致性边界（主副本之间）
宕机恢复边界（translog 重放）
性能与可靠性的权衡
```

讲清楚。

---

## 二、题目：ES 写入链路深度解析

你负责维护一个保险商城的搜索集群，业务侧反馈：

```text
现象1：保单写入后立即搜索，偶尔搜不到（1 秒内）
现象2：集群写入 QPS 上不去，瓶颈在哪里？
现象3：某次节点宕机后重启，少量已确认写入的保单丢失了
现象4：主分片所在节点宕机，副本切换为主后，部分数据"消失"了
```

现在要求你：

```text
从一条文档的完整写入链路出发，解释清楚上述四个现象的根因，
并给出架构师视角的写入参数调优与可靠性保障方案。
```

---

## 三、需要回答的问题

### 1. 一条文档从写入到可见，完整经历了哪些阶段？

请说明：

```text
写入请求到协调节点后，路由到主分片
主分片内部：写 In-memory Buffer + 写 Translog
refresh：Buffer → Segment（OS Cache），可搜索
flush：Segment fsync 到磁盘 + Translog 清空
merge：多个小 Segment 合并为大 Segment
副本同步：主分片 → 副本分片
```

重点说明：

```text
为什么是 1 秒延迟而不是实时？
refresh、flush、merge 各自解决什么问题？
Translog 在整个链路中扮演什么角色？
```

### 2. 为什么"写入后立即搜索搜不到"？

重点说明：

```text
refresh 之前，文档在 In-memory Buffer，不可搜索
默认 refresh_interval = 1s，意味着最多 1 秒延迟
强制 refresh=true 的代价是什么？
业务侧"写后立即读"应该怎么解？
```

### 3. 写入 QPS 上不去，瓶颈在哪里？

重点说明：

```text
refresh 太频繁 → Segment 太多 → merge 压力大
副本同步是串行还是并行？
Translog 的 fsync 策略对写入吞吐的影响
Bulk 批次大小为什么是 5-15MB？
```

### 4. 宕机后少量数据丢失，根因是什么？

重点说明：

```text
Translog 的 durability 配置（request vs async）
async 模式下 sync_interval 的影响
OS Cache 没 fsync 的数据会丢吗？
为什么 flush 之前的数据依赖 Translog 恢复？
```

### 5. 主副本切换后数据"消失"，根因是什么？

重点说明：

```text
ES 的写入一致性模型（不是强一致）
wait_for_active_shards 的含义
主副本之间的同步是同步还是异步？
主分片宕机时，未同步到副本的数据会怎样？
```

---

## 四、完整写入链路深度解析

### 4.1 一条文档的完整生命周期

```text
客户端：PUT /index/_doc/1 { ... }
   │
   ↓
协调节点（Coordinating Node）
   │  1. 根据 routing 计算 shard_num = hash(_routing) % primary_count
   │  2. 转发请求到主分片所在节点
   │
   ↓
主分片节点（Primary Shard）
   │  3. 写入 In-memory Buffer（堆内存，不可搜索）
   │  4. 同时写入 Translog（磁盘，保证不丢）
   │  5. 返回成功给协调节点（不等待副本）
   │     ── 或等待副本（取决于 wait_for_active_shards）
   │
   ↓ 异步并行
   ├─→ 副本分片：复制 In-memory Buffer + Translog
   │
   ↓ 默认 1 秒
refresh 操作
   │  6. In-memory Buffer 生成新 Segment（写入 OS Cache）
   │  7. Segment 注册到 Lucene，可被搜索
   │  8. In-memory Buffer 清空
   │  → 此时文档可被搜到（NRT 来源）
   │
   ↓ 默认 30 分钟 或 Translog 满 512MB
flush 操作
   │  9. 调用 Lucene commit
   │  10. OS Cache 中的 Segment fsync 到磁盘
   │  11. 清空 Translog
   │  → 此时数据真正持久化
   │
   ↓ 后台异步
merge 操作
   │  12. 多个小 Segment 合并为大 Segment
   │  13. 合并时清理 .del 标记的删除文档
   │  14. 减少段数量，提升查询性能
```

### 4.2 三个关键时间点对照

| 操作 | 默认间隔 | 数据位置 | 是否可搜索 | 是否持久化 | 触发条件 |
|------|---------|---------|-----------|-----------|---------|
| 写入 | 实时 | In-memory Buffer + Translog | ❌ | ❌（仅 Translog） | 客户端请求 |
| refresh | 1 秒 | OS Cache 中的 Segment | ✅ | ❌（OS Cache 可能丢） | 定时 / 手动 |
| flush | 30 分钟 / Translog 512MB | 磁盘上的 Segment | ✅ | ✅ | 定时 / Translog 满 |
| merge | 后台 | 磁盘上的大 Segment | ✅ | ✅ | 段数量达阈值 |

### 4.3 关键认知：三层数据状态

```text
┌─────────────────────────────────────────────────┐
│ 第一层：In-memory Buffer（堆内存）              │
│   - 写入后立即存在                              │
│   - 不可搜索                                    │
│   - 进程崩溃即丢失                              │
│   - 由 Translog 保护                            │
└─────────────────────────────────────────────────┘
                    ↓ refresh（默认 1s）
┌─────────────────────────────────────────────────┐
│ 第二层：OS Cache 中的 Segment（系统页缓存）     │
│   - 可搜索（NRT 来源）                          │
│   - 进程崩溃不丢（OS 还在）                     │
│   - 机器断电会丢（OS Cache 没持久化）           │
│   - 由 Translog 保护                            │
└─────────────────────────────────────────────────┘
                    ↓ flush（默认 30 分钟）
┌─────────────────────────────────────────────────┐
│ 第三层：磁盘上的 Segment（持久化）              │
│   - 可搜索                                      │
│   - 持久化（fsync 完成）                        │
│   - 机器断电不丢                                │
│   - Translog 可清空                            │
└─────────────────────────────────────────────────┘
```

架构师必须能讲清楚：**任何时刻断电，数据是否会丢？丢多少？怎么恢复？**

---

## 五、Translog 深度解析

### 5.1 Translog 是什么

Translog（Transaction Log）是 ES 的预写日志（WAL，Write-Ahead Log），类似 MySQL 的 Redo Log / Binlog。

```text
写入流程：
  1. 文档先写 Translog（磁盘）
  2. 再写 In-memory Buffer（堆内存）

为什么这样设计？
  - In-memory Buffer 进程崩溃即丢
  - Translog 在磁盘，崩溃后可重放
  - 重启时从 Translog 恢复未 flush 的数据
```

### 5.2 Translog 的两种 fsync 策略

```text
index.translog.durability:
  request（默认）：
    - 每次写入请求都 fsync Translog
    - 任何崩溃都不丢数据
    - 性能差（每次写入都有磁盘 IO）

  async：
    - 异步 fsync，间隔由 sync_interval 控制（默认 5s）
    - 崩溃最多丢失 sync_interval 时间内的数据
    - 性能好（批量 fsync）
```

### 5.3 选型决策

```text
场景1：订单、保单、支付（数据不能丢）
  → durability: request
  → 接受性能损失换可靠性

场景2：日志、监控指标（可丢少量）
  → durability: async
  → sync_interval: 5s（最多丢 5s 数据）
  → 性能提升 2-5 倍

场景3：批量导入（一次性大量写入）
  → durability: async
  → sync_interval: 30s
  → refresh_interval: -1（禁用 refresh）
  → 导入完成后恢复
```

### 5.4 Translog 与 flush 的关系

```text
Translog 的生命周期：
  1. 写入时追加到 Translog
  2. Translog 持续增长
  3. 达到 flush_threshold_size（默认 512MB）触发 flush
  4. flush 后：
     - Segment fsync 到磁盘
     - Translog 清空（新建一个）
  5. 旧的 Translog 文件可以删除

为什么 Translog 满了要 flush？
  - Translog 太大，宕机恢复时重放耗时
  - flush 后数据已持久化，Translog 没用了
  - 控制 Translog 大小 = 控制恢复时间
```

### 5.5 宕机恢复流程

```text
节点重启后：
  1. 读取磁盘上最近的 Segment（已 flush 的数据）
  2. 读取 Translog（未 flush 的数据）
  3. 重放 Translog 中的操作到 In-memory Buffer
  4. 触发 refresh，使数据可搜索

恢复的数据范围：
  - 已 flush 的数据：完整恢复
  - 未 flush 但已写 Translog 的数据：
    - durability=request：完整恢复
    - durability=async：恢复到最近一次 fsync（最多丢 sync_interval）

未写 Translog 的数据：
  - 永远丢失（不可能恢复）
```

---

## 六、Refresh 深度解析

### 6.1 Refresh 做了什么

```text
refresh 操作：
  1. In-memory Buffer 中的文档生成新 Segment
  2. Segment 写入 OS Cache（不 fsync）
  3. Segment 注册到 Lucene 的 SearcherManager
  4. 新建一个 IndexSearcher 引用新 Segment
  5. 旧 Searcher 关闭
  6. In-memory Buffer 清空

关键：refresh 不写磁盘，只写 OS Cache
```

### 6.2 为什么默认 1 秒

```text
ES 的设计哲学：用极小的查询延迟换极高的写入吞吐

如果实时可见：
  - 每次写入都 refresh → 每次都生成 Segment
  - Segment 数量爆炸 → merge 跟不上
  - 查询要扫所有 Segment → 查询变慢
  - 整体崩溃

1 秒延迟：
  - 1 秒积累一批写入，一次 refresh
  - Segment 数量可控
  - 写入吞吐高 10-100 倍
  - 查询延迟稳定
```

### 6.3 Refresh 的代价

```text
每次 refresh：
  1. 生成新 Segment（占文件句柄）
  2. Segment 元数据进内存（占堆）
  3. 触发可能的 merge（占 CPU 和 IO）
  4. Searcher 切换（短暂的查询暂停）

refresh 越频繁：
  - Segment 越多 → 查询越慢
  - merge 越频繁 → CPU 越高
  - 文件句柄越多 → 资源占用大
```

### 6.4 refresh_interval 调优

```text
场景1：搜索类业务（用户搜索）
  → refresh_interval: 1s（默认）
  → 1 秒延迟可接受

场景2：日志类业务（不需要实时）
  → refresh_interval: 30s
  → 减少 Segment 数量，提升写入吞吐

场景3：批量导入
  → refresh_interval: -1（禁用）
  → 导入完成后手动 POST /index/_refresh

场景4：强一致"写后立即读"
  → 不建议用 refresh=true（性能差）
  → 改用业务侧方案（见 6.5）
```

### 6.5 "写后立即读"的正确解法

```text
错误做法：写入时带 ?refresh=true
  - 每次写入都强制 refresh
  - 写入吞吐崩溃
  - 生产环境禁止

正确做法1：双写查询（推荐）
  - 写入 ES 后，同时查 MySQL
  - 如果 ES 搜不到，回退查 MySQL
  - 适合"写后立即查"的少数场景

正确做法2：异步等待
  - 写入后客户端等 1-2 秒再查
  - 适合用户提交后跳转列表页的场景
  - 用户感知不到延迟

正确做法3：业务侧缓存
  - 写入后把文档缓存到 Redis（TTL 5 秒）
  - 查询时先查 Redis，再查 ES
  - 适合"写后立即搜"的场景

架构师视角：
  - 不要为 1% 的"写后立即读"需求牺牲 99% 的写入吞吐
  - 用业务方案解决，不要用 refresh=true
```

---

## 七、Flush 深度解析

### 7.1 Flush 做了什么

```text
flush 操作（Lucene commit）：
  1. 触发一次 refresh（确保 Buffer 数据进 Segment）
  2. 调用 Lucene 的 commit：
     - OS Cache 中的 Segment fsync 到磁盘
     - 写入新的 segments.gen 文件（指向最新 Segment）
     - 写入新的 write.lock
  3. 清空 Translog（数据已持久化）
  4. 删除旧的 Translog 文件

关键：flush 是真正的持久化
```

### 7.2 Flush 的触发条件

```text
触发条件1：Translog 满（默认 512MB）
  index.translog.flush_threshold_size: 512mb

触发条件2：定时（默认 30 分钟）
  没有显式配置，由内部调度

触发条件3：手动
  POST /index/_flush
  POST /_flush?wait_for_ongoing=true

触发条件4：索引关闭
  关闭索引前会 flush

触发条件5：节点优雅关闭
  节点 stop 前会 flush 所有索引
```

### 7.3 为什么不每秒 flush

```text
如果每秒 flush：
  - 每秒 fsync 一次 → 磁盘 IO 瓶颈
  - 每秒生成持久化 Segment → Segment 数量爆炸
  - 写入吞吐崩溃

ES 的设计：
  - refresh（1s）：写 OS Cache，可搜索，不持久化
  - flush（30min）：fsync 到磁盘，持久化
  - 中间靠 Translog 兜底

权衡：
  - flush 间隔短 → 数据更安全，但性能差
  - flush 间隔长 → 性能好，但宕机恢复慢（Translog 重放耗时长）
```

### 7.4 Flush 与 Segment 数量

```text
每次 flush 生成一个新的"提交点"（commit point）
两个 commit point 之间的 Segment 会被 merge 合并

如果 flush 太频繁：
  - commit point 多
  - Segment 文件多
  - merge 压力大

如果 flush 太少：
  - Translog 巨大
  - 宕机恢复慢
  - 但 Segment 数量少，merge 压力小

默认 512MB 是经验值，平衡了恢复时间和 Segment 数量
```

---

## 八、Merge 深度解析

### 8.1 为什么需要 Merge

```text
refresh 每秒生成一个 Segment
一天 = 86400 个 Segment（如果不 merge）

Segment 太多的代价：
  - 查询要扫所有 Segment → 查询变慢
  - 每个 Segment 占文件句柄 → 资源占用
  - 每个 Segment 元数据进堆 → 堆内存压力
  - 删除文档的 .del 标记不会被清理 → 空间浪费

Merge 的作用：
  - 把多个小 Segment 合并为大 Segment
  - 合并时清理 .del 标记的删除文档
  - 减少段数量，提升查询性能
  - 释放磁盘空间
```

### 8.2 Merge 策略

```text
Tiered Merge Policy（默认）：
  - 分层合并
  - 同层 Segment 大小相近
  - 达到阈值后合并为下一层

合并触发：
  - Segment 数量达阈值
  - Segment 大小达阈值
  - 删除文档比例达阈值

合并过程：
  1. 选择待合并的 Segment
  2. 在后台读取多个 Segment
  3. 合并为新 Segment（写 OS Cache）
  4. fsync 新 Segment
  5. 旧 Segment 标记删除
  6. 旧 Segment 文件延迟删除（无人引用时）
```

### 8.3 Force Merge 的使用与陷阱

```text
POST /index/_forcemerge?max_num_segments=1

作用：把所有 Segment 合并为 1 个
  - 适合：只读索引（如已结束的日志索引）
  - 提升查询性能
  - 释放磁盘空间（清理 .del）

陷阱：
  1. force merge 是同步操作，会阻塞写入
  2. 合并过程占大量 CPU 和 IO
  3. 正在写入的索引禁止 force merge
     → 会持续产生新 Segment，merge 永无止境
     → 浪费资源
  4. force merge 到 1 个 Segment 后：
     → 后续再有写入，又要重新 merge
     → 资源浪费

正确用法：
  - 日志索引转入 Warm 阶段后 force merge 到 1
  - 此时索引只读，不再写入
  - 一次性合并，永久受益
```

### 8.4 Merge 调优

```text
index.merge.scheduler.max_thread_count:
  - 控制 merge 并发线程数
  - 默认：max(1, min(4, cpu_cores / 2))
  - SSD 可以适当调大
  - 机械硬盘建议 1（避免 IO 抖动）

index.merge.policy:
  - max_merge_at_once: 一次最多合并几个 Segment（默认 10）
  - max_merged_segment: 单个 Segment 最大大小（默认 5GB）
  - segments_per_tier: 每层 Segment 数量（默认 10）

监控：
  - GET /_cat/segments/index?v → 看 Segment 数量
  - GET /_nodes/stats/indices/merges → 看 merge 进度
  - Segment 数量持续 > 50 → 有问题
```

---

## 九、主副本一致性深度解析

### 9.1 写入流程中的副本同步

```text
主分片写入流程：
  1. 主分片写 In-memory Buffer + Translog
  2. 主分片将数据并行发送到所有副本
  3. 副本写入各自的 In-memory Buffer + Translog
  4. 副本返回 ACK 给主分片
  5. 主分片返回 ACK 给协调节点

关键问题：主分片什么时候返回成功给客户端？
  - 取决于 wait_for_active_shards 配置
```

### 9.2 wait_for_active_shards 详解

```text
wait_for_active_shards:
  1（默认）：主分片自己写入成功就返回
  all：所有副本都写入成功才返回
  数字 N：至少 N 个分片（含主）写入成功才返回

  例：1 主 + 2 副本
    wait_for_active_shards=1 → 主写成功就返回（默认）
    wait_for_active_shards=2 → 主 + 至少 1 副本
    wait_for_active_shards=3 → 主 + 2 副本（=all）

权衡：
  值越小 → 写入延迟低，但宕机可能丢数据
  值越大 → 写入延迟高，但数据更安全
```

### 9.3 ES 不是强一致

```text
ES 的写入一致性：
  - 主分片写入后立即返回（默认 wait_for_active_shards=1）
  - 副本异步同步
  - 副本可能落后于主分片

主分片宕机场景：
  1. 主分片写入数据 D，返回成功给客户端
  2. 副本还没收到 D
  3. 主分片宕机
  4. 副本被提升为新主
  5. D 丢失！

这就是"主副本切换后数据消失"的根因

如何避免？
  - wait_for_active_shards=all（牺牲性能换可靠性）
  - 但即使 all，也只是"写入时同步"，无法保证"切换时一致"
  - 极端场景（主分片写完，副本还没同步，主宕机）仍可能丢
```

### 9.4 副本同步的并发模型

```text
主副本之间的同步：
  - 不是基于 binlog 的位点同步（不像 MySQL）
  - 是基于"操作"的同步
  - 主分片把每个写入操作发送给副本

每个操作带版本号（_version）：
  - 主分片写入时 _version + 1
  - 副本按 _version 顺序应用
  - 乐观并发控制（OCC）

副本落后场景：
  - 副本网络抖动 → 暂时落后
  - 主分片继续接收写入
  - 副本恢复后追赶（catch-up）
  - 追赶期间，副本可读但数据可能旧
```

### 9.5 读一致性

```text
ES 默认读偏好：balance（轮询主和副本）
  - 读请求可能落到任意副本
  - 副本可能落后于主
  - 用户可能读到旧数据

读偏好（preference）选项：
  _primary：只读主分片（强一致，但压力大）
  _primary_first：优先读主
  _replica：只读副本
  _local：优先本地节点
  _only_local：只读本地

业务侧"写后立即读"：
  - 写入后用 preference=_primary 读
  - 但主分片也可能在 refresh 之前（不可见）
  - 所以"写后立即读"在 ES 里是双重难题：
    1. refresh 延迟（不可见）
    2. 副本延迟（读不到最新）
```

---

## 十、版本控制与乐观锁

### 10.1 _version 字段

```text
每个文档有一个 _version 字段：
  - 初始写入：_version = 1
  - 每次更新：_version + 1
  - 删除后重建：_version 继续递增（不重置）

_version 的作用：
  - 乐观并发控制
  - 防止"丢失更新"
  - 副本同步的顺序保证
```

### 10.2 乐观锁更新

```text
场景：用户 A 和 B 同时编辑同一文档

不加版本控制：
  T1: A 读到 _version=1
  T2: B 读到 _version=1
  T3: A 写入（基于读到的内容修改）
  T4: B 写入（覆盖 A 的修改）→ A 的修改丢失

加版本控制（if_seq_no + if_primary_term，ES 6.7+）：
  T1: A 读到 _seq_no=10, _primary_term=5
  T2: B 读到 _seq_no=10, _primary_term=5
  T3: A 写入，带 if_seq_no=10
       → 写入成功，_seq_no 变为 11
  T4: B 写入，带 if_seq_no=10
       → 版本冲突，写入失败（409）
  T5: B 重新读取，基于最新版本修改
```

### 10.3 _seq_no 和 _primary_term

```text
ES 6.7+ 用 _seq_no + _primary_term 替代旧的 _version：
  _seq_no：单调递增的序列号（每个分片独立）
  _primary_term：主分片任期（主切换时 +1）

两者组合 = 全局唯一版本号

为什么不用 _version？
  - _version 是文档级
  - _seq_no 是分片级（更轻量）
  - 副本同步时按 _seq_no 顺序应用，保证一致性
```

### 10.4 外部版本控制

```text
场景：从 MySQL 同步数据到 ES
  MySQL 是数据源，有自己的 version（如 update_time）
  希望按 MySQL 的 version 判断新旧

ES 支持 external 版本控制：
  PUT /index/_doc/1?version=5&version_type=external
  → ES 只接受 version > 当前 _version 的写入
  → 防止旧数据覆盖新数据（消息乱序场景）

但 ES 6.0+ 已废弃 version_type=external
  推荐用 if_seq_no + if_primary_term
  或在文档里存一个 mysql_update_time 字段，业务侧判断
```

---

## 十一、写入性能调优完整方案

### 11.1 客户端层

```text
1. Bulk API 批量写入
   - 批次大小 5-15MB（不要按条数）
   - 并发多个 Bulk 请求（不要串行）
   - 单个 Bulk 不超过 100MB

2. 路由优化
   - 同一租户/用户的数据用相同 routing
   - 写入和查询都用 routing
   - 减少分片 fan-out

3. 失败重试
   - Bulk 部分失败时，只重试失败的部分
   - 重试要带版本号（防止重复写入）
```

### 11.2 索引层

```text
1. refresh_interval
   - 搜索类：1s（默认）
   - 日志类：30s
   - 批量导入：-1（禁用）

2. 副本数
   - 批量导入时设为 0，完成后恢复
   - 实时写入保持 1-2

3. Translog
   - 数据可丢：durability=async, sync_interval=5s
   - 数据不能丢：durability=request（默认）

4. 索引缓冲区
   - indices.memory.index_buffer_size: 10%（默认）
   - 大节点可调到 20-30%
   - 不超过 512MB per shard
```

### 11.3 集群层

```text
1. 节点角色分离
   - Master / Data / Coordinating 独立部署
   - 写入压力集中到 Data 节点

2. 磁盘
   - 强烈建议 SSD（写入性能 5-10 倍）
   - 机械硬盘只用于 Warm/Cold 节点

3. 线程池
   - index 线程池（写入）：默认 size=cpu_cores，queue=10000
   - 队列满了会拒绝写入（429）
   - 监控 rejected 指标，及时扩容

4. 网络
   - 万兆网络（写入密集场景）
   - 减少 RTT
```

### 11.4 写入性能瓶颈定位 SOP

```text
现象：写入 QPS 上不去

排查步骤：
  1. 看节点资源
     GET /_nodes/stats
     → CPU > 80%？内存？磁盘 IO？
     → 哪个是瓶颈？

  2. 看线程池
     GET /_cat/thread_pool?v
     → write 线程池 rejected > 0？
     → 队列满了，需要扩容或降低并发

  3. 看 Segment
     GET /_cat/segments/index?v
     → Segment 数量 > 50？
     → refresh 太频繁，调大 refresh_interval

  4. 看 merge
     GET /_nodes/stats/indices/merges
     → merge 频繁？
     → 调大 refresh_interval 或 max_merge_at_once

  5. 看 GC
     GET /_nodes/stats/jvm
     → Old GC 频繁？
     → 堆内存不够，扩容

  6. 看副本同步
     GET /_cat/recovery?v
     → 副本同步慢？
     → 网络瓶颈或副本数太多

  7. 看 Bulk 大小
     → 单个 Bulk 太大？
     → 调小批次（5-10MB）

  8. 看 Translog
     → durability=request 且写入密集？
     → 改 async 提升性能
```

---

## 十二、可靠性保障完整方案

### 12.1 数据不丢的三层保障

```text
第一层：Translog（进程崩溃保护）
  - durability=request：每次写入都 fsync
  - durability=async：定期 fsync（最多丢 sync_interval）

第二层：副本（节点崩溃保护）
  - 1 副本：允许 1 个节点宕机
  - 2 副本：允许 2 个节点宕机
  - wait_for_active_shards=all：写入时所有副本同步

第三层：Snapshot（集群崩溃保护）
  - 定期 snapshot 到对象存储（S3/HDFS）
  - 跨机房 / 跨集群备份
  - 灾难恢复的最后防线
```

### 12.2 主副本切换的数据安全

```text
风险：主分片写入后未同步到副本，主宕机

缓解措施：
  1. wait_for_active_shards=all
     → 写入时所有副本同步
     → 但牺牲写入性能

  2. 副本数 >= 2
     → 单副本宕机不至于丢数据
     → 但仍有"主+1副本同步完，另1副本没同步"的窗口

  3. 跨机房部署
     → 主副本分布在不同机房
     → 单机房故障不至于全丢

  4. 异步双写 + 对账
     → 关键数据双写 ES + 另一个存储
     → 定期对账补偿
     → 适合订单、支付等关键业务
```

### 12.3 宕机恢复流程

```text
单节点宕机：
  1. 集群检测节点离线（默认 10s）
  2. 该节点上的主分片丢失
  3. 对应副本被提升为新主
  4. 其他副本重新分配（如果有的话）
  5. 集群恢复 green

节点重启后：
  1. 节点加入集群
  2. 本地 Segment 加载
  3. Translog 重放（恢复未 flush 数据）
  4. 与新主分片对比，同步缺失数据
  5. 成为副本（或恢复主身份）

集群级灾难（整个集群挂）：
  1. 从最近 Snapshot 恢复
  2. 重放 Translog（如果还有）
  3. 数据恢复到 Snapshot 时间点 + 部分 Translog
```

---

## 十三、架构师视角：写入链路的核心权衡

### 13.1 三对矛盾

```text
矛盾1：写入吞吐 vs 数据可靠性
  - durability=request → 可靠但慢
  - durability=async → 快但可能丢
  - 架构师决策：按业务分级

矛盾2：查询延迟 vs 写入吞吐
  - refresh 1s → 查询快但 Segment 多
  - refresh 30s → Segment 少但查询延迟
  - 架构师决策：按业务类型分级

矛盾3：写入延迟 vs 主副本一致
  - wait_for_active_shards=1 → 快但切换可能丢
  - wait_for_active_shards=all → 慢但安全
  - 架构师决策：按数据重要性分级
```

### 13.2 分级配置策略

| 业务类型 | refresh_interval | durability | replicas | wait_for_active_shards | 理由 |
|---------|-----------------|------------|----------|------------------------|------|
| 订单/支付/保单 | 1s | request | 2 | 2 | 数据不能丢，强可靠 |
| 商品/用户（搜索类） | 1s | request | 2 | 1 | 1s 延迟可接受，副本兜底 |
| 日志（实时） | 5s | async(5s) | 1 | 1 | 可丢少量，吞吐优先 |
| 日志（批量） | 30s | async(30s) | 1 | 1 | 可丢，吞吐最大化 |
| 监控指标 | 30s | async(10s) | 1 | 1 | 可丢，量大 |
| 归档数据 | -1（写入时禁用） | async | 0 | 1 | 写完即只读 |

### 13.3 写入链路的常见失败认知

| 错误认知 | 正确理解 |
|----------|----------|
| 写入 ES 返回成功就持久化了 | 默认仅主分片写 Translog，副本可能还没同步 |
| refresh 让数据可见，也持久化了 | refresh 只写 OS Cache，断电会丢，靠 Translog 保护 |
| durability=request 就绝对不丢 | 主分片不丢，但主宕机且副本没同步仍可能丢 |
| 副本数=2 就绝对安全 | 主+1副本同步完，另1副本没同步时主宕机仍丢 |
| 写入慢就是 ES 性能差 | 可能是 refresh 太频繁/副本数多/durability=request/Bulk 太小 |
| force merge 提升查询性能 | 只读索引才适合，写入中索引 force merge 浪费资源 |
| wait_for_active_shards=all 保证强一致 | 写入时一致，但切换时仍有窗口，不是真正的强一致 |
| ES 和 MySQL 一样有 binlog 同步 | ES 是操作同步，不是位点同步，副本落后机制不同 |

### 13.4 架构师的写入链路设计原则

```text
原则1：按业务分级配置
  - 不要所有索引用一套参数
  - 订单、日志、归档分别配置

原则2：可靠性优先于性能
  - 关键业务用 durability=request + 2 副本
  - 性能问题靠扩容解决，不靠降可靠性

原则3：用业务方案解"写后立即读"
  - 不要用 refresh=true
  - 用 Redis 缓存或 MySQL 回退

原则4：监控写入链路全链路
  - 写入 QPS、延迟、失败率
  - Segment 数量、merge 速度
  - 副本同步延迟
  - 线程池 rejected

原则5：定期演练宕机恢复
  - 模拟主分片宕机
  - 模拟节点宕机
  - 模拟集群灾难
  - 验证恢复时间和数据完整性
```

---

## 十四、能力差距自检

```text
[ ] 能否画出一条文档从写入到落盘的完整链路图
[ ] 能否说清楚 In-memory Buffer / OS Cache / 磁盘 Segment 三层数据状态
[ ] 能否说清楚 refresh / flush / merge 各自做什么、何时触发
[ ] 能否说清楚 Translog 的 durability 两种模式及选型依据
[ ] 能否说清楚"写后立即读搜不到"的根因和正确解法
[ ] 能否说清楚"主副本切换数据消失"的根因和缓解措施
[ ] 能否说清楚 wait_for_active_shards 各取值的含义和权衡
[ ] 能否说清楚 _seq_no + _primary_term 的作用
[ ] 能否说清楚为什么 ES 不是强一致，哪些场景可能丢数据
[ ] 能否说清楚 force merge 的正确使用场景和陷阱
[ ] 能否给出写入性能瓶颈定位的 SOP
[ ] 能否按业务类型设计分级配置策略
```

---

## 十五、与本周内容的呼应

```text
Day1（倒排索引）：
  - 写入链路最终落到 Segment（倒排索引的物理载体）
  - Segment 不可变 → 字段类型不能改 → 必须 reindex（Day2）

Day2（Mapping）：
  - Mapping 决定文档如何被分词、如何进倒排索引
  - 字段类型选错 → 写入性能差 / 查询结果不对

Day3（DSL）：
  - refresh 后的文档才能被 match/term 查到
  - filter 缓存依赖 Segment 不可变

Day4（性能优化）：
  - 写入优化的所有参数都来自本日的链路分析
  - refresh_interval / 副本数 / Bulk / Translog

Day5（业务集成）：
  - Canal 同步的实时性受 refresh_interval 影响
  - 双写场景的可靠性依赖本日的可靠性保障

Day6（搜索中台）：
  - 中台按业务类型分级配置（refresh/durability/副本）
  - 统一数据管道的 Bulk 大小调优
```

本周从底层原理（倒排索引）出发，经过数据建模、查询、优化、集成、中台，最后回到写入链路深度解析——形成 ES 知识的完整闭环。

---

*日期：2026-06-21 | 2026年06月第3周 Day7 | 架构深挖日 — ES 写入链路深度解析*