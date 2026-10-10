# Day03：ES查询DSL与聚合分析（练习整理）
> 2026-06-17 周三｜ES专题第3天

本日目标：掌握ES的查询语言Query DSL，从简单的精确查询到复杂的全文检索，再到多维聚合分析。

---

## 题目一：全文检索 vs 精确查询 — match vs term

### 场景

你有一个保险产品索引，mapping如下：

```json
PUT /insurance_product
{
  "mappings": {
    "properties": {
      "product_name": { "type": "text", "analyzer": "ik_max_word" },
      "product_code": { "type": "keyword" },
      "category": { "type": "keyword" },
      "price": { "type": "scaled_float", "scaling_factor": 100 }
    }
  }
}
```

写入数据：

```json
PUT /insurance_product/_doc/1
{
  "product_name": "重疾险 - 终身守护版",
  "product_code": "INS-001",
  "category": "健康险",
  "price": 2999.00
}

PUT /insurance_product/_doc/2
{
  "product_name": "重疾险 - 定期版",
  "product_code": "INS-002",
  "category": "健康险",
  "price": 999.00
}
```

请回答：
1. 查询产品名称包含"重疾险"的文档，用match还是term？
2. 查询产品编码是"INS-001"的文档，用match还是term？
3. match和term的本质区别是什么？
4. text字段可以用term查询吗？会有什么问题？

---

## 答案

### 1. 全文检索用 match

```json
GET /insurance_product/_search
{
  "query": {
    "match": {
      "product_name": "重疾险"
    }
  }
}
```

### 2. 精确匹配用 term

```json
GET /insurance_product/_search
{
  "query": {
    "term": {
      "product_code": "INS-001"
    }
  }
}
```

### 3. match vs term 本质区别

```latex
match（全文检索）：
  步骤1：对查询词做分词（用和索引时相同的analyzer）
  步骤2：用分词后的词项去倒排索引里匹配
  步骤3：返回匹配的文档，按BM25打分排序

  例子：查询"重疾险"
    查询词分词 → ["重疾", "险"]
    匹配包含"重疾"或"险"的文档

term（精确匹配）：
  步骤1：不对查询词做分词，直接用完整值去匹配
  步骤2：去倒排索引里找完全相等的词项
  步骤3：返回匹配的文档，不打分（filter context）

  例子：查询"INS-001"
    直接找完整值等于"INS-001"的词项
```

### 4. text字段用term查询的问题

```latex
问题：
  text字段在索引时会被分词
  term查询用完整值去匹配分词后的词项
  → 很难匹配到！

例子：
  文档product_name字段值："重疾险 - 终身守护版"
  索引时分词结果：["重疾", "险", "终身", "守护", "版"]

  用term查询"重疾险"：
    → 倒排索引里没有"重疾险"这个词项
    → 只有"重疾"、"险"等
    → 查询不到结果！

结论：
  text字段 → 用match查询
  keyword字段 → 用term查询
```

### 5. match的变体：match_phrase

```json
GET /insurance_product/_search
{
  "query": {
    "match_phrase": {
      "product_name": "重疾险 终身"
    }
  }
}
```

```latex
match_phrase要求：
  1. 查询词分词后的所有词项都在文档中出现
  2. 词项的顺序必须和查询时一致
  3. 词项之间的位置不能超过slop（默认0）

  例子：
    查询"重疾险 终身" → 匹配"重疾险 - 终身守护版"
    查询"终身 重疾险" → 不匹配（顺序反了）
```

### 与架构师水平的差距

| 层次 | 回答 |
|------|------|
| 开发 | 知道match查text，term查keyword |
| 高级开发 | 理解match分词的过程，知道match_phrase |
| 架构师 | 能讲清楚"索引时分词"和"查询时分词"的关系，理解为什么text字段用term查不到，能根据场景选择match/match_phrase/match_bool_prefix |

**补足方向**：查询时先想清楚"这个字段在索引时是怎么存的"，再选择对应的查询方式。

---

## 题目二：复合查询 — bool查询如何组合多个条件

### 场景

你需要查询保险产品，要求：
1. 产品名称包含"重疾险"或"医疗险"
2. 类别必须是"健康险"
3. 价格在1000-5000之间
4. 不能是"定期版"

请回答：
1. bool查询的四个子句（must/should/must_not/filter）分别是什么意思？
2. 上面的需求如何用bool查询实现？
3. must和filter有什么区别？
4. should如何控制至少匹配几个？

---

## 答案

### 1. bool查询的四个子句

```latex
must：
  → 必须匹配，相当于逻辑AND
  → 会参与相关性打分

filter：
  → 必须匹配，相当于逻辑AND
  → 不参与打分，只做过滤
  → 会被缓存，性能更好

should：
  → 至少匹配一个，相当于逻辑OR
  → 会参与相关性打分
  → 可以用minimum_should_match控制匹配数量

must_not：
  → 必须不匹配，相当于逻辑NOT
  → 不参与打分，只做过滤
```

### 2. 实现需求的bool查询

```json
GET /insurance_product/_search
{
  "query": {
    "bool": {
      "must": [
        {
          "match": {
            "product_name": {
              "query": "重疾险 医疗险",
              "operator": "or"
            }
          }
        }
      ],
      "filter": [
        { "term": { "category": "健康险" } },
        {
          "range": {
            "price": {
              "gte": 1000,
              "lte": 5000
            }
          }
        }
      ],
      "must_not": [
        { "match": { "product_name": "定期版" } }
      ]
    }
  }
}
```

### 3. must vs filter 的核心区别

```latex
性能上的区别：
  filter：
    - 不计算相关性分数
    - 结果会被缓存（bitset）
    - 性能比must好很多

  must：
    - 计算相关性分数
    - 结果不缓存
    - 性能比filter差

什么时候用哪个？
  需要"匹配度排序" → 用must
  只是"过滤条件" → 用filter

例子：
  "产品名称包含重疾险" → must（需要打分排序）
  "类别是健康险" → filter（只是过滤，不需要打分）
  "价格在1000-5000" → filter（只是过滤）
```

### 4. minimum_should_match 的用法

```json
GET /insurance_product/_search
{
  "query": {
    "bool": {
      "should": [
        { "match": { "product_name": "重疾险" } },
        { "match": { "product_name": "医疗险" } },
        { "match": { "product_name": "意外险" } }
      ],
      "minimum_should_match": 2  // 至少匹配2个
    }
  }
}
```

```latex
minimum_should_match的取值：
  数字：直接指定数量，如 2
  百分比：如 "75%"，匹配3/4
  组合：如 "2<75%"，小于等于2个时全匹配，大于2个时匹配75%

注意：
  如果bool查询里只有should，没有must/filter
  → minimum_should_match默认是1（至少匹配一个）
  如果bool查询里既有should又有must/filter
  → minimum_should_match默认是0（可以不匹配）
```

### 5. 嵌套bool查询

复杂逻辑可以嵌套bool：

```json
GET /insurance_product/_search
{
  "query": {
    "bool": {
      "must": [
        { "term": { "category": "健康险" } },
        {
          "bool": {
            "should": [
              { "match": { "product_name": "重疾险" } },
              { "match": { "product_name": "医疗险" } }
            ]
          }
        }
      ]
    }
  }
}
```

### 与架构师水平的差距

| 层次 | 回答 |
|------|------|
| 开发 | 会写简单的bool查询，知道must/should |
| 高级开发 | 理解filter的缓存机制，会用minimum_should_match |
| 架构师 | 能设计高效的查询结构，把过滤条件都放filter里缓存，只把需要打分的条件放must里，会用嵌套bool处理复杂逻辑，知道如何优化查询性能 |

**补足方向**：写bool查询时，先区分"哪些是过滤条件"、"哪些是打分条件"，过滤条件都放filter，打分条件放must/should。

---

## 题目三：聚合分析 — 统计各分类的保费分布

### 场景

你需要对保险产品做统计分析：
1. 按类别分组，统计每个类别的产品数量
2. 在每个类别下，统计平均价格、最高价格、最低价格
3. 在每个类别下，按价格区间分段统计（0-1000，1000-3000，3000-5000，5000+）

请回答：
1. ES聚合的三种基本类型（Bucket/Metric/Pipeline）分别是什么？
2. 上面的需求如何用聚合DSL实现？
3. 聚合和查询如何配合？
4. 聚合有哪些性能优化建议？

---

## 答案

### 1. 聚合的三种基本类型

```latex
Bucket（桶聚合）：
  → 按条件把文档分到不同的"桶"里
  → 类似SQL的GROUP BY
  → 例子：terms、range、date_histogram

Metric（指标聚合）：
  → 对一个桶里的文档做统计计算
  → 类似SQL的COUNT/AVG/SUM/MAX/MIN
  → 例子：avg、sum、max、min、stats、cardinality

Pipeline（管道聚合）：
  → 对其他聚合的结果再做聚合
  → 例子：derivative（导数）、moving_avg（移动平均）
```

### 2. 实现需求的聚合DSL

```json
GET /insurance_product/_search
{
  "size": 0,  // 不返回文档，只返回聚合结果
  "aggs": {
    "by_category": {
      "terms": { "field": "category" },  // 按类别分桶
      "aggs": {
        "price_stats": {
          "stats": { "field": "price" }  // 价格统计（avg/max/min）
        },
        "price_range": {
          "range": {
            "field": "price",
            "ranges": [
              { "to": 1000 },
              { "from": 1000, "to": 3000 },
              { "from": 3000, "to": 5000 },
              { "from": 5000 }
            ]
          }
        }
      }
    }
  }
}
```

### 3. 聚合结果解读

```json
{
  "aggregations": {
    "by_category": {
      "buckets": [
        {
          "key": "健康险",
          "doc_count": 100,  // 100个产品
          "price_stats": {
            "count": 100,
            "avg": 2500.0,
            "max": 10000.0,
            "min": 100.0
          },
          "price_range": {
            "buckets": [
              { "key": "*-1000.0", "doc_count": 30 },
              { "key": "1000.0-3000.0", "doc_count": 50 },
              { "key": "3000.0-5000.0", "doc_count": 15 },
              { "key": "5000.0-*", "doc_count": 5 }
            ]
          }
        }
      ]
    }
  }
}
```

### 4. 查询 + 聚合配合

先过滤再聚合，减少参与聚合的数据量：

```json
GET /insurance_product/_search
{
  "size": 0,
  "query": {
    "bool": {
      "filter": [
        { "range": { "create_time": { "gte": "2026-01-01" } } }
      ]
    }
  },
  "aggs": {
    "by_category": {
      "terms": { "field": "category" }
    }
  }
}
```

### 5. 聚合性能优化建议

```latex
1. 先用query过滤：
   → 只对需要的文档做聚合
   → 不要对全量数据做聚合

2. 用keyword字段做terms聚合：
   → text字段聚合性能差
   → 需要聚合的字段用keyword

3. 控制聚合层级：
   → 嵌套层级越深，性能越差
   → 一般不超过3层

4. 用size限制桶数量：
   → terms聚合默认返回10个桶
   → 可以用size指定更多，但不要超过1000

5. 开启聚合缓存：
   → 相同的聚合请求会被缓存
   → 查询条件不变时，直接返回缓存结果
```

### 与架构师水平的差距

| 层次 | 回答 |
|------|------|
| 开发 | 会写简单的terms聚合 |
| 高级开发 | 会用嵌套聚合，理解Bucket/Metric的区别 |
| 架构师 | 能设计高效的聚合查询，先过滤再聚合，用keyword字段聚合，控制聚合层级，开启聚合缓存，理解聚合的内存消耗和性能瓶颈 |

**补足方向**：聚合查询永远先想"能不能先过滤"，减少参与聚合的数据量比什么优化都有效。

---

## 题目四：分页与排序 — 深分页问题怎么解

### 场景

你需要展示保险产品列表，每页20条：
1. 第一页：按价格降序排列
2. 第100页：如何高效获取？
3. 用户翻到第1000页：会有什么问题？

请回答：
1. ES的from/size分页有什么问题？
2. search_after如何解决深分页？
3. scroll和search_after的区别是什么？
4. 什么时候用哪种分页方式？

---

## 答案

### 1. from/size的深分页问题

```json
GET /insurance_product/_search
{
  "from": 0,
  "size": 20,
  "sort": [{ "price": "desc" }]
}
```

```latex
from/size的问题：
  from=10000, size=20时：
    → 每个分片都要取出前10020条
    → 协调节点汇总所有分片的结果，排序后取第10000-10020条
    → 消耗大量内存和CPU

  默认限制：
    → from + size 不能超过 10000
    → 超过会报错
```

### 2. search_after 解决深分页

```json
// 第一页
GET /insurance_product/_search
{
  "size": 20,
  "sort": [
    { "price": "desc" },
    { "_id": "asc" }  // 一定要加唯一字段，避免相同值问题
  ]
}

// 第二页，用上一页最后一条的sort值作为search_after
GET /insurance_product/_search
{
  "size": 20,
  "search_after": [2999.0, "doc_id_20"],
  "sort": [
    { "price": "desc" },
    { "_id": "asc" }
  ]
}
```

```latex
search_after的原理：
  → 记住上一页最后一条的排序值
  → 下次查询从这个位置往后取
  → 每个分片只需要从这个位置往后取size条
  → 内存消耗小，性能高

注意：
  → search_after只能往后翻，不能往前翻
  → 适合"下一页"这种场景，不适合跳页
```

### 3. scroll 适合大规模数据导出

```json
// 初始化scroll，返回第一批数据和scroll_id
GET /insurance_product/_search?scroll=1m
{
  "size": 100,
  "sort": ["_doc"]  // 按文档顺序，最快
}

// 用scroll_id继续获取下一批
POST /_search/scroll
{
  "scroll": "1m",
  "scroll_id": "DnF1ZXJ5VGhlbkZldGNoBQAAAAAAAC8xFlk1bU9i..."
}
```

```latex
scroll的特点：
  → 对查询结果做一个"快照"
  → 保留一段时间（1m = 1分钟）
  → 适合批量导出数据
  → 不适合实时用户分页（快照是历史的）
```

### 4. 分页方式选型

| 场景 | 推荐方式 | 理由 |
|------|---------|------|
| 前100页，可跳页 | from/size | 简单，灵活 |
| 深分页，只翻下一页 | search_after | 性能好，不占内存 |
| 批量导出数据 | scroll | 可以遍历全量数据 |

### 与架构师水平的差距

| 层次 | 回答 |
|------|------|
| 开发 | 只会用from/size分页 |
| 高级开发 | 知道search_after解决深分页问题 |
| 架构师 | 能根据场景选择合适的分页方式，理解三种分页方式的原理和性能差异，知道search_after要加唯一字段作为排序的 tie-breaker |

**补足方向**：设计分页功能时，先想清楚"用户会不会翻到100页之后"，如果不会，from/size就够；如果会，用search_after。

---

## 题目五：相关性打分 — BM25算法原理

### 场景

你搜索"重疾险 终身"，返回结果的顺序是由什么决定的？

请回答：
1. BM25算法的核心思想是什么？
2. TF（词频）和IDF（逆文档频率）分别是什么？
3. 如何调整字段的权重？
4. 什么时候需要干预相关性打分？

---

## 答案

### 1. BM25算法核心思想

```latex
BM25打分公式（简化版）：
  score = sum( IDF(t) * (TF(t) * (k1 + 1)) / (TF(t) + k1 * (1 - b + b * (docLen / avgDocLen))) )

核心思想：
  1. 词频（TF）：词在文档中出现越多，相关性越高
  2. 逆文档频率（IDF）：词在所有文档中出现越少，越稀有，权重越高
  3. 文档长度归一化：长文档词频容易高，做一定惩罚
  4. k1和b是可调参数

直观理解：
  搜索"重疾险 终身"
  → "重疾险"在文档中出现了3次，"终身"出现了2次 → TF高，加分
  → "重疾险"在1000个文档中出现过，"终身"在10000个文档中出现过
  → "重疾险"更稀有 → IDF高，权重大
```

### 2. TF和IDF

```latex
TF（Term Frequency，词频）：
  → 词在文档中出现的次数
  → 次数越多，相关性越高
  → 但不是线性增长，有饱和（k1参数控制）

IDF（Inverse Document Frequency，逆文档频率）：
  → log( (总文档数 - 包含该词的文档数 + 0.5) / (包含该词的文档数 + 0.5) )
  → 词越稀有，IDF越大，权重越高
  → "的"这种停用词在所有文档中都有，IDF接近0，几乎不影响打分
```

### 3. 调整字段权重

```json
GET /insurance_product/_search
{
  "query": {
    "bool": {
      "should": [
        {
          "match": {
            "product_name": {
              "query": "重疾险",
              "boost": 2.0  // 字段权重2倍
            }
          }
        },
        {
          "match": {
            "description": {
              "query": "重疾险",
              "boost": 1.0  // 字段权重1倍
            }
          }
        }
      ]
    }
  }
}
```

### 4. 干预相关性打分的场景

```latex
场景1：某些字段更重要
  → 产品名称比描述更重要 → product_name boost设为2

场景2：某些文档需要置顶
  → 用function_score给指定文档加权重
  → 或用constant_score + filter

场景3：需要按业务规则排序，而不是相关性
  → 用sort，不看_score
  → 如按价格、销量、创建时间排序
```

### 与架构师水平的差距

| 层次 | 回答 |
|------|------|
| 开发 | 知道ES会按相关性排序，但不知道原理 |
| 高级开发 | 理解TF-IDF的概念，知道可以用boost调整权重 |
| 架构师 | 理解BM25算法原理，知道什么时候该干预打分，什么时候该用业务排序，能通过调整mapping和查询来优化相关性 |

**补足方向**：先问用户"搜索结果怎么排序合理"，如果是"最相关的放前面"，用BM25；如果是"最新的放前面"，用sort按时间排。

---

## Day03核心总结

```latex
Day03主线：ES查询不是写SQL，而是理解"倒排索引上如何做查找"。

  match vs term：
    match对查询词分词 → 全文检索
    term不用分词 → 精确匹配
    text用match，keyword用term

  bool查询：
    must：必须匹配，参与打分
    filter：必须匹配，不打分，可缓存
    should：至少匹配一个
    must_not：必须不匹配
    优化：过滤条件都放filter，只把需要打分的放must

  聚合分析：
    Bucket：分桶（GROUP BY）
    Metric：统计（COUNT/AVG）
    Pipeline：聚合结果再聚合
    优化：先过滤再聚合，用keyword字段聚合

  分页：
    from/size：前100页，灵活但深分页性能差
    search_after：深分页，性能好但只能往后翻
    scroll：批量导出数据

  相关性打分：
    BM25基于TF-IDF
    词频越高、词越稀有 → 打分越高
    可以用boost调整字段权重
```

---

*日期：2026-06-17 | 2026年06月第3周 Day3 | ES查询DSL与聚合分析*