# Day 7：架构深挖 —— Sentinel 滑动窗口 LeapArray 底层原理

## 一、今日主题

本周限流降级熔断专题已经完成了从算法原理到工程实战的完整串联：

```text
Day1：限流算法核心原理与选型（固定窗口/滑动窗口/漏桶/令牌桶）
Day2：熔断器原理与降级策略设计（慢调用/异常比例/熔断状态机）
Day3：集群限流与流量隔离设计（Token Server/流量染色）
Day4：自适应限流与系统负载保护（BBR/系统规则）
Day5：限流降级熔断实战综合（多级防护体系）
```

今天不再泛泛讲限流整体架构，而是深挖一个贯穿 Day1/Day2/Day4 的核心数据结构：

```text
Sentinel 为什么用 LeapArray？LeapArray 是什么？
它如何用一套数据结构同时支撑 QPS 限流、RT 统计、熔断判断、热点参数？
```

这道题重点考察的不是"会不会用 Sentinel"，而是你能不能把滑动窗口背后的：

```text
数据结构（WindowWrap 数组 + 时间轮转）
并发安全（CAS 写入 + 自旋重试）
精度取舍（桶数 vs 内存 vs 准确性）
统计复用（限流/熔断/热点共用一套窗口）
工程演化（从 SlidingWindow 到 LeapArray 演进）
```

讲清楚。

---

## 二、题目：Sentinel 滑动窗口 LeapArray 源码深挖

你负责维护一个秒杀系统的限流降级中间件，线上反馈：

```text
现象1：限流阈值 1000 QPS，压测 1200 QPS 时实际通过 1100+，误差 10%
现象2：某接口 RT 突增到 5s，但熔断器延迟 2 秒才打开，导致下游被压垮
现象3：热点参数限流（topN 商品）在机器扩容后命中率骤降
现象4：JStack 抓到大量 STAT_OCCUPY_FAILED 自旋，CPU 飙高
```

现在要求你：

```text
从 LeapArray 的数据结构、写入路径、读取路径、并发控制出发，
解释清楚上述四个现象的根因，并给出架构师视角的参数调优与替代方案。
```

---

## 三、需要回答的问题

### 1. LeapArray 是什么？为什么不用 Queue 或 Map？

请说明：

```text
LeapArray 的核心数据结构（WindowWrap[] + sampleCount + intervalInMs）
时间轮转：如何根据当前时间戳定位到对应的桶？
桶的过期与复用：老桶如何被新桶"覆盖"？
```

重点说明：

```text
为什么是定长数组而不是链表/Queue？
为什么用 sampleCount（桶数）+ intervalInMs（窗口总长）两个参数？
桶数与精度的关系是什么？
```

### 2. 一个请求进入后，LeapArray 的写入路径是怎样的？

重点说明：

```text
currentWindow() 定位桶：cas 衡量 + 写入 + 自旋重试
updateStatistic() 写入桶的 statistic 对象
如何处理跨桶（时间跳过多个桶）？
如何处理时间回拨？
```

### 3. 限流 / 熔断 / 热点参数 / 自适应 如何复用同一套 LeapArray？

重点说明：

```text
StatisticSlot 写入哪些指标（pass/block/rt/success/exception）
FlowSlot 读取什么、计算什么、判断什么
DegradeSlot 如何用 RT/异常指标触发熔断
ParamFlowSlot 为什么需要为每个热点参数维护独立 LeapArray
```

### 4. 四个线上现象的根因与解决方案？

针对每个现象：

```text
现象1（限流误差 10%）：桶数与精度的取舍
现象2（熔断延迟 2s）：1s 窗口 vs 慢调用比例的有效样本
现象3（热点参数命中率骤降）：扩容后单机热点分散
现象4（STAT_OCCUPY_FAILED 自旋）：高并发下 CAS 失败的代价
```

---

## 四、作答区

### 1. LeapArray 是什么？为什么不用 Queue 或 Map？

#### 1.1 核心数据结构

LeapArray 是 Sentinel 滑动窗口的实现，源码核心字段：

```java
public abstract class LeapArray<T> {
    private int sampleCount;             // 桶数（窗口分多少个格子）
    private int intervalInMs;            // 窗口总时长（ms）
    private long intervalInSecond;       // 窗口总时长（秒，用于统计输出）
    private final AtomicReferenceArray<WindowWrap<T>> array;  // 桶数组

    // 每个 WindowWrap 是一个桶
    private static class WindowWrap<T> {
        long windowStart;   // 桶起始时间戳
        T value;            // 桶内数据（Statistic 对象）
    }
}
```

**关键设计**：
- **定长数组**而非链表/Queue：`new WindowWrap[sampleCount]`
- **每个桶固定时间长度**：`windowLengthInMs = intervalInMs / sampleCount`
- **桶通过时间戳索引**：`idx = (timeMillis / windowLengthInMs) % sampleCount`

#### 1.2 时间轮转：如何定位到对应桶

```java
private int calculateTimeIdx(long timeMillis) {
    long timeId = timeMillis / windowLengthInMs;
    return (int)(timeId % sampleCount);
}

private long calculateWindowStart(long timeMillis) {
    return timeMillis - timeMillis % windowLengthInMs;
}
```

举例：sampleCount=10, intervalInMs=1000ms → windowLengthInMs=100ms

```
时间戳 1234ms
  timeId = 1234 / 100 = 12
  idx = 12 % 10 = 2         → array[2]
  windowStart = 1234 - 1234%100 = 1234 - 34 = 1200ms

时间戳 1300ms
  timeId = 13, idx = 3       → array[3]
  windowStart = 1300ms

时间戳 2200ms（轮转一圈回来）
  timeId = 22, idx = 2       → array[2]  (复用桶2)
  windowStart = 2200ms
```

#### 1.3 桶的过期与复用

`currentWindow()` 定位到 `array[idx]` 后，三种情况：

```java
public WindowWrap<T> currentWindow(long timeMillis) {
    int idx = calculateTimeIdx(timeMillis);
    long windowStart = calculateWindowStart(timeMillis);

    while (true) {
        WindowWrap<T> old = array.get(idx);
        if (old == null) {
            // 情况1：首次使用，创建新桶
            WindowWrap<T> wrap = new WindowWrap<>(windowStart, newEmptyBucket());
            if (array.compareAndSet(idx, null, wrap)) {
                return wrap;
            } else {
                Thread.yield();  // CAS 失败，重试
            }
        } else if (windowStart == old.windowStart()) {
            // 情况2：当前时间正好落在这个桶的时间范围内，直接复用
            return old;
        } else if (windowStart > old.windowStart()) {
            // 情况3：老桶已过期，覆盖更新（resetBucketTo 写入新值）
            if (updateLock.tryLock()) {
                try {
                    return resetWindowTo(old, windowStart);  // 复用对象，重置 windowStart 和统计值
                } finally {
                    updateLock.unlock();
                }
            } else {
                Thread.yield();
            }
        } else if (windowStart < old.windowStart()) {
            // 情况4：时钟回拨，返回已过期桶（不写入）
            return old;
        }
    }
}
```

#### 1.4 为什么是定长数组而不是 Queue/Map

| 方案 | 优点 | 缺点 | 为什么不选 |
| --- | --- | --- | --- |
| **Queue（链表）** | 桶过期自然出队 | 每次 GC 压力大、节点对象分散缓存不友好 | 性能差 |
| **ConcurrentHashMap** | 查找快 | 桶过期需主动清理、内存不可控 | 内存碎片 |
| **定长数组（LeapArray）** | O(1) 索引、内存预分配、缓存行友好 | 桶数固定 | **选定** |

**架构师视角**：
1. **预分配内存**——避免 GC 抖动，对限流这种"每请求都走"的热点路径至关重要
2. **O(1) 时间复杂度**——`calculateTimeIdx` 一次除法一次取模，纳秒级
3. **缓存行友好**——数组连续内存，CPU 缓存命中率高
4. **无需清理**——桶通过 `windowStart` 比对自动复用，无 GC 负担

#### 1.5 桶数与精度的关系

Sentinel 默认 `sampleCount=2, intervalInMs=1000ms`：
- 桶长度 = 500ms
- 窗口覆盖最近 1s，但只有 2 个桶

**精度公式**：误差 = 桶长度 / 窗口总长 = 1/sampleCount

```
sampleCount=2   → 误差 50%（最大）
sampleCount=10  → 误差 10%
sampleCount=20  → 误差 5%
sampleCount=60  → 误差 1.6%（每秒60桶，约16ms精度）
```

**精度越高，内存越大**：每个桶内是 `MetricBucket` 对象，包含 pass/block/rt/success/exception 等多个 LongAdder。60 桶意味着每个资源占用 60×N×8 字节，对于热点参数限流（每个参数一份 LeapArray）内存爆炸。

**Sentinel 默认 sampleCount=2 的取舍**：
- 优点：内存极省，1 个资源 2 个桶即可
- 缺点：精度差（这就是"现象1：限流误差 10%"的根因之一）
- 适合：QPS 限流的快速判断（不需要精确到毫秒）
- 不适合：RT 突增检测（需要更细粒度）

---

### 2. 一个请求进入后，LeapArray 的写入路径

#### 2.1 写入路径全流程

```
请求进入
  ↓
NodeSelectorSlot       建立资源 → ClusterNode/DefaultNode 树
  ↓
ClusterBuilderSlot     构建 ClusterNode（按资源聚合）
  ↓
StatisticSlot          ← 关键：写入 LeapArray
  │
  ├─ 线程计数：curThreadNum.increment()
  ├─ 通过数：  rollCounterInCurrentBucket().pass() += 1
  ├─ RT 记录： rollCounterInCurrentBucket().rt() += rt
  └─ 异常：    rollCounterInCurrentBucket().exception() += 1
  ↓
FlowSlot               读取 LeapArray 判断限流
  ↓
DegradeSlot            读取 LeapArray 判断熔断
  ↓
ParamFlowSlot          热点参数限流（独立 LeapArray）
  ↓
SystemSlot             系统自适应限流（全局 LeapArray）
  ↓
业务调用
```

#### 2.2 currentWindow() 的四象限处理

回到 1.3 节源码，**四种情况**：

```
┌──────────────────────────────────────────────────┐
│  情况1：old == null                               │
│  → CAS 创建新桶，失败则 Thread.yield() 重试        │
├──────────────────────────────────────────────────┤
│  情况2：windowStart == old.windowStart             │
│  → 当前桶，直接复用                                │
├──────────────────────────────────────────────────┤
│  情况3：windowStart > old.windowStart              │
│  → 老桶过期，加锁重置（updateLock）                 │
├──────────────────────────────────────────────────┤
│  情况4：windowStart < old.windowStart              │
│  → 时钟回拨，返回老桶（不写入）                     │
└──────────────────────────────────────────────────┘
```

**关键并发设计**：
- 情况1 用 CAS（无锁）——首次创建桶的高频场景
- 情况3 用 ReentrantLock——桶过期重置是低频但需要原子重置 `windowStart + statistic`

#### 2.3 跨桶处理（时间跳过多个桶）

```
当前时间 t=2500ms, sampleCount=10, windowLength=100ms
  idx = (2500/100) % 10 = 5
  windowStart = 2500 - 2500%100 = 2500ms

如果 array[5] 上次 windowStart = 1000ms（1.5秒前）
  → windowStart(2500) > old.windowStart(1000)
  → 直接重置 array[5] 为 windowStart=2500ms，统计清零
  → 中间跳过的桶 array[6]~array[4] 不主动清理！
```

**架构师洞察**：LeapArray **不主动清理过期桶**——只有在下次该桶被定位到时才惰性重置。这意味着 `values()` 方法返回时要过滤过期桶：

```java
public List<T> values(long timeMillis) {
    int size = array.length();
    List<T> result = new ArrayList<>(size);
    for (int i = 0; i < size; i++) {
        WindowWrap<T> wrap = array.get(i);
        if (wrap == null || isWindowDeprecated(timeMillis, wrap)) {
            continue;  // 过滤过期桶
        }
        result.add(wrap.value());
    }
    return result;
}

private boolean isWindowDeprecated(long time, WindowWrap<T> wrap) {
    return time - wrap.windowStart() >= intervalInMs;  // 超出窗口范围
}
```

#### 2.4 时间回拨的处理

情况4：`windowStart < old.windowStart` → 直接返回老桶，**不写入新数据**。

**架构师评价**：
- **保守策略**：宁可漏统计也不污染老桶数据
- **副作用**：时钟回拨期间所有请求的指标都丢失
- **改进方向**：业务里可以加监控，发现回拨告警

---

### 3. 限流 / 熔断 / 热点参数 / 自适应 如何复用同一套 LeapArray

#### 3.1 StatisticSlot 写入哪些指标

每个 `WindowWrap<MetricBucket>` 中的 `MetricBucket`：

```java
public class MetricBucket {
    private final LongAdder pass;           // 通过数
    private final LongAdder block;          // 拒绝数
    private final LongAdder exception;      // 异常数
    private final LongAdder success;        // 成功数
    private final LongAdder rt;             // 总响应时间
    private final LongAdder occupiedPass;   // 占用通过（异步资源）
    private long minRt;                     // 最小 RT
}
```

**关键设计**：用 `LongAdder` 而非 `AtomicLong`——高并发下分段累加避免热点。

#### 3.2 FlowSlot 读取什么、计算什么

```java
// 限流判断核心
public boolean canPassCheck(FlowRule rule, ...) {
    long pass = node.passQps();          // 当前窗口通过的 QPS
    long previousPass = node.previousPassQps();  // 上一个窗口的 QPS
    
    // 平滑计算：当前窗口 + 上一个窗口按时间占比加权
    long estimatedQps = pass + previousPass * (1 - currentBucketProgress);
    
    return estimatedQps + acquireCount <= rule.count;
}
```

**关键巧思**：用"上一个窗口 QPS × 当前桶剩余时间占比"做预测，避免突发请求在窗口切换瞬间通过 2x 流量（与 Day01 临界突发对应）。

#### 3.3 DegradeSlot 如何用 RT/异常指标触发熔断

```java
// 慢调用比例熔断
public boolean checkSlowRequestRatio(...) {
    // 1. 取最近 N 秒窗口内的 RT 统计
    slowRequestCount = node slowRequestCount(minRt * 3);
    totalCount = node.totalRequestInWindow();
    
    // 2. 计算慢调用比例
    ratio = slowRequestCount / totalCount;
    
    // 3. 与阈值比较，触发熔断
    if (ratio > rule.slowRatioThreshold && totalCount > rule.minRequestAmount) {
        transformToOpen();  // 切换到 OPEN 状态
    }
}
```

**状态机**（Day02 已详述）：CLOSED → OPEN → HALF_OPEN → CLOSED/OPEN

#### 3.4 ParamFlowSlot 为什么需要为每个热点参数维护独立 LeapArray

**痛点**：限流维度从"接口QPS"细化到"每个商品ID的QPS"，每个热点参数都需要独立的计数器。

```java
public class ParamFlowSlot {
    // 每个热点参数对应一个 LeapArray
    private final Map<ParamKey, LeapArray<ParamFlowBucket>> metricsMap;
}

public class ParamFlowBucket {
    long count;          // 该参数的通过数
    Map<Object, Long> topN;  // topN 排序（LRU LinkedHashMap）
}
```

**问题**：metricsMap 是 `ConcurrentHashMap`，热点参数下高并发写入同一 key 仍可能成为瓶颈。这也是现象3（扩容后命中率骤降）的根因之一。

#### 3.5 SystemSlot 全局自适应限流

SystemSlot 用一个**全局** LeapArray 监控：
- load1（CPU 负载）
- cpuUsage
- averageRt
- incomingQps
- concurrency

`SystemRuleManager` 每秒读取一次 LeapArray 判断是否触发系统级保护（Day04 自适应限流的底座）。

#### 3.6 一图总结：一套 LeapArray 支撑四种 Slot

```
                ┌──────────────────────┐
                │   StatisticSlot 写入 │
                │  (MetricBucket)      │
                └──────────┬───────────┘
                           │
                  ┌────────┴────────┐
                  ▼                 ▼
        ┌─────────────┐    ┌─────────────┐
        │  FlowSlot   │    │ DegradeSlot │
        │ (pass/block)│    │ (rt/exception)│
        └─────────────┘    └─────────────┘
                  ▲                 ▲
                  │                 │
        ┌─────────┴─────────────────┴──────┐
        │   LeapArray<MetricBucket>         │
        │   sampleCount=2, interval=1000ms  │
        └───────────────────────────────────┘

        ┌───────────────────────────────────┐
        │  ParamFlowSlot 独立               │
        │  Map<ParamKey, LeapArray>         │  ← 热点参数
        └───────────────────────────────────┘

        ┌───────────────────────────────────┐
        │  SystemSlot 全局                  │
        │  LeapArray<SystemMetric>          │  ← 自适应限流
        └───────────────────────────────────┘
```

---

### 4. 四个线上现象的根因与解决方案

#### 现象1：限流阈值 1000 QPS，压测 1200 QPS 实际通过 1100+，误差 10%

**根因**：Sentinel 默认 `sampleCount=2, intervalInMs=1000ms`，桶长度 500ms，**最大误差 50%**。

误差来源：
1. **桶切换瞬间的临界突发**（Day01 讲过）——压测 1200 QPS 集中在 0.4~0.6s 跨桶时，单桶可能记录 600 通过，跨桶累加 = 1100+
2. **平滑预测算法的偏差**——FlowSlot 用"上一窗口×剩余时间"预测，预测值与实际值偏差
3. **桶长度 500ms**——精度只到 500ms，瞬时流量被平均

**解决方案**：

```java
// 方案1：增加桶数（牺牲内存换精度）
FlowRule rule = new FlowRule();
rule.setResource("seckill");
rule.setCount(1000);
// 修改 LeapArray 配置（需要通过 SpiLoader 或自定义 StatisticSlot）
// 在 sentinel.properties 中：
// sliding.window.sample.count=20  // 桶数 20，精度 50ms
```

| 桶数 | 精度 | 内存（每资源） | 误差 |
| --- | --- | --- | --- |
| 2 (默认) | 500ms | ~64B | 50% |
| 10 | 100ms | ~320B | 10% |
| 20 | 50ms | ~640B | 5% |
| 60 | ~16ms | ~2KB | 1.6% |

**方案2：用严格滑动窗口（Sentinel 1.8+ 的 `StrictLeapArray`）**

```java
// 替代默认 LeapArray，桶过期时严格清理
public class StrictLeapArray<T> extends LeapArray<T> { ... }
```

**方案3：在网关层加粗限流**——把误差分散到多层。

**架构师选型**：
- 一般业务：sampleCount=2 默认即可（误差换内存值得）
- 强精度需求（秒杀下单）：sampleCount=10~20
- 极端精度（支付）：不用 Sentinel，用 Redis+Lua 精确计数

#### 现象2：RT 突增 5s，熔断延迟 2 秒才打开

**根因**：熔断判断依赖"最近 1s 窗口内的 RT 统计"，但 sampleCount=2 桶长度 500ms：
- t=0~1s：5s RT 请求进入，写入桶0
- t=1s：桶0 过期，桶1 开始记录
- t=1.5s：第一次熔断判断，看桶0（已过期，不统计）+ 桶1（仅 500ms 数据，样本不足）
- t=2s：桶1 满 1s 数据，熔断判断生效

**核心问题**：1s 窗口 + 桶长度 500ms = 最坏情况 1.5s 才能积累足够样本触发熔断。

**解决方案**：

**方案1：扩大统计窗口**

```java
// 熔断规则用更长窗口
DegradeRule rule = new DegradeRule();
rule.setResource("payment");
rule.setStatIntervalMs(5000);  // 5s 窗口
rule.setMinRequestAmount(20);
rule.setSlowRatioThreshold(0.5);
```

**方案2：缩短桶长度**

```java
// 熔断专用 LeapArray，桶长度更短
// 自定义 DegradeSlot 用 sampleCount=10
```

**方案3：用"慢调用绝对值"而非"慢调用比例"**

```java
rule.setMinRt(1000);  // RT>1s 视为慢调用
// 避免比例计算的样本积累延迟
```

**方案4：异常比例熔断 + 慢调用熔断双触发**——异常比例窗口可独立配置更短。

**架构师心法**：**熔断的延迟 = 窗口长度 × (1 - 1/sampleCount)**，把窗口和桶数算清楚才能保证 SLA。

#### 现象3：热点参数限流在机器扩容后命中率骤降

**根因**：扩容前 4 台机器，某商品 top1 流量集中在 1 台机器上，ParamFlowSlot 命中；扩容到 8 台后，同一商品流量被负载均衡打散到 2 台机器，单机 ParamFlow 阈值不变但单机流量减半，**单机限流值未相应调整**导致：
- 实际通过 = 单机QPS × 机器数（误以为全局阈值）
- 命中率从 90% 降到 50%

**根因深层**：ParamFlowSlot 是**单机热点参数限流**，无法感知全局。要做全局热点参数限流必须配合 Token Server。

**解决方案**：

**方案1：集群热点参数限流（Token Server）**

```java
ParamFlowRule rule = new ParamFlowRule("seckill")
    .setParamIdx(0)
    .setCount(1000)
    .setClusterMode(true)         // 开启集群模式
    .setClusterConfig(new ClusterFlowConfig()
        .setThresholdType(GLOBAL));  // 全局阈值
```

Token Server 维护热点参数的 LeapArray，所有客户端去 Server 申请令牌。

**方案2：本地预限流 + 集群精限流**

```
本地：每个参数阈值 = 全局阈值 / 机器数 × 0.8（80%本地拦截）
集群：剩余 20% 走 Token Server 精确判断
```

**方案3：动态调整本地阈值**——监听机器数变化，动态调整本地 ParamFlow 阈值（Nacos 推送）。

**架构师选型**：秒杀场景选**方案2**——本地预限流大幅降低 Token Server 压力，集群精限流保证全局准确。

#### 现象4：JStack 抓到 STAT_OCCUPY_FAILED 自旋，CPU 飙高

**根因**：`currentWindow()` 在情况3（桶过期重置）时用 `updateLock.tryLock()`，失败则 `Thread.yield()` 自旋。高并发下：
- 大量请求同时检测到桶过期
- 竞争 `updateLock`，仅一个线程拿到锁
- 其他线程 `yield` 后立即重试，CPU 飙高

**触发场景**：
1. 桶切换瞬间（每 500ms 一次）大量请求堆积
2. 时钟回拨（情况4 误入情况3 的边缘情况）
3. `array` 容量不足（热点参数 metricsMap 扩容）

**解决方案**：

**方案1：自旋加退避**

```java
// Sentinel 1.8+ 已优化：增加 waitTime
if (updateLock.tryLock(10, TimeUnit.MILLISECONDS)) { ... }
else {
    // 短暂 sleep 而非 yield
    LockSupport.parkNanos(1000);
}
```

**方案2：分段锁（Striped Lock）**——按 idx 分段，减少锁竞争。

**方案3：无锁化设计（RingBuffer 替代）**
- 用 Disruptor 的 RingBuffer 思路
- 每个桶一个独立的 AtomicReference
- 写入时只 CAS 自己的桶，无锁竞争

**方案4：增大桶长度**——减少桶切换频率，从根上降低竞争概率。

**架构师洞察**：LeapArray 的并发设计在 1w QPS 以下没问题，但 10w+ QPS 场景下 `updateLock` 成为瓶颈。这也是为什么超大规模业务（如阿里双11）会自研限流框架而非直接用 Sentinel。

---

## 五、架构师视角的总结

### 5.1 LeapArray 的设计精髓

```text
1. 定长数组 + 时间轮转：O(1) 索引，内存预分配
2. 惰性清理：不主动扫，定位到才重置
3. CAS + Lock 分级：高频用 CAS，低频用锁
4. LongAdder 分段累加：避免热点
5. 一套数据结构四种 Slot 复用：通用性 + 内存省
```

### 5.2 LeapArray 的局限

```text
1. 精度受 sampleCount 限制——内存与精度的天然矛盾
2. updateLock 在 10w+ QPS 成为瓶颈
3. 时钟回拨处理保守——回拨期间丢统计
4. 热点参数 metricsMap 在大量参数下内存爆炸
5. 跨进程统计需配合 Token Server——本身是单机数据结构
```

### 5.3 架构师选型决策树

```
QPS < 1w + 单机业务
  → Sentinel LeapArray 默认配置

QPS 1w~10w + 需要精度
  → Sentinel + sampleCount=10~20
  + 本地预限流 + Token Server 集群限流

QPS > 10w + 强精度
  → 自研限流框架（RingBuffer + 无锁化）
  或 Resilience4j + 自定义滑动窗口

支付/金融场景
  → Redis + Lua 精确计数（牺牲性能换精度）
  + 多层兜底
```

### 5.4 与本周内容的串联

```text
Day1 限流算法 → LeapArray 是滑动窗口的工程实现
Day2 熔断器   → DegradeSlot 复用 LeapArray 的 RT/异常统计
Day3 集群限流 → Token Server 是 LeapArray 的跨进程延伸
Day4 自适应   → SystemSlot 用全局 LeapArray 监控系统指标
Day5 实战综合 → 多级防护体系的底层数据结构就是 LeapArray
Day7 深挖     → 把前 5 天的"是什么"推进到"底层怎么实现"
```

---

## 六、与架构师水平的差距及补足方向

### 差距

1. **LeapArray 源码细节不熟**——业务里用 Sentinel 都是配置规则，没真正读过 `LeapArray.java`、`WindowWrap.java`、`MetricBucket.java` 的实现细节，对 CAS+Lock 的分级策略、`isWindowDeprecated` 的过滤逻辑没形成肌肉记忆

2. **精度与内存的量化取舍不扎实**——知道"桶越多越精确"，但没在自己业务中压测过 sampleCount=2/10/20/60 各自的内存占用、CPU 开销、实际误差曲线

3. **高并发下 `updateLock` 瓶颈的实战经验缺失**——业务里没遇到过 STAT_OCCUPY_FAILED 自旋问题，对 Sentinel 在 10w+ QPS 下的瓶颈点没第一手数据

4. **热点参数限流的内存爆炸问题考虑不深**——ParamFlowSlot 的 `Map<ParamKey, LeapArray>` 在百万级参数下会内存爆炸，业务里没设计过 LRU 淘汰策略

5. **集群限流与 LeapArray 的协同理解不透**——Token Server 内部用的也是 LeapArray，但客户端如何申请、Server 如何分配令牌的协议细节不熟

6. **Sentinel 的替代方案对比不全面**——对 Resilience4j 的 RingBitSet、Hystrix 的 BucketedCounterStream、自研 Disruptor 方案的对比维度不清晰

### 补足方向

1. **精读 Sentinel 1.8 源码**：`LeapArray`、`StatisticSlot`、`FlowSlot`、`DegradeSlot`、`ParamFlowSlot`、`ClusterFlowChecker` 六个核心类，整理源码笔记
2. **压测对比**：在秒杀系统中压测 sampleCount=2/10/20/60 各配置下的 QPS、内存、CPU、误差，形成"sampleCount 调优表"
3. **实现一个无锁化滑动窗口**：参考 Disruptor RingBuffer，用 `AtomicReference<WindowWrap>` 数组替代 `updateLock`，对比 Sentinel 的性能
4. **设计热点参数 LRU 淘汰策略**：ParamFlowSlot 的 metricsMap 增加 LRU 上限（如 top1000），避免内存爆炸
5. **整理"限流框架选型决策表"**：Sentinel / Resilience4j / Hystrix / 自研，按 QPS、精度、内存、生态四维度对比
6. **演练集群限流 Token Server 部署**：搭建 Token Server 集群，验证 10w QPS 下的稳定性与故障切换

---

## 七、明日预告

本周（限流降级熔断与高可用架构）已收尾，下周将开启新主题：**分布式ID生成与全局唯一性保障**——从 Snowflake 时钟回拨、Leaf-Segment/Leaf-Snowflake 源码、订单号设计、多机房部署等维度，深挖高并发系统的基础设施。