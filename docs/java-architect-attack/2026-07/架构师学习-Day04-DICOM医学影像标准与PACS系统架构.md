# 架构师学习-Day04-DICOM医学影像标准与PACS系统架构

> 日期：2026年07月09日（周四）
> 周主题：医疗信息化专题
> 出题日：Day04 - DICOM 医学影像标准与 PACS 系统架构

---

## 背景

Day03 把镜头拉到"医疗信息互操作性标准"（HL7/FHIR），但只覆盖了文本类数据（病历、检验、报告）。体检场景有大量**影像类数据**——B 超、X 光、CT、DR、心电、眼底——这些走的是 **DICOM 标准**，而非 HL7/FHIR。Day04 把镜头彻底拉到"医学影像标准"。

为什么 DICOM/PACS 对你重要？

1. **体检业务的影像占比**：体检场景下影像检查占比约 30-40%（B 超、CT、X 光、DR、心电、眼底），影像数据量占总数据量 80%+（一次 CT 检查约 200MB-1GB）。智慧体检系统不能只懂 HIS/EMR/FHIR，必须懂 DICOM/PACS。
2. **能力差距 1.2 集中在 DICOM**：Day01 差距梳理明确指出"DICOM 协议细节不熟（DIMSE、SOP Class、Transfer Syntax）"，本周重点补足。
3. **啄木鸟云健康场景**：智慧公卫体检包含 B 超、心电、眼底等影像检查，体检系统需对接 PACS（或自建轻量 PACS）。当前啄木鸟的影像集成多是设备直推 + 设备厂家私有协议，DICOM 标准化不足，跳槽到三甲医疗信息化公司必须补齐。
4. **跳槽到更好的医疗公司**：三甲医院信息化公司（卫宁、东软、创业慧康、嘉和美康、医为）的产品矩阵中，PACS 是独立模块，DICOM 是硬技能。能讲清 DICOM 协议体系、PACS 部署架构、DICOMweb 上云、AI 辅助诊断集成，是医疗影像架构师的加分项。
5. **云原生 PACS 趋势**：传统 PACS 走 DIMSE（C-STORE/C-FIND/C-MOVE），云原生 PACS 走 DICOMweb（STOW/QIDO/WADO）。互联网医院、连锁体检机构、AI 辅助诊断都在推动 PACS 上云。理解"设备侧 DIMSE + 调阅侧 DICOMweb + 网关协议转换"的混合架构，是云原生医疗架构师的核心能力。
6. **AI 辅助诊断的影像集成**：体检场景 AI 应用（肺结节 AI 筛查 CT、乳腺 AI 超声、眼底 AI 筛查）越来越多，AI 服务的影像接入方式、推理结果的存储（DICOM SR/Segmentation Object）、AI 工作流的设计，是当前医疗信息化的热点。

本日三道题：
- 题目一：DICOM 协议体系与 PACS 系统架构（架构设计题）
- 题目二：体检系统集成 PACS 的工程实现（工程实战题）
- 题目三：云原生 PACS 架构与体检影像上云（选型权衡题）

---

## 题目一（架构设计题）：DICOM 协议体系与 PACS 系统架构

请回答：

1. DICOM 标准的核心组成（文件格式、网络协议、服务类、信息模型）？DICOM 文件结构（Preamble + DICM + Data Elements）？Tag（Group, Element）+ VR + Length + Value 的编码方式？Transfer Syntax 的作用（决定字节序、压缩方式）？为什么 DICOM 文件既能存影像又能存患者/检查/报告信息？
2. DICOM 网络协议体系：DIMSE-C（C-STORE/C-FIND/C-MOVE/C-GET/C-ECHO）与 DIMSE-N（N-CREATE/N-SET/N-ACTION/N-EVENT-REPORT）的区别？SOP Class UID 与 SOP Instance UID 的关系？Presentation Context 协商（Abstract Syntax + Transfer Syntax List）？关联（Association）的建立与释放流程？
3. DICOM 三大服务类的应用场景：Storage（C-STORE 推送影像）、Query-Retrieve（C-FIND 查询 + C-MOVE 拉取）、Modality Worklist（MWL，设备拉取体检项目）。三者如何在体检场景协同？比如 B 超设备开机后如何从 MWL 拉取当日体检清单、采集后如何 C-STORE 推送到 PACS、医生调阅时如何 C-FIND + C-MOVE？
4. PACS 系统架构：Modalities（设备）+ PACS Server（接收/存储/路由/索引）+ Workstation（诊断工作站）+ Archive（归档存储）。主流 PACS 厂商（GE、飞利浦、东软、医为）与开源方案（Orthanc、dcm4che、PacsOne）的对比？体检场景下的 PACS 部署架构（小规模 vs 多机构 SaaS）？

### 作答区

#### 1. DICOM 标准核心组成

**DICOM 标准简介**：

- DICOM = Digital Imaging and Communications in Medicine，医学数字成像与通信标准
- 由 NEMA（美国电气制造商协会）与 ACR（美国放射学会）共同制定，1993 年发布 3.0 版本（至今未发布 4.0，持续修订）
- 当前最新版本：DICOM 2024a（每年发布两次，a/b 版本）
- 覆盖：医学影像的**采集、存储、传输、打印、归档、查询、显示**全链路
- 不只是协议，也是**文件格式**（.dcm 文件）、**信息模型**（Patient/Study/Series/Instance 四级）、**服务类**（Storage/Query-Retrieve/Worklist/Print 等）

**核心组成（5 大要素）**：

```
┌──────────────────────────────────────────────────────┐
│  DICOM 标准                                          │
│                                                       │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐           │
│  │ 文件格式  │  │ 网络协议  │  │ 服务类    │           │
│  │ (.dcm)   │  │ (DIMSE)  │  │ (SOP)    │           │
│  └──────────┘  └──────────┘  └──────────┘           │
│        │             │             │                  │
│        └─────────────┼─────────────┘                  │
│                      ▼                                │
│              ┌──────────────┐                         │
│              │  信息模型     │                         │
│              │ Patient/Study│                         │
│              │ /Series/Inst │                         │
│              └──────────────┘                         │
│                      │                                │
│                      ▼                                │
│              ┌──────────────┐                         │
│              │  术语与编码   │                         │
│              │ (SOP UID/    │                         │
│              │ Transfer     │                         │
│              │ Syntax)      │                         │
│              └──────────────┘                         │
└──────────────────────────────────────────────────────┘
```

**1. 文件格式（.dcm）**：

DICOM 文件结构：

```
┌─────────────────────────────────────────────────────┐
│  Preamble (128 字节)                                 │
│  - 内容不限制，通常全 0                                │
│  - 用于文件头识别（与 TIFF 等格式兼容）                │
├─────────────────────────────────────────────────────┤
│  Magic "DICM" (4 字节)                              │
│  - 固定字符串 "DICM"，标识 DICOM 文件                │
├─────────────────────────────────────────────────────┤
│  Data Set (一系列 Data Element)                     │
│                                                      │
│  ┌─────────────────────────────────────────────┐   │
│  │  Data Element 1                             │   │
│  │  ├─ Tag (Group, Element) 4 字节             │   │
│  │  ├─ VR (Value Representation) 2 字节        │   │
│  │  ├─ Length 2 或 4 字节                      │   │
│  │  └─ Value 变长                              │   │
│  └─────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────┐   │
│  │  Data Element 2                             │   │
│  │  ├─ Tag (0010,0010) Patient Name           │   │
│  │  ├─ VR (PN)                                │   │
│  │  ├─ Length                                 │   │
│  │  └─ Value "张三"                            │   │
│  └─────────────────────────────────────────────┘   │
│  ...                                                 │
│  ┌─────────────────────────────────────────────┐   │
│  │  Data Element N (Pixel Data)                │   │
│  │  ├─ Tag (7FE0,0010) Pixel Data             │   │
│  │  ├─ VR (OW/OB)                             │   │
│  │  ├─ Length (可达几百 MB)                    │   │
│  │  └─ Value (影像像素字节流)                  │   │
│  └─────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

**2. Tag（Group, Element）+ VR + Length + Value 编码**：

| 字段 | 长度 | 说明 | 示例 |
|---|---|---|---|
| Tag | 4 字节 | Group（2 字节）+ Element（2 字节） | (0010,0010) = Patient Name |
| VR | 2 字节 | Value Representation，值类型（显式 VR） | PN = Person Name |
| Length | 2 或 4 字节 | Value 的字节长度 | 6（"张三" UTF-8 编码） |
| Value | 变长 | 实际数据 | "张三" |

**Tag 分组（Group）约定**：

| Group | 含义 | 示例 Element |
|---|---|---|
| (0008,xx) | Exam/Series 信息 | (0008,0060) Modality、(0008,0020) Study Date |
| (0010,xx) | Patient 信息 | (0010,0010) Patient Name、(0010,0020) Patient ID |
| (0020,xx) | Study/Series 标识 | (0020,000D) Study Instance UID、(0020,000E) Series Instance UID |
| (0040,xx) | 模板与工作流 | (0040,0275) Request Attributes Sequence |
| (7FE0,xx) | 像素数据 | (7FE0,0010) Pixel Data |
| (0002,xx) | Meta File Info | (0002,0010) Transfer Syntax UID |

**VR（Value Representation）类型**：

| VR | 含义 | 示例 |
|---|---|---|
| PN | Person Name | "张^三" |
| LO | Long String | "心内科" |
| SH | Short String | "001" |
| DA | Date | "20260709" |
| TM | Time | "120000" |
| DT | Date Time | "20260709120000" |
| UI | Unique Identifier | "1.2.840.10008.5.1.4.1.1.2"（CT Image Storage SOP Class） |
| IS | Integer String | "1024" |
| DS | Decimal String | "1.5" |
| CS | Code String | "M"（男）/ "F"（女） |
| OB | Other Byte | 字节流（如压缩影像） |
| OW | Other Word | 字流（如未压缩影像） |
| SQ | Sequence | 嵌套序列（如 Request Attributes Sequence） |

**3. Transfer Syntax（传输语法）**：

- Transfer Syntax UID = 一个标识，决定 **DICOM Data Set 的字节编码方式**
- 三要素：字节序（Little/Big Endian）、VR 表示（显式/隐式）、像素数据压缩方式（未压缩/JPEG Lossless/JPEG 2000/RLE 等）

| Transfer Syntax UID | 名称 | 字节序 | VR | 压缩 |
|---|---|---|---|---|
| 1.2.840.10008.1.2 | Implicit VR Little Endian | LE | 隐式 | 未压缩 |
| 1.2.840.10008.1.2.1 | Explicit VR Little Endian | LE | 显式 | 未压缩 |
| 1.2.840.10008.1.2.2 | Explicit VR Big Endian | BE | 显式 | 未压缩 |
| 1.2.840.10008.1.2.4.50 | JPEG Baseline | LE | 显式 | JPEG 有损 |
| 1.2.840.10008.1.2.4.70 | JPEG Lossless | LE | 显式 | JPEG 无损 |
| 1.2.840.10008.1.2.4.90 | JPEG 2000 Lossless | LE | 显式 | JPEG 2000 无损 |
| 1.2.840.10008.1.2.5 | RLE Lossless | LE | 显式 | RLE 无损 |

**Transfer Syntax 的作用**：

```
设备采集 CT 影像（原始未压缩，Implicit VR LE）
    │
    ▼
设备 C-STORE 时协商 Presentation Context
    │
    ├─ Abstract Syntax: CT Image Storage (1.2.840.10008.5.1.4.1.1.2)
    └─ Transfer Syntax: JPEG Lossless (1.2.840.10008.1.2.4.70)
    │
    ▼
设备按 JPEG Lossless 压缩影像，传输到 PACS
    │
    ▼
PACS 接收后按 JPEG Lossless 解码，存储或转发
```

**4. 为什么 DICOM 文件既能存影像又能存患者/检查/报告信息**：

DICOM 文件 = **Data Set**（一系列 Data Element）+ **Pixel Data**（影像像素）。Data Set 中的 Tag 可以包含：

- **Patient 模块**：Patient Name (0010,0010)、Patient ID (0010,0020)、Birth Date (0010,0030)、Sex (0010,0040)
- **General Study 模块**：Study Instance UID (0020,000D)、Study Date (0008,0020)、Accession Number (0008,0050)、Referring Physician (0008,0090)
- **General Series 模块**：Series Instance UID (0020,000E)、Modality (0008,0060)、Series Number (0020,0011)、Series Description (0008,103E)
- **Image Pixel 模块**：Rows (0028,0010)、Columns (0028,0011)、Bits Allocated (0028,0100)、Pixel Data (7FE0,0010)
- **SR Document 模块**：Structured Report 内容（用于 AI 推理结果、影像报告）
- **Segmentation 模块**：AI 分割结果（如肺结节 mask）

**核心设计哲学**：

- DICOM 把"影像"与"上下文"（患者/检查/序列）**强绑定**到一个文件，每张影像都自带完整元数据
- 这与"图片 + 数据库记录"的方式不同，DICOM 是"自描述"的，单文件可独立传输、解析、显示
- 优势：去中心化，传输中不丢上下文；劣势：冗余（同一 Study 多张影像重复 Patient 信息）

#### 2. DICOM 网络协议体系

**DICOM 网络协议栈**：

```
┌────────────────────────────────────────┐
│  DICOM Application Layer              │
│  ├─ DIMSE-C / DIMSE-N                 │
│  └─ SOP Class（服务类）                │
├────────────────────────────────────────┤
│  DICOM Upper Layer (DUL)              │
│  - Association 协商与释放              │
│  - P-DATA / P-DATA-TF PDUs           │
├────────────────────────────────────────┤
│  TCP/IP                               │
└────────────────────────────────────────┘
```

**1. DIMSE-C（DIMSE-Composite）vs DIMSE-N（DIMSE-Normalized）**：

| 维度 | DIMSE-C | DIMSE-N |
|---|---|---|
| 全称 | DIMSE-Composite | DIMSE-Normalized |
| 操作对象 | 复合对象（Composite IOD，如 CT Image） | 标准化对象（Normalized IOD，如 Print Queue） |
| 操作特点 | 整体传输（不可分割） | 单属性操作（可单字段修改） |
| 命令 | C-STORE / C-FIND / C-MOVE / C-GET / C-ECHO | N-CREATE / N-SET / N-GET / N-ACTION / N-EVENT-REPORT / N-DELETE |
| 用途 | 影像存储、查询、拉取 | 打印队列、Storage Commitment、设备控制 |
| 典型场景 | 设备 -> PACS 推送影像 | PACS -> 设备确认存储、设备控制 |

**DIMSE-C 五大命令**：

| 命令 | 方向 | 用途 | 示例 |
|---|---|---|---|
| C-ECHO | 双向 | 连通性测试（心跳） | 设备验证与 PACS 的连接 |
| C-STORE | SCU -> SCP | 推送影像到存储方 | 设备推送 CT 影像到 PACS |
| C-FIND | SCU -> SCP | 查询影像元数据 | 工作站查询某患者的所有 Study |
| C-MOVE | SCU -> SCP | 让另一方推送影像到第三方 | 工作站让 PACS 推送影像到本地 |
| C-GET | SCU -> SCP | 主动拉取影像（仅 SCU 主动发起） | 工作站主动从 PACS 拉影像（少用） |

**SCU vs SCP**：

- SCU = Service Class User（客户端，发起请求）
- SCP = Service Class Provider（服务端，响应请求）
- 同一设备在不同场景下可扮演不同角色：设备 C-STORE 时是 SCU，PACS 是 SCP；工作站 C-FIND 时是 SCU，PACS 是 SCP

**DIMSE-N 五大命令**：

| 命令 | 用途 | 示例 |
|---|---|---|
| N-CREATE | 创建标准化对象 | 创建 Print Queue 中的打印任务 |
| N-SET | 修改标准化对象属性 | 修改打印参数 |
| N-GET | 查询标准化对象属性 | 查询打印队列状态 |
| N-ACTION | 触发动作 | 触发 Storage Commitment 校验 |
| N-EVENT-REPORT | 事件上报 | Storage Commitment 结果回传 |

**Storage Commitment（存储提交确认）**：

- 解决"设备 C-STORE 推送后不知道 PACS 是否真正持久化"的问题
- 流程：设备 C-STORE 完成后，发起 N-ACTION 请求 Storage Commitment -> PACS 异步确认存储 -> PACS 回传 N-EVENT-REPORT 通知设备
- 体检场景应用：B 超设备推送影像后，必须确认 PACS 已落盘才能删除本地缓存

**2. SOP Class UID 与 SOP Instance UID**：

- **SOP Class UID**：标识"服务类 + 信息对象定义"的组合，如 "CT Image Storage" (1.2.840.10008.5.1.4.1.1.2)
- **SOP Instance UID**：标识某个具体的 SOP 实例（一张影像、一份 SR 文档），全局唯一
- 关系：SOP Class UID 是"类型"，SOP Instance UID 是"实例"

**常见 SOP Class UID**：

| SOP Class | UID | 含义 |
|---|---|---|
| CT Image Storage | 1.2.840.10008.5.1.4.1.1.2 | CT 影像存储 |
| MR Image Storage | 1.2.840.10008.5.1.4.1.1.4 | MR 影像存储 |
| US Image Storage | 1.2.840.10008.5.1.4.1.1.6.1 | 超声影像存储 |
| X-Ray Angiographic Image Storage | 1.2.840.10008.5.1.4.1.1.12.1 | 血管造影 |
| Digital X-Ray Image Storage | 1.2.840.10008.5.1.4.1.1.1.1 | 数字 X 光 |
| Secondary Capture | 1.2.840.10008.5.1.4.1.1.7 | 二次采集（如截图） |
| Study Component Management | 1.2.840.10008.5.1.4.33 | Study 组件管理 |
| Modality Worklist Information Model - FIND | 1.2.840.10008.5.1.4.31 | MWL 查询 |
| DICOM Storage Commitment Push Model | 1.2.840.10008.1.20.1 | Storage Commitment |
| Basic Worklist Management | 1.2.840.10008.5.1.4.32 | 基础工作列表 |

**UID 体系**：

- DICOM UID 基于 OSI OID（对象标识符）体系，使用 arc 1.2.840.10008（DICOM 专属）
- UID 全局唯一，由标准定义或机构自行分配（如机构在 1.2.840.10008.x.x 下分配自己的 root）
- 体检系统应申请自己的 UID Root（如 1.2.840.10008.5.1.4.1.x.y.z），用于生成 Study/Series/Instance UID

**3. Presentation Context 协商**：

Association 建立时，SCU 与 SCP 协商每条"对话主题"（Presentation Context），每个 Context 包含：

- **Abstract Syntax**：SOP Class UID（如 CT Image Storage）
- **Transfer Syntax List**：可接受的字节编码方式列表（如 [JPEG Lossless, Explicit VR LE]）

```
协商示例：
SCU (设备) -> SCP (PACS)
Presentation Context 1:
  Abstract Syntax: CT Image Storage (1.2.840.10008.5.1.4.1.1.2)
  Transfer Syntax List:
    - JPEG Lossless (1.2.840.10008.1.2.4.70)
    - Explicit VR LE (1.2.840.10008.1.2.1)

SCP (PACS) 响应：
Presentation Context 1: Accept
  Selected Transfer Syntax: JPEG Lossless
  （PACS 选择支持的 Transfer Syntax）
```

**4. Association 建立与释放流程**：

```
T0: 设备 -> PACS: A-ASSOCIATE-RQ（携带 AE Title、Presentation Context List）
T1: PACS -> 设备: A-ASSOCIATE-AC（接受，返回选定的 Transfer Syntax）
T2: 设备 -> PACS: P-DATA-TF（C-STORE-RQ + 影像数据）
T3: PACS -> 设备: P-DATA-TF（C-STORE-RSP，成功/失败）
... (重复 T2-T3 推送多张影像)
T4: 设备 -> PACS: A-RELEASE-RQ（请求释放）
T5: PACS -> 设备: A-RELEASE-RP（确认释放）
```

**AE Title（Application Entity Title）**：

- 应用实体标题，标识网络中的 DICOM 节点
- 配置项：AE Title + IP + Port（如 PACS_AE@192.168.1.100:104）
- 长度上限 16 字符，通常用大写字母 + 数字（如 "PACS_MAIN"）
- 与 SOP Instance UID 不同，AE Title 不要求全局唯一，只需通信双方不冲突

#### 3. DICOM 三大服务类在体检场景的协同

**三大服务类**：

| 服务类 | 用途 | 命令 | 方向 |
|---|---|---|---|
| Storage | 影像存储 | C-STORE | 设备 -> PACS |
| Query-Retrieve | 影像查询与拉取 | C-FIND + C-MOVE | 工作站 -> PACS |
| Modality Worklist | 设备工作列表 | C-FIND (MWL) | 设备 -> 体检系统/RIS |

**体检场景协同流程**：

```
┌──────────────────────────────────────────────────────────────────┐
│  体检系统/RIS                  PACS                  B 超设备    │
│                                                                  │
│  T1: 生成 MWL                              <- C-FIND (MWL) ────│
│      ┌────────────────┐                                            │
│      │ Worklist Item: │                                            │
│      │ - Patient ID   │                                            │
│      │ - Patient Name │                                            │
│      │ - Accession #  │                                            │
│      │ - Procedure    │                                            │
│      │   Description  │                                            │
│      └────────────────┘                                            │
│                                                                  │
│  T2: 返回 Worklist List  ─── C-FIND RSP ──->                     │
│                                                                  │
│  T3: 设备显示当日体检清单，医生选择患者                       │
│                                                                  │
│  T4: 设备采集 B 超影像                                          │
│                                                                  │
│  T5: 设备将 Patient ID、Accession Number、Study Instance UID  │
│      写入 DICOM 文件元数据                                       │
│                                                                  │
│  T6:                                          <- C-STORE ────── │
│                                                  (推送影像)      │
│                                                                  │
│  T7:                                          ── C-STORE RSP ->│
│                                                                  │
│  T8: 体检系统异步感知影像就绪                                    │
│      方式 A：DICOM Tag (0040,0275) Request Attributes Seq       │
│              - 体检系统定期 C-FIND Study，匹配 Accession Number │
│      方式 B：Storage Commitment                                  │
│              - 设备 N-ACTION 请求，PACS N-EVENT-REPORT 确认     │
│      方式 C：PACS Webhook（部分 PACS 支持，如 Orthanc）         │
│                                                                  │
│  T9: 主检医生调阅影像                                           │
│      ┌─────────────────┐                                          │
│      │ 工作站/H5 Viewer│                                          │
│      └─────────────────┘                                          │
│          │                                                        │
│          ├─ C-FIND (Study)  ───────────> PACS                    │
│          │  返回 Study 列表                                       │
│          ├─ C-MOVE (Study, 目标 AE Title) ──> PACS               │
│          │  PACS 推送影像到本地缓存                               │
│          └─ 工作站从本地缓存渲染影像                              │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

**关键 Tag 与业务字段映射**：

| 体检业务字段 | DICOM Tag | 用途 |
|---|---|---|
| 患者 ID | (0010,0020) Patient ID | 关联体检系统患者 |
| 患者姓名 | (0010,0010) Patient Name | 显示 |
| 出生日期 | (0010,0030) Birth Date | 验证身份 |
| 性别 | (0010,0040) Sex | 显示 |
| 检查号 | (0008,0050) Accession Number | 关联体检申请单（核心关联键） |
| Study UID | (0020,000D) Study Instance UID | DICOM 全局唯一标识 |
| Series UID | (0020,000E) Series Instance UID | 序列标识 |
| 检查类型 | (0008,0060) Modality | CT/MR/US/DR/ECG |
| 检查日期 | (0008,0020) Study Date | 调阅过滤 |
| 检查描述 | (0008,1030) Study Description | 显示 |
| 申请医生 | (0008,0090) Referring Physician | 显示 |
| 设备 | (0008,0070) Manufacturer + (0008,1090) Model | 设备管理 |

**Accession Number 是体检系统与 PACS 的核心关联键**：

- 体检系统在申请单生成时分配 Accession Number（如 "EXAM202607090001"）
- 该号写入 MWL（设备查询时获得），设备采集后写入 DICOM 文件
- PACS 收到 C-STORE 时通过 Accession Number 关联到体检申请单
- 主检医生调阅时通过 Accession Number 反查 Study Instance UID

**MWL（Modality Worklist）的核心字段**：

| Tag | 含义 | 体检场景应用 |
|---|---|---|
| (0010,0020) Patient ID | 患者 ID | 关联体检患者 |
| (0010,0010) Patient Name | 患者姓名 | 显示 |
| (0008,0050) Accession Number | 检查号 | 关联申请单 |
| (0040,1001) Requested Procedure ID | 申请检查 ID | 体检申请 |
| (0032,1060) Requested Procedure Description | 检查描述 | "腹部 B 超" |
| (0008,0060) Modality | 模态 | "US"（超声） |
| (0040,0001) Scheduled Station AE Title | 预定设备 AE | "US_DEVICE_01" |
| (0040,0002) Scheduled Procedure Step Start Date | 预定日期 | "20260709" |
| (0040,0003) Scheduled Procedure Step Start Time | 预定时间 | "100000" |

#### 4. PACS 系统架构

**PACS 核心组成**：

```
┌──────────────────────────────────────────────────────────────────┐
│  PACS 系统架构                                                    │
│                                                                  │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐          │
│  │ Modality │ │ Modality │ │ Modality │ │ Modality │          │
│  │  (CT)    │ │  (MR)    │ │  (US)    │ │  (DR)    │          │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘          │
│       │            │            │            │                  │
│       └────────────┴────────────┴────────────┘                  │
│                    │ C-STORE                                    │
│                    ▼                                            │
│       ┌──────────────────────────────────────┐                 │
│       │  PACS Server                          │                 │
│       │  ├─ DICOM Listener (接收)             │                 │
│       │  ├─ Storage Router (路由)             │                 │
│       │  ├─ Database Index (索引)             │                 │
│       │  ├─ Archive Manager (归档管理)        │                 │
│       │  └─ Query Interface (查询接口)        │                 │
│       └──────────────────────────────────────┘                 │
│                    │                                            │
│       ┌────────────┼────────────┐                              │
│       ▼            ▼            ▼                              │
│  ┌─────────┐ ┌─────────┐ ┌────────────────┐                   │
│  │ Hot     │ │ Warm    │ │ Cold Archive   │                   │
│  │ Storage │ │ Storage │ │ (Tape/Cloud)   │                   │
│  │ (SSD)   │ │ (HDD)   │ │                │                   │
│  │ 3 month │ │ 3 year  │ │ 3+ year        │                   │
│  └─────────┘ └─────────┘ └────────────────┘                   │
│                                                                  │
│       ┌──────────────────────────────────────┐                 │
│       │  Workstation                          │                 │
│       │  ├─ 诊断工作站（放射科医生）          │                 │
│       │  ├─ 主检工作站（体检医生）            │                 │
│       │  ├─ Web Viewer（浏览器/H5）           │                 │
│       │  └─ 移动端 Viewer（小程序）           │                 │
│       └──────────────────────────────────────┘                 │
└──────────────────────────────────────────────────────────────────┘
```

**PACS Server 核心功能**：

| 功能 | 实现 |
|---|---|
| 接收（Ingest） | DICOM Listener，监听 104/11112 端口，接收 C-STORE |
| 路由（Routing） | 按 Tag（Modality/AE Title/部门）路由到不同存储或下游系统 |
| 索引（Indexing） | 提取 Tag，建立索引（Patient/Study/Series/Instance） |
| 查询（Query） | 响应 C-FIND/C-MOVE，返回元数据 |
| 归档（Archive） | 分层存储（Hot/Warm/Cold） |
| 复制（Replication） | 多副本，容灾 |
| 删除保留（Retention） | 按法规保留（门诊 15 年、住院 30 年） |
| 压缩（Compression） | 传输/存储时压缩（无损优先） |

**主流 PACS 厂商对比**：

| 厂商 | 类型 | 特点 | 国内市场 |
|---|---|---|---|
| GE Healthcare | 商业 | Centricity PACS，三甲医院高端市场 | 大型三甲 |
| 飞利浦 | 商业 | IntelliSpace PACS，与设备深度集成 | 大型三甲 |
| 西门子 | 商业 | syngo.via，与设备深度集成 | 大型三甲 |
| 东软 Neusoft | 商业 | NeuPACS，国产化 | 中大型医院 |
| 卫宁健康 | 商业 | Winning PACS/RIS，HIS 厂家延伸 | 中型医院 |
| 医为（Mindray） | 商业 | 与设备绑定 | 影像设备客户 |
| 嘉和美康 | 商业 | 一体化影像解决方案 | 中型医院 |
| 3D Slicer | 开源 | 科研用，不适合生产 | 科研 |
| Orthanc | 开源 | 轻量、REST API、插件丰富 | 中小机构/集成 |
| dcm4che | 开源 | JBoss 体系，企业级 | 集成/自建 |
| PacsOne | 开源 | Windows 友好 | 小机构 |
| Dicoogle | 开源 | 索引搜索友好 | 科研 |

**开源方案深度对比**：

| 维度 | Orthanc | dcm4che |
|---|---|---|
| 语言 | C++（核心）+ Lua/Python 插件 | Java |
| 部署 | 单机/Docker，简单 | JBoss + 数据库，复杂 |
| REST API | 内置，友好 | 通过 dcm4chee 影像管理 |
| 数据库 | SQLite/MySQL/PostgreSQL | MySQL/PostgreSQL/Oracle |
| DICOMweb | 插件支持 | 原生支持 |
| 集群 | 单机为主，扩展需额外设计 | 支持集群 |
| 学习曲线 | 平缓 | 陡 |
| 适用场景 | 中小机构、PACS 集成 | 大型机构、企业级 PACS |

**体检场景下的 PACS 部署架构**：

**小规模（单机构，&lt; 100 检查/日）**：

```
B 超/DR/心电 设备
    │
    ▼
Orthanc (单机部署，Docker)
    │
    ├─ DICOM Listener (104)
    ├─ PostgreSQL (元数据)
    ├─ 文件系统 (影像存储)
    └─ REST API + DICOMweb (供体检系统调阅)
    │
    ▼
体检系统集成 (REST API 拉取元数据 + WADO-RS 拉取影像)
```

**多机构 SaaS（啄木鸟云健康场景）**：

```
机构 A 设备     机构 B 设备     机构 C 设备
   │              │              │
   ▼              ▼              ▼
机构 A 边缘网关  机构 B 边缘网关  机构 C 边缘网关
（轻量 Orthanc + 缓存）
   │              │              │
   └──────────────┼──────────────┘
                  │ 专线/HTTPS（影像上传）
                  ▼
       云端 PACS（dcm4chee 集群）
       ├─ DICOMweb 接口
       ├─ PostgreSQL 集群（多租户隔离）
       ├─ 对象存储（影像存储）
       └─ CDN 加速（PDF 报告等）
                  │
                  ▼
       体检系统主流程（FHIR + DICOMweb 调阅）
```

---

## 题目二（工程实战题）：体检系统集成 PACS 的工程实现

请回答：

1. 体检设备（B 超、X 光、CT、DR、心电）如何通过 DICOM 推送到 PACS？设备 DICOM 配置（AE Title、IP、Port、目标 PACS AE Title）？C-STORE 的过程（设备主动推 / PACS 被动收）？推送失败的重试策略？体检系统如何感知"影像已就绪"（DICOM 第二采集 / Storage Commitment）？
2. Modality Worklist（MWL）在体检场景的应用：体检系统如何生成 MWL 列表（待检患者 + 检查项目）？B 超设备开机后如何 query-modality-worklist（C-FIND MWL）拉取当日清单？设备采集完成后如何通过 DICOM Tag（如 Patient ID、Accession Number、Study Description）关联到体检报告？MWL 与体检系统预约/报到的衔接？
3. 体检系统调阅影像的接口选型：传统 DICOM DIMSE（C-FIND 查询 + C-MOVE 拉取到工作站 + C-GET 主动拉取）vs DICOMweb（QIDO-RS 查询 + WADO-RS 拉取 + STOW-RS 存储）。Web 端调阅（小程序/浏览器）应该如何选？影像渲染（Cornerstone.js / Orthanc Viewer）的性能与压缩？
4. 影像存储与归档策略：在线（热数据，SSD）、近线（温数据，HDD）、离线（冷数据，对象存储/磁带库）的分层？DICOM 文件存储方式（文件系统 vs 对象存储 vs 数据库 BLOB）？影像生命周期管理（3 个月内快速调阅、3 个月-3 年归档、3 年以上离线）？多机构 SaaS 下，影像是按机构分库还是统一存储 + 租户隔离？
5. Orthanc 开源 PACS 部署实战：Orthanc 架构（Core + REST API + Plugins）、与 dcm4che 的对比？Orthanc 与体检系统对接的两种方式（DICOM DIMSE 接收 + REST API 调阅）？Orthanc 插件（MySQL/PostgreSQL 后端、DICOMweb、OHIF Viewer）？

### 作答区

#### 1. 体检设备 DICOM 推送 PACS

**设备 DICOM 配置（4 项）**：

| 配置项 | 含义 | 示例 |
|---|---|---|
| AE Title | 设备的应用实体标题 | "US_DEVICE_01"（B 超 1 号机） |
| Port | DICOM 监听端口（设备侧无需，仅主动发起时） | 104 / 11112 |
| 目标 PACS AE Title | PACS 的 AE Title | "PACS_MAIN" |
| 目标 PACS IP + Port | PACS 的网络地址 | 192.168.1.100:104 |

设备侧还需配置（部分设备）：

| 配置项 | 含义 |
|---|---|
| Transfer Syntax 列表 | 设备支持的传输语法（Implicit VR LE / Explicit VR LE / JPEG Lossless 等） |
| Local AE Title | 设备自身的 AE Title |
| Institution Name | 机构名（写入 DICOM 文件） |
| Modality | 模态类型（US/CT/DR/ECG 等） |

**C-STORE 流程（设备主动推 / PACS 被动收）**：

```
T0: 设备采集完成，生成 DICOM 文件
T1: 设备发起 A-ASSOCIATE-RQ
    - Calling AE Title: US_DEVICE_01
    - Called AE Title: PACS_MAIN
    - Presentation Context: CT/US/DR Image Storage + Transfer Syntax List
T2: PACS 响应 A-ASSOCIATE-AC
    - 选定 Presentation Context（接受请求）
T3: 设备发送 C-STORE-RQ
    - Affected SOP Instance UID: 1.2.840.xxxx.yyyy.zzzz
    - Patient/Study/Series Tag
    - Pixel Data
T4: PACS 持久化到存储 + 写入数据库索引
T5: PACS 响应 C-STORE-RSP
    - Status: 0000H (Success) / A7xx (Refused) / A9xx (Data Set Error) / Cxxx (Cannot Understand)
T6: 设备继续推送下一张（重复 T3-T5）
T7: 全部推送完成，设备 A-RELEASE-RQ
T8: PACS A-RELEASE-RP
```

**推送失败的重试策略**：

| 失败原因 | Status Code | 重试策略 |
|---|---|---|
| 网络中断 | A-ASSOCIATE 失败 | 设备本地缓存，定时重试（如每 5 分钟） |
| PACS 繁忙 | A7xx (Refused) | 退避重试（指数退避，最大 1 小时） |
| 数据格式错误 | A9xx (Data Set Error) | 不重试，告警，人工介入 |
| 不支持的 SOP Class | A-ASSOCIATE-AC 拒绝 Context | 设备配置修正，不重试 |
| 存储空间不足 | A7xx | 告警 PACS 扩容，设备缓存重试 |

**设备本地缓存设计**：

- 大部分医疗设备自带本地存储（如 GE CT 自带 100GB+ 硬盘），网络中断时影像自动缓存
- 网络恢复后，设备自动按队列补推（FIFO 顺序）
- 部分低端设备（如便携 B 超）本地缓存有限，需集成第三方缓存代理（如 Conquest DICOM Server）

**体检系统感知"影像已就绪"的 3 种方式**：

**方式 A：DICOM 第二采集（Secondary Capture）+ Tag 反查**

- 体检系统定时 C-FIND 查询 PACS，按 Accession Number 匹配申请单
- 适合简单场景，缺点是延迟（轮询周期 1-5 分钟）

```java
// 体检系统定时任务（每 5 分钟）
@Scheduled(cron = "0 */5 * * * ?")
public void checkImageReady() {
    List<ExamRequest> pendingRequests = examRequestRepo.findPendingImage();
    for (ExamRequest req : pendingRequests) {
        DicomFindResult result = pacsClient.cfind("STUDY", req.getAccessionNumber());
        if (result != null && "AVAILABLE".equals(result.getStatus())) {
            // 影像已就绪，更新申请单状态
            req.setImageReady(true);
            req.setStudyInstanceUID(result.getStudyInstanceUID());
            examRequestRepo.save(req);
        }
    }
}
```

**方式 B：Storage Commitment**

- 设备 C-STORE 完成后，发 N-ACTION 请求 Storage Commitment
- PACS 异步确认存储（持久化完成），通过 N-EVENT-REPORT 回调设备
- 设备收到确认后，通过 PACS Webhook 或反向通知体检系统
- 优点：实时、可靠；缺点：部分 PACS 不支持

**方式 C：PACS Webhook（推荐，Orthanc 支持）**

- Orthanc 等开源 PACS 支持 Webhook 插件
- 影像落库后自动 POST 通知体检系统
- 体检系统收到通知后更新申请单状态

```
Orthanc Webhook 配置：
{
  "Webhooks": {
    "OnStableStudy": "https://tj.example.org/api/pacs/notify"
  }
}

通知内容：
POST /api/pacs/notify
{
  "EventType": "OnStableStudy",
  "ResourceType": "Study",
  "ResourceID": "study-uuid",
  "Tags": {
    "PatientID": "PAT001",
    "AccessionNumber": "EXAM202607090001",
    "StudyInstanceUID": "1.2.840.xxxx.yyyy",
    "Modality": "US"
  }
}
```

#### 2. MWL（Modality Worklist）在体检场景的应用

**体检系统生成 MWL 列表**：

```
体检系统预约/报到流程：
1. 患者预约 B 超 -> 生成 ExamRequest（含 Accession Number）
2. 患者报到 -> ExamRequest 状态变为"已报到，待检查"
3. 体检系统将 ExamRequest 写入 MWL Table
   - 字段：Patient ID、Patient Name、Accession Number、Modality、Scheduled Date/Time、Scheduled Station AE Title、Requested Procedure Description
4. B 超设备开机后 C-FIND MWL，拉取当日清单
```

**MWL 数据模型**：

```sql
CREATE TABLE mwl_item (
    id BIGINT PRIMARY KEY,
    patient_id VARCHAR(64),
    patient_name VARCHAR(128),
    patient_birth_date DATE,
    patient_sex VARCHAR(4),
    accession_number VARCHAR(64) UNIQUE,  -- 体检申请单号
    requested_procedure_id VARCHAR(64),
    requested_procedure_description VARCHAR(256),  -- "腹部 B 超"
    modality VARCHAR(16),  -- "US"
    scheduled_station_ae_title VARCHAR(64),  -- "US_DEVICE_01"
    scheduled_procedure_step_start_date DATE,
    scheduled_procedure_step_start_time TIME,
    requesting_physician VARCHAR(128),
    status VARCHAR(16),  -- SCHEDULED / IN_PROGRESS / COMPLETED / CANCELLED
    institution_name VARCHAR(128)
);
```

**B 超设备 C-FIND MWL 流程**：

```
T0: B 超设备开机
T1: 设备发起 C-FIND MWL 请求
    - 查询条件：Scheduled Date = today, Scheduled Station AE = "US_DEVICE_01"
T2: 体检系统/MWL 服务响应
    - 返回当日 B 超待检清单
T3: 设备显示清单（患者姓名、Accession Number、检查描述）
T4: 医生选择患者，进入采集界面
T5: 设备采集影像，自动写入 DICOM 元数据
    - Patient ID（来自 MWL）
    - Accession Number（来自 MWL）
    - Study Instance UID（设备生成）
    - Study Description（来自 MWL）
T6: 设备 C-STORE 推送到 PACS
T7: PACS 通过 Accession Number 关联到体检申请单
```

**MWL 查询的 C-FIND Identifier**：

```
C-FIND Request:
- SOP Class UID: 1.2.840.10008.5.1.4.31 (Modality Worklist Information Model - FIND)
- Identifier:
  (0008,0005) Specific Character Set = "ISO_IR 192"  # UTF-8
  (0010,0020) Patient ID = ""  # 查询所有
  (0010,0010) Patient Name = ""  # 查询所有
  (0008,0050) Accession Number = ""  # 查询所有
  (0040,0002) Scheduled Procedure Step Start Date = "20260709"
  (0040,0003) Scheduled Procedure Step Start Time = ""
  (0008,0060) Modality = "US"
  (0040,0001) Scheduled Station AE Title = "US_DEVICE_01"
```

**DICOM Tag 关联体检报告**：

| DICOM Tag | 体检字段 | 关联方式 |
|---|---|---|
| (0010,0020) Patient ID | 体检患者 ID | 主键关联 |
| (0008,0050) Accession Number | 体检申请单号 | 核心关联键 |
| (0020,000D) Study Instance UID | DICOM Study 标识 | 反查影像 |
| (0008,1030) Study Description | 检查描述 | 显示 |
| (0008,0060) Modality | 检查类型 | 路由依据 |

**MWL 与预约/报到的衔接**：

```
预约 ──── 报到 ──── MWL 生成 ──── 设备 C-FIND ──── 采集 ──── C-STORE ──── 影像就绪 ──── 主检
 │          │          │              │              │           │              │            │
 │          │          │              │              │           │              │            │
ExamReq   ExamReq    MWL Insert    Device Pull    DICOM File  PACS           Webhook     Diagnostic
生成      状态:      状态:         设备显示       Tag 写入    持久化         体检系统      Report
         REPORTED   SCHEDULED     Worklist       Accession                  更新状态      生成
                                  Number
```

#### 3. 体检系统调阅影像的接口选型

**传统 DICOM DIMSE vs DICOMweb 对比**：

| 维度 | DICOM DIMSE | DICOMweb |
|---|---|---|
| 协议 | TCP + DIMSE（自定义二进制） | HTTP/HTTPS RESTful |
| 查询 | C-FIND（DICOM Identifier） | QIDO-RS（URL Query） |
| 拉取 | C-MOVE + C-STORE（推送到本地） / C-GET（主动拉取） | WADO-RS（HTTP GET） |
| 存储 | C-STORE | STOW-RS（HTTP POST） |
| 渲染 | 需 DICOM Viewer 客户端 | Web 友好（HTML5/JS） |
| 适用场景 | 设备 ↔ PACS（设备原生支持） | Web/移动端 ↔ PACS（现代应用） |
| 防火墙 | 需开放 104/11112 端口 | HTTPS 443 |
| 性能 | 长连接，批量传输快 | 短连接，单次请求 |
| 跨网 | 不友好（端口限制） | 友好（HTTPS） |
| CDN 加速 | 不支持 | 支持 |

**DICOMweb 三大接口**：

| 接口 | 全称 | 方法 | 用途 |
|---|---|---|---|
| QIDO-RS | Query based on ID for DICOM Objects by RESTful Services | GET | 查询元数据 |
| WADO-RS | Web Access to DICOM Objects by RESTful Services | GET | 拉取影像/元数据 |
| STOW-RS | Store Over the Web by RESTful Services | POST | 上传影像 |

**QIDO-RS 示例**：

```http
# 查询某患者的所有 Study
GET /dicomweb/studies?PatientID=PAT001
Accept: application/dicom+json

# 响应
[
  {
    "0020000D": {"vr": "UI", "Value": ["1.2.840.xxxx.yyyy"]},  // StudyInstanceUID
    "00080020": {"vr": "DA", "Value": ["20260709"]},  // StudyDate
    "00080050": {"vr": "SH", "Value": ["EXAM202607090001"]},  // AccessionNumber
    "00080060": {"vr": "CS", "Value": ["US"]}  // Modality
  }
]

# 查询某 Study 的所有 Series
GET /dicomweb/studies/{studyInstanceUID}/series

# 查询某 Series 的所有 Instance
GET /dicomweb/studies/{studyInstanceUID}/series/{seriesInstanceUID}/instances
```

**WADO-RS 示例**：

```http
# 拉取单张 DICOM 文件
GET /dicomweb/studies/{studyUID}/series/{seriesUID}/instances/{instanceUID}
Accept: application/dicom

# 拉取渲染后的 JPEG（Web 直接显示）
GET /dicomweb/studies/{studyUID}/series/{seriesUID}/instances/{instanceUID}/rendered
Accept: image/jpeg

# 拉取元数据
GET /dicomweb/studies/{studyUID}/series/{seriesUID}/instances/{instanceUID}/metadata
Accept: application/dicom+json
```

**STOW-RS 示例**：

```http
# 上传影像
POST /dicomweb/studies
Content-Type: multipart/related; type="application/dicom"; boundary=BOUNDARY

--BOUNDARY
Content-Type: application/dicom
Content-Length: 123456

<DICOM 文件二进制>
--BOUNDARY--
```

**Web 端调阅的接口选型**：

| 场景 | 推荐接口 | 原因 |
|---|---|---|
| 设备 ↔ PACS | DICOM DIMSE（C-STORE） | 设备原生支持，无需改造 |
| 工作站 ↔ PACS | DICOM DIMSE（C-FIND + C-MOVE） | 工作站需高性能，长连接 |
| 浏览器/H5 ↔ PACS | DICOMweb（QIDO + WADO） | HTTP 友好，无需插件 |
| 小程序 ↔ PACS | DICOMweb（WADO-RS rendered JPEG） | 小程序不支持二进制渲染，需 JPEG |
| 移动 App ↔ PACS | DICOMweb（QIDO + WADO） | HTTP 友好 |

**影像渲染方案（Cornerstone.js）**：

```javascript
// Cornerstone.js 渲染 DICOM 影像
import cornerstone from 'cornerstone-core';
import dicomImageLoader from 'cornerstone-wado-image-loader';

// 通过 WADO-RS 加载影像
const imageId = 'wadors:https://pacs.example.org/dicomweb/studies/.../instances/.../rendered';

cornerstone.enable(element);
cornerstone.loadImage(imageId).then(image => {
    cornerstone.displayImage(element, image);
});
```

**Cornerstone.js 性能优化**：

| 优化点 | 实现 |
|---|---|
| 渐进式加载 | JPEG 2000 / JPEG-XL 支持渐进解码 |
| 多分辨率（Pyramid） | Whole Slide Imaging（WSI）病理影像 |
| Web Worker | 解码放到 Worker，避免阻塞 UI |
| WebGL 渲染 | 大影像（CT 1000+ 张）用 WebGL 加速 |
| 压缩传输 | WADO-RS 支持 gzip / JPEG Lossless |

**OHIF Viewer**：

- 基于 Cornerstone.js 的开源 Web PACS Viewer
- 支持 DICOMweb、多种 Modality、MPR、3D 渲染
- 体检系统可嵌入 OHIF 作为 Web 调阅组件

#### 4. 影像存储与归档策略

**分层存储**：

| 层级 | 介质 | 访问频率 | 保留期 | 访问时延 |
|---|---|---|---|---|
| 在线（Hot） | SSD | 高（&lt; 1 秒） | 3 个月 | &lt; 100ms |
| 近线（Warm） | HDD / 大容量 | 中（&lt; 1 分钟） | 3 个月-3 年 | &lt; 1s |
| 离线（Cold） | 对象存储 / 磁带库 | 低（&lt; 1 小时） | 3 年以上 | 1-60 分钟 |

**DICOM 文件存储方式对比**：

| 方式 | 优势 | 劣势 | 适用场景 |
|---|---|---|---|
| 文件系统 | 简单、IO 高 | 不支持事务、扩展性差 | 小规模 PACS |
| 对象存储（S3/OSS） | 海量、高可用、低成本 | 延迟略高 | 云原生 PACS |
| 数据库 BLOB | 事务一致 | 性能差、不推荐 | 不推荐 |
| 混合（DB 索引 + 对象存储） | 兼顾索引与存储 | 架构复杂 | 主流方案 |

**主流方案：DB 索引 + 对象存储**：

```
元数据（PostgreSQL/MySQL）：
- Patient 表（ID、姓名、生日）
- Study 表（StudyInstanceUID、AccessionNumber、Modality、日期）
- Series 表（SeriesInstanceUID、Series 描述）
- Instance 表（SOPInstanceUID、对象存储 Key）

影像（对象存储）：
- 路径：/studies/{studyUID}/series/{seriesUID}/instances/{instanceUID}.dcm
- 元数据 DB 通过对象存储 Key 反查影像
```

**影像生命周期管理**：

```java
// 归档策略
@Scheduled(cron = "0 0 1 * * ?")  // 每天凌晨 1 点
public void archiveLifecycle() {
    // 1. 3 个月前 Study 从 Hot -> Warm
    List<Study> hotStudies = studyRepo.findOlderThan(3, ChronoUnit.MONTHS, "HOT");
    for (Study s : hotStudies) {
        s.moveToStorage("WARM");
        objectStorage.copy(s.getObjectKey(), "hot-bucket", "warm-bucket");
    }
    
    // 2. 3 年前 Study 从 Warm -> Cold
    List<Study> warmStudies = studyRepo.findOlderThan(3, ChronoUnit.YEARS, "WARM");
    for (Study s : warmStudies) {
        s.moveToStorage("COLD");
        objectStorage.copy(s.getObjectKey(), "warm-bucket", "cold-bucket");
        // 冷数据可用低频访问存储（如 S3 IA / OSS IA）
    }
    
    // 3. 30 年后（门诊保留期）Study 删除
    List<Study> expiredStudies = studyRepo.findOlderThan(30, ChronoUnit.YEARS, "COLD");
    for (Study s : expiredStudies) {
        objectStorage.delete(s.getObjectKey());
        studyRepo.delete(s);
    }
}
```

**多机构 SaaS 影像存储方案**：

| 方案 | 优势 | 劣势 | 适用场景 |
|---|---|---|---|
| 按机构分库 | 数据隔离强、合规友好 | 运维成本高 | 三甲机构、合规要求高 |
| 统一存储 + tenant_id 隔离 | 成本低、运维简单 | 隔离弱 | 中小机构 |
| 混合（大客户私有 + 小客户共享） | 兼顾 | 架构复杂 | 啄木鸟云健康 |

**统一存储 + tenant_id 隔离的实现**：

```sql
-- Study 表加 tenant_id
CREATE TABLE study (
    id BIGINT PRIMARY KEY,
    tenant_id VARCHAR(32) NOT NULL,  -- 机构 ID
    study_instance_uid VARCHAR(128),
    accession_number VARCHAR(64),
    patient_id VARCHAR(64),
    modality VARCHAR(16),
    study_date DATE,
    object_key VARCHAR(256),  -- 对象存储 Key（含 tenant_id 前缀）
    storage_tier VARCHAR(16),  -- HOT/WARM/COLD
    ...
    INDEX idx_tenant_date (tenant_id, study_date),
    INDEX idx_accession (tenant_id, accession_number)
);

-- 对象存储 Key 设计
// organizations/{tenant_id}/studies/{studyUID}/series/{seriesUID}/instances/{instanceUID}.dcm
```

**查询强制按 tenant_id 过滤**：

```java
public Study findStudy(String tenantId, String accessionNumber) {
    return studyRepo.findByTenantIdAndAccessionNumber(tenantId, accessionNumber)
        .orElseThrow(() -> new NotFoundException("Study not found"));
}
```

#### 5. Orthanc 开源 PACS 部署实战

**Orthanc 架构**：

```
┌──────────────────────────────────────────────────┐
│  Orthanc Server                                   │
│                                                   │
│  ┌──────────────────────────────────────────┐   │
│  │  Core (C++)                              │   │
│  │  ├─ DICOM Server (SCU/SCP)              │   │
│  │  ├─ REST API                             │   │
│  │  ├─ Storage (文件系统)                   │   │
│  │  ├─ Index (SQLite/MySQL/PostgreSQL)      │   │
│  │  └─ Lua Scripting                        │   │
│  └──────────────────────────────────────────┘   │
│                                                   │
│  ┌──────────────────────────────────────────┐   │
│  │  Plugins                                  │   │
│  │  ├─ PostgreSQL Index/Storage             │   │
│  │  ├─ MySQL Index/Storage                  │   │
│  │  ├─ DICOMweb                             │   │
│  │  ├─ Web Viewer                            │   │
│  │  ├─ OHIF Viewer                           │   │
│  │  ├─ Authorization (IAM)                  │   │
│  │  ├─ Python Scripting                     │   │
│  │  ├─ Whole Slide Imaging                  │   │
│  │  └─ Webhooks                             │   │
│  └──────────────────────────────────────────┘   │
└──────────────────────────────────────────────────┘
```

**Orthanc vs dcm4che 对比**：

| 维度 | Orthanc | dcm4che |
|---|---|---|
| 语言 | C++ | Java |
| 部署 | Docker 单容器 | JBoss + DB + LDAP，复杂 |
| 默认数据库 | SQLite（自带） | MySQL/PostgreSQL |
| REST API | 内置，简洁 | 通过 dcm4chee-arc-light |
| DICOMweb | 插件 | 原生 |
| 集群 | 单机为主，需扩展 | 支持集群 |
| 学习曲线 | 平缓 | 陡 |
| 扩展性 | Lua/Python 插件 | Java EE |
| 适用 | 中小机构、集成 | 大型机构 |

**Orthanc 与体检系统对接的两种方式**：

**方式 A：DICOM DIMSE 接收**

- Orthanc 监听 104 端口，接收设备 C-STORE
- 体检系统通过 REST API 查询元数据

```python
# Orthanc 配置（orthanc.json）
{
  "DicomModalities": {
    "US_DEVICE_01": ["US_DEVICE_01", "192.168.1.50", 104]
  },
  "DicomAet": "ORTHANC",
  "DicomPort": 4242,
  "AuthenticationEnabled": true,
  "RegisteredUsers": {
    "tj": "tj_password"
  }
}
```

**方式 B：REST API 调阅**

```bash
# 查询所有 Study
curl -u tj:tj_password https://orthanc.example.org/studies

# 查询某 Study 元数据
curl -u tj:tj_password https://orthanc.example.org/studies/{studyUUID}

# 下载 DICOM 文件
curl -u tj:tj_password https://orthanc.example.org/studies/{studyUUID}/archive -o study.zip

# DICOMweb 接口
curl -u tj:tj_password "https://orthanc.example.org/dicom-web/studies?PatientID=PAT001"
```

**Orthanc Docker 部署示例**：

```yaml
# docker-compose.yml
version: '3'
services:
  orthanc:
    image: orthancteam/orthanc:latest
    ports:
      - "4242:4242"   # DICOM
      - "8042:8042"   # REST API
    volumes:
      - ./orthanc.json:/etc/orthanc/orthanc.json:ro
      - orthanc-data:/var/lib/orthanc/db
    environment:
      - ORTHANC__POSTGRESQL__HOST=postgres
      - ORTHANC__POSTGRESQL__DATABASE=orthanc
      - ORTHANC__POSTGRESQL__USERNAME=orthanc
      - ORTHANC__POSTGRESQL__PASSWORD=orthanc_password

  postgres:
    image: postgres:15
    environment:
      - POSTGRES_DB=orthanc
      - POSTGRES_USER=orthanc
      - POSTGRES_PASSWORD=orthanc_password
    volumes:
      - postgres-data:/var/lib/postgresql/data

volumes:
  orthanc-data:
  postgres-data:
```

**Orthanc 插件启用（orthanc.json）**：

```json
{
  "Plugins": [
    "/usr/share/orthanc/plugins"
  ],
  "PostgreSQL": {
    "EnableIndex": true,
    "EnableStorage": false,  // 影像用文件系统
    "Host": "postgres",
    "Database": "orthanc",
    "Username": "orthanc",
    "Password": "orthanc_password"
  },
  "DicomWeb": {
    "Enable": true,
    "Root": "/dicom-web/"
  },
  "OHIF": {
    "Enable": true
  },
  "Webhooks": {
    "OnStableStudy": "https://tj.example.org/api/pacs/notify"
  }
}
```

**体检系统对接 Orthanc 的代码示例**：

```java
@Service
public class OrthancClient {
    private final RestClient restClient;
    
    public Study findStudy(String accessionNumber) {
        // 通过 DICOMweb QIDO-RS 查询
        return restClient.get()
            .uri("/dicom-web/studies?AccessionNumber=" + accessionNumber)
            .header("Accept", "application/dicom+json")
            .retrieve()
            .body(Study.class);
    }
    
    public byte[] downloadInstance(String studyUID, String seriesUID, String instanceUID) {
        // 通过 WADO-RS 下载
        return restClient.get()
            .uri("/dicom-web/studies/{study}/series/{series}/instances/{instance}",
                 studyUID, seriesUID, instanceUID)
            .header("Accept", "application/dicom")
            .retrieve()
            .body(byte[].class);
    }
    
    public byte[] downloadRenderedJpeg(String studyUID, String seriesUID, String instanceUID) {
        // 渲染为 JPEG（小程序友好）
        return restClient.get()
            .uri("/dicom-web/studies/{study}/series/{series}/instances/{instance}/rendered",
                 studyUID, seriesUID, instanceUID)
            .header("Accept", "image/jpeg")
            .retrieve()
            .body(byte[].class);
    }
}
```

---

## 题目三（选型权衡题）：云原生 PACS 架构与体检影像上云

请回答：

1. 多机构 SaaS 下 PACS 部署架构选型：单租户私有部署（每机构一套 PACS，数据隔离强）vs 多租户共享部署（统一 PACS + tenant_id 隔离）vs 混合部署（大客户私有 + 小客户共享）。体检场景下，乡镇卫生院（小规模）vs 三甲体检中心（大规模）vs 连锁体检机构（多机构）应如何选？影像数据合规（等保三级、医疗数据不出院）对部署架构的约束？
2. DICOMweb vs DIMSE 的选型：传统 PACS 走 DIMSE（C-STORE/C-FIND/C-MOVE），云原生 PACS 走 DICOMweb（STOW/QIDO/WADO）。DIMSE 的优势（成熟、设备原生支持）与劣势（不适合跨网/云）？DICOMweb 的优势（HTTP/RESTful、Web 友好、CDN 加速）与劣势（设备需改造）？体检场景下设备侧（DIMSE）+ 调阅侧（DICOMweb）的混合方案如何设计？网关层做协议转换？
3. 影像上云的链路设计：体检机构设备 -> 边缘网关（DICOM 接收 + 缓存）-> 专线/HTTPS -> 云端 PACS。边缘网关断网缓存与重传策略？云端 PACS 的高可用（多 AZ + 异地容灾）？影像上云的合规要求（医疗数据本地化、跨域传输加密）？带宽与成本估算（一次 CT 检查约 200MB-1GB，每日 1000 次体检的影像上行带宽）？
4. 体检影像与 FHIR ImagingStudy 资源的集成：FHIR ImagingStudy 资源如何描述 DICOM Study（Series/Instance）？ImagingStudy.endpoint 如何引用 DICOMweb WADO URI？体检报告（DiagnosticReport.imaging）如何引用 ImagingStudy？跨系统调阅（互联网医院调阅体检影像）时，FHIR + DICOMweb 的协同链路？
5. AI 辅助诊断的影像集成：体检场景 AI 应用（肺结节 AI 筛查 CT、乳腺 AI 超声、眼底 AI 筛查）的影像接入方式？AI 推理结果的存储（DICOM Segmentation Object / SR Structured Report / FHIR Observation）？AI 工作流（DICOM Studies 推送到 AI 服务 -> 推理结果回写 PACS -> 主检医生审核）？AI 推理延迟对主检流程的影响？

### 作答区

#### 1. 多机构 SaaS 下 PACS 部署架构选型

**三种部署架构对比**：

| 架构 | 隔离 | 成本 | 运维 | 定制 | 适用 |
|---|---|---|---|---|---|
| 单租户私有部署 | 强 | 高 | 高 | 高 | 三甲机构、合规要求高 |
| 多租户共享部署 | 弱 | 低 | 低 | 低 | 中小机构 |
| 混合部署 | 中 | 中 | 中 | 中 | 啄木鸟云健康 |

**1. 单租户私有部署**：

```
机构 A ─── Orthanc A (独立 DB + 独立存储)
机构 B ─── Orthanc B (独立 DB + 独立存储)
机构 C ─── Orthanc C (独立 DB + 独立存储)
```

- 优势：数据物理隔离，合规友好
- 劣势：每机构一套，资源浪费，运维成本高
- 适用：三甲机构、合规要求"数据不出院"

**2. 多租户共享部署**：

```
机构 A ─┐
机构 B ─┼─> 云端 Orthanc 集群 (统一 DB + tenant_id 隔离)
机构 C ─┘
```

- 优势：成本低、运维简单、弹性扩容
- 劣势：数据逻辑隔离，租户间互相影响（性能、可用性）
- 适用：中小机构（乡镇卫生院、社区医院）

**3. 混合部署（推荐啄木鸟云健康）**：

```
三甲机构 A ─── 私有 Orthanc (本地) ─── 影像不出院
                │
                │ FHIR/DICOMweb 元数据同步（不含影像）
                ▼
           云端中台（统一调阅入口）

中小机构 B ─┐
中小机构 C ─┼─> 云端 Orthanc 集群 (统一存储)
中小机构 D ─┘
```

- 大客户：私有部署 + 元数据上云（影像不出院，仅元数据上云供调阅）
- 小客户：直接上云（影像 + 元数据都在云端）

**不同体检场景的选型**：

| 场景 | 推荐架构 | 原因 |
|---|---|---|
| 乡镇卫生院（&lt; 50 检查/日） | 共享部署 | 规模小，上云成本最低 |
| 三甲体检中心（500+ 检查/日） | 私有部署 | 影像不出院，合规要求 |
| 连锁体检机构（多机构） | 混合部署 | 大门店私有 + 小门店共享 |
| 啄木鸟云健康（公卫 SaaS） | 混合部署 | 县级机构私有 + 乡镇共享 |

**等保三级对部署架构的约束**：

| 要求 | 对部署的影响 |
|---|---|
| 数据本地化 | 三甲机构必须私有部署，影像不出院 |
| 传输加密 | 专线或 HTTPS，禁止公网明文传输 |
| 访问审计 | 所有调阅操作日志化，保留 6 个月以上 |
| 多因素认证 | 医生调阅需 MFA（如密码 + 短信） |
| 数据脱敏 | 患者姓名/身份证脱敏显示（部分场景） |
| 容灾备份 | 异地容灾，数据 3-2-1 备份 |

#### 2. DICOMweb vs DIMSE 选型

**DIMSE 的优势与劣势**：

| 维度 | DIMSE |
|---|---|
| 优势 | 成熟、设备原生支持、长连接性能好、批量传输快 |
| 劣势 | 不适合跨网（需开放 104 端口）、Web 不友好、无 CDN 加速 |

**DICOMweb 的优势与劣势**：

| 维度 | DICOMweb |
|---|---|
| 优势 | HTTP/RESTful、Web 友好、CDN 加速、跨网穿透、防火墙友好 |
| 劣势 | 设备需改造（多数老设备不支持）、短连接性能略差 |

**体检场景的混合方案**：

```
┌──────────────────────────────────────────────────────┐
│  设备侧（DIMSE）              调阅侧（DICOMweb）      │
│                                                      │
│  B 超/DR/CT/心电 设备         浏览器/小程序/App       │
│       │                            │                 │
│       │ C-STORE                    │ QIDO+WADO-RS    │
│       ▼                            ▼                 │
│  ┌────────────────┐         ┌────────────────┐     │
│  │ 边缘网关        │         │ API Gateway    │     │
│  │ (DICOM SCP)    │         │                │     │
│  └────────┬───────┘         └────────┬───────┘     │
│           │                          │              │
│           │  协议转换                 │              │
│           ▼                          ▼              │
│  ┌────────────────────────────────────────────┐    │
│  │  云端 PACS (Orthanc + DICOMweb 插件)        │    │
│  │  - 接收 DIMSE C-STORE                       │    │
│  │  - 对外提供 DICOMweb QIDO/WADO/STOW         │    │
│  └────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────┘
```

**网关层协议转换**：

```
设备 (DIMSE C-STORE) ──> 边缘网关 (DICOM SCP)
                          │
                          │ STOW-RS（HTTP POST）
                          ▼
                       云端 PACS

设备 C-FIND (MWL)  <──  边缘网关 (DICOM SCU 代理)
                          │
                          │ QIDO-RS（HTTP GET）
                          ▼
                       云端 PACS
```

**网关层的设计**：

| 功能 | 实现 |
|---|---|
| DIMSE SCP（接收设备 C-STORE） | Orthanc / dcm4che |
| STOW-RS 上传云端 | HTTP POST multipart/related |
| 断网缓存 | 本地 SQLite/PostgreSQL + 文件系统 |
| 重传机制 | 队列 + 退避重试 |
| DIMSE SCU 代理（设备 C-FIND MWL） | 边缘网关将云端 QIDO-RS 响应转为 DICOM C-FIND 响应 |
| 协议转换 | DIMSE &lt;-> DICOMweb 双向 |

**混合方案的设备适配**：

| 设备类型 | 支持方式 |
|---|---|
| 新设备（支持 STOW-RS） | 直接 DICOMweb 上云，无需网关 |
| 老设备（仅支持 DIMSE） | 通过网关协议转换 |
| 便携设备（无网络） | 本地缓存，定期同步 |

#### 3. 影像上云的链路设计

**链路架构**：

```
体检机构设备
    │
    │ C-STORE (DIMSE)
    ▼
边缘网关（机构内）
├─ DICOM SCP（Orthanc 轻量部署）
├─ 本地缓存（PostgreSQL + 文件系统）
├─ 上传队列
└─ 重传器
    │
    │ 专线 / HTTPS（STOW-RS）
    ▼
云端 PACS（多 AZ 部署）
├─ Orthanc 集群（无状态）
├─ PostgreSQL 主从（多 AZ）
├─ 对象存储（S3/OSS，跨 AZ 复制）
└─ 异地容灾备份
    │
    ▼
互联网医院 / 调阅端
```

**边缘网关断网缓存与重传**：

```python
# 边缘网关上传逻辑
def upload_to_cloud(study_uid):
    try:
        # STOW-RS 上传
        response = stow_rs_upload(study_uid)
        if response.status == 200:
            mark_uploaded(study_uid)
        else:
            enqueue_retry(study_uid, delay=60)
    except NetworkError:
        enqueue_retry(study_uid, delay=60)

# 重传策略
def retry_queue():
    while True:
        pending = get_pending_uploads()
        for study in pending:
            upload_to_cloud(study.uid)
        time.sleep(60)
```

**重传策略**：

| 状态 | 处理 |
|---|---|
| 网络中断 | 本地缓存 7 天，恢复后 FIFO 上传 |
| 上传失败（5xx） | 指数退避（60s, 120s, 240s, ...），最大 1 小时 |
| 上传失败（4xx） | 告警，不重试（数据问题） |
| 本地缓存满 | LRU 淘汰已上传的，告警未上传的 |

**云端 PACS 高可用**：

| 层级 | 高可用方案 |
|---|---|
| Orthanc 应用 | 多实例 + 负载均衡（无状态） |
| PostgreSQL | 主从 + 自动切换（如 RDS / Patroni） |
| 对象存储 | 跨 AZ 复制（如 S3 跨区域复制） |
| 异地容灾 | 异地备份（如异地 OSS 同步） |
| DNS | 健康检查 + 自动切换 |

**合规要求**：

| 要求 | 实现 |
|---|---|
| 数据本地化 | 三甲机构私有部署，影像不出院 |
| 传输加密 | TLS 1.2+，禁用弱算法 |
| 存储加密 | 对象存储 SSE-KMS（密钥管理服务） |
| 访问审计 | 所有调阅操作日志化，保留 6 个月+ |
| 跨域传输 | 专线 / VPN / HTTPS |
| 数据出境 | 禁止医疗数据出境（个保法） |

**带宽与成本估算**：

```
场景：每日 1000 次体检

影像数据量估算：
- B 超：50MB/次 × 600 次 = 30GB
- DR：20MB/次 × 200 次 = 4GB
- CT：500MB/次 × 100 次 = 50GB
- 心电：5MB/次 × 100 次 = 0.5GB
- 总计：约 85GB/日

带宽估算：
- 工作时间 8 小时均匀分布
- 平均上行带宽：85GB / (8 × 3600s) = 3 MB/s = 24 Mbps
- 峰值（早晚高峰）：5x 平均 = 120 Mbps

存储成本（按 AWS OSS 标准）：
- 标准存储（热）：85GB × 30 天 = 2.55 TB/月
- 低频访问（温，3 个月前）：约 7.65 TB
- 归档（冷，3 年前）：约 92 TB（按 30 年保留）
- 月成本估算：约 2000-5000 美元（含流量）

专线 vs HTTPS：
- 专线（10Mbps 起步）：月费 5000-20000 元，固定成本
- HTTPS（按流量计费）：约 0.5 元/GB × 85GB × 30 = 1275 元/月
- 大机构选专线，小机构选 HTTPS
```

#### 4. 体检影像与 FHIR ImagingStudy 集成

**FHIR ImagingStudy 资源结构**：

```json
{
  "resourceType": "ImagingStudy",
  "id": "imaging-study-001",
  "status": "available",
  "subject": {
    "reference": "Patient/patient-001"
  },
  "encounter": {
    "reference": "Encounter/encounter-2026-0709-001"
  },
  "started": "2026-07-09T10:00:00+08:00",
  "basedOn": [
    {"reference": "ServiceRequest/exam-request-001"}
  ],
  "referrer": {
    "reference": "Practitioner/referrer-001"
  },
  "interpreter": [
    {"reference": "Practitioner/main-examiner-001"}
  ],
  "numberOfSeries": 1,
  "numberOfInstances": 50,
  "procedureReference": {
    "reference": "Procedure/b-ultrasound-procedure"
  },
  "procedureCode": [
    {
      "coding": [{
        "system": "http://snomed.info/sct",
        "code": "16310003",
        "display": "Ultrasonography of abdomen"
      }]
    }
  ],
  "reasonCode": [
    {
      "coding": [{
        "system": "http://snomed.info/sct",
        "code": "267036007",
        "display": "Dyspepsia"
      }]
    }
  ],
  "description": "腹部 B 超",
  "series": [
    {
      "uid": "1.2.840.xxxx.series.001",
      "number": 1,
      "modality": {
        "system": "http://dicom.nema.org/resources/ontology/DCM",
        "code": "US",
        "display": "Ultrasound"
      },
      "description": "肝脏切面",
      "numberOfInstances": 50,
      "bodySite": {
        "system": "http://snomed.info/sct",
        "code": "10200004",
        "display": "Liver"
      },
      "started": "2026-07-09T10:05:00+08:00",
      "instance": [
        {
          "uid": "1.2.840.xxxx.instance.001",
          "number": 1,
          "sopClass": {
            "system": "urn:ietf:rfc:3986",
            "code": "urn:oid:1.2.840.10008.5.1.4.1.1.6.1"
          },
          "title": "US Image 1"
        }
      ]
    }
  ],
  "endpoint": [
    {"reference": "Endpoint/dicomweb-endpoint-001"}
  ]
}
```

**ImagingStudy.endpoint 引用 DICOMweb WADO URI**：

```json
{
  "resourceType": "Endpoint",
  "id": "dicomweb-endpoint-001",
  "status": "active",
  "connectionType": {
    "system": "http://terminology.hl7.org/CodeSystem/endpoint-connection-type",
    "code": "dicom-wado-rs"
  },
  "name": "PACS DICOMweb Endpoint",
  "payloadType": [
    {
      "coding": [{
        "system": "http://terminology.hl7.org/CodeSystem/v3-MediaType",
        "code": "application/dicom"
      }]
    }
  ],
  "payloadMimeType": [
    "application/dicom",
    "application/dicom+json",
    "image/jpeg"
  ],
  "address": "https://pacs.example.org/dicom-web"
}
```

**调阅路径**：

```
1. 互联网医院 -> FHIR Server: GET /ImagingStudy?patient={id}
   返回 ImagingStudy 资源（含 Study Instance UID + Endpoint 引用）

2. 互联网医院 -> FHIR Server: GET /Endpoint/{endpointId}
   返回 DICOMweb 地址（如 https://pacs.example.org/dicom-web）

3. 互联网医院 -> PACS DICOMweb:
   GET https://pacs.example.org/dicom-web/studies/{studyInstanceUID}/series/{seriesUID}/instances/{instanceUID}/rendered
   Accept: image/jpeg
   
   返回渲染后的 JPEG，浏览器直接显示

4. 高级调阅（多张影像）：
   GET /dicom-web/studies/{studyUID}/metadata
   返回所有 Series + Instance 元数据
   前端用 Cornerstone.js 渲染
```

**DiagnosticReport 引用 ImagingStudy**：

```json
{
  "resourceType": "DiagnosticReport",
  "id": "exam-report-001",
  "status": "final",
  "code": {
    "coding": [{
      "system": "http://snomed.info/sct",
      "code": "16310003",
      "display": "Ultrasonography of abdomen"
    }]
  },
  "subject": {"reference": "Patient/patient-001"},
  "effectiveDateTime": "2026-07-09T10:00:00+08:00",
  "imagingStudy": [
    {"reference": "ImagingStudy/imaging-study-001"}
  ],
  "conclusion": "脂肪肝，建议定期复查",
  "conclusionCode": [
    {
      "coding": [{
        "system": "http://hl7.org/fhir/sid/icd-10",
        "code": "K76.0",
        "display": "脂肪肝"
      }]
    }
  ]
}
```

**跨系统调阅协同链路**：

```
┌──────────────────────────────────────────────────────────────┐
│  互联网医院                     FHIR Server       PACS        │
│                                                              │
│  1. 查询体检报告 ───────────> GET /DiagnosticReport           │
│                              ?patient={id}                   │
│                                                              │
│  2. 返回 DiagnosticReport（含 imagingStudy 引用）             │
│                                                              │
│  3. 查询 ImagingStudy ───────> GET /ImagingStudy/{id}        │
│                                                              │
│  4. 返回 ImagingStudy（含 StudyInstanceUID + Endpoint）       │
│                                                              │
│  5. 调阅影像 ───────────────────────────────────> WADO-RS    │
│     GET /dicom-web/studies/{UID}/rendered                    │
│                                                              │
│  6. 返回 JPEG/渲染后影像                                      │
│                                                              │
│  7. 前端显示影像 + 报告                                       │
└──────────────────────────────────────────────────────────────┘
```

#### 5. AI 辅助诊断的影像集成

**体检场景的 AI 应用**：

| AI 应用 | 影像类型 | 临床价值 |
|---|---|---|
| 肺结节 AI 筛查 | CT | 早期肺癌筛查 |
| 乳腺 AI 超声 | 超声 | 乳腺肿块良恶性判别 |
| 眼底 AI 筛查 | 眼底照相 | 糖尿病视网膜病变筛查 |
| 骨密度 AI | DEXA | 骨质疏松评估 |
| 心电 AI | ECG | 心律失常筛查 |
| 肝纤维化 AI | 超声弹性 | 肝纤维化分级 |

**AI 服务的影像接入方式**：

**方式 A：DICOM DIMSE 推送（传统）**：

- PACS 配置 DICOM 路由，CT Study 自动转发到 AI 服务的 DICOM SCP
- AI 服务接收后推理，结果回写 PACS

**方式 B：DICOMweb STOW + WADO（推荐）**：

- AI 服务的输入：WADO-RS 从 PACS 拉取影像
- AI 服务的输出：STOW-RS 将推理结果（DICOM SR / Segmentation Object）写回 PACS

**方式 C：FHIR + DICOMweb 协同**：

- 互联网医院通过 FHIR 调阅 ImagingStudy，触发 AI 推理
- AI 推理结果作为 FHIR Observation 或 DiagnosticReport 返回

**AI 推理结果的存储**：

| 存储方式 | 含义 | 适用场景 |
|---|---|---|
| DICOM SR（Structured Report） | 结构化报告（XML/JSON 编码） | 文本类结果（结节位置、大小、特征） |
| DICOM Segmentation Object | 分割对象（mask 影像） | 像素级分割（结节轮廓） |
| DICOM RT Structure Set | 放射治疗结构集 | 放疗靶区勾画 |
| DICOM Secondary Capture | 二次采集（截图） | 标注后的影像截图 |
| FHIR Observation | FHIR 资源 | 跨系统调阅、互联网医院 |
| FHIR DiagnosticReport | FHIR 报告 | AI 报告整体呈现 |

**肺结节 AI 推理结果示例（DICOM SR）**：

```json
{
  "resourceType": "ImagingStudy",
  "id": "ct-study-001",
  "series": [
    {
      "uid": "1.2.840.ct.series",
      "modality": {"code": "CT"}
    },
    {
      "uid": "1.2.840.sr.series",
      "modality": {"code": "SR"},
      "description": "AI 肺结节筛查结果",
      "instance": [
        {
          "uid": "1.2.840.sr.instance",
          "sopClass": {
            "code": "urn:oid:1.2.840.10008.5.1.4.1.1.88.22"
          }
        }
      ]
    }
  ]
}
```

**SR 内容（肺结节结果）**：

```
- 患者信息：张三
- 检查信息：CT 胸部扫描
- AI 模型：肺结节筛查 v1.2
- 推理时间：2026-07-09 10:30:00
- 结论：
  - 结节 1：右上叶，6mm × 5mm，边缘光滑，良性可能大
  - 结节 2：左下叶，8mm × 7mm，边缘毛刺，建议进一步检查
- 建议：6 个月后复查 CT
```

**AI 工作流设计**：

```
T0: CT 设备 C-STORE 推送影像到 PACS
T1: PACS 路由配置：CT Study -> AI 服务（DICOM 转发或 Webhook 触发）
T2: AI 服务接收影像，开始推理
T3: AI 推理完成（耗时 30s-3min，按影像数）
T4: AI 服务将结果写回 PACS（DICOM SR / Segmentation Object）
T5: AI 服务通知体检系统（Webhook 或 MQ）
T6: 体检系统更新申请单状态（"AI 推理完成"）
T7: 主检医生在工作站看到 AI 结果 + 原影像
T8: 主检医生审核 AI 结果：
    - 同意：直接采纳
    - 修改：手动调整（生成新版本 SR）
    - 拒绝：标记错误，反馈给 AI 团队
T9: 主检医生签发报告（DiagnosticReport.status = final）
```

**AI 推理延迟对主检流程的影响**：

| 延迟场景 | 处理策略 |
|---|---|
| 短延迟（&lt; 30s） | 同步等待，主检医生看到 AI 结果后再审核 |
| 中延迟（30s-3min） | 异步处理，主检医生先看影像，AI 结果出来后推送提示 |
| 长延迟（> 3min） | 异步队列，主检医生先签发报告，AI 结果后补，需要时修订 |

**异步处理设计**：

```java
@Service
public class AiInferenceService {
    @Autowired private MqProducer mqProducer;
    
    public void triggerAiInference(Study study) {
        // 1. 异步队列触发
        mqProducer.send("ai.inference.queue", new AiTask(study.getStudyInstanceUID()));
        
        // 2. 状态标记
        study.setAiStatus("PENDING");
        studyRepo.save(study);
    }
    
    @EventListener
    public void onAiResultReady(AiResultEvent event) {
        // 3. AI 结果就绪，更新状态
        Study study = studyRepo.findByUID(event.getStudyUID());
        study.setAiStatus("COMPLETED");
        study.setAiResultUID(event.getResultUID());
        studyRepo.save(study);
        
        // 4. 通知主检医生
        notificationService.notifyExaminer(study.getMainExaminer(), 
            "AI 推理结果已就绪: " + study.getAccessionNumber());
    }
}
```

**AI 推理结果的合规要求**：

| 要求 | 实现 |
|---|---|
| AI 模型备案 | NMPA（国家药监局）二类/三类医疗器械注册证 |
| 医生审核 | AI 结果不能直接签发，必须医生审核 |
| 审计日志 | AI 推理过程、医生修改记录可追溯 |
| 模型版本 | 每次推理记录模型版本，可回溯 |
| 失效回退 | AI 服务不可用时，主检流程不阻塞 |

---

## 与架构师水平的差距自评

> **知识点掌握**：DICOM 文件结构（Preamble + DICM + Data Elements）、Tag/VR/Length/Value 编码、Transfer Syntax、DIMSE-C/DIMSE-N 命令体系、SOP Class UID、Association 协商流程能讲清；DICOMweb（QIDO/WADO/STOW）的 RESTful 接口能讲清；FHIR ImagingStudy 资源与 DICOM Study 的集成思路清楚；但 DICOM 协议的细节（Presentation Context 协商的失败处理、Storage Commitment 的状态机）不熟。
>
> **架构思维**：PACS 部署架构（单租户/多租户/混合）的选型权衡能讲清；DICOMweb vs DIMSE 的选型思路清晰；云原生 PACS（边缘网关 + 云端集群 + 对象存储）的链路设计能画清；但多机构 SaaS 下影像数据的合规边界（哪些可以上云、哪些必须私有）、边缘网关断网缓存的具体工程实现（消息库、重传策略、容量规划）需要补足。
>
> **工程细节**：Orthanc 部署、Docker 配置、与体检系统对接的 REST API 调用能写出代码示例；FHIR ImagingStudy + Endpoint + WADO-RS 的协同链路能设计；但 Orthanc 集群部署、PostgreSQL 调优、对象存储（S3/OSS）的接入、Cornerstone.js 渲染性能优化需要实践。
>
> **业务理解**：体检场景的影像集成（MWL -> C-STORE -> 调阅）流程清晰；Accession Number 作为核心关联键的设计能讲清；AI 辅助诊断的影像接入、SR/Segmentation Object 存储、AI 工作流（异步推理 + 医生审核）能设计；但 AI 推理结果到 FHIR Observation/DiagnosticReport 的映射、AI 服务的合规（NMPA 二类/三类注册）、AI 工作流的延迟治理需要补足。
>
> **合规意识**：等保三级对医疗影像的约束（数据本地化、传输加密、访问审计）能讲清框架；但医疗数据上云的具体合规要求（影像是否能上公有云、跨域传输的报备流程）、AI 辅助诊断的医疗器械注册证要求、患者影像的隐私脱敏规则需要补足。
>
> **补足方向**：
> 1. 部署 Orthanc 开源 PACS（Docker + PostgreSQL），实践设备 C-STORE 接收与 REST API 调阅
> 2. 学习 DICOM 协议细节（DIMSE-C/DIMSE-N 命令、Association 协商、Storage Commitment）
> 3. 实践 DICOMweb（QIDO-RS / WADO-RS / STOW-RS）的接口调用
> 4. 学习 Cornerstone.js / OHIF Viewer 的 Web 端影像渲染
> 5. 实践 Modality Worklist（MWL）的生成与设备对接
> 6. 学习影像分层存储（Hot/Warm/Cold）与对象存储（S3/OSS）的接入
> 7. 学习 FHIR ImagingStudy 资源与 DICOM Study 的集成（Endpoint 引用 WADO URI）
> 8. 调研 AI 辅助诊断的影像集成（肺结节 AI、眼底 AI）与 DICOM SR / Segmentation Object
> 9. 学习医疗影像的合规要求（等保三级、医疗数据本地化、AI 医疗器械注册证）
> 10. 复盘啄木鸟云健康的影像集成现状，规划"MWL 标准化 + DICOMweb 调阅 + 云原生 PACS"的演进路径