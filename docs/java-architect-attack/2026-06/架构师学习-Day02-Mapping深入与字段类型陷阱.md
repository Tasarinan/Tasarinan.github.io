# Day 2：Mapping深入与字段类型陷阱 — object/nested/动态映射/Index Template（练习整理）

## 题目一：object vs nested — 为什么查询结果不对？

### 场景

你要在 ES 中存储保险保单，每个保单有多个被保险人：

```json
PUT /policy/_doc/1
{
  "policy_no": "P20260616001",
  "insureds": [
    { "name": "张三", "age": 30, "relation": "被保险人" },
    { "name": "李四", "age": 28, "relation": "受益人" }
  ]
}
```

现在你想查询：**"被保险人是张三，且年龄30岁"**

执行查询：

```json
GET /policy/_search
{
  "query": {
    "bool": {
      "must": [
        { "match": { "insureds.name": "张三" }},
        { "match": { "insureds.age": 30 }}
      ]
    }
  }
}
```

结果发现：不仅返回了保单1，还返回了下面这个保单2：

```json
PUT /policy/_doc/2
{
  "policy_no": "P20260616002",
  "insureds": [
    { "name": "张三", "age": 28, "relation": "被保险人" },
    { "name": "李四", "age": 30, "relation": "受益人" }
  ]
}
```

请回答：
1. 为什么保单2会被返回？
2. `object` 类型是如何存储数组的？
3. `nested` 类型解决了什么问题？
4. `nested` 查询怎么写？
5. `object` 和 `nested` 分别适合什么场景？

---

## 答案

### 1. 为什么保单2会被返回？

```latex
原因：object 类型把数组扁平化存储了。

保单2的 insureds 数组在 ES 内部实际上被存储成：
  insureds.name: ["张三", "李四"]
  insureds.age: [28, 30]
  insureds.relation: ["被保险人", "受益人"]

查询条件：
  name="张三" 且 age=30

ES 的判断：
  "张三" 在 name 数组里 ✅
  30 在 age 数组里 ✅
  → 认为匹配，返回保单2

但这不是我们想要的！
我们要的是：同一个被保险人既是张三，年龄又是30。
而不是：张三存在，30也存在。
```

### 2. object 类型的存储方式

object 类型对数组的处理是**扁平化（flatten）**：

```latex
原始文档：
{
  "insureds": [
    { "name": "张三", "age": 28 },
    { "name": "李四", "age": 30 }
  ]
}

ES 内部存储（倒排索引）：
  insureds.name → ["张三", "李四"]
  insureds.age → [28, 30]

对象之间的边界消失了！
张三的年龄是28，李四的年龄是30 → 但被打散成两个独立数组
查询时只能判断"有没有"，不能判断"是否在同一个对象里"
```

### 3. nested 类型解决了什么问题？

nested 类型会把数组里的每个对象作为**独立的隐藏文档**存储：

```latex
nested 文档存储结构：

  根文档（主文档）：
    policy_no: "P20260616002"

  nested 文档1（隐藏）：
    insureds.name: "张三"
    insureds.age: 28
    insureds.relation: "被保险人"

  nested 文档2（隐藏）：
    insureds.name: "李四"
    insureds.age: 30
    insureds.relation: "受益人"

每个 nested 对象独立存储，对象内部的字段关联关系保留！
查询时可以要求"同一个 nested 文档内匹配多个条件"
```

### 4. nested 查询怎么写？

首先要把字段类型定义为 `nested`：

```json
PUT /policy
{
  "mappings": {
    "properties": {
      "policy_no": { "type": "keyword" },
      "insureds": {
        "type": "nested",  // 关键：声明为 nested
        "properties": {
          "name": { "type": "keyword" },
          "age": { "type": "integer" },
          "relation": { "type": "keyword" }
        }
      }
    }
  }
}
```

然后用 `nested` 查询：

```json
GET /policy/_search
{
  "query": {
    "nested": {
      "path": "insureds",  // nested 字段路径
      "query": {
        "bool": {
          "must": [
            { "match": { "insureds.name": "张三" }},
            { "match": { "insureds.age": 30 }}
          ]
        }
      }
    }
  }
}
```

现在只有保单1会被返回，保单2不会被返回！

### 5. nested 聚合也很重要

如果要统计"各年龄段的被保险人数量"：

```json
GET /policy/_search
{
  "size": 0,
  "aggs": {
    "insureds": {
      "nested": { "path": "insureds" },  // 先进入 nested 上下文
      "aggs": {
        "age_group": {
          "range": {
            "field": "insureds.age",
            "ranges": [
              { "to": 30 },
              { "from": 30, "to": 50 },
              { "from": 50 }
            ]
          }
        }
      }
    }
  }
}
```

### 6. object vs nested 选型

| 场景 | 推荐类型 | 原因 |
|------|---------|------|
| 标签数组 `["a", "b", "c"]` | object/keyword | 扁平数组，不需要对象关联 |
| 单对象 `{ "city": "北京", "district": "朝阳" }` | object | 只有一个对象，不会混淆 |
| 对象数组，需要"同一对象内多字段匹配" | nested | 必须保留对象边界 |
| 日志里的多个事件，每个事件有多个字段 | nested | 需要独立查询每个事件 |
| 不需要跨字段匹配的对象数组 | object | nested 性能差，没必要用 |

```latex
object 的问题：
  数组对象被扁平化，丢失对象边界
  跨字段匹配会出现"张三的年龄匹配了李四的数据"

nested 的代价：
  ① 每个 nested 对象是独立隐藏文档，存储成本高
  ② nested 查询比普通查询慢
  ③ 更新一个 nested 对象，整个根文档要重新索引（段不可变）
  ④ nested 文档越多，性能越差

所以：
  确实需要对象边界 → 用 nested
  只是扁平数组 → 别用 nested
```

### 与架构师水平的差距

| 层次 | 回答 |
|------|------|
| 开发 | ES 可以存对象数组，用 object 类型 |
| 高级开发 | object 会扁平化，查询结果不对时要用 nested |
| 架构师 | 能讲清楚 object 扁平化的存储原理、nested 隐藏文档的实现、nested 查询/聚合的写法，以及 nested 的性能代价（存储、查询、更新）。选型时会按"是否需要同一对象内多字段匹配"来决定，不滥用 nested，也不会在需要时忘记用 |

**补足方向**：看到对象数组第一反应是"会不会需要跨字段匹配"，如果是"被保险人姓名+年龄"这种场景，直接上 nested；如果是"标签数组"这种扁平结构，object 就够了。

---

## 题目二：动态映射陷阱 — 为什么数字变成了 text？

### 场景

你的日志系统用 ES 动态映射（dynamic mapping）自动识别字段类型：

```json
PUT /logs/_doc/1
{
  "order_id": "12345",      // 看起来像数字，但加了引号
  "amount": 100.50,         // 数字
  "status": "PAID",         // 字符串
  "create_time": "2026-06-16"  // 日期
}
```

过了一会儿写入第二条日志：

```json
PUT /logs/_doc/2
{
  "order_id": 67890,        // 这次是数字，没加引号
  "amount": "200.00",       // 加了引号
  "status": "REFUND",
  "create_time": 1718505600000  // 时间戳
}
```

结果报错：`mapper_parsing_exception`。

请回答：
1. 动态映射的类型推断规则是什么？
2. 第一条日志写入后，各字段是什么类型？
3. 为什么第二条会报错？
4. `dynamic: true/false/strict` 分别是什么意思？
5. 如何避免动态映射的陷阱？

---

## 答案

### 1. 动态映射的类型推断规则

ES 会根据第一次写入的字段值类型来推断字段类型：

```latex
第一次值类型 → 推断结果
  null → 忽略，等待下一个非 null 值
  true/false → boolean
  整数 → long
  浮点数 → float
  日期格式字符串 → date
  其他字符串 → text + keyword（多字段）
  对象 → object
  数组 → 根据第一个非 null 元素推断
```

### 2. 第一条日志写入后的类型

```json
PUT /logs/_doc/1
{
  "order_id": "12345",      // 字符串 → text + keyword
  "amount": 100.50,         // 浮点数 → float
  "status": "PAID",         // 字符串 → text + keyword
  "create_time": "2026-06-16"  // 日期格式 → date
}
```

实际 mapping：
```json
{
  "order_id": {
    "type": "text",
    "fields": { "keyword": { "type": "keyword", "ignore_above": 256 }}
  },
  "amount": { "type": "float" },
  "status": {
    "type": "text",
    "fields": { "keyword": { "type": "keyword", "ignore_above": 256 }}
  },
  "create_time": { "type": "date" }
}
```

### 3. 第二条日志为什么报错？

```latex
第二条日志：
  "order_id": 67890 → long，但已定义为 text → 类型冲突 ✗
  "amount": "200.00" → text，但已定义为 float → 类型冲突 ✗
  "create_time": 1718505600000 → 时间戳，date 类型可以接受 ✅

ES 字段类型一旦确定就不能改！
这是段不可变决定的：已写入的段已经按 text 类型建了倒排索引，
不可能突然把这些段改成 long 类型。
```

### 4. dynamic 的三种模式

| 模式 | 新字段行为 | 类型不匹配 | 适用场景 |
|------|-----------|-----------|---------|
| `dynamic: true` | 自动添加字段，自动推断类型 | 报错 | 开发环境、快速原型 |
| `dynamic: false` | 新字段被忽略（不索引，只存 `_source`） | 不报错 | 不关心的字段可以不索引 |
| `dynamic: strict` | 新字段直接报错 | 报错 | 生产环境，严格控制字段 |

生产环境建议 `dynamic: strict`：

```json
PUT /logs
{
  "mappings": {
    "dynamic": "strict",  // 严格模式
    "properties": {
      "order_id": { "type": "keyword" },
      "amount": { "type": "scaled_float", "scaling_factor": 100 },
      "status": { "type": "keyword" },
      "create_time": { "type": "date" }
    }
  }
}
```

### 5. 日期动态映射的注意事项

日期推断也会踩坑：

```latex
第一条："create_time": "2026-06-16" → date ✅
第二条："create_time": "not a date" → 想存字符串，但已经是 date 了 ✗

或者反过来：
第一条："create_time": "hello" → text ✅
第二条："create_time": "2026-06-16" → 想存日期，但已经是 text 了 ✗
```

可以关闭日期自动推断：

```json
PUT /logs
{
  "mappings": {
    "date_detection": false,  // 关闭日期自动检测
    "properties": {
      "create_time": { "type": "date" }  // 显式定义日期字段
    }
  }
}
```

### 6. 数字也会踩坑：字符串 vs 数字

```latex
场景：订单号
  第一条："order_id": "12345" → 字符串 → text + keyword
  第二条："order_id": 12345 → 数字 → 类型冲突

订单号、手机号这种看起来像数字，但不需要计算的字段：
  → 显式定义为 keyword！
  → 不要让 ES 推断
  → 不要用 text（不需要全文检索）
```

### 7. 避免动态映射陷阱的最佳实践

```latex
生产环境三条铁律：
  ① 禁用动态映射：dynamic: strict
  ② 显式定义所有字段类型
  ③ 用 Index Template 批量管理索引

开发环境可以：
  ① dynamic: true 先跑起来
  ② 用 GET /index/_mapping 看自动生成的 mapping
  ③ 基于自动生成的结果，手动优化成正式 mapping
```

### 与架构师水平的差距

| 层次 | 回答 |
|------|------|
| 开发 | ES 会自动识别字段类型，很方便 |
| 高级开发 | 动态映射可能有类型冲突，最好手动定义 mapping |
| 架构师 | 能讲清楚 dynamic 三种模式的区别、date_detection 的陷阱、为什么订单号要用 keyword 而不是 text/long。生产环境会强制 strict 模式，用 Index Template 统一管理，不会让字段类型"随机"确定 |

**补足方向**：不要相信"ES 自动识别类型很智能"，生产环境必须严格控制，所有字段提前定义好。

---

## 题目三：Index Template — 如何给每天的索引自动应用 mapping？

### 场景

你的日志系统每天创建一个新索引：
- `logs-2026.06.16`
- `logs-2026.06.17`
- `logs-2026.06.18`
- ...

你希望：
1. 所有 `logs-*` 索引自动应用相同的 mapping
2. 不同环境（dev/prod）用不同的副本数
3. 预留 10 分钟的 index pattern（防止时区问题）

请回答：
1. Index Template 如何匹配索引？
2. Template 优先级怎么定？
3. Component Template 和 Index Template 有什么区别？
4. 如何给日志索引设计 Template？
5. dynamic_template 是什么？

---

## 答案

### 1. Index Template 的基本用法

ES 7.8+ 推荐用 **Composable Index Template**：

```json
PUT _index_template/logs_template
{
  "index_patterns": ["logs-*"],  // 匹配 logs- 开头的索引
  "template": {
    "settings": {
      "number_of_shards": 3,
      "number_of_replicas": 1,
      "refresh_interval": "30s"
    },
    "mappings": {
      "dynamic": "strict",
      "properties": {
        "@timestamp": { "type": "date" },
        "level": { "type": "keyword" },
        "message": { "type": "text" },
        "service": { "type": "keyword" }
      }
    },
    "aliases": {
      "logs_read": {}  // 自动绑定别名
    }
  },
  "priority": 100,  // 优先级，数字越大越优先
  "version": 1,     // 版本号，方便管理
  "_meta": {        // 自定义元数据
    "description": "日志索引模板",
    "owner": "infra"
  }
}
```

现在创建 `logs-2026.06.16` 时会自动应用这个模板！

### 2. 模板匹配规则

```latex
多个模板都匹配时的优先级：
  ① 看 priority 字段，数字越大优先级越高
  ② priority 相同的话，不确定（不建议）

例子：
  template A: index_patterns: ["*"], priority: 10 → 默认配置
  template B: index_patterns: ["logs-*"], priority: 100 → 日志专用
  template C: index_patterns: ["logs-prod-*"], priority: 200 → 生产日志

创建 logs-prod-2026.06.16 时：
  匹配 A、B、C
  选 priority 最高的 C
  → 应用 template C
```

### 3. Component Template：可复用的组件

把通用配置抽成 Component Template，可以被多个 Index Template 引用：

```json
// 第一步：创建通用 settings component
PUT _component_template/common_settings
{
  "template": {
    "settings": {
      "number_of_replicas": 1,
      "refresh_interval": "30s"
    }
  }
}

// 第二步：创建通用 mappings component
PUT _component_template/common_mappings
{
  "template": {
    "mappings": {
      "@timestamp": { "type": "date" },
      "service": { "type": "keyword" }
    }
  }
}

// 第三步：Index Template 引用 components
PUT _index_template/logs_template
{
  "index_patterns": ["logs-*"],
  "composed_of": ["common_settings", "common_mappings"],  // 引用组件
  "template": {
    "settings": { "number_of_shards": 3 },
    "mappings": {
      "properties": {
        "level": { "type": "keyword" },
        "message": { "type": "text" }
      }
    }
  },
  "priority": 100
}
```

### 4. 环境隔离的模板设计

```json
// 开发环境模板
PUT _index_template/logs_dev_template
{
  "index_patterns": ["logs-dev-*"],
  "composed_of": ["common_settings", "common_mappings"],
  "template": {
    "settings": {
      "number_of_replicas": 0,  // 开发环境 0 副本
      "number_of_shards": 1
    }
  },
  "priority": 150
}

// 生产环境模板
PUT _index_template/logs_prod_template
{
  "index_patterns": ["logs-prod-*"],
  "composed_of": ["common_settings", "common_mappings"],
  "template": {
    "settings": {
      "number_of_replicas": 2,  // 生产环境 2 副本
      "number_of_shards": 6
    }
  },
  "priority": 200
}
```

### 5. dynamic_template：按规则自动映射字段

有些字段名有规律，比如所有 `*_id` 都应该是 keyword，所有 `*_time` 都应该是 date：

```json
PUT _index_template/logs_template
{
  "index_patterns": ["logs-*"],
  "template": {
    "mappings": {
      "dynamic_templates": [
        {
          "ids_as_keyword": {
            "match": "*_id",          // 匹配 *_id
            "match_mapping_type": "string",
            "mapping": { "type": "keyword" }
          }
        },
        {
          "dates_as_date": {
            "match": "*_time",       // 匹配 *_time
            "match_mapping_type": "string",
            "mapping": { "type": "date" }
          }
        },
        {
          "strings_as_keyword": {
            "match_mapping_type": "string",
            "mapping": { "type": "keyword" }  // 其他字符串默认 keyword
          }
        }
      ]
    }
  }
}
```

现在写入字段时：
- `order_id` → 自动 keyword
- `create_time` → 自动 date
- `status` → 自动 keyword

### 6. Index Template 最佳实践

```latex
生产环境建议：
  ① 用 Composable Index Template，不要用 Legacy Template
  ② 抽 Component Template，复用通用配置
  ③ 按环境（dev/prod）、按业务（logs/order/user）分层模板
  ④ priority 留好间隔（100, 200, 300），方便插入新模板
  ⑤ 加 version 和 _meta，方便追踪变更

时区问题处理：
  每天 23:50 创建明天的索引，不要等到 00:00
  或者 index pattern 用 logs-2026.06.16-12 这种小时级
  防止时区导致的跨天问题
```

### 与架构师水平的差距

| 层次 | 回答 |
|------|------|
| 开发 | 每次创建索引手动指定 mapping |
| 高级开发 | 用 Index Template 自动应用 mapping |
| 架构师 | 能设计 Composable Index Template + Component Template 的分层结构，区分 dev/prod 的副本数和分片数，用 dynamic_template 处理有规律的字段，考虑时区预留创建索引，用 version/_meta 管理模板变更 |

**补足方向**：不要每次手动建索引，所有索引都要通过模板管理，且模板要按环境、按业务分层。

---

## 题目四：字段类型踩坑集锦 — 这些坑你遇到过吗？

### 场景

下面是真实生产环境遇到过的问题，请分析原因和解决方案：

1. **场景一**：手机号字段用了 text，结果查询 "13800138000" 时，返回了 "13800138000" 和 "13800138001"（因为分词了）
2. **场景二**：订单号字段用了 long，结果 "001234" 存进去变成了 1234，前导零丢了
3. **场景三**：价格字段用了 float，结果存 "0.1" 变成了 "0.10000000149"
4. **场景四**：IP 字段用了 keyword，结果想查 "192.168.1.0/24" 网段查不了
5. **场景五**：地理坐标存成了两个 float 字段（lat/lon），结果没法做范围查询

请回答：每个场景的正确字段类型是什么？为什么？

---

## 答案

### 1. 场景一：手机号 → keyword，不要用 text

```latex
问题：
  手机号用 text → 被分词 → 查 13800138000 可能匹配到 13800138001

为什么？
  text 类型默认会分词（standard analyzer）
  "13800138000" 可能被切分成 "138"、"0013"、"8000" 等词项
  导致查询时误匹配

正确做法：
  { "type": "keyword" }

什么时候用 text？
  需要全文检索的字段：商品标题、文章内容、用户评论
  需要分词才能搜到的内容

什么时候用 keyword？
  精确匹配的字段：手机号、身份证号、订单号、状态枚举、标签
  需要聚合/排序的字段
```

### 2. 场景二：订单号 → keyword，不要用 long

```latex
问题：
  订单号用 long → "001234" 变成 1234 → 前导零丢失
  订单号超过 2^63-1 → long 存不下
  订单号里有字母 → 直接报错

为什么？
  订单号本质是"标识符"，不是"数字"
  标识符不需要加减乘除
  标识符可能有前导零、字母、分隔符

正确做法：
  { "type": "keyword" }

类似的：
  身份证号、银行卡号、工号 → 都用 keyword
```

### 3. 场景三：金额 → scaled_float，不要用 float/double

```latex
问题：
  价格用 float → 0.1 存成 0.10000000149 → 精度丢失
  金额计算时 0.1 + 0.2 = 0.30000000000000004

为什么？
  float/double 是二进制浮点数
  十进制小数 0.1 在二进制里是无限循环小数
  存储时会舍入 → 精度丢失

正确做法：
  {
    "type": "scaled_float",
    "scaling_factor": 100  // 精确到分
  }

原理：
  0.1 元 × 100 = 10 → 作为整数存储
  内部存整数，避免浮点数精度问题
  查询时自动除以 scaling_factor

或者用 keyword + BigDecimal（应用层处理）：
  极端精确场景（财务、资金）→ 存字符串，应用层用 BigDecimal 计算
```

### 4. 场景四：IP → ip 类型，不要用 keyword

```latex
问题：
  IP 用 keyword → 想查 "192.168.1.0/24" 网段查不了
  只能精确匹配单个 IP

正确做法：
  { "type": "ip" }

查询网段：
  GET /access_logs/_search
  {
    "query": {
      "term": {
        "client_ip": "192.168.1.0/24"
      }
    }
  }

ip 类型还支持 IPv6！
```

### 5. 场景五：地理坐标 → geo_point，不要用两个 float

```latex
问题：
  lat: 39.9, lon: 116.4 → 分开存 → 没法做"查询 5km 内的门店"

正确做法：
  { "type": "geo_point" }

写入：
  PUT /store/_doc/1
  { "location": { "lat": 39.9, "lon": 116.4 }}

查询半径 5km 内：
  GET /store/_search
  {
    "query": {
      "geo_distance": {
        "distance": "5km",
        "location": { "lat": 39.9, "lon": 116.4 }
      }
    }
  }

还支持 geo_bounding_box（矩形范围）、geo_polygon（多边形）
```

### 6. 字段类型选型速查表

| 字段 | 推荐类型 | 理由 |
|------|---------|------|
| 手机号、身份证号、订单号 | keyword | 标识符，精确匹配，不需要计算 |
| 状态、标签、枚举 | keyword | 精确匹配、聚合排序 |
| 商品标题、文章内容 | text | 需要全文检索、分词 |
| 金额、价格 | scaled_float 或 keyword | 避免浮点数精度问题 |
| IP 地址 | ip | 支持网段查询、IPv4/IPv6 |
| 地理坐标 | geo_point | 支持地理位置查询 |
| 日期 | date | 支持范围查询、时间聚合 |
| 年龄、数量 | integer/long | 数值范围查询 |
| 数组（非对象） | keyword/text | 看元素类型 |
| 对象数组（需跨字段匹配） | nested | 保留对象边界 |

### 与架构师水平的差距

| 层次 | 回答 |
|------|------|
| 开发 | 字符串用 text，数字用 long/float |
| 高级开发 | 标识符用 keyword，金额要注意精度 |
| 架构师 | 能完整讲出上面速查表的选型理由，包括为什么订单号用 keyword 不用 long、为什么金额用 scaled_float 不用 float、为什么 geo_point 比两个 float 好。设计 mapping 时会先问清楚每个字段的查询方式（精确匹配？全文检索？范围查询？地理位置查询？），再选类型 |

**补足方向**：设计 mapping 不要上来就写类型，先问"这个字段怎么查"：查精确值→keyword，查关键词→text，查范围→integer/date，查位置→geo_point，查网段→ip。

---

## 题目五：Mapping 变更 — 字段类型错了怎么改？

### 场景

线上索引 `order-2026.06` 的 `order_id` 字段不小心定义成了 text，现在想改成 keyword。

请回答：
1. 为什么不能直接修改现有字段的类型？
2. 如何正确地"修改" mapping？
3. reindex 过程中如何保证服务不中断？
4. alias 切换有什么注意事项？

---

## 答案

### 1. 为什么不能直接修改字段类型？

```latex
段不可变（Immutable Segments）决定的：
  ① 已写入的段已经按 text 类型建了倒排索引
  ② 倒排索引里存的是分词后的词项
  ③ 如果突然改成 keyword，这些已存在的段没法处理
  ④ keyword 需要的是完整值的倒排索引，不是分词后的

所以 ES 不允许修改已存在字段的类型！
只能新建索引，重新索引数据。
```

### 2. 正确的变更流程

```latex
步骤：
  ① 新建一个索引，用正确的 mapping
  ② 把旧索引数据 reindex 到新索引
  ③ 用 alias 切换读写流量
  ④ 删除旧索引（确认没问题后）
```

具体操作：

```json
// 步骤1：创建新索引，正确的 mapping
PUT /order-2026.06-v2
{
  "mappings": {
    "properties": {
      "order_id": { "type": "keyword" },  // 正确！
      "amount": { "type": "scaled_float", "scaling_factor": 100 }
    }
  }
}

// 步骤2：reindex 数据
POST _reindex
{
  "source": { "index": "order-2026.06" },
  "dest": { "index": "order-2026.06-v2" }
}

// 步骤3：用 alias 切换（先做好 alias 规划）
POST /_aliases
{
  "actions": [
    { "remove": { "index": "order-2026.06", "alias": "order_read" }},
    { "add": { "index": "order-2026.06-v2", "alias": "order_read" }}
  ]
}

// 步骤4：删除旧索引（确认没问题后）
DELETE /order-2026.06
```

### 3. 零停机切换：alias 的重要性

```latex
一开始就应该用 alias，不要直接读写索引名：

  应用只读写 alias：order_write、order_read
  而不是直接读写：order-2026.06

好处：
  切换索引时，应用不需要改代码
  只用修改 alias 指向

推荐做法：
  写 alias 只指向一个索引（避免双写）
  读 alias 可以指向多个索引（跨天查询）
```

### 4. Reindex 优化

大数据量 reindex 可能很慢，可以优化：

```json
POST _reindex?wait_for_completion=false
{
  "source": {
    "index": "order-2026.06",
    "slice": "auto",  // 并行切片
    "size": 5000     // 每批 5000 条
  },
  "dest": {
    "index": "order-2026.06-v2"
  }
}

// wait_for_completion=false 后台执行
// 用 GET _tasks/<task_id> 查看进度
```

### 5. 有新写入怎么办？

如果 reindex 期间还有新数据写入旧索引：

```latex
方案1：双写
  应用同时写旧索引和新索引
  reindex 历史数据
  验证一致后切读
  停双写

方案2：按时间分片
  新索引用新 mapping 接收新数据
  旧索引只读
  用 alias 同时读新 + 旧

方案3：停机维护（非核心业务）
  停写 → reindex → 切 alias → 恢复
```

### 与架构师水平的差距

| 层次 | 回答 |
|------|------|
| 开发 | 直接 PUT mapping 修改类型（发现报错） |
| 高级开发 | 新建索引 reindex 数据，然后切 alias |
| 架构师 | 从一开始就设计 alias 机制，不让应用直接碰索引名；mapping 变更前先在测试环境验证；reindex 时考虑切片并行、分批大小；切换时有回滚预案（alias 可以切回来）；变更后监控查询性能 |

**补足方向**：生产环境索引一定要用 alias，不要让应用直接读写物理索引名，否则哪天需要 reindex 切换时会很痛苦。

---

## Day2核心总结

```latex
Day2主线：Mapping 不是随便定义的，每个字段类型选择都决定了查询能力和性能。

  object vs nested：
    object 扁平化数组，丢失对象边界
    nested 把每个对象存成独立隐藏文档，保留边界
    nested 查询/聚合要加 nested 关键字
    不需要对象边界时别用 nested（性能代价）

  动态映射陷阱：
    字段类型一旦确定不能改
    生产环境用 dynamic: strict
    date_detection 可能踩坑，建议关闭后显式定义
    不要让 ES 推断类型，所有字段显式定义

  Index Template：
    用 Composable Index Template + Component Template
    按环境（dev/prod）、按业务分层模板
    priority 留好间隔，version/_meta 方便管理
    dynamic_template 处理有规律的字段（*_id、*_time）

  字段类型选型：
    标识符（手机号、订单号）→ keyword
    金额 → scaled_float（别用 float）
    IP → ip（支持网段查询）
    地理位置 → geo_point
    需要分词才用 text，否则优先 keyword

  Mapping 变更：
    不能直接修改字段类型
    新建索引 → reindex → alias 切换
    从一开始就用 alias，别让应用碰物理索引名
```

---

*日期：2026-06-16 | 2026年06月第3周 Day2 | Mapping深入与字段类型陷阱*