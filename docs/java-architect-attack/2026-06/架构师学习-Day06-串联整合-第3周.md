# Day 6：ES 专题串联整合 — 企业级搜索中台架构设计

## 本周回顾速览

本周 Day1-Day5 完整覆盖了 ES 从原理到实战的链路：

| Day | 主题 | 核心知识点 |
|-----|------|-----------|
| Day1 | 核心概念与倒排索引原理 | 倒排索引（Term Index + Dictionary + Posting List）、FST、Segment 不可变、NRT 写入链路、分片规划 |
| Day2 | Mapping 与字段类型陷阱 | text/keyword、object/nested、动态映射、Index Template、字段类型选型、reindex + alias 变更 |
| Day3 | 查询 DSL 与聚合分析 | match/term、bool 四子句、Bucket/Metric/Pipeline 聚合、深分页三方案、BM25 |
| Day4 | 性能优化与生产集群运维 | Bulk 调优、filter 缓存、Doc Values、节点角色、ILM、监控告警、故障排查 |
| Day5 | 业务系统集成与典型场景 | Canal 同步、ELK 日志平台、routing 优化、多租户 DLS/FLS、生态集成 |

**本周因果链**：底层原理（倒排索引/段不可变）→ 数据建模（Mapping）→ 查询表达（DSL/聚合）→ 性能与稳定性（优化/运维）→ 工程落地（业务集成）

---

## 场景选择：企业级搜索中台

### 为什么选中台场景

今天不走多场景分选模式。本周五天学完之后，最能"一次性把所有知识点用上"的场景，不是单业务的搜索功能，而是**多业务统一搜索中台**——这是架构师视角才能真正驾驭的设计题。

中台场景一次性用到本周全部知识点：

```text
Day1：倒排索引 → 中台抽象出"索引即数据集合"的统一模型，所有业务线共用一套底层心智
Day2：Index Template + Component Template → 多业务线统一 Mapping 规约，dynamic_template 字段治理
Day3：bool/filter/聚合 DSL → 中台层封装统一查询 DSL，屏蔽业务侧差异
Day4：集群节点角色 + 分片规划 + ILM + 监控 → 多业务共享集群的隔离与稳定性
Day5：Canal/MQ 统一数据管道 + Redis 缓存 + Spark/Flink 分析 → 数据闭环
```

如果只看单业务搜索，会错过"多业务共享集群的隔离、模板治理、数据管道统一"这些架构师核心命题。

---

## 核心考题：企业级搜索中台架构设计

### 业务背景

```text
公司有多条业务线，都需要搜索能力，但各自为政：
  - 保险商城：产品搜索（全文检索 + 多维筛选 + 聚合）
  - IM 在线客服：历史消息检索（中文分词 + 高亮）
  - 医疗在线问诊：病历/处方搜索（多租户 + 合规）
  - 啄木鸟智慧公卫体检：体检数据检索（多租户 + 字段权限）
  - 秒杀系统：订单搜索（高并发 + routing）
  - 日志平台：统一日志分析（ELK + Hot/Warm）

每条业务线各自维护 ES 集群或索引，问题：
  - 重复造轮子：每条线都自己写同步、自己写 DSL、自己定 Mapping
  - 资源浪费：小业务线集群空载，大业务线集群打爆
  - 字段类型混乱：相同业务概念（如 order_id）在不同线类型不一致
  - 运维割裂：每条线一套监控、一套告警、一套 ILM，运维成本爆炸
  - 数据孤岛：跨业务搜索（如"某用户在所有业务的痕迹"）做不到
```

### 目标

```text
1. 统一索引模型：所有业务线遵循同一套 Mapping 规约与字段命名
2. 统一数据管道：所有业务线通过同一套 Canal/MQ 管道写入 ES
3. 统一查询 DSL：业务侧调用中台 SDK，不直接写 ES DSL
4. 集群共享 + 隔离：多业务共享集群，但分片/索引/权限互相隔离
5. 统一运维：一套监控、一套 ILM、一套告警
6. 跨业务搜索能力：通过别名和路由支持"用户全链路行为检索"
7. SLA：P99 < 200ms，可用性 99.95%
```

---

## 架构师方案：分层抽象 + 统一治理 + 业务隔离

```text
                          业务线
                            │
        ┌───────────────────┼───────────────────┐
        │                   │                   │
   保险商城搜索         IM消息搜索          医疗/秒杀/日志搜索
        │                   │                   │
        └───────────────────┼───────────────────┘
                            │
                  搜索中台 SDK（统一 DSL）
                            │
                  查询网关（鉴权 + 限流 + 缓存）
                            │
        ┌───────────────────┼───────────────────┐
        │                   │                   │
   索引模板治理层       数据同步管道层       集群运维治理层
   - Component Template - Canal + Kafka       - 节点角色分离
   - Index Template     - Logstash/Connect   - 分片规划
   - dynamic_template   - 双写 + 补偿        - ILM 生命周期
   - alias 切换         - Redis 缓存         - 监控告警
        │                   │                   │
        └───────────────────┼───────────────────┘
                            │
                    共享 ES 集群（多业务隔离）
                            │
            ┌───────────────┼───────────────┐
            │               │               │
         Master 组       Data 节点       Coordinating
         （3 个）       （Hot/Warm）       节点
```

---

## 本周知识点串联

| 知识点 | 在中台场景中的应用 |
|--------|-------------------|
| **倒排索引 / Segment 不可变（Day1）** | 中台必须向业务侧讲清楚"为什么 Mapping 一旦确定不能改"——这是 segment 不可变决定的，所有变更必须走 reindex + alias |
| **NRT 写入链路（Day1）** | 中台统一配置 refresh_interval：搜索类业务 1s、日志类 30s，业务侧无感知 |
| **分片规划（Day1）** | 中台根据各业务数据量统一规划分片数，避免单业务过度分片拖累集群 |
| **text/keyword 选型（Day2）** | 中台字段规约：所有标识符（order_id/user_id/policy_no）统一 keyword，金额统一 scaled_float |
| **object vs nested（Day2）** | 中台规约：保单被保险人、商品保障责任等需要跨字段匹配的，强制 nested；标签数组强制 keyword |
| **dynamic: strict（Day2）** | 中台所有索引强制 strict，禁止业务侧私自加字段，从源头治理字段爆炸 |
| **Index Template 分层（Day2）** | Component Template 抽通用配置（@timestamp/service/level），Index Template 按业务+环境分层 |
| **dynamic_template（Day2）** | 统一规则：`*_id` → keyword、`*_time` → date、`*_amount` → scaled_float |
| **alias 切换（Day2）** | 中台所有索引必须通过 alias 访问，业务侧永远不直接碰物理索引名，reindex 零停机 |
| **bool 四子句（Day3）** | 中台 SDK 封装：所有过滤条件默认走 filter，只有显式声明"需要打分"的字段才走 must |
| **filter 缓存（Day3）** | 中台对常见 filter（租户、状态、时间范围）做缓存预热，业务侧透明享受加速 |
| **深分页三方案（Day3）** | 中台 SDK 默认禁用 from/size > 10000，深分页强制走 search_after，导出走 scroll/PIT |
| **聚合先过滤（Day3）** | 中台规约：所有聚合请求必须带 query 过滤，禁止全量聚合 |
| **Bulk 写入调优（Day4）** | 中台统一数据管道的批量大小 5-15MB，所有业务线共享同一套调优参数 |
| **副本数策略（Day4）** | 中台按业务 SLA 分级：核心业务 2 副本、日志类 1 副本、可重建数据 0 副本 |
| **Doc Values（Day4）** | 中台 Mapping 规约：text 字段默认 doc_values=false（不需要聚合），keyword 默认开启 |
| **节点角色分离（Day4）** | 中台集群：3 Master + N Hot Data + M Warm Data + K Coordinating，业务侧无感知 |
| **ILM（Day4）** | 中台按业务类型配置生命周期：日志 30 天删除、订单 90 天转 warm、保单永久 |
| **监控告警（Day4）** | 中台统一监控：集群 status、堆内存、磁盘水位、Old GC、慢查询，业务侧按索引维度看自己的指标 |
| **Canal + Kafka 同步（Day5）** | 中台统一数据管道：所有业务线 MySQL 变更通过 Canal → Kafka → 消费者写 ES |
| **routing 优化（Day5）** | 中台对秒杀订单、医疗多租户等场景，统一用 routing=user_id/tenant_id，查询只命中一个分片 |
| **多租户 DLS/FLS（Day5）** | 中台对医疗、保险等合规业务，统一用 Document/Field Level Security 做行级/字段级权限 |
| **Redis 缓存（Day5）** | 中台查询网关统一接 Redis：热门搜索结果缓存 5 分钟，布隆过滤器防穿透 |
| **Spark/Flink 分析（Day5）** | 中台对账、画像、报表类需求统一走 Spark/Flink 读 ES，不直接打在线集群 |

---

## 一、索引模型治理层

中台的第一责任是**让所有业务线遵循同一套字段规约**，否则后续一切都是空谈。

### 1.1 字段命名与类型规约

```text
全公司统一的字段规约（部分）：
  order_id          → keyword       （所有业务线的订单号）
  user_id           → keyword       （所有业务线的用户ID）
  policy_no         → keyword       （保单号）
  product_name      → text + keyword（商品/产品名称）
  amount            → scaled_float  （金额，scaling_factor=100）
  create_time       → date          （创建时间）
  update_time       → date          （更新时间）
  tenant_id         → keyword       （租户ID，所有多租户业务强制带）
  status            → keyword       （状态枚举）
  tags              → keyword       （标签数组）
  message           → text          （消息/日志正文）
```

为什么必须统一？因为中台要支持"跨业务搜索"——比如查"用户 user_123 在所有业务的痕迹"，如果保险线叫 `user_id`、医疗线叫 `patient_id`、IM 线叫 `sender_id`，跨业务搜索就做不到。

### 1.2 Component Template 抽通用配置

```json
PUT _component_template/common_settings
{
  "template": {
    "settings": {
      "number_of_replicas": 1,
      "refresh_interval": "1s",
      "index.default_pipeline": "common_enrich"
    }
  }
}

PUT _component_template/common_mappings
{
  "template": {
    "mappings": {
      "dynamic": "strict",
      "dynamic_templates": [
        { "ids_as_keyword":   { "match": "*_id",     "match_mapping_type": "string", "mapping": { "type": "keyword" }}},
        { "times_as_date":    { "match": "*_time",   "match_mapping_type": "string", "mapping": { "type": "date" }}},
        { "amounts_as_scaled":{ "match": "*_amount", "match_mapping_type": "string", "mapping": { "type": "scaled_float", "scaling_factor": 100 }}},
        { "strings_as_keyword":{ "match_mapping_type": "string", "mapping": { "type": "keyword" }}}
      ],
      "properties": {
        "@timestamp": { "type": "date" },
        "tenant_id":  { "type": "keyword" },
        "service":    { "type": "keyword" }
      }
    }
  }
}
```

### 1.3 Index Template 按业务+环境分层

```json
// 保险商城 - 生产
PUT _index_template/insurance_prod
{
  "index_patterns": ["insurance-prod-*"],
  "composed_of": ["common_settings", "common_mappings"],
  "template": {
    "settings": { "number_of_shards": 5, "number_of_replicas": 2 }
  },
  "priority": 200
}

// 日志 - 生产（refresh 拉长、副本少、ILM 接管）
PUT _index_template/logs_prod
{
  "index_patterns": ["logs-prod-*"],
  "composed_of": ["common_settings", "common_mappings"],
  "template": {
    "settings": {
      "number_of_shards": 10,
      "number_of_replicas": 1,
      "refresh_interval": "30s",
      "index.lifecycle.name": "logs_policy"
    }
  },
  "priority": 200
}

// 通用默认（兜底）
PUT _index_template/default
{
  "index_patterns": ["*"],
  "composed_of": ["common_settings", "common_mappings"],
  "priority": 10
}
```

priority 留间隔（10 / 100 / 200 / 300），后续插入新业务模板时有空间。

### 1.4 强制 alias 访问

中台铁律：**业务侧永远不直接读写物理索引名**。

```text
写：业务侧写 alias：order_write
  → 中台路由到当天物理索引：order-2026.06.21

读：业务侧读 alias：order_read
  → 中台可指向单索引（当天）或多索引（跨天/跨月）

reindex 变更时：
  → 新建 order-2026.06.21-v2
  → reindex 数据
  → alias 切换（业务侧无感知）
  → 删除旧索引
```

这一条直接来源于 Day2 学到的"段不可变 → 字段类型不能改 → 必须 reindex + alias"。

---

## 二、数据同步管道层

中台的第二责任是**统一数据管道**，让业务侧不需要自己写同步逻辑。

### 2.1 统一同步架构

```text
各业务 MySQL
   │
   ↓ Canal/Debezium 监听 Binlog
   │
Kafka（topic 按业务分：insurance-events / im-events / order-events / ...）
   │
   ↓ 统一消费者（中台维护）
   │
   ├── 写入 ES（按业务路由到对应索引）
   ├── 失败落本地消息表（补偿）
   └── 删除 Redis 缓存（保证读一致）
```

### 2.2 三种同步模式按业务选型

| 业务 | 同步模式 | 理由 |
|------|---------|------|
| 保险商城产品 | Canal + Kafka（异步） | 更新不频繁，1s 延迟可接受 |
| IM 消息 | 双写 + 异步补偿 | 用户发消息后要立即搜到，NRT 不够 |
| 秒杀订单 | 双写 + 异步补偿 + Canal 兜底 | 实时性 + 一致性双要求 |
| 医疗体检 | Canal + Kafka | 合规要求不侵入业务，且延迟可接受 |
| 日志 | Filebeat → Kafka → Logstash | 不走 MySQL，直接采集 |

为什么不一刀切都用 Canal？因为 IM 和秒杀有"写后立即可搜"的强需求，Canal 的 1s 延迟满足不了。

### 2.3 双写场景的可靠性保障

秒杀订单这类双写场景，中台统一封装：

```java
// 中台 SDK 封装：业务侧只调一个方法
@EsSync(business = "order")
public void createOrder(Order order) {
    orderMapper.insert(order);          // 1. 写 MySQL（事务内）
    // 2. 中台 AOP 拦截，事务提交后异步写 ES
    // 3. ES 写入失败 → 落本地消息表
    // 4. Canal 做兜底校验（防止本地消息表也丢）
}
```

三层保障：

```text
第一层：双写（实时性）
第二层：本地消息表 + 补偿任务（可靠性）
第三层：Canal 兜底（一致性校验）
```

这是 Day5 秒杀订单场景学到的同步方案在中台层的标准化封装。

### 2.4 跨业务数据管道的幂等

中台所有消费者统一用 requestId（业务侧生成）作为幂等 Key：

```text
消费前：SETNX es:sync:dedup:{requestId}
  成功 → 处理
  失败 → 跳过（已处理）

处理失败 → 不 ACK → Kafka 重试
重试耗尽 → 死信队列 → 人工介入
```

业务侧不需要关心幂等，中台 SDK 默认带上。

---

## 三、查询 DSL 治理层

中台的第三责任是**屏蔽 ES DSL 的复杂性**，让业务侧写不出性能差的查询。

### 3.1 中台 SDK 封装统一查询接口

业务侧调用方式：

```java
SearchRequest request = SearchRequest.builder()
    .business("insurance")              // 业务标识
    .tenantId("tenant_123")             // 自动注入租户过滤
    .keyword("重疾险 终身", "product_name^2", "description")  // 全文检索
    .filter("category", "健康险")       // 过滤条件（默认走 filter）
    .filter("price", 100, 5000)        // 范围过滤
    .sort("sales_count", "desc")        // 排序
    .page(1, 20, SearchMode.SAFE)      // 分页：SAFE 强制 search_after
    .aggregation("category_agg", "category")
    .build();

SearchResult result = searchClient.search(request);
```

SDK 在背后做的事：

```text
1. 自动注入 tenant_id filter（多租户隔离，业务侧无感知）
2. 所有 filter 走 bool.filter 子句（利用缓存）
3. keyword 字段强制走 match（全文检索）或 term（精确匹配）
4. 深分页自动转 search_after（业务侧不需要知道）
5. 聚合请求自动加 query 过滤（防止全量聚合）
6. 自动加 _source 过滤（只返回业务侧声明的字段）
```

### 3.2 禁用清单（性能红线）

中台 SDK 直接禁用以下写法：

```text
✗ from + size > 10000          → 强制 search_after
✗ text 字段用 term 查询         → 编译期报错
✗ text 字段做聚合               → 编译期报错
✗ 没带 query 的全量聚合          → 运行期拒绝
✗ nested 查询不带 path           → 编译期报错
✗ 没带 tenant_id 的多租户业务查询 → 运行期拒绝
```

这些红线全部来自 Day3、Day4 学到的性能陷阱。

### 3.3 查询网关层

SDK 之后还有一层查询网关：

```text
业务侧 SDK
   ↓
查询网关
   ├── 鉴权（业务线身份校验）
   ├── 限流（按业务线配额：保险 5000 QPS、IM 2000 QPS、秒杀 10000 QPS）
   ├── 缓存（Redis 缓存热门查询，TTL 5 分钟）
   ├── 熔断（ES 集群压力大时降级）
   └── 审计（记录所有查询，合规追溯）
   ↓
ES 集群
```

为什么需要查询网关？因为多业务共享集群，如果没有限流和隔离，一个业务线的慢查询会拖垮所有业务。

---

## 四、集群运维治理层

中台的第四责任是**统一集群运维**，让多业务共享集群但互不影响。

### 4.1 节点角色分离

```text
3 × Master 节点（奇数防脑裂，ES7+ 默认协调机制）
   配置：4核 8G、普通磁盘
   职责：集群管理、分片分配

N × Hot Data 节点
   配置：16核 64G、SSD 4TB×2
   职责：存放最近 7 天热数据、承接写入和热查询

M × Warm Data 节点
   配置：16核 64G、机械硬盘 8TB×2
   职责：存放 7-90 天温数据、低频查询

K × Coordinating 节点
   配置：16核 32G、SSD
   职责：请求路由、结果聚合、屏蔽 Data 节点

1 × Cold 节点（可选）
   配置：大容量机械硬盘
   职责：90 天以上归档数据
```

Heap 设置铁律（来自 Day4）：

```text
Heap ≤ 31GB（避免指针压缩失效）
Heap ≤ 物理内存 50%（留一半给 OS Cache）
```

### 4.2 业务隔离策略

多业务共享集群，三种隔离手段叠加：

```text
1. 索引隔离（强）：
   每个业务用独立索引前缀：insurance-* / im-* / order-* / medical-* / logs-*
   互不干扰，可独立做 ILM

2. 分片隔离（中）：
   通过分片分配过滤（index.routing.allocation.include）：
   - 核心业务（保险、秒杀）→ 优先分配到高性能 Hot 节点
   - 日志业务 → 分配到普通 Hot 节点
   - 冷数据 → 分配到 Warm 节点

3. 权限隔离（强）：
   每个业务线一个 ES 角色 + 索引权限：
   - insurance_role 只能读写 insurance-*
   - order_role 只能读写 order-*
   - medical_role 额外配置 DLS/FLS（行级/字段级权限）
```

### 4.3 ILM 生命周期按业务定制

```text
保险商城保单：永久保留（合规要求）
  Hot（0-30 天）→ Warm（30 天-永久）

秒杀订单：
  Hot（0-7 天）→ Warm（7-90 天）→ Delete（180 天）

IM 消息：
  Hot（0-30 天）→ Warm（30-180 天）→ Cold（180 天-1 年）→ Delete（1 年）

医疗体检：永久保留（医疗合规）
  Hot → Warm → Cold（归档）

日志：
  Hot（0-7 天）→ Warm（7-30 天）→ Delete（30 天）
```

每个业务的 ILM 策略由中台统一维护，业务侧声明保留期即可。

### 4.4 统一监控告警

```text
集群维度（中台运维看）：
  - cluster.status（green/yellow/red）
  - 节点 CPU/内存/磁盘
  - Old GC 频次
  - 未分配分片数

业务维度（各业务线看自己的）：
  - 索引写入 QPS / 延迟
  - 索引查询 QPS / P99 延迟
  - 索引存储大小
  - 慢查询数

告警分级：
  P0：集群 red、节点离线、磁盘 > 95%
  P1：堆内存 > 90%、Old GC 频繁、查询 P99 > 1s
  P2：堆内存 > 80%、磁盘 > 85%、慢查询增多
```

中台提供 Grafana Dashboard 模板，每个业务线自动生成自己的看板。

### 4.5 故障排查 SOP

中台统一故障排查流程（来自 Day4）：

```text
集群 red：
  1. GET /_cluster/health → 看哪些索引 red
  2. GET /_cluster/allocation/explain → 看分片未分配原因
  3. 节点离线 → 重启；磁盘满 → 清理/扩容；分片损坏 → 从副本恢复

写入变慢：
  1. 看节点资源（CPU/内存/IO）
  2. 看 JVM GC 是否频繁
  3. 看 segment 数量（refresh_interval 是否过短）
  4. 看写入队列积压

查询超时：
  1. Profile API 定位慢查询
  2. 看是否走了 filter 缓存
  3. 看是否有全量聚合
  4. 看 segment 数量

OOM：
  1. 立即重启节点 + 切流量
  2. 分析 heap dump（MAT）
  3. 长期：优化查询 / 减少 fielddata / 扩容
```

---

## 五、跨业务搜索能力

中台独有的能力——单业务线做不到的**跨业务用户行为检索**。

### 5.1 统一用户行为索引

中台额外维护一个 `user_behavior-*` 索引，所有业务线的用户行为归一化后写入：

```json
PUT /user_behavior-2026.06.21/_doc/1
{
  "user_id": "user_123",
  "tenant_id": "tenant_abc",
  "service": "insurance",            // 来源业务
  "action": "search",                // 行为类型
  "target_id": "INS-001",            // 目标对象
  "action_time": "2026-06-21T10:00:00Z",
  "context": {                       // 业务上下文（nested）
    "keyword": "重疾险",
    "filters": {"category": "健康险"}
  }
}
```

### 5.2 跨业务查询示例

```text
"查 user_123 最近 30 天在所有业务的痕迹"
  → 查询 user_behavior-* 索引
  → filter: user_id = user_123, action_time >= now-30d
  → 不用 fan-out 到各业务索引
```

### 5.3 routing 优化

`user_behavior` 索引用 `user_id` 做 routing：

```text
写入：routing = user_id
查询：routing = user_id
  → 只查一个分片，不用 fan-out 到全部分片
  → 单用户行为查询从 O(全分片) 降到 O(1 分片)
```

这是 Day5 学到的 routing 优化在中台跨业务场景的应用。

---

## 六、架构师思考：搜索中台的职责边界

### 6.1 不要把中台当成"ES 集群代运维"

中台的核心不是 ES 集群，而是**治理**：

```text
ES 集群：底层存储，可以被替换（理论上换成 OpenSearch / Solr 也可以）
中台价值：
  - 字段规约（让所有业务说同一种语言）
  - 数据管道（让业务侧不写同步代码）
  - 查询 DSL 封装（让业务侧写不出性能差的查询）
  - 隔离与共享（多业务共享集群但互不影响）
  - 跨业务能力（单业务做不到的统一检索）
```

每个能力只负责自己擅长的部分：

```text
业务侧负责：业务逻辑、字段定义
中台负责：模板治理、数据管道、查询封装、集群运维
ES 负责：倒排索引、分布式存储、近实时检索
```

### 6.2 强一致和最终一致的边界

中台必须讲清楚哪些强一致、哪些最终一致：

```text
必须强一致：
  - ES 字段类型一旦确定不能改（段不可变）
  - 多租户数据隔离（DLS 强制生效）
  - 别名切换的原子性（_aliases API 单次操作原子）

可以最终一致：
  - MySQL 到 ES 的数据同步（1s 延迟）
  - Redis 缓存与 ES 的一致性（5 分钟 TTL）
  - 跨业务用户行为索引的写入（异步）
  - ILM 阶段切换（按时间触发）
```

### 6.3 中台常见的失败认知

| 错误认知 | 正确理解 |
|----------|----------|
| 中台就是搭个 ES 集群让大家用 | 中台核心是治理（规约+管道+封装+隔离），集群只是底层 |
| 所有业务统一 Mapping 就够了 | 还需要数据管道统一、查询 DSL 封装、监控告警统一 |
| 多业务共享集群一定比独享省成本 | 共享后必须做隔离，否则一个业务拖垮全公司 |
| 业务侧直接写 ES DSL 最灵活 | 灵活 = 写出性能差的查询，中台必须封禁危险写法 |
| 跨业务搜索就是多索引联合查询 | 必须有统一字段规约 + routing 设计，否则跨业务搜不了 |
| 中台上线后业务侧必须立刻迁移 | 必须有灰度方案（双写双读 → 切读 → 切写 → 下线旧） |
| 中台做完了就稳定了 | 中台是持续治理，字段会膨胀、业务会变更、容量会增长 |

### 6.4 中台演进路径

```text
阶段 1（单业务集群）：各业务自建集群 → 重复造轮子
阶段 2（共享集群 + 模板治理）：统一 Index Template、字段规约
阶段 3（统一数据管道）：Canal + Kafka 标准化，业务侧不写同步
阶段 4（统一查询 SDK）：屏蔽 DSL，性能红线封禁
阶段 5（跨业务能力）：统一用户行为索引、routing 优化
阶段 6（智能化）：查询自动优化、容量自动扩缩、异常自愈
```

不是一上来就做阶段 5，而是从模板治理开始逐步演进。

---

## 七、能力差距自检

本周所有知识串联成搜索中台后，按这个清单检查是否达到架构师水平：

```text
[ ] 能否 1 分钟内说清楚中台四层架构（索引治理 / 数据管道 / 查询封装 / 集群运维）
[ ] 能否说清楚为什么所有索引必须 alias 访问（段不可变 → reindex → 零停机切换）
[ ] 能否说清楚多业务共享集群的三层隔离手段（索引 / 分片 / 权限）
[ ] 能否说清楚三种数据同步模式（Canal / 双写 / Filebeat）的选型依据
[ ] 能否说清楚中台 SDK 封装后屏蔽了哪些性能陷阱（深分页 / text 聚合 / 全量聚合）
[ ] 能否说清楚 Hot/Warm/Cold 分层与 ILM 的关系
[ ] 能否说清楚跨业务搜索为什么需要统一字段规约 + routing
[ ] 能否说清楚中台哪些地方强一致、哪些地方最终一致
[ ] 能否指出"中台就是搭个 ES 集群让大家用"为什么是错的
[ ] 能否设计出从单业务集群到中台的灰度迁移方案
```

---

## 八、与上周 Redis 专题的呼应

上周 Redis 专题用秒杀系统串联，本周 ES 专题用搜索中台串联，两者在公司架构中的关系：

```text
秒杀系统（Redis 为主）
   ↓ 订单写入 MySQL
   ↓ Canal 同步
搜索中台（ES 为主）
   ↓ 订单可被搜索
   ↓ 跨业务用户行为分析
```

秒杀系统产生的订单数据，最终通过中台的数据管道进入 ES，被搜索、被分析。两个专题不是孤立的，而是公司数据链路上下游的关系。

中台对秒杀订单的特殊处理：

```text
- 秒杀订单索引：用 user_id 做 routing（查询只命中一个分片）
- 双写 + 补偿 + Canal 兜底（Day5 学到的同步方案）
- 高峰期临时扩副本（应对读 QPS 暴涨）
- 高峰期临时调大 refresh_interval（提升写入吞吐）
```

---

*日期：2026-06-20 | 2026年06月第3周 Day6 | 串联整合日 — 企业级搜索中台架构设计*