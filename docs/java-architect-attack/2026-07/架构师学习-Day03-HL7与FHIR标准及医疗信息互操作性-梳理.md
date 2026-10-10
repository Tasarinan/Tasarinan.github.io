# 架构师学习 Day03 梳理：HL7 与 FHIR 标准及医疗信息互操作性
> 架构师视角的提炼版｜适合复习与面试速记
>
> 周主题：医疗信息化专题

---

## 一、HL7 四代标准：医疗信息化的"通信语言"

### 1.1 核心一句话
> **HL7 v2 是国内医院集成的事实标准（竖线分隔 + MLLP），HL7 v3 因 RIM 太重几乎未落地，CDA 是文档归档标准（基于 v3），FHIR 是下一代主流（RESTful + JSON + 资源模型）**
>
> 架构师必须能讲清四代标准的演进逻辑：v2 简单但无统一模型 -> v3 模型完整但太重 -> CDA 只取文档部分简化 -> FHIR 用 RESTful 重新设计。国内现状是 v2 + CDA 并存，FHIR 在互联网医院与商业保险场景切入。

### 1.2 四代标准对比

| 维度 | HL7 v2 | HL7 v3 | CDA | FHIR |
| --- | --- | --- | --- | --- |
| 诞生 | 1989 | 2005 | 2000 | 2011 |
| 数据模型 | 消息模型 | RIM | Header+Body | 资源模型 |
| 语法 | 竖线分隔（\|） | XML | XML | JSON / XML |
| 协议 | MLLP/TCP | SOAP | 文档交换 | RESTful/HTTP |
| 国内现状 | **医院事实标准** | 几乎未落地 | 共享文档规范 | 起步阶段 |
| 适合场景 | 实时消息推送 | 少用 | 文档归档 | RESTful API |
| 实施成本 | 低 | 高 | 中 | 低 |

### 1.3 HL7 v2 消息结构（必背）

```
MSH|^~\&|HIS|HOSP_A|EMR|HOSP_A|20260708120000||ADT^A04|MSG00001|P|2.4
EVN|A04|20260708120000
PID|1||PAT000123^^^HOSP_A||张^三||19650101|M|||北京市朝阳区^XX路1号^^100000
PV1|1|O|OUTPATIENT^^^DEPT0001
```

- **MSH**：消息头（发送方/接收方/消息类型/版本）
- **EVN**：事件类型（A04 = 注册）
- **PID**：患者信息
- **PV1**：就诊信息
- **分隔符**：`|` 字段、`^` 组件、`~` 重复、`\` 转义、`&` 子组件
- **Z 段**：厂家自定义段，灵活但破坏互操作

### 1.4 为什么 v2 至今是事实标准

| 原因 | 详解 |
| --- | --- |
| 历史包袱 | 90 年代起医院 HIS 用 v2.3/v2.4，替换成本极高 |
| 实时消息优势 | MLLP/TCP 长连接推送是 v2 强项，FHIR 实时推送需 WebSocket |
| 简单粗暴 | 一行 `MSH|...` 比 XML/JSON 短得多 |
| 厂家定制 | Z 段允许厂家自定义 |
| 集成引擎生态 | Mirth/Rhapsody 对 v2 支持最完整 |
| 国内标准滞后 | 国标走 CDA 路线，未推动 v2 升级 FHIR |

### 1.5 FHIR 成为下一代主流的原因

| 优势 | 详解 |
| --- | --- |
| RESTful + JSON | 与现代 Web 技术栈兼容，开发门槛低 |
| 资源模型 | Patient/Observation 等独立资源，可组合可扩展 |
| 可扩展性 | Extension 机制允许厂家/国标扩展 |
| API 优先 | 天然支持 CRUD/搜索/批量/订阅 |
| 文档即资源 | DocumentReference、Bundle 承载 CDA（CDA-on-FHIR） |
| 生态完善 | HAPI FHIR/IBM FHIR/Azure FHIR/Google FHIR |
| 行业采用 | 美国 ONC 规定 2022 起医院必须支持 FHIR |

---

## 二、国内医疗信息化标准生态

### 2.1 标准层级

```
国际标准（HL7/FHIR/IHE/SNOMED/LOINC/ICD/DICOM）
       │
       ▼ 国标化（本土化）
国家标准（GB/T、WS/T）
  ├─ WS 445《电子病历基本数据集》
  ├─ 卫生信息共享文档规范（基于 CDA）
  ├─ 《国家基本公共卫生服务规范》第三版
  └─ GB/T 14396《疾病分类与代码》
       │
       ▼
行业标准 / 团体标准
  ├─ 互联网医院数据交换规范（部分用 FHIR）
  └─ 医保结算接口规范
       │
       ▼
厂家私有标准
```

### 2.2 国际标准与国内标准映射

| 国际标准 | 国内对应 | 差异 |
| --- | --- | --- |
| HL7 v2 | 无国标对应 | 国内直接用 v2.4 |
| HL7 v3 / CDA | 卫生信息共享文档规范 | CN-CDA 本土化 |
| FHIR | 部分省份互联网医院规范 | 暂无统一国标 |
| LOINC | WS 445 部分引用 | 国内常用厂家自编代码 |
| SNOMED CT | 国内未广泛采用 | 试点中 |
| ICD-10 | GB/T 14396 | 中国版（含 2 万条扩展码） |
| IHE XDS | 共享文档规范的传输部分 | 国内落地少 |
| DICOM | 直接用 DICOM | PACS 厂家直接用 |

### 2.3 公卫体检为什么用国标 XML 而不用 FHIR

| 原因 | 详解 |
| --- | --- |
| 国标强制 | 《国家基本公共卫生服务规范》第三版明确要求 XML/JSON |
| 省级平台对接 | 各省公卫系统 WebService + 国标 XML |
| 历史包袱 | 2009 年新医改沉淀大量国标 XML 接口 |
| 数据结构差异 | 国标按"人群分类"组织，FHIR 按"资源"组织 |
| 监管要求 | 卫健委考核按国标字段验收 |
| 实施成本 | 改用 FHIR 需全国 31 省同步升级，不现实 |

### 2.4 何时应该用 FHIR

| 场景 | FHIR 适用度 | 原因 |
| --- | --- | --- |
| 公卫上报 | ✗ | 国标强制 |
| 体检对接老 HIS | △ | 看厂家支持 |
| 对接互联网医院 | ✓ | 多用 FHIR/RESTful |
| 跨机构健康档案 | ✓ | Patient/$everything 适合 |
| 商业保险理赔 | ✓ | 部分保险公司采用 |
| 患者端 API（小程序） | ✓ | 前端友好 |
| 设备数据接入 | ✗ | 用 DICOM/ASTM/私有协议 |
| 区域卫生信息平台 | △ | 老平台 CDA，新平台 FHIR |
| 科研数据共享 | ✓ | 资源模型适合 |

---

## 三、FHIR 资源模型：医疗信息化的"领域对象"

### 3.1 核心资源分类

| 类别 | 代表资源 | 用途 |
| --- | --- | --- |
| 基本信息 | Patient, Practitioner, Organization, Location | 患者主索引、医生、机构、地点 |
| 就诊 | Encounter, EpisodeOfCare, Appointment | 一次就诊、就诊周期、预约 |
| 申请 | ServiceRequest, MedicationRequest | 检查检验申请、用药申请 |
| 观察 | Observation, DiagnosticReport | 单项观察、综合报告 |
| 文档 | DocumentReference, Binary, Composition | 文档引用、二进制、文档组成 |
| 影像 | ImagingStudy | 影像检查（关联 DICOM） |
| 用药 | Medication, MedicationStatement, Immunization | 药品、用药记录、免疫接种 |
| 计划 | CarePlan, Task, CareTeam | 护理计划、任务、护理团队 |
| 标本 | Specimen | 检验标本 |
| 设备 | Device | 医疗设备 |

### 3.2 体检业务的 FHIR 资源映射

| 体检阶段 | FHIR 资源 |
| --- | --- |
| 预约 | Appointment + ServiceRequest |
| 报到 | Encounter（status=arrived） |
| 检中（生命体征） | Observation（category=vital-signs） |
| 检中（检验） | Observation（category=laboratory） + Specimen |
| 检中（影像） | ImagingStudy + DiagnosticReport（imaging） |
| 主检 | DiagnosticReport（status=preliminary） |
| 报告 | DiagnosticReport（status=final） + DocumentReference |
| 异常随访 | Task / CarePlan |
| 转诊 | ServiceRequest（referral） |

### 3.3 资源引用关系

```
Patient ──┬── Encounter ──── ServiceRequest ──── Observation
          │                                          │
          │                                          └── Specimen
          │
          ├── DiagnosticReport ──── result ──── Observation[]
          │
          ├── DocumentReference ──── content ──── Binary (PDF)
          │
          └── ImagingStudy ──── series ──── instance (DICOM)

Practitioner ──┬── Encounter.participant（体检医生）
               └── DiagnosticReport.performer（主检医生）

Organization ── Encounter.serviceProvider（体检机构）
```

### 3.4 用 Extension 表达国标特有字段

| 国标字段 | FHIR Extension |
| --- | --- |
| 人群分类 | population-category（CodeableConcept） |
| 健康评估 | health-assessment（string/CodeableConcept） |
| 随访建议 | followup-suggestion（string） |
| 异常项标识 | abnormal-flag（boolean） |
| 公卫上报状态 | public-health-report-status（code） |
| 上报批次号 | report-batch-id（identifier） |
| 体检车编号 | mobile-clinic-id（identifier） |

**Extension 设计原则**：
- 优先用标准资源字段，标准字段无法表达时才用 Extension
- Extension 必须定义 StructureDefinition（url + type + context）
- Extension 的 url 必须是绝对 URL，便于跨机构识别
- 国标字段用本地 CodeSystem，避免与 LOINC/SNOMED 冲突

---

## 四、FHIR Server 接口设计

### 4.1 关键 RESTful 接口

| 接口 | 方法 | URL |
| --- | --- | --- |
| 创建 | POST | /Patient |
| 更新 | PUT | /Patient/{id} |
| 读取 | GET | /Patient/{id} |
| 按身份证搜索 | GET | /Patient?identifier=http://example.org/cs/id-card\|110101199001011234 |
| 按姓名+生日 | GET | /Patient?name=张三&birthdate=1990-01-01 |
| 按患者拉观察项 | GET | /Observation?patient={id}&category=vital-signs |
| 按就诊拉报告 | GET | /DiagnosticReport?encounter={id} |
| 批量上传 | POST | /（Transaction Bundle） |
| 订阅事件 | POST | /Subscription |
| 拉取全部数据 | GET | /Patient/{id}/$everything |
| 历史版本 | GET | /Observation/{id}/_history |

### 4.2 搜索参数（Search Parameter）设计原则

| 原则 | 详解 |
| --- | --- |
| 用标准参数优先 | FHIR 标准已定义的（identifier、name、birthdate）优先 |
| 自定义参数用 Extension | 如"按人群分类搜索"需自定义 SearchParam |
| 索引友好 | 对应数据库索引，避免 LIKE 全表扫描 |
| 链式搜索 | `Patient?organization.name=XX` |
| 反向链 | `Patient?_revinclude=DiagnosticReport:subject` |
| 复合参数 | `Observation?patient={id}&date=gt2026-01-01&category=laboratory` |
| 强制分页 | `_count` + `_offset` 或 `Bundle.link[next]` |

### 4.3 Include 与 RevInclude

**Include（正向包含）**：搜索主资源时包含被引用的资源
```
GET /DiagnosticReport?patient={id}&_include=DiagnosticReport:result
返回：DiagnosticReport + Observation[]
```

**RevInclude（反向包含）**：搜索主资源时反向包含引用它的资源
```
GET /Patient?identifier=...&_revinclude=DiagnosticReport:subject
返回：Patient + DiagnosticReport[]
```

### 4.4 Subscription（订阅）

```json
POST /Subscription
{
  "resourceType": "Subscription",
  "status": "active",
  "criteria": "DiagnosticReport?status=final",
  "channel": {
    "type": "rest-hook",
    "endpoint": "https://internet-hospital.example.org/fhir/notify",
    "payload": "application/fhir+json"
  }
}
```

- 当 DiagnosticReport status 变为 final 时，FHIR Server 推送到 endpoint
- 适合"报告生成后通知互联网医院"场景
- channel 类型：rest-hook / websocket / email / sms / message

### 4.5 Patient/$everything 操作

```
GET /Patient/{id}/$everything

返回 Bundle，包含：
- Patient + 所有 Encounter + 所有 Observation + 所有 DiagnosticReport
- 所有 DocumentReference + 所有 MedicationStatement + ...
```

- 用于"拉取患者全量数据"（转诊、跨机构调阅）
- 数据量大时分页（Bundle.link[next]）

---

## 五、版本控制与并发：ETag + If-Match

### 5.1 乐观锁机制

```
# 客户端首次读取
GET /Observation/obs-001
响应：ETag: W/"1"

# 客户端更新
PUT /Observation/obs-001
Headers: If-Match: W/"1"
Body: {...}

# 服务端校验
- 当前 ETag 是 W/"1" -> 更新成功，新 ETag 是 W/"2"
- 当前 ETag 是 W/"2"（已被其他端修改）-> 412 Precondition Failed
```

### 5.2 多端修改冲突场景

```
T0: Observation 初始 value=120, ETag=W/"1"
T1: 医生 A 读取，得到 ETag=W/"1"
T2: 设备自动上传更新 value=125, ETag=W/"2"
T3: 医生 A 提交修改 value=145, If-Match: W/"1"
T4: 412 Precondition Failed，医生 A 需重新读取最新版本
```

### 5.3 冲突解决策略

| 策略 | 适用场景 |
| --- | --- |
| 最后写入胜出 | 简单场景，冲突少 |
| 客户端重试 | 冲突偶发 |
| 服务端合并 | 字段级冲突 |
| 业务规则仲裁 | 业务有优先级（如设备值优先于医生修改） |
| 人工介入 | 关键数据冲突 |

### 5.4 Transaction Bundle

```json
POST /
{
  "resourceType": "Bundle",
  "type": "transaction",
  "entry": [
    {"request": {"method": "POST", "url": "Observation"}, "resource": {...}},
    {"request": {"method": "POST", "url": "Observation"}, "resource": {...}},
    {"request": {"method": "POST", "url": "DiagnosticReport"}, "resource": {...}}
  ]
}
```

- **transaction**：全成功或全失败（原子性）
- **batch**：各自独立，部分失败不影响其他
- 适合"体检批量上传"（一份报告 + N 个观察项一次性写入）

---

## 六、Mirth Connect：医疗集成引擎

### 6.1 核心架构

```
Channel（通道）
  ├─ Source（源）：MLLP/HTTP/文件/数据库/FTP
  ├─ Transformer（转换器）：JavaScript 步骤
  ├─ Filter（过滤器）：消息过滤
  ├─ Router（路由器）：按内容路由
  └─ Destination（目的地）：HTTP/MLLP/数据库/文件
```

### 6.2 与通用 MQ 的差异

| 维度 | Mirth | RabbitMQ/Kafka |
| --- | --- | --- |
| 定位 | 医疗集成引擎 | 通用消息中间件 |
| 协议 | HL7 v2/ASTM/DICOM/CDA/FHIR | AMQP/Kafka |
| 转换能力 | 内置 JavaScript Transformer | 无 |
| 医疗标准 | 原生支持 | 无 |
| 适用 | 医疗异构系统集成 | 通用异步消息 |

### 6.3 必须用 Mirth 的场景

| 场景 | 原因 |
| --- | --- |
| HIS 推送 HL7 v2 ORU 检验结果 | Mirth 原生支持 MLLP + v2 解析 |
| LIS 推送 ASTM 检验结果 | Mirth 内置 ASTM 协议 |
| PACS 推送 DICOM 影像元数据 | Mirth 支持 DICOM 解析 |
| CDA 文档生成与交换 | Mirth 内置 CDA 模板支持 |
| 跨系统集成（多厂家 HIS/EMR/LIS/PACS） | Mirth 是"集成平台"标准 |

### 6.4 通用 MQ 即可的场景

| 场景 | 原因 |
| --- | --- |
| 体检系统内部异步任务 | RabbitMQ 足够 |
| 体检系统与互联网医院 FHIR 互操作 | FHIR 是 RESTful，HTTP 即可 |
| 公卫上报异步队列 | 通用 MQ + 自定义适配器 |
| 大数据分析消息流 | Kafka 适合 |

### 6.5 HL7 v2 -> FHIR 转换通道设计

```
Source: MLLP Listener Port:2575
   │
   ▼
Transformer（JavaScript）:
   1. 解析 HL7 v2（PipeParser）
   2. 提取 PID -> Patient
   3. 提取 OBR -> DiagnosticReport
   4. 遍历 OBX -> Observation[]
   5. 构造 Transaction Bundle
   │
   ▼
Filter: MSH-9 = ORU^R01
   │
   ▼
Destination: HTTP POST /fhir（FHIR Server）
```

**关键字段映射**：

| HL7 v2 | FHIR |
| --- | --- |
| PID-3（患者ID） | Patient.identifier |
| PID-5（姓名） | Patient.name |
| PID-7（生日） | Patient.birthDate |
| PID-8（性别） | Patient.gender |
| OBR-4（检查代码） | DiagnosticReport.code |
| OBR-7（观察时间） | DiagnosticReport.effectiveDateTime |
| OBX-3（观察项代码） | Observation.code |
| OBX-5（观察值） | Observation.valueQuantity.value |
| OBX-6（单位） | Observation.valueQuantity.unit |

### 6.6 消息堆积/重复/顺序

| 问题 | 策略 |
| --- | --- |
| 消息堆积 | 异步处理 + 多线程消费 + 持久化队列 + 死信队列 + 限流 + 监控告警 |
| 消息重复 | 消息 ID 去重 + FHIR conditional update（PUT?identifier=msg-001） |
| 消息顺序 | 同患者哈希分队列串行 + 跨患者并行 |

---

## 七、FHIR Server 部署架构

### 7.1 整体架构

```
互联网医院/商业保险/小程序
        │ HTTPS + OAuth2
        ▼
API Gateway（Kong/Nginx）
   ├─ TLS 终止
   ├─ 限流
   ├─ 鉴权
   └─ 路由
        │
        ▼
FHIR Server（HAPI FHIR）
   ├─ RESTful 接口
   ├─ 资源校验
   ├─ Search Parameter
   ├─ Subscription
   └─ Transaction
        │
        ▼
PostgreSQL 集群
   ├─ Master（读写）
   ├─ Slave x 2（只读）
   └─ 资源 JSONB + 索引
        │
        ▼
Redis（缓存 + 限流）
```

### 7.2 HAPI FHIR 选型理由

| 维度 | HAPI FHIR | IBM FHIR | 自研 |
| --- | --- | --- | --- |
| 完整度 | R4/R5 全资源 | R4 | 自定义 |
| 开源 | Apache 2.0 | Apache 2.0 | - |
| Java 生态 | 与 Spring Boot 兼容 | Java | - |
| 性能 | 中等（可优化） | 高 | - |
| 学习曲线 | 中等 | 陡 | - |
| 适用 | 大多数医疗信息化 | 大型企业 | 特殊需求 |

### 7.3 数据库选型

| 数据库 | 优势 | 劣势 | 适用 |
| --- | --- | --- | --- |
| PostgreSQL | JSONB + GIN 索引 + 稳定 | 国产生态弱 | **主流选择** |
| Oracle | 性能稳定 | 成本高 | 大型三甲 |
| MySQL | 简单 | JSON 弱 | 小规模 |
| 达梦 | 信创 | JSONB 差 | 信创要求 |
| MongoDB | 文档模型契合 | 事务弱 | 不推荐 |

### 7.4 性能优化

| 优化点 | 实现 |
| --- | --- |
| 索引优化 | Search Parameter 索引（identifier、name、birthdate） |
| 缓存 | Redis 缓存热点资源 + 搜索结果 |
| 分页强制 | `_count=50` 最大，避免全表扫描 |
| 读写分离 | 读走 PG Slave，写走 Master |
| 异步索引 | 写入后异步更新搜索索引 |
| 批量接口 | Bundle/Transaction 减少请求次数 |
| 资源压缩 | 大资源（Binary）用 GZIP |
| 字段裁剪 | `_elements=Patient.name,birthDate` |

---

## 八、安全：OAuth2 + SMART on FHIR

### 8.1 OAuth2 三种授权

| 授权类型 | 适用 | scope |
| --- | --- | --- |
| 患者授权 | 小程序调阅自己报告 | `patient/.*.read` |
| 医生授权 | 互联网医院医生调阅 | `user/.*.read` + `patient={id}` |
| 机构授权 | 互联网医院批量调阅（对账） | `system/.*.read` |

### 8.2 SMART on FHIR 流程

```
1. 小程序 -> FHIR Server /.well-known/smart-configuration 获取配置
2. 跳转到 authorize_endpoint
3. 患者授权
4. 回调小程序，携带 code
5. 小程序用 code 换 access_token
6. 小程序用 access_token 调 FHIR API
```

### 8.3 SMART on FHIR 优势

| 优势 | 详解 |
| --- | --- |
| 标准化 | 国际通用，避免每家互联网医院自定义 |
| 互操作 | 可对接任意支持 SMART 的应用 |
| 安全 | 基于 OAuth2 + OpenID Connect |
| 患者授权留痕 | 授权记录可审计 |

### 8.4 多机构 SaaS 部署

| 方案 | 隔离强度 | 适用 |
| --- | --- | --- |
| 数据库级隔离（每租户一库） | 强 | 大客户（三甲） |
| 表级隔离（tenant_id 字段） | 中 | 中小机构（乡镇） |
| Schema 级隔离（FHIR Extension） | 中 | 实验性 |

**混合部署推荐**：
- 大客户（三甲医院）：私有化部署 FHIR Server
- 小客户（乡镇卫生院）：共享 SaaS FHIR Server + tenant_id 隔离

---

## 九、双轨架构：FHIR + 国标同时支持

### 9.1 架构图

```
体检系统内部领域模型（ExamReport）
        │
        ├─ 领域事件总线
        │     │
        ├─────┼──────┐
        ▼     ▼      ▼
    FHIR 适配  国标适配  其他适配
        │     │      │
        ▼     ▼      ▼
   FHIR Server  省级公卫  互联网医院
   (REST API)  (WebService)
```

### 9.2 关键设计

| 设计点 | 实现 |
| --- | --- |
| 领域模型与标准解耦 | 内部用 ExamReport，不绑定 FHIR/国标 |
| 领域事件驱动 | 报告发布发出 ExamReportPublishedEvent |
| 各适配器并行处理 | FHIR/国标各自订阅事件 |
| 失败独立补偿 | 各自重试 + 死信队列 |
| 定时对账 | FHIR Server 资源 vs 国标上报记录 |

### 9.3 国标上报状态反馈到 FHIR

| 上报状态 | FHIR 状态 |
| --- | --- |
| 待上报 | DiagnosticReport.status = "preliminary"，Extension: pending |
| 上报成功 | DiagnosticReport.status = "final"，Extension: success |
| 上报失败 | DiagnosticReport.status = "final"，Extension: failed |
| 上报后修改 | DiagnosticReport.status = "amended"，生成新版本 |
| 上报后撤销 | DiagnosticReport.status = "entered-in-error" |

---

## 十、体检系统与互联网医院 FHIR 对接

### 10.1 对接场景

| 场景 | FHIR 接口 | 调用方 |
| --- | --- | --- |
| 调阅体检报告 | GET /DocumentReference?patient={id} | 互联网医院 -> 体检 |
| 调阅报告 PDF | GET /Binary/{id} | 互联网医院 -> 体检 |
| 查询患者信息 | GET /Patient?identifier=... | 互联网医院 -> 体检 |
| 查询检查检验 | GET /Observation?patient={id}&category=laboratory | 互联网医院 -> 体检 |
| 体检预约 | POST /Appointment + POST /ServiceRequest | 互联网医院 -> 体检 |
| 报告生成通知 | Subscription（rest-hook） | 体检 -> 互联网医院 |

### 10.2 百万级日调用扛住策略

| 优化 | 效果 |
| --- | --- |
| 横向扩展 | FHIR Server 无状态，多实例 + LB |
| 读写分离 | 读走 Slave，写走 Master |
| Redis 缓存 | 命中率 70%+ |
| Bundle 批量 | 减少请求次数 |
| 异步索引 | 写入快 |
| API Gateway 限流 | 100 QPS/租户 |
| 字段裁剪 | 节省带宽 |
| 强制分页 | 内存可控 |

### 10.3 容量估算（日调用 100 万次）

```
日调用量：100 万
峰值 QPS：约 100
单实例 QPS：约 50（HAPI FHIR 优化后）
所需实例：2-3 个 FHIR Server
数据库：PG Master + 2 Slave
缓存：Redis 集群（3 主 3 从）
带宽：约 50 Mbps
```

---

## 十一、FHIR 在国内的落地现状

### 11.1 FHIR Server 产品对比

| 产品 | 类型 | 特点 |
| --- | --- | --- |
| HAPI FHIR | 开源 Java | 最完整，R4/R5 支持 |
| IBM FHIR Server | 开源 | 企业级 |
| Azure API for FHIR | 云服务 | 托管、HIPAA |
| Google Cloud FHIR | 云服务 | 与 BigQuery 集成 |
| AWS HealthLake | 云服务 | 内置 ML |
| 阿里健康 FHIR | 国内云 | 国内最早实践 |
| 东软 FHIR | 商业 | HIS 集成 |

### 11.2 中文 FHIR IG 现状

- 国家层面无官方 FHIR IG
- 中国电子技术标准化研究院（CESI）发布《健康医疗数据安全指南》，未含 FHIR IG
- 国家卫健委《医院信息互联互通标准化成熟度测评》部分指标提及 FHIR
- 部分 OpenEHR 中文社区在推动中文 FHIR IG
- 实践案例：上海、浙江部分互联网医院试点 FHIR

### 11.3 FHIR 与国标兼容挑战

| 挑战 | 详解 |
| --- | --- |
| 资源模型差异 | 国标按"人群分类"，FHIR 按"资源"，无直接映射 |
| 编码体系 | 国标用 GB/T 14396，FHIR 用 ICD-10/LOINC/SNOMED |
| 扩展机制 | FHIR Extension vs 国标 XML 元素，需设计转换 |
| 术语映射 | 国标检验项代码与 LOINC 映射不全 |
| 数据结构 | 国标的"人群分类""健康评估"无对应 FHIR 资源 |
| 验证标准 | 卫健委考核按国标字段，FHIR 需逆向映射 |

### 11.4 公卫 SaaS 引入 FHIR 的切入路径

| 路径 | 价值 | 复杂度 |
| --- | --- | --- |
| 1. 对外开放患者端 API（小程序） | 前端友好 | 低 |
| 2. 对接互联网医院 | 互联网医院多用 FHIR | 中 |
| 3. 对接商业保险理赔 | 部分保险公司用 FHIR | 中 |
| 4. 跨机构居民健康档案调阅 | Patient/$everything 适合 | 中高 |
| 5. 区域卫生信息平台对接（新建） | 新建平台倾向 FHIR | 高 |
| 6. 内部数据中台统一资源模型 | FHIR 资源作为统一模型 | 高 |

---

## 十二、Day03 关键考点速记

| 考点 | 一句话记忆 |
| --- | --- |
| 四代标准 | v2（消息）/ v3（RIM，未落地）/ CDA（文档）/ FHIR（资源+REST） |
| v2 字段分隔符 | `\|` 字段、`^` 组件、`~` 重复、`\` 转义、`&` 子组件 |
| v2 段 | MSH 头、EVN 事件、PID 患者、PV1 就诊、OBR 检查、OBX 观察 |
| v2 是国内事实标准 | 历史包袱 + 实时消息优势 + 厂家定制 Z 段 |
| FHIR 核心资源 | Patient/Encounter/ServiceRequest/Observation/DiagnosticReport |
| FHIR 优势 | RESTful + JSON + 资源模型 + Extension + 生态完善 |
| 体检业务映射 | 预约 Appointment/报到 Encounter/检中 Observation/主检 DiagnosticReport |
| Search Parameter | 用标准优先、索引友好、支持链式/反向链/复合参数 |
| Include/RevInclude | Include 拉被引用资源，RevInclude 拉引用者 |
| Subscription | rest-hook 推送，适合报告生成通知 |
| 乐观锁 | ETag + If-Match，412 Precondition Failed |
| Transaction Bundle | 全成功或全失败，适合批量上传 |
| Mirth 必用场景 | HL7 v2/ASTM/DICOM/CDA 解析与转换 |
| 通用 MQ 即可场景 | 内部异步、FHIR 互操作、公卫上报队列 |
| 双轨架构 | 领域事件驱动 + FHIR/国标适配器并行 |
| 多租户隔离 | 大客户私有化，小客户共享 + tenant_id |
| SMART on FHIR | OAuth2 医疗扩展 + scope + launch 上下文 |
| 公卫 SaaS 引入 FHIR | 患者端 -> 互联网医院 -> 商业保险 -> 区域平台 |

---

## 十三、与 Day02 的衔接与 Day04 的预告

### 13.1 Day03 与 Day02 的衔接

- Day02 题目一的"集成模式选型"（HL7 v2 / FHIR）-> Day03 深入四代标准对比
- Day02 题目二的"实时查询（FHIR/HL7 v2）"-> Day03 的 FHIR Server 接口设计
- Day02 题目三的"CDA 文档回写"-> Day03 的 CDA-on-FHIR 过渡
- Day02 的"多 HIS 厂家适配"-> Day03 的 Mirth Connect 集成引擎实战
- Day02 的"国标上报 vs FHIR"-> Day03 的双轨架构设计

### 13.2 Day04 预告：DICOM/PACS 影像系统

- DICOM 协议详解（DIMSE-C/DIMSE-N、SOP Class UID、Transfer Syntax）
- 三大服务类：Storage / Query-Retrieve / Modality Worklist
- PACS 系统架构（图像存储、WADO/QIDO、影像调阅）
- 体检影像（B 超、X 光、CT）的 DICOM 标准化
- Orthanc 开源 PACS 部署与对接实战
- 体检系统与 PACS 的集成（DICOM Worklist、影像调阅链接）
- Day03 的 FHIR ImagingStudy 资源与 DICOM 影像的关联