# Day 2：Mapping深入与字段类型陷阱 — 架构师梳理

> 2026-06-16 | 2026年06月第3周 Day2 | ES 专题

---

## 一、架构师视角：Mapping 是什么？

```latex
Mapping 不是"字段类型定义"那么简单，它是：
  ① 存储模型：决定数据如何在磁盘上组织
  ② 索引模型：决定倒排索引如何构建
  ③ 查询模型：决定你能做什么查询、不能做什么查询
  ④ 性能模型：决定查询速度、写入速度、存储成本

设计 Mapping 之前，先问三个问题：
  Q1：这个字段怎么查？（精确匹配？全文检索？范围查询？）
  Q2：这个字段怎么聚合/排序？
  Q3：这个字段的数据量和写入QPS是多少？

Mapping 设计是"面向查询"的，不是"面向数据结构"的。
```

---

## 二、object vs nested 深度剖析

### 2.1 object 的扁平化存储原理

```latex
为什么 object 要扁平化？
  ES 的倒排索引是"字段 → 文档"的结构
  不支持嵌套文档的原生表示
  扁平化是妥协方案

object 存储的细节：
  文档：
    {
      "insureds": [
        { "name": "张三", "age": 28 },
        { "name": "李四", "age": 30 }
      ]
    }

  倒排索引实际存储：
    insureds.name → "张三" → doc1
    insureds.name → "李四" → doc1
    insureds.age → 28 → doc1
    insureds.age → 30 → doc1

  问题：倒排索引里没有"张三-28"的关联
        只有"张三存在"且"28存在"
        无法判断是不是同一个人
```

### 2.2 nested 的隐藏文档实现

```latex
nested 的本质：
  把数组里的每个对象存成独立的"隐藏文档"
  隐藏文档和根文档有物理关联，但独立索引

存储结构：
  根文档 doc1:
    _id: "1"
    _source: { "policy_no": "P001" }

  nested 隐藏文档 doc1#0:
    _id: "1#0" (内部表示)
    _source: { "name": "张三", "age": 28 }
    _nested: { "path": "insureds", "parent": "1" }

  nested 隐藏文档 doc1#1:
    _id: "1#1"
    _source: { "name": "李四", "age": 30 }
    _nested: { "path": "insureds", "parent": "1" }

查询原理：
  1. 先查 nested 隐藏文档，找到符合条件的
  2. 再找到对应的根文档返回

为什么 nested 性能差？
  ① 存储更多文档（1根 + N nested）
  ② 查询要做 join（nested 文档 → 根文档）
  ③ 更新一个 nested 对象，整个根文档重新索引
```

### 2.3 nested 的代价量化

```latex
假设一个索引有 1000 万根文档，每个根文档平均 5 个 nested 对象：

  不用 nested：1000 万文档
  用 nested：1000 万 + 5000 万 = 6000 万文档

存储膨胀：
  nested 文档也有自己的段文件、元数据
  存储成本可能增加 2x-5x

查询性能：
  nested 查询要先查 nested 文档，再关联根文档
  比普通查询慢 2x-10x（取决于数据量）

更新性能：
  根文档任意字段更新 → 整个根文档 + 所有 nested 文档重索引
  nested 对象更新 → 整个根文档 + 所有 nested 文档重索引
 （段不可变决定的，局部更新不可能）

所以：
  确实需要对象边界才用 nested
  能用 object 就别用 nested
```

### 2.4 nested 替代方案

```latex
方案1：数据扁平化（反范式）
  场景：每个保单只有一个主被保险人
  做法：
    {
      "policy_no": "P001",
      "main_insured_name": "张三",
      "main_insured_age": 28,
      "beneficiary_name": "李四",
      "beneficiary_age": 30
    }
  优点：不用 nested，查询快
  缺点：结构不灵活，只能固定几个

方案2：父子文档（join 类型）
  场景：嵌套层级深、更新频繁
  做法：把嵌套对象拆成独立文档，用 join 关联
  优点：可以独立更新子文档
  缺点：查询更复杂，性能更差

方案3：应用层组装
  场景：读多写少，对一致性要求不高
  做法：MySQL 存原始数据，ES 存扁平后的搜索视图
  优点：ES 查询简单，MySQL 保证关系一致性
  缺点：要双写，有延迟
```

---

## 三、动态映射：为什么生产环境要禁用？

### 3.1 动态映射的不确定性

```latex
动态映射的问题：
  ① 字段类型取决于"第一次写入的值"
  ② 第一次写入时不小心加了引号 → 变成 text
  ③ 第一次写入是 null → 等下一个非 null 值
  ④ 日期格式没对齐 → 一会儿 date 一会儿 text
  ⑤ 不同分片可能推断出不同类型（理论上不会，实际有风险）

这就像：
  代码里不定义变量类型，根据第一次赋值自动推断
  第一次赋 1 → int
  第二次想赋 "hello" → 报错
  而且类型确定了就不能改

生产环境不能接受这种不确定性！
```

### 3.2 严格模式 + Index Template = 最佳实践

```latex
生产环境 Mapping 管理流程：

  1. 开发环境先用 dynamic: true 跑通
     → GET /index/_mapping 看自动生成的结果

  2. 基于自动生成的结果，手动优化：
     → 把不需要分词的 text 改成 keyword
     → 把金额的 float 改成 scaled_float
     → 把 IP、地理位置用专用类型
     → 补充 ignore_above、scaling_factor 等参数

  3. 写入 Index Template，设为 dynamic: strict
     → 确保新字段必须显式定义，不能随机添加

  4. 用 Component Template 复用通用配置
     → 避免每个 Index Template 复制粘贴

  5. template 加 version 和 _meta
     → 方便追踪变更历史和负责人
```

### 3.3 dynamic_template 的合理使用

```latex
dynamic_template 不是"不用定义字段"，而是"按规则自动定义"：

  适合用 dynamic_template 的场景：
    ① 字段名有规律：*_id、*_time、*_status
    ② 同一类字段用相同类型
    ③ 不想每个字段都写一遍 mapping

  不适合用 dynamic_template 的场景：
    ① 字段名没规律
    ② 同一类字段可能有不同类型
    ③ 需要精细控制每个字段的参数

  最佳实践：
    核心字段显式定义
    通用字段用 dynamic_template 兜底
    还是要开 dynamic: strict（防止完全失控）
```

---

## 四、字段类型选型：架构师的决策树

```latex
字段类型决策流程：

  第一步：这个字段需要查询吗？
    不需要 → "index": false（只存 _source，不建倒排索引）
    需要 → 继续

  第二步：怎么查询？
    精确匹配（=、IN）→ keyword
    全文检索（关键词搜索）→ text
    范围查询（>、<、BETWEEN）→ integer/long/date
    地理位置查询 → geo_point
    IP 网段查询 → ip
    嵌套对象查询 → nested

  第三步：需要聚合/排序吗？
    需要 → keyword（text 不能聚合/排序，除非用 fielddata，但不推荐）
    不需要 → 无所谓

  第四步：数据量和写入QPS？
    量大/写入QPS高 → 优先 keyword（比 text 省空间、快）
    量小 → 可以适当宽松

  第五步：有精度要求吗？
    金额/财务数据 → scaled_float 或 keyword
    普通数值 → integer/long/float
```

### 4.1 text 与 keyword 的深度对比

```latex
text 类型的内部结构：
  原始字符串 → 分词器 → 词项列表 → 倒排索引
  "我爱北京天安门" →  ["我", "爱", "北京", "天安门"]

text 的存储成本：
  ① 分词后的词项（比原字符串大）
  ② 词频、位置、偏移量（用于相关性打分和高亮）
  ③ 可能比原字符串大 2x-10x

text 的查询能力：
  ✅ 全文检索（match 查询）
  ✅ 短语查询（match_phrase）
  ✅ 前缀查询（match_phrase_prefix）
  ❌ 精确匹配（性能很差）
  ❌ 聚合/排序（除非开 fielddata，内存爆炸）

keyword 类型的内部结构：
  原始字符串 → 完整值作为一个词项 → 倒排索引
  "我爱北京天安门" → ["我爱北京天安门"]

keyword 的存储成本：
  ① 完整值一个词项
  ② 没有词频、位置、偏移量（可选）
  ③ 比 text 省很多空间

keyword 的查询能力：
  ✅ 精确匹配（term 查询）
  ✅ 前缀查询（prefix）
  ✅ 通配符查询（wildcard）
  ✅ 聚合/排序（高效）
  ❌ 全文检索（不会分词，查"北京"找不到）

所以：
  能不用 text 就不用 text
  只有真的需要全文检索才用 text
  其他情况一律 keyword
```

### 4.2 浮点数精度问题的本质

```latex
为什么 float 存 0.1 会变成 0.10000000149？

  计算机用二进制存储浮点数
  十进制小数 0.1 = 1/10 = 二进制 0.0001100110011...（无限循环）
  float 只有 32 位，double 只有 64 位
  只能截断无限循环小数 → 精度丢失

  类似十进制里 1/3 = 0.333333...，写不下就变成 0.3333333333

scaled_float 的解决方案：
  把浮点数 × scaling_factor 变成整数存储
  0.1 × 100 = 10 → 存整数 10
  查询时自动除以 100 → 0.1

  整数不会有精度问题！

scaled_float 的限制：
  scaling_factor 要提前定好，不能改
  比如 scaling_factor=100，只能精确到分
  不能精确到厘（0.001）

极端精确场景：
  财务、资金、会计 → 用 keyword 存字符串
  应用层用 BigDecimal 处理
  ES 只负责存储和检索，不负责计算
```

---

## 五、Index Template 架构设计

### 5.1 分层模板架构

```latex
推荐的模板分层结构：

  第一层：Cluster Default（priority: 10）
    _index_template/default
      通用 settings：
        number_of_replicas: 1
        refresh_interval: 1s
        max_result_window: 10000

  第二层：Business Domain（priority: 100）
    _index_template/logs
    _index_template/orders
    _index_template/users
      业务通用的 mappings 和 settings
      引用 Component Template

  第三层：Environment Specific（priority: 200）
    _index_template/logs_dev
    _index_template/logs_prod
      环境特定配置：
        dev: number_of_replicas: 0
        prod: number_of_replicas: 2

  第四层：Temporary Override（priority: 1000）
    紧急修复、临时调整用
    用完删掉

好处：
  配置复用，不用复制粘贴
  优先级明确，不会混乱
  变更范围可控
```

### 5.2 Component Template 设计原则

```latex
Component Template 按"关注点"拆分：

  component/common_settings
    通用设置：副本数、刷新间隔、段合并策略

  component/common_mappings
    通用字段：@timestamp、service、env

  component/logs_settings
    日志专用设置：大分片、refresh_interval: 30s

  component/order_mappings
    订单专用字段：order_id、amount、status

原则：
  ① 按功能拆分，不是按环境拆分
  ② 一个 Component Template 只做一件事
  ③ 避免循环依赖
  ④ 可以被多个 Index Template 引用
```

### 5.3 Alias 设计规范

```latex
Alias 命名规范：
  {业务}_{类型}
    types: write（写）、read（读）、all（读写）

  例子：
    order_write → 只写
    order_read → 只读
    order_all → 读写

Alias 约束：
  写 alias 只能指向一个索引（避免双写冲突）
  读 alias 可以指向多个索引（跨天查询）

Index 命名规范：
  {业务}-{时间}-{版本}
    例子：
      order-2026.06.16-v1
      order-2026.06.16-v2

为什么要版本？
  哪天需要 reindex 时，v2 就是新版本
  切换 alias 就行，不用 rename 索引
```

---

## 六、Mapping 变更管理：架构师的预案

### 6.1 变更风险评估

```latex
Mapping 变更的风险等级：

  低风险：
    - 新增字段（dynamic: strict 时需要先更新 template）
    - 修改字段的 index 从 false 改成 true
    - 添加 multi-fields

  中风险：
    - 修改 ignore_above（只影响新写入数据）
    - 修改 scaling_factor（只影响新写入数据）
    - reindex 小数据量索引（< 100万）

  高风险：
    - 修改已有字段类型（必须 reindex）
    - 修改字段的 index 从 true 改成 false（已写入数据不影响）
    - reindex 大数据量索引（> 1000万）
    - alias 切换（可能影响线上查询）

高风险变更必须：
  ① 先在测试环境验证
  ② 制定回滚预案
  ③ 选低峰期操作
  ④ 全程监控
```

### 6.2 Reindex 性能优化

```latex
Reindex 性能优化 checklist：

  1. 新索引优化设置：
      refresh_interval: -1（先禁用刷新）
      number_of_replicas: 0（先不要副本）

  2. Reindex 参数：
      slice: auto（并行切片，利用多 CPU）
      size: 1000-5000（每批大小，看文档大小）
      wait_for_completion: false（后台执行）

  3. 限流保护：
      requests_per_second: 5000（防止把集群打挂）

  4. 完成后恢复设置：
      refresh_interval: 1s
      number_of_replicas: 1
      强制刷新：POST /new_index/_refresh
      等待 green：GET _cluster/health?wait_for_status=green

  5. 验证数据一致性：
      对比新旧索引的文档数
      抽样查询验证数据正确性
```

### 6.3 零停机切换流程

```latex
零停机切换步骤（有新写入的场景）：

  前置条件：应用已经在使用 alias

  1. 准备阶段
    - 创建新索引 v2，正确的 mapping
    - 更新应用代码，支持双写（v1 和 v2）

  2. 双写阶段
    - 发布应用，开始双写
    - 观察双写有没有报错

  3. Reindex 阶段
    - 把 v1 的历史数据 reindex 到 v2
    - 注意去重（用 version_type=external）

  4. 验证阶段
    - 对比 v1 和 v2 的数据一致性
    - 用 v2 跑测试查询，验证性能

  5. 切读阶段
    - 把读 alias 从 v1 切到 v2
    - 观察查询性能和错误率

  6. 停双写阶段
    - 更新应用，只写 v2
    - 发布应用

  7. 清理阶段
    - 确认没问题后删除 v1

回滚预案：
  任何阶段出问题，把读 alias 切回 v1
```

---

## 七、架构师的 Mapping 设计 Checklist

```latex
Mapping 设计完成前，检查以下各项：

  □ 所有字段类型都明确了吗？
     → 关键字段有没有显式定义，没依赖动态映射？

  □ 标识符字段（订单号、手机号）是 keyword 吗？
     → 有没有误用 text 或 long？

  □ 金额字段是 scaled_float 或 keyword 吗？
     → 有没有用 float/double？

  □ 需要全文检索的字段才用 text 吗？
     → 其他字段是不是都用 keyword？

  □ IP 字段是 ip 类型吗？
     → 有没有误用 keyword？

  □ 地理坐标是 geo_point 吗？
     → 有没有拆成两个 float？

  □ 对象数组需要跨字段匹配吗？
     → 需要的话用 nested，不需要用 object

  □ dynamic 设为 strict 了吗？
     → 生产环境不能是 true

  □ date_detection 需要关闭吗？
     → 如果不需要自动识别日期，建议关闭

  □ 索引有 alias 规划吗？
     → 应用会不会直接读写索引名？

  □ Index Template 准备好了吗？
     → 新索引会不会自动应用正确的配置？

  □ 字段的 ignore_above 设置了吗？
     → keyword 类型建议设置，防止过长字段

  □ text 字段的分词器选对了吗？
     → 中文是不是用 ik_max_word/ik_smart？
```

---

## 八、明日预告

```latex
Day3：搜索与聚合 — Query DSL、Bool 查询、聚合分析
  - Match vs Term：什么时候用哪个？
  - Bool 查询的 must/should/must_not/filter
  - Filter Context 怎么利用缓存？
  - 相关性评分（BM25）如何调优？
  - Metric Aggregation（avg/sum/cardinality）
  - Bucket Aggregation（terms/range/date_histogram）
  - 聚合性能优化（内存限制、预聚合）
```

---

*日期：2026-06-16 | 2026年06月第3周 Day2 | Mapping深入与字段类型陷阱 | 架构师梳理*