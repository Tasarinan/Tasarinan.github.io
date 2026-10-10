# 架构师学习-Day05-医保对接与医疗支付结算

> 日期：2026年07月10日（周五）
> 周主题：医疗信息化专题
> 出题日：Day05 - 医保对接与医疗支付结算

---

## 背景

Day01-Day04 把镜头从体检业务（Day01）拉到 HIS/EMR（Day02）、HL7/FHIR（Day03）、DICOM/PACS（Day04），覆盖了"医疗业务与医疗数据"两条线。但医疗行业还有一条**资金线**--医保结算。Day05 把镜头拉到这条特殊的"医疗支付"链路。

为什么医保对接对你重要？

1. **体检业务的医保属性**：公卫体检是**免费**（财政全额拨款，不计费），但商业体检、入职体检、从业人员健康证体检涉及**个人支付/企业支付/医保支付**的混合。啄木鸟云健康智慧体检的主战场是公卫，但商业体检 SaaS、互联网医院的延伸必然涉及医保对接。跳槽到三甲医疗信息化公司（卫宁、东软、创业慧康）必然要懂医保。
2. **医保是国内医疗信息化的"硬骨头"**：国家医保局成立后（2018），医保信息化建设进入快车道--国家医保信息平台、医保电子凭证、DRG/DIP 支付方式改革、集中带量采购、跨省异地就医直接结算。每一项都是万亿级资金流，每一项都对系统对接有强约束。能讲清医保对接的架构师，在国内医疗信息化市场是稀缺的。
3. **医保接口规范国内独有**：HL7/FHIR/DICOM 是国际标准，医保对接走的是**国家医保信息平台**的接口规范--前端服务（HOS）、医保业务编码、医保电子凭证、电子票据、异地就医、DRG/DIP 结算。这套规范与 HL7/FHIR 体系**完全独立**，是国内医疗信息化架构师必须掌握的"另一套语言"。
4. **跳槽到更好的医疗公司**：三甲医院信息化公司的核心模块之一就是医保对接（医保控费、智能审核、DRG/DIP 入组、医保结算）。能讲清"医保三段式结算流程"、"医保目录引擎"、"医保-医院-患者三方对账"、"DRG/DIP 支付改革对系统的影响"，是医疗信息化架构师的硬实力。
5. **医保与支付的交叉**：第5周支付专题讲的是"商业支付"（微信/支付宝/银联），本周 Day05 讲的是"医保支付"--两者有共性（幂等、对账、差错处理），也有差异（医保有目录约束、有报销规则、有异地结算、有 DRG/DIP）。能对比"商业支付 vs 医保支付"的架构师，能更好地驾驭医疗+支付的复合场景。
6. **啄木鸟云健康场景**：当前啄木鸟的智慧体检主要是公卫免费体检，不涉及医保。但若延伸到商业体检（个人加项）、互联网医院在线问诊开方、慢病随访开药、家庭医生签约服务包等场景，必然涉及医保对接。提前补齐这块能力，是跳槽到更好医疗公司的关键。

本日三道题：
- 题目一：医保系统全景与对接架构（架构设计题）
- 题目二：体检场景下的医保结算流程与目录对照（工程实战题）
- 题目三：医保电子凭证、移动支付、商保直付的混合支付方案（选型权衡题）

---

## 题目一（架构设计题）：医保系统全景与对接架构

请回答：

1. 国内医保体系的整体架构？国家医保局、省医保中心、市医保经办、定点医药机构（医院/药店）的层级关系？医保信息平台（国家-省-市三级）的部署架构与数据流转？医保三大基础数据库（医保目录库、定点机构库、参保人员库）的作用？医院 HIS 与医保系统的边界在哪里？
2. 医院侧医保对接的核心模块？HIS 中的"医保接口模块"负责什么？医保业务编码（医保疾病诊断 ICD-10、医保手术操作 ICD-9-CM-3、医保药品、医保医用耗材、医保医疗服务项目）的作用与维护？医保三大目录（药品目录、诊疗项目目录、医用耗材目录）与医院本地目录的对照机制？
3. 医保结算的"三段式"流程？挂号/登记（医保身份核验 + 待遇享受判定）-> 就诊/计费（医嘱->医保审核->计费明细上传）-> 结算（医保计算 + 个人支付 + 医保支付）的完整链路？每一段在 HIS 中的对应模块？哪些是同步调用医保接口、哪些是异步？
4. 医保对接的接口规范？国家医保信息平台的"前端服务（HOS）"接口体系（医保电子凭证、医保结算、医保审核、异地就医、DRG/DIP）？接口协议（HTTP+XML/JSON+签名）？医保电子凭证的扫码/读卡流程？医保接口的容错与重试策略？

### 作答区

#### 1. 国内医保体系整体架构

**医保体系层级**：

```
┌──────────────────────────────────────────────────────────────────┐
│  国家医保局（NHSA）                                                │
│  - 制定医保政策、目录、支付方式改革                                │
│  - 建设国家医保信息平台                                            │
│  - 集中带量采购、DRG/DIP 推广                                      │
└──────────────────────────────────────────────────────────────────┘
                            │
                            │  政策下发 / 目录更新 / 跨省结算指令
                            ▼
┌──────────────────────────────────────────────────────────────────┐
│  省医保局 / 省医保中心                                             │
│  - 落地国家政策，制定省级细则                                      │
│  - 建设省级医保信息平台                                            │
│  - 省内异地就医直接结算                                            │
└──────────────────────────────────────────────────────────────────┘
                            │
                            │  省级目录 / 省内结算
                            ▼
┌──────────────────────────────────────────────────────────────────┐
│  市医保经办机构（市医保中心）                                      │
│  - 具体经办：参保登记、待遇审核、费用结算                          │
│  - 与定点医药机构签协议、对账、付款                                │
└──────────────────────────────────────────────────────────────────┘
                            │
                            │  医保协议 / 月度对账 / 费用拨付
                            ▼
┌──────────────────────────────────────────────────────────────────┐
│  定点医药机构（医院 / 药店 / 体检机构）                            │
│  - 与医保系统对接，提供医保结算服务                                │
│  - 上传费用明细，接受医保审核                                      │
└──────────────────────────────────────────────────────────────────┘
```

**国家医保信息平台（NHIP）部署架构**：

```
┌──────────────────────────────────────────────────────────────────┐
│  国家医保信息平台（云端）                                          │
│                                                                    │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐            │
│  │ 医保电子凭证  │  │ 异地就医     │  │ DRG/DIP      │            │
│  │ 中心         │  │ 结算中心     │  │ 结算中心     │            │
│  └──────────────┘  └──────────────┘  └──────────────┘            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐            │
│  │ 药品集中采购 │  │ 智能审核     │  │ 医保基金监管 │            │
│  │ 中心         │  │ 中心         │  │ 中心         │            │
│  └──────────────┘  └──────────────┘  └──────────────┘            │
│                                                                    │
│  三大基础数据库：                                                  │
│  - 医保目录库（药品/诊疗项目/医用耗材）                            │
│  - 定点机构库（定点医院/定点药店）                                 │
│  - 参保人员库（全国 13.6 亿参保人）                                │
└──────────────────────────────────────────────────────────────────┘
                            │
                            │  专线 / VPN
                            ▼
┌──────────────────────────────────────────────────────────────────┐
│  省级医保信息平台                                                  │
│  - 落地国家平台下发的能力                                          │
│  - 省内扩展业务（如门诊统筹、大病保险、医疗救助）                  │
│  - 省内异地就医结算枢纽                                            │
└──────────────────────────────────────────────────────────────────┘
                            │
                            │  专线 / VPN
                            ▼
┌──────────────────────────────────────────────────────────────────┐
│  定点医药机构 HIS                                                  │
│  - 通过"医保前置机"或"医保接口网关"对接                            │
│  - 上传费用明细、下载目录更新、获取审核结果                        │
└──────────────────────────────────────────────────────────────────┘
```

**三大基础数据库**：

| 数据库 | 维护方 | 内容 | 更新频率 | 在 HIS 中的作用 |
|---|---|---|---|---|
| **医保目录库** | 国家医保局 | 药品（西药/中成药/中药饮片）、诊疗项目、医用耗材 | 每年大调整 + 不定期增补 | 医院本地目录需要与医保目录对照，计费时按医保目录判定报销 |
| **定点机构库** | 国家/省医保局 | 全国定点医院、定点药店（约 50w+ 家） | 实时变动（新增/取消） | 跨省异地就医时校验对方医院是否定点 |
| **参保人员库** | 国家医保局 | 全国 13.6 亿参保人（职工医保 / 居民医保） | 实时变动（参保/停保/转移） | 通过医保电子凭证查询参保状态、待遇享受 |

**HIS 与医保系统的边界**：

```
┌──────────────────────────────────────┐   ┌──────────────────────────────────────┐
│  医院 HIS                              │   │  医保系统                              │
│                                        │   │                                        │
│  - 患者主索引（EMPI）                  │   │  - 参保人员库（全国统一）              │
│  - 门诊/住院业务                       │   │  - 待遇享受判定                        │
│  - 医生工作站（开医嘱/处方）           │ ←→ │  - 医保目录                            │
│  - 本地计费（项目/药品/耗材）          │   │  - 医保审核（规则引擎）                │
│  - 本地库存                            │   │  - 医保计算（报销比例/起付线/封顶线）  │
│  - 电子病历（EMR）                     │   │  - 医保结算（统筹/个人账户）           │
│  - 影像/检验                           │   │  - 医保基金监管                        │
│  - 医院本地财务                        │   │  - 跨省异地就医                        │
│                                        │   │                                        │
│  医保接口模块（边界）：                │   │  前置服务（HOS）接口：                │
│  - 医保身份核验                        │   │  - 身份核验                           │
│  - 医保目录对照                        │   │  - 待遇查询                           │
│  - 费用明细上传                        │   │  - 费用上传/审核/结算                  │
│  - 医保结算撤销                        │   │  - 异地就医                           │
│  - 医保对账文件下载                    │   │  - DRG/DIP                            │
└──────────────────────────────────────┘   └──────────────────────────────────────┘
                ↑                                     ↑
                │                                     │
                └────────── 专线 / VPN ──────────────┘
```

> 架构师要点：HIS 是"医院侧业务系统"，医保是"国家侧支付方系统"。两者的边界是**医保接口模块**（HIS 端）与**前端服务 HOS**（医保端）。所有跨边界的调用必须走标准接口，不能直接读对方数据库。

#### 2. 医院侧医保对接核心模块

**HIS 中的医保接口模块架构**：

```
┌──────────────────────────────────────────────────────────────────┐
│  HIS - 医保接口模块                                                │
│                                                                    │
│  ┌─────────────────────────────────────────────┐                  │
│  │  1. 医保身份核验子模块                       │                  │
│  │  - 读医保电子凭证（扫码/读卡）               │                  │
│  │  - 调用医保"身份核验"接口                    │                  │
│  │  - 返回参保状态、待遇享受、个人账户余额       │                  │
│  └─────────────────────────────────────────────┘                  │
│  ┌─────────────────────────────────────────────┐                  │
│  │  2. 医保目录对照子模块                       │                  │
│  │  - 维护医院本地目录与医保目录的映射          │                  │
│  │  - 本地药品 ↔ 医保药品编码                   │                  │
│  │  - 本地项目 ↔ 医保诊疗项目编码               │                  │
│  │  - 本地耗材 ↔ 医保耗材编码                   │                  │
│  └─────────────────────────────────────────────┘                  │
│  ┌─────────────────────────────────────────────┐                  │
│  │  3. 医保审核子模块                           │                  │
│  │  - 医生开医嘱时实时预审核                    │                  │
│  │  - 调用医保"事前审核"接口                    │                  │
│  │  - 不合规医嘱提示医生（如超量/适应症不符）   │                  │
│  └─────────────────────────────────────────────┘                  │
│  ┌─────────────────────────────────────────────┐                  │
│  │  4. 费用明细上传子模块                       │                  │
│  │  - 按医保接口规范打包费用明细                │                  │
│  │  - 调用医保"费用上传"接口                    │                  │
│  │  - 处理上传失败（重试/人工介入）             │                  │
│  └─────────────────────────────────────────────┘                  │
│  ┌─────────────────────────────────────────────┐                  │
│  │  5. 医保结算子模块                           │                  │
│  │  - 调用医保"结算"接口                        │                  │
│  │  - 解析返回的结算单                          │                  │
│  │  - 计算"个人支付"金额                        │                  │
│  │  - 触发商业支付（微信/支付宝/现金）          │                  │
│  └─────────────────────────────────────────────┘                  │
│  ┌─────────────────────────────────────────────┐                  │
│  │  6. 医保结算撤销子模块                       │                  │
│  │  - 退费时调用医保"结算撤销"接口              │                  │
│  │  - 处理撤销失败（已拨付无法撤销）            │                  │
│  └─────────────────────────────────────────────┘                  │
│  ┌─────────────────────────────────────────────┐                  │
│  │  7. 医保对账子模块                           │                  │
│  │  - 下载医保对账文件                          │                  │
│  │  - 与 HIS 本地结算记录比对                   │                  │
│  │  - 生成差错单，触发人工核差                  │                  │
│  └─────────────────────────────────────────────┘                  │
│  ┌─────────────────────────────────────────────┐                  │
│  │  8. 异地就医子模块                           │                  │
│  │  - 异地参保人备案查询                        │                  │
│  │  - 异地就医直接结算                          │                  │
│  │  - 异地就医费用上传                          │                  │
│  └─────────────────────────────────────────────┘                  │
│  ┌─────────────────────────────────────────────┐                  │
│  │  9. DRG/DIP 子模块                           │                  │
│  │  - 病案首页上传                              │                  │
│  │  - DRG 入组判定                              │                  │
│  │  - DIP 病种分值计算                          │                  │
│  └─────────────────────────────────────────────┘                  │
└──────────────────────────────────────────────────────────────────┘
```

**医保业务编码体系**：

| 编码类型 | 标准 | 长度 | 示例 | 维护方 |
|---|---|---|---|---|
| **医保疾病诊断编码** | ICD-10（医保版） | 6 位 + 扩展 | A01.001 | 国家医保局 |
| **医保手术操作编码** | ICD-9-CM-3（医保版） | 4 位 + 扩展 | 01.01001 | 国家医保局 |
| **医保药品编码** | 国家药品代码 | 20 位 | XA01BD0010010000000X | 国家医保局 |
| **医保医用耗材编码** | 国家耗材编码 | 27 位 | 070101001000000000000000000 | 国家医保局 |
| **医保医疗服务项目编码** | 国家医疗服务项目 | 9 位 | 110100001 | 国家医保局 |
| **医院本地项目编码** | 医院自定义 | 不定 | HM001234 | 医院 |

> 架构师要点：医保业务编码是医保结算的"术语系统"，相当于医疗版的"商品 SKU"。HIS 本地目录必须与医保目录做**双向对照**（医院本地编码 ↔ 医保编码），未对照的项目医保不报销。

**医保三大目录**：

| 目录 | 内容 | 数量级 | 报销规则 |
|---|---|---|---|
| **药品目录** | 西药、中成药、中药饮片、谈判药 | 西药 ~1500 种，中成药 ~1400 种 | 甲类 100% 报销，乙类按比例自付后剩余报销 |
| **诊疗项目目录** | 检查、治疗、手术、康复 | ~5000 项 | 部分全额报销，部分按比例自付 |
| **医用耗材目录** | 高值耗材、低值耗材 | ~3000 种 | 设定医保支付限价，超限自付 |

**医院本地目录与医保目录对照机制**：

```
┌──────────────────────────────────────────────────────────────────┐
│  目录对照表（医院本地维护）                                        │
│                                                                    │
│  本地药品编码 | 本地药品名称 | 医保药品编码        | 医保类别     │
│  HM001234     | 阿司匹林     | XA01BD00100100...  | 甲类         │
│  HM001235     | 氯吡格雷     | XA02BC00100100...  | 乙类自付 5%  │
│  HM001236     | 美托洛尔     | XA02AB00100100...  | 乙类自付 10% │
│  HM999999     | 进口保健品   | (未对照)            | 自费         │
└──────────────────────────────────────────────────────────────────┘
```

对照流程：
- 新增药品时：药剂科在 HIS 维护本地编码 + 医保编码对照
- 计费时：HIS 按本地编码计费，医保结算时按对照关系查到医保编码
- 未对照项目：医保系统拒付，需医院自费或患者承担

#### 3. 医保结算"三段式"流程

**完整链路**：

```
┌──────────────────────────────────────────────────────────────────┐
│  阶段一：挂号/登记（医保身份核验 + 待遇享受判定）                  │
└──────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────────────┐
│  阶段二：就诊/计费（医嘱 -> 医保审核 -> 计费明细上传）             │
└──────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────────────┐
│  阶段三：结算（医保计算 + 个人支付 + 医保支付）                    │
└──────────────────────────────────────────────────────────────────┘
```

**阶段一：挂号/登记**

```
T0: 患者到院，扫码/读卡（医保电子凭证/社保卡/身份证）
T1: HIS 调用医保"身份核验"接口
    - 入参：医保电子凭证码 / 社保卡号
    - 出参：参保状态、参保地、险种（职工/居民）、待遇享受标志
T2: HIS 调用医保"待遇查询"接口
    - 出参：起付线、报销比例、封顶线、个人账户余额
T3: 患者挂号，HIS 生成就诊号，标记"医保就诊"
T4: （异地参保）HIS 调用"异地就医备案查询"
    - 出参：备案是否有效、备案地、备案有效期
```

调用方式：**同步**（必须等医保返回才能挂号）

**阶段二：就诊/计费**

```
T5: 医生工作站开医嘱（药品/检查/治疗/手术）
T6: HIS 实时调用医保"事前审核"接口
    - 入参：就诊号 + 医嘱明细
    - 出参：审核结果（通过/不通过/警告）
    - 不通过原因：超量、适应症不符、限工伤保险等
T7: 医生确认医嘱，HIS 生成计费明细（本地计费）
T8: 检查/治疗/取药执行
T9: （住院）每日上传费用明细到医保
    - 调用医保"费用明细上传"接口
    - 同步返回：上传成功/失败
T10: （门诊）就诊结束，触发结算
```

调用方式：
- 事前审核：**同步**（医生等待审核结果决定是否开医嘱）
- 费用明细上传：**异步**（住院每日批量上传，门诊就诊结束后批量上传）

**阶段三：结算**

```
T11: HIS 调用医保"结算"接口
    - 入参：就诊号 + 全部费用明细
    - 出参：医保结算单
        - 总费用
        - 自费金额
        - 自付金额（乙类自付）
        - 起付线
        - 统筹支付金额
        - 个人账户支付金额
        - 个人支付金额
T12: HIS 展示结算单，患者确认
T13: HIS 触发商业支付（个人支付部分）
    - 微信/支付宝/现金/银行卡
T14: 支付成功，HIS 调用医保"结算确认"接口
    - 出参：医保结算流水号
T15: HIS 生成发票、打印结算单
```

调用方式：
- 结算：**同步**（患者等待结算结果）
- 结算确认：**同步**（必须等医保确认才能完成结算）

**模块对应关系**：

| 阶段 | HIS 模块 | 医保接口 | 同步/异步 |
|---|---|---|---|
| 挂号/登记 | 挂号处、入院登记 | 身份核验、待遇查询、异地备案查询 | 同步 |
| 就诊/计费 | 医生工作站、计费模块 | 事前审核、费用明细上传 | 事前同步、上传异步 |
| 结算 | 收费处、出院结算 | 结算、结算确认、结算撤销 | 同步 |

#### 4. 医保对接接口规范

**国家医保信息平台前端服务（HOS）接口体系**：

| 接口类别 | 主要接口 | 用途 |
|---|---|---|
| **医保电子凭证** | 电子凭证生成、电子凭证核验 | 替代实体社保卡 |
| **身份核验** | 参保信息查询、待遇享受查询 | 挂号/登记时核验身份 |
| **费用结算** | 费用明细上传、结算、结算确认、结算撤销 | 三段式结算 |
| **医保审核** | 事前审核、事中审核、事后审核 | 全流程控费 |
| **异地就医** | 异地备案查询、异地就医结算 | 跨省就医 |
| **DRG/DIP** | 病案首页上传、DRG 入组、DIP 分值 | 支付方式改革 |
| **目录管理** | 目录查询、目录对照 | 三大目录 |
| **对账管理** | 对账文件下载、差错处理 | T+1 对账 |
| **医保电子票据** | 电子票据开具、电子票据查询 | 替代纸质发票 |

**接口协议（典型）**：

```
协议：HTTPS + JSON / XML
签名：SM2 / RSA
加密：SM4 / AES（敏感字段）
编码：UTF-8

请求报文示例（医保电子凭证核验）：
POST /api/medical/cert/verify HTTP/1.1
Content-Type: application/json
X-Sign: <SM2 签名>

{
  "infno": "1101",          // 交易编号
  "infver": "1.0",          // 接口版本
  "infid": "uuid-1234",     // 唯一流水
  "orgno": "H12345678",    // 定点机构编号
  "cert_no": "abc123...",   // 医保电子凭证码
  "name": "张三",           // 姓名（加密）
  "id_no": "AES:xxxx..."    // 身份证号（加密）
}

响应报文示例：
{
  "infcode": 0,             // 0=成功，非0=失败
  "infmsg": "成功",
  "infid": "uuid-1234",
  "output": {
    "insutype": "110",      // 险种（职工）
    "balc": 12345.67,       // 个人账户余额
    "psn_type": "1",        // 人员类别
    "etf_flag": "1"         // 待遇享受标志
  }
}
```

**医保电子凭证扫码/读卡流程**：

```
┌─────────────────────────────────────────────────────────────┐
│  患者端（手机）                                              │
│  - 国家医保 APP / 微信小程序 / 支付宝小程序                  │
│  - 展示医保电子凭证动态二维码（每分钟刷新）                   │
└─────────────────────────────────────────────────────────────┘
                          │
                          │  扫码
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  HIS 读卡器 / 扫码器                                         │
│  - 读取二维码内容                                            │
│  - 调用 HIS 医保接口模块                                     │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  HIS 医保接口模块                                            │
│  - 调用医保"电子凭证核验"接口                                │
│  - 获取参保信息、待遇信息                                    │
│  - 缓存到本地会话                                            │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  医保系统                                                    │
│  - 校验电子凭证有效性                                        │
│  - 返回参保信息                                              │
└─────────────────────────────────────────────────────────────┘
```

**医保接口容错与重试策略**：

| 接口类型 | 容错策略 | 重试策略 |
|---|---|---|
| **身份核验** | 失败必须重试，不允许跳过 | 指数退避 3 次（1s/2s/4s） |
| **事前审核** | 失败可降级（医生手工审核） | 不自动重试，提示医生 |
| **费用明细上传** | 失败可异步重试 | 指数退避 5 次（1m/5m/30m/2h/12h） |
| **结算** | 失败必须重试 | 指数退避 3 次（1s/2s/4s） |
| **结算确认** | 失败必须人工介入 | 不自动重试，告警 |
| **结算撤销** | 失败必须人工介入 | 不自动重试，告警 |

**幂等设计**（与第5周支付幂等呼应）：

```java
// 医保接口幂等表
CREATE TABLE medical_insurance_idempotent (
  infid VARCHAR(64) PRIMARY KEY,         -- 唯一流水号
  infno VARCHAR(10),                     -- 交易编号
  biz_type VARCHAR(20),                  -- 业务类型（核验/上传/结算）
  biz_id VARCHAR(64),                    -- 业务 ID（就诊号/结算号）
  request_text TEXT,                     -- 请求报文
  response_text TEXT,                    -- 响应报文
  status VARCHAR(20),                    -- SUCCESS/FAIL/PENDING
  retry_count INT DEFAULT 0,
  created_at TIMESTAMP,
  updated_at TIMESTAMP,
  UNIQUE KEY uk_biz (biz_type, biz_id)   -- 业务唯一约束
);
```

> 架构师要点：医保接口与支付接口一样需要幂等设计。infid 是医保接口的幂等键，同一 infid 多次调用返回相同结果。HIS 侧必须用"业务唯一约束"避免同一笔业务多次发起医保调用。

#### 5. 与架构师水平的差距

| 维度 | 我的水平 | 架构师水平 | 差距 |
|---|---|---|---|
| **医保体系认知** | 知道国家-省-市三级架构，知道三大目录，未深读医保信息平台架构 | 能讲清国家医保信息平台的微服务架构、数据流转、跨省结算链路 | 需补足国家平台架构细节 |
| **接口规范** | 知道有 HOS 接口，未深读接口文档 | 能讲清 HOS 接口分类、报文格式、签名加密、幂等设计 | 需深读 HOS 接口规范 |
| **结算流程** | 知道三段式流程，未实践过完整结算 | 能落地完整三段式流程，处理异常场景（结算失败/撤销/退费） | 缺少实战经验 |
| **目录对照** | 知道需要对照，未实践过对照表设计 | 能设计目录对照表、批量对照工具、对照差异告警 | 缺少工程实践 |
| **异地就医** | 知道有异地就医直接结算，未深读流程 | 能讲清异地就医备案、跨省结算、费用清算链路 | 需补足跨省结算细节 |
| **DRG/DIP** | 知道概念，未深读对系统的影响 | 能讲清 DRG 入组、DIP 分值、对医院病案首页的影响 | 需补足 DRG/DIP 落地 |

---

## 题目二（工程实战题）：体检场景下的医保结算流程与目录对照

**业务背景**：

啄木鸟云健康承接某三甲医院的健康管理中心，提供体检业务。体检场景涉及多种付费模式：

```
1. 公卫体检：65 岁以上老年人免费体检（财政全额拨款，不走医保）
2. 商业体检：个人/企业付费（不走医保，走商业支付）
3. 医保体检：某些地区允许"特定体检项目"走医保个人账户（如公务员体检、慢病随访体检）
4. 混合体检：基础套餐公卫免费 + 加项个人支付（部分医保 + 部分自费）
```

**假设**：
- 该三甲医院是医保定点医院
- 当地医保允许"公务员体检"用医保个人账户支付
- 体检项目需对照医保诊疗项目目录
- 部分体检项目（如基因检测、PET-CT）医保不报销（自费）

请回答：

1. 体检业务的医保结算流程设计？如何区分"公卫免费"、"商业自费"、"医保个人账户"、"混合支付"四种付费模式？体检预约时如何判定该居民本次体检能否走医保？
2. 体检项目与医保诊疗项目目录的对照设计？体检套餐（如"公务员套餐"、"慢病随访套餐"）如何拆分为医保项目 + 自费项目？一个体检套餐（300 元）拆分后出现"部分医保 + 部分自费"，HIS 如何计费、医保如何结算？
3. 体检加项的实时医保审核？居民现场加项时如何实时调医保"事前审核"接口？加项后总价变化如何重新结算？加项已部分执行，能否撤销？
4. 体检退款场景？居民已结算后要求退款（如未做某项检查），如何调医保"结算撤销"接口？部分退款 vs 全额退款的处理差异？已开发票如何冲红？

### 作答区

#### 1. 体检业务医保结算流程设计

**四种付费模式判定矩阵**：

```
┌──────────────────────────────────────────────────────────────────┐
│  体检预约时的付费模式判定                                          │
│                                                                    │
│  入参：居民身份证 + 体检套餐 + 人群标签                            │
└──────────────────────────────────────────────────────────────────┘
                          │
                          ▼
            ┌─────────────────────────┐
            │  人群是否公卫覆盖？      │
            │  （65+/慢病/孕产妇等）   │
            └─────────────────────────┘
                  │           │
              是  │           │ 否
                  ▼           ▼
        ┌──────────────┐  ┌─────────────────────────┐
        │  公卫免费     │  │  是否公务员/慢病随访？   │
        │  FiscalOnly  │  └─────────────────────────┘
        └──────────────┘        │           │
                            是  │           │ 否
                                ▼           ▼
                    ┌──────────────────┐  ┌──────────────┐
                    │  医保个人账户     │  │  商业自费     │
                    │  InsurancePersonal│  │  Commercial │
                    └──────────────────┘  └──────────────┘
                                │
                                ▼
                ┌─────────────────────────┐
                │  是否有加项？           │
                └─────────────────────────┘
                    │           │
                是  │           │ 否
                    ▼           ▼
            ┌──────────────────┐  │
            │  混合支付         │  │
            │  Mixed           │  │
            └──────────────────┘  │
                                  ▼
                              纯医保 or 纯自费
```

**付费模式枚举设计**：

```java
public enum PaymentMode {
    FISCAL_ONLY("FiscalOnly", "公卫免费（财政全额）"),
    INSURANCE_PERSONAL("InsurancePersonal", "医保个人账户"),
    COMMERCIAL("Commercial", "商业自费"),
    MIXED("Mixed", "混合支付（医保+自费）");

    private String code;
    private String desc;
}

// 体检订单
public class ExamOrder {
    private Long orderId;
    private Long residentId;            // 居民 ID
    private String idCard;              // 身份证
    private String examPackageCode;     // 套餐编码
    private PaymentMode paymentMode;    // 付费模式
    
    // 拆分明细
    private BigDecimal totalAmount;     // 总金额
    private BigDecimal insuranceAmount; // 医保支付金额
    private BigDecimal personalAmount;  // 个人支付金额
    private BigDecimal fiscalAmount;    // 财政拨款金额
}
```

**预约时的医保资格判定**：

```java
@Service
public class ExamPaymentModeResolver {
    @Autowired private MedicalInsuranceClient miClient;
    
    public PaymentMode resolve(Resident resident, ExamPackage pkg) {
        // 1. 公卫覆盖人群 -> 公卫免费
        if (isPublicHealthCovered(resident)) {
            return PaymentMode.FISCAL_ONLY;
        }
        
        // 2. 非公卫人群，查询医保参保状态
        InsuranceInfo info = miClient.queryInsurance(resident.getIdCard());
        if (info == null || !info.isActive()) {
            // 未参保 -> 商业自费
            return PaymentMode.COMMERCIAL;
        }
        
        // 3. 检查套餐是否医保范围（公务员体检/慢病随访）
        if (!isPackageInsuranceCovered(pkg)) {
            return PaymentMode.COMMERCIAL;
        }
        
        // 4. 检查个人账户余额
        if (info.getPersonalAccountBalance().compareTo(pkg.getPrice()) >= 0) {
            return PaymentMode.INSURANCE_PERSONAL;
        }
        
        // 5. 余额不足，混合支付
        return PaymentMode.MIXED;
    }
    
    private boolean isPublicHealthCovered(Resident r) {
        // 65+、慢病、孕产妇、0-6 岁儿童等
        return r.getAge() >= 65 || r.hasChronicDisease() || r.isPregnant();
    }
    
    private boolean isPackageInsuranceCovered(ExamPackage pkg) {
        // 公务员体检、慢病随访体检可走医保个人账户
        return "CIVIL_SERVANT".equals(pkg.getCategory()) 
            || "CHRONIC_FOLLOWUP".equals(pkg.getCategory());
    }
}
```

**体检业务医保结算完整流程**：

```
T0: 居民预约体检
    - 选择套餐（公务员套餐 500 元）
    - 系统判定付费模式（InsurancePersonal）
    
T1: 体检当日登记
    - 扫医保电子凭证
    - 调医保"身份核验"接口
    - 调医保"待遇查询"接口
    - 确认个人账户余额 >= 500
    
T2: 体检项目对照医保目录
    - 套餐 500 元拆分为医保项目（450 元）+ 自费项目（50 元）
    - 上传医保"事前审核"
    
T3: 体检执行（按套餐项目检查）
    - 项目 A：身高体重（医保项目，0 元）
    - 项目 B：血压（医保项目，0 元）
    - 项目 C：血常规（医保项目，30 元）
    - 项目 D：B 超（医保项目，120 元）
    - 项目 E：CT（医保项目，300 元）
    - 项目 F：基因检测（自费项目，50 元）
    
T4: 体检完成，触发结算
    - 调医保"费用明细上传"
    - 调医保"结算"
        - 总费用 500 元
        - 自费 50 元（基因检测）
        - 医保个人账户支付 450 元
        - 个人支付 50 元
    - 调医保"结算确认"
    
T5: 商业支付（个人支付部分）
    - 微信/支付宝扫码 50 元
    
T6: 生成发票、打印结算单
    - 医保结算单（450 元）
    - 商业发票（50 元）
    - 电子票据上传医保平台
```

#### 2. 体检项目与医保诊疗项目目录对照设计

**目录对照表**：

```sql
CREATE TABLE exam_item_mi_mapping (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    exam_item_code VARCHAR(20) NOT NULL COMMENT '体检项目编码（本地）',
    exam_item_name VARCHAR(100) NOT NULL COMMENT '体检项目名称',
    mi_item_code VARCHAR(20) COMMENT '医保诊疗项目编码',
    mi_item_name VARCHAR(100) COMMENT '医保诊疗项目名称',
    mi_category VARCHAR(10) COMMENT '医保类别：甲/乙/丙/自费',
    self_pay_ratio DECIMAL(5,2) COMMENT '乙类自付比例',
    mi_price DECIMAL(10,2) COMMENT '医保支付限价',
    local_price DECIMAL(10,2) COMMENT '本地价格',
    status VARCHAR(10) DEFAULT 'ACTIVE',
    create_time DATETIME,
    update_time DATETIME,
    UNIQUE KEY uk_exam_item (exam_item_code),
    INDEX idx_mi_item (mi_item_code)
);

CREATE TABLE exam_package_item_split (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    package_id BIGINT NOT NULL COMMENT '套餐 ID',
    exam_item_code VARCHAR(20) NOT NULL COMMENT '体检项目编码',
    payment_type VARCHAR(20) NOT NULL COMMENT 'FISCAL/INSURANCE/COMMERCIAL',
    mi_item_code VARCHAR(20) COMMENT '医保项目编码（如 INSURANCE）',
    split_amount DECIMAL(10,2) NOT NULL COMMENT '拆分金额',
    INDEX idx_package (package_id)
);
```

**套餐拆分逻辑**：

```java
@Service
public class ExamPackageSplitter {
    @Autowired private ExamItemMiMappingMapper mappingMapper;
    
    public PackageSplitResult split(ExamPackage pkg) {
        PackageSplitResult result = new PackageSplitResult();
        result.setPackageId(pkg.getId());
        result.setTotalAmount(pkg.getPrice());
        
        for (ExamItem item : pkg.getItems()) {
            ExamItemMiMapping mapping = mappingMapper.findByExamItemCode(item.getCode());
            
            if (mapping == null || "SELF_PAY".equals(mapping.getMiCategory())) {
                // 未对照或自费项目
                result.addCommercialItem(item, mapping);
            } else {
                // 医保项目
                result.addInsuranceItem(item, mapping);
            }
        }
        
        // 计算汇总
        result.calculateSummary();
        return result;
    }
}

@Data
public class PackageSplitResult {
    private Long packageId;
    private BigDecimal totalAmount;
    
    private List<SplitItem> insuranceItems = new ArrayList<>();  // 医保项目
    private List<SplitItem> commercialItems = new ArrayList<>(); // 自费项目
    private List<SplitItem> fiscalItems = new ArrayList<>();     // 公卫免费项目
    
    private BigDecimal insuranceAmount = BigDecimal.ZERO;
    private BigDecimal commercialAmount = BigDecimal.ZERO;
    private BigDecimal fiscalAmount = BigDecimal.ZERO;
    
    public void calculateSummary() {
        insuranceAmount = insuranceItems.stream()
            .map(SplitItem::getAmount)
            .reduce(BigDecimal.ZERO, BigDecimal::add);
        commercialAmount = commercialItems.stream()
            .map(SplitItem::getAmount)
            .reduce(BigDecimal.ZERO, BigDecimal::add);
        fiscalAmount = fiscalItems.stream()
            .map(SplitItem::getAmount)
            .reduce(BigDecimal.ZERO, BigDecimal::add);
    }
}
```

**示例：公务员套餐 500 元拆分**：

| 项目 | 本地编码 | 医保编码 | 医保类别 | 本地价格 | 拆分类型 | 拆分金额 |
|---|---|---|---|---|---|---|
| 身高体重 | EXAM001 | MI001 | 甲类 | 0 | INSURANCE | 0 |
| 血压 | EXAM002 | MI002 | 甲类 | 0 | INSURANCE | 0 |
| 血常规 | EXAM003 | MI003 | 甲类 | 30 | INSURANCE | 30 |
| 尿常规 | EXAM004 | MI004 | 甲类 | 20 | INSURANCE | 20 |
| 肝功能 | EXAM005 | MI005 | 乙类（自付 5%） | 50 | INSURANCE | 50 |
| 肾功能 | EXAM006 | MI006 | 乙类（自付 5%） | 50 | INSURANCE | 50 |
| 血脂 | EXAM007 | MI007 | 乙类（自付 5%） | 50 | INSURANCE | 50 |
| B 超 | EXAM008 | MI008 | 乙类（自付 10%） | 120 | INSURANCE | 120 |
| 心电图 | EXAM009 | MI009 | 甲类 | 30 | INSURANCE | 30 |
| CT 胸部 | EXAM010 | MI010 | 乙类（自付 10%） | 150 | INSURANCE | 150 |
| 基因检测 | EXAM999 | (未对照) | - | 50 | COMMERCIAL | 50 |
| **合计** | | | | **500** | | **500** |

拆分结果：
- 医保项目金额：450 元
- 自费项目金额：50 元
- 医保个人账户支付：450 元（公务员体检走个人账户，不计算乙类自付，因个人账户支付不受乙类自付约束）
- 个人现金支付：50 元

**HIS 计费与医保结算协同**：

```java
@Service
public class ExamSettlementService {
    @Autowired private MedicalInsuranceClient miClient;
    @Autowired private CommercialPayService commercialPayService;
    
    @Transactional
    public SettlementResult settle(ExamOrder order) {
        // 1. 拆分套餐
        PackageSplitResult split = packageSplitter.split(order.getPackage());
        
        // 2. 上传医保费用明细（仅医保部分）
        if (split.getInsuranceAmount().compareTo(BigDecimal.ZERO) > 0) {
            MiUploadResponse uploadResp = miClient.uploadFeeDetail(
                order, split.getInsuranceItems());
            if (!uploadResp.isSuccess()) {
                throw new BizException("医保费用上传失败: " + uploadResp.getMsg());
            }
        }
        
        // 3. 调医保结算
        MiSettlementResponse miResp = null;
        if (split.getInsuranceAmount().compareTo(BigDecimal.ZERO) > 0) {
            miResp = miClient.settle(order, split);
            // 结算单
            // - 总费用 500
            // - 自费 50
            // - 个人账户支付 450
            // - 个人现金支付 50
        }
        
        // 4. 商业支付（个人现金部分）
        PayResult payResult = null;
        if (split.getCommercialAmount().compareTo(BigDecimal.ZERO) > 0) {
            payResult = commercialPayService.collect(
                order, split.getCommercialAmount());
        }
        
        // 5. 调医保结算确认
        if (miResp != null) {
            miClient.confirmSettlement(order, miResp.getSettlementId());
        }
        
        // 6. 生成发票
        Invoice invoice = invoiceService.generate(order, split, miResp, payResult);
        
        return SettlementResult.success(order, miResp, payResult, invoice);
    }
}
```

#### 3. 体检加项的实时医保审核

**加项场景流程**：

```
T0: 居民已完成基础套餐结算（500 元，医保 450 + 自费 50）
T1: 居民临时决定加项"肿瘤标志物 12 项"（200 元，医保项目）
T2: 加项"基因检测"（100 元，自费项目）
```

**加项实时审核**：

```java
@Service
public class ExamAddItemService {
    @Autowired private MedicalInsuranceClient miClient;
    
    public AddItemResult addItem(ExamOrder order, ExamItem newItem) {
        // 1. 查项目对照
        ExamItemMiMapping mapping = mappingMapper.findByExamItemCode(newItem.getCode());
        
        // 2. 医保项目 -> 调事前审核
        if (mapping != null && !"SELF_PAY".equals(mapping.getMiCategory())) {
            MiPreAuditRequest req = new MiPreAuditRequest();
            req.setVisitId(order.getVisitId());
            req.setItemCode(mapping.getMiItemCode());
            req.setQuantity(newItem.getQuantity());
            
            MiPreAuditResponse resp = miClient.preAudit(req);
            if (!resp.isApproved()) {
                // 审核不通过，提示医生/居民
                throw new BizException("医保事前审核不通过: " + resp.getReason());
            }
        }
        
        // 3. 加入订单
        order.addExtraItem(newItem, mapping);
        
        return AddItemResult.success(newItem);
    }
}
```

**加项后重新结算**：

```text
方案 A：合并结算（推荐）
- 加项不立即结算，标记为"加项未结算"
- 体检全部完成后，统一结算（原 500 + 加项 300 = 800）
- 医保结算 750（450 + 300），自费 50

方案 B：分次结算
- 加项立即单独结算
- 第一次结算：医保 450 + 自费 50
- 第二次结算：医保 300（加项 300 全医保）
- 缺点：两次结算单，两次发票，患者体验差

方案 C：撤销重结
- 撤销第一次结算
- 合并后重新结算
- 缺点：撤销有风险（已拨付无法撤销）
```

**推荐方案 A 的实现**：

```java
@Service
public class ExamSettlementService {
    
    public AddItemResult addItem(ExamOrder order, ExamItem item) {
        // 1. 事前审核（仅医保项目）
        if (item.isInsurance()) {
            miClient.preAudit(order.getVisitId(), item);
        }
        
        // 2. 标记加项（不立即结算）
        order.addExtraItem(item);
        order.setStatus(OrderStatus.EXAMINING);  // 体检中
        order.setSettlementStatus(SettlementStatus.PENDING_ADD);  // 待重新结算
        orderRepo.save(order);
        
        return AddItemResult.success(item);
    }
    
    public SettlementResult settle(ExamOrder order) {
        // 检查是否已结算
        if (order.getSettlementStatus() == SettlementStatus.SETTLED) {
            throw new BizException("订单已结算，请走撤销重结流程");
        }
        
        // 重新拆分（基础套餐 + 加项）
        PackageSplitResult split = packageSplitter.splitWithExtras(order);
        
        // 走正常结算流程...
    }
}
```

**加项已部分执行的撤销**：

| 加项状态 | 能否撤销 | 处理 |
|---|---|---|
| 已加入订单，未执行 | 可撤销 | 直接移除加项 |
| 已执行部分（如抽血，未出结果） | 部分撤销 | 撤销未执行部分，已执行部分保留 |
| 已全部执行（出结果） | 不可撤销 | 走退款流程（结算后退款） |

#### 4. 体检退款场景

**全额退款流程**：

```
T0: 居民已结算（医保 450 + 自费 50）
T1: 居民要求全额退款（未做任何检查）

T2: HIS 调医保"结算撤销"接口
    - 入参：原医保结算流水号
    - 出参：撤销成功/失败
T3: 撤销成功，HIS 调商业支付"退款"
    - 微信原路退款 50 元
T4: HIS 生成红冲发票
    - 冲红原电子票据
T5: HIS 更新订单状态为"已退款"
```

**部分退款流程**：

```
T0: 居民已结算（医保 450 + 自费 50）
T1: 居民要求退 CT（150 元，医保项目）

T2: HIS 调医保"结算撤销"接口（撤销原结算）
T3: HIS 重新计算费用
    - 总费用 500 - 150 = 350
    - 医保 450 - 150 = 300
    - 自费 50
T4: HIS 调医保"重新结算"
    - 医保 300 + 自费 50
T5: HIS 退商业支付差价
    - 微信退款 0 元（自费部分未变）
    - 但医保多扣的 150 需要退到居民医保账户
T6: HIS 生成新发票 + 冲红原发票
```

**关键问题：医保结算撤销的限制**：

| 场景 | 能否撤销 | 处理 |
|---|---|---|
| 当日撤销 | 可撤销 | HIS 调"结算撤销"接口，医保自动冲正 |
| 当月撤销（次日-月底） | 可撤销 | HIS 调"结算撤销"，需医保审核 |
| 跨月撤销 | **不可撤销** | 已拨付给医院，需走"医保退费"流程，由医院向医保申请退费 |
| 已冲红发票 | 不可撤销 | 发票已红冲的，原结算不能撤销，需重新开具 |

**Java 实现**：

```java
@Service
public class ExamRefundService {
    @Autowired private MedicalInsuranceClient miClient;
    @Autowired private CommercialPayService commercialPayService;
    
    @Transactional
    public RefundResult refund(ExamOrder order, RefundRequest req) {
        // 1. 校验是否可撤销
        RefundCheckResult check = checkRefundable(order, req);
        if (!check.isRefundable()) {
            throw new BizException(check.getReason());
        }
        
        // 2. 判断全额 vs 部分退款
        boolean isFullRefund = req.isFullRefund();
        
        if (isFullRefund) {
            return fullRefund(order);
        } else {
            return partialRefund(order, req);
        }
    }
    
    private RefundResult fullRefund(ExamOrder order) {
        // 1. 调医保结算撤销
        MiRevokeResponse miResp = miClient.revokeSettlement(
            order.getMiSettlementId());
        
        if (!miResp.isSuccess()) {
            if ("ALREADY_PAID".equals(miResp.getErrorCode())) {
                // 已拨付，走医保退费流程
                return applyMiManualRefund(order);
            }
            throw new BizException("医保结算撤销失败: " + miResp.getMsg());
        }
        
        // 2. 商业支付退款
        if (order.getCommercialPayAmount().compareTo(BigDecimal.ZERO) > 0) {
            commercialPayService.refund(order.getPayId(), 
                order.getCommercialPayAmount());
        }
        
        // 3. 发票冲红
        invoiceService.redInvoice(order.getInvoiceId());
        
        // 4. 更新订单状态
        order.setStatus(OrderStatus.REFUNDED);
        order.setRefundTime(LocalDateTime.now());
        orderRepo.save(order);
        
        return RefundResult.success(order);
    }
    
    private RefundResult partialRefund(ExamOrder order, RefundRequest req) {
        // 1. 调医保结算撤销
        MiRevokeResponse miResp = miClient.revokeSettlement(
            order.getMiSettlementId());
        
        // 2. 重新计算费用
        BigDecimal newInsuranceAmount = order.getInsuranceAmount()
            .subtract(req.getRefundInsuranceAmount());
        BigDecimal newCommercialAmount = order.getCommercialAmount();
        // 自费部分一般不退（除非整项退）
        
        // 3. 重新医保结算
        MiSettlementResponse newMiResp = miClient.settle(order, 
            newInsuranceAmount, newCommercialAmount);
        
        // 4. 商业支付差价退款（如有）
        if (req.getRefundCommercialAmount().compareTo(BigDecimal.ZERO) > 0) {
            commercialPayService.refund(order.getPayId(), 
                req.getRefundCommercialAmount());
        }
        
        // 5. 发票冲红 + 重开
        invoiceService.redInvoice(order.getInvoiceId());
        Invoice newInvoice = invoiceService.generate(order, newMiResp);
        
        return RefundResult.success(order);
    }
    
    private RefundCheckResult checkRefundable(ExamOrder order, RefundRequest req) {
        RefundCheckResult result = new RefundCheckResult();
        
        // 1. 订单状态校验
        if (order.getStatus() != OrderStatus.SETTLED) {
            result.setRefundable(false);
            result.setReason("订单状态非已结算");
            return result;
        }
        
        // 2. 是否跨月
        if (order.getSettleTime().getMonth() != LocalDateTime.now().getMonth()) {
            result.setRefundable(false);
            result.setReason("跨月不能撤销，需走医保退费流程");
            return result;
        }
        
        // 3. 是否已开发票
        if (order.getInvoiceStatus() == InvoiceStatus.ISSUED) {
            // 需先冲红
            result.setRequireRedInvoice(true);
        }
        
        result.setRefundable(true);
        return result;
    }
}
```

#### 5. 与架构师水平的差距

| 维度 | 我的水平 | 架构师水平 | 差距 |
|---|---|---|---|
| **付费模式设计** | 能想到公卫/商业/医保/混合四种 | 能设计付费模式判定矩阵 + 订单模型 + 状态机 | 缺少状态机设计经验 |
| **目录对照** | 知道需要对照，未实践过 | 能设计目录对照表 + 批量对照工具 + 差异告警 | 缺少工程实践 |
| **加项实时审核** | 知道调事前审核 | 能设计合并结算/分次结算/撤销重结三种方案，权衡选型 | 缺少方案对比能力 |
| **退款场景** | 知道有撤销接口 | 能处理全额/部分退款、跨月退费、发票冲红等复杂场景 | 缺少复杂场景实战 |
| **幂等设计** | 第5周已掌握支付幂等 | 能将支付幂等迁移到医保场景 | 可复用经验 |

---

## 题目三（选型权衡题）：医保电子凭证、移动支付、商保直付的混合支付方案

**业务背景**：

啄木鸟云健康承接某互联网医院的"在线问诊 + 开方 + 用药"业务。该业务的支付链路涉及：

```
1. 在线问诊费：医生定价 50-200 元（部分可走医保，部分自费）
2. 处方药品费：医保药品 + 自费药品混合
3. 配送费：物流费（自费）
4. 商业保险直付：与平安健康险、众安在线合作，部分商保用户可直付
```

**约束**：
- 必须支持医保电子凭证扫码支付
- 必须支持微信/支付宝移动支付
- 必须支持商保直付（用户授权后，商保公司直接付款）
- 用户一次支付可能同时使用多种支付方式（医保 + 商保 + 自费）

请回答：

1. 混合支付架构设计？如何设计"支付方式编排"，让一次订单可以同时使用医保个人账户、商保直付、微信/支付宝？三种支付的优先级如何设定？支付失败的回滚策略？
2. 医保电子凭证在互联网医院场景的应用？线上问诊如何核验医保身份？处方药品配送（O2O/B2C）如何走医保？国家"互联网+医保"政策允许的诊疗场景有哪些？
3. 商保直付的对接设计？如何与平安健康险、众安在线等商保公司对接？商保直付的授权流程（用户授权->商保审核->直付）？商保拒付后的兜底（用户自付）？
4. 三种支付的协同与对账？医保结算单、商保直付凭证、商业支付订单如何在 HIS 中合并？T+1 对账时三方对账的差异如何处理？商保拒付但已发货的药品如何追回？

### 作答区

#### 1. 混合支付架构设计

**支付方式编排**：

```
┌──────────────────────────────────────────────────────────────────┐
│  混合支付编排器（Payment Orchestrator）                           │
│                                                                    │
│  入参：订单 + 用户选择的支付方式列表                                │
│  出参：支付结果（每种的支付状态 + 总支付结果）                     │
└──────────────────────────────────────────────────────────────────┘
                          │
                          ▼
            ┌─────────────────────────┐
            │  1. 计算支付优先级       │
            │  医保 -> 商保 -> 自费    │
            └─────────────────────────┘
                          │
                          ▼
            ┌─────────────────────────┐
            │  2. 按优先级拆分金额     │
            │  医保支付 X 元           │
            │  商保支付 Y 元           │
            │  自费 Z 元               │
            └─────────────────────────┘
                          │
                          ▼
            ┌─────────────────────────┐
            │  3. 顺序调用支付渠道    │
            │  - 调医保结算           │
            │  - 调商保直付           │
            │  - 调商业支付           │
            └─────────────────────────┘
                          │
                          ▼
            ┌─────────────────────────┐
            │  4. 任一失败 -> 回滚    │
            │  - 医保结算撤销         │
            │  - 商保直付撤销         │
            │  - 商业支付退款         │
            └─────────────────────────┘
                          │
                          ▼
            ┌─────────────────────────┐
            │  5. 全部成功 -> 完成    │
            │  - 生成统一支付凭证     │
            │  - 通知业务             │
            └─────────────────────────┘
```

**支付方式优先级**：

| 优先级 | 支付方式 | 原因 |
|---|---|---|
| 1 | 医保个人账户 | 报销比例最高，用户首选 |
| 2 | 商保直付 | 商保公司承担，用户无需现金 |
| 3 | 微信/支付宝 | 用户自费，兜底 |

**金额拆分示例**：

```
订单：在线问诊 100 元 + 处方药品 300 元 + 配送费 20 元 = 420 元

医保覆盖：
- 问诊费医保部分：50 元（部分医保）
- 处方药品医保部分：200 元（甲类 100% + 乙类 80%）
- 配送费：0 元（医保不覆盖）
小计：250 元

商保覆盖：
- 问诊费商保部分：50 元
- 处方药品商保部分：50 元（剩余乙类自付）
- 配送费：0 元
小计：100 元

自费：
- 配送费：20 元
- 处方药品自费部分：50 元（如进口药）
小计：70 元

总计：250 + 100 + 70 = 420 元 ✓
```

**Java 实现（支付编排器）**：

```java
@Service
public class MixedPaymentOrchestrator {
    @Autowired private MedicalInsuranceClient miClient;
    @Autowired private CommercialInsuranceClient ciClient;
    @Autowired private CommercialPayService cpService;
    
    @Transactional
    public PaymentResult pay(Order order, PaymentPlan plan) {
        // 1. 校验金额拆分
        if (!plan.validateAmount(order.getTotalAmount())) {
            throw new BizException("金额拆分校验失败");
        }
        
        PaymentResult result = new PaymentResult();
        List<ExecutedPayment> executed = new ArrayList<>();
        
        try {
            // 2. 按优先级顺序调用
            if (plan.getMiAmount().compareTo(BigDecimal.ZERO) > 0) {
                MiPaymentResult miResult = miClient.pay(order, plan.getMiAmount());
                executed.add(new ExecutedPayment("MI", miResult));
                result.setMiResult(miResult);
            }
            
            if (plan.getCiAmount().compareTo(BigDecimal.ZERO) > 0) {
                CiPaymentResult ciResult = ciClient.pay(order, plan.getCiAmount());
                executed.add(new ExecutedPayment("CI", ciResult));
                result.setCiResult(ciResult);
            }
            
            if (plan.getCpAmount().compareTo(BigDecimal.ZERO) > 0) {
                CpPaymentResult cpResult = cpService.pay(order, plan.getCpAmount());
                executed.add(new ExecutedPayment("CP", cpResult));
                result.setCpResult(cpResult);
            }
            
            // 3. 全部成功
            result.setSuccess(true);
            return result;
            
        } catch (Exception e) {
            // 4. 任一失败 -> 回滚已执行的支付
            rollback(executed);
            result.setSuccess(false);
            result.setErrorMsg(e.getMessage());
            return result;
        }
    }
    
    private void rollback(List<ExecutedPayment> executed) {
        // 逆序回滚
        Collections.reverse(executed);
        for (ExecutedPayment ep : executed) {
            try {
                switch (ep.getType()) {
                    case "MI":
                        miClient.revoke(ep.getResult().getSettlementId());
                        break;
                    case "CI":
                        ciClient.refund(ep.getResult().getPayId());
                        break;
                    case "CP":
                        cpService.refund(ep.getResult().getPayId());
                        break;
                }
            } catch (Exception e) {
                // 记录失败，人工介入
                log.error("支付回滚失败: type={}, id={}", 
                    ep.getType(), ep.getResult().getPayId(), e);
                alertService.alert("支付回滚失败，需人工介入: " + ep);
            }
        }
    }
}
```

**支付失败的回滚策略**：

| 失败环节 | 回滚策略 | 风险 |
|---|---|---|
| 医保结算失败 | 不需回滚（医保未扣款） | 无 |
| 商保直付失败 | 撤销医保结算 | 医保撤销可能失败（已拨付） |
| 商业支付失败 | 撤销医保 + 撤销商保 | 商保撤销可能失败（已清算） |
| 全部成功但订单创建失败 | 撤销全部 | 全部撤销可能失败 |

> 架构师要点：混合支付的回滚是分布式事务问题，不能用强一致性的 XA 事务（医保/商保/支付是不同系统），必须用**Saga 模式** + **补偿事务** + **人工兜底**。

#### 2. 医保电子凭证在互联网医院场景的应用

**互联网医院医保场景**：

```
┌──────────────────────────────────────────────────────────────────┐
│  互联网医院医保业务                                                │
│                                                                    │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐│
│  │ 复诊开方         │  │ 慢病随访         │  │ 在线购药         ││
│  │ (部分统筹)       │  │ (个人账户)       │  │ (个人账户)       ││
│  └──────────────────┘  └──────────────────┘  └──────────────────┘│
│                                                                    │
│  ┌──────────────────────────────────────────────────────────────┐│
│  │ 国家"互联网+医保"政策允许的诊疗场景：                        ││
│  │ 1. 复诊（同医生 2 周内复诊，可走医保）                       ││
│  │ 2. 慢病随访（高血压/糖尿病等 12 种慢病）                     ││
│  │ 3. 处方流转（线上开方，定点药店取药/配送）                   ││
│  │ 不允许：首诊、急诊、手术、住院                                ││
│  └──────────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────┘
```

**线上问诊医保身份核验流程**：

```
T0: 用户在互联网医院 APP 选择"在线问诊"
T1: 用户授权医保电子凭证（OAuth2）
    - 跳转医保电子凭证小程序
    - 用户授权后返回授权码
T2: 互联网医院后端调医保"线上身份核验"
    - 入参：授权码
    - 出参：参保信息、待遇享受、个人账户余额
T3: 判定该次问诊是否医保范围
    - 是否复诊（同医生 2 周内复诊）
    - 是否慢病随访（用户有慢病标签）
T4: 问诊完成后医保结算
    - 调医保"互联网+医保结算"接口
    - 个人账户支付问诊费
T5: 开方后药品配送
    - 处方上传医保
    - 用户授权后，定点药店发药
    - 医保个人账户支付药品费
```

**处方药品配送医保结算**：

```
┌──────────────────────────────────────────────────────────────────┐
│  处方流转医保结算流程                                              │
└──────────────────────────────────────────────────────────────────┘

T0: 互联网医院医生在线开方
    - 处方上传医保系统审核
    - 医保审核通过

T1: 用户选择购药方式
    - 选项 A：到店自取（定点药店）
    - 选项 B：B2C 配送（快递）
    - 选项 C：O2O 配送（达达/顺丰）

T2: 用户授权医保支付
    - 调医保"处方流转"接口
    - 用户在 APP 确认

T3: 医保计算支付
    - 医保药品：医保支付
    - 自费药品：自费

T4: 定点药店发药
    - 药店 HIS 接收处方
    - 调医保"药店结算"接口
    - 用户支付自费部分

T5: 配送（如选 B/C）
    - 物流出库
    - 用户签收
```

**关键约束（国家"互联网+医保"政策）**：

| 约束 | 说明 |
|---|---|
| 仅限复诊 | 首诊不能走医保（必须线下） |
| 慢病随访 | 12 种慢病（高血压、糖尿病、冠心病等） |
| 处方流转 | 必须定点药店，处方上传医保审核 |
| 配送限制 | 处方药必须本人签收，冷链药品限区域内配送 |
| 累计限额 | 互联网医院医保支付计入年度累计限额 |

#### 3. 商保直付的对接设计

**商保直付架构**：

```
┌──────────────────────────────────────────────────────────────────┐
│  互联网医院后端                                                    │
│                                                                    │
│  ┌─────────────────────────────────────────────┐                  │
│  │  商保直付模块                                │                  │
│  │  - 用户授权                                  │                  │
│  │  - 商保预审核                                │                  │
│  │  - 商保直付                                  │                  │
│  │  - 商保对账                                  │                  │
│  └─────────────────────────────────────────────┘                  │
└──────────────────────────────────────────────────────────────────┘
                          │
                          │  HTTPS + 签名
                          ▼
        ┌─────────────────────────────────────────┐
        │  商保公司 API 网关                       │
        │  - 平安健康险                            │
        │  - 众安在线                              │
        │  - 太平洋保险                            │
        │  - 中国人寿                              │
        └─────────────────────────────────────────┘
```

**商保直付授权流程**：

```
T0: 用户在 APP 选择"商保直付"
T1: APP 弹出商保授权页
    - 展示商保公司列表（平安/众安/...）
    - 用户选择"平安健康险"

T2: APP 跳转平安健康险授权页
    - 用户登录平安 APP
    - 平安展示授权范围（订单信息、金额、诊疗记录）
    - 用户确认授权

T3: 平安回调互联网医院
    - 返回授权码

T4: 互联网医院后端调平安 API
    - 入参：授权码 + 订单信息
    - 平安预审核（是否在保障范围）

T5: 平安返回预审核结果
    - 通过：可直付 X 元
    - 拒绝：超保障范围 / 保单失效

T6: 互联网医院发起直付
    - 平安直接付款给医院
    - 互联网医院收到支付成功通知
```

**商保直付 Java 实现**：

```java
@Service
public class CommercialInsuranceService {
    @Autowired private PingAnClient pingAnClient;
    @Autowired private ZhongAnClient zhongAnClient;
    
    public CiAuthResult auth(Long userId, String ciCompany, Order order) {
        CiClient client = getCiClient(ciCompany);
        
        // 1. 调授权接口
        CiAuthResponse resp = client.auth(userId, order);
        
        if (!resp.isApproved()) {
            return CiAuthResult.reject(resp.getReason());
        }
        
        return CiAuthResult.success(resp.getAuthCode(), resp.getMaxAmount());
    }
    
    public CiPayResult pay(Order order, String ciCompany, BigDecimal amount) {
        CiClient client = getCiClient(ciCompany);
        
        // 2. 调直付接口
        CiPayRequest req = new CiPayRequest();
        req.setOrderId(order.getId());
        req.setAmount(amount);
        req.setAuthCode(order.getCiAuthCode());
        req.setMedicalRecords(order.getMedicalRecords());  // 诊疗记录
        
        CiPayResponse resp = client.pay(req);
        
        if (!resp.isSuccess()) {
            throw new BizException("商保直付失败: " + resp.getMsg());
        }
        
        return CiPayResult.success(resp.getPayId(), resp.getPayTime());
    }
    
    public CiRefundResult refund(String payId, BigDecimal amount) {
        // 商保拒付后的退款
        // ...
    }
    
    private CiClient getCiClient(String ciCompany) {
        switch (ciCompany) {
            case "PINGAN": return pingAnClient;
            case "ZHONGAN": return zhongAnClient;
            default: throw new BizException("不支持的商保公司");
        }
    }
}
```

**商保拒付后的兜底**：

```java
@Service
public class CommercialInsuranceService {
    
    public CiPayResult payWithFallback(Order order, BigDecimal amount) {
        try {
            // 1. 尝试商保直付
            return pay(order, order.getCiCompany(), amount);
            
        } catch (CiRejectException e) {
            // 2. 商保拒付，转自费
            log.warn("商保拒付，转自费: orderId={}, reason={}", 
                order.getId(), e.getReason());
            
            // 3. 通知用户
            notificationService.notifyUser(order.getUserId(), 
                "商保拒付：" + e.getReason() + "，已转自费");
            
            // 4. 调商业支付
            CpPaymentResult cpResult = cpService.pay(order, amount);
            
            return CiPayResult.fallbackToCp(cpResult);
        }
    }
}
```

#### 4. 三种支付的协同与对账

**统一支付凭证**：

```java
@Data
public class UnifiedPaymentVoucher {
    private String voucherNo;           // 统一支付凭证号
    private Long orderId;
    private BigDecimal totalAmount;     // 总金额
    
    // 三方支付明细
    private MiPaymentDetail miDetail;   // 医保支付
    private CiPaymentDetail ciDetail;   // 商保直付
    private CpPaymentDetail cpDetail;   // 商业支付
    
    // 状态
    private String status;              // SUCCESS/PARTIAL/FAILED
    private LocalDateTime payTime;
}

@Data
public class MiPaymentDetail {
    private String settlementId;        // 医保结算流水号
    private BigDecimal amount;
    private String insutype;            // 险种
    private String personalAccountPay;  // 个人账户支付
    private String overallPay;          // 统筹支付
}

@Data
public class CiPaymentDetail {
    private String payId;               // 商保支付流水号
    private String ciCompany;           // 商保公司
    private BigDecimal amount;
}

@Data
public class CpPaymentDetail {
    private String payId;               // 商业支付流水号
    private String channel;             // 微信/支付宝
    private BigDecimal amount;
}
```

**T+1 三方对账**：

```
┌──────────────────────────────────────────────────────────────────┐
│  T+1 三方对账                                                      │
│                                                                    │
│  数据源：                                                          │
│  1. HIS 本地订单数据                                               │
│  2. 医保对账文件（T 日所有结算记录）                                │
│  3. 商保对账文件（T 日所有直付记录）                                │
│  4. 商业支付对账文件（微信/支付宝 T 日所有交易）                    │
│                                                                    │
│  对账逻辑：                                                        │
│  Step 1: HIS 订单 vs 医保对账                                      │
│    - 医保结算金额一致 ✓                                            │
│    - 差异：HIS 有订单，医保无结算 -> 单边账                         │
│    - 差异：医保有结算，HIS 无订单 -> 反向单边账                     │
│                                                                    │
│  Step 2: HIS 订单 vs 商保对账                                      │
│    - 商保直付金额一致 ✓                                            │
│    - 差异：商保拒付但 HIS 已发货 -> 需追回                          │
│                                                                    │
│  Step 3: HIS 订单 vs 商业支付对账                                  │
│    - 商业支付金额一致 ✓                                            │
│    - 差异：支付成功但 HIS 订单失败 -> 退款                          │
│                                                                    │
│  Step 4: 三方汇总对账                                              │
│    - HIS 总收入 = 医保支付 + 商保直付 + 商业支付                    │
│    - 总账平衡 ✓                                                    │
└──────────────────────────────────────────────────────────────────┘
```

**对账差错处理**：

| 差错类型 | 处理策略 | 责任方 |
|---|---|---|
| HIS 有订单，医保无结算 | 调医保查询，必要时补结算 | HIS |
| 医保有结算，HIS 无订单 | 调医保结算撤销，退款给医保 | 医院财务 |
| 商保拒付但已发货 | 联系用户补款，或追回药品 | 客服 + 物流 |
| 商业支付多扣 | 退款给用户 | 商业支付运营 |
| 商业支付少扣 | 联系用户补款 | 客服 |
| 三方总账不平 | 人工核差，财务介入 | 财务 |

**商保拒付但已发货的追回流程**：

```java
@Service
public class CiRefundRecoveryService {
    
    @Scheduled(cron = "0 0 8 * * ?")  // 每日 8 点
    public void scanCiRefusedOrders() {
        // 1. 扫描昨日商保拒付订单
        List<Order> refusedOrders = orderRepo.findYesterdayCiRefused();
        
        for (Order order : refusedOrders) {
            // 2. 判断药品是否已签收
            if (order.getDeliveryStatus() == DeliveryStatus.SIGNED) {
                // 已签收 -> 联系用户补款
                contactUserForPayment(order);
            } else if (order.getDeliveryStatus() == DeliveryStatus.IN_TRANSIT) {
                // 配送中 -> 召回
                recallDelivery(order);
            } else if (order.getDeliveryStatus() == DeliveryStatus.PENDING) {
                // 待发货 -> 取消发货
                cancelDelivery(order);
            }
        }
    }
    
    private void contactUserForPayment(Order order) {
        // 1. APP 推送
        notificationService.notifyUser(order.getUserId(), 
            "您的商保支付未通过，请于 3 日内完成支付 100 元");
        
        // 2. 短信
        smsService.send(order.getUserPhone(), 
            "【XX 互联网医院】您的订单 " + order.getId() + " 商保拒付，请于 3 日内支付");
        
        // 3. 3 日后未支付 -> 电话催收
        scheduler.schedule(() -> phoneCollect(order), 3, TimeUnit.DAYS);
    }
    
    private void recallDelivery(Order order) {
        // 调物流召回
        logisticsService.recall(order.getDeliveryId());
        order.setDeliveryStatus(DeliveryStatus.RECALLED);
        orderRepo.save(order);
    }
}
```

#### 5. 与架构师水平的差距

| 维度 | 我的水平 | 架构师水平 | 差距 |
|---|---|---|---|
| **混合支付编排** | 知道 Saga 模式（第5周支付专题） | 能落地 Saga + 补偿事务 + 人工兜底 | 缺少多渠道混合支付实战 |
| **互联网医院医保** | 知道"互联网+医保"政策框架 | 能落地复诊/慢病随访/处方流转完整链路 | 缺少政策细节落地 |
| **商保直付** | 知道有商保直付，未实践过 | 能对接平安/众安等多家商保，设计授权/直付/拒付兜底 | 缺少商保对接经验 |
| **三方对账** | 第5周掌握双方对账 | 能扩展到三方对账，处理商保拒付追回 | 缺少三方对账实战 |
| **拒付追回** | 未考虑过此场景 | 能设计已签收/配送中/待发货三种召回策略 | 缺少拒付追回经验 |

---

## 本日总结

### 核心知识点

1. **医保体系全景**：国家-省-市三级架构，三大基础数据库（目录/定点/参保），HIS 与医保的边界
2. **HIS 医保接口模块**：9 个子模块（身份核验/目录对照/事前审核/费用上传/结算/撤销/对账/异地/DRG）
3. **三段式结算流程**：挂号登记（同步）-> 就诊计费（事前同步+上传异步）-> 结算（同步）
4. **医保业务编码**：ICD-10 诊断 / ICD-9-CM-3 手术 / 药品 / 耗材 / 服务项目
5. **目录对照机制**：医院本地目录 ↔ 医保目录，未对照不报销
6. **体检场景应用**：四种付费模式判定、套餐拆分、加项实时审核、退款撤销
7. **互联网医院医保**：复诊/慢病随访/处方流转，线上身份核验
8. **混合支付编排**：医保 -> 商保 -> 自费的优先级，Saga 补偿事务
9. **三方对账**：HIS + 医保 + 商保 + 商业支付的总账平衡
10. **拒付追回**：已签收/配送中/待发货三种召回策略

### 与架构师水平的整体差距

| 维度 | 当前水平 | 架构师水平 | 补足路径 |
|---|---|---|---|
| **医保体系认知** | 知道框架，未深读 | 能讲清国家平台架构 + 跨省结算链路 | 深读国家医保信息平台文档 |
| **接口规范** | 知道有 HOS，未深读 | 能落地完整接口对接 + 幂等设计 | 深读 HOS 接口文档 |
| **结算流程** | 知道三段式 | 能落地完整流程 + 异常处理 | 实践医保结算对接 |
| **目录对照** | 知道概念 | 能设计对照工具 + 差异告警 | 实践目录对照工程 |
| **混合支付** | 知道 Saga | 能落地多渠道混合 + 三方对账 | 实践混合支付编排 |
| **互联网医院医保** | 知道政策框架 | 能落地完整链路 | 实践互联网+医保 |
| **商保直付** | 知道概念 | 能对接多家商保 + 拒付兜底 | 实践商保对接 |

### 跳槽价值

Day05 医保对接是医疗信息化架构师的**硬实力**：
- 三甲医疗信息化公司（卫宁、东软、创业慧康）的**核心模块**之一
- 与第5周支付专题形成"医疗+支付"复合能力
- 国内医疗行业**独有**的接口规范（与 HL7/FHIR 体系完全独立）
- 跳槽到更好医疗公司的**加分项**

---

## 明日预告

Day06 将以"智慧体检全链路架构设计"为场景，把 Day01-Day05 的知识点全部用上：
- Day01 智慧体检业务架构
- Day02 HIS/EMR 对接
- Day03 HL7/FHIR 互操作性
- Day04 DICOM/PACS 影像
- Day05 医保对接

完成一个完整的"多机构、多人群、多付费模式、多设备、多标准"的智慧体检平台架构设计。