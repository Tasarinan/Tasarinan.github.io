# 架构师学习-Day04-并发容器

> 日期：2026年08月13日（周四）
> 周主题：并发编程专题 - JMM / synchronized 锁升级 / AQS / 并发容器 / 线程池 / 虚拟线程
> 出题日：Day04 - 并发容器

---

## 背景

经过 Day01 JMM（可见性的契约）、Day02 synchronized 锁升级（内置锁的进化）、Day03 AQS（显式同步器的框架），本周进入**并发容器**专题。前三日讲的是"怎么协调多个线程"，Day04 讲的是"多个线程协调好了之后，往哪里存数据"。

并发容器是 JMM / synchronized / AQS 三者的**集大成者**：

- ConcurrentHashMap 的 get 无锁依赖 **Day01 的 volatile happens-before**
- ConcurrentHashMap JDK8 锁桶头节点用的是 **Day02 的 synchronized 锁升级优化**
- BlockingQueue 的 put/take 依赖 **Day03 的 AQS Condition 多队列精确唤醒**
- LongAdder / CounterCell 依赖 **Day01 的 CAS + MESI 缓存行认知**

架构师面试官最爱问的不是"ConcurrentHashMap 怎么用"，而是：

> "JDK7 的 Segment 继承 ReentrantLock，JDK8 为什么改成 CAS + synchronized 锁桶头节点？synchronized 不是更 Low 吗？"
> "ConcurrentHashMap 的 get 为什么不加锁？扩容的时候 get 到的是新表还是旧表？"
> "size() 返回的是精确值吗？为什么和 LongAdder 是一个思想？"
> "线程池里用 ThreadLocal 不 remove 会怎样？value 到底怎么泄漏的？key 为什么设计成弱引用？"

这些问题答不出来，等于"并发容器只会 new，不知道里面是什么"：IM 网关的 UserMap 为什么用 ConcurrentHashMap 而不是 synchronizedMap、监管上报的缓冲队列为什么会 OOM、秒杀的 QPS 统计为什么用 LongAdder，全是黑盒。本周 Day04 把并发容器一次性梳理清楚，Day05 进入线程池（线程池的工作队列就是今天的 BlockingQueue），Day06 串联整合，Day07 深挖 AQS 源码与生产事故反推。

**Day04 为什么是"并发容器"而不是"线程池"**：

1. **容器先于线程池**：线程池的工作队列（LinkedBlockingQueue / SynchronousQueue）就是今天的 BlockingQueue；不懂阻塞队列，线程池的拒绝策略和 newCachedThreadPool OOM 事故无法理解
2. **并发容器是面试超高频**：ConcurrentHashMap 是 Java 面试的"第一梯队考题"，JDK7->JDK8 演进 / size 机制 / 扩容协助是标准追问链
3. **并发容器是事故高发区**：无界队列 OOM、ThreadLocal 线程池串号、COW 内存翻倍，都是真实生产事故模式
4. **与简历项目强绑定**：IM 网关 10w+ 长连接 UserMap、监管上报缓冲队列、秒杀 QPS 统计、问诊 UserContext，每个都有对应的容器选型决策

**与往周专题的衔接点**：

- **Day03 AQS Condition** vs **BlockingQueue notFull/notEmpty**：ArrayBlockingQueue / LinkedBlockingQueue 的 put/take 就是 Day03 多 Condition 精确唤醒的教科书实现
- **Day02 synchronized 锁升级** vs **CHM JDK8 桶头 synchronized**：JDK8 敢用 synchronized 锁桶头节点，正是因为 JDK 6+ 的偏向锁（当时）/轻量级锁/自适应自旋优化--锁升级链是 CHM 演进的前提
- **Day01 volatile happens-before** vs **CHM get 无锁**：table / val / next 三级 volatile 读写链路建立可见性，是 JMM 规则的工程落地
- **Day01 MESI / 缓存行** vs **LongAdder @Contended**：CounterCell / Cell 的 128 字节填充对抗伪共享，是 MESI 协议在 JDK 源码层的直接应用
- **05月第4周 MQ 延迟消息** vs **DelayQueue**：单机 DelayQueue 与 RocketMQ 延迟等级 / Redis ZSet 轮询是"延迟语义"的两级实现（单机 vs 分布式），今天做串联
- **07月第2周 EMPI 串档风险** vs **ThreadLocal 线程池串号**：医疗串档是重大事故级别，UserContext 串号和 EMPI 错配是同一性质的问题--"患者 A 的数据给了患者 B"

**与简历项目的衔接点**：

在线问诊系统的并发容器四大重灾区：

1. **IM 网关 UserMap**：10w+ 长连接的在线用户表，上线 put / 下线 remove / 消息路由 get，Day03 比较了 RWLock / StampedLock / ConcurrentHashMap 三方案，今天深挖 ConcurrentHashMap 为什么赢
2. **监管上报服务的缓冲队列**：上报消息先入内存队列再批量发送，用了 LinkedBlockingQueue 默认无界容量，监管接口抖动时队列堆积导致 OOM（真实事故模式）
3. **秒杀系统的 QPS / 成交统计**：库存扣减要精确（Redis + DB），但 QPS / 下单量统计只需近似值，高并发计数用 LongAdder
4. **问诊链路的 UserContext**：患者上下文用 ThreadLocal 在网关 -> 服务 -> DAO 全链路透传，线程池场景下曾出现"患者 A 的请求读到患者 B 的上下文"串号风险（医疗串档级事故）

---

## 题目一（ConcurrentHashMap 全解题）：ConcurrentHashMap 全解

请详细回答以下问题：

1. **JDK7 -> JDK8 演进全解**：JDK7 的 Segment 分段锁结构（Segment extends ReentrantLock，默认 16 段，HashEntry 链表）？JDK8 为什么抛弃 Segment 改成 CAS + synchronized 锁单个桶头节点（5 大原因：锁粒度 / synchronized 优化 / 内存开销 / 红黑树 / 协助扩容）？两者的锁粒度、并发度、查询复杂度对比？
2. **put 流程全解**：spread 哈希扩散为什么高低位异或 + HASH_BITS 保证非负（负数 hash 有特殊含义 MOVED/-1、TreeBin/-2）？空桶为什么用 CAS 无锁插入？非空桶 synchronized 锁的是哪个对象？treeifyBin 的两个条件（链表 >= 8 且 table >= 64，否则先扩容）？为什么 key / value 都不允许 null（并发下 get 返回 null 的二义性）？
3. **get 为什么无锁**：table（volatile 数组引用）+ Node.val（volatile）+ Node.next（volatile）的可见性链路？扩容期间 get 的行为（ForwardingNode.find 转发到 nextTable）？弱一致性为什么工程上可接受？
4. **size 全解**：baseCount + CounterCell[] 分散计数为什么与 LongAdder 同思想（热点分离）？@sun.misc.Contended 为什么能避免伪共享？size() 为什么是近似值？与 JDK7 size 对比？
5. **多线程扩容 transfer 全解**：sizeCtl 的 4 种状态？stride 步长为什么按 NCPU 划分（最小 16）？transferIndex 抢区间？ForwardingNode 的两大作用（迁移标记 + get 转发）？高低位链拆分（fn & n）？扩容期间 get / put 行为？
6. **fail-fast vs fail-safe 全解**：HashMap 的 modCount 机制？ConcurrentModificationException 的触发场景（含单线程）？ConcurrentHashMap 的弱一致性迭代器？迭代中安全删除的方式？fail-fast 的设计目的（bug 检测而非并发保证）？

### 作答区

#### 1. JDK7 -> JDK8 演进全解

**JDK7 的分段锁结构**：

```
ConcurrentHashMap (JDK7)
┌─────────────────────────────────────────────┐
│  Segment[] segments（默认 16，不可扩段）     │
│  ┌─────────┐  ┌─────────┐      ┌─────────┐  │
│  │Segment 0│  │Segment 1│ .... │Segment15│  │
│  │extends  │  │extends  │      │extends  │  │
│  │Reentrant│  │Reentrant│      │Reentrant│  │
│  │  Lock   │  │  Lock   │      │  Lock   │  │
│  │HashEntry│  │HashEntry│      │HashEntry│  │
│  │[] 链表  │  │[] 链表  │      │[] 链表  │  │
│  └─────────┘  └─────────┘      └─────────┘  │
└─────────────────────────────────────────────┘
```

- 定位：两次 hash -- 先定位 Segment，再定位 HashEntry
- 加锁：put 时锁住**整个 Segment（含其下所有桶）**，并发度固定 16

**JDK8 的结构**：

```
ConcurrentHashMap (JDK8)
┌────────────────────────────────────────────────────┐
│  transient volatile Node<K,V>[] table              │
│  ┌────┐  ┌────┐  ┌────┐  ┌────┐  ┌────┐           │
│  │null│  │ f  │  │null│  │ f  │  │Tree│           │
│  └────┘  └─┬──┘  └────┘  └─┬──┘  └─┬──┘           │
│            │                │       │              │
│        CAS 抢到        synchronized │ 红黑树        │
│        （空桶无锁）    锁住 f（桶头）│ O(log n)     │
│            ↓                ↓      ↓               │
│        Node->Node->Node        TreeBin(hash=-2)    │
└────────────────────────────────────────────────────┘
```

**JDK8 为什么抛弃 Segment（5 大原因）**：

1. **锁粒度更细**：Segment 锁"一段多个桶"，JDK8 锁"单个桶头节点"。16 个 Segment 放 10w 个桶时，同一段内不同桶的写仍互相阻塞；桶粒度下冲突概率极低
2. **synchronized 已优化（呼应 Day02）**：JDK 6+ 锁升级让"低竞争、小临界区"场景的 synchronized 不输 ReentrantLock；锁桶头正是最佳命中场景--多数时候停在轻量级锁 CAS，很少膨胀到重量级锁
3. **内存开销更小**：16 个 Segment（每个是 ReentrantLock + HashEntry 数组 + 若干字段）的固定冗余被去掉
4. **红黑树解决长链表**：JDK7 碰撞严重时链表 O(n)；JDK8 链表 >= 8 树化为 O(log n)（防御恶意 hash 碰撞攻击）
5. **多线程协助扩容**：JDK7 扩容是 Segment 内单线程 rehash；JDK8 多线程按 stride 认领区间并行迁移

**JDK7 vs JDK8 对比表**：

| 维度 | JDK7 | JDK8 |
|------|------|------|
| 数据结构 | Segment[] + HashEntry[] 链表 | Node[] + 链表 / 红黑树 |
| 锁实现 | Segment extends ReentrantLock | CAS（空桶）+ synchronized（桶头） |
| 锁粒度 | 段（默认 16 段） | 桶（随扩容增长） |
| 并发度 | 固定 | 动态（等于 table 长度） |
| 查询复杂度 | O(1) -> O(n) | O(1) -> O(log n) |
| 扩容 | Segment 内单线程 | 多线程协助 |
| 计数 | 无锁试 2 次再锁全部 Segment | baseCount + CounterCell（无锁） |
| null key/value | 不允许 | 不允许（HashMap 允许） |

**架构师经验**：JDK7 -> JDK8 的演进本质是"**锁粒度从粗到细 + 从自研锁到借力 JVM 优化 + 从精确计数到热点分离**"三条哲学线。这三条哲学线同样适用于业务系统设计：锁什么、锁多细、计数是否必须精确。

#### 2. put 流程全解

**putVal 主流程（源码骨架）**：

```java
final V putVal(K key, V value, boolean onlyIfAbsent) {
    if (key == null || value == null) throw new NullPointerException();
    int hash = spread(key.hashCode());              // 1. 哈希扩散
    for (Node<K,V>[] tab = table;;) {               // 2. 自旋重试
        Node<K,V> f; int n, i, fh;
        if (tab == null || (n = tab.length) == 0)
            tab = initTable();                      // 2.1 懒初始化
        else if ((f = tabAt(tab, i = (n - 1) & hash)) == null) {
            if (casTabAt(tab, i, null,              // 2.2 空桶：CAS 无锁插入
                     new Node<K,V>(hash, key, value)))
                break;
        }
        else if ((fh = f.hash) == MOVED)
            tab = helpTransfer(tab, f);             // 2.3 正在扩容：协助迁移
        else {
            synchronized (f) {                      // 2.4 非空桶：锁桶头节点
                if (tabAt(tab, i) == f) {           // 2.4.1 双重检查
                    if (fh >= 0) { /* 链表尾插 or 覆盖 */ }
                    else if (f instanceof TreeBin) { /* 红黑树插入 */ }
                }
            }
            if (binCount >= TREEIFY_THRESHOLD)      // 2.5 链表>=8
                treeifyBin(tab, i);                 //     （内部再判容量>=64）
        }
    }
    addCount(1L, binCount);                         // 3. 计数 + 扩容检查
    return null;
}
```

```
put 流程图：spread -> 未初始化则 initTable -> 桶空则 CAS 插入（失败重试）
 -> MOVED 则 helpTransfer 协助扩容后重试 -> 否则 synchronized(f) 锁桶头
 -> 双重检查后：链表尾插/覆盖 或 红黑树插入 -> 链表>=8 且容量>=64 才树化
 -> addCount 计数 + 扩容检查
```

**spread 为什么高低位异或 + HASH_BITS**：

```java
static final int spread(int h) {
    return (h ^ (h >>> 16)) & HASH_BITS;  // HASH_BITS = 0x7fffffff
}
```

1. `h ^ (h >>> 16)`：高低位异或，让高位信息参与桶下标计算（table 短时只用低位），减少碰撞
2. `& HASH_BITS`：保证非负。**负数 hash 有特殊含义**：MOVED(-1) 是 ForwardingNode、TreeBin 为 -2、ReservationNode 为 -3，业务 key 的 hash 必须与它们隔离

**空桶为什么 CAS 无锁**：空桶插入只是"null 换新 Node"的单字段原子变更，CAS 足够；失败说明有人竞争，重试走非空桶分支。这是"乐观 + 回退"模式（呼应 Day03 AQS 先 tryAcquire 的哲学）。

**synchronized 锁谁**：桶头节点 `f`，锁粒度 = 1 个桶。拿到锁后**先 `tabAt(tab, i) == f` 双重检查**头节点没变（防拿锁期间桶被迁移/树化）。

**treeifyBin 的两个条件**：

```java
if (binCount >= TREEIFY_THRESHOLD)      // 8
    treeifyBin(tab, i);
// treeifyBin 内部：
if (tab == null || tab.length < MIN_TREEIFY_CAPACITY)  // 64
    resize();       // 容量 < 64：优先扩容（拆散碰撞链，成本低于树化）
else /* 树化 */;    // 容量 >= 64 且链表 >= 8 才真正树化
```

**关键认知**：链表到 8 但容量不足 64 时**先扩容不树化**--扩容把碰撞 key 按高低位拆到两个桶，通常比维护红黑树划算；树化是"扩容也救不了"时的兜底。红黑树节点 &lt;= 6 时退化回链表（扩容拆分时）。

**为什么 key / value 都不允许 null**：

```java
// 假设 CHM 允许 null value：
User u = map.get("patient-123");
if (u == null) { /* key 不存在？还是 value 就是 null？无法区分 */ }
// 单线程 HashMap 可用 containsKey 二次确认；
// 并发下 containsKey + get 两步之间可能被其他线程修改 -> 二义性无法消除 -> 索性禁止
```

**这是 HashMap（允许 null）与 CHM 的经典面试差异点**。

#### 3. get 为什么无锁

**三级 volatile 可见性链路**：

```java
transient volatile Node<K,V>[] table;      // 一级：数组引用 volatile

static class Node<K,V> {
    final int hash;                        // final：安全发布（Day01）
    final K key;
    volatile V val;                        // 二级：值 volatile
    volatile Node<K,V> next;               // 三级：链表指针 volatile
}

static final <K,V> Node<K,V> tabAt(Node<K,V>[] tab, int i) {
    return (Node<K,V>)U.getObjectAcquire(tab, ...);   // acquire 语义读数组元素
}
```

**可见性推导（呼应 Day01 happens-before）**：写线程 CAS/volatile 写入桶（casTabAt/setTabAt），与读线程的 tabAt volatile 读建立 happens-before--**读者要么看不到新节点，看到的一定是完整的新节点**（hash/key 是 final，无半构造问题）。

**get 的完整流程**：

```java
public V get(Object key) {
    // spread 后 tabAt 定位桶：
    if (e.hash == h) return e.val;                        // 1. 头节点命中
    else if (e.hash < 0)
        return (p = e.find(h, key)) != null ? p.val : null;  // 2. 特殊节点（Forwarding/TreeBin）
    while ((e = e.next) != null) { /* 3. 遍历链表 */ }
    return null;
}
```

**扩容期间 get 的行为（ForwardingNode.find 转发）**：

```
扩容进行时（table -> nextTable）：
┌────────────┐         ┌────────────────────┐
│ 旧 table   │         │  nextTable（新表）  │
│ 桶 i：已迁完│──fwd──>│ 桶 i / 桶 i+n      │
│ (Forwarding│  指向   │（该桶数据已迁完）  │
│  Node)     │         │                    │
│ 桶 j：未迁移│         │                    │
└────────────┘         └────────────────────┘
get 定位到桶 i：头是 ForwardingNode(hash==MOVED)
  -> fwd.find(h, key) 转发到 nextTable 递归查找
get 定位到桶 j：旧 table 链表/红黑树上正常查（不阻塞）
```

**弱一致性为什么工程上可接受**：get 读到的可能是"上一瞬间"的值。IM 网关场景：消息路由时用户"刚下线 1ms 前仍可查到"，业务完全可接受。**强一致要付出加锁代价，绝大多数读场景只需要"已发布数据完整可见"（volatile 保证）而非"线性一致"**。

**架构师经验**：CHM 的 get 是读写不互斥的极致--**读路径 0 锁 0 CAS，纯 volatile 读**。这是 Day03 IM 网关 UserMap 三方案对比中 CHM 100w+ 读 QPS 完胜的根本原因：RWLock 读要 CAS 读计数、StampedLock 乐观读要 validate，CHM 连这些都没有。

#### 4. size 全解

**baseCount + CounterCell 分散计数（与 LongAdder 同思想）**：

```java
// LongAdder：base + Cell[]（@Contended 填充）
// CHM 同款思想：baseCount + CounterCell[]，CounterCell 同样 @sun.misc.Contended
@sun.misc.Contended static final class CounterCell { volatile long value; }
```

**addCount 的流程**：

```
CAS baseCount += 1 ──成功──> 结束（低竞争：绝大多数走这条）
    │失败（有竞争）
    ▼
按线程 probe 哈希定位 CounterCell[i]
    ├─ CAS cell.value += 1 ──成功──> 结束
    └─ 失败 -> 换 Cell / 扩容 cells（LongAdder 的 longAccumulate 同款逻辑）
    ▼
检查是否需要扩容（元素数 >= sizeCtl 时触发 transfer）
```

**@sun.misc.Contended 为什么避免伪共享（呼应 Day01 MESI）**：

```
无填充：[baseCount 8B][Cell0.value 8B][...] 挤在同一 64 字节缓存行
  -> 核 A 改 base、核 B 改 Cell0，缓存行在核间 Invalidate 弹跳
  -> 地址分散了、缓存行没分散，热点分离白做
@Contended（默认 128 字节填充）：每个 Cell 独占缓存行
  -> 无弹跳。为什么 128 不是 64：防相邻缓存行的预取伪别名
  -> 注意：应用类需 -XX:-RestrictContended，JDK 内部类默认生效
```

**size() 为什么是近似值**：sumCount 无锁遍历（baseCount + 所有 Cell），计数（分散写）与求和（无锁读）**并发交错**，返回的是弱一致快照--本质与 LongAdder.sum() 相同。

**架构师经验**：这是"热点分离换精确性"的取舍。业务上 size 只用于监控 / 日志 / 粗判，**并发下不要基于 size() 做精确控制流**（`if (size() < 1000) put` 是错的，应改用有界队列或 compute 复合操作）。

**与 JDK7 size 对比**：

| 维度 | JDK7 | JDK8 |
|------|------|------|
| 实现 | 无锁算 2 次（count 与 modCount 校验），不一致锁全部 Segment 精算 | baseCount + CounterCell 无锁分散 |
| 精确性 | 无锁路径近似 / 加锁路径精确（代价大） | 始终近似 |
| 高并发代价 | 锁全部段 -> 写全阻塞 | 无锁，多一次 Cell CAS |

#### 5. 多线程扩容 transfer 全解

**sizeCtl 的 4 种状态**：

```java
private transient volatile int sizeCtl;
// 0    ：默认（table 未初始化）
// -1   ：正在初始化（CAS 抢到初始化权的线程设置）
// <-1  ：正在扩容（高 16 位扩容戳 stamp，低 16 位 = 参与扩容线程数 + 1）
// >0   ：扩容阈值（capacity * loadFactor）
```

**stride 步长与 transferIndex 抢区间**：

```java
// 每线程认领的区间大小
if ((stride = (NCPU > 1) ? (n >>> 3) / NCPU : n) < MIN_TRANSFER_STRIDE)
    stride = MIN_TRANSFER_STRIDE;   // 最小 16：避免区间切太碎，CAS transferIndex 开销反超收益
```

```
table 长度 n=64，stride=16，两线程协助扩容（transferIndex 从末端倒着分配）：
线程 A：CAS transferIndex 64->48，抢 [48,64)；线程 B：CAS 48->32，抢 [32,48)
┌────────┬────────┬────────┬────────┬───────────┐
│  0-15  │ 16-31  │ 32-47  │ 48-63  │transferIdx│
│ 未迁移 │ 未迁移 │ 线程 B │ 线程 A │    =32    │
└────────┴────────┴────────┴────────┴───────────┘
迁完自己的区间 -> 再抢新区间 -> transferIndex<=0 后收尾：重扫 + table=nextTable
```

**ForwardingNode 的两大作用**：

```java
static final class ForwardingNode<K,V> extends Node<K,V> {
    final Node<K,V>[] nextTable;
    ForwardingNode(Node<K,V>[] tab) { super(MOVED, null, null, null); this.nextTable = tab; }
}
```

1. **迁移完成的标记**：桶迁完后 `setTabAt(tab, i, fwd)` 换成 ForwardingNode，后续写线程看到 MOVED 就去帮忙或去新表
2. **get 请求的转发器**：get 遇到已迁移桶，`fwd.find()` 到 nextTable 递归查找--**读请求扩容期间不阻塞、不丢失**

**helpTransfer 协助扩容**：写操作遇到 MOVED 时 CAS sizeCtl（扩容线程数 +1），参与迁移后 -1。**设计哲学：写线程"顺路"帮扩容，成本分摊给所有写入者，不设专职扩容线程**。

**高低位链拆分（fn & n）**：

```
旧桶 i：A -> B -> C -> D -> E
        │ 遍历一遍，按 (e.hash & n) 分组（n=旧容量，不重新计算 hash）
        ▼
(hash & n)==0 低位链留新表 i：A -> C -> E    （lastRun 优化：尾部一次连接）
(hash & n)!=0 高位链去新表 i+n：B -> D
只用多出的 1 个 bit 分组，一次 setTabAt 写入
```

**扩容期间 get / put 行为**：

| 操作 | 桶已迁移（MOVED） | 桶未迁移 |
|------|-----------------|---------|
| get | ForwardingNode.find 转发新表查找 | 旧 table 正常查（无锁） |
| put | helpTransfer 协助后重试（最终写进新表） | 正常写入旧表（随后被迁走） |
| 迭代器 | 弱一致：不抛异常，反映某个时刻的视图 | 同左 |

**关键认知**：CHM 扩容是"**分而治之 + 协作 + 转发**"三件套：stride 切区间多线程并行、ForwardingNode 让读写不阻塞、helpTransfer 让写线程顺路出力。对比 JDK7 Segment 内单线程 rehash（其他线程整段阻塞），是数量级的体验差异。

#### 6. fail-fast vs fail-safe 全解

**HashMap 的 fail-fast（modCount 机制）**：

```java
// modCount 在 put/remove 等结构性修改时 ++
// 迭代器创建时记录 expectedModCount = modCount
final void checkForComodification() {
    if (modCount != expectedModCount)
        throw new ConcurrentModificationException();
}
```

```java
// 反例 1：单线程也会 CME（不是并发问题！）
for (String s : list) {
    if ("b".equals(s)) list.remove(s);   // modCount++，下次 next 抛 CME
}
// 反例 2：多线程一读一写，读方 CME
// 反例 3（隐蔽 bug）：删倒数第二个元素不抛 CME（hasNext 提前 false），静默漏删
```

**fail-fast 的设计目的**：**bug 检测，不是并发保证**。Javadoc 明确：CME 应仅用于检测程序错误，fast-fail 行为不能作为正确性依据。

**ConcurrentHashMap 的 fail-safe（弱一致性迭代器）**：

```java
// CHM 迭代器：逐桶推进，不记录 modCount，不检查并发修改
// - 永不抛 CME
// - 反映"迭代器推进时刻"的中间态视图：可能看到部分构造后的修改，也可能看不到
// - iterator.remove 支持（弱一致删除）
```

| 维度 | HashMap（fail-fast） | ConcurrentHashMap（fail-safe） |
|------|---------------------|------------------------------|
| 机制 | modCount 检查 | 无检查（不抛 CME） |
| 迭代中修改 | 抛 CME | 不抛，旧/新混合视图 |
| 设计目的 | bug 检测 | 并发可用（容忍过期数据） |
| 迭代中删除 | 必须 iterator.remove | iterator.remove / removeIf 均可 |

```java
// 迭代中安全删除：
Iterator<String> it = list.iterator();
while (it.hasNext()) { if (cond(it.next())) it.remove(); }  // 内部同步 expectedModCount
list.removeIf(s -> "b".equals(s));                          // JDK8 批量删除
map.forEach((k, v) -> { if (stale(k)) map.remove(k); });    // CHM 弱一致，安全
```

**架构师经验**：fail-fast 容器的 CME 是**单线程 bug 检测器**，不是并发保护；fail-safe 的弱一致是**性能换一致性**的取舍。Code Review 看到"捕获 CME 继续循环"的代码直接打回--那是在掩盖 bug。

---

## 题目二（并发容器选型全解题）：并发容器选型全解

请详细回答以下问题：

1. **ConcurrentSkipListMap 全解**：跳表的多层链表结构（平均 O(log n)）？为什么并发有序 Map 用跳表而不用"红黑树 + 锁"（插入局部性 vs 旋转全局性）？与 ConcurrentHashMap 的对比与使用场景？
2. **CopyOnWriteArrayList 全解**：COW 原理（写时复制 + volatile 引用替换）？适用场景（读多写少配置类）？三大陷阱（内存翻倍 / 迭代器快照 / COW 复合操作覆盖）？与 Collections.synchronizedList 对比？
3. **ConcurrentLinkedQueue 全解**：Michael-Scott 无锁算法？head/tail 松弛更新为什么不是每次都推进（减少 CAS 竞争）？size() 为什么 O(n) 且弱一致？无界风险？
4. **BlockingQueue 全家桶对比**：ArrayBlockingQueue（单锁两 Condition 有界）/ LinkedBlockingQueue（两锁分离吞吐高一倍以上、无界陷阱）/ SynchronousQueue（直接 handoff，newCachedThreadPool）/ DelayQueue（leader-follower，串联 05月第4周 MQ 延迟消息）/ PriorityBlockingQueue / LinkedTransferQueue？
5. **阻塞队列与 AQS Condition 的关系**：notFull/notEmpty 如何实现精确唤醒（呼应 Day03 多 Condition）？ArrayBlockingQueue 为什么单锁而 LinkedBlockingQueue 敢两锁（数据结构决定锁策略）？
6. **选型决策树全解**：按业务场景的完整决策树？无界队列 OOM 风险（监管上报缓冲队列事故）？与 Day05 线程池工作队列的关系？

### 作答区

#### 1. ConcurrentSkipListMap 全解

**跳表结构**：

```
Level 2:  head ------------------------> 50 ---------------------> null
Level 1:  head --------> 20 ------------> 50 --------> 70 -------> null
Level 0:  head -> 10 -> 20 -> 30 -> 40 -> 50 -> 60 -> 70 -> 80 -> null
          （底层完整有序链表，上层是"跳跃"索引，概率 1/2 提升一层）

查找 40：head -> L1 走到 20（<40）-> L0 走到 40 命中，平均 O(log n)
```

**为什么用跳表而不用"红黑树 + 锁"**：

| 维度 | 红黑树（TreeMap） | 跳表（ConcurrentSkipListMap） |
|------|-------------------|------------------------------|
| 复杂度 | O(log n) 严格保证 | O(log n) 期望保证 |
| 插入的结构变更 | 旋转 + 变色，连改**多节点父子关系** | 只改前驱的 next 指针（**局部性**） |
| 无锁化难度 | 旋转多节点联动，CAS 状态机极复杂 | 逐层 CAS next 即可（算法成熟） |
| 工程现实 | JDK 至今没有 ConcurrentTreeMap | Doug Lea 已实现 |
| 内存 | 节点 3 指针 + 颜色 | 底层链表 + 索引层（平均每元素 ~2 索引节点） |

**关键认知**：红黑树平衡靠"全局结构调整（旋转）"，跳表平衡靠"概率（随机层数）"。**概率性平衡换来修改局部性，局部性换来 CAS 无锁化的可能**。不是"跳表比红黑树好"，是"跳表更适合并发"。

**与 ConcurrentHashMap 对比**：

| 维度 | ConcurrentHashMap | ConcurrentSkipListMap |
|------|-------------------|----------------------|
| 有序性 | 无序 | 按 key 有序 |
| 单点查询 | O(1) | O(log n) |
| 范围查询 | 不支持 | headMap/tailMap/subMap O(log n) |
| firstKey/lastKey | 需全扫 | O(log n) |
| 适用 | 通用并发缓存/注册表 | 并发有序调度表、区间视图 |

**使用场景**：定时任务表（按触发时间取最近）、限流时间窗口、在线问诊的**预约放号时间槽表**（按时间有序取第一个可约槽位）。

#### 2. CopyOnWriteArrayList 全解

**COW 原理**：

```java
private transient volatile Object[] array;   // volatile 数组引用

public boolean add(E e) {
    synchronized (lock) {                    // 写串行化
        Object[] es = getArray();
        int len = es.length;
        es = Arrays.copyOf(es, len + 1);     // 1. 复制整个数组
        es[len] = e;                         // 2. 新数组写入
        setArray(es);                        // 3. volatile 引用替换（发布）
        return true;
    }
}
public E get(int index) {
    return elementAt(getArray(), index);     // 读：volatile 读引用，无锁
}

// 写线程 setArray(volatile写) --hb--> 读线程 getArray(volatile读) 看到新数组
// setArray 之前启动的读仍持有旧数组引用 -> 快照读
```

**适用场景（读多写少 + 小数据量）**：事件监听器列表、配置白名单/黑名单、路由表、SPI 实现列表。

**三大陷阱**：

```
陷阱 1：写复制内存翻倍 + GC 压力
  10w 元素的 COW 每次 add 复制 10w 引用（~800KB）；分钟级全量刷新
  -> Young GC 暴涨 + 峰值内存翻倍 + 大对象直进老年代（G1 Humongous）

陷阱 2：迭代器快照弱一致 + 不支持 remove
  it.remove() 抛 UnsupportedOperationException（COW 迭代器不支持）
  迭代期间的新增本次看不到（快照视图）

陷阱 3：复合操作"读-判断-写"覆盖并发修改
  if (!listeners.contains(l)) listeners.add(l);
  // contains 与 add 之间另一线程 add 了同一 l -> 判重失效 -> 重复注册
  // contains/add 各自线程安全，组合不原子（check-then-act 竞态）
  // 正例：复合操作放锁内，或用 CopyOnWriteArraySet.add（内部原子）
```

**与 Collections.synchronizedList 对比**：

| 维度 | CopyOnWriteArrayList | Collections.synchronizedList |
|------|---------------------|------------------------------|
| 读 | 无锁（volatile 快照） | synchronized 全互斥 |
| 写 | 锁 + 全量复制 | synchronized 原地修改 |
| 迭代 | 快照无锁不抛 CME，不支持 remove | 需手动 synchronized 包裹，否则 CME |
| 写成本 | O(n) 复制 | O(1)~O(n) |
| 适用 | 读极多写极少 + 小 | 读写均衡或写多 |

**架构师经验**：COW 的本质是**"用写成本换读吞吐 + 读写不互斥"**，是"读写分离"在数据结构层的实现（类比数据库读写分离）。监听器列表是教科书场景；超过千级元素或秒级写入就该换 ConcurrentLinkedQueue / CHM。

#### 3. ConcurrentLinkedQueue 全解

**Michael-Scott 无锁算法**：

```java
// 入队核心：CAS 把尾节点的 next 从 null 换成新节点
public boolean offer(E e) {
    final Node<E> newNode = new Node<E>(e);
    for (Node<E> t = tail, p = t;;) {
        Node<E> q = p.next;
        if (q == null) {                          // p 是真正的尾
            if (casNext(p, null, newNode)) {       // CAS 挂接
                if (p != t) casTail(t, newNode);   // tail 落后则顺便推进
                return true;
            }
        }
        else if (p == q)                           // 自引用（已出队哨兵）跳过
            p = (t != (t = tail)) ? t : head;
        else
            p = (p != t && t != (t = tail)) ? t : q;  // 向后推进找真尾
    }
}
```

**head / tail 的松弛更新（slack）**：严格更新（每次 offer/poll 都 CAS tail/head）会让所有生产者在 tail 单点竞争；松弛更新允许 tail/head 落后于真实位置--offer 时新节点挂上 next 即"逻辑入队"，tail 不必马上推进（下次顺带推进）。例：`head -> A -> B -> C -> null`，tail 可停在 B（落后一跳），下一个 offer 发现 `p.next != null` 就推进到 C 挂接，顺带推 tail。

**关键认知**：松弛更新的哲学是**"正确性不依赖 tail/head 实时准确，只依赖链表 next 指针的原子性"**--算法在"不信任 tail/head"的前提下仍正确（遇到落后自己往前找）。与 AQS 的"乐观 + 回退"（Day03）一脉相承。

**size() 为什么 O(n) 且弱一致**：无锁队列不维护计数字段（维护计数会引入新的 CAS 竞争点），只能遍历统计，且遍历期间其他线程还在增删。**需要精确计数 + 有界能力时用 BlockingQueue 而不是 CLQ**。CLQ 无界，生产远超消费时同样有 OOM 风险。

#### 4. BlockingQueue 全家桶对比

**全家桶对比表**：

| 队列 | 底层结构 | 锁策略 | 有界性 | 特点 | 典型用途 |
|------|---------|--------|--------|------|---------|
| ArrayBlockingQueue | 循环数组 | 单锁 + 两 Condition | 有界 | 预分配内存、支持公平 | 生产者消费者（严格背压） |
| LinkedBlockingQueue | 链表 | **两锁分离** | 默认无界（**陷阱**） | 吞吐高一倍以上 | 线程池工作队列（newFixedThreadPool） |
| SynchronousQueue | 无存储 | Transferer（栈/队列） | 容量 0 | put 必须等 take 配对 | newCachedThreadPool |
| DelayQueue | 堆 | 单锁 + leader-follower | 无界 | 到期才能取 | 延迟任务/重试退避 |
| PriorityBlockingQueue | 堆 | 单锁（**无 notFull**） | 无界 | 按优先级出队 | 优先级调度 |
| LinkedTransferQueue | 预占链表 | 无锁 + LockSupport | 无界 | transfer 即时交付 | 高性能生产者消费者（JDK7+） |

**ArrayBlockingQueue（单锁两 Condition）**：

```java
final Object[] items;                // 循环数组
final ReentrantLock lock;            // 一把锁管读写
private final Condition notEmpty;    // 消费者等待队列
private final Condition notFull;     // 生产者等待队列

public void put(E e) throws InterruptedException {
    lock.lockInterruptibly();
    try {
        while (count == items.length) notFull.await();  // 满：生产者精确等待
        enqueue(e);                     // items[putIndex] = e; 循环推进
        notEmpty.signal();              // 精确唤醒消费者
    } finally {
        lock.unlock();
    }
}
```

**LinkedBlockingQueue（两锁分离）**：

```java
private final AtomicInteger count = new AtomicInteger();  // 两锁都能改，须原子
private final ReentrantLock takeLock = new ReentrantLock();
private final Condition notEmpty = takeLock.newCondition();   // take 侧
private final ReentrantLock putLock = new ReentrantLock();
private final Condition notFull = putLock.newCondition();     // put 侧

public void put(E e) throws InterruptedException {
    // node 入队，c = count.getAndIncrement()
    if (c + 1 < capacity) notFull.signal();   // putLock 内唤醒其他生产者
    if (c == 0) signalNotEmpty();             // 跨锁：拿 takeLock 唤醒消费者
}
```

**为什么两锁吞吐高一倍以上**：单锁 put/take 互斥，任何时刻队列操作串行；两锁让**生产与消费真正并行**，高竞争下吞吐接近 2 倍。代价：count 必须 AtomicInteger + 跨锁唤醒复杂度。

**SynchronousQueue（直接 handoff）**：

```
容量 0：不存储任何元素
put(e)：无消费者在等 -> 阻塞；有消费者在等 -> 直接移交
非公平 TransferStack（LIFO）：新消费者优先匹配（局部性好）
公平 TransferQueue（FIFO）：按到达顺序匹配

newCachedThreadPool 为什么用它：
new ThreadPoolExecutor(0, Integer.MAX_VALUE, 60L, SECONDS, new SynchronousQueue<>());
任务提交 -> 无法入队（容量0）-> 有空闲线程（60s内）则 handoff，无则新建线程
-> 突发流量下线程爆炸 OOM（1w 线程 ≈ 10GB 栈内存）
与 newFixedThreadPool 的无界 LinkedBlockingQueue 是"两种 OOM"：
  cached 线程爆炸 / fixed 队列堆积（Day05 展开）
```

**DelayQueue（延迟任务，串联 05月第4周 MQ 延迟消息）**：

```java
// PriorityQueue 堆按 getDelay 排序 + leader-follower
public E take() throws InterruptedException {
    lock.lockInterruptibly();
    try {
        for (;;) {
            E first = q.peek();
            if (first == null) available.await();        // 空：无限等
            long delay = first.getDelay(NANOSECONDS);
            if (delay <= 0) return q.poll();             // 到期：出队
            if (leader != null)
                available.await();                       // follower：无限等（不群醒）
            else {
                this.leader = Thread.currentThread();
                try { available.awaitNanos(delay); }     // leader：只等最近到期时间
                finally { if (leader == Thread.currentThread()) leader = null; }
            }
        }
    } finally {
        if (leader == null && q.peek() != null) available.signal();
        lock.unlock();
    }
}
```

**leader-follower 的价值**：到期最近的元素只由一个线程（leader）定时等待，其他线程无限等待--**避免所有消费者都定时唤醒空转**（100 个线程全 awaitNanos，到期瞬间 100 个全醒、99 个白跑）。

**与 05月第4周 MQ 延迟消息的串联**：

| 方案 | 范围 | 可靠性 | 精度 | 适用 |
|------|------|--------|------|------|
| DelayQueue（单机内存） | 单 JVM | **重启丢失** | 纳秒 | 单机重试退避、会话超时 |
| Redis ZSet 轮询 | 跨节点 | 持久化+兜底 | 秒级 | 中小规模延迟任务 |
| RocketMQ 延迟等级 | 分布式 | 高（持久化+重试） | 固定 18 级 | 订单超时关闭 |
| 时间轮（Netty/Kafka） | 单机/分布式 | 看实现 | 毫秒 | 海量短延迟（心跳） |

**关键认知**：单机 DelayQueue 的致命伤是**内存态不持久**。问诊订单"15 分钟未支付自动取消"绝不能只靠 DelayQueue（重启丢任务 = 订单永不关闭），必须 Redis ZSet 兜底对账或 MQ 延迟消息（呼应 05月第4周"延迟消息 + 本地任务表"）。

**PriorityBlockingQueue**：无界堆 + 单锁 + 只有 notEmpty（无界入队永不阻塞，不需要 notFull）。注意堆积风险；同优先级不保证 FIFO。

#### 5. 阻塞队列与 AQS Condition 的关系

**put/take 的 notFull/notEmpty（呼应 Day03 多 Condition 精确唤醒）**：

```java
// 用 Object.wait/notify 的反例（Day03 讲过）：
synchronized (lock) {
    while (queue.isEmpty()) lock.wait();   // 生产者消费者混在同一个 WaitSet
}                                          // notify 无法精确唤醒 -> 误唤醒 + 惊群 + 空转

// BlockingQueue 的正例：两个 Condition 分开等待
lock.lock();
try {
    while (count == items.length) notFull.await();   // 生产者只睡 notFull 队列
    enqueue(e);
    notEmpty.signal();                              // 只唤醒消费者（精确）
} finally {
    lock.unlock();
}
```

这正是 Day03 AQS Condition 章节的**框架级落地**：ArrayBlockingQueue 就是"ReentrantLock（AQS 独占模式）+ 两个 ConditionObject（条件队列）"组合出的生产者-消费者。**BlockingQueue 是 AQS 之上最成功的中层抽象**--把"锁 + 条件 + 循环判断"封装成一行 put/take。

**为什么 ABQ 单锁而 LBQ 敢两锁（数据结构决定锁策略）**：

| 维度 | ArrayBlockingQueue | LinkedBlockingQueue |
|------|--------------------|---------------------|
| 锁 | 1 把（读写互斥） | 2 把（takeLock/putLock） |
| 计数 | int count（锁保护） | AtomicInteger（跨锁原子） |
| 唤醒 | 同锁内 signal | 跨锁 signalNotEmpty/signalNotFull |
| 吞吐 | 基准 | 高竞争 ~2 倍 |
| 成立前提 | 数组 putIndex/takeIndex/count 共享同一数组状态 | **链表头尾天然分离**（put 碰尾、take 碰头） |

**Condition.await 的"完全释放 + 重排队列"**（Day03 第 4 小问）：await 时 fullyRelease 释放锁睡在 Condition 队列；被 signal 后 transferForSignal 转回同步队列重新竞争锁，醒来重新拿锁、退出时 finally unlock。ABQ 可选公平构造，公平性影响饥饿表现。

#### 6. 选型决策树全解

**完整决策树**：

```
需要"阻塞协调"（满则等 / 空则等）？
├─ 否（自己控制流量，只要线程安全）
│   ├─ 队列 -> ConcurrentLinkedQueue（无锁高吞吐；无界 + size O(n)）
│   ├─ 有序 Map -> ConcurrentSkipListMap（范围查询 / 有序遍历）
│   └─ 读多写极少小列表 -> CopyOnWriteArrayList（配置/监听器）
└─ 是（生产者-消费者）
    ├─ 延迟到期 -> DelayQueue（单机内存，重启丢，需持久化兜底）
    ├─ 优先级 -> PriorityBlockingQueue（无界，注意堆积）
    ├─ 不排队直接交付 -> SynchronousQueue（handoff，配 cachedPool）
    ├─ transfer 语义 -> LinkedTransferQueue
    └─ 普通缓冲
        ├─ 吞吐优先 + 可控有界 -> LinkedBlockingQueue（务必显式容量！）
        └─ 严格有界/预分配/公平 -> ArrayBlockingQueue
Map 场景默认 ConcurrentHashMap（get 无锁）
```

**无界队列 OOM 风险（监管上报缓冲队列事故）**：

```java
// 反例：监管平台接口抖动（RT 50ms -> 5s），消费速度 2000/s -> 200/s
BlockingQueue<Report> buffer = new LinkedBlockingQueue<>();  // 默认 Integer.MAX_VALUE！
// 净增长 1800 条/s * 2KB/条，3 小时 ≈ 38GB -> Full GC 风暴 -> OOM
// 症状（呼应 JVM 调优周）：Old 回收无效、jmap 直方图 LinkedBlockingQueue$Node 霸榜

// 正例：
BlockingQueue<Report> buffer = new LinkedBlockingQueue<>(10_000);   // 1. 有界
if (!buffer.offer(report)) { fallbackToDisk(report); }               // 2. 满则降级（磁盘兜底/告警）
// 3. 水位监控：size/capacity > 0.8 告警 + 消费 lag 指标
```

**架构师经验**：**"无界"是并发容器里最隐蔽的炸弹**（LinkedBQ / CLQ / PriorityBQ / DelayQ 全部默认或本质无界）。架构评审对任何内存队列必问三句：**容量多大？满了怎么办？谁来监控水位？**这三问同样适用于 Day05 线程池的工作队列（线程池 OOM = 队列 OOM 或线程爆炸，队列选择就是今天的容器选型）。

---

## 题目三（ThreadLocal 与原子类全解题）：ThreadLocal 与原子类全解

请详细回答以下问题：

1. **ThreadLocalMap 结构全解**：Thread 对象里的 threadLocals 字段？Entry 为什么是"弱引用 key + 强引用 value"？0x61c88647 魔数增量为什么能让 Entry 均匀分布（黄金分割数）？开放地址法 vs HashMap 的链表法？
2. **内存泄漏完整链路全解**：完整引用链路图？外部强引用消失后 key 可回收，value 为什么仍泄漏？为什么设计成弱引用（若强引用 key，泄漏更严重）？expungeStaleEntry 的"自愈"机制与局限？
3. **线程池场景全解**：为什么线程池里必须 finally remove？在线问诊 UserContext（患者上下文）串号事故的完整链路（患者 A 的数据串给患者 B -> 医疗串档，呼应 07月第2周 EMPI 串档风险）？正例代码（拦截器统一清理）？
4. **InheritableThreadLocal 与 TransmittableThreadLocal 全解**：ITL 的原理（Thread.init 时复制，只在 new Thread 那一刻）？为什么线程池场景失效？TTL 的 capture/replay/release 三段式原理？JDK 21 ScopedValue 为什么是未来方向？
5. **原子类演进全解**：AtomicLong 的 volatile + CAS 基础？ABA 问题是什么？什么场景有害（引用复用）什么场景无害（纯计数）？AtomicStampedReference 怎么解决？
6. **AtomicLong vs LongAdder 全解**：AtomicLong 高并发下的单点竞争（缓存行核间弹跳，呼应 Day01 MESI）？LongAdder 的 base + Cell[] 分段累加？sum() 为什么弱一致？什么时候用哪个？

### 作答区

#### 1. ThreadLocalMap 结构全解

**ThreadLocal 的真身存在 Thread 里**：

```java
public class Thread {
    ThreadLocal.ThreadLocalMap threadLocals = null;            // 普通ThreadLocal
    ThreadLocal.ThreadLocalMap inheritableThreadLocals = null; // 可继承的
}

public class ThreadLocal<T> {
    public void set(T value) {
        ThreadLocalMap map = getMap(Thread.currentThread());   // 拿当前线程的 map
        if (map != null) map.set(this, value);                 // 以 ThreadLocal 对象为 key
        else createMap(t, value);
    }
    // get 同理：以 this 为 key 查当前线程的 map
}
```

```
结构图：
线程 A（栈）threadLocal --强引用--> ThreadLocal 对象 <--弱引用-- Entry.key
                                    （同一个 TL 对象，被两个线程的 map 共用作 key）
线程 A.threadLocals: Entry[key=tl1] -> value=用户A数据
线程 B.threadLocals: Entry[key=tl1] -> value=用户B数据（各自独立，互不可见）
```

**Entry 为什么是"弱引用 key + 强引用 value"**：

```java
static class Entry extends WeakReference<ThreadLocal<?>> {
    Object value;                       // 强引用！
    Entry(ThreadLocal<?> k, Object v) { super(k); value = v; }  // key 弱引用
}
```

- **key 弱引用**：外部强引用消失后 key 可被 GC（Entry.key 变 null），给"被动清理"留入口
- **value 强引用**：value 的生命周期被绑定到 Entry（也就是线程），这正是泄漏的根源

**0x61c88647 魔数**：连续 N 个 ThreadLocal 的 hash 按 0x61c88647（2^32 的黄金分割数）递增，在 2 的幂次长度数组上均匀散开（斐波那契散列），开放地址法的线性探测路径极短。

**开放地址法 vs 链表法**：

| 维度 | ThreadLocalMap（开放地址） | HashMap（链表法） |
|------|---------------------------|-------------------|
| 冲突处理 | 线性探测找空位 | 拉链 |
| 负载因子 | 2/3 | 0.75 |
| 内存 | 紧凑（无链表指针） | 每桶链表开销 |
| 适用 | ThreadLocal 数量少（一个线程几十个顶天） | 通用大数据量 |

**关键认知**：ThreadLocal 冲突极少（黄金分割 + 数量少），开放地址法省内存又快--**数据结构选型跟着数据规模特征走**的又一案例。

#### 2. 内存泄漏完整链路全解

**泄漏四部曲**：

```
第 1 步：正常状态
  线程栈 tlRef --强引用--> ThreadLocal 对象
  ThreadLocal 对象 <--弱引用-- Entry.key；Entry.value --强引用--> 大对象
  Entry 挂在线程池核心线程（长存活）的 threadLocals 里
第 2 步：tlRef = null（方法结束）-> TL 对象只剩 Entry 的弱引用
第 3 步：GC -> key 被回收（Entry.key == null，脏 Entry）
         但 value 仍被 Entry 强引用 -> 无法回收
第 4 步：线程不死（线程池核心线程存活数周）-> value 泄漏成立
         症状：老年代 GC 后不降（呼应 JVM 专题），MAT 可见 key==null 的 Entry
```

**为什么设计成弱引用（两害相权）**：

```java
// 假设 key 是强引用（反推设计）：
// tlRef = null 后，TL 对象仍被 Entry 强引用
// -> ThreadLocal 对象本身泄漏（连它管辖的所有线程的 Entry 全无法清理）
// -> 连 expungeStaleEntry 的清理入口都没有（key 永远不为 null）

// 弱引用：key 可回收 -> 脏 Entry 有"自愈"入口 -> 把重泄漏降级为轻泄漏
```

**关键认知**：弱引用不是"解决泄漏"，是**把更严重的泄漏（ThreadLocal 对象 + value 永久泄漏）降级为较轻的泄漏（仅 value，且有自愈机会）**。value 的泄漏只有一条正解：用完 remove。弱引用是安全网，不是免死金牌。

**expungeStaleEntry 的自愈与局限**：set/get/remove 时顺带扫描，发现 key==null 的 Entry 就清 value、整理槽位。**局限**：自愈只在**该线程继续调用 ThreadLocal 方法时触发**；任务结束就不再访问，脏 Entry 无人触发清理，一直挂到线程死。所以"依赖自愈"不可靠。

#### 3. 线程池场景全解（UserContext 串号事故）

**事故完整链路（反面案例）**：

```
背景：在线问诊系统用 ThreadLocal 的 UserContext 在网关解析 JWT 后
     存"患者 id / 就诊卡号 / 医生 id"，全链路（服务层/DAO/日志）透传

线程池核心线程 worker-3（长存活）：
  任务 1（患者 A 的开方请求）：
    UserContext.set(患者A) -> 业务执行（RPC 超时 8s）-> 异常抛出，【没有 finally remove】
  任务 2（患者 B 的问诊记录查询，复用 worker-3）：
    UserContext.get() -> 患者A  ←←← 串号！
    -> 患者B 查到了患者A 的就诊记录 / 处方草稿

定性：医疗信息串档。与 07月第2周 EMPI 错配同性质--
《个人信息保护法》+ 医疗数据合规下的重大事故，远超普通线上 bug
```

```java
// 反例：没有清理
@PostMapping("/prescription")
public Result createPrescription(...) {
    UserContext.setCurrent(patientFromToken());   // 设置
    prescriptionService.create(dto);              // 全链路 get() 透传
    // 异常/正常路径都没有 remove -> 污染下一个任务
}

// 正例 1：try/finally（业务层兜底）
try {
    UserContext.setCurrent(patientFromToken());
    prescriptionService.create(dto);
} finally {
    UserContext.remove();        // 必须在 finally
}

// 正例 2：拦截器统一管理（推荐：清理职责收口到框架层）
public class UserContextInterceptor implements HandlerInterceptor {
    public boolean preHandle(...) { UserContext.setCurrent(resolvePatient(request)); return true; }
    public void afterCompletion(...) { UserContext.remove(); }   // 含异常路径一定执行
}
```

**架构师经验**：ThreadLocal 的最佳实践是**"设置点与清理点对称，且清理收口到框架层"**（拦截器 / Filter / AOP），不允许业务代码裸 set。Code Review 三连问：哪里 set？哪里 remove？异步/线程池路径谁负责传递和清理？

#### 4. InheritableThreadLocal 与 TransmittableThreadLocal 全解

**ITL 原理（只在 new Thread 时复制一次）**：

```java
// Thread 构造时（init 方法）：
if (inheritThreadLocals && parent.inheritableThreadLocals != null)
    this.inheritableThreadLocals = ThreadLocal.createInheritedMap(parent.inheritableThreadLocals);
// 父线程在 new 子线程那一刻浅拷贝给子线程
```

**线程池场景为什么失效**：

```
手动 new Thread（ITL 有效）：主线程 set(traceId) -> new Thread() 时复制 -> 子线程拿到 ✓
线程池（ITL 失效）：
  worker 线程在【应用启动/首次提交时】创建 -> 复制的是【那一刻】提交者的数据
  此后患者B 的请求线程 submit 任务 -> worker 复用，不再走 init
  -> worker 里还是【第一个提交者】的旧数据 -> 读到陈旧/错误上下文（串号）
  反过来 worker 里改 ITL 也不会回传给提交者
```

**TransmittableThreadLocal（阿里 TTL）三段式**：TTL 把"传递"从"线程创建时"挪到"任务执行时"，`TtlRunnable.get(runnable)` 包装任务：

1. **capture**：提交时刻（患者B 的请求线程里）抓取当前线程全部 TTL 值（快照）
2. **replay**：执行时刻（worker 里）备份当前值 + 回放快照，任务读到患者B 的上下文
3. **restore**：finally 恢复备份（清掉污染，防串号 + 防泄漏）

使用：`TtlExecutors.getTtlExecutorService(rawExecutor)` 或每个任务 `TtlRunnable.get(() -> {...})`，生产推荐 java agent 无侵入增强。

**JDK 21 ScopedValue（JEP 446，未来方向）**：

```java
private static final ScopedValue<UserContext> CTX = ScopedValue.newInstance();
ScopedValue.where(CTX, patientFromToken()).run(() -> prescriptionService.create(dto));
// CTX 只在 run 作用域内可见，退出自动"卸载"--没有 remove、没有泄漏、没有串号
// 虚拟线程（Day05）海量实例下比 ThreadLocal 更省内存（不占线程字段）
```

**关键认知**：ThreadLocal 家族的演进主线是**"生命周期管理责任"**：原始 TL（全靠自觉 remove）-> ITL（创建时复制，池化失效）-> TTL（任务级 capture/replay/restore，工程最优）-> ScopedValue（语言级作用域，根治）。

#### 5. 原子类演进全解

**CAS + volatile 基础**：

```java
public class AtomicLong {
    private volatile long value;                    // volatile 保证可见性
    public final long incrementAndGet() {
        return U.getAndAddLong(this, VALUE, 1L);    // Unsafe CAS（x86 lock cmpxchg）
    }
}
// do { old = read; } while (!CAS(this, old, old + 1));
// 无锁但不是无等待：失败自旋重试
```

**ABA 问题**：

```
时间线：
T1: 读到 value == A
T2: 把 value 改成 B（先扣减），又改回 A（补偿回来）
T1: CAS(A -> 新值) 成功 -- 但这个 A 已经"不是当年的 A"（A->B->A，T1 不知情）
```

```java
// ABA 有害场景：无锁栈（引用复用）
// T1 拿到栈顶 A（准备 CAS(A, A.next=B)）
// T2: pop A, pop B, push A（A 复用，A.next 已不是 B）
// T1: CAS 栈顶 A->B 成功，但 B 早已不在栈里 -- 栈结构损坏

// ABA 无害场景：纯计数器（值 A->B->A 后 CAS +1 结果仍正确，只关心数值不关心历史）

// 解决：AtomicStampedReference（版本戳）
AtomicStampedReference<Integer> ref = new AtomicStampedReference<>(100, 0);
int[] stamp = new int[1];
Integer v = ref.get(stamp);                          // 同时拿值和版本号
ref.compareAndSet(v, 200, stamp[0], stamp[0] + 1);   // 值+版本双匹配
// AtomicMarkableReference：boolean 标记版（只care"变没变过"）
```

**架构师经验**：ABA 高分答案分两段：先说**纯计数无碍**（数值语义），再举**引用/链表节点复用有害**（结构语义）。直接背"用 StampedReference 解决"而不分场景，是初级答案。

#### 6. AtomicLong vs LongAdder 全解

**AtomicLong 的单点竞争**：

```
64 核机器 64 线程同时 incrementAndGet：
┌────────────────────────────────────────────┐
│ ┌──┐ ┌──┐ ┌──┐ ┌──┐       ┌──┐            │
│ │T1│ │T2│ │T3│ │T4│ . . . │T64│           │
│ └─┬┘ └─┬┘ └─┬┘ └─┬┘       └─┬┘            │
│   └────┴────┴────┴───────────┴──> value    │
│             单点 CAS 竞争                   │
└────────────────────────────────────────────┘
代价 1：缓存行独占权核间弹跳（MESI Invalidate 广播，呼应 Day01）
代价 2：同一时刻只有 1 个线程成功，其余自旋重试
实测：核越多吞吐越差（乒乓），64 线程可能比单线程还低
```

**LongAdder 的 base + Cell[] 分段累加**：

```java
public class LongAdder extends Striped64 {
    transient volatile long base;      // 低竞争时直接用
    transient volatile Cell[] cells;   // 高竞争时分散

    @sun.misc.Contended               // 128 字节填充防伪共享（与 CHM CounterCell 同款）
    static final class Cell { volatile long value; }

    public void add(long x) {
        // 先 casBase；失败 -> 按线程 probe 找 Cell CAS；
        // Cell 也竞争失败 -> 换 Cell / 扩容 cells（上限接近 CPU 核数）
    }
    public long sum() {
        // base + 所有 Cell 无锁快照 -> 弱一致！
    }
}
```

**两者对比表**：

| 维度 | AtomicLong | LongAdder |
|------|-----------|-----------|
| 原理 | 单值 volatile + CAS | base + Cell[] 分段 |
| 高竞争吞吐 | 差（单点竞争 + 核间弹跳） | 高数倍到数十倍 |
| 低竞争吞吐 | 略优 | 略差（多一次 casBase） |
| 精确性 | incrementAndGet 返回精确值 | sum() 弱一致快照 |
| CAS 语义 | 支持 compareAndSet | **不支持**（无单点值可 CAS） |
| 依赖值做控制流 | 可以 | 不可以 |
| 典型场景 | 低竞争精确计数 / 状态机 | 高竞争统计（QPS/监控） |

**什么时候用哪个**：

- **用 AtomicLong**：状态机 CAS（CONNECTING -> CONNECTED）；精确时点值判断（`if (counter.incrementAndGet() == 1)` 首个进入者做初始化）；竞争低
- **用 LongAdder**：纯统计（QPS、总请求、错误数、缓存命中，秒杀大促监控打点）；高竞争（几十上百线程同时累加）；不需要基于当前值做控制流
- **秒杀场景**：库存扣减（Redis+DB 精确）与"今日成交统计"（LongAdder）分离

**关键认知**：LongAdder 与 CHM 的 CounterCell 是**同一个思想（Striped64）的两处应用**。面试能把"CHM size 近似"和"LongAdder sum 弱一致"串成一个故事（牺牲精确性换高并发吞吐），是加分项。

---

## 本日能力差距与补足方向

### 差距 1：CHM JDK7 -> JDK8 演进的工程权衡认识不深
> Day4发现，延续 Day02 差距6（synchronized vs ReentrantLock 选型）

- **现状**：知道 JDK8 用"CAS + synchronized 锁桶头"，但讲不清为什么敢用 synchronized（与 Day02 锁升级的因果关系）、Segment 固定并发度的具体缺陷、null key/value 二义性的完整推理
- **架构师水平**：能画出 JDK7/JDK8 双结构图并讲清 5 大演进原因；能从 Day02 锁升级链推导"桶头 synchronized 多数停在轻量级锁"；能把演进哲学（锁粒度细化 / 借力 JVM / 热点分离）迁移到自己业务的锁设计
- **补足方向**：精读 OpenJDK `ConcurrentHashMap.java` 头部 Doug Lea 的设计注释；对比 JDK7 Segment 源码；写一份"CHM 演进哲学 -> 业务锁优化"的迁移笔记

### 差距 2：多线程扩容 transfer 与 ForwardingNode 机制不熟
> Day4发现，延续 Day03 差距3（共享模式传播机制）

- **现状**：知道"并发扩容"概念，但 sizeCtl 4 种状态、stride 按 NCPU 划分、transferIndex 抢区间、高低位链拆分（fn & n）、扩容期间 get/put 行为这些细节不熟，面试追问两层就断
- **架构师水平**：能白板画出两线程协助扩容的区间图；能讲清 ForwardingNode 的双重作用（标记 + 转发）；能对比 JDK7 单线程 rehash 的阻塞问题
- **补足方向**：精读 `transfer()` / `helpTransfer()` / `addCount()` 源码；写 Demo 多线程 put 触发扩容并 jstack 观察协助线程；整理"CHM 扩容 12 步"笔记

### 差距 3：BlockingQueue 家族选型与无界风险决策不精
> Day4发现，延续 Day03 差距4（Condition await/signal）

- **现状**：知道 ABQ / LBQ 区别，但 LBQ 两锁 + AtomicInteger count + 跨锁唤醒的实现、SynchronousQueue 的 handoff 与 newCachedThreadPool 的关系、DelayQueue leader-follower、无界队列 OOM 三连问没有形成条件反射
- **架构师水平**：能背出 6 个阻塞队列的"结构 / 锁 / 有界性 / 一句话选型"；能讲清 LBQ 两锁为什么成立（链表头尾天然分离）；架构评审对内存队列必问三连；能把监管上报 OOM 事故讲成完整 STAR
- **补足方向**：精读 LinkedBlockingQueue 源码（重点 signalNotEmpty 跨锁）；复盘监管上报队列事故并补写容量规划文档；为 Day05 线程池工作队列选型做铺垫笔记

### 差距 4：ThreadLocal 泄漏链路与线程池串号事故认知不足
> Day4发现，延续 7月第2周差距（EMPI 串档风险防范）

- **现状**：知道"ThreadLocal 要 remove"，但弱引用 key 的设计初衷（两害相权）、value 泄漏的完整引用链、expungeStaleEntry 自愈的局限、ITL 在线程池失效的原因、TTL 的 capture/replay/restore 讲不深；对"串号 = 医疗串档级事故"的定性不敏感
- **架构师水平**：能白板画泄漏四部曲引用图；能讲清 ITL 失效与 TTL 三段式；能设计"拦截器统一 set/remove + TTL 包装线程池"的完整方案；能把 UserContext 串号事故与 EMPI 串档并案讲成医疗数据安全故事
- **补足方向**：精读 ThreadLocalMap 源码（expungeStaleEntry / replaceStaleEntry）；在自己项目用 jmap + MAT 实证一次 ThreadLocal 泄漏；引 TTL 改造 UserContext 透传并压测

### 差距 5：LongAdder 分段与伪共享的底层认知不足
> Day4发现，延续 Day01 差距6（MESI 协议与 JMM 协同）

- **现状**：知道 LongAdder 比 AtomicLong 快，但"为什么快"（缓存行弹跳 / 热点分离）、@sun.misc.Contended 的 128 字节填充、sum 弱一致、无 CAS 语义这些取舍讲不透；对"CHM CounterCell 与 LongAdder 同思想（Striped64）"的关联不清楚
- **架构师水平**：能从 MESI 协议讲清伪共享的硬件原理（呼应 Day01）；能 JMH 实测 64 线程下 AtomicLong vs LongAdder 的吞吐拐点；能给出"精确控制流用 Atomic / 统计用 LongAdder"的选型判断
- **补足方向**：精读 Striped64 源码；JMH 压测 AtomicLong vs LongAdder（1/4/16/64 线程）；调研 -XX:-RestrictContended 与 JDK 内部注解白名单

### 差距 6：CopyOnWriteArrayList 与无锁容器的陷阱边界不熟
> Day4发现，延续 Day02 差距5（锁消除/锁粗化的 JIT 优化边界）

- **现状**：会把 COW 当"并发 List 万金油"，对写复制内存翻倍 + GC 压力、迭代器不支持 remove、复合操作"读-判断-写"覆盖并发修改三大陷阱没有切肤认识；CLQ 的 head/tail 松弛更新原理不熟
- **架构师水平**：能给出 COW 的量化适用边界（元素 &lt; 千级、写频率 &lt; 秒级）；能识别"contains + add"复合竞态；能讲清 CLQ 松弛更新与 AQS"乐观 + 回退"的设计同源性
- **补足方向**：JMH 实测 COW 在 1w 元素下写 1000 次/s 的 GC 表现；调研 Spring 事件监听器为什么用 COW 语义；整理"并发容器陷阱 Checklist"

### 差距 7：与简历项目并发容器实战结合的深度不足
> Day4发现，延续第4周简历项目差距

- **现状**：能讲容器原理，但与在线问诊系统的 4 个场景（IM UserMap 选 CHM 的决策链、监管上报队列 OOM 事故、秒杀 QPS 统计用 LongAdder、UserContext 串号）的完整 STAR 故事不熟，尤其"为什么不用 synchronizedMap / RWLock 而用 CHM"的对比论证不流畅
- **架构师水平**：能用 STAR 法则结构化讲述 4 个并发容器案例；能从案例反推架构改进（有界化 + 水位监控 + TTL + 统计与扣减分离）；能在面试中 10 分钟讲清 2 个案例并自然串联 Day01-03 的 JMM / 锁 / AQS 知识
- **补足方向**：本周 Day06 串联日产出"并发容器 4 案例"文档；用 JMH 复测 UserMap 三方案性能数据补全对比表；用 STAR 法则演练 5 次面试讲述

---

## 附录：本日关键认知速查

```text
ConcurrentHashMap：
  - JDK7：Segment extends ReentrantLock（16段），锁一段多桶
  - JDK8：CAS（空桶）+ synchronized（锁桶头），演进5因素（粒度/sync优化/内存/红黑树/协助扩容）
  - put：spread保非负 -> 空桶CAS / MOVED协助 / 锁桶头尾插或树插
  - 树化双条件：链表>=8 且 table>=64（否则先扩容）
  - get 无锁：volatile table + volatile val/next + tabAt(acquire)
    扩容期间 ForwardingNode.find 转发 nextTable；语义=已发布数据完整可见
  - size：baseCount+CounterCell（与 LongAdder 同源 Striped64），近似值勿做控制流
  - 扩容：sizeCtl 四态 / stride=max((n>>>3)/NCPU,16) / transferIndex 抢区间
    高低位链 fn&n 拆分不 rehash / 迁移期间 get 转发 put 协助
  - 迭代器弱一致不抛 CME；null 二义性 -> key/value 都禁止 null

其他并发容器：
  - SkipListMap：概率平衡->局部性->CAS可无锁化（红黑树旋转做不到），有序/范围查询
  - COW：写复制+volatile替换，读无锁；三陷阱（内存翻倍/迭代器快照/复合操作覆盖）
  - CLQ：Michael-Scott 无锁，head/tail 松弛更新；size O(n) 弱一致；无界
  - ArrayBQ：单锁两Condition，有界循环数组
  - LinkedBQ：两锁分离吞吐~2倍，默认无界陷阱
  - SynchronousQ：容量0直接handoff（newCachedThreadPool）
  - DelayQ：堆+leader-follower防群醒，内存态重启丢
  - PriorityBQ：无界堆无notFull；LinkedTransferQ：transfer即时交付
  - 无界队列三连问：容量多大？满了怎么办？谁监控水位？

ThreadLocal：
  - map 在 Thread 上；key弱引用+value强引用；0x61c88647 黄金分割散列
  - 弱引用=两害相权（防TL对象本身泄漏），不是免死金牌
  - 泄漏链：外部引用消失->key被GC->value仍被Entry强引->线程不死->泄漏
  - 线程池必 finally remove；串号=医疗串档级事故（并案EMPI）
  - ITL线程池失效（init只复制一次）；TTL capture/replay/restore

原子类：
  - ABA：纯计数无害，引用/节点复用有害 -> AtomicStampedReference
  - AtomicLong：单点CAS竞争，核间缓存行弹跳（MESI）
  - LongAdder：base+Cell 分段，@Contended 防伪共享，sum 弱一致
  - 选型：精确控制流->AtomicLong；高竞争统计->LongAdder
```
