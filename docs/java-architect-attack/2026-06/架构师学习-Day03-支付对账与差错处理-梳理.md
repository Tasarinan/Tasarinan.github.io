# 架构师学习 Day03 梳理：支付对账与差错处理
> 架构师视角的提炼版｜适合复习与面试速记
>
> 周主题：支付系统架构设计

---

## 一、对账在支付系统中的定位

### 1.1 核心一句话

> **对账 = 用渠道账单做"外部真相"，把本地订单/账务/退款的状态和金额收敛到与渠道一致**

幂等解决"同一笔请求不重复处理"，对账解决"业务侧与资金侧的状态偏离"。前者是请求级去重，后者是状态级对齐。

### 1.2 对账的三大不可替代价值

| 价值 | 描述 |
|---|---|
| 资金兜底 | 渠道实际扣款但本地仍 PROCESSING / 渠道未扣但本地 SUCCESS — 幂等拦不住，只能对账兜底 |
| 监管合规 | 央行要求 T+1 完成对账、T+2 处置差错、30 天未解需上报 |
| 财务准确性 | 收入确认、应收应付、税务申报都依赖对账结果 |

### 1.3 对账 ≠ 简单比对

对账不是"两边数据相等"那么简单，必须解决：数据来源异构、跨日时差、语义差异（业务金额 vs 渠道实扣）、差错分类与处置。

---

## 二、三端星型勾对模型

### 2.1 星型模型（推荐）

```
            业务订单
               │
               │ biz_order_no → pay_order_no
               ▼
        ┌──────────────┐
        │  支付订单 ★  │ ◄── 对账中心（语义锚点）
        └──────────────┘
               │
               ├──► 渠道账单（out_trade_no）
               ├──► 账务流水（pay_order_no）
               └──► 退款流水（pay_order_no）
```

### 2.2 为什么星型而不是两两对账

| 问题 | 两两对账 | 星型对账 |
|---|---|---|
| 关系数 | C(N,2) 指数膨胀 | N-1 线性 |
| 差错定位 | 三方矛盾难定根因 | 单边差异直达根因 |
| 语义对齐 | 业务金额 vs 渠道实扣天然有差 | 通过支付订单做语义转换 |

### 2.3 支付订单是"语义锚点"

支付订单持有所有外部键（biz_order_no、pay_order_no、out_trade_no、channel_no），是唯一能跨系统关联的实体，所以星型以它为中心。

### 2.4 勾对键速记

| 勾对关系 | 勾对键 | 容忍度 |
|---|---|---|
| 业务↔支付 | biz_order_no + biz_system_id | 0 |
| 支付↔渠道 | out_trade_no | 0 |
| 支付↔账务 | pay_order_no + direction | 0 |
| 支付↔退款 | pay_order_no（累计金额） | 0 |

---

## 三、渠道对账文件适配器框架

### 3.1 渠道差异维度

| 维度 | 微信 | 支付宝 | 银联 | e卡 |
|---|---|---|---|---|
| 格式 | CSV | TXT(\|分隔) | 定长报文 | DB |
| 时间 | T+1 08:00 | T+1 06:00 | T+1 14:00 | 实时 |
| 获取 | SFTP | 开放平台 | SFTP | JDBC |
| 金额单位 | 分 | 元（字符串） | 分 | 元 |
| 状态枚举 | SUCCESS/REFUND | TRADE_SUCCESS | 00/01 | 1/2/3 |

### 3.2 适配器框架（SPI + 模板方法）

```
ChannelReconciliationAdapter（SPI）
  - channelId()
  - fetchFile()
  - parse()
  - normalizeAmount()
  - normalizeStatus()
  - verifySignature()

AbstractReconTemplate（模板方法）
  - fetch → verify → parse → match → handleDiscrepancy

ReconciliationOrchestrator（编排器）
  - Spring SPI 自动发现所有 Adapter
  - 新增渠道 = 实现一个 Adapter，零主流程改动
```

### 3.3 三大陷阱

| 陷阱 | 描述 | 规避 |
|---|---|---|
| 时区错配 | 银联 UTC，本地 Asia/Shanghai | 解析时显式指定时区 |
| 金额单位错配 | 微信分（int），支付宝元（string） | 归一化到最小单位（分） |
| 字段顺序变更 | 渠道升级 API 后字段顺序变 | file_version 路由不同 parser |

### 3.4 文件晚到处理

```
预定时间触发 → 拉取失败
→ 30 分钟重试 × 8 次（覆盖 4 小时晚到窗口）
→ 仍失败 → 降级为渠道开放平台 API 单笔查询
→ 仍失败 → T+2 补对 + 告警
```

---

## 四、对账粒度与跨日对账

### 4.1 三种粒度

| 粒度 | 比对内容 | 适用 |
|---|---|---|
| 订单级 | 订单号是否存在 | 闭环检查 |
| 金额级 | 订单号+金额 | 资金对账核心 |
| 明细级 | 订单号+金额+状态+时间 | 差错深挖 |

**实战组合**：日常用订单级+金额级，差错深挖下钻明细级。

### 4.2 跨日对账方案

**双窗口对齐（推荐）**：

```
T 日对账范围 = 渠道账单 T 日 00:00~24:00
              ∩ 本地订单 created_at ∈ [T-1 23:00, T+1 01:00]
```

扩展 2 小时窗口覆盖跨日回调。

**以渠道账单为锚点**：遍历渠道账单每条记录，用 out_trade_no 反查本地订单（不管本地 created_at 是哪天）。

### 4.3 跨日订单的去重

一笔订单可能出现在 T 日和 T+1 两个渠道账单。必须用 `(out_trade_no, recon_date)` 复合键去重，记录"已对账日期"。

```sql
ALTER TABLE pay_order ADD COLUMN reconciled_date DATE;
ALTER TABLE pay_order ADD UNIQUE KEY uk_out_trade_recon (out_trade_no, reconciled_date);
```

---

## 五、调度与补偿

### 5.1 调度架构

```
调度中心（XXL-Job）
  - 02:00 触发 T-1 对账（按渠道分片并行）
  - 04:00 触发差错处置
  - 每小时挂账超时检查
```

### 5.2 "一笔订单最多对账一次"的三重保障

1. **DB 唯一索引**：`uk_recon (recon_date, channel_id, pay_order_no)` 兜底
2. **对账前查询**：recon_record 已存在则跳过
3. **渠道账单去重**：解析时按 out_trade_no 去重

### 5.3 对账必须幂等可重跑

```sql
INSERT IGNORE INTO recon_record (recon_date, channel_id, pay_order_no, recon_status, handle_status)
VALUES (?, ?, ?, ?, 0);
```

同一天跑 N 次结果必须一致。

### 5.4 失败补偿策略

| 失败类型 | 处置 |
|---|---|
| 渠道文件未到 | 30 分钟重试 ×8 → API 查询降级 → T+2 补对 |
| 解析失败 | 告警+人工，原始文件归档 |
| DB 异常 | 重试 3 次，仍失败整体回滚 |
| 差错处理失败 | 自动挂账+人工工单 |

---

## 六、四类差错速记

### 6.1 长单（平台有单、渠道无单）

**判定**：本地 SUCCESS + 渠道账单无 out_trade_no + SUCCESS 时间 ≤ T-1 23:59:59

**根因 5 类**：

| 根因 | 占比 | 判定 |
|---|---|---|
| 渠道账单未结算 | 50% | 调查询返回 SUCCESS |
| 跨日结算落到 T+1 | 20% | 查 T+1 账单 |
| 本地误置 SUCCESS | 15% | 调查询返回 FAILED |
| out_trade_no 错配 | 10% | 查询返回实际单号 |
| 渠道侧真的没扣 | 5% | 查询返回 NOT_FOUND |

**核心动作**：调渠道查询接口二次确认，绝不直接挂账。

**SLA**：

```
T+1 08:00  识别
T+1 08:30  二次查询确认
T+1 12:00  误置 SUCCESS → 冲正+撤发货+通知业务方
T+2 12:00  仍未结账 → 挂账
T+7 12:00  上报风控
T+30       监管报告
```

### 6.2 短单（渠道有单、平台无单）

**判定**：渠道账单有扣款 + 本地订单不存在（或 INIT/CLOSED）

**资损信号最强烈**——必须先定位根因，不能直接补单。

**根因 5 类**：本地漏单、out_trade_no 错配、渠道多扣、回调重发二次扣款、跨系统串单。

**为什么不能直接补单**：

| 风险 | 正确做法 |
|---|---|
| 资金来源不明 | 先调渠道查原始下单参数 |
| 业务订单状态错乱 | 校验业务订单状态，已关单转退款 |
| 冲账困难 | 先挂"待处理短单"科目 |
| 审计盲区 | 走完整差错处置流程 |

**处置流程**：

```
调渠道查原始参数 → 核对业务订单
  ├─ 业务订单未支付 → 补建支付单 + 补记账 + 通知
  ├─ 业务订单已关单/已支付 → 退款流程
  └─ 业务订单不存在 → 挂账"无主资金" + 客服
```

### 6.3 金额不符

**6 类场景**：手续费扣减、优惠抵扣、汇率换算、退款部分冲抵、渠道多扣少扣、分账场景。

**分账双层勾对**：

```
第一层：本地 pay_order.amount = 渠道账单 total_amount
第二层：本地 pay_order_split.split_amount = 渠道分账明细（逐笔）
```

渠道账单只给总额时，调"渠道分账查询接口"补齐明细。

**零头差异处置**：

| 差异金额 | 处置 | 会计科目 |
|---|---|---|
| ≤0.01 元 | 自动平账 | 营业外收支（不入应收应付） |
| 0.01~1 元 | 挂账 | 待处理财产损溢 |
| >1 元 | 立即告警人工 | - |

**关键原则**：零头平账只入"营业外收支"，**绝不入"应收/应付"**，否则污染往来账。

### 6.4 状态不符（最危险）

**最危险组合**：

| 组合 | 风险 | SLA |
|---|---|---|
| 本地 SUCCESS + 渠道 FAILED | 平台发货但渠道没扣到钱 → 资损 | 30 分钟确认，2 小时冲正 |
| 本地 FAILED + 渠道 SUCCESS | 用户付了钱但平台没发货 → 客诉 | 1 小时确认，4 小时补单/退款 |
| 本地 PROCESSING + 渠道 SUCCESS | 正常回调延迟 | 5 分钟补单 |
| 本地 PROCESSING + 渠道 FAILED | 正常回调延迟 | 30 分钟关单 |

**根因 4 类**：回调丢失（60%）、回调处理失败（25%）、状态机错乱（10%）、渠道侧状态变更（5%）。

**自动恢复机制**：

```
对账识别 → 调渠道查询二次确认 → 多状态校验
        → 幂等状态恢复事务（冲正账务/补单/退款）
        → 异步通知业务方
```

**扫描频率**：

| 场景 | 频率 |
|---|---|
| PROCESSING 订单扫描 | 每 5 分钟 |
| SUCCESS 订单状态校验 | 每小时 |
| 跨日差异单深扫 | 每日 02:00 |
| 本地 SUCCESS+渠道 FAILED | 实时告警 |

**恢复动作的幂等**（结合 Day02）：

```
idempotent_key = "STATUS_RECOVER#" + pay_order_no + "#" + channelStatus
→ 抢占幂等记录
→ SELECT FOR UPDATE 锁定支付订单
→ 多状态校验（业务订单/退款/账务/通知）
→ 事务：UPDATE 状态 + 冲正账务 + 审计日志
→ 异步 MQ 通知业务方
```

---

## 七、关键 SQL 速记

### 7.1 长单（左连接找 NULL）

```sql
SELECT a.pay_order_no 
FROM local_orders a 
LEFT JOIN channel_bills b ON a.out_trade_no = b.out_trade_no 
WHERE b.out_trade_no IS NULL AND a.status = 'SUCCESS';
```

### 7.2 短单（右连接找 NULL）

```sql
SELECT b.out_trade_no, b.amount 
FROM local_orders a 
RIGHT JOIN channel_bills b ON a.out_trade_no = b.out_trade_no 
WHERE a.out_trade_no IS NULL;
```

### 7.3 金额差

```sql
SELECT a.pay_order_no, a.amount AS local, b.amount AS channel, 
       a.amount - b.amount AS diff
FROM local_orders a 
JOIN channel_bills b ON a.out_trade_no = b.out_trade_no 
WHERE a.amount <> b.amount;
```

### 7.4 状态差

```sql
SELECT a.pay_order_no, a.status AS local_status, b.status AS channel_status
FROM local_orders a 
JOIN channel_bills b ON a.out_trade_no = b.out_trade_no 
WHERE a.status <> b.status;
```

### 7.5 退款累计校验

```sql
SELECT pay_order_no, SUM(refund_amount) AS total_refunded
FROM refund_order 
WHERE pay_order_no = ? AND status = 'SUCCESS'
GROUP BY pay_order_no
HAVING SUM(refund_amount) <= original_pay_amount;
```

---

## 八、面试速记口诀

1. **对账三句话**：以支付订单为中心做星型勾对、用渠道账单做外部真相、用对账键去重保证一笔一账
2. **四类差错**：长单（平台有渠道无）、短单（渠道有平台无）、金额差、状态差
3. **长单处置**：先调查询二次确认，再分根因——账单晚到等 T+1，误置 SUCCESS 走冲正
4. **短单处置**：不能直接补单，先核对业务订单状态，已关单转退款
5. **零头差异**：≤0.01 元走营业外收支自动平账，绝不入应收应付
6. **状态不符 SLA**：本地 SUCCESS+渠道 FAILED 半小时确认 2 小时冲正
7. **幂等三重保障**：唯一索引+对账前查询+账单去重
8. **适配器框架**：SPI+模板方法，新增渠道零主流程改动

---

## 九、与前后的衔接

**承接 Day02**：
- Day02 的 `channel_no` 既是回调幂等键也是对账勾对键
- Day03 的"二次查询→状态恢复"全程沿用 Day02 的幂等模板
- Day03 的"补单事务四校验"是 Day02 补单流程的对账驱动版

**为 Day04/Day05 铺垫**：
- Day03 的"挂账账户"是 Day04 资金安全的核心组件（应收/应付/无主资金三类账户）
- Day03 的"分账对账"是 Day05 退款分账的地基（分账失败补偿依赖分账对账模型）
- Day03 的"状态恢复"是 Day04"资金冲正"的对账触发入口

---

## 十、架构师核心原则

1. **对账是会计不是审计**——主动参与资金流，不只是事后核对
2. **以支付订单为锚点**——它是唯一能跨系统关联的实体
3. **二次确认永远在对账后**——账单有时点偏差，必须调查询接口确认当前状态
4. **差错处置不能"补单了事"**——必须走完整流程，留全链路审计
5. **零头差异不入往来账**——只走营业外收支，避免污染应收应付
6. **对账必须幂等可重跑**——同一天跑 N 次结果必须一致
7. **资损类差错实时告警**——本地 SUCCESS+渠道 FAILED 不等跑批，立即介入
8. **监管红线**——T+1 对账、T+2 处置、30 天上报，硬性要求不可妥协