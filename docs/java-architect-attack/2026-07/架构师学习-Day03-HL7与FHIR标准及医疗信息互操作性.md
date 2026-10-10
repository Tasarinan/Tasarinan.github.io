# 架构师学习-Day03-HL7与FHIR标准及医疗信息互操作性

> 日期：2026年07月08日（周三）
> 周主题：医疗信息化专题
> 出题日：Day03 - HL7/FHIR 标准与医疗信息互操作性

---

## 背景

Day02 把镜头拉近到 HIS/EMR 与体检系统的对接，题目一提到"集成模式选型（点对点 / 集成引擎 / HL7 v2 / FHIR）"，题目二提到"实时查询（FHIR/HL7 v2 接口）"，题目三提到"结构化回写（CDA Entry/Observation）"。这些都是医疗信息化的"互操作性（Interoperability）"主题，但 Day02 没有展开。Day03 把镜头彻底拉到"标准本身"。

为什么 HL7/FHIR 对你重要？

1. **跳槽到更好的医疗公司**：医疗信息化公司（卫宁、东软、创业慧康、嘉和美康、医惠）的产品矩阵中，"对外标准接口"是技术亮点。FHIR 是当下医疗信息化最热的标准，能讲清 FHIR 资源模型、实践过 FHIR Server，是医疗架构师的加分项。
2. **公卫体检数据交换的现实**：公卫体检上报走国标 XML/JSON（不是 FHIR），但区域卫生信息平台、跨机构调阅、商业保险对接越来越多用 FHIR。从"国标上报"到"FHIR 互操作"的演进，是公卫 SaaS 架构师必须看清的趋势。
3. **三甲医院 EMR 共享文档**：CDA 是 HL7 v3 的文档模型，国内《电子病历基本数据集》《卫生信息基本数据集》的"共享文档规范"就是 CDA 衍生。CDA 与 FHIR 的关系（CDA 是 HL7 v3 文档模型，FHIR 是 HL7 最新标准，两者并存）是医疗架构师必须搞清的标准演进图。
4. **Mirth Connect 集成引擎**：医疗信息化的"中间件之王"。Mirth 把 HL7 v2 / FHIR / DICOM / 数据库 / WebService / FTP 等异构系统串起来，是三甲医院集成平台的事实标准。能用 Mirth 写复杂消息转换（HL7 v2 -> FHIR），是医疗集成架构师的核心硬技能。
5. **能力差距 1.1、1.3 集中在 HL7/FHIR**：Day01 差距梳理中明确指出"FHIR 资源模型实践不足""Mirth Connect 工程实践不足"，是本周重点补足方向。

本日三道题：
- 题目一：HL7 v2 / v3 / CDA / FHIR 四代标准对比与体检系统选型（架构设计题）
- 题目二：基于 FHIR 资源建模体检业务 + FHIR Server 接口设计（工程实战题）
- 题目三：Mirth Connect 集成引擎实战 + 体检系统对外 FHIR 接口落地（选型权衡题）

---

## 题目一（架构设计题）：HL7 v2 / v3 / CDA / FHIR 四代标准对比与体检系统选型

请回答：

1. HL7 v2、HL7 v3、CDA、FHIR 各自的诞生背景、核心模型、消息格式、优缺点？为什么 HL7 v2 至今仍是国内医院集成的事实标准？为什么 FHIR 能成为下一代主流？四代标准的演进逻辑（语法/模型/协议/生态）是什么？
2. 国内医疗信息化的"标准生态"：国标（公卫规范、电子病历基本数据集）、行标（卫生信息共享文档规范）、国际标准（HL7、FHIR、IHE、SNOMED CT、LOINC、ICD）。它们之间的映射关系？公卫体检上报为什么用国标 XML 而不用 FHIR？什么场景下应该用 FHIR？
3. 体检系统对外提供接口时（对接 HIS/EMR/区域平台/商业保险/互联网医院），应该选 HL7 v2、CDA、还是 FHIR？多机构 SaaS 下不同对接方的标准差异如何屏蔽？同一体检系统对外同时提供 HL7 v2（对接老 HIS）和 FHIR（对接新互联网医院）的双协议如何实现？
4. FHIR 在国内的落地现状与挑战：FHIR Server 产品（HAPI FHIR / IBM FHIR / Microsoft Azure API for FHIR / 阿里健康 FHIR）、中文 FHIR 实施指南（IG）、FHIR 与国标的兼容、FHIR 与 CDA 的过渡。一个公卫 SaaS 公司要引入 FHIR，应该从哪个场景切入？

### 作答区

#### 1. HL7 四代标准对比

**演进时间线**：

```
1987 ─── HL7 v1（实验室内部，未推广）
1989 ─── HL7 v2.1（事件驱动、消息模型）
   │
   ├─ v2.2 (1994)
   ├─ v2.3 (1997)  国内医院最早接触
   ├─ v2.3.1 (1999)
   ├─ v2.4 (2000)  国内医院最常用版本
   ├─ v2.5 / v2.6 / v2.7
   └─ v2.8 (2014)
1996 ─── HL7 v3 草案（RIM 模型、XML 语法）
2005 ─── HL7 v3 正式发布
   └─ CDA R1 (2000) / R2 (2005) / R3 (CDA R2 IG B1 2018)
2011 ─── FHIR DSTU 1（Draft Standard for Trial Use）
2014 ─── FHIR DSTU 2
2017 ─── FHIR STU 3
2019 ─── FHIR R4（首个正式版 Normative）
2023 ─── FHIR R5
2025 ─── FHIR R6（草案）
```

**四代标准核心对比**：

| 维度 | HL7 v2 | HL7 v3 | CDA | FHIR |
|---|---|---|---|---|
| 诞生年代 | 1989 | 2005 | 2000 | 2011 |
| 数据模型 | 消息模型（事件驱动） | RIM（Reference Information Model） | CDA 模型（Header + Body） | 资源模型（Resource） |
| 语法 | 竖线分隔符（|） | XML | XML | JSON / XML |
| 通信协议 | MLLP / TCP | SOAP / WebService | 文档交换（无固定协议） | RESTful / HTTP |
| 学习曲线 | 看似简单，细节复杂 | 极陡（RIM 模型庞大） | 中等（基于 v3） | 平缓（RESTful + JSON） |
| 互操作性 | 厂家自定义 Z 段破坏互操作 | 模型完整但实施难 | 文档级互操作 | API 级互操作 |
| 国内现状 | **医院集成事实标准** | 几乎未落地 | 共享文档规范基础 | 起步阶段 |
| 适合场景 | 实时消息（挂号/检验结果推送） | 复杂临床模型（少用） | 文档归档与共享 | RESTful API、跨机构 |
| 实施成本 | 低（消息简单） | 高（RIM 学习成本） | 中（模板设计） | 低（RESTful） |
| 演进方向 | 维护性升级 | 基本停止 | CDA-on-FHIR | 持续演进 |

**HL7 v2 消息结构示例（ADT^A04 患者挂号）**：

```
MSH|^~\&|HIS|HOSP_A|EMR|HOSP_A|20260708120000||ADT^A04|MSG00001|P|2.4
EVN|A04|20260708120000
PID|1||PAT000123^^^HOSP_A||张^三||19650101|M|||北京市朝阳区^XX路1号^^100000
PV1|1|O|OUTPATIENT^^^DEPT0001
```

- MSH：消息头（Message Header），含发送方、接收方、消息类型、版本
- EVN：事件类型（Event Type），A04 = 注册
- PID：患者信息（Patient Identification）
- PV1：就诊信息（Patient Visit）
- 字段分隔符：`|`；组件分隔符：`^`；重复分隔符：`~`；转义符：`\`；子组件分隔符：`&`

**HL7 v2 至今仍是国内事实标准的原因**：

| 原因 | 详解 |
|---|---|
| 历史包袱 | 90 年代起医院 HIS 用 v2.3/v2.4，集成引擎、点对点接口都基于 v2，替换成本极高 |
| 实时消息优势 | MLLP/TCP 长连接推送（如挂号推送、检验结果推送）是 v2 的强项，FHIR RESTful 是请求-响应，实时推送需 WebSocket |
| 简单粗暴 | 一行 `MSH|...` 比一段 XML/JSON 短得多，串口/窄带网络友好 |
| 厂家定制 | Z 段（Z-segment）允许厂家自定义字段，灵活但破坏互操作 |
| 集成引擎生态 | Mirth Connect、Rhapsody、Corepoint 等对 v2 支持最完整 |
| 国内标准滞后 | 国标（如 WS 445）和行标（共享文档规范）走 CDA 路线，未推动 v2 升级到 FHIR |

**HL7 v3 失败的原因**：

- RIM（Reference Information Model）模型过于庞大（6000+ 类），学习曲线极陡
- XML 消息冗长，性能差
- 实施成本高，落地案例少
- 但 CDA（HL7 v3 的文档模型）成功，因为只取了 v3 的"文档"部分，简化了模型

**FHIR 能成为下一代主流的原因**：

| 优势 | 详解 |
|---|---|
| RESTful + JSON | 与现代 Web 技术栈兼容，开发门槛低 |
| 资源模型 | Patient/Observation/DiagnosticReport 等独立资源，可组合、可扩展 |
| 可扩展性 | Extension 机制允许厂家/国标扩展，不破坏核心规范 |
| API 优先 | 天然支持 CRUD、搜索、批量、订阅，符合现代 API 设计 |
| 文档即资源 | DocumentReference、Bundle 等资源可承载 CDA 文档（CDA-on-FHIR） |
| 生态完善 | HAPI FHIR（Java）、IBM FHIR Server、Azure API for FHIR、Google Cloud FHIR |
| 行业采用 | 美国 ONC 规定 2022 年起医院必须支持 FHIR；欧盟、日本跟进 |

**演进逻辑**：

```
v2（消息驱动）── 优点：实时、轻量
   │             缺点：无统一模型，Z 段破坏互操作
   ▼
v3（RIM 模型）── 优点：模型完整
   │             缺点：太重、实施难
   ▼
CDA（文档模型）── 优点：文档级互操作
   │             缺点：仅文档，无 API
   ▼
FHIR（资源 + REST）── 优点：现代、轻量、API 化
                     缺点：仍在演进，国内落地少
```

#### 2. 国内医疗信息化标准生态

**标准层级**：

```
┌─────────────────────────────────────────────────────┐
│  国际标准                                            │
│  ├─ HL7 v2 / v3 / CDA / FHIR                        │
│  ├─ IHE（ITI、PIX、XDS、PIX、PDQ）                  │
│  ├─ SNOMED CT（临床术语）                            │
│  ├─ LOINC（检验/观察项编码）                         │
│  ├─ ICD-9/10/11（疾病诊断编码）                      │
│  ├─ DICOM（影像）                                   │
│  └─ RxNorm（药品编码）                              │
└─────────────────────────────────────────────────────┘
                       │
                       ▼ 国标化（本土化）
┌─────────────────────────────────────────────────────┐
│  国家标准（GB/T、WS/T）                              │
│  ├─ WS 445《电子病历基本数据集》                     │
│  ├─ WS/T 500《电子病历应用管理规范》                 │
│  ├─ 卫生信息共享文档规范（基于 CDA）                 │
│  ├─ 《国家基本公共卫生服务规范》第三版               │
│  ├─ GB/T 14396《疾病分类与代码》（ICD-10 国标化）    │
│  └─ GB/T 21715《健康档案基本架构》                   │
└─────────────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│  行业标准 / 团体标准                                 │
│  ├─ 互联网医院数据交换规范（部分省份用 FHIR）         │
│  ├─ 医保结算接口规范（国家医保局）                   │
│  └─ 商业保险理赔数据交换（部分用 FHIR）              │
└─────────────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│  厂家私有标准                                        │
│  ├─ 卫宁/东软/创业慧康私有 API                       │
│  ├─ 各省公卫系统私有 WebService                      │
│  └─ 各省医保平台私有接口                             │
└─────────────────────────────────────────────────────┘
```

**核心映射关系**：

| 国际标准 | 国内对应标准 | 差异 |
|---|---|---|
| HL7 v2 | 无国标对应 | 国内医院直接用 v2.4 |
| HL7 v3 / CDA | 卫生信息共享文档规范 | CDA 的中国本土化（CN-CDA） |
| FHIR | 部分省份互联网医院规范采用 | 暂无统一国标 |
| LOINC | WS 445 部分引用 | 国内常用厂家自编代码 |
| SNOMED CT | 国内未广泛采用 | 中文 SNOMED 在试点 |
| ICD-10 | GB/T 14396 | ICD-10 中国版（含 2 万条扩展码） |
| IHE XDS | 卫生信息共享文档规范的传输部分 | 国内 XDS 落地少 |
| DICOM | 无国标对应（直接用 DICOM） | 国内 PACS 厂家直接用 DICOM |

**公卫体检上报为什么用国标 XML 而不用 FHIR**：

| 原因 | 详解 |
|---|---|
| 国标强制 | 《国家基本公共卫生服务规范》第三版明确要求数据格式（国标 XML/JSON），不是 FHIR |
| 省级平台对接 | 各省公卫系统接口规范由省卫健委制定，多基于 WebService + 国标 XML |
| 历史包袱 | 公卫系统从 2009 年新医改开始建设，已沉淀大量国标 XML 接口 |
| 数据结构差异 | 国标按"人群分类"组织（老年人/高血压/糖尿病），FHIR 按"资源"组织，模型不同 |
| 监管要求 | 卫健委考核按国标字段验收，FHIR 字段不直接对应考核字段 |
| 实施成本 | 改用 FHIR 需要全国 31 个省级公卫系统同步升级，不现实 |

**何时应该用 FHIR**：

| 场景 | 适用 FHIR 程度 | 原因 |
|---|---|---|
| 公卫上报省级系统 | ✗ | 国标强制 |
| 体检系统对接医院 HIS/EMR | △ | 看 HIS 厂家支持，部分新版本支持 FHIR |
| 体检系统对接互联网医院 | ✓ | 互联网医院多用 FHIR/RESTful |
| 跨机构居民健康档案调阅 | ✓ | FHIR 的 Patient/$everything、DocumentReference 适合 |
| 商业保险理赔数据交换 | ✓ | 部分保险公司用 FHIR（如平安、太保） |
| 区域卫生信息平台 | △ | 部分新建区域平台用 FHIR，老平台用 CDA |
| 科研数据共享 | ✓ | FHIR 资源模型适合科研数据集 |
| 设备数据接入 | ✗ | 设备用 DICOM / ASTM / 私有协议 |
| 对外开放 API（互联网医院/患者端） | ✓ | FHIR 是 RESTful，前端友好 |

#### 3. 体检系统对外接口的标准选型

**多对接方场景与标准选型**：

| 对接方 | 标准 | 原因 |
|---|---|---|
| 老 HIS（卫宁/东软） | HL7 v2.4 | 厂家支持最稳定 |
| 新 HIS（部分新版） | FHIR R4 | 新版本支持 FHIR |
| 区域卫生信息平台 | HL7 v2 / CDA / FHIR | 看平台建设年代，老平台 CDA，新平台 FHIR |
| 省级公卫系统 | 国标 XML + WebService | 国标强制 |
| 商业保险（平安/太保） | FHIR R4 | 部分保险公司采用 |
| 互联网医院 | FHIR R4 | 互联网医院多用 FHIR |
| 患者端（小程序） | FHIR R4 / 私有 RESTful | FHIR 前端友好 |
| 影像系统 PACS | DICOM | 影像唯一标准 |
| 检验系统 LIS | ASTM / HL7 v2 ORU | LIS 多用 ASTM，部分用 v2 |

**双协议（HL7 v2 + FHIR）实现方案**：

```
                     体检系统业务核心
                            │
                            ▼
                   ┌─────────────────┐
                   │  标准接口层      │
                   │  （领域模型）    │
                   │  Patient/Visit/ │
                   │  Observation/   │
                   │  Report         │
                   └────────┬────────┘
                            │
                ┌───────────┼───────────┐
                ▼           ▼           ▼
         ┌──────────┐ ┌──────────┐ ┌──────────┐
         │ HL7 v2   │ │ FHIR R4  │ │ 国标 XML │
         │ 适配器   │ │ 适配器   │ │ 适配器   │
         └────┬─────┘ └────┬─────┘ └────┬─────┘
              │            │            │
         MLLP/TCP     REST/HTTP     WebService
              │            │            │
              ▼            ▼            ▼
           老 HIS      互联网医院     省级公卫
                      /商业保险
```

**核心设计**：

1. **领域模型层**：体检系统内部用统一的领域模型（不绑定任何标准）
2. **标准适配器**：每个标准一个适配器，负责领域模型 ↔ 标准格式的双向转换
3. **协议层**：每个适配器内封装对应协议（MLLP / HTTP / SOAP）

**领域模型示例**：

```java
// 体检系统内部领域模型（与标准无关）
public class ExamReport {
    private String reportId;
    private Patient patient;
    private Visit visit;
    private List<Observation> observations;  // 检查检验项
    private String conclusion;               // 主检结论
    private Doctor mainExaminer;
    private LocalDateTime publishTime;
}

// HL7 v2 适配器：转换为 ORU^R01 消息
public class HL7V2Adapter {
    public String toORUR01(ExamReport report) {
        // MSH|...|ORU^R01|...
        // PID|...（患者）
        // OBR|...（体检报告主检）
        // OBX|...（每项观察）
    }
}

// FHIR 适配器：转换为 DiagnosticReport 资源
public class FhirAdapter {
    public DiagnosticReport toDiagnosticReport(ExamReport report) {
        DiagnosticReport dr = new DiagnosticReport();
        dr.setSubject(new Reference("Patient/" + report.getPatient().getId()));
        dr.setStatus(DiagnosticReport.DiagnosticReportStatus.FINAL);
        dr.setResult(report.getObservations().stream()
            .map(o -> new Reference("Observation/" + o.getId()))
            .collect(Collectors.toList()));
        dr.setConclusion(report.getConclusion());
        return dr;
    }
}

// 国标适配器：转换为公卫上报 XML
public class NationalStandardAdapter {
    public String toPublicHealthXML(ExamReport report) {
        // 按《国家基本公共卫生服务规范》第三版格式
        // <体检记录><人群分类>...</人群分类>...</体检记录>
    }
}
```

**多对接方路由**：

```java
public class InterfaceRouter {
    public void sendReport(ExamReport report, Counterparty counterparty) {
        Standard standard = counterparty.getStandard();
        switch (standard) {
            case HL7_V2:
                String hl7Msg = hl7Adapter.toORUR01(report);
                mllpSender.send(counterparty.getEndpoint(), hl7Msg);
                break;
            case FHIR_R4:
                DiagnosticReport dr = fhirAdapter.toDiagnosticReport(report);
                fhirClient.create(dr);
                break;
            case NATIONAL_XML:
                String xml = nsAdapter.toPublicHealthXML(report);
                wsClient.call(counterparty.getEndpoint(), xml);
                break;
        }
    }
}
```

#### 4. FHIR 在国内的落地现状与挑战

**FHIR Server 产品对比**：

| 产品 | 厂家 | 类型 | 特点 | 适用场景 |
|---|---|---|---|---|
| HAPI FHIR | 加拿大 UHN 开源 | 开源 Java 库 | 最完整的 FHIR 实现，支持 R4/R5 | 自建 FHIR Server |
| IBM FHIR Server | IBM 开源 | 开源 | 企业级，支持 R4 | 企业级部署 |
| Microsoft Azure API for FHIR | 微软 | 云服务 | 托管、合规（HIPAA） | 国外业务 |
| Google Cloud FHIR Store | 谷歌 | 云服务 | 与 BigQuery 集成 | 国外业务 |
| AWS HealthLake | 亚马逊 | 云服务 | 内置 ML | 国外业务 |
| 阿里健康 FHIR | 阿里 | 国内云 | 国内最早 FHIR 实践 | 国内互联网医疗 |
| 东软 Neusoft FHIR | 东软 | 商业 | HIS 厂家支持 | 东软 HIS 集成 |
| 微脉 / 平安好医生 | 各家 | 自研 | 互联网医院用 | 自有互联网医院 |

**中文 FHIR 实施指南（IG）现状**：

- 中国电子技术标准化研究院（CESI）发布《健康医疗数据安全指南》，未发布官方 FHIR IG
- 国家卫健委发布《医院信息互联互通标准化成熟度测评》，部分指标提及 FHIR
- 部分 OpenEHR 中文社区在推动中文 FHIR IG
- 实践案例：上海、浙江部分互联网医院试点 FHIR

**FHIR 与国标的兼容挑战**：

| 挑战 | 详解 |
|---|---|
| 资源模型差异 | 国标按"人群分类"组织，FHIR 按"资源"组织，无直接映射 |
| 编码体系 | 国标用 GB/T 14396（ICD-10 中国版），FHIR 用 ICD-10/LOINC/SNOMED CT |
| 扩展机制 | FHIR 用 Extension，国标用 XML 元素扩展，需设计转换规则 |
| 术语映射 | 国标检验项代码与 LOINC 映射不全 |
| 数据结构 | 国标的"人群分类""健康评估"在 FHIR 中无对应资源，需用 Observation + Extension |
| 验证标准 | 卫健委考核按国标字段，FHIR 资源需要逆向映射到国标字段 |

**FHIR 与 CDA 的过渡**：

- CDA-on-FHIR：用 FHIR 资源（Bundle + Composition）承载 CDA 文档
- DocumentReference 资源：用 FHIR 资源引用 CDA 文档
- 过渡策略：体检报告同时归档 CDA + FHIR，CDA 满足国标合规，FHIR 满足 API 互操作

**公卫 SaaS 公司引入 FHIR 的切入场景**：

| 切入场景 | 价值 | 复杂度 |
|---|---|---|
| 对外开放患者端 API（小程序） | FHIR 前端友好，方便小程序对接 | 低 |
| 对接互联网医院 | 互联网医院多用 FHIR | 中 |
| 对接商业保险理赔 | 部分保险公司用 FHIR | 中 |
| 跨机构居民健康档案调阅 | FHIR 的 Patient/$everything 适合 | 中高 |
| 区域卫生信息平台对接（新建） | 新建平台倾向 FHIR | 高 |
| 内部数据中台统一资源模型 | FHIR 资源作为统一模型 | 高 |

**推荐切入路径**：

1. **第一步**：内部数据中台用 FHIR 资源模型重构（不影响对外接口）
2. **第二步**：患者端 API 用 FHIR（小程序前端友好）
3. **第三步**：对接互联网医院/商业保险用 FHIR
4. **第四步**：内部用 FHIR Server 作为统一数据访问层
5. **第五步**：区域卫生信息平台对接（待省级平台支持 FHIR）

**啄木鸟云健康的现实路径**：

- 短期（6 个月）：保持国标 XML 上报，新增患者端 FHIR 接口（小程序调阅体检报告）
- 中期（1-2 年）：内部数据中台用 FHIR 资源模型，对外接口逐步 FHIR 化
- 长期（3 年）：对省级公卫系统仍保持国标，对医院 HIS/互联网医院用 FHIR

---

## 题目二（工程实战题）：基于 FHIR 资源建模体检业务 + FHIR Server 接口设计

请回答：

1. 用 FHIR 资源建模一次完整的公卫体检（预约-报到-检中-主检-报告），列出涉及的资源（Patient/Encounter/ServiceRequest/Observation/DiagnosticReport/DocumentReference/Practitioner/Organization）、资源间引用关系、关键字段。如何用 Extension 表达国标特有字段（人群分类、健康评估、随访建议）？
2. 体检系统的 FHIR Server 接口设计：列出关键 RESTful 接口（CRUD Patient、按身份证搜索 Patient、按 Patient 拉取所有 Observation、按 Encounter 拉取 DiagnosticReport、批量上传 Observation、订阅体检报告生成事件）。搜索参数（Search Parameter）的设计原则？包含（Include）与反向链（Reverse Chain）的应用？
3. 体检数据 FHIR 接口与公卫上报国标接口的双轨实现：如何在内部领域模型上同时支持 FHIR 接口和国标 XML 上报？如何保证两套接口的数据一致性？国标上报失败时如何反馈到 FHIR 接口（如 Observation.status = "entered-in-error"）？
4. FHIR 资源版本控制与并发：同一 Observation 被多端修改（医生修改 + 设备自动上传）如何用 ETag + If-Match 实现乐观锁？FHIR 的历史版本（History）如何查询？版本冲突时如何解决？FHIR 的事务（Transaction Bundle）如何在体检批量上传中应用？

### 作答区

#### 1. FHIR 资源建模体检业务

**体检全流程的 FHIR 资源映射**：

| 体检阶段 | FHIR 资源 | 用途 |
|---|---|---|
| 预约 | Appointment + ServiceRequest | 预约时间 + 体检项目申请 |
| 报到 | Encounter（status=arrived） | 一次体检就诊 |
| 检中（生命体征） | Observation（category=vital-signs） | 血压、身高、体重、BMI |
| 检中（检验） | Observation（category=laboratory） + Specimen | 血常规、生化、尿常规 |
| 检中（影像） | ImagingStudy + DiagnosticReport（imaging） | B 超、CT、X 光 |
| 检中（心电） | Observation（category=procedure） + Media | 心电图波形 |
| 主检 | DiagnosticReport（status=preliminary） | 主检报告 |
| 报告 | DiagnosticReport（status=final） + DocumentReference | 体检报告 + PDF 文档 |
| 异常随访 | Task / CarePlan | 随访工单 |
| 转诊 | ServiceRequest（referral） | 转诊到上级医院 |

**资源引用关系图**：

```
Patient ──┬── Encounter（体检就诊）
          │      │
          │      ├── ServiceRequest（体检项目申请）
          │      │      │
          │      │      └── Observation（检查检验结果）
          │      │             │
          │      │             └── Specimen（标本，检验项）
          │      │
          │      └── DiagnosticReport（主检报告）
          │             │
          │             └── result: Observation[]
          │
          ├── DocumentReference（体检报告 PDF）
          │      └── content: Binary（PDF 二进制）
          │
          └── ImagingStudy（影像检查）
                  └── series -> instance（DICOM 影像）

Practitioner ──┬── Encounter.participant（体检医生）
               └── DiagnosticReport.performer（主检医生）

Organization ── Encounter.serviceProvider（体检机构）
```

**FHIR 资源示例（体检报告 DiagnosticReport）**：

```json
{
  "resourceType": "DiagnosticReport",
  "id": "exam-report-2026-0708-001",
  "meta": {
    "versionId": "2",
    "lastUpdated": "2026-07-08T15:30:00+08:00",
    "profile": ["http://example.org/fhir/StructureDefinition/ExamReport"]
  },
  "status": "final",
  "category": [
    {
      "coding": [{
        "system": "http://terminology.hl7.org/CodeSystem/v2-0074",
        "code": "LAB",
        "display": "Laboratory"
      }]
    }
  ],
  "code": {
    "coding": [{
      "system": "http://snomed.info/sct",
      "code": "410005001",
      "display": "Domiciliary care, comprehensive history taking"
    }]
  },
  "subject": {
    "reference": "Patient/patient-001",
    "display": "张三"
  },
  "encounter": {
    "reference": "Encounter/encounter-2026-0708-001"
  },
  "effectiveDateTime": "2026-07-08T10:00:00+08:00",
  "issued": "2026-07-08T15:30:00+08:00",
  "performer": [{
    "reference": "Practitioner/practitioner-001",
    "display": "李医生"
  }],
  "result": [
    {"reference": "Observation/bp-001"},
    {"reference": "Observation/bmi-001"},
    {"reference": "Observation/blood-glucose-001"},
    {"reference": "Observation/cholesterol-001"}
  ],
  "conclusion": "血压偏高（145/90 mmHg），空腹血糖正常（5.2 mmol/L），建议低盐饮食，3个月后复查血压",
  "conclusionCode": [{
    "coding": [{
      "system": "http://hl7.org/fhir/sid/icd-10",
      "code": "I10",
      "display": "原发性高血压"
    }]
  }],
  "presentedForm": [{
    "contentType": "application/pdf",
    "url": "Binary/exam-report-pdf-001",
    "title": "体检报告 PDF"
  }],
  "extension": [
    {
      "url": "http://example.org/fhir/StructureDefinition/population-category",
      "valueCodeableConcept": {
        "coding": [{
          "system": "http://example.org/code-system/population",
          "code": "elderly",
          "display": "65岁以上老年人"
        }]
      }
    },
    {
      "url": "http://example.org/fhir/StructureDefinition/health-assessment",
      "valueString": "高血压高危人群"
    },
    {
      "url": "http://example.org/fhir/StructureDefinition/followup-suggestion",
      "valueString": "3个月后复查血压"
    }
  ]
}
```

**Extension 表达国标特有字段**：

| 国标字段 | FHIR Extension | 实现方式 |
|---|---|---|
| 人群分类 | population-category | CodeableConcept，用本地 CodeSystem |
| 健康评估 | health-assessment | string 或 CodeableConcept |
| 随访建议 | followup-suggestion | string |
| 异常项标识 | abnormal-flag | boolean |
| 公卫上报状态 | public-health-report-status | code（pending/success/failed） |
| 上报批次号 | report-batch-id | identifier |
| 体检车编号 | mobile-clinic-id | identifier |
| 体检地点 | exam-location | Address |

**Extension 定义示例（StructureDefinition）**：

```json
{
  "resourceType": "StructureDefinition",
  "id": "population-category",
  "url": "http://example.org/fhir/StructureDefinition/population-category",
  "name": "PopulationCategory",
  "status": "active",
  "kind": "complex-type",
  "context": [{
    "type": "element",
    "expression": "DiagnosticReport"
  }],
  "type": "Extension",
  "baseDefinition": "http://hl7.org/fhir/StructureDefinition/Extension",
  "derivation": "constraint",
  "snapshot": {
    "element": [{
      "path": "Extension",
      "short": "公卫人群分类",
      "type": [{"code": "Extension"}]
    }]
  }
}
```

#### 2. 体检系统 FHIR Server 接口设计

**关键 RESTful 接口**：

| 接口 | 方法 | URL | 用途 |
|---|---|---|---|
| 创建患者 | POST | /Patient | 创建体检患者 |
| 更新患者 | PUT | /Patient/{id} | 更新患者信息 |
| 读患者 | GET | /Patient/{id} | 读取患者 |
| 按身份证搜索 | GET | /Patient?identifier=http://example.org/cs/id-card\|110101199001011234 | 按身份证搜索 |
| 按姓名+生日搜索 | GET | /Patient?name=张三&birthdate=1990-01-01 | 模糊搜索 |
| 按患者拉取观察项 | GET | /Observation?patient={id}&category=vital-signs | 拉取生命体征 |
| 按就诊拉取报告 | GET | /DiagnosticReport?encounter={id} | 按就诊拉报告 |
| 批量上传观察项 | POST | /Observation/_search?_batch=true | 批量上传 |
| 订阅报告生成事件 | POST | /Subscription | 订阅 DiagnosticReport 创建事件 |
| 拉取患者全部数据 | GET | /Patient/{id}/$everything | 拉取所有相关资源 |
| 事务批量操作 | POST | / | Transaction Bundle |
| 历史版本 | GET | /Observation/{id}/_history | 资源历史版本 |

**搜索参数（Search Parameter）设计原则**：

| 原则 | 详解 |
|---|---|
| 用标准参数优先 | FHIR 标准已定义的 SearchParam（如 identifier、name、birthdate）优先用 |
| 自定义参数用 Extension | 如"按人群分类搜索"需定义自定义 SearchParam |
| 索引友好 | 搜索参数对应数据库索引，避免 LIKE 全表扫描 |
| 区分 common / specific | common（name、birthdate）所有患者都搜；specific（id-card）精确匹配 |
| 支持链式与反向链 | `Patient?organization.name=XX` 链式搜索 |
| 支持复合参数 | `Observation?patient={id}&date=gt2026-01-01&category=laboratory` |
| 分页必须 | `_count` + `_offset` 或 `_count` + `Bundle.link[next]` |

**按身份证搜索 Patient 示例**：

```
GET /Patient?identifier=http://example.org/cs/id-card|110101199001011234

响应（200 OK）:
{
  "resourceType": "Bundle",
  "type": "searchset",
  "total": 1,
  "entry": [{
    "fullUrl": "https://fhir.example.org/Patient/patient-001",
    "resource": {
      "resourceType": "Patient",
      "id": "patient-001",
      "identifier": [{
        "system": "http://example.org/cs/id-card",
        "value": "110101199001011234"
      }],
      "name": [{"family": "张", "given": ["三"]}],
      "gender": "male",
      "birthDate": "1990-01-01"
    }
  }]
}
```

**包含（Include）与反向链（Reverse Include）**：

**正向包含（Include）**：搜索 DiagnosticReport 时包含其引用的 Observation

```
GET /DiagnosticReport?patient={id}&_include=DiagnosticReport:result

响应包含：
- DiagnosticReport（主资源）
- Observation[]（被 result 引用的资源）
```

**反向包含（RevInclude）**：搜索 Patient 时反向包含所有 DiagnosticReport

```
GET /Patient?identifier=...&_revinclude=DiagnosticReport:subject

响应包含：
- Patient（主资源）
- DiagnosticReport[]（subject 指向该 Patient 的所有报告）
```

**体检场景应用**：

| 场景 | 用法 |
|---|---|
| 拉取体检报告 + 所有关联观察项 | `_include=DiagnosticReport:result` |
| 拉取患者 + 所有体检报告 | `_revinclude=DiagnosticReport:subject` |
| 拉取就诊 + 所有观察项 + 报告 | `_revinclude=Observation:encounter&_revinclude=DiagnosticReport:encounter` |
| 拉取主检医生 + 其主检的所有报告 | `_revinclude=DiagnosticReport:performer` |

**Subscription（订阅）**：

```json
POST /Subscription
{
  "resourceType": "Subscription",
  "status": "active",
  "reason": "订阅体检报告生成事件",
  "criteria": "DiagnosticReport?status=final",
  "channel": {
    "type": "rest-hook",
    "endpoint": "https://internet-hospital.example.org/fhir/notify",
    "payload": "application/fhir+json"
  }
}
```

- 当体检报告 status 变为 final 时，FHIR Server 推送到互联网医院的 endpoint
- 适合"报告生成后通知互联网医院"的场景

**Patient/$everything 操作**：

```
GET /Patient/{id}/$everything

响应：Bundle，包含：
- Patient
- 所有 Encounter
- 所有 Observation
- 所有 DiagnosticReport
- 所有 DocumentReference
- 所有 MedicationStatement
- ...
```

- 用于"拉取患者全量数据"（如转诊、跨机构调阅）
- 数据量大时支持分页（Bundle.link[next]）

#### 3. FHIR 接口与国标上报双轨实现

**双轨架构**：

```
                 体检系统内部领域模型
                       │
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
   领域事件        FHIR 适配层    国标适配层
   （事件总线）       │              │
        │              ▼              ▼
        ▼         FHIR Server    国标 XML 生成器
   事件订阅者            │              │
   ├─ 互联网医院     │              │
   ├─ 商业保险       ▼              ▼
   ├─ 内部统计    RESTful API    WebService 调用
   └─ 公卫上报                            │
        │                                 ▼
        ▼                            省级公卫系统
   公卫上报适配器
        │
        ▼
   国标 XML 生成器
        │
        ▼
   省级公卫系统
```

**关键设计**：

1. **领域模型与标准解耦**：内部用统一的 `ExamReport` 领域模型，不绑定 FHIR 或国标
2. **领域事件驱动**：体检报告发布时发出 `ExamReportPublishedEvent`，多个订阅者各自处理
3. **FHIR 适配器**：领域模型 → FHIR 资源（DiagnosticReport + Observation[]）
4. **国标适配器**：领域模型 → 国标 XML（按公卫规范格式）

**双轨代码示例**：

```java
// 领域事件
public class ExamReportPublishedEvent {
    private String reportId;
    private ExamReport report;
    private LocalDateTime publishTime;
}

// 事件发布
@Service
public class ExamReportService {
    @Autowired private ApplicationEventPublisher eventPublisher;
    
    public void publishReport(ExamReport report) {
        // 1. 落库（领域模型）
        examReportRepo.save(report);
        
        // 2. 发布事件
        eventPublisher.publishEvent(new ExamReportPublishedEvent(report.getId(), report, LocalDateTime.now()));
    }
}

// FHIR 适配器（订阅事件，写入 FHIR Server）
@Component
public class FhirSyncListener {
    @EventListener
    public void onReportPublished(ExamReportPublishedEvent event) {
        DiagnosticReport dr = fhirAdapter.toDiagnosticReport(event.getReport());
        List<Observation> obs = fhirAdapter.toObservations(event.getReport());
        
        // Transaction Bundle 一次性写入
        fhirClient.transaction()
            .create(dr)
            .create(obs.toArray(new Observation[0]))
            .execute();
    }
}

// 国标上报适配器（订阅事件，调用公卫 WebService）
@Component
public class PublicHealthReportListener {
    @EventListener
    @Async  // 异步，避免阻塞主流程
    public void onReportPublished(ExamReportPublishedEvent event) {
        String xml = nsAdapter.toPublicHealthXML(event.getReport());
        
        try {
            wsClient.upload(xml);
            // 上报成功，更新状态
            examReportRepo.updateReportStatus(event.getReportId(), "PH_REPORTED");
        } catch (Exception e) {
            // 上报失败，重试 + 告警
            examReportRepo.updateReportStatus(event.getReportId(), "PH_REPORT_FAILED");
            retryTemplate.execute(ctx -> {
                wsClient.upload(xml);
                return null;
            });
        }
    }
}
```

**数据一致性保证**：

| 一致性维度 | 实现方式 |
|---|---|
| 同一份报告同时写入 FHIR 和国标 | 领域事件驱动，两套适配器并行处理 |
| 写入失败补偿 | 各自重试 + 死信队列 + 人工介入 |
| 状态对账 | 定时任务对账（FHIR Server 资源 vs 国标上报记录） |
| 公卫上报状态反馈到 FHIR | Observation.status / DiagnosticReport.status 字段标记 |

**国标上报失败反馈到 FHIR**：

| 上报状态 | FHIR 资源状态 |
|---|---|
| 待上报 | DiagnosticReport.status = "preliminary"，Extension: public-health-report-status = "pending" |
| 上报成功 | DiagnosticReport.status = "final"，Extension: public-health-report-status = "success" |
| 上报失败 | DiagnosticReport.status = "final"，Extension: public-health-report-status = "failed" |
| 上报后修改 | DiagnosticReport.status = "amended"，生成新版本 |
| 上报后撤销 | DiagnosticReport.status = "entered-in-error"，标记为错误 |

**对账机制**：

```java
@Scheduled(cron = "0 0 2 * * ?")  // 每天凌晨 2 点对账
public void reconcileFhirAndPublicHealth() {
    List<ExamReport> reports = examReportRepo.findYesterdayReports();
    
    for (ExamReport report : reports) {
        // 检查 FHIR Server 中是否存在
        boolean existsInFhir = fhirClient.fetch(DiagnosticReport.class, report.getFhirId()) != null;
        
        // 检查国标上报状态
        String phStatus = report.getPublicHealthStatus();
        
        if (existsInFhir && "success".equals(phStatus)) {
            // 双轨一致
            continue;
        } else if (existsInFhir && "failed".equals(phStatus)) {
            // FHIR 有，国标失败：触发国标重报
            publicHealthReporter.retry(report);
        } else if (!existsInFhir && "success".equals(phStatus)) {
            // FHIR 无，国标有：触发 FHIR 同步
            fhirSyncListener.sync(report);
        } else {
            // 双失败：告警
            alertService.alert("Both FHIR and PH failed: " + report.getId());
        }
    }
}
```

#### 4. FHIR 版本控制与并发

**ETag + If-Match 乐观锁**：

```
# 客户端首次读取 Observation
GET /Observation/obs-001
响应：
  ETag: W/"1"
  Body: {"resourceType": "Observation", "id": "obs-001", ...}

# 客户端修改后更新
PUT /Observation/obs-001
Headers:
  If-Match: W/"1"   # 必须带上当前的 ETag
Body: {"resourceType": "Observation", "id": "obs-001", "valueQuantity": {"value": 145}, ...}

# 服务端校验
# 当前 ETag 是 W/"2"（已被其他端修改）→ 412 Precondition Failed
# 当前 ETag 是 W/"1" → 更新成功，新 ETag 是 W/"2"
```

**多端修改场景**：

```
T0: Observation 初始 value=120, ETag=W/"1"
T1: 医生 A 读取，得到 ETag=W/"1"
T2: 设备自动上传更新 value=125, ETag=W/"2"
T3: 医生 A 提交修改 value=145, If-Match: W/"1"
T4: 服务端校验：当前 ETag=W/"2" ≠ If-Match=W/"1"
    → 412 Precondition Failed
    → 医生 A 需重新读取最新版本（ETag=W/"2"）再修改
```

**Java 代码示例（HAPI FHIR）**：

```java
// 读取 Observation
IObservation observation = fhirClient.read().resource(Observation.class).withId("obs-001").execute();
String currentETag = observation.getMeta().getVersionId();  // "1"

// 修改并更新（带 If-Match）
observation.setValueQuantity(new Quantity(145, "mmHg", "http://unitsofmeasure.org", "mm[Hg]", "mmHg"));
try {
    MethodOutcome outcome = fhirClient.update()
        .resource(observation)
        .withId("obs-001")
        .conditionalBy("Observation?_id=obs-001&_version=" + currentETag)  // If-Match
        .execute();
} catch (PreconditionFailedException e) {
    // 412 错误：版本冲突，需重新读取
    handleConflict("obs-001");
}
```

**历史版本查询**：

```
# 查询某资源的所有历史版本
GET /Observation/obs-001/_history

响应：
{
  "resourceType": "Bundle",
  "type": "history",
  "total": 3,
  "entry": [
    {
      "fullUrl": "/Observation/obs-001/_history/3",
      "resource": {...version 3...},
      "request": {"method": "PUT"}
    },
    {
      "fullUrl": "/Observation/obs-001/_history/2",
      "resource": {...version 2...},
      "request": {"method": "PUT"}
    },
    {
      "fullUrl": "/Observation/obs-001/_history/1",
      "resource": {...version 1...},
      "request": {"method": "POST"}
    }
  ]
}

# 查询特定版本
GET /Observation/obs-001/_history/2
```

**版本冲突解决策略**：

| 策略 | 适用场景 | 实现 |
|---|---|---|
| 最后写入胜出（Last Write Wins） | 简单场景，冲突少 | 不带 If-Match，直接覆盖 |
| 客户端重试（Client Retry） | 冲突偶发 | 412 后客户端重新读取、合并、再提交 |
| 服务端合并（Server Merge） | 字段级冲突 | 服务端识别冲突字段，合并非冲突部分 |
| 业务规则仲裁 | 业务有优先级 | 如"医生修改优先于设备自动上传" |
| 人工介入 | 关键数据冲突 | 标记冲突，进人工审核队列 |

**体检场景的冲突解决**：

| 冲突场景 | 解决策略 |
|---|---|
| 医生修改血压值 + 设备同时上传新值 | 业务规则：设备值优先（原始数据），医生修改作为补充 Observation |
| 主检医生修改结论 + 审核医生同时审核 | 业务规则：审核医生优先，主检医生修改需重新审核 |
| 多端修改患者基本信息 | 客户端重试 + 人工核对（基本信息冲突不能自动合并） |
| 体检报告归档后修改 | 不允许覆盖，生成 amended 版本，原版本保留 |

**Transaction Bundle（事务）**：

```json
POST /
{
  "resourceType": "Bundle",
  "type": "transaction",
  "entry": [
    {
      "request": {"method": "POST", "url": "Observation"},
      "resource": {"resourceType": "Observation", "id": "bp-001", ...}
    },
    {
      "request": {"method": "POST", "url": "Observation"},
      "resource": {"resourceType": "Observation", "id": "bmi-001", ...}
    },
    {
      "request": {"method": "POST", "url": "Observation"},
      "resource": {"resourceType": "Observation", "id": "glucose-001", ...}
    },
    {
      "request": {"method": "POST", "url": "DiagnosticReport"},
      "resource": {
        "resourceType": "DiagnosticReport",
        "result": [
          {"reference": "Observation/bp-001"},
          {"reference": "Observation/bmi-001"},
          {"reference": "Observation/glucose-001"}
        ]
      }
    }
  ]
}
```

- 事务特性：全部成功或全部失败（原子性）
- 适合"体检批量上传"（一份报告 + N 个观察项一次性写入）
- 性能优势：减少 HTTP 请求次数

**Batch vs Transaction**：

| 类型 | 原子性 | 适用场景 |
|---|---|---|
| transaction | 全成功或全失败 | 关联性强的写入（如报告 + 观察项） |
| batch | 各自独立，部分失败不影响其他 | 批量删除/批量查询（容忍部分失败） |

**体检批量上传示例（一次体检包含 20 项观察项 + 1 份报告）**：

- 不用 Bundle：22 次 HTTP 请求（20 POST Observation + 1 POST DiagnosticReport + 1 修补 result 引用）
- 用 Transaction Bundle：1 次 HTTP 请求，原子性保证

---

## 题目三（选型权衡题）：Mirth Connect 集成引擎实战 + 体检系统对外 FHIR 接口落地

请回答：

1. Mirth Connect 的核心架构（Channel / Source / Transformer / Destination / Filter / Router）、消息流转模型、与 RabbitMQ/Kafka 等通用 MQ 的差异？什么场景必须用 Mirth（HL7 v2 消息解析、ASTM 设备协议、CDA 生成）？什么场景用通用 MQ 即可？
2. 用 Mirth Connect 实现"HL7 v2 ORU^R01（HIS 推送检验结果）→ FHIR Observation"的转换通道：Source（MLLP 监听）、Transformer（HL7 v2 解析 → FHIR 映射）、Destination（HTTP POST FHIR Server）。关键转换逻辑（PID → Patient、OBX → Observation、OBR → DiagnosticReport）如何写？消息堆积、消息重复、消息顺序如何处理？
3. 体检系统对外提供 FHIR 接口的部署架构：FHIR Server（HAPI FHIR）选型与部署、数据库选型（PostgreSQL/Oracle）、性能优化（索引、缓存、分页）、安全（OAuth2 / SMART on FHIR）、监控（响应时延、错误率、资源数量）。多机构 SaaS 下，FHIR Server 是单租户部署还是多租户部署？如何做租户隔离？
4. 体检系统与互联网医院的 FHIR 对接实战：互联网医院调阅体检报告（DocumentReference + Binary）、患者基本信息查询（Patient）、检查检验结果查询（Observation）、体检预约（Appointment + ServiceRequest）。如何设计 OAuth2 授权流程（患者授权、医生授权、机构授权）？SMART on FHIR 的应用场景？大型互联网医院日调用量百万级，FHIR Server 如何扛住？

### 作答区

#### 1. Mirth Connect 核心架构

**Mirth Connect 简介**：

- 开源医疗集成引擎（NextGen Healthcare 收购后开源），医疗信息化领域事实标准
- 国内三甲医院集成平台多基于 Mirth（或商业版 Rhapsody、Corepoint）
- 用途：异构系统消息转换与路由（HL7 v2 / FHIR / ASTM / DICOM / 数据库 / WebService / FTP / SMTP）

**核心架构**：

```
┌────────────────────────────────────────────────────────┐
│  Mirth Connect Server                                   │
│                                                         │
│  ┌────────────────────────────────────────────────┐    │
│  │  Channel（通道）                                │    │
│  │                                                  │    │
│  │  ┌──────────┐   ┌──────────┐   ┌──────────┐   │    │
│  │  │ Source   │──>│ Transformer │──>│ Router   │   │    │
│  │  │ (源)     │   │ (转换器)    │   │ (路由器) │   │    │
│  │  └──────────┘   └──────────┘   └────┬─────┘   │    │
│  │                                       │        │    │
│  │                  ┌────────────────────┼────┐  │    │
│  │                  ▼                    ▼    │  │    │
│  │            ┌──────────┐         ┌──────────┐│  │    │
│  │            │ Filter 1 │         │ Filter 2 ││  │    │
│  │            └────┬─────┘         └────┬─────┘│  │    │
│  │                 ▼                    ▼      │  │    │
│  │            ┌──────────┐         ┌──────────┐│  │    │
│  │            │ Dest 1   │         │ Dest 2   ││  │    │
│  │            │ (目的地1)│         │ (目的地2)││  │    │
│  │            └──────────┘         └──────────┘│  │    │
│  └────────────────────────────────────────────────┘    │
│                                                         │
│  ┌────────────────────────────────────────────────┐    │
│  │  Channel 队列与消息库（PostgreSQL/MySQL/Oracle）│    │
│  └────────────────────────────────────────────────┘    │
└────────────────────────────────────────────────────────┘
```

**核心组件**：

| 组件 | 作用 | 示例 |
|---|---|---|
| Channel | 一个完整的消息流通道 | "HL7 v2 ORU -> FHIR Obs" 通道 |
| Source | 消息来源（监听器） | MLLP TCP 监听 / HTTP 监听 / 文件读取 / 数据库轮询 / FTP |
| Transformer | 消息转换（JavaScript 步骤） | HL7 v2 解析、字段映射、FHIR 资源生成 |
| Filter | 消息过滤 | 只处理 ORU^R01 类型，过滤 ACK |
| Router | 消息路由 | 按消息类型路由到不同 Destination |
| Destination | 消息目的地 | HTTP POST / MLLP 发送 / 数据库写入 / 文件写入 |

**消息流转模型**：

1. Source 接收原始消息（如 HL7 v2 字符串）
2. Transformer 解析并转换为目标格式（如 FHIR JSON）
3. Filter 决定是否继续处理
4. Router 根据消息内容路由到 0..N 个 Destination
5. Destination 发送转换后的消息
6. 全程消息落库（消息库），支持重放、审计、监控

**与 RabbitMQ/Kafka 的差异**：

| 维度 | Mirth Connect | RabbitMQ / Kafka |
|---|---|---|
| 定位 | 医疗集成引擎 | 通用消息中间件 |
| 消息模型 | 端到端转换 + 路由 | 发布订阅 / 队列 |
| 协议支持 | HL7 v2 / ASTM / DICOM / CDA / FHIR | AMQP / Kafka 协议 |
| 转换能力 | 内置（JavaScript Transformer） | 无（需应用层转换） |
| 医疗标准 | 原生支持 | 无 |
| 部署 | 单机/集群 | 集群 |
| 消息持久化 | 数据库（默认） | 文件/Kafka 日志 |
| 适用场景 | 医疗异构系统集成 | 通用异步消息 |

**必须用 Mirth 的场景**：

| 场景 | 原因 |
|---|---|
| HIS 推送 HL7 v2 ORU 检验结果 | Mirth 原生支持 MLLP + HL7 v2 解析 |
| LIS 推送 ASTM 检验结果 | Mirth 内置 ASTM 协议支持 |
| PACS 推送 DICOM 影像元数据 | Mirth 支持 DICOM 解析 |
| CDA 文档生成与交换 | Mirth 内置 CDA 模板支持 |
| 跨系统集成（多厂家 HIS/EMR/LIS/PACS） | Mirth 是"集成平台"的标准角色 |

**通用 MQ 即可的场景**：

| 场景 | 原因 |
|---|---|
| 体检系统内部异步任务（报告生成、推送通知） | RabbitMQ 足够，无需 Mirth |
| 体检系统与互联网医院的 FHIR 互操作 | FHIR 是 RESTful，用 HTTP 即可，Mirth 不必要 |
| 公卫上报的异步队列 | 通用 MQ + 自定义适配器即可 |
| 大数据分析的消息流 | Kafka 适合，Mirth 不擅长大数据流 |

#### 2. Mirth 实现 HL7 v2 → FHIR 转换通道

**通道设计**：

```
HIS ──MLLP/TCP──> [Mirth Channel: HIS_ORU_TO_FHIR]
                          │
                          ▼
                   ┌──────────────┐
                   │ Source:      │
                   │ MLLP Listener│
                   │ Port: 2575   │
                   └──────┬───────┘
                          │
                          ▼
                   ┌──────────────┐
                   │ Transformer: │
                   │ 1. 解析 HL7  │
                   │ 2. 提取 PID  │
                   │ 3. 提取 OBR  │
                   │ 4. 提取 OBX  │
                   │ 5. 构造 FHIR │
                   │    Bundle    │
                   └──────┬───────┘
                          │
                          ▼
                   ┌──────────────┐
                   │ Filter:      │
                   │ MSH-9=ORU^R01│
                   └──────┬───────┘
                          │
                          ▼
                   ┌──────────────┐
                   │ Destination: │
                   │ HTTP POST    │
                   │ /fhir        │
                   └──────────────┘
```

**Transformer 关键代码（Mirth JavaScript）**：

```javascript
// 1. 解析 HL7 v2 消息
var hl7Msg = sourceMap.get('rawData');
var parser = new Packages.ca.uhn.hl7v2.parser.PipeParser();
var message = parser.parse(hl7Msg);

// 2. 提取 PID 段（患者信息）
var pid = message.get("PID");
var patientId = pid.getPid3().encode();  // 患者ID
var patientName = pid.getPid5().encode();  // 姓名
var birthDate = pid.getPid7().encode();  // 生日
var gender = pid.getPid8().encode();  // 性别

// 3. 提取 OBR 段（检查申请）
var obr = message.get("OBR");
var orderCode = obr.getObr4().encode();  // 检查代码
var orderName = obr.getObr44().encode();  // 检查名称
var observationTime = obr.getObr7().encode();  // 观察时间

// 4. 构造 DiagnosticReport 资源
var diagnosticReport = {
  "resourceType": "DiagnosticReport",
  "status": "final",
  "code": {
    "coding": [{
      "system": "http://loinc.org",
      "code": orderCode,
      "display": orderName
    }]
  },
  "subject": {
    "reference": "Patient?identifier=" + patientId
  },
  "effectiveDateTime": observationTime,
  "result": []
};

// 5. 遍历 OBX 段（观察项），构造 Observation 资源
var observations = message.getAll("OBX");
var observationRefs = [];
for (var i = 0; i < observations.length; i++) {
  var obx = observations[i];
  var obsCode = obx.getObx3().encode();
  var obsValue = obx.getObx5().encode();
  var obsUnit = obx.getObx6().encode();
  
  var observation = {
    "resourceType": "Observation",
    "status": "final",
    "code": {
      "coding": [{"system": "http://loinc.org", "code": obsCode}]
    },
    "subject": {"reference": "Patient?identifier=" + patientId},
    "valueQuantity": {
      "value": parseFloat(obsValue),
      "unit": obsUnit
    },
    "effectiveDateTime": observationTime
  };
  
  observationRefs.push({"reference": "Observation/" + i});
}

diagnosticReport.result = observationRefs;

// 6. 构造 Transaction Bundle
var bundle = {
  "resourceType": "Bundle",
  "type": "transaction",
  "entry": []
};

// 添加 DiagnosticReport
bundle.entry.push({
  "request": {"method": "POST", "url": "DiagnosticReport"},
  "resource": diagnosticReport
});

// 添加 Observation
for (var j = 0; j < observations.length; j++) {
  bundle.entry.push({
    "request": {"method": "POST", "url": "Observation"},
    "resource": observationArray[j]
  });
}

// 7. 输出到 Destination
channelMap.put('fhirBundle', JSON.stringify(bundle));
```

**关键字段映射**：

| HL7 v2 字段 | FHIR 资源字段 |
|---|---|
| MSH-9（消息类型） | 用于路由（不映射到 FHIR） |
| PID-3（患者ID） | Patient.identifier |
| PID-5（姓名） | Patient.name |
| PID-7（生日） | Patient.birthDate |
| PID-8（性别） | Patient.gender |
| OBR-4（检查代码） | DiagnosticReport.code |
| OBR-7（观察时间） | DiagnosticReport.effectiveDateTime |
| OBX-3（观察项代码） | Observation.code |
| OBX-5（观察值） | Observation.valueQuantity.value |
| OBX-6（单位） | Observation.valueQuantity.unit |

**消息堆积处理**：

| 策略 | 实现 |
|---|---|
| 异步处理 | Source 接收后立即 ACK，消息入队，Transformer 异步处理 |
| 多线程消费 | Channel 配置 worker 线程数（如 10），并行处理 |
| 持久化队列 | 消息落库（Mirth 默认 PostgreSQL），宕机不丢消息 |
| 死信队列 | 处理失败的消息进入 Error 队列，人工干预 |
| 限流 | Transformer 处理速率限制，避免下游 FHIR Server 被压垮 |
| 监控告警 | 队列深度 > 阈值时告警（如 > 1000 条） |

**消息重复处理**：

| 策略 | 实现 |
|---|---|
| 消息 ID 去重 | Mirth 为每条消息分配 messageId，下游 FHIR 用 If-None-Match 去重 |
| 幂等写入 | FHIR 用 conditional update（`PUT /Observation?identifier=msg-001`） |
| 业务幂等 | DiagnosticReport.identifier 用 HL7 消息 ID，重复消息直接覆盖 |

**消息顺序处理**：

| 策略 | 实现 |
|---|---|
| 同患者顺序 | 按 Patient ID 哈希分队列，同患者消息串行 |
| 跨患者并行 | 不同患者消息可并行，提高吞吐 |
| 时序保证 | OBX 内部时序由 OBR-7 观察；跨消息时序由 Mirth 接收顺序保证 |

#### 3. 体检系统 FHIR 接口部署架构

**部署架构**：

```
                 ┌─────────────────────────────┐
                 │   互联网医院 / 商业保险 /    │
                 │   区域平台 / 患者小程序      │
                 └──────────────┬──────────────┘
                                │ HTTPS + OAuth2
                                ▼
                 ┌─────────────────────────────┐
                 │   API Gateway (Kong/Nginx)  │
                 │   ├─ TLS 终止                │
                 │   ├─ 限流                    │
                 │   ├─ 鉴权                    │
                 │   └─ 路由                    │
                 └──────────────┬──────────────┘
                                │
                                ▼
                 ┌─────────────────────────────┐
                 │   FHIR Server (HAPI FHIR)   │
                 │   ├─ RESTful 接口             │
                 │   ├─ 资源校验                 │
                 │   ├─ Search Parameter         │
                 │   ├─ Subscription             │
                 │   └─ Transaction              │
                 └──────────────┬──────────────┘
                                │
                                ▼
                 ┌─────────────────────────────┐
                 │   PostgreSQL 集群            │
                 │   ├─ Master（读写）           │
                 │   ├─ Slave x 2（只读）        │
                 │   └─ 资源 JSONB + 索引        │
                 └─────────────────────────────┘
                                │
                                ▼
                 ┌─────────────────────────────┐
                 │   Redis（缓存 + 限流）       │
                 └─────────────────────────────┘
                                │
                                ▼
                 ┌─────────────────────────────┐
                 │   监控（Prometheus+Grafana） │
                 │   日志（ELK）                │
                 └─────────────────────────────┘
```

**HAPI FHIR 选型理由**：

| 维度 | HAPI FHIR | IBM FHIR | 自研 |
|---|---|---|---|
| 完整度 | R4/R5 全资源支持 | R4 | 自定义 |
| 开源协议 | Apache 2.0 | Apache 2.0 | - |
| Java 生态 | 与 Spring Boot 兼容 | Java | - |
| 性能 | 中等（可优化） | 高 | - |
| 社区活跃 | 活跃 | 一般 | - |
| 学习曲线 | 中等 | 陡 | - |
| 适用场景 | 大多数医疗信息化 | 大型企业 | 特殊需求 |

**数据库选型**：

| 数据库 | 优势 | 劣势 | 适用场景 |
|---|---|---|---|
| PostgreSQL | JSONB 支持、GIN 索引、稳定 | 国产生态弱 | 主流选择 |
| Oracle | 性能、稳定 | 成本高、信创替代 | 大型三甲 |
| MySQL | 简单 | JSON 支持弱 | 小规模 |
| 达梦 | 信创 | JSONB 支持差 | 信创要求场景 |
| MongoDB | 文档模型契合 | 事务弱 | 不推荐 |

**PostgreSQL 表结构（HAPI FHIR 默认）**：

```sql
-- 资源主表（每条资源一行）
CREATE TABLE hfj_resource (
    res_id BIGINT PRIMARY KEY,
    res_type VARCHAR(30) NOT NULL,
    res_published_at TIMESTAMP,
    res_updated_at TIMESTAMP,
    res_version VARCHAR(20),
    res_encoding VARCHAR(10),
    res_text CLOB
);

-- 资源历史表（每个版本一行）
CREATE TABLE hfj_res_ver (
    res_ver_id BIGINT PRIMARY KEY,
    res_id BIGINT NOT NULL,
    res_version VARCHAR(20),
    res_updated_at TIMESTAMP,
    res_text CLOB
);

-- 索引表（搜索参数索引）
CREATE TABLE hfj_spidx_string (
    sp_idx_string_id BIGINT PRIMARY KEY,
    res_id BIGINT NOT NULL,
    sp_name VARCHAR(100),
    sp_value_string VARCHAR(200)
);
CREATE INDEX idx_spidx_string_res ON hfj_spidx_string(res_id);
CREATE INDEX idx_spidx_string_value ON hfj_spidx_string(sp_name, sp_value_string);
```

**性能优化**：

| 优化点 | 实现 |
|---|---|
| 索引优化 | Search Parameter 索引（identifier、name、birthdate 等） |
| 缓存 | Redis 缓存热点资源（如 Patient 基本信息） |
| 分页 | 强制分页（`_count=50` 最大），避免全表扫描 |
| 读写分离 | FHIR Server 读走 Slave，写走 Master |
| 异步索引 | 资源写入后异步更新搜索索引 |
| 批量接口 | Bundle/Transaction 减少请求次数 |
| 资源压缩 | 大资源（如 Binary）用 GZIP |
| 字段裁剪 | `_elements=Patient.name,birthDate` 仅返回指定字段 |

**安全（OAuth2 + SMART on FHIR）**：

**OAuth2 授权流程**：

```
1. 患者小程序 → 互联网医院
2. 互联网医院 → 授权服务器（OAuth2）
3. 授权服务器 → 患者授权页（同意分享体检数据）
4. 患者同意 → 授权服务器返回 access_token
5. 互联网医院 → FHIR Server（携带 access_token）
6. FHIR Server → 校验 token → 返回资源
```

**SMART on FHIR**：

- 基于 OAuth2 的医疗扩展规范
- 定义了"scope"（如 `patient/Observation.read`、`patient/DiagnosticReport.read`）
- 定义了"launch"上下文（如 `launch/patient` 指定患者 ID）
- 国内落地少，但趋势

**Scope 设计**：

```json
{
  "scope": "patient/Observation.read patient/DiagnosticReport.read patient/Patient.read",
  "patient": "patient-001"
}
```

- `patient/` 前缀：仅访问当前患者的资源
- `user/` 前缀：访问当前用户的资源（如医生查看所有患者）
- `system/` 前缀：系统级访问（如公卫上报）

**多机构 SaaS 下的 FHIR Server 部署**：

| 方案 | 优势 | 劣势 | 适用场景 |
|---|---|---|---|
| 单租户部署（每机构一套） | 数据隔离强、定制灵活 | 资源浪费、运维成本高 | 大客户（三甲医院） |
| 多租户共享部署 | 成本低、运维简单 | 数据隔离需设计、定制受限 | 中小机构（乡镇） |
| 混合部署（大客户私有，小客户共享） | 兼顾隔离与成本 | 架构复杂 | 啄木鸟云健康场景 |

**租户隔离方案**：

| 隔离级别 | 实现 |
|---|---|
| 数据库级隔离 | 每租户一个 schema/database（强隔离） |
| 表级隔离（tenant_id 字段） | 所有资源加 tenant_id，查询 WHERE tenant_id = ?（中等隔离） |
| Schema 级隔离（FHIR Extension） | 用 Extension 标记租户，搜索参数过滤 |

**HAPI FHIR 多租户实现**：

```java
// 自定义 TenantInterceptor，从请求头解析 tenant_id
public class TenantInterceptor {
    @Read
    public void interceptRead(RequestDetails requestDetails) {
        String tenantId = requestDetails.getHeader("X-Tenant-Id");
        if (tenantId == null) {
            throw new UnauthorizedException("Missing tenant");
        }
        // 在查询 SQL 中注入 tenant_id 条件
        requestDetails.setTenantId(tenantId);
    }
}
```

#### 4. 体检系统与互联网医院 FHIR 对接实战

**对接场景与接口**：

| 场景 | FHIR 接口 | 调用方 |
|---|---|---|
| 调阅体检报告 | GET /DocumentReference?patient={id} | 互联网医院 → 体检系统 |
| 调阅体检报告 PDF | GET /Binary/{id} | 互联网医院 → 体检系统 |
| 查询患者基本信息 | GET /Patient?identifier=... | 互联网医院 → 体检系统 |
| 查询检查检验结果 | GET /Observation?patient={id}&category=laboratory | 互联网医院 → 体检系统 |
| 体检预约 | POST /Appointment + POST /ServiceRequest | 互联网医院 → 体检系统 |
| 体检报告生成通知 | Subscription（rest-hook） | 体检系统 → 互联网医院 |

**OAuth2 授权流程（三种授权）**：

**① 患者授权（小程序调阅自己的体检报告）**：

```
1. 患者小程序 → 互联网医院
2. 互联网医院 → 授权服务器（患者授权页）
3. 患者扫码确认
4. 授权服务器返回 access_token（scope: patient/.*.read）
5. 互联网医院 → 体检系统 FHIR Server（携带 token）
6. 体检系统校验 token，仅返回该患者的资源
```

**② 医生授权（互联网医院医生调阅患者体检报告）**：

```
1. 医生 → 互联网医院
2. 互联网医院 → 授权服务器（医生登录 + 患者授权）
3. 医生选择患者 → 授权服务器校验医患关系
4. 授权服务器返回 access_token（scope: user/.*.read，patient={id}）
5. 互联网医院 → 体检系统 FHIR Server（携带 token）
6. 体检系统校验 token，仅返回指定患者的资源
```

**③ 机构授权（互联网医院批量调阅，如对账）**：

```
1. 互联网医院 → 体检系统（机构级 client_credentials）
2. 授权服务器返回 access_token（scope: system/.*.read）
3. 互联网医院 → 体检系统 FHIR Server（携带 token）
4. 体检系统校验 token，返回全量数据（按合同范围）
```

**SMART on FHIR 应用**：

```
1. 患者小程序启动时，向 FHIR Server 的 /.well-known/smart-configuration 发起请求
2. FHIR Server 返回 SMART 配置（authorize_endpoint、token_endpoint、scopes_supported）
3. 小程序跳转到 authorize_endpoint，患者授权
4. 授权后回调小程序，携带 code
5. 小程序用 code 换 access_token
6. 小程序用 access_token 调用 FHIR API
```

**SMART on FHIR 优势**：

| 优势 | 详解 |
|---|---|
| 标准化 | 国际通用，避免每家互联网医院都自定义授权流程 |
| 互操作 | 体检系统可对接任意支持 SMART 的应用（如第三方健康 App） |
| 安全 | 基于 OAuth2 + OpenID Connect，安全成熟 |
| 患者授权留痕 | 患者授权记录可审计 |

**百万级日调用量的 FHIR Server 扛住策略**：

| 优化点 | 实现 | 效果 |
|---|---|---|
| 横向扩展 | FHIR Server 无状态，多实例 + 负载均衡 | 线性扩容 |
| 读写分离 | 读走 PG Slave，写走 Master | 读 QPS 翻倍 |
| 缓存 | Redis 缓存热点资源（如 Patient）+ 搜索结果 | 命中率 70%+ |
| 批量接口 | 鼓励用 Bundle 批量查询，减少请求次数 | 单次请求效率高 |
| 异步索引 | 写入后异步更新搜索索引 | 写入快 |
| 限流 | API Gateway 限流（如 100 QPS/租户） | 防止单租户压垮 |
| CDN | 静态资源（如 PDF 报告）走 CDN | 减少 Server 压力 |
| 字段裁剪 | 强制 `_elements`，减少传输量 | 网络带宽节省 |
| 分页强制 | `_count=50` 最大，避免拉全表 | 内存可控 |

**容量估算（日调用 100 万次）**：

```
日调用量：100 万次
峰值 QPS（8 小时分布）：约 100 QPS
平均 QPS：约 35 QPS
单实例 QPS：约 50（HAPI FHIR 优化后）
所需实例数：2-3 个 FHIR Server 实例
数据库：PostgreSQL Master + 2 Slave
缓存：Redis 集群（3 主 3 从）
带宽：约 50 Mbps
```

**监控指标**：

| 指标 | 阈值 | 告警 |
|---|---|---|
| 响应时延 P99 | &lt; 500ms | > 1s 告警 |
| 错误率 | &lt; 0.1% | > 1% 告警 |
| QPS | 监控 | 突增/突降告警 |
| 资源数量 | 监控 | 异常增长告警 |
| 队列深度（Mirth） | &lt; 100 | > 1000 告警 |
| 数据库连接数 | &lt; 80% | > 90% 告警 |
| Redis 命中率 | > 70% | &lt; 50% 告警 |

**实战案例（啄木鸟云健康场景）**：

- 短期（6 个月）：对接 1-2 家互联网医院，日调用 1-5 万次，单实例 FHIR Server 足够
- 中期（1-2 年）：对接 5-10 家互联网医院 + 商业保险，日调用 10-50 万次，2-3 实例
- 长期（3 年）：对接区域平台 + 多家互联网医院，日调用 100 万+，需集群化部署

---

## 与架构师水平的差距自评

> **知识点掌握**：HL7 v2/v3/CDA/FHIR 四代标准的演进逻辑、消息结构、优缺点能讲清；国内标准生态（国标/行标/国际标准）的层级关系清楚；FHIR 资源模型（Patient/Encounter/Observation/DiagnosticReport）能建模体检业务；但 FHIR 的 Search Parameter、Include/RevInclude、Subscription、SMART on FHIR 的实战经验不足。
>
> **架构思维**：多协议适配（HL7 v2 + FHIR + 国标 XML）的双轨架构思路清晰；FHIR Server 部署架构（API Gateway + FHIR Server + PostgreSQL + Redis）能设计；但多租户隔离（tenant_id vs schema vs database）的工程实战、SMART on FHIR 的授权流程落地、百万级 QPS 的性能优化经验不足。
>
> **工程细节**：FHIR 资源建模（DiagnosticReport + Observation + Extension）能写出代码示例；Mirth Connect 的 Channel 设计与 Transformer JavaScript 能写；但 HAPI FHIR Server 的部署调优（数据库索引、Search Parameter 优化、Subscription 推送可靠性）、Mirth 集群部署与高可用、FHIR Server 的监控告警需要补足。
>
> **业务理解**：公卫体检上报用国标 XML 的现实原因清楚；FHIR 在国内落地的挑战（国标 vs FHIR 模型差异、编码体系映射、省级平台支持）能分析；但国内 FHIR 落地案例（阿里健康、东软、微脉）的深度调研不足，"国标上报 + FHIR 对外"双轨落地的实战经验需要积累。
>
> **合规意识**：SMART on FHIR 的患者授权机制能讲清框架；但 SMART on FHIR 在国内的合规性（与个保法、数据安全法的对齐）、医疗数据出境（FHIR 跨境共享）的合规边界需要补足。
>
> **补足方向**：
> 1. 深读 FHIR 官方文档（hl7.org/fhir），重点学习 Resource Model、Search Parameter、Include/RevInclude、Subscription、Transaction
> 2. 部署 HAPI FHIR Server，实践体检业务的 FHIR 资源建模（Patient/Encounter/Observation/DiagnosticReport）
> 3. 学习 FHIR IG（Implementation Guide）的编写，定义体检业务 Profile 与 Extension
> 4. 实践 Mirth Connect，写一个 HL7 v2 ORU^R01 → FHIR Observation 转换通道
> 5. 学习 SMART on FHIR 规范，实践 OAuth2 授权流程（患者授权、医生授权、机构授权）
> 6. 调研国内 FHIR 落地案例（阿里健康 FHIR、东软 FHIR、微脉、平安好医生）
> 7. 学习 FHIR 与国标的映射（CDA-on-FHIR、LOINC 与国标检验代码映射）
> 8. 学习 HAPI FHIR 性能优化（PostgreSQL JSONB 索引、Search Parameter 调优、缓存策略）
> 9. 复盘啄木鸟云健康公卫上报现状，规划"FHIR 对外接口"的切入路径（患者端 → 互联网医院 → 商业保险 → 区域平台）
> 10. 准备面试讲清楚"FHIR 资源建模体检业务 + Mirth 集成引擎实战 + 多协议双轨架构"三大能力点