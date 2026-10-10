# 架构师学习-Day03-OOM 排查实战-梳理

> 日期：2026年08月05日（周三）
> 周主题：JVM 专题第 2 周 - 调优实战与生产排查
> 梳理日：Day03 - 架构师视角梳理

---

## 一、架构师视角下的 OOM 排查

### 1.1 不只是"会查 dump"，是"OOM 防治体系"

很多工程师把 OOM 排查当成"出事用 MAT 看一下"的临时技能，结果就是"dump 会看了但生产事故还是定位不出来"。架构师视角下，OOM 是**体系化工程**：

| 架构决策 | 受 OOM 排查能力约束的具体点 |
|---------|--------------------------|
| OOM 自救能力 | `-XX:+HeapDumpOnOutOfMemoryError` 是否开启、dump 路径是否有磁盘 |
| 故障定位 SLA（5 分钟 vs 30 分钟） | MAT 熟练度、支配树算法理解、5 分钟定位法节奏 |
| 监控告警体系 | 堆使用率 / Full GC 频率 / 缓存大小是否纳入监控 |
| Code Review 流程 | Map 上限 / ThreadLocal remove / 监听器 unregister 是否进 Checklist |
| 静态代码扫描 | SpotBugs / SonarQube 是否扫描内存泄漏模式 |
| 容量规划 | 堆大小 / Pod limit / 缓存上限是否匹配业务量 |
| JDK 升级决策 | finalize 在 JDK 18+ Deprecated，需要前置排查 |
| 业务架构设计 | 24h 必达 / 长生命周期任务是否设计内存保护 |

如果 OOM 排查只是"工程师的私人技能"，团队整体故障定位能力就上不去。**架构师的责任是把 OOM 防治变成团队能力**。

### 1.2 OOM 排查的本质：诊断 vs 治疗 vs 预防

OOM 排查按医学逻辑分三类：

| 类别 | 作用 | 代表工具 / 实践 | 时机 |
|------|------|---------------|------|
| **诊断** | 看现状、定位问题 | dump + MAT + GC 日志 + Arthas vmtool | 出问题后 |
| **治疗** | 修复问题 | 清缓存 / Arthas ognl 改字段 / 重启 / PR 修复 | 定位后 |
| **预防** | 提前发现问题 | Code Review Checklist / 静态扫描 / 监控告警 / 演练 | 出问题前 |

**架构师思维**：

```
普通工程师：会诊断（dump + MAT）
高级工程师：会诊断 + 会治疗（Arthas 热修复）
架构师：会诊断 + 会治疗 + 建设预防体系（Checklist + 扫描 + 告警 + 演练）
```

**关键认知**：OOM 自动 dump + Code Review Checklist 是"OOM 防治的两道闸"--自动 dump 保证"事故有证据"，Checklist 保证"事故不重演"。

### 1.3 OOM 排查的 8 种类型：不是所有 OOM 都是"堆 OOM"

JVM 的 OOM 不是单点问题，是 8 类问题，每类的根因和修复方向完全不同：

| OOM 类型 | 触发区域 | 修复方向 | 与 Day01 参数的对应 |
|---------|---------|---------|------------------|
| `Java heap space` | Java 堆 | 找泄漏 / 扩堆 | `-Xmx` |
| `GC overhead limit exceeded` | Java 堆（预警） | 同上 | `-XX:+UseGCOverheadLimit` |
| `Metaspace` | Metaspace | 排查动态类生成 | `-XX:MaxMetaspaceSize` |
| `Compressed class space` | 压缩类空间 | 调大 / 关指针压缩 | `-XX:CompressedClassSpaceSize` |
| `Direct buffer memory` | 堆外直接内存 | 排查 ByteBuf 释放 | `-XX:MaxDirectMemorySize` |
| `unable to create new native thread` | OS 线程 | 调 ulimit / 减线程 | `-Xss` |
| `Requested array size exceeds VM limit` | Java 堆 | 改集合 / 分片 | 无 |
| `StackOverflowError` | 线程栈 | 加 `-Xss` / 改迭代 | `-Xss` |

**架构师经验**：

1. **OOM 类型决定排查方向**：不要所有 OOM 都按"堆 OOM"排查，Metaspace OOM 看 dump 没用，要看 ClassLoader
2. **OOM 自动 dump 必开**：`-XX:+HeapDumpOnOutOfMemoryError` 是救命配置
3. **OOM 前预警**：`GC overhead limit exceeded` 是预警，看到了立即抓现场
4. **OOM 重启不是终点**：不修根因，重启后必复现
5. **OOM 与 OOM kill 区分**：JVM OOM 是堆内爆，OS OOM kill 是 Pod RSS 超 limit 被 kill，两者根因不同

### 1.4 MAT 的本质：支配树算法是 OOM 排查的"核武器"

MAT 不是"看一下 Histogram 就完了"的工具，MAT 的核心是**支配树 Dominator Tree 算法**。架构师必须理解这个算法，才能 1 分钟内找到元凶。

**支配树算法核心**：
- 节点 d 支配节点 n，当且仅当从 GC Root 到 n 的所有路径都必须经过 d
- **移除 d 就切断了 n 与 GC Root 的所有联系**
- 在支配树中，**父节点回收时，所有子节点都能被回收**
- **Retained Size = 自身 Shallow + 所有子节点的 Shallow 之和**

**为什么用支配树而非引用树**：
1. 引用关系是图（一个对象可能被多个对象引用），支配树把图转成树
2. 支配树揭示"回收价值"：支配树 Top 1 回收能释放最大内存
3. 避免重复计算：一个对象的 Retained Size 在支配树中是确定的

**架构师思维**：
- 找内存泄漏**永远看 Retained Size**
- 一个 ArrayList 对象本身才 24 字节，但里面装了 1GB 数据，Retained Size 就是 1GB
- Dominator Tree 按 Retained 排序，第一名通常就是元凶（70% 准确率）

### 1.5 OOM 与业务架构的协同：不是所有 OOM 都是"代码 bug"

架构师视角下，OOM 的根因不仅是代码 bug，更多是**业务架构与 JVM 内存设计的协同不足**：

| 业务场景 | OOM 风险 | 架构设计 |
|---------|---------|---------|
| 24h 必达任务 | 任务长期驻留内存，taskMap 累积 | 任务持久化到 DB + 内存上限 + 失败队列 |
| IM 长连接 | 每连接一个 EventLoop 线程 + ByteBuf | 单 Pod 连接数上限 + ByteBuf 池化 |
| 视频通话 | RTP 包堆积 | 通话结束清理 queue + 单通话内存上限 |
| 大文档存储 | 单文档 > Region/2 触发 Humongous | 文档分片 + G1HeapRegionSize 调大 |
| 全量查询 | ResultSet 全量加载 | 流式查询 + 游标 + 分页 |
| 缓存设计 | Caffeine 上限过大 | 上限与堆大小匹配 + 过期策略 |
| 监管上报 | 重试逻辑新建对象 | 重试复用对象 + 上限保护 |

**架构师责任**：
1. **业务架构评审必看 JVM 内存**：长生命周期对象、大对象、缓存膨胀都要在评审阶段识别
2. **JVM 调优不能脱离业务**：`-Xmx` 多大、用什么 GC，取决于业务对象特征
3. **OOM 预防要前置**：Code Review + 静态扫描 + 监控告警，三道防线

---

## 二、OOM 排查的三大核心场景

### 2.1 场景一：堆 OOM（最高频，占 80%）

**典型现象**：服务 OOM 重启，日志报 `Java heap space`，自动 dump 生成。

**架构师视角的堆 OOM 分类**：

| 类型 | 特征 | 工具链 | 修复方向 |
|------|------|--------|---------|
| **真泄漏** | Retained Size 单一对象异常大、引用链可追 | jmap + MAT | 修业务 bug |
| **缓存膨胀** | Caffeine / Map Retained 大、key 数量异常 | Arthas vmtool + MAT | 加上限 / 调过期 |
| **大对象** | byte[] / String Retained 大、单实例异常 | jmap -histo + MAT | 改分页 / 流式 |
| **ThreadLocal 累积** | ThreadLocalMap 大、线程池复用 | MAT + OQL | 用完 remove |
| **重试风暴** | 重试时新建对象、Map 累积 | MAT + 业务代码 review | 复用对象 + 上限 |
| **静态集合无限增长** | System Class 持有的 Map | MAT | 改成有上限的缓存 |
| **finalize 队列堆积** | Finalizer 队列大、对象多 | jstat + MAT | 避免 finalize |

**架构师经验**：

1. **第一次定位不出来很正常**：可能元凶是动态生成的类，需要看 Histogram 多次刷新
2. **MAT Dominator Tree 第一名未必是元凶**：可能是 JVM 内部对象（如 StringTable），要看引用链
3. **缓存膨胀最常见**：80% 的"内存泄漏"都是缓存配置错误或未设上限
4. **重试风暴容易被忽视**：业务方说"重试逻辑没问题"，但重试时新建对象是隐形泄漏

**生产实战 - 堆 OOM 的识别清单**：

```
□ Leak Suspects 报告指向什么？
□ Dominator Tree Top 1 Retained 占比多少？
□ Top 1 是 Caffeine / ConcurrentHashMap / HashMap？-> 缓存膨胀
□ Top 1 是 byte[] / char[] / String？-> 大对象
□ Top 1 是 ThreadLocalMap？-> ThreadLocal 累积
□ Top 1 是 Finalizer$Queue？-> finalize 队列堆积
□ Top 1 是 java.lang.Class？-> CGLIB / Groovy 动态类
□ Path to GC Roots 显示元凶线程是谁？
□ 业务代码是否有 register/unregister 配对？
□ 业务代码是否有 ThreadLocal.set/remove 配对？
□ 业务代码是否有 retry 复用对象逻辑？
□ 缓存是否设了 maximumSize + expireAfterWrite？
□ 静态集合是否有清理逻辑？
□ 是否重写了 finalize？
```

### 2.2 场景二：Metaspace / Direct Buffer OOM（最隐蔽）

**典型现象**：堆使用率正常（&lt; 60%），但 Pod RSS 持续涨，最终 Metaspace OOM 或 Direct Buffer OOM。

**Metaspace OOM 的识别**：

| 维度 | 特征 |
|------|------|
| 报错信息 | `java.lang.OutOfMemoryError: Metaspace` |
| jstat 看 | MC（Metaspace Used）持续涨 |
| jmap -histo | `java.lang.Class` 实例数异常多 |
| MAT 看 | `BoundedUnlimitedClassLoader` / `CGLIB$GeneratedClassLoader` 实例多 |
| 根因 | 动态类生成（CGLIB / Groovy / JSP）/ ClassLoader 泄漏 |

**Direct Buffer OOM 的识别**：

| 维度 | 特征 |
|------|------|
| 报错信息 | `java.lang.OutOfMemoryError: Direct buffer memory` |
| 堆使用率 | 正常（&lt; 60%） |
| Pod RSS | 持续涨，最终被 OOM kill 或 Direct Buffer OOM |
| NMT summary | `Internal` 部分持续涨 |
| Arthas vmtool | `java.nio.DirectByteBuffer` 实例数异常多 |
| 根因 | ByteBuf 未 release / Direct ByteBuffer 累积 |

**架构师经验**：

1. **堆正常但 RSS 涨，先看 NMT**：`jcmd PID VM.native_memory summary`
2. **Metaspace OOM 看类加载器**：Arthas `vmtool --action getInstances --className java.lang.ClassLoader`
3. **Direct Buffer 看(ByteBuf)**：开启 Netty leak detection
4. **K8s limit 与 JVM 内存配比**：堆 + Metaspace + Direct + Thread Stack + JVM 自身（约 500MB）&lt; Pod limit

**生产实战 - Direct Buffer OOM 识别清单**：

```
□ 堆使用率正常但 RSS 涨？
□ jcmd PID VM.native_memory summary 看 Internal 涨？
□ Arthas vmtool --action getInstances --className java.nio.DirectByteBuffer 实例数？
□ 是否用 Netty？-> 开 -Dio.netty.leakDetection.level=PARANOID
□ 是否用 NIO？-> 检查 ByteBuffer.allocateDirect 后是否 release
□ 是否禁用了 System.gc？-> -XX:+DisableExplicitGC 会让 Direct Buffer 清理失效
□ -XX:MaxDirectMemorySize 设了多少？是否与 Pod limit 匹配？
□ K8s Pod limit 是否预留 Direct Buffer 空间？
```

### 2.3 场景三：Thread OOM / StackOverflow（最易误判）

**典型现象**：服务报 `unable to create new native thread` 或 `StackOverflowError`，但堆完全正常。

**Thread OOM 的识别**：

| 维度 | 特征 |
|------|------|
| 报错信息 | `java.lang.OutOfMemoryError: unable to create new native thread` |
| 堆使用率 | 正常 |
| jstack | 线程数异常多（如 6w+） |
| 业务代码 | `new Thread()` 没用线程池 / 线程池配置错误 |
| OS 限制 | `ulimit -u` / `pid_max` 超限 |

**StackOverflowError 的识别**：

| 维度 | 特征 |
|------|------|
| 报错信息 | `java.lang.StackOverflowError` |
| 堆使用率 | 正常 |
| jstack | 单线程栈深度异常深（如 1w+ 帧） |
| 业务代码 | 递归无终止 / 互相递归 / JSON 循环引用 |

**架构师经验**：

1. **Thread OOM 不是堆问题**：调 `-Xmx` 没用，要调 `ulimit -u` / 减线程数 / 减 `-Xss`
2. **JDK 21+ 用虚拟线程**：`Thread.ofVirtual()`，百万级并发不爆
3. **StackOverflow 要看栈顶**：jstack 看栈顶方法，识别是哪个递归
4. **JSON 循环引用**：用 `@JsonIgnore` 打破循环

**生产实战 - Thread OOM 排查清单**：

```
□ jstack 看线程数：jstack -l PID | grep "java.lang.Thread.State" | wc -l
□ 看线程数趋势：Prometheus jvm_threads_states_threads 是否持续涨
□ 看 OS 限制：ulimit -u / cat /proc/<pid>/status | grep Threads
□ 业务代码 grep "new Thread" 是否用线程池
□ 业务代码 grep "Executors.newCachedThreadPool" 是否无上限
□ -Xss 设了多少？是否可以减到 256k
□ 是否可以改用 NIO（少线程多连接）
□ 是否可以升级 JDK 21+ 用虚拟线程
```

---

## 三、生产事故排查的方法论

### 3.1 5 分钟定位法（OOM 版）

**架构师视角的"5 分钟"不是死规定，而是节奏感**：

```
0:00-0:30  现象确认 - 看监控告警、确认 OOM 类型
0:30-1:00  止损决策 - 摘流量 / 限流 / 重启
1:00-2:00  抓现场 - dump + GC 日志 + jstack + NMT
2:00-3:00  GC 日志分类 - 频繁 Minor / Mixed 慢 / Full 失败
3:00-4:00  MAT 分析 - Dominator Tree + Path to GC Roots
4:00-5:00  根因止血 - 清缓存 / 修复代码 / 扩容
```

**关键节奏点**：

1. **30 秒确认 OOM 类型**：看报错信息，识别是堆 / Metaspace / Direct / Thread
2. **1 分钟内止损**：止损优先于定位，避免故障扩大
3. **2 分钟内抓现场**：现场一旦丢失就难再抓
4. **3 分钟内 GC 日志分类**：从 GC 日志判断是泄漏 / 大对象 / 配置 / 流量
5. **4 分钟内 MAT 找元凶**：Dominator Tree Top 1 + Path to GC Roots
6. **5 分钟内止血**：哪怕没定位根因，也要止血（清缓存 / 重启 / 限流）

**与 Day02 工具链的协同**：

| 节奏 | Day02 工具 | Day03 OOM 排查 |
|------|----------|--------------|
| 0:00-0:30 | Prometheus + Grafana | 看 OOM 类型 + 影响范围 |
| 0:30-1:00 | Nacos 摘节点 + Sentinel 限流 | 止损决策 |
| 1:00-2:00 | jstack + jmap + jcmd + Arthas | 抓 dump + jstack + GC 日志 + NMT |
| 2:00-3:00 | GC 日志分析（GCViewer / gceasy.io） | GC 日志分类元凶 |
| 3:00-4:00 | MAT Dominator Tree + OQL | 找 Retained Top 1 + Path to GC Roots |
| 4:00-5:00 | Arthas ognl / redefine | 清缓存 / 改字段 / 热修复 |

### 3.2 止损决策树（OOM 版）

**架构师视角的止损不是"无脑重启"**：

```
OOM 发生
   │
   ▼
是否已自动重启？
   ├─ 是（K8s 已重启新 Pod）
   │   ├─ 新 Pod 健康？-> 流量切到新 Pod，旧 Pod 抓现场
   │   └─ 新 Pod 也 OOM？-> 集群性问题，紧急扩容
   │
   └─ 否（JVM 抛 OOM 但进程未死）
       │
       ▼
   是否有其他 Pod 接流量？
       ├─ 是 -> 摘流量 + 抓现场
       └─ 否 -> 紧急扩容 + 抓现场 + 重启
   │
   ▼
是否抓到 dump？
   ├─ 是 -> MAT 分析
   └─ 否 -> 等下次 OOM（确认 -XX:+HeapDumpOnOutOfMemoryError 已开）
```

**关键认知**：

1. **止损不等于重启**：摘流量、限流、降级都是止损手段
2. **现场优先**：能摘流量就摘流量，不要直接重启
3. **OOM 自动 dump 是救命配置**：没开的话，事故都难复盘
4. **集群性问题要扩容**：3 个 Pod 都 OOM，可能是流量突增或上游异常重试

### 3.3 根因定位的层次（OOM 版）

**架构师视角的根因不是"找到对象"**：

```
层次 1：现象 - 服务 OOM 重启
        │
        ▼
层次 2：直接原因 - 堆 6GB 用满，Full GC 后 Old 不降
        │
        ▼
层次 3：表层根因 - ReportTaskManager.taskMap 累积 280w ReportTask（3.7GB）
        │
        ▼
层次 4：代码根因 - retry() 方法新建 ReportTask 而非复用，taskMap 只增不减
        │
        ▼
层次 5：流程根因 - Code Review 未检查 Map 缓存配置
        │
        ▼
层次 6：体系根因 - 缺乏缓存配置规范、缺乏缓存大小监控
```

**架构师经验**：

1. **找到对象 ≠ 找到根因**：MAT 看到 3.7GB ReportTask 只是"表层根因"
2. **真正的根因在流程和体系**：Code Review 漏了、监控告警没加、规范没立
3. **复盘必须挖到层次 5-6**：否则同类问题会再发生
4. **改进项要可执行**：不要写"加强 Code Review"，要写"Map 上限检查加入 Checklist 第 5 项"

### 3.4 故障复盘的标准模板（OOM 版）

**架构师视角的复盘不是"出文档"，是"沉淀知识"**：

```
# 故障复盘 - 2026-08-05 监管上报服务 OOM

## 1. 时间线
- 14:25 - 堆使用率开始上涨
- 14:32 - OOM 重启，自动 dump 4.5GB
- 14:35 - 摘流量 + 抓现场
- 14:40 - MAT 分析：ReportTaskManager.taskMap 3.7GB
- 14:50 - 清空 taskMap 止血
- 15:00 - PR #1234 修复 retry 复用逻辑
- 15:30 - 灰度发布
- 16:00 - 全量恢复

## 2. 影响范围
- 业务：监管上报失败 200 条，需要人工补录
- 数据：无数据丢失（任务持久化到 DB）
- 资金：无直接损失，间接影响订单转化率 5%

## 3. 根因（5 层）
- 现象：服务 OOM 重启
- 直接原因：堆 6GB 用满
- 表层根因：taskMap 累积 280w ReportTask
- 代码根因：retry() 新建 ReportTask 而非复用
- 流程根因：Code Review 未检查 Map 配置
- 体系根因：缺乏缓存配置规范、缺乏缓存大小监控

## 4. 改进项
| 改进项 | 负责人 | 截止日期 | 状态 |
|--------|--------|---------|------|
| 修复 retry 复用逻辑 | 张三 | 2026-08-05 | 完成 |
| 全量排查 Map 缓存 | 李四 | 2026-08-10 | 完成 |
| 加缓存大小监控告警 | 王五 | 2026-08-12 | 完成 |
| Code Review Checklist 更新 | 钱七 | 2026-08-08 | 完成 |

## 5. 经验教训
- OOM 自动 dump 配置正确，现场抓到了
- MAT 5 分钟定位元凶，工具链熟练度高
- 但根因是低级错误（重试时新建对象），说明 Code Review 流程有漏洞
```

**架构师经验**：

1. **复盘不追责**：对事不对人，否则团队会隐瞒问题
2. **改进项必须可执行**：要有负责人、截止日期、验收标准
3. **复盘要快**：故障后 24 小时内复盘，时间久了细节忘记
4. **改进项要跟踪**：不能开完会就完事，每月 review 进度

---

## 四、OOM 排查与简历项目的结合

### 4.1 在线问诊系统的 5 个 OOM 场景

**场景 1：IM 网关 10w+ 长连接 ByteBuf 泄漏（Direct Buffer OOM）**

```
现象：IM 网关 RSS 持续涨，从 2GB 涨到 7.5GB（Pod limit 8GB），堆使用率仅 50%
排查：
  1. jcmd PID VM.native_memory summary 看 Internal 涨
  2. Arthas vmtool --action getInstances --className io.netty.buffer.PooledByteBuf 看实例数 100w+
  3. 开 -Dio.netty.leakDetection.level=PARANOID，看日志报泄漏栈
根因：业务代码 ByteBuf 没 release，Netty 检测泄漏循环清理占 CPU
修复：业务代码加 try-finally release
JVM 视角：Direct Buffer OOM，本质是堆外内存泄漏
```

**架构师反思**：
- IM 网关选 Netty 是对的，但 ByteBuf 生命周期管理要规范
- 业务团队培训：ByteBuf 必须 try-finally release
- 监控：Netty 内存池使用率 + Direct Buffer 实例数
- 工具：开启 Netty leak detection 在测试环境（生产 PARANOID 开销大）

**场景 2：视频问诊 RTP 包堆积导致 Full GC（堆 OOM）**

```
现象：视频问诊偶发 Full GC，STW 1.5s，视频卡顿
排查：
  1. jmap dump（摘流量后），MAT 分析
  2. Dominator Tree Top 1: RTPPacketWrapper 数组 3.2GB
  3. Path to GC Roots: VideoStreamSession -> RTPQueue -> 100w RTPPacketWrapper
根因：视频通话结束后 RTPQueue 未 clear，下次通话又累积
修复：通话结束 finally 块加 queue.clear()
JVM 视角：堆 OOM，本质是长生命周期对象未清理
```

**架构师反思**：
- 视频通话业务对象生命周期明确（通话开始到结束），必须有清理逻辑
- 业务架构：通话 Session 设计 close() 方法，确保所有资源释放
- 监控：每个通话的 RTPQueue size 上报 Prometheus
- Code Review：grep "RTPQueue" / "Session" 看是否有清理

**场景 3：监管上报 24h 必达 OOM（堆 OOM）**

```
现象：监管上报服务 OOM 重启，24h 必达任务丢失
排查：
  1. OOM 自动 dump（-XX:+HeapDumpOnOutOfMemoryError）
  2. MAT 分析：ConcurrentHashMap<UUID, ReportTask> 3.7GB
  3. Path to GC Roots: ReportTaskManager -> taskMap -> 280w ReportTask
根因：上报失败重试时，每次都新建 ReportTask 而非复用，Map 无限增长
修复：重试时复用 ReportTask，加 maximumSize 防爆
JVM 视角：堆 OOM，本质是重试逻辑的内存陷阱
```

**架构师反思**：
- 24h 必达任务必须设计内存保护：上限 + 持久化
- 重试逻辑必须复用对象，不能每次新建
- Map 缓存必须用 Caffeine 而非 ConcurrentHashMap
- 监控：cache.estimatedSize() 上报 Prometheus，超阈值告警

**场景 4：问诊订单缓存 100w Key（堆 OOM）**

```
现象：问诊订单服务堆 92%，Full GC 频繁
排查：
  1. jmap -histo:live（已摘流量），看 Top 1 是 OrderEntity
  2. Arthas vmtool 查 Caffeine 实例
  3. ognl 调用 cache.estimatedSize()，发现 100w Key
根因：Caffeine maximumSize 设了 100w（应该 1w），缓存膨胀
修复：Arthas ognl 改 maximumSize（不重启）+ PR 修复
JVM 视角：堆 OOM，本质是缓存配置错误
```

**架构师反思**：
- Caffeine maximumSize 必须与堆大小匹配：1w Key × 4KB = 40MB，100w Key × 4KB = 4GB
- 缓存配置规范：maximumSize + expireAfterWrite 必须配对
- 监控：cache.estimatedSize() 上报 Prometheus
- Code Review：grep "Caffeine.newBuilder" 检查每个缓存的配置

**场景 5：MongoDB 大文档 G1 Humongous（GC 异常 + 潜在 OOM）**

```
现象：监管上报服务 G1 频繁 Humongous Allocation，GC 日志报 Humongous
排查：
  1. GC 日志看 "Humongous Allocation" 频繁
  2. jmap -histo 看 byte[] Top 1
  3. Arthas trace MongoDB 调用，发现读取 5MB 文档
根因：MongoDB 单文档 5MB，超过 G1 Region 大小（默认 4MB）的 50%
修复：
  1. 改 G1HeapRegionSize=8m（让 5MB 不再 Humongous）
  2. 改 MongoDB 查询，只查必要字段（< 1MB）
JVM 视角：G1 Humongous Allocation，本质是大对象触发 GC 异常
```

**架构师反思**：
- G1 Region 大小默认 1-32MB（按堆大小自动选），5MB 文档可能触发 Humongous
- 大文档存储要分片：MongoDB GridFS 或应用层分片
- 查询要投影：只查必要字段，避免全文档加载
- 监控：G1 Humongous Allocation 频率告警

### 4.2 5 个场景的架构师统一视角

| 场景 | OOM 类型 | 根因层次 | 修复方向 |
|------|---------|---------|---------|
| IM ByteBuf 泄漏 | Direct Buffer | 代码 bug + 培训不足 | try-finally release + 团队培训 |
| 视频 RTP 堆积 | 堆 OOM | 业务架构缺清理逻辑 | Session.close() + Code Review |
| 监管上报 OOM | 堆 OOM | 业务架构缺上限保护 | 重试复用 + Caffeine 上限 |
| 问诊订单缓存 | 堆 OOM | 配置错误 | maximumSize 与堆匹配 |
| MongoDB 大文档 | G1 Humongous | 业务架构 + JVM 配置 | 文档分片 + Region 调大 |

**架构师统一视角**：

1. **5 个场景都是"业务架构与 JVM 内存设计协同不足"**：不是单纯的代码 bug
2. **每个场景都需要"业务架构 + JVM 调优 + 监控告警"三层修复**：单层修复必复现
3. **5 个场景对应 5 种 OOM 类型**：Direct Buffer / 堆 OOM / G1 Humongous，覆盖 80% 生产场景
4. **简历项目打磨要点**：每个场景用 STAR 法则结构化，配合监控数据 + MAT 截图

### 4.3 OOM 防治体系建设的架构师 KPI

**架构师不仅要会排查 OOM，还要建设 OOM 防治体系**：

1. **OOM 自动 dump 全覆盖**：所有生产服务开 `-XX:+HeapDumpOnOutOfMemoryError`
2. **Code Review Checklist 落地**：Map 上限 / ThreadLocal remove / 监听器 unregister 必查
3. **静态代码扫描**：SpotBugs / SonarQube 扫描内存泄漏模式
4. **监控告警体系**：堆使用率 / Full GC 频率 / 缓存大小 / Direct Buffer 占用
5. **故障知识库**：每次 OOM 故障沉淀到 wiki，团队共享
6. **定期演练**：每月一次注入内存泄漏，让团队练手

**架构师责任**：

```
OOM 防治体系建设的 KPI：
- OOM 故障定位时长 P50 < 5 分钟
- OOM 故障定位时长 P99 < 15 分钟
- OOM 故障复发率 < 5%（同类问题不重复发生）
- Code Review Checklist 覆盖率 > 90%
- 静态扫描接入率 > 80%
- 监控告警覆盖率 > 95%（关键缓存 / Map / 队列都有监控）
- 演练覆盖率 > 90%（关键服务都演练过）
```

---

## 五、Day03 与整体学习路径的关系

### 5.1 Day03 在 JVM 专题中的位置

```
第 1 周（基础与核心）：
  Day01 内存模型 -> Day02 GC 算法 -> Day03 GC 收集器 -> Day04 类加载 -> Day05 JIT -> Day06 串联 -> Day07 G1 深挖

第 2 周（调优实战与生产排查）：
  Day01 参数全解 -> Day02 工具链实战 -> [Day03 OOM 排查] -> Day04 CPU 飙高排查 -> Day05 在线问诊 JVM 调优案例 -> Day06 故障复盘串联 -> Day07 ZGC 深挖
```

**Day03 的位置意义**：

1. **承上**：Day01 的参数（`-XX:+HeapDumpOnOutOfMemoryError`）+ Day02 的工具链（MAT / jmap / Arthas）是 Day03 的前置
2. **启下**：Day04 CPU 飙高排查与 Day03 OOM 排查是"故障排查双胞胎"，Day05 在线问诊系统调优案例会用到 Day03 的 5 个场景
3. **串联**：Day06 故障复盘方法论会整合 Day03 + Day04，Day07 ZGC 深挖会对比 G1 在 OOM 场景的差异
4. **深挖基础**：Day03 的支配树算法、5 类泄漏模式，是后续实战的"内功"

### 5.2 Day03 与往周专题的呼应

| 往周专题 | 与 Day03 OOM 排查的呼应 |
|---------|----------------------|
| 6月第1周 MySQL | MySQL 大结果集 OOM vs JVM OOM：`SELECT *` 全量加载 vs 流式查询 |
| 6月第2周 Redis | Redis bigKey vs JVM 缓存膨胀：Redis 内存爆 vs JVM 堆爆 |
| 6月第3周 ES | ES Scroll API vs JVM 堆：scroll 上下文堆积 + 客户端全量接收 |
| 6月第4周 限流降级 | Sentinel 黑名单堆积 vs JVM OOM：ClusterNode 累积 |
| 6月第5周 支付 | 支付幂等表无限增长 vs JVM OOM：ConcurrentHashMap 用作幂等表 |
| 7月第1周 医疗 | 医保结算大对象 vs JVM Humongous：1-5MB 结算单触发 G1 Humongous |
| 7月第4周简历项目 | 在线问诊系统 5 个 OOM 场景 |
| 7月第5周 JVM 第1周 | Day07 G1 调优与 Humongous Region 的关系 |

**Day03 与 7月第5周 Day07 G1 深挖的呼应**：

- 7月第5周 Day07 讲 G1 的 Region 结构 + Humongous Allocation 触发条件
- Day03 讲 Humongous Allocation 引发的 OOM 排查（场景 5：MongoDB 大文档）
- 两周内容互补：Day07 是"原理"，Day03 是"实战"

### 5.3 Day03 的能力差距与补足

**作答时发现的能力差距**（详见 `架构师学习-能力差距梳理.md`）：

1. **OOM 类型识别**：8 种 OOM 类型的触发条件 / 修复方向，能否脱口而出（差距2.3 延伸）
2. **MAT 深度**：支配树算法 / OQL / 大 dump 处理（差距2.3）
3. **5 类泄漏模式**：每类模式的典型代码 / 识别清单 / 修复方案（差距2.3 延伸）
4. **5 分钟定位法**：6 个节奏点的关键动作（差距2.6）
5. **GC 日志分析**：从 GC 日志判断 OOM 类型（差距2.5）
6. **与简历项目的结合**：5 个 OOM 场景的 STAR 法则讲述（差距2.10）
7. **OOM 防治体系建设**：Code Review Checklist / 静态扫描 / 监控告警（差距2.8 延伸）

**补足方向**：

1. **每日练 1 个 OOM 类型**：周一堆 OOM / 周二 Metaspace / 周三 Direct Buffer / 周四 Thread / 周五 Stack
2. **MAT 实战**：本地装 MAT，分析 3 个真实 dump 文件
3. **OQL 练习**：写 10 条 OQL 查询，覆盖常见场景
4. **代码审查**：每周 review 5 个业务的缓存配置，找出潜在泄漏
5. **故障演练**：每月一次注入内存泄漏，让团队练手
6. **简历项目打磨**：用 STAR 法则整理 5 个 OOM 案例，配合监控数据 + MAT 截图

---

## 六、Day03 核心要点速查

### 6.1 8 种 OOM 类型速查表

| OOM 类型 | 报错信息 | 修复方向 |
|---------|---------|---------|
| 堆 OOM | `Java heap space` | 找泄漏 / 扩堆 / 减对象 |
| GC Overhead | `GC overhead limit exceeded` | 同堆 OOM（预警） |
| 元空间 OOM | `Metaspace` | 排查动态类生成 / 调大 MaxMetaspaceSize |
| 压缩类空间 OOM | `Compressed class space` | 调大 CompressedClassSpaceSize |
| 直接内存 OOM | `Direct buffer memory` | 排查 ByteBuf 释放 / 调大 MaxDirectMemorySize |
| 线程 OOM | `unable to create new native thread` | 调 ulimit / 减线程数 / 用虚拟线程 |
| 数组 OOM | `Requested array size exceeds VM limit` | 改集合 / 分片 |
| 栈溢出 | `StackOverflowError` | 加 -Xss / 改迭代 |

### 6.2 Heap Dump 5 种方式速查

| 方式 | 命令 | STW | 适用场景 |
|------|------|-----|---------|
| 自动 dump | `-XX:+HeapDumpOnOutOfMemoryError` | 是 | 生产 OOM 自动抓现场 |
| jcmd 主动 | `jcmd PID GC.heap_dump /tmp/x.bin` | 是 | 推荐，主动排查 |
| jmap 主动 | `jmap -dump:format=b,file=heap.bin PID` | 是 | JDK 8 风格 |
| jmap 强制 | `jmap -F -dump:format=b,file=heap.bin PID` | 进程挂起 | 进程假死 |
| Arthas heapdump | `heapdump /tmp/x.bin` | 是 | Arthas 在线排查 |
| 极端情况 | `gcore PID` + `jhsdb jmap --binaryheap` | 是 | 进程完全卡死 |

### 6.3 MAT 4 大视图速查

| 视图 | 作用 | 典型用法 |
|------|------|---------|
| Histogram | 按类统计对象数和大小 | 找"哪类对象最多" |
| Dominator Tree | 按对象引用关系（支配关系）排序 | 找"哪个对象独占最大内存" |
| Leak Suspects | 自动分析疑似泄漏点 | 第一步快速定位 |
| Object Inspector | 查看具体对象的字段值 | 验证猜测 |

### 6.4 Shallow vs Retained 速查

| 维度 | Shallow Size | Retained Size |
|------|--------------|---------------|
| 含义 | 对象自身占用的字节数 | 对象被回收后能释放的总内存 |
| 计算 | 对象头 + 实例字段 | Shallow + 所有仅被该对象支配的对象的 Shallow |
| 典型值 | HashMap 48 字节 | HashMap + 所有 Node + key/value 可能 100MB |
| 找泄漏看哪个 | 不看 | **看 Retained** |

### 6.5 5 类内存泄漏模式速查

| 模式 | 典型代码 | 识别清单 | 修复方案 |
|------|---------|---------|---------|
| 缓存膨胀 | Caffeine / Map 未设上限 | MAT 看缓存类 Retained 大 | 加 maximumSize + expireAfterWrite |
| ThreadLocal 累积 | 线程池下未 remove | MAT 看 ThreadLocalMap 大 | finally 中 remove |
| 监听器未 unregister | 注册了没解注册 | MAT 看事件源持有监听器 | 配对 register/unregister |
| 静态集合无限增长 | static Map 永不清理 | MAT 看 System Class 持有的 Map | 改成有上限的缓存 |
| finalize 队列堆积 | 重写 finalize 方法 | MAT 看 Finalizer 队列大 | 避免 finalize（用 AutoCloseable） |

### 6.6 5 分钟定位法速查

```
0:00-0:30  现象确认 - 看监控告警、确认 OOM 类型
0:30-1:00  止损决策 - 摘流量 / 限流 / 重启
1:00-2:00  抓现场 - dump + GC 日志 + jstack + NMT
2:00-3:00  GC 日志分类 - 频繁 Minor / Mixed 慢 / Full 失败
3:00-4:00  MAT 分析 - Dominator Tree + Path to GC Roots
4:00-5:00  根因止血 - 清缓存 / 修复代码 / 扩容
```

### 6.7 元凶对象速查

| 对象类型 | 典型 Retained | 元凶场景 |
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
| `java.nio.DirectByteBuffer` | 1-4GB | NIO ByteBuf 未 release |

### 6.8 OQL 常用查询速查

```sql
-- 查所有 String
SELECT * FROM java.lang.String

-- 查 Retained > 1MB 的 String
SELECT * FROM java.lang.String s WHERE s.@retainedHeapSize > 1048576

-- 查所有 HashMap 的 size
SELECT s.size FROM java.util.HashMap s

-- 查所有 Caffeine Cache
SELECT * FROM com.github.benmanes.caffeine.cache.BoundedLocalCache

-- 查所有 ClassLoader
SELECT * FROM java.lang.ClassLoader

-- 查所有长度 > 1000 的 ArrayList
SELECT l FROM java.util.ArrayList l WHERE l.size > 1000

-- 按 Retained 降序取前 10
SELECT s, s.@retainedHeapSize FROM java.util.HashMap s 
ORDER BY s.@retainedHeapSize DESC LIMIT 10
```

### 6.9 生产配置速查（OOM 防治）

```bash
# 必备参数（生产模板）
-Xlog:gc*:file=/data/logs/gc.log:time,uptime,level,tags:filecount=10,filesize=50M
-XX:+HeapDumpOnOutOfMemoryError
-XX:HeapDumpPath=/data/dump/
-XX:OnOutOfMemoryError="kill -9 %p"  # 可选：OOM 后自动 kill
-XX:+UseGCOverheadLimit  # 默认开启，不要关
-XX:MaxMetaspaceSize=512m
-XX:MaxDirectMemorySize=2g
-XX:+DisableExplicitGC  # 注意：会让 Direct Buffer 清理失效
-XX:+AlwaysPreTouch

# JFR 持续录制（OOM 黑匣子）
-XX:StartFlightRecording=filename=/data/jfr/continuous.jfr,settings=profile,maxage=1h,maxsize=200M

# K8s 容器感知
-XX:+UseContainerSupport
-XX:InitialRAMPercentage=50
-XX:MaxRAMPercentage=50
```

### 6.10 Code Review Checklist（OOM 防治）

```
□ Caffeine 是否设了 maximumSize？
□ Caffeine 是否设了 expireAfterWrite / expireAfterAccess？
□ maximumSize 与 maximumWeight 是否混淆？
□ ConcurrentHashMap 是否用作缓存但没设上限？
□ ThreadLocal 是否在 finally 中 remove？
□ ThreadLocal 是否用了线程池？
□ 监听器 / Callback 是否在不需要时 unregister？
□ 静态集合（static Map / static List）是否无限增长？
□ 是否重写了 finalize？（应该用 AutoCloseable）
□ 重试逻辑是否复用对象？（避免每次新建）
□ 大对象是否分页 / 流式读取？
□ ByteBuf / Direct ByteBuffer 是否 try-finally release？
□ JSON 序列化是否有循环引用？
□ 递归是否有终止条件？
□ 线程池是否用了 Executors.newCachedThreadPool（无上限）？
```

---

> **Day03 总结**：OOM 排查不是"出事查一下 dump"的临时技能，而是架构师必须建立的体系化能力。从 8 种 OOM 类型识别到 5 种 dump 方式选择，从 MAT 支配树算法到 5 类泄漏模式识别，每个环节都有深度。架构师不仅要会排查 OOM，还要建设 OOM 防治体系（自动 dump + Code Review Checklist + 静态扫描 + 监控告警 + 故障演练）。Day04 进入 CPU 飙高排查实战，与 Day03 OOM 排查是"故障排查双胞胎"，Day03 的工具链与 Day02 的工具链协同使用。
