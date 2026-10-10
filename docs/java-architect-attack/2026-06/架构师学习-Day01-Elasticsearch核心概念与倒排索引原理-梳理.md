# 架构师学习 Day01 梳理：Elasticsearch 核心概念与倒排索引原理
> 架构师视角的提炼版｜适合复习与面试速记
>

---

## 一、ES 在系统架构中的定位
### 1.1 核心一句话
> **ES = 倒排索引 + 分布式 Lucene + JSON RESTful 接口**
>
> 用作搜索/聚合的专用读侧存储，与 MySQL 形成 CQRS 架构。
>

### 1.2 不要混淆的两个误区
| 误区 | 正确认知 |
| --- | --- |
| "ES 可以替代 MySQL" | ❌ ES 没有事务、近实时、不擅长 JOIN，是**搜索和分析引擎** |
| "ES 是 NoSQL 数据库" | ⚠️ 形式上是，但定位是**搜索引擎**，存储能力是副产品 |


### 1.3 业务架构中的位置
```latex
                 ┌─────────────┐
                 │   业务请求    │
                 └──────┬──────┘
                        │
            ┌───────────┼───────────┐
            ↓                       ↓
       写 / 强一致              搜索 / 聚合
            ↓                       ↓
      ┌───────────┐           ┌──────────┐
      │   MySQL    │ ──同步──→ │    ES     │
      │（事实源头） │  Canal/MQ │（最终一致）│
      └───────────┘           └──────────┘
```

---

## 二、必背的概念层级
```latex
Cluster
  └── Node                   集群成员，承担不同角色
        ├── Master Node      管理元数据
        ├── Data Node        存储数据
        ├── Coordinating Node 协调请求
        └── Ingest Node      数据预处理
        
Index（业务概念，类比表）
  └── Shard（分布式单元）
        ├── Primary Shard    主分片，写入入口
        └── Replica Shard    副本，高可用 + 读扩展
              └── Segment    Lucene 最小搜索单元（不可变）
                    └── Document
                          └── Field
```

### 关键约束
```latex
1. 主分片数 = 创建时确定，不可修改（reindex 才能改）
2. 副本数 = 任何时候可调整
3. 副本不能与主分片在同一节点
4. 单分片 = 一个 Lucene Index = 多个 Segment
```

---

## 三、倒排索引：架构师必须能讲清楚的三件事
### 3.1 三层结构
```latex
Term Index（FST，内存）
   ↓ 定位
Term Dictionary（词项字典，磁盘）
   ↓ 指针
Posting List（倒排列表，磁盘）
```

### 3.2 Posting List 不只是 DocID
```latex
DocID + TF（词频）+ Position（位置）+ Offset（偏移）

→ DocID：定位
→ TF：BM25 打分
→ Position：短语查询 match_phrase
→ Offset：高亮显示
```

### 3.3 为什么快
```latex
传统 LIKE：全表扫描 + 字符串比对  → O(N × L)
倒排索引：Term 直接定位 Posting List → O(log T)

关键差异不在数据结构，而在"是否提前对内容做了分词与建索引"
```

---

## 四、写入流程：理解 NRT 的关键
### 4.1 核心链路（必须背）
```latex
Client
  → Coordinating Node（路由）
    → Primary Shard
      → In-memory Buffer（不可见）
      → translog（持久化保障）
      → [refresh 1s] → OS Cache 中生成 Segment（可搜索）
      → [flush 30min] → fsync 到磁盘，translog 清空
      → [merge 后台] → 段合并
```

### 4.2 三个时间窗口
| 操作 | 默认 | 触发条件 | 关键点 |
| --- | --- | --- | --- |
| refresh | 1s | 间隔到 / 手动 | 决定**可搜索性**（NRT 来源） |
| flush | 30min | 间隔到 / translog 满 | 决定**持久化**（数据落盘） |
| merge | 后台 | 段数量阈值 | 决定**搜索性能**（段越少越快） |


### 4.3 调优思路
```latex
高写入吞吐场景（日志）：refresh_interval = 30s
高实时性场景（搜索）：refresh_interval = 1s（默认）
强一致写后读：?refresh=true（性能差，慎用）
批量导入：临时关闭 refresh（refresh_interval = -1）+ 关闭副本
```

---

## 五、Mapping 设计的架构师 checklist
### 5.1 必须明确的问题
```latex
□ 字段是否需要全文搜索？     → text
□ 字段是否需要精确匹配？     → keyword
□ 字段是否需要聚合排序？     → keyword 或 doc_values 开启
□ 字段是否需要嵌套查询？     → nested
□ 字段是否会爆炸增长（动态字段）？ → 关闭 dynamic 或用 strict
□ 大文本字段是否需要存储原文？ → store: false（默认从 _source 取）
```

### 5.2 双字段（multi-fields）模板
> 这是生产环境**最常用的模板**，几乎所有字符串字段都建议这么写：
>

```json
"name": {
  "type": "text",
  "analyzer": "ik_max_word",
  "search_analyzer": "ik_smart",
  "fields": {
    "keyword": { "type": "keyword", "ignore_above": 256 }
  }
}
```

含义：

```latex
name              → 全文搜索（IK 分词）
name.keyword      → 精确匹配、聚合、排序
ignore_above:256  → 超过 256 字符的值不进 keyword 索引（防止聚合爆内存）
```

### 5.3 索引时分词 vs 搜索时分词
```latex
analyzer        : 写入时用，颗粒度细（ik_max_word）→ 索引更全
search_analyzer : 查询时用，颗粒度粗（ik_smart）→ 减少误匹配

例：
写入 "中华人民共和国"
  ik_max_word → ["中华", "人民", "共和国", "中华人民共和国", "华人", ...]
  ik_smart    → ["中华人民共和国"]

查询 "中华"
  ik_smart 分词 → ["中华"]
  匹配到索引中的 "中华" Term → 命中
```

---

## 六、分片规划的架构师方法论
### 6.1 三步法
```latex
第一步：估算总数据量（3年规划）
   总文档数 × 单文档大小

第二步：定主分片数
   总数据量 / 单分片目标大小（30GB）

第三步：定副本数
   核心业务：1~2 副本
   日志类：0~1 副本
```

### 6.2 案例对照表
| 业务 | 数据量 | 主分片 | 副本 | 理由 |
| --- | --- | --- | --- | --- |
| 保单搜索（核心） | 1 亿 / 800GB | 30 | 1 | 高可用 + 读扩展 |
| 商品搜索 | 500 万 / 50GB | 3 | 1 | 数据量小，留扩展余地 |
| 客服会话日志 | 10 亿 / 5TB | 100 | 0 | 可重建，不要副本 |
| 体检报告 | 1000 万 / 500GB | 15 | 2 | 资金/合规相关，多副本 |


### 6.3 反模式（要避免）
```latex
× 单 Index 几个亿数据只用 5 个分片  → 单分片过大，搜索慢
× 几百万数据用 100 个分片            → 分片过多，元数据开销大
× 主分片和副本在同一节点              → 单点故障一起挂
× 1 个 Node 上 1000+ 分片            → JVM heap 压力，集群不稳
```

---

## 七、ES 与 MySQL/Redis 的选型矩阵
### 7.1 三件套定位
```latex
MySQL  : 事务、强一致、复杂关系          → 事实源头
Redis  : 高并发、低延迟、简单 KV          → 缓存与计数
ES     : 全文检索、多维聚合、海量分析      → 搜索与分析
```

### 7.2 业务场景选型表
| 场景 | 主存储 | 辅助 | 理由 |
| --- | --- | --- | --- |
| 用户登录鉴权 | Redis (Session) | MySQL | 高并发、低延迟 |
| 下单 / 支付 | MySQL | Redis (库存) | ACID 事务 |
| 我的保单列表（按 user_id 查） | MySQL | - | 关系型查询 |
| 保险商品搜索 | ES | MySQL（事实源头） | 全文检索 + 多维筛选 |
| 客服历史消息全文搜索 | ES | MySQL | 全文检索 |
| 库存扣减 / 防重 | Redis | MySQL | 低延迟原子操作 |
| 体检报告关键词检索 | ES | MySQL | 全文 + 聚合统计 |
| 日志监控分析 | ES | - | 时序聚合 |
| RAG 知识库 | ES（dense_vector） | LLM | 向量召回 |


### 7.3 关键判断准则
```latex
要事务、要强一致 → MySQL
要快、要原子、要计数 → Redis
要搜索、要聚合、要分析 → ES
不知道选哪个 → 先 MySQL，搜索/分析痛了再加 ES
```

---

## 八、架构师面试高频考点速记
### 8.1 必答题清单
```latex
Q1: ES 为什么比 MySQL 全文检索快？
   倒排索引（不是 B+ 树扫表）+ FST 词项定位

Q2: ES 是实时的吗？
   近实时（NRT），默认 1s。1s 用于 refresh 生成 segment

Q3: ES 怎么保证不丢数据？
   translog（写入即 fsync，默认 request 级别）
   + flush（30min 落盘 segment）
   + 副本（高可用）

Q4: 主分片数为什么不能改？
   路由公式 hash(_id) % primary_shard_count
   分片数变了，已有数据的路由全部失效，必须 reindex

Q5: text 和 keyword 区别？
   text 分词进倒排，用于全文搜索
   keyword 不分词，用于精确匹配/聚合/排序
   生产建议：multi-fields 同时建两个

Q6: ES 集群脑裂如何避免？
   discovery.zen.minimum_master_nodes = (master 数 / 2) + 1
   ES 7.x 后改为 cluster.initial_master_nodes 自动管理

Q7: 段为什么要不可变？
   不可变 = 无锁并发读 + OS 级缓存友好 + 简化数据结构
   代价：更新变成"标记删除 + 新增"，需要 merge

Q8: 一个文档怎么找到对应的分片？
   shard_num = hash(_routing) % primary_shard_count
   _routing 默认是 _id，可自定义（用于路由优化）
```

### 8.2 进阶题
```latex
Q: 如果有一个亿级 keyword 字段做聚合，怎么避免内存爆？
   - 用 composite aggregation 分页
   - 开启 doc_values（默认开启）
   - 必要时换 cardinality（基数估算）

Q: ES 写入慢怎么排查？
   1. 看 _nodes/stats 的 indexing 指标
   2. refresh 太频繁？→ 调大 refresh_interval
   3. translog fsync 太频繁？→ async 模式（牺牲数据安全）
   4. 段合并占资源？→ 调整 merge throttling
   5. 副本太多？→ 临时降副本

Q: ES 搜索慢怎么排查？
   1. profile API 看耗时
   2. 段太多？→ force merge
   3. 查询深分页？→ search_after 替代 from + size
   4. 大聚合？→ 加 filter context 提前过滤
   5. 字段类型设计错？→ text 用 keyword 字段聚合
```

---

## 九、本日核心心智模型
```latex
┌──────────────────────────────────────────────────────┐
│                                                      │
│  ES 的一切设计都围绕一个核心权衡：                      │
│                                                      │
│    "牺牲一点写入实时性和事务能力                        │
│     换取极致的搜索性能和横向扩展能力"                   │
│                                                      │
│  理解这个权衡：                                        │
│   - 段不可变 → 才能 OS 缓存友好、无锁并发              │
│   - 1 秒 refresh → 才能批量构建索引                    │
│   - 倒排索引 → 才能毫秒级全文检索                      │
│   - 分片路由 → 才能横向扩展到 PB 级                    │
│                                                      │
│  所有的优化、调优、踩坑，都是这个权衡的延伸             │
│                                                      │
└──────────────────────────────────────────────────────┘
```

---

## 十、明日预告
> Day2：**Mapping 深入与字段类型陷阱**
>
> + 动态映射的坑：字段爆炸
> + object vs nested：什么时候必须 nested
> + index template / dynamic template
> + dense_vector 字段（为后续 RAG 做铺垫）
> + 业务案例：保单文档的 Mapping 设计
>

