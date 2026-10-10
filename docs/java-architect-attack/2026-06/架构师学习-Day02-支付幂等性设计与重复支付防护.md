# 架构师学习-Day02-支付幂等性设计与重复支付防护

> 日期：2026年06月30日（周二）
> 周主题：支付系统架构设计
> 出题日：Day02 - 幂等性与重复支付防护

---

## 背景

Day01 落地的状态机里，PROCESSING→SUCCESS 与 PROCESSING→FAILED 的并发竞争被点名是"最危险的三处"之一。背后真正的工程命题就是**幂等**：渠道回调可能重投、MQ 消息可能重试、用户可能连点、网络超时可能触发上游重发——任何一个环节没有幂等护栏，都会演变成资损。本日聚焦于"从入口到资金层的全链路幂等"，为 Day03 对账、Day04 资金安全、Day05 退款分账打底。

支付幂等与秒杀库存扣减（第2周Day05）、Redis 分布式锁（第2周Day05）、TCC 分布式事务（第3周）一脉相承，但支付链路更长、跨服务跨进程跨渠道，幂等键的传递与组合防御是架构师必须讲清的能力。

---

## 题目一（架构设计题）：支付全链路幂等设计

蛋壳钱包收银台承接多业务线，请回答：

1. 一笔支付从用户点击付款到账务记账完成，**哪些环节必须做幂等**？请至少列出 6 个幂等点，并指出每个幂等点的"幂等键"是什么、由谁生成、有效期多长。
2. 幂等键的生成策略有哪些？（业务方生成 vs 网关生成 vs 渠道流水号）各自的优劣？跨服务调用时，幂等键如何在调用链上传递？
3. "幂等表"应该建在哪一层？字段如何设计？唯一索引建在什么字段上？为什么幂等表通常要配一个"执行状态"字段而不是仅靠唯一索引报错？
4. 部分退款场景下，原支付订单的幂等键不能直接复用，退款幂等键如何设计？合并支付（一笔支付订单关联多个业务订单）的幂等键又如何设计？

### 作答区

#### 1. 全链路幂等点清单

一笔支付从用户点击到账务记账完成，至少存在 **8 个幂等点**，分布在 5 个层级：

| # | 幂等点 | 所在层 | 幂等键 | 谁生成 | 有效期 | 防什么 |
|---|---|---|---|---|---|---|
| 1 | 收银台领票（Token） | 收银台 | `biz_order_no + cuid + token_nonce` | 收银台下发，业务方持有 | 30秒~2分钟 | 防用户连点、防业务方重复提交 |
| 2 | 业务方→支付网关下单 | 网关 | `biz_order_no + biz_system_id`（业务方幂等键） | 业务方生成 | 永久（业务订单生命周期） | 防业务方超时重试、防消息重投 |
| 3 | 支付订单创建 | 订单中心 | `pay_order_no`（雪花/Leaf 全局唯一） | 网关生成 | 永久 | 防同笔业务订单创建多笔支付单 |
| 4 | 网关→渠道下单 | 渠道适配 | `out_trade_no = pay_order_no` | 网关生成 | 渠道规定（微信2小时，支付宝1年） | 防同笔支付单在渠道侧重复下单 |
| 5 | 渠道异步回调入口 | 网关 | `channel_no + channel_id`（渠道流水号） | 渠道生成 | 永久落库 | 防渠道重投回调 |
| 6 | MQ 消费订单状态流转 | 订单中心 | `msg_key = channel_no`（或 pay_order_no） | 生产者透传 | MQ 持久化期内 | 防 MQ 至少一次投递导致的重复消费 |
| 7 | 业务订单状态回调 | 业务系统 | `pay_order_no + biz_event_type` | 通知中心生成 | 永久 | 防通知中心重试导致业务订单重复更新 |
| 8 | 账务记账 | 账务系统 | `pay_order_no + account_id + direction`（借贷方向） | 账务系统 | 永久 | 防重复记账（同笔支付只能记一笔借/贷） |

**关键设计原则**：

- **每个幂等点独立设计幂等键**，不能跨层复用。例如不能用 `pay_order_no` 当账务记账幂等键，因为退款时同笔 pay_order_no 还要记反向账。
- **幂等键必须"业务语义稳定"**：不依赖时间戳、不依赖随机数、不依赖机器IP。业务方重试 N 次，幂等键必须完全一致。
- **幂等键必须可追溯**：每个幂等键落库时记录原始请求快照、来源 IP、调用方 systemId，方便排查"谁重复提交了"。
- **有效期分层**：领票 Token 短（30秒~2分钟，防连点）；业务下单键永久（业务订单生命周期）；渠道回调键永久（监管要求 7 年留存）。

#### 2. 幂等键生成策略与跨服务传递

**三种生成策略对比**：

| 策略 | 谁生成 | 优点 | 缺点 | 适用场景 |
|---|---|---|---|---|
| **业务方生成** | 业务系统（电商/保险/问诊） | 业务语义稳定，跨重试一致；业务方掌握上下文 | 依赖业务方规范，可能有脏数据 | 业务→支付网关下单 |
| **网关生成** | 支付网关 | 全局唯一可控；屏蔽业务方差异 | 不能跨"网关→渠道"复用 | 支付订单号、out_trade_no |
| **渠道生成** | 微信/支付宝/银联 | 渠道权威，回调时携带 | 网关下单前拿不到，只能用于回调幂等 | 渠道回调、渠道查询 |

**实际组合**（蛋壳钱包实践）：

```
业务方 → 网关：用 biz_order_no + biz_system_id（业务方生成）
网关 → 订单中心：用 pay_order_no（网关生成，雪花算法）
网关 → 渠道：out_trade_no = pay_order_no（透传网关生成的）
渠道 → 网关回调：channel_no（渠道生成，落库为幂等键）
网关 → MQ → 订单中心：msg_key = channel_no（透传渠道生成）
订单中心 → 业务系统：pay_order_no + biz_event_type（网关生成）
```

**跨服务传递**：

- **HTTP 调用**：放在请求头 `X-Idempotency-Key`，全链路透传。Spring Cloud OpenFeign 用 RequestInterceptor 统一注入。
- **MQ 消息**：放 `msg_key` 和 `msg_properties` 双重携带。msg_key 用于 MQ 层去重（部分 MQ 支持），msg_properties 用于业务层幂等校验。
- **traceId 与幂等键分离**：traceId 用于全链路追踪（一次调用一个），幂等键用于业务去重（N 次调用一个）。不能混用，否则重试时 traceId 变了但幂等键不变，traceId 无法定位所有重试请求。

**关键陷阱**：

- 业务方生成幂等键时，如果用了 `UUID.randomUUID()`，每次重试都不同 → 等于没幂等。必须强制业务方用"业务订单号 + 业务系统标识"。
- 跨服务传递时如果序列化丢失（如 JSON 反序列化丢字段），下游拿不到幂等键 → 必须用强类型 DTO，禁止用 Map 传参。

#### 3. 幂等表设计与"执行状态"字段

**幂等表建在哪一层**：建在**实际执行业务动作的服务**（订单中心、账务系统），而不是网关。原因：网关只做路由，不做业务执行；幂等表必须与业务数据在同一事务里，否则会出现"幂等记录写入成功但业务执行失败"的不一致。

**字段设计**：

```sql
CREATE TABLE idempotent_record (
    id              BIGINT       PRIMARY KEY AUTO_INCREMENT,
    idempotent_key  VARCHAR(128) NOT NULL,        -- 幂等键
    biz_type        VARCHAR(32)  NOT NULL,        -- 业务类型：CREATE_PAY/REFUND/SETTLE
    request_snapshot TEXT,                         -- 原始请求快照（JSON）
    status          TINYINT      NOT NULL,        -- 0-INIT 1-PROCESSING 2-SUCCESS 3-FAILED
    response_snapshot TEXT,                        -- 首次执行结果快照（成功后存）
    retry_count     INT          DEFAULT 0,
    created_at      DATETIME     NOT NULL,
    updated_at      DATETIME     NOT NULL,
    expire_at       DATETIME     NOT NULL,        -- 过期时间（领票场景用）
    UNIQUE KEY uk_key_biz (idempotent_key, biz_type)  -- 唯一索引
);
```

**唯一索引建在 `(idempotent_key, biz_type)`**：

- 不能只建 `idempotent_key`：因为同一个 key 可能用于不同业务类型（如 `pay_order_no` 既能用于支付下单，也能用于退款），加 `biz_type` 区分。
- 不能只建 `biz_type`：毫无意义。
- 复合唯一索引保证"同 key 同业务只能成功插入一次"。

**为什么需要 `status` 字段，不能仅靠唯一索引报错？**

这是幂等设计的核心考点。仅靠唯一索引报错存在三个致命问题：

**① 无法区分"首次执行中"与"已完成"**

```
线程A：INSERT 成功 → status=PROCESSING → 调渠道下单（耗时200ms）
线程B：INSERT 失败（唯一索引冲突）→ ？？？怎么办
```

线程B拿到唯一索引冲突后，不知道：
- 是线程A还在执行中（应该等待或返回"处理中"）
- 还是线程A已成功（应该直接返回首次结果）
- 还是线程A执行失败了（应该重试还是返回失败）

有了 `status` 字段，线程B可以查询当前状态：
- INIT/PROCESSING → 返回"处理中，请轮询"
- SUCCESS → 直接返回 `response_snapshot`（关键！首次成功的响应必须存下来给重试请求用）
- FAILED → 允许重试（DELETE 旧记录或 UPDATE 状态为 INIT）

**② 失败场景下唯一索引会"卡死"重试**

```
首次执行：渠道返回余额不足 → INSERT 成功但执行失败
业务方重试：唯一索引冲突 → 永远失败
```

正确做法：执行失败时 `status=FAILED`，重试时检测到 FAILED 允许 `UPDATE status=INIT` 重新执行。

**③ 异常恢复需要状态机驱动**

进程崩溃后重启，幂等表里留下 `status=PROCESSING` 的"僵尸记录"。需要定时任务扫描超时的 PROCESSING 记录：
- 调渠道查询接口确认实际状态
- 成功 → 置 SUCCESS + 补充响应快照
- 失败 → 置 FAILED，允许重试
- 进行中 → 继续等待

**仅靠唯一索引报错的"伪幂等"代码**（错误示范）：

```java
// 错误：仅靠唯一索引，无法处理并发与失败
try {
    insertIdempotent(key);
    return executeBiz(req);
} catch (DuplicateKeyException e) {
    return "重复请求";  // 错！无法区分"成功中"还是"已成功"
}
```

**正确的幂等执行模板**：

```java
public Result execute(IdempotentRequest req) {
    String key = req.getIdempotentKey();
    
    // 1. 查询已有记录
    IdempotentRecord exist = query(key, req.getBizType());
    if (exist != null) {
        switch (exist.getStatus()) {
            case SUCCESS: return Result.fromSnapshot(exist.getResponseSnapshot());
            case PROCESSING: return Result.processing();
            case FAILED: 
                // 允许重试：用乐观锁抢占
                if (!retryLock(exist)) return Result.processing();
                break;
        }
    }
    
    // 2. 抢占式插入（或更新 FAILED→PROCESSING）
    try {
        insertOrClaim(key, req.getBizType(), snapshot(req));
    } catch (DuplicateKeyException e) {
        return Result.processing();  // 被其他线程抢占
    }
    
    // 3. 执行业务
    try {
        Result r = doExecute(req);
        updateStatus(key, SUCCESS, r.toSnapshot());
        return r;
    } catch (Exception e) {
        updateStatus(key, FAILED, null);
        throw e;
    }
}
```

#### 4. 退款与合并支付的幂等键设计

**部分退款幂等键**：

原支付订单的幂等键 `pay_order_no` 不能复用于退款，因为：
- 一笔支付可能多次部分退款（先退50，再退30）
- 退款是独立业务动作，需要独立的幂等控制

**退款幂等键设计**：

```
refund_idempotent_key = biz_refund_no（业务方生成的退款单号）
                      或 pay_order_no + "#" + refund_seq（同笔支付的退款序号）
```

**关键字段**：

```sql
CREATE TABLE refund_order (
    refund_no       VARCHAR(64) PRIMARY KEY,       -- 退款单号（幂等键）
    pay_order_no    VARCHAR(64) NOT NULL,          -- 原支付订单
    refund_amount   DECIMAL(18,2) NOT NULL,
    refund_seq      INT NOT NULL,                  -- 第几次部分退款
    status          TINYINT NOT NULL,
    UNIQUE KEY uk_pay_seq (pay_order_no, refund_seq),  -- 防同序号重复
    CHECK (refund_amount > 0),
    INDEX idx_pay (pay_order_no)
);
```

**累计金额校验**（防止退款超额）：

```sql
-- 发起退款前校验
SELECT 
    pay_order_no,
    SUM(refund_amount) AS total_refunded
FROM refund_order 
WHERE pay_order_no = ? AND status = SUCCESS
GROUP BY pay_order_no
HAVING SUM(refund_amount) + ? <= original_pay_amount;  -- 必须成立
```

**合并支付幂等键**：

合并支付：购物车一次结账，多笔业务订单（SO001、SO002、SO003）合并为一笔支付订单（PayOrder-001）。

```
合并支付幂等键 = 合并批次号（merge_batch_no）+ 业务方标识
                或 biz_system_id + cuid + merge_token（领票Token）
```

**关联表设计**：

```sql
CREATE TABLE pay_order_biz_ref (
    id              BIGINT PRIMARY KEY,
    pay_order_no    VARCHAR(64) NOT NULL,
    biz_order_no    VARCHAR(64) NOT NULL,
    biz_system_id   VARCHAR(32) NOT NULL,
    split_amount    DECIMAL(18,2),                 -- 分摊金额（用于退款按单拆分）
    UNIQUE KEY uk_pay_biz (pay_order_no, biz_order_no),
    UNIQUE KEY uk_biz_pay (biz_order_no, pay_order_no),
    INDEX idx_pay (pay_order_no)
);
```

**两道唯一索引的意义**：
- `uk_pay_biz`：一笔支付订单下同一业务订单只能出现一次（防重复关联）
- `uk_biz_pay`：一笔业务订单只能关联到一笔支付订单（防业务订单被重复支付）

**业务订单维度幂等校验**（关键）：合并支付发起前，必须校验所有业务订单均未支付：

```sql
SELECT biz_order_no FROM pay_order_biz_ref 
WHERE biz_order_no IN (?, ?, ?) AND pay_status = SUCCESS;
-- 若有结果，拒绝合并支付
```

---

## 题目二（原理深入题）：重复支付的成因与防护链路

实战中最常见的资损事故是"用户付了一次钱，系统扣了两次"。请回答：

1. 列出至少 **5 种**导致重复支付的根因场景（从用户行为、客户端、网络、服务端、渠道侧分别给出），并指出每种场景的触发条件。
2. 针对其中"**用户连点付款**"和"**渠道回调延迟 + 上游重试**"两个场景，分别画出时序图，说明各环节的幂等防护点。
3. 客户端防连点、服务端幂等表、状态机乐观锁、渠道侧"查询订单"接口——这四道防线各自能拦截什么、拦不住什么？如何组合形成纵深防御？
4. 如果渠道侧已经扣款成功，但本地订单因为乐观锁冲突一直没有置成 SUCCESS，T+1 对账时发现"渠道已扣款、本地仍 PROCESSING"。这个差异单的处理流程是什么？直接补单置 SUCCESS 有什么风险？

### 作答区

#### 1. 重复支付的 5 种根因场景

| # | 类别 | 场景 | 触发条件 |
|---|---|---|---|
| 1 | 用户行为 | 用户连点付款按钮 | 收银台未做按钮置灰、未领票；网络慢时用户急躁连点 |
| 2 | 客户端 | 客户端超时重试 | 客户端发起支付请求后未收到响应（实际已收到），按超时策略重试 |
| 3 | 网络 | 网关响应丢失 | 网关已创建支付单并调渠道成功，但响应回客户端时网络中断；客户端重试 |
| 4 | 服务端 | 业务方超时重试 | 业务方调网关下单，网关处理慢（>业务方超时阈值），业务方触发重试 |
| 5 | 渠道侧 | 渠道回调延迟 + 上游重试 | 渠道异步回调延迟到达，订单中心未及时置 SUCCESS；业务方查询接口超时，触发"补单"逻辑再次发起支付 |
| 6 | 服务端 | MQ 消息重投 | MQ 至少一次投递，回调消息被消费两次（消费者宕机后 rebalance 重投） |
| 7 | 渠道侧 | 渠道侧重启导致重复扣款 | 渠道内部状态机未与商户侧同步，渠道侧重试扣款 |

**最隐蔽的场景是 #5**：表面看是渠道回调慢，实际是业务方"补单逻辑"设计错误——业务方查询超时后，没有调"查询接口"而是直接重新发起支付，相当于绕过幂等键新建支付单。

#### 2. 两个典型场景的时序图与防护点

**场景一：用户连点付款**

```
用户          收银台         网关          订单中心       渠道
  │  点付款①   │              │              │             │
  │───────────>│              │              │             │
  │  点付款②   │              │              │             │
  │───────────>│  ①拦截        │              │             │
  │            │  (按钮置灰)   │              │             │
  │            │  ②领票Token  │              │             │
  │            │─────────────>│              │             │
  │            │              │  ③幂等表查询  │             │
  │            │              │  (biz_key不存在)            │
  │            │              │  ④插入幂等表  │             │
  │            │              │  status=PROCESSING         │
  │            │              │  ⑤创建支付单 INIT          │
  │            │              │─────────────>│             │
  │            │  返回拉起参数 │              │             │
  │            │<─────────────│              │             │
  │  点付款③   │              │              │             │
  │───────────>│  ⑥客户端拦截（按钮置灰/Token已用）         │
  │            │  ⑦若绕过客户端，到网关查询幂等表           │
  │            │  status=PROCESSING → 返回相同响应          │
  │  返回相同参数│              │              │             │
  │<───────────│              │              │             │
  │  拉起SDK   │              │              │             │
  │──────────────────────────────────────────────────────>│
  │  扣款一次  │              │              │             │
```

**防护点**：
- ① 客户端按钮置灰（防连点的第一道防线，最廉价）
- ② 领票 Token（一次性凭证，业务方提交时必须携带，使用后失效）
- ③④ 服务端幂等表（核心防线，承载所有重复请求的识别）
- ⑤ 支付订单状态机（INIT→PROCESSING 是单次的，禁止重复创建）
- ⑥ 客户端二次拦截（按钮置灰期间的所有点击都不发请求）
- ⑦ 服务端幂等响应（返回首次的响应快照，让重试请求拿到相同结果继续后续流程）

**场景二：渠道回调延迟 + 上游重试**

```
业务方        网关          订单中心       渠道         MQ
  │  下单     │              │              │             │
  │──────────>│ createPayOrder(INIT)        │             │
  │           │──────────────>│ 调渠道下单   │             │
  │           │               │─────────────>│             │
  │           │               │ PROCESSING   │             │
  │  返回处理中│              │              │             │
  │<──────────│              │              │             │
  │                                                          │
  │  ①业务方查询超时                                          │
  │  ②业务方"补单"逻辑：错误地重新发起支付                     │
  │──────────>│  ③网关幂等表拦截（biz_key已存在）              │
  │           │  返回首次响应                                  │
  │<──────────│                                               │
  │                                                          │
  │           │  ④渠道回调（延迟到达）                         │
  │           │<─────────────────────────────│               │
  │           │  验签→通知中心→MQ                             │
  │           │                              │─────────────>│
  │           │                              │  ⑤订单中心消费 │
  │           │                              │  幂等键=channel_no
  │           │                              │  状态机校验：PROCESSING→SUCCESS
  │           │                              │  乐观锁更新（version+1）
  │           │                              │  ⑥MQ消息重投（消费者rebalance）
  │           │                              │  幂等键channel_no命中
  │           │                              │  状态已是SUCCESS → 直接ACK返回
  │           │  ⑦通知业务方                                  │
  │           │  MQ biz_key=pay_order_no+biz_event           │
  │<──────────│                                               │
```

**防护点**：
- ③ 网关层幂等表（拦截业务方错误的重发请求，返回首次响应）
- ⑤ 订单中心 MQ 消费幂等（channel_no 作为幂等键）
- ⑤ 状态机乐观锁（PROCESSING→SUCCESS 用 `WHERE status=PROCESSING AND version=?`）
- ⑥ MQ 重投幂等（状态机白名单校验，已是 SUCCESS 则直接 ACK）
- ⑦ 业务通知幂等（pay_order_no+biz_event_type 作为幂等键）

#### 3. 四道防线的纵深防御

| 防线 | 能拦截 | 拦不住 | 失效场景 |
|---|---|---|---|
| **客户端防连点** | 用户主动连点、按钮重复点击 | 网络重试、客户端崩溃后的重试、绕过客户端的直接调用 | JS 被禁用、客户端 BUG、API 直接调用 |
| **服务端幂等表** | 所有重复请求（HTTP重试、MQ重投、绕过客户端的调用） | 幂等键生成错误（每次重试不同）、跨服务的并发首次执行 | 业务方用 UUID 做幂等键、Redis 宕机误判 |
| **状态机乐观锁** | 并发的状态流转冲突（PROCESSING→SUCCESS 重复） | 状态机配置错误、跨表的复合状态（如支付+账务） | 状态机白名单不全、version 字段未加索引 |
| **渠道侧查询接口** | 回调丢失、本地状态滞后 | 渠道侧本身的状态不一致、查询接口的限流 | 渠道查询接口限流、查询返回的状态非权威 |

**纵深防御组合**：

```
第一道：客户端防连点（按钮置灰 + Token 一次性）
   ↓ 漏过的（API 直调、客户端 BUG）
第二道：服务端幂等表（网关层、订单层、账务层各一道）
   ↓ 漏过的（并发首次执行、跨服务调用）
第三道：状态机乐观锁（数据库层最终裁决）
   ↓ 漏过的（状态滞后、回调丢失）
第四道：渠道侧查询接口（主动补偿）+ T+1 对账兜底
```

**为什么不能只靠一道防线**：

- 只靠客户端：API 直接调用绕过，秒级资损
- 只靠幂等表：幂等键生成错误时全线崩盘
- 只靠状态机：跨表的复合状态（支付+账务+业务订单）无法保证一致
- 只靠查询接口：渠道限流时拖垮渠道接口，引发更大范围故障

**架构师视角**：四道防线各有失效场景，必须组合使用。其中**幂等表是核心**（覆盖 80% 场景），**状态机乐观锁是兜底**（覆盖并发首次执行），**查询+对账是补网**（覆盖极少数漏网场景）。

#### 4. "渠道已扣款、本地仍 PROCESSING"差异单处理

这是 T+1 对账最常见的差异类型，处理流程必须严谨，**直接补单置 SUCCESS 有资损风险**。

**完整处理流程**：

```
Step1：对账系统识别差异
   渠道对账文件：SUCCESS（已扣款）
   本地订单：    PROCESSING（仍在处理中）
   ↓
Step2：人工/自动审核（金额阈值分级）
   小额（<100元）：自动处理
   大额（>=100元）：人工审核
   ↓
Step3：调渠道查询接口二次确认
   关键：不能直接信任对账文件，必须调查询接口拿到渠道侧权威状态
   渠道查询返回 SUCCESS → 进入Step4
   渠道查询返回 PROCESSING → 挂起，下一轮对账再处理
   渠道查询返回 FAILED/CLOSED → 渠道对账文件错误，提工单
   ↓
Step4：检查本地订单当前状态
   仍 PROCESSING → 进入Step5
   已变为 SUCCESS/CLOSED/FAILED → 中止补单（说明已被其他流程处理）
   ↓
Step5：执行补单（核心防资损步骤）
   ① 乐观锁更新：UPDATE pay_order SET status=SUCCESS 
                  WHERE id=? AND status=PROCESSING AND version=?
   ② 触发后续业务流程：MQ通知业务系统更新业务订单为已支付
   ③ 触发账务记账
   ④ 全程记录审计日志（人工工单号、操作人、渠道流水号）
   ↓
Step6：事后核对
   ① 业务订单是否已正确流转
   ② 账务是否已记账
   ③ 通知是否已下发
   任一环节失败 → 告警，人工介入
```

**直接补单置 SUCCESS 的风险**：

**风险一：业务订单可能已经被关单/退款**

```
时间线：
  T0：渠道扣款成功，本地仍 PROCESSING
  T1：业务方超时关单业务订单（但本地支付单仍 PROCESSING）
  T2：T+1 对账发现差异
  T3：直接补单置 SUCCESS → 业务订单状态混乱
       （已关单的业务订单被置为已支付，可能误发货）
```

正确做法：补单前必须校验业务订单当前状态，若业务订单已关单，应走"自动退款"流程而非补单。

**风险二：可能存在重复退款**

```
时间线：
  T0：渠道扣款成功
  T1：本地超时关单（CLOSED）
  T2：渠道回调晚到，触发自动退款
  T3：T+1 对账发现"渠道已扣款"但忽略了"已退款"
  T4：直接补单置 SUCCESS → 资金对账错误（钱已退但订单显示已支付）
```

正确做法：补单前查询退款记录，若有退款则差异类型应为"已退款未对账"而非"未支付"。

**风险三：账务可能已记反向账**

如果账务系统在超时关单时记了"冲正账"，补单置 SUCCESS 后会触发正向记账，导致同笔支付记一正一反两笔账。

正确做法：补单前校验账务记录，已记账的走"账务冲销"流程而非补记。

**风险四：渠道侧可能实际是退款中**

渠道对账文件生成时刻是 SUCCESS，但生成后用户可能已发起退款。直接补单置 SUCCESS 会与渠道当前状态不一致。

正确做法：Step3 的渠道查询必须返回**当前**状态而非对账文件时点状态。

**架构师总结**：补单不是简单的 `UPDATE status`，而是一个**多状态校验的事务**：

```text
补单事务伪代码：
  BEGIN;
    1. 锁定支付订单行（SELECT FOR UPDATE）
    2. 校验订单状态仍为 PROCESSING
    3. 调渠道查询确认当前状态为 SUCCESS
    4. 校验无退款记录
    5. 校验账务未记账
    6. 校验业务订单未关单
    7. UPDATE 支付订单 status=SUCCESS
    8. 记录审计日志
  COMMIT;
  
  COMMIT 后异步触发：
    - MQ 通知业务系统
    - MQ 通知账务记账
    - MQ 通知通知中心
```

---

## 题目三（选型权衡题，进阶）：幂等实现方案选型与边界

针对不同场景，幂等的实现方案不同。请回答：

1. **Redis SETNX**（分布式锁/标记位）vs **数据库唯一索引**（幂等表）vs **状态机乐观锁**（version 字段）vs **Token 机制**（前置领票）——四者各自适用的场景、性能、可靠性边界？给出一张选型对照表。
2. 为什么"只用 Redis SETNX 做幂等"是危险的？请构造一个具体的资损场景说明 Redis 宕机 + 重试导致的重复扣款。
3. 高并发支付（峰值 QPS 数万）下，幂等表的写入会成为瓶颈。如何优化？（分库分表、本地幂等缓存、异步落库、热点账户）这些优化各自带来什么新风险？
4. 跨服务的分布式幂等（如订单服务调用支付服务、支付服务调用渠道服务）如何保证？是端到端用一个幂等键，还是每跳用不同幂等键？Saga 长事务里的幂等补偿与 TCC 的 Try/Confirm/Cancel 幂等有什么区别？结合蛋壳钱包的 TCC 实战讲。

### 作答区

#### 1. 四种幂等方案选型对照表

| 维度 | Redis SETNX | DB 唯一索引 | 状态机乐观锁 | Token 领票 |
|---|---|---|---|---|
| **原理** | 抢占式设键，过期自动失效 | 唯一索引冲突拦截重复插入 | version 字段控制更新条件 | 前置申请一次性 Token |
| **性能** | 极高（10w+ QPS） | 中（1w QPS，受 DB 限制） | 中（同 DB） | 高（Redis 存 Token，DB 存业务） |
| **可靠性** | 中（Redis 宕机丢数据） | 高（DB 持久化） | 高（同 DB） | 高（Token 短期、业务数据持久） |
| **持久性** | 过期失效（秒级~分钟级） | 永久 | 永久 | Token 短期 + 业务永久 |
| **幂等返回** | 难（无法返回首次结果） | 中（需配 status 字段） | 中（需查当前状态） | 易（Token 关联首次结果） |
| **失败重试** | 不支持（键已设无法重置） | 支持（status=FAILED 可重试） | 支持 | 支持 |
| **适用场景** | 防连点、限流去重、领票 | 支付下单、退款、记账 | 状态流转并发控制 | 收银台领票、表单提交 |
| **典型用法** | `SET key val NX EX 30` | `INSERT ... UNIQUE KEY` | `UPDATE ... WHERE version=?` | 领票→业务→销票 |
| **失效场景** | Redis 主从切换丢数据、过期键 | DB 主从延迟、唯一索引设计错误 | 状态机白名单不全 | Token 提前过期、Token 重放 |
| **金融场景** | ❌ 不可单独用于资金幂等 | ✅ 推荐 | ✅ 必备 | ✅ 推荐作为前置 |

**组合使用原则**：

```
Redis SETNX（前置防连点、限流去重）
   ↓
Token 领票（业务方调用前先领票）
   ↓
DB 唯一索引（幂等表，承载核心幂等逻辑）
   ↓
状态机乐观锁（并发状态流转兜底）
```

四者并非互斥，而是**层层递进的纵深防御**。Redis 用于"快速过滤"，DB 唯一索引用于"权威记录"，状态机用于"并发兜底"，Token 用于"业务防重"。

#### 2. "只用 Redis SETNX 做幂等"的资损场景

**场景构造**：

```
T0：业务方调网关下单，网关用 Redis SETNX 设置幂等键
    SET pay_order:bid:123 NX EX 3600  →  成功
T1：网关调渠道下单（耗时200ms）
T2：渠道扣款成功，本地准备更新订单状态
T3：Redis 主从切换（哨兵提升新主），新主未同步到该键
T4：业务方超时重试，再次调网关下单
T5：网关 Redis SETNX 设置同一键 → 成功（因为新主没数据）
T6：网关再次调渠道下单 → 渠道侧"同 out_trade_no 重复"拦截
    但若 out_trade_no 不同（业务方生成了新幂等键），渠道侧无法拦截
T7：渠道再次扣款 → 用户被扣两次
```

**根因分析**：

- Redis 主从切换存在数据丢失窗口（异步复制）
- SETNX 的键在新主上不存在，被误判为"首次请求"
- 没有数据库幂等表兜底，无法识别这是重复请求

**为什么 Redis 不能单独用于资金幂等**：

| 问题 | 影响 |
|---|---|
| 异步复制丢数据 | 主从切换后键丢失，重复请求被放行 |
| 过期失效 | 业务仍在执行中，键过期后被重放 |
| 持久化不可靠 | AOF/RDB 恢复可能丢最近数据 |
| 集群分片迁移 | 迁移过程中键可能找不到 |
| 网络分区 | 部分节点持有键，部分节点没有 |

**正确组合**：

```java
// 错误：仅靠 Redis
if (redis.setIfAbsent(key, val, 30s)) {
    return executeBiz();  // Redis 丢失后会重复执行
}

// 正确：Redis 快速过滤 + DB 权威记录
if (!redis.setIfAbsent(key, val, 30s)) {
    // 可能是重复请求，也可能是 Redis 主从切换的误判
    IdempotentRecord r = db.query(key);
    if (r != null) return handleExist(r);
}
try {
    db.insertIdempotent(key, PROCESSING);  // DB 唯一索引兜底
    return executeBiz();
} catch (DuplicateKeyException e) {
    // DB 拦截了重复请求
    return handleExist(db.query(key));
}
```

**Redis 在幂等中的正确角色**：

- **快速过滤层**：拦截 80% 的明显重复请求，避免打到 DB
- **不可作为唯一防线**：必须配合 DB 唯一索引
- **过期时间设置**：必须大于业务最长执行时间 + 重试周期，避免键过期后被重放

#### 3. 高并发下幂等表瓶颈优化与新风险

**瓶颈分析**：

峰值 QPS 数万时，幂等表的写入瓶颈：
- 单库写入 QPS 上限约 1w（含唯一索引校验）
- 唯一索引的 B+ 树插入会加锁，热点键（如热门活动）会形成锁等待
- 大量 INSERT 事务日志（binlog）拖慢主从同步

**优化方案及新风险**：

**方案一：分库分表**

按 `biz_system_id` 或 `biz_order_no` 哈希分片，将幂等表分散到多个库多个表。

- ✅ QPS 线性扩展
- ⚠️ 风险：跨片查询困难，运维复杂
- ⚠️ 风险：分片键设计错误会导致同业务订单的幂等记录落在不同片

**方案二：本地幂等缓存**

业务进程内用 Caffeine/Guava 缓存近期成功的幂等键，命中则直接返回。

```java
Cache<String, Result> localCache = Caffeine.newBuilder()
    .maximumSize(100_000)
    .expireAfterWrite(5, TimeUnit.MINUTES)
    .build();

Result execute(req) {
    String key = req.getKey();
    Result cached = localCache.getIfPresent(key);
    if (cached != null) return cached;  // 本地命中
    // 未命中走 DB 幂等表
    ...
}
```

- ✅ 极快，拦截 90% 重复请求
- ⚠️ 风险：多实例间缓存不共享，A 实例缓存命中但 B 实例未命中可能误判
- ⚠️ 风险：进程重启后缓存丢失，重启期间的重试请求会打到 DB
- ⚠️ 风险：缓存与 DB 不一致时（如 DB 更新成功但缓存写入失败），可能放过重复请求

**正确用法**：本地缓存只能作为"加速层"，DB 幂等表仍是权威。本地缓存未命中时必须查 DB。

**方案三：异步落库**

同步路径只写 Redis（短期），异步将幂等记录批量落 DB。

- ✅ 同步路径快
- ❌ 风险极大：Redis 丢失 + DB 未落库 = 完全无幂等
- ❌ 不适合资金场景

**资金场景的改进**：同步路径**必须**先落 DB（短期），再异步更新详细字段。但不能完全异步化。

**方案四：热点账户优化**

针对"双11爆款秒杀"等单点热点支付单：
- 业务侧前置限流（Sentinel）控制单点击穿
- 热点 Key 走独立分片，避免影响其他订单
- 本地缓存 + Redis 双层过滤

**优化组合后的架构**：

```
请求 → 本地缓存（Caffeine，5分钟）
       ↓ 未命中
     Redis（SETNX，30分钟）
       ↓ 未命中
     DB 幂等表（分库分表，永久）
       ↓ 唯一索引拦截
     业务执行
```

**新增风险汇总**：

| 优化 | 新风险 | 缓解措施 |
|---|---|---|
| 分库分表 | 跨片查询、分片键设计 | 严格分片键规范、运维工具支持 |
| 本地缓存 | 多实例不一致、重启丢失 | 仅作加速层、DB 权威兜底 |
| 异步落库 | 数据丢失 | 资金场景禁止，仅用于日志类 |
| 热点优化 | 限流误杀正常请求 | 精细化限流策略、白名单 |

**架构师原则**：资金场景的幂等优化"宁慢勿错"，宁可性能差一点也不能牺牲可靠性。优化的优先级是：**先分库分表水平扩展，再用本地缓存过滤**，绝不用异步落库。

#### 4. 跨服务分布式幂等与 TCC/Saga 实战

**端到端 vs 每跳独立幂等键**：

| 策略 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **端到端一个键** | 业务方生成 key，全链路透传 | 简单、易追溯 | 服务边界不清，下游无法独立判断 |
| **每跳独立键** | 每个服务用自己的 key | 服务自治、职责清晰 | 链路追溯复杂、键管理成本高 |

**实际推荐：分层混合策略**

```
业务方 → 支付网关：用业务方 key（biz_order_no + biz_system_id）
支付网关 → 订单中心：用网关 key（pay_order_no，由网关生成）
订单中心 → 渠道：用 out_trade_no（= pay_order_no 透传）
渠道 → 网关回调：用 channel_no（渠道生成）
网关 → MQ → 订单中心：用 channel_no 透传
```

**关键原则**：

1. **跨进程边界时换 key**：进入新的"执行单元"时生成自己的幂等键
2. **同进程内不换 key**：避免无意义的键转换
3. **键的"血缘"可追溯**：每个 key 落库时记录上游 key（如 `parent_idempotent_key` 字段）
4. **回调链路用渠道 key**：渠道回调的权威性最高，必须用 channel_no 作为幂等键

**Saga 长事务的幂等补偿**：

Saga 模式：每个子事务有对应的补偿事务，失败时反向补偿。

```
T1（创建订单）→ T2（扣库存）→ T3（扣款）→ T4（发通知）
   ↓ 失败
C4（不发通知）← C3（退款）← C2（回库存）← C1（取消订单）
```

**幂等要求**：
- 每个正向事务 T_i 必须幂等（重试不重复执行）
- 每个补偿事务 C_i 必须幂等（重试不重复补偿）
- 补偿必须可重入（即使正向未成功也能补偿）

**Saga 幂等键设计**：

```
正向 T_i 幂等键 = saga_id + step_i
补偿 C_i 幂等键 = saga_id + step_i + "_compensate"
```

**关键陷阱**：
- 补偿执行前必须查询正向事务是否成功，未成功则跳过补偿
- 补偿与正向可能并发执行（重试时），必须用状态机控制

**TCC 的 Try/Confirm/Cancel 幂等（蛋壳钱包实战）**：

TCC 模式：Try（资源预留）→ Confirm（确认提交）→ Cancel（释放预留）。

```
Try：冻结账户余额（预扣）
  ↓
Confirm：扣减冻结金额，实际扣账
  ↓ 或
Cancel：解冻，恢复可用余额
```

**TCC 幂等键设计**：

| 阶段 | 幂等键 | 谁生成 | 防什么 |
|---|---|---|---|
| Try | `tcc_tx_id + account_id`（事务ID+账户） | TCC 协调器 | 防重复冻结 |
| Confirm | `tcc_tx_id + account_id` | TCC 协调器 | 防重复扣账 |
| Cancel | `tcc_tx_id + account_id` | TCC 协调器 | 防重复解冻 |

**TCC 状态机**：

```
INIT → TRYING → TRIED → CONFIRMED
                ↓
              CANCELLED
```

**关键防护**：

1. **Try 必须幂等**：TCC 协调器可能重试 Try，账户侧用 `tcc_tx_id` 作为幂等键，已 Try 过的直接返回成功
2. **Confirm 必须幂等**：协调器可能重试 Confirm，已 Confirm 过的直接返回成功
3. **Cancel 必须幂等**：协调器可能重试 Cancel
4. **空回滚防护**：Try 未执行但 Cancel 到达时，必须先记录"空 Cancel"标记，Cancel 时检查 Try 是否执行过
5. **悬挂防护**：Cancel 先于 Try 到达时，Try 必须拒绝（检查 Cancel 是否已到达）

**蛋壳钱包 TCC 实战要点**：

```sql
CREATE TABLE tcc_record (
    tcc_tx_id       VARCHAR(64) NOT NULL,
    account_id      VARCHAR(32) NOT NULL,
    branch_id       VARCHAR(64) NOT NULL,         -- 分支事务ID
    status          TINYINT NOT NULL,             -- 0-INIT 1-TRYING 2-TRIED 3-CONFIRMED 4-CANCELLED
    try_amount      DECIMAL(18,2),
    confirm_amount  DECIMAL(18,2),
    cancel_amount   DECIMAL(18,2),
    PRIMARY KEY (tcc_tx_id, account_id, branch_id)
);

-- 账户表增加冻结字段
ALTER TABLE account ADD COLUMN frozen_amount DECIMAL(18,2) DEFAULT 0;
```

**Try 逻辑（幂等）**：

```java
@Transactional
public void tryDeduct(String tccTxId, String accountId, BigDecimal amount) {
    // 1. 幂等校验
    TccRecord r = tccRecordDao.get(tccTxId, accountId);
    if (r != null && r.getStatus() >= TRYING) {
        return;  // 已 Try 过，幂等返回
    }
    
    // 2. 空回滚防护：检查 Cancel 是否已到达
    if (r != null && r.getStatus() == CANCELLED) {
        throw new SuspendedTryException("Cancel already arrived, Try rejected");
    }
    
    // 3. 执行冻结
    int affected = accountDao.freeze(accountId, amount);
    if (affected == 0) throw new InsufficientBalanceException();
    
    // 4. 记录 TCC 状态
    if (r == null) {
        tccRecordDao.insert(new TccRecord(tccTxId, accountId, TRYING, amount, ...));
    } else {
        tccRecordDao.updateStatus(tccTxId, accountId, INIT, TRYING);
    }
}
```

**Confirm 逻辑（幂等）**：

```java
@Transactional
public void confirmDeduct(String tccTxId, String accountId) {
    TccRecord r = tccRecordDao.getForUpdate(tccTxId, accountId);  // 行锁
    if (r.getStatus() == CONFIRMED) return;  // 幂等返回
    
    if (r.getStatus() != TRIED) throw new IllegalStateException();
    
    // 扣减冻结金额，实际扣账
    accountDao.confirmDeduct(accountId, r.getTryAmount());
    tccRecordDao.updateStatus(tccTxId, accountId, TRIED, CONFIRMED);
}
```

**Cancel 逻辑（幂等 + 空回滚）**：

```java
@Transactional
public void cancelDeduct(String tccTxId, String accountId) {
    TccRecord r = tccRecordDao.getForUpdate(tccTxId, accountId);
    
    // 空回滚：Try 未执行
    if (r == null || r.getStatus() == INIT) {
        if (r == null) {
            tccRecordDao.insert(new TccRecord(tccTxId, accountId, CANCELLED, ...));
        } else {
            tccRecordDao.updateStatus(tccTxId, accountId, INIT, CANCELLED);
        }
        return;  // 空回滚
    }
    
    if (r.getStatus() == CANCELLED) return;  // 幂等返回
    if (r.getStatus() == CONFIRMED) throw new IllegalStateException("已 Confirm 不可 Cancel");
    
    // 解冻
    accountDao.unfreeze(accountId, r.getTryAmount());
    tccRecordDao.updateStatus(tccTxId, accountId, TRIED, CANCELLED);
}
```

**TCC vs Saga 幂等对比**：

| 维度 | TCC | Saga |
|---|---|---|
| 一致性 | 强一致（资源预留） | 最终一致（补偿） |
| 幂等键 | tcc_tx_id + account_id | saga_id + step |
| 隔离性 | Try 阶段冻结资源，可见 | 无隔离，中间状态可见 |
| 补偿 | Cancel（解冻） | 反向事务（退款/回库存） |
| 复杂度 | 高（需改业务，加冻结字段） | 中（补偿事务） |
| 适用场景 | 资金扣减、库存扣减 | 长流程业务编排 |

**架构师总结**：

- **跨服务幂等**：分层混合策略，跨进程边界换 key，全链路可追溯
- **TCC 幂等**：三阶段必须各自幂等，必须处理空回滚与悬挂
- **Saga 幂等**：正向与补偿各自幂等，补偿可重入
- **资金场景优先 TCC**：隔离性强，资损风险低；非资金场景用 Saga

---

## 与架构师水平的差距自评（作答后填写）

> 知识点掌握：四种幂等方案的边界能讲清，但 TCC 空回滚、悬挂防护的工程实现细节（如 tcc_record 表设计、行锁粒度）此前只停留在概念层，未落实到代码级。
>
> 架构思维：纵深防御思路清晰（客户端→幂等表→状态机→对账），但"为什么是这四道、不是三道或五道"的演进逻辑（每道防线对应的失效场景）需要更多实战案例支撑。
>
> 工程细节：补单流程的多状态校验（业务订单/退款/账务/渠道当前状态）能讲，但实际工程中"补单事务"的隔离级别、锁粒度、与对账系统的并发协调不够清晰。
>
> 业务理解：贴合蛋壳钱包 TCC、e卡资金路由背景，但保险、问诊场景的幂等差异（如保险分期多笔扣款、问诊按次结算）需要补充。
>
> 补足方向：
> 1. 深读 Seata TCC 模式源码，理解 tcc_fence 表的空回滚与悬挂防护实现
> 2. 实践一个简化版支付幂等组件（含 Redis+DB 双层、状态机、对账兜底），代码级掌握
> 3. 补充金融监管对幂等的要求（如重复扣款的客诉处理流程、监管报送）
> 4. 学习支付路由的幂等设计（如同笔业务订单切换渠道时的幂等键处理）