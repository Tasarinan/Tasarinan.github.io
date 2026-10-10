# 架构师学习 Day04 梳理：DICOM 医学影像标准与 PACS 系统架构
> 架构师视角的提炼版｜适合复习与面试速记
>
> 周主题：医疗信息化专题

---

## 一、DICOM 标准：医学影像的"通信语言"

### 1.1 核心一句话
> **DICOM 既是协议、也是文件格式、又是信息模型。它把影像与上下文（患者/检查/序列）强绑定到一个 .dcm 文件中，每张影像都自带完整元数据，可独立传输与解析**
>
> 架构师必须能讲清 DICOM 的 5 大要素：文件格式、网络协议（DIMSE）、服务类（SOP）、信息模型（Patient/Study/Series/Instance 四级）、术语与编码（Transfer Syntax）。DICOM 与 HL7/FHIR 互补--文本数据走 HL7/FHIR，影像数据走 DICOM。

### 1.2 DICOM 文件结构（必背）

```
┌──────────────────────────────────┐
│ Preamble (128 字节，通常全 0)     │
├──────────────────────────────────┤
│ Magic "DICM" (4 字节)            │  <- 标识 DICOM 文件
├──────────────────────────────────┤
│ Meta File Info (Group 0002)      │  <- Transfer Syntax UID
├──────────────────────────────────┤
│ Data Set (一系列 Data Element)   │
│  ├─ Patient 模块 (0010,xx)       │
│  ├─ General Study 模块 (0008,xx) │
│  ├─ General Series 模块 (0020,xx)│
│  ├─ Image Pixel 模块 (0028,xx)   │
│  └─ Pixel Data (7FE0,0010)       │  <- 影像像素字节流
└──────────────────────────────────┘
```

每个 Data Element = Tag (Group, Element) + VR + Length + Value

### 1.3 Tag/VR/Length/Value 编码（必背）

| 字段 | 长度 | 说明 | 示例 |
|---|---|---|---|
| Tag | 4 字节 | Group + Element | (0010,0010) = Patient Name |
| VR | 2 字节 | 值类型（显式 VR） | PN/LO/DA/UI/OB/OW/SQ |
| Length | 2/4 字节 | Value 字节长度 | 6 |
| Value | 变长 | 实际数据 | "张三" |

**关键 Tag（必背）**：

| Tag | 含义 |
|---|---|
| (0010,0010) | Patient Name |
| (0010,0020) | Patient ID |
| (0010,0030) | Birth Date |
| (0010,0040) | Sex |
| (0008,0050) | **Accession Number（核心关联键）** |
| (0008,0060) | Modality（CT/MR/US/DR/ECG） |
| (0008,0020) | Study Date |
| (0008,1030) | Study Description |
| (0020,000D) | **Study Instance UID（DICOM 全局唯一标识）** |
| (0020,000E) | Series Instance UID |
| (0008,0070) | Manufacturer |
| (7FE0,0010) | Pixel Data |

### 1.4 Transfer Syntax（传输语法）

Transfer Syntax UID 决定 **字节序 + VR 表示 + 像素压缩方式**：

| UID | 名称 | 压缩 |
|---|---|---|
| 1.2.840.10008.1.2 | Implicit VR LE | 未压缩 |
| 1.2.840.10008.1.2.1 | Explicit VR LE | 未压缩 |
| 1.2.840.10008.1.2.4.70 | JPEG Lossless | JPEG 无损 |
| 1.2.840.10008.1.2.4.90 | JPEG 2000 Lossless | JPEG 2000 无损 |

> 架构师要点：设备 C-STORE 时通过 Presentation Context 协商 Transfer Syntax；PACS 接收时按选定的 Transfer Syntax 解码。

---

## 二、DICOM 网络协议：DIMSE 命令体系

### 2.1 DIMSE-C vs DIMSE-N

| 维度 | DIMSE-C | DIMSE-N |
|---|---|---|
| 全称 | Composite | Normalized |
| 操作对象 | 复合对象（CT/US/DR Image） | 标准化对象（Print Queue） |
| 操作特点 | 整体传输 | 单属性操作 |
| 命令 | C-STORE/C-FIND/C-MOVE/C-GET/C-ECHO | N-CREATE/N-SET/N-ACTION/N-EVENT-REPORT |
| 用途 | 影像存储/查询/拉取 | 打印队列、Storage Commitment |

### 2.2 DIMSE-C 五大命令（必背）

| 命令 | 方向 | 用途 |
|---|---|---|
| C-ECHO | 双向 | 连通性测试 |
| C-STORE | SCU -> SCP | 推送影像 |
| C-FIND | SCU -> SCP | 查询元数据 |
| C-MOVE | SCU -> SCP | 让 PACS 推送到第三方 |
| C-GET | SCU -> SCP | 主动拉取（少用） |

**SCU/SCP**：SCU = 客户端（发起），SCP = 服务端（响应）

### 2.3 Association 建立流程

```
T0: SCU -> SCP: A-ASSOCIATE-RQ
    - Calling AE Title / Called AE Title
    - Presentation Context List:
      Abstract Syntax (SOP Class UID) + Transfer Syntax List

T1: SCP -> SCU: A-ASSOCIATE-AC
    - 选定每个 Context 的 Transfer Syntax

T2: SCU -> SCP: P-DATA-TF (C-STORE-RQ + 影像)
T3: SCP -> SCU: P-DATA-TF (C-STORE-RSP)
... 重复

T4: SCU -> SCP: A-RELEASE-RQ
T5: SCP -> SCU: A-RELEASE-RP
```

### 2.4 SOP Class UID 与 SOP Instance UID

- **SOP Class UID** = 服务类 + IOD 的组合（"类型"），如 CT Image Storage = `1.2.840.10008.5.1.4.1.1.2`
- **SOP Instance UID** = 某个具体实例（"实例"），全局唯一

### 2.5 Storage Commitment

- 解决"设备 C-STORE 后不知道 PACS 是否真正持久化"
- 流程：C-STORE 完成后 -> N-ACTION 请求 -> PACS 异步确认 -> N-EVENT-REPORT 回调设备
- 体检场景：B 超推送后必须确认 PACS 落盘才能删本地缓存

---

## 三、DICOM 三大服务类（体检场景协同）

### 3.1 三大服务类

| 服务类 | 用途 | 命令 |
|---|---|---|
| Storage | 影像存储 | C-STORE |
| Query-Retrieve | 查询与拉取 | C-FIND + C-MOVE |
| Modality Worklist | 设备工作列表 | C-FIND (MWL) |

### 3.2 体检场景协同流程（必背）

```
体检系统/RIS              PACS              B 超设备
    │                       │                  │
1. 生成 MWL (预约/报到)     │                  │
    │                       │                  │
2.  <- C-FIND (MWL) ──────│──────────────────│  设备开机拉取当日清单
    │                       │                  │
3.  ── C-FIND RSP ──────>│                  │  返回清单
    │                       │                  │
4. 设备显示清单，医生选择患者                  │
    │                       │                  │
5. 设备采集影像，写入 DICOM Tag                │
   (Patient ID, Accession #, Study UID)        │
    │                       │                  │
6.                          │ <- C-STORE ──── │  推送影像
    │                       │                  │
7.                          │ ── C-STORE RSP> │
    │                       │                  │
8. 体检系统感知影像就绪                         │
   方式 A: 定时 C-FIND 反查 (轮询)             │
   方式 B: Storage Commitment                  │
   方式 C: PACS Webhook (推荐 Orthanc)         │
    │                       │                  │
9. 主检医生调阅                                │
   - C-FIND Study                              │
   - C-MOVE 到本地                              │
   - 渲染影像                                   │
```

### 3.3 Accession Number 是核心关联键

- 体检系统在申请单生成时分配（如 `EXAM202607090001`）
- 写入 MWL -> 设备采集时写入 DICOM 文件 -> PACS 收到后关联申请单
- 主检医生通过 Accession Number 反查 Study Instance UID

### 3.4 MWL 核心字段

| Tag | 含义 |
|---|---|
| (0010,0020) | Patient ID |
| (0010,0010) | Patient Name |
| (0008,0050) | Accession Number |
| (0040,1001) | Requested Procedure ID |
| (0032,1060) | Requested Procedure Description |
| (0008,0060) | Modality |
| (0040,0001) | Scheduled Station AE Title |
| (0040,0002) | Scheduled Procedure Step Start Date |
| (0040,0003) | Scheduled Procedure Step Start Time |

---

## 四、PACS 系统架构

### 4.1 PACS 核心组成

```
Modalities (设备)
    │ C-STORE
    ▼
PACS Server
├─ DICOM Listener
├─ Storage Router
├─ Database Index
├─ Archive Manager
└─ Query Interface
    │
    ├──────────┬──────────┐
    ▼          ▼          ▼
Hot SSD    Warm HDD    Cold (对象存储/磁带)
3 month    3 year      3+ year
    │
    ▼
Workstation
├─ 诊断工作站
├─ 主检工作站
├─ Web Viewer (OHIF)
└─ 移动端 Viewer
```

### 4.2 主流 PACS 厂商对比

| 厂商 | 类型 | 国内市场 |
|---|---|---|
| GE Centricity | 商业 | 大型三甲 |
| 飞利浦 IntelliSpace | 商业 | 大型三甲 |
| 西门子 syngo.via | 商业 | 大型三甲 |
| 东软 NeuPACS | 商业（国产） | 中大型 |
| 卫宁 Winning PACS | 商业 | 中型 |
| 嘉和美康 | 商业 | 中型 |
| **Orthanc** | **开源** | **中小/集成** |
| **dcm4che** | **开源** | **大型/自建** |
| 3D Slicer | 开源 | 科研 |

### 4.3 Orthanc vs dcm4che（必背）

| 维度 | Orthanc | dcm4che |
|---|---|---|
| 语言 | C++ | Java |
| 部署 | Docker 单容器，简单 | JBoss + DB，复杂 |
| 默认 DB | SQLite | MySQL/PostgreSQL |
| REST API | 内置 | 通过 dcm4chee-arc |
| DICOMweb | 插件 | 原生 |
| 集群 | 单机为主 | 支持集群 |
| 学习曲线 | 平缓 | 陡 |
| 适用 | 中小机构、集成 | 大型机构 |

---

## 五、体检系统集成 PACS

### 5.1 设备 DICOM 配置（4 项）

| 配置项 | 示例 |
|---|---|
| AE Title | "US_DEVICE_01" |
| Port | 104 / 11112 |
| 目标 PACS AE | "PACS_MAIN" |
| 目标 PACS IP+Port | 192.168.1.100:104 |

### 5.2 影像就绪感知的 3 种方式

| 方式 | 实现 | 优劣 |
|---|---|---|
| A. Tag 反查 | 定时 C-FIND 反查 Accession Number | 简单但延迟（1-5 分钟） |
| B. Storage Commitment | N-ACTION + N-EVENT-REPORT | 实时但部分 PACS 不支持 |
| C. PACS Webhook | Orthanc OnStableStudy 钩子 | 实时且可靠（推荐） |

### 5.3 Orthanc Webhook 配置

```json
{
  "Webhooks": {
    "OnStableStudy": "https://tj.example.org/api/pacs/notify"
  }
}
```

### 5.4 Orthanc Docker 部署（必背）

```yaml
version: '3'
services:
  orthanc:
    image: orthancteam/orthanc:latest
    ports:
      - "4242:4242"  # DICOM
      - "8042:8042"  # REST API
    volumes:
      - ./orthanc.json:/etc/orthanc/orthanc.json:ro
      - orthanc-data:/var/lib/orthanc/db
  postgres:
    image: postgres:15
    environment:
      - POSTGRES_DB=orthanc
      - POSTGRES_USER=orthanc
      - POSTGRES_PASSWORD=xxx
volumes:
  orthanc-data:
  postgres-data:
```

---

## 六、DICOMweb vs DIMSE

### 6.1 接口对比

| 维度 | DIMSE | DICOMweb |
|---|---|---|
| 协议 | TCP + 二进制 | HTTP/HTTPS RESTful |
| 查询 | C-FIND | QIDO-RS |
| 拉取 | C-MOVE/C-GET | WADO-RS |
| 存储 | C-STORE | STOW-RS |
| Web 友好 | 否 | 是 |
| CDN 加速 | 不支持 | 支持 |
| 跨网 | 不友好 | 友好 |
| 设备支持 | 原生 | 需改造 |

### 6.2 DICOMweb 三大接口（必背）

| 接口 | 全称 | 方法 | 用途 |
|---|---|---|---|
| QIDO-RS | Query by ID | GET | 查询元数据 |
| WADO-RS | Web Access | GET | 拉取影像 |
| STOW-RS | Store Over Web | POST | 上传影像 |

### 6.3 接口示例

```http
# QIDO-RS：查询某患者 Study
GET /dicomweb/studies?PatientID=PAT001
Accept: application/dicom+json

# WADO-RS：拉取 DICOM 文件
GET /dicomweb/studies/{studyUID}/series/{seriesUID}/instances/{instanceUID}
Accept: application/dicom

# WADO-RS：渲染为 JPEG（小程序友好）
GET /dicomweb/studies/{studyUID}/series/{seriesUID}/instances/{instanceUID}/rendered
Accept: image/jpeg

# STOW-RS：上传影像
POST /dicomweb/studies
Content-Type: multipart/related; type="application/dicom"
```

### 6.4 体检场景混合方案

```
设备侧 (DIMSE)               调阅侧 (DICOMweb)
   │                              │
   │ C-STORE                      │ QIDO + WADO-RS
   ▼                              ▼
边缘网关 (DICOM SCP)         API Gateway
   │                              │
   │ STOW-RS                      │
   ▼                              │
云端 PACS (Orthanc + DICOMweb 插件) <───┘
```

---

## 七、影像存储与归档

### 7.1 分层存储

| 层级 | 介质 | 保留期 | 时延 |
|---|---|---|---|
| 在线 Hot | SSD | 3 个月 | &lt; 100ms |
| 近线 Warm | HDD | 3 个月-3 年 | &lt; 1s |
| 离线 Cold | 对象存储/磁带 | 3 年+ | 1-60 min |

### 7.2 主流存储方案

**DB 索引 + 对象存储**：

```
PostgreSQL (元数据索引):
- Patient/Study/Series/Instance 表
- 通过 object_key 反查影像

对象存储 (影像):
- 路径: /studies/{studyUID}/series/{seriesUID}/instances/{instanceUID}.dcm
- 桶: hot-bucket / warm-bucket / cold-bucket
```

### 7.3 生命周期管理

```java
@Scheduled(cron = "0 0 1 * * ?")
public void archiveLifecycle() {
    // 3 个月前 Study: Hot -> Warm
    moveToStorage(studiesOlderThan(3, MONTHS), "WARM");
    
    // 3 年前 Study: Warm -> Cold
    moveToStorage(studiesOlderThan(3, YEARS), "COLD");
    
    // 30 年后 Study: 删除（门诊保留期）
    deleteStudiesOlderThan(30, YEARS);
}
```

### 7.4 多机构 SaaS 影像隔离

| 方案 | 适用 |
|---|---|
| 按机构分库 | 三甲机构、合规要求高 |
| 统一存储 + tenant_id 隔离 | 中小机构 |
| 混合（大客户私有 + 小客户共享） | 啄木鸟云健康 |

**统一存储 + tenant_id 隔离**：

```sql
CREATE TABLE study (
    id BIGINT PRIMARY KEY,
    tenant_id VARCHAR(32) NOT NULL,
    study_instance_uid VARCHAR(128),
    accession_number VARCHAR(64),
    object_key VARCHAR(256),  -- 含 tenant_id 前缀
    storage_tier VARCHAR(16),
    INDEX idx_tenant_date (tenant_id, study_date)
);
```

---

## 八、云原生 PACS 架构

### 8.1 多机构 SaaS 部署架构

```
三甲机构 A ─── 私有 Orthanc (本地) ─── 影像不出院
                │
                │ FHIR/DICOMweb 元数据同步
                ▼
           云端中台 (统一调阅入口)

中小机构 B ─┐
中小机构 C ─┼─> 云端 Orthanc 集群
中小机构 D ─┘   ├─ Orthanc 多实例 (无状态)
                ├─ PostgreSQL 主从 (多 AZ)
                ├─ 对象存储 (跨 AZ 复制)
                └─ CDN 加速
```

### 8.2 等保三级约束

| 要求 | 实现 |
|---|---|
| 数据本地化 | 三甲机构私有部署 |
| 传输加密 | TLS 1.2+，专线或 HTTPS |
| 访问审计 | 所有调阅操作日志化，保留 6 个月+ |
| 多因素认证 | 医生调阅需 MFA |
| 容灾备份 | 异地容灾，3-2-1 备份 |

### 8.3 影像上云链路

```
体检机构设备
    │ C-STORE
    ▼
边缘网关 (Orthanc 轻量部署)
├─ DICOM SCP
├─ 本地缓存 (PostgreSQL + 文件)
├─ 上传队列
└─ 重传器
    │
    │ STOW-RS (专线/HTTPS)
    ▼
云端 PACS (多 AZ)
    │
    ▼
互联网医院 / 调阅端
```

### 8.4 带宽估算（每日 1000 次体检）

| 检查 | 数据量 |
|---|---|
| B 超 × 600 | 30 GB |
| DR × 200 | 4 GB |
| CT × 100 | 50 GB |
| 心电 × 100 | 0.5 GB |
| **总计** | **85 GB/日** |

- 平均上行带宽：85GB / 8h ≈ 24 Mbps
- 峰值（5x）：120 Mbps
- 月存储成本：约 2000-5000 美元（含流量）

---

## 九、FHIR ImagingStudy 与 DICOM 集成

### 9.1 FHIR ImagingStudy 资源结构

```json
{
  "resourceType": "ImagingStudy",
  "subject": {"reference": "Patient/patient-001"},
  "started": "2026-07-09T10:00:00+08:00",
  "numberOfSeries": 1,
  "numberOfInstances": 50,
  "description": "腹部 B 超",
  "series": [{
    "uid": "1.2.840.xxxx.series.001",
    "modality": {"code": "US"},
    "instance": [{"uid": "1.2.840.xxxx.instance.001"}]
  }],
  "endpoint": [{"reference": "Endpoint/dicomweb-endpoint-001"}]
}
```

### 9.2 Endpoint 引用 DICOMweb

```json
{
  "resourceType": "Endpoint",
  "connectionType": {"code": "dicom-wado-rs"},
  "address": "https://pacs.example.org/dicom-web"
}
```

### 9.3 跨系统调阅协同链路

```
1. 互联网医院 -> FHIR Server: GET /DiagnosticReport?patient={id}
   返回 DiagnosticReport (含 imagingStudy 引用)

2. 互联网医院 -> FHIR Server: GET /ImagingStudy/{id}
   返回 ImagingStudy (含 StudyInstanceUID + Endpoint)

3. 互联网医院 -> PACS DICOMweb:
   GET /dicom-web/studies/{UID}/series/{UID}/instances/{UID}/rendered
   Accept: image/jpeg
   返回 JPEG 直接显示

4. 高级调阅 (多张):
   GET /dicom-web/studies/{UID}/metadata
   前端用 Cornerstone.js 渲染
```

### 9.4 DiagnosticReport 引用 ImagingStudy

```json
{
  "resourceType": "DiagnosticReport",
  "imagingStudy": [
    {"reference": "ImagingStudy/imaging-study-001"}
  ],
  "conclusion": "脂肪肝，建议定期复查"
}
```

---

## 十、AI 辅助诊断的影像集成

### 10.1 体检场景 AI 应用

| AI 应用 | 影像 | 价值 |
|---|---|---|
| 肺结节 AI 筛查 | CT | 早期肺癌 |
| 乳腺 AI 超声 | 超声 | 乳腺肿块 |
| 眼底 AI 筛查 | 眼底照相 | 糖尿病视网膜 |
| 骨密度 AI | DEXA | 骨质疏松 |
| 心电 AI | ECG | 心律失常 |

### 10.2 AI 推理结果存储方式

| 方式 | 适用 |
|---|---|
| DICOM SR (Structured Report) | 文本类结果（结节位置/大小） |
| DICOM Segmentation Object | 像素级分割（结节轮廓） |
| DICOM Secondary Capture | 标注截图 |
| FHIR Observation | 跨系统调阅 |
| FHIR DiagnosticReport | AI 报告整体呈现 |

### 10.3 AI 工作流

```
T0: 设备 C-STORE 推送影像到 PACS
T1: PACS 路由: Study -> AI 服务 (DICOM 转发或 Webhook)
T2: AI 服务接收影像，开始推理
T3: AI 推理完成 (30s-3min)
T4: AI 服务将结果写回 PACS (DICOM SR / Segmentation)
T5: AI 服务通知体检系统 (Webhook / MQ)
T6: 体检系统更新申请单 ("AI 推理完成")
T7: 主检医生看到 AI 结果 + 原影像
T8: 主检医生审核: 同意 / 修改 / 拒绝
T9: 主检医生签发报告 (DiagnosticReport.status = final)
```

### 10.4 推理延迟处理

| 延迟 | 策略 |
|---|---|
| &lt; 30s | 同步等待 |
| 30s-3min | 异步，主检先看影像，AI 结果出来后推送 |
| > 3min | 异步队列，先签发，AI 后补 |

### 10.5 AI 合规要求

| 要求 | 实现 |
|---|---|
| 模型备案 | NMPA 二类/三类医疗器械注册证 |
| 医生审核 | AI 结果不能直接签发 |
| 审计日志 | 推理过程 + 修改记录可追溯 |
| 模型版本 | 每次推理记录版本 |
| 失效回退 | AI 不可用时主检流程不阻塞 |

---

## 十一、面试速记清单

### 11.1 必背知识点

1. **DICOM 文件结构**：Preamble (128B) + DICM (4B) + Data Set (Tag+VR+Length+Value)
2. **核心 Tag**：Patient ID (0010,0020)、Accession Number (0008,0050)、Study Instance UID (0020,000D)、Modality (0008,0060)、Pixel Data (7FE0,0010)
3. **DIMSE-C 五命令**：C-ECHO / C-STORE / C-FIND / C-MOVE / C-GET
4. **DICOMweb 三接口**：QIDO-RS / WADO-RS / STOW-RS
5. **三大服务类**：Storage / Query-Retrieve / Modality Worklist
6. **Transfer Syntax**：决定字节序 + VR + 压缩方式
7. **Accession Number 是核心关联键**：体检申请单 -> MWL -> DICOM 文件 -> PACS -> 主检报告
8. **Orthanc vs dcm4che**：C++ 简单 vs Java 复杂，中小 vs 大型
9. **PACS 分层存储**：Hot SSD (3m) / Warm HDD (3y) / Cold 对象存储 (3y+)
10. **FHIR ImagingStudy** + Endpoint 引用 DICOMweb WADO URI

### 11.2 架构师必须能讲清的设计点

1. **多协议适配**：DIMSE (设备侧) + DICOMweb (调阅侧) + FHIR (跨系统) 的混合架构
2. **影像就绪感知**：3 种方式（Tag 反查 / Storage Commitment / Webhook）
3. **MWL 协同**：体检系统生成 MWL -> 设备 C-FIND 拉取 -> 采集后 C-STORE -> Accession Number 关联
4. **多机构 SaaS**：单租户私有 / 多租户共享 / 混合部署的选型
5. **影像上云**：边缘网关断网缓存 + 重传 + 云端多 AZ
6. **FHIR + DICOMweb 协同**：ImagingStudy + Endpoint + WADO-RS 的调阅链路
7. **AI 辅助诊断**：DICOM SR / Segmentation + 异步工作流 + 医生审核
8. **等保三级约束**：数据本地化 + 传输加密 + 访问审计 + MFA

### 11.3 与啄木鸟云健康场景的对齐

| 现状 | 演进方向 |
|---|---|
| 设备直推 + 私有协议 | MWL 标准化 + DICOM C-STORE |
| 设备厂家私有 SDK | DICOM 通用协议适配 |
| 影像调阅需登录 PACS 客户端 | Web 调阅（OHIF + DICOMweb） |
| 影像与体检报告分散 | FHIR ImagingStudy + DiagnosticReport 集成 |
| 单机构部署 | 边缘网关 + 云端 PACS 混合 |
| 无 AI 集成 | AI 辅助诊断（眼底 AI / 心电 AI）接入 |

### 11.4 跳槽到三甲医疗信息化公司的能力画像

- 能讲清 DICOM 协议体系（文件格式 + 网络协议 + 服务类）
- 能设计体检系统与 PACS 的集成方案（MWL + C-STORE + DICOMweb）
- 能部署 Orthanc 开源 PACS（Docker + PostgreSQL + 插件）
- 能设计云原生 PACS 架构（边缘网关 + 云端集群 + 对象存储）
- 能讲清 FHIR ImagingStudy 与 DICOM 的集成（Endpoint + WADO-RS）
- 能讲清 AI 辅助诊断的影像集成（DICOM SR + 工作流 + 医生审核）
- 能讲清医疗影像合规要求（等保三级 + 数据本地化 + NMPA 注册证）

---

## 十二、本日差距自评

| 维度 | 现状 | 架构师水平 | 补足 |
|---|---|---|---|
| 知识点 | DICOM 文件结构、Tag/VR、DIMSE-C 命令、Transfer Syntax、DICOMweb 三接口能讲清 | 能讲清协议细节（Presentation Context 协商失败处理、Storage Commitment 状态机） | 实践 Orthanc 部署，写一个 C-STORE + C-FIND Demo |
| 架构思维 | PACS 部署架构选型、DICOMweb vs DIMSE 选型能讲清 | 多机构 SaaS 影像合规边界、边缘网关工程实现细节 | 复盘啄木鸟云健康影像集成，规划"MWL + DICOMweb + 云原生 PACS"演进 |
| 工程细节 | Orthanc Docker 部署、REST API 调用、FHIR ImagingStudy + Endpoint 能写代码 | Orthanc 集群部署、PG 调优、对象存储接入、Cornerstone.js 渲染优化 | 部署完整 Orthanc 集群 + OHIF Viewer |
| 业务理解 | MWL -> C-STORE -> 调阅流程清晰、Accession Number 关联设计能讲清 | AI 工作流（异步推理 + 医生审核）、AI 推理结果到 FHIR 映射 | 调研肺结节 AI / 眼底 AI 的影像集成方案 |
| 合规意识 | 等保三级框架能讲清 | 医疗影像上云的具体合规、AI 医疗器械注册证、患者影像脱敏规则 | 学习《健康医疗数据安全指南》、NMPA AI 医疗器械分类 |