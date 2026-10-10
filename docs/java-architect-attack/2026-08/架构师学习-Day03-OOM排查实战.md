# 架构师学习-Day03-OOM 排查实战

> 日期：2026年08月05日（周三）
> 周主题：JVM 专题第 2 周 - 调优实战与生产排查
> 出题日：Day03 - OOM 排查实战（8 种 OOM 类型 / Heap Dump / MAT 实战 / 支配树 / 引用链）

---

## 背景

Day01 把 JVM 调优参数梳理清楚了，Day02 把诊断工具链（jps/jstat/jmap/jstack/jcmd + Arthas + MAT + async-profiler + GC 日志）摆到了台面上。但**工具链是"武器"，OOM 排查是"战役"**——很多工程师会背 `jmap -dump` 命令、会打开 MAT 看 Leak Suspects，但真到生产事故时，还是会出现这些问题：

> "OOM 重启后才发现没开 `-XX:+HeapDumpOnOutOfMemoryError`，现场丢了。"
> "8GB 的 dump 文件拉到本地 MAT 直接 OOM，根本打不开。"
> "MAT 报告说 Caffeine 占了 3GB，但 Caffeine 不是设了 maximumSize 吗？怎么还在涨？"
> "Metaspace OOM 看了 Histogram 也看不出元凶，因为元凶是动态生成的 CGLIB 类。"
> "OOM 之前 Full GC 频繁，但每次 Full GC 后 Old 没降，到底是泄漏还是配置问题？"

这些问题答不出来，Day02 的工具链就是"花架子"。Day03 把 OOM 排查的"类型识别 → 现场抓取 → MAT 深度分析 → 模式识别 → 5 分钟定位"完整链路梳理清楚。

**为什么 Day03 必须深挖 OOM 而不是泛泛讲"内存问题"**：

1. **OOM 是生产事故最高频元凶之一**：仅次于 CPU 飙高、P99 抖动，但 OOM 一旦发生就是"服务重启 + 业务中断 + 数据丢失"三连击
2. **OOM 不是单点问题，是 8 类问题**：堆 OOM、Metaspace OOM、Direct Buffer OOM、Native Thread OOM、GC Overhead OOM... 每类的根因和修复方向完全不同
3. **MAT 是 OOM 排查的核心武器，但门槛高**：Dominator Tree 的支配树算法、Shallow vs Retained 的本质、OQL 语法、10GB+ 大 dump 处理，每个点都能筛掉一批工程师
4. **OOM 与简历项目深度绑定**：在线问诊系统的 5 个 JVM 场景里，3 个直接是 OOM（监管上报 OOM / 问诊订单缓存膨胀 / MongoDB 大文档 Humongous），1 个间接是 OOM（IM 网关 ByteBuf 泄漏是 Direct Buffer OOM 雏形），1 个是 GC 抖动（视频 RTP 包堆积引发 Full GC 失败）

**与 Day01 / Day02 的衔接点**：

- Day01 讲了 `-XX:+HeapDumpOnOutOfMemoryError` + `-XX:HeapDumpPath=/data/dump/`，Day03 讲这个 dump 怎么用 MAT 分析
- Day01 讲了 `-XX:MetaspaceSize` / `-XX:MaxMetaspaceSize`，Day03 讲 Metaspace OOM 怎么排查
- Day01 讲了 `-XX:MaxDirectMemorySize`，Day03 讲 Direct Buffer OOM 怎么排查
- Day01 讲了 `-Xss`，Day03 讲 `unable to create new native thread` 与 StackOverflowError 的区别
- Day02 讲了 `jmap -histo:live` 会触发 Full GC、`jcmd PID GC.heap_dump` 是推荐方式，Day03 讲什么时候用哪种 dump
- Day02 讲了 MAT 的 Histogram / Dominator Tree / Leak Suspects / Object Inspector 四大视图，Day03 深挖支配树算法、OQL、大 dump 处理
- Day02 讲了 GC 日志的 5 步法，Day03 讲怎么从 GC 日志判断"OOM 即将发生"和"OOM 已经发生"

**与往周专题的衔接点**：

- **6月第1周 MySQL**：MySQL 大结果集 OOM vs JVM OOM——`SELECT * FROM order` 全量加载到 ResultSet，再映射成 List&lt;OrderEntity>，JVM 堆直接爆；对比 MySQL 服务端 OOM（buffer_pool 撑爆），根因都是"未分页 + 全量加载"
- **6月第2周 Redis**：Redis bigKey vs JVM 缓存膨胀——Redis 单 key 100MB 是 Redis 内存爆，Caffeine 100w Key × 1KB 是 JVM 堆爆；两者的修复方向都是"拆 + 限"
- **6月第3周 ES**：ES Scroll API vs JVM 堆——深分页 scroll 上下文堆积在 ES 服务端，但客户端用 `SearchHits` 全量接收也会 JVM OOM；正确姿势是 `SearchScroll` 流式 + `clearScroll` 释放
- **6月第4周 限流降级**：Sentinel 黑名单堆积 vs JVM OOM——Sentinel 的 `ClusterNode` 累积也会 OOM，尤其是 QPS 高 + 资源名动态生成（如 userId 作为资源名）时
- **6月第5周 支付**：支付幂等表无限增长 vs JVM OOM——支付幂等记录如果用 `ConcurrentHashMap<orderId, PayRecord>` 在 JVM 内存里做（错误做法），跑 1 个月必 OOM
- **7月第1周 医疗**：医保结算大对象 vs JVM Humongous——医保结算单含明细 + 用药 + 检查，单对象 1-5MB，超过 G1 Region 50% 触发 Humongous Allocation
- **7月第4周简历项目**：在线问诊系统 5 个 OOM 场景（IM 网关 ByteBuf / 视频 RTP / 监管上报 / 问诊订单 / MongoDB 大文档）
- **7月第5周 JVM 第1周**：Day07 G1 调优与 Humongous Region 的关系，Day03 接着讲 Humongous Allocation 触发的 OOM

Day04 进入 CPU 飙高排查，Day05 落到在线问诊系统 JVM 调优案例，Day06 串联故障复盘方法论，Day07 深挖 ZGC。

---

## 题目一（OOM 排查实战全解题）：8 种 OOM 类型 / Heap Dump / MAT 实战 / 引用链 / 5 分钟定位

请详细回答以下问题：

1. **8 种 OOM 类型全解**：`Java heap space` / `GC overhead limit exceeded` / `Metaspace` / `Compressed class space` / `Direct buffer memory` / `unable to create new native thread` / `Requested array size exceeds VM limit` / `StackOverflowError`——每类的触发条件、根因、修复方向、生产案例是什么？为什么 `GC overhead limit exceeded` 本质是"堆 OOM 的预警"？`Metaspace` OOM 与 `Compressed class space` OOM 的关系？`StackOverflowError` 算 OOM 吗（JVM 规范的角度）？
2. **Heap Dump 获取的 5 种方式**：`-XX:+HeapDumpOnOutOfMemoryError` 自动 dump / `jcmd PID GC.heap_dump` 主动 dump / `jmap -dump:format=b,file=`（JDK 8 风格）/ `Arthas heapdump` 在线 dump / `kill -3` + core 文件 + `jhsdb`（极端情况）——5 种方式的差异、STW 时长、是否包含 unreachable 对象、是否触发 GC、生产场景如何选择？为什么说"自动 dump 未必抓得到元凶"（OOM 前已经 Full GC 多次，对象状态变了）？
3. **MAT 深度实战**：Histogram / Dominator Tree / Leak Suspects / Object Inspector 四大视图的实战流程？Shallow Size vs Retained Size 的本质区别（含支配集算法）？**支配树 Dominator Tree 的算法原理**（IBM paper：Largest Retained Set 算法）？`Path to GC Roots` vs `Merge Shortest Paths` 的区别？OQL 查询语法（`SELECT s.size FROM java.util.HashMap s WHERE s.@retainedHeapSize > 1000000`）？10GB+ 大 dump 处理（MAT `-Xmx`、离线机器、在线 MAT、`--loader` 模式）？怎么识别"看似泄漏实则是缓存膨胀"？
4. **5 类常见内存泄漏模式**：缓存膨胀（Caffeine / ConcurrentHashMap 未设上限）/ ThreadLocal 累积（线程池复用未 remove）/ 监听器 Callback 未 unregister / 静态集合无限增长 / finalize 队列堆积——每类模式的识别清单、典型代码、修复方案？为什么 ThreadLocal 在线程池下是"隐形杀手"？finalize 为什么被 JDK 9 标记 Deprecated、JDK 18 提案移除？
5. **5 分钟定位 OOM 元凶的实战节奏**：0:00-0:30 现象确认（监控告警 / OOM 重启）→ 0:30-1:00 止损决策（摘流量 / 限流 / 重启）→ 1:00-2:00 抓现场（dump + GC 日志 + jstack）→ 2:00-3:00 GC 日志分类（频繁 Minor / Mixed 慢 / Full 失败）→ 3:00-4:00 MAT 分析（Dominator Tree + Path to GC Roots）→ 4:00-5:00 根因止血（清缓存 / 修复代码 / 扩容）——每个节点的关键决策、踩坑点、与 Day02 工具链的协同？

### 作答区

#### 1. 8 种 OOM 类型全解

**8 种 OOM 类型全景**：

| OOM 类型 | 报错信息 | 触发区域 | 是否真的"内存不够" | 修复方向 |
|---------|---------|---------|-----------------|---------|
| 堆 OOM | `Java heap space` | Java 堆 | 是 | 找泄漏 / 扩堆 / 减对象 |
| GC Overhead | `GC overhead limit exceeded` | Java 堆 | 临界（98% 时间 GC 仍回收不下来） | 同堆 OOM，但是"预警" |
| 元空间 OOM | `Metaspace` | Metaspace | 是（元数据区满） | 排查动态类生成 / 调大 MaxMetaspaceSize |
| 压缩类空间 OOM | `Compressed class space` | Compressed Class Space | 是（指针压缩的类空间满） | 调大 CompressedClassSpaceSize / 关指针压缩 |
| 直接内存 OOM | `Direct buffer memory` | 堆外直接内存 | 是（Direct ByteBuffer 满） | 排查 ByteBuf 释放 / 调大 MaxDirectMemorySize |
| 线程 OOM | `unable to create new native thread` | OS 线程 | 否（线程数超 limit） | 调 ulimit / 减线程数 / 用虚拟线程 |
| 数组 OOM | `Requested array size exceeds VM limit` | Java 堆 | 是（单数组超 Integer.MAX_VALUE） | 改集合 / 分片 |
| 栈溢出 | `StackOverflowError` | 线程栈 | 否（单栈深度超限） | 加 -Xss / 改递归为迭代 |

**类型 1：`Java heap space`（堆内存溢出）**

**触发条件**：JVM 在堆上分配对象时，老年代 + 新生代都满了，Full GC 后仍无足够连续空间。

**根因**：
1. 内存泄漏：对象被 GC Root 持续持有，无法回收（如静态 Map、ThreadLocal、监听器未 unregister）
2. 缓存膨胀：Caffeine / ConcurrentHashMap 未设上限或上限过大
3. 大对象：单次加载超过堆可用空间（如 5GB 文件读入内存、10w 条记录全量查询）
4. 流量突增：QPS 翻 10 倍，对象分配速率超 GC 回收速率

**典型日志**：
```
java.lang.OutOfMemoryError: Java heap space
    at com.example.ReportService.submit(ReportService.java:45)
    at com.example.ReportController.post(ReportController.java:23)
```

**修复方向**：
1. 立即止血：重启 / 摘流量 / 限流
2. 短期修复：扩堆（`-Xmx4g` -> `-Xmx8g`）、加 `-XX:+HeapDumpOnOutOfMemoryError` 抓现场
3. 长期修复：MAT 分析 dump 找元凶，修业务 bug

**生产案例（在线问诊系统 - 问诊订单缓存 100w Key）**：
```
现象：问诊订单服务 OOM 重启
排查：jmap dump + MAT 分析
根因：Caffeine maximumSize 设了 100w（应该 1w），100w OrderEntity × 4KB = 4GB
修复：改 maximumSize=10000 + expireAfterWrite=10min
```

**类型 2：`GC overhead limit exceeded`（GC 开销超限）**

**触发条件**：JDK 默认规则——`> 98% 时间在做 GC` 且 `< 2% 堆被回收`，连续 5 次（`-XX:GCTimeLimit=98` `-XX:GCHeapFreeLimit=2` `-XX:+UseGCOverheadLimit`）。

**本质**：堆 OOM 的"预警"——还没真 OOM，但 GC 已经"在做无用功"。

**与堆 OOM 的区别**：

| 维度 | `Java heap space` | `GC overhead limit exceeded` |
|------|------------------|------------------------------|
| 触发时机 | 分配失败时 | GC 占用过高时（可能还能分配少量对象） |
| 堆状态 | 完全满 | 接近满但还有少量空间 |
| 修复紧迫度 | 立即重启 | 可以撑一会儿（但不建议） |
| 是否可关闭 | 不可关闭 | `-XX:-UseGCOverheadLimit` 可关闭（不建议） |

**为什么不要关闭**：关闭后 JVM 会硬撑到完全 OOM，可能导致 Full GC STW 数十秒，业务雪崩。

**典型场景**：
- 缓存配置 maximumSize=100w，但业务实际只能塞 90w，临界状态频繁 Full GC
- 大对象分配速率高（如 1MB/请求），GC 跟不上分配

**修复方向**：与堆 OOM 相同——找泄漏 / 扩堆 / 减对象。

**类型 3：`Metaspace`（元空间溢出）**

**触发条件**：JVM 加载类时 Metaspace 满（默认无限，受限于宿主内存；可设 `-XX:MaxMetaspaceSize=512m`）。

**根因**：
1. **动态类生成**：CGLIB / Spring AOP / Groovy 动态生成类未释放
2. **类加载器泄漏**：自定义 ClassLoader 未 close，热部署时旧 ClassLoader 保留所有类
3. **大量第三方库**：依赖太多 jar，类元数据超预期
4. **JSP 重新编译**：每次 JSP 改动都生成新类

**典型日志**：
```
java.lang.OutOfMemoryError: Metaspace
    at java.lang.ClassLoader.defineClass1(Native Method)
    at java.lang.ClassLoader.defineClass(ClassLoader.java:756)
```

**识别特征**：
- jstat 看 MC（Metaspace Used）持续涨
- jmap -histo 看 `java.lang.Class` 实例数异常多
- MAT 看 `BoundedUnlimitedClassLoader` / `CGLIB$GeneratedClassLoader` 实例数

**修复方向**：
1. 调大 `-XX:MaxMetaspaceSize=1g`
2. 排查动态类生成（Arthas `vmtool --action getInstances --className java.lang.ClassLoader` 看 ClassLoader 实例数）
3. 修代码：自定义 ClassLoader 用完 `close()`、Groovy 脚本缓存 `GroovyClassLoader.parseClass` 结果
4. 升级 JDK 11+：Metaspace 在 JDK 11 重构（JEP 一系列改进），更不易泄漏

**生产案例（在线问诊系统 - 视频问诊动态代理泄漏）**：
```
现象：视频问诊服务 Metaspace OOM，每周必重启
排查：jstat 看 MC 从 200MB 涨到 1.2GB（MaxMetaspaceSize=1g）
根因：每次视频通话动态生成 RTP Proxy 类（CGLIB），ClassLoader 未复用
修复：复用 GroovyClassLoader + 缓存生成的 Class
```

**类型 4：`Compressed class space`（压缩类空间溢出）**

**触发条件**：开启指针压缩（`-XX:+UseCompressedOops`，堆 &lt; 32GB 默认开）后，类的元数据中"压缩指针部分"放在 Compressed Class Space，这块空间满。

**与 Metaspace 的关系**：
- Metaspace = Class Metadata（非压缩部分） + Compressed Class Space（压缩部分）
- Compressed Class Space 默认 1GB（`-XX:CompressedClassSpaceSize=1g`）
- 堆 >= 32GB 时关闭指针压缩，Compressed Class Space 不存在

**典型场景**：极少见，只有动态生成大量类（如 100w+ CGLIB 类）才会触发。

**修复方向**：
1. 调大 `-XX:CompressedClassSpaceSize=2g`
2. 关闭指针压缩（`-XX:-UseCompressedOops`），但堆性能下降 10-30%
3. 排查动态类生成（同 Metaspace 修复方向）

**类型 5：`Direct buffer memory`（直接内存溢出）**

**触发条件**：NIO Direct ByteBuffer 占用超过 `-XX:MaxDirectMemorySize`（默认等于 `-Xmx`）。

**根因**：
1. **ByteBuf 未 release**：Netty 的 `PooledByteBufAllocator` 分配后业务代码忘了 `ReferenceCountUtil.release(buf)`
2. **Direct ByteBuffer 累积**：NIO Channel 读到的数据放在 Direct Buffer，业务处理后未释放
3. **`-XX:MaxDirectMemorySize` 设小了**：默认等于 `-Xmx`，但 K8s Pod limit 可能小于此值，导致 OOM kill

**典型日志**：
```
java.lang.OutOfMemoryError: Direct buffer memory
    at java.nio.Bits.reserveMemory(Bits.java:175)
    at java.nio.DirectByteBuffer.<init>(DirectByteBuffer.java:118)
```

**识别特征**：
- 堆使用率正常（&lt; 60%），但 Pod RSS 持续涨
- NMT（Native Memory Tracking）：`jcmd PID VM.native_memory summary` 看 `Internal` 部分涨
- Arthas `vmtool --action getInstances --className java.nio.DirectByteBuffer` 看实例数

**修复方向**：
1. 排查 ByteBuf 释放：开启 Netty leak detection（`-Dio.netty.leakDetection.level=PARANOID`）
2. 调大 `-XX:MaxDirectMemorySize=2g`（但要确保 Pod limit 足够）
3. 修代码：业务代码用 `try-finally` 确保 `ByteBuf.release()`
4. 配合 `-XX:+DisableExplicitGC` 注意：Direct ByteBuffer 清理靠 `Cleaner`（基于 PhantomReference + ReferenceQueue），`System.gc()` 触发清理；如果禁用了 `System.gc()`，Direct Buffer 可能堆积

**生产案例（在线问诊系统 - IM 网关 ByteBuf 泄漏）**：
```
现象：IM 网关 RSS 持续涨，从 2GB 涨到 7.5GB（Pod limit 8GB），堆使用率仅 50%
排查：
  1. jcmd PID VM.native_memory summary 看 Internal 涨
  2. Arthas vmtool --action getInstances --className io.netty.buffer.PooledByteBuf 看实例数 100w+
  3. 开 -Dio.netty.leakDetection.level=PARANOID，看日志报泄漏栈
根因：业务代码 ByteBuf 没 release，Netty 检测泄漏循环清理占 CPU
修复：业务代码加 try-finally release
```

**类型 6：`unable to create new native thread`（无法创建新线程）**

**触发条件**：JVM 向 OS 申请创建线程失败（OS 拒绝）。

**根因**：
1. **OS 线程数超限**：`ulimit -u`（max user processes）超限
2. **PID 数超限**：`/proc/sys/kernel/pid_max` 超限（默认 32768）
3. **JVM 线程数过多**：每个线程默认 1MB 栈（`-Xss1m`），4GB 内存理论上限 4000 线程
4. **线程泄漏**：业务代码 `new Thread()` 没用线程池，每次请求新建线程

**典型日志**：
```
java.lang.OutOfMemoryError: unable to create new native thread
    at java.lang.Thread.start0(Native Method)
    at java.lang.Thread.start(Thread.java:717)
```

**识别特征**：
- jstack 看线程数：`jstack -l PID | grep "java.lang.Thread.State" | wc -l`
- 看线程数趋势：Prometheus `jvm_threads_states_threads` 持续涨
- 看 OS 限制：`ulimit -u` / `cat /proc/<pid>/status | grep Threads`

**修复方向**：
1. **调大 OS 限制**：`ulimit -u 65535` / 修改 `/etc/security/limits.conf`
2. **减线程数**：用线程池复用、改用 NIO（少线程多连接）
3. **减小栈大小**：`-Xss256k`（默认 1MB）
4. **JDK 21+ 用虚拟线程**：`Thread.ofVirtual()`，百万级并发不爆

**生产案例（在线问诊系统 - IM 网关 10w 长连接）**：
```
现象：IM 网关在 8w 连接时 OOM "unable to create new native thread"
排查：jstack 看线程数 65000+，每连接一个 NioEventLoop 线程
根因：单 Pod 6.5w 线程 × 1MB 栈 = 65GB 虚拟内存，触达 OS 限制
修复：
  1. 调 ulimit -u 到 200000
  2. 改 -Xss256k
  3. Netty EventLoopGroup 单线程多 Channel（已是默认，但业务自定义线程池泄漏）
```

**类型 7：`Requested array size exceeds VM limit`（数组超限）**

**触发条件**：分配数组长度超过 `Integer.MAX_VALUE`（约 21 亿）或超过 JVM 实现上限（部分 JVM 是 `Integer.MAX_VALUE - 5`）。

**根因**：
1. **算法 bug**：`new byte[size]` 中 size 计算错误，溢出为巨大值
2. **大文件读取**：`Files.readAllBytes()` 读 5GB 文件
3. **不当批处理**：`list.toArray(new T[list.size()])` 但 list.size 计算错

**典型场景**：极少见，但出现在"看似正常的代码"中：

```java
// 错误：long 转 int 溢出
long fileSize = file.length();
byte[] data = new byte[(int) fileSize];  // fileSize=5GB 时 (int) 溢出为负数或大数

// 错误：集合 size 计算错
int size = computeSize();  // 返回 30 亿
Object[] arr = new Object[size];  // OOM
```

**修复方向**：
1. 改用流式读取（`InputStream` + 缓冲区）
2. 改用集合分片（`List<List<T>>`）
3. 检查 size 计算逻辑（long 转 int 的溢出）

**类型 8：`StackOverflowError` 与 OOM 的关系**

**触发条件**：线程栈深度超过 `-Xss` 允许的最大值（默认 1MB 栈约 5000-10000 层深度）。

**典型场景**：
1. **递归无终止条件**：`factorial(n)` 忘了 `if (n == 1) return 1`
2. **互相递归**：A 调 B，B 调 A
3. **栈过深**：JSON 序列化深度嵌套对象（如循环引用）

**`StackOverflowError` 算 OOM 吗**：
- **JVM 规范角度**：`StackOverflowError` extends `VirtualMachineError` extends `Error`，与 `OutOfMemoryError` 是平级的兄弟，**不算 OOM**
- **广义 OOM 角度**：很多工程师把它当作"栈 OOM"，因为本质都是"内存不够"——栈空间不够分配新栈帧
- **面试标准答法**：严格说不算，但工程上常归类为"栈 OOM"

**与 `unable to create new native thread` 的区别**：

| 维度 | `StackOverflowError` | `unable to create new native thread` |
|------|---------------------|--------------------------------------|
| 单线程 vs 多线程 | 单线程栈过深 | 总线程数过多 |
| 栈空间 | 单栈空间不够 | 总栈空间不够 |
| 修复 | 加 `-Xss` / 改迭代 | 调 ulimit / 减线程 |

**典型代码**：
```java
// 错误：递归无终止
public int factorial(int n) {
    return n * factorial(n - 1);  // 缺少 if (n == 1) return 1
}

// 错误：JSON 循环引用
class Order {
    User user;
}
class User {
    Order order;  // 循环引用，序列化时栈溢出
}

// 错误：互相递归
void methodA() { methodB(); }
void methodB() { methodA(); }
```

**修复方向**：
1. 加终止条件（递归）
2. 改迭代（用 `Stack` 数据结构代替递归调用栈）
3. 加大 `-Xss`（治标不治本，且占内存）
4. 序列化时用 `@JsonIgnore` 打破循环引用

**8 种 OOM 的统一排查框架**：

```
OOM 发生
   │
   ▼
1. 看报错信息，识别 OOM 类型（heap / Metaspace / Direct / Thread / Stack）
   │
   ▼
2. 看监控趋势（堆 / Metaspace / RSS / 线程数），找涨幅异常的指标
   │
   ▼
3. 抓现场（dump / jstack / GC 日志 / NMT）
   │
   ├─ heap OOM     -> jmap dump + MAT
   ├─ Metaspace    -> jmap -histo 看 Class 实例 + ClassLoader 排查
   ├─ Direct       -> NMT summary + Arthas vmtool DirectByteBuffer
   ├─ Thread       -> jstack 看线程数 + 业务代码 Thread 创建点
   └─ Stack        -> jstack 看栈深度 + 业务代码递归点
   │
   ▼
4. 根因定位（MAT / 代码审查 / 日志）
   │
   ▼
5. 修复（代码 PR / 配置调整 / 扩容）
```

**生产实战经验**：

1. **OOM 类型决定排查方向**：不要所有 OOM 都按"堆 OOM"排查，Metaspace OOM 看 dump 没用，要看 ClassLoader
2. **OOM 自动 dump 必开**：`-XX:+HeapDumpOnOutOfMemoryError` 是救命配置
3. **OOM 前预警**：`GC overhead limit exceeded` 是预警，看到了立即抓现场
4. **OOM 重启不是终点**：不修根因，重启后必复现
5. **OOM 与 OOM kill 区分**：JVM OOM 是堆内爆，OS OOM kill 是 Pod RSS 超 limit 被 kill，两者根因不同

---

#### 2. Heap Dump 获取的 5 种方式

**5 种 Heap Dump 方式全景**：

| 方式 | 命令 | 是否 STW | STW 时长 | 是否触发 GC | 是否含 unreachable | 适用场景 |
|------|------|---------|---------|------------|------------------|---------|
| 自动 dump | `-XX:+HeapDumpOnOutOfMemoryError` | 是 | 数秒-数分钟 | OOM 前已 Full GC 多次 | 否（默认） | 生产 OOM 自动抓现场 |
| jcmd 主动 | `jcmd PID GC.heap_dump /tmp/x.bin` | 是 | 1-30 秒 | 否 | 否（默认） | 主动排查（推荐） |
| jmap 主动 | `jmap -dump:format=b,file=heap.bin PID` | 是 | 1-30 秒 | 否 | 否（默认） | JDK 8 风格 |
| jmap 强制 | `jmap -F -dump:format=b,file=heap.bin PID` | 是 | 进程挂起 | 是 | 是 | 进程假死时 |
| Arthas heapdump | `heapdump /tmp/x.bin` | 是 | 1-30 秒 | 否 | 否 | Arthas 在线排查 |
| `kill -3` + core + jhsdb | `kill -3 PID` + `gcore` + `jhsdb jmap --binaryheap` | 是 | 1-5 分钟 | 否 | 是 | 极端情况（进程卡死） |

**方式 1：`-XX:+HeapDumpOnOutOfMemoryError` 自动 dump（生产必备）**

**配置**：
```bash
-XX:+HeapDumpOnOutOfMemoryError
-XX:HeapDumpPath=/data/dump/
-XX:OnOutOfMemoryError="kill -9 %p"  # 可选：OOM 后自动 kill 进程，让 K8s 重启
```

**工作机制**：
1. JVM 检测到 OOM 抛出
2. 触发 HeapDumpSource 系列逻辑，调用 `HeapDumper.createHeapDump`
3. dump 到 `HeapDumpPath` 指定路径（默认 `java_pid<PID>.hprof`）
4. dump 完成后继续抛 OOM（业务线程捕获则继续运行，否则退出）

**STW 时长**：与堆大小正相关，6GB 堆约 5-10 秒。

**坑点**：
1. **磁盘满**：dump 文件 ≈ 堆大小，磁盘要预留 1.5 倍堆大小
2. **路径权限**：容器内 `/data/dump/` 要可写，且要挂大盘（不要 dump 到 rootfs）
3. **OOM 后业务可能还在跑**：JVM 抛 OOM 但不退出，业务线程捕获 OOM 继续跑（错误做法），导致 dump 不准
4. **OOM 前 Full GC 多次，对象状态变了**：dump 出来的不是"事故第一现场"，可能元凶已被部分回收

**为什么"自动 dump 未必抓得到元凶"**：
```
T0: 缓存开始泄漏（元凶出现）
T1: 堆使用率 70%（无感知）
T2: 堆使用率 90%（开始频繁 Full GC）
T3: Full GC 后 Old 仍 85%（业务开始抖动）
T4: Full GC 后 Old 95%（GC overhead limit）
T5: 真正 OOM，触发自动 dump
```
T5 时刻的 dump，SoftReference 已被清空、WeakReference 已被回收、Finalizer 队列已执行——看到的对象都是"硬泄漏"，但软引用 / 弱引用相关的元凶可能丢失。

**解决**：
1. 配合监控告警，堆使用率 85% 时**主动 dump**（抓早期现场）
2. 配合 JFR 持续录制，OOM 后看 JFR 找历史
3. 关键业务加自定义监控（如 `cache.estimatedSize()` 上报 Prometheus）

**方式 2：`jcmd PID GC.heap_dump` 主动 dump（推荐）**

**命令**：
```bash
# 1. 标准主动 dump（推荐）
jcmd 12345 GC.heap_dump /data/dump/heap_$(date +%s).bin

# 2. 包含 unreachable 对象（-all）
jcmd 12345 GC.heap_dump -all /data/dump/heap_all.bin

# 输出：Heap dump file created [/data/dump/heap_1785234567.bin, 4567890123 bytes] in 8.234s
```

**STW 时长**：

| 堆大小 | STW 时长 | 备注 |
|--------|---------|------|
| 1GB | 1-2 秒 | 正常 |
| 4GB | 5-10 秒 | 已摘流量可接受 |
| 8GB | 15-30 秒 | 必须摘流量 |
| 32GB | 1-5 分钟 | 建议改用 JFR |

**为什么推荐 jcmd 而非 jmap**：
1. **稳定性**：`jmap` 在某些 JDK 8 版本对大堆（>32GB）会卡死
2. **进度反馈**：`jcmd` 输出 `created [...] in 8.234s` 友好
3. **统一入口**：JDK 7+ 推荐 `jcmd` 作为万能命令
4. **可脚本化**：`-all` 选项控制是否包含 unreachable
5. **JDK 11+ 标准**：`jmap` 在 JDK 11+ 仍可用但**官方文档明确推荐 jcmd**

**主动 dump 的最佳时机**：
1. **监控告警触发时**：堆使用率 > 85% 持续 1 分钟
2. **Full GC 频率异常时**：Full GC > 1 次/分钟
3. **业务 RT 抖动时**：P99 突然飙高，可能是 GC 停顿
4. **演练时**：主动注入故障前抓一次 baseline

**主动 dump 的副作用**：
- STW 期间业务全停，必须先摘流量
- 磁盘 IO 突增，可能影响同 Pod 其他进程
- dump 文件大，要预留磁盘

**方式 3：`jmap -dump:format=b,file=` 主动 dump（JDK 8 风格）**

**命令**：
```bash
# 1. 标准主动 dump
jmap -dump:format=b,file=heap.bin PID

# 2. 强制 dump（进程假死时）
jmap -F -dump:format=b,file=heap.bin PID

# 3. 只 dump 存活对象（会触发 Full GC！）
jmap -dump:live,format=b,file=heap.bin PID
```

**与 jcmd 的差异**：
- `jmap -dump` 默认包含 unreachable
- `jmap -dump:live` 触发 Full GC 后 dump，只包含 reachable
- `jmap -F` 用 Serviceability Agent，会挂起进程，但能 dump 假死进程

**何时用 `jmap -F`**：
- 进程假死（jstack / jcmd 都无响应）
- 必须抓到现场才能定位
- 已无业务流量（或接受雪崩）

**何时不能用 `jmap -F`**：
- 业务还在跑（会雪崩）
- 有其他方式（jcmd、Arthas heapdump）

**方式 4：`Arthas heapdump` 在线 dump**

**命令**：
```bash
# 1. 标准 dump（功能同 jcmd GC.heap_dump）
heapdump /tmp/heap.bin

# 2. 只 dump 存活对象（触发 Full GC）
heapdump --live /tmp/heap.bin

# 3. dump 到临时文件
heapdump
# 输出：HeapDump file saved to /tmp/heapdump-2026-08-05-123456.hprof
```

**与 jcmd / jmap 的差异**：

| 维度 | jcmd | jmap | Arthas heapdump |
|------|------|------|-----------------|
| 原理 | JVM 内置 | JVM 内置 | 包装 jcmd / jmap |
| 输出 | 文件路径 + 大小 + 耗时 | 仅文件 | 友好输出 + 路径 |
| 选项 | -all 包含 unreachable | :live 触发 GC | --live 触发 GC |
| 远程 | 需 SSH 到容器 | 需 SSH 到容器 | 通过 Arthas tunnel 远程 |
| 自动化 | 可脚本化 | 可脚本化 | 可集成 Arthas CLI |

**Arthas heapdump 的优势**：
1. **远程友好**：通过 Arthas tunnel server，本地 IDE 直接 dump 远程 Pod
2. **集成 workflow**：dump 完直接 `vmtool` / `ognl` 看对象，不用切工具
3. **K8s sidecar**：sidecar 容器跑 Arthas，不污染业务容器

**方式 5：`kill -3` + core 文件 + jhsdb（极端情况）**

**适用场景**：进程完全卡死，jcmd / jmap / Arthas 都无响应。

**步骤**：
```bash
# 1. 发送 SIGQUIT（kill -3），JVM 把栈打到 stdout
kill -3 PID
# 如果 stdout 重定向到文件，看 jstack

# 2. 用 gcore 生成 core 文件（不影响进程，但暂停所有线程）
gcore PID
# 输出：Saved corefile core.12345

# 3. 用 jhsdb 从 core 文件 dump 堆（JDK 9+）
jhsdb jmap --binaryheap --exe /usr/lib/jvm/java-11-openjdk/bin/java --core core.12345

# 4. 用 jhsdb 从 core 文件抓栈
jhsdb jstack --exe /usr/lib/jvm/java-11-openjdk/bin/java --core core.12345
```

**JDK 8 的等价方式**：
```bash
# JDK 8 没有 jhsdb，用 jmap -F + core
jmap -F -dump:format=b,file=heap.bin /usr/lib/jvm/java-8-openjdk/bin/java core.12345
```

**关键认知**：
1. `gcore` 会暂停所有线程（不是 STW，是 OS 级 SIGSTOP），暂停时长与进程内存大小正相关
2. `jhsdb` 是 JDK 9+ 引入的"Serviceability Agent"工具，可以从 core 文件离线分析
3. **极端情况才用**：正常情况用前 4 种方式

**5 种 dump 方式的选择决策树**：

```
需要 dump 堆
   │
   ▼
是否需要立即抓？
   ├─ 否（生产配置）-> 配置 -XX:+HeapDumpOnOutOfMemoryError
   │                  -XX:HeapDumpPath=/data/dump/
   │
   └─ 是（主动排查）
       │
       ▼
   进程是否响应？
       ├─ 是 -> 是否有 Arthas？
       │       ├─ 是 -> heapdump /tmp/x.bin
       │       └─ 否 -> jcmd PID GC.heap_dump /tmp/x.bin
       │
       └─ 否（假死）-> jmap -F -dump:format=b,file=heap.bin PID
                       或 gcore + jhsdb（极端）
```

**5 种 dump 方式的包含范围**：

| 包含对象 | 自动 dump | jcmd 默认 | jcmd -all | jmap 默认 | jmap :live | Arthas heapdump |
|---------|----------|-----------|-----------|-----------|-----------|-----------------|
| Reachable 对象 | 是 | 是 | 是 | 是 | 是（GC 后） | 是 |
| SoftReference | 看时机 | 是 | 是 | 是 | 否（GC 清理） | 是 |
| WeakReference | 看时机 | 是 | 是 | 是 | 否（GC 清理） | 是 |
| Unreachable 对象 | 否 | 否 | 是 | 是 | 否 | 否 |
| Finalizer 队列 | 是 | 是 | 是 | 是 | 是 | 是 |
| GC Roots | 是 | 是 | 是 | 是 | 是 | 是 |
| 线程栈 | 是 | 是 | 是 | 是 | 是 | 是 |

**关键认知**：
1. **找泄漏看 reachable 即可**：默认 jcmd 不带 -all 就是 reachable
2. **找"被谁引用"看 unreachable 也行**：但通常不需要
3. **`:live` 会触发 Full GC**：会清掉 SoftReference / WeakReference，可能丢失元凶

**生产实战经验**：

1. **OOM 自动 dump 必开**：`-XX:+HeapDumpOnOutOfMemoryError` + 磁盘预留
2. **dump 路径要挂大盘**：`/data/dump/` 挂 100GB+ 磁盘，避免 rootfs 撑爆
3. **dump 文件要清理**：定时任务清理 7 天前的 dump 文件
4. **dump 时长预估**：堆大小 / 100MB/s ≈ dump 秒数（受磁盘 IO 限制）
5. **大堆（>32GB）建议 JFR**：JFR 开销 &lt; 1%，dump 大堆 STW 太久
6. **dump 文件敏感**：含业务数据，传输要加密，存储要脱敏

---

#### 3. MAT 深度实战

**MAT 四大视图的实战流程**：

**视图 1：Histogram（按类统计对象数和大小）**

**入口**：`Histogram` 选项卡

**列含义**：

| 列 | 含义 | 用途 |
|---|------|------|
| Class Name | 类名 | 找异常类 |
| Objects | 实例数 | 找"哪类对象最多" |
| Shallow Heap | 对象本身大小（字节） | 看自身占用 |
| Retained Heap | 对象被回收后能释放的大小 | 找"释放它能腾多少内存" |
| Percent | 占比 | 快速看 Top N |

**实战用法**：
1. 按 Retained Heap 降序排
2. 看 Top 1 是什么类
3. 如 `byte[]` Retained 4GB -> 大对象泄漏
4. 如 `java.lang.String` Retained 2GB -> 字符串堆积
5. 如 `java.util.HashMap$Node` Retained 3GB -> Map 累积

**正则过滤**：
- `.*Cache.*` 过滤所有 Cache 相关类
- `com\.example\..*` 过滤业务包

**视图 2：Dominator Tree（按对象引用关系排序，找元凶）**

**入口**：`Dominator Tree` 选项卡

**列含义**：

| 列 | 含义 |
|---|------|
| Object | 对象（含类名 + 地址） |
| Shallow Heap | 对象本身大小 |
| Retained Heap | 对象被回收后能释放的大小（**核心指标**） |
| Percent | 占堆总内存比例 |

**实战用法**：
1. 按 Retained Heap 降序排
2. **第一名通常就是元凶**（70% 准确率）
3. 展开看子节点（被该对象支配的对象）
4. 右键 -> `Path to GC Roots` -> `exclude weak/soft references` 看引用链

**典型 Dominator Tree 输出**：
```
Top 1: com.example.cache.OrderCache @ 0x...
       Shallow: 48 bytes
       Retained: 4.2 GB    ← 元凶！
       ├─ com.github.benmanes.caffeine.cache.BoundedLocalCache @ 0x...
       │  Shallow: 80 bytes
       │  Retained: 4.1 GB
       │  ├─ [100w+ com.example.entity.OrderEntity 实例]
       │  └─ ...
       └─ ...

Top 2: java.lang.Thread @ 0x...
       Shallow: 96 bytes
       Retained: 200 MB
```

**视图 3：Leak Suspects（自动分析疑似泄漏点）**

**入口**：`Leak Suspects Report` -> `Leak Suspects`

**自动分析**：
- MAT 自动扫描堆，识别"Retained Size 异常大 + 引用链异常"的对象
- 给出 Top 1-3 嫌疑
- 每个嫌疑包含：对象信息、引用链、问题描述、修复建议

**典型报告**：
```
Problem Suspect 1:
  The class "com.example.cache.OrderCache" occupies 4.2 GB (70%) of the heap.
  The memory is accumulated in one instance of
  "com.github.benmanes.caffeine.cache.BoundedLocalCache" loaded by
  "sun.misc.Launcher$AppClassLoader @ 0x...".
  
  Keywords:
  com.example.cache.OrderCache
  com.github.benmanes.caffeine.cache.BoundedLocalCache
  sun.misc.Launcher$AppClassLoader
  
  Description:
  The class "com.example.cache.OrderCache"...
```

**准确率**：70%+，第一步看这个能快速定位 60% 的问题。

**视图 4：Object Inspector（查看具体对象的字段值）**

**入口**：双击任意对象 -> `Object Inspector` 视图

**展示内容**：
- 对象的所有字段（含继承的）
- 字段值（基本类型直接显示，引用类型显示为链接，可点击跳转）
- `_class` 类元数据
- GC Root 信息

**实战用法**：
1. 在 Dominator Tree 找到元凶对象
2. 双击进入 Object Inspector
3. 看字段值，确认猜测
4. 如 Caffeine Cache 看 `maximumSize` 字段是否设了
5. 如 ThreadLocal 看 `table` 数组大小

**Shallow Size vs Retained Size 的本质区别**：

| 维度 | Shallow Size | Retained Size |
|------|--------------|---------------|
| 含义 | 对象自身占用的字节数 | 对象被回收后能释放的总内存 |
| 计算 | 对象头 + 实例字段（不含引用指向的对象） | Shallow Size + 所有仅被该对象支配的对象的 Shallow Size |
| 典型值 | HashMap 对象本身 48 字节 | HashMap + 所有 Node + 所有 key/value 可能 100MB |
| 找泄漏看哪个 | 不看 | **看 Retained** |
| 计算 Retained 的算法 | 直接计算对象头 + 字段 | **支配集算法** |

**关键认知**：找内存泄漏**永远看 Retained Size**。一个 ArrayList 对象本身才 24 字节，但里面装了 1GB 数据，Retained Size 就是 1GB。

**支配树 Dominator Tree 算法原理（IBM paper）**

**算法来源**：IBM 的 paper "Memory Heap Inspection for the Masses"（2008）。

**核心概念**：

1. **支配关系（dominator）**：节点 d 支配节点 n，当且仅当从 GC Root 到 n 的所有路径都必须经过 d。也就是说，**移除 d 就切断了 n 与 GC Root 的所有联系**。

2. **直接支配者（immediate dominator）**：n 的所有支配者中"最接近 n"的那个，记为 idom(n)。

3. **支配树**：把每个节点的 idom 作为父节点，构成的树。在支配树中，**父节点回收时，所有子节点都能被回收**。

4. **Retained Size**：节点在支配树中的 Retained Size = 自身 Shallow Size + 所有子节点的 Shallow Size 之和。

**算法步骤**（简化版）：

```
1. 从 GC Root 出发，对堆做 BFS/DFS，得到所有对象的可达性
2. 对每个对象 n，计算其支配者集合 dom(n)
   - dom(root) = {root}
   - dom(n) = {n} ∪ (intersection of dom(p) for all p in predecessors(n))
3. 从 dom(n) 中找直接支配者 idom(n)
4. 以 idom 为父节点，构建支配树
5. 计算每个节点的 Retained Size = Shallow Size + sum(children's Retained Size)
```

**算法复杂度**：O(E × α(N))（使用并查集优化后），E 是引用边数，N 是对象数。

**为什么用支配树而非引用树**：
1. **引用关系是图，不是树**：一个对象可能被多个对象引用
2. **支配树把图转成树**：每个节点的 Retained Size 是确定的（不被多次计算）
3. **支配树揭示"回收价值"**：支配树 Top 1 回收能释放最大内存

**Path to GC Roots vs Merge Shortest Paths 的区别**：

| 操作 | 含义 | 适用场景 |
|------|------|---------|
| `Path To GC Roots` | 单个对象到所有 GC Roots 的路径 | 验证猜测（已知泄漏对象） |
| `Merge Shortest Paths` | 多个对象到 GC Roots 的合并最短路径 | 找共性（多个对象都被同一个 Root 持有） |

**实战用法**：

1. **Path To GC Roots**：
   - 已知 OrderCache 是元凶
   - 右键 OrderCache -> `Path To GC Roots` -> `exclude weak/soft references`
   - 看路径：`Thread -> OrderCacheService -> OrderCache -> BoundedLocalCache -> ...`
   - 找到 GC Root 是哪个 Thread，定位元凶线程

2. **Merge Shortest Paths**：
   - 在 Histogram 选多个 OrderEntity 实例
   - 右键 -> `Merge Shortest Paths to GC Roots` -> `exclude weak/soft references`
   - 看所有 OrderEntity 都被同一个 BoundedLocalCache 持有
   - 验证"缓存膨胀"猜测

**exclude weak/soft references 的意义**：
- WeakReference / SoftReference 引用不算"泄漏"（GC 会自动清理）
- 排除后看到的路径都是强引用链
- 找"硬泄漏"必看 exclude weak/soft

**OQL（Object Query Language）查询**

**OQL 语法**：类似 SQL，但 `@` 前缀访问 MAT 内置属性。

```sql
-- 1. 查所有 String 对象
SELECT * FROM java.lang.String

-- 2. 查 Retained Size > 1MB 的 String
SELECT * FROM java.lang.String s WHERE s.@retainedHeapSize > 1048576

-- 3. 查所有 HashMap 实例的 size 字段
SELECT s.size FROM java.util.HashMap s

-- 4. 查所有 HashMap 实例的 Retained Size
SELECT s.@retainedHeapSize FROM java.util.HashMap s

-- 5. 查所有 Caffeine Cache 实例
SELECT * FROM com.github.benmanes.caffeine.cache.BoundedLocalCache

-- 6. 联合查询：所有 Caffeine Cache 的 estimatedSize
SELECT c.estimatedSize() FROM com.github.benmanes.caffeine.cache.BoundedLocalCache c

-- 7. 查所有 ThreadLocal 的 value
SELECT tl.value FROM java.lang.ThreadLocal tl

-- 8. 查所有 ClassLoader 实例
SELECT * FROM java.lang.ClassLoader

-- 9. 查所有长度 > 1000 的 ArrayList
SELECT l FROM java.util.ArrayList l WHERE l.size > 1000

-- 10. 查所有 byte[] 长度 > 1MB
SELECT b FROM byte[] b WHERE b.@length > 1048576
```

**OQL 高级用法**：

```sql
-- TOOLS 调用：用 MAT 内置工具
SELECT * FROM OBJECTS (SELECT OBJECTS s.value FROM java.lang.ThreadLocal s)

-- 聚合：统计 HashMap 的总 size
SELECT SUM(s.size) FROM java.util.HashMap s

-- 排序：按 Retained Size 降序取前 10
SELECT s, s.@retainedHeapSize FROM java.util.HashMap s ORDER BY s.@retainedHeapSize DESC LIMIT 10

-- 子查询：查所有被 OrderCache 持有的 OrderEntity
SELECT * FROM com.example.entity.OrderEntity o WHERE o IN (SELECT OBJECTS c.cache.asMap().values() FROM com.example.cache.OrderCache c)
```

**MAT 内置属性**：

| 属性 | 含义 |
|------|------|
| `@objectAddress` | 对象内存地址 |
| `@usedHeapSize` | Shallow Size |
| `@retainedHeapSize` | Retained Size |
| `@class` | 类元数据 |
| `@classLoader` | 类加载器 |
| `@gcRoot` | 是否 GC Root |
| `@length` | 数组长度（仅数组对象） |

**10GB+ 大 dump 处理**

**问题**：MAT 默认 `-Xmx1g`，处理 4GB 以上 dump 会 OOM。

**MAT 内存经验法则**：MAT 内存 = dump 文件大小 × 2。4GB dump 用 8GB MAT，10GB dump 用 20GB MAT。

**解决方案**：

1. **修改 MemoryAnalyzer.ini**：
   ```
   -vmargs
   -Xmx20g
   -XX:+UseG1GC
   -XX:+AlwaysPreTouch
   ```

2. **关闭"解析时计算 Retained Size"**：
   - `Preferences > Memory Analyzer > "Compute precise retained size"` 取消勾选
   - 改为按需计算（右键对象 -> `Calculate Retained Size`）
   - 解析时间从 30 分钟降到 5 分钟

3. **使用"对象引用树懒加载"**：
   - MAT 默认全索引，大 dump 要 30 分钟
   - 用 `--loader` 离线模式（命令行解析）：
     ```bash
     ./MemoryAnalyzer -console -application org.eclipse.mat.api.parse heap.bin
     ```

4. **离线分析**：把 dump 拉到本地 32GB 内存的开发机分析

5. **在线 MAT**（heapdump.io）：浏览器上传，云端分析
   - 优势：无需本地装工具
   - 劣势：数据上传到第三方，敏感数据慎用

6. **用 jmap -histo 先定位**：
   - 先 `jmap -histo:live PID` 看哪类对象大
   - 针对性 dump（如只 dump 部分 heap）
   - 但 JVM 不支持部分 dump，所以这步只能筛选

7. **JFR 替代**：
   - 大堆（>32GB）建议用 JFR 持续录制
   - OOM 时 JFR 自动 dump
   - JFR 文件小（200MB 限制），MAT 之外用 JMC 分析

**识别"看似泄漏实则是缓存膨胀"**

**典型现象**：
1. Leak Suspects 报告指向 `Caffeine` / `ConcurrentHashMap` / `HashMap`
2. 这些 Map 的 key 是业务对象（如 userId、orderId）
3. 业务方说"缓存设了过期但内存还是涨"

**排查步骤**：

1. **查缓存配置**：
   ```bash
   # Arthas 查 Caffeine 实例
   vmtool --action getInstances --className com.github.benmanes.caffeine.cache.BoundedLocalCache --limit 10
   
   # 查具体配置
   vmtool --action getInstances --className com.github.benmanes.caffeine.cache.BoundedLocalCache --express 'instances[0].policy'
   ```

2. **查缓存实际大小**：
   ```bash
   # OGNL 调用 estimatedSize
   ognl '@com.example.OrderCache@CACHE.estimatedSize()'
   ```

3. **看 Retained Size 是否合理**：
   - 100w Key × 1KB value = 1GB，是预期吗
   - 看 MAT Object Inspector 看 `maximumSize` 字段值
   - 看 `expireAfterAccessNanos` / `expireAfterWriteNanos` 字段值

4. **看 key 分布**：
   ```sql
   -- OQL 取前 1000 个 key 看分布
   SELECT c.cache.asMap().keySet().iterator().next() FROM com.example.cache.OrderCache c LIMIT 1000
   ```
   - 是不是异常大量重复（key 的 equals/hashCode 错误）
   - 是不是预期外的 key（如临时 ID 当永久 key）

5. **看 expireAfterWrite 是否生效**：
   - 在 MAT 里看对象的 creation time（如果对象有 timestamp 字段）
   - 业务方配合：在测试环境跑 1 小时，看缓存大小是否收敛

**典型假泄漏场景**：

| 场景 | 现象 | 真实根因 |
|------|------|---------|
| Caffeine maximumSize 配置错误 | 设了 maximumWeight 但没设 weigher | maximumWeight 需要 weigher 才生效，否则无上限 |
| ThreadLocal 没清理 | 线程池复用导致 ThreadLocal 累积 | 业务代码 finally 没 remove |
| HashMap 键冲突 | 同一对象塞多份 | equals/hashCode 实现错误 |
| 监听器未 unregister | 事件源持有监听器引用 | 注册了没解注册 |
| 静态集合无限增长 | static Map 永远不清理 | 没设上限、没设过期 |

**生产实战经验**：

1. **MAT 第一次打开大 dump 要 30 分钟**：让它跑完，不要中断，否则索引损坏
2. **优先看 Leak Suspects**：自动分析准确率 70%+，能快速定位嫌疑
3. **Retained Size 排序找 Top 1**：Dominator Tree 按 Retained 排序，第一名通常就是元凶
4. **导出报告**：`Leak Suspects Report` 可导出 HTML，便于团队复盘
5. **结合 jstack 看**：哪个线程持有泄漏对象的引用，往往就是元凶线程
6. **多次 dump 对比**：同一服务每隔 1 小时 dump 一次，对比 Dominator Tree 变化，找持续增长的对象

---

#### 4. 5 类常见内存泄漏模式

**5 类内存泄漏模式全景**：

| 模式 | 典型代码 | 识别清单 | 修复方案 |
|------|---------|---------|---------|
| 缓存膨胀 | Caffeine / Map 未设上限 | MAT 看缓存类 Retained 大 | 加 maximumSize + expireAfterWrite |
| ThreadLocal 累积 | 线程池下未 remove | MAT 看 ThreadLocalMap 大 | finally 中 remove |
| 监听器未 unregister | 注册了没解注册 | MAT 看事件源持有监听器 | 配对 register/unregister |
| 静态集合无限增长 | static Map 永不清理 | MAT 看 System Class 持有的 Map | 改成有上限的缓存 |
| finalize 队列堆积 | 重写 finalize 方法 | MAT 看 Finalizer 队列大 | 避免 finalize |

**模式 1：缓存膨胀**

**典型代码**：

```java
// 错误 1：Caffeine 没设 maximumSize
public class OrderCache {
    public static final Cache<String, Order> CACHE = Caffeine.newBuilder()
            .expireAfterWrite(10, TimeUnit.MINUTES)  // 设了过期
            .build();  // 没设 maximumSize！
}

// 错误 2：ConcurrentHashMap 当缓存用
public class UserCache {
    private static final Map<String, User> CACHE = new ConcurrentHashMap<>();
    public static User get(String userId) {
        return CACHE.computeIfAbsent(userId, UserCache::loadFromDb);
        // 永远不清理！
    }
}

// 错误 3：maximumWeight 设了但没设 weigher
public class BigObjectCache {
    public static final Cache<String, BigObject> CACHE = Caffeine.newBuilder()
            .maximumWeight(1000)  // 设了 maximumWeight
            // .weigher(...)  // 但没设 weigher！
            .build();
    // maximumWeight 默认 weigher 是 "每个对象权重=1"，等价于 maximumSize
}
```

**识别清单**：
- MAT Dominator Tree Top 1 是 Caffeine BoundedLocalCache / ConcurrentHashMap / HashMap
- Arthas `vmtool --action getInstances --className com.github.benmanes.caffeine.cache.BoundedLocalCache` 看实例
- OGNL 调用 `cache.estimatedSize()` 看大小
- OQL 查 `c.maximumSize` 字段值

**修复方案**：

```java
// 修复 1：Caffeine 设 maximumSize + expireAfterWrite
public static final Cache<String, Order> CACHE = Caffeine.newBuilder()
        .maximumSize(10000)
        .expireAfterWrite(10, TimeUnit.MINUTES)
        .recordStats()  // 开启统计
        .build();

// 修复 2：ConcurrentHashMap 改成 Caffeine 或 WeakHashMap
public static final Map<String, User> CACHE = 
    Caffeine.newBuilder()
        .maximumSize(10000)
        .expireAfterWrite(10, TimeUnit.MINUTES)
        .build()
        .asMap();

// 修复 3：maximumWeight + weigher 配合使用
public static final Cache<String, BigObject> CACHE = Caffeine.newBuilder()
        .maximumWeight(1024 * 1024 * 100)  // 100MB 总权重
        .weigher((String key, BigObject val) -> val.size())  // 按对象大小算权重
        .build();
```

**生产案例（在线问诊系统 - 问诊订单缓存 100w Key）**：
- 现象：问诊订单服务堆 92%，Full GC 频繁
- 排查：jmap -histo:live（已摘流量），看 Top 1 是 OrderEntity
- 根因：Caffeine maximumSize 设了 100w（应该 1w），100w OrderEntity × 4KB = 4GB
- 修复：Arthas ognl 改 maximumSize（不重启）+ PR 修复

**模式 2：ThreadLocal 累积**

**典型代码**：

```java
// 错误：ThreadLocal 用完没 remove
public class RequestContext {
    private static final ThreadLocal<RequestInfo> CONTEXT = new ThreadLocal<>();
    
    public static void set(RequestInfo info) {
        CONTEXT.set(info);
    }
    
    public static RequestInfo get() {
        return CONTEXT.get();
    }
    // 没有 remove()！
}

// 在线程池下复用，CONTEXT 累积
@Service
public class OrderService {
    @Autowired
    private ThreadPoolExecutor executor;
    
    public void process(Order order) {
        executor.execute(() -> {
            RequestContext.set(new RequestInfo(order));
            // 业务处理
            doBusiness();
            // 没 remove，下次任务复用线程时还在
        });
    }
}
```

**为什么 ThreadLocal 在线程池下是"隐形杀手"**：
- 线程池核心线程数 50，每个线程的 ThreadLocalMap 累积 1000 个 RequestInfo
- 50 × 1000 = 5w 个 RequestInfo，每个 10KB = 500MB
- 看似单线程没问题，但累积起来很大

**识别清单**：
- MAT 看 `java.lang.ThreadLocal$ThreadLocalMap` Retained Size 大
- OQL 查 `SELECT tl FROM java.lang.ThreadLocal$ThreadLocalMap tl` 看实例
- 看业务代码 grep `ThreadLocal` 是否配对 `set` / `remove`

**修复方案**：

```java
// 修复 1：finally 中 remove
public class RequestContext {
    private static final ThreadLocal<RequestInfo> CONTEXT = new ThreadLocal<>();
    
    public static void set(RequestInfo info) {
        CONTEXT.set(info);
    }
    
    public static void clear() {
        CONTEXT.remove();
    }
}

// 业务代码
executor.execute(() -> {
    try {
        RequestContext.set(new RequestInfo(order));
        doBusiness();
    } finally {
        RequestContext.clear();  // 必须 remove
    }
});

// 修复 2：用 try-with-resources 模式
public class RequestContext implements AutoCloseable {
    private static final ThreadLocal<RequestInfo> CONTEXT = new ThreadLocal<>();
    
    public RequestContext(RequestInfo info) {
        CONTEXT.set(info);
    }
    
    @Override
    public void close() {
        CONTEXT.remove();
    }
}

// 业务代码
try (RequestContext ctx = new RequestContext(new RequestInfo(order))) {
    doBusiness();
}
```

**模式 3：监听器 / Callback 未 unregister**

**典型代码**：

```java
// 错误：注册了没解注册
public class EventBus {
    private final List<Listener> listeners = new CopyOnWriteArrayList<>();
    
    public void register(Listener listener) {
        listeners.add(listener);
    }
    // 没有 unregister()！
}

// 业务代码
@Service
public class OrderService {
    @Autowired
    private EventBus eventBus;
    
    public void process(Order order) {
        // 每次请求都注册一个监听器！
        eventBus.register(event -> handle(event, order));
        // 短生命周期对象被长生命周期的 EventBus 持有
    }
}
```

**识别清单**：
- MAT 看 `java.util.concurrent.CopyOnWriteArrayList` / `java.util.ArrayList` Retained Size 大
- 看引用链：`EventBus -> listeners -> 100w Listener 实例`
- 业务代码 grep `register` 是否配对 `unregister`

**修复方案**：

```java
// 修复 1：配对 unregister
public class EventBus {
    private final List<Listener> listeners = new CopyOnWriteArrayList<>();
    
    public void register(Listener listener) {
        listeners.add(listener);
    }
    
    public void unregister(Listener listener) {
        listeners.remove(listener);
    }
}

// 业务代码
public void process(Order order) {
    Listener listener = event -> handle(event, order);
    eventBus.register(listener);
    try {
        doBusiness();
    } finally {
        eventBus.unregister(listener);  // 必须 unregister
    }
}

// 修复 2：用 WeakReference 让监听器自动回收
public class EventBus {
    private final List<WeakReference<Listener>> listeners = new CopyOnWriteArrayList<>();
    
    public void register(Listener listener) {
        listeners.add(new WeakReference<>(listener));
    }
}
```

**模式 4：静态集合无限增长**

**典型代码**：

```java
// 错误：static Map 永不清理
public class UserCache {
    private static final Map<String, User> CACHE = new HashMap<>();
    // static 字段是 GC Root，永远不回收
    // 业务往里塞东西，永远不清理
}

// 错误：单例 Service 持有大集合
public class OrderService {
    private static final OrderService INSTANCE = new OrderService();
    private final Map<String, Order> orderMap = new HashMap<>();
    // 单例的字段等同于 static，永不回收
}
```

**识别清单**：
- MAT 看 GC Root 类型为 `System Class` 的对象
- 看 `ClassLoader` 持有的 static 字段
- 业务代码 grep `static.*Map\|static.*List\|static.*Set` 看是否有清理逻辑

**修复方案**：

```java
// 修复 1：改成有上限的缓存
public class UserCache {
    private static final Cache<String, User> CACHE = Caffeine.newBuilder()
            .maximumSize(10000)
            .expireAfterWrite(10, TimeUnit.MINUTES)
            .build();
}

// 修复 2：用 WeakHashMap（key 是弱引用）
public class UserCache {
    private static final Map<String, User> CACHE = new WeakHashMap<>();
    // key 弱引用，JVM GC 时自动清理
    // 注意：WeakHashMap 不是线程安全的
}
```

**模式 5：finalize 队列堆积**

**典型代码**：

```java
// 错误：重写 finalize
public class Resource implements AutoCloseable {
    @Override
    protected void finalize() throws Throwable {
        // 在 finalize 中做清理
        close();
    }
    // finalize 会被 JVM 加入 Finalizer 队列
    // Finalizer 线程优先级低，可能清理不及时
}

// 大量 Resource 实例创建后，Finalizer 队列堆积
for (int i = 0; i < 1000000; i++) {
    new Resource();  // 没主动 close
}
```

**finalize 为什么被废弃**：
- JDK 9 标记 `@Deprecated`
- JDK 18 提案 JEP 421：`finalize` 标记 `forRemoval=true`
- 未来 JDK 版本将完全移除

**finalize 的问题**：
1. **不可靠**：JVM 不保证 finalize 一定执行（程序退出时 Finalizer 线程可能没跑完）
2. **性能差**：finalize 让对象经历"创建 -> 入 Finalizer 队列 -> Finalizer 线程执行 -> GC"两次 GC 才能回收
3. **安全风险**：finalize 中可以"复活"对象（`this` 重新被引用），导致对象无法回收

**识别清单**：
- MAT 看 `java.lang.ref.Finalizer$Queue` Retained Size 大
- jstack 看 `Finalizer` 线程状态
- 业务代码 grep `finalize` 是否重写

**修复方案**：

```java
// 修复：用 try-with-resources + AutoCloseable
public class Resource implements AutoCloseable {
    @Override
    public void close() {
        // 主动调用 close()，不依赖 finalize
    }
}

// 业务代码
try (Resource res = new Resource()) {
    // 使用 res
}  // 自动调用 close()
```

**5 类内存泄漏模式统一识别流程**：

```
MAT 分析 dump
   │
   ▼
Dominator Tree Top 1 是什么？
   │
   ├─ Caffeine / ConcurrentHashMap / HashMap
   │  -> 缓存膨胀（模式 1）
   │  -> 检查 maximumSize / weigher / expireAfterWrite
   │
   ├─ ThreadLocalMap
   │  -> ThreadLocal 累积（模式 2）
   │  -> 检查业务代码 ThreadLocal.set/remove 配对
   │
   ├─ CopyOnWriteArrayList / ArrayList（事件源持有）
   │  -> 监听器未 unregister（模式 3）
   │  -> 检查业务代码 register/unregister 配对
   │
   ├─ System Class 持有的 Map / List
   │  -> 静态集合无限增长（模式 4）
   │  -> 检查 static 字段是否有清理逻辑
   │
   └─ Finalizer$Queue
      -> finalize 队列堆积（模式 5）
      -> 检查业务代码是否重写 finalize
```

**生产实战经验**：

1. **Code Review 必查 ThreadLocal**：grep `ThreadLocal` 看是否配对 `remove`
2. **Code Review 必查监听器**：grep `register` 看是否配对 `unregister`
3. **Code Review 必查缓存配置**：grep `Caffeine.newBuilder` 看是否设 `maximumSize`
4. **Code Review 必查 static 集合**：grep `static.*Map\|static.*List` 看是否有清理
5. **禁止重写 finalize**：Code Review 检查，直接 reject
6. **静态代码扫描**：用 SpotBugs / SonarQube 自动扫描内存泄漏模式

---

#### 5. 5 分钟定位 OOM 元凶的实战节奏

**5 分钟定位法的时间轴**：

```
0:00-0:30  现象确认 - 看监控告警、确认 OOM 类型
0:30-1:00  止损决策 - 摘流量 / 限流 / 重启
1:00-2:00  抓现场 - dump + GC 日志 + jstack + NMT
2:00-3:00  GC 日志分类 - 频繁 Minor / Mixed 慢 / Full 失败
3:00-4:00  MAT 分析 - Dominator Tree + Path to GC Roots
4:00-5:00  根因止血 - 清缓存 / 修复代码 / 扩容
```

**0:00-0:30 现象确认**

**关键动作**：
1. 看监控告警：是 OOM 重启了？还是 GC 抖动？还是堆使用率告警？
2. 看日志：是 `Java heap space`？`Metaspace`？`Direct buffer memory`？`unable to create new native thread`？
3. 看影响范围：单 Pod 还是集群？业务影响多大？

**判断 OOM 类型**：

| 现象 | OOM 类型 | 紧急度 |
|------|---------|--------|
| OOM 重启 + 日志 `Java heap space` | 堆 OOM | P0 |
| OOM 重启 + 日志 `Metaspace` | 元空间 OOM | P0 |
| OOM 重启 + 日志 `Direct buffer memory` | 直接内存 OOM | P0 |
| OOM 重启 + 日志 `unable to create new native thread` | 线程 OOM | P0 |
| Pod 被 OOM kill（无 JVM OOM 日志） | Pod RSS 超 limit | P0 |
| GC overhead limit exceeded（未重启） | GC 预警 | P1 |
| 堆使用率 90%+ 持续 5 分钟 | 即将 OOM | P1 |

**Pod OOM kill vs JVM OOM 的区别**：
- **JVM OOM**：JVM 进程未死，业务线程抛 OutOfMemoryError，dump 文件可能已生成
- **Pod OOM kill**：JVM 进程被内核 kill（RSS 超 limit），无 dump 文件，业务中断

**0:30-1:00 止损决策**

**止损优先级**：

1. **第一选择：摘流量 + 抓现场**（最佳）
   - K8s: `kubectl cordon <node>` + `kubectl drain <node>`
   - Nacos 摘节点：`curl -X POST "http://nacos/v1/ns/instance?serviceName=xxx&ip=xxx&enabled=false"`
   - **关键**：摘流量后服务还在，可以慢慢抓 dump

2. **第二选择：限流降级**（如果摘流量做不到）
   - Sentinel 限流接口到 10 QPS
   - 触发降级返回"系统繁忙"

3. **第三选择：扩容**（如果根因是流量突增）
   - HPA 自动扩容 +10 Pod
   - 但如果是泄漏，扩容只是延缓

4. **最后选择：重启**（如果以上都不行）
   - **风险**：丢失现场，无法定位根因
   - **必须先做的事**：jstack + jmap dump

**为什么不能直接重启**：
1. **GC 日志能看到，但堆内存看不到**：OOM 元凶在堆里，重启就丢失
2. **可能复现**：不修根因，重启后 30 分钟又出问题
3. **复盘需要证据**：故障复盘没证据，等于白复盘

**正确止损流程**：
```
0:00 - 看监控确认是 OOM（30 秒）
0:30 - 摘流量（10 秒）
0:40 - 抓 jstack（5 秒，不 STW）
0:45 - 抓 jmap dump（30 秒，会 STW 但已摘流量）
1:15 - 抓 GC 日志最后 1 小时（10 秒）
1:25 - 抓 NMT summary（如果是 Direct Buffer OOM）
1:30 - 此时现场已抓完，可以决定重启或继续
```

**1:00-2:00 抓现场**

**抓现场命令清单**：

```bash
# 1. 确认 PID
jps -lvm
# 12345 com.example.ConsultApplication

# 2. 抓 jstack（不 STW，必抓）
jstack -l 12345 > /tmp/jstack_$(date +%s).log

# 3. 抓 GC 日志（如果已开 Xlog）
cp /data/logs/gc.log /tmp/gc_$(date +%s).log

# 4. 抓 heap dump（会 STW，但已摘流量）
jcmd 12345 GC.heap_dump /data/dump/heap_$(date +%s).bin
# 输出：Heap dump file created [/data/dump/heap_1785234567.bin, 4567890123 bytes] in 8.234s

# 5. 抓对象直方图（轻量，先看个大概）
jcmd 12345 GC.class_histogram > /tmp/histo_$(date +%s).log

# 6. 抓 NMT（如果是 Direct Buffer OOM）
jcmd 12345 VM.native_memory summary > /tmp/nmt_$(date +%s).log

# 7. 如果有 Arthas，开 JFR 录制
jcmd 12345 JFR.start name=incident duration=5m filename=/tmp/incident.jfr

# 8. 抓 Arthas vmtool 看 Caffeine 实例
vmtool --action getInstances --className com.github.benmanes.caffeine.cache.BoundedLocalCache
```

**不同 OOM 类型的抓现场侧重点**：

| OOM 类型 | 必抓 | 选抓 |
|---------|------|------|
| 堆 OOM | heap dump + GC 日志 + jstack | class_histogram |
| Metaspace OOM | heap dump + jstack | ClassLoader 实例（Arthas vmtool） |
| Direct Buffer OOM | NMT summary + heap dump | DirectByteBuffer 实例（Arthas vmtool） |
| Thread OOM | jstack + 业务代码 Thread 创建点 | heap dump |
| StackOverflow | jstack + 业务代码递归点 | heap dump |

**避免抓 dump 引发雪崩**：
1. **必须先摘流量**：摘流量后即使 STW 30 秒，业务无感知
2. **分批抓**：集群 10 台只抓 1 台
3. **指定路径**：dump 到 `/data/dump/`（专门挂大盘），不要 dump 到容器 rootfs
4. **磁盘预留**：dump 文件 ≈ 堆大小，6G 堆要预留 7G 磁盘
5. **OOM 时自动 dump**：`-XX:+HeapDumpOnOutOfMemoryError` 配置好，下次 OOM 自动留下 dump

**2:00-3:00 GC 日志分类**

**看 GC 日志的关键字段**：

```bash
# 看最近 100 行 GC 日志
tail -100 /tmp/gc_1785234567.log

# 关键字段 grep
grep -E "Full GC|Concurrent Mode Failure|to-space exhausted|System.gc|Humongous|Metadata GC Threshold|Last ditch" /tmp/gc_1785234567.log
```

**根据 GC 日志分类元凶**：

| GC 日志特征 | 元凶类型 | 验证方向 |
|------------|---------|---------|
| `Full GC (System.gc)` | 显式调用 System.gc | grep 代码搜 `System.gc` |
| `Full GC (Allocation Failure)` | 老年代分配失败 | 看堆 dump，找大对象 |
| `Concurrent Mode Failure`（CMS） | CMS 并发标记跟不上 | 看 CMS 配置 |
| `to-space exhausted`（G1） | G1 疏散失败 | 调 G1ReservePercent |
| `Humongous Allocation`（G1） | 大对象 > Region/2 | 找大对象来源 |
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

**3 种 GC 异常类型的判断**：

| 类型 | 现象 | 根因 |
|------|------|------|
| Minor GC 频繁 | YGC 次数 > 1次/秒 | Eden 太小 / 分配速率过高 |
| Mixed GC 慢 | 单次 > 500ms | Old Region 多、存活率高 |
| Full GC 失败 | `to-space exhausted` | Survivor 或 to-space 不够 |

**3:00-4:00 MAT 分析**

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

**典型元凶对象速查**：

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
| `ThreadLocalMap` | 500MB-1GB | ThreadLocal 未 remove |
| `Finalizer$Queue` | 100MB-1GB | finalize 方法堆积 |
| `java.lang.Class` | 100MB-500MB | CGLIB / Groovy 动态类 |

**4:00-5:00 根因止血**

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

**止血后闭环**：

1. **PR 修复**：
   - 缓存泄漏：加 maximumSize、加 expireAfterWrite
   - 大对象：改成分页查询、流式读取
   - 监听器未清理：注册时配 unregister

2. **监控告警**：
   - Prometheus + JVM Exporter：监控堆使用率、GC 频率、GC 耗时
   - 告警阈值：堆使用率 > 85% 持续 1 分钟、Full GC > 1 次/分钟
   - 缓存大小告警：`cache.estimatedSize()` 上报 Prometheus，超阈值告警

3. **复盘文档**：
   ```
   ## 故障复盘
   - 时间：2026-08-05 14:30 - 15:15
   - 影响：监管上报服务 OOM 重启，24h 必达任务丢失 200 条
   - 根因：ReportTask 重试时每次新建而非复用，Map 无限增长
   - 止血：摘流量 + 清空 Map + 重启
   - 根因修复：PR #1234 重试时复用 ReportTask + 加 maximumSize=10000
   - 改进项：
     1. 全量排查所有 Map 缓存配置
     2. 加 Map 大小监控告警
     3. JVM 调优 Checklist 加入"Map 上限检查"
   ```

4. **知识沉淀**：
   - 更新团队 JVM 调优 Checklist
   - 故障案例归档到 wiki
   - 定期演练（混沌工程）

**5 分钟定位法的踩坑点**：

1. **第 1 分钟踩坑：直接重启**
   - 错误：看到 OOM 立即重启，丢失现场
   - 正确：先摘流量再抓 dump，最后才重启

2. **第 2 分钟踩坑：抓 dump 时未摘流量**
   - 错误：业务还在跑时 jmap dump，STW 30 秒引发雪崩
   - 正确：必须先摘流量再 dump

3. **第 3 分钟踩坑：GC 日志看错重点**
   - 错误：看 Full GC 次数，忽略 Mixed GC 后 Old 涨幅
   - 正确：看 Mixed GC 后 Old 是否还在涨，判断是否泄漏

4. **第 4 分钟踩坑：MAT 看错视图**
   - 错误：看 Histogram 找"对象数最多的类"
   - 正确：看 Dominator Tree 找"Retained 最大的对象"

5. **第 5 分钟踩坑：止血不彻底**
   - 错误：清缓存后未加监控，第二天又 OOM
   - 正确：止血 + PR 修复 + 监控告警 + 复盘

**生产实战经验**：

1. **5 分钟定位是理想**：实际 8-15 分钟更常见，但思路要清晰
2. **MAT 打开大 dump 要等**：1GB dump 索引 1-2 分钟，6GB 要 5-10 分钟，不能急
3. **第一次定位不出来很正常**：可能元凶是动态生成的类（如 CGLIB），需要看 Histogram 多次刷新
4. **团队协作**：一人看日志、一人看 dump、一人查代码，比单干快 3 倍
5. **演练**：定期注入故障（如内存泄漏演练），让团队熟悉工具链

---

## 题目二（场景应用题）：在线问诊系统监管上报服务 OOM 排查

> **场景**：在线问诊系统生产环境，监管上报服务（独立微服务，负责医疗数据上报到监管平台）某天 14:32 告警：服务 OOM 重启，24h 必达任务丢失。登录监控看到：
> - 4C8G Pod，JVM 参数 `-Xms6g -Xmx6g -XX:+UseG1GC -XX:MaxGCPauseMillis=100 -XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/data/dump/`
> - 服务日志：`java.lang.OutOfMemoryError: Java heap space`，自动 dump 已生成（4.5GB）
> - 监控告警：14:25 堆使用率从 60% 飙到 92%，14:30 Full GC 5 次/分钟，14:32 OOM 重启
> - 业务背景：监管要求"问诊数据 24h 必达"，上报失败要重试，重试上限 24h
> - 影响范围：约 200 条上报任务丢失（重试上限到了仍未成功），需要人工补录
>
> **要求**：用 STAR 法则完整讲述排查过程，包括止血、定位、根因、修复、预防。

### 作答区

#### Situation（情境）

**业务背景**：
- 监管上报服务负责把问诊数据上报到当地卫健委监管平台
- 监管要求"24h 必达"：上报失败必须重试，直到成功或超过 24h
- 单次上报任务：拉取问诊数据 -> 生成报文 -> HTTP POST 上报 -> 失败则重试
- 上报频率：每分钟约 100 次（高峰 200 次/分钟）

**服务架构**：
- 微服务，独立部署，4C8G Pod × 3 实例
- JVM：`-Xms6g -Xmx6g -XX:+UseG1GC -XX:MaxGCPauseMillis=100`
- OOM 自动 dump：`-XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/data/dump/`
- 任务调度：内部用 `ScheduledExecutorService` 每分钟扫描待上报任务

**故障时间线**：
```
14:25:00 - 堆使用率从 60% 开始上涨（监控告警：堆使用率 > 80%）
14:28:00 - 堆使用率 92%，Full GC 开始频繁（告警：Full GC > 1次/分钟）
14:30:00 - Full GC 5 次/分钟，每次 STW 1.2-1.8s，业务 RT 飙到 3s
14:31:00 - 服务日志开始报 OOM warning（GC overhead limit exceeded）
14:32:15 - 服务日志：java.lang.OutOfMemoryError: Java heap space
14:32:16 - OOM 自动 dump 触发，生成 4.5GB dump 文件
14:32:24 - JVM 进程退出，K8s 自动重启 Pod
14:32:30 - 新 Pod 启动，但丢失了内存中 200 条待上报任务
14:35:00 - 业务方反馈：监管平台少收 200 条上报，需要人工补录
```

#### Task（任务）

**5 分钟内完成**：
1. 止血：恢复服务，避免持续 OOM
2. 定位：找到 OOM 元凶
3. 修复：止血 + 根因修复
4. 预防：避免同类问题再发生

**额外要求**：
- 24h 必达任务不能丢（需要补录丢失的 200 条）
- 不能简单扩容了事（不修根因，下次必复现）

#### Action（行动）

##### 第 1 分钟：现象确认 + 止损决策

**现象确认（30 秒）**：
- 看监控：堆使用率从 60% 飙到 92%，Full GC 频繁
- 看日志：`Java heap space`，自动 dump 已生成
- 看影响：3 个 Pod 中 1 个 OOM 重启，其他 2 个堆使用率 75%（未 OOM 但已临界）

**止损决策（30 秒）**：
- OOM 已自动重启，新 Pod 已启动，业务恢复
- 但其他 2 个 Pod 临界，可能 30 分钟内也 OOM
- 决策：摘除临界 Pod 流量 + 抓现场

**摘流量命令**：
```bash
# Nacos 摘除临界 Pod
curl -X POST "http://nacos/v1/ns/instance?serviceName=report-service&ip=10.0.1.21&enabled=false"
curl -X POST "http://nacos/v1/ns/instance?serviceName=report-service&ip=10.0.1.22&enabled=false"
# 只留新启动的 Pod 接流量
```

**关键决策**：不重启临界 Pod，让它继续跑（堆使用率 75%），先抓 dump 再处理。

##### 第 2 分钟：抓现场

**抓现场命令清单**：

```bash
# 1. 确认 PID
jps -lvm
# 12345 com.example.ReportServiceApplication

# 2. 抓 jstack（不 STW）
jstack -l 12345 > /tmp/jstack_$(date +%s).log

# 3. 抓 GC 日志最后 1 小时
cp /data/logs/gc.log /tmp/gc_$(date +%s).log

# 4. 抓 heap dump（已摘流量，可 STW）
jcmd 12345 GC.heap_dump /data/dump/heap_active_$(date +%s).bin
# 输出：Heap dump file created [/data/dump/heap_active_1785234567.bin, 4567890123 bytes] in 8.234s

# 5. 抓对象直方图（轻量）
jcmd 12345 GC.class_histogram > /tmp/histo_$(date +%s).log

# 6. Arthas 查 ReportTask 实例
vmtool --action getInstances --className com.example.ReportTask --limit 10
```

**抓到的现场**：
- 自动 dump（OOM 时）：4.5GB
- 主动 dump（OOM 后 1 分钟）：4.2GB
- GC 日志：最近 1 小时
- jstack：当前线程状态
- class_histogram：对象直方图

##### 第 3 分钟：GC 日志分析

**看 GC 日志关键字段**：

```bash
grep -E "Full GC|Allocation Failure|Humongous|Metadata" /tmp/gc_1785234567.log | tail -50
```

**关键发现**：
```
14:25:00 [GC pause (G1 Evacuation Pause) (young) ... 1800M->1200M]
14:25:30 [GC pause (G1 Evacuation Pause) (young) ... 2100M->1300M]
14:26:00 [GC pause (G1 Evacuation Pause) (mixed) ... 2400M->1400M]
14:26:30 [GC pause (G1 Evacuation Pause) (mixed) ... 2700M->1500M]
14:27:00 [GC pause (G1 Evacuation Pause) (mixed) ... 3000M->1700M]
14:27:30 [GC pause (G1 Evacuation Pause) (mixed) ... 3300M->2000M]
14:28:00 [Full GC (Allocation Failure) ... 3600M->2800M, 1.234s]
14:29:00 [Full GC (Allocation Failure) ... 4200M->3500M, 1.567s]
14:30:00 [Full GC (Allocation Failure) ... 4800M->4200M, 1.789s]
14:31:00 [Full GC (Allocation Failure) ... 5400M->4800M, 1.823s]
14:32:00 [Full GC (Allocation Failure) ... 5800M->5400M, 1.891s]
14:32:15 java.lang.OutOfMemoryError: Java heap space
```

**分析**：
1. **14:25-14:27 Mixed GC 后 Old 持续涨**：从 1200M 涨到 2000M，30 秒涨 100M，每分钟涨 200M
2. **14:28 Full GC 开始**：Old 满，触发 Full GC
3. **Full GC 后 Old 没降**：5400M -> 4800M（仅降 600M），说明 80%+ 是无法回收的"硬泄漏"
4. **Full GC 频率加快**：14:28 第一次，14:32 第 5 次，间隔从 60 秒缩到 15 秒
5. **元凶类型**：长生命周期对象累积（不是大对象，因为没看到 Humongous Allocation）

**结论**：是泄漏型 OOM，不是流量突增或大对象。

##### 第 4 分钟：MAT 分析

**第 1 步：看 Leak Suspects（自动分析）**

```
Problem Suspect 1:
  The class "com.example.service.ReportTaskManager" occupies 3.8 GB (84%) of the heap.
  The memory is accumulated in one instance of
  "java.util.concurrent.ConcurrentHashMap" loaded by
  "sun.misc.Launcher$AppClassLoader @ 0x...".
  
  Keywords:
  com.example.service.ReportTaskManager
  java.util.concurrent.ConcurrentHashMap
```

**结论**：Leak Suspects 直接指向 `ReportTaskManager` 的 `ConcurrentHashMap` 占 3.8GB。

**第 2 步：看 Dominator Tree**

```
Top 1: com.example.service.ReportTaskManager @ 0x...
       Shallow: 64 bytes
       Retained: 3.8 GB    ← 元凶！
       ├─ java.util.concurrent ConcurrentHashMap @ 0x...
       │  Shallow: 80 bytes
       │  Retained: 3.7 GB
       │  ├─ java.util.concurrent.ConcurrentHashMap$Node[] @ 0x...
       │  │  Retained: 3.5 GB
       │  │  └─ [大量 com.example.entity.ReportTask 实例]
       │  └─ ...
       └─ ...
```

**结论**：`ConcurrentHashMap` 占 3.7GB，里面是大量 `ReportTask` 实例。

**第 3 步：看 Object Inspector**

查看 `ConcurrentHashMap` 的字段：
- `table`：Node 数组，长度 67108864（64M 槽位）
- `size`：约 280w（280 万个 ReportTask）

查看 `ReportTask` 的字段：
- `reportId`：UUID，36 字符
- `payload`：JSON 字符串，平均 1.2KB
- `retryCount`：1-5 次
- `nextRetryTime`：时间戳

**计算**：
- 280w × 1.2KB payload = 3.36GB
- 280w × 32 字节 HashMap Node = 90MB
- 64M 槽位 × 32 字节 = 2GB（数组本身）
- 总计：3.36GB + 90MB + 2GB ≈ 5.4GB（与堆使用率吻合）

**第 4 步：看 Path to GC Roots**

```
Thread "report-scheduler-1" 
  └─ ReportTaskManager @ 0x...
     └─ ConcurrentHashMap<UUID, ReportTask> taskMap @ 0x...
        └─ 280w ReportTask 实例
```

**结论**：`ReportTaskManager` 是单例（被 `report-scheduler-1` 线程持有），其 `taskMap` 累积了 280w 个 ReportTask。

##### 第 5 分钟：根因定位 + 止血

**根因定位**：

查看 `ReportTaskManager` 源码（用 Arthas `jad` 反编译）：

```java
@Service
public class ReportTaskManager {
    // 错误：taskMap 没设上限
    private final Map<UUID, ReportTask> taskMap = new ConcurrentHashMap<>();
    
    public void submit(ReportData data) {
        ReportTask task = new ReportTask(data);
        taskMap.put(task.getId(), task);  // 每次新建 ReportTask
        executor.submit(task);
    }
    
    public void retry(UUID taskId) {
        ReportTask oldTask = taskMap.get(taskId);
        // 错误：重试时新建 ReportTask 而非复用！
        ReportTask newTask = new ReportTask(oldTask.getData());
        newTask.setRetryCount(oldTask.getRetryCount() + 1);
        taskMap.put(newTask.getId(), newTask);  // 旧 task 没移除，新 task 加进去
        // taskMap 每次重试 +1 个 ReportTask，永远不减
        executor.submit(newTask);
    }
    
    public void complete(UUID taskId) {
        taskMap.remove(taskId);  // 完成 remove
    }
}
```

**根因**：
1. **重试时新建 ReportTask 而非复用**：`retry()` 方法每次新建 `ReportTask`，但旧的 task 没 `remove`
2. **taskMap 没设上限**：`ConcurrentHashMap` 当缓存用，但没设 maximumSize
3. **24h 必达导致任务长期累积**：失败的 task 会一直重试 24h，期间 taskMap 持续增长
4. **重试风暴**：高峰期 200 次/分钟 × 24h = 28.8w 次任务，重试 5 次平均 = 144w task，加上累积可达 280w

**止血方案**：

```bash
# 1. 清空 taskMap（救急）
ognl '@com.example.ReportTaskManager@taskMap.clear()'

# 2. 验证清空
ognl '@com.example.ReportTaskManager@taskMap.size()'
# 0

# 3. 重新加载待上报任务（从 DB 重新拉取）
ognl '@com.example.ReportTaskManager@reloadFromDb()'
```

**注意**：清空 taskMap 会丢失内存中"未完成的任务"，但这些任务在 DB 里都有记录（任务持久化），可以重新加载。

##### 根因修复 PR

```java
// 修复 1：重试时复用 ReportTask
@Service
public class ReportTaskManager {
    private final Map<UUID, ReportTask> taskMap = new ConcurrentHashMap<>();
    
    public void retry(UUID taskId) {
        ReportTask task = taskMap.get(taskId);
        if (task != null) {
            task.setRetryCount(task.getRetryCount() + 1);
            task.setNextRetryTime(computeNextRetry());
            // 不新建对象，复用原 task
            executor.submit(task);
        }
    }
    
    public void complete(UUID taskId) {
        taskMap.remove(taskId);
    }
}

// 修复 2：加 Caffeine 限制上限（防御性）
public class ReportTaskManager {
    private final Cache<UUID, ReportTask> taskCache = Caffeine.newBuilder()
            .maximumSize(50000)  // 上限 5w
            .expireAfterWrite(24, TimeUnit.HOURS)  // 24h 过期
            .recordStats()
            .build();
    
    public void submit(ReportData data) {
        ReportTask task = new ReportTask(data);
        taskCache.put(task.getId(), task);
        executor.submit(task);
    }
    
    public void retry(UUID taskId) {
        ReportTask task = taskCache.getIfPresent(taskId);
        if (task != null) {
            task.setRetryCount(task.getRetryCount() + 1);
            executor.submit(task);
        }
    }
}

// 修复 3：加监控上报
@Scheduled(fixedRate = 60000)
public void reportCacheSize() {
    long size = taskCache.estimatedSize();
    metrics.gauge("report.task.cache.size", size);
    if (size > 40000) {  // 80% 预警
        log.warn("ReportTask cache size > 40000, current: {}", size);
    }
}
```

##### 预防措施

**1. 全量排查所有 Map 缓存**：
```bash
# 代码库 grep
grep -rn "new ConcurrentHashMap\|new HashMap" --include="*.java" src/main/java/
# 检查每个 Map 是否设了上限或过期
```

**2. 加监控告警**：
- 缓存大小：`cache.estimatedSize()` 上报 Prometheus
- 堆使用率：> 85% 持续 1 分钟告警
- Full GC 频率：> 1 次/分钟告警

**3. Code Review Checklist 更新**：
```
□ Map 缓存是否设了上限（Caffeine maximumSize / ConcurrentHashMap size 限制）
□ Map 缓存是否有清理逻辑（remove / expireAfterWrite）
□ 重试逻辑是否复用对象（避免每次新建）
□ ThreadLocal 是否 finally remove
□ 监听器是否配对 register/unregister
```

**4. 故障演练**：每月一次注入内存泄漏，让团队练手

#### Result（结果）

**业务影响**：
- 200 条上报任务丢失，需要人工补录（已补录完成）
- 服务中断 5 分钟（OOM 重启 + 摘流量）
- 影响订单转化率 5%（监管上报失败导致部分订单不能完成）

**修复成果**：
- 止血：摘流量 + 清空 taskMap，5 分钟恢复
- 根因：retry 方法复用 ReportTask + Caffeine 上限 5w
- 预防：全量排查 23 处 Map 缓存，3 处类似问题修复

**复盘文档**：
```
## 故障复盘 - 2026-08-05 监管上报服务 OOM

### 时间线
- 14:25 - 堆使用率开始上涨
- 14:32 - OOM 重启，自动 dump 4.5GB
- 14:35 - 摘流量 + 抓现场
- 14:40 - MAT 分析：ReportTaskManager.taskMap 3.7GB
- 14:50 - 清空 taskMap 止血
- 15:00 - PR #1234 修复 retry 复用逻辑
- 15:30 - 灰度发布
- 16:00 - 全量恢复

### 根因（5 层）
1. 现象：服务 OOM 重启
2. 直接原因：堆 6GB 用满，Full GC 后 Old 不降
3. 表层根因：ReportTaskManager.taskMap 累积 280w ReportTask（3.7GB）
4. 代码根因：retry() 方法新建 ReportTask 而非复用，taskMap 只增不减
5. 流程根因：Code Review 未检查 Map 缓存配置
6. 体系根因：缺乏缓存配置规范、缺乏缓存大小监控

### 改进项
| 改进项 | 负责人 | 截止日期 | 状态 |
|--------|--------|---------|------|
| 修复 retry 复用逻辑 | 张三 | 2026-08-05 | 完成 |
| 全量排查 Map 缓存 | 李四 | 2026-08-10 | 完成（发现 3 处类似问题） |
| 加缓存大小监控告警 | 王五 | 2026-08-12 | 完成 |
| Code Review Checklist 更新 | 钱七 | 2026-08-08 | 完成 |
| 制定缓存配置规范 | 赵六 | 2026-08-15 | 进行中 |

### 经验教训
- OOM 自动 dump 配置正确，现场抓到了
- MAT 5 分钟定位元凶，工具链熟练度高
- 但根因是低级错误（重试时新建对象），说明 Code Review 流程有漏洞
```

**架构师反思**：

1. **24h 必达的代价**：业务要求 24h 必达，意味着任务长期驻留内存，必须设上限
2. **重试逻辑的内存陷阱**：重试时复用对象 vs 新建对象，是常见的内存泄漏模式
3. **Map 缓存必须有上限**：`ConcurrentHashMap` 不是缓存，要用 Caffeine
4. **监控不能只看堆使用率**：要监控缓存大小、Map size、队列长度等业务指标
5. **Code Review 是第一道防线**：Map 上限、ThreadLocal remove、监听器 unregister 必须检查

---

## 能力差距提示

作答时请对照架构师水平，重点检查以下能力：

1. **OOM 类型识别**：能不能 30 秒内从报错信息识别 OOM 类型（heap / Metaspace / Direct / Thread / Stack）？每种 OOM 的修复方向能否脱口而出？
2. **Heap Dump 方式选择**：5 种 dump 方式的差异、STW 时长、是否包含 unreachable，能不能不查文档选对方式？
3. **MAT 深度**：支配树 Dominator Tree 的算法原理（IBM paper）能不能讲清？OQL 语法能不能写对？10GB+ 大 dump 怎么处理？
4. **5 类泄漏模式**：每类模式的典型代码、识别清单、修复方案，能不能脱口而出？ThreadLocal / 监听器 / finalize 的"坑"在哪？
5. **5 分钟定位法**：6 个节奏点的关键动作、踩坑点，能不能背出来？
6. **与简历项目的结合**：在线问诊系统的 5 个 OOM 场景（IM ByteBuf / 视频 RTP / 监管上报 / 问诊订单 / MongoDB 大文档），能不能用 STAR 法则结构化讲述？
7. **架构师视角**：能不能从"OOM 排查"上升到"OOM 预防体系建设"（Code Review Checklist / 静态扫描 / 监控告警 / 故障演练）？
8. **与往周专题的衔接**：MySQL 大结果集 OOM / Redis bigKey / ES Scroll 堆积 / Sentinel 黑名单堆积 / 支付幂等表无限增长 / 医保结算大对象 Humongous，能不能讲清各自与 JVM OOM 的关系？
