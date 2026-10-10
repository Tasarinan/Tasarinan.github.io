# 架构师学习-Day04-Netty高性能原理

> 日期：2026年09月06日（周日）
> 周主题：网络编程与Netty专题 - 模型演进与epoll / 核心架构与线程模型 / 协议设计与编解码 / 高性能原理 / IM网关实战
> 出题日：Day04 - Netty 高性能原理

---

## 背景

Day01 埋了这条因果链：heap buffer 隐性拷贝 → direct 免拷贝 → direct 分配贵 → 池化 → 引用计数 → 泄漏检测。今天兑现它，并且把 Netty 高性能的另外几条主线（零拷贝、写路径优化背压、EventLoop 微优化）一次讲透。Day07 深挖日会在今天的内存池基础上继续下探源码与事故。

架构师面试官在这一层的问题都很"硬"：

> "Netty 为什么要自己搞内存池？JVM 的 GC 不是已经管内存了吗？"
> "`slice()` 出来的 ByteBuf，release 谁负责？`retainedSlice` 和 `slice` 差在哪？"
> "堆外内存泄漏，ResourceLeakDetector 的原理是什么？为什么生产只能用 SIMPLE？"
> "writeBufferWaterMark 的水位线背后，整条背压链路怎么传导到 TCP 的？"

**今日衔接点**：

- **Day01 因果链**（heap 隐性拷贝 / direct 分配贵 / Cleaner 延迟回收）→ PooledByteBufAllocator 的完整动机
- **JVM 第2周 Day05 堆外内存事故**（`-XX:MaxDirectMemorySize` / NMT / Cleaner）→ 今天从 Netty 侧再看一遍同一个问题，Day07 闭环
- **Day02 EventLoop 串行无锁** → MpscQueue / FastThreadLocal 的微优化
- **Day03 解码器 release** → 引用计数的所有权规则
- **K8s 周容器内存账** → 堆外内存预算 = 活跃连接 × 缓冲水位，OOMKilled 防线
- **简历项目 IM 在线客服** → "10w 连接网关的堆外内存预算怎么定"是量化叙事的核心题

---

## 题目一（Netty 高性能全解题）：Netty 高性能原理

请详细回答以下问题：

1. **PooledByteBufAllocator 内存池**：为什么需要池化（direct 分配/释放贵 + GC 不管堆外 + 每连接每消息都分配的频率）？jemalloc 的分层思想（Arena → Chunk → Page → Subpage）如何落到 Netty？分配路径（线程本地缓存 PoolThreadCache → arena（synchronized）→ chunk/subpage）？tiny/small/normal/huge 四档规格与 subpage 位图？池化参数与默认值（arena 数量 = 2×CPU、smallCacheSize/normalCacheSize）？
2. **引用计数与内存泄漏检测**：ReferenceCounted 的 retain/release 配对规则与"所有权"心智模型？入站消息的释放责任链（SimpleChannelInboundHandler 自动释放 / TailContext 兜底 / ByteToMessageDecoder 对未消费帧的处理）？ResourceLeakDetector 四级（DISABLED/SIMPLE/ADVANCED/PARANOID）原理（弱引用 + 采样 + record 访问记录）与各级开销？为什么生产只能 SIMPLE/ADVANCED 采样而 PARANOID 只能测试用？
3. **Netty 零拷贝五件套**：CompositeByteBuf（逻辑组合免物理拷贝）、slice/duplicate（共享底层存储）、retainedSlice（组合 retain）、FileRegion（transferTo）、gather write（writev 批量写）各自的机制与适用？slice 后两个 ByteBuf 的 release 归属规则？应用层零拷贝与内核零拷贝（sendfile/mmap）的分层关系？
4. **写路径与背压**：write → ChannelOutboundBuffer（Entry 链表 + unflushed/flushed 指针）→ flush → doWrite（批量 writev）的完整流程？"写多条消息一次 flush"为什么快？writeBufferWaterMark（默认 32KB/64KB）的高低水位语义与 isWritable / ChannelWritabilityChanged 事件？背压如何一路传导到 TCP 窗口（autoRead=false → 不再读 → 接收缓冲堆积 → 通告窗口收缩 → 对端减速）？
5. **EventLoop 微优化**：MpscQueue 为什么比 LinkedBlockingQueue 适合 Netty（锁竞争/伪共享/CAS 追加）？FastThreadLocal 数组下标直取？Recycler/ObjectPool 对象池复用哪些对象？ioRatio 的调优？堆外 ByteBuf 的业务侧访问成本（unsafe 跨界慢于堆内，所以"IO 边界 direct、业务处理尽快 POJO"）？
6. **架构师调优清单**：网关上线前后的 Netty 参数清单（SO_BACKLOG/TCP_NODELAY/水位/allocator/pool 参数）？必须建立的监控指标（池化内存用量、ChannelOutboundBuffer 深度、EventLoop 任务延迟、isWritable=false 连接数）？堆外内存预算公式（连接数 × 每连接缓冲上限 + 排队消息）与容器 memory limit 的关系？

### 作答区

#### 1. PooledByteBufAllocator 内存池

**为什么需要池化（动机三连）**：

1. **direct 分配贵**：`ByteBuffer.allocateDirect` 走 unsafe + 计数锁（`Bits.reserveMemory`），比堆内 TLAB 分配慢一个量级；超限时还会触发 `System.gc()`（JVM 堆外周的坑）
2. **GC 不管堆外**：DirectByteBuffer 靠 Cleaner 延迟释放——回收时机不可控，高吞吐下"待回收的堆外"堆积
3. **分配频率极高**：网关每条消息入站一个读缓冲、出站一个写缓冲——10w 连接 × 峰值每秒 10 条消息 = 每秒百万次量级的缓冲分配。**不池化，分配成本就是吞吐天花板**

结论：**池化的对象是"分配/释放"这个动作本身**——预申请大块（chunk），内部切分管理，用完归还池子而不是还给操作系统。

**jemalloc 分层（Netty 的老师）**：

```
PooledByteBufAllocator
 ├── directArenas ×（默认 2×CPU 核数）        ← 竞争摊薄：每个 arena 一把锁
 │    ├── PoolChunk（默认 16MB 量级，4.1 新版为 4MB：pageSize 8KB << maxOrder 9，
 │    │              旧版 16MB——报量级即可，分层结构不变）
 │    │     ├── Page（8KB）
 │    │     │     └── Subpage（按需等分：16B/32B/.../4KB，位图管理）
 │    │     └── PoolChunkList（qInit/q000/q025/q050/q075/q100 按使用率分带，分配时择带）
 │    └── PoolThreadCache（每线程本地缓存，分配快路径，无锁）
 │          ├── smallCache（默认 256 个/规格）
 │          └── normalCache（默认 64 个/规格，最大缓存 32KB 以下）
```

**四档规格**：

| 档位 | 大小 | 分配方式 |
|---|---|---|
| tiny | &lt;512B | subpage 位图（4.1 后期与 small 合并简化，思想不变） |
| small | 512B~8KB | subpage 位图 |
| normal | 8KB~16MB | chunk 内 page run（连续页） |
| huge | >16MB | 不池化，直接分配（大消息本来就不该常发） |

**分配路径（快 → 慢）**：

```java
// PooledByteBufAllocator.newDirectBuffer（简化）
buf = RECYCLER.get();                       // ① ByteBuf 对象本身也复用（对象池）
buf.init(...)                               // ② 定规格
// ③ PoolThreadCache.get(): 线程本地缓存同规格空闲块 → 命中即返回，全程无锁 ★ 快路径
// ④ 未命中 → arena.allocate()（arena 内 synchronized）:
//      normal → 沿 chunkList 找有空间的 chunk → chunk.allocHandle 分配 page run
//      small/tiny → 找有 subpage 空位的 page → 位图置位
// ⑤ arena 也没有 → 新建 chunk
```

**释放路径（对称）**：release 归还时优先进 **PoolThreadCache**（本线程下次直接复用）；cache 满/超规格才回 arena（chunk 使用率降到阈值以下时 chunk 跨带下沉，全部空闲可释放回操作系统）。

**关键认知**：①"多 arena + 线程本地缓存"是把一把大锁拆成 2×CPU 把小锁 + 大部分请求无锁——与并发周 LongAdder 分散热点同构；②**池化内存高水位不回落是正常的**（cache/arena 里存着备用块），这会干扰"泄漏判断"——Day07 的事故点之一。

#### 2. 引用计数与内存泄漏检测

**retain/release 配对规则（所有权心智模型）**：

```java
buf.retain();      // 引用 +1：我要长期持有（存 Map / 跨方法传递 / 广播扇出）
buf.release();     // 引用 -1：减到 0 → 归还池
// 铁律：谁 retain 谁 release；谁分配的（new/decode 出来的）谁负责第一条释放链
```

**入站消息的释放责任链（高频考点）**：

| 场景 | 谁释放 |
|---|---|
| decoder 分出的帧，业务 handler 消费后 | **业务 handler 释放**（或用 SimpleChannelInboundHandler，其 channelRead0 完成后自动 release） |
| 业务 handler 不处理、继续 fireChannelRead 传递 | 责任随消息传递，由下一个消费者释放 |
| 一路传到 Tail 没人处理 | **TailContext 兜底 release**（并打 DEBUG 日志） |
| decoder 产生的"半包残留"（连接断开时） | ByteToMessageDecoder 的 handlerRemoved/channelInactive 兜底释放 cumulation |
| 出站消息写到 ChannelOutboundBuffer 后真的发出 | 框架在写完成后释放 |
| 广播扇出 N 份（retainedDuplicate） | **每份各自 release**，少一份就泄漏（Day07 事故主角） |

**ResourceLeakDetector 原理**：

```java
// 池化 ByteBuf 创建/包装时（Simple 级，1/128 采样）：
if (leakDetector.track(buf) != null) {       // 用 WeakReference 包住 buf
    buf.记录创建栈;                          // record() 存访问点（ADVANCED 级更多）
}
// GC 发生时，弱引用进入引用队列且引用计数 > 0 = 没 release 就被丢 = 泄漏
// Reference Handler 线程发现后打印：
// "LEAK: ByteBuf.release() was not called before it's garbage-collected..."
```

| 级别 | 采样率 | 记录 | 开销 | 用途 |
|---|---|---|---|---|
| DISABLED | 0 | 无 | 0 | —— |
| SIMPLE（默认） | 1/128 | 创建点 | 很小 | 生产默认 |
| ADVANCED | 1/128 | 创建 + 各 touch 点 | 中 | 生产排查期 |
| PARANOID | **100%** | 全记录 | **巨大** | 测试/预发压测复现 |

**为什么生产只能采样**：PARANOID 对每个 ByteBuf 都建 WeakReference + 存栈（栈捕获是微秒级 × 百万次/秒 = 吞吐直接腰斩以上）。SIMPLE 的 1/128 采样是"低开销换早期发现"的工程折中——**泄漏是概率暴露、日志是采样触发，看到一条泄漏日志就意味着背后至少有 128 次泄漏事件**，必须立刻升级 ADVANCED 排查。

#### 3. Netty 零拷贝五件套

**内核零拷贝 vs 应用层零拷贝（先分层，Day01 已铺）**：

| 层 | 机制 | 拷贝消除点 |
|---|---|---|
| 内核态 | sendfile / transferTo（FileRegion） | 文件→socket 不进用户态（Kafka 消费拉取同款） |
| 内存映射 | mmap | 文件↔堆外映射（RocketMQ CommitLog 同款） |
| **应用层** | CompositeByteBuf / slice / duplicate / retainedSlice / writev | **用户态内的物理拷贝** |

**五件套逐个看**：

```java
// ① CompositeByteBuf：组合而不合并
CompositeByteBuf msg = ctx.alloc().compositeBuffer();
msg.addComponents(true, header, body);   // header + body 两块逻辑拼接，零物理拷贝
// 反例：单块 ByteBuf + copy(header)+copy(body) = 两次内存拷贝
// 场景：协议头与体分开生成后的拼装（Day03 的 16B 头 + Protobuf body）

// ② slice：共享底层存储的可读切片
ByteBuf body = frame.slice(16, frame.readableBytes() - 16);
// slice 只是"视图"：新建读写指针，底层内存与 frame 同一块
// ★ 不增加引用计数！frame.release() 后 body 就悬空了（use-after-free 风险）

// ③ retainedSlice：slice + retain 一步到位
ByteBuf body = frame.retainedSlice(16, len);   // 引用 +1，body 自己 release 一次是安全的

// ④ duplicate：整个缓冲的视图（不同于 slice：覆盖整个区间，仅指针独立）

// ⑤ gather write（writev）：ChannelOutboundBuffer 的 Entry 链表一次系统调用批量写出
// 配合 CompositeByteBuf：内核把多块内存一次发出（Day01 聚集写同款）
```

**slice 的 release 归属规则（事故级考点）**：

| 用法 | 归属 | 风险 |
|---|---|---|
| `slice()` 不 retain | 原 buf 的 owner 释放即全释放 | **下游还拿着 slice 用 = 读到已回收内存** |
| `retainedSlice()` | slice 自带 +1，下游用完必须 release | **忘 release = 引用永不归零 = 泄漏** |
| 广播 N 个连接 | 每连接 `retainedDuplicate()`（+1），各自写完自动释放 | **某条异常路径绕过写出 → 那份泄漏**（Day07） |

**一句话心智模型：slice 系列让"读视图"免费共享，但把"释放责任"变成显式契约——零拷贝节省的是 CPU 与带宽，支付的是所有权复杂度**。

#### 4. 写路径与背压

**write 不等于发送（高频误解）**：

```java
ctx.write(msg);    // 只是入队 + 指针操作：追加到 ChannelOutboundBuffer 的 Entry 链表
ctx.flush();       // 才真正触发 doWrite → channel 写系统调用（writev 批量）
ctx.writeAndFlush(msg); // = write + flush

// ChannelOutboundBuffer 内部：
//   unflushedEntries（已 write 未 flush）→ flush() 时整体搬到 flushedEntries
//   每 Entry 持有 ByteBuf + promise；写完成逐个回调 promise、释放 Entry
//   totalPendingSize 累计未写字节数 ★ 水位判断的依据
```

**"多条一次 flush"为什么快**：每个 Entry 一次 writev（一次系统调用批量写多块内存）比每条消息一次 write 少 N-1 次系统调用与用户态/内核态切换。**写吞吐优化的第一课：攒批**（与 MQ 周批量发送、Kafka 攒批 acks 同构）。

**水位线与背压链路**：

```java
// 默认 writeBufferWaterMark(32KB, 64KB)
// totalPendingSize > 64KB（高水位）→ channel.isWritable()=false → 触发 ChannelWritabilityChanged
// totalPendingSize 回落 < 32KB（低水位）→ isWritable()=true（回滞设计防抖动）
```

**背压的完整传导链（架构师必须会画）**：

```
对端消费慢（弱网客户端）
 → 本机内核发送缓冲堆积
 → write 系统调用写不进 → ChannelOutboundBuffer 的 Entry 堆积
 → totalPendingSize 超高水位 → isWritable()=false
 → 业务侧选择：
    a) 停止写入，等 WritabilityChanged 恢复（背压正确姿势）
    b) 更狠：channel.config().setAutoRead(false) → 不再从内核读
        → 本机接收缓冲堆积 → TCP 通告窗口收缩 → 对端发送减速 ★ 全链路到对端
    c) 不处理 → 堆积无限涨 → 堆外内存 OOM（Day06/Day07 的事故路径）
```

**架构师认知**：**背压的本质是把"下游慢"这个事实沿着链路反向传导到数据源头**。Netty 给了三层开关（isWritable 信号 / autoRead / 水位配置），但**不替你做策略**——降频、丢弃低优先级、断开，是业务决策（Day05 的慢消费者处置）。

#### 5. EventLoop 微优化

**MpscQueue vs LinkedBlockingQueue**：

| 维度 | LinkedBlockingQueue（两把锁） | MpscQueue |
|---|---|---|
| 锁 | takeLock + putLock（各 CAS/互斥） | 无锁：多生产者 CAS 尾追加，**单消费者免竞争出队** |
| 适配度 | 多生产多消费 | 恰好匹配"任意线程投递任务、只有 EventLoop 线程消费"的结构 |
| 伪共享 | —— | padding 缓存行填充（head/tail 不同核缓存行） |

**为什么不用 ConcurrentLinkedQueue**：它出队也要 CAS 竞争（支持多消费者），而 Netty 的消费端天然单线程——**Mpsc 把"必然单线程"的结构约束换成了更便宜的无锁算法**。这是"按访问模式选数据结构"的教科书案例（对照并发周容器选型）。

**FastThreadLocal（Day02 已铺）**：数组下标直取替代 ThreadLocalMap 开放寻址；`FastThreadLocalThread` 直接持有 map 字段。Netty 内部（allocator 的 PoolThreadCache、recycler）全用它——**框架先吃自己的狗粮**。

**Recycler/ObjectPool**：复用的不是内存是**对象头**（PooledByteBuf 实例、ChannelOutboundBuffer.Entry 等）——高频率创建的小对象（每条消息一个 Entry）复用可显著降低 GC 压力。规约：不透明的内部机制，业务别乱用（4.1 后期以 ObjectPool/清理器演进）。

**ioRatio（Day02 已铺）**：IO 与任务时间配比，默认 50。网关类（IO 重）保持默认；任务重（EventLoop 上有重计算——先自问为什么没移出 EventLoop）才调。

**direct 上做业务解析反而慢**：堆外 get/put 每次走 unsafe 跨界，比堆内指针访问慢。**正确姿势（Day01 口诀的落地）**：

```
入站：direct 读缓冲（IO 边界免拷贝）→ decoder 尽快解码成 POJO → 立刻 release 帧
出站：业务对象 → encoder 一次性序列化进 direct out → write
```

**"解码器尽早把字节变对象"不只是代码风格，是性能设计的必然**——direct 的价值只在"内核 ↔ 缓冲区"那一跳，不在业务层驻留。

#### 6. 架构师调优清单

**上线前参数清单**：

| 项 | 建议值/策略 | 依据 |
|---|---|---|
| transport | Linux 上 EpollEventLoopGroup（ET + SO_REUSEPORT + 免疫空轮询） | Day01 |
| SO_BACKLOG | 2048+（按 accept 速率 × 重连风暴余量） | 重连风暴时 accept 队列深度（Day06） |
| TCP_NODELAY | true（IM 低延迟） | 关 Nagle：小包立刻发（与 Day03 心跳配合） |
| childOption writeBufferWaterMark | 32KB/64KB 起步；按"单连接可容忍的堆积内存"定 | 高水位 = 单连接最大驻留 × 连接数 = 堆外预算 |
| allocator | PooledByteBufAllocator（默认即池化）；huge 消息限流 | 第 1 问 |
| MaxDirectMemorySize | 显式设置，纳入容器账 | JVM 堆外周 |
| ioRatio | 默认 50 | 第 5 问 |

**监控指标（四件套）**：

```
1. 池化堆外用量：PooledByteBufAllocator.metric()（usedDirectMemory/arena 分布）——容器内存账的主角
2. ChannelOutboundBuffer：每连接 pendingBytes（topN 慢消费者）+ 全局 isWritable=false 连接数
3. EventLoop：任务队列深度 / 排队延迟（execute 采样打点）——Day02 规约的执法依据
4. 连接指标：在线数、建立速率、断开速率、IdleState 踢除率
```

**堆外内存预算公式（容量叙事核心）**：

```
堆外高水位预算 ≈ 连接数 × (读缓冲 + 高水位 64KB) + 广播峰值 × 单消息大小 × 扇出系数
             + 解码累积余量
容器 memory limit ≥ 堆(-Xmx) + 元空间 + 堆外预算 + 线程栈(N×Xss) + code cache + 余量 20%
```

漏算堆外 = OOMKilled 候选（K8s 周结论在 Netty 网关的具体化）。**预算不是精确值，是水位红线：监控接近 80% 就扩容/限流，而不是等 OOM 教你做人**。

---

## 本日能力差距与补足方向

### 差距1：内存池只知道"有池子"

- **现状**：知道 Netty 有 PooledByteBufAllocator，讲不出 Arena/Chunk/Page/Subpage 分层、PoolThreadCache 快路径无锁、arena 内 synchronized 的锁粒度设计；"池化高水位不回落是正常的"这个运维常识没有
- **架构师水平**：画出分配路径图（cache → arena → 新 chunk），讲清"多 arena + 线程缓存"与 LongAdder 分散热点同构
- **补足方向**：读 PooledByteBufAllocator.newDirectBuffer 的调用链；Day07 深挖前先把这个骨架记住

### 差距2：引用计数规则没变成肌肉记忆

- **现状**：retain/release 知道要配对，但"入站消息释放责任链"（谁分配谁释放/传递即转移责任/Tail 兜底）讲不系统；SimpleChannelInboundHandler 自动释放的时机说不出
- **架构师水平**：任意 handler 场景秒答"这条 ByteBuf 谁释放"；广播 retainedDuplicate 的 N 份释放义务讲得清
- **补足方向**：把第 2 问责任链表抄进笔记；对照 Day03 解码器代码走一遍帧的生命周期

### 差距3：泄漏检测原理停留在"配个参数"

- **现状**：知道 `-Dio.netty.leakDetection.level`，说不出弱引用 + 引用队列 + 采样的机制；"SIMPLE 下看到一条日志 = 至少 128 次泄漏"的量化含义没有
- **架构师水平**：讲清 ResourceLeakDetector 的 WeakReference 生命周期，以及"为什么生产只能采样"的开销账
- **补足方向**：读 DefaultResourceLeak 源码入口；把"采样日志 → 升级 ADVANCED → 压测复现 → PARANOID"的排查流程写进预案

### 差距4：slice/retain 系列的所有权会算错

- **现状**：slice 与 retainedSlice 的区别、slice 后原 buf 释放的悬空风险、release 归属，三题混在一起就错
- **架构师水平**："slice 是免费视图但不持有引用；retainedSlice 持有就必须还"一句话定型；广播扇出的每份释放义务成清单
- **补足方向**：写一个单测分别验证 slice 悬空（expected IllegalReferenceCountException）与 retainedSlice 泄漏（PARANOID 触发日志）

### 差距5：背压链路画不到 TCP 窗口

- **现状**：知道 isWritable 和水位线，但"autoRead=false → 接收缓冲堆积 → 通告窗口收缩 → 对端减速"的完整传导画不全；水位线 32/64KB 该按什么定没有方法论
- **架构师水平**：从对端慢到源头减速的六步链路白板画出；水位线按"单连接可容忍驻留内存 × 连接数 = 堆外预算"反推
- **补足方向**：抓一次 tcpdump 看通告窗口收缩；把链路图写进网关设计文档（Day05/Day06 承接）

### 差距6：堆外内存预算与容器账串不起来

- **现状**：面试被问"10w 连接网关堆外要留多少"时给不出公式，也说不清它与 K8s memory limit、MaxDirectMemorySize 的关系
- **架构师水平**：预算公式 + 水位红线（80% 扩容）+ 监控指标（allocator metric）三件套张口就来
- **补足方向**：给 IM 在线客服按公式算一遍预算，写进简历项目的容量规划段（补 Day01 差距1 的作业）

---

## 附录：本日关键认知速查

| 认知点 | 关键结论 |
|---|---|
| 池化动机 | direct 分配贵（unsafe+计数锁+可能触发 System.gc）+ Cleaner 延迟释放 + 百万次/秒分配频率 |
| 分层 | Allocator → Arena(默认 2×CPU，arena 内一把锁) → Chunk(默认 4~16MB 量级) → Page(8KB) → Subpage(位图) |
| 快路径 | PoolThreadCache 线程本地缓存命中即无锁返回；smallCache 256 / normalCache 64 / 缓存上限 32KB |
| 四档规格 | tiny(&lt;512B)/small(≤8KB) subpage 位图；normal(≤chunk) page run；huge 不池化 |
| 池高水位 | cache/arena 存备用块，RSS 不回落是正常的——区别于泄漏（Day07） |
| 释放责任链 | 谁分配谁释放；fireChannelRead 转移责任；Tail 兜底；SimpleChannelInboundHandler 自动释放 |
| LeakDetector | WeakReference + 引用队列；SIMPLE/ADVANCED 采样 1/128，PARANOID 100% 仅测试 |
| 采样含义 | SIMPLE 下一条泄漏日志 = 背后至少 128 次泄漏事件 |
| 零拷贝五件套 | CompositeByteBuf 组合 / slice 视图 / retainedSlice 视图+引用 / duplicate / writev 批量 |
| slice 归属 | slice 不持有引用（原 buf 释放即悬空）；retainedSlice 必须 release；广播每份各还一次 |
| write≠发送 | write 只入队 ChannelOutboundBuffer；flush 才 writev；攒批少 N-1 次系统调用 |
| 水位线 | 默认 32KB/64KB 高低水位；高水位 isWritable=false；低水位恢复（回滞防抖） |
| 背压全链 | 堆积 → isWritable=false → autoRead=false → 接收缓冲涨 → TCP 窗口收缩 → 对端减速 |
| MpscQueue | 多生产者 CAS 追加 + 单消费者免竞争；按"必然单消费"的访问模式换更便宜的无锁 |
| direct 业务访问 | unsafe 跨界慢于堆内 → IO 边界 direct、尽快解码 POJO、立刻释放 |
| 堆外预算 | 连接数×(读缓冲+高水位) + 广播峰值×扇出 + 累积余量；计入容器 limit，80% 红线 |
