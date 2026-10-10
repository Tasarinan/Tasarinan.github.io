# 架构师学习-Day04-类加载机制与字节码

> 日期：2026年07月30日（周四）
> 周主题：JVM 专题第 1 周 - JVM 基础与核心
> 出题日：Day04 - 类加载机制与字节码基础

---

## 背景

Day01 讲了 JVM 内存模型与对象生命周期——堆 / 栈 / 方法区 / 元空间 / 直接内存的内存区域划分，对象从 `new` 到分配完成的流程，对象内存布局（Mark Word + 类型指针 + 数组长度），逃逸分析基础。这些是"运行时数据区层面"，回答的是"对象放在哪里"。

Day02 讲了 GC 算法与分代收集理论——标记清除 / 复制 / 标记整理三种基础算法，跨代引用、Card Table、写屏障、Safepoint、并发标记。这些是"算法层面"，回答的是"GC 怎么标记对象"。

Day03 讲了 GC 收集器全谱系——Serial / Parallel / CMS / G1 / ZGC / Shenandoah 七种收集器的设计哲学、适用场景、调优参数。这些是"工程层面"，回答的是"生产中用哪种 GC"。

Day04 进入"类生命周期与字节码层面"，回答的是"类从 .class 文件到可用对象的完整链路"。这是 JVM 五大核心（内存 / GC / 类加载 / JIT / 并发）中面试官最爱深挖的一块——因为类加载是**架构师做技术选型时的常见决策点**（如 SPI 扩展、热部署、依赖隔离、模块化）。

**为什么 Day04 重要**：

1. **类加载是架构师做扩展性的核心抓手**：Dubbo SPI、Spring Boot SPI、Tomcat WebappClassLoader、OSGi 模块化——这些工业级框架都建立在"打破双亲委派"之上
2. **生产事故 30% 与类加载相关**：Jar 冲突、`ClassNotFoundException`、`NoSuchMethodError`、`LinkageError`、循环依赖、热部署失效——这些坑每个 Java 工程师都踩过
3. **字节码是理解 AOP / 动态代理 / 反射性能的基础**：Spring AOP 用 CGLIB / JdkDynamicAopProxy，MyBatis 用 MapperProxy，RPC 用字节码生成 Stub——理解栈帧结构与方法调用指令，才能讲清这些技术的性能边界
4. **JDK 升级必考**：JDK 9 模块化对类加载的破坏性变更、JDK 11+ 移除 EE 模块、JDK 17 强封装——升级时类加载冲突是头号雷区

**与前 3 天的衔接**：

- Day01 讲了"对象在堆中的内存布局"，Day04 讲"类元信息在元空间中的存储（Klass Pointer）"——两者通过对象头的类型指针关联
- Day01 讲了"方法区 / 元空间演进"，Day04 讲"类信息如何进入元空间（加载 -> 验证 -> 准备 -> 解析 -> 初始化）"
- Day02 讲了"GC Roots 包含静态变量、常量、本地方法栈"，Day04 讲"准备阶段给静态变量赋零值、初始化阶段给静态变量赋真实值、`<clinit>` 方法何时调用"
- Day03 讲了"G1 回收元空间中的卸载类（Class Unloading）"，Day04 讲"类卸载的条件（ClassLoader 可达性分析）"

**与往周专题的衔接点**：

- **Dubbo SPI vs Java SPI** vs **类加载器**：Dubbo SPI 用 `ExtensionLoader` 解决 Java SPI 不支持依赖注入与自适应扩展的问题，但底层仍是类加载（呼应 5月第4周 MQ / 6月第5周微服务）
- **Tomcat WebappClassLoader** vs **Spring Boot LaunchedURLClassLoader**：都是打破双亲委派的工业级实现，但目标不同——Tomcat 为 Web 应用隔离，Spring Boot 为 Fat Jar 启动（呼应 6月第5周微服务）
- **Spring AOP CGLIB** vs **JDK Dynamic Proxy**：CGLIB 字节码生成子类，JDK 动态代理基于接口，性能差异与方法调用指令 `invokevirtual` vs `invokeinterface` 相关
- **MyBatis MapperProxy** vs **RPC Stub 生成**：都用字节码增强，但 MapperProxy 用 JDK 动态代理，Dubbo / gRPC Stub 用 ASM 字节码生成（呼应 5月第4周 MQ、6月第5周微服务）
- **K8s 容器化与类共享**：CDS / AppCDS 在容器镜像中如何复用，影响启动速度（呼应 7月第3周）

**与简历项目的衔接点**：

在线问诊系统的类加载场景：

1. **IM 网关（Netty）**：Netty 4.x vs 3.x 字节码不兼容，曾出现 `NoSuchMethodError` 排查一整天
2. **视频问诊 SFU**：Kurento / Janus 客户端 SDK 用了大量 native 库，类加载时要先 `System.loadLibrary`
3. **MongoDB Driver**：BSON 编解码器用反射动态加载 `Codec<?>`，类加载器隔离不当会泄漏
4. **TCC 分布式事务**：Try / Confirm / Cancel 三个阶段用 Spring AOP 拦截，CGLIB 字节码生成是性能关键
5. **医疗 HL7 / FHIR 解析**：HAPI FHIR 库依赖大量注解处理器，启动慢——可用 AppCDS 优化
6. **动态配置中心**：Apollo / Nacos 热更新配置，触发 Spring `@Value` 重新绑定，本质是反射 + 字节码增强

Day04 会针对每个场景讲清类加载与字节码的角色。第 2 周 Day05 在线问诊 JVM 实战时深入。

---

## 题目一（原理深挖题）：类加载机制与字节码基础

请详细回答以下问题：

1. **类加载的完整流程**：一个 `.class` 文件到 JVM 中可用对象，需要经历哪些阶段？加载 / 验证 / 准备 / 解析 / 初始化 / 使用 / 卸载 7 个阶段各自做什么？验证阶段有哪 4 类验证（文件格式 / 元数据 / 字节码 / 符号引用）？准备阶段给静态变量赋零值还是初始值？`<clinit>` 方法何时调用？接口是否有 `<clinit>` 方法？什么情况下会触发类初始化（6 种主动引用）？什么情况下不触发（3 种被动引用）？
2. **双亲委派模型**：JVM 内置的 3 种类加载器（Bootstrap / Extension-Platform / Application）各自加载什么路径？双亲委派的"委派"与"回溯"流程？为什么需要双亲委派（安全 + 一致性）？JDK 9 之后 ExtensionClassLoader 改为 PlatformClassLoader 的原因？如何自定义类加载器（继承 `ClassLoader` 重写 `findClass` vs `loadClass`）？为什么 Tomcat 重写 `loadClass` 而不是 `findClass`？
3. **打破双亲委派的 4 种场景**：JDBC SPI（DriverManager 用 Thread Context ClassLoader）为什么需要打破？Tomcat WebappClassLoader 的隔离策略（Web 应用之间互不可见、Web 应用优先于父加载器）？OSGi 的网状类加载模型？热部署（OSGi / JRebel / Arthas redefine）的实现原理？`Class.forName` 与 `ClassLoader.loadClass` 的区别（初始化 vs 不初始化）？
4. **字节码与栈帧结构**：`javap -v -p` 输出的字节码包含哪些部分（常量池 / 字段表 / 方法表 / 属性表）？一个方法的栈帧包含什么（局部变量表 / 操作数栈 / 动态链接 / 返回地址）？局部变量表 Slot 的复用规则（Slot 复用引发的 GC 陷阱）？方法调用的 5 个字节码指令（`invokestatic` / `invokespecial` / `invokevirtual` / `invokeinterface` / `invokedynamic`）？`invokedynamic` 为什么是 JDK 7 最重要的字节码指令（Lambda / Groovy / JRuby 都依赖）？
5. **Spring Boot 类加载与字节码增强**：Spring Boot Fat Jar 的 `org.springframework.boot.loader` 如何启动？`LaunchedURLClassLoader` 与 `AppClassLoader` 的关系？`BOOT-INF/classes` 与 `BOOT-INF/lib` 如何加载？Spring AOP 中 CGLIB 与 JdkDynamicAopProxy 的字节码生成差异？CGLIB 生成子类的字节码为什么不能 `final` 类？JDK 17 强封装（`--add-opens`）对字节码增强（CGLIB / 反射）的破坏性影响？

### 作答区

#### 1. 类加载的完整流程

**类加载 7 阶段**：

```
.class 文件
    │
    ▼
┌──────────┐  ┌─────────────────────────────────┐  ┌──────────┐  ┌──────────┐
│  加载    │->│  验证 / 准备 / 解析 (链接阶段)   │->│  初始化   │->│ 使用 / 卸载 │
└──────────┘  └─────────────────────────────────┘  └──────────┘  └──────────┘
   │              │       │         │                  │
   │              │       │         │                  │
   通过类的       文件    静态      符号引用            执行 <clinit>
   全限定名       元数据  变量      解析为              赋真实值
   获取字节流     字节码  赋零值    直接引用            静态代码块
   生成 Klass    验证    分配      (可选的             父类 <clinit>
   对象放入      4 类    方法区    lazy resolution)    先于子类
   方法区                空间
```

**加载阶段**：

- 通过类的全限定名获取定义此类的二进制字节流（来源：Jar / 网络 / 动态生成 / JSP 编译 / `defineClass`）
- 将字节流转化为方法区的运行时数据结构（Klass Pointer）
- 在堆中生成一个 `Class<?>` 对象，作为方法区数据的访问入口

**验证阶段（4 类验证）**：

1. **文件格式验证**：魔数 `0xCAFEBABE`、主次版本号、常量池索引合法性
2. **元数据验证**：类是否有父类、是否继承 `final` 类、是否实现所有接口方法
3. **字节码验证**：方法体语义合法性、操作数栈类型匹配、跳转指令目标合法
4. **符号引用验证**：解析阶段前，符号引用对应的类 / 字段 / 方法是否真实存在、是否可访问（`public` / `private` 检查）

**准备阶段**：

- 给**静态变量**（`static`）在方法区分配内存并赋**零值**（不是初始值）
- `static int a = 123;` 准备阶段 `a = 0`，初始化阶段 `a = 123`
- `static final int b = 123;`（ConstantValue 属性）准备阶段 `b = 123`，因为 `final` 常量在编译期确定

**解析阶段**：

- 将常量池中的**符号引用**替换为**直接引用**
- 符号引用：字符串形式的引用（如 `Ljava/lang/String;`、`"java/lang/Object.hashCode:()I"`）
- 直接引用：内存地址 / 偏移量 / 句柄
- **Lazy Resolution**：HotSpot 默认在第一次使用时才解析（类初始化时不全部解析）

**初始化阶段**：

- 执行类构造器 `<clinit>` 方法（编译器自动收集**所有静态变量的赋值** + **所有静态代码块** `static {}` 合并产生）
- JVM 保证 `<clinit>` 在多线程下被正确加锁同步，所以**单例可以用静态内部类实现**（线程安全）
- 父类的 `<clinit>` 先于子类执行（保证父类静态变量已初始化）
- 接口也有 `<clinit>` 方法（JDK 8+ 接口可以有 `default` 方法和静态方法），但接口 `<clinit>` 不需要先执行父接口的 `<clinit>`

**6 种主动引用（触发初始化）**：

1. `new` / `getstatic` / `putstatic` / `invokestatic` 4 个字节码指令（new 实例 / 读写静态字段 / 调用静态方法）
2. 使用 `java.lang.reflect` 包的方法对类型进行反射调用
3. 初始化子类时，父类还没初始化，先触发父类初始化
4. JVM 启动时的主类（包含 `main` 方法的类）
5. `MethodHandle` 句柄对应的类（`REF_getStatic` / `REF_putStatic` / `REF_invokeStatic`）
6. 接口含 `default` 方法时，实现类初始化触发接口初始化（JDK 8+ 新增）

**3 种被动引用（不触发初始化）**：

1. 通过子类访问父类的静态字段，只触发父类初始化，不触发子类初始化
   ```java
   class Parent { static int value = 123; }
   class Child extends Parent {}
   System.out.println(Child.value);  // 只初始化 Parent，不初始化 Child
   ```
2. 通过数组定义引用类，不触发类初始化
   ```java
   Child[] arr = new Child[10];  // 不会触发 Child 初始化
   // JVM 会生成一个 [Lcom.example.Child; 的数组类
   ```
3. 常量在编译期进入常量池，引用常量不触发类初始化
   ```java
   class Const { static final String NAME = "hello"; }
   System.out.println(Const.NAME);  // 编译期已优化为 "hello"，不触发 Const 初始化
   ```

#### 2. 双亲委派模型

**3 种内置类加载器**：

```
┌──────────────────────────────────┐
│  Bootstrap ClassLoader           │  (C++ 实现，JVM 内部)
│  加载：$JAVA_HOME/lib 目录        │  加载 rt.jar、resources.jar
│  无法被 Java 代码直接引用         │  String.class.getClassLoader() == null
└──────────────────────────────────┘
              ▲
              │ 父加载器
┌──────────────────────────────────┐
│  Extension / Platform ClassLoader│  (Java 实现，ExtClassLoader)
│  JDK 8：$JAVA_HOME/lib/ext       │  JDK 9+ 改名 PlatformClassLoader
│  JDK 9+：$JAVA_HOME/lib/ext +    │  加载平台模块
│           jdk.* 模块              │
└──────────────────────────────────┘
              ▲
              │ 父加载器
┌──────────────────────────────────┐
│  Application ClassLoader         │  (AppClassLoader)
│  加载：-classpath / -cp /         │  默认用户类加载器
│        CLASSPATH 环境变量         │
│        JDK 9+：module path       │
└──────────────────────────────────┘
              ▲
              │ 父加载器
┌──────────────────────────────────┐
│  Custom ClassLoader              │  用户自定义
│  Tomcat / Spring Boot / OSGi     │
└──────────────────────────────────┘
```

**双亲委派的"委派"与"回溯"流程**：

```java
// ClassLoader.loadClass 的双亲委派实现
protected Class<?> loadClass(String name, boolean resolve) {
    // 1. 检查是否已加载
    Class<?> c = findLoadedClass(name);
    if (c == null) {
        try {
            // 2. 委派给父加载器
            if (parent != null) {
                c = parent.loadClass(name, false);
            } else {
                c = findBootstrapClassOrNull(name);
            }
        } catch (ClassNotFoundException e) {
            // 父加载器找不到，不处理
        }
        if (c == null) {
            // 3. 回溯：父加载器找不到，自己找
            c = findClass(name);
        }
    }
    return c;
}
```

**为什么需要双亲委派**：

1. **安全**：防止用户伪造核心类（如 `java.lang.String`）覆盖系统类。用户写的 `java.lang.String` 委派给 Bootstrap 加载 `rt.jar` 中的 `String`，用户的 `String` 被忽略
2. **一致性**：同一个类只加载一次。`String.class` 在整个 JVM 中只有一个 `Class` 对象，类型比较才有意义（`instanceof`、`equals`）
3. **层级清晰**：核心类由 Bootstrap 加载，扩展类由 Extension 加载，应用类由 Application 加载，职责分明

**JDK 9 之后的类加载器变化**：

- **ExtensionClassLoader 改为 PlatformClassLoader**：JDK 9 引入模块化，`ext` 目录不再使用，平台模块（`java.sql`、`java.xml` 等）由 PlatformClassLoader 加载
- **Boot Class Path 变为 Boot Modules**：`-Xbootclasspath` 改为 `-Xbootclasspath/a`（追加）和模块路径
- **Application ClassPath 变为 Class Path + Module Path**：兼容旧 Jar 但推荐模块化

**自定义类加载器的两种方式**：

1. **继承 `ClassLoader` 重写 `findClass`**（推荐）：
   ```java
   public class MyClassLoader extends ClassLoader {
       @Override
       protected Class&lt;?> findClass(String name) throws ClassNotFoundException {
           byte[] bytes = loadClassData(name);  // 自定义加载逻辑
           return defineClass(name, bytes, 0, bytes.length);
       }
   }
   ```
   保持双亲委派（不重写 `loadClass`），只在父加载器找不到时自己找

2. **继承 `ClassLoader` 重写 `loadClass`**（破坏双亲委派）：
   ```java
   public class TomcatClassLoader extends URLClassLoader {
       @Override
       protected Class&lt;?> loadClass(String name, boolean resolve) {
           // 1. 自己先找（Web 应用优先）
           Class&lt;?> c = findClass(name);
           if (c == null) {
               // 2. 找不到才委派给父
               c = super.loadClass(name, resolve);
           }
           return c;
       }
   }
   ```

**为什么 Tomcat 重写 `loadClass` 而不是 `findClass`**：

- Tomcat 需要让 **Web 应用之间互不可见**（每个 Web 应用一个 `WebappClassLoader`）
- Tomcat 需要让 **Web 应用优先于父加载器**（避免应用类被父加载器加载）
- 因此必须在 `loadClass` 阶段就介入，改变委派顺序

#### 3. 打破双亲委派的 4 种场景

**场景 1：JDBC SPI（Thread Context ClassLoader）**

JDBC 4.0 开始支持 SPI 自动发现 Driver：

```java
// DriverManager 在 rt.jar 中，由 Bootstrap 加载
// 但 Driver 实现在 classpath 上（如 mysql-connector-java.jar），由 AppClassLoader 加载
// Bootstrap 加载的类看不到 AppClassLoader 加载的类

DriverManager.getConnection(url);
// 内部用 ServiceLoader.load(Driver.class)
// ServiceLoader 用 Thread.currentThread().getContextClassLoader()
// 这个 ClassLoader 默认是 AppClassLoader
// 通过 TCCL 打破双亲委派
```

**核心矛盾**：Bootstrap 加载的 `DriverManager` 需要加载 AppClassLoader 的 `Driver` 实现，但 Bootstrap 看不到 AppClassLoader 的类。

**解决方案**：`Thread Context ClassLoader`（TCCL）—— 父加载器通过线程上下文获取子加载器，反向使用子加载器加载类。

**场景 2：Tomcat WebappClassLoader**

```
Tomcat 类加载器层级：

Bootstrap
   ▲
Platform
   ▲
Application
   ▲
CatalinaClassLoader   (Tomcat 自身的类)
   ▲
SharedClassLoader     (多个 Web 应用共享的类)
   ▲
┌──────────────────┐  ┌──────────────────┐
│WebappClassLoader1│  │WebappClassLoader2│  (每个 Web 应用一个)
│  /webapps/app1   │  │  /webapps/app2   │
└──────────────────┘  └──────────────────┘
```

**Tomcat 的隔离策略**：

1. **Web 应用之间隔离**：app1 和 app2 各有一个 `WebappClassLoader`，互相看不见
2. **Web 应用优先于父加载器**：Web 应用自己的类优先加载（除非是 JVM 核心类）
3. **例外情况**：JVM 核心类（`java.*`、`javax.*`）必须委派给父加载器（防止 Web 应用伪造核心类）

**Tomcat 的 `loadClass` 流程**：

```java
public Class<?> loadClass(String name) {
    // 1. 检查是否已加载
    // 2. 如果是 java.* / javax.* / sun.* 等核心类，委派给父
    // 3. 在 Web 应用的 WEB-INF/classes 中找
    // 4. 在 Web 应用的 WEB-INF/lib 中找
    // 5. 在父 SharedClassLoader 中找
    // 6. 抛 ClassNotFoundException
}
```

**场景 3：OSGi 网状类加载模型**

OSGi 每个模块（Bundle）都有自己的类加载器，模块之间通过 `Export-Package` / `Import-Package` 声明依赖，形成**网状结构**（不再是树状）：

```
Bundle A (export com.foo.bar)
    │
    ▼
Bundle B (import com.foo.bar)  <-  B 的类加载器委派给 A 的类加载器

Bundle C (export com.foo.bar)  <-  另一个 Bundle 也 export 同名包
    │
    ▼
Bundle D (import com.foo.bar)  <-  D 委派给 C
```

OSGi 解决了 Jar Hell 问题（同一包的多版本共存），但代价是类加载器复杂度爆炸，调试困难。Spring DM / Eclipse 都基于 OSGi。

**场景 4：热部署**

| 工具 | 实现原理 | 适用场景 |
|------|---------|---------|
| OSGi | 卸载旧 Bundle 的 ClassLoader，加载新 Bundle | 模块化热部署 |
| JRebel | 不卸载旧类，生成新类 + 字节码增强重定向 | 开发期热部署 |
| Arthas redefine | Instrumentation.redefineClasses | 生产期诊断 |
| Spring DevTools | 监听 classpath，重启应用 | 开发期 |

**热部署的核心难题**：

- **类的不可变性**：JVM 中同一个 ClassLoader 加载的同名类不能被替换
- **解决方案**：创建新的 ClassLoader 加载新类，旧 ClassLoader 卸载（前提：旧类无引用，GC 可达性分析判定可回收）
- **泄漏风险**：如果旧 ClassLoader 还有引用，旧类无法卸载，导致 Metaspace OOM

**`Class.forName` vs `ClassLoader.loadClass`**：

```java
// Class.forName 默认会触发初始化
Class.forName("com.foo.Bar");  // 等价于 Class.forName("com.foo.Bar", true, currentClassLoader)

// ClassLoader.loadClass 默认不触发初始化
classLoader.loadClass("com.foo.Bar");  // 只加载，不初始化

// Class.forName 可控制是否初始化
Class.forName("com.foo.Bar", false, classLoader);  // 不初始化
```

**实战选择**：

- 加载 JDBC Driver：用 `Class.forName("com.mysql.cj.jdbc.Driver")`（需要触发初始化注册到 DriverManager）
- 反射创建对象：用 `ClassLoader.loadClass` + `newInstance()`（延迟初始化，性能略好）
- Spring 扫描 Bean：用 `Class.forName` + `isAnnotationPresent`（需要初始化以读取注解）

#### 4. 字节码与栈帧结构

**`javap -v -p` 输出结构**：

```
Classfile /path/Hello.class
  Last modified ...
  Magic: 0xCAFEBABE
  Constant pool:                   // 常量池
    #1 = Methodref          #4.#15  // java/lang/Object."<init>":()V
    #2 = Fieldref           #3.#16  // com/foo/Hello.value:I
    #3 = Class              #14     // com/foo/Hello
    ...
{
  private int value;              // 字段表
    descriptor: I
    flags: (0x0002) ACC_PRIVATE

  public void sayHello();          // 方法表
    descriptor: ()V
    flags: (0x0001) ACC_PUBLIC
    Code:
      stack=2, locals=1, args_size=1
         0: getstatic     #2    // Field System.out
         3: ldc           #3    // String hello
         5: invokevirtual #4    // Method PrintStream.println
         8: return
      LineNumberTable: ...
      LocalVariableTable: ...
}
```

**栈帧结构**：

```
┌────────────────────────────────┐
│  局部变量表 (Local Variable Table) │  数组实现，每个 Slot 32 位
│  this / args / locals          │  64 位 long/double 占 2 个 Slot
├────────────────────────────────┤
│  操作数栈 (Operand Stack)         │  LIFO 栈，最大深度编译期确定
│  字节码指令 push/pop            │  存放中间计算结果
├────────────────────────────────┤
│  动态链接 (Dynamic Linking)       │  指向运行时常量池的方法引用
│  支持动态分派                    │  invokevirtual 时的多态查找
├────────────────────────────────┤
│  方法返回地址 (Return Address)    │  正常返回：调用者的 PC 寄存器
│  异常完成：异常表                │  异常完成：抛给调用者
└────────────────────────────────┘
```

**局部变量表 Slot 复用规则**：

- 方法的作用域内，局部变量表 Slot 可以复用
- 当变量超出作用域，其 Slot 可以被新变量使用

**Slot 复用引发的 GC 陷阱**：

```java
public void gcTrap() {
    byte[] big = new byte[10 * 1024 * 1024];  // 占用 10MB
    // big 仍在局部变量表 Slot 1
    doSomething();
    // big 还没被回收！因为 Slot 1 仍引用着它
    
    // 显式置 null 才能回收（不推荐，但有效）
    // big = null;
}

public void gcOk() {
    {
        byte[] big = new byte[10 * 1024 * 1024];
    }  // big 超出作用域，Slot 1 可被复用
    byte[] small = new byte[1];  // 复用 Slot 1
    doSomething();
    // big 已无引用，可被 GC（small 引用与 big 不同对象）
}
```

**实战教训**：在 `byte[]` 大对象的方法中，如果后续逻辑耗时长，应让大对象超出作用域或显式 `= null`，否则 GC 不回收。

**方法调用的 5 个字节码指令**：

| 指令 | 调用类型 | 例子 | 解析时机 |
|------|---------|------|---------|
| `invokestatic` | 静态方法 | `Math.abs(-1)` | 编译期确定 |
| `invokespecial` | 构造方法 / 私有方法 / `super.method` | `new Object()`、`this.privateMethod()` | 编译期确定 |
| `invokevirtual` | 实例方法（虚方法） | `obj.toString()` | 运行时动态分派 |
| `invokeinterface` | 接口方法 | `list.add(e)` | 运行时动态分派 |
| `invokedynamic` | 动态方法 | Lambda、Groovy、JRuby | 运行时 invokedfactory |

**`invokevirtual` 的分派过程**：

1. 从操作数栈顶取出对象的实际类型
2. 在实际类型的方法表中查找方法
3. 找不到则递归查找父类
4. 找到则调用

**`invokeinterface` 与 `invokevirtual` 的差异**：

- `invokeinterface` 每次都需要在接口实现类中搜索（接口方法表无固定偏移）
- `invokevirtual` 通过 vtable（虚方法表）直接索引，O(1)
- 所以接口调用比实例调用略慢（在 JIT 优化前）

**`invokedynamic` 的重要性**：

- JDK 7 引入，JDK 8 Lambda 表达式使用
- 与前 4 个指令不同，`invokedynamic` 的调用目标**在运行时由引导方法（Bootstrap Method）决定**
- Lambda 编译后生成 `invokedynamic` + `LambdaMetafactory.metafactory()` 引导方法，运行时生成匿名类
- Groovy / JRuby / Kotlin 协程都基于 `invokedynamic`

**Lambda 字节码示例**：

```java
Runnable r = () -> System.out.println("hello");
```

```
0: invokedynamic #2,  0   // InvokeDynamic #0:run:()Ljava/lang/Runnable;
```

`LambdaMetafactory` 在运行时生成 `Lambda$0` 方法 + 匿名类（JDK 8 用 ASM 生成内部类，JDK 11+ 用 hidden class）。

#### 5. Spring Boot 类加载与字节码增强

**Spring Boot Fat Jar 启动流程**：

```
java -jar app.jar
    │
    ▼
META-INF/MANIFEST.MF
  Main-Class: org.springframework.boot.loader.JarLauncher
    │
    ▼
JarLauncher.main()
    │
    ▼
创建 LaunchedURLClassLoader
  加载 BOOT-INF/classes/
  加载 BOOT-INF/lib/*.jar
    │
    ▼
反射调用 Main-Class（用户应用入口）
  com.example.Application.main()
```

**`LaunchedURLClassLoader` 与 `AppClassLoader` 的关系**：

- `LaunchedURLClassLoader` 继承 `URLClassLoader`，是 Spring Boot 自定义的
- 它是 `AppClassLoader` 的子加载器
- 用户代码由 `LaunchedURLClassLoader` 加载，所以 `Application.class.getClassLoader()` 返回 `LaunchedURLClassLoader` 而不是 `AppClassLoader`

**Fat Jar 的内部结构**：

```
app.jar
├── META-INF/
│   └── MANIFEST.MF            # Main-Class: JarLauncher
├── org/springframework/boot/loader/   # 启动器代码（AppClassLoader 加载）
│   ├── JarLauncher.class
│   ├── LaunchedURLClassLoader.class
│   └── ...
├── BOOT-INF/
│   ├── classes/                # 用户代码（LaunchedURLClassLoader 加载）
│   │   └── com/example/Application.class
│   └── lib/                    # 依赖 Jar（LaunchedURLClassLoader 加载）
│       ├── spring-core-5.3.x.jar
│       ├── spring-boot-2.6.x.jar
│       └── ...
```

**Spring Boot 为什么要自定义 ClassLoader**：

1. **Fat Jar 内部 Jar 不能直接被 `AppClassLoader` 加载**：JDK 的 `URLClassLoader` 不支持嵌套 Jar（`jar:file:/app.jar!/BOOT-INF/lib/spring-core.jar`），需要自定义处理
2. **隔离启动器与应用代码**：`JarLauncher` 由 `AppClassLoader` 加载，应用代码由 `LaunchedURLClassLoader` 加载，避免冲突
3. **支持 devtools 热重启**：devtools 监听 classpath 变化，重新创建 `LaunchedURLClassLoader` 加载新类

**Spring AOP 的字节码增强**：

| 代理类型 | 实现方式 | 适用场景 | 性能 |
|---------|---------|---------|------|
| JdkDynamicAopProxy | JDK 动态代理，生成实现接口的代理类 | 目标类实现接口 | 略慢（反射调用） |
| CGLIB | 字节码生成子类，重写父类方法 | 目标类未实现接口 | 略快（直接调用） |
| Objenesis | 跳过构造器创建对象 | CGLIB 创建代理对象 | - |

**CGLIB 生成子类的字节码流程**：

1. ASM 读取目标类的字节码
2. 生成子类，重写所有非 `final` 方法
3. 在子类方法中插入 `MethodInterceptor.intercept()` 调用
4. 通过 `ClassLoader.defineClass` 加载子类

**CGLIB 不能代理 `final` 类的原因**：

- CGLIB 通过生成子类实现代理
- `final` 类不能被继承，无法生成子类
- `final` 方法也不能被重写，CGLIB 跳过这些方法（不增强）

**JDK 17 强封装的影响**：

- JDK 16+ 默认强封装（`--illegal-access=deny`）
- JDK 17 强制强封装，无法通过反射访问 JDK 内部 API（如 `sun.misc.Unsafe`）
- CGLIB / Spring 5.x 用 `sun.misc.Unsafe.defineClass`，被禁止
- 解决方案：
  - Spring 6+ 改用 `MethodHandles.Lookup.defineClass`（JDK 9+）
  - 启动时加 `--add-opens java.base/java.lang=ALL-UNNAMED` 强制开放

**`--add-opens` 示例**：

```
java --add-opens java.base/java.lang=ALL-UNNAMED \
     --add-opens java.base/java.lang.reflect=ALL-UNNAMED \
     -jar app.jar
```

**典型问题**：升级 JDK 17 后 CGLIB 报错 `InaccessibleObjectException`，需要在启动参数中加 `--add-opens`，或升级到 Spring 6 / CGLIB 3.3+。

---

## 题目二（实战场景题）：在线问诊系统的类加载与字节码实战

在线问诊系统涉及多个组件：IM 网关（Netty）、视频问诊 SFU（Kurento / Janus）、MongoDB 存档、TCC 分布式事务、HL7 / FHIR 解析。请结合以下场景，回答类加载与字节码相关问题：

1. **Netty 版本冲突排查**：IM 网关用 Netty 4.1.x，但 MongoDB Driver 4.x 依赖 Netty 4.1.x，第三方推送 SDK 依赖 Netty 4.0.x。生产环境报 `NoSuchMethodError: io.netty.buffer.PooledByteBufAllocator.<init>(ZIIIIIIIIIZ)V`。请详细分析：
   - 这个错误的根因是什么？
   - 如何用 `jmap -clstats`、`-verbose:class`、Arthas `sc -d` 诊断类加载来源？
   - 如何用 `mvn dependency:tree` + `mvn dependency:analyze` 排查冲突？
   - 如何用 `<exclusion>` + `<dependencyManagement>` 强制统一 Netty 版本？
   - 类加载器隔离方案（如自定义 ClassLoader 隔离第三方 SDK）是否可行？

2. **Spring Boot Fat Jar 启动慢优化**：在线问诊系统 30+ 微服务，启动时间从 30s 涨到 90s，影响弹性扩容。经分析，类加载阶段占 25s。请回答：
   - Spring Boot Fat Jar 启动慢的根因（嵌套 Jar 解压、类扫描、Bean 初始化）？
   - 如何用 AppCDS（Application Class Data Sharing）加速类加载？AppCDS 的原理（共享元空间内存）？
   - Spring Boot 3.2+ 的 Spring AOT + Native Image（GraalVM）的优缺点？为什么不能完全替代 JIT？
   - 在线问诊系统哪些服务适合 Native Image，哪些不适合（IM 网关 / SFU / 业务服务 / 定时任务）？

3. **TCC 分布式事务的 AOP 性能瓶颈**：TCC 拦截器用 Spring AOP + CGLIB 字节码增强，压测时发现拦截器本身占 15% CPU。请回答：
   - CGLIB 字节码生成的热点在哪（ASM 读取字节码、生成子类、`defineClass`）？
   - 如何用 `-XX:+PrintCompilation` + JFR 分析 JIT 优化情况？
   - CGLIB 代理类为什么"逃逸"严重，影响 GC？
   - 优化方案：缓存代理类、用 AspectJ 编译期织入、用 `invokedynamic` 替代反射？

4. **JDK 8 升级 JDK 17 的类加载兼容性**：在线问诊系统计划从 JDK 8 升级到 JDK 17。已知问题：使用了 `sun.misc.Unsafe`、`reflectasm`、`cglib 3.2.x`、`hapi-fhir 4.x`。请回答：
   - JDK 8 到 JDK 17 之间类加载的关键变化（模块系统、强封装、PlatformClassLoader）？
   - `sun.misc.Unsafe` 在 JDK 17 的状态？哪些 API 被移除，哪些保留？
   - `--add-opens` / `--add-exports` 的写法？
   - 如何用 `jdeps` 提前扫描不兼容的依赖？
   - 升级后的回归测试重点（反射、序列化、字节码增强、JNDI）？

5. **Arthas 热更新生产代码**：生产环境出 Bug，但重启服务影响大。请用 Arthas `redefine` 热修复。请回答：
   - `redefine` 与 `retransform` 的区别？为什么 `retransform` 能恢复但 `redefine` 不能？
   - Arthas 热更新的限制（不能加字段、不能改方法签名、不能改继承关系）？
   - 热更新后旧类的 GC 条件？为什么 Metaspace 容易 OOM？
   - 如何确保热更新代码安全（单元测试、灰度、回滚预案）？

### 作答区

#### 1. Netty 版本冲突排查

**根因分析**：

```
NoSuchMethodError: io.netty.buffer.PooledByteBufAllocator.<init>(ZIIIIIIIIIZ)V

签名解读：构造方法，参数为 (boolean, int, int, int, int, int, int, int, int, int, boolean)
Netty 4.1.x 的 PooledByteBufAllocator 构造方法有 11 个参数
Netty 4.0.x 的 PooledByteBufAllocator 构造方法可能只有 8 个参数
```

**根因**：

1. IM 网关代码编译时用 4.1.x，运行时类加载器加载了 4.0.x 的 `PooledByteBufAllocator`
2. 4.0.x 没有 11 参数的构造方法，所以 `NoSuchMethodError`
3. 通常因为 Maven 依赖冲突，4.0.x 的 Netty 优先被加载

**诊断工具链**：

**Step 1：`jmap -clstats <pid>`**（查看类加载器统计）：

```
ClassLoader          classes  bytes  parent
AppClassLoader       12543    ...
URLClassLoader@xxx   125      ...    AppClassLoader   <- 第三方 SDK 的 ClassLoader
```

如果第三方 SDK 自带 ClassLoader，可能加载了自己的 Netty。

**Step 2：`-verbose:class`**（启动参数，打印类加载日志）：

```
[Loaded io.netty.buffer.PooledByteBufAllocator from file:/app/lib/netty-buffer-4.0.51.Final.jar]
```

直接看到 `PooledByteBufAllocator` 从哪个 Jar 加载。

**Step 3：Arthas `sc -d io.netty.buffer.PooledByteBufAllocator`**：

```
class-info         io.netty.buffer.PooledByteBufAllocator
code-source        file:/app/lib/netty-buffer-4.0.51.Final.jar   <- 真凶
is-interface       false
super-class        java.lang.Object
class-loader       sun.misc.Launcher$AppClassLoader@xxx
classLoaderHash    18b4aac2
```

`code-source` 直接指出从哪个 Jar 加载。

**Step 4：`mvn dependency:tree -Dincludes=io.netty`**：

```
[INFO] com.example:im-gateway:jar:1.0.0
[INFO] +- io.netty:netty-all:jar:4.1.68.Final:compile
[INFO] +- org.mongodb:mongodb-driver-sync:jar:4.4.0:compile
[INFO] |  \- io.netty:netty-buffer:jar:4.1.68.Final:compile
[INFO] \- com.thirdparty:push-sdk:jar:2.0.0:compile
[INFO]    \- io.netty:netty-all:jar:4.0.51.Final:compile   <- 冲突源
```

定位到 `push-sdk` 依赖了 4.0.51。

**Step 5：`mvn dependency:analyze`**（分析未使用 / 间接依赖）：

```
[WARNING] Used undeclared dependencies:    <- 用了但没声明
[WARNING] Unused declared dependencies:     <- 声明了但没用
```

帮助清理无用依赖。

**解决方案**：

**方案 1：`<exclusion>` 排除冲突依赖**：

```xml
<dependency>
    <groupId>com.thirdparty</groupId>
    <artifactId>push-sdk</artifactId>
    <version>2.0.0</version>
    <exclusions>
        <exclusion>
            <groupId>io.netty</groupId>
            <artifactId>netty-all</artifactId>
        </exclusion>
    </exclusions>
</dependency>
```

**方案 2：`<dependencyManagement>` 强制统一版本**（推荐）：

```xml
<dependencyManagement>
    <dependencies>
        <dependency>
            <groupId>io.netty</groupId>
            <artifactId>netty-bom</artifactId>
            <version>4.1.68.Final</version>
            <type>pom</type>
            <scope>import</scope>
        </dependency>
    </dependencies>
</dependencyManagement>

<dependencies>
    <dependency>
        <groupId>io.netty</groupId>
        <artifactId>netty-all</artifactId>
        <!-- 版本由 BOM 统一管理 -->
    </dependency>
</dependencies>
```

**方案 3：Maven Enforcer 插件强制依赖收敛**：

```xml
<plugin>
    <groupId>org.apache.maven.plugins</groupId>
    <artifactId>maven-enforcer-plugin</artifactId>
    <executions>
        <execution>
            <id>enforce</id>
            <goals><goal>enforce</goal></goals>
            <configuration>
                <rules>
                    <dependencyConvergence/>
                </rules>
            </configuration>
        </execution>
    </executions>
</plugin>
```

如果有版本冲突，构建直接失败。

**方案 4：自定义 ClassLoader 隔离**（极端方案）：

```java
public class IsolatingClassLoader extends URLClassLoader {
    public IsolatingClassLoader(URL[] urls, ClassLoader parent) {
        super(urls, parent);
    }
    @Override
    protected Class<?> loadClass(String name, boolean resolve) {
        // 对 io.netty.* 类，自己优先加载
        if (name.startsWith("io.netty.")) {
            Class<?> c = findClass(name);
            if (c != null) return c;
        }
        return super.loadClass(name, resolve);
    }
}

// 加载 push-sdk 时用独立的 IsolatingClassLoader
URL[] pushSdkUrls = ...;
ClassLoader pushSdkLoader = new IsolatingClassLoader(pushSdkUrls, getClass().getClassLoader());
Class<?> pushSdkClass = pushSdkLoader.loadClass("com.thirdparty.PushClient");
Object pushClient = pushSdkClass.getDeclaredConstructor().newInstance();
```

**适用场景**：第三方 SDK 强依赖旧 Netty，且无法升级。

**代价**：跨 ClassLoader 调用需要反射，性能差，类型不兼容（不同 ClassLoader 加载的同名类是不同 Class）。

**实战教训**：

- 优先用 `dependencyManagement` 统一版本
- 升级第三方 SDK 而不是隔离
- 只在 SDK 完全无法升级时才用 ClassLoader 隔离（如某些闭源 SDK）

#### 2. Spring Boot Fat Jar 启动慢优化

**启动慢的根因**：

| 阶段 | 耗时占比 | 原因 |
|------|---------|------|
| JVM 启动 | 1s | JVM 初始化、加载核心类 |
| 类加载 | 25s | Fat Jar 解压 + 嵌套 Jar 读取 + 10000+ 类加载 |
| Spring 上下文初始化 | 30s | Bean 扫描、`@Configuration` 解析、AOP 代理生成 |
| Bean 初始化 | 25s | DataSource / Redis / Kafka / Nacos 连接 |
| Actuator 健康 | 5s | 启动末期健康检查 |
| 其他 | 4s | 日志、JIT 预热 |

**Fat Jar 嵌套 Jar 加载慢**：

- `LaunchedURLClassLoader` 加载 `BOOT-INF/lib/*.jar` 时，每个嵌套 Jar 都要解压到内存或临时目录
- 每个类加载都涉及"打开 Jar -> 定位 Entry -> 读取字节"的多层 IO
- 10000+ 类加载 = 10000+ 次 Jar 读取

**AppCDS 加速类加载**：

**AppCDS 原理**：

```
传统流程：
  .class 文件 -> 加载 -> 解析 -> 验证 -> 元空间
                 ↑ 每次启动都重复

AppCDS 流程：
  第一次：.class -> 加载 -> 解析 -> 验证 -> 元空间 -> dump 到 JSA 文件
  
  后续启动：
  JSA 文件 -> mmap 直接映射到元空间   <- O(1)，无解析验证
```

**AppCDS 步骤**：

```bash
# Step 1：dump 类列表
java -Xshare:off -XX:DumpLoadedClassList=classes.lst -jar app.jar

# Step 2：生成 AppCDS 归档
java -Xshare:dump -XX:SharedClassListFile=classes.lst \
     -XX:SharedArchiveFile=app.jsa \
     -jar app.jar

# Step 3：使用 AppCDS 启动
java -Xshare:on -XX:SharedArchiveFile=app.jsa -jar app.jar
```

**效果**：

- 类加载时间从 25s 降到 5s（70% 优化）
- 元空间内存共享，节省 200MB+
- 启动时间从 90s 降到 60s

**Spring Boot 3.2+ Spring AOT + GraalVM Native Image**：

**AOT 编译原理**：

- Spring Boot 启动时分析 Bean Graph，生成 `BeanFactoryInitializationAotContribution`
- 编译期生成 `BeanFactoryInitializationAotProcessor` 的代码，跳过运行时反射
- 减少反射、`@Conditional` 判断、`BeanPostProcessor` 调用

**GraalVM Native Image**：

```
javac -> .class -> GraalVM native-image -> 可执行文件

执行文件包含：
- JVM 精简版（无 JIT，无解释器）
- 应用代码 AOT 编译为机器码
- 启动时直接进入 main，<100ms 启动
```

**优点**：

- 启动 &lt; 100ms（30 倍提升）
- 内存占用 &lt; 50MB（10 倍降低）
- 适合 Serverless / Function 场景

**缺点**：

- **无 JIT**：峰值性能低 30%（无法动态优化）
- **Closed World Assumption**：编译期必须知道所有反射、动态代理、序列化目标
- **构建慢**：Native Image 构建需 5-10 分钟
- **兼容性**：依赖反射、字节码增强的库需要额外配置（`reflect-config.json`、`proxy-config.json`）

**为什么 Native Image 不能完全替代 JIT**：

1. **JIT 的核心价值是动态优化**：基于运行时 Profile 优化（Hot Spot 检测、内联、逃逸分析）
2. **Native Image 是 AOT**：编译期无 Profile，无法做激进优化（如虚方法内联）
3. **长期运行服务**：JIT 优化后的吞吐比 Native Image 高 20-30%
4. **峰值延迟**：Native Image 在高负载下退化严重

**在线问诊系统各服务的 Native Image 适用性**：

| 服务 | 是否适合 Native Image | 原因 |
|------|---------------------|------|
| IM 网关 | 不适合 | 长连接，JIT 优化后吞吐高 30%；Netty 用反射 + 字节码增强 |
| SFU | 不适合 | 实时音视频，JIT 优化关键；native 库依赖复杂 |
| 业务服务（订单/支付） | 一般 | 启动快但峰值性能损失大；支付需要 JIT 优化 |
| 定时任务 | 适合 | 短时运行，启动快重要；峰值性能不重要 |
| Webhook 接收器 | 适合 | 短时请求，Serverless 部署 |
| 健康检查 | 适合 | 极简，无需 JIT |

**实战建议**：

- **短期**：用 AppCDS（兼容性高，效果 70%）
- **中期**：评估 Spring AOT（无 Native Image，只生成 AOT 代码减少反射）
- **长期**：评估特定服务（定时任务、Webhook）上 Native Image

#### 3. TCC 分布式事务的 AOP 性能瓶颈

**CGLIB 字节码生成的热点**：

```
CGLIB 生成代理类的流程：
1. ASM 读取目标类字节码 (10us)
2. ASM 生成子类字节码 (50us)
3. ClassLoader.defineClass (20us)
4. 创建代理实例 (5us)
   总计：~85us per 代理类

如果每个 TCC 服务 10 个 Bean，每个 Bean 5 个 TCC 方法，共 50 个代理类 -> 4.25ms
压测 QPS 10000 时，每秒生成 50000 个代理（如果没缓存）
```

**Spring AOP 默认缓存代理类**：

- `DefaultAopProxyFactory.createAopProxy()` 缓存代理类（`ProxyFactory` 的 `advised` 字段缓存）
- 但 `MethodInterceptor.invoke()` 每次调用都要走反射

**TCC 拦截器调用链**：

```
TCC 调用流程：
1. CGLIB 代理拦截 try 方法
2. ReflectiveMethodInvocation.proceed()
3. TccTryInterceptor.invoke()         <- TCC 拦截器
4. 反射调用真实 try 方法
5. 记录 TCC 事务日志
6. 返回

每次调用涉及：
- 1 次 CGLIB 方法拦截
- 1 次 ReflectiveMethodInvocation 创建
- 1 次 MethodInterceptor 调用
- 1 次反射调用（target.method）
```

**用 `-XX:+PrintCompilation` + JFR 分析**：

**PrintCompilation**：

```
java -XX:+PrintCompilation -XX:+UnlockDiagnosticVMOptions -XX:+PrintInlining -jar app.jar

  123   4 % b  com.example.TccService::try @ 5 (32 bytes)
  124   5   b  com.example.TccService::confirm (28 bytes)
                          @ 7   com.example.TccInterceptor::invoke (15 bytes)   inline
```

`@ 7 ... inline` 表示 `TccInterceptor.invoke` 被内联到 `confirm` 方法中，性能好。

**JFR 分析**：

```bash
java -XX:StartFlightRecording=duration=60s,filename=tcc.jfr -jar app.jar

# 用 JMC 打开 tcc.jfr
# 查看 Method Profiling 样本，看 TCC 拦截器占比
```

如果 `TccInterceptor.invoke` 占 CPU 15%，需要优化。

**CGLIB 代理类逃逸严重**：

- 代理类是 `ClassLoader` 加载的真实类，存放在元空间
- 代理对象在堆中，每个 Bean 一个代理对象
- 代理对象持有 `target`、`advisors`、`interceptors`，引用链长
- 如果代理对象生命周期长（单例 Bean），所有引用都不会被 GC

**优化方案**：

**方案 1：缓存代理类**：

```java
// Spring 默认已缓存，但自定义拦截器可能没缓存
private static final Map<Method, MethodInterceptor> CACHE = new ConcurrentHashMap<>();

public Object invoke(MethodInvocation invocation) {
    Method method = invocation.getMethod();
    MethodInterceptor interceptor = CACHE.computeIfAbsent(method, this::createInterceptor);
    return interceptor.invoke(invocation);
}
```

**方案 2：用 AspectJ 编译期织入**：

- AspectJ 在编译时（`ajc` 编译器）或加载时（LTW）织入切面
- 直接修改字节码，没有运行时代理
- 性能接近原生方法调用（无反射）

```xml
<!-- pom.xml -->
<plugin>
    <groupId>org.codehaus.mojo</groupId>
    <artifactId>aspectj-maven-plugin</artifactId>
    <executions>
        <execution>
            <goals><goal>compile</goal></goals>
        </execution>
    </executions>
    <configuration>
        <complianceLevel>17</complianceLevel>
    </configuration>
</plugin>
```

**AspectJ 切面**：

```java
@Aspect
public class TccAspect {
    @Around("execution(* com.example.TccService.*(..))")
    public Object around(ProceedingJoinPoint pjp) throws Throwable {
        // 直接织入字节码，无代理对象
        return pjp.proceed();
    }
}
```

**方案 3：用 `invokedynamic` 替代反射**：

- JDK 7+ 的 `invokedynamic` + `LambdaMetafactory` 可以生成调用 Site
- 比 `Method.invoke()` 快 3-5 倍

```java
MethodHandles.Lookup lookup = MethodHandles.lookup();
MethodHandle handle = lookup.findVirtual(target.getClass(), "try", 
    MethodType.methodType(void.class));
MethodHandle wrapper = MethodHandles.dropArguments(handle, 0, Object.class);
BiConsumer<Object, Object> invoker = (BiConsumer<Object, Object>) 
    LambdaMetafactory.metafactory(lookup, "accept", 
        MethodType.methodType(BiConsumer.class), 
        MethodType.methodType(void.class, Object.class, Object.class), 
        wrapper, 
        MethodType.methodType(void.class, TargetClass.class, ParamClass.class))
    .getTarget().invoke();
```

**实战建议**：

1. 短期：缓存拦截器、减少反射调用
2. 中期：评估 AspectJ LTW 织入
3. 长期：评估 invokedynamic 改造

#### 4. JDK 8 升级 JDK 17 的类加载兼容性

**JDK 8 到 JDK 17 的关键变化**：

| 维度 | JDK 8 | JDK 17 | 影响 |
|------|-------|--------|------|
| 类加载器 | Bootstrap + Extension + App | Bootstrap + Platform + App | 自定义 ClassLoader 父类变化 |
| 模块系统 | 无 | JPMS（Jigsaw） | `--add-opens` / `--add-exports` |
| 强封装 | 无（`--illegal-access=permit`） | 强制（`deny`） | 反射 JDK 内部 API 失败 |
| `sun.misc.Unsafe` | 全部可用 | 部分移除，部分 `deprecated for removal` | 直接使用需迁移 |
| 内部 API | `sun.reflect.*`、`sun.misc.*` 可用 | 强封装，需 `--add-opens` | 字节码增强库受影响 |
| EE 模块 | `javax.xml.bind`、`javax.annotation`、`javax.transaction` 内置 | 移除（需引入 Jakarta EE 依赖） | JAXB / JTA 升级 |
| URLClassLoader | `defineClass` 可用 | `defineClass` 弃用，推荐 `Lookup.defineClass` | CGLIB 3.x 失败 |

**`sun.misc.Unsafe` 在 JDK 17 的状态**：

| API | JDK 8 | JDK 17 |
|-----|-------|--------|
| `objectFieldOffset` | 可用 | 可用（保留） |
| `putObject` / `getObject` | 可用 | 可用（保留） |
| `compareAndSwapObject` | 可用 | 可用（保留，`compareAndSet` 是新名） |
| `defineClass` | 可用 | **弃用**，使用 `MethodHandles.Lookup.defineClass` |
| `allocateInstance` | 可用 | 可用 |
| `park` / `unpark` | 可用 | 可用（保留，被 `java.util.concurrent` 使用） |

**关键变化**：`Unsafe.defineClass` 弃用，CGLIB 3.x 默认走这个 API，所以 JDK 17 必须升级到 CGLIB 3.3+。

**`--add-opens` / `--add-exports` 写法**：

```bash
java \
  --add-opens java.base/java.lang=ALL-UNNAMED \
  --add-opens java.base/java.lang.reflect=ALL-UNNAMED \
  --add-opens java.base/java.util=ALL-UNNAMED \
  --add-exports java.base/sun.nio.ch=ALL-UNNAMED \
  -jar app.jar
```

- `--add-opens`：开放反射访问（深开放，包括 `private`）
- `--add-exports`：开放编译期访问（公开 API）
- `ALL-UNNAMED`：所有未命名模块（默认模块路径）

**用 `jdeps` 扫描不兼容依赖**：

```bash
# 扫描应用 Jar 依赖的 JDK 内部 API
jdeps --jdk-internals --multi-release 17 app.jar

# 输出示例：
# app.jar -> JDK internal API:
#    sun.misc.Unsafe            <- 不兼容
#    sun.reflect.Reflection     <- 不兼容
#    sun.nio.ch.DirectBuffer    <- 不兼容
# 
# Suggested replacements:
#    sun.misc.Unsafe -> java.lang.invoke.MethodHandles.Lookup
#    sun.reflect.Reflection -> java.lang.invoke.MethodHandle
```

**升级后的回归测试重点**：

| 维度 | 测试点 |
|------|--------|
| 反射 | `setAccessible(true)` 是否仍可用（强封装后部分失败） |
| 序列化 | `ObjectInputStream` 反序列化内部类是否成功 |
| 字节码增强 | CGLIB / Objenesis / ByteBuddy 创建对象是否成功 |
| JNDI | `InitialContext` lookup 是否被安全限制（JEP 290） |
| Unsafe | CAS、内存分配、`defineClass` 是否可用 |
| 字节码指令 | `invokedynamic`、`getstatic` 等 JDK 17 是否兼容 |
| 类加载器 | 自定义 ClassLoader 的 parent 是否需要改（`ExtClassLoader` -> `PlatformClassLoader`） |

**升级路径建议**：

```
JDK 8 -> JDK 11（LTS，过渡）
  - 移除 EE 模块依赖（JAXB / JTA）
  - 升级 Lombok / CGLIB / Spring Boot 2.x
  - 容器化 cgroup 检测（JDK 8u191+ 已支持）

JDK 11 -> JDK 17（LTS，目标）
  - 升级 Spring Boot 2.x -> 3.x（Jakarta EE 命名空间）
  - 升级 CGLIB 3.3+ / ByteBuddy 1.12+
  - 加 `--add-opens` 启动参数
  - 测试 `Unsafe.defineClass` 替换
```

#### 5. Arthas 热更新生产代码

**`redefine` 与 `retransform` 的区别**：

| 命令 | 行为 | 可恢复性 |
|------|------|---------|
| `redefine` | 直接替换字节码（外部 .class 文件） | 不可恢复（无原始字节码备份） |
| `retransform` | 通过 `ClassFileTransformer` 重新转换 | 可恢复（JVM 备份原始字节码） |

**Arthas 的 `redefine` 实现**：

```java
// Arthas 内部使用 Instrumentation.redefineClasses(ClassDefinition...)
Instrumentation inst = ...;
ClassDefinition def = new ClassDefinition(targetClass, newBytes);
inst.redefineClasses(def);
```

`retransform` 使用 `Instrumentation.retransformClasses()`：

```java
inst.addTransformer(new ClassFileTransformer() {
    @Override
    public byte[] transform(ClassLoader loader, String className, 
                            Class<?> classBeingRedefined, 
                            ProtectionDomain pd, byte[] classfileBuffer) {
        // 修改 classfileBuffer
        return modifiedBytes;
    }
}, true);  // canRetransform = true
inst.retransformClasses(targetClass);
```

**为什么 `retransform` 能恢复但 `redefine` 不能**：

- `retransform` 在 JVM 内部维护原始字节码，可以再次 `retransform` 还原
- `redefine` 直接覆盖，没有原始字节码备份

**热更新的限制（JVMS 规范）**：

1. **不能新增字段**：`ClassFormatError` 
2. **不能删除字段**：`ClassFormatError`
3. **不能改字段类型**：`ClassFormatError`
4. **不能新增方法**：`ClassFormatError`
5. **不能删除方法**：`ClassFormatError`
6. **不能改方法签名**：`ClassFormatError`
7. **不能改继承关系**：`superclass` 必须相同
8. **不能改实现的接口**：接口列表必须相同（部分情况允许新增，但不允许删除）
9. **不能改修饰符**：`final` -> 非 `final` 不允许
10. **可以改方法体**：这是最常见的热更新场景

**热更新后旧类的 GC 条件**：

- JVMS：一个 Class 只有当其 ClassLoader 不可达时才能被 GC
- 热更新后，新类替换旧类，但**旧 ClassLoader 仍然持有旧 Class**
- 如果 ClassLoader 是 `AppClassLoader`，几乎永远不会 GC（生命周期 = JVM）
- 所以热更新会泄漏：每次热更新都在 Metaspace 留下旧 Class

**为什么 Metaspace 容易 OOM**：

```
Metaspace 默认上限：无限（受物理内存限制）
Maven 限制：通常 -XX:MaxMetaspaceSize=512m

每次 redefine：
- 旧 Class 留在 Metaspace（不能 GC）
- 新 Class 进入 Metaspace
- 每个类 ~10KB

如果热更新 50 次，泄漏 500KB（不算多）
但若循环依赖 + 反射 + 字节码增强，单次热更新可能泄漏 100MB+
```

**解决方案**：

1. **生产环境用 `redefine` 而不是反复热更新**：每次都先确认问题根因
2. **测试环境用 `retransform`**：可恢复
3. **监控 Metaspace**：`jstat -class <pid>` 或 Prometheus 监控
4. **热更新后重启**：根治泄漏

**热更新安全策略**：

```bash
# 1. 单元测试：先在本地跑通修复
mvn test -Dtest=FixedTest

# 2. 灰度：在 1 台机器上热更新，观察 30 分钟
# 3. 全量：在所有机器上热更新
# 4. 回滚预案：保留原始 .class 文件，必要时重启服务回滚
```

**Arthas 热更新实战**：

```bash
# 1. 反编译当前类
[arthas@1234]$ jad com.example.BugService > BugService.java

# 2. 修改 BugService.java，编译成 .class
$ javac -cp app.jar BugService.java

# 3. 热更新
[arthas@1234]$ redefine /path/BugService.class

# 4. 验证修复
[arthas@1234]$ watch com.example.BugService doSomething '{params, returnObj}' -x 2
```

---

## 本日能力差距与补足方向

### 差距 1：字节码指令的细节掌握不深
> Day4发现

- **现状**：知道 `invokevirtual` / `invokestatic` / `invokespecial` / `invokeinterface` / `invokedynamic` 5 个方法调用指令，但 `invokedynamic` 的引导方法（Bootstrap Method）机制、Lambda 字节码生成、`LambdaMetafactory` 的实现细节不深
- **架构师水平**：能讲清 `invokedynamic` 的调用点（CallSite）、引导方法、方法句柄（MethodHandle）三件套；能读 Lambda、Groovy、Kotlin 协程的字节码并解释 invokedynamic 的作用
- **补足方向**：阅读《Java 虚拟机规范》第 6 章；用 `javap -v` 分析 5 个 Lambda 表达式的字节码；阅读 OpenJDK `LambdaMetafactory.java` 源码

### 差距 2：Spring Boot Fat Jar 启动流程的源码不熟
> Day4发现

- **现状**：知道 `JarLauncher` 创建 `LaunchedURLClassLoader`，但 `JarLauncher.main()` 的具体执行流程、`BOOT-INF/lib` 嵌套 Jar 的解析实现、`LaunchedURLClassLoader` 的 URL 处理逻辑不深
- **架构师水平**：能讲清 `org.springframework.boot.loader.jar.JarFile` 的嵌套 Jar 处理（`JarFileWrapper` / `NestedJarFile`）；能改造启动器实现自定义加载逻辑；能用 Spring Boot 3.2 的 `Nested` 加载器优化启动
- **补足方向**：阅读 `spring-boot-loader` 模块源码；调研 Spring Boot 3.2 的 Nested Jar 改进（JEP 引入 standard nested jars）；尝试自定义 `Launcher` 实现

### 差距 3：Tomcat WebappClassLoader 的细节不熟
> Day4发现

- **现状**：知道 Tomcat 打破双亲委派，但 `WebappClassLoader` 的具体加载顺序、`delegate` 属性的作用、`JarScanner` 扫描 TLD 的机制不深
- **架构师水平**：能讲清 `WebappClassLoaderBase.loadClass()` 的 7 步流程；能调优 `delegate` 属性（true 委派父优先 / false 自己优先）；能解决 `JarScanner` 引发的 TLD 加载冲突
- **补足方向**：阅读 Tomcat `WebappClassLoaderBase.java` 源码；调研 Spring Boot Embedded Tomcat 的类加载器继承关系

### 差距 4：AppCDS 与 GraalVM Native Image 实战经验不足
> Day4发现

- **现状**：知道 AppCDS 加速类加载、GraalVM Native Image AOT 编译，但缺生产实战——如何 dump 类列表、生成 JSA 文件、在容器中复用 AppCDS；如何配置 `reflect-config.json` 解决 Native Image 兼容性
- **架构师水平**：能在 K8s 容器中正确挂载 AppCDS JSA 文件；能用 Spring Boot AOT + Tracing Agent 自动生成 Native Image 配置；能根据业务特征判断是否上 Native Image
- **补足方向**：在测试环境为在线问诊系统生成 AppCDS JSA 并测启动时间；调研 Quarkus / Micronaut 的 Native Image 实践；第 2 周 Day05 在线问诊实战时尝试

### 差距 5：JDK 8 -> 17 升级的实战经验不足
> Day4发现

- **现状**：知道 JDK 9 模块化、强封装、`--add-opens`，但缺升级实战——`sun.misc.Unsafe` 替换、`reflectasm` 升级、CGLIB 升级、JAXB / JTA 迁移
- **架构师水平**：能用 `jdeps` 提前扫描不兼容依赖；能完整规划升级路径（评估 / 试点 / 全量）；能解决 `Unsafe.defineClass` -> `Lookup.defineClass` 的迁移
- **补足方向**：调研阿里、美团、字节的 JDK 升级实践；用 `jdeps` 扫描在线问诊系统的所有依赖；第 2 周末尝试在测试环境升级 1 个微服务

### 差距 6：CGLIB 字节码生成的底层细节不熟
> Day4发现

- **现状**：知道 CGLIB 用 ASM 生成子类，但 ASM 的 visitor 模式、`ClassWriter` 的 `COMPUTE_FRAMES` 选项、`MethodInterceptor` 的调用机制不深
- **架构师水平**：能直接用 ASM 写一个简单的字节码增强器；能调优 `ClassWriter` 的 flag（`COMPUTE_MAXS` / `COMPUTE_FRAMES`）；能讲清 CGLIB `FastClass` 机制的原理（避免反射）
- **补足方向**：阅读 ASM 用户指南；阅读 CGLIB `Enhancer.java` 源码；尝试用 ASM 实现一个简单 AOP

### 差距 7：类加载器与 Metaspace OOM 的关系不深
> Day4发现，延续第1周差距

- **现状**：知道 Metaspace 存储类元信息，但 ClassLoader 与 Metaspace 的回收关系、`-XX:MaxMetaspaceSize` 调优、ClassLoader 泄漏的诊断不深
- **架构师水平**：能用 `jmap -clstats` 分析 ClassLoader 数量；能用 JFR 定位 ClassLoader 泄漏；能讲清 Class 卸载的 3 个条件（ClassLoader 不可达、无类实例、无 Class 引用）
- **补足方向**：第 2 周 Day03 OOM 排查时深入；调研 Metaspace OOM 真实案例；阅读 OpenJDK `Metaspace` 源码（`metaspace.cpp`）
