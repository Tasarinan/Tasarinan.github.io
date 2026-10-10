# 架构师学习-Day01-IoC容器启动流程

> 日期：2026年09月07日（周一）
> 周主题：Spring 核心源码第1周 - IoC 容器启动流程 / Bean 生命周期与扩展点 / 循环依赖三级缓存 / AOP 与动态代理 / 实战综合
> 出题日：Day01 - IoC 容器启动流程

---

## 背景

经过 16 周专题训练（CAP/MQ/微服务/MySQL/Redis/ES/限流降级/支付/医疗×2/K8s + 简历项目打磨 + JVM×2 + 并发 + Netty），知识库里唯一没系统过的大空洞就是 **Spring 源码**——而这恰恰是 Java 架构师面试的第一高频。所有往周专题（事务、锁、线程池、网关）最终都跑在 Spring 容器之上，容器没搞透，往周的"深挖"都悬在半空。

架构师面试官问 Spring 从不问"注解怎么用"，而是：

> "new AnnotationConfigApplicationContext() 到第一个 Bean 就绪，中间发生了什么？"
> "三级缓存里存的到底是什么对象？为什么第三级必须是 ObjectFactory 而不能直接放 Bean？"（Day03）
> "你们服务启动 8 分钟，发布窗口怎么算的？启动耗时怎么治？"
> "处方服务里 @Transactional 自调用失效，线上资损了，根因是什么？"（Day04）

**Day01 为什么从容器启动流程开始**：Bean 生命周期、循环依赖、AOP 代理创建，全部发生在 `refresh()` 的 `finishBeanFactoryInitialization()` 之后。不懂容器的启动两阶段设计，就看不懂 Bean 生命周期在哪个舞台上演、循环依赖是谁在救场、AOP 代理是谁创建的。

**与往周专题的衔接点**：

- **JMM（并发周 Day01）** vs **单例 Bean 可见性**：请求线程通过 getBean() 拿到的单例，其构造期间的字段写为什么可见——singletonObjects 是 ConcurrentHashMap，happens-before 靠它建立；但 Bean 自己的可变字段没有任何保护（第 6 问）
- **JDK 动态代理（并发周 Day02）** vs **Spring AOP（Day04）**：动态代理的"怎么造"已讲过，本周补"谁在生命周期哪一步造、为什么自调用会绕过代理"
- **类加载机制（JVM 第1周 Day04）** vs **@Configuration 增强类**：ConfigurationClassPostProcessor 用 CGLIB 生成的配置类增强子类全部进 Metaspace——动态生成类是 Metaspace 撑大的隐性来源
- **K8s 发布工程（K8s 周 Day02）** vs **启动耗时**：启动耗时直接决定滚动发布批次窗口与 readiness 探针配置（第 5 问算发布窗口账）
- **MyBatis Mapper 扫描**：@MapperScan 就是 BeanDefinitionRegistryPostProcessor + FactoryBean——问诊系统每天在用却没看过它的容器视角

**与简历项目的衔接点**：

1. **启动耗时治理**：在线问诊系统依赖多（MySQL/Redis/ES/MQ/医保渠道），启动慢影响发布窗口——Day01 第 5 问 + Day05 实战的简历亮点素材
2. **Bean 初始化顺序**：医保对接模块的渠道客户端必须在配置加载后初始化——@DependsOn 与生命周期顺序问题
3. **有状态单例事故**：处方编号生成器 / SimpleDateFormat 字段在并发下的错乱——第 6 问

---

## 热身题（TCP/HTTPS 八股）

### 热身题1：三次握手、SYN Flood 与 backlog

**为什么是三次，不是两次**：握手本质是双方各自确认"我的发送、对方的接收"这对通路正常，共四件事（C确认收发、S确认收发），SYN+ACK 合并后压成三次。两次的致命问题：失效的历史 SYN（旧连接的重复请求绕路迟到）到达服务端会**直接建立连接并分配资源**，而客户端根本不认这个连接——服务端单方面挂一堆"僵尸半开连接"。第三次 ACK 给了客户端一个否决机会（可回 RST）。**为什么不是四次**：服务端的 ACK 与 SYN 没有信息依赖，拆开发没有额外收益，纯粹浪费一个 RTT。

**SYN Flood 为什么能打死服务端**：攻击者伪造源 IP 狂发 SYN、不回第三次 ACK，服务端为每个半开连接分配条目并重发 SYN-ACK，**半连接队列（SYN queue）被打满**，正常用户的 SYN 被丢弃。注意资源账：服务端没建立任何完整连接，纯粹被"握手的一半"拖死——攻击成本（发包）远低于防御成本（每个条目+定时器重传）。

**syn cookie**：队列将满时不再保存半连接状态，把连接四元组+时间戳哈希编码进 SYN-ACK 的初始序列号（ISN）；收到第三次 ACK 时验证 `ack-1` 是否等于该哈希，通过才在**全连接队列**建真正的 sock。本质是**用无状态换有状态**——把状态从内核内存挪到报文序号里。代价：握手期无法使用部分 TCP options（窗口缩放等，后续内核有扩展补偿）。

**backlog 满了会怎样**：backlog 定义的是**全连接队列**（accept queue）上限，实际长度 = `min(backlog, somaxconn)`。三次握手完成、但应用 accept 不及时 → 全连接队列溢出 → 默认（`tcp_abort_on_overflow=0`）内核**直接丢弃第三次 ACK**，客户端认为连接已建立开始发数据，服务端却在重传 SYN-ACK，表现为"连接超时/写失败"——**客户端看是 established、服务端看是 SYN_RECV 的诡异错位**，排查靠 `ss -lnt` 的 Recv-Q（当前全连接队列积压）。衔接 Netty 周：Netty 的 `SO_BACKLOG` 参数就是它，容量推演"峰值建连速率 × accept 处理时长 × 冗余"的落点。

### 热身题2：四次挥手、TIME_WAIT 与重连风暴

**为什么比握手多一次**：TCP 全双工，两个方向独立关闭。被动方收到 FIN 时**可能还有数据没发完**（半关闭状态），所以"确认对方的 FIN"和"发出自己的 FIN"通常分两个包。**CLOSE_WAIT 是谁的等待**：是被动关闭方收到 FIN、回了 ACK 之后，**等应用层调用 close()** 的状态——大量 CLOSE_WAIT 停留 = 应用代码拿到 EOF 后没关 fd（连接泄漏），这是"网络问题"伪装下的"代码 bug"。

**TIME_WAIT 为什么 2MSL、为什么在主动关闭方**：两个理由，缺一不可：
1. **最后的 ACK 可能丢**：主动方的 ACK 丢了，对方会重传 FIN，必须留一个"人"应答，否则对方永远停在 LAST_ACK 重传
2. **让本连接的旧报文在网络中自然消亡**（MSL 是报文最大生存时间，2MSL 保证一个往返）：防止相同四元组的新连接收到旧连接的迟到报文造成数据污染

**重连风暴下 TIME_WAIT 堆积在哪侧**：**主动关闭方**。上周 Day06 重连风暴：10w 客户端断线重连，旧连接如果是客户端先关，客户端每条旧连接留一个 TIME_WAIT（持续 60s）。TIME_WAIT 本身不占端口，但对**同一个 server IP:port**，新连接的源端口必须与所有存活四元组不冲突 → 临时端口（`ip_local_port_range` 默认 32768~60999，约 2.8w 个）被 TIME_WAIT 吃光 → `connect()` 报 `Cannot assign requested address`，客户端"自己把自己锁死"。

**治理手段**（按优先级）：
1. **根本解：长连接保活**，不频繁断连（心跳保活 + 服务端不主动踢）
2. **重连打散**：随机抖动退避（上周 Day06 的错峰重连），把瞬时风暴摊平
3. **扩端口范围**：`ip_local_port_range` 调大（治标）
4. **`tcp_tw_reuse=1`**：仅对**主动发起连接**（客户端方向）生效，依赖 TCP 时间戳，允许复用超过 1s 的 TIME_WAIT 端口
5. **多源 IP 出连接**（客户端绑定多个本地 IP，四元组空间翻倍）
6. **反面教材**：`tcp_tw_recycle`（NAT 环境下把整个办公室的连接误杀，Linux 4.12 已删除）——架构师要知道"曾经有个错误答案被内核社区收回了"

---

## 题目一（IoC 容器启动全解题）：从 main() 到第一个 Bean 就绪

### 作答区

#### 1. 容器体系与三个"Bean"辨析

**BeanFactory 与 ApplicationContext：组合，不是继承重写**

```java
public interface ApplicationContext extends ListableBeanFactory, HierarchicalBeanFactory,
        MessageSource, ApplicationEventPublisher, ResourcePatternResolver, EnvironmentCapable { }

public abstract class AbstractApplicationContext extends DefaultResourceLoader
        implements ConfigurableApplicationContext {
    private DefaultListableBeanFactory beanFactory;   // ← 组合：内部持有一个"真正的容器"
}
```

- **BeanFactory** 是容器的最小内核：getBean / containsBean / isSingleton / getType / 别名——职责就是"按定义生产与管理 Bean"
- **ApplicationContext 在内核之上叠加四类周边设施**：国际化（MessageSource）、事件发布（ApplicationEventPublisher）、资源加载（ResourcePatternResolver）、环境抽象（EnvironmentCapable），以及父子容器（HierarchicalBeanFactory）

**关键认知（架构师必答点）**：ApplicationContext **不是重写了容器，而是组合了一个 DefaultListableBeanFactory**——`obtainFreshBeanFactory()` 拿到的就是它，所有 getBean 最终都委托进去。职责分离：**容器内核（怎么造 Bean）与容器周边设施（事件/资源/国际化）分离**，周边设施随时可以换实现而不动内核。

功能差异清单：

| 能力 | BeanFactory | ApplicationContext |
|---|---|---|
| Bean 生产/管理 | ✓ | ✓（委托内部 BeanFactory） |
| 默认实例化时机 | **懒加载**（getBean 才创建） | **启动时预实例化全部非懒加载单例** |
| BeanPostProcessor 注册 | 手动 addBeanPostProcessor | **自动检测并注册**（所有 BPP 定义自动生效） |
| 事件/监听器 | ✗ | ✓ |
| 国际化/资源/环境抽象 | ✗ | ✓ |

> 面试陷阱："ApplicationContext 启动就实例化所有单例"——对，但注意 `@Lazy` 的 Bean 例外；且这是 AbstractApplicationContext.refresh 的行为，不是接口语义。

**FactoryBean：生产 Bean 的 Bean**

```java
public interface FactoryBean<T> {
    T getObject() throws Exception;     // 返回真正注册进容器的对象
    Class<?> getObjectType();
    boolean isSingleton();
}
```

- 容器里注册的名字 `xxx` 对应两个对象：FactoryBean 本身（`getBean("&xxx")`）与 getObject() 的产物（`getBean("xxx")`，多数场景缓存复用）
- **为什么要有这层抽象**：第三方对象的构造逻辑复杂/需要编程式生成（不是"new + 反射赋值"能表达的），把它封装成"容器能理解的 Bean"——**把任意对象工厂接入 IoC 体系的统一适配器**

经典实现（衔接简历项目）：

| 框架 | FactoryBean | getObject() 返回什么 |
|---|---|---|
| MyBatis | MapperFactoryBean | **JDK 动态代理**（MapperProxy）——接口没有实现类，代理拦截方法翻译成 SQL（并发周 Day02 动态代理的业务级应用） |
| MyBatis | SqlSessionFactoryBean | SqlSessionFactory |
| OpenFeign | FeignClientFactoryBean | 接口的 HTTP 代理 |
| Dubbo | ReferenceBean | RPC 代理 |

> 问诊系统每个 `XxxMapper` 注入的都是 MapperFactoryBean.getObject() 产出的代理对象——"MyBatis 整合 Spring"的全部秘密就在 FactoryBean + BeanDefinitionRegistryPostProcessor（第 4 问）。

**BeanDefinition：图纸与产品分离**

BeanDefinition 是"Bean 的图纸"：beanClassName（**存的是字符串，不是 Class 对象**）、scope、lazyInit、primary、dependsOn、autowireCandidate、initMethod/destroyMethod、constructorArgumentValues、propertyValues、factoryBeanName/factoryMethodName。

"元数据与实例分离"带来的五项能力：

1. **延迟实例化**：先收集全部定义、加工定义，再统一实例化——**这是循环依赖能在实例化阶段被三级缓存化解的前提**（Day03）：依赖解析按"定义"找，实例化才能中途回头
2. **动态注册**：运行时 registerBeanDefinition——@Import、编程式注册、MyBatis 扫 Mapper 全靠它
3. **加工空间**：BFPP 的加工对象是图纸不是产品——改图纸零成本，改产品要重建
4. **父子定义合并**：getMergedBeanDefinition——XML 时代"公共配置抽取复用"的机制，注解时代仍在生效（Spring 的很多内部定义靠它）
5. **延迟类加载**：扫描阶段只存 className 字符串，实例化时才 loadClass——启动内存可控（第 2 问 ASM）

#### 2. 从 main() 到 refresh()

**`new AnnotationConfigApplicationContext(AppConfig.class)` 构造器三步**：

```java
public AnnotationConfigApplicationContext(Class<?>... componentClasses) {
    this();            // ① 无参构造
    register(componentClasses);   // ② 注册配置类
    refresh();         // ③ 启动主体
}
```

**① this() 里发生了什么**：

```java
public AnnotationConfigApplicationContext() {
    this.reader = new AnnotatedBeanDefinitionReader(this);     // 注册注解处理器
    this.scanner = new ClassPathBeanDefinitionScanner(this);
}
// AnnotatedBeanDefinitionReader 构造器 → AnnotationConfigUtils.registerAnnotationConfigProcessors：
//   注册 ConfigurationClassPostProcessor（BeanDefinitionRegistryPostProcessor）
//   注册 AutowiredAnnotationBeanPostProcessor（处理 @Autowired/@Value）
//   注册 CommonAnnotationBeanPostProcessor（处理 @Resource/@PostConstruct/@PreDestroy）
//   注册 EventListenerMethodProcessor（处理 @EventListener）
```

**架构师必答的认知**：@Autowired、@PostConstruct、@Configuration 的"魔法能力"**不是容器内核硬编码的，而是以普通 BeanDefinition 形式注册进来的后置处理器**。容器内核只认 BeanFactory/BeanDefinition/后置处理器协议，注解能力是"出厂预装的插件"。**内核 + 插件化**——这是 Spring 扩展性的根基（梳理篇展开）。

**② register() 把配置类变成什么**：AnnotatedBeanDefinitionReader.register → 配置类包装成 AnnotatedGenericBeanDefinition（记录类元数据与注解）→ registerBeanDefinition。**此时容器里只有配置类自己，还没有任何业务 Bean**。

**③ 扫描发生在哪里（高频误区）**：**不在构造器，在 refresh() 的 `invokeBeanFactoryPostProcessors` 阶段**——由 ConfigurationClassPostProcessor 解析配置类上的 @ComponentScan 才触发扫描。"new 一下就扫完了"是错的。

Boot 的对应关系：`SpringApplication.run` → createApplicationContext（AnnotationConfigServletWebServerApplicationContext）→ prepareContext（把主类注册为定义）→ **refreshContext（同样的 refresh）**。主类上的 @SpringBootApplication = @ComponentScan + @EnableAutoConfiguration，解析它们的仍是 ConfigurationClassPostProcessor。

**@ComponentScan 扫描链路**：

```
ClassPathBeanDefinitionScanner.doScan(basePackages)
  → findCandidateComponents: 包名转成 classpath*:com/xx/**/*.class 资源表达式
  → PathMatchingResourcePatternResolver 枚举出所有 .class 文件
  → CachingMetadataReaderFactory 逐个读 → SimpleMetadataReader（ASM 解析字节码，不加载类！）
  → 过滤器链: excludeFilters 排除 → includeFilters 匹配
  → @Component 派生判定: hasAnnotation 或 hasMetaAnnotation(@Component)
  → 独立且具体（非接口非抽象）→ 生成 ScannedGenericBeanDefinition → registerBeanDefinition
```

**@Component 派生判定原理**：@Service/@Repository/@Controller 的**元注解**是 @Component，扫描器用"注解上递归找元注解"判定（hasMetaAnnotation）——这就是"注解派生"机制，自定义组合注解（如内部的 @BizService）标注 @Component 也能被扫到。

**为什么用 ASM 不用反射**：类路径下可能有上千个类，反射判定注解要**先加载类**（触发类加载、静态初始化、占 Metaspace），其中绝大多数根本不是候选——成本浪费一个数量级。ASM 只读字节码元数据（类名/注解/接口），**不触发类加载**。与 BeanDefinition 存 className 字符串配合，形成"扫描不加载、实例化才加载"的延迟设计（衔接 JVM 周类加载）。

#### 3. refresh() 12 步全解

```java
public void refresh() throws BeansException, IllegalStateException {
    synchronized (this.startupShutdownMonitor) {
        prepareRefresh();                                 // 1
        ConfigurableListableBeanFactory beanFactory = obtainFreshBeanFactory();  // 2
        prepareBeanFactory(beanFactory);                  // 3
        postProcessBeanFactory(beanFactory);              // 4
        invokeBeanFactoryPostProcessors(beanFactory);     // 5 ★
        registerBeanPostProcessors(beanFactory);          // 6 ★
        initMessageSource();                              // 7
        initApplicationEventMulticaster();                // 8
        onRefresh();                                      // 9
        registerListeners();                              // 10
        finishBeanFactoryInitialization(beanFactory);     // 11 ★★
        finishRefresh();                                  // 12
    }
}
```

| 步骤 | 职责 | 备注 |
|---|---|---|
| 1 prepareRefresh | 设启动时间、active 标志、校验必需属性 | 早期事件列表初始化 |
| 2 obtainFreshBeanFactory | refreshBeanFactory + 返回内部 DefaultListableBeanFactory | 容器内核就位 |
| 3 prepareBeanFactory | 标准上下文特征：ClassLoader、SpEL 解析器、**注册 ApplicationContextAwareProcessor**、忽略 Aware 依赖接口、注册系统环境单例 | 最早的 BPP 在此注册 |
| 4 postProcessBeanFactory | 子类钩子 | Web 容器注册 request/session Scope |
| 5 invokeBeanFactoryPostProcessors | 执行全部 BFPP（含 RegistryPostProcessor）★ | **扫描与配置类解析在这** |
| 6 registerBeanPostProcessors | 实例化并注册全部 BPP ★ | 处理器队伍组建 |
| 7 initMessageSource | 国际化 | |
| 8 initApplicationEventMulticaster | 事件广播器 | 默认 SimpleApplicationEventMulticaster |
| 9 onRefresh | 子类钩子 | **Boot 在此创建内嵌 WebServer** |
| 10 registerListeners | 注册监听器（**只注册名字不实例化**） | 早期积压事件此刻补发 |
| 11 finishBeanFactoryInitialization | **冻结配置 + 预实例化全部非懒加载单例** ★★ | **启动耗时大头** |
| 12 finishRefresh | LifecycleProcessor.onRefresh（SmartLifecycle 启动，**Boot 在此启动 WebServer**）+ 发布 ContextRefreshedEvent | 容器就绪信号 |

**重点步骤 5：invokeBeanFactoryPostProcessors 内部秩序**

执行委托给 PostProcessorRegistrationDelegate，铁律是：**BeanDefinitionRegistryPostProcessor 先于普通 BFPP；同级内 PriorityOrdered → Ordered → 无序 三批执行**。

最关键的 RegistryPostProcessor 是 **ConfigurationClassPostProcessor**：

```
processConfigBeanDefinitions:
  解析 @Configuration 配置类
    → @ComponentScan 递归扫描（第 2 问链路）
    → @Import: 普通配置类 / ImportSelector / ImportBeanDefinitionRegistrar 三形态
    → @Bean 方法注册为 BeanDefinition（factoryMethod 指向配置类方法）
    → @ImportResource、接口 default 方法
  新解析出的配置类递归处理，直到没有新的定义产生（do-while 收敛循环）
```

**整个应用的 Bean 定义在第 5 步收齐**——这就是"注解驱动"的全部。MyBatis @MapperScan 的 ImportBeanDefinitionRegistrar 在此注册 MapperScannerConfigurer，后者（也是 RegistryPostProcessor）再注册所有 MapperFactoryBean 定义。

**重点步骤 6：registerBeanPostProcessors 为什么必须在 BFPP 之后**：BFPP 阶段可能产生**新的 BPP 定义**（@Bean 方法返回的处理器、Registrar 注册的处理器），先跑完第 5 步才能收齐全部 BPP。注册顺序同样是 PriorityOrdered → Ordered → 无序 → 内部 MergedBeanDefinitionPostProcessor → ApplicationListenerDetector 垫底。

**重点步骤 11：finishBeanFactoryInitialization**

```
conversionService 初始化 → freezeConfiguration()（定义冻结，此后图纸不再变）
→ preInstantiateSingletons(): 遍历全部 BeanDefinition
     非抽象 && 单例 && 非懒加载 → getBean(beanName) 触发完整生命周期（Day02 主题）
     FactoryBean: 本身实例化；getObject() 按 SmartFactoryBean.isEagerInit() 决定是否立刻调
→ 全部就绪后统一回调 SmartInitializingSingleton.afterSingletonsInstantiated（全量就绪信号）
```

**lazy 挡不住的 Bean**：BeanPostProcessor / BFPP 等容器基础设施（第 6 步就 getBean 提前实例化了）、被任何非懒加载 Bean 依赖的懒加载 Bean（依赖触发实例化）——lazy 只挡"没人主动要"的情况。

**synchronized 与失败补偿**：锁对象是 startupShutdownMonitor，防的是**启动与关闭并发**（Boot 关闭钩子与启动竞争）。中途抛 BeansException 时：`destroyBeans()`（销毁已创建单例，逆序回调 destroy）+ `cancelRefresh()`（active=false）再抛出——**副作用集中、清理路径单一**。

**两阶段设计的架构价值**（面试升维点）：

1. **先收齐/加工定义（纯元数据操作、可逆、无副作用），后统一实例化（副作用集中）**——所有 Bean 被同等加工，无一遗漏地享受全部 BFPP 产物
2. **循环依赖可解的前提**：依赖按定义解析、实例化才发生，A 造到一半发现需要 B 时能"先回头"（Day03 三级缓存的舞台）
3. **失败语义清晰**：定义阶段失败=零残留；实例化阶段失败=统一销毁点

同构类比：**编译器前端（解析/变换/无副作用）与后端（代码生成）**、**2PC 的 prepare 与 commit**、**K8s 的 dry-run 验证与 apply**。BFPP ≈ 编译期注解处理器（APT），BPP ≈ 运行期字节码增强——"编译期/运行期"两段扩展模型贯穿软件设计。

#### 4. 两类后置处理器

**核心对比**：

| 维度 | BeanFactoryPostProcessor | BeanPostProcessor |
|---|---|---|
| 加工对象 | **BeanFactory / BeanDefinition**（图纸） | **每个 Bean 实例**（产品） |
| 执行时机 | 容器启动早期，**任何单例实例化之前**，一次性 | 每个 Bean 初始化前后，随 getBean 反复执行 |
| 典型实现 | ConfigurationClassPostProcessor（注解解析）、PropertySourcesPlaceholderConfigurer（占位符替换）、MapperScannerConfigurer | AutowiredAnnotationBeanPostProcessor（@Autowired/@Value 注入）、CommonAnnotationBeanPostProcessor（@Resource/@PostConstruct）、ApplicationContextAwareProcessor（Aware 回调）、AbstractAutoProxyCreator（**AOP 代理创建**，Day04） |

**BeanDefinitionRegistryPostProcessor 为什么先于普通 BFPP**：它负责**注册/删除定义**（ConfigurationClassPostProcessor 就是它）——必须先"收齐图纸"，其他 BFPP 才能对完整图纸集加工（如占位符替换要能覆盖刚扫描出来的定义）。

**三批执行的保证**：PostProcessorRegistrationDelegate 先把当前所有 RegistryPostProcessor 定义按 `PriorityOrdered → getBean 实例化 → 排序执行`，再 Ordered 批，再无序批；普通 BFPP 同样三批。执行中新注册的处理器会被收敛循环捡起来再跑（直到没有新增）。

**"BPP 提前实例化"陷阱（生产级细节）**：registerBeanPostProcessors 阶段逐个 `getBean(BPP名)` 提前实例化——**排在后面的 BPP 不在前面 BPP 的加工名单里**。如果某个普通 Bean 被某个 BPP 依赖而提前实例化，它会错过后续 BPP 的加工，Spring 会打日志：

```
Bean 'xxx' is not eligible for getting processed by all BeanPostProcessors
(for example: not eligible for auto-proxying)
```

**看到这行日志 = 有 Bean 没被 AOP 增强/没被完整处理**——真实生产事故线索（事务/日志切面莫名失效的根因之一）。推论：BPP 及其依赖的 Bean 应保持"无注解注入"（构造器注入或 BeanFactoryAware），并尽早注册。

**Aware 系列是谁在什么时候回调**——两条路径，面试区分点：

| Aware 接口 | 回调者 | 时机 |
|---|---|---|
| BeanNameAware / BeanClassLoaderAware / BeanFactoryAware | **容器直接回调**（initializeBean 前段的 invokeAwareMethods，不经 BPP） | Bean 初始化期 |
| EnvironmentAware / ApplicationContextAware / ResourceLoaderAware… | **ApplicationContextAwareProcessor（一个 BPP）** 的 postProcessBeforeInitialization | prepareBeanFactory（第 3 步）注册，早于一切注解处理器 |

BeanFactory 级 Aware 走内核直调（因为它只依赖内核），ApplicationContext 级的必须经 BPP（因为内核不该感知 ApplicationContext 这层设施）——**两段 Aware 的分野本身就是"内核/周边设施"分层的证据**。

#### 5. 架构师视角——启动耗时治理

**第一步永远是度量，不是猜**：

```java
// Boot 2.4+：ApplicationStartup 缓冲区 + 端点暴露
new SpringApplicationBuilder(App.class)
    .applicationStartup(new BufferingApplicationStartup(2048)).run(args);
// application.yml: management.endpoints.web.exposure.include=startup
// GET /actuator/startup → StartupStep 树：每步名称/耗时/标签（哪个 Bean、哪个扫描路径）
```

辅助手段：`-verbose:class` 看类加载量、JFR 的 ClassLoading 事件、async-profiler wall-clock 模式抓启动火焰图、refresh 各阶段打点日志。

**耗时大头通常三类（用 /actuator/startup 验证）**：

1. **类路径扫描与配置类解析**：包路径过大（扫到 com 根包）、候选类过多、正则过滤器
2. **Bean 实例化——尤其是"启动即连远端"的 Bean**：连接池初始化（HikariCP/Druid 预热）、Redis/ES/MQ 客户端建连、**医保渠道 SSL 握手 + 专线探测**、@PostConstruct 里做 RPC 预热/数据预热
3. **自动装配条件评估**（Boot）：上千个 AutoConfiguration 的条件判定（9月第3周详讲）

**优化手段分层**：

| 层次 | 手段 | 收益 | 风险/边界 |
|---|---|---|---|
| 实例化范围 | 全局 `spring.main.lazy-initialization=true`（Boot 2.2+） | 大量 Bean 延迟到首请求 | 首请求慢、**配置错误延迟暴露**（Bean 坏了运行时才炸）、@Scheduled/Listener 失效需 LazyInitializationExcludeFilter 排除——适合开发/测试/Serverless，生产慎用 |
| 实例化范围 | 局部 @Lazy：报表导出、管理端、低频渠道 | 精准、安全 | 依赖图要理清 |
| 实例化并行 | `spring.main.bootstrap-executor`（Boot 3.2+ 后台线程初始化 Bean） | 依赖图有并行分支时收益 | 收益取决于依赖图形状（问诊系统一条链依赖并行度低） |
| 外部连接 | 连接池后台预热、@PostConstruct 只装配不建连、渠道探测异步化 | 消除启动期同步等待 | **fail-fast vs 降级启动的架构决策**：医保网关连不上要不要阻塞启动？（医疗场景答案：核心结算通道 fail-fast，非核心（短信/报表）异步重试——启动语义要按依赖分级） |
| 类加载/JVM | AppCDS 归档、CRaC checkpoint/restore（Boot 3.2+ 配套） | 毫秒~秒级恢复 | CRaC 需要进程快照支持（衔接 JVM 周）；适用 Serverless/弹性扩容 |
| AOT | Boot 3 Native Image：编译期完成 BFPP 类工作 | 启动 100ms 级 | 闭世界假设、反射/动态代理要配置、与 CGLIB/运行时增强冲突（AOP 需改 JDK 代理） |

**发布窗口账（衔接 K8s 周）**：

```
前提：5 实例，maxSurge=1 / maxUnavailable=0（逐台替换），readiness 间隔 15s，
     terminationGracePeriodSeconds=90，启动 8 分钟
每台周期 = 启动 8min + readiness 确认 ≈15s + 摘流后 drain 90s ≈ 9.25min
全量发布窗口 ≈ 5 × 9.25min ≈ 46min
启动提速到 3min → 每台 ≈ 4.25min → 窗口 ≈ 21min，节省一半以上
```

架构师要讲出的三句账：
1. **窗口越长，新旧版本共存时间越长**——接口兼容/数据兼容的暴露面越大（双写、灰度逻辑都要兼容两个版本）
2. **回滚 = 再付一次窗口**——启动慢的回滚更慢，故障恢复时间被启动时间放大
3. **启动抖动是探针杀手**：启动 8min 的服务，一次 GC/网络慢拖到 10min，livenessProbe initialDelay 设 8min 就会误杀重启循环——**用 startupProbe 保护慢启动，readinessPeriod 之前先过 startup 门槛**（K8s 1.16+）

#### 6. 并发视角——单例 Bean 的线程安全

**结论先行（JMM 语言）**：Spring 只保证**安全发布**——你通过 getBean() 拿到的单例，其构造与注入期间的字段写对你**可见**；但 Bean 自身**可变字段的并发读写没有任何保护**。安全发布 ≠ 线程安全。

**安全发布靠什么保证**：

```java
// DefaultSingletonBeanRegistry
private final Map<String, Object> singletonObjects = new ConcurrentHashMap<>(256);
```

- 启动期：主线程（refresh 单线程）创建单例 → 构造/属性填充的所有写都发生在 `singletonObjects.put(name, singleton)` **之前**
- 运行期：请求线程 getBean → getSingleton → `singletonObjects.get(name)`
- **JMM 推理**：ConcurrentHashMap 的写与后续读建立 happens-before（CHM 内部 volatile/锁语义），所以 put 之前的所有字段写，对 get 之后的读线程全部可见
- 运行期懒创建的 Bean（lazy/prototype）：getSingleton 用 synchronized(this.singletonObjects) 双重检查创建——互斥保证单例性，同一把锁保证可见性

**但拿到引用之后**：Bean 的非 final 可变字段是裸奔的——i++ 丢更新、SimpleDateFormat 内部 Calendar 复用错乱、HashMap 并发 put 丢数据/（JDK7 头插）成环，全部可能。

**有状态单例的两个典型事故**：

| 事故 | 根因 | 形态 | 修复 |
|---|---|---|---|
| SimpleDateFormat 静态/成员字段 | parse 复用内部 Calendar，非线程安全 | 日期错乱 / ArrayIndexOutOfBoundsException（低概率复现难） | **DateTimeFormatter（不可变，首选）** / ThreadLocal\&lt;SDF\> |
| 计数器/累加器 int 字段 | count++ 是读-改-写三步 | 丢失更新，计数偏小 | AtomicLong / LongAdder |
| 缓存用 HashMap 字段 | 并发 put 丢数据、resize 竞态 | 缓存偶发缺项 | ConcurrentHashMap |

**处方决策树**：

```
字段有并发访问吗？
 ├─ 没有（只读/不可变/final 初始化）→ 安全，保持
 ├─ 有 → 能无状态化吗？（字段改方法参数/局部变量）→ 优先无状态化（Spring 官方推荐的 Controller/Service 形态）
 │       └─ 状态必须驻留 → 并发容器/原子类/锁
 │               └─ 状态是"每请求/每线程独立"的 → ThreadLocal（线程池环境必须 finally remove——衔接并发周 ThreadLocal 泄漏事故）
 └─ 想用 prototype 逃避 → 小心失活陷阱 ↓
```

**prototype 注入单例的失活陷阱**：单例 A 注入 prototype B，注入**只在 A 创建时发生一次**——A 拿到的是"出生那刻的那一个 B"，此后每次用都是同一个，prototype 语义完全失效。解法：注入 `ObjectProvider<B>`（每次 getObject 拿新实例）/ @Lookup 方法注入 / ApplicationContext.getBean。**这与 @Async/@Transactional 自调用失效是"代理与作用域"两大经典失效家族的姊妹问题**（Day04 合并梳理）。

**Controller 里放成员变量存请求上下文会怎样**：请求 A 写入 userId，请求 B 读到 A 的 userId——**跨用户数据串号**。医疗语境下这就是"内存层的串档事故"（与医疗周 EMPI 串档同根：共享可变状态 + 并发，只是那笔在存储层、这笔在内存层），属于安全与合规级缺陷。正确姿势：请求状态走方法参数 / ThreadLocal（请求结束清理，Spring 的 RequestContextHolder 就是这么做的）/ Session。

**Servlet 是单例还是多例，与 Spring Bean 什么关系**：Tomcat 里一个 Servlet 类**默认单例**（整个容器一个实例服务全部请求）；Spring MVC 的 Controller 不是 Servlet，是 DispatcherServlet（单例）按映射分发的普通对象——**默认也是单例**。整个请求处理链（DispatcherServlet → HandlerAdapter → Controller → Service）设计前提就是**无状态管道**，状态只允许存在于：方法栈、请求/会话上下文、外部存储。

---

## 本日能力差距与补足方向

### 差距1：容器体系"组合而非重写"的结构答不出

- **现状**：知道 ApplicationContext 功能更多，但说不出它内部持有 DefaultListableBeanFactory、"内核与周边设施分离"的分层设计；FactoryBean 只记得" getObject 拿对象"，串不起 MyBatis Mapper 的代理链
- **架构师水平**：画出 ApplicationContext 组合 BeanFactory 的结构图，用"内核+插件+适配器"讲清 FactoryBean 是"任意对象工厂接入 IoC 的统一适配器"
- **补足方向**：读 AbstractApplicationContext.obtainFreshBeanFactory 与 AnnotationConfigUtils.registerAnnotationConfigProcessors 各一遍

### 差距2：refresh() 12 步讲不全，三大重点步骤职责边界模糊

- **现状**：能说出几个方法名，但 12 步顺序记不全；说不出扫描发生在第 5 步（高频误区是"构造器里就扫了"）、Boot 的 WebServer 在第 9/12 步创建与启动
- **架构师水平**：白板默写 12 步并标出三个★步骤的内部细节（BDRPP 先行三批执行 / BPP 提前实例化 / 冻结+预实例化）
- **补足方向**：对着 AbstractApplicationContext.refresh 源码抄写一遍并标注每步产出物；把 12 步做成卡片

### 差距3：BFPP/BPP 的时机、分层执行与"提前实例化陷阱"没掌握

- **现状**：两类后置处理器只会背定义；PriorityOrdered → Ordered → 无序三批、"RegistryPostProcessor 先行"、`not eligible for getting processed by all BeanPostProcessors` 日志的含义全部空白
- **架构师水平**：看到该日志立刻定位"某 Bean 错过了部分 BPP → 事务/切面可能失效"；讲清 BPP 依赖Bean 的编码纪律
- **补足方向**：把第 4 问对比表与两条 Aware 路径抄进笔记；在自己项目里搜这条日志

### 差距4："ASM 扫描 + className 字符串"的延迟类加载设计不知道

- **现状**：以为扫描就是反射加载类；不知道 BeanDefinition 存字符串、实例化才 loadClass——启动内存账与 Metaspace 的因果（衔接 JVM 周）断了
- **架构师水平**：讲清"扫描不加载、实例化才加载"两级延迟，并联系 CGLIB 增强类进 Metaspace 的账
- **补足方向**：读 ClassPathScanningCandidateComponentProvider.findCandidateComponents 与 SimpleMetadataReader

### 差距5：启动耗时治理没有方法论——不会度量、只会 lazy 一招

- **现状**：没用过 BufferingApplicationStartup / /actuator/startup；优化停留在"加 @Lazy"；全局 lazy 的风险（错误延迟暴露、Listener 失效）说不全
- **架构师水平**：度量先行 → 定位三类大头 → 分层施策（范围/并行/外部连接/类加载/AOT）；对外部依赖有"fail-fast vs 降级启动"的分级决策
- **补足方向**：给问诊系统配 /actuator/startup 跑一次启动画像；按第 5 问分层表产出一份启动优化清单

### 差距6：发布窗口账不会算，启动耗时与 K8s 发布工程没串起来

- **现状**：算不出"启动 8min × 5 台逐台替换"的全量窗口，讲不出"窗口→新旧共存→兼容暴露面、回滚→两次窗口、启动抖动→探针误杀"三笔账
- **架构师水平**：30 秒报出发布窗口公式并推 startupProbe 配置建议——把 JVM/Spring 层的启动优化翻译成发布工程收益，是面试的高区分度叙事
- **补足方向**：按第 5 问算一遍问诊系统的真实发布窗口；补 K8s 周 Day02 的差距（发布工程）

### 差距7：单例 Bean 线程安全只会答"有状态不安全"，说不出安全发布机制

- **现状**：知道"不要写可变字段"，但用 JMM 语言（singletonObjects 是 CHM、put/get 建 happens-before）解释"为什么构造期间的写对请求线程可见"答不出——并发周 JMM 与 Spring 的连接点悬空
- **架构师水平**：分"安全发布（容器保证）"与"线程安全（自己负责）"两层作答；对有状态单例能按决策树秒开处方
- **补足方向**：读 DefaultSingletonBeanRegistry.getSingleton；把第 6 问决策树内化成 code review checklist

### 差距8：prototype 失活陷阱不知道

- **现状**：没意识到单例注入 prototype 只注入一次；不知道 ObjectProvider/@Lookup 解法——与 Day04 的 @Transactional/@Async 自调用失效同属"作用域与代理"失效家族，缺一张全景图
- **架构师水平**：把"代理失效/作用域失效"两类家族题合并成一张失效地图（本周 Day04 收官时产出）
- **补足方向**：写一个单例注入 ObjectProvider\&lt;PrototypeBean\> 的 demo 验证多例语义

---

## 附录：本日关键认知速查

| 认知点 | 关键结论 |
|---|---|
| 容器关系 | ApplicationContext **组合** DefaultListableBeanFactory——内核与周边设施分离 |
| FactoryBean | 生产 Bean 的 Bean；getBean("x") 拿产品、getBean("&x") 拿工厂；Mapper = JDK 代理 |
| BeanDefinition | 图纸与产品分离；存 className 字符串非 Class；延迟实例化是循环依赖可解的前提 |
| 注解能力来源 | @Autowired/@PostConstruct 是"出厂预装的 BPP 插件"，不是内核硬编码 |
| 扫描时机 | refresh 第 5 步（ConfigurationClassPostProcessor），**不在构造器** |
| 扫描实现 | ASM 读字节码元数据不加载类；@Component 派生靠元注解递归查找 |
| refresh 铁律 | BDRPP 先于 BFPP；同级 PriorityOrdered → Ordered → 无序 |
| BPP 陷阱日志 | `not eligible for getting processed by all BeanPostProcessors` = 有 Bean 错过 BPP 加工（切面/事务可能失效） |
| Aware 两条路径 | BeanFactory 级容器直调；ApplicationContext 级走 ApplicationContextAwareProcessor（BPP） |
| 预实例化 | 第 11 步冻结配置后 preInstantiateSingletons；SmartInitializingSingleton 是全量就绪信号 |
| 启动度量 | BufferingApplicationStartup + /actuator/startup（Boot 2.4+） |
| 全局 lazy 风险 | 首请求慢、错误延迟暴露、@Scheduled/Listener 失效 |
| 发布窗口 | ≈ 实例数 × (启动 + readiness 确认 + drain)；启动慢 → 新旧共存久、回滚慢、探针易误杀（用 startupProbe） |
| 安全发布 | singletonObjects 是 CHM，put/get 建 happens-before——构造期间的写对请求线程可见 |
| 线程安全 | Bean 可变字段裸奔；SimpleDateFormat/计数器/HashMap 三大事故；优先无状态化 |
| prototype 失活 | 单例注入 prototype 只注入一次；解法 ObjectProvider/@Lookup/getBean |
| Servlet 关系 | DispatcherServlet 单例，Controller 是它分发的普通单例对象——请求链=无状态管道 |
| TIME_WAIT 治理 | 长连接保活 > 打散 > 扩端口 > tw_reuse；tcp_tw_recycle 已废除（NAT 灾难） |
| SYN Flood | syn cookie 用无状态换有状态（编码进 ISN）；backlog= 全连接队列，满则丢 ACK |
