# Day 4：消息重试·死信队列·积压实战 — 练习整理

## 题目一：消息重试机制与死信队列 — 秒杀订单消费失败怎么办？

### 场景映射

| 你的业务 | 重试/死信场景 |
|---------|-------------|
| 秒杀系统 | 扣库存消息消费失败 → 重试 → 仍失败 → 进死信队列人工处理 |
| 蛋壳钱包 | 转账消息消费失败 → 不能无限重试（金额敏感）→ 进死信队列 |
| 保险商城 | 投保消息下游服务不可用 → 重试恢复后自动消费 |
| IM客服 | 消息推送失败 → 重试3次 → 降级为离线消息 |

### 你先答：消费者处理失败后，消息会怎样？

> 停下来想30秒再往下看。

---

### RocketMQ 重试机制

**集群消费模式下的重试**：

```
消费者返回 RECONSUME_LATER
  → Broker将消息存入重试Topic：%RETRY% + ConsumerGroup
  → 延迟一定时间后重新投递
  → 默认重试16次，间隔递增：

  第1次: 10s    第2次: 30s    第3次: 1min
  第4次: 2min   第5次: 3min   第6次: 4min
  第7次: 5min   第8次: 6min   第9次: 7min
  第10次: 8min  第11次: 9min  第12次: 10min
  第13次: 20min 第14次: 30min 第15次: 1h
  第16次: 2h

  16次全部失败 → 进入死信队列（DLQ）
```

**关键数字**：

| 项目 | 值 |
|------|-----|
| 默认重试次数 | 16次 |
| 重试Topic命名 | %RETRY% + ConsumerGroup |
| 死信Topic命名 | %DLQ% + ConsumerGroup |
| 第1次重试间隔 | 10秒 |
| 全部重试耗时 | 约4小时47分钟 |

### 死信队列（DLQ）

```
消息16次重试全部失败 → 进入死信队列 %DLQ%ConsumerGroup

死信队列的特点：
  1. 不再自动重试，需要人工介入
  2. 死信队列本质是一个特殊Topic，可以订阅消费
  3. 默认保留3天，超时删除

处理方式：
  方案1：订阅死信Topic，自动告警 + 转人工
  方案2：定时任务扫描死信队列，自动补偿或告警
  方案3：管理后台手动重发
```

```java
// 订阅死信队列
consumer.subscribe("%DLQ%OrderConsumerGroup", "*");

// 手动重发死信消息到原Topic
DefaultMQProducer producer = new DefaultMQProducer("DLQ_HANDLER_GROUP");
producer.start();
// 从死信队列拉取消息 → 修复数据 → 重新发送到原Topic
```

### 架构师关注：重试策略不是"默认就行"

```
1. 重试次数要根据业务调整
   - 金额相关（钱包）：重试3-5次就进死信，不能拖太久
   - 通知类（IM推送）：可以重试更多次
   - 日志类：不需要重试，丢弃即可

2. 重试间隔要考虑下游恢复时间
   - 下游DB宕机恢复需要5分钟 → 前3次重试(10s/30s/1min)全浪费
   - 调整：前几次间隔拉长，或者先探活再重试

3. 重试必须幂等
   - 第1次消费成功但返回RECONSUME_LATER（网络超时）
   - 第2次重试 → 重复消费 → 必须幂等兜底

4. 死信队列必须有监控
   - 死信队列有消息 = 有业务异常
   - 告警级别：P0（金额相关）或P1（一般业务）
```

### Kafka 的重试机制对比

```
Kafka没有内置重试和死信队列！

Consumer处理失败：
  方案1：提交offset跳过 → 消息丢失（不推荐）
  方案2：不提交offset → 阻塞后续消息（顺序消费时）
  方案3：发到重试Topic → 自定义重试逻辑（生产推荐）

Kafka重试Topic方案：
  主Topic → 消费失败 → 发到 retry-topic-1（延迟1s）
  retry-topic-1 → 失败 → 发到 retry-topic-2（延迟5s）
  retry-topic-2 → 失败 → 发到 dead-letter-topic

Spring Kafka 封装了这套逻辑：
  spring.kafka.consumer.properties.auto.offset.reset=earliest
  spring.kafka.listener.ack-mode=manual
```

### 分层防御：重试的完整兜底链

```
L1：业务重试（消费端自己决定重试策略）
  ↓ 失败
L2：MQ重试（RocketMQ 16次递增重试 / Kafka自定义重试Topic）
  ↓ 失败
L3：死信队列（自动告警 + 人工介入）
  ↓ 超时未处理
L4：对账补偿（定时Job对账，发现缺失数据主动修复）
  ↓ 仍无法修复
L5：人工介入（运维/DBA手动修复数据）
```

> 反向论证：为什么不能无限重试？①下游如果永久不可用（如代码bug），无限重试只会占满存储和CPU ②重试队列的消息会占用Broker资源 ③金额场景重试间隔长=资金冻结时间长，业务不可接受。

---

## 题目二：线上消息积压了怎么办？ — 从应急到根治

### 场景映射

| 你的业务 | 积压场景 |
|---------|---------|
| 秒杀系统 | 活动开始瞬间10万TPS写入，消费端只2万TPS → 8万积压/秒 |
| 保险商城 | 投保确认消息消费端DB慢查询 → 消费速度骤降 |
| IM客服 | 长假后积压大量离线消息，上班后需要快速消化 |
| 蛋壳钱包 | 下游支付通道限流 → 转账消息积压 |

### 你先答：线上监控到消息积压了，你的处理步骤是什么？

> 停下来想1分钟再往下看。

---

### 应急三板斧（5分钟内必须动手）

```
第1步：确认积压原因（1分钟）
  - 消费端有问题？（GC频繁、DB慢查询、下游超时）
  - 生产端突增？（营销活动、批量任务）
  - Rebalance风暴？（Consumer频繁上下线）

第2步：止血（2分钟）
  - 消费端问题：快速定位 → 重启/回滚有问题的Consumer
  - 生产端突增：通知业务方降速/限流
  - Rebalance：暂停扩缩容，检查心跳配置

第3步：加速消费（2分钟）
  - 如果消费端正常只是量太大 → 扩容Consumer
  - 注意：Queue数量是并行度上限！4个Queue扩8个Consumer没用
  - 需要同时扩Queue：动态扩Queue + 扩Consumer
```

### 消化积压的架构方案

**方案1：扩容Consumer（最简单）**

```
前提：Queue数量 > 当前Consumer数量
操作：增加Consumer实例
效果：线性提升消费能力

秒杀场景：
  16个Queue，4个Consumer，每个消费4个Queue
  扩到16个Consumer，每个消费1个Queue → 4倍消费能力
  但要注意Rebalance短暂暂停
```

**方案2：临时转发到新Topic（Queue不够时）**

```
问题：4个Queue已经4个Consumer，扩不了了
解决：
  1. 新建临时Topic，16个Queue
  2. 写一个转发Consumer，从原Topic消费 → 发到临时Topic
  3. 16个新Consumer消费临时Topic → 4倍消费能力
  4. 积压消化后，切回原Topic

原理：临时Topic的Queue数 = 临时并行度上限
```

```
原Topic(4 Queue) → 转发Consumer → 临时Topic(16 Queue) → 16个Consumer
                                                              ↓
                                                         消费完成
                                                              ↓
                                                    切回原Topic正常消费
```

**方案3：批量消费（提升单Consumer吞吐）**

```
将逐条处理改为批量处理：
  原来：一条消息一次DB操作
  优化：攒100条消息，一次批量insert

RocketMQ：
  consumer.registerMessageListener(new MessageListenerConcurrently() {
      public ConsumeConcurrentlyStatus consumeMessage(
              List<MessageExt> msgs, ConsumeConcurrentlyContext context) {
          // msgs就是一批消息，默认最多32条
          batchProcess(msgs);
          return Consume_CONSUME_SUCCESS;
      }
  });

注意：批量消费时部分失败的处理 → 整批重试 or 标记失败条目
```

**方案4：跳过非核心消息（降级消费）**

```
积压的消息中，区分优先级：
  P0：金额相关（支付、转账）→ 必须消费，不能丢
  P1：核心业务（下单、库存）→ 必须消费
  P2：通知类（短信、推送）→ 可以跳过，后续补发
  P3：日志类 → 直接丢弃

实现：
  1. 消息Tag区分类型
  2. 积压时Consumer只订阅P0/P1的Tag
  3. P2/P3跳过或转存，等积压消化后再处理

秒杀场景：
  积压100万条 → 80万是推送通知 → 跳过 → 只消费20万核心消息
```

### 积压后的副作用处理

```
副作用1：消息过期
  RocketMQ默认保留72小时 → 积压超过72小时的被删除
  处理：调整保留时间 / 紧急扩容前先确认不会丢消息

副作用2：消费端超时
  积压的消息消费时可能已经"过期"（如15分钟超时取消的订单还在积压）
  处理：消费时先检查消息是否还有效，无效直接跳过

副作用3：数据库压力
  加速消费 → DB写入暴增 → DB扛不住
  处理：批量写入 + 限流 + 读写分离

副作用4：Rebalance
  扩容Consumer → Rebalance → 短暂暂停 → 积压更多
  处理：提前扩容，不要在高峰期扩
```

### 关键数字

| 指标 | 值 |
|------|-----|
| RocketMQ默认消息保留时间 | 72小时 |
| 单Consumer消费速率参考 | 1-2万TPS（简单业务） |
| 单Consumer消费速率参考 | 1000-3000TPS（涉及DB操作） |
| 积压告警阈值建议 | 积压量 > 10分钟消费能力 |
| 扩容生效时间 | Rebalance完成后，约30秒 |

### 架构师思维：积压不是突发事件，是系统设计问题

```
面试官问"积压怎么办"，不是要你背应急步骤，而是看你有没有从设计层面防积压：

1. 容量规划：消费能力 >= 峰值生产能力的1.5倍
2. 监控预警：消费延迟 > N秒自动告警，别等积压了才发现
3. 降级预案：提前设计好消息分级和跳过策略
4. 压测验证：上线前压测消费端极限，知道天花板在哪
5. 弹性能力：Consumer能快速扩容（K8s HPA / 自动扩缩容）
```

---

## 题目三：消息回溯 — 消费出错了怎么重来？

### 场景映射

| 你的业务 | 回溯场景 |
|---------|---------|
| 秒杀系统 | 新上线扣库存代码有bug，消费了10分钟才发现 → 需要从bug上线前重新消费 |
| 保险商城 | 投保数据统计发现最近1小时数据异常 → 需要重新消费确认 |
| 蛋壳钱包 | 消费端代码逻辑错误，处理了一批错误数据 → 需要回溯重消费 |
| IM客服 | 消息推送服务升级后丢了部分消息 → 需要补推 |

### 什么是消息回溯？

```
消息回溯 = 将Consumer的消费进度（offset）回退到某个历史时间点
  → 重新消费该时间点之后的所有消息

与重试的区别：
  重试：单条消息消费失败，自动重试
  回溯：批量消息需要重新消费，手动设置offset
```

### RocketMQ 消息回溯

```
方式1：按时间戳回溯（最常用）
  consumer.setConsumeTimestamp("20260521103000"); // 回溯到2026-05-21 10:30:00
  consumer.start();

  原理：Broker根据时间戳找到对应的ConsumeQueue位置 → 从该位置开始消费

方式2：按Offset回溯（精确控制）
  consumer.seekToOffset(queue, offset); // 精确到某个Queue的某个Offset

方式3：从最早开始消费
  consumer.setConsumeFromWhere(ConsumeFromWhere.CONSUME_FROM_FIRST_OFFSET);

方式4：管理台操作
  RocketMQ Dashboard → Consumer → 重置消费进度
  选择时间点或Offset → 确认 → 所有Consumer重新消费
```

### Kafka 消息回溯

```
方式1：按时间戳回溯
  Map<TopicPartition, Long> timestampsToSearch = new HashMap<>();
  timestampsToSearch.put(new TopicPartition("topic", 0), timestamp);
  Map<TopicPartition, OffsetAndTimestamp> offsets = consumer.offsetsForTimes(timestampsToSearch);
  consumer.seek(partition, offsetAndTimestamp.offset());

方式2：按Offset回溯
  consumer.seek(partition, targetOffset);

方式3：从头消费
  consumer.seekToBeginning(partitions);

方式4：从最新开始
  consumer.seekToEnd(partitions);

方式5：按消费者组重置
  kafka-consumer-groups.sh --reset-offsets --group myGroup
    --topic myTopic --to-datetime 2026-05-21T10:30:00 --execute
```

### 回溯的坑

```
坑1：回溯会重复消费
  回溯到10:30 → 10:30~10:35的消息消费过了 → 回溯后重新消费
  必须：幂等！幂等！幂等！

坑2：回溯期间新消息也在产生
  回溯到10:30消费，但现在是11:00
  → 回溯消费期间，新消息也在不断产生
  → Consumer要同时处理回溯消息和新消息
  → 消费速度跟不上又积压

  解决方案：临时Consumer专门处理回溯，原Consumer继续消费新消息

坑3：回溯范围过大
  回溯到3天前 → 几百万条消息重新消费 → DB压力暴增

  解决方案：限流消费（控制消费速率），或分批回溯

坑4：广播模式的回溯
  集群消费：offset在Broker，重置一次生效
  广播消费：offset在每个Consumer本地 → 每个实例都要重置
```

### 回溯 vs 重试 vs 死信 vs 对账 — 什么时候用哪个？

```
消费单条失败 → 重试（自动）
批量消费逻辑错误 → 回溯（手动重置offset）
重试16次仍失败 → 死信队列（人工介入）
事后发现数据不一致 → 对账补偿（定时Job）
数据彻底丢失/损坏 → 备份恢复（DB binlog回放）
```

| 场景 | 方案 | 耗时 | 数据完整性 |
|------|------|------|-----------|
| 单条处理异常 | 自动重试 | 秒级 | 高（幂等保证） |
| 代码bug批量错误 | 消息回溯 | 分钟~小时 | 高（幂等+限流） |
| 重试耗尽 | 死信队列 | 小时级 | 中（需人工修复） |
| 静态数据不一致 | 对账补偿 | 小时级 | 高（全量比对） |

---

## 题目四：消费端线程模型与流控 — 怎么让消费"稳而不漏"？

### 场景映射

| 你的业务 | 线程/流控场景 |
|---------|-------------|
| 秒杀系统 | 瞬间海量下单消息，消费端线程池打满 → 需要流控 |
| 保险商城 | 投保确认消息涉及DB事务，消费线程不能太多 → 需要限流 |
| 蛋壳钱包 | 转账消息涉及金额，消费不能过快也不能过慢 → 精确控速 |
| IM客服 | 消息推送高峰，不能因为推送慢导致消费积压 → 异步化 |

### RocketMQ 消费端线程模型

```
Push模式（Long Polling）的线程模型：

1. Pull线程：不断从Broker拉取消息（Long Polling）
2. 消费线程池：处理拉取到的消息
3. 每个MessageQueue对应一个ProcessQueue（本地缓存）

关键配置：
  consumeThreadMin = 20    // 最小消费线程数
  consumeThreadMax = 64    // 最大消费线程数
  pullBatchSize = 32       // 每次拉取最多32条
  consumeMessageBatchMaxSize = 1  // 每次消费1条（可调大做批量消费）

线程分配：
  所有MessageQueue共享同一个消费线程池
  不是每个Queue一个线程！是所有Queue争抢线程池
```

```
                    Pull线程(Long Polling)
                         │
                         ▼
               ┌──────────────────┐
               │   ProcessQueue   │  ← 每个Queue一个本地缓存
               │  (本地消息队列)   │
               └──────────────────┘
                         │
                         ▼
               ┌──────────────────┐
               │   消费线程池      │  ← consumeThreadMin~Max
               │  (所有Queue共享)  │
               └──────────────────┘
                         │
                         ▼
               ┌──────────────────┐
               │   业务处理逻辑    │  ← 你的代码
               └──────────────────┘
```

### 消费端流控

**RocketMQ 内置流控**：

```
触发条件：
  1. ProcessQueue本地缓存 > pullThresholdForQueue（默认1000条）
  2. ProcessQueue本地缓存大小 > pullThresholdSizeForQueue（默认100MB）
  3. ProcessQueue中消息跨度 > consumeConcurrentlyMaxSpan（默认2000offset差）

触发后果：
  拉取请求被延迟 → 不再拉新消息 → 等本地消费完再拉

设计意图：
  消费端处理不过来 → 不要再拉更多消息堆积在本地内存
  本质上是背压（Backpressure）机制
```

**业务级流控（架构师要设计的）**：

```
1. 限流消费
   使用RateLimiter控制消费速率：
   RateLimiter rateLimiter = RateLimiter.create(5000); // 5000TPS
   if (!rateLimiter.tryAcquire()) {
       return RECONSUME_LATER; // 限流时返回重试
   }
   processMessage(msg);

   场景：钱包转账消费，下游支付通道限流5000TPS

2. 熔断消费
   下游服务不可用时，停止消费避免无效重试：
   if (circuitBreaker.isOpen()) {
       // 熔断状态，等待恢复
       Thread.sleep(5000);
       return RECONSUME_LATER;
   }

   场景：保险投保确认，核心服务宕机时暂停消费

3. 分级消费
   按消息优先级分配不同的消费速率：
   P0消息：不限速，全速消费
   P1消息：限速5000TPS
   P2消息：限速1000TPS
```

### 顺序消费的线程模型

```
普通消费（Concurrently）：
  多线程并发消费，不保证顺序
  20-64个线程争抢处理

顺序消费（Orderly）：
  同一个MessageQueue单线程消费
  同一个Queue的消息按顺序处理
  不同Queue可以并行

线程模型：
  Queue0 → 线程A（串行处理Queue0的所有消息）
  Queue1 → 线程B（串行处理Queue1的所有消息）
  Queue2 → 线程C（串行处理Queue2的所有消息）
  ...

关键区别：
  并发消费：消费失败 → 重试（不影响其他消息）
  顺序消费：消费失败 → 挂起当前Queue → 不断重试直到成功
    → 一条消息卡住 → 整个Queue的消费暂停
    → 容易积压！

架构师决策：
  需要顺序 → 接受单Queue串行的代价 → 多设Queue提升并行度
  不需要顺序 → 用并发消费 → 吞吐量高
```

### 消费端性能优化清单

| 优化点 | 方法 | 效果 |
|-------|------|------|
| 批量消费 | consumeMessageBatchMaxSize调大 | 减少DB交互次数 |
| 异步处理 | 消费端只接收，异步线程池处理 | 提升消费TPS |
| 线程池调优 | 根据下游能力调consumeThreadMax | 避免过载/欠载 |
| 本地缓存 | 热点数据本地缓存，减少DB查询 | 降低消费延迟 |
| 限流保护 | RateLimiter + 熔断 | 保护下游服务 |
| ProcessQueue | 调整pullThresholdForQueue | 平衡内存和吞吐 |

---

## 今日能力差距分析

| 差距 | 具体表现 | 补足方向 |
|------|---------|---------|
| **重试数字不熟** | 不知道RocketMQ默认16次重试、间隔递增 | 背一遍16次重试间隔表，重点记第1次10s、第16次2h、总耗时~4h47min |
| **死信队列处理空白** | 只知道"进死信"，不知道怎么消费死信队列 | 练习写一个订阅死信Topic的Consumer代码 |
| **积压应急没有章法** | 想到什么做什么，没有结构化步骤 | 记住三板斧：确认原因→止血→加速消费，每个步骤1-2分钟 |
| **回溯方案不完整** | 只知道"回退offset"，不知道回溯的坑 | 重点理解：回溯必重复消费→幂等兜底；广播模式每个实例都要重置 |
| **消费线程模型模糊** | 不知道consumeThreadMin/Max和ProcessQueue的关系 | 画一遍消费端线程模型图，理解背压机制 |

### 关键数字补充

| 数字 | 值 |
|------|-----|
| RocketMQ默认重试次数 | 16次 |
| 第1次重试间隔 | 10秒 |
| 全部16次重试总耗时 | 约4小时47分钟 |
| 死信队列默认保留时间 | 3天 |
| RocketMQ消息默认保留时间 | 72小时 |
| consumeThreadMin默认值 | 20 |
| consumeThreadMax默认值 | 64 |
| pullBatchSize默认值 | 32 |
| pullThresholdForQueue默认值 | 1000条 |
| consumeConcurrentlyMaxSpan默认值 | 2000 offset差 |

---

## 知识串联

| 已学主题 | 与重试/死信/积压/回溯/流控的关联 |
|---------|-------------------------------|
| 消息不丢（Day1） | 重试是消息不丢的保障之一；死信队列是重试的兜底 |
| 消息幂等（Day1） | 重试必然导致重复消费→幂等是重试的前提；回溯更必须幂等 |
| 消息顺序（Day1） | 顺序消费失败→整个Queue挂起→容易积压；积压时不能跳过消息 |
| 消息积压（Day1） | Day1讲概念，Day4讲实战应急方案；积压的根本原因是生产>消费 |
| MQ选型（Day2） | RocketMQ内置重试+死信；Kafka需自建→选型时考虑运维成本 |
| 事务消息（Day2） | 事务消息的回查本质是一种"重试"；事务消息失败也进重试→死信 |
| 延迟消息（Day3） | 秒杀超时取消 = 延迟消息+消费失败重试；延迟消息消费失败→重试→死信 |
| Rebalance（Day3） | Rebalance导致消费暂停→积压；积压扩容→Rebalance；注意循环 |
| 集群vs广播（Day3） | 重试只对集群消费有效！广播消费没有重试机制；回溯在广播模式需每个实例重置 |
| 分布式锁（第3周） | 消费端限流可以用分布式锁控制并发；熔断器的状态管理类似锁的租约 |
| 缓存架构（第3周） | 消费端本地缓存热点数据→减少DB查询→提升消费TPS；缓存失效→广播消费刷新 |

---

*日期：2026-05-21 | 第4周 Day4 | 主题：消息重试·死信队列·积压实战 | 练习整理*
