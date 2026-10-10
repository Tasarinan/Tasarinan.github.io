# Day 6：限流降级熔断专题串联整合 — 高可用防护网架构设计

## 本周回顾速览

本周 Day1-Day5 完整覆盖了限流降级熔断从原理到实战的链路：

| Day | 主题 | 核心知识点 |
|-----|------|-----------|
| Day1 | 限流算法核心原理与选型 | 固定窗口/滑动窗口/漏桶/令牌桶、临界突发、Sentinel vs Guava RateLimiter 选型 |
| Day2 | 熔断器原理与降级策略设计 | 慢调用/异常比例/异常数熔断、CLOSED/OPEN/HALF_OPEN 状态机、降级策略八种 |
| Day3 | 集群限流与流量隔离设计 | Token Server、本地预限流、流量染色、租户/灰度隔离 |
| Day4 | 自适应限流与系统负载保护 | BBR 算法、系统规则（load/cpu/rt/incomingQps/concurrency）、Load 自适应 |
| Day5 | 限流降级熔断实战综合 | 多级防护体系、网关/Sentinel/Redis+Lua 分层、故障演练、可观测性 |

**本周因果链**：算法原理（限流算法）→ 故障防御（熔断器）→ 集群协同（集群限流）→ 自适应（系统保护）→ 工程落地（多级防护体系）

---

## 场景选择：高可用防护网

### 为什么选这个场景

今天不走多场景分选模式。本周五天学完之后，最能"一次性把所有知识点用上"的场景，不是单点限流配置，而是**多级高可用防护网**——这是架构师视角才能真正驾驭的设计题。

防护网场景一次性用到本周全部知识点：

```text
Day1：四种限流算法 → 防护网每一层根据职责选不同算法（网关令牌桶、应用滑动窗口、资源漏桶）
Day2：熔断器 + 降级 → 防护网在故障发生时的"快速失败 + 兜底返回"机制
Day3：集群限流 + 流量隔离 → 防护网的全局阈值控制与租户/灰度隔离
Day4：自适应限流 → 防护网根据系统实时负载自动收缩流量
Day5：多级防护体系 → 防护网本身的分层架构与协同
```

如果只看单点限流，会错过"多层协同、降级链路、可观测性、故障演练"这些架构师核心命题。

---

## 核心考题：秒杀系统高可用防护网架构设计

### 业务背景

```text
双11 秒杀系统峰值 QPS 10w+，业务链路：
  CDN/WAF → Nginx → API Gateway → 秒杀服务 → 订单服务 → 支付服务 → DB/Redis

历史故障：
  - 2024双11：恶意用户瞬时 100w 请求打爆网关，整个入口瘫痪 5 分钟
  - 2024双11：下游支付服务慢调用导致秒杀服务线程池打满，雪崩
  - 2025 618：DB 慢查询导致连接池耗尽，所有接口超时
  - 2025 618：某租户突发流量挤占公共资源，其他租户业务受影响
  - 2026 春节：突发流量未达限流阈值但系统已过载，传统限流失效
```

### 目标

```text
1. 多级防护：CDN/WAF → Nginx → Gateway → 应用 → 资源，每层都有防护
2. 全局阈值：核心接口支持集群限流，10w QPS 精确控制
3. 故障隔离：单服务故障不雪崩，单租户故障不影响其他租户
4. 自适应：根据系统负载自动收缩，不依赖人工阈值
5. 快速降级：故障时毫秒级返回兜底，不阻塞用户
6. 可观测：防护网每层指标可视、告警秒级触达
7. SLA：P99 < 500ms，可用性 99.99%
```

---

## 架构师方案：五层防护网 + 全局协同 + 自适应兜底

```text
                          用户流量
                              │
                    ┌─────────▼─────────┐
        L1          │   CDN / WAF        │  ← 黑名单、地理限流、CC防护
                    └─────────┬─────────┘
                              │
                    ┌─────────▼─────────┐
        L2          │   Nginx + Lua      │  ← IP/UA/接口级粗限流，挡 80% 流量
                    └─────────┬─────────┘
                              │
                    ┌─────────▼─────────┐
        L3          │   API Gateway      │  ← 用户/API 级细限流 + 集群限流
                    │  (Spring Cloud GW) │     + 鉴权 + 流量染色
                    └─────────┬─────────┘
                              │
                    ┌─────────▼─────────┐
        L4          │   应用层 Sentinel  │  ← 接口/方法级限流 + 熔断 + 降级
                    │  + 集群流控          │     + 热点参数 + 系统自适应
                    └─────────┬─────────┘
                              │
                    ┌─────────▼─────────┐
        L5          │   资源层保护        │  ← DB 连接池/线程池限流
                    │  Redis+Lua / 慢SQL │     + Redis+Lua 精确计数
                    └─────────┬─────────┘
                              │
                          DB / Redis
```

---

## 本周知识点串联

| 知识点 | 在防护网场景中的应用 |
|--------|-------------------|
| **固定窗口（Day1）** | L1 CDN 黑名单按"天"维度的访问计数，精度要求低，固定窗口足够 |
| **滑动窗口（Day1）** | L4 Sentinel 默认滑动窗口，QPS/RT/异常多维统计的统一底座 |
| **令牌桶（Day1）** | L2 Nginx+Lua 入口限流，容忍用户瞬时点击 burst，桶容量按业务突发量设定 |
| **漏桶（Day1）** | L5 调用下游敏感接口（支付通道），严格平滑流量，保护下游 |
| **临界突发流量（Day1）** | L4 滑动窗口规避窗口切换瞬间的 2x 流量穿透 |
| **Sentinel vs Guava 选型（Day1）** | L4 选 Sentinel（需要熔断+多维统计），L5 单机资源保护用 Guava RateLimiter |
| **慢调用比例熔断（Day2）** | L4 秒杀→支付接口配置 RT>500ms 比例 > 50% 触发熔断 |
| **异常比例熔断（Day2）** | L4 支付接口异常率 > 10% 触发熔断，避免坏账 |
| **熔断状态机（Day2）** | L4 OPEN 持续 10s → HALF_OPEN 探测 5 次 → CLOSED/OPEN |
| **降级策略八种（Day2）** | L4 秒杀场景：返回兜底页、默认值、缓存数据、异步化、空响应 |
| **Cluster Token Server（Day3）** | L3/L4 集群限流，全局 10w QPS 精确控制，Token Server 高可用部署 |
| **本地预限流 + 集群精限流（Day3）** | L4 本地阈值 = 全局阈值/N × 0.8，80% 本地拦截，20% 走 Token Server |
| **流量染色（Day3）** | L3 网关染色 X-Traffic-Type=seckill/normal/gray，L4 按染色分流 |
| **租户隔离（Day3）** | L4 大租户单独限流规则，避免挤占公共资源 |
| **灰度隔离（Day3）** | L4 灰度流量染色后走独立限流规则，灰度异常不影响正式流量 |
| **BBR 自适应（Day4）** | L4 系统规则用 BBR 算法，根据 CPU/RT 自动调整通过率 |
| **Load 自适应（Day4）** | L4 系统 load1 > 8 触发自适应限流，无需人工阈值 |
| **CPU 使用率（Day4）** | L4 cpuUsage > 80% 触发系统保护 |
| **多级防护体系（Day5）** | 防护网本身 L1-L5 分层架构 |
| **fail-open/close 取舍（Day5）** | L3 网关层 fail-open（保入口可用），L5 资源层 fail-close（保 DB） |
| **故障演练（Day5）** | 每月演练 Token Server 故障、Redis 故障、下游慢调用 |
| **可观测性（Day5）** | L1-L5 每层上报 Prometheus，统一 Grafana 看板 |

---

## 一、L1 CDN/WAF 层：黑名单与地理限流

### 1.1 职责定位

```text
L1 是防护网最外层，挡掉：
  - 黑名单 IP/UA
  - 地理区域限制（如海外IP封禁）
  - CC 攻击（同 IP 高频请求）
  - 爬虫流量
```

### 1.2 实现方案

```text
CDN 边缘节点：
  - IP 黑名单：恶意 IP 直接 403
  - 频率限制：单 IP > 100 req/s 拦截
  - UA 过滤：空 UA / 已知爬虫 UA 拦截
  - 地理限流：海外 IP 封禁或验证码

WAF：
  - SQL 注入 / XSS 拦截
  - CC 攻击自动识别
  - Bot 流量识别
```

### 1.3 用到的本周知识点

- **固定窗口计数器（Day1）**：CDN 边缘节点按"分钟"维度做 IP 频率统计，精度低但够用
- **fail-open（Day5）**：CDN 故障时直接放行，由 L2 兜底

### 1.4 关键参数

```text
单 IP 频率：100 req/s（超出拦截）
单 UA 频率：1000 req/s（爬虫识别阈值）
黑名单更新：T+1 离线计算 + 实时举报
```

---

## 二、L2 Nginx+Lua 层：粗限流与挡量

### 2.1 职责定位

```text
L2 是防护网第二道闸门，目标：挡掉 80% 的恶意/超量流量
  - IP/UA/接口级粗限流
  - 漏斗模型：用户/IP/接口 三维度
  - 静态资源直接返回（不进应用）
```

### 2.2 实现方案

OpenResty + lua-resty-limit-traffic：

```lua
-- 令牌桶限流：单 IP 每秒 50 请求
local limit_req = require "resty.limit.req"
local lim, err = limit_req.new("my_limit_req_store", 50, 10)  -- rate=50, burst=10
local delay, err = lim:incoming(ngx.var.remote_addr, true)

if not delay then
    if err == "rejected" then
        ngx.exit(429)  -- 限流
    end
    return
end

-- 滑动窗口限流：接口级
local limit_count = require "resty.limit.count"
local lim2, err = limit_count.new("my_limit_count_store", 1000, 60)  -- 60s 1000次
local count, err = lim2:incoming(ngx.var.uri, true)
if not count then
    if err == "rejected" then
        ngx.exit(429)
    end
end
```

### 2.3 用到的本周知识点

- **令牌桶（Day1）**：IP 级限流，桶容量 10 允许用户瞬时 burst
- **滑动窗口（Day1）**：接口级限流，规避临界突发
- **Redis 共享计数（Day3）**：多 Nginx 节点共享 Redis 计数器，实现集群粗限流

### 2.4 关键参数

```text
单 IP 阈值：50 req/s（令牌桶，burst=10）
单接口阈值：1000 req/60s（滑动窗口）
挡量目标：80% 流量在 L2 拦截
```

---

## 三、L3 API Gateway 层：细限流与流量染色

### 3.1 职责定位

```text
L3 是防护网的"细控层"，目标：
  - 用户/API 维度的细限流
  - 集群限流（精确全局阈值）
  - 鉴权 + 流量染色
  - 路由 + 协议转换
```

### 3.2 实现方案

Spring Cloud Gateway + Sentinel：

```java
// 网关层 Sentinel 限流规则
GatewayRuleManager.loadRules(Arrays.asList(
    new GatewayFlowRule("seckill_route")
        .setCount(10000)             // 全局 10w QPS
        .setIntervalSec(1)
        .setClusterMode(true)        // 集群限流
        .setClusterConfig(new ClusterFlowConfig()
            .setThresholdType(ClusterFlowConfig.GLOBAL)),
    new GatewayFlowRule("seckill_route")
        .setResourceMode(GatewayRuleManager.RESOURCE_MODE_CUSTOM_API_NAME)
        .setCount(10)                // 单用户 10 req/s
        .setParamItem(new GatewayParamFlowItem()
            .setParseStrategy(GatewayParamFlowItem.PARAM_PARSE_STRATEGY_HEADER)
            .setFieldName("X-User-ID"))
));
```

流量染色：

```java
@Component
public class TrafficDyeFilter implements GlobalFilter {
    @Override
    public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) {
        String userId = exchange.getRequest().getHeaders().getFirst("X-User-ID");
        String trafficType = classifyTraffic(userId);  // seckill / normal / gray
        
        // 染色
        exchange.getRequest().mutate()
            .header("X-Traffic-Type", trafficType)
            .build();
        return chain.filter(exchange);
    }
}
```

### 3.3 用到的本周知识点

- **集群限流 Token Server（Day3）**：网关层全局 10w QPS 精确控制
- **流量染色（Day3）**：seckill/normal/gray 三色分流
- **热点参数限流（Day3）**：单用户维度限流（X-User-ID 作为热点参数）
- **fail-open（Day5）**：Token Server 故障时网关 fail-open，避免入口不可用

### 3.4 关键参数

```text
全局阈值：10w QPS（集群限流）
单用户阈值：10 req/s（热点参数）
Token Server 部署：3 节点集群，主备 + 1 选举
fail-open 触发：Token Server 3 节点全挂时
```

---

## 四、L4 应用层 Sentinel：熔断降级与自适应

### 4.1 职责定位

```text
L4 是防护网最核心层，承担：
  - 接口/方法级限流
  - 熔断器（保护下游）
  - 降级策略（兜底返回）
  - 系统自适应限流（兜底保护）
  - 热点参数限流（topN 商品）
```

### 4.2 实现方案

#### 4.2.1 限流规则（滑动窗口 + 集群）

```java
FlowRule rule1 = new FlowRule("createOrder")
    .setGrade(RuleConstant.FLOW_GRADE_QPS)
    .setCount(5000)                 // 单机 5000 QPS
    .setClusterMode(true)           // 集群模式
    .setClusterConfig(new ClusterFlowConfig()
        .setThresholdType(ClusterFlowConfig.GLOBAL)
        .setFallbackToLocalWhenFail(true));  // Token Server 失败回退本地

FlowRule rule2 = new FlowRule("createOrder")
    .setGrade(RuleConstant.FLOW_GRADE_THREAD)  // 线程数限流
    .setCount(200);                              // 单机并发 200
```

#### 4.2.2 熔断规则（慢调用 + 异常比例）

```java
// 慢调用熔断：RT > 500ms 比例 > 50% 触发
DegradeRule slowRule = new DegradeRule("paymentService.call")
    .setGrade(CircuitBreakerStrategy.SLOW_REQUEST_RATIO)
    .setCount(500)                  // 慢调用阈值 500ms
    .setSlowRatioThreshold(0.5)     // 比例 50%
    .setMinRequestAmount(20)        // 最小样本 20
    .setStatIntervalMs(5000)        // 5s 窗口
    .setTimeWindow(10);             // OPEN 持续 10s

// 异常比例熔断：异常率 > 10% 触发
DegradeRule errorRule = new DegradeRule("paymentService.call")
    .setGrade(CircuitBreakerStrategy.ERROR_RATIO)
    .setCount(0.1)                  // 异常比例 10%
    .setMinRequestAmount(20)
    .setStatIntervalMs(5000)
    .setTimeWindow(10);
```

#### 4.2.3 降级策略

```java
@SentinelResource(value = "createOrder", blockHandler = "createOrderBlockHandler",
                  fallback = "createOrderFallback")
public OrderResult createOrder(OrderRequest req) {
    // 正常下单逻辑
}

// 限流降级：返回兜底页
public OrderResult createOrderBlockHandler(OrderRequest req, BlockException ex) {
    log.warn("createOrder blocked: {}", ex.getClass().getSimpleName());
    return OrderResult.builder()
        .code(429)
        .message("活动太火爆，请稍后再试")
        .build();
}

// 异常降级：返回缓存数据或默认值
public OrderResult createOrderFallback(OrderRequest req, Throwable t) {
    log.error("createOrder fallback", t);
    // 异步化：写入 MQ 后续处理
    mqProducer.sendAsync("order-fallback-queue", req);
    return OrderResult.builder()
        .code(202)
        .message("订单已接收，正在处理中")
        .build();
}
```

#### 4.2.4 热点参数限流

```java
ParamFlowRule rule = new ParamFlowRule("queryProduct")
    .setParamIdx(0)              // 第0个参数（productId）
    .setCount(100);              // 单商品 100 QPS

// topN 商品特殊阈值
ParamFlowItem item = new ParamFlowItem();
item.setObject("PID_001");      // 秒杀商品
item.setClassType(String.class.getName());
item.setCount(1000);            // topN 商品 1000 QPS
rule.setParamFlowItemList(Collections.singletonList(item));
```

#### 4.2.5 系统自适应限流（BBR）

```java
SystemRule loadRule = new SystemRule();
loadRule.setHighestSystemLoad(8.0);      // load1 > 8 触发

SystemRule cpuRule = new SystemRule();
cpuRule.setHighestCpuUsage(0.8);         // cpu > 80% 触发

SystemRule rtRule = new SystemRule();
rtRule.setAvgRt(500);                    // 平均 RT > 500ms 触发

SystemRule qpsRule = new SystemRule();
qpsRule.setQps(50000);                   // 全局 QPS > 5w 触发

SystemRuleManager.loadRules(Arrays.asList(loadRule, cpuRule, rtRule, qpsRule));
```

### 4.3 用到的本周知识点

- **滑动窗口（Day1）**：Sentinel LeapArray 默认 sampleCount=2，秒杀场景调到 10
- **熔断状态机（Day2）**：CLOSED → OPEN(10s) → HALF_OPEN(5次探测) → CLOSED
- **降级八种策略（Day2）**：兜底页（限流）+ 异步化（异常）双策略
- **集群限流（Day3）**：Token Server 失败 fallback 本地
- **本地预限流（Day3）**：单机 5000 QPS 是全局 10w / 20台 × 0.8 反推
- **热点参数 topN（Day3）**：秒杀商品单独 1000 QPS 阈值
- **BBR 自适应（Day4）**：系统规则作为兜底，避免突发流量过载
- **LeapArray（Day7深挖）**：底层支撑限流/熔断/热点/自适应

### 4.4 关键参数

```text
单机阈值：5000 QPS（集群模式 fallback）
全局阈值：10w QPS（Token Server）
熔断窗口：5s（统计） + 10s（OPEN 持续）
最小样本：20（避免少量样本误判）
热点 topN：1000 QPS（秒杀商品单独）
系统规则：load1>8 / cpu>80% / rt>500ms / qps>5w
```

---

## 五、L5 资源层保护：DB/Redis 兜底

### 5.1 职责定位

```text
L5 是防护网最后一道闸门，目标：
  - DB 连接池限流
  - 慢 SQL 保护
  - Redis+Lua 精确计数（秒杀库存扣减）
  - fail-close 保护下游
```

### 5.2 实现方案

#### 5.2.1 DB 连接池保护

```java
// HikariCP 连接池配置
HikariConfig config = new HikariConfig();
config.setMaximumPoolSize(50);          // 最大连接数
config.setConnectionTimeout(3000);      // 连接获取超时 3s
config.addDataSourceProperty("maxWait", "3000");

// Sentinel 保护 DB 访问
@SentinelResource(value = "db.queryOrder", blockHandler = "dbBlockHandler")
public Order queryOrder(Long orderId) {
    return jdbcTemplate.queryForObject(...);
}
```

#### 5.2.2 Redis+Lua 库存扣减（漏桶平滑）

```lua
-- KEYS[1] = stock:PID_001, ARGV[1] = current time ms
local key = KEYS[1]
local stock = tonumber(redis.call('GET', key) or 0)
if stock <= 0 then
    return 0  -- 库存不足
end
redis.call('DECR', key)
return 1
```

#### 5.2.3 慢 SQL 熔断

```java
// Druid 慢 SQL 监控 + Sentinel 熔断
@SentinelResource(value = "db.executeSql", 
                  blockHandler = "sqlBlockHandler",
                  fallback = "sqlFallback")
public List<Map<String, Object>> executeSql(String sql) {
    // 执行 SQL
}

// 慢 SQL 比例熔断
DegradeRule slowSqlRule = new DegradeRule("db.executeSql")
    .setGrade(CircuitBreakerStrategy.SLOW_REQUEST_RATIO)
    .setCount(1000)              // 1s 慢 SQL
    .setSlowRatioThreshold(0.5);
```

### 5.3 用到的本周知识点

- **漏桶（Day1）**：调用 DB 用漏桶平滑，避免 DB 瞬时压力
- **Redis+Lua（Day5）**：库存扣减精确计数，Lua 保证原子性
- **fail-close（Day5）**：DB 故障时 fail-close，避免脏数据
- **熔断器（Day2）**：慢 SQL 熔断保护 DB

### 5.4 关键参数

```text
DB 连接池：50（单实例）
SQL 超时：3s
慢 SQL 阈值：1s（比例 > 50% 熔断 10s）
Redis+Lua：单分片 10w QPS
fail-close：DB 不可用时返回兜底，不写脏数据
```

---

## 六、防护网协同：分层阈值与流量削减

### 6.1 流量削减漏斗

```text
原始流量：100w QPS（恶意+正常）
  ↓ L1 CDN/WAF 拦截 30%
  剩余 70w QPS
  ↓ L2 Nginx+Lua 拦截 70%（剩余 21w QPS 中再挡掉）
  剩余 21w QPS（实际进入应用）
  ↓ L3 Gateway 集群限流 10w QPS
  剩余 10w QPS（精确阈值）
  ↓ L4 Sentinel 单机 5000 QPS × 20 台 = 10w
  剩余 10w QPS（业务处理）
  ↓ L5 资源层保护：DB 连接池 / Redis Lua 兜底
  最终落 DB：5w QPS（其他走缓存/异步）
```

### 6.2 各层阈值设计原则

```text
L1 CDN：粗，挡黑名单 + 地理，无阈值精确性要求
L2 Nginx：挡 80%，IP/接口粗粒度
L3 Gateway：精确全局阈值，集群限流 10w
L4 Sentinel：单机阈值 = 全局 / 机器数 × 0.8（本地预限流）
L5 资源层：兜底，根据资源容量反推
```

### 6.3 fail-open / fail-close 分层策略

| 层级 | 策略 | 理由 |
|------|------|------|
| L1 CDN | fail-open | CDN 故障由 L2 兜底 |
| L2 Nginx | fail-open | Nginx 故障由 L3 兜底 |
| L3 Gateway | fail-open | Token Server 故障回退本地限流 |
| L4 Sentinel | fail-open | Sentinel 故障放行，由 L5 兜底 |
| L5 资源层 | **fail-close** | DB/Redis 故障必须拒绝，避免脏数据 |

**架构师心法**：**外层 fail-open（保入口可用），内层 fail-close（保数据正确）**——越靠近数据越保守。

---

## 七、可观测性：防护网监控告警

### 7.1 指标体系

```text
L1 CDN：
  - 拦截率（IP/UA/地理）
  - 误杀率
L2 Nginx：
  - 429 比例
  - 挡量数
L3 Gateway：
  - 集群限流通过/拒绝数
  - Token Server 健康度
  - 染色流量分布
L4 Sentinel：
  - 限流 QPS / 拒绝 QPS
  - 熔断器状态（CLOSED/OPEN/HALF_OPEN）
  - 系统规则触发次数
  - 热点参数命中率
L5 资源层：
  - DB 连接池使用率
  - 慢 SQL 数
  - Redis 命中率
```

### 7.2 告警分级

```text
P0（电话告警）：
  - L4 熔断器 OPEN 持续 > 30s
  - L5 DB 连接池 > 90%
  - L3 Token Server 全挂

P1（短信告警）：
  - L4 限流拒绝率 > 30%
  - L2 Nginx 429 > 20%
  - L5 Redis 命中率 < 80%

P2（IM 告警）：
  - L4 系统规则触发
  - L4 热点参数命中率骤降
```

---

## 八、故障演练：防护网健壮性验证

### 8.1 演练计划

```text
每月演练：
  1. Token Server 故障切换（验证 fallback 本地）
  2. Redis 单分片故障（验证库存扣减降级）
  3. 下游支付服务慢调用（验证熔断器 OPEN）
  4. DB 慢 SQL（验证资源层 fail-close）
  5. 单租户突发流量（验证租户隔离）
  6. 突发超阈值流量（验证 BBR 自适应）

每季演练：
  7. 整机房故障（验证多机房切换）
  8. CDN 故障（验证 L2 兜底）
```

### 8.2 演练指标

```text
故障注入 → 系统恢复时间 < 30s
故障期间可用性 > 99.9%
故障期间 P99 < 1s
告警延迟 < 10s
```

---

## 九、与用户业务背景的对应

| 用户业务 | 在防护网中的对应 |
|---------|----------------|
| **蛋壳钱包（TCC分布式事务）** | L5 资源层 fail-close + 慢 SQL 熔断，保证支付数据一致性 |
| **平安健康险保险商城** | L3 流量染色 + L4 租户隔离，多租户共享防护网 |
| **IM 在线客服** | L4 热点参数限流（按客服ID），L5 Redis 缓存兜底 |
| **医疗在线问诊** | L3 租户隔离 + L4 降级返回兜底医生 |
| **国美e卡资金路由** | L5 Redis+Lua 精确计数 + fail-close |
| **啄木鸟智慧公卫体检** | L4 系统自适应 + 多租户隔离 |
| **内部管理系统（SETNX 裸实现）** | L4 不走 Sentinel，用 Guava 单机限流（QPS低） |
| **ToC核心业务（Redisson）** | L4 Redisson RRateLimiter + Sentinel 双保险 |
| **完整秒杀系统** | L1-L5 五层全防护 + 故障演练 |

---

## 十、架构师视角的总结

### 10.1 防护网设计的三大原则

```text
1. 分层而治：每层职责单一，外层挡量内层精控
2. fail 分级：外层 fail-open 保可用，内层 fail-close 保正确
3. 自适应兜底：人工阈值 + BBR 自适应，应对突发流量
```

### 10.2 防护网的"反模式"

```text
反模式1：单层限流——所有压力集中到一层，单点瓶颈
反模式2：阈值一致——所有层用同样阈值，无削减漏斗
反模式3：fail-open 到底——资源层也 fail-open，脏数据风险
反模式4：无自适应——突发流量靠人工调阈值，反应慢
反模式5：无演练——线上故障第一次暴露，恢复时间长
```

### 10.3 与本周内容的串联

```text
Day1 限流算法 → L1-L5 每层选不同算法（令牌桶/滑动窗口/漏桶）
Day2 熔断降级 → L4 熔断器 + 降级策略，L5 慢 SQL 熔断
Day3 集群限流 → L3 Token Server + L4 本地预限流 + 流量染色
Day4 自适应   → L4 系统规则作为兜底
Day5 实战综合 → L1-L5 分层架构本身 + 故障演练 + 可观测性
Day6 串联     → 一次性把全部知识点用到防护网设计
Day7 深挖     → LeapArray 是 L4 所有 Slot 的底层支撑
```

---

## 十一、与架构师水平的差距及补足方向

### 差距

1. **分层阈值的量化设计经验不足**——业务里只在单层（应用层）配置限流，没系统设计过 L1-L5 各层阈值的削减漏斗，对"每层挡多少"缺乏量化数据

2. **fail-open / fail-close 的分层策略不体系化**——业务里默认全 fail-open 或全 fail-close，没分析过"外层 open 内层 close"的分级策略

3. **流量染色与租户隔离的实战经验少**——业务里没用过 Sentinel 的流量染色能力，对多租户场景的隔离方案只停留在理论

4. **故障演练体系缺失**——业务里没做过限流降级的故障演练，对 Token Server 故障、Redis 故障、下游慢调用等场景的恢复时间无第一手数据

5. **可观测性指标体系不全面**——只监控限流拒绝率，没监控熔断器状态分布、热点参数命中率、系统规则触发次数等深度指标

6. **防护网与业务的对应关系不清晰**——业务背景里的多个项目（蛋壳钱包/保险商城/IM/医疗）如何各自接入防护网，缺统一设计

### 补足方向

1. **在秒杀系统搭建完整 L1-L5 防护网**：CDN → Nginx+Lua → Gateway → Sentinel → Redis+Lua，验证流量削减漏斗
2. **设计分层阈值表**：每层阈值、削减比例、fail 策略、降级方案，形成标准化文档
3. **接入流量染色**：秒杀/普通/灰度三色分流，验证 L4 按染色独立限流
4. **建立月度故障演练机制**：6 个核心场景（Token Server/Redis/下游/DB/租户/突发）每月轮换
5. **完善可观测性**：接入 Prometheus + Grafana，建立 5 层指标看板，配置 P0/P1/P2 三级告警
6. **整理"业务接入防护网 SOP"**：每个新业务接入时按 SOP 走，避免重复造轮子

---

## 十二、明日预告

Day7 将深挖 Sentinel 滑动窗口 LeapArray 底层原理——它是 Day1（限流算法）、Day2（熔断器）、Day4（自适应限流）共同的底层数据结构，深挖它能把本周内容串成一条线，从"是什么"推进到"底层怎么实现"。
