# Day 2：服务治理深入 — 限流·熔断·降级·隔离（练习整理）

## 题目一：Sentinel限流深入 — 滑动窗口源码级理解

### Sentinel滑动窗口实现原理

```
传统固定窗口的问题：
  第1秒后500ms：来了100个请求 → 通过
  第2秒前500ms：来了100个请求 → 通过
  实际1秒内（跨窗口边界）：200个请求通过 → 2倍突发！

Sentinel的滑动窗口（LeapArray）：
  把1秒切成2个500ms的子窗口（sampleCount=2, intervalInMs=1000）

  时间轴：|----窗口0----|----窗口1----|
          0ms        500ms        1000ms

  当前时间750ms → 统计窗口0(250ms-750ms) + 窗口1(250ms-750ms)
  当前时间1250ms → 窗口0过期，窗口0位置被复用 → 统计窗口1+新窗口0

  核心数据结构：
    LeapArray
      ├── windowLengthInMs = intervalInMs / sampleCount  // 子窗口长度
      ├── sampleCount = 2                                 // 子窗口数量
      ├── intervalInMs = 1000                             // 统计间隔
      └── array = AtomicReferenceArray<WindowWrap>        // 环形数组
            ├── WindowWrap[0]: { windowStart, WindowWrap.value: MetricBucket }
            └── WindowWrap[1]: { windowStart, WindowWrap.value: MetricBucket }

  MetricBucket 内部用 LongAdder 统计：
    pass计数、block计数、exception计数、rt总和、success计数
```

### 源码级关键流程

```java
// 1. 获取当前窗口
public WindowWrap<T> currentWindow(long timeMillis) {
    int idx = calculateTimeIdx(timeMillis);   // 计算数组下标
    long windowStart = calculateWindowStart(timeMillis); // 窗口起始时间

    while (true) {
        WindowWrap<T> old = array.get(idx);
        if (old == null) {
            // 新窗口 → CAS创建
            WindowWrap<T> window = new WindowWrap<>(windowLengthInMs, windowStart, newEmptyBucket());
            if (array.compareAndSet(idx, null, window)) return window;
        } else if (windowStart == old.windowStart()) {
            // 时间匹配 → 直接用
            return old;
        } else if (windowStart > old.windowStart() + windowLengthInMs) {
            // 窗口过期 → 重置（这就是滑动！）
            if (updateLock.tryLock()) {
                return resetWindowTo(old, windowStart);
            }
        } else {
            // 时钟回拨 → 等待
            Thread.yield();
        }
    }
}

// 2. 统计当前QPS
public double passQps() {
    // 取所有有效窗口的pass计数求和 / 统计间隔
    return getCurrentBucketArray()
        .stream()
        .filter(w -> isWindowDeprecated(w))
        .mapToLong(w -> w.value().pass())
        .sum() * 1000.0 / intervalInMs;
}
```

### 为什么Sentinel选滑动窗口而不是令牌桶？

```
Sentinel的设计哲学：运行时动态规则 + 实时统计

  令牌桶/漏桶的问题是：
    - 需要预置速率参数，改参数要重建桶
    - 统计维度单一（只有QPS），不支持多维度（RT、异常比、线程数）

  滑动窗口的优势：
    - 统计数据天然支持多维度（pass/block/exception/rt）
    - 规则变更不需要重建数据结构
    - 支持热点参数限流（对参数值维度统计）

  Sentinel的分工：
    滑动窗口 → 统计 + 判断（该不该限流）
    令牌桶/漏桶 → 排队等待模式的效果（匀速器）
    两者配合，不是替代关系
```

### 与架构师水平的差距

| 层次 | 回答 |
|------|------|
| 开发 | 加个@SentinelResource注解限流 |
| 高级开发 | Sentinel用滑动窗口统计QPS，比固定窗口精确 |
| 架构师 | Sentinel滑动窗口的LeapArray是环形数组+时间窗口过期重置，用LongAdder高并发统计，CAS保证无锁。滑动窗口负责统计+判断，令牌桶/漏桶在排队模式下做匀速效果，二者是配合不是替代。选滑动窗口是因为支持多维度统计+动态规则变更 |

**补足方向**：能画出LeapArray的环形数组结构，说清窗口过期→重置→滑动的完整流程。面试时能答"Sentinel为什么不用令牌桶做限流"。

---

## 题目二：熔断器设计模式 — 三种熔断策略与参数调优

### Sentinel三种熔断策略

| 策略 | 触发条件 | 适用场景 | 典型参数 |
|------|---------|---------|---------|
| **慢调用比例** | RT > 阈值的调用占比超限 | 下游变慢但没挂 | slowRatioThreshold=0.5, RT阈值=500ms |
| **异常比例** | 异常占比超限 | 下游偶发异常 | ratioThreshold=0.5 |
| **异常数** | 异常绝对数超限 | 下游必挂场景 | count=5 |

### 熔断器状态机的工程实现

```
Sentinel熔断器的核心：CircuitBreaker接口

  ┌─────────────────────────────────────────────────┐
  │              CircuitBreaker                      │
  │  ├── tryPass(ctx)        → 判断是否放行           │
  │  ├── currentState()      → 当前状态               │
  │  ├── onRequestComplete(ctx) → 统计结果            │
  │  └── strategy                                   │
  │       ├── SlowRequestRatio                      │
  │       ├── ExceptionRatio                        │
  │       └── ExceptionCount                        │
  └─────────────────────────────────────────────────┘

  状态转换：
    CLOSED → OPEN：
      条件：统计窗口内，满足策略条件
      代码：currentState.compareAndSet(CLOSED, OPEN)
      动作：记录熔断开始时间，后续请求快速失败

    OPEN → HALF_OPEN：
      条件：熔断时长到期（timeWindow，默认10s）
      代码：检测 System.currentTimeMillis() - circuitOpenTime >= timeWindow
      动作：放行一个探测请求

    HALF_OPEN → CLOSED：
      条件：探测请求成功（RT正常/无异常）
      动作：重置统计，恢复正常

    HALF_OPEN → OPEN：
      条件：探测请求失败
      动作：重新开始计时，继续熔断
```

### 参数调优实战

```java
// 场景1：订单服务偶尔慢查询 → 慢调用比例熔断
DegradeRule rule1 = new DegradeRule("orderService")
    .setGrade(CircuitBreakerStrategy.SLOW_REQUEST_RATIO.getType())
    .setCount(500)              // RT阈值500ms
    .setSlowRatioThreshold(0.5) // 慢调用比例50%
    .setTimeWindow(10)          // 熔断10秒
    .setMinRequestAmount(5)     // 最少5个请求才统计
    .setStatIntervalMs(1000);   // 统计窗口1秒

// 场景2：支付服务异常率高 → 异常比例熔断
DegradeRule rule2 = new DegradeRule("paymentService")
    .setGrade(CircuitBreakerStrategy.EXCEPTION_RATIO.getType())
    .setCount(0.3)              // 异常比例30%
    .setTimeWindow(30)          // 熔断30秒（支付要谨慎，多等一会）
    .setMinRequestAmount(10)    // 最少10个请求
    .setStatIntervalMs(5000);   // 统计窗口5秒

// 场景3：库存服务直接报错 → 异常数熔断
DegradeRule rule3 = new DegradeRule("inventoryService")
    .setGrade(CircuitBreakerStrategy.EXCEPTION_COUNT.getType())
    .setCount(5)                // 5个异常就熔断
    .setTimeWindow(60)          // 熔断60秒（库存服务可能要重启）
    .setMinRequestAmount(3)
    .setStatIntervalMs(10000);  // 统计窗口10秒
```

### 熔断参数调优的架构师决策

```
关键问题：熔断时间窗口设多长？

  太短（1-3秒）：
    - 探测太频繁，下游还没恢复就又打过去
    - 适合：下游是偶发超时，很快自恢复

  适中（10-30秒）：
    - 给下游恢复时间，又不会降级太久
    - 适合：大部分业务场景的默认值

  太长（60秒+）：
    - 降级时间太长，用户体验差
    - 适合：下游需要重启/扩容的场景

  架构师经验值：
    - 正常业务：10秒
    - 核心链路（支付）：30秒
    - 需人工介入（DB故障）：60秒，同时触发告警

  另一个关键参数：minRequestAmount
    - 设太小（1-2）：单次偶然失败就熔断，误杀
    - 设太大（100）：真正故障时反应慢
    - 架构师经验值：5-10（QPS低的服务取5，QPS高的取10）
```

### 与架构师水平的差距

| 层次 | 回答 |
|------|------|
| 开发 | 加个熔断规则，失败了走降级 |
| 高级开发 | 熔断器有三种状态CLOSED/OPEN/HALF_OPEN，用Sentinel配置 |
| 架构师 | 三种熔断策略对应不同故障模式：慢调用比例→下游变慢、异常比例→偶发故障、异常数→必挂场景。参数调优是业务决策：timeWindow取决于下游恢复时间（业务10s/支付30s/DB故障60s），minRequestAmount防误杀取5-10。熔断器状态切换用CAS保证并发安全，HALF_OPEN只放一个探测请求 |

**补足方向**：能针对你的秒杀系统，写出每个下游服务的熔断规则配置，并解释每个参数为什么这么设。

---

## 题目三：降级策略矩阵 — 不同业务场景怎么降级

### 降级的四种策略

| 策略 | 做法 | 数据特征 | 典型场景 |
|------|------|---------|---------|
| **返回兜底值** | 硬编码默认值返回 | 无实时性要求 | 商品详情的推荐栏降级 → "暂无推荐" |
| **返回缓存数据** | 读缓存/上次成功结果 | 可接受短期过期 | 订单查询降级 → 读Redis缓存 |
| **走备链路** | 调备用服务/读备库 | 数据最终一致 | 支付降级 → 走备用支付通道 |
| **异步化** | 请求入MQ，异步处理 | 可接受延迟 | 秒杀下单降级 → "排队中"+ MQ异步处理 |

### 降级策略矩阵 — 按业务场景选型

```
                    实时性要求
                 低           高
              ┌────────┬────────┐
         允许  │ 兜底值  │ 缓存   │
  数据     │        │        │
  过期     ├────────┼────────┤
         不允许 │ 异步化  │ 备链路 │
              └────────┴────────┘

  你的项目映射：
    兜底值：IM未读数降级 → 返回0（用户感知弱）
    缓存：保险商城商品列表降级 → 读Redis（允许1分钟过期）
    备链路：蛋壳钱包支付降级 → 走备用通道（不允许数据错误）
    异步化：秒杀下单降级 → "排队中"+ MQ（允许几秒延迟）
```

### 降级的层次设计

```
L1 自动降级（代码逻辑，毫秒级切换）
  ┌──────────────────────────────────────────┐
  │ @SentinelResource(fallback = "fallback") │
  │ public Order getOrder(Long id) {         │
  │     return orderService.getById(id);     │
  │ }                                        │
  │                                          │
  │ public Order fallback(Long id) {         │
  │     return cacheService.getOrder(id);    │  ← L1: 读缓存
  │ }                                        │
  └──────────────────────────────────────────┘

L2 半自动降级（配置开关，秒级切换）
  ┌──────────────────────────────────────────┐
  │ Nacos配置中心：                           │
  │   order.query.degrade = true             │  ← 运维一键开启
  │   order.query.cache.ttl = 300            │  ← 缓存TTL可调
  │                                          │
  │ @Value("${order.query.degrade}")         │
  │ private boolean degradeEnabled;          │
  │                                          │
  │ if (degradeEnabled) {                    │
  │     return cacheService.getOrder(id);    │  ← L2: 配置开关降级
  │ }                                        │
  └──────────────────────────────────────────┘

L3 手动降级（SOP预案，分钟级切换）
  ┌──────────────────────────────────────────┐
  │ 预案文档：                                │
  │   当订单DB不可用 > 5分钟：                │
  │     1. 切读备库（DBA执行）               │
  │     2. 修改Nacos配置指向备库              │
  │     3. 通知业务方"数据可能有1分钟延迟"    │
  │   当支付通道不可用 > 10分钟：             │
  │     1. 切备用支付通道                     │
  │     2. 更新前端文案"部分支付方式暂不可用"  │
  └──────────────────────────────────────────┘

  架构师核心认知：
    L1覆盖90%场景（自动+快速）
    L2覆盖9%场景（半自动+可控）
    L3覆盖1%场景（人工+慢但安全）
    三层不是替代关系，是叠加防御
```

### 核心链路 vs 非核心链路的降级差异

```
核心链路（下单/支付/账户）：
  降级策略 → 备链路 > 异步化 > 缓存（绝不用兜底值）
  原因：核心链路数据不能错，宁可慢也不能丢
  你的映射：
    蛋壳钱包TCC → 支付降级走备用通道，不用兜底值
    秒杀下单 → 降级走MQ异步化，不是直接返回"下单成功"假数据

非核心链路（推荐/评价/通知）：
  降级策略 → 兜底值 > 缓存 > 异步化（不用备链路，不值得）
  原因：非核心链路不值得备链路的成本
  你的映射：
    IM未读数 → 降级返回0，用户感知弱
    保险商城推荐 → 降级"暂无推荐"，不影响核心购买流程
```

### 与架构师水平的差距

| 层次 | 回答 |
|------|------|
| 开发 | 降级就返回默认值 |
| 高级开发 | 降级可以返回缓存数据，或走备链路 |
| 架构师 | 降级策略是二维矩阵：实时性要求×数据过期容忍度。四种策略按场景选择：兜底值（低实时+可过期）、缓存（高实时+可过期）、异步化（低实时+不可过期）、备链路（高实时+不可过期）。降级分三层：L1自动降级覆盖90%、L2配置开关覆盖9%、L3人工预案覆盖1%。核心链路绝不用兜底值，宁可慢也不能丢 |

**补足方向**：列出你的秒杀系统中每个服务的降级策略，标注属于L1/L2/L3哪层+为什么。

---

## 题目四：线程隔离 vs 信号量隔离 — 两种隔离策略的取舍

### 隔离的本质：切断故障传播

```
没有隔离：
  服务A
  ├── 调B（线程1-200）    ← B慢了，200个线程全卡在等B
  ├── 调C（线程1-200）    ← 共享线程池，C也调不到了
  └── 调D（线程1-200）    ← D也调不到了

  结果：B慢 → A的所有线程卡死 → C和D也跟着不可用

有隔离：
  服务A
  ├── 调B（独立线程池，20个线程）   ← B慢了，最多卡20个线程
  ├── 调C（独立线程池，30个线程）   ← C不受影响
  └── 调D（独立线程池，50个线程）   ← D不受影响

  结果：B慢 → 只影响调B的20个线程 → C和D正常
```

### 两种隔离策略对比

| 维度 | 线程池隔离 | 信号量隔离 |
|------|-----------|-----------|
| **原理** | 每个下游分配独立线程池 | 用计数器限制并发数 |
| **开销** | 大（线程创建+上下文切换） | 小（只是计数器） |
| **超时控制** | 天然支持（线程可被中断） | 不支持（调用线程同步等待） |
| **异步** | 支持（提交任务到线程池） | 不支持（在调用线程上执行） |
| **适用** | 下游慢/不可靠、需要超时 | 下游快/可靠、只是限并发 |
| **Sentinel** | 不直接支持（Hystrix核心） | 默认方式 |
| **Hystrix** | 默认推荐 | 非核心场景 |

### Sentinel的隔离实现

```
Sentinel不提供线程池隔离，只提供信号量隔离：

  Sentinel的思路：
    线程池隔离开销太大 → 用信号量限制并发数 → 配合熔断做超时控制
    省下线程池开销，用熔断器兜底

  Sentinel信号量隔离（线程数限流）：
    // 限制调orderService的并发线程数
    FlowRule rule = new FlowRule("orderService")
        .setCount(50)                                    // 最多50个线程同时调用
        .setGrade(RuleConstant.FLOW_GRADE_THREAD)        // 线程数限流
        .setLimitApp("default");

  线程数限流 vs QPS限流的区别：
    QPS限流：1秒内允许50次调用（不管每次调用多久）
    线程数限流：同时最多50个线程在调用（RT越长，并发越高越容易触发）

    RT=10ms，QPS=5000 → 并发线程 ≈ 5000×0.01 = 50
    RT=1000ms，QPS=50 → 并发线程 ≈ 50×1 = 50
    同样50个线程，QPS差100倍！

    所以：RT高的服务，线程数限流比QPS限流更合理
```

### Hystrix vs Sentinel 的隔离设计哲学

```
Hystrix哲学：最坏情况下的强隔离
  每个Command一个线程池 → 彻底隔离 → 开销大 → 已停更
  适合：对外部不可控服务的调用（第三方API、老系统）

Sentinel哲学：轻量级 + 熔断兜底
  信号量隔离 + 熔断器 → 隔离+超时双保险 → 开销小 → 社区活跃
  适合：内部微服务调用（可控、RT可预期）

  架构师决策：
    内部服务 → Sentinel（轻量，够用）
    外部服务 → 额外加一层异步+超时（不用Hystrix，用CompletableFuture+线程池）
```

### 实际项目中的隔离设计

```java
// 内部服务：Sentinel信号量 + 熔断
@SentinelResource(value = "orderService",
    blockHandler = "orderBlock",
    fallback = "orderFallback")
public Order getOrder(Long orderId) {
    return orderClient.getById(orderId);
}

// 外部服务：CompletableFuture + 自定义线程池 + 超时
private static final ExecutorService externalPool =
    new ThreadPoolExecutor(10, 50, 60L, TimeUnit.SECONDS,
        new LinkedBlockingQueue<>(100),
        new ThreadFactoryBuilder().setNameFormat("external-%d").build(),
        new ThreadPoolExecutor.CallerRunsPolicy());

public PaymentResult pay(PaymentRequest request) {
    CompletableFuture<PaymentResult> future = CompletableFuture
        .supplyAsync(() -> paymentClient.pay(request), externalPool)
        .orTimeout(3, TimeUnit.SECONDS);  // JDK9+，超时快速失败

    try {
        return future.get();
    } catch (TimeoutException e) {
        return PaymentResult.timeout();  // 降级
    }
}
```

### 与架构师水平的差距

| 层次 | 回答 |
|------|------|
| 开发 | 用Hystrix做线程隔离，Sentinel做限流 |
| 高级开发 | 线程池隔离开销大但彻底，信号量隔离轻量但不支持超时 |
| 架构师 | 隔离的本质是切断故障传播。线程池隔离=物理隔离（独立线程），信号量隔离=逻辑隔离（计数器限制并发）。Sentinel选信号量+熔断兜底是性能和安全的平衡。线程数限流比QPS限流更适合RT高的服务（RT×QPS=并发线程数）。内部服务用Sentinel轻量隔离，外部服务用CompletableFuture+独立线程池做真正隔离 |

**补足方向**：能解释"为什么Sentinel不用线程池隔离"和"外部服务怎么自己做隔离"。画图对比有隔离和无隔离时的故障传播路径。

---

## 题目五：秒杀系统容错实战 — 从网关到DB的五层防御

### 秒杀系统完整容错链路

```
用户请求
  │
  ↓
[L1 CDN/WAF层] ——— DDoS清洗、IP黑名单、人机验证
  │  挡掉90%恶意流量
  ↓
[L2 网关层] ——— Spring Cloud Gateway + Sentinel
  │  令牌桶限流10000 QPS
  │  用户维度限流（单用户5 QPS）
  │  商品维度限流（热点参数限流）
  │  挡掉90%正常溢出流量
  ↓
[L3 秒杀服务层] ——— 业务校验 + 本地预扣
  │  活动时间校验（本地缓存活动配置）
  │  库存预扣（Redis原子操作）
  │  售罄标记（Redis存售罄标志，直接返回）
  │  用户幂等校验（Redis SETNX）
  │  挡掉9%无效请求
  ↓
[L4 调用链路层] ——— Dubbo + Sentinel
  │  订单服务：熔断（慢调用比例50%，RT 500ms，熔断10s）
  │  库存服务：熔断（异常数5，熔断30s）
  │  支付服务：熔断（异常比例30%，熔断30s）
  │  降级策略：
  │    订单服务降级 → MQ异步下单 + "排队中"
  │    库存服务降级 → 拒绝新下单 + 人工介入
  │    支付服务降级 → 走备用支付通道
  ↓
[L5 数据层] ——— DB + Redis
  │  Redis Cluster（6主6从）
  │  MySQL主从 + 读写分离
  │  紧急扩容预案（5分钟扩2倍读库）
  │  兜底1%极端场景
  ↓
  成功下单

  五层防御的总通过率：
    10000 QPS → L1挡9000 → L2挡900 → L3挡90 → L4挡9 → L5挡0.9
    最终到达DB的 ≈ 1 QPS（库存扣减）
```

### 每层的限流算法选择

```
L1 CDN/WAF：不关心算法，规则引擎
L2 网关层：令牌桶（允许正常突发）
  - 10点开抢 → 前100ms涌入5万请求 → 令牌桶允许10000个瞬间通过
  - 超限返回"活动太火爆" → 用户体验可接受

L3 秒杀服务：滑动窗口（精确统计）
  - 单用户5 QPS（防刷）
  - 热点参数限流（商品维度）

L4 调用链路：熔断器（异常保护）
  - 不限流，而是异常时快速失败
  - 熔断+降级配合

L5 数据层：漏桶（匀速消费）
  - 库存扣减请求走MQ → Consumer匀速消费
  - 保护DB不被突发写入打挂

  整体看：令牌桶(入口) → 滑动窗口(中间) → 熔断(保护) → 漏桶(出口)
  和Day01的"谁在保护谁"完全对应！
```

### 售罄后的快速拒绝

```
关键优化：商品售罄后，后续请求不需要再走完整链路

  Redis售罄标记：
    // 库存扣到0时设置
    redis.set("seckill:soldout:" + itemId, "1", "EX", 3600);

    // 售罄判断（在网关层或服务层最前面）
    if ("1".equals(redis.get("seckill:soldout:" + itemId))) {
        return SeckillResult.soldOut();  // 直接返回"已售罄"
    }

  效果：
    10万QPS → 5秒卖完 → 剩余55秒全部直接返回"已售罄"
    DB压力：5秒内约5000次库存扣减 → 卖完后0次
    售罄标记挡掉99%+的后续请求

  这和第4周MQ的"消费端流控"思路一致：
    消费端处理不过来 → 丢弃/延后 → 保护系统
    秒杀售罄 → 直接拒绝 → 保护DB
```

### 秒杀容错的面试回答模板

```
面试官：你的秒杀系统怎么做容错的？

  第1层：CDN/WAF挡恶意流量，挡掉90%
  第2层：网关令牌桶限流，允许正常突发但超限拒绝，再挡90%
  第3层：服务层本地校验+Redis预扣+售罄标记，挡掉9%无效请求
  第4层：调用链路熔断降级，订单降级走MQ异步，支付走备通道
  第5层：DB层读写分离+紧急扩容预案

  关键数字：
    网关限流10000 QPS
    单用户5 QPS
    熔断阈值50%慢调用/500ms RT/10s窗口
    售罄标记5秒设置完成，后续请求0 DB压力

  最自豪的点：售罄标记机制，卖完后DB压力直接归零
```

### 与架构师水平的差距

| 层次 | 回答 |
|------|------|
| 开发 | 用Sentinel限流，Redis预扣库存 |
| 高级开发 | 五层防御，网关限流+熔断+降级 |
| 架构师 | 五层防御不是平铺，是漏斗：每层挡掉一个数量级，从10万QPS漏到DB只有几千次写入。每层限流算法不同：令牌桶(入口允许突发)→滑动窗口(精确统计)→熔断(异常保护)→漏桶(出口匀速)。售罄标记是最强优化：卖完后DB压力归零。关键数字信手拈来：网关1万QPS、单用户5QPS、熔断50%/500ms/10s、售罄5秒内设置 |

**补足方向**：用你秒杀系统的真实压测数据替换上面的数字，面试时能说"我压测过，网关层实际能扛X QPS"。

---

*日期：2026-05-26 | 第5周 Day2 | 服务治理深入*
