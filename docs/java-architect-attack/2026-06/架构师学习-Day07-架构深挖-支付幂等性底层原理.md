# Day 7：架构深挖 —— 支付幂等性底层原理与三防闭环

## 一、今日主题

本周支付专题已完成从架构到资金的完整闭环：

```text
Day1：支付系统整体架构与核心模块设计（接入/核心/渠道/账务四层）
Day2：支付幂等性设计与重复支付防护（8 个幂等点、幂等键全链路、幂等表）
Day3：支付对账与差错处理（T+1 离线对账、长款/短款/单边账）
Day4：支付渠道路由与智能选择设计（5 层漏斗、规则引擎、动态权重）
Day5：清结算与资金核算设计（清算/结算/核算/对账四层、备付金）
Day6：串联整合 —— 支付系统全链路架构设计与资金安全闭环
```

Day2 讲了"幂等设计"——8 个幂等点、幂等键全链路传递、幂等表字段设计。今天 Day7 不再讲"设计在哪一层"，而是深挖一个贯穿 Day2/Day3/Day5 的底层命题：

```text
同样是"防重复"，分布式锁、DB 唯一索引、状态机幂等 三者的底层实现是什么？
各自的并发原语、边界 case、性能代价、可靠性边界在哪？
为什么生产级支付系统必须三层叠加，而不是任选其一？
```

这道题考察的不是"会不会用 Redisson"，而是你能不能把背后的：

```text
并发原语（SETNX 的单线程模型 / B+Tree 唯一约束 / CAS 乐观锁）
边界 case（看门狗续期失败 / 唯一索引死锁 / 悬挂与空回滚）
可靠性边界（Redis 主从切换丢锁 / MySQL 主备延迟 / 状态机的"已终态"）
工程选型（防并发 vs 防重复 vs 防错乱，三层各防什么）
```

讲清楚。结合用户业务背景：蛋壳钱包 TCC、ToC 核心业务 Redisson、内部管理系统 SETNX 裸实现——三套实践正好覆盖三种机制的踩坑现场。

---

## 二、题目：支付幂等性三防闭环的底层原理深挖

你负责维护蛋壳钱包收银台的幂等中台，线上反馈四个现象：

```text
现象1：某业务方重试导致重复扣款 13 笔，资损 4.2w
       排查发现：业务方用 UUID.randomUUID() 做幂等键，每次重试都不一样

现象2：大促期间 Redisson 看门狗续期失败，导致分布式锁提前释放
       同笔支付订单被两个线程同时处理，渠道重复下单 7 笔

现象3：账务系统用 DB 唯一索引防重复记账，但并发场景下出现死锁
       ERROR 1213: Deadlock found when trying to get lock; try restarting transaction
       100+ 笔交易被回滚，业务方超时重试引发雪崩

现象4：TCC 二阶段 Cancel 在 Try 之前到达（悬挂）
       后续 Try 一直成功执行，资金被预留但永不扣减，对账才发现
```

现在要求你：

```text
从分布式锁、DB 唯一索引、状态机幂等 三种机制的底层原理出发，
解释清楚上述四个现象的根因，并给出架构师视角的三防闭环设计与替代方案。
```

---

## 三、需要回答的问题

### 1. 三种幂等机制的底层原理分别是什么？

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
为什么"状态机幂等"才是支付场景的"最终防线"
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

CAS UPDATE 的"乐观锁"为什么比 SELECT FOR UPDATE 更适合支付场景？
ABA 问题在支付场景下是否存在？为什么 status 字段比 version 字段更可靠？
```

### 3. 边界 case 与异常场景

重点说明：

```text
锁续期失败：看门狗机制什么场景下会失效？（GC 长停顿 / 网络分区 / Redis 主从切换）
锁与事务的边界：锁在事务外还是事务内？为什么"锁在事务外"才是正确姿势？
锁重入：Redisson 为什么用 Hash 结构而不是 String？

唯一索引冲突的并发处理：INSERT IGNORE 的"静默失败"为什么反而危险？
死锁场景：唯一索引并发插入为什么容易死锁？如何用 INSERT ... ON DUPLICATE KEY UPDATE 避免？

TCC 三大边界：悬挂、空回滚、幂等的底层逻辑
状态机的"已终态"处理：为什么 Cancel 到达时必须先检查"是否 Try 过"？
```

### 4. 三层防御的工程选型与组合

重点说明：

```text
分布式锁防"并发"——同一时刻只允许一个请求进入临界区
DB 唯一索引防"重复"——同笔业务请求只能落库一次
状态机防"错乱"——状态流转必须符合状态机定义，不能逆向

为什么三层必须叠加？少任何一层会怎样？
   只有锁：锁释放后重试还是会重复
   只有索引：并发插入死锁，TPS 撑不住
   只有状态机：不能防"重复请求"，只能防"状态错乱"

性能对比：三种机制各自的 TPS、延迟、可靠性
组合姿势：锁在事务外，索引在事务内，状态机在事务内

三层各自的失败模式与降级方案
```

### 5. 四个线上现象的根因与解决方案

针对每个现象：

```text
现象1（UUID 幂等键）：业务方生成幂等键的规范缺失
现象2（看门狗续期失败）：Redisson 锁的可靠性边界
现象3（唯一索引死锁）：B+Tree 唯一约束的并发陷阱
现象4（TCC 悬挂）：二阶段到达顺序的"前置检查"缺失
```

---

## 四、作答区

### 1. 三种幂等机制的底层原理

#### 1.1 Redis SETNX 与 Redisson 看门狗

**Redis SETNX 的底层**：

```text
SETNX key value
  → 如果 key 不存在，设置 key=value，返回 1
  → 如果 key 已存在，不做任何操作，返回 0
```

底层依赖 Redis 的**单线程模型**：所有命令在 Redis Server 内部串行执行，不存在并发竞争。SETNX 的"检查 + 设置"两步在 Redis 内部是一个原子操作。

但单纯 SETNX 有一个问题：**如果客户端设置锁后崩溃，锁会永久持有**。所以早期方案是 `SETNX + EXPIRE` 两步，但这破坏了原子性——SETNX 成功后、EXPIRE 之前客户端崩溃，锁就泄漏了。

Redis 2.6.12 起支持 `SET key value NX PX 30000`，把"检查 + 设置 + 过期"合并为一个原子命令：

```bash
SET lock_key lock_value NX PX 30000
  NX：不存在才设置（等价于 SETNX）
  PX 30000：过期时间 30 秒（毫秒）
```

**EVAL Lua 的原子性**：

当需要"检查 + 设置 + 多 key 操作"时，SET 已不够用。Redis 提供 EVAL 执行 Lua 脚本，**Lua 脚本在 Redis 内部是原子执行的**（其他客户端命令会被阻塞到 Lua 执行完）。

Redisson 加锁的核心 Lua 脚本（简化版）：

```lua
-- KEYS[1] = 锁 key, ARGV[1] = 锁值, ARGV[2] = 过期时间, ARGV[3] = 重入标识
if redis.call('exists', KEYS[1]) == 0 then
    -- 锁不存在，直接获取
    redis.call('hset', KEYS[1], ARGV[3], 1)
    redis.call('pexpire', KEYS[1], ARGV[2])
    return nil
end
if redis.call('hexists', KEYS[1], ARGV[3]) == 1 then
    -- 锁存在且是当前线程持有，重入计数 +1
    redis.call('hincrby', KEYS[1], ARGV[3], 1)
    redis.call('pexpire', KEYS[1], ARGV[2])
    return nil
end
-- 锁被其他线程持有，返回锁的剩余 TTL（用于计算等待时间）
return redis.call('pttl', KEYS[1])
```

**为什么用 Hash 而不是 String？** 因为要支持**重入**：Hash 字段 = `thread_id`，value = `重入次数`。同一线程可以多次加锁，每次重入次数 +1，解锁时 -1，归零时删除。

**Redisson 看门狗机制**：

加锁时如果没指定 leaseTime（或指定为 -1），会启动一个**续期任务**：每隔 1/3 TTL（默认 10s）自动把锁的 TTL 续回 30s。

```java
// Redisson 加锁源码（简化）
private void lock(long leaseTime, TimeUnit unit, boolean interruptibly) {
    long threadId = Thread.currentThread().getId();
    Long ttl = tryAcquire(leaseTime, unit, threadId);  // 执行 Lua 脚本
    if (ttl == null) {
        // 加锁成功
        return;
    }
    // 加锁失败，订阅 unlock channel，等待
    ...
}

// 看门狗续期任务
private void scheduleExpirationRenewal(long threadId) {
    ExpirationEntry entry = new ExpirationEntry();
    ExpirationEntry oldEntry = EXPIRATION_RENEWAL_MAP.putIfAbsent(getEntryName(), entry);
    if (oldEntry != null) entry = oldEntry;
    entry.addThreadId(threadId);
    
    // 用 Netty HashedWheelTimer 调度延迟任务
    Timeout task = commandExecutor.getConnectionManager()
        .newTimeout(new TimeoutTask() {
            public void run(Timeout t) {
                // Lua 脚本：检查锁是否还属于当前线程，是则续期
                RFuture<Boolean> future = renewExpirationAsync(threadId);
                future.onComplete((res, e) -> {
                    if (res) {
                        // 续期成功，重新调度下一次
                        scheduleExpirationRenewal(threadId);
                    }
                    // 续期失败，不再续期（锁即将过期）
                });
            }
        }, internalLockLeaseTime / 3, TimeUnit.MILLISECONDS);
}
```

**为什么用 Netty HashedWheelTimer 而不是 ScheduledExecutorService？**

- ScheduledExecutorService 内部用 DelayQueue（基于堆），添加/取消任务 O(log n)
- HashedWheelTimer 是时间轮，添加/取消任务 O(1)，适合"大量延迟任务 + 精度要求不高"的场景
- Redisson 一个 ConnectionManager 管理成千上万个锁，每个锁一个续期任务，时间轮性能更好

**Redlock 算法**（Redisson 多主模式）：

```text
1. 客户端记录开始时间 T0
2. 依次向 N（通常 5）个独立 Redis 实例请求 SET NX PX
3. 至少 N/2+1 个实例加锁成功，且总耗时 < TTL，则认为加锁成功
4. 否则向所有实例发起 DEL 释放锁
```

Redlock 的核心假设：**时钟同步**。但 Martin Kleppmann 在 2016 年的批评中指出：GC 长停顿、时钟跳变、主从切换都会破坏这个假设。生产环境 Redlock 的可靠性低于 ZK/etcd 的分布式锁，但性能更高。

#### 1.2 MySQL 唯一索引的底层

**B+Tree 唯一约束**：

MySQL InnoDB 的唯一索引是一棵 B+Tree，叶子节点按索引键有序排列。插入一条记录时：

```text
1. 从 root 节点开始，按索引键定位到叶子节点（B+Tree 查找）
2. 在叶子节点上检查唯一约束：
   - 如果找到相同 key 的记录 → 报错 1062（Duplicate entry）
   - 否则在叶子节点上插入新记录
3. 插入可能触发页分裂（page split）
```

**关键点：唯一约束检查不是"先查后插"，而是"插入时检查"**。InnoDB 在 B+Tree 的插入路径上同步完成约束检查，所以是原子的。

**唯一索引的死锁场景**：

两个并发事务同时插入不同但相邻的 key，在 B+Tree 叶子节点上需要 next-key lock（行锁 + 间隙锁），可能互相等待对方释放间隙锁，触发死锁检测。

```sql
-- 表结构
CREATE TABLE idempotent_record (
  idempotent_key VARCHAR(64) PRIMARY KEY,
  biz_order_no VARCHAR(64),
  status VARCHAR(16),
  UNIQUE KEY uk_biz (biz_order_no)
);

-- 事务 A
BEGIN;
INSERT INTO idempotent_record (idempotent_key, biz_order_no, status)
VALUES ('k1', 'order_001', 'INIT');
-- 还没 COMMIT

-- 事务 B（并发）
BEGIN;
INSERT INTO idempotent_record (idempotent_key, biz_order_no, status)
VALUES ('k2', 'order_002', 'INIT');
-- 阻塞，等待事务 A 释放 next-key lock
-- 如果事务 A 也阻塞在 B 持有的某个锁上，死锁
```

**INSERT IGNORE / ON DUPLICATE KEY / REPLACE INTO 的差异**：

| 语法 | 语义 | 冲突时行为 | 适用场景 |
|---|---|---|---|
| `INSERT IGNORE` | 忽略冲突 | 静默跳过，返回 0 行受影响 | 幂等记录（不关心是否冲突） |
| `INSERT ... ON DUPLICATE KEY UPDATE` | 冲突则更新 | 更新指定字段 | UPSERT 场景 |
| `REPLACE INTO` | 冲突则替换 | DELETE 旧行 + INSERT 新行 | 完全覆盖（注意触发器副作用） |

**INSERT IGNORE 的"静默失败"为什么反而危险？** 因为业务方拿到 0 行受影响，无法区分"重复请求"和"字段不合法被忽略"，容易把校验失败当幂等成功处理。

**支付场景推荐**：`INSERT ... ON DUPLICATE KEY UPDATE status=IF(status='INIT', 'PROCESSING', status)` —— 利用 IF 函数做状态机校验，冲突时只有 INIT 状态才更新。

#### 1.3 状态机幂等（CAS UPDATE）

**核心思想**：用 UPDATE 的 WHERE 子句做"检查 + 更新"原子操作，避免"先 SELECT 再 UPDATE"的并发问题。

```sql
-- 错误姿势：先查后改（非原子）
SELECT status FROM pay_order WHERE pay_order_no = 'xxx';
-- 此时其他线程可能已经改了 status
UPDATE pay_order SET status='SUCCESS' WHERE pay_order_no='xxx';
-- 状态可能被覆盖

-- 正确姿势：CAS UPDATE（原子）
UPDATE pay_order
SET status='SUCCESS', update_time=NOW()
WHERE pay_order_no='xxx' AND status='PROCESSING';
-- 返回 affected_rows
-- =1：状态机匹配，更新成功
-- =0：状态机不匹配（已 SUCCESS / 已 FAILED / 不存在），幂等跳过
```

**为什么 status 字段比 version 字段更可靠？**

```text
version 字段（通用乐观锁）：
  UPDATE ... SET version=version+1 WHERE id=x AND version=old_version
  → 防止"丢失更新"，但不限制状态流转方向
  → 可能出现"SUCCESS → PROCESSING"的逆向状态

status 字段（状态机乐观锁）：
  UPDATE ... SET status='SUCCESS' WHERE id=x AND status='PROCESSING'
  → 既防丢失更新，又强制状态机方向
  → SUCCESS 状态下的任何 UPDATE 都返回 0 行（已终态，拒绝一切变更）
```

支付场景下，**状态机比通用乐观锁更可靠**：因为支付订单有明确的状态机（INIT→PROCESSING→SUCCESS/FAILED），逆向流转永远是 bug。status 字段天然防逆向，version 字段不能。

**ABA 问题在支付场景下是否存在？**

通用 CAS 有 ABA 问题：线程 1 读到 A，线程 2 把 A 改成 B 再改回 A，线程 1 CAS 成功，但中间状态丢失。但支付场景下：

```text
status=PROCESSING → SUCCESS → FAILED → SUCCESS 这种逆向流转不应该出现
所以用 status 字段做 CAS，ABA 不存在（因为状态机不允许逆向）
如果用 version 字段，ABA 仍可能存在（version 可以任意变化）
```

所以支付场景下，status 字段 CAS 既防并发又防 ABA，比 version 字段更优。

#### 1.4 三层防御的关系

```text
┌─────────────────────────────────────────────────────────────┐
│  外层：分布式锁（防并发）                                       │
│  同一时刻只允许一个请求进入临界区，挡住 99% 的并发请求            │
│  失败模式：锁续期失败、主从切换丢锁、Redlock 时钟问题            │
├─────────────────────────────────────────────────────────────┤
│  中层：DB 唯一索引（防重复）                                    │
│  同笔业务请求只能落库一次，挡住锁失效后的并发重复                 │
│  失败模式：唯一索引冲突死锁、主备延迟                            │
├─────────────────────────────────────────────────────────────┤
│  内层：状态机幂等（防错乱）                                     │
│  状态流转必须符合状态机定义，挡住重复回调、消息重投                │
│  失败模式：状态机定义错误（如允许逆向流转）                       │
└─────────────────────────────────────────────────────────────┘
```

**三层各防什么**：

| 层级 | 防什么 | 不防什么 |
|---|---|---|
| 分布式锁 | 防并发（同一时刻多个请求） | 不防"锁释放后的重复请求" |
| DB 唯一索引 | 防重复（同笔业务多次落库） | 不防"状态错乱"（同笔订单 INIT→SUCCESS→FAILED） |
| 状态机幂等 | 防错乱（状态流转方向） | 不防"重复请求"（已终态的请求被拒绝，但请求本身到达） |

**为什么三层必须叠加？少任何一层会怎样？**

```text
只有锁：
  锁释放后渠道回调重投，仍然会重复处理
  Redis 主从切换丢锁，两个线程同时进入临界区
  
只有索引：
  并发请求都尝试 INSERT，冲突时一个成功一个失败
  失败的请求重试又冲突，TPS 撑不住
  死锁概率上升
  
只有状态机：
  不能防"重复请求"，已终态的请求被拒绝，但前端不知道
  用户连点 5 次，前 1 次成功，后 4 次失败，用户体验差
  重复回调每次都查 DB，DB 压力大
```

### 2. 各种机制的并发原语与原子性保证

#### 2.1 Redis 单线程模型与 Lua 原子性

Redis 的"单线程"指的是**命令执行线程**（实际上 Redis 6.0 后有 IO 多线程，但命令执行仍是单线程）。所有命令在一个线程内串行执行，所以单条命令天然原子。

**MULTI/EXEC 事务 vs EVAL Lua**：

```text
MULTI/EXEC 事务：
  - MULTI 开启事务，后续命令入队，EXEC 原子执行
  - 不支持"条件分支"（如果 key 存在则 A 否则 B）
  - 命令入队期间不能读取结果（无法基于上一步结果决定下一步）
  - WATCH 实现乐观锁，但只能"全或无"，不能复杂条件

EVAL Lua：
  - 整个脚本作为一个命令在单线程内执行
  - 支持条件分支、循环、复杂逻辑
  - 执行期间其他客户端命令阻塞（不能太长，否则影响其他请求）
  - 是 Redisson、分布式锁、限流等场景的标准姿势
```

**Redisson 加锁为什么必须用 Lua？** 因为加锁是"检查 + 设置 + 续期"三步，必须原子。MULTI/EXEC 不能基于"key 是否存在"做分支，所以只能用 Lua。

#### 2.2 B+Tree 唯一约束的并发控制

InnoDB 在唯一索引插入时，需要在 B+Tree 节点上加**next-key lock**（行锁 + 间隙锁）来防止并发插入导致的唯一约束破坏。

```text
事务 A 插入 key=100：
  1. 在 B+Tree 上定位到 (95, 100) 的间隙
  2. 加 next-key lock (95, 100]
  3. 检查唯一约束：没有冲突
  4. 插入记录

事务 B 并发插入 key=99：
  1. 定位到 (95, 99) 的间隙
  2. 想加 next-key lock (95, 99]，但被事务 A 的 (95, 100] 阻塞
  3. 等待事务 A 提交
```

**死锁场景**：

```text
事务 A 插入 key=100，加 (95, 100] next-key lock
事务 B 插入 key=101，加 (100, 101] next-key lock
事务 A 想再插入 key=101 → 等待 B
事务 B 想再插入 key=100 → 等待 A
死锁！
```

**避免死锁的姿势**：

```sql
-- 1. 用 INSERT ... ON DUPLICATE KEY UPDATE，减少重试
INSERT INTO idempotent_record (idempotent_key, biz_order_no, status)
VALUES ('k1', 'order_001', 'INIT')
ON DUPLICATE KEY UPDATE status=IF(status='INIT', 'PROCESSING', status);

-- 2. 业务层先查一次（虽然不能完全避免，但能减少冲突）
SELECT 1 FROM idempotent_record WHERE idempotent_key='k1';
-- 如果存在，直接走幂等跳过分支
-- 如果不存在，再 INSERT ... ON DUPLICATE KEY UPDATE

-- 3. 用 Redis 分布式锁先把并发请求串行化（外层防御）
```

#### 2.3 CAS UPDATE 的乐观锁原理

**SELECT FOR UPDATE 悲观锁 vs CAS UPDATE 乐观锁**：

```sql
-- 悲观锁（先锁后改）
BEGIN;
SELECT * FROM pay_order WHERE pay_order_no='xxx' FOR UPDATE;  -- 加 X 锁
-- 业务逻辑
UPDATE pay_order SET status='SUCCESS' WHERE pay_order_no='xxx';
COMMIT;
-- 问题：锁持有时间长，并发吞吐低；如果忘记 COMMIT，锁泄漏

-- 乐观锁（CAS UPDATE）
UPDATE pay_order SET status='SUCCESS', update_time=NOW()
WHERE pay_order_no='xxx' AND status='PROCESSING';
-- 一次 SQL 完成"检查 + 更新"，锁持有时间极短（仅 SQL 执行期间）
```

**支付场景为什么 CAS UPDATE 更好？**

```text
1. 锁持有时间短：只锁 UPDATE 涉及的行，且 SQL 执行完立即释放
2. 性能高：TCC 的 Confirm/Cancel 阶段，QPS 高但状态变更简单
3. 天然幂等：affected_rows=0 即"状态不匹配"，无需额外查询
4. 防逆向流转：status 字段限制了状态机方向
```

### 3. 边界 case 与异常场景

#### 3.1 Redisson 看门狗的失效场景

**场景一：GC 长停顿**

```text
T0：客户端加锁成功，TTL=30s，看门狗调度 10s 后续期
T0+5s：客户端 Full GC，停顿 25s
T0+30s：锁过期，其他线程拿到锁
T0+30s：客户端 GC 结束，看门狗续期（成功！因为它还持有锁的 hash 字段）
       → 但实际上锁已经被其他线程持有，续期会失败（Lua 脚本检查 thread_id）
       → 看门狗续期失败，不再续期
       → 但客户端业务逻辑还在执行，可能写入脏数据
```

**根本问题**：GC 长停顿导致客户端"假死"，锁过期但客户端不知道，恢复后继续执行业务逻辑，可能写入脏数据。

**解决方案**：

```text
1. 业务逻辑加"锁有效性检查"：执行关键操作前再检查一次锁是否还属于自己
2. 业务逻辑加" fencing token "：每次加锁返回一个递增 token，下游服务校验 token
3. 缩短锁持有时间：把锁的粒度做小，业务逻辑尽量短
4. 用 ZK/etcd 替代 Redis：基于 session 而非 TTL，GC 停顿时 session 失效
```

**场景二：Redis 主从切换丢锁**

```text
T0：客户端向 Master 加锁成功
T0+1ms：Master 准备异步同步给 Slave，但还没同步
T0+2ms：Master 宕机，Sentinel 把 Slave 提升为 Master
T0+3ms：Slave 上没有这把锁
T0+5ms：另一个客户端向新 Master 加锁成功
       → 两个客户端同时持有锁
```

**根本问题**：Redis 主从异步复制，锁信息可能丢失。

**解决方案**：

```text
1. 用 Redlock：多数派加锁，至少 N/2+1 个实例持有锁才算成功
2. 用 ZK/etcd：基于 Raft/ZAB 共识算法，强一致
3. 接受这个风险，用 DB 唯一索引 + 状态机做兜底
```

**场景三：网络分区**

```text
T0：客户端加锁成功
T0+1s：网络分区，客户端与 Redis 断连
T0+30s：锁过期，其他线程拿到锁
T0+35s：网络恢复，客户端继续执行业务逻辑（不知道锁已过期）
```

**根本问题**：客户端无法感知锁过期。

**解决方案**：

```text
1. Redisson 在锁过期时会抛出 IllegalMonitorStateException
   业务方需要捕获并处理（重新加锁或放弃操作）
2. 关键操作前调用 lock.isLocked() 检查
3. 用 fencing token
```

#### 3.2 锁与事务的边界

**错误姿势：锁在事务内**

```java
@Transactional
public void pay(String payOrderNo) {
    RLock lock = redisson.getLock("pay:" + payOrderNo);
    lock.lock();
    try {
        // 业务逻辑
    } finally {
        lock.unlock();
    }
}
// 问题：
// 1. 事务提交在 lock.unlock() 之后，但 unlock 是先于 commit 的
//    锁释放后、事务提交前，其他线程拿到锁，看到的是未提交的数据（脏读）
// 2. 或者：事务还没 commit，其他线程拿到锁，发现订单状态还是 PROCESSING
//    重复处理
```

**正确姿势：锁在事务外**

```java
public void pay(String payOrderNo) {
    RLock lock = redisson.getLock("pay:" + payOrderNo);
    lock.lock();
    try {
        transactionTemplate.execute(status -> {
            // 业务逻辑
            return null;
        });
    } finally {
        lock.unlock();
    }
}
// 锁持有期间事务已 commit，其他线程拿到锁时能看到最新数据
```

**关键原则**：**锁的生命周期必须包含事务的完整生命周期**。锁先于事务获取，事务先于锁释放。

#### 3.3 唯一索引的死锁与解决方案

**死锁场景复现**：

```sql
-- 表
CREATE TABLE idempotent (
  id BIGINT PRIMARY KEY,
  idempotent_key VARCHAR(64),
  UNIQUE KEY uk_key (idempotent_key)
);

-- 事务 A
BEGIN;
INSERT INTO idempotent VALUES (1, 'k1');

-- 事务 B（并发）
BEGIN;
INSERT INTO idempotent VALUES (2, 'k2');

-- 事务 A
INSERT INTO idempotent VALUES (3, 'k3');  -- 阻塞

-- 事务 B
INSERT INTO idempotent VALUES (4, 'k4');  -- 阻塞
-- 死锁！
```

**根因**：B+Tree 叶子节点上的 next-key lock 互相等待。

**解决方案**：

```sql
-- 方案1：用 INSERT ... ON DUPLICATE KEY UPDATE，单语句原子
INSERT INTO idempotent (id, idempotent_key) VALUES (1, 'k1')
ON DUPLICATE KEY UPDATE id=id;

-- 方案2：业务层先查（虽然不能完全避免，但能减少冲突概率）
SELECT 1 FROM idempotent WHERE idempotent_key='k1';
if (exists) return;  // 幂等跳过
INSERT INTO idempotent (id, idempotent_key) VALUES (1, 'k1');

-- 方案3：用 Redis 分布式锁串行化（外层防御）
```

#### 3.4 TCC 三大边界：悬挂、空回滚、幂等

**TCC 三阶段**：

```text
Try：资源预留（冻结金额）
Confirm：业务确认（扣减冻结金额）
Cancel：业务回滚（解冻金额）
```

**TCC 三大边界 case**：

```text
1. 悬挂（Suspension）
   场景：Cancel 在 Try 之前到达
   原因：Try 请求网络超时，TCC Manager 等不到响应，触发 Cancel
        但 Try 请求其实还在路上，Cancel 之后才到达
   后果：Try 成功执行，资源被预留，但 Confirm/Cancel 不会再到达
        资源永远无法释放
   解决：Cancel 时插入"已 Cancel"记录，Try 时检查"是否已 Cancel"

2. 空回滚（Empty Rollback）
   场景：Cancel 时 Try 没有执行（或失败）
   原因：Try 失败后 TCC Manager 仍然触发 Cancel
   后果：Cancel 试图解冻不存在的冻结金额，业务异常
   解决：Cancel 时检查"是否 Try 过"，没有则跳过（空回滚）

3. 幂等（Idempotency）
   场景：Confirm/Cancel 被重试
   原因：网络超时，TCC Manager 重试
   后果：重复扣减/解冻，资金错乱
   解决：用事务状态机做幂等（CAS UPDATE WHERE status=...）
```

**TCC 状态机表设计**：

```sql
CREATE TABLE tcc_transaction (
  xid VARCHAR(64) PRIMARY KEY,         -- 全局事务 ID
  biz_id VARCHAR(64),                  -- 业务 ID
  status VARCHAR(16),                  -- INIT / TRYING / TRIED / CONFIRMED / CANCELLED
  try_count INT DEFAULT 0,
  confirm_count INT DEFAULT 0,
  cancel_count INT DEFAULT 0,
  version INT DEFAULT 0,
  UNIQUE KEY uk_biz (biz_id)
);

-- Try 阶段（防悬挂）
INSERT INTO tcc_transaction (xid, biz_id, status) VALUES (?, ?, 'TRYING')
ON DUPLICATE KEY UPDATE 
  status = IF(status='CANCELLED', status, 'TRYING');  -- 如果已 CANCELLED，则不更新（防悬挂）

-- Confirm 阶段（幂等 + 防错乱）
UPDATE tcc_transaction 
SET status='CONFIRMED', confirm_count=confirm_count+1
WHERE xid=? AND status='TRIED';

-- Cancel 阶段（幂等 + 空回滚 + 防悬挂）
-- 先查是否存在且 status != 'INIT'，否则空回滚
SELECT status FROM tcc_transaction WHERE xid=?;
if (not exists) {
    // Try 没执行，空回滚
    INSERT INTO tcc_transaction (xid, biz_id, status) VALUES (?, ?, 'CANCELLED');
    return;
}
UPDATE tcc_transaction 
SET status='CANCELLED', cancel_count=cancel_count+1
WHERE xid=? AND status IN ('TRYING', 'TRIED');
```

### 4. 三层防御的工程选型与组合

#### 4.1 三层防御的协作时序

```text
请求到达
  ↓
[分布式锁] lock(pay_order_no)
  ↓ 加锁成功
[开启 DB 事务]
  ↓
[DB 唯一索引] INSERT INTO idempotent_record ... ON DUPLICATE KEY UPDATE
  ↓ 唯一索引冲突 → 幂等跳过，返回上次结果
  ↓ 唯一索引成功 → 业务处理
[状态机幂等] UPDATE pay_order SET status=... WHERE pay_order_no=? AND status=...
  ↓ affected_rows=0 → 状态不匹配，幂等跳过
  ↓ affected_rows=1 → 状态更新成功
[COMMIT 事务]
  ↓
[释放锁] unlock(pay_order_no)
  ↓
返回结果
```

#### 4.2 三层各自的性能与可靠性

| 机制 | TPS（单机） | 延迟 | 可靠性 | 失败模式 |
|---|---|---|---|---|
| Redis 分布式锁 | 5w+ | 1ms | 99.9% | 主从切换丢锁、GC 停顿假死 |
| MySQL 唯一索引 | 3k | 5ms | 99.99% | 死锁、主备延迟 |
| 状态机 CAS UPDATE | 5k | 3ms | 99.99% | 状态机定义错误 |

**组合后的性能**：

```text
单层 Redis 锁：5w TPS，但可靠性差
单层 DB 索引：3k TPS，死锁概率高
三层组合：3k TPS（受限于 DB），但可靠性最高
```

**性能优化方向**：

```text
1. 锁的粒度做小：按 pay_order_no 加锁，不同订单并行
2. 索引的冲突率做低：业务方先生成幂等键，重试时用同一个键
3. 状态机的 SQL 短：UPDATE 一次完成，不要 SELECT FOR UPDATE
4. DB 分库分表：按 pay_order_no 哈希，单表 QPS 撑到 5k+
```

#### 4.3 三层各自的失败模式与降级方案

**Redis 锁失效**：

```text
降级方案：DB 唯一索引兜底
失败影响：并发请求会打到 DB，DB 锁竞争加剧，TPS 下降
监控指标：Redis 锁失败率、DB 死锁次数
```

**DB 唯一索引死锁**：

```text
降级方案：业务层重试（注意重试次数限制，避免雪崩）
失败影响：少量请求失败，业务方重试
监控指标：MySQL 死锁次数（SHOW ENGINE INNODB STATUS）
```

**状态机幂等失败**：

```text
降级方案：人工介入（资金安全相关，宁可慢不要错）
失败影响：少量订单状态错乱，对账发现后人工修复
监控指标：状态机异常流转次数（如 PROCESSING→PROCESSING）
```

### 5. 四个线上现象的根因与解决方案

#### 5.1 现象1：UUID 幂等键导致重复扣款

**根因**：

```text
业务方代码：
  String idempotentKey = UUID.randomUUID().toString();
  payApi.pay(idempotentKey, ...);
  
每次重试 UUID 都不同，幂等键失去意义，DB 唯一索引无法拦截
```

**解决方案**：

```text
1. 幂等中台强制规范：业务方必须用 biz_order_no + biz_system_id 作为幂等键
2. 网关层校验：X-Idempotency-Key 必须符合规范（不能是 UUID、不能含时间戳）
3. 网关层兜底：如果业务方没传，用 biz_order_no + biz_system_id 自动生成
4. 文档+培训：发布《幂等键使用规范》，列出血泪案例
```

**架构师视角**：幂等键的设计不能依赖业务方自觉，必须在网关层强制规范。

#### 5.2 现象2：Redisson 看门狗续期失败

**根因**：

```text
场景：大促期间 QPS 5w，Redis 单实例承压，看门狗续期请求超时
T0：客户端加锁成功，TTL=30s，看门狗调度 10s 后续期
T0+10s：看门狗执行 renewExpirationAsync，Redis 响应慢
T0+15s：续期请求超时失败，看门狗不再续期
T0+30s：锁过期，其他线程拿到锁
T0+30s：原线程还在执行业务逻辑，两个线程并发处理
```

**解决方案**：

```text
1. 业务关键操作前检查锁：lock.isExists() / lock.isLockedByCurrentThread()
2. 缩短业务逻辑：把锁的粒度做小，业务逻辑 < 锁 TTL/2
3. 用 fencing token：每次加锁返回递增 token，下游服务校验 token
4. Redis 集群分片：5w QPS 单实例承压，分到 5 个实例各 1w QPS
5. 关键场景用 ZK/etcd：基于 session 而非 TTL，不受 Redis 网络抖动影响
```

**架构师视角**：Redisson 看门狗不是"绝对可靠"，是"尽力而为"。资金场景必须配合 DB 唯一索引兜底。

#### 5.3 现象3：DB 唯一索引死锁

**根因**：

```text
表结构：UNIQUE KEY uk_biz (biz_order_no)
并发插入不同 biz_order_no，但 hash 到同一个 B+Tree 叶子节点
next-key lock 互相等待，触发死锁检测
```

**解决方案**：

```text
1. 改用 INSERT ... ON DUPLICATE KEY UPDATE，单语句原子，减少死锁
2. 业务层先 SELECT 查询（减少冲突概率，不能完全避免）
3. 外层 Redis 锁串行化（同 pay_order_no 的请求串行）
4. DB 分库分表（按 biz_order_no 哈希，减少单表 B+Tree 深度）
5. 业务方重试限制（最多 3 次，避免雪崩）
6. 死锁监控告警（SHOW ENGINE INNODB STATUS 解析死锁日志）
```

**架构师视角**：DB 唯一索引的死锁是"概率事件"，可以通过设计降低概率，但无法完全避免。必须配合重试机制 + 死锁监控。

#### 5.4 现象4：TCC 悬挂导致资金预留

**根因**：

```text
T0：TCC Manager 调用 Try，网络超时
T0+5s：TCC Manager 等不到响应，触发 Cancel
T0+5s：Cancel 检查 tcc_transaction 表，发现没有记录，空回滚
       但 Cancel 在表里插入了一条 status=CANCELLED 的记录
T0+10s：Try 请求终于到达，执行 INSERT
        但 INSERT 的 status 是 TRYING，覆盖了 CANCELLED
        → 这就是悬挂！
        
更精确的根因：Try 的 INSERT 没有检查"是否已 Cancel"
```

**解决方案**：

```sql
-- Try 阶段防悬挂（关键）
INSERT INTO tcc_transaction (xid, biz_id, status) VALUES (?, ?, 'TRYING')
ON DUPLICATE KEY UPDATE 
  -- 如果已 CANCELLED，则不更新（防悬挂）
  status = IF(status='CANCELLED', status, 'TRYING');

-- 检查 affected_rows：
-- 1（INSERT 成功或 UPDATE 成功且 status=TRYING）→ 正常 Try
-- 0（UPDATE 但 status=CANCELLED）→ 悬挂，Try 跳过

-- Confirm 阶段幂等
UPDATE tcc_transaction 
SET status='CONFIRMED', confirm_count=confirm_count+1
WHERE xid=? AND status='TRIED';
-- affected_rows=1 → 正常 Confirm
-- affected_rows=0 → 已 Confirm 或已 Cancel，幂等跳过

-- Cancel 阶段幂等 + 空回滚
SELECT status FROM tcc_transaction WHERE xid=?;
if (not exists) {
    -- 空回滚：Try 没执行，直接标记 CANCELLED
    INSERT INTO tcc_transaction (xid, biz_id, status) VALUES (?, ?, 'CANCELLED')
    ON DUPLICATE KEY UPDATE status=IF(status='CANCELLED', status, 'CANCELLED');
    return;
}
UPDATE tcc_transaction 
SET status='CANCELLED', cancel_count=cancel_count+1
WHERE xid=? AND status IN ('TRYING', 'TRIED');
-- affected_rows=1 → 正常 Cancel
-- affected_rows=0 → 已 Cancel，幂等跳过
```

**架构师视角**：TCC 的三大边界 case（悬挂、空回滚、幂等）必须用状态机表 + CAS UPDATE 兜底，不能依赖 Try/Confirm/Cancel 的"按顺序执行"假设。网络超时、消息重投是常态，状态机才是最终防线。

---

## 五、能力差距与补足方向

### 差距7.1：Redisson 看门狗的失效边界理解不深

> Day7发现，延续第2周差距（Redisson 用得多但底层不熟）

- **现状**：知道 Redisson 看门狗会自动续期，但不确定什么场景下会失效
- **架构师水平**：能列出 GC 停顿、网络分区、主从切换三种失效场景，并设计 fencing token / DB 兜底方案
- **补足方向**：
  - 阅读 Redisson 源码 `RedissonLock.scheduleExpirationRenewal`
  - 学习 Martin Kleppmann 《How to do distributed locking》对 Redlock 的批评
  - 复盘蛋壳钱包 TCC 是否有看门狗失效风险

### 差距7.2：DB 唯一索引的死锁机制不熟

> Day7发现，延续第1周差距（MySQL 锁机制底层原理不深）

- **现状**：知道用唯一索引防重复，但不清楚为什么并发插入会死锁
- **架构师水平**：能讲清 B+Tree next-key lock 在唯一索引插入时的加锁范围，以及 INSERT ... ON DUPLICATE KEY UPDATE 为什么能减少死锁
- **补足方向**：
  - 复盘第1周 Day07 InnoDB 锁机制底层原理
  - 阅读 MySQL 官方文档《InnoDB Locking》
  - 在测试环境复现唯一索引死锁，分析 `SHOW ENGINE INNODB STATUS`

### 差距7.3：TCC 三大边界的工程实现不熟

> Day7发现，延续第3周差距（TCC 分布式事务理论懂，工程实现不深）

- **现状**：知道 TCC 有悬挂、空回滚、幂等三大边界，但工程实现细节不熟
- **架构师水平**：能用状态机表 + CAS UPDATE 实现三大边界的兜底，并设计补偿机制
- **补足方向**：
  - 复盘蛋壳钱包 TCC 是否有悬挂风险
  - 学习 Seata TCC 模式源码 `TccActionInterceptorHandler`
  - 学习 Hmily、EasyTransaction 等 TCC 框架的边界处理

### 差距7.4：三层防御的协同设计能力不足

> Day7发现

- **现状**：单独用 Redis 锁、DB 索引、状态机都行，但三者协同的时序、边界、降级方案不清晰
- **架构师水平**：能画出三层防御的时序图，明确各层的失败模式与降级方案，并给出性能/可靠性平衡的选型决策
- **补足方向**：
  - 复盘蛋壳钱包收银台的幂等设计，识别是否三层齐备
  - 学习蚂蚁/美团支付中台的幂等中间件设计
  - 设计时序图、决策树，沉淀为团队规范

### 差距7.5：fencing token 方案不了解

> Day7发现

- **现状**：知道 fencing token 概念，但没实践过
- **架构师水平**：能用 Redis INCR / ZK 事务版本实现 fencing token，下游服务校验 token 防止"过期锁"导致的并发问题
- **补足方向**：
  - 学习 Martin Kleppmann 《How to do distributed locking》的 fencing token 方案
  - 学习 TiKV / CockroachDB 的 fencing token 实现
  - 在内部管理系统重写 SETNX 裸实现时引入 fencing token

---

## 六、本周总结与下一周衔接

### 本周回顾

```text
Day1：支付系统整体架构与核心模块设计
Day2：支付幂等性设计与重复支付防护
Day3：支付对账与差错处理
Day4：支付渠道路由与智能选择设计
Day5：清结算与资金核算设计
Day6：串联整合 —— 支付系统全链路架构设计
Day7：架构深挖 —— 支付幂等性底层原理与三防闭环
```

支付专题从架构到资金、从设计到实现、从单点到闭环，完整覆盖。Day7 把 Day2 的"幂等设计"深挖到"底层实现"，把第3周 TCC、第1周 MySQL 锁机制、第2周 Redis 锁全部串联到支付场景。

### 下一周衔接

按 memory 规划，2026年07月第1周将进入**医疗信息化专题**，以智慧体检/公卫为基础延伸到医疗行业通用架构：

```text
智慧体检/公卫直接相关（体检流程、公卫数据上报、LIS/PACS 集成、健康档案）
医疗信息化高频考点（HIS/EMR/集成平台、HL7/FHIR 标准、DICOM 影像）
医疗数据特色问题（隐私合规、医保对接、临床数据治理）
大厂医疗架构进阶（互联网医院、AI 辅诊、医疗大数据）
```

支付专题的"幂等三防闭环"会延续到医疗场景：医保结算、体检套餐支付、公卫数据上报的幂等设计，都可以复用本周的方法论。