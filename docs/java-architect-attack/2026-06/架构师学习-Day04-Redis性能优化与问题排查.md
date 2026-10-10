
# Day 4：Redis性能优化与问题排查

## 题目一：慢查询与性能瓶颈定位

### 场景

你的蛋壳钱包系统在高峰期出现问题：

- 支付接口响应时间从50ms变成500ms
- 应用日志显示大量Redis命令超时
- Redis监控显示CPU使用率100%
- 但QPS只有5万，远没到Redis单实例10万的极限

请回答：

1. 怎么排查Redis慢查询？Redis的慢查询日志怎么配置和查看？
2. 哪些Redis命令容易导致慢查询？为什么KEYS、FLUSHDB这些命令要禁用？
3. 怎么通过Redis INFO命令定位性能瓶颈？CPU/内存/网络/复制延迟分别看哪些指标？
4. 怎么判断是Redis的问题还是应用的问题？给一个排查思路。
5. 如果发现是BigKey导致的，怎么识别BigKey？怎么处理？

---

## 你的回答

（这里留空，等待用户回答）

---

## 架构师点评

（这里留空，等待用户回答后填写）

---

## 标准答案

## 一、慢查询排查

### 1.1 慢查询日志配置

```
Redis慢查询日志相关配置：

slowlog-log-slower-than 10000
  → 超过10000微秒（10ms）的命令记录到慢查询日志
  → 生产环境建议设为1-5ms

slowlog-max-len 128
  → 慢查询日志最多保留128条
  → 建议设为1024，保留更多历史

config set slowlog-log-slower-than 1000
config set slowlog-max-len 1024
  → 动态修改配置，无需重启
```

### 1.2 查看慢查询日志

```
SLOWLOG GET N
  → 查看最近N条慢查询日志

SLOWLOG LEN
  → 查看慢查询日志条数

SLOWLOG RESET
  → 清空慢查询日志

慢查询日志示例：
1) (integer) 1
2) (integer) 1623283200
3) (integer) 15000
4) 1) "KEYS"
   2) "product:*"
5) "127.0.0.1:58781"
6) ""

字段含义：
  1: 日志编号
  2: 执行时间戳
  3: 执行耗时（微秒）
  4: 执行的命令和参数
  5: 客户端地址
  6: 客户端名称
```

### 1.3 常见慢查询命令

```
需要禁用/慎用的命令：
  KEYS pattern → O(n)，n是Key总数
  FLUSHDB/FLUSHALL → O(n)，清空整个库
  HGETALL big_hash → O(n)，n是field数
  LRANGE big_list 0 -1 → O(n)，n是元素数
  SMEMBERS big_set → O(n)，n是元素数
  ZRANGE big_zset 0 -1 → O(n)，n是元素数
  SINTER/SUNION/SDIFF → O(n+m+k)，集合操作

推荐替代方案：
  KEYS → SCAN（迭代遍历）
  HGETALL → HMGET（只取需要的field）或 HSCAN
  LRANGE → LTRIM（只保留需要的元素）
  大集合 → 拆分成多个小集合
```

## 二、INFO命令定位瓶颈

### 2.1 关键指标

```
INFO [section]
  → 不指定section返回所有信息
  → section可以是：server, clients, memory, persistence, stats, replication, cpu, cluster, keyspace

关注的核心指标：

1. CPU相关（info cpu）：
   used_cpu_sys: 0.5 → Redis内核占用CPU
   used_cpu_user: 1.2 → Redis用户态占用CPU
   → CPU高说明有慢查询或频繁的短命令

2. 内存相关（info memory）：
   used_memory: 8.5G → Redis已使用内存
   used_memory_peak: 10G → 内存峰值
   used_memory_rss: 9G → 物理内存占用
   mem_fragmentation_ratio: 1.06 → 内存碎片率
   → 碎片率&gt;1.5说明有内存碎片，需要整理

3. 客户端相关（info clients）：
   connected_clients: 200 → 当前连接数
   blocked_clients: 5 → 阻塞的客户端数
   maxclients: 10000 → 最大连接数
   → blocked_clients&gt;0说明有BLPOP等阻塞命令

4. 复制相关（info replication）：
   master_repl_offset: 1000000 → 主库复制偏移量
   slave0: state=online, offset=999000, lag=10 → 从库延迟
   → lag&gt;5s需要关注

5. 统计相关（info stats）：
   instantaneous_ops_per_sec: 50000 → 当前QPS
   total_commands_processed: 10000000 → 总命令数
   keyspace_hits: 9500000 → 缓存命中次数
   keyspace_misses: 500000 → 缓存未命中次数
   hit_rate: 95% → 缓存命中率
   → 命中率&lt;90%需要优化缓存策略
```

## 三、排查思路

### 3.1 问题定位流程

```
步骤1：确认是不是Redis的问题
  1. 看应用日志：有没有Redis超时、连接失败
  2. 看Redis监控：CPU/内存/QPS/慢查询
  3. 用redis-cli ping：看延迟是不是正常
  4. 用redis-benchmark压测：看Redis本身性能是不是正常

步骤2：如果是Redis的问题，看是哪类问题
  1. 慢查询：SLOWLOG GET看有没有慢命令
  2. BigKey：redis-cli --bigkeys扫描
  3. 内存满了：info memory看used_memory
  4. 复制延迟：info replication看lag
  5. 连接数满了：info clients看connected_clients

步骤3：如果不是Redis的问题，看应用的问题
  1. 连接池配置：是不是连接数不够
  2. 命令使用：是不是频繁创建销毁连接
  3. 序列化：是不是用了性能差的序列化方式
  4. 网络：是不是网络延迟大
```

### 3.2 Redis vs 应用问题判断

```
Redis问题特征：
  1. redis-cli ping延迟大
  2. redis-cli执行简单命令（GET/PING）也慢
  3. INFO stats显示instantaneous_ops_per_sec低
  4. SLOWLOG有大量慢查询

应用问题特征：
  1. redis-cli ping正常，但应用调用慢
  2. 应用日志显示获取连接超时
  3. 连接池配置不合理（maxTotal太小）
  4. 序列化/反序列化耗时太长
```

## 四、BigKey处理

### 4.1 识别BigKey

```
方法1：redis-cli --bigkeys
  → 扫描整个库，找出BigKey
  → 生产环境慎用，会阻塞Redis

方法2：SCAN + 类型判断
  → 用SCAN迭代遍历所有Key
  → 对每个Key用TYPE判断类型
  → 对String用STRLEN，对Hash用HLEN，对List用LLEN
  → 对Set用SCARD，对ZSet用ZCARD

方法3：RDB分析工具
  → redis-rdb-tools
  → 分析RDB文件，找出BigKey
  → 对Redis无影响

BigKey判断标准：
  String：value &gt; 10KB
  Hash/List/Set/ZSet：元素数 &gt; 1000
```

### 4.2 BigKey处理方案

```
方案1：拆分成多个小Key
  例如：
    user:100 → user:100:1, user:100:2, ..., user:100:n
  优点：简单直接
  缺点：客户端需要维护拆分逻辑

方案2：换成其他存储
  大Value → MongoDB/OSS
  大集合 → Tair/HBase
  优点：专业存储处理大数据更好
  缺点：架构变复杂

方案3：异步删除
  DEL big_key → UNLINK big_key（Redis 4.0+）
  → UNLINK不是真的删除，是放到后台线程删除
  → 不会阻塞主线程

方案4：压缩
  序列化后用GZIP/Snappy压缩
  优点：节省空间
  缺点：增加CPU开销
```

---

## 题目二：内存优化与碎片问题

### 场景

你的Redis实例遇到内存问题：

- used_memory_rss（物理内存）是used_memory（逻辑内存）的2倍
- 内存碎片率1.8，超过1.5的警戒线
- 明明删除了很多Key，但内存没怎么释放
- 重启Redis内存就降下来了，但业务不能接受重启

请回答：

1. 什么是内存碎片？为什么会出现内存碎片？
2. 怎么通过INFO命令查看内存碎片率？碎片率多少算正常？多少需要关注？
3. Redis 4.0+的MEMORY命令有哪些？怎么用MEMORY PURGE整理碎片？
4. 除了MEMORY PURGE，还有哪些减少内存碎片的方法？
5. 怎么优化Redis的内存占用？举5个以上的优化技巧。

---

## 你的回答

（这里留空，等待用户回答）

---

## 架构师点评

（这里留空，等待用户回答后填写）

---

## 标准答案

## 一、内存碎片原理

### 1.1 什么是内存碎片

```
内存碎片类比：
  停车场有10个车位
  车1停在1号，车2停在2号，车3停在3号
  车2开走了，2号车位空了
  现在来了一辆大巴，需要连续2个车位
  → 虽然有1+3+...号车位空着，但没有连续2个
  → 这就是内存碎片

Redis的内存碎片：
  Redis用jemalloc分配内存
  jemalloc按固定大小分配（8B, 16B, 32B, ..., 4KB）
  小Key删除后，留下的小空间很难被复用
  → 导致碎片
```

### 1.2 为什么会出现碎片

```
产生碎片的原因：

1. 频繁更新小Key
  例如：频繁修改String的value
  原来的value是100B，修改后变成200B
  → 原来的100B空间释放，但很难被复用

2. 大量删除Key
  删除大量Key后，留下很多小空间
  → 这些小空间难以被新Key复用

3. Key大小差异大
  有的Key是10B，有的是10KB
  → 10B的Key删除后，10KB的Key用不上
```

## 二、查看碎片率

### 2.1 INFO memory

```
INFO memory关键指标：

used_memory: 8589934592 → 8GB（逻辑内存，Redis实际使用）
used_memory_human: 8G
used_memory_rss: 15461882880 → 14.4GB（物理内存，实际占用）
used_memory_rss_human: 14.4G
mem_fragmentation_ratio: 1.8 → 碎片率
mem_allocator: jemalloc-5.1.0

碎片率计算：
  mem_fragmentation_ratio = used_memory_rss / used_memory

碎片率判断标准：
  &lt; 1.0：不正常，说明有swap（内存不够用，用磁盘）
  1.0 ~ 1.5：正常，健康范围
  &gt; 1.5：需要关注，碎片较多
  &gt; 2.0：严重，需要处理
```

## 三、碎片清理

### 3.1 MEMORY命令（Redis 4.0+）

```
MEMORY DOCTOR
  → 内存诊断，给出建议
  → 类似redis-cli info的智能解读

MEMORY STATS
  → 详细内存统计

MEMORY PURGE
  → 手动触发内存碎片整理
  → 不会阻塞主线程（后台线程执行）
  → 但不是100%能清理干净

MEMORY MALLOC-STATS
  → 内存分配器统计

生产建议：
  定期执行MEMORY PURGE（例如每天凌晨）
  → 不要等碎片率太高再处理
```

### 3.2 其他清理方法

```
方法1：重启Redis（最彻底）
  → 重启后重新加载数据
  → 完全没有碎片
  → 但业务不能接受长时间停机

方法2：主从切换
  → 新建一个从库
  → 全量同步后，把主库切到新从库
  → 新库没有碎片
  → 需要维护双写或暂停业务

方法3：手动重写AOF
  BGREWRITEAOF
  → AOF重写会重新整理数据
  → 有一定效果，但不如重启彻底

方法4：避免频繁更新
  → 减少碎片产生的根源
```

## 四、内存优化技巧

### 4.1 数据结构优化

```
技巧1：使用ziplist编码小集合
  hash-max-ziplist-entries 512
  hash-max-ziplist-value 64
  → 小Hash用ziplist编码，节省内存
  → 超过阈值自动转成hashtable

  list-max-ziplist-size -2
  → 小List用ziplist编码

  zset-max-ziplist-entries 128
  zset-max-ziplist-value 64
  → 小ZSet用ziplist编码

技巧2：Hash代替String存对象
  user:100:name = "张三"
  user:100:age = "20"
  → 改成：
  HSET user:100 name "张三" age "20"
  → 节省Key的内存开销

技巧3：Integer共享对象
  Redis对0-9999的整数做了共享
  → 用String存数字时，尽量用整数
  → 例如："1001"比"一千零一"省内存
```

### 4.2 Key设计优化

```
技巧4：Key名尽量短
  user:info:100 → u:i:100
  product:detail:123 → p:d:123
  → Key也是占内存的！

技巧5：过期时间合理设置
  不要设置过长的过期时间
  不用的Key及时删除
  → 释放内存

技巧6：冷数据归档
  30天前的数据 → 归档到MySQL/OSS
  → Redis只留热数据
```

### 4.3 其他优化

```
技巧7：使用Redis 6.0的IO多线程
  → 网络读写用多线程，命令执行还是单线程
  → 提升QPS

技巧8：关闭不需要的持久化
  纯缓存场景 → 可以关闭AOF和RDB
  → 节省磁盘IO

技巧9：使用内存淘汰策略
  maxmemory 10GB
  maxmemory-policy allkeys-lru
  → 内存满了自动淘汰旧数据

技巧10：使用Redis Cluster
  单实例内存不要超过20GB
  → 太大的话RDB fork慢，恢复慢
  → 用Cluster水平扩展
```

---

## 题目三：连接池问题与连接数满

### 场景

你的系统在高峰期出现：

- 应用日志：Could not get a resource from the pool
- Redis监控：connected_clients=10000，达到maxclients
- 很多连接是IDLE状态，空闲很久了

请回答：

1. Redis的最大连接数怎么配置？maxclients默认是多少？
2. 怎么通过CLIENT LIST查看连接信息？怎么看哪些连接是空闲的？
3. 连接池的常见问题有哪些？怎么配置Jedis/Redisson/Lettuce的连接池？
4. 怎么防止连接数泄漏？有哪些最佳实践？
5. 如果连接数突然满了，怎么快速处理？给一个应急方案。

---

## 你的回答

（这里留空，等待用户回答）

---

## 架构师点评

（这里留空，等待用户回答后填写）

---

## 标准答案

## 一、连接数配置

### 1.1 maxclients

```
Redis最大连接数配置：

1. 配置文件redis.conf：
   maxclients 10000
   → 默认10000

2. 动态修改：
   config set maxclients 20000
   → 无需重启

3. 查看当前连接数：
   info clients
   connected_clients: 5000
   → 当前5000个连接

注意：
  maxclients也受系统限制
  ulimit -n 至少要比maxclients大
  → ulimit -n 65535
```

### 1.2 CLIENT命令

```
CLIENT LIST
  → 列出所有连接

CLIENT LIST输出示例：
  id=1 addr=127.0.0.1:58781 fd=5 name= age=100 idle=50 flags=N db=0 sub=0 psub=0 multi=-1 qbuf=0 qbuf-free=0 obl=0 oll=0 omem=0 events=r cmd=GET user=default

关键字段：
  addr：客户端地址
  age：连接存活时间（秒）
  idle：空闲时间（秒）
  cmd：最后执行的命令

CLIENT KILL ip:port
  → 杀掉指定连接

CLIENT KILL addr 127.0.0.1:58781
  → 杀掉指定地址的连接

CLIENT KILL user default
  → 杀掉指定用户的连接
```

## 二、连接池配置

### 2.1 Jedis连接池

```java
JedisPoolConfig config = new JedisPoolConfig();
config.setMaxTotal(500);          // 最大连接数
config.setMaxIdle(200);           // 最大空闲连接
config.setMinIdle(50);            // 最小空闲连接
config.setMaxWaitMillis(3000);    // 获取连接等待超时
config.setTestOnBorrow(true);     // 借连接时测试
config.setTestOnReturn(true);     // 还连接时测试
config.setTestWhileIdle(true);    // 空闲时测试
config.setTimeBetweenEvictionRunsMillis(60000); // 空闲连接检测周期
config.setMinEvictableIdleTimeMillis(300000);   // 空闲连接最小存活时间

JedisPool pool = new JedisPool(config, "localhost", 6379);
```

### 2.2 Redisson连接池

```java
Config config = new Config();
config.useSingleServer()
    .setAddress("redis://localhost:6379")
    .setConnectionPoolSize(500)      // 连接池大小
    .setConnectionMinimumIdleSize(50) // 最小空闲连接
    .setConnectTimeout(10000)        // 连接超时
    .setTimeout(3000);               // 命令超时

RedissonClient client = Redisson.create(config);
```

### 2.3 Lettuce连接池

```java
RedisClient redisClient = RedisClient.create("redis://localhost:6379");
GenericObjectPoolConfig&lt;StatefulRedisConnection&lt;String, String&gt;&gt; poolConfig =
    new GenericObjectPoolConfig&lt;&gt;();
poolConfig.setMaxTotal(500);
poolConfig.setMaxIdle(200);
poolConfig.setMinIdle(50);

RedisPool&lt;String, String&gt; pool = new RedisPool&lt;&gt;(
    redisClient::connect, poolConfig);
```

## 三、连接池常见问题

### 3.1 连接泄漏

```
连接泄漏原因：
  1. 借了连接没还
     Jedis jedis = pool.getResource();
     // 用完没close
  2. 异常时没释放
     try { jedis = pool.getResource(); }
     catch (Exception e) {}
     // 没有finally
  3. 线程池里的连接没释放

防止泄漏：
  1. 用try-with-resources
     try (Jedis jedis = pool.getResource()) { ... }
  2. 用finally块
     try { jedis = pool.getResource(); }
     finally { if (jedis != null) jedis.close(); }
  3. 连接池配置testWhileIdle，定期检测
```

### 3.2 连接数满

```
连接数满的原因：
  1. 连接池MaxTotal太小
  2. 连接泄漏，连接没释放
  3. Redis maxclients太小
  4. 应用实例太多，累加起来超过maxclients

应急处理：
  1. 先杀掉空闲连接
     CLIENT KILL addr idle&gt;300
     → 杀掉空闲超过5分钟的连接
  2. 临时调大maxclients
     config set maxclients 20000
  3. 查找泄漏的原因并修复
```

## 四、连接池最佳实践

```
最佳实践1：连接数不要太大
  单应用连接池MaxTotal 50-500足够
  → 太多连接反而会降低性能

最佳实践2：合理设置MaxIdle/MinIdle
  MaxIdle = MaxTotal * 0.5
  MinIdle = MaxTotal * 0.1
  → 避免频繁创建销毁连接

最佳实践3：定期检测空闲连接
  testWhileIdle = true
  timeBetweenEvictionRunsMillis = 60000
  minEvictableIdleTimeMillis = 300000
  → 定期清理空闲连接

最佳实践4：设置合理的超时
  maxWaitMillis = 3000
  connectTimeout = 10000
  timeout = 3000
  → 避免无限等待

最佳实践5：监控连接池状态
  监控活跃连接数、空闲连接数、等待线程数
  → 提前发现问题
```

---

## 题目四：Redis问题排查实战

### 场景

给你几个真实的故障场景，请给出排查思路和解决方案：

1. **场景A**：Redis的CPU突然100%，但QPS不高，只有2万
2. **场景B**：Redis内存持续增长，但业务没有明显增长
3. **场景C**：主从延迟越来越大，从库数据一直追不上主库
4. **场景D**：Redis Cluster有个节点不停的MOVED重定向

请针对每个场景，给出：
1. 排查步骤
2. 可能原因
3. 解决方案

---

## 你的回答

（这里留空，等待用户回答）

---

## 架构师点评

（这里留空，等待用户回答后填写）

---

## 标准答案

## 场景A：CPU 100%但QPS不高

### 排查步骤

```
步骤1：查看慢查询日志
  SLOWLOG GET 50
  → 看有没有慢查询

步骤2：查看INFO stats
  INFO stats
  → 看keyspace_hits/hits_rate，命中率是不是很低
  → 看instantaneous_ops_per_sec，QPS是不是真的低

步骤3：用redis-cli monitor看实时命令
  redis-cli monitor
  → 看执行的都是什么命令

步骤4：查看INFO cpu
  INFO cpu
  → 看used_cpu_sys和used_cpu_user哪个高
```

### 可能原因

```
原因1：有慢查询命令
  例如：KEYS、HGETALL大Hash、LRANGE大List
  → 查看慢查询日志确认

原因2：集中过期
  大量Key在同一时间过期
  → 过期删除操作也会占用CPU
  → 看INFO stats的expired_keys

原因3：RDB/AOF重写
  fork子进程生成RDB或重写AOF
  → 看INFO persistence
  → rdb_bgsave_in_progress或aof_rewrite_in_progress

原因4：Lua脚本执行时间过长
  → 看慢查询日志里有没有EVAL/EVALSHA
```

### 解决方案

```
方案1：如果是慢查询
  → 禁用KEYS，用SCAN
  → 大Hash用HSCAN，不要HGETALL
  → 大List用LTRIM，不要LRANGE 0 -1

方案2：如果是集中过期
  → TTL加随机值，打散过期时间
  → 用EXPIRE key TTL + random(0, 3600)

方案3：如果是持久化
  → 调整bgsave时间，放到低峰期
  → AOF重写阈值调大
  → 纯缓存场景可以关闭持久化

方案4：如果是Lua脚本
  → 优化Lua脚本，减少执行时间
  → 拆分成多个小脚本
```

---

## 场景B：内存持续增长

### 排查步骤

```
步骤1：查看INFO memory
  INFO memory
  → 看used_memory是不是持续增长
  → 看mem_fragmentation_ratio是不是很高

步骤2：查看INFO keyspace
  INFO keyspace
  → 看哪个库的Key数在增长
  → 看expires，是不是有大量永久Key

步骤3：用redis-cli --bigkeys扫描
  → 看是不是有BigKey

步骤4：用RDB分析工具
  redis-rdb-tools -c memory dump.rdb
  → 分析Key的内存分布
```

### 可能原因

```
原因1：没有设置过期时间
  大量Key是永久的，不会自动删除
  → 看INFO keyspace的expires

原因2：有BigKey一直在增长
  例如：用户行为日志的List一直在append
  → 用redis-cli --bigkeys扫描

原因3：内存碎片
  删除大量Key后，碎片率很高
  → 看mem_fragmentation_ratio

原因4：Pub/Sub消息堆积
  消费者消费太慢，消息积压
  → 看INFO stats的pubsub_channels
```

### 解决方案

```
方案1：设置过期时间
  给所有Key设置合理的TTL
  → 不要用永久Key

方案2：清理BigKey
  → 拆分BigKey
  → 冷数据归档
  → UNLINK异步删除

方案3：整理内存碎片
  → MEMORY PURGE（Redis 4.0+）
  → 低峰期重启

方案4：优化Pub/Sub
  → 用Stream代替Pub/Sub（有持久化）
  → 消费者扩容
```

---

## 场景C：主从延迟大

### 排查步骤

```
步骤1：查看INFO replication
  INFO replication
  → 看slave的lag值
  → 看master_repl_offset和slave的offset差

步骤2：查看从库的INFO stats
  → 看sync_partial_err，是不是频繁全量同步
  → 看sync_full，全量同步次数

步骤3：查看主从网络
  → ping看延迟
  → iperf看带宽

步骤4：查看从库的慢查询
  → 从库也会执行写命令，可能有慢查询
```

### 可能原因

```
原因1：网络带宽不够
  主库写入量大，从库同步不过来
  → 看带宽使用率

原因2：复制积压缓冲区太小
  repl-backlog-size 1MB
  → 网络抖动后，从库offset不在backlog里
  → 退化成全量同步

原因3：从库执行慢查询
  从库也会执行主库的写命令
  → 从库也可能有慢查询阻塞复制

原因4：主库写入太快
  主库写入QPS超过从库的处理能力
```

### 解决方案

```
方案1：优化网络
  → 主从同机房部署
  → 升级带宽

方案2：调大复制积压缓冲区
  repl-backlog-size 512MB
  → 根据写入量计算
  → 写入5MB/s，断连10分钟，需要3000MB

方案3：从库优化
  → 从库关闭持久化（RDB/AOF）
  → 从库禁用慢查询（避免影响复制）

方案4：限制主库写入
  → 限流
  → 拆分成多个主从实例
```

---

## 场景D：Cluster不停MOVED

### 排查步骤

```
步骤1：查看集群状态
  CLUSTER NODES
  → 看节点是不是都是connected
  → 看slot分配是不是正常

步骤2：查看槽位迁移情况
  CLUSTER SLOTS
  → 看有没有槽位在迁移中

步骤3：查看客户端配置
  → 是不是用了智能客户端
  → 是不是缓存了slot-node映射
```

### 可能原因

```
原因1：槽位正在迁移
  → 部分key在源节点，部分在目标节点
  → 源节点返回ASK，不是MOVED

原因2：客户端缓存没更新
  → 客户端缓存了旧的slot-node映射
  → 节点变更后，缓存没更新

原因3：集群配置不一致
  → 部分节点的槽位分配信息不对
  → 节点之间没有同步

原因4：有节点故障
  → 某个节点挂了，槽位没迁移
```

### 解决方案

```
方案1：等待槽位迁移完成
  → 迁移期间会有ASK重定向
  → 迁移完成后就正常了

方案2：客户端刷新缓存
  → MOVED后，客户端应该更新缓存
  → 检查客户端是不是支持自动刷新

方案3：检查集群状态
  CLUSTER INFO
  → 看cluster_state是不是ok
  → 看cluster_slots_assigned是不是16384

方案4：修复故障节点
  → 重启故障节点
  → 或者手动故障转移
```

---

## Day4核心总结

```
Day4主线：Redis性能优化与问题排查

慢查询排查：
  SLOWLOG GET查看慢查询
  KEYS/FLUSHDB/HGETALL大集合是常见原因
  → 用SCAN/UNLINK/HSCAN替代

内存优化：
  mem_fragmentation_ratio &gt; 1.5需要关注
  MEMORY PURGE整理碎片（Redis 4.0+）
  → 小集合用ziplist，Hash代替String，Key名尽量短

连接池问题：
  连接泄漏是最常见原因
  → try-with-resources/finally释放连接
  → testWhileIdle定期检测空闲连接

实战排查：
  CPU 100%：慢查询/集中过期/持久化
  内存增长：永久Key/BigKey/碎片
  主从延迟：网络/backlog太小/从库慢查询
  Cluster MOVED：槽位迁移/客户端缓存/节点故障
```

---

*日期：2026-06-11 | 2026年06月第2周 Day4 | Redis性能优化与问题排查*

