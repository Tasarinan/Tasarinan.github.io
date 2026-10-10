# 架构师学习-Day03-支付对账与差错处理

> 日期：2026年07月01日（周三）
> 周主题：支付系统架构设计
> 出题日：Day03 - 对账与差错处理

---

## 背景

Day01 落地的状态机把"PROCESSING→SUCCESS/FAILED"的竞争交给了幂等（Day02），但幂等只能保证"同一笔请求不重复处理"，解决不了"渠道实际扣了款但本地订单仍 PROCESSING"、"渠道回调丢失导致长单"、"渠道多扣少扣"、"退款已发起但渠道侧未执行"这类**资金侧与业务侧状态偏离**的问题。兜底机制只有一道——**对账**。

对账是支付系统的"会计"，不是可选项而是监管硬要求（央行《非银行支付机构网络支付业务管理办法》要求 T+1 完成对账，差错最长 T+2 处理完）。蛋壳钱包、e卡资金路由、保险商城保费收缴、问诊充值任何一条业务线，只要资金过路就必须对账。本日聚焦于"对账数据流、差错类型与处置、长单与挂账"，把幂等留下的"少数派"异常闭环掉。

对账与 Day02 幂等一脉相承：幂等键是对账键的基础（渠道流水号 `channel_no` 既是回调幂等键，也是对账勾对键），补单流程的"四校验"必须建立在对账识别的差异单之上。

---

## 题目一（架构设计题）：对账系统整体架构与数据流设计

### 作答区

#### 1. 数据来源与三端星型勾对模型

**对账数据来源（三端）**：

| # | 数据源 | 来源系统 | 数据内容 | 获取方式 |
|---|---|---|---|---|
| 1 | 业务订单数据 | 业务系统（电商/保险/问诊/e卡） | biz_order_no、pay_order_no、biz_status | 离线 T-1 全量 + 增量 binlog |
| 2 | 支付订单数据 | 支付订单中心 | pay_order_no、channel_no、amount、status、callback_time | DB 全量拉取（T-1 快照） |
| 3 | 渠道账单数据 | 微信/支付宝/银联/e卡内部账 | out_trade_no、channel_no、trade_time、amount、trade_status | T+1 对账文件下载（SFTP/开放平台） |
| 4 | 账务流水 | 账务系统 | pay_order_no、account_id、direction、amount | DB 全量 + 凭证号 |
| 5 | 退款流水 | 退款中心 | refund_no、pay_order_no、refund_amount、refund_status | DB 全量 |

**三端勾对的核心：以"支付订单"为中心的星型模型**

```
            业务订单
               │
               │ biz_order_no → pay_order_no（一对多）
               ▼
        ┌──────────────┐
        │  支付订单    │ ◄── 对账中心
        │ pay_order_no │
        └──────────────┘
               │
               ├──► 渠道账单（out_trade_no = pay_order_no）
               │
               ├──► 账务流水（pay_order_no）
               │
               └──► 退款流水（pay_order_no）
```

**为什么不直接"两两对"，而要星型勾对？**

这是对账设计的核心架构选择。两两对账（业务↔渠道、业务↔账务、渠道↔账务）有三大致命问题：

**① 对账关系爆炸**

N 个端两两对账需要 C(N,2) 次比对。5 个数据源 = 10 次勾对，每加一个端就指数级膨胀。星型模型只需要 N-1 = 4 次勾对。

**② 差错定位困难**

业务订单有 100 元、渠道账单有 100 元、账务只记了 99 元——两两对账会发现"业务↔渠道平、业务↔账务差、渠道↔账务差"，三个对账结果相互矛盾，定位不到"账务漏记 1 元"这一根因。星型模型直接定位"支付订单 100 元 vs 账务 99 元 = 账务短记"。

**③ 业务订单与渠道账单语义不对齐**

业务订单是"业务方视角"（订单金额、优惠后金额），渠道账单是"渠道视角"（实扣金额、手续费后金额），两者天然有差异（优惠券、积分抵扣、手续费）。强行两两对账会产生大量"伪差错"。星型模型通过"支付订单"作为语义转换层：

- 业务订单 ↔ 支付订单：业务语义对齐（应支付 vs 实发起）
- 支付订单 ↔ 渠道账单：资金语义对齐（发起金额 vs 渠道实扣）
- 支付订单 ↔ 账务流水：账务语义对齐（应记 vs 实记）

**支付订单是全链路的"语义锚点"**，因为它持有所有外部键（biz_order_no、pay_order_no、out_trade_no、channel_no），是唯一能跨系统关联的实体。

**星型勾对的具体勾对键**：

| 勾对关系 | 勾对键 | 勾对粒度 | 容忍度 |
|---|---|---|---|
| 业务订单 ↔ 支付订单 | biz_order_no + biz_system_id | 订单级 + 金额级 | 0 容忍 |
| 支付订单 ↔ 渠道账单 | out_trade_no（= pay_order_no） | 订单级 + 金额级 + 状态级 | 0 容忍 |
| 支付订单 ↔ 账务流水 | pay_order_no + direction | 订单级 + 金额级 | 0 容忍 |
| 支付订单 ↔ 退款流水 | pay_order_no | 订单级 + 累计金额 | 0 容忍 |

#### 2. 渠道对账文件适配器框架

**渠道账单的差异维度**：

| 维度 | 微信 | 支付宝 | 银联 | e卡内部账 |
|---|---|---|---|---|
| 文件格式 | CSV | TXT（| 分隔） | 定长报文 | DB 直查 |
| 下发时间 | T+1 08:00 | T+1 06:00 | T+1 14:00 | 实时 |
| 获取方式 | SFTP | 开放平台 HTTP | SFTP | JDBC |
| 编码 | UTF-8 | GBK | GBK | - |
| 字段顺序 | 商户号→订单号→金额→状态→时间 | 业务流水→商户订单→金额→状态 | 32 字节定长头 + 变长 body | - |
| 状态枚举 | SUCCESS/REFUND/REVOKED | TRADE_SUCCESS/TRADE_CLOSED | 00/01/02/03 | 1/2/3 |
| 金额单位 | 分 | 元（字符串） | 分 | 元（DECIMAL） |
| 时区 | Asia/Shanghai | Asia/Shanghai | Asia/Shanghai | Asia/Shanghai |
| 文件签名 | MD5 | RSA2 | 无 | - |

**适配器框架设计**（SPI + 模板方法）：

```java
// 1. SPI 接口：每个渠道实现一个
public interface ChannelReconciliationAdapter {
    String channelId();                              // 渠道标识：WECHAT/ALIPAY/UNIONPAY
    FileFetchResult fetchFile(LocalDate reconDate);  // 获取原始文件
    List<ChannelBillItem> parse(InputStream raw);    // 解析为统一模型
    BigDecimal normalizeAmount(String raw);          // 金额归一化（分→元）
    ReconStatus normalizeStatus(String raw);         // 状态归一化
    DateTime parseTradeTime(String raw);             // 时间归一化
    boolean verifySignature(File file);              // 签名校验
}

// 2. 模板方法：主流程固定
public abstract class AbstractReconTemplate {
    public final ReconciliationResult reconcile(LocalDate date, String channelId) {
        ChannelReconciliationAdapter adapter = adapterFactory.get(channelId);
        FileFetchResult file = retryFetch(adapter, date, 3);  // 文件晚到重试
        if (!adapter.verifySignature(file)) throw new SignInvalidException();
        List<ChannelBillItem> bills = adapter.parse(file.getInputStream());
        List<PayOrder> localOrders = payOrderRepo.findReconOrders(date, channelId);
        return reconciler.match(localOrders, bills);
    }
}

// 3. 主流程注册：Spring SPI 自动发现
@Service
public class ReconciliationOrchestrator {
    private Map<String, ChannelReconciliationAdapter> adapters;  // @Autowired Map<String,Adapter>

    public void runDailyRecon(LocalDate date) {
        for (String channelId : enabledChannels()) {
            try {
                AbstractReconTemplate template = templates.get(channelId);
                ReconciliationResult result = template.reconcile(date, channelId);
                discrepancyHandler.handle(result);
            } catch (Exception e) {
                alarmService.fire("对账失败:" + channelId, e);
                reconRetryScheduler.schedule(date, channelId, delay(1, HOURS));
            }
        }
    }
}
```

**新增渠道的扩展点**：只需实现 `ChannelReconciliationAdapter` 接口 + 注册到 SPI，主流程零改动。这是开闭原则在对账场景的典型落地。

**文件晚到的处理**：

```
预定时间触发 → 拉取失败（文件未到）→ 进入等待队列
→ 每隔 30 分钟重试，最多 8 次（覆盖 4 小时晚到窗口）
→ 8 次仍失败 → 告警 + 转人工 + 次日 T+2 补对
```

**关键陷阱**：

- **时区错配**：银联账单用 UTC 时间戳，本地订单用 Asia/Shanghai。解析时必须显式指定时区，否则跨日对账全错。
- **金额单位错配**：微信是"分"（整数），支付宝是"元"（字符串，可能有逗号千分位）。归一化必须先到最小单位（分），再比对。
- **字段顺序变更**：渠道升级 API 后字段顺序可能变。必须用版本号（file_version）路由不同 parser，不能写死字段下标。

#### 3. 对账粒度与跨日对账

**三种对账粒度对比**：

| 粒度 | 比对内容 | 适用场景 | 缺点 |
|---|---|---|---|
| **订单级** | 只比对订单号是否存在 | 闭环检查、漏单检查 | 不能发现金额差错 |
| **金额级** | 订单号 + 金额 | 资金对账核心 | 不能发现状态差错（已退款的订单金额仍匹配） |
| **明细级** | 订单号 + 金额 + 状态 + 时间 + 币种 | 资金安全场景、退款场景 | 性能开销大、伪差错多 |

**实战组合**：日常跑批用"订单级 + 金额级"，差错深挖时下钻"明细级"。

```sql
-- 订单级：找出长单与短单
SELECT a.pay_order_no 
FROM local_orders a 
LEFT JOIN channel_bills b ON a.out_trade_no = b.out_trade_no 
WHERE b.out_trade_no IS NULL AND a.status = 'SUCCESS';  -- 长单

-- 金额级：找出金额差异
SELECT a.pay_order_no, a.amount AS local, b.amount AS channel, 
       a.amount - b.amount AS diff
FROM local_orders a 
JOIN channel_bills b ON a.out_trade_no = b.out_trade_no 
WHERE a.amount <> b.amount;

-- 状态级：找出状态差异
SELECT a.pay_order_no, a.status AS local_status, b.status AS channel_status
FROM local_orders a 
JOIN channel_bills b ON a.out_trade_no = b.out_trade_no 
WHERE a.status <> b.status;
```

**跨日对账的处理**：

跨日订单（23:50 下单、00:10 回调）是对账的经典难题。核心原则：**以"渠道账单时点"为准，本地订单做时间窗对齐**。

**方案一：双窗口对齐（推荐）**

```
T 日对账范围 = 渠道账单 T 日 00:00~24:00 的所有交易
              ∩ 本地订单 created_at ∈ [T-1 23:00, T+1 01:00]
              （扩展 2 小时窗口，覆盖跨日回调）
```

渠道账单的 trade_time 是"渠道实际扣款时间"，本地订单的 created_at 是"订单创建时间"，两者本来就有偏差。双窗口对齐保证跨日订单不会被遗漏或重复对账。

**方案二：以渠道账单为锚点**

```
对账中心遍历渠道账单 T 日每条记录：
  - 用 out_trade_no 反查本地订单（不管本地 created_at 是哪天）
  - 找到 → 勾对
  - 找不到 → 短单（差错）
```

这种方法简单但有个陷阱：本地订单可能在 T-1 创建但 T+1 才回调成功，如果 T 日对账时本地状态仍是 PROCESSING，会被误判为"状态不符"。**正确做法**：对账时先做"状态补偿"（调渠道查询接口把本地 PROCESSING 订单的实际状态补齐），再勾对。

**跨日订单的"对账键去重"**：

一笔订单可能出现在 T 日和 T+1 两个渠道账单里（T 日创建、T+1 结算）。必须用 `(out_trade_no, trade_date)` 复合键去重，且记录"已对账日期"，避免一笔订单被对账两次。

```sql
ALTER TABLE pay_order ADD COLUMN reconciled_date DATE;
ALTER TABLE pay_order ADD UNIQUE KEY uk_out_trade_recon (out_trade_no, reconciled_date);
```

#### 4. 调度与补偿机制

**调度架构**：

```
┌─────────────────────────────────────┐
│  调度中心 (XXL-Job / ElasticJob)     │
│  - 每日 02:00 触发 T-1 对账          │
│  - 每日 04:00 触发差错处置           │
│  - 每小时触发"挂账超时检查"          │
└─────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────┐
│  对账执行器                          │
│  - 按渠道并行（4 个渠道 = 4 个分片） │
│  - 单渠道内按 out_trade_no 分桶并行 │
└─────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────┐
│  差错处理器                          │
│  - 自动处置（80% 差错）              │
│  - 人工介入（20% 差错，资损类）      │
└─────────────────────────────────────┘
```

**渠道账单晚到的处理**：

```java
// 文件获取重试策略
@Retryable(
    value = FileNotReadyException.class,
    maxAttempts = 8,
    backoff = @Backoff(delay = 30 * 60 * 1000)  // 30 分钟
)
public File fetchBill(LocalDate date, String channelId) {
    return channelAdapter.fetchFile(date);
}

// 8 次重试仍失败 → 降级为"渠道开放平台 API 单笔查询"
@Recover
public File fallbackFetch(FileNotReadyException e, LocalDate date, String channelId) {
    log.warn("账单晚到，降级为 API 查询: {} {}", date, channelId);
    List<PayOrder> pendingOrders = payOrderRepo.findSuccessOrders(date, channelId);
    return apiQueryService.batchQuery(pendingOrders, channelId);
}
```

**对账跑批失败的恢复**：

对账必须**幂等可重跑**——同一天的对账跑 N 次，结果必须一致。这是通过对账记录表实现的：

```sql
CREATE TABLE recon_record (
    id              BIGINT PRIMARY KEY,
    recon_date      DATE NOT NULL,
    channel_id      VARCHAR(32) NOT NULL,
    pay_order_no    VARCHAR(64) NOT NULL,
    recon_status    TINYINT NOT NULL,        -- 0-平 1-长单 2-短单 3-金额差 4-状态差
    handle_status   TINYINT NOT NULL,        -- 0-未处理 1-已自动处理 2-已人工处理
    UNIQUE KEY uk_recon (recon_date, channel_id, pay_order_no)  -- 防重复对账
);
```

重跑时用 `INSERT IGNORE` 或 `ON DUPLICATE KEY UPDATE` 保证一笔订单一天只对账一次：

```sql
INSERT IGNORE INTO recon_record (recon_date, channel_id, pay_order_no, recon_status, handle_status)
VALUES (?, ?, ?, ?, 0);
```

**"一笔订单最多被对账一次"的三重保障**：

1. **DB 唯一索引**：`uk_recon (recon_date, channel_id, pay_order_no)` 数据库层兜底
2. **对账前查询**：对账执行器查询 `recon_record`，已对账的跳过
3. **渠道账单去重**：解析渠道账单时按 out_trade_no 去重（防止渠道账单自身有重复行）

**对账失败的补偿策略**：

| 失败类型 | 处理策略 |
|---|---|
| 渠道文件未到 | 30 分钟重试 × 8 次，仍失败则 T+2 补对 |
| 解析失败 | 告警 + 人工介入，原始文件归档供排查 |
| DB 异常 | 重试 3 次，仍失败则整体回滚 + 告警 |
| 差错处理失败 | 自动挂账 + 人工处理工单 |

---

## 题目二（场景实战题）：差错类型与挂账处置

### 作答区

#### 1. 长单（平台有单、渠道无单）

**判定条件**：

```
本地支付订单 status = SUCCESS 
且 渠道账单 T 日无对应 out_trade_no 记录
且 本地订单 SUCCESS 时间 ≤ T-1 23:59:59（排除当日才成功，账单未结算的正常情况）
```

**根因分析（5 类）**：

| # | 根因 | 判定方法 | 占比（经验） |
|---|---|---|---|
| 1 | 渠道账单未结算（结算延迟） | 调渠道查询接口，渠道返回 SUCCESS | 50% |
| 2 | 渠道账单错位（跨日结算，账单落到 T+1） | 检查 T+1 账单是否有该订单 | 20% |
| 3 | 本地订单误置 SUCCESS（回调错误） | 调渠道查询，渠道返回 FAILED/NOT_FOUND | 15% |
| 4 | out_trade_no 错配（下单时传错） | 检查渠道查询返回的实际单号 | 10% |
| 5 | 渠道侧真的没扣款（异步下单未完成） | 调渠道查询，返回 NOT_FOUND | 5% |

**区分"渠道还没结账"和"渠道真的没这笔"**：

**核心动作：调渠道查询接口二次确认**——这是处理长单的第一步，绝不能直接挂账。

```java
public void handleLongOrder(PayOrder order) {
    // 1. 调渠道查询接口（不能只看账单，账单可能晚到）
    ChannelQueryResult result = channelService.query(order.getOutTradeNo(), order.getChannelId());
    
    switch (result.getStatus()) {
        case SUCCESS:
            // 渠道实际已扣款，账单未结算 → 等待 T+1 补对账
            tagAsPendingRecon(order, "渠道已扣款，账单未结算");
            break;
        case FAILED:
        case NOT_FOUND:
            // 渠道真的没扣到钱 → 本地订单误置 SUCCESS，需冲正
            handleFalseSuccess(order);
            break;
        case PROCESSING:
            // 渠道仍在处理 → 等待 24 小时再查
            scheduleRecheck(order, 24, HOURS);
            break;
    }
}
```

**处置流程与 SLA**：

```
T+1 08:00  对账识别长单
T+1 08:30  调渠道查询二次确认
           ├─ 渠道 SUCCESS → 标记"待 T+1 补对账"
           └─ 渠道 FAILED/NOT_FOUND → 进入"误置 SUCCESS 处置"

T+1 12:00  误置 SUCCESS 处置：
           - 冲正账务（已记的借记冲销）
           - 撤销业务订单发货（如已发货则触发"货款追回"工单）
           - 通知业务方"该笔支付实际失败"
           - 客服介入联系用户补付款

T+2 12:00  仍未结账 → 挂账"长单挂账"账户，提交财务复核
T+7 12:00  仍未结账 → 上报风控，启动"渠道对账争议处理流程"
T+30 12:00 仍未结账 → 监管报告（央行要求 30 天未解的差错需上报）
```

**误置 SUCCESS 的冲正事务**：

```sql
BEGIN;
  -- 1. 锁定支付订单
  SELECT * FROM pay_order WHERE pay_order_no = ? FOR UPDATE;
  
  -- 2. 校验仍是 SUCCESS（防止并发已处理）
  IF status != 'SUCCESS' ROLLBACK;
  
  -- 3. 检查是否已退款（避免双重退）
  IF EXISTS (SELECT 1 FROM refund_order WHERE pay_order_no = ? AND status = 'SUCCESS') ROLLBACK;
  
  -- 4. 更新状态为 CLOSED（不能直接改 FAILED，要留审计痕迹）
  UPDATE pay_order SET status = 'CLOSED', close_reason = 'CHANNEL_NOT_FOUND' 
  WHERE pay_order_no = ?;
  
  -- 5. 冲正账务（同笔支付记账的反向账）
  INSERT INTO account_entry (pay_order_no, direction, amount, ...) 
  VALUES (?, 'CREDIT', ?, ...);  -- 原借记则冲正为贷记
  
  -- 6. 记录差错处置日志
  INSERT INTO discrepancy_handle_log (...) VALUES (...);
COMMIT;
```

#### 2. 短单（渠道有单、平台无单）

**判定条件**：

```
渠道账单 T 日有扣款记录
且 本地支付订单不存在对应 out_trade_no
（或本地存在但 status 为 INIT/CLOSED，渠道却已扣款）
```

**这是资损信号最强烈的差错类型**——渠道真金白银扣了钱，但平台不知道这单的存在。可能造成：
- 用户被扣款但订单不发货 → 客诉
- 平台少记收入 → 财务数据失真
- 退款无门 → 资金沉淀在渠道账户变成"无主资金"

**根因定位**：

| 根因 | 判定方法 | 处置 |
|---|---|---|
| 本地漏单（下单接口异常但渠道已扣款） | 检查下单接口日志 | 补建本地订单 |
| out_trade_no 错配（用了错误的单号下单） | 比对下单日志与渠道账单 | 补单并修正单号映射 |
| 渠道多扣（渠道侧 BUG 或攻击） | 调渠道查询，核对业务订单 | 渠道侧差错，提争议工单 |
| 历史订单重新扣款（回调重发触发了二次扣款） | 检查同 out_trade_no 是否有多笔渠道记录 | 退款并修复回调逻辑 |
| 跨系统串单（A 业务的订单号撞到 B 业务的渠道） | 检查 biz_system_id 与 out_trade_no 的归属 | 数据修复 + 单号生成规则升级 |

**为什么不能直接"补单了事"？**

直接补单（在本地建一个 SUCCESS 订单）看似简单，但有四大风险：

| 风险 | 描述 | 正确做法 |
|---|---|---|
| **资金来源不明** | 不知道这笔钱对应哪个业务订单，可能是攻击者构造的虚假扣款 | 必须先调渠道查询拿到原始下单参数（业务订单号、下单时间、用户ID），与本地业务系统核对 |
| **业务订单状态错乱** | 业务订单可能已关单/已退款，补单会让已关单变成已支付 | 补单前校验业务订单状态，已关单的拒绝补单，转退款流程 |
| **冲账困难** | 直接补 SUCCESS 后，账务要补记一笔借记；但若后续发现是渠道多扣要退款，反向账如何记？ | 先挂账"待处理短单"科目，根因明确后再决定补单 or 退款 |
| **审计盲区** | 直接补单看不出"原本就缺失" vs "补出来的"，监管检查时无法追溯 | 必须走"差错处置流程"，记录从识别到处置的全链路日志 |

**正确的短单处置流程**：

```
1. 调渠道查询 → 拿到原始下单参数（业务订单号、用户、金额、时间）
2. 与本地业务系统核对：
   ├─ 业务订单存在且未支付 → 补建支付订单 + 补记账务 + 触发业务通知
   ├─ 业务订单已关单 → 退款流程，钱退回用户
   ├─ 业务订单已支付（其他支付单）→ 退款流程，钱退回用户
   └─ 业务订单不存在 → 挂账"无主资金" + 客服介入联系用户
3. 全程审计日志，挂账账户记录资金去向
4. 7 日内未解决 → 上报风控
```

#### 3. 金额不符

**金额差异的典型场景**：

| # | 场景 | 差异方向 | 根因 |
|---|---|---|---|
| 1 | 手续费扣减 | 本地 > 渠道 | 渠道已扣手续费，本地记的是订单原金额 |
| 2 | 优惠抵扣 | 本地 &lt; 渠道 | 业务订单有优惠券，但渠道按原价扣款 |
| 3 | 汇率换算 | 本地 ≠ 渠道 | 跨境支付，本地用下单时汇率，渠道用结算时汇率 |
| 4 | 退款部分冲抵 | 本地 ≠ 渠道 | 同笔订单有部分退款，渠道账单是净值 |
| 5 | 渠道多扣/少扣 | 本地 ≠ 渠道 | 渠道 BUG 或风控限额 |
| 6 | 分账场景 | 本地 ≠ 渠道 | 平台抽佣、商户分账，渠道账单是总分拆分 |

**分账场景的对账设计**：

分账是金额差异的高发场景。比如蛋壳钱包抽佣 0.6 元、商户实收 99.4 元，本地账务记两笔（平台 0.6、商户 99.4），渠道账单可能记两行（总分拆），也可能记一行（仅总分）。

**分账对账的字段设计**：

```sql
CREATE TABLE pay_order_split (
    id              BIGINT PRIMARY KEY,
    pay_order_no    VARCHAR(64) NOT NULL,
    split_account   VARCHAR(64) NOT NULL,        -- 分账接收方
    split_amount    DECIMAL(18,2) NOT NULL,
    split_type      VARCHAR(16) NOT NULL,        -- PLATFORM_FEE/MERCHANT/REFUND_RESERVE
    UNIQUE KEY uk_pay_split (pay_order_no, split_account)
);

-- 对账时聚合为总分
SELECT pay_order_no, SUM(split_amount) AS total_split
FROM pay_order_split 
WHERE pay_order_no = ?
GROUP BY pay_order_no;
-- total_split 应该 = pay_order.amount
```

**分账对账的双层勾对**：

```
第一层：总额勾对
本地 pay_order.amount = 渠道账单 total_amount

第二层：分账明细勾对
本地 pay_order_split.split_amount = 渠道分账明细.split_amount（逐笔）
```

如果渠道账单只给总额（不分明细），分账场景对账会丢失第二层，需要调"渠道分账查询接口"补齐明细。

**零头差（≤0.01 元）的处置**：

零头差通常来自浮点精度问题或四舍五入规则差异。常见来源：

- 手续费率计算（如 0.6% × 99.99 = 0.59994 元，四舍五入到 0.60 还是截断到 0.59？）
- 汇率换算（小数位精度差异）
- 跨币种结算

**处置策略**：

| 差异金额 | 处置 |
|---|---|
| ≤ 0.01 元 | 自动平账，记入"零头差异"科目（不要挂账，否则差错单爆炸） |
| 0.01 ~ 1 元 | 挂账，每笔单独处置 |
| > 1 元 | 立即告警，人工介入 |

**自动平账的会计处理**：

```sql
-- 零头差异走"营业外收支"科目，不挂账
INSERT INTO account_entry (pay_order_no, account_code, direction, amount, memo)
VALUES (?, '6603_MISCELLANEOUS', 'DEBIT', ?, '零头差异自动平账');
```

**关键原则**：零头平账只入"营业外收支"科目，**绝不入"应收/应付"科目**，否则会污染往来账。

#### 4. 状态不符（最危险类）

**判定条件**：

```
本地订单 status 与渠道账单 status 不一致
最危险组合：
  - 本地 SUCCESS + 渠道 FAILED  → 平台发货了但渠道没扣到钱（资损）
  - 本地 FAILED + 渠道 SUCCESS  → 用户付了钱但平台没发货（客诉）
```

**根因**：

| 根因 | 描述 | 占比 |
|---|---|---|
| 回调丢失 | 渠道回调因网络/服务异常未到达本地 | 60% |
| 回调处理失败 | 回调到达但本地处理异常（DB 错、幂等错） | 25% |
| 状态机错乱 | 并发回调与查询补单冲突，状态被错误覆盖 | 10% |
| 渠道侧状态变更 | 渠道主动撤销订单（风控、用户撤回）但未通知 | 5% |

**状态偏差自动恢复机制**：

```
┌──────────────────────────────────────┐
│ 1. 对账识别状态差异                  │
│    本地 SUCCESS + 渠道 FAILED        │
└──────────────────────────────────────┘
            │
            ▼
┌──────────────────────────────────────┐
│ 2. 二次确认（调渠道查询接口）        │
│    不能只看账单（账单可能时点偏差）  │
└──────────────────────────────────────┘
            │
            ▼
┌──────────────────────────────────────┐
│ 3. 多状态校验（避免双重处理）        │
│    - 业务订单状态                    │
│    - 退款记录                        │
│    - 账务记录                        │
│    - 通知记录                        │
└──────────────────────────────────────┘
            │
            ▼
┌──────────────────────────────────────┐
│ 4. 状态恢复事务（幂等）              │
│    - UPDATE pay_order SET status=?   │
│    - 冲正账务                        │
│    - 撤销/补发业务通知               │
└──────────────────────────────────────┘
```

**扫描频率**：

| 场景 | 频率 | 原因 |
|---|---|---|
| PROCESSING 订单扫描 | 每 5 分钟 | 覆盖回调延迟的常见窗口（10-30 分钟） |
| SUCCESS 订单状态校验 | 每小时 | 防止渠道主动撤销未通知 |
| 跨日差异单深扫 | 每日 02:00 | 跑批深度核对 |
| 实时告警 | 实时 | 本地 SUCCESS + 渠道 FAILED 立即告警 |

**恢复动作的幂等设计**（结合 Day02）：

```java
public void recoverStatusMismatch(PayOrder order, ChannelStatus channelStatus) {
    // 1. 加幂等键（避免与对账跑批、定时任务、人工处理冲突）
    String idempotentKey = "STATUS_RECOVER#" + order.getPayOrderNo() + "#" + channelStatus;
    
    if (!idempotentService.claim(idempotentKey, "STATUS_RECOVER")) {
        log.info("已被其他线程处理，跳过");
        return;
    }
    
    // 2. 锁定支付订单
    try {
        PayOrder locked = payOrderRepo.selectForUpdate(order.getPayOrderNo());
        
        // 3. 多状态校验（防止并发场景下状态已被改变）
        if (locked.getStatus() != order.getStatus()) {
            log.info("状态已变更，跳过");
            return;
        }
        
        // 4. 业务订单校验
        BizOrder bizOrder = bizOrderRepo.findByPayOrderNo(order.getPayOrderNo());
        if (bizOrder.isShipped() && channelStatus == ChannelStatus.FAILED) {
            // 已发货但渠道实际未扣款 → 货款追回工单
            workflowService.startDebtCollection(order);
            return;
        }
        
        // 5. 退款校验
        if (refundService.hasRefund(order.getPayOrderNo())) {
            log.info("已存在退款，跳过状态恢复");
            return;
        }
        
        // 6. 状态恢复事务
        transactionTemplate.execute(status -> {
            // 更新支付订单状态
            payOrderRepo.updateStatus(order.getPayOrderNo(), 
                channelStatus == ChannelStatus.FAILED ? OrderStatus.CLOSED : OrderStatus.SUCCESS);
            
            // 冲正账务（如果是 SUCCESS→CLOSED）
            if (channelStatus == ChannelStatus.FAILED) {
                accountService.reverseEntry(order.getPayOrderNo());
            }
            
            // 记录审计
            auditService.logStatusRecovery(order, channelStatus);
            return null;
        });
        
        // 7. 异步通知业务方
        mqProducer.send("biz-notify", new StatusRecoveryEvent(order, channelStatus));
        
    } finally {
        idempotentService.release(idempotentKey);
    }
}
```

**状态恢复的 SLA**：

| 场景 | SLA | 处置 |
|---|---|---|
| 本地 SUCCESS + 渠道 FAILED | 30 分钟内确认，2 小时内冲正 | 资损风险，立即介入 |
| 本地 FAILED + 渠道 SUCCESS | 1 小时内确认，4 小时内补单或退款 | 客诉风险，立即介入 |
| 本地 PROCESSING + 渠道 SUCCESS | 5 分钟内补单 | 正常回调延迟，自动处理 |
| 本地 PROCESSING + 渠道 FAILED | 30 分钟内关单 | 正常回调延迟，自动处理 |

---

## 三、与 Day02 的衔接

Day02 落地的幂等键与对账键高度重叠——`channel_no` 既是渠道回调的幂等键，也是对账勾对的核心键。Day03 的"对账识别 → 二次查询 → 状态恢复"流程每一步都必须幂等（沿用 Day02 的幂等表 + 状态机模板），否则对账跑批与回调并发处理会冲突。

Day03 的"挂账账户"是 Day04 资金安全的核心组件——所有未决差错必须挂账到指定会计科目，资金侧的"应收/应付/无主资金"三类账户必须有清晰的资金归属与处置流程。

Day03 的"分账对账"是 Day05 退款分账的地基——退款分账的累计金额校验、按单拆分都建立在本日的分账对账模型之上。

---

## 与架构师水平的差距自评（作答后填写）

> **知识掌握**：对账的三端星型勾对、四类差错处置流程能讲清，但银联定长报文的解析细节、跨境对账的汇率换算规则、央行对账监管要求（T+1/T+2/30 天上报）此前只停留在概念层，未落实到规范文档。
>
> **架构思维**：星型 vs 两两对账的选型逻辑能讲，但"为什么是以支付订单为中心、不是以业务订单或渠道账单为中心"的演进逻辑（语义锚点、跨系统关联能力）需要更多实战案例支撑。适配器框架的扩展点设计（SPI + 模板方法）能讲，但实际项目中"新增渠道的接入 SOP"不够标准化。
>
> **工程细节**：补单事务的"四校验"和幂等抢占模板能讲，但对账跑批的"水平扩展方案"（按 out_trade_no 分桶并行、跨分片聚合）、对账系统的"故障演练"（账单文件损坏、渠道 API 降级）不够清晰。零头差异的会计处理（营业外收支 vs 应收应付）此前没认真区分过。
>
> **业务理解**：贴合蛋壳钱包、e卡资金路由、保险商城背景，但保险保费的"分期对账"（每期独立对账 vs 整单对账）、问诊的"按次结算对账"（服务次数与支付次数对齐）需要补充。监管报送的具体字段、频次、口径不够清楚。
>
> **补足方向**：
> 1. 深读央行《非银行支付机构网络支付业务管理办法》及实施细则，整理监管对对账的硬性要求清单
> 2. 实践一个简化版对账引擎（含适配器框架、差错处置、挂账科目），代码级掌握
> 3. 学习财务会计基础（借贷记账法、应收应付/营业外收支科目边界、科目余额与对账关系）
> 4. 补充分账场景的对账设计（微信分账、支付宝佣金抽成、银联分账），尤其是分账失败的补偿流程
> 5. 研究跨境支付对账的特殊性（汇率换算时点、跨境清算周期、外汇监管报送）