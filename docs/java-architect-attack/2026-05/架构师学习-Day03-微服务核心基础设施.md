# Day 3：微服务核心基础设施 — 注册发现深入·配置中心·服务网关·链路追踪·通信进阶（练习整理）

## 题目一：Nacos注册中心深入 — Distro协议与实例模型

### Distro协议的核心设计

```
Distro协议本质：Hash分区 + 异步复制

1. 节点职责划分（Hash分区）
   每个Nacos节点负责一部分Service：
     hashCode(serviceName) % nodeCount → 决定哪个节点负责
   节点A负责 [service1, service4, service7...]
   节点B负责 [service2, service5, service8...]

2. 写流程
   客户端发起注册 → 请求打到任意节点N1
     → N1判断：这个service归我管吗？
       归我管 → 本地写入 + 异步同步给其他节点（fire-and-forget）
       不归我管 → 转发给负责的节点处理

   关键：写是"先写负责节点，再异步同步"，不是同步写所有节点
   所以是AP——牺牲强一致，换可用性

3. 读流程
   客户端查询服务列表 → 请求打到任意节点
     → 直接读本地数据返回

   关键：每个节点都持有全量数据（通过同步获得）
   所以读不需要转发，任意节点都能响应
   但数据可能有短暂不一致（同步延迟）

4. 新节点加入的数据同步
   新节点启动 → 向集群请求全量数据（DistroData）
   收到全量数据后 → 定期接收增量同步

5. 数据校验（一致性保障）
   每个节点定期验证自己负责的数据在其他节点上是否一致
   不一致 → 触发全量同步修正
   这是"最终一致"的兜底机制
```

### 临时实例 vs 持久实例

```
                    临时实例（ephemeral）       持久实例（persistent）
  ──────────────────────────────────────────────────────────────
  一致性协议        Distro (AP)               Raft (CP)
  健康检查方式      客户端心跳上报             服务端主动探测
  不健康时          自动剔除                   标记不健康但不剔除
  适用场景          微服务实例                 数据库/中间件
  实例注册者        服务自己注册               运维/外部系统注册

  核心区别：谁来做健康检查！

  临时实例 — 客户端心跳：
    客户端每5秒发心跳 → 15秒没收到 → 标记不健康 → 30秒没收到 → 剔除
    服务端是被动的，等客户端"报到"

    和Eureka的区别：
    Eureka自我保护：心跳比例低于85% → 不再剔除任何实例
      问题：真正挂掉的服务也保留 → 调用大量失败
    Nacos改进：protectThreshold保护阈值
      不健康实例占比超过阈值 → 保留所有实例（包括不健康的）
      未超过阈值 → 正常剔除不健康实例
      比"全保留"更精细，给架构师一个可调参数

  持久实例 — 服务端探测：
    服务端主动发TCP探测或HTTP请求 → 检查实例是否存活
    发现不健康 → 只标记，不剔除
    为什么不剔除？数据库主从、中间件地址不能凭空消失
    为什么用Raft(CP)？持久实例数据不能丢，两个节点数据不一致
    可能导致流量打到错误的数据库实例
```

### 注册中心的推拉结合机制

```
注册中心：UDP推送 + 客户端定时拉取

  推：UDP推送
    服务端检测到实例变更 → 找到订阅该服务的客户端 → UDP推送变更通知
    优点：实时（延迟<1秒）
    缺点：UDP不可靠，可能丢包

  拉：客户端定时拉取
    客户端每隔6秒（默认）向注册中心拉取服务列表
    优点：可靠，兜底
    缺点：有延迟（最多6秒）

  为什么推拉结合？
    UDP丢了 → 拉取兜底（最多6秒延迟）
    正常时 → 推送实时（<1秒）
    两者叠加 = 实时性 + 可靠性

  为什么不用纯推送（TCP长连接/WebSocket）？
    注册中心可能有数万客户端 → 万级TCP长连接 → 资源开销大
    注册数据允许短暂不一致（秒级延迟可接受）
    UDP无连接 → 轻量

  为什么不用纯拉取？
    拉取间隔6秒 → 实例上下线有6秒延迟
    微服务调用失败6秒 → 对业务影响大
    推送可以把延迟降到1秒内

配置中心：Long Polling（不是UDP！）

  客户端发起请求 → 服务端hold住（最多29.5秒）
    → 期间配置变更 → 立即返回
    → 超时无变更 → 返回空 → 客户端重新发起

  为什么配置中心不用UDP推送？
    配置变更比注册变更更敏感——一个配置项可能影响所有实例行为
    UDP丢了可能导致实例行为不一致，比注册表不一致更危险
    Long Polling是HTTP的，可靠传输，不会丢

  两套机制的选型反映了数据特性的差异：
    注册数据 → 允许短暂不一致 → UDP轻量+拉取兜底
    配置数据 → 不允许丢失 → Long Polling可靠
```

### 与架构师水平的差距

| 层次 | 回答 |
|------|------|
| 开发 | Nacos支持AP和CP模式切换 |
| 高级开发 | Nacos AP用Distro协议，CP用Raft，临时实例客户端心跳，持久实例服务端探测 |
| 架构师 | Distro协议本质是Hash分区+异步复制：写先到负责节点再fire-and-forget同步，读任意节点直接返回。临时vs持久的本质区别是健康检查发起方——客户端心跳还是服务端探测。protectThreshold替代Eureka自我保护，更精细可控。注册中心推拉结合因UDP不可靠需拉取兜底，配置中心Long Polling因配置不能丢——两个场景的通信模型由数据特性决定 |

**补足方向**：能画出Distro协议的写流程（请求→判断负责节点→本地写→异步同步）和读流程（任意节点直接返回）。分清注册中心UDP推拉和配置中心Long Polling是两套机制，能解释为什么选型不同。

---

## 题目二：配置中心设计 — 长轮询·灰度·回滚

### Nacos配置中心长轮询机制

```
Long Polling的完整流程：

  客户端                                  Nacos服务端
    │                                        │
    │  1. GET /listener                      │
    │     body: dataId+group+md5             │
    │ ─────────────────────────────────────→ │
    │                                        │ 2. 比较md5
    │                                        │    相同 → hold住，不返回
    │                                        │    不同 → 立即返回变更的dataId
    │                                        │
    │       （等待中，最多29.5秒）             │
    │                                        │
    │     3a. 配置变更了！                    │
    │ ←───────────────────────────────────── │    立即返回变更的dataId
    │                                        │
    │  4. POST /configs                      │
    │     拉取最新配置内容                     │
    │ ─────────────────────────────────────→ │
    │                                        │
    │  5. 返回配置内容                        │
    │ ←───────────────────────────────────── │
    │                                        │
    │  6. 重新发起Long Polling               │
    │ ─────────────────────────────────────→ │
    │                                        │
    │     3b. 29.5秒超时，无变更              │
    │ ←───────────────────────────────────── │    返回空
    │                                        │
    │  7. 重新发起Long Polling               │
    │ ─────────────────────────────────────→ │

  为什么不用纯推送（WebSocket）？
    1. 万级客户端连接 → 服务端资源开销大
    2. WebSocket需要维护连接状态 → 重连、心跳、断线检测复杂
    3. 配置变更频率极低（可能几天一次）→ 长连接大部分时间空闲
    4. Long Polling用HTTP → 天然穿透防火墙/代理，运维简单
    5. HTTP无状态 → 服务端重启客户端自动重连，无需复杂恢复逻辑

  为什么不用纯拉取？
    拉取间隔30秒 → 配置变更延迟30秒 → 线上问题修复不及时
    Long Polling → 配置变更1秒内感知

  Long Polling的关键参数：
    长轮询超时：29.5秒（Nacos默认）
    客户端等待超时：30秒（略大于服务端超时）
    连接超时：3秒
    为什么是29.5秒而不是60秒？
      HTTP代理/负载均衡器通常30秒超时 → 29.5秒刚好不超过
```

### 配置灰度发布方案

```
配置灰度 vs 代码灰度：
  代码灰度：按流量比例逐步放量
  配置灰度：按实例/集群逐步生效

方案一：按集群灰度（推荐）

  集群划分：
    集群A（灰度集群）：10台实例
    集群B（正式集群）：90台实例

  灰度流程：
    Step1: 配置发布到集群A → 观察10分钟
      监控：错误率、RT、业务指标
      1%流量 → 10台/100台 = 10%

    Step2: 扩大灰度范围 → 集群A+B的部分实例
      30台实例 → 30%流量

    Step3: 全量发布
      所有实例 → 100%流量

  Nacos实现：
    方式1：不同集群用不同namespace/group
      灰度集群 → namespace=gray, group=DEFAULT
      正式集群 → namespace=prod, group=DEFAULT
      逐步将实例的namespace从gray切到prod

    方式2：Nacos 2.x的Beta发布
      指定灰度IP列表 → 配置只推送到这些IP
      扩大IP列表 → 逐步放量
      全量发布 → 删除Beta配置，发布正式配置

方案二：按流量比例灰度

  网关层路由规则：
    10%流量 → 读灰度配置的实例
    90%流量 → 读正式配置的实例

  实现：
    网关根据请求头/cookie → 决定路由到哪组实例
    灰度实例和正式实例部署不同配置

  缺点：需要两套实例，成本高
  优点：可以精确控制流量比例

  按集群灰度 vs 按流量灰度：
    按集群 → 运维简单，但粒度粗
    按流量 → 粒度细，但需要双倍实例
    大多数场景 → 按集群灰度够用
```

### 配置回滚机制

```
配置回滚的核心问题：正在运行的实例怎么办？

1. Nacos的配置历史机制
   每次配置变更 → 保留历史版本（默认保留30天）
   回滚操作：选择历史版本 → 发布 → Long Polling推送到所有客户端

2. 回滚时正在运行实例的处理
   立即生效（大部分场景）：
     客户端收到新配置 → 更新内存中的配置值
     Spring Cloud应用 → @RefreshScope 重新创建Bean
     问题：正在执行中的请求用的是旧配置还是新配置？
       答：正在执行的请求用旧配置，新请求用新配置
       这是可接受的——回滚是紧急操作，秒级生效已足够

   不能立即生效的场景：
     数据库连接池参数（maxPoolSize）→ 回滚后需要重建连接池
     线程池参数（corePoolSize）→ 需要等任务完成再调整
     这些场景的回滚 → 配置回滚 + 应用重启

3. 回滚的SOP
   0-1分钟：发现问题 → Nacos控制台回滚配置
   1-2分钟：观察监控，确认配置已推送到所有实例
   2-5分钟：如需重启 → 滚动重启（不是全部重启）
   5分钟+：事后复盘 → 配置变更审批流程优化

4. 防止配置事故的架构设计
   L1 变更审批：配置变更需要审批（生产环境）
   L2 灰度发布：先灰度1% → 观察 → 全量
   L3 快速回滚：Nacos一键回滚 + Long Polling秒级推送
   L4 配置校验：变更前校验配置格式/合法性（JSON Schema）
   L5 监控告警：配置变更后自动触发监控巡检
```

### 与架构师水平的差距

| 层次 | 回答 |
|------|------|
| 开发 | Nacos可以改配置，不用重启 |
| 高级开发 | Nacos用长轮询推送配置变更，支持灰度发布 |
| 架构师 | Long Polling的本质是"客户端主动拉、服务端延迟响应"，选型原因是HTTP无状态+穿透代理+万级客户端轻量。配置灰度推荐按集群灰度（不同namespace/Beta IP），逐步扩大范围。回滚靠配置历史+Long Polling秒级推送，但正在执行的请求用旧配置——秒级生效已足够。防配置事故是五层防御：审批→灰度→回滚→校验→监控 |

**补足方向**：能画出Long Polling的完整流程（请求→hold→变更返回/超时返回→重新发起），理解29.5秒超时的原因（HTTP代理30秒超时）。配置灰度首选按集群灰度+Nacos Beta发布。

---

## 题目三：服务网关架构 — 过滤器链·动态路由·灰度路由

### Spring Cloud Gateway过滤器链模型

```
Gateway的请求处理流程：

  客户端请求
    │
    ↓
  RoutePredicateHandlerMapping → 匹配路由
    │
    ↓
  FilteringWebHandler → 组装过滤器链
    │
    ↓
  ┌──────────────────────────────────────────┐
  │          过滤器链（责任链模式）             │
  │                                          │
  │  前置阶段（order从小到大）：               │
  │    GlobalFilter(0)  → 请求日志            │
  │    GatewayFilter(1) → 请求头修改          │
  │    GlobalFilter(2)  → 限流检查            │
  │    GatewayFilter(3) → 鉴权                │
  │                                          │
  │  ──── 代理转发（Netty HttpClient）────     │
  │                                          │
  │  后置阶段（order从大到小，反向执行）：       │
  │    GatewayFilter(3) → 响应头修改          │
  │    GlobalFilter(2)  → 记录响应时间        │
  │    GatewayFilter(1) → 响应体修改          │
  │    GlobalFilter(0)  → 响应日志            │
  └──────────────────────────────────────────┘

  GlobalFilter vs GatewayFilter：
    GlobalFilter：全局生效，所有路由都经过
      适合：鉴权、限流、日志、监控
    GatewayFilter：绑定到特定路由
      适合：特定服务的请求头修改、重试、熔断

  执行顺序控制：
    实现 Ordered 接口 或 @Order 注解
    order值越小 → 前置阶段越先执行 → 后置阶段越后执行
    典型顺序：
      -1000 → 全局日志（最外层，记录完整耗时）
      -500  → 全局限流（限流在最前面，减少无效处理）
      0     → 全局鉴权
      1000  → 路由级过滤器（重试、熔断等）
```

### 动态路由实现

```
问题：默认路由配置在yml里，改路由要重启网关

方案一：Nacos配置中心 + 路由监听

  路由配置存Nacos：
    dataId: gateway-routes.json
    content:
    [
      {
        "id": "order-service",
        "uri": "lb://order-service",
        "predicates": [{"name": "Path", "args": {"pattern": "/order/**"}}],
        "filters": [{"name": "StripPrefix", "args": {"parts": "1"}}]
      }
    ]

  网关启动时：
    1. 从Nacos加载路由配置
    2. 注册配置变更监听器
    3. 配置变更 → 解析新路由 → 更新RouteDefinition

  核心代码：
    @Component
    public class NacosRouteListener {
        private final RouteDefinitionWriter routeDefinitionWriter;

        @NacosConfigListener(dataId = "gateway-routes.json")
        public void onRouteChange(String config) {
            List<RouteDefinition> routes = parseRoutes(config);
            // 清除旧路由
            routeDefinitionWriter.deleteAll();
            // 写入新路由
            routes.forEach(route ->
                routeDefinitionWriter.save(Mono.just(route)).subscribe()
            );
        }
    }

方案二：数据库 + 定时轮询

  路由配置存数据库 → 网关定时查询 → 发现变更则更新
  优点：可以给路由配置加审批流程
  缺点：延迟高（轮询间隔）

  方案一 vs 方案二：
    Nacos推送 → 秒级生效 → 推荐
    数据库轮询 → 分钟级延迟 → 适合需要审批流程的场景
```

### 网关层灰度路由

```
方案一：按用户标签灰度（精准灰度）

  路由规则：
    请求头带 gray-tag=true → 路由到灰度实例
    请求头无 gray-tag → 路由到正式实例

  实现（Spring Cloud Gateway + Nacos元数据）：
    灰度实例注册时带上元数据：version=gray
    正式实例注册时带上元数据：version=prod

    自定义GlobalFilter：
      public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) {
          String grayTag = exchange.getRequest().getHeaders().getFirst("gray-tag");
          String targetVersion = "true".equals(grayTag) ? "gray" : "prod";

          // 通过Nacos元数据过滤实例
          // 只路由到 metadata.version = targetVersion 的实例
          exchange.getAttributes().put("targetVersion", targetVersion);
          return chain.filter(exchange);
      }

  优点：精准控制——指定用户/租户走灰度
  缺点：需要客户端配合传标签

  适用场景：B端系统按租户灰度、内部员工先灰度

方案二：按流量比例灰度（比例灰度）

  路由规则：10%流量 → 灰度实例，90%流量 → 正式实例

  实现：
    自定义LoadBalancer：
      public ServiceInstance choose(List<ServiceInstance> instances) {
          int grayRatio = nacosConfig.getGrayRatio(); // 从配置中心读取比例
          int random = ThreadLocalRandom.current().nextInt(100);

          List<ServiceInstance> grayInstances = instances.stream()
              .filter(i -> "gray".equals(i.getMetadata().get("version")))
              .collect(Collectors.toList());
          List<ServiceInstance> prodInstances = instances.stream()
              .filter(i -> "prod".equals(i.getMetadata().get("version")))
              .collect(Collectors.toList());

          if (random < grayRatio && !grayInstances.isEmpty()) {
              return randomChoose(grayInstances);
          }
          return randomChoose(prodInstances);
      }

  优点：不需要客户端配合，服务端控制比例
  缺点：粒度粗，无法精准控制哪些用户走灰度

  适用场景：C端系统大范围灰度

方案对比：
  ┌─────────────┬──────────────┬──────────────┐
  │             │ 按用户标签    │ 按流量比例    │
  ├─────────────┼──────────────┼──────────────┤
  │ 精准度       │ 高（指定用户） │ 低（随机分配） │
  │ 客户端配合   │ 需要传标签    │ 不需要        │
  │ 回滚复杂度   │ 低（去标签）  │ 中（调比例）  │
  │ 适用场景     │ B端/租户系统  │ C端大范围灰度  │
  │ 实时调整     │ 改标签规则    │ 改比例配置    │
  └─────────────┴──────────────┴──────────────┘

  架构师建议：两者组合——先用标签灰度（内部用户），再用比例灰度（逐步放量）
```

### 与架构师水平的差距

| 层次 | 回答 |
|------|------|
| 开发 | 网关做路由转发和鉴权 |
| 高级开发 | Gateway用过滤器链处理请求，支持动态路由 |
| 架构师 | 过滤器链是责任链模式：GlobalFilter全局生效+GatewayFilter路由级生效，order控制执行顺序，前置正序后置逆序。动态路由推荐Nacos推送+RouteDefinitionWriter秒级生效。灰度路由两种方案：按用户标签（精准+需客户端配合）和按流量比例（粗粒度+服务端控制），B端选标签C端选比例，进阶是两者组合——先标签灰内部用户再比例灰放量 |

**补足方向**：能画出Gateway过滤器链的前置→代理→后置执行流程。灰度路由能结合Nacos元数据（version=gray/prod）解释完整实现。

---

## 题目四：分布式链路追踪 — 模型·传播·采样

### Trace/Span模型设计

```
典型调用链：用户 → 网关 → 订单服务 → 库存服务 → 支付服务

  TraceId = abc123（整个调用链唯一）
  SpanId  = 每个服务调用生成一个

  时间轴：
  ┌─────────────────────────────────────────────────────────┐
  │ TraceId: abc123                                         │
  │                                                         │
  │ [Span1] 网关         SpanId=1      ParentSpanId=null   │
  │ ├──────────────────────────────────────────┐            │
  │ │                                          │            │
  │ │ [Span2] 订单服务   SpanId=1.1    ParentSpanId=1      │
  │ │ ├──────────────────────────────┐         │            │
  │ │ │                              │         │            │
  │ │ │ [Span3] 库存服务 SpanId=1.1.1 ParentSpanId=1.1    │
  │ │ │ ├──────────────┐             │         │            │
  │ │ │ │              │             │         │            │
  │ │ │ └──────────────┘             │         │            │
  │ │ │                              │         │            │
  │ │ │ [Span4] 支付服务 SpanId=1.1.2 ParentSpanId=1.1    │
  │ │ │ ├──────────────┐             │         │            │
  │ │ │ │              │             │         │            │
  │ │ │ └──────────────┘             │         │            │
  │ │ └──────────────────────────────┘         │            │
  │ └──────────────────────────────────────────┘            │
  └─────────────────────────────────────────────────────────┘

  Span的核心字段：
    traceId       — 全链路唯一ID
    spanId        — 当前Span ID
    parentSpanId  — 父Span ID
    operationName — 操作名（如 OrderService.createOrder）
    startTime     — 开始时间
    endTime       — 结束时间
    tags          — 标签（http.method=POST, http.url=/order）
    logs          — 事件日志（异常信息等）
    status        — 状态（OK/ERROR）

  TraceId的生成策略：
    方案1：UUID — 简单但无序，索引性能差
    方案2：Snowflake — 有序，性能好（推荐）
    方案3：时间戳+IP+序列号 — 可读性好

  SpanId的生成策略：
    方案1：递增编号（1, 2, 3...）— 简单但无法表达父子关系
    方案2：点分编号（1, 1.1, 1.1.1...）— 直观表达层级（推荐）
    方案3：128位随机 — 不依赖全局序号
```

### 跨线程和跨MQ的TraceId传播

```
问题1：跨线程（异步任务）

  正常情况：ThreadLocal存储TraceContext → 子线程拿不到

  解决方案：
    方案1：手动传递
      @Async
      public void asyncTask(TraceContext context) {
          TraceContext.set(context); // 子线程手动设置
          try {
              // 业务逻辑
          } finally {
              TraceContext.remove();
          }
      }

    方案2：TransmittableThreadLocal（阿里开源，推荐）
      // 替换ThreadLocal
      private static final TransmittableThreadLocal<TraceContext> CONTEXT =
          new TransmittableThreadLocal<>();

      // 线程池需要用TtlExecutors装饰
      ExecutorService executor = TtlExecutors.getTtlExecutorService(rawExecutor);

      // TransmittableThreadLocal自动在提交任务时捕获上下文
      // 在执行任务时恢复上下文 → TraceId自动传播

    方案3：Java 21 Virtual Thread
      虚拟线程天然支持ThreadLocal → 无需额外处理
      但Virtual Thread的ThreadLocal行为和平台线程一致
      仍需要TransmittableThreadLocal来处理线程池复用场景

问题2：跨消息队列（MQ）

  生产者 → MQ → 消费者，中间是Broker，TraceId怎么传？

  核心思路：把TraceId放进消息属性（不是消息体）

  RocketMQ实现：
    // 生产者
    Message msg = new Message("order-topic", "tag", body);
    msg.putUserProperty("traceId", TraceContext.getTraceId());
    msg.putUserProperty("spanId", TraceContext.getSpanId());
    producer.send(msg);

    // 消费者
    consumer.registerMessageListener(msgs -> {
        String traceId = msgs.get(0).getUserProperty("traceId");
        String parentSpanId = msgs.get(0).getUserProperty("spanId");
        TraceContext.set(new TraceContext(traceId, parentSpanId));
        try {
            // 业务逻辑 → 生成新的子Span
        } finally {
            TraceContext.remove();
        }
        return ConsumeConcurrentlyStatus.CONSUME_SUCCESS;
    });

  Kafka实现：
    // 生产者
    ProducerRecord<String, String> record = new ProducerRecord<>(topic, value);
    record.headers().add("traceId", TraceContext.getTraceId().getBytes());
    producer.send(record);

    // 消费者
    Header traceHeader = record.headers().lastHeader("traceId");
    String traceId = new String(traceHeader.value());

  关键区别：
    HTTP调用 → Header传播（W3C Trace Context标准）
    MQ调用 → Message Property传播
    线程池 → TransmittableThreadLocal传播
    三种场景，三种传播方式，但TraceId是同一个
```

### 采样策略选择

```
为什么需要采样？
  万级QPS → 每个请求一条Trace → 每秒万条 → 存储和查询成本爆炸
  采样目标：用最少的Trace数据，覆盖最多的故障场景

方案一：头部连续采样（Head-based Sampling）

  决策时机：请求入口（网关）就决定是否采样
  实现：随机/概率采样，如采样率1%
    if (random.nextInt(100) < 1) {
        traceContext.setSampled(true);
    }

  优点：
    - 实现简单，入口决定
    - 采样率精确可控
    - 传播简单（Header带sampled标记）

  缺点：
    - 随机采样，可能漏掉异常请求
    - 1%采样率 → 99%的故障Trace被丢弃
    - 无法针对慢请求/异常请求做特殊采样

方案二：尾部基于采样（Tail-based Sampling）

  决策时机：请求完成后，根据结果决定是否保留
  实现：所有Trace先暂存 → 根据规则决定保留哪些
    规则1：RT > 1秒的Trace → 保留
    规则2：有异常的Trace → 保留
    规则3：正常Trace → 采样率0.1%

  优点：
    - 保留所有异常/慢请求的Trace
    - 正常请求低采样，异常请求100%保留
    - 对排障最有价值

  缺点：
    - 实现复杂：需要暂存所有Trace → 等请求完成 → 再决定
    - 内存开销大：暂存期间所有Span都在内存
    - 延迟：需要等请求完成才能决定

  典型实现：OpenTelemetry Collector的Tail Sampling Processor

方案选择：
  ┌─────────────┬──────────────────┬──────────────────┐
  │             │ 头部采样          │ 尾部采样          │
  ├─────────────┼──────────────────┼──────────────────┤
  │ 决策时机     │ 请求入口          │ 请求完成          │
  │ 实现复杂度   │ 简单             │ 复杂（需暂存）     │
  │ 资源开销     │ 小               │ 大（暂存开销）     │
  │ 异常覆盖     │ 差（随机可能漏）   │ 好（异常全保留）   │
  │ 适用场景     │ QPS高+故障率低    │ 排障需求高+流量可控 │
  └─────────────┴──────────────────┴──────────────────┘

  架构师推荐：两者组合
    默认：头部采样1%（覆盖大部分正常流量）
    叠加：尾部采样保留所有异常/慢请求（覆盖关键故障）
    结果：正常请求1%采样 + 异常请求100%保留
    成本：略高于纯头部采样，但排障价值大增
```

### 与架构师水平的差距

| 层次 | 回答 |
|------|------|
| 开发 | 用SkyWalking做链路追踪 |
| 高级开发 | Trace/Span模型，TraceId通过Header传播 |
| 架构师 | Trace/Span模型用点分编号表达层级关系，TraceId推荐Snowflake生成保证有序。三种传播场景三种方案：HTTP→Header（W3C标准）、MQ→Message Property、线程池→TransmittableThreadLocal。采样策略选头部+尾部组合：头部1%覆盖正常流量，尾部100%保留异常，成本可控排障价值大 |

**补足方向**：能画出五服务调用链的Trace/Span树。三种传播方式（HTTP/MQ/线程池）各写一段伪代码。采样策略能解释"为什么纯头部采样会漏异常"。

---

## 题目五：微服务通信进阶 — 选型·连接管理·超时策略

### gRPC vs RESTful 选型决策框架

```
不要一句话"性能选gRPC"——架构师要给出决策框架

维度1：调用场景
  内部服务间调用 → gRPC（二进制+长连接+多路复用）
  对外API/前端调用 → RESTful（HTTP/JSON，通用性）

维度2：性能要求
  高频+低延迟 → gRPC（Protobuf序列化比JSON快3-5倍，体积小2-3倍）
  低频+可接受50ms+ → RESTful够用

维度3：团队约束
  团队都会Java+Protobuf → gRPC
  团队多语言/前端也要调 → RESTful
  前端BFF层调后端 → 可以用gRPC-Web

维度4：生态约束
  需要浏览器直接调用 → RESTful（gRPC-Web支持有限）
  需要API网关转发 → RESTful（大部分网关对gRPC支持不完善）
  服务网格（Istio）→ gRPC原生支持

维度5：演进化
  原有系统是RESTful → 逐步迁移，核心链路先改gRPC
  新系统 → 内部通信直接gRPC，对外暴露RESTful

决策矩阵：
  ┌───────────────┬──────────┬───────────┐
  │               │ gRPC     │ RESTful   │
  ├───────────────┼──────────┼───────────┤
  │ 序列化性能     │ 高(Protobuf)│ 中(JSON) │
  │ 传输体积       │ 小        │ 大         │
  │ 连接模型       │ 长连接+多路复用│ 短连接/keep-alive│
  │ 流式支持       │ 原生双向流 │ 不支持      │
  │ 代码生成       │ 自动生成   │ 手写/注解   │
  │ 调试便利性     │ 差(二进制) │ 好(可读)    │
  │ 浏览器支持     │ 有限      │ 原生        │
  │ 网关兼容       │ 弱        │ 强          │
  │ 多语言支持     │ 强        │ 强          │
  └───────────────┴──────────┴───────────┘

  架构师推荐：
    内部服务 → gRPC（性能优先）
    对外API → RESTful（通用性优先）
    混合模式 → gRPC内部 + RESTful网关暴露（gRPC-Gateway）
```

### Dubbo连接管理模型

```
Dubbo的连接模型：长连接复用

  单连接复用（Dubbo默认）：
    消费者A → 提供者B：一个TCP长连接
    所有请求复用这条连接
    请求/响应通过请求ID匹配（类似HTTP/2的多路复用）

    优点：连接数少，资源开销小
    缺点：单连接瓶颈——大请求体时会阻塞小请求

  多连接（配置connections参数）：
    消费者A → 提供者B：N个TCP长连接
    请求轮询分发到不同连接

    dubbo.protocol.connections=4

    优点：吞吐量更高，避免单连接瓶颈
    缺点：连接数增多，资源开销增大

  连接池模式：
    和HTTP连接池类似，池化复用
    Dubbo Triple协议（基于HTTP/2）→ 天然多路复用

  长连接复用 vs 连接池：
    ┌──────────────┬──────────────┬──────────────┐
    │              │ 长连接复用     │ 连接池        │
    ├──────────────┼──────────────┼──────────────┤
    │ 连接数       │ 少(1-N)      │ 多(按需创建)   │
    │ 资源开销     │ 小            │ 中            │
    │ 吞吐量       │ 中            │ 高            │
    │ 实现复杂度   │ 中(需请求ID匹配)│ 低(标准池化)  │
    │ 典型实现     │ Dubbo默认     │ HTTP Client   │
    └──────────────┴──────────────┴──────────────┘

  Dubbo3 Triple协议的变化：
    基于HTTP/2 → 天然多路复用 + 流式调用
    兼容gRPC → 可以和gRPC服务互通
    连接管理更简单：一个连接多路复用，不需要配置connections

  架构师决策：
    Dubbo默认单连接 → QPS<5000够用
    QPS>5000 → 配置connections=4或切Triple协议
    新项目 → 直接Triple协议（HTTP/2+多路复用+兼容gRPC）
```

### 服务调用超时与重试策略

```
超时策略设计：

  三层超时：
    网关超时 → 服务超时 → 下游调用超时

    网关超时（最外层）：30秒
    服务超时（中间层）：10秒
    下游调用超时（最内层）：3秒

    原则：内层超时 < 外层超时
    为什么？内层超时后走降级，外层还没超时 → 有时间做降级处理

    反例：内层超时10秒，外层超时3秒 → 内层还没超时，外层已经返回超时
    → 用户体验差 + 内层请求还在跑（资源浪费）

重试的三大坑：

  坑1：非幂等操作重试 → 数据重复
    订单创建（非幂等）→ 重试 → 创建了两个订单
    解决：
      - 非幂等操作不重试，只做降级
      - 或先做幂等改造（唯一业务号+去重表）

  坑2：重试风暴 → 雪崩
    服务A调B超时 → A重试3次 → B更忙 → 更多超时 → 更多重试
    解决：
      - 重试次数≤2，间隔递增（指数退避）
      - 熔断器优先：先熔断，再重试
      - 重试不是给所有超时都重试——被熔断的不重试

  坑3：超时叠加 → 用户等太久
    A调B超时3秒 + 重试2次 = 最长等9秒
    A还要调C超时3秒 + 重试2次 = 再等9秒
    用户总共等18秒 → 不可接受

    解决：
      - 总超时控制：A的总超时10秒，不管内部重试几次
      - 超时预算：分配给B的预算5秒，C的预算5秒
      - B超时3秒+重试1次=6秒 > 预算5秒 → 只重试0次

Dubbo的超时+重试配置：

  // 推荐配置
  @DubboReference(
      timeout = 3000,        // 超时3秒
      retries = 1,           // 重试1次（总共调用2次）
      cluster = "failover"   // 失败自动切换实例重试
  )
  private OrderService orderService;

  // 非幂等操作
  @DubboReference(
      timeout = 3000,
      retries = 0,           // 不重试！
      cluster = "failfast"   // 快速失败
  )
  private PaymentService paymentService;

超时+重试+熔断的配合：

  正常链路：超时3秒 → 重试1次 → 总共6秒
  熔断触发后：不超时不等，直接快速失败 → 毫秒级降级
  熔断恢复后：HALF_OPEN放一个请求探测 → 成功则恢复重试

  配合原则：
    熔断 > 重试 > 超时
    先看熔断器状态：OPEN → 不重试，直接降级
    HALF_OPEN → 放一个请求，不重试
    CLOSED → 正常超时+重试逻辑

  和Day2的知识串联：
    熔断策略选哪种？看故障模式
    慢调用比例 → 超时但没报错 → 重试可能有用
    异常数 → 每次都报错 → 重试只会加重负担 → 不重试
    这就是为什么"熔断策略决定重试策略"
```

### 与架构师水平的差距

| 层次 | 回答 |
|------|------|
| 开发 | 用Dubbo调服务，配个超时时间 |
| 高级开发 | gRPC性能好，Dubbo用长连接，超时+重试防雪崩 |
| 架构师 | gRPC vs RESTful不是性能问题，是五维决策框架（场景/性能/团队/生态/演化），内部gRPC对外RESTful是常见组合。Dubbo默认单连接复用（请求ID匹配），QPS>5000配多连接或切Triple。超时设计三层嵌套且内&lt;外，重试三大坑（非幂等/风暴/叠加）的核心解法是：非幂等不重试、指数退避+熔断优先、总超时预算控制。熔断策略决定重试策略——异常数熔断则不重试 |

**补足方向**：能写出三层超时的嵌套关系（网关30s>服务10s>下游3s）。重试策略能说清"什么时候不重试"比"什么时候重试"更重要。熔断和重试的配合关系能画流程图。

---

*日期：2026-05-27 | 第5周 Day3 | 微服务核心基础设施*
