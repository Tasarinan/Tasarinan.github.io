# 架构师学习-Day03-Service 与网络模型

> 日期：2026年07月22日（周三）
> 周主题：K8s 与云原生专题
> 出题日：Day03 - Service 与网络模型

---

## 背景

Day01 我们打了"K8s 核心架构 + Pod 容器设计模式"两根地基，回答了"K8s 由什么组成"和"Pod 为什么是最小调度单位"。Day02 我们打了"Workload 编排 + 发布工程"两根支柱，回答了"Pod 怎么被编排成可运维的业务系统"和"怎么零宕机发布"。

但到这里我们刻意回避了一个核心问题：**Pod IP 是易碎的，Pod 重建 IP 就变，业务之间怎么稳定通信？外部流量怎么进来？**

为什么 Day03 必须接着讲 Service 与网络模型：

1. **业务现实**：啄木鸟云健康的体检预约服务日均 50w+ 订单，多副本 Pod 之间的负载均衡、外部 HTTPS 流量入口、跨 Namespace 的服务调用、医保接口的安全审计 -- 任何一跳出问题就是订单丢失 + 监管事故。Day02 解决了"Pod 怎么发布"，Day03 必须解决"流量怎么进来 + Pod 之间怎么互访"

2. **承接往周专题**：
   - 微服务专题的"Nacos 服务发现 + LoadBalancer 软负载" -> K8s 的 Service + Endpoints + kube-proxy（**K8s 把服务发现下沉到基础设施**）
   - 限流降级专题的"Sentinel 集群限流 + 网关限流" -> K8s 的 Ingress 限流 + Service Mesh 全局限流（**限流可以下沉到 Ingress 和 Sidecar**）
   - 支付专题的"幂等 + 多可用区容灾" -> K8s 的 Service `topologyAwareHints` + 跨 AZ Endpoints（**流量按拓扑路由，降低跨 AZ 费用 + 提高容灾**）
   - 医疗专题的"互联网医院多医院隔离 + 监管合规" -> K8s 的 Namespace + NetworkPolicy（**网络层原生多租户隔离**）
   - Redis 专题的"主从复制 + 哨兵" -> K8s 的 Headless Service + StatefulSet 稳定标识（**客户端能稳定找到 redis-0 主节点**）

3. **面试高频考点**：Service 五种类型、ClusterIP 为什么是"虚拟 IP"、iptables vs ipvs 本质差异、EndpointSlice 为什么取代 Endpoints、Ingress 与 Ingress Controller 关系、CoreDNS 解析链路、ndots:5 陷阱、CNI Overlay vs BGP、NetworkPolicy default-deny -- 中高级架构师岗几乎必问

4. **架构师思维跃迁**：从"我会写 Service YAML"到"我能在 K8s 上设计多租户隔离 + 流量治理 + 灰度发布 + 安全合规的网络架构，并能定位 DNS 慢、kube-proxy 规则爆炸、NodePort SNAT 丢客户端 IP 等线上疑难杂症"

Day03 我们打两根支柱：

- **题目一（架构设计题）**：Service 与 kube-proxy 转发原理 -- 解决"Service 为什么能稳定路由到易碎的 Pod、ClusterIP 凭什么能转发、kube-proxy iptables vs ipvs 怎么选、客户端 IP 怎么保留"
- **题目二（架构设计题）**：Ingress + CNI + CoreDNS + NetworkPolicy 综合设计 -- 解决"外部流量怎么进、Pod 之间怎么走、DNS 怎么解析、多医院怎么隔离"

---

## 题目一（架构设计题）：Service 与 kube-proxy 转发原理

假设你作为新公司的架构师，负责啄木鸟云健康智慧体检平台在 K8s 上的网络层设计。平台包含：

- 体检预约 Web 服务（10+ 副本，外部 HTTPS 入口）
- 体检报告服务（内部服务，被预约服务调用）
- 医保接口代理服务（需要保留客户端真实 IP 给医保局审计）
- Redis Cluster（6 节点，3 主 3 从，内部服务）

请你回答：

1. K8s Service 有哪几种类型（ClusterIP / NodePort / LoadBalancer / ExternalName / Headless）？分别解决什么场景？为什么不能用 Pod IP 直接通信？Service 与 Endpoints / EndpointSlice 的关系？EndpointSlice 控制器在做什么，为什么 K8s 1.21+ 要用 EndpointSlice 取代 Endpoints？
2. 一个 Pod 访问 `http://report-svc.health.svc.cluster.local/api/report/123` 在集群内的完整链路是什么？从 CoreDNS 解析到 ClusterIP、到 iptables/ipvs DNAT、到 Pod IP，每一跳发生了什么？为什么 ClusterIP 是"虚拟 IP"但能转发？kube-proxy 在其中的角色？为什么 ping ClusterIP 不通但 curl 通？
3. kube-proxy 的 iptables 模式与 ipvs 模式本质差异？规则数量随 Service / Endpoint 规模的复杂度？为什么大集群必须用 ipvs？iptables 模式的"概率随机"是怎么实现的，陷阱是什么？ipvs 的调度算法（rr / wrr / lc / sh）分别适合什么场景？
4. Service 的会话保持（sessionAffinity）、流量策略（externalTrafficPolicy / internalTrafficPolicy）、客户端 IP 保留怎么做？为什么 NodePort 默认会 SNAT 导致后端看不到真实客户端 IP？什么场景必须保留客户端 IP（如医保审计、风控、限流按 IP）？保留客户端 IP 的代价是什么？
5. 请为啄木鸟云健康 4 个子系统分别选择最合适的 Service 类型，给出关键 YAML 配置片段（类型 / 端口 / 流量策略 / 会话保持 / 注解），并解释每个选择的工程理由。如果体检预约服务要做"灰度发布 + 蓝绿切换 + 故障隔离"，Service 层该如何配合？

### 作答区

#### 1. Service 五种类型与 Endpoints/EndpointSlice

**核心一句话**：Service = "稳定的虚拟 IP + 域名 + 负载均衡"，把易碎的 Pod IP 抽象成稳定的访问入口，本质是"用对象存储的 Service -> Pod IP 列表映射，配合 kube-proxy 在节点上维护转发规则"。

**五种 Service 类型**：

| 类型 | clusterIP | 用途 | 典型场景 | 是否四层 |
|------|-----------|------|---------|---------|
| ClusterIP | 分配 VIP | 集群内访问 | 内部微服务互相调用 | 是（L4） |
| NodePort | 分配 VIP + 暴露节点端口（30000-32767） | 集群外访问（暴露到节点 IP:Port） | 自建 LB 后端、临时暴露 | 是（L4） |
| LoadBalancer | 分配 VIP + NodePort + 云厂商 LB | 云上对外暴露 | 云上生产对外服务（阿里云 SLB / AWS ELB） | 是（L4） |
| ExternalName | None（CNAME 解析） | 集群内访问外部域名（不走 kube-proxy） | 把外部服务封装成集群内 Service 名 | 否（DNS CNAME） |
| Headless（clusterIP: None） | None | 直接返回 Pod IP 列表 | StatefulSet（Redis/ZK/Kafka）、客户端需要直接连特定 Pod | 否（DNS A 记录） |

**为什么不能用 Pod IP 直接通信**：

1. **Pod IP 易碎**：Pod 重建（滚动更新、节点宕机、OOM 重启）后 IP 必变。代码里写死 Pod IP = 每次发布都要改配置
2. **Pod IP 多副本**：10 个 Pod 副本，客户端怎么选？自己实现负载均衡？K8s 已经在 Service 层做了
3. **Pod IP 跨节点不可路由**：CNI Overlay 模式下 Pod IP 是私网 IP，跨节点靠隧道；直接写 Pod IP 在跨 Namespace / 跨集群场景不可达
4. **滚动发布期间 Pod IP 在变**：Day02 讲过，滚动更新期间新老板本共存，客户端必须能动态感知后端列表变化

**Service 与 Endpoints / EndpointSlice 的关系**：

```
┌─────────────────────────────────────────────────────────────┐
│  Service（抽象层：稳定 VIP + 域名 + 选择器）                  │
│  - spec.clusterIP: 10.96.10.23                              │
│  - spec.selector: { app: report }                           │
│  - ports: [{ port: 80, targetPort: 8080 }]                  │
└─────────────────────────────────────────────────────────────┘
                 ▲
                 │ watch Service + Pod
                 │
┌─────────────────────────────────────────────────────────────┐
│  EndpointSlice 控制器（kube-controller-manager 内）           │
│  - watch Service 变化                                         │
│  - watch Pod 变化（按 selector 过滤 + readinessProbe 通过）   │
│  - 维护 Service -> Pod IP 列表的映射                          │
└─────────────────────────────────────────────────────────────┘
                 │
                 │ 写 EndpointSlice 对象到 etcd
                 ▼
┌─────────────────────────────────────────────────────────────┐
│  EndpointSlice（数据层：实际后端 Pod IP 列表）                 │
│  - addressType: IPv4                                         │
│  - endpoints:                                                │
│    - [10.244.1.23, 10.244.2.45, 10.244.3.12, ...]           │
│  - 每切片最多 100 个 endpoint（默认 maxEndpointsPerSlice=100）│
└─────────────────────────────────────────────────────────────┘
                 ▲
                 │ watch EndpointSlice
                 │
┌─────────────────────────────────────────────────────────────┐
│  kube-proxy（每个节点）                                       │
│  - watch EndpointSlice 变化                                   │
│  - 更新 iptables / ipvs 规则：ClusterIP -> [PodIP1, ...]     │
└─────────────────────────────────────────────────────────────┘
```

**Endpoints vs EndpointSlice**：

| 维度 | Endpoints（旧） | EndpointSlice（新，1.21+ 默认） |
|------|----------------|------------------------------|
| 单对象容量 | 一个 Service 一个 Endpoints 对象，所有 Pod IP 都在一个对象 | 一个 Service 多个 EndpointSlice 对象，每片最多 100 IP |
| watch 长尾 | 一个 Pod IP 变化 = 整个 Endpoints 对象重新发给所有 watcher | 只发变化的 slice，watcher 流量小 |
| 网络协议 | 仅 IPv4/IPv6 | IPv4/IPv6/FQDN 多协议 |
| 拓扑感知 | 无 | 有 topologyHints（按 zone/region 分布提示） |
| 大集群表现 | 5000 Pod 的 Service，Endpoints 对象几百 KB，watch 风暴 | 切片后单对象小，watch 流量分散 |
| 默认启用 | 1.21 之前 | 1.21+ 默认 |

**为什么 EndpointSlice 取代 Endpoints**：

1. **watch 放大效应**：大集群中 kube-proxy、coredns、Istio 等都 watch Endpoints。一个 Pod IP 变化，整个 Endpoints 对象（可能几 MB）推送给所有 watcher，网络/CPU 风暴
2. **对象大小限制**：etcd 默认单对象 1.5MB 上限，5000+ Pod 的 Service 单 Endpoints 对象会超限
3. **拓扑感知**：EndpointSlice 支持 topologyHints，配合 `externalTrafficPolicy: Local` 实现同 AZ 流量优先

**EndpointSlice 控制器的工作**：

- watch Service 变化：Service 创建/删除/selector 变化
- watch Pod 变化：Pod ready 状态变化（readinessProbe 通过才加入 endpoints）
- 把 Pod IP 按切片写入 EndpointSlice 对象（每片 100 IP 上限）
- 处理 Pod 优雅终止：Pod 删除时先从 endpoints 摘除，再等 `terminationGracePeriodSeconds` 让存量流量排空

#### 2. Pod 访问 Service 的完整链路

以 Pod A（10.244.1.10）访问 `http://report-svc.health.svc.cluster.local/api/report/123` 为例：

```
┌──────────────────────────────────────────────────────────────┐
│ 1. Pod A 发起请求                                              │
│    curl http://report-svc.health.svc.cluster.local/api/report/123│
└──────────────────────────────────────────────────────────────┘
                │
                │ 解析域名（先查 /etc/resolv.conf）
                │ nameserver 10.96.0.10 (CoreDNS ClusterIP)
                │ search: health.svc.cluster.local svc.cluster.local cluster.local
                │ options: ndots:5
                ▼
┌──────────────────────────────────────────────────────────────┐
│ 2. CoreDNS 解析                                                │
│    - 查 CoreDNS Plugin: kubernetes                            │
│    - report-svc.health.svc.cluster.local -> Service ClusterIP │
│    - 返回 10.96.10.23                                          │
└──────────────────────────────────────────────────────────────┘
                │
                │ TCP 连接 10.96.10.23:80
                ▼
┌──────────────────────────────────────────────────────────────┐
│ 3. Pod A 所在节点的 iptables/ipvs 规则匹配                     │
│    - PREROUTING / OUTPUT 链                                    │
│    - 匹配目的 IP = 10.96.10.23:80                              │
│    - DNAT 改写目的地址为 Pod IP（如 10.244.2.45:8080）         │
└──────────────────────────────────────────────────────────────┘
                │
                │ 数据包目的地址已改为 10.244.2.45:8080
                │ 通过 CNI 路由到目标节点
                ▼
┌──────────────────────────────────────────────────────────────┐
│ 4. Pod B（report-svc 的某个副本，10.244.2.45）收到请求         │
│    - 看到的源 IP 是 Pod A 的 IP（10.244.1.10）                │
│    - 业务处理，返回响应                                         │
└──────────────────────────────────────────────────────────────┘
                │
                │ 响应包源: 10.244.2.45:8080, 目的: 10.244.1.10:xxx
                ▼
┌──────────────────────────────────────────────────────────────┐
│ 5. 节点 iptables conntrack 反向 NAT                           │
│    - conntrack 记录了正向 NAT 映射                              │
│    - 反向改写源地址为 10.96.10.23:80                           │
│    - Pod A 收到的响应看上去就是 ClusterIP 回的                 │
└──────────────────────────────────────────────────────────────┘
```

**为什么 ClusterIP 是"虚拟 IP"但能转发**：

ClusterIP 是"虚拟 IP"的含义：
- **没有网络接口绑定**：没有任何网卡配置这个 IP，`ip addr` 看不到
- **不会响应 ARP**：节点不会对 ClusterIP 的 ARP 请求回应
- **只在 iptables/ipvs 规则中存在**：所有发往 ClusterIP 的包，在节点本地的 PREROUTING/OUTPUT 链被 DNAT 改写为 Pod IP

类比：ClusterIP 像"邮编分拣中心编号"，写信时填这个编号，但实际投递时分拣员会改写成具体收件人地址。集群中没有任何一个机器"是"这个 IP。

**kube-proxy 的角色**：

- **不是代理**（虽然名字里有 proxy）：流量不经过 kube-proxy 进程，kube-proxy 只是"规则维护者"
- **工作机制**：watch Service/EndpointSlice 变化，把 ClusterIP -> Pod IP 的 DNAT 规则写到 iptables/ipvs
- **数据面**：实际转发由 Linux 内核的 netfilter（iptables）或 IPVS 完成，kube-proxy 不参与数据面
- **优势**：内核态转发，性能高（无用户态切换），kube-proxy 进程挂了不影响存量流量

**为什么 ping ClusterIP 不通但 curl 通**：

- **ping 用 ICMP 协议**：iptables 的 Service 规则只匹配 TCP/UDP，不匹配 ICMP
- **curl 用 TCP**：TCP 包被 iptables DNAT 改写，正常转发到 Pod
- **设计原因**：ClusterIP 是"四层负载均衡虚拟 IP"，只为 TCP/UDP 服务，不为 ICMP 服务
- **调试技巧**：测试 Service 通不通用 `curl` 或 `nc`，不要用 `ping`

#### 3. kube-proxy iptables vs ipvs

**iptables 模式**：

```
# 一个 Service（ClusterIP=10.96.10.23，3 个 Pod IP）的 iptables 规则

# 1. KUBE-SERVICES 链：匹配 ClusterIP，跳转到 KUBE-SVC-XXX
-A KUBE-SERVICES -d 10.96.10.23/32 -p tcp --dport 80 -j KUBE-SVC-XXX

# 2. KUBE-SVC-XXX 链：按概率跳转到 KUBE-SEP-XXX（每个 SEP 对应一个 Pod）
-A KUBE-SVC-XXX -m statistic --mode random --probability 0.333 -j KUBE-SEP-AAA
-A KUBE-SVC-XXX -m statistic --mode random --probability 0.500 -j KUBE-SEP-BBB
-A KUBE-SVC-XXX -j KUBE-SEP-CCC

# 3. KUBE-SEP-XXX 链：DNAT 改写目的地址为 Pod IP
-A KUBE-SEP-AAA -p tcp -j DNAT --to-destination 10.244.1.23:8080
-A KUBE-SEP-BBB -p tcp -j DNAT --to-destination 10.244.2.45:8080
-A KUBE-SEP-CCC -p tcp -j DNAT --to-destination 10.244.3.12:8080
```

**iptables 模式的特点**：
- **规则数 = O(Service × Endpoint)**：每个 Service-Endpoint 对应 1 条 SEP 规则 + 1 条 SVC 概率规则
- **概率随机**：通过 `--mode random --probability` 实现，按顺序匹配，第三个 SEP 概率 1（兜底）
- **线性匹配**：iptables 规则按顺序匹配，规则越多越慢

**ipvs 模式**：

```
# ipvs 用内核中的 IPVS 模块，规则在 IPVS 表（不在 iptables）

$ ipvsadm -L -n
TCP  10.96.10.23:80 rr
  -> 10.244.1.23:8080         Masq    1      0          0
  -> 10.244.2.45:8080         Masq    1      0          0
  -> 10.244.3.12:8080         Masq    1      0          0
```

**ipvs 模式的特点**：
- **规则数 = O(Endpoint)**：每个 Endpoint 一条规则，Service 不增加规则数
- **哈希查找**：IPVS 用哈希表查找，O(1) 复杂度
- **调度算法丰富**：rr（轮询）/ wrr（加权轮询）/ lc（最少连接）/ sh（源地址哈希，会话保持）/ sed（最短期望延迟）
- **仍需 iptables 做 SNAT/kube-nodeport**：ipvs 不处理 SNAT 和 NodePort，kube-proxy 会配少量 iptables 规则做补充

**iptables vs ipvs 本质差异**：

| 维度 | iptables | ipvs |
|------|---------|------|
| 规则数据结构 | 线性链表 | 哈希表 |
| 规则数复杂度 | O(Service × Endpoint) | O(Endpoint) |
| 查找复杂度 | O(N) 线性 | O(1) 哈希 |
| 1万 Service × 10 Endpoint = 10万规则 | 慢，规则更新卡顿 | 快，规则更新无感 |
| 调度算法 | 仅 random | rr/wrr/lc/sh/sed/dh 等 10+ 种 |
| 会话保持 | iptables recent 模块（粗略） | sh 算法（精确） |
| 内核依赖 | netfilter（默认有） | ip_vs 模块（需加载） |
| 适用规模 | 小中集群（&lt; 1000 Service） | 大集群（> 1000 Service） |

**为什么大集群必须用 ipvs**：

1. **规则爆炸**：1000 Service × 10 Endpoint = 10000 条规则，iptables 模式下规则更新（每次 Endpoints 变化都要重写）需要数百毫秒，导致 kube-proxy CPU 飙升
2. **查找性能**：iptables 线性查找，1万规则下每个包要遍历，CPU 占用高；ipvs 哈希查找，性能与规则数无关
3. **内核锁竞争**：iptables 修改规则时持有 `xt_table_lock`，大集群下规则更新阻塞数据面；ipvs 用 RCU，更新不影响数据面
4. **滚动发布雪崩**：Day02 讲过，Endpoints 频繁变化时 iptables 重写规则可能阻塞，ipvs 几乎无感

**iptables 模式的"概率随机"陷阱**：

```bash
# 规则1: --probability 0.333   # 1/3 概率走 SEP-AAA
# 规则2: --probability 0.500   # 剩 2/3 中 1/2 概率走 SEP-BBB（实际 1/3 概率）
# 规则3: 兜底走 SEP-CCC        # 剩 1/3 概率
```

陷阱：
1. **顺序依赖**：规则必须按概率从大到小排列，否则概率计算错乱
2. **Endpoint 变化时重算**：每次 Endpoints 变化，所有概率要重新计算重写，规则数翻倍
3. **权重不均**：客户端连接复用（keepalive）会导致实际流量分布偏离概率
4. **conntrack 命中后不走规则**：已建立的连接走 conntrack，新连接才走概率规则，导致长连接流量分布不均

**ipvs 调度算法的适用场景**：

| 算法 | 全称 | 适用场景 |
|------|------|---------|
| rr | Round-Robin | 默认，后端性能均匀 |
| wrr | Weighted Round-Robin | 后端性能不均（如混合 4C/8C 节点） |
| lc | Least-Connection | 长连接场景（如 gRPC、WebSocket） |
| wlc | Weighted Least-Connection | 长连接 + 后端不均 |
| sh | Source-Hashing | 会话保持（替代 sessionAffinity） |
| sed | Shortest Expected Delay | 综合考虑连接数和响应时间 |
| dh | Destination-Hashing | 缓存命中优化（同一后端缓存） |

#### 4. 会话保持 / 流量策略 / 客户端 IP 保留

**会话保持（sessionAffinity）**：

```yaml
apiVersion: v1
kind: Service
metadata:
  name: report-svc
spec:
  type: ClusterIP
  sessionAffinity: ClientIP                    # 启用客户端 IP 会话保持
  sessionAffinityConfig:
    clientIP:
      timeoutSeconds: 10800                    # 默认 3 小时
  selector:
    app: report
  ports:
  - port: 80
    targetPort: 8080
```

- 实现：kube-proxy 在 iptables 用 `recent` 模块记录客户端 IP，3 小时内同一客户端 IP 始终转发到同一 Pod
- ipvs 模式用 `sh`（Source-Hashing）算法实现
- **陷阱**：客户端 IP 是 NAT 后的 IP，大量客户端经过同一 NAT 出口会被打到同一 Pod，造成流量倾斜

**流量策略（externalTrafficPolicy / internalTrafficPolicy）**：

```yaml
spec:
  externalTrafficPolicy: Local      # Cluster（默认）/ Local
  internalTrafficPolicy: Cluster    # Cluster（默认）/ Local
```

| 策略 | 选项 | 含义 | 副作用 |
|------|------|------|------|
| externalTrafficPolicy | Cluster（默认） | NodePort/LB 流量可跨节点转发到任意 Pod | 跨节点 SNAT，丢失客户端 IP |
| externalTrafficPolicy | Local | NodePort/LB 流量只能转发到本节点 Pod | 保留客户端 IP；本节点无 Pod 时流量被丢弃 |
| internalTrafficPolicy | Cluster（默认） | ClusterIP 流量可跨节点转发 | 跨节点 SNAT |
| internalTrafficPolicy | Local | ClusterIP 流量只转发到本节点 Pod | 减少跨节点流量；本节点无 Pod 时流量被丢弃 |

**NodePort 默认 SNAT 的链路**：

```
外部客户端 (1.2.3.4) -> Node A:30080 (NodePort)
                       │
                       │ externalTrafficPolicy: Cluster (默认)
                       │ 本节点有 Pod -> 直接转发；本节点无 Pod -> 转发到 Node B
                       │
                       ▼
                  跨节点转发到 Node B
                       │
                       │ SNAT 改写源 IP（避免回包走丢）
                       │ 源 IP: 1.2.3.4 -> Node A 内网 IP
                       ▼
                  Pod（在 Node B）收到请求
                       │
                       │ 看到的源 IP 是 Node A 内网 IP，看不到客户端真实 IP
```

**为什么 NodePort 默认会 SNAT**：

设计权衡：如果不 SNAT，回包从 Node B 直接发给客户端，客户端看到响应源 IP 是 Node B（而非最初连的 Node A），TCP 连接被打破。所以默认 SNAT 保证回包走原路。

代价：后端 Pod 看不到真实客户端 IP，只看到 Node A 内网 IP。

**保留客户端 IP 的方案**：

| 方案 | 实现 | 代价 |
|------|------|------|
| externalTrafficPolicy: Local | 只转发到本节点 Pod，不 SNAT | 本节点无 Pod 时流量丢弃；需要 LB 做健康检查只转发到有 Pod 的节点 |
| 透传 X-Forwarded-For / X-Real-IP | Ingress 层加 HTTP 头，业务读 header | 仅 HTTP，TCP/UDP 不行 |
| PROXY Protocol | LB -> NodePort 时加 PROXY Protocol 头 | 需 Ingress Controller 支持（nginx-ingress 支持） |
| 直连 Pod IP（HostNetwork） | Pod 用 hostNetwork，绕过 Service | 失去 Service 负载均衡；端口冲突 |
| 使用 eBPF/Cilium | Cilium 用 eBPF 直接保留源 IP | 需替换 CNI |

**保留客户端 IP 的场景**：

1. **医保审计**：医保局要求日志记录参保人真实 IP，必须保留客户端 IP 用于追责
2. **风控反欺诈**：同一 IP 短时间多次提交预约，需识别并拦截
3. **限流按 IP**：单 IP 限流必须看到真实 IP
4. **CDN 回源**：CDN 节点 IP 白名单（看 X-Forwarded-For 链）
5. **合规日志**：等保 2.0 要求审计日志含源 IP

**保留客户端 IP 的代价**：

- 流量分布不均：Local 模式下，每个节点的 Pod 数决定该节点的流量比例，不均
- 流量丢弃风险：节点没有 Pod 时流量被丢弃，需要 LB 健康检查配合
- LB 配置复杂：云厂商 LB 需开启"客户端 IP 保留"模式（如阿里云 SLB 的"Local"模式）

#### 5. 啄木鸟云健康 4 个子系统的 Service 选型

| 子系统 | Service 类型 | 关键配置 | 工程理由 |
|--------|------------|---------|---------|
| 体检预约 Web 服务 | LoadBalancer（云上）或 Ingress + ClusterIP（自建） | externalTrafficPolicy: Local；annotations: 保留客户端 IP | 外部 HTTPS 入口；需要保留客户端 IP 给风控/审计 |
| 体检报告服务 | ClusterIP | internalTrafficPolicy: Cluster（默认） | 纯内部服务；不需要保留客户端 IP；跨节点转发可接受 |
| 医保接口代理服务 | ClusterIP + Ingress | externalTrafficPolicy: Local；Ingress 开启 PROXY Protocol | 必须保留客户端 IP 给医保局审计；用 Ingress 终结 HTTPS |
| Redis Cluster | Headless（clusterIP: None）+ StatefulSet | 不分配 VIP，DNS 返回 Pod IP 列表 | 客户端需直接连 redis-0 主节点做 slot 路由 |

**体检预约服务的 YAML 示例**：

```yaml
apiVersion: v1
kind: Service
metadata:
  name: appointment-svc
  namespace: health
  annotations:
    # 阿里云 LB：开启客户端 IP 保留（SLB "本地模式"）
    service.beta.kubernetes.io/alibaba-cloud-loadbalancer-spec: "slb.s1.small"
    service.beta.kubernetes.io/alibaba-cloud-loadbalancer-forward-port: "443:80"
spec:
  type: LoadBalancer
  externalTrafficPolicy: Local              # 保留客户端 IP
  sessionAffinity: None                     # 体检预约无需会话保持（无状态）
  selector:
    app: appointment
  ports:
  - name: https
    port: 443
    targetPort: 8080
    protocol: TCP
```

**Redis Cluster 的 Headless Service 示例**：

```yaml
apiVersion: v1
kind: Service
metadata:
  name: redis-headless
  namespace: health
spec:
  clusterIP: None                           # Headless
  selector:
    app: redis
  ports:
  - port: 6379
    name: redis-client
  - port: 16379
    name: redis-cluster-bus
---
# StatefulSet 关联 Headless Service
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: redis
spec:
  serviceName: redis-headless               # 必须指向 Headless Service
  replicas: 6
  # ...
```

**灰度发布 / 蓝绿切换 / 故障隔离的 Service 层配合**：

**方案一：Ingress + 两个 Service（蓝绿 / 灰度）**

```yaml
# 蓝绿：Ingress 通过 Service selector 切换
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: appointment-ingress
  namespace: health
  annotations:
    nginx.ingress.kubernetes.io/canary: "true"                    # 金丝雀开关
    nginx.ingress.kubernetes.io/canary-weight: "10"                # 10% 流量到 canary
spec:
  rules:
  - host: appointment.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: appointment-svc-stable     # 90% 流量
            port:
              number: 443
---
# 金丝雀 Ingress（同一 host，canary 注解）
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: appointment-canary
  namespace: health
  annotations:
    nginx.ingress.kubernetes.io/canary: "true"
    nginx.ingress.kubernetes.io/canary-weight: "10"
    nginx.ingress.kubernetes.io/canary-by-header: "x-canary"   # 按 header 灰度
    nginx.ingress.kubernetes.io/canary-by-header-value: "true"
spec:
  rules:
  - host: appointment.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: appointment-svc-canary     # 10% 流量
            port:
              number: 443
```

**方案二：Service Mesh（Istio）做精细流量治理**

- Istio VirtualService + DestinationRule 实现按比例、按 header、按 user-agent 的流量切分
- 故障隔离：Istio OutlierDetection 把异常 Pod 从负载均衡池摘除
- 灰度发布：5% -> 25% -> 50% -> 100% 渐进切换
- 蓝绿切换：一键改 VirtualService 路由规则，秒级回滚

**架构师视角的关键认知**：

- Service 是 L4 抽象，无法做 L7 路由（按 URL / Header / Cookie 切分流量）。**灰度 / 蓝绿 / A/B 测试必须用 Ingress 或 Service Mesh**
- ClusterIP 不是负载均衡器，是"虚拟 IP + iptables 规则"。真正的负载均衡在 iptables/ipvs（内核态）
- 1000 Service 是 ipvs 模式的"分水岭"，超过必须从 iptables 切 ipvs
- 保留客户端 IP 是有代价的（流量分布不均 + 流量丢弃风险），需要 LB 健康检查配合
- EndpointSlice 不是"Endpoints 的小升级"，是大集群的"命根子"，watch 流量从 MB 级降到 KB 级

#### 与架构师水平的差距与补足方向

**差距1**：kube-proxy iptables vs ipvs 的实战调优只调过模式切换，没做过规则数与性能的量化对比
**补足**：搭一个大集群（1000+ Service），用 `iptables-save | wc -l` 和 `ipvsadm -L -n | wc -l` 对比规则数；用 wrk 压测对比 CPU/延迟

**差距2**：CoreDNS 解析链路、ndots:5 陷阱、Pod DNS 配置优化不熟
**补足**：精读 CoreDNS Plugin 机制，复盘啄木鸟云健康线上 DNS 慢的案例（如有），学习 `dnsConfig: { options: [{ name: ndots, value: "2" }] }` 优化

**差距3**：保留客户端 IP 的方案用过 `externalTrafficPolicy: Local`，但 PROXY Protocol / Cilium eBPF 直连方案不熟
**补足**：学习 nginx-ingress PROXY Protocol 配置，研究 Cilium eBPF 替代 kube-proxy 的方案

**差距4**：Service Mesh（Istio）的 VirtualService + DestinationRule 流量治理用过，但与 K8s Service 的协作关系不清晰
**补足**：精读 Istio 流量治理模型，理解"K8s Service 提供寻址 + Istio VirtualService 提供路由"的分层

---

## 题目二（架构设计题）：Ingress + CNI + CoreDNS + NetworkPolicy 综合设计

K8s 网络模型包含"南北向流量"（外部 -> 集群）和"东西向流量"（Pod &lt;-> Pod）两条链路。请你回答：

1. K8s 中"四层流量入口"和"七层流量入口"分别是什么？为什么 Service（L4）不能取代 Ingress（L7）？Ingress 资源与 Ingress Controller 的关系？主流 Ingress Controller（nginx-ingress / Traefik / APISIX / Istio Gateway / Gateway API）的差异与选型？
2. CNI 插件解决什么问题？Calico / Flannel / Cilium 三种主流方案的差异？Overlay 模式（VXLAN/IPIP）与 BGP 模式本质差异？为什么大规模生产倾向 Cilium（eBPF）？CNI 与 NetworkPolicy 的关系？为什么说"eBPF 是 K8s 网络的下一场革命"？
3. CoreDNS 在 K8s 中的作用？`svc.namespace.svc.cluster.local` 的解析链路？CoreDNS 的 Plugin 机制（kubernetes / forward / rewrite / cache / hosts）？为什么 DNS 解析慢会成为业务延迟的"隐形杀手"？ndots:5 陷阱怎么解决？Pod 的 DNS 配置怎么调优？
4. NetworkPolicy 解决什么问题？default-deny-all 的标准模式怎么写？为什么 NetworkPolicy 不能取代传统防火墙（L4 vs L7、东西向 vs 南北向）？多租户场景（如啄木鸟云健康多医院）如何用 Namespace + NetworkPolicy 做隔离？NetworkPolicy 的局限与替代方案（Cilium NetworkPolicy / Istio AuthorizationPolicy）？
5. 综合设计：啄木鸟云健康平台要在 K8s 上做"多医院隔离 + 灰度发布 + 流量治理 + 安全合规"的网络架构设计，包含：互联网入口（WAF + LB）-> Ingress -> 业务 Pod -> DB/Redis。请给出 Namespace 划分、NetworkPolicy 策略、CNI 选型、DNS 配置、Service Mesh 衔接的完整方案，并画出整体网络架构图。

### 作答区

#### 1. 四层 vs 七层流量入口 / Ingress Controller 选型

**核心一句话**：Service 是 L4（TCP/UDP）流量入口，只能按 IP + 端口转发；Ingress 是 L7（HTTP/HTTPS）流量入口，能按 URL / Header / Cookie 路由。L7 必须用 Ingress，L4 用 Service。

**为什么 Service 不能取代 Ingress**：

| 需求 | Service（L4） | Ingress（L7） |
|------|--------------|--------------|
| 转发 TCP/UDP | 支持 | 不支持（HTTP only） |
| 转发 HTTP/HTTPS | 支持但功能弱 | 原生支持 |
| 按 URL 路由（/api -> A, /web -> B） | 不支持 | 支持 |
| 按 Host 路由（a.com -> A, b.com -> B） | 不支持 | 支持 |
| TLS 终结（HTTPS -> HTTP） | 不支持 | 支持 |
| 按 Header / Cookie 灰度 | 不支持 | 支持 |
| 重写 URL / 重定向 | 不支持 | 支持 |
| 限流 / 黑白名单 | 不支持（需 Istio） | 支持（nginx annotations） |

**Ingress 资源 vs Ingress Controller**：

```
┌──────────────────────────────────────────────────────────────┐
│  Ingress 资源（K8s 内置 API）                                  │
│  - 一种"声明式 L7 路由规则"API，定义 host/path -> Service 映射 │
│  - K8s 只定义资源，不实现转发                                  │
└──────────────────────────────────────────────────────────────┘
                 ▲
                 │ watch Ingress 资源
                 │
┌──────────────────────────────────────────────────────────────┐
│  Ingress Controller（独立组件，非 K8s 内置）                   │
│  - watch Ingress 资源，生成实际转发规则                        │
│  - 不同 Controller 实现不同（nginx / traefik / istio）        │
│  - 通常以 DaemonSet 或 Deployment 部署                        │
└──────────────────────────────────────────────────────────────┘
                 │
                 │ 转发流量到 Service
                 ▼
┌──────────────────────────────────────────────────────────────┐
│  Service -> Pod（按 K8s 标准转发链路）                         │
└──────────────────────────────────────────────────────────────┘
```

**注意**：K8s 内置 Ingress 资源 API，但**不内置 Controller**。集群必须手动部署 Ingress Controller，否则 Ingress 资源不会生效。

**主流 Ingress Controller 对比**：

| Controller | 实现基础 | 优势 | 劣势 | 适用场景 |
|-----------|---------|------|------|---------|
| nginx-ingress | Nginx + Lua | 生态成熟、配置文档多、稳定 | 配置变更靠 reload（除非用 Lua 动态） | 中小规模、传统 Web 应用 |
| Traefik | Go 自研 | 自动 ACME 证书、配置热加载、Dashboard 漂亮 | 性能不如 nginx、生态较小 | 个人项目、DevOps 友好场景 |
| APISIX | OpenResty + etcd | 插件丰富、动态配置、性能好 | 部署复杂（需 etcd）、社区相对小 | API 网关场景、需要丰富插件 |
| Istio Gateway | Envoy | 与 Service Mesh 集成、xDS 动态配置 | 需要全量 Istio 部署、运维复杂 | 已用 Istio 的集群 |
| Gateway API | K8s 1.25+ 标准 | 跨 Controller 标准、TCP/UDP/HTTP 通用 | 生态发展中、迁移成本 | 未来趋势、新集群推荐 |

**架构师选型建议**：

- **中小集群、传统 Web**：nginx-ingress（默认选择，生态最成熟）
- **API 网关场景**：APISIX（插件丰富，限流/认证/灰度内置）
- **已用 Istio**：Istio Gateway（统一治理）
- **新集群、长期演进**：Gateway API（K8s 标准，未来跨 Controller 兼容）

**Gateway API 的关键变化**：

K8s 1.25+ 引入 Gateway API 作为 Ingress 的下一代标准：
- Ingress 资源只能描述 HTTP 路由；Gateway API 支持 HTTP / TCP / UDP / gRPC / TLS 全协议
- Ingress Controller 各家注解不同（如 nginx 的 `nginx.ingress.kubernetes.io/...`），可移植性差；Gateway API 是标准化的
- 角色分离：GatewayClass（基础设施管理员） / Gateway（集群运维） / HTTPRoute（业务开发）三层职责清晰

#### 2. CNI 插件 / Calico vs Flannel vs Cilium / Overlay vs BGP

**CNI（Container Network Interface）解决什么问题**：

- 为 Pod 分配 IP 地址
- 配置 Pod 的网络接口（veth pair / bridge / 路由）
- 处理 Pod 跨节点通信（Overlay 隧道 / BGP 路由 / 直连路由）
- 实现 NetworkPolicy（部分 CNI 支持）

**CNI 工作时机**：kubelet 创建 Pod 时调用 CNI 插件，Pod 销毁时再调用清理。

**三大主流 CNI 对比**：

| CNI | 数据平面 | 模式 | NetworkPolicy | 性能 | 适用场景 |
|-----|---------|------|--------------|------|---------|
| Flannel | 简单路由 | VXLAN（默认）/ Host-GW | 不支持（需 Calico 配合） | 中等 | 小集群、入门、简单场景 |
| Calico | iptables / eBPF | BGP（默认）/ VXLAN / IPIP | 原生支持 | 高 | 中大集群、生产、需 NetworkPolicy |
| Cilium | eBPF | VXLAN / BGP / 直连 | 原生支持（增强版） | 极高 | 大集群、性能敏感、Service Mesh 替代 |

**Overlay vs BGP 本质差异**：

```
┌─────────────────────────────────────────────────────────────┐
│  Overlay 模式（VXLAN / IPIP）                                │
│                                                              │
│  Node A (10.0.1.10)            Node B (10.0.2.20)            │
│  ┌──────────┐                  ┌──────────┐                  │
│  │ Pod A    │                  │ Pod B    │                  │
│  │ 10.244.1 │                  │ 10.244.2 │                  │
│  └────┬─────┘                  └────┬─────┘                  │
│       │ veth                        │ veth                    │
│  ┌────┴─────┐                  ┌────┴─────┐                  │
│  │ flannel.1│ ◄──── VXLAN 隧道 ──► │flannel.1│                  │
│  │ (封装层) │    封装外层 IP        │ (封装层) │                  │
│  └──────────┘  10.0.1.10->10.0.2.20 └──────────┘                  │
│       │                            │                          │
│  Pod 包封装成 Node 包，跨节点走 Node IP 路由                   │
│                                                              │
│  优点：跨网段、跨云、跨 VPC 都能用                              │
│  缺点：封装开销（约 50 字节/包），MTU 减小，CPU 开销            │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  BGP 模式（Calico 默认）                                      │
│                                                              │
│  Node A (10.0.1.10)            Node B (10.0.2.20)            │
│  ┌──────────┐                  ┌──────────┐                  │
│  │ Pod A    │                  │ Pod B    │                  │
│  │ 10.244.1 │                  │ 10.244.2 │                  │
│  └────┬─────┘                  └────┬─────┘                  │
│       │ veth                        │ veth                    │
│  ┌────┴─────┐                  ┌────┴─────┐                  │
│  │  路由表  │ ◄──── BGP 路由协议 ──► │  路由表  │                  │
│  │ 10.244.2│    交换 Pod CIDR 路由  │ 10.244.1│                  │
│  │ via B   │                    │ via A   │                  │
│  └──────────┘                  └──────────┘                  │
│                                                              │
│  Pod 包不封装，按 BGP 路由直接转发，三层路由                   │
│                                                              │
│  优点：无封装开销、性能高、可调试                              │
│  缺点：要求节点 L3 互通、BGP 路由表规模大、跨 VPC 复杂         │
└─────────────────────────────────────────────────────────────┘
```

**为什么大规模生产倾向 Cilium（eBPF）**：

1. **性能**：eBPF 在内核态处理包，跳过 iptables netfilter 的多个 hook，延迟降低 30%+
2. **替换 kube-proxy**：Cilium 用 eBPF 直接做 Service 转发，规则数无上限，性能与规模无关
3. **可观测性**：eBPF 可以追踪每个包的完整链路，Hubble 工具提供流量拓扑图
4. **安全**：L3-L7 全层 NetworkPolicy（不只是 L4），可按 HTTP path/method 限流
5. **Service Mesh 替代**：Cilium Service Mesh 用 eBPF 实现，不需要 Sidecar，性能损耗更小
6. **未来趋势**：K8s 1.25+ 的 kube-proxy 替代方案（KPR，Cilium kube-proxy replacement）

**eBPF 为什么是革命**：

- **内核可编程**：eBPF 让你在内核态运行安全沙箱程序，无需修改内核源码
- **跳过 iptables**：传统 K8s 网络走 netfilter（iptables），每个包经过多个 hook；eBPF 直接在 socket / NIC 层处理
- **观测无侵入**：eBPF 可以追踪任意内核函数，无需改业务代码
- **不只是网络**：eBPF 还用于安全（Falco）、追踪（bpftrace）、性能分析（BCC）

**CNI 与 NetworkPolicy 的关系**：

- K8s NetworkPolicy 是 API 资源，定义"哪些 Pod 可以访问哪些 Pod"
- **K8s 只定义资源，不实现**，需要 CNI 插件实现
- Flannel 不支持 NetworkPolicy（需配 Calico 子模块）
- Calico 原生支持
- Cilium 原生支持增强版（L7 策略）

#### 3. CoreDNS / DNS 解析链路 / ndots:5 陷阱

**CoreDNS 在 K8s 中的作用**：

- 集群内 DNS 服务器（通常 ClusterIP 10.96.0.10）
- 解析 Service 域名：`<svc>.<namespace>.svc.cluster.local` -> ClusterIP
- 解析 Pod 域名（Headless Service）：`<pod-0>.<svc>.<namespace>.svc.cluster.local` -> Pod IP
- 解析外部域名：转发到上游 DNS（如 8.8.8.8）
- CoreDNS 自身以 Deployment 部署（通常 2 副本），通过 Service 暴露

**`svc.namespace.svc.cluster.local` 的解析链路**：

```
Pod A 访问 report-svc.health.svc.cluster.local
        │
        │ 1. 查 /etc/resolv.conf
        │    nameserver 10.96.0.10
        │    search health.svc.cluster.local svc.cluster.local cluster.local
        │    options ndots:5
        │
        │ 2. 因 ndots:5，域名含 5 个点 -> 直接查绝对域名
        │    查 report-svc.health.svc.cluster.local.
        │
        ▼
CoreDNS (10.96.0.10)
        │
        │ 3. CoreDNS kubernetes plugin 查 etcd
        │    找到 Service report-svc.health -> ClusterIP 10.96.10.23
        │
        │ 4. 返回 A 记录：report-svc.health.svc.cluster.local -> 10.96.10.23
        │
        ▼
Pod A 拿到 10.96.10.23，发起 TCP 连接
```

**CoreDNS Plugin 机制**：

CoreDNS 用插件链（plugin chain）处理请求，常用插件：

| 插件 | 作用 |
|------|------|
| kubernetes | 解析 K8s Service/Pod 域名 |
| forward | 转发非 K8s 域名到上游 DNS |
| rewrite | 重写域名（如把 `*.consul` 转发到 Consul） |
| cache | 缓存 DNS 响应，降低 etcd 压力 |
| hosts | 静态域名解析（类似 /etc/hosts） |
| prometheus | 暴露 DNS 指标给 Prometheus |
| errors / log | 日志输出 |

**Corefile 示例**：

```corefile
.:53 {
    errors
    health {
        lameduck 5s
    }
    ready
    kubernetes cluster.local in-addr.arpa ip6.arpa {
        pods insecure
        fallthrough in-addr.arpa ip6.arpa
        ttl 30
    }
    prometheus :9153
    forward . /etc/resolv.conf {
        max_concurrent 1000
        prefer_udp
    }
    cache 30
    loop
    reload
    loadbalance
}
```

**为什么 DNS 解析慢是"隐形杀手"**：

1. **每次请求都查 DNS**：业务代码每次 HTTP 调用都解析域名（除非缓存），DNS 慢 = 业务慢
2. **DNS 慢的特征**：P99 延迟高（如 50ms），但平均正常（1ms），难以察觉
3. **DNS 不可用 = 全站不可用**：DNS 挂了，所有域名解析失败，业务全挂
4. **连锁反应**：上游 DNS 慢 -> CoreDNS 慢 -> 业务慢 -> 用户超时 -> 重试 -> 雪崩

**ndots:5 陷阱**：

K8s 默认 Pod 的 `/etc/resolv.conf` 配置 `options ndots:5`，含义：**域名中点数 &lt; 5 时，先按 search 列表补全后缀查询**。

**陷阱场景**：Pod 访问 `www.baidu.com`（2 个点 &lt; 5）：

```
1. 先查 www.baidu.com.health.svc.cluster.local.  -> NXDOMAIN
2. 再查 www.baidu.com.svc.cluster.local.         -> NXDOMAIN
3. 再查 www.baidu.com.cluster.local.             -> NXDOMAIN
4. 最后查 www.baidu.com.                         -> 解析成功
```

**4 次 DNS 查询才解析成功**，每次 10ms = 40ms 额外延迟。在高 QPS 场景下放大为 CoreDNS 压力翻 4 倍。

**解决方案**：

1. **外部域名加 `.`**：`www.baidu.com.`（绝对域名，跳过 search），但业务代码改造成本高
2. **降低 ndots**：`dnsConfig: { options: [{ name: ndots, value: "2" }] }`，但可能影响集群内域名解析
3. **使用 NodeLocal DNSCache**：每个节点跑一个 DNS 缓存，避免跨节点查 CoreDNS
4. **业务侧 DNS 缓存**：JVM 默认缓存 30s，调整 `networkaddress.cache.ttl`
5. **CoreDNS cache 调优**：增大 cache 容量、延长 TTL

**Pod DNS 调优示例**：

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: appointment
spec:
  dnsConfig:
    options:
    - name: ndots
      value: "2"                              # 降低 ndots
    - name: single-request-reopen             # 避免 IPv4/IPv6 串行查询
    - name: timeout
      value: "2"
    - name: attempts
      value: "3"
  dnsPolicy: ClusterFirst                     # 默认；优先集群 DNS
  containers:
  - name: app
    # ...
```

**NodeLocal DNSCache 部署架构**：

```
┌─────────────────────────────────────────────────────────────┐
│  Node                                                        │
│  ┌──────────┐    ┌──────────────┐    ┌──────────────────┐   │
│  │ Pod      │ -> │ NodeLocal    │ -> │ CoreDNS          │   │
│  │          │    │ DNSCache     │    │ (ClusterIP)      │   │
│  │ resolv:  │    │ 169.254.20.10│    │ 10.96.0.10       │   │
│  │ 169.254  │    │ (DaemonSet)  │    │ (Deployment)     │   │
│  └──────────┘    └──────────────┘    └──────────────────┘   │
│                  本地缓存命中率 90%+                          │
└─────────────────────────────────────────────────────────────┘
```

NodeLocal DNSCache 在每个节点跑一份 DaemonSet，Pod 的 DNS 指向本节点 cache，命中本地，未命中再转发 CoreDNS。命中率 90%+，CoreDNS QPS 降一个数量级。

#### 4. NetworkPolicy / default-deny-all / 多租户隔离

**NetworkPolicy 解决什么问题**：

K8s 默认"全连通"：任何 Pod 都能访问任何 Pod（同 Namespace + 跨 Namespace）。生产环境必须隔离：

- 不同业务之间不能互访（如订单服务不能直接访问支付服务的 DB）
- 不同租户之间不能互访（如医院 A 不能访问医院 B 的数据）
- 外部访问只能通过 Ingress，不能直连 Pod IP

**NetworkPolicy 是声明式 L3/L4 隔离规则**，由 CNI 实现：

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: db-allow-only-app
  namespace: health
spec:
  podSelector:
    matchLabels:
      app: mysql                  # 应用到 mysql Pod
  policyTypes:
  - Ingress
  ingress:
  - from:
    - podSelector:
        matchLabels:
          app: appointment         # 只允许 appointment Pod 访问
    ports:
    - protocol: TCP
      port: 3306
```

**default-deny-all 标准模式**：

```yaml
# 一个 Namespace 默认拒绝所有入站 + 出站，再按白名单放行
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: hospital-a
spec:
  podSelector: {}                  # 应用到 Namespace 内所有 Pod
  policyTypes:
  - Ingress
  - Egress
  ingress: []                      # 默认全拒
  egress: []                       # 默认全拒
---
# 放行 DNS（出站到 kube-system CoreDNS）
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dns
  namespace: hospital-a
spec:
  podSelector: {}
  policyTypes:
  - Egress
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
    - protocol: TCP
      port: 53
```

**default-deny-all 的工作原理**：

- 一旦 Namespace 中存在任何 NetworkPolicy（即使只对部分 Pod 生效），K8s 会进入"白名单模式"：所有未明确放行的流量都被拒绝
- 默认全拒后，必须显式放行：
  - DNS（必须，否则解析不了任何域名）
  - Ingress Controller -> 业务 Pod
  - 业务 Pod -> DB / Redis / MQ
  - 业务 Pod -> 外部 API（如医保接口）

**NetworkPolicy 不能取代传统防火墙的原因**：

| 维度 | NetworkPolicy | 传统防火墙 |
|------|--------------|-----------|
| 工作层级 | L3/L4 | L3-L7 |
| 流量方向 | 东西向（Pod &lt;-> Pod） | 南北向（外部 &lt;-> 集群） |
| 策略维度 | Pod 标签 / Namespace / IP | IP / 端口 / 应用 / 用户 |
| L7 策略 | 不支持（标准 NetworkPolicy） | 支持（应用识别） |
| 入侵检测 | 不支持 | 支持（IDS/IPS） |
| DDoS 防护 | 不支持 | 支持 |
| 持久化日志 | 弱 | 强（合规必需） |

**多租户场景的 Namespace + NetworkPolicy 隔离**：

```
┌─────────────────────────────────────────────────────────────┐
│  集群                                                        │
│  ┌──────────────────┐  ┌──────────────────┐                 │
│  │ Namespace:       │  │ Namespace:       │                 │
│  │ hospital-a       │  │ hospital-b       │                 │
│  │ - appointment    │  │ - appointment    │                 │
│  │ - report         │  │ - report         │                 │
│  │ - mysql          │  │ - mysql          │                 │
│  │ - redis          │  │ - redis          │                 │
│  │                  │  │                  │                 │
│  │ NetworkPolicy:   │  │ NetworkPolicy:   │                 │
│  │  default-deny    │  │  default-deny    │                 │
│  │  仅允许本 NS 内  │  │  仅允许本 NS 内  │                 │
│  │  Pod 互访        │  │  Pod 互访        │                 │
│  └──────────────────┘  └──────────────────┘                 │
│                                                              │
│  两个 Namespace 之间默认不能互访（多医院隔离）                 │
└─────────────────────────────────────────────────────────────┘
```

**多租户 NetworkPolicy 模板**：

```yaml
# hospital-a 的隔离策略：只允许本 NS 内 Pod 互访
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ns-isolation
  namespace: hospital-a
spec:
  podSelector: {}
  policyTypes:
  - Ingress
  - Egress
  ingress:
  - from:
    - podSelector: {}            # 本 NS 内所有 Pod
  egress:
  - to:
    - podSelector: {}            # 本 NS 内所有 Pod
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: kube-system
      podSelector:
        matchLabels:
          k8s-app: kube-dns       # 放行 DNS
  - to:
    - ipBlock:
        cidr: 0.0.0.0/0
        except:
        - 10.0.0.0/8              # 放行外网，拒绝内网（避免跨 NS 访问）
    ports:
    - protocol: TCP
      port: 443                   # 仅放行 HTTPS 到外网（如医保接口）
```

**NetworkPolicy 的局限与替代方案**：

| 局限 | 替代方案 |
|------|---------|
| 不支持 L7（HTTP path/method） | Cilium NetworkPolicy（L7 增强）/ Istio AuthorizationPolicy |
| 不支持按 Service 名称 | Cilium CiliumNetworkPolicy 支持 service selector |
| 不支持按域名（FQDN）egress | Cilium FQDN 策略 / Istio ServiceEntry |
| 策略数量爆炸（多规则组合） | Cilium 策略层级 / Istio AuthorizationPolicy 更灵活 |
| 跨集群不生效 | Istio Multi-Cluster AuthorizationPolicy |

#### 5. 啄木鸟云健康多医院平台网络架构设计

**整体网络架构图**：

```
                          ┌──────────────────┐
                          │  互联网用户       │
                          └────────┬─────────┘
                                   │
                                   ▼
                          ┌──────────────────┐
                          │  WAF (云厂商)     │  SQL 注入/XSS/CC 防护
                          └────────┬─────────┘
                                   │
                                   ▼
                          ┌──────────────────┐
                          │  云厂商 LB        │  L4 SLB (HTTPS 443)
                          │  (保留客户端 IP)  │  externalTrafficPolicy: Local
                          └────────┬─────────┘
                                   │
            ┌──────────────────────┼──────────────────────┐
            │                      │                      │
            ▼                      ▼                      ▼
   ┌────────────────┐     ┌────────────────┐    ┌────────────────┐
   │ Ingress        │     │ Ingress        │    │ Ingress        │
   │ Controller     │     │ Controller     │    │ Controller     │
   │ (hospital-a)   │     │ (hospital-b)   │    │ (hospital-c)   │
   │ Namespace:     │     │ Namespace:     │    │ Namespace:     │
   │ ingress-a      │     │ ingress-b      │    │ ingress-c      │
   └────────┬───────┘     └────────┬───────┘    └────────┬───────┘
            │                      │                      │
            ▼                      ▼                      ▼
   ┌────────────────┐     ┌────────────────┐    ┌────────────────┐
   │ Namespace:     │     │ Namespace:     │    │ Namespace:     │
   │ hospital-a     │     │ hospital-b     │    │ hospital-c     │
   │                │     │                │    │                │
   │ appointment    │     │ appointment    │    │ appointment    │
   │ report         │     │ report         │    │ report         │
   │ mysql          │     │ mysql          │    │ mysql          │
   │ redis          │     │ redis          │    │ redis          │
   │                │     │                │    │                │
   │ NetworkPolicy: │     │ NetworkPolicy: │    │ NetworkPolicy: │
   │ default-deny   │     │ default-deny   │    │ default-deny   │
   └────────┬───────┘     └────────┬───────┘    └────────┬───────┘
            │                      │                      │
            └──────────────────────┼──────────────────────┘
                                   │
                                   ▼
                          ┌──────────────────┐
                          │  Namespace:       │
                          │  kube-system      │
                          │  - CoreDNS        │
                          │  - Cilium         │
                          │  - NodeLocal DNS  │
                          └──────────────────┘
                                   │
                                   ▼
                          ┌──────────────────┐
                          │  外部服务         │
                          │  - 医保局 API    │
                          │  - 短信网关      │
                          │  - 支付通道      │
                          └──────────────────┘
```

**Namespace 划分**：

| Namespace | 用途 | 隔离策略 |
|-----------|------|---------|
| `ingress-a/b/c` | 每医院独立 Ingress Controller | 仅本 NS Pod + LB 来源 |
| `hospital-a/b/c` | 每医院业务 Pod | default-deny-all，仅本 NS 内 Pod 互访 |
| `kube-system` | 集群组件（CoreDNS、Cilium、metrics-server） | 仅集群管理员访问 |
| `monitoring` | Prometheus、Grafana、AlertManager | 仅运维访问，业务不能访问 |
| `middleware-shared` | 共享中间件（如医院共享 Redis Cluster） | 按白名单访问 |

**NetworkPolicy 策略矩阵**：

| 来源 \ 目的 | hospital-a | hospital-b | kube-system | middleware-shared | 外网 |
|------------|-----------|-----------|-------------|-------------------|------|
| hospital-a | 允许 | 拒绝 | 允许 DNS | 允许指定端口 | 允许 HTTPS |
| hospital-b | 拒绝 | 允许 | 允许 DNS | 允许指定端口 | 允许 HTTPS |
| ingress-a | 允许 | 拒绝 | 拒绝 | 拒绝 | 拒绝 |
| ingress-b | 拒绝 | 允许 | 拒绝 | 拒绝 | 拒绝 |
| 外网 | 拒绝（仅 LB） | 拒绝（仅 LB） | 拒绝 | 拒绝 | - |

**CNI 选型**：Cilium（eBPF）

理由：
1. 大集群性能优势（eBPF 跳过 iptables）
2. 替代 kube-proxy（KPR），减少组件
3. L7 NetworkPolicy（按 HTTP path/method 限流）
4. Hubble 流量观测（医疗合规日志）
5. 多集群支持（未来跨 Region 容灾）

**DNS 配置**：

- CoreDNS 部署 3 副本（高可用）
- NodeLocal DNSCache 部署 DaemonSet（每节点一份，命中率 90%+）
- Pod `dnsConfig.ndots: 2`（降低外部域名解析开销）
- CoreDNS cache TTL 调到 60s（医疗配置变更频率低）

**Service Mesh 衔接（Istio）**：

- 业务 Namespace 启用 Istio Sidecar 注入（`istio-injection: enabled` 标签）
- Ingress -> Sidecar -> Pod，全链路 mTLS（医疗合规数据加密）
- VirtualService 做按比例灰度（5% -> 25% -> 50% -> 100%）
- DestinationRule 做故障隔离（OutlierDetection 摘除异常 Pod）
- AuthorizationPolicy 做细粒度授权（按 Service Account 限制访问）
- Telemetry 全链路追踪（SkyWalking / Jaeger）

**安全合规设计**：

1. **数据加密**：Pod 间 mTLS（Istio）；DB 连接 TLS；存储加密（KMS 托管密钥）
2. **审计日志**：所有 API 调用走 audit log；Cilium Hubble 记录网络流量；Ingress 记录 HTTP 请求
3. **身份认证**：外部用户走 OIDC（Keycloak）；内部服务走 SPIFFE（Istio Identity）
4. **授权**：K8s RBAC + Istio AuthorizationPolicy 双层
5. **网络隔离**：Namespace + NetworkPolicy + Istio AuthorizationPolicy 三层
6. **DDoS 防护**：WAF + 云厂商 Anti-DDoS + Ingress 限流

**灰度发布设计**：

```
1. 灰度策略：Ingress + Istio VirtualService
   - v1 (stable): 90%
   - v2 (canary): 10%
   - 按 header 灰度（x-canary: true）
   - 按用户 ID 灰度（hash % 100 < 10）

2. 灰度流程：
   - 5% canary -> 观察 30min（错误率、延迟、业务指标）
   - 25% -> 50% -> 100%
   - 任一阶段异常 -> 一键回滚（VirtualService 改回 100% v1）

3. 故障隔离：
   - Istio OutlierDetection：Pod 异常率 > 5% 自动摘除
   - 熔断：consecutive5xxErrors=5 触发熔断
   - 限流：rqps limit 1000 防雪崩
```

**架构师视角的关键认知**：

- 网络架构不是"配个 CNI 就完事"，而是"南北向 + 东西向 + DNS + Service Mesh + 安全合规"五位一体的系统设计
- 大集群必选 Cilium（eBPF），不只是性能，更是观测性和 L7 安全
- 多租户隔离不能只靠 NetworkPolicy，必须 Namespace + NetworkPolicy + RBAC + Istio AuthorizationPolicy 多层
- DNS 是 K8s 最容易被忽略的"基础设施命脉"，NodeLocal DNSCache 是大集群标配
- 灰度发布 / 蓝绿切换 / 故障隔离，K8s 原生 Ingress + Service 不够，必须用 Service Mesh
- 医疗合规要求"全程加密 + 全程审计 + 全程隔离"，每一条都要在网络架构中落地，不能口头承诺

#### 与架构师水平的差距与补足方向

**差距1**：Ingress Controller 只用过 nginx-ingress，对 Gateway API / APISIX / Istio Gateway 的选型差异不熟
**补足**：精读 Gateway API 官方文档，对比 nginx-ingress 和 APISIX 的能力矩阵，新集群尝试 Gateway API

**差距2**：CNI 只用过 Flannel 和 Calico，对 Cilium（eBPF）只有概念认知
**补足**：搭一个 Cilium 集群，启用 kube-proxy replacement，对比 iptables 模式的 CPU/延迟差异；学习 Hubble 流量观测

**差距3**：CoreDNS 的 Plugin 机制、NodeLocal DNSCache、ndots 调优只用过默认配置
**补足**：在生产集群部署 NodeLocal DNSCache，对比命中率；调优 ndots 和 CoreDNS cache TTL

**差距4**：NetworkPolicy 写过简单规则，但多租户场景的 default-deny-all + 白名单放行策略不熟
**补足**：学习 Cilium NetworkPolicy（L7 增强）和 Istio AuthorizationPolicy，制定多租户隔离 SOP

**差距5**：Service Mesh（Istio）只用了基础流量治理，对 mTLS、AuthorizationPolicy、SPIFFE 身份体系不熟
**补足**：精读 Istio Security 模型，启用 mTLS 和 AuthorizationPolicy，理解 SPIFFE 与 K8s ServiceAccount 的关系

---

## 能力差距梳理（Day03）

> 后续将统一汇总到 `架构师学习-能力差距梳理.md`

### 差距1：kube-proxy iptables vs ipvs 实战调优不足
> Day3发现

- **现状**：知道 iptables 和 ipvs 两种模式，但没做过规则数与性能的量化对比，没切过 ipvs 模式
- **架构师水平**：能根据集群规模（Service/Endpoint 数）选模式，能基于 iptables-save/ipvsadm 输出做规则诊断，能在大集群平滑切换 ipvs
- **补足方向**：搭大集群压测对比；学习 ipvs 调度算法（rr/wrr/lc/sh）的适用场景；研究 KPR（kube-proxy replacement）

### 差距2：CoreDNS 解析链路与 ndots 陷阱不熟
> Day3发现

- **现状**：知道 CoreDNS 解析 Service 域名，但 ndots:5 陷阱、NodeLocal DNSCache、CoreDNS Plugin 机制不熟
- **架构师水平**：能基于 DNS 查询日志诊断解析慢的根因，能调优 ndots/cache TTL/CoreDNS 副本数，能设计 NodeLocal DNSCache 部署架构
- **补足方向**：精读 CoreDNS 官方 Plugin 文档；部署 NodeLocal DNSCache 对比命中率；复盘 DNS 慢的线上案例

### 差距3：Cilium eBPF 只有概念认知
> Day3发现，延续第2周差距2.1（Service Mesh Sidecar）

- **现状**：知道 eBPF 是趋势，但没用过 Cilium，对 KPR、Hubble、L7 NetworkPolicy 不熟
- **架构师水平**：能选型 Cilium 替代 Flannel/Calico，能启用 KPR 替代 kube-proxy，能用 Hubble 做流量观测
- **补足方向**：搭 Cilium 集群做对比测试；学习 eBPF 基础（bcc/bpftrace）；研究 Cilium Service Mesh（无 Sidecar 模式）

### 差距4：保留客户端 IP 的方案不全面
> Day3发现

- **现状**：用过 `externalTrafficPolicy: Local`，但对 PROXY Protocol、Cilium 直连等方案不熟
- **架构师水平**：能根据业务场景（医保审计、风控、限流按 IP）选最合适的客户端 IP 保留方案，能权衡流量分布不均的代价
- **补足方向**：学习 nginx-ingress PROXY Protocol 配置；研究 Cilium eBPF 直连保留源 IP；复盘啄木鸟云健康审计日志场景

### 差距5：NetworkPolicy 多租户隔离不熟
> Day3发现

- **现状**：写过简单 NetworkPolicy，但 default-deny-all + 白名单放行的多租户隔离策略不熟
- **架构师水平**：能为多医院场景设计 Namespace + NetworkPolicy + RBAC + Istio AuthorizationPolicy 四层隔离方案
- **补足方向**：学习 Cilium NetworkPolicy（L7 增强）；研究 Istio AuthorizationPolicy；制定多租户隔离 SOP

### 差距6：Ingress Controller 选型与 Gateway API 不熟
> Day3发现

- **现状**：只用过 nginx-ingress，对 APISIX / Istio Gateway / Gateway API 选型差异不熟
- **架构师水平**：能根据业务场景（API 网关 / 传统 Web / Service Mesh）选 Ingress Controller，能用 Gateway API 设计跨 Controller 兼容的网络方案
- **补足方向**：精读 Gateway API 官方文档；对比 APISIX 和 nginx-ingress 的插件能力；在新集群尝试 Gateway API

### 差距7：Service Mesh 与 K8s Service 的协作关系不清晰
> Day3发现，延续第2周差距2.1（Service Mesh Sidecar）

- **现状**：用过 Istio VirtualService，但与 K8s Service 的分层关系（寻址 vs 路由）不清晰
- **架构师水平**：能讲清"K8s Service 提供寻址 + Istio VirtualService 提供路由"的分层，能用 Istio 做灰度/蓝绿/故障隔离
- **补足方向**：精读 Istio 流量治理模型；研究 Istio mTLS 与 K8s NetworkPolicy 的协作；复盘啄木鸟云健康灰度发布场景

---
