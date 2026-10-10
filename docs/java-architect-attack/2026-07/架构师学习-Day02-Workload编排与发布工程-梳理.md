# 架构师学习 Day02 梳理：Workload 编排与发布工程

> 架构师视角的提炼版｜适合复习与面试速记
>
> 周主题：K8s 与云原生专题

---

## 一、Workload 在云原生架构中的定位

### 1.1 核心一句话

> **Workload 控制器 = 声明式驱动 Pod 状态收敛的控制器，每类 Workload 对应一类业务形态**
>
> Pod 是"易碎品"，不会自愈、不会伸缩、不会滚动更新。Workload 控制器把 Pod 编排成"可运维的业务系统"。选 Workload 的本质 = 选 Pod 之间的关系模型。

### 1.2 五种 Workload 对应五类业务

| Workload | 业务形态 | Pod 关系 | 典型场景 |
| --- | --- | --- | --- |
| Deployment | 无状态服务 | 完全独立、可替换 | Web/API 微服务 |
| StatefulSet | 有状态服务 | 有序、稳定标识 | DB/缓存/MQ |
| DaemonSet | 节点级守护 | 每节点一份 | 日志/监控 Agent |
| Job | 一次性任务 | 一次性执行 | 批处理、数据迁移 |
| CronJob | 定时任务 | 周期性执行 | 定时报表、对账 |

### 1.3 为什么不能用 Deployment 通吃

| 错误选型 | 问题 |
| --- | --- |
| 有状态服务塞进 Deployment | Pod 名随机、PVC 写冲突、重启后状态丢失 |
| 节点级守护用 Deployment + replicas=N | 节点动态变化时无法保证"每节点一份" |
| 批处理用 Deployment | restartPolicy=Always 导致无限重启 |
| 定时任务用 Deployment | 需要外部调度器，丢失 K8s 原生能力 |

### 1.4 Workload 与往周专题的衔接

| 往周专题 | Workload 衔接 |
| --- | --- |
| Redis 主从/哨兵 | StatefulSet + Headless Service 提供稳定 DNS |
| MySQL 读写分离 | StatefulSet + Operator（Vitess/Oracle MySQL Operator） |
| 微服务无状态服务 | Deployment + 反亲和 + HPA |
| 限流降级 | DaemonSet 部署 Ingress/API Gateway，金丝雀发布联调 Sentinel |
| 支付幂等多可用区 | Deployment + Pod 反亲和 + maxUnavailable=0 |
| 医疗定时对账 | CronJob + concurrencyPolicy=Forbid |

---

## 二、五种 Workload 拆分

### 2.1 Deployment

| 字段 | 含义 |
| --- | --- |
| `replicas` | 期望副本数 |
| `strategy.type` | `RollingUpdate`（默认）/ `Recreate` |
| `strategy.rollingUpdate.maxSurge` | 滚动期最多比期望多多少（25% 默认） |
| `strategy.rollingUpdate.maxUnavailable` | 滚动期最多比期望少多少（25% 默认） |
| `revisionHistoryLimit` | 历史 ReplicaSet 保留数（10 默认，建议 50） |
| `progressDeadlineSeconds` | 发布超时阈值（600s 默认） |

**关键陷阱**：readinessProbe 没配好就上滚动发布 = 灾难（新 Pod 没真正 Ready 接流量 / 卡在滚动 / 资源占满）

### 2.2 StatefulSet

**三大核心特性**：

1. **稳定网络标识**：Pod 名 `redis-0/1/2`，DNS `redis-0.redis-headless.default.svc.cluster.local`
2. **稳定存储**：`volumeClaimTemplates` 每副本独立 PVC，Pod 与 PVC 稳定绑定
3. **有序部署/扩缩/滚动**：`podManagementPolicy: OrderedReady`（默认）严格按序号

**必备条件**：必须关联 Headless Service（`clusterIP: None`）

**Headless Service vs ClusterIP Service**：

| 维度 | ClusterIP | Headless |
| --- | --- | --- |
| clusterIP | 分配 VIP | None |
| DNS | 返回 VIP A 记录 | 返回所有 Pod IP A 记录 |
| 负载均衡 | kube-proxy 轮询 | 客户端自选 |
| 适用 | Deployment 无状态 | StatefulSet 有状态 |

**生产陷阱**：
- 滚动卡死（readinessProbe 失败导致整滚卡住）
- Pod 卡 Terminating（PVC 没回收）
- Headless Service 漏配（StatefulSet 创建失败）

### 2.3 DaemonSet

**核心机制**：控制器 watch Node 资源，每节点自动创建一份 Pod

**关键配置**：

```yaml
updateStrategy:
  type: RollingUpdate  # 默认；OnDelete 手动删 Pod 才更新
  rollingUpdate:
    maxUnavailable: 1
template:
  spec:
    hostNetwork: true  # 用节点网络，绕过 CNI
    tolerations:
    - operator: Exists  # 容忍所有 taint，包括 master
```

**典型场景**：日志采集（Filebeat）、监控 Agent（Node Exporter）、CNI（Calico）、CSI Node Plugin、Ingress Controller

**为什么不能用 Deployment + nodeSelector + replicas=N**：
- 节点动态变化无法自动跟随
- 不能强保证每节点一份（可能两个 Pod 调度到同节点）
- 滚动逻辑按 Pod 而非节点维度
- 节点退出处理不同

### 2.4 Job

**核心参数**：

| 参数 | 含义 |
| --- | --- |
| `completions` | 成功完成多少个 Pod 整 Job 才完成 |
| `parallelism` | 同时并发多少 Pod |
| `backoffLimit` | 失败重试次数（6 默认） |
| `activeDeadlineSeconds` | 最长执行时间 |
| `ttlSecondsAfterFinished` | 完成后多久清理 |
| `restartPolicy` | **必须** Never 或 OnFailure |
| `completionMode` | `NonIndexed`（默认）/ `Indexed`（K8s 1.24 GA） |

**三种执行模式**：
- 单任务：completions=1, parallelism=1
- N 串行：completions=N, parallelism=1
- N 并行：completions=N, parallelism=M

**Indexed Job 价值**：每个 Pod 拿稳定 index（0~N-1），适合分片处理（10w PDF 分 20 片），省去外部队列

### 2.5 CronJob

```yaml
spec:
  schedule: "0 2 * * *"  # 每天 2:00
  concurrencyPolicy: Forbid  # Forbid/Replace/Allow
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 5
  timeZone: Asia/Shanghai  # K8s 1.25+
```

**concurrencyPolicy 选型**：
- `Forbid`：上次没跑完不启动新任务（数据同步场景，避免重复）
- `Replace`：杀掉上次任务，启动新的
- `Allow`（默认）：允许并发

---

## 三、Deployment 滚动发布全链路

### 3.1 滚动发布节奏（10 副本，maxSurge=2/maxUnavailable=0）

```
1. 创建新 ReplicaSet rs-v2，扩容 0 -> 1
2. 新 Pod Pending -> Scheduler 调度 -> kubelet 拉镜像
3. 新 Pod Running，readinessProbe 未通过 -> 不加入 Endpoints
4. readinessProbe 通过 -> Endpoints Controller 加入新 Pod
5. kube-proxy 更新 iptables/ipvs 规则 -> 新 Pod 接流量
6. 旧 ReplicaSet rs-v1 缩容 10 -> 9，旧 Pod Terminating
7. Endpoints Controller 摘除旧 Pod -> kube-proxy 更新规则
8. 旧 Pod 收到 SIGTERM，preStop hook 执行
9. 等 terminationGracePeriodSeconds（30s 默认）
10. 旧 Pod 退出，循环 1-9 直到全部替换
```

### 3.2 maxSurge / maxUnavailable 配置矩阵（10 副本）

| 配置 | 行为 | 适用 |
| --- | --- | --- |
| `maxSurge=2, maxUnavailable=0` | 最多 12，永不小于 10 | 高可用推荐 |
| `maxSurge=0, maxUnavailable=2` | 最多 10，最少 8 | 资源紧张 |
| `maxSurge=10, maxUnavailable=0` | 一次性起 10 新 Pod | 蓝绿（资源足） |
| `maxSurge=1, maxUnavailable=1` | 慢速滚动 | 测试环境 |

### 3.3 优雅停机的三大配额

```yaml
# 1. preStop：让 Pod 等几秒，给 kube-proxy 规则更新时间
lifecycle:
  preStop:
    exec:
      command: ["sh", "-c", "sleep 5 && curl -X POST localhost:8080/actuator/shutdown"]

# 2. terminationGracePeriodSeconds：给优雅停机足够时间（默认 30s，建议 60s）
terminationGracePeriodSeconds: 60

# 3. Spring Boot 2.3+ graceful shutdown
# application.yaml:
# server:
#   shutdown: graceful
# spring:
#   lifecycle:
#     timeout-per-shutdown-phase: 30s
```

### 3.4 滚动发布四大陷阱

1. **readinessProbe 没配**：新 Pod 没真正 Ready 接流量，5xx
2. **readinessProbe 太严**：新 Pod 永不 Ready，卡在滚动，maxSurge 占满资源
3. **preStop 没配**：kube-proxy 规则未更新，流量还打到旧 Pod，SIGTERM 后请求丢
4. **terminationGracePeriodSeconds 太短**：Spring Boot 关闭流程没走完被 SIGKILL

---

## 四、StatefulSet 三大特性详解

### 4.1 稳定网络标识

```
redis-cluster-0 -> redis-cluster-0.redis-cluster-headless.default.svc.cluster.local
redis-cluster-1 -> redis-cluster-1.redis-cluster-headless.default.svc.cluster.local
redis-cluster-2 -> redis-cluster-2.redis-cluster-headless.default.svc.cluster.local
```

- Pod 重启后名字不变、DNS 不变
- 客户端可直接连特定 Pod（如 Redis 主节点 redis-cluster-0）
- 配合 Redis Cluster 槽位路由、Kafka 分区路由

### 4.2 稳定存储

```yaml
volumeClaimTemplates:
- metadata:
    name: data
  spec:
    accessModes: ["ReadWriteOnce"]
    storageClassName: fast-ssd
    resources:
      requests:
        storage: 50Gi
```

- 每副本独立 PVC：`data-redis-cluster-0`、`data-redis-cluster-1`...
- Pod 与 PVC 稳定绑定：redis-0 永远挂 data-redis-cluster-0
- Pod 删除默认保留 PVC（`persistentVolumeClaimRetentionPolicy: Retain`）

### 4.3 有序部署/扩缩/滚动

| 操作 | 顺序 |
| --- | --- |
| 部署 | 0 -> 1 -> 2 -> ... |
| 扩容 | 0 -> 1 -> 2 -> 3（正向） |
| 缩容 | 3 -> 2 -> 1（反向删除） |
| 滚动更新 | N-1 -> N-2 -> ... -> 0（反向滚动，主节点最后更新） |

**Parallel 模式**（`podManagementPolicy: Parallel`）：并行创建，适合 ES/Cassandra 等"有状态但不需要有序"的场景

---

## 五、Job 参数体系与批处理加速

### 5.1 Job 三种执行模式

```yaml
# 模式1：单任务跑一次
spec:
  completions: 1
  parallelism: 1

# 模式2：N 串行
spec:
  completions: 10
  parallelism: 1

# 模式3：N 并行
spec:
  completions: 100
  parallelism: 10
```

### 5.2 Indexed Job 分片处理

```yaml
spec:
  completions: 20
  parallelism: 5
  completionMode: Indexed
  template:
    spec:
      containers:
      - env:
        - name: JOB_COMPLETION_INDEX
          valueFrom:
            fieldRef:
              fieldPath: metadata.annotations['batch.kubernetes.io/job-completion-index']
```

**价值**：10w 体检报告分 20 片，每 Pod 处理 5000，5 并发分 4 批跑完，省去外部队列

### 5.3 批处理 10w PDF 三种方案对比

| 方案 | 实现 | 耗时 | 复杂度 |
| --- | --- | --- | --- |
| 串行单 Pod | completions=1, parallelism=1 | 28 小时 | 简单 |
| Job + 工作队列 | Pod 从 Redis 队列抢任务 | 3 小时 | 中等（需 Redis） |
| Indexed Job | completionMode=Indexed, completions=20 | 2 小时 | 简单（原生） |

---

## 六、发布工程三件套

### 6.1 滚动发布（Rolling Update）

- **资源占用**：maxSurge 增量
- **回滚速度**：K8s `rollout undo` 5 秒切回（受滚动节奏限制）
- **适用**：日常小版本迭代、测试环境

### 6.2 蓝绿发布（Blue-Green）

**K8s 实现**：Deployment v1/v2 + Service Label 切换

```bash
# 部署绿环境
kubectl apply -f appointment-green.yaml

# 等绿环境 Ready
kubectl wait --for=condition=ready pod -l version=green

# 切流量
kubectl patch svc appointment -p '{"spec":{"selector":{"version":"green"}}}'
```

| 维度 | 蓝绿 |
| --- | --- |
| 流量切换 | 一键全量 |
| 资源占用 | 双倍 |
| 回滚速度 | 极快（改 label） |
| 适用 | 大版本升级、测试环境 |

**双倍资源优化**：绿环境缩容待命（1 副本保持镜像预热）+ 切流量前扩容到 10

### 6.3 金丝雀发布（Canary）

**K8s 实现方案对比**：

| 方案 | 流量控制粒度 |
| --- | --- |
| Deployment 副本数 | 10% 步长 |
| Nginx Ingress Canary | 5%/10%/50% |
| Istio VirtualService | 1%/5%/10%/50% 精确 |

**Istio VirtualService 金丝雀**：

```yaml
http:
- route:
  - destination: {host: appointment, subset: v1}
    weight: 95
  - destination: {host: appointment, subset: v2}
    weight: 5
```

| 维度 | 金丝雀 |
| --- | --- |
| 流量切换 | 渐进式百分比 |
| 资源占用 | 增量（5% 副本） |
| 回滚速度 | 较慢（流量切回 + 缩容） |
| 适用 | 生产环境、小版本迭代 |

### 6.4 三种发布策略对比

| 策略 | 资源 | 回滚 | 风险 | 复杂度 |
| --- | --- | --- | --- | --- |
| 滚动 | 增量 | 中 | 中 | 简单 |
| 蓝绿 | 双倍 | 极快 | 集中 | 简单 |
| 金丝雀 | 增量 | 慢 | 分散 | 中等 |

---

## 七、HPA + 发布 + 回滚协同

### 7.1 HPA 核心配置

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
spec:
  minReplicas: 5
  maxReplicas: 50
  metrics:
  - type: Resource
    resource:
      name: cpu
      target: {type: Utilization, averageUtilization: 60}
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 0  # 立即扩容
      policies:
      - {type: Percent, value: 100, periodSeconds: 60}
    scaleDown:
      stabilizationWindowSeconds: 300  # 5 分钟稳定期
      policies:
      - {type: Percent, value: 10, periodSeconds: 60}
```

### 7.2 HPA + 滚动发布雪崩场景

```
1. 业务高峰 10 副本 CPU 80%，HPA 扩到 15
2. 此时发布 v2，滚动替换
3. 新 Pod JVM 启动期 CPU 飙高，HPA 持续扩容
4. maxSurge 资源占满，副本数飙升到 30
5. 节点资源不足，新 Pod Pending
6. 旧 Pod 全被替换，新 Pod 没起来 -> 雪崩
```

**防御方案**：
- 发布期间 HPA scaleDown.stabilizationWindowSeconds 设为 600（10 分钟）
- 避开业务高峰发布
- 小批量滚动 maxSurge=1/maxUnavailable=0
- 预热新 Pod（startupProbe 接管 liveness）

### 7.3 HPA / VPA / Cluster Autoscaler 分工

| 机制 | 作用层 | 调整维度 | 适用场景 |
| --- | --- | --- | --- |
| HPA | Pod | 副本数（横向） | 流量波动 |
| VPA | Pod | Requests/Limits（纵向） | 内存泄漏、CPU 估算不准 |
| Cluster Autoscaler | Node | 节点数 | 节点池容量不足 |
| Karpenter | Node | 节点类型 + 数量 | AWS 灵活伸缩 |

**注意**：HPA 与 VPA 不能同时用于同一维度（HPA 按 CPU 扩容 + VPA 调 CPU Requests 会冲突）

### 7.4 Deployment 回滚机制

```bash
kubectl rollout history deployment xxx
kubectl rollout undo deployment xxx
kubectl rollout undo deployment xxx --to-revision=2
kubectl rollout status deployment xxx
```

**回滚背后**：找到目标 ReplicaSet -> 扩容目标 RS -> 缩容当前 RS -> 反向滚动更新

**revisionHistoryLimit 建议**：
- 默认 10 偏紧，生产建议 50
- 配合 GitOps（ArgoCD/Flux）从 Git 历史回滚，双保险

**回滚陷阱**：回滚到"修复了 bug 又引入新 bug"的版本，重新暴露安全漏洞

---

## 八、综合设计：金丝雀发布工程方案

### 8.1 整体架构

```
外部流量 -> SLB -> Istio IngressGateway -> VirtualService (95% v1 / 5% v2)
                                              │
                              ┌───────────────┴───────────────┐
                              │                                │
                              ▼                                ▼
                    Deployment v1                    Deployment v2
                    replicas: 10                     replicas: 1
                    (旧版本)                          (金丝雀)
                              │                                │
                              └───────────────┬────────────────┘
                                              │
                                              ▼
                                    Service Endpoints
                                    (readinessProbe 联动)
                                              │
                                              ▼
                                    MySQL / Redis / MQ
```

### 8.2 涉及资源

| 资源 | 用途 |
| --- | --- |
| Deployment v1/v2 | 双版本并行 |
| Service | 内部负载（selector 不区分版本） |
| PodDisruptionBudget | minAvailable=70% 防止驱逐过多 |
| HPA | 自动伸缩 |
| Istio DestinationRule | 定义版本子集 |
| Istio VirtualService | 控制流量比例 |

### 8.3 发布 SOP（5% -> 50% -> 100%）

```
[阶段0] 准备：确认 HPA 稳定、Prometheus baseline 指标
[阶段1] 部署 v2 replicas=1，等 Ready
[阶段2] VirtualService v2 weight=5，观察 30 分钟（错误率/延迟/业务指标）
[阶段3] v2 weight=50，扩容 v2 到 5 副本，观察 15 分钟
[阶段4] v2 weight=100，扩容 v2 到 10 副本，缩容 v1 到 0
[阶段5] 观察 30 分钟稳定后删除 v1
```

### 8.4 监控指标

| 类别 | 指标 | 阈值 |
| --- | --- | --- |
| 流量 | v1/v2 QPS 对比 | v2 与权重比例匹配 |
| 错误 | v1/v2 5xx 错误率 | v2 &lt; v1 |
| 延迟 | P99/P95 | v2 &lt; baseline + 10% |
| 业务 | 下单/支付成功率 | 不低于 baseline |
| 资源 | CPU/内存 | &lt; 80% |
| K8s | Pod Ready/重启 | 0 重启 |
| HPA | 当前/目标副本数 | 不震荡 |

### 8.5 5 分钟回滚 SOP

```bash
# 1. 立即切回 v1（5 秒）
kubectl patch virtualservice appointment --type=json \
  -p='[{"op":"replace","path":"/spec/http/1/route/0/weight","value":100},
        {"op":"replace","path":"/spec/http/1/route/1/weight","value":0}]'

# 2. 等 v1 流量恢复（30 秒）
sleep 30

# 3. 缩容 v2（30 秒）
kubectl scale deployment appointment-v2 --replicas=0

# 4. 验证业务恢复（4 分钟）
# 总耗时 < 5 分钟
```

---

## 九、架构师面试高频问题速记

### 9.1 Workload 选型

- **五种 Workload 分别对应什么场景？**：Deployment 无状态、StatefulSet 有状态、DaemonSet 节点级守护、Job 一次性、CronJob 定时
- **为什么不能用 Deployment 通吃？**：有状态服务丢数据、节点守护漏节点、批处理无限重启、定时任务缺调度
- **StatefulSet 三大特性？**：稳定网络标识（Headless Service + Pod DNS）、稳定存储（volumeClaimTemplates + PVC 永久绑定）、有序部署（OrderedReady 按序号）
- **Headless Service 与 ClusterIP 差异？**：clusterIP=None，DNS 返回 Pod IP 列表而非 VIP，客户端自选，配合 StatefulSet 让客户端能稳定找到 redis-0 主节点
- **DaemonSet 为什么不能用 Deployment + replicas=N？**：节点动态变化、强保证每节点一份、节点退出处理、滚动按节点维度
- **Job 的 restartPolicy 为什么不能是 Always？**：Job 语义是跑完即退，Always 永不退出，API Server 创建时校验报错
- **Indexed Job 解决什么问题？**：原生分片处理（每 Pod 拿稳定 index），省去外部队列（Redis 工作队列）

### 9.2 发布工程

- **maxSurge / maxUnavailable 含义？**：surge 控制资源上限，unavailable 控制可用性下限
- **滚动发布 readinessProbe 没配好为什么会灾难？**：新 Pod 没真正 Ready 接流量 5xx / 太严卡在滚动 / 共用 liveness 启动期被杀
- **蓝绿 vs 金丝雀本质差异？**：蓝绿一键全量切换（双倍资源，回滚极快）；金丝雀渐进式（增量资源，回滚慢）
- **K8s 回滚机制？**：每版本对应 ReplicaSet，rollout undo 找到目标 RS 反向滚动，revisionHistoryLimit 控制保留数（建议 50）
- **HPA + 滚动为什么雪崩？**：JVM 启动期 CPU 高被 HPA 误判扩容，maxSurge 资源占满，新 Pod Pending，旧 Pod 全替换，服务雪崩
- **HPA/VPA/CA 分工？**：HPA 横向副本数，VPA 纵向 Requests，CA 节点数；HPA + VPA 不能同维度
- **5 分钟回滚 SOP？**：VirtualService weight 切回 100/0 -> 等 30s -> 缩容 v2 -> 验证业务恢复

### 9.3 优雅停机

- **preStop + terminationGracePeriodSeconds 怎么配？**：preStop sleep 5 给 kube-proxy 规则更新时间，terminationGracePeriodSeconds 60s 给 Spring Boot 关闭流程
- **Spring Boot 2.3+ graceful shutdown？**：`server.shutdown: graceful` + `spring.lifecycle.timeout-per-shutdown-phase: 30s`
- **Pod 收到 SIGTERM 后做了什么？**：preStop hook 执行 -> 等待 terminationGracePeriodSeconds -> SIGKILL 强杀

### 9.4 Operator 模式

- **有状态服务为什么用 Operator？**：StatefulSet 只提供基础（稳定标识/存储），Operator 提供业务生命周期（扩缩容、故障转移、备份恢复、版本升级）
- **Operator 本质？**：CRD（自定义资源）+ Controller（控制器循环 watch + reconcile）
- **常见 Operator？**：Redis Operator、Strimzi Kafka Operator、Prometheus Operator、Vitess（MySQL）、ECK（ES）

---

## 十、Day02 核心架构师命题

### 10.1 核心命题

> **理解 K8s 的"Workload 控制器 + 发布工程 + 自动伸缩"三层架构，掌握"无状态/有状态/节点级/批处理/定时"五类业务形态的 Workload 选型与"滚动/蓝绿/金丝雀"三种发布策略的工程落地**

### 10.2 架构师思维跃迁

- 从"我会写 Deployment YAML"到"我能设计零宕机发布 + 5 分钟回滚 + 多版本并存的发布工程体系"
- 从"会用 K8s"到"能选对 Workload、能设计发布工程、能避坑 HPA 雪崩、能压测优雅停机"

### 10.3 与往周专题的呼应

| 往周专题 | Day02 呼应 |
| --- | --- |
| CAP/分布式事务 | StatefulSet = CP 系统（强一致 + 稳定标识），Deployment = AP 系统（多副本 + 最终一致） |
| Redis | StatefulSet + Headless Service 部署 Redis Cluster，Redis Operator 管理生命周期 |
| 微服务 | Deployment + 反亲和 + HPA 部署无状态微服务，Istio 金丝雀发布 |
| 限流降级 | HPA + 滚动发布雪崩防御，发布期间 HPA 行为调优 |
| 支付 | Deployment + maxUnavailable=0 + Pod 反亲和保证零宕机支付 |
| 医疗 | CronJob 定时同步医保目录，Indexed Job 批量生成体检报告 PDF |

### 10.4 Day02 → Day03 衔接

Day02 解决了"Pod 怎么编排、怎么发布"，但 Pod 之间怎么通信、外部流量怎么进 K8s 集群、跨 namespace/集群怎么联通？这就需要 Day03 的 **Service 与网络模型**：

- Service / Ingress / Endpoints / kube-proxy iptables vs ipvs
- CNI（Calico/Flannel/Cilium）
- CoreDNS
- NetworkPolicy（多租户隔离）
- Service Mesh（Istio）

---