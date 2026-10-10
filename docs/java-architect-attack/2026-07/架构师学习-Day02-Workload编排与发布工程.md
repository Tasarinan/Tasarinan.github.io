# 架构师学习-Day02-Workload 编排与发布工程

> 日期：2026年07月21日（周二）
> 周主题：K8s 与云原生专题
> 出题日：Day02 - Workload 编排与发布工程

---

## 背景

Day01 我们打了"K8s 核心架构 + Pod 容器设计模式"两根地基，解决了"K8s 由什么组成"和"Pod 为什么是最小调度单位"两个问题。但 Pod 本身是"易碎品"——它不会自愈、不会伸缩、不会滚动更新。真正把 Pod 编排成"可运维的业务系统"的，是 **Workload 控制器** 和 **发布工程**。

为什么 Day02 必须接着讲 Workload 与发布：

1. **业务现实**：啄木鸟云健康的体检预约服务日均 50w+ 订单，一旦发布期间出问题就是医疗订单丢失 + 监管事故。我们之前用 SETNX/Redisson 做秒杀库存，跑在 K8s 上要做"零宕机发布 + 5 分钟回滚"，必须吃透 Deployment 的滚动/回滚机制
2. **承接往周专题**：
   - 微服务专题的"Nacos watch + 健康检查" -> K8s 的 Endpoints + readinessProbe 联动
   - 限流降级专题的"Sentinel 集群限流" -> K8s 的 HPA + maxSurge/maxUnavailable 联动避免雪崩
   - 支付专题的"幂等 + 多可用区容灾" -> K8s 的 Pod 反亲和 + 滚动发布保证至少有一份副本在跑
   - Redis 专题的"主从复制 + 哨兵" -> K8s 的 StatefulSet 提供稳定网络标识 + 稳定存储
   - MySQL 专题的"读写分离 + 分库分表" -> K8s 的 StatefulSet 部署 MySQL Operator（如 Vitess）
3. **面试高频考点**：Deployment/StatefulSet/DaemonSet/Job/CronJob 五件套、滚动发布参数、金丝雀发布、HPA + 滚动雪崩、revisionHistoryLimit、PodDisruptionBudget —— 中高级架构师岗几乎必问
4. **架构师思维跃迁**：从"我会写 Deployment YAML"到"我能在 K8s 上设计零宕机发布 + 5 分钟回滚 + 多版本并存的发布工程体系"

Day02 我们打两根支柱：

- **题目一（架构设计题）**：K8s Workload 五件套选型与生产落地 —— 解决"为什么不能用 Deployment 通吃、五种 Workload 的本质差异、有状态服务怎么部署、批处理任务怎么编排"
- **题目二（架构设计题）**：K8s 发布工程实战 —— 解决"滚动/蓝绿/金丝雀三种发布策略在 K8s 中怎么落地、回滚机制怎么实现、HPA 与发布怎么配合、如何设计零宕机发布工程"

---

## 题目一（架构设计题）：K8s Workload 五件套选型与生产落地

假设你作为新公司的架构师，把啄木鸟云健康的智慧体检/公卫平台搬到 K8s 上。平台包含以下子系统：

- 体检预约 Web 服务（无状态 Spring Boot 微服务，10+ 副本）
- Redis Cluster 缓存集群（6 节点，3 主 3 从）
- Filebeat 日志采集器（每个节点都必须跑一份）
- 体检报告 PDF 批量生成任务（每天凌晨一次性任务，处理 10w 体检报告）
- 医保目录定时同步任务（每天 2:00 从医保局 API 拉取最新目录）

请你回答：

1. K8s 提供哪些 Workload 资源？分别对应什么场景？为什么不能用 Deployment 通吃？讲清 Deployment / StatefulSet / DaemonSet / Job / CronJob 五件套的本质差异，并对应"无状态服务 / 有状态服务 / 节点级守护进程 / 一次性任务 / 定时任务"五类业务形态。
2. StatefulSet 的"稳定网络标识 + 稳定存储 + 有序部署/扩缩/滚动"是怎么实现的？为什么 Redis Cluster、Zookeeper、Kafka 等有状态服务必须用 StatefulSet 而不能用 Deployment + PVC？Headless Service 与 ClusterIP Service 的本质差异？`redis-0/redis-1/redis-2` 这种稳定标识在生产中能解决什么问题？
3. DaemonSet 的调度规则是什么？怎么保证"每个节点都跑一份"？哪些场景必须用 DaemonSet（Deployment + nodeSelector + 副本数=节点数 为什么不够）？DaemonSet 的滚动更新策略 `RollingUpdate` 与 `OnDelete` 的差异？taints/tolerations 怎么影响 DaemonSet 的部署范围？
4. Job 的 `completions` / `parallelism` / `backoffLimit` / `activeDeadlineSeconds` 四个参数怎么影响执行？Job 的 Pod 重启策略为什么必须是 `Never` 或 `OnFailure` 而不是 `Always`？什么是 Indexed Job（K8s 1.24 GA），能解决什么问题？批处理 10w PDF 怎么用 Job + 工作队列并行加速？
5. 请给啄木鸟云健康 5 个子系统分别选择最合适的 Workload，给出关键 YAML 配置片段（副本数/网络模型/存储模型/发布策略/调度约束），并解释每个选择的工程理由。

### 作答区

#### 1. K8s Workload 五件套的本质差异

**核心一句话**：Workload 控制器 = "声明式驱动 Pod 状态收敛的控制器"，每类 Workload 对应一类业务形态，差异在"Pod 之间的关系"——独立无状态 / 有序有状态 / 每节点一份 / 一次性执行 / 定时执行。

**五种 Workload 对应五类业务形态**：

| Workload | 业务形态 | Pod 关系 | 典型场景 | 网络模型 | 存储模型 |
|----------|---------|---------|---------|---------|---------|
| Deployment | 无状态服务 | 完全独立、可替换 | Web/API 微服务、Spring Boot | ClusterIP Service | 共享/无状态 |
| StatefulSet | 有状态服务 | 有序、稳定标识 | DB/缓存/MQ（Redis/ZK/Kafka/MySQL） | Headless Service + 稳定 DNS | 每副本独立 PVC |
| DaemonSet | 节点级守护 | 每节点一份 | 日志采集、监控 Agent、CNI | HostNetwork 或 ClusterIP | 节点级（hostPath/emptyDir） |
| Job | 一次性任务 | 一次性执行 | 批处理、数据迁移、PDF 生成 | 无 Service | 任务完成即销毁 |
| CronJob | 定时任务 | 周期性执行 | 定时报表、对账、清理 | 无 Service | 任务完成即销毁 |

**为什么不能用 Deployment 通吃**：

1. **有状态服务用 Deployment 会出大问题**：
   - Deployment 的 Pod 名是随机的（`redis-7f9b6c4d5-x8k2j`），重启后名字和 IP 都变
   - Redis Cluster 的节点发现、主从复制依赖稳定节点地址，IP 变化导致集群重新选主、数据丢失
   - Deployment 的 Pod 共享 PVC 会写冲突，独立 PVC 又没法保证 Pod 与 PVC 的稳定绑定
   - StatefulSet 才能保证 `redis-0` 永远绑 `pvc-redis-0`，重启后还是这个 Pod 拿这个 PVC

2. **节点级守护进程用 Deployment 不够**：
   - Deployment + `replicas=N`（N=节点数）+ `nodeSelector` 不能保证"每节点一份"，可能两个 Pod 调度到同一节点
   - 新节点加入集群时，Deployment 不会自动扩容（除非手动改 replicas）
   - 节点宕机时，Deployment 的 Pod 会被重新调度到其他节点（违反"每节点一份"）
   - DaemonSet 通过控制器直接 watch Node 资源，节点加入/退出自动调整

3. **批处理任务用 Deployment 会无限重启**：
   - Deployment 的 Pod `restartPolicy=Always`，任务完成后会无限重启
   - 没有 completions/parallelism 概念，无法控制"跑多少个、跑多少次"
   - 没有 backoffLimit，失败任务不会被清理，浪费资源
   - Job 才能正确表达"跑完即退、失败重试、并发控制"

4. **定时任务用 Deployment 需要外部调度器**：
   - Deployment 没有 cron 表达式，需要外部 crontab 或 Airflow 调度
   - CronJob 是 K8s 原生方案，由 Controller Manager 内置 cron 触发器
   - CronJob 支持 concurrencyPolicy（Forbid/Replace/Allow），避免任务叠加

**架构师视角**：选 Workload 的本质是"选 Pod 之间的关系模型"。错误选型 = 把有状态服务塞进 Deployment = 数据丢失 + 集群崩溃。

#### 2. StatefulSet 的"稳定标识 + 稳定存储 + 有序部署"

**StatefulSet 三大核心特性**：

##### 2.1 稳定网络标识

```yaml
# StatefulSet 关键字段
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: redis
spec:
  serviceName: redis-headless  # 必须关联 Headless Service
  replicas: 6
  podManagementPolicy: OrderedReady  # 默认有序，可选 Parallel
  template:
    spec:
      containers:
      - name: redis
        image: redis:7
---
apiVersion: v1
kind: Service
metadata:
  name: redis-headless
spec:
  clusterIP: None  # Headless
  selector:
    app: redis
  ports:
  - port: 6379
```

- 每个 Pod 的名字是固定序号：`redis-0`、`redis-1`、`redis-2`、`redis-3`、`redis-4`、`redis-5`
- 每个 Pod 有独立 DNS：`redis-0.redis-headless.default.svc.cluster.local`
- Pod 重启后名字不变、IP 不变（K8s 1.21+ Pod IP 在 Pod 生命周期内稳定，跨重启 IP 变但 DNS 名不变）
- Headless Service（`clusterIP: None`）不为 Service 分配 VIP，而是直接返回 Pod IP 列表（通过 DNS A 记录）

**Headless Service vs ClusterIP Service 的本质差异**：

| 维度 | ClusterIP Service | Headless Service |
|------|------------------|------------------|
| clusterIP | 分配 VIP（如 10.96.0.10） | None（不分配） |
| DNS 行为 | 返回 VIP 的 A 记录 | 返回后端所有 Pod IP 的 A 记录 |
| 负载均衡 | kube-proxy 在 iptables/ipvs 做轮询 | 客户端 DNS 解析后自己选 |
| 适用场景 | 无状态服务（Deployment） | 有状态服务（StatefulSet）+ 客户端需要直接连特定 Pod |
| 与 StatefulSet 配合 | 不适合（Pod 切换无意义） | 必须（让客户端能稳定找到 redis-0 主节点） |

**为什么有状态服务必须用 Headless Service**：

Redis Cluster 客户端需要知道每个节点的地址（不只是 VIP），因为：
- SET key value 后客户端要计算 slot（16384 slots），定位到具体节点
- 主节点故障时客户端要从 Sentinel/Cluster 获取新主节点地址
- MOVED/ASK 重定向要返回具体节点地址
- 如果用 ClusterIP，客户端只能看到 VIP，无法做 slot 路由

##### 2.2 稳定存储

```yaml
volumeClaimTemplates:  # StatefulSet 独有的 PVC 模板
- metadata:
    name: data
  spec:
    accessModes: [ "ReadWriteOnce" ]
    storageClassName: "fast-ssd"
    resources:
      requests:
        storage: 50Gi
```

- 每个 Pod 自动创建独立 PVC：`data-redis-0`、`data-redis-1`、`data-redis-2`...
- Pod 与 PVC 绑定关系稳定：`redis-0` 永远挂 `data-redis-0`，重启后还是这个
- Pod 删除时（默认 `persistentVolumeClaimRetentionPolicy: Retain`），PVC 保留，数据不丢
- 这是有状态服务的命根子：DB 重启后还能拿到原来的数据

**为什么不能用 Deployment + 共享 PVC**：
- 多个 Pod 同时写同一个 PVC 会写冲突（如多个 Redis 主节点写同一份 RDB）
- 用 ReadWriteMany（NFS/CephFS）会有性能问题 + 一致性问题
- 用 ReadWriteOnce + 多 PVC，又无法保证"Pod N 永远绑 PVC N"

##### 2.3 有序部署/扩缩/滚动

StatefulSet 默认 `podManagementPolicy: OrderedReady`：
- **部署**：严格按序号 0 -> 1 -> 2 -> ...，前一个 Ready 后才创建下一个
- **扩缩**：扩容按序号正向创建，缩容按序号反向删除（先删 N-1，再删 N-2...）
- **滚动更新**：从最大序号开始反向滚动（先更新 N-1，再更新 N-2...），保证主节点（通常是 0 号）最后更新

**为什么有序**：
- Redis Cluster：必须先起 master（redis-0），再起 slave（redis-1/2）做主从复制
- Zookeeper：必须按序启动做 leader 选举，否则选主混乱
- Kafka：必须按序启动 controller 节点，否则 partition 副本分配错乱

**Parallel 模式**（`podManagementPolicy: Parallel`）：
- 不等待前一个 Ready，并行创建所有 Pod
- 适用于"有状态但不需要有序"的场景（如 Elasticsearch 数据节点、Cassandra）

**生产实战陷阱**：

1. **滚动更新卡死**：StatefulSet 滚动到 redis-2 时，redis-2 readinessProbe 失败，整个滚动卡死，redis-1 也不更新。需要设 `maxUnavailable` 或临时改 `podManagementPolicy: Parallel`
2. **Pod 卡在 Terminating**：PVC 没回收，Pod 被绑死。需要 `persistentVolumeClaimRetentionPolicy: Delete` 或手动清理
3. **headless service 漏配**：StatefulSet 创建失败（`serviceName` 必须指向已存在的 Headless Service）

#### 3. DaemonSet 的调度规则与场景

**DaemonSet 的核心机制**：
- 控制器 watch Node 资源，每个 Node 上自动创建一份 Pod
- 节点加入集群自动创建 Pod，节点退出自动清理 Pod
- 默认每个节点一份，可通过 `nodeSelector` / `affinity` / `taints/tolerations` 限定范围

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: filebeat
spec:
  updateStrategy:
    type: RollingUpdate  # 默认；OnDelete 表示手动删除 Pod 才更新
    rollingUpdate:
      maxUnavailable: 1  # 同时最多 1 个节点更新
  template:
    spec:
      hostNetwork: true  # 用节点网络，避免经过 CNI
      tolerations:
      - operator: Exists  # 容忍所有 taint，包括 master
      containers:
      - name: filebeat
        image: docker.elastic.co/beats/filebeat:8.10
        volumeMounts:
        - name: varlog
          mountPath: /var/log
        - name: varlibdockercontainers
          mountPath: /var/lib/docker/containers
          readOnly: true
      volumes:
      - name: varlog
        hostPath:
          path: /var/log
      - name: varlibdockercontainers
        hostPath:
          path: /var/lib/docker/containers
```

**为什么必须用 DaemonSet 而不能用 Deployment + nodeSelector + replicas=N**：

1. **节点动态变化**：新节点加入集群，DaemonSet 自动创建 Pod；Deployment 需要手动调整 replicas 或写外部控制器
2. **强保证每节点一份**：DaemonSet 是控制器级别的"每节点一份"保证；Deployment + 反亲和可能因为节点数变化或调度抖动漏一个
3. **节点级资源访问**：DaemonSet 通常用 hostNetwork + hostPath，Deployment 默认不用 hostNetwork
4. **滚动更新逻辑不同**：DaemonSet 的 RollingUpdate 按"节点"维度滚动（每节点更新一份），Deployment 按"Pod"维度滚动
5. **节点退出处理**：节点 NotReady/Drain 时，DaemonSet Pod 会被标记删除但马上重新调度（如果节点恢复）；Deployment Pod 会被驱逐到其他节点

**DaemonSet 典型场景**：

| 场景 | 例子 |
|------|------|
| 日志采集 | Filebeat / Fluentd / Promtail |
| 监控 Agent | Node Exporter / Datadog Agent |
| 网络组件 | CNI（Calico/Flannel）/ kube-proxy |
| 存储 Agent | CSI Node Plugin / Longhorn Agent |
| 安全 Agent | Falco / Aqua Security |
| Ingress Controller | nginx-ingress / Traefik（每节点一份模式） |

**DaemonSet 滚动更新策略**：
- `RollingUpdate`（默认）：按节点滚动，`maxUnavailable` 控制同时更新节点数
- `OnDelete`：手动删除 Pod 才更新（兼容老版本 K8s 或特殊场景）

**taints/tolerations 对 DaemonSet 的影响**：
- 默认 DaemonSet Pod 不会调度到 master（master 有 NoSchedule taint）
- 监控/日志 Agent 需要部署到 master，要加 `tolerations: [{operator: Exists}]`（容忍所有 taint）
- 但 `NoExecute` taint 会驱逐 DaemonSet Pod（除非显式容忍）

#### 4. Job 的参数体系与批处理加速

**Job 的核心参数**：

| 参数 | 含义 | 典型值 |
|------|------|--------|
| `completions` | 成功完成多少个 Pod 后整个 Job 才算完成 | 1（单任务）/ N（多任务） |
| `parallelism` | 同时并发跑多少个 Pod | 1（串行）/ M（并行） |
| `backoffLimit` | 失败重试次数（默认 6） | 3-6 |
| `activeDeadlineSeconds` | Job 最长执行时间，超时强制终止 | 3600（1小时） |
| `ttlSecondsAfterFinished` | Job 完成后多久自动清理 | 86400（1天） |
| `restartPolicy` | Pod 重启策略，**必须**是 `Never` 或 `OnFailure` | Never（用 Job 推荐）/ OnFailure |

**为什么 restartPolicy 不能是 Always**：
- Job 的语义是"跑完即退"，Always 会让 Pod 永不退出
- K8s API Server 在创建 Job 时会校验 restartPolicy，Always 会直接报错
- Always 只能用于 Deployment/StatefulSet/DaemonSet 等长跑服务

**Job 的三种执行模式**：

```yaml
# 模式1：单任务跑一次（completions=1, parallelism=1）
apiVersion: batch/v1
kind: Job
metadata:
  name: db-migration
spec:
  completions: 1
  parallelism: 1
  backoffLimit: 3
  template:
    spec:
      restartPolicy: OnFailure
      containers:
      - name: migrate
        image: my-app:latest
        command: ["flyway", "migrate"]

# 模式2：N 个任务串行（completions=N, parallelism=1）
spec:
  completions: 10
  parallelism: 1  # 一次跑一个，跑完一个再跑下一个

# 模式3：N 个任务并行（completions=N, parallelism=M）
spec:
  completions: 100
  parallelism: 10  # 同时跑 10 个，跑完一个起下一个，直到 100 个都完成
```

**Indexed Job（K8s 1.24 GA）**：

```yaml
spec:
  completions: 5
  parallelism: 5
  completionMode: Indexed  # 关键字段
  template:
    spec:
      containers:
      - name: worker
        env:
        - name: JOB_COMPLETION_INDEX
          valueFrom:
            fieldRef:
              fieldPath: metadata.annotations['batch.kubernetes.io/job-completion-index']
```

- 每个 Pod 拿到一个稳定的 index（0-N-1）
- 适合"分片处理"场景：处理 10w 体检报告，按报告 ID 取模分成 10 片，每个 Pod 处理 1w
- 比传统"Job + 工作队列（Redis）"省去队列依赖，Pod 失败重启用 index 重新分配

**批处理 10w PDF 的三种加速方案**：

| 方案 | 实现 | 优劣 |
|------|------|------|
| 串行单 Pod | completions=1, parallelism=1 | 简单但慢，10w * 1s = 28 小时 |
| Job + 工作队列 | completions=N, parallelism=M，Pod 从 Redis 队列抢任务 | 灵活但需要外部队列 |
| Indexed Job | completionMode=Indexed, completions=10, parallelism=10 | 原生分片，2.8 小时跑完 |

**啄木鸟云健康 PDF 批量生成方案**：

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: pdf-batch-20260721
spec:
  completions: 20
  parallelism: 5
  completionMode: Indexed
  backoffLimit: 3
  activeDeadlineSeconds: 7200  # 2 小时超时
  ttlSecondsAfterFinished: 86400
  template:
    spec:
      restartPolicy: OnFailure
      containers:
      - name: pdf-generator
        image: registry/zhuomu/pdf-generator:1.0
        env:
        - name: JOB_COMPLETION_INDEX
          valueFrom:
            fieldRef:
              fieldPath: metadata.annotations['batch.kubernetes.io/job-completion-index']
        command:
        - sh
        - -c
        - |
          # 按 index 分片处理
          TOTAL=100000
          SHARDS=20
          SHARD_SIZE=$((TOTAL / SHARDS))
          START=$((JOB_COMPLETION_INDEX * SHARD_SIZE))
          END=$((START + SHARD_SIZE))
          # 从 MySQL 查询 START-END 范围的报告 ID，生成 PDF
          java -jar pdf-generator.jar --start=$START --end=$END
```

- 10w 报告分 20 片，每片 5000，每 Pod 处理 5000
- 5 并发，分 4 批跑完，每批约 30 分钟，总耗时约 2 小时
- 失败自动重试 3 次，超时 2 小时强制终止

#### 5. 啄木鸟云健康 5 个子系统 Workload 选型

##### 5.1 体检预约 Web 服务 -> Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: appointment-service
spec:
  replicas: 10
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 2          # 滚动时最多多 2 个 Pod
      maxUnavailable: 0    # 滚动时不允许少 Pod（保证可用性）
  template:
    spec:
      affinity:
        podAntiAffinity:   # 反亲和，分散到不同节点
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            podAffinityTerm:
              labelSelector:
                matchLabels:
                  app: appointment-service
              topologyKey: kubernetes.io/hostname
      containers:
      - name: app
        image: registry/zhuomu/appointment-service:1.5.0
        resources:
          requests: {cpu: 500m, memory: 1Gi}
          limits: {cpu: 1000m, memory: 2Gi}
        livenessProbe:
          httpGet: {path: /actuator/health/liveness, port: 8080}
        readinessProbe:
          httpGet: {path: /actuator/health/readiness, port: 8080}
        startupProbe:
          httpGet: {path: /actuator/health/liveness, port: 8080}
          failureThreshold: 30
          periodSeconds: 10
```

**工程理由**：
- 无状态、可水平扩展 -> Deployment
- 10 副本 + Pod 反亲和分散到不同节点，避免单节点宕机导致全部不可用
- maxUnavailable=0 保证滚动期间副本数不下降，配合 readinessProbe 实现零宕机
- startupProbe 给 Spring Boot 60s 启动时间

##### 5.2 Redis Cluster -> StatefulSet

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: redis-cluster
spec:
  serviceName: redis-cluster-headless
  replicas: 6  # 3 主 3 从
  podManagementPolicy: OrderedReady
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      partition: 0  # 滚动更新从最大序号开始
  template:
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchLabels:
                app: redis-cluster
            topologyKey: kubernetes.io/hostname  # 强制分散到不同节点
      containers:
      - name: redis
        image: redis:7.2-alpine
        command: ["redis-server", "/conf/redis.conf", "--cluster-enabled yes"]
        ports:
        - containerPort: 6379
        - containerPort: 16379  # cluster bus
        volumeMounts:
        - name: data
          mountPath: /data
        - name: conf
          mountPath: /conf
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: ["ReadWriteOnce"]
      storageClassName: fast-ssd
      resources:
        requests:
          storage: 50Gi
---
apiVersion: v1
kind: Service
metadata:
  name: redis-cluster-headless
spec:
  clusterIP: None  # Headless
  selector:
    app: redis-cluster
  ports:
  - name: client
    port: 6379
  - name: bus
    port: 16379
```

**工程理由**：
- 有状态、需稳定网络标识 -> StatefulSet
- 6 副本（3 主 3 从），Pod 名稳定 `redis-cluster-0` ~ `redis-cluster-5`
- Headless Service 暴露每个 Pod 的独立 DNS，客户端做 slot 路由
- 每副本独立 PVC（`data-redis-cluster-0` ~ `data-redis-cluster-5`）
- podAntiAffinity required 强制每副本不同节点，避免单节点宕机丢主从
- 滚动更新 partition 模式：先滚 redis-5/4/3，确认 OK 再滚 redis-2/1/0

##### 5.3 Filebeat 日志采集 -> DaemonSet

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: filebeat
  namespace: logging
spec:
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
  template:
    spec:
      serviceAccountName: filebeat
      hostNetwork: true
      dnsPolicy: ClusterFirstWithHostNet
      tolerations:
      - operator: Exists  # 容忍所有 taint，包括 master
      containers:
      - name: filebeat
        image: docker.elastic.co/beats/filebeat:8.10
        resources:
          requests: {cpu: 100m, memory: 100Mi}
          limits: {cpu: 200m, memory: 200Mi}
        volumeMounts:
        - name: varlog
          mountPath: /var/log
        - name: varlibdockercontainers
          mountPath: /var/lib/docker/containers
          readOnly: true
        - name: config
          mountPath: /etc/filebeat
      volumes:
      - name: varlog
        hostPath: {path: /var/log}
      - name: varlibdockercontainers
        hostPath: {path: /var/lib/docker/containers}
      - name: config
        configMap:
          name: filebeat-config
```

**工程理由**：
- 每节点一份 -> DaemonSet
- hostNetwork: true 直接用节点网络，不走 CNI，性能更好
- tolerations: Exists 容忍所有 taint，master 节点也要采集日志
- hostPath 挂载节点日志目录，访问容器日志文件
- maxUnavailable=1 节点级滚动，避免一次更新多个节点

##### 5.4 体检报告 PDF 批量生成 -> Indexed Job

见上文 4.5 详细方案。

**工程理由**：
- 一次性批处理任务 -> Job
- 数据量大需要分片并行 -> Indexed Job
- 失败自动重试 + 超时强制终止 + 完成后自动清理

##### 5.5 医保目录定时同步 -> CronJob

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: medical-insurance-sync
  namespace: zhuomu
spec:
  schedule: "0 2 * * *"  # 每天 2:00
  concurrencyPolicy: Forbid  # 上次没跑完不启动新的
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 5
  jobTemplate:
    spec:
      backoffLimit: 3
      activeDeadlineSeconds: 1800  # 30 分钟超时
      template:
        spec:
          restartPolicy: OnFailure
          containers:
          - name: sync
            image: registry/zhuomu/insurance-sync:1.2.0
            env:
            - name: SPRING_PROFILES_ACTIVE
              value: prod
            command:
            - java
            - -jar
            - sync.jar
            - --source=https://api.medical.gov.cn/catalog
            - --target=mysql://mysql-master:3306/medical
```

**工程理由**：
- 定时任务 -> CronJob
- concurrencyPolicy: Forbid 避免上次任务没跑完时再次启动，防止数据重复
- successfulJobsHistoryLimit=3 保留最近 3 次成功 Job 的日志，便于排查
- failedJobsHistoryLimit=5 保留更多失败 Job 历史
- 30 分钟超时防止任务卡死占用资源
- backoffLimit=3 失败自动重试 3 次

#### 与架构师水平的差距与补足方向

**差距1**：StatefulSet 生产实战经验不足，特别是 Redis Cluster Operator / Kafka Operator 等 Operator 模式
**补足**：研读 Redis Operator / Strimzi Kafka Operator 源码，理解 Operator 如何管理 StatefulSet 生命周期（扩缩、滚动、备份恢复）

**差距2**：Indexed Job 的工程化使用经验不足，公司批处理任务大多还是用 XXL-Job
**补足**：在啄木鸟云健康找一个批处理场景（如体检报告 PDF 批量生成），用 Indexed Job 重构，对比 XXL-Job 的优劣

**差距3**：DaemonSet 的滚动更新策略经验不足，特别是大规模集群（100+ 节点）的滚动节奏控制
**补足**：学习 DaemonSet 的 maxUnavailable 百分比配置，结合 PodDisruptionBudget 控制节点驱逐节奏

**差距4**：CronJob 的时区问题、concurrencyPolicy 选型经验不足
**补足**：研究 K8s 1.25+ 的 CronJob 时区支持（timeZone 字段），统一线上 CronJob 时区规范

---

## 题目二（架构设计题）：K8s 发布工程实战 - 滚动/蓝绿/金丝雀与回滚

啄木鸟云健康体检预约服务日均 50w 订单，每天发布 1-2 次，要求"零宕机发布 + 5 分钟回滚 + 灰度验证"。请你回答：

1. K8s Deployment 的滚动发布默认行为是什么？`maxSurge` / `maxUnavailable` 两个参数怎么影响发布速度与可用性？为什么"ReadinessProbe 没配好就上滚动发布"是灾难？滚动发布的 Pod 替换节奏与 Endpoints 联动机制？
2. 蓝绿发布、金丝雀发布在 K8s 中怎么实现？分别用什么资源（Deployment + Service Label / Ingress 流量切分 / Istio VirtualService）？蓝绿和金丝雀的本质差异？蓝绿发布"双倍资源"成本如何优化？
3. K8s Deployment 的回滚机制是怎么实现的？`kubectl rollout undo` 背后发生了什么？`revisionHistoryLimit` 默认 10 是否够用？回滚时如何避免"回到一个有问题的版本"？
4. HPA（HorizontalPodAutoscaler）在发布过程中扮演什么角色？`minReplicas` / `maxReplicas` / `scaleTargetRef` / `metrics` 怎么配？为什么"HPA + 滚动发布"可能"雪崩"？VPA、Cluster Autoscaler 与 HPA 的分工？
5. 设计啄木鸟云健康体检预约服务的发布工程方案：要求支持"金丝雀 5% 流量验证 30 分钟 -> 全量发布"、"5 分钟内完成回滚"、"发布期间不影响正常订单"、"支持多版本并行观察"。请画出架构图，说明涉及的 K8s 资源、Istio 资源、监控指标、回滚 SOP。

### 作答区

#### 1. Deployment 滚动发布机制

**默认滚动行为**：
- 默认 `strategy: RollingUpdate`，`maxSurge=25%`，`maxUnavailable=25%`
- 10 副本的 Deployment：先多起 2-3 个新 Pod（surge），等新 Pod Ready 后再杀 2-3 个旧 Pod，循环直到全部替换

**maxSurge / maxUnavailable 的工程含义**：

| 参数 | 含义 | 影响 |
|------|------|------|
| `maxSurge` | 滚动期间最多比期望副本数多多少 | 控制资源占用上限 |
| `maxUnavailable` | 滚动期间最多比期望副本数少多少 | 控制可用性下限 |

**10 副本的几种配置对比**：

| 配置 | 行为 | 适用场景 |
|------|------|---------|
| `maxSurge=2, maxUnavailable=0` | 最多 12 个 Pod，永不小于 10 | 高可用场景（推荐） |
| `maxSurge=0, maxUnavailable=2` | 最多 10 个 Pod，最少 8 个 | 资源紧张场景 |
| `maxSurge=10, maxUnavailable=0` | 一次性起 10 个新 Pod，全 Ready 后切流量 | 蓝绿发布（资源充足） |
| `maxSurge=1, maxUnavailable=1` | 慢速滚动，资源占用低 | 测试环境 |

**为什么"ReadinessProbe 没配好就上滚动发布"是灾难**：

1. **现象**：新 Pod 启动后，readinessProbe 没配或太松，Pod 还没真正 Ready 就被加进 Endpoints，流量打过去 5xx
2. **更严重的现象**：readinessProbe 太严，新 Pod 永远不 Ready，Deployment 卡在滚动中，maxSurge 占满资源，最终雪崩
3. **最严重的现象**：readinessProbe 和 livenessProbe 共用接口，启动慢被 livenessProbe 杀掉，CrashLoopBackOff，永远无法 Ready
4. **正确做法**：
   - readinessProbe 与 livenessProbe 必须分离（Spring Boot Actuator `/actuator/health/readiness` vs `/actuator/health/liveness`）
   - readinessProbe 必须检查"业务依赖"（DB/Redis/MQ 是否连通），而不只是进程存活
   - 配 startupProbe 给 Java 应用 60s+ 启动时间，避免 livenessProbe 在启动期杀 Pod

**滚动发布的 Pod 替换节奏与 Endpoints 联动**：

```
1. Deployment Controller 创建新 ReplicaSet，扩容新 Pod (rs-v2 0->1)
2. 新 Pod Pending -> Scheduler 调度 -> kubelet 拉镜像起容器
3. 新 Pod Running，但 readinessProbe 还没通过 -> 不加入 Endpoints
4. readinessProbe 通过 -> Endpoints Controller 把新 Pod 加入 Service Endpoints
5. kube-proxy 更新 iptables/ipvs 规则 -> 新 Pod 开始接流量
6. 同时旧 ReplicaSet 缩容 (rs-v1 10->9) -> 旧 Pod 进入 Terminating
7. Endpoints Controller 把旧 Pod 摘除 -> kube-proxy 更新规则 -> 旧 Pod 不接新流量
8. 旧 Pod 收到 SIGTERM，preStop hook 执行（如反注册到 Nacos），等待 terminationGracePeriodSeconds（默认 30s）
9. 旧 Pod 真正退出
10. 循环 1-9 直到所有 Pod 替换完成
```

**关键陷阱**：
- `terminationGracePeriodSeconds` 默认 30s，如果 preStop + 关闭流程超过 30s，Pod 会被 SIGKILL 强杀，请求丢失
- 旧 Pod 摘除与 SIGTERM 是并发的，kube-proxy 更新规则有 1-2s 延迟，期间流量还会打到旧 Pod
- **正确做法**：preStop 加 `sleep 5` 让 Pod 先等 5s 再开始关闭，等 kube-proxy 规则更新

```yaml
lifecycle:
  preStop:
    exec:
      command:
      - sh
      - -c
      - "sleep 5 && curl -X POST http://localhost:8080/actuator/shutdown"
```

#### 2. 蓝绿发布 vs 金丝雀发布

##### 2.1 蓝绿发布（Blue-Green Deployment）

**核心思想**：同时部署两套完整环境（蓝/绿），通过 Service Label 或 Ingress 一键切流量。

**K8s 实现（Deployment + Service Label）**：

```yaml
# 蓝环境（当前版本）
apiVersion: apps/v1
kind: Deployment
metadata:
  name: appointment-blue
spec:
  replicas: 10
  selector:
    matchLabels:
      app: appointment
      version: blue
  template:
    metadata:
      labels:
        app: appointment
        version: blue
    spec:
      containers:
      - image: registry/zhuomu/appointment:1.5.0
---
# 绿环境（新版本）
apiVersion: apps/v1
kind: Deployment
metadata:
  name: appointment-green
spec:
  replicas: 10
  selector:
    matchLabels:
      app: appointment
      version: green
  template:
    metadata:
      labels:
        app: appointment
        version: green
    spec:
      containers:
      - image: registry/zhuomu/appointment:1.6.0
---
# Service 通过 label 切换
apiVersion: v1
kind: Service
metadata:
  name: appointment
spec:
  selector:
    app: appointment
    version: blue  # 切流量时改为 green
  ports:
  - port: 80
```

**切流量操作**：
```bash
# 1. 部署绿环境
kubectl apply -f appointment-green.yaml

# 2. 等绿环境 Ready
kubectl wait --for=condition=ready pod -l app=appointment,version=green --timeout=300s

# 3. 切流量到绿
kubectl patch svc appointment -p '{"spec":{"selector":{"version":"green"}}}'

# 4. 观察 30 分钟，确认无问题
# 5. 删除蓝环境
kubectl delete deployment appointment-blue
```

##### 2.2 金丝雀发布（Canary Deployment）

**核心思想**：逐步把流量从旧版本切到新版本，先小流量验证再全量。

**K8s 实现方案对比**：

| 方案 | 实现 | 流量控制粒度 | 复杂度 |
|------|------|------------|-------|
| Deployment 副本数 | 旧版本 9 副本 + 新版本 1 副本 | 10% 流量 | 简单 |
| Service Label + 多 Deployment | 同上 | 10% 流量 | 简单 |
| Nginx Ingress Canary | ingress-nginx 的 canary annotation | 5%/10%/50% 流量 | 中等 |
| Istio VirtualService | weight 字段精确控制 | 1%/5%/10%/50% 流量 | 复杂但精确 |

**Istio VirtualService 金丝雀方案**：

```yaml
# Gateway + VirtualService 控制流量
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: appointment
spec:
  gateways: [appointment-gateway]
  http:
  - route:
    - destination:
        host: appointment-v1
        port: {number: 80}
      weight: 95  # 旧版本 95%
    - destination:
        host: appointment-v2
        port: {number: 80}
      weight: 5   # 新版本 5%
```

**Nginx Ingress 金丝雀方案**：

```yaml
# 主 Ingress
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: appointment
  annotations:
    nginx.ingress.kubernetes.io/canary: "true"
    nginx.ingress.kubernetes.io/canary-weight: "5"  # 5% 流量
spec:
  rules:
  - host: appointment.zhuomu.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: appointment-v2
            port: {number: 80}
```

##### 2.3 蓝绿 vs 金丝雀的本质差异

| 维度 | 蓝绿发布 | 金丝雀发布 |
|------|---------|-----------|
| 流量切换 | 一键全量切换 | 渐进式百分比切换 |
| 资源占用 | 双倍资源 | 增量资源（5% 副本） |
| 回滚速度 | 极快（改 label） | 较慢（要把流量切回去 + 缩容新版本） |
| 风险 | 切换瞬间风险集中 | 风险逐步暴露 |
| 适用场景 | 测试环境、版本升级大改 | 生产环境、小版本迭代 |
| 监控要求 | 切换前后对比 | 全程持续监控 |
| 复杂度 | 简单 | 中等（需要流量分流机制） |

**蓝绿发布的"双倍资源"成本优化**：

1. **绿环境缩容待命**：平时蓝环境 10 副本，绿环境只起 1 副本（保持镜像预热），切流量前扩容到 10
2. **混合部署**：蓝绿环境共享节点池，绿环境用低优先级（PriorityClass）抢占式部署
3. **Serverless/EKS Fargate**：用 Fargate 等无服务器方案，绿环境按需启动，不长期占用资源
4. **金丝雀代替蓝绿**：把蓝绿改成"95% + 5%"的金丝雀，省一半资源

#### 3. Deployment 回滚机制

**Rollout 历史与 ReplicaSet 保留**：

```bash
# 查看发布历史
kubectl rollout history deployment appointment

# 输出
deployment.apps/appointment
REVISION  CHANGE-CAUSE
1         kubectl apply --filename=appointment-v1.yaml
2         kubectl apply --filename=appointment-v2.yaml
3         kubectl apply --filename=appointment-v3.yaml

# 查看某个 revision 详情
kubectl rollout history deployment appointment --revision=2

# 回滚到上一版本
kubectl rollout undo deployment appointment

# 回滚到指定版本
kubectl rollout undo deployment appointment --to-revision=1

# 查看发布状态
kubectl rollout status deployment appointment
```

**回滚背后发生了什么**：

1. 每个 Deployment 版本对应一个 ReplicaSet（RS），RS 用 template hash 区分
2. 默认保留 10 个历史 RS（`revisionHistoryLimit: 10`），老的 RS 被删除（Pod 已被回收，只剩 RS 元数据）
3. `rollout undo` 操作：
   - 找到目标 RS（如 revision=1 的 RS）
   - 把目标 RS 的 replicas 扩到期望副本数
   - 把当前 RS 的 replicas 缩到 0
   - **本质 = 反向滚动更新**，同样受 maxSurge/maxUnavailable 控制

**revisionHistoryLimit 是否够用**：

- 默认 10 偏紧，生产建议设为 20-50
- 每天发布 2 次，10 个 revision 只能保留 5 天历史
- 回滚到 5 天前的版本会发现 RS 已被删除，无法 `rollout undo`，只能重新 apply
- **正确做法**：把 `revisionHistoryLimit: 50`，并配合 GitOps（ArgoCD/Flux）从 Git 历史回滚

**回滚时如何避免"回到一个有问题的版本"**：

1. **回滚前先验证目标 revision 的 YAML**：`kubectl rollout history deployment xxx --revision=N -o yaml`
2. **不要回滚"修复了 bug 又引入新 bug"的版本**：如果 v2 修了 v1 的安全漏洞，回滚到 v1 重新暴露漏洞
3. **回滚后立即标记**：回滚的版本要打 `change-cause` 标签，避免再次误用
4. **配合 GitOps**：从 Git 历史回滚，保留完整变更追溯

**生产实战 SOP**：

```bash
# 1. 发现问题（监控告警）
# 2. 立即回滚（5 分钟内）
kubectl rollout undo deployment appointment --to-revision=2

# 3. 验证回滚
kubectl rollout status deployment appointment
watch kubectl get pods -l app=appointment

# 4. 监控指标回归正常
# 5. 复盘，把有问题的 revision 打 tag 避免再次使用
kubectl annotate deployment appointment kubernetes.io/change-cause="rollback from broken v3"
```

#### 4. HPA 与发布的联动

##### 4.1 HPA 核心配置

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: appointment
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: appointment
  minReplicas: 5
  maxReplicas: 50
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 60  # 平均 CPU 60%
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 70
  - type: Pods
    pods:
      metric:
        name: http_requests_per_second
      target:
        type: AverageValue
        averageValue: "1000"  # 每 Pod 1000 QPS
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 0  # 立即扩容
      policies:
      - type: Percent
        value: 100  # 每次最多翻倍
        periodSeconds: 60
    scaleDown:
      stabilizationWindowSeconds: 300  # 5 分钟稳定期才缩容
      policies:
      - type: Percent
        value: 10  # 每次最多缩 10%
        periodSeconds: 60
```

##### 4.2 HPA + 滚动发布的"雪崩"场景

**典型雪崩过程**：

1. 业务高峰期，10 副本 CPU 80%，HPA 扩容到 15 副本
2. 此时发布 v2 版本，滚动替换 Pod
3. 新 Pod 启动期间，CPU 采样受 JVM JIT 影响偏高，HPA 持续扩容
4. 旧 Pod 缩容时（maxUnavailable=0），新 Pod 还在启动，副本数飙升到 30
5. 节点资源不足，新 Pod Pending，无法 Ready
6. 旧 Pod 全部被替换，新 Pod 没起来，服务雪崩

**根因**：
- HPA 的 CPU 采样受 JVM 启动期 JIT 影响，启动期 CPU 飙高
- 滚动发布的 Pod 替换与 HPA 的扩缩容冲突
- 缩容的旧 Pod 副本数算在 maxUnavailable 里，与 HPA 的目标副本数叠加

**避免雪崩的方案**：

1. **发布期间禁用 HPA 缩容**：
   ```yaml
   behavior:
     scaleDown:
       stabilizationWindowSeconds: 600  # 发布期间设为 10 分钟
   ```
2. **避开业务高峰发布**：选择业务低峰期（如凌晨 2 点）
3. **小批量滚动**：`maxSurge=1, maxUnavailable=0`，慢但稳
4. **预热新 Pod**：启动期通过 startupProbe 接管 liveness，避免 CrashLoop
5. **配合 VPA**：用 VPA 调整 Requests，避免资源不足导致 Pending

##### 4.3 HPA / VPA / Cluster Autoscaler 的分工

| 机制 | 作用层 | 调整维度 | 适用场景 |
|------|-------|---------|---------|
| HPA | Pod | 副本数（横向） | 流量波动、QPS 变化 |
| VPA | Pod | Requests/Limits（纵向） | 内存泄漏、CPU 估算不准 |
| Cluster Autoscaler | Node | 节点数 | 节点池容量不足 |
| Karpenter | Node | 节点类型 + 数量 | AWS 上更灵活的节点伸缩 |

**三者协作**：
- HPA 横向扩容 -> 副本数增加 -> 节点资源不够 -> Cluster Autoscaler 加节点
- VPA 调整 Requests -> Pod 重新调度（VPA 推荐用 InPlacePodVerticalScaling，K8s 1.27+ Alpha）
- **HPA 与 VPA 不能同时用于同一维度**（HPA 按 CPU 扩容 + VPA 调 CPU Requests 会冲突）

#### 5. 啄木鸟云健康体检预约服务发布工程方案

##### 5.1 整体架构

```
                          ┌─────────────────────────┐
                          │   外部流量（用户/App）    │
                          └────────────┬─────────────┘
                                       │
                                       ▼
                          ┌─────────────────────────┐
                          │   阿里云 SLB / AWS ALB    │
                          └────────────┬─────────────┘
                                       │
                                       ▼
                          ┌─────────────────────────┐
                          │  Istio IngressGateway    │
                          │   (DaemonSet, 多副本)    │
                          └────────────┬─────────────┘
                                       │
                                       ▼
                          ┌─────────────────────────┐
                          │  Istio VirtualService     │
                          │  weight: v1=95, v2=5     │
                          └────────────┬─────────────┘
                                       │
                       ┌───────────────┴────────────────┐
                       │                                 │
                       ▼                                 ▼
            ┌────────────────────┐            ┌────────────────────┐
            │  Deployment v1     │            │  Deployment v2     │
            │  appointment-v1    │            │  appointment-v2    │
            │  replicas: 10      │            │  replicas: 1       │
            │  (蓝/旧版本)       │            │  (金丝雀/新版本)   │
            └─────────┬──────────┘            └─────────┬──────────┘
                      │                                 │
                      └────────────┬────────────────────┘
                                   │
                                   ▼
                          ┌─────────────────────────┐
                          │   Service Endpoints      │
                          │   (readinessProbe 联动)  │
                          └────────────┬─────────────┘
                                       │
                                       ▼
                          ┌─────────────────────────┐
                          │   业务依赖层              │
                          │  MySQL / Redis / MQ     │
                          └─────────────────────────┘
```

##### 5.2 涉及的 K8s 资源

| 资源 | 用途 | 关键配置 |
|------|------|---------|
| Deployment v1 | 旧版本 | replicas=10, 反亲和, PDB |
| Deployment v2 | 新版本（金丝雀） | replicas=1, 反亲和, 同 Service |
| Service | 内部负载均衡 | selector: app=appointment（不区分版本） |
| PodDisruptionBudget | 防止驱逐过多 Pod | minAvailable=70% |
| HPA | 自动伸缩 | min=5, max=50 |
| ConfigMap | 配置 | 双版本共享，避免重复 |
| Secret | 敏感配置 | 双版本共享 |

##### 5.3 涉及的 Istio 资源

```yaml
# DestinationRule 定义两个版本子集
apiVersion: networking.istio.io/v1beta1
kind: DestinationRule
metadata:
  name: appointment
spec:
  host: appointment
  subsets:
  - name: v1
    labels: {version: v1}
  - name: v2
    labels: {version: v2}
---
# VirtualService 控制流量比例
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: appointment
spec:
  gateways: [appointment-gateway]
  http:
  - match:
    - headers:
        x-canary:
          exact: "true"  # 带 x-canary: true 头的流量 100% 到 v2
    route:
    - destination:
        host: appointment
        subset: v2
      weight: 100
  - route:
    - destination:
        host: appointment
        subset: v1
      weight: 95
    - destination:
        host: appointment
        subset: v2
      weight: 5
```

##### 5.4 发布 SOP（金丝雀 5% -> 全量）

```
[阶段0: 准备]
  - 发布前 30 分钟，确认 HPA 行为稳定
  - 在 Prometheus 验证 baseline 指标（错误率、延迟、QPS）
  - 准备好回滚脚本

[阶段1: 部署金丝雀 v2]
  kubectl apply -f appointment-v2-deployment.yaml
  kubectl wait --for=condition=ready pod -l app=appointment,version=v2 --timeout=300s
  # v2 副本数 = 1（占 v1 的 10%，权重 5%）

[阶段2: 切 5% 流量到 v2]
  kubectl apply -f appointment-virtualservice-canary.yaml  # v2 weight=5
  # 观察 30 分钟
  - 错误率 < 0.1%
  - P99 延迟 < baseline + 10%
  - 业务指标：下单成功率、支付成功率

[阶段3: 切 50% 流量]
  # 如果阶段 2 OK
  kubectl patch virtualservice appointment --type=json \
    -p='[{"op":"replace","path":"/spec/http/1/route/0/weight","value":50},{"op":"replace","path":"/spec/http/1/route/1/weight","value":50}]'
  kubectl scale deployment appointment-v2 --replicas=5  # 同步扩容 v2
  # 观察 15 分钟

[阶段4: 全量切换]
  kubectl patch virtualservice appointment --type=json \
    -p='[{"op":"replace","path":"/spec/http/1/route/0/weight","value":0},{"op":"replace","path":"/spec/http/1/route/1/weight","value":100}]'
  kubectl scale deployment appointment-v2 --replicas=10
  kubectl scale deployment appointment-v1 --replicas=0
  # 观察 30 分钟，确认稳定后删除 v1
  kubectl delete deployment appointment-v1
```

##### 5.5 监控指标体系

| 指标类别 | 指标 | 阈值 |
|---------|------|------|
| 流量 | v1/v2 QPS 对比 | v2 QPS 与权重比例匹配 |
| 错误 | v1/v2 5xx 错误率 | v2 错误率 &lt; v1 |
| 延迟 | v1/v2 P99/P95 延迟 | v2 P99 &lt; baseline + 10% |
| 业务 | 下单成功率、支付成功率 | 不低于 baseline |
| 资源 | Pod CPU/内存 | 不超 80% |
| K8s | Pod Ready 状态、重启次数 | 0 重启 |
| HPA | 当前副本数、目标副本数 | 不持续震荡 |

##### 5.6 5 分钟回滚 SOP

```bash
# 立即切回 v1（5 秒）
kubectl patch virtualservice appointment --type=json \
  -p='[{"op":"replace","path":"/spec/http/1/route/0/weight","value":100},{"op":"replace","path":"/spec/http/1/route/1/weight","value":0}]'

# 等 v1 流量恢复（30 秒）
sleep 30 && kubectl get pods -l app=appointment,version=v1

# 缩容 v2（30 秒）
kubectl scale deployment appointment-v2 --replicas=0

# 验证业务恢复（4 分钟）
# - 监控错误率回到 baseline
# - 业务指标正常

# 总耗时：< 5 分钟
```

##### 5.7 多版本并行观察

- v1/v2 长期共存（如灰度发布 1 小时观察期）
- 通过 Istio 的 `x-canary` header 做白名单灰度（产品经理 / 测试团队的流量 100% 到 v2）
- 通过 Istio Telemetry 收集 v1/v2 的详细指标对比
- v2 验证 24 小时无问题后再下线 v1

#### 与架构师水平的差距与补足方向

**差距1**：金丝雀发布的工程化实战不足，公司大多还是简单的滚动发布
**补足**：引入 Argo Rollouts 或自研基于 Istio 的金丝雀控制器，把发布策略从手动 SOP 升级为自动化流水线

**差距2**：HPA + 滚动发布的雪崩场景没有压测验证
**补足**：用 Chaos Mesh 在测试集群做"HPA + 滚动发布 + 流量突增"的混沌实验，验证雪崩场景与防御方案

**差距3**：PodDisruptionBudget 与 PVP（PodVerticalPreflight）等高级发布保障机制不熟
**补足**：研究 PDB 在节点维护、Cluster Autoscaler 缩容时的作用，制定线上 PDB 规范

**差距4**：GitOps（ArgoCD/Flux）的回滚机制与 K8s 原生 `rollout undo` 的协同不熟
**补足**：学习 ArgoCD 的"回滚即把 Git HEAD 指向旧 commit"模式，对比 K8s 原生回滚的优劣

**差距5**：Spring Boot 优雅停机与 K8s preStop 的配合经验不足
**补足**：研究 Spring Boot 2.3+ 的 graceful shutdown，结合 K8s preStop + terminationGracePeriodSeconds 设计零请求丢失的优雅停机方案

---

## 能力差距梳理（Day02）

> 后续将统一汇总到 `架构师学习-能力差距梳理.md`

### 差距1：StatefulSet 生产实战经验不足
> Day2发现

- **现状**：知道 StatefulSet 三大特性（稳定标识/稳定存储/有序部署），但 Redis Cluster、Kafka 等有状态服务的 Operator 模式（如 Redis Operator、Strimzi Kafka Operator）没用过，生产部署还是手写 StatefulSet YAML
- **架构师水平**：能基于 Operator 管理有状态服务生命周期（扩缩、滚动、备份恢复、故障转移），能自研简单的 Operator（如医疗 IM 长连接网关的状态管理）
- **补足方向**：
  - 研读 Redis Operator / Strimzi Kafka Operator 源码
  - 学习 Operator SDK / Kubebuilder，自研一个简单的 Operator
  - 在啄木鸟云健康测试集群验证 Redis Operator 部署 Redis Cluster

### 差距2：Indexed Job 的工程化使用经验不足
> Day2发现

- **现状**：知道 Indexed Job 是 K8s 1.24 GA，但公司批处理任务大多还是用 XXL-Job 或自研调度器
- **架构师水平**：能根据批处理场景（数据量、单任务耗时、并行度）选择合适方案（Indexed Job vs Job+工作队列 vs XXL-Job vs Airflow），能设计分片策略与失败重试机制
- **补足方向**：
  - 在啄木鸟云健康找一个批处理场景（如体检报告 PDF 批量生成）用 Indexed Job 重构
  - 对比 XXL-Job 的优劣（任务可视化、分片机制、失败告警）
  - 学习 K8s 1.27+ 的 Job Pod Failure Policy 新特性

### 差距3：DaemonSet 大规模集群的滚动节奏控制经验不足
> Day2发现

- **现状**：知道 DaemonSet 每节点一份，但大规模集群（100+ 节点）的滚动节奏（maxUnavailable 百分比、节点分批、PodDisruptionBudget 配合）经验不足
- **架构师水平**：能为 100+ 节点集群设计 DaemonSet 滚动方案（按节点池分批、PDB 保护、监控告警），能在不影响业务的情况下完成日志/监控 Agent 升级
- **补足方向**：
  - 学习 DaemonSet 的 maxUnavailable 百分比配置
  - 研究节点池（NodePool）+ DaemonSet 的分批滚动
  - 学习 PodDisruptionBudget 在 DaemonSet 滚动中的应用

### 差距4：金丝雀发布的工程化实战不足
> Day2发现，延续第5周差距（微服务）

- **现状**：公司大多还是简单的滚动发布，金丝雀发布停留在"Istio VirtualService weight 改一下"的手动操作，没有完整的金丝雀流水线（自动切流量、自动监控、自动回滚）
- **架构师水平**：能基于 Argo Rollouts 或自研控制器设计完整金丝雀流水线（5% -> 50% -> 100%，每阶段自动验证指标、自动回滚），能集成 Prometheus/SkyWalking 做指标驱动的发布决策
- **补足方向**：
  - 学习 Argo Rollouts 的 AnalysisTemplate 与 metric-based 回滚
  - 在啄木鸟云健康测试集群搭建 Argo Rollouts + Istio 金丝雀流水线
  - 研究基于业务指标（下单成功率）的金丝雀验证，而非只看 HTTP 5xx

### 差距5：HPA + 滚动发布的雪崩场景没有压测验证
> Day2发现

- **现状**：知道 HPA + 滚动发布可能雪崩，但没有压测验证过雪崩场景，防御方案（发布期间禁用 HPA 缩容）只是理论
- **架构师水平**：能用 Chaos Mesh 做"HPA + 滚动发布 + 流量突增"的混沌实验，验证雪崩场景与防御方案，能基于压测结果制定发布期间的 HPA 行为策略
- **补足方向**：
  - 在测试集群用 Chaos Mesh + k6 做 HPA 雪崩压测
  - 验证 HPA scaleDown.stabilizationWindowSeconds 对雪崩的防御效果
  - 研究业务低峰期发布窗口的选取策略

### 差距6：Spring Boot 优雅停机与 K8s preStop 配合不深
> Day2发现，延续第5周差距（微服务）

- **现状**：知道 K8s preStop + terminationGracePeriodSeconds，但 Spring Boot 2.3+ 的 graceful shutdown 配置不熟，发布期间偶有请求丢失
- **架构师水平**：能设计零请求丢失的优雅停机方案（preStop sleep + Spring Boot graceful shutdown + readinessProbe 摘流量 + 自定义关闭钩子），能基于压测验证发布期间零请求丢失
- **补足方向**：
  - 学习 Spring Boot 2.3+ 的 `server.shutdown.grace-period` 配置
  - 在啄木鸟云健康测试集群压测发布期间请求丢失率
  - 制定 Spring Boot 应用优雅停机配置规范

### 差距7：GitOps（ArgoCD/Flux）的发布与回滚机制不熟
> Day2发现

- **现状**：公司发布大多是 `kubectl apply` 手动操作或 CI/CD 流水线直接 apply，没有用 GitOps 工具
- **架构师水平**：能基于 ArgoCD/Flux 设计 GitOps 发布流程（Git PR -> 自动同步 -> 多环境 rollout），能用 Git 历史做回滚（Git revert 触发 ArgoCD 同步）
- **补足方向**：
  - 在测试集群搭建 ArgoCD，把现有 K8s YAML 接入 GitOps
  - 学习 ArgoCD 的 ApplicationSet 多环境发布
  - 对比 ArgoCD 回滚 vs K8s 原生 `rollout undo` 的差异

### 差距8：Workload 与往周专题的衔接认知不深
> Day2发现，延续第5周差距（微服务）

- **现状**：K8s Workload 与往周专题（Redis Cluster 部署、Kafka 部署、医疗 IM 长连接）的衔接认知不深
- **架构师水平**：能讲清"K8s 原生 Workload vs 中间件 Operator"的边界（如 K8s StatefulSet 提供基础，Operator 提供业务生命周期管理），能根据业务阶段选择合适方案
- **补足方向**：
  - 对比 K8s 原生 StatefulSet 部署 Redis vs Redis Operator（扩缩容、故障转移、备份恢复的自动化程度）
  - 学习 Strimzi Kafka Operator 的 CRD 设计
  - 研究医疗 IM 长连接网关在 K8s 上的 Workload 选型（StatefulSet + 稳定标识 vs Deployment + SessionAffinity）

---