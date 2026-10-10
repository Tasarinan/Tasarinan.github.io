# 架构师学习-Day01-K8s 核心架构与 Pod 容器设计模式

> 日期：2026年07月20日（周一）
> 周主题：K8s 与云原生专题
> 出题日：Day01 - K8s 核心架构与 Pod 容器设计模式

---

## 背景

经过 8 周专题（CAP/MQ/微服务/MySQL/Redis/ES/限流降级/支付）+ 2 周医疗专题，我们已经把"业务 + 中间件 + 数据 + 流量治理 + 行业"五条主线打穿。从本周开始回归架构师通用专题，进入 **K8s 与云原生** —— 这是过去几年我们一直在用但一直没专门梳理的"底层底座"。

为什么把 K8s 放到现在：

1. **前置专题已经把"为什么需要 K8s"磨出来**：
   - 微服务专题的"服务注册发现 + 配置中心 + 网关 + 链路追踪"，K8s 原生提供（DNS + ConfigMap + Ingress + Service Mesh）
   - 限流降级专题的"Sentinel 集群限流需要 Token Server"，K8s 的"统一流量入口 + Service Mesh"可以让限流下沉到基础设施
   - 支付专题的"幂等 + 多可用区容灾"，K8s 的"Deployment 多副本 + Pod 反亲和 + 滚动更新"是标准解法
   - 医疗专题的"互联网医院多医院隔离 + 监管合规"，K8s 的"Namespace + NetworkPolicy + ResourceQuota"提供原生隔离

2. **架构师面试的高频考点**：
   - K8s 调度原理、Pod 状态机、Service 转发原理、etcd 一致性、HPA/VPA、滚动发布回滚、Operator 模式、Service Mesh
   - 中高级架构师岗位几乎必问 K8s，且不止"会用"，要求"懂原理 + 能调优 + 能排障"

3. **用户的业务现实**：
   - 啄木鸟云健康的智慧体检/公卫服务，部分已上 K8s（按用户口述），但偏"会用"层面
   - 跳槽到更好的医疗公司，中大型医疗 SaaS / 互联网医院平台基本都基于 K8s + Service Mesh 构建
   - 用户的"完整秒杀系统经验"如果跑在 K8s 上，弹性伸缩、流量调度、灰度发布的工程深度会再上一个台阶

4. **云原生的全链路价值**：
   - 不只是容器编排，而是"声明式 API + 控制器模式 + 不可变基础设施 + 服务网格 + 可观测性 + GitOps"一整套范式
   - 理解了 K8s，回过头看 Nacos/Sentinel/Seata 的设计，会发现"控制面 + 数据面"的范式无处不在

本周安排：

| Day | 主题 | 关键考点 |
|-----|------|---------|
| Day01 | K8s 核心架构与 Pod 容器设计模式 | 控制面/数据面组件、Pod 模型、Pause 容器、Sidecar/Ambassador/Adapter、Init Container、探针 |
| Day02 | Workload 编排与发布工程 | Deployment/StatefulSet/DaemonSet/Job/CronJob、滚动/蓝绿/金丝雀、回滚机制 |
| Day03 | Service 与网络模型 | Service/Ingress、kube-proxy iptables vs ipvs、CNI、CoreDNS、NetworkPolicy |
| Day04 | 存储卷与配置管理 | PV/PVC/StorageClass、CSI、ConfigMap/Secret、有状态服务 |
| Day05 | 调度与资源治理 | Requests/Limits/QoS、亲和性/污点容忍/优先级、HPA/VPA/CA、调度器扩展 |
| Day06 | 串联整合 | 云原生微服务全链路架构设计（接入 + 业务 + 数据 + 治理 + 可观测性） |
| Day07 | 架构深挖 | K8s 调度器底层原理与 etcd 一致性（或 Istio xDS 协议） |

Day01 我们先打两根地基：

- **题目一（架构设计题）**：K8s 核心组件架构与控制面高可用 —— 解决"K8s 由什么组成、组件怎么协作、控制面怎么高可用"的体系化认知
- **题目二（架构设计题）**：Pod 模型与多容器设计模式 —— 解决"为什么不是直接管容器、Pod 内多容器如何协作、设计模式怎么落地"的工程化认知

---

## 题目一（架构设计题）：K8s 核心组件架构与控制面高可用

假设你作为新公司的架构师，接手一套"自建 K8s 生产集群"的方案设计。集群规模预估：3 master + 30 worker，承载 20+ 微服务、5000+ Pod、日均 10 亿次请求。请你回答：

1. 列出 K8s 的核心组件，按"控制面 / 数据面 / 节点组件"分类，并说明每个组件的职责、监听端口、是否无状态、是否多副本。`kube-apiserver`、`etcd`、`kube-scheduler`、`kube-controller-manager`、`kubelet`、`kube-proxy`、`coredns` 分别在请求链路中扮演什么角色？
2. 一个 `kubectl apply -f deployment.yaml` 命令的完整链路是怎样的？从命令行到 etcd 落盘，再到 Pod 真正起来，每一跳走的是哪个组件、什么协议、什么状态机？为什么 K8s 选 etcd 而不是 MySQL/Redis 作为底层存储？
3. K8s 控制面的高可用有"堆叠式（stacked）"和"外部 etcd（external）"两种拓扑，二者差异是什么？生产环境为什么一般选外部 etcd？3 master 集群里 etcd 应该部署几个节点，为什么是奇数？etcd 出现脑裂会怎样？
4. `kube-scheduler` 和 `kube-controller-manager` 都是"多副本部署但只有 leader 工作"的组件，leader 选举是怎么实现的？基于什么资源？如果 leader 节点宕机，新 leader 切换需要多久，期间业务是否受影响？
5. 生产环境 API Server 的性能瓶颈通常在哪？如何评估"API Server 的 QPS 上限"？`--max-requests-inflight`、`--max-mutating-requests-inflight`、`Priority and Fairness` 各解决什么问题？为什么大集群必须开启 Priority and Fairness？

### 作答区

#### 1. K8s 核心组件分类与职责

K8s 是一个典型的"控制面 + 数据面 + 节点组件"分层架构，组件协作通过"声明式 API + 控制器模式 + watch 机制"驱动。

```
┌────────────────────────────────────────────────────────────────────┐
│                       控制面（Control Plane）                       │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐  │
│  │ kube-apiserver   │  │      etcd        │  │ kube-scheduler   │  │
│  │ (无状态, 多副本)  │◄─│  (有状态, Raft)  │  │ (Leader 选举)    │  │
│  │  :6443 HTTPS     │  │  :2379/:2380     │  │                  │  │
│  └────────┬─────────┘  └──────────────────┘  └──────────────────┘  │
│           │                                                        │
│           │ watch                                                  │
│           ▼                                                        │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐  │
│  │ kube-controller  │  │ cloud-controller │  │    coredns       │  │
│  │ -manager (Leader)│  │ -manager         │  │  (Deployment)    │  │
│  │ 内含 N 个控制器  │  │ (云厂商集成)     │  │   :53            │  │
│  └──────────────────┘  └──────────────────┘  └──────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
                 │ API Server  HTTPS :6443
                 ▼
┌────────────────────────────────────────────────────────────────────┐
│                  节点组件（每个 Worker/Master 节点）                │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐  │
│  │    kubelet       │  │   kube-proxy     │  │   容器运行时      │  │
│  │ :10250 HTTPS     │  │ (iptables/ipvs)  │  │ containerd/CRI-O │  │
│  │ 节点 agent       │  │ Service 转发     │  │   dockershim     │  │
│  └──────────────────┘  └──────────────────┘  └──────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
```

**控制面组件**：

| 组件 | 职责 | 监听端口 | 状态 | 多副本方式 |
|------|------|---------|------|-----------|
| kube-apiserver | 唯一入口，提供 RESTful API，做认证/鉴权/准入控制/etcd 读写 | 6443 (HTTPS) | 无状态 | 多副本，前置 LB |
| etcd | 强一致性 KV 存储，存所有集群状态（资源对象、配置、Secret） | 2379 (client) / 2380 (peer) | 有状态 | Raft 协议，奇数节点 |
| kube-scheduler | 调度器，决定 Pod 落到哪个节点（资源、亲和性、污点、优先级） | 10259 (HTTPS, /healthz) | 无状态（leader 工作） | Leader 选举 |
| kube-controller-manager | 控制器集合（Deployment/ReplicaSet/Node/Endpoint/Job 等），驱动"期望状态 -> 实际状态" | 10257 (HTTPS, /healthz) | 无状态（leader 工作） | Leader 选举 |
| cloud-controller-manager | 云厂商集成控制器（路由、负载均衡、节点生命周期），自建机房可不用 | 10258 (HTTPS) | 无状态 | Leader 选举 |

**节点组件**（每个节点都跑）：

| 组件 | 职责 | 端口 | 状态 |
|------|------|-----|------|
| kubelet | 节点 agent，向 API Server 注册节点，按 PodSpec 拉起/销毁容器，做健康检查、资源上报 | 10250 (HTTPS) | 节点本地一个 |
| kube-proxy | 维护 Service -> Pod 的转发规则（iptables 或 ipvs 模式），处理 ClusterIP/NodePort 流量 | 10256 (metrics) | 节点本地一个 |
| 容器运行时 | 真正跑容器（containerd / CRI-O），通过 CRI 接口被 kubelet 调用 | - | 节点本地一个 |
| CNI 插件 | 为 Pod 分配 IP、配置网络（Calico / Flannel / Cilium） | - | 节点本地一个 |

**附加组件**：

| 组件 | 职责 |
|------|------|
| coredns | 集群内 DNS，提供 Service 域名解析（如 `svc.namespace.svc.cluster.local`） |
| Ingress Controller | 七层流量入口（Nginx Ingress / Traefik / APISIX），将外部 HTTP/HTTPS 流量路由到 Service |
| Metrics Server | 资源指标采集（CPU/内存），供 HPA 使用 |
| Prometheus + Grafana | 监控指标存储与展示 |

**链路中的角色**（以访问 `http://api.example.com/users` 为例）：

```
用户 -> DNS 解析 -> LB（云厂商 ELB/SLB）-> Ingress Controller (Pod) 
     -> Service (ClusterIP, kube-proxy 维护的规则) 
     -> Pod (业务容器, Service Mesh Sidecar) 
     -> 数据库/中间件
```

每个组件的角色：
- **kube-apiserver**：业务 Pod 启动时会调用 API Server（通过 ServiceAccount Token）拉取 ConfigMap/Secret，业务本身不直接打 API Server
- **etcd**：存 Service、Endpoints、Pod 等所有对象。Endpoint 控制器 watch Service 变化，更新 Endpoints
- **kube-scheduler**：当 Deployment 控制器创建 Pod（PodSpec 中 `nodeName` 为空）时，调度器决定 nodeName
- **kube-controller-manager**：Endpoint 控制器 watch Service 和 Pod，维护 Service -> Pod IP 列表
- **kubelet**：在 Pod 被调度到本节点后，调用容器运行时拉起容器
- **kube-proxy**：watch Service/Endpoints 变化，把 ClusterIP -> Pod IP 的转发规则写到 iptables/ipvs
- **coredns**：当业务通过 `my-svc.my-ns.svc.cluster.local` 访问 Service 时，coredns 返回 ClusterIP

#### 2. `kubectl apply` 的完整链路

以 `kubectl apply -f deployment.yaml` 创建一个 Deployment 为例，链路如下：

```
1. kubectl 读取 yaml，本地 schema 校验
        │
        │ HTTPS + kubeconfig (客户端证书/Token)
        ▼
2. kube-apiserver 接收
   │  a. Authentication（认证）：客户端证书 / Token / OIDC
   │  b. Authorization（鉴权）：RBAC，校验用户/SA 是否有 create deployments 权限
   │  c. Admission（准入控制）：
   │     - MutatingAdmissionWebhook：可改对象（如注入 Sidecar、默认 SA、默认节点选择器）
   │     - ValidatingAdmissionWebhook：校验对象（如 OPA Gatekeeper 校验标签/资源限制）
   │     - 内置准入插件：NamespaceLifecycle、ResourceQuota、LimitRanger、ServiceAccount
   │  d. 序列化（protobuf/json）写入 etcd
        │
        │ gRPC + TLS
        ▼
3. etcd 持久化 Deployment 对象
   │  - 写入 /registry/deployments/<namespace>/<name>
   │  - Raft 协议同步到多数节点后返回成功
        │
        ▼
4. Deployment 控制器（在 kube-controller-manager 中）watch 到新 Deployment
   │  - 期望状态: replicas=3
   │  - 实际状态: 0 个 Pod
   │  - 创建 ReplicaSet（OwnerReference 指向 Deployment）
        │
        ▼
5. ReplicaSet 控制器 watch 到新 ReplicaSet
   │  - 期望 replicas=3
   │  - 创建 3 个 Pod（PodSpec.nodeName 为空）
        │
        ▼
6. kube-scheduler watch 到 nodeName 为空的 Pod
   │  - 预选（Predicates）：资源是否够、节点是否污点、亲和性是否匹配
   │  - 优选（Priorities）：资源均衡、亲和性权重、反亲和性
   │  - 选定节点，更新 Pod.spec.nodeName
        │
        ▼
7. 目标节点的 kubelet watch 到 nodeName = 本节点的 Pod
   │  - 调用 CRI（容器运行时接口）创建 Pause 容器（先创建）
   │  - 调用 CNI 为 Pod 分配 IP、配置虚拟网卡
   │  - 拉业务镜像、创建业务容器（共享 Pause 的 network namespace）
   │  - 调用 CSI 挂载存储卷
   │  - 启动 livenessProbe/readinessProbe 探针
        │
        ▼
8. Pod 状态变为 Running
   │  - kubelet 上报 Pod 状态到 API Server -> etcd
        │
        ▼
9. Endpoint 控制器 watch 到 Pod ready
   │  - 把 Pod IP 加入 Service 的 Endpoints
        │
        ▼
10. kube-proxy watch 到 Endpoints 变化
    │  - 更新 iptables/ipvs 规则：ClusterIP -> [PodIP1, PodIP2, PodIP3]
        │
        ▼
11. 业务可访问
    - 其他 Pod 通过 Service 域名 -> ClusterIP -> iptables DNAT -> Pod IP
```

**为什么选 etcd 而不是 MySQL/Redis**：

1. **强一致性 + 高可用**：etcd 用 Raft 协议，多数派写入即可保证线性一致；MySQL 主从是异步/半同步，可能丢数据；Redis 主从异步，更不能用于强一致场景
2. **watch 机制**：etcd 原生支持 watch（基于 MVCC 多版本），K8s 所有控制器都靠 watch 驱动。MySQL 没有原生 watch，需要轮询；Redis 有 keyspace notification 但不稳定
3. **MVCC 多版本**：etcd 每次写都生成新版本（revision），支持历史查询、回滚。K8s 的 `kubectl rollout history` 就是基于 etcd 的 revision
4. **事务与乐观锁**：etcd 支持 `compare-and-swap`（基于 mod_revision），K8s 所有更新都是"读-改-写"的乐观锁，避免并发覆盖
5. **轻量 + 高性能**：etcd 用 Go 写，单二进制部署，读写性能足够（万级 QPS）。MySQL 太重，Redis 没有强一致
6. **专用场景**：etcd 专为"配置存储 + 服务发现 + 分布式锁"设计，K8s 的所有资源对象（Pod/Service/Deployment）都是 KV 形态，契合度高

补一句：K8s 早期版本支持过 MySQL/Redis 作为后端，但 1.0 之后只保留 etcd。原因就是上述 1-4 条。

#### 3. 控制面高可用拓扑

K8s 控制面高可用有两种主流拓扑：

| 维度 | 堆叠式（Stacked etcd） | 外部 etcd（External etcd） |
|------|----------------------|-------------------------|
| 拓扑 | etcd 与 API Server/Controller/Scheduler 同机部署 | etcd 独立集群，与控制面其他组件物理分离 |
| 节点数 | 3 master（同时跑 etcd） | 3 master + 3 etcd（或 5 etcd） |
| 故障域 | master 节点宕机同时影响 etcd 和控制面 | 故障隔离，etcd 宕机不影响 master 其他组件进程 |
| 部署难度 | 简单（kubeadm 默认） | 复杂（需独立规划 etcd 集群） |
| 性能 | etcd 与控制面争抢资源 | etcd 独占资源，I/O 专用 |
| 适用场景 | 中小规模、测试、生产 100 节点以内 | 大规模生产、500+ 节点、强 SLA |
| 风险 | master 节点故障 = etcd 同时不可用 | 单点风险更低，但运维成本高 |

**生产环境为什么选外部 etcd**：

1. **故障隔离**：etcd 是 K8s 的"命根子"，etcd 不可用 = 整个集群不可用。把 etcd 独立部署，避免控制面其他组件的资源争抢（如 API Server 大量请求时影响 etcd I/O）
2. **资源独占**：etcd 对磁盘 I/O 极其敏感（fsync 延迟 > 10ms 就会告警），独立 SSD + 独立节点避免被其他组件干扰
3. **独立扩缩容**：etcd 集群规模可以根据集群规模独立调整（5/7/9 节点），不受 master 节点数限制
4. **运维独立性**：etcd 备份/恢复、版本升级、证书轮换可以独立于 K8s 进行
5. **安全合规**：etcd 存了所有 Secret，独立部署可以做更严格的网络隔离和审计

**etcd 节点数为什么是奇数**：

- Raft 协议要求"多数派"达成一致才能写入
- 奇数节点：3 节点容忍 1 节点宕机，5 节点容忍 2 节点宕机，7 节点容忍 3 节点宕机
- 偶数节点：4 节点也只能容忍 1 节点宕机（多数派 = 3），但比 3 节点多花一台机器，**性价比不如奇数**
- 5 节点容忍 2 节点宕机，6 节点也只能容忍 2 节点宕机（多数派 = 4），性价比低于 5

公式：n 节点容忍 (n-1)/2 节点宕机。

**etcd 脑裂**：

Raft 协议天然防止脑裂 —— 写入必须多数派同意。如果网络分区导致脑裂：
- 多数派分区：可继续读写，少数派分区不可用
- 都没多数派（如 4 节点分裂 2+2）：整个集群不可用，但不会出现两个"主"，保证一致性

K8s 在 etcd 脑裂期间：
- API Server 无法写入（创建/更新/删除对象都失败）
- kubelet/kube-proxy/controller 仍能用本地缓存跑已部署的 Pod（已运行的 Pod 不受影响）
- 业务流量继续，但无法新建/更新资源

#### 4. Leader 选举机制

`kube-scheduler` 和 `kube-controller-manager` 都是"多副本部署，但只有一个工作"的模式。原因：

- **避免重复调度**：两个调度器同时调度同一个 Pod，会创建两份
- **避免重复控制循环**：两个 Deployment 控制器同时创建 ReplicaSet，会重复创建

**Leader 选举实现**（基于 Lease 资源）：

```
1. 启动时，每个副本尝试创建 Lease 对象（kube-system/lease-name）
   apiVersion: coordination.k8s.io/v1
   kind: Lease
   metadata:
     name: kube-scheduler
     namespace: kube-system
   spec:
     holderIdentity: scheduler-instance-1   # 当前持有者
     leaseDurationSeconds: 15                # 租约有效期
     renewTime: 2026-07-20T10:00:00Z         # 续约时间
     acquireTime: 2026-07-20T09:50:00Z       # 抢到的时间

2. 抢到的副本成为 leader，开始工作
3. 其他副本进入"watch + 等待"状态
4. Leader 每隔 renewTime（默认 1/3 leaseDuration，即 5s）续约一次
5. 如果 leader 宕机（停止续约），leaseDuration（15s）后 Lease 失效
6. 其他副本竞争抢 Lease，抢到的成为新 leader
```

**切换时间**：
- 默认 `leaseDuration=15s`、`renewDeadline=10s`、`retryPeriod=2s`
- leader 宕机后，最长 15s 内新 leader 上线
- 实际平均切换时间 5-10s

**期间业务是否受影响**：

| 业务场景 | 是否受影响 |
|---------|----------|
| 已运行的 Pod | 不受影响，kubelet 独立运行 |
| Pod 健康检查、重启 | 不受影响，kubelet 独立 |
| Service -> Pod 转发 | 不受影响，kube-proxy 独立 |
| 新 Pod 创建（kubectl scale） | 受影响，无 scheduler 调度 |
| Pod 故障后重建（节点宕机） | 受影响，无 scheduler 重新调度 |
| Deployment 滚动更新 | 受影响，新 Pod 无法调度 |

**关键设计**：业务面（数据面）与控制面解耦，控制面短暂不可用不影响存量业务。

#### 5. API Server 性能瓶颈与调优

**性能瓶颈分布**：

| 瓶颈点 | 表现 | 原因 |
|--------|------|------|
| etcd I/O | 写延迟 P99 > 100ms | 磁盘 fsync 慢，或 QPS 超过 etcd 处理能力（默认 10000 QPS） |
| API Server CPU | P99 延迟高 | 序列化/反序列化、准入控制 webhook 慢 |
| API Server 内存 | OOM | 大对象 watch 缓存（List Pod/Node 全量） |
| 网络带宽 | watch 慢 | 全集群 Pod 状态变更广播 |
| 准入 webhook | 请求堆积 | 外部 webhook 服务慢（如 OPA、Istio Sidecar 注入） |
| List 请求 | 集群卡顿 | 客户端不带 ResourceVersion=0 全量 List |

**API Server QPS 上限评估**：

参考经验值（3 master，每台 16C/32G + SSD）：
- 单 API Server：约 5000-10000 QPS（取决于对象大小、准入 webhook）
- 3 master LB 后：约 15000-30000 QPS
- 5000 Pod 集群日常 QPS：约 1000-3000（watch + 心跳）
- 大流量事件（部署、扩容）：可能瞬时 10000+ QPS

**关键参数**：

1. `--max-requests-inflight=400`（只读请求并发上限）
2. `--max-mutating-requests-inflight=200`（写请求并发上限）
   - 超过则返回 429 Too Many Requests
   - 默认值适合小集群，大集群必须调大（如 1000/500）
3. `--max-mutating-requests-inflight` 需配合 etcd 性能，否则写请求堆积在 etcd

**Priority and Fairness（APF）**：

K8s 1.20+ 引入，解决"互相挤占"问题：

- **旧方案**（max-requests-inflight）：所有请求共享一个池，一个慢请求会阻塞其他请求
- **APF 方案**：按 PriorityClass（系统级 / leader-elect / node-high / default / low）和 FlowSchema（按用户/SA/Namespace 路由）分级，每级独立限流

APF 核心概念：
- **PriorityLevel**：优先级 + 并发上限（如 system 200 并发、default 100 并发、low 50 并发）
- **FlowSchema**：请求按规则路由到 PriorityLevel（如 kubelet 心跳 -> node-high，kubectl apply -> default）

**为什么大集群必须开 APF**：

1. 防止"心跳风暴"：5000 Pod + 100 节点，kubelet 每 10s 上报一次心跳 = 500 QPS 心跳。如果与 kubectl apply 共享池，心跳会挤占业务请求
2. 防止"慢 webhook 拖垮 API Server"：准入 webhook 慢会导致请求堆积，APF 让系统级请求（如 controller watch）优先
3. 防止"恶意租户"：多租户场景，一个租户的大 List 请求不能拖垮其他租户

**架构师视角的关键认知**：

- API Server 不是"中间件"，而是"集群的数据库 + 网关"，必须按数据库标准规划资源（CPU/内存/磁盘 I/O）
- 评估 K8s 集群容量不只是节点数，还要看"API Server QPS / etcd IOPS / watch 带宽"三个维度
- 大集群一定要开 APF，否则一次大规模部署可能拖垮 API Server
- etcd 备份是 K8s 的"最后一道防线"，每天一次 + 关键变更前一次

#### 与架构师水平的差距与补足方向

**差距1**：对 etcd 的 Raft 协议细节、备份恢复、性能调优只在概念层，缺乏实战
**补足**：精读 etcd 官方文档 + Raft 论文，搭一个 3 节点 etcd 集群做脑裂/恢复演练

**差距2**：API Server 性能调优只调过 `max-requests-inflight`，没系统用过 APF
**补足**：在生产集群启用 APF，按 PriorityLevel 拆分请求，观察限流效果

**差距3**：K8s 控制面故障排查经验不足（如 API Server 慢、etcd 写超时）
**补足**：学习 K8s 控制面监控指标（apiserver_request_duration、etcd_request_duration、workqueue_depth），结合 Prometheus 告警体系

---

## 题目二（架构设计题）：Pod 模型与多容器设计模式

K8s 的最小调度单位是 Pod 而不是容器，这是 K8s 与早期容器编排系统（如 Docker Swarm）的根本差异。请你回答：

1. 为什么 K8s 引入 Pod 这一层抽象，而不是直接调度容器？Pod 内的多个容器共享哪些命名空间？Pause 容器（infra container）的作用是什么，如果 Pause 容器挂了会怎样？为什么不直接让业务容器互相共享网络命名空间？
2. K8s 经典的多容器设计模式有 Sidecar、Ambassador、Adapter 三种，请分别说明它们的适用场景、典型应用、陷阱。Sidecar 模式在 Service Mesh（如 Istio）中是怎么用的？Sidecar 注入是 K8s 哪个机制实现的？
3. Init Container 的执行顺序、失败重试、资源限制是怎样的？典型应用场景有哪些（如等待依赖、配置初始化、安全敏感操作）？Init Container 与 Sidecar 的本质区别是什么？
4. Pod 的生命周期有 Pending / Running / Succeeded / Failed / Unknown 五个阶段，每个阶段对应什么状态？Pod 内容器的重启策略（Always/OnFailure/Never）如何影响 Pod 状态？livenessProbe/readinessProbe/startupProbe 三个探针的差异、适用场景、配置陷阱是什么？
5. 假设你设计的微服务需要"主容器 + Sidecar（日志采集）+ Init Container（拉配置）"三容器 Pod，请画出 Pod 结构图，说明容器启动顺序、网络共享、存储共享、资源竞争、故障处理。如果 Sidecar 容器 OOM，主容器会不会受影响？如果主容器 CrashLoopBackOff，Sidecar 还在跑，怎么办？

### 作答区

#### 1. 为什么引入 Pod 抽象

**核心动机**：K8s 把"容器组"作为最小调度单位，是因为许多应用天然需要多容器紧密协作。

**典型场景**：
- 主容器 + 日志采集 Sidecar（Filebeat 采集主容器日志）
- 主容器 + Service Mesh Sidecar（Envoy 代理进出流量）
- 主容器 + 配置拉取 Init Container（启动前从配置中心拉配置）
- 主容器 + 适配器 Sidecar（把主容器的 metric 转成 Prometheus 格式）

**为什么不能直接调度容器**：

1. **调度困难**：两个紧密协作的容器（如业务 + Sidecar），如果分别调度，可能落到不同节点，跨节点通信开销大
2. **生命周期耦合**：业务容器和 Sidecar 必须同时启动、同时销毁，独立调度难以保证
3. **资源管理复杂**：两个容器的资源（CPU/内存）需要独立配额，但调度时又需要按总和算
4. **网络共享需求**：业务与 Sidecar 通常需要共享 localhost 网络栈（如 Envoy 监听 15006，业务流量先到 Envoy 再转发到业务 8080）

**Pod 内共享的命名空间**：

| 命名空间 | 是否共享 | 说明 |
|---------|---------|------|
| Network | 共享 | 所有容器共享同一个 network namespace，localhost 互通，端口冲突 |
| IPC | 共享 | 可通过 System V IPC / POSIX IPC 通信 |
| UTS | 共享 | 共享 hostname |
| PID | 默认不共享（可开启 shareProcessNamespace） | 共享后可见彼此进程 |
| Mount | 不共享 | 每个容器有独立的文件系统，但可挂载同一个 Volume |
| User | 不共享 | 各容器独立的 UID/GID |

**Pause 容器（infra container）的作用**：

每个 Pod 第一个启动的容器是 Pause 容器（`registry.k8s.io/pause:3.9`），它的职责：

1. **持有 network namespace**：Pod 内其他容器都共享 Pause 的 network namespace（通过 `--net=container:pause`）
2. **持有 IPC namespace**：同理
3. **僵尸进程回收**：Pause 调用 `pause()` 系统调用，作为 PID 1 回收子进程资源

**为什么不直接让业务容器互相共享**：

1. **生命周期解耦**：业务容器可能 CrashLoopBackOff，如果业务 A 持有 network namespace，A 重启时整个 Pod 网络断开
2. **统一管理**：Pause 容器极简（C 写的几十行代码 + 静态链接），永不崩溃，专门做"持有 namespace"这一件事
3. **避免循环依赖**：A 共享 B 的 namespace 还是 B 共享 A 的？解耦为"都共享 Pause 的"

**Pause 容器挂了会怎样**：

- Pod 内所有容器的 network namespace 丢失，所有容器网络中断
- Kubelet 会重建 Pod（删除所有容器，重新拉起 Pause）
- 等同于 Pod 重启

实际上 Pause 容器几乎不会挂，因为：
- 它只调用一次 `pause()` 系统调用，然后睡眠
- 没有业务逻辑，没有外部依赖
- 资源占用极小（CPU 几乎为 0，内存几 MB）

#### 2. 多容器设计模式

K8s 经典三模式（来自 Google Borg 论文）：

```
┌─────────────────────────────────────────────────────────────┐
│  Pod                                                         │
│  ┌─────────────┐    ┌─────────────┐                         │
│  │  Main       │    │  Sidecar    │  辅助主容器             │
│  │  Container  │◄──►│             │  生命周期与主容器耦合    │
│  │             │    │             │                         │
│  └─────────────┘    └─────────────┘                         │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  Pod                                                         │
│  ┌─────────────┐    ┌─────────────┐                         │
│  │  Main       │    │ Ambassador  │  代理外部依赖           │
│  │  Container  │───►│ (Proxy)     │  屏蔽外部复杂性         │
│  │             │◄───│             │                         │
│  └─────────────┘    └─────────────┘                         │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  Pod                                                         │
│  ┌─────────────┐    ┌─────────────┐                         │
│  │  Main       │───►│  Adapter    │  标准化输出             │
│  │  Container  │    │             │  把主容器输出转成标准格式│
│  └─────────────┘    └─────────────┘                         │
└─────────────────────────────────────────────────────────────┘
```

**Sidecar 模式**：

| 维度 | 说明 |
|------|------|
| 适用场景 | 主容器需要辅助功能（日志、监控、Mesh），但不想耦合到主代码 |
| 典型应用 | Istio Envoy、Filebeat 日志采集、Prometheus exporter、Vault Agent |
| 陷阱1 | 资源竞争：Sidecar 占用主容器资源，需独立 Requests/Limits |
| 陷阱2 | 启动顺序：Sidecar 必须先于主容器启动（K8s 1.28+ 支持 sidecarContainers） |
| 陷阱3 | 升级困难：Sidecar 升级需要 Pod 重建，影响主容器 |
| 陷阱4 | 故障排查：Sidecar 故障可能阻塞主容器，但日志看不出来 |

**Sidecar 在 Service Mesh（Istio）中的应用**：

Istio 通过 Sidecar 模式实现"流量代理 + 治理能力下沉"：

```
┌─────────────────────────────────────────────────────────────┐
│  Pod (业务 + Envoy Sidecar)                                  │
│                                                              │
│  ┌─────────────────┐         ┌─────────────────────┐        │
│  │  业务容器       │ ──►    │  Envoy Sidecar      │        │
│  │  (Java/Spring)  │ ◄──    │  - 监听 15006 入站  │        │
│  │                 │         │  - 监听 15001 出站  │        │
│  │  localhost:8080 │         │  - 路由/负载/熔断   │        │
│  └─────────────────┘         │  - 重试/超时/灰度   │        │
│         ▲                     └─────────────────────┘        │
│         │                              │                     │
│         └──────── iptables ────────────┘                     │
│             REDIRECT 到 Envoy                                │
└─────────────────────────────────────────────────────────────┘
```

工作原理：
1. Pod 启动时，Istio CNI 通过 iptables 把业务容器的进出流量 REDIRECT 到 Envoy
2. 入站流量：15006 -> 业务 8080
3. 出站流量：业务 -> 15001 -> 外部
4. Envoy 根据 xDS 配置做路由、负载均衡、熔断、重试

**Sidecar 注入机制**：

通过 K8s 的 **MutatingAdmissionWebhook** 实现：

1. 用户创建 Pod（带 `istio-injection=enabled` 标签的 Namespace）
2. API Server 收到请求，进入准入控制阶段
3. Istio 的 Sidecar Injector Webhook 被调用
4. Webhook 修改 PodSpec：添加 Envoy 容器、Init Container（配置 iptables）、Volumes
5. 修改后的 PodSpec 写入 etcd
6. Kubelet 按修改后的 PodSpec 拉起 Pod

**Ambassador 模式**：

| 维度 | 说明 |
|------|------|
| 适用场景 | 主容器需要访问复杂外部依赖（多数据库、多 Redis、多外部 API） |
| 典型应用 | 把外部服务集群封装成 localhost 端口，主容器只连 localhost |
| 例子 | 主容器连 localhost:3306 -> Ambassador 转发到真实 MySQL 集群 |
| 陷阱 | 与 Service Mesh Sidecar 功能重叠，现代实践多用 Sidecar 替代 |

**Adapter 模式**：

| 维度 | 说明 |
|------|------|
| 适用场景 | 主容器输出格式不标准，需转换 |
| 典型应用 | 主容器暴露 Prometheus 不认识的 metric -> Adapter 转成 Prometheus 格式 |
| 例子 | Java 应用 JMX metric -> JMX Exporter 转 Prometheus 格式 |
| 陷阱 | Adapter 故障导致监控缺失，需独立健康检查 |

#### 3. Init Container

**执行顺序**：

```
Pod 启动顺序：
1. Pause 容器（infra container）启动
2. Init Container 1 启动 -> 完成
3. Init Container 2 启动 -> 完成
4. ...
5. Init Container N 启动 -> 完成
6. 主容器 + Sidecar 启动（并行）
```

**关键特性**：

| 维度 | 说明 |
|------|------|
| 顺序执行 | 多个 Init Container 严格顺序执行，前一个完成才执行下一个 |
| 并行启动 | 所有主容器和 Sidecar 在 Init Container 全部完成后并行启动 |
| 失败重试 | Init Container 失败按 restartPolicy 重启整个 Pod |
| 资源限制 | 每个 Init Container 独立 Requests/Limits，Pod 的有效资源 = max(所有 Init Container Requests) |
| 网络共享 | 与主容器共享 Pause 的 network namespace |
| 存储 | 可挂载 Volume，与主容器共享 |

**典型应用场景**：

1. **等待依赖**：等待 MySQL/Redis 启动完成（如 `until nc -z mysql 3306; do sleep 1; done`）
2. **配置初始化**：从配置中心拉配置，写到 emptyDir，主容器读
3. **数据预处理**：拉取模型文件、解压、放到指定目录
4. **安全敏感操作**：拉取 Secret（如数据库密码）、生成证书、写入 Pod 内
5. **注册到服务发现**：启动前注册到 Consul/Eureka，避免主容器起来但流量还没准备好

**Init Container vs Sidecar 本质区别**：

| 维度 | Init Container | Sidecar |
|------|---------------|---------|
| 执行时机 | Pod 启动时一次性 | 与主容器同时跑，长期运行 |
| 生命周期 | 短暂（秒级到分钟级） | 与主容器同生命周期 |
| 失败影响 | Pod 启动失败 | 主容器仍可跑，但功能受损 |
| 资源占用 | 启动期占用，结束后释放 | 全程占用 |
| 典型用途 | 初始化、等待依赖 | 持续辅助（日志/Mesh/监控） |

**K8s 1.28+ 的 sidecarContainers**：

K8s 1.28 引入了 `sidecarContainers` 字段（1.29 转 GA），解决"Sidecar 必须先启动"问题：

```yaml
spec:
  initContainers:
  - name: sidecar-1
    restartPolicy: Always   # 关键：Init Container 设 restartPolicy: Always 即变为 Sidecar
    image: envoy
```

设 `restartPolicy: Always` 的 Init Container 会在主容器之前启动并保持运行，是真正的 Sidecar。

#### 4. Pod 生命周期与探针

**Pod 阶段（Phase）**：

| Phase | 说明 | 触发条件 |
|-------|------|---------|
| Pending | 已被 API Server 接受，但容器未全部启动 | 调度中、镜像拉取中、Init Container 执行中 |
| Running | 所有容器已创建，至少一个还在运行 | 主容器启动 |
| Succeeded | 所有容器成功退出，不再重启 | Job/CronJob 完成 |
| Failed | 所有容器退出，至少一个失败 | 主容器 exit code != 0 且 restartPolicy 不允许重启 |
| Unknown | 无法获取 Pod 状态 | API Server 与 kubelet 通信失败 |

**容器重启策略**：

| 策略 | 说明 | 适用 |
|------|------|------|
| Always | 容器退出总是重启 | Deployment/StatefulSet/DaemonSet（默认） |
| OnFailure | 容器失败（exit != 0）才重启 | Job |
| Never | 容器退出不重启 | 一次性任务、CronJob |

**注意**：restartPolicy 是 Pod 级别，所有容器共用。

**三个探针**：

| 探针 | 作用 | 失败后果 | 配置要点 |
|------|------|---------|---------|
| livenessProbe | 探测容器是否"活着" | 失败 -> 重启容器 | 探测死锁、卡死，避免探测业务依赖（DB 挂了不应让 Pod 重启） |
| readinessProbe | 探测容器是否"准备好接流量" | 失败 -> 从 Service Endpoints 摘除 | 探测业务依赖（DB/Redis 挂了应摘流量），避免雪崩 |
| startupProbe | 探测容器是否"启动完成" | 失败 -> 重启容器；成功前 liveness/readiness 不生效 | 慢启动应用（如 Java JVM 预热 60s） |

**配置陷阱**：

1. **livenessProbe 探测业务依赖**：如 livenessProbe 探测 `/api/health`，里面检查 DB 连接，DB 挂了 -> Pod 重启 -> 重启后 DB 还挂 -> CrashLoopBackOff。正确：livenessProbe 只探进程存活（如 `/api/liveness` 直接返回 200）
2. **readinessProbe 太严**：检查太严导致 Endpoints 频繁摘除，流量抖动
3. **startupProbe 没设**：Java 应用启动 60s，但 livenessProbe initialDelaySeconds=30s、failureThreshold=3、periodSeconds=10s -> 启动到 60s 时 liveness 失败 3 次重启，永远起不来
4. **探针超时太短**：业务 GC 导致接口慢 1s，探针 timeoutSeconds=1s -> 频繁失败
5. **livenessProbe 与 readinessProbe 用同一个接口**：失去差异化能力

**推荐配置**（Java Spring Boot 应用）：

```yaml
livenessProbe:
  httpGet:
    path: /actuator/health/liveness   # 只检查进程
    port: 8080
  initialDelaySeconds: 0              # 用 startupProbe 接管启动期
  periodSeconds: 10
  failureThreshold: 3
  timeoutSeconds: 1

readinessProbe:
  httpGet:
    path: /actuator/health/readiness  # 检查 DB/Redis/MQ 连接
    port: 8080
  initialDelaySeconds: 0
  periodSeconds: 5
  failureThreshold: 3
  timeoutSeconds: 3

startupProbe:
  httpGet:
    path: /actuator/health/liveness
    port: 8080
  failureThreshold: 30                # 30 * 10s = 300s 启动期
  periodSeconds: 10
```

#### 5. 三容器 Pod 综合设计

**Pod 结构图**：

```
┌──────────────────────────────────────────────────────────────────┐
│  Pod: my-service-abc123                                            │
│  Network NS: shared (Pause 容器持有)                              │
│  IP: 10.244.1.23                                                   │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │  Volume: config-emptyDir (emptyDir, 共享)                    │ │
│  └──────────────────────────────────────────────────────────────┘ │
│           ▲                ▲                  ▲                    │
│           │                │                  │                    │
│  ┌────────┴─────┐   ┌──────┴──────┐  ┌────────┴─────┐             │
│  │ Init         │   │ Main        │  │ Sidecar     │             │
│  │ Container    │   │ Container   │  │ (Filebeat)  │             │
│  │              │   │             │  │             │             │
│  │ 1. 从 Apollo │   │ Java Spring │  │ 采集        │             │
│  │    拉配置    │   │ Boot 8080   │  │ /var/log/   │             │
│  │ 2. 写入      │   │             │  │ *.log       │             │
│  │    emptyDir  │   │             │  │ -> Kafka    │             │
│  │ 3. exit 0    │   │             │  │             │             │
│  └──────────────┘   └─────────────┘  └─────────────┘             │
│                                                                    │
│  Resources:                                                        │
│    Init:   cpu 100m / mem 128Mi                                   │
│    Main:   cpu 1000m / mem 2Gi                                    │
│    Sidecar: cpu 100m / mem 256Mi                                  │
└──────────────────────────────────────────────────────────────────┘
```

**启动顺序**：

1. Pause 容器启动（持有 network namespace）
2. Init Container 启动：从 Apollo 配置中心拉配置，写入 `/config/application.yaml`
3. Init Container 退出（exit 0）
4. Main 容器 + Sidecar（Filebeat）并行启动
5. Main 容器读 `/config/application.yaml` 启动 Spring Boot
6. Filebeat 监听 `/var/log/*.log`，输出到 Kafka
7. Main 容器 readinessProbe 通过 -> Pod 加入 Service Endpoints

**网络共享**：

- Main 容器 8080 端口、Filebeat 无监听端口（输出到 Kafka）
- 都通过 Pause 持有的 network namespace 共享 localhost
- Filebeat 可访问 Main 容器的 `localhost:8080/actuator/metrics` 采集指标

**存储共享**：

- `config-emptyDir`：Init Container 写、Main 容器读
- `log-emptyDir`：Main 容器写日志、Filebeat 读日志
- 都是 emptyDir，Pod 销毁即丢失（适合配置和日志，不适合持久化数据）

**资源竞争**：

- 三个容器独立 Requests/Limits
- Pod 总资源 = 100m+1000m+100m = 1200m CPU，2Gi+256Mi+128Mi = 2.4Gi 内存
- 节点调度按 Pod 总资源计算
- Sidecar OOM 不会影响 Main 容器的内存配额

**故障处理**：

| 故障场景 | 处理 |
|---------|------|
| Sidecar OOM | Sidecar 被 OOMKilled，按 restartPolicy=Always 重启；Main 容器不受影响，但日志采集中断 |
| Main 容器 CrashLoopBackOff | Main 容器反复重启；Sidecar 仍跑；readinessProbe 失败 -> 从 Endpoints 摘除 |
| Init Container 失败 | 整个 Pod 阻塞在 Init 阶段；Main 和 Sidecar 不会启动 |
| Pause 容器挂（极少） | 整个 Pod 网络断开，kubelet 重建 Pod |
| 节点宕机 | Pod 重新调度到其他节点，所有容器重建 |

**Sidecar OOM 是否影响主容器**：

- **内存**：不影响。每个容器独立 cgroup，Sidecar OOM 不会牵连主容器
- **CPU**：影响。如果 Sidecar CPU 没限制好，可能抢占主容器 CPU（需配合 CPU Manager + cpu.cfs_quota_us）
- **网络**：影响。如果 Sidecar 是 Mesh 代理（如 Envoy），Sidecar 重启期间网络中断
- **磁盘 I/O**：影响。如果 Sidecar 大量写日志，可能拖慢主容器

**主容器 CrashLoopBackOff 时 Sidecar 还在跑怎么办**：

1. **现象**：Pod 仍在 Running（因为 Sidecar 还活着），但 readinessProbe 失败 -> 摘流量
2. **风险**：Sidecar 持续采集"卡死状态"的日志，Mesh Sidecar 持续占用资源
3. **处理**：
   - 通过 Deployment 滚动更新强制重建 Pod（`kubectl rollout restart`）
   - 设置 Pod 的 `terminationGracePeriodSeconds` 较短（如 30s），加速重建
   - 监控 Pod 的 `restartCount`，超过阈值自动告警
4. **架构层规避**：K8s 1.28+ 的 sidecarContainers（Sidecar Init Container，restartPolicy: Always）可以让 Sidecar 与主容器生命周期更强耦合，主容器退出时 Sidecar 也退出

#### 与架构师水平的差距与补足方向

**差距1**：Sidecar 模式的实践经验主要在 Istio Envoy，对自定义 Sidecar（如自研日志/Mesh）设计不足
**补足**：阅读 Istio Sidecar 注入实现（MutatingAdmissionWebhook），尝试自研一个简单的 Sidecar 注入控制器

**差距2**：探针配置大多复制粘贴，对 startupProbe 引入后的最佳实践不熟
**补足**：重新梳理 Spring Boot Actuator 的 `/actuator/health/liveness` vs `/actuator/health/readiness` 分离，所有线上 Java 应用统一启用 startupProbe

**差距3**：多容器 Pod 的资源竞争（CPU/IO/网络）调优经验不足
**补足**：学习 K8s CPU Manager（static 策略）、Memory Manager、IO 隔离（cgroup v2 io），在生产集群验证 Sidecar 资源配额

**差距4**：Pod 故障排查（CrashLoopBackOff、OOMKilled、Init:Error）熟练度不够
**补足**：整理 K8s 故障排查手册（kubectl describe/events/logs/exec/crictl），结合实际事故复盘

---

## 能力差距梳理（Day01）

> 后续将统一汇总到 `架构师学习-能力差距梳理.md`

### 差距1：K8s 控制面组件实战调优不足
> Day1发现

- **现状**：知道 K8s 控制面组件构成，但 API Server、etcd 的性能调优（max-requests-inflight、APF PriorityLevel、etcd –quota-backend-bytes）只调过参数，未深度实战
- **架构师水平**：能根据集群规模（节点数、Pod 数、QPS）规划 API Server/etcd 资源，能基于监控指标（apiserver_request_duration、etcd_wal_fsync_duration）做容量评估
- **补足方向**：
  - 精读 K8s 官方"Scaling Kubernetes to 2,500 Nodes"系列博客
  - 学习 APF FlowSchema/PriorityLevel 配置，在生产集群验证限流效果
  - 复盘啄木鸟云健康集群（如有）的 API Server 监控指标

### 差距2：etcd 备份恢复与故障演练缺失
> Day1发现

- **现状**：知道 etcd 是 K8s 命根子，但没做过 etcd 备份恢复演练、脑裂演练
- **架构师水平**：能设计 etcd 备份策略（snapshot 周期 + 异地备份 + 恢复演练），能在 etcd 脑裂时快速诊断与恢复
- **补足方向**：
  - 搭 3 节点 etcd 集群，做脑裂、磁盘满、节点宕机演练
  - 学习 `etcdctl snapshot save/restore` 完整流程
  - 在生产集群配置 etcd 监控告警（fsync 延迟、leader 切换、磁盘使用率）

### 差距3：Pod 多容器设计模式实战不深
> Day1发现

- **现状**：用过 Istio Sidecar、Filebeat Sidecar，但对 Ambassador/Adapter 模式、自研 Sidecar 注入控制器不熟
- **架构师水平**：能根据业务需求设计多容器 Pod（如医疗 IM 长连接网关 + Mesh Sidecar + 日志 Sidecar），能自研 AdmissionWebhook 实现 Sidecar 自动注入
- **补足方向**：
  - 阅读 Istio Sidecar Injector 实现源码
  - 自研一个简单的 Sidecar 注入控制器（如自动注入日志采集容器）
  - 复盘啄木鸟云健康线上 Sidecar 模式使用情况，识别可优化点

### 差距4：Pod 探针配置缺乏统一规范
> Day1发现

- **现状**：探针配置主要复制粘贴，liveness/readiness/startup 没有清晰职责划分
- **架构师水平**：能为不同类型应用（Java/Go/Python、Web/Worker/CronJob）制定探针配置规范，能基于 Actuator/Micrometer 设计精细化健康检查
- **补足方向**：
  - 制定 Spring Boot 应用探针配置规范（liveness + readiness + startup 分离）
  - 制定 Go/Python 应用探针配置规范
  - 在啄木鸟云健康线上推广，逐步替换老配置

### 差距5：K8s 故障排查体系化不足
> Day1发现，延续第5周差距2.3（微服务长连接网关）

- **现状**：能查 `kubectl describe`、`kubectl logs`，但 CrashLoopBackOff、OOMKilled、Init:Error 等高频故障的体系化排查不熟
- **架构师水平**：能建立 K8s 故障排查手册（按现象 -> 原因 -> 诊断 -> 处理流程化），能基于 kubelet/容器运行时日志深入分析
- **补足方向**：
  - 整理 K8s 常见故障案例库（CrashLoopBackOff、ImagePullBackOff、OOMKilled、Pending、Evicted）
  - 学习 `crictl`、`ctr`、`kubectl debug` 等工具
  - 复盘历史故障（如 Pod 频繁重启、节点 NotReady）形成 SOP

---