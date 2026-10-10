# Day 7：架构深挖 -- 医保结算底层原理与三防闭环

## 一、今日主题

本周医疗信息化专题已完成从业务到资金的完整闭环：

```text
Day1：智慧体检业务架构与核心流程设计（9 大模块、多机构 SaaS、设备异构）
Day2：HIS 与 EMR 核心架构与体检系统对接（CDA 文档、EMPI、4 种对接模式）
Day3：HL7 与 FHIR 标准及医疗信息互操作性（四代标准、Mirth Connect、SMART on FHIR）
Day4：DICOM 医学影像标准与 PACS 系统架构（协议体系、Orthanc、云原生 PACS、AI 辅诊）
Day5：医保对接与医疗支付结算（三段式结算、HOS 接口、混合支付、三方对账）
Day6：串联整合 -- 智慧体检全链路架构设计
```

Day5 讲了"医保对接设计"--三段式结算、HOS 接口、混合支付编排、三方对账。Day6 把全链路串起来。Day7 不再讲"设计在哪一层"，而是深挖一个贯穿 Day5/Day6 的底层命题：

```text
同样是"防重复/防错乱"，分布式锁、DB 唯一索引、状态机幂等、医保接口 infid 幂等
四者的底层实现是什么？
各自的并发原语、边界 case、性能代价、可靠性边界在哪？
为什么生产级医保结算系统必须四层叠加，而不是任选其一？
为什么医保结算的"跨月不可撤销"是资金安全的关键约束？
```

这道题考察的不是"会不会调医保接口"，而是你能不能把背后的：

```text
并发原语（SETNX 单线程模型 / B+Tree 唯一约束 / CAS 乐观锁 / infid 唯一流水）
边界 case（看门狗续期失败 / 唯一索引死锁 / 跨月撤销失败 / 异地参保人重复结算）
可靠性边界（Redis 主从切换丢锁 / MySQL 主备延迟 / 医保接口超时 / 网络分区）
工程选型（防并发 vs 防重复 vs 防错乱 vs 防超时，四层各防什么）
```

讲清楚。结合用户业务背景：蛋壳钱包 TCC、ToC 核心业务 Redisson、内部管理系统 SETNX 裸实现、智慧体检医保结算 -- 四套实践正好覆盖多种机制的踩坑现场。

---

## 二、题目：医保结算四防闭环的底层原理深挖

你负责维护某区域医疗集团智慧体检平台的医保结算中台，线上反馈四个现象：

```text
现象1：某体检车网络抖动，居民医保结算请求超时重试，导致同一笔体检被医保结算 3 次
       排查发现：业务方用 UUID.randomUUID() 做幂等键，每次重试都不一样
       医保接口 infid 也是每次重新生成，医保侧无法识别为同一笔

现象2：大促期间（社区集中体检）Redisson 看门狗续期失败，导致分布式锁提前释放
       同一居民的结算请求被两个窗口同时处理，医保重复扣款 7 笔
       其中 3 笔已跨月，无法撤销，需走医保退费流程

现象3：账务系统用 DB 唯一索引防重复结算，但并发场景下出现死锁
       ERROR 1213: Deadlock found when trying to get lock; try restarting transaction
       100+ 笔结算被回滚，业务方超时重试引发雪崩

现象4：异地参保人在本地体检，本地医保结算成功，但参保地医保也同步结算
       两地医保都扣款，居民投诉"医保被扣两次"
       排查发现：本地与参保地医保系统数据同步延迟，两地同时发起结算
```

现在要求你：

```text
从分布式锁、DB 唯一索引、状态机幂等、医保接口 infid 幂等 四种机制的底层原理出发，
解释清楚上述四个现象的根因，并给出架构师视角的四防闭环设计与替代方案。
```

---

## 三、需要回答的问题

### 1. 四种幂等机制的底层原理分别是什么？

请说明：

```text
Redis SETNX 的底层：单线程模型 + EVAL Lua 原子性 + 过期时间
Redisson 看门狗机制：renewal 线程 + Netty HashedWheelTimer 时间轮
Redlock 算法：多数派 + 时钟同步假设 + "有效性窗口"

MySQL 唯一索引：B+Tree 唯一约束 + 插入路径 + 死锁检测
MySQL 行锁 + 间隙锁：RR 隔离级别下的 next-key lock
INSERT IGNORE / ON DUPLICATE KEY / REPLACE INTO 的差异

状态机幂等：CAS UPDATE WHERE status=old_status
乐观锁 vs 悲观锁的边界
为什么"状态机幂等"才是医保结算的"最终防线"

医保接口 infid 幂等：服务端缓存 infid -> response
HOS 接口的幂等协议：infcode + infid 的语义
为什么 infid 必须业务侧生成，不能用 UUID
```

### 2. 各种机制的并发原语与原子性保证

重点说明：

```text
SETNX 为什么是原子的？Redis 单线程模型如何保证？
Lua 脚本 EVAL 为什么比 MULTI/EXEC 更可靠？
Redisson 看门狗的 renewal 任务为什么用 Netty 时间轮而不是 ScheduledExecutor？

MySQL 唯一索引检查为什么不是"先查后插"而是"插入时检查"？
B+Tree 在唯一约束下如何处理并发插入？
唯一索引冲突报错 1062 的内部流程是什么？

CAS UPDATE 的"乐观锁"为什么比 SELECT FOR UPDATE 更适合医保结算？
ABA 问题在医保结算场景下是否存在？为什么 status 字段比 version 字段更可靠？

infid 的服务端存储：Redis 缓存 + DB 持久化？
infid 的过期策略：多久过期？过期后同一 infid 再请求会怎样？
```

### 3. 边界 case 与异常场景

重点说明：

```text
锁续期失败：看门狗机制什么场景下会失效？（GC 长停顿 / 网络分区 / Redis 主从切换）
锁与事务的边界：锁在事务外还是事务内？为什么"锁在事务外"才是正确姿势？
锁重入：Redisson 为什么用 Hash 结构而不是 String？

唯一索引冲突的并发处理：INSERT IGNORE 的"静默失败"为什么反而危险？
死锁场景：唯一索引并发插入为什么容易死锁？如何用 INSERT ... ON DUPLICATE KEY UPDATE 避免？

状态机的"已终态"处理：为什么医保结算 Cancel 到达时必须先检查"是否已结算"？
跨月不可撤销：医保结算的"跨月不可撤销"是技术限制还是业务限制？
为什么必须人工兜底？

异地参保人重复结算：本地医保与参保地医保的数据同步延迟如何导致重复结算？
如何用"参保地预校验"避免？
```

### 4. 四层防御的工程选型与组合

重点说明：

```text
防并发：分布式锁（防止两线程同时处理同一笔）
防重复：DB 唯一索引（防止同一笔业务多次入库）
防错乱：状态机幂等（防止状态跳跃）
防超时：infid 幂等（防止网络超时导致的重复调用）

四层各防什么？是否能相互替代？
为什么生产级医保结算必须四层叠加？
哪些场景可以简化？
```

### 5. 跨月不可撤销的工程实现

重点说明：

```text
跨月边界的本质：医保按月清算，月底"封账"
跨月撤销的技术不可行性：医保侧已生成对账文件
跨月退费的业务流程：医院向医保申请退费 -> 医保审核 -> 退回到居民医保账户
如何防止跨月撤销尝试：状态机检查 + 时间窗口校验
跨月退费的工程实现：工单 + 人工审核 + 对账修正
```

### 6. 异地重复结算的根因与防范

重点说明：

```text
异地就医直接结算的链路：本地医保 -> 国家平台 -> 参保地医保
数据同步延迟：国家平台 -> 参保地医保的同步延迟（T+1 或 T+0）
重复结算场景：本地结算成功后，参保地医保也发起结算（同步延迟内）
防范机制：参保地预校验 + 国家平台锁 + 业务侧防重
为什么"参保地预校验"不能 100% 防范？
兜底机制：跨省对账 + 人工核差 + 退费
```

---

## 四、四种幂等机制的底层原理

### 1. Redis SETNX 的底层

**单线程模型**：

Redis 采用单线程 Reactor 模型（Redis 6.0 后引入多线程 IO，但命令执行仍单线程）：

```text
┌──────────────────────────────────────────────────────────────────┐
│  Redis 单线程模型                                                 │
│                                                                    │
│  ┌──────────┐                                                    │
│  │ 客户端 1  │ ──┐                                                │
│  └──────────┘   │                                                 │
│  ┌──────────┐   │     ┌──────────────┐     ┌──────────────┐     │
│  │ 客户端 2  │ ──┼───>│ IO 多路复用  │ ──> │ 命令执行单线程│     │
│  └──────────┘   │     │ (epoll)      │     │              │     │
│  ┌──────────┐   │     └──────────────┘     └──────────────┘     │
│  │ 客户端 3  │ ──┘                              │                │
│  └──────────┘                                   ▼                │
│                                          ┌──────────────┐        │
│                                          │ 数据结构     │        │
│                                          │ (String/Hash)│        │
│                                          └──────────────┘        │
└──────────────────────────────────────────────────────────────────┘
```

**SETNX 原子性**：

```bash
# SETNX 命令本身是原子的
SETNX key value  # 如果 key 不存在，设置 value，返回 1
                  # 如果 key 已存在，不做任何操作，返回 0

# 但 SETNX + EXPIRE 两步不原子！
SETNX key value  # 步骤 1：设置
EXPIRE key 60    # 步骤 2：设置过期时间

# 如果步骤 1 成功，步骤 2 之前 Redis 崩溃，key 会永久存在 -> 死锁
```

**Lua 脚本原子性**：

```lua
-- 加锁 Lua 脚本（原子）
if redis.call('setnx', KEYS[1], ARGV[1]) == 1 then
    redis.call('expire', KEYS[1], ARGV[2])
    return 1
else
    return 0
end

-- 解锁 Lua 脚本（原子 + 防误删）
if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
else
    return 0
end
```

> 关键：Lua 脚本在 Redis 中是原子的（执行期间不被其他命令打断），因此"判断 + 操作"两步合并为原子操作。

### 2. Redisson 看门狗机制

**问题**：SETNX 加锁时如果指定过期时间太短，业务未完成锁就释放了；如果太长，宕机后锁迟迟不释放。

**Redisson 看门狗方案**：默认 30 秒过期 + 后台续期。

```text
┌──────────────────────────────────────────────────────────────────┐
│  Redisson 看门狗机制                                               │
│                                                                    │
│  T0 客户端加锁                                                     │
│     - SETNX key value EX 30  # 默认 30 秒过期                     │
│     - 启动 renewal 任务（Netty HashedWheelTimer）                 │
│                                                                    │
│  T10 renewal 任务第一次续期                                        │
│     - Lua 脚本：if exists then expire 30                          │
│     - 锁延长到 T40                                                 │
│                                                                    │
│  T20 renewal 任务第二次续期                                        │
│     - 锁延长到 T50                                                 │
│                                                                    │
│  T25 业务完成，客户端解锁                                          │
│     - DEL key                                                      │
│     - 取消 renewal 任务                                            │
└──────────────────────────────────────────────────────────────────┘
```

**续期任务为什么用 Netty HashedWheelTimer**：

| 方案 | 优点 | 缺点 |
|---|---|---|
| ScheduledExecutorService | 简单 | 大量任务时性能差（堆排序） |
| HashedWheelTimer | 时间轮，O(1) 添加 | 精度略低（轮询周期） |
| DelayQueue | 精度高 | 堆排序，性能差 |

> Redisson 选 HashedWheelTimer：百万级锁时性能优秀，精度可接受（默认 100ms）。

**续期失败场景**：

```text
1. GC 长停顿
   - JVM Full GC 导致 renewal 线程暂停
   - 锁过期但未续期 -> 锁释放
   - 其他线程获取锁 -> 重复处理

2. 网络分区
   - 客户端与 Redis 网络分区
   - renewal 请求失败 -> 锁过期
   - Redis 侧认为客户端宕机，释放锁

3. Redis 主从切换
   - 主节点宕机，从节点升级
   - 从节点未同步完锁数据 -> 锁丢失
   - 新主节点接受其他客户端加锁请求
```

**Redlock 算法**（多节点 Redis）：

```text
1. 客户端获取当前时间 T0
2. 依次向 N（通常 5）个 Redis 节点请求加锁
   - 每个节点 SETNX + 短过期时间
3. 计算获取锁总耗时 T1 - T0
4. 如果 (N/2 + 1) = 3 个节点加锁成功，且 T1 - T0 < 锁过期时间
   - 加锁成功
5. 否则
   - 向所有节点释放锁
```

> Redlock 的争议：Martin Kleppmann 批评其依赖时钟同步，Redis 作者 antirez 反驳。生产中 Redlock 用得不多，更多用主从 + 哨兵。

### 3. MySQL 唯一索引的底层

**B+Tree 唯一约束**：

```text
┌──────────────────────────────────────────────────────────────────┐
│  B+Tree 唯一索引                                                  │
│                                                                    │
│  CREATE TABLE mi_settlement_idempotent (                           │
│    settlement_id VARCHAR(64) PRIMARY KEY,                          │
│    infid VARCHAR(64),                                              │
│    biz_id VARCHAR(64),                                             │
│    UNIQUE KEY uk_infid (infid),                                    │
│    UNIQUE KEY uk_biz (biz_id)                                      │
│  );                                                                │
│                                                                    │
│  B+Tree 结构（uk_infid 索引）：                                    │
│                                                                    │
│                    ┌──────────┐                                    │
│                    │  Root    │                                    │
│                    │ inf5     │                                    │
│                    └──────────┘                                    │
│                       /   \                                        │
│             ┌─────────┘   └─────────┐                             │
│             ▼                       ▼                              │
│       ┌──────────┐            ┌──────────┐                        │
│       │ inf1-5   │            │ inf6-9   │                        │
│       └──────────┘            └──────────┘                        │
│                                                                    │
│  插入 inf3 时：                                                   │
│  1. 从 Root 开始查找，定位到叶子节点                              │
│  2. 在叶子节点检查 inf3 是否已存在                               │
│  3. 不存在 -> 插入                                                │
│  4. 已存在 -> 报错 1062（Duplicate entry）                       │
└──────────────────────────────────────────────────────────────────┘
```

**唯一索引检查为什么不是"先查后插"**：

```text
错误做法（先查后插）：
  SELECT count(*) FROM t WHERE infid = 'xxx';  -- 0
  -- 此时其他线程也插入同一 infid
  INSERT INTO t (infid, ...) VALUES ('xxx', ...);  -- 成功
  -- 但另一线程也插入成功 -> 重复

正确做法（插入时检查）：
  INSERT INTO t (infid, ...) VALUES ('xxx', ...);
  -- 数据库在 B+Tree 插入时检查唯一约束
  -- 已存在则报错 1062
  -- 这是原子的（在行锁保护下）
```

**B+Tree 并发插入与死锁**：

```text
场景：两个事务同时插入相邻的 infid

T1: INSERT inf3 (叶子节点需要 inf1-inf5 的锁)
T2: INSERT inf4 (叶子节点需要 inf1-inf5 的锁)

T1 持有 inf1-inf5 锁，等待 T2 释放
T2 持有 inf1-inf5 锁，等待 T1 释放
-> 死锁
```

**INSERT IGNORE / ON DUPLICATE KEY / REPLACE INTO 的差异**：

| 语法 | 行为 | 适用场景 |
|---|---|---|
| `INSERT IGNORE` | 唯一冲突时静默跳过（返回 0 行受影响） | **危险**：会忽略其他错误（如字段类型错误） |
| `INSERT ... ON DUPLICATE KEY UPDATE` | 唯一冲突时执行 UPDATE | 推荐：明确处理冲突 |
| `REPLACE INTO` | 唯一冲突时 DELETE + INSERT | **危险**：会改变主键、触发器、外键 |

```sql
-- 推荐：ON DUPLICATE KEY UPDATE
INSERT INTO mi_settlement_idempotent (infid, biz_id, status, retry_count)
VALUES ('inf-123', 'biz-456', 'PENDING', 0)
ON DUPLICATE KEY UPDATE 
    retry_count = retry_count + 1,
    updated_at = NOW();
```

### 4. 状态机幂等

**CAS UPDATE 原理**：

```sql
-- 状态机幂等：CAS UPDATE WHERE status = old_status
UPDATE exam_order 
SET status = 'SETTLED', 
    settle_time = NOW(),
    settlement_id = 'MI-123'
WHERE order_id = 456 
  AND status = 'PENDING_SETTLE';
-- 返回影响行数：1=成功，0=状态已变更（重复请求）
```

**为什么 CAS UPDATE 比 SELECT FOR UPDATE 更适合医保结算**：

| 维度 | SELECT FOR UPDATE（悲观锁） | CAS UPDATE（乐观锁） |
|---|---|---|
| 锁粒度 | 行锁，持有整个事务 | 仅 UPDATE 时锁 |
| 并发性 | 低（串行） | 高（无锁读） |
| 死锁风险 | 高 | 低 |
| 重试要求 | 不需要 | 失败需重试 |
| 适用场景 | 冲突多 | 冲突少 |

> 医保结算冲突率低（同一笔订单并发结算概率小），CAS UPDATE 更合适。

**ABA 问题在医保结算场景**：

```text
ABA 场景：
T0 status = PENDING_SETTLE
T1 线程 A 读到 status = PENDING_SETTLE
T2 线程 B 改 status = SETTLED
T3 线程 B 改 status = REFUNDED
T4 线程 A CAS UPDATE WHERE status = PENDING_SETTLE -> 失败（0 行）

ABA 问题：线程 A 读到 PENDING，但实际已经 SETTLED -> REFUNDED。
```

**version 字段 vs status 字段**：

```sql
-- version 字段（不推荐）
UPDATE exam_order 
SET status = 'SETTLED', version = version + 1
WHERE order_id = 456 AND version = 1;

-- status 字段（推荐）
UPDATE exam_order 
SET status = 'SETTLED'
WHERE order_id = 456 AND status = 'PENDING_SETTLE';
```

> 推荐 status 字段：
> - 业务语义更强（"状态机"本身就是业务规则）
> - 防止状态跳跃（PENDING_SETTLE 只能转到 SETTLED，不能直接到 REFUNDED）
> - 防止误操作（如已退款状态被改回已结算）

**状态机定义**：

```java
public enum ExamOrderStatus {
    CREATED,             // 已创建
    RESERVED,            // 已预约
    CHECKED_IN,          // 已报到
    EXAMINING,           // 体检中
    EXAM_COMPLETED,      // 体检完成
    PENDING_SETTLE,      // 待结算
    SETTLED,             // 已结算
    PENDING_REFUND,      // 待退款
    REFUNDED,            // 已退款
    CANCELLED;           // 已取消
}

// 状态机转移规则（白名单）
public class ExamOrderStateMachine {
    private static final Map<ExamOrderStatus, Set<ExamOrderStatus>> TRANSITIONS = Map.of(
        CREATED, Set.of(RESERVED, CANCELLED),
        RESERVED, Set.of(CHECKED_IN, CANCELLED),
        CHECKED_IN, Set.of(EXAMINING, CANCELLED),
        EXAMINING, Set.of(EXAM_COMPLETED, CANCELLED),
        EXAM_COMPLETED, Set.of(PENDING_SETTLE),
        PENDING_SETTLE, Set.of(SETTLED),
        SETTLED, Set.of(PENDING_REFUND),
        PENDING_REFUND, Set.of(REFUNDED, SETTLED),  // 退款失败回滚到已结算
        REFUNDED, Set.of(),  // 终态
        CANCELLED, Set.of()   // 终态
    );
    
    public static boolean canTransit(ExamOrderStatus from, ExamOrderStatus to) {
        return TRANSITIONS.getOrDefault(from, Set.of()).contains(to);
    }
}
```

### 5. 医保接口 infid 幂等

**infid 的本质**：医保接口的"业务幂等键"，由 HIS 侧生成，医保侧缓存"infid -> response"映射。

```text
┌──────────────────────────────────────────────────────────────────┐
│  infid 幂等协议                                                   │
│                                                                    │
│  第一次请求：                                                     │
│  HIS -> 医保                                                       │
│  { infid: "inf-123", ... }                                        │
│                                                                    │
│  医保处理：                                                        │
│  1. 查 infid 缓存 -> 未命中                                       │
│  2. 执行业务                                                       │
│  3. 缓存 infid -> response                                        │
│  4. 返回 response                                                  │
│                                                                    │
│  第二次请求（重试）：                                              │
│  HIS -> 医保                                                       │
│  { infid: "inf-123", ... }  // 同一 infid                         │
│                                                                    │
│  医保处理：                                                        │
│  1. 查 infid 缓存 -> 命中                                         │
│  2. 直接返回缓存的 response（不执行业务）                         │
└──────────────────────────────────────────────────────────────────┘
```

**infid 必须业务侧生成**：

```text
错误做法：UUID.randomUUID()
- 每次重试生成新 UUID
- 医保侧识别为不同请求
- 重复执行业务

正确做法：基于业务 ID 生成
- infid = hash(biz_type + biz_id + date)
- 如：infid = "MI_SETTLE_456_20260710"
- 同一笔业务重试时 infid 相同
- 医保侧识别为同一请求
```

**Java 实现**：

```java
public class InfidGenerator {
    public static String generate(String bizType, String bizId) {
        String date = LocalDate.now().format(DateTimeFormatter.BASIC_ISO_DATE);
        String raw = bizType + "_" + bizId + "_" + date;
        return "INF_" + DigestUtils.md5Hex(raw).substring(0, 16).toUpperCase();
    }
}

// 使用
String infid = InfidGenerator.generate("MI_SETTLE", order.getOrderId().toString());
MiSettlementRequest req = new MiSettlementRequest();
req.setInfid(infid);
req.setBizId(order.getOrderId().toString());
// ...
```

**infid 服务端存储**：

```text
医保侧 infid 缓存（推测）：
- Redis 缓存：infid -> response，TTL 24h
- DB 持久化：infid 表，保留 7 天

HIS 侧 infid 表（必须）：
- 记录每个 infid 的请求与响应
- 重试时复用同一 infid
- 用于本地审计
```

**infid 过期策略**：

```text
医保侧 Redis 缓存：24h 过期
医保侧 DB 持久化：7 天保留
HIS 侧 DB：永久保留（审计需要）

过期后的影响：
- 24h 后同一 infid 再请求 -> 医保侧识别为新请求
- 但 7 天内 DB 仍有记录，可申诉
- 超过 7 天 -> 完全无法识别
```

---

## 五、并发原语与原子性保证

### 1. SETNX 的原子性

**单线程模型如何保证**：

```text
Redis 6.0 架构：
┌────────────────────────────────────────────────┐
│  Redis Server                                   │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐    │
│  │ IO 线程 1│  │ IO 线程 2│  │ IO 线程 N│    │  多线程 IO
│  └──────────┘  └──────────┘  └──────────┘    │
│       │             │             │            │
│       └─────────────┼─────────────┘            │
│                     ▼                          │
│            ┌────────────────┐                  │
│            │ 命令执行单线程  │  单线程执行      │
│            │ (Redis Core)   │  保证原子性      │
│            └────────────────┘                  │
└────────────────────────────────────────────────┘
```

> 关键：即使 IO 多线程，命令执行仍单线程。SETNX 命令在执行线程中是不可被打断的原子操作。

### 2. Lua 脚本 vs MULTI/EXEC

**MULTI/EXEC 事务的问题**：

```bash
MULTI
SETNX key value   # 入队
EXPIRE key 60     # 入队
EXEC              # 执行

# 问题：
# 1. MULTI 后命令入队，但不会立即执行
# 2. EXEC 前如果有其他客户端的命令插入，可能影响状态
# 3. 不支持条件判断（如"如果 key 存在才 EXPIRE"）
# 4. 命令入队错误不会立即报错
```

**Lua 脚本的优势**：

```lua
-- 整个脚本作为一个原子操作执行
-- 期间不会被其他命令打断
-- 支持条件判断

if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
else
    return 0
end
```

> 关键：Lua 脚本在 Redis 中是原子的，整个脚本执行期间不被打断。MULTI/EXEC 只保证"按顺序执行"，不保证"中间不被打断"。

### 3. MySQL 唯一索引的原子性

**插入路径**：

```text
INSERT INTO mi_settlement_idempotent (infid, ...) VALUES ('inf-123', ...);

MySQL InnoDB 执行流程：
1. 在 B+Tree 中查找插入位置（持锁）
2. 检查唯一约束
   - 已存在：报错 1062，释放锁
   - 不存在：继续
3. 插入新记录
4. 写 redo log + binlog
5. 提交事务，释放锁
```

**唯一索引冲突报错 1062 的流程**：

```text
1. 客户端发起 INSERT
2. InnoDB 在 B+Tree 中定位插入位置
3. 持有叶子节点的行锁 + 间隙锁
4. 检查到已存在相同 infid
5. 回滚当前插入操作
6. 释放锁
7. 返回错误：ERROR 1062 (23000): Duplicate entry 'inf-123' for key 'uk_infid'
```

### 4. CAS UPDATE 的原子性

```sql
UPDATE exam_order 
SET status = 'SETTLED', settle_time = NOW()
WHERE order_id = 456 AND status = 'PENDING_SETTLE';
```

**InnoDB 执行流程**：

```text
1. 查找 order_id = 456 的记录（持行锁）
2. 检查 status 是否为 PENDING_SETTLE
   - 是：更新 status 和 settle_time
   - 否：不更新，返回 0 行受影响
3. 写 redo log + binlog
4. 提交事务，释放行锁
```

> 关键：CAS UPDATE 的"查找 + 检查 + 更新"在 InnoDB 中是原子的（行锁保护），不需要额外的锁。

### 5. infid 服务端的原子性

**Redis 缓存方案**：

```lua
-- 医保侧 infid 缓存（Lua 原子）
local key = KEYS[1]
local value = ARGV[1]

local cached = redis.call('GET', key)
if cached then
    return cached  -- 命中缓存，直接返回
else
    -- 未命中，需要执行业务
    -- 但这里不能执行业务（Lua 脚本不应有副作用）
    return nil
end
```

**实际流程**：

```text
T0: HIS 请求 infid=inf-123
T1: 医保 Redis 查 inf-123 -> 未命中
T2: 医保执行业务（结算）
T3: 医保写 Redis: inf-123 -> response
T4: 医保返回 response

并发问题：
T0: HIS 请求 infid=inf-123（线程 A）
T1: HIS 请求 infid=inf-123（线程 B，重试）
T2: 线程 A 查 Redis -> 未命中
T3: 线程 B 查 Redis -> 未命中
T4: 线程 A 执行业务
T5: 线程 B 执行业务  # 重复执行！
T6: 线程 A 写 Redis
T7: 线程 B 写 Redis  # 覆盖

防范：HIS 侧必须保证同一笔业务不并发调用医保接口
     -> 用分布式锁或本地锁防止并发
```

> 关键：infid 幂等是"事后补救"，不能防止并发。必须配合分布式锁或 DB 唯一索引防止并发。

---

## 六、边界 case 与异常场景

### 1. 锁续期失败

**GC 长停顿**：

```text
T0: 客户端加锁，TTL 30s
T10: 客户端开始 Full GC
T40: 锁过期，Redis 释放
T41: 其他线程加锁成功
T45: Full GC 结束
T46: 客户端继续执行业务（以为自己还持有锁）
T47: 两个线程都在处理同一笔业务 -> 重复
```

**网络分区**：

```text
T0: 客户端加锁，TTL 30s
T10: 网络分区，客户端与 Redis 断开
T20: renewal 请求失败
T40: 锁过期，Redis 释放
T41: 其他客户端加锁成功
T50: 网络恢复，原客户端继续业务
T51: 两个客户端都在处理 -> 重复
```

**Redis 主从切换**：

```text
T0: 客户端在主节点加锁
T1: 主节点异步复制到从节点（未完成）
T2: 主节点宕机
T3: 哨兵提升从节点为新主
T4: 新主没有锁数据
T5: 其他客户端加锁成功
T6: 两个客户端都在处理 -> 重复
```

**防范**：

| 场景 | 防范 |
|---|---|
| GC 长停顿 | 优化 JVM，避免 Full GC；监控 GC 时长 |
| 网络分区 | 业务幂等兜底（DB 唯一索引） |
| Redis 主从切换 | Redlock 算法（多节点）或业务幂等兜底 |

> 关键：分布式锁不能 100% 可靠，必须配合业务幂等兜底。

### 2. 锁与事务的边界

**错误做法（锁在事务内）**：

```java
@Transactional
public void settle(ExamOrder order) {
    RLock lock = redisson.getLock("order:" + order.getId());
    lock.lock();
    try {
        // 业务逻辑
        order.setStatus(SETTLED);
        orderRepo.save(order);
        miClient.settle(order);
    } finally {
        lock.unlock();  // 在事务提交前释放锁
    }
}
// 事务在方法返回后才提交
// 锁释放后，其他线程可以进入，但事务还未提交
// -> 锁释放后其他线程读到的是旧状态
```

**正确做法（锁在事务外）**：

```java
public void settle(ExamOrder order) {
    RLock lock = redisson.getLock("order:" + order.getId());
    lock.lock();
    try {
        transactionTemplate.execute(status -> {
            // 业务逻辑
            order.setStatus(SETTLED);
            orderRepo.save(order);
            miClient.settle(order);
            return null;
        });
    } finally {
        lock.unlock();  // 事务提交后才释放锁
    }
}
```

> 关键：锁必须"包住"事务，不能被事务包住。否则锁释放后事务未提交，其他线程读到旧状态。

### 3. Redisson 锁重入

**Hash 结构**：

```text
SETNX 是 String 结构：
key: "order:456"
value: "client-uuid"
TTL: 30s

Redisson 用 Hash 结构：
key: "order:456"
field: "client-uuid"
value: 重入次数（如 2）

为什么用 Hash？
- 同一线程可重入（计数 +1）
- 不同线程不能获取（field 不匹配）
- 解锁时计数 -1，归零才删除 key
```

**Lua 脚本（Redisson 加锁）**：

```lua
-- 加锁
if redis.call('exists', KEYS[1]) == 0 then
    -- key 不存在，初始化 Hash
    redis.call('hset', KEYS[1], ARGV[2], 1)
    redis.call('pexpire', KEYS[1], ARGV[1])
    return nil
end
if redis.call('hexists', KEYS[1], ARGV[2]) == 1 then
    -- key 存在且 field 匹配，重入
    redis.call('hincrby', KEYS[1], ARGV[2], 1)
    redis.call('pexpire', KEYS[1], ARGV[1])
    return nil
end
-- 锁被其他线程持有
return redis.call('pttl', KEYS[1])
```

### 4. 唯一索引死锁

**死锁场景**：

```text
表 t 有唯一索引 uk_infid

事务 A：INSERT infid=inf-3
事务 B：INSERT infid=inf-4

B+Tree 叶子节点：[inf-1, inf-2, inf-5, inf-6]

事务 A 插入 inf-3：
1. 定位到 [inf-1, inf-2, inf-5, inf-6] 叶子节点
2. 持有间隙锁 (inf-2, inf-5)
3. 准备插入 inf-3

事务 B 插入 inf-4：
1. 定位到同一叶子节点
2. 持有间隙锁 (inf-2, inf-5)
3. 准备插入 inf-4

A 等 B 释放，B 等 A 释放 -> 死锁
```

**避免方案**：

```sql
-- 方案 1：ON DUPLICATE KEY UPDATE
INSERT INTO mi_settlement_idempotent (infid, biz_id, status, retry_count)
VALUES ('inf-123', 'biz-456', 'PENDING', 0)
ON DUPLICATE KEY UPDATE 
    retry_count = retry_count + 1,
    updated_at = NOW();

-- 方案 2：捕获 1062 错误
try {
    INSERT INTO mi_settlement_idempotent (infid, ...) VALUES ('inf-123', ...);
} catch (DuplicateKeyException e) {
    // 已存在，查询已有记录
    return repo.findByInfid('inf-123');
}

-- 方案 3：调整事务隔离级别为 READ COMMITTED
-- 间隙锁只在 RR 下存在，RC 下无间隙锁
SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED;
```

### 5. INSERT IGNORE 的危险

```sql
INSERT IGNORE INTO mi_settlement_idempotent (infid, biz_id, status) 
VALUES ('inf-123', 'biz-456', 'PENDING');

-- 问题：IGNORE 会忽略所有错误，不只是唯一冲突
-- 如：字段类型错误、NULL 约束、外键约束
-- 都会被静默忽略，导致数据未插入但应用以为成功

-- 推荐：ON DUPLICATE KEY UPDATE
INSERT INTO mi_settlement_idempotent (infid, biz_id, status) 
VALUES ('inf-123', 'biz-456', 'PENDING')
ON DUPLICATE KEY UPDATE updated_at = NOW();
-- 仅处理唯一冲突，其他错误正常抛出
```

### 6. 状态机"已终态"处理

**退款场景**：

```java
public void refund(ExamOrder order) {
    // 检查当前状态
    if (order.getStatus() != ExamOrderStatus.SETTLED) {
        // 已退款？已取消？
        if (order.getStatus() == ExamOrderStatus.REFUNDED) {
            // 已退款，幂等返回
            return;
        }
        throw new BizException("订单状态非已结算，不能退款");
    }
    
    // 调医保撤销
    MiRevokeResponse resp = miClient.revoke(order.getSettlementId());
    
    // 更新状态
    int rows = orderRepo.updateStatus(
        order.getOrderId(), 
        ExamOrderStatus.SETTLED,  // 期望状态
        ExamOrderStatus.REFUNDED  // 新状态
    );
    if (rows == 0) {
        // 状态已变更，可能被其他线程处理
        throw new BizException("状态变更失败，可能并发处理");
    }
}
```

**已终态的幂等**：

```java
public void refund(ExamOrder order) {
    if (order.getStatus() == ExamOrderStatus.REFUNDED) {
        log.info("订单已退款，幂等返回");
        return;  // 幂等
    }
    if (order.getStatus() != ExamOrderStatus.SETTLED) {
        throw new BizException("订单状态非已结算");
    }
    // ... 退款逻辑
}
```

### 7. 跨月不可撤销

**跨月边界的本质**：

```text
医保按月清算：
T-1 月 25 日：医保对账文件生成
T-1 月 30 日：医院与医保对账
T 月 1 日 0:00：T-1 月"封账"，T-1 月的结算不可撤销

跨月撤销尝试：
T-1 月 31 日 23:50：居民结算
T 月 1 日 0:10：居民要求退款
-> 调医保撤销接口 -> 拒绝（已封账）
-> 需走"医保退费"流程
```

**技术限制 vs 业务限制**：

| 维度 | 说明 |
|---|---|
| 技术限制 | 医保侧对账文件已生成，数据库记录已"冻结" |
| 业务限制 | 医保基金已拨付给医院，不能再撤销 |
| 兜底 | 走"医保退费"流程：医院向医保申请 -> 医保审核 -> 退回到居民医保账户 |

**防范跨月撤销尝试**：

```java
public void revokeSettlement(ExamOrder order) {
    // 1. 状态校验
    if (order.getStatus() != ExamOrderStatus.SETTLED) {
        throw new BizException("订单状态非已结算");
    }
    
    // 2. 时间窗口校验
    LocalDateTime settleTime = order.getSettleTime();
    LocalDateTime now = LocalDateTime.now();
    if (!settleTime.getMonth().equals(now.getMonth()) 
        || !settleTime.getYear() == now.getYear()) {
        // 跨月，不能撤销
        throw new BizException("已跨月，不能撤销，请走医保退费流程");
    }
    
    // 3. 调医保撤销
    MiRevokeResponse resp = miClient.revoke(order.getSettlementId());
    if (!resp.isSuccess()) {
        if ("ALREADY_PAID".equals(resp.getErrorCode())) {
            // 已拨付，走退费流程
            applyMiManualRefund(order);
            return;
        }
        throw new BizException("医保撤销失败: " + resp.getMsg());
    }
    
    // 4. 更新状态
    orderRepo.updateStatus(order.getOrderId(), SETTLED, REFUNDED);
}
```

### 8. 异地参保人重复结算

**异地就医直接结算链路**：

```text
┌──────────────────────────────────────────────────────────────────┐
│  异地就医直接结算                                                 │
│                                                                    │
│  T0: 参保人在参保地 A 备案                                        │
│  T1: 参保人到本地 B 体检/就医                                     │
│  T2: 本地 B 调本地医保结算                                        │
│      - 入参：参保人身份证、参保地 A 信息                          │
│      - 本地医保 -> 国家平台                                       │
│      - 国家平台 -> 参保地 A 医保                                  │
│      - 参保地 A 返回结算结果 -> 国家平台 -> 本地 B                │
│  T3: 本地 B 完成结算                                              │
│                                                                    │
│  问题：                                                            │
│  T4: 参保地 A 医保数据同步延迟，参保人查询时未看到本次结算         │
│  T5: 参保人以为未结算，到参保地 A 重新发起结算                    │
│  T6: 参保地 A 医保也结算 -> 重复扣款                              │
└──────────────────────────────────────────────────────────────────┘
```

**数据同步延迟导致的重复**：

```text
国家平台 -> 参保地医保的同步：
- 实时（T+0）：理想状态，但实现成本高
- 准实时（T+1 小时）：多数省份
- 日批（T+1）：部分省份

同步延迟内的重复风险：
- 参保人在 T 时刻本地结算
- T+30 分钟参保地医保未同步
- 参保人到参保地办理退款，参保地医保也发起结算
- 两地都扣款
```

**防范机制**：

| 机制 | 实现 | 效果 |
|---|---|---|
| 参保地预校验 | 本地结算前调参保地查询"是否已结算" | 部分防范 |
| 国家平台锁 | 本地结算时国家平台加锁 | 较强防范 |
| 业务侧防重 | 身份证 + 日期维度做防重表 | 兜底 |
| 跨省对账 | T+1 跨省对账，发现重复 | 事后补救 |

**业务侧防重表**：

```sql
CREATE TABLE cross_province_settlement_idempotent (
    id_card_hash VARCHAR(64),
    settle_date DATE,
    settle_province VARCHAR(20),
    settlement_id VARCHAR(64),
    PRIMARY KEY (id_card_hash, settle_date, settle_province)
);

-- 本地结算前插入
INSERT INTO cross_province_settlement_idempotent 
VALUES ('hash_xxx', '2026-07-10', 'BEIJING', 'MI-123');
-- 唯一冲突 -> 已结算
```

> 关键：跨省防重表是兜底，不能 100% 防范（参保人可能用不同证件）。最终靠跨省对账。

---

## 七、四层防御的工程选型与组合

### 1. 四层防御全貌

```text
┌──────────────────────────────────────────────────────────────────┐
│  四层防御                                                          │
│                                                                    │
│  ┌──────────────────────────────────────────────────┐            │
│  │  Layer 1: 分布式锁（防并发）                      │            │
│  │  - 防止两线程同时处理同一笔业务                    │            │
│  │  - Redisson 实现                                  │            │
│  │  - 锁粒度：订单 ID                                │            │
│  └──────────────────────────────────────────────────┘            │
│                          ↓                                        │
│  ┌──────────────────────────────────────────────────┐            │
│  │  Layer 2: DB 唯一索引（防重复）                   │            │
│  │  - 防止同一笔业务多次入库                         │            │
│  │  - 业务唯一约束 (biz_type, biz_id)               │            │
│  │  - 数据库层防线                                   │            │
│  └──────────────────────────────────────────────────┘            │
│                          ↓                                        │
│  ┌──────────────────────────────────────────────────┐            │
│  │  Layer 3: 状态机幂等（防错乱）                    │            │
│  │  - 防止状态跳跃                                   │            │
│  │  - CAS UPDATE WHERE status = old_status          │            │
│  │  - 业务规则白名单                                 │            │
│  └──────────────────────────────────────────────────┘            │
│                          ↓                                        │
│  ┌──────────────────────────────────────────────────┐            │
│  │  Layer 4: infid 幂等（防超时）                    │            │
│  │  - 防止网络超时导致的重复调用                     │            │
│  │  - 医保接口的 infid 协议                          │            │
│  │  - 服务端缓存 infid -> response                   │            │
│  └──────────────────────────────────────────────────┘            │
└──────────────────────────────────────────────────────────────────┘
```

### 2. 四层各防什么

| 层 | 防什么 | 不能防什么 |
|---|---|---|
| 分布式锁 | 并发（两线程同时处理） | 网络超时重复、Redis 故障 |
| DB 唯一索引 | 重复入库 | 状态错乱、超时重复 |
| 状态机幂等 | 状态跳跃 | 并发（需配合锁） |
| infid 幂等 | 网络超时重复 | 并发（需配合锁） |

**关键**：四层不可相互替代，必须叠加。

### 3. 完整代码实现

```java
@Service
@Slf4j
public class MiSettlementService {
    @Autowired private RedissonClient redisson;
    @Autowired private ExamOrderMapper orderRepo;
    @Autowired private MiIdempotentMapper idempotentRepo;
    @Autowired private MedicalInsuranceClient miClient;
    
    /**
     * 医保结算 - 四层防御
     */
    public SettlementResult settle(ExamOrder order) {
        // ===== Layer 1: 分布式锁（防并发）=====
        RLock lock = redisson.getLock("mi:settle:" + order.getOrderId());
        boolean locked = false;
        try {
            locked = lock.tryLock(5, 30, TimeUnit.SECONDS);
            if (!locked) {
                throw new BizException("获取锁失败，可能正在处理");
            }
            
            return doSettleWithTx(order);
            
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new BizException("获取锁中断");
        } finally {
            if (locked && lock.isHeldByCurrentThread()) {
                lock.unlock();
            }
        }
    }
    
    /**
     * 事务包裹的业务逻辑
     */
    @Transactional
    protected SettlementResult doSettleWithTx(ExamOrder order) {
        // ===== Layer 3: 状态机幂等（防错乱）=====
        if (order.getStatus() == ExamOrderStatus.SETTLED) {
            log.info("订单已结算，幂等返回");
            return SettlementResult.alreadySettled(order);
        }
        if (order.getStatus() != ExamOrderStatus.PENDING_SETTLE) {
            throw new BizException("订单状态非待结算: " + order.getStatus());
        }
        
        // ===== Layer 2: DB 唯一索引（防重复）=====
        String infid = InfidGenerator.generate("MI_SETTLE", 
            order.getOrderId().toString());
        
        MiIdempotent idempotent = new MiIdempotent();
        idempotent.setInfid(infid);
        idempotent.setBizType("MI_SETTLE");
        idempotent.setBizId(order.getOrderId().toString());
        idempotent.setStatus("PENDING");
        idempotent.setCreatedAt(LocalDateTime.now());
        
        try {
            idempotentRepo.insert(idempotent);
        } catch (DuplicateKeyException e) {
            // 已有记录，查询已有结果
            MiIdempotent existing = idempotentRepo.findByInfid(infid);
            if ("SUCCESS".equals(existing.getStatus())) {
                log.info("结算已成功，幂等返回");
                return SettlementResult.fromExisting(existing);
            }
            // 失败状态，可重试
            log.info("上次结算失败，重试");
        }
        
        // ===== Layer 4: infid 幂等（防超时）=====
        MiSettlementRequest req = buildRequest(order, infid);
        MiSettlementResponse resp;
        try {
            resp = miClient.settle(req);
        } catch (TimeoutException e) {
            // 超时，更新幂等表状态
            idempotentRepo.updateStatus(infid, "TIMEOUT");
            throw new BizException("医保结算超时，请稍后查询结果");
        }
        
        if (!resp.isSuccess()) {
            idempotentRepo.updateStatus(infid, "FAIL", resp.getErrorMsg());
            throw new BizException("医保结算失败: " + resp.getErrorMsg());
        }
        
        // ===== Layer 3: 状态机更新（CAS）=====
        int rows = orderRepo.updateStatus(
            order.getOrderId(),
            ExamOrderStatus.PENDING_SETTLE,  // 期望状态
            ExamOrderStatus.SETTLED,         // 新状态
            resp.getSettlementId()
        );
        if (rows == 0) {
            // 状态已变更，可能被其他线程处理
            // 但 Layer 1 锁已经防止了并发，这里不应该发生
            log.error("状态更新失败，可能并发问题");
            throw new BizException("状态更新失败");
        }
        
        // 更新幂等表
        idempotentRepo.updateStatus(infid, "SUCCESS", 
            JSON.toJSONString(resp));
        
        return SettlementResult.success(order, resp);
    }
}
```

### 4. 哪些场景可以简化

| 场景 | 简化方案 |
|---|---|
| 内部管理系统（低并发） | 仅 Layer 2 + Layer 3，无锁 |
| 单机应用 | 仅 Layer 2 + Layer 3，用本地锁 |
| 跨进程并发 | 必须 Layer 1（分布式锁） |
| 跨系统调用（医保接口） | 必须 Layer 4（infid 幂等） |
| 资金场景 | 必须 Layer 1-4 全叠加 |

> 内部管理系统的 SETNX 裸实现可以简化（用户业务背景），但资金场景必须四层叠加。

---

## 八、跨月不可撤销的工程实现

### 1. 跨月边界的本质

**医保按月清算流程**：

```text
T-1 月 25 日 0:00:00
  └─ 医保对账文件生成（包含 T-2 月所有结算）

T-1 月 25 日 - 30 日
  └─ 医院与医保对账

T-1 月 30 日 24:00:00（即 T 月 1 日 0:00）
  └─ "封账"：T-2 月的结算不可撤销

T 月 1 日 0:00:00
  └─ T-1 月的结算进入"对账中"状态

T 月 25 日 0:00:00
  └─ T-1 月对账文件生成

T 月 30 日 24:00:00
  └─ T-1 月封账
```

### 2. 跨月撤销的技术不可行性

```text
医保侧的状态：
T-1 月 30 日 23:59: 居民结算 -> 状态 SETTLED
T 月 1 日 0:00:00: 封账 -> 状态 FROZEN（已生成对账文件）

调撤销接口：
HIS -> 医保：revokeSettlement(settlementId)
医保：状态 FROZEN，拒绝撤销 -> 返回错误 ALREADY_FROZEN

医保侧拒绝原因：
1. 该结算已在对账文件中
2. 医保基金已拨付给医院
3. 撤销会破坏对账数据完整性
```

### 3. 跨月退费的业务流程

```text
┌──────────────────────────────────────────────────────────────────┐
│  跨月退费流程                                                     │
│                                                                    │
│  T0: 居民要求退款（已跨月）                                       │
│      - HIS 系统检测跨月，标记"需医保退费"                         │
│      - 生成退费工单                                               │
│                                                                    │
│  T1: 医院财务审核                                                 │
│      - 核对原始结算单                                             │
│      - 核对居民身份                                               │
│      - 审核退费原因                                               │
│      - 财务签字                                                   │
│                                                                    │
│  T2: 医院向医保申请退费                                           │
│      - 填写《医保退费申请表》                                     │
│      - 附原始结算单、居民身份证、退费原因                         │
│      - 提交到市医保中心                                           │
│                                                                    │
│  T3: 市医保中心审核                                               │
│      - 审核材料完整性                                             │
│      - 审核退费合理性                                             │
│      - 5-15 个工作日                                              │
│                                                                    │
│  T4: 医保退费                                                     │
│      - 退回到居民医保个人账户                                     │
│      - 生成《医保退费凭证》                                       │
│      - 通知医院财务                                               │
│                                                                    │
│  T5: 医院账务调整                                                 │
│      - 冲红原发票                                                 │
│      - 重开发票（如部分退费）                                     │
│      - 财务系统账务调整                                           │
│      - 更新 HIS 订单状态为"已退款"                                │
│                                                                    │
│  T6: 通知居民                                                     │
│      - 短信通知退费完成                                           │
│      - APP 推送退费凭证                                           │
└──────────────────────────────────────────────────────────────────┘
```

### 4. 防止跨月撤销尝试

**时间窗口校验**：

```java
public class MiSettlementService {
    
    public void revokeSettlement(ExamOrder order) {
        // 1. 状态校验
        if (order.getStatus() != ExamOrderStatus.SETTLED) {
            throw new BizException("订单状态非已结算");
        }
        
        // 2. 时间窗口校验
        LocalDate settleDate = order.getSettleTime().toLocalDate();
        LocalDate today = LocalDate.now();
        
        if (settleDate.getMonth() != today.getMonth() 
            || settleDate.getYear() != today.getYear()) {
            // 跨月，不能撤销
            log.warn("跨月撤销尝试: order={}, settleDate={}", 
                order.getOrderId(), settleDate);
            
            // 创建退费工单
            RefundTicket ticket = new RefundTicket();
            ticket.setOrderId(order.getOrderId());
            ticket.setType("CROSS_MONTH_REFUND");
            ticket.setStatus("PENDING");
            ticket.setDescription("跨月退费，需走医保退费流程");
            refundTicketRepo.save(ticket);
            
            throw new BizException("已跨月，不能撤销，已创建退费工单: " 
                + ticket.getId());
        }
        
        // 3. 调医保撤销
        MiRevokeResponse resp = miClient.revoke(order.getSettlementId());
        
        if (!resp.isSuccess()) {
            if ("ALREADY_FROZEN".equals(resp.getErrorCode())) {
                // 医保侧已封账
                applyMiManualRefund(order);
                return;
            }
            throw new BizException("医保撤销失败: " + resp.getMsg());
        }
        
        // 4. 更新状态
        orderRepo.updateStatus(order.getOrderId(), SETTLED, REFUNDED);
    }
}
```

### 5. 跨月退费的工程实现

```java
@Service
public class CrossMonthRefundService {
    @Autowired private RefundTicketMapper ticketRepo;
    @Autowired private HospitalFinanceService financeService;
    @Autowired private MiRefundClient miRefundClient;
    
    /**
     * 提交跨月退费申请
     */
    public RefundTicket submitRefund(ExamOrder order, String reason) {
        RefundTicket ticket = new RefundTicket();
        ticket.setOrderId(order.getOrderId());
        ticket.setType("CROSS_MONTH_REFUND");
        ticket.setStatus("PENDING_FINANCE");
        ticket.setReason(reason);
        ticket.setSettlementId(order.getSettlementId());
        ticket.setSettleTime(order.getSettleTime());
        ticket.setRefundAmount(order.getInsuranceAmount());
        ticket.setCreatedAt(LocalDateTime.now());
        
        ticketRepo.insert(ticket);
        
        // 通知财务审核
        notificationService.notifyFinance("新跨月退费工单: " + ticket.getId());
        
        return ticket;
    }
    
    /**
     * 财务审核
     */
    public void financeApprove(Long ticketId, String financeUser) {
        RefundTicket ticket = ticketRepo.findById(ticketId);
        if (ticket.getStatus() != "PENDING_FINANCE") {
            throw new BizException("工单状态非待财务审核");
        }
        
        // 财务签字
        ticket.setFinanceUser(financeUser);
        ticket.setFinanceApproveTime(LocalDateTime.now());
        ticket.setStatus("PENDING_MI");
        ticketRepo.save(ticket);
        
        // 提交医保退费申请
        submitMiRefund(ticket);
    }
    
    /**
     * 提交医保退费
     */
    private void submitMiRefund(RefundTicket ticket) {
        MiRefundRequest req = new MiRefundRequest();
        req.setSettlementId(ticket.getSettlementId());
        req.setRefundAmount(ticket.getRefundAmount());
        req.setReason(ticket.getReason());
        req.setApplyUser(ticket.getFinanceUser());
        
        MiRefundResponse resp = miRefundClient.apply(req);
        
        if (resp.isSuccess()) {
            ticket.setMiApplyNo(resp.getApplyNo());
            ticket.setStatus("MI_REVIEWING");
            ticket.setMiApplyTime(LocalDateTime.now());
        } else {
            ticket.setStatus("MI_REJECTED");
            ticket.setMiRejectReason(resp.getErrorMsg());
        }
        ticketRepo.save(ticket);
    }
    
    /**
     * 医保退费回调
     */
    @EventListener
    public void onMiRefundCallback(MiRefundCallbackEvent event) {
        RefundTicket ticket = ticketRepo.findByMiApplyNo(event.getApplyNo());
        
        if (event.isApproved()) {
            // 医保退费成功
            ticket.setStatus("MI_REFUNDED");
            ticket.setMiRefundTime(event.getRefundTime());
            ticketRepo.save(ticket);
            
            // 更新订单状态
            orderRepo.updateStatus(ticket.getOrderId(), SETTLED, REFUNDED);
            
            // 通知居民
            notificationService.notifyUser(ticket.getOrderId(), 
                "医保退费已完成，退费金额: " + ticket.getRefundAmount());
            
            // 触发账务调整
            financeService.adjustAccount(ticket);
        } else {
            ticket.setStatus("MI_REJECTED");
            ticket.setMiRejectReason(event.getRejectReason());
            ticketRepo.save(ticket);
            
            // 通知财务
            notificationService.notifyFinance(
                "医保退费被拒: " + ticket.getId() + ", 原因: " + event.getRejectReason());
        }
    }
}
```

---

## 九、异地重复结算的根因与防范

### 1. 异地就医直接结算链路

```text
┌──────────────────────────────────────────────────────────────────┐
│  异地就医直接结算完整链路                                          │
│                                                                    │
│  本地医院 HIS                                                     │
│      ↓ 调本地医保结算                                              │
│  本地医保系统（市医保中心）                                        │
│      ↓ 调国家平台"异地就医"接口                                    │
│  国家医保信息平台                                                  │
│      ↓ 转发到参保地                                                │
│  参保地医保系统                                                    │
│      ↓ 计算、扣款                                                  │
│      ↑ 返回结算结果                                                │
│  国家医保信息平台                                                  │
│      ↑ 转发结算结果                                                │
│  本地医保系统                                                      │
│      ↑ 返回结算结果                                                │
│  本地医院 HIS                                                      │
│      ↑ 展示结算单                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### 2. 数据同步延迟

```text
国家平台 -> 参保地医保的同步：

实时（T+0）：
- 理想状态
- 实现成本高（需要双写、CDC 等）
- 仅部分省份实现

准实时（T+1 小时）：
- 多数省份
- 每小时批量同步

日批（T+1）：
- 部分省份
- 每日凌晨批量同步前一日数据

延迟内的风险：
T0: 参保人在本地结算（国家平台 -> 参保地医保转发）
T0+1s: 本地医保收到结算成功
T0+1min: 参保地医保开始处理
T0+5min: 参保地医保完成扣款
T0+10min: 参保地医保查询系统更新（但部分查询接口延迟）
T0+30min: 参保人查询参保地医保，发现"未结算"
T0+35min: 参保人到参保地医保窗口办理退款
T0+40min: 参保地医保窗口发起结算（数据未同步）
T0+45min: 参保地医保也结算 -> 重复
```

### 3. 重复结算场景

```text
场景：张三，参保地北京，在杭州体检

T0: 张三在杭州某医院体检，结算 500 元
    - 杭州医保 -> 国家平台 -> 北京医保
    - 北京医保扣款 500 元
    - 杭州医院收到结算成功
    - 张三自付 50 元

T0+30min: 张三查询北京医保 APP，未看到本次结算（数据同步延迟）
T0+35min: 张三以为未结算，电话北京医保
T0+40min: 北京医保窗口查询，确实未显示
T0+45min: 北京医保窗口发起"撤销"
    - 但实际本次结算已成功，撤销失败
T0+50min: 北京医保窗口以为是系统故障，发起"重新结算"
    - 北京医保又扣款 500 元（?）

注：实际中医院不会"重新结算"，但参保人可能误操作。
更常见的场景是参保人到不同医院再次就诊，触发重复。
```

### 4. 防范机制

**参保地预校验**：

```java
public class CrossProvinceSettlementService {
    
    public SettlementResult settle(ExamOrder order) {
        // 1. 参保地预校验
        CrossProvinceCheckRequest req = new CrossProvinceCheckRequest();
        req.setIdCard(order.getResident().getIdCard());
        req.setSettleDate(LocalDate.now());
        req.setHomeProvince(order.getResident().getHomeProvince());
        
        CrossProvinceCheckResponse check = crossProvinceClient.check(req);
        if (check.isAlreadySettled()) {
            // 参保地已记录结算
            throw new BizException("参保地已结算，不能重复: " 
                + check.getExistingSettlementId());
        }
        
        // 2. 调本地结算
        return doSettle(order);
    }
}
```

**业务侧防重表**：

```sql
-- 跨省结算防重表
CREATE TABLE cross_province_settlement_idempotent (
    id_card_hash VARCHAR(64) NOT NULL,
    settle_date DATE NOT NULL,
    home_province VARCHAR(20) NOT NULL,
    settlement_id VARCHAR(64),
    settle_time DATETIME,
    PRIMARY KEY (id_card_hash, settle_date, home_province)
);

-- 本地结算前插入
INSERT INTO cross_province_settlement_idempotent 
VALUES ('hash_xxx', '2026-07-10', 'BEIJING', 'MI-123', NOW());
-- 唯一冲突 -> 已结算
```

**国家平台锁**：

```text
国家平台提供"跨省结算锁"接口：
- 入参：身份证 + 日期 + 参保地
- 加锁：5 分钟
- 释放：结算完成或超时

本地结算前先加锁：
1. 调国家平台加锁
2. 调本地结算
3. 调国家平台释放锁

锁内不允许其他地方发起结算
```

### 5. 跨省对账兜底

```text
T+1 跨省对账：

Step 1: 国家平台导出 T 日所有跨省结算记录
Step 2: 本地医保导出 T 日所有异地参保人结算
Step 3: 比对
  - 本地有，国家无 -> 本地结算失败？数据丢失？
  - 国家有，本地无 -> 国家平台误记？
  - 都有但金额不同 -> 数据错误
Step 4: 差错处理
  - 重复结算 -> 退费给参保人
  - 金额错误 -> 修正
Step 5: 通知参保人
  - 短信/APP 推送
```

---

## 十、四现象根因与解决方案

### 现象1：UUID 幂等键导致重复结算

**根因**：

```text
业务方用 UUID.randomUUID() 做 infid
- 每次重试生成新 UUID
- 医保侧识别为不同请求
- 重复执行结算

同时，HIS 侧的幂等表也是 UUID 主键
- 无法识别同一笔业务的多次重试
- 多次记录、多次调用医保
```

**解决方案**：

```java
// 错误：UUID
String infid = UUID.randomUUID().toString();

// 正确：基于业务 ID
public class InfidGenerator {
    public static String generate(String bizType, String bizId) {
        String date = LocalDate.now().format(DateTimeFormatter.BASIC_ISO_DATE);
        String raw = bizType + "_" + bizId + "_" + date;
        return "INF_" + DigestUtils.md5Hex(raw).substring(0, 16).toUpperCase();
    }
}

// 使用
String infid = InfidGenerator.generate("MI_SETTLE", order.getOrderId().toString());
// 同一笔订单，同一天的重试，infid 相同
```

### 现象2：看门狗续期失败导致重复结算

**根因**：

```text
1. 大促期间高并发，Redis 压力大
2. 看门狗 renewal 请求被 Redis 拒绝（连接池满）
3. 锁过期未续期 -> 释放
4. 其他窗口获取锁，处理同一笔结算
5. 重复扣款 7 笔
6. 其中 3 笔已跨月，无法撤销
```

**解决方案**：

```java
// Layer 1: 分布式锁（防并发）
RLock lock = redisson.getLock("mi:settle:" + order.getOrderId());
boolean locked = lock.tryLock(5, 30, TimeUnit.SECONDS);

// Layer 2: DB 唯一索引（防重复）
try {
    idempotentRepo.insert(idempotent);
} catch (DuplicateKeyException e) {
    // 锁释放后其他线程尝试插入，唯一索引兜底
    return handleExisting(idempotent);
}

// Layer 3: 状态机幂等（防错乱）
int rows = orderRepo.updateStatus(orderId, PENDING_SETTLE, SETTLED);
if (rows == 0) {
    // 状态已变更，可能是其他线程已处理
    throw new BizException("状态变更失败");
}

// Layer 4: infid 幂等（防超时）
String infid = InfidGenerator.generate(...);
MiSettlementResponse resp = miClient.settle(req);  // infid 相同 -> 返回相同结果
```

> 关键：分布式锁不可靠，必须配合 DB 唯一索引 + 状态机幂等 + infid 幂等。

### 现象3：唯一索引死锁

**根因**：

```text
并发插入相邻 infid：
- 事务 A 插入 inf-3
- 事务 B 插入 inf-4
- 两个事务都持有间隙锁 (inf-2, inf-5)
- 互相等待 -> 死锁
- MySQL 检测到死锁，回滚其中一个
- 100+ 笔被回滚
- 业务方超时重试 -> 雪崩
```

**解决方案**：

```sql
-- 方案 1：ON DUPLICATE KEY UPDATE（推荐）
INSERT INTO mi_settlement_idempotent (infid, biz_id, status, retry_count)
VALUES ('inf-123', 'biz-456', 'PENDING', 0)
ON DUPLICATE KEY UPDATE 
    retry_count = retry_count + 1,
    updated_at = NOW();

-- 方案 2：调整隔离级别为 READ COMMITTED
-- RC 下无间隙锁，但代价是失去重复读
SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED;

-- 方案 3：捕获 1062 错误（应用层）
try {
    idempotentRepo.insert(idempotent);
} catch (DuplicateKeyException e) {
    // 已存在，查询已有
    return repo.findByInfid(infid);
}
```

**防雪崩**：

```java
// 限流（Sentinel）
@SentinelResource(value = "miSettle", blockHandler = "blockHandler")
public SettlementResult settle(ExamOrder order) {
    // ...
}

public SettlementResult blockHandler(ExamOrder order, BlockException ex) {
    // 限流后返回友好提示，不抛异常
    return SettlementResult.rateLimited();
}

// 重试退避（避免雪崩）
@Retryable(value = {DeadlockException.class}, 
           maxAttempts = 3,
           backoff = @Backoff(delay = 100, multiplier = 2))
public void doSettle(ExamOrder order) {
    // ...
}
```

### 现象4：异地重复结算

**根因**：

```text
1. 本地与参保地医保数据同步延迟（T+1）
2. 参保人查询参保地医保，未看到本地结算
3. 参保人误以为未结算
4. 到参保地办理退款，触发重复结算
5. 两地医保都扣款
```

**解决方案**：

```java
// Layer 1: 参保地预校验
CrossProvinceCheckResponse check = crossProvinceClient.check(req);
if (check.isAlreadySettled()) {
    throw new BizException("参保地已结算");
}

// Layer 2: 业务侧防重表
try {
    crossProvinceIdempotentRepo.insert(record);
} catch (DuplicateKeyException e) {
    throw new BizException("本地已结算，请勿重复");
}

// Layer 3: 国家平台锁
NationalLock lock = nationalPlatformClient.lock(idCard, date, province);
try {
    doSettle(order);
} finally {
    lock.release();
}

// Layer 4: 跨省对账兜底
@Scheduled(cron = "0 0 6 * * ?")  // 每日 6 点
public void crossProvinceReconcile() {
    // 比对本地 vs 国家平台 T-1 日数据
    // 发现重复 -> 触发退费
}
```

---

## 十一、四防闭环架构图

```text
┌──────────────────────────────────────────────────────────────────┐
│  医保结算四防闭环架构                                              │
│                                                                    │
│  入口：结算请求                                                    │
│                                                                    │
│  ┌──────────────────────────────────────────────────┐            │
│  │  Layer 1: 分布式锁（Redisson）                    │            │
│  │  - 防并发（同一订单两线程同时处理）               │            │
│  │  - 锁粒度：order_id                              │            │
│  │  - TTL：30s + 看门狗续期                         │            │
│  └──────────────────────────────────────────────────┘            │
│                          ↓                                        │
│  ┌──────────────────────────────────────────────────┐            │
│  │  Layer 2: DB 唯一索引（业务唯一约束）             │            │
│  │  - 防重复（同一笔业务多次入库）                   │            │
│  │  - infid + biz_id 双重唯一                       │            │
│  │  - ON DUPLICATE KEY UPDATE 处理冲突              │            │
│  └──────────────────────────────────────────────────┘            │
│                          ↓                                        │
│  ┌──────────────────────────────────────────────────┐            │
│  │  Layer 3: 状态机幂等（CAS UPDATE）                │            │
│  │  - 防错乱（状态跳跃）                             │            │
│  │  - WHERE status = old_status                     │            │
│  │  - 状态白名单（PENDING_SETTLE -> SETTLED）       │            │
│  └──────────────────────────────────────────────────┘            │
│                          ↓                                        │
│  ┌──────────────────────────────────────────────────┐            │
│  │  Layer 4: infid 幂等（医保接口协议）              │            │
│  │  - 防超时（网络超时重复调用）                     │            │
│  │  - 基于业务 ID 生成 infid                        │            │
│  │  - 医保侧缓存 infid -> response                   │            │
│  └──────────────────────────────────────────────────┘            │
│                          ↓                                        │
│  出口：结算结果（已结算 / 已退款 / 失败）                          │
│                                                                    │
│  ┌──────────────────────────────────────────────────┐            │
│  │  兜底：跨月退费工单 + 异地对账                    │            │
│  │  - 跨月不可撤销 -> 退费工单 -> 医保审核           │            │
│  │  - 异地重复 -> 跨省对账 -> 退费                   │            │
│  └──────────────────────────────────────────────────┘            │
└──────────────────────────────────────────────────────────────────┘
```

---

## 十二、与第5周支付幂等深挖的对比

| 维度 | 第5周支付幂等 | 本周医保结算 |
|---|---|---|
| 幂等键 | 商户订单号 | infid + biz_id |
| 防并发 | Redisson 分布式锁 | Redisson 分布式锁（一致） |
| 防重复 | DB 唯一索引 | DB 唯一索引（一致） |
| 防错乱 | 状态机幂等 | 状态机幂等（一致） |
| 防超时 | 商户订单号 + 支付单号 | infid 幂等（更强） |
| 跨月限制 | 无 | **跨月不可撤销** |
| 异地重复 | 无 | **跨省重复风险** |
| 兜底 | T+1 对账 | T+1 对账 + 跨月退费 + 跨省对账 |

> 架构师要点：医保结算比商业支付更复杂。商业支付四防闭环 + 双方对账；医保结算四防闭环 + 三方对账 + 跨月退费 + 跨省对账。能驾驭医保结算的架构师，可以驾驭任何资金场景。

---

## 十三、本周总结

### 核心收获

1. **四防闭环**：分布式锁（防并发）+ DB 唯一索引（防重复）+ 状态机幂等（防错乱）+ infid 幂等（防超时）
2. **不可相互替代**：四层各防不同问题，必须叠加
3. **infid 业务生成**：不能用 UUID，必须基于业务 ID
4. **锁在事务外**：分布式锁必须"包住"事务，不能被事务包住
5. **ON DUPLICATE KEY UPDATE**：避免 INSERT IGNORE 静默失败 + 死锁
6. **状态机白名单**：用 status 字段不用 version 字段，防止状态跳跃
7. **跨月不可撤销**：医保按月清算，跨月走"退费"流程
8. **异地重复结算**：数据同步延迟 + 参保地预校验 + 跨省对账
9. **兜底机制**：人工兜底是最后一道防线，必须设计

### 架构师能力体现

| 能力 | 体现 |
|---|---|
| **底层原理** | SETNX / Lua / B+Tree / CAS / infid 协议 |
| **边界 case** | 看门狗续期失败 / 唯一索引死锁 / 跨月不可撤销 / 异地重复 |
| **工程选型** | 四层叠加 vs 简化方案的选择 |
| **资金安全** | 跨月退费 + 跨省对账兜底 |
| **可观测性** | 全链路追踪 + 监控告警 |

### 跳槽价值

Day7 医保结算底层原理是医疗信息化架构师的**顶层能力**：
- 能讲清"四防闭环"的架构师，能驾驭任何资金场景
- 能讲清"跨月不可撤销"的架构师，懂医保业务本质
- 能讲清"异地重复结算"的架构师，懂跨域一致性
- 与第5周支付幂等深挖形成"商业支付 + 医保支付"复合能力
- 跳槽到三甲医疗信息化公司的**核心竞争力**

---

## 十四、本周医疗信息化专题完成度

| Day | 主题 | 完成度 | 核心能力 |
|---|---|---|---|
| Day1 | 智慧体检业务架构 | ✓ | 业务建模、多机构 SaaS |
| Day2 | HIS/EMR 对接 | ✓ | 医疗系统协同、CDA、EMPI |
| Day3 | HL7/FHIR 标准 | ✓ | 互操作标准、Mirth、SMART |
| Day4 | DICOM/PACS | ✓ | 影像标准、Orthanc、AI 辅诊 |
| Day5 | 医保对接 | ✓ | 三段式结算、HOS、混合支付 |
| Day6 | 串联整合 | ✓ | 全链路架构、多标准协同 |
| Day7 | 架构深挖 | ✓ | 四防闭环、跨月退费、异地对账 |

**本周能力画像**：

```text
医疗信息化架构师能力画像（基于本周学习）

业务能力：
- 智慧体检全链路（业务+医疗+影像+资金）
- 多机构 SaaS 设计
- 多付费模式（公卫/商业/医保/混合）

技术能力：
- 医疗标准：HL7/FHIR/DICOM/国标 协同
- 系统对接：HIS/EMR/LIS/PACS/医保/商保
- 集成引擎：Mirth Connect
- 影像系统：Orthanc、DICOMweb、AI 辅诊
- FHIR Server：HAPI FHIR

资金能力：
- 医保结算：三段式、HOS 接口
- 混合支付：Saga 补偿事务
- 三方对账：医保+商保+商业支付
- 幂等设计：四防闭环

架构能力：
- 分布式：多 AZ、异地容灾、断网缓存
- 可观测性：全链路追踪、监控告警
- 资金安全：跨月退费、跨省对账

合规能力：
- 等保三级、医疗数据合规
- 监管上报：公卫、医保、疾控
```

**跳槽目标**：三甲医疗信息化公司（卫宁、东软、创业慧康、嘉和美康、医为）的架构师岗位，能讲清本周内容的 80%+，是强竞争力。