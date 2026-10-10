# 架构师学习-Day02-JVM 诊断工具链实战-梳理

> 日期：2026年08月04日（周二）
> 周主题：JVM 专题第 2 周 - 调优实战与生产排查
> 梳理日：Day02 - 架构师视角梳理

---

## 一、架构师视角下的 JVM 工具链

### 1.1 不只是"会用工具"，是"工具体系建设"

很多工程师把 JVM 工具链当成"出问题查一下文档"的临时技能，结果就是"工具会用了但生产事故还是定位不出来"。架构师视角下，工具链是**体系化工程**：

| 架构决策 | 受工具链约束的具体点 |
|---------|--------------------|
| 故障排查 SLA（5 分钟定位 vs 30 分钟定位） | 工具熟练度 + 是否预置 JFR/Arthas |
| K8s 部署形态（是否需要 sidecar Arthas） | Arthas 接入方式（exec / javaagent / sidecar / tunnel） |
| 监控告警是否完善 | Prometheus + JVM Exporter + GC 日志采集是否就绪 |
| OOM 自救能力 | `-XX:+HeapDumpOnOutOfMemoryError` 是否开启、dump 路径是否有磁盘 |
| 团队故障排查能力 | 是否有定期演练、是否有故障知识库 |
| JDK 升级决策 | JDK 8 -> 11 工具链迁移成本（jhat 废弃、JFR 转正、jmap 卡死修复） |

如果工具链只是"工程师的私人技能"，团队整体故障排查能力就上不去。**架构师的责任是把工具链变成团队能力**。

### 1.2 工具链的本质：诊断 vs 治疗 vs 预防

JVM 工具链按医学逻辑分三类：

| 类别 | 作用 | 代表工具 | 时机 |
|------|------|---------|------|
| **诊断工具** | 看现状、定位问题 | jstack / jmap / jstat / Arthas / MAT | 出问题后 |
| **治疗工具** | 修复问题 | Arthas redefine / jinfo 改参数 / 重启 | 定位后 |
| **预防工具** | 提前发现问题 | JFR 持续录制 / Prometheus 监控 / 告警 | 出问题前 |

**架构师思维**：

```
普通工程师：会诊断（jstack、jmap）
高级工程师：会诊断 + 会治疗（Arthas redefine）
架构师：会诊断 + 会治疗 + 建设预防体系（监控告警 + 演练）
```

**关键认知**：JFR 持续录制是"飞机黑匣子"--平时开销 &lt; 1%，事故时是"救命证据"。架构师必须推动生产环境长开 JFR。

### 1.3 工具链的副作用：每个工具都有代价

JVM 工具不是免费的，每个工具都有副作用。架构师必须**精确掌握每个工具的代价**：

| 工具 | 副作用 | 何时不能用 | 替代方案 |
|------|--------|-----------|---------|
| `jmap -histo:live` | 触发 Full GC，STW 数秒 | 线上高峰期 | `jcmd GC.class_histogram`（无 :live 不触发 GC） |
| `jmap -dump` | STW 数秒到数分钟（看堆大小） | 流量未摘除时 | 先摘流量再 dump |
| `jmap -F` | 强制连接，进程挂起 | 进程假死时才能用（不能用 -F 替代普通 dump） | 等待进程恢复或用 gcore |
| `jstack -F` | 临时挂起进程 | 流量未摘除时 | 普通 jstack -l |
| `Arthas trace` | 每次方法调用都计时，开销线性增长 | 高 QPS 接口长时间挂 | `trace -n 5` 限制次数 + `#cost > N` 过滤 |
| `Arthas watch` | 每次匹配触发一次，开销中等 | 高 QPS 接口 | 用 `monitor` 统计代替 |
| `Arthas redefine` | Metaspace 累积膨胀 | 反复 redefine | 一次改对，不要试错 |
| `Arthas vmtool` | 全堆扫描找实例 | 大堆（>32GB） | 改用 OQL on heap dump |
| `MAT` 分析大 dump | 本地 OOM | dump > MAT 内存 / 2 | 离线大内存机器 / 在线 MAT |
| `JFR 长开` | &lt; 1% 开销 | 极致延迟敏感场景 | 事件触发录制 |

**架构师经验**：

1. **工具不是越强大越好**：Arthas `trace` 比 `jstack` 强大，但开销也大；能用 `monitor` 就不用 `trace`
2. **工具用错比不用更糟**：`jmap -histo:live` 在高峰期用，等于"主动制造 Full GC"
3. **每个工具都要懂原理**：不懂 `jmap -F` 会挂起进程，就可能在生产把它当普通工具用

### 1.4 工具链与版本演进：JDK 8 -> 11 -> 17 的迁移

JVM 工具链与 JDK 版本深度绑定，**JDK 升级会改变工具链**：

| 工具 | JDK 8 | JDK 11 | JDK 17 |
|------|-------|--------|--------|
| `jhat` | 内置但简陋 | Deprecated | 移除（用 MAT） |
| `jmap` | 主流 | 推荐 jcmd 替代 | 推荐 jcmd 替代 |
| `jcmd` | 主流 | 主流 | 主流 |
| `JMC/JFR` | 商业特性（需解锁） | 开源免费 | 开源免费 |
| `JVisualVM` | 内置 | 单独下载 | 单独下载 |
| GC 日志参数 | `-XX:+PrintGCDetails` | `-Xlog:gc*` | `-Xlog:gc*` |
| `Arthas` | 支持 | 支持 | 支持 |
| `async-profiler` | 支持 | 支持 | 支持 |

**JDK 升级工具链迁移清单**：

1. **GC 日志参数迁移**：`-XX:+PrintGCDetails` -> `-Xlog:gc*`（语法完全不同）
2. **jhat 替换**：用 MAT 离线分析
3. **JFR 启用**：去掉 `-XX:+UnlockCommercialFeatures`，直接 `jcmd PID JFR.start`
4. **jmap 替换**：所有 `jmap -dump:format=b,file=` 改成 `jcmd PID GC.heap_dump`
5. **Arthas 兼容性检查**：Arthas 3.x+ 支持 JDK 17，但 `redefine` 在 JDK 17 受模块化限制
6. **监控告警适配**：JVM Exporter 的 metrics 名称在 JDK 8 vs 11 vs 17 有差异

**架构师做 JDK 升级的工具链决策**：

1. **小步快跑**：先升级 1 台，验证工具链全部可用
2. **保留旧工具**：升级期间 JDK 8 和 JDK 11 工具并存，避免一刀切
3. **培训团队**：JDK 11+ 的 `jcmd` / `Xlog` / `JFR` 要团队熟悉
4. **更新文档**：故障排查手册、运维 SOP 全部更新

### 1.5 工具链与可观测性建设：从工具到体系

JVM 工具链是可观测性体系的**最后一公里**--当监控告警发现异常时，用工具链定位根因。架构师视角下，可观测性是金字塔：

```
                    ┌──────────────────┐
                    │   故障自愈        │  顶 - 自动化
                    │  （auto-remediation）│
                    └──────────────────┘
                  ┌──────────────────────┐
                  │   根因定位           │  上 - 工具链
                  │  （Arthas/MAT/JFR）  │
                  └──────────────────────┘
                ┌──────────────────────────┐
                │   告警与排查              │  中 - 监控
                │  （Prometheus/Grafana）  │
                └──────────────────────────┘
              ┌──────────────────────────────┐
              │   指标采集                   │  下 - 数据
              │  （JMX/JFR/GC log/access）  │
              └──────────────────────────────┘
            ┌──────────────────────────────────┐
            │   应用埋点                       │  基 - 业务
            │  （SkyWalking/Pinpoint/OpenTelemetry）│
            └──────────────────────────────────┘
```

**架构师责任**：

1. **底层埋点**：每个服务接入 OpenTelemetry / SkyWalking，全链路追踪
2. **指标采集**：JVM Exporter 采集堆 / GC / 线程，业务埋点采集 QPS / RT / 错误率
3. **告警体系**：分级告警（P0 立即打电话、P1 钉钉、P2 邮件）
4. **工具链就绪**：Arthas 预装、JFR 长开、dump 路径预留磁盘
5. **故障自愈**：基础自愈（如 OOM 自动重启、磁盘满自动清理日志）

**关键认知**：工具链不是"出事才用"，而是"平时就绪"。Arthas sidecar、JFR 持续录制、dump 磁盘预留，都要在平时配置好。

---

## 二、工具链的三大核心场景

### 2.1 场景一：CPU 飙高定位

**典型现象**：服务 CPU 持续 90%+，业务 RT 飙高。

**架构师视角的 CPU 飙高分类**：

| 类型 | 特征 | 工具链 | 修复方向 |
|------|------|--------|---------|
| **业务 CPU 高** | 单接口 RT 高、jstack 显示业务方法 | top -Hp + jstack | 优化算法 / 加缓存 |
| **GC CPU 高** | GC 频率高、jstack 显示 GC 线程 | jstat + GC 日志 | 内存调优 |
| **JIT 编译 CPU 高** | 启动后 5 分钟内 CPU 高、jstack 显示 CompileThread | jstack + `-XX:+PrintCompilation` | 预热、AppCDS |
| **锁竞争 CPU 高** | 多线程 BLOCKED、jstack 显示等锁 | jstack + Arthas thread -b | 减小锁粒度 / 改并发结构 |
| **死循环 CPU 高** | 单线程 100% CPU、jstack 显示同一行 | top -Hp + jstack | 修死循环 bug |
| **Native CPU 高** | jstack 看不出业务栈 | async-profiler + perf | 排查 JNI / 本地库 |

**关键认知**：CPU 飙高不是单一线索，要先用 jstack 区分是"业务 CPU"还是"GC CPU"还是"JIT CPU"。架构师能在 30 秒内分类。

**生产实战经验**：

1. **不要只看 jstack 一次**：单次 jstack 是瞬时快照，至少抓 3 次（间隔 5 秒）才能确认热点
2. **GC CPU 高的根因往往是内存**：GC 线程占 70% CPU，本质是堆压力大，调 GC 参数治标不治本
3. **JIT 编译 CPU 高在 JDK 11+ 减少**：AppCDS + AOT 编译可以预热
4. **死循环看 jstack 必须连续抓**：单次抓到的栈可能恰好不是死循环那行

### 2.2 场景二：内存泄漏 / Full GC 频繁

**典型现象**：堆使用率持续上涨、Full GC 后堆不下降、P99 飙高。

**架构师视角的内存问题分类**：

| 类型 | 特征 | 工具链 | 修复方向 |
|------|------|--------|---------|
| **真泄漏** | Retained Size 单一对象异常大、引用链可追 | jmap + MAT | 修业务 bug |
| **缓存膨胀** | Caffeine / Map Retained 大、key 数量异常 | Arthas vmtool + MAT | 加上限 / 调过期 |
| **大对象** | byte[] / String Retained 大、单实例异常 | jmap -histo + MAT | 改分页 / 流式 |
| **ThreadLocal 累积** | ThreadLocalMap 大、线程池复用 | MAT + OQL | 用完 remove |
| **Metaspace 泄漏** | Metaspace 持续涨、动态生成类 | jstat -gcmetacapacity + MAT | 排查 CGLIB / 反射 |
| **直接内存泄漏** | NIO ByteBuf 占用、堆外内存涨 | NMT（Native Memory Tracking） | 修 ByteBuf 释放 |
| **过多 finalize** | Finalizer 队列大、对象多 | jstat + MAT | 避免用 finalize |

**架构师经验**：

1. **第一次定位不出来很正常**：可能元凶是动态生成的类，需要看 Histogram 多次刷新
2. **MAT Dominator Tree 第一名未必是元凶**：可能是 JVM 内部对象（如 StringTable），要看引用链
3. **缓存膨胀最常见**：80% 的"内存泄漏"都是缓存配置错误
4. **Metaspace 泄漏易被忽视**：堆正常但 Metaspace 涨，通常是 CGLIB / Groovy 动态生成类

**生产实战 - 缓存膨胀的识别清单**：

```
□ Caffeine 是否设了 maximumSize？
□ Caffeine 是否设了 expireAfterWrite / expireAfterAccess？
□ maximumSize 与 maximumWeight 是否混淆（maximumWeight 需要 weigher）？
□ ConcurrentHashMap 是否用作缓存但没设上限？
□ ThreadLocal 是否在 finally 中 remove？
□ ThreadLocal 是否用了线程池（线程池复用导致累积）？
□ 监听器 / Callback 是否在不需要时 unregister？
□ 静态集合（static Map / static List）是否无限增长？
```

### 2.3 场景三：接口慢 / P99 飙高

**典型现象**：单接口 P99 飙到秒级，CPU / 内存 / GC 都正常。

**架构师视角的接口慢分类**：

| 类型 | 特征 | 工具链 | 修复方向 |
|------|------|--------|---------|
| **DB 慢查询** | 接口慢、DB 慢日志有记录 | Arthas trace + DB slowlog | 加索引 / 改 SQL |
| **下游接口慢** | Arthas trace 显示 HTTP / RPC 调用慢 | Arthas trace + 下游监控 | 排查下游 / 加超时 |
| **锁竞争** | jstack 显示 BLOCKED | jstack + Arthas thread -b | 减小锁粒度 |
| **GC 偶发停顿** | P99 抖动但平均值正常、GC 日志显示长停顿 | GC 日志 | GC 调优 |
| **网络抖动** | 跨可用区调用慢 | 全链路追踪 | 改就近部署 |
| **JIT 退优化** | 接口偶发慢、`-XX:+PrintCompilation` 显示 deopt | JFR + PrintCompilation | 减少分支抖动 |
| **资源耗尽** | 接口慢、连接池满 | Arthas trace + 池监控 | 调连接池参数 |

**架构师经验**：

1. **P99 飙高比平均 RT 飙高更难定位**：偶发问题要靠持续采样（JFR）
2. **Arthas trace 是利器但要小心副作用**：高 QPS 接口不能长挂 `trace`
3. **GC 偶发停顿是常见元凶**：单次 GC 1s 可能只让平均 RT 涨 1ms，但让 P99 涨 1000ms
4. **全链路追踪是必备**：SkyWalking / Pinpoint 能快速定位是哪个调用慢

**接口慢的排查优先级**：

```
1. 看监控 - 是单接口慢还是全服务慢？
   ├─ 单接口慢 -> 2a
   └─ 全服务慢 -> 2b

2a. Arthas trace 单接口 - 找慢在哪一步
   ├─ DB 慢 -> 看 DB 慢日志
   ├─ RPC 慢 -> 看下游监控
   └─ 计算慢 -> 看 JIT / GC

2b. 看整体指标
   ├─ CPU 高 -> top -Hp + jstack
   ├─ GC 频繁 -> GC 日志
   ├─ 锁竞争 -> jstack + Arthas thread -b
   └─ 网络抖动 -> 全链路追踪
```

---

## 三、生产事故排查的方法论

### 3.1 5 分钟定位法

**架构师视角的"5 分钟"不是死规定，而是节奏感**：

```
0:00-0:30  现象确认 - 看监控、确认影响范围
0:30-1:00  止损决策 - 摘流量 / 限流 / 降级 / 扩容
1:00-2:00  抓现场 - jstack + jmap dump + GC 日志
2:00-3:00  日志分析 - GC 日志分类元凶
3:00-4:00  堆分析 - MAT 看 Dominator Tree + Leak Suspects
4:00-5:00  根因定位 + 止血
```

**关键节奏点**：

1. **30 秒确认现象**：不要凭直觉，看监控数据
2. **1 分钟内止损**：止损优先于定位，避免故障扩大
3. **2 分钟内抓现场**：现场一旦丢失就难再抓
4. **3 分钟内分类元凶**：从 GC 日志判断是泄漏 / 大对象 / 配置 / 流量
5. **5 分钟内止血**：哪怕没定位根因，也要止血（重启 / 清缓存 / 限流）

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

1. **止损不等于重启**：摘流量、限流、降级都是止损手段
2. **现场优先**：能摘流量就摘流量，不要直接重启
3. **P0 故障可以牺牲现场**：核心业务中断比定位根因更重要
4. **抓现场也要分批**：集群 10 台只抓 1 台，避免雪崩

### 3.3 根因定位的层次

**架构师视角的根因不是"找到对象"**：

```
层次 1：现象 - 接口 P99 飙到 3.2s
        │
        ▼
层次 2：直接原因 - Full GC 1.5s STW
        │
        ▼
层次 3：表层根因 - 老年代 4.2GB OrderEntity 累积
        │
        ▼
层次 4：代码根因 - OrderCache 未设 maximumSize
        │
        ▼
层次 5：流程根因 - Code Review 没检查缓存配置
        │
        ▼
层次 6：体系根因 - 缺乏缓存配置规范、缺乏监控告警
```

**架构师经验**：

1. **找到对象 ≠ 找到根因**：MAT 看到 4.2GB OrderEntity 只是"表层根因"
2. **真正的根因在流程和体系**：Code Review 漏了、监控告警没加、规范没立
3. **复盘必须挖到层次 5-6**：否则同类问题会再发生
4. **改进项要可执行**：不要写"加强 Code Review"，要写"缓存配置加入 Checklist 第 5 项"

### 3.4 故障复盘的标准模板

**架构师视角的复盘不是"出文档"，是"沉淀知识"**：

```
# 故障复盘 - 2026-08-04 在线问诊 Full GC 事件

## 1. 时间线
- 14:30 - 监控告警：P99 飙到 3.2s
- 14:32 - 摘流量 + 抓 dump
- 14:35 - MAT 分析：OrderCache 4.2GB
- 14:40 - 清空缓存止血
- 14:50 - 修复 PR 合并
- 15:00 - 灰度发布
- 15:15 - 全量恢复

## 2. 影响范围
- 业务：问诊发起接口超时，影响 2000 用户
- 数据：无数据丢失（接口幂等）
- 资金：无直接损失，间接影响订单转化率 5%

## 3. 根因
- 直接原因：OrderCache 未设 maximumSize，100w 订单对象堆积 4.2GB
- 代码根因：Caffeine builder 漏写 .maximumSize(10000)
- 流程根因：Code Review 未检查缓存配置
- 体系根因：缺乏缓存配置规范、缺乏缓存大小监控

## 4. 改进项
| 改进项 | 负责人 | 截止日期 | 状态 |
|--------|--------|---------|------|
| 修复 OrderCache | 张三 | 2026-08-04 | 完成 |
| 全量排查所有 Caffeine 缓存 | 李四 | 2026-08-10 | 进行中 |
| 制定缓存配置规范 | 王五 | 2026-08-15 | 待开始 |
| 加缓存大小监控告警 | 赵六 | 2026-08-12 | 待开始 |
| Code Review Checklist 更新 | 钱七 | 2026-08-08 | 完成 |

## 5. 经验教训
- 止损及时（10 分钟内），未扩大影响
- MAT 分析准确，定位根因仅用 5 分钟
- 但根因是低级错误（漏写 maximumSize），说明 Code Review 流程有漏洞
```

**架构师经验**：

1. **复盘不追责**：对事不对人，否则团队会隐瞒问题
2. **改进项必须可执行**：要有负责人、截止日期、验收标准
3. **复盘要快**：故障后 24 小时内复盘，时间久了细节忘记
4. **改进项要跟踪**：不能开完会就完事，每月 review 进度

---

## 四、工具链与简历项目的结合

### 4.1 在线问诊系统的工具链实战案例

**案例 1：IM 网关 10w 长连接 CPU 飙高**

```
现象：IM 网关 CPU 持续 95%，10w 连接开始断开
排查：
  1. top -Hp 找到 CPU 95% 线程，是 Netty NioEventLoop
  2. jstack 抓栈，发现 NioEventLoop 在 ByteBuf.release 卡住
  3. async-profiler CPU 火焰图，发现 ByteBuf 分配占 60% CPU
  4. vmtool 查 ByteBuf 实例数，发现 100w+ 未释放
根因：业务代码 ByteBuf 没 release，Netty 检测泄漏循环清理
修复：加 leak detection，定位到具体业务代码，修复 release 逻辑
```

**案例 2：视频问诊 RTP 包堆积导致 Full GC**

```
现象：视频问诊偶发 Full GC，STW 1.5s，视频卡顿
排查：
  1. jmap dump（摘流量后），MAT 分析
  2. Dominator Tree Top 1: RTPPacketWrapper 数组 3.2GB
  3. Path to GC Roots: VideoStreamSession -> RTPQueue -> 100w RTPPacketWrapper
根因：视频通话结束后 RTPQueue 未 clear，下次通话又累积
修复：通话结束 finally 块加 queue.clear()
```

**案例 3：监管上报 24h 必达的 OOM**

```
现象：监管上报服务 OOM 重启，24h 必达任务丢失
排查：
  1. OOM 自动 dump（-XX:+HeapDumpOnOutOfMemoryError）
  2. MAT 分析：ConcurrentHashMap<Key, ReportTask> 2.8GB
  3. Key 是 reportId，ReportTask 是上报任务
根因：上报失败重试时，每次都新建 ReportTask 而非复用，导致 Map 无限增长
修复：重试时复用 ReportTask，加 maximumSize 防爆
```

**案例 4：问诊订单缓存 100w Key**

```
现象：问诊订单服务堆 92%，Full GC 频繁
排查：
  1. jmap -histo:live（已摘流量），看 Top 1 是 OrderEntity
  2. Arthas vmtool 查 Caffeine 实例
  3. ognl 调用 cache.estimatedSize()，发现 100w Key
根因：Caffeine maximumSize 设了 100w（应该 1w），缓存膨胀
修复：Arthas ognl 改 maximumSize（不重启）+ PR 修复
```

**案例 5：MongoDB 大文档导致 G1 Humongous**

```
现象：监管上报服务 G1 频繁 Humongous Allocation
排查：
  1. GC 日志看 "Humongous Allocation" 频繁
  2. jmap -histo 看 byte[] Top 1
  3. Arthas trace MongoDB 调用，发现读取 5MB 文档
根因：MongoDB 单文档 5MB，超过 G1 Region 大小（默认 4MB）的 50%
修复：
  1. 改 G1HeapRegionSize=8m（让 5MB 不再 Humongous）
  2. 改 MongoDB 查询，只查必要字段（< 1MB）
```

### 4.2 工具链体系的架构师建设

**架构师不仅要会用工具，还要建设工具体系**：

1. **JFR 长开**：所有生产服务 JFR 持续录制，OOM 时自动 dump
2. **Arthas sidecar**：所有 Pod 部署 Arthas sidecar，免安装直接用
3. **dump 路径预留**：`/data/dump/` 挂大盘，预留 1.5 倍堆大小
4. **监控告警体系**：Prometheus + JVM Exporter + Grafana + 告警
5. **故障知识库**：每次故障沉淀到 wiki，团队共享
6. **定期演练**：每月一次混沌工程，注入故障让团队练手

**架构师责任**：

```
工具链体系建设的 KPI：
- 故障定位时长 P50 < 10 分钟
- 故障定位时长 P99 < 30 分钟
- 工具链使用率 > 80%（团队成员都熟练）
- 演练覆盖率 > 90%（关键服务都演练过）
```

---

## 五、Day02 与整体学习路径的关系

### 5.1 Day02 在 JVM 专题中的位置

```
第 1 周（基础与核心）：
  Day01 内存模型 -> Day02 GC 算法 -> Day03 GC 收集器 -> Day04 类加载 -> Day05 JIT -> Day06 串联 -> Day07 G1 深挖

第 2 周（调优实战与生产排查）：
  Day01 参数全解 -> [Day02 工具链实战] -> Day03 OOM 排查 -> Day04 CPU 飙高排查 -> Day05 在线问诊 JVM 调优案例 -> Day06 故障复盘串联 -> Day07 ZGC 深挖
```

**Day02 的位置意义**：

1. **承上**：Day01 的参数是"处方"，Day02 的工具是"诊断器"
2. **启下**：Day03 OOM 排查、Day04 CPU 飙高排查，都需要 Day02 的工具链作为前置
3. **串联**：Day05 实战案例、Day06 故障复盘，都会用到 Day02 的工具链
4. **深挖基础**：Day07 ZGC 深挖，需要 Day02 的 JFR / async-profiler 作为验证工具

### 5.2 Day02 与往周专题的呼应

| 往周专题 | 工具链呼应 |
|---------|-----------|
| 6月第1周 MySQL | MySQL 慢查询 + Arthas trace 联动定位慢接口 |
| 6月第2周 Redis | Redis slowlog + JVM jstack 联动定位缓存抖动 |
| 6月第3周 ES | ES _cat/thread_pool + JVM jstack 联动定位写入慢 |
| 6月第4周 限流降级 | Sentinel 监控 + JVM 工具链联动定位限流触发 |
| 6月第5周 支付 | 支付幂等 + JVM OOM dump 联动定位资损风险 |
| 7月第1周 医疗 | 医保结算 + JVM GC 抖动联动定位结算超时 |
| 7月第3周 K8s | kubectl exec + jcmd 联动定位容器内 JVM |
| 7月第4周 简历项目 | 在线问诊系统的 5 个工具链实战案例 |
| 7月第5周 JVM 第1周 | G1 调优 + jstat/GC 日志联动验证 |

### 5.3 Day02 的能力差距与补足

**作答时发现的能力差距**（详见 `架构师学习-能力差距梳理.md`）：

1. **工具命令熟练度**：Arthas 命令参数（`-x N`、`-n N`、`#cost > N`）能否脱口而出
2. **生产事故节奏感**：5 分钟定位法的节奏点能否背出
3. **副作用意识**：每个工具的副作用能否说清楚
4. **版本差异**：JDK 8 vs 11+ 工具差异能否脱口而出
5. **架构师视角**：能否从"工具使用"上升到"工具体系建设"

**补足方向**：

1. **每日练 1 个工具**：周一 jstack、周二 Arthas trace、周三 MAT、周四 JFR、周五 async-profiler
2. **生产实战**：主动参与故障排查，每次故障后整理复盘
3. **模拟演练**：本地注入故障（如内存泄漏、死锁），用工具链定位
4. **阅读源码**：async-profiler、Arthas 源码理解原理
5. **关注社区**：JDK 官方博客、阿里 Arthas 文档、Eclipse MAT 更新

---

## 六、Day02 核心要点速查

### 6.1 工具链速查表

| 场景 | 首选工具 | 备选 | 副作用 |
|------|---------|------|--------|
| 看 GC 概况 | `jstat -gcutil PID 1000` | Arthas dashboard | 无 |
| 看堆概况 | `jcmd PID GC.class_histogram` | jmap -histo | jmap -histo:live 触发 GC |
| 抓堆 dump | `jcmd PID GC.heap_dump /tmp/x.bin` | Arthas heapdump | STW 数秒 |
| 抓线程栈 | `jstack -l PID` | Arthas thread | 无 |
| 找 CPU 高线程 | `top -Hp` + `printf %x` + jstack | Arthas thread -n 3 | 无 |
| 找死锁 | Arthas thread -b | jstack 自动检测 | jstack -F 挂起进程 |
| 看方法耗时 | Arthas trace | JFR | trace 高 QPS 不能长挂 |
| 看入参返回值 | Arthas watch | JFR | watch 中等开销 |
| 反编译验证 | Arthas jad | javap | 无 |
| 改日志级别 | Arthas logger | jinfo | 无 |
| 改 VM 参数 | Arthas vmoption / jinfo | - | 仅 manageable 可改 |
| 火焰图 | async-profiler / Arthas profiler | JFR | &lt; 1% 开销 |
| 持续录制 | JFR | - | &lt; 1% 开销 |
| 查内存对象 | Arthas vmtool | MAT OQL | vmtool 全堆扫描 |
| 调用 Spring Bean | Arthas ognl | - | 无 |
| 热更新字节码 | Arthas redefine | javaagent | Metaspace 累积 |
| 分析大 dump | MAT | JVisualVM | MAT 内存 = dump × 2 |

### 6.2 生产配置速查

```bash
# 必备参数（生产模板）
-Xlog:gc*:file=/data/logs/gc.log:time,uptime,level,tags:filecount=10,filesize=50M
-XX:+HeapDumpOnOutOfMemoryError
-XX:HeapDumpPath=/data/dump/
-XX:StartFlightRecording=filename=/data/jfr/continuous.jfr,settings=profile,maxage=1h,maxsize=200M
-XX:+DisableExplicitGC
-XX:+AlwaysPreTouch

# K8s 容器感知（JDK 8u191+）
-XX:+UseContainerSupport
-XX:InitialRAMPercentage=50
-XX:MaxRAMPercentage=50
-XX:ParallelGCThreads=4    # 容器内必须手动设
-XX:ConcGCThreads=1
```

### 6.3 5 分钟定位法速查

```
0:00-0:30  现象确认 - 看监控确认故障
0:30-1:00  止损决策 - 摘流量 / 限流 / 降级
1:00-2:00  抓现场 - jstack + jmap dump + GC 日志
2:00-3:00  日志分析 - GC 日志分类元凶
3:00-4:00  堆分析 - MAT Dominator Tree + Leak Suspects
4:00-5:00  根因定位 + 止血
```

### 6.4 工具链副作用速查

| 工具 | 副作用 | 何时禁用 |
|------|--------|---------|
| `jmap -histo:live` | 触发 Full GC | 高峰期 |
| `jmap -dump` | STW 数秒-数分钟 | 流量未摘除 |
| `jstack -F` | 进程挂起 | 流量未摘除 |
| `Arthas trace` | 每次调用计时 | 高 QPS 长挂 |
| `Arthas watch` | 每次匹配触发 | 高 QPS 长挂 |
| `Arthas redefine` | Metaspace 累积 | 反复试错 |
| `Arthas vmtool` | 全堆扫描 | 大堆（>32GB） |

### 6.5 元凶对象速查

| 元凶对象 | 典型 Retained | 元凶场景 |
|---------|--------------|---------|
| `byte[]` | 1-4GB | 文件未关闭、大响应缓存 |
| `char[]` / `String` | 500MB-2GB | 日志拼接、JSON 缓存 |
| `HashMap$Node[]` | 1-3GB | 缓存未设上限 |
| `ConcurrentHashMap` | 1-3GB | 同上 |
| `Caffeine BoundedLocalCache` | 1-4GB | maximumSize 配置错误 |
| `LinkedList$Node` | 500MB-1GB | 队列未消费 |
| `ThreadLocalMap` | 500MB-1GB | ThreadLocal 未 remove |
| `Finalizer$Queue` | 100MB-1GB | finalize 方法堆积 |
| `java.lang.Class` | 100MB-500MB | CGLIB / Groovy 动态类 |

---

> **Day02 总结**：JVM 工具链不是"出事才查文档"的临时技能，而是架构师必须建立的体系化能力。从 jps 到 Arthas，从 MAT 到 JFR，每个工具都有适用场景与副作用。架构师不仅要会用工具，还要建设工具体系（JFR 长开、Arthas sidecar、监控告警、故障知识库）。Day03 进入 OOM 排查实战，Day02 的工具链是必备前置。
