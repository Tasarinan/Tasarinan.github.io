# Day05：ES实战综合 — 业务系统集成与典型场景（练习整理）
> 2026-06-19 周五｜ES专题第5天

本日目标：将ES与实际业务系统结合，掌握典型场景的架构设计、数据同步、查询设计等实战技能。

---

## 题目一：保险产品搜索 — 电商类搜索场景设计

### 场景

你要为保险商城设计产品搜索功能：
- 产品数据：100万条，字段包括名称、描述、分类、价格、销量、保障责任、保险公司
- 搜索需求：全文搜索、分类筛选、价格区间、销量排序、保障责任筛选
- 性能要求：QPS 5000，响应时间 &lt; 200ms
- 数据更新：产品信息每天更新，价格实时更新

请回答：
1. 索引如何设计？（Mapping、分片、副本）
2. 数据库与ES如何同步？
3. 搜索DSL如何设计？
4. 如何处理"搜索推荐"和"联想词"？
5. 高可用架构如何设计？

---

## 答案

### 1. 索引设计

```json
PUT /insurance_product
{
  "settings": {
    "number_of_shards": 5,
    "number_of_replicas": 2,
    "refresh_interval": "1s",
    "analysis": {
      "analyzer": {
        "ik_max_word_analyzer": {
          "type": "custom",
          "tokenizer": "ik_max_word",
          "filter": ["lowercase"]
        },
        "ik_smart_analyzer": {
          "type": "custom",
          "tokenizer": "ik_smart",
          "filter": ["lowercase"]
        }
      }
    }
  },
  "mappings": {
    "properties": {
      "product_id": { "type": "keyword" },
      "product_name": {
        "type": "text",
        "analyzer": "ik_max_word",
        "search_analyzer": "ik_smart",
        "fields": {
          "keyword": { "type": "keyword", "ignore_above": 256 }
        }
      },
      "description": {
        "type": "text",
        "analyzer": "ik_max_word"
      },
      "category": { "type": "keyword" },
      "category_path": { "type": "keyword" },
      "price": { "type": "scaled_float", "scaling_factor": 100 },
      "sales_count": { "type": "integer" },
      "company": { "type": "keyword" },
      "tags": { "type": "keyword" },
      "features": {
        "type": "nested",
        "properties": {
          "feature_name": { "type": "keyword" },
          "feature_value": { "type": "text" }
        }
      },
      "create_time": { "type": "date" },
      "update_time": { "type": "date" },
      "status": { "type": "keyword" }
    }
  }
}
```

```latex
设计思路：
  分片数：5个（100万数据，每个分片20万，约10-20GB）
  副本数：2个（允许挂2个节点）
  分词器：IK分词器，索引用ik_max_word，搜索用ik_smart
  字段设计：
    - product_name：text + keyword（既支持全文搜索，也支持精确匹配）
    - category：keyword（用于过滤和聚合）
    - features：nested类型（保障责任是多值，需要关联查询）
```

### 2. 数据库与ES同步方案

```latex
方案对比：

  方案1：双写（应用层同时写MySQL和ES）
    优点：简单，实时性好
    缺点：一致性难保证（MySQL成功ES可能失败）
    适用：数据量小，一致性要求不高

  方案2：基于Binlog同步（Canal/Maxwell + Kafka）
    优点：一致性好，不侵入业务
    缺点：架构复杂，有延迟
    适用：数据量大，一致性要求高

  方案3：定时全量 + 增量更新
    优点：简单可靠
    缺点：实时性差
    适用：数据更新不频繁

推荐方案（保险产品）：
  → 方案2：Canal监听Binlog → Kafka → 消费写入ES
  → 同时支持实时同步 + 定时全量校验

为什么？
  → 保险产品数据重要，一致性要求高
  → 数据更新不频繁，延迟可接受
  → 不希望侵入业务代码
```

```java
// 伪代码：Canal消费者
public class CanalConsumer {
    public void consume(BinlogEvent event) {
        if (event.isInsert() || event.isUpdate()) {
            Product product = parseProduct(event.getData());
            if (product.getStatus() == "ONLINE") {
                // 写入ES
                elasticsearchService.index(product);
            } else {
                // 从ES删除
                elasticsearchService.delete(product.getId());
            }
        } else if (event.isDelete()) {
            // 从ES删除
            elasticsearchService.delete(event.getId());
        }
    }
}
```

### 3. 搜索DSL设计

```json
// 典型搜索请求
GET /insurance_product/_search
{
  "from": 0,
  "size": 20,
  "query": {
    "bool": {
      "must": [
        {
          "multi_match": {
            "query": "重疾险 终身",
            "fields": ["product_name^2", "description"],
            "type": "best_fields"
          }
        }
      ],
      "filter": [
        { "term": { "category": "健康险" } },
        { "range": { "price": { "gte": 100, "lte": 5000 } } },
        { "term": { "status": "ONLINE" } },
        {
          "nested": {
            "path": "features",
            "query": {
              "bool": {
                "must": [
                  { "term": { "features.feature_name": "重疾保障" } }
                ]
              }
            }
          }
        }
      ]
    }
  },
  "sort": [
    { "_score": "desc" },
    { "sales_count": "desc" },
    { "price": "asc" }
  ],
  "aggs": {
    "category_agg": {
      "terms": { "field": "category" }
    },
    "price_range_agg": {
      "range": {
        "field": "price",
        "ranges": [
          { "to": 100 },
          { "from": 100, "to": 500 },
          { "from": 500, "to": 2000 },
          { "from": 2000 }
        ]
      }
    },
    "company_agg": {
      "terms": { "field": "company" }
    }
  }
}
```

```latex
DSL设计思路：
  1. multi_match：在product_name和description中搜索
     → product_name权重2倍（名称比描述更重要）
  2. filter：把分类、价格、状态等过滤条件放filter
     → 不参与打分，利用缓存，性能更好
  3. nested：保障责任用nested查询
     → 因为feature_name和feature_value需要关联
  4. sort：先按相关性，再按销量，再按价格
  5. aggs：返回分类、价格区间、公司的聚合结果
     → 用于前端展示筛选条件
```

### 4. 搜索推荐和联想词

```latex
搜索联想词（Suggest）：

  方案1：Completion Suggester
    → 自动补全
    → 性能好
    → 需要提前配置

  方案2：match_phrase_prefix
    → 简单灵活
    → 性能稍差

搜索推荐：

  方案1：基于用户行为（推荐系统）
    → 用户搜索了什么，点击了什么
    → 个性化推荐

  方案2：基于热门（聚合）
    → 统计热门搜索词
    → 统计热门商品

推荐组合：
  → 热门推荐（通用）+ 个性化推荐（精准）
```

```json
// Completion Suggester配置
PUT /insurance_product
{
  "mappings": {
    "properties": {
      "suggest": {
        "type": "completion",
        "analyzer": "ik_max_word"
      }
    }
  }
}

// 搜索联想
POST /insurance_product/_search
{
  "suggest": {
    "product_suggest": {
      "prefix": "重疾",
      "completion": {
        "field": "suggest",
        "size": 10
      }
    }
  }
}
```

### 5. 高可用架构设计

```latex
整体架构：

  接入层：
    → Nginx/HAProxy做负载均衡
    → 多个应用节点

  应用层：
    → 无状态应用
    → 查询ES，写入MySQL

  数据层：
    → MySQL主从（主写从读）
    → ES集群（3主 + N数据 + 2协调）
    → Canal监听Binlog → Kafka → 消费写入ES

  缓存层：
    → Redis缓存热门搜索结果
    → 缓存时间：5-10分钟

  搜索请求流程：
    1. 请求 → Nginx → 应用
    2. 应用先查Redis缓存
    3. 命中直接返回，没命中查ES
    4. ES查询结果回写Redis
    5. 返回给用户

  数据更新流程：
    1. 应用写入MySQL
    2. Canal监听到Binlog变化
    3. 发送到Kafka
    4. 消费者从Kafka消费
    5. 写入ES
    6. 同时删除Redis缓存（下次查询从ES获取最新）
```

### 与架构师水平的差距

| 层次 | 回答 |
|------|------|
| 开发 | 会写查询DSL，能做基本搜索 |
| 高级开发 | 会设计Mapping，知道用Canal同步 |
| 架构师 | 能设计完整的搜索架构，考虑数据同步一致性、高可用、性能优化、推荐功能等，能根据业务场景选择合适的技术方案 |

**补足方向**：设计搜索功能时，先想清楚"数据从哪来"、"怎么同步"、"查询怎么设计"、"高可用怎么保证"，而不是只写DSL。

---

## 题目二：日志分析平台 — ELK架构实战

### 场景

你要为公司搭建统一日志分析平台：
- 日志来源：100+应用节点，Nginx日志、应用日志、错误日志
- 日志量：每天5亿条，每条1KB，共500GB/天
- 查询需求：按应用、按时间范围、按错误级别、关键词搜索
- 告警需求：错误日志超过阈值告警
- 保留时间：30天

请回答：
1. ELK架构如何设计？
2. 日志采集如何实现？
3. 索引如何设计（按天分片、ILM）？
4. 日志查询DSL如何设计？
5. 告警如何实现？

---

## 答案

### 1. ELK架构设计

```latex
完整ELK架构（含Beats）：

  日志源：
    → 应用日志
    → Nginx日志
    → 系统日志

  采集层：
    → Filebeat：轻量级采集器，部署在每个应用节点
    → Metricbeat：采集系统指标
    → Packetbeat：采集网络数据

  消息队列：
    → Kafka：缓冲削峰，防止ES被打垮
    → 应对突增流量

  处理层：
    → Logstash：过滤、清洗、格式化
    → 或用Elasticsearch Ingest Node

  存储层：
    → Elasticsearch集群：Hot/Warm/Cold架构
    → Hot：SSD，存最近7天数据
    → Warm：机械硬盘，存7-30天数据
    → Cold：归档存储，存30天以上

  展示层：
    → Kibana：可视化、Dashboard
    → Grafana：指标展示（可选）

  告警：
    → Elastic APM：应用性能监控
    → Watcher：ES告警
    → 或用第三方：Prometheus + Alertmanager
```

```yaml
# Filebeat配置示例
filebeat.inputs:
  - type: log
    enabled: true
    paths:
      - /var/log/nginx/access.log
    fields:
      log_type: nginx_access
      app_name: insurance_mall

  - type: log
    enabled: true
    paths:
      - /var/log/app/*.log
    fields:
      log_type: app_log
      app_name: insurance_mall

output.kafka:
  hosts: ["kafka1:9092", "kafka2:9092"]
  topic: "logs-%{[fields.app_name]}"
```

### 2. 日志采集实现

```latex
Filebeat优点：
  → 轻量级，资源占用少
  → 有背压机制（ES处理慢就慢发）
  → 支持断点续传（记录offset）
  → 部署简单，配置化

Filebeat部署方案：
  → 每个应用节点部署一个Filebeat
  → 容器环境用Sidecar模式
  → K8s环境用DaemonSet
```

```yaml
# Logstash配置示例（从Kafka消费，写入ES）
input {
  kafka {
    bootstrap_servers => "kafka1:9092,kafka2:9092"
    topics => ["logs-*"]
    group_id => "logstash-consumer"
  }
}

filter {
  # 解析Nginx日志
  if [fields][log_type] == "nginx_access" {
    grok {
      match => { "message" => '%{COMBINEDAPACHELOG}' }
    }
  }
  
  # 解析JSON日志
  if [fields][log_type] == "app_log" {
    json {
      source => "message"
      skip_on_invalid_json => true
    }
  }
  
  # 添加时间戳
  date {
    match => [ "timestamp", "ISO8601" ]
  }
  
  # 删除不需要的字段
  mutate {
    remove_field => [ "message", "@version" ]
  }
}

output {
  elasticsearch {
    hosts => ["es1:9200", "es2:9200"]
    index => "logs-%{[fields.app_name]}-%{+YYYY.MM.dd}"
  }
}
```

### 3. 索引设计与ILM

```json
// ILM策略
PUT /_ilm/policy/logs_policy
{
  "policy": {
    "phases": {
      "hot": {
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
          "allocate": {
            "number_of_replicas": 1
          },
          "forcemerge": {
            "max_num_segments": 1
          },
          "shrink": {
            "number_of_shards": 1
          }
        }
      },
      "delete": {
        "min_age": "30d",
        "actions": {
          "delete": {}
        }
      }
    }
  }
}

// 索引模板
PUT /_index_template/logs_template
{
  "index_patterns": ["logs-*"],
  "template": {
    "settings": {
      "number_of_shards": 5,
      "number_of_replicas": 1,
      "refresh_interval": "30s",
      "index.lifecycle.name": "logs_policy",
      "index.lifecycle.rollover_alias": "logs-alias"
    },
    "mappings": {
      "properties": {
        "@timestamp": { "type": "date" },
        "app_name": { "type": "keyword" },
        "log_type": { "type": "keyword" },
        "level": { "type": "keyword" },
        "message": { "type": "text" },
        "trace_id": { "type": "keyword" }
      }
    }
  }
}
```

```latex
索引设计思路：
  → 按天分索引：logs-app_name-2026.06.19
  → 用ILM自动管理生命周期
  → Hot阶段7天，Warm阶段23天，30天后删除
  → 每天的索引分片数5个（每天500GB，每个分片100GB？不对，应该更小）

修正：
  → 每天的索引分片数20个（500GB，每个分片25GB）
  → 或者按应用分索引，每个应用单独索引
```

### 4. 日志查询DSL设计

```json
// 典型日志查询
GET /logs-*/_search
{
  "from": 0,
  "size": 100,
  "sort": [
    { "@timestamp": "desc" }
  ],
  "query": {
    "bool": {
      "filter": [
        { "range": { "@timestamp": { "gte": "now-1h", "lte": "now" } } },
        { "term": { "app_name": "insurance_mall" } },
        { "term": { "level": "ERROR" } }
      ],
      "must": [
        { "match": { "message": "NullPointerException" } }
      ]
    }
  }
}

// 聚合统计
GET /logs-*/_search
{
  "size": 0,
  "query": {
    "bool": {
      "filter": [
        { "range": { "@timestamp": { "gte": "now-24h", "lte": "now" } } }
      ]
    }
  },
  "aggs": {
    "by_app": {
      "terms": { "field": "app_name" },
      "aggs": {
        "by_level": {
          "terms": { "field": "level" }
        }
      }
    }
  }
}
```

### 5. 告警实现

```json
// Watcher告警配置
PUT /_watcher/watch/error_log_alert
{
  "trigger": {
    "schedule": { "interval": "5m" }
  },
  "input": {
    "search": {
      "request": {
        "indices": ["logs-*"],
        "body": {
          "query": {
            "bool": {
              "filter": [
                { "range": { "@timestamp": { "gte": "now-5m" } } },
                { "term": { "level": "ERROR" } }
              ]
            }
          },
          "size": 0,
          "aggs": {
            "by_app": {
              "terms": { "field": "app_name" }
            }
          }
        }
      }
    }
  },
  "condition": {
    "compare": { "ctx.payload.hits.total": { "gt": 100 } }
  },
  "actions": {
    "send_email": {
      "email": {
        "to": "devops@company.com",
        "subject": "ERROR日志告警",
        "body": "过去5分钟ERROR日志超过100条，应用分布：{{ctx.payload.aggregations.by_app.buckets}}"
      }
    },
    "send_slack": {
      "slack": {
        "message": {
          "text": "ERROR日志告警：过去5分钟超过100条"
        }
      }
    }
  }
}
```

```latex
或用Prometheus + Alertmanager：
  → Metricbeat采集指标到ES
  → 同时也采集到Prometheus
  → Alertmanager负责告警
```

### 与架构师水平的差距

| 层次 | 回答 |
|------|------|
| 开发 | 会用Kibana看日志 |
| 高级开发 | 会部署ELK，配置Filebeat和Logstash |
| 架构师 | 能设计大规模日志平台架构，考虑采集、缓冲、处理、存储、查询、告警全链路，能做容量规划，设计Hot/Warm分层存储，配置ILM自动管理生命周期 |

**补足方向**：设计日志平台时，先想清楚"数据量多大"、"保留多久"、"查询频率多高"，再选择对应的架构，而不是只堆ELK组件。

---

## 题目三：秒杀订单搜索 — 高并发混合场景

### 场景

秒杀系统需要订单搜索功能：
- 订单量：峰值每秒10万订单，每天1亿订单
- 查询需求：用户查自己的订单、商家查订单、运营后台查订单
- 性能要求：用户查询QPS 5000，响应时间 &lt; 100ms
- 数据量：每天1亿条，保留3个月
- 一致性要求：订单创建后要能立即搜索到

请回答：
1. 订单数据如何存储（MySQL + ES分工）？
2. 订单索引如何设计（分片、路由）？
3. 订单数据如何同步（实时性要求高）？
4. 查询如何优化（routing优化）？
5. 高并发下如何保证ES稳定？

---

## 答案

### 1. 数据存储架构

```latex
MySQL + ES分工：

  MySQL：
    → 存完整订单数据（所有字段）
    → 订单主库：写入
    → 订单从库：读（非实时查询）
    → 是唯一数据源，ES可以重建

  ES：
    → 存订单搜索需要的字段（索引字段）
    → 用于多条件检索、聚合统计
    → 不是唯一数据源，数据来自MySQL

  字段分工：
    → MySQL：所有字段（包括详情、扩展字段等）
    → ES：order_id、user_id、merchant_id、status、create_time、pay_time、amount、product_name等（搜索需要的字段）
```

### 2. 索引设计（重点routing）

```json
PUT /order_index
{
  "settings": {
    "number_of_shards": 32,
    "number_of_replicas": 2,
    "refresh_interval": "1s"
  },
  "mappings": {
    "properties": {
      "order_id": { "type": "keyword" },
      "user_id": { "type": "keyword" },
      "merchant_id": { "type": "keyword" },
      "order_no": { "type": "keyword" },
      "status": { "type": "keyword" },
      "amount": { "type": "scaled_float", "scaling_factor": 100 },
      "product_name": { "type": "text", "analyzer": "ik_max_word" },
      "create_time": { "type": "date" },
      "pay_time": { "type": "date" },
      "routing_key": { "type": "keyword" }
    }
  }
}
```

```latex
为什么用routing？
  → 秒杀订单场景：用户查询自己的订单
  → 用user_id做routing
  → 查询时只查一个分片，不用fan-out到所有32个分片
  → 性能提升32倍（理论）

routing设计：
  → 写入时：routing = user_id
  → 用户查询：routing = user_id
  → 商家查询：需要查询所有分片（商家订单分散在所有分片）
  → 运营查询：需要查询所有分片

trade-off：
  → 用user_id做routing：用户查询快，商家查询慢
  → 用merchant_id做routing：商家查询快，用户查询慢
  → 实际选择：用户查询量更大，优先保证用户体验
```

### 3. 数据同步方案（高实时性）

```latex
秒杀场景同步要求：
  → 订单创建后立即能搜索到
  → 不能有延迟
  → 高并发下不能丢数据

同步方案：

  方案1：双写 + 异步补偿
    → 应用先写MySQL
    → 再同步写ES
    → ES写入失败记录到重试表
    → 后台定时重试
    → Canal做兜底校验

  方案2：事务消息（RocketMQ）
    → 应用写MySQL
    → 同时发事务消息
    → 本地事务成功后才投递消息
    → 消费者消费消息写入ES
    → Canal做兜底

推荐方案1（秒杀场景）：
  → 双写保证实时性
  → 异步补偿保证可靠性
  → Canal兜底保证一致性

为什么？
  → 秒杀场景对实时性要求高
  → 双写可以保证订单创建立即可见
  → 但要处理失败情况
```

```java
// 伪代码：双写 + 补偿
@Transactional
public void createOrder(Order order) {
    // 1. 写MySQL
    orderMapper.insert(order);
    
    try {
        // 2. 同步写ES
        elasticsearchService.index(order);
    } catch (Exception e) {
        // 3. ES写入失败，记录重试表
        retryMapper.insert(new RetryTask(order.getId(), "ORDER_ES_SYNC"));
    }
}

// 后台定时重试
@Scheduled(fixedRate = 5000)
public void retry() {
    List<RetryTask> tasks = retryMapper.selectPendingTasks();
    for (RetryTask task : tasks) {
        Order order = orderMapper.selectById(task.getBizId());
        elasticsearchService.index(order);
        retryMapper.markSuccess(task.getId());
    }
}
```

### 4. 查询优化（routing利用）

```json
// 用户查询自己的订单（用routing）
GET /order_index/_search?routing=user_123
{
  "from": 0,
  "size": 20,
  "sort": [
    { "create_time": "desc" }
  ],
  "query": {
    "bool": {
      "filter": [
        { "term": { "user_id": "user_123" } },
        { "range": { "create_time": { "gte": "now-30d" } } }
      ]
    }
  }
}

// 商家查询订单（不用routing，查所有分片）
GET /order_index/_search
{
  "from": 0,
  "size": 20,
  "query": {
    "bool": {
      "filter": [
        { "term": { "merchant_id": "merchant_456" } }
      ]
    }
  }
}
```

```latex
查询优化思路：
  1. 用户查询用routing，只查一个分片
  2. 所有过滤条件放filter，利用缓存
  3. 用sort按时间排序，不用_score
  4. 限制查询时间范围（只查最近30天）
  5. 源数据过滤，只返回需要的字段

额外优化：
  → 热点用户订单做缓存（Redis）
  → 用户最近订单缓存
  → 缓存时间：5分钟
```

### 5. 高并发下保证ES稳定

```latex
ES稳定保障措施：

  1. 限流降级：
     → 应用层做限流
     → ES查询设置timeout
     → 超过阈值直接返回降级结果

  2. 隔离：
     → 用户查询、商家查询、运营查询用不同索引
     → 或用不同的协调节点
     → 避免互相影响

  3. 熔断：
     → ES集群压力大时自动熔断
     → 暂停非核心查询
     → 优先保证核心查询

  4. 监控告警：
     → 监控ES的JVM、CPU、磁盘
     → 监控查询耗时、错误率
     → 有问题立即告警

  5. 容量规划：
     → 提前扩容
     → 压测验证
     → 留有buffer
```

### 与架构师水平的差距

| 层次 | 回答 |
|------|------|
| 开发 | 会把订单存ES，会查 |
| 高级开发 | 会用routing优化查询，理解双写 |
| 架构师 | 能设计高并发订单搜索架构，考虑MySQL和ES分工、数据同步一致性、routing优化、限流降级、隔离熔断等，能保证ES在高并发下稳定 |

**补足方向**：设计高并发搜索时，先想清楚"读多还是写多"、"谁在查"、"一致性要求多高"，再选择对应的架构，而不是只考虑功能。

---

## 题目四：医疗数据搜索 — 多租户与权限控制场景

### 场景

智慧公卫体检系统需要搜索功能：
- 多租户：100+医院，数据隔离
- 数据量：每个医院100万体检数据，共10亿
- 查询需求：医院只能查自己的数据，总管理员能查所有
- 权限要求：字段级权限（部分字段敏感，需要脱敏）
- 合规要求：数据不能跨医院

请回答：
1. 多租户架构如何设计？
2. 数据隔离如何实现？
3. 字段级权限如何实现？
4. 审计日志如何实现？
5. 合规性如何保证？

---

## 答案

### 1. 多租户架构设计

```latex
多租户架构方案对比：

  方案1：每个租户一个索引
    优点：完全隔离，互不影响
    缺点：索引太多，管理复杂
    适用：租户数量少（<100）

  方案2：所有租户一个索引，用字段区分（tenant_id）
    优点：索引少，管理简单
    缺点：隔离性差，需要用filter
    适用：租户数量多（>1000）

  方案3：混合方案（推荐）
    → 大租户：单独索引
    → 小租户：共享索引，用tenant_id区分
    → 用索引别名统一访问

推荐方案3（医疗场景）：
  → 大医院：单独索引
  → 小医院：共享索引
  → 用routing+tenant_id隔离
```

```json
// 索引别名配置
POST /_aliases
{
  "actions": [
    {
      "add": {
        "index": "physical_exam_hospital_1",
        "alias": "physical_exam",
        "filter": { "term": { "tenant_id": "hospital_1" } }
      }
    },
    {
      "add": {
        "index": "physical_exam_shared",
        "alias": "physical_exam",
        "filter": { "term": { "tenant_id": "hospital_2" } }
      }
    }
  ]
}
```

### 2. 数据隔离实现

```latex
数据隔离手段：

  1. Routing隔离：
     → 写入时用tenant_id做routing
     → 同一个租户的数据在同一个分片
     → 查询时用routing，只查自己的分片

  2. Filter隔离：
     → 查询时强制加tenant_id filter
     → 应用层拦截，确保每个查询都有
     → 或用Document Level Security（ES安全特性）

  3. 索引隔离：
     → 大租户单独索引
     → 完全物理隔离

组合使用（医疗场景）：
  → routing + filter + 索引别名
  → 三层隔离，确保安全
```

```json
// Document Level Security（ES安全特性）
PUT /_security/role/hospital_1_role
{
  "indices": [
    {
      "names": ["physical_exam*"],
      "privileges": ["read"],
      "query": {
        "term": { "tenant_id": "hospital_1" }
      }
    }
  ]
}
```

### 3. 字段级权限实现

```latex
字段级权限方案：

  方案1：应用层处理
    → ES返回所有字段
    → 应用层根据权限过滤字段
    → 缺点：ES返回了敏感数据

  方案2：ES Field Level Security
    → ES原生支持字段级权限
    → 配置role可以访问哪些字段
    → 推荐

  方案3：索引时分离
    → 敏感字段单独存储
    → 或用parent-child
```

```json
// Field Level Security配置
PUT /_security/role/hospital_1_doctor_role
{
  "indices": [
    {
      "names": ["physical_exam*"],
      "privileges": ["read"],
      "query": { "term": { "tenant_id": "hospital_1" } },
      "field_security": {
        "grant": [
          "name", "age", "exam_result", "doctor_id"
        ],
        "except": [
          "id_card", "phone", "address"
        ]
      }
    }
  ]
}

// 字段脱敏（Ingest Pipeline）
PUT /_ingest/pipeline/redact_pipeline
{
  "processors": [
    {
      "set": {
        "field": "id_card",
        "value": "{{#replace id_card '(.{6}).*(.{4})' '$1********$2'}}"
      }
    }
  ]
}
```

### 4. 审计日志实现

```latex
审计日志需求：
  → 记录谁在什么时候查了什么数据
  → 记录谁在什么时候改了什么数据
  → 不可篡改，可追溯

实现方案：
  → ES Audit Log（X-Pack特性）
  → 或应用层记录审计日志
  → 审计日志单独索引，单独存储
  → 保留足够长时间（比如1年）

审计日志内容：
  → 用户ID、租户ID
  → 操作类型（查询/更新/删除）
  → 操作时间
  → 操作内容（查询DSL、更新内容）
  → IP地址
  → 结果（成功/失败）
```

### 5. 合规性保证

```latex
医疗数据合规要求：
  → 数据隔离
  → 权限控制
  → 审计日志
  → 数据加密（传输加密 + 存储加密）
  → 数据备份
  → 数据删除（用户授权）

ES合规措施：
  → TLS加密传输（HTTPS）
  → 磁盘加密
  → Snapshot备份
  → ILM自动删除过期数据
  → 权限控制（DLS + FLS）
  → 审计日志
```

### 与架构师水平的差距

| 层次 | 回答 |
|------|------|
| 开发 | 知道用tenant_id区分 |
| 高级开发 | 会用routing隔离，知道DLS/FLS |
| 架构师 | 能设计合规的多租户搜索架构，考虑数据隔离、权限控制、审计日志、加密、备份、删除全流程，能通过合规审计 |

**补足方向**：设计医疗等合规场景时，先想清楚"合规要求是什么"、"数据隔离到什么程度"、"如何审计"，而不是只考虑功能。

---

## 题目五：ES与系统生态集成

### 场景

ES需要与现有系统生态集成：
- 消息队列：Kafka/RocketMQ
- 缓存：Redis
- 数据库：MySQL/PostgreSQL
- 大数据：Spark/Flink
- 监控：Prometheus/Grafana

请回答：
1. ES与Kafka如何集成？
2. ES与Redis如何配合使用？
3. ES与Spark/Flink如何集成做数据分析？
4. ES与监控系统如何集成？
5. 数据管道如何设计？

---

## 答案

### 1. ES与Kafka集成

```latex
集成场景：
  → 数据从Kafka写入ES
  → ES变更数据发送到Kafka

方案1：Logstash
  → input.kafka
  → filter.处理
  → output.elasticsearch
  → 优点：功能强大，过滤丰富
  → 缺点：重，资源占用大

方案2：Kafka Connect Elasticsearch Sink
  → 官方Connector
  → 轻量
  → 配置化

方案3：自己写消费者
  → 灵活
  → 需要自己处理重试、幂等
```

```properties
# Kafka Connect Elasticsearch Sink配置
name=elasticsearch-sink
connector.class=io.confluent.connect.elasticsearch.ElasticsearchSinkConnector
tasks.max=1
topics=logs,orders
key.ignore=true
connection.url=http://es1:9200
type.name=doc
```

### 2. ES与Redis配合

```latex
配合场景：

  1. 缓存热点数据：
     → 热门搜索结果缓存Redis
     → 缓存时间：5-10分钟
     → 查询先查Redis，没命中查ES

  2. 布隆过滤器：
     → 判断数据是否存在
     → 避免穿透ES

  3. 限流计数：
     → Redis计数
     → 超过阈值限流

  4. Session存储：
     → 用户搜索Session
```

```java
// 伪代码：Redis缓存ES结果
public SearchResult search(SearchRequest request) {
    String cacheKey = buildCacheKey(request);
    
    // 1. 先查Redis
    String cached = redis.get(cacheKey);
    if (cached != null) {
        return JSON.parseObject(cached, SearchResult.class);
    }
    
    // 2. 查ES
    SearchResult result = elasticsearch.search(request);
    
    // 3. 回写Redis（5分钟过期）
    redis.setex(cacheKey, 300, JSON.toJSONString(result));
    
    return result;
}
```

### 3. ES与Spark/Flink集成

```latex
集成场景：
  → 从ES读取数据做离线分析
  → 分析结果写回ES

Spark集成：
  → Elasticsearch for Apache Hadoop
  → 读取ES数据做RDD/DataFrame
  → 分析后写回ES

Flink集成：
  → Flink Elasticsearch Connector
  → 实时流处理，结果写ES

典型场景：
  → 日志分析：Flink消费Kafka → 实时统计 → 写ES
  → 用户画像：Spark分析用户行为 → 写ES供搜索
```

```java
// Spark读ES示例
JavaSparkContext sc = new JavaSparkContext(conf);
JavaPairRDD<String, Map<String, Object>> esRDD = 
    JavaEsSpark.esRDD(sc, "physical_exam");

// 分析后写ES
Map<String, String> esWriteConf = new HashMap<>();
esWriteConf.put("es.resource", "user_profile");
JavaEsSpark.saveToEs(profileRDD, esWriteConf);

// Flink写ES示例
DataStream<Log> logStream = ...;
logStream.addSink(new ElasticsearchSink<>(
    config, transports, new ElasticsearchSinkFunction<Log>() {
        @Override
        public void process(Log element, RuntimeContext ctx, RequestIndexer indexer) {
            indexer.add(Requests.indexRequest()
                .index("log_analysis")
                .source(JSON.toJSONString(element), XContentType.JSON));
        }
    }
);
```

### 4. ES与监控系统集成

```latex
监控集成：

  ES指标采集：
    → Metricbeat采集ES指标
    → 或Prometheus Exporter
    → 采集JVM、CPU、磁盘、查询性能

  监控展示：
    → Grafana做Dashboard
    → Kibana也可以自己做

  告警：
    → Alertmanager告警
    → 或ES Watcher

  链路追踪：
    → APM集成
    → 追踪ES查询耗时
```

### 5. 数据管道设计

```latex
完整数据管道：

  数据源 → 采集 → 消息队列 → 处理 → 存储 → 查询/分析
  ↑                                                      ↓
  MySQL → Canal/Debezium → Kafka → Flink/Logstash → ES → Kibana/Grafana

各组件职责：
  → 数据源：MySQL/日志/设备
  → 采集：Filebeat/Canal/Debezium
  → 消息队列：Kafka（缓冲削峰）
  → 处理：Flink/Logstash/Spark
  → 存储：ES（查询） + MySQL（事务） + HDFS（归档）
  → 查询：应用/Kibana/Grafana
```

### 与架构师水平的差距

| 层次 | 回答 |
|------|------|
| 开发 | 会用ES做查询 |
| 高级开发 | 会集成Kafka，会用Redis缓存 |
| 架构师 | 能设计完整的数据管道，将ES融入整个系统生态，与消息队列、缓存、数据库、大数据、监控等系统有机结合，形成完整的数据闭环 |

**补足方向**：设计ES集成时，先想清楚"ES在整个系统中扮演什么角色"、"数据从哪来，到哪去"、"如何与其他系统配合"，而不是孤立地用ES。

---

## Day05核心总结

```latex
Day05主线：ES不是独立存在的，要与业务系统、数据库、消息队列、缓存、大数据等系统集成，形成完整的架构。

  电商搜索场景：
    → 索引设计：合理的Mapping、分词器
    → 数据同步：Canal + Kafka
    → 搜索DSL：multi_match + filter + 聚合
    → 高可用：多副本 + 缓存

  日志分析场景：
    → ELK架构：Filebeat → Kafka → Logstash → ES → Kibana
    → ILM：Hot/Warm/Cold分层 + 自动删除
    → 告警：Watcher/Alertmanager

  秒杀订单场景：
    → MySQL + ES分工：MySQL存完整数据，ES存索引字段
    → Routing优化：用user_id做routing，只查一个分片
    → 数据同步：双写 + 异步补偿 + Canal兜底
    → 高并发保障：限流降级、隔离、熔断

  医疗多租户场景：
    → 多租户架构：混合方案（大租户单独索引，小租户共享）
    → 数据隔离：routing + filter + DLS
    → 字段权限：FLS
    → 合规保障：审计日志、加密、备份

  系统生态集成：
    → Kafka：数据管道
    → Redis：缓存热点
    → Spark/Flink：数据分析
    → 监控：Prometheus/Grafana
```

---

*日期：2026-06-19 | 2026年06月第3周 Day5 | ES实战综合 — 业务系统集成与典型场景*