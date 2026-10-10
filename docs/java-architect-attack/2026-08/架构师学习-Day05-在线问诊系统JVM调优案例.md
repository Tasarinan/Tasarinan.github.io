# 架构师学习-Day05-在线问诊系统 JVM 调优案例

> 日期：2026年08月07日（周五，补全）
> 周主题：JVM 专题第 2 周 - 调优实战与生产排查
> 出题日：Day05 - 在线问诊系统 JVM 实战（5 个 STAR 故障案例 + JVM 调优参数模板 + 业务架构协同）

---

## 背景

Day01 把 JVM 调优参数梳理清楚，Day02 把诊断工具链梳理清楚，Day03 进入 OOM 排查（内存维度），Day04 转到 CPU 维度。**Day05 是本周的"实战日"**，把 Day01-Day04 的工具链与方法论全部用到简历项目"在线问诊系统"的 5 个真实场景上，产出可以作为面试讲述的 STAR 故事。

**为什么 Day05 是"在线问诊系统 JVM 实战"而不是"更多工具练习"**：

1. **简历项目打磨的核心产出**：用户当前简历项目"在线问诊系统"已完成架构文档、难点拆解、面试预演 3 份核心文档，但缺少 JVM 调优案例的实战支撑。Day05 产出 5 个 STAR 故事，直接成为面试加分项
2. **5 个场景覆盖 JVM 全维度**：IM 网关 ByteBuf 泄漏（直接内存 OOM）/ 视频 RTP 包堆积（GC 频繁 CPU 高）/ 监管上报 Map 累积（heap OOM）/ 问诊订单缓存膨胀（GC CPU 高）/ MongoDB 大文档（G1 Humongous），刚好覆盖 Day01-Day04 的全部知识点
3. **架构师面试官最爱追问"讲一个你处理的 JVM 故障"**：5 个案例覆盖内存模型、GC 选型、工具链、OOM 排查、CPU 排查，能在面试中根据面试官兴趣选 2-3 个深讲
4. **呼应第 1 周 Day06 串联日**：第 1 周 Day06 是"IM 网关从 5w QPS 优化到 15w QPS 的全链路调优"，Day05 是"5 个独立故障的 STAR 故事"，两者形成"优化"和"故障"两个互补视角

**与 Day01 / Day02 / Day03 / Day04 的衔接点**：

- Day01 讲了 `-XX:MaxDirectMemorySize`、`-XX:+HeapDumpOnOutOfMemoryError`、`-XX:MaxGCPauseMillis`、`-XX:+UseG1GC` 等参数，Day05 把这些参数落到 5 个场景的具体配置上
- Day02 讲了 jstack / jmap / jcmd / Arthas / MAT / async-profiler / JFR 工具链，Day05 在 5 个案例中分别用不同的工具组合
- Day03 讲了 8 种 OOM 类型 / 5 种 dump 方式 / MAT 支配树 / 5 类泄漏模式，Day05 的案例一、二、三、五都是 OOM 场景，分别用到不同的 dump 方式与排查路径
- Day04 讲了 6 种 CPU 高类型 / 5 步法 / async-profiler 4 模式 / JIT 退优化 / Safepoint，Day05 的案例二、四是 CPU 高场景，分别用到不同的 CPU 排查路径

**与往周专题的衔接点**：

- **6月第2周 Redis**：案例四问诊订单缓存与 Redis 缓存的边界（Caffeine 本地缓存 vs Redis 分布式缓存）
- **6月第3周 ES**：案例五 MongoDB 大文档与 ES Lucene MMAP 的对比（都是大对象内存压力）
- **6月第4周 限流降级**：案例一 IM 网关 ByteBuf OOM 触发 Sentinel 限流误判（GC STW 引发限流统计失真）
- **6月第5周 支付**：案例三监管上报与支付幂等性的相似性（都是 24h 必达 + 幂等）
- **7月第1周 医疗**：案例三监管上报就是医疗合规要求的"24h 内必达"
- **7月第4周简历项目**：5 个场景全部来自简历项目，与已有 3 份简历文档形成"架构 -> 难点 -> 面试预演 -> JVM 调优"完整闭环
- **7月第5周 JVM 第1周**：Day07 G1 GC 底层（Region / SATB / Mixed GC / Humongous），Day05 案例五直接用 G1 Humongous 概念；Day03 GC 收集器全谱系，Day05 案例二讨论 G1 vs ZGC 选型

**与简历项目的衔接点**：

5 个 STAR 案例直接对应简历项目"在线问诊系统"的 5 个核心模块：

| 简历项目模块 | Day05 STAR 案例 | 故障类型 | 工具链组合 |
|------------|---------------|---------|----------|
| 医患 IM 服务 | 案例一：IM 网关 ByteBuf 直接内存 OOM | Direct Buffer OOM | jcmd + NMT + MAT + Arthas |
| 视频问诊服务 | 案例二：视频问诊 RTP 包堆积 Full GC 频繁 | GC CPU 高 | jstat + GC 日志 + async-profiler |
| 监管上报服务 | 案例三：监管上报 Map 累积 heap OOM | Heap OOM | 自动 dump + MAT + OQL |
| 问诊订单服务 | 案例四：问诊订单缓存 100w Key GC CPU 高 | GC CPU 高 | Arthas vmtool + jstat + GC 日志 |
| 消息存档服务 | 案例五：MongoDB 大文档 G1 Humongous | Humongous OOM | jmap -histo + GC 日志 + G1 调参 |

Day06 会做"一次完整的 JVM 故障复盘"串联，Day07 深挖 ZGC。

---

## 题目一（5 个 STAR 案例全解题）：在线问诊系统 JVM 调优实战

请详细回答以下问题：

1. **案例一 - IM 网关 ByteBuf 直接内存 OOM**：在线问诊系统 IM 网关（10w+ 长连接、Netty 4.1.x、Spring Boot 2.7、JDK 8）凌晨突发 `OutOfMemoryError: Direct buffer memory`，服务无响应 3 分钟，触发雪崩。请用 STAR 法则完整讲述：业务背景、故障现象、5 分钟定位过程（jcmd VM.native_memory + Arthas heapdump + MAT 分析 DirectByteBuffer 实例）、根因（某业务代码 `ByteBuf.retain()` 后未 release，导致 DirectByteBuffer 强引用链进入老年代）、止血与修复（限流降级 + ByteBuf 生命周期重构 + -XX:MaxDirectMemorySize 调优）、与 Netty 内部机制（PoolArena / PoolChunk / MemoryRegionCache）的关系、为什么 -XX:+HeapDumpOnOutOfMemoryError 抓不到直接内存现场
2. **案例二 - 视频问诊 RTP 包堆积 Full GC 频繁**：视频问诊 SFU 服务（日均 3200 路视频通话、单机 200 路并发）出现 Full GC 频繁（每分钟 8 次，STW 1.5s），导致视频卡顿、P99 RT 800ms。请用 STAR 法则讲述：业务背景、故障现象、5 步法定位（top -Hp + jstack 看到 GC Thread 占 60% CPU）、jstat + GC 日志分析（Old 区上涨快、Mixed GC 失败）、根因（RTPQueue 通话结束未 clear，每路通话 5MB 包堆积在 Old 区）、止血与修复（修复 RTPQueue 生命周期 + G1 Region 调大 8MB + -XX:G1HeapRegionSize=8m）、为什么 G1 Mixed GC 没能回收（RTPQueue 跨 Region 引用 + RSet 更新成本）、与 ZGC 选型的对比（视频低延迟场景为什么 ZGC 更合适）
3. **案例三 - 监管上报 Map 累积 heap OOM**：监管上报服务（医疗合规 24h 必达、3 万条上报规则、Kafka 消费 1300 QPS）出现 `Java heap space` OOM，自动重启后 30 分钟再次 OOM。请用 STAR 法则讲述：业务背景、故障现象、自动 dump + MAT 分析（Dominator Tree 发现 ConcurrentHashMap$Node 占 4.5GB / 6GB heap）、OQL 查询（`SELECT s FROM java.util.concurrent.ConcurrentHashMap s WHERE s.@retainedHeapSize > 1000000` 找到 3 个超大 Map）、根因（ReportTaskMap 用 reportId 作 key 但 reportId 是 UUID 每次新建、上报失败重试时新建 ReportTask 而非复用、5 类泄漏模式中的"静态集合无限增长"）、止血与修复（修复 reportId 复用 + Caffeine 替换 ConcurrentHashMap 加 maximumSize + expireAfterWrite）、为什么自动 dump 抓到的不是元凶（OOM 前 Full GC 多次，对象状态已变）、与支付幂等性的对比（都是 24h 必达 + 幂等）
4. **案例四 - 问诊订单缓存 100w Key GC CPU 高**：问诊订单服务（日均 5.2w 订单、Caffeine 本地缓存）出现 CPU 80%+ 持续高，但接口 RT 正常。请用 STAR 法则讲述：业务背景、故障现象、5 步法 + Arthas vmtool 定位（top -Hp 看到 GC Thread 占 50% CPU、Arthas `vmtool --action getInstances --className com.github.benmanes.caffeine.cache.BoundedLocalCache` 找到 1 个 Caffeine 实例 size=100w）、jstat + GC 日志分析（Young GC 频繁每秒 1 次、Old 区缓慢上涨）、根因（Caffeine maximumSize 设了 100w 应该是 1w，业务理解错误以为"缓存所有订单"）、止血与修复（maximumSize 1w + expireAfterWrite 30min + Caffeine vs Redis 边界重新划分）、为什么 Young GC 频繁而非 Old GC（Caffeine 内部 LinkedHashMap 频繁 put 触发 Young GC）、与第 1 周 Day06 IM 网关优化的呼应（缓存调优是 JVM 调优的"业务侧调优"）
5. **案例五 - MongoDB 大文档 G1 Humongous Allocation**：消息存档服务（MongoDB 存储会话消息、年新增 7.6 亿条、单文档最大 5MB）出现 G1 Humongous Allocation 频繁，Full GC 每分钟 1 次。请用 STAR 法则讲述：业务背景、故障现象、GC 日志分析（`[Humongous Allocation]` 标记、`[Pause (G1 Evacuation Pause) (humongous)]`）、jmap -histo 看到 byte[] 占 70% heap、根因（5MB 文档超过 G1 Region 大小 50%（默认 4MB Region / 2MB 阈值），被打成 Humongous Object 走特殊 GC 路径）、止血与修复（-XX:G1HeapRegionSize=16m 让 5MB 文档不再 Humongous + MongoDB Schema 优化把大文档拆分为多条小文档 + 冷热分离）、为什么 G1 Humongous 影响 GC 性能（Humongous Object 在老年代连续 Region、回收只能在 Full GC 或 Concurrent Marking 后、容易引发 Full GC）、与 ES Lucene FST 的对比（都是大对象内存压力，但 ES 用 MMAP 解决）

### 作答区

---

### 案例一 - IM 网关 ByteBuf 直接内存 OOM

#### Situation - 业务背景与故障现象

**业务背景**：

啄木鸟云健康在线问诊系统 IM 网关，承担医患 IM 长连接管理与消息分发：

```text
部署：K8s 3 副本，每副本 4 core CPU / 8GB 内存 / 4GB 直接内存
框架：Spring Boot 2.7 + Netty 4.1.x + JDK 8u362
协议：WebSocket + 自研 IM 协议（消息体 JSON）
业务规模：
  - 日均 210w 消息，峰值 360w/s
  - 单机 10w+ 长连接
  - 单会话最大消息数 500+
JVM 参数（故障前）：
  -Xmx4g -Xms4g
  -XX:+UseG1GC -XX:MaxGCPauseMillis=200
  -XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/data/dump/
  -XX:MaxDirectMemorySize=2g
  -Dio.netty.leakDetection.level=SIMPLE
```

**故障现象（2025-Q2 某日凌晨 03:15）**：

```text
03:15:00  监控告警：im-gateway CPU 95%、内存 90%
03:15:30  监控告警：im-gateway 健康检查失败
03:16:00  K8s 自动重启 Pod（OOMKilled）
03:16:30  重启后 30 秒再次 OOMKilled
03:17:00  3 个 Pod 全部 OOMKilled，IM 服务完全不可用
03:17:30  雪崩：业务服务调用 IM 网关超时，问诊订单创建失败
03:18:00  客户端开始大规模断连，10w+ 用户受影响
03:30:00  紧急回滚到上一版本（怀疑是新版本引入）
03:45:00  回滚后服务恢复，但根因不明

影响：
  - 服务不可用 30 分钟
  - 1.5w 问诊订单创建失败
  - 10w+ 用户断连
  - 间接影响夜间问诊订单 5%
```

**关键监控数据**：

```text
Pod 监控：
  - CPU：常态 30% → 95%（持续 2 分钟后 OOMKilled）
  - 内存（Heap）：常态 2.5GB → 3.8GB（未到 4GB 上限）
  - 内存（RSS）：常态 4GB → 7.5GB（接近 K8s limit 8GB）
  - 直接内存：未监控（盲区！）

GC 日志（重启前的最后一段）：
  [03:14:50] GC(1234) Pause Young (Normal) (G1 Evacuation Pause) 2800M->2200M(4096M) 35.123ms
  [03:14:55] GC(1235) Pause Young (Normal) (G1 Evacuation Pause) 2900M->2300M(4096M) 38.456ms
  [03:15:00] GC(1236) Pause Young (Normal) (G1 Evacuation Pause) 3000M->2400M(4096M) 42.789ms
  # 没有看到 Full GC，但 RSS 在飙
  # → 强烈提示是 Native 内存 / 直接内存问题
```

#### Task - 任务目标

```text
1. 5 分钟内定位 OOM 根因（heap OOM / Direct OOM / Metaspace OOM / Native OOM）
2. 30 分钟内止血恢复服务
3. 24 小时内根因修复 + 预防体系改进
```

#### Action - 排查与修复过程

##### 第 1 步（0:00-0:30）：现象分类 - 这不是普通的 Heap OOM

**关键判断：监控盲区 - 直接内存**：

```bash
# 看监控：Heap 才 3.8GB，没到 4GB 上限，为什么 OOMKilled？
# K8s OOMKilled 是基于 RSS（进程总内存），不是 JVM Heap
# RSS 7.5GB ≈ Heap 3.8GB + Direct Memory ? + JVM 自身 + Metaspace
# → 怀疑是 Direct Memory 泄漏

# 但 JVM 没抛 OutOfMemoryError: Direct buffer memory
# 为什么？因为 -XX:MaxDirectMemorySize=2g 但实际 Direct 可能超了
# 在 JDK 8 中，-XX:MaxDirectMemorySize 是"软限制"（不强制），full 时才检查
# 实际 Direct 可能涨到 3GB+ 才 OOM
```

**第 1 步结论**：**这不是 Heap OOM，是 Direct Memory 泄漏引发 K8s OOMKilled**。

##### 第 2 步（0:30-1:00）：抓现场 - 启动新 Pod 时配置好工具链

```bash
# 1. 临时调整启动参数，加上 Direct 监控
java -Xmx4g -Xms4g \
  -XX:+UseG1GC -XX:MaxGCPauseMillis=200 \
  -XX:MaxDirectMemorySize=2g \
  -Dio.netty.leakDetection.level=ADVANCED \  # 升级到 ADVANCED（采样 10%）
  -XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/data/dump/ \
  -XX:NativeMemoryTracking=summary \  # 启用 NMT 跟踪 Native 内存
  -Xlog:gc*:file=/data/log/gc.log:time,level,tags \  # GC 日志
  -jar im-gateway.jar

# 2. 配置 Arthas tunnel server，方便远程接入
# 3. 配置 Prometheus + JVM Exporter（含 direct_memory_used 指标）
```

##### 第 3 步（1:00-2:00）：复现 + NMT 分析

**复现故障**（用回滚前的版本）：

```bash
# 拉一份流量到新版本 Pod（10% 灰度）
kubectl scale deployment im-gateway-canary --replicas=1
# 配置 ServiceMesh 路由 10% 流量到 canary

# 监控 1 小时后，Direct Memory 涨势：
# 00:00 - 100MB
# 00:30 - 800MB
# 01:00 - 1.5GB
# 01:30 - 2GB（接近 -XX:MaxDirectMemorySize 限制）
# 01:45 - 2.5GB（超过限制但没 OOM，因为 JDK 8 是软限制）
```

**NMT 分析**：

```bash
# 用 jcmd NMT 看 Native 内存构成
jcmd 1 VM.native_memory summary

# 关键输出：
Internal (reserved=2648058KB, committed=2648058KB)
                            # ← 2.5GB 在 Internal 分类下
                            # NMT 把 Direct ByteBuffer 计入 Internal

Direct Buffer 内存统计（更精确的方式）：
jcmd 1 GC.class_histogram | grep -i direct
# 12345: 50000: 1200000: java.nio.DirectByteBuffer
# 50000 个 DirectByteBuffer，占 1.2GB

# 或者用 Arthas：
ognl '@java.nio.Bits@reservedMemory'
# 2648058KB ≈ 2.5GB
```

**第 3 步结论**：DirectByteBuffer 实例数 5w，占用 2.5GB Native 内存，已经超 -XX:MaxDirectMemorySize=2g 的软限制。

##### 第 4 步（2:00-3:00）：Arthas heapdump + MAT 分析 DirectByteBuffer 引用链

**为什么 -XX:+HeapDumpOnOutOfMemoryError 抓不到直接内存现场**：

```text
关键陷阱：
  1. HeapDump 只 dump Heap，不 dump Native / Direct
  2. 但 DirectByteBuffer 对象本身在 Heap 中（约 100 字节）
  3. DirectByteBuffer 内部的 cleaner 是 PhantomReference
  4. 直接内存的释放依赖 Cleaner（GC 时触发）
  5. 如果 DirectByteBuffer 被强引用，Cleaner 永远不会触发
  6. 直接内存就泄漏了

→ 所以要看 Heap 中的 DirectByteBuffer 引用链
```

**Arthas heapdump**：

```bash
# 用 Arthas 主动 dump（不触发 Full GC，比 jmap -dump 优越）
arthas> heapdump /data/dump/im-gateway-direct.hprof

# 也可以用 jcmd
jcmd 1 GC.heap_dump /data/dump/im-gateway-direct.hprof
```

**MAT 分析 DirectByteBuffer 引用链**：

```text
1. OQL 查询所有 DirectByteBuffer：
   SELECT db FROM java.nio.DirectByteBuffer db WHERE db.capacity > 1000000
   → 找到 200 个 capacity > 1MB 的 DirectByteBuffer

2. 右键 -> Path to GC Roots -> exclude weak/soft references
   → 找到强引用链：
   ImHandler.messageHandlers (ConcurrentHashMap)
     -> MessageHandler.buffer (DirectByteBuffer)
       -> DirectByteBuffer.cleaner (PhantomReference)
       → DirectByteBuffer 被强引用，Cleaner 无法触发

3. 看 DirectByteBuffer 的创建栈（通过 Allocation Record）：
   com.example.ImHandler.decode(ChannelHandlerContext, ByteBuf)
   → 业务代码在 decode 时 alloc 了 DirectByteBuffer 但没 release
```

##### 第 5 步（3:00-4:00）：根因定位 - 业务代码 Bug

**业务代码片段**：

```java
// ImHandler.decode - 业务代码 Bug
public class ImHandler extends ChannelInboundHandlerAdapter {
    
    // 静态 Map 缓存所有连接的 handler
    private static final Map<Channel, MessageHandler> messageHandlers = new ConcurrentHashMap<>();
    
    @Override
    public void channelActive(ChannelHandlerContext ctx, ByteBuf msg) {
        // 创建 MessageHandler，内部 alloc 一个 DirectByteBuffer 作为接收缓冲
        MessageHandler handler = new MessageHandler(ctx.channel());
        handler.buffer = ctx.alloc().directBuffer(1024 * 1024);  // 1MB Direct
        messageHandlers.put(ctx.channel(), handler);
        // ↑ 这里把 handler 放进静态 Map，handler 持有 DirectByteBuffer
        // 只要 channel 没断开，handler 就一直在 Map 中
        // DirectByteBuffer 就一直被强引用
    }
    
    @Override
    public void channelInactive(ChannelHandlerContext ctx) {
        // Bug！channelInactive 时移除了 handler 但没 release buffer
        MessageHandler handler = messageHandlers.remove(ctx.channel());
        // 应该 handler.buffer.release(); 但忘了！
        // → handler 移除后，handler.buffer 进入老年代
        // → 每次有客户端断连，就泄漏 1MB Direct
        // → 10w 长连接，每天 20% 断连 = 2w 次 × 1MB = 20GB Direct 泄漏
    }
}
```

**为什么凌晨 03:15 才 OOM**：

```text
- 服务运行 7 天，累积了 1.5GB Direct 泄漏
- 03:00 凌晨流量小，但客户端大量重连（断网后重连）
- 03:15 1 分钟内 5000+ 客户端断连重连
- 每次断连重连泄漏 1MB Direct
- 1 分钟内泄漏 5GB → Direct 涨到 6.5GB
- JVM Heap 没满（DirectByteBuffer 对象才 100B × 5w = 5MB）
- 但 Native 内存飙到 7.5GB
- K8s limit 8GB，触发 OOMKilled
```

##### 第 6 步（4:00-5:00）：止血 + 根因修复

**止血（立即）**：

```bash
# 止血方案 1：扩容 +3 Pod，分散流量
kubectl scale deployment im-gateway --replicas=6

# 止血方案 2：限流客户端重连（LB 层）
# 每 IP 每秒最多 1 次重连

# 止血方案 3：恢复 SIMPLE 等级（ADVANCED 也有 10% 开销）
# 临时下线 canary
kubectl scale deployment im-gateway-canary --replicas=0
```

**根因修复**：

**PR 1：修复 ByteBuf 生命周期管理（核心修复）**

```java
// 坏代码：手动 release，容易忘
public class ImHandler extends ChannelInboundHandlerAdapter {
    private static final Map<Channel, MessageHandler> messageHandlers = new ConcurrentHashMap<>();
    
    @Override
    public void channelInactive(ChannelHandlerContext ctx) {
        MessageHandler handler = messageHandlers.remove(ctx.channel());
        // 忘了 release buffer
    }
}

// 好代码：用 try-with-resources 或 SimpleInboundHandler
public class ImHandler extends SimpleChannelInboundHandler<ByteBuf> {
    
    @Override
    protected void channelRead0(ChannelHandlerContext ctx, ByteBuf msg) {
        // SimpleChannelInboundHandler 自动 release msg
        // 业务不需要手动 release
        try (ByteBuf respBuf = ctx.alloc().buffer(1024)) {
            processMessage(msg, respBuf);
            ctx.writeAndFlush(respBuf.retain());  // writeAndFlush 会自动 release
        }
    }
    
    @Override
    public void channelInactive(ChannelHandlerContext ctx) {
        // 不再持有 DirectByteBuffer，不需要 release
        messageHandlers.remove(ctx.channel());
    }
}
```

**PR 2：移除业务代码中的 DirectByteBuffer alloc（用 Netty 池化 ByteBuf）**

```java
// 坏代码：业务自己 alloc DirectByteBuffer
handler.buffer = ctx.alloc().directBuffer(1024 * 1024);  // 1MB Direct

// 好代码：用 Netty 池化的 ByteBuf，由 Netty 管理
// 业务代码不直接持有 ByteBuf 引用
// 用 ChannelOption.ALLOCATOR 配置池化分配器
ServerBootstrap b = new ServerBootstrap();
b.group(bossGroup, workerGroup)
 .channel(NioServerSocketChannel.class)
 .option(ChannelOption.ALLOCATOR, PooledByteBufAllocator.DEFAULT)  // 池化
 .childOption(ChannelOption.ALLOCATOR, PooledByteBufAllocator.DEFAULT);
```

**PR 3：JVM 参数调优 + Direct Memory 监控**

```bash
# JVM 参数（修复后）
java -Xmx4g -Xms4g \
  -XX:+UseG1GC -XX:MaxGCPauseMillis=200 \
  -XX:MaxDirectMemorySize=2g \
  -XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/data/dump/ \
  -XX:NativeMemoryTracking=summary \
  -Dio.netty.leakDetection.level=SIMPLE \
  -Dio.netty.allocator.type=pooled \  # Netty 池化
  -Dio.netty.maxDirectMemory=2g \  # Netty 内部 Direct 限制
  -jar im-gateway.jar

# 监控改进（关键）：
# 1. Prometheus + JVM Exporter 加 direct_memory_used 指标
# 2. 告警：Direct Memory > 1.5GB（75% 阈值）
# 3. Grafana 看板：Heap / Direct / Metaspace / RSS 4 个维度
```

**与 Netty 内部机制的关系**：

```text
Netty ByteBuf 分配的层级：
  PoolArena（默认 4 个堆 + 4 个直接）
    -> PoolChunk（默认 16MB，由 Arena 分配）
      -> PoolSubpage（小块 < 8KB）
      -> MemoryRegionCache（线程本地缓存，减少锁竞争）

为什么池化 ByteBuf 比直接 new DirectByteBuffer 好：
  1. 池化减少 alloc / free 开销（DirectByteBuffer 创建涉及 malloc 系统调用）
  2. 减少内存碎片
  3. Netty 内部 ReferenceCount 清理机制（release() 时引用计数 -1，到 0 归还池）

但池化 ByteBuf 必须 release()，否则：
  - 池中的 ByteBuf 不会被归还
  - 但比直接 DirectByteBuffer 泄漏好一点：池有上限，超了会触发 release
  - 但仍然会 GC（PoolChunk 中的 ByteBuf 是 DirectByteBuffer 子类）
```

#### Result - 结果与经验

**业务结果**：
- 故障持续 30 分钟（03:15 - 03:45）
- 1.5w 问诊订单创建失败
- 10w+ 用户断连重连
- 间接影响夜间问诊订单 5%

**技术结果**：
- 5 分钟内定位为 Direct Memory 泄漏（不是 Heap OOM）
- 用 NMT + Arthas heapdump + MAT 完整定位
- 根因修复 + 预防体系改进完整闭环
- 一周内 Direct Memory 稳定在 200MB 以下

**经验沉淀**：

1. **Direct Memory 是 K8s OOMKilled 的隐形杀手**：Heap 没满但 RSS 涨到 limit，必然是 Native / Direct 内存问题
2. **JVM 监控必须 4 维度**：Heap / Direct / Metaspace / RSS，缺一不可
3. **-XX:+HeapDumpOnOutOfMemoryError 抓不到 Direct 现场**：必须用 NMT 或 Arthas 主动 dump
4. **业务代码不应直接持有 DirectByteBuffer**：用 Netty 池化 ByteBuf + SimpleChannelInboundHandler 自动 release
5. **Netty ByteBuf 生命周期管理是 IM 网关的核心**：每次 Code Review 都要检查 ByteBuf release

**面试 STAR 法则讲述要点**：

```text
S（Situation）：
  - IM 网关 10w+ 长连接，凌晨突发 K8s OOMKilled
  - 3 个 Pod 全部 OOMKilled，服务不可用 30 分钟
  - 1.5w 问诊订单失败，10w+ 用户断连
  - 监控盲区：Heap 才 3.8GB（没满 4GB），但 RSS 7.5GB

T（Task）：
  - 5 分钟定位 OOM 根因
  - 30 分钟止血恢复服务
  - 24 小时根因修复 + 预防体系改进

A（Action）：
  - 第 1 步：现象分类
    - 监控看 Heap 3.8GB 没满，但 RSS 7.5GB 接近 K8s limit
    - 判断：不是 Heap OOM，是 Direct Memory 泄漏
    - 关键：JVM 没抛 OOM，但 K8s 直接 OOMKilled
  - 第 2 步：抓现场
    - 新版本灰度 10% 流量复现
    - 配置 NMT + ADVANCED 泄漏检测 + Direct 监控
  - 第 3 步：NMT 分析
    - jcmd VM.native_memory summary 看 Internal 2.5GB
    - jcmd GC.class_histogram 看 DirectByteBuffer 5w 实例
  - 第 4 步：MAT 分析
    - Arthas heapdump（不触发 Full GC，比 jmap 优越）
    - OQL 查询 capacity > 1MB 的 DirectByteBuffer
    - Path to GC Roots 找到强引用链：ImHandler.messageHandlers -> MessageHandler.buffer
    - Allocation Record 看创建栈：ImHandler.decode 中 alloc
  - 第 5 步：根因定位
    - 业务代码 channelInactive 时移除了 handler 但没 release buffer
    - 每次客户端断连泄漏 1MB Direct
    - 凌晨客户端大量重连，1 分钟内 5000+ 断连重连 = 5GB 泄漏
  - 第 6 步：止血 + 根因修复
    - 止血：扩容 +3 Pod + 限流客户端重连
    - PR 1：用 SimpleChannelInboundHandler 自动 release ByteBuf
    - PR 2：移除业务代码中的 DirectByteBuffer alloc，用 Netty 池化
    - PR 3：JVM 参数调优 + Direct Memory 监控（4 维度）

R（Result）：
  - 5 分钟定位，30 分钟全量恢复
  - 1.5w 订单失败，10w+ 用户影响（已恢复）
  - 沉淀 Direct Memory 监控 + Netty ByteBuf 生命周期规范
  - 一周内 Direct 稳定 200MB 以下
```

**与架构师水平的差距与补足方向**：

| 能力项 | 我的水平 | 架构师水平 | 补足方向 |
|--------|---------|----------|---------|
| Direct Memory 排查 | 知道 -XX:MaxDirectMemorySize 但不知道 NMT | 30 秒内用 jcmd NMT 看 Internal 分类 | 每周练 1 次 NMT 分析 |
| Netty 内部机制 | 知道 ResourceLeakDetector 但不知道 PoolArena | 能脱口而出 PoolArena/PoolChunk/MemoryRegionCache | 精读 Netty 4.1 ByteBuf 源码 |
| K8s + JVM 协同 | 知道 OOMKilled 但不知道 RSS 构成 | 能讲清 RSS = Heap + Direct + Metaspace + JVM 自身 | 整理团队"K8s JVM 内存配比模板" |
| HeapDump 局限性 | 不知道抓不到 Direct 现场 | 能讲清 HeapDump 只 dump Heap 的原理 | 阅读 OpenJDK heapDumper.cpp |
| ByteBuf 生命周期管理 | 知道 release 但容易忘 | 能设计自动 release 模式（SimpleChannelInboundHandler） | 整理团队 Netty 编码规范 |

---

### 案例二 - 视频问诊 RTP 包堆积 Full GC 频繁

#### Situation - 业务背景与故障现象

**业务背景**：

啄木鸟云健康在线问诊系统视频问诊 SFU（Selective Forwarding Unit）服务：

```text
部署：K8s 2 副本，每副本 8 core CPU / 16GB 内存
框架：Spring Boot 2.7 + Netty 4.1.x + Kurento Media Server + JDK 8u362
协议：WebRTC + RTP + SDP
业务规模：
  - 日均 3200 路视频通话
  - 单机 200 路并发
  - 单路通话 5-15 分钟
  - RTP 包大小 100-1500 字节，每秒 30-60 包
JVM 参数（故障前）：
  -Xmx8g -Xms8g
  -XX:+UseG1GC -XX:MaxGCPauseMillis=100
  -XX:G1HeapRegionSize=4m  # 默认根据堆大小自动选，这里手动设了 4MB
  -XX:+HeapDumpOnOutOfMemoryError
```

**故障现象（2025-Q3 某日 14:30）**：

```text
14:30:00  监控告警：video-sfu GC 频繁，Full GC 每分钟 8 次
14:30:30  监控告警：video-sfu P99 RT 800ms（正常 50ms）
14:31:00  用户反馈：视频卡顿，画面定格
14:32:00  监控告警：200 路通话全部卡顿，5% 通话掉线
14:35:00  30 路通话掉线，医师投诉
14:45:00  紧急扩容 +2 Pod，但 GC 仍频繁
15:00:00  开始排查根因

影响：
  - 200 路视频通话卡顿，影响 400 患者
  - 30 路通话掉线，需重新呼叫
  - P99 RT 800ms，视频体验严重劣化
```

**关键监控数据**：

```text
GC 日志（故障时）：
  [14:30:00] GC(5678) Pause Young (Normal) (G1 Evacuation Pause) 4500M->3200M(8192M) 95.123ms
  [14:30:05] GC(5679) Pause Young (Normal) (G1 Evacuation Pause) 5000M->3800M(8192M) 110.456ms
  [14:30:15] GC(5680) Pause Full (G1 Compaction Pause) 6500M->4500M(8192M) 1530.789ms  ← Full GC 1.5s
  [14:30:25] GC(5681) Pause Young 5800M->4200M 125ms
  [14:30:35] GC(5682) Pause Full 7000M->4800M 1620ms  ← 又 Full GC
  ...
  # Full GC 每分钟 8 次，每次 1.5s STW
  # Young GC 后 Old 区还是涨，说明对象进入 Old 没被回收

jstat -gcutil（故障时）：
  S0     S1     E      O      M     YGC   YGCT   FGC   FGCT
  0.00  85.32  67.45  82.15  95.23   5678  85.234   45  68.234
  # O=82%（Old 区使用率），FGC=45 次（频繁）
  # YGCT=85s（Young GC 总耗时），FGCT=68s（Full GC 总耗时）
  # FGCT > YGCT，Full GC 占主导
```

#### Task - 任务目标

```text
1. 5 分钟内定位 GC 频繁根因
2. 30 分钟内止血恢复（P99 RT < 100ms）
3. 24 小时内根因修复 + ZGC 选型评估
```

#### Action - 排查与修复过程

##### 第 1 步（0:00-0:30）：现象分类 - 这是 GC CPU 高

```bash
# 5 步法第 1 步：top -Hp 找高 CPU 线程
top -Hp $(pgrep -f video-sfu)
#   PID  CPU%  COMMAND
#   123  65%   GC Thread#0
#   124  60%   GC Thread#1
#   125  58%   GC Thread#2
#   126  55%   GC Thread#3
#   127  30%   NioEventLoop
#   ...
# → 4 个 GC Thread 占 60%+ CPU，是 GC CPU 高

# 第 2 步：jstat 看 GC 情况
jstat -gcutil $(pgrep -f video-sfu) 1000 10
#   S0     S1     E      O      M     YGC   YGCT   FGC   FGCT
#   0.00  85.32  67.45  82.15  95.23   5678  85.234   45  68.234
#   ...（1 秒后）
#   0.00  85.32  70.12  83.45  95.23   5680  85.234   46  69.754
#   → 1 秒内 1 次 Full GC，Old 区还在涨
```

**第 1 步结论**：**GC CPU 高（4 个 GC Thread 占 60%+），Old 区持续上涨，Full GC 频繁**。

##### 第 2 步（0:30-1:00）：jmap -histo 看堆内对象

```bash
# jmap -histo:live 触发 Full GC 后看存活对象
jmap -histo:live $(pgrep -f video-sfu) | head -20
#  num     #instances         #bytes  class name
#     1:       1500000      720000000  [B  ← 1.5w 个 byte[]，720MB
#     2:       1500000      36000000   java.util.concurrent.ConcurrentHashMap$Node
#     3:       1500000      24000000   com.example.RtpPacket
#     4:       5000         1200000    com.example.RtpQueue  ← 关键！
#     ...

# 关键发现：
# - 150w 个 byte[]（RTP 包数据），720MB
# - 5000 个 RtpQueue（应该 200 路通话 × 2 方 = 400 个，为什么 5000？）
# - 每个 RtpQueue 内部持有 300 个 RtpPacket
```

##### 第 3 步（1:00-2:00）：Arthas vmtool + jstack 定位 RtpQueue

```bash
# Arthas vmtool 查 RtpQueue 实例
arthas> vmtool --action getInstances --className com.example.RtpQueue
# 5000 个 RtpQueue 实例

# 查每个 RtpQueue 的状态
arthas> vmtool --action getInstances --className com.example.RtpQueue \
  --express 'instances.size() + " instances, " + instances.stream().mapToInt(i -> i.packets.size()).sum() + " total packets"'
# 5000 instances, 1500000 total packets
# → 平均每个 RtpQueue 持有 300 个 RtpPacket

# 查 RtpQueue 的归属
arthas> vmtool --action getInstances --className com.example.RtpQueue \
  --express 'instances.stream().collect(Collectors.groupingBy(i -> i.sessionId)).size()'
# 200 sessions
# → 200 个 session，但 5000 个 RtpQueue
# → 每个 session 平均 25 个 RtpQueue（应该 2 个：发送 + 接收）

# jstack 看业务线程
jstack -l $(pgrep -f video-sfu) | grep -A 30 "RtpHandler"
# "RtpHandler-Thread-1" prio=5 ... waiting on condition
#   at java.util.LinkedHashMap.put(LinkedHashMap.java:412)
#   at com.example.RtpQueue.add(RtpQueue.java:42)
#   ...
```

##### 第 4 步（2:00-3:00）：根因定位 - RTPQueue 生命周期 Bug

**业务代码片段**：

```java
// RtpHandler - 业务代码 Bug
public class RtpHandler {
    
    // 每次通话开始时新建 RtpQueue，但通话结束时没清理
    private final Map<String, RtpQueue> rtpQueues = new ConcurrentHashMap<>();
    
    public void onCallStart(String sessionId, String direction) {
        // Bug：用 sessionId + direction 作 key，但每次重连都新建
        String key = sessionId + "_" + direction + "_" + System.currentTimeMillis();
        RtpQueue queue = new RtpQueue(sessionId, direction);
        queue.packets = new LinkedBlockingQueue<>(300);  // 300 个包
        rtpQueues.put(key, queue);
        // ↑ 通话结束时没 remove
    }
    
    public void onRtpPacket(String sessionId, String direction, byte[] packet) {
        String key = findKey(sessionId, direction);  // 找最近的 key
        RtpQueue queue = rtpQueues.get(key);
        queue.add(packet);  // 加入队列
    }
    
    public void onCallEnd(String sessionId) {
        // Bug：只清理了 sessionId 对应的最新 key，老的 key 还在
        String key = findLatestKey(sessionId, "send");
        rtpQueues.remove(key);
        // 漏了：通话期间重连产生的老 key 没清理
    }
}

class RtpQueue {
    String sessionId;
    String direction;
    Queue<byte[]> packets;  // 持有 300 个 byte[]（RTP 包）
}
```

**为什么 200 路通话有 5000 个 RtpQueue**：

```text
- 视频通话会因网络抖动重连
- 平均每路通话重连 12 次（移动网络弱网）
- 200 路通话 × 12 次重连 × 2 方向 = 4800 个 RtpQueue（残留）
- 加上正常 200 路通话 × 2 = 400 个活跃 RtpQueue
- 总计 5200 个 RtpQueue

每个 RtpQueue 持有 300 个 byte[]（每个 1500 字节）
  = 5200 × 300 × 1500 = 2.3GB
但 byte[] 在 Young 区分配，晋升到 Old 区后难以回收
  → Old 区持续上涨
  → Mixed GC 失败（RtpQueue 跨 Region 引用）
  → Full GC
```

##### 第 5 步（3:00-4:00）：为什么 G1 Mixed GC 没能回收

```bash
# 看 GC 日志中的 Mixed GC
grep "mixed" /data/log/gc.log | tail -20
# [14:30:15] GC(5680) Pause Full (G1 Compaction Pause) 6500M->4500M(8192M) 1530ms
# [14:30:35] GC(5682) Pause Full 7000M->4800M 1620ms
# ...
# 关键：没有 mixed 标记，全是 Full GC
# → CSet 选择失败，Mixed GC 没能回收 Old 区

# 为什么 Mixed GC 失败？
# 1. RtpQueue 跨多个 Region（每个 RtpQueue 2.3MB，跨 1 个 4MB Region）
# 2. RSet（Remembered Set）更新成本高
# 3. IHOP（Initiating Heap Occupancy Percent）默认 45%，Old 区 3.7GB / 8GB = 46% 才触发并发标记
# 4. 但并发标记没跟上 Old 区上涨速度
# 5. 触发 Full GC 兜底

# 看 RSet 统计
jcmd $(pgrep -f video-sfu) GC.g1_heap_summary
# Region count: 2048
# Used: 6500M
# RSet memory: 80MB  ← RSet 占用大
# → 提示跨 Region 引用多
```

##### 第 6 步（4:00-5:00）：止血 + 根因修复

**止血（立即）**：

```bash
# 止血方案 1：扩容 +2 Pod，分散流量
kubectl scale deployment video-sfu --replicas=4

# 止血方案 2：Arthas 主动清理残留的 RtpQueue
arthas> ognl '@com.example.RtpHandler@getInstance().cleanupStaleQueues()'
# 调用业务暴露的清理方法

# 止血方案 3：调高 IHOP 让并发标记更早启动
# 不能动态调，需要重启
```

**根因修复**：

**PR 1：修复 RTPQueue 生命周期管理**

```java
// 坏代码：sessionId + direction + timestamp 作 key，重连时残留
String key = sessionId + "_" + direction + "_" + System.currentTimeMillis();

// 好代码：用 sessionId + direction 作 key，重连时复用
public void onCallStart(String sessionId, String direction) {
    String key = sessionId + "_" + direction;
    rtpQueues.compute(key, (k, oldQueue) -> {
        if (oldQueue != null) {
            oldQueue.clear();  // 清空老队列的包
        }
        return new RtpQueue(sessionId, direction);  // 新建
    });
}

public void onCallEnd(String sessionId) {
    // 清理所有相关 key（send + recv）
    rtpQueues.remove(sessionId + "_send");
    rtpQueues.remove(sessionId + "_recv");
}
```

**PR 2：G1 Region 调大 + IHOP 调低**

```bash
# 坏配置：Region 4MB，RtpQueue 跨 Region
-XX:G1HeapRegionSize=4m -XX:InitiatingHeapOccupancyPercent=45

# 好配置：Region 8MB（RtpQueue 不再跨 Region），IHOP 35%（更早启动并发标记）
-XX:G1HeapRegionSize=8m -XX:InitiatingHeapOccupancyPercent=35

# 为什么 Region 8MB：
# - RtpQueue 内部 300 个 byte[] × 1500 字节 = 450KB
# - 加上 RtpQueue 对象本身 + 元数据 = 1MB
# - 1MB < Region 8MB / 2 = 4MB（Humongous 阈值）
# - 不会被标记为 Humongous Object
# - 单 Region 内回收，RSet 简单

# 为什么 IHOP 35%：
# - Old 区 2.8GB / 8GB = 35% 时启动并发标记
# - 比默认 45% 早 10%
# - 让 Mixed GC 有更多时间回收
```

**PR 3：ZGC 选型评估**

```bash
# 视频问诊场景为什么 ZGC 更合适：
# 1. 低延迟要求：P99 RT < 100ms，G1 的 100ms 停顿刚好踩在边界
# 2. 大堆优势：8GB 堆下 G1 还行，但 16GB+ 时 G1 停顿会涨
# 3. RTP 包敏感：1.5s STW 直接导致视频卡顿

# JDK 17 + ZGC 测试
java -Xmx8g -Xms8g \
  -XX:+UseZGC \  # ZGC
  -XX:+ZGenerational \  # 分代 ZGC（JDK 21）
  -XX:SoftMaxHeapSize=6g \  # 软上限，让 ZGC 更激进
  -jar video-sfu.jar

# ZGC 优势（视频问诊场景）：
# - 停顿 < 10ms（无论堆大小）
# - 并发标记 + 并发整理（不依赖 STW）
# - 染色指针 + 读屏障（不依赖 Write Barrier）

# ZGC 劣势：
# - JDK 8 不支持，需要升级 JDK 17
# - 吞吐稍低于 G1（约 5-10%）
# - 直接内存占用稍高（染色指针元数据）
```

#### Result - 结果与经验

**业务结果**：
- 故障持续 30 分钟（14:30 - 15:00）
- 200 路视频通话卡顿，30 路掉线
- P99 RT 800ms → 50ms（修复后）
- Full GC 每分钟 8 次 → 0 次（修复后）

**技术结果**：
- 5 分钟定位为 RTPQueue 生命周期泄漏
- 用 jmap -histo + Arthas vmtool + GC 日志完整定位
- G1 Region 调优 + IHOP 调低
- ZGC 选型评估完成，计划 JDK 17 升级时切换

**经验沉淀**：

1. **GC CPU 高的本质是内存问题**：先看 jmap -histo 找对象类型，再看代码找泄漏点
2. **G1 Region 大小要匹配业务对象大小**：4MB Region 配 1MB RtpQueue 跨 Region 引用，8MB Region 才合适
3. **IHOP 调低让并发标记更早启动**：默认 45% 太晚，35% 更适合频繁分配的场景
4. **视频问诊场景 ZGC 比 G1 更合适**：低延迟 + 大堆 + 高对象分配率，ZGC 优势明显
5. **Arthas vmtool 是查"实例数"的利器**：比 jmap -histo 更精确，能直接看实例的字段值

**面试 STAR 法则讲述要点**：

```text
S（Situation）：
  - 视频问诊 SFU 服务 200 路并发通话
  - Full GC 每分钟 8 次，每次 1.5s STW
  - P99 RT 800ms，视频卡顿，30 路掉线
  - 4 个 GC Thread 占 60%+ CPU

T（Task）：
  - 5 分钟定位 GC 根因
  - 30 分钟止血恢复 P99 RT < 100ms
  - 24 小时根因修复 + ZGC 选型评估

A（Action）：
  - 第 1 步：5 步法分类
    - top -Hp 看到 4 个 GC Thread 占 60%+ CPU
    - 判断：GC CPU 高，本质是内存问题
  - 第 2 步：jmap -histo 看对象
    - 150w 个 byte[] 占 720MB
    - 5000 个 RtpQueue（应该 400 个）
  - 第 3 步：Arthas vmtool 定位
    - 200 个 session 但 5000 个 RtpQueue
    - 每路通话重连 12 次，残留 4800 个 RtpQueue
  - 第 4 步：根因
    - 业务代码用 sessionId + direction + timestamp 作 key
    - 重连时新建 RtpQueue，老的不清理
    - 每个 RtpQueue 持有 300 个 byte[]，5000 × 300 × 1500 = 2.3GB
  - 第 5 步：G1 调优
    - Region 4MB -> 8MB，让 RtpQueue 不跨 Region
    - IHOP 45% -> 35%，让并发标记更早启动
  - 第 6 步：止血 + 根因修复 + ZGC 选型
    - 扩容 +2 Pod + Arthas 主动清理残留队列
    - PR 1：修复 RtpQueue 生命周期（用 sessionId + direction 作 key）
    - PR 2：G1 Region 8MB + IHOP 35%
    - PR 3：JDK 17 升级时切换 ZGC（停顿 < 10ms）

R（Result）：
  - 5 分钟定位，30 分钟全量恢复
  - Full GC 每分钟 8 次 -> 0 次
  - P99 RT 800ms -> 50ms
  - 沉淀 G1 Region 调优规范 + ZGC 选型 RFC
```

**与架构师水平的差距与补足方向**：

| 能力项 | 我的水平 | 架构师水平 | 补足方向 |
|--------|---------|----------|---------|
| G1 调优 | 知道 MaxGCPauseMillis 但不知道 Region/IHOP | 能脱口而出 Region/IHOP/G1ReservePercent 耦合关系 | 第 1 周 Day07 G1 底层 + 本周 Day05 实战 |
| Arthas vmtool | 不熟悉 | 能用 vmtool 查实例数 + 字段值 | 每周练 1 次 vmtool |
| GC 日志解读 | 能看 Full GC | 能看 Mixed GC 失败原因 + RSet 统计 | 收集 10 份真实 GC 日志分析 |
| ZGC 选型 | 知道 ZGC 低延迟 | 能讲清染色指针 + 读屏障 + 分代 ZGC | 第 2 周 Day07 ZGC 深挖 |
| 视频场景 JVM 调优 | 不熟悉 RTP 包特性 | 能讲清 RTP 包生命周期 + SFU 内存模型 | 调研 Kurento / Janus JVM 调优案例 |

---

### 案例三 - 监管上报 Map 累积 heap OOM

#### Situation - 业务背景与故障现象

**业务背景**：

啄木鸟云健康监管上报服务，承担医疗合规上报：

```text
部署：K8s 2 副本，每副本 4 core CPU / 8GB 内存
框架：Spring Boot 2.7 + Kafka Client + OkHttp + JDK 8u362
业务规模：
  - 日均 13w 上报（医疗合规 24h 必达）
  - Kafka 消费 1300 QPS
  - 3 万条上报规则（医保目录、药品目录、IC10 编码）
  - 幂等率 100%（基于 reportId）
JVM 参数（故障前）：
  -Xmx6g -Xms6g
  -XX:+UseG1GC -XX:MaxGCPauseMillis=200
  -XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/data/dump/
```

**故障现象（2025-Q4 某日 10:00）**：

```text
10:00:00  监控告警：regulator-report OOM 自动重启
10:00:30  K8s 自动重启 Pod
10:01:00  重启后 30 分钟再次 OOM
10:32:00  连续 3 次 OOM，K8s CrashLoopBackOff
10:35:00  监管上报堆积 5w 条，超时风险
10:45:00  医疗合规告警：24h 必达可能违约
11:00:00  紧急扩容 +2 Pod + 限流消费
11:30:00  开始排查根因

影响：
  - 监管上报延迟 1.5 小时
  - 5w 条上报堆积，部分超 24h 必达
  - 医疗合规风险，需向监管机构说明
```

**关键监控数据**：

```text
Heap Dump（自动 dump 的）：
  - 文件大小：4.2GB
  - Total objects: 8500w
  - Top 1: java.util.concurrent.ConcurrentHashMap$Node (4500w, 4.5GB)
  - Top 2: java.lang.String (1500w, 1.2GB)
  - Top 3: com.example.ReportTask (500w, 600MB)

GC 日志（OOM 前）：
  [09:55:00] GC(1234) Pause Young 4500M->4200M(6144M) 35ms
  [09:55:30] GC(1235) Pause Young 5000M->4800M 45ms
  [09:56:00] GC(1236) Pause Full 5800M->5000M 1850ms  ← Full GC
  [09:56:30] GC(1237) Pause Full 5500M->4900M 1950ms  ← Full GC
  [09:57:00] GC(1238) Pause Full 6000M->5800M 2200ms  ← Full GC（回收不下来）
  [09:58:00] GC(1239) Pause Full 5900M->5800M 2300ms  ← 回收不下来
  [09:59:00] OOM: Java heap space
  → Full GC 持续 4 分钟，回收不下来，最终 OOM
```

#### Task - 任务目标

```text
1. 5 分钟内从 dump 文件定位 OOM 根因
2. 30 分钟内止血恢复（避免 24h 必达违约）
3. 24 小时内根因修复 + 预防体系改进
```

#### Action - 排查与修复过程

##### 第 1 步（0:00-0:30）：MAT 分析自动 dump

```bash
# 用 MAT 打开 /data/dump/regulator-report-oom.hprof（4.2GB）
# MAT 配置 -Xmx8g 处理大 dump

# 第 1 步：Leak Suspects 报告
# MAT 自动分析：
# "Problem 1: 4500 instances of java.util.concurrent.ConcurrentHashMap"
# "loaded by com.example.ReportTaskManager occupies 4,500,000,000 (87.5%) bytes"
# → 4500 个 ConcurrentHashMap 占 4.5GB（87.5%）

# 第 2 步：Dominator Tree（支配树）
# 找 Retained Size 最大的对象
java.util.concurrent.ConcurrentHashMap
  ├── ReportTaskManager.taskMap (2.5GB)
  │     └── ConcurrentHashMap$Node × 1500w (key=String, value=ReportTask)
  ├── ReportTaskManager.retryMap (1.5GB)
  │     └── ConcurrentHashMap$Node × 800w
  └── ReportTaskManager.idempotentMap (500MB)
        └── ConcurrentHashMap$Node × 200w
```

##### 第 2 步（0:30-1:00）：OQL 查询超大 Map

```sql
-- OQL 查询所有 ConcurrentHashMap（按 retainedHeapSize 排序）
SELECT s FROM java.util.concurrent.ConcurrentHashMap s 
WHERE s.@retainedHeapSize > 100000000
-- 100MB 以上的 Map

-- 结果：
-- 1. ReportTaskManager.taskMap - 2.5GB
-- 2. ReportTaskManager.retryMap - 1.5GB
-- 3. ReportTaskManager.idempotentMap - 500MB

-- 查 taskMap 的 key（reportId）
SELECT s.key.toString(), s.value.toString() 
FROM java.util.concurrent.ConcurrentHashMap$Node s 
WHERE s.@retainedHeapSize > 1000000
-- 100w 个 key，但很多是 UUID（应该是固定的）
-- 看出 key 模式：reportId = "uuid_2025-12-01T10:00:00.123"
-- → 每次重试都新建 UUID，老的没清理
```

##### 第 3 步（1:00-2:00）：根因定位 - 5 类泄漏模式中的"静态集合无限增长"

**业务代码片段**：

```java
// ReportTaskManager - 5 类泄漏模式中的"静态集合无限增长"
public class ReportTaskManager {
    
    // 3 个静态 Map，无限增长
    private static final Map<String, ReportTask> taskMap = new ConcurrentHashMap<>();
    private static final Map<String, ReportTask> retryMap = new ConcurrentHashMap<>();
    private static final Map<String, Boolean> idempotentMap = new ConcurrentHashMap<>();
    
    public void submitReport(ReportData data) {
        // Bug 1：每次都新建 reportId（UUID），不复用
        String reportId = UUID.randomUUID().toString() + "_" + System.currentTimeMillis();
        
        ReportTask task = new ReportTask(data, reportId);
        taskMap.put(reportId, task);
        
        // Bug 2：幂等检查用 reportId（应该用业务 ID，如 orderId + reportType）
        if (!idempotentMap.containsKey(reportId)) {
            idempotentMap.put(reportId, true);
            executeTask(task);
        }
    }
    
    public void onReportFailed(String reportId, Exception e) {
        // Bug 3：失败重试时新建 ReportTask 而非复用
        ReportTask oldTask = taskMap.get(reportId);
        String newReportId = UUID.randomUUID().toString() + "_" + System.currentTimeMillis();
        ReportTask retryTask = new ReportTask(oldTask.getData(), newReportId);
        retryMap.put(newReportId, retryTask);
        // ↑ 老的 taskMap.get(reportId) 没 remove
        
        // Bug 4：没有 TTL，没有 maximumSize，无限增长
        // Bug 5：没有定期清理机制
    }
    
    public void onReportSuccess(String reportId) {
        taskMap.remove(reportId);
        // ↑ 成功时移除，但 retryMap 没 remove
        // 失败重试后的 retryMap 永远不清理
    }
}
```

**5 类内存泄漏模式识别清单**：

```text
1. 缓存膨胀：Caffeine 没设 maximumSize
   → 案例四会讲到
2. ThreadLocal 累积：线程池下 ThreadLocal 没 remove
   → 不在本案例
3. 监听器 Callback 未 unregister：监听器注册后没移除
   → 不在本案例
4. 静态集合无限增长：本案例！
   - taskMap：所有上报任务，成功才 remove，失败永远残留
   - retryMap：重试任务，永远不清理
   - idempotentMap：幂等记录，永远不清理
5. finalize 队列堆积：finalize 方法导致对象延迟回收
   → 不在本案例

本案例命中模式 4 - 静态集合无限增长
```

##### 第 4 步（2:00-3:00）：为什么自动 dump 抓到的不是元凶

**关键陷阱**：

```text
-XX:+HeapDumpOnOutOfMemoryError 的局限：
  1. OOM 时已经 Full GC 多次，对象状态已变
  2. dump 的是 OOM 那一刻的 Heap，不是泄漏开始时
  3. 但本案例幸运，因为 Map 是强引用，Full GC 也没法回收

但有些场景下自动 dump 抓不到元凶：
  1. 内存泄漏很慢（持续 7 天），但 OOM 时被一波流量引爆
  2. dump 时刚好 GC 完，弱引用 / 软引用被清空
  3. 元凶对象在 Native 内存（不在 Heap）

更好的做法：
  1. 主动 jcmd heap_dump（不依赖 OOM 触发）
  2. 设置 heap 使用率 80% 告警，主动 dump
  3. JFR 持续录制，看对象分配趋势
```

**本案例的"幸运"**：

```text
- taskMap / retryMap / idempotentMap 都是强引用
- Full GC 也无法回收
- 自动 dump 抓到了完整的元凶
- 如果是 WeakReference / SoftReference，dump 时可能已经被回收
```

##### 第 5 步（3:00-4:00）：止血 + 根因修复

**止血（立即）**：

```bash
# 止血方案 1：扩容 +2 Pod，分散消费
kubectl scale deployment regulator-report --replicas=4

# 止血方案 2：Kafka 消费限流（避免重启后再次 OOM）
# 配置 Kafka consumer max.poll.records=100（默认 500）
# 配置 Kafka consumer fetch.max.bytes=10MB（默认 50MB）

# 止血方案 3：Arthas 主动清理 Map
arthas> ognl '@com.example.ReportTaskManager@taskMap.clear()'
arthas> ognl '@com.example.ReportTaskManager@retryMap.clear()'
arthas> ognl '@com.example.ReportTaskManager@idempotentMap.clear()'
```

**根因修复**：

**PR 1：用业务 ID 替代 UUID 作为 reportId**

```java
// 坏代码：每次新建 UUID
String reportId = UUID.randomUUID().toString() + "_" + System.currentTimeMillis();

// 好代码：用业务 ID（orderId + reportType），保证幂等
String reportId = data.getOrderId() + "_" + data.getReportType();

// 幂等检查：用业务 ID，重试时复用
if (!idempotentMap.containsKey(reportId)) {
    idempotentMap.put(reportId, true);
    executeTask(task);
}
```

**PR 2：用 Caffeine 替代 ConcurrentHashMap，加 maximumSize + TTL**

```java
// 坏代码：静态 Map 无限增长
private static final Map<String, ReportTask> taskMap = new ConcurrentHashMap<>();

// 好代码：Caffeine 加 maximumSize + TTL
private static final Cache<String, ReportTask> taskMap = Caffeine.newBuilder()
    .maximumSize(10_000)  // 最多 1w 个
    .expireAfterWrite(Duration.ofHours(1))  // 1h 后过期
    .recordStats()  // 开启统计
    .build();

// 重试 Map 也用 Caffeine
private static final Cache<String, ReportTask> retryMap = Caffeine.newBuilder()
    .maximumSize(5_000)  // 最多 5k 个
    .expireAfterWrite(Duration.ofMinutes(30))  // 30min 后过期
    .build();

// 幂等 Map 用 Redis（不占 JVM Heap）
// 用 Redis SET + TTL 24h
redisTemplate.opsForValue().set("idempotent:" + reportId, "1", Duration.ofHours(24));
```

**PR 3：修复重试逻辑 - 复用 ReportTask 而非新建**

```java
// 坏代码：失败重试时新建 ReportTask
public void onReportFailed(String reportId, Exception e) {
    ReportTask oldTask = taskMap.get(reportId);
    String newReportId = UUID.randomUUID().toString() + "_" + System.currentTimeMillis();
    ReportTask retryTask = new ReportTask(oldTask.getData(), newReportId);
    retryMap.put(newReportId, retryTask);
}

// 好代码：复用 ReportTask，重试次数 +1
public void onReportFailed(String reportId, Exception e) {
    ReportTask task = taskMap.getIfPresent(reportId);
    if (task == null) {
        // 任务已过期，重新创建
        task = new ReportTask(/* ... */);
        taskMap.put(reportId, task);
    }
    task.incrementRetryCount();
    if (task.getRetryCount() > 3) {
        // 进入死信队列
        sendToDLQ(task);
        return;
    }
    retryMap.put(reportId, task);  // 复用同一对象
}
```

**PR 4：监控告警改进**

```bash
# 1. Caffeine stats 暴露到 Prometheus
# - cache.size（缓存大小）
# - cache.hit.rate（命中率）
# - cache.eviction.count（驱逐次数）

# 2. 告警规则
# - taskMap.size > 5000 告警（正常 < 1000）
# - retryMap.size > 1000 告警（正常 < 100）
# - Heap 使用率 > 80% 主动 dump

# 3. JFR 持续录制
java -XX:StartFlightRecording=duration=1h,filename=/data/jfr/recording.jfr,maxsize=200M
```

**与支付幂等性的对比**：

```text
监管上报 vs 支付幂等性：
  共同点：
    1. 都是 24h 必达
    2. 都需要幂等性（避免重复上报 / 重复扣款）
    3. 都有重试机制
    4. 都有死信队列
  
  差异：
    1. 监管上报：医疗合规要求，监管机构接收
    2. 支付：资金安全要求，银行 / 第三方支付接收
    3. 监管上报：失败重试 3 次，进入死信队列人工处理
    4. 支付：失败重试 3 次，进入对账系统自动核对
  
  共同的 JVM 风险：
    1. 都用 Map 维护任务状态，容易内存泄漏
    2. 都需要 Caffeine + maximumSize + TTL
    3. 都需要监控告警 + 主动 dump
```

#### Result - 结果与经验

**业务结果**：
- 故障持续 1.5 小时（10:00 - 11:30）
- 5w 条监管上报堆积，3 条超 24h 必达
- 医疗合规风险，已向监管机构说明
- 无资损

**技术结果**：
- 5 分钟从自动 dump 定位根因
- 用 MAT Dominator Tree + OQL 完整定位
- Caffeine 替换 ConcurrentHashMap + Redis 幂等
- 一周内 Heap 稳定 1.5GB 以下

**经验沉淀**：

1. **5 类泄漏模式必须背熟**：本案例命中"静态集合无限增长"，10 秒内识别
2. **Caffeine 必须设 maximumSize + TTL**：Code Review Checklist 第一条
3. **幂等性应该用 Redis 而非 JVM Map**：避免内存压力 + 跨实例共享
4. **业务 ID 必须基于稳定字段**：orderId + reportType，不能用 UUID + 时间戳
5. **自动 dump 的局限性**：依赖 OOM 触发，应该 80% 主动 dump + JFR 持续录制

**面试 STAR 法则讲述要点**：

```text
S（Situation）：
  - 监管上报服务 1300 QPS，医疗合规 24h 必达
  - 凌晨 OOM 自动重启，30 分钟后再次 OOM
  - 5w 条上报堆积，3 条超 24h 必达，医疗合规风险

T（Task）：
  - 5 分钟从 dump 定位根因
  - 30 分钟止血恢复（避免 24h 必达违约）
  - 24 小时根因修复 + 预防体系改进

A（Action）：
  - 第 1 步：MAT 分析自动 dump
    - Leak Suspects：4500 个 ConcurrentHashMap 占 4.5GB（87.5%）
    - Dominator Tree：taskMap 2.5GB / retryMap 1.5GB / idempotentMap 500MB
  - 第 2 步：OQL 查询超大 Map
    - OQL: SELECT s FROM ConcurrentHashMap s WHERE s.@retainedHeapSize > 100000000
    - 看 key 模式：reportId = UUID + timestamp，每次重试都新建
  - 第 3 步：根因定位
    - 5 类泄漏模式中的"静态集合无限增长"
    - 业务代码 4 个 Bug：
      - Bug 1：每次新建 UUID 作 reportId
      - Bug 2：幂等检查用 reportId（应该用业务 ID）
      - Bug 3：失败重试时新建 ReportTask 而非复用
      - Bug 4：没有 TTL，没有 maximumSize
  - 第 4 步：自动 dump 的局限性分析
    - 本案例幸运：Map 是强引用，Full GC 也没法回收
    - 改进：80% 主动 dump + JFR 持续录制
  - 第 5 步：止血 + 根因修复
    - 止血：扩容 +2 Pod + Kafka 限流 + Arthas 主动清理 Map
    - PR 1：用业务 ID 替代 UUID（orderId + reportType）
    - PR 2：Caffeine 替换 ConcurrentHashMap，maximumSize + TTL
    - PR 3：幂等 Map 用 Redis（不占 JVM Heap）
    - PR 4：复用 ReportTask 而非新建
    - PR 5：监控告警 + JFR 持续录制

R（Result）：
  - 5 分钟定位，30 分钟全量恢复
  - Heap 稳定 1.5GB 以下（之前 6GB 涨满）
  - 5w 堆积上报处理完毕，3 条超 24h 已说明监管
  - 沉淀 5 类泄漏模式识别 Checklist + Caffeine 使用规范
```

**与架构师水平的差距与补足方向**：

| 能力项 | 我的水平 | 架构师水平 | 补足方向 |
|--------|---------|----------|---------|
| MAT 支配树 | 知道怎么看 | 能讲清支配集算法 + Retained Size 本质 | 精读 IBM Dominator Tree paper |
| OQL 查询 | 不熟悉语法 | 能写复杂 OQL 查特定模式对象 | 每周练 2 个 OQL 查询 |
| 5 类泄漏模式 | 知道 2-3 类 | 能背出 5 类 + 识别清单 | 整理团队"5 类泄漏 Checklist" |
| Caffeine 配置 | 知道基本用法 | 能讲清 maximumSize / TTL / 弱引用键 | 精读 Caffeine wiki |
| 幂等性设计 | 知道用 Redis SET | 能讲清业务 ID + Redis + 死信队列 + 对账 | 对比支付幂等性设计 |
| 自动 dump 局限性 | 不知道 | 能讲清何时抓不到元凶 + 主动 dump 方案 | 80% 主动 dump + JFR 持续录制 |

---

### 案例四 - 问诊订单缓存 100w Key GC CPU 高

#### Situation - 业务背景与故障现象

**业务背景**：

啄木鸟云健康问诊订单服务：

```text
部署：K8s 3 副本，每副本 4 core CPU / 8GB 内存
框架：Spring Boot 2.7 + Caffeine 3.x + Redis 7.x + JDK 8u362
业务规模：
  - 日均 5.2w 订单，峰值 8.1w
  - 问诊订单缓存命中率要求 95%+
  - Caffeine 本地缓存 + Redis 分布式缓存（两级）
JVM 参数（故障前）：
  -Xmx4g -Xms4g
  -XX:+UseG1GC -XX:MaxGCPauseMillis=200
```

**故障现象（2026-Q1 某日 09:00）**：

```text
09:00:00  监控告警：consult-order CPU 80%+ 持续高
09:00:30  监控告警：Young GC 频繁（每秒 1 次）
09:01:00  接口 RT 正常（P99 30ms），但 CPU 持续高
09:05:00  扩容 +1 Pod，CPU 仍 70%+
09:15:00  开始排查根因

影响：
  - 接口可用，但 CPU 持续高，资源浪费
  - 临近早高峰（10:00-12:00），可能引发雪崩
  - K8s HPA 自动扩容触发，成本上升
```

**关键监控数据**：

```text
GC 日志（故障时）：
  [09:00:00] GC(1234) Pause Young 1200M->800M(4096M) 25ms
  [09:00:01] GC(1235) Pause Young 1300M->900M(4096M) 28ms
  [09:00:02] GC(1236) Pause Young 1400M->1000M(4096M) 30ms
  ...
  # Young GC 每秒 1 次，每次 25-30ms
  # 没有 Full GC，Old 区缓慢上涨

jstat -gcutil：
  S0     S1     E      O      M     YGC   YGCT   FGC
  0.00  85.32  67.45  45.15  95.23  5678  142.234   0
  # YGC=5678，YGCT=142s（平均 25ms/次）
  # FGC=0（没有 Full GC）
  # O=45%（Old 区缓慢上涨）

CPU：
  - GC Thread：50%（4 个 GC Thread 各 12.5%）
  - 业务线程：30%
  # GC 占主导
```

#### Task - 任务目标

```text
1. 5 分钟内定位 CPU 高根因
2. 30 分钟内止血（CPU < 50%）
3. 24 小时内根因修复 + Caffeine 配置规范
```

#### Action - 排查与修复过程

##### 第 1 步（0:00-0:30）：5 步法分类 - GC CPU 高

```bash
# 5 步法第 1 步：top -Hp 找高 CPU 线程
top -Hp $(pgrep -f consult-order)
#   PID  CPU%  COMMAND
#   123  12%   GC Thread#0
#   124  12%   GC Thread#1
#   125  12%   GC Thread#2
#   126  12%   GC Thread#3
#   127  5%    http-nio-8080-exec-1
#   ...
# → 4 个 GC Thread 各 12% CPU，总计 50%
# → GC CPU 高

# 第 2 步：jstat 看 GC
jstat -gcutil $(pgrep -f consult-order) 1000 10
#   S0     S1     E      O      M     YGC   YGCT   FGC
#   0.00  85.32  67.45  45.15  95.23  5678  142.234   0
#   0.00  85.32  80.12  46.45  95.23  5680  142.234   0
#   → 1 秒内 2 次 Young GC，Old 区缓慢上涨

# 第 3 步：jmap -histo 看对象
jmap -histo:live $(pgrep -f consult-order) | head -10
#  num     #instances         #bytes  class name
#     1:       1000000      48000000  java.util.LinkedHashMap$Entry  ← 100w 个！
#     2:       1000000      24000000  com.example.ConsultOrder
#     3:       1000000      16000000  java.lang.String
#     ...
# → 100w 个 LinkedHashMap$Entry，强烈提示 Caffeine 缓存膨胀
```

##### 第 2 步（0:30-1:00）：Arthas vmtool 定位 Caffeine 实例

```bash
# Arthas vmtool 查 Caffeine 实例
arthas> vmtool --action getInstances --className com.github.benmanes.caffeine.cache.BoundedLocalCache
# 5 个 BoundedLocalCache 实例（5 个 Caffeine 缓存）

# 查每个 BoundedLocalCache 的大小
arthas> vmtool --action getInstances --className com.github.benmanes.caffeine.cache.BoundedLocalCache \
  --express 'instances.stream().map(i -> i.getClass().getName() + "=" + i.entrySet().size()).collect(Collectors.toList())'
# [
#   "BoundedLocalCache=1000000",  ← 100w 个！
#   "BoundedLocalCache=5000",
#   "BoundedLocalCache=2000",
#   "BoundedLocalCache=1000",
#   "BoundedLocalCache=500"
# ]

# → 第 1 个 Caffeine 缓存有 100w 个 entry，是元凶
```

##### 第 3 步（1:00-2:00）：定位是哪个 Caffeine 缓存

```bash
# Arthas 查 Caffeine 缓存的配置
arthas> vmtool --action getInstances --className com.github.benmanes.caffeine.cache.BoundedLocalCache \
  --express 'instances.stream().filter(i -> i.entrySet().size() > 100000).map(i -> i.evictionPolicy).collect(Collectors.toList())'
# [EvictionPolicy.NONE]  ← 没有驱逐策略！

# 查业务代码里哪些地方定义了 Caffeine
grep -r "Caffeine.newBuilder" src/
# src/main/java/com/example/OrderCacheConfig.java:
#   Caffeine.newBuilder().expireAfterWrite(30, TimeUnit.MINUTES).build();
#   ↑ 没有 maximumSize！默认无限增长
```

**业务代码片段**：

```java
// OrderCacheConfig - 业务代码 Bug
@Configuration
public class OrderCacheConfig {
    
    // 坏代码：没有 maximumSize
    @Bean
    public Cache<String, ConsultOrder> orderCache() {
        return Caffeine.newBuilder()
            .expireAfterWrite(30, TimeUnit.MINUTES)
            // 忘了 .maximumSize(10000)
            .build();
    }
    
    // 业务理解错误：以为"缓存所有订单"
    // 实际上：日均 5.2w 订单 × 30min TTL = 10w+ 缓存
    // 高峰期 100w+ 订单查询，全部进缓存
}
```

##### 第 4 步（2:00-3:00）：为什么 Young GC 频繁而非 Old GC

```text
关键现象：
  - 100w 个 LinkedHashMap$Entry 在 Young 区
  - Young GC 每秒 1 次
  - Old 区缓慢上涨（45% -> 50%）

为什么 Young GC 频繁：
  1. Caffeine 内部用 LinkedHashMap 存 entry
  2. 每次查询 / 写入都会 new LinkedHashMap$Entry
  3. 高 QPS（5000/s）下，每秒 5000 个新对象
  4. Young 区 1.5GB，5000 个 Entry 占 240KB
  5. 但加上其他对象，每秒分配 1.5GB
  6. Young 区 1 秒就满，触发 Young GC

为什么 Old 区缓慢上涨：
  1. Caffeine 缓存对象本身是强引用（在 Old 区）
  2. 但 LinkedHashMap$Entry 在 Young 区
  3. Young GC 时，被引用的 Entry 晋升到 Old 区
  4. 缓存 30min TTL，Old 区对象 30min 才回收
  5. Old 区缓慢上涨

为什么没有 Full GC：
  - Old 区才 50%，没到 G1 触发阈值（45% IHOP + 5% buffer）
  - 但持续高频 Young GC 已经是问题
```

##### 第 5 步（3:00-4:00）：止血 + 根因修复

**止血（立即）**：

```bash
# 止血方案 1：扩容 +1 Pod
kubectl scale deployment consult-order --replicas=4

# 止血方案 2：Arthas 主动清空 Caffeine 缓存
arthas> ognl '@com.example.OrderCacheConfig@orderCache.invalidateAll()'

# 止血方案 3：临时调小 TTL（30min -> 5min）
# 需要重启
```

**根因修复**：

**PR 1：Caffeine 加 maximumSize**

```java
// 坏代码：没有 maximumSize
@Bean
public Cache<String, ConsultOrder> orderCache() {
    return Caffeine.newBuilder()
        .expireAfterWrite(30, TimeUnit.MINUTES)
        .build();
}

// 好代码：maximumSize 1w + TTL 30min + recordStats
@Bean
public Cache<String, ConsultOrder> orderCache() {
    return Caffeine.newBuilder()
        .maximumSize(10_000)  // 最多 1w 个
        .expireAfterWrite(30, TimeUnit.MINUTES)
        .recordStats()  // 开启统计
        .build();
}

// 容量规划：
// - 日均 5.2w 订单，峰值 8.1w
// - 高峰期 1h 内订单约 1w
// - maximumSize 1w 足够覆盖高峰期
// - 命中率 95%+，未命中的走 Redis
```

**PR 2：Caffeine vs Redis 边界重新划分**

```text
重新划分原则：
  1. Caffeine：单实例 1w Key 以内的"热点数据"
  2. Redis：所有数据，TTL 24h
  3. MySQL：持久化数据，TTL 永久

具体到问诊订单：
  - 热点：最近 30min 内的订单（用户活跃查询）
  - Caffeine：maximumSize 1w + TTL 30min
  - Redis：所有订单 + TTL 24h
  - MySQL：永久

两级缓存查询逻辑：
  1. Caffeine 命中 -> 直接返回
  2. Caffeine 未命中 -> 查 Redis
  3. Redis 命中 -> 回填 Caffeine + 返回
  4. Redis 未命中 -> 查 MySQL + 回填 Redis + Caffeine + 返回
```

**PR 3：Caffeine 监控告警**

```bash
# 1. Caffeine stats 暴露到 Prometheus
@Bean
public Cache<String, ConsultOrder> orderCache() {
    return Caffeine.newBuilder()
        .maximumSize(10_000)
        .expireAfterWrite(30, TimeUnit.MINUTES)
        .recordStats()
        .build();
}

# 暴露指标：
# - cache.size（缓存大小）
# - cache.hit.rate（命中率）
# - cache.eviction.count（驱逐次数）
# - cache.load.average（加载时间）

# 2. 告警规则
# - cache.size > 8000 告警（80% 容量）
# - cache.hit.rate < 80% 告警（命中率低）
# - cache.eviction > 100/s 告警（频繁驱逐）
```

**与第 1 周 Day06 IM 网关优化的呼应**：

```text
第 1 周 Day06：IM 网关从 5w QPS 优化到 15w QPS 的全链路调优
  - 用 Caffeine 缓存"在线状态"，maximumSize 5w
  - 用 Caffeine 缓存"会话路由"，maximumSize 1w
  - 用 Redis 缓存"消息 seq"，TTL 24h

本案例：问诊订单服务 Caffeine 缓存调优
  - 用 Caffeine 缓存"问诊订单"，maximumSize 1w
  - 用 Redis 缓存"所有订单"，TTL 24h
  - 用 MySQL 持久化

共同点：
  - 都是"缓存调优是 JVM 调优的业务侧调优"
  - 都需要 maximumSize + TTL + recordStats
  - 都需要 Prometheus 监控告警
  - 都需要 Caffeine vs Redis 边界划分
```

#### Result - 结果与经验

**业务结果**：
- 故障持续 15 分钟（09:00 - 09:15）
- 接口可用，无业务影响
- CPU 持续高，资源浪费
- K8s HPA 自动扩容，成本上升 33%

**技术结果**：
- 5 分钟定位为 Caffeine 缓存膨胀
- 用 jmap -histo + Arthas vmtool 完整定位
- Caffeine 加 maximumSize 1w + TTL 30min
- CPU 稳定 30% 以下

**经验沉淀**：

1. **Caffeine 必须设 maximumSize**：Code Review Checklist 第一条
2. **缓存调优是 JVM 调优的业务侧调优**：100w Key 的 Caffeine 比 1w Key 的 Caffeine 多 100 倍 GC 压力
3. **Arthas vmtool 是查"实例数"的利器**：直接看 BoundedLocalCache.entrySet().size()
4. **Caffeine vs Redis 边界要明确**：1w Key 以内用 Caffeine，超过用 Redis
5. **缓存监控告警必须 4 维度**：size / hit rate / eviction / load time

**面试 STAR 法则讲述要点**：

```text
S（Situation）：
  - 问诊订单服务日均 5.2w 订单，峰值 8.1w
  - CPU 80%+ 持续高，但接口 RT 正常
  - Young GC 每秒 1 次，GC Thread 占 50% CPU
  - 临近早高峰，可能引发雪崩

T（Task）：
  - 5 分钟定位 CPU 根因
  - 30 分钟止血（CPU < 50%）
  - 24 小时根因修复 + Caffeine 配置规范

A（Action）：
  - 第 1 步：5 步法分类
    - top -Hp 看到 4 个 GC Thread 各 12% CPU
    - jstat 看 Young GC 每秒 1 次，Old 区缓慢上涨
    - jmap -histo 看 100w 个 LinkedHashMap$Entry
  - 第 2 步：Arthas vmtool 定位 Caffeine
    - 5 个 BoundedLocalCache 实例
    - 第 1 个有 100w 个 entry
    - evictionPolicy = NONE（没有驱逐策略）
  - 第 3 步：根因
    - 业务代码 Caffeine.newBuilder().expireAfterWrite(30min).build()
    - 忘了 .maximumSize(10000)
    - 业务理解错误：以为"缓存所有订单"
  - 第 4 步：为什么 Young GC 频繁
    - Caffeine 内部 LinkedHashMap 每次 put 都 new Entry
    - 高 QPS 下每秒 5000 个新对象
    - Young 区 1 秒就满
  - 第 5 步：止血 + 根因修复
    - 止血：扩容 +1 Pod + Arthas 主动清空缓存
    - PR 1：maximumSize 1w + TTL 30min + recordStats
    - PR 2：Caffeine vs Redis 边界重新划分（1w 用 Caffeine，所有用 Redis）
    - PR 3：Caffeine 监控告警（size / hit rate / eviction / load time）

R（Result）：
  - 5 分钟定位，15 分钟全量恢复
  - CPU 稳定 30% 以下（之前 80%+）
  - 缓存命中率 95%+
  - 沉淀 Caffeine 使用规范 + Code Review Checklist
```

**与架构师水平的差距与补足方向**：

| 能力项 | 我的水平 | 架构师水平 | 补足方向 |
|--------|---------|----------|---------|
| Caffeine 配置 | 知道基本用法 | 能讲清 maximumSize / TTL / 弱引用键 / recordStats | 精读 Caffeine wiki |
| Arthas vmtool | 不熟悉 | 能用 vmtool 查实例数 + 字段值 | 每周练 1 次 vmtool |
| 缓存监控 | 只看命中率 | 4 维度（size / hit rate / eviction / load time） | 搭建 Prometheus + Caffeine stats |
| Caffeine vs Redis | 没明确边界 | 能讲清 1w Key 阈值 + 两级缓存逻辑 | 整理团队"缓存选型规范" |
| 容量规划 | 凭感觉 | 能根据 QPS + TTL 算 maximumSize | 调研 Caffeine 容量规划方法论 |

---

### 案例五 - MongoDB 大文档 G1 Humongous Allocation

#### Situation - 业务背景与故障现象

**业务背景**：

啄木鸟云健康消息存档服务：

```text
部署：K8s 2 副本，每副本 8 core CPU / 16GB 内存
框架：Spring Boot 2.7 + MongoDB Driver 4.x + JDK 8u362
存储：MongoDB 5.x 分片集群（按 sessionId 哈希分片）
业务规模：
  - 日均 210w 消息，年新增 7.6 亿条
  - 单文档最大 5MB（包含图片 base64 + OCR 结果 + 元数据）
  - 6 个月内热数据 MongoDB，6 个月后归档 OSS + Hive
JVM 参数（故障前）：
  -Xmx8g -Xms8g
  -XX:+UseG1GC -XX:MaxGCPauseMillis=200
  # G1HeapRegionSize 没设，默认根据堆大小自动选（8GB 堆选 4MB Region）
```

**故障现象（2025-Q4 某日 16:00）**：

```text
16:00:00  监控告警：message-archive Full GC 每分钟 1 次
16:00:30  监控告警：消息写入延迟 P99 2s（正常 50ms）
16:01:00  MongoDB 写入堆积，Kafka 消费滞后
16:05:00  紧急扩容 +2 Pod，但 Full GC 仍频繁
16:15:00  开始排查根因

影响：
  - 消息存档延迟 P99 2s
  - Kafka 消费滞后 5 分钟
  - 监管查询历史消息超时
```

**关键监控数据**：

```text
GC 日志（故障时）：
  [16:00:00] GC(1234) Pause Young 4500M->3200M(8192M) 95ms
  [16:00:15] GC(1235) [Humongous Allocation]  ← 关键标记！
  [16:00:15] GC(1236) Pause Young (mixed) (G1 Evacuation Pause) (humongous) 5000M->3800M 220ms
  [16:00:30] GC(1237) Pause Full 6500M->4500M 1850ms  ← Full GC
  [16:01:00] GC(1238) Pause Full 6000M->4700M 1750ms
  ...
  # 看到 [Humongous Allocation] 标记
  # 看到 (humongous) 的 Mixed GC
  # 触发 Full GC

jmap -histo：
  num     #instances         #bytes  class name
     1:       1500          5400000000  [B  ← 1500 个 byte[]，5.4GB！
     2:       1500          24000000    org.bson.BsonDocument
     ...
  # 1500 个 byte[] 占 5.4GB
  # 平均每个 3.6MB（接近 5MB 文档大小）
```

#### Task - 任务目标

```text
1. 5 分钟内定位 Full GC 根因
2. 30 分钟内止血恢复（P99 < 100ms）
3. 24 小时内根因修复 + MongoDB Schema 优化
```

#### Action - 排查与修复过程

##### 第 1 步（0:00-0:30）：GC 日志识别 Humongous

```bash
# 看 GC 日志中的 Humongous 标记
grep -E "Humongous|humongous" /data/log/gc.log | tail -20
# [16:00:15] GC(1235) [Humongous Allocation]  ← 关键标记
# [16:00:15] GC(1236) Pause Young (mixed) (G1 Evacuation Pause) (humongous) 5000M->3800M 220ms

# Humongous Object 的定义：
# - 对象大小 >= Region 大小 / 2 = 4MB / 2 = 2MB
# - 在 8GB 堆 + 4MB Region 下，2MB+ 对象就是 Humongous
# - 5MB 文档 > 2MB 阈值，被打成 Humongous Object

# jmap -histo 看 byte[]
jmap -histo:live $(pgrep -f message-archive) | head -10
#  num     #instances         #bytes  class name
#     1:       1500          5400000000  [B  ← 1500 个 byte[]，5.4GB
#     2:       1500          24000000    org.bson.BsonDocument
# → 1500 个 byte[]（5MB 文档），占 5.4GB（67% Heap）
```

##### 第 2 步（0:30-1:00）：根因定位 - 5MB 文档触发 Humongous

**G1 Humongous Object 机制**：

```text
G1 Region 模型：
  - Heap 8GB / Region 4MB = 2048 个 Region
  - 每个 Region 4MB

Humongous Object 分配：
  - 对象 >= Region / 2 = 2MB → Humongous
  - 5MB 文档 > 2MB → Humongous
  - 分配在连续的多个 Region（5MB 文档占 2 个 Region：4MB + 1MB）
  - 标记为 Humongous Region

Humongous Object 回收：
  - 不能在 Young GC 回收（跨 Region）
  - 不能在普通 Mixed GC 回收
  - 只能在 Full GC 或 Concurrent Marking 后回收
  - 容易引发 Full GC

为什么 1500 个 5MB 文档同时存在：
  1. MongoDB 批量查询：一次查询 100 个会话的消息
  2. 每个会话最大 500 条消息，单文档 5MB
  3. 批量反序列化为 BsonDocument
  4. byte[] 在 Young 区分配，5MB 触发 Humongous
  5. Young GC 时晋升到 Old 区（Humongous Region）
  6. Old 区 Humongous 累积，触发 Full GC
```

##### 第 3 步（1:00-2:00）：MongoDB Schema 分析

```javascript
// 查 MongoDB 中 5MB 文档的占比
db.consult_message.aggregate([
  { $project: { 
      size: { $bsonSize: "$$ROOT" },
      hasImage: { $ne: ["$imageBase64", null] }
  }},
  { $group: { 
      _id: null,
      totalDocs: { $sum: 1 },
      largeDocs: { $sum: { $cond: [{ $gt: ["$size", 2 * 1024 * 1024] }, 1, 0] } },
      avgSize: { $avg: "$size" },
      maxSize: { $max: "$size" }
  }}
])
// 结果：
// { totalDocs: 100000, largeDocs: 8500, avgSize: 200KB, maxSize: 5.2MB }
// → 8.5% 文档 > 2MB（触发 Humongous）

// 看大文档的内容
db.consult_message.aggregate([
  { $project: { size: { $bsonSize: "$$ROOT" } } },
  { $match: { size: { $gt: 2 * 1024 * 1024 } } },
  { $limit: 5 }
])
// 大文档都是包含图片 base64 的：
// {
//   "_id": "msg_xxx",
//   "content": "请看化验单",
//   "imageBase64": "data:image/jpeg;base64,/9j/4AAQSkZJRg...",  // 4MB+
//   "ocrResult": { ... },
//   "metadata": { ... }
// }
```

##### 第 4 步（2:00-3:00）：止血 + 根因修复

**止血（立即）**：

```bash
# 止血方案 1：扩容 +2 Pod
kubectl scale deployment message-archive --replicas=4

# 止血方案 2：临时调大 G1 Region（让 5MB 文档不再 Humongous）
# 需要重启，但效果立竿见影
# -XX:G1HeapRegionSize=16m（5MB < 16MB / 2 = 8MB，不再 Humongous）
```

**根因修复**：

**PR 1：G1 Region 调大 16MB**

```bash
# 坏配置：Region 4MB（默认），5MB 文档触发 Humongous
-XX:+UseG1GC  # 默认 Region 4MB

# 好配置：Region 16MB，5MB 文档不再 Humongous
-XX:+UseG1GC -XX:G1HeapRegionSize=16m

# 为什么 Region 16MB：
# - Humongous 阈值 = Region / 2 = 8MB
# - 5MB 文档 < 8MB，不再 Humongous
# - 在 Young GC 正常回收
# - Region 16MB 在 8GB 堆下 = 512 个 Region（合理）

# Region 大小选择决策树：
# 堆 4GB：Region 2MB / 4MB
# 堆 8GB：Region 4MB / 8MB / 16MB（看对象大小）
# 堆 16GB：Region 8MB / 16MB / 32MB
# 堆 32GB：Region 16MB / 32MB

# 选择原则：Region 大小 > 业务最大对象大小 × 2
# 业务最大对象 5MB → Region >= 10MB → 选 16MB
```

**PR 2：MongoDB Schema 优化 - 大文档拆分**

```javascript
// 坏 Schema：单文档包含图片 base64
db.consult_message.insertOne({
  _id: "msg_xxx",
  content: "请看化验单",
  imageBase64: "data:image/jpeg;base64,/9j/4AAQSkZJRg...",  // 4MB+
  ocrResult: { ... },
  metadata: { ... }
})
// → 单文档 5MB，触发 Humongous

// 好 Schema 1：图片存 OSS，文档只存 URL
db.consult_message.insertOne({
  _id: "msg_xxx",
  content: "请看化验单",
  imageUrl: "oss://consult-message/msg_xxx.jpg",  // 只存 URL
  ocrResult: { ... },
  metadata: { ... }
})
// → 单文档 200KB，不触发 Humongous

// 好 Schema 2：大文档拆分为多条小文档
db.consult_message.insertOne({
  _id: "msg_xxx",
  type: "text",
  content: "请看化验单"
})
db.consult_message.insertOne({
  _id: "msg_xxx_image",
  parentId: "msg_xxx",
  type: "image",
  imageUrl: "oss://consult-message/msg_xxx.jpg",
  ocrResult: { ... }
})
// → 每条文档 < 100KB
```

**PR 3：冷热分离 - 6 个月后归档 OSS**

```java
// 归档任务：每天凌晨归档 6 个月前的消息
@Scheduled(cron = "0 0 2 * * ?")
public void archiveOldMessages() {
    // 1. 查 6 个月前的消息
    LocalDateTime sixMonthsAgo = LocalDateTime.now().minusMonths(6);
    
    // 2. 分批查 + 上传 OSS
    try (MongoCursor<Document> cursor = mongoCollection
        .find(Filters.lt("createTime", sixMonthsAgo))
        .batchSize(100)
        .iterator()) {
        
        while (cursor.hasNext()) {
            Document doc = cursor.next();
            String ossKey = "archive/" + doc.getObjectId("_id") + ".json";
            ossClient.putObject(ossKey, doc.toJson());
            
            // 3. 删 MongoDB
            mongoCollection.deleteOne(Filters.eq("_id", doc.getObjectId("_id")));
        }
    }
    
    // 4. Hive 元数据同步
    hiveTemplate.execute("MSCK REPAIR TABLE consult_message_archive");
}
```

**与 ES Lucene FST 的对比**：

```text
MongoDB 大文档 vs ES Lucene FST：
  共同点：
    1. 都是大对象内存压力
    2. 都不能简单 Young GC 回收
    3. 都需要特殊处理
  
  差异：
    1. MongoDB 大文档：业务数据，可以拆分
    2. ES Lucene FST：索引结构，不能拆分，用 MMAP 解决
    3. MongoDB 大文档：JVM Heap 中（BsonDocument）
    4. ES Lucene FST：堆外内存（MMAP 映射文件）
    5. MongoDB 大文档：G1 Humongous Allocation
    6. ES Lucene FST：Direct Memory + MappedByteBuffer

  共同教训：
    1. 大对象是 JVM 杀手
    2. 拆分 / MMAP / 流式处理是解决思路
    3. 监控大对象分配（JFR + allocation sampling）
```

#### Result - 结果与经验

**业务结果**：
- 故障持续 15 分钟（16:00 - 16:15）
- 消息存档延迟 P99 2s → 50ms（修复后）
- Full GC 每分钟 1 次 → 0 次（修复后）
- Kafka 消费滞后恢复

**技术结果**：
- 5 分钟定位为 G1 Humongous Allocation
- 用 GC 日志 + jmap -histo 完整定位
- G1 Region 调大 16MB + MongoDB Schema 优化
- 一周内 Heap 稳定 2GB 以下

**经验沉淀**：

1. **G1 Region 大小要匹配业务对象大小**：Region >= 业务最大对象大小 × 2
2. **5MB 文档是 G1 Humongous 杀手**：默认 4MB Region 下，2MB+ 对象就 Humongous
3. **MongoDB Schema 必须避免大文档**：图片 / 视频 / 大文本存 OSS，文档只存 URL
4. **冷热分离是必须的**：6 个月前归档 OSS，MongoDB 只保留热数据
5. **JFR + allocation sampling 是发现大对象分配的利器**：比 jmap -histo 更早发现

**面试 STAR 法则讲述要点**：

```text
S（Situation）：
  - 消息存档服务日均 210w 消息，单文档最大 5MB
  - Full GC 每分钟 1 次，P99 RT 2s
  - Kafka 消费滞后 5 分钟
  - 监管查询历史消息超时

T（Task）：
  - 5 分钟定位 Full GC 根因
  - 30 分钟止血恢复（P99 < 100ms）
  - 24 小时根因修复 + MongoDB Schema 优化

A（Action）：
  - 第 1 步：GC 日志识别 Humongous
    - 看到 [Humongous Allocation] 标记
    - 看到 (humongous) 的 Mixed GC
    - jmap -histo 看 1500 个 byte[] 占 5.4GB
  - 第 2 步：根因定位
    - 5MB 文档 > Region / 2 = 2MB → Humongous Object
    - Humongous 跨 Region，回收只能在 Full GC 或 Concurrent Marking 后
    - 1500 个 5MB 文档 = 5.4GB（67% Heap）
  - 第 3 步：MongoDB Schema 分析
    - 8.5% 文档 > 2MB（触发 Humongous）
    - 大文档都是包含图片 base64 的
  - 第 4 步：止血 + 根因修复
    - 止血：扩容 +2 Pod + 临时调大 G1 Region 16MB
    - PR 1：G1 Region 16MB（5MB < 8MB 阈值，不再 Humongous）
    - PR 2：MongoDB Schema 优化 - 图片存 OSS，文档只存 URL
    - PR 3：冷热分离 - 6 个月前归档 OSS
    - PR 4：JFR + allocation sampling 监控大对象分配

R（Result）：
  - 5 分钟定位，15 分钟全量恢复
  - Full GC 每分钟 1 次 -> 0 次
  - P99 RT 2s -> 50ms
  - Heap 稳定 2GB 以下（之前 5.4GB）
  - 沉淀 G1 Region 选型规范 + MongoDB Schema 设计规范
```

**与架构师水平的差距与补足方向**：

| 能力项 | 我的水平 | 架构师水平 | 补足方向 |
|--------|---------|----------|---------|
| G1 Humongous 机制 | 知道概念但不知道触发条件 | 能脱口而出 Region / 2 阈值 + 分配 / 回收机制 | 精读 OpenJDK g1CollectedHeap.cpp |
| G1 Region 选型 | 用默认值 | 能根据业务对象大小选 Region | 整理团队"G1 Region 选型规范" |
| MongoDB Schema | 凭感觉设计 | 能讲清大文档拆分 + 冷热分离 | 调研 MongoDB Schema 设计最佳实践 |
| 冷热分离 | 知道概念但没实现过 | 能设计完整归档流水线 | 实战 OSS 归档 + Hive 元数据同步 |
| JFR allocation sampling | 不熟悉 | 能用 JFR 看大对象分配趋势 | 每周练 1 次 JFR 分析 |

---

## 题目二（参数模板全解题）：JVM 调优参数模板（4 套生产配置）

请详细回答以下问题：

请为在线问诊系统的 4 个核心服务设计生产级 JVM 参数模板：1）IM 网关（10w+ 长连接、Netty 直接内存重）；2）视频问诊 SFU（200 路并发、低延迟要求）；3）监管上报（1300 QPS、24h 必达）；4）消息存档（MongoDB 大文档、冷热分离）。每个模板需要包含：堆大小 / GC 收集器 / 直接内存 / 元空间 / GC 参数 / JIT 参数 / 容器化参数 / 监控参数 / 故障兜底参数，并说明为什么这么配。

### 作答区

### IM 网关 JVM 参数模板

```bash
# IM 网关 JVM 参数（10w+ 长连接、Netty 直接内存重）
java \
  # 堆大小（固定，避免动态扩展）
  -Xmx4g -Xms4g \
  # GC 收集器
  -XX:+UseG1GC \
  -XX:MaxGCPauseMillis=100 \
  -XX:G1HeapRegionSize=4m \
  -XX:InitiatingHeapOccupancyPercent=35 \
  -XX:G1ReservePercent=15 \
  # 直接内存（Netty ByteBuf）
  -XX:MaxDirectMemorySize=2g \
  -Dio.netty.allocator.type=pooled \
  -Dio.netty.maxDirectMemory=2g \
  -Dio.netty.leakDetection.level=SIMPLE \
  # 元空间
  -XX:MetaspaceSize=256m \
  -XX:MaxMetaspaceSize=512m \
  # JIT 参数
  -XX:+TieredCompilation \
  -XX:CompileThreshold=10000 \
  # 容器化参数
  -XX:+UseContainerSupport \
  -XX:InitialRAMPercentage=50.0 \
  -XX:MaxRAMPercentage=50.0 \
  # 监控参数
  -XX:NativeMemoryTracking=summary \
  -Xlog:gc*:file=/data/log/gc.log:time,level,tags:filecount=10,filesize=100M \
  -XX:StartFlightRecording=duration=1h,filename=/data/jfr/recording.jfr,maxsize=200M \
  # 故障兜底
  -XX:+HeapDumpOnOutOfMemoryError \
  -XX:HeapDumpPath=/data/dump/ \
  -XX:OnOutOfMemoryError="kill -9 %p" \
  -jar im-gateway.jar
```

**配置说明**：

| 参数 | 值 | 理由 |
|------|-----|------|
| -Xmx/-Xms | 4g | K8s 8GB Pod，Heap 占 50%（剩下 50% 给 Direct + JVM 自身） |
| MaxGCPauseMillis | 100ms | IM 心跳超时 200ms，GC 停顿必须 &lt; 心跳超时 |
| G1HeapRegionSize | 4m | 8GB 堆默认 2MB，调到 4MB 减少 Region 数量 |
| IHOP | 35% | 默认 45% 太晚，IM 网关对象分配率高，35% 更早启动并发标记 |
| G1ReservePercent | 15% | 默认 10%，调到 15% 防止 to-space exhausted |
| MaxDirectMemorySize | 2g | Netty 直接内存限制，K8s limit 8GB 减去 Heap 4GB 减去 JVM 自身 1GB = 3GB，留 1GB buffer |
| MetaspaceSize | 256m | 启动时预分配，避免元空间扩张引发 Full GC |
| MaxRAMPercentage | 50% | K8s 8GB Pod，Heap 占 50% |

### 视频问诊 SFU JVM 参数模板

```bash
java \
  -Xmx8g -Xms8g \
  -XX:+UseG1GC \
  -XX:MaxGCPauseMillis=50 \
  -XX:G1HeapRegionSize=8m \
  -XX:InitiatingHeapOccupancyPercent=30 \
  -XX:G1ReservePercent=20 \
  -XX:MaxDirectMemorySize=4g \
  -XX:MetaspaceSize=256m \
  -XX:MaxMetaspaceSize=512m \
  -XX:+TieredCompilation \
  -XX:+UseContainerSupport \
  -XX:InitialRAMPercentage=50.0 \
  -XX:MaxRAMPercentage=50.0 \
  -XX:NativeMemoryTracking=summary \
  -Xlog:gc*:file=/data/log/gc.log:time,level,tags:filecount=10,filesize=100M \
  -XX:StartFlightRecording=duration=1h,filename=/data/jfr/recording.jfr,maxsize=200M \
  -XX:+HeapDumpOnOutOfMemoryError \
  -XX:HeapDumpPath=/data/dump/ \
  -XX:OnOutOfMemoryError="kill -9 %p" \
  -jar video-sfu.jar
```

**配置说明**：

| 参数 | 值 | 理由 |
|------|-----|------|
| -Xmx | 8g | 视频问诊对象分配率高（RTP 包），需要大堆 |
| MaxGCPauseMillis | 50ms | 视频延迟要求 P99 &lt; 100ms，GC 停顿必须 &lt; 50ms |
| G1HeapRegionSize | 8m | RtpQueue 1MB，Region 8MB 让 RtpQueue 不跨 Region |
| IHOP | 30% | 视频对象分配率高，30% 更早启动并发标记 |
| G1ReservePercent | 20% | RTP 包突发场景，预留 20% 防止 to-space exhausted |
| MaxDirectMemorySize | 4g | Kurento Media Server 用 Direct Buffer 处理 RTP 包 |

### 监管上报 JVM 参数模板

```bash
java \
  -Xmx6g -Xms6g \
  -XX:+UseG1GC \
  -XX:MaxGCPauseMillis=200 \
  -XX:G1HeapRegionSize=4m \
  -XX:InitiatingHeapOccupancyPercent=40 \
  -XX:G1ReservePercent=15 \
  -XX:MetaspaceSize=256m \
  -XX:MaxMetaspaceSize=512m \
  -XX:+TieredCompilation \
  -XX:+UseContainerSupport \
  -XX:InitialRAMPercentage=75.0 \
  -XX:MaxRAMPercentage=75.0 \
  -Xlog:gc*:file=/data/log/gc.log:time,level,tags:filecount=10,filesize=100M \
  -XX:StartFlightRecording=duration=1h,filename=/data/jfr/recording.jfr,maxsize=200M \
  -XX:+HeapDumpOnOutOfMemoryError \
  -XX:HeapDumpPath=/data/dump/ \
  -XX:OnOutOfMemoryError="kill -9 %p" \
  -jar regulator-report.jar
```

**配置说明**：

| 参数 | 值 | 理由 |
|------|-----|------|
| -Xmx | 6g | 监管上报无 Direct 内存压力，Heap 可以占 75% |
| MaxGCPauseMillis | 200ms | 监管上报延迟容忍度高（24h 必达），GC 停顿要求宽松 |
| MaxRAMPercentage | 75% | 无 Direct 内存压力，Heap 占比可以高 |
| 无 MaxDirectMemorySize | - | 监管上报无 Netty 直接内存压力 |

### 消息存档 JVM 参数模板

```bash
java \
  -Xmx8g -Xms8g \
  -XX:+UseG1GC \
  -XX:MaxGCPauseMillis=200 \
  -XX:G1HeapRegionSize=16m \
  -XX:InitiatingHeapOccupancyPercent=35 \
  -XX:G1ReservePercent=15 \
  -XX:MetaspaceSize=256m \
  -XX:MaxMetaspaceSize=512m \
  -XX:+TieredCompilation \
  -XX:+UseContainerSupport \
  -XX:InitialRAMPercentage=50.0 \
  -XX:MaxRAMPercentage=50.0 \
  -Xlog:gc*:file=/data/log/gc.log:time,level,tags:filecount=10,filesize=100M \
  -XX:StartFlightRecording=duration=1h,filename=/data/jfr/recording.jfr,maxsize=200M \
  -XX:+HeapDumpOnOutOfMemoryError \
  -XX:HeapDumpPath=/data/dump/ \
  -XX:OnOutOfMemoryError="kill -9 %p" \
  -jar message-archive.jar
```

**配置说明**：

| 参数 | 值 | 理由 |
|------|-----|------|
| -Xmx | 8g | 大文档处理需要大堆 |
| G1HeapRegionSize | 16m | 5MB 文档 &lt; 16MB / 2 = 8MB，不再 Humongous |
| IHOP | 35% | 大文档批量处理时 Old 区上涨快，35% 更早启动并发标记 |

---

## 题目三（业务架构协同全解题）：JVM 与业务架构协同优化

请详细回答以下问题：

JVM 调优不只是调参数，更是业务架构调优。请从架构师视角，讲述 JVM 与业务架构协同优化的 5 个维度：1）缓存架构（Caffeine vs Redis vs MySQL 三级缓存的边界划分）；2）消息可靠性（Outbox / 事务消息 / 客户端 ACK / 服务端重发的协同）；3）大对象处理（图片 / 视频 / 大文档的存储与传输策略）；4）长连接管理（IM 网关 10w+ 长连接的内存模型与心跳设计）；5）容量规划（K8s limit / JVM Heap / Direct Memory / Metaspace 的全局配比）。

### 作答区

### 维度一：缓存架构（三级缓存的边界划分）

```text
三级缓存模型：
  L1: Caffeine（本地缓存，1w Key 以内，TTL 30min）
  L2: Redis（分布式缓存，所有数据，TTL 24h）
  L3: MySQL（持久化，永久）

边界划分原则：
  1. 热点数据：L1（最近 30min 内的活跃查询）
  2. 全量数据：L2（24h 内的所有数据）
  3. 持久化：L3

JVM 调优协同：
  - L1 Caffeine 必须设 maximumSize（避免 Heap 膨胀）
  - L1 Caffeine 必须设 TTL（避免老对象堆积）
  - L1 Caffeine 必须开 recordStats（监控命中率）
  - L2 Redis 不占 JVM Heap（但占用网络 / 序列化开销）
  - L3 MySQL 不占 JVM Heap（但占用连接池）

在线问诊系统的缓存边界：
  - 问诊订单：L1 1w / L2 全部
  - 医师信息：L1 5000（医师总数）/ L2 全部
  - 药品目录：L1 5w（药品总数）/ L2 全部
  - 监管规则：L1 3w（规则总数）/ L2 全部
  - 会话路由：L1 1w（活跃会话）/ L2 全部
```

### 维度二：消息可靠性（4 层保障的协同）

```text
4 层消息可靠性保障：
  1. Outbox 模式（业务表 + 消息表本地事务）
  2. RocketMQ 事务消息（高性能，与业务解耦）
  3. 客户端 ACK + seq 补齐（保证客户端不丢）
  4. 服务端重发补偿（保证 ACK 不丢）

JVM 调优协同：
  - Outbox 表存 MySQL，不占 JVM Heap
  - RocketMQ 客户端有内部缓存（producer 内部 batch）
    → 调 producer maxBatchSize / maxBatchIntervalMillis
  - 客户端 seq 存 Redis，不占 JVM Heap
  - 服务端重发 Map 必须用 Caffeine + maximumSize + TTL

在线问诊系统的消息可靠性：
  - 关键消息（处方 / 监管上报）：Outbox + 事务消息 + 重发
  - 普通消息（聊天）：事务消息 + 客户端 ACK + 重发
  - 大消息（图片 / 视频）：上传 OSS 后只发 URL
```

### 维度三：大对象处理（存储与传输策略）

```text
大对象分类：
  1. 图片（化验单 / 处方单）：100KB - 5MB
  2. 视频（视频问诊录制）：50MB - 500MB
  3. 大文档（电子病历）：1MB - 10MB
  4. 大日志（审计日志）：1MB - 100MB

存储策略：
  - 图片：OSS（按 sessionId 分目录）+ MongoDB 存 URL
  - 视频：OSS + 录制元数据存 MongoDB
  - 大文档：拆分为多条小文档存 MongoDB
  - 大日志：直接写 ES（Lucene 用 MMAP）

传输策略：
  - 不在 IM 消息中传输大对象（只传 URL）
  - 大文件上传走 OSS 直传（不经过业务服务）
  - 大文件下载走 OSS 直链（CDN 加速）

JVM 调优协同：
  - 不在 JVM Heap 中持有大对象
  - 流式处理（InputStream / OutputStream，不要一次 read 全部）
  - 大对象分配触发 Humongous 时调大 G1 Region
  - 用 Direct ByteBuffer 处理网络 IO（不占 Heap）
```

### 维度四：长连接管理（10w+ 长连接的内存模型）

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

心跳设计：
  - 心跳间隔 60s（客户端 -> 服务端）
  - 心跳超时 180s（3 次心跳未收到判定断线）
  - GC 停顿必须 < 心跳超时（MaxGCPauseMillis 100ms）
  - 心跳 ByteBuf 池化（避免每次 new）
```

### 维度五：容量规划（K8s / JVM / Direct / Metaspace 全局配比）

```text
K8s Pod 8GB 内存的全局配比：
  - JVM Heap: 4GB（50%）
  - Direct Memory: 2GB（25%）
  - Metaspace: 512MB（6%）
  - JVM 自身（Code Cache / Thread Stack / GC 日志等）: 1GB（13%）
  - Buffer: 488MB（6%）

K8s Pod 16GB 内存的全局配比（视频问诊）：
  - JVM Heap: 8GB（50%）
  - Direct Memory: 4GB（25%）
  - Metaspace: 512MB（3%）
  - JVM 自身: 2GB（13%）
  - Buffer: 1.5GB（9%）

容量规划公式：
  K8s limit = Heap + Direct + Metaspace + JVM 自身 + Buffer
  Heap = 50% K8s limit
  Direct = 25% K8s limit（有 Netty 时）
  Metaspace = 512MB（固定）
  JVM 自身 = 13% K8s limit
  Buffer = 6-9% K8s limit
```

---

## 能力差距提示

作答时请对照架构师水平，重点检查以下能力：

1. **5 个 STAR 案例的完整讲述能力**：能否用 STAR 法则结构化讲述 5 个案例，每个案例 5 分钟讲完
2. **JVM 与业务架构协同能力**：能否从架构师视角讲清 JVM 与缓存 / 消息 / 大对象 / 长连接 / 容量规划的协同
3. **5 类内存泄漏模式的识别清单**：能否背出 5 类模式 + 识别清单 + 修复方案
4. **G1 调优参数耦合关系**：能否讲清 Region / IHOP / G1ReservePercent / MaxGCPauseMillis 的耦合
5. **JVM 监控 4 维度**：Heap / Direct / Metaspace / RSS，能否设计完整监控告警
6. **5 个案例的工具链组合**：能否根据故障类型选择对应工具链（Direct OOM 用 NMT / GC CPU 高用 jmap+vmtool / heap OOM 用 MAT+OQL）
7. **简历项目实战案例的深度**：能否在面试中根据面试官兴趣选 2-3 个案例深讲
