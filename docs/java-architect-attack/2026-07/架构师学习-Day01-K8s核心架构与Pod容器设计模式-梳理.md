# 架构师学习 Day01 梳理：K8s 核心架构与 Pod 容器设计模式

> 架构师视角的提炼版｜适合复习与面试速记
>
> 周主题：K8s 与云原生专题

---

## 一、K8s 在云原生架构中的定位

### 1.1 核心一句话

> **K8s = 声明式 API + 控制器模式 + 不可变基础设施 + 服务网格底座**
>
> 与传统 PaaS 的根本差异：声明式（描述"想要什么"而非"做什么"）+ 控制器模式（watch + reconcile 闭环）+ 不可变基础设施（Pod 销毁重建而非原地升级）。

### 1.2 K8s 的四大特征

| 特征 | 含义 | 架构影响 |
| --- | --- | --- |
| 声明式 API | 用户描述期望状态（Deployment replicas=3），系统驱动实际状态收敛到期望 | 可重入、可版本化、可回滚；diff 即变更 |
| 控制器模式 | 每类资源对应一个控制器，watch + reconcile 闭环 | 解耦、可扩展；自定义 CRD + Operator |
| 不可变基础设施 | Pod 不原地修改，变更 = 重建 | 故障可重现、回滚 = 重新部署 |
| 服务网格底座 | Sidecar 模式下沉流量治理、可观测性、安全 | 业务无侵入；Service Mesh 标配 |

### 1.3 K8s 在云原生全景中的位置

```
┌──────────────────────────────────────────────────────────────────┐
│  应用层：微服务 / Serverless / Job                                │
└──────────────────────────────────────────────────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────────────────────────────────┐
│  治理层：Service Mesh (Istio/Linkerd) / API Gateway              │
└──────────────────────────────────────────────────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────────────────────────────────┐
│  编排层：Kubernetes (K8s)                                         │
│  - Workload 编排：Deployment / StatefulSet / DaemonSet / Job     │
│  - 网络：Service / Ingress / CNI / DNS                           │
│  - 存储：PV / PVC / StorageClass / CSI                           │
│  - 配置：ConfigMap / Secret                                      │
│  - 调度：Scheduler / 资源管理 / QoS / 优先级                      │
└──────────────────────────────────────────────────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────────────────────────────────┐
│  容器运行时：containerd / CRI-O / Docker                          │
└──────────────────────────────────────────────────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────────────────────────────────┐
│  基础设施：物理机 / 虚机 / 公有云 / 私有云                         │
└──────────────────────────────────────────────────────────────────┘
```

### 1.4 K8s 与往周专题的衔接

| 往周专题 | K8s 衔接点 |
| --- | --- |
| CAP/分布式事务 | K8s 控制面 = CP 系统（etcd Raft 强一致）；K8s 业务面 = AP 系统（Pod 多副本 + 反亲和） |
| 消息队列 | K8s 部署 Kafka/ RocketMQ 集群（StatefulSet + PV）；Operator 管理 MQ 生命周期 |
| 微服务 | K8s 原生提供"服务注册发现 (DNS) + 配置中心 (ConfigMap) + 网关 (Ingress) + 链路追踪 (Mesh)" |
| MySQL | K8s 部署 MySQL（Operator 模式，如 Vitess、Oracle MySQL Operator）；读写分离 + 分库分表不变 |
| Redis | K8s 部署 Redis Cluster（StatefulSet + PV），Redis Operator 管理集群 |
| Elasticsearch | K8s 部署 ES（ECK Operator），冷热分离 + 节点角色 |
| 限流降级 | Sentinel 可下沉到 Service Mesh Sidecar；K8s 原生 ingress-nginx 限流 |
| 支付 | K8s 多副本 + Pod 反亲和 + 多可用区部署，满足支付 SLA 与容灾 |
| 医疗 | K8s Namespace + NetworkPolicy + ResourceQuota 实现多医院隔离 |

---

## 二、K8s 核心组件拆分

### 2.1 控制面（Control Plane）

| 组件 | 职责 | 端口 | 状态 | 多副本方式 |
| --- | --- | --- | --- | --- |
| kube-apiserver | 唯一入口，认证/鉴权/准入/etcd 读写 | 6443 | 无状态 | 多副本 + LB |
| etcd | 强一致 KV 存储（Raft） | 2379/2380 | 有状态 | 奇数节点 Raft |
| kube-scheduler | Pod 调度（预选+优选） | 10259 | 无状态 | Leader 选举 |
| kube-controller-manager | 控制器集合（Deployment/ReplicaSet/Node/Endpoint/Job） | 10257 | 无状态 | Leader 选举 |
| cloud-controller-manager | 云厂商集成（路由/LB/节点） | 10258 | 无状态 | Leader 选举 |

### 2.2 节点组件（每个节点）

| 组件 | 职责 | 端口 |
| --- | --- | --- |
| kubelet | 节点 agent，按 PodSpec 拉起容器，做健康检查 | 10250 |
| kube-proxy | 维护 Service -> Pod 转发规则（iptables/ipvs） | 10256 |
| 容器运行时 | 跑容器（containerd/CRI-O） | CRI 接口 |
| CNI 插件 | Pod 网络（Calico/Flannel/Cilium） | - |

### 2.3 附加组件

| 组件 | 职责 |
| --- | --- |
| coredns | 集群内 DNS，Service 域名解析 |
| Ingress Controller | 七层流量入口（nginx-ingress/Traefik/APISIX） |
| Metrics Server | 资源指标采集（HPA 依赖） |
| Prometheus + Grafana | 监控指标 |
| Fluentd/Filebeat | 日志采集 |

---

## 三、kubectl apply 全链路

### 3.1 完整链路

```
1. kubectl apply
   ↓ (HTTPS + kubeconfig)
2. kube-apiserver
   a. Authentication（认证）
   b. Authorization（鉴权，RBAC）
   c. Admission（准入控制）
      - MutatingAdmissionWebhook（注入 Sidecar、默认 SA）
      - ValidatingAdmissionWebhook（OPA Gatekeeper 校验）
      - 内置：NamespaceLifecycle/ResourceQuota/LimitRanger/ServiceAccount
   d. 写入 etcd
   ↓ (gRPC + TLS)
3. etcd 持久化（Raft 多数派）
   ↓ (watch)
4. Deployment 控制器 watch 到，创建 ReplicaSet
   ↓ (watch)
5. ReplicaSet 控制器 watch 到，创建 Pod（nodeName 为空）
   ↓ (watch)
6. kube-scheduler watch 到，预选+优选，更新 nodeName
   ↓ (watch)
7. 目标节点 kubelet watch 到
   - 调用 CRI 创建 Pause 容器
   - 调用 CNI 分配 Pod IP
   - 拉镜像、创建业务容器
   - 调用 CSI 挂载存储
   - 启动探针
   ↓
8. Pod Running，kubelet 上报状态
   ↓ (watch)
9. Endpoint 控制器把 Pod IP 加入 Service Endpoints
   ↓ (watch)
10. kube-proxy 更新 iptables/ipvs 规则：ClusterIP -> Pod IP
   ↓
11. 业务可访问
```

### 3.2 为什么选 etcd 而不是 MySQL/Redis

| 维度 | etcd | MySQL | Redis |
| --- | --- | --- | --- |
| 一致性 | Raft 强一致 | 异步/半同步主从 | 异步主从 |
| watch 机制 | 原生 MVCC watch | 无原生（需轮询） | keyspace notification（不稳） |
| 多版本 | MVCC，支持历史查询 | 不支持 | 不支持 |
| 事务 | compare-and-swap（乐观锁） | 行锁（悲观） | 事务弱 |
| 性能 | 万级 QPS | 万级 QPS（但锁竞争） | 十万级 QPS（但弱一致） |
| 专用场景 | 配置存储 + 服务发现 + 分布式锁 | 通用关系型 | 缓存 + 简单 KV |

---

## 四、控制面高可用拓扑

### 4.1 两种拓扑对比

| 维度 | 堆叠式（Stacked etcd） | 外部 etcd（External etcd） |
| --- | --- | --- |
| 拓扑 | etcd 与控制面其他组件同机 | etcd 独立集群 |
| 节点数 | 3 master | 3 master + 3 etcd |
| 故障域 | master 宕机 = etcd 同时不可用 | 故障隔离 |
| 部署难度 | 简单（kubeadm 默认） | 复杂 |
| 性能 | etcd 与控制面争资源 | etcd 独占资源 |
| 适用 | 中小规模、测试 | 大规模生产 |

### 4.2 etcd 节点数为什么是奇数

- Raft 要求"多数派"同意才能写入
- 奇数节点：3 容忍 1 宕机，5 容忍 2 宕机，7 容忍 3 宕机
- 偶数节点：4 容忍 1 宕机（多数派=3），性价比不如 3 节点
- 公式：n 节点容忍 (n-1)/2 宕机

### 4.3 Leader 选举（基于 Lease）

```
1. 启动时各副本抢 Lease 资源（kube-system/lease-xxx）
2. 抢到者为 leader，开始工作
3. 其他副本 watch + 等待
4. Leader 每 5s 续约（renewTime）
5. Leader 宕机，15s（leaseDuration）后 Lease 失效
6. 其他副本竞争，新 leader 上线
```

切换时间：默认 5-15s。期间：
- 已运行 Pod 不受影响（kubelet/kube-proxy 独立）
- 新 Pod 创建、故障 Pod 重建、滚动更新受影响

### 4.4 API Server 性能调优

**关键参数**：
- `--max-requests-inflight=400`（只读并发上限）
- `--max-mutating-requests-inflight=200`（写并发上限）
- 大集群需调大（如 1000/500）

**Priority and Fairness（APF）**：
- 按 PriorityLevel（system/leader-elect/node-high/default/low）分级
- 按 FlowSchema（用户/SA/Namespace）路由
- 防止心跳风暴、慢 webhook、恶意租户拖垮 API Server

**经验值**：
- 单 API Server：5000-10000 QPS
- 3 master LB：15000-30000 QPS
- 5000 Pod 集群日常：1000-3000 QPS

---

## 五、Pod 模型与设计模式

### 5.1 为什么引入 Pod

**核心动机**：许多应用天然需要多容器紧密协作（业务 + Sidecar）。

**Pod 内共享的命名空间**：

| 命名空间 | 共享 |
| --- | --- |
| Network | 共享（localhost 互通） |
| IPC | 共享 |
| UTS | 共享（hostname） |
| PID | 默认不共享（可开启 shareProcessNamespace） |
| Mount | 不共享（但可挂载同 Volume） |
| User | 不共享 |

### 5.2 Pause 容器作用

- 持有 Pod 的 network namespace
- 持有 Pod 的 IPC namespace
- 调用 `pause()` 系统调用，作为 PID 1 回收僵尸进程
- 极简（C 写、几十行代码）、永不崩溃
- 业务容器通过 `--net=container:pause` 共享 Pause 的网络栈

### 5.3 多容器设计模式

```
Sidecar 模式：主容器 + 辅助容器（同生命周期）
  典型：Istio Envoy / Filebeat / Prometheus Exporter

Ambassador 模式：主容器 + 代理容器（屏蔽外部依赖）
  典型：代理多数据库/多 Redis

Adapter 模式：主容器 + 转换容器（标准化输出）
  典型：JMX Exporter 转 Prometheus 格式
```

### 5.4 Istio Sidecar 注入机制

通过 **MutatingAdmissionWebhook** 实现：

1. Pod 创建请求到达 API Server
2. 准入控制阶段触发 Istio Sidecar Injector Webhook
3. Webhook 修改 PodSpec：添加 Envoy 容器、Init Container（配 iptables）、Volumes
4. 修改后的 PodSpec 写入 etcd
5. Kubelet 按修改后的 PodSpec 拉起 Pod

### 5.5 Init Container vs Sidecar

| 维度 | Init Container | Sidecar |
| --- | --- | --- |
| 执行时机 | Pod 启动一次性 | 与主容器同时跑 |
| 生命周期 | 短暂 | 与主容器同 |
| 失败影响 | Pod 启动失败 | 主容器仍可跑 |
| 典型用途 | 初始化、等待依赖 | 持续辅助 |

K8s 1.28+ 引入 `sidecarContainers`（Init Container + restartPolicy: Always），让 Sidecar 真正先启动。

---

## 六、Pod 生命周期与探针

### 6.1 Pod Phase

| Phase | 说明 |
| --- | --- |
| Pending | 已接受，容器未全部启动 |
| Running | 所有容器已创建，至少一个运行 |
| Succeeded | 所有容器成功退出（Job） |
| Failed | 所有容器退出，至少一个失败 |
| Unknown | API Server 与 kubelet 通信失败 |

### 6.2 重启策略

| 策略 | 说明 | 适用 |
| --- | --- | --- |
| Always | 总是重启 | Deployment/StatefulSet/DaemonSet（默认） |
| OnFailure | 失败才重启 | Job |
| Never | 不重启 | 一次性任务 |

### 6.3 三个探针

| 探针 | 作用 | 失败后果 |
| --- | --- | --- |
| livenessProbe | 容器是否"活着" | 重启容器 |
| readinessProbe | 容器是否"准备好接流量" | 从 Endpoints 摘除 |
| startupProbe | 容器是否"启动完成" | 重启容器；启动期接管 liveness |

### 6.4 探针配置陷阱

1. **livenessProbe 探测业务依赖**：DB 挂 -> Pod 重启 -> 重启后 DB 还挂 -> CrashLoopBackOff
   - 正确：liveness 只探进程存活
2. **readinessProbe 太严**：Endpoints 频繁摘除，流量抖动
3. **startupProbe 没设**：Java 启动 60s，liveness 30s 后开始探，永远起不来
4. **探针超时太短**：GC 导致接口慢 1s，timeout=1s 频繁失败
5. **liveness 与 readiness 用同一接口**：失去差异化

### 6.5 Spring Boot 推荐配置

```yaml
livenessProbe:
  httpGet:
    path: /actuator/health/liveness   # 只检查进程
    port: 8080
  periodSeconds: 10
  failureThreshold: 3
  timeoutSeconds: 1

readinessProbe:
  httpGet:
    path: /actuator/health/readiness  # 检查 DB/Redis/MQ
    port: 8080
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

---

## 七、三容器 Pod 综合设计

### 7.1 Pod 结构

```
Pod (Pause 持有 network namespace)
├── Init Container (拉配置 -> emptyDir)
├── Main Container (Spring Boot 8080, 读 emptyDir)
└── Sidecar (Filebeat, 读 log-emptyDir -> Kafka)
```

### 7.2 启动顺序

1. Pause 启动
2. Init Container 拉配置 -> 写 emptyDir -> exit 0
3. Main + Sidecar 并行启动
4. Main 读 emptyDir 启动 Spring Boot
5. Filebeat 监听 log-emptyDir
6. readinessProbe 通过 -> 加入 Endpoints

### 7.3 故障矩阵

| 故障 | 处理 |
| --- | --- |
| Sidecar OOM | Sidecar 重启；Main 不受影响；Mesh Sidecar 例外（网络中断） |
| Main CrashLoopBackOff | Main 反复重启；Sidecar 仍跑；摘流量 |
| Init Container 失败 | Pod 阻塞 Init 阶段；Main/Sidecar 不启动 |
| Pause 挂 | Pod 网络断；kubelet 重建 Pod |
| 节点宕机 | Pod 重新调度，全部重建 |

---

## 八、架构师面试高频问题速记

### 8.1 K8s 核心架构

- **K8s 由哪些组件组成？**：控制面（API Server/etcd/Scheduler/Controller Manager/Cloud Controller Manager）+ 节点组件（kubelet/kube-proxy/容器运行时/CNI）+ 附加（coredns/Ingress/Metrics Server）
- **kubectl apply 全链路？**：kubectl -> API Server (AuthN/AuthZ/Admission) -> etcd -> Deployment 控制器 -> ReplicaSet -> Pod -> Scheduler -> kubelet -> CRI/CNI/CSI -> Endpoints -> kube-proxy -> 业务可访问
- **为什么选 etcd？**：Raft 强一致 + 原生 watch + MVCC 多版本 + compare-and-swap 乐观锁
- **etcd 节点数为什么奇数？**：Raft 多数派要求，偶数不增加容错能力，浪费机器

### 8.2 控制面高可用

- **堆叠 vs 外部 etcd？**：堆叠简单但故障耦合，外部隔离但运维复杂；大规模生产选外部
- **Leader 选举怎么实现？**：基于 Lease 资源（kube-system/lease-xxx），holderIdentity + leaseDuration + renewTime
- **API Server 性能瓶颈？**：etcd I/O / API Server CPU / 准入 webhook / List 请求；调优 max-requests-inflight + APF
- **APF 解决什么问题？**：按 PriorityLevel 分级 + FlowSchema 路由，防止心跳风暴、慢 webhook、恶意租户拖垮 API Server

### 8.3 Pod 模型

- **为什么引入 Pod？**：多容器紧密协作需要共享网络/IPC/UTS，独立调度难以保证
- **Pause 容器作用？**：持有 network/IPC namespace + PID 1 回收僵尸进程
- **Pod 内共享什么？**：Network/IPC/UTS 共享，Mount/User 不共享，PID 默认不共享
- **Sidecar 模式应用？**：Istio Envoy / Filebeat / Prometheus Exporter / Vault Agent
- **Sidecar 怎么注入？**：MutatingAdmissionWebhook，Istio Injector 在 Pod 创建时改 PodSpec
- **Init vs Sidecar 区别？**：Init 一次性顺序执行，Sidecar 长期并行；K8s 1.28+ 用 restartPolicy: Always 的 Init Container 实现 Sidecar

### 8.4 探针与生命周期

- **三个探针区别？**：liveness（重启容器）/ readiness（摘流量）/ startup（启动期接管 liveness）
- **liveness 不能探什么？**：业务依赖（DB/Redis），否则 DB 挂 -> CrashLoopBackOff
- **readiness 探什么？**：业务依赖，DB 挂 -> 摘流量但不重启
- **startup 何时用？**：慢启动应用（Java JVM 预热 60s+）
- **CrashLoopBackOff 原因？**：应用启动失败 / 探针配置错误 / 资源不足 / 镜像问题 / 配置错误

### 8.5 故障排查

| 现象 | 可能原因 | 诊断命令 |
| --- | --- | --- |
| Pending | 资源不足/调度失败/镜像拉取失败 | kubectl describe pod / kubectl get events |
| CrashLoopBackOff | 应用启动失败/探针错/资源不足 | kubectl logs --previous / kubectl describe |
| OOMKilled | 内存限制太低/内存泄露 | kubectl describe + 监控内存曲线 |
| ImagePullBackOff | 镜像不存在/认证失败 | kubectl describe / 检查 imagePullSecrets |
| Init:Error | Init Container 失败 | kubectl logs &lt;pod> -c &lt;init-container> |
| Evicted | 节点资源压力（磁盘/内存） | kubectl describe node + kubelet 日志 |

---

## 九、Day01 核心架构师命题

**Day01 的核心架构师命题**：理解 K8s 的"控制面 + 数据面 + 节点组件"三层架构，掌握 K8s 的"声明式 + 控制器 + 不可变基础设施"三大范式，能把 K8s 当成"业务面 + 控制面 + 数据面"分层架构来设计。

**与往周专题的呼应**：
- K8s 控制面 = CP 系统（etcd Raft），呼应 CAP 专题
- K8s 控制器模式 = watch + reconcile，呼应微服务专题的配置中心（Nacos watch）
- K8s Sidecar 模式 = 治理能力下沉，呼应限流降级专题的"基础设施下沉"
- K8s 多副本 + 反亲和 = 容灾基础，呼应支付专题的多可用区部署
- K8s Namespace + NetworkPolicy = 多租户隔离，呼应医疗专题的多医院隔离

**Day02 预告**：Workload 编排与发布工程 -- Deployment / StatefulSet / DaemonSet / Job / CronJob 五种工作负载，以及滚动更新 / 蓝绿发布 / 金丝雀发布三种发布策略在 K8s 中的工程落地。

---