# Day 2：MQ选型与高可用 — 练习整理

## 题目一：Kafka、RocketMQ、RabbitMQ 核心差异

### 一句话定位

- **Kafka**：分布式流处理平台，吞吐量优先
- **RocketMQ**：分布式消息中间件，业务功能完整性优先
- **RabbitMQ**：传统消息代理，路由灵活性和低延迟优先

### 存储模型差异（面试重点）

```
Kafka：分区模型
  Topic → 多个Partition → 每个Partition一个独立文件
  顺序写磁盘 → 极致吞吐
  但Topic多了 → Partition文件多 → OS页缓存争抢 → 退化为随机写！

RocketMQ：CommitLog + ConsumeQueue
  所有Topic共享一个CommitLog → 永远顺序写 → 不怕Topic多
  ConsumeQueue是逻辑索引 → 随机读但数据量小
  一份物理存储，多份逻辑索引 → 天然支持回溯、延迟、事务

RabbitMQ：Exchange-Queue路由模型
  灵活的路由（direct/fanout/topic）
  单队列无分区概念 → 并行度受限 → 吞吐量上不去
```

### 核心对比

| 维度 | Kafka | RocketMQ | RabbitMQ |
|------|-------|----------|----------|
| **开发语言** | Scala + Java | Java | Erlang |
| **单机TPS** | 10万+ | 6-10万 | 万级 |
| **延迟** | 毫秒级 | 毫秒级 | 微秒级 |
| **消息可靠性** | 较高（副本+刷盘） | 高（同步刷盘+同步双写） | 高（镜像队列） |
| **消息顺序** | 分区有序 | 分区有序 | 单队列有序 |
| **事务消息** | 流处理Exactly Once | 业务事务（半消息+回查） | 不支持 |
| **延迟消息** | 不支持 | 原生支持（18个级别） | 插件支持 |
| **消息回溯** | 支持按offset/time | 支持按time | 不支持 |
| **死信队列** | 不支持 | 原生支持 | 支持 |
| **路由模型** | 简单（Topic+Partition） | 简单（Topic+Queue） | 灵活（Exchange路由） |
| **消息确认** | 简单（offset提交） | 完善（手动ACK+重试+死信） | 最完善（ACK/NACK/Reject） |
| **社区生态** | 极强（大数据生态） | 强（阿里生态） | 成熟（欧洲企业级） |

### Kafka为什么吞吐量最高

```
1. 顺序写磁盘：追加写，磁盘顺序写速度接近内存
2. 零拷贝：sendfile系统调用，数据直接从页缓存到网卡，不经用户态
3. 批量发送：Producer端批量攒消息，一次网络请求发送一批
4. 页缓存：利用OS Page Cache，不自己管理缓存
5. 分区并行：多分区并行读写，横向扩展
```

---

## 题目二：MQ选型决策

### 选型决策树

```
业务核心需求是什么？
│
├── 大数据/日志/流处理（吞吐量优先）
│   └── → Kafka
│       优势：10万+TPS，与Flink/Spark生态天然整合，消息回溯支持重放
│       代价：没有延迟消息、没有死信队列、topic多了性能退化
│
├── 业务消息/事务/延迟（功能完整性优先）
│   └── → RocketMQ
│       优势：事务消息、延迟消息、死信队列+回查、消息回溯、同步刷盘+同步双写
│       代价：大数据生态不如Kafka，与Flink/Spark整合弱
│       注意：选RocketMQ不只是因为"事务消息"一个特性，是整套业务能力
│
├── 企业集成/复杂路由（灵活性优先）
│   └── → RabbitMQ
│       优势：Exchange路由模型灵活、消息确认机制完善、管理界面友好
│       代价：万级TPS扛不住高并发，不支持消息回溯
│
└── 多场景混合
    └── 分场景选型（不建议一刀切）
        - 日志链路 → Kafka
        - 业务链路 → RocketMQ
        - 内部集成 → RabbitMQ
```

### 选型的反向论证（架构师加分项）

| 方案 | 不适合的场景 | 原因 |
|------|------------|------|
| Kafka | 需要延迟消息、事务消息的业务 | 不原生支持，需自研或定时任务变通 |
| Kafka | 消息量小的内部系统 | 杀鸡用牛刀，运维复杂度高 |
| Kafka | Topic特别多的业务 | Partition文件争抢页缓存，退化为随机写 |
| RocketMQ | 大数据流处理场景 | 生态不如Kafka，与Flink/Spark整合弱 |
| RabbitMQ | 高吞吐削峰场景 | 万级TPS扛不住秒杀峰值 |
| RabbitMQ | 需要消息回溯的场景 | 不支持按时间回溯消费 |

### 蛋壳钱包如果从RocketMQ换成Kafka会怎样

```
没有事务消息 → 扣余额和发消息不是原子的 → 需要自己实现本地事务表+补偿
没有延迟消息 → 订单超时取消需要额外定时任务
没有死信队列 → 消费失败的重试和兜底要自己实现
结论：能做，但每个都要自研，RocketMQ帮你省了这些工作量
```

### 你的业务映射

| 你的系统 | 推荐MQ | 理由 |
|---------|--------|------|
| 蛋壳钱包 | RocketMQ | 事务消息天然适合资金场景，整套业务能力支撑 |
| 秒杀系统 | RocketMQ/Kafka | 削峰需要高吞吐，RocketMQ的延迟消息可做倒计时 |
| 保险商城 | RocketMQ | 业务链路长，需要事务消息保证一致性 |
| IM在线客服 | RabbitMQ/Kafka | 低延迟路由 vs 高吞吐，看并发量级 |
| 资金路由 | RocketMQ | 多渠道支付需要事务保证 |

---

## 题目三：RocketMQ 高可用架构

### 整体架构

```
Producer → NameServer集群 → Broker集群（Master-Slave）→ Consumer

NameServer：
  - 存储：路由信息（哪个Broker有哪些Topic/Queue）
  - 机制：Broker定时注册心跳（30秒），120秒没收到就剔除
  - 特点：各节点独立、无状态、无通信、不强一致
  - 不做什么：不监控Broker健康（被动等心跳）、不管理Broker（不触发故障转移）

Broker：
  - Master-Slave模式，每个Master承担一部分Topic的读写
  - Slave只做备份，Master宕机时提供故障转移
  - 同步复制（SYNC_MASTER）/ 异步复制（ASYNC_MASTER）
```

### NameServer 为什么不需要强一致？

```
1. 路由信息短暂不一致是可接受的
   - Producer拿到旧的Broker列表 → 发送失败 → 重试时拿到最新列表
   - Consumer感知到新Broker → 重新做负载均衡

2. 对比ZooKeeper
   - ZK的Leader选举增加复杂度
   - ZK的强一致在路由场景下是over-engineering
   - NameServer各节点独立，挂一个不影响其他

3. 和Nacos Distro协议思路一致
   - 都是AP模式：服务注册/路由场景允许短暂不一致
   - 都是最终一致 + 重试兜底
   - 不同场景用不同一致性级别
```

### Master宕机后怎么办？

| 模式 | 切换方式 | 优势 | 劣势 |
|------|---------|------|------|
| **传统模式（4.x）** | Slave不能自动升主，需人工介入 | 简单 | 人工切换慢，故障期间该Broker不可写入 |
| **Dledger模式** | 基于Raft自动选主 | 自动故障转移 | 额外组件，运维复杂 |
| **Controller模式（5.x）** | 内置Controller自动切换 | 原生支持，推荐 | 较新版本 |

```
传统模式下Slave还能做什么？
  - Slave可提供读取（消费者可以从Slave消费）
  - 只是写入不可用，不影响已有消息的消费
```

---

## 题目四：Kafka 高可用架构

### 核心概念

```
Topic → 多个Partition → 每个Partition有一个Leader和多个Follower
Leader处理读写，Follower持续从Leader拉取数据做备份
Leader宕机 → 从ISR中选新Leader
```

### ISR 机制（面试重点）

```
ISR = In-Sync Replicas，与Leader保持同步的副本集合

Follower怎么算"同步"？
  → replica.lag.time.max.ms（默认10秒）内持续拉取最新消息
  → 超过10秒没跟上 → 踢出ISR

Follower落后了怎么办？
  → 落后少：从Leader拉取增量数据
  → 落后多：截断日志，重新同步（high watermark机制）

ISR和ACK的关系：
  ISR是"谁能参与确认"的范围（Broker端维护）
  ACK是"等多少人确认"的级别（Producer端配置）

  acks=all  → 等ISR中所有副本确认后才返回成功
  acks=1    → 只等Leader确认
  acks=0    → 不等确认
```

### Leader宕机怎么选新Leader

```
优先从ISR中选 → 数据不丢

ISR全挂了怎么办？
  unclean.leader.election.enable=false（默认）→ 分区不可用，等ISR恢复
  unclean.leader.election.enable=true → 允许非ISR副本升主 → 可能丢数据

架构师决策：
  金融场景 → false，宁可不可用也不能丢数据
  日志场景 → true，可用性优先
```

### Controller 机制

```
集群中一个Broker担任Controller角色：

职责：
  - 分区Leader选举
  - 副本分配
  - Broker上下线感知
  - Topic创建/删除

如何选举？
  - 通过ZK抢占 /controller 临时节点当选
  - 当前Controller宕机 → 临时节点消失 → 其他Broker争抢

Kafka 3.x KRaft模式（移除ZK依赖）：
  - 内置Raft协议选举Controller
  - 简化架构，减少外部依赖
  - 你上周学的Raft协议就用在这里
```

### Offset的作用

```
1. 消费进度管理：Consumer提交offset，宕机重启后从上次位置继续
2. 消息回溯：可以重置offset回溯到任意时间点重新消费
3. 独立消费：不同Consumer Group独立offset，同一条消息可被多个Group各消费一次
```

### Kafka vs RocketMQ 高可用对比

| 维度 | Kafka | RocketMQ |
|------|-------|----------|
| 元数据管理 | ZK / KRaft（强一致） | NameServer（最终一致） |
| 副本同步 | ISR机制（动态调整同步副本集） | 主从复制（固定Master-Slave） |
| 故障转移 | Controller自动选主 | 传统模式需人工，5.x Controller模式自动 |
| 数据一致性 | ISR机制保证 | 同步双写保证 |
| 扩展方式 | 增加Partition | 增加Broker + Queue |
| 设计哲学 | 数据一致性优先 | 简单轻量优先 |

---

## 题目五：事务消息 — Kafka vs RocketMQ

### 两个"事务"说的是不同的事

| 维度 | Kafka事务 | RocketMQ事务 |
|------|----------|-------------|
| 解决的问题 | 流处理链路的原子性 | 本地事务+消息的原子性 |
| 场景 | Flink消费Kafka→处理→写回Kafka | 扣余额+发消息通知 |
| 机制 | 两阶段提交（跨Partition） | 半消息+本地事务+回查 |
| 你的业务 | 不适用 | 蛋壳钱包的扣款+通知 |

### Kafka事务消息

```java
// 场景：流处理的Exactly Once
producer.initTransactions();
try {
    producer.beginTransaction();
    producer.send(record1); // Partition 0
    producer.send(record2); // Partition 1
    producer.commitTransaction();
} catch (Exception e) {
    producer.abortTransaction();
}
```

```
保证的是：消费→处理→生产链路的原子性
不是给你的业务事务用的！

如果要在Kafka上做业务事务 → 需要自己实现TCC或Saga
但这不是Kafka事务消息的功能，是你自己实现的
```

### RocketMQ事务消息（完整流程）

```
1. Producer发送半消息（Half Message）
   → Broker收到后对Consumer不可见，存入内部Topic

2. 执行本地事务
   → 成功 → 发送Commit → Broker将消息投到目标Topic
   → 失败 → 发送Rollback → Broker删除半消息

3. 事务回查（关键！）
   → Broker未收到Commit/Rollback → 定时回查Producer
   → 回查15次（默认）仍未确认 → Rollback
```

```java
TransactionMQProducer producer = new TransactionMQProducer("tx_producer_group");
producer.setTransactionListener(new TransactionListener() {
    @Override
    public LocalTransactionState executeLocalTransaction(Message msg, Object arg) {
        try {
            accountService.deduct(userId, amount);
            return LocalTransactionState.COMMIT_MESSAGE;
        } catch (Exception e) {
            return LocalTransactionState.ROLLBACK_MESSAGE;
        }
    }

    @Override
    public LocalTransactionState checkLocalTransaction(MessageExt msg) {
        boolean success = accountService.checkDeducted(msg.getTransactionId());
        return success ? LocalTransactionState.COMMIT_MESSAGE
                       : LocalTransactionState.ROLLBACK_MESSAGE;
    }
});
```

### 蛋壳钱包：TCC vs 事务消息

```
TCC方案（现在用的）：
  Try：冻结金额
  Confirm：扣减冻结金额
  Cancel：解冻金额
  优势：强一致
  劣势：性能差，每个下游都要写Try/Confirm/Cancel

RocketMQ事务消息方案：
  1. 发送半消息"扣减100元"
  2. 本地事务：扣减账户余额
  3. 扣减成功 → Commit → 消息可见 → 下游消费
  4. 扣减失败 → Rollback → 消息删除
  5. 网络断了没收到确认 → Broker回查 → 查本地账户是否扣了
  优势：简单，不需要下游配合
  劣势：最终一致，有短暂窗口期不一致

架构师决策：
  资金场景 → TCC（不能错，强一致）
  业务通知场景 → 事务消息（可以晚，最终一致）
```

---

## 今日能力差距分析

| 差距 | 具体表现 | 补足方向 |
|------|---------|---------|
| **Kafka侧知识不扎实** | ISR机制理解有误、事务消息概念混淆 | 系统过一遍Kafka官方文档，重点理解ISR和事务 |
| **回答偏结论** | 只说选什么，不说为什么和代价 | 每个选择加"为什么"和"放弃了什么" |
| **缺少主动对比** | 两个MQ的题没主动对比差异 | 答完一方后主动说"对比另一方" |
| **流程描述不够** | 事务消息只说了"Half消息"，没展开流程 | 练习时把关键流程画出来，说完再检查有没有漏步骤 |

### 关键数字补充

| 数字 | 值 |
|------|-----|
| NameServer心跳间隔 | Broker 30秒注册，120秒超时剔除 |
| ISR踢出阈值 | replica.lag.time.max.ms = 10秒 |
| 事务回查次数 | RocketMQ默认15次 |
| Kafka事务隔离级别 | read_uncommitted（默认）/ read_committed |

---

## 知识串联

| 已学主题 | 与MQ选型/高可用的关联 |
|---------|---------------------|
| CAP定理 | NameServer选AP，ZK/KRaft选CP，不同场景不同选择 |
| 分布式事务 | RocketMQ事务消息 vs TCC，两种一致性的实现路径 |
| 分布式锁 | Dledger/Controller的Leader选举本质是分布式锁问题 |
| 缓存架构 | Kafka页缓存 = OS级缓存，和业务缓存的思路不同 |
| Raft协议 | Dledger和KRaft都基于Raft，但应用场景不同 |
| 消息不丢（Day1） | ISR机制 vs 同步双写，不同的"多数派确认"思路 |

---

*日期：2026-05-19 | 第4周 Day2 | 主题：MQ选型与高可用 | 整理版*
