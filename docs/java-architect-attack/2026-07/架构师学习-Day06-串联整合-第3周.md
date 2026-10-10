# Day 6：K8s 与云原生专题串联整合 - 云原生智慧医疗平台全链路架构设计

> 日期：2026年07月25日（周六）
> 周主题：K8s 与云原生专题
> 串联日：Day06 - 本周 Day01-Day05 知识点整合

---

## 本周回顾速览

本周 Day01-Day05 完整覆盖了 K8s 从底层架构到调度治理的完整链路：

| Day | 主题 | 核心知识点 |
|-----|------|-----------|
| Day01 | K8s 核心架构与 Pod 容器设计模式 | 控制面/数据面/节点组件、apiserver/etcd/scheduler/controller-manager、Pod 状态机、Pause 容器、Sidecar/Ambassador/Adapter、Init Container、探针（liveness/readiness/startup） |
| Day02 | Workload 编排与发布工程 | Deployment/StatefulSet/DaemonSet/Job/CronJob 五件套、滚动/蓝绿/金丝雀、maxSurge/maxUnavailable、revisionHistoryLimit、PodDisruptionBudget、HPA 联动雪崩 |
| Day03 | Service 与网络模型 | Service 五类型、ClusterIP 虚拟 IP 原理、iptables vs ipvs、EndpointSlice、Ingress、CoreDNS、ndots:5 陷阱、CNI Overlay vs BGP、NetworkPolicy |
| Day04 | 存储卷与配置管理 | Volume 七类型、PV/PVC/StorageClass 三层抽象、CSI 三组件、accessModes、reclaimPolicy、WaitForFirstConsumer、ConfigMap 热更新、Secret KMS 加密、StatefulSet volumeClaimTemplates |
| Day05 | 调度与资源管理 | 调度器 Filter/Score/Reserve/Permit/Bind 五阶段、nodeAffinity/podAffinity/podAntiAffinity、污点容忍、topologySpreadConstraints、PriorityClass 抢占、Requests/Limits、QoS 三等级、CPU Throttling、OOMKilled、LimitRange/ResourceQuota、Node Allocatable |

**本周因果链**：

```
基础设施视角（Day01）：K8s 控制面 + Pod 模型
   ↓
编排视角（Day02）：Workload 五件套 + 发布工程
   ↓
网络视角（Day03）：Service 转发 + CNI + DNS + NetworkPolicy
   ↓
存储视角（Day04）：PV/PVC/StorageClass + CSI + 配置/Secret
   ↓
调度视角（Day05）：调度约束 + 资源管理 + 多租户隔离
```

五视角合一形成"云原生全链路"：**K8s 集群是底座 -> Workload 编排业务 Pod -> Service 让流量找到 Pod -> 存储让数据落盘 -> 调度让 Pod 落到合适节点 + 资源不被抢光**。

Day06 不走多场景分选模式。本周五天学完之后，最能"一次性把所有知识点用上"的场景，不是单点调度、也不是单点网络，而是**云原生智慧医疗平台 K8s 全链路架构设计**--这是医疗架构师视角才能真正驾驭的设计题：既要把 K8s 五大支柱（架构/编排/网络/存储/调度）串成闭环，又要把啄木鸟云健康的真实业务（体检/医保/影像/AI/批处理）落到 K8s 上，还要兼顾医疗监管合规、多租户隔离、跨 AZ 容灾、性能与成本平衡。

---

## 场景选择：云原生智慧医疗平台 K8s 全链路架构设计

### 为什么选这个场景

全链路场景一次性用到本周全部知识点：

```text
Day01：K8s 核心架构 + Pod 设计模式  -> 全链路的"底座"（3 master 控制面 HA + Pod 多容器设计）
Day02：Workload + 发布工程          -> 全链路的"业务编排"（5 类 Workload + 零宕机发布 + PDB）
Day03：Service + 网络模型            -> 全链路的"流量入口"（Ingress + Service + NetworkPolicy + DNS）
Day04：存储卷 + 配置管理             -> 全链路的"数据持久化"（PV/PVC + CSI + ConfigMap + Secret）
Day05：调度 + 资源管理               -> 全链路的"调度治理"（亲和性 + 污点 + 拓扑分布 + QoS + 多租户配额）
```

如果只看单点设计，会错过"全链路协同、跨域一致性、故障雪崩防护、多租户资源隔离、监管合规闭环"这些架构师核心命题。特别是医疗行业的"医保结算不能被 PDF 批处理挤占"、"医疗影像 AI 推理要独占 GPU"、"多医共体客户共享集群要 ResourceQuota 隔离"、"监管上报数据 5 年不丢"等强约束，逼着我们在 K8s 上把五大支柱串成工程闭环。

---

## 核心考题：云原生智慧医疗平台 K8s 全链路架构设计

### 业务背景

```text
啄木鸟云健康 2026 年战略升级：把智慧体检/公卫平台从"传统 VM + Spring Cloud"
全量迁移到 K8s 云原生架构，并承接 4 家医共体客户的 SaaS 化服务。

集群规模：
- 3 master（控制面 HA，外部 etcd 拓扑）+ 30 worker
- 3 AZ × 10 节点，每节点 24 核 CPU / 96GB 内存 / 2TB 本地盘
- 节点角色：通用节点 24 台、医保结算专用节点 3 台、GPU 节点 3 台
- 总容量：720 核 CPU / 1440GB 内存 / 60TB 本地盘 + 100TB 网络存储

业务负载：
1. 体检预约 Web 服务（无状态，10 副本，要求跨 3 AZ 均匀分布，日均 50w+ 订单）
2. 体检报告服务（无状态，6 副本，被预约服务调用）
3. 医保结算服务（敏感业务，3 副本，必须只调度到医保专用节点，要求保留客户端 IP 给医保局审计）
4. 体检报告 PDF 批处理（低优先级 Job，每天凌晨处理 10w 体检报告，可被抢占）
5. Redis Cluster（6 节点，3 主 3 从，主从跨 AZ）
6. MySQL 主从（主库 500GB + 从库 500GB，高 IOPS + 跨 AZ 容灾）
7. 医疗影像 AI 推理服务（需要 GPU，2 副本，要求 GPU 节点独占）
8. 体检报告 PDF 文件存储（日均 10w 份，每份 1-5MB，3 年归档）
9. 医疗影像 DICOM 文件存储（单年 PB 级，30 天热 / 90 天温 / 长期冷归档）
10. Filebeat 日志采集（DaemonSet，每节点一份，但医保节点不能采集医保日志外的数据）
11. Prometheus + Grafana + Loki + Jaeger 可观测性栈
12. 4 家医共体客户业务隔离（A 客户 50w 体检/年、B 客户 20w、C 客户 10w、D 客户 5w）

历史痛点：
  - 2025 年：体检预约发布期间 OOM 雪崩，5 分钟不可用
  - 2025 年：Redis 主从同节点，节点宕机导致缓存全失
  - 2025 年：PDF 批处理挤占医保结算，医保接口超时被监管通报
  - 2025 年：医疗影像 DICOM 文件丢失，被患者投诉
  - 2025 年：4 家医共体客户共享集群，D 客户跑飞把整个集群拖垮
  - 2025 年：节点资源超卖 3:1，OOM 风暴连锁雪崩
  - 2026 年：医保结算数据要满足等保三级 + 5 年合规归档
  - 2026 年：医疗影像 AI 推理延迟 < 2s 但 GPU 资源浪费严重

目标：
  1. 全链路可用性 99.95%（年度宕机 < 4.4 小时）
  2. 医保结算 SLA 99.99%（年度宕机 < 52 分钟）
  3. 发布零宕机（maxUnavailable=0 + readinessProbe + PDB）
  4. 跨 AZ 高可用（单 AZ 故障业务自愈）
  5. 多租户隔离（4 家医共体客户互不影响）
  6. 医保结算物理隔离（专用节点 + 污点 + NetworkPolicy 三件套）
  7. GPU 节点独占（不浪费 + 不被普通业务挤占）
  8. 数据 5 年合规归档（医疗监管 + 等保三级）
  9. 集群资源利用率 50%-70%（不超卖不过度保守）
  10. 全链路可观测（指标 + 日志 + 链路三件套）
```

### 设计目标

```text
1. 业务全覆盖：5 类 Workload + 10 类业务 + 4 家医共体客户全编排
2. 五视角融合：基础设施 + 编排 + 网络 + 存储 + 调度五视角合一
3. 多租户隔离：Namespace + ResourceQuota + LimitRange + NetworkPolicy + PriorityClass
4. 跨 AZ 高可用：Pod 反亲和 + topologySpreadConstraints + 跨 AZ PVC
5. 调度治理：亲和性 + 污点 + 优先级抢占 + QoS 等级
6. 数据持久化：PV/PVC/StorageClass + CSI + 热/温/冷分层 + 5 年归档
7. 网络合规：NetworkPolicy default-deny + 医保结算物理隔离 + 客户端 IP 保留
8. 零宕机发布：滚动 + 金丝雀 + PDB + readinessProbe + HPA 联动
9. 全链路可观测：Prometheus 指标 + Loki 日志 + Jaeger 链路 + 告警闭环
10. 合规零事故：等保三级 + 医疗监管 + 数据 5 年归档
```

---

## 全链路架构总览

### 一、整体分层架构

```
┌────────────────────────────────────────────────────────────────────────────┐
│  C 端入口层                                                                  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │
│  │ 患者APP/H5   │  │ 医师工作台   │  │ 医保局接口   │  │ 监管上报接口 │        │
│  │ (微信小程序) │  │ (PC/Pad)    │  │              │  │              │        │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘        │
└────────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  接入层（Ingress + LoadBalancer）                                            │
│  ┌─────────────────────────┐  ┌─────────────────────────┐                  │
│  │ NGINX Ingress Controller │  │ 云厂商 SLB                │                  │
│  │ (DaemonSet hostNetwork)  │  │ (LoadBalancer Service)    │                  │
│  │ - TLS 终止、限流、灰度     │  │ - 4 层 LB → Ingress Node │                  │
│  │ - WAF 接入、审计日志       │  │ - 跨 AZ 多后端            │                  │
│  └─────────────────────────┘  └─────────────────────────┘                  │
└────────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  业务应用层（按 Namespace 分租户 + Workload 编排）                            │
│                                                                            │
│  Namespace: health-platform（自有业务）                                     │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐        │
│  │ 体检预约 Web   │ │ 体检报告服务   │ │ 医保结算服务   │ │ AI 推理服务    │        │
│  │ Deployment    │ │ Deployment    │ │ Deployment    │ │ Deployment    │        │
│  │ 10 副本跨 3AZ │ │ 6 副本跨 3AZ  │ │ 3 副本污点节点 │ │ 2 副本 GPU 节点│        │
│  │ PriorityClass │ │ PriorityClass │ │ PriorityClass │ │ PriorityClass │        │
│  │ = core-biz    │ │ = core-biz    │ │ = medical-ins │ │ = ai-inference│        │
│  └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘        │
│  ┌──────────────┐ ┌──────────────┐                                          │
│  │ PDF 批处理 Job │ │ Filebeat     │                                          │
│  │ CronJob       │ │ DaemonSet    │                                          │
│  │ PriorityClass │ │ 每节点一份    │                                          │
│  │ = batch-low   │ │ 医保节点除外  │                                          │
│  └──────────────┘ └──────────────┘                                          │
│                                                                            │
│  Namespace: tenant-a / tenant-b / tenant-c / tenant-d（4 家医共体客户）       │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐        │
│  │ tenant-a Web  │ │ tenant-a Redis│ │ tenant-a MySQL│ │ tenant-a PDF │        │
│  │ Deployment    │ │ StatefulSet   │ │ StatefulSet   │ │ CronJob       │        │
│  └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘        │
│                                                                            │
│  Namespace: middleware（中间件共享）                                         │
│  ┌──────────────┐ ┌──────────────┐                                          │
│  │ Redis Cluster │ │ MySQL 主从    │                                          │
│  │ StatefulSet   │ │ StatefulSet   │                                          │
│  │ 6 节点跨 3AZ  │ │ 主从跨 AZ     │                                          │
│  └──────────────┘ └──────────────┘                                          │
│                                                                            │
│  Namespace: observability（可观测性）                                        │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐        │
│  │ Prometheus    │ │ Grafana       │ │ Loki         │ │ Jaeger       │        │
│  │ StatefulSet   │ │ Deployment    │ │ StatefulSet  │ │ Deployment   │        │
│  └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘        │
└────────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  Service 网络层                                                              │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐            │
│  │ ClusterIP    │ │ Headless     │ │ LoadBalancer │ │ ExternalName │            │
│  │ 内部微服务    │ │ StatefulSet  │ │ Ingress 后端 │ │ 外部服务封装 │            │
│  └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘            │
│  ┌─────────────────────────────┐  ┌─────────────────────────────┐            │
│  │ kube-proxy ipvs 模式          │  │ CoreDNS                       │            │
│  │ - rr/wrr/lc/sh 调度算法       │  │ - ndots:5 陷阱规避            │            │
│  │ - 规则复杂度 O(1)             │  │ - Pod 域名 + Headless 解析     │            │
│  └─────────────────────────────┘  └─────────────────────────────┘            │
│  ┌─────────────────────────────┐  ┌─────────────────────────────┐            │
│  │ Calico CNI (BGP 模式)        │  │ NetworkPolicy default-deny   │            │
│  │ - Pod IP 跨节点原生可路由     │  │ - Namespace 间默认拒绝       │            │
│  │ - 无 Overlay 性能损耗        │  │ - 医保结算出向白名单          │            │
│  └─────────────────────────────┘  └─────────────────────────────┘            │
└────────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  存储层（按场景分级存储）                                                     │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐            │
│  │ 体检 PDF      │ │ 医疗影像      │ │ Redis 数据   │ │ MySQL 数据   │            │
│  │ CephFS RWX    │ │ MinIO 对象存储 │ │ Ceph RBD     │ │ Ceph RBD     │            │
│  │ StorageClass  │ │ 热/温/冷分层   │ │ StorageClass │ │ StorageClass │            │
│  │ WaitForFirst │ │ 30d/90d/归档  │ │ WaitForFirst │ │ WaitForFirst │            │
│  └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘            │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐            │
│  │ ConfigMap    │ │ Secret       │ │ emptyDir     │ │ hostPath     │            │
│  │ 应用配置     │ │ 医保私钥/KMS  │ │ Pod 临时文件  │ │ DaemonSet    │            │
│  │ 热更新+reloader│ │ etcd KMS 加密│ │              │ │              │            │
│  └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘            │
└────────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  调度与资源治理层                                                             │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐            │
│  │ 节点亲和性   │ │ 污点容忍度   │ │ 拓扑分布     │ │ 优先级抢占    │            │
│  │ nodeAffinity │ │ Taint/Tolera│ │ topologySpread│ │ PriorityClass│            │
│  │ 医保专用      │ │ GPU 专用     │ │ 跨 3AZ 均匀   │ │ 5 级优先级    │            │
│  └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘            │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐            │
│  │ QoS 等级     │ │ ResourceQuota│ │ LimitRange   │ │ Node Allocatable│         │
│  │ Guaranteed   │ │ 命名空间配额  │ │ 默认/最大/最小│ │ 系统预留 10%  │            │
│  │ /Burstable   │ │ 4 客户分配   │ │ 防 100 核 Pod │ │ kube/eviction │            │
│  └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘            │
└────────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  基础设施层（K8s 集群 + 控制面 HA）                                          │
│  ┌──────────────────────────────────────────────────────────────┐            │
│  │  控制面（3 master，外部 etcd 拓扑，跨 3 AZ）                    │            │
│  │  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐             │            │
│  │  │ kube-apiserver│ │kube-scheduler│ │kube-controller│             │            │
│  │  │ 6443 HTTPS    │ │ Leader 选举   │ │ Leader 选举   │             │            │
│  │  │ 多副本+LB     │ │ 多副本        │ │ 多副本        │             │            │
│  │  └─────────────┘ └─────────────┘ └─────────────┘             │            │
│  │  ┌─────────────────────────────────────────────┐              │            │
│  │  │ etcd 集群（5 节点 Raft，跨 3 AZ）             │              │            │
│  │  │ 2379/2380，定期快照备份                       │              │            │
│  │  └─────────────────────────────────────────────┘              │            │
│  └──────────────────────────────────────────────────────────────┘            │
│  ┌──────────────────────────────────────────────────────────────┐            │
│  │  数据面（30 worker，3 AZ × 10 节点）                           │            │
│  │  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐             │            │
│  │  │ kubelet     │ │ kube-proxy  │ │ CNI Calico  │             │            │
│  │  │ 10250       │ │ ipvs 模式   │ │ BGP 模式    │             │            │
│  │  └─────────────┘ └─────────────┘ └─────────────┘             │            │
│  └──────────────────────────────────────────────────────────────┘            │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## 二、Day01 K8s 核心架构与 Pod 设计模式在全链路中的位置

### 2.1 控制面 HA 与 Pod 设计模式全链路

```
┌────────────────────────────────────────────────────────────────────────────┐
│  Day01 在全链路中的位置：底座层                                                │
└────────────────────────────────────────────────────────────────────────────┘

Step 1: 集群拓扑设计
   ↓
   - 3 master 跨 3 AZ（AZ-A/B/C 各 1 台）
   - 外部 etcd 拓扑（5 节点 etcd 集群跨 3 AZ：A/B/C 各 1 台 + A/B 各 1 台备用）
   - 30 worker 跨 3 AZ（每 AZ 10 台）
   - 节点角色标签：
     * node-role.kubernetes.io/worker=true（24 台通用节点）
     * node-role.kubernetes.io/medical-insurance=true（3 台医保专用）
     * node-role.kubernetes.io/gpu=true（3 台 GPU 节点）
   - 节点污点：
     * medical-insurance-dedicated:NoSchedule（医保专用节点）
     * nvidia.com/gpu:NoSchedule（GPU 节点）

Step 2: 控制面组件部署
   ↓
   - kube-apiserver：3 副本，前面挂内网 SLB（apiserver.cluster.local:6443）
     * --max-requests-inflight=400 --max-mutating-requests-inflight=200
     * --enable-priority-and-fairness=true（大集群必须开启）
   - etcd：5 节点 Raft（3 AZ 部署，quorum=3，容忍 2 节点宕机）
     * --quota-backend-bytes=8GB
     * 定期快照：每小时 1 次，保留 24 份
   - kube-scheduler：3 副本 Leader 选举（基于 endpoints/lease）
   - kube-controller-manager：3 副本 Leader 选举

Step 3: Pod 设计模式落地（核心业务 Pod 的多容器设计）
   ↓
   - 体检预约 Web 服务 Pod（Sidecar 模式）：
     * 主容器：spring-boot-web（业务逻辑）
     * Sidecar 容器：filebeat（日志采集，emptyDir 共享日志目录）
     * Sidecar 容器：envoy-proxy（Mesh 代理，接收 xDS 配置）
     * Init 容器：wait-for-mysql（等待 MySQL 启动）
     * Init 容器：wait-for-redis（等待 Redis Cluster 就绪）

   - 医保结算服务 Pod（Ambassador 模式）：
     * 主容器：medical-insurance-service（业务逻辑）
     * Ambassador 容器：医保局接口代理（限流 + 熔断 + 重试，独立于业务容器）
     * Sidecar 容器：audit-log-collector（审计日志采集，独立于业务日志）
     * Init 容器：load-cert-from-secret（加载医保私钥到容器）

   - AI 推理服务 Pod（Adapter 模式）：
     * 主容器：triton-inference-server（模型推理）
     * Adapter 容器：metrics-exporter（Prometheus 指标适配）
     * Adapter 容器：preprocess-service（图像预处理，独立于推理容器）
     * Sidecar 容器：model-puller（从对象存储拉取最新模型）

   - Filebeat DaemonSet Pod（单容器 + hostPath）：
     * 主容器：filebeat
     * Volume：hostPath /var/log/containers（采集节点上所有 Pod 日志）
     * Volume：ConfigMap filebeat-config（采集规则）

Step 4: Pod 探针设计（livenessProbe / readinessProbe / startupProbe）
   ↓
   - livenessProbe（存活探针，失败则重启容器）：
     * 体检预约 Web：HTTP GET /actuator/health/liveness，periodSeconds=10
     * MySQL：TCP 3306，periodSeconds=10
   - readinessProbe（就绪探针，失败则从 Service Endpoints 摘除）：
     * 体检预约 Web：HTTP GET /actuator/health/readiness，periodSeconds=5
     * Redis Cluster：TCP 6379 + ping 检查
   - startupProbe（启动探针，启动期间禁用 liveness，避免慢启动被重启）：
     * 体检预约 Web：HTTP GET /actuator/health/liveness
     * failureThreshold=30，periodSeconds=10（最长 5 分钟启动）
     * 适用于 JVM 应用（JVM 启动慢 + JIT 预热）
```

### 2.2 关键工程节点

```
- 控制面 3 master 跨 3 AZ + 外部 etcd 5 节点 Raft（Day01）
- apiserver 前置 SLB + Priority and Fairness 限流（Day01）
- Pod 多容器设计模式：Sidecar/Ambassador/Adapter/Init 四种模式按场景落地（Day01）
- liveness/readiness/startup 三探针配合避免慢启动被重启（Day01）
- Pod 状态机：Pending -> Running -> Succeeded/Failed，与控制器联动（Day01）
- etcd 定期快照 + 跨 AZ 备份（Day01 + Day04）
- 节点角色标签 + 污点预定义（为 Day05 调度约束铺垫）
```

---

## 三、Day02 Workload 编排与发布工程在全链路中的位置

### 3.1 Workload 五件套与发布工程全链路

```
┌────────────────────────────────────────────────────────────────────────────┐
│  Day02 在全链路中的位置：业务编排层                                            │
└────────────────────────────────────────────────────────────────────────────┘

Step 1: Workload 选型矩阵（10 类业务 -> 5 种 Workload）
   ↓
   ┌────────────────────────┬──────────────────┬──────────────────────────┐
   │ 业务                    │ Workload          │ 关键配置                  │
   ├────────────────────────┼──────────────────┼──────────────────────────┤
   │ 体检预约 Web             │ Deployment        │ 10 副本，跨 3AZ 反亲和    │
   │ 体检报告服务             │ Deployment        │ 6 副本，跨 3AZ 反亲和     │
   │ 医保结算服务             │ Deployment        │ 3 副本，污点节点          │
   │ AI 推理服务              │ Deployment        │ 2 副本，GPU 节点          │
   │ Redis Cluster           │ StatefulSet       │ 6 副本，Headless Service  │
   │ MySQL 主从              │ StatefulSet       │ 2 副本，Headless Service  │
   │ Filebeat 日志采集        │ DaemonSet         │ 每节点一份，医保节点除外  │
   │ NGINX Ingress           │ DaemonSet         │ 每节点一份，hostNetwork   │
   │ PDF 批处理               │ CronJob           │ 每天 02:00 触发           │
   │ 医保目录同步             │ CronJob           │ 每天 02:00 触发           │
   └────────────────────────┴──────────────────┴──────────────────────────┘

Step 2: Deployment 滚动发布策略（零宕机）
   ↓
   - 体检预约 Web：
     * replicas: 10
     * strategy: RollingUpdate
     * maxSurge: 3（多启动 3 个新 Pod，比 maxUnavailable 更安全）
     * maxUnavailable: 0（绝不减少可用副本，零宕机核心）
     * revisionHistoryLimit: 10（保留 10 个历史版本，支持 5 分钟回滚）
     * progressDeadlineSeconds: 600（10 分钟没滚完判失败）

   - readinessProbe + maxSurge=3 + maxUnavailable=0 联动：
     * 新 Pod readinessProbe 通过后才进入 Service Endpoints
     * 老 Pod 在新 Pod 就绪后才被终止
     * 终止前发送 SIGTERM + terminationGracePeriodSeconds=60
     * preStop hook：sleep 10s + curl -X POST /actuator/shutdown
     * 确保 kube-proxy 规则更新 + Service 流量切换完成

   - PodDisruptionBudget（PDB）保证自愿中断下最少可用副本：
     * apiVersion: policy/v1
     * kind: PodDisruptionBudget
     * metadata: name: booking-web-pdb
     * spec:
         minAvailable: 8（始终至少 8 个副本可用）
         selector:
           matchLabels:
             app: booking-web

Step 3: StatefulSet 有状态服务编排
   ↓
   - Redis Cluster（StatefulSet）：
     * serviceName: redis-cluster（Headless）
     * replicas: 6
     * podManagementPolicy: OrderedReady（有序启动，redis-0 先就绪再启 redis-1）
     * updateStrategy: RollingUpdate
       partition: 0（灰度时设 partition=3，只滚后 3 个）
     * volumeClaimTemplates:
       - metadata: name: redis-data
         spec:
           accessModes: [ReadWriteOnce]
           storageClassName: ceph-rbd
           resources:
             requests:
               storage: 50Gi
     * podAntiAffinity: 跨 AZ 反亲和（topologyKey: topology.kubernetes.io/zone）
     * 每副本稳定 DNS：redis-0.redis-cluster.middleware.svc.cluster.local:6379

   - MySQL 主从（StatefulSet + Operator）：
     * 使用 vitess-operator 或 mysql-operator（Operator 模式管理生命周期）
     * 自动主从复制、自动故障切换、自动备份
     * StatefulSet 提供稳定标识 + 稳定存储，Operator 管理业务逻辑

Step 4: DaemonSet 节点级守护
   ↓
   - Filebeat 日志采集（DaemonSet）：
     * updateStrategy: RollingUpdate
     * maxUnavailable: 1（一次只滚一个节点，避免日志断流）
     * tolerations: 控制面污点容忍（控制面也要采集日志）
     * nodeSelector: kubernetes.io/os=linux
     * 排除医保节点：通过 Namespace + NetworkPolicy 隔离（不直接在 DaemonSet 排除）

   - NGINX Ingress Controller（DaemonSet + hostNetwork）：
     * hostNetwork: true（直接用节点网络，性能无损）
     * daemonset 也行，deployment + nodeSelector 也行，看场景
     * tolerations: 控制面 + GPU 节点污点容忍（所有节点都能接 Ingress 流量）

Step 5: Job/CronJob 批处理
   ↓
   - PDF 批处理（CronJob）：
     * schedule: "0 2 * * *"（每天 02:00 触发）
     * jobTemplate:
       spec:
         parallelism: 5（5 个 Pod 并行）
         completions: 20（共 20 个 Pod 完成 10w 体检报告）
         backoffLimit: 3（失败重试 3 次）
         activeDeadlineSeconds: 7200（2 小时超时）
         template:
           spec:
             priorityClassName: batch-low（低优先级，可被抢占）
             containers:
               - name: pdf-generator
                 image: pdf-generator:1.0
                 resources:
                   requests: { cpu: 2, memory: 4Gi }
                   limits:   { cpu: 2, memory: 4Gi }（Guaranteed QoS）

Step 6: HPA + 滚动发布联动防雪崩
   ↓
   - 体检预约 Web HPA：
     * minReplicas: 10
     * maxReplicas: 50
     * metrics:
       - type: Resource
         resource:
           name: cpu
           target: { type: Utilization, averageUtilization: 70 }
       - type: Resource
         resource:
           name: memory
           target: { type: Utilization, averageUtilization: 80 }
   - HPA + maxSurge/maxUnavailable 联动：
     * 流量突增 -> HPA 扩容到 50 副本
     * 扩容期间 maxUnavailable=0 保证老副本不挂
     * 流量回落后 HPA 缩容，但 PDB minAvailable=8 兜底

Step 7: 金丝雀发布 + 蓝绿发布实战
   ↓
   - 金丝雀（基于 Service Selector + 标签）：
     * v1 Deployment: app=booking-web, version=v1, replicas=10
     * v2 Deployment: app=booking-web, version=v2, replicas=1
     * Service selector: app=booking-web（不带 version 标签，两个版本都接流量）
     * 通过 replica 比例控制流量：1/11 ≈ 9% 流量到 v2
     * 监控 v2 错误率、延迟、业务指标
     * 逐步 v2 扩到 3, 5, 10，v1 缩到 0
   - 蓝绿（基于双 Service + Ingress 切换）：
     * blue Service: selector version=v1
     * green Service: selector version=v2
     * Ingress 默认指向 blue
     * 切换时改 Ingress backend 到 green，秒级回滚
```

### 3.2 关键工程节点

```
- Workload 五件套按业务形态选型（Day02）
- Deployment maxSurge=3 + maxUnavailable=0 零宕机发布（Day02）
- PDB minAvailable=8 保证自愿中断下最少副本（Day02）
- StatefulSet OrderedReady + volumeClaimTemplates + Headless Service 三件套（Day02）
- DaemonSet tolerations 控制面容忍 + hostNetwork 高性能（Day02）
- CronJob parallelism/completions/backoffLimit 控制批处理（Day02）
- HPA + 滚动发布联动防雪崩（Day02 + Day05 QoS）
- 金丝雀基于 Service Selector 标签版本控制流量比例（Day02 + Day03）
- 蓝绿基于双 Service + Ingress backend 切换（Day02 + Day03）
- preStop hook + terminationGracePeriodSeconds 优雅终止（Day02）
```

---

## 四、Day03 Service 与网络模型在全链路中的位置

### 4.1 Service 网络与流量入口全链路

```
┌────────────────────────────────────────────────────────────────────────────┐
│  Day03 在全链路中的位置：流量入口层                                            │
└────────────────────────────────────────────────────────────────────────────┘

Step 1: Service 类型选型矩阵
   ↓
   ┌────────────────────────┬──────────────────┬──────────────────────────┐
   │ 业务                    │ Service 类型      │ 关键配置                  │
   ├────────────────────────┼──────────────────┼──────────────────────────┤
   │ 体检预约 Web             │ ClusterIP         │ 内部微服务调用             │
   │ 体检报告服务             │ ClusterIP         │ 内部微服务调用             │
   │ 医保结算服务             │ ClusterIP         │ 内部调用 + NodePort 备用   │
   │ 医保接口代理             │ ExternalName      │ CNAME 到医保局域名          │
   │ Redis Cluster           │ Headless          │ 返回 Pod IP 列表            │
   │ MySQL 主从              │ Headless          │ 客户端直连 redis-0/mysql-0  │
   │ AI 推理服务              │ ClusterIP         │ 内部调用                    │
   │ NGINX Ingress           │ LoadBalancer      │ 云厂商 SLB → Ingress Node  │
   │ 监控 Grafana            │ ClusterIP + Ingress│ 内部访问 + 域名访问         │
   └────────────────────────┴──────────────────┴──────────────────────────┘

Step 2: 外部流量入口（Ingress + LoadBalancer）
   ↓
   - 云厂商 SLB（4 层）：
     * type: LoadBalancer
     * externalTrafficPolicy: Local（保留客户端真实 IP，不 SNAT）
     * 健康检查：/healthz，端口 10254
     * 跨 3 AZ 多后端（10 个节点都接 SLB）
   - NGINX Ingress Controller（DaemonSet hostNetwork）：
     * 每节点一个 Ingress Pod，直接用节点 80/443 端口
     * Ingress 资源：
       apiVersion: networking.k8s.io/v1
       kind: Ingress
       metadata:
         name: booking-web-ingress
         annotations:
           nginx.ingress.kubernetes.io/limit-rps: "1000"（限流）
           nginx.ingress.kubernetes.io/canary: "true"（金丝雀）
           nginx.ingress.kubernetes.io/canary-weight: "10"
       spec:
         tls:
           - hosts: [booking.example.com]
             secretName: booking-tls
         rules:
           - host: booking.example.com
             http:
               paths:
                 - path: /
                   pathType: Prefix
                   backend:
                     service:
                       name: booking-web
                       port:
                         number: 8080

Step 3: Service 转发原理（kube-proxy ipvs 模式）
   ↓
   - 为什么选 ipvs 不选 iptables：
     * iptables 规则随 Service/Endpoint 数量线性增长，10w+ 规则后性能急剧下降
     * ipvs 基于 hash 表，规则复杂度 O(1)，大集群必选
     * ipvs 支持 rr/wrr/lc/sh 等多种调度算法
   - ipvs 调度算法选型：
     * rr（轮询）：默认，适合均匀后端
     * wrr（加权轮询）：后端性能差异大时按权重分配
     * lc（最少连接）：长连接场景（数据库、Redis）
     * sh（源地址哈希）：会话保持，但 K8s 有 sessionAffinity 替代
   - 体检预约 Web Service（ClusterIP）：
     * type: ClusterIP
     * clusterIP: 10.96.100.100（手动指定，便于 DNS 缓存）
     * sessionAffinity: None（无状态服务不需要）
     * internalTrafficPolicy: Cluster（默认，跨节点转发）
   - 医保结算 Service（保留客户端 IP）：
     * type: ClusterIP（内部调用）
     * externalTrafficPolicy: Local（如果走 NodePort/LoadBalancer，保留客户端 IP）
     * 注解：service.beta.kubernetes.io/aws-load-balancer-type: nlb

Step 4: CoreDNS 解析链路
   ↓
   - DNS 解析 Pod 访问 booking-report.health-platform.svc.cluster.local 的链路：
     * Pod 的 /etc/resolv.conf: search default.svc.cluster.local svc.cluster.local cluster.local
     * CoreDNS 解析 -> 返回 ClusterIP 10.96.100.100
     * Pod 访问 ClusterIP -> kube-proxy ipvs DNAT -> 后端 Pod IP
   - ndots:5 陷阱规避：
     * Pod 访问 booking-report（短名）-> 触发 5 次解析尝试
     * 优化：用 FQHN（booking-report.health-platform.svc.cluster.local.）或减少 ndots
     * CoreDNS 配置：
       apiVersion: v1
       kind: ConfigMap
       metadata:
         name: coredns
         namespace: kube-system
       data:
         Corefile: |
           .:53 {
               errors
               health
               ready
               kubernetes cluster.local in-addr.arpa ip6.arpa {
                 pods insecure
                 fallthrough in-addr.arpa ip6.arpa
               }
               prometheus :9153
               forward . /etc/resolv.conf
               cache 30
               loop
               reload
               loadbalance
           }
   - Headless Service 解析（StatefulSet 稳定标识）：
     * redis-cluster Headless -> 返回 6 个 Pod IP 列表
     * redis-0.redis-cluster.middleware.svc.cluster.local -> 单个 Pod IP
     * Redis Cluster 客户端直接连 redis-0，主从切换时客户端自动感知

Step 5: NetworkPolicy 多租户网络隔离
   ↓
   - default-deny 基线（每个 Namespace 默认拒绝所有入向）：
     apiVersion: networking.k8s.io/v1
     kind: NetworkPolicy
     metadata:
       name: default-deny
       namespace: health-platform
     spec:
       podSelector: {}
       policyTypes: [Ingress]
   - 医保结算 Namespace 严格白名单：
     apiVersion: networking.k8s.io/v1
     kind: NetworkPolicy
     metadata:
       name: medical-insurance-allow
       namespace: health-platform
     spec:
       podSelector:
         matchLabels:
           app: medical-insurance
       policyTypes: [Ingress, Egress]
       ingress:
         - from:
             - podSelector:
                 matchLabels:
                   app: booking-web
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
                   k8s-app: kube-dns
           ports:
             - protocol: UDP
               port: 53
         - to:
             - namespaceSelector:
                 matchLabels:
                   kubernetes.io/metadata.name: middleware
               podSelector:
                 matchLabels:
                   app: redis-cluster
           ports:
             - protocol: TCP
               port: 6379
         - to:
             - ipBlock:
                 cidr: 0.0.0.0/0
                 exceptions:
                   - 10.0.0.0/8（禁止访问内网其他服务）
           ports:
             - protocol: TCP
               port: 443（仅允许出向 HTTPS 到医保局域名）

Step 6: CNI 选型（Calico BGP 模式）
   ↓
   - 为什么选 Calico BGP 不选 Flannel VXLAN：
     * Flannel VXLAN 有 Overlay 封装损耗（约 5%-10%）
     * Calico BGP 模式下 Pod IP 跨节点原生可路由，无封装损耗
     * Calico 支持 NetworkPolicy，Flannel 不支持（需 Calico for NetworkPolicy）
   - BGP 模式架构：
     * 每节点运行 BGP agent，与路由反射器（RR）建立 BGP 邻居
     * 节点学习到所有 Pod CIDR 路由
     * Pod 跨节点通信直接走底层网络，无 Overlay
   - BGP 模式前提：节点网络可路由（同一 VPC / 同一数据中心）
```

### 4.2 关键工程节点

```
- Ingress + LoadBalancer 双层入口（Day03）
- externalTrafficPolicy: Local 保留客户端 IP 给医保局审计（Day03）
- kube-proxy ipvs 模式 + wrr 调度算法（Day03）
- CoreDNS ndots:5 陷阱规避 + cache 30（Day03）
- Headless Service 提供 StatefulSet 稳定标识（Day03 + Day02）
- NetworkPolicy default-deny + 严格白名单（Day03）
- Calico BGP 模式无 Overlay 损耗（Day03）
- EndpointSlice 取代 Endpoints 应对大规模 Endpoints（Day03）
- Service sessionAffinity 应用场景（Day03）
- 金丝雀基于 Ingress canary-weight 流量切分（Day03 + Day02）
```

---

## 五、Day04 存储卷与配置管理在全链路中的位置

### 5.1 存储与配置全链路

```
┌────────────────────────────────────────────────────────────────────────────┐
│  Day04 在全链路中的位置：数据持久化层                                          │
└────────────────────────────────────────────────────────────────────────────┘

Step 1: 存储场景分级矩阵
   ↓
   ┌──────────────────────────┬──────────────────┬──────────────────────────┐
   │ 场景                      │ StorageClass      │ 关键配置                  │
   ├──────────────────────────┼──────────────────┼──────────────────────────┤
   │ 体检 PDF 文件存储          │ cephfs-rwx        │ RWX，多 Pod 共享          │
   │ 医疗影像 DICOM            │ minio-hot/warm/cold│ 对象存储分层              │
   │ Redis Cluster 持久化      │ ceph-rbd          │ RWO，每副本独立 PVC       │
   │ MySQL 主从数据            │ ceph-rbd-high-iops│ RWO，高 IOPS              │
   │ 应用日志（Filebeat 采集）  │ emptyDir + hostPath│ Pod 临时 + 节点级         │
   │ Spring Boot 配置          │ ConfigMap         │ 热更新 + reloader         │
   │ 医保私钥/密码             │ Secret + KMS      │ etcd KMS 加密             │
   │ TLS 证书                  │ Secret + cert-manager│ 自动续期                │
   └──────────────────────────┴──────────────────┴──────────────────────────┘

Step 2: StorageClass 设计（5 个 StorageClass）
   ↓
   - ceph-rbd（普通块存储）：
     * provisioner: ceph.csi.ceph.com
     * accessModes: [ReadWriteOnce]
     * reclaimPolicy: Retain（生产必选，防止误删数据）
     * volumeBindingMode: WaitForFirstConsumer（跨 AZ 必选）
     * allowVolumeExpansion: true（支持在线扩容）
     * parameters: pool=rbd-pool, imageFeatures=layering
   - ceph-rbd-high-iops（高 IOPS 块存储）：
     * 同上，但 parameters 指定高 IOPS 池
     * 用于 MySQL 主从
   - cephfs-rwx（共享文件存储）：
     * provisioner: ceph.csi.ceph.com
     * accessModes: [ReadWriteMany]
     * 用于体检 PDF 多 Pod 共享
   - minio-hot / minio-warm / minio-cold（对象存储分层）：
     * 用于医疗影像 DICOM 热/温/冷分层
     * 30 天热（SSD）、90 天温（HDD）、长期冷归档（磁带库/云归档）

Step 3: StatefulSet volumeClaimTemplates 实战
   ↓
   - Redis Cluster StatefulSet：
     apiVersion: apps/v1
     kind: StatefulSet
     metadata:
       name: redis-cluster
       namespace: middleware
     spec:
       serviceName: redis-cluster
       replicas: 6
       template:
         spec:
           containers:
             - name: redis
               volumeMounts:
                 - name: redis-data
                   mountPath: /data
       volumeClaimTemplates:
         - metadata:
             name: redis-data
           spec:
             accessModes: [ReadWriteOnce]
             storageClassName: ceph-rbd
             resources:
               requests:
                 storage: 50Gi

   - MySQL 主从 StatefulSet：
     * 每副本独立 PVC（mysql-data-mysql-0, mysql-data-mysql-1）
     * StorageClass: ceph-rbd-high-iops
     * 跨 AZ 反亲和 + topologySpreadConstraints
     * Pod 重建后 PVC 保留，数据不丢

Step 4: 跨 AZ 容灾存储设计
   ↓
   - WaitForFirstConsumer 的关键作用：
     * Immediate 模式：PVC 创建时就分配 PV，可能在 AZ-A，但 Pod 被调度到 AZ-B
     * WaitForFirstConsumer：等 Pod 调度后再分配 PV，保证 PV 与 Pod 同 AZ
   - 跨 AZ PVC 反亲和：
     * 通过 topology.kubernetes.io/zone 节点标签
     * Pod 调度到 AZ-A，PV 也从 AZ-A 的 Ceph pool 分配
   - 跨 AZ 数据复制（Ceph RBD Mirror）：
     * AZ-A 的 Ceph 集群与 AZ-B 的 Ceph 集群做 RBD Mirror
     * 主库在 AZ-A，从库在 AZ-B，数据异步复制
     * 主库故障时切换到从库（Operator 自动切换）

Step 5: ConfigMap 热更新 + reloader
   ↓
   - ConfigMap 挂载方式：
     * Volume 挂载：自动热更新（symlink 重新指向），但需应用 reload
     * env 挂载：不热更新（Pod 重启才生效）
   - Spring Boot 应用 + reloader Sidecar：
     * ConfigMap 通过 Volume 挂载到 /config
     * reloader Sidecar 监听文件变化，触发 Spring Boot reload
     * 或用 spring-cloud-kubernetes 自动 reload
   - 关键 ConfigMap：
     * application.yaml（数据库连接、Redis 地址）
     * logback.xml（日志级别）
     * feature-flags.yaml（功能开关）

Step 6: Secret 加密管理（医保私钥 + TLS 证书）
   ↓
   - etcd KMS 加密：
     * kube-apiserver 启动参数：--encryption-provider-config=encryption.yaml
     * encryption.yaml:
       apiVersion: apiserver.config.k8s.io/v1
       kind: EncryptionConfiguration
       resources:
         - resources: [secrets]
           providers:
             - kms:
                 name: ckms
                 endpoint: unix:///var/run/kmsplugin/socket
                 cachesize: 1000
             - identity: {}
   - 医保私钥 Secret：
     * 类型：kubernetes.io/tls 或 Opaque
     * 数据：医保局下发的 RSA/ECC 私钥 + 证书
     * 挂载方式：Volume 挂载到 /etc/medical-insurance/ssl
     * 应用通过 InputStream 读取，定期 reload（证书续期后）
   - cert-manager 自动管理 TLS 证书：
     * 通过 Let's Encrypt 或内部 CA 自动签发
     * 自动续期：证书到期前 30 天自动 renew
     * 集成 Ingress：cert-manager 自动注入 TLS Secret

Step 7: 医疗影像 DICOM 对象存储设计
   ↓
   - DICOM 文件存储架构：
     * 热数据（30 天内）：MinIO + SSD，低延迟访问
     * 温数据（30-90 天）：MinIO + HDD，归档访问
     * 冷数据（90 天后）：磁带库 / 云归档（OSS IA / S3 Glacier）
     * 生命周期规则：自动迁移
   - DICOM 元数据 + 文件分离存储：
     * DICOM 元数据（患者 ID/检查 ID/检查日期）：PostgreSQL
     * DICOM 文件：MinIO 对象存储
     * 通过对象 URL 关联
   - 备份策略：
     * 跨 AZ 复制（MinIO Bucket Replication）
     * 定期快照（每天 1 次，保留 30 天）
     * 长期归档（5 年合规要求）
```

### 5.2 关键工程节点

```
- StorageClass 分级（ceph-rbd / cephfs-rwx / minio-hot/warm/cold）（Day04）
- WaitForFirstConsumer 保证 PV 与 Pod 同 AZ（Day04）
- StatefulSet volumeClaimTemplates 每副本独立 PVC（Day04 + Day02）
- Ceph RBD Mirror 跨 AZ 数据复制（Day04）
- ConfigMap 热更新 + reloader Sidecar（Day04）
- Secret etcd KMS 加密 + cert-manager 自动续期（Day04）
- 医疗影像 DICOM 热/温/冷分层 + 5 年归档（Day04）
- emptyDir Pod 临时存储 + hostPath DaemonSet 节点级（Day04）
- 跨 AZ 备份 + 跨 AZ 复制 + 长期归档三重数据保护（Day04）
```

---

## 六、Day05 调度与资源管理在全链路中的位置

### 6.1 调度与资源治理全链路

```
┌────────────────────────────────────────────────────────────────────────────┐
│  Day05 在全链路中的位置：调度治理层                                            │
└────────────────────────────────────────────────────────────────────────────┘

Step 1: 节点池设计（节点标签 + 污点）
   ↓
   - 通用节点（24 台）：
     * 标签：node-role.kubernetes.io/worker=true
     * 标签：node-pool=general
     * 无污点，普通业务都可调度
   - 医保专用节点（3 台，跨 3 AZ）：
     * 标签：node-role.kubernetes.io/medical-insurance=true
     * 标签：node-pool=medical-insurance
     * 污点：medical-insurance-dedicated:NoSchedule
   - GPU 节点（3 台，跨 3 AZ）：
     * 标签：node-role.kubernetes.io/gpu=true
     * 标签：nvidia.com/gpu.present=true
     * 污点：nvidia.com/gpu:NoSchedule
   - 控制面节点（3 台）：
     * 默认污点：node-role.kubernetes.io/control-plane:NoSchedule

Step 2: 10 类业务调度约束设计（核心）
   ↓
   ┌──────────────────────────┬────────────────────────────────────────────┐
   │ 业务                      │ 调度约束                                    │
   ├──────────────────────────┼────────────────────────────────────────────┤
   │ 体检预约 Web（10 副本）    │ topologySpreadConstraints maxSkew=1 跨 3AZ │
   │                          │ podAntiAffinity 跨节点反亲和                │
   │                          │ priorityClassName: core-biz                │
   ├──────────────────────────┼────────────────────────────────────────────┤
   │ 体检报告服务（6 副本）     │ topologySpreadConstraints maxSkew=1 跨 3AZ │
   │                          │ podAntiAffinity 跨节点反亲和                │
   │                          │ priorityClassName: core-biz                │
   ├──────────────────────────┼────────────────────────────────────────────┤
   │ 医保结算服务（3 副本）     │ nodeAffinity required 调度到医保专用节点    │
   │                          │ tolerations 容忍 medical-insurance-dedicated│
   │                          │ topologySpreadConstraints 跨 3AZ           │
   │                          │ priorityClassName: medical-insurance       │
   ├──────────────────────────┼────────────────────────────────────────────┤
   │ PDF 批处理 Job             │ priorityClassName: batch-low（可被抢占）   │
   │                          │ 无 nodeAffinity，调度到任意通用节点         │
   │                          │ ResourceQuota 限制总量                      │
   ├──────────────────────────┼────────────────────────────────────────────┤
   │ Redis Cluster（6 副本）   │ podAntiAffinity topologyKey=zone 跨 AZ 反亲和│
   │                          │ podAntiAffinity topologyKey=hostname 同节点反亲和│
   │                          │ priorityClassName: middleware-critical     │
   ├──────────────────────────┼────────────────────────────────────────────┤
   │ MySQL 主从（2 副本）       │ podAntiAffinity topologyKey=zone 主从跨 AZ  │
   │                          │ nodeAffinity preferred 高 IOPS 节点          │
   │                          │ priorityClassName: middleware-critical     │
   ├──────────────────────────┼────────────────────────────────────────────┤
   │ AI 推理服务（2 副本）      │ nodeAffinity required 调度到 GPU 节点       │
   │                          │ tolerations 容忍 nvidia.com/gpu            │
   │                          │ resources.limits nvidia.com/gpu: 1         │
   │                          │ priorityClassName: ai-inference            │
   ├──────────────────────────┼────────────────────────────────────────────┤
   │ Filebeat DaemonSet        │ 每节点一份                                  │
   │                          │ tolerations 控制面污点容忍                  │
   │                          │ 医保节点不采集医保日志外数据（Namespace 隔离）│
   ├──────────────────────────┼────────────────────────────────────────────┤
   │ NGINX Ingress DaemonSet   │ hostNetwork + hostPort 80/443              │
   │                          │ tolerations 所有污点容忍                    │
   ├──────────────────────────┼────────────────────────────────────────────┤
   │ Prometheus + Grafana      │ nodeAffinity preferred 监控节点             │
   │                          │ priorityClassName: system-critical         │
   └──────────────────────────┴────────────────────────────────────────────┘

Step 3: topologySpreadConstraints 跨 3AZ 均匀分布
   ↓
   - 体检预约 Web（10 副本跨 3AZ，每 AZ 3-4 副本）：
     topologySpreadConstraints:
       - maxSkew: 1
         topologyKey: topology.kubernetes.io/zone
         whenUnsatisfiable: DoNotSchedule（硬约束）
         labelSelector:
           matchLabels:
             app: booking-web
       - maxSkew: 1
         topologyKey: kubernetes.io/hostname
         whenUnsatisfiable: ScheduleAnyway（软约束，避免同节点）
         labelSelector:
           matchLabels:
             app: booking-web
   - maxSkew=1 含义：任意两个 AZ 之间 Pod 数差异 ≤ 1
   - 当 AZ-A 故障时，AZ-B/C 各有 3-4 副本，业务不挂

Step 4: 医保结算"专用节点 + 物理隔离"三件套
   ↓
   - 节点污点 + Pod 容忍：
     * 节点：medical-insurance-dedicated:NoSchedule
     * Pod tolerations:
       tolerations:
         - key: medical-insurance-dedicated
           effect: NoSchedule
           operator: Equal
           value: "true"
   - nodeAffinity 强约束调度到医保节点：
     affinity:
       nodeAffinity:
         requiredDuringSchedulingIgnoredDuringExecution:
           nodeSelectorTerms:
             - matchExpressions:
                 - key: node-pool
                   operator: In
                   values: [medical-insurance]
   - NetworkPolicy 网络隔离（Day03 已设计）：
     * 医保结算 Pod 只接受 booking-web 的入向
     * 医保结算 Pod 只允许出向到 DNS、Redis、医保局域名
   - PriorityClass 高优先级：
     * medical-insurance 优先级高于 core-biz 和 batch-low
     * 资源紧张时抢占 PDF 批处理 Pod

Step 5: Redis Cluster 主从跨 AZ
   ↓
   - podAntiAffinity 双重反亲和：
     affinity:
       podAntiAffinity:
         requiredDuringSchedulingIgnoredDuringExecution:
           - labelSelector:
               matchExpressions:
                 - key: app
                   operator: In
                   values: [redis-cluster]
             topologyKey: kubernetes.io/hostname（同节点不调度两个 Redis Pod）
         preferredDuringSchedulingIgnoredDuringExecution:
           - weight: 100
             podAffinityTerm:
               labelSelector:
                 matchExpressions:
                   - key: app
                     operator: In
                     values: [redis-cluster]
               topologyKey: topology.kubernetes.io/zone（跨 AZ 优先）
   - 6 副本跨 3 AZ：AZ-A: redis-0,redis-3 / AZ-B: redis-1,redis-4 / AZ-C: redis-2,redis-5
   - 主从配对：redis-0 主 -> redis-1 从（跨 AZ）

Step 6: GPU 节点独占设计
   ↓
   - GPU 节点污点 + 资源声明：
     * 节点污点：nvidia.com/gpu:NoSchedule
     * Pod 声明：
       resources:
         requests:
           nvidia.com/gpu: 1
         limits:
           nvidia.com/gpu: 1
       tolerations:
         - key: nvidia.com/gpu
           effect: NoSchedule
           operator: Exists
   - GPU 独占保证：
     * nvidia.com/gpu 是整数资源，不能小数分配
     * Pod 声明 1 个 GPU，节点只有 1 个 GPU 时独占该节点
     * 节点上不会调度其他 GPU Pod（除非有 2+ GPU）
   - GPU 时间片共享（vGPU）：通过 NVIDIA vGPU 实现，但医疗 AI 推理延迟敏感，不建议

Step 7: PriorityClass 5 级优先级体系
   ↓
   ┌─────────────────────┬──────────────┬──────────────────────────┐
   │ PriorityClass        │ value         │ 用途                      │
   ├─────────────────────┼──────────────┼──────────────────────────┤
   │ system-critical      │ 1000000       │ 系统组件（kube-proxy/DNS） │
   │ medical-insurance    │ 900000        │ 医保结算（敏感业务）       │
   │ middleware-critical  │ 800000        │ Redis/MySQL 中间件        │
   │ core-biz             │ 700000        │ 体检预约/报告服务          │
   │ ai-inference         │ 600000        │ AI 推理                   │
   │ batch-low            │ 100000        │ PDF 批处理（可被抢占）     │
   └─────────────────────┴──────────────┴──────────────────────────┘
   - 抢占机制：
     * 资源不足时，调度器选牺牲者（Victim）：低优先级 Pod 优先被抢占
     * PDF 批处理 Pod 被高优先级业务抢占，优雅终止 + 重新排队

Step 8: Requests/Limits + QoS 等级
   ↓
   - 体检预约 Web（Guaranteed QoS）：
     resources:
       requests: { cpu: 2, memory: 4Gi }
       limits:   { cpu: 2, memory: 4Gi }
     * Requests = Limits -> Guaranteed QoS
     * 核心服务必须 Guaranteed，避免被驱逐
   - Redis Cluster（Guaranteed QoS）：
     resources:
       requests: { cpu: 4, memory: 8Gi }
       limits:   { cpu: 4, memory: 8Gi }
   - PDF 批处理（Burstable QoS）：
     resources:
       requests: { cpu: 1, memory: 2Gi }
       limits:   { cpu: 2, memory: 4Gi }
     * Requests < Limits -> Burstable QoS
     * 批处理可以容忍被驱逐，Burstable 合理
   - BestEffort（Requests 和 Limits 都不设）：
     * 生产中不用，仅测试环境

Step 9: CPU Throttling 与 OOMKilled 排查
   ↓
   - JVM 应用 CPU Throttling 排查：
     * 监控指标：container_cpu_cfs_throttled_seconds_total
     * 现象：CPU Limits 设为 2 核，实际只用 1.5 核，但 Throttle 严重
     * 根因：CFS 周期边界问题（100ms 周期内瞬间突发被限）
     * 解决方案：Limits 设为 Requests 的 1.5-2 倍，或使用 cpu manager static policy
   - JVM OOMKilled 排查：
     * 现象：Memory Limits 设为 4GB，JVM 堆 3GB，但 OOMKilled
     * 根因：JVM 元空间 + 线程栈 + 堆外内存 + Direct Buffer 未算
     * 解决方案：
       - -XX:MaxRAMPercentage=75（堆占容器内存 75%）
       - -XX:+UseContainerSupport（K8s 1.21+ 自动）
       - 留 25% 给 JVM 非堆 + 堆外内存
   - Prometheus 监控规则：
     * alert: PodCpuThrottlingHigh
       expr: rate(container_cpu_cfs_throttled_seconds_total[5m]) > 0.1
       for: 5m
     * alert: PodOOMKilled
       expr: increase(container_memory_failcnt[5m]) > 0

Step 10: 多租户 ResourceQuota + LimitRange 治理
   ↓
   - 4 家医共体客户 ResourceQuota 分配：
     ┌──────────┬──────────────┬──────────────┬──────────────────────┐
     │ 客户      │ CPU（requests) │ Memory（requests) │ PVC 总量              │
     ├──────────┼──────────────┼──────────────┼──────────────────────┤
     │ tenant-a │ 100 核        │ 200Gi         │ 1Ti                   │
     │ tenant-b │ 50 核         │ 100Gi         │ 500Gi                 │
     │ tenant-c │ 30 核         │ 60Gi          │ 300Gi                 │
     │ tenant-d │ 20 核         │ 40Gi          │ 200Gi                 │
     └──────────┴──────────────┴──────────────┴──────────────────────┘
   - ResourceQuota YAML：
     apiVersion: v1
     kind: ResourceQuota
     metadata:
       name: tenant-a-quota
       namespace: tenant-a
     spec:
       hard:
         requests.cpu: "100"
         requests.memory: 200Gi
         limits.cpu: "200"
         limits.memory: 400Gi
         persistentvolumeclaims: "20"
         requests.storage: "1Ti"
         pods: "50"
   - LimitRange 默认约束：
     apiVersion: v1
     kind: LimitRange
     metadata:
       name: tenant-a-limits
       namespace: tenant-a
     spec:
       limits:
         - type: Container
           default:          # 默认 Limits
             cpu: 2
             memory: 4Gi
           defaultRequest:   # 默认 Requests
             cpu: 500m
             memory: 1Gi
           max:              # 单 Pod 最大 Limits
             cpu: 16
             memory: 32Gi
           min:              # 单 Pod 最小 Requests
             cpu: 100m
             memory: 256Mi
           maxLimitRequestRatio:  # Limits/Requests 比值
             cpu: 4
             memory: 2
   - 系统组件保底（PriorityClass scope）：
     apiVersion: v1
     kind: ResourceQuota
     metadata:
       name: system-reserved
       namespace: kube-system
     spec:
       hard:
         requests.cpu: "50"
       scopes: [PriorityClass]
       scopeSelector:
         matchExpressions:
           - operator: In
             scopeName: PriorityClass
             values: [system-critical]

Step 11: Node Allocatable 节点资源预留
   ↓
   - 节点资源分配：
     * Capacity（物理总量）：24 核 CPU / 96GB 内存 / 2TB 盘
     * System Reserved（系统组件）：--system-reserved=cpu=1,memory=2Gi,ephemeral-storage=10Gi
     * Kube Reserved（K8s 组件）：--kube-reserved=cpu=500m,memory=1Gi,ephemeral-storage=5Gi
     * Eviction Threshold（驱逐阈值）：--eviction-hard=memory.available<1Gi,nodefs.available<10%
     * Allocatable（可分配给 Pod）：约 22 核 / 92GB / 1.95TB
   - 节点资源使用率目标：
     * Requests 总量不超过 Allocatable 的 70%（避免超卖过度）
     * Limits 总量不超过 Allocatable 的 150%（适度超卖）
     * 实际使用率监控告警：节点 CPU > 80% / 内存 > 85% 告警
```

### 6.2 关键工程节点

```
- 节点池分层 + 节点标签 + 污点三件套（Day05）
- 10 类业务调度约束按场景设计（Day05）
- topologySpreadConstraints maxSkew=1 跨 AZ 均匀分布（Day05）
- 医保专用节点"污点 + 容忍 + nodeAffinity + NetworkPolicy + PriorityClass"五件套（Day05 + Day03）
- Redis Cluster podAntiAffinity 双重反亲和跨 AZ（Day05）
- GPU 节点污点 + nvidia.com/gpu 资源声明独占（Day05）
- PriorityClass 5 级优先级 + 抢占机制（Day05）
- Guaranteed QoS 核心服务 + Burstable 批处理（Day05）
- CPU Throttling + OOMKilled 监控告警（Day05）
- ResourceQuota 多租户配额 + LimitRange 默认约束（Day05）
- Node Allocatable 系统预留 + 驱逐阈值（Day05）
```

---

## 七、跨链路协同的关键工程命题

### 7.1 跨域一致性：Pod 状态 + Service Endpoints + PV 绑定 + 调度约束

```
┌────────────────────────────────────────────────────────────────────────────┐
│  跨域一致性四维对齐                                                          │
└────────────────────────────────────────────────────────────────────────────┘

维度1：Pod 状态与 Workload 状态对齐
- Deployment 期望副本数 10 <-> 实际 Running Pod 数 10 <-> Ready Pod 数 10
- 滚动发布期间：期望 10 + maxSurge 3 = 13，老 Pod 终止前新 Pod 必须就绪
- 状态不一致触发告警：Deployment 期望 ≠ 实际副本数 > 5 分钟

维度2：Service Endpoints 与 Pod Ready 状态对齐
- Pod readinessProbe 通过 -> Endpoints 加入该 Pod IP
- Pod readinessProbe 失败 -> Endpoints 摘除该 Pod IP
- 滚动发布期间：新 Pod Ready 才进 Endpoints，老 Pod 终止前从 Endpoints 摘除
- kube-proxy ipvs 规则与 Endpoints 同步（秒级）

维度3：PV 与 Pod 调度位置对齐
- WaitForFirstConsumer：Pod 调度到 AZ-A -> PV 从 AZ-A 分配
- StatefulSet volumeClaimTemplates：redis-0 永远绑 pvc-redis-0
- Pod 重建后 PVC 保留，重新调度到同 AZ（PV 同 AZ 约束）

维度4：调度约束与节点状态对齐
- 节点污点变化 -> Pod 可能被驱逐（NoExecute）
- 节点标签变化 -> 调度约束失效或激活
- 节点 NotReady -> Pod 5分钟后被驱逐（kube-controller-manager 默认）
- PriorityClass 抢占 -> 低优先级 Pod 被优雅终止
```

### 7.2 故障雪崩防护：从单 Pod 故障到集群级雪崩

```
┌────────────────────────────────────────────────────────────────────────────┐
│  故障雪崩防护四层兜底                                                        │
└────────────────────────────────────────────────────────────────────────────┘

Layer 1：Pod 级故障自愈
- livenessProbe 失败 -> kubelet 重启容器（restartPolicy: Always）
- 单容器崩溃 -> Pod 内其他容器不受影响（除非共享 lifecycle）
- 单 Pod 故障 -> Service Endpoints 摘除，流量转发到其他 Pod
- 自愈时长：< 30 秒（restart + readiness 就绪）

Layer 2：节点级故障兜底
- 节点 NotReady -> kubelet 5 分钟标记 Pod 为 Terminating
- kube-controller-manager 触发 Pod 重新调度到其他节点
- StatefulSet Pod 重新调度 -> PVC 跟着走（同 AZ 优先）
- 跨 AZ 拓扑分布保证：单节点故障不超出 maxSkew 容忍范围

Layer 3：AZ 级故障容灾
- 单 AZ 故障（AZ-A 全挂）：
  * 体检预约 Web：AZ-B/C 各 3-4 副本，业务可用
  * Redis Cluster：AZ-B/C 各 2 副本，主从自动切换
  * MySQL 主从：主库在 AZ-A -> 自动切换到从库（AZ-B）
  * PV 跨 AZ 复制（Ceph RBD Mirror）保证数据不丢
- AZ 故障切换时长：< 5 分钟（Pod 重新调度 + 数据复制延迟）

Layer 4：集群级雪崩防护
- HPA + Cluster Autoscaler：流量突增自动扩容 Pod + 节点
- PriorityClass 抢占：核心业务抢占批处理资源
- ResourceQuota 隔离：4 家医共体客户互不影响
- LimitRange 防止单 Pod 吃光节点资源
- Node Allocatable 系统预留：节点资源紧张时系统组件不被饿死
- 驱逐策略：节点内存 < 1Gi 触发 kubelet 驱逐 BestEffort -> Burstable -> Guaranteed
```

### 7.3 多租户隔离：Namespace + ResourceQuota + NetworkPolicy + PriorityClass 四件套

```
┌────────────────────────────────────────────────────────────────────────────┐
│  多租户隔离四维防线                                                          │
└────────────────────────────────────────────────────────────────────────────┘

维度1：Namespace 资源隔离
- 4 家医共体客户各一个 Namespace（tenant-a/b/c/d）
- 自有业务 Namespace：health-platform
- 中间件共享 Namespace：middleware
- 可观测性 Namespace：observability
- RBAC：每客户 ServiceAccount 限定到自己 Namespace

维度2：ResourceQuota 配额隔离
- 每客户独立 ResourceQuota（CPU/Memory/PVC/Pods）
- 防止"一家客户跑飞把整个集群拖垮"
- 配额超限：Pod 创建失败（Pending 状态）
- 4 客户配额合计 < 集群总容量，留余量给系统组件

维度3：NetworkPolicy 网络隔离
- 每 Namespace default-deny 入向
- 跨 Namespace 调用严格白名单
- 医保结算 Namespace 严格出向白名单
- 4 客户之间默认互不可达

维度4：PriorityClass 优先级隔离
- 4 客户使用相同优先级 core-biz-tenant
- 自有业务使用 core-biz
- 资源紧张时：客户业务与自有业务按比例受影响（不偏袒）
- 系统组件 system-critical 永远最高优先级

节点池隔离 vs 命名空间共享权衡：
- 节点池隔离：每客户专用节点池（成本高、利用率低）
- 命名空间共享：共享节点池（成本低、利用率高，依赖软隔离）
- 啄木鸟选型：命名空间共享 + ResourceQuota + NetworkPolicy 软隔离
- 例外：医保结算专用节点池（监管合规要求物理隔离）
```

### 7.4 零宕机发布工程：Day01 探针 + Day02 Workload + Day03 Service + Day05 QoS

```
┌────────────────────────────────────────────────────────────────────────────┐
│  零宕机发布工程五件套联动                                                    │
└────────────────────────────────────────────────────────────────────────────┘

1. Deployment 滚动参数（Day02）：
   - maxSurge: 3 + maxUnavailable: 0
   - 任意时刻可用副本数 ≥ 期望副本数
   - 新 Pod 启动 + 老 Pod 终止错开进行

2. readinessProbe 就绪检查（Day01）：
   - HTTP GET /actuator/health/readiness
   - 失败则不进 Service Endpoints（Day03）
   - 成功后才开始接收流量

3. Service Endpoints 联动（Day03）：
   - kube-proxy ipvs 规则秒级同步
   - 老 Pod 终止前从 Endpoints 摘除
   - terminationGracePeriodSeconds=60 等待流量切换

4. preStop hook 优雅终止（Day02）：
   - sleep 10s（等 kube-proxy 规则更新）
   - curl -X POST /actuator/shutdown（应用主动关闭）
   - SIGTERM 信号处理

5. PDB 兜底（Day02）：
   - minAvailable: 8
   - 自愿中断（节点维护、滚动更新）下保证最少 8 副本可用
   - 非自愿中断（节点故障）不触发 PDB

6. Guaranteed QoS（Day05）：
   - Requests = Limits
   - 节点资源紧张时不被驱逐
   - CPU Throttling 可控（Limits 设为 Requests 的 1-1.5 倍）

7. HPA 联动（Day02 + Day05）：
   - 发布期间流量突增 -> HPA 自动扩容
   - 但 maxSurge 已限制新 Pod 数，避免无限扩容
   - 发布后流量回落 -> HPA 缩容（PDB 兜底）
```

---

## 八、关键场景串联

### 8.1 场景一：体检预约发布期间流量突增 + 零宕机切换

```
2026 年 7 月某日 14:00，啄木鸟云健康发布体检预约 v2.0 版本（新增医保电子凭证扫码功能），
发布期间正值下午预约高峰（QPS 5000+），要求零宕机切换。

Step 1: 发布前准备
   - 体检预约 v1：10 副本，每副本 QPS 500，总 QPS 5000
   - HPA minReplicas=10, maxReplicas=50
   - PDB minAvailable=8
   - readinessProbe: HTTP GET /actuator/health/readiness, periodSeconds=5
   - terminationGracePeriodSeconds=60

Step 2: 触发滚动发布
   - kubectl apply -f booking-web-v2.yaml（image: booking-web:v2.0）
   - Deployment Controller 启动新 ReplicaSet（v2）
   - maxSurge=3：v2 副本数从 0 扩到 3，v1 仍 10 副本（共 13 个 Pod）
   - maxUnavailable=0：v1 副本数不能少于 10

Step 3: 新 Pod 启动 + 就绪检查
   - v2 Pod 启动：Init Container wait-for-mysql + wait-for-redis
   - startupProbe 探测：failureThreshold=30, periodSeconds=10（最长 5 分钟）
   - JVM 启动 + JIT 预热：约 60-90 秒
   - readinessProbe 探测：HTTP GET /actuator/health/readiness
   - 就绪后进入 Service Endpoints

Step 4: Service Endpoints 切换 + kube-proxy 规则更新
   - Endpoints Controller：v2 Pod IP 加入 Endpoints
   - kube-proxy ipvs：v2 Pod IP 加入转发规则（wrr 调度）
   - 流量开始按比例转发到 v2（3/13 ≈ 23%）

Step 5: 老 Pod 优雅终止
   - v1 副本数从 10 缩到 7（保留 7 + 新 3 = 10）
   - 老 Pod 收到 SIGTERM：
     * preStop hook: sleep 10s（等 kube-proxy 规则更新）
     * curl -X POST /actuator/shutdown（应用主动关闭）
     * terminationGracePeriodSeconds=60（最多等 60 秒）
   - Endpoints Controller：v1 Pod IP 从 Endpoints 摘除
   - kube-proxy ipvs：v1 Pod IP 从转发规则删除

Step 6: 流量突增 + HPA 扩容
   - 14:05 QPS 突增到 8000（发布日 + 下午高峰）
   - HPA 检测到 CPU 平均利用率 85%（> 70% 阈值）
   - HPA 扩容：v2 副本数从 3 扩到 16（v1 已终止）
   - maxSurge=3 限制已解除（已切到 v2）
   - 新 Pod 启动 + 就绪后加入 Endpoints

Step 7: 发布完成 + 流量回落
   - v2 全部 16 副本就绪，v1 全部终止
   - 14:30 QPS 回落到 5000，HPA 缩容到 10 副本
   - PDB minAvailable=8 兜底，确保不缩到 8 以下
   - 发布完成，零宕机切换，业务无感知

Step 8: 应急回滚（如果 v2 有严重 bug）
   - kubectl rollout undo deployment/booking-web --to-revision=10
   - 回滚到 v1：新 ReplicaSet（v1）扩容，老 ReplicaSet（v2）缩容
   - 同样走 maxSurge=3 + maxUnavailable=0 流程
   - 回滚时长 < 5 分钟（revisionHistoryLimit=10 保留历史）
```

### 8.2 场景二：单 AZ 故障 + 跨 AZ 自愈 + 数据零丢失

```
2026 年 7 月某日 03:00，AZ-A 因数据中心故障全部断电，3 master 中的 1 台 + 10 worker 中的
4 台 + 2 台 etcd 节点同时宕机。要求业务自愈 + 数据零丢失。

Step 1: 故障检测
   - 03:00:15 AZ-A 节点 NotReady（kubelet 心跳超时）
   - 03:00:30 kube-controller-manager 标记 AZ-A 节点上 Pod 为 Terminating（5 分钟后）
   - 03:00:30 etcd 集群：5 节点中 2 节点宕机，剩余 3 节点仍满足 quorum
   - 03:00:30 控制面：3 master 中 1 台宕机，apiserver 仍可用（前置 SLB 自动摘除）
   - 03:00:30 kube-scheduler/kube-controller-manager：Leader 在 AZ-A？切换到 AZ-B/C

Step 2: 体检预约 Web 自愈
   - AZ-A 上 4 副本 Pod 全部 Pending -> 重新调度到 AZ-B/C
   - topologySpreadConstraints maxSkew=1 重新平衡
   - AZ-B/C 各扩到 5 副本，共 10 副本（与期望一致）
   - 自愈时长：约 2-3 分钟（Pod 启动 + readiness 就绪）

Step 3: Redis Cluster 主从切换
   - AZ-A 上 redis-0（主）和 redis-3（从）宕机
   - Redis Cluster 自动选主：redis-1（AZ-B 从）升级为新主
   - redis-4（AZ-C 从）继续作为 redis-1 的从
   - 6 副本减为 4 副本，仍满足 Redis Cluster quorum
   - 客户端通过 redis-cluster Headless Service 重新发现主节点
   - 自愈时长：< 30 秒（Redis Cluster failover）

Step 4: MySQL 主从切换
   - AZ-A 上 mysql-0（主）宕机
   - Operator 检测主库故障，触发故障切换
   - mysql-1（AZ-B 从）升级为新主
   - 应用通过 mysql-headless Service 重新发现主节点
   - 数据零丢失：异步复制延迟 < 1 秒（Ceph RBD Mirror 跨 AZ 同步）
   - 自愈时长：约 1-2 分钟（Operator 决策 + 切换）

Step 5: PV 跨 AZ 容灾
   - AZ-A 的 PV 数据通过 Ceph RBD Mirror 异步复制到 AZ-B/C
   - Pod 重新调度到 AZ-B/C 时，PV 已在 AZ-B/C 有副本
   - 数据零丢失：RPO < 1 秒（异步复制延迟）
   - 自愈时长：约 1-2 分钟（PV 重新挂载）

Step 6: 医保结算业务自愈
   - AZ-A 上 1 副本医保结算 Pod 宕机
   - 重新调度到 AZ-B/C 的医保专用节点
   - tolerations + nodeAffinity 保证调度到医保专用节点
   - 医保私钥 Secret 已挂载，新 Pod 启动后立即可用
   - 自愈时长：约 2 分钟

Step 7: AI 推理服务自愈
   - AZ-A 上 1 副本 AI 推理 Pod 宕机
   - 重新调度到 AZ-B/C 的 GPU 节点
   - nvidia.com/gpu 资源重新声明
   - 模型从 MinIO 重新拉取（约 30 秒）
   - 自愈时长：约 2-3 分钟

Step 8: 故障恢复后回填
   - 03:30 AZ-A 恢复，节点重新加入集群
   - 体检预约 Web：topologySpreadConstraints 重新平衡，AZ-A 扩到 3-4 副本
   - Redis Cluster：redis-0/redis-3 重新加入，主从重新同步
   - MySQL：mysql-0 重新加入作为从库，数据从 mysql-1 同步
   - 业务无感知，数据零丢失

Step 9: 复盘改进
   - AZ-A 故障根因：数据中心电力系统故障
   - 改进：增加第 4 AZ 容灾（成本权衡后评估）
   - 改进：跨集群备份（异地灾备）
   - 改进：定期演练 AZ 故障（混沌工程）
```

### 8.3 场景三：PDF 批处理挤占医保结算 + 抢占式调度止血

```
2026 年 7 月某日 02:00，PDF 批处理 Job 启动处理 10w 体检报告，同时医保结算服务接收到
夜间医保批量对账请求。集群资源紧张，PDF 批处理挤占医保结算，医保接口超时被监管通报。
要求用 K8s 调度机制止血 + 长期改进。

Step 1: 故障发生
   - 02:00 PDF 批处理 CronJob 触发：parallelism=5，每 Pod 2 核 4Gi，共 10 核 20Gi
   - 02:00 医保批量对账请求：QPS 1000（平时 100）
   - 02:05 医保结算 Pod CPU 100%，响应延迟从 50ms 升到 5s
   - 02:10 医保接口超时，医保局监控告警
   - 02:15 监管通报：医保结算 SLA 不达标

Step 2: 紧急止血
   - 立即缩减 PDF 批处理：
     kubectl scale job pdf-batch --replicas=0
   - 但 Job 已经在跑的 Pod 不会立即终止，需要等优雅终止
   - 强制终止：
     kubectl delete pod -l job-name=pdf-batch --grace-period=0 --force
   - 医保结算 Pod CPU 立即恢复，响应延迟降回 50ms
   - 但 02:00-02:15 期间的医保接口已超时，需要补传

Step 3: 根因分析
   - PDF 批处理和医保结算都调度到通用节点（24 台）
   - PDF 批处理没有节点隔离，与医保结算抢资源
   - PDF 批处理优先级 batch-low，但被调度到与医保结算同节点
   - 节点资源超卖：通用节点 Requests 总和 > Allocatable 的 80%
   - PDF 批处理启动时，节点 CPU 立即 100%，影响医保结算

Step 4: 长期改进方案 - 抢占式调度
   - 医保结算 PriorityClass: medical-insurance（value=900000）
   - PDF 批处理 PriorityClass: batch-low（value=100000）
   - 资源紧张时，调度器选牺牲者：PDF 批处理 Pod 被抢占
   - 抢占流程：
     * 医保结算 Pod Pending（资源不足）
     * 调度器查找可抢占的低优先级 Pod
     * 选 PDF 批处理 Pod 作为 Victim
     * 优雅终止 PDF Pod（preStop hook + terminationGracePeriodSeconds=30）
     * 释放资源给医保结算 Pod
   - 抢占阈值：medical-insurance Pod Pending > 1 分钟触发抢占

Step 5: 长期改进方案 - 资源隔离
   - 医保结算已有专用节点（3 台，污点 medical-insurance-dedicated:NoSchedule）
   - 但夜间对账时 3 副本不够，需要扩容
   - 改进：HPA 配置
     * minReplicas: 3
     * maxReplicas: 10（夜间对账时扩容）
     * metrics: CPU 70% + 自定义指标（医保 QPS）
   - 扩容时新 Pod 调度到医保专用节点（污点容忍）

Step 6: 长期改进方案 - 节点池扩容
   - 夜间 PDF 批处理 + 医保对账同时跑，3 台医保专用节点不够
   - 改进：Cluster Autoscaler 自动扩容
     * 节点池配置：min=3, max=10
     * Pod 因资源不足 Pending -> 触发节点扩容
     * 新节点加入集群（约 2-3 分钟）
     * Pod 调度到新节点
   - 成本权衡：夜间扩容 + 早上缩容，节约成本

Step 7: 长期改进方案 - 错峰调度
   - PDF 批处理避开医保对账高峰：
     * CronJob schedule: "0 3 * * *"（推迟到 03:00）
     * 医保对账：02:00-03:00
     * PDF 批处理：03:00-05:00
   - 错峰后资源冲突降低 70%

Step 8: 监控告警改进
   - 医保结算延迟监控：P99 > 200ms 告警
   - 医保结算 CPU 使用率：> 80% 告警
   - PDF 批处理 Pod 状态：Failed 告警
   - 抢占事件：调度器抢占告警（记录 Victim Pod 信息）

Step 9: 复盘改进
   - 根因：资源隔离不彻底 + 优先级未生效 + 错峰未配置
   - 改进：PriorityClass 5 级体系（system/medical/middleware/core/ai/batch）
   - 改进：医保专用节点池 + HPA + Cluster Autoscaler
   - 改进：错峰调度 + 监控告警
   - 改进：定期演练抢占式调度（混沌工程）
   - 演练结果：再次模拟夜间对账高峰，医保结算 SLA 100% 达标
```

---

## 九、容量与性能设计

### 9.1 容量估算

```
集群规模：
- 30 worker × 24 核 / 96GB / 2TB = 720 核 / 1440GB / 60TB
- Node Allocatable：约 660 核 / 1380GB（系统预留 10%）

业务分配（Requests）：
┌──────────────────────────┬──────────────┬──────────────┬──────────────────┐
│ 业务                      │ CPU 总量      │ Memory 总量   │ 副本数            │
├──────────────────────────┼──────────────┼──────────────┼──────────────────┤
│ 体检预约 Web              │ 20 核         │ 40Gi         │ 10 副本 × 2核4G   │
│ 体检报告服务              │ 12 核         │ 24Gi         │ 6 副本 × 2核4G    │
│ 医保结算服务              │ 6 核          │ 12Gi         │ 3 副本 × 2核4G    │
│ AI 推理服务               │ 8 核 + 2 GPU │ 16Gi         │ 2 副本 × 4核8G    │
│ Redis Cluster            │ 24 核         │ 48Gi         │ 6 副本 × 4核8G    │
│ MySQL 主从               │ 16 核         │ 32Gi         │ 2 副本 × 8核16G   │
│ Filebeat DaemonSet       │ 6 核          │ 12Gi         │ 30 节点 × 0.2核0.4G│
│ NGINX Ingress            │ 12 核         │ 12Gi         │ 30 节点 × 0.4核0.4G│
│ PDF 批处理（峰值）        │ 10 核         │ 20Gi         │ 5 副本 × 2核4G    │
│ Prometheus + Grafana     │ 8 核          │ 16Gi         │ 多副本            │
│ 4 客户业务（合计）        │ 200 核        │ 400Gi        │ 200+ 副本         │
├──────────────────────────┼──────────────┼──────────────┼──────────────────┤
│ 合计                      │ 322 核        │ 632Gi        │ -                 │
└──────────────────────────┴──────────────┴──────────────┴──────────────────┘
- 利用率：322/660 ≈ 49%（合理区间 50%-70%）
- 留余量：35% 给 HPA 扩容 + 突发流量

数据规模：
- 体检 PDF 文件：日均 10w 份 × 3MB = 300GB/天，3 年累计 330TB
- 医疗影像 DICOM：单年 PB 级，3 年累计 3PB
- Redis 数据：6 节点 × 50GB = 300GB
- MySQL 数据：主从 × 500GB = 1TB
- 监控指标：Prometheus 30 天保留，约 500GB
- 日志：Loki 30 天保留，约 2TB

性能要求：
- 体检预约 P99 延迟 < 200ms
- 医保结算 P99 延迟 < 500ms
- AI 推理 P99 延迟 < 2s
- 集群内 Service 调用延迟 < 5ms
- 跨 AZ 调用延迟 < 20ms
```

### 9.2 性能设计

```
控制面性能：
- kube-apiserver：3 副本 + SLB，QPS 上限 400（--max-requests-inflight）
- etcd：5 节点 SSD，写入延迟 < 10ms
- kube-scheduler：单 Leader，调度延迟 < 100ms
- Priority and Fairness：保护 apiserver 不被单一客户端打挂

数据面性能：
- kube-proxy ipvs 模式：规则复杂度 O(1)
- Calico BGP 模式：无 Overlay 损耗
- ClusterIP 转发：iptables DNAT < 1ms
- CoreDNS 解析：< 5ms（cache 30s）

存储性能：
- Ceph RBD：IOPS 5000+，延迟 < 5ms
- CephFS RWX：IOPS 2000+，延迟 < 10ms
- MinIO 对象存储：吞吐 1GB/s+，延迟 < 50ms
- 跨 AZ 复制延迟：异步 < 1 秒

业务性能：
- 体检预约 Web：JVM 预热 + readiness 探针，避免冷启动
- 医保结算：HPA + 专用节点，保证 SLA
- AI 推理：GPU 独占 + 模型预加载
- PDF 批处理：parallelism=5，错峰调度

可观测性：
- Prometheus：15s 抓取间隔，30 天保留
- Loki：日志 30 天保留，自动归档
- Jaeger：链路追踪 7 天保留
- 告警：P99 延迟、CPU、内存、错误率
```

---

## 十、合规与安全设计

### 10.1 合规框架

```
医疗监管合规：
- 等保三级：网络隔离 + 访问控制 + 加密传输 + 加密存储
- 互联网诊疗监管细则：处方签章 + 复诊认定 + 数据上报
- 医保电子处方中心：处方流转 + 双轨对接
- 国家药监局药品追溯码：药品追溯上报
- 病历管理规定：病历保存 ≥ 30 年
- 数据安全法：分级分类 + 风险评估

K8s 合规落地：
- 医保结算物理隔离：专用节点 + 污点 + NetworkPolicy
- 数据加密：etcd KMS + Secret 加密 + PV 加密
- 访问审计：K8s Audit Log + 不可变审计日志
- RBAC：最小权限原则 + ServiceAccount 限定 Namespace
- 镜像安全：镜像签名 + 漏洞扫描 + 准入控制
- Pod Security Standards：restricted 级别
```

### 10.2 安全设计

```
数据安全：
- etcd KMS 加密：Secret 数据加密存储
- PV 加密：Ceph RBD 加密 + MinIO 服务端加密
- 传输加密：TLS 1.3 + 国密 SM2/SM4
- 密钥管理：KMS + HSM 硬件安全模块

网络安全：
- NetworkPolicy default-deny + 严格白名单
- Calico BGP 模式 + 节点级防火墙
- Ingress WAF + DDoS 防护
- Service Mesh mTLS（Istio）

应用安全：
- Pod Security Standards: restricted
  * 禁止 privileged 容器
  * 禁止 hostNetwork/hostPID
  * 必须 runAsNonRoot
  * readOnlyRootFilesystem
- 镜像安全：
  * 镜像签名（cosign）
  * 漏洞扫描（Trivy）
  * 准入控制（OPA Gatekeeper）
- RBAC：
  * 最小权限原则
  * ServiceAccount 限定 Namespace
  * 定期审计权限

合规审计：
- K8s Audit Log：所有 apiserver 请求审计
- 不可变审计日志：写入对象存储 + WORM 保护
- 三道防线：业务 + 合规 + 内审
- 季度审计 + 专项审计
- 第三方安全评估

应急响应：
- 7 阶段应急响应流程
- 72 小时监管上报 + 用户通知
- 复盘改进 + 知识沉淀
```

---

## 十一、与架构师水平的核心差距（综合）

通过 Day01-Day05 五天串联，识别本周综合型差距：

1. **跨支柱协同的工程闭环不足**：Day01 探针 + Day02 Workload + Day03 Service + Day04 存储 + Day05 调度五大支柱协同的工程闭环不足，特别是零宕机发布工程五件套联动的实战经验。

2. **跨 AZ 容灾的工程化深度不足**：Pod 反亲和 + topologySpreadConstraints + 跨 AZ PVC + Ceph RBD Mirror + Operator 自动切换的端到端容灾工程化深度不足，特别是故障切换时序和数据一致性保证。

3. **多租户隔离的工程化不足**：Namespace + ResourceQuota + LimitRange + NetworkPolicy + PriorityClass 四件套隔离的工程化不足，特别是"软隔离 vs 硬隔离"的权衡与选型。

4. **抢占式调度的实战经验不足**：PriorityClass 抢占机制在生产中的实战经验不足，特别是抢占时机选择、Victim 选择策略、抢占后业务自愈。

5. **CPU Throttling 与 OOMKilled 的根因排查不足**：JVM 容器化后 CPU Throttling 与 OOMKilled 的根因排查经验不足，特别是 CFS 周期边界问题、JVM 非堆内存估算、监控指标识别。

6. **可观测性三件套与 K8s 集成深度不足**：Prometheus + Loki + Jaeger 与 K8s 集成的工程深度不足，特别是 Service Mesh 链路追踪、指标关联分析、告警根因定位。

---

## 十二、明日预告

Day07 进行**架构深挖**，候选深挖点：

1. **K8s 调度器底层原理与 Scheduler Framework**：贯穿 Day05，深挖调度器 Filter/Score/Reserve/Permit/Bind 五阶段、Scheduler Framework 的 Plugin 机制、抢占式调度的 Victim 选择算法、调度器性能优化

2. **etcd Raft 一致性与 K8s 控制面 HA**：贯穿 Day01，深挖 etcd Raft 协议、quorum 与脑裂、etcd 性能调优、apiserver watch 机制、Leader 选举实现

3. **kube-proxy iptables vs ipvs 底层原理**：贯穿 Day03，深挖 iptables 规则链、ipvs 内核模块、conntrack 表、性能基准测试、故障排查

4. **Istio xDS 协议与服务网格控制面**：贯穿 Day03 + Day05，深挖 Envoy xDS 协议、Pilot/Istiod 控制面、Sidecar 注入、mTLS、流量治理

明日选其中一个深挖到底，训练架构师思维。
