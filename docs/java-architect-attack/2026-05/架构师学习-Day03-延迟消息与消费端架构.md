# Day 3：延迟消息与消费端架构 — 练习整理

## 题目一：延迟消息怎么实现？秒杀倒计时与支付超时取消

### 场景映射

| 你的业务 | 延迟消息场景 |
|---------|------------|
| 秒杀系统 | 下单后15分钟未支付自动取消释放库存 |
| 保险商城 | 投保确认后24小时犹豫期提醒 |
| 蛋壳钱包 | 转账延迟到账、支付超时关单 |

### RocketMQ 延迟消息

**原生支持18个延迟级别**（不是任意时间！）：

| 级别 | 延迟时间 | 级别 | 延迟时间 |
|------|---------|------|---------|
| 1 | 1s | 10 | 6min |
| 2 | 5s | 11 | 7min |
| 3 | 10s | 12 | 8min |
| 4 | 30s | 13 | 9min |
| 5 | 1min | 14 | 10min |
| 6 | 2min | 15 | 20min |
| 7 | 3min | 16 | 30min |
| 8 | 4min | 17 | 1h |
| 9 | 5min | 18 | 2h |

```java
Message msg = new Message("OrderTopic", "TagA", "orderId", "订单内容".getBytes());
msg.setDelayTimeLevel(14); // 延迟10分钟
producer.send(msg);
```

**实现原理**：

```
1. Broker收到延迟消息 → 不直接投到目标Topic → 存入内部Topic SCHEDULE_TOPIC_XXXX
2. 按延迟级别分Queue，每个级别一个Queue
3. 定时线程（ScheduleMessageService）轮询各Queue
4. 到达延迟时间 → 从SCHEDULE_TOPIC取出 → 投到目标Topic
5. 消费者正常消费
```

### RocketMQ 5.x 任意延迟（面试加分项）

```
5.x之前：只能选18个固定级别，粒度不够细
5.x新增：支持任意时间延迟（秒级精度）

原理变化：
  旧版：按级别分Queue，定时线程轮询
  新版：时间轮算法（Timing Wheel），O(1)入轮，O(1)出轮

实际影响：
  秒杀场景需要精确15分钟 → 旧版只能选10min或20min级别 → 不精确
  5.x可以精确到15分0秒
```

### Kafka 为什么不支持延迟消息？

```
Kafka的设计哲学：流处理平台，追求吞吐和简单
延迟消息需要定时调度 → 与"顺序写、批量发送"的设计相矛盾
如果要做 → 需要自己实现：
  方案1：本地定时任务（简单但不精确，实例多了重复触发）
  方案2：延迟Topic + 时间窗口消费（复杂）
  方案3：Redis过期事件 + 发Kafka消息（常见方案）
```

### Redis 延迟队列方案（通用方案）

```
方案1：Keyspace Notification（键空间通知）
  SET order:1234 "content" EX 900  // 15分钟过期
  监听 __keyevent@0__:expired  → 收到过期事件 → 发MQ消息
  问题：过期事件可能丢失，不可靠！

方案2：ZSET + 定时轮询（更可靠）
  ZADD delay_queue <timestamp> <message>
  定时Job：ZRANGEBYSCORE delay_queue 0 <now> → 取出到期的消息 → 发MQ
  优势：可查、可重试、不会丢
  劣势：轮询频率影响精度，量大了ZSET性能下降

方案3：Redisson 延迟队列（生产级）
  RBlockingQueue + RDelayedQueue 封装
  内部就是ZSET实现，但封装了轮询和重试
  你用Redisson做过分布式锁 → 延迟队列API风格一致
```

### 架构师决策：不同场景选不同方案

| 场景 | 推荐方案 | 理由 |
|------|---------|------|
| 已经在用RocketMQ | RocketMQ延迟消息 | 零额外组件，运维简单 |
| 延迟级别不满足且不能升级5.x | Redis ZSET + 定时轮询 | 灵活精确，通用方案 |
| 已经在用Kafka | Redis ZSET + 投Kafka | Kafka不原生支持，Redis补位 |
| 海量延迟消息（百万级） | 时间轮 + DB持久化 | 内存放不下，需要持久化 |

> 反向论证：为什么不全用Redis延迟队列？因为Redis方案本质上是你自己实现了一套MQ的延迟功能，RocketMQ帮你做了这件事。能用原生功能就不要自研。

---

## 题目二：消费者 Rebalance 机制 — 秒杀扩缩容的关键

### 什么是 Rebalance？

```
消费者组内的消费者数量变化 → 重新分配Queue给消费者 → Rebalance

触发条件：
  1. 消费者上线（扩容）
  2. 消费者下线（宕机/缩容）
  3. 订阅的Topic/Queue变化

本质：Queue:Consumer 的重新映射
```

### RocketMQ Rebalance 流程

```
1. 每个Consumer启动时向Broker注册
2. Broker通知Consumer Group内所有Consumer → 触发Rebalance
3. 各Consumer从Broker获取Group内所有Consumer列表和Queue列表
4. 本地按分配策略分配Queue
5. 每个Consumer只消费分配给自己的Queue

分配策略：
  AllocateMessageQueueAveragely      — 均分（默认）
  AllocateMessageQueueAveragelyByCID — 按Consumer ID均分
  AllocateMessageQueueConsistentHash — 一致性Hash（减少迁移量）
```

**均分策略示例**：

```
4个Queue，3个Consumer：
  Consumer1 → Queue0, Queue1  （多分一个）
  Consumer2 → Queue2
  Consumer3 → Queue3

Consumer2下线 → Rebalance：
  Consumer1 → Queue0, Queue1
  Consumer3 → Queue2, Queue3  （接管Consumer2的Queue）
```

### Rebalance 的问题（面试重点）

**问题1：消费暂停**

```
Rebalance期间 → 所有Consumer暂停消费 → 等待重新分配完成
秒杀场景：高峰期Consumer宕机 → Rebalance → 所有消费者暂停几秒 → 积压暴增
```

**问题2：重复消费**

```
Consumer1正在处理Queue0的消息A
Rebalance → Queue0重新分配给Consumer2
Consumer1没处理完 → offset未提交 → Consumer2从头消费 → 消息A被重复消费

解决：消费幂等（Day1已学，幂等是Rebalance重复消费的兜底）
```

**问题3：Rebalance风暴**

```
一个Consumer频繁上下线（如心跳超时配置不合理）
→ 每次触发全组Rebalance
→ 所有Consumer反复暂停
→ 雪崩

根因：默认20秒心跳超时，如果GC或网络抖动超过20秒就会被踢出
```

### Kafka Rebalance 对比

| 维度 | RocketMQ | Kafka |
|------|----------|-------|
| 协调者 | 各Consumer本地计算 | Group Coordinator（Broker端） |
| 分配算法 | 均分/一致性Hash | Range/RoundRobin/Sticky |
| 避免抖动 | 无特殊机制 | Kafka 2.4+ Sticky分区（尽量保持原分配） |
| Cooperative模式 | 无 | Kafka 2.4+ 增量Rebalance（不用全部暂停） |

**Kafka Cooperative Rebalance（面试加分项）**：

```
旧版（Eager模式）：
  Rebalance → 所有Consumer放弃全部分区 → 重新分配 → 全部暂停

新版（Cooperative模式）：
  Rebalance → 只迁移需要变动的分区 → 其他分区不暂停
  例如：Consumer3下线 → 只把Consumer3的分区重新分配 → 其他Consumer不受影响
```

### 秒杀场景的 Rebalance 实战

```
秒杀开始前：4个Consumer预热
秒杀开始：扩到16个Consumer → Rebalance → Queue:Consumer重新分配
秒杀结束：缩回4个 → 再次Rebalance

架构师关注点：
  1. Queue数量决定最大并行度 → 4个Queue扩16个Consumer也没用（Day1已提）
  2. 扩缩容时机 → 提前扩，延后缩，避免高峰期Rebalance
  3. 幂等兜底 → Rebalance必然导致短暂重复消费
  4. 监控 → Rebalance频率是核心指标，频繁Rebalance = 有问题
```

---

## 题目三：Push vs Pull 消费模式

### 两种模式本质

| 维度 | Push | Pull |
|------|------|------|
| 主动方 | Broker推给Consumer | Consumer从Broker拉 |
| 实时性 | 高（消息来了就推） | 取决于拉取间隔 |
| Broker压力 | 高（维护推送连接） | 低（Consumer自己来取） |
| 流控 | Broker控制推送速率 | Consumer自己控制 |

### 面试陷阱：RocketMQ 的"Push"是伪Push

```
RocketMQ的Push模式 ≠ Broker主动推送
本质：Long Polling（长轮询）

Consumer发起Pull请求 → Broker没有消息 → 不立即返回 → 挂起连接
等有新消息或超时（默认15秒）→ 返回给Consumer
Consumer收到后立即发下一个Pull请求 → 看起来像Push

为什么这么设计？
  真Push：Broker要维护每个Consumer的推送状态，复杂度高
  Long Polling：Consumer主动拉取，Broker无状态，天然流控
  效果：既有了Push的实时性，又保留了Pull的简洁性
```

### Kafka 的 Pull 模式

```
Kafka只有Pull模式，没有"Push"概念

Consumer循环调用 poll()：
  while (true) {
      ConsumerRecords<String, String> records = consumer.poll(Duration.ofMillis(100));
      for (ConsumerRecord<String, String> record : records) {
          process(record);
      }
  }

poll参数：
  timeout太短 → 空轮询浪费CPU
  timeout太长 → 消息延迟高
  通常100-500ms

为什么Kafka坚持Pull？
  1. 批量拉取效率高（一次拉一批，批量处理）
  2. Consumer自己控制消费速率（Broker不用关心Consumer能扛多少）
  3. 适配流处理框架（Flink/Spark自己控制消费节奏）
```

### RabbitMQ 的 Push 模式

```
RabbitMQ是真正的Push：Broker主动推送消息给Consumer

@RabbitListener(queues = "orderQueue")
public void handleMessage(String message) {
    processOrder(message);
}

流控机制：prefetchCount
  channel.basicQos(prefetchCount=10)
  → Broker最多推10条未确认消息给Consumer
  → Consumer处理一条ACK一条 → Broker再推一条

问题：Consumer处理慢 → prefetchCount满了 → Broker停止推送 → 积压在Broker
```

### 三种模式对比

| 场景 | 推荐模式 | 理由 |
|------|---------|------|
| 业务消息（RocketMQ） | "Push"（Long Polling） | 实时性好，自动负载均衡 |
| 大数据流处理（Kafka） | Pull | 批量拉取高效，Consumer自己控制节奏 |
| 低延迟推送（RabbitMQ） | Push | 真正的实时推送，微秒级延迟 |
| 消费能力不均 | Pull | 慢的Consumer拉得慢，快的拉得快，自然均衡 |

---

## 题目四：消费模式 — 集群消费 vs 广播消费

### 两种消费模式

```
集群消费（CLUSTERING）— 默认模式：
  一个Queue的消息只被Group内一个Consumer消费
  Queue:Consumer = 1:1（同一个Group内）
  消费进度（offset）由Broker维护

广播消费（BROADCASTING）：
  一个Queue的消息被Group内所有Consumer各消费一次
  每个Consumer都收到全量消息
  消费进度由各Consumer自己维护
```

### 场景对比

| 场景 | 模式 | 理由 |
|------|------|------|
| 订单处理 | 集群消费 | 一条订单只处理一次 |
| 秒杀下单 | 集群消费 | 一条下单消息只消费一次 |
| 配置变更通知 | 广播消费 | 每个实例都要更新本地缓存 |
| 缓存刷新 | 广播消费 | 每个实例都要清本地缓存 |
| 日志采集 | 集群消费 | 一条日志只采集一次 |
| 用户行为通知（短信+积分+物流） | 集群消费 | 不同Group各消费一次 |

### 广播消费的坑

```
坑1：消费进度本地维护 → Consumer重启可能重复消费
  解决：消费幂等

坑2：每个Consumer都消费全量 → 扩容不提升消费能力
  集群消费：4个Consumer处理4万TPS，每台1万
  广播消费：4个Consumer处理1万TPS，每台都处理1万

坑3：Consumer宕机 → 消息没人消费（不是别人接管）
  集群消费：Consumer宕机 → Queue被其他Consumer接管
  广播消费：Consumer宕机 → 这个Consumer的消息就丢了（除非有持久化重启恢复）
```

### 秒杀系统的消费模式选择

```
下单消息 → 集群消费（一条消息只处理一次订单）
库存扣减结果 → 集群消费
缓存预热通知 → 广播消费（所有实例刷新本地缓存）
配置变更 → 广播消费
```

---

## 题目五：消息过滤 — Tag过滤与SQL过滤

### 为什么要过滤？

```
一个Topic下可能有多种消息：
  Topic: ORDER_TOPIC
  Tag: CREATE / PAY / SHIP / CANCEL

Consumer只想消费支付成功的消息 → 不用订阅全部再在代码里过滤
→ Broker端过滤，减少网络传输
```

### 两种过滤方式

**Tag 过滤（默认）**：

```java
// 生产者
Message msg = new Message("ORDER_TOPIC", "PAY", "orderId", "内容".getBytes());

// 消费者 — 订阅指定Tag
consumer.subscribe("ORDER_TOPIC", "PAY");           // 单Tag
consumer.subscribe("ORDER_TOPIC", "PAY || SHIP");   // 多Tag（|| 分隔）
consumer.subscribe("ORDER_TOPIC", "*");              // 全部
```

```
过滤流程：
  1. ConsumeQueue存储8字节CommitLog Offset + 4字节Message Size + 8字节TagsCode
  2. Consumer订阅时上报Tag的HashCode
  3. Broker在ConsumeQueue层面比对HashCode → 匹配才投递
  4. Consumer端再精确匹配Tag字符串（防HashCode冲突）

特点：高效，在索引层面就过滤，不读CommitLog
局限：Tag只能有一个，不能做复杂条件过滤
```

**SQL92 过滤**：

```java
// 生产者 — 设置属性
Message msg = new Message("ORDER_TOPIC", "PAY", "orderId", "内容".getBytes());
msg.putUserProperty("amount", "100");
msg.putUserProperty("region", "BJ");

// 消费者 — SQL表达式过滤
consumer.subscribe("ORDER_TOPIC",
    MessageSelector.bySql("amount > 50 AND region = 'BJ'"));
```

```
过滤流程：
  1. ConsumeQueue没有属性信息 → Broker需要读CommitLog获取属性
  2. Broker按SQL表达式过滤 → 匹配才投递
  3. 比Tag过滤多一次磁盘读取

特点：灵活，支持复杂条件
局限：
  - 需要读CommitLog → 性能低于Tag过滤
  - 需要开启enablePropertyFilter=true
  - 只支持SQL92子集（数字比较、字符串比较、IS NULL、BETWEEN、IN）
```

### Kafka 的过滤方式

```
Kafka没有Broker端过滤！
Consumer只能按Topic+Partition订阅，拉取全量消息
过滤在Consumer端代码里做

如果需要过滤：
  方案1：不同业务用不同Topic（推荐）
  方案2：Consumer端代码过滤（浪费带宽）
  方案3：Kafka Streams过滤（重）
```

### 过滤方式决策

| 场景 | 推荐方式 | 理由 |
|------|---------|------|
| 消息类型少且固定 | Tag过滤 | 性能最优，索引层过滤 |
| 需要按属性条件筛选 | SQL92过滤 | 灵活，适合复杂条件 |
| 用Kafka | 不同Topic | 没有Broker端过滤，Topic隔离最干净 |
| Tag太多（>10个） | 考虑拆Topic | Tag太多管理复杂，不如按业务拆Topic |

> 反向论证：为什么不把所有消息放一个Topic用Tag区分？因为Topic是物理隔离，Tag是逻辑隔离。消息量差异大时，小业务消息被大业务消息淹没；运维时无法独立对某个Tag做监控和限流。

---

## 今日能力差距分析

| 差距 | 具体表现 | 补足方向 |
|------|---------|---------|
| **延迟消息原理不熟** | 只知道"有延迟级别"，说不清内部Topic转换和时间轮机制 | 画一遍延迟消息的完整流转图：生产→SCHEDULE_TOPIC→定时线程→目标Topic→消费 |
| **Rebalance影响低估** | 知道会重分配，但没意识到会暂停消费和重复消费 | 理解Rebalance的三个问题（暂停/重复/风暴），面试时主动提幂等兜底 |
| **Push/Pull概念混淆** | 以为RocketMQ Push是真Push | 记住：RocketMQ Push = Long Polling，面试时说清楚本质 |
| **过滤方案选择模糊** | 只知道Tag过滤，不知道SQL92和Kafka的局限 | 对比三种MQ的过滤能力差异，面试时展现对比思维 |

### 关键数字补充

| 数字 | 值 |
|------|-----|
| RocketMQ延迟级别数 | 18个（1s~2h） |
| RocketMQ Push长轮询超时 | 15秒 |
| Kafka默认poll超时 | 通常100-500ms |
| RabbitMQ默认prefetchCount | 1（建议调到10-50） |
| RocketMQ心跳超时 | 20秒（Broker端） |
| Rebalance触发感知延迟 | 最多30秒（心跳周期） |

---

## 知识串联

| 已学主题 | 与延迟消息/消费端架构的关联 |
|---------|-------------------------|
| 消息不丢（Day1） | Rebalance重复消费 → 幂等兜底，延迟消息过期未消费 → 死信队列 |
| 消息顺序（Day1） | Rebalance后Queue重新分配 → 顺序消费的分区可能变化 |
| 消息积压（Day1） | Rebalance暂停消费 → 积压加剧；扩容Consumer触发Rebalance → 短暂暂停后加速 |
| MQ选型（Day2） | 延迟消息选RocketMQ；Kafka不支持延迟消息需额外方案 |
| 事务消息（Day2） | 延迟消息+事务消息组合：半消息Commit后延迟投递 |
| Raft协议（第3周） | Kafka KRaft用Raft选Controller → Controller管理Rebalance |
| 分布式锁（第3周） | Rebalance本质上是在做"谁消费哪个Queue"的协调，类似分布式锁的租约机制 |
| 缓存架构（第3周） | 广播消费刷新本地缓存 → 缓存一致性的一种实现方式 |

---

*日期：2026-05-20 | 第4周 Day3 | 主题：延迟消息与消费端架构 | 整理版*
