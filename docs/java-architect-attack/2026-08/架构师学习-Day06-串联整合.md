# Day06：JVM 专题串联整合 - 一次完整的 JVM 故障复盘

> 日期：2026年08月08日（周六）
> 周主题：JVM 专题第 2 周 - 调优实战与生产排查
> 串联日：Day06 - 本周 Day01-Day05 知识点整合

---

## 本周回顾速览

本周 Day01-Day05 完整覆盖了 JVM 调优实战与生产排查的 5 大支柱：

| Day | 主题 | 核心知识点 |
|-----|------|-----------|
| Day01 | JVM 调优参数全解 | 堆 / GC / JIT / 容器化 / -XX 陷阱、参数版本演进、MaxGCPauseMillis 陷阱、指针压缩、容器化 cgroup、生产配置模板 |
| Day02 | JVM 诊断工具链实战 | jps/jstat/jmap/jstack/jcmd + Arthas + MAT + async-profiler + JFR + GC 日志、K8s 容器内工具链 |
| Day03 | OOM 排查实战 | 8 种 OOM 类型 / 5 种 dump 方式 / MAT 支配树 / 5 类泄漏模式 / 5 分钟定位 / 大 dump 处理 |
| Day04 | CPU 飙高排查实战 | 6 种 CPU 高类型 / 5 步法 / async-profiler 4 模式 / JIT 退优化 / Safepoint / 工具副作用 |
| Day05 | 在线问诊系统 JVM 实战 | 5 个 STAR 案例（IM 网关 ByteBuf OOM / 视频 RTP 包堆积 / 监管上报 Map OOM / 问诊订单缓存膨胀 / MongoDB 大文档 Humongous）+ JVM 调优参数模板 + 业务架构协同 |

**本周因果链**：

```
参数视角（Day01）：JVM 怎么配
   ↓ 参数配错会出问题
工具视角（Day02）：出了问题怎么排查
   ↓ 排查的两大维度
内存视角（Day03）：OOM 排查（堆 / Direct / Metaspace）
   ↓
CPU 视角（Day04）：CPU 飙高排查（业务 / GC / JIT / 锁）
   ↓ 工具 + 方法论用到真实业务
实战视角（Day05）：在线问诊系统 5 个 STAR 案例
   ↓ 5 个案例需要统一的复盘方法论
复盘视角（Day06）：一次完整的 JVM 故障复盘（从告警到根因到修复到复盘）
```

5 视角合一形成"JVM 故障排查全链路"：**参数配错 -> 监控告警 -> 工具链排查 -> 内存 / CPU 维度定位 -> 根因修复 -> 复盘改进**。这 6 个环节缺一不可，任何一个环节不到位，下次同类故障还会重演。

Day06 不走多场景分选模式。本周五天学完之后，最能"一次性把所有知识点用上"的场景，不是单个故障的排查，而是**一次完整的 JVM 故障复盘**——这是架构师视角才能真正驾驭的能力：既要把 Day01-Day05 的工具链与方法论串成闭环，又要把"故障时间线 / 根因 6 层次 / 复盘模板 / 改进项跟踪"完整跑通，还要兼顾"5 分钟止血 / 1 小时根因 / 24 小时修复 / 1 周预防体系"的时间节奏，最后产出可以团队复用的故障复盘 SOP。

---

## 场景选择：一次完整的 JVM 故障复盘

### 为什么选这个场景

全链路场景一次性用到本周全部知识点：

```text
Day01：JVM 调优参数            -> 故障复盘要回看"参数是否合理"
Day02：JVM 诊断工具链          -> 故障复盘要回看"工具链是否完备"
Day03：OOM 排查                -> 故障复盘要回看"内存维度排查是否到位"
Day04：CPU 飙高排查            -> 故障复盘要回看"CPU 维度排查是否到位"
Day05：在线问诊系统 JVM 实战   -> 故障复盘要回看"5 个 STAR 案例的根因模式"
```

如果只看单个故障的排查，会错过"故障复盘方法论"这个架构师核心命题。特别是"根因 6 层次"、"5 分钟止血 vs 24 小时根因修复的时间节奏"、"改进项跟踪闭环"等内容，单个故障排查根本无法覆盖，必须从"复盘"视角才能完整训练。

### 业务背景

```text
啄木鸟云健康 2026 年 Q1 某日 14:30：

故障服务：在线问诊系统 - 监管上报服务
故障等级：P1（核心业务受影响，医疗合规风险）
故障时长：1 小时 15 分钟（14:30 - 15:45）
业务影响：
  - 监管上报堆积 8 万条
  - 3 条上报超 24h 必达，需向监管机构说明
  - 问诊订单创建连锁延迟（依赖监管上报回调）
  - 间接影响：医师接诊时延 P95 从 30min 涨到 50min

服务现状：
  - 部署：K8s 2 副本，每副本 4 core CPU / 8GB 内存
  - 框架：Spring Boot 2.7 + Kafka Client + OkHttp + JDK 8u362
  - 业务规模：日均 13w 上报，Kafka 消费 1300 QPS
  - SLA：24h 必达，幂等率 100%

故障前一周变更：
  - 周一：上线"医保目录 3.0"扩容（新增 5000 条规则，规则总数 3w -> 3.5w）
  - 周二：K8s 升级 1.26 -> 1.27（cgroup v2 默认开启）
  - 周三：JVM 参数调整（-Xmx 4g -> 6g）
  - 周四：Kafka 消费者扩容（5 -> 8 个 consumer）
  - 周五（故障日）：无变更
```

**为什么选这个故障做复盘**：

1. **故障现象复杂**：同时存在 OOM + CPU 高 + GC 频繁 + K8s OOMKilled 多种现象，需要 Day03 + Day04 协同排查
2. **根因跨多层**：业务代码 + JVM 参数 + K8s cgroup + Kafka 消费者配置 + 上线变更，需要根因 6 层次分析
3. **时间节奏典型**：5 分钟止血 + 30 分钟定位 + 1 小时根因 + 24 小时修复 + 1 周预防体系，覆盖完整节奏
4. **与 Day05 案例三呼应**：Day05 案例三是"监管上报 Map 累积 OOM"，本案例是同一服务的更复杂故障，可以对比学习
5. **架构师视角**：单看代码根因不够，必须从"变更管理 / 监控告警 / 容量规划 / 故障演练"4 个体系维度复盘

---

## 第一部分：故障时间线（5 分钟节奏点）

### 1.1 时间线总览

```text
故障时间线（14:30 - 15:45，共 1 小时 15 分钟）：

阶段 1：故障发生与发现（14:30 - 14:35，5 分钟）
  14:30:00  监控告警：regulator-report Heap 使用率 85%（P2 告警）
  14:30:30  监控告警：regulator-report Heap 使用率 92%（P1 告警 + 主动 dump 触发）
  14:31:00  K8s 自动重启 Pod（OOMKilled）
  14:31:30  重启后 5 分钟再次 OOM
  14:32:00  连续 3 次 OOM，K8s CrashLoopBackOff
  14:33:00  SRE 介入：摘流量 + 扩容 +2 Pod
  14:35:00  服务部分恢复，但仍有 GC 频繁告警

阶段 2：5 分钟止血（14:35 - 14:40）
  14:35:00  oncall 工程师到达，开始排查
  14:35:30  看监控：Heap 6GB 涨满，GC 频繁，CPU 90%
  14:36:00  看自动 dump 文件：4.2GB，已上传 OSS
  14:36:30  决策：先扩容 + 限流，不回滚（变更已 4 天，回滚风险高）
  14:37:00  Kafka 消费限流（max.poll.records 500 -> 100）
  14:38:00  Arthas 主动清理业务 Map
  14:39:00  Heap 稳定 3GB，GC 频率恢复正常
  14:40:00  止血完成，开始根因定位

阶段 3：根因定位（14:40 - 15:00，20 分钟）
  14:40:00  开始 MAT 分析自动 dump（4.2GB）
  14:42:00  MAT Leak Suspects：4500 个 ConcurrentHashMap 占 4.5GB
  14:44:00  Dominator Tree：taskMap 2.5GB / retryMap 1.5GB / idempotentMap 500MB
  14:46:00  OQL 查询：reportId = UUID + timestamp，每次重试新建
  14:48:00  Arthas vmtool 确认：5000 个 ReportTask 实例（应该 < 100）
  14:50:00  代码定位：ReportTaskManager.onReportFailed 重试时新建 ReportTask
  14:52:00  与 Day05 案例三对比：同一个 Bug，但本案例还有其他因素
  14:55:00  发现额外问题：JVM 参数 -Xmx 6g 但 K8s limit 8GB，Direct + Metaspace 不够
  14:58:00  发现 K8s cgroup v2 兼容问题：JDK 8u362 在 cgroup v2 下 CPU 限制识别不准
  15:00:00  根因定位完成：5 层根因（代码 + 配置 + JVM + K8s + 变更管理）

阶段 4：根因修复（15:00 - 15:30，30 分钟）
  15:00:00  PR 1：修复 ReportTask 复用（不再新建）
  15:05:00  PR 2：用 Caffeine 替代 ConcurrentHashMap
  15:10:00  PR 3：幂等 Map 用 Redis 替代 JVM Map
  15:15:00  PR 4：JVM 参数调整（-Xmx 5g，留 3GB 给 Direct + Metaspace + JVM 自身）
  15:20:00  PR 5：升级 JDK 8u362 -> 8u382（修复 cgroup v2 兼容）
  15:25:00  PR 6：Kafka 消费者配置（max.poll.records 100 + fetch.max.bytes 10MB）
  15:30:00  修复完成，开始灰度发布

阶段 5：灰度发布与验证（15:30 - 15:45，15 分钟）
  15:30:00  灰度 1 个 Pod（10% 流量）
  15:33:00  观察 3 分钟，Heap 稳定 1.5GB，GC 正常
  15:36:00  灰度 3 个 Pod（30% 流量）
  15:39:00  观察 3 分钟，无异常
  15:42:00  全量发布（5 个 Pod）
  15:45:00  故障结束，业务全量恢复

阶段 6：复盘与改进（次日 + 1 周）
  次日 10:00  故障复盘会（团队 + 架构师 + SRE）
  次日 12:00  产出复盘文档
  1 周内      完成所有改进项
  1 周后      故障演练验证
```

### 1.2 关键决策点

```text
决策点 1：14:31 K8s 自动重启 vs 主动摘流量
  - 实际：K8s 自动重启（Pod OOMKilled）
  - 问题：自动重启丢失了第一现场（部分栈信息）
  - 改进：80% Heap 主动 dump + 95% 主动摘流量，不让 K8s 自动重启

决策点 2：14:33 摘流量 vs 回滚
  - 实际：摘流量 + 扩容（不回滚）
  - 理由：变更已 4 天（周一上线，周五故障），回滚风险高
  - 改进：变更后 24 小时内故障优先回滚，超过 24 小时优先摘流量

决策点 3：14:36 先看 dump vs 先看代码
  - 实际：先看 dump（MAT 分析）
  - 理由：代码改动 4 天前，看不出新问题
  - 改进：先 dump 分析找元凶，再反推代码

决策点 4：14:50 修复代码 vs 临时调参
  - 实际：先临时调参（Kafka 限流 + Arthas 清理 Map），再修复代码
  - 理由：临时调参 5 分钟止血，代码修复需要 30 分钟
  - 改进：止血用临时调参，根因用代码修复

决策点 5：15:00 修复多个 PR vs 一个大 PR
  - 实际：6 个独立 PR（代码 + 配置 + JVM + K8s + Kafka + JDK 升级）
  - 理由：分层修复，独立灰度
  - 改进：根因修复要分多个 PR，避免一个大 PR 引入新风险
```

### 1.3 时间节奏的架构师视角

```text
5 分钟止血（黄金时间）：
  - 0-1 分钟：现象确认（Heap / Direct / Metaspace / RSS 哪个高）
  - 1-2 分钟：止损决策（重启 / 摘流量 / 限流 / 降级）
  - 2-3 分钟：抓现场（dump + GC 日志 + jstack）
  - 3-4 分钟：临时止血（扩容 + 限流 + Arthas 清理）
  - 4-5 分钟：稳定确认（监控指标回归正常）

30 分钟根因（白银时间）：
  - 5-10 分钟：MAT 分析 dump（Leak Suspects + Dominator Tree + OQL）
  - 10-15 分钟：Arthas vmtool 验证假设
  - 15-20 分钟：代码定位（结合 Allocation Record）
  - 20-25 分钟：根因 6 层次分析（代码 / 配置 / JVM / K8s / 变更 / 体系）
  - 25-30 分钟：根因确认 + 修复方案设计

1 小时修复（青铜时间）：
  - 30-50 分钟：写代码 + Code Review
  - 50-60 分钟：测试环境验证

24 小时预防（钻石时间）：
  - 当天：灰度发布 + 监控验证
  - 次日：复盘会 + 改进项排期
  - 1 周内：完成所有改进项
  - 1 周后：故障演练验证
```

---

## 第二部分：根因 6 层次分析

### 2.1 根因 6 层次模型

```text
架构师视角的根因 6 层次：

第 1 层：现象根因（What happened）
  - K8s OOMKilled
  - Heap 6GB 涨满
  - GC 频繁
  -> 这只是现象，不是根因

第 2 层：直接根因（Direct cause）
  - ReportTaskManager 的 3 个 Map 累积
  - taskMap 2.5GB / retryMap 1.5GB / idempotentMap 500MB
  -> 这是最直接的代码问题

第 3 层：代码根因（Code root cause）
  - onReportFailed 重试时新建 ReportTask（newReportId = UUID + timestamp）
  - 没有 maximumSize / TTL / 清理机制
  -> 这是代码层面的 Bug

第 4 层：配置根因（Configuration root cause）
  - JVM 参数：-Xmx 6g 但 K8s limit 8GB，Direct + Metaspace + JVM 自身只剩 2GB
  - Kafka 参数：max.poll.records 500（默认）太大，OOM 后重启再次冲击
  - K8s cgroup v2：JDK 8u362 在 cgroup v2 下 CPU 限制识别不准
  -> 这是配置层面的问题

第 5 层：流程根因（Process root cause）
  - 变更管理：周一上线"医保目录 3.0"扩容 5000 条规则，但没评估 JVM 影响
  - 监控告警：80% Heap 告警但没主动 dump，95% 才主动 dump（已 OOM）
  - Code Review：5 类泄漏模式 Checklist 没有覆盖"静态 Map + UUID key"模式
  -> 这是流程层面的问题

第 6 层：体系根因（Systemic root cause）
  - 团队能力：JVM 调优能力不足（依赖 SRE 排查，研发不会用 MAT）
  - 工具链体系：没搭建 JFR 持续录制 + Arthas sidecar 体系
  - 故障演练：没定期演练内存泄漏，团队不熟练
  - 容量规划：没建立 K8s limit / JVM Heap / Direct / Metaspace 全局配比模板
  -> 这是体系层面的问题
```

### 2.2 本案例的根因 6 层次详细分析

#### 第 1 层：现象根因

```text
故障现象（监控数据）：
  - K8s：Pod OOMKilled 3 次，CrashLoopBackOff
  - JVM Heap：6GB 涨满（-Xmx 6g）
  - GC：Full GC 持续 4 分钟，回收不下来
  - CPU：90%+（GC Thread 占 60%）
  - 业务：监管上报堆积 8 万条，3 条超 24h 必达

监控盲区：
  - Direct Memory：未监控（但本案例 Direct 才 200MB，不是元凶）
  - Metaspace：未监控（但本案例 Metaspace 才 100MB，不是元凶）
  - RSS：监控了但没告警（RSS 7.5GB 接近 limit 8GB 时应该告警）

教训：
  - 现象根因只是"症状"，不是"病因"
  - 但症状的准确捕捉是排查的起点
  - 4 维度监控（Heap / Direct / Metaspace / RSS）缺一不可
```

#### 第 2 层：直接根因

```text
直接根因（MAT 分析）：
  - 4500 个 ConcurrentHashMap 实例
  - 占用 4.5GB Heap（87.5%）
  - 其中：
    - ReportTaskManager.taskMap：2.5GB
    - ReportTaskManager.retryMap：1.5GB
    - ReportTaskManager.idempotentMap：500MB

MAT Dominator Tree：
  java.util.concurrent.ConcurrentHashMap
    ├── ReportTaskManager.taskMap (2.5GB)
    │     └── ConcurrentHashMap$Node × 1500w（key=String, value=ReportTask）
    ├── ReportTaskManager.retryMap (1.5GB)
    │     └── ConcurrentHashMap$Node × 800w
    └── ReportTaskManager.idempotentMap (500MB)
          └── ConcurrentHashMap$Node × 200w

OQL 查询 key 模式：
  SELECT s.key.toString() FROM java.util.concurrent.ConcurrentHashMap$Node s
  WHERE s.@retainedHeapSize > 1000000
  -> key = "uuid_2026-01-15T14:30:00.123"
  -> 每次重试都新建 UUID + timestamp，老的没清理

教训：
  - MAT Dominator Tree 是定位"Retained Top 1 元凶"的利器
  - OQL 是查特定模式对象的利器
  - 直接根因往往在 Dominator Tree Top 3 内
```

#### 第 3 层：代码根因

```java
// ReportTaskManager - 代码根因
public class ReportTaskManager {
    
    // Bug 1：3 个静态 Map，无限增长
    private static final Map<String, ReportTask> taskMap = new ConcurrentHashMap<>();
    private static final Map<String, ReportTask> retryMap = new ConcurrentHashMap<>();
    private static final Map<String, Boolean> idempotentMap = new ConcurrentHashMap<>();
    
    public void submitReport(ReportData data) {
        // Bug 2：每次都新建 reportId（UUID），不复用
        String reportId = UUID.randomUUID().toString() + "_" + System.currentTimeMillis();
        // 应该：String reportId = data.getOrderId() + "_" + data.getReportType();
        
        ReportTask task = new ReportTask(data, reportId);
        taskMap.put(reportId, task);
        
        // Bug 3：幂等检查用 reportId（应该用业务 ID）
        if (!idempotentMap.containsKey(reportId)) {
            idempotentMap.put(reportId, true);
            executeTask(task);
        }
    }
    
    public void onReportFailed(String reportId, Exception e) {
        // Bug 4：失败重试时新建 ReportTask 而非复用
        ReportTask oldTask = taskMap.get(reportId);
        String newReportId = UUID.randomUUID().toString() + "_" + System.currentTimeMillis();
        ReportTask retryTask = new ReportTask(oldTask.getData(), newReportId);
        retryMap.put(newReportId, retryTask);
        // ↑ 老的 taskMap.get(reportId) 没 remove
        
        // Bug 5：没有 TTL，没有 maximumSize，没有清理机制
    }
    
    public void onReportSuccess(String reportId) {
        taskMap.remove(reportId);
        // ↑ 成功时移除，但 retryMap 没 remove
        // 失败重试后的 retryMap 永远不清理
    }
}
```

```text
代码根因 5 个 Bug：
  Bug 1：3 个静态 Map，无限增长
  Bug 2：每次新建 UUID 作 reportId
  Bug 3：幂等检查用 reportId（应该用业务 ID）
  Bug 4：失败重试时新建 ReportTask 而非复用
  Bug 5：没有 TTL / maximumSize / 清理机制

5 类泄漏模式识别：
  本案例命中"静态集合无限增长"模式
  - 识别清单：
    - 是否是 static Map / List？是
    - 是否设了 maximumSize？否
    - 是否设了 TTL？否
    - 是否有定期清理？否
    - 业务成功 / 失败时是否 remove？部分（成功时 remove taskMap，但 retryMap 没 remove）

教训：
  - 代码根因往往有多个 Bug 叠加
  - 5 类泄漏模式 Checklist 必须背熟
  - Code Review Checklist 第一条："所有静态 Map / List 必须用 Caffeine + maximumSize + TTL"
```

#### 第 4 层：配置根因

```text
配置根因 1：JVM 参数配比不合理
  - K8s limit 8GB
  - JVM Heap 6GB（75%）
  - 剩余 2GB 给 Direct + Metaspace + JVM 自身
  - 实际占用：
    - Direct Memory：200MB（Netty 客户端）
    - Metaspace：100MB
    - JVM 自身：1GB（Code Cache + Thread Stack + GC 日志）
    - 合计：1.3GB
  - 理论上够用，但 buffer 只有 700MB
  - 当 Heap 涨满 + GC 频繁时，JVM 自身开销增加，触发 OOMKilled

  改进：Heap 5GB（62.5%），留 3GB 给其他

配置根因 2：Kafka 消费者参数不合理
  - max.poll.records 500（默认）
  - fetch.max.bytes 50MB（默认）
  - OOM 重启后，Kafka 消费者会"狂吃"消息，再次冲击 JVM
  - 改进：max.poll.records 100 + fetch.max.bytes 10MB

配置根因 3：K8s cgroup v2 兼容问题
  - JDK 8u362 在 cgroup v2 下 CPU 限制识别不准
  - 实际 CPU 限制 4 core，但 JVM 识别为 8 core（宿主机 CPU）
  - ParallelGCThreads 设置过多，GC 线程抢占业务 CPU
  - 改进：升级 JDK 8u382（修复 cgroup v2 兼容）

教训：
  - 配置根因往往跨多个层面（JVM + Kafka + K8s）
  - JVM 参数与 K8s limit 的配比要有 buffer
  - JDK 版本与 K8s 版本要兼容（cgroup v2 是 JDK 8u372+ 才完全支持）
```

#### 第 5 层：流程根因

```text
流程根因 1：变更管理不严
  - 周一上线"医保目录 3.0"扩容 5000 条规则
  - 但没评估 JVM 影响（规则数 3w -> 3.5w，每条规则匹配产生 ReportTask）
  - 上线后 Heap 使用率从 50% 涨到 70%，但没告警
  - 改进：变更评估必须包含 JVM 容量评估

流程根因 2：监控告警阈值不合理
  - 80% Heap P2 告警，但没主动 dump
  - 95% Heap 才主动 dump（已 OOM）
  - 改进：80% 主动 dump + 90% 主动摘流量

流程根因 3：Code Review Checklist 不全
  - 5 类泄漏模式 Checklist 没有覆盖"静态 Map + UUID key"模式
  - Code Review 没识别出"重试时新建对象"反模式
  - 改进：完善 Code Review Checklist，加入"重试复用对象"规则

流程根因 4：变更后观察期不足
  - 周一上线后只观察 24 小时
  - 但内存泄漏很慢（4 天累积），24 小时看不出问题
  - 改进：大变更后观察 7 天，每天对比 JVM 指标趋势

教训：
  - 流程根因往往"看不见摸不着"，但影响最大
  - 变更管理 + 监控告警 + Code Review + 观察期，缺一不可
  - 单次故障的流程根因，往往是多次小问题累积
```

#### 第 6 层：体系根因

```text
体系根因 1：团队 JVM 能力不足
  - 研发不会用 MAT / Arthas，依赖 SRE 排查
  - 排查时长 1 小时+，远超 5 分钟标准
  - 改进：团队 JVM 培训 + 每月演练

体系根因 2：工具链体系不完善
  - 没搭建 JFR 持续录制（看不出对象分配趋势）
  - 没搭建 Arthas sidecar（K8s 内排查困难）
  - 主动 dump 策略不完善（依赖 OOM 触发）
  - 改进：搭建完整工具链体系

体系根因 3：故障演练缺失
  - 没定期演练内存泄漏，团队不熟练
  - 5 分钟止血节奏混乱，决策点不清晰
  - 改进：每月一次故障演练

体系根因 4：容量规划不规范
  - 没建立 K8s limit / JVM Heap / Direct / Metaspace 全局配比模板
  - 凭经验设置，容易 buffer 不足
  - 改进：建立 4 套标准 Pod 配比模板

体系根因 5：知识库不沉淀
  - 5 类泄漏模式 Checklist 不全
  - 故障案例库不完善
  - 改进：建立团队"故障案例库"wiki

教训：
  - 体系根因是"最深的根因"，影响多个故障
  - 体系不完善，同类故障会重演
  - 体系改进需要 1-3 个月，但收益最大
```

### 2.3 根因 6 层次的对应改进

```text
| 根因层次 | 本案例根因 | 改进项 | 完成时间 |
|---------|----------|--------|---------|
| 第 1 层 现象 | OOMKilled + Heap 涨满 | 4 维度监控告警 | 1 周内 |
| 第 2 层 直接 | 3 个 Map 累积 4.5GB | Caffeine + Redis 替代 | 24 小时内 |
| 第 3 层 代码 | 5 个 Bug 叠加 | 修复 5 个 Bug | 24 小时内 |
| 第 4 层 配置 | JVM + Kafka + K8s 配置 | 调整 3 个配置 | 1 周内 |
| 第 5 层 流程 | 变更 + 监控 + Review | 完善 4 个流程 | 1 个月内 |
| 第 6 层 体系 | 能力 + 工具 + 演练 + 容量 + 知识库 | 5 个体系建设 | 3 个月内 |
```

---

## 第三部分：复盘文档模板

### 3.1 复盘文档结构

```markdown
# 故障复盘 - [服务名] [故障类型] [日期]

## 1. 故障概述
- 故障时间：[开始时间] - [结束时间]，共 [时长]
- 故障等级：[P0/P1/P2]
- 业务影响：[影响范围 + 量化数据]
- 故障根因：[一句话总结]

## 2. 时间线
- [时间] [事件]
- [时间] [决策点]
- ...

## 3. 影响范围
- 业务影响：[量化数据]
- 资金影响：[量化数据]
- 用户影响：[量化数据]
- 合规影响：[量化数据]

## 4. 根因分析（6 层次）
### 4.1 现象根因
### 4.2 直接根因
### 4.3 代码根因
### 4.4 配置根因
### 4.5 流程根因
### 4.6 体系根因

## 5. 改进项
| 改进项 | 负责人 | 截止日期 | 状态 |
|--------|--------|---------|------|
| ... | ... | ... | ... |

## 6. 经验教训
- [教训 1]
- [教训 2]
- ...

## 7. 附录
- 监控截图
- GC 日志
- Heap Dump 分析报告
- 代码 PR 链接
```

### 3.2 本案例的复盘文档（示例）

```markdown
# 故障复盘 - 监管上报服务 OOM 2026-01-15

## 1. 故障概述
- 故障时间：2026-01-15 14:30 - 15:45，共 1 小时 15 分钟
- 故障等级：P1
- 业务影响：监管上报堆积 8 万条，3 条超 24h 必达
- 故障根因：ReportTaskManager 3 个静态 Map 无限增长 + JVM 配比不合理 + K8s cgroup v2 兼容问题

## 2. 时间线
（见第一部分 1.1 时间线总览）

## 3. 影响范围
- 业务影响：监管上报堆积 8 万条，3 条超 24h 必达
- 资金影响：无直接资损
- 用户影响：问诊订单创建连锁延迟，医师接诊时延 P95 从 30min 涨到 50min
- 合规影响：医疗合规风险，已向监管机构说明

## 4. 根因分析（6 层次）
（见第二部分 根因 6 层次详细分析）

## 5. 改进项
| 改进项 | 负责人 | 截止日期 | 状态 |
|--------|--------|---------|------|
| 修复 ReportTask 复用（不再新建）| 张三 | 2026-01-16 | 完成 |
| 用 Caffeine 替代 ConcurrentHashMap | 张三 | 2026-01-16 | 完成 |
| 幂等 Map 用 Redis 替代 JVM Map | 李四 | 2026-01-17 | 完成 |
| JVM 参数调整（-Xmx 5g） | 王五 | 2026-01-17 | 完成 |
| 升级 JDK 8u362 -> 8u382 | 王五 | 2026-01-20 | 完成 |
| Kafka 消费者配置 | 赵六 | 2026-01-17 | 完成 |
| 4 维度监控告警 | SRE | 2026-01-22 | 完成 |
| Code Review Checklist 完善 | 架构师 | 2026-01-30 | 进行中 |
| 变更管理流程完善 | PMO | 2026-02-15 | 待开始 |
| 团队 JVM 培训 | 架构师 | 2026-02-28 | 待开始 |
| 工具链体系建设 | SRE | 2026-03-31 | 待开始 |
| 故障演练（每月一次） | SRE | 2026-02-15 | 待开始 |

## 6. 经验教训
- 5 分钟止血节奏要熟练，决策点要清晰
- 根因 6 层次分析要彻底，不能停留在代码层
- 监控告警 4 维度缺一不可（Heap / Direct / Metaspace / RSS）
- 80% Heap 主动 dump，不让 K8s 自动重启丢失现场
- Code Review Checklist 必须包含 5 类泄漏模式
- 变更管理必须评估 JVM 容量影响
- 团队 JVM 能力建设是长期工程

## 7. 附录
（监控截图 / GC 日志 / Heap Dump 分析报告 / 代码 PR 链接）
```

---

## 第四部分：改进项跟踪闭环

### 4.1 改进项分类

```text
改进项按时间紧急度分类：

P0 改进项（24 小时内完成）：
  - 修复代码 Bug（5 个 Bug）
  - JVM 参数调整
  - Kafka 消费者配置

P1 改进项（1 周内完成）：
  - 升级 JDK
  - 4 维度监控告警
  - Caffeine + Redis 替代

P2 改进项（1 个月内完成）：
  - Code Review Checklist 完善
  - 变更管理流程完善
  - 故障演练机制

P3 改进项（3 个月内完成）：
  - 团队 JVM 培训
  - 工具链体系建设
  - 容量规划规范
  - 知识库沉淀
```

### 4.2 改进项跟踪机制

```text
改进项跟踪机制：

1. 复盘会当场认领负责人 + 截止日期
2. 每周例会跟踪进度（5 分钟过一遍）
3. Jira 建单跟踪（标签：故障复盘-2026-01-15）
4. 截止日期前 3 天提醒
5. 逾期需要说明原因 + 重新排期
6. 完成后由架构师 Review 验收
7. 月度统计完成率（目标 90%+）
```

### 4.3 改进项验收标准

```text
代码层改进项验收：
  - PR 已合并
  - 测试环境验证通过
  - 生产灰度发布完成
  - 监控指标回归正常

配置层改进项验收：
  - 配置已更新
  - 文档已更新
  - 团队已通知

流程层改进项验收：
  - 流程文档已更新
  - 团队已培训
  - 下次变更按新流程执行

体系层改进项验收：
  - 体系搭建完成
  - 团队已培训
  - 实战验证（如下次故障演练）
```

---

## 第五部分：5 分钟止血 SOP

### 5.1 5 分钟止血 SOP（生产事故标准操作）

```text
=== 5 分钟止血 SOP ===

第 0-1 分钟：现象确认
  □ 看监控告警，确认故障服务
  □ 看监控指标：Heap / Direct / Metaspace / RSS / CPU
  □ 看业务指标：QPS / RT / 错误率
  □ 判断故障类型：OOM / CPU 高 / GC 频繁 / 死锁 / 死循环

第 1-2 分钟：止损决策
  □ 决策止损方式：
    - 重启（OOMKilled 后 K8s 自动重启）
    - 摘流量（Stop traffic，保留现场）
    - 限流（部分流量保留）
    - 降级（关闭非核心功能）
  □ 决策回滚 / 不回滚：
    - 24 小时内有变更 -> 优先回滚
    - 24 小时前变更 -> 优先摘流量
  □ 通知业务方 + SRE + 架构师

第 2-3 分钟：抓现场
  □ jstack -l PID > /tmp/jstack-$(date +%s).txt
  □ jcmd PID GC.heap_dump /tmp/dump-$(date +%s).hprof
  □ 拷贝 GC 日志 /tmp/gc.log
  □ 拷贝业务日志（最近 1 小时）
  □ 上传到 OSS（避免 Pod 重启丢失）

第 3-4 分钟：临时止血
  □ 扩容（kubectl scale deployment xxx --replicas=N+2）
  □ 限流（Kafka consumer / API gateway / Sentinel）
  □ Arthas 主动清理（ognl 调用业务清理方法）
  □ 临时调参（如 Netty 等级 SIMPLE，Kafka max.poll.records 100）

第 4-5 分钟：稳定确认
  □ 看监控：Heap / CPU / RT 是否回归正常
  □ 看业务：错误率是否下降
  □ 看日志：是否还有 ERROR
  □ 通知业务方：止血完成 / 仍需观察

=== 止血完成，开始根因定位 ===
```

### 5.2 不同故障类型的止血策略

```text
OOM 类故障止血策略：
  - 立即摘流量（避免雪崩）
  - 主动 dump（不依赖 OOM 触发）
  - 扩容 +2 Pod
  - Arthas 清理业务 Map
  - Kafka 限流

CPU 高类故障止血策略：
  - 立即摘流量（避免 CPU 持续高）
  - 抓 jstack + async-profiler 火焰图
  - 扩容 +2 Pod
  - 限流（降低 QPS）
  - 降级（关闭非核心功能）

GC 频繁类故障止血策略：
  - 立即摘流量
  - 抓 GC 日志 + jmap -histo
  - 扩容 +2 Pod（增加 Heap）
  - 临时调参（IHOP / Region）
  - Arthas 清理业务 Map

死锁类故障止血策略：
  - 立即摘流量
  - jstack -l 看死锁
  - 重启 Pod（死锁无法在线解锁）
  - 修复代码后灰度

死循环类故障止血策略：
  - 立即摘流量
  - jstack -l 看栈（连续 3 次同一行）
  - 重启 Pod
  - 修复代码后灰度
```

---

## 第六部分：与 Day01-Day05 的衔接

### 6.1 与 Day01 JVM 调优参数的衔接

```text
Day06 故障复盘用到 Day01 知识点：
  1. JVM 参数配比：-Xmx 6g + K8s 8GB，buffer 不足（改进：5g + 3GB buffer）
  2. -XX:+HeapDumpOnOutOfMemoryError 的局限：依赖 OOM 触发（改进：80% 主动 dump）
  3. -XX:MaxGCPauseMillis 陷阱：设了 100ms 但实际 Full GC 1.5s（参数是"目标"不是"上限"）
  4. -XX:InitiatingHeapOccupancyPercent 调低：45% -> 35%，让并发标记更早启动
  5. -XX:+UseContainerSupport + cgroup v2 兼容：JDK 8u362 不完全兼容，升级 8u382

Day01 是参数视角，Day06 是复盘视角
Day01 关心"怎么配"，Day06 关心"配错了怎么改进"
```

### 6.2 与 Day02 诊断工具链的衔接

```text
Day06 故障复盘用到 Day02 知识点：
  1. jcmd VM.native_memory summary：看 Native 内存构成（本案例 Direct 才 200MB，排除）
  2. jcmd GC.heap_dump：主动 dump（不依赖 OOM 触发）
  3. Arthas heapdump：比 jmap 优越，不触发 Full GC
  4. Arthas vmtool：查 ReportTask 实例数（5000 个，应该 < 100）
  5. Arthas ognl：主动清理业务 Map
  6. MAT Leak Suspects + Dominator Tree + OQL：分析 dump
  7. JFR 持续录制：看对象分配趋势（本案例没搭建，是改进项）

Day02 是工具链视角，Day06 是复盘视角
Day02 关心"怎么用工具"，Day06 关心"工具链是否完备"
```

### 6.3 与 Day03 OOM 排查的衔接

```text
Day06 故障复盘用到 Day03 知识点：
  1. 8 种 OOM 类型识别：本案例是"Java heap space"（heap OOM）
  2. 5 种 dump 方式：本案例用 jcmd GC.heap_dump + Arthas heapdump
  3. MAT 支配树算法：本案例 Dominator Tree 找到 3 个 Map
  4. OQL 查询：本案例查 key 模式，发现 UUID + timestamp
  5. 5 类泄漏模式：本案例命中"静态集合无限增长"模式
  6. 5 分钟定位法：本案例 5 分钟止血 + 30 分钟根因

Day03 是 OOM 排查视角，Day06 是复盘视角
Day03 关心"怎么排查 OOM"，Day06 关心"OOM 排查是否到位 + 怎么改进"
```

### 6.4 与 Day04 CPU 飙高排查的衔接

```text
Day06 故障复盘用到 Day04 知识点：
  1. 6 种 CPU 高类型：本案例是"GC CPU 高"（本质是内存问题）
  2. 5 步法：本案例 top -Hp 看到 4 个 GC Thread 占 60% CPU
  3. async-profiler 火焰图：本案例没用到（GC CPU 高不需要火焰图）
  4. JIT 退优化：本案例没涉及（不是 JIT 问题）
  5. Safepoint：本案例 Full GC 时 Safepoint 1.5s（GC 日志可见）

Day04 是 CPU 排查视角，Day06 是复盘视角
Day04 关心"怎么排查 CPU 高"，Day06 关心"CPU 排查是否到位 + 怎么改进"
```

### 6.5 与 Day05 在线问诊系统 JVM 实战的衔接

```text
Day06 故障复盘与 Day05 案例三的对比：

Day05 案例三（监管上报 Map 累积 OOM）：
  - 单一故障：3 个 Map 累积
  - 单一原因：5 个代码 Bug
  - 单一改进：Caffeine + Redis 替代
  - 排查时长：5 分钟定位 + 30 分钟止血

Day06 案例（监管上报 OOM 复盘）：
  - 复杂故障：OOM + CPU 高 + GC 频繁 + K8s OOMKilled 多种现象
  - 多层原因：代码 + 配置 + JVM + K8s + 变更 + 体系 6 层
  - 多项改进：6 个 PR + 4 个流程 + 5 个体系
  - 排查时长：5 分钟止血 + 30 分钟根因 + 1 小时修复 + 24 小时预防

Day05 是"单个故障的 STAR 故事"，Day06 是"完整复盘方法论"
Day05 关心"怎么排查 + 怎么讲"，Day06 关心"怎么改进 + 怎么预防"
Day05 用于面试讲述，Day06 用于团队复盘
```

---

## 第七部分：架构师视角的故障复盘能力

### 7.1 架构师 vs 工程师的复盘能力对比

| 能力项 | 工程师水平 | 架构师水平 |
|--------|---------|----------|
| 时间节奏 | 5 分钟止血混乱 | 5 个节奏点清晰 |
| 根因分析 | 停留在代码层 | 6 层次彻底分析 |
| 改进项 | 只修复代码 | 代码 + 配置 + 流程 + 体系 |
| 跟踪闭环 | 改完就结束 | 月度统计 + 验收 |
| 知识沉淀 | 个人经验 | 团队 SOP + 案例库 |
| 预防体系 | 单点修复 | 体系建设 |

### 7.2 架构师复盘的 5 个核心能力

```text
能力 1：5 分钟止血的决策力
  - 30 秒判断故障类型
  - 1 分钟做止损决策（重启 / 摘流量 / 限流 / 降级）
  - 1 分钟抓现场（dump + GC 日志 + jstack）
  - 1 分钟临时止血（扩容 + 限流 + Arthas 清理）
  - 1 分钟稳定确认

能力 2：根因 6 层次的分析力
  - 现象根因：监控指标准确捕捉
  - 直接根因：MAT + OQL 定位元凶
  - 代码根因：5 类泄漏模式 + 反模式识别
  - 配置根因：JVM + Kafka + K8s 跨层分析
  - 流程根因：变更管理 + 监控告警 + Code Review
  - 体系根因：能力 + 工具 + 演练 + 容量 + 知识库

能力 3：改进项的分层规划力
  - P0（24 小时）：代码 + 配置
  - P1（1 周）：监控 + 工具链
  - P2（1 个月）：流程 + 演练
  - P3（3 个月）：体系 + 培训

能力 4：改进项的跟踪闭环力
  - 复盘会当场认领
  - 每周例会跟踪
  - 月度统计完成率
  - 架构师 Review 验收

能力 5：知识沉淀的体系力
  - 团队 SOP 文档化
  - 故障案例库 wiki 化
  - Code Review Checklist 持续完善
  - 故障演练定期执行
```

### 7.3 故障复盘的反模式

```text
反模式 1：甩锅式复盘
  - "运维没监控好"
  - "研发代码烂"
  - "SRE 响应慢"
  -> 改进：对事不对人，根因 6 层次分析

反模式 2：浅尝辄止式复盘
  - "代码 Bug 已修复"
  - "监控告警已加"
  -> 改进：深挖到体系根因，避免同类故障重演

反模式 3：改进项不跟踪
  - 复盘会开完就结束
  - 改进项无人认领
  -> 改进：当场认领 + 每周跟踪 + 月度统计

反模式 4：只修代码不修体系
  - 代码 PR 合并就结束
  - 没改进 Code Review Checklist
  - 没改进变更管理流程
  -> 改进：代码 + 配置 + 流程 + 体系 4 层改进

反模式 5：复盘文档不沉淀
  - 复盘文档存个人电脑
  - 团队看不到
  -> 改进：wiki 化 + 团队培训 + 故障案例库
```

---

## 第八部分：能力差距与补足方向

### 8.1 Day06 暴露的能力差距

| 能力项 | 我的水平 | 架构师水平 | 补足方向 |
|--------|---------|----------|---------|
| 5 分钟止血节奏 | 知道思路但不熟练 | 5 个节奏点清晰 | 每月演练 1 次 |
| 根因 6 层次分析 | 停留在代码层 | 6 层次彻底分析 | 每次复盘挖到第 6 层 |
| 改进项分层规划 | 改完代码就结束 | P0/P1/P2/P3 分层 | 整理团队"改进项分层模板" |
| 改进项跟踪闭环 | 改完就结束 | 月度统计 + 验收 | 建立 Jira 跟踪机制 |
| 复盘文档结构 | 凭感觉写 | 标准模板 | 整理团队"复盘文档模板" |
| 故障演练 | 没演练过 | 每月一次 | 搭建混沌工程演练机制 |
| 跨层根因分析 | 只看代码 | JVM + K8s + Kafka 跨层 | 学习 K8s / Kafka 故障排查 |
| 体系化建设 | 单点修复 | 5 个体系建设 | 1-3 个月长期能力建设 |

### 8.2 补足路径

```text
第 2 周剩余补足计划：

Day07（明日）：架构深挖 - ZGC 底层原理
  - 补足差距1.1 / 第5周差距3.2 / 7.7（ZGC / Shenandoah）
  - 染色指针 / 读屏障 / 并发整理 / 分代 ZGC（JDK 21）

第 3 周开始：Service Mesh / 简历项目继续延伸
  - 简历项目延伸：电子处方流转 / 药品配送 / 医保结算
  - 系统设计 / 架构师通用能力专题

长期补足方向（1-3 个月）：
  1. 故障复盘能力建设
    - 每月一次故障演练
    - 整理团队"5 分钟止血 SOP"
    - 整理团队"根因 6 层次模板"
    - 整理团队"复盘文档模板"

  2. 跨层根因分析能力
    - 学习 K8s 故障排查（cgroup / kubelet / etcd）
    - 学习 Kafka 故障排查（consumer lag / rebalance）
    - 学习 MongoDB 故障排查（slow query / lock）

  3. 体系化建设
    - 搭建 JFR 持续录制 + Arthas sidecar 体系
    - 建立 4 套标准 Pod 配比模板
    - 建立团队"故障案例库"wiki
    - 建立团队"Code Review Checklist"
```

---

## 第九部分：本周学习节奏回顾

```text
2026年08月第1周（JVM 专题第 2 周 - 调优实战与生产排查）

Day01（08/03 周一）：JVM 调优参数全解
  - 出题 + 作答 + 梳理
  - 5 个子问题：堆内存 / GC / JIT / 容器化 / -XX 陷阱
  - 发现 7 项差距（1.1-1.7）

Day02（08/04 周二）：JVM 诊断工具链实战
  - 出题 + 作答 + 梳理
  - 5 个子问题：JDK 自带 / Arthas / MAT / jstack+火焰图 / GC 日志
  - 1 个场景题：5 分钟定位 Full GC 元凶
  - 发现 10 项差距（2.1-2.10）

Day03（08/05 周三）：OOM 排查实战
  - 出题 + 作答 + 梳理
  - 5 个子问题：8 种 OOM 类型 / 5 种 dump 方式 / MAT 支配树 / 5 类泄漏模式 / 5 分钟定位
  - 1 个场景题：监管上报服务 OOM 排查（STAR 法则）
  - 发现 8 项差距（3.1-3.8）

Day04（08/06 周四）：CPU 飙高排查实战
  - 出题 + 作答 + 梳理
  - 5 个子问题：6 种 CPU 类型 / 5 步法 / async-profiler 4 模式 / JIT 退优化 / Safepoint
  - 1 个场景题：IM 网关 CPU 95% 排查（STAR 法则）
  - 发现 9 项差距（4.1-4.9）

Day05（08/07 周五，补全）：在线问诊系统 JVM 实战
  - 出题 + 作答 + 梳理
  - 5 个 STAR 案例 + JVM 调优参数模板 + 业务架构协同
  - 产出简历项目延伸文档：在线问诊系统-JVM调优案例.md

Day06（08/08 周六，今日）：串联整合 - 一次完整的 JVM 故障复盘
  - 故障时间线 + 根因 6 层次 + 复盘模板 + 改进项跟踪
  - 5 分钟止血 SOP + 架构师视角的复盘能力

Day07（08/09 周日，明日）：架构深挖 - ZGC 底层原理
  - 染色指针 / 读屏障 / 并发整理 / 分代 ZGC（JDK 21）
```

---

## 第十部分：本周产出汇总

```text
本周产出（2026年08月第1周）：

1. 7 份 JVM 调优实战文档（Day01-Day07）
2. 1 份能力差距梳理文档（按主题组织，标注发现日期）
3. 1 份简历项目延伸文档：在线问诊系统-JVM调优案例.md
   - 5 个 STAR 故事（面试讲述版）
   - JVM 调优参数模板（4 套生产配置）
   - 统一方法论 + 预防体系

累计差距：151+ 项 + 本周新增（Day06 8 项）= 159+ 项

本周关键能力沉淀：
  1. JVM 调优参数全解（7 项能力）
  2. JVM 诊断工具链实战（10 项能力）
  3. OOM 排查实战（8 项能力）
  4. CPU 飙高排查实战（9 项能力）
  5. 在线问诊系统 JVM 实战（5 个 STAR 案例）
  6. JVM 故障复盘方法论（8 项能力）

与简历项目的衔接：
  - 简历项目-在线问诊系统-架构文档.md（已存在）
  - 简历项目-在线问诊系统-技术亮点与难点拆解.md（已存在）
  - 简历项目-在线问诊系统-面试问答预演.md（已存在）
  - 简历项目-在线问诊系统-JVM调优案例.md（本周新增）
  - 简历项目-在线问诊系统-核心模块-医保对接.md（已存在）
  - 简历项目-在线问诊系统-核心模块-处方开具.md（已存在）

形成"架构 -> 难点 -> 面试预演 -> JVM 调优 -> 核心模块"完整闭环
```
