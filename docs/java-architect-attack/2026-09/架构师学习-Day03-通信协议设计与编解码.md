# 架构师学习-Day03-通信协议设计与编解码

> 日期：2026年09月05日（周六）
> 周主题：网络编程与Netty专题 - 模型演进与epoll / 核心架构与线程模型 / 协议设计与编解码 / 高性能原理 / IM网关实战
> 出题日：Day03 - 通信协议设计与编解码

---

## 背景

Day01 埋了一颗雷：**TCP 是字节流，没有消息边界**。一次 read 可能读到 0.5 条、1.7 条消息——粘包拆包。Day01 的 `compact()` 累积缓冲是地基，今天用 Netty 的解码器体系把这栋楼盖完。

协议设计是架构师面试里"区分背框架和做系统"的分水岭题，因为面试官可以直接拿你的简历项目问：

> "你 IM 在线客服的通信协议长什么样？字段为什么这么设计？为什么不用纯 JSON 文本？"
> "客户端版本从 1.0 升到 2.0，协议加了字段，老客户端还连着，怎么办？"
> "线上有人拿端口扫描器连你的网关随便发数据，你的协议怎么自保？"
> "`LengthFieldBasedFrameDecoder` 的 lengthAdjustment 到底怎么算？"

**今日衔接点**：

- **Day01 compact/半包** → ByteToMessageDecoder 的 cumulator 就是"自动 compact 的累积缓冲"
- **Day02 Pipeline 方向** → Decoder 是 inbound、Encoder 是 outbound，添加顺序由传播方向决定
- **MQ 周（协议设计）**：Kafka 的 RecordBatch、RocketMQ 的消息格式都是"定长头 + 变长体 + 校验"的同构设计
- **医疗周（HL7/FHIR）**：医疗领域标准协议的版本演进（HL7 v2 → FHIR）是"协议版本化"的极端案例
- **简历项目 IM 在线客服** → 自定义二进制协议 + WebSocket 承载 + 心跳保活，今天全部闭环

---

## 题目一（协议设计与编解码全解题）：通信协议设计与编解码

请详细回答以下问题：

1. **粘包拆包全解**：根因是什么（字节流无边界 / MSS 分段 / Nagle 合并 / 接收时机）？为什么 UDP 没有这个问题？四种解法（定长、分隔符、长度字段、上层协议自带边界）各自的适用场景与缺陷？Netty 对应的四个开箱解码器？
2. **LengthFieldBasedFrameDecoder 五参数精讲**：maxFrameLength / lengthFieldOffset / lengthFieldLength / lengthAdjustment / initialBytesToStrip 各自含义？三种典型配置（含长度域 / 不含长度域 / 长度含头）的参数推演？lengthAdjustment 的"补偿"本质？maxFrameLength 超限抛 TooLongFrameException 后的正确处理姿势？
3. **自定义 IM 协议设计**：设计一个 IM 二进制帧（magic / version / type / flags / seqId / length / body / checksum），每个字段的存在理由（magic 防误连、version 演进、length 上限防内存攻击、seqId 幂等去重）？编码器（MessageToByteEncoder）与解码器（继承 LengthFieldBasedFrameDecoder）的实现要点与常见 bug（长度占位回填、引用计数归属）？
4. **序列化选型**：JSON / Hessian2 / Kryo / Protobuf 五维对比（体积、速度、跨语言、兼容性、可读性）？字段演进的前向/后向兼容怎么做到（Protobuf 的 tag-unknown fields 机制 / JSON 的自然容错）？为什么 IM 推荐 Protobuf 而管理后台用 JSON 就够？
5. **心跳与空闲检测**：IdleStateHandler 的三种空闲（readerIdle / writerIdle / allIdle）？IM 心跳间隔怎么定（客户端 30s / 服务端 90s 的三倍容错原则）？心跳与 NAT 保活的关系？读空闲踢连接的完整流程与"假死连接"的危害？
6. **架构师视角：协议的版本演进与安全**：协议版本演进策略（version 字段 + 兼容矩阵 + 服务端向后兼容窗口）？协议安全四件套（magic 校验白名单 / 长度上限 / TLS / 鉴权首包）？WebSocket 二进制帧 vs 裸 TCP 自定义协议的选型（HTTP 语义成本、代理友好性、多路复用）？

### 作答区

#### 1. 粘包拆包全解

**根因剖析（四个来源）**：

1. **字节流无边界（本质）**：TCP 只承诺"字节按序到达"，不承诺"你 send 几次我就recv 几次"——发送端的 N 次 write 到接收端可能合成 1 次可读（粘包），也可能 1 次被拆成多次（拆包）。"包"从来不存在，存在的只是流
2. **MSS 分段**：发送大于 MSS（一般 1460B）的数据被 IP 层分段，接收端一次可读到多个分段或半个分段
3. **Nagle 合并**：小包合并发送（省带宽），多个逻辑消息挤进一个 TCP 段——IM 心跳+消息同发时常见
4. **接收时机**：应用层 buffer 里已有上次没读完的数据（Day01 compact 的场景），新数据与残留拼接

UDP 为什么没有：UDP 是**数据报文（datagram）**协议，每个报文有边界，sendto 几次 recvfrom 就几次（可能丢、可能乱序，但不会粘）。代价是 UDP 不保证可靠与顺序。**粘包拆包是"流式可靠传输"为达成目标而必须付出的结构代价，解法只能由应用层补齐：在字节流上重建消息边界**。

**四种解法与 Netty 对应解码器**：

| 解法 | 原理 | 适用 | 缺陷 | Netty 解码器 |
|---|---|---|---|---|
| 定长 | 每条消息固定长度，不足补齐 | 高频小报文（金融行情位） | 补齐浪费带宽；变长消息不可用 | FixedLengthFrameDecoder |
| 分隔符 | 特殊字符（\r\n）标记结尾 | 文本协议（Redis RESP、HTTP 头） | body 里含分隔符要转义；扫描成本 | DelimiterBasedFrameDecoder / LineBasedFrameDecoder |
| 长度字段 | 头里写明 body 长度 | **二进制协议主流（主流 MQ、RPC 全是）** | 需要头结构设计；恶意长度要防护 | **LengthFieldBasedFrameDecoder** |
| 上层自带边界 | HTTP 的 Content-Length/chunked | 直接采用成熟应用层协议 | 协议重 | HttpObjectDecoder 等 |

**选型口诀**：文本用分隔符、二进制用长度字段、报文天然定长用定长。**99% 的自研二进制协议都是"定长头 + 变长体"= 长度字段法**。

#### 2. LengthFieldBasedFrameDecoder 五参数精讲

**五参数含义**：

| 参数 | 含义 |
|---|---|
| maxFrameLength | 单帧最大长度，超过抛 TooLongFrameException（**内存攻击的第一道防线**） |
| lengthFieldOffset | 长度字段从第几字节开始（前面可能有 magic/version 等头） |
| lengthFieldLength | 长度字段本身几字节（1/2/3/4/8，决定单帧上限） |
| lengthAdjustment | **补偿值**：长度字段的值 + 补偿值 + lengthFieldOffset + lengthFieldLength = 整帧长度 |
| initialBytesToStrip | 解码后剥掉头部几字节（通常剥掉长度字段，或剥掉整个头） |

**三种典型配置推演**（背参数不如会推导，lengthAdjustment 的本质是"长度字段值没算进去的部分要补，多算了的部分要减"）：

```text
帧格式A：[长度2B(只算body)] [body]
  "HELLO" → 00 05 48 45 4C 4C 4F
  参数：offset=0, fieldLength=2, adjustment=0, strip=0
  推导：帧总长 = offset(0) + fieldLength(2) + length值(5) + adjustment(0) = 7 ✓

帧格式B：[magic2B][长度2B(只算body)][body] —— magic 也要算进总帧
  CA FE 00 05 "HELLO"
  参数：offset=2, fieldLength=2, adjustment=0, strip=0
  推导：总长 = 2(magic) + 2(长度) + 5(body) + 0 = 9
  ★ 若 strip=2：剥掉 magic，decoder 输出从长度字段开始（业务自己读magic就设0）

帧格式C：[长度4B(含整个帧自身的长度)] [body] —— 长度字段把"自己"也算进去了
  00 00 00 09 "HELLO"(5B) → 总帧 9B = 4(长度) + 5(body)，长度值9包含了长度字段自己
  参数：offset=0, fieldLength=4, adjustment=-4, strip=0
  推导：总长 = 0 + 4 + 9 + (-4) = 9 ✓
  ★ 多算的部分用负补偿扣回来
```

**lengthAdjustment 心法**：写一个恒等式 `帧总长 = lengthFieldOffset + lengthFieldLength + 长度字段值 + lengthAdjustment`，已知三个求第四个。**面试时当场推，比背三个 case 的参数更能证明理解**。

**TooLongFrameException 的正确处理**（衔接 Day02 异常处理）：

```java
@Override
public void exceptionCaught(ChannelHandlerContext ctx, Throwable cause) {
    if (cause instanceof TooLongFrameException) {
        // 恶意/异常长度：该连接的流状态已不可信，必须关闭，不能只丢帧
        //   抛出异常时解码器内部累积缓冲的处理不保证能继续正确分帧
        securityMetric.count("oversizedFrame", ctx.channel().remoteAddress());
        ctx.close();
    }
}
```

关键认知：**长度超限不是"这一帧坏了"，是"这条流的边界状态可能已错乱"**（长度字段是后续分帧的唯一依据，一个异常长度意味着后面所有字节的边界解释全部不可信）。所以原则是：**校验失败关连接，而不是跳过这帧**。同时 maxFrameLength 要略大于业务最大消息（如图片消息分片上限 1MB）+ 余量，避免正常大消息被误杀。

#### 3. 自定义 IM 协议设计与编解码实现

**帧结构设计（16B 定长头 + 变长体）**：

```
 0        2        3        4        5          8                12         16
+--------+--------+--------+--------+----------+----------------+-----------+------------+
| magic  |version | type   | flags  |  seqId   |   reserved     |  length   |   body...  |
| 0xCAFE |  1B    |  1B    |  1B    |   4B     |     4B         |    4B     |    N B     |
+--------+--------+--------+--------+----------+----------------+-----------+------------+
```

**每个字段的存在理由（架构师考点：没有理由的字段就是设计漏洞）**：

| 字段 | 理由 | 不设计的后果 |
|---|---|---|
| magic（2B，0xCAFE） | 快速识别"这是不是我的协议"——端口扫描器、误连的 HTTP 客户端第一字节就露馅 | 异常数据混入 pipeline 深处才报错，浪费解码 CPU，且错误信息难定位 |
| version（1B） | 协议演进的生命线：新增字段、改语义都靠它分流 | 新旧客户端混布时无法兼容（第 6 问展开） |
| type（1B） | AUTH=1 / HEARTBEAT=2 / MSG=3 / ACK=4 / NOTIFY=5，分发而非 body 里带字符串 | 分发在 header 层完成，未认证连接只允许 AUTH/HEARTBEAT 类型 |
| flags（1B） | 压缩位 / 加密位 / 分片位 / SYN-ACK 控制位 | 后续扩展全部要动帧结构 |
| seqId（4B） | 连接内单调递增：**ACK 关联、重发去重、幂等键**、消息顺序校验 | 丢消息无法感知、重发无法去重 |
| reserved（4B） | 预留（对齐到 16B 头，未来放 timestamp/checksum） | 需要新字段时无位可用 |
| length（4B） | body 长度（不含头）——分帧的唯一依据 + 上限防线 | 粘包拆包无法解决 |
| body | 序列化后的业务消息（Protobuf） | —— |

**编码器实现（MessageToByteEncoder&lt;Packet&gt;）**：

```java
public class PacketEncoder extends MessageToByteEncoder<Packet> {
    @Override
    protected void encode(ChannelHandlerContext ctx, Packet msg, ByteBuf out) {
        byte[] body = ProtobufCodec.encode(msg);          // ① 先序列化（长度才可知）
        out.writeShort(MAGIC);                            // ② magic
        out.writeByte(msg.getVersion());
        out.writeByte(msg.getType());
        out.writeByte(msg.getFlags());
        out.writeInt(msg.getSeqId());
        out.writeInt(0);                                  // ③ reserved
        out.writeInt(body.length);                        // ④ 长度字段
        out.writeBytes(body);                             // ⑤ body
        // ⑥ 千万不要 out.release() —— out 由框架管理（出站缓冲的传递，Day04 引用计数）
    }
}
```

要点：①**长度字段必须先占位后回填或先序列化再写**（序列化完才知道长度，所以 body 字节先备好）；②`MessageToByteEncoder` 的 out（出站 ByteBuf）由框架从 allocator 分配，**编码器不管分配不管释放**；③ encoder 应该 @Sharable（无状态）。

**解码器实现（继承 LengthFieldBasedFrameDecoder）**：

```java
public class PacketDecoder extends LengthFieldBasedFrameDecoder {
    public PacketDecoder() {
        // magic2 + version1 + type1 + flags1 + seq4 + reserved4 = 13B 头，length 在 offset=13
        super(MAX_FRAME /*1MB*/, 13, 4, 0, 0);   // 不剥离：整帧交给下游，业务要读头
    }
    @Override
    protected Object decode(ChannelHandlerContext ctx, ByteBuf in) throws Exception {
        // ① 前置校验：magic 不对 = 不是我的协议，立即断开（防扫描/误连）
        if (in.readableBytes() >= 2 && in.getShort(in.readerIndex()) != MAGIC) {
            ctx.close();
            return null;                          // 返回 null = 本轮没有完整帧
        }
        ByteBuf frame = (ByteBuf) super.decode(ctx, in);  // ② 父类完成分帧（含长度校验）
        if (frame == null) return null;           // 半包：等下一次数据（框架自动累积）
        try {
            short magic = frame.readShort();
            byte version = frame.readByte();
            byte type = frame.readByte();
            // ... 依次读出头字段
            byte[] body = new byte[frame.readInt()];
            frame.readBytes(body);
            return new Packet(version, type, seqId, ProtobufCodec.decode(type, body));
        } finally {
            frame.release();   // ③ 分出的帧用完立即释放（引用计数，Day04/Day07 深挖）
        }
    }
}
```

**三个常见 bug**：
1. **忘 release**：分出的 frame 是从池化 allocator 来的（引用计数 +1），读完不 release = 堆外泄漏（Day07 事故主角）
2. **半包时误关连接**：`in.readableBytes() >= 2` 的前置判断必须有——半包时可能只有 1 字节，读 magic 越界或误判
3. **decode 返回 POJO 但下游 handler 还想拿 ByteBuf**：帧的"所有权"在 decode 返回 POJO 时已释放，下游不能再引用 frame（要用就 copy 或改为传递 Packet 里带 ByteBuf 并明确所有权）

**ByteToMessageDecoder 的 cumulator 就是 Day01 compact 的自动化**：内部维护 `cumulation` 累积缓冲，每轮 `channelRead` 把新数据追加（`cumulator.cumulate`，扩容 + 拷贝，必要时用 CompositeByteBuf 减少拷贝），decode 循环调用直到返回 null（没有完整帧），**未消费数据留在 cumulation 里等下一次**——与 Day01 手写的 `compact + channel.read` 循环逻辑一一对应，只是框架代劳且处理了所有边界。

#### 4. 序列化选型

**五维对比**：

| 维度 | JSON | Hessian2 | Kryo | Protobuf | Protostuff |
|---|---|---|---|---|---|
| 体积（同消息） | 1x（基线） | ~0.5x | ~0.3x | **~0.25x** | ~0.25x |
| 序列化速度 | 慢（反射+字符串） | 中 | **快** | 快（生成代码） | 快 |
| 跨语言 | 全语言 | Java 生态为主 | Java only | **官方多语言** | Java only |
| Schema | 无（自描述） | 弱 | 无 | **强（.proto IDL）** | 无 |
| 字段兼容 | 天然容错（忽略未知） | 较好 | **差（跨版本有风险）** | **tag 机制，工业级** | 依赖 runtime |
| 可读性 | **好** | 无 | 无 | 无（需工具） | 无 |

**Protobuf 的字段演进机制（前向/后向兼容的核心）**：每个字段编码为 `tag << 3 | wire_type`。**老代码遇到新字段：不认识的 tag 走 unknown fields 保留/跳过，不报错**；新代码遇到老消息：缺失字段用默认值。规约：**只加字段不改语义、废弃字段保留 tag 号不复用、改类型必须新开字段**。这就是"协议版本演进"在序列化层的地基（第 6 问在帧级再讲一层）。

**IM 为什么推荐 Protobuf**：
1. **移动端流量/电量敏感**：消息体 1KB JSON 压到 250B，省流量即省用户成本
2. **多端（Android/iOS/Web/服务端）**：跨语言是硬需求，Kryo 出局
3. **协议演进频繁**：消息类型迭代快，tag 机制保证灰度期新旧版本共存
4. **编解码 CPU 成本低**：EventLoop 内做编解码（Day02 规约），越快对 EventLoop 越友好

**管理后台/内部 OpenAPI 用 JSON 就够**：可读性（联调 curl 直接看）、生态（无 schema 也能改字段）、流量成本不敏感——**选型的本质是约束匹配，不是技术优劣**。

#### 5. 心跳与空闲检测

**IdleStateHandler 三种空闲**：

| 类型 | 含义 | 典型用途 |
|---|---|---|
| readerIdleTime | N 秒没**读到**数据 | 服务端检测客户端假死（IM 主用） |
| writerIdleTime | N 秒没**写出**数据 | 客户端保活：没事也发个心跳防止 NAT 老化 |
| allIdleTime | 读或写都空闲 | 通用保活 |

**IM 的心跳设计（三倍容错原则）**：

```text
客户端：每 30s 发一次 HEARTBEAT（writerIdle 25s 触发：比 30s 略短，保证不断档）
服务端：readerIdle = 90s = 客户端间隔 × 3
  为什么 3 倍：容错一次网络抖动 + 一次丢包重传 + 一次 GC/调度延迟
  2 倍太敏感（一次抖动就误杀）、5 倍太迟钝（假死连接多占 2 分钟资源）
```

**心跳与 NAT 保活**：运营商/家用路由的 NAT 表项空闲超时（常见几分钟）会被回收，回收后连接单向死亡（客户端不知道，发消息才失败）。**客户端心跳的真正价值大半在"刷 NAT 表项"**，其次才是应用层活性检测。这也是"心跳包必须小"的原因（高频纯开销，2B 头即可，别带 body）。

**读空闲踢连接流程**：

```java
public class ServerIdleHandler extends ChannelInboundHandlerAdapter {
    @Override
    public void userEventTriggered(ChannelHandlerContext ctx, Object evt) {
        if (evt instanceof IdleStateEvent e && e.state() == IdleState.READER_IDLE) {
            sessionManager.offline(ctx.channel());   // 摘 Session、更新路由表
            ctx.close();                              // 释放 fd + 内核缓冲
        }
    }
}
// pipeline: addLast(new IdleStateHandler(90, 0, 0), new ServerIdleHandler())
```

**假死连接的危害账**（为什么必须踢）：一个假死连接 = 1 个 fd + 内核收发缓冲（几十 KB~MB）+ Session 对象 + 路由表条目，**且推送它的消息全部写进 ChannelOutboundBuffer 堆着**（Day04 背压问题）。10w 连接里 5% 假死 = 5000 个"僵尸成本"，还拉高推送延迟统计。**踢连接是容量卫生**。

#### 6. 架构师视角：协议版本演进与安全

**协议版本演进三层策略**：

1. **帧级 version 字段**：服务端收到不认识的 version → 回"版本不支持"错误帧 + 关闭（而不是硬解析）。灰度期服务端必须同时支持 N 和 N-1（**向后兼容窗口 ≥ 一个全量发布周期**）
2. **消息级 Protobuf tag 机制**：新增字段不改 tag、废弃保留、类型变更新开字段（第 4 问）
3. **能力协商**：AUTH 握手时客户端上报支持的 feature 集合（压缩算法、加密套件、消息类型版本），服务端按交集降级——把"版本判断"从每条消息一次收敛到连接建立一次

**协议安全四件套**：

| 防线 | 机制 | 防什么 |
|---|---|---|
| magic + 长度前置校验 | 第 3 问 decoder 里的两行前置判断 | 端口扫描器、误连的 HTTP/其他协议客户端——第一字节就断，省解码资源 |
| maxFrameLength | 超限关连接 | **恶意超长长度字段**（一个 4B 长度声明 2GB，无校验时解码器直接分配 2GB 堆外 = OOM 攻击） |
| TLS | 传输加密 + 证书双向校验 | 窃听、中间人、伪造客户端 |
| 鉴权首包 + 未认证限权 | 连接建立后第一条必须是 AUTH，且未认证连接的解码白名单只有 AUTH/HEARTBEAT 类型；认证超时（如 10s）自动断 | DoS：海量裸连接占 fd（未认证连接不许产生任何业务开销） |

**WebSocket vs 裸 TCP 自定义协议**：

| 维度 | WebSocket | 裸 TCP 自定义协议 |
|---|---|---|
| 浏览器支持 | **必须**（浏览器不能开裸 TCP） | 不可能 |
| 代理/网关友好 | 好（HTTP 升级，Nginx/LB 原生支持） | 差（中间盒可能掐长连接、需透传配置） |
| 语义成本 | 多一层帧封装（opcode/mask/payload len），二进制帧内仍需自定义应用协议 | 无 |
| 适用 | ToC（Web/App 混合）、IM 在线客服 | ToB 内网、性能极致的接入层 |

**实践结论**：Web 端必须 WebSocket；原生 App（Android/iOS）可走裸 TCP；**统一方案是"WebSocket 帧承载自定义二进制协议"**（ws 二进制帧的 payload 就是第 3 问的帧结构）——一套编解码、两种传输。这也呼应 Day01 第 6 问的选型：WebSocket 主推 + 长轮询降级。

---

## 本日能力差距与补足方向

### 差距1：粘包拆包"知道有"但讲不出根因层次

- **现状**：会说"TCP 粘包要处理"，但四层根因（字节流无边界/MSS/Nagle/接收时机）讲不全，"UDP 为什么没有"答不出"数据报文有边界 vs 流无边界"的本质
- **架构师水平**：从 TCP 的设计目标（流式可靠）推出"边界必须应用层重建"的必然性，而不是把它当 TCP 的 bug
- **补足方向**：把"TCP 没有粘包问题，它只有字节流；问题在你把流当消息用"这句话内化，能讲清因果

### 差距2：lengthAdjustment 靠背参数，不会现场推导

- **现状**：LengthFieldBasedFrameDecoder 五参数背过，换个头结构就算不准；"长度含头"场景不知道要用负补偿
- **架构师水平**：用恒等式"帧总长 = offset + fieldLength + 长度值 + adjustment"现场推任意头结构
- **补足方向**：自己设计三个畸形头结构做推导练习；把恒等式写进笔记

### 差距3：协议字段"抄来的"说不出存在理由

- **现状**：帧结构画得出，但 magic/version/seqId 每个字段"为什么存在"答不严——magic 防误连、length 上限防 OOM 攻击、seqId 幂等去重这些理由链条断裂
- **架构师水平**：每个字段一句存在理由 + 不设计的后果；能按业务（IM/推送/RPC）裁剪字段
- **补足方向**：给 IM 在线客服的协议每个字段写一行"删掉它会怎样"，作为面试话术

### 差距4：序列化选型缺乏量化与场景匹配叙事

- **现状**：知道 Protobuf 小，但说不出小多少（JSON 的 1/4）、快在哪（生成代码 vs 反射）、兼容靠什么（tag + unknown fields）；Kryo 的跨版本兼容风险不知道
- **架构师水平**：五维对比表脱口而出，并按约束（多端？流量敏感？演进频繁？）匹配选型，而不是无脑 Protobuf
- **补足方向**：用同一个消息对象实测 JSON/Protobuf 的体积与编解码耗时，拿到自己的数字

### 差距5：心跳参数没有"为什么"

- **现状**：答"配了 IdleStateHandler"，但 30s/90s 的三倍容错原则、心跳防 NAT 老化的真实价值、假死连接的成本账讲不出
- **架构师水平**：从 NAT 表项超时、GC 停顿、网络抖动的量级推导心跳参数；把踢连接讲成"容量卫生"
- **补足方向**：查证运营商 NAT 超时的典型值（1~5 分钟）；把假死连接成本账（fd+缓冲+Session+路由条目+堆积消息）写全

### 差距6：协议安全只想到 TLS

- **现状**：协议安全 = 加密，漏了 magic 前置校验（防扫描）、maxFrameLength（防恶意长度 OOM）、鉴权首包 + 未认证限权（防海量裸连接 DoS）这三件更基础的
- **架构师水平**：按"资源消耗路径"设计防线——每个字节进来消耗什么（解析 CPU/内存/状态），哪里是最便宜的拦截点（第一字节）
- **补足方向**：把安全四件套与"未认证连接零业务开销"原则写进网关设计文档（Day05 承接）

---

## 附录：本日关键认知速查

| 认知点 | 关键结论 |
|---|---|
| 粘包本质 | TCP 是流没有边界；"包"是应用层概念，边界必须应用层重建 |
| 四解法 | 定长 / 分隔符（文本）/ 长度字段（二进制主流）/ 上层协议 |
| 五参数恒等式 | 帧总长 = lengthFieldOffset + lengthFieldLength + 长度值 + lengthAdjustment |
| 长度含头 | adjustment 为负（长度值多算了长度字段自身） |
| TooLongFrameException | 流状态已不可信 → 关连接，不能只丢帧；maxFrameLength > 业务最大消息 + 余量 |
| 帧结构 16B | magic(2) version(1) type(1) flags(1) seqId(4) reserved(4) length(4) + body |
| magic 价值 | 第一字节识别非本协议 → 立即断，防扫描器/误连，最便宜的拦截点 |
| length 防线 | 无 maxFrameLength 校验时，4B 声明 2GB = 直接 OOM 攻击 |
| encoder 规则 | 先序列化再写长度；out 由框架管，不分配不释放；@Sharable |
| decoder 三 bug | 忘 release（泄漏）/ 半包时越界读 magic / 帧所有权转移给 POJO 后下游再引用 |
| cumulator | ByteToMessageDecoder 的累积缓冲 = Day01 compact 的框架化 |
| Protobuf 体积 | 约为 JSON 的 1/4；编解码是生成代码非反射 |
| Protobuf 兼容 | tag + unknown fields；只加不改不复用 tag |
| 心跳三倍 | 客户端 30s / 服务端 readerIdle 90s（容一次抖动+一次丢包+一次调度延迟） |
| 心跳真价值 | 大半在刷 NAT 表项（常见 1~5 分钟超时），其次才是活性检测 |
| 假死连接成本 | fd + 内核缓冲 + Session + 路由条目 + 堆积的推送消息 |
| 安全四件套 | magic 校验 / 长度上限 / TLS / 鉴权首包 + 未认证零业务开销 |
| WS vs TCP | 浏览器必须 WS；统一方案 = WS 二进制帧承载自定义协议（一套编解码两种传输） |
