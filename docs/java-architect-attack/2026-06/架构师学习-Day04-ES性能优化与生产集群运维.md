# Day04：ES性能优化与生产集群运维（练习整理）
> 2026-06-19 周五｜ES专题第4天

本日目标：掌握ES生产环境的性能优化、集群运维、故障排查等实战技能。

---

## 题目一：索引性能优化 — 写入速度提升10倍的秘诀

### 场景

你负责的保险商城日志系统，每天需要写入5亿条日志，当前写入速度只有5000条/秒，高峰期经常队列积压。

请回答：
1. 写入性能优化有哪些关键参数？
2. Bulk API如何使用？批次大小多少合适？
3. 副本数在写入时应该如何设置？
4. Refresh间隔如何调整？
5. Translog如何配置？

---

## 答案

### 1. 写入性能优化关键参数

```latex
核心优化方向：
  1. 减少磁盘IO（批量写入、关闭不必要的功能）
  2. 减少分词和索引计算
  3. 利用内存缓存，减少刷盘

关键参数：
  index.refresh_interval：刷新间隔，默认1s
  index.number_of_replicas：副本数
  index.translog.*：translog配置
  indices.memory.index_buffer_size：索引缓冲区大小
```

### 2. Bulk API使用

```json
// Bulk API格式：action + metadata + 可选source
POST /_bulk
{ "index": { "_index": "logs", "_id": "1" } }
{ "message": "log message 1" }
{ "index": { "_index": "logs", "_id": "2" } }
{ "message": "log message 2" }
```

```latex
批次大小建议：
  1. 不要按条数，按大小：5-15MB一个批次
  2. 从5-10MB开始测试，逐步增加
  3. 单个批次不要超过100MB
  4. 整个bulk请求不要超过HTTP连接超时（默认30s）

为什么这样？
  → 批次太小：网络往返次数多，效率低
  → 批次太大：内存压力大，可能OOM
  → 5-15MB是经验值，根据文档大小调整
```

### 3. 副本数设置策略

```latex
写入时副本数设置：
  方案1：先设为0，写入完成后再恢复
    → 适用场景：批量导入数据
    → 优点：写入速度最快
    → 缺点：期间无副本，有数据丢失风险

  方案2：保持1-2个副本
    → 适用场景：实时写入
    → 优点：数据安全
    → 缺点：写入速度稍慢（每个副本都要写）

  方案3：异步复制（ES7+）
    → 设为副本数，但是用index.number_of_replicas，同时配置index.requests.cache.enable=false
```

```json
// 临时把副本设为0
PUT /logs/_settings
{
  "index.number_of_replicas": 0
}

// 写入完成后恢复副本
PUT /logs/_settings
{
  "index.number_of_replicas": 1
}
```

### 4. Refresh间隔调整

```latex
refresh_interval作用：
  → 控制文档写入后多久对搜索可见
  → 默认1s，意味着每秒生成一个segment
  → segment太多会有频繁合并，消耗资源

调整策略：
  场景1：日志类，不需要近实时搜索
    → 设为30s或60s
    → 大幅减少segment生成

  场景2：批量导入
    → 设为-1（禁用自动刷新）
    → 导入完成后手动refresh

  场景3：需要近实时搜索
    → 保持1s或2s
```

```json
PUT /logs/_settings
{
  "index.refresh_interval": "30s"
}

// 批量导入时禁用
PUT /logs/_settings
{
  "index.refresh_interval": "-1"
}

// 导入完成后手动刷新
POST /logs/_refresh

// 恢复原来的设置
PUT /logs/_settings
{
  "index.refresh_interval": "1s"
}
```

### 5. Translog配置优化

```latex
Translog作用：
  → 保证写入数据不丢（类似MySQL的binlog）
  → 写入时先写translog，再写内存buffer
  → ES宕机后从translog恢复数据

Translog配置：
  index.translog.durability：
    - request：每次请求都fsync（默认，最安全）
    - async：异步fsync，性能更好
  index.translog.sync_interval：async模式下刷盘间隔
  index.translog.flush_threshold_size：translog多大时触发flush

优化建议：
  场景1：追求性能，允许少量数据丢失（日志）
    → durability: async
    → sync_interval: 5s
  场景2：追求数据安全（订单）
    → durability: request（默认）
```

```json
PUT /logs/_settings
{
  "index.translog.durability": "async",
  "index.translog.sync_interval": "5s",
  "index.translog.flush_threshold_size": "512mb"
}
```

### 6. 其他优化技巧

```latex
1. 关闭不需要的功能：
   → index.indexing.slowlog.threshold.index.warn: -1（关闭慢日志）
   → index.search.slowlog.threshold.query.warn: -1
   → index.number_of_shards：合理设置分片数，不是越多越好

2. 索引缓冲区：
   → indices.memory.index_buffer_size：10%（默认）
   → 大节点可以调大，但不要超过512MB per shard

3. 使用SSD：
   → 机械硬盘 vs SSD：写入性能差5-10倍
   → 生产环境强烈建议用SSD
```

### 与架构师水平的差距

| 层次 | 回答 |
|------|------|
| 开发 | 知道用Bulk API批量写入 |
| 高级开发 | 会调整refresh_interval和副本数 |
| 架构师 | 能根据业务场景（日志 vs 订单）选择合适的配置，理解translog、segment、refresh的关系，能做端到端的写入性能调优 |

**补足方向**：优化写入性能时，先想清楚"数据能不能丢"、"多久需要搜索到"，再选择对应的参数组合。

---

## 题目二：查询性能优化 — 如何让慢查询变快

### 场景

你的保险产品搜索接口，高峰期响应时间从100ms涨到2s，用户投诉不断。

请回答：
1. 如何定位慢查询？
2. 查询性能优化有哪些常用手段？
3. 如何利用filter缓存？
4. Fielddata vs Doc Values是什么？
5. 索引设计层面有哪些优化？

---

## 答案

### 1. 定位慢查询

```json
// 开启慢查询日志
PUT /_cluster/settings
{
  "transient": {
    "search.slowlog.threshold.query.warn": "1s",
    "search.slowlog.threshold.query.info": "500ms",
    "search.slowlog.threshold.fetch.warn": "500ms"
  }
}

// Profile API分析查询
GET /insurance_product/_search
{
  "profile": true,
  "query": {
    "match": { "product_name": "重疾险" }
  }
}
```

```latex
profile输出看什么？
  → 各阶段耗时：rewrite_time、build_scorer_time、next_doc_time
  → 哪个查询子句耗时最长
  → 打分是否占用大量时间
```

### 2. 查询性能优化常用手段

```latex
优化方向1：减少需要扫描的文档
  → 用filter代替must（缓存）
  → 先过滤再查询，把范围小的条件放前面
  → 用keyword代替text做精确匹配

优化方向2：减少返回的数据量
  → 用source filtering只返回需要的字段
  → 分页不要太深（用search_after）
  → 聚合时size设为0

优化方向3：减少打分
  → 不需要排序时用filter
  → 用constant_score包装查询
  → 用sort代替_score排序
```

```json
// source filtering只返回需要的字段
GET /insurance_product/_search
{
  "_source": ["product_name", "price"],
  "query": { "match_all": {} }
}

// constant_score，不打分
GET /insurance_product/_search
{
  "query": {
    "constant_score": {
      "filter": { "term": { "category": "健康险" } }
    }
  }
}
```

### 3. Filter缓存利用

```latex
Filter缓存原理：
  → filter查询的结果会被缓存到bitset
  → 相同filter再次查询直接从缓存取
  → 不参与打分，不改变结果顺序

哪些filter会被缓存？
  → term、terms、range、bool的filter子句
  → 经常重复使用的filter条件

如何让filter更高效？
  → 把最常过滤、过滤掉最多文档的条件放前面
  → 相同条件复用（不要写多个变体）
  → 避免在filter里用script
```

### 4. Fielddata vs Doc Values

```latex
Fielddata：
  → 存在堆内存（heap）
  → text字段聚合/排序时动态构建
  → 占用大量内存，可能OOM
  → 不建议用text字段做聚合

Doc Values：
  → 存在磁盘（列式存储）
  → keyword/numeric/date字段默认启用
  → 不在堆内存，不占用heap
  → 比fielddata稍慢，但稳定

建议：
  → 需要聚合/排序的字段用keyword
  → 避免用text字段聚合
  → 禁用不需要的doc_values
```

```json
// 禁用不需要的doc_values
PUT /insurance_product
{
  "mappings": {
    "properties": {
      "description": {
        "type": "text",
        "doc_values": false  // text不需要聚合，禁用
      },
      "category": {
        "type": "keyword",
        "doc_values": true   // 需要聚合，启用（默认）
      }
    }
  }
}
```

### 5. 索引设计层面优化

```latex
1. 合理设置分片数：
   → 每个分片大小：20-40GB（建议）
   → 分片数 = 预计数据量 / 30GB
   → 不要设置太多分片（每个分片有开销）
   → 可以用split API后续增加分片

2. 索引生命周期管理（ILM）：
   → 日志类按天/周滚动索引
   → 热数据用SSD，冷数据迁移到机械硬盘
   → 定期删除过期索引

3. 路由（Routing）：
   → 相关数据放到同一个分片
   → 查询时只查一个分片，不用fan-out
   → 适合租户隔离场景
```

```json
// 用routing把同一租户的数据放到同一分片
PUT /insurance_product/_doc/1?routing=tenant_123
{
  "tenant_id": "tenant_123",
  "product_name": "重疾险"
}

// 查询时指定routing，只查一个分片
GET /insurance_product/_search?routing=tenant_123
{
  "query": {
    "term": { "tenant_id": "tenant_123" }
  }
}
```

### 与架构师水平的差距

| 层次 | 回答 |
|------|------|
| 开发 | 会写查询，不知道优化 |
| 高级开发 | 会用filter，知道source filtering |
| 架构师 | 能通过profile定位慢查询瓶颈，能从索引设计、查询DSL、缓存利用等多维度优化，理解fielddata/doc_values的区别，能根据数据量规划分片 |

**补足方向**：查询慢时先profile，看是"打分慢"还是"扫描文档多"还是"聚合慢"，再针对性优化。

---

## 题目三：集群架构设计 — 生产集群如何规划

### 场景

你需要设计一个ES集群，支撑：
- 日增5亿条日志，保留30天
- 保险产品搜索，QPS 10000
- SLA要求99.9%

请回答：
1. ES节点类型有哪些？分别是什么角色？
2. 如何规划集群规模（多少节点、什么配置）？
3. 分片和副本如何设置？
4. 集群脑裂问题如何避免？
5. 如何规划索引生命周期？

---

## 答案

### 1. ES节点类型

```latex
Master节点：
  → 负责集群管理：创建/删除索引、节点上下线、分片分配
  → 不处理查询和写入
  → 建议3个（奇数），避免脑裂
  → 配置：低CPU、低内存、普通磁盘

Data节点：
  → 存储数据，处理查询和写入
  → 配置：高CPU、大内存、SSD
  → 可以进一步细分：
    - Hot节点：SSD，存放热数据
    - Warm节点：机械硬盘，存冷数据

Ingest节点：
  → 数据写入前做预处理（pipeline）
  → 类似ETL
  → 可选

Coordinating节点：
  → 协调节点，负责请求路由、结果聚合
  → 不存数据，不做主节点
  → 大集群建议独立部署
```

```yaml
# elasticsearch.yml配置示例
# 主节点
node.master: true
node.data: false
node.ingest: false

# 数据节点
node.master: false
node.data: true
node.ingest: false
```

### 2. 集群规模规划

```latex
数据量估算（日志场景）：
  日增5亿条 × 每条1KB = 500GB/天
  保留30天 = 15TB
  副本数1 = 30TB
  每个分片30GB = 1000个分片？不对...

重新计算：
  索引按天分：每天一个索引
  每天500GB × 2（副本）= 1000GB
  每个分片30GB = 34个分片/天
  → 每天的索引用30-40个分片

节点数量：
  假设每个数据节点存2TB
  30TB总数据 = 15个数据节点
  + 3个主节点
  + 2个协调节点
  → 总共20个节点

节点配置（数据节点）：
  CPU：16核+
  内存：32GB-64GB（heap设为31GB）
  磁盘：4TB × 2 SSD
  网络：万兆
```

```latex
Heap内存设置经验法则：
  → 不超过32GB（避免指针压缩失效）
  → 不超过物理内存的50%
  → 留一半给系统缓存（page cache）
  → 生产环境建议31GB
```

### 3. 分片和副本设置

```latex
分片数设置：
  原则1：每个分片大小20-40GB
  原则2：分片数不要超过节点数的3倍
  原则3：不要过度分片（每个分片有开销）
  原则4：后续可以用split API增加分片

副本数设置：
  生产环境至少1个副本
  重要数据可以设2个
  副本数 = 允许挂掉的节点数

示例：
  每天500GB日志：
    → 分片数：20（每个分片25GB）
    → 副本数：1
  保险产品索引100GB：
    → 分片数：5（每个分片20GB）
    → 副本数：2
```

### 4. 避免脑裂

```latex
脑裂原因：
  → 网络分区导致集群分成两个独立的集群
  → 两边都认为自己是主，同时对外服务

如何避免：
  1. 部署奇数个主节点：3或5个
  2. 设置discovery.zen.minimum_master_nodes
     → 公式：(master节点数 / 2) + 1
     → 3个主节点 → 设为2
     → 5个主节点 → 设为3
  3. ES7+默认用新的集群协调机制，不需要配这个参数
```

```yaml
# elasticsearch.yml（ES7-）
discovery.zen.minimum_master_nodes: 2

# ES7+：默认使用基于Raft的新协调机制
cluster.initial_master_nodes: ["master1", "master2", "master3"]
```

### 5. 索引生命周期管理（ILM）

```latex
ILM四个阶段：
  Hot：热数据，读写频繁 → SSD
  Warm：温数据，读多写少 → 机械硬盘
  Cold：冷数据，偶尔读 → 归档存储
  Delete：删除

日志场景ILM策略：
  1-7天：Hot阶段 → 2个副本，SSD
  7-30天：Warm阶段 → 1个副本，机械硬盘，force merge
  30-90天：Cold阶段 → 只读
  90天后：Delete
```

```json
// 创建ILM策略
PUT /_ilm/policy/logs_policy
{
  "policy": {
    "phases": {
      "hot": {
        "min_age": "0ms",
        "actions": {
          "rollover": {
            "max_size": "50gb",
            "max_age": "1d"
          }
        }
      },
      "warm": {
        "min_age": "7d",
        "actions": {
          "allocate": { "number_of_replicas": 1 },
          "forcemerge": { "max_num_segments": 1 }
        }
      },
      "delete": {
        "min_age": "30d",
        "actions": { "delete": {} }
      }
    }
  }
}
```

### 与架构师水平的差距

| 层次 | 回答 |
|------|------|
| 开发 | 知道ES是分布式的，但不知道节点类型 |
| 高级开发 | 了解主节点和数据节点，会设置分片数 |
| 架构师 | 能根据数据量和QPS规划集群规模，选择合适的节点配置，设计分片副本策略，配置ILM，能防范脑裂等问题 |

**补足方向**：设计集群时，先算清楚"数据量多大"、"读写QPS多少"、"SLA要求多高"，再选择对应的架构。

---

## 题目四：监控与告警 — 如何及时发现集群问题

### 场景

你的ES集群经常在出问题后才发现，业务已经受影响。

请回答：
1. ES有哪些重要的监控指标？
2. 如何监控集群健康状态？
3. JVM堆内存如何监控？
4. 磁盘使用率有什么风险？
5. 常见的告警规则有哪些？

---

## 答案

### 1. 重要监控指标

```latex
集群层面：
  cluster.status：green/yellow/red
  cluster.number_of_nodes：节点数
  cluster.number_of_data_nodes：数据节点数
  cluster.active_primary_shards：活跃主分片数
  cluster.active_shards：活跃总分片数
  cluster.unassigned_shards：未分配分片数

节点层面：
  jvm.mem.heap_used_percent：堆内存使用率
  process.cpu.percent：CPU使用率
  fs.total.disk_used_percent：磁盘使用率
  indices.search.query_total：查询总数
  indices.search.query_time_in_millis：查询总耗时
  indices.indexing.index_total：写入总数

JVM层面：
  jvm.gc.collectors.young.collection_count：Young GC次数
  jvm.gc.collectors.young.collection_time_in_millis：Young GC耗时
  jvm.gc.collectors.old.collection_count：Old GC次数
  jvm.gc.collectors.old.collection_time_in_millis：Old GC耗时
```

### 2. 集群健康状态监控

```json
// 集群健康API
GET /_cluster/health

{
  "status": "green",  // green/yellow/red
  "number_of_nodes": 10,
  "number_of_data_nodes": 8,
  "active_primary_shards": 100,
  "active_shards": 200,
  "unassigned_shards": 0
}
```

```latex
健康状态含义：
  green：所有主分片和副本都分配好了
  yellow：所有主分片分配了，但有副本没分配
  red：有主分片没分配，数据不完整

状态变化：
  green → yellow：某个数据节点挂了，副本丢失
  yellow → red：更多节点挂了，主分片也丢失
```

### 3. JVM堆内存监控

```latex
堆内存使用率风险：
  → 持续超过75%：注意
  → 持续超过85%：危险
  → 持续超过90%：非常危险，可能OOM

GC监控：
  Young GC频繁但耗时短：正常
  Young GC耗时超过1s：有问题
  Old GC频繁：很危险
  Full GC：非常危险，会STW

Heap dump：
  OOM前自动dump：-XX:+HeapDumpOnOutOfMemoryError
  路径：-XX:HeapDumpPath=/path/to/dump
```

### 4. 磁盘使用率监控

```latex
磁盘水位线（ES默认）：
  low watermark：85% → 不再分配新分片到该节点
  high watermark：90% → 尝试把分片移走
  flood stage：95% → 所有索引设为只读

监控建议：
  磁盘使用率超过80%告警
  超过85%紧急扩容或删除数据
  不要等满了再处理
```

### 5. 常见告警规则

```latex
告警规则示例：
  1. 集群状态 = yellow/red → 立即告警
  2. 堆内存使用率 > 80% → 告警
  3. 堆内存使用率 > 90% → 紧急告警
  4. 磁盘使用率 > 80% → 告警
  5. 磁盘使用率 > 90% → 紧急告警
  6. Old GC次数/分钟 > 5 → 告警
  7. 查询平均耗时 > 500ms → 告警
  8. 写入平均耗时 > 100ms → 告警
  9. 节点离线 → 立即告警
  10. 未分配分片数 > 0 → 告警
```

### 与架构师水平的差距

| 层次 | 回答 |
|------|------|
| 开发 | 只知道看集群status |
| 高级开发 | 会监控堆内存和磁盘 |
| 架构师 | 能建立完整的监控体系，知道哪些指标需要告警，能根据指标趋势预判问题，理解GC行为和磁盘水位线的影响 |

**补足方向**：建立监控时，先想清楚"哪些指标出问题会影响业务"，设置合理的阈值，不要等问题发生才处理。

---

## 题目五：故障排查 — 常见问题如何处理

### 场景

你的ES集群遇到问题：
1. 集群变成red状态
2. 写入突然变慢
3. 查询超时

请回答：
1. 集群red如何排查和恢复？
2. 写入变慢如何排查？
3. 查询超时如何处理？
4. 如何处理OOM？

---

## 答案

### 1. 集群red状态排查

```latex
排查步骤：
  1. GET /_cluster/health → 看哪些索引red
  2. GET /_cat/shards → 看哪些分片没分配
  3. GET /_cluster/allocation/explain → 看为什么没分配

常见原因：
  1. 节点离线：某个数据节点挂了，主分片在上面
  2. 磁盘满了：磁盘超过high watermark
  3. 分片分配失败：比如分片损坏

恢复步骤：
  节点离线：
    → 重启节点
    → 或者把该节点的分片重新分配到其他节点
  磁盘满了：
    → 清理磁盘空间
    → 删除旧索引
    → 增加数据节点
  分片损坏：
    → 从副本恢复（如果有副本）
    → 或者重新索引数据
```

```json
// 查看未分配分片原因
GET /_cluster/allocation/explain

// 手动重试分配
POST /_cluster/reroute?retry_failed=true
```

### 2. 写入变慢排查

```latex
排查步骤：
  1. 看节点CPU/内存/磁盘IO是否高
  2. 看JVM GC是否频繁
  3. 看索引是否有大量segment
  4. 看写入队列是否积压

常见原因：
  1. 节点资源不足：CPU/内存/磁盘满了
  2. GC频繁：堆内存不够
  3. segment太多：refresh_interval太短，频繁生成segment
  4. 写入并发太高：队列满了

解决方法：
  1. 扩容节点
  2. 调大refresh_interval
  3. 做force merge
  4. 增加副本分流
```

### 3. 查询超时排查

```latex
排查步骤：
  1. 用Profile API看查询慢在哪里
  2. 看是否有慢查询日志
  3. 看节点负载是否高
  4. 看是否有大量segment

常见原因：
  1. 查询条件没走filter，每次都扫描大量文档
  2. 查询太复杂，多个条件组合
  3. 聚合太深，占用大量内存
  4. segment太多，查询需要扫很多segment

解决方法：
  1. 优化查询，多用filter缓存
  2. 简化聚合层级
  3. 做force merge
  4. 增加协调节点
```

### 4. 处理OOM

```latex
OOM表现：
  → 节点挂掉
  → 日志里有java.lang.OutOfMemoryError
  → heap dump文件生成

紧急处理：
  1. 立即重启节点
  2. 暂时把该节点的流量切走
  3. 分析heap dump（用MAT工具）

长期解决：
  1. 增加heap内存（不超过32GB）
  2. 优化查询/聚合，减少内存占用
  3. 减少fielddata使用，用doc_values
  4. 增加节点，分散压力
```

### 与架构师水平的差距

| 层次 | 回答 |
|------|------|
| 开发 | 遇到问题只会重启 |
| 高级开发 | 会看日志和基本指标 |
| 架构师 | 能系统性排查问题，从症状找到根因，能预判问题并提前预防，知道紧急处理和长期优化的区别 |

**补足方向**：遇到问题时，先看"集群状态"、"节点资源"、"日志"这三个维度，再一步步缩小范围定位根因。

---

## Day04核心总结

```latex
Day04主线：ES生产运维不是"装起来能用就行"，而是理解各种参数对性能和稳定性的影响。

  写入优化：
    Bulk API批量写入（5-15MB/批）
    写入时副本数设为0，完成后恢复
    调大refresh_interval（30s）
    用SSD提升IO性能

  查询优化：
    用filter代替must，利用缓存
    source filtering只返回需要的字段
    用keyword做聚合，避免fielddata
    Profile API定位慢查询

  集群规划：
    节点类型分离：Master/Data/Coordinating
    每个分片20-40GB，不要过度分片
    3个Master节点防脑裂
    Heap设为31GB，不超过物理内存50%

  监控告警：
    集群status、堆内存、磁盘是核心指标
    磁盘80%告警，90%紧急处理
    Old GC频繁要注意

  故障排查：
    集群red先看未分配分片原因
    写入慢看segment数量和GC
    查询慢用Profile分析
    OOM先重启再分析dump
```

---

*日期：2026-06-19 | 2026年06月第3周 Day4 | ES性能优化与生产集群运维*