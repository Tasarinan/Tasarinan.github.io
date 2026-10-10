# Day 5：Redis分布式锁与秒杀库存扣减

## 题目一：Redis分布式锁怎么设计才可靠？

### 场景

你的系统里有两类 Redis 分布式锁实践：

- 内部管理系统：早期用 `SETNX + EXPIRE` 裸实现分布式锁
- ToC 核心业务：后来改用 Redisson
- 秒杀系统：用 Redis 扣减库存，防止超卖
- 资金路由：同一笔交易只能被一个渠道处理，不能重复路由

现在面试官追问你：

1. 为什么 `SETNX + EXPIRE` 分两步实现锁不可靠？
2. 正确的 Redis 分布式锁加锁命令应该怎么写？为什么要带唯一 value？
3. 解锁为什么必须用 Lua 脚本？如果直接 `DEL key` 会有什么问题？
4. 锁过期时间怎么设置？业务没执行完锁过期了怎么办？
5. Redisson 的看门狗机制解决了什么问题？它有什么边界？
6. Redis 主从切换时，分布式锁会不会失效？为什么？
7. RedLock 是什么？生产中你会怎么取舍？
8. 哪些业务可以用 Redis 锁？哪些业务不能只依赖 Redis 锁？

---

## 你的回答

（这里留空，等待用户回答）

---

## 架构师点评

（这里留空，等待用户回答后填写）

---

## 标准答案

## 一、Redis分布式锁的核心目标

Redis 分布式锁不是简单地“加一个 key”，它至少要满足四个目标：

```text
1. 互斥性：同一时刻只能有一个客户端持有锁
2. 防死锁：客户端宕机后锁能自动释放
3. 防误删：只能释放自己加的锁，不能删别人的锁
4. 可续期：业务执行时间超过锁过期时间时，锁不能提前失效
```

面试中最常见的误区是只回答 `SETNX`，但没有回答“宕机、误删、过期、主从切换”这些异常场景。

---

## 二、为什么 SETNX + EXPIRE 不可靠

### 2.1 分两步不是原子操作

错误写法：

```text
SETNX lock:order:1001 requestId
EXPIRE lock:order:1001 30
```

问题在于这两个命令不是原子的。

```text
客户端A执行 SETNX 成功
    ↓
还没来得及执行 EXPIRE
    ↓
客户端A宕机
    ↓
lock:order:1001 永不过期
    ↓
其他客户端永远拿不到锁
```

这就是死锁。

### 2.2 正确加锁命令

Redis 2.6.12 之后，推荐使用一条 `SET` 命令完成加锁和设置过期时间：

```text
SET lock:order:1001 requestId NX PX 30000
```

含义：

```text
SET：设置 key
NX：只有 key 不存在才设置成功
PX 30000：锁 30 秒后自动过期
requestId：当前客户端的唯一标识
```

加锁成功返回：

```text
OK
```

加锁失败返回：

```text
(nil)
```

### 2.3 为什么 value 必须唯一

value 不能写死成 `1`，而应该是唯一值，例如：

```text
requestId = UUID + threadId
```

原因是解锁时要判断：

```text
这把锁是不是我自己加的？
```

如果没有唯一 value，就无法区分锁的归属。

---

## 三、为什么解锁必须用 Lua 脚本

### 3.1 直接 DEL 的问题

错误解锁：

```text
DEL lock:order:1001
```

问题场景：

```text
1. 客户端A加锁成功，锁过期时间30秒
2. 客户端A业务执行很慢，执行了35秒
3. 第30秒时，A的锁自动过期
4. 客户端B加锁成功
5. 第35秒时，客户端A执行 DEL lock
6. A把B的锁删掉了
7. 客户端C也能加锁成功
8. B和C同时执行临界区，互斥失效
```

这就是“误删别人锁”。

### 3.2 先 GET 再 DEL 也不安全

错误写法：

```text
if GET lock == requestId:
    DEL lock
```

问题是 `GET` 和 `DEL` 两步不是原子的。

```text
客户端A GET 判断锁是自己的
    ↓
锁刚好过期
    ↓
客户端B加锁成功
    ↓
客户端A DEL
    ↓
A删除了B的锁
```

### 3.3 正确解锁 Lua 脚本

```lua
if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
else
    return 0
end
```

执行含义：

```text
1. 判断锁的 value 是否等于自己的 requestId
2. 如果是，删除锁
3. 如果不是，不删除
4. 整个判断 + 删除由 Redis 单线程原子执行
```

---

## 四、锁过期时间怎么设置

锁过期时间不能随便写，要结合业务耗时评估。

```text
锁过期时间 = 业务 P99 耗时 × 2 ~ 3 + 网络抖动时间
```

例如：

```text
正常耗时：100ms
P99耗时：800ms
偶发GC/网络抖动：1s

锁过期时间建议：3s ~ 5s
```

如果业务可能执行几十秒，不适合简单设置很长过期时间，而应该考虑：

```text
1. 缩小锁粒度
2. 拆分业务步骤
3. 使用可续期锁
4. 使用状态机保证幂等
5. 对强一致场景使用数据库事务或唯一约束兜底
```

---

## 五、Redisson 看门狗机制

### 5.1 看门狗解决什么问题

Redisson 默认锁过期时间是 30 秒。

如果业务没有主动指定 `leaseTime`，Redisson 会启动 watchdog：

```text
客户端A加锁成功
    ↓
锁默认过期时间30秒
    ↓
后台每隔 10 秒检查一次
    ↓
如果客户端A还活着，并且锁还被A持有
    ↓
自动把锁续期到30秒
```

它解决的是：

```text
业务执行时间不确定，锁提前过期导致并发进入临界区
```

### 5.2 看门狗的边界

看门狗不是万能的。

```text
1. 客户端进程宕机：不会续期，锁到期释放
2. JVM 长时间 STW：续期线程也停住，可能续期失败
3. Redis 网络抖动：续期命令发不出去，锁可能过期
4. 显式指定 leaseTime：Redisson 不会启用 watchdog
5. Redis 主从切换：仍可能出现锁丢失
```

所以 Redisson 提升了工程可靠性，但不能把 Redis 锁变成强一致锁。

---

## 六、Redis主从切换下锁为什么可能失效

Redis 主从复制是异步的。

故障链路：

```text
1. 客户端A在 master 加锁成功
2. master 还没把锁同步给 slave
3. master 宕机
4. slave 被提升为新 master
5. 新 master 上没有这把锁
6. 客户端B加锁成功
7. A和B同时认为自己持有锁
```

这会导致互斥失效。

因此，单 Redis 主从架构下的分布式锁不能提供严格一致性，只能提供“多数情况下可用”的互斥能力。

---

## 七、RedLock 是什么，怎么取舍

RedLock 的思路是使用多个相互独立的 Redis master。

```text
假设有 5 个 Redis master：R1、R2、R3、R4、R5

客户端加锁：
  1. 依次向 5 个节点加锁
  2. 至少 3 个节点加锁成功
  3. 总耗时小于锁有效期
  4. 才认为加锁成功
```

它想解决的是单点 Redis 主从切换导致的锁丢失问题。

但工程上要注意：

```text
优点：比单 Redis 锁更抗单点故障
缺点：实现复杂、延迟更高、运维成本更高、仍有时钟和网络分区争议
```

生产取舍：

```text
1. 普通防重复提交、防并发刷新缓存：单 Redis 锁或 Redisson 足够
2. 库存扣减、订单创建：Redis 锁 + DB唯一约束/乐观锁兜底
3. 资金、支付、账户余额：不能只靠 Redis 锁，必须依赖数据库事务、唯一约束、幂等表、状态机
4. 真正强一致分布式协调：优先考虑 ZooKeeper、etcd、数据库行锁等 CP 组件
```

---

## 八、业务场景怎么选

### 8.1 可以用 Redis 锁的场景

```text
1. 防止缓存击穿：同一热点Key只允许一个线程回源DB
2. 防重复提交：短时间内同一用户重复点击
3. 定时任务抢占：多实例中只有一个实例执行任务
4. 非核心资源互斥：例如报表生成、配置刷新
```

这些场景的特点是：

```text
短时互斥、允许失败重试、允许最终一致、有业务兜底
```

### 8.2 不能只依赖 Redis 锁的场景

```text
1. 支付扣款
2. 账户余额变更
3. 订单唯一创建
4. 库存最终扣减
5. 资金路由唯一处理
```

这些场景必须有强约束兜底：

```text
数据库唯一索引
数据库乐观锁 version
数据库条件更新 stock > 0
幂等表 request_id
状态机流转约束
MQ最终一致补偿
```

架构师表达重点：

```text
Redis 锁用于降低并发冲突，不负责最终正确性；最终正确性要交给数据库约束、幂等和状态机。
```

---

## 题目二：秒杀库存扣减怎么防止超卖？

### 场景

你负责一个秒杀系统：

- 活动商品库存 1000 件
- 峰值 QPS 10 万
- 用户可能重复点击
- 下单链路涉及 Redis、MySQL、MQ
- 要求不能超卖，允许少量未支付订单后续释放库存

请回答：

1. 为什么不能直接查 MySQL 库存再扣减？
2. Redis 预扣库存怎么设计？用 `DECR` 够不够？
3. Lua 脚本扣库存相比多条 Redis 命令有什么优势？
4. 如何防止同一用户重复抢购？
5. Redis 扣减成功、创建订单失败怎么办？
6. MySQL 最终扣减库存怎么兜底防超卖？
7. 未支付订单超时释放库存怎么设计？
8. 秒杀库存设计里，Redis、MQ、MySQL 各自承担什么职责？

---

## 你的回答

（这里留空，等待用户回答）

---

## 架构师点评

（这里留空，等待用户回答后填写）

---

## 标准答案

## 一、为什么不能直接打 MySQL

错误方案：

```sql
select stock from product where id = 1001;
if stock > 0:
    update product set stock = stock - 1 where id = 1001;
```

高并发下问题很多：

```text
1. MySQL QPS 扛不住 10 万级请求
2. 先查再扣不是原子操作，容易并发超卖
3. 行锁竞争严重，热点商品库存行成为瓶颈
4. 大量请求阻塞在数据库，拖垮连接池和应用线程
```

秒杀的核心原则：

```text
入口削峰，Redis挡流量，MQ削峰，MySQL做最终一致性落库。
```

---

## 二、Redis预扣库存设计

### 2.1 活动预热

活动开始前，把库存加载到 Redis：

```text
seckill:stock:sku:1001 = 1000
seckill:user:sku:1001 = Set或Bitmap，用于记录已抢用户
```

### 2.2 只用 DECR 的问题

简单 `DECR`：

```text
DECR seckill:stock:sku:1001
```

问题：

```text
1. 库存可能扣成负数
2. 不能同时判断用户是否重复购买
3. 不能同时写入用户抢购记录
4. 多条命令之间不是原子的
```

例如：

```text
库存 = 1
用户A DECR 后库存 = 0，成功
用户B DECR 后库存 = -1，也已经扣了
```

虽然可以扣完后发现小于 0 再补回，但高并发下会产生大量无效写和复杂补偿。

---

## 三、Lua脚本原子扣库存

Lua 脚本可以把“判断库存、判断重复、扣减库存、记录用户”合并成一次原子操作。

示例逻辑：

```lua
local stockKey = KEYS[1]
local userKey = KEYS[2]
local userId = ARGV[1]

local bought = redis.call('SISMEMBER', userKey, userId)
if bought == 1 then
    return -2
end

local stock = tonumber(redis.call('GET', stockKey))
if stock == nil or stock <= 0 then
    return -1
end

redis.call('DECR', stockKey)
redis.call('SADD', userKey, userId)
return 1
```

返回值：

```text
1：抢购成功
-1：库存不足
-2：重复购买
```

优势：

```text
1. Redis 单线程执行 Lua，天然原子
2. 减少网络往返，多条命令变一次请求
3. 避免并发下重复购买和库存负数
4. 应用层逻辑更简单
```

---

## 四、防重复抢购

常见方案：

```text
1. Redis Set：SISMEMBER + SADD
   适合用户量不是特别夸张的活动

2. Bitmap：SETBIT userIdOffset
   适合用户ID连续或可映射，内存更省

3. MySQL唯一索引：唯一约束 sku_id + user_id
   最终兜底，防止重复订单落库

4. 幂等号：requestId / orderToken
   防止重复提交和接口重试
```

架构师表达：

```text
Redis 防重复是前置拦截，MySQL 唯一索引才是最终兜底。
```

---

## 五、Redis扣减成功但订单创建失败怎么办

这是秒杀系统的核心一致性问题。

链路：

```text
Redis Lua 预扣成功
    ↓
发送下单消息到 MQ
    ↓
消费者创建订单
    ↓
MySQL 扣减库存
```

如果中间失败，会出现：

```text
Redis 库存少了，但订单没创建
```

治理方案：

```text
1. MQ发送失败：回滚 Redis 库存和用户购买标记
2. MQ已发送但消费失败：消息重试 + 死信队列
3. 订单创建失败：释放 Redis 预扣库存，删除用户购买标记
4. MySQL扣减失败：订单标记失败，释放 Redis 预扣库存
5. 定时对账：Redis预扣记录、订单表、库存表定期校准
```

更稳的做法是记录预扣流水：

```text
seckill:reservation:{requestId}
  skuId
  userId
  status: RESERVED / ORDER_CREATED / RELEASED
  expireTime
```

这样补偿任务可以基于流水判断哪些预扣需要释放。

---

## 六、MySQL最终防超卖兜底

即使用了 Redis，MySQL 也必须防超卖。

推荐条件更新：

```sql
update product_stock
set stock = stock - 1
where sku_id = 1001
  and stock > 0;
```

判断影响行数：

```text
affected_rows = 1：扣减成功
affected_rows = 0：库存不足，扣减失败
```

如果是一个用户只能买一次：

```sql
create unique index uk_sku_user on seckill_order(sku_id, user_id);
```

这样即使 Redis 层漏了，MySQL 仍然能防住：

```text
1. 库存不能扣成负数：条件更新兜底
2. 用户不能重复下单：唯一索引兜底
3. 重复消息不能重复创建订单：幂等表/唯一索引兜底
```

---

## 七、未支付订单超时释放库存

常见设计：

```text
1. 用户抢购成功，创建待支付订单
2. 发送延迟消息：15分钟后检查订单状态
3. 如果订单未支付：取消订单，释放库存
4. 如果订单已支付：什么都不做
```

释放库存要注意幂等：

```text
只有订单状态从 WAIT_PAY → CANCELED 成功时，才能释放库存
```

SQL 示例：

```sql
update seckill_order
set status = 'CANCELED'
where order_id = #{orderId}
  and status = 'WAIT_PAY';
```

如果影响行数为 1，再释放库存：

```sql
update product_stock
set stock = stock + 1
where sku_id = #{skuId};
```

Redis 库存也要同步恢复，或通过活动库存对账任务修正。

---

## 八、Redis、MQ、MySQL职责边界

```text
Redis：
  1. 扛高并发读写
  2. 快速判断库存是否足够
  3. 快速判断用户是否重复抢购
  4. 做预扣减，不做最终事实来源

MQ：
  1. 削峰填谷
  2. 异步创建订单
  3. 解耦秒杀请求和订单落库
  4. 失败重试和死信补偿

MySQL：
  1. 保存最终订单
  2. 保存最终库存
  3. 用事务、唯一索引、条件更新保证最终正确性
  4. 支持对账和补偿
```

一句话总结：

```text
Redis 决定“能不能先放你进来”，MySQL 决定“最终这单是否真的成立”，MQ 负责“把瞬时高峰变成可消费的稳定流量”。
```

---

## 九、架构师回答模板

回答 Redis 分布式锁和秒杀库存问题时，可以固定按这个结构：

```text
1. 先说目标：互斥、防死锁、防误删、防超卖、防重复
2. 再说错误方案：SETNX+EXPIRE、GET后DEL、MySQL直接扣库存
3. 再说正确方案：SET NX PX、Lua解锁、Lua扣库存、Redisson看门狗
4. 再说异常场景：锁过期、客户端宕机、主从切换、MQ失败、订单失败
5. 最后说兜底：DB唯一索引、条件更新、幂等表、状态机、对账补偿
```

架构师层面的关键表达：

```text
Redis 适合做高性能前置互斥和预扣减，但不能作为资金、订单、库存最终正确性的唯一保障。越核心的业务，越要把最终一致性落到数据库约束、幂等状态机和补偿对账上。
```
