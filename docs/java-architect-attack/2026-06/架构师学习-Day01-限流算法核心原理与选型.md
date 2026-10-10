# 架构师学习-Day01-限流算法核心原理与选型

> 日期：2026年06月22日（周一）
> 周主题：限流降级熔断与高可用架构
> 出题日：Day01 - 原理与选型

---

## 背景

你的秒杀系统在双11峰值 QPS 达到 10w+，网关层、应用层、资源层都需要限流。面试官递过白板：先把限流算法讲清楚。

限流是高可用架构的第一道闸门，是秒杀、支付、IM 等高并发业务的必修课。本日聚焦于**算法原理与选型**，为后续熔断降级、多级防护打基础。

---

## 题目一（原理题）：四种经典限流算法对比

请画出并解释这四种限流算法的原理与时序图：

1. 固定窗口计数器（Fixed Window）
2. 滑动窗口计数器（Sliding Window）
3. 漏桶算法（Leaky Bucket）
4. 令牌桶算法（Token Bucket）

并回答：

- 哪种算法会出现"临界突发流量"？为什么？
- 漏桶和令牌桶的本质区别是什么？分别在什么场景下选谁？
- 为什么 Sentinel 默认用滑动窗口，而 Guava RateLimiter 用令牌桶？

### 作答区

#### 1. 四种限流算法原理与时序

**① 固定窗口计数器（Fixed Window）**

原理：把时间切分为固定窗口（如每秒一个窗口），每个窗口维护一个计数器，请求进来 +1，超过阈值拒绝。窗口切换时计数器清零。

```
窗口1 [0-1s]:  ████████████ 100  (阈值100, 全部放行)
窗口2 [1-2s]:  ███████████████████ 150 (超50被拒)
```

时序：
```
t=0.0s  req → counter=1
t=0.5s  req → counter=100 (满)
t=0.6s  req → reject
t=1.0s  窗口切换 counter=0
t=1.01s req → counter=1 (放行)
```

**② 滑动窗口计数器（Sliding Window）**

原理：把窗口细分为多个小桶（如 1s 窗口分 10 个 100ms 桶），统计"当前时刻往前 1s 内所有桶的计数和"。每过一个桶时间，淘汰最老的桶，新增一个新桶。

```
[桶0][桶1][桶2]...[桶9]   ← 当前窗口覆盖桶0~桶9
       ↓ 时间推移
   [桶1][桶2]...[桶9][桶10]  ← 桶0淘汰,桶10加入
```

时序：
```
t=0.0s  bucket[0]=1
t=0.1s  bucket[1]=1
...
t=1.0s  sum(bucket[1..10]) 作为当前QPS, bucket[0]被淘汰
```

**③ 漏桶算法（Leaky Bucket）**

原理：请求像水一样倒入漏桶，桶容量有限，水以**恒定速率**漏出（处理）。入水超桶容量则溢出（拒绝）。**输出速率恒定**。

```
        入水(请求)
         ↓↓↓↓↓
    ┌────────────┐
    │  桶(队列)   │ ← 容量 N
    │ ~~水水水~~ │
    └─────┬──────┘
          ↓ 恒定速率漏出(处理)
        qps = R
```

时序：
```
t=0  突发来 200 请求, 桶容量100 → 100入队, 100拒绝
t=0~1s 每秒处理 50(恒定) → 桶剩50
t=1s 又来 50 → 50入队, 桶满100
```

**④ 令牌桶算法（Token Bucket）**

原理：以**恒定速率 R**往桶里放令牌，桶容量 N。请求来时取一个令牌，取到放行，取不到拒绝。**允许突发**（桶里累积的令牌可瞬时消耗）。

```
       令牌以R速率放入
         ↓↓↓
    ┌────────────┐
    │ 桶(令牌)    │ ← 容量 N
    │ ◯◯◯◯◯◯◯◯ │
    └─────┬──────┘
          ↓ 请求取令牌
        req → 有令牌放行 / 无令牌拒绝
```

时序：
```
t=0  桶里100令牌(满)
t=0  突发来 150 请求 → 100放行, 50拒绝
t=1s 又来 50 请求 → 期间补了50令牌, 50放行
```

#### 2. 临界突发流量问题

**固定窗口会出现临界突发流量**。

原因：窗口切换瞬间计数器清零，攻击者可在窗口切换前后各放一波流量，瞬间通过 2x 阈值。

```
窗口1 [0-1s]: 阈值100
窗口2 [1-2s]: 阈值100

攻击: t=0.99s 来 100 请求 (窗口1满)
      t=1.01s 来 100 请求 (窗口2清零, 又满)
→ 0.02s 内通过 200 请求, 是阈值的2倍
```

滑动窗口通过"覆盖窗口期内所有桶"解决了这个问题——切换瞬间不会清零，而是平滑淘汰老桶。

#### 3. 漏桶 vs 令牌桶的本质区别

| 维度 | 漏桶 | 令牌桶 |
| --- | --- | --- |
| 输出速率 | **恒定**（漏水速率固定） | **可突发**（桶里令牌可瞬时消耗） |
| 入口控制 | 桶满则拒绝 | 无令牌则拒绝 |
| 突发流量 | 不允许（强行平滑） | 允许（受桶容量限制） |
| 实现角色 | 请求队列 + 定时消费 | 令牌生产 + 请求消费 |

**选型**：
- **漏桶**：需要**严格平滑流量**的场景，如调用第三方接口（对方限流 100 QPS，我方用漏桶保证不超过）
- **令牌桶**：需要**允许突发**的场景，如网关入口限流（用户瞬时点击 burst，令牌桶能容忍）

**秒杀场景选谁**：网关层用令牌桶（容忍突发），调用下游敏感接口用漏桶（保护下游）。

#### 4. Sentinel 用滑动窗口 / Guava RateLimiter 用令牌桶的原因

**Sentinel 选滑动窗口的原因**：
1. 滑窗天然支持**多维统计**（QPS、RT、异常数、慢调用比例）——熔断需要这些指标，滑窗一套数据结构搞定
2. 滑窗对**临界突发**免疫，限流更精确
3. Sentinel 是"限流+熔断"一体化框架，滑窗是共同基础

**Guava RateLimiter 选令牌桶的原因**：
1. Guava RateLimiter **只做限流，不做熔断**——不需要统计 RT/异常，令牌桶足够
2. 令牌桶实现简单，单机内存即可，无锁/低锁实现性能高
3. Guava 的典型场景是**单机入口突发流量控制**（如限制日志写入速率），令牌桶的"允许突发"特性更合适
4. Guava RateLimiter 还提供 `SmoothBursty`（默认）和 `SmoothWarmingUp` 两种预热变体，进一步适配不同业务

#### 与架构师水平的差距及补足方向

**差距**：
1. **算法选型经验不足**——业务里默认用 Redisson 限流，没系统对比过四种算法在不同场景的适用性
2. **滑动窗口的桶数与精度取舍**——桶越多越精确但内存越大，没量化分析过
3. **令牌桶的预热设计**——SmoothWarmingUp 的预热曲线设计原理不熟
4. **临界突发流量的真实影响**——理论知道，但没在压测中复现过

**补足方向**：
- 阅读 Sentinel `LeapArray` 与 Guava `SmoothBursty` 源码
- 在秒杀系统中对比四种算法的压测曲线（突发流量通过率、拒绝率、延迟分布）
- 整理一份"算法选型决策树"：按业务容忍突发程度、是否需要平滑、是否需要多维统计三维度选型

---

## 题目二（实战题）：分布式限流设计

单机限流用本地计数器即可，但集群限流需要分布式方案。请设计一个支撑 10w QPS 的分布式限流方案：

1. 基于 Redis + Lua 的分布式限流如何实现？Lua 脚本伪代码思路？
2. 为什么必须用 Lua？不用 Lua 会有什么并发问题？
3. Redis 集群模式下，限流 key 怎么路由？如果限流 key 落在不同分片上怎么保证准确？
4. 如果 Redis 挂了，限流是 fail-open（放行）还是 fail-close（拒绝）？架构上怎么取舍？
5. 还有哪些替代方案（如 Sentinel 集群流控、Nginx+Lua、网关层限流）？各自的适用场景？

### 作答区

#### 1. Redis + Lua 分布式限流实现

**核心思路**：用 Redis 的 INCR + EX 实现计数器，把"判断+计数"打包进 Lua 脚本保证原子性。

**滑动窗口 Lua 伪代码（Sentinel 集群限流思路）**：
```lua
-- KEYS[1] = 限流key, ARGV[1] = 窗口大小ms, ARGV[2] = 阈值, ARGV[3] = 当前时间ms, ARGV[4] = 桶数

local key = KEYS[1]
local windowMs = tonumber(ARGV[1])
local threshold = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local bucketCount = tonumber(ARGV[4])

-- 1. 清理过期桶
local bucketMs = windowMs / bucketCount
local earliestBucket = now - windowMs
redis.call('ZREMRANGEBYSCORE', key, 0, earliestBucket)

-- 2. 统计当前窗口内请求数
local current = redis.call('ZCARD', key)

-- 3. 判断
if current < threshold then
    -- 放行: 添加当前请求到zset
    redis.call('ZADD', key, now, now .. '-' .. math.random())
    redis.call('PEXPIRE', key, windowMs)
    return 1  -- 放行
else
    return 0  -- 拒绝
end
```

**令牌桶 Lua 伪代码**：
```lua
-- KEYS[1] = 桶key, ARGV[1] = 容量, ARGV[2] = 速率(令牌/秒), ARGV[3] = 当前时间秒

local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

-- 读取上次状态
local last_tokens = tonumber(redis.call('HGET', key, 'tokens') or capacity)
local last_time = tonumber(redis.call('HGET', key, 'last_time') or now)

-- 计算新增令牌
local delta = math.max(0, now - last_time)
local filled = last_tokens + delta * rate
local tokens = math.min(capacity, filled)

if tokens >= 1 then
    tokens = tokens - 1
    redis.call('HMSET', key, 'tokens', tokens, 'last_time', now)
    redis.call('EXPIRE', key, capacity / rate * 2)
    return 1
else
    redis.call('HMSET', key, 'tokens', tokens, 'last_time', now)
    return 0
end
```

#### 2. 为什么必须用 Lua

**不用 Lua 的并发问题**：典型的"判断+操作"非原子性。

```
T1: GET key → 99
T2: GET key → 99      (两个并发请求都读到99)
T1: INCR key → 100    (放行)
T2: INCR key → 101    (也放行, 但实际已超阈值!)
```

**Lua 保证原子性**：Redis 单线程执行 Lua 脚本，期间不会被其他命令打断，"判断+计数+写入"是一个原子操作。

**替代方案**：
- `INCR` + `EXPIRE` 组合（但首次设置和过期时间设置非原子，可能 INCR 成功但 EXPIRE 失败导致 key 永不过期）
- `SETNX` + `EXPIRE` 同样有问题
- Lua 是最干净的方案，且一次网络往返完成所有操作

#### 3. Redis 集群模式下的 key 路由问题

**问题**：Redis Cluster 用 CRC16 路由 key 到分片，如果限流 key 落在不同分片，无法保证全局准确。

```
限流key="rate:user:1001" → 落分片A
限流key="rate:user:1002" → 落分片B
→ 两个分片各统计各的, 全局QPS翻倍
```

**解决方案**：

**方案1：Hash Tag 强制同分片**
```
key = "rate:{user1001}:api"  ← {user1001} 是hash tag
所有以 {user1001} 为tag的key都落同一分片
```
适用：单用户/单接口限流，所有相关计数器需在同一分片。

**方案2：分片聚合**
- 把限流 key 拆成 N 个子 key（如 `rate:api:0` ~ `rate:api:9`），分别落在不同分片
- 限流时随机选一个子 key 计数，统计时 SUM 所有子 key
- 牺牲精确性换吞吐（误差 = 1/N）

**方案3：集中式限流**
- 限流 key 强制路由到单一分片（专用限流 Redis）
- 简单但该分片是瓶颈，无法水平扩展

**方案4：本地预限流 + 集群精限流**
- 每台应用本地先做粗限流（如阈值 80% 本地限）
- 通过的请求再走 Redis 精限流
- 大幅降低 Redis 压力，Sentinel 集群限流就是这思路

#### 4. Redis 挂了：fail-open 还是 fail-close

| 策略 | 行为 | 适用场景 | 风险 |
| --- | --- | --- | --- |
| **fail-open（放行）** | Redis 挂了不限流，全放行 | 非核心业务、可降级业务 | 把下游打挂 |
| **fail-close（拒绝）** | Redis 挂了全部拒绝 | 强保护场景（支付、扣库存） | 误杀业务，可用性归零 |



**架构取舍**：

- **核心链路（秒杀下单、支付）**：fail-close + 本地兜底
  - Redis 挂了先走本地限流（粗略但保命）
  - 本地限流也失效才 fail-close
- **非核心链路（查询、推荐）**：fail-open
  - Redis 挂了放行，宁可打挂下游也不能让入口不可用
  - 配合下游自身熔断兜底

**实际方案**：
1. **多层兜底**：Redis 集群挂 → 本地缓存限流 → fail-close
2. **降级而非直接拒绝**：fail-close 时返回兜底页而非 500
3. **告警 + 快速恢复**：Redis 故障要分钟级恢复，不能长时间 fail-close

**心法**：**fail-open 是"宁可打挂下游也要可用"，fail-close 是"宁可不可用也不打挂下游"**——核心 vs 非核心的判断决定选谁。

#### 5. 其他替代方案

| 方案 | 适用场景 | 优点 | 缺点 |
| --- | --- | --- | --- |
| **Sentinel 集群流控** | 微服务内部限流 | 与 Sentinel 生态融合，可视化规则推送 | Token Server 单点，需高可用部署 |
| **Nginx + Lua (OpenResty)** | 网关层入口限流 | 在最外层挡流量，性能极高 | 规则更新需 reload，灵活性差 |
| **网关层限流（Spring Cloud Gateway / Kong）** | API 网关层 | 与路由/鉴权一体化，开发友好 | 受限于网关本身性能 |
| **Redis + Lua（自研）** | 精确集群限流 | 灵活，可控性强 | 运维成本高，需自研控制台 |
| **本地单机限流（Guava / Bucket4j）** | 单机限流 | 无网络开销，性能最高 | 无法全局限流 |

**典型分层组合**：
```
请求 → CDN/WAF (L7防护)
       → Nginx+Lua (粗限流,挡80%流量)        ← 网关层
         → Spring Cloud Gateway (细限流,API级) ← API网关
           → Sentinel 集群流控 (应用级)        ← 应用层
             → Redis+Lua (资源级,如DB前限流)   ← 资源层
```

**秒杀系统实际选型**：
- **入口层**：Nginx + Lua（挡掉 80% 流量）
- **API 网关层**：Spring Cloud Gateway + Redis 限流（按用户/IP/API 细化）
- **应用层**：Sentinel 集群流控（保护核心服务）
- **资源层**：Redis + Lua（保护 DB、下游接口）

#### 与架构师水平的差距及补足方向

**差距**：
1. **Lua 脚本调优经验少**——业务里用 Redisson 封装好的 RRateLimiter，没自己写过 Lua，对脚本中的时间精度、桶清理策略理解不深
2. **集群模式限流的精度与性能取舍**——Hash Tag、分片聚合、本地预限流的方案对比没系统压测过
3. **fail-open / fail-close 的决策体系不成熟**——业务里默认 fail-open，没分析过哪些场景该 fail-close
4. **多层限流的协同设计**——每层独立配置阈值，没形成"上游挡 80%、下游精限"的协同体系
5. **限流的可观测性弱**——只看拒绝率，没看"限流命中率、限流延迟分布、桶满时间分布"等深度指标

**补足方向**：
- 手写一份 Redis + Lua 滑动窗口限流脚本，压测对比 Redisson RRateLimiter 的性能
- 在秒杀系统搭建"Nginx+Lua → Gateway → Sentinel → Redis+Lua"四层限流体系，验证协同效果
- 整理"fail-open / fail-close 决策表"：按业务核心度、下游容忍度、降级成本三维度选型
- 接入 Prometheus + Grafana，监控限流深度指标

- 每道题作答后，需指出与架构师水平的差距及补足方向
- 重点谈你在蛋壳钱包 / 秒杀系统中实际遇到的限流场景与踩坑
- 作答完成后，整理为问答文档与架构师梳理两个文档