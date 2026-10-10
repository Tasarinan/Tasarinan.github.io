# 架构师学习 Day04 梳理：存储卷与配置管理

> 架构师视角的提炼版｜适合复习与面试速记
>
> 周主题：K8s 与云原生专题

---

## 一、存储卷在云原生架构中的定位

### 1.1 核心一句话

> **存储 = "Pod 易碎，数据要独立于 Pod 生命周期"，K8s 用 Volume + PV/PVC/StorageClass 三层抽象把存储与业务解耦**
>
> Volume 解决"Pod 内怎么挂存储"，PV/PVC/StorageClass 解决"集群级别怎么管理存储资源"，CSI 解决"K8s 怎么调用各家存储驱动"。

### 1.2 为什么需要三层抽象

| 痛点 | 三层抽象解法 |
| --- | --- |
| Pod 直接挂存储，YAML 写死底层细节 | PVC 声明需求，开发者不关心底层 |
| 集群管理员手动创建 PV 太累 | StorageClass + CSI 动态供给 |
| 多租户隔离（开发者不该看存储凭证） | PV/PVC 通过 RBAC 隔离 |
| 存储生命周期独立于 Pod | PVC 独立，Pod 销毁数据保留 |
| 跨 AZ 调度需考虑存储位置 | WaitForFirstConsumer 拓扑感知 |

### 1.3 七种 Volume 类型速记

| 类型 | 生命周期 | 介质 | 典型场景 |
| --- | --- | --- | --- |
| emptyDir | Pod 销毁即丢 | 节点本地盘 | 多容器共享临时文件 |
| hostPath | 节点本地 | 节点文件系统 | DaemonSet 访问节点资源 |
| configMap | Pod 销毁即丢 | etcd | 配置文件（&lt; 1MB） |
| secret | Pod 销毁即丢 | etcd | 敏感配置 |
| persistentVolumeClaim | 独立 Pod | 块/文件/对象 | 数据库、缓存 |
| projected | Pod 销毁即丢 | etcd + SA | 多源投射 |
| csi | 独立 Pod | CSI 驱动 | 直接用 CSI（少用） |

### 1.4 与往周专题的衔接

| 往周专题 | Day04 存储衔接 |
| --- | --- |
| MySQL 主从复制 | StatefulSet + PVC + Operator（Oracle MySQL Operator / Vitess） |
| Redis RDB/AOF 持久化 | StatefulSet + PVC + StorageClass（ESSD PL2 高 IOPS） |
| ES 冷热分离 | StatefulSet + 多 PVC + ECK Operator |
| Nacos 配置中心 | ConfigMap + Apollo/Nacos 协同（启动配置 vs 业务配置） |
| 支付对账文件 | PVC + 备份归档到对象存储 |
| 医疗影像 DICOM | 对象存储（OSS）+ DICOM Web + 冷热分层 + WORM |

---

## 二、PV/PVC/StorageClass 三层抽象

### 2.1 三层职责边界

| 层 | 职责 | 谁负责 |
| --- | --- | --- |
| PVC | 声明需求（容量/访问模式/StorageClass） | 开发者 |
| PV | 描述实际存储资源 | 管理员（或 StorageClass 自动） |
| StorageClass | 存储类型 + 供给策略 + CSI 驱动 | 存储管理员 |

### 2.2 动态供给链路

```
PVC 创建 -> PVC 控制器 -> CSI Provisioner 调用 CreateVolume
       -> 底层存储创建（如阿里云 CreateDisk）
       -> PV 自动创建并绑定 PVC
       -> Pod 调度到节点
       -> CSI Node Plugin 调用 NodeStageVolume（格式化 + 全局挂载）
       -> CSI Node Plugin 调用 NodePublishVolume（bind mount 到 Pod 内）
```

### 2.3 accessModes 速记

| 模式 | 含义 | 支持的存储 |
| --- | --- | --- |
| RWO | 单节点读写 | 块存储（EBS/Ceph RBD/本地盘） |
| ROX | 多节点只读 | NFS/CephFS/对象存储 |
| RWX | 多节点读写 | NFS/CephFS/对象存储 |
| RWOP | 单 Pod 读写（1.22+） | 块存储 |

**核心认知**：块存储不支持 RWX（无分布式锁），文件/对象存储支持。

### 2.4 reclaimPolicy 速记

| 策略 | PVC 删除后 | 数据 | 适用 |
| --- | --- | --- | --- |
| Retain | PV 保留（Released） | 保留 | 生产标配 |
| Delete | PV 与底层存储删除 | 删除 | 测试环境 |
| Recycle | 已废弃 | - | 不要用 |

**生产必选 Retain**：防误删 + 审计合规 + 数据归档 + 故障恢复。

### 2.5 WaitForFirstConsumer 为什么是生产标配

| 维度 | Immediate（默认） | WaitForFirstConsumer |
| --- | --- | --- |
| PV 创建时机 | PVC 创建即创建 PV | 等 Pod 调度后创建 PV |
| 跨 AZ | 可能 PV 与 Pod 跨 AZ | PV 跟随 Pod 同 AZ |
| 拓扑感知 | 无 | 自动考虑 zone / region |
| 资源浪费 | PV 未绑定占用配额 | 创建即绑定 |

**跨 AZ 必选 WaitForFirstConsumer**，否则 PV 可能创建在 az-1 但 Pod 调度到 az-2，云盘无法跨 AZ 挂载，Pod 永远 Pending。

---

## 三、CSI（Container Storage Interface）

### 3.1 为什么从 in-tree 迁移到 CSI

| 维度 | in-tree（旧） | CSI out-of-tree（新） |
| --- | --- | --- |
| 驱动位置 | K8s 源码内 | 独立进程 |
| 升级 | 跟 K8s 版本绑定 | 独立升级 |
| 厂商接入 | 改 K8s 源码 | 实现 CSI 接口 |
| K8s 1.21+ | 废弃 | 全部迁移 |

### 3.2 CSI 三大组件

| 组件 | 职责 | 核心调用 |
| --- | --- | --- |
| Identity | 身份与能力 | GetPluginInfo / GetPluginCapabilities / Probe |
| Controller | 控制面（集群级） | CreateVolume / DeleteVolume / ControllerPublishVolume / ControllerExpandVolume / CreateSnapshot |
| Node | 节点级（DaemonSet） | NodeStageVolume / NodePublishVolume / NodeExpandVolume |

### 3.3 CSI 四个核心调用链路

```
创建 PV:    Controller.CreateVolume -> 底层存储创建
挂载到节点: Controller.ControllerPublishVolume -> 底层 attach
格式化+挂载: Node.NodeStageVolume -> 格式化 + 全局路径
            Node.NodePublishVolume -> bind mount 到 Pod 内
扩容:      Controller.ControllerExpandVolume -> 底层扩容
            Node.NodeExpandVolume -> 文件系统扩容
```

### 3.4 主流 CSI 驱动对比

| CSI 驱动 | 类型 | accessModes | 适用场景 |
| --- | --- | --- | --- |
| Ceph RBD | 块 | RWO | 自建机房数据库 |
| CephFS | 文件 | RWX | 自建机房文件共享 |
| 阿里云 CSI（disk） | 块 | RWO | 阿里云生产数据库 |
| 阿里云 CSI（nas） | 文件 | RWX | 阿里云文件共享 |
| 阿里云 CSI（oss） | 对象 | ROX | 阿里云对象存储 |
| AWS EBS CSI | 块 | RWO | AWS 生产数据库 |
| OpenEBS | 容器原生块 | RWO | 自建机房本地存储 |
| Longhorn | 分布式块 | RWO | 自建机房 K8s 原生 |

### 3.5 架构师选型建议

- 云上生产数据库 -> 云厂商 CSI（ESSD/IO2）
- 云上文件共享 -> 云厂商 NAS CSI
- 自建机房数据库 -> Ceph RBD（RWO）+ SSD
- 自建机房文件共享 -> CephFS（RWX）
- 本地低延迟 -> OpenEBS Local PV
- 备份归档 -> 对象存储 CSI
- K8s 原生分布式块 -> Longhorn

---

## 四、ConfigMap 与 Secret

### 4.1 本质差异

| 维度 | ConfigMap | Secret |
| --- | --- | --- |
| 数据类型 | 非敏感配置 | 敏感数据 |
| 存储格式 | 明文 | base64（默认非加密） |
| etcd | 明文 | base64 / 加密（开 KMS） |
| Volume 挂载 | tmpfs | tmpfs |
| RBAC | 默认可读 | 通常限制读取 |
| 审计 | 弱 | 强 |

### 4.2 Secret 真正加密方案

| 方案 | 实现 | 适用 |
| --- | --- | --- |
| etcd 静态加密（AES） | EncryptionConfiguration + AES-CBC | 中小集群 |
| 外部 KMS | KMS provider + gRPC（阿里云 KMS / AWS KMS / Vault） | 大集群生产 |
| Sealed Secrets | 客户端加密 + Controller 解密 | GitOps 场景 |
| External Secrets Operator | 从 KMS / Vault / Secrets Manager 拉取 | 凭证轮换 |

### 4.3 Secret 三种类型

| 类型 | 用途 |
| --- | --- |
| Opaque | 通用 KV（密码/API Key） |
| kubernetes.io/tls | TLS 证书 + 私钥 |
| kubernetes.io/dockerconfigjson | 镜像仓库凭证 |

### 4.4 ConfigMap 两种使用方式

| 方式 | 热更新 | 业务感知 | 大小限制 |
| --- | --- | --- | --- |
| 环境变量（envFrom / configMapKeyRef） | 不支持 | 改 env 不感知，需重启 | env 总长度有限 |
| Volume 挂载 | 支持（kubelet 60s 同步） | 业务需 watch 文件 | 1MB |

### 4.5 Volume 热更新链路

```
用户更新 ConfigMap
  ↓
kubelet watch 到 ConfigMap 变化
  ↓
kubelet 把新 ConfigMap 写入 ..data 目录（symlink 原子替换）
  ↓
容器内 /etc/app 看到新内容（bind mount 跟随 symlink）
  ↓
业务通过 inotify 感知，重新加载
```

### 4.6 SubPath 陷阱

```yaml
# 陷阱：subPath 挂载，不热更新！
volumeMounts:
- name: config
  mountPath: /etc/app/application.yaml
  subPath: application.yaml            # 不热更新
```

原因：subPath 是直接 mount 文件（非 symlink），kubelet 不更新。

**解决**：
1. 不用 subPath，挂载整个 ConfigMap 目录
2. 用 Reloader 监听 ConfigMap 变化自动滚动重启
3. 应用 watch 文件变化

### 4.7 ConfigMap 热更新方案对比

| 方案 | 实现 | 优势 | 劣势 |
| --- | --- | --- | --- |
| Reloader | 监听 ConfigMap 变化自动重启 | 通用 | 重启有损 |
| Spring Cloud Kubernetes | 应用 watch + @RefreshScope | 无需重启 | 仅 Spring |
| Apollo / Nacos | 配置中心推送 | 实时 | 需独立组件 |
| 业务 inotify | 应用 watch 文件 | 最实时 | 实现复杂 |

**生产推荐**：
- 小集群 -> ConfigMap + Reloader
- 中大集群 -> ConfigMap + Spring Cloud Kubernetes
- 大集群 / 多环境 -> Apollo / Nacos

---

## 五、Operator 模式

### 5.1 为什么有状态服务推荐 Operator

手写 StatefulSet 的问题：
- 运维知识硬编码（slot 迁移 / 主从切换 / 集群再平衡）
- 故障恢复靠人
- 备份恢复手写脚本
- 升级复杂
- 配置管理混乱

Operator 优势：
- 领域知识编码到控制器
- 声明式运维
- 自动故障恢复
- 统一 CRD

### 5.2 Operator 模式本质

```
CRD（自定义资源定义）
  ↑ 用户声明期望状态
  │
CR（自定义资源实例，如 my-redis-cluster）
  ↑ watch CR 变化
  │
Controller（Operator）
  - watch CR + 实际资源
  - reconcile 闭环
  - 编码领域知识
```

### 5.3 主流 Operator 对比

| Operator | 管理对象 | 核心能力 |
| --- | --- | --- |
| Redis Operator | RedisCluster / RedisReplication | 集群 / 主从 / 哨兵 / 备份 |
| Strimzi Kafka Operator | Kafka / KafkaConnect / KafkaTopic | 集群 / Topic / Schema Registry |
| ECK | Elasticsearch / Kibana | 集群 / 升级 / 快照 / 安全 |
| Oracle MySQL Operator | MySQLInnoDBCluster | InnoDB Cluster / Router / 备份 |
| Vitess Operator | VitessCluster | 分库分表 / MySQL 兼容 |
| TiDB Operator | TidbCluster | HTAP / 分布式 |
| Percona Operator | PerconaServerForXtraDBCluster | PXC / 备份 / 监控 |

### 5.4 选型建议

| 规模 | 推荐 |
| --- | --- |
| 小（&lt; 10GB） | 手写 StatefulSet + 备份 CronJob |
| 中（10GB-1TB） | Redis Operator / Oracle MySQL Operator / ECK |
| 大（> 1TB） | Vitess / TiDB |
| 跨集群多活 | CockroachDB / YugabyteDB |

---

## 六、医疗影像 DICOM 存储设计

### 6.1 DICOM 文件特点

- 单文件大：CT 200-500MB
- 海量：单医院年增 10TB+
- 访问模式：写多读少，3 个月后访问降 90%
- 监管：门诊 15 年 / 住院 30 年，不可篡改、可追溯

### 6.2 为什么 DICOM 不适合块存储

1. 海量小文件性能差（inode 耗尽 / 元数据差）
2. 容量成本高（块存储是对象存储的 5-10 倍）
3. 冷热分层难（块存储无自动分层）
4. 跨集群共享难（PV 是集群级，跨集群需 NFS/CephFS）
5. 合规归档难（块存储无 WORM）

### 6.3 OSS + DICOM Web 方案

```
PACS / 影像浏览端 / AI 辅诊
  ↓ DICOM Web（QIDO/WADO/STOW）
DICOM Web 网关（Orthanc / dcm4che）
  ↓ HTTP
对象存储（OSS/S3）
  - Hot: 30 天内（标准）
  - Warm: 30-90 天（低频）
  - Cold: 90-180 天（归档）
  - Archive: 180 天-5 年（冷归档）
  - Deep Archive: 5 年+（深度冷归档）
  - WORM 合规保留 + KMS 加密 + 跨 Region 复制
```

### 6.4 冷热分层成本对比

| 层级 | 介质 | 价格（元/GB/月） | 适用阶段 |
| --- | --- | --- | --- |
| Hot | 标准存储 | 0.12 | 30 天内 |
| Warm | 低频 | 0.08 | 30-90 天 |
| Cold | 归档 | 0.03 | 90-180 天 |
| Archive | 冷归档 | 0.01 | 180 天-5 年 |
| Deep Archive | 深度冷归档 | 0.005 | 5 年+ |

**5 年归档成本**：1TB 数据全用 Hot = 7200 元/年；用分层 = 30 天 Hot + 60 天 Warm + 90 天 Cold + 3 年 Archive + 1.5 年 Deep Archive ≈ 600 元/年。**降 12 倍**。

### 6.5 合规要求落地

| 合规要求 | 技术实现 |
| --- | --- |
| 不可篡改 | 对象存储 WORM / Object Lock |
| 可追溯 | OSS 访问日志 + KMS 加密 |
| 可恢复 | 跨 Region 复制 + 定期恢复演练 |
| 最小权限 | RAM 子账号 + STS 临时凭证 + IP 白名单 |
| 数据脱敏 | DICOM De-identification 工具（dcmtk） |

---

## 七、综合存储架构设计

### 7.1 整体架构图

```
┌─────────────────────────────────────────────────────────┐
│  配置层（无状态）                                         │
│  - ConfigMap: application.yaml / logback.xml            │
│  - Apollo: 业务动态配置（限流阈值/开关）                  │
│  - Reloader: 自动滚动重启                                │
├─────────────────────────────────────────────────────────┤
│  Secret 层（敏感数据）                                    │
│  - Opaque: DB 密码 / API Key                            │
│  - TLS: HTTPS 证书                                       │
│  - 加密: 阿里云 KMS provider（etcd 静态加密）             │
│  - 轮换: External Secrets Operator                      │
├─────────────────────────────────────────────────────────┤
│  持久化层（有状态）                                       │
│  - Redis Operator (6 副本, ESSD PL2, RWO, Retain)       │
│  - MySQL Operator (1主2从, ESSD PL3, RWO, Retain)       │
│  - ECK ES Operator (3 master, ESSD PL2, RWO, Retain)    │
├─────────────────────────────────────────────────────────┤
│  对象存储层（海量文件）                                   │
│  - OSS Bucket: dicom-archive (WORM + KMS + 跨 Region)   │
│  - OSS Bucket: pdf-reports (生命周期分层)                │
├─────────────────────────────────────────────────────────┤
│  备份归档层（容灾）                                       │
│  - Velero: K8s 资源 + PV 备份到 OSS                     │
│  - MySQL: mysqldump + binlog 增量                       │
│  - Redis: RDB snapshot                                  │
│  - 跨 Region 复制 + 季度 DR 演练                         │
└─────────────────────────────────────────────────────────┘
```

### 7.2 配置层方案

- ConfigMap 存"启动配置"（端口、日志级别、Apollo 元数据）
- Apollo 存"业务配置"（限流阈值、开关、医保接口地址）
- 应用启动从 ConfigMap 读 Apollo 元数据，连 Apollo 拉业务配置
- Apollo 推送变更，应用通过 @ApolloConfigChangeListener 热更新

### 7.3 Secret 层方案

```yaml
# External Secrets Operator 从 KMS 拉取
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
spec:
  refreshInterval: 1h          # 1 小时轮换
  secretStoreRef:
    name: aliyun-kms
  target:
    name: db-secret            # 生成 K8s Secret
  data:
  - secretKey: mysql-root-password
    remoteRef:
      key: health/mysql-root-password
```

### 7.4 持久化层方案

- Redis Operator：6 副本，50GB × 6，ESSD PL2，RWO，Retain
- MySQL Operator：1 主 2 从，500GB × 3，ESSD PL3，RWO，Retain，跨 3 AZ
- ECK ES Operator：3 master + 3 data，1TB × 3，ESSD PL2

### 7.5 备份归档方案

| 对象 | 工具 | 频率 | 保留 | 目标 |
| --- | --- | --- | --- | --- |
| K8s 资源 | Velero | 每日 | 30 天 | OSS |
| PV 数据 | Velero + Restic | 每日 | 30 天 | OSS |
| MySQL 全量 | mysqldump | 每日 2 点 | 7 天 | OSS |
| MySQL 增量 | binlog | 实时 | 7 天 | OSS |
| Redis | RDB snapshot | 每日 3 点 | 7 天 | OSS |
| ES | ECK Snapshot | 每日 4 点 | 7 天 | OSS |
| OSS 跨 Region | OSS 跨 Region 复制 | 实时 | 永久 | 异地 OSS |

### 7.6 跨集群数据迁移

```
1. 主集群: Velero 备份到 OSS（杭州）
2. OSS 跨 Region 复制到北京
3. DR 集群: Velero 从 OSS（北京）恢复
4. 验证: 业务/数据/配置一致性
5. 切换流量到 DR 集群
```

---

## 八、架构师视角的关键认知

### 8.1 八条核心认知

1. **存储三层抽象不是冗余**：PVC 给开发者，PV 给管理员，StorageClass 给存储管理员，职责清晰
2. **块存储 RWO / 文件存储 RWX / 对象存储 ROX**：选 accessModes 前先选存储类型
3. **WaitForFirstConsumer 是跨 AZ 必选**：否则 PV 与 Pod 可能跨 AZ
4. **Retain 是生产标配**：Delete 是测试便利
5. **Secret base64 不是加密**：必须开 KMS 或 etcd 静态加密
6. **SubPath 挂载不热更新**：用整目录挂载或 Reloader
7. **有状态服务推荐 Operator**：避免手写 StatefulSet 的运维知识硬编码
8. **医疗影像 DICOM 必须用对象存储**：块存储不适合海量小文件 + 冷热分层 + WORM

### 8.2 存储架构六层一体

| 层 | 关键技术 |
| --- | --- |
| 配置层 | ConfigMap + Apollo + Reloader |
| Secret 层 | Opaque + TLS + KMS + External Secrets |
| 持久化层 | Redis/MySQL/ES Operator + StatefulSet + PVC |
| 对象存储层 | OSS + 生命周期 + WORM + KMS |
| 备份归档层 | Velero + Operator 备份 CRD + OSS 跨 Region |
| 跨集群迁移 | Velero + 跨 Region OSS + DR 演练 |

### 8.3 与往周专题的体系化衔接

| 往周专题 | Day04 存储衔接 |
| --- | --- |
| MySQL 主从 | StatefulSet + PVC + Oracle MySQL Operator |
| Redis RDB/AOF | StatefulSet + PVC + Redis Operator |
| ES 冷热分离 | ECK Operator + 多 PVC + StorageClass 分级 |
| Nacos 配置中心 | ConfigMap + Apollo 协同（启动 vs 业务） |
| 支付对账 | PVC + 备份归档到对象存储 |
| 医疗影像 DICOM | OSS + DICOM Web + 冷热分层 + WORM |
| CAP 分布式一致性 | etcd 静态加密 = CP；对象存储跨 Region = AP |

---

## 九、Day04 能力差距速查

| 差距 | 现状 | 架构师水平 |
| --- | --- | --- |
| CSI 三大组件调用链路 | 只停留在概念 | 能部署 + 调试 + 诊断 |
| StorageClass 跨 AZ 调度 | 实战不深 | 能设计跨 AZ 容灾 StorageClass |
| Redis/MySQL Operator | 用过手写 StatefulSet | 能用 Operator + 自研简单 Operator |
| ConfigMap 与 Apollo 边界 | 不清晰 | 能制定协同方案 |
| Secret 加密 | 只用 base64 | 能配 KMS + External Secrets |
| DICOM 存储设计 | 缺乏 | 能设计 OSS + 分层 + WORM 方案 |
| 跨集群 DR 演练 | 只有理论 | 能用 Velero 做 DR + 量化 RTO/RPO |
| SubPath 陷阱与热更新 | 不熟 | 能讲清机制 + 用 Reloader 解决 |

---
