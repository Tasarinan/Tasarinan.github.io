# 架构师学习-Day05-在线问诊系统 JVM 调优案例 - 梳理

> 日期：2026年08月07日（周五，补全）
> 周主题：JVM 专题第 2 周 - 调优实战与生产排查
> 出题日：Day05 - 在线问诊系统 JVM 实战（5 个 STAR 故障案例 + JVM 调优参数模板 + 业务架构协同）

---

## 一、5 个 STAR 案例的统一方法论

### 1.1 5 个案例的核心特征

| 案例 | 服务 | 故障类型 | JVM 维度 | 工具链组合 | 核心根因 |
|------|------|---------|---------|----------|---------|
| 案例一 | IM 网关 | Direct Buffer OOM | 直接内存 | NMT + Arthas heapdump + MAT | ByteBuf.retain() 后未 release |
| 案例二 | 视频问诊 SFU | GC CPU 高 | GC + CPU | top -Hp + jmap + Arthas vmtool + GC 日志 | RTPQueue 重连时残留 |
| 案例三 | 监管上报 | Heap OOM | Heap | 自动 dump + MAT + OQL | 5 类泄漏模式之"静态集合无限增长" |
| 案例四 | 问诊订单 | GC CPU 高 | GC + CPU | jmap + Arthas vmtool | Caffeine 没设 maximumSize |
| 案例五 | 消息存档 | Humongous OOM | G1 Humongous | GC 日志 + jmap -histo | 5MB 文档 > Region / 2 阈值 |

### 1.2 5 个案例的统一排查方法论

```text
架构师视角的 JVM 故障排查 6 步法：

第 1 步：现象分类（30 秒）
  - 看 K8s OOMKilled vs JVM OOM
  - 看 GC 频繁 vs GC 慢
  - 看 CPU 高 vs Heap 高
  - 看 Direct 高 vs Metaspace 高
  - 判断是哪一类故障

第 2 步：抓现场（1 分钟）
  - jstack + jmap dump + GC 日志三件套
  - 注意：先摘流量再 dump（避免雪崩）
  - 注意：自动 dump 未必抓到元凶

第 3 步：工具链选择（1 分钟）
  - Heap OOM：MAT + OQL + Dominator Tree
  - Direct OOM：NMT + Arthas heapdump + MAT
  - GC CPU 高：jmap -histo + Arthas vmtool + GC 日志
  - Humongous：GC 日志 + jmap -histo + G1 调参
  - CPU 死循环：top -Hp + jstack + async-profiler

第 4 步：根因定位（1 分钟）
  - 从对象类型反推业务代码
  - 从引用链找强引用持有者
  - 从代码逻辑确认泄漏点

第 5 步：止血（1 分钟）
  - 扩容 + 限流 + 降级
  - 主动清理（Arthas ognl 调用业务方法）
  - 临时调参（重启）

第 6 步：根因修复（24 小时）
  - 代码层：修复生命周期 / 加 maximumSize / 拆分大对象
  - 配置层：G1 Region / IHOP / MaxDirectMemorySize
  - 监控层：4 维度监控 + 告警 + JFR 持续录制
  - 流程层：Code Review Checklist + 故障演练
```

### 1.3 5 个案例的关键陷阱

| 案例 | 关键陷阱 | 架构师视角的规避 |
|------|---------|---------------|
| 案例一 | -XX:+HeapDumpOnOutOfMemoryError 抓不到 Direct 现场 | 用 NMT + Arthas 主动 dump |
| 案例二 | G1 Region 4MB 配 RtpQueue 1MB 跨 Region | Region >= 业务对象 × 2 |
| 案例三 | 自动 dump 时元凶对象可能已变 | 80% 主动 dump + JFR 持续录制 |
| 案例四 | Caffeine 没设 maximumSize 等于"缓存所有" | Code Review Checklist 第一条 |
| 案例五 | 5MB 文档 > Region / 2 = 2MB 触发 Humongous | Region 选型 + Schema 拆分 |

---

## 二、JVM 与业务架构协同的 5 个维度

### 2.1 维度一：缓存架构（三级缓存的边界划分）

```text
三级缓存模型：
  L1: Caffeine（本地缓存，1w Key 以内，TTL 30min）
  L2: Redis（分布式缓存，所有数据，TTL 24h）
  L3: MySQL（持久化，永久）

边界划分原则：
  - 热点数据：L1（最近 30min 内的活跃查询）
  - 全量数据：L2（24h 内的所有数据）
  - 持久化：L3

JVM 调优协同：
  - L1 Caffeine 必须设 maximumSize（避免 Heap 膨胀）
  - L1 Caffeine 必须设 TTL（避免老对象堆积）
  - L1 Caffeine 必须开 recordStats（监控命中率）
  - L2 Redis 不占 JVM Heap（但占用网络 / 序列化开销）
  - L3 MySQL 不占 JVM Heap（但占用连接池）

在线问诊系统的缓存边界：
  | 数据类型 | L1 maximumSize | L1 TTL | L2 TTL | L3 |
  |---------|---------------|--------|--------|-----|
  | 问诊订单 | 1w | 30min | 24h | 永久 |
  | 医师信息 | 5000 | 1h | 24h | 永久 |
  | 药品目录 | 5w | 24h | 7d | 永久 |
  | 监管规则 | 3w | 24h | 7d | 永久 |
  | 会话路由 | 1w | 5min | 1h | - |
```

### 2.2 维度二：消息可靠性（4 层保障的协同）

```text
4 层消息可靠性保障：
  1. Outbox 模式（业务表 + 消息表本地事务）
  2. RocketMQ 事务消息（高性能，与业务解耦）
  3. 客户端 ACK + seq 补齐（保证客户端不丢）
  4. 服务端重发补偿（保证 ACK 不丢）

JVM 调优协同：
  - Outbox 表存 MySQL，不占 JVM Heap
  - RocketMQ 客户端有内部缓存（producer 内部 batch）
    -> 调 producer maxBatchSize / maxBatchIntervalMillis
  - 客户端 seq 存 Redis，不占 JVM Heap
  - 服务端重发 Map 必须用 Caffeine + maximumSize + TTL

在线问诊系统的消息可靠性：
  | 消息类型 | 保障层级 | JVM 关注点 |
  |---------|---------|----------|
  | 处方消息 | Outbox + 事务消息 + 重发 | 重发 Map 用 Caffeine |
  | 监管上报 | 事务消息 + 重发 + 死信 | 幂等 Map 用 Redis |
  | 聊天消息 | 事务消息 + ACK + 重发 | 重发 Map 用 Caffeine |
  | 图片消息 | OSS + URL | 不在 JVM 持有图片 |
```

### 2.3 维度三：大对象处理（存储与传输策略）

```text
大对象分类与处理策略：
  | 类型 | 大小 | 存储 | 传输 | JVM 影响 |
  |------|------|------|------|---------|
  | 图片 | 100KB-5MB | OSS | URL | 不在 JVM 持有 |
  | 视频 | 50MB-500MB | OSS | URL + 流式 | 不在 JVM 持有 |
  | 大文档 | 1MB-10MB | MongoDB 拆分 | 流式 | 触发 Humongous |
  | 大日志 | 1MB-100MB | ES | MMAP | Direct Memory |

JVM 调优协同：
  - 不在 JVM Heap 中持有大对象
  - 流式处理（InputStream / OutputStream，不要一次 read 全部）
  - 大对象分配触发 Humongous 时调大 G1 Region
  - 用 Direct ByteBuffer 处理网络 IO（不占 Heap）
  - MongoDB Schema 拆分避免大文档
  - ES Lucene 用 MMAP 处理大索引
```

### 2.4 维度四：长连接管理（10w+ 长连接的内存模型）

```text
10w 长连接的内存模型：
  - 每个连接 Netty 内部约 4KB（Channel + Pipeline + ByteBuf）
  - 10w 连接 × 4KB = 400MB Direct Memory
  - 加上心跳 ByteBuf / 业务 ByteBuf = 1GB Direct
  - 加上 Heap 中的 Channel 对象 = 200MB Heap

JVM 调优协同：
  - MaxDirectMemorySize 2g（10w 长连接 + 业务 buffer）
  - Heap 4g（业务对象 + 缓存）
  - K8s Pod 8GB（Heap 4g + Direct 2g + JVM 自身 1g + buffer 1g）

心跳设计与 GC 协同：
  - 心跳间隔 60s（客户端 -> 服务端）
  - 心跳超时 180s（3 次心跳未收到判定断线）
  - GC 停顿必须 < 心跳超时（MaxGCPauseMillis 100ms）
  - 心跳 ByteBuf 池化（避免每次 new）

Netty ByteBuf 生命周期管理：
  - 用 SimpleChannelInboundHandler 自动 release
  - 业务代码不直接持有 DirectByteBuffer
  - 用 Netty 池化 ByteBuf（PooledByteBufAllocator）
  - Code Review 检查所有 ByteBuf release
```

### 2.5 维度五：容量规划（K8s / JVM / Direct / Metaspace 全局配比）

```text
K8s Pod 内存的全局配比模板：

| Pod 大小 | Heap | Direct | Metaspace | JVM 自身 | Buffer |
|---------|------|--------|-----------|---------|--------|
| 4GB | 2g | 1g | 256m | 500m | 250m |
| 8GB（IM/订单） | 4g | 2g | 512m | 1g | 500m |
| 8GB（监管） | 6g | 0 | 256m | 1g | 750m |
| 16GB（视频） | 8g | 4g | 512m | 2g | 1.5g |
| 16GB（存档） | 8g | 1g | 512m | 2g | 4.5g |
| 32GB（大堆） | 24g | 4g | 512m | 2g | 1.5g |

容量规划公式：
  K8s limit = Heap + Direct + Metaspace + JVM 自身 + Buffer
  Heap = 50% K8s limit（默认）/ 75%（无 Netty 时）
  Direct = 25% K8s limit（有 Netty 时）
  Metaspace = 256-512MB（固定）
  JVM 自身 = 13% K8s limit（Code Cache + Thread Stack + GC 日志）
  Buffer = 6-9% K8s limit（防止 OOMKilled）

JVM 自身开销明细：
  - Code Cache: 240MB（默认）
  - Thread Stack: 1MB × 200 线程 = 200MB
  - GC 日志: 100MB
  - Heap Dump 预留: 500MB
  - Arthas / JFR 元数据: 100MB
  - 合计: 约 1GB
```

---

## 三、5 类内存泄漏模式的识别清单

### 3.1 5 类泄漏模式总览

```text
1. 缓存膨胀：Caffeine / Guava Cache 没设 maximumSize
2. ThreadLocal 累积：线程池下 ThreadLocal 没 remove
3. 监听器 Callback 未 unregister：监听器注册后没移除
4. 静态集合无限增长：静态 Map / List 没清理
5. finalize 队列堆积：finalize 方法导致对象延迟回收
```

### 3.2 识别清单

#### 模式 1：缓存膨胀

```text
典型代码：
  Cache<String, Object> cache = Caffeine.newBuilder()
      .expireAfterWrite(30, TimeUnit.MINUTES)
      // 忘了 .maximumSize(10000)
      .build();

识别清单：
  - 是否设了 maximumSize？
  - maximumSize 是否合理（不超过 1w）？
  - 是否设了 TTL？
  - 是否开了 recordStats 监控命中率？
  - 命中率是否 > 80%？
  - cache.size 是否超过预期？

修复方案：
  - 加 maximumSize
  - 加 TTL
  - 开 recordStats
  - 加监控告警（size / hit rate / eviction）

本案例：案例四问诊订单 Caffeine 缓存 100w Key
```

#### 模式 2：ThreadLocal 累积

```text
典型代码：
  private static final ThreadLocal<UserContext> userContext = new ThreadLocal<>();
  
  public void handle(Request req) {
      userContext.set(new UserContext(req));
      // 忘了 finally { userContext.remove(); }
      // 线程池下 ThreadLocalMap 累积
  }

识别清单：
  - 是否在 finally 中 remove？
  - 是否用了线程池？
  - ThreadLocal 中存的对象大小是否合理？
  - 是否有"线程池 + ThreadLocal + 大对象"反模式？

修复方案：
  - try-finally remove
  - 用 try-with-resources 模式
  - 避免在大对象上用 ThreadLocal
  - 用 ScopedValue（JDK 21+）替代 ThreadLocal
```

#### 模式 3：监听器 Callback 未 unregister

```text
典型代码：
  public class Listener {
      public Listener() {
          EventBus.register(this);  // 注册
          // 忘了 destroy 时 EventBus.unregister(this)
      }
  }

识别清单：
  - 注册了监听器是否有 unregister？
  - 是否用 @PreDestroy 注解？
  - 监听器是否持有大对象？
  - 监听器数量是否持续增长？

修复方案：
  - @PreDestroy 注解 unregister
  - 用 WeakReference 持有监听器
  - 监听器不持有大对象
  - 监控监听器数量
```

#### 模式 4：静态集合无限增长

```text
典型代码：
  private static final Map<String, Task> taskMap = new ConcurrentHashMap<>();
  // 没有 maximumSize
  // 没有 TTL
  // 没有清理机制

识别清单：
  - 是否是 static Map / List？
  - 是否设了 maximumSize？
  - 是否设了 TTL？
  - 是否有定期清理？
  - 业务成功 / 失败时是否 remove？

修复方案：
  - 用 Caffeine 替代 ConcurrentHashMap
  - 加 maximumSize + TTL
  - 业务成功 / 失败时 remove
  - 用 Redis 替代 JVM Map（不占 Heap）

本案例：案例三监管上报 Map 累积 OOM
```

#### 模式 5：finalize 队列堆积

```text
典型代码：
  public class Resource {
      @Override
      protected void finalize() throws Throwable {
          // 在 finalize 中释放资源
          // finalize 由 GC 线程异步执行，延迟回收
      }
  }

识别清单：
  - 是否用了 finalize 方法？
  - finalize 是否有耗时操作？
  - 是否可以改用 Cleaner（JDK 9+）？
  - 是否可以改用 try-with-resources？

修复方案：
  - 用 Cleaner 替代 finalize（JDK 9+）
  - 用 try-with-resources
  - finalize 只用于最后兜底，不做关键资源释放
  - 注意：JDK 18 提案移除 finalize

为什么 finalize 被废弃：
  1. 性能差（finalize 由 GC 线程异步执行，延迟回收）
  2. 易内存泄漏（finalize 异常导致对象"复活"）
  3. 替代方案：Cleaner（JDK 9+）/ try-with-resources
  4. JDK 9 标记 Deprecated，JDK 18 提案移除
```

### 3.3 Code Review Checklist

```text
JVM 安全 Code Review Checklist（10 条）：

1. 所有 Caffeine / Guava Cache 必须设 maximumSize + TTL
2. 所有 ThreadLocal 必须 try-finally remove
3. 所有监听器必须 @PreDestroy unregister
4. 所有静态 Map / List 必须用 Caffeine + maximumSize + TTL
5. 所有 ByteBuf 必须 release（用 SimpleChannelInboundHandler）
6. 不能用 finalize，改用 Cleaner / try-with-resources
7. 所有数据库连接 / 文件流必须 try-with-resources
8. 所有 Kafka / RocketMQ consumer 必须有 max.poll.records 限制
9. 所有定时任务必须有超时机制（避免线程泄漏）
10. 所有外部 HTTP 调用必须有连接池 + 超时
```

---

## 四、JVM 监控 4 维度体系

### 4.1 4 维度监控指标

```text
维度 1：Heap
  - jvm_memory_heap_used（已用）
  - jvm_memory_heap_committed（已分配）
  - jvm_memory_heap_max（最大）
  - jvm_gc_collection_seconds（GC 耗时）
  - jvm_gc_collection_count（GC 次数）

维度 2：Direct Memory
  - jvm_memory_direct_used（已用）
  - jvm_memory_direct_committed（已分配）
  - jvm_memory_direct_max（最大）
  - jvm_buffer_pool_used_buffers（DirectByteBuffer 实例数）

维度 3：Metaspace
  - jvm_memory_metaspace_used（已用）
  - jvm_memory_metaspace_committed（已分配）
  - jvm_memory_metaspace_max（最大）
  - jvm_classloader_classes_loaded（加载类数）

维度 4：RSS（K8s 进程总内存）
  - container_memory_rss（K8s cgroup）
  - container_memory_working_set_bytes（K8s 实际使用）
  - container_memory_OOMKilled（OOMKilled 计数）
```

### 4.2 告警规则

```text
Heap 告警：
  - heap_used / heap_max > 80% 持续 1 分钟 -> P2 告警
  - heap_used / heap_max > 90% 持续 30 秒 -> P1 告警 + 主动 dump
  - Full GC > 1 次/分钟 -> P1 告警
  - Young GC > 10 次/分钟 -> P2 告警

Direct 告警：
  - direct_used / direct_max > 75% -> P2 告警
  - direct_used / direct_max > 90% -> P1 告警 + NMT 分析
  - DirectByteBuffer 实例数 > 5w -> P2 告警

Metaspace 告警：
  - metaspace_used / metaspace_max > 80% -> P2 告警
  - 类加载数持续增长 -> P2 告警（可能是类加载泄漏）

RSS 告警：
  - rss / k8s_limit > 85% -> P2 告警
  - rss / k8s_limit > 95% -> P1 告警（即将 OOMKilled）
  - OOMKilled 计数 > 0 -> P1 告警
```

### 4.3 主动 dump 策略

```text
主动 dump 触发条件：
  1. Heap 使用率 > 85% 主动 dump
  2. Direct Memory > 75% 主动 dump
  3. RSS > 90% K8s limit 主动 dump
  4. Full GC > 3 次/分钟 主动 dump
  5. 业务异常（如接口超时率 > 5%）主动 dump

主动 dump 实现：
  # 用 jcmd 主动 dump（不依赖 OOM）
  jcmd PID GC.heap_dump /data/dump/proactive-$(date +%s).hprof

  # 用 Arthas heapdump（更稳定，不触发 Full GC）
  arthas> heapdump /data/dump/proactive.hprof

  # 定时任务（每 5 分钟检查 + 主动 dump）
  */5 * * * * /opt/jvm-monitor/dump-if-needed.sh
```

### 4.4 JFR 持续录制

```text
JFR（Java Flight Recorder）持续录制配置：
  -XX:StartFlightRecording=\
    duration=1h,\
    filename=/data/jfr/recording.jfr,\
    maxsize=200M,\
    maxage=1h,\
    settings=profile

JFR 优势：
  1. 开销低（< 1% CPU）
  2. 持续录制（不像 dump 是一次性）
  3. 包含对象分配 / GC / JIT / Safepoint 等全维度
  4. JDK 11+ 开源（免费）

JFR 分析工具：
  - JDK Mission Control（官方 GUI）
  - jcmd JFR.view（命令行）
  - jfr2flame（火焰图转换）
```

---

## 五、JVM 调优参数模板库

### 5.1 4 套生产配置对比

| 服务 | Heap | Direct | G1 Region | IHOP | MaxGCPause | K8s limit |
|------|------|--------|----------|------|-----------|-----------|
| IM 网关 | 4g | 2g | 4m | 35% | 100ms | 8GB |
| 视频 SFU | 8g | 4g | 8m | 30% | 50ms | 16GB |
| 监管上报 | 6g | 0 | 4m | 40% | 200ms | 8GB |
| 消息存档 | 8g | 0 | 16m | 35% | 200ms | 16GB |

### 5.2 通用参数模板

```bash
# 通用 JVM 参数模板（所有服务都用）
java \
  # 堆大小（固定，避免动态扩展）
  -Xmx${HEAP} -Xms${HEAP} \
  # GC 收集器
  -XX:+UseG1GC \
  -XX:MaxGCPauseMillis=${GC_PAUSE} \
  -XX:G1HeapRegionSize=${REGION} \
  -XX:InitiatingHeapOccupancyPercent=${IHOP} \
  -XX:G1ReservePercent=15 \
  # 元空间
  -XX:MetaspaceSize=256m \
  -XX:MaxMetaspaceSize=512m \
  # JIT 参数
  -XX:+TieredCompilation \
  # 容器化参数
  -XX:+UseContainerSupport \
  -XX:InitialRAMPercentage=${RAM_PCT} \
  -XX:MaxRAMPercentage=${RAM_PCT} \
  # 监控参数
  -XX:NativeMemoryTracking=summary \
  -Xlog:gc*:file=/data/log/gc.log:time,level,tags:filecount=10,filesize=100M \
  -XX:StartFlightRecording=duration=1h,filename=/data/jfr/recording.jfr,maxsize=200M \
  # 故障兜底
  -XX:+HeapDumpOnOutOfMemoryError \
  -XX:HeapDumpPath=/data/dump/ \
  -XX:OnOutOfMemoryError="kill -9 %p" \
  -jar app.jar
```

### 5.3 G1 Region 选型决策树

```text
G1 Region 选型决策树：
  
  1. 业务最大对象多大？
     - < 1MB：Region 2MB（默认）
     - 1-2MB：Region 4MB
     - 2-8MB：Region 8MB 或 16MB
     - 8-16MB：Region 16MB 或 32MB
     - > 16MB：考虑 ZGC / Shenandoah（避免 Humongous）

  2. 堆大小多少？
     - 4GB：Region 2MB / 4MB
     - 8GB：Region 4MB / 8MB / 16MB
     - 16GB：Region 8MB / 16MB / 32MB
     - 32GB：Region 16MB / 32MB

  3. 选择原则：
     Region 大小 > 业务最大对象大小 × 2
     避免对象触发 Humongous（>= Region / 2）

  4. 在线问诊系统的 4 个服务：
     - IM 网关：最大对象 ByteBuf 1MB -> Region 4MB
     - 视频 SFU：最大对象 RtpQueue 1MB -> Region 8MB（跨 Region 保险）
     - 监管上报：最大对象 ReportTask 100KB -> Region 4MB
     - 消息存档：最大对象 BsonDocument 5MB -> Region 16MB
```

### 5.4 IHOP 调优决策

```text
IHOP（Initiating HeapOccupancy Percent）调优：
  
  默认值：45%（JDK 9+ 自适应，JDK 8 固定 45%）
  
  调低场景（30-35%）：
    - 对象分配率高（IM 网关 / 视频 SFU）
    - Old 区上涨快
    - Mixed GC 跟不上
  
  调高场景（50-55%）：
    - 对象分配率低（监管上报 / 消息存档）
    - Old 区上涨慢
    - 频繁 Mixed GC 浪费 CPU
  
  在线问诊系统的 4 个服务：
    - IM 网关：35%（对象分配率高）
    - 视频 SFU：30%（对象分配率最高）
    - 监管上报：40%（中等）
    - 消息存档：35%（大文档批量处理）
```

---

## 六、与简历项目的衔接点

### 6.1 5 个 STAR 案例与简历项目的对应

| 简历项目模块 | Day05 STAR 案例 | 简历文档已有内容 | Day05 补充内容 |
|------------|---------------|---------------|--------------|
| 医患 IM 服务 | 案例一：IM 网关 ByteBuf OOM | 架构文档 / 难点拆解 | JVM 调优案例 + STAR 故事 |
| 视频问诊服务 | 案例二：视频 RTP 包堆积 | 架构文档 / 难点拆解 | JVM 调优案例 + STAR 故事 |
| 监管上报服务 | 案例三：监管上报 Map OOM | 架构文档 / 难点拆解 | JVM 调优案例 + STAR 故事 |
| 问诊订单服务 | 案例四：问诊订单缓存膨胀 | 架构文档 / 难点拆解 | JVM 调优案例 + STAR 故事 |
| 消息存档服务 | 案例五：MongoDB 大文档 | 架构文档 / 难点拆解 | JVM 调优案例 + STAR 故事 |

### 6.2 简历项目延伸文档产出

Day05 的 5 个 STAR 案例会整理为简历项目延伸文档：

```text
文件路径：2026年07月第4周/简历项目-在线问诊系统-JVM调优案例.md
内容结构：
  - 5 个 STAR 案例（面试讲述版，比 Day05 更精炼）
  - JVM 调优参数模板（4 套生产配置）
  - JVM 与业务架构协同（5 个维度）
  - 面试追问点（每个案例 5-10 个追问）

与已有 3 份简历文档的关系：
  - 简历项目-在线问诊系统-架构文档.md（已存在）
  - 简历项目-在线问诊系统-技术亮点与难点拆解.md（已存在）
  - 简历项目-在线问诊系统-面试问答预演.md（已存在）
  - 简历项目-在线问诊系统-JVM调优案例.md（Day05 产出，新增）
  - 简历项目-在线问诊系统-核心模块-医保对接.md（已存在）
  - 简历项目-在线问诊系统-核心模块-处方开具.md（已存在）

形成"架构 -> 难点 -> 面试预演 -> JVM 调优 -> 核心模块"完整闭环
```

### 6.3 面试讲述策略

```text
面试官追问"讲一个你处理的 JVM 故障"时：

策略 1：根据面试官兴趣选案例
  - 面试官关注内存：讲案例三（Heap OOM + MAT 分析）
  - 面试官关注 GC：讲案例二（GC CPU 高 + G1 调优）
  - 面试官关注 Netty：讲案例一（Direct Buffer OOM）
  - 面试官关注缓存：讲案例四（Caffeine 膨胀）
  - 面试官关注 MongoDB：讲案例五（Humongous Allocation）

策略 2：选最有"故事性"的案例
  - 案例一最有故事性：凌晨 OOM + 监控盲区 + 5 分钟定位
  - 案例三最有深度：5 类泄漏模式 + OQL + Caffeine
  - 案例五最有"架构师视角"：G1 调优 + Schema 优化 + 冷热分离

策略 3：用 STAR 法则结构化讲述
  S（Situation）：业务背景 + 故障现象（30 秒）
  T（Task）：任务目标（10 秒）
  A（Action）：5 步法 + 工具链 + 根因（3 分钟）
  R（Result）：业务结果 + 经验沉淀（30 秒）

总时长：5 分钟内讲完一个案例
```

---

## 七、能力差距与补足方向

### 7.1 Day05 暴露的能力差距

| 能力项 | 我的水平 | 架构师水平 | 补足方向 |
|--------|---------|----------|---------|
| 5 个 STAR 案例讲述 | 能讲但不够熟练 | 5 分钟内讲完一个案例 | 用 STAR 法则演练 10 次 |
| Direct Memory 排查 | 知道 NMT 但不熟练 | 30 秒内用 jcmd NMT 看 Internal | 每周练 1 次 NMT 分析 |
| G1 Humongous 机制 | 知道概念但不知道 Region 选型 | 能脱口而出 Region / 2 阈值 | 精读 OpenJDK g1CollectedHeap.cpp |
| MAT 支配树 | 知道怎么看 | 能讲清支配集算法 + Retained Size 本质 | 精读 IBM Dominator Tree paper |
| OQL 查询 | 不熟悉语法 | 能写复杂 OQL 查特定模式对象 | 每周练 2 个 OQL 查询 |
| 5 类泄漏模式 | 知道 2-3 类 | 能背出 5 类 + 识别清单 | 整理团队"5 类泄漏 Checklist" |
| Caffeine 配置 | 知道基本用法 | 能讲清 maximumSize / TTL / 弱引用键 | 精读 Caffeine wiki |
| Arthas vmtool | 不熟悉 | 能用 vmtool 查实例数 + 字段值 | 每周练 1 次 vmtool |
| G1 Region 选型 | 用默认值 | 能根据业务对象大小选 Region | 整理团队"G1 Region 选型规范" |
| MongoDB Schema | 凭感觉设计 | 能讲清大文档拆分 + 冷热分离 | 调研 MongoDB Schema 设计最佳实践 |
| JVM 监控 4 维度 | 只看 Heap | 4 维度（Heap / Direct / Metaspace / RSS） | 搭建 Prometheus + JVM Exporter |
| 容量规划 | 凭感觉 | 能根据 K8s limit 算 JVM 配比 | 整理团队"JVM 容量规划模板" |

### 7.2 补足路径

```text
第 2 周剩余补足计划：

Day06（今日）：串联整合 - 一次完整的 JVM 故障复盘
  - 补足差距2.6 / 3.5 / 4.2（5 分钟定位 + 节奏感）
  - 故障时间线 / 根因 6 层次 / 复盘模板 / 改进项跟踪

Day07（明日）：架构深挖 - ZGC 底层原理
  - 补足差距1.1 / 第5周差距3.2 / 7.7（ZGC / Shenandoah）
  - 染色指针 / 读屏障 / 并发整理 / 分代 ZGC（JDK 21）

第 3 周开始：Service Mesh / 简历项目继续延伸
```

### 7.3 长期能力建设

```text
长期补足方向（1-3 个月）：

1. JVM 工具链体系建设
  - 搭建 Prometheus + JVM Exporter + 4 维度监控
  - 搭建 JFR 持续录制 + Arthas sidecar 体系
  - 设计主动 dump 策略 + 大 dump 离线分析流水线

2. JVM 调优规范沉淀
  - 整理团队"JVM 生产配置模板库"（4 套：IM / 视频 / 监管 / 归档）
  - 整理团队"5 类泄漏模式识别 Checklist"
  - 整理团队"G1 Region 选型规范"
  - 整理团队"JVM 容量规划模板"

3. JVM 故障演练
  - 每月一次故障演练（注入内存泄漏 / CPU 死循环 / 死锁）
  - 整理团队"5 分钟定位 SOP"
  - 用 STAR 法则整理 10 个真实案例

4. JDK 8 -> 17 升级
  - 写 IM 网关 JDK 17 升级 RFC
  - 评估 ZGC 选型
  - 评估 AppCDS / AOT 编译
```

---

## 八、本周学习节奏回顾

```text
2026年08月第1周（JVM 专题第 2 周 - 调优实战与生产排查）

Day01（08/03 周一）：JVM 调优参数全解
  - 出题 + 作答 + 梳理
  - 5 个子问题：堆内存 / GC / JIT / 容器化 / -XX 陷阱
  - 发现 7 项差距（1.1-1.7）

Day02（08/04 周二）：JVM 诊断工具链实战
  - 出题 + 作答 + 梳理
  - 5 个子问题：JDK 自带 / Arthas / MAT / jstack+火焰图 / GC 日志
  - 1 个场景题：5 分钟定位 Full GC 元凶
  - 发现 10 项差距（2.1-2.10）

Day03（08/05 周三）：OOM 排查实战
  - 出题 + 作答 + 梳理
  - 5 个子问题：8 种 OOM 类型 / 5 种 dump 方式 / MAT 支配树 / 5 类泄漏模式 / 5 分钟定位
  - 1 个场景题：监管上报服务 OOM 排查（STAR 法则）
  - 发现 8 项差距（3.1-3.8）

Day04（08/06 周四）：CPU 飙高排查实战
  - 出题 + 作答 + 梳理
  - 5 个子问题：6 种 CPU 类型 / 5 步法 / async-profiler 4 模式 / JIT 退优化 / Safepoint
  - 1 个场景题：IM 网关 CPU 95% 排查（STAR 法则）
  - 发现 9 项差距（4.1-4.9）

Day05（08/07 周五，补全）：在线问诊系统 JVM 实战
  - 出题 + 作答 + 梳理
  - 5 个 STAR 案例：IM 网关 ByteBuf OOM / 视频 RTP 包堆积 / 监管上报 Map OOM / 问诊订单缓存膨胀 / MongoDB 大文档
  - JVM 调优参数模板（4 套生产配置）
  - JVM 与业务架构协同（5 个维度）
  - 产出简历项目延伸文档：在线问诊系统-JVM调优案例.md

Day06（08/08 周六，今日）：串联整合 - 一次完整的 JVM 故障复盘
Day07（08/09 周日，明日）：架构深挖 - ZGC 底层原理
```
