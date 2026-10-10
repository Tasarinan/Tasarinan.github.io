# 架构师学习 Day01：Elasticsearch 核心概念与倒排索引原理
> 2026-06-15 周一｜ES 专题第 1 天｜系统学习模式
>

本日目标：建立 ES 整体认知，搞清楚"它是什么、和 MySQL 的根本区别、为什么快、什么场景该用"。

---

## 一、Elasticsearch 是什么
### 1.1 一句话定义
Elasticsearch 是基于 **Apache Lucene** 构建的**分布式搜索与分析引擎**，核心能力是：

```latex
对海量文本数据建立倒排索引 → 提供毫秒级全文检索 + 多维聚合分析
```

### 1.2 它解决什么问题
MySQL 解决不了的三类问题：

```latex
1. 全文检索：LIKE '%关键词%' 不走索引、亿级数据扫表崩溃
2. 多维聚合：GROUP BY + JOIN 多字段任意组合统计，慢查询拖垮主库
3. 横向扩展：单库单表上限、分库分表方案重、跨片聚合困难
```

ES 不是"取代 MySQL"，而是**作为搜索/分析侧的专用存储**，与 MySQL 形成 **CQRS（读写分离架构）**：

```latex
写入：业务 → MySQL（事务、强一致）
                  ↓ Canal/Logstash/MQ 同步
读取：用户 → Elasticsearch（搜索、聚合、最终一致）
```

### 1.3 典型业务场景
| 场景 | 用 ES 的原因 |
| --- | --- |
| 商品搜索（标题/卖点/规格全文检索 + 多筛选） | 全文匹配 + 多条件聚合 |
| 日志分析（ELK 全家桶） | 海量写入 + 时间维度聚合 |
| 监控指标检索（APM、链路追踪） | 高维标签查询 |
| 用户行为分析（漏斗/留存/画像） | 多维聚合 + 即席查询 |
| 站内搜索 / 客服历史消息检索 | 中文分词 + 高亮 |
| RAG 向量检索（AI 知识库） | dense_vector + kNN 召回 |


---

## 二、核心概念与层级关系
### 2.1 七个必须刻在脑子里的概念
```latex
Cluster（集群）
  └── Node（节点）  多个 Node 组成 Cluster
        └── Index（索引）   逻辑上的一类数据集合，类似 MySQL 的 Database/Table
              └── Shard（分片）   Index 被切成多个 Shard，分散在不同 Node 上
                    └── Segment（段）   Shard 内部由多个 Segment 组成，是 Lucene 最底层文件
                          └── Document（文档）   一条 JSON 数据，类似 MySQL 的 Row
                                └── Field（字段）   文档里的 KV，类似 MySQL 的 Column
```

### 2.2 与 MySQL 的概念对照表
| MySQL | Elasticsearch | 说明 |
| --- | --- | --- |
| Database | Cluster / Index | ES 早期一个 Index 类比一个 Database，新版强调单 Index |
| Table | Index（7.x 之后） | 7.x 起去除 Type，一个 Index 一种文档 |
| Row | Document | 一条 JSON 数据，有唯一 `_id` |
| Column | Field | 字段，有类型（text/keyword/long/...） |
| Schema | Mapping | 字段类型与索引规则的定义 |
| SQL | Query DSL | ES 的查询语言（JSON 格式） |
| Index（B+树索引） | Inverted Index | ES 的索引是数据本身，每个字段都默认建倒排索引 |


> ⚠️ **概念坑**：MySQL 里 "Index" 是辅助加速结构（B+树）；ES 里 "Index" 是**数据集合本身**。两个 Index 含义完全不同。
>

### 2.3 Shard（分片）：ES 分布式的基石
#### 2.3.1 主分片（Primary Shard）
+ 创建 Index 时确定，**默认 1 个，建议根据数据量提前规划**
+ 一旦创建**主分片数不可变更**（必须 reindex 重建索引）
+ 数据写入时通过路由算法决定落到哪个主分片：

```latex
shard_num = hash(_routing) % primary_shard_count
默认 _routing = _id
```

#### 2.3.2 副本分片（Replica Shard）
+ 主分片的完整副本，**可以随时增减**
+ 作用：**高可用**（主分片宕机副本顶上） + **读扩展**（读请求可以走副本）
+ 副本必须分布在与主分片**不同的 Node** 上（同一节点上没意义，单点故障一起挂）

#### 2.3.3 一个例子
```latex
Index: insurance_policy
配置: 3 主 + 1 副本
集群: 3 个 Node

分布如下（P = Primary，R = Replica）：
Node1: P0  R1  R2
Node2: P1  R2  R0
Node3: P2  R0  R1

→ 任何一个 Node 挂掉，其他 Node 上的副本都能顶上提供完整数据
→ 总分片数 = 3 主 × (1 + 1 副本) = 6 个分片
```

### 2.4 Segment（段）：Lucene 的最小搜索单元
```latex
一个 Shard = 一个 Lucene Index = 多个 Segment
Segment 是磁盘上的一组不可变文件（.fdt/.tim/.tip/.doc 等）
```

关键特性：

```latex
1. 段一旦写入磁盘，内容不可变（Immutable）
2. 删除文档：标记 .del 文件，搜索时过滤
3. 更新文档：标记旧文档删除 + 写入新文档（不是真的更新）
4. 段会定期合并（Segment Merge）以减少段数量、释放删除空间
```

> ⚠️ **关键认知**：理解"段不可变"是理解 ES 写入流程、refresh、flush、merge 的前提。
>

---

## 三、倒排索引原理（核心中的核心）
### 3.1 正排索引 vs 倒排索引
#### 3.1.1 正排索引（Forward Index，传统数据库）
```latex
DocID  →  内容
1      →  "我爱北京天安门"
2      →  "天安门上太阳升"
3      →  "我爱我家"
```

要查"包含'天安门'的文档"：必须扫描每条记录 → O(N)

#### 3.1.2 倒排索引（Inverted Index，ES/Lucene）
先对内容做**分词**，然后反过来建索引：

```latex
词项（Term）   →  包含该词的文档列表（Posting List）
"我"          →  [1, 3]
"爱"          →  [1, 3]
"北京"        →  [1]
"天安门"       →  [1, 2]
"太阳"        →  [2]
"升"          →  [2]
"家"          →  [3]
```

要查"包含'天安门'的文档"：直接查词项表 → O(log N) 甚至 O(1)

### 3.2 倒排索引的完整结构
实际 ES 的倒排索引比上图复杂，包含三部分：

```latex
┌─────────────────────────────────────────────┐
│  Term Index（词项索引，FST 结构）             │
│   - 内存中，对所有 Term 建立前缀索引          │
│   - 根据查询词快速定位到 Term Dictionary       │
└───────────────┬─────────────────────────────┘
                ↓
┌─────────────────────────────────────────────┐
│  Term Dictionary（词项字典）                  │
│   - 磁盘上，存储所有 Term 及其元信息            │
│   - 包含 Term → Posting List 的指针            │
└───────────────┬─────────────────────────────┘
                ↓
┌─────────────────────────────────────────────┐
│  Posting List（倒排列表）                     │
│   - 磁盘上，存储每个 Term 对应的文档 ID 列表    │
│   - 还包含：词频(TF)、位置(Position)、偏移量    │
└─────────────────────────────────────────────┘
```

#### 3.2.1 FST（Finite State Transducer）
Term Index 用 FST 实现，是一种**压缩前缀树**：

```latex
优势：
- 比 HashMap 节省内存（共享前缀）
- 支持范围查询、前缀查询
- 内存占用极小（比传统 Trie 小一个数量级）

例如 ["cat", "car", "card", "care"] 的 FST：
  c → a → t
        ↘ r ─→ d
              ↘ e
```

#### 3.2.2 Posting List 的额外信息
每个词项的倒排列表不只存 DocID，还存：

```latex
DocID    : 文档ID（用于定位）
TF       : Term Frequency，词在文档中出现次数（用于打分）
Position : 词在文档中的位置（用于短语查询 match_phrase）
Offset   : 词在原文中的字符偏移（用于高亮显示）
Payload  : 自定义负载（用于 BM25 等打分算法）
```

### 3.3 例子：一句话的完整倒排过程
输入文档：

```json
PUT /demo/_doc/1
{ "content": "我爱北京天安门" }
```

#### 3.3.1 步骤 1：分词（Analyzer）
用 IK 分词器 `ik_max_word`：

```latex
"我爱北京天安门" → ["我", "爱", "北京", "天安门"]
```

#### 3.3.2 步骤 2：构建倒排
```latex
"我"     → [{docId:1, tf:1, pos:0, offset:[0,1]}]
"爱"     → [{docId:1, tf:1, pos:1, offset:[1,2]}]
"北京"   → [{docId:1, tf:1, pos:2, offset:[2,4]}]
"天安门" → [{docId:1, tf:1, pos:3, offset:[4,7]}]
```

#### 3.3.3 步骤 3：搜索时
```json
GET /demo/_search
{ "query": { "match": { "content": "天安门" } } }
```

执行流程：

```latex
1. 对查询词"天安门"分词 → ["天安门"]
2. 查 Term Index，定位到 Term Dictionary
3. 取出 Posting List → [{docId:1, ...}]
4. BM25 算法打分
5. 返回结果
```

全程 **O(log N)**，不需要扫描任何文档。

---

## 四、为什么 ES 比 MySQL 全文检索快几个数量级
### 4.1 MySQL `LIKE '%关键词%'` 的痛点
```sql
SELECT * FROM products WHERE name LIKE '%充电器%';
```

执行过程：

```latex
1. B+树索引对 LIKE '%xxx%' 不生效（左模糊不能用索引）
2. 必须全表扫描，逐行执行字符串匹配
3. 1000 万行数据：磁盘 IO + 字符串比对 → 秒级甚至分钟级
4. 多个关键词组合：CPU + IO 双重瓶颈
```

### 4.2 ES 的根本优势
| 对比项 | MySQL | ES |
| --- | --- | --- |
| 索引结构 | B+树（基于完整字段值） | 倒排索引（基于分词词项） |
| 查询方式 | 全表扫描 + 字符串比对 | Term 查找 + Posting List 求交集 |
| 时间复杂度 | O(N × 字符串长度) | O(log T)，T = 词项数 |
| 多字段查询 | 索引失效或多次回表 | 多个 Posting List 直接求并集/交集 |
| 相关性排序 | 不支持（只能 ORDER BY） | BM25/TF-IDF 内置打分 |


### 4.3 ES 不擅长什么（边界）
ES 不是银弹，下面这些场景**不要用 ES**：

```latex
1. 强一致事务   → 用 MySQL（ES 是近实时，无 ACID）
2. 高频精确更新 → 用 MySQL（ES 段不可变，更新成本高）
3. 复杂多表 JOIN → 用 MySQL（ES 不擅长 JOIN，nested 性能差）
4. 计数器/库存扣减 → 用 Redis/MySQL（ES 写入有 1 秒延迟）
5. 主键精确查询单条 → 用 Redis/MySQL（杀鸡用牛刀）
```

---

## 五、近实时（NRT）写入流程
### 5.1 一条文档从写入到可见的完整链路
```latex
客户端 PUT /index/_doc/1
   ↓
协调节点路由到主分片
   ↓
主分片接收
   ↓
┌────────────────────────────────┐
│ 1. 写入 In-memory Buffer         │  ← 内存，此时不可搜索
│    同时写入 translog（事务日志）  │  ← 磁盘，保证不丢
└────────────────────────────────┘
   ↓ 默认 1 秒
┌────────────────────────────────┐
│ 2. refresh：buffer 中数据生成    │
│    新的 segment（在 OS Cache）   │  ← 此刻开始可搜索！
└────────────────────────────────┘
   ↓ 持续累积
┌────────────────────────────────┐
│ 3. flush：OS Cache 中的 segment │
│    fsync 到磁盘，translog 清空   │  ← 数据真正落盘
└────────────────────────────────┘
   ↓ 后台
┌────────────────────────────────┐
│ 4. merge：多个小 segment 合并    │
│    为大 segment，删除 .del 标记  │
└────────────────────────────────┘
```

### 5.2 三个关键时间点
| 操作 | 默认间隔 | 作用 | 配置 |
| --- | --- | --- | --- |
| refresh | 1 秒 | 数据可被搜索（NRT 来源） | `index.refresh_interval` |
| flush | 30 分钟 / translog 满 512MB | 数据真正落盘 | `index.translog.flush_threshold_size` |
| merge | 后台触发 | 减少段数量，释放删除空间 | merge policy |


### 5.3 为什么是 1 秒延迟而不是实时
```latex
权衡点：
- 实时可见 = 每次写入都 fsync → 磁盘 IO 瓶颈，写入吞吐崩溃
- 1 秒延迟 = 批量 refresh 到 OS Cache → 写入吞吐高 10~100 倍

ES 的设计哲学：用极小的查询延迟换取极高的写入吞吐
```

### 5.4 业务场景的 NRT 应对
| 场景 | 1 秒延迟可接受？ | 应对策略 |
| --- | --- | --- |
| 用户提交保单后查"我的保单" | ❌ 用户感知差 | 列表查 MySQL，搜索查 ES |
| 商品搜索 | ✅ 可接受 | 默认配置即可 |
| IM 历史消息搜索 | ✅ 可接受 | 默认配置即可 |
| 日志分析 | ✅ 可接受 | refresh 拉长到 30s 提升写入 |
| 强一致："写后立刻读" | ❌ | `refresh=true` 强制刷新（性能差，慎用） |


---

## 六、Mapping（映射）：字段类型设计
### 6.1 text vs keyword：最高频的踩坑点
| 类型 | 是否分词 | 是否进倒排索引 | 适用场景 |
| --- | --- | --- | --- |
| `text` | ✅ 是 | ✅ 是（按词项） | 全文搜索（标题、内容、评论） |
| `keyword` | ❌ 否 | ✅ 是（按完整值） | 精确匹配、聚合、排序（状态、ID、标签） |


#### 6.1.1 同一字段两种行为：multi-fields
```json
PUT /products
{
  "mappings": {
    "properties": {
      "name": {
        "type": "text",                  // 主字段：全文搜索
        "analyzer": "ik_max_word",
        "fields": {
          "keyword": {                   // 子字段：聚合排序
            "type": "keyword",
            "ignore_above": 256
          }
        }
      }
    }
  }
}
```

使用：

```latex
搜索: name        → 走 text，分词后匹配
聚合: name.keyword → 走 keyword，按完整值聚合
```

### 6.2 业务字段选型表
| 字段 | 类型 | 理由 |
| --- | --- | --- |
| 保单号 `policy_no` | keyword | 精确匹配，不需要分词 |
| 商品名称 `product_name` | text + keyword | 全文搜索 + 聚合 |
| 用户手机号 `mobile` | keyword | 精确匹配，分词无意义 |
| 体检报告 `report_content` | text | 全文搜索（"高血压"等关键词） |
| 订单状态 `order_status` | keyword | 枚举值，过滤聚合 |
| 创建时间 `create_time` | date | 范围查询、时间聚合 |
| 价格 `price` | scaled_float | 数值范围、避免浮点误差 |
| 标签数组 `tags` | keyword | 数组也用 keyword |


### 6.3 常见类型清单
```latex
字符串：text、keyword
数值：long、integer、short、byte、double、float、scaled_float
日期：date（支持多种格式）
布尔：boolean
对象：object（扁平化）、nested（独立索引，支持嵌套查询）
特殊：geo_point（地理坐标）、ip、dense_vector（向量）
```

---

## 七、分片规划实战
### 7.1 主分片数怎么定
经验公式：

```latex
单分片建议大小：10GB ~ 50GB
单分片文档数：不超过 20 亿（Lucene 上限）
推荐：单分片 30GB 左右

主分片数 = 预估总数据量 / 单分片大小
```

### 7.2 案例：保险商城保单索引
```latex
现状：5000 万文档，单文档 8KB
未来：年增 1500 万，3 年规划 = 5000 + 4500 = 约 1 亿文档

总数据量 = 1 亿 × 8KB ≈ 800GB
副本因子 = 1（高可用）
实际占用 = 800GB × 2 = 1.6TB

主分片数 = 800GB / 30GB ≈ 27
建议规划：30 个主分片 + 1 副本
```

> 经验值：**宁可多分片，不要少分片**。主分片数后期不能改，多了可以缩。
>

### 7.3 副本数怎么定
```latex
1 副本：标准生产环境（2 副本起步推荐用于核心业务）
0 副本：日志类、可重建数据
2+ 副本：读多写少、要求高可用、资金类核心数据
```

### 7.4 节点数与分片关系
```latex
最小生产集群：3 个 Master-eligible Node + N 个 Data Node
单节点分片数：建议不超过 600 个
单节点堆内存：32GB（不能超过，超过会触发指针压缩失效）
```

---

## 八、写在 Day1 末尾：架构师视角的 ES 心智模型
```latex
╔══════════════════════════════════════════════════════════╗
║  ES 不是"另一个数据库"，而是                                ║
║  "面向搜索和聚合的、最终一致的、近实时的、横向扩展的存储"     ║
╠══════════════════════════════════════════════════════════╣
║  搞清楚四件事：                                            ║
║   1. 倒排索引 → 为什么搜索快                                ║
║   2. 段不可变 → 为什么写入是近实时                          ║
║   3. 分片设计 → 为什么能横向扩展                            ║
║   4. text/keyword → 为什么 Mapping 是核心                  ║
║                                                            ║
║  搞清楚这四件事，ES 就入门了。                              ║
╚══════════════════════════════════════════════════════════╝
```

---

## 九、本日学习任务清单
```latex
[ ] 用 Docker 起一个 ES 8.x 单节点（端口 9200）
[ ] 装 Kibana，能访问 Dev Tools
[ ] 装 IK 中文分词器插件
[ ] 用 _analyze API 测试 "我爱北京天安门" 的分词结果
[ ] 创建一个测试索引，写入 5 条数据，体验近实时
[ ] 用 GET _cat/indices?v 看索引信息
[ ] 用 GET _cat/shards?v 看分片分布
```

> 明天 Day2：**Mapping 深入与字段类型陷阱（含 nested、object、动态映射、index template）**
>

