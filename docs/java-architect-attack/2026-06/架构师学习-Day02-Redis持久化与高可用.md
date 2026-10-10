# Day 2：Redis持久化与高可用 — RDB/AOF/主从/哨兵/Cluster（练习整理）

## 题目一：Redis持久化选型 — RDB和AOF怎么选？

### 场景

你的系统大量依赖 Redis：

- 商品详情缓存：允许丢失，丢了可以回源 DB
- 用户 Session：丢失会导致用户重新登录
- 分布式锁：不要求持久化，但要求不能误恢复旧锁
- 资金路由实时评分：Redis 中保存渠道实时评分，MySQL 有最终结果
- 延迟队列：Redis ZSet 保存待执行任务，丢失会影响业务

请回答：
1. RDB 和 AOF 的工作原理分别是什么？
2. RDB、AOF 各自的优缺点是什么？
3. `appendfsync always/everysec/no` 怎么选？
4. 哪些业务数据适合开启持久化？哪些不适合？
5. Redis 重启恢复时，为什么要优先加载 AOF 而不是 RDB？

---

## 答案

### 1. RDB 工作原理

RDB 是 Redis 的**快照持久化**：在某个时间点，把内存中的全量数据生成一个 `.rdb` 文件。

```
RDB生成流程：

  Redis主进程
      │
      │  触发BGSAVE
      ▼
  fork子进程
      │
      │  子进程遍历内存数据
      ▼
  写临时RDB文件 dump.rdb.tmp
      │
      │  写完后rename
      ▼
  替换旧RDB文件 dump.rdb

关键点：
  ① fork 时主进程不会把所有内存复制一份
  ② 操作系统使用 Copy-On-Write（写时复制）
  ③ 子进程持有 fork 时刻的内存快照
  ④ 主进程继续处理请求
  ⑤ 如果 fork 后主进程修改了某些内存页，OS 才复制对应页
```

### RDB 的优缺点

| 维度 | RDB |
|------|-----|
| 优点 | 文件紧凑、恢复快、适合备份、对子进程写磁盘不阻塞主线程 |
| 缺点 | 可能丢失最近一次快照后的数据、fork 大内存实例可能阻塞、COW 可能导致内存瞬时翻倍 |

```
RDB适合：
  ① 数据可重建的缓存
  ② 定期备份
  ③ 大规模冷启动恢复

RDB不适合：
  ① 不能接受分钟级数据丢失的场景
  ② 内存极大且写入很频繁的实例
  ③ 需要秒级恢复点的业务数据
```

### 2. AOF 工作原理

AOF 是 Redis 的**命令追加日志**：每次写命令执行后，把命令追加到 AOF 文件。

```
客户端写命令：

  SET user:1 Tom
      │
      ▼
  Redis执行命令，修改内存
      │
      ▼
  追加命令到 AOF buffer
      │
      ▼
  根据 appendfsync 策略刷盘
      │
      ▼
  写入 appendonly.aof

Redis重启恢复：
  读取 AOF 文件
  按顺序重放写命令
  恢复内存状态
```

### AOF 的三种刷盘策略

| 策略 | 含义 | 数据丢失 | 性能 | 适用场景 |
|------|------|---------|------|---------|
| always | 每条写命令都 fsync | 最多丢 0 条 | 最差 | 极少用，性能不可接受 |
| everysec | 每秒 fsync 一次 | 最多丢 1 秒 | 较好 | 默认推荐 |
| no | 交给 OS 自己刷盘 | 可能丢几十秒 | 最好 | 纯缓存、可丢数据 |

```
为什么 everysec 是默认推荐？

  always：
    每条写命令都调用 fsync
    fsync 是磁盘同步 IO，延迟可能 1-10ms
    Redis 单线程会被拖慢，QPS 大幅下降

  no：
    由 OS 决定什么时候刷盘
    Linux 可能 30 秒才刷一次
    机器宕机可能丢很多数据

  everysec：
    后台线程每秒 fsync
    主线程只写 AOF buffer
    最坏丢 1 秒数据
    性能和可靠性平衡最好
```

### 3. AOF 重写机制

AOF 文件会越来越大，因为它记录的是历史命令。

```
原始AOF：
  SET counter 1
  INCR counter
  INCR counter
  INCR counter
  DEL temp
  SET temp 123
  DEL temp

重写后AOF：
  SET counter 4

核心思想：
  不需要保存历史过程，只需要保存当前最终状态
```

AOF rewrite 流程：

```
Redis主进程
    │
    │  BGREWRITEAOF
    ▼
fork子进程
    │
    │  子进程根据当前内存状态生成新AOF
    ▼
主进程继续处理写请求
    │
    │  新写命令同时写入：
    │  ① 旧AOF buffer
    │  ② AOF rewrite buffer
    ▼
子进程写完新AOF
    │
    ▼
主进程把 rewrite buffer 追加到新AOF
    │
    ▼
rename替换旧AOF
```

### 4. RDB + AOF 混合持久化

Redis 4.0+ 支持 AOF 混合持久化：

```
AOF文件结构：

  [RDB格式的全量快照]
  [AOF格式的增量命令]

好处：
  ① 前半段 RDB 恢复快
  ② 后半段 AOF 保留最近增量
  ③ 文件比纯 AOF 小
  ④ 恢复速度比纯 AOF 快

配置：
  aof-use-rdb-preamble yes
```

### 5. Redis 重启为什么优先加载 AOF？

```
如果同时开启 RDB 和 AOF：

  RDB：上一次快照，可能是 5 分钟前
  AOF：最多丢 1 秒数据（everysec）

AOF 数据更新，所以 Redis 优先加载 AOF。

恢复优先级：
  AOF存在且开启 → 加载AOF
  否则 → 加载RDB
```

### 6. 业务场景选型

| 业务场景 | 推荐持久化 | 原因 |
|---------|------------|------|
| 商品详情缓存 | 可不开或 RDB | 可回源 DB，丢了只是缓存重建 |
| 用户 Session | AOF everysec | 丢失影响用户体验，最多丢 1 秒可接受 |
| 分布式锁 | 不建议持久化 | 重启后恢复旧锁可能造成死锁或误互斥 |
| 资金路由评分 | RDB + MySQL 兜底 | Redis 是实时视图，MySQL 有最终数据 |
| 延迟队列 | AOF everysec + DB 任务表兜底 | 任务不能丢，Redis 只做调度索引 |
| 幂等 Key | 视业务决定 | 支付幂等需要持久化，普通防重可不持久化 |

### 与架构师水平的差距

| 层次 | 回答 |
|------|------|
| 开发 | Redis 有 RDB 和 AOF，AOF 更安全 |
| 高级开发 | RDB 是快照，AOF 是追加日志，everysec 最常用 |
| 架构师 | 持久化选型要按数据语义分层：可重建缓存不持久化或 RDB；用户态关键数据用 AOF everysec；分布式锁不持久化防止恢复旧锁；延迟队列必须 DB 兜底，Redis 只做调度索引。还要能解释 fork+COW 内存风险、AOF rewrite 双写 buffer、混合持久化的恢复性能优势 |

**补足方向**：面试时不要只说“开启 AOF 防丢数据”，要说“这类数据能不能重建、能丢几秒、恢复旧数据是否有副作用”。

---

## 题目二：Redis 主从复制 — 全量复制和增量复制怎么工作？

### 场景

你有一个 Redis 主节点，挂了两个从节点承担读流量。某天从节点网络抖动 30 秒后恢复。

请回答：
1. 第一次建立主从复制时发生了什么？
2. 网络短暂断开后，Redis 如何做增量复制？
3. 什么时候会退化成全量复制？
4. 主从延迟怎么监控和治理？
5. 读写分离场景下，如何避免读到旧数据？

---

## 答案

### 1. 第一次同步：全量复制

```
从节点执行：
  REPLICAOF master_ip master_port

全量复制流程：

  Slave                                  Master
    │                                      │
    │  PSYNC ? -1                         │
    │─────────────────────────────────────▶│
    │                                      │
    │                     fork子进程生成RDB│
    │                                      │
    │◀──────────────────── FULLRESYNC      │
    │                                      │
    │◀──────────────────── 发送RDB文件      │
    │                                      │
  清空旧数据                              │
  加载RDB                                 │
    │                                      │
    │◀──────────────────── 发送缓冲区增量命令│
    │                                      │
  执行增量命令                            │
    │                                      │
  同步完成                                │
```

关键点：

```
全量复制不是直接把内存数据一条条发给从库，而是：
  ① Master 生成 RDB 快照
  ② 发送 RDB 给 Slave
  ③ Slave 清空本地数据并加载 RDB
  ④ Master 把生成 RDB 期间的新写命令发给 Slave
```

### 2. 增量复制：复制积压缓冲区

Redis 2.8+ 使用 PSYNC 支持增量复制。

```
核心数据结构：复制积压缓冲区 repl_backlog_buffer

  Master维护：
    replid：主库复制ID
    offset：全局复制偏移量
    backlog：固定大小环形缓冲区，保存最近写命令

示意：

  backlog size = 1MB

  offset: 1000 1001 1002 ... 2000
          [ SET ][ INCR ][ DEL ] ...

  Slave 断开前 offset = 1500
  30秒后重连：
    Slave: PSYNC <master_replid> 1500
    Master检查：1500之后的数据还在backlog吗？
      在  → CONTINUE，发送1501之后的增量命令
      不在 → FULLRESYNC，全量复制
```

### 3. 什么时候退化成全量复制？

```
退化条件：

  ① 从节点 offset 太旧，backlog 已经覆盖
     断开期间写入量 > repl-backlog-size
     → 增量命令找不到，只能全量

  ② master_replid 不匹配
     主节点重启或切主后 replid 变化
     → 旧主的 offset 对新主无意义

  ③ 从节点第一次连接
     offset = -1，没有历史位置
     → 必须全量

量化判断：
  backlog大小应至少覆盖网络抖动期间的写入量

  公式：
    repl-backlog-size >= 写入流量MB/s × 最大断连秒数 × 安全系数

  例子：
    Redis写入流量 5MB/s
    希望支持断连 60 秒
    安全系数 2
    backlog >= 5 × 60 × 2 = 600MB
```

### 4. 主从延迟监控

```
INFO replication 关键指标：

  master_repl_offset: 1000000
  slave0: ip=...,state=online,offset=999000,lag=1

延迟计算：
  offset差 = master_repl_offset - slave_repl_offset
  lag = 从库最后一次 ACK 距现在的秒数

告警阈值：
  lag > 1s：关注
  lag > 5s：介入
  lag > 30s：切流/摘除从库
```

### 5. 主从延迟治理

```
原因1：主库写入太大
  例如一次 MSET 100MB，复制链路被打满
  解法：拆分大写、限流、避免大Key

原因2：网络带宽不足
  解法：主从同机房部署、升级带宽、压缩链路

原因3：从库执行慢
  从库也是单线程执行命令
  大Key删除、大Lua脚本会阻塞复制命令执行
  解法：UNLINK替代DEL，拆Lua，禁用慢命令

原因4：从库磁盘慢
  AOF fsync 或 RDB 加载拖慢
  解法：从库关闭AOF或使用更快磁盘
```

### 6. 读写分离如何避免读到旧数据？

| 场景 | 策略 |
|------|------|
| 普通商品详情 | 可以读从库，允许秒级旧数据 |
| 用户刚修改个人资料 | 写后短时间读主库 |
| 支付状态/订单状态 | 强制读主库 |
| IM 在线状态 | 读主库或 Redis 单主，不走延迟从库 |
| 管理后台报表 | 可读从库，接受延迟 |

```
通用方案：写后读主

  用户更新资料：
    UPDATE user
    SET session_flag:user_id = now + 3s

  3秒内该用户读请求：
    读主库/主Redis

  3秒后：
    读从库

本质：用业务路由规避主从延迟，而不是试图消灭延迟。
```

### 与架构师水平的差距

| 层次 | 回答 |
|------|------|
| 开发 | Redis 可以主从复制，从库读 |
| 高级开发 | 第一次全量复制，断线后增量复制，主从会有延迟 |
| 架构师 | 能讲清 PSYNC、replid、offset、复制积压缓冲区的关系，并用公式估算 backlog 大小。主从延迟治理不是“等同步”，而是按业务一致性分级：弱一致读从、强一致读主、写后读主窗口。能说出 lag/offset 差两个监控指标，以及全量复制带来的 fork、网络、从库清空加载风险 |

**补足方向**：被问“主从延迟怎么办”，不要只答“读主库”，要先分类业务一致性，再给写后读主、摘除延迟从库、扩大 backlog、防止全量复制等组合方案。

---

## 题目三：Redis 哨兵机制 — 主节点挂了如何自动切换？

### 场景

你的 Redis 使用一主两从 + 三个 Sentinel。某天主节点宕机。

请回答：
1. Sentinel 如何判断主节点真的挂了？
2. 什么是主观下线和客观下线？
3. Sentinel 之间如何选举 Leader？
4. 新 Master 如何选出来？
5. 故障切换过程中会不会丢数据？

---

## 答案

### 1. Sentinel 的职责

Sentinel 不是 Redis 数据节点，它是高可用控制平面。

```
Sentinel职责：
  ① 监控：定期 PING 主从节点
  ② 通知：发现故障后通知客户端或管理员
  ③ 自动故障转移：主挂后选从提升为主
  ④ 配置中心：客户端通过 Sentinel 获取当前 Master 地址
```

### 2. 主观下线 vs 客观下线

```
主观下线 SDOWN：
  某个 Sentinel 自己认为 Master 挂了

  判断依据：
    down-after-milliseconds 时间内没有收到有效 PONG

  例子：
    Sentinel A ping Master 5秒无响应
    → A 标记 Master 为 SDOWN

客观下线 ODOWN：
  多个 Sentinel 达成共识，认为 Master 挂了

  判断依据：
    达到 quorum 数量的 Sentinel 都认为 Master SDOWN

  例子：
    quorum=2
    Sentinel A/B 都认为 Master SDOWN
    → Master 被标记为 ODOWN
    → 触发故障转移
```

### 为什么需要两层判断？

```
如果只有主观下线：
  Sentinel A 到 Master 网络抖动
  A 误判 Master 挂了
  → 直接切主，可能脑裂

引入客观下线：
  必须多数 Sentinel 都认为挂了
  → 降低误判概率

本质：分布式系统里单点观察不可信，要通过多数派确认。
```

### 3. Sentinel Leader 选举

当 Master 被 ODOWN 后，多个 Sentinel 都可能想发起切换，需要先选出一个 Leader。

```
选举规则类似 Raft：

  ① 每个 Sentinel 都可以成为候选者
  ② 候选者向其他 Sentinel 请求投票
  ③ 每个 Sentinel 每轮只能投一票
  ④ 获得多数票的 Sentinel 成为 Leader
  ⑤ Leader 负责执行故障转移

为什么需要 Leader？
  防止多个 Sentinel 同时提升不同从库为 Master
```

### 4. 新 Master 选择规则

Sentinel Leader 会从多个 Slave 中选一个提升为 Master。

选择优先级：

```
第一步：过滤不合格 Slave
  ① 已经下线的从库剔除
  ② 断开时间太久的从库剔除
  ③ 配置 slave-priority=0 的从库剔除

第二步：按优先级排序
  ① slave-priority 越小优先级越高
  ② 复制 offset 越大越优先（数据越新）
  ③ runid 越小越优先（稳定排序兜底）

最终：
  选数据最新、优先级最高的 Slave 提升为 Master
```

### 5. 故障切换流程

```
主挂 → Sentinel 检测 SDOWN → 多数确认 ODOWN
      ↓
Sentinel Leader 选举
      ↓
选择最优 Slave
      ↓
对该 Slave 执行 SLAVEOF NO ONE
      ↓
其他 Slave 执行 SLAVEOF new_master
      ↓
客户端通过 Sentinel 获取新 Master 地址
      ↓
故障切换完成
```

### 6. 会不会丢数据？

会。Sentinel 不能保证 RPO=0。

```
原因：Redis 主从复制默认是异步复制

时间线：
  T1 客户端写 Master：SET order:1 PAID
  T2 Master 返回成功给客户端
  T3 Master 还没复制给 Slave
  T4 Master 宕机
  T5 Sentinel 提升 Slave 为新 Master

结果：
  order:1=PAID 丢失
```

### 如何降低丢数据风险？

```
配置 min-replicas-to-write：

  min-replicas-to-write 1
  min-replicas-max-lag 10

含义：
  至少有1个从库延迟小于10秒，Master 才接受写入
  如果所有从库都断开或延迟太大，Master 拒绝写请求

作用：
  降低主从断开时继续写入导致的数据丢失窗口

代价：
  可用性下降
  从库全断时，主库也不可写
```

### 与架构师水平的差距

| 层次 | 回答 |
|------|------|
| 开发 | 哨兵能自动切主 |
| 高级开发 | Sentinel 判断主观下线/客观下线，然后选从库为主 |
| 架构师 | Sentinel 是控制平面，采用“主观下线→客观下线→Leader选举→Slave择优→配置重写”的完整流程。必须明确 Sentinel 不能保证 RPO=0，因为 Redis 主从异步复制，故障窗口内可能丢最后几秒写入。可用 min-replicas-to-write 降低风险，但本质是用可用性换一致性 |

**补足方向**：面试时被问“哨兵会不会丢数据”，不能回答“不会”。正确答案是“会，异步复制导致；哨兵解决的是自动故障转移，不是零丢失”。

---

## 题目四：Redis Cluster — 为什么需要 Cluster？槽位迁移怎么做？

### 场景

单个 Redis 实例内存 20GB、QPS 10 万已经接近瓶颈，你准备上 Redis Cluster。

请回答：
1. Redis Cluster 为什么是 16384 个槽？
2. 客户端访问 Key 时如何定位节点？
3. MOVED 和 ASK 重定向有什么区别？
4. 槽位迁移过程中如何保证服务可用？
5. Cluster 能解决什么问题？不能解决什么问题？

---

## 答案

### 1. Redis Cluster 的核心：槽位分片

Redis Cluster 不直接按节点哈希，而是引入 16384 个 hash slot。

```
Key路由：

  slot = CRC16(key) % 16384

  例子：
    user:1001 → CRC16 → 5798 → slot 5798

  槽位分配：
    Node A: slot 0-5460
    Node B: slot 5461-10922
    Node C: slot 10923-16383

  user:1001 的 slot=5798 → 路由到 Node B
```

为什么是 16384？

```
原因1：槽位足够细，支持均匀分配
  16384 个槽分给几十个节点，每个节点几百个槽
  扩容迁移可以按槽粒度迁移，足够细

原因2：集群元数据开销可控
  每个节点用 bitmap 表示自己负责哪些槽
  16384 bit = 2KB
  节点间 Gossip 传播槽位信息时开销小

原因3：没必要更多
  如果是 65536 槽，bitmap 8KB，Gossip 包变大
  Redis Cluster 目标节点数通常 < 1000
  16384 已经足够
```

### 2. 客户端如何定位节点？

```
智能客户端会缓存 slot → node 映射：

  第一次访问：
    客户端计算 slot
    查本地 slot cache
    找到目标节点
    发送命令

  如果路由错了：
    Redis 返回 MOVED 5798 10.0.0.2:6379
    客户端更新 slot cache
    重试请求到正确节点
```

### 3. MOVED vs ASK

| 类型 | 含义 | 场景 | 客户端行为 |
|------|------|------|------------|
| MOVED | 槽已经迁移完成 | 稳定状态路由错 | 更新本地 slot cache，永久重定向 |
| ASK | 槽正在迁移中 | 迁移过程中的临时状态 | 不更新 slot cache，只本次临时访问目标节点 |

```
MOVED：
  客户端访问 Node A
  Node A：slot 5798 已经归 Node B
  → 返回 MOVED 5798 NodeB
  → 客户端更新缓存，以后都访问 Node B

ASK：
  slot 5798 正在从 A 迁移到 B
  有些 Key 已经迁到 B，有些还在 A
  客户端访问 A 查不到某个已迁移 Key
  A 返回 ASK NodeB
  客户端先发 ASKING，再访问 B
  但 slot cache 不更新，因为迁移还没完成
```

### 4. 槽位迁移流程

```
把 slot 5798 从 Node A 迁移到 Node B：

  ① 设置状态
     Node B: IMPORTING slot 5798 from A
     Node A: MIGRATING slot 5798 to B

  ② 迁移 Key
     对 slot 5798 下的 Key 逐批 MIGRATE 到 B

  ③ 迁移期间读写
     Key 在 A：A 正常处理
     Key 已迁到 B：A 返回 ASK，让客户端临时访问 B

  ④ 完成迁移
     更新集群元数据：slot 5798 归 Node B
     之后访问 A 会返回 MOVED
```

为什么迁移过程仍可用？

```
核心机制：ASK 临时重定向

  槽迁移不是一刀切，而是 Key 级别逐步迁移
  已迁移的 Key 通过 ASK 访问新节点
  未迁移的 Key 继续在旧节点访问

  所以迁移期间服务不中断，只是客户端多一次重定向
```

### 5. Cluster 解决什么问题？

```
解决：
  ① 单节点内存上限：数据分散到多个节点
  ② 单节点 QPS 上限：请求分散到多个节点
  ③ 自动故障转移：每个 Master 可挂 Slave，主挂后从提升
  ④ 在线扩容：迁移 slot 即可扩容
```

### 6. Cluster 不能解决什么问题？

```
不能解决1：跨槽事务
  MULTI/EXEC 只能操作同一个 slot 的 Key
  不同 slot 的 Key 无法保证原子性

不能解决2：跨槽 Lua
  Lua 脚本里的所有 Key 必须在同一个 slot

不能解决3：大Key热Key
  一个热Key只能落在一个节点
  Cluster 不能自动拆分单Key流量

不能解决4：强一致性
  Cluster 主从仍是异步复制
  主挂时仍可能丢最后几秒数据

不能解决5：多Key操作受限
  MGET/MSET 多个 Key 必须同槽
  解决方法：Hash Tag

  例子：
    user:{1001}:profile
    user:{1001}:orders
    user:{1001}:cart

  Redis只对 {} 内的内容计算slot
  三个Key都按 1001 算slot → 落在同一节点
```

### 与架构师水平的差距

| 层次 | 回答 |
|------|------|
| 开发 | Redis Cluster 能分片，自动扩容 |
| 高级开发 | Cluster 有 16384 个槽，Key 通过 CRC16 路由，MOVED 重定向 |
| 架构师 | Cluster 的本质是“槽位作为稳定中间层”，解决节点扩缩容导致的路由变化问题。能解释 16384 的元数据开销权衡、MOVED/ASK 在稳定态和迁移态的区别、Hash Tag 解决同槽多Key操作。也要明确 Cluster 不解决热Key、大Key、强一致和跨槽事务，单Key热点仍要靠本地缓存/Key拆分/读副本解决 |

**补足方向**：面试时不要只说“Cluster 自动分片”，要说“它解决的是多节点路由和扩容，不解决单Key热点和强一致”。

---

## 题目五：Redis 高可用架构选型 — 单机/主从/哨兵/Cluster怎么选？

### 场景

你要给不同业务选择 Redis 架构：

1. 内部管理系统的验证码缓存，QPS 很低
2. 商品详情缓存，QPS 5 万，可回源 DB
3. IM 在线状态，QPS 10 万，要求低延迟
4. 支付幂等 Key，不能误判重复支付
5. 资金路由评分，要求高可用，可短暂不一致

请回答：
1. 单机、主从、哨兵、Cluster 分别适合什么场景？
2. 选型时看哪些维度？
3. Redis 高可用能不能等同于数据不丢？
4. 哪些场景必须有 DB 兜底？

---

## 答案

### 1. 四种架构形态对比

| 架构 | 特点 | 优点 | 缺点 | 适用场景 |
|------|------|------|------|---------|
| 单机 | 一个 Redis | 简单、成本低 | 单点、容量/QPS有限 | 低QPS、可丢缓存 |
| 主从 | 一主多从 | 读扩展、备份 | 主挂需人工切换 | 读多写少、可人工恢复 |
| 哨兵 | 主从 + Sentinel | 自动故障转移 | 不分片、仍可能丢数据 | 中等规模、高可用 |
| Cluster | 多主多从 + 槽位 | 分片、扩容、自动切换 | 跨槽限制、复杂 | 大容量、高QPS |

### 2. 选型三维框架

```
维度1：容量
  单实例内存 < 10GB → 单机/哨兵足够
  单实例内存 10-20GB → 哨兵可用但需谨慎
  单实例内存 > 20GB → 建议 Cluster

维度2：QPS
  QPS < 1万 → 单机
  QPS 1万-10万 → 主从/哨兵
  QPS > 10万 → Cluster 或业务拆分

维度3：可用性
  可短暂不可用 → 单机/主从
  要自动切换 → 哨兵
  要自动切换 + 水平扩展 → Cluster

维度4：数据可丢性
  可丢 → 不必强持久化
  不可丢 → Redis 不能做唯一存储，必须 DB 兜底
```

### 3. 业务选型案例

| 业务 | 推荐架构 | 理由 |
|------|---------|------|
| 内部管理验证码 | 单机 + RDB 或无持久化 | QPS 低，丢了重发验证码即可 |
| 商品详情缓存 | 哨兵或 Cluster | QPS 5 万，读多写少，可回源 DB |
| IM 在线状态 | 哨兵/Cluster + 本地缓存 | QPS 高、低延迟，允许秒级状态误差 |
| 支付幂等 Key | Redis + DB 唯一约束兜底 | Redis 不能作为唯一防线，必须 DB 防重复 |
| 资金路由评分 | 哨兵 + AOF everysec + MySQL 兜底 | Redis 做实时排序视图，最终数据在 DB |

### 4. Redis 高可用 ≠ 数据不丢

```
高可用解决的是：
  节点挂了能不能自动恢复服务

数据不丢解决的是：
  写成功的数据是否一定能恢复

Redis主从异步复制：
  Master 写成功返回
  还没同步 Slave
  Master 挂了
  Slave 被提升
  → 最后一段数据丢失

结论：
  哨兵/Cluster 提升可用性，不保证 RPO=0
  核心业务不能只靠 Redis
```

### 5. 哪些必须 DB 兜底？

```
必须兜底：
  ① 支付幂等：DB唯一索引兜底
  ② 订单状态：DB为准，Redis只是缓存
  ③ 延迟任务：DB任务表为准，Redis ZSet只是调度索引
  ④ 资金路由评分：DB保存最终评分，Redis实时排序
  ⑤ 库存最终扣减：DB库存或流水为准，Redis预扣只是削峰

可以不兜底：
  ① 商品详情缓存：丢了回源
  ② 验证码：丢了重发
  ③ 临时限流计数：丢了最多短暂限流失效
```

### 与架构师水平的差距

| 层次 | 回答 |
|------|------|
| 开发 | 用 Redis Cluster，因为高可用 |
| 高级开发 | 单机简单，哨兵自动切换，Cluster 可以分片 |
| 架构师 | Redis 架构选型看容量、QPS、可用性、数据可丢性四个维度。单实例超过 20GB 或 QPS 超 10 万才优先 Cluster，否则哨兵更简单。核心业务必须明确“Redis 不是事实源”，支付幂等/延迟任务/资金路由都要 DB 兜底。Redis 高可用只解决服务恢复，不等于 RPO=0 |

**补足方向**：被问“为什么不用 Cluster”，要敢于回答“因为当前单实例 8GB、QPS 3万，哨兵足够，Cluster 会引入跨槽限制和运维复杂度”。架构师不是上来用最复杂方案，而是按约束选最合适方案。

---

## Day2核心总结

```
Day2主线：Redis高可用不是一个功能，而是一组权衡。

  持久化：
    RDB = 快照，恢复快但可能丢分钟级数据
    AOF = 命令日志，everysec 最多丢1秒
    混合持久化 = RDB恢复速度 + AOF增量可靠性
    分布式锁不建议持久化，防止恢复旧锁

  主从复制：
    第一次全量复制：Master生成RDB → Slave加载 → 发送增量
    断线恢复增量复制：replid + offset + backlog
    backlog大小 = 写入速率 × 最大断连时间 × 安全系数
    主从延迟靠业务分级治理，不是靠技术消灭

  哨兵：
    解决自动故障转移，不解决零丢失
    SDOWN主观下线 → ODOWN客观下线 → Leader选举 → Slave择优 → 切主
    Redis异步复制决定了 Sentinel 可能丢最后几秒数据

  Cluster：
    通过16384槽解决分片和扩容
    MOVED是永久重定向，ASK是迁移期间临时重定向
    Cluster不解决热Key、大Key、强一致、跨槽事务

  架构选型：
    看容量/QPS/可用性/数据可丢性
    Redis高可用 ≠ 数据不丢
    核心业务必须DB兜底
```

---

*日期：2026-06-09 | 2026年06月第2周 Day2 | Redis持久化与高可用*
