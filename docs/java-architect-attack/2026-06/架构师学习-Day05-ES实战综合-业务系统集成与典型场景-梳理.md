# Day05：ES实战综合 — 业务系统集成与典型场景（架构师梳理）
> 2026-06-19 周五｜ES专题第5天

从架构师视角梳理ES与业务系统集成的典型场景、架构设计和最佳实践。

---

## 一、ES在系统架构中的定位

### 1.1 ES的核心能力与边界

```latex
ES擅长做什么？
  ✓ 全文搜索：分词检索、相关性排序
  ✓ 多条件检索：复杂的bool查询组合
  ✓ 聚合统计：group by、range、嵌套聚合
  ✓ 时序数据：日志、监控指标
  ✓ 近实时查询：1s延迟内可见

ES不擅长做什么？
  ✗ 事务：不支持ACID事务
  ✗ 强一致性：最终一致性
  ✗ 频繁更新：更新操作成本高
  ✗ 小数据量查询：不如MySQL直接
  ✗ 唯一数据源：建议有其他数据源备份

架构原则：
  → ES是搜索引擎，不是数据库
  → MySQL/其他数据库是唯一数据源
  → ES数据可以从数据源重建
  → 不要在ES中存唯一数据
```

### 1.2 MySQL + ES 典型分工

```latex
MySQL + ES 黄金组合：

  MySQL职责：
    → 存完整数据（所有字段）
    → 处理事务操作
    → 保证数据一致性
    → 是唯一数据源

  ES职责：
    → 存索引字段（搜索需要的字段）
    → 处理复杂查询、全文检索
    → 处理聚合统计
    → 提供高性能检索

  字段分工示例（订单）：
    MySQL: order_id, user_id, status, amount, create_time, 
           detail_json, extend_fields, address, phone...
    ES:    order_id, user_id, status, amount, create_time, 
           product_name, merchant_id...（搜索需要的字段）
           
  数据流向：
    写入：应用 → MySQL → (同步/异步) → ES
    读取：简单查询 → MySQL；复杂搜索 → ES
```

---

## 二、数据同步方案选型

### 2.1 同步方案对比矩阵

| 方案 | 实时性 | 一致性 | 复杂度 | 推荐场景 |
|-----|--------|--------|--------|---------|
| 双写（应用同时写） | 高 | 中（可能不一致） | 低 | 小数据量、一致性要求不高 |
| 双写 + 补偿重试 | 高 | 高 | 中 | 秒杀、金融等实时性要求高的场景 |
| Canal/Debezium（Binlog） | 中（秒级） | 高 | 中 | 大多数业务场景（推荐） |
| 定时全量同步 | 低（小时/天） | 高（最终） | 低 | 数据更新不频繁、或做兜底校验 |
| 事务消息 | 中 | 高 | 高 | 一致性要求高的分布式场景 |

### 2.2 架构师推荐方案

```latex
推荐组合（通用场景）：

  主要方案：
    → Canal/Debezium 监听 Binlog
    → Kafka 缓冲削峰
    → 消费者写入 ES

  兜底方案：
    → 定时全量校验
    → 发现不一致自动修复

  为什么这样选？
    → 不侵入业务代码
    → 一致性好（基于Binlog）
    → 可应对突增流量（Kafka缓冲）
    → 可扩展性好

  高实时性场景（如秒杀）：
    → 双写 + 异步补偿 + Canal兜底
    → 双写保证实时性
    → 补偿保证可靠性
    → Canal兜底保证最终一致
```

```java
// 架构师视角的同步架构
public class EsSyncArchitecture {
    
    /**
     * 高实时性场景同步方案
     */
    public void highRealTimeSync(Order order) {
        // 1. 写MySQL（事务）
        orderMapper.insert(order);
        
        // 2. 尝试同步写ES
        try {
            elasticsearchService.index(order);
        } catch (Exception e) {
            // 3. 失败记录重试表
            retryTaskMapper.insert(new RetryTask(order.getId(), "ES_SYNC"));
        }
    }
    
    /**
     * 通用场景同步方案
     */
    public void generalSync() {
        // Canal监听Binlog -> Kafka -> 消费者写ES
        // 完全异步，不侵入业务
    }
    
    /**
     * 兜底校验
     */
    @Scheduled(cron = "0 0 2 * * ?")
    public void dailyVerify() {
        // 每天凌晨2点，校验MySQL和ES数据一致性
        // 发现不一致自动修复
    }
}
```

---

## 三、典型场景架构设计

### 3.1 电商搜索场景

```latex
场景特点：
  → 全文检索需求强
  → 多条件筛选
  → 聚合统计（分类、价格区间）
  → 高QPS
  → 数据更新不频繁

架构要点：
  1. 索引设计：
     → 合理的分词器（IK分词）
     → multi_match在多个字段搜索
     → filter做条件过滤
     → 聚合返回筛选条件
     
  2. 数据同步：
     → Canal + Kafka
     → 实时性要求不高（分钟级可接受）
     
  3. 性能优化：
     → 热门搜索结果缓存Redis
     → filter缓存利用
     → 合理的分片和副本
     
  4. 高可用：
     → 多副本
     → 应用层限流降级
```

### 3.2 日志分析场景

```latex
场景特点：
  → 数据量大（每天几百GB）
  → 写入持续稳定
  → 查询频率不高，但查询范围可能大
  → 数据有生命周期（保留N天）
  → 不需要事务

架构要点：
  1. ELK架构：
     → Filebeat采集
     → Kafka缓冲
     → Logstash处理
     → ES存储
     → Kibana展示
     
  2. 存储分层：
     → Hot：SSD，存最近7天
     → Warm：机械硬盘，存7-30天
     → Cold：归档，存30天以上
     → Delete：自动删除
     
  3. 索引管理：
     → 按天/周分片
     → ILM自动管理生命周期
     → force merge减少segment
     
  4. 写入优化：
     → refresh_interval设为30s
     → translog async模式
     → Bulk批量写入
```

### 3.3 秒杀订单场景

```latex
场景特点：
  → 写入峰值高（每秒10万+）
  → 查询QPS也高
  → 用户查询自己的订单（带user_id条件）
  → 实时性要求高（订单创建立即可见）
  → 数据量大（每天上亿）

架构要点：
  1. Routing优化：
     → 用user_id做routing
     → 同一用户的订单在同一分片
     → 查询时只查一个分片，性能提升N倍
     
  2. 数据同步：
     → 双写 + 异步补偿 + Canal兜底
     → 双写保证实时性
     → 补偿保证可靠性
     
  3. 隔离：
     → 用户查询、商家查询、运营查询隔离
     → 避免互相影响
     
  4. 限流降级：
     → 应用层限流
     → ES查询超时控制
     → 降级策略
```

### 3.4 医疗多租户场景

```latex
场景特点：
  → 多租户，数据隔离要求高
  → 合规要求严（审计、权限）
  → 字段级权限控制
  → 数据不能跨租户

架构要点：
  1. 多租户架构：
     → 混合方案：大租户单独索引，小租户共享
     → routing + filter隔离
     → Document Level Security
     
  2. 权限控制：
     → Field Level Security
     → 字段脱敏
     
  3. 审计：
     → 完整的审计日志
     → 操作可追溯
     
  4. 合规：
     → 传输加密、存储加密
     → 数据备份
     → 生命周期管理
```

---

## 四、Routing 深入理解

### 4.1 Routing 的原理与价值

```latex
Routing是什么？
  → 控制文档写入哪个分片
  → 默认用文档ID做routing
  → 也可以自定义routing key

Routing的价值：
  → 查询时指定routing，只查一个分片
  → 避免fan-out到所有分片
  → 性能提升N倍（N=分片数）

什么时候用routing？
  ✓ 查询条件中总是带某个字段（如user_id）
  ✓ 该字段的区分度够高（数据分散）
  ✓ 不需要跨routing查询（或能接受）

什么时候不用？
  ✗ 查询条件不固定
  ✗ 需要跨routing聚合
  ✗ routing key分布不均匀（数据倾斜）
```

```latex
Routing的工作原理：

  写入时：
    1. 计算 hash(routing)
    2. hash % number_of_shards = shard_id
    3. 写入该分片

  查询时（带routing）：
    1. 计算 hash(routing)
    2. 只查询该分片
    3. 返回结果

  查询时（不带routing）：
    1. 广播查询到所有分片
    2. 每个分片查询返回结果
    3. 协调节点聚合结果
    4. 返回给用户
```

### 4.2 Routing 的 trade-off

```latex
用user_id做routing（订单场景）：

  收益：
    ✓ 用户查询自己的订单：只查1个分片，快
    ✓ 性能提升32倍（假设32个分片）
    
  代价：
    ✗ 商家查询自己的订单：需要查所有分片，慢
    ✗ 运营查询所有订单：需要查所有分片，慢
    ✗ 数据可能倾斜（某个用户订单特别多，分片数据不均）
    
  架构决策：
    → 看谁的查询量更大
    → 用户查询量 >> 商家查询量：优先保证用户
    → 或者：商家查询用另外的索引（读写分离思路）
```

---

## 五、缓存策略设计

### 5.1 ES + Redis 缓存架构

```latex
缓存层级：

  L1缓存：应用本地缓存（Caffeine/Guava Cache）
    → 缓存最热的数据
    → 缓存时间：1-5分钟
    → 容量：GB级别
    
  L2缓存：Redis分布式缓存
    → 缓存热门搜索结果
    → 缓存时间：5-10分钟
    → 容量：10-100GB
    
  L3：ES
    → 兜底查询
    → 全量数据

缓存策略：
  → Cache-Aside Pattern（旁路缓存）
  → 查询：先查缓存，没命中查ES，回写缓存
  → 更新：先更ES，再删缓存（不要更缓存）
  → 过期时间：合理设置，避免缓存雪崩
  
缓存预热：
  → 系统启动时预热热门数据
  → 定时刷新热门数据
```

```java
// 架构师视角的缓存设计
public class SearchCacheArchitecture {
    
    @Autowired
    private RedisTemplate redisTemplate;
    
    @Autowired
    private ElasticsearchService elasticsearchService;
    
    /**
     * 带缓存的查询
     */
    public SearchResult searchWithCache(SearchRequest request) {
        // 1. 构建缓存Key
        String cacheKey = buildCacheKey(request);
        
        // 2. 查Redis
        String cached = (String) redisTemplate.opsForValue().get(cacheKey);
        if (cached != null) {
            return JSON.parseObject(cached, SearchResult.class);
        }
        
        // 3. 查ES
        SearchResult result = elasticsearchService.search(request);
        
        // 4. 回写Redis（5分钟过期）
        redisTemplate.opsForValue().set(cacheKey, JSON.toJSONString(result), 5, TimeUnit.MINUTES);
        
        return result;
    }
    
    /**
     * 数据更新
     */
    public void updateData(Document doc) {
        // 1. 更新ES
        elasticsearchService.update(doc);
        
        // 2. 删除缓存（不要更新缓存，避免并发问题）
        String cacheKey = buildCacheKeyForDoc(doc);
        redisTemplate.delete(cacheKey);
    }
}
```

---

## 六、高可用与稳定性保障

### 6.1 高可用架构设计

```latex
ES集群高可用：
  → 3个Master节点（防脑裂）
  → 数据节点多副本（至少2副本）
  → 协调节点独立（大集群）
  → 机架感知（分片分配到不同机架）

应用层高可用：
  → 多个应用节点
  → 负载均衡
  → 无状态设计

数据层高可用：
  → MySQL主从
  → ES多副本
  → 定期备份（Snapshot）
```

### 6.2 限流降级与熔断

```latex
限流策略：
  → 应用层限流（Sentinel/Resilience4j）
  → ES查询设置timeout
  → 按用户、按接口限流

降级策略：
  → ES查询超时，返回缓存数据
  → ES不可用，降级查MySQL（简单查询）
  → 返回友好提示

熔断策略：
  → ES错误率超过阈值，熔断一段时间
  → 熔断期间直接返回降级结果
  → 探测恢复后自动关闭熔断
```

### 6.3 隔离设计

```latex
隔离手段：

  1. 索引隔离：
     → 不同业务用不同索引
     → 互不影响
     
  2. 查询隔离：
     → 用户查询、商家查询、运营查询分开
     → 不同的查询优先级
     
  3. 资源隔离：
     → 不同业务用不同的协调节点
     → 线程池隔离
     
  4. 读写隔离：
     → 读写分离
     → 不同的优化策略
```

---

## 七、监控与运维体系

### 7.1 关键监控指标

```latex
业务指标：
  → QPS
  → 查询耗时（P50/P95/P99）
  → 错误率
  → 缓存命中率

ES指标：
  → 集群状态（Green/Yellow/Red）
  → JVM Heap使用率
  → 磁盘使用率
  → CPU使用率
  → GC次数和耗时
  → 查询/写入耗时
  → 未分配分片数

系统指标：
  → CPU
  → 内存
  → 磁盘IO
  → 网络
```

### 7.2 告警规则建议

| 指标 | 警告阈值 | 危险阈值 | 处理优先级 |
|-----|---------|---------|-----------|
| 集群状态 | Yellow | Red | P0 |
| JVM Heap | >80% | >90% | P1 |
| 磁盘使用率 | >80% | >90% | P1 |
| 查询P99耗时 | >1s | >3s | P2 |
| 错误率 | >1% | >5% | P1 |
| 缓存命中率 | &lt;80% | &lt;50% | P2 |

---

## 八、架构师能力成长路径

### 8.1 从开发到架构师

```latex
开发阶段：
  ✓ 会写CRUD
  ✓ 会写查询DSL
  ✓ 知道基本的索引概念

高级开发阶段：
  ✓ 会设计索引Mapping
  ✓ 会做基本的性能优化（filter、routing）
  ✓ 会用Canal同步数据
  ✓ 理解分片和副本
  ✓ 会看监控指标

架构师阶段：
  ✓ 能根据业务场景设计架构
  ✓ 能做容量规划
  ✓ 能设计数据同步方案
  ✓ 能考虑高可用、稳定性、限流降级
  ✓ 能将ES融入整个系统生态
  ✓ 能排查复杂问题
  ✓ 有合规意识（多租户、审计、加密）

关键转折点：
  → 从"怎么用ES"到"怎么用ES解决业务问题"
  → 从"功能实现"到"架构设计"
  → 从"只看ES"到"看整个系统"
```

### 8.2 架构师思维

```latex
架构师思考问题的方式：

  1. 先理解业务：
     → 业务场景是什么？
     → 数据量多大？
     → QPS多少？
     → 一致性要求多高？
     → 实时性要求多高？
     
  2. 再设计方案：
     → 选择什么技术？
     → 架构怎么设计？
     → 数据怎么同步？
     → 高可用怎么保证？
     → 成本如何？
     
  3. 然后考虑Trade-off：
     → 性能 vs 一致性？
     → 实时性 vs 可靠性？
     → 成本 vs 体验？
     
  4. 最后考虑运维：
     → 怎么监控？
     → 怎么告警？
     → 出问题怎么办？
     → 怎么扩容？
```

---

## Day05架构师总结

```latex
ES实战的核心能力：

  1. 场景理解：
     → 电商搜索、日志分析、秒杀订单、医疗多租户
     → 不同场景不同架构
     
  2. 架构设计：
     → MySQL + ES分工
     → 数据同步方案选型
     → Routing优化
     → 缓存策略
     
  3. 系统集成：
     → Kafka数据管道
     → Redis缓存
     → Spark/Flink分析
     → 监控告警
     
  4. 稳定性保障：
     → 高可用架构
     → 限流降级熔断
     → 隔离设计
     
  5. 运维体系：
     → 监控指标
     → 告警规则
     → 故障排查

架构师思维：
  → 不是为了用ES而用ES
  → 而是根据业务场景选择合适的技术
  → 考虑功能、性能、可靠性、成本、运维的平衡
  → 形成完整的闭环
```

---

*日期：2026-06-19 | 2026年06月第3周 Day5 | ES实战综合 — 业务系统集成与典型场景*