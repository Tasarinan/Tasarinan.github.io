# Day 7：架构深挖 — 分布式事务与消息最终一致性
## 一、为什么这个主题值得深挖？
### 1.1 你的业务背景
```plain
蛋壳钱包：TCC分布式事务
国美e卡：资金路由
保险商城：投保链路
秒杀系统：订单链路
→ 这些场景都绕不开"数据一致性"这个核心问题
```

### 1.2 面试中的地位
```plain
面试官必问：
  "你们系统中怎么保证数据一致性？"
  "TCC和可靠消息最终一致性怎么选？"
  "消息丢了/重复了怎么办？"

普通回答：
  "我们用TCC" / "我们用MQ"
→ 太浅，不像架构师

架构师回答：
  从业务场景→方案选型→技术实现→兜底方案→监控运维，完整讲清楚
→ 这才是架构师水平
```

---

## 二、先建立一个全局视图：一致性方案全景图
### 2.1 一致性方案的五个层级
```plain
┌─────────────────────────────────────────────────────────────┐
│  L1：本地事务（单DB）                                         │
│      优点：简单，ACID保证                                      │
│      缺点：只能单库                                           │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│  L2：XA事务（2PC/3PC）                                        │
│      优点：强一致性                                           │
│      缺点：性能差，锁时间长，可用性低                           │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│  L3：TCC（Try-Confirm-Cancel）                                │
│      优点：性能较好，最终一致                                   │
│      缺点：代码侵入，开发成本高                                 │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│  L4：可靠消息最终一致性（本地消息表/RocketMQ事务消息）          │
│      优点：解耦，性能好，最终一致                               │
│      缺点：实时性稍差                                         │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│  L5：Saga（长事务、补偿事务）                                  │
│      优点：适合长流程，无锁                                     │
│      缺点：需要编写补偿逻辑，回滚复杂                           │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 架构师决策树
```plain
业务场景 → 选择方案
─────────────────────────────────────────────
单笔操作，单库 → L1 本地事务

跨库操作，数据量小，实时性要求高 → L2 XA（慎用）

跨服务，实时性要求高，金额敏感 → L3 TCC
  例子：蛋壳钱包转账、支付扣款

跨服务，实时性要求不高，流程长 → L4 可靠消息最终一致性
  例子：保险投保、订单通知、IM推送

超长长流程，需要回滚 → L5 Saga
  例子：旅游预订（酒店+机票+门票）
```

---

## 三、深入拆解：TCC 分布式事务
### 3.1 TCC 的三个阶段
```plain
Try：
  资源检查 + 资源预留
  例子：冻结A的100元，不实际扣款
  特点：可以快速失败

Confirm：
  实际执行
  例子：扣除A的冻结金额，增加B的余额
  特点：必须成功（幂等）

Cancel：
  释放预留资源
  例子：解冻A的100元
  特点：必须成功（幂等）
```

### 3.2 TCC 的典型架构（蛋壳钱包转账案例）
```plain
┌─────────────────────────────────────────────────────────────┐
│                    用户发起转账                                │
│                      ↓                                       │
│              转账服务（TCC协调者）                            │
│                      ↓                                       │
│     ┌──────────────────┬──────────────────┐                 │
│     ↓                  ↓                  ↓                 │
│  账户A服务Try      账户B服务Try      流水服务Try            │
│  冻结100元         检查账户有效性    记录流水（处理中）     │
│     ↓                  ↓                  ↓                 │
│  都成功？─────────────是──────────────────┘                 │
│     ↓否                ↓是                                  │
│  全部Cancel        全部Confirm                              │
│     ↓                  ↓                                   │
│  解冻A的100元      扣A冻结+加B余额+流水完成                  │
└─────────────────────────────────────────────────────────────┘
```

### 3.3 TCC 的 6 个大坑（架构师必须知道）
#### 坑 1：空回滚
```plain
问题：
  Try没执行，Cancel先执行了
  例子：网络超时，Try没到账户A服务，Cancel先到了

架构师方案：
  1. 每个分支事务记录"是否执行过Try"
  2. Cancel时检查：如果Try没执行，直接返回成功（空回滚）
  3. 用事务日志表记录：
     ┌─────────────────────────────────────┐
     │ tx_id | branch_id | stage | status │
     │ 123   | accountA  | TRY   | SUCCESS│
     └─────────────────────────────────────┘
```

#### 坑 2：悬挂
```plain
问题：
  Cancel先执行，Try后执行
  例子：网络乱序，Cancel先到，Try后到

架构师方案：
  1. Try时检查：如果Cancel已经执行过，拒绝Try
  2. 用事务日志表判断：
     if (存在CANCEL记录) → 拒绝TRY
```

#### 坑 3：幂等
```plain
问题：
  Confirm/Cancel重复执行
  例子：网络超时，重复发送Confirm

架构师方案：
  1. 每个分支事务有唯一ID
  2. 执行前检查：如果已经执行过，直接返回成功
  3. 用事务日志表记录执行状态
```

#### 坑 4：超时处理
```plain
问题：
  某个分支超时了怎么办？

架构师方案：
  1. 同步等待 + 超时时间（比如30s）
  2. 超时后，定时任务不断重试Confirm/Cancel
  3. 重试超过N次（比如16次）→ 告警+人工介入
  4. 关键点：Confirm/Cancel必须幂等
```

#### 坑 5：Try 成功，Confirm 失败
```plain
问题：
  Try都成功了，Confirm时某个分支失败了

架构师方案：
  1. 不能回滚！不能回滚！不能回滚！
  2. 必须不断重试Confirm，直到成功
  3. 为什么？因为其他分支已经Confirm成功了
  4. 兜底：人工介入
```

#### 坑 6：事务日志表怎么设计？
```plain
架构师设计：
┌─────────────────────────────────────────────────────────┐
│ tcc_transaction_log                                     │
├─────────────────────────────────────────────────────────┤
│ id          BIGINT      PRIMARY KEY AUTO_INCREMENT      │
│ tx_id       VARCHAR(64) 全局事务ID                      │
│ branch_id   VARCHAR(64) 分支事务ID                      │
│ stage       VARCHAR(16)  TRY/CONFIRM/CANCEL             │
│ status      VARCHAR(16)  INIT/SUCCESS/FAIL              │
│ request_data JSON        请求参数                       │
│ response_data JSON       响应数据                       │
│ retry_count INT         重试次数                        │
│ created_at  DATETIME    创建时间                        │
│ updated_at  DATETIME    更新时间                        │
└─────────────────────────────────────────────────────────┘

索引：
  idx_tx_id_branch_id (tx_id, branch_id) 唯一
  idx_status_updated_at (status, updated_at) 用于定时任务扫描
```

### 3.4 TCC 的数字直觉
```plain
性能：
  Try阶段：3次网络调用（账户A+账户B+流水）
  Confirm阶段：3次网络调用
  总耗时：~200-500ms（同步等待）

可用性：
  某个分支不可用 → 整个事务失败/阻塞 → 需要兜底

开发成本：
  每个分支事务需要写3套逻辑（Try/Confirm/Cancel）
  → 开发成本是普通代码的3倍

适用场景：
  单笔操作涉及金额 ≤ 10万元
  实时性要求高（用户要立即看到结果）
  分支数 ≤ 5个
```

---

## 四、深入拆解：可靠消息最终一致性
### 4.1 方案一：本地消息表（最经典）
#### 核心思想
```plain
1. 本地事务执行时，同时写消息到本地消息表
2. 定时任务扫描本地消息表，发送到MQ
3. MQ消费端消费消息，幂等处理
4. 消费成功后，更新本地消息表状态
```

#### 完整架构（保险投保案例）
```plain
┌─────────────────────────────────────────────────────────────┐
│  步骤1：用户发起投保                                          │
│         ↓                                                    │
│  步骤2：投保服务本地事务（同一DB）                            │
│         ├─ 创建投保记录（状态=处理中）                         │
│         └─ 写入本地消息表：                                    │
│             tx_id: 123,                                      │
│             message: {投保信息},                             │
│             status: INIT,                                    │
│             retry_count: 0                                   │
│         ↓                                                    │
│  步骤3：本地事务提交 → 返回用户"处理中"                       │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│  步骤4：定时任务（每分钟扫描一次）                             │
│         SELECT * FROM local_message WHERE status = INIT      │
│         ↓                                                    │
│  步骤5：发送消息到MQ                                          │
│         发送成功 → status = SENT                              │
│         发送失败 → retry_count++                              │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│  步骤6：MQ消费端（核保服务）                                   │
│         ├─ 幂等检查（用tx_id去重）                             │
│         ├─ 执行核保逻辑                                       │
│         └─ ACK消息                                            │
│         ↓                                                    │
│  步骤7：消费成功 → 投保服务更新消息状态 = COMPLETED           │
└─────────────────────────────────────────────────────────────┘
```

#### 本地消息表设计
```plain
┌─────────────────────────────────────────────────────────┐
│ local_message                                           │
├─────────────────────────────────────────────────────────┤
│ id          BIGINT      PRIMARY KEY AUTO_INCREMENT      │
│ tx_id       VARCHAR(64) 唯一键                          │
│ topic       VARCHAR(64) MQ主题                          │
│ message     JSON        消息内容                        │
│ status      VARCHAR(16)  INIT/SENT/COMPLETED/FAIL       │
│ retry_count INT         重试次数                        │
│ max_retry   INT         最大重试次数（默认16）           │
│ created_at  DATETIME    创建时间                        │
│ updated_at  DATETIME    更新时间                        │
│ next_retry_at DATETIME  下次重试时间                    │
└─────────────────────────────────────────────────────────┘

索引：
  idx_tx_id (tx_id) 唯一
  idx_status_next_retry (status, next_retry_at) 用于扫描
```

#### 定时任务逻辑
```java
@Scheduled(fixedDelay = 60000) // 每分钟执行
public void scanAndSendMessages() {
    // 1. 扫描需要发送的消息
    List<LocalMessage> messages = localMessageMapper.selectByStatusAndNextRetry(
        Arrays.asList("INIT", "FAIL"),
        new Date()
    );

    for (LocalMessage message : messages) {
        try {
            // 2. 发送到MQ
            rocketMQTemplate.syncSend(message.getTopic(), message.getMessage());

            // 3. 发送成功，更新状态
            message.setStatus("SENT");
            localMessageMapper.updateById(message);

        } catch (Exception e) {
            // 4. 发送失败，更新重试次数和下次重试时间
            message.setRetryCount(message.getRetryCount() + 1);
            if (message.getRetryCount() >= message.getMaxRetry()) {
                message.setStatus("FAIL");
                // 告警：超过最大重试次数
                alertService.alert("消息发送失败超过最大重试次数: " + message.getId());
            } else {
                // 下次重试时间：指数退避（1min, 2min, 4min, 8min...）
                message.setNextRetryAt(calculateNextRetryTime(message.getRetryCount()));
            }
            localMessageMapper.updateById(message);
        }
    }
}
```

#### 消费端幂等设计
```java
@RocketMQMessageListener(topic = "INSURANCE_APPLY")
public class InsuranceApplyConsumer implements RocketMQListener<MessageExt> {

    @Autowired
    private MessageIdempotentMapper idempotentMapper;

    @Override
    public void onMessage(MessageExt message) {
        String txId = message.getKeys(); // 用txId做幂等键

        // 1. 幂等检查
        if (idempotentMapper.exists(txId)) {
            return; // 已经处理过，直接返回
        }

        try {
            // 2. 业务逻辑（核保）
            doUnderwrite(message);

            // 3. 记录幂等
            idempotentMapper.insert(txId);

        } catch (Exception e) {
            // 4. 业务异常，抛出去让MQ重试
            throw new RuntimeException(e);
        }
    }
}
```

#### 本地消息表的优点
```plain
✓ 可靠性高：本地事务保证消息一定被记录
✓ 可观察性好：消息状态清晰可见
✓ 可控性强：可以随时重发、人工干预
✓ 实现简单：不依赖MQ的事务消息
```

#### 本地消息表的缺点
```plain
✗ 本地事务耗时增加：多了一次DB写入
✗ 定时任务扫表：有轻微的DB压力
✗ 消息有延迟：取决于定时任务频率（1分钟）
✗ 需要额外维护：本地消息表、定时任务
```

---

### 4.2 方案二：RocketMQ 事务消息（更优雅）
#### 核心思想
```plain
1. 发送"半消息"（Half Message）到MQ
2. MQ收到半消息，持久化成功后，回调"执行本地事务"
3. 本地事务执行成功 → 提交消息（Commit）
   本地事务执行失败 → 回滚消息（Rollback）
4. 如果MQ长时间没收到Commit/Rollback → 回调"检查本地事务状态"
5. 消息提交后，消费端才能消费
```

#### 完整流程
```plain
┌─────────────────────────────────────────────────────────────┐
│  1. 投保服务向RocketMQ发送半消息                               │
│     Message: {投保信息}, TransactionId: 123                  │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│  2. RocketMQ收到半消息，持久化到DLQ（半消息队列）              │
│     ↓                                                        │
│  3. RocketMQ回调投保服务："执行本地事务"                      │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│  4. 投保服务执行本地事务：                                      │
│     ├─ 创建投保记录（状态=处理中）                              │
│     └─ 记录事务日志：tx_id=123, status=SUCCESS               │
│     ↓                                                        │
│  5. 本地事务执行成功 → 返回Commit给RocketMQ                   │
│     本地事务执行失败 → 返回Rollback给RocketMQ                 │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│  6. RocketMQ收到Commit → 把消息投递给消费者                    │
│     RocketMQ收到Rollback → 删除半消息                         │
│                                                             │
│     如果超时没收到（比如网络断了）→ 触发"回查"                 │
│     RocketMQ回调投保服务："检查事务状态"                      │
│     投保服务查询事务日志 → 返回Commit/Rollback                │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│  7. 消费端消费消息（幂等处理）                                 │
└─────────────────────────────────────────────────────────────┘
```

#### 代码实现
##### 1. 发送事务消息
```java
@Autowired
private RocketMQTemplate rocketMQTemplate;

public void submitInsuranceApply(InsuranceApply apply) {
    String txId = UUID.randomUUID().toString();

    // 构建消息
    Message<InsuranceApply> message = MessageBuilder
        .withPayload(apply)
        .setHeader(RocketMQHeaders.TRANSACTION_ID, txId)
        .build();

    // 发送事务消息
    rocketMQTemplate.sendMessageInTransaction(
        "insurance-apply-tx-group",  // 事务消息生产者组
        "INSURANCE_APPLY",           // Topic
        message,
        apply                        // 传给本地事务的参数
    );
}
```

##### 2. 本地事务监听器
```java
@RocketMQTransactionListener(txProducerGroup = "insurance-apply-tx-group")
public class InsuranceApplyTransactionListener implements RocketMQLocalTransactionListener {

    @Autowired
    private InsuranceApplyService applyService;

    @Autowired
    private TransactionLogMapper txLogMapper;

    @Override
    public RocketMQLocalTransactionState executeLocalTransaction(Message msg, Object arg) {
        String txId = (String) msg.getHeaders().get(RocketMQHeaders.TRANSACTION_ID);
        InsuranceApply apply = (InsuranceApply) arg;

        try {
            // 执行本地事务
            applyService.doSubmitApply(txId, apply);

            // 记录事务日志
            TransactionLog log = new TransactionLog();
            log.setTxId(txId);
            log.setStatus("SUCCESS");
            log.setCreatedAt(new Date());
            txLogMapper.insert(log);

            // 返回Commit
            return RocketMQLocalTransactionState.COMMIT;

        } catch (Exception e) {
            // 本地事务失败，返回Rollback
            TransactionLog log = new TransactionLog();
            log.setTxId(txId);
            log.setStatus("FAIL");
            log.setCreatedAt(new Date());
            txLogMapper.insert(log);

            return RocketMQLocalTransactionState.ROLLBACK;
        }
    }

    @Override
    public RocketMQLocalTransactionState checkLocalTransaction(Message msg) {
        String txId = (String) msg.getHeaders().get(RocketMQHeaders.TRANSACTION_ID);

        // 查询事务日志
        TransactionLog log = txLogMapper.selectByTxId(txId);

        if (log == null) {
            // 事务日志不存在 → 可能还在执行中 → 返回UNKNOWN，继续回查
            return RocketMQLocalTransactionState.UNKNOWN;
        }

        switch (log.getStatus()) {
            case "SUCCESS":
                return RocketMQLocalTransactionState.COMMIT;
            case "FAIL":
                return RocketMQLocalTransactionState.ROLLBACK;
            default:
                return RocketMQLocalTransactionState.UNKNOWN;
        }
    }
}
```

##### 3. 事务日志表
```plain
┌─────────────────────────────────────────────────────────┐
│ transaction_log                                         │
├─────────────────────────────────────────────────────────┤
│ id          BIGINT      PRIMARY KEY AUTO_INCREMENT      │
│ tx_id       VARCHAR(64) 唯一键                          │
│ status      VARCHAR(16)  SUCCESS/FAIL/UNKNOWN           │
│ business_type VARCHAR(32) 业务类型                      │
│ business_id VARCHAR(64)  业务ID                         │
│ created_at  DATETIME    创建时间                        │
│ updated_at  DATETIME    更新时间                        │
└─────────────────────────────────────────────────────────┘
```

#### RocketMQ 事务消息的优点
```plain
✓ 性能好：本地事务和消息发送原子性，不需要定时任务扫表
✓ 实时性好：消息立即发送，没有延迟
✓ 可靠性高：MQ提供事务消息机制，回查机制保证
✓ 代码简洁：不需要维护本地消息表和定时任务
```

#### RocketMQ 事务消息的缺点
```plain
✗ 依赖RocketMQ：只能用RocketMQ
✗ 理解成本高：半消息、回查等概念需要理解
✗ 回查逻辑需要自己实现：需要维护事务日志表
✗ 消息对消费者不可见：直到Commit之前，消费者看不到消息
```

#### RocketMQ 事务消息的数字直觉
```plain
半消息存储：
  存储在RMQ_SYS_TRANS_HALF_TOPIC这个内部Topic

回查机制：
  回查间隔：默认1分钟
  回查次数：默认15次
  超过15次 → 消息丢弃或进入死信（可配置）

性能：
  本地事务执行时间：~50-100ms
  消息投递延迟：~100-200ms（比普通消息稍慢）

适用场景：
  实时性要求较高的场景
  已经在使用RocketMQ的系统
```

---

### 4.3 两种方案对比：本地消息表 vs RocketMQ事务消息
| 维度 | 本地消息表 | RocketMQ事务消息 |
| --- | --- | --- |
| **可靠性** | 高 | 高 |
| **实时性** | 稍差（取决于定时任务） | 好 |
| **性能** | 稍差（多写一次DB） | 好 |
| **依赖** | 无（任何MQ都可以） | 必须RocketMQ |
| **复杂度** | 中等（需要维护定时任务） | 稍高（需要实现回查） |
| **可观察性** | 好（消息状态在DB） | 中等（需要查询MQ） |
| **适用场景** | 对实时性要求不高，通用场景 | 实时性要求高，已用RocketMQ |


---

## 五、TCC vs 可靠消息最终一致性：怎么选？
### 5.1 对比矩阵
| 维度 | TCC | 可靠消息最终一致性 |
| --- | --- | --- |
| **一致性** | 最终一致（接近强一致） | 最终一致 |
| **实时性** | 高（同步等待） | 中（异步） |
| **性能** | 中（多次网络调用） | 高（一次本地事务+消息） |
| **开发成本** | 高（3套逻辑） | 中（1套逻辑+幂等） |
| **可用性** | 中（某个分支不可用会阻塞） | 高（异步解耦） |
| **适用场景** | 金额敏感、实时性要求高 | 流程长、解耦要求高 |


### 5.2 架构师决策：用蛋壳钱包举例
#### 场景：用户A转账100元给用户B
```plain
方案选择：TCC

原因：
  1. 金额敏感，用户需要立即看到结果
  2. 分支数少（账户A、账户B、流水）
  3. 实时性要求高

具体设计：
  Try：冻结A的100元，检查B账户，记录流水（处理中）
  Confirm：扣A冻结，加B余额，流水完成
  Cancel：解冻A的100元，流水失败
```

#### 场景：转账成功后发送短信通知
```plain
方案选择：可靠消息最终一致性

原因：
  1. 短信通知不是核心流程
  2. 实时性要求不高（可以晚几秒）
  3. 解耦：短信服务挂了不影响转账

具体设计：
  1. TCC Confirm成功后，发送"转账成功"消息到MQ
  2. 短信服务消费消息，发送短信
  3. 幂等：重复消息不重复发短信
  4. 兜底：重试+死信+人工补发
```

---

## 六、架构师总结：一致性方案的"五层防御模型"
### 第一层：业务设计
```plain
目标：从业务层面避免一致性问题

方案：
  1. 尽量避免分布式事务：能不拆就不拆
  2. 合理拆分服务：按领域拆分，避免跨服务事务
  3. 最终一致优先：能接受最终一致，就不用强一致

例子：
  转账金额用TCC，通知用MQ
  → 核心数据强一致，非核心数据最终一致
```

### 第二层：技术方案选择
```plain
目标：选择合适的一致性方案

方案：
  1. 本地事务：首选
  2. TCC：金额敏感、实时性要求高
  3. 可靠消息最终一致性：流程长、解耦要求高
  4. Saga：超长长流程

例子：
  蛋壳钱包：TCC（转账）+ 可靠消息（通知）
```

### 第三层：幂等设计
```plain
目标：任何重试都不影响业务

方案：
  1. 唯一键：用业务唯一键做幂等
  2. 状态机：状态只能单向流转
  3. 分布式锁：同一时间只有一个能执行

例子：
  转账：用转账流水号做幂等
  通知：用消息ID做幂等
```

### 第四层：重试机制
```plain
目标：自动重试解决临时故障

方案：
  1. 快速重试：前3次间隔10s/30s/1min（临时故障）
  2. 慢速重试：后面13次间隔递增到2h（需要恢复的故障）
  3. 不重试：数据错误直接死信

例子：
  MQ重试：RocketMQ默认16次重试
  TCC重试：定时任务扫描失败的Confirm/Cancel
```

### 第五层：兜底方案
```plain
目标：任何问题都能人工介入

方案：
  1. 死信队列：重试失败进死信，人工处理
  2. 对账脚本：定时核对数据，发现不一致
  3. 人工后台：提供人工操作界面

例子：
  死信队列：短信发送失败16次 → 死信 → 人工补发
  对账脚本：每天核对转账流水和余额 → 发现不一致 → 修复
```

---

## 七、面试时怎么回答？
### 面试官问："你们系统中怎么保证数据一致性？"
#### 普通回答
```plain
"我们用TCC和MQ来保证一致性。"
→ 太简单
```

#### 架构师回答
```plain
"我从几个维度来说明我们的一致性方案：

1. **业务分层**：
   - 核心数据（金额、订单）用TCC，保证实时性和可靠性
   - 非核心数据（通知、日志）用可靠消息最终一致性，保证解耦和性能

2. **技术方案**：
   - TCC：我们解决了空回滚、悬挂、幂等这些常见问题，有完善的事务日志表
   - 可靠消息：我们用本地消息表方案，定时任务扫描发送，消费端幂等处理

3. **五层防御**：
   - L1：业务设计，尽量避免分布式事务
   - L2：方案选择，TCC+可靠消息结合
   - L3：幂等设计，唯一键+状态机+分布式锁
   - L4：重试机制，区分临时故障和数据错误
   - L5：兜底方案，死信队列+对账脚本+人工介入

4. **具体例子**：
   蛋壳钱包转账：用TCC保证金额准确，TCC成功后用MQ发送通知，通知有16次重试+死信队列+对账脚本兜底。

5. **监控运维**：
   我们监控TCC的失败率、消息的积压量、消费延迟，有完善的告警阈值和应急SOP。"

→ 这样回答，既有方法论，又有具体实践，架构师范儿就出来了！
```

---

## 八、刻意练习
### 练习 1：TCC 空回滚/悬挂处理
```plain
场景：
  蛋壳钱包TCC转账，网络超时，出现空回滚或悬挂

任务：
  1. 设计事务日志表
  2. 写出Try/Confirm/Cancel的处理逻辑
  3. 指出如何避免空回滚和悬挂

要求：
  考虑各种异常情况（网络超时、乱序、重复请求）
```

### 练习 2：可靠消息最终一致性
```plain
场景：
  保险商城投保，投保成功后需要：
    1. 调用核保接口
    2. 创建保单
    3. 发送保单邮件
    4. 发送短信通知

任务：
  1. 用本地消息表方案设计完整流程
  2. 设计本地消息表结构
  3. 写出定时任务发送逻辑
  4. 写出消费端幂等处理逻辑

要求：
  考虑消息丢失、重复、积压等问题
```

### 练习 3：方案选型
```plain
场景：
  给你以下业务场景，选择合适的一致性方案，并说明原因：

  1. 秒杀下单：扣库存+创建订单+扣余额
  2. 订单支付：支付成功后更新订单状态+发通知+加积分
  3. 旅游预订：预订酒店+机票+门票
  4. IM消息：医生发消息给患者，需要推送
  5. 国美e卡消费：扣e卡余额+记录流水+通知账务

任务：
  为每个场景选择方案，并说明为什么
```

---

## 九、能力差距自查
### 你需要掌握的
```plain
✓ 理解各种一致性方案的优缺点和适用场景
✓ 能根据业务场景选择合适的方案
✓ 能实现TCC，解决空回滚、悬挂、幂等问题
✓ 能实现可靠消息最终一致性（本地消息表/RocketMQ事务消息）
✓ 知道怎么设计幂等、重试、兜底方案
✓ 面试时能用架构师的语言表达
```

### 你可能欠缺的
```plain
✗ 数字直觉：不知道TCC耗时多少、消息延迟多少
✗ 反向论证：不知道为什么选这个不选另一个
✗ 运维经验：没处理过TCC失败、消息积压等问题
✗ 源码理解：没看过RocketMQ事务消息的实现
```

### 补足方向
```plain
1. 实践：本地搭建RocketMQ，跑一遍事务消息的流程
2. 源码：看看RocketMQ事务消息的实现
3. 故障演练：模拟各种故障，看系统如何应对
4. 总结：把自己项目中的一致性方案整理成文档
```

---

_日期：2026-05-24 | 第4周 Day7 | 主题：架构深挖-分布式事务与消息最终一致性 | 架构深挖_

