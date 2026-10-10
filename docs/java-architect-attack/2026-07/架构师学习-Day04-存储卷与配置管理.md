# 架构师学习-Day04-存储卷与配置管理

> 日期：2026年07月23日（周四）
> 周主题：K8s 与云原生专题
> 出题日：Day04 - 存储卷与配置管理

---

## 背景

Day01 我们打了"K8s 核心架构 + Pod 容器设计模式"两根地基。Day02 我们打了"Workload 编排 + 发布工程"两根支柱。Day03 我们打了"Service 转发原理 + 网络模型"两根支柱，解决了"流量怎么进来 + Pod 之间怎么互访"。

但到这里我们又刻意回避了一个核心问题：**Pod 是易碎品，Pod 销毁后数据怎么办？配置怎么热更新？Secret 怎么安全管理？有状态服务的存储怎么设计？**

为什么 Day04 必须接着讲存储卷与配置管理：

1. **业务现实**：啄木鸟云健康的智慧体检/公卫平台涉及大量"数据持久化"场景：
   - 体检报告 PDF 文件（日均 10w 份，每份 1-5MB，需长期保存 5 年以上满足监管）
   - 医疗影像 DICOM 文件（单次 CT 检查 200-500MB，单年 PB 级存储）
   - Redis Cluster 数据（缓存预热数据、限流计数器）
   - MySQL 数据（订单、用户、医保结算）
   - 应用配置（数据库连接、医保 API 密钥）
   - 敏感 Secret（数据库密码、医保私钥、TLS 证书）

   任何一处存储设计出错，就是数据丢失 + 监管事故 + 业务停摆

2. **承接往周专题**：
   - MySQL 专题的"主从复制 + 分库分表" -> K8s 用 StatefulSet + PVC 部署 MySQL（每副本独立 PVC，Operator 管理生命周期）
   - Redis 专题的"主从复制 + 哨兵 + RDB/AOF 持久化" -> K8s 用 StatefulSet + PVC + StorageClass 实现 Redis 持久化
   - ES 专题的"冷热分离 + 节点角色" -> K8s 用 StatefulSet + 多 PVC + StorageClass 分级存储
   - 微服务专题的"Nacos 配置中心动态推送" -> K8s ConfigMap + reloader + Volume 挂载（无侵入配置热更新）
   - 支付专题的"幂等 + 对账 + 资金核算" -> K8s Secret 管理支付私钥 + 持久化存储对账文件
   - 医疗专题的"医疗影像 DICOM + 监管合规" -> K8s 对象存储（OSS/S3）+ PV 静态挂载 + CSI 驱动

3. **面试高频考点**：Volume 类型、PV/PVC/StorageClass 三层抽象、静态/动态供给、CSI 接口、StatefulSet 的 volumeClaimTemplates、ConfigMap 热更新机制、SubPath 陷阱、Secret 加密（etcd KMS / 外部 KMS）、有状态服务 Operator 模式 -- 中高级架构师岗几乎必问

4. **架构师思维跃迁**：从"我会挂 PVC"到"我能在 K8s 上设计多级存储架构（热/温/冷/归档）+ 配置热更新 + Secret 安全管理 + 有状态服务 Operator 化 + 跨可用区容灾 + 长期数据合规归档"

Day04 我们打两根支柱：

- **题目一（架构设计题）**：PV/PVC/StorageClass 与 CSI 存储体系 -- 解决"K8s 存储三层抽象的本质、动态供给怎么工作、CSI 接口怎么实现、有状态服务怎么选存储、跨 AZ 容灾怎么做"
- **题目二（架构设计题）**：ConfigMap/Secret 与有状态服务存储设计 -- 解决"配置怎么热更新、Secret 怎么加密、医疗影像 DICOM 怎么存、Redis/MySQL 在 K8s 上的存储设计、跨集群数据迁移"

---

## 题目一（架构设计题）：PV/PVC/StorageClass 与 CSI 存储体系

假设你作为新公司的架构师，负责啄木鸟云健康智慧体检平台在 K8s 上的存储架构设计。平台包含以下存储场景：

- 体检报告 PDF 文件存储（日均 10w 份，每份 1-5MB，访问模式：写入后偶尔查询，3 个月后转归档）
- Redis Cluster 持久化（6 节点，每节点 50GB，要求 Pod 重建数据不丢）
- MySQL 主从（主库 500GB，从库 500GB，要求高 IOPS + 跨 AZ 容灾）
- 应用日志（Filebeat 采集，节点级临时存储，无需持久化）
- 配置文件（Spring Boot application.yaml，需热更新）

请你回答：

1. K8s 的 Volume 体系是怎么演进的？emptyDir / hostPath / configMap / secret / persistentVolumeClaim / projected / csi 七种 Volume 类型分别解决什么场景？为什么需要 PV/PVC/StorageClass 三层抽象？三层抽象的职责边界？为什么不能用"Pod 直接挂存储"通吃？
2. PV 的 `accessModes`（ReadWriteOnce / ReadOnlyMany / ReadWriteMany / ReadWriteOncePod）含义与陷阱？为什么 NFS/CephFS 支持 RWX 但本地盘不支持？`persistentVolumeReclaimPolicy`（Retain / Delete / Recycle）的差异？生产环境为什么一般选 Retain 而不是 Delete？跨 AZ PV 怎么实现？
3. StorageClass 的动态供给链路是什么？`provisioner` / `parameters` / `volumeBindingMode` / `allowVolumeExpansion` / `reclaimPolicy` 五个字段怎么配？`WaitForFirstConsumer` 为什么是生产标配？StorageClass 的 `volumeBindingMode: Immediate` 在跨 AZ 场景下会出什么问题？
4. CSI（Container Storage Interface）是什么？为什么 K8s 要把存储驱动从"in-tree"迁移到"CSI out-of-tree"？CSI 的三大组件（Identity / Controller / Node）职责？CSI 的 `CreateVolume` / `DeleteVolume` / `NodePublishVolume` / `NodeStageVolume` 四个核心调用链路？主流 CSI 驱动（Ceph RBD/CephFS / 阿里云 CSI / AWS EBS CSI / OpenEBS / Longhorn）的选型差异？
5. 请为啄木鸟云健康 5 个存储场景分别选择最合适的 Volume 类型 + PV/PVC/StorageClass 配置（含 accessModes / reclaimPolicy / volumeBindingMode / storageClassName / 容量 / IOPS），并解释每个选择的工程理由。Redis Cluster 在 K8s 上的存储设计要特别注意什么？MySQL 主从的跨 AZ 容灾存储怎么设计？

### 作答区

#### 1. K8s Volume 体系演进与三层抽象

**核心一句话**：Volume = "Pod 内可挂载的存储卷"，K8s 把"容器文件系统"抽象成"Volume 资源"，让 Pod 与底层存储解耦。但 Volume 直接挂载需要"Pod 知道底层存储细节"，所以又抽象出 PV/PVC/StorageClass 三层。

**七种 Volume 类型**：

| Volume 类型 | 生命周期 | 存储介质 | 典型场景 | 陷阱 |
|------------|---------|---------|---------|------|
| emptyDir | Pod 销毁即丢 | 节点本地盘 | Pod 内多容器共享临时文件、缓存 | 数据不持久，节点宕机即丢 |
| hostPath | 节点本地 | 节点文件系统 | DaemonSet 访问节点资源（日志/CNI/容器运行时） | 安全风险大，Pod 重建可能丢 |
| configMap | Pod 销毁即丢 | etcd（小文件） | 配置文件挂载（1MB 以内） | 不能存大文件；热更新有延迟 |
| secret | Pod 销毁即丢 | etcd（base64 编码） | 敏感配置（密码/密钥/证书） | 默认仅 base64，需开 KMS 加密 |
| persistentVolumeClaim | 独立 Pod | 块/文件/对象存储 | 数据库、缓存、文件存储 | 三层抽象复杂，需 StorageClass |
| projected | Pod 销毁即丢 | etcd + ServiceAccount | 把多个源（ConfigMap/Secret/SA Token）投射到一个目录 | 仅 K8s 1.21+ |
| csi | 独立 Pod | CSI 驱动管理 | 直接用 CSI 驱动（绕过 PVC） | 配置复杂，不常用 |

**为什么需要 PV/PVC/StorageClass 三层抽象**：

```
┌─────────────────────────────────────────────────────────────┐
│  开发者视角（PVC）：我需要 50GB SSD 存储                       │
│  - 不关心底层是 Ceph / 阿里云 EBS / AWS EBS                  │
│  - 不关心挂在哪个节点                                         │
│  - 只声明容量 + 访问模式 + StorageClass                       │
└─────────────────────────────────────────────────────────────┘
                 ▲
                 │ 绑定（binding）
                 │
┌─────────────────────────────────────────────────────────────┐
│  集群管理员视角（PV）：集群有哪些存储资源                       │
│  - 静态供给：管理员手动创建 PV，等 PVC 来绑                   │
│  - 动态供给：StorageClass + CSI 自动创建 PV                   │
└─────────────────────────────────────────────────────────────┘
                 ▲
                 │ 动态供给（provisioning）
                 │
┌─────────────────────────────────────────────────────────────┐
│  存储管理员视角（StorageClass）：存储分级 + 供给策略             │
│  - fast-ssd：SSD，高 IOPS，expensive                         │
│  - cold-hdd：HDD，冷数据，cheap                              │
│  - archive：对象存储归档，cheapest                            │
│  - 每类对应一个 CSI provisioner                               │
└─────────────────────────────────────────────────────────────┘
```

**三层抽象的职责边界**：

| 层 | 职责 | 谁负责 |
|----|------|-------|
| PVC | 声明"我需要多少存储、什么访问模式" | 开发者 |
| PV | 描述"集群中实际存在的存储资源" | 集群管理员（或 StorageClass 自动创建） |
| StorageClass | 描述"存储的类型 + 供给策略 + CSI 驱动" | 存储管理员 |

**为什么不能用"Pod 直接挂存储"通吃**：

1. **职责耦合**：Pod YAML 写死底层存储细节（如 Ceph monitor 地址、阿里云 diskId），换存储就要改业务 YAML
2. **存储调度困难**：Pod 调度到节点 A，但存储在节点 B，跨节点访问性能差。需要"存储调度"配合 Pod 调度
3. **多租户隔离难**：开发者不该看到底层存储凭证，应由管理员通过 PV 隔离
4. **存储生命周期独立**：Pod 销毁后数据要保留（数据库），PVC 独立于 Pod 生命周期
5. **动态供给需求**：业务频繁创建 PVC，不可能每次都让管理员手动创建 PV

#### 2. PV accessModes 与 reclaimPolicy

**accessModes（访问模式）**：

| 模式 | 含义 | 支持的存储 | 典型场景 |
|------|------|-----------|---------|
| ReadWriteOnce (RWO) | 单节点读写 | 块存储（EBS/Ceph RBD/本地盘） | 数据库、Redis |
| ReadOnlyMany (ROX) | 多节点只读 | NFS/CephFS/对象存储 | 配置文件、模型文件只读挂载 |
| ReadWriteMany (RWX) | 多节点读写 | NFS/CephFS/CephFS/对象存储 | 文件共享、Web 静态资源 |
| ReadWriteOncePod (RWOP) | 单 Pod 读写（K8s 1.22+） | 块存储 | 防止同节点多 Pod 同时挂载 RWO PV |

**为什么 NFS/CephFS 支持 RWX 但本地盘不支持**：

- **块存储（RWO）**：磁盘是"块设备"，操作系统需要独占挂载到一台机器。两台机器同时挂载块设备会导致文件系统损坏（无分布式锁）
- **文件存储（NFS/CephFS）**：文件存储自带"分布式锁 + 元数据服务"，多客户端同时挂载安全
- **对象存储**：本质是 HTTP API，没有"挂载"概念，天然支持多客户端并发

**accessModes 陷阱**：

1. **RWO 多 Pod 共享**：同节点多个 Pod 可以同时挂载 RWO PV（K8s 1.22 前允许），但可能导致数据损坏（无文件锁）。1.22+ 用 RWOP 防止
2. **NFS 用 RWO**：NFS 实际支持 RWX，但 PV 写 RWO 会限制只能单节点挂载，浪费 NFS 能力
3. **数据库误用 RWX**：MySQL 用 NFS RWX，多 Pod 同时写同一份 MySQL 数据 = 数据损坏

**persistentVolumeReclaimPolicy**：

| 策略 | 含义 | PVC 删除后 PV 状态 | 数据状态 | 适用场景 |
|------|------|------------------|---------|---------|
| Retain | 保留 PV 与数据 | Released（已释放但保留） | 保留 | 生产环境（数据库、敏感数据） |
| Delete | 删除 PV 与底层存储 | 不存在 | 删除 | 云厂商动态供给（测试环境） |
| Recycle | 已废弃（K8s 1.31+ 移除） | Available | 数据擦除 | 已废弃，不要用 |

**生产环境为什么一般选 Retain 而不是 Delete**：

1. **防止误删**：PVC 误删时数据自动清空，无法恢复。Retain 保留数据，可以重新创建 PVC 绑定
2. **审计合规**：医疗数据要求"可追溯"，Delete 直接清空无法满足等保 2.0
3. **数据归档**：删除 PVC 后底层存储可手动归档到对象存储，再删除 PV
4. **故障恢复**：误删 PVC 后，重建 PVC 绑定原 PV 即可恢复

**Retain 流程**：

```
PVC 存在 -> PV 状态: Bound
   │
   │ 删除 PVC
   ▼
PV 状态: Released（数据保留）
   │
   │ 管理员手动处理：
   │   1. 备份/归档数据
   │   2. 删除 PV（手动决定是否删底层存储）
   │   3. 重新创建 PV 与 PVC 绑定（恢复数据）
   ▼
PV 状态: Available（可被新 PVC 绑定）
```

**跨 AZ PV 实现**：

云厂商的跨 AZ PV 一般通过"Volume Attachment + Topology"实现：

```yaml
# StorageClass 配置 volumeBindingMode: WaitForFirstConsumer
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: fast-ssd-cross-az
provisioner: disk.csi.aliyun.com
parameters:
  type: cloud_essd                     # 阿里云 ESSD
  performanceLevel: PL2                 # 性能等级
volumeBindingMode: WaitForFirstConsumer  # 关键：等 Pod 调度后再创建 PV
allowVolumeExpansion: true
reclaimPolicy: Retain
```

`WaitForFirstConsumer` 让 PV 创建等 Pod 调度完成，确保 PV 与 Pod 在同一 AZ：

```
Pod 调度 -> 节点 node-A (zone=az-1)
   ↓
StorageClass 看 Pod 所在 zone
   ↓
在 az-1 创建 PV（云盘必须在 az-1）
   ↓
Pod 挂载 PV（同 AZ 访问，低延迟）
```

如果用 `Immediate`，PV 创建时不知道 Pod 在哪，可能创建在 az-1，但 Pod 调度到 az-2，跨 AZ 挂载性能差或失败。

#### 3. StorageClass 动态供给链路

**动态供给完整链路**：

```
1. 开发者创建 PVC（storageClassName: fast-ssd）
        │
        ▼
2. PVC 控制器 watch 到新 PVC
   - 检查 storageClassName
   - 找到对应 StorageClass
        │
        ▼
3. CSI Provisioner（外部 Controller）调用 CSI 驱动
   - 调用 CreateVolume（GRPC）
   - CSI 驱动调用云厂商 API（如阿里云 CreateDisk）
   - 创建底层存储（如 ESSD 云盘）
        │
        ▼
4. PV 自动创建
   - CSI Provisioner 创建 PV 对象
   - PV spec 关联底层存储 ID（如 diskId=d-xxx）
   - PV 与 PVC 绑定
        │
        ▼
5. Pod 调度到节点
   - Pod spec 引用 PVC
        │
        ▼
6. CSI Node Plugin（节点上的 DaemonSet）调用 NodeStageVolume
   - 把云盘挂载到节点（如 /dev/vdb）
   - 格式化（如 ext4 / xfs）
   - 挂载到全局路径（/var/lib/kubelet/plugins/.../staging）
        │
        ▼
7. CSI Node Plugin 调用 NodePublishVolume
   - 把全局路径 bind mount 到 Pod 内路径
   - 如 /var/lib/mysql/data
        │
        ▼
8. Pod 启动，容器看到 /var/lib/mysql/data 已挂载
```

**StorageClass 关键字段**：

| 字段 | 含义 | 生产配置 |
|------|------|---------|
| `provisioner` | CSI 驱动名 | `disk.csi.aliyun.com` / `rbd.csi.ceph.com` |
| `parameters` | CSI 驱动参数 | `type: cloud_essd` / `performanceLevel: PL2` |
| `volumeBindingMode` | 何时创建 PV | `WaitForFirstConsumer`（生产标配） |
| `allowVolumeExpansion` | 是否支持扩容 | `true`（数据库必开） |
| `reclaimPolicy` | PVC 删除后处理 | `Retain`（生产）/ `Delete`（测试） |
| `mountOptions` | 挂载选项 | `["noatime", "nodiratime"]`（DB 优化） |
| `volumeBindingMode` | 调度时机 | `WaitForFirstConsumer`（跨 AZ 必选） |

**WaitForFirstConsumer 为什么是生产标配**：

`Immediate`（默认）的陷阱：

1. **跨 AZ 调度失败**：PV 创建在 az-1，但 Pod 调度到 az-2，云盘无法跨 AZ 挂载，Pod 永远 Pending
2. **节点亲和性冲突**：PV 有 topology 信息，与 Pod 的 nodeSelector 冲突，导致 Pod Pending
3. **资源浪费**：PV 创建后未绑定，长期占用云厂商配额，可能触发限流

`WaitForFirstConsumer` 的优势：

1. **PV 创建跟随 Pod 调度**：Pod 调度到哪个节点，PV 在该节点所在 AZ 创建
2. **拓扑感知**：自动考虑节点 zone / region / instance type
3. **避免跨 AZ 挂载**：PV 与 Pod 始终同 AZ，性能最优

**生产 StorageClass 示例（阿里云 ESSD）**：

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: fast-ssd-cross-az
provisioner: disk.csi.aliyun.com
parameters:
  type: cloud_essd
  performanceLevel: PL2                  # 单盘 IOPS 上限 5万
  description: "Production SSD for databases"
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
reclaimPolicy: Retain
allowVolumeExpansion: true
mountOptions:
- noatime                                # 数据库场景关闭 atime 更新
- nodiratime
```

#### 4. CSI（Container Storage Interface）

**CSI 是什么**：

CSI 是 K8s / Mesos / Docker 等容器编排系统共同的"存储驱动接口标准"，定义了"容器编排系统如何调用存储驱动"的 gRPC 接口。

**为什么 K8s 把存储驱动从 in-tree 迁移到 CSI out-of-tree**：

| 维度 | in-tree（旧） | CSI out-of-tree（新） |
|------|--------------|---------------------|
| 驱动位置 | K8s 源码内 | 独立进程（Sidecar/Deployment） |
| 升级 | 跟 K8s 版本绑定 | 独立升级 |
| 厂商接入 | 改 K8s 源码 | 实现 CSI 接口即可 |
| K8s 维护负担 | 重（每厂商一份代码） | 轻 |
| 测试 | K8s CI 全量 | 厂商自测 |
| K8s 1.21+ | in-tree 已废弃 | 全部迁移 CSI |

K8s 1.21+ 的 in-tree 卷插件已废弃，所有云厂商驱动迁移到 CSI。1.31+ 完全移除部分 in-tree 驱动（如 AWS EBS / GCE PD）。

**CSI 三大组件**：

```
┌─────────────────────────────────────────────────────────────┐
│  CSI Identity（身份服务）                                    │
│  - GetPluginInfo：驱动名/版本                                │
│  - GetPluginCapabilities：驱动能力（Controller/Volume）       │
│  - Probe：健康检查                                           │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  CSI Controller（控制面，集群级）                              │
│  - CreateVolume：创建底层存储                                 │
│  - DeleteVolume：删除底层存储                                 │
│  - ControllerPublishVolume：把存储挂载到节点（attach）         │
│  - ControllerUnpublishVolume：从节点卸载（detach）            │
│  - ValidateVolumeCapabilities：校验 PV 能力                  │
│  - ControllerExpandVolume：扩容                              │
│  - CreateSnapshot / DeleteSnapshot：快照                     │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  CSI Node（节点级，DaemonSet）                                │
│  - NodeStageVolume：格式化 + 挂载到全局路径                    │
│  - NodePublishVolume：bind mount 到 Pod 内路径                 │
│  - NodeUnpublishVolume：从 Pod 内卸载                          │
│  - NodeUnstageVolume：从全局路径卸载                           │
│  - NodeExpandVolume：节点级扩容（文件系统扩容）                │
│  - NodeGetCapabilities：节点能力                              │
└─────────────────────────────────────────────────────────────┘
```

**CSI 四个核心调用链路**：

```
创建 PV：
  Controller.CreateVolume
  → 底层存储创建（如阿里云 CreateDisk）

挂载到节点：
  Controller.ControllerPublishVolume
  → 底层 attach（如阿里云 AttachDisk）

格式化 + 挂载到 Pod：
  Node.NodeStageVolume
  → 格式化 + 挂载到 /var/lib/kubelet/plugins/.../staging

  Node.NodePublishVolume
  → bind mount 到 Pod 内 /var/lib/mysql/data

扩容：
  Controller.ControllerExpandVolume
  → 底层存储扩容（如阿里云 ResizeDisk）

  Node.NodeExpandVolume
  → 文件系统扩容（resize2fs / xfs_growfs）
```

**主流 CSI 驱动对比**：

| CSI 驱动 | 存储类型 | accessModes | 性能 | 适用场景 |
|---------|---------|------------|------|---------|
| Ceph RBD | 块存储 | RWO | 中高 | 自建机房、MySQL/Redis |
| CephFS | 文件存储 | RWX | 中 | 自建机房、文件共享 |
| 阿里云 CSI（disk） | 块存储 | RWO | 高（ESSD PL3 100万 IOPS） | 阿里云生产数据库 |
| 阿里云 CSI（nas） | 文件存储 | RWX | 中 | 阿里云文件共享 |
| 阿里云 CSI（oss） | 对象存储 | ROX | 低（HTTP 协议） | 阿里云对象存储、备份归档 |
| AWS EBS CSI | 块存储 | RWO | 高 | AWS 生产数据库 |
| OpenEBS | 容器原生块存储 | RWO | 中 | 自建机房、本地存储 |
| Longhorn | 分布式块存储 | RWO | 中 | 自建机房、K8s 原生 |

**架构师选型建议**：

- **云上生产数据库**：云厂商 CSI（阿里云 disk / AWS EBS），ESSD/IO2 高 IOPS
- **云上文件共享**：云厂商 NAS CSI（阿里云 NAS / AWS EFS）
- **自建机房数据库**：Ceph RBD（RWO）+ SSD
- **自建机房文件共享**：CephFS（RWX）
- **本地存储低延迟**：OpenEBS Local PV / 阿里云本地盘
- **备份归档**：对象存储 CSI（阿里云 OSS / AWS S3）
- **K8s 原生分布式块存储**：Longhorn（自建机房，运维简单）

#### 5. 啄木鸟云健康 5 个存储场景的选型

| 场景 | Volume 类型 | StorageClass | accessModes | reclaimPolicy | 容量 | IOPS | 工程理由 |
|------|------------|--------------|------------|--------------|------|------|---------|
| 体检报告 PDF | 对象存储（OSS）+ PV 静态挂载 | oss-archive | ROX | Retain | PB 级 | 低 | 海量小文件、低成本归档、HTTP 访问 |
| Redis Cluster | PVC + StorageClass | fast-ssd-cross-az | RWO | Retain | 50GB×6 | 1万+ | 高 IOPS、单节点独占、Pod 重建数据不丢 |
| MySQL 主从 | PVC + StorageClass | fast-ssd-cross-az | RWO | Retain | 500GB×2 | 5万+ | 高 IOPS、单节点独占、跨 AZ 容灾 |
| 应用日志 | emptyDir | 无 | - | - | 10GB | 中 | Pod 销毁即丢，Filebeat 采集后无需持久化 |
| 配置文件 | configMap | 无 | - | - | &lt;1MB | - | 配置热更新，无需持久化 |

**Redis Cluster 在 K8s 上的存储设计**：

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: redis-fast-ssd
provisioner: disk.csi.aliyun.com
parameters:
  type: cloud_essd
  performanceLevel: PL2                  # IOPS 5万，足够 Redis 高 QPS
volumeBindingMode: WaitForFirstConsumer  # 跨 AZ 必选
allowVolumeExpansion: true
reclaimPolicy: Retain                    # Redis 数据不能误删
mountOptions:
- noatime                                # Redis 不需要 atime
- nodiratime
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: redis
spec:
  serviceName: redis-headless
  replicas: 6
  template:
    spec:
      containers:
      - name: redis
        image: redis:7
        volumeMounts:
        - name: data
          mountPath: /data               # Redis RDB/AOF 持久化目录
        - name: config
          mountPath: /etc/redis/redis.conf
          subPath: redis.conf
      volumes:
      - name: config
        configMap:
          name: redis-config
  volumeClaimTemplates:                  # StatefulSet 独有：每副本独立 PVC
  - metadata:
      name: data
    spec:
      accessModes: [ "ReadWriteOnce" ]
      storageClassName: "redis-fast-ssd"
      resources:
        requests:
          storage: 50Gi
```

**Redis Cluster 存储设计特别注意点**：

1. **持久化配置**：开启 AOF（appendonly yes）+ RDB（save 900 1），AOF 文件更可靠但占用空间
2. **存储性能**：ESSD PL2 起步，单盘 IOPS 5万以上（Redis 是内存型但持久化写盘要快）
3. **reclaimPolicy: Retain**：Pod 重建后 PVC 与 PV 重新绑定，数据不丢
4. **Pod 与 PVC 稳定绑定**：StatefulSet + volumeClaimTemplates 保证 redis-0 永远挂 data-redis-0
5. **跨 AZ 部署**：6 副本分到 3 AZ（每 AZ 2 副本），主从跨 AZ，主节点宕机从节点升主
6. **备份策略**：每日 RDB snapshot 到对象存储，7 天保留
7. **陷阱：Redis Cluster 节点 IP 变化**：用 Headless Service + 稳定 DNS（redis-0.redis-headless），客户端通过 DNS 寻址

**MySQL 主从的跨 AZ 容灾存储设计**：

```yaml
# 主库在 az-1，从库在 az-2，跨 AZ 同步复制
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: mysql
spec:
  serviceName: mysql-headless
  replicas: 2                              # 1主1从
  template:
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchLabels:
                app: mysql
            topologyKey: topology.kubernetes.io/zone  # 跨 AZ 反亲和
      containers:
      - name: mysql
        image: mysql:8.0
        volumeMounts:
        - name: data
          mountPath: /var/lib/mysql
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: [ "ReadWriteOnce" ]
      storageClassName: "mysql-fast-ssd-cross-az"
      resources:
        requests:
          storage: 500Gi
```

**MySQL 跨 AZ 容灾存储设计要点**：

1. **跨 AZ 反亲和**：主从 Pod 强制分布到不同 AZ（podAntiAffinity + topologyKey: zone）
2. **每副本独立 PV**：StatefulSet + volumeClaimTemplates，data-mysql-0 / data-mysql-1
3. **存储跨 AZ**：volumeBindingMode: WaitForFirstConsumer，主库 PV 在 az-1，从库 PV 在 az-2
4. **半同步复制**：MySQL 半同步复制（rpl_semi_sync_master_wait_for_slave_count=1），主库写入至少一个从库确认才算成功
5. **数据备份**：每日 mysqldump + binlog 增量备份到对象存储，跨 Region 备份
6. **故障切换**：用 MHA / Orchestrator 管理 MySQL 主从切换，主库宕机自动提升从库
7. **Operator 推荐**：用 Oracle MySQL Operator / Vitess / TiDB Operator，避免手写 StatefulSet

**架构师视角的关键认知**：

- 选 StorageClass 的本质是"选存储介质 + 选调度策略 + 选生命周期策略"
- 块存储（RWO）适合数据库/缓存，文件存储（RWX）适合共享文件，对象存储适合海量小文件
- 跨 AZ 容灾必须用 `WaitForFirstConsumer`，否则 PV 与 Pod 可能跨 AZ
- `reclaimPolicy: Retain` 是生产标配，Delete 是测试环境的便利
- Redis/MySQL 在 K8s 上的存储设计要考虑"Pod 重建数据不丢 + 跨 AZ 容灾 + 备份归档 + Operator 管理"四件事

#### 与架构师水平的差距与补足方向

**差距1**：CSI 三大组件的调用链路只停留在概念，没有实际部署过 CSI 驱动
**补足**：在测试集群部署 Ceph CSI / 阿里云 CSI，用 `kubectl get csidriver` / `crictl logs` 观察组件行为

**差距2**：StorageClass 的 `volumeBindingMode: WaitForFirstConsumer` 在跨 AZ 场景的实战不深
**补足**：在多 AZ 集群对比 Immediate vs WaitForFirstConsumer 的 PV 创建位置，验证拓扑感知

**差距3**：Redis/MySQL 在 K8s 上的生产存储设计只用过 StatefulSet + PVC，没用过 Operator
**补足**：研究 Redis Operator / Oracle MySQL Operator 的 CRD 设计与备份恢复机制

**差距4**：对象存储（OSS/S3）通过 CSI 挂载的实战不深
**补足**：在测试集群用阿里云 OSS CSI 挂载体检报告 PDF，验证访问性能与成本

---

## 题目二（架构设计题）：ConfigMap/Secret 与有状态服务存储设计

K8s 中"配置"和"敏感数据"都是 Pod 运行时需要的输入，但管理方式不同。请你回答：

1. ConfigMap 与 Secret 的本质差异？Secret 默认仅 base64 编码，怎么实现真正加密？etcd 静态加密（EncryptionConfiguration）怎么配置？外部 KMS（阿里云 KMS / AWS KMS / HashiCorp Vault）怎么集成？Secret 的三种类型（Opaque / kubernetes.io/tls / dockerconfigjson）适用场景？
2. ConfigMap 的两种使用方式（环境变量 vs Volume 挂载）的差异？为什么 Volume 挂载能热更新但环境变量不能？ConfigMap 热更新的链路（kubelet -> API Server -> Volume 更新）？`configMapKeyRef` 与 `envFrom` 的差异？SubPath 陷阱是什么？怎么解决 ConfigMap 热更新后业务不感知的问题（reloader / 应用 watch）？
3. 有状态服务（Redis/MySQL/ES/Kafka）在 K8s 上的存储设计模式？为什么这些服务推荐用 Operator 而不是手写 StatefulSet？Operator 模式的本质是什么（CRD + Controller）？主流 Operator（Redis Operator / Strimzi Kafka Operator / ECK Elasticsearch Operator / Oracle MySQL Operator / Vitess / TiDB Operator）的能力对比？
4. 医疗影像 DICOM 存储怎么设计？为什么 DICOM 不适合用 PV/PVC 块存储？对象存储（OSS/S3）+ DICOM Web 协议的方案？冷热分层（hot/warm/cold/archive）怎么实现？长期归档（5 年以上）怎么设计？合规要求（不可篡改、可追溯、可恢复）怎么落地？
5. 综合设计：啄木鸟云健康平台要在 K8s 上做"配置中心 + Secret 管理 + 多级存储 + 数据备份归档 + 跨集群数据迁移"的完整存储架构，包含：① 应用配置（Spring Boot application.yaml + Apollo 配置中心）② 数据库密码/医保私钥/TLS 证书 ③ Redis/MySQL 持久化 ④ 体检报告 PDF + 医疗影像 DICOM ⑤ 跨集群数据迁移（DR 演练）。请给出完整方案。

### 作答区

#### 1. ConfigMap 与 Secret 的本质差异

**核心一句话**：ConfigMap 存"非敏感配置"（明文），Secret 存"敏感数据"（base64 编码 + 可加密），两者结构相似但安全模型不同。

| 维度 | ConfigMap | Secret |
|------|----------|--------|
| 数据类型 | 非敏感配置（application.yaml / log level） | 敏感数据（密码/密钥/证书） |
| 存储格式 | 明文 | base64 编码（默认非加密） |
| etcd 存储 | 明文 | base64（默认）/ 加密（开 KMS 后） |
| 单对象大小限制 | 1MB | 1MB（大 Secret 用 etcd --max-request-bytes 调） |
| Volume 挂载 | tmpfs（内存文件系统） | tmpfs（更安全，不落盘） |
| 环境变量 | envFrom configMapKeyRef | envFrom secretKeyRef |
| RBAC | 默认所有 SA 可读 | 通常限制 SA 读取 |
| 审计 | 弱 | 强（访问审计必需） |

**Secret 默认仅 base64 编码**：

```bash
# 创建 Secret
$ kubectl create secret generic db-password \
    --from-literal=password='P@ssw0rd123'

# 查看 Secret，看到的是 base64 编码
$ kubectl get secret db-password -o yaml
data:
  password: UEBzc3cwcmQxMjM=    # base64 解码即明文，等于没加密

# 解码
$ echo 'UEBzc3cwcmQxMjM=' | base64 -d
P@ssw0rd123
```

base64 不是加密，是"编码"（避免二进制数据在 YAML 中转义）。任何能读 Secret 的人都能解码。**真正加密必须开 etcd 静态加密或外部 KMS**。

**etcd 静态加密（EncryptionConfiguration）**：

K8s 1.13+ 支持 etcd 静态加密，把 Secret 数据在写入 etcd 前用 KMS / AES-CBC / AES-GCM 加密：

```yaml
# /etc/kubernetes/encryption-config.yaml
apiVersion: apiserver.config.k8s.io/v1
kind: EncryptionConfiguration
resources:
- resources:
  - secrets
  providers:
  - aescbc:
      keys:
      - name: key1
        secret: <base64-encoded-32-byte-key>     # AES-256 密钥
  - identity: {}                                  # 兜底（明文，用于读取老数据）
```

apiserver 启动时加 `--encryption-provider-config=/etc/kubernetes/encryption-config.yaml`，新写入的 Secret 用 AES-CBC 加密。

**陷阱**：静态加密的密钥要安全管理，密钥泄露 = 所有 Secret 泄露。密钥轮换要做（每 6 个月一次）。

**外部 KMS 集成**：

K8s 1.29+ 支持通过 KMS provider 接入外部 KMS（如阿里云 KMS / AWS KMS / HashiCorp Vault）：

```yaml
# EncryptionConfiguration with KMS
apiVersion: apiserver.config.k8s.io/v1
kind: EncryptionConfiguration
resources:
- resources:
  - secrets
  providers:
  - kms:
      apiVersion: v2
      name: aliyun-kms
      endpoint: unix:///var/run/kmsplugin/socket.sock  # KMS provider socket
      timeout: 3s
      cachesize: 1000
  - identity: {}
```

KMS provider 是一个 Sidecar 进程（如 aliyun-kms-provider），与 apiserver 同节点部署，通过 gRPC 通信。每次 Secret 读写都调用 KMS API 加解密。

**主流 KMS 方案对比**：

| KMS | 优势 | 劣势 | 适用场景 |
|-----|------|------|---------|
| etcd 静态加密（AES） | 简单、无外部依赖 | 密钥管理难、轮换复杂 | 中小集群 |
| 阿里云 KMS | 密钥托管、自动轮换 | 依赖云厂商 | 阿里云生产 |
| AWS KMS | 同上 | 依赖 AWS | AWS 生产 |
| HashiCorp Vault | 自建、多后端 | 运维复杂 | 自建机房、多云 |
| Sealed Secrets（Bitnami） | GitOps 友好 | 加密强度弱于 KMS | GitOps 场景 |

**Sealed Secrets 方案**：

```bash
# 客户端加密
$ echo -n 'P@ssw0rd123' | kubeseal --raw --namespace health --name db-password
AgBh...encrypted-string...

# 加密后的 SealedSecret 可以放到 Git 仓库
$ kubectl apply -f sealed-secret.yaml
# Sealed Secrets Controller 在集群内解密，生成 Secret
```

适合 GitOps 场景：Secret 不能直接放 Git（明文），用 SealedSecret 加密后放 Git，集群内 Controller 解密。

**Secret 三种类型**：

| 类型 | 用途 | 示例 |
|------|------|------|
| Opaque | 通用 Secret（任意 KV） | 数据库密码、API Key |
| kubernetes.io/tls | TLS 证书 + 私钥 | HTTPS 证书 |
| kubernetes.io/dockerconfigjson | 镜像仓库凭证 | 私有镜像仓库登录 |

```yaml
# kubernetes.io/tls 类型的 Secret
apiVersion: v1
kind: Secret
metadata:
  name: tls-secret
type: kubernetes.io/tls
data:
  tls.crt: <base64-cert>
  tls.key: <base64-key>
```

#### 2. ConfigMap 两种使用方式与热更新

**两种使用方式**：

**方式一：环境变量（envFrom / configMapKeyRef）**

```yaml
spec:
  containers:
  - name: app
    envFrom:
    - configMapRef:
        name: app-config               # 把整个 ConfigMap 的所有 KV 注入为环境变量
    env:
    - name: LOG_LEVEL
      valueFrom:
        configMapKeyRef:
          name: app-config
          key: log.level               # 单独注入某个 key
```

**方式二：Volume 挂载**

```yaml
spec:
  containers:
  - name: app
    volumeMounts:
    - name: config
      mountPath: /etc/app              # 整个 ConfigMap 挂载为目录
      # 或 subPath 单独挂载某个 key
    - name: config
      mountPath: /etc/app/application.yaml
      subPath: application.yaml
  volumes:
  - name: config
    configMap:
      name: app-config
```

**两种方式的差异**：

| 维度 | 环境变量 | Volume 挂载 |
|------|---------|------------|
| 热更新 | 不支持（Pod 启动后 env 固化） | 支持（kubelet 周期同步） |
| 单文件挂载 | 不适用 | subPath 单独挂载某 key |
| 业务感知 | 改 env 不感知，需重启 Pod | 业务需 watch 文件变化 |
| 大小限制 | env 总长度有限制 | ConfigMap 1MB |
| 配置格式 | 仅 KV | 任意格式（YAML/JSON/Properties） |

**为什么 Volume 挂载能热更新但环境变量不能**：

- **环境变量**：容器启动时通过 `docker run -e` 传入，进程启动后 env 固化在进程内存中。修改 ConfigMap 不会通知进程，进程也无 API 监听 env 变化
- **Volume 挂载**：kubelet 周期（默认 60s）watch ConfigMap 变化，更新 Volume 中的文件（用 symlink 原子替换）。业务进程通过 `inotify` / `watch` 文件变化感知

**Volume 热更新链路**：

```
1. 用户更新 ConfigMap
   ↓
2. kubelet watch 到 ConfigMap 变化
   ↓
3. kubelet 把新 ConfigMap 写入 /var/lib/kubelet/pods/<pod-uid>/volumes/.../..data
   - 用 symlink 原子替换：..data -> ..2026_07_23_10_00_00.xxx
   - 旧版本保留一段时间用于回滚
   ↓
4. 容器内的 /etc/app 看到新文件内容（bind mount 跟随 symlink）
   ↓
5. 业务进程通过 inotify watch 到文件变化，重新加载配置
```

**SubPath 陷阱**：

```yaml
# 陷阱：用 subPath 挂载的文件不会热更新！
volumeMounts:
- name: config
  mountPath: /etc/app/application.yaml
  subPath: application.yaml            # subPath 挂载，不热更新
```

原因：subPath 是直接 mount 文件（不是 symlink），kubelet 不会更新 subPath 挂载的文件。ConfigMap 更新后，subPath 挂载的文件还是旧的。

**解决方案**：

1. **不用 subPath**：挂载整个 ConfigMap 目录，业务读 `/etc/app/application.yaml`（会跟随 symlink 更新）
2. **用 reloader**：Reloader 监听 ConfigMap 变化，自动触发 Pod 滚动重启
3. **应用 watch**：业务用 `inotify` 或 Spring Cloud Kubernetes watch ConfigMap

**ConfigMap 热更新后业务不感知的解决方案**：

| 方案 | 实现 | 优势 | 劣势 |
|------|------|------|------|
| Reloader | 监听 ConfigMap/Secret 变化，自动触发 Deployment 滚动重启 | 通用、无侵入 | 重启 Pod 有损（连接中断、JVM 预热） |
| Spring Cloud Kubernetes | 应用 watch ConfigMap，触发 @RefreshScope | 无需重启 | 仅 Spring 应用 |
| Apollo / Nacos | 应用 watch 配置中心 | 实时推送 | 需独立配置中心 |
| 业务 inotify | 应用直接 watch 文件 | 最实时 | 业务侧实现复杂 |

**生产推荐方案**：

- **小集群 / 无配置中心**：ConfigMap + Reloader（自动重启）
- **中大型集群**：ConfigMap + Spring Cloud Kubernetes（热更新 + 滚动重启兜底）
- **大型集群 / 多环境**：Apollo / Nacos 配置中心（独立于 K8s，跨集群统一）

#### 3. 有状态服务的 Operator 模式

**为什么 Redis/MySQL/ES/Kafka 推荐用 Operator 而不是手写 StatefulSet**：

手写 StatefulSet 的问题：

1. **运维知识硬编码**：Redis Cluster 节点扩缩容需要"迁移 slot / 主从切换 / 集群再平衡"，手写 StatefulSet 不懂这些
2. **故障恢复靠人**：MySQL 主库宕机，需要人工判断哪个从库数据最新、手动提升主库、手动改应用连接
3. **备份恢复手写脚本**：mysqldump / RDB snapshot 都是手写 CronJob + 脚本，错误率高
4. **升级复杂**：Redis 6 -> 7 升级，需要逐节点升级 + slot 迁移 + 兼容性检查
5. **配置管理混乱**：每个服务的配置项不同，没有统一 CRD

Operator 模式的优势：

1. **领域知识编码到控制器**：Redis Operator 知道"slot 迁移 / 主从切换"，MySQL Operator 知道"主从同步 / 备份恢复"
2. **声明式运维**：用户声明 `redisCluster.replicas=6`，Operator 自动完成扩缩容全过程
3. **自动故障恢复**：MySQL 主库宕机，Operator 自动提升从库、改应用连接
4. **统一 CRD**：`RedisCluster` / `MySQLCluster` / `ElasticsearchCluster` 一致的 API

**Operator 模式的本质**：

```
┌─────────────────────────────────────────────────────────────┐
│  CRD（CustomResourceDefinition）                            │
│  - 定义"自定义资源"的结构（如 RedisCluster）                  │
│  - 是 K8s API 的扩展                                          │
└─────────────────────────────────────────────────────────────┘
                 ▲
                 │ 用户声明期望状态
                 │
┌─────────────────────────────────────────────────────────────┐
│  CR（Custom Resource）                                       │
│  - 用户创建的具体资源实例（如 my-redis-cluster）              │
│  - spec: { replicas: 6, persistence: true, ... }           │
└─────────────────────────────────────────────────────────────┘
                 ▲
                 │ watch CR 变化
                 │
┌─────────────────────────────────────────────────────────────┐
│  Controller（Operator）                                       │
│  - watch CR + 实际资源（StatefulSet / Service / ConfigMap）  │
│  - reconcile 闭环：期望状态 -> 实际状态                        │
│  - 编码领域知识（如 Redis slot 迁移）                         │
└─────────────────────────────────────────────────────────────┘
```

**Operator 与 K8s 内置控制器的关系**：

- K8s 内置控制器（Deployment / StatefulSet）= 通用 Pod 编排
- Operator = 领域特定控制器（在 StatefulSet 之上再加一层业务逻辑）

**主流 Operator 能力对比**：

| Operator | 管理对象 | 核心能力 | 适用场景 |
|---------|---------|---------|---------|
| Redis Operator（OT Container） | RedisCluster / RedisReplication | 集群模式 / 主从 / 哨兵 / 备份 | 自建机房 Redis |
| Strimzi Kafka Operator | Kafka / KafkaConnect / KafkaTopic | 集群管理 / Topic 管理 / Schema Registry | Kafka on K8s 事实标准 |
| ECK（Elasticsearch Operator） | Elasticsearch / Kibana | 集群管理 / 升级 / 快照 / 安全 | ES on K8s 官方 |
| Oracle MySQL Operator | MySQLInnoDBCluster | InnoDB Cluster / Router / 备份 | MySQL 官方 |
| Vitess Operator | VitessCluster | 分库分表 / MySQL 兼容 | 大规模 MySQL |
| TiDB Operator | TidbCluster | HTAP / MySQL 兼容 / 分布式 | 大规模 HTAP |
| Percona Operator for MySQL | PerconaServerForXtraDBCluster | PXC 集群 / 备份 / 监控 | Percona 用户 |

**架构师选型建议**：

| 业务规模 | 推荐 Operator |
|---------|-------------|
| 小规模（&lt; 10GB） | 手写 StatefulSet + 备份 CronJob |
| 中等规模（10GB-1TB） | Redis Operator / Oracle MySQL Operator / ECK |
| 大规模（> 1TB） | Vitess / TiDB（分布式） |
| 跨集群多活 | CockroachDB Operator / YugabyteDB Operator |

#### 4. 医疗影像 DICOM 存储设计

**DICOM 文件特点**：

- 单文件大：单次 CT 检查 200-500MB（切片数 × 单切片大小）
- 海量：单医院年增 10TB+，5 年累计 50TB+
- 访问模式：写入后偶尔查询（写多读少），3 个月后访问频率降 90%
- 监管要求：医疗影像至少保存 15 年（门诊）/ 30 年（住院），不可篡改、可追溯
- 协议：DICOM 协议（端口 104），不是 HTTP

**为什么 DICOM 不适合用 PV/PVC 块存储**：

1. **海量小文件性能差**：单 PV 是块设备，海量小文件导致 inode 耗尽 / 元数据性能差
2. **容量成本高**：块存储（ESSD PL2）每 GB 价格是对象存储的 5-10 倍
3. **冷热分层难**：块存储无法自动冷热分层，需手动迁移
4. **跨集群共享难**：PV 是集群级资源，跨集群共享需 NFS / CephFS，复杂
5. **合规归档难**：医疗影像需要"不可篡改"（WORM），块存储不原生支持

**对象存储（OSS/S3）+ DICOM Web 协议方案**：

```
┌─────────────────────────────────────────────────────────────┐
│  医疗影像存储架构                                              │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       │
│  │ PACS 系统    │  │ 影像浏览端   │  │ AI 辅诊      │       │
│  │ (HIS 集成)   │  │ (Web/移动)   │  │              │       │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘       │
│         │ DICOM Web         │               │                │
│         │ (QIDO/WADO/STOW)  │               │                │
│         ▼                   ▼               ▼                │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  DICOM Web 网关（Orthanc / dcm4che）                  │    │
│  │  - DICOM 协议 <-> HTTP 协议转换                       │    │
│  │  - QIDO-RS（查询）/ WADO-RS（获取）/ STOW-RS（存储）   │    │
│  └────────────────────────┬─────────────────────────────┘    │
│                           │                                  │
│                           ▼                                  │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  对象存储（阿里云 OSS / AWS S3）                       │    │
│  │  - 标准 Bucket：hot（30 天）/ warm（90 天）            │    │
│  │  - 归档 Bucket：cold（180 天）/ archive（5 年+）       │    │
│  │  - 生命周期规则自动分层                                 │    │
│  │  - 版本控制 + WORM（合规保留）                         │    │
│  └──────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

**冷热分层实现**：

| 层级 | 存储介质 | 访问频率 | 价格（每 GB/月） | 适用阶段 |
|------|---------|---------|----------------|---------|
| Hot | 标准存储 | 高（日均访问） | 高（0.12 元） | 30 天内（门诊复查） |
| Warm | 低频访问存储 | 中（月均访问） | 中（0.08 元） | 30-90 天（住院复查） |
| Cold | 归档存储 | 低（年访问） | 低（0.03 元） | 90-180 天 |
| Archive | 冷归档存储 | 极低（5 年内访问） | 极低（0.01 元） | 180 天-5 年 |
| Deep Archive | 深度冷归档 | 几乎不访问 | 最低（0.005 元） | 5 年以上（合规归档） |

**对象存储生命周期规则**：

```json
// OSS Bucket Lifecycle 规则
{
  "Rule": {
    "ID": "dicom-tiering",
    "Status": "Enabled",
    "Filter": { "Prefix": "dicom/" },
    "Transitions": [
      { "Days": 30, "StorageClass": "IA" },          // 30 天后转低频
      { "Days": 90, "StorageClass": "Archive" },     // 90 天后转归档
      { "Days": 180, "StorageClass": "ColdArchive" },// 180 天后转冷归档
      { "Days": 1825, "StorageClass": "DeepArchive" } // 5 年后转深度冷归档
    ],
    "NoncurrentVersionTransitions": [...],
    "Expiration": { "Days": 5475 }  // 15 年后过期（门诊影像）
  }
}
```

**长期归档设计（5 年以上）**：

1. **WORM（Write Once Read Many）**：对象存储"合规保留"功能，写入后不可删改，满足等保 2.0
2. **跨 Region 复制**：归档数据跨 Region 复制（如华东 1 -> 华北 2），防单 Region 故障
3. **磁带库备份**：超长期归档（10 年+）可考虑磁带库，成本最低
4. **校验机制**：定期 MD5 校验，防止数据腐烂
5. **索引分离**：DICOM 元数据（Patient ID / Study ID）存数据库（MySQL），文件存对象存储，通过 URL 关联

**合规要求落地**：

| 合规要求 | 技术实现 |
|---------|---------|
| 不可篡改 | 对象存储 WORM / 版本控制 + Object Lock |
| 可追溯 | 操作审计（OSS 访问日志）+ KMS 加密 |
| 可恢复 | 跨 Region 复制 + 定期恢复演练 |
| 最小权限 | RAM 子账号 + STS 临时凭证 + IP 白名单 |
| 数据脱敏 | DICOM De-identification 工具（如 dcmtk） |

#### 5. 啄木鸟云健康存储架构综合设计

**整体存储架构图**：

```
┌─────────────────────────────────────────────────────────────────────┐
│  啄木鸟云健康 K8s 存储架构                                              │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │  配置层（无状态）                                            │    │
│  │  - ConfigMap：application.yaml / logback.xml（< 1MB）       │    │
│  │  - Apollo 配置中心：业务动态配置（限流阈值/开关）             │    │
│  │  - Reloader：监听 ConfigMap 变化，自动滚动重启               │    │
│  └────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │  Secret 层（敏感数据）                                       │    │
│  │  - Opaque Secret：DB 密码 / Redis 密码 / API Key            │    │
│  │  - kubernetes.io/tls：HTTPS 证书 / mTLS 证书                │    │
│  │  - kubernetes.io/dockerconfigjson：私有镜像仓库凭证           │    │
│  │  - 加密：阿里云 KMS provider（etcd 静态加密）                │    │
│  │  - 凭证轮换：External Secrets Operator + KMS 自动轮换         │    │
│  └────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │  持久化层（有状态）                                          │    │
│  │                                                              │    │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐          │    │
│  │  │ Redis       │  │ MySQL       │  │ ES          │          │    │
│  │  │ Operator    │  │ Operator    │  │ ECK         │          │    │
│  │  │             │  │             │  │             │          │    │
│  │  │ 6 副本      │  │ 1主2从      │  │ 3 master    │          │    │
│  │  │ 50GB × 6    │  │ 500GB × 3   │  │ 1TB × 3     │          │    │
│  │  │ ESSD PL2    │  │ ESSD PL3    │  │ ESSD PL2    │          │    │
│  │  │ RWO         │  │ RWO         │  │ RWO         │          │    │
│  │  │ Retain      │  │ Retain      │  │ Retain      │          │    │
│  │  │ 跨 3 AZ     │  │ 跨 3 AZ     │  │ 跨 3 AZ     │          │    │
│  │  └─────────────┘  └─────────────┘  └─────────────┘          │    │
│  └────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │  对象存储层（海量文件）                                       │    │
│  │                                                              │    │
│  │  ┌─────────────────────────────────────────────────────┐    │    │
│  │  │  OSS Bucket: dicom-archive                            │    │    │
│  │  │  - Hot: 30 天内（标准存储）                            │    │    │
│  │  │  - Warm: 30-90 天（低频存储）                          │    │    │
│  │  │  - Cold: 90-180 天（归档存储）                         │    │    │
│  │  │  - Archive: 180 天-5 年（冷归档）                      │    │    │
│  │  │  - Deep Archive: 5 年+（深度冷归档）                   │    │    │
│  │  │  - WORM 合规保留 + KMS 加密 + 跨 Region 复制           │    │    │
│  │  └─────────────────────────────────────────────────────┘    │    │
│  │                                                              │    │
│  │  ┌─────────────────────────────────────────────────────┐    │    │
│  │  │  OSS Bucket: pdf-reports                              │    │    │
│  │  │  - 体检报告 PDF（10w/天，1-5MB/份）                    │    │    │
│  │  │  - 30 天后转低频，1 年后转归档                         │    │    │
│  │  └─────────────────────────────────────────────────────┘    │    │
│  └────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │  备份归档层（容灾）                                          │    │
│  │  - Velero：K8s 资源 + PV 备份到 OSS                         │    │
│  │  - MySQL：每日 mysqldump + binlog 增量到 OSS                 │    │
│  │  - Redis：每日 RDB snapshot 到 OSS                          │    │
│  │  - 跨 Region 复制：OSS 跨 Region 同步                       │    │
│  │  - DR 演练：每季度一次，从备份恢复到 DR 集群                  │    │
│  └────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
```

**配置层方案**：

```yaml
# ConfigMap 示例：Spring Boot 配置
apiVersion: v1
kind: ConfigMap
metadata:
  name: appointment-config
  namespace: health
data:
  application.yaml: |
    server:
      port: 8080
    spring:
      datasource:
        url: jdbc:mysql://mysql-headless:3306/appointment
        # 密码用 Secret 注入，不写在 ConfigMap
      redis:
        host: redis-headless
    management:
      endpoints:
        web:
          exposure:
            include: health,info,metrics,prometheus
  logback.xml: |
    <configuration>
      <appender name="STDOUT" class="ch.qos.logback.core.ConsoleAppender">
        <encoder><pattern>%d %-5level %logger{36} - %msg%n</pattern></encoder>
      </appender>
      <root level="INFO"><appender-ref ref="STDOUT" /></root>
    </configuration>
---
# Deployment 用 Reloader 自动重启
apiVersion: apps/v1
kind: Deployment
metadata:
  name: appointment
  namespace: health
  annotations:
    reloader.stakater.com/auto: "true"     # ConfigMap/Secret 变化自动重启
spec:
  replicas: 10
  template:
    spec:
      containers:
      - name: app
        image: appointment:1.0.0
        volumeMounts:
        - name: config
          mountPath: /etc/app              # 整目录挂载，不用 subPath
      volumes:
      - name: config
        configMap:
          name: appointment-config
```

**Apollo 配置中心衔接**：

- ConfigMap 存"启动配置"（端口、日志级别、Apollo 元数据）
- Apollo 存"业务配置"（限流阈值、开关、医保接口地址）
- 应用启动时从 ConfigMap 读 Apollo 元数据，连 Apollo 拉业务配置
- Apollo 推送变更，应用通过 @ApolloConfigChangeListener 热更新

**Secret 层方案**：

```yaml
# Opaque Secret：数据库密码
apiVersion: v1
kind: Secret
metadata:
  name: db-secret
  namespace: health
type: Opaque
data:
  mysql-root-password: <base64>            # KMS 加密后存 etcd
  mysql-app-password: <base64>
---
# TLS Secret：HTTPS 证书
apiVersion: v1
kind: Secret
metadata:
  name: tls-secret
  namespace: health
type: kubernetes.io/tls
data:
  tls.crt: <base64-cert>
  tls.key: <base64-key>
---
# External Secrets Operator：从外部 KMS 拉取
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: db-password-es
  namespace: health
spec:
  refreshInterval: 1h                     # 1 小时轮换一次
  secretStoreRef:
    name: aliyun-kms                       # 指向 KMS
    kind: SecretStore
  target:
    name: db-secret                        # 生成 K8s Secret
    creationPolicy: Owner
  data:
  - secretKey: mysql-root-password
    remoteRef:
      key: health/mysql-root-password      # KMS 中的 key
```

**External Secrets Operator 工作流**：

1. 用户在 KMS / Vault / AWS Secrets Manager 存密码
2. ExternalSecret 声明"从 KMS 拉取哪些 key"
3. External Secrets Operator 周期性从 KMS 拉取，生成 K8s Secret
4. 密码轮换：在 KMS 改密码，Operator 1 小时后自动同步，Reloader 自动重启 Pod

**持久化层方案**：

```yaml
# Redis Operator 示例
apiVersion: redis.redis.opstreelabs.com/v1beta2
kind: RedisCluster
metadata:
  name: redis-cluster
  namespace: health
spec:
  clusterSize: 6                          # 3 主 3 从
  clusterVersion: v7
  persistenceEnabled: true
  storage:
    volumeClaimTemplate:
      spec:
        accessModes: [ReadWriteOnce]
        storageClassName: redis-fast-ssd
        resources:
          requests:
            storage: 50Gi
  kubernetesConfig:
    image: quay.io/opstree/redis:v7.0.5
    resources:
      requests:
        cpu: 1
        memory: 2Gi
      limits:
        cpu: 2
        memory: 4Gi
  redisExporter:
    enabled: true
  backup:
    successfulJobsHistoryLimit: 3
    schedule: "0 2 * * *"                 # 每日 2 点备份
    storage:
      volumeClaimTemplate:
        spec:
          accessModes: [ReadWriteOnce]
          storageClassName: backup-storage
          resources:
            requests:
              storage: 100Gi
```

**对象存储层方案**：

```yaml
# OSS CSI 驱动挂载
apiVersion: v1
kind: PersistentVolume
metadata:
  name: oss-dicom-pv
spec:
  capacity:
    storage: 100Ti                        # 容量字段仅用于调度，OSS 无限容量
  accessModes:
  - ReadOnlyMany                          # 多 Pod 只读
  persistentVolumeReclaimPolicy: Retain
  csi:
    driver: ossplugin.csi.alibabacloud.com
    volumeHandle: oss-dicom-pv
    volumeAttributes:
      bucket: dicom-archive
      url: oss-cn-hangzhou-internal.aliyuncs.com
      otherOpts: "-o max_stat_cache_size=0 -o allow_other"
  mountOptions:
  - -o noatime
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: dicom-pvc
  namespace: health
spec:
  accessModes:
  - ReadOnlyMany
  storageClassName: ""
  volumeName: oss-dicom-pv
  resources:
    requests:
      storage: 100Ti
---
# Pod 挂载 OSS
apiVersion: apps/v1
kind: Deployment
metadata:
  name: pacs-gateway
  namespace: health
spec:
  template:
    spec:
      containers:
      - name: orthanc
        image: orthancteam/orthanc:23.6.0
        volumeMounts:
        - name: dicom-storage
          mountPath: /var/lib/orthanc/db
      volumes:
      - name: dicom-storage
        persistentVolumeClaim:
          claimName: dicom-pvc
```

**备份归档层方案**：

| 备份对象 | 工具 | 频率 | 保留 | 目标 |
|---------|------|------|------|------|
| K8s 资源（YAML） | Velero | 每日 | 30 天 | OSS |
| PV 数据 | Velero + Restic | 每日 | 30 天 | OSS |
| MySQL 全量 | mysqldump | 每日 2 点 | 7 天 | OSS |
| MySQL 增量 | binlog | 实时 | 7 天 | OSS |
| Redis | RDB snapshot | 每日 3 点 | 7 天 | OSS |
| ES | ECK Snapshot | 每日 4 点 | 7 天 | OSS |
| OSS 跨 Region | OSS 跨 Region 复制 | 实时 | 永久 | 异地 OSS |

**Velero 备份示例**：

```yaml
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: daily-backup
  namespace: velero
spec:
  schedule: "0 1 * * *"                   # 每日 1 点
  template:
    includedNamespaces:
    - health
    - middleware
    storageLocation: default
    ttl: 720h                             # 30 天保留
    snapshotVolumes: true
```

**跨集群数据迁移方案**：

**场景**：DR 演练，从主集群（杭州）迁移到 DR 集群（北京）。

```
1. 主集群：Velero 备份到 OSS（杭州）
   ↓
2. OSS 跨 Region 复制到北京
   ↓
3. DR 集群：Velero 从 OSS（北京）恢复
   ↓
4. 验证：业务、数据、配置一致性
   ↓
5. 切换流量到 DR 集群
```

**Operator 的备份恢复**：

- Redis Operator：自带 backup CRD，每日 RDB 到 OSS
- MySQL Operator：备份 CRD，mysqldump + binlog 到 OSS
- ECK：Snapshot CRD，ES snapshot 到 OSS

**架构师视角的关键认知**：

- 存储架构不是"挂个 PVC"，是"配置 + Secret + 持久化 + 对象存储 + 备份归档 + 跨集群迁移"六层一体的系统设计
- ConfigMap 适合"启动配置"，Apollo/Nacos 适合"业务动态配置"，二者协同
- Secret 必须开 etcd 静态加密 / KMS，base64 不是加密
- 有状态服务推荐 Operator 模式，避免手写 StatefulSet 的运维知识硬编码
- 医疗影像 DICOM 必须用对象存储 + 冷热分层 + WORM 合规保留，块存储不适合
- 跨集群数据迁移要靠"对象存储 + Velero + Operator 备份 CRD"三件套

#### 与架构师水平的差距与补足方向

**差距1**：ConfigMap 与 Apollo/Nacos 配置中心的边界不清晰
**补足**：对比 ConfigMap 与 Apollo 的能力（热更新、灰度发布、多环境），制定"启动配置 ConfigMap + 业务配置 Apollo"的协同方案

**差距2**：Secret 加密只用了 base64，没开过 KMS 静态加密
**补足**：在测试集群配置 EncryptionConfiguration，学习阿里云 KMS provider / External Secrets Operator

**差距3**：有状态服务只用过手写 StatefulSet，没用过 Operator
**补足**：研究 Redis Operator / Oracle MySQL Operator 的 CRD 设计，在测试集群部署

**差距4**：对象存储（OSS）通过 CSI 挂载的实战不深，医疗影像存储设计缺乏
**补足**：学习阿里云 OSS CSI 驱动配置，研究 DICOM Web 协议与 Orthanc/dcm4che 部署

**差距5**：跨集群数据迁移 / DR 演练只有理论
**补足**：用 Velero 在测试集群做 DR 演练，验证恢复时间目标（RTO）和恢复点目标（RPO）

---

## 能力差距梳理（Day04）

> 后续将统一汇总到 `架构师学习-能力差距梳理.md`

### 差距1：CSI 三大组件调用链路实战不足
> Day4发现

- **现状**：知道 CSI 是 K8s 存储驱动标准，但 CSI Identity / Controller / Node 三大组件的调用链路（CreateVolume / ControllerPublishVolume / NodeStageVolume / NodePublishVolume）只停留在概念
- **架构师水平**：能部署 CSI 驱动（如阿里云 CSI / Ceph CSI），能用 `crictl logs` / `kubectl get csidriver` 诊断 CSI 问题，能基于 CSI 接口调试存储异常
- **补足方向**：在测试集群部署 Ceph CSI / 阿里云 CSI，跟踪 CreateVolume 全链路日志；研究 CSI Spec 文档

### 差距2：StorageClass 跨 AZ 调度实战不深
> Day4发现

- **现状**：用过 StorageClass，但 `volumeBindingMode: WaitForFirstConsumer` 在跨 AZ 场景的实战不深
- **架构师水平**：能在多 AZ 集群对比 Immediate vs WaitForFirstConsumer 的 PV 创建位置，能设计跨 AZ 容灾的 StorageClass
- **补足方向**：在多 AZ 集群验证 WaitForFirstConsumer 的拓扑感知；研究跨 AZ PV 的故障切换

### 差距3：Redis/MySQL Operator 模式实战不足
> Day4发现，延续第2周差距4.1（StatefulSet + Operator）

- **现状**：有状态服务用过手写 StatefulSet + PVC，没用过 Operator 模式
- **架构师水平**：能用 Redis Operator / Oracle MySQL Operator / ECK 部署生产有状态服务，能自研简单 Operator（如医疗 IM 长连接网关的状态管理）
- **补足方向**：研究 Redis Operator / Oracle MySQL Operator 的 CRD 设计；学习 Operator SDK / Kubebuilder 自研 Operator

### 差距4：ConfigMap 与 Apollo 配置中心边界不清晰
> Day4发现，延续第5周差距3.1（K8s 与微服务衔接）

- **现状**：用过 ConfigMap 和 Apollo，但二者边界不清晰（什么配置放 ConfigMap，什么放 Apollo）
- **架构师水平**：能制定"启动配置 ConfigMap + 业务配置 Apollo"的协同方案，能用 Spring Cloud Kubernetes 实现配置热更新
- **补足方向**：对比 ConfigMap 与 Apollo 的能力矩阵（热更新、灰度发布、多环境）；制定啄木鸟云健康配置管理规范

### 差距5：Secret 加密只用了 base64，没开过 KMS
> Day4发现

- **现状**：Secret 默认 base64 编码，没开过 etcd 静态加密 / KMS
- **架构师水平**：能配置 EncryptionConfiguration 启用 etcd 静态加密，能集成外部 KMS（阿里云 KMS / HashiCorp Vault），能用 External Secrets Operator 实现凭证轮换
- **补足方向**：在测试集群配置 EncryptionConfiguration；学习 External Secrets Operator；研究 Sealed Secrets 的 GitOps 实践

### 差距6：医疗影像 DICOM 存储设计缺乏
> Day4发现

- **现状**：知道 DICOM 是医疗影像协议，但对象存储 + DICOM Web + 冷热分层 + WORM 合规的完整方案没设计过
- **架构师水平**：能为医疗影像设计 OSS + 生命周期规则 + WORM + KMS 加密 + 跨 Region 复制的完整方案，能集成 Orthanc / dcm4che DICOM Web 网关
- **补足方向**：学习阿里云 OSS 生命周期规则配置；研究 Orthanc / dcm4che 部署；学习 DICOM Web 协议（QIDO/WADO/STOW）

### 差距7：跨集群数据迁移与 DR 演练只有理论
> Day4发现

- **现状**：知道 Velero 备份恢复，但没做过完整的跨集群 DR 演练
- **架构师水平**：能用 Velero + Operator 备份 CRD 设计完整的 DR 方案，能量化 RTO / RPO，能定期做 DR 演练
- **补足方向**：用 Velero 在测试集群做 DR 演练；学习 Operator 的备份恢复 CRD；研究跨 Region 数据复制

### 差距8：SubPath 陷阱与 ConfigMap 热更新机制不熟
> Day4发现

- **现状**：用过 ConfigMap Volume 挂载，但 SubPath 不会热更新的陷阱不清楚，热更新机制（kubelet 周期同步 + symlink 替换）不熟
- **架构师水平**：能讲清 ConfigMap Volume 挂载的热更新链路，能用 Reloader / Spring Cloud Kubernetes / Apollo 解决热更新问题
- **补足方向**：研究 kubelet Volume Mount 的 symlink 机制；部署 Reloader 测试自动重启；学习 Spring Cloud Kubernetes 的 @RefreshScope

---
