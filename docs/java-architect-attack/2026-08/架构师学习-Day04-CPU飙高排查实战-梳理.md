# 架构师学习-Day04-CPU 飙高排查实战-梳理

> 日期：2026年08月06日（周四）
> 周主题：JVM 专题第 2 周 - 调优实战与生产排查
> 梳理日：Day04 - 架构师视角梳理

---

## 一、架构师视角下的 CPU 飙高排查

### 1.1 不只是"会 5 步法"，是"分类 + 工具链 + 副作用"的体系

很多工程师把 CPU 飙高排查等同于"5 步法（top -Hp + jstack）"，结果就是"命令会用了但生产事故还是定位不出来"。架构师视角下，CPU 飙高排查是**体系化工程**：

| 架构决策 | 受 CPU 排查能力约束的具体点 |
|---------|--------------------------|
| 故障排查 SLA（5 分钟定位 vs 30 分钟定位） | 5 步法熟练度 + 工具链预置 |
| K8s 部署形态（是否需要 Arthas sidecar） | 容器内工具链可用性（jstack / jcmd 权限） |
| 监控告警体系 | 是否有 CPU 维度告警 + NioEventLoop 告警 |
| JIT 与预热方案 | 是否理解 JIT 退优化风险 + 预热脚本设计 |
| Safepoint 风险评估 | 大循环代码评审 + Safepoint 监控 |
| 团队故障排查能力 | 是否有 CPU 故障知识库 + 演练机制 |

如果只停留在"会 5 步法"，团队整体故障排查能力就上不去。**架构师的责任是把 CPU 排查变成团队能力**。

### 1.2 CPU 飙高排查的本质：先分类，再排查

CPU 飙高不是单一现象，而是 6 种不同类型问题的统称：

| 类型 | 占比 | 难度 | 工具链 |
|------|------|------|--------|
| **业务 CPU 高** | 40% | 中 | 5 步法 + 火焰图 |
| **GC CPU 高** | 25% | 中 | jstat + GC 日志 + MAT |
| **死循环 CPU 高** | 10% | 易 | 5 步法（连续 3 次） |
| **锁竞争 CPU 高** | 10% | 中 | jstack + Arthas thread -b |
| **JIT 编译 CPU 高** | 5% | 难 | PrintCompilation + JFR |
| **Native CPU 高** | 5% | 难 | async-profiler + perf |
| **复合型（多种叠加）** | 5% | 极难 | 多工具联动 |

**架构师思维**：

```
普通工程师：看到 CPU 高就 jstack，抓不到就重启
高级工程师：会 5 步法 + 火焰图，能定位 80% 问题
架构师：先分类（30 秒），再用对应工具链深挖；能识别 JIT 退优化和 Safepoint 这种高阶问题
```

**关键认知**：6 种类型中，**JIT 退优化和 Safepoint 是架构师与高级工程师的分水岭**。80% 的工程师不知道 JIT 退优化会引发 CPU 飙高，90% 的工程师不知道 jstack 会触发 Safepoint。

### 1.3 CPU 排查工具链的副作用

CPU 排查工具不是免费的，每个工具都有副作用。架构师必须**精确掌握每个工具的代价**：

| 工具 | 副作用 | 何时不能用 | 替代方案 |
|------|--------|-----------|---------|
| `top -Hp` | 极低 | 容器内可能不显示线程 | `/proc/PID/task` 遍历 |
| `jstack` | 触发 Safepoint，10w 线程可能 STW 5 秒 | 大型应用高峰期 | `jcmd Thread.print`（JDK 11+ async walk） |
| `jstack -F` | 强制连接，进程挂起 | 流量未摘除时 | 普通 jstack -l |
| `jstack -m` | 混合模式，很慢 | 日常诊断 | 仅 JNI 死锁时用 |
| `Arthas thread -n N` | 5 秒采样，开销中等 | 高 QPS 时长挂 | 用 `dashboard` 替代 |
| `Arthas trace` | 每次调用都计时，开销线性增长 | 高 QPS 接口长时间挂 | `trace -n 5` + `#cost > N` |
| `async-profiler cpu` | &lt; 1% 开销 | 极少禁用 | 生产长开 |
| `async-profiler wall` | 采样所有线程，数据量大 | 大型应用慎用 | 仅 IO 密集场景 |
| `JFR` | &lt; 1% 开销 | 极少禁用 | 生产长开 |
| `kill -3` | 触发 Safepoint + 栈打到 stdout | 大型应用高峰期 | jstack 替代 |

**架构师经验**：

1. **jstack 在 10w+ 线程应用上有副作用**：触发 Safepoint，可能引发 1-5 秒 STW
2. **JDK 11+ 用 jcmd Thread.print 替代 jstack**：默认 async walk，不触发 Safepoint
3. **async-profiler 是生产首选**：开销 &lt; 1%，能看 native 栈，能出火焰图
4. **JFR 长开是"飞机黑匣子"**：故障时直接拉 JFR，不用现场抓

### 1.4 CPU 飙高与版本演进：JDK 8 -> 11 -> 17 的差异

JVM CPU 排查能力与 JDK 版本深度绑定：

| 能力 | JDK 8 | JDK 11 | JDK 17 |
|------|-------|--------|--------|
| `jstack` 触发 Safepoint | 是 | 是 | 是 |
| `jcmd Thread.print` async walk | 否 | 是 | 是 |
| JFR（持续录制） | 商业特性（需解锁） | 开源免费 | 开源免费 |
| async-profiler | 支持 | 支持 | 支持 |
| AppCDS（减少类加载） | 实验性 | 改进 | 稳定 |
| AOT 编译（jaotc） | 无 | 实验性 | 实验性 |
| Thread Local Handshakes（JEP 312） | 无 | 是 | 是 |
| ZGC concurrent stack scan（JEP 376） | 无 | 无 | 是 |
| 偏向锁（Biased Locking） | 默认开启 | 默认开启 | JDK 15 废弃 |

**JDK 升级对 CPU 排查的影响**：

1. **JDK 11+ jcmd Thread.print 不触发 Safepoint**：大型应用 jstack 副作用大幅减少
2. **JDK 11+ JFR 开源**：免费使用，生产长开成为可能
3. **JDK 17 Thread Local Handshakes**：偏向锁撤销等不需要全局 Safepoint
4. **JDK 17 ZGC concurrent stack scan**：ZGC 不再依赖 Safepoint 扫栈
5. **JDK 17 废弃偏向锁**：减少 Safepoint 触发频率

**架构师做 JDK 升级的 CPU 排查决策**：

1. **优先升级到 JDK 17**：解决 Safepoint / JIT 退优化的大部分痛点
2. **JFR 长开**：JDK 11+ 必须，OOM / CPU 飙高时自动留下"黑匣子"
3. **替换 jstack 为 jcmd Thread.print**：JDK 11+ 推荐用法
4. **测试 ZGC**：JDK 17 分代 ZGC，&lt; 1ms 停顿

### 1.5 CPU 飙高与可观测性建设

CPU 排查是可观测性体系的应用层。架构师视角下，可观测性是金字塔：

```
                    ┌──────────────────┐
                    │   故障自愈        │  顶 - 自动化
                    │  （auto-remediation）│
                    └──────────────────┘
                  ┌──────────────────────┐
                  │   根因定位           │  上 - 工具链
                  │  （5 步法 + 火焰图）  │
                  └──────────────────────┘
                ┌──────────────────────────┐
                │   告警与排查              │  中 - 监控
                │  （Prometheus + JVM Exporter）│
                └──────────────────────────┘
              ┌──────────────────────────────┐
              │   指标采集                   │  下 - 数据
              │  （CPU / GC / 线程 / Safepoint）│
              └──────────────────────────────┘
            ┌──────────────────────────────────┐
            │   应用埋点                       │  基 - 业务
            │  （QPS / RT / 错误率 / 资源使用）  │
            └──────────────────────────────────┘
```

**架构师责任**：

1. **底层埋点**：CPU / 内存 / GC / 线程 / Safepoint 指标采集
2. **指标采集**：JVM Exporter + Node Exporter + 业务埋点
3. **告警体系**：CPU > 70% / NioEventLoop CPU > 50% / GC CPU > 30% / Safepoint sync > 100ms
4. **工具链就绪**：Arthas sidecar + JFR 长开 + async-profiler 预装
5. **故障自愈**：CPU > 90% 自动扩容 / 自动摘流量

**关键认知**：CPU 飙高不是"出事才查"，而是"平时就绪"。Arthas sidecar、JFR 持续录制、async-profiler 预装，都要在平时配置好。

---

## 二、CPU 飙高排查的三大核心场景

### 2.1 场景一：业务 CPU 高 - 5 步法 + 火焰图

**典型现象**：单接口 RT 高，QPS 涨或不变，CPU 持续 80%+。

**架构师视角的排查链路**：

```
第 1 步（30 秒）：top -Hp 看高 CPU 线程名
  ├─ http-nio-8080-exec-* -> Tomcat 业务线程
  ├─ nioEventLoopGroup-* -> Netty 业务线程
  ├─ DubboServerHandler-* -> Dubbo 业务线程
  └─ pool-N-thread-* -> 通用线程池（看 setName）

第 2 步（30 秒）：jstack 抓栈（连续 3 次，间隔 2 秒）
  ├─ 栈顶是业务方法 -> 业务 CPU 高
  ├─ 多次同一行 -> 死循环
  └─ 栈顶是 native -> Native CPU 高

第 3 步（2 分钟）：async-profiler 火焰图（采样 60 秒）
  ├─ 宽且尖 -> 单一热点
  ├─ 宽且平 -> 多方法均匀分散
  └─ 大量 GC 帧 -> GC CPU 高（误判）

第 4 步（1 分钟）：定位代码 + 算法优化
  ├─ O(n²) 循环 -> 改算法 / 加索引
  ├─ 序列化 -> 换库 / 流式
  └─ 正则 -> 预编译 / 换匹配方式

第 5 步（30 秒）：止血 + 修复
  ├─ 临时：限流 / 扩容
  └─ 根因：PR 修复
```

**典型业务 CPU 高场景**：

| 场景 | 案例 | 火焰图特征 | 优化方向 |
|------|------|----------|---------|
| **算法复杂度高** | 医保结算 3 万规则匹配 O(n) | RuleEngine.match 占 70% | 加索引（Map&lt;ICD10, List&lt;Rule>>） |
| **JSON 序列化** | 大对象 JSON.toString | Jackson serialize 占 50% | 换 Jackson Afterburner / Protobuf |
| **正则回溯** | 贪婪匹配 + 大输入 | Pattern.matches 占 80% | 预编译 Pattern / 换 indexOf |
| **批量计算** | 支付对账 100w 条 | BankReconcile.compare 占 60% | 并行化 / 分批 |
| **加密哈希** | BCrypt 调用频繁 | BCrypt.hash 占 40% | 缓存 / 改 PBKDF2 |

**生产实战经验**：

1. **5 步法的第一步是看线程名**：好的工程习惯是给线程池起名字（`ThreadFactoryBuilder.setNameFormat`）
2. **连续抓 3 次 jstack**：单次快照可能误判
3. **火焰图必看 60 秒以上**：短采样统计意义不大
4. **业务 CPU 高的根因往往是算法**：换硬件 / 加机器是治标不治本

### 2.2 场景二：GC CPU 高 - 内存调优联动

**典型现象**：CPU 高但根因是内存问题，GC 线程占 50%+ CPU。

**架构师视角的 GC CPU 高排查**：

```
GC CPU 高 = 内存问题 + CPU 维度
   │
   ▼
jstat -gcutil PID 1000 10
   │
   ├─ O 列 > 85% -> 老年代膨胀
   ├─ FGC 涨 -> Full GC 频繁
   ├─ YGC 涨快 -> Young GC 频繁
   └─ GCT 涨快 -> GC 时间长

   │
   ▼
GC 日志分析
   │
   ├─ Allocation Failure -> 老年代分配失败
   ├─ Humongous Allocation -> 大对象 > Region/2
   ├─ Metadata GC Threshold -> Metaspace 满
   ├─ System.gc -> 显式调用
   └─ to-space exhausted -> 疏散失败

   │
   ▼
jmap dump + MAT 分析
   │
   ├─ byte[] Retained 大 -> 大对象 / 文件未关闭
   ├─ HashMap Retained 大 -> 缓存未设上限
   ├─ Caffeine BoundedLocalCache 大 -> maximumSize 配置错误
   └─ ThreadLocalMap 大 -> ThreadLocal 未 remove
```

**GC CPU 高的典型场景**：

| 场景 | GC 表现 | CPU 表现 | 根因 |
|------|--------|---------|------|
| **缓存膨胀** | Full GC 频繁 | GC 线程占 70% | Caffeine maximumSize 错误 |
| **大对象** | Humongous Allocation | GC 线程占 50% | MongoDB 大文档 / 大 byte[] |
| **内存泄漏** | Full GC 不回收 | GC 线程占 60% | 静态 Map 无限增长 |
| **Metaspace 满** | Metadata GC Threshold | GC 线程占 30% | CGLIB 动态生成类 |
| **过早晋升** | Mixed GC 频繁 | GC 线程占 40% | Survivor 太小 |

**生产实战 - 问诊订单缓存 100w Key**：

```
现象：
  - CPU 持续 80%，堆 92%，Full GC 1次/分钟
  - jstack 看 GC Thread 占 70% CPU

排查：
  1. jstat -gcutil: O 列 88%，FGC 涨 1次/秒
  2. jmap dump + MAT: OrderEntity 100w 占 4.2GB
  3. Arthas vmtool 查 Caffeine: estimatedSize = 100w

根因：Caffeine maximumSize 配置错误（设了 100w，应该 1w）
修复：maximumSize 改 10000 + expireAfterWrite=10min
效果：CPU 立即降到 15%
```

**架构师经验**：

1. **GC CPU 高的根因在内存**：调 GC 参数治标不治本
2. **第一步看 jstat -gcutil**：30 秒确认是 GC CPU 高
3. **第二步看 GC 日志**：判断是哪类 GC 问题（Full GC / Humongous / Metaspace）
4. **第三步 jmap dump + MAT**：定位具体元凶对象

### 2.3 场景三：JIT 与 Safepoint 高阶问题

**典型现象**：CPU 高但 jstack 看不出明显业务热点，可能伴随接口偶发慢。

**JIT 退优化的火焰图特征**：

```
┌──────────────────────────────────────────────┐
│ C2 CompilerThread                            │  ← 占 30-50%
│ ├──────────────────────────────────────      │
│ │ compile method                             │
│ │ ├─────────────────                         │
│ │ │ optimize                                 │
│ │ ├─────────────────                         │
│ │ │ CompileBroker::compile                   │
└──────────────────────────────────────────────┘
```

**Safepoint 慢的现象**：

```
-XX:+PrintSafepointStatistics 输出：
  Total time for application threads to stop: 5234 ms  ← 长！
  Stopping threads took: 5200 ms  ← sync time 长，有线程阻挡
```

**JIT 退优化与 Safepoint 的排查清单**：

```text
JIT 退优化排查：
□ 是否开启 -XX:+PrintCompilation 或 -Xlog:codegen？
□ 是否有大量 "made not entrant" 标记？
□ 是否有 C2 CompilerThread CPU 占比高？
□ 代码是否有 if-else 分支比例抖动？
□ 是否用 SPI / 反射加载新类？
□ 是否有异常控制流（异常风暴）？

Safepoint 排查：
□ 是否开启 -Xlog:safepoint？
□ Safepoint sync time 是否 > 100ms？
□ 是否有线程阻挡 Safepoint（SafepointTimeout 告警）？
□ 元凶线程是否在长循环 / Native 调用？
□ 是否需要 Thread.onSpinWait() 加 Safepoint 轮询点？
```

**JIT 退优化的代码反模式**：

```java
// 反模式 1：if-else 分支抖动
if (msg.type == MessageType.NORMAL) {  // 95%
    handleNormal(msg);
} else if (msg.type == MessageType.SPECIAL) {  // 5%，但突发时变 30%
    handleSpecial(msg);  // uncommon trap！
}

// 反模式 2：异常控制流
try {
    parseJson(input);  // C2 假设不抛异常
} catch (ParseException e) {
    handleParseError(input);  // 异常风暴触发退优化
}

// 反模式 3：SPI 动态加载
ServiceLoader<Handler> loader = ServiceLoader.load(Handler.class);
for (Handler h : loader) {  // 每次循环可能加载新类
    h.handle(msg);  // inline 假设失效
}

// 改进：用稳定的虚调用 / Map 分发
private static final Map<MessageType, Consumer<Message>> HANDLERS = Map.of(
    MessageType.NORMAL, Handler::handleNormal,
    MessageType.SPECIAL, Handler::handleSpecial
);
public void dispatch(Message msg) {
    HANDLERS.get(msg.type).accept(msg);  // C2 友好
}
```

**Safepoint 慢的代码反模式**：

```java
// 反模式 1：长循环无 Safepoint 轮询点
for (int i = 0; i < Integer.MAX_VALUE; i++) {
    count++;  // 简单计算，无 Safepoint 轮询点
}

// 反模式 2：10w 连接的批量检查
for (int i = 0; i < connections.size(); i++) {  // 10w 次
    checkConnection(connections.get(i));  // 简单计算
}

// 改进 1：加 Safepoint 轮询点
for (int i = 0; i < BIG; i++) {
    count++;
    if ((i & 0xFF) == 0) {  // 每 256 次轮询一次
        Thread.onSpinWait();
    }
}

// 改进 2：分批处理
for (int i = 0; i < connections.size(); i += 1000) {
    int end = Math.min(i + 1000, connections.size());
    for (int j = i; j < end; j++) {
        checkConnection(connections.get(j));
    }
    Thread.yield();  // 让出 CPU + Safepoint 轮询
}
```

**生产实战经验**：

1. **JIT 退优化在 JDK 11+ 增强诊断**：JFR + JMC 能可视化编译历史
2. **Safepoint 慢的元凶线程要靠 SafepointTimeout 告警**：`-XX:+SafepointTimeout -XX:SafepointTimeoutDelay=1000`
3. **大循环 + 简单计算 = Safepoint 杀手**：必须加轮询点
4. **JDK 17 减少 Safepoint 依赖**：升级是根本解决方案

---

## 三、生产事故排查的方法论

### 3.1 CPU 飙高 5 分钟定位法

**架构师视角的"5 分钟"是节奏感，不是死规定**：

```
0:00-0:30  现象确认 - 看监控、确认影响范围、分类（业务 / GC / JIT / 锁 / 死循环 / Native）
0:30-1:00  止损决策 - 摘流量 / 限流 / 降级 / 扩容
1:00-2:00  抓现场 - top -Hp + jstack（连续 3 次）+ async-profiler 火焰图
2:00-3:00  火焰图分析 - 找宽且尖的栈、识别单一热点
3:00-4:00  根因定位 - 看代码、确认元凶方法
4:00-5:00  止血 + 修复方案 - 临时止血 + 根因 PR
```

**关键节奏点**：

1. **30 秒分类**：用 `top -Hp` 看线程名，30 秒区分 6 种类型
2. **1 分钟止损**：止损优先于定位，避免故障扩大
3. **2 分钟抓现场**：现场一旦丢失就难再抓
4. **3 分钟火焰图**：async-profiler 是定位热点利器
5. **5 分钟止血**：哪怕没定位根因，也要止血（限流 / 扩容 / 重启）

### 3.2 止损决策树

**架构师视角的止损不是"无脑重启"**：

```
故障发生
   │
   ▼
影响多大？
   ├─ P0（核心业务中断）-> 立即止损
   │   ├─ 能摘流量？-> 摘流量 + 抓现场
   │   ├─ 不能摘流量但能限流？-> 限流 + 抓现场
   │   ├─ 不能限流但能扩容？-> 扩容 + 抓现场
   │   └─ 都不能？-> 立即重启（牺牲现场）
   │
   ├─ P1（部分功能异常）-> 评估后止损
   │   ├─ 抓现场 + 继续服务
   │   └─ 现场抓完 -> 限流异常接口
   │
   └─ P2（轻微抖动）-> 继续观察
       ├─ 抓现场
       └─ 不止损
```

**关键认知**：

1. **止损不等于重启**：摘流量、限流、降级、扩容都是止损手段
2. **现场优先**：能摘流量就摘流量，不要直接重启
3. **P0 故障可以牺牲现场**：核心业务中断比定位根因更重要
4. **抓现场也要分批**：集群 10 台只抓 1 台，避免雪崩

### 3.3 根因定位的层次

**架构师视角的根因不是"找到代码行"**：

```
层次 1：现象 - CPU 95%，P99 3.2s
        │
        ▼
层次 2：直接原因 - ResourceLeakDetector.track 占 50% CPU
        │
        ▼
层次 3：表层根因 - Netty 泄漏检测等级从 SIMPLE 切到 PARANOID
        │
        ▼
层次 4：代码根因 - 业务代码支持动态修改 Netty 检测等级
        │
        ▼
层次 5：流程根因 - 配置变更没有评审，凌晨操作
        │
        ▼
层次 6：体系根因 - 缺乏配置变更告警、缺乏 Netty 内部状态监控
```

**架构师经验**：

1. **找到代码行 ≠ 找到根因**：5 步法找到 ResourceLeakDetector.track 只是"表层根因"
2. **真正的根因在流程和体系**：配置变更管控、监控告警、Code Review
3. **复盘必须挖到层次 5-6**：否则同类问题会再发生
4. **改进项要可执行**：不要写"加强配置评审"，要写"配置变更必须 RFC + 至少 2 人 approve"

### 3.4 故障复盘的标准模板

**架构师视角的复盘不是"出文档"，是"沉淀知识"**：

```
# 故障复盘 - 2026-08-06 IM 网关 CPU 95% 事件

## 1. 时间线
- 02:28 ByteBuf 泄漏告警开始（每秒 100+ 条）
- 02:30 配置中心推送 NETTY_LEAK_DETECTION_LEVEL=PARANOID
- 02:30 CPU 飙到 95%，P99 3.2s
- 02:35 1.2w 客户端断连
- 02:36 抓现场 + 恢复 SIMPLE 等级
- 02:38 P99 恢复
- 02:40 客户端断连停止
- 03:00 全量恢复

## 2. 影响范围
- 业务：1.5w 客户端断连重连，影响 15% 用户
- 数据：无数据丢失（消息队列重投）
- 资金：无直接损失，间接影响夜间问诊订单 5%

## 3. 根因
- 直接原因：ResourceLeakDetector 等级从 SIMPLE 切到 PARANOID
- 代码根因：业务代码支持动态修改 Netty 检测等级
- 流程根因：配置变更没有评审，凌晨操作
- 体系根因：缺乏配置变更告警，缺乏 Netty 内部状态监控

## 4. 改进项
| 改进项 | 负责人 | 截止日期 | 状态 |
|--------|--------|---------|------|
| 移除动态修改 Netty 检测等级 | 张三 | 2026-08-07 | 完成 |
| 配置变更评审流程 | 李四 | 2026-08-10 | 进行中 |
| 配置变更告警 | 王五 | 2026-08-08 | 完成 |
| ByteBuf 泄漏告警 | 赵六 | 2026-08-09 | 完成 |
| 故障演练（Netty 配置变更） | 钱七 | 2026-08-15 | 待开始 |

## 5. 经验教训
- 凌晨配置变更要禁止（除非紧急）
- Netty ResourceLeakDetector 不能动态切 PARANOID
- 抓现场要快（top -Hp + jstack 5 分钟内）
- async-profiler 火焰图是定位 Netty 内部热点利器
```

**架构师经验**：

1. **复盘不追责**：对事不对人，否则团队会隐瞒问题
2. **改进项必须可执行**：要有负责人、截止日期、验收标准
3. **复盘要快**：故障后 24 小时内复盘，时间久了细节忘记
4. **改进项要跟踪**：不能开完会就完事，每月 review 进度

---

## 四、CPU 排查与简历项目的结合

### 4.1 在线问诊系统的 CPU 飙高实战案例

**案例 1：IM 网关 10w+ 长连接 CPU 飙高（ByteBuf 泄漏检测）**

```
现象：IM 网关 CPU 持续 95%，10w 连接开始断开
排查：
  1. top -Hp 找到 CPU 85% 线程，是 nioEventLoopGroup
  2. jstack 抓栈，栈顶是 ResourceLeakDetector$DefaultResourceLeak.close
  3. async-profiler CPU 火焰图，发现 ResourceLeakDetector.track 占 50% CPU
  4. 业务日志看到 02:30 Netty 泄漏检测等级从 SIMPLE 切到 PARANOID
根因：业务代码支持动态修改 Netty 检测等级，凌晨配置变更切到 PARANOID
修复：
  1. 立即恢复 SIMPLE 等级
  2. PR 移除动态修改逻辑
  3. 加配置变更告警
经验：5 步法 + 火焰图 5 分钟定位，复盘挖到流程根因（配置变更管控）
```

**案例 2：视频问诊 RTP 包堆积导致 Full GC CPU 高**

```
现象：视频问诊 CPU 持续 80%，GC Thread 占 70% CPU
排查：
  1. jstat -gcutil: O 列 88%，FGC 涨 1次/秒
  2. jmap dump + MAT: RTPPacketWrapper 数组 3.2GB
  3. Path to GC Roots: VideoStreamSession -> RTPQueue -> 100w RTPPacketWrapper
根因：视频通话结束后 RTPQueue 未 clear，下次通话又累积
修复：通话结束 finally 块加 queue.clear()
经验：GC CPU 高的根因在内存，调 GC 参数治标不治本
```

**案例 3：监管上报 24h 必达引发 CPU 高**

```
现象：监管上报服务 CPU 持续 75%，GC Thread 占 60%
排查：
  1. jstat -gcutil: O 列 92%，Full GC 5次/分钟
  2. jmap dump + MAT: ConcurrentHashMap<Key, ReportTask> 2.8GB
  3. Key 是 reportId，ReportTask 是上报任务
根因：上报失败重试时，每次都新建 ReportTask 而非复用，导致 Map 无限增长
修复：重试时复用 ReportTask，加 maximumSize 防爆
经验：缓存类场景要检查 maximumSize 配置
```

**案例 4：问诊订单缓存 100w Key 引发 GC CPU 高**

```
现象：问诊订单服务 CPU 持续 80%，堆 92%
排查：
  1. jstat -gcutil: FGC 涨 1次/秒
  2. jmap dump + MAT: OrderEntity 100w 占 4.2GB
  3. Arthas vmtool 查 Caffeine: estimatedSize = 100w
根因：Caffeine maximumSize 设了 100w（应该 1w），缓存膨胀
修复：
  1. Arthas ognl 改 maximumSize（不重启）
  2. PR 修复 maximumSize=10000 + expireAfterWrite=10min
经验：Caffeine maximumSize 配置错误是常见坑，要 Code Review 检查
```

**案例 5：MongoDB 大文档导致 G1 Humongous GC CPU 高**

```
现象：监管上报服务 G1 频繁 Humongous Allocation，GC Thread 占 50% CPU
排查：
  1. GC 日志看 "Humongous Allocation" 频繁
  2. jmap -histo 看 byte[] Top 1
  3. Arthas trace MongoDB 调用，发现读取 5MB 文档
根因：MongoDB 单文档 5MB，超过 G1 Region 大小（默认 4MB）的 50%
修复：
  1. 改 G1HeapRegionSize=8m（让 5MB 不再 Humongous）
  2. 改 MongoDB 查询，只查必要字段（< 1MB）
经验：大对象要警惕 G1 Humongous，调整 Region 大小或分片
```

### 4.2 CPU 排查体系的架构师建设

**架构师不仅要会用工具，还要建设 CPU 排查体系**：

1. **JFR 长开**：所有生产服务 JFR 持续录制，OOM / CPU 飙高时自动 dump
2. **Arthas sidecar**：所有 Pod 部署 Arthas sidecar，免安装直接用
3. **async-profiler 预装**：基础镜像包含 async-profiler
4. **监控告警体系**：CPU / NioEventLoop / GC Thread / Safepoint 多维告警
5. **故障知识库**：每次 CPU 故障沉淀到 wiki，团队共享
6. **定期演练**：每月一次 CPU 故障注入（死循环 / 锁竞争 / JIT 退优化）

**架构师责任**：

```
CPU 排查体系建设的 KPI：
- CPU 故障定位时长 P50 < 5 分钟
- CPU 故障定位时长 P99 < 15 分钟
- 工具链使用率 > 80%（团队成员都熟练 5 步法）
- 演练覆盖率 > 90%（关键服务都演练过 CPU 故障）
```

**监控告警体系（架构师视角）**：

```
指标采集（Prometheus + JVM Exporter）：
  - process_cpu_usage（进程 CPU）
  - jvm_threads_states（线程状态分布）
  - jvm_gc_concurrent_phase_time（GC 阶段耗时）
  - jvm_gc_pause_seconds（GC 停顿）
  - jvm_classes_loaded（类加载）
  - jvm_buffer_pool_used_bytes（直接内存）

告警规则：
  - CPU > 70% 持续 1 分钟 -> P2 告警
  - CPU > 85% 持续 30 秒 -> P1 告警
  - CPU > 95% 持续 10 秒 -> P0 告警
  - NioEventLoop CPU > 50% -> P1 告警（IM 网关）
  - GC Thread CPU > 30% -> P1 告警
  - Safepoint sync time > 100ms -> P2 告警
  - Full GC > 1次/分钟 -> P0 告警

Grafana 大盘：
  - CPU 趋势图（按 Pod / 线程类型）
  - 线程状态分布（RUNNABLE / BLOCKED / WAITING）
  - GC 频率 + 耗时
  - Safepoint 统计
  - JIT 编译统计
```

---

## 五、Day04 与整体学习路径的关系

### 5.1 Day04 在 JVM 专题中的位置

```
第 1 周（基础与核心）：
  Day01 内存模型 -> Day02 GC 算法 -> Day03 GC 收集器 -> Day04 类加载 -> Day05 JIT -> Day06 串联 -> Day07 G1 深挖

第 2 周（调优实战与生产排查）：
  Day01 参数全解 -> Day02 工具链实战 -> Day03 OOM 排查 -> [Day04 CPU 飙高排查] -> Day05 在线问诊 JVM 调优案例 -> Day06 故障复盘串联 -> Day07 ZGC 深挖
```

**Day04 的位置意义**：

1. **承上**：Day02 工具链 + Day03 OOM 排查是 Day04 的前置能力
2. **启下**：Day05 在线问诊 JVM 调优案例、Day06 故障复盘串联，都会用到 Day04 的 5 步法 + 火焰图
3. **串联**：Day04 把 CPU 维度（业务 / GC / JIT / 锁 / 死循环 / Native）梳理清楚，是面试"现场题"的核心
4. **深挖基础**：Day07 ZGC 深挖，需要 Day04 的 Safepoint / JIT 知识作为前置

### 5.2 Day04 与 Day03 的衔接（OOM vs CPU）

| 维度 | Day03 OOM 排查 | Day04 CPU 飙高排查 |
|------|---------------|------------------|
| 故障现象 | 堆涨、Full GC、OOM Kill | CPU 高、P99 飙、连接断 |
| 排查工具 | jmap + MAT + GC 日志 | top -Hp + jstack + async-profiler |
| 元凶类型 | 内存泄漏 / 缓存膨胀 / 大对象 | 业务 / GC / JIT / 锁 / 死循环 / Native |
| 5 分钟定位 | 摘流量 + dump + MAT | 摘流量 + 5 步法 + 火焰图 |
| 交织点 | GC CPU 高（内存问题引发 CPU 问题） | GC CPU 高（CPU 问题表象，根因在内存） |

**Day03 + Day04 的协同**：

```
GC 频繁 + CPU 高
  │
  ▼
jstat -gcutil 看堆
  │
  ├─ O 列高 + Full GC 多 -> 内存问题（走 Day03 路径）
  │   └─ jmap dump + MAT
  │
  └─ O 列正常 + Young GC 多 -> 可能是分配压力（Day03 + Day04 联动）
      └─ async-profiler alloc 模式找分配大头
```

### 5.3 Day04 与往周专题的呼应

| 往周专题 | CPU 排查呼应 |
|---------|------------|
| 6月第1周 MySQL | MySQL 慢查询 CPU 高 vs JVM CPU 高（DB CPU vs App CPU） |
| 6月第2周 Redis | Redis 单线程 CPU 100% vs JVM 多线程 CPU 高 |
| 6月第3周 ES | ES hot_threads API vs JVM jstack（ES 内部也是 JVM） |
| 6月第4周 限流降级 | Sentinel LeapArray CPU 占用 vs JVM 业务 CPU |
| 6月第5周 支付 | 支付对账大数据量计算 CPU 高 |
| 7月第1周 医疗 | 医保结算 3 万规则匹配 CPU 高 |
| 7月第3周 K8s | K8s kubectl top vs 容器内 top（PID / cgroup 陷阱） |
| 7月第4周简历项目 | 在线问诊系统的 5 个 CPU 飙高场景 |
| 7月第5周 JVM 第1周 | G1 GC 线程 CPU / JIT 编译 CPU |

### 5.4 Day04 的能力差距与补足

**作答时发现的能力差距**（详见 `架构师学习-能力差距梳理.md`）：

1. **5 步法熟练度**（差距2.4）：能不能不查文档直接写出完整命令链？
2. **火焰图解读**（差距2.4）：能不能 1 分钟内识别"宽且尖"vs"宽且平"vs"窄且高"？
3. **async-profiler 4 种模式**（差距2.4）：cpu / alloc / lock / wall 的区别？
4. **JIT 退优化**（差距1.5）：能不能讲清 uncommon trap、unstable if、not entrant？
5. **Safepoint 与 jstack 关系**（差距1.5）：能不能讲清 jstack 为什么会触发 Safepoint？
6. **生产事故节奏感**（差距2.6）：5 分钟定位法的节奏点能不能背出？
7. **工具链副作用**（差距2.7）：jstack -F / Arthas trace / async-profiler wall 的副作用？
8. **K8s 容器内排查**（差距2.9）：top -Hp 不显示线程、容器 PID 不一致？
9. **架构师视角**（差距2.8）：能不能从"工具使用"上升到"配置变更管控 + 故障演练"？

**补足方向**：

1. **每日练 1 个场景**：周一业务 CPU 高 / 周二 GC CPU 高 / 周三 JIT 退优化 / 周四 Safepoint / 周五 Native CPU 高
2. **生产实战**：主动参与 CPU 故障排查，每次故障后整理复盘
3. **模拟演练**：本地注入故障（死循环、锁竞争、JIT 退优化），用工具链定位
4. **阅读源码**：async-profiler 源码、Netty ResourceLeakDetector 源码、JVM C2 编译器源码
5. **关注 JEP**：JEP 312（Handshakes）/ JEP 376（ZGC stack scan）/ JEP 374（Biased Locking Deprecated）

---

## 六、Day04 核心要点速查

### 6.1 CPU 飙高 6 种类型速查

| 类型 | 特征 | 工具链 | 修复方向 |
|------|------|--------|---------|
| **业务 CPU 高** | 业务方法栈顶 | 5 步法 + 火焰图 | 优化算法 / 加缓存 |
| **GC CPU 高** | GC 线程栈顶 | jstat + GC 日志 + MAT | 内存调优 |
| **JIT 编译 CPU 高** | C2 CompilerThread 栈顶 | PrintCompilation + JFR | 预热 / AppCDS |
| **锁竞争 CPU 高** | 多线程 BLOCKED | jstack + Arthas thread -b | 减小锁粒度 |
| **死循环 CPU 高** | 单线程 100% | 5 步法（连续 3 次） | 修死循环 bug |
| **Native CPU 高** | 栈看不出业务 | async-profiler + perf | 排查 JNI / 本地库 |

### 6.2 5 步法速查

```bash
# 第 1 步：找 Java 进程
jps -lvm
# 或
top -c

# 第 2 步：找 CPU 高的线程
top -Hp PID

# 第 3 步：10 进制转 16 进制
printf "%x\n" TID

# 第 4 步：jstack 抓栈并过滤
jstack -l PID | grep -A 30 "nid=0xHEX"

# 第 5 步：看栈顶方法定位代码
# 多次 jstack 同一行 = 死循环
```

### 6.3 async-profiler 4 种模式速查

| 模式 | 事件 | 适合场景 | 命令 |
|------|------|---------|------|
| `cpu` | CPU 周期 | CPU 密集型找热点 | `./profiler.sh -d 60 -f cpu.html PID` |
| `alloc` | 内存分配 | 找分配压力大的方法 | `./profiler.sh -d 60 -e alloc -f alloc.html PID` |
| `lock` | 锁竞争 | 锁分析 | `./profiler.sh -d 60 -e lock -f lock.html PID` |
| `wall` | 挂钟时间 | IO 密集、慢接口 | `./profiler.sh -d 60 -e wall -f wall.html PID` |

### 6.4 火焰图形态速查

| 形态 | 含义 | 优化方向 |
|------|------|---------|
| **宽且尖** | 单一方法占 80%+ CPU | 优化该方法（算法、缓存） |
| **宽且平** | 多方法各占 10-20% | 难优化，需架构级调整 |
| **窄且高** | 深度调用链但单次开销低 | 减少递归深度 |
| **底部很宽** | 调用入口被频繁触发 | 减少调用次数（限流、批量化） |
| **顶部很宽** | CPU 浪费在叶子方法 | 优化叶子方法（换库、流式） |
| **大量 JIT 帧** | JIT 编译占用 | 预热不充分 |
| **大量 GC 帧** | GC 占 CPU | 内存调优 |

### 6.5 JIT 退优化速查

| 类型 | 含义 | 触发条件 |
|------|------|---------|
| **unstable if** | 分支预测失效 | profile 显示 99% 走 true，突然遇到 false |
| **not entrant** | inline 假设失效 | 新类加载使 inline 假设失效 |
| **uncommon trap** | 反向分支触发退优化 | C2 假设某分支不走，实际走到了 |

**排查命令**：

```bash
# JDK 8
-XX:+PrintCompilation

# JDK 11+
-Xlog:codegen=info

# 看 inline 失败
-XX:+UnlockDiagnosticVMOptions -XX:+PrintInlining

# JFR 录制
jcmd PID JFR.start name=profile duration=60s filename=/tmp/r.jfr settings=profile
```

### 6.6 Safepoint 速查

| 场景 | 进入 Safepoint 频率 | STW 时长 |
|------|-------------------|---------|
| **GC** | 高频 | 100ms-数秒 |
| **偏向锁撤销** | 中频 | 1-10ms |
| **jstack / jcmd Thread.print** | 手动 | 100ms-数秒 |
| **heap dump** | 手动 | 数秒-数分钟 |
| **class unloading** | 中频 | 10-100ms |

**排查命令**：

```bash
# JDK 8
-XX:+PrintSafepointStatistics -XX:PrintSafepointStatisticsCount=1

# JDK 11+
-Xlog:safepoint

# Safepoint 超时告警
-XX:+SafepointTimeout -XX:SafepointTimeoutDelay=1000

# 关闭定期 Safepoint（生产慎用）
-XX:GuaranteedSafepointInterval=0
```

### 6.7 K8s 容器内排查速查

```bash
# 1. 进容器
kubectl exec -it pod -- bash

# 2. 找 Java PID（容器内 PID 通常是 1）
jps
# 1 com.example.Application

# 3. top -Hp（如果可用）
top -Hp 1

# 4. 如果 top -Hp 不可用，用 /proc/PID/task
ls /proc/1/task/
for tid in $(ls /proc/1/task/); do
  cpu=$(awk '{print $14+$15}' /proc/1/task/$tid/stat 2>/dev/null)
  echo "$cpu $tid"
done | sort -rn | head -5

# 5. jstack（如果权限够）
jstack -l 1

# 6. 如果 jstack 权限不够，用 jcmd
jcmd 1 Thread.print -l

# 7. 如果都没有，用 kill -3
kill -3 1
# 栈打到 stdout（需要启动时重定向）

# 8. 推荐：Arthas sidecar
```

### 6.8 CPU 飙高 5 分钟定位法速查

```
0:00-0:30  现象确认 - 看监控 + top -Hp 分类（业务 / GC / JIT / 锁 / 死循环 / Native）
0:30-1:00  止损决策 - 摘流量 / 限流 / 降级 / 扩容
1:00-2:00  抓现场 - 5 步法（top -Hp + printf %x + jstack + grep）
2:00-3:00  火焰图分析 - async-profiler cpu 模式 60 秒
3:00-4:00  根因定位 - 看代码、确认元凶方法
4:00-5:00  止血 + 修复方案 - 临时止血 + 根因 PR
```

### 6.9 工具链副作用速查

| 工具 | 副作用 | 何时禁用 |
|------|--------|---------|
| `jstack` | 触发 Safepoint（10w 线程可能 STW 5 秒） | 大型应用高峰期 |
| `jstack -F` | 进程挂起 | 流量未摘除 |
| `jstack -m` | 混合模式，很慢 | 日常诊断 |
| `Arthas trace` | 每次调用计时 | 高 QPS 长挂 |
| `Arthas watch` | 每次匹配触发 | 高 QPS 长挂 |
| `async-profiler wall` | 采样所有线程 | 大型应用慎用 |
| `kill -3` | 触发 Safepoint | 大型应用高峰期 |

### 6.10 元凶线程名速查

| 线程名前缀 | 含义 | CPU 高意味着 |
|-----------|------|------------|
| `main` | 主线程 | 启动期问题 |
| `GC Thread` / `G1 RefineThread` | GC 线程 | 内存问题，GC 频繁 |
| `C2 CompilerThread` / `C1 CompilerThread` | JIT 编译线程 | 启动期编译 / 退优化风暴 |
| `VM Thread` | JVM 内部线程 | GC STW 时间长 |
| `http-nio-8080-exec-*` | Tomcat 业务线程 | 业务 CPU 高 |
| `DubboServerHandler-*` | Dubbo 业务线程 | RPC 业务 CPU 高 |
| `nioEventLoopGroup-*` | Netty I/O 线程 | 网络或 ByteBuf 处理问题 |
| `DefaultDispatcher-worker-*` | Kotlin 协程 | 协程业务 CPU 高 |
| `pool-N-thread-*` | 通用线程池 | 看具体业务（无 setName 时无法区分） |

---

> **Day04 总结**：CPU 飙高排查不是"5 步法万能"，而是"先分类、再深挖"的体系化工程。架构师必须掌握 6 种 CPU 飙高类型（业务 / GC / JIT / 锁 / 死循环 / Native）、5 步法 + async-profiler 火焰图、JIT 退优化与 Safepoint 高阶问题、K8s 容器内的坑、工具链副作用。Day04 把 CPU 维度梳理清楚，与 Day03 OOM 排查（内存维度）形成完整的 JVM 故障排查能力。Day05 落到在线问诊系统 JVM 调优案例，Day06 串联故障复盘方法论，Day07 深挖 ZGC。
