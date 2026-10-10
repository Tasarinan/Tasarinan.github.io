# 架构师学习-Day04-CPU 飙高排查实战

> 日期：2026年08月06日（周四）
> 周主题：JVM 专题第 2 周 - 调优实战与生产排查
> 出题日：Day04 - CPU 飙高排查实战（5 步法 / top -Hp + jstack / async-profiler / JIT 退优化 / Safepoint）

---

## 背景

Day01 把 JVM 调优参数梳理清楚，Day02 把诊断工具链梳理清楚，Day03 进入 OOM 排查（内存维度），Day04 转到 CPU 维度。**内存和 CPU 是 JVM 故障的两个核心维度，但两者经常交织**：

- 内存泄漏引发频繁 GC，GC 线程占 CPU 70%+
- CPU 死循环引发频繁 Safepoint，间接导致 GC 时机异常
- JIT 退优化可能同时引发 CPU 飙高和 OOM（去虚化的对象分配突然增加）
- 锁竞争引发大量自旋，CPU 用户态时间飙高，同时 GC 暂停异常

Day03 解决"堆为什么涨"，Day04 解决"CPU 为什么高"。架构师面试官最爱追问的"线上 CPU 100%，你怎么 5 分钟定位到代码行"，考的就是 Day04 的内容。

**为什么 Day04 是"CPU 飙高排查实战"而不是"线程分析"**：

1. **CPU 飙高是最高频生产事故**：流量突增、死循环、GC 频繁、JIT 抖动都会引发 CPU 飙高，是 SRE 告警最多的 JVM 问题
2. **5 步法是面试"现场题"核心**：面试官常说"我给你一个 CPU 100% 的 PID，你怎么定位到代码行"--考的就是 `top -Hp + printf %x + jstack` 的熟练度
3. **火焰图是架构师分水岭**：能看懂火焰图的工程师不多，能从火焰图反推优化方向的更是少数
4. **JIT 退优化和 Safepoint 是高阶盲区**：80% 的工程师不知道 JIT 退优化会引发 CPU 飙高，90% 的工程师不知道 jstack 会触发 Safepoint

**与 Day01 / Day02 / Day03 的衔接点**：

- Day01 讲了 `-XX:+PrintCompilation`，Day04 讲怎么用它诊断 JIT 退优化
- Day01 讲了 `-XX:+SafepointTimeout` / `-XX:+PrintSafepointStatistics`，Day04 讲怎么用它诊断 Safepoint 同步慢
- Day02 讲了 `top -Hp + jstack` 5 步法、Arthas `thread -n 3`、async-profiler 火焰图，Day04 把这些工具组合成完整的排查链路
- Day02 讲了 `jstack -F` 会挂起进程，Day04 讲为什么会挂起（触发 Safepoint 且 sync time 长）
- Day03 讲了 OOM 排查（内存维度），Day04 讲 CPU 维度，两者经常交织（GC 频繁 = 内存问题 + CPU 问题）

**与往周专题的衔接点**：

- **6月第1周 MySQL**：MySQL 慢查询引发 DB CPU 高 vs JVM 业务 CPU 高--MySQL CPU 高看 `SHOW PROCESSLIST` + `EXPLAIN`，JVM CPU 高看 `top -Hp + jstack`，但慢查询会阻塞业务线程引发 JVM 线程池耗尽，需要联动排查
- **6月第2周 Redis**：Redis 单线程 CPU 100%（`SLOWLOG` / `INFO clients`）vs JVM 多线程 CPU 高--Redis 是单核打满，JVM 是多核分散，排查工具链完全不同
- **6月第3周 ES**：ES 聚合 CPU 高（`_cat/thread_pool` + `hot_threads`）vs JVM CPU 高--ES 内部也是 JVM，但 ES 提供 `hot_threads` API 直接定位热点线程
- **6月第4周 限流降级**：Sentinel 限流检查本身占 CPU（滑动窗口统计）vs JVM 业务 CPU--Sentinel LeapArray 在高 QPS 下 CPU 占用 5-10%，需要区分
- **6月第5周 支付**：支付对账 CPU 飙高（大数据量计算）--典型业务 CPU 高，需要在火焰图上看对账算法热点
- **7月第1周 医疗**：医保结算批量计算 CPU 飙高--3 万条规则匹配 + IC10 编码查询，CPU 密集型
- **7月第4周简历项目**：在线问诊系统 5 个 CPU 飙高场景（IM 网关 / 视频 RTP / 监管上报 / 问诊订单 / MongoDB 大文档）
- **7月第5周 JVM 第1周**：Day07 G1 GC 线程 CPU 占用（GC 线程占 50%+ CPU）、Day05 JIT 编译 CPU（启动期 CompileThread 占 30% CPU）

**与简历项目的衔接点**：

在线问诊系统的 CPU 飙高实战重灾区：

1. **IM 网关 10w+ 长连接 CPU 飙高**：ByteBuf 泄漏，Netty 检测泄漏循环清理，CPU 95%，10w 连接开始断开
2. **视频问诊 RTP 包堆积 Full GC**：RTPQueue 通话结束未 clear，GC 频繁 CPU 高，视频卡顿
3. **监管上报 24h 必达 OOM**：上报失败重试时每次新建 ReportTask 而非复用，Map 无限增长，GC 频繁 CPU 高
4. **问诊订单缓存 100w Key**：Caffeine maximumSize 设了 100w（应该 1w），GC CPU 高
5. **MongoDB 大文档 G1 Humongous**：5MB 文档超过 G1 Region 大小 50%，GC CPU 高

Day05 落到在线问诊系统 JVM 调优案例，Day06 串联故障复盘，Day07 深挖 ZGC。

---

## 题目一（CPU 飙高全解题）：CPU 飙高排查实战

请详细回答以下问题：

1. **CPU 飙高的 6 种类型分类**：业务 CPU 高（单接口 RT 高、jstack 显示业务方法）/ GC CPU 高（GC 频繁、jstack 显示 GC 线程）/ JIT 编译 CPU 高（启动后 5 分钟内、CompileThread）/ 锁竞争 CPU 高（多线程 BLOCKED、自旋）/ 死循环 CPU 高（单线程 100%、jstack 显示同一行）/ Native CPU 高（jstack 看不出业务栈、JNI / 本地库）--每种类型的特征、工具链、修复方向、生产案例？为什么"先分类再排查"比"无脑 jstack"快 3 倍？
2. **5 步定位法 - top -Hp + jstack 完整流程**：从 `top` 找 Java 进程，到 `top -Hp PID` 找高 CPU 线程，到 `printf "%x\n" TID` 转 16 进制，到 `jstack -l PID | grep -A 30 nid=0xHEX` 过滤栈，到分析栈帧定位代码--每一步的输出怎么解读？K8s 容器内有哪些坑（top 不显示线程 / `/proc/PID/task` 替代 / 容器 PID 与宿主机 PID 不一致 / `kubectl top pod` vs `kubectl exec top`）？jstack 抓到的栈"恰好不在热点"怎么办（多次抓 / async-profiler 替代）？
3. **async-profiler 火焰图实战**：4 种模式（cpu / alloc / lock / wall）的区别与适用场景？cpu 模式基于 `perf_events + AsyncGetCallTrace` 的原理？alloc 模式采样内存分配的机制（每 N 字节采样一次）？lock 模式采样锁竞争（`Unsafe.park` / `synchronized` wait）？wall 模式与 cpu 模式的本质区别（含 IO 等待 vs 仅 CPU 时间）？火焰图横向纵向代表什么，"宽且尖"vs"宽且平"vs"窄且高"分别意味着什么？Arthas `profiler` 与原生 async-profiler 的关系（Arthas 集成 async-profiler，命令包装）？
4. **JIT 退优化（Deoptimization）引发 CPU 飙高**：JIT 编译层次（解释执行 -> C1 -> C2）？分层编译（Tiered Compilation）的 4 个 Tier（Tier 1-4）？退优化的 2 种类型（unstable if 分支预测失效 / not entrant 类加载使假设失效）？退优化触发条件（异常分支 / profile 不匹配 / 新类加载使 inline 假设失效 / "uncommon trap"）？现象（接口偶发慢、`-XX:+PrintCompilation` 显示 deopt、`-XX:+UnlockDiagnosticVMOptions -XX:+PrintInlining` 看到_inline failure）？排查方法（JFR + PrintCompilation + 看代码分支）？案例：在线问诊系统 IM 网关偶发 CPU 飙高（profile 失效导致 uncommon trap 风暴）？
5. **Safepoint 引发延迟与 CPU 飙高**：Safepoint 概念（JVM 全局安全点，所有线程阻塞进入）？进入 Safepoint 的场景（GC / 偏向锁撤销 / delegate disabled / stack watermark / jstack 等诊断操作）？**SafePoint Bias**（基于时间的 Safepoint 会让"长循环"进入慢，JDK 11+ JEP 312 解决）？`jstack` / `jcmd Thread.print` 会触发 Safepoint 的原因（需要遍历所有线程栈）？**safepoint time vs sync time**（进入 safepoint 的同步时间，sync time 长说明有线程阻挡 safepoint）？排查方法（`-XX:+PrintSafepointStatistics` + `-XX:+SafepointTimeout` + `-XX:SafepointTimeoutDelay=1000`）？案例：IM 网关 10w 长连接 jstack 引发 5 秒 STW？

### 作答区

#### 1. CPU 飙高的 6 种类型分类

**架构师视角的 CPU 飙高分类**：

很多工程师一遇到 CPU 高就 `jstack`，抓到的栈不一定能定位根因。**架构师视角是先分类，再排查**：先用 30 秒区分是哪一类 CPU 高，再用对应的工具链深挖，效率提升 3 倍以上。

| 类型 | 特征 | jstack 表现 | 工具链 | 修复方向 | 生产案例 |
|------|------|------------|--------|---------|---------|
| **业务 CPU 高** | 单接口 RT 高、QPS 涨 | 业务方法栈顶 | top -Hp + jstack + async-profiler | 优化算法 / 加缓存 / 异步化 | 医保结算 3 万规则匹配 |
| **GC CPU 高** | GC 频繁、堆高 | GC 线程栈顶（G1 RefineThread / GC Thread） | jstat + GC 日志 + MAT | 修内存泄漏 / 调 GC 参数 | 问诊订单缓存 100w Key |
| **JIT 编译 CPU 高** | 启动后 5 分钟内、接口偶发慢 | CompileThread / C2 CompilerThread | jstack + `-XX:+PrintCompilation` | 预热 / AppCDS / AOT | IM 网关冷启动 5 分钟抖动 |
| **锁竞争 CPU 高** | 多线程 BLOCKED、自旋等待 | 大量线程 BLOCKED 在同一锁 | jstack + Arthas thread -b | 减小锁粒度 / 改并发结构 | 秒杀库存 RowLock |
| **死循环 CPU 高** | 单线程 100% CPU、持续高 | 多次 jstack 同一行 | top -Hp + jstack（连续 3 次） | 修死循环 bug | while(true) 无退出条件 |
| **Native CPU 高** | jstack 看不出业务栈 | 栈顶是 native 方法 / JNI | async-profiler + perf + strace | 排查 JNI / 本地库 / zlib | ES Lucene FST 构建 |

**为什么"先分类再排查"比"无脑 jstack"快 3 倍**：

```
无脑 jstack 路径（10 分钟）：
  jstack -> 看到栈 -> 不知道是 GC 还是业务 -> 再 jstack -> 抓到的栈变了
  -> 怀疑是 JIT -> 翻 -XX:+PrintCompilation -> 又发现是 GC -> 重新看 GC 日志

分类路径（3 分钟）：
  第 1 步（30 秒）：top -Hp 看高 CPU 线程名
    ├─ "GC Thread" / "G1 RefineThread" -> GC CPU 高 -> 走 GC 排查链
    ├─ "C2 CompilerThread" -> JIT CPU 高 -> 走 JIT 排查链
    ├─ "http-nio-8080-exec-*" -> 业务 CPU 高 -> 走业务排查链
    ├─ 多个线程都 BLOCKED -> 锁竞争 -> 走锁排查链
    └─ 单线程 100% -> 死循环 / 业务 CPU 高 -> 多次 jstack 确认
  
  第 2 步（30 秒）：jstat -gcutil 看堆和 GC 频率
    ├─ O 列 > 85% 且 FGC 涨 -> 内存问题，GC CPU 是表象
    └─ O 列正常且 FGC 不涨 -> 纯 CPU 问题，与内存无关
  
  第 3 步（2 分钟）：针对性深挖
    ├─ 业务 -> async-profiler 火焰图
    ├─ GC -> jmap dump + MAT
    ├─ JIT -> PrintCompilation + JFR
    ├─ 锁 -> Arthas thread -b
    └─ 死循环 -> 多次 jstack 对比
```

**业务 CPU 高的典型场景**：

1. **算法复杂度高**：O(n²) 循环、深递归、字符串拼接（`+=` 在循环里）
2. **序列化 / 反序列化**：JSON 序列化大对象、Java 原生序列化（比 JSON 还慢 5 倍）
3. **正则表达式**：贪婪匹配 + 大输入，回溯爆炸
4. **加密 / 哈希**：BCrypt / PBKDF2 故意慢，但调用频率高就成热点
5. **批量计算**：医保结算 3 万规则匹配、支付对账大数据量

**生产案例 - 医保结算 3 万规则匹配**：

```
现象：医保结算接口 CPU 持续 85%，单次结算 RT 800ms
排查：
  1. top -Hp 找到 CPU 90% 线程，是 http-nio-8080-exec-12
  2. jstack 抓栈，栈顶是 RuleEngine.match（业务方法）
  3. async-profiler 火焰图，RuleEngine.match 占 70% CPU
  4. 火焰图细分：3 万规则逐条匹配，O(n) 遍历
根因：医保规则匹配用 List 遍历，3 万规则每条都遍历
修复：
  1. 把规则按 ICD10 编码建索引（Map<ICD10, List<Rule>>）
  2. 匹配时按编码查索引，从 3 万次降到 5-10 次
  3. RT 从 800ms 降到 50ms，CPU 从 85% 降到 20%
```

**GC CPU 高的典型场景**：

1. **Young GC 频繁**：Eden 太小、分配速率过高（> 2GB/s）
2. **Mixed GC 慢**：Old Region 多、存活率高
3. **Full GC 失败**：to-space exhausted、Concurrent Mode Failure
4. **Metaspace 满**：动态生成类（CGLIB / Groovy）
5. **Humongous Allocation**：大对象 > Region/2

**生产案例 - 问诊订单缓存 100w Key**：

```
现象：问诊订单服务 CPU 持续 80%，堆 92%，Full GC 1次/分钟
排查：
  1. top -Hp 找到 CPU 70% 线程，是 "G1 Main Marker" / "GC Thread"
  2. jstat -gcutil PID 1000：O 列 88%、FGC 涨 1次/秒
  3. GC CPU 高 + 堆高 -> 内存问题
  4. jmap dump + MAT，发现 OrderEntity 100w 个占 4.2GB
  5. Arthas vmtool 查 Caffeine，estimatedSize = 100w
根因：Caffeine maximumSize 配置错误（设了 100w，应该 1w）
修复：maximumSize 改 10000，加 expireAfterWrite=10min，CPU 立即降到 15%
```

**JIT 编译 CPU 高的典型场景**：

1. **启动期编译风暴**：刚启动时大量方法首次触发 C1/C2 编译
2. **预热不充分**：流量进来时还在编译，C2 没生效
3. **JIT 退优化风暴**：profile 失效导致大量方法同时退优化，重新编译

**生产案例 - IM 网关冷启动 5 分钟抖动**：

```
现象：IM 网关发布后 5 分钟内 P99 飙到 2s，CPU 持续 70%
排查：
  1. top -Hp 找到 CPU 30% 线程，是 "C2 CompilerThread"
  2. jstack 抓栈，栈顶是 C2 编译方法
  3. -XX:+PrintCompilation 看到大量 "made not entrant" + 重新编译
根因：启动期 profile 不稳定，C2 反复退优化重编译
修复：
  1. 加预热脚本：发布后先跑 1 分钟压测再放流量
  2. 开启 AppCDS：减少类加载开销
  3. 关键路径方法用 -XX:CompileThreshold=1000 提前触发编译
```

**锁竞争 CPU 高的典型场景**：

1. **synchronized 大锁**：单个 synchronized 方法承担高 QPS
2. **ReentrantLock 公平锁**：公平锁比非公平锁慢 10 倍
3. **数据库行锁**：MySQL InnoDB RowLock 等待
4. **连接池耗尽**：HikariCP 满负载，业务线程 BLOCKED 等连接
5. **锁自旋**：JVM 自适应自旋锁在激烈竞争时 CPU 高

**生产案例 - 秒杀库存 RowLock**：

```
现象：秒杀接口 CPU 60%，但 P99 飙到 5s
排查：
  1. top -Hp 找不到 100% 线程，多个线程都是 30%
  2. jstack 抓栈，500 个业务线程都 BLOCKED 在同一行
     at com.example.StockService.deduct(StockService.java:45)
     - waiting to lock <0x...> (a java.lang.Object)
  3. Arthas thread -b 找到罪魁：thread-12 持有锁 5s
根因：synchronized 大锁保护 stock 扣减，单点串行
修复：
  1. 改成分段锁：100 个 stock 分 100 段，每段独立锁
  2. 改成 Redis Lua 原子扣减：DB 异步对账
  3. P99 从 5s 降到 80ms，CPU 从 60% 降到 30%
```

**死循环 CPU 高的典型场景**：

1. **while(true) 无退出**：状态判断字段写错（如 flag 用错变量）
2. **for 循环边界错**：`for (int i = 0; i < list.size(); i--)`
3. **递归无终止**：终止条件写错
4. **集合遍历 ConcurrentModificationException 后重试**：异常被吞，循环重试
5. **Future.get 无超时**：循环里 future.get() 死等

**生产案例 - IM 网关消息分发死循环**：

```
现象：IM 网关 CPU 100%，单线程持续打满
排查：
  1. top -Hp 找到 CPU 100% 线程 nid=0x3065
  2. jstack 抓栈，栈顶是 ImDispatcher.dispatch
  3. 等 5 秒再 jstack，栈顶还是 ImDispatcher.dispatch 同一行
  4. 第三次 jstack，仍然同一行 -> 死循环确认
根因：消息分发循环条件 status == SENT 写成 status != SENT，永远为 true
修复：改条件判断，加超时退出
```

**Native CPU 高的典型场景**：

1. **JNI 本地库**：自己写的 C/C++ 库
2. **zlib / gzip 压缩**：大流量压缩，CPU 在 native zlib
3. **加密库**：OpenSSL / BoringSSL native 调用
4. **Netty Epoll**：Netty native epoll transport
5. **Lucene FST 构建**：ES 倒排索引构建
6. **JNI 字符串拷贝**：GetStringUTFChars 大字符串

**生产案例 - ES Lucene FST 构建引发 Native CPU 高**：

```
现象：ES 节点 CPU 90%，但 jstack 看不出业务栈
排查：
  1. top -Hp 找到 CPU 90% 线程
  2. jstack 抓栈，栈顶是 java.lang.Thread.yield（Native 方法）
     实际栈被 native 调用吃掉，看不到业务方法
  3. async-profiler 火焰图（cpu 模式），看到 org.apache.lucene.util.fst.FST
  4. perf top 看到 libc.so 占 60% CPU
根因：ES 新建索引时构建 FST（Finite State Transducer），native 内存操作 CPU 高
修复：
  1. 索引预构建：避免高峰期建索引
  2. 增大 ES 节点内存，减少 FST 重建频率
```

**6 种类型的快速判断流程**：

```
CPU 飙高
  │
  ▼
top -Hp PID（30 秒）
  │
  ├─ GC Thread / G1 RefineThread 占 50%+ -> GC CPU 高
  │   └─ jstat -gcutil 确认 + 走内存排查链
  │
  ├─ C2 CompilerThread 占 30%+ -> JIT CPU 高
  │   └─ 启动期 vs 运行期？运行期 JIT 高 = 退优化风暴
  │
  ├─ 多个业务线程都 30%+ -> 锁竞争 / 业务 CPU 高
  │   ├─ jstack 看是否大量 BLOCKED -> 锁竞争
  │   └─ jstack 都是 RUNNABLE 在不同方法 -> 业务 CPU 高
  │
  ├─ 单线程 100% -> 死循环 / 业务 CPU 高
  │   └─ 多次 jstack 看是否同一行 -> 死循环
  │
  └─ 线程名不明 / 栈看不出业务 -> Native CPU 高
      └─ async-profiler + perf top
```

**生产实战经验**：

1. **线程名是第一线索**：好的工程习惯是给线程池起名字（`ThreadFactoryBuilder.setNameFormat`），jstack 一眼看出业务
2. **GC CPU 高的根因往往是内存**：调 GC 参数治标不治本，必须找到内存元凶
3. **JIT CPU 高在 JDK 11+ 减少**：AppCDS + AOT 编译可以预热
4. **死循环看 jstack 必须连续抓 3 次**：单次抓到的栈可能恰好不是死循环那行
5. **Native CPU 高用 async-profiler**：jstack 看不出 native 栈，必须用 async-profiler 或 perf

#### 2. 5 步定位法 - top -Hp + jstack 完整流程

**5 步法完整命令链**：

```bash
# 第 1 步：找到 CPU 高的 Java 进程
top -c
# 或者
jps -lvm
# 输出：
#   PID USER      PR  NI    VIRT    RES    SHR S  %CPU %MEM     TIME+ COMMAND
#  12345 app       20   0  4.5g   2.3g  50m  R  95.3  3.5   1:23.4 java -jar im-gateway.jar
#  23456 app       20   0  3.2g   1.8g  40m  R  10.5  2.7   0:23.5 java -jar consult.jar

# 第 2 步：找到 CPU 高的线程（top -H 显示线程级 CPU）
top -Hp 12345
# 输出：
#   PID    USER  PR  NI    VIRT    RES    SHR S %CPU %MEM    TIME+ COMMAND
#  12389    app  20   0  4.5g   2.3g  50m  R 95.3  3.5   1:23.4 java
#  12390    app  20   0  4.5g   2.3g  50m  R 23.1  3.5   0:15.6 java
#  12391    app  20   0  4.5g   2.3g  50m  S  5.2  3.5   0:03.2 java

# 第 3 步：把线程 PID 转成 16 进制（jstack 中 nid 是 16 进制）
printf "%x\n" 12389
# 输出：3065

# 第 4 步：jstack 抓栈并过滤
jstack -l 12345 > /tmp/jstack.log
grep -A 30 "nid=0x3065" /tmp/jstack.log

# 第 5 步：看栈顶方法定位代码
# "NettyClientHandler-1" #50 prio=5 os_prio=0 tid=0x... nid=0x3065 runnable
#    java.lang.Thread.State: RUNNABLE
#        at com.example.HeavyComputeService.calculate(HeavyComputeService.java:45)
#        at com.example.ImGatewayHandler.handleMessage(ImGatewayHandler.java:78)
```

**每一步的输出怎么解读**：

**第 1 步输出解读**：

| 列 | 含义 | 关注点 |
|---|------|--------|
| `PID` | 进程 ID | 后续所有命令的入参 |
| `VIRT` | 虚拟内存 | JVM 申请的虚拟内存（通常 4-12GB） |
| `RES` | 物理内存 | 实际占用的物理内存（应小于 Pod limit） |
| `%CPU` | CPU 占用率 | 高于单核 100% = 多线程，比如 350% = 3.5 核 |
| `%MEM` | 内存占用率 | 接近 100% 要小心 OOM Kill |
| `TIME+` | 累计 CPU 时间 | 进程启动以来总 CPU 时间 |

**关键认知**：
- Linux `%CPU` 可以超过 100%（多核累加），400% = 4 核满载
- `top` 默认按 CPU 排序，按 `M` 切换为按内存排序
- `top -c` 显示完整命令行，便于识别 Java 进程

**第 2 步输出解读**：

`top -H` 的 `-H` 表示按线程显示（H = Threads），关键点：

| 列 | 含义 | 关注点 |
|---|------|--------|
| `PID` | 线程 ID（OS 层的 gettid()） | 后续转 16 进制 |
| `%CPU` | 线程 CPU 占用 | 单线程 100% = 单核满载 |
| `S` | 状态（R=运行 / S=睡眠 / D=不可中断睡眠） | R 持续 = CPU 密集 |

**线程名识别（jstack 中 nid 与 top -Hp 的 PID 对应）**：

但是！`top -Hp` 不显示线程名，怎么知道是 GC 线程还是业务线程？两种方法：

```bash
# 方法 1：jstack 后看 nid 对应的线程名
jstack 12345 | grep -B 1 "nid=0x3065"
# "NettyClientHandler-1" #50 prio=5 os_prio=0 tid=0x... nid=0x3065 runnable

# 方法 2：从 /proc/PID/task 直接看线程名
ls /proc/12345/task/
# 12389  12390  12391  ...
cat /proc/12345/task/12389/comm
# NettyClientHa  <- 线程名（截断到 15 字符）
```

**线程名速查表**：

| 线程名前缀 | 含义 | CPU 高意味着 |
|-----------|------|------------|
| `main` | 主线程 | 启动期问题 |
| `GC Thread` / `G1 RefineThread` / `G1 Main Marker` | GC 线程 | 内存问题，GC 频繁 |
| `C2 CompilerThread` / `C1 CompilerThread` | JIT 编译线程 | 启动期编译 / 退优化风暴 |
| `VM Thread` | JVM 内部线程（GC 等） | GC STW 时间长 |
| `http-nio-8080-exec-*` | Tomcat 业务线程 | 业务 CPU 高 |
| `DubboServerHandler-*` | Dubbo 业务线程 | RPC 业务 CPU 高 |
| `NettyClientHandler-*` / `nioEventLoopGroup-*` | Netty I/O 线程 | 网络或 ByteBuf 处理问题 |
| `DefaultDispatcher-worker-*` | Kotlin 协程 | 协程业务 CPU 高 |
| `pool-N-thread-*` | 通用线程池 | 看具体业务（无 setName 时无法区分） |

**第 3 步：10 进制转 16 进制**：

```bash
# 方法 1：printf（最常用）
printf "%x\n" 12389
# 3065

# 方法 2：bc
echo "obase=16; 12389" | bc
# 3065

# 方法 3：bash 算术
printf "0x%x\n" 12389
# 0x3065

# 一行命令搞定（top -Hp + printf + jstack）
TID=$(top -b -n 1 -H -p 12345 | awk 'NR>7 {print $1, $9}' | sort -k2 -rn | head -1 | awk '{print $1}')
HEX_TID=$(printf "%x\n" $TID)
jstack -l 12345 | grep -A 30 "nid=0x$HEX_TID"
```

**第 4 步：jstack 输出格式解读**：

```
"NettyClientHandler-1" #50 prio=5 os_prio=0 tid=0x7f8e5c3b4000 nid=0x3065 runnable [0x7f8e4c0a9000]
   java.lang.Thread.State: RUNNABLE
        at com.example.HeavyComputeService.calculate(HeavyComputeService.java:45)
        at com.example.ImGatewayHandler.handleMessage(ImGatewayHandler.java:78)
        at io.netty.channel.AbstractChannelHandlerContext.invokeChannelRead(AbstractChannelHandlerContext.java:379)
```

| 字段 | 含义 |
|------|------|
| `"NettyClientHandler-1"` | 线程名（Thread.setName） |
| `#50` | 线程编号（JVM 内部计数） |
| `prio=5` | Java 优先级（1-10，默认 5） |
| `os_prio=0` | OS 优先级（nice 值） |
| `tid=0x7f8e5c3b4000` | JVM 内部线程对象地址 |
| `nid=0x3065` | **Native 线程 ID（OS 的 gettid()，16 进制）** |
| `runnable` | 状态（runnable / blocked on monitor / waiting on condition） |
| `[0x7f8e4c0a9000]` | 栈底内存地址 |
| `java.lang.Thread.State: RUNNABLE` | Java 线程状态 |

**关键认知**：`nid` 是 16 进制，`top -Hp` 的 PID 是 10 进制，两者要转换。

**第 5 步：栈帧分析**：

栈帧从上到下 = 从当前方法到调用起点。**栈顶（第一行）= 当前正在执行的方法**。

```java
// 栈顶
at com.example.HeavyComputeService.calculate(HeavyComputeService.java:45)
// 调用 calculate 的方法
at com.example.ImGatewayHandler.handleMessage(ImGatewayHandler.java:78)
// 调用 handleMessage 的方法
at io.netty.channel.AbstractChannelHandlerContext.invokeChannelRead(...)
```

**判断逻辑**：
- 多次 jstack 都在同一行 -> **死循环**
- 多次 jstack 在同一方法（不同行） -> **方法耗时高**
- 栈顶是 native 方法 -> 看 Native CPU 排查
- 栈顶是 GC / JIT 线程 -> 不是业务问题

**K8s 容器内的坑**：

**坑 1：top -Hp 在容器内不显示线程**

某些 K8s 配置下，容器内 `top -H` 不显示线程：

```bash
# 解决方法 1：用 /proc/PID/task 替代
ls /proc/12345/task/
# 12389  12390  12391  ...

# 看每个线程的 CPU（top 不能直接用，需要从 /proc 读）
for tid in $(ls /proc/12345/task/); do
  cpu=$(awk '{print $14+$15}' /proc/12345/task/$tid/stat 2>/dev/null)
  echo "$cpu $tid"
done | sort -rn | head -5

# 解决方法 2：kubectl exec 进容器，启动时加 --pid=host
kubectl exec -it pod -- sh -c "top -H -p $(pgrep java)"
```

**坑 2：容器 PID 与宿主机 PID 不一致**

容器内 PID 1 在宿主机可能是 PID 12345：

```bash
# 容器内看到的 PID
jps
# 1 com.example.ImGatewayApplication  <- 容器内 PID 是 1

# 宿主机看到的 PID
kubectl get pod -o yaml | grep pid
# 宿主机 PID 是 12345

# jstack 用容器内 PID 即可
kubectl exec -it pod -- jstack -l 1
```

**坑 3：kubectl top pod vs kubectl exec top 不一致**

```bash
# kubectl top 显示的是 Pod 维度（含 sidecar）
kubectl top pod im-gateway-xxx
# NAME           CPU(cores)   MEMORY(bytes)
# im-gateway     950m         2.3Gi

# 进容器内 top 看的是业务容器（不含 sidecar）
kubectl exec -it pod -- top -b -n 1
#  PID  CPU%  ...
#  1    95%   java   <- 业务容器

# 如果有 sidecar（如 Envoy），kubectl top 是两者之和
```

**坑 4：容器内 jstack 权限问题**

```bash
# JVM 启动用户是 app，但 kubectl exec 默认是 root
# jstack 可能因为 hsperfdata 文件权限失败
jstack -l 1
# Operation not permitted

# 解决方法 1：切到 app 用户
kubectl exec -it pod -- su app -c "jstack -l 1"

# 解决方法 2：用 jcmd
kubectl exec -it pod -- jcmd 1 Thread.print -l

# 解决方法 3：开共享 PID namespace（sidecar 模式）
# K8s 1.12+ shareProcessNamespace: true
```

**坑 5：容器内找不到 jstack / jcmd**

```bash
# 一些精简镜像（如 alpine + JRE）没有 jstack
kubectl exec -it pod -- jstack
# Error: jstack not found

# 解决方法 1：用 JDK 镜像（含 JDK 工具）
# 解决方法 2：用 kill -3 SIGQUIT
kubectl exec -it pod -- kill -3 1
# JVM 把栈打到 stdout（需要在启动脚本重定向 stdout 到文件）

# 解决方法 3：用 Arthas sidecar（推荐，生产标配）
```

**jstack 抓到的栈"恰好不在热点"怎么办**：

jstack 是**瞬时快照**，可能在抓的瞬间线程恰好不在热点方法。解决方法：

```bash
# 方法 1：连续抓 3 次（间隔 1-2 秒）
for i in 1 2 3; do
  jstack -l 12345 > /tmp/jstack_$i.log
  sleep 2
done

# 对比 3 次的栈，看哪些方法持续出现
grep -A 30 "nid=0x3065" /tmp/jstack_*.log

# 方法 2：用 Arthas thread -n 5（按 5 秒 CPU 增量排序）
arthas -> thread -n 5
# 输出按 5 秒内 CPU 增量排序，比单次 jstack 更准

# 方法 3：用 async-profiler 采样 30 秒（统计意义大）
./profiler.sh -d 30 -f /tmp/cpu.html 12345
```

**5 步法的完整一键脚本**：

```bash
#!/bin/bash
# cpu_hotspot.sh - 一键定位 CPU 高的代码
PID=$1
[ -z "$PID" ] && echo "Usage: $0 <pid>" && exit 1

echo "=== Step 1: 进程 CPU Top ==="
top -b -n 1 -p $PID | tail -5

echo "=== Step 2: 线程 CPU Top 5 ==="
TOP5=$(top -b -n 1 -H -p $PID | awk 'NR>7 {print $1, $9, $12}' | sort -k2 -rn | head -5)
echo "$TOP5"

echo "=== Step 3-5: 抓栈定位 ==="
jstack -l $PID > /tmp/jstack_$(date +%s).log
JSTACK_FILE=$(ls -t /tmp/jstack_*.log | head -1)

echo "$TOP5" | while read TID CPU NAME; do
  HEX=$(printf "%x\n" $TID)
  echo "--- TID=$TID (nid=0x$HEX) CPU=${CPU}% ---"
  grep -A 15 "nid=0x$HEX" $JSTACK_FILE | head -20
done
```

**生产实战经验**：

1. **5 步法的第一步是 `top -c` 而不是 `top`**：`-c` 显示完整命令行，避免进程名截断
2. **`top -Hp` 必须 `top -H -p PID`**：参数顺序不能错（`-Hp` 是连写）
3. **`printf "%x\n"` 而不是 `printf "%X\n"`**：jstack 的 nid 是小写 16 进制
4. **jstack 至少抓 3 次**：单次快照可能误判
5. **栈顶是 native 方法时**：用 async-profiler 替代 jstack

#### 3. async-profiler 火焰图实战

**async-profiler 4 种模式对比**：

| 模式 | 事件 | 适合场景 | 注意 |
|------|------|---------|------|
| `cpu`（默认） | CPU 周期（基于 `perf_events`） | CPU 密集型应用找热点 | 看不出等待 IO 的时间 |
| `alloc` | 内存分配（每 N 字节采样一次） | 找分配压力大的方法 | 配合 GC 调优 |
| `lock` | 锁竞争（`Unsafe.park` / `synchronized` wait） | 锁分析 | 找锁持有者与等待者 |
| `wall` | 挂钟时间（含 IO 等待） | IO 密集、慢接口 | 包含等待时间，火焰图更"宽" |

**cpu 模式原理**：

async-profiler 的 cpu 模式基于两个机制：

1. **Linux `perf_events`**：内核采样 CPU 性能计数器（如 CPU 周期、cache miss），定时触发中断
2. **JVM `AsyncGetCallTrace`**：JVM 内部 API，在 perf_events 中断时获取当前线程的 Java 调用栈

```
perf_events 中断（每 10ms）
   │
   ▼
触发 AsyncGetCallTrace（JVM 内部 API）
   │
   ▼
获取当前线程的 Java 调用栈
   │
   ▼
写入采样数据（栈 + 计数）
```

**为什么 async-profiler 比 jstack 好**：
- **开销低**：&lt; 1%（基于采样，非插桩）
- **统计意义大**：30 秒采样 = 3000 次栈，比单次 jstack 准
- **能看 native 栈**：jstack 看不到的 JNI / 本地库栈，async-profiler 能看到
- **生成火焰图**：jstack 还要手动整理，async-profiler 直接出 HTML

**alloc 模式原理**：

```
JVM 每分配 N 字节内存（默认 N = 1024 * 1024 = 1MB）
   │
   ▼
触发采样（记录当前线程的栈）
   │
   ▼
统计每个方法的分配量
```

**调节采样频率**：

```bash
# 默认每 1MB 采样一次
./profiler.sh -d 60 -e alloc -f /tmp/alloc.html PID

# 改为每 512KB 采样一次（更精细，开销略增）
./profiler.sh -d 60 -e alloc --alloc 512k -f /tmp/alloc.html PID

# 改为每 100KB 采样一次（极致精细，生产慎用）
./profiler.sh -d 60 -e alloc --alloc 100k -f /tmp/alloc.html PID
```

**适用场景**：
- 找分配压力大的方法（Minor GC 频繁时定位元凶）
- 配合 GC 调优：找出"分配大头"
- 找临时对象（短生命周期对象的分配热路径）

**lock 模式原理**：

```
JVM 锁竞争（synchronized 进入 / ReentrantLock.lock / Unsafe.park）
   │
   ▼
触发采样（记录锁的等待者与持有者）
   │
   ▼
统计每个锁的等待时间
```

**适用场景**：
- 锁竞争分析（找阻塞其他线程的"罪魁"锁）
- 找锁持有者（哪个方法持有锁最久）
- 找锁等待者（哪些方法在等锁）

**wall 模式原理**：

```
定时采样（默认 10ms）
   │
   ▼
不管线程是否在用 CPU，都记录栈
   │
   ▼
统计每个方法的墙上时间（含 IO 等待 / 锁等待）
```

**wall vs cpu 的本质区别**：

| 维度 | cpu 模式 | wall 模式 |
|------|---------|---------|
| 采样对象 | 仅 RUNNABLE 线程 | 所有线程（含 WAITING / BLOCKED） |
| 包含 IO 等待 | 否 | 是 |
| 包含锁等待 | 否 | 是 |
| 适合场景 | CPU 密集型 | IO 密集 / 慢接口 |
| 火焰图宽度 | CPU 时间 | 总时间（含等待） |

**典型场景**：
- 接口慢但 CPU 不高 -> wall 模式（看时间花在哪）
- CPU 高 -> cpu 模式（找 CPU 大头）
- 频繁 GC -> alloc 模式（找分配大头）
- 大量 BLOCKED -> lock 模式（找锁大头）

**完整生成命令**：

```bash
# 1. 下载安装 async-profiler
wget https://github.com/async-profiler/async-profiler/releases/download/v3.0/async-profiler-3.0-linux-x64.tar.gz
tar -xzf async-profiler-3.0-linux-x64.tar.gz
cd async-profiler-3.0-linux-x64

# 2. CPU 火焰图（最常用）
./profiler.sh -d 60 -f /tmp/cpu.html <PID>
# -d 60：采样 60 秒
# -f /tmp/cpu.html：输出 HTML 火焰图

# 3. 内存分配火焰图
./profiler.sh -d 60 -e alloc -f /tmp/alloc.html <PID>

# 4. 锁采样
./profiler.sh -d 60 -e lock -f /tmp/lock.html <PID>

# 5. Wall clock 模式
./profiler.sh -d 60 -e wall -f /tmp/wall.html <PID>

# 6. 多事件同时采样（JDK 11+）
./profiler.sh -d 60 -e cpu,alloc,lock -f /tmp/multi.html <PID>

# 7. 指定采样频率（默认 10ms）
./profiler.sh -d 60 -i 5ms -f /tmp/cpu.html <PID>
# -i 5ms：每 5ms 采样一次（更精细，开销略增）

# 8. 包含 native 栈
./profiler.sh -d 60 --include-native -f /tmp/cpu.html <PID>

# 9. 包含 JVM 内部栈
./profiler.sh -d 60 --include-jvm -f /tmp/cpu.html <PID>
```

**Arthas profiler 命令**：

Arthas 集成了 async-profiler，命令包装更友好：

```bash
# 启动 CPU 火焰图采样
profiler start
# 等待 60 秒
profiler stop --format html --file /tmp/cpu.html

# 内存分配火焰图
profiler start --event alloc
profiler stop --file /tmp/alloc.html

# 锁采样
profiler start --event lock
profiler stop --file /tmp/lock.html

# wall 模式
profiler start --event wall
profiler stop --file /tmp/wall.html

# 查看采样状态
profiler status

# 查看支持的事件
profiler list
```

**Arthas profiler vs 原生 async-profiler 的关系**：

| 维度 | 原生 async-profiler | Arthas profiler |
|------|--------------------|-----------------|
| 安装 | 需要下载 + 解压 | Arthas 启动时自带 |
| 调用 | `./profiler.sh -d 60 -f x.html PID` | `profiler start; sleep 60; profiler stop --file x.html` |
| 输出 | 文件 | 文件 + Arthas 终端预览 |
| 跨容器 | 需要 profiler.sh 在容器内 | Arthas 在容器内即可 |
| 高级选项 | 全部支持 | 部分包装（如 --include-jvm 不一定暴露） |
| 生产推荐 | 大规模长期采样 | 临时排查 |

**火焰图解读**：

```
┌──────────────────────────────────────────────┐
│ main                                         │   ← 栈底（调用入口）
│ ├────────────────────────────────┬────────── │
│ │ handleMessage                  │ doFilter  │
│ │ ├──────────────┬────────────── │           │
│ │ │ parseJson    │ queryOrder    │           │
│ │ │              ├──────┬─────── │           │
│ │ │              │ db   │ redis  │           │   ← 栈顶（叶子方法）
│ └──────────────┴──────┴─────── ┴────────── │
└──────────────────────────────────────────────┘
   ↑              ↑              ↑
   父方法       子方法         孙方法
```

**横向（X 轴）**：方法调用栈，从下往上 = 调用关系（父方法在下，子方法在上）
**纵向（Y 轴）**：栈深度（顶部 = 叶子方法，底部 = 入口方法）
**宽度**：方法被采样到的次数 = CPU 占用时间

**关键判断标准 - "宽且尖"vs"宽且平"vs"窄且高"**：

| 形态 | 含义 | 案例 | 优化方向 |
|------|------|------|---------|
| **宽且尖**（一个方法特别宽，栈很深） | 单一方法是热点，且调用链深 | `HeavyCompute.calculate` 占 80% CPU | 优化该方法（算法、缓存） |
| **宽且平**（多个方法都占 CPU，栈很浅） | 多方法均匀分散，调用链短 | 各 RPC 调用各占 10% | 难优化，需架构级调整 |
| **窄且高**（栈很深但宽度小） | 深度调用链但单次开销低 | 递归调用 | 减少递归深度 |
| **底部很宽** | 调用入口被频繁触发 | main 函数占 100% | 减少调用次数（限流、批量化） |
| **顶部很宽** | CPU 浪费在叶子方法 | JSON 序列化占 80% | 优化叶子方法（换库、流式） |
| **大量 `JIT` 调用** | JIT 编译占用 | 编译方法频繁 | 预热不充分，提高编译阈值 |
| **大量 `GC` 调用** | GC 占 CPU | GC 频繁 | 内存调优 |

**典型火焰图模式识别**：

**模式 1：单一热点（宽且尖）**

```
┌──────────────────────────────────────────────┐
│ main                                         │
│ ├──────────────────────────────────────────  │
│ │ handleMessage                              │  ← 宽（频繁调用）
│ │ ├──────────────────────────────────────    │
│ │ │ RuleEngine.match                         │  ← 宽（频繁调用）
│ │ │ ├───────────────────────────────────     │
│ │ │ │ Pattern.matches                        │  ← 最宽（CPU 占 80%）
│ │ │ │ ├─────────────────                     │
│ │ │ │ │ regex match                          │
│ └──────────────────────────────────────────  │
└──────────────────────────────────────────────┘
```

**判断**：`Pattern.matches` 占 80% CPU，是单一热点。
**优化**：换正则、预编译 Pattern、改用 String.indexOf

**模式 2：均匀分散（宽且平）**

```
┌──────────────────────────────────────────────┐
│ main                                         │
│ ├──────┬──────┬──────┬──────┬──────┬─────── │
│ │ rpc1 │ rpc2 │ rpc3 │ db1  │ db2  │ redis │  ← 各占 15%
│ └──────┴──────┴──────┴──────┴──────┴─────── │
└──────────────────────────────────────────────┘
```

**判断**：6 个调用各占 15%，无单一热点。
**优化**：并行化（CompletableFuture）、批量化、缓存

**模式 3：GC 占用（大量 GC 帧）**

```
┌──────────────────────────────────────────────┐
│ main                                         │
│ ├──────────────────────────────────────────  │
│ │ GCTask                                     │  ← 占 50%
│ │ ├──────────────────────────────────────    │
│ │ │ G1 Evacuation                            │
│ │ │ ├─────────────────                       │
│ │ │ │ scan object                            │
│ └──────────────────────────────────────────  │
└──────────────────────────────────────────────┘
```

**判断**：GC 占 50% CPU。
**优化**：内存调优（找泄漏、调 GC 参数）

**模式 4：JIT 编译占用（启动期）**

```
┌──────────────────────────────────────────────┐
│ main                                         │
│ ├──────────────────────────────────────────  │
│ │ C2 CompilerThread                          │  ← 占 60%
│ │ ├──────────────────────────────────────    │
│ │ │ compile method                           │
│ │ │ ├─────────────────                       │
│ │ │ │ optimize                               │
│ └──────────────────────────────────────────  │
└──────────────────────────────────────────────┘
```

**判断**：C2 编译占 60% CPU（启动期正常）。
**优化**：预热、AppCDS、AOT

**HTML 火焰图操作**：

- **鼠标悬停**：显示方法名 + 占比
- **点击方法**：放大该方法子树
- **搜索**：右上角搜索框，输入方法名高亮所有匹配
- **重置**：点击 "Reset Zoom" 按钮

**生产实战经验**：

1. **采样至少 30 秒**：短采样统计意义不大
2. **CPU 高时立刻采样**：故障期间采样才有价值，故障恢复后再采样就看不到
3. **同时抓 cpu + alloc**：JDK 11+ 支持多事件，能一次性看 CPU 和内存
4. **生产长开 wall 模式慎用**：wall 模式采样所有线程（包括 WAITING），数据量大
5. **火焰图保存**：故障复盘要附火焰图，便于团队学习

#### 4. JIT 退优化（Deoptimization）引发 CPU 飙高

**JIT 编译层次（Tiered Compilation）**：

JVM 默认开启分层编译（`-XX:+TieredCompilation`，JDK 8 起默认开启），把 JIT 编译分为 4 个层次：

| Tier | 层次 | 优化级别 | 触发阈值 | 适用 |
|------|------|---------|---------|------|
| Tier 0 | 解释执行 | 无优化 | 启动时 | 所有方法首次执行 |
| Tier 1 | C1 编译（no profiling） | 快速编译，无 profile | 调用 ~200 次 | 短小方法 |
| Tier 2 | C1 编译（with profiling） | 快速编译 + 收集 profile | 调用 ~200 次 | 中频方法 |
| Tier 3 | C1 编译（full profiling） | 完整 profile 收集 | 调用 ~2000 次 | 高频方法 |
| Tier 4 | C2 编译 | 深度优化（escape analysis / inline / loop unroll） | 调用 ~10000-15000 次 | 热点方法 |

**编译路径**：

```
解释执行（Tier 0）
   │
   │ 调用 ~200 次
   ▼
C1 编译 with profiling（Tier 2/3）
   │
   │ 调用 ~10000-15000 次 + profile 充分
   ▼
C2 编译（Tier 4，深度优化）
   │
   │ 退优化触发
   ▼
退优化 -> 重新解释执行 / 重新 C1 编译
```

**退优化的 2 种类型**：

| 类型 | 含义 | 触发条件 | 案例 |
|------|------|---------|------|
| **unstable if**（分支预测失效） | C2 假设某分支永远走（或不走），实际遇到反向分支 | profile 显示 99% 走 true，突然遇到 false | 配置变更后异常分支被触发 |
| **not entrant**（假设失效） | C2 基于"类层次稳定"做的 inline 假设失效 | 新类加载使 inline 假设失效 | SPI / 反射加载新实现类 |

**退优化触发条件详解**：

1. **uncommon trap**：C2 编译时假设某分支不会走，生成 uncommon trap；运行时真的走到该分支，触发退优化
2. **profile 不匹配**：C2 基于 profile 推测的"调用目标只有一个"失效，新调用目标出现
3. **新类加载使 inline 假设失效**：C2 inline 了某方法的所有实现，运行时新实现类加载
4. **强制退优化**：`-XX:CompileCommand=dontinline,..` / `-XX:CompileCommand=exclude,..`

**uncommon trap 的执行过程**：

```
C2 编译代码执行
   │
   ▼
遇到反向分支（assumed false 但实际 true）
   │
   ▼
跳转到 uncommon trap
   │
   ▼
JVM 退优化（uncommon trap handler）
   │
   ▼
从 C2 编译代码切回解释执行
   │
   ▼
重新收集 profile
   │
   ▼
（可能）重新触发 C2 编译
```

**退优化的代价**：
- 单次退优化：~1-10ms（切换到解释执行）
- 退优化风暴：大量方法同时退优化 -> CPU 飙高 + 接口偶发慢 + 重新编译占 CPU

**现象**：
- 接口偶发慢（某次请求触发 uncommon trap）
- `-XX:+PrintCompilation` 显示大量 `made not entrant` + 重新编译
- `-XX:+UnlockDiagnosticVMOptions -XX:+PrintInlining` 看到大量 `inline failure`
- CPU 在 `C2 CompilerThread` 占比高（重新编译）

**排查方法**：

**方法 1：开启 PrintCompilation**

```bash
# JDK 8
-XX:+PrintCompilation

# JDK 11+
-Xlog:codegen=info

# 输出示例：
#   1234  4 %   com.example.Handler::handleMessage @ 25 (128 bytes)
#   1235  4     com.example.Handler::handleMessage @ 25 (128 bytes)   made not entrant
#   1236  3     com.example.Handler::handleMessage @ 25 (128 bytes)
```

字段解读：
- `1234`：编译 ID
- `4`：Tier（4 = C2）
- `%`：栈上替换（OSR，On Stack Replacement）
- `made not entrant`：退优化标记
- `@ 25`：方法的第 25 字节码位置

**方法 2：JFR 录制 + JMC 分析**

```bash
# 启动 JFR
jcmd PID JFR.start name=profile duration=60s filename=/tmp/r.jfr settings=profile

# JMC 打开 jfr 文件，看：
# - "Compiler" -> "Compilation" 看编译次数
# - "Compiler" -> "Code Cache" 看代码缓存使用
# - "GC" -> "GC Cause" 看是否有 deopt 触发的 GC
```

**方法 3：看代码分支**

退优化的根因往往是代码分支抖动：

```java
// 坏例子：分支抖动
public void handleMessage(Message msg) {
    if (msg.getType() == MessageType.NORMAL) {  // 99% 走这里
        handleNormal(msg);
    } else {  // 1% 走这里，但配置变更后突然 30% 走这里
        handleSpecial(msg);  // uncommon trap！
    }
}

// 好例子：避免分支抖动
public void handleMessage(Message msg) {
    MessageHandler handler = handlerRegistry.get(msg.getType());
    handler.handle(msg);  // 没有 if 分支，handler 多态分发
}
```

**案例：在线问诊系统 IM 网关偶发 CPU 飙高**

```
现象：
  - IM 网关平时 CPU 30%，偶发飙到 80%（持续 1-2 分钟）
  - 偶发时段 P99 从 50ms 飙到 500ms
  - 监控看到 C2 CompilerThread CPU 30%

排查：
  1. top -Hp 找到高 CPU 线程，是 "C2 CompilerThread0/1/2/3"
  2. jstack 抓栈，栈顶是 C2 编译方法
  3. -XX:+PrintCompilation 看到大量：
     1234  4   com.example.ImHandler::dispatch @ 45 (256 bytes)   made not entrant
     1235  3   com.example.ImHandler::dispatch @ 45 (256 bytes)
     1236  4 % com.example.ImHandler::dispatch @ 45 (256 bytes)   made not entrant
  4. 大量 dispatch 方法反复退优化 + 重新编译

根因分析：
  ImHandler.dispatch 方法根据消息类型分发：
  ```java
  if (msg.type == MessageType.CHAT) {  // 95%
      handleChat(msg);
  } else if (msg.type == MessageType.VIDEO) {  // 4%
      handleVideo(msg);
  } else if (msg.type == MessageType.SYSTEM) {  // 1%
      handleSystem(msg);
  } else if (msg.type == MessageType.REGULATORY) {  // 0.01%，但监管上报突发时变成 20%
      handleRegulatory(msg);  // uncommon trap！
  }
  ```

  - 平时 REGULATORY 消息占比 0.01%，C2 假设该分支不走
  - 监管上报突发（如晚上 11 点批量上报），REGULATORY 消息占比变成 20%
  - C2 编译代码遇到 REGULATORY 消息 -> uncommon trap -> 退优化
  - 退优化后重新 profile -> 重新 C2 编译
  - 但每来一批 REGULATORY 消息就触发一次退优化 -> 风暴

修复：
  1. 把 if-else 改成 handler registry（Map<MessageType, Handler>）
     ```java
     private static final Map<MessageType, Consumer<Message>> HANDLERS = Map.of(
         MessageType.CHAT, ImHandler::handleChat,
         MessageType.VIDEO, ImHandler::handleVideo,
         MessageType.SYSTEM, ImHandler::handleSystem,
         MessageType.REGULATORY, ImHandler::handleRegulatory
     );
     public void dispatch(Message msg) {
         HANDLERS.get(msg.type).accept(msg);
     }
     ```
  2. C2 看到 get + accept 是稳定的虚调用，不再退优化
  3. 修复后 C2 CompilerThread CPU 降到 5%，接口 P99 稳定

经验：
  - if-else 分支比例抖动是 JIT 退优化的常见根因
  - 多态分发（Map / 虚方法）比 if-else 更"JIT 友好"
  - 高频方法的 uncommon trap 要重点排查
```

**JIT 退优化的预防**：

1. **避免在热路径用 if-else 分发**：用 Map / 虚方法替代
2. **避免 SPI / 反射加载新类**：在启动时加载所有实现
3. **避免异常控制流**：异常路径会被 C2 假设为"不走"，异常风暴会触发退优化
4. **避免分支比例抖动**：要么 99%/1% 稳定，要么 50%/50% 稳定，不要忽高忽低
5. **预热脚本**：发布后跑压测，让 profile 稳定后再放流量

**生产实战经验**：

1. **退优化是 JDK 11+ 增强后的诊断热点**：JDK 8 也有但工具链不完善
2. **PrintCompilation 输出量很大**：开 5 分钟就能产生几百 MB，要 grep 关键字
3. **JFR 是诊断 JIT 问题的最佳工具**：低开销 + 可视化 + 时间序列
4. **退优化风暴往往伴随 GC 抖动**：退优化后对象分配模式变化，GC 也会变

#### 5. Safepoint 引发延迟与 CPU 飙高

**Safepoint 概念**：

Safepoint（安全点）是 JVM 全局同步点，所有 Java 线程都必须在 Safepoint 阻塞等待，JVM 才能执行需要"全局一致视图"的操作（如 GC、偏向锁撤销、stack watermark 等）。

**进入 Safepoint 的场景**：

| 场景 | 频率 | STW 时长 | 备注 |
|------|------|---------|------|
| **GC** | 高频 | 100ms-数秒 | 主要 STW 来源 |
| **偏向锁撤销**（bulk revoke） | 中频 | 1-10ms | 锁竞争激烈时批量撤销 |
| **delegate disabled**（JVM 内部） | 低频 | &lt; 1ms | JVM 内部状态切换 |
| **stack watermark**（JDK 15+） | 高频 | &lt; 1ms | 替代部分 Safepoint |
| **jstack / jcmd Thread.print** | 手动触发 | 100ms-数秒 | **诊断操作的副作用** |
| **heap dump** | 手动触发 | 数秒-数分钟 | 全堆扫描 |
| **class unloading** | 中频 | 10-100ms | Metaspace 满时 |
| **Code Cache 清理** | 低频 | 10-100ms | Code Cache 满时 |

**Safepoint 的执行流程**：

```
JVM 触发 Safepoint（如 GC）
   │
   ▼
设置 Safepoint 触发标志（SafepointSynchronize::begin）
   │
   ▼
所有 Java 线程检查标志（轮询点：方法返回 / 循环回边 / Native 调用退出）
   │
   ▼
线程进入 Safepoint（阻塞）
   │  ← 这一步可能慢！叫 sync time
   ▼
JVM 执行 Safepoint 操作（GC / dump 等）
   │  ← 这一步是 Safepoint 操作时长
   ▼
JVM 释放 Safepoint（SafepointSynchronize::end）
   │
   ▼
所有线程恢复执行
```

**SafePoint Bias（基于时间的 Safepoint 偏置）**：

JVM 默认每 1 秒触发一次 Safepoint（基于 `-XX:GuaranteedSafepointInterval=1000`），用于"无操作时也定期同步"。但这会让"长循环"进入 Safepoint 慢：

```java
// 长循环（无方法调用、无循环回边）
for (int i = 0; i < Integer.MAX_VALUE; i++) {
    count++;  // 简单计算，无 Safepoint 轮询点
}
```

**问题**：
- JVM 触发 Safepoint 时，这个线程不在 Safepoint 轮询点
- 其他线程都在 Safepoint 等它
- 等它跑到下一个轮询点（可能几秒后）才能进 Safepoint
- 这段时间叫 **sync time**（同步时间）

**JDK 11+ JEP 312 解决方案**：

JEP 312（Thread Local Handshakes）让 JVM 不需要全局 Safepoint 就能执行单个线程的操作（如偏向锁撤销、stack watermark），减少 Safepoint 频率。

**jstack / jcmd Thread.print 会触发 Safepoint**：

```bash
# jstack 会触发 Safepoint！
jstack -l 12345
# JVM 内部流程：
#   1. 触发 Safepoint
#   2. 所有线程阻塞
#   3. 遍历所有线程栈
#   4. 输出栈信息
#   5. 释放 Safepoint

# 大型应用（10w 线程）的 jstack 可能 STW 5 秒
```

**为什么 jstack 会触发 Safepoint**：
- jstack 需要遍历所有线程的栈
- 遍历栈需要"线程栈不变"
- 让线程栈不变需要"线程阻塞"
- 让所有线程阻塞需要 Safepoint

**JDK 11+ 的改进**：`jcmd Thread.print` 在 JDK 11+ 默认使用 Async Walk（不需要 Safepoint），但 `jstack -l` 仍然会触发 Safepoint。

**safepoint time vs sync time**：

```
Safepoint 总时间 = sync time + operation time

sync time：所有线程进入 Safepoint 的同步时间
operation time：Safepoint 操作本身的执行时间

sync time 长说明：有线程阻挡 Safepoint（长循环 / Native 调用）
operation time 长说明：Safepoint 操作本身慢（GC 慢 / dump 慢）
```

**排查方法**：

```bash
# JDK 8：开启 Safepoint 统计
-XX:+PrintSafepointStatistics
-XX:PrintSafepointStatisticsCount=1

# JDK 11+：用 Xlog
-Xlog:safepoint

# 输出示例：
# [2026-08-06T14:30:15.234+0800] Safepoint "GC" time: 1.234s
# [2026-08-06T14:30:15.234+0800] Safepoint sync time: 4.567s  ← 长！
```

**SafepointTimeout 检测**：

```bash
# Safepoint 同步超过阈值告警
-XX:+SafepointTimeout
-XX:SafepointTimeoutDelay=1000  # 1 秒

# 超时后输出：
# [Warn] SafepointSynchronize::begin: Timeout detected in 1234 ms
# # SafepointSynchronize::begin: Timeout detected in 1234 ms
#   thread: 0x...  [n: 12345]
#   stack:
#     at com.example.LongLoop.calculate(LongLoop.java:45)  <- 元凶线程
```

**Safepoint 慢的常见元凶**：

1. **长循环无 Safepoint 轮询点**：`for (int i = 0; i < BIG; i++)` 简单计算
2. **JNI 调用慢**：Native 方法执行中，线程不在 Java 代码里，无法响应 Safepoint
3. **大循环 + 内联**：C2 内联后循环变长，循环回边少，Safepoint 轮询少
4. **网络 IO 阻塞**：socket read 阻塞中（但 socket read 会让出 CPU，JDK 10+ 优化为不阻挡 Safepoint）

**案例：IM 网关 10w 长连接 jstack 引发 5 秒 STW**

```
现象：
  - IM 网关承载 10w 长连接，平时 P99 50ms
  - 某次故障排查时 jstack，引发 5 秒 STW
  - STW 期间 1.2w 长连接断开（心跳超时）

排查：
  1. 看 -XX:+PrintSafepointStatistics 输出：
     Total time for application threads to stop: 5234 ms
     Stopping threads took: 5200 ms  ← sync time 5.2s
  			
  2. SafepointTimeout 告警：
     [Warn] SafepointSynchronize::begin: Timeout detected in 1000 ms
       thread: 0x...  [n: 12389]  <- Netty NioEventLoop
       stack:
         at com.example.HeartbeatManager.batchCheck(HeartbeatManager.java:67)
         at io.netty.channel.nio.NioEventLoop.run(NioEventLoop.java:494)

  3. 看 HeartbeatManager.batchCheck 代码：
     ```java
     public void batchCheck() {
         // 长循环：检查 10w 连接的心跳
         for (int i = 0; i < connections.size(); i++) {  // 10w 次
             checkConnection(connections.get(i));  // 简单计算，无 Safepoint 轮询
         }
     }
     ```

根因：
  - 10w 连接的循环，每次 checkConnection 是简单计算（几百纳秒）
  - C2 内联了 checkConnection，整个循环变成单一大循环
  - 循环回边少，Safepoint 轮询点少
  - jstack 触发 Safepoint 时，NioEventLoop 线程在循环中
  - 等了 5 秒才到下一个 Safepoint 轮询点

修复：
  1. 加 Safepoint 轮询点：循环里加 Thread.onSpinWait() 或 LockSupport.parkNanos(1)
     ```java
     for (int i = 0; i < connections.size(); i++) {
         checkConnection(connections.get(i));
         if (i % 1000 == 0) {
             Thread.onSpinWait();  // Safepoint 轮询点
         }
     }
     ```
  2. 缩小循环：把 10w 连接分批，每批 1000 个，中间走 Netty schedule
  3. 关闭 -XX:GuaranteedSafepointInterval（生产慎用，可能引发其他问题）
  4. 升级 JDK 17，启用 JEP 376（ZGC: Concurrent Stack Scanning），减少 Safepoint 依赖

经验：
  - 大循环 + 简单计算 = Safepoint 杀手
  - jstack 在大型应用上是有副作用的（触发 Safepoint）
  - 故障排查时的诊断操作本身可能引发新的故障
```

**Safepoint 排查清单**：

```text
□ 是否开启 -XX:+PrintSafepointStatistics 或 -Xlog:safepoint？
□ Safepoint sync time 是否 > 100ms？
□ 是否有线程阻挡 Safepoint（SafepointTimeout 告警）？
□ 元凶线程的栈是否在长循环 / Native 调用？
□ GuaranteedSafepointInterval 是否需要调整？
□ 是否升级到 JDK 17 减少 Safepoint 依赖？
```

**Safepoint 与 GC 的关系**：

```
GC 必须在 Safepoint 执行
   │
   ▼
Safepoint sync time 长 = GC STW 时间长
   │
   ▼
P99 抖动 + 业务偶发慢
```

**生产实战经验**：

1. **jstack 在 10w+ 线程应用上有副作用**：触发 Safepoint，可能引发 1-5 秒 STW
2. **JDK 11+ 用 jcmd Thread.print 替代 jstack**：默认 async walk，不触发 Safepoint
3. **长循环要加 Safepoint 轮询点**：Thread.onSpinWait() / LockSupport.parkNanos(1)
4. **GuaranteedSafepointInterval 可以关闭**：`-XX:GuaranteedSafepointInterval=0`，但生产慎用
5. **JDK 17 减少 Safepoint 依赖**：JEP 376（ZGC concurrent stack scan）/ JEP 312（handshake）

---

## 题目二（场景应用题）：在线问诊系统 IM 网关 CPU 95% 排查

> **场景**：在线问诊系统生产环境，某天凌晨 02:30 IM 网关告警：
> - IM 网关 4 个 Pod CPU 全部 95%+，单 Pod 4C8G，10w 长连接
> - 业务监控：消息投递 P99 从 50ms 飙到 3.2s，开始有客户端断开重连
> - 02:35 客户端断开数突破 1.2w，移动端反馈"消息收不到"
> - 网关 Pod RSS 内存 4.8GB（未涨），GC 监控正常（Young GC 0.5 次/秒，Full GC 0）
> - 02:30 前后没有发布，没有明显流量突增（QPS 平稳 8000）
>
> **要求**：用 STAR 法则讲述完整排查过程，5 分钟内定位根因，给出止血 + 根因方案。

### 作答区

#### Situation - 现象与影响

**业务背景**：
- IM 网关承载 10w+ 医患长连接，单 Pod 4C8G，4 副本
- 业务监控：消息投递 P99 50ms，CPU 平稳 30%
- 02:30 告警：CPU 95%+，P99 3.2s，1.2w 客户端断连
- 没有发布，没有明显流量突增

**初步信息收集**：

```
监控面板：
  CPU: 4 Pod 都 95%+（之前 30%）
  QPS: 8000（平稳，无突增）
  P99: 3.2s（之前 50ms）
  堆内存: 1.8GB（正常，未涨）
  GC: Young GC 0.5 次/秒，Full GC 0（正常）
  RSS: 4.8GB（正常）
  
GC 日志：正常，无 Full GC，无大对象
业务日志：大量 "client disconnected: idle timeout"
```

**关键判断**：
- CPU 高但 GC 正常 -> 不是 GC CPU 高
- QPS 没涨但 CPU 高 -> 不是流量突增
- 没有 Full GC -> 不是内存问题

#### Task - 任务目标

**核心任务**：5 分钟内定位 CPU 95% 的根因，止血 + 修复

**优先级**：
1. 止血（02:35 客户端断连 1.2w，每分钟新增 5000+）
2. 定位根因（CPU 高的代码位置）
3. 修复（避免同类问题复现）

#### Action - 排查动作

##### 第 1 分钟：止损决策 + 现象分类

**止损决策**：

```
判断影响：
  - 10w 长连接，已断 1.2w，每分钟新增 5000+
  - 5 分钟内可能断 4w，影响 40% 用户
  - P0 故障，必须立即止损
  
止损选项：
  1. 扩容 +4 Pod：缓解单 Pod CPU，但不能解决根因
  2. 限流：IM 网关限流会让更多客户端断连（心跳超时）
  3. 摘流量：IM 网关是长连接，摘流量等于主动断连
  4. 重启：丢失所有 10w 连接，业务影响最大
  
决策：先抓现场，再扩容 +4 Pod 缓解
  - 抓 1 个 Pod 现场（其他 3 个继续服务）
  - 立即 HPA 扩容 +4 Pod
  - 新连接打到新 Pod，旧 Pod CPU 逐步下降
```

**现象分类**（30 秒）：

```
GC 正常 + CPU 高 -> 排除 GC CPU 高
没有发布 + 突然飙高 -> 排除 JIT 编译 CPU 高
单 Pod CPU 95%（不是单线程 100%） -> 排除单线程死循环
GC 正常但 CPU 高 -> 业务 CPU 高 / 锁竞争 / Native CPU 高
```

##### 第 2-3 分钟：抓现场 - 5 步法 + async-profiler

**5 步法抓栈**：

```bash
# 第 1 步：找 CPU 高的 Java 进程
kubectl exec -it im-gateway-pod-1 -- jps -lvm
# 1 com.example.ImGatewayApplication -Xms4g -Xmx4g -XX:+UseG1GC

# 第 2 步：top -Hp 找高 CPU 线程
kubectl exec -it im-gateway-pod-1 -- top -b -n 1 -H -p 1
#   PID  USER  %CPU  COMMAND
#  234   app    85   java  <- NioEventLoopGroup
#  235   app    78   java  <- NioEventLoopGroup
#  236   app    72   java  <- NioEventLoopGroup
#  237   app    68   java  <- NioEventLoopGroup
#  238   app    35   java  <- C2 CompilerThread
#  239   app    12   java  <- GC Thread

# 4 个 NioEventLoopGroup 线程各占 70%+ CPU
# -> 业务 CPU 高 / Native CPU 高（Netty IO）

# 第 3 步：转 16 进制
printf "%x\n" 234
# ea

# 第 4 步：jstack 抓栈
kubectl exec -it im-gateway-pod-1 -- jstack -l 1 > /tmp/jstack_im.log
grep -A 30 "nid=0xea" /tmp/jstack_im.log

# 第 5 步：看栈顶
# "nioEventLoopGroup-2-1" #25 prio=10 tid=0x... nid=0xea runnable
#    java.lang.Thread.State: RUNNABLE
#        at io.netty.util.ResourceLeakDetector$DefaultResourceLeak.close(ResourceLeakDetector.java:550)
#        at io.netty.util.ResourceLeakDetector.track(ResourceLeakDetector.java:300)
#        at io.netty.buffer.AbstractByteBuf.release(AbstractByteBuf.java:217)
#        at com.example.ImHandler.handleMessage(ImHandler.java:78)
```

**关键发现**：
- 栈顶是 `ResourceLeakDetector$DefaultResourceLeak.close` 和 `ResourceLeakDetector.track`
- Netty 的 ByteBuf 泄漏检测器在循环清理！
- 业务代码 ImHandler.handleMessage 调用了 ByteBuf.release

**连续抓 3 次确认**：

```bash
for i in 1 2 3; do
  kubectl exec -it im-gateway-pod-1 -- jstack -l 1 >> /tmp/jstack_im_$i.log
  sleep 2
done

# 3 次抓到的栈顶都是 ResourceLeakDetector -> 确认是泄漏检测循环
```

**async-profiler 火焰图确认**：

```bash
# CPU 火焰图，采样 60 秒
kubectl exec -it im-gateway-pod-1 -- ./profiler.sh -d 60 -f /tmp/cpu.html 1
kubectl cp im-gateway-pod-1:/tmp/cpu.html /tmp/cpu.html

# 打开火焰图：
# - nioEventLoopGroup 占 70% CPU
# - 子调用 ResourceLeakDetector.track 占 50% CPU  ← 大头！
# - ResourceLeakDetector$DefaultResourceLeak.close 占 30% CPU
# - 业务 handleMessage 只占 5% CPU
```

**火焰图形态**：

```
┌──────────────────────────────────────────────┐
│ nioEventLoopGroup-2-1                        │  ← 70%
│ ├──────────────────────────────────────      │
│ │ ResourceLeakDetector.track                 │  ← 50%（核心问题）
│ │ ├─────────────────                         │
│ │ │ DefaultResourceLeak.close                │  ← 30%
│ │ │ ├───────────                             │
│ │ │ │ ReferenceQueue.poll                    │
│ │ ├───────                                   │
│ │ │ WeakReference.clear                      │
│ ├─────────                                   │
│ │ AbstractByteBuf.release                    │  ← 5%
│ └─────                                       │
│ │ ImHandler.handleMessage                    │  ← 5%（业务）
└──────────────────────────────────────────────┘
```

**判断**：宽且尖的栈，单一方法 ResourceLeakDetector.track 占 50% CPU，是核心问题。

##### 第 4 分钟：根因定位

**Netty ResourceLeakDetector 的工作原理**：

```
Netty 检测 ByteBuf 泄漏的机制：
  1. 创建 ByteBuf 时，ResourceLeakDetector 用 WeakReference 引用
  2. ByteBuf.release() 时，调用 ResourceLeakDetector.track()
  3. track() 检查 ByteBuf 是否真的被释放
  4. 如果 ByteBuf 没 release 就被 GC，记录泄漏
  
问题：
  - WeakReference 数量随 ByteBuf 创建线性增长
  - 每次创建 ByteBuf 都要 track
  - 每次释放 ByteBuf 都要从 ReferenceQueue 移除
  - 高频创建 / 释放时，track() 自身成为 CPU 热点
```

**为什么平时没问题，凌晨突然飙高**：

```bash
# 查业务日志，凌晨 02:30 前后的关键事件
kubectl logs im-gateway-pod-1 --since=1h | grep -E "ERROR|WARN" | head -50

# 关键发现：
# 02:28:35 WARN  ByteBufLeakDetector - Leaked ByteBuf: 0x... (release count: 0)
# 02:28:36 WARN  ByteBufLeakDetector - Leaked ByteBuf: 0x... (release count: 0)
# ...（每秒 100+ 条泄漏告警）
# 02:30:00 INFO  ResourceLeakDetector - Leak detection level: SIMPLE -> PARANOID
```

**关键发现**：
- 02:28 开始有 ByteBuf 泄漏告警
- 02:30 ResourceLeakDetector 等级从 SIMPLE 切换到 PARANOID
- PARANOID 等级会对**每个** ByteBuf 都做泄漏检测（默认 SIMPLE 是采样 1%）

**为什么等级会切换**：

```bash
# Arthas 查 ResourceLeakDetector 配置
ognl '@io.netty.util.ResourceLeakDetector@level()'
# PARANOID

# 查代码，发现是动态配置
jad com.example.ImGatewayConfig
# public static String LEAK_DETECTION_LEVEL = System.getenv("NETTY_LEAK_DETECTION_LEVEL");

# 凌晨 02:30 配置中心推送了配置变更（运维操作）
# NETTY_LEAK_DETECTION_LEVEL 从 SIMPLE 改为 PARANOID
# 业务代码读到了新配置，调用 ResourceLeakDetector.setLevel()
```

**为什么 PARANOID 会引发 CPU 飙高**：

```
IM 网关每秒处理 8000 消息，每条消息 5 个 ByteBuf（请求 / 响应 / 多个 buffer）
  = 40000 ByteBuf / 秒

SIMPLE 模式：1% 采样 -> 400 次 track/秒 -> CPU 1%
PARANOID 模式：100% 采样 -> 40000 次 track/秒 -> CPU 70%+
```

**业务代码片段**：

```java
// ImHandler.handleMessage
public void handleMessage(Channel ctx, ByteBuf msg) {
    ByteBuf reqBuf = msg;  // 入参 ByteBuf，业务自己 release
    ByteBuf respBuf = ctx.alloc().buffer(1024);
    ByteBuf heartBuf = ctx.alloc().buffer(64);
    ByteBuf ackBuf = ctx.alloc().buffer(32);
    
    try {
        // 业务处理
        processMessage(reqBuf, respBuf);
        ctx.writeAndFlush(respBuf);
    } finally {
        reqBuf.release();      // 1 次 release
        heartBuf.release();    // 1 次 release  
        ackBuf.release();      // 1 次 release
        // 每次 release 都触发 ResourceLeakDetector.track()
    }
}
```

**根因总结**：
1. 凌晨 02:30 运维通过配置中心把 `NETTY_LEAK_DETECTION_LEVEL` 从 SIMPLE 改为 PARANOID
2. 业务代码读到新配置，调用 `ResourceLeakDetector.setLevel(Level.PARANOID)`
3. PARANOID 等级下，每个 ByteBuf 创建 / 释放都触发 track()
4. 8000 QPS × 5 ByteBuf = 40000 track/秒
5. track() 自身成为 CPU 热点（占 50% CPU）
6. NioEventLoop 4 个线程都被 track 占用，没空处理 IO 事件
7. 客户端心跳超时，10w 连接开始断开

##### 第 5 分钟：止血 + 根因修复

**止血（立即）**：

```bash
# 止血方案 1：恢复 ResourceLeakDetector 等级
kubectl exec -it im-gateway-pod-1 -- bash -c '
  java -jar arthas-boot.jar 1 <<EOF
ognl "@io.netty.util.ResourceLeakDetector@setLevel(io.netty.util.ResourceLeakDetector.Level.SIMPLE)"
EOF
'

# 止血方案 2：扩容 +4 Pod（同时进行）
kubectl scale deployment im-gateway --replicas=8

# 止血方案 3：限流客户端重连（防止雪崩）
# 在 LB 层加 rate limit，每秒只允许 1000 客户端重连
```

**止血效果**：
- 02:36 恢复 SIMPLE 等级，CPU 立即降到 30%
- 02:38 P99 恢复到 50ms
- 02:40 客户端断连停止，已有 1.5w 断连客户端开始重连
- 02:45 +4 Pod 就绪，承接重连流量
- 03:00 全量恢复

**根因修复**：

**PR 1：移除动态修改 ResourceLeakDetector 等级的逻辑**

```java
// 坏代码：动态修改等级
public class ImGatewayConfig {
    public static String LEAK_DETECTION_LEVEL = System.getenv("NETTY_LEAK_DETECTION_LEVEL");
    
    @PostConstruct
    public void init() {
        // 监听配置变更，动态修改
        configCenter.addListener("NETTY_LEAK_DETECTION_LEVEL", newLevel -> {
            ResourceLeakDetector.setLevel(Level.valueOf(newLevel));
        });
    }
}

// 好代码：启动时一次性读取，不动态修改
public class ImGatewayConfig {
    private static final Level LEAK_LEVEL = 
        Level.valueOf(System.getProperty("io.netty.leakDetection.level", "SIMPLE"));
    
    static {
        ResourceLeakDetector.setLevel(LEAK_LEVEL);  // 启动时设一次
    }
}
```

**PR 2：PARANOID 等级只能通过启动参数设置**

```bash
# 启动参数设置（不能运行时改）
java -Dio.netty.leakDetection.level=SIMPLE -jar im-gateway.jar

# 生产环境永远用 SIMPLE，测试环境用 PARANOID
# 排查泄漏时临时用 ADVANCED（采样 10%）
```

**PR 3：ByteBuf 泄漏检测的工程实践**

```java
// 1. 用 SimpleLeakAwareByteBuf 即可，不要用 AdvancedLeakAwareByteBuf
// 2. 业务代码用 try-with-resources 模式
public void handleMessage(Channel ctx, ByteBuf msg) {
    try (ByteBuf reqBuf = msg.retain();
         ByteBuf respBuf = ctx.alloc().buffer(1024)) {
        processMessage(reqBuf, respBuf);
        ctx.writeAndFlush(respBuf.retain());
    }  // try-with-resources 自动 release
}

// 3. 排查泄漏时用 PARANOID，但要在低峰期，且监控 CPU
// 4. 加 ByteBuf 泄漏告警：日志里有 "LEAK: ByteBuf.release()" 时告警
```

**监控告警改进**：

```
新增告警规则：
  - Netty ResourceLeakDetector 等级变更告警（监听 setLevel 调用）
  - ByteBuf 泄漏告警（日志关键字 "LEAK: ByteBuf"）
  - CPU 高 + NioEventLoop 占用高告警（早期发现）
  - 配置变更告警（所有动态配置变更都告警）
```

**复盘文档**：

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

#### Result - 结果与经验

**业务结果**：
- 故障持续 30 分钟（02:30 - 03:00）
- 1.5w 客户端断连重连，影响 15% 用户
- 无数据丢失，无资损

**技术结果**：
- 5 分钟内定位根因（02:36 - 02:41）
- 用 5 步法 + async-profiler 火焰图确认
- 止血 + 根因修复完整闭环

**经验沉淀**：

1. **5 步法是 CPU 排查的基础**：top -Hp + printf %x + jstack + grep + 看栈顶
2. **async-profiler 火焰图是定位框架内部热点的利器**：jstack 看到 ResourceLeakDetector.track 不够，火焰图能看清占比
3. **连续抓 3 次 jstack**：单次可能误判
4. **生产配置变更要有评审 + 告警**：尤其涉及 Netty / JVM 框架级配置
5. **PARANOID 等级只在排查泄漏时用**：低峰期开 5 分钟，定位完立即关

**面试 STAR 法则讲述要点**：

```
S（Situation）：
  - IM 网关 10w 长连接，凌晨 CPU 飙到 95%
  - P99 3.2s，1.5w 客户端断连
  - 没有 GC 异常，没有流量突增

T（Task）：
  - 5 分钟定位 CPU 根因
  - 止血 + 根因修复

A（Action）：
  - 第 1 分钟：止损决策 + 现象分类（排除 GC / 流量，定位业务 CPU）
  - 第 2-3 分钟：5 步法 + async-profiler 火焰图
    - top -Hp 找到 4 个 NioEventLoop 占 70%+ CPU
    - jstack 看到 ResourceLeakDetector.track 栈顶
    - async-profiler 火焰图确认占 50% CPU
  - 第 4 分钟：根因定位
    - 凌晨配置变更把 Netty 泄漏检测从 SIMPLE 改为 PARANOID
    - 8000 QPS × 5 ByteBuf = 40000 track/秒
  - 第 5 分钟：止血 + 根因修复
    - 恢复 SIMPLE 等级 + 扩容 +4 Pod
    - PR 移除动态修改逻辑

R（Result）：
  - 5 分钟定位，30 分钟全量恢复
  - 1.5w 用户影响，无资损
  - 沉淀配置变更告警 + ByteBuf 泄漏告警
```

**与架构师水平的差距与补足方向**：

| 能力项 | 我的水平 | 架构师水平 | 补足方向 |
|--------|---------|----------|---------|
| 5 步法熟练度 | 能用但要查命令 | 30 秒内背出全命令 | 每周演练 1 次 |
| 火焰图解读 | 能看懂基本形态 | 1 分钟内识别 5 种模式 | 收集 10 个真实火焰图分析 |
| Netty 内部机制 | 知道 ResourceLeakDetector 但不知道 PARANOID 影响 | 能脱口而出 4 个等级区别 | 精读 Netty 源码 |
| Safepoint 与 jstack 关系 | 不知道 jstack 触发 Safepoint | 能讲清 JDK 11+ async walk | 阅读 JEP 312 / 376 |
| 故障复盘深度 | 复盘到代码根因 | 复盘到流程 / 体系根因 | 每次复盘挖到第 5-6 层 |

---

## 能力差距提示

作答时请对照架构师水平，重点检查以下能力：

1. **6 种 CPU 飙高类型的分类能力**：能不能 30 秒内根据 top -Hp 线程名判断是 GC / JIT / 业务 / 锁 / 死循环 / Native？
2. **5 步法的熟练度**：能不能不查文档直接写出 `top -Hp PID` + `printf "%x\n" TID` + `jstack -l PID | grep -A 30 nid=0xHEX`？
3. **K8s 容器内的坑**：top -Hp 不显示线程、容器 PID 不一致、kubectl top 与 exec top 不一致，能不能说清？
4. **火焰图解读**：能不能从火焰图识别"宽且尖"vs"宽且平"vs"窄且高"，并给出优化方向？
5. **async-profiler 4 种模式**：cpu / alloc / lock / wall 的区别与适用场景，能不能脱口而出？
6. **JIT 退优化**：能不能讲清 C1 / C2 层次、uncommon trap、unstable if、not entrant 的机制？能不能从代码分支反推退优化风险？
7. **Safepoint 与 jstack 的关系**：能不能讲清 jstack 为什么会触发 Safepoint？sync time 长说明什么？
8. **与简历项目的结合**：在线问诊系统的 5 个 CPU 飙高场景，能不能用 STAR 法则讲出 2-3 个完整故事？
9. **架构师视角**：能不能从"工具使用"上升到"配置变更管控 + 故障演练 + 监控告警体系"？
