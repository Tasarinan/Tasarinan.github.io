# Day03：ES查询DSL与聚合分析（架构师梳理）
> 2026-06-17 周三｜ES专题第3天

---

## 一、查询DSL的心智模型

### 1.1 从倒排索引到查询DSL

```latex
架构师视角：
  ES查询DSL不是"另一种SQL"，而是"倒排索引操作的API"

  理解倒排索引结构：
    Term Index → Term Dictionary → Posting List

  查询就是：
    1. 找到词项在倒排索引中的位置
    2. 取出Posting List
    3. 对多个Posting List做交/并/差集运算
    4. 计算相关性打分
    5. 返回结果
```

### 1.2 查询的两个上下文

```latex
Query Context（查询上下文）：
  → "这个文档和查询词有多匹配"
  → 计算相关性分数_score
  → 用于must/should

Filter Context（过滤上下文）：
  → "这个文档匹配吗？是/否"
  → 不计算分数
  → 结果会被缓存（bitset）
  → 用于filter/must_not

架构师原则：
  能不用Query Context就不用
  过滤条件都放Filter Context
  只把真正需要"相关性排序"的条件放Query Context
```

---

## 二、全文检索的原理

### 2.1 分析器（Analyzer）的三阶段

```latex
分析器 = 字符过滤器（CharFilter） + 分词器（Tokenizer） + 词项过滤器（TokenFilter）

例子："我爱北京天安门"
  CharFilter：不做处理
  Tokenizer：按IK分词器切分 → ["我", "爱", "北京", "天安门"]
  TokenFilter：去掉停用词"我" → ["爱", "北京", "天安门"]

索引时和查询时：
  必须用同一个分析器！
  否则会出现"索引时分词是A，查询时分词是B，匹配不到"的问题
```

### 2.2 常见分析器选型

| 分析器 | 适用场景 | 说明 |
|--------|---------|------|
| standard | 英文 | 按空格分词，转小写，去掉标点 |
| ik_max_word | 中文 | 最细粒度分词，适合索引 |
| ik_smart | 中文 | 最粗粒度分词，适合查询 |
| keyword | 不分词 | 整个字段作为一个词项 |

---

## 三、bool查询的性能优化

### 3.1 Filter Context的缓存机制

```latex
Bitset缓存：
  每个filter条件会生成一个bitset
    → 1表示匹配，0表示不匹配
    → 每个位对应一个文档

  多个filter条件：
    → 多个bitset做AND运算
    → 位运算极快

  缓存策略：
    → 相同的filter条件直接复用bitset
    → 缓存有大小限制，LRU淘汰
```

### 3.2 查询重写（Query Rewriting）

```latex
ES会自动优化查询：
  例子1：
    bool:
      should:
        term: { status: "active" }
        term: { status: "pending" }
    → 自动重写为 terms: { status: ["active", "pending"] }

  例子2：
    bool:
      must:
        term: { category: "健康险" }
        match: { product_name: "重疾险" }
    → 先执行filter（category），再执行match（product_name）
    → 因为filter更快，可以先过滤掉大部分文档

架构师需要知道：
  ES会做查询优化，但不应该依赖它
  自己先把查询结构设计好
```

---

## 四、聚合的深度理解

### 4.1 聚合的执行流程

```latex
分布式聚合：
  阶段1：每个分片对本地数据做聚合
  阶段2：协调节点汇总各分片的结果，合并出最终结果

  例子：count聚合
    分片1：100条
    分片2：150条
    分片3：120条
    协调节点：100 + 150 + 120 = 370条

  例子：avg聚合
    分片1：sum=1000, count=100 → avg=10
    分片2：sum=3000, count=150 → avg=20
    协调节点：(1000+3000)/(100+150) = 4000/250 = 16
    → 注意不能直接对avg再求avg！
```

### 4.2 聚合的内存消耗

```latex
terms聚合的内存：
  → 每个桶需要存key和count
  → 如果有1000个桶，每个桶100字节
  → 1000 × 100 = 100KB / 分片
  → 10个分片就是1MB
  → 看起来不大，但并发高了就有问题

  cardinality聚合：
    → 近似去重计数，用HyperLogLog算法
    → 内存可控，精度可调

  深度嵌套聚合：
    → 每一层都要存中间结果
    → 层级越深，内存消耗越大
```

---

## 五、生产环境查询最佳实践

### 5.1 查询设计 Checklist

```latex
□ 所有过滤条件都放在filter里了吗？
□ text字段用match，keyword字段用term了吗？
□ 聚合前先用query过滤数据了吗？
□ 分页方式选对了吗？（前100页用from/size，深分页用search_after）
□ 排序字段用keyword/数值/日期了吗？（text字段排序性能差）
□ 是否需要相关性打分？不需要的话用filter或constant_score
□ 聚合返回的桶数量合理吗？（默认10个，不要超过1000个）
```

### 5.2 慢查询定位

```latex
查看慢查询日志：
  → 配置index.search.slowlog.threshold
  → 超过阈值的查询会记录

  用profile API分析：
    GET /index/_search?profile=true
    { ... }
  → 看到查询每个阶段的耗时

  常见慢查询原因：
    1. 没有用filter，大量文档参与打分
    2. text字段做term聚合
    3. 深分页（from太大）
    4. 返回字段太多（用_source_includes只返回需要的）
```

---

## 六、架构师视角的Day03总结

```latex
查询DSL的核心：
  不是语法，而是"理解每个查询在倒排索引上如何执行"

  关键认知：
    1. Filter Context比Query Context快很多，能缓存
    2. 先过滤再聚合，减少参与计算的数据量
    3. 分页不是简单的offset/limit，深分页有性能问题
    4. 相关性打分不是免费的，不需要就别用

  生产环境原则：
    - 简单查询 > 复杂查询
    - filter > must
    - 小结果集 > 大结果集
    - 能聚合就不查询出所有文档
```

---

*日期：2026-06-17 | 2026年06月第3周 Day3 | ES查询DSL与聚合分析-梳理*