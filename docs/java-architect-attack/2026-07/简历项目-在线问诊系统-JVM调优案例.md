# 简历项目 · 在线问诊系统 · JVM 调优案例

> 配套文档：架构文档、技术亮点与难点拆解、面试问答预演、核心模块（医保对接 / 处方开具）
> 本文聚焦 5 个真实 JVM 故障排查案例，每个案例包含：业务背景、故障现象、5 分钟定位过程、根因修复、量化收益、面试追问点
> 整理日期：2026-08-07（基于 2025-Q2 ~ 2026-Q1 真实故障复盘）

---

## 概述

在线问诊系统在 2025-Q2 ~ 2026-Q1 期间共发生 5 次 P1/P2 级 JVM 故障，覆盖 Direct Memory OOM / GC CPU 高 / Heap OOM / 缓存膨胀 / G1 Humongous 五种典型场景。本文以 STAR 法则结构化复盘每个案例，沉淀出可复用的 JVM 故障排查方法论与预防体系。

| 案例 | 服务 | 故障类型 | 业务影响 | 修复时长 | 量化收益 |
|------|------|---------|---------|---------|---------|
| 案例一 | IM 网关 | Direct Buffer OOM | 服务不可用 30 分钟 | 30 分钟止血 / 24h 修复 | Direct Memory 6.5GB -> 200MB |
| 案例二 | 视频问诊 SFU | GC CPU 高 | 200 路通话卡顿 | 30 分钟止血 / 24h 修复 | Full GC 8 次/分 -> 0 次/分 |
| 案例三 | 监管上报 | Heap OOM | 上报延迟 1.5h | 30 分钟止血 / 24h 修复 | Heap 6GB 涨满 -> 1.5GB 稳定 |
| 案例四 | 问诊订单 | GC CPU 高 | CPU 80% 持续高 | 15 分钟止血 / 24h 修复 | CPU 80% -> 30% |
| 案例五 | 消息存档 | G1 Humongous | P99 RT 2s | 15 分钟止血 / 24h 修复 | Full GC 1 次/分 -> 0 次/分 |

---

## 案例一：IM 网关 ByteBuf 直接内存 OOM

### 1.1 业务背景

IM 网关承担医患 IM 长连接管理与消息分发，是日均 210w 消息的核心入口。

```text
部署：K8s 3 副本，每副本 4 core CPU / 8GB 内存
框架：Spring Boot 2.7 + Netty 4.1.x + JDK 8u362
业务规模：单机 10w+ 长连接，峰值 360w 消息/秒
JVM 参数：-Xmx4g -XX:+UseG1GC -XX:MaxDirectMemorySize=2g
```

### 1.2 故障现象（2025-Q2 凌晨 03:15）

```text
03:15  监控告警：im-gateway CPU 95%、内存 90%
03:16  K8s 自动重启 Pod（OOMKilled）
03:17  3 个 Pod 全部 OOMKilled，IM 服务完全不可用
03:18  雪崩：10w+ 用户断连，1.5w 问诊订单创建失败
03:45  紧急回滚后服务恢复，但根因不明

关键现象：
  - Heap 才 3.8GB（未到 4GB 上限）
  - RSS 7.5GB（接近 K8s limit 8GB）
  - JVM 没抛 OutOfMemoryError
  - K8s 直接 OOMKilled
  -> 监控盲区：Direct Memory 没监控
```

### 1.3 5 分钟定位过程

**第 1 步（0:00-0:30）：现象分类 - 不是 Heap OOM**

```text
关键判断：
  - Heap 3.8GB 没满，但 RSS 7.5GB 接近 K8s limit
  - K8s OOMKilled 基于 RSS（进程总内存），不是 JVM Heap
  - RSS 7.5GB ≈ Heap 3.8GB + Direct ? + JVM 自身 + Metaspace
  -> 强烈提示是 Direct Memory 泄漏

为什么 JVM 没抛 OutOfMemoryError: Direct buffer memory：
  - JDK 8 中 -XX:MaxDirectMemorySize 是"软限制"
  - 实际 Direct 可能涨到 3GB+ 才 OOM
  - K8s 先于 JVM 触发 OOMKilled
```

**第 2 步（0:30-1:00）：抓现场 - 配置 Direct 监控**

```bash
# 临时调整启动参数，加上 Direct 监控
java -Xmx4g -Xms4g \
  -XX:+UseG1GC -XX:MaxGCPauseMillis=200 \
  -XX:MaxDirectMemorySize=2g \
  -Dio.netty.leakDetection.level=ADVANCED \
  -XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/data/dump/ \
  -XX:NativeMemoryTracking=summary \  # 关键：NMT 跟踪 Native 内存
  -Xlog:gc*:file=/data/log/gc.log:time,level,tags \
  -jar im-gateway.jar
```

**第 3 步（1:00-2:00）：NMT 分析 - 用 10% 灰度流量复现**

```bash
# 监控 1 小时后，Direct Memory 涨势：
# 00:00 - 100MB / 00:30 - 800MB / 01:00 - 1.5GB / 01:30 - 2GB / 01:45 - 2.5GB

# 用 jcmd NMT 看 Native 内存构成
jcmd 1 VM.native_memory summary

# 关键输出：
# Internal (reserved=2648058KB, committed=2648058KB)
#                # ← 2.5GB 在 Internal 分类下（NMT 把 Direct ByteBuffer 计入 Internal）

# 用 Arthas 查 DirectByteBuffer 实例
arthas> vmtool --action getInstances --className java.nio.DirectByteBuffer
# 50000 个 DirectByteBuffer 实例

# 查 Direct Memory 占用
arthas> ognl '@java.nio.Bits@reservedMemory'
# 2648058KB ≈ 2.5GB
```

**第 4 步（2:00-3:00）：MAT 分析 DirectByteBuffer 引用链**

```bash
# Arthas heapdump（不触发 Full GC，比 jmap 优越）
arthas> heapdump /data/dump/im-gateway-direct.hprof

# MAT 分析：
# 1. OQL 查询所有 DirectByteBuffer：
#    SELECT db FROM java.nio.DirectByteBuffer db WHERE db.capacity > 1000000
#    -> 找到 200 个 capacity > 1MB 的 DirectByteBuffer

# 2. Path to GC Roots -> exclude weak/soft references
#    -> 找到强引用链：
#    ImHandler.messageHandlers (ConcurrentHashMap)
#      -> MessageHandler.buffer (DirectByteBuffer)
#        -> DirectByteBuffer 被强引用，Cleaner 无法触发
```

**第 5 步（3:00-4:00）：根因 - 业务代码 Bug**

```java
// ImHandler - 业务代码 Bug
public class ImHandler extends ChannelInboundHandlerAdapter {
    
    private static final Map<Channel, MessageHandler> messageHandlers = new ConcurrentHashMap<>();
    
    @Override
    public void channelActive(ChannelHandlerContext ctx, ByteBuf msg) {
        MessageHandler handler = new MessageHandler(ctx.channel());
        handler.buffer = ctx.alloc().directBuffer(1024 * 1024);  // 1MB Direct
        messageHandlers.put(ctx.channel(), handler);
        // ↑ handler 持有 DirectByteBuffer，只要 channel 没断开就一直在
    }
    
    @Override
    public void channelInactive(ChannelHandlerContext ctx) {
        // Bug！移除了 handler 但没 release buffer
        MessageHandler handler = messageHandlers.remove(ctx.channel());
        // 应该 handler.buffer.release(); 但忘了！
        // -> handler 移除后，handler.buffer 进入老年代
        // -> 每次客户端断连，就泄漏 1MB Direct
    }
}
```

```text
为什么凌晨 03:15 才 OOM：
  - 服务运行 7 天，累积了 1.5GB Direct 泄漏
  - 03:00 凌晨流量小，但客户端大量重连（断网后重连）
  - 03:15 1 分钟内 5000+ 客户端断连重连
  - 每次断连重连泄漏 1MB Direct
  - 1 分钟内泄漏 5GB -> Direct 涨到 6.5GB
  - K8s limit 8GB，触发 OOMKilled
```

### 1.4 根因修复

**止血（立即）**：
```bash
# 扩容 +3 Pod，分散流量
kubectl scale deployment im-gateway --replicas=6
# 限流客户端重连（LB 层）：每 IP 每秒最多 1 次重连
```

**PR 1：用 SimpleChannelInboundHandler 自动 release ByteBuf**

```java
// 坏代码：手动 release，容易忘
public class ImHandler extends ChannelInboundHandlerAdapter {
    @Override
    public void channelInactive(ChannelHandlerContext ctx) {
        MessageHandler handler = messageHandlers.remove(ctx.channel());
        // 忘了 release buffer
    }
}

// 好代码：SimpleChannelInboundHandler 自动 release
public class ImHandler extends SimpleChannelInboundHandler<ByteBuf> {
    
    @Override
    protected void channelRead0(ChannelHandlerContext ctx, ByteBuf msg) {
        // SimpleChannelInboundHandler 自动 release msg
        try (ByteBuf respBuf = ctx.alloc().buffer(1024)) {
            processMessage(msg, respBuf);
            ctx.writeAndFlush(respBuf.retain());
        }
    }
    
    @Override
    public void channelInactive(ChannelHandlerContext ctx) {
        messageHandlers.remove(ctx.channel());
    }
}
```

**PR 2：移除业务代码中的 DirectByteBuffer alloc，用 Netty 池化**

```java
// 坏代码：业务自己 alloc DirectByteBuffer
handler.buffer = ctx.alloc().directBuffer(1024 * 1024);

// 好代码：用 Netty 池化的 ByteBuf，由 Netty 管理
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
  -XX:+UseG1GC -XX:MaxGCPauseMillis=100 \
  -XX:MaxDirectMemorySize=2g \
  -XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/data/dump/ \
  -XX:NativeMemoryTracking=summary \
  -Dio.netty.leakDetection.level=SIMPLE \
  -Dio.netty.allocator.type=pooled \
  -Dio.netty.maxDirectMemory=2g \
  -jar im-gateway.jar

# 监控改进（关键）：
# 1. Prometheus + JVM Exporter 加 direct_memory_used 指标
# 2. 告警：Direct Memory > 1.5GB（75% 阈值）
# 3. Grafana 看板：Heap / Direct / Metaspace / RSS 4 个维度
```

### 1.5 量化收益

| 指标 | 修复前 | 修复后 | 改善 |
|------|--------|--------|------|
| Direct Memory | 6.5GB（涨满） | 200MB（稳定） | -97% |
| K8s OOMKilled | 每周 1-2 次 | 0 次（半年） | -100% |
| 服务可用性 | 99.5% | 99.99% | +0.49% |
| ByteBuf 泄漏告警 | 每天 100+ 条 | 0 条 | -100% |

### 1.6 面试追问点

1. **为什么 -XX:+HeapDumpOnOutOfMemoryError 抓不到直接内存现场？**
   - HeapDump 只 dump Heap，不 dump Native / Direct
   - DirectByteBuffer 对象本身在 Heap 中（约 100 字节），但直接内存数据在 Native
   - 需要用 NMT 或 Arthas 主动 dump

2. **Netty ByteBuf 的池化机制是什么？**
   - PoolArena（默认 4 个堆 + 4 个直接）-> PoolChunk（16MB）-> PoolSubpage（小块）
   - MemoryRegionCache：线程本地缓存，减少锁竞争
   - 池化减少 alloc / free 开销（DirectByteBuffer 创建涉及 malloc 系统调用）

3. **如何监控 Direct Memory？**
   - JVM 内：`jcmd VM.native_memory summary` 看 Internal 分类
   - Arthas：`ognl '@java.nio.Bits@reservedMemory'`
   - Prometheus：JVM Exporter 的 `jvm_memory_direct_used` 指标
   - K8s：`container_memory_rss` 减去 Heap 即可估算 Direct

4. **为什么 JDK 8 的 -XX:MaxDirectMemorySize 是软限制？**
   - JDK 8 中 -XX:MaxDirectMemorySize 只在 full 时检查
   - 实际 Direct 可能超过限制
   - JDK 9+ 改为硬限制（每次 alloc 检查）

5. **如果生产 OOM 时不能 dump，怎么办？**
   - 提前配置 NMT + ADVANCED 泄漏检测
   - 灰度复现 + 主动 dump
   - JFR 持续录制（看对象分配趋势）

---

## 案例二：视频问诊 RTP 包堆积 Full GC 频繁

### 2.1 业务背景

视频问诊 SFU 服务承担视频通话的 RTP 包转发，是日均 3200 路视频通话的核心服务。

```text
部署：K8s 2 副本，每副本 8 core CPU / 16GB 内存
框架：Spring Boot 2.7 + Netty 4.1.x + Kurento Media Server + JDK 8u362
业务规模：单机 200 路并发，单路通话 5-15 分钟
JVM 参数：-Xmx8g -XX:+UseG1GC -XX:G1HeapRegionSize=4m
```

### 2.2 故障现象（2025-Q3 14:30）

```text
14:30  监控告警：video-sfu Full GC 每分钟 8 次，STW 1.5s
14:31  P99 RT 800ms（正常 50ms），200 路通话全部卡顿
14:32  30 路通话掉线，医师投诉
14:45  紧急扩容 +2 Pod，但 GC 仍频繁
15:00  开始排查根因

GC 日志：
  Full GC 每分钟 8 次，每次 1.5s STW
  Young GC 后 Old 区还是涨（对象进入 Old 没被回收）
```

### 2.3 5 分钟定位过程

**第 1 步：5 步法分类 - GC CPU 高**

```bash
# top -Hp 找高 CPU 线程
top -Hp $(pgrep -f video-sfu)
#   PID  CPU%  COMMAND
#   123  65%   GC Thread#0
#   124  60%   GC Thread#1
#   125  58%   GC Thread#2
#   126  55%   GC Thread#3
# -> 4 个 GC Thread 占 60%+ CPU

# jstat 看 GC
jstat -gcutil $(pgrep -f video-sfu) 1000 10
#   O=82%（Old 区使用率），FGC=45 次（频繁）
#   1 秒内 1 次 Full GC，Old 区还在涨
```

**第 2 步：jmap -histo 看堆内对象**

```bash
jmap -histo:live $(pgrep -f video-sfu) | head -20
#  num     #instances         #bytes  class name
#     1:       1500000      720000000  [B  ← 150w 个 byte[]，720MB
#     2:       1500000      36000000   java.util.concurrent.ConcurrentHashMap$Node
#     3:       1500000      24000000   com.example.RtpPacket
#     4:       5000         1200000    com.example.RtpQueue  ← 关键！

# 关键发现：
# - 150w 个 byte[]（RTP 包数据），720MB
# - 5000 个 RtpQueue（应该 200 路通话 × 2 方 = 400 个，为什么 5000？）
```

**第 3 步：Arthas vmtool 定位 RtpQueue**

```bash
# Arthas vmtool 查 RtpQueue 实例
arthas> vmtool --action getInstances --className com.example.RtpQueue
# 5000 个 RtpQueue 实例

# 查每个 RtpQueue 的状态
arthas> vmtool --action getInstances --className com.example.RtpQueue \
  --express 'instances.stream().collect(Collectors.groupingBy(i -> i.sessionId)).size()'
# 200 sessions  ← 200 个 session，但 5000 个 RtpQueue
# -> 每个 session 平均 25 个 RtpQueue（应该 2 个：发送 + 接收）
```

**第 4 步：根因 - RTPQueue 生命周期 Bug**

```java
// RtpHandler - 业务代码 Bug
public class RtpHandler {
    
    private final Map<String, RtpQueue> rtpQueues = new ConcurrentHashMap<>();
    
    public void onCallStart(String sessionId, String direction) {
        // Bug：用 sessionId + direction + timestamp 作 key，重连时新建
        String key = sessionId + "_" + direction + "_" + System.currentTimeMillis();
        RtpQueue queue = new RtpQueue(sessionId, direction);
        queue.packets = new LinkedBlockingQueue<>(300);  // 300 个包
        rtpQueues.put(key, queue);
        // ↑ 通话结束时没 remove
    }
    
    public void onCallEnd(String sessionId) {
        // Bug：只清理了 sessionId 对应的最新 key，老的 key 还在
        String key = findLatestKey(sessionId, "send");
        rtpQueues.remove(key);
        // 漏了：通话期间重连产生的老 key 没清理
    }
}
```

```text
为什么 200 路通话有 5000 个 RtpQueue：
  - 视频通话会因网络抖动重连
  - 平均每路通话重连 12 次（移动网络弱网）
  - 200 路通话 × 12 次重连 × 2 方向 = 4800 个 RtpQueue（残留）
  - 加上正常 200 路通话 × 2 = 400 个活跃 RtpQueue
  - 总计 5200 个 RtpQueue

每个 RtpQueue 持有 300 个 byte[]（每个 1500 字节）
  = 5200 × 300 × 1500 = 2.3GB
但 byte[] 在 Young 区分配，晋升到 Old 区后难以回收
  -> Old 区持续上涨
  -> Mixed GC 失败（RtpQueue 跨 Region 引用）
  -> Full GC
```

**第 5 步：为什么 G1 Mixed GC 没能回收**

```bash
# 看 GC 日志中的 Mixed GC
grep "mixed" /data/log/gc.log | tail -20
# 没有看到 mixed 标记，全是 Full GC
# -> CSet 选择失败，Mixed GC 没能回收 Old 区

# 为什么 Mixed GC 失败：
# 1. RtpQueue 跨多个 Region（每个 RtpQueue 2.3MB，跨 1 个 4MB Region）
# 2. RSet（Remembered Set）更新成本高
# 3. IHOP 默认 45%，Old 区 3.7GB / 8GB = 46% 才触发并发标记
# 4. 但并发标记没跟上 Old 区上涨速度
# 5. 触发 Full GC 兜底
```

### 2.4 根因修复

**止血（立即）**：
```bash
# 扩容 +2 Pod，分散流量
kubectl scale deployment video-sfu --replicas=4
# Arthas 主动清理残留的 RtpQueue
arthas> ognl '@com.example.RtpHandler@getInstance().cleanupStaleQueues()'
```

**PR 1：修复 RTPQueue 生命周期管理**

```java
// 坏代码：sessionId + direction + timestamp 作 key，重连时残留
String key = sessionId + "_" + direction + "_" + System.currentTimeMillis();

// 好代码：用 sessionId + direction 作 key，重连时复用
public void onCallStart(String sessionId, String direction) {
    String key = sessionId + "_" + direction;
    rtpQueues.compute(key, (k, oldQueue) -> {
        if (oldQueue != null) {
            oldQueue.clear();
        }
        return new RtpQueue(sessionId, direction);
    });
}

public void onCallEnd(String sessionId) {
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
```

**PR 3：ZGC 选型评估**

```bash
# JDK 17 + ZGC 测试（计划 2026-Q2 升级）
java -Xmx8g -Xms8g \
  -XX:+UseZGC \
  -XX:+ZGenerational \  # 分代 ZGC（JDK 21）
  -XX:SoftMaxHeapSize=6g \
  -jar video-sfu.jar

# ZGC 优势（视频问诊场景）：
# - 停顿 < 10ms（无论堆大小）
# - 并发标记 + 并发整理
# - 染色指针 + 读屏障
```

### 2.5 量化收益

| 指标 | 修复前 | 修复后 | 改善 |
|------|--------|--------|------|
| Full GC 频率 | 8 次/分钟 | 0 次/分钟 | -100% |
| P99 RT | 800ms | 50ms | -94% |
| Old 区使用率 | 82% | 30% | -63% |
| 视频通话掉线率 | 15% | 0.5% | -97% |

### 2.6 面试追问点

1. **G1 Region 大小如何选？**
   - 默认根据堆大小自动选（4GB 选 2MB，8GB 选 4MB，16GB 选 8MB）
   - 选择原则：Region 大小 > 业务最大对象大小 × 2
   - 业务最大对象 1MB -> Region >= 2MB -> 选 4MB
   - 避免对象触发 Humongous（>= Region / 2）

2. **G1 Mixed GC 为什么会失败？**
   - CSet（Collection Set）选择失败：跨 Region 引用多，RSet 更新成本高
   - IHOP 太高：默认 45%，Old 区上涨快时来不及触发并发标记
   - to-space exhausted：Survivor 区不够，晋升失败

3. **视频问诊场景为什么 ZGC 比 G1 更合适？**
   - 低延迟要求：P99 RT &lt; 100ms，G1 的 100ms 停顿踩在边界
   - 大堆优势：8GB 堆下 G1 还行，但 16GB+ 时 G1 停顿会涨
   - RTP 包敏感：1.5s STW 直接导致视频卡顿
   - ZGC 停顿 &lt; 10ms（无论堆大小）

4. **Arthas vmtool 与 jmap -histo 的区别？**
   - jmap -histo：看堆内对象类型 + 数量，不区分实例
   - Arthas vmtool：直接看实例 + 字段值，能定位到具体哪个实例
   - vmtool 更精确，但开销稍大

5. **为什么 IHOP 调低能解决问题？**
   - IHOP 是 Initiating Heap Occupancy Percent，触发并发标记的 Old 区阈值
   - 默认 45%，但视频对象分配率高，Old 区上涨快
   - 调到 35%，让并发标记更早启动，Mixed GC 有更多时间回收

---

## 案例三：监管上报 Map 累积 heap OOM

### 3.1 业务背景

监管上报服务承担医疗合规上报，是医疗合规 24h 必达的核心服务。

```text
部署：K8s 2 副本，每副本 4 core CPU / 8GB 内存
框架：Spring Boot 2.7 + Kafka Client + OkHttp + JDK 8u362
业务规模：日均 13w 上报，Kafka 消费 1300 QPS，3 万条上报规则
JVM 参数：-Xmx6g -XX:+UseG1GC -XX:+HeapDumpOnOutOfMemoryError
```

### 3.2 故障现象（2025-Q4 10:00）

```text
10:00  监控告警：regulator-report OOM 自动重启
10:01  重启后 30 分钟再次 OOM
10:32  连续 3 次 OOM，K8s CrashLoopBackOff
10:35  监管上报堆积 5w 条，超时风险
10:45  医疗合规告警：24h 必达可能违约

Heap Dump（自动 dump 的）：
  - 文件大小：4.2GB
  - Top 1: ConcurrentHashMap$Node (4500w, 4.5GB)
  - Top 2: String (1500w, 1.2GB)
  - Top 3: ReportTask (500w, 600MB)
```

### 3.3 5 分钟定位过程

**第 1 步：MAT 分析自动 dump**

```text
MAT Leak Suspects 报告：
  "Problem 1: 4500 instances of java.util.concurrent.ConcurrentHashMap"
  "loaded by com.example.ReportTaskManager occupies 4,500,000,000 (87.5%) bytes"
  -> 4500 个 ConcurrentHashMap 占 4.5GB（87.5%）

Dominator Tree（支配树）：
  java.util.concurrent.ConcurrentHashMap
    ├── ReportTaskManager.taskMap (2.5GB)
    │     └── ConcurrentHashMap$Node × 1500w
    ├── ReportTaskManager.retryMap (1.5GB)
    │     └── ConcurrentHashMap$Node × 800w
    └── ReportTaskManager.idempotentMap (500MB)
          └── ConcurrentHashMap$Node × 200w
```

**第 2 步：OQL 查询超大 Map**

```sql
-- OQL 查询所有 ConcurrentHashMap（按 retainedHeapSize 排序）
SELECT s FROM java.util.concurrent.ConcurrentHashMap s 
WHERE s.@retainedHeapSize > 100000000

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
-- -> 每次重试都新建 UUID，老的没清理
```

**第 3 步：根因 - 5 类泄漏模式中的"静态集合无限增长"**

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
        
        // Bug 2：幂等检查用 reportId（应该用业务 ID）
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
    }
    
    public void onReportSuccess(String reportId) {
        taskMap.remove(reportId);
        // ↑ 成功时移除，但 retryMap 没 remove
    }
}
```

**第 4 步：为什么自动 dump 抓到的不是元凶**

```text
-XX:+HeapDumpOnOutOfMemoryError 的局限：
  1. OOM 时已经 Full GC 多次，对象状态已变
  2. dump 的是 OOM 那一刻的 Heap，不是泄漏开始时
  3. 但本案例幸运，因为 Map 是强引用，Full GC 也没法回收

更好的做法：
  1. 主动 jcmd heap_dump（不依赖 OOM 触发）
  2. 设置 heap 使用率 80% 告警，主动 dump
  3. JFR 持续录制，看对象分配趋势
```

### 3.4 根因修复

**止血（立即）**：
```bash
# 扩容 +2 Pod，分散消费
kubectl scale deployment regulator-report --replicas=4
# Kafka 消费限流（避免重启后再次 OOM）
# 配置 Kafka consumer max.poll.records=100（默认 500）
# Arthas 主动清理 Map
arthas> ognl '@com.example.ReportTaskManager@taskMap.clear()'
arthas> ognl '@com.example.ReportTaskManager@retryMap.clear()'
arthas> ognl '@com.example.ReportTaskManager@idempotentMap.clear()'
```

**PR 1：用业务 ID 替代 UUID 作为 reportId**

```java
// 坏代码：每次新建 UUID
String reportId = UUID.randomUUID().toString() + "_" + System.currentTimeMillis();

// 好代码：用业务 ID（orderId + reportType），保证幂等
String reportId = data.getOrderId() + "_" + data.getReportType();
```

**PR 2：用 Caffeine 替代 ConcurrentHashMap，加 maximumSize + TTL**

```java
// 坏代码：静态 Map 无限增长
private static final Map<String, ReportTask> taskMap = new ConcurrentHashMap<>();

// 好代码：Caffeine 加 maximumSize + TTL
private static final Cache<String, ReportTask> taskMap = Caffeine.newBuilder()
    .maximumSize(10_000)
    .expireAfterWrite(Duration.ofHours(1))
    .recordStats()
    .build();

// 幂等 Map 用 Redis（不占 JVM Heap）
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
        task = new ReportTask(/* ... */);
        taskMap.put(reportId, task);
    }
    task.incrementRetryCount();
    if (task.getRetryCount() > 3) {
        sendToDLQ(task);  // 进入死信队列
        return;
    }
    retryMap.put(reportId, task);  // 复用同一对象
}
```

**PR 4：监控告警改进**

```bash
# 1. Caffeine stats 暴露到 Prometheus
# - cache.size / cache.hit.rate / cache.eviction.count
# 2. 告警规则
# - taskMap.size > 5000 告警
# - retryMap.size > 1000 告警
# - Heap 使用率 > 80% 主动 dump
# 3. JFR 持续录制
java -XX:StartFlightRecording=duration=1h,filename=/data/jfr/recording.jfr,maxsize=200M
```

### 3.5 量化收益

| 指标 | 修复前 | 修复后 | 改善 |
|------|--------|--------|------|
| Heap 使用 | 6GB 涨满 | 1.5GB 稳定 | -75% |
| Full GC | 持续 4 分钟 | 0 次 | -100% |
| OOM 频率 | 30 分钟一次 | 0 次（半年） | -100% |
| 24h 必达率 | 99.5% | 99.99% | +0.49% |

### 3.6 面试追问点

1. **5 类内存泄漏模式有哪些？**
   - 缓存膨胀：Caffeine / Guava Cache 没设 maximumSize
   - ThreadLocal 累积：线程池下 ThreadLocal 没 remove
   - 监听器 Callback 未 unregister
   - 静态集合无限增长（本案例）
   - finalize 队列堆积

2. **MAT 支配树（Dominator Tree）的算法原理？**
   - X 支配 Y 当且仅当所有从 GC Roots 到 Y 的路径都经过 X
   - 支配树用于计算 Retained Size（保留大小）
   - 1 分钟内从 Dominator Tree 找到 Retained Top 1 元凶

3. **OQL（Object Query Language）查询语法？**
   - `SELECT s FROM java.util.HashMap s WHERE s.@retainedHeapSize > 1000000`
   - 类 SQL 语法，查特定模式对象
   - `@retainedHeapSize` 是 MAT 扩展属性

4. **为什么幂等性应该用 Redis 而非 JVM Map？**
   - Redis 不占 JVM Heap，避免内存压力
   - Redis 跨实例共享，多 Pod 一致
   - Redis 自带 TTL，避免无限增长
   - Redis 持久化，重启不丢

5. **自动 dump 的局限性？**
   - OOM 时已经 Full GC 多次，对象状态已变
   - 弱引用 / 软引用可能已被清空
   - 元凶对象在 Native 内存（不在 Heap）
   - 改进：80% 主动 dump + JFR 持续录制

---

## 案例四：问诊订单缓存 100w Key GC CPU 高

### 4.1 业务背景

问诊订单服务承担问诊订单的创建、查询、状态变更，是日均 5.2w 订单的核心交易服务。

```text
部署：K8s 3 副本，每副本 4 core CPU / 8GB 内存
框架：Spring Boot 2.7 + Caffeine 3.x + Redis 7.x + JDK 8u362
业务规模：日均 5.2w 订单，峰值 8.1w，缓存命中率要求 95%+
JVM 参数：-Xmx4g -XX:+UseG1GC
```

### 4.2 故障现象（2026-Q1 09:00）

```text
09:00  监控告警：consult-order CPU 80%+ 持续高
09:01  Young GC 频繁（每秒 1 次），但接口 RT 正常
09:05  扩容 +1 Pod，CPU 仍 70%+
09:15  临近早高峰，可能引发雪崩

GC 日志：
  Young GC 每秒 1 次，每次 25-30ms
  没有 Full GC，Old 区缓慢上涨（45% -> 50%）

CPU：
  - GC Thread：50%（4 个 GC Thread 各 12.5%）
  - 业务线程：30%
```

### 4.3 5 分钟定位过程

**第 1 步：5 步法分类 - GC CPU 高**

```bash
# top -Hp 找高 CPU 线程
top -Hp $(pgrep -f consult-order)
#   4 个 GC Thread 各 12% CPU，总计 50%
# -> GC CPU 高

# jstat 看 GC
jstat -gcutil $(pgrep -f consult-order) 1000 10
#   YGC=5678，YGCT=142s（平均 25ms/次）
#   FGC=0（没有 Full GC）
#   O=45%（Old 区缓慢上涨）

# jmap -histo 看对象
jmap -histo:live $(pgrep -f consult-order) | head -10
#  num     #instances         #bytes  class name
#     1:       1000000      48000000  java.util.LinkedHashMap$Entry  ← 100w 个！
#     2:       1000000      24000000  com.example.ConsultOrder
#     3:       1000000      16000000  java.lang.String
# -> 100w 个 LinkedHashMap$Entry，强烈提示 Caffeine 缓存膨胀
```

**第 2 步：Arthas vmtool 定位 Caffeine 实例**

```bash
# Arthas vmtool 查 Caffeine 实例
arthas> vmtool --action getInstances --className com.github.benmanes.caffeine.cache.BoundedLocalCache
# 5 个 BoundedLocalCache 实例

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

# 查 Caffeine 缓存的配置
arthas> vmtool --action getInstances --className com.github.benmanes.caffeine.cache.BoundedLocalCache \
  --express 'instances.stream().filter(i -> i.entrySet().size() > 100000).map(i -> i.evictionPolicy).collect(Collectors.toList())'
# [EvictionPolicy.NONE]  ← 没有驱逐策略！
```

**第 3 步：根因 - Caffeine 没设 maximumSize**

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

**第 4 步：为什么 Young GC 频繁而非 Old GC**

```text
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
```

### 4.4 根因修复

**止血（立即）**：
```bash
# 扩容 +1 Pod
kubectl scale deployment consult-order --replicas=4
# Arthas 主动清空 Caffeine 缓存
arthas> ognl '@com.example.OrderCacheConfig@orderCache.invalidateAll()'
```

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
        .maximumSize(10_000)
        .expireAfterWrite(30, TimeUnit.MINUTES)
        .recordStats()
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
  3. MySQL：持久化数据

两级缓存查询逻辑：
  1. Caffeine 命中 -> 直接返回
  2. Caffeine 未命中 -> 查 Redis
  3. Redis 命中 -> 回填 Caffeine + 返回
  4. Redis 未命中 -> 查 MySQL + 回填 Redis + Caffeine + 返回
```

**PR 3：Caffeine 监控告警**

```bash
# 1. Caffeine stats 暴露到 Prometheus
# 暴露指标：cache.size / cache.hit.rate / cache.eviction.count / cache.load.average
# 2. 告警规则
# - cache.size > 8000 告警（80% 容量）
# - cache.hit.rate < 80% 告警（命中率低）
# - cache.eviction > 100/s 告警（频繁驱逐）
```

### 4.5 量化收益

| 指标 | 修复前 | 修复后 | 改善 |
|------|--------|--------|------|
| CPU 使用率 | 80%+ | 30% | -63% |
| Young GC 频率 | 1 次/秒 | 1 次/30秒 | -97% |
| Caffeine size | 100w | 1w | -99% |
| 缓存命中率 | 60%（被驱逐） | 95%+ | +35% |

### 4.6 面试追问点

1. **Caffeine 的 maximumSize 与 TTL 的关系？**
   - maximumSize：基于 Window TinyLfu 算法驱逐
   - TTL：基于时间驱逐
   - 两者独立，先到先驱逐
   - 必须同时设，缺一不可

2. **Caffeine vs Guava Cache vs Ehcache 的区别？**
   - Caffeine：性能最好（W-TinyLfu），Spring Boot 默认
   - Guava Cache：老旧，已被 Caffeine 替代
   - Ehcache：功能全（支持堆外 / 磁盘），但配置复杂

3. **Caffeine 的 W-TinyLfu 算法是什么？**
   - Window LRU + TinyLfu（Count-Min Sketch 估算频率）
   - 既保护新热点，又驱逐老冷数据
   - 命中率比 LRU 高 30%+

4. **本地缓存 vs 分布式缓存的边界？**
   - 本地缓存：1w Key 以内，TTL 短（30min），高命中热点
   - 分布式缓存：所有数据，TTL 长（24h），跨实例共享
   - 选择原则：本地缓存 &lt; 1w Key，超过用分布式

5. **为什么缓存膨胀会引发 Young GC 频繁？**
   - Caffeine 内部 LinkedHashMap 每次 put 都 new Entry
   - 高 QPS 下每秒 5000 个新对象
   - Young 区 1 秒就满
   - Young GC 频繁

---

## 案例五：MongoDB 大文档 G1 Humongous Allocation

### 5.1 业务背景

消息存档服务承担医患 IM 消息的存储与归档，是医疗合规 15 年留存的核心服务。

```text
部署：K8s 2 副本，每副本 8 core CPU / 16GB 内存
框架：Spring Boot 2.7 + MongoDB Driver 4.x + JDK 8u362
存储：MongoDB 5.x 分片集群（按 sessionId 哈希分片）
业务规模：日均 210w 消息，年新增 7.6 亿条，单文档最大 5MB
JVM 参数：-Xmx8g -XX:+UseG1GC（G1HeapRegionSize 默认 4MB）
```

### 5.2 故障现象（2025-Q4 16:00）

```text
16:00  监控告警：message-archive Full GC 每分钟 1 次
16:01  消息写入延迟 P99 2s（正常 50ms）
16:05  紧急扩容 +2 Pod，但 Full GC 仍频繁
16:15  开始排查根因

GC 日志：
  [16:00:15] GC(1235) [Humongous Allocation]  ← 关键标记
  [16:00:15] GC(1236) Pause Young (mixed) (G1 Evacuation Pause) (humongous) 5000M->3800M 220ms
  [16:00:30] GC(1237) Pause Full 6500M->4500M 1850ms  ← Full GC
  -> 看到 [Humongous Allocation] 标记
  -> 触发 Full GC

jmap -histo：
  num     #instances         #bytes  class name
     1:       1500          5400000000  [B  ← 1500 个 byte[]，5.4GB！
  # 平均每个 3.6MB（接近 5MB 文档大小）
```

### 5.3 5 分钟定位过程

**第 1 步：GC 日志识别 Humongous**

```bash
# 看 GC 日志中的 Humongous 标记
grep -E "Humongous|humongous" /data/log/gc.log | tail -20
# [16:00:15] GC(1235) [Humongous Allocation]  ← 关键标记
# [16:00:15] GC(1236) Pause Young (mixed) (G1 Evacuation Pause) (humongous)

# Humongous Object 的定义：
# - 对象大小 >= Region 大小 / 2 = 4MB / 2 = 2MB
# - 在 8GB 堆 + 4MB Region 下，2MB+ 对象就是 Humongous
# - 5MB 文档 > 2MB 阈值，被打成 Humongous Object

# jmap -histo 看 byte[]
jmap -histo:live $(pgrep -f message-archive) | head -10
#  num     #instances         #bytes  class name
#     1:       1500          5400000000  [B  ← 1500 个 byte[]，5.4GB
# -> 1500 个 byte[]（5MB 文档），占 5.4GB（67% Heap）
```

**第 2 步：根因 - 5MB 文档触发 Humongous**

```text
G1 Humongous Object 机制：
  - Heap 8GB / Region 4MB = 2048 个 Region
  - 每个 Region 4MB

Humongous Object 分配：
  - 对象 >= Region / 2 = 2MB -> Humongous
  - 5MB 文档 > 2MB -> Humongous
  - 分配在连续的多个 Region（5MB 文档占 2 个 Region）
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

**第 3 步：MongoDB Schema 分析**

```javascript
// 查 MongoDB 中 5MB 文档的占比
db.consult_message.aggregate([
  { $project: { size: { $bsonSize: "$$ROOT" } } },
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
// -> 8.5% 文档 > 2MB（触发 Humongous）

// 大文档都是包含图片 base64 的：
// {
//   "_id": "msg_xxx",
//   "content": "请看化验单",
//   "imageBase64": "data:image/jpeg;base64,/9j/4AAQSkZJRg...",  // 4MB+
//   "ocrResult": { ... }
// }
```

### 5.4 根因修复

**止血（立即）**：
```bash
# 扩容 +2 Pod
kubectl scale deployment message-archive --replicas=4
# 临时调大 G1 Region（让 5MB 文档不再 Humongous）
# -XX:G1HeapRegionSize=16m（5MB < 16MB / 2 = 8MB，不再 Humongous）
```

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
```

**PR 2：MongoDB Schema 优化 - 大文档拆分**

```javascript
// 坏 Schema：单文档包含图片 base64
db.consult_message.insertOne({
  _id: "msg_xxx",
  content: "请看化验单",
  imageBase64: "data:image/jpeg;base64,/9j/4AAQSkZJRg...",  // 4MB+
  ocrResult: { ... }
})
// -> 单文档 5MB，触发 Humongous

// 好 Schema：图片存 OSS，文档只存 URL
db.consult_message.insertOne({
  _id: "msg_xxx",
  content: "请看化验单",
  imageUrl: "oss://consult-message/msg_xxx.jpg",  // 只存 URL
  ocrResult: { ... }
})
// -> 单文档 200KB，不触发 Humongous
```

**PR 3：冷热分离 - 6 个月后归档 OSS**

```java
// 归档任务：每天凌晨归档 6 个月前的消息
@Scheduled(cron = "0 0 2 * * ?")
public void archiveOldMessages() {
    LocalDateTime sixMonthsAgo = LocalDateTime.now().minusMonths(6);
    
    try (MongoCursor<Document> cursor = mongoCollection
        .find(Filters.lt("createTime", sixMonthsAgo))
        .batchSize(100)
        .iterator()) {
        
        while (cursor.hasNext()) {
            Document doc = cursor.next();
            String ossKey = "archive/" + doc.getObjectId("_id") + ".json";
            ossClient.putObject(ossKey, doc.toJson());
            mongoCollection.deleteOne(Filters.eq("_id", doc.getObjectId("_id")));
        }
    }
}
```

### 5.5 量化收益

| 指标 | 修复前 | 修复后 | 改善 |
|------|--------|--------|------|
| Full GC 频率 | 1 次/分钟 | 0 次/分钟 | -100% |
| P99 RT | 2s | 50ms | -97% |
| Heap 使用 | 5.4GB | 2GB | -63% |
| MongoDB 单文档大小 | 5MB | 200KB | -96% |
| 存储成本 | MongoDB 7.6 亿条 | OSS 归档 6 个月前 | -40% |

### 5.6 面试追问点

1. **G1 Humongous Object 的触发条件？**
   - 对象大小 >= Region / 2
   - 8GB 堆默认 Region 4MB，2MB+ 对象就是 Humongous
   - Humongous 跨多个 Region，回收只能在 Full GC 或 Concurrent Marking 后

2. **G1 Region 大小如何选？**
   - 默认根据堆大小自动选（4GB 选 2MB，8GB 选 4MB，16GB 选 8MB）
   - 选择原则：Region 大小 > 业务最大对象大小 × 2
   - 业务最大对象 5MB -> Region >= 10MB -> 选 16MB

3. **MongoDB Schema 设计原则？**
   - 避免大文档（&lt; 1MB 最佳）
   - 图片 / 视频 / 大文本存 OSS，文档只存 URL
   - 大文档拆分为多条小文档（parentId 关联）
   - 冷热分离（6 个月前归档）

4. **冷热分离的实现方案？**
   - 热数据：MongoDB（6 个月内）
   - 冷数据：OSS + Hive 元数据（6 个月后）
   - 归档任务：每天凌晨执行
   - 查询时：先查 MongoDB，未命中查 OSS

5. **为什么 G1 Humongous 不能在 Young GC 回收？**
   - Humongous 跨多个 Region
   - Young GC 只回收 Young Region
   - Humongous 在 Old Region
   - 只能在 Full GC 或 Concurrent Marking 后回收

---

## 统一方法论：5 步法 + 6 节奏点

### 5 步法（适用于 CPU 高 / GC 频繁）

```text
第 1 步：top -Hp PID  →  找高 CPU 线程
第 2 步：printf "%x\n" TID  →  转 16 进制
第 3 步：jstack -l PID | grep -A 30 nid=0xHEX  →  过滤栈
第 4 步：分析栈帧定位代码
第 5 步：根因修复

适用：业务 CPU 高 / 死循环 / 锁竞争 / JIT CPU 高
不适用：GC CPU 高（要看 jmap -histo 而非 jstack）
```

### 6 节奏点（适用于 OOM / 内存泄漏）

```text
0:00-0:30  现象确认（Heap / Direct / Metaspace / RSS 哪个高）
0:30-1:00  止损决策（重启 / 摘流量 / 限流 / 降级）
1:00-2:00  抓现场（jstack + jmap dump + GC 日志三件套）
2:00-3:00  日志分析（GC 日志分类 + jmap -histo 看对象）
3:00-4:00  堆分析（MAT Dominator Tree + OQL）
4:00-5:00  根因止血（修复 + 监控 + 演练）
```

### 工具链组合选择

| 故障类型 | 工具链组合 |
|---------|----------|
| Heap OOM | 自动 dump + MAT + OQL + Dominator Tree |
| Direct OOM | NMT + Arthas heapdump + MAT + Allocation Record |
| GC CPU 高 | top -Hp + jmap -histo + Arthas vmtool + GC 日志 |
| Humongous | GC 日志 + jmap -histo + G1 Region 调参 |
| CPU 死循环 | top -Hp + jstack + async-profiler 火焰图 |
| JIT 退优化 | -XX:+PrintCompilation + JFR + 看代码分支 |

---

## JVM 调优参数模板（4 套生产配置）

### IM 网关

```bash
java \
  -Xmx4g -Xms4g \
  -XX:+UseG1GC -XX:MaxGCPauseMillis=100 \
  -XX:G1HeapRegionSize=4m -XX:InitiatingHeapOccupancyPercent=35 \
  -XX:G1ReservePercent=15 \
  -XX:MaxDirectMemorySize=2g \
  -Dio.netty.allocator.type=pooled -Dio.netty.maxDirectMemory=2g \
  -Dio.netty.leakDetection.level=SIMPLE \
  -XX:MetaspaceSize=256m -XX:MaxMetaspaceSize=512m \
  -XX:+TieredCompilation -XX:CompileThreshold=10000 \
  -XX:+UseContainerSupport -XX:InitialRAMPercentage=50.0 -XX:MaxRAMPercentage=50.0 \
  -XX:NativeMemoryTracking=summary \
  -Xlog:gc*:file=/data/log/gc.log:time,level,tags:filecount=10,filesize=100M \
  -XX:StartFlightRecording=duration=1h,filename=/data/jfr/recording.jfr,maxsize=200M \
  -XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/data/dump/ \
  -XX:OnOutOfMemoryError="kill -9 %p" \
  -jar im-gateway.jar
```

### 视频问诊 SFU

```bash
java \
  -Xmx8g -Xms8g \
  -XX:+UseG1GC -XX:MaxGCPauseMillis=50 \
  -XX:G1HeapRegionSize=8m -XX:InitiatingHeapOccupancyPercent=30 \
  -XX:G1ReservePercent=20 \
  -XX:MaxDirectMemorySize=4g \
  -XX:MetaspaceSize=256m -XX:MaxMetaspaceSize=512m \
  -XX:+TieredCompilation \
  -XX:+UseContainerSupport -XX:InitialRAMPercentage=50.0 -XX:MaxRAMPercentage=50.0 \
  -XX:NativeMemoryTracking=summary \
  -Xlog:gc*:file=/data/log/gc.log:time,level,tags:filecount=10,filesize=100M \
  -XX:StartFlightRecording=duration=1h,filename=/data/jfr/recording.jfr,maxsize=200M \
  -XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/data/dump/ \
  -XX:OnOutOfMemoryError="kill -9 %p" \
  -jar video-sfu.jar
```

### 监管上报

```bash
java \
  -Xmx6g -Xms6g \
  -XX:+UseG1GC -XX:MaxGCPauseMillis=200 \
  -XX:G1HeapRegionSize=4m -XX:InitiatingHeapOccupancyPercent=40 \
  -XX:G1ReservePercent=15 \
  -XX:MetaspaceSize=256m -XX:MaxMetaspaceSize=512m \
  -XX:+TieredCompilation \
  -XX:+UseContainerSupport -XX:InitialRAMPercentage=75.0 -XX:MaxRAMPercentage=75.0 \
  -Xlog:gc*:file=/data/log/gc.log:time,level,tags:filecount=10,filesize=100M \
  -XX:StartFlightRecording=duration=1h,filename=/data/jfr/recording.jfr,maxsize=200M \
  -XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/data/dump/ \
  -XX:OnOutOfMemoryError="kill -9 %p" \
  -jar regulator-report.jar
```

### 消息存档

```bash
java \
  -Xmx8g -Xms8g \
  -XX:+UseG1GC -XX:MaxGCPauseMillis=200 \
  -XX:G1HeapRegionSize=16m -XX:InitiatingHeapOccupancyPercent=35 \
  -XX:G1ReservePercent=15 \
  -XX:MetaspaceSize=256m -XX:MaxMetaspaceSize=512m \
  -XX:+TieredCompilation \
  -XX:+UseContainerSupport -XX:InitialRAMPercentage=50.0 -XX:MaxRAMPercentage=50.0 \
  -Xlog:gc*:file=/data/log/gc.log:time,level,tags:filecount=10,filesize=100M \
  -XX:StartFlightRecording=duration=1h,filename=/data/jfr/recording.jfr,maxsize=200M \
  -XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/data/dump/ \
  -XX:OnOutOfMemoryError="kill -9 %p" \
  -jar message-archive.jar
```

### 参数对比

| 服务 | Heap | Direct | G1 Region | IHOP | MaxGCPause | K8s limit |
|------|------|--------|----------|------|-----------|-----------|
| IM 网关 | 4g | 2g | 4m | 35% | 100ms | 8GB |
| 视频 SFU | 8g | 4g | 8m | 30% | 50ms | 16GB |
| 监管上报 | 6g | 0 | 4m | 40% | 200ms | 8GB |
| 消息存档 | 8g | 0 | 16m | 35% | 200ms | 16GB |

---

## 预防体系建设

### 监控告警（4 维度）

```text
维度 1：Heap
  - heap_used / heap_max > 80% 持续 1 分钟 -> P2 告警
  - heap_used / heap_max > 90% 持续 30 秒 -> P1 告警 + 主动 dump
  - Full GC > 1 次/分钟 -> P1 告警
  - Young GC > 10 次/分钟 -> P2 告警

维度 2：Direct Memory
  - direct_used / direct_max > 75% -> P2 告警
  - direct_used / direct_max > 90% -> P1 告警 + NMT 分析
  - DirectByteBuffer 实例数 > 5w -> P2 告警

维度 3：Metaspace
  - metaspace_used / metaspace_max > 80% -> P2 告警
  - 类加载数持续增长 -> P2 告警

维度 4：RSS（K8s 进程总内存）
  - rss / k8s_limit > 85% -> P2 告警
  - rss / k8s_limit > 95% -> P1 告警
  - OOMKilled 计数 > 0 -> P1 告警
```

### Code Review Checklist（10 条）

```text
1. 所有 Caffeine / Guava Cache 必须设 maximumSize + TTL
2. 所有 ThreadLocal 必须 try-finally remove
3. 所有监听器必须 @PreDestroy unregister
4. 所有静态 Map / List 必须用 Caffeine + maximumSize + TTL
5. 所有 ByteBuf 必须 release（用 SimpleChannelInboundHandler）
6. 不能用 finalize，改用 Cleaner / try-with-resources
7. 所有数据库连接 / 文件流必须 try-with-resources
8. 所有 Kafka / RocketMQ consumer 必须有 max.poll.records 限制
9. 所有定时任务必须有超时机制
10. 所有外部 HTTP 调用必须有连接池 + 超时
```

### 故障演练（每月一次）

```text
每月一次故障演练内容：
  1. 注入内存泄漏（Caffeine 没设 maximumSize）
  2. 注入 CPU 死循环（while(true) 无退出条件）
  3. 注入死锁（多个 synchronized 嵌套）
  4. 注入 Direct Memory 泄漏（ByteBuf 没 release）
  5. 注入 Full GC 频繁（大对象分配触发 Humongous）

演练流程：
  1. 注入故障（混沌工程工具）
  2. 团队 5 分钟定位
  3. 复盘 + 改进
  4. 沉淀 SOP
```

---

## 总结

5 个 JVM 故障案例覆盖了在线问诊系统核心服务的典型场景，沉淀出：

1. **统一方法论**：5 步法 + 6 节奏点 + 工具链组合选择
2. **参数模板库**：4 套生产配置（IM / 视频 / 监管 / 归档）
3. **预防体系**：4 维度监控 + 10 条 Code Review Checklist + 每月演练
4. **面试素材**：5 个完整 STAR 故事，可在面试中根据面试官兴趣选 2-3 个深讲

5 个案例的核心教训：

| 案例 | 核心教训 |
|------|---------|
| 案例一 | Direct Memory 是 K8s OOMKilled 的隐形杀手，必须 4 维度监控 |
| 案例二 | G1 Region 大小要匹配业务对象大小，IHOP 调低让并发标记更早启动 |
| 案例三 | 5 类泄漏模式必须背熟，幂等性应该用 Redis 而非 JVM Map |
| 案例四 | Caffeine 必须设 maximumSize，缓存调优是 JVM 调优的业务侧调优 |
| 案例五 | G1 Region 选型 + MongoDB Schema 优化 + 冷热分离是大对象场景的三大支柱 |
