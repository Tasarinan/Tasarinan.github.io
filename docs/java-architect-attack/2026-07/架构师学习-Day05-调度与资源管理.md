# 架构师学习-Day05-调度与资源管理

> 日期：2026年07月24日（周五）
> 周主题：K8s 与云原生专题
> 出题日：Day05 - 调度与资源管理

---

## 背景

Day01 我们打了"K8s 核心架构 + Pod 容器设计模式"两根地基。Day02 我们打了"Workload 编排 + 发布工程"两根支柱。Day03 我们打了"Service 转发原理 + 网络模型"两根支柱。Day04 我们打了"存储卷 + 配置管理"两根支柱。

但到这里我们又刻意回避了一个核心问题：**Pod 到底被调度到哪个节点？谁决策？依据什么？节点资源不够怎么办？关键业务被低优先级任务挤占怎么办？多租户集群怎么避免"吵闹的邻居"？**

为什么 Day05 必须接着讲调度与资源管理：

1. **业务现实**：啄木鸟云健康的智慧体检/公卫平台跑在 K8s 上，会面临一系列调度与资源问题：
   - 体检预约 / 医保结算 / 报告生成 等不同优先级业务混跑在同一集群，怎么保证医保结算不被 PDF 批处理挤占？
   - 多 AZ 集群怎么保证体检核心服务的高可用（单 AZ 故障不能全军覆没）？
   - 医保结算等敏感业务要不要用污点节点做物理隔离？
   - Redis/MySQL 等有状态服务对 IOPS、内存敏感，怎么保证资源独占不被抢？
   - GPU 节点（医疗影像 AI 推理）怎么调度才不浪费？
   - 多租户集群（SaaS 给多家医共体客户）怎么用 ResourceQuota + LimitRange 防止"一家客户跑飞把整个集群拖垮"？
   - 节点资源超卖（overcommit）到什么比例合适？怎么避免雪崩时的 OOM 风暴？

   任何一处调度设计出错，就是节点雪崩 + OOM 风暴 + 业务全挂

2. **承接往周专题**：
   - 微服务专题的"Nacos 服务发现 + 健康检查" -> K8s 的 readinessProbe + Service Endpoints 联动，但 Pod 调度到哪个节点才不影响服务可用性？
   - 限流降级专题的"Sentinel 集群限流 + 自适应限流" -> K8s 的 HPA + ResourceQuota + PriorityClass 联动做"集群级限流与降级"
   - 支付专题的"幂等 + 多可用区容灾" -> K8s 的 Pod 反亲和 + topologySpreadConstraints 保证跨 AZ 高可用
   - Redis 专题的"主从复制 + 哨兵" -> K8s 的 Pod 反亲和避免主从同节点、StatefulSet + 稳定调度
   - MySQL 专题的"读写分离 + 分库分表" -> K8s 的本地盘 + 节点亲和性 + 污点容忍做"专库专节点"
   - ES 专题的"冷热分离 + 节点角色" -> K8s 的节点标签 + nodeAffinity + 污点做"热节点/温节点/冷节点分级调度"
   - 秒杀专题的"流量突增 + 库存扣减" -> K8s 的 PriorityClass + 抢占式调度保证秒杀 Pod 抢占普通 Pod 资源
   - 医疗专题的"医保结算四防闭环" -> K8s 的污点 + NetworkPolicy + PriorityClass 做"敏感业务物理与逻辑双重隔离"

3. **面试高频考点**：调度器架构（Filter/Score/Reserve/Permit/Bind 五阶段）、节点亲和性 vs Pod 亲和性、污点与容忍度（NoSchedule/NoExecute/PreferNoSchedule）、topologySpreadConstraints、Requests/Limits、QoS 三等级（Guaranteed/Burstable/BestEffort）、CPU Throttling、OOMKilled、PriorityClass 与抢占、LimitRange、ResourceQuota、Node Allocatable、Descheduler -- 中高级架构师岗几乎必问

4. **架构师思维跃迁**：从"我会写 nodeSelector"到"我能在 K8s 上设计多 AZ 拓扑分布 + 多租户资源隔离 + 优先级抢占 + 雪崩防护 + 资源配额治理的调度体系，并能在节点故障/OOM 风暴/资源争抢场景下快速定位与止血"

Day05 我们打两根支柱：

- **题目一（架构设计题）**：K8s 调度器与调度约束 -- 解决"调度器怎么决策、亲和性/反亲和性怎么用、污点容忍怎么隔离、topologySpreadConstraints 怎么做拓扑分布、生产场景怎么落地"
- **题目二（架构设计题）**：资源管理与多租户隔离 -- 解决"Requests/Limits 怎么配、QoS 等级怎么选、PriorityClass 抢占怎么工作、LimitRange/ResourceQuota 怎么治理多租户、OOM/CPU Throttling 怎么排查"

---

## 题目一（架构设计题）：K8s 调度器与调度约束工程实战

假设你作为新公司的架构师，把啄木鸟云健康的智慧体检/公卫平台搬到 K8s 上。集群是 3 AZ × 10 节点 = 30 节点的中等规模，节点角色混杂（通用节点 24 台、医保结算专用节点 3 台、GPU 节点 3 台）。平台包含以下需要调度的工作负载：

- 体检预约 Web 服务（无状态，10 副本，要求跨 3 AZ 均匀分布）
- 医保结算服务（敏感业务，3 副本，必须只调度到医保专用节点）
- 体检报告 PDF 批处理（低优先级 Job，可被抢占，尽量利用空闲资源）
- Redis Cluster（6 节点，主从跨 AZ，要求主从不能同节点同 AZ）
- 医疗影像 AI 推理服务（需要 GPU，2 副本，要求 GPU 节点独占）
- Filebeat 日志采集（DaemonSet，每节点一份，但医保节点不能采集医保日志外的数据）

请你回答：

1. K8s 调度器的架构是什么？调度流程的 Filter / Score / Reserve / Permit / Bind 五个阶段分别做什么？为什么调度器是"两阶段（Filter + Score）+ 调度扩展（Scheduler Framework）"的设计？kube-scheduler 的 Leader 选举与多副本机制（默认 Active/Standby）在生产中怎么部署？调度器扩展（Scheduler Framework 的 Plugin 机制）比旧版 Scheduler Extender 优势在哪？
2. 节点亲和性（nodeAffinity）的 `requiredDuringSchedulingIgnoredDuringExecution` / `preferredDuringSchedulingIgnoredDuringExecution` 两类约束的差异？Pod 亲和性（podAffinity）与 Pod 反亲和性（podAntiAffinity）的本质差异？为什么 Pod 亲和性在大集群（>100 节点）会引发性能问题？topologySpreadConstraints 与 podAntiAffinity 在"跨 AZ 分布"场景下应该选哪个？`maxSkew` / `whenUnsatisfiable` / `topologyKey` 三个字段怎么配？
3. 污点（Taints）与容忍度（Tolerations）的 `NoSchedule` / `NoExecute` / `PreferNoSchedule` 三种 effect 的差异？`NoExecute` 加 `tolerationSeconds` 的驱逐行为？为什么"专用节点"要用污点而不是 nodeSelector？控制面节点默认污点（`node-role.kubernetes.io/control-plane:NoSchedule`）的作用？生产中怎么用污点做"医保专用节点 / GPU 专用节点 / 监管专用节点"的物理隔离？
4. PriorityClass 与抢占式调度（Preemption）的工作机制？高优先级 Pod 触发抢占时，调度器怎么选牺牲者（Victim）？抢占发生的"优雅驱逐"（graceful eviction）流程？为什么 PriorityClass 的 `preemptionPolicy: PreemptLowerPriority` 比 `Never` 更常用？生产中怎么设计 4-5 级优先级体系（系统级 / 核心业务 / 普通业务 / 批处理 / BestEffort）？
5. 请为啄木鸟云健康 6 个工作负载分别给出调度约束设计（含 nodeSelector / nodeAffinity / podAffinity / podAntiAffinity / topologySpreadConstraints / tolerations / priorityClass），并解释每个选择的工程理由。重点讲清：体检预约的跨 3 AZ 均匀分布怎么用 topologySpreadConstraints 实现？医保结算的"专用节点 + 物理隔离"怎么用污点 + 容忍 + NetworkPolicy 三件套实现？Redis Cluster 的"主从跨 AZ"怎么用 podAntiAffinity + topologyKey 实现？GPU 节点独占怎么用污点 + 资源声明（nvidia.com/gpu）实现？

### 作答区

#### 1. K8s 调度器架构与五阶段流程

**调度器整体架构**：

```
┌──────────────────────────────────────────────────────────────────┐
│                       kube-scheduler                              │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │  Scheduler Queue (Active Queue / Backoff Queue / Unschedulable)│ │
│  └──────────────────────────────────────────────────────────────┘ │
│                            │                                      │
│                            ▼                                      │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │                  调度流水线（Schedule Pipeline）              │ │
│  │                                                              │ │
│  │   ┌────────────┐  ┌────────────┐  ┌────────────┐            │ │
│  │   │  Filter    │→│   Score    │→│  Reserve    │            │ │
│  │   │ (预选)    │  │ (优选)    │  │  (预留)    │            │ │
│  │   └────────────┘  └────────────┘  └────────────┘            │ │
│  │                                        │                    │ │
│  │                                        ▼                    │ │
│  │   ┌────────────┐  ┌────────────┐  ┌────────────┐            │ │
│  │   │  Permit    │→│  PreBind   │→│   Bind     │            │ │
│  │   │ (许可)    │  │ (预绑定)  │  │  (绑定)    │            │ │
│  │   └────────────┘  └────────────┘  └────────────┘            │ │
│  └──────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
                            │
                            ▼
                    etcd: pod.spec.nodeName
                            │
                            ▼
              kubelet（目标节点）启动容器
```

**五阶段职责**：

| 阶段 | 英文 | 职责 | 失败行为 |
|------|------|------|---------|
| Filter | 预选 | 过滤掉不满足硬性约束的节点（资源不足、污点不容忍、亲和性不匹配） | 节点被淘汰 |
| Score | 优选 | 对通过 Filter 的节点打分（0-100），选最优 | 选最高分 |
| Reserve | 预留 | 在缓存中"预留"资源，避免下个 Pod 调度时重复计算 | 失败回滚 |
| Permit | 许可 | 允许"等待"或"绑定"决策（用于 Volume Binding、Scheduler Framework 扩展） | 可延迟绑定 |
| Bind | 绑定 | 写入 pod.spec.nodeName 到 etcd，通知 kubelet | 失败重试 |

**为什么是"两阶段（Filter + Score）+ 调度扩展"设计**：

1. **职责分离**：Filter 是"硬约束"（必须满足），Score 是"软约束"（越满足越好），分离让调度策略可组合
2. **可扩展性**：Scheduler Framework 把每个阶段暴露为 Plugin，允许第三方扩展（如 GPU 调度、拓扑感知调度、容量调度）
3. **性能优化**：Filter 用短路算法（一旦不满足立即跳过），Score 用加权打分（避免单一指标主导）
4. **可观测性**：每个阶段都有 metrics（schedule_attempts / filter_failure / score_high），便于排查

**Scheduler Framework 的 Plugin 机制 vs 旧版 Scheduler Extender**：

| 维度 | Scheduler Extender（旧） | Scheduler Framework（新，1.19+） |
|------|------------------------|-------------------------------|
| 调用方式 | HTTP API 远程调用 | 进程内函数调用 |
| 性能 | 网络开销大（每 Filter 一次 RPC） | 几乎零开销（函数调用） |
| 扩展点 | 仅 Filter + Score | 11 个扩展点（QueueSort / Filter / Score / Reserve / Permit / PreBind / Bind / PostBind 等） |
| 状态共享 | 难（HTTP 无状态） | 易（Plugin 可共享缓存） |
| 故障隔离 | HTTP 进程隔离 | 进程内崩溃会拖垮调度器 |

**kube-scheduler 的 Leader 选举与多副本**：

- 默认 Active/Standby（多副本但只有一个工作）
- 通过 `coordination.k8s.io/v1 Lease` 资源实现 Leader 选举
- 关键参数：`--leader-elect=true`、`--leader-elect-lease-duration=15s`、`--leader-elect-renew-deadline=10s`、`--leader-elect-retry-period=2s`
- 生产部署：每个 master 节点一个 kube-scheduler 实例，3 master 集群中 1 Active + 2 Standby
- 切换时间窗口：默认 10-15s（Lease 过期 + 重新选举）

**调度器扩展实战建议**：
- 啄木鸟云健康智慧体检平台如有 GPU 调度需求，可用 `nvidia.com/gpu` 资源声明 + Node Allocatable + 污点容忍三件套，不必自研 Plugin
- 如有跨 AZ 严格均匀分布需求，用 `topologySpreadConstraints` 而非自研 Plugin
- 自研 Plugin 仅在"业务强相关调度策略"时才用（如医疗影像 AI 必须调度到带特定型号 GPU 的节点）

#### 2. 节点亲和性 / Pod 亲和性 / topologySpreadConstraints

**nodeAffinity 两类约束**：

```yaml
affinity:
  nodeAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:   # 硬约束（必须满足）
      nodeSelectorTerms:
      - matchExpressions:
        - key: node-role.kubernetes.io/medical
          operator: In
          values: ["true"]
    preferredDuringSchedulingIgnoredDuringExecution:  # 软约束（尽量满足，加分项）
    - weight: 100
      preference:
        matchExpressions:
        - key: topology.kubernetes.io/zone
          operator: In
          values: ["az1"]
```

| 约束类型 | 语义 | 失败行为 | 适用场景 |
|---------|------|---------|---------|
| required | 硬约束，类似 nodeSelector 增强 | Pod Pending | 必须调度到特定节点（医保专用节点） |
| preferred | 软约束，加分项 | 调度到次优节点 | 倾向性调度（优先用 az1，不行用 az2） |

**"IgnoredDuringExecution"的含义**：
- 调度时评估（DuringScheduling）
- 运行时忽略（IgnoredDuringExecution）：节点标签变化后，已运行的 Pod 不会被驱逐
- K8s 1.20+ 引入 `requiredDuringSchedulingRequiredDuringExecution`（实验性），运行时节点标签变化会触发驱逐

**podAffinity vs podAntiAffinity 本质差异**：

```yaml
affinity:
  podAffinity:        # 我要靠近某个 Pod
    requiredDuringSchedulingIgnoredDuringExecution:
    - labelSelector:
        matchLabels:
          app: redis-cache
      topologyKey: kubernetes.io/hostname
  podAntiAffinity:    # 我要远离某个 Pod
    requiredDuringSchedulingIgnoredDuringExecution:
    - labelSelector:
        matchLabels:
          app: redis-cache
      topologyKey: kubernetes.io/hostname
```

| 维度 | podAffinity | podAntiAffinity |
|------|-----------|----------------|
| 语义 | 调度到与目标 Pod 同拓扑域 | 调度到与目标 Pod 不同拓扑域 |
| 用途 | 服务共存（Web + Redis 同节点降低延迟） | 服务打散（Redis 主从不同节点） |
| 风险 | 大集群性能问题 | 大集群性能问题 |

**Pod 亲和性在大集群（>100 节点）的性能问题根因**：

- 调度每个 Pod 时，需要遍历所有节点 × 所有目标 Pod 的拓扑域
- 时间复杂度 O(N×M)，N=节点数，M=目标 Pod 数
- 100 节点 × 1000 个 Redis Pod = 10w 次匹配
- 调度延迟从毫秒级升到秒级

**优化方案**：
- 用 `topologySpreadConstraints` 替代 podAntiAffinity（性能更好）
- 用 `nodeSelector` + 节点标签代替 podAffinity（把"靠近某 Pod"转为"调度到带某标签的节点"）
- 启用 K8s 1.25+ 的 `NodeInclusionPolicy` 优化

**topologySpreadConstraints vs podAntiAffinity**：

| 维度 | topologySpreadConstraints | podAntiAffinity |
|------|--------------------------|----------------|
| 语义 | "跨拓扑域均匀分布" | "远离特定 Pod" |
| 控制粒度 | maxSkew（最大偏差） | 硬性远离 |
| 性能 | O(N) 遍历节点 | O(N×M) 遍历节点 × Pod |
| 灵活度 | whenUnsatisfiable 可选硬/软约束 | required / preferred |
| 推荐场景 | 跨 AZ 均匀分布（首选） | 严格不能同节点（如 Redis 主从） |

**topologySpreadConstraints 三字段配置**：

```yaml
topologySpreadConstraints:
- maxSkew: 1                          # 最大偏差：1
  topologyKey: topology.kubernetes.io/zone  # 按 AZ 拓扑域分布
  whenUnsatisfiable: DoNotSchedule    # 不满足时拒绝调度（硬约束）
  labelSelector:                      # 哪些 Pod 参与统计
    matchLabels:
      app: medical-appointment
```

| 字段 | 含义 | 取值 |
|------|------|------|
| maxSkew | 各拓扑域之间 Pod 数量最大允许偏差 | 1（严格均匀）/ 2（适度容忍） |
| topologyKey | 拓扑域的节点标签 key | kubernetes.io/hostname / topology.kubernetes.io/zone / topology.kubernetes.io/region |
| whenUnsatisfiable | 偏差超过 maxSkew 时的行为 | DoNotSchedule（硬约束）/ ScheduleAnyway（软约束，尽力分布） |

**maxSkew=1 的语义**：
- 3 个 AZ，10 个 Pod
- 理想分布：4/3/3（最大偏差 1）
- 实际调度时，新 Pod 优先调度到 Pod 数最少的 AZ
- 如果调度到某 AZ 后会让偏差 > 1，则拒绝调度

**生产实践**：
- 跨 AZ 高可用：`maxSkew=1, whenUnsatisfiable=DoNotSchedule`
- 跨节点反亲和（避免同节点多副本）：用 `podAntiAffinity` 或 `topologyKey=kubernetes.io/hostname, maxSkew=1`

#### 3. 污点与容忍度

**三种 effect 的差异**：

```bash
# 给节点打污点
kubectl taint nodes az1-worker-medical medical-only=true:NoSchedule
kubectl taint nodes az1-worker-medical medical-only=true:NoExecute
kubectl taint nodes az1-worker-medical medical-only=true:PreferNoSchedule
```

| effect | 语义 | 已运行 Pod 行为 | 新 Pod 行为 |
|--------|------|---------------|-----------|
| NoSchedule | 不调度新 Pod | 不驱逐已运行 Pod | 不能调度（除非容忍） |
| NoExecute | 不调度 + 驱逐已运行 | 驱逐不容忍的 Pod（按 tolerationSeconds 倒计时） | 不能调度（除非容忍） |
| PreferNoSchedule | 尽量不调度 | 不驱逐 | 尽量避免（软约束） |

**NoExecute + tolerationSeconds 的驱逐行为**：

```yaml
tolerations:
- key: "medical-only"
  operator: "Equal"
  value: "true"
  effect: "NoExecute"
  tolerationSeconds: 60    # 容忍 60 秒，之后驱逐
```

- 节点打上 `NoExecute` 污点后，不容忍的 Pod 立即驱逐
- 容忍但设了 `tolerationSeconds=60` 的 Pod，60 秒后驱逐
- 用途：节点故障时给业务"宽限期"完成处理（如医保结算完成在途请求）

**为什么"专用节点"用污点而不是 nodeSelector**：

| 维度 | nodeSelector | 污点 + 容忍 |
|------|-------------|------------|
| 语义 | "我要去这个节点" | "这个节点不欢迎我，但我有特权" |
| 默认行为 | Pod 不写 nodeSelector 就能调度到任何节点 | 节点打污点后，不容忍的 Pod 一律进不来 |
| 隔离强度 | 弱（其他 Pod 也能进来） | 强（其他 Pod 进不来） |
| 反向控制 | 难（需要每个 Pod 都写 nodeSelector） | 易（节点一次性打污点，所有 Pod 默认进不来） |

**控制面节点默认污点**：
- `node-role.kubernetes.io/control-plane:NoSchedule`（K8s 1.24+，旧版 `node-role.kubernetes.io/master:NoSchedule`）
- 防止业务 Pod 调度到控制面节点，避免业务负载影响控制面稳定性
- 仅 kube-proxy / CNI / 监控 Agent 等系统组件容忍

**生产中"专用节点"的物理隔离三件套**：

```yaml
# 1. 节点打污点
kubectl taint nodes az1-worker-medical medical-only=true:NoSchedule
kubectl taint nodes az1-worker-medical medical-only=true:NoExecute

# 2. 节点打标签
kubectl label nodes az1-worker-medical node-role.kubernetes.io/medical=true

# 3. 医保 Pod 同时声明 nodeAffinity + tolerations + NetworkPolicy
spec:
  affinity:
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
        - matchExpressions:
          - key: node-role.kubernetes.io/medical
            operator: In
            values: ["true"]
  tolerations:
  - key: "medical-only"
    operator: "Equal"
    value: "true"
    effect: "NoSchedule"
  - key: "medical-only"
    operator: "Equal"
    value: "true"
    effect: "NoExecute"
```

加 NetworkPolicy 实现"网络层 + 调度层"双重隔离，防止医保 Pod 被同节点其他 Pod 嗅探。

#### 4. PriorityClass 与抢占式调度

**PriorityClass 定义**：

```yaml
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: medical-critical
value: 1000000              # 优先级数值，越大越高
globalDefault: false
description: "医保结算等关键业务"
preemptionPolicy: PreemptLowerPriority   # 默认值，允许抢占低优先级 Pod
```

**抢占式调度（Preemption）的工作机制**：

```
1. 高优先级 Pod 进入调度队列，找不到合适节点（资源不足）
2. 调度器寻找"候选节点"：节点上是否有低优先级 Pod 可以驱逐
3. 在每个候选节点上选择"牺牲者"（Victim）：
   - 优先驱逐优先级最低的 Pod
   - 同优先级按"启动时间最新"原则（先驱逐后启动的）
   - 驱逐总数最小化（尽量少驱逐）
4. 驱逐牺牲者（优雅删除 + grace period）
5. 高优先级 Pod 调度到该节点
```

**牺牲者选择算法**：
- 在所有候选节点中，找"驱逐后能腾出足够资源"的节点
- 在该节点上，按优先级升序选 Pod 作为牺牲者
- 选最少需要驱逐的 Pod 数（"最小驱逐集合"）

**优雅驱逐（Graceful Eviction）流程**：
1. 调度器发起 Preempt，标记牺牲者 `deletionTimestamp`
2. 牺牲者收到 SIGTERM，开始优雅停机
3. kubelet 等待 `terminationGracePeriodSeconds`（默认 30s）
4. 超时后强制 SIGKILL
5. 高优先级 Pod 等待牺牲者完全退出后，Bind 到节点

**preemptionPolicy 两种取值**：

| 取值 | 语义 | 适用场景 |
|------|------|---------|
| PreemptLowerPriority（默认） | 可抢占低优先级 Pod | 关键业务（医保结算、支付） |
| Never | 不抢占，等资源 | 批处理任务（PDF 生成、AI 训练） |

**为什么 PreemptLowerPriority 比 Never 更常用**：
- 关键业务（医保结算）必须立即获得资源，不能等
- 批处理任务（PDF）可以"让位"，反正不急
- 默认值 PreemptLowerPriority 保护关键业务 SLA

**生产 4-5 级优先级体系设计**：

| 优先级 | PriorityClass | value | preemptionPolicy | 典型业务 |
|--------|--------------|-------|------------------|---------|
| P0 系统级 | system-node-critical | 2000000000 | PreemptLowerPriority | CNI / kube-proxy / 监控 Agent |
| P0 系统级 | system-cluster-critical | 1000000000 | PreemptLowerPriority | DNS / Ingress / cert-manager |
| P1 核心业务 | medical-critical | 1000000 | PreemptLowerPriority | 医保结算 / 支付 / 体检预约 |
| P2 普通业务 | medical-normal | 500000 | PreemptLowerPriority | 报告查询 / 用户中心 |
| P3 批处理 | batch-low | 100000 | Never | PDF 批处理 / 数据同步 |
| P4 BestEffort | best-effort | 100 | Never | 实验性任务 |

**注意**：
- 系统级保留 value 在 1000000000+ 范围（K8s 内置）
- 业务级从 1000000 起步，预留空间
- BestEffort 不建议生产使用

#### 5. 啄木鸟云健康 6 个工作负载调度约束设计

**整体节点池设计**：

```bash
# 节点标签
kubectl label nodes az{1,2,3}-worker-{01..10} node-role=general
kubectl label nodes az{1,2,3}-worker-medical-{01,02,03} node-role=medical
kubectl label nodes az{1,2,3}-worker-gpu-{01,02,03} node-role=gpu accelerator=nvidia-a100

# 节点污点
kubectl taint nodes az{1,2,3}-worker-medical-{01,02,03} medical-only=true:NoSchedule
kubectl taint nodes az{1,2,3}-worker-medical-{01,02,03} medical-only=true:NoExecute
kubectl taint nodes az{1,2,3}-worker-gpu-{01,02,03} nvidia.com/gpu=true:NoSchedule
```

**工作负载 1：体检预约 Web 服务（无状态，10 副本，跨 3 AZ 均匀分布）**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: medical-appointment
  namespace: production
spec:
  replicas: 10
  selector:
    matchLabels:
      app: medical-appointment
  template:
    metadata:
      labels:
        app: medical-appointment
        qos: guaranteed
    spec:
      priorityClassName: medical-critical
      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: medical-appointment
      - maxSkew: 1                          # 跨节点也打散
        topologyKey: kubernetes.io/hostname
        whenUnsatisfiable: ScheduleAnyway   # 软约束，节点不够时允许同节点
        labelSelector:
          matchLabels:
            app: medical-appointment
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
            - matchExpressions:
              - key: node-role
                operator: In
                values: ["general"]
      containers:
      - name: app
        image: registry.example.com/medical-appointment:v1.2.3
        resources:
          requests:
            cpu: 2
            memory: 4Gi
          limits:
            cpu: 2
            memory: 4Gi      # Guaranteed QoS
```

**设计理由**：
- `topologyKey=zone, maxSkew=1, DoNotSchedule`：严格跨 3 AZ 均匀分布，单 AZ 故障最多损失 1/3 副本
- `topologyKey=hostname, ScheduleAnyway`：软约束尽量跨节点，节点不够时允许同节点多 Pod
- `nodeAffinity general`：调度到通用节点（不占用医保专用 / GPU 节点）
- `priorityClassName=medical-critical`：P1 优先级，可抢占 P2/P3 任务
- `Guaranteed QoS`：requests=limits，节点资源压力下最后被驱逐

**工作负载 2：医保结算服务（敏感业务，3 副本，必须只调度到医保专用节点）**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: medical-insurance
  namespace: production
spec:
  replicas: 3
  template:
    metadata:
      labels:
        app: medical-insurance
    spec:
      priorityClassName: medical-critical
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
            - matchExpressions:
              - key: node-role
                operator: In
                values: ["medical"]
        podAntiAffinity:                    # 3 副本分别在不同节点
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchLabels:
                app: medical-insurance
            topologyKey: kubernetes.io/hostname
      tolerations:
      - key: "medical-only"
        operator: "Equal"
        value: "true"
        effect: "NoSchedule"
      - key: "medical-only"
        operator: "Equal"
        value: "true"
        effect: "NoExecute"
        tolerationSeconds: 300              # 故障时 5 分钟宽限期
      containers:
      - name: app
        resources:
          requests: {cpu: 4, memory: 8Gi}
          limits:   {cpu: 4, memory: 8Gi}
---
# 配套 NetworkPolicy：医保 Pod 网络层隔离
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: medical-insurance-isolation
  namespace: production
spec:
  podSelector:
    matchLabels:
      app: medical-insurance
  policyTypes:
  - Ingress
  - Egress
  ingress:
  - from:
    - podSelector:
        matchLabels:
          app: medical-appointment   # 只允许体检预约调用
    ports:
    - protocol: TCP
      port: 8080
  egress:
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: kube-system
      podSelector:
        matchLabels:
          k8s-app: kube-dns          # 允许 DNS
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: production
      podSelector:
        matchLabels:
          app: mysql-master          # 允许访问 MySQL 主库
```

**设计理由（"专用节点 + 物理隔离"三件套）**：
- `nodeAffinity medical` + `tolerations medical-only`：硬约束调度到医保专用节点
- `podAntiAffinity hostname`：3 副本不同节点，单节点故障最多损失 1/3
- `tolerationSeconds=300`：NoExecute 污点时 5 分钟宽限，给医保结算完成在途请求
- `NetworkPolicy`：网络层隔离，只允许体检预约调用 + DNS + MySQL
- 不用污点用 nodeSelector 行不行？不行，污点是"反向控制"（默认不允许），nodeSelector 是"正向控制"（默认允许），污点隔离更彻底

**工作负载 3：体检报告 PDF 批处理（低优先级 Job，可被抢占）**

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: pdf-batch-20260726
  namespace: production
spec:
  parallelism: 10                        # 10 个并发
  completions: 100                       # 共 100 个任务
  ttlSecondsAfterFinished: 86400         # 完成后 1 天自动清理
  template:
    spec:
      priorityClassName: batch-low      # P3 批处理，可被抢占
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
            - matchExpressions:
              - key: node-role
                operator: In
                values: ["general"]
      containers:
      - name: pdf-generator
        image: registry.example.com/pdf-generator:v1.0
        resources:
          requests: {cpu: 1, memory: 2Gi}
          limits:   {cpu: 2, memory: 4Gi}   # Burstable QoS
      restartPolicy: OnFailure
```

**设计理由**：
- `priorityClassName=batch-low` + `preemptionPolicy=Never`：不抢占别人，但会被 P1 抢占
- `Burstable QoS`：requests &lt; limits，节点资源压力时优先被驱逐
- `parallelism=10`：10 个并发处理 100 个任务，约 10 分钟完成
- `ttlSecondsAfterFinished=86400`：完成后 1 天清理，避免 Job 堆积
- 调度到 general 节点，不占用医保专用 / GPU 节点

**工作负载 4：Redis Cluster（6 节点，主从跨 AZ，主从不能同节点同 AZ）**

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: redis-cluster
  namespace: production
spec:
  serviceName: redis-cluster
  replicas: 6
  podManagementPolicy: ParallelManagement
  template:
    spec:
      priorityClassName: medical-critical
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchLabels:
                app: redis-cluster
            topologyKey: kubernetes.io/hostname     # 严格不同节点
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            podAffinityTerm:
              labelSelector:
                matchLabels:
                  app: redis-cluster
                  redis-role: master
              topologyKey: topology.kubernetes.io/zone   # 主跨 AZ
      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: redis-cluster
      containers:
      - name: redis
        resources:
          requests: {cpu: 2, memory: 8Gi}
          limits:   {cpu: 2, memory: 8Gi}     # Guaranteed QoS
```

**设计理由（"主从跨 AZ"双重反亲和）**：
- `podAntiAffinity hostname required`：严格不同节点，防止单节点故障丢失两个副本
- `podAntiAffinity zone preferred` + Redis Operator 标记 master 标签：主节点跨 AZ
- `topologySpreadConstraints zone maxSkew=1`：6 个 Pod 在 3 AZ 严格均匀分布（2/2/2）
- 主从配对（az1-master + az2-slave）：用 Redis Operator 的 `redis-role` 标签 + podAntiAffinity 实现

**Redis 主从跨 AZ 的两种实现方式**：
1. **方式 A（podAntiAffinity）**：上面代码所示，所有 Redis Pod 之间相互反亲和
2. **方式 B（Operator + 标签）**：Redis Operator 自动给 master / slave 打标签，用 `podAffinityTerm` 让 slave 远离 master

生产推荐方式 B（更精细），但方式 A 在自研场景更简单。

**工作负载 5：医疗影像 AI 推理服务（GPU，2 副本，GPU 节点独占）**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: medical-ai-inference
  namespace: production
spec:
  replicas: 2
  template:
    spec:
      priorityClassName: medical-critical
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
            - matchExpressions:
              - key: node-role
                operator: In
                values: ["gpu"]
              - key: accelerator
                operator: In
                values: ["nvidia-a100"]
      tolerations:
      - key: "nvidia.com/gpu"
        operator: "Equal"
        value: "true"
        effect: "NoSchedule"
      podAntiAffinity:
        requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchLabels:
              app: medical-ai-inference
          topologyKey: kubernetes.io/hostname      # 2 副本不同 GPU 节点
      containers:
      - name: inference
        image: registry.example.com/medical-ai:v2.0
        resources:
          requests:
            cpu: 8
            memory: 32Gi
            nvidia.com/gpu: 1     # 申请 1 个 GPU
          limits:
            cpu: 8
            memory: 32Gi
            nvidia.com/gpu: 1
```

**设计理由（GPU 节点独占）**：
- `nodeAffinity gpu + accelerator=nvidia-a100`：调度到 A100 GPU 节点
- `tolerations nvidia.com/gpu`：容忍 GPU 节点污点
- `resources.nvidia.com/gpu=1`：声明 1 个 GPU，调度器通过 Extended Resource 调度
- `podAntiAffinity hostname`：2 副本不同 GPU 节点，单节点故障不丢失
- GPU 节点独占通过"污点 + 资源声明"实现：污点防止其他 Pod 进来，资源声明保证 GPU 不被多个 Pod 共享

**GPU 节点独占为什么用污点 + 资源声明而不是只用 nodeAffinity**：
- 只用 nodeAffinity：其他不带 GPU 声明的 Pod 也能调度到 GPU 节点，浪费 GPU
- 加污点：其他 Pod 不容忍，进不来
- 加资源声明 `nvidia.com/gpu`：调度器按 GPU 卡数限制，1 个 GPU 卡不会被 2 个 Pod 共享

**工作负载 6：Filebeat 日志采集（DaemonSet，每节点一份，医保节点不能采集医保日志外的数据）**

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: filebeat-general
  namespace: kube-system
spec:
  template:
    spec:
      nodeSelector:
        node-role: general          # 只在通用节点
      containers:
      - name: filebeat
        image: docker.elastic.co/beats/filebeat:8.10
        resources:
          requests: {cpu: 100m, memory: 200Mi}
          limits:   {cpu: 500m, memory: 500Mi}
---
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: filebeat-medical
  namespace: kube-system
spec:
  template:
    spec:
      nodeSelector:
        node-role: medical
      tolerations:
      - key: "medical-only"
        operator: "Equal"
        value: "true"
        effect: "NoSchedule"
      - key: "medical-only"
        operator: "Equal"
        value: "true"
        effect: "NoExecute"
      containers:
      - name: filebeat
        image: docker.elastic.co/beats/filebeat:8.10
        env:
        - name: LOG_TYPE
          value: "medical"            # 标记为医保日志
        resources:
          requests: {cpu: 100m, memory: 200Mi}
          limits:   {cpu: 500m, memory: 500Mi}
---
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: filebeat-gpu
  namespace: kube-system
spec:
  template:
    spec:
      nodeSelector:
        node-role: gpu
      tolerations:
      - key: "nvidia.com/gpu"
        operator: "Equal"
        value: "true"
        effect: "NoSchedule"
      containers:
      - name: filebeat
        image: docker.elastic.co/beats/filebeat:8.10
```

**设计理由**：
- 拆 3 个 DaemonSet（general / medical / gpu）：每个 DaemonSet 只采集自己节点池的日志
- 医保节点的 Filebeat 用 `LOG_TYPE=medical` 标记，发送到独立的 ES 集群（医保审计专用）
- 通用 Filebeat 不容忍 medical 污点，自然不调度到医保节点
- 医保 Filebeat 容忍 medical 污点，独占采集医保日志

**为什么不共用一个 DaemonSet**：
- 共用一个 DaemonSet 需要容忍所有污点，但日志分流逻辑复杂（按节点标签分流）
- 拆 3 个独立 DaemonSet，配置清晰，便于审计
- 医保日志单独走独立 ES 集群，满足等保 2.0 三级要求

#### 题目一与架构师水平的差距

**差距1：拓扑分布约束生产实战不足**
- 现状：知道 topologySpreadConstraints，但没用 maxSkew + whenUnsatisfiable 组合做过严格跨 AZ 分布
- 架构师水平：能基于业务 SLA 设计"严格均匀（maxSkew=1, DoNotSchedule）/ 尽力均匀（ScheduleAnyway）"分级方案
- 补足方向：在测试集群验证 maxSkew=1 在节点故障场景的行为，压测跨 AZ 分布的收敛速度

**差距2：抢占式调度的牺牲者选择算法不熟**
- 现状：知道抢占会驱逐低优先级 Pod，但牺牲者选择的"最小驱逐集合"算法不深
- 架构师水平：能讲清抢占算法的"按优先级升序 + 同优先级按启动时间最新 + 驱逐最小化"原则
- 补足方向：精读 kube-scheduler preemption 算法源码（pkg/scheduler/framework/preemption.go）

**差距3：医疗专用节点隔离设计深度不足**
- 现状：用过污点 + 容忍，但"污点 + nodeAffinity + NetworkPolicy + PriorityClass + ResourceQuota"五件套协同没系统设计过
- 架构师水平：能为医保结算设计"调度层 + 网络层 + 优先级层 + 资源层"四重隔离
- 补足方向：在啄木鸟云健康测试集群验证五件套协同效果

**差距4：GPU 调度实战经验不足**
- 现状：没用过 nvidia.com/gpu 资源声明 + GPU 节点独占
- 架构师水平：能基于 GPU 型号标签（A100/V100/T4）做 GPU 节点池分级，能配置 MIG（Multi-Instance GPU）切片
- 补足方向：在测试集群验证 GPU 节点独占调度，研究 NVIDIA GPU Operator

---

## 题目二（架构设计题）：资源管理与多租户隔离

接题目一的场景。30 节点集群共 720 核 CPU / 1440GB 内存，要承载 4 家医共体客户（每家客户规模差异大：A 客户 50w 体检/年、B 客户 20w、C 客户 10w、D 客户 5w）+ 啄木鸟自身业务 + 系统组件（监控/日志/Ingress）。每个客户的业务包含 Web 服务 + Redis 缓存 + MySQL 从库 + PDF 批处理。

请你回答：

1. K8s 的资源模型是怎么设计的？CPU 与 Memory 的 Requests/Limits 在 cgroups 层面分别对应什么（cpu.shares / cpu.cfs_quota_us / memory.limit_in_bytes / memory.soft_limit_in_bytes）？为什么 CPU 是"压缩资源"（compressible）而 Memory 是"不可压缩资源"（incompressible）？Ephemeral-Storage 资源限制解决什么问题？为什么只设 Limits 不设 Requests 是生产大忌？
2. QoS（Quality of Service）三等级 Guaranteed / Burstable / BestEffort 的判定规则？三等级在节点资源压力下的驱逐顺序（kubelet Eviction）？为什么生产核心服务必须用 Guaranteed（Requests = Limits）？为什么"Requests = Limits"对 JVM/Golang 应用尤其重要（CPU Throttling 与 GC 停顿的联动）？Burstable 在哪些场景下是合理选择？BestEffort 在生产中能不能用？
3. CPU Throttling 的根因与排查？`cpu.cfs_quota_us` / `cpu.cfs_period_us` 默认 100ms 周期的工作机制？为什么"Limits 设为 2 核但实际只用 1.5 核"也会被 Throttle（CFS 周期边界问题）？JVM 应用为什么对 CPU Throttling 极其敏感（GC pause + JIT 编译）？怎么用 metrics（container_cpu_cfs_throttled_seconds_total）发现 Throttling？生产中 CPU Limits 应该设为多少（Requests 的多少倍）？
4. OOMKilled 的根因与排查？为什么"Memory Limits 设为 4GB，JVM 堆 3GB"也会 OOMKilled（JVM 元空间/线程栈/堆外内存/Direct Buffer 没算）？容器内 `free` / `top` 看到的内存为什么不对（LXCFS 与 cgroup 的视图差异）？JVM 容器化后必须设置哪些参数（-XX:MaxRAMPercentage / -XX:+UseContainerSupport）？为什么 K8s 1.21 前 JVM 容器化是大坑？Memory Requests 在节点资源压力下怎么影响 Eviction 顺序？
5. LimitRange 与 ResourceQuota 在多租户集群中怎么配合？ResourceQuota 的"硬配额（hard）"与"范围配额（scopes: NotBestEffort / Terminating / NotTerminating / PriorityClass）"的差异？为什么必须用 PriorityClass scope 给系统组件留"保底资源"？LimitRange 的"默认 Requests/Limits / 最小 / 最大 / Limit/Requests 比值"四个约束怎么配？怎么防止"某客户把单个 Pod Limits 设为 100 核，把整个节点吃光"？怎么设计 4 家医共体客户的 ResourceQuota 分配方案（A/B/C/D 分别多少 CPU/Memory）+ LimitRange 默认约束 + 系统组件保底？
6. Node Allocatable 的"Capacity / Allocatable / Reserved"三者的关系？`system-reserved` / `kube-reserved` / `eviction-hard` 三个阈值怎么配？为什么生产必须给 kubelet / 容器运行时 / 系统守护进程留够资源（不留就会节点雪崩）？怎么用 `--system-reserved-cgroup` / `--kube-reserved-cgroup` 把系统组件也纳入 cgroups 限制？多租户集群的"节点池隔离 vs 命名空间共享"两种方案怎么选？

### 作答区

#### 1. K8s 资源模型与 cgroups 底层

**资源模型设计哲学**：

```
┌──────────────────────────────────────────────────────────────────┐
│  Pod spec                                                        │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  resources:                                                │  │
│  │    requests:    # 调度依据 + 运行时保障                    │  │
│  │      cpu: 2          # 调度器选节点依据                    │  │
│  │      memory: 4Gi      # 节点 Allocatable 扣减              │  │
│  │    limits:      # 运行时上限（cgroups 硬限制）             │  │
│  │      cpu: 4          # cfs_quota_us                       │  │
│  │      memory: 8Gi      # OOMKilled 阈值                    │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
              kubelet 启动容器时翻译为 cgroups
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│  cgroups v1 / v2  （容器级）                                      │
│  - cpu.shares = 1024 * requests.cpu       # 相对权重             │
│  - cpu.cfs_quota_us = limits.cpu * 100000  # 绝对上限            │
│  - cpu.cfs_period_us = 100000              # 100ms 周期          │
│  - memory.limit_in_bytes = limits.memory   # 绝对上限            │
│  - memory.soft_limit_in_bytes = requests.memory  # 软限制        │
│  - memory.oom_control = 1                  # OOM 时杀进程         │
└──────────────────────────────────────────────────────────────────┘
```

**CPU vs Memory 的本质差异：压缩 vs 不可压缩**：

| 维度 | CPU（压缩资源） | Memory（不可压缩资源） |
|------|---------------|---------------------|
| 超限行为 | Throttling（节流，进程变慢） | OOMKilled（杀进程） |
| 可恢复性 | 限流解除后即恢复 | 进程已死，不可恢复 |
| cgroups 机制 | cfs_quota_us 限速 | memory.limit_in_bytes 杀进程 |
| 生产影响 | 业务变慢，体验下降 | 业务中断，数据可能丢失 |

**为什么 CPU 是"可压缩"**：
- CPU 是"时间片"资源，进程多了就分时间片，每个进程慢一点
- 不会"杀死"进程，只是让进程变慢
- 系统稳定，不会因 CPU 压力崩溃

**为什么 Memory 是"不可压缩"**：
- 内存是"空间"资源，进程已用满就是用满
- 不能"让进程用少一点内存"，进程持有的内存页不能强制收回
- 唯一办法：杀掉进程释放内存

**Ephemeral-Storage 资源限制解决什么问题**：

```yaml
resources:
  requests:
    ephemeral-storage: 1Gi      # 调度依据
  limits:
    ephemeral-storage: 2Gi      # 上限，超过触发 Eviction
```

- 限制容器临时存储用量（日志 / emptyDir / 容器可写层）
- 防止"日志写满磁盘"导致节点故障
- 超过 limits 时 kubelet 驱逐 Pod（Evicted 状态）
- cgroups v2 通过 `io.max` 和文件系统 quota 实现

**为什么"只设 Limits 不设 Requests"是生产大忌**：

```yaml
# 错误写法
resources:
  limits:
    cpu: 4
    memory: 8Gi
# 没有 requests
```

| 问题 | 影响 |
|------|------|
| 调度器不知道 Pod 实际需要多少资源 | 默认 requests=limits，导致节点 Allocatable 计算错误 |
| 节点超卖 | 多个 Pod 调度到同节点，实际 CPU 不够，Throttling |
| QoS 等级降级 | 自动判定为 Burstable（不是 Guaranteed），驱逐优先级高 |
| HPA 失效 | HPA 基于 requests 计算 CPU 利用率，没 requests 无法计算 |

**正确写法**：
```yaml
# 方式 A：Guaranteed（生产核心服务）
resources:
  requests: {cpu: 2, memory: 4Gi}
  limits:   {cpu: 2, memory: 4Gi}     # requests == limits

# 方式 B：Burstable（普通业务 / 批处理）
resources:
  requests: {cpu: 1, memory: 2Gi}
  limits:   {cpu: 2, memory: 4Gi}     # requests < limits
```

#### 2. QoS 三等级与生产选择

**QoS 判定规则**：

| 等级 | 判定条件 | 驱逐顺序 |
|------|---------|---------|
| Guaranteed | 所有容器 requests == limits（CPU/Memory 都要等） | 最后驱逐（第 3 顺位） |
| Burstable | 至少一个容器有 requests，但 requests != limits | 中间驱逐（第 2 顺位） |
| BestEffort | 所有容器都没设 requests/limits | 最先驱逐（第 1 顺位） |

**判定流程**：
```
kubelet 计算 Pod QoS：
1. 所有容器都设了 requests == limits（CPU 和 Memory 都等）？-> Guaranteed
2. 否则，至少一个容器设了 requests 或 limits？-> Burstable
3. 否则（啥都没设）-> BestEffort
```

**生产核心服务为什么必须 Guaranteed**：

| 维度 | Guaranteed | Burstable |
|------|-----------|----------|
| 驱逐优先级 | 最后（第 3 顺位） | 中间（第 2 顺位） |
| CPU Throttling 风险 | 低（requests=limits，cfs_quota 充裕） | 高（limits > requests，可能被限流） |
| 节点压力下稳定性 | 高 | 中 |
| JVM/Golang 应用 | 推荐 | 不推荐 |

**为什么 Guaranteed 对 JVM/Golang 应用尤其重要**：

**JVM 应用的 CPU Throttling 联动 GC pause**：
- JVM GC（Full GC）需要"Stop-The-World"，暂停所有线程
- 如果 GC 期间被 CPU Throttling，GC 时间被拉长
- 100ms 的 GC pause + 200ms 的 CPU Throttling = 300ms 应用停顿
- 用户感知：请求超时 / 健康检查失败 / Pod 重启

**Golang 应用**：
- Golang GC 标记阶段需要 CPU 资源
- 被限流时 GC 拖慢，内存增长
- 触发更频繁 GC，恶性循环

**Burstable 的合理使用场景**：
- 批处理任务（PDF 生成）：低优先级，可被驱逐
- 开发测试环境：资源不紧张，节省成本
- 突发流量场景：requests 保守，limits 留余地

**BestEffort 在生产中的禁忌**：
- 节点资源压力时立即被驱逐
- 无资源保障，OOMKilled 风险高
- 仅用于"实验性"任务，不能用于业务

#### 3. CPU Throttling 根因与排查

**cfs_quota_us / cfs_period_us 默认 100ms 周期工作机制**：

```
cpu.cfs_period_us = 100000   (100ms 周期)
cpu.cfs_quota_us  = 200000   (200ms quota，即 2 核)

含义：
- 每 100ms 周期内，容器最多用 200ms CPU 时间（等价于 2 核满载）
- 周期开始：容器可消耗 CPU 时间
- 周期内 quota 用完：容器被 Throttle，等下个周期
- 周期结束：quota 重置，容器恢复
```

**为什么"limits 设为 2 核但实际只用 1.5 核"也会被 Throttle（CFS 周期边界问题）**：

```
时间线（100ms 周期）：
0ms          50ms         100ms        150ms        200ms
│            │            │            │            │
├────────────┼────────────┼────────────┼────────────┤
│ 容器用 1 核 │ 容器用 2 核 │            │            │
│ 50ms CPU   │ 50ms CPU   │            │            │
│            │            │            │            │
              ↑
              100ms 周期到了，已用 100ms（1 核满载）
              但 quota 是 200ms（2 核），还剩 100ms
              
              等等！问题在于"突发使用模式"：
              - 0-50ms 用 1 核（50ms CPU）
              - 50-100ms 突然用 4 核（4*50=200ms CPU）
              - 100ms 时累计已用 250ms，超过 quota 200ms
              - 在 90ms 时被 Throttle（quota 用完）
              - 100-150ms 等 quota 重置
              - 150ms 恢复

实际场景：
- JVM GC 100ms 内突发使用 4 核
- 限流后 GC pause 拉长到 200ms
- 应用层感知：请求延迟 + 健康检查失败
```

**JVM 应用对 CPU Throttling 极其敏感的根因**：

| JVM 阶段 | CPU 需求 | Throttling 影响 |
|---------|---------|----------------|
| GC（Young/Old） | 突发 4-8 核 | GC pause 从 50ms 拉长到 500ms |
| JIT 编译 | 突发 2-4 核 | 编译延迟，热点代码优化推迟 |
| Class Loading | 突发 2 核 | 启动慢， readinessProbe 失败 |
| 启动期 | 持续高 CPU | 启动失败，CrashLoopBackOff |

**用 metrics 发现 Throttling**：

```
Prometheus 指标：
  container_cpu_cfs_throttled_seconds_total   # 累计被限流秒数
  container_cpu_cfs_throttled_periods_total   # 被限流的周期数
  container_cpu_cfs_periods_total             # 总周期数

诊断公式：
  throttling_ratio = cfs_throttled_periods / cfs_periods
  throttling_ratio > 5%  -> 告警
  throttling_ratio > 20% -> 严重告警

Grafana 查询：
  rate(container_cpu_cfs_throttled_seconds_total[5m]) > 0
```

**生产 CPU Limits 配置建议**：

| 业务类型 | requests | limits | 比例 |
|---------|---------|--------|------|
| 核心业务（Guaranteed） | 2 核 | 2 核 | 1:1 |
| JVM 应用（GC 突发） | 2 核 | 4 核 | 1:2 |
| 普通业务（Burstable） | 1 核 | 2 核 | 1:2 |
| 批处理 | 1 核 | 2 核 | 1:2 |

**JVM 应用为什么 limits > requests**：
- GC 期间突发用 CPU，limits 留余地
- 但 Guaranteed 要求 requests=limits，怎么办？
- 方案：把 requests 设到能容纳 GC 突发的水平（如 4 核）
- 或：用 cgroups v2 的 `cpu.max` + `cpu.weight` 联合控制

**CPU Manager static 策略**：
- kubelet 配置 `--cpu-manager-policy=static`
- 给 Guaranteed Pod 分配独占 CPU 核（不与其他 Pod 共享）
- 适合 CPU 敏感型应用（如数据库、消息队列）

#### 4. OOMKilled 根因与排查

**为什么"Memory Limits 设为 4GB，JVM 堆 3GB"也会 OOMKilled**：

```
容器内存使用构成：
┌────────────────────────────────────────────────┐
│  JVM 堆（-Xmx3g）              3GB           │
├────────────────────────────────────────────────┤
│  JVM 元空间（Metaspace）        256MB         │
├────────────────────────────────────────────────┤
│  JVM 线程栈（500 线程 × 1MB）   500MB         │
├────────────────────────────────────────────────┤
│  JVM 代码缓存（Code Cache）     240MB         │
├────────────────────────────────────────────────┤
│  JVM 直接内存（Direct Buffer）  500MB         │
├────────────────────────────────────────────────┤
│  JVM GC 日志 / 类加载 / 内部    100MB         │
├────────────────────────────────────────────────┤
│  JVM 本身（C++ 内存）           100MB         │
├────────────────────────────────────────────────┤
│  容器其他进程（如 Filebeat）    100MB         │
└────────────────────────────────────────────────┘
                         合计: 4.8GB

容器 Memory Limits = 4GB
实际使用 = 4.8GB > 4GB
-> OOMKilled！
```

**根因**：JVM 堆只是 JVM 内存的一部分，还有元空间、线程栈、堆外内存等。容器 Memory Limits 必须 ≥ JVM 堆 + 元空间 + 线程栈 + 堆外 + 其他。

**容器内 free / top 看到的内存为什么不对**：

```
传统 Linux：free / top 看到的是宿主机内存（如 96GB）
容器内（cgroups v1）：free / top 还是看到宿主机内存，不是容器 Limits（4GB）

原因：
- free / top 读 /proc/meminfo
- /proc/meminfo 是宿主机的内存信息，不是容器的
- LXCFS（LXC FUSE）可以"修正" /proc/meminfo，但需要单独部署

后果：
- JVM 看 /proc/meminfo，以为有 96GB 内存
- 默认 -Xmx = /proc/meminfo 的 1/4 = 24GB
- 但容器 Limits = 4GB
- JVM 启动后立刻 OOMKilled
```

**JVM 容器化后必须设置的参数**：

```bash
# JDK 8u191+ / JDK 10+
-XX:+UseContainerSupport              # 自动识别容器 Limits（默认开启）
-XX:MaxRAMPercentage=75.0            # JVM 堆 = 容器 Limits × 75%
-XX:InitialRAMPercentage=75.0        # 初始堆
-XX:MinRAMPercentage=75.0            # 小容器场景

# 不要再用旧参数（已废弃）：
# -Xmx3g                              # 写死堆大小，不适应 Limits 变化
# -XX:+UseCGroupMemoryLimitForBacking # JDK 8u191 前的实验参数，已废弃
```

**MaxRAMPercentage 75% 的设计理由**：
- 75% 给 JVM 堆
- 25% 留给元空间 + 线程栈 + 堆外 + JVM 自身
- 是 JVM 容器化的"经验值"

**为什么 K8s 1.21 前 JVM 容器化是大坑**：
- K8s 1.21 前，cgroups v2 默认未启用，JVM UseContainerSupport 仅支持 cgroups v1
- JDK 8u191 前的 JDK 版本，UseContainerSupport 不存在
- 容器 Limits 4GB，JVM 看到宿主机 96GB，按 1/4 设堆 = 24GB
- 立即 OOMKilled

**Memory Requests 在节点资源压力下怎么影响 Eviction 顺序**：

```
kubelet Eviction 顺序（节点内存压力时）：
1. BestEffort Pod（无 requests/limits）
2. Burstable Pod 中"内存使用 > requests"的（超 requests 部分）
3. Burstable Pod 中"内存使用 < requests"的
4. Guaranteed Pod（最后驱逐）

判断"内存使用 > requests"：
- Pod A: requests=2Gi, limits=8Gi, 实际用 6Gi  -> 使用 > requests，优先驱逐
- Pod B: requests=2Gi, limits=8Gi, 实际用 1.5Gi -> 使用 < requests，保护
- Pod C: Guaranteed, limits=4Gi, 实际用 3Gi      -> 最后驱逐

启发：
- requests 是"保底资源"，超过 requests 的部分在压力时被牺牲
- 想保住 Pod，requests 设到能容纳正常使用的水位
```

#### 5. LimitRange + ResourceQuota 多租户治理

**ResourceQuota 的"硬配额"vs"范围配额"**：

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: quota-customer-a
  namespace: customer-a
spec:
  hard:                          # 硬配额（绝对上限）
    requests.cpu: 100
    requests.memory: 200Gi
    limits.cpu: 200
    limits.memory: 400Gi
    persistentvolumeclaims: 20
    pods: 50
    services.loadbalancers: 2
    configmaps: 50
    secrets: 50
  scopes:                        # 范围配额（仅统计满足条件的 Pod）
  - NotBestEffort                # 排除 BestEffort Pod
  - NotTerminating               # 排除 Terminating Pod（如 Job）
  scopeSelector:                 # K8s 1.14+，按 PriorityClass 限定
    matchExpressions:
    - operator: In
      scopeName: PriorityClass
      values: [medical-critical, medical-normal]
```

| 配额类型 | 语义 | 适用场景 |
|---------|------|---------|
| hard | 绝对上限 | 限制客户最多用多少资源 |
| scopes | 按 QoS / 终止状态过滤 | 排除 BestEffort / Job 噪音 |
| scopeSelector | 按 PriorityClass 过滤 | 给系统组件留保底资源 |

**为什么必须用 PriorityClass scope 给系统组件留"保底资源"**：

```yaml
# 系统命名空间的 ResourceQuota
apiVersion: v1
kind: ResourceQuota
metadata:
  name: quota-system
  namespace: kube-system
spec:
  hard:
    requests.cpu: 50
    requests.memory: 100Gi
  scopeSelector:
    matchExpressions:
    - operator: In
      scopeName: PriorityClass
      values: [system-node-critical, system-cluster-critical]
```

- 系统组件（CNI / DNS / Ingress）必须保证资源
- 用 PriorityClass scope 限定，避免被业务 Pod 抢占
- 配合 PriorityClass 抢占式调度，系统组件总能在节点资源紧张时驱逐业务 Pod

**LimitRange 四个约束**：

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: limit-range-customer-a
  namespace: customer-a
spec:
  limits:
  - type: Container
    default:                    # 默认 limits（没显式设的 Pod 用这个）
      cpu: 2
      memory: 4Gi
    defaultRequest:             # 默认 requests
      cpu: 1
      memory: 2Gi
    min:                        # 最小值
      cpu: 100m
      memory: 256Mi
    max:                        # 最大值
      cpu: 16
      memory: 32Gi
    maxLimitRequestRatio:       # limits/requests 最大比值
      cpu: 4
      memory: 2
```

| 约束 | 作用 | 防止什么 |
|------|------|---------|
| default / defaultRequest | 没显式设的 Pod 用默认值 | BestEffort Pod 泛滥 |
| min | 最小资源 | Pod 资源不足导致 CrashLoopBackOff |
| max | 最大资源 | "某客户把单个 Pod limits 设 100 核吃光整个节点" |
| maxLimitRequestRatio | limits/requests 比值 | 超卖过狠导致节点 Throttling |

**防止"单 Pod limits 设 100 核吃光节点"的工程机制**：
- LimitRange max 限制单容器最大资源
- 超过 max 的 Pod 创建请求被 Admission 拒绝
- 配合 ResourceQuota 限制命名空间总资源

**4 家医共体客户 ResourceQuota 分配方案**：

集群容量：720 核 CPU / 1440GB 内存 / 60TB 本地盘 + 100TB 网络存储

```
┌────────────────────────────────────────────────────────────────┐
│  节点池容量分配（30 节点）                                         │
├────────────────────────────────────────────────────────────────┤
│  系统组件保底：       80 核 / 160GB  (kube-system + istio-system) │
│  平台自身业务：      120 核 / 240GB  (啄木鸟自身)                │
│  4 家客户分配：     520 核 / 1040GB                              │
│    - A 客户（50w/年）：240 核 / 480GB  (46%)                     │
│    - B 客户（20w/年）：120 核 / 240GB  (23%)                     │
│    - C 客户（10w/年）：80 核 / 160GB   (15%)                     │
│    - D 客户（5w/年）： 40 核 / 80GB    (8%)                      │
│    - Buffer 保留：    40 核 / 80GB    (8%)  应对突发              │
│  共计：              720 核 / 1440GB                             │
└────────────────────────────────────────────────────────────────┘
```

```yaml
# A 客户 ResourceQuota（50w 体检/年，最大客户）
apiVersion: v1
kind: ResourceQuota
metadata:
  name: quota-customer-a
  namespace: customer-a
spec:
  hard:
    requests.cpu: 240
    requests.memory: 480Gi
    limits.cpu: 480
    limits.memory: 960Gi
    persistentvolumeclaims: 30
    pods: 150
    services.loadbalancers: 5
    configmaps: 100
    secrets: 100

---
# B 客户 ResourceQuota（20w 体检/年）
apiVersion: v1
kind: ResourceQuota
metadata:
  name: quota-customer-b
  namespace: customer-b
spec:
  hard:
    requests.cpu: 120
    requests.memory: 240Gi
    limits.cpu: 240
    limits.memory: 480Gi
    persistentvolumeclaims: 20
    pods: 80

---
# C 客户（10w/年）
hard:
  requests.cpu: 80
  requests.memory: 160Gi
  limits.cpu: 160
  limits.memory: 320Gi
  pods: 50

---
# D 客户（5w/年，最小客户）
hard:
  requests.cpu: 40
  requests.memory: 80Gi
  limits.cpu: 80
  limits.memory: 160Gi
  pods: 30

---
# 每个客户命名空间的 LimitRange
apiVersion: v1
kind: LimitRange
metadata:
  name: limit-range-default
  namespace: customer-X
spec:
  limits:
  - type: Container
    default: {cpu: 2, memory: 4Gi}
    defaultRequest: {cpu: 1, memory: 2Gi}
    min: {cpu: 100m, memory: 256Mi}
    max: {cpu: 16, memory: 32Gi}
    maxLimitRequestRatio:
      cpu: 4
      memory: 2
```

**方案设计要点**：
1. 按"体检业务量"分配（A:B:C:D = 50w:20w:10w:5w = 6:3:2:1 接近）
2. 留 8% buffer 应对突发
3. LimitRange 防止"单 Pod 吃光节点"
4. ResourceQuota 配合 PriorityClass 保护核心业务

#### 6. Node Allocatable 与多租户隔离方案

**Capacity / Allocatable / Reserved 三者关系**：

```
节点总容量（Capacity）= 24 核 CPU / 96GB 内存 / 2TB 磁盘
         │
         │  减去系统预留
         ▼
Allocatable = Capacity - system-reserved - kube-reserved - eviction-hard
         │
         │  调度器用 Allocatable 调度 Pod
         ▼
Pod 可用资源 = Allocatable
```

**三组预留参数**：

```bash
# kubelet 启动参数
--system-reserved=cpu=2,memory=4Gi,ephemeral-storage=20Gi
--kube-reserved=cpu=1,memory=2Gi,ephemeral-storage=10Gi
--eviction-hard=memory.available<500Mi,nodefs.available<10%,imagefs.available<15%
--system-reserved-cgroup=/system.slice
--kube-reserved-cgroup=/runtime.slice
```

| 预留 | 用途 | 典型值 |
|------|------|-------|
| system-reserved | 系统守护进程（sshd / systemd / NTP） | cpu=2, memory=4Gi |
| kube-reserved | kubelet / 容器运行时（containerd / dockerd） | cpu=1, memory=2Gi |
| eviction-hard | 触发 Eviction 的硬阈值 | memory.available&lt;500Mi |

**为什么生产必须留够资源**：

```
不留 system-reserved 的后果：
- 系统守护进程（如 systemd-journald）突发用 CPU
- 与业务 Pod 抢 CPU，业务 Pod Throttling
- 系统守护进程被 cgroups 限制，关键服务（如 SSH）无响应
- 节点失联，kubelet 上报 NotReady
- 雪崩：节点 NotReady -> Pod eviction -> 其他节点雪崩

不留 kube-reserved 的后果：
- kubelet 自己被业务 Pod 抢资源
- kubelet 心跳上报延迟，节点标记 NotReady
- 容器运行时（containerd）被限流，Pod 启动慢
- 节点稳定性下降
```

**节点雪崩的典型场景**：
```
1. 业务突发流量，节点 CPU 100%
2. kubelet 心跳上报延迟
3. Node controller 标记节点 NotReady
4. Pod eviction 到其他节点
5. 其他节点也 CPU 100%，雪崩
6. 整个集群业务不可用

防御：留够 system-reserved + kube-reserved，确保系统组件不被业务抢资源
```

**多租户集群"节点池隔离 vs 命名空间共享"两种方案**：

| 维度 | 节点池隔离 | 命名空间共享 |
|------|----------|------------|
| 架构 | 每个客户独立节点池 | 所有客户共享节点池，按 Namespace 隔离 |
| 资源隔离 | 物理隔离（最强） | 逻辑隔离（弱） |
| 资源利用率 | 低（客户资源不能共享） | 高（共享节点池） |
| 成本 | 高 | 低 |
| 故障隔离 | 强（客户故障不影响其他） | 弱（一个客户跑飞可能影响其他） |
| 运维复杂度 | 高（多套节点池） | 低（一套节点池） |
| 适用场景 | 强合规 / 大客户 | 小客户 / SaaS |

**啄木鸟云健康推荐方案：混合模式**
- 大客户（A/B）独立节点池（按需扩容）
- 小客户（C/D）共享节点池 + Namespace 隔离
- 医保结算等敏感业务专用节点池（污点 + 网络隔离）
- GPU 节点池独立（医疗影像 AI 推理）

```yaml
# 节点池设计
- 客户 A 专用节点池（az1-customer-a-01..05）：5 节点，污点 customer=a
- 客户 B 专用节点池（az1-customer-b-01..03）：3 节点
- 共享节点池（az1-shared-01..10）：10 节点，客户 C/D 共享
- 医保专用节点池（az1-medical-01..03）：3 节点
- GPU 节点池（az1-gpu-01..03）：3 节点
- 系统节点池（az1-system-01..03）：3 节点，仅运行 kube-system

# 共享节点池的 LimitRange
apiVersion: v1
kind: LimitRange
metadata:
  name: limit-shared
  namespace: customer-c
spec:
  limits:
  - type: Container
    max: {cpu: 8, memory: 16Gi}    # 限制单 Pod 最大资源
    maxLimitRequestRatio:
      cpu: 4                        # 限制超卖比

# 共享节点池的 ResourceQuota
hard:
  requests.cpu: 80                  # C 客户最多 80 核
  requests.memory: 160Gi
```

**节点池隔离的实现**：
- 节点标签：`node-role.kubernetes.io/customer=a`
- 节点污点：`customer=a:NoSchedule`
- 客户 Pod 用 `nodeAffinity + tolerations` 调度到自己的节点池
- 优势：物理隔离，故障不影响其他客户

#### 题目二与架构师水平的差距

**差距1：cgroups v1 vs v2 实战差异不深**
- 现状：知道 cgroups 限制 CPU/Memory，但 cgroups v1（cpu.shares/cfs_quota）vs v2（cpu.max/cpu.weight）的实战差异不深
- 架构师水平：能配置 cgroups v2（K8s 1.25+ GA），能用 `io.max` 限制 IO，能用 `memory.max` + `memory.high` 双层限制
- 补足方向：在测试集群启用 cgroups v2，验证 io.max 对日志 Sidecar 的 IO 限制

**差距2：JVM 容器化调参深度不足**
- 现状：知道 -XX:MaxRAMPercentage，但 JVM 元空间 / 线程栈 / 堆外内存的精细调参不深
- 架构师水平：能基于容器 Limits 精细配置 JVM 参数（堆 / 元空间 / 线程栈 / 直接内存），能基于 JFR / async-profiler 分析内存使用
- 补足方向：精读《Java Performance》（Scott Oaks），用 async-profiler 分析啄木鸟云健康线上 JVM 内存

**差距3：CPU Throttling 线上排查实战不足**
- 现状：知道 cfs_throttled 指标，但线上 Throttling 排查实战不足，没建立"Throttling 告警 + 诊断 + 处理 SOP"
- 架构师水平：能基于 Prometheus 抓取 cfs_throttled 指标，建立"Throttling ratio > 5% 告警 + 火焰图分析 + 调参" SOP
- 补足方向：在啄木鸟云健康集群部署 Throttling 监控，复盘历史 Throttling 事件

**差距4：LimitRange / ResourceQuota 多租户实战不足**
- 现状：用过 LimitRange + ResourceQuota，但 4 家客户的配额分配方案、LimitRange 默认约束、系统组件保底机制没系统设计过
- 架构师水平：能基于业务规模（体检业务量）设计 4 家客户的配额分配，能用 PriorityClass scope 保护系统组件，能建立"超配预警 + 自动扩容"机制
- 补足方向：在测试集群模拟 4 家客户场景，验证 ResourceQuota 配额生效

**差距5：Node Allocatable 调优实战不足**
- 现状：知道 Capacity / Allocatable / Reserved，但 system-reserved / kube-reserved / eviction-hard 的具体调参没做过
- 架构师水平：能基于节点规格（CPU/内存/磁盘）设计 Reserved 方案，能用 cgroups 把系统组件纳入限制，能监控节点 NotReady 与 OOM 风险
- 补足方向：在测试集群调参 system-reserved / kube-reserved，观察节点稳定性

**差距6：节点池隔离 vs 命名空间共享选型经验不足**
- 现状：用过 Namespace 共享，但"节点池隔离 + 命名空间共享"混合方案没系统设计过
- 架构师水平：能基于业务规模（大客户独立节点池 / 小客户共享）设计混合方案，能用污点 + 网络隔离实现"逻辑 + 物理"双重隔离
- 补足方向：在啄木鸟云健康设计多租户节点池方案，验证故障隔离效果

---

## 题目作答要求

按照 CLAUDE.md 的训练要求，每道题作答后需指出：

1. 与架构师水平的差距（具体到知识盲点、实战经验缺失）
2. 补足方向（具体的学习材料、实战场景、源码阅读路径）

作答时建议先在草稿纸上列思路，再补充细节，最后对照"架构师水平"做自我评估。
