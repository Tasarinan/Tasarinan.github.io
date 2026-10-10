# 架构师学习-Day05-实战综合-启动提速与Bean故障排查

> 日期：2026年09月11日（周五）
> 周主题：Spring 核心源码第1周 - IoC 容器启动流程 / Bean 生命周期与扩展点 / 循环依赖三级缓存 / AOP 与动态代理 / 实战综合
> 出题日：Day05 - 实战综合（Day01-04 知识的实战收口）

---

## 背景

前四天完成了 Spring 核心源码的四大支柱：容器启动（Day01）、Bean 生命周期（Day02）、循环依赖（Day03）、AOP 代理（Day04）。今天全部收口到**两个生产实战场景**：

1. **启动提速**——Day01 第 5 问给方法论（度量→分层施策→发布窗口换算），今天把方法论落地成问诊系统的完整案例
2. **Bean 故障排查**——Day02 生命周期、Day04 失效地图在事故里的综合应用：启动失败（三类报错）与运行期失效（资损事故 STAR）

架构师面试的 Spring 高区分度题从来不是"你懂多少源码"，而是：

> "你们服务启动要多久？为什么？怎么治的？发布窗口怎么算？"
> "启动报 BeanCurrentlyInCreationException / NoSuchBeanDefinitionException，你的排查路径是什么？"
> "讲一个 Spring 相关的生产事故，从发现到防复发。"

**实战题的设计**：四个场景全部挂在**在线问诊系统**（简历核心项目）上，每个场景要求：现象 → 排查路径（用哪天学的什么工具/机制）→ 根因 → 修复 → 防复发 → 简历表达。Day06 串联复盘会把场景 2、3 合并成一次"发布三连事故"的完整叙事。

**与往周专题的衔接点**：

- **JVM 第2周诊断工具链**：启动排查的武器（jcmd、JFR、async-profiler 火焰图）与本周的 Spring 工具（/actuator/startup、条件评估报告）是**同一诊断方法论的两层**——进程级 vs 框架级
- **Netty 周 Day05-06**：连接迁移 drain、优雅停机——今天场景 1 的发布窗口账再次与之咬合
- **支付周对账**：场景 3 的静默失效靠对账发现——对账是"失效地图所有条目的兜底防线"
- **K8s 周 Day02 发布工程**：场景 1 的最终收益换算（startupProbe/发布窗口/回滚）

---

## 热身题（URL 全链路——四周热身题的收口）

### 热身题：浏览器输入 URL 到页面展示，中间发生了什么（串联版）

这道八股是把 Day01-04 全部热身题串成一条链的收口题。按请求的一生推进，每个环节标注本周往日的知识锚点：

```
1. URL 解析与 DNS 解析
   浏览器缓存 → OS 缓存（hosts）→ 本地 DNS → 递归/迭代查询（根→.com→权威）
   【优化】DNS prefetch / HTTPDNS（防劫持——医疗 App 内嵌 H5 的实际工程问题）
   【串联】Netty 周：DNS 解析本身也是一次网络往返——客户端建连前的隐性延迟
2. TCP 三次握手（Day01 热身题：SYN Flood / backlog / syn cookie）
   【账】一个 RTT；移动端 RTT 50-100ms 起——为什么长连接（H2/连接池）值钱
3. TLS 握手（Day03 热身题：混合加密 / ECDHE 前向保密 / 0-RTT 会话复用）
   【账】TLS1.2 两个 RTT、TLS1.3 一个、0-RTT 首包即数据——会话复用是移动端核心优化
4. HTTP 请求（Day04 热身题：1.1 keep-alive / H2 多路复用 / H3 QUIC）
   CDN 命中判定：缓存-Control/max-age/ETag 协商缓存 304
   【串联】静态资源走 CDN 边缘节点，动态请求走源站——分流是第一层
5. 服务端：LB → 网关 → 服务
   【串联】限流周（网关限流）、微服务周（路由/Nacos）、医疗周（互联网医院网关鉴权）
6. 应用内部：DispatcherServlet → Controller → Service → Mapper
   【本周主线】这条链上的每个对象都是容器里的单例代理——事务切面/脱敏切面在链上生效
   【串联】失效地图：链上任何一处自调用，声明式能力失效
7. 响应返回：连接复用（keep-alive）→ 浏览器解析（DOM/CSSOM/渲染树/layout/paint）
   【串联】H2 的 HPACK 省头、QUIC 连接迁移（WiFi→4G 不断）
```

**架构师答法的三个升维点**：

1. **每一步都有耗时与优化手段的对应**：DNS（prefetch/HTTPDNS）→ TCP/TLS（连接复用/0-RTT）→ 传输（H2/H3）→ 服务端（缓存/异步）——**性能优化=沿链路逐段找串行等待点**（Day04 梳理"拆全局锁"的请求版）
2. **这条链就是全栈视角**：前端、网络、协议、网关、应用、容器（Spring）、JVM、DB——往周专题全部挂在这条链的某一段上，**面试官从任意一段切入都能接住**
3. **回答结构决定印象**：按"链路顺序 + 每步一句话机制 + 一个优化点"作答，3 分钟收束；切忌从 TCP 头部格式开始背书

---

## 题目一（实战综合）：启动提速完整案例

### 场景描述

> 在线问诊系统（问诊+处方+医保对接），12 个微服务里最重的 `prescription-service`：**启动 8 分 10 秒**。结果：发布窗口 46 分钟（Day01 第 5 问算过），夜班发布、发布夜一次故障回滚再付 46 分钟。领导要求：**一个月内把窗口压到 25 分钟以内**。

### 作答区

#### 1. 度量：启动画像怎么做（第一步永远是测）

```java
// Boot 2.4+：ApplicationStartup 缓冲区
new SpringApplicationBuilder(PrescriptionServiceApplication.class)
    .applicationStartup(new BufferingApplicationStartup(2048))
    .run(args);
// application.yml
management.endpoints.web.exposure.include: startup,beans,conditions
```

`GET /actuator/startup` 的 StartupStep 树给出的分段画像（本次实测）：

| 阶段 | 耗时 | 占比 |
|---|---|---|
| spring.context.base/scan + 配置类解析 | 47s | 9.6% |
| **Bean 实例化合计** | **6min 12s** | **76%** |
| ├─ HikariCP 初始化（5 个数据源） | 38s | |
| ├─ **医保渠道客户端 ×18（SSL 握手 + 专线探测，串行）** | **4min 40s** | |
| ├─ ES RestHighLevelClient 建连 + 拉取集群信息 | 35s | |
| ├─ Redisson 初始化（锁/限流器初始化拉取） | 28s | |
| └─ @PostConstruct 预热（药品目录 20 万条进本地缓存） | 51s | |
| onRefresh（WebServer 创建）+ finishRefresh | 41s | 8.4% |
| Boot 自动装配条件评估 | 30s | 6% |

**画像结论**：76% 在 Bean 实例化，其中**医保渠道串行建连占全启动的 57%**——不是 Spring 慢，是"启动即连远端"的业务 Bean 慢（Day01 三类大头的典型）。

辅助手段：`-verbose:class` 确认类加载量（识别过度扫描）、JFR 的 Wall Clock 事件抓启动火焰图（确认 4min40s 都阻塞在 SSL_connect）、`/actuator/beans` 审计 Bean 总数（1,847 个，其中 300+ 来自一次误配的 `com` 根包扫描——历史遗留）。

#### 2. 施策：分层治理（按收益/风险排序落地）

| PR | 措施 | 层次 | 预期收益 | 风险与对策 |
|---|---|---|---|---|
| PR1 | **医保渠道建连并行化**（18 渠道串行→并行池 6 并发）+ **核心渠道 fail-fast、非核心异步重连** | 外部连接 | 4min40s → **50s** | 依赖分级 ADR（结算通道 fail-fast、短信/报表渠道异步）——Day01 的分层决策落地 |
| PR2 | 药品目录预热迁出 @PostConstruct → ApplicationRunner + 异步 + 就绪标志（就绪前查库，预热完成后切本地缓存，双读切换） | 挂点治理 | 51s → 0（不阻塞启动） | 双读切换的短暂 DB 压力（QPS 评估过，峰值 300，可承受） |
| PR3 | 扫描包收敛：`com` → `com.zhuomuniao.prescription` + 删除 3 个已下线 starter 依赖 | 类路径 | 47s → 21s；Bean 数 1847 → 1520 | 回归全量启动自检（防 Bean 丢失） |
| PR4 | HikariCP `initializationFailTimeout` 调整：核心库 fail-fast 保留，报表/日志库懒建连（minIdle=0 + 后台填充） | 外部连接 | 38s → 15s | 报表库首用慢（可接受，非主链路） |
| PR5 | ES/Redisson 建连异步化（后台线程 + 健康检查门禁：未就绪时相关功能降级） | 外部连接 | 63s → 12s（就绪门禁逻辑） | 就绪门禁要接入 actuator health group——readiness 拆分（核心组/非核心组） |
| PR6 | 全局 lazy 评估 | 实例化范围 | 讨论后**放弃** | 错误延迟暴露（处方服务是核心链路，Bean 坏了必须启动期死）+ Listener/@Scheduled 失效排查成本——**核心服务不适合，非核心（报表/管理端）适合** |

**治理后**：8min10s → **2min5s**（并行建连 + 挂点迁移 + 扫描收敛三笔合计）。发布窗口：46min → **21min**，达标。

#### 3. 架构师的三笔账（向领导汇报的翻译层）

1. **窗口账**：46min → 21min，夜班发布窗口缩短一半；**回滚恢复时间同步减半**（MTTR 的重要构成）
2. **风险账**：启动期与运行期的"半成品时间窗"（SmartLifecycle 停止探针前）从 8 分钟缩到 2 分钟——**新旧版本共存面减半，双写兼容的暴露时间减半**
3. **探针账**：启动 2 分钟后，readinessProbe 的 initialDelaySeconds 从 8min 挪到 150s + startupProbe 保护——**误杀重启循环的隐患消除**（Day01 的探针三笔账闭环）

**面试叙事（30 秒版）**："问诊系统处方服务启动 8 分钟，发布窗口 46 分钟。我先用 /actuator/startup 做了启动画像，76% 耗在 Bean 实例化，其中 18 个医保渠道串行 SSL 建连占了 57%。治理三板斧：渠道建连并行化 + 依赖分级 fail-fast、预热代码从 @PostConstruct 迁到 Runner 异步化、扫描包收敛。启动降到 2 分钟，发布窗口 21 分钟，回滚 MTTR 减半。核心决策是放弃了全局 lazy——处方服务是核心链路，配置错误必须启动期暴露。"

---

## 题目二（实战综合）：Bean 故障排查

### 场景一：启动失败三类报错的排查路径

**报错 1：`BeanCurrentlyInCreationException`**（Day03/Day07）

```
排查路径：
① 看报错 Bean 名 → getBean 调用栈（栈顶是 createBeanInstance 还是 populateBean）
   - createBeanInstance 中 → 构造器环：环上必有构造器注入
   - 报错文案带 "raw version ... circular reference" → @Async 撞环（Day07 反推）
② 环的定位：--debug 开启 org.springframework.beans 日志的 "Creating instance of bean" 序列
   → 谁在创建中又被依赖
③ 修复决策树：能抽中介/事件解耦 → 重构（目标解）；过渡期 @Lazy 标注入点（显式 TODO）
④ Boot 2.6+：先确认 allow-circular-references 是不是被人打开的（闸门意识）
```

**报错 2：`NoSuchBeanDefinitionException`**

```
排查路径：
① 是"没扫描到"还是"条件不满足"？
   - /actuator/beans 搜类名：有定义没实例化 → 条件问题；连定义都没有 → 扫描/注册问题
   - /actuator/conditions 搜对应的自动配置类 → ConditionEvaluationReport 直接告诉你哪个
     @ConditionalOnXxx 没过（Boot 自动装配排查的杀手锏——9月第3周 Boot 周深讲）
② 扫描问题：主类包路径 vs 组件实际包名（com.zhuomuniao.prescription vs com.zhuomuniao.common）
   ——common 模块的 Bean 为什么没被扫到：@ComponentScan 显式补 or Spring Boot 自动装配模块化（starter 化）
③ 条件问题：@ConditionalOnProperty 的 key/缺省值、@ConditionalOnClass 的类路径冲突
   （不同版本 jar 同时在 classpath——mvn dependency:tree | grep）
④ 注入点问题：单实现没加 @Primary/标记，构造器参数名丢失（-parameters 编译参数）导致 byName 失败
```

**报错 3：`BeanCreationException`（cause 链才是真相）**

```
排查路径：读完整 cause 链（Beautified stack：BeanCreationException → ... → 根因）
高频根因三类：
- @PostConstruct 抛 NPE：依赖未注入（BPP 顺序/条件不满足）或配置缺失
  （@Value 占位符没配：PropertySourcesPlaceholderConfigurer 时机——Day01 BFPP）
- 类型不匹配：注入候选有多个（@Primary 缺失）或早期引用是原始对象（Day03/07 的
  BeanNotOfRequiredTypeException 变体——循环依赖 + 代理的组合）
- 循环依赖的普通形态（见报错 1）
```

**三类报错的统一方法论**：**报错是流水线的断点信息——先定位断在 Day02 总装线哪一步，再按步骤的介入者排查**。这就是"背报错清单"和"懂生命周期"的差距：前者记不完，后者一通百通。

### 场景二：运行期资损事故 STAR（Day06 串联复盘的预演）

**S（情境）**：续方功能上线第 3 天，对账任务发现 17 笔"库存已扣、续方订单失败"的脏数据（金额涉及 3 个药品），其中 2 笔已触发患者投诉。

**T（任务）**：定位根因、修复数据、防止复发。

**A（行动）——排查全链路**：

```
1. 对账差异定位：inventory_flow（库存流水）与 prescription_order 状态比对
   → 17 笔差异全部是 "renew 抛异常但库存扣减已提交" 的形态
2. 反查 renew 的代码路径：renew() 内部 this.deductInventory()（自调用）
3. 机制确认（Day04 内存图）：外部调 renew 走代理，事务生效；
   renew 内部 this 指原始对象 → deductInventory 的事务从未开启
   → renew 外层异常回滚了自己的写操作，但 deductInventory 的 SQL 是自动提交的
4. 为什么测试没发现：单测直接 new Service（无容器无代理）；
   集成测试没构造"扣减成功后续方失败"的分支（mock 掉了下游）
5. 修复：
   - 数据：17 笔按流水逆向补偿（补回库存 or 补成订单——业务确认 15 笔补回、2 笔补成订单）
   - 代码：deductInventory 拆到 InventoryService（拆 Bean，目标解而非 @Lazy/self 注入）
   - 防复发：① 全仓自调用扫描（ArchUnit 规则 + IDEA Structural Search 人工一轮）
            ② 集成测试补"扣减后失败回滚"用例（真实容器跑——@SpringBootTest）
            ③ 失效地图 checklist 进 code review 模板
```

**R（结果）**：17 笔数据闭环；扫描出另外 6 处自调用隐患（2 处 @Transactional、4 处 @Cacheable）；ArchUnit 规则进 CI（本轮拦截为零，下个迭代拦截 2 次——**规则开始干活了**）。

**简历一句话表达**："主导处方服务资损事故排查：通过对账发现自调用导致的事务失效（17 笔库存/订单不一致），根因定位到代理绕过（this 不经代理），修复采用拆 Bean + ArchUnit 静态规则 + 真实容器集成测试三防，全仓清除 6 处同类隐患。"

### 场景三：单例 Bean 的运行期"慢性病"审计（架构师日常）

线上稳定性巡检清单（把本周知识变成周期性动作）：

| 审计项 | 手段 | 判据 | 本周知识锚点 |
|---|---|---|---|
| 有状态单例 | archunit 规则：@Service/@Component 类的非 final 成员 | 白名单外报警 | Day01 第 6 问决策树 |
| 自调用隐患 | ArchUnit 自定义规则 / IDE 检查 | 全仓清零 | Day04 失效地图 |
| 循环依赖 | Boot 闸门 + ArchUnit slices | 闸门必须 false | Day03 治理 |
| BPP 连坐 | 日志搜 "not eligible for getting processed" | 零出现 | Day01 陷阱 |
| 切面耗时 | Micrometer 指标 aspect.execution.time | P99 &lt; 5ms | Day04 纪律 |
| 启动时长回归 | CI 记录启动时间趋势 | 超基线 20% 报警 | Day05 场景一 |
| Bean 数量趋势 | /actuator/beans 数量入监控 | 涨幅需要解释 | Day05 扫描收敛 |

**这张表是"Spring 健康度审查"的 MVP**——把失效地图的每族检测手段工程化为周期任务，是架构师"把知识变成系统"的示范。

---

## 本日能力差距与补足方向

### 差距1：启动画像工具链没用过——排查靠"猜 + 注释代码二分"

- **现状**：没用过 BufferingApplicationStartup / /actuator/startup；定位启动慢靠注释 Bean 二分法（能到结果但低效且说不出口）；/actuator/beans、/actuator/conditions 的排查价值没概念
- **架构师水平**：30 分钟出启动画像（分段耗时表），按三类大头直接定位；把"度量先行"讲成纪律
- **补足方向**：给问诊系统 prescription-service 配置 startup 端点跑一次（场景一的实操重演）

### 差距2：启动优化只有"加 @Lazy"一招，没有分层施策与放弃决策

- **现状**：不知道并行建连、fail-fast 分级、挂点迁移（@PostConstruct→Runner）、扫描收敛、懒建连这些层次；更没有"核心服务放弃全局 lazy"的决策叙事
- **架构师水平**：按画像逐段施策；每个决策能讲清收益与风险（依赖分级 ADR 是面试加分项）
- **补足方向**：把场景一 PR 清单变成模板（措施/层次/预期收益/风险对策四列）

### 差距3：启动报错排查没有路径——看到异常栈就懵

- **现状**：三类报错（CurrentlyInCreation / NoSuchBeanDefinition / CreationException cause 链）没有结构化路径；不知道 /actuator/conditions 是条件装配排查的杀手锏
- **架构师水平**："先定位断在总装线哪一步，再按介入者排查"——用生命周期做排查地图而不是背报错清单
- **补足方向**：把场景一的三个排查路径抄成卡片；下次真实报错按卡片走一遍

### 差距4：资损事故的排查叙事没有闭环结构

- **现状**：讲事故只讲"改了什么代码"，没有"对账发现→机制确认→为什么测试没拦住→数据修复→防复发三防"的完整闭环；STAR 结构散乱
- **架构师水平**：5 分钟讲完闭环，其中"为什么测试没拦住"和"防复发"是体现架构师素养的两段（工程师修 bug，架构师修"bug 进入生产的路径"）
- **补足方向**：用场景二模板重述问诊系统经历一遍；补"扣减后失败回滚"的真实容器集成测试

### 差距5：静态防护（ArchUnit）不会用——防复发只靠"人记住"

- **现状**：不知道 ArchUnit 能查循环依赖（slices beFreeOfCycles）、自调用、有状态单例；防复发手段停留在"发文档提醒"
- **架构师水平**：把失效地图的每一族变成 ArchUnit 规则进 CI——规则开始拦截就是知识变成系统的时刻
- **补足方向**：写三条规则（noCycles / no self-invocation 自定义 / no mutable @Service fields）在 side project 跑通

### 差距6：健康度审计没有周期化

- **现状**：Spring 相关的巡检（启动时长趋势、Bean 数趋势、切面耗时、"not eligible" 日志）完全没有常态化——问题都在事故后才暴露
- **架构师水平**：把场景三审计表落成季度/发布前的检查项（部分自动化进 CI/监控）
- **补足方向**：先手工执行一轮问诊系统审计，把发现项建清单，再逐步自动化

### 差距7：URL 全链路答不到架构师深度

- **现状**：按流程背步骤，讲不出每段的耗时量级与优化手段对应；不会用"沿链路找串行等待点"的组织方式
- **架构师水平**：3 分钟链路叙事 + 每步一个优化锚点 + 从任意一段被追问都能展开（DNS 劫持/0-RTT/H2/H3/网关限流/容器代理/JVM/DB 全链路视野）
- **补足方向**：对着场景一热身题自己讲三遍录音回听

### 差距8：启动优化的收益翻译不熟

- **现状**：能讲"启动从 8 分钟到 2 分钟"，讲不出三笔账（窗口=兼容暴露面、回滚=两次窗口、探针误杀防护）——技术结果没有翻译成工程/业务收益
- **架构师水平**：汇报必带三笔账；把 startupProbe/readiness 配置建议一并给出（Day01 差距 1.6 的闭环）
- **补足方向**：把第 3 问三笔账背熟；给问诊系统的 K8s 配置算一遍真实数字

---

## 附录：本日关键认知速查

| 认知点 | 关键结论 |
|---|---|
| 度量先行 | BufferingApplicationStartup + /actuator/startup 出分段画像；三类大头：扫描/配置解析、启动即连远端的 Bean、自动装配评估 |
| 启动大头规律 | 76% 在 Bean 实例化、"启动即连远端"占半壁——不是 Spring 慢是业务 Bean 慢 |
| 优化分五层 | 外部连接（并行化+fail-fast 分级）/ 挂点迁移（Runner+异步+就绪门禁）/ 扫描收敛 / 实例化范围（lazy 慎用）/ JVM/AOT |
| 全局 lazy 决策 | 核心链路服务放弃（错误延迟暴露）；非核心（报表/管理端/Serverless）适用 |
| 三笔账 | 窗口=新旧共存暴露面；回滚=两次窗口；启动抖动=探针误杀（startupProbe 防护） |
| 报错排查总纲 | 先定位断在总装线哪一步，再按该步骤的介入者排查——生命周期是排查地图 |
| NoSuchBean 三查 | /actuator/beans（有定义吗）→ /actuator/conditions（条件为什么没过）→ 扫描包路径/依赖树 |
| 资损事故闭环 | 对账发现→机制确认（代理内存图）→为什么测试没拦住→数据修复→防复发三防（扫描/测试/规则） |
| 为什么测试没拦住 | 单测 new 对象无代理、集成测试 mock 掉了失败分支——真实容器+真实失败注入才算数 |
| 健康度审计 | 七项：有状态单例/自调用/循环/连坐日志/切面耗时/启动趋势/Bean 数趋势——失效地图的检测手段工程化 |
| URL 链路叙事 | 链路顺序+每步一句话机制+一个优化锚点；性能优化=沿链路逐段找串行等待点 |