# Day 7：架构深挖 - K8s 声明式调谐循环与 Informer 底层原理

> 日期：2026年07月26日（周日）
> 周主题：K8s 与云原生专题
> 深挖日：Day07 - 控制面调谐循环（Reconcile Loop / Informer / Workqueue）底层原理

---

## 一、今日主题

本周 Day01-Day06 完成了 K8s 从底层架构到调度治理的完整闭环：

```text
Day01：K8s 核心架构与 Pod 容器设计模式
        - kube-apiserver / etcd / kube-controller-manager / kube-scheduler / kubelet
        - Pause 容器、Sidecar/Ambassador/Adapter 模式、Init Container、探针

Day02：Workload 编排与发布工程
        - Deployment / StatefulSet / DaemonSet / Job / CronJob 五件套
        - 滚动 / 蓝绿 / 金丝雀、PDB、HPA、revisionHistoryLimit、优雅停机

Day03：Service 与网络模型
        - ClusterIP 虚拟 IP、iptables / ipvs、EndpointSlice、Ingress、CoreDNS
        - CNI Overlay vs BGP、NetworkPolicy、Service Mesh 衔接

Day04：存储卷与配置管理
        - Volume / PV / PVC / StorageClass / CSI 三组件
        - ConfigMap 热更新、Secret KMS、StatefulSet volumeClaimTemplates

Day05：调度与资源管理
        - 调度器 Filter/Score/Reserve/Permit/Bind 五阶段
        - 亲和性 / 污点容忍 / topologySpreadConstraints / PriorityClass 抢占
        - Requests/Limits、QoS 三等级、CPU Throttling、OOMKilled
        - LimitRange / ResourceQuota / Node Allocatable / 多租户隔离

Day06：串联整合 - 云原生智慧医疗平台 K8s 全链路架构设计
        - 把 Day01-Day05 五大支柱串成工程闭环
```

但到这里我们发现一个一直被刻意回避的命题：**Pod 创建请求提交到 API Server 之后，是谁把 Deployment 滚动到期望副本数？是谁给 Pod 分配 IP 并写入 Endpoints？是谁把 PV 绑定到 PVC？是谁在节点宕机时把 Pod 重新调度到其他节点？是谁在 ResourceQuota 超额时拒绝新 Pod 创建？**

```text
kube-apiserver 是"前端柜台"，只负责"读 / 写" etcd，不做任何业务逻辑
etcd 是"仓库"，只负责"存数据"，不知道字段含义
kube-scheduler 是"调度员"，只负责"决定 Pod 去哪个节点"，不负责"实际启动"
kubelet 是"现场工人"，只负责"在自己节点上启动 Pod"，不负责"集群状态"
kube-proxy 是"路由表维护员"，只负责"维护本机 iptables/ipvs 规则"

那"集群最终状态收敛到期望状态"这件事是谁在推动？
答案：kube-controller-manager（KCM）里几十个 Controller，外加 K8s 内置的其他 Controller（如 cloud-controller-manager、Endpoint Controller、Podgc Controller、ResourceQuota Controller 等）
```

K8s 设计哲学的核心命题是：

```text
声明式 API（Declarative API）：
  用户写"我期望集群有 3 个 Nginx Pod"（Desired State）
  而不是"帮我启动第 1 个 / 第 2 个 / 第 3 个 Nginx Pod"（Imperative Command）

最终一致性（Eventual Consistency）：
  集群当前状态（Current State）可能暂时不等于期望状态
  但系统会持续收敛，直到 Current State == Desired State

调谐循环（Reconcile Loop）：
  Controller 不断观察 Current State，与 Desired State 比对
  发现差异就发"调和动作"（创建 / 删除 / 更新），循环往复

List-Watch 机制：
  Controller 通过 List（一次性全量）+ Watch（增量推送）保持本地缓存与 etcd 一致
  避免每次调谐都查 API Server

Workqueue 异步处理：
  事件被分发到 Workqueue，Controller Worker 异步消费
  避免单个事件处理慢阻塞整个系统
```

这五个机制合起来，就是 K8s 控制面的"心脏"：

```text
声明式 API（YAML）
       ↓ 写入 etcd
Watch 事件（List-Watch 推送）
       ↓
Informer 分发（Delta FIFO → Indexer 缓存 → 事件回调）
       ↓
Workqueue 入队（key = namespace/name）
       ↓
Reconcile Loop（Worker 取出 key，调谐）
       ↓
Current State 收敛到 Desired State
```

任何一个 Controller（无论是 K8s 内置的还是自研 Operator）都遵循这个范式。Day01-Day05 涉及的所有"自动化行为"都基于这个机制：

```text
Deployment Controller       - 把副本数收敛到 spec.replicas，处理滚动发布
StatefulSet Controller       - 有序创建 / 删除 Pod，处理 volumeClaimTemplates
DaemonSet Controller         - 给每个 Node 创建一份 Pod
Job Controller                - 等待所有 Pod 完成，处理失败重试
EndpointSlice Controller      - 监听 Service + Pod，写入 Endpoints
Service Controller            - 处理 LoadBalancer 类型 Service 的云厂商 LB 生命周期
Node Controller              - 监听 Node 心跳，标记 NotReady，驱逐 Pod
PV Controller                 - 绑定 PVC 与 PV
AttachDetach Controller       - 调用 CSI 把卷挂载到节点
ResourceQuota Controller      - 统计资源用量，拒绝超额创建
PodDisruptionBudget Controller - 保护 Pod 不被过量驱逐
HorizontalPodAutoscaler Controller - 监控指标，调整 Deployment replicas
Endpoint Controller           - 维护 Service -> Pod 的映射
cloud-controller-manager      - 路由 / LB / 节点生命周期与云厂商集成
```

Day07 不再讲"哪个 Controller 干什么"，而是深挖一个贯穿 Day01-Day05 所有 Controller 的底层命题：

```text
声明式 API 的"最终一致性"如何在工程上落地？
List-Watch 协议在 etcd 层、API Server 层、Controller 层各自做了什么？
Informer 的 Delta FIFO 与 Indexer 本地缓存如何工作？
Workqueue 的去重、延迟、限速、退避算法如何设计？
Reconcile Loop 为什么是"水平触发"而不是"边沿触发"？
resourceVersion 与乐观锁如何避免"写覆盖"？
为什么生产 Controller 必须做"幂等 + 退避 + 限流"，缺一就会雪崩？
自研 Operator 的 Controller 框架（client-go / controller-runtime / Kubebuilder）该怎么选？
```

这道题考察的不是"会不会写 Deployment YAML"，而是你能不能把背后的：

```text
API 范式（声明式 / 命令式 / 终态驱动）
事件分发（List 全量 + Watch 增量 + resourceVersion 续传）
本地缓存（Indexer + ThreadSafeStore）
异步处理（Workqueue + AddAfter + AddRateLimited）
可靠性边界（requeue 风暴 / watch 中断 / List 慢 / Controller 重启）
工程选型（client-go vs controller-runtime vs Kubebuilder）
```

讲清楚。结合用户业务背景：啄木鸟云健康的智慧体检/公卫平台跑在 K8s 上，每一个 K8s 资源（Deployment/StatefulSet/Pod/Service/Ingress/PVC/ConfigMap）背后都有对应的 Controller 在调谐。理解调谐循环机制，是 Day01-Day05 五大支柱（架构 / 编排 / 网络 / 存储 / 调度）的"工程闭环"。

---

## 二、题目：K8s 声明式调谐循环与 Informer 底层原理深挖

你作为啄木鸟云健康的架构师，把智慧体检/公卫平台搬到 K8s 集群（3 master + 30 worker，3 AZ × 10 节点，承接 4 家医共体 SaaS 客户）。某日凌晨发布，平台出现五个现象：

```text
现象1：发布一个 Deployment（replicas: 10），kubectl get deploy 显示 10/10 Ready，
       但 kubectl get endpoints 显示 Endpoints 只有 7 个 Pod IP，
       持续 8 分钟后才变成 10 个。
       期间部分流量打到没有 Ready Pod 的实例，返回 502。
       日志显示 kube-controller-manager 在 02:03:14 重启过一次。

现象2：医生反馈，医保结算服务偶尔会出现"Pod 反复重启"问题。
       describe Pod 显示：
       - 02:11:30 创建
       - 02:11:35 Ready
       - 02:12:10 收到 SIGTERM，开始优雅停机
       - 02:12:40 重新创建新 Pod
       每隔 1-2 分钟重复一次。集群事件显示：
       "Node controller: Node az1-worker-03 status Unknown,
        pod will be forcibly deleted after 40s"

现象3：体检报告 PDF 批处理 CronJob 凌晨 2 点启动 100 个 Job，每个 Job 处理 1000 份报告，
       但实际只有 30 个 Job 完成成功，70 个 Job 卡在 ContainerCreating 状态。
       kube-controller-manager 日志：
       "workqueue [batchv1.Jobs] depth: 70, rate limited: true,
        wait time: 12m30s"

现象4：升级 ResourceQuota 后，发现 quota usage 与实际不符：
       kubectl describe resourcequota 显示 used: cpu 80, memory 200Gi
       但实际 kubectl get pods --all-namespaces 统计 used: cpu 65, memory 180Gi
       部分客户被错误拒绝创建 Pod（"exceeded quota"）

现象5：自研的"医疗影像 AI 推理 Operator"在生产环境上线后，
       发现 Reconcile Loop 反复触发：
       每 5 秒一次 Reconcile，每次都创建一个新的 ConfigMap，
       但 ConfigMap 实际状态没变。
       日志：worker 1: reconciling GPUInference/gpu-inference-001
            worker 1: creating ConfigMap gpu-inference-001-config
            worker 1: reconciling GPUInference/gpu-inference-001
            worker 1: creating ConfigMap gpu-inference-001-config
            （无限循环）

现在要求你：

```text
从 K8s 声明式 API 范式、List-Watch 协议、Informer / Workqueue / Reconcile Loop
底层原理出发，解释清楚上述五个现象的根因，并给出架构师视角的"五防闭环"设计与替代方案。
```

---

## 三、需要回答的问题

```text
1. 声明式 API 与命令式 API 的本质差异？
   - K8s 为什么选"声明式 + 最终一致性"而不是"命令式 + 同步执行"？
   - 调谐循环（Reconcile Loop）的"水平触发"vs"边沿触发"差异？
   - 为什么"水平触发"在生产中更稳健（网络抖动 / Controller 重启 / 事件丢失）？
   - 声明式 API 的"幂等性"要求如何影响 Controller 设计？
   - 声明式 API 与"不可变基础设施（Immutable Infrastructure）"的关系？

2. List-Watch 协议在 etcd / API Server / Controller 三层各自做什么？
   - etcd 的 Watch 协议底层（Watch API、revision、compaction）
   - API Server 对 Watch 的代理（缓存层 cacher + watch cache）
   - Controller 的 Reflector 实现（List 全量 + Watch 增量 + re-list 重试）
   - 为什么必须 List + Watch 而不是只用 Watch？（首次启动 / watch 中断 / revision 过期）
   - resourceVersion 的语义（"资源版本号"vs"对象版本号"）
   - 为什么 List 默认不带 resourceVersion=0（从 cache 读）会引发"读旧值"？

3. Informer / Reflector / Delta FIFO / Indexer 四大组件如何协作？
   - Reflector：List-Watch 的执行者，把事件写入 Delta FIFO
   - Delta FIFO：去重 + 先进先出的"事件队列"
   - Informer：从 Delta FIFO 取事件，分发给 Handler + 同步 Indexer
   - Indexer：本地缓存（ThreadSafeStore），支持索引查询
   - SharedInformer：同一个 GVR 多个 Handler 共享一个 Informer，避免重复 List-Watch
   - 为什么"SharedInformer"在生产 Controller 中是必须的？

4. Workqueue 的"去重 / 延迟 / 限速 / 退避"四件套如何设计？
   - Add / Get / Done 三个核心 API
   - AddAfter：延迟入队（用于退避）
   - AddRateLimited：限速入队（用于失败退避）
   - Forget / NumRequeues：退避状态管理
   - 默认限速器（BucketRateLimiter + ItemExponentialFailureRateLimiter）
   - 为什么 Workqueue 必须是"持久"的（key 不丢），而 Delta FIFO 可以丢？

5. Reconcile Loop 的核心模式是什么？
   - Reconcile(pattern: 取出 key → 读取 Desired State → 读取 Current State → 比对 → 调和动作 → 返回）
   - "无状态"调谐：Reconcile 不依赖上下文，每次都重新读取
   - "幂等"调谐：同一个 key 多次 Reconcile 结果一致
   - "乐观锁"调谐：基于 resourceVersion 的 CAS（Compare-And-Swap）
   - "失败 requeue"：失败后通过 AddRateLimited 重新入队，指数退避
   - 为什么 Reconcile 必须返回 error 才算失败（返回 nil 算成功，即使啥也没做）？

6. resourceVersion 与乐观锁的底层原理？
   - resourceVersion 是 etcd 的 revision（全局递增整数）
   - 为什么不用对象本身的 hash 或时间戳？（全局单调递增才能比较"新旧"）
   - 乐观锁的 CAS 模式（PUT if resourceVersion == X）
   - "写覆盖"问题：A 读 rv=100 → B 读 rv=100 → A 写 rv=101 → B 写？(409 Conflict)
   - 为什么 Controller 必须处理 409 Conflict（re-list + retry）
   - resourceVersion 在 Watch 中的"续传"语义（从某个 rv 继续监听）

7. Controller 重启后的"状态恢复"如何保证？
   - Controller 重启后，本地 Indexer 缓存丢失
   - 重新 List 全量 → 重建缓存（启动期 List 慢的根因）
   - List 期间发生的事件会丢失吗？（不会，Watch 会从 rv=0 开始重新订阅，配合 List 后的"最新 rv"）
   - "List + Watch 同时进行"vs"List 完成后再 Watch"两种实现的差异
   - Controller 启动期"窗口期"业务影响（现象1的根因）

8. 自研 Operator 的 Controller 框架选型与陷阱？
   - client-go（最底层，需要自己组装 Informer + Workqueue）
   - controller-runtime（封装 Informer + Workqueue + Reconcile 接口）
   - Kubebuilder / Operator SDK（脚手架，生成 CRD + Controller + Webhook）
   - 自研 Controller 的常见陷阱：
     * Reconcile 不幂等（依赖外部状态）
     * Reconcile 不返回 error（吞掉错误导致不 requeue）
     * 创建子资源不带 OwnerReference（GC 不工作）
     * Workqueue worker 数过多（API Server 限流）
     * Watch 不带 FieldSelector（List 全量资源）
   - 现象5（无限循环）的根因：Reconcile 创建 ConfigMap 后没等 Cache 同步就读 Cache
```

---

## 四、问题逐题深挖

### 问题1：声明式 API 与命令式 API 的本质差异

#### 1.1 命令式 API 的范式

命令式 API 的核心是"动词 + 宾语"：

```text
用户："帮我启动第 1 个 Nginx Pod"
系统：创建 Pod nginx-1，返回 OK
用户："帮我启动第 2 个 Nginx Pod"
系统：创建 Pod nginx-2，返回 OK
用户："帮我启动第 3 个 Nginx Pod"
系统：创建 Pod nginx-3，返回 OK

如果用户重启 / 系统重启 / 网络抖动：
- 已经创建的 3 个 Pod 是否还需要创建？不知道
- 是否要查询当前状态再决定下一步？需要
- 如果第 2 步失败怎么办？需要回滚第 1 步
```

典型代表：Ansible、Shell 脚本、SSH 手动运维。

#### 1.2 声明式 API 的范式

声明式 API 的核心是"主语 + 表语"：

```text
用户："我期望集群有 3 个 Nginx Pod"（写入 Deployment YAML 到 etcd）
系统：观察 Current State（0 个 Pod）
       与 Desired State（3 个 Pod）比对，发现差异
       发出调和动作：创建 Pod nginx-1, nginx-2, nginx-3
       持续观察，直到 Current State == Desired State

如果用户重启 / 系统重启 / 网络抖动：
- 系统重启后，重新读取 Desired State（3 个 Pod）
- 重新观察 Current State（可能还是 0 个，也可能有部分）
- 持续收敛，无需用户干预
```

典型代表：K8s、Terraform、Prometheus Operator。

#### 1.3 "水平触发"vs"边沿触发"

这是声明式 API 与命令式 API 最深刻的工程差异，源自电子电路的两个术语：

```text
边沿触发（Edge-Triggered）：
  - 在"状态变化的瞬间"触发一次动作
  - 例如：Pod 从 Pending 变成 Ready 的瞬间触发一次 Reconcile
  - 问题：如果触发瞬间网络抖动，事件丢失，状态永远无法收敛

水平触发（Level-Triggered）：
  - 在"状态不一致的整个时间段"持续触发动作
  - 例如：Desired State = 3 个 Pod，Current State = 0 个 Pod，整个时间段持续触发 Reconcile
  - 优点：即使某次事件丢失，下次 Reconcile 仍会发现差异并修正
```

K8s Controller 是"水平触发 + 边沿触发"混合模式：

```text
边沿触发：Watch 事件（Pod Added / Modified / Deleted）触发 Reconcile
水平触发：周期性 Re-list（默认 10 小时一次）或 Resync（默认 30 分钟一次）触发 Reconcile

Resync 机制：
  - 即使没有事件，Informer 也会周期性把 Indexer 缓存中的所有 key 重新入队
  - 触发 Reconcile，发现"实际状态没变"就直接返回
  - 防止"某个事件丢失导致状态永远不一致"
```

#### 1.4 声明式 API 的"幂等性"要求

声明式 API 要求 Controller 必须**幂等**：

```text
同一个 key 多次 Reconcile，结果一致
即使 Reconcile 中途失败，下次重新执行不会产生副作用

反例（不幂等的 Controller）：
  Reconcile(key):
    cm = createConfigMap()  // 每次都创建新的！
    updateOwnerReference(cm)

  问题：每次 Reconcile 都创建新 ConfigMap，老 ConfigMap 没删，导致 ConfigMap 泛滥

正例（幂等的 Controller）：
  Reconcile(key):
    cm = getCM(name)
    if cm not exist:
      cm = createConfigMap()
    updateOwnerReference(cm)

  每次 Reconcile 先查，没有才创建，有就更新，结果幂等
```

这是现象5（医疗影像 AI 推理 Operator 无限循环）的根因之一：Reconcile 不幂等。

#### 1.5 与"不可变基础设施"的关系

声明式 API 是"不可变基础设施（Immutable Infrastructure）"的工程支撑：

```text
不可变基础设施原则：
  - 部署一个新版本 = 创建新 Pod，不是修改老 Pod
  - 回滚 = 创建老版本 Pod，不是修改新 Pod
  - 配置变更 = 创建新 ConfigMap + 重启 Pod，不是修改老 ConfigMap

声明式 API 实现：
  - Deployment 滚动发布：新 ReplicaSet 创建新 Pod，旧 ReplicaSet 删除旧 Pod
  - ConfigMap 不可变（immutable: true）：变更 = 创建新 ConfigMap
  - Pod 不可变：修改 Pod = 删除 + 重建，不是 in-place 修改

工程价值：
  - 状态可追溯（git history）
  - 回滚即 Git revert
  - 无"隐藏状态"（无 SSH 手动修改）
```

#### 1.6 架构师视角

```text
命令式 API 的代价：
  - 重启 / 网络抖动后状态不可恢复
  - 并发执行需复杂锁
  - 回滚需手工"逆操作"
  - 状态发散（隐藏状态）

声明式 API 的价值：
  - 重启 / 网络抖动后自动收敛
  - 并发执行靠乐观锁
  - 回滚 = 把 Desired State 改回老版本
  - 状态收敛（etcd 是唯一真相源）
```

K8s 选择声明式 API 的核心动机：**为分布式系统的"故障恢复"和"自动伸缩"提供工程基础**。在分布式系统中，机器会宕机、网络会抖动、进程会重启，命令式 API 在每次故障后都需要人工干预恢复；声明式 API 让系统在每次故障后自动收敛回期望状态。

### 问题2：List-Watch 协议在 etcd / API Server / Controller 三层各自做什么

#### 2.1 etcd 层：Watch API 与 revision

etcd 是 K8s 的"唯一真相源"。所有 K8s 资源（Pod、Service、ConfigMap 等）都存储在 etcd 中。

```text
etcd v3 是个 MVCC（Multi-Version Concurrency Control）KV 存储：
  - 每次写操作都会产生一个全局递增的 revision（全局整数版本号）
  - 每个 key 在每个 revision 都有一个版本
  - 历史版本默认保留 5000 个（可配置），用于 Watch 续传

etcd Watch API：
  - 客户端订阅"从 revision X 开始的所有变更"
  - 服务端推送：每发生一次写操作，把 (revision, event) 推给所有订阅者
  - 客户端可指定"从最新 revision 开始"或"从历史 revision 开始"

revision 的语义：
  - 全局递增（不是每个 key 一个 revision）
  - 单调（不会回退）
  - 持久化（重启后继续递增，从 last revision + 1 开始）

K8s 把 etcd 的 revision 暴露为 resourceVersion：
  - 每个 K8s 对象都有 resourceVersion 字段
  - 值就是 etcd 在该对象上次被写时的 revision
  - 用于乐观锁（CAS）和 Watch 续传
```

#### 2.2 etcd 的 compaction 与历史版本回收

```text
etcd 默认保留 5000 个历史 revision：
  - 客户端可以 Watch 任何 rv 在 [current_rev - 5000, current_rev] 范围的事件
  - 超出这个范围的 Watch 请求会返回 "required revision has been compacted"

K8s 的 compaction 机制：
  - kube-apiserver 每 5 分钟（默认）调用一次 etcd compaction
  - compaction 删除比当前 rv 早 N 分钟的历史版本
  - 防止 etcd 历史版本无限增长

Watch 中断的根因：
  - Controller 的 Watch 慢，落后超过 5000 个 revision
  - 需要重新 List（从最新 rv 开始重新 Watch）
  - 这就是 Reflector 的 "List + Watch + Re-List" 重试机制
```

#### 2.3 API Server 层：cacher 与 watch cache

API Server 不是简单代理 etcd 的 Watch，而是有自己的缓存层：

```text
kube-apiserver 内部结构：
  - ETF (etcd filter)：直接读写 etcd
  - cacher：缓存层，每个 GVR 一份 watch cache
  - watch cache 大小默认 100（可配置，高负载集群建议调到 1000+）

cacher 的工作：
  - 启动时一次性 List etcd 全量，写入 watch cache
  - 持续 Watch etcd，把事件追加到 watch cache
  - 客户端 Watch API Server 时，从 watch cache 读，不直接查 etcd
  - watch cache 是个环形缓冲（ring buffer）

为什么 API Server 要加 cacher：
  - 防止 Controller 多次 Watch 同一个 GVR 给 etcd 造成压力
  - 多个 Controller Watch 同一个 GVR，etcd 只 Watch 一次
  - "SharedInformer"在 API Server 端的等价物

cacher 的代价：
  - 客户端 Watch 到的事件可能比 etcd 实际写入晚几毫秒
  - 大集群（10w+ Pod）启动期 List 会很慢（即使从 cacher 读，数据量大）
```

#### 2.4 Controller 层：Reflector 的 List-Watch 实现

Reflector 是 client-go 提供的"List-Watch 执行者"，每个 Informer 内部有一个 Reflector。

```text
Reflector 的核心循环：

  1. List 阶段（启动时）
     - 调用 API Server 的 List 接口，获取全量对象
     - List 请求带 resourceVersion=0，从 cacher 读
       （如果带具体 rv，会从 etcd 读，慢且容易超时）
     - List 完成后，记录"最新 rv"（list 中对象的最大 rv）

  2. Watch 阶段
     - 用最新 rv 调用 API Server 的 Watch 接口
     - Watch 是 HTTP/2 长连接，server-sent events
     - 持续接收事件，每个事件带 (type, obj)
       type: BOOKMARK / ADDED / MODIFIED / DELETED
     - 每收到一个事件，更新最新 rv

  3. Re-List 阶段（异常恢复）
     - 触发条件：
       * Watch 连接断开
       * 收到 "Gone" 错误（rv 已被 compacted）
       * 收到 "Timeout" 或 "Too large resource version" 错误
     - 处理：从最新 rv 重新 List + Watch
     - 退避：1s → 2s → 4s → 8s → 10s（上限），防止雪崩

  4. resync 阶段（周期性）
     - 默认 10 小时（client-go 默认 30 分钟，但 K8s 内置 Controller 调到 10h）
     - 把 Indexer 缓存中的所有 key 重新入队
     - 触发 Reconcile，发现"状态没变"就直接返回
     - 防止"某个事件丢失导致状态永远不一致"
```

#### 2.5 为什么必须 List + Watch 而不是只用 Watch

```text
如果只用 Watch，会有什么问题：

  问题1：首次启动
    - Controller 启动时，etcd 中已经有 10w 个 Pod
    - Watch 只推送"未来的变更"，不会推送"已存在的对象"
    - Controller 永远不知道集群里已经有什么

  问题2：Watch 中断
    - 网络抖动 / API Server 重启 / rv 过期，Watch 断开
    - 重新 Watch 时，需要指定 rv
    - 如果指定老 rv，可能已 compacted，报错"Gone"
    - 如果指定 0，相当于"从最新开始"，丢失中断期间的事件

  问题3：rv 过期
    - etcd 默认保留 5000 个历史 rv
    - 如果 Watch 慢，落后超过 5000 个 rv，需要重新 List

List + Watch 的工程组合：
  - 启动期：List 全量，拿到"最新 rv"
  - 运行期：Watch 从"最新 rv"开始续传增量
  - 异常期：List 全量重建缓存，重新 Watch
  - 周期性：resync 防止事件丢失

这是 K8s 控制面"最终一致性"的工程实现：
  - 不是"实时一致"（Watch 有延迟）
  - 不是"强一致"（多个 Controller 缓存可能短暂不一致）
  - 但保证"最终收敛"（resync + re-list 兜底）
```

#### 2.6 resourceVersion 的语义

```text
resourceVersion 是 K8s 对象的"资源版本号"：

  - 来源：etcd 的全局递增 revision
  - 每次写操作（创建 / 更新 / 删除）都产生新 rv
  - rv 是字符串，但实际是数字（如 "12345"）
  - 单调递增，可用于比较"新旧"

resourceVersion 的两种用途：

  1. 乐观锁（CAS）
     - PUT /api/v1/pods/foo HTTP/1.1
       Content-Type: application/json
       {"kind":"Pod","metadata":{"name":"foo","resourceVersion":"12345"},...}
     - API Server 校验：当前 etcd 中 pod foo 的 rv 是否 == 12345
     - 如果 != 12345，返回 409 Conflict（说明已被他人修改）
     - 客户端需 re-list + retry

  2. Watch 续传
     - GET /api/v1/watch/pods?resourceVersion=12345
     - API Server 推送 rv > 12345 的所有事件
     - 如果 rv 12345 已 compacted，返回 410 Gone
     - 客户端需 re-list

resourceVersion 的常见陷阱：

  - "0"：表示"读最新"，从 cacher 读，但 cacher 可能比 etcd 慢几毫秒
  - ""（空）：表示"读 etcd 最新"，等价于"0"
  - 具体 rv：从 cacher 读该 rv 的快照（如果还存在）
  - "Not set"：相当于"0"

  生产陷阱：
    Controller 读 Pod 时带 resourceVersion=0 → 读到 cacher 缓存
    Controller 写 Pod 时用读到的 rv → 写入时校验 etcd 当前 rv
    如果中间 Pod 被修改，cacher 还没同步 → 409 Conflict
```

### 问题3：Informer / Reflector / Delta FIFO / Indexer 四大组件如何协作

#### 3.1 整体架构

```text
                        ┌─────────────────────┐
                        │  API Server / etcd  │
                        └──────────┬──────────┘
                                   │ List-Watch
                        ┌──────────▼──────────┐
                        │     Reflector      │
                        │  (List-Watch 执行) │
                        └──────────┬──────────┘
                                   │ Add Δ
                        ┌──────────▼──────────┐
                        │    Delta FIFO      │  ← 去重 + FIFO
                        │  (事件队列)         │
                        └──────────┬──────────┘
                                   │ Pop
                        ┌──────────▼──────────┐
                        │     Informer       │
                        │  (分发器)           │
                        └──┬─────────────┬────┘
                           │             │
              ┌────────────▼───┐    ┌────▼────────────┐
              │  Indexer       │    │  Event Handlers  │
              │ (本地缓存)     │    │  (OnAdd/OnUpdate/│
              │                │    │   OnDelete)      │
              └────────────────┘    └────┬────────────┘
                                          │ EnqueueKey
                                       ┌──▼──┐
                                       │Work-│
                                       │queue│
                                       └──┬──┘
                                          │ Get
                                       ┌──▼──┐
                                       │Worker│
                                       │ (Reconcile)│
                                       └─────┘
```

#### 3.2 Reflector：List-Watch 的执行者

```text
Reflector 的职责：
  - 调用 API Server 的 List + Watch
  - 把事件（Added / Modified / Deleted）转换为 Delta（Δ）
  - 写入 Delta FIFO 队列

Reflector 的关键方法：
  - Run(stopCh)        - 启动 Reflector 主循环
  - ListAndWatch()     - 执行 List + Watch
  - watchHandler()     - 处理 Watch 事件
  - relistResourceVersion() - 获取最新 rv（用于 re-list）

Reflector 的退避策略：
  - List 失败：1s → 2s → 4s → 8s → 10s（指数退避，上限 10s）
  - Watch 失败：1s → 2s → 4s → 8s → 10s
  - 防止 API Server 故障时 Controller 雪崩
```

#### 3.3 Delta FIFO：去重 + 先进先出的"事件队列"

```text
Delta FIFO 的核心特性：
  - "FIFO"：先进先出，保证事件顺序
  - "Delta"：每个事件是个"增量"（Added/Modified/Deleted/Sync）
  - "去重"：同一个 key 多个 Δ 会合并，但保留顺序

Delta FIFO 的内部结构：
  - items map[Key][]Delta - 每个 key 累积的所有 Δ
  - queue []Key - key 的入队顺序

去重的工程价值：
  - Informer 处理慢时，Watch 可能推送多个同 key 事件
  - 例如：Pod foo 被快速 Modified 3 次（rv 100, 101, 102）
  - Delta FIFO 把 3 个 Δ 累积为 [Modified@100, Modified@101, Modified@102]
  - Informer 处理时一次性应用 3 次，最终状态正确
  - 没有"中间状态丢失"风险

Sync Δ 的特殊语义：
  - resync 时，Informer 把 Indexer 中所有 key 重新入队
  - 入队的是 Sync Δ（不是 Added/Modified/Deleted）
  - Handler 看到 Sync Δ 时，应该"用当前缓存状态调用 OnUpdate"
  - 用于"水平触发"的兜底机制
```

#### 3.4 Informer：分发器

```text
Informer 的职责：
  - 从 Delta FIFO Pop Δ
  - 更新 Indexer（本地缓存）
  - 分发给 Event Handlers（OnAdd / OnUpdate / OnDelete）

Informer 的核心方法：
  - Run(stopCh)         - 启动 Informer（启动 Reflector + 处理循环）
  - AddEventHandler()   - 注册 Handler
  - GetStore()         - 获取 Indexer
  - HasSynced()        - 是否完成首次 List（缓存与 etcd 一致）
  - LastSyncResourceVersion() - 最新 rv

Informer 的处理循环：
  for {
    delta := fifo.Pop()
    switch delta.Type {
    case Added:
      indexer.Add(delta.Object)
      handler.OnAdd(delta.Object)
    case Modified:
      oldObj := indexer.Get(delta.Object)
      indexer.Update(delta.Object)
      handler.OnUpdate(oldObj, delta.Object)
    case Deleted:
      handler.OnDelete(delta.Object)
      indexer.Delete(delta.Object)
    case Sync:
      // resync，用当前缓存状态调用 OnUpdate
      obj := indexer.Get(delta.Object)
      handler.OnUpdate(obj, obj)
    }
  }
```

#### 3.5 Indexer：本地缓存

```text
Indexer 的职责：
  - 本地缓存（避免每次 Reconcile 都查 API Server）
  - 索引查询（按 namespace / labels / 字段查询）
  - 线程安全（ThreadSafeStore）

Indexer 的内部结构：
  - cache map[string]interface{}  - key -> obj
  - indices map[string]map[string]sets.String - 索引

Indexer 的核心方法：
  - Add(obj) / Update(obj) / Delete(obj)
  - Get(obj) / List() / ListKeys()
  - Index(key, obj) - 添加索引
  - ByIndex(indexName, key) - 按索引查询

默认索引：
  - "namespace" - 按 namespace 查询
  - 自定义索引 - 例如按 labels、按 ownerReference

生产价值：
  - Controller 处理一个 Pod 的事件，需要查它的 Owner（Deployment）
  - 不用 Indexer：每次查 API Server，5000 个 Pod 同时处理 → API Server 雪崩
  - 用 Indexer：查本地缓存，纳秒级响应
```

#### 3.6 SharedInformer：共享 Informer

```text
为什么需要 SharedInformer：

  反例（不共享）：
    - Controller A 监听 Pod，启动一个 Informer
    - Controller B 监听 Pod，启动另一个 Informer
    - Controller C 监听 Pod，启动第三个 Informer
    - API Server 收到 3 个 List 请求 + 3 个 Watch 长连接
    - 浪费网络 / API Server 资源

  正例（SharedInformer）：
    - SharedInformerFactory 创建一个 SharedInformer
    - Controller A / B / C 各自注册 Handler
    - 内部只维护一个 List-Watch
    - 多个 Handler 共享同一份 Indexer 缓存
    - API Server 只收到 1 个 List 请求 + 1 个 Watch 长连接

SharedInformer 的实现：
  - SharedInformer 内部维护一个 Informer + 多个 Handler
  - List-Watch 只执行一次
  - 事件分发给所有 Handler
  - 每个 Handler 自己的 Workqueue 独立处理

K8s 内置 Controller 全部用 SharedInformerFactory：
  - kube-controller-manager 启动时，创建一个 factory
  - 所有 Controller 共享同一份 Pod / Service / Endpoints 缓存
  - 节省 API Server 大量资源
```

#### 3.7 五大组件协作的"事件流"

```text
事件流示例：用户创建 Pod foo

  1. 用户 kubectl apply pod foo → API Server → etcd（rv=100）

  2. etcd 推送 Watch 事件给 API Server cacher

  3. cacher 推送 Watch 事件给 Controller 的 Reflector

  4. Reflector 把 Δ{Added, foo} 写入 Delta FIFO

  5. Informer 从 Delta FIFO Pop Δ

  6. Informer 调用 Indexer.Add(foo)，缓存更新

  7. Informer 调用 Handler.OnAdd(foo)

  8. Handler 把 key "default/foo" Enqueue 到 Workqueue

  9. Worker 从 Workqueue Get key "default/foo"

  10. Worker 执行 Reconcile("default/foo")：
      - 从 Indexer 读 Pod foo（不查 API Server）
      - 检查 Pod 状态，决定动作
      - 返回 nil（成功）或 error（失败 requeue）

整个链路的关键点：
  - List-Watch 推送（异步）
  - Delta FIFO 缓冲（削峰）
  - Indexer 缓存（加速读）
  - Workqueue 限流（保护 API Server）
  - Reconcile 幂等（重试安全）
```

### 问题4：Workqueue 的"去重 / 延迟 / 限速 / 退避"四件套如何设计

#### 4.1 Workqueue 的核心 API

```text
type RateLimitingInterface interface {
  Add(item)        // 立即入队
  AddAfter(item, duration)  // 延迟入队（用于退避）
  AddRateLimited(item)      // 限速入队（按退避策略）
  Get() (item, shutdown)    // 取出（标记为"处理中"）
  Done(item)       // 标记完成（从"处理中"移除）
  Forget(item)    // 重置退避计数
  NumRequeues(item) int    // 退避次数
}
```

#### 4.2 Add / Get / Done 的"持久性"

```text
Workqueue 与 Delta FIFO 的核心差异：

  Delta FIFO：
    - "事件队列"，事件处理完就丢
    - 同一个 key 多次入队，会合并 Δ
    - 适合"事件分发"

  Workqueue：
    - "任务队列"，key 不丢
    - 同一个 key 多次 Add 只入队一次（去重）
    - Get 后标记为"处理中"，Done 后才彻底移除
    - 适合"任务处理"

为什么 Workqueue 必须持久：

  反例（不持久）：
    1. Worker A Get key "foo"，开始 Reconcile
    2. Worker A 处理过程中，Watch 推送 Pod foo 的 Modified 事件
    3. Handler 再次 Enqueue "foo"
    4. Worker B Get key "foo"，开始 Reconcile
    5. 现在 A 和 B 同时处理 "foo"，可能并发写 API Server

  正例（持久）：
    1. Worker A Get key "foo"，标记为"处理中"
    2. 期间 Watch 推送 Pod foo 的 Modified 事件
    3. Handler 再次 Enqueue "foo"
    4. Workqueue 发现 "foo" 已在"处理中"集合，标记"待重新入队"
    5. Worker A Done "foo"，触发"待重新入队"的 "foo" 重新入队
    6. Worker B Get key "foo"，开始 Reconcile
    7. 串行处理，无并发冲突

工程价值：
  - 同一个 key 不会并发执行
  - 处理期间发生的事件不会丢
  - "处理中"集合 = 互斥锁的等价物
```

#### 4.3 AddAfter：延迟入队

```text
AddAfter(item, duration) 的语义：
  - 把 item 延迟 duration 后入队
  - 用于"主动等待"场景

典型应用：
  - 等待 ConfigMap 同步：Reconcile 失败，AddAfter(key, 5s)
  - 退避策略：失败后立即退避 N 秒再重试
  - 周期性任务：Reconcile 成功，AddAfter(key, 30s) 周期性轮询

实现：
  - 内部维护一个"延迟队列"（heap，按 ready 时间排序）
  - 后台 goroutine 周期性检查 ready 的 item，移入主队列
  - 即使 Controller 重启，延迟队列状态会丢（需用持久化退避策略补足）
```

#### 4.4 AddRateLimited：限速入队

```text
AddRateLimited(item) 的语义：
  - 按"退避策略"决定延迟时间，再 AddAfter 入队
  - 用于"失败重试"场景

退避策略的接口：
  type RateLimiter interface {
    When(item) time.Duration  // 计算下次重试延迟
    Forget(item)             // 成功后重置
    NumRequeues(item) int    // 失败次数
  }

K8s 默认限速器：BucketRateLimiter + ItemExponentialFailureRateLimiter

  BucketRateLimiter：
    - 令牌桶，全局限速（例如 10 qps）
    - 防止 Controller 雪崩 API Server

  ItemExponentialFailureRateLimiter：
    - 每个 item 独立退避
    - baseDelay * 2^(failures-1)，上限 maxDelay
    - 默认：baseDelay=5ms, maxDelay=1000s
    - 失败 1 次：5ms
    - 失败 5 次：80ms
    - 失败 10 次：2560ms ≈ 2.5s
    - 失败 20 次：≈ 8.7min

  组合（默认）：
    - BucketRateLimiter(10 qps)
    - ItemExponentialFailureRateLimiter(5ms, 1000s)
    - Controller 每秒最多处理 10 个 item
    - 每个 item 失败时按指数退避
```

#### 4.5 Forget / NumRequeues：退避状态管理

```text
Forgetter 的语义：
  - Reconcile 成功后调用 Forget(item)
  - 重置该 item 的失败次数
  - 下次失败从 baseDelay 重新开始

NumRequeues 的用途：
  - 监控某 item 的失败次数
  - 超过阈值告警（如 > 10 次持续失败）
  - 用于"死信"处理（人工介入）

正确用法：
  Reconcile(key):
    err := doWork()
    if err != nil {
      queue.AddRateLimited(key)  // 失败，按退避重试
      return err
    }
    queue.Forget(key)  // 成功，重置退避
    return nil

错误用法1：不 Forget
  Reconcile(key):
    err := doWork()
    if err == nil {
      return nil  // 忘了 Forget
    }
    ...
    问题：item 成功后，失败次数不重置，下次失败仍按高延迟重试

错误用法2：吞错误
  Reconcile(key):
    doWork()  // 错误被吞
    return nil  // 永远返回 nil
    问题：失败也不 requeue，状态永远不收敛
```

### 问题5：Reconcile Loop 的核心模式

#### 5.1 Reconcile 的标准签名

```text
controller-runtime 的 Reconcile 接口：

  type Reconciler interface {
    Reconcile(context.Context, Request) (Result, error)
  }

  type Request struct {
    NamespacedName types.NamespacedName  // namespace/name
  }

  type Result struct {
    Requeue      bool
    RequeueAfter time.Duration
  }

返回值的语义：

  Requeue: false, RequeueAfter: 0, error: nil
    - 成功，不重试
    - 等 Watch 下次推送事件再触发

  Requeue: true, RequeueAfter: 0, error: nil
    - 立即重新入队（不常用）

  Requeue: false, RequeueAfter: 30s, error: nil
    - 30s 后重新入队（周期性轮询）

  error: &lt;非空>
    - 失败，按退避策略重试
    - controller-runtime 会自动 AddRateLimited
```

#### 5.2 Reconcile 的"无状态"模式

```text
Reconcile 必须无状态：

  - 不依赖上次的执行结果
  - 不依赖外部变量（如全局 map）
  - 每次都重新读取 Desired State + Current State

  正例：
    Reconcile(req):
      deploy = getDeploy(req.Name)  // 从 Indexer 读
      if deploy == nil:
        return nil  // 已删除，无需处理
      pods = listPodsForDeploy(req.Name)  // 从 Indexer 读
      diff = compareReplicas(deploy.Spec.Replicas, len(pods))
      if diff > 0:
        createPods(deploy, diff)
      elif diff &lt; 0:
        deletePods(pods, -diff)
      return nil

  反例（有状态）：
    var lastReplicas = 0
    Reconcile(req):
      deploy = getDeploy(req.Name)
      if deploy.Spec.Replicas != lastReplicas:
        scale(deploy.Spec.Replicas)
        lastReplicas = deploy.Spec.Replicas
      return nil

    问题：
      - Controller 重启后 lastReplicas 丢失，首次 Reconcile 行为异常
      - 多个 Worker 并发执行时 lastReplicas 竞争
      - 事件丢失时，"边沿触发"模式无法收敛
```

#### 5.3 Reconcile 的"幂等"模式

```text
Reconcile 必须幂等：

  - 同一个 key 多次 Reconcile 结果一致
  - 即使 Reconcile 中途失败，下次重新执行不会产生副作用

  幂等模式的核心：
    "先查再做"（GetOrCreate 模式）

  正例：
    Reconcile(req):
      cm = getConfigMap(req.Name)
      if cm == nil:
        cm = createConfigMap(defaultCM)
      elif cm.Data["config.yaml"] != expectedConfig:
        cm.Data["config.yaml"] = expectedConfig
        updateConfigMap(cm)
      return nil

  反例（不幂等）：
    Reconcile(req):
      cm = createConfigMap(defaultCM)  // 每次都创建！
      return nil

    问题：每次 Reconcile 都创建新 CM，老 CM 没删，导致 CM 泛滥

  反例（不幂等 + 不查 OwnerReference）：
    Reconcile(req):
      pods = listPodsForDeploy(req.Name)
      for pod in pods:
        if pod.Status.Phase == "Failed":
          deletePod(pod)  // 删除失败的 Pod
      createPod(deploy)  // 再创建一个新 Pod

    问题：
      - 如果 Reconcile 中途失败，可能创建了新 Pod 但没删老的
      - 下次 Reconcile 再创建一个新 Pod，无限循环
```

#### 5.4 Reconcile 的"乐观锁"模式

```text
Reconcile 通过 resourceVersion 实现乐观锁：

  - 读对象时，获取当前 rv
  - 写对象时，API Server 校验 rv 是否一致
  - 不一致返回 409 Conflict
  - Controller 重新读 + 重试

  正例：
    Reconcile(req):
      deploy = getDeploy(req.Name)
      deploy.Spec.Replicas = newReplicas
      try:
        updateDeploy(deploy)
      except ConflictError:
        // rv 不一致，重新读 + 重试
        return retry
      return nil

  工程价值：
    - 多个 Controller 并发修改同一对象不会冲突
    - 比悲观锁（行锁 / 表锁）性能好
    - 失败时退避重试，最终一致
```

#### 5.5 Reconcile 的"失败 requeue"模式

```text
Reconcile 必须正确处理失败：

  - 返回 error：触发退避重试
  - 返回 nil：成功，等下次事件
  - 返回 RequeueAfter：主动延迟重试（如等待外部资源就绪）

  正例：
    Reconcile(req):
      deploy = getDeploy(req.Name)
      if deploy == nil:
        return nil  // 已删除，无需处理

      cm, err = getConfigMapWithError(deploy.Spec.ConfigMapName)
      if err != nil:
        return err  // 退避重试

      if cm == nil:
        // ConfigMap 还没创建，30s 后再检查
        return Result{RequeueAfter: 30s}, nil

      // 业务逻辑
      return nil

  反例（吞错误）：
    Reconcile(req):
      defer func() {
        if r := recover(); r != nil {
          log.Error(r)  // 吞 panic
        }
      }()
      doWork()  // 错误被吞
      return nil

    问题：
      - 错误被吞，状态永远不收敛
      - workqueue 不会 requeue
      - 用户感知不到问题
```

### 问题6：resourceVersion 与乐观锁的底层原理

#### 6.1 resourceVersion 的本质

```text
resourceVersion 是 K8s 对象的"资源版本号"：

  - 来源：etcd 的全局递增 revision（mod_revision）
  - 类型：字符串（实际是数字）
  - 单调递增
  - 持久化（etcd 重启后继续递增）

为什么不用对象 hash 或时间戳：

  - hash：无法比较"新旧"
  - 时间戳：分布式时钟不可靠（NTP 漂移）
  - 全局递增整数：可比较、单调、可靠

revision 的全局性：
  - 不仅同一对象不同版本 rv 不同
  - 不同对象不同版本 rv 也不同
  - 例如：
    Pod foo created at rv=100
    Service bar created at rv=101
    Pod foo updated at rv=102
  - 这是 etcd MVCC 的全局版本号
```

#### 6.2 乐观锁的 CAS 模式

```text
CAS（Compare-And-Swap）模式：

  1. 客户端读对象，获取当前 rv
  2. 客户端修改对象，发送 PUT 请求带 rv
  3. 服务端校验：当前 etcd 中对象 rv == 客户端 rv?
     - 是：写入，返回新 rv
     - 否：返回 409 Conflict

  示例：
    Step 1: Controller A 读 Pod foo（rv=100）
    Step 2: Controller B 读 Pod foo（rv=100）
    Step 3: Controller A 写 Pod foo（带 rv=100）
            → etcd 校验：当前 rv=100 ✓，写入，新 rv=101
    Step 4: Controller B 写 Pod foo（带 rv=100）
            → etcd 校验：当前 rv=101，≠ 100，返回 409 Conflict
    Step 5: Controller B 重新读（rv=101）+ 重试

工程价值：
  - 多个 Controller 并发修改同一对象不会冲突
  - 不需要悲观锁（行锁 / 表锁）
  - 失败时退避重试，最终一致
```

#### 6.3 "写覆盖"问题

```text
没有 CAS 时会发生什么：

  Step 1: Controller A 读 Pod foo（spec.replicas=3）
  Step 2: Controller B 读 Pod foo（spec.replicas=3）
  Step 3: Controller A 想把 replicas 改为 5
          写 Pod foo（spec.replicas=5）
  Step 4: Controller B 想把 replicas 改为 4
          写 Pod foo（spec.replicas=4）
          → 覆盖 A 的修改！

  最终结果：replicas=4，A 的修改丢失

  有了 CAS：
  Step 4: Controller B 写 Pod foo（带 rv=100）
          → 409 Conflict
          → B 重新读（rv=101, replicas=5）
          → B 决定：基于 replicas=5 修改为 4？还是放弃？
          → 业务决策

K8s Controller 的标准做法：
  - 收到 409 Conflict 时，re-list + retry
  - 不需要悲观锁
  - 但要求业务逻辑幂等
```

#### 6.4 resourceVersion 在 Watch 中的"续传"语义

```text
Watch 续传的语义：

  GET /api/v1/watch/pods?resourceVersion=100

  - 客户端告诉服务端："我已经看到 rv=100 了，请推送 rv>100 的事件"
  - 服务端推送：(rv=101, Added, pod-a), (rv=102, Modified, pod-b), ...

  如果 rv=100 已被 compacted：
  - 返回 410 Gone
  - 客户端需重新 List

  如果 rv=0：
  - 表示"从最新开始"
  - 仅推送"未来的事件"，不推送"已存在的对象"
  - 适合"事件订阅"，不适合"状态同步"

  如果 rv=""（空）：
  - 等价于 rv=0

  如果 rv=具体值：
  - 推送 rv > 该值的所有事件
  - 用于"断线续传"

生产场景：
  - Controller 启动时 List 全量，拿到最新 rv（如 rv=10000）
  - Watch 从 rv=10000 开始
  - Watch 中断后，用最新已收到的 rv（如 rv=10050）续传
  - 如果 rv=10050 已 compacted，re-list
```

#### 6.5 resourceVersion 的常见陷阱

```text
陷阱1：用 resourceVersion 做"唯一标识"

  反例：
    if pod.ResourceVersion == "100" {
      // 这个 Pod 是某个特定版本
    }

  问题：
    - resourceVersion 不是"对象唯一标识"
    - 同一个对象可能在不同集群 / 不同 API Server 实例有相同 rv
    - 应该用 UID 字段做唯一标识

陷阱2：缓存 rv 后长时间不更新

  反例：
    rv = listPods().ResourceVersion  // rv=100
    // 5 分钟后
    watchPods(rv)  // rv=100 可能已 compacted

  正例：
    rv = listPods().ResourceVersion  // rv=100
    watchPods(rv)  // 立即 Watch

陷阱3：用 resourceVersion 排序

  反例：
    pods = listPods()
    sort(pods, by rv)  // 错误！

  问题：
    - 同一对象多次更新，rv 不同
    - 不同对象 rv 不可比（例如 Pod A rv=100, Service B rv=101）
    - 应该按 creationTimestamp / name 排序
```

### 问题7：Controller 重启后的"状态恢复"如何保证

#### 7.1 Controller 重启后的状态

```text
Controller 重启后，本地状态全部丢失：
  - Indexer 缓存（全量对象）
  - Delta FIFO 队列（待处理事件）
  - Workqueue（待处理任务）
  - 退避状态（每个 item 的失败次数）

但 etcd 中的"集群状态"没丢：
  - 所有 Deployment / Pod / Service 等资源完整
  - resourceVersion 继续递增

Controller 重启后的恢复流程：

  1. 启动期（10s-数分钟）
     - Reflector 重新 List 全量
       * 大集群（10w+ Pod）可能需要数十秒
     - 期间 Indexer 缓存为空，Reconcile 读对象会"未找到"
     - 期间 Watch 还没开始，事件丢失

  2. List 完成后
     - Indexer 缓存填充完毕
     - 启动 Watch（从 List 后的最新 rv 开始）

  3. 触发 Reconcile
     - List 期间发生的事件会通过 Watch 推送（如果 rv 没 compacted）
     - resync 机制兜底（默认 10h）

  4. 恢复正常工作
```

#### 7.2 List + Watch 的"双轨制"

```text
Reflector 的 List + Watch 实现：

  方案 A（K8s 默认）：先 List 完成后 Watch
    1. List 全量，记录最新 rv
    2. 启动 Watch（从最新 rv 开始）
    3. List 期间发生的事件可能丢失

  方案 B（理论方案）：List + Watch 同时
    1. 启动 List（异步）
    2. 同时启动 Watch（从某个 rv 开始）
    3. 合并 List 结果和 Watch 事件

  方案 A 的"窗口期"问题：
    - List 启动时 rv=1000
    - List 完成时 rv=1050
    - 启动 Watch 从 rv=1000（List 启动时的 rv）
    - 期间 rv 1001-1050 的事件通过 Watch 推送
    - 但如果 List 期间发生"Pod foo 创建 + 删除"，最终 List 不会包含 foo
    - Watch 会推送 foo 的 Added + Deleted，最终 Indexer 状态正确

  方案 A 的"风险"：
    - 如果 rv=1000 已 compacted（极端情况），Watch 返回 410 Gone
    - 需要重新 List，从最新 rv 开始 Watch
```

#### 7.3 Controller 启动期"窗口期"业务影响

```text
现象1 的根因：Deployment Controller 启动期窗口

  时间线：
  02:00:00  开始升级 K8s 控制面（rolling update kube-controller-manager）
  02:00:30  旧 KCM 实例优雅退出（释放 Leader 选举 Lease）
  02:01:00  新 KCM 实例启动
  02:01:30  新 KCM 启动 Leader 选举，获取 Lease
  02:01:31  启动 Deployment Controller（创建 SharedInformer）
  02:01:32  开始 List Deployment（小对象，快）
  02:01:33  开始 List ReplicaSet
  02:01:34  开始 List Pod（大对象，10w+ 个，需要 10s+）
  02:02:00  List Pod 完成，开始 Watch Pod
  02:02:01  开始 List Endpoints
  02:02:30  List Endpoints 完成，启动 EndpointSlice Controller

  期间（02:01:30 - 02:02:30）：
  - 用户 kubectl apply Deployment，期望 10 副本
  - Deployment Controller 还没启动，没有创建 ReplicaSet
  - 1 分钟后 Deployment Controller 启动，看到 Deployment，创建 ReplicaSet
  - ReplicaSet Controller 还没启动，没有创建 Pod
  - 1 分钟后 ReplicaSet Controller 启动，创建 Pod
  - Pod 调度到节点，kubelet 启动容器
  - EndpointSlice Controller 还没启动，没有更新 Endpoints
  - 1 分钟后 EndpointSlice Controller 启动，更新 Endpoints
  - Endpoints 收敛到 10 个 Pod

  总延迟：约 8 分钟，与现象1 一致

工程防御：
  1. 滚动升级 KCM（多副本 + Leader 选举）：
     - 旧 Leader 还在工作时，新副本启动并 List
     - 新副本 List 完成后，旧 Leader 退出
     - 窗口期最短

  2. List 加速：
     - 启用 API Server 的 watch cache（默认开启）
     - 启用 List 的 FieldSelector（只 List 自己关心的资源）
     - 启用 List 的 limit 分页

  3. 监控 KCM 启动期：
     - 监控 workqueue depth
     - 监控 List 耗时
     - 告警 "Leader 选举切换"事件
```

#### 7.4 Controller 重启时的 "Missing Watch" 风险

```text
如果 Controller 在重启期间错过了某些事件：

  风险：
    - 事件永久丢失，状态永远不一致

  防御机制：

  1. resync 兜底
     - 默认 10h resync 一次
     - 把 Indexer 中所有 key 重新入队，触发 Reconcile
     - 即使错过事件，10h 内会修正

  2. List 时的 rv 续传
     - Reflector List 时获取最新 rv
     - Watch 从该 rv 开始
     - 期间事件通过 Watch 推送

  3. 启动期 List + Watch 配合
     - List 启动时记录 rv=X
     - List 完成后 Watch 从 rv=X 开始
     - 期间事件不会丢失

  4. 错过事件后的最终一致
     - 即使错过事件，下次 resync 会触发 Reconcile
     - Reconcile 比对 Desired State vs Current State，发现差异，修正

  K8s 的"最终一致性"承诺：
    - 不保证"实时一致"
    - 保证"最终收敛"
    - 通常收敛时间 &lt; resync 周期（10h）
    - 大部分场景 &lt; 1 分钟（事件触发 Reconcile）
```

### 问题8：自研 Operator 的 Controller 框架选型与陷阱

#### 8.1 三大框架对比

```text
client-go（最底层）
  - 提供 Informer / Workqueue / Indexer 基础组件
  - 需要自己组装 Informer + Workqueue + Reconcile Loop
  - 灵活但代码量大
  - 适合"非标准"场景（如自定义事件分发）

controller-runtime（中层）
  - 封装 Informer + Workqueue + Reconcile 接口
  - 提供 Manager / Controller / Client 抽象
  - 自动处理 Leader 选举、metrics、健康检查
  - 代码量适中
  - 适合"标准" Operator

Kubebuilder / Operator SDK（高层脚手架）
  - 生成 CRD / Controller / Webhook 脚手架
  - 集成 controller-runtime
  - 提供 Makefile / Dockerfile / Kustomize
  - 适合"从零开始"的 Operator

选型建议：
  - 简单 Operator（一个 CRD + 几个子资源）→ Kubebuilder
  - 复杂 Operator（多 CRD + Webhook + 复杂状态机）→ controller-runtime + 自定义脚手架
  - 特殊场景（如自定义事件源）→ client-go
```

#### 8.2 controller-runtime 的 Reconcile 接口

```go
type Reconciler interface {
    Reconcile(context.Context, Request) (Result, error)
}

type ReconcileRequest struct {
    NamespacedName types.NamespacedName  // namespace/name
}

type Result struct {
    Requeue      bool           // 是否立即重新入队
    RequeueAfter time.Duration  // 延迟重新入队
}

// 标准实现示例
func (r *GPUInferenceReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    log := r.Log.WithValues("gpuinference", req.NamespacedName)

    // 1. 获取 CR
    var inference gpustackv1.GPUInference
    if err := r.Get(ctx, req.NamespacedName, &inference); err != nil {
        if errors.IsNotFound(err) {
            return ctrl.Result{}, nil  // 已删除，无需处理
        }
        return ctrl.Result{}, err  // 失败，退避重试
    }

    // 2. 检查 Finalizer
    if inference.DeletionTimestamp.IsZero() {
        if !controllerutil.ContainsFinalizer(&inference, "gpustack.example.com/finalizer") {
            controllerutil.AddFinalizer(&inference, "gpustack.example.com/finalizer")
            if err := r.Update(ctx, &inference); err != nil {
                return ctrl.Result{}, err
            }
            return ctrl.Result{Requeue: true}, nil  // 立即重新入队
        }
    } else {
        // 处理删除逻辑
        if err := r.cleanupExternalResources(&inference); err != nil {
            return ctrl.Result{}, err
        }
        controllerutil.RemoveFinalizer(&inference, "gpustack.example.com/finalizer")
        if err := r.Update(ctx, &inference); err != nil {
            return ctrl.Result{}, err
        }
        return ctrl.Result{}, nil
    }

    // 3. 确保 ConfigMap（幂等）
    var cm corev1.ConfigMap
    err := r.Get(ctx, types.NamespacedName{Name: inference.Name + "-config", Namespace: inference.Namespace}, &cm)
    if errors.IsNotFound(err) {
        cm = buildConfigMap(&inference)
        if err := r.Create(ctx, &cm); err != nil {
            return ctrl.Result{}, err
        }
        // 创建后立即返回，等下次 Reconcile 检查状态
        return ctrl.Result{Requeue: true}, nil
    } else if err != nil {
        return ctrl.Result{}, err
    }

    // 4. 检查 ConfigMap 内容是否需要更新
    if !reflect.DeepEqual(cm.Data, expectedConfigMapData(&inference)) {
        cm.Data = expectedConfigMapData(&inference)
        if err := r.Update(ctx, &cm); err != nil {
            return ctrl.Result{}, err
        }
    }

    // 5. 更新 Status
    if inference.Status.Phase != "Ready" {
        inference.Status.Phase = "Ready"
        if err := r.Status().Update(ctx, &inference); err != nil {
            return ctrl.Result{}, err
        }
    }

    return ctrl.Result{}, nil
}
```

#### 8.3 自研 Controller 的常见陷阱

```text
陷阱1：Reconcile 不幂等

  反例：
    Reconcile(req):
      cm = buildConfigMap()  // 每次都创建新的
      r.Create(ctx, &cm)     // 不检查是否已存在
      return nil

  问题：每次 Reconcile 都尝试创建，第二次返回 409 AlreadyExists
       但 Controller 吞错误，状态永远不收敛

  正例：
    Reconcile(req):
      err := r.Get(ctx, cmKey, &cm)
      if errors.IsNotFound(err):
        cm = buildConfigMap()
        if err := r.Create(ctx, &cm); err != nil:
          return err
        return requeue  // 创建后立即重新入队
      elif err != nil:
        return err
      // 检查内容
      if !reflect.DeepEqual(cm.Data, expected):
        cm.Data = expected
        if err := r.Update(ctx, &cm); err != nil:
          return err
      return nil

陷阱2：Reconcile 不返回 error（吞错误）

  反例：
    Reconcile(req):
      defer func() {
        if r := recover(); r != nil:
          log.Error(r)  // 吞 panic
      }()
      doWork()
      return nil  // 永远返回 nil

  问题：失败也不 requeue，状态永远不收敛

  正例：
    Reconcile(req):
      defer func() {
        if r := recover(); r != nil:
          log.Error(r)
          // 把 panic 转为 error，触发 requeue
          panicChan &lt;- r
      }()
      err := doWork()
      if err != nil:
        return err  // 触发退避重试
      return nil

陷阱3：创建子资源不带 OwnerReference

  反例：
    Reconcile(req):
      cm = buildConfigMap()
      // 不设 OwnerReference
      r.Create(ctx, &cm)
      return nil

  问题：CR 被删除时，CM 不会被自动 GC，造成资源泄漏

  正例：
    Reconcile(req):
      cm = buildConfigMap()
      controllerutil.SetControllerReference(&inference, &cm, r.Scheme)
      r.Create(ctx, &cm)
      return nil

陷阱4：Workqueue worker 数过多

  反例：
    controller.SetMaxConcurrentReconciles(100)

  问题：100 个 worker 并发调谐，可能压垮 API Server
       （每个 worker 都在 List / Watch / Update）

  正例：
    controller.SetMaxConcurrentReconciles(1)  // 串行
    // 或：
    controller.SetMaxConcurrentReconciles(5)  // 小并发
    // 配合 client-go 限流器（默认 5 qps）

陷阱5：Watch 不带 FieldSelector

  反例：
    builder.For(&corev1.Pod{}).Complete(r)

  问题：Watch 集群中所有 Pod（10w+），List 慢 + 内存占用大

  正例：
    builder.For(&gpustackv1.GPUInference{}).
        Owns(&corev1.ConfigMap{}).  // 只 Watch 自己创建的 CM
        Complete(r)

陷阱6：缓存未同步就读对象

  反例：
    Reconcile(req):
      cm := r.Get(ctx, key)  // 读 cache，但 cache 还没同步
      if cm == nil:
        r.Create(ctx, newCM)  // 创建，但实际已存在 → 409
      return nil

  问题：Controller 启动期，cache 还在 List 中，读取返回 NotFound
       Controller 创建新对象，但 etcd 中已有，409 AlreadyExists

  正例：
    Reconcile(req):
      if !r.Cache.WaitForCacheSync(ctx):
        return requeue  // 等 cache 同步
      cm := r.Get(ctx, key)
      ...

  或：用 client.Reader 直接读 API Server（不读 cache）：
    Reconcile(req):
      cm := r.APIReader.Get(ctx, key)  // 直接读 API Server
      ...
```

#### 8.4 现象5 的根因：医疗影像 AI 推理 Operator 无限循环

```text
现象5 的根因分析：

  自研 Operator 的 Reconcile 实现（错误）：
    Reconcile(req):
      inference := getGPUInference(req.Name)
      cm := getCM(inference.Name + "-config")
      if cm == nil:
        createCM(inference)  // 创建
      updateStatus(inference, "Ready")
      return nil  // 返回 nil，立即结束

  错误：
    1. 创建 CM 后立即返回 nil，但 Cache 还没同步到新 CM
    2. 下次 Reconcile（5s 后由 resync 或其他事件触发）
       读 Cache，看到 Cache 中没有新 CM（Cache 滞后）
       → 再次创建 CM → 409 AlreadyExists
    3. 即使 409，Controller 没正确处理，吞错误
    4. 但每次 Reconcile 都执行了 updateStatus，可能引发 Status 的反复修改
    5. Status 修改触发 Watch 事件，再次触发 Reconcile
    6. 无限循环

  修复：
    Reconcile(req):
      inference := getGPUInference(req.Name)
      if inference == nil:
        return nil  // 已删除

      cm := getCM(inference.Name + "-config")
      if cm == nil:
        // 用 APIReader 直接读 API Server，避免 Cache 滞后
        cm = apiReader.GetCM(inference.Name + "-config")
        if cm == nil:
          createCM(inference)
          return requeue  // 创建后立即重新入队
          // 下次 Reconcile 时 CM 已在 Cache 中

      // 检查 CM 内容
      if !reflect.DeepEqual(cm.Data, expectedData(inference)):
        updateCM(cm, expectedData(inference))
        return requeue  // 更新后立即重新入队

      // 更新 Status
      if inference.Status.Phase != "Ready":
        updateStatus(inference, "Ready")
        // 不需要 requeue，等下次事件
      return nil

  关键修复点：
    1. 创建 / 更新后立即 requeue，等 Cache 同步
    2. 用 APIReader 直接读 API Server，绕过 Cache 滞后
    3. 严格幂等：先查再创建 / 更新
    4. 严格错误处理：返回 error 触发退避
```

---

## 五、五个现象的根因深挖与防御方案

### 现象1：Endpoints 收敛延迟 8 分钟

#### 根因

```text
KCM 滚动升级期间的"窗口期"：

  02:01:30  KCM 重启，Deployment Controller / ReplicaSet Controller / EndpointSlice Controller 都在启动
  02:01:31  Deployment Controller 启动，开始 List Deployment
  02:01:32  ReplicaSet Controller 启动，开始 List ReplicaSet
  02:02:00  Pod 列表 List 完成（10w+ Pod，30s+）
  02:02:01  EndpointSlice Controller 启动，开始 List Endpoints / EndpointSlice
  02:02:30  EndpointSlice Controller 启动完成，开始处理事件

  期间（02:01:30 - 02:02:30）：
  - 用户 apply Deployment（replicas: 10）
  - Deployment Controller 还没启动 → ReplicaSet 没创建
  - 1 分钟后 Deployment Controller 启动 → 创建 ReplicaSet
  - ReplicaSet Controller 还在 List Pod → 1 分钟后才创建 Pod
  - Pod 创建 → kubelet 启动容器 → Pod Ready
  - 但 EndpointSlice Controller 还在 List → 1 分钟后才更新 Endpoints

  总延迟：约 8 分钟，与现象1 一致
```

#### 防御方案

```text
方案1：KCM 多副本 + Leader 选举

  - 部署 3 副本 KCM（kube-controller-manager）
  - 启用 Leader 选举（--leader-elect=true）
  - 滚动升级时：
    * 旧 Leader 还在工作时，新副本启动并 List
    * 新副本 List 完成后，旧 Leader 退出
    * 窗口期最短（&lt; 10s）

  - K8s 默认配置：3 master，每个 master 一个 KCM，Leader 选举 Lease 15s

方案2：API Server watch cache 加速

  - 启用 API Server 的 watch cache（默认开启，--watch-cache=true）
  - 调大 watch cache 大小（--watch-cache-sizes=Pod#10000,Endpoints#10000）
  - 减少 List 时的 etcd 压力

方案3：避免在业务高峰期升级 KCM

  - KCM 升级窗口选凌晨低峰期
  - 提前公告，业务方知道"控制面升级期间可能有秒级抖动"

方案4：监控 KCM 启动期

  - 监控 Leader 选举切换事件（kcm_leader_election_status）
  - 监控 List 耗时（apiserver_request_duration_seconds）
  - 监控 workqueue depth（workqueue_depth）
  - 告警阈值：workqueue depth > 100 或 Leader 选举切换 > 1 次/分钟
```

### 现象2：Pod 反复重启

#### 根因

```text
Node controller 标记节点 NotReady + Pod eviction：

  时间线：
  02:11:30  Pod 在 az1-worker-03 上创建
  02:11:35  Pod Ready
  02:11:50  az1-worker-03 网络抖动，kubelet 失联
  02:11:55  Node controller 标记 az1-worker-03 为 NotReady
  02:12:10  Node controller 触发 Pod eviction（默认 40s 后驱逐）
  02:12:10  Pod 收到 SIGTERM，开始优雅停机
  02:12:40  Pod 被强制删除
            Deployment Controller 检测到 Pod 减少，重新创建
  02:12:41  新 Pod 调度到 az2-worker-05

  但 az1-worker-03 实际只是网络抖动，1 分钟后恢复：
  02:12:50  az1-worker-03 恢复，kubelet 重新连接
  02:12:50  Node controller 标记 az1-worker-03 为 Ready

  问题：
  - 网络抖动 1 分钟，但 Pod 已经被驱逐 + 重新调度
  - 短暂的网络抖动导致不必要的重启

  反复重启的原因：
  - az1-worker-03 周期性网络抖动（如每 1-2 分钟一次）
  - 每次抖动触发 Pod eviction + 重新调度
  - 形成反复重启
```

#### 防御方案

```text
方案1：调大 kubelet 的节点心跳超时

  - node-monitor-grace-period 默认 40s
  - 调大到 60s 或 120s（容忍更长网络抖动）
  - 但太大会导致"节点真的宕机"时检测延迟

方案2：调大 Pod eviction 的 grace period

  - Pod spec.terminationGracePeriodSeconds 默认 30s
  - 调大到 60s（给优雅停机更多时间）
  - 配合 preStop sleep 5s，避免流量还在打到正在关闭的 Pod

方案3：Pod 拓扑分布 + 反亲和

  - topologySpreadConstraints 让 Pod 跨 AZ 分布
  - podAntiAffinity 让同一 Deployment 的 Pod 不在同节点
  - 单节点故障不会让多个 Pod 同时被驱逐

方案4：节点健康检查 + 自动恢复

  - 监控节点 NotReady 事件（node_status_condition）
  - 告警阈值：单节点 NotReady > 1 次/小时
  - 排查根因（网络 / 磁盘 / 内存）
  - 必要时下线问题节点
```

### 现象3：批处理 Job 卡在 ContainerCreating

#### 根因

```text
Job Controller 的 Workqueue 限速：

  - Job Controller 默认 worker 数：5
  - 默认限流：10 qps
  - 100 个 Job 同时入队 → 70 个等限流
  - 等待时间：70 / 10 = 7s（理论值）
  - 但实际：12m30s（现象3 报告的值）

  为什么 12m30s 而不是 7s：
  - 70 个 Job 不是简单排队，而是指数退避
  - 失败的 Job（ContainerCreating 中）每次 Reconcile 都失败
  - AddRateLimited 按指数退避：5ms → 10ms → 20ms → ... → 1000s
  - 累积退避时间 ≈ 12m30s

  ContainerCreating 卡住的根因：
  - 多个 Job 同时调度到同一节点
  - 节点资源不足，无法启动容器
  - 镜像拉取慢（10w 份报告处理需要 100 个 Job，每个 Job 拉同一个镜像，节点 IO 阻塞）
  - PVC 绑定慢（每个 Job 一个 PVC，CSI 处理不过来）
```

#### 防御方案

```text
方案1：分批启动 Job

  - 不要 1 次性创建 100 个 Job
  - 用 Indexed Job + 分片（每批 10 个）
  - 用 K8s 1.27+ 的 Job Pod Failure Policy 控制失败重试

方案2：节点池隔离 + 资源预留

  - 体检报告 PDF 批处理用专用节点池
  - 节点 taint: pdf-batch=true:NoSchedule
  - Job 容忍 taint，独占节点
  - 避免与业务 Pod 争抢资源

方案3：镜像预热 + 节点预热

  - DaemonSet 在所有节点预拉镜像
  - 凌晨低峰期触发批处理，避免与业务争抢 IO

方案4：CSI 加速

  - 用本地盘（Local PV）替代网络存储
  - 或用 StorageClass 的 volumeBindingMode: WaitForFirstConsumer
  - 避免 PVC 绑定雪崩

方案5：Job Controller 调参

  - 调大 Job Controller worker 数（kube-controller-manager --concurrent-job-syncs=20）
  - 调大限流（kube-controller-manager --kube-api-qps=50）
  - 监控 workqueue depth，超过阈值告警
```

### 现象4：ResourceQuota usage 与实际不符

#### 根因

```text
ResourceQuota Controller 的"延迟统计"：

  - ResourceQuota Controller 周期性统计每个 Namespace 的资源用量
  - 默认 10 分钟统计一次（hard quota）
  - 期间 Pod 创建 / 删除，但 quota usage 还没更新
  - 用户看到的 quota usage 是"10 分钟前的快照"

  现象4 的根因：
  - 凌晨 02:00 ResourceQuota Controller 统计 used: cpu 65, memory 180Gi
  - 02:01 业务方创建 10 个 Pod，实际 used: cpu 80, memory 200Gi
  - 02:05 用户 kubectl describe quota，看到的还是 used: cpu 65, memory 180Gi（10 分钟前的快照）
  - 02:10 ResourceQuota Controller 再次统计，used: cpu 80, memory 200Gi
  - 但中间创建的 Pod 因 used 超过 hard（如 hard: cpu 70）被拒绝

  ResourceQuota 的"硬限制 + 延迟统计"问题：
  - Pod 创建时，ResourceQuota admission webhook 检查 used + new Pod requests 是否超过 hard
  - 但 used 是缓存值，可能滞后
  - 实际 used 已经接近 hard，但缓存显示还有空间
  - 新 Pod 通过 admission，但节点实际无法承载 → OOMKilled

  现象4 的另一种根因：
  - 多个 Namespace 共享 ResourceQuota
  - ResourceQuota Controller 用 List + Watch 跟踪 Pod
  - 如果 Controller 重启，启动期 List 慢，统计滞后
  - 期间 Pod 创建 / 删除，统计偏差
```

#### 防御方案

```text
方案1：周期性 resync + 主动触发

  - 缩短 ResourceQuota Controller 的统计周期（默认 10m，调到 5m 或 1m）
  - 但周期太短会增加 API Server 负载

方案2：ResourceQuota scope 区分

  - scopes: NotBestEffort 只统计 Guaranteed Pod
  - scopes: PriorityClass 按优先级统计
  - 避免统计噪音

方案3：监控 ResourceQuota 一致性

  - 周期性比对 ResourceQuota used vs 实际 Pod 总和
  - 偏差 > 5% 告警
  - 触发 ResourceQuota Controller 重新统计

方案4：避免 ResourceQuota 临界场景

  - hard quota 留 10-20% buffer
  - 业务方提前规划扩容
  - 不要在 quota 临界点创建 Pod
```

### 现象5：自研 Operator 无限循环

#### 根因（已在问题8详细分析）

```text
核心错误：
  1. 创建 ConfigMap 后立即返回 nil，没等 Cache 同步
  2. 下次 Reconcile 读 Cache 看到 CM 不存在，再次创建
  3. 但 etcd 中 CM 已存在 → 409 AlreadyExists
  4. 错误被吞，但 Status 更新触发 Watch 事件
  5. Watch 事件触发 Reconcile，无限循环

  本质：Reconcile 不幂等 + Cache 滞后 + 错误吞没
```

#### 防御方案（已在问题8详细分析）

```text
核心修复：
  1. 严格幂等：先查再创建 / 更新
  2. 创建 / 更新后立即 requeue，等 Cache 同步
  3. 用 APIReader 直接读 API Server，绕过 Cache 滞后
  4. 严格错误处理：返回 error 触发退避
  5. 监控 NumRequeues，超阈值告警
```

---

## 六、与往周专题的衔接

### 6.1 与"分布式一致性协议（Raft）"专题的衔接

```text
第3周深挖了 Raft 协议，本周深挖 K8s 调谐循环，二者关系：

  - etcd 内部用 Raft 协议保证多副本一致性
    * 写入需要多数派确认
    * Leader 选举 / 日志复制 / 快照
  - K8s 控制面用 List-Watch + Reconcile 保证"最终一致"
    * 不是 Raft 的"强一致"
    * 而是"最终一致"
    * 多个 Controller 缓存可能短暂不一致

  为什么 K8s 不用 Raft 直接做"对象层强一致"：
  - etcd 已经是强一致的（Raft + etcd）
  - K8s API Server 是 etcd 的"应用层代理"
  - Controller 是"应用层逻辑"，可以异步处理
  - 强一致 + 同步处理会牺牲可用性（CAP）

  K8s 的 CAP 取舍：
  - CP（一致性 + 分区容忍）优先：etcd 是 CP 系统
  - 但应用层（Controller）是 AP（可用性 + 分区容忍）
  - 分区时 Controller 仍可工作（用本地缓存）
  - 分区恢复后通过 resync 收敛

  衔接认知：
  - Raft 是"协议层一致性"
  - K8s 调谐循环是"应用层最终一致性"
  - 二者叠加，构成 K8s 的"分层一致性模型"
```

### 6.2 与"分布式事务"专题的衔接

```text
第4周深挖了分布式事务，本周的 K8s 调谐循环也涉及"分布式事务"问题：

  - 一个 Deployment 滚动发布涉及多个对象：
    * Deployment（spec.replicas: 3 → 5）
    * ReplicaSet（旧 RS 3 副本 → 0，新 RS 0 → 5）
    * Pod（旧 Pod 删除，新 Pod 创建）
    * Endpoints（更新 Pod 列表）
    * ConfigMap（如果配置变更）
  - 这些对象分布在 etcd 不同 key，无法用单机事务
  - K8s 通过"调谐循环 + 乐观锁"实现"最终一致"
  - 中间状态：旧 RS 还在删，新 RS 已开始创建，Pod 数量暂时 > 5
  - 最终收敛：旧 RS = 0，新 RS = 5，Pod = 5

  与传统分布式事务的差异：
  - 传统：2PC / TCC / Saga，强一致或补偿
  - K8s：Reconcile Loop + 乐观锁，最终一致
  - K8s 选择最终一致的原因：
    * 微服务场景下，强一致代价过高
    * 用户可接受"几秒钟的不一致"
    * 调谐循环天然容错（重启自动收敛）

  衔接认知：
  - 啄木鸟钱包的 TCC 分布式事务（强一致）
  - K8s 控制面的 Reconcile Loop（最终一致）
  - 二者互补：业务强一致用 TCC，集群治理用 Reconcile
```

### 6.3 与"消息队列最终一致性"专题的衔接

```text
第4周深挖了"分布式事务与消息最终一致性"，K8s 的 List-Watch 机制也是"消息最终一致性"：

  - etcd Watch 类似 MQ 的"消息订阅"
  - List + Watch 类似 MQ 的"全量拉取 + 增量推送"
  - Delta FIFO 类似 MQ 的"消息队列"
  - Workqueue 类似 MQ 的"消费队列"
  - Requeue 类似 MQ 的"重试 + 死信"

  K8s Watch 与传统 MQ 的差异：
  - K8s Watch：server-sent events，长连接
  - 传统 MQ：AMQP / Kafka 协议，broker 中转
  - K8s Watch 不持久化（断线丢消息）
  - 传统 MQ 持久化（断线不丢）

  K8s 的"消息可靠性"机制：
  - resync 兜底（类似 MQ 的"重放"）
  - List + Watch 续传（类似 MQ 的"offset 续传"）
  - Workqueue 持久（类似 MQ 的"消息确认"）

  衔接认知：
  - 啄木鸟业务的 Kafka 消息最终一致性
  - K8s 控制面的 Watch + Reconcile 最终一致性
  - 二者工程思想一致：通过消息驱动状态收敛
```

### 6.4 与"Nacos Distro 协议"专题的衔接

```text
第5周深挖了 Nacos Distro 协议（AP 一致性），K8s 调谐循环也涉及"AP 一致性"：

  - Nacos Distro：节点对等 + gossip 同步 + 最终一致
  - K8s Controller：Informers + Workqueue + Reconcile + 最终一致

  差异：
  - Nacos Distro 是"节点间对等同步"
  - K8s Controller 是"中心式（API Server）+ 客户端缓存"
  - Nacos Distro 适合"服务发现"场景
  - K8s Controller 适合"配置治理"场景

  共同点：
  - 都是"最终一致"
  - 都通过"周期性 resync"兜底
  - 都用"版本号"做续传
  - 都容忍"短期不一致"

  衔接认知：
  - 业务侧用 Nacos（服务发现 + 配置中心）
  - 集群侧用 K8s（Pod + Service + ConfigMap）
  - 二者一致性模型互补
```

### 6.5 与"InnoDB 锁机制"专题的衔接

```text
第6月第1周深挖了 InnoDB 锁机制，K8s 用 resourceVersion 做乐观锁，与 InnoDB 锁有差异：

  InnoDB 锁：
  - 行锁（共享锁 / 排他锁）
  - 间隙锁 / Next-Key Lock
  - 悲观锁（先锁后改）
  - 死锁检测

  K8s resourceVersion：
  - 乐观锁（先改后校验）
  - CAS 模式
  - 失败重试
  - 无死锁风险

  为什么 K8s 不用悲观锁：
  - Controller 长时间处理（秒级），悲观锁会阻塞其他 Controller
  - 悲观锁需要"锁服务"（如 etcd lease），增加复杂度
  - 大部分场景下"乐观锁 + 重试"性能更好

  衔接认知：
  - 数据库用悲观锁（强一致 + 短事务）
  - K8s 用乐观锁（最终一致 + 长事务）
  - 二者按场景选择
```

### 6.6 与"ES 写入链路"专题的衔接

```text
第6月第3周深挖了 ES 写入链路（primary + replica + translog + refresh），K8s 调谐循环也涉及"写入链路"：

  ES 写入链路：
  - 客户端写入 → primary → translog → replica → refresh
  - 同步 + 异步混合
  - 强一致（primary + replica 都成功才返回）

  K8s 写入链路：
  - 客户端写入 → API Server → etcd（Raft 多数派） → 返回
  - Controller Watch → Indexer 更新 → Reconcile
  - 同步写 + 异步调谐

  差异：
  - ES 写入是"用户感知的强一致"
  - K8s 写入是"API Server 强一致 + Controller 最终一致"
  - ES 副本是"数据冗余"
  - K8s Controller 缓存是"读加速 + 异步处理"

  衔接认知：
  - 数据写入用 ES（强一致 + 高吞吐）
  - 集群治理用 K8s（最终一致 + 调谐循环）
```

### 6.7 与"Sentinel 滑动窗口 LeapArray"专题的衔接

```text
第6月第4周深挖了 Sentinel LeapArray 滑动窗口，K8s Workqueue 也有"限流"机制：

  Sentinel LeapArray：
  - 滑动窗口 + 时间桶
  - 实时统计 QPS
  - 自适应限流

  K8s Workqueue 限流：
  - BucketRateLimiter（令牌桶）
  - ItemExponentialFailureRateLimiter（指数退避）
  - 防止 Controller 雪崩 API Server

  差异：
  - Sentinel 限流是"业务流量保护"
  - K8s 限流是"控制面保护"
  - Sentinel 自适应（根据负载动态调整）
  - K8s 静态配置（默认 10 qps）

  衔接认知：
  - 业务层限流用 Sentinel
  - 控制面限流用 K8s Workqueue
  - 二者分层保护
```

### 6.8 与"支付幂等性"专题的衔接

```text
第6月第5周深挖了支付幂等性，K8s Reconcile 也要求"幂等"：

  支付幂等性：
  - 同一支付单多次提交结果一致
  - 通过幂等键 + 状态机实现
  - 防止"重复扣款"

  K8s Reconcile 幂等性：
  - 同一 key 多次 Reconcile 结果一致
  - 通过"先查再创建 / 更新"实现
  - 防止"重复创建子资源"

  共同点：
  - 都要求"幂等"
  - 都通过"状态机 + 乐观锁"实现
  - 都有"重试 + 退避"机制

  衔接认知：
  - 业务幂等用支付幂等性方案
  - 集群治理幂等用 K8s Reconcile 方案
  - 二者工程思想一致
```

### 6.9 与"医保结算四防闭环"专题的衔接

```text
第7月第1周深挖了医保结算四防闭环（防重复 / 防超时 / 防并发 / 防错账），K8s 调谐循环也有类似"四防"：

  K8s 调谐循环四防：
  - 防事件丢失：resync 兜底
  - 防雪崩：Workqueue 限流 + 退避
  - 防并发：Workqueue 串行（同一 key）
  - 防状态发散：Reconcile 幂等 + 乐观锁

  衔接认知：
  - 业务侧四防（医保结算）
  - 集群治理四防（K8s 调谐循环）
  - 二者都是"工程闭环"思想
```

### 6.10 与"EMPI 错配修复"专题的衔接

```text
第7月第2周深挖了 EMPI 错配修复工程闭环，K8s 调谐循环也涉及"错配修复"：

  EMPI 错配修复：
  - 串档（错误合并）→ 拆分 + 数据迁移
  - 错配（错误拆分）→ 合并 + 数据迁移
  - 双向验证 + 人工兜底

  K8s 调谐循环：
  - 状态发散（Controller 错误调谐）→ 自动收敛（resync + Reconcile）
  - 错误配置（用户错误 YAML）→ 告警 + 人工介入
  - 调谐循环 + 监控告警

  共同点：
  - 都需要"自动修复 + 人工兜底"
  - 都需要"监控告警"
  - 都需要"工程闭环"

  衔接认知：
  - 业务数据错配用 EMPI 修复方案
  - 集群状态错配用 K8s 调谐方案
  - 二者都是"工程闭环"思想
```

---

## 七、能力差距梳理

### 差距1：client-go 源码阅读深度不足
> Day7发现

- **现状**：知道 Informer / Workqueue / Indexer 的概念，但 client-go 的 Reflector / Delta FIFO / SharedInformer 源码没精读，遇到生产问题只能查日志，不能从源码层面定位
- **架构师水平**：能精读 client-go 源码，理解 List-Watch / Delta FIFO / Workqueue 的内部实现，能基于源码定位生产问题（如 workqueue depth 异常、List 慢、Watch 中断）
- **补足方向**：
  - 精读 client-go `tools/cache/` 目录（reflector.go / delta_fifo.go / index.go / shared_informer.go）
  - 精读 client-go `util/workqueue/` 目录（delaying_queue.go / rate_limiting_queue.go）
  - 在啄木鸟云健康测试集群构造"Watch 中断 + re-list"场景，观察 Controller 行为

### 差距2：自研 Operator 实战经验不足
> Day7发现，延续第2周差距4.1（StatefulSet + Operator）、第2周差距4.6（Day02 Operator）

- **现状**：写过简单的 Operator（创建 ConfigMap / Secret），但复杂 Operator（多 CRD 联动 / Webhook / Finalizer / 状态机）没实战过，遇到无限循环（现象5）只能试错
- **架构师水平**：能基于 controller-runtime + Kubebuilder 设计生产级 Operator，包含 CRD / Webhook / Finalizer / Leader 选举 / metrics / 健康检查 / 状态机
- **补足方向**：
  - 学习 KubeBuilder Book（官方文档）
  - 研读 Strimzi Kafka Operator / Redis Operator 源码
  - 在啄木鸟云健康测试集群自研"医疗影像 AI 推理 Operator"，覆盖 CRD + Webhook + Finalizer + 状态机

### 差距3：Controller 性能调优实战不足
> Day7发现

- **现状**：知道 workqueue_depth / reconcile_duration 等指标，但没做过 Controller 性能调优（worker 数 / 限流 / List 加速），没处理过 workqueue 积压
- **架构师水平**：能基于 metrics（workqueue_depth / reconcile_duration / list_duration）定位 Controller 性能瓶颈，能调参（worker 数 / 限流 / cache size）优化吞吐
- **补足方向**：
  - 学习 K8s Controller Metrics 体系
  - 在测试集群构造 10w+ Pod 场景，压测 Controller 性能
  - 调参 worker 数 / 限流，观察 workqueue_depth 变化

### 差距4：List-Watch 与 etcd Watch 的衔接认知不深
> Day7发现，延续第3周差距1.2（etcd 备份恢复）

- **现状**：知道 List-Watch 是 K8s 的"事件分发"机制，但 etcd Watch 的底层（revision / compaction / mvcc）不深
- **架构师水平**：能讲清 etcd Watch → API Server cacher → Controller Reflector 的完整链路，能基于 etcd metrics（etcd_watcher_changes / etcd_storage_objects）诊断 List-Watch 问题
- **补足方向**：
  - 学习 etcd MVCC 实现（revision / compaction）
  - 学习 API Server cacher 实现（watch cache / ring buffer）
  - 复盘啄木鸟云健康集群（如有）的 etcd 监控

### 差距5：Reconcile Loop 与分布式系统理论的衔接认知不深
> Day7发现，延续第3周差距（Raft）

- **现状**：知道 Reconcile Loop 是"最终一致"，但与 CAP / Raft / Paxos 等分布式系统理论的衔接不深
- **架构师水平**：能讲清"声明式 API + 调谐循环 + 乐观锁"在分布式系统理论中的位置，能对比"Raft 强一致"vs"Reconcile 最终一致"的工程取舍
- **补足方向**：
  - 学习"Designing Data-Intensive Applications"第5章（复制）
  - 学习 K8s 设计哲学（声明式 API / 最终一致性 / 控制循环）
  - 对比 K8s 调谐循环与 Lambda Architecture / Event Sourcing / CQRS

### 差距6：Controller 故障排查体系化不足
> Day7发现，延续第1周差距2.4（K8s 故障排查）

- **现状**：能查 Controller 日志，但 workqueue 积压 / List 慢 / Watch 中断 / resync 异常等高频故障的体系化排查不熟
- **架构师水平**：能建立 Controller 故障排查手册（按现象 → 原因 → 诊断 → 处理流程化），能基于 metrics（workqueue_depth / reconcile_duration / list_duration）定位问题
- **补足方向**：
  - 整理 Controller 常见故障案例库（workqueue 积压 / List 慢 / Watch 中断 / resync 异常）
  - 学习 `kubectl get --raw /metrics` 抓取 Controller 指标
  - 复盘历史故障形成 SOP

### 差距7：CRD 设计经验不足
> Day7发现，延续第2周差距4.1（Operator）

- **现状**：写过简单 CRD（一个 spec + 一个 status），但复杂 CRD（多版本 + Webhook + 子资源 + status 子资源 + printer columns）没设计过
- **架构师水平**：能设计生产级 CRD，包含 v1alpha1 / v1beta1 / v1 多版本兼容、Webhook 校验与默认值、status 子资源、printer columns、additionalPrinterColumns、x-kubernetes-list-type
- **补足方向**：
  - 学习 CRD 官方文档（apiextensions.k8s.io）
  - 研读 Strimzi Kafka CRD（Kafka / KafkaConnect / KafkaTopic 等多 CRD 联动）
  - 在啄木鸟云健康设计"医疗影像 AI 推理"CRD，覆盖多版本 + Webhook + 子资源

### 差距8：Webhook 实战经验不足
> Day7发现

- **现状**：知道 MutatingWebhook / ValidatingWebhook 的概念，但没自研过 Webhook，没处理过 Webhook 故障（Webhook 挂了 → 集群瘫痪）
- **架构师水平**：能自研 Webhook（Mutating + Validating），能配置 failurePolicy（Fail / Ignore），能设计 Webhook 高可用（多副本 + PDB）
- **补足方向**：
  - 学习 admissionregistration.k8s.io 官方文档
  - 自研一个 MutatingWebhook（如自动注入 Sidecar）
  - 研究 Webhook 故障场景（如 Webhook 挂了导致 Pod 创建失败）

### 差距9：Finalizer 与优雅删除实战不足
> Day7发现

- **现状**：知道 Finalizer 的概念，但没实战过，遇到"CR 删除但卡住"只能等
- **架构师水平**：能为 CRD 设计 Finalizer，处理外部资源清理（如删除外部数据库、清理云厂商资源），能基于 Finalizer 设计"CR 删除前清理"流程
- **补足方向**：
  - 学习 controller-runtime 的 Finalizer 模式
  - 自研 Operator 加 Finalizer（如清理外部 Redis 资源）
  - 研究"CR 卡住 Terminating"的排查方法

### 差距10：Leader 选举与多副本 Controller 实战不足
> Day7发现，延续第1周差距1.3（Leader 选举机制）

- **现状**：知道 Controller 用 Leader 选举，但 Lease 资源的字段含义、续约机制、切换时间窗口不深
- **架构师水平**：能配置 Leader 选举（leaseDuration / renewDeadline / retryPeriod），能基于 controller-runtime 实现自定义 Leader 选举，能监控 Leader 切换事件
- **补足方向**：
  - 学习 client-go leader-election 库
  - 在测试集群验证 Leader 选举切换行为
  - 监控 Leader 切换事件，告警异常切换

---

## 八、本周总结

### 8.1 本周学习路径

```text
Day01（K8s 核心架构 + Pod 模型）：
  打下"控制面 + 数据面 + Pod 容器设计模式"地基
  → 关键命题：K8s 是"声明式 API + 最终一致性"

Day02（Workload + 发布工程）：
  打下"五件套 Workload + 滚动发布"支柱
  → 关键命题：Deployment Controller + ReplicaSet Controller + Pod 调谐循环

Day03（Service + 网络模型）：
  打下"Service 转发 + CNI + DNS + NetworkPolicy"支柱
  → 关键命题：EndpointSlice Controller + kube-proxy watch Service

Day04（存储卷 + 配置管理）：
  打下"PV/PVC + CSI + ConfigMap/Secret"支柱
  → 关键命题：PV Controller + AttachDetach Controller + CSI 调用链路

Day05（调度 + 资源管理）：
  打下"调度约束 + 资源管理 + 多租户隔离"支柱
  → 关键命题：kube-scheduler Filter/Score + ResourceQuota Controller

Day06（串联整合）：
  把五大支柱串成"云原生智慧医疗平台 K8s 全链路架构设计"工程闭环
  → 关键命题：K8s 五大支柱协同 + 医疗监管合规 + 多租户隔离

Day07（架构深挖）：
  深挖"K8s 声明式调谐循环 + Informer 底层原理"
  → 关键命题：声明式 API + List-Watch + Informer + Workqueue + Reconcile Loop
```

### 8.2 本周核心架构师思维跃迁

```text
跃迁1：从"我会写 K8s YAML"到"我能讲清 K8s 调谐循环底层"

  - 不再停留在"apply Deployment → Pod 创建"的表面
  - 能讲清 Deployment Controller → ReplicaSet Controller → Pod 创建 → kubelet 启动 → Endpoints 更新的完整链路
  - 能讲清 List-Watch / Informer / Workqueue / Reconcile Loop 的底层机制

跃迁2：从"我用 K8s"到"我能设计 K8s 风格的控制系统"

  - 不再停留在"用 K8s 部署业务"
  - 能基于声明式 API + 调谐循环设计自研控制系统
  - 能把"分布式系统理论（CAP / Raft / 最终一致）"与"K8s 工程实践"结合

跃迁3：从"我自研 Operator"到"我能设计生产级 Operator"

  - 不再停留在"简单 Operator（创建 ConfigMap）"
  - 能设计 CRD + Webhook + Finalizer + 状态机的复杂 Operator
  - 能基于 controller-runtime / Kubebuilder 工程化交付

跃迁4：从"我会排查 K8s 故障"到"我能建立 K8s 故障排查体系"

  - 不再停留在"kubectl describe / logs"
  - 能基于 metrics（workqueue_depth / reconcile_duration / list_duration）定位问题
  - 能建立 K8s Controller 故障排查 SOP
```

### 8.3 本周与往周专题的衔接

```text
第3周（CAP / Raft）：
  - Raft 是"协议层强一致"
  - K8s 调谐循环是"应用层最终一致"
  - 二者叠加，构成 K8s 分层一致性模型

第4周（分布式事务 / 消息最终一致性）：
  - 业务强一致用 TCC / Saga
  - 集群治理用 Reconcile Loop（最终一致）
  - 二者按场景选择

第5周（微服务 / Nacos）：
  - Nacos Distro 是"节点间对等同步"
  - K8s Controller 是"中心式 + 客户端缓存"
  - 二者互补

第6月第1周（MySQL / InnoDB 锁）：
  - InnoDB 用悲观锁（行锁 + 间隙锁）
  - K8s 用乐观锁（CAS + resourceVersion）
  - 二者按场景选择

第6月第2周（Redis / 秒杀库存一致性）：
  - 业务幂等用支付幂等性方案
  - 集群治理幂等用 K8s Reconcile 方案
  - 二者工程思想一致

第6月第3周（ES）：
  - ES 写入是"用户感知强一致"
  - K8s 写入是"API Server 强一致 + Controller 最终一致"
  - 二者按场景选择

第6月第4周（限流降级 / Sentinel）：
  - 业务限流用 Sentinel
  - 控制面限流用 K8s Workqueue
  - 二者分层保护

第6月第5周（支付幂等性）：
  - 业务幂等用支付幂等性方案
  - 集群治理幂等用 K8s Reconcile 方案
  - 二者工程思想一致

第7月第1周（医保结算四防闭环）：
  - 业务四防（医保结算）
  - 集群治理四防（K8s 调谐循环：防事件丢失 / 防雪崩 / 防并发 / 防状态发散）
  - 二者都是"工程闭环"思想

第7月第2周（EMPI 错配修复）：
  - 业务数据错配用 EMPI 修复方案
  - 集群状态错配用 K8s 调谐方案
  - 二者都是"工程闭环"思想
```

### 8.4 下周（2026年07月第4周）预告

```text
本周完成了 K8s 与云原生专题，下周建议方向：

候选1：Service Mesh 与 Istio 专题
  - Istio 架构（Control Plane / Data Plane）
  - Envoy Filter Chain / Listener / Route
  - 流量治理（VirtualService / DestinationRule）
  - 安全（mTLS / AuthorizationPolicy）
  - 可观测性（Kiali / Jaeger）
  - 衔接本周 K8s（Sidecar 模式）+ 第5周（微服务）

候选2：CI/CD 与 GitOps 专题
  - ArgoCD / Flux 工作原理
  - GitOps 发布流程
  - 多环境发布（ApplicationSet）
  - Argo Rollouts 金丝雀
  - 衔接本周 K8s（Day02 发布工程）

候选3：可观测性与云原生监控专题
  - Prometheus / Thanos / Mimir
  - Grafana / Loki / Tempo
  - OpenTelemetry
  - Service Mesh 可观测性
  - 衔接本周 K8s + 第5周微服务

候选4：服务端工程深水区专题
  - Netty / Reactor 模式
  - 协程 / Virtual Thread
  - 异步编程 / CompletableFuture / Mono
  - 衔接用户 IM 在线客服 / 医疗在线问诊长连接业务
```

按 CLAUDE.md 出题优先级（用户业务相关 > 面试高频 > 前序延伸 > 进阶主题），建议下周做 **Service Mesh 与 Istio 专题**：
1. 用户业务相关：啄木鸟云健康智慧体检 + 互联网医院都涉及微服务治理
2. 面试高频：Istio / Envoy 是中高级架构师岗必问
3. 前序延伸：本周 K8s（Day03 Service Mesh 衔接）+ 第5周微服务（Nacos / Sentinel 对比）
4. 进阶主题：Service Mesh 是云原生架构师必备能力

---

## 九、今日复盘

### 9.1 知识点掌握度自评

```text
声明式 API / 调谐循环：★★★★★（架构师水平）
List-Watch 协议：★★★★☆（架构师水平，etcd revision 底层待深入）
Informer / Reflector / Delta FIFO / Indexer：★★★★☆（架构师水平，源码待精读）
Workqueue 限速退避：★★★★☆（架构师水平，自定义限速器待实战）
Reconcile Loop 模式：★★★★☆（架构师水平，复杂状态机待实战）
resourceVersion 乐观锁：★★★★★（架构师水平）
Controller 重启状态恢复：★★★★☆（架构师水平，启动期 List 优化待实战）
自研 Operator：★★★☆☆（中高级水平，复杂 Operator 待实战）
Controller 故障排查：★★★☆☆（中高级水平，体系化 SOP 待建立）
```

### 9.2 重点学习材料

```text
官方文档：
  - K8s Controller 机制（kubernetes.io/docs/concepts/architecture/controller/）
  - client-go Informer（kubernetes.io/docs/concepts/overview/components/#kube-controller-manager）
  - Kubernetes API Conventions（github.com/kubernetes/community/blob/master/contributors/devel/sig-architecture/api-conventions.md）

源码：
  - client-go/tools/cache/（reflector.go / delta_fifo.go / index.go / shared_informer.go）
  - client-go/util/workqueue/（delaying_queue.go / rate_limiting_queue.go）
  - kube-controller-manager（kubernetes.io/cmd/kube-controller-manager）
  - controller-runtime（sigs.k8s.io/controller-runtime）

书籍：
  - 《Kubernetes in Action》- Marko Lukša
  - 《Programming Kubernetes》- Michael Hausenblas, Stefan Schimanski
  - 《Designing Data-Intensive Applications》- Martin Kleppmann

实践：
  - 自研 Operator（Kubebuilder 脚手架）
  - 复盘生产故障（workqueue 积压 / List 慢 / Watch 中断）
  - 阅读 Strimzi Kafka Operator / Redis Operator 源码
```

### 9.3 下周计划

```text
1. 完成 2026年07月第3周（K8s 与云原生专题）：
  - 已完成 Day01-Day07（含串联整合 + 架构深挖）
  - 整理本周能力差距到"能力差距梳理.md"

2. 启动 2026年07月第4周（候选 Service Mesh 与 Istio 专题）：
  - Day01：Istio 架构与 Envoy 数据面
  - Day02：流量治理（VirtualService / DestinationRule）
  - Day03：安全（mTLS / AuthorizationPolicy）
  - Day04：可观测性（Kiali / Jaeger / Prometheus）
  - Day05：实战综合（医疗平台 Service Mesh 落地）
  - Day06：串联整合
  - Day07：架构深挖（Envoy Filter Chain / xDS 协议）
```

---

**今日深挖要点回顾**：

```text
1. 声明式 API + 最终一致性 + 调谐循环 = K8s 控制面心脏
2. List-Watch = List 全量 + Watch 增量 + Re-List 异常恢复 + resync 兜底
3. Informer / Reflector / Delta FIFO / Indexer 四大组件协作
4. Workqueue 持久 + 去重 + 限速 + 退避，保护 API Server
5. Reconcile Loop 必须"无状态 + 幂等 + 乐观锁 + 失败 requeue"
6. resourceVersion = etcd revision，全局递增，用于 CAS 与 Watch 续传
7. Controller 重启后通过 List + Watch 续传 + resync 兜底恢复
8. 自研 Operator 必须避开"不幂等 / 吞错误 / 不带 OwnerReference / worker 过多 / 不带 FieldSelector / 缓存未同步"陷阱
```

**架构师思维核心**：

```text
从"我会用 K8s"到"我能设计 K8s 风格的分布式控制系统"
从"我会写 Operator"到"我能设计生产级 Operator（CRD + Webhook + Finalizer + 状态机）"
从"我会排查 K8s 故障"到"我能基于 metrics 建立故障排查 SOP"
从"我知道声明式 API"到"我能讲清声明式 API 在分布式系统理论中的位置"
```

这是 K8s 架构师 vs 中高级工程师的分水岭。
