# ES 进阶专题：生产实战与面试高频考点

> 2026年06月第3周 补充专题 | 在 Day01-Day07 基础上的进阶深化

## 前言

本周 Day01-Day07 覆盖了 ES 的主干知识体系：倒排索引、Mapping、DSL、性能优化、业务集成、搜索中台、写入链路。但生产环境和面试中还有不少高频考点没深入展开，本专题把这些内容整合成一份进阶文档，按"出现频率 + 实战价值"组织。

```text
第一章：中文分词与相关性调优
第二章：向量检索与 RAG（2026 必问）
第三章：生产故障案例集（架构师面试最爱）
第四章：时序数据三件套（Data Stream + ILM + Snapshot）
第五章：JVM 调优与慢查询定位
第六章：ES 8.x 新特性与生态选型
第七章：进阶架构题（容量规划、跨机房、多租户、reindex）
```

---

# 第一章：中文分词与相关性调优

## 1.1 中文分词器全景

### 1.1.1 ES 内置分词器的问题

```text
Standard Analyzer（默认）：
  - 对中文按字切分
  - "我爱北京" → ["我", "爱", "北", "京"]
  - 搜"北京"能命中（因为"北"和"京"都在）
  - 但搜"我爱"也会命中（误匹配）
  - 完全不理解中文语义

结论：中文场景必须装 IK 或其他中文分词器
```

### 1.1.2 IK 分词器两种模式

```text
ik_max_word（最细粒度，索引用）：
  "中华人民共和国国歌" →
  ["中华人民共和国", "中华人民", "中华", "华人", "人民共和国",
   "人民", "共和国", "共和", "国歌", "国"]

  → 召回率高（多分词，多命中）
  → 索引体积大
  → 用于索引时 analyzer

ik_smart（智能切分，查询用）：
  "中华人民共和国国歌" →
  ["中华人民共和国", "国歌"]

  → 精确度高（少分词，少误匹配）
  → 用于搜索时 search_analyzer

最佳实践：
  索引用 ik_max_word，查询用 ik_smart
  → 召回率和精确度兼顾
```

```json
PUT /products
{
  "settings": {
    "analysis": {
      "analyzer": {
        "ik_index_analyzer": {
          "type": "custom",
          "tokenizer": "ik_max_word",
          "filter": ["lowercase"]
        },
        "ik_search_analyzer": {
          "type": "custom",
          "tokenizer": "ik_smart",
          "filter": ["lowercase"]
        }
      }
    }
  },
  "mappings": {
    "properties": {
      "title": {
        "type": "text",
        "analyzer": "ik_index_analyzer",
        "search_analyzer": "ik_search_analyzer"
      }
    }
  }
}
```

### 1.1.3 IK 词典热更新

```text
问题：
  - 新词（"yyds"、"绝绝子"、"显眼包"）默认分不出来
  - 改词典后必须 reindex 重建索引（段不可变）
  - 生产环境不能频繁 reindex

IK 热更新方案：
  1. 远程词典模式
     - IK 配置远程 HTTP 词典接口
     - IK 定时拉取（默认 60s）
     - 词典变更后自动生效（新写入用新词典）
     - 旧数据仍用旧词典（需 reindex 才能完全生效）

  2. 配置示例（IK Analyzer.cfg.xml）：
     <entry key="remote_ext_dict">http://dict.company.com/dict.txt</entry>
     <entry key="remote_ext_stopwords">http://dict.company.com/stop.txt</entry>

  3. 词典接口返回：
     - HTTP 200
     - Last-Modified 或 ETag 头（IK 据此判断是否更新）
     - Body 每行一个词

注意：
  - 热更新只对新写入生效
  - 旧数据要重新分词必须 reindex
  - 关键词变更要走变更流程，不能随意加
```

### 1.1.4 拼音分词

```text
场景：搜索"zhongguo"能搜到"中国"

pinyin 分词器（pinyin plugin）：
  "中国" → ["zhong", "guo", "zhongguo", "zg", "中国"]

配置：
  "analyzer": {
    "pinyin_analyzer": {
      "type": "custom",
      "tokenizer": "pinyin",
      "tokenizer_args": {
        "keep_first_letter": true,      // 保留首字母 "zg"
        "keep_full_pinyin": true,       // 保留全拼 "zhongguo"
        "keep_original": true           // 保留原文 "中国"
      }
    }
  }

最佳实践：
  - 用 multi-fields，主字段用 IK，子字段用拼音
  - 查询时按需选择走哪个字段
```

### 1.1.5 同义词词典

```text
场景：搜"番茄"能命中"西红柿"

配置同义词过滤器：
  "analysis": {
    "filter": {
      "synonym_filter": {
        "type": "synonym",
        "synonyms": [
          "番茄,西红柿",
          "手机,移动电话",
          "重疾险,重大疾病险"
        ]
      }
    },
    "analyzer": {
      "synonym_analyzer": {
        "tokenizer": "ik_max_word",
        "filter": ["lowercase", "synonym_filter"]
      }
    }
  }

两种同义词规则：
  "番茄,西红柿"          → 双向同义词（索引和查询都展开）
  "番茄 => 西红柿"        → 单向（查询时番茄→西红柿，索引不展开）

陷阱：
  - 同义词在索引时展开 → 索引体积膨胀
  - 同义词在查询时展开 → 查询性能下降
  - 推荐：查询时展开（同义词变更不需要 reindex）
  - 同义词变更需要 reload analyzer（_reload_search_analyzers API，ES 7.3+）
```

## 1.2 相关性调优

### 1.2.1 为什么需要干预相关性

```text
默认 BM25 排序的问题：
  - 业务上"销量高的应该排前面"，BM25 不知道
  - "赞助商品应该置顶"，BM25 不知道
  - "新品应该有加权"，BM25 不知道
  - "用户偏好商品应该靠前"，BM25 不知道

需要业务侧干预相关性排序
```

### 1.2.2 function_score 详解

```text
function_score：在 BM25 打分基础上，叠加函数调整

核心结构：
  query：基础查询（产生 _score）
  functions：多个打分函数
    - weight：固定权重
    - field_value_factor：基于字段值
    - decay_function：衰减函数（linear/exp/gauss）
    - random_score：随机打分
    - script_score：脚本
  score_mode：函数如何组合（multiply/sum/avg/max/first）
  boost_mode：函数结果与 _score 如何组合（multiply/sum/avg/max/replace）
```

```json
// 案例：商品搜索，销量加权 + 新品加权
GET /products/_search
{
  "query": {
    "function_score": {
      "query": { "match": { "title": "重疾险" }},
      "functions": [
        {
          "field_value_factor": {
            "field": "sales_count",
            "modifier": "log1p",
            "factor": 2,
            "missing": 1
          }
        },
        {
          "exp": {
            "create_time": {
              "origin": "now",
              "scale": "30d",
              "decay": 0.5
            }
          }
        },
        {
          "filter": { "term": { "is_sponsored": true }},
          "weight": 3
        }
      ],
      "score_mode": "multiply",
      "boost_mode": "multiply"
    }
  }
}
```

```text
字段解释：
  field_value_factor：销量越大分越高，log1p 防止销量爆炸
  exp 衰减：越新的商品分越高，30 天衰减一半
  filter + weight：赞助商品 3 倍加权
  score_mode=multiply：三个函数结果相乘
  boost_mode=multiply：函数结果 × BM25 _score
```

### 1.2.3 rescore 重排

```text
function_score 的问题：
  - 在全量匹配文档上计算函数，慢
  - 复杂函数（脚本）尤其慢

rescore 方案：
  - 第一阶段：用简单 query 快速召回 top N（如 500）
  - 第二阶段：在 top N 上用复杂函数重排，取 top 20

适用场景：
  - 向量检索 + 业务重排
  - BM25 召回 + 业务规则重排
```

```json
GET /products/_search
{
  "query": { "match": { "title": "重疾险" }},
  "rescore": [
    {
      "window_size": 500,
      "query": {
        "rescore_query": {
          "function_score": {
            "query": { "match_all": {}},
            "functions": [
              { "field_value_factor": { "field": "sales_count", "modifier": "log1p" }}
            ]
          }
        },
        "query_weight": 0.3,
        "rescore_query_weight": 0.7
      }
    }
  ],
  "size": 20
}
```

### 1.2.4 constant_score 与 boost

```text
constant_score：
  - 把 filter 包装成不打分的查询
  - _score 固定为 1（或 boost 值）
  - 用于"只过滤不打分"的场景

boost：
  - 字段级 boost：product_name^2 让该字段权重翻倍
  - 查询级 boost：整个 bool 查询加权

陷阱：
  - boost 不是线性放大（boost=10 不等于 10 倍排序效果）
  - boost 是 _score 的乘数，_score 本身是非线性的
  - 业务上想"硬置顶"，用 function_score + filter + weight
```

## 1.3 BM25 参数调优

### 1.3.1 BM25 公式回顾

```text
score = IDF(t) × ( TF(t) × (k1+1) ) / ( TF(t) + k1 × (1 - b + b × |D|/avgDl) )

参数：
  k1：控制 TF 饱和速度（默认 1.2）
  b：控制文档长度归一化强度（默认 0.75）
  |D|：当前文档长度
  avgDl：平均文档长度
```

### 1.3.2 k1 调优

```text
k1 越大：TF 越不容易饱和，词频影响越大
k1 越小：TF 越容易饱和，词频影响越小

默认 k1=1.2：
  - 大部分场景够用
  - 词频到 3-5 次就接近饱和

调优场景：
  - 长文档（如文章正文）：k1 调大到 1.5-2.0
    → 词频更有区分度
  - 短文档（如商品标题）：k1 调小到 0.5-1.0
    → 防止词频过度放大
```

### 1.3.3 b 调优

```text
b 控制文档长度归一化：
  b=1：完全归一化（长文档被惩罚）
  b=0：不归一化（长文档不惩罚）

默认 b=0.75：
  - 适度惩罚长文档

调优场景：
  - 文档长度差异大（标题 vs 正文）：b 保持 0.75
  - 文档长度均匀：b 调小到 0.3-0.5
  - 不希望长文档被惩罚：b=0

如何配置：
  "settings": {
    "index": {
      "similarity": {
        "custom_bm25": {
          "type": "BM25",
          "k1": 1.5,
          "b": 0.5
        }
      }
    }
  },
  "mappings": {
    "properties": {
      "title": {
        "type": "text",
        "similarity": "custom_bm25"
      }
    }
  }
```

---

# 第二章：向量检索与 RAG

## 2.1 为什么 ES 也要做向量检索

```text
传统全文检索（BM25）的局限：
  - 关键词匹配，不理解语义
  - "苹果手机" 和 "iPhone" 关键词不同，BM25 匹配不到
  - 同义词词典能缓解，但维护成本高

向量检索（Dense Vector）：
  - 文本通过 Embedding 模型转为向量（如 768 维）
  - 语义相近的文本，向量距离近
  - "苹果手机" 和 "iPhone" 向量距离近，能匹配

ES 8.x 原生支持向量检索：
  - dense_vector 字段类型
  - kNN 查询（HNSW 算法）
  - 混合检索（BM25 + 向量）
```

## 2.2 dense_vector 字段与 HNSW

### 2.2.1 Mapping 定义

```json
PUT /knowledge_base
{
  "mappings": {
    "properties": {
      "content": { "type": "text", "analyzer": "ik_max_word" },
      "embedding": {
        "type": "dense_vector",
        "dims": 768,
        "index": true,
        "similarity": "cosine",
        "index_options": {
          "type": "hnsw",
          "m": 16,
          "ef_construction": 100
        }
      }
    }
  }
}
```

```text
关键字段：
  dims：向量维度（必须和 Embedding 模型一致，如 768/1024/1536）
  index: true：开启 HNSW 索引（8.0+ 默认开启）
  similarity：距离度量
    - cosine（余弦相似度，最常用）
    - dot_product（点积，归一化向量用）
    - l2_norm（欧氏距离）
  m：HNSW 图的连接数（默认 16，越大越准越占内存）
  ef_construction：构建时探索深度（默认 100，越大构建越慢但召回越高）
```

### 2.2.2 HNSW 算法原理

```text
HNSW（Hierarchical Navigable Small World）：
  - 分层图结构
  - 上层稀疏（快速跳转），下层稠密（精确查找）
  - 查询时从上层开始，逐层下沉

查询过程：
  1. 从最上层任一节点出发
  2. 贪心搜索最近的邻居
  3. 直到该层局部最近
  4. 下沉到下一层，重复
  5. 最底层找到 top-k 最近邻

查询参数：
  num_candidates：候选池大小（默认跟 k 走）
  → 越大召回越高但越慢
  → 推荐 num_candidates = k × 10

特点：
  - 近似最近邻（ANN），不精确
  - 召回率 95%+ 时性能远好于精确 KNN
  - 内存占用大（图结构在堆外）
```

### 2.2.3 kNN 查询

```json
GET /knowledge_base/_search
{
  "knn": {
    "field": "embedding",
    "query_vector": [0.1, 0.2, ...],  // 768 维
    "k": 10,
    "num_candidates": 100
  },
  "_source": ["content"]
}
```

```text
ES 8.0+ 推荐用 query_vector_builder（避免大 JSON）：
  "knn": {
    "field": "embedding",
    "query_vector_builder": {
      "text_embedding": {
        "model_id": "my-embedding-model",
        "model_text": "苹果手机"
      }
    },
    "k": 10,
    "num_candidates": 100
  }
  → ES 内部调用 Embedding 模型，不用客户端自己算向量
```

## 2.3 混合检索（Hybrid Search）

### 2.3.1 为什么需要混合

```text
纯向量检索的问题：
  - 关键词精确匹配场景不如 BM25
  - "iPhone 15 Pro" 这种具体型号，向量可能召回"iPhone 14"
  - 长尾词、专有名词向量可能没见过

纯 BM25 的问题：
  - 语义理解弱
  - 同义词、近义词难召回

混合检索：
  - BM25 召回关键词精确匹配
  - 向量召回语义相近
  - 两者结果融合，取长补短
```

### 2.3.2 RRF 融合算法

```text
RRF（Reciprocal Rank Fusion，倒数排名融合）：
  - 不依赖原始分数，只看排名
  - 公式：score(d) = Σ 1 / (k + rank_i(d))
  - k 通常取 60

为什么用 RRF：
  - BM25 分数和向量距离尺度不同，不能直接相加
  - RRF 只看排名，尺度无关
  - 简单且效果好

ES 8.8+ 原生支持 RRF：
```

```json
GET /knowledge_base/_search
{
  "size": 10,
  "retriever": {
    "rrf": {
      "retrievers": [
        {
          "standard": {
            "query": { "match": { "content": "苹果手机" }}
          }
        },
        {
          "knn": {
            "field": "embedding",
            "query_vector_builder": {
              "text_embedding": {
                "model_id": "my-model",
                "model_text": "苹果手机"
              }
            },
            "k": 50,
            "num_candidates": 100
          }
        }
      ],
      "rank_window_size": 50,
      "rank_constant": 60
    }
  }
}
```

### 2.3.3 加权融合

```text
如果不想用 RRF，可以用 function_score 手动加权：

  BM25 召回 top 50
  向量召回 top 50
  合并去重
  score = 0.4 × normalize(bm25_score) + 0.6 × normalize(vector_score)

normalize：归一化到 [0,1]
  → bm25_score / max_bm25_score
  → (1 - vector_distance / 2)  // cosine 距离转相似度
```

## 2.4 RAG 架构中的 ES

### 2.4.1 典型 RAG 流程

```text
用户提问
   ↓
Embedding 模型把问题转向量
   ↓
ES kNN 检索 top-k 相关文档
   ↓
（可选）BM25 混合检索补充
   ↓
（可选）rerank 模型重排
   ↓
拼接 prompt：问题 + 检索到的文档
   ↓
LLM 生成回答
   ↓
返回用户
```

### 2.4.2 ES 在 RAG 中的优势

```text
vs 专用向量库（Milvus / Pinecone / Weaviate）：

ES 优势：
  ① 混合检索原生支持（BM25 + 向量 + RRF）
  ② 过滤能力强（向量库的元数据过滤普遍弱）
  ③ 与现有业务数据同库，不需要再维护一套
  ④ 聚合能力（向量库几乎没有聚合）
  ⑤ 生态成熟（监控、ILM、备份）

ES 劣势：
  ① 向量检索性能略逊于专用库（HNSW 实现没 Milvus 极致）
  ② 内存占用大（向量字段占堆外内存）
  ③ 超大规模（10亿+ 向量）时成本高

选型建议：
  - 中小规模（< 1 亿向量）+ 已有 ES → 用 ES
  - 超大规模 + 纯向量场景 → Milvus
  - 全文 + 向量混合 + 业务复杂 → ES
```

### 2.4.3 RAG 实战陷阱

```text
陷阱1：Embedding 模型与查询不一致
  - 索引时用模型 A，查询时用模型 B
  - 向量空间不一致，召回崩坏
  - 必须用同一个模型

陷阱2：分块（chunking）策略
  - 文档太长，向量不精确
  - 文档太短，上下文丢失
  - 推荐 200-500 字一块，有重叠（50 字）

陷阱3：top-k 设置
  - k 太小：召回不足
  - k 太大：噪声多，prompt 过长
  - 推荐 k=5~20，配合 rerank

陷阱4：忽略元数据过滤
  - 用户问"2024 年的政策"
  - 应该先过滤 time=2024，再做向量检索
  - 否则可能召回 2020 年的旧政策

陷阱5：没有 rerank
  - 向量召回的 top-k 相关性参差不齐
  - 用 rerank 模型（如 bge-reranker）重排
  - 显著提升最终质量
```

---

# 第三章：生产故障案例集

## 3.1 磁盘满导致索引只读

### 3.1.1 现象

```text
业务侧报错：
  cluster_block_exception: index [logs-2026.06.20] blocked by: [FORBIDDEN/8/index read-only (api)];

写入全部失败，但查询正常
```

### 3.1.2 根因

```text
ES 磁盘水位线：
  low watermark（85%）：不再分配新分片到该节点
  high watermark（90%）：尝试把分片移走
  flood stage（95%）：所有索引设为只读（read_only_allow_delete）

集群某节点磁盘使用率达 95%，触发 flood stage
→ 该节点上的所有索引被标记为只读
→ 写入被拒绝
```

### 3.1.3 解决步骤

```text
1. 立即解除只读（治标）：
   PUT /logs-2026.06.20/_settings
   { "index.blocks.read_only_allow_delete": null }

2. 清理磁盘空间（治本）：
   - 删除过期索引
   - 临时调大磁盘
   - 增加数据节点

3. 调整水位线（如果默认太严格）：
   PUT /_cluster/settings
   {
     "transient": {
       "cluster.routing.allocation.disk.watermark.low": "85%",
       "cluster.routing.allocation.disk.watermark.high": "90%",
       "cluster.routing.allocation.disk.watermark.flood_stage": "95%"
     }
   }

4. 监控告警：
   - 磁盘 80% 告警（提前介入）
   - 不要等到 95% 才发现
```

### 3.1.4 架构师反思

```text
- 磁盘水位线是兜底保护，不是正常运维手段
- 应该在 80% 就告警，85% 就扩容
- 日志类业务必须配 ILM 自动删除
- 监控要分节点看磁盘，不能只看集群总览
```

## 3.2 unassigned shard 排查

### 3.2.1 现象

```text
集群状态 yellow 或 red
GET /_cluster/health 显示 unassigned_shards > 0
```

### 3.2.2 排查步骤

```text
1. 看哪些分片未分配：
   GET /_cat/shards?v&h=index,shard,prirep,state,unassigned.reason
   → state=UNASSIGNED 的就是问题分片

2. 看未分配原因：
   GET /_cluster/allocation/explain
   {
     "index": "logs-2026.06.20",
     "shard": 0,
     "primary": false
   }
   → 返回具体原因

3. 常见原因：
   - NODE_LEFT：节点离线，等节点回来
   - ALLOCATION_FAILED：分配失败（如磁盘满、 Corruption）
   - CLUSTER_RECOVERED：集群重启中，等恢复
   - REINITIALIZED：分片初始化失败
```

### 3.2.3 常见处理

```text
节点离线：
  → 重启节点或等节点回来
  → 副本会自动重新分配

分配失败：
  → 看具体失败原因（disk/CORRUPTION）
  → POST /_cluster/reroute?retry_failed=true 重试

分片损坏（CORRUPTION）：
  → 主分片损坏：从副本恢复（如果有）
  → 主副本都损坏：数据丢失，需从 snapshot 恢复
  → 不得已：丢弃该分片（数据丢失）
     POST /_cluster/reroute
     {
       "commands": [
         { "allocate_stale_primary": {
             "index": "logs-2026.06.20",
             "shard": 0,
             "node": "node1",
             "accept_data_loss": true
         }}
       ]
     }
```

## 3.3 mapping conflict（字段类型冲突）

### 3.3.1 现象

```text
写入报错：
  mapper_parsing_exception: failed to parse field [amount] of type [scaled_float]

或：
  illegal_argument_exception: [amount] is defined as scaled_float but [abc] is not a number
```

### 3.3.2 根因

```text
Day2 学过：字段类型一旦确定不能改
  - 第一条写入 "amount": 100.5 → scaled_float
  - 第二条写入 "amount": "abc" → 类型冲突

更隐蔽的场景：
  - 多个索引通过别名统一查询
  - 索引 A 的 amount 是 scaled_float
  - 索引 B 的 amount 是 text
  - 跨索引查询时类型冲突
```

### 3.3.3 解决方案

```text
立即解决：
  - 找到冲突的字段
  - 修正写入逻辑（保证类型一致）
  - 错误数据手动修复或丢弃

长期解决：
  - dynamic: strict 禁止新字段
  - 显式定义所有字段类型
  - 用 Index Template 统一管理
  - 写入前在 Ingest Pipeline 做类型校验

如果已上线且字段类型错误：
  - reindex 到新索引（正确 mapping）
  - alias 切换
  - 删除旧索引
```

## 3.4 shard 过多拖垮集群

### 3.4.1 现象

```text
集群状态 green，但：
  - 查询延迟逐渐升高
  - 节点 CPU 持续 60%+（无明显业务流量）
  - Master 节点压力异常大
  - GET /_cat/shards 返回几万个分片
```

### 3.4.2 根因

```text
每个分片的代价：
  - 内存：元数据、Segment 信息进堆
  - CPU：merge、refresh、查询都要扫
  - 文件句柄：每个 Segment 多个文件
  - 网络：主副本心跳、状态同步

经验值：
  - 每节点分片数 < 600（数据节点）
  - 每节点分片数 < 1000（绝对上限）
  - 集群总分片数 < (节点数 × 600)

常见原因：
  - 日志按天分索引 + 分片数 20 + 保留 365 天 = 7300 分片
  - 多业务线各自建索引
  - 过度分片（每个索引 30 分片，但数据量只有 1GB）
```

### 3.4.3 解决方案

```text
1. 关闭过期索引（close）：
   POST /logs-2026.01.01/_close
   → 不占资源，需要时再 open

2. 删除过期索引：
   DELETE /logs-2026.01.01

3. shrink 收缩分片：
   POST /logs-2026.06.01/_shrink/logs-2026.06.01-shrunk
   { "settings": { "index.number_of_shards": 1 }}
   → 5 分片缩为 1 分片（适合冷数据）

4. 合并索引：
   reindex 多个小索引到一个大索引

5. 长期：
  - 合理规划分片数（按数据量，不是越多越好）
  - 日志类用 ILM 自动 shrink 和 delete
  - 小数据量用 1 分片
```

## 3.5 fielddata OOM

### 3.5.1 现象

```text
节点 OOM 重启
日志：java.lang.OutOfMemoryError: Java heap space
堆 dump 显示 fielddata 占用 80%+
```

### 3.5.2 根因

```text
fielddata：
  - text 字段聚合/排序时，动态构建倒排（堆内存）
  - 不可控，可能瞬间占满堆

触发场景：
  - 对 text 字段做聚合
  - 对 text 字段排序
  - 对 text 字段做 script
```

### 3.5.3 解决方案

```text
立即：
  - 重启节点
  - 找到触发 fielddata 的查询并停止

长期：
  1. 禁用 text 字段的 fielddata：
     "properties": {
       "content": {
         "type": "text",
         "fielddata": false  // 默认就是 false
       }
     }

  2. 聚合用 keyword 子字段：
     "title": {
       "type": "text",
       "fields": { "keyword": { "type": "keyword" }}
     }
     → 聚合走 title.keyword

  3. 限制 fielddata cache 大小：
     indices.fielddata.cache.size: 40%
     → 超过 40% 就淘汰旧数据

  4. 监控 fielddata：
     GET /_nodes/stats/indices/fielddata
     → memory_size 持续上涨要注意
```

## 3.6 写入被拒绝（429）

### 3.6.1 现象

```text
写入报错：
  EsRejectedExecutionException: rejected execution of org.elasticsearch.transport... 
  on EsThreadPoolExecutor[write, queue capacity = 10000, ...]
```

### 3.6.2 根因

```text
write 线程池：
  - size = cpu 核数
  - queue = 10000
  - 队列满后拒绝写入（429）

原因：
  - 写入 QPS 超过处理能力
  - 单个 Bulk 太大，处理慢
  - 副本同步慢，主等待
  - merge 占用资源
  - GC 频繁
```

### 3.6.3 解决方案

```text
立即：
  - 降低客户端写入并发
  - 增大 Bulk 批次（5-15MB）
  - 临时调大队列（治标）：
    PUT /_cluster/settings
    { "transient": { "thread_pool.write.queue_size": 20000 }}

长期：
  - 扩容数据节点
  - 调大 refresh_interval（减少 Segment）
  - 副本数临时设为 0（批量导入）
  - 监控 rejected 指标，提前扩容
```

## 3.7 故障排查通用 SOP

```text
Step 1：看集群状态
  GET /_cluster/health
  → green/yellow/red？

Step 2：看节点
  GET /_cat/nodes?v
  → 是否有节点离线？
  → CPU/内存/disk 是否异常？

Step 3：看分片
  GET /_cat/shards?v
  → 是否有 UNASSIGNED？
  → 是否有 RELOCATING 卡住？

Step 4：看索引
  GET /_cat/indices?v
  → 哪个索引 health 异常？
  → 哪个索引 docs/size 异常？

Step 5：看线程池
  GET /_cat/thread_pool?v
  → 哪个线程池 rejected 高？
  → queue 是否满？

Step 6：看 JVM
  GET /_nodes/stats/jvm
  → heap 使用率？
  → GC 频次？
  → 是否有 OOM 痕迹？

Step 7：看慢查询日志
  → 哪些查询慢？
  → 是否有全量聚合？

Step 8：看应用日志
  → 客户端报什么错？
  → 什么时间开始？
```

---

# 第四章：时序数据三件套

## 4.1 Data Stream

### 4.1.1 为什么需要 Data Stream

```text
传统方案（alias + rollover）：
  - 写 alias 指向当前索引
  - 索引达阈值（大小/时间）rollover 到新索引
  - alias 切换到新索引
  - 读 alias 指向所有索引

痛点：
  - 配置繁琐（rollover + alias 管理）
  - 客户端要理解 alias 概念
  - 跨索引查询要手动管理

Data Stream（ES 6.7+，8.x 主推）：
  - 抽象为一层"数据流"
  - 客户端只写 data stream 名
  - ES 自动管理 backing indices
  - 自动 rollover
  - 适合时序数据（日志、指标、追踪）
```

### 4.1.2 创建与使用

```json
// 1. 创建 Index Template（绑定 data stream）
PUT _index_template/logs_template
{
  "index_patterns": ["logs-*"],
  "data_stream": {},  // 声明为 data stream
  "template": {
    "settings": {
      "number_of_shards": 3,
      "number_of_replicas": 1,
      "index.lifecycle.name": "logs_policy"
    },
    "mappings": {
      "properties": {
        "@timestamp": { "type": "date" },
        "message": { "type": "text" },
        "level": { "type": "keyword" }
      }
    }
  }
}

// 2. 写入（自动创建 data stream）
POST logs-app/_doc
{
  "@timestamp": "2026-06-21T10:00:00Z",
  "message": "service started",
  "level": "INFO"
}
→ 自动创建 logs-app data stream
→ 实际写入 .ds-logs-app-2026.06.21-000001

// 3. 查询（直接查 data stream 名）
GET logs-app/_search
{ "query": { "match_all": {} }}

// 4. 查看 data stream
GET _data_stream/logs-app
```

### 4.1.3 rollover 与 backing indices

```text
Data Stream 的物理结构：
  logs-app
    ├── .ds-logs-app-2026.06.21-000001  (write)
    ├── .ds-logs-app-2026.06.22-000002  (write，rollover 后)
    └── .ds-logs-app-2026.06.23-000003  (write，最新)

rollover 触发：
  - 由 ILM 管理
  - max_size: 50gb 或 max_age: 1d
  - 自动创建新 backing index
  - 写入流向新 index

特点：
  - 只有最新的 backing index 可写
  - 旧的 backing index 自动 read-only
  - 删除整个 data stream 会删除所有 backing indices
```

### 4.1.4 Data Stream vs Alias+Rollover

| 对比项 | Data Stream | Alias+Rollover |
|--------|-------------|----------------|
| 客户端复杂度 | 低（只写 stream 名） | 中（要理解 alias） |
| 自动 rollover | 内置 ILM | 要配 ILM + rollover alias |
| 适合场景 | 时序数据 | 任意场景 |
| 删除数据 | 删整个 stream 或按 backing index | 按 alias 下的索引删 |
| 灵活性 | 较低（必须 @timestamp） | 高 |
| 8.x 推荐 | ✅ 主推 | 仍支持 |

## 4.2 ILM 各阶段实战

### 4.2.1 ILM 完整阶段

```text
Hot：热数据
  - 写入频繁，查询频繁
  - SSD
  - 触发 rollover（按 size/age/docs）

Warm：温数据
  - 写入停止，查询少
  - 机械硬盘
  - shrink（收缩分片）、forcemerge（合并段）

Cold：冷数据
  - 偶尔查询
  - searchable snapshot（可搜索快照）
  - 节省本地存储

Frozen：冰冻数据（8.x）
  - 极少查询
  - searchable snapshot（完全按需加载）
  - 几乎不占本地磁盘

Delete：删除
  - 过期数据直接删
```

### 4.2.2 实战 ILM 策略

```json
PUT _ilm/policy/logs_policy
{
  "policy": {
    "phases": {
      "hot": {
        "actions": {
          "rollover": {
            "max_size": "50gb",
            "max_age": "1d",
            "max_docs": 500000000
          },
          "set_priority": { "priority": 100 }
        }
      },
      "warm": {
        "min_age": "7d",
        "actions": {
          "set_priority": { "priority": 50 },
          "allocate": {
            "number_of_replicas": 1,
            "include": { "data": "warm" }
          },
          "shrink": {
            "number_of_shards": 1
          },
          "forcemerge": {
            "max_num_segments": 1
          }
        }
      },
      "cold": {
        "min_age": "30d",
        "actions": {
          "allocate": {
            "include": { "data": "cold" }
          },
          "searchable_snapshot": {
            "snapshot_repository": "s3_repo"
          }
        }
      },
      "delete": {
        "min_age": "90d",
        "actions": {
          "delete": {}
        }
      }
    }
  }
}
```

### 4.2.3 各 action 详解

```text
rollover：滚动创建新索引
  - 触发条件：max_size/max_age/max_docs 任一满足
  - 注意：与 data stream 配合，自动管理

shrink：收缩分片数
  - 前提：索引必须 read-only、所有分片在同一节点、health green
  - 5 分片 → 1 分片
  - 适合冷数据（写入停止后）

forcemerge：合并段
  - max_num_segments=1：合并为 1 个段
  - 释放 .del 空间
  - 提升查询性能
  - 注意：只在 read-only 索引上做

allocate：分配到指定节点
  - 通过 include/exclude 标签
  - 把 hot 数据分到 SSD 节点，cold 分到机械节点

searchable_snapshot：可搜索快照
  - 把索引转为快照
  - 本地只保留缓存
  - 大幅节省存储成本

delete：删除
  - 过期数据直接删
  - 释放存储
```

### 4.2.4 ILM 排查

```text
查看索引的 ILM 状态：
  GET logs-app/_ilm/explain
  → managed、phase、action、step

常见问题：
  ① 索引卡在某个 step：
     POST logs-app-2026.06.20/_ilm/retry
  ② shrink 失败：
     - 检查索引是否 read-only
     - 检查分片是否在同一节点
     - 检查 cluster.routing.allocation
  ③ rollover 不触发：
     - 检查 ILM 是否绑定到索引
     - 检查 rollover 条件是否满足
     - 检查 poll_interval（默认 10 分钟）
```

## 4.3 Snapshot 备份恢复

### 4.3.1 注册仓库

```json
// S3 仓库
PUT _snapshot/s3_repo
{
  "type": "s3",
  "settings": {
    "bucket": "my-es-backup",
    "base_path": "snapshots",
    "region": "us-east-1",
    "compress": true
  }
}

// HDFS 仓库
PUT _snapshot/hdfs_repo
{
  "type": "hdfs",
  "settings": {
    "uri": "hdfs://namenode:8020",
    "path": "es/backups"
  }
}

// 文件系统（共享存储）
PUT _snapshot/fs_repo
{
  "type": "fs",
  "settings": {
    "location": "/mnt/es-backup"
  }
}
```

### 4.3.2 手动快照

```json
// 全集群快照
PUT _snapshot/s3_repo/snapshot_20260621?wait_for_completion=false
{}

// 指定索引快照
PUT _snapshot/s3_repo/snapshot_logs
{
  "indices": "logs-2026.06.*",
  "ignore_unavailable": true,
  "include_global_state": false
}

// 查看快照
GET _snapshot/s3_repo/_all?pretty

// 查看快照详情
GET _snapshot/s3_repo/snapshot_20260621
```

### 4.3.3 自动快照（SLM）

```json
// 配置 SLM（Snapshot Lifecycle Management）
PUT _slm/policy/daily_backup
{
  "schedule": "0 30 2 * * ?",  // 每天 2:30
  "name": "<daily-snap-{now/d}>",
  "repository": "s3_repo",
  "config": {
    "indices": ["*"],
    "ignore_unavailable": true,
    "include_global_state": false
  },
  "retention": {
    "expire_after": "30d",
    "min_count": 5,
    "max_count": 50
  }
}
```

### 4.3.4 恢复

```json
// 恢复整个快照
POST _snapshot/s3_repo/snapshot_20260621/_restore?wait_for_completion=false
{}

// 恢复指定索引，并重命名
POST _snapshot/s3_repo/snapshot_20260621/_restore
{
  "indices": "logs-2026.06.20",
  "rename_pattern": "logs-(.+)",
  "rename_replacement": "restored-logs-$1"
}

// 监控恢复进度
GET _recovery?human
GET _cat/recovery?v
```

### 4.3.5 跨集群恢复

```text
场景：A 集群故障，从 B 集群恢复

步骤：
  1. A 和 B 共享同一个 snapshot 仓库（S3）
  2. 在 B 集群注册相同仓库
  3. POST _snapshot/repo/snapshot/_restore
  4. 数据恢复到 B 集群

注意：
  - 恢复的索引默认是新的（可以 rename）
  - 恢复期间索引 yellow（副本还没建）
  - 大索引恢复可能很久（几小时-几天）
```

### 4.3.6 searchable snapshot（8.x）

```text
传统 snapshot：
  - 恢复时要把数据全量拉回本地
  - 占用本地存储
  - 慢

searchable snapshot：
  - 数据在 S3/HDFS 上
  - 本地只缓存热点块
  - 查询时按需从远端拉取
  - 大幅节省本地存储

适用：
  - Cold/Frozen 层数据
  - 极少查询但需要保留
  - 成本敏感场景

注意：
  - 查询延迟比本地高（远端拉取）
  - 适合低频查询，不适合在线查询
```

---

# 第五章：JVM 调优与慢查询定位

## 5.1 JVM 调优

### 5.1.1 Heap 大小

```text
铁律：
  ① Heap ≤ 31GB（避免指针压缩失效）
     - 32GB 是指针压缩（Compressed Oops）的边界
     - 超过后指针不压缩，内存占用反而增加
     - 实际上限约 31GB
  ② Heap ≤ 物理内存的 50%
     - 留一半给 OS Cache（Lucene 依赖 OS Cache 加速查询）
  ③ 生产环境推荐：31GB

配置（jvm.options）：
  -Xms31g
  -Xmx31g
  → Xms 和 Xmx 必须一致（避免动态扩容）
```

### 5.1.2 GC 选型

```text
ES 7+ 默认 G1GC（之前是 CMS）：
  - G1GC 适合大堆
  - 分区回收，可控停顿
  - 不需要太多调优

G1GC 关键参数：
  -XX:+UseG1GC
  -XX:MaxGCPauseMillis=200      // 期望最大停顿
  -XX:G1ReservePercent=25       // 保留内存
  -XX:InitiatingHeapOccupancyPercent=30  // 触发并发标记的阈值

为什么不调？
  - G1 自适应能力强
  - ES 官方测试默认配置最优
  - 调错了反而出问题
  → 99% 场景保持默认即可
```

### 5.1.3 off-heap 内存

```text
ES 进程内存 = Heap + off-heap + Direct Memory

off-heap 用途：
  - Lucene 的 Segment 文件通过 mmap 映射到 off-heap
  - Netty 的 Direct Buffer（网络传输）
  - 向量检索的 HNSW 图结构

预留：
  - 至少给 off-heap 留 16GB
  - 大集群 32GB+
  - 通过 vm.max_map_count 调高（生产必做）

/etc/sysctl.conf:
  vm.max_map_count=262144
  → sysctl -p 生效
```

### 5.1.4 circuit breaker（熔断器）

```text
ES 内置熔断器，防止 OOM：

indices.breaker.total.limit：总熔断阈值（默认 95% heap）
indices.breaker.fielddata.limit：fielddata 熔断（默认 60%）
indices.breaker.request.limit：请求熔断（默认 60%）
indices.breaker.accounting.limit：统计熔断（默认 100%）

工作流程：
  - 查询前估算内存占用
  - 超过阈值 → 抛 CircuitBreakerException
  - 避免真正 OOM 崩溃

调整：
  PUT /_cluster/settings
  { "transient": {
    "indices.breaker.fielddata.limit": "40%"
  }}

注意：
  - 不要轻易调高熔断阈值
  - 调高了会真 OOM
  - 触发熔断说明查询本身有问题
```

## 5.2 慢查询定位

### 5.2.1 慢查询日志

```json
// 配置慢查询阈值
PUT /_cluster/settings
{
  "transient": {
    "indices.recovery.*": null,
    "search.slowlog.threshold.query.warn": "2s",
    "search.slowlog.threshold.query.info": "1s",
    "search.slowlog.threshold.query.debug": "500ms",
    "search.slowlog.threshold.fetch.warn": "500ms"
  }
}
```

```text
日志位置：
  <ES_HOME>/logs/<cluster>_index_search_slowlog.json

日志内容：
  - 索引名、分片
  - 查询 DSL
  - 耗时
  - 来源（source_node、source）

query 阶段 vs fetch 阶段：
  query：协调节点分发到分片，分片本地查询返回 doc_id
  fetch：协调节点根据 doc_id 取真实文档
  → query 慢：查询条件有问题
  → fetch 慢：返回字段太多、深分页
```

### 5.2.2 Profile API

```json
GET /products/_search
{
  "profile": true,
  "query": {
    "bool": {
      "must": [
        { "match": { "title": "重疾险" }},
        { "range": { "price": { "gte": 100 }}}
      ],
      "filter": [
        { "term": { "category": "健康险" }}
      ]
    }
  }
}
```

```text
Profile 输出关键字段：
  query.time：总耗时
  query.children[]：每个子查询耗时
    - match、term、range 各自耗时
  rewrite_time：查询重写耗时
  collector[]：收集器耗时
    - build_scorer：构建打分器
    - next_doc：遍历文档
    - advance：跳跃遍历
  aggregations[]：聚合耗时

定位思路：
  1. 哪个子查询最慢？
  2. 是 build_scorer 慢（打分开销）还是 next_doc 慢（扫描多）？
  3. 聚合是否占比异常？

常见发现：
  - text 字段 term 查询慢 → 改 keyword
  - range 查询慢 → 加 keyword 字段做 range
  - 聚合慢 → 减少桶数、用 cardinality 代替 terms
```

### 5.2.3 慢查询常见原因

```text
原因1：扫描文档太多
  → 没走 filter 缓存
  → 范围查询返回大量文档
  → 解决：加 filter、缩小范围

原因2：聚合太重
  → 全量聚合
  → 嵌套层级深
  → cardinality precision_threshold 太高
  → 解决：先过滤、减少层级、调低 precision_threshold

原因3：深分页
  → from=10000
  → 解决：search_after

原因4：字段类型不对
  → text 字段做聚合
  → keyword 字段做 match
  → 解决：检查 Mapping

原因5：Segment 太多
  → refresh 太频繁
  → 没 force merge
  → 解决：调大 refresh_interval，冷数据 force merge

原因6：副本同步影响
  → 副本同步占资源
  → 解决：错峰查询、扩容
```

## 5.3 任务管理与取消

```text
查看正在执行的任务：
  GET /_cat/tasks?v

查看耗时任务：
  GET /_tasks?detailed=true&actions=*search*

取消任务：
  POST /_tasks/<task_id>/_cancel

设置查询超时：
  GET /products/_search?timeout=5s
  → 超时返回部分结果（不是取消）

  GET /products/_search?terminate_after=10000
  → 每个分片最多扫 10000 文档后停止

实战：
  - 大查询卡住 → _cancel
  - 防止大查询 → terminate_after
  - 全局超时 → search.default_search_timeout
```

---

# 第六章：ES 8.x 新特性与生态选型

## 6.1 ES 8.x 关键变化

### 6.1.1 安全默认开启

```text
ES 7.x：默认无认证
ES 8.x：默认开启 security
  - TLS 加密（传输层）
  - HTTPS（HTTP 层）
  - 认证（用户名密码 / API Key）
  - 第一次启动自动生成密码和证书

影响：
  - 升级到 8.x 必须配置安全
  - 老应用要改客户端配置（https + 认证）
  - 内网部署也要走 TLS
```

### 6.1.2 原生向量检索

```text
ES 7.x：dense_vector 是实验性的，无 HNSW
ES 8.0：HNSW 索引，dense_vector.index=true
ES 8.4：kNN 查询稳定
ES 8.8：RRF retriever
ES 8.11：query_vector_builder（内置 Embedding）

→ 8.x 是 RAG 落地的关键版本
```

### 6.1.3 Lucene 9

```text
Lucene 9 的重要改进：
  - 块压缩（Block KD-Tree）：数值/向量查询更快
  - 向量检索（HNSW）
  - 更好的列式存储
  - 大文档支持更好
```

### 6.1.4 ES|QL

```text
ES 8.11+ 新查询语言：
  - 管道式语法（类似 Splunk / DataFrames）
  - 比 DSL 简洁
  - 性能更好（专门的执行引擎）

示例：
  POST /_query
  {
    "query": "FROM logs-* | WHERE level == \"ERROR\" | STATS count = COUNT(*) BY service | SORT count DESC"
  }

适合：
  - 日志分析
  - 简单报表
  - 不适合复杂相关性查询
```

### 6.1.5 Data Stream 主推

```text
ES 8.x 全面主推 Data Stream：
  - 时序数据用 Data Stream
  - 非时序数据用普通索引
  - alias + rollover 仍支持但不是首选
```

## 6.2 ES vs OpenSearch

### 6.2.1 分叉背景

```text
2021 年：
  - Elastic 改 ES 许可证（从 Apache 2.0 到 SSPL + Elastic License）
  - AWS 不满，fork 出 OpenSearch
  - 两者从此分道扬镳

现状：
  - ES：商业许可，部分功能需要付费（X-Pack）
  - OpenSearch：Apache 2.0，完全开源
```

### 6.2.2 功能差异

| 对比项 | ES | OpenSearch |
|--------|-----|------------|
| 安全 | 默认开启 | 默认开启（plugin） |
| 向量检索 | 8.x 原生 HNSW | k-NN plugin（同样 HNSW） |
| ML | 需要白金版 | ML Commons 开源 |
| SQL | 需要 Basic+ | SQL plugin 开源 |
| 生态 | Elastic 全家桶 | OpenSearch Dashboards |
| 兼容 | 自己的 API | 兼容 ES 7.10 API |

### 6.2.3 选型建议

```text
选 ES：
  - 需要最新特性（如 ES|QL、最新向量检索）
  - 愿意付商业许可费
  - 已有 Elastic 生态
  - 需要官方商业支持

选 OpenSearch：
  - 预算敏感，要完全开源
  - AWS 用户（托管服务便宜）
  - 不需要 ES 独有特性
  - 自建集群且要避免许可证风险

趋势：
  - 国内大厂倾向 OpenSearch（合规）
  - 创业公司倾向 ES（生态成熟）
  - 向量场景两者都能用
```

## 6.3 ES vs Solr

```text
Solr：另一个基于 Lucene 的搜索引擎

对比：
  | 维度 | ES | Solr |
  |-----|-----|------|
  | 分布式 | 原生（强） | SolrCloud（较弱） |
  | 实时性 | NRT（1s） | NRT（可配） |
  | 聚合 | 强（aggs） | 强（faceting） |
  | 中文 | IK 插件 | IK 分词器 |
  | 生态 | Elastic 全家桶 | 独立项目 |
  | 社区 | 活跃（更大） | 活跃 |
  | 学习曲线 | 中 | 中 |

选型：
  - 新项目优先 ES（生态、社区、向量检索）
  - 老项目维护 Solr 不强求迁移
  - 纯全文检索场景两者都行
```

---

# 第七章：进阶架构题

## 7.1 容量规划精算

### 7.1.1 分片数精算公式

```text
经验公式：
  单分片大小 = 30-50GB（推荐 30GB）
  单分片文档数 < 20 亿（Lucene 上限 2^31）

主分片数 = 预估总数据量 / 单分片大小

例：保险保单索引
  - 文档数：1 亿
  - 单文档大小：8KB（含 _source）
  - 副本：1
  - 总数据量：1 亿 × 8KB × 2（含副本）= 1.6TB
  - 主分片数：1.6TB / 2 / 30GB ≈ 27
  - 取整：30 个主分片
```

### 7.1.2 节点数精算

```text
数据节点数 = 总数据量 / 单节点存储

考虑因素：
  - 单节点磁盘 4TB（SSD）
  - 留 20% 余量（实际用 3.2TB）
  - 单节点分片 < 600

例：日志集群
  - 日增 500GB
  - 保留 30 天 = 15TB
  - 副本 1 = 30TB
  - 单节点 3.2TB → 需要 10 节点
  - 加冗余 → 12-15 节点

总节点数：
  - 数据节点：12
  - Master 节点：3
  - 协调节点：2
  - 总计：17 节点
```

### 7.1.3 内存精算

```text
单节点内存：
  - Heap：31GB
  - off-heap（Lucene cache）：16GB+
  - 系统预留：8GB
  - 总计：64GB 物理内存

集群总 Heap = 数据节点数 × 31GB
  - 12 × 31GB = 372GB
  - 实际可用（避免熔断）= 372 × 0.85 = 316GB

监控：
  - Heap 使用率 > 75% 告警
  - Heap 使用率 > 85% 紧急
```

## 7.2 跨机房多活

### 7.2.1 方案对比

```text
方案1：CCR（Cross-Cluster Replication）
  - 主集群 → 备集群自动跟随
  - 索引级复制
  - 异步，有延迟
  - 备集群可读不可写
  - 适合灾备

方案2：CCS（Cross-Cluster Search）
  - 多集群联合查询
  - 不复制数据
  - 适合分布式查询

方案3：双写
  - 应用同时写两个集群
  - 一致性靠应用保证
  - 复杂，不推荐

方案4：Kafka 双消费
  - 写入先到 Kafka
  - 两个集群各自消费
  - 解耦，但延迟和顺序要处理
```

### 7.2.2 CCR 实战

```text
CCR（需要白金版）：
  - 主集群配置 remote cluster
  - 创建 follower index
  - 自动跟随 leader index 的变化

配置：
  PUT _cluster/settings
  { "persistent": {
    "cluster": {
      "remote": {
        "leader_cluster": {
          "seeds": ["leader1:9300"]
        }
      }
    }
  }}

  PUT logs-follower/_ccr/follow
  {
    "remote_cluster": "leader_cluster",
    "leader_index": "logs-leader"
  }

特点：
  - 异步复制（秒级延迟）
  - follower 只读
  - 主集群故障可手动 promote follower 为可写
  - 不保证强一致
```

### 7.2.3 跨机房架构

```text
两地三中心：
  机房 A（主）：写入 + 读取
  机房 B（备）：CCR 跟随，只读
  机房 C（灾）：snapshot 备份

故障切换：
  - A 故障 → 提升 B 为可写
  - 应用切到 B
  - A 恢复后反向同步（如果可能）

注意：
  - CCR 是异步的，A 故障时可能丢少量数据
  - 切换需要人工决策（避免脑裂）
  - 跨机房延迟影响写入吞吐
```

## 7.3 多租户容量隔离

### 7.3.1 噪声邻居问题

```text
多租户共享集群的痛点：
  - 租户 A 发起大查询 → 占用协调节点 CPU
  - 租户 B 的查询被阻塞
  - 租户 A 写入暴增 → 触发 merge
  - 租户 B 的查询变慢

这就是"噪声邻居"问题
```

### 7.3.2 隔离手段

```text
手段1：索引隔离（强）
  - 每个租户独立索引
  - 互不影响
  - 租户多时索引爆炸

手段2：分片分配过滤
  - 大租户分配到独立节点组
  - "tenant:big" 标签的节点只放 big 租户分片
  - 中等隔离强度

手段3：限流
  - 按租户限流（查询网关层）
  - 超过配额拒绝
  - 不影响其他租户

手段4：节点级隔离（最强）
  - 大租户独享节点
  - 物理隔离
  - 成本最高

手段5：搜索延迟隔离
  - search.default_search_timeout 全局
  - indices.query.bool.max_clause_count 限制复杂度
  - 防止慢查询拖垮
```

### 7.3.3 配额设计

```text
按租户配额：
  - 写入 QPS：1000/s
  - 查询 QPS：500/s
  - 存储大小：100GB
  - 索引数：10

实现：
  - 网关层做配额（Redis 计数）
  - 超额返回 429
  - 监控告警租户使用情况

进阶：
  - 大租户升级到独享集群
  - 小租户继续共享
  - 中台自动迁移（参考 Day06 中台架构）
```

## 7.4 大规模 reindex 方案

### 7.4.1 reindex 场景

```text
需要 reindex 的场景：
  - 字段类型错了（text → keyword）
  - 分词器变了（IK 升级、加同义词）
  - 分片数要改（主分片数不能改，只能 reindex）
  - 索引结构重大调整
```

### 7.4.2 reindex 步骤

```text
步骤1：新建目标索引（正确 mapping）
步骤2：reindex 数据
步骤3：双写（保持新数据同步）
步骤4：alias 切换
步骤5：删除旧索引
```

### 7.4.3 reindex 优化

```json
// 并行 reindex（slice）
POST _reindex?wait_for_completion=false&slices=auto
{
  "source": {
    "index": "old_index",
    "size": 5000  // 每批 5000
  },
  "dest": {
    "index": "new_index"
  }
}

// 监控进度
GET _tasks/<task_id>
```

```text
slices=auto：
  - ES 自动按分片数切片
  - 并行 reindex
  - 速度提升数倍

size：
  - 每批大小
  - 5000 适合普通文档
  - 大文档调小（1000）

其他优化：
  - reindex 时关掉目标索引的副本（number_of_replicas=0）
  - reindex 时调大 refresh_interval（-1）
  - 完成后恢复
```

### 7.4.4 版本冲突处理

```text
reindex 期间如果有新数据写入：
  - 旧索引有新数据
  - 新索引没同步
  - 切换后会丢数据

方案1：双写（推荐）
  - reindex 期间应用双写新旧索引
  - reindex 完成后切换
  - 切换后停双写

方案2：按时间分界
  - T 时刻开始 reindex
  - reindex 处理 T 之前的数据
  - T 之后的数据通过 Canal 补
  - 验证一致后切换

方案3：retry_on_conflict
  POST _reindex
  {
    "conflicts": "proceed",  // 冲突继续
    "source": { "index": "old" },
    "dest": {
      "index": "new",
      "op_type": "create"  // 只创建不更新
    }
  }
```

### 7.4.5 reindex 回滚预案

```text
回滚：
  - alias 切回旧索引
  - 旧索引不要立刻删，留 1-7 天观察
  - 确认无问题后删除

注意：
  - reindex 是高风险操作
  - 必须有回滚预案
  - 切换前在测试环境验证
  - 大索引 reindex 选低峰期
```

## 7.5 冷热数据分层架构

### 7.5.1 四层架构

```text
Hot（热）：
  - 最近 1-7 天数据
  - SSD
  - 高 CPU 大内存
  - 写入 + 高频查询

Warm（温）：
  - 7-30 天数据
  - 机械硬盘
  - 中等配置
  - 偶尔查询

Cold（冷）：
  - 30-90 天数据
  - searchable snapshot
  - 本地缓存 + S3
  - 低频查询

Frozen（冰冻）：
  - 90 天以上
  - 完全在 S3
  - 几乎不查询
  - 极低成本
```

### 7.5.2 节点配置

```text
Hot 节点：
  - elasticsearch.yml: node.attr.data: hot
  - 16 核 64G + SSD 4TB×2
  - 数量按写入 QPS 算

Warm 节点：
  - node.attr.data: warm
  - 16 核 64G + HDD 8TB×2
  - 数量按存储算

Cold 节点：
  - node.attr.data: cold
  - 8 核 32G + HDD 4TB
  - 数量少（大部分在 S3）
```

### 7.5.3 ILM 联动

```text
ILM 自动迁移：
  Hot 阶段：allocate include data=hot
  Warm 阶段：allocate include data=warm + shrink + forcemerge
  Cold 阶段：allocate include data=cold + searchable_snapshot
  Delete 阶段：delete

效果：
  - 数据自动从热到冷迁移
  - 节省 SSD 成本
  - 旧数据自动归档
  - 自动删除过期数据
```

---

# 第八章：能力差距自检

## 8.1 分词与相关性

```text
[ ] 能否说清楚 ik_max_word 和 ik_smart 的差异及组合用法
[ ] 能否设计 IK 词典热更新方案
[ ] 能否配置同义词词典并解释查询时展开 vs 索引时展开的取舍
[ ] 能否用 function_score 实现业务相关性排序
[ ] 能否解释 BM25 的 k1 和 b 参数及调优场景
```

## 8.2 向量检索与 RAG

```text
[ ] 能否解释 HNSW 算法原理
[ ] 能否配置 dense_vector 字段并执行 kNN 查询
[ ] 能否设计混合检索（BM25 + 向量）并用 RRF 融合
[ ] 能否说清楚 ES 向量检索 vs Milvus 的选型
[ ] 能否列出 RAG 实战的 5 个陷阱
```

## 8.3 故障排查

```text
[ ] 能否处理磁盘满导致只读的故障
[ ] 能否排查 unassigned shard 并给出处理方案
[ ] 能否定位 mapping conflict 并修复
[ ] 能否处理 shard 过多的问题
[ ] 能否定位 fielddata OOM 并根治
[ ] 能否处理写入 429 拒绝
[ ] 能否背出故障排查 SOP
```

## 8.4 时序三件套

```text
[ ] 能否说清楚 Data Stream 与 alias+rollover 的区别
[ ] 能否设计完整 ILM 策略（Hot/Warm/Cold/Delete）
[ ] 能否解释 shrink 和 forcemerge 的前提与陷阱
[ ] 能否配置 SLM 自动快照
[ ] 能否从 snapshot 恢复并理解跨集群恢复
[ ] 能否说清楚 searchable snapshot 的优势
```

## 8.5 JVM 与性能

```text
[ ] 能否说清楚 Heap 31GB 边界的原因
[ ] 能否解释 G1GC 为什么不需要太多调优
[ ] 能否说清楚 circuit breaker 的工作机制
[ ] 能否配置慢查询日志并用 Profile API 定位
[ ] 能否区分 query 阶段和 fetch 阶段的慢
```

## 8.6 8.x 特性与生态

```text
[ ] 能否说清楚 ES 8.x 相比 7.x 的关键变化
[ ] 能否对比 ES 与 OpenSearch 的选型
[ ] 能否解释为什么 8.x 默认开启安全
[ ] 能否说清楚 ES|QL 的定位
```

## 8.7 进阶架构

```text
[ ] 能否做容量规划精算（分片数/节点数/内存）
[ ] 能否设计跨机房多活方案（CCR vs CCS vs 双写）
[ ] 能否设计多租户容量隔离方案
[ ] 能否设计大规模 reindex 方案并处理版本冲突
[ ] 能否设计冷热数据分层架构
```

---

# 第九章：与本周内容的总闭环

```text
Day1（倒排索引）→ 进阶第一章（分词是倒排索引的入口）
Day2（Mapping）→ 进阶第三章（mapping conflict 故障）
Day3（DSL）→ 进阶第一章（function_score 相关性调优）
Day4（性能运维）→ 进阶第五章（JVM 调优、慢查询）
Day5（业务集成）→ 进阶第二章（RAG 是 ES 业务集成的新形态）
Day6（搜索中台）→ 进阶第七章（多租户隔离、容量规划）
Day7（写入链路）→ 进阶第三章（429 拒绝、fielddata OOM）

本周 ES 专题完整闭环：
  原理 → 建模 → 查询 → 优化 → 集成 → 中台 → 深挖 → 进阶
```

---

*日期：2026-06-21 | 2026年06月第3周 补充 | ES 进阶专题：生产实战与面试高频考点*