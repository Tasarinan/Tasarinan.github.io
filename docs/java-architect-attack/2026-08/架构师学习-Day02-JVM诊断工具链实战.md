# 架构师学习-Day02-JVM 诊断工具链实战

> 日期：2026年08月04日（周二）
> 周主题：JVM 专题第 2 周 - 调优实战与生产排查
> 出题日：Day02 - JVM 诊断工具链实战（jps/jstat/jinfo/jmap/jstack/jcmd + Arthas + MAT + async-profiler + GC 日志）

---

## 背景

Day01 把 JVM 调优参数一次性梳理清楚了：堆内存参数、GC 参数、JIT 参数、容器化参数、生产配置模板。但**参数是"处方"，工具是"诊断器"**--没有诊断器，处方就是瞎开。架构师面试官最爱追问的不是"你知道 -Xmx"，而是：

> "线上服务 CPU 100%，你怎么定位是哪个线程、哪段代码？"
> "线上 Full GC 频繁，你怎么 5 分钟内找到元凶？"
> "线上接口偶发 P99 飙到 3 秒，你怎么在不重启服务的情况下抓到现场？"

这些问题答不出来，Day01 的参数就是死的。Day02 把整个 JVM 诊断工具链梳理清楚，从 JDK 自带命令行到阿里 Arthas、Eclipse MAT、async-profiler，再到 GC 日志分析。

**为什么 Day02 是"工具链实战"而不是"OOM 排查"**：

1. **工具链是排查的前置能力**：Day03 OOM 排查、Day04 CPU 飙高排查，都需要先掌握 jmap / jstack / Arthas / MAT，否则讲不动
2. **工具链是面试"现场题"的核心**：面试官常说"我给你一个 PID，你怎么排查"--考的就是工具熟练度
3. **工具链版本差异大**：JDK 8 的 jmap 有 `-dump:format=b,file=`，JDK 11+ 推荐用 `jcmd PID GC.heap_dump`，JMC 在 JDK 11+ 才转正，踩坑点很多
4. **生产限制多**：jmap -F 会触发 Full GC，线上能随便用吗？Arthas 的 `watch`/`trace` 会影响性能，怎么用才安全？这是工程经验

**与 Day01 的衔接点**：

- Day01 讲了 `-Xlog:gc*`（JDK 11+）vs `-XX:+PrintGCDetails`（JDK 8），Day02 讲怎么用 GCViewer / gceasy.io 分析这些日志
- Day01 讲了 `-XX:+HeapDumpOnOutOfMemoryError`，Day02 讲怎么用 MAT 分析 dump 文件
- Day01 讲了 `-XX:+PrintCompilation`，Day02 讲怎么用 async-profiler 生成火焰图看 JIT 热点
- Day01 讲了 `-XX:ParallelGCThreads`，Day02 讲怎么用 jstat 看 GC 线程占用

**与往周专题的衔接点**：

- **MySQL SHOW PROCESSLIST / EXPLAIN** vs **JVM jstack**：都是看"线程/查询在干什么"，但 MySQL 是 SQL 维度，JVM 是栈维度（6月第1周）
- **Redis slowlog + monitor** vs **JVM jstat + GC 日志**：都是抓"慢操作"，但 Redis 是单线程模型，JVM 是多线程（6月第2周）
- **ES _cat/thread_pool** vs **JVM jstack**：都是看线程池水位，但 ES 是协程式，JVM 是 OS 线程（6月第3周）
- **Sentinel cluster watchdog** vs **JVM Safepoint 轮询**：都是"心跳式"采集状态，但 Sentinel 是流控维度，Safepoint 是 GC 维度（6月第4周）
- **K8s kubectl top / exec** vs **JVM jcmd**：都是进入容器诊断，但 K8s 是 Pod 维度，JVM 是进程维度（7月第3周）

**与简历项目的衔接点**：

在线问诊系统的工具链实战重灾区：

1. **IM 网关 10w+ 长连接**：jstack 抓栈时 10w 线程的栈文件 200MB+，怎么快速过滤出 Netty I/O 线程？
2. **视频问诊 RTP 包堆积**：jmap dump 时 STW 5 秒，会断视频通话，怎么不 STW 抓堆？
3. **监管上报 24h 必达**：Arthas `watch` 加大接口耗时，怎么在低峰期使用？
4. **问诊订单缓存 100w Key**：Caffeine 内存占用怎么用 Arthas `vmtool` 直接查对象？
5. **生产 Full GC 1.2 秒 STW**：怎么用 GC 日志 + gceasy.io 5 分钟定位是 Humongous Region？

Day03 进入 OOM 排查实战，Day04 CPU 飙高排查，Day05 落到在线问诊系统 JVM 调优案例，Day06 串联故障复盘，Day07 深挖 ZGC。

---

## 题目一（工具链全解题）：JVM 诊断工具链实战

请详细回答以下问题：

1. **JDK 自带命令行工具全解**：`jps` / `jstat` / `jinfo` / `jmap` / `jstack` / `jcmd` / `jhat` 各自的作用与典型用法？`jstat -gcutil` 与 `jstat -gc` 的区别？`jmap -histo:live` 会触发什么？为什么不推荐 `jmap -dump:format=b,file=heap.bin` 而推荐 `jcmd PID GC.heap_dump`？`jstack -F` 与 `jstack -l` 的区别？`jstack` 抓不到死锁怎么办（`-F` 强制 / `kill -3` / Arthas thread）？JDK 11+ 为什么废弃 `jhat`，替代品是什么？JMC（Java Mission Control）的 jfr（Java Flight Recorder）相比 jstack/jmap 的优势？
2. **Arthas 在线诊断实战**：Arthas 的 `dashboard` / `thread` / `jad` / `watch` / `trace` / `stack` / `monitor` / `profiler` / `vmtool` / `ognl` / `heapdump` / `logger` / `vmoption` 各自的典型使用场景？`watch` 与 `trace` 的区别（一个是看入参返回值，一个是看方法调用链耗时）？`trace` 性能开销有多大，为什么线上不能长时间挂？`profiler` 生成火焰图的原理（async-profiler 基于 perf_events 与 AsyncGetCallTrace）？`vmtool` 怎么直接查询内存中的对象（如查所有 Caffeine Cache 实例）？Arthas 的 `redefine` / `retransform` 热更新字节码的原理与限制？Arthas 在 K8s Pod 中怎么用（kubectl exec vs javaagent）？
3. **堆内存分析 - MAT 实战**：Heap Dump（hprof）文件包含哪些信息？MAT 的 Histogram / Dominator Tree / Leak Suspects / Object Inspector 四大视图各自的作用？什么是 Shallow Size vs Retained Size，为什么找内存泄漏要看 Retained Size？什么是 GC Root，MAT 中如何按 GC Root 分类查找？MAT 的 `Path to GC Roots` / `Merge Shortest Paths` 的区别？怎么用 OQL（Object Query Language）查询特定对象？一个 4GB 的堆 dump 文件，MAT 需要多少内存分析？怎么处理 10GB+ 的大 dump（MAT 配置 -XX:+HeapDumpOnOutOfMemoryError / 离线分析 / 在线 MAT）？怎么识别"看似泄漏实则是缓存膨胀"的情况？
4. **线程与 CPU 分析 - jstack + 火焰图实战**：`top -Hp PID` 找到高 CPU 线程后，怎么用 `printf "%x\n" PID` 转换 + `jstack` 过滤定位代码？jstack 输出中 `RUNNABLE` / `BLOCKED` / `WAITING` / `TIMED_WAITING` 各自的含义？什么情况下会出现死锁（jstack 末尾会自动检测）？怎么用 `Arthas thread -n 3` 找 CPU 占用最高的 3 个线程？async-profiler 生成火焰图的两种模式（cpu / alloc）的区别？火焰图横向纵向分别代表什么？为什么说"火焰图宽的栈不一定是问题，但要重点关注宽且平的栈"？怎么用 `jfr`（Java Flight Recorder）做持续低开销采样？
5. **GC 日志分析与生产模板**：JDK 8 的 `-XX:+PrintGCDetails` / `-XX:+PrintGCDateStamps` / `-Xloggc:gc.log` 与 JDK 11+ 的 `-Xlog:gc*:file=gc.log:time,uptime,level,tags:filecount=10,filesize=50M` 的对应关系？一条典型 G1 Mixed GC 日志怎么解读（`[Pause (G1 Evacuation Pause) (young) (initial-mark) (mixed)` 各字段含义）？GC 日志中的 `Allocation Rate` / `Pause Time` / `Region Count` 怎么看？怎么用 GCViewer / gceasy.io 在线分析 GC 日志？怎么从 GC 日志判断是"Minor GC 频繁"还是"Mixed GC 慢"还是"Full GC 失败"？生产事故复盘模板：从 GC 日志到根因定位的 5 步法是什么？

### 作答区

#### 1. JDK 自带命令行工具全解

**JDK 自带命令行工具全景**：

| 工具 | 作用 | 典型用法 | 是否 STW | 是否触发 GC |
|------|------|---------|---------|------------|
| `jps` | 列出所有 Java 进程 | `jps -lvm` | 否 | 否 |
| `jstat` | 查看 GC / 类加载 / JIT 统计 | `jstat -gcutil PID 1000` | 否 | 否（仅读统计） |
| `jinfo` | 查看 / 修改 JVM 参数 | `jinfo -flag MaxHeapSize PID` | 否 | 否 |
| `jmap` | 堆内存分析（histo / dump） | `jmap -histo:live PID` | 是（histo:live 触发 Full GC） | 是 |
| `jstack` | 线程栈 dump | `jstack -l PID` | 否（除非 -F） | 否 |
| `jcmd` | 万能命令（JDK 7+ 推荐） | `jcmd PID GC.heap_dump` | 视命令而定 | 视命令而定 |
| `jhat` | 分析 hprof（已废弃） | `jhat heap.bin` | 否 | 否 |
| `JMC/JFR` | 持续低开销采样 | `jcmd PID JFR.start duration=60s filename=/tmp/r.jfr` | 否 | 否 |

**jps - 列出 Java 进程**：

```bash
# -l 显示主类全名，-v 显示 JVM 参数，-m 显示 main 方法参数
jps -lvm
# 输出示例：
# 12345 com.example.ImGatewayApplication -Xms4g -Xmx4g -XX:+UseG1GC
# 23456 sun.tools.jps.Jps -lvm
```

**容器内坑**：K8s Pod 中 `jps` 默认扫 `/tmp/hsperfdata_<user>`，如果 JVM 启动用户与 jps 用户不同（如 JVM 用 `app`，jps 用 `root`），会找不到 PID。解决：`jps -J-Djava.io.tmpdir=/tmp/hsperfdata_app` 或 `--system` 模式。

**jstat - GC / 类加载 / JIT 统计**：

```bash
# -gcutil 看 GC 百分比，1 秒刷新 10 次
jstat -gcutil PID 1000 10
#  S0     S1     E      O      M     CCS    YGC  YGCT   FGC FGCT   GCT
#  0.00  85.42  73.21  45.67  92.34  88.12   23  0.234   1  0.156  0.390

# -gc 看具体内存使用（KB）
jstat -gc PID 1000
#  S0C    S1C    S0U    S1U    EC     EU     OC     OU       MC     CCSC   YGC  YGCT
# 20480.0 20480.0 0.0   17480.0 163840.0 119822.3 409600.0 187213.5 78200.0 9420.0  23  0.234
```

**`jstat -gcutil` vs `jstat -gc` 区别**：

- `-gcutil`：百分比形式（O 列 85.42 = 老年代用了 85.42%），适合快速看健康度
- `-gc`：绝对值 KB（OU 列 187213 = 老年代已用 187MB），适合精确测算
- `-gccause`：额外显示最近一次 GC 原因（`LGCC`：上次 GC 原因，`GCC`：当前 GC 原因）
- `-gcnew` / `-gcold` / `-gcperm` / `-gcmetacapacity`：分代详情

**关键看什么**：

1. **O 列持续上涨不下降** -> 老年代内存泄漏
2. **FGC 次数快速增加** -> 频繁 Full GC，可能是泄漏或大对象
3. **GCT / 总时间 = 单次 GC 平均停顿** -> 如果单次 GC > 1s，业务必然抖动
4. **YGC 后 O 涨幅** -> 晋升速率，判断是否过早晋升

**jinfo - 查看 / 修改 JVM 参数**：

```bash
# 查看所有参数（含默认值）
jinfo -flags PID

# 查看具体参数
jinfo -flag MaxHeapSize PID
# -XX:MaxHeapSize=4294967296

# 修改参数（仅 Manageable 类型可改）
jinfo -flag +PrintGCDetails PID      # 运行时打开 GC 日志
jinfo -flag -PrintGCDetails PID      # 运行时关闭 GC 日志
```

**哪些参数能运行时改**：`jcmd PID VM.flags | grep manageable` 列出可改参数，主要是 GC 日志开关、`HeapDumpOnOutOfMemoryError`、`TraceClassLoading` 等诊断类。`-Xmx`、`-XX:+UseG1GC` 等核心参数**不能运行时改**，必须重启。

**jmap - 堆内存分析（坑最多）**：

```bash
# 1. 堆直方图，按对象类型统计
jmap -histo PID | head -20
#  num     #instances         #bytes  class name (module)
#  1:       1234567      1234567890  [B (byte[])
#  2:        987654       987654321  java.lang.String
#  3:        456789       234567890  java.util.HashMap$Node

# 2. 只看存活对象（会触发 Full GC！）
jmap -histo:live PID | head -20

# 3. 堆 dump（JDK 8 风格，不推荐）
jmap -dump:format=b,file=heap.bin PID

# 4. 堆 dump（强制，进程无响应时用，会触发 Full GC）
jmap -F -dump:format=b,file=heap.bin PID
```

**`jmap -histo:live` 会触发什么**：

- 触发一次 Full GC，**所有应用线程 STW**
- 线上无脑用会导致 P99 飙高甚至雪崩
- **正确用法**：先摘流量再用，或用 `jcmd PID GC.class_histogram`（功能等价但更稳定）

**为什么不推荐 `jmap -dump:format=b,file=` 而推荐 `jcmd PID GC.heap_dump`**：

1. **稳定性**：`jmap` 在某些 JDK 8 版本对大堆（>32GB）会卡死，`jcmd` 更稳定
2. **进度反馈**：`jcmd` 输出更友好（`Heap dump file created [/tmp/heap.bin, 1234567890 bytes] in 5.234s`）
3. **统一入口**：JDK 7+ 推荐 `jcmd` 作为万能命令，所有诊断操作统一入口
4. **可脚本化**：`jcmd PID GC.heap_dump -all` 包含 unreachable 对象，`jcmd PID GC.heap_dump` 默认只 dump reachable
5. **JDK 11+ 标准**：`jmap` 在 JDK 11+ 仍可用但**官方文档明确推荐 jcmd**

**jstack - 线程栈 dump**：

```bash
# 1. 默认 dump（推荐）
jstack -l PID > jstack.log
# -l 额外打印锁信息（ownable synchronizers）

# 2. 强制 dump（进程无响应时）
jstack -F PID > jstack.log

# 3. 除了 jstack，也可以用 kill -3
kill -3 PID
# 信号 SIGQUIT（3）会让 JVM 把所有线程栈打到 stdout
```

**`jstack -F` vs `jstack -l` 区别**：

| 选项 | 作用 | 副作用 | 适用场景 |
|------|------|--------|---------|
| 无 | 打印线程栈 | 无 | 普通诊断 |
| `-l` | 额外打印锁信息（额外加 ownable synchronizers） | 略慢（要遍历锁表） | 死锁分析、锁竞争分析 |
| `-F` | 强制（用 Serviceability Agent 连接） | 进程会被临时挂起，CPU 飙高 | 进程无响应、jstack 卡死 |
| `-m` | 混合模式（Java + Native 栈） | 很慢，需要本地符号表 | JNI 死锁、Native 卡死 |

**`jstack` 抓不到死锁怎么办**：

1. `-F` 强制模式：进程假死时普通 jstack 卡住，必须 -F
2. `kill -3 PID`：发送 SIGQUIT，JVM 把栈打到 stdout（需要在启动脚本重定向 stdout 到文件）
3. **Arthas `thread` 命令**：`thread -n 3` 找 CPU 最高线程，`thread -b` 找阻塞其他线程的"罪魁"，`thread <id>` 看具体线程栈
4. **JFR（Java Flight Recorder）**：`jcmd PID JFR.start duration=60s filename=/tmp/r.jfr`，60 秒后用 JMC 分析
5. **gcore + 离线 jstack**：`gcore PID` 生成 core 文件，`jstack -m core_file` 离线分析（极端情况）

**JDK 11+ 为什么废弃 `jhat`**：

- `jhat` 是 JDK 6 时代的 OQL 查询工具，基于 HTTP 服务，UI 极其简陋
- 处理大堆（>1GB）会 OOM
- JDK 9 标记 Deprecated，JDK 10 移除
- **替代品**：
  1. **Eclipse MAT**：业界标准，开源免费，支持 10GB+ 堆
  2. **JVisualVM**（JDK 8 内置，JDK 11+ 单独下载）：可视化但能力弱
  3. **JFR + JMC**：JDK 11+ 推荐方案，开销极低
  4. **在线 MAT**（heapdump.io）：浏览器上传 dump 文件分析，无需本地装工具

**JFR（Java Flight Recorder）相比 jstack/jmap 的优势**：

| 维度 | jstack / jmap | JFR |
|------|--------------|-----|
| 开销 | jmap dump STW 数秒 | 持续采样，开销 &lt; 1% |
| 数据 | 静态快照 | 时间序列（事件流） |
| 内容 | 仅线程栈 / 堆 | CPU / 内存 / GC / 锁 / IO / 方法耗时 |
| 触发 | 手动 | 可定时、可事件触发（如 OOM 前自动 dump） |
| 分析 | 文本 / MAT | JMC 可视化 |
| 历史 | 不可回放 | 可回放任意时间段 |

**JFR 典型用法**：

```bash
# 1. 启动 60 秒录制
jcmd PID JFR.start name=profile duration=60s filename=/tmp/r.jfr

# 2. 持续录制 + 自动滚动（适合生产长期开）
jcmd PID JFR.start name=continuous settings=profile maxage=1h maxsize=200M filename=/tmp/r.jfr

# 3. OOM 时自动 dump（启动参数）
-XX:StartFlightRecording=filename=/tmp/oom.jfr,settings=profile
-XX:+UnlockCommercialFeatures  # JDK 8 需要（商业特性），JDK 11+ 已开源无需此参数
```

**生产实战经验**：

1. **JDK 8 的 jmap 在 32GB+ 堆上经常卡死** -> 用 `jcmd PID GC.heap_dump` 替代
2. **K8s 容器内 jps 找不到进程** -> `jps -J-Djava.io.tmpdir=/tmp/hsperfdata_<user>`
3. **jstack -F 会临时挂起进程** -> 必须先摘流量
4. **JFR 在 JDK 8 是商业特性** -> 升级 JDK 11+ 后免费，强烈建议开启持续录制
5. **jinfo 修改 manageable 参数** -> 线上忘开 GC 日志时不用重启，`jinfo -flag +PrintGCDetails PID` 即可

#### 2. Arthas 在线诊断实战

**Arthas 命令全景**：

| 命令 | 作用 | 典型场景 | 性能开销 |
|------|------|---------|---------|
| `dashboard` | 实时面板（线程 / GC / 内存） | 快速看健康度 | 极低 |
| `thread` | 线程分析（CPU / 死锁 / 阻塞） | CPU 飙高、死锁定位 | 低 |
| `jad` | 反编译类（看实际加载版本） | 验证部署是否生效 | 低 |
| `watch` | 观察方法入参 / 返回值 / 异常 | 排查业务逻辑错误 | 中（每次匹配都触发） |
| `trace` | 方法调用链耗时分解 | 接口慢，找耗时方法 | 中-高（每个调用都计时） |
| `stack` | 查看方法被谁调用 | 找调用来源 | 中 |
| `monitor` | 方法调用统计（QPS / RT / 成功率） | 接口性能监控 | 低 |
| `profiler` | 生成火焰图（基于 async-profiler） | CPU / 内存热点定位 | 低 |
| `vmtool` | 直接查询堆内对象 | 查缓存实例、查特殊状态对象 | 中（强制扫描） |
| `ognl` | 执行 OGNL 表达式 | 调用静态方法、修改字段 | 低 |
| `heapdump` | 堆 dump（功能同 jmap） | 内存泄漏 | 高（STW） |
| `logger` | 动态修改日志级别 | 线上开 DEBUG 日志 | 极低 |
| `vmoption` | 查看 / 修改 VM 参数 | 运行时改 GC 日志 | 极低 |

**核心命令详解**：

**dashboard - 实时面板**：

```
dashboard
```

显示 3 个区域：
1. **线程区**：ID / NAME / GROUP / PRIORITY / STATE / CPU / DELTA_TIME / TIME / INTERRUPTED
2. **内存区**：heap / nonheap / gc_eden / gc_survivor / gc_old / gc_metaspace 的 used / total / max
3. **GC 区**：gc_(类型) 的 count / time

**thread - 线程分析**：

```bash
# 1. 找 CPU 占用最高的 3 个线程
thread -n 3

# 2. 找阻塞其他线程的"罪魁"线程
thread -b

# 3. 看具体线程栈
thread 1234

# 4. 找死锁
thread --state BLOCKED

# 5. 找等待锁的线程
thread --state WAITING
```

**`thread -b` 的妙用**：找出"持有锁不释放、阻塞大量线程"的元凶，本质是扫描所有 BLOCKED 线程的锁持有者，找出现频率最高的那个。

**jad - 反编译**：

```bash
# 反编译指定类
jad com.example.ImGatewayHandler

# 反编译指定方法
jad com.example.ImGatewayHandler handleMessage

# 关闭行号信息（输出更紧凑）
jad --source-only com.example.ImGatewayHandler
```

**典型场景**：线上 bug 是否真的修复了？发布后 `jad` 一下看实际加载的字节码是不是新版本。

**watch - 观察方法执行**：

```bash
# 观察 handleMessage 方法的入参和返回值
watch com.example.ImGatewayHandler handleMessage "{params, returnObj}" -x 2

# 观察抛异常的情况
watch com.example.ImGatewayHandler handleMessage "{params, throwExp}" -e

# 观察方法耗时（condition 表达式过滤）
watch com.example.ImGatewayHandler handleMessage "{params, returnObj}" "#cost > 100" -x 2

# 观察内部字段
watch com.example.ImGatewayHandler handleMessage "{target.cache.size, params, returnObj}" -x 3
```

**watch 表达式语法**：
- `params`：方法入参数组
- `returnObj`：返回值
- `throwExp`：抛出的异常
- `target`：方法所属对象
- `#cost`：方法耗时（毫秒）
- `-x N`：展开层级（默认 1，复杂对象要展开到 2-3 层）
- `-e`：仅在抛异常时触发
- `-s`：仅在正常返回时触发
- condition 表达式：`#cost > 100`、`params[0].length > 10` 等

**trace - 方法调用链耗时**：

```bash
# 跟踪 handleMessage 方法的所有子调用耗时
trace com.example.ImGatewayHandler handleMessage

# 跳过 JDK 方法
trace com.example.ImGatewayHandler handleMessage --skipJDKMethod true

# 过滤耗时 > 50ms 的调用
trace com.example.ImGatewayHandler handleMessage "#cost > 50"

# 限制调用次数（避免长时间挂）
trace com.example.ImGatewayHandler handleMessage -n 5
```

**`watch` 与 `trace` 的区别**：

| 维度 | watch | trace |
|------|-------|-------|
| 关注点 | 方法**自身**的入参/返回值/异常 | 方法**调用链**每个子方法的耗时 |
| 输出 | JSON 格式的对象 | 树形耗时图 |
| 典型场景 | 业务逻辑错误排查 | 接口慢，找瓶颈方法 |
| 性能开销 | 每次匹配触发一次（中等） | 每个子调用都插桩（高） |
| 适合时长 | 可长时间挂（开销可控） | 不能长时间挂（开销线性增长） |

**`trace` 性能开销有多大**：

- 每个 method entry / exit 都插桩（字节码增强）
- 1000 QPS 的方法挂 `trace` 1 分钟，可能让接口 RT 从 50ms 涨到 200ms
- **生产用法**：
  1. `trace -n 5` 限制只看前 5 次调用
  2. `trace "#cost > 50"` 只看慢调用
  3. 低峰期使用
  4. 用完立即 `stop` 关闭

**profiler - 火焰图**：

```bash
# 1. CPU 火焰图，采样 60 秒
profiler start
# 等 60 秒
profiler stop --format html --file /tmp/cpu.html

# 2. 内存分配火焰图
profiler start --event alloc
profiler stop --file /tmp/alloc.html

# 3. 锁采样
profiler start --event lock
profiler stop --file /tmp/lock.html
```

**原理**：基于 async-profiler，底层用 Linux `perf_events` 采样 CPU，结合 JVM `AsyncGetCallTrace` 获取 Java 栈。开销 &lt; 1%，可生产长开。

**vmtool - 直接查询堆内对象**：

```bash
# 查所有 Caffeine Cache 实例
vmtool --action getInstances --className com.github.benmanes.caffeine.cache.BoundedLocalCache --limit 10

# 查某个实例的字段
vmtool --action getInstances --className com.example.OrderCache --express 'instances[0].cache.size()'

# 强制 GC
vmtool --action forceGc

# 查线程上下文类加载器
vmtool --action getInstances --className java.lang.ClassLoader
```

**典型场景**：
- 查 Caffeine 缓存实例大小（不用 dump 堆）
- 查自定义连接池的活跃连接数
- 验证单例是否真的只有一个实例

**ognl - 执行 OGNL 表达式**：

```bash
# 调用静态方法
ognl '@java.lang.System@currentTimeMillis()'

# 调用 Spring Bean 的方法
ognl '@org.springframework.web.context.ContextLoader@getCurrentWebApplicationContext().getBean("orderCache").size()'

# 修改静态字段
ognl '@com.example.Config@DEBUG = true'

# 读取静态字段
ognl '@com.example.Config@DEBUG'
```

**典型场景**：
- 不重启服务修改日志级别：`ognl '@org.slf4j.LoggerFactory@getLogger("com.example").setLevel(org.slf4j.event.Level.DEBUG)'`（或直接用 `logger` 命令）
- 调用 Spring Bean 的方法验证状态
- 修改配置项（volatile 字段）

**logger - 动态修改日志级别**：

```bash
# 查看所有 logger 的级别
logger

# 修改 com.example 包的日志级别为 DEBUG
logger --name com.example --level DEBUG

# 修改 root logger
logger --name ROOT --level INFO
```

**`redefine` / `retransform` 热更新字节码**：

```bash
# 1. 反编译
jad --source-only com.example.ImGatewayHandler > /tmp/ImGatewayHandler.java

# 2. 修改源码（在容器内或本地）

# 3. 编译
mc /tmp/ImGatewayHandler.java -d /tmp

# 4. 重新加载
redefine /tmp/com/example/ImGatewayHandler.class
```

**原理**：基于 JDK Instrumentation API 的 `redefineClasses`，直接替换 JVM 中已加载的类的字节码。

**限制**：
1. **不能改方法签名**（增删方法、改参数、改返回值都不行）
2. **不能改字段**（增删字段都不行）
3. **不能改继承关系**
4. **只能改方法体**
5. **被改的类如果有正在执行的方法，旧版本会执行完才生效**
6. **反复 redefine 会导致 PermGen / Metaspace 膨胀**（JDK 8 的 PermGen 会爆，JDK 11+ 的 Metaspace 也会累积）

**Arthas 在 K8s Pod 中怎么用**：

| 方式 | 命令 | 优点 | 缺点 |
|------|------|------|------|
| `kubectl exec` | `kubectl exec -it pod -- java -jar arthas-boot.jar` | 不改镜像 | 需要 JDK 在镜像里；Pod 重启 Arthas 丢失 |
| init container 注入 | 启动时下载 Arthas | 自动化 | 增加启动时间 |
| javaagent | 启动时 `-javaagent:arthas-agent.jar` | 持久 | 改启动脚本 |
| **sidecar 容器** | 同 Pod 跑 Arthas 容器，通过共享进程命名空间连接 | 不污染业务容器 | 需要 K8s 1.12+ 共享 PID namespace |
| **远程连接** | 业务容器开 Arthas tunnel，本地用 arthas-tunnel-client 连 | 本地分析，不污染容器 | 需打通网络 |

**生产推荐**：sidecar 模式 + tunnel server 集中管理。本地 IDE + Arthas 远程连接，体验最好。

#### 3. 堆内存分析 - MAT 实战

**Heap Dump（hprof）文件包含哪些信息**：

1. **所有对象**：实例数据（字段值）、对象头、类型指针
2. **所有类**：类名、字段定义、继承关系
3. **GC Roots**：栈引用、静态字段、JNI 全局引用等
4. **线程栈**：每个线程的栈帧、局部变量
5. **finalize 队列**：等待执行 finalize 的对象
6. **系统属性**：JVM 启动参数、系统属性

**不包含**：
- 方法区字节码（只存类元数据引用）
- JIT 编译后的本地代码
- 堆外内存（直接内存、NIO Buffer）

**MAT 四大视图**：

| 视图 | 作用 | 典型用法 |
|------|------|---------|
| **Histogram** | 按类统计对象数和大小 | 找"哪类对象最多" |
| **Dominator Tree** | 按对象引用关系（支配关系）排序 | 找"哪个对象独占最大内存" |
| **Leak Suspects** | 自动分析疑似泄漏点 | 第一步快速定位 |
| **Object Inspector** | 查看具体对象的字段值 | 验证猜测 |

**Shallow Size vs Retained Size**：

| 维度 | Shallow Size | Retained Size |
|------|--------------|---------------|
| 含义 | 对象自身占用的字节数（对象头 + 字段） | 对象被回收后能释放的总内存 |
| 计算 | 对象头 + 实例字段（不含引用指向的对象） | Shallow Size + 所有仅被该对象支配的对象的 Shallow Size |
| 典型值 | HashMap 对象本身 48 字节 | HashMap + 所有 Node + 所有 key/value 可能 100MB |
| 找泄漏看哪个 | **看 Retained** | 因为释放它才能释放最大内存 |

**关键认知**：找内存泄漏**永远看 Retained Size**。一个 ArrayList 对象本身才 24 字节，但里面装了 1GB 数据，Retained Size 就是 1GB。

**GC Root 分类**：

| GC Root 类型 | 说明 | MAT 标识 |
|-------------|------|---------|
| **虚拟机栈引用** | 方法局部变量 | `Thread Block` |
| **静态字段** | 类的 static 字段 | `System Class` |
| **本地方法栈引用** | JNI 局部变量 | `Native Stack` |
| **JNI 全局引用** | JNI 全局表 | `JNI Global` |
| **同步监视器** | synchronized 持有的对象 | `Busy Monitor` |
| **Java 虚拟机内部** | 系统类加载器等 | `System Class` |

**MAT 按 GC Root 分类查找**：

1. 选对象 -> `Path To GC Roots` -> `exclude weak/soft references`（排除弱引用软引用，因为它们不算泄漏）
2. 看路径上的对象链，找到 GC Root
3. 典型泄漏路径：`Thread -> XxxService -> HashMap -> 大量对象`

**`Path to GC Roots` vs `Merge Shortest Paths`**：

| 操作 | 含义 | 适用场景 |
|------|------|---------|
| `Path To GC Roots` | 单个对象到所有 GC Roots 的路径 | 验证猜测（已知泄漏对象） |
| `Merge Shortest Paths` | 多个对象到 GC Roots 的合并最短路径 | 找共性（多个对象都被同一个 Root 持有） |

**OQL（Object Query Language）查询**：

```sql
-- 查所有 String 对象
SELECT * FROM java.lang.String

-- 查长度 > 1000 的 String
SELECT * FROM java.lang.String s WHERE s.@retainedHeapSize > 1000

-- 查所有 HashMap 实例的 size
SELECT s.size FROM java.util.HashMap s

-- 查所有 ThreadLocal 的 value
SELECT tl.value FROM java.lang.ThreadLocal tl

-- 联合查询：所有 Caffeine Cache 的 size
SELECT c.size() FROM com.github.benmanes.caffeine.cache.BoundedLocalCache c
```

**OQL 语法**：类似 SQL，但 `@` 前缀访问 MAT 内置属性（`@retainedHeapSize`、`@usedHeapSize`、`@objectAddress`）。

**MAT 内存配置**：

```
# 一个 4GB 的堆 dump，MAT 需要 8GB 内存（dump 文件大小的 2 倍）
# 修改 MemoryAnalyzer.ini
-Xmx8g
-XX:+UseG1GC
```

**经验法则**：MAT 内存 = dump 文件大小 × 2。4GB dump 用 8GB MAT，10GB dump 用 20GB MAT，否则会 OOM。

**处理 10GB+ 大 dump 的方法**：

1. **MAT 配置大内存**：`MemoryAnalyzer.ini` 设 `-Xmx20g` 以上
2. **关闭"解析时计算 Retained Size"**：改为按需计算（`Preferences > Memory Analyzer > "Compute precise retained size"`）
3. **使用"对象引用树懒加载"**：MAT 默认全索引，大 dump 要 30 分钟；用 `--loader` 离线模式
4. **离线分析**：把 dump 拉到本地 32GB 内存的开发机分析
5. **在线 MAT**（heapdump.io）：浏览器上传，云端分析（不适合敏感数据）
6. **用 jmap -histo 先定位**：先 `jmap -histo:live PID` 看哪类对象大，再针对性 dump

**识别"看似泄漏实则是缓存膨胀"**：

典型现象：
1. Leak Suspects 报告指向 `Caffeine` / `ConcurrentHashMap` / `HashMap`
2. 这些 Map 的 key 是业务对象（如 userId、orderId）
3. 业务方说"缓存设了过期但内存还是涨"

排查步骤：
1. **查缓存配置**：`vmtool --action getInstances --className com.github.benmanes.caffeine.cache.BoundedLocalCache --express 'instances[0].policy'` 看 maximumSize / expireAfterWrite
2. **查缓存实际大小**：`ognl '@com.example.OrderCache@CACHE.estimatedSize()'`
3. **看 Retained Size 是否合理**：100w Key × 1KB value = 1GB，是预期吗
4. **看 key 分布**：用 OQL `SELECT s FROM com.example.OrderKey s` 取前 1000 个 key 看分布，是不是异常大量重复
5. **看 expireAfterWrite 是否生效**：在 MAT 里看对象的 creation time（如果对象有 timestamp 字段）

**典型假泄漏**：
- Caffeine maximumSize 配置错误（设成 maximumWeight 但没设 weigher）
- ThreadLocal 没清理（线程池复用导致 ThreadLocal 累积）
- HashMap 键冲突（equals/hashCode 实现错误，导致同一对象塞多份）

**生产实战经验**：

1. **MAT 第一次打开大 dump 要 30 分钟**：让它跑完，不要中断，否则索引损坏
2. **优先看 Leak Suspects**：自动分析准确率 70%+，能快速定位嫌疑
3. **Retained Size 排序找 Top 1**：Dominator Tree 按 Retained 排序，第一名通常就是元凶
4. **导出报告**：`Leak Suspects Report` 可导出 HTML，便于团队复盘
5. **结合 jstack 看**：哪个线程持有泄漏对象的引用，往往就是元凶线程

#### 4. 线程与 CPU 分析 - jstack + 火焰图实战

**经典 CPU 飙高定位流程（5 步）**：

```bash
# 1. 找到 Java 进程
jps -lvm
# 12345 com.example.ImGatewayApplication

# 2. 找到 CPU 最高的线程（top -H 显示线程级 CPU）
top -Hp 12345
#   PID    USER  PR  NI    VIRT    RES    SHR S %CPU %MEM    TIME+ COMMAND
#  12389    app  20   0  4.5g   2.3g  50m  R 95.3  3.5   1:23.4 java
#  12390    app  20   0  4.5g   2.3g  50m  R 23.1  3.5   0:15.6 java

# 3. 把线程 PID 转成 16 进制（jstack 中 nid 是 16 进制）
printf "%x\n" 12389
# 3065

# 4. jstack 抓栈并过滤
jstack -l 12345 > /tmp/jstack.log
grep -A 30 "nid=0x3065" /tmp/jstack.log

# 5. 看栈顶方法
# "NettyClientHandler-1" #50 prio=5 os_prio=0 tid=0x... nid=0x3065 runnable
#    java.lang.Thread.State: RUNNABLE
#        at com.example.HeavyComputeService.calculate(HeavyComputeService.java:45)
#        at com.example.ImGatewayHandler.handleMessage(ImGatewayHandler.java:78)
```

**5 步法的关键点**：

1. **`top -Hp`** 的 `-H` 表示按线程显示
2. **`printf "%x\n"`** 把 10 进制 PID 转成 16 进制
3. **jstack 的 nid** 是 16 进制线程 ID，对应 OS 的 `gettid()`
4. **grep -A 30** 显示匹配行后 30 行（栈通常 10-30 行）
5. **栈顶方法** = 当前正在执行的方法（如果一直显示同一行，就是死循环）

**jstack 输出线程状态详解**：

| 状态 | 含义 | 常见原因 |
|------|------|---------|
| `RUNNABLE` | 可运行（可能正在执行也可能在等 CPU） | 正常业务、死循环、计算密集 |
| `BLOCKED` | 等待 synchronized 锁 | 锁竞争激烈 |
| `WAITING` | 无限等待（Object.wait / Lock.await / Thread.join） | 线程池空闲、生产者-消费者等待 |
| `TIMED_WAITING` | 限时等待（sleep / wait(timeout) / parkNanos） | 限流等待、定时任务 |
| `TERMINATED` | 已退出 | 正常结束 |

**关键认知**：
- `RUNNABLE` 不等于"正在用 CPU"，可能只是"可调度"。看 `top -Hp` 的 %CPU 才知道是否真用 CPU
- `BLOCKED` 持续不消失 = 死锁或锁饥饿
- 大量 `WAITING` 线程不一定是问题（线程池空闲正常）

**死锁检测**：

jstack 末尾会自动检测死锁，输出：

```
Found one Java-level deadlock:
=============================
"Thread-1":
  waiting to lock monitor 0x... (object 0x..., a java.lang.Object),
  which is held by "Thread-2"
"Thread-2":
  waiting to lock monitor 0x... (object 0x..., a java.lang.Object),
  which is held by "Thread-1"

Java stack information for the threads listed above:
===================================================
"Thread-1":
  at com.example.Deadlock.method1(Deadlock.java:10)
  - waiting to lock <0x...> (a java.lang.Object)
  - locked <0x...> (a java.lang.Object)
"Thread-2":
  at com.example.Deadlock.method2(Deadlock.java:20)
  - waiting to lock <0x...> (a java.lang.Object)
  - locked <0x...> (a java.lang.Object)

Found 1 deadlock.
```

**注意**：jstack 只能检测**synchronized 死锁**。`ReentrantLock` 死锁不会自动检测，需要用 `Arthas thread -b` 或 `thread --state WAITING` 人工分析。

**Arthas thread 命令实战**：

```bash
# 1. 找 CPU 占用最高的 3 个线程（按 5 秒内 CPU 增量排序）
thread -n 3
# 输出示例：
# threadId=50 threadName=NettyClientHandler-1 cpu=95.3% deltaTime=200ms time=1:23.4
#   at com.example.HeavyComputeService.calculate(HeavyComputeService.java:45)

# 2. 找阻塞其他线程的"罪魁"线程
thread -b
# 找出持有锁不释放、阻塞大量线程的元凶

# 3. 找死锁
thread --state BLOCKED

# 4. 看具体线程栈
thread 50
```

**async-profiler 火焰图**：

```bash
# CPU 火焰图
./profiler.sh -d 60 -f /tmp/cpu.html <PID>
# -d 60：采样 60 秒
# -f /tmp/cpu.html：输出 HTML 火焰图

# 内存分配火焰图
./profiler.sh -d 60 -e alloc -f /tmp/alloc.html <PID>

# 锁采样
./profiler.sh -d 60 -e lock -f /tmp/lock.html <PID>

# Wall clock 模式（适合 IO 密集）
./profiler.sh -d 60 -e wall -f /tmp/wall.html <PID>
```

**两种模式区别**：

| 模式 | 事件 | 适合场景 | 注意 |
|------|------|---------|------|
| `cpu`（默认） | CPU 周期 | CPU 密集型应用找热点 | 看不出等待 IO 的时间 |
| `alloc` | 内存分配 | 找分配压力大的方法 | 配合 GC 调优 |
| `lock` | 锁竞争 | 锁分析 | 找锁持有者 |
| `wall` | 挂钟时间 | IO 密集、慢接口 | 包含等待时间，火焰图更"宽" |

**火焰图解读**：

```
┌──────────────────────────────────────────────┐
│ main                                         │
│ ├────────────────────────────────┬────────── │
│ │ handleMessage                  │ doFilter  │
│ │ ├──────────────┬────────────── │           │
│ │ │ parseJson    │ queryOrder    │           │
│ │ │              ├──────┬─────── │           │
│ │ │              │ db   │ redis  │           │
│ └──────────────┴──────┴─────── ┴────────── │
└──────────────────────────────────────────────┘
   ↑              ↑              ↑
   父方法       子方法         孙方法
```

- **横向（X 轴）**：方法调用栈，从下往上 = 调用关系
- **纵向（Y 轴）**：采样次数（宽度）= CPU 占用时间
- **宽度**：方法被采样到的次数，越宽越占 CPU
- **颜色**：通常无意义（Java 火焰图按包名着色）

**关键判断标准**：

1. **宽且平的栈** = 多个不同方法都占 CPU，正常业务
2. **宽且尖的栈（一个方法特别宽）** = 这个方法是热点，需要优化
3. **顶部很宽** = CPU 浪费在叶子方法
4. **底部很宽** = 调用入口被频繁触发

**典型火焰图模式识别**：

| 模式 | 含义 | 优化方向 |
|------|------|---------|
| 顶部一个尖峰 | 单一方法占 80%+ CPU | 优化该方法（算法、缓存） |
| 多个均匀尖峰 | 多方法各占 10-20% | 难优化，需架构级调整 |
| 底部宽 + 中间空 | 频繁调用但中间无热点 | 减少调用次数（限流、批量化） |
| 大量 `JIT` 调用 | JIT 编译占用 | 预热不充分，提高编译阈值 |
| 大量 `GC` 调用 | GC 占 CPU | 内存调优 |

**JFR 持续低开销采样**：

```bash
# 1. 持续录制（适合生产长开）
jcmd PID JFR.start name=continuous settings=profile maxage=1h maxsize=200M filename=/var/log/jfr/continuous.jfr

# 2. 抓 1 分钟录制
jcmd PID JFR.start name=profile duration=60s filename=/tmp/profile.jfr settings=profile

# 3. dump 当前录制
jcmd PID JFR.dump name=continuous filename=/tmp/dump.jfr

# 4. 停止录制
jcmd PID JFR.stop name=continuous
```

**JFR 的优势**：

1. **开销 &lt; 1%**：基于事件而非轮询
2. **时间序列**：能回放任意时间段
3. **多维数据**：CPU / 内存 / GC / 锁 / IO / 方法耗时都有
4. **OOM 自动 dump**：`-XX:StartFlightRecording=...,filename=/tmp/oom.jfr` 配合 `-XX:+HeapDumpOnOutOfMemoryError`

**生产实战经验**：

1. **CPU 飙高先用 `top -Hp` 而不是 jstack**：避免 jstack 抓的栈恰好不在热点
2. **采样至少 30 秒**：单次 jstack 是瞬时快照，可能误判
3. **死锁检测优先用 Arthas**：`thread -b` 比 jstack 自动检测更准
4. **火焰图必看 5 分钟以上**：短采样统计意义不大
5. **JFR 长开**：JDK 11+ 必备，OOM 时自动留下"黑匣子"

#### 5. GC 日志分析与生产模板

**JDK 8 vs JDK 11+ GC 日志参数对应**：

| 功能 | JDK 8 | JDK 11+ |
|------|-------|---------|
| 打印 GC 详情 | `-XX:+PrintGCDetails` | `-Xlog:gc*` 或 `-Xlog:gc=debug` |
| 打印时间戳 | `-XX:+PrintGCDateStamps` | `-Xlog:gc*:time` |
| 打印 GC 原因 | `-XX:+PrintGCCause` | 默认打印 |
| 打印应用暂停时间 | `-XX:+PrintGCApplicationStoppedTime` | `-Xlog:safepoint` |
| 打印 GC 大小详情 | `-XX:+PrintAdaptiveSizePolicy` | `-Xlog:gc+ergo*=trace` |
| 输出到文件 | `-Xloggc:gc.log` | `-Xlog:gc*:file=gc.log` |
| 文件滚动 | `-XX:+UseGCLogFileRotation -XX:NumberOfGCLogFiles=10 -XX:GCLogFileSize=50M` | `-Xlog:gc*:file=gc.log:filecount=10,filesize=50M` |

**JDK 11+ 统一日志（Xlog）语法**：

```
-Xlog:<tags>[=<level>][:<output>][:<decorators>][:<file-options>]

# 示例
-Xlog:gc*:file=gc.log:time,uptime,level,tags:filecount=10,filesize=50M
```

- `gc*`：所有 gc 相关 tag
- `:time,uptime,level,tags`：装饰器（时间、运行时长、日志级别、tag）
- `:filecount=10,filesize=50M`：10 个文件，每个 50MB 滚动

**G1 Mixed GC 日志解读**：

JDK 8 风格：
```
2016-08-04T14:30:15.234+0800: 1234.567: [GC pause (G1 Evacuation Pause) (mixed) (young) (initial-mark), 0.0234567 secs]
   [Eden: 100M->0B(100M) Survivors: 10M->10M Total: 1.5G->1.2G(4G)]
   [Times: user=0.15 sys=0.02, real=0.02 secs]
```

JDK 11+ 风格：
```
[2026-08-04T14:30:15.234+0800][1234.567s][info][gc] GC(42) Pause Young (Concurrent Start) (G1 Evacuation Pause)
[2026-08-04T14:30:15.257+0800][1234.590s][info][gc] GC(43) Concurrent Cycle
[2026-08-04T14:30:15.289+0800][1234.622s][info][gc] GC(43) Pause Young (Mixed) (G1 Evacuation Pause) 1500M->1200M(4096M) 23.456ms
```

**关键字段含义**：

| 字段 | 含义 |
|------|------|
| `G1 Evacuation Pause` | 疏散暂停（拷贝存活对象到新 Region） |
| `(young)` | 仅 Young Region 参与 |
| `(mixed)` | Young + 部分 Old 参与 |
| `(initial-mark)` | 伴随并发标记启动（Mixed GC 的标记开始） |
| `(Concurrent Start)` | JDK 11+ 表述，等同 initial-mark |
| `1500M->1200M(4096M)` | GC 前使用 -> GC 后使用（堆总大小） |
| `23.456ms` | 本次 GC 耗时 |
| `user=0.15 sys=0.02, real=0.02` | 用户态 / 内核态 / 实际时间 |

**GC 日志中的关键指标**：

1. **Allocation Rate**：Eden 区每秒分配多少 MB（JDK 8 看 `Allocation Rate`，JDK 11+ 看 `Alloc Regions` + 时间差计算）
   - 健康：&lt; 500MB/s
   - 警告：500MB/s - 2GB/s
   - 危险：> 2GB/s（Minor GC 极频繁）

2. **Pause Time**：单次 GC 停顿
   - G1 健康：&lt; 100ms
   - G1 警告：100ms - 500ms
   - G1 危险：> 500ms（业务必然抖动）

3. **Region Count**：参与回收的 Region 数
   - Mixed GC 中回收 Old Region 数量
   - 如果一直为 0，说明 Mixed GC 没回收 Old，Old 一直涨 -> Full GC

4. **Concurrent Cycle 频率**：并发标记周期
   - 健康：每 5-10 分钟一次
   - 警告：每 1-2 分钟一次（IHOP 设低了或 Old 增长太快）
   - 危险：每 30 秒一次（Old 增长失控）

**GCViewer / gceasy.io 在线分析**：

| 工具 | 类型 | 优点 | 缺点 |
|------|------|------|------|
| **GCViewer** | 开源本地 | 离线、可集成 CI | UI 简陋 |
| **gceasy.io** | 在线 SaaS | UI 漂亮、自动给出调优建议 | 数据上传到第三方（敏感数据慎用） |
| **JDK Mission Control** | 桌面 | 与 JFR 集成 | 学习曲线陡 |
| **GCEasy API** | API | 可自动化分析 | 收费 |

**gceasy.io 关键指标**：

1. **Throughput**：吞吐量 = 业务时间 / 总时间，应 > 95%
2. **Average Pause**：平均 GC 停顿，应 &lt; 100ms
3. **Max Pause**：最大停顿，应 &lt; 500ms
4. **GC Cause 分布**：看 GC 原因分布（Allocation Failure / System.gc / Metadata GC Threshold）
5. **Heap Trend**：堆使用趋势，看是否"锯齿状"（健康）还是"楼梯状"（泄漏）

**从 GC 日志判断问题类型**：

| 现象 | 推断 | 验证 |
|------|------|------|
| Minor GC 频繁（> 1次/秒） | Eden 太小或分配速率过高 | 看 Allocation Rate + Eden Size |
| Mixed GC 单次时间长（> 500ms） | Old Region 多、存活率高 | 看 Region Count + Survivors |
| Full GC 频繁 | 老年代膨胀或 Metaspace 满 | 看 Old Used + Metaspace Used |
| Full GC 失败（`to-space exhausted`） | 疏散失败，Survivor 或 to-space 不够 | 看 G1ReservePercent + SurvivorRatio |
| `Concurrent Mode Failure`（CMS） | CMS 并发标记跟不上，退化为 Serial Old | 看 CMS 旧堆占比 + Concurrent GC 线程数 |
| `System.gc` 触发的 Full GC | 显式调用 System.gc | 看 RMI 框架 / Direct ByteBuffer 清理 |

**生产事故复盘模板：5 步法**：

```
Step 1: 现象描述
  - 时间、影响范围、业务指标
  - 监控截图：GC 频率、堆使用率、CPU、P99

Step 2: 日志采集
  - GC 日志（最近 1 小时）
  - jstack / jmap dump
  - 系统日志（dmesg / oom-killer）

Step 3: 日志分析
  - GC 频率变化点
  - Full GC 触发原因（Allocation Failure / System.gc / Metaspace）
  - 堆使用趋势（楼梯状 = 泄漏，锯齿状 = 配置问题）

Step 4: 根因定位
  - 内存泄漏：MAT 看 Dominator Tree Top 1
  - 大对象：jmap -histo 看 byte[] / char[] Top 1
  - 配置问题：参数检查（如 -Xmn 设小了、IHOP 设高了）
  - 流量异常：业务监控对照（是否有营销活动 / 重试风暴）

Step 5: 修复与预防
  - 止血：重启 / 限流 / 扩容
  - 根因修复：PR 修复 bug / 调整参数 / 加监控告警
  - 复盘文档：故障时间线、根因、改进项
  - 知识沉淀：更新 JVM 调优 Checklist
```

**生产实战经验**：

1. **GC 日志必开**：`-Xlog:gc*:file=gc.log:time,uptime,level,tags:filecount=10,filesize=50M` 是生产必备
2. **OOM 自动 dump**：`-XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/data/dump/` 救命配置
3. **System.gc 屏蔽**：`-XX:+DisableExplicitGC`（但注意 Direct ByteBuffer 清理会失效，要配合 `-XX:+ExplicitGCInvokesConcurrently`）
4. **GC 日志滚动**：避免日志撑爆磁盘
5. **GC 日志实时分析**：Filebeat 采集到 ES + Kibana，做 GC 监控告警

---

## 题目二（场景应用题）：5 分钟定位线上 Full GC 元凶

> **场景**：在线问诊系统生产环境，某天 14:30 开始告警频繁：接口 P99 从 80ms 飙到 3.2s，业务方反馈"问诊发起"接口偶发超时。登录监控看到：
> - 4C8G Pod，JVM 参数 `-Xms6g -Xmx6g -XX:+UseG1GC -XX:MaxGCPauseMillis=100`
> - GC 监控：Full GC 频率从 0.1 次/小时 涨到 5 次/分钟，每次 STW 1.2-1.8s
> - 堆使用率：从 60% 涨到 92%，老年代占 85%
> - CPU：GC 线程占 70% CPU，业务线程仅 30%
> - 内存：Pod RSS 7.2G（接近 limit 8G），无 OOM kill
>
> **要求**：在 5 分钟内定位 Full GC 元凶，并给出止血 + 根因方案。

### 作答区

#### 第 1 分钟 - 止损决策

**核心原则**：**先止血再定位，抓现场优先于重启**。

**判断流程**：

```
Full GC 5 次/分钟 × 1.5s STW = 7.5s/分钟 STW = 12.5% 时间在 STW
P99 3.2s 已严重影响业务
```

**止损优先级**：

1. **第一选择：摘流量 + 抓现场**（最佳）
   - 在 K8s 里给 Pod 打 `kubectl cordon` + `kubectl drain`，让 LB 摘除该 Pod
   - 服务注册中心（Nacos）摘节点：`curl -X POST http://nacos/v1/ns/instance?serviceName=xxx&ip=xxx&enabled=false`
   - **关键**：摘流量后服务还在，可以慢慢抓 dump

2. **第二选择：限流降级**（如果摘流量做不到）
   - Sentinel 限流"问诊发起"接口到 10 QPS
   - 触发降级返回"系统繁忙，请稍后重试"

3. **第三选择：扩容**（如果根因是流量突增）
   - HPA 自动扩容 +10 Pod
   - 但如果是泄漏，扩容只是延缓

4. **最后选择：重启**（如果以上都不行）
   - **风险**：丢失现场，无法定位根因，下次还会复现
   - **必须先做的事**：jstack + jmap dump

**为什么不能直接重启**：

1. **GC 日志能看到，但堆内存看不到**：Full GC 元凶在堆里，重启就丢失
2. **可能复现**：不修根因，重启后 30 分钟又出问题
3. **复盘需要证据**：故障复盘没证据，等于白复盘

**正确做法**：

```
0:00 - 摘流量（10 秒）
0:10 - 抓 jstack（5 秒，不 STW）
0:15 - 抓 jmap dump（30 秒，会 STW 但已摘流量）
0:45 - 抓 GC 日志最后 1 小时（10 秒）
0:55 - 此时现场已抓完，可以决定重启或继续
```

#### 第 2 分钟 - 抓现场

**抓现场命令清单**：

```bash
# 1. 确认 PID
jps -lvm
# 12345 com.example.ConsultApplication

# 2. 抓 jstack（不 STW）
jstack -l 12345 > /tmp/jstack_$(date +%s).log

# 3. 抓 GC 日志（如果已开 Xlog）
cp /data/logs/gc.log /tmp/gc_$(date +%s).log

# 4. 抓 heap dump（会 STW，但已摘流量）
jcmd 12345 GC.heap_dump /tmp/heap_$(date +%s).bin
# 输出：Heap dump file created [/tmp/heap_1785234567.bin, 4567890123 bytes] in 8.234s

# 5. 抓对象直方图（轻量，先看个大概）
jcmd 12345 GC.class_histogram > /tmp/histo_$(date +%s).log

# 6. 如果有 Arthas，开 JFR 录制
jcmd 12345 JFR.start name=incident duration=5m filename=/tmp/incident.jfr
```

**`jcmd GC.heap_dump` 会 STW 多久**：

| 堆大小 | STW 时长 | 备注 |
|--------|---------|------|
| 1GB | 1-2 秒 | 正常 |
| 4GB | 5-10 秒 | 已摘流量可接受 |
| 8GB | 15-30 秒 | 必须摘流量 |
| 32GB | 1-5 分钟 | 建议改用 JFR |

**关键认知**：dump 时长 ≈ 堆大小 / 100MB/s（受磁盘 IO 限制）。

**Arthas `heapdump` vs `jmap`/`jcmd`**：

| 命令 | 原理 | 优势 | 劣势 |
|------|------|------|------|
| `jmap -dump:format=b,file=` | JDK 自带 | 通用 | JDK 8 大堆卡死风险 |
| `jcmd PID GC.heap_dump` | JDK 自带 | 稳定 | JDK 8 早期版本不支持 |
| `Arthas heapdump` | 包装 jcmd | 输出友好 | 多一层代理 |
| `Arthas heapdump --live` | 包装 jmap -histo:live | 触发 GC 后 dump | 会 Full GC |

**避免抓 dump 引发雪崩**：

1. **必须先摘流量**：摘流量后即使 STW 30 秒，业务无感知
2. **分批抓**：集群 10 台只抓 1 台
3. **指定路径**：dump 到 `/data/dump/`（专门挂大盘），不要 dump 到容器 rootfs
4. **磁盘预留**：dump 文件 ≈ 堆大小，6G 堆要预留 7G 磁盘
5. **OOM 时自动 dump**：`-XX:+HeapDumpOnOutOfMemoryError` 配置好，下次 OOM 自动留下 dump

#### 第 3 分钟 - 看日志

**GC 日志 30 秒定位元凶类型**：

```bash
# 看最近 100 行 GC 日志
tail -100 /tmp/gc_1785234567.log

# 关键字段 grep
grep -E "Full GC|Concurrent Mode Failure|to-space exhausted|System.gc|Humongous" /tmp/gc_1785234567.log
```

**根据日志判断元凶类型**：

| 日志特征 | 元凶类型 | 验证方向 |
|---------|---------|---------|
| `Full GC (System.gc)` | 显式调用 System.gc | grep 代码搜 `System.gc` |
| `Full GC (Allocation Failure)` | 老年代分配失败 | 看堆 dump，找大对象 |
| `Concurrent Mode Failure` | CMS 并发标记跟不上 | 看 CMS 配置 |
| `to-space exhausted` | G1 疏散失败 | 调 G1ReservePercent |
| `Humongous Allocation` | 大对象 > Region/2 | 找大对象来源 |
| `Metadata GC Threshold` | Metaspace 满 | 看动态类生成（CGLIB） |
| `Last ditch collection` | Finalizer 队列满 | 看 finalize 方法 |

**从 Mixed GC 频率推断老年代膨胀速度**：

```
# 假设看到以下日志（间隔时间）：
14:25:00 [GC pause (G1 Evacuation Pause) (mixed) ... 1500M->1200M]
14:25:30 [GC pause (G1 Evacuation Pause) (mixed) ... 1800M->1300M]
14:26:00 [GC pause (G1 Evacuation Pause) (mixed) ... 2100M->1400M]
14:26:30 [GC pause (G1 Evacuation Pause) (mixed) ... 2400M->1500M]
```

**分析**：
- 每 30 秒一次 Mixed GC，但 Old 从 1200M 涨到 1500M
- **每次 Mixed GC 后 Old 仍在涨** -> Mixed GC 来不及回收
- **涨幅**：100M/30s = 200M/min = 12GB/h
- **元凶方向**：业务在持续创建长生命周期对象（缓存、连接、监听器未清理）

**对比"健康 GC 日志"**：

```
14:25:00 [GC pause (G1 Evacuation Pause) (young) ... 1500M->800M]
14:25:30 [GC pause (G1 Evacuation Pause) (young) ... 1300M->700M]
14:26:00 [GC pause (G1 Evacuation Pause) (young) ... 1100M->600M]
```

**健康特征**：
- 主要是 young GC，很少 mixed
- 每次 GC 后 Old 几乎不变
- 堆使用率 60% 左右

#### 第 4 分钟 - 看堆

**MAT 打开 dump 后的 1 分钟流程**：

**第 1 步（10 秒）：看 Leak Suspects**

- 自动分析报告，给出 Top 1-3 嫌疑
- 准确率 70%+
- 看报告标题就能定位 60% 的问题

**第 2 步（20 秒）：看 Dominator Tree**

- 按 Retained Size 降序排
- 看第一名，通常就是元凶
- 展开 Top 1 看引用链

**第 3 步（20 秒）：看 Histogram**

- 按 Retained Size 排序
- 看哪类对象最多
- 如 `byte[]` Retained 4GB -> 大对象泄漏
- 如 `java.lang.String` Retained 2GB -> 字符串堆积

**第 4 步（10 秒）：Path to GC Roots**

- 右键 Top 1 对象 -> `Merge Shortest Paths to GC Roots` -> `exclude weak/soft references`
- 看路径上的对象链
- 典型路径：`Thread -> ImHandler -> Caffeine Cache -> 100w Order`

**1 分钟内找到"占用 Retained Size 最大的对象链"**：

```
Dominator Tree（按 Retained 排序）
  Top 1: com.example.cache.OrderCache @ 0x... 
         Shallow: 48 bytes
         Retained: 4.2 GB    ← 元凶！
         ├─ com.github.benmanes.caffeine.cache.BoundedLocalCache @ 0x...
         │  Shallow: 80 bytes
         │  Retained: 4.1 GB
         │  ├─ [100w+ com.example.entity.OrderEntity 实例]
         │  └─ ...
         └─ ...

Path to GC Roots:
  Thread "http-nio-8080-exec-10" 
    └─ OrderCache @ 0x...
       └─ BoundedLocalCache @ 0x...
          └─ OrderEntity × 1000000
```

**典型元凶对象**：

| 对象类型 | 典型 Retained | 元凶场景 |
|---------|--------------|---------|
| `byte[]` | 1-4GB | 文件读取未关闭、大响应体缓存 |
| `char[]` / `String` | 500MB-2GB | 日志拼接、JSON 序列化缓存 |
| `HashMap$Node[]` | 1-3GB | 缓存未设上限 |
| `ConcurrentHashMap` | 1-3GB | 同上 |
| `ArrayList` | 500MB-2GB | 批量数据未清理 |
| `Caffeine BoundedLocalCache` | 1-4GB | 缓存配置错误（maximumSize 没生效） |
| `java.lang.Object[]` | 1-2GB | 反射调用缓存（Method/Field 缓存） |
| `LinkedList$Node` | 500MB-1GB | 队列未消费 |

#### 第 5 分钟 - 根因定位与止血

**判断元凶类型**：

| 元凶类型 | 判断特征 | 修复方向 |
|---------|---------|---------|
| **业务 bug** | 单一对象 Retained 异常大、引用链异常 | 代码 PR 修复 |
| **配置不当** | 缓存类正常但 maximumSize 未设 | 调配置（不重启可用 Arthas ognl） |
| **流量异常** | 多个对象都涨、Histogram 分布正常 | 限流降级 |
| **依赖库 bug** | 元凶对象是第三方库（如 Netty ByteBuf） | 升级版本 |

**Caffeine 缓存未设上限 - 不重启服务修改配置**：

```bash
# 1. 查当前 Caffeine 实例
vmtool --action getInstances --className com.github.benmanes.caffeine.cache.BoundedLocalCache

# 2. 查当前配置
ognl '@com.example.OrderCache@CACHE.policy'

# 3. 不重启调整：通过 Arthas 调用 setter（如果 Cache 暴露了 setter）
ognl '@com.example.OrderCache@CACHE.cleanUp()'

# 4. 强制清空缓存（救急）
ognl '@com.example.OrderCache@CACHE.invalidateAll()'

# 5. 修改配置类（如果有 volatile 字段）
ognl '@com.example.Config@CACHE_MAX_SIZE = 10000'

# 6. 如果字段是 final，必须用 redefine 改字节码
jad --source-only com.example.Config > /tmp/Config.java
# 编辑 /tmp/Config.java
mc /tmp/Config.java -d /tmp
redefine /tmp/com/example/Config.class
```

**注意**：Arthas 改字段只对 `volatile` 或通过 setter 修改的字段生效。`final` 字段需要 `redefine` 字节码。

**大对象（如 100MB MongoDB 文档）定位哪个接口**：

```bash
# 1. jstack 抓栈，看哪个线程在处理大对象
jstack -l 12345 | grep -A 5 "MongoClient"

# 2. Arthas trace MongoDB 调用
trace com.mongodb.client.internal.MongoCollectionImpl find --skipJDKMethod true -n 5

# 3. Arthas watch 看入参（查询条件 + 返回大小）
watch com.mongodb.client.internal.MongoCollectionImpl find "{params, returnObj.size()}" -x 2 -n 5

# 4. profiler 内存分配火焰图
profiler start --event alloc
# 等 30 秒
profiler stop --file /tmp/alloc.html
# 在火焰图里找 MongoDB 相关的大块
```

**止血后闭环**：

1. **PR 修复**：
   - 缓存泄漏：加 maximumSize、加 expireAfterWrite
   - 大对象：改成分页查询、流式读取
   - 监听器未清理：注册时配 unregister

2. **监控告警**：
   - Prometheus + JVM Exporter：监控堆使用率、GC 频率、GC 耗时
   - 告警阈值：堆使用率 > 85% 持续 1 分钟、Full GC > 1 次/分钟
   - Grafana 大盘：堆、GC、线程、CPU 一图全览

3. **复盘文档**：
   ```
   ## 故障复盘
   - 时间：2026-08-04 14:30 - 15:15
   - 影响：问诊发起接口 P99 飙到 3.2s，影响 2000 用户
   - 根因：OrderCache 未设 maximumSize，导致 100w 订单对象堆积（4.2GB）
   - 止血：摘流量 + 清空缓存
   - 根因修复：PR #1234 加 maximumSize=10000 + expireAfterWrite=10min
   - 改进项：
     1. 全量排查所有 Caffeine 缓存配置
     2. 加缓存大小监控告警
     3. JVM 调优 Checklist 加入"缓存上限检查"
   ```

4. **知识沉淀**：
   - 更新团队 JVM 调优 Checklist
   - 故障案例归档到 wiki
   - 定期演练（混沌工程）

**生产实战经验**：

1. **5 分钟定位是理想**：实际 8-15 分钟更常见，但思路要清晰
2. **MAT 打开大 dump 要等**：1GB dump 索引 1-2 分钟，6GB 要 5-10 分钟，不能急
3. **第一次定位不出来很正常**：可能元凶是动态生成的类（如 CGLIB），需要看 Histogram 多次刷新
4. **团队协作**：一人看日志、一人看 dump、一人查代码，比单干快 3 倍
5. **演练**：定期注入故障（如内存泄漏演练），让团队熟悉工具链

---

## 能力差距提示

作答时请对照架构师水平，重点检查以下能力：

1. **工具熟练度**：能不能不查文档直接写出 `jmap -dump:format=b,file=heap.bin PID` 这种命令？Arthas 命令能否脱口而出？
2. **生产事故节奏感**：5 分钟定位 Full GC 的"分秒级"动作清单，能不能背出来？
3. **工具的副作用意识**：jmap -F、Arthas trace、jstack -F 都有副作用，能不能说清楚什么时候不能用？
4. **版本差异**：JDK 8 vs JDK 11+ 的工具差异，能不能脱口而出？
5. **与简历项目的结合**：在线问诊系统的工具链实战经验，能不能讲出 2-3 个真实排查案例？
6. **架构师视角**：能不能从"工具使用"上升到"工具体系建设"（如全链路监控、自动化告警、故障自愈）？
