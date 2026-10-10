# 架构师学习-Day04-并发容器-梳理

> 日期：2026年08月13日（周四）
> 周主题：并发编程专题 - JMM / synchronized 锁升级 / AQS / 并发容器 / 线程池 / 虚拟线程
> 梳理日：Day04 - 架构师视角梳理

---

## 一、架构师视角下的并发容器

### 1.1 容器选型是架构决策，不是 API 调用

很多工程师把并发容器当成"加了个参数的集合类"：随手 `new ConcurrentHashMap<>()`、`new LinkedBlockingQueue<>()` 就完了。架构师视角下，**每一次并发容器选型都是一次架构决策**，因为它同时决定了：

| 决策维度 | 选型回答的问题 |
|---------|--------------|
| 一致性模型 | 读到的数据可以多旧？（强一致 / 弱一致 / 快照） |
| 背压策略 | 写入速度超过消费速度时，系统怎么办？（阻塞 / 拒绝 / 无界堆积） |
| 故障模式 | 这个容器最坏情况下怎么死？（OOM / 延迟飙升 / 数据过期） |
| 容量规划 | 内存里允许最多存多少数据？谁来监控？ |
| 扩展路径 | 单机容器不够时，升级路径是什么？（分片 / MQ / 分布式缓存） |

**架构师经验**：初级工程师问"用什么容器实现"，架构师问"**这个容器的失败模式是什么、业务能不能承受**"。监管上报的 LinkedBlockingQueue 默认无界（OOM）、UserContext 的 ThreadLocal 在线程池串号（医疗串档）、COW 大列表频繁写（GC 风暴）--三个真实事故模式都源于"只看功能、不看失败模式"。

### 1.2 并发容器的设计光谱

并发容器并非一个统一套路，而是一条**"阻塞程度从弱到强、一致性从弱到强"的光谱**：

```
无阻塞（lock-free）                     阻塞协调（blocking）
────────────────────────────────────────────────────────────>
ConcurrentLinkedQueue   ConcurrentSkipListMap   LinkedTransferQueue
ConcurrentHashMap.get   CopyOnWriteArrayList    ArrayBlockingQueue
LongAdder.add           CHM.put(桶头sync)       LinkedBlockingQueue
                                                DelayQueue / PriorityBQ

一致性：弱一致（快照/近似值） ──────────────> 相对强（队列的传递语义）
吞吐：  高（读写不互斥）    ──────────────> 低（锁 + 条件等待）
延迟：  低且稳定           ──────────────> 受水位影响（满则阻塞/拒绝）
```

**关键认知**：越靠左吞吐越高但一致性越弱（size 近似、迭代弱一致、读到旧值），越靠右语义越强但代价越大。**架构师的功力是判断业务落在光谱的哪个点**：IM 网关 UserMap 的消息路由读可以落最左（弱一致可接受），库存扣减绝不能落左侧（必须精确）。

### 1.3 "用错容器"是并发事故的第一大来源

对比本周前三日的主题：JMM 的 bug（可见性）通常表现成"偶发诡异数据"，锁的 bug 表现成"卡死/性能差"，而**容器用错的 bug 表现成 OOM、串号、数据积压--最直接打死系统的那种**：

| 事故模式 | 根因 | 典型案例 |
|---------|------|---------|
| 无界队列 OOM | LinkedBlockingQueue 默认 Integer.MAX_VALUE | 监管上报缓冲队列，消费降速 3 小时堆 38GB |
| 线程爆炸 OOM | SynchronousQueue + 无界 maximumPoolSize | newCachedThreadPool 扛突发流量 |
| 上下文串号 | ThreadLocal 线程池未 remove / ITL 失效 | 患者A 上下文串到患者B（医疗串档） |
| GC 风暴 | COW 大列表频繁写复制 | 万级路由表分钟级全量刷新 |
| 迭代器 CME | fail-fast 容器迭代中修改 | HashMap 迭代中 remove（单线程也会） |

**架构师经验**：评审任何使用内存队列 / ThreadLocal / COW 的设计，必问"失败模式三连"：**最坏会怎么死？死之前有什么征兆（监控水位/lag）？死了怎么恢复（磁盘兜底/MQ/降级）？**

### 1.4 并发容器是前三日知识的"集大成者"

Day04 不是一个孤立主题，而是本周知识线的汇合点：

```
Day01 JMM          Day02 synchronized      Day03 AQS
volatile/hb        锁升级链                Condition 多队列
    │                  │                      │
    ▼                  ▼                      ▼
CHM get 无锁       CHM.put 桶头锁          BlockingQueue
（三级 volatile）  （轻量级锁场景命中）     put/take 的 notFull/notEmpty
LongAdder Cell     CopyOnWriteArrayList    DelayQueue leader-follower
@Contended 伪共享  的写锁                  的 available 条件
```

**关键认知**：面试讲 CHM 的 get 无锁，能主动点一句"这依赖 volatile 的 happens-before 规则（Day01）"；讲 JDK8 敢用 synchronized 锁桶头，点一句"因为 JDK6+ 锁升级让低竞争场景 synchronized 不输 ReentrantLock（Day02）"；讲 BlockingQueue，点一句"就是 AQS 多 Condition 精确唤醒的框架级落地（Day03）"--**知识连成线，就是架构师和背题者的区别**。

### 1.5 单机容器的天花板：升级路径要提前想清楚

并发容器是**单 JVM 内**的协调工具，架构师必须同时看到它的天花板和升级路径：

| 单机方案 | 天花板 | 升级路径 | 升级触发条件 |
|---------|--------|---------|-------------|
| ConcurrentHashMap（本地缓存） | 单机内存 + 多实例不共享 | Redis / Caffeine 多级缓存（06月第2周） | 容量超内存 / 需要实例间共享 |
| LinkedBlockingQueue（缓冲） | 单机重启丢数据 | MQ（05月第4周）/ Kafka | 需要持久化 / 削峰 / 解耦 |
| DelayQueue（延迟任务） | 重启丢任务 | RocketMQ 延迟 / Redis ZSet / 时间轮 | 任务关键不可丢 |
| LongAdder（统计） | 单机数据 | Micrometer / Prometheus 指标体系 | 需要全局聚合与告警 |
| ThreadLocal（上下文） | 单线程内 | MQ 消息头透传（traceId）/ 网关协议字段 | 跨进程传递 |

**架构师经验**：单机容器方案上线前必须回答"**涨 10 倍之后怎么办**"。监管上报队列（LinkedBlockingQueue -> 磁盘兜底 -> Kafka）和订单延迟（DelayQueue -> MQ 延迟消息）都体现了"单机容器做第一级，分布式设施做第二级"的分层思路。

---

## 二、ConcurrentHashMap 设计哲学

### 2.1 演进哲学：锁粒度从"段"到"桶"，从"自研锁"到"借力 JVM"

JDK7 -> JDK8 的演进表面是"Segment 没了"，本质是两条哲学线：

**哲学线 1：锁粒度持续细化**

```
JDK7：锁 Segment（默认16段，一段=N个桶）  并发度固定 16
JDK8：锁桶头节点（一个桶）                并发度 = table 长度（随扩容增长）
      空桶连 synchronized 都不用，纯 CAS
```

**哲学线 2：不重复造轮子，借力 JVM 持续优化**

- JDK8 之前大家嘲笑 synchronized 是"重量级锁"，JDK6+ 的锁升级链（Day02）让"低竞争 + 小临界区"场景的 synchronized 性能不输 ReentrantLock
- CHM 锁桶头节点恰好是"低竞争（桶冲突概率低）+ 小临界区（只改一个桶）"的最佳命中场景：多数加锁停在轻量级锁 CAS，很少膨胀到重量级
- **架构师经验**：选技术时要看它的"优化趋势线"，不是只看今天的快照。JDK 团队持续优化 synchronized（锁升级、JDK15 偏向锁废弃后的简化），Doug Lea 换 synchronized 是"跟着 JVM 红利走"的决策

**哲学线 3：数据结构换性能（红黑树兜底）**：链表 >= 8 且容量 >= 64 才树化--先扩容拆散（成本低），树化是兜底。防御 hash 碰撞攻击的同时不为小概率场景常态付费。

### 2.2 读无锁哲学：volatile 全链路

CHM 的 get 是读写不互斥的极致：**读路径 0 锁 0 CAS**，靠三级 volatile 撑起可见性：

```java
volatile Node<K,V>[] table;       // 一级：数组引用
    // Node 内：
    volatile V val;               // 二级：值
    volatile Node<K,V> next;      // 三级：链表指针
// 加上 tabAt/setTabAt 的 Unsafe acquire/release 语义读数组元素
```

**为什么够用（呼应 Day01 happens-before）**：

1. 写线程发布 Node 前，val/next 已在构造中赋值；CAS/volatile 写入桶（`casTabAt`/`setTabAt`）与读线程的 `tabAt` volatile 读建立 happens-before
2. hash / key 是 final：final 域禁止重排序到构造函数外（Day01），不存在"半构造 Node"
3. 结果：**读者要么看不到新节点，看到的一定是完整的新节点**--这正是弱一致读的工程承诺："已发布的数据完整可见"

**对比 Day03 的 UserMap 三方案**：RWLock 读要 CAS 读计数（且写饥饿）、StampedLock 乐观读要 validate 校验、CHM 读什么都没有。10w 长连接场景读 QPS 100w+，CHM 完胜的根本原因在此。

### 2.3 计数哲学：热点分离，牺牲精确性

size 的 baseCount + CounterCell 与 LongAdder 同源（Striped64）：

```
AtomicLong 思路（精确但单点）：          Striped64 思路（分散但近似）：
所有线程 CAS 一个地址                   低竞争：CAS baseCount
-> 缓存行核间弹跳                       高竞争：各线程 CAS 各自的 Cell
-> CAS 失败自旋浪费                     -> 竞争点分散，吞吐数倍
                                        代价：sum() 无锁快照 = 近似值
```

**关键认知**：Doug Lea 的判断是"**高并发场景下，size() 的用途（监控/日志/粗判）本来就不需要精确值**"。用业务上可接受的近似，换数量级的吞吐。这个取舍在业务架构里到处可复制：QPS 统计、缓存命中数、消息量--凡是"统计"都可以弱一致；凡是"控制流"（`if (size() < limit)`）都不行，应改用有界队列或 compute 复合操作。

### 2.4 扩容哲学：分而治之 + 协作 + 转发

CHM 的扩容三件套，每一件都是分布式思想的单机缩影：

| 机制 | 做的事 | 分布式世界的影子 |
|------|--------|----------------|
| stride 区间划分 + transferIndex | 把大迁移切成多个区间，线程按能力认领 | 分片（sharding）/ 任务分片调度 |
| helpTransfer | 写线程"顺路"帮扩容，不设专职扩容线程 | 协作式再平衡（如 Kafka 消费者协作再平衡） |
| ForwardingNode | 旧桶的"已迁移"标记 + get 请求转发 | 重定向（redirect）/ DNS 切流 |

**关键认知**：扩容期间 get 不阻塞（ForwardingNode.find 转发到新表）、put 顺路协助（MOVED 触发 helpTransfer）--**迁移期间读写服务不降级**。这与"双 buffer 切换 / 蓝绿发布"的业务架构思想同源：新旧表并存，逐步迁移，入口转发，迁完切换。

### 2.5 弱一致性迭代器：不抛异常的哲学

HashMap 的 fail-fast 是"发现你迭代中修改就炸"（bug 检测器），CHM 的 fail-safe 是"我怎么改都不炸，但你可能看到混合视图"：

- **设计目的不同**：modCount 是开发期 bug 检测；弱一致是运行期并发可用
- **架构师经验**：CHM 迭代器不抛 CME 不代表"迭代是事务性的"（不是快照隔离，是"推进式弱视图"）。对"必须一致的批量视图"需求（如对账快照），并发容器给不了，要靠外部冻结（复制、版本号、数据库快照）--呼应 06月第1周 MySQL 的一致性读

### 2.6 CHM 的复合操作：并发安全 ≠ 组合安全

```java
// 反例：两个原子操作的组合不原子
if (!map.containsKey(k)) map.put(k, v);      // check-then-act 竞态
User old = map.get(uid); if (old != null) map.put(uid, merge(old, delta));  // 读改写竞态

// 正例：CHM 内置的原子复合操作
map.putIfAbsent(k, v);                        // 不存在才放
map.computeIfAbsent(k, key -> load(key));     // 不存在才计算放入（网关会话懒加载）
map.compute(uid, (k, v) -> merge(v, delta));  // 原子读改写（统计累加）
map.merge(k, 1L, Long::sum);                  // 计数器经典写法
```

**架构师经验**：选 CHM 不只是为了"线程安全的 get/put"，**compute 系列把"锁粒度 = 一个桶"的复合操作原子化，才是它对业务的最大价值**。IM 网关的会话懒加载（computeIfAbsent）、在线人数统计（merge）都应优先用内置复合操作，而不是外面套 synchronized。

### 2.7 API 契约里的并发语义：null 禁令与 size 近似

CHM 有两个"反直觉"的 API 契约，都是并发语义倒逼的设计：

**null 禁令**：并发下 `get` 返回 null 无法区分"key 不存在"还是"值就是 null"；单线程可以用 containsKey 二次确认，但并发下"containsKey + get"两步之间可能被其他线程改掉，**二义性无法用组合操作消除**，索性禁止 null key/value（HashMap 单线程下二义性可消除，所以允许）。

**size 近似**：高并发精确计数需要全局锁或单点 CAS，两者都是吞吐杀手；CounterCell 分散计数换数量级吞吐，代价是弱一致快照。Doug Lea 的判断：size 的真实用途（监控/日志/粗判）不需要精确值。

```
API 设计启示：
  单线程容器：API 可以"含糊"（null 可区分，因为可以二次确认）
  并发容器：  API 必须把并发语义写进契约（禁 null / size 近似 / 迭代弱一致）
```

**架构师经验**：自己设计并发组件的 API 时同样如此--**契约（javadoc）里的每一句"不保证"都是给调用者的显式风险声明**。模糊的并发契约 = 未来的事故。

---

## 三、BlockingQueue 与生产者消费者

### 3.1 两 Condition 精确唤醒：Day03 的框架级落地

BlockingQueue 是 Day03 AQS Condition 章节最成功的应用。put/take 的骨架：

```java
public void put(E e) throws InterruptedException {
    lock.lockInterruptibly();
    try {
        while (count == items.length)   // 必须 while（防虚假唤醒 + 被唤醒后条件又变）
            notFull.await();            // 生产者睡 notFull 队列
        enqueue(e);
        notEmpty.signal();              // 精确叫醒消费者
    } finally {
        lock.unlock();
    }
}
```

**三个必答细节**：

1. **为什么 while 不是 if**：被唤醒到重新拿锁之间，条件可能又被其他线程改掉（如另一个生产者先把队列塞满）--唤醒后必须重检条件。这呼应 Day03"signal 只是转移到同步队列，拿到锁后还要重试"
2. **为什么两个 Condition**：生产者和消费者分开睡，signal 才能精确--单 WaitSet 的 notify 会误唤醒同类线程（惊群 + 空转）
3. **为什么必须持锁**：判断条件（count）和修改状态（enqueue）必须原子，否则丢失唤醒（Day03 await/signal 必须持锁的工程原因）

### 3.2 单锁 vs 两锁：数据结构决定锁策略

ArrayBlockingQueue 一把锁，LinkedBlockingQueue 两把锁，差异的根源在**数据结构**：

```
数组：putIndex/takeIndex/count 共享同一数组状态
  -> 读写无法分离地加锁 -> 单锁 + 两 Condition
链表：put 只碰尾（last），take 只碰头（head）
  -> 头尾天然分离 -> takeLock/putLock 各管一段
  -> 代价：count 必须 AtomicInteger（两把锁的持有者都会改）
  -> 代价：跨锁唤醒（signalNotEmpty 要额外拿 takeLock）
  -> 收益：生产与消费真正并行，高竞争吞吐 ~2 倍
```

**关键认知**：**不是"两锁一定比一锁好"，是"链表的头尾分离让两锁成为可能"**。业务系统同理：先看共享状态能不能物理拆开（如订单的读状态和写状态、Account 的借方贷方），能拆才谈锁分离。

### 3.3 无界队列：最隐蔽的炸弹

| 队列 | 默认容量 | 风险 |
|------|---------|------|
| LinkedBlockingQueue | Integer.MAX_VALUE（约 21 亿） | 生产 > 消费时线性堆积 -> OOM |
| ConcurrentLinkedQueue | 无界 | 同上，且 size() O(n) 无法做水位监控 |
| PriorityBlockingQueue | 无界（自动扩容） | 同上 |
| DelayQueue | 无界 | 堆积的到期任务一次涌出 |

**架构师经验（无界三连问）**：容量多大？满了怎么办？谁监控水位？对应的正解模板：

```java
// 监管上报缓冲队列的正解
BlockingQueue<Report> buffer = new LinkedBlockingQueue<>(10_000);   // 1. 显式有界
if (!buffer.offer(report)) {                                        // 2. 满时降级
    fallbackToDisk(report);          // 磁盘兜底（或发 Kafka / 丢弃计数告警）
}
// 3. 水位监控：buffer.size() / capacity > 0.8 告警 + 消费 lag 指标
```

这与 06月第4周限流降级的思路闭环：**内存队列的有界化 + 拒绝策略，本质就是队列版的"限流 + 降级"**。

### 3.4 DelayQueue 与延迟消息体系（串联 05月第4周）

DelayQueue 的 leader-follower 设计是"避免群醒"的经典：只有 leader 定时 `awaitNanos(最近的到期时间)`，follower 无限 await，到期或新任务入堆才重新选举。

**但单机 DelayQueue 有致命伤：内存态，重启丢任务**。延迟语义的完整选型：

```
延迟规模小 / 可容忍丢失（重试退避、会话超时）-> DelayQueue（纳秒级精度，零依赖）
中等规模 / 需要跨重启             -> Redis ZSet 轮询（秒级，配合持久化 + 对账）
业务关键（订单15分钟未支付关闭）   -> RocketMQ 延迟等级（持久化 + 重试，18 级固定）
海量短延迟（心跳/会话保持）        -> 时间轮 HashedWheelTimer（毫秒级，O(1)）
```

**关键认知**：在线问诊的"订单超时关闭"必须走 MQ 延迟消息或 Redis ZSet + 兜底对账（05月第4周"延迟消息 + 本地任务表"），DelayQueue 只能作为单机加速层。**"选延迟方案先问：重启丢了怎么办？"**

### 3.5 阻塞队列选型决策树

```
需要阻塞协调（满则等/空则等）？
├─ 否
│   ├─ 队列 -> ConcurrentLinkedQueue（无锁，注意无界）
│   ├─ 有序Map -> ConcurrentSkipListMap（范围查询）
│   └─ 读多写极少小列表 -> CopyOnWriteArrayList
└─ 是
    ├─ 延迟到期 -> DelayQueue（+持久化兜底）
    ├─ 优先级 -> PriorityBlockingQueue（无界注意堆积）
    ├─ 直接交付不排队 -> SynchronousQueue（handoff）
    ├─ transfer 语义 -> LinkedTransferQueue
    └─ 普通缓冲
        ├─ 吞吐优先（显式容量！）-> LinkedBlockingQueue
        └─ 严格有界/预分配/公平 -> ArrayBlockingQueue
Map 场景默认 ConcurrentHashMap；有界化 + 水位监控是铁律
```

这个决策树在 Day05 还会复用一半：**线程池的工作队列就是这里选的**--newFixedThreadPool 配无界 LinkedBlockingQueue（队列 OOM）、newCachedThreadPool 配 SynchronousQueue（线程爆炸 OOM）、自定义池推荐有界队列 + 明确拒绝策略。

### 3.6 从手写生产者消费者到 BlockingQueue：抽象的演进

Day03 用"ReentrantLock + 两 Condition"手写过监管上报的生产者-消费者（约 30 行），今天回头看，BlockingQueue 把它压缩成一行 put/take：

```java
// Day03 手写版（教学价值：理解 notFull/notEmpty 怎么工作）
lock.lock();
try {
    while (queue.size() == capacity) notFull.await();
    queue.offer(msg);
    notEmpty.signal();
} finally { lock.unlock(); }

// Day04 生产版（工程价值：正确性由 JDK 保证）
buffer.put(msg);     // 满则阻塞，等价于上面 7 行
```

**关键认知**：手写一遍的意义是**知道封装内部是什么**，生产直接用封装的意义是**把并发正确性交给经过千锤百炼的 JDK 实现**。架构师的学习路径就是"先能写对，再敢用封装，最后知道什么时候不能用封装"（如需要公平出队、需要批量 take、需要跨锁优先级时才自研）。

---

## 四、ThreadLocal 的坑

### 4.1 内存泄漏完整链路（四部曲）

```
1. 正常：栈强引用 TL 对象；Entry.key 弱引用 TL；Entry.value 强引用大对象
2. 栈引用消失（tlRef=null）：TL 对象只剩 Entry 的弱引用
3. GC：key 被回收（Entry.key==null），value 仍被 Entry->map->线程 强引用链拽着
4. 线程池核心线程不死 -> 脏 Entry 的 value 永不回收 -> 泄漏
   症状：老年代 GC 后不降（呼应 JVM 专题），MAT 看到 key==null 的 Entry
```

### 4.2 为什么弱引用是"两害相权"

如果 key 是强引用：TL 对象本身在线程存活期间永远回收不了，连"自愈入口"（key==null 触发 expungeStaleEntry）都没有。弱引用把"对象+值全泄漏"降级为"仅值泄漏且有自愈机会"。

**关键认知**：**弱引用是安全网，不是免死金牌**。自愈（expungeStaleEntry）只在继续调用 set/get/remove 时触发；任务结束就不再访问，脏 Entry 挂到线程死。唯一正解是 finally remove。

### 4.3 比泄漏更严重的是串号：医疗串档

在线问诊的 UserContext（患者上下文）透传，线程池场景的两种事故形态：

```
形态 1（泄漏）：任务设置后不 remove -> value 泄漏（慢性病，内存涨）
形态 2（串号）：任务A设置不 remove，线程复用执行任务B -> B 读到 A 的患者上下文
             -> 处方/就诊记录查给错误患者 -> 医疗信息串档（急性病，重大事故）
```

串号与 07月第2周 EMPI 错配同性质：**患者A 的数据给了患者B**。在医疗合规语境下这是《个人信息保护法》级别的重大事故，比 OOM 严重得多。**架构师经验：ThreadLocal 的评审标准不是"会不会泄漏"，是"会不会串"--泄漏是资源问题，串号是安全事故。**

正解组合拳：

```java
// 1. 拦截器收口：preHandle 设置 / afterCompletion 清理（异常路径也执行）
// 2. 异步/线程池路径：TtlRunnable 包装或 TtlExecutors 包装线程池（capture/replay/restore）
// 3. 兜底：业务关键操作前校验 context 的请求 id 与当前请求一致（防串号断言）
// 4. 演进：JDK21 ScopedValue（作用域绑定自动清理）+ 虚拟线程友好
```

### 4.4 InheritableThreadLocal 为什么在线程池失效

ITL 的复制时机是 `new Thread()` 的 init--**线程创建那一刻浅拷贝父线程数据**。线程池线程复用不再走 init：worker 里的数据永远是"第一次创建它的那个提交者"的旧数据。TTL 把传递时机挪到任务执行时（提交时 capture 快照、执行时 replay + 备份、结束 restore），池化场景才真正正确。

### 4.5 ThreadLocal 使用 Checklist

1. 哪里 set？哪里 remove？（必须 try/finally 或拦截器收口对称）
2. 线程池/异步链路谁负责传递？（TTL 包装）
3. value 是大对象吗？（泄漏时 value 是内存主体）
4. 有没有静态集合持有 ThreadLocal？（静态 ThreadLocal 永不回收，等同泄漏放大器）
5. 关键业务有没有防串号断言？（医疗/资金场景必须）

### 4.6 面试追问链与标准回答路径

ThreadLocal 是"三层追问"的经典题，每层的标准回答路径：

```
第 1 层（是什么）：线程本地变量，每个线程一份副本，互不干扰
第 2 层（怎么实现）：Thread.threadLocals（map 挂在 Thread 上），
  Entry 是 WeakReference<ThreadLocal> key + 强引用 value，黄金分割散列
第 3 层（为什么泄漏 / 为什么串号）：
  泄漏：外部引用消失 -> key 被 GC -> value 仍被 Entry 强引 -> 线程不死 -> 泄漏
  弱引用是两害相权（防 TL 对象本身泄漏），自愈不可靠，正解 finally remove
第 4 层（线程池衍生）：
  ITL 为何失效（init 只复制一次）-> TTL 三段式 -> ScopedValue 是未来
  并主动抛出：医疗场景串号 = 串档级事故（比泄漏严重，EMPI 并案）
```

**架构师经验**：答到第 4 层还主动联系业务场景，面试官就不太会继续追问了--**你已经把面试官想问的都说完了**。

---

## 五、原子类与 LongAdder

### 5.1 CAS 的三个固有问题与 JDK 的三层演进

```
问题 1：ABA（值变回来了 CAS 不知道）
  -> 无害于纯计数，有害于引用复用（无锁栈/链表）
  -> AtomicStampedReference / AtomicMarkableReference

问题 2：自旋浪费（CAS 失败重试烧 CPU）
  -> 高竞争下失败率上升，吞吐崩
  -> LongAdder 分散热点（见 5.2）

问题 3：单点竞争（同一地址的缓存行核间弹跳，MESI Invalidate）
  -> 多核扩展性差（核越多越慢）
  -> LongAdder 的 Cell[] + @sun.misc.Contended 128 字节填充
```

### 5.2 LongAdder 分段思想（与 CHM CounterCell 同源）

```
AtomicLong：64 线程 CAS 1 个地址 -> 同一缓存行 64 核弹跳
LongAdder：64 线程 CAS 分散的 Cell（约 CPU 核数个）
  add：先 casBase，失败按线程 probe 找 Cell，cell CAS 也失败换/扩 cells
  sum：base + 所有 Cell 无锁快照（弱一致）
```

**关键认知**：LongAdder 与 CHM 的 CounterCell 都出自 Striped64--**"热点分离 + 弱一致求和"是一个可复用的架构模式**，业务里的大盘计数（秒杀 QPS、IM 消息量、监管上报条数）都该用它。

### 5.3 伪共享：从 MESI 到 @Contended（呼应 Day01）

64 字节缓存行装了 8 个 long 时，不同核改不同 long 也会互相 Invalidate（缓存行是 MESI 的一致性单位，不是变量）。@Contended 用 128 字节填充把每个 Cell 隔离到独立缓存行（两倍是防相邻缓存行的预取伪别名）。应用层要用需 `-XX:-RestrictContended`，JDK 内部类（Cell/CounterCell）默认生效。

**架构师经验**：伪共享是"并发数据结构性能莫名差"的隐形原因之一。业务自研的环形缓冲区/计数器数组，要么 Padding 手工填充（7 个多余 long），要么 Netty 的 `@UnstableApi` Padding 类思路。

### 5.4 原子计数选型表

| 场景 | 选择 | 理由 |
|------|------|------|
| 低竞争计数 / 需要精确值 | AtomicLong | 简单，get 精确 |
| 状态机 CAS（CONNECTING->CONNECTED） | AtomicReference / AtomicLong | LongAdder 无 compareAndSet |
| `if (get()==1) 首个进入` 类控制流 | AtomicLong | 需要精确时点值 |
| 高竞争纯统计（QPS/总量/监控打点） | LongAdder | 吞吐数倍，弱一致可接受 |
| 引用复用场景的 CAS | AtomicStampedReference | 防 ABA |

**秒杀场景的架构拆分**：库存扣减（精确，Redis+DB，呼应 06月第2周）与成交/QPS 统计（近似，LongAdder）**分离**--"控制流精确、统计流近似"，这是并发计数的第一设计原则。

### 5.5 高性能计数架构模板（可直接套用）

```java
public class BizMetrics {
    // 统计流：全部 LongAdder（高竞争、弱一致可接受）
    private final LongAdder totalReq = new LongAdder();
    private final LongAdder successCount = new LongAdder();
    private final LongAdder failCount = new LongAdder();

    // 控制流：AtomicLong/AtomicReference（需要精确值或 CAS 语义）
    private final AtomicLong circuitState = new AtomicLong(0);   // 熔断状态机
    private final AtomicInteger concurrent = new AtomicInteger(); // 当前并发数

    public void onRequest() { totalReq.increment(); }
    public void onResult(boolean ok) { (ok ? successCount : failCount).increment(); }

    public double failRate() {                     // 秒级采样
        long total = totalReq.sum();               // 弱一致快照
        return total == 0 ? 0 : (double) failCount.sum() / total;
    }
}
```

模板的三条纪律：统计打点绝不进控制流判断；熔断/限流的窗口判断用精确值（或接受近似但选对窗口算法，呼应 06月第4周滑动窗口）；打点方法内不做 IO（否则 LongAdder 省下的 CPU 全还给日志了）。

---

## 六、在线问诊系统实战

### 6.1 场景一：IM 网关 UserMap 的 ConcurrentHashMap 决策链（Day03 方案的深挖）

**场景（S）**：IM 网关单机 10w+ 长连接，UserMap 维护 userId -> Session。读（消息路由查连接）100w QPS，写（上下线）100 QPS。

**决策链（T）**：

```java
// 方案对比（Day03 已比锁，今天从容器视角定案）
// synchronizedMap：读写全互斥 -> 100w 读 QPS 直接串行化，否决
// HashMap + RWLock：读要 CAS 计数 + 写饥饿风险（Day03），否决
// HashMap + StampedLock 乐观读：validate 版本号开销 + 复合操作仍需写锁，次优
// ConcurrentHashMap：读 0 锁 0 CAS，写锁粒度=桶头，复合操作原子 -> 定案

public class UserChannelMap {
    private final ConcurrentHashMap<Long, Channel> userMap = new ConcurrentHashMap<>(1 << 17); // 初始容量预估，减少扩容

    public void online(Long userId, Channel ch) {
        Channel old = userMap.put(userId, ch);
        if (old != null && old != ch) old.close();     // 顶号下线：put 原子语义天然支持
    }
    public void offline(Long userId, Channel ch) {
        userMap.remove(userId, ch);                    // 双参 remove：防止误删顶号后的新连接
    }
    public Channel route(Long userId) {
        return userMap.get(userId);                    // 无锁读，消息路由热路径
    }
    public int onlineCount() {
        return userMap.size();                         // 近似值，仅用于监控
    }
}
```

**关键实现细节（面试加分点）**：

1. **顶号互踢用 put 的返回值**：put 返回旧 Channel，原子完成"覆盖 + 拿到旧连接关闭"
2. **下线用 remove(k, v) 双参版**：防止"顶号后旧连接心跳超时误删新连接"的竞态
3. **构造预估容量**：10w 用户 / 0.75 负载 -> 初始 1&lt;&lt;17（13w 桶），避免上线高峰触发扩容迁移
4. **size 只做监控**：网关汇报在线数允许秒级误差

**四方案压测对比（4C8G，10w 在线用户，读:写 = 10000:1）**：

| 方案 | 读 QPS | 写 QPS | P99 读延迟 | 写饥饿 | 备注 |
|------|--------|--------|-----------|--------|------|
| synchronizedMap | ~18w | ~2w | 8 us | 有 | 全局锁串行化 |
| RWLock + HashMap | ~55w | ~0.5w | 3 us | 有（持续读时） | Day03 方案 1 |
| StampedLock + HashMap | ~90w | ~1w | 1.8 us | 无 | 乐观读 validate 开销 |
| **ConcurrentHashMap** | **~120w** | **~5w** | **1.2 us** | 无 | 读 0 锁 0 CAS，定案 |

（数据为 JMH 压测量级参考，面试口述"CHM 读吞吐约为 RWLock 的 2 倍、synchronizedMap 的 6 倍以上"即可。）

**结果（R）**：路由路径无锁，压测单机消息路由 120w QPS（4C8G），上下线峰值无感知。

### 6.2 场景二：监管上报缓冲队列的无界 OOM 事故（STAR）

**S（背景）**：公卫监管平台要求问诊/体检数据实时上报，上报服务用"内存缓冲 + 定时批量发送"：请求线程 offer 入队，异步线程批量 take 发送。

**T（事故与排查）**：

```java
// 事故代码
BlockingQueue<Report> buffer = new LinkedBlockingQueue<>();  // 默认无界！
requestExecutor.submit(() -> buffer.offer(buildReport(dto))); // 生产 2000/s
// 消费：批量 take 200 条 -> 监管接口 HTTP POST（RT 正常 50ms）

// 监管平台故障日：接口 RT 50ms -> 5s（限流+重试），消费速率 2000/s -> 200/s
// 队列净增 1800 条/s * 单条 2KB = 3.6MB/s
// 3 小时堆积 ~38GB：Young GC 频繁 -> 大对象直进老年代（G1 Humongous）-> Full GC 风暴
// -> OOM（GC overhead limit exceeded）-> 上报服务整体不可用
// 呼应 JVM 专题调优周：GC 日志 Old 回收无效 + jmap 直方图 LinkedBlockingQueue$Node 霸榜
```

**A（修复）**：

```java
// 1. 有界化：容量 1w（约 20MB，按单条 2KB 估算）
BlockingQueue<Report> buffer = new LinkedBlockingQueue<>(10_000);
// 2. 满时降级：offer 失败 -> 写本地磁盘队列（重启可重发）+ 丢弃计数告警
if (!buffer.offer(report)) {
    diskBacklog.append(report);               // 兜底，恢复后回放
    degradedCount.increment();                // LongAdder 统计降级量
}
// 3. 水位监控：size/capacity > 0.8 告警；消费 lag 指标接 Grafana
// 4. 消费端加固：批量 take + 超时控制 + 失败指数退避（呼应 Day03/DelayQueue 思想）
```

**R（结果）**：再次监管接口抖动时，服务稳定（队列打满走磁盘降级，峰值降级 12w 条，恢复后 40 分钟回放完毕），全程无 OOM。**面试讲述要点：无界三连问（容量/满了怎么办/谁监控）+ GC 排查证据链（JVM 专题串联）。**

### 6.3 场景三：秒杀系统 QPS 统计的 LongAdder（统计与扣减分离）

**S**：秒杀活动（老项目经验）大促峰值 8w QPS，64 个工作线程，需要实时统计：总请求数 / 下单成功数 / 命中限流数，用于大盘与动态限流参考。

**T（方案）**：

```java
public class SeckillMetrics {
    // 控制流（精确）：库存扣减走 Redis Lua + DB（呼应 06月第2周），不用内存原子类
    // 统计流（近似）：LongAdder 分散热点
    private final LongAdder totalReq = new LongAdder();
    private final LongAdder orderSuc = new LongAdder();
    private final LongAdder rateLimited = new LongAdder();

    public void onRequest() { totalReq.increment(); }
    public void onOrder()   { orderSuc.increment(); }
    public void onLimited() { rateLimited.increment(); }

    public double successRate() {           // 秒级采样计算成功率
        long total = totalReq.sum();        // 弱一致快照，统计可接受
        return total == 0 ? 0 : (double) orderSuc.sum() / total;
    }
}
```

**性能对比（JMH 思路，4C 压测数据量级）**：

| 计数方案 | 4 线程吞吐 | 32 线程吞吐 | 精确性 |
|---------|-----------|------------|--------|
| synchronized ++ | ~3kw ops/s | ~1kw ops/s（锁竞争恶化） | 精确 |
| AtomicLong | ~6kw ops/s | ~2.5kw ops/s（CAS 单点弹跳） | 精确 |
| LongAdder | ~5.5kw ops/s | ~1.1亿 ops/s（热点分散） | sum 弱一致 |

**R**：32 线程下 LongAdder 比 AtomicLong 高 4 倍以上；成功率大盘秒级刷新无抖动。**面试要点：为什么库存不用 LongAdder（需要精确扣减与 CAS 语义）、为什么统计不用 AtomicLong（高竞争单点弹跳）--"控制流精确、统计流近似"的分离原则。**

### 6.4 场景四：UserContext 串号事故与 TTL 改造（医疗串档级）

**S**：在线问诊全链路透传患者上下文（患者id/就诊卡/角色），网关解析 JWT 后 ThreadLocal 存储，服务层/DAO/日志 traceId 全依赖它。异步开方（敏感操作）走独立线程池。

**T（事故链路）**：

```java
// 隐患代码
public class UserContext {
    private static final ThreadLocal<Ctx> HOLDER = new ThreadLocal<>();
    public static void set(Ctx c) { HOLDER.set(c); }
    public static Ctx get() { return HOLDER.get(); }   // 无 remove
}
// 异步开方任务（线程池）：
asyncPool.submit(() -> {
    Ctx ctx = UserContext.get();          // 提交线程没传，worker 里是【上一个任务】的残留
    prescriptionDao.saveDraft(ctx.getPatientId(), draft);  // 串号！
});
// 某次复现：患者A 的问诊结束后，患者B 的草稿查询返回了 A 的处方草稿
// 定性：医疗信息串档（并案 07月第2周 EMPI 错配），合规重大事故
```

**A（修复）**：

```java
// 1. 同步链路：拦截器收口
public class UserContextInterceptor implements HandlerInterceptor {
    public boolean preHandle(HttpServletRequest req, HttpServletResponse resp, Object h) {
        UserContext.set(resolvePatient(req));       // JWT -> 患者
        return true;
    }
    public void afterCompletion(HttpServletRequest req, HttpServletResponse resp, Object h, Exception e) {
        UserContext.remove();                        // 异常路径也执行
    }
}
// 2. 异步链路：TTL 包装线程池 + 防串号断言
ExecutorService ttlPool = TtlExecutors.getTtlExecutorService(asyncPool);
ttlPool.submit(() -> {
    Ctx ctx = UserContext.get();                    // TTL 已 replay 提交者的快照
    assert ctx.getRequestId().equals(currentReqId); // 兜底断言：请求 id 一致才放行
    prescriptionDao.saveDraft(ctx.getPatientId(), draft);
});
// 3. 长期：评估 JDK21 ScopedValue + 虚拟线程（Day05 铺垫）
```

**R**：串号根因消除（拦截器统一清理 + TTL 任务级传递 + 断言兜底），压测 10w 并发请求零串号。**面试要点：把"泄漏（慢性）"与"串号（急性安全事故）"分层定性，再讲 TTL 的 capture/replay/restore 原理。**

### 6.5 场景五：问诊订单超时关闭的延迟方案选型

**S**：问诊订单 15 分钟未支付自动关闭（释放号源）。日均 5w 单，峰值 3000 单/15分钟。

**T（选型对比）**：

| 方案 | 精度 | 可靠性 | 成本 | 结论 |
|------|------|--------|------|------|
| 单机 DelayQueue | 纳秒 | 重启丢任务 | 零依赖 | 否决（号源泄漏不可接受） |
| Redis ZSet 轮询 | 秒级 | 持久化 + 需对账 | 低 | 备选（当前规模够用） |
| RocketMQ 延迟等级（15min 档） | 级别固定 | 消息持久化 + 重试 | 中 | **定案**（05月第4周延迟消息方案） |
| DB 定时扫描 | 分钟级 | 最高 | 低（扫表压力） | 兜底对账（每 10 分钟扫超时单） |

```java
// 最终架构：MQ 延迟消息（主）+ DB 扫表（兜底对账）
orderService.create(order);                       // 1. 落库 status=UNPAID
mqProducer.sendDelay(orderId, DelayLevel.X);      // 2. 15min 延迟消息（05月第4周）
// 3. 延迟消费者：status 仍 UNPAID -> 关闭 + 释放号源（幂等，呼应支付幂等专题）
// 4. 兜底定时任务：扫描 create_time > 20min 且 UNPAID 的单补关闭（防消息丢失）
```

**R**：超时关闭准确率 100%（消息 + 扫表双保险），号源不再泄漏。**面试要点：先否定 DelayQueue（内存态不持久），再给出"主消息 + 兜底扫表"的双保险，体现单机容器与分布式设施的边界意识。**

### 6.6 五案例的汇总与共同模式

**五案例的容器决策汇总表**：

| 案例 | 容器/工具 | 关键决策点 | 踩过的坑/否决的方案 |
|------|----------|-----------|-------------------|
| IM 网关 UserMap | ConcurrentHashMap | 读 0 锁 + 顶号 put 原子 + remove(k,v) 防误删 | synchronizedMap 串行化、RWLock 写饥饿（Day03） |
| 监管上报缓冲 | LinkedBlockingQueue（有界 1w） | 显式容量 + 满则磁盘降级 + 水位监控 | 默认无界 OOM（38GB 堆积事故） |
| 秒杀统计 | LongAdder | 统计与扣减分离（控制流精确/统计流近似） | AtomicLong 高竞争单点弹跳 |
| UserContext 透传 | ThreadLocal + TTL | 拦截器收口 + 任务级传递 + 防串断言 | 不 remove 串号（医疗串档级事故） |
| 订单超时关闭 | MQ 延迟消息 + DB 扫表 | 单机容器只做加速层，持久化兜底 | DelayQueue 重启丢任务 |

**四个共同架构模式（可复用的方法论）**：

1. **先定性失败模式再选容器**：每个案例的第一问都是"最坏怎么死"（串行化/OOM/串号/丢任务），而不是"哪个性能好"
2. **精确与近似分层**：需要精确的走精确设施（Redis/DB/AtomicLong），可以近似的走弱一致设施（CHM size/LongAdder/弱一致迭代）--不混用
3. **单机容器 + 持久化兜底**：内存容器只承担性能层，可靠性交给磁盘/MQ/扫表对账（监管上报、订单超时两个案例同构）
4. **清理与传递收口到框架**：ThreadLocal 的 set/remove/异步传递不允许业务代码裸写（拦截器 + TTL 统一管理），把易错动作从"人人都要记住"变成"框架保证"

**架构师经验**：面试中被问"你项目里怎么用并发容器"，最优结构是**"一个汇总表 + 一个深案例"**：30 秒讲全五个场景证明广度，然后挑监管上报 OOM 或 UserContext 串号讲 3 分钟 STAR 证明深度（排查链路：现象 -> GC 日志/jmap 证据 -> 根因 -> 修复 -> 防复发监控）。

---

## 七、本日核心认知

1. **容器选型是架构决策**：每次选型同时决定一致性模型、背压策略、故障模式、容量规划--先问"最坏怎么死"，再问"怎么实现"
2. **CHM 演进三条哲学线**：锁粒度从段到桶、借力 JVM 的 synchronized 优化（Day02）、数据结构兜底（红黑树）；弱引用 null 禁令是对二义性的防御
3. **get 无锁靠三级 volatile**（table/val/next + Unsafe acquire），本质是 Day01 happens-before 的工程落地："已发布的数据完整可见"的弱一致承诺
4. **size 近似是热点分离的代价**：baseCount+CounterCell 与 LongAdder 同源 Striped64，统计可弱一致，控制流必须精确
5. **扩容三件套是分布式思想的单机缩影**：stride 分片 + helpTransfer 协作 + ForwardingNode 转发 = "迁移期间服务不降级"
6. **fail-fast 是 bug 检测器，不是并发保证**：CME 连单线程都会抛；fail-safe 弱一致是性能换一致性的取舍
7. **跳表换红黑树是为并发换结构**：概率平衡 -> 修改局部性 -> CAS 可无锁化
8. **COW 三陷阱**：内存翻倍 GC 压力、迭代器快照不支持 remove、复合操作覆盖并发修改--只配"读多写少 + 小数据量"
9. **BlockingQueue 是 AQS Condition 的框架级落地**：两 Condition 精确唤醒 + while 重检 + 必须持锁；LBQ 两锁成立的前提是链表头尾天然分离
10. **无界是并发容器最隐蔽的炸弹**：无界三连问（容量多大/满了怎么办/谁监控水位）是评审铁律，监管上报 OOM 与 newCachedThreadPool 线程爆炸同根同源（Day05 延续）
11. **ThreadLocal 的弱引用是两害相权**：防的是更严重的对象泄漏，不是免死金牌；线程池场景串号比泄漏更严重--医疗串档是合规级事故，正解 = 拦截器收口 + TTL + 防串断言
12. **"控制流精确、统计流近似"**：AtomicLong 管 CAS 与精确判断，LongAdder 管高竞争统计；伪共享的 @Contended 是 Day01 MESI 认知的源码级回响
13. **面试表达结构：一个汇总表 + 一个深案例**：30 秒讲全五个业务场景证明广度，再挑监管上报 OOM 或 UserContext 串号讲 3 分钟 STAR（现象 -> 证据链 -> 根因 -> 修复 -> 防复发）证明深度--并把根因自然挂回 Day01-03 的 JMM / 锁 / AQS 知识线
