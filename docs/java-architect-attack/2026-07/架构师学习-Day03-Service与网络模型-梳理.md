# 架构师学习 Day03 梳理：Service 与网络模型

> 架构师视角的提炼版｜适合复习与面试速记
>
> 周主题：K8s 与云原生专题

---

## 一、Service 在云原生架构中的定位

### 1.1 核心一句话

> **Service = "稳定的虚拟 IP + 域名 + 负载均衡"，把易碎的 Pod IP 抽象成稳定访问入口**
>
> 本质是"Service -> Pod IP 列表的对象存储映射 + kube-proxy 在节点上维护 iptables/ipvs 转发规则"。真正的负载均衡在内核态（netfilter/IPVS），kube-proxy 只是"规则维护者"。

### 1.2 为什么需要 Service

| 痛点 | Service 解法 |
| --- | --- |
| Pod IP 易碎（重建就变） | 稳定 ClusterIP + DNS 域名 |
| 多副本 Pod 客户端怎么选 | kube-proxy 内核态负载均衡 |
| 滚动发布期间 Pod IP 在变 | Endpoints 控制器 watch Pod 自动更新 |
| Pod IP 跨节点不可路由 | ClusterIP 是虚拟 IP，每个节点本地有 DNAT 规则 |

### 1.3 五种 Service 类型速记

| 类型 | clusterIP | 用途 |
| --- | --- | --- |
| ClusterIP | 分配 VIP | 集群内访问（默认） |
| NodePort | VIP + 节点端口 30000-32767 | 集群外访问（自建 LB 后端） |
| LoadBalancer | VIP + NodePort + 云厂商 LB | 云上对外暴露 |
| ExternalName | None（CNAME） | 集群内访问外部域名 |
| Headless | None | 直接返回 Pod IP 列表（StatefulSet 必须） |

### 1.4 Service 与往周专题的衔接

| 往周专题 | Service 衔接 |
| --- | --- |
| 微服务 Nacos 服务发现 | K8s DNS + Endpoints 控制器原生提供 |
| Redis 主从/哨兵 | Headless Service 让客户端稳定找到 redis-0 主节点 |
| 限流降级 Sentinel 集群限流 | 限流下沉到 Ingress / Service Mesh Sidecar |
| 支付幂等多可用区 | Service `topologyAwareHints` 跨 AZ 流量优化 |
| 医疗多医院隔离 | Namespace + NetworkPolicy 多租户隔离 |

---

## 二、Service -> Pod 转发链路

### 2.1 完整链路图

```
Pod A -> CoreDNS 解析 svc.namespace.svc.cluster.local -> ClusterIP
      -> iptables/ipvs DNAT 改写为 Pod IP
      -> CNI 路由到目标节点
      -> Pod B 收到请求
      -> 响应包经 conntrack 反向 NAT，源 IP 改回 ClusterIP
```

### 2.2 为什么 ClusterIP 是"虚拟 IP"但能转发

- 没有网络接口绑定（`ip addr` 看不到）
- 不会响应 ARP（节点不回应）
- 只在 iptables/ipvs 规则中存在
- 类比：邮编分拣中心编号，实际投递时改写为具体收件人

### 2.3 kube-proxy 的角色

- **不是代理**：流量不经过 kube-proxy 进程
- **是规则维护者**：watch Service/EndpointSlice，写 iptables/ipvs 规则
- **数据面在内核**：netfilter/IPVS 处理转发，性能高
- **进程挂了不影响存量流量**：规则已在内核中

### 2.4 调试技巧

- `ping ClusterIP` 不通但 `curl` 通：ClusterIP 只为 TCP/UDP 服务，不为 ICMP
- 测试 Service 通不通用 `curl` / `nc`，不要用 `ping`

---

## 三、Endpoints / EndpointSlice

### 3.1 Service 与 Endpoints 的关系

```
Service（抽象层：稳定 VIP + 域名 + 选择器）
    ↓ watch Service + Pod
EndpointSlice 控制器（kube-controller-manager 内）
    ↓ 写 EndpointSlice 对象到 etcd
EndpointSlice（数据层：实际 Pod IP 列表）
    ↓ watch EndpointSlice
kube-proxy（每节点）-> 更新 iptables/ipvs 规则
```

### 3.2 Endpoints vs EndpointSlice

| 维度 | Endpoints（旧） | EndpointSlice（1.21+ 默认） |
| --- | --- | --- |
| 单对象容量 | 一 Service 一对象，全 Pod IP | 一 Service 多切片，每片 100 IP |
| watch 长尾 | 一个 Pod IP 变化 = 全对象重发 | 只发变化的 slice |
| 协议支持 | IPv4/IPv6 | IPv4/IPv6/FQDN |
| 拓扑感知 | 无 | topologyHints（按 zone/region） |
| 大集群 | 5000 Pod 单对象超 etcd 1.5MB 上限 | 切片后单对象小 |

### 3.3 为什么 EndpointSlice 取代 Endpoints

1. **watch 放大效应**：kube-proxy / coredns / Istio 都 watch Endpoints，一变全推
2. **etcd 单对象上限**：5000+ Pod 的 Service 单 Endpoints 对象超 1.5MB
3. **拓扑感知**：EndpointSlice 支持 topologyHints，配合 `externalTrafficPolicy: Local` 实现同 AZ 优先

---

## 四、kube-proxy iptables vs ipvs

### 4.1 本质差异

| 维度 | iptables | ipvs |
| --- | --- | --- |
| 数据结构 | 线性链表 | 哈希表 |
| 规则数复杂度 | O(Service × Endpoint) | O(Endpoint) |
| 查找复杂度 | O(N) 线性 | O(1) 哈希 |
| 1万规则下 | 慢，规则更新卡顿 | 快，无感更新 |
| 调度算法 | random | rr/wrr/lc/sh/sed/dh |
| 内核依赖 | netfilter（默认） | ip_vs 模块（需加载） |
| 适用规模 | &lt; 1000 Service | > 1000 Service |

### 4.2 iptables 概率随机实现

```
-A KUBE-SVC-XXX -m statistic --mode random --probability 0.333 -j KUBE-SEP-AAA
-A KUBE-SVC-XXX -m statistic --mode random --probability 0.500 -j KUBE-SEP-BBB
-A KUBE-SVC-XXX -j KUBE-SEP-CCC
```

陷阱：
- 顺序依赖（必须从大到小排列）
- Endpoints 变化时所有概率重算重写
- 长连接复用导致实际流量偏离概率
- conntrack 命中后不走规则（长连接分布不均）

### 4.3 ipvs 调度算法选型

| 算法 | 适用场景 |
| --- | --- |
| rr | 默认，后端性能均匀 |
| wrr | 后端性能不均（混合 4C/8C） |
| lc | 长连接场景（gRPC/WebSocket） |
| sh | 会话保持（替代 sessionAffinity） |
| sed | 综合连接数和响应时间 |

### 4.4 大集群必选 ipvs 的四个理由

1. 规则爆炸：1000 Service × 10 Endpoint = 10000 规则，iptables 更新卡顿
2. 查找性能：iptables 线性 O(N)，ipvs 哈希 O(1)
3. 内核锁：iptables 修改持有 `xt_table_lock` 阻塞数据面；ipvs 用 RCU
4. 滚动雪崩：Endpoints 频繁变化时 iptables 重写阻塞，ipvs 几乎无感

---

## 五、会话保持 / 流量策略 / 客户端 IP

### 5.1 会话保持

```yaml
sessionAffinity: ClientIP
sessionAffinityConfig:
  clientIP:
    timeoutSeconds: 10800   # 默认 3 小时
```

- iptables 用 `recent` 模块记录客户端 IP
- ipvs 用 `sh`（Source-Hashing）算法
- 陷阱：NAT 后大量客户端被分到同一 Pod

### 5.2 流量策略

| 策略 | 选项 | 含义 | 副作用 |
| --- | --- | --- | --- |
| externalTrafficPolicy | Cluster（默认） | NodePort/LB 跨节点转发 | SNAT，丢客户端 IP |
| externalTrafficPolicy | Local | NodePort/LB 只转发本节点 Pod | 保留客户端 IP；本节点无 Pod 流量丢弃 |
| internalTrafficPolicy | Cluster（默认） | ClusterIP 跨节点转发 | 跨节点 SNAT |
| internalTrafficPolicy | Local | ClusterIP 只转发本节点 Pod | 减少跨节点流量 |

### 5.3 NodePort SNAT 链路

```
客户端 1.2.3.4 -> Node A:30080
   → externalTrafficPolicy: Cluster 默认
   → 跨节点转发到 Node B
   → SNAT 源 IP 1.2.3.4 -> Node A 内网 IP（避免回包走丢）
   → Pod 看到的是 Node A 内网 IP，看不到客户端真实 IP
```

### 5.4 保留客户端 IP 的方案

| 方案 | 实现 | 代价 |
| --- | --- | --- |
| externalTrafficPolicy: Local | 只转发本节点 Pod，不 SNAT | 流量分布不均 + 流量丢弃风险 |
| X-Forwarded-For / X-Real-IP | Ingress 加 HTTP 头 | 仅 HTTP |
| PROXY Protocol | LB -> NodePort 加 PROXY 头 | 需 Ingress Controller 支持 |
| HostNetwork | Pod 用节点网络，绕过 Service | 失去 Service 负载均衡 |
| Cilium eBPF | eBPF 直接保留源 IP | 需替换 CNI |

### 5.5 必须保留客户端 IP 的场景

- 医保审计（参保人 IP 追责）
- 风控反欺诈（同一 IP 多次提交识别）
- 限流按 IP（单 IP 限流）
- CDN 回源（节点 IP 白名单）
- 合规日志（等保 2.0 审计源 IP）

---

## 六、Ingress / Ingress Controller / Gateway API

### 6.1 L4 vs L7 流量入口

| 需求 | Service（L4） | Ingress（L7） |
| --- | --- | --- |
| TCP/UDP 转发 | 支持 | 不支持（HTTP only） |
| HTTP/HTTPS 转发 | 弱 | 原生 |
| URL 路由 | 不支持 | 支持 |
| Host 路由 | 不支持 | 支持 |
| TLS 终结 | 不支持 | 支持 |
| Header/Cookie 灰度 | 不支持 | 支持 |
| 限流/黑白名单 | 不支持（需 Istio） | 支持（nginx annotations） |

### 6.2 Ingress 资源 vs Ingress Controller

- K8s 内置 Ingress API，**不内置 Controller**
- Controller 独立部署（DaemonSet 或 Deployment）
- Controller watch Ingress 资源 -> 生成实际转发规则 -> 转发到 Service

### 6.3 主流 Ingress Controller 对比

| Controller | 实现基础 | 适用场景 |
| --- | --- | --- |
| nginx-ingress | Nginx + Lua | 中小规模、传统 Web（默认选择） |
| Traefik | Go 自研 | 个人项目、DevOps 友好 |
| APISIX | OpenResty + etcd | API 网关、插件丰富 |
| Istio Gateway | Envoy | 已用 Istio 的集群 |
| Gateway API | K8s 1.25+ 标准 | 未来趋势、跨 Controller 兼容 |

### 6.4 Gateway API 的关键变化

- 全协议：HTTP / TCP / UDP / gRPC / TLS
- 标准化：跨 Controller 兼容（摆脱 nginx 注解锁定）
- 角色分离：GatewayClass / Gateway / HTTPRoute 三层职责清晰

### 6.5 灰度发布的 Ingress 配合

```yaml
# 稳定版 Ingress
metadata:
  annotations:
    nginx.ingress.kubernetes.io/canary-weight: "90"
# 金丝雀 Ingress（同 host）
metadata:
  annotations:
    nginx.ingress.kubernetes.io/canary: "true"
    nginx.ingress.kubernetes.io/canary-weight: "10"
    nginx.ingress.kubernetes.io/canary-by-header: "x-canary"
    nginx.ingress.kubernetes.io/canary-by-header-value: "true"
```

**架构师认知**：Service 是 L4 抽象，无法做 L7 路由。**灰度 / 蓝绿 / A/B 必须用 Ingress 或 Service Mesh**。

---

## 七、CNI / Calico vs Flannel vs Cilium

### 7.1 CNI 解决什么问题

- 为 Pod 分配 IP
- 配置 Pod 网络接口（veth pair / bridge）
- 处理 Pod 跨节点通信
- 实现 NetworkPolicy（部分 CNI）

### 7.2 三大主流 CNI 对比

| CNI | 数据平面 | 模式 | NetworkPolicy | 性能 | 适用 |
| --- | --- | --- | --- | --- | --- |
| Flannel | 简单路由 | VXLAN（默认）/ Host-GW | 不支持 | 中等 | 小集群、入门 |
| Calico | iptables / eBPF | BGP / VXLAN / IPIP | 原生支持 | 高 | 中大集群、生产 |
| Cilium | eBPF | VXLAN / BGP / 直连 | 原生（增强 L7） | 极高 | 大集群、性能敏感 |

### 7.3 Overlay vs BGP 本质差异

```
Overlay（VXLAN/IPIP）：
  Pod 包封装成 Node 包，跨节点走 Node IP 路由
  优点：跨网段/跨云/跨 VPC 都能用
  缺点：封装开销 50 字节/包，MTU 减小，CPU 开销

BGP：
  Pod 包不封装，按 BGP 路由直接转发
  优点：无封装开销、性能高、可调试
  缺点：要求节点 L3 互通、BGP 路由表大
```

### 7.4 大规模生产倾向 Cilium 的六个理由

1. **性能**：eBPF 内核态处理，跳过 netfilter，延迟降 30%+
2. **替代 kube-proxy**：KPR，规则数无上限
3. **可观测**：Hubble 流量拓扑
4. **安全**：L3-L7 全层 NetworkPolicy
5. **Service Mesh 替代**：无 Sidecar 模式
6. **未来趋势**：K8s 1.25+ KPR 标准方案

### 7.5 eBPF 为什么是革命

- 内核可编程（安全沙箱，无需改内核源码）
- 跳过 iptables（socket / NIC 层处理）
- 观测无侵入（追踪任意内核函数）
- 不只是网络（安全 Falco / 追踪 bpftrace / 性能 BCC）

### 7.6 CNI 与 NetworkPolicy 的关系

- K8s NetworkPolicy 是 API 资源，**只定义不实现**
- CNI 插件实现规则
- Flannel 不支持（需配 Calico 子模块）
- Calico 原生支持
- Cilium 原生支持增强版（L7）

---

## 八、CoreDNS / DNS 解析链路

### 8.1 CoreDNS 在 K8s 中的作用

- 集群内 DNS 服务器（通常 ClusterIP 10.96.0.10）
- 解析 Service 域名 -> ClusterIP
- 解析 Pod 域名（Headless）-> Pod IP
- 转发外部域名到上游 DNS
- 通常 2 副本 Deployment + Service 暴露

### 8.2 `svc.namespace.svc.cluster.local` 解析链路

```
Pod A 访问 report-svc.health.svc.cluster.local
  ↓ 查 /etc/resolv.conf（nameserver 10.96.0.10）
CoreDNS kubernetes plugin 查 etcd
  ↓ 找到 Service -> ClusterIP
返回 A 记录
  ↓ Pod 拿到 ClusterIP，发起 TCP 连接
```

### 8.3 CoreDNS Plugin 机制

| 插件 | 作用 |
| --- | --- |
| kubernetes | 解析 K8s Service/Pod 域名 |
| forward | 转发非 K8s 域名到上游 |
| rewrite | 重写域名 |
| cache | 缓存响应降低 etcd 压力 |
| hosts | 静态域名解析 |
| prometheus | 暴露指标 |

### 8.4 DNS 慢是"隐形杀手"

- 每次请求都查 DNS（除非缓存）
- P99 高但平均正常，难察觉
- DNS 不可用 = 全站不可用
- 连锁反应：上游慢 -> CoreDNS 慢 -> 业务慢 -> 雪崩

### 8.5 ndots:5 陷阱

K8s 默认 Pod `resolv.conf` 配 `ndots:5`，含义：**域名点数 &lt; 5 时先按 search 列表补全后缀查询**。

访问 `www.baidu.com`（2 点 &lt; 5）的实际查询：

```
1. www.baidu.com.health.svc.cluster.local.   -> NXDOMAIN
2. www.baidu.com.svc.cluster.local.          -> NXDOMAIN
3. www.baidu.com.cluster.local.              -> NXDOMAIN
4. www.baidu.com.                            -> 成功
```

**4 次 DNS 查询才成功**，高 QPS 下放大为 CoreDNS 压力翻 4 倍。

### 8.6 ndots 陷阱解决方案

1. **外部域名加 `.`**：`www.baidu.com.`（绝对域名，跳过 search）
2. **降低 ndots**：`dnsConfig: { options: [{ name: ndots, value: "2" }] }`
3. **NodeLocal DNSCache**：每节点一份 DaemonSet 缓存
4. **业务侧 DNS 缓存**：JVM `networkaddress.cache.ttl=30`
5. **CoreDNS cache 调优**：增大容量、延长 TTL

### 8.7 NodeLocal DNSCache 架构

```
Pod -> NodeLocal DNSCache (169.254.20.10, DaemonSet)
        ↓ 未命中
       CoreDNS (10.96.0.10, Deployment)
```

- 每节点一份 DaemonSet
- 命中本地，未命中转发 CoreDNS
- 命中率 90%+，CoreDNS QPS 降一个数量级

---

## 九、NetworkPolicy / 多租户隔离

### 9.1 NetworkPolicy 解决什么

K8s 默认"全连通"：任何 Pod 都能访问任何 Pod。生产必须隔离：
- 不同业务不能互访
- 不同租户不能互访
- 外部访问只能走 Ingress，不能直连 Pod IP

### 9.2 default-deny-all 标准模式

```yaml
# 一、默认全拒
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: hospital-a
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
  ingress: []
  egress: []
---
# 二、放行 DNS（必需）
spec:
  egress:
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: kube-system
      podSelector:
        matchLabels:
          k8s-app: kube-dns
    ports: [{ protocol: UDP, port: 53 }, { protocol: TCP, port: 53 }]
```

### 9.3 NetworkPolicy 工作原理

- 一旦 Namespace 中存在任何 NetworkPolicy，进入"白名单模式"
- 未明确放行的流量都被拒绝
- 必须显式放行：DNS / Ingress -> 业务 / 业务 -> DB / 业务 -> 外部 API

### 9.4 NetworkPolicy vs 传统防火墙

| 维度 | NetworkPolicy | 传统防火墙 |
| --- | --- | --- |
| 层级 | L3/L4 | L3-L7 |
| 方向 | 东西向（Pod &lt;-> Pod） | 南北向（外部 &lt;-> 集群） |
| 策略维度 | Pod 标签 / Namespace / IP | IP / 端口 / 应用 / 用户 |
| L7 策略 | 不支持 | 支持 |
| 入侵检测 | 不支持 | 支持（IDS/IPS） |
| DDoS 防护 | 不支持 | 支持 |
| 持久化日志 | 弱 | 强（合规必需） |

### 9.5 多租户隔离三层架构

| 层 | 实现 |
| --- | --- |
| Namespace 隔离 | hospital-a / hospital-b 物理分离 |
| NetworkPolicy 隔离 | default-deny-all + 白名单放行本 NS 内 Pod 互访 |
| RBAC 隔离 | 每医院 ServiceAccount 权限隔离 |
| Istio AuthorizationPolicy | 细粒度 L7 授权（按 SA 限制访问） |

### 9.6 NetworkPolicy 局限与替代方案

| 局限 | 替代方案 |
| --- | --- |
| 不支持 L7（HTTP path/method） | Cilium NetworkPolicy L7 / Istio AuthorizationPolicy |
| 不支持按 Service 名称 | CiliumNetworkPolicy 支持 service selector |
| 不支持 FQDN egress | Cilium FQDN / Istio ServiceEntry |
| 策略数量爆炸 | Cilium 策略层级 / Istio AuthorizationPolicy |
| 跨集群不生效 | Istio Multi-Cluster AuthorizationPolicy |

---

## 十、多医院平台网络架构设计

### 10.1 整体架构图

```
互联网 -> WAF -> 云厂商 LB (保留客户端 IP)
                      ↓
        ┌─────────────┼─────────────┐
        ↓             ↓             ↓
   ingress-a      ingress-b      ingress-c
        ↓             ↓             ↓
   hospital-a    hospital-b    hospital-c
   (default-deny)(default-deny)(default-deny)
        └─────────────┼─────────────┘
                      ↓
                kube-system (CoreDNS / Cilium / NodeLocal DNS)
                      ↓
                外部服务 (医保局 API / 短信网关 / 支付通道)
```

### 10.2 Namespace 划分

| Namespace | 用途 | 隔离策略 |
| --- | --- | --- |
| `ingress-a/b/c` | 每医院独立 Ingress Controller | 仅本 NS Pod + LB 来源 |
| `hospital-a/b/c` | 每医院业务 Pod | default-deny，仅本 NS 互访 |
| `kube-system` | 集群组件 | 仅集群管理员访问 |
| `monitoring` | Prometheus / Grafana | 仅运维访问 |
| `middleware-shared` | 共享中间件 | 白名单访问 |

### 10.3 NetworkPolicy 策略矩阵

| 来源 \ 目的 | hospital-a | hospital-b | kube-system | middleware-shared | 外网 |
| --- | --- | --- | --- | --- | --- |
| hospital-a | 允许 | 拒绝 | 允许 DNS | 允许指定端口 | 允许 HTTPS |
| hospital-b | 拒绝 | 允许 | 允许 DNS | 允许指定端口 | 允许 HTTPS |
| ingress-a | 允许 | 拒绝 | 拒绝 | 拒绝 | 拒绝 |
| ingress-b | 拒绝 | 允许 | 拒绝 | 拒绝 | 拒绝 |
| 外网 | 拒绝（仅 LB） | 拒绝 | 拒绝 | 拒绝 | - |

### 10.4 CNI 选型：Cilium（eBPF）

- 大集群性能优势（eBPF 跳过 iptables）
- 替代 kube-proxy（KPR）
- L7 NetworkPolicy（按 HTTP path/method 限流）
- Hubble 流量观测（医疗合规日志）
- 多集群支持（未来跨 Region 容灾）

### 10.5 DNS 配置

- CoreDNS 3 副本（高可用）
- NodeLocal DNSCache DaemonSet（命中率 90%+）
- Pod `dnsConfig.ndots: 2`
- CoreDNS cache TTL 60s

### 10.6 Service Mesh（Istio）衔接

- 业务 NS 启用 Sidecar 注入
- Ingress -> Sidecar -> Pod 全链路 mTLS
- VirtualService 按比例灰度（5% -> 25% -> 50% -> 100%）
- DestinationRule 故障隔离（OutlierDetection）
- AuthorizationPolicy 细粒度授权
- Telemetry 全链路追踪

### 10.7 安全合规设计

1. **数据加密**：Pod 间 mTLS / DB TLS / 存储 KMS 加密
2. **审计日志**：API audit / Cilium Hubble / Ingress HTTP 日志
3. **身份认证**：外部 OIDC / 内部 SPIFFE
4. **授权**：K8s RBAC + Istio AuthorizationPolicy 双层
5. **网络隔离**：Namespace + NetworkPolicy + Istio 三层
6. **DDoS 防护**：WAF + Anti-DDoS + Ingress 限流

### 10.8 灰度发布设计

```
v1 stable 90% / v2 canary 10%
按 header（x-canary: true）灰度
按 user ID（hash % 100 < 10）灰度

流程：5% -> 25% -> 50% -> 100%，任一阶段异常 -> 一键回滚
故障隔离：OutlierDetection 异常率 > 5% 摘除 / 熔断 consecutive5xxErrors=5 / 限流 rqps 1000
```

---

## 十一、架构师视角的关键认知

### 11.1 七条核心认知

1. **Service 是 L4 抽象**，无法做 L7 路由。**灰度 / 蓝绿 / A/B 必须用 Ingress 或 Service Mesh**
2. **ClusterIP 不是负载均衡器**，是"虚拟 IP + iptables 规则"。真正负载均衡在内核态
3. **1000 Service 是 ipvs 分水岭**，超过必须从 iptables 切 ipvs
4. **保留客户端 IP 有代价**（流量分布不均 + 流量丢弃），需 LB 健康检查配合
5. **EndpointSlice 是大集群命根子**，watch 流量从 MB 级降到 KB 级
6. **DNS 是 K8s 最易被忽略的命脉**，NodeLocal DNSCache 是大集群标配
7. **多租户隔离不能只靠 NetworkPolicy**，必须 Namespace + NetworkPolicy + RBAC + Istio 多层

### 11.2 网络架构五位一体

| 维度 | 关键技术 |
| --- | --- |
| 南北向 | WAF + LB + Ingress / Gateway API |
| 东西向 | CNI（Cilium eBPF）+ NetworkPolicy |
| DNS | CoreDNS + NodeLocal DNSCache |
| Service Mesh | Istio VirtualService + DestinationRule |
| 安全合规 | mTLS + AuthorizationPolicy + 审计日志 |

### 11.3 与往周专题的体系化衔接

| 往周专题 | Day03 网络层衔接 |
| --- | --- |
| 微服务 Nacos | K8s DNS + Endpoints 控制器替代 Nacos watch |
| Redis 主从 | Headless Service 让客户端稳定找到 redis-0 |
| 限流降级 Sentinel | 限流下沉到 Ingress / Sidecar |
| 支付幂等容灾 | Service `topologyAwareHints` 跨 AZ 流量优化 |
| 医疗多医院隔离 | Namespace + NetworkPolicy + Istio 多层隔离 |
| CAP 分布式一致性 | K8s 控制面 CP（etcd Raft）/ 业务面 AP（Pod 多副本） |

---

## 十二、Day03 能力差距速查

| 差距 | 现状 | 架构师水平 |
| --- | --- | --- |
| kube-proxy iptables/ipvs 调优 | 没做过量化对比 | 能根据规模选模式 + 平滑切换 |
| CoreDNS 解析链路 | 不熟 ndots 陷阱 | 能调优 ndots/cache/NodeLocal DNSCache |
| Cilium eBPF | 只有概念认知 | 能选型替代 kube-proxy + Hubble 观测 |
| 保留客户端 IP | 只用过 Local 模式 | 能选 PROXY Protocol / Cilium 直连方案 |
| NetworkPolicy 多租户 | 不熟 default-deny | 能设计四层隔离方案 |
| Ingress Controller 选型 | 只用过 nginx-ingress | 能选 APISIX / Gateway API |
| Service Mesh 与 K8s Service | 分层关系不清晰 | 能讲清"寻址 vs 路由"分层 |

---
