# 架构师学习-Day01-JVM 调优参数全解-梳理

> 日期：2026年08月03日（周一）
> 周主题：JVM 专题第 2 周 - 调优实战与生产排查
> 梳理日：Day01 - 架构师视角梳理

---

## 一、架构师视角下的 JVM 参数

### 1.1 不只是"调参"，是"工程决策"

很多工程师把 JVM 参数当成"网上抄一份生产配置就行"，结果就是"参数能跑但调不出问题"。架构师视角下，每一个 JVM 参数都是**工程决策**：

| 架构决策 | 受 JVM 参数约束的具体点 |
|---------|------------------------|
| 服务部署密度（一台 32C64G 部署 1 个还是 4 个 JVM） | `-Xmx` 设多大；指针压缩 32GB 边界；AlwaysPreTouch 启动延迟 |
| 选 G1 还是 ZGC | 堆大小决定：G1 在 4-32GB 最佳，ZGC 在 16GB-16TB 都行 |
| K8s limit 设多少 | JVM 堆 + 直接内存 + 元空间 + Code Cache + 线程栈 + OS 留存 |
| 启动时间敏感吗 | `-Xms`=`-Xmx` + `AlwaysPreTouch` 启动慢 5-30s 但运行稳；不设启动快但运行抖 |
| 服务是延迟敏感还是吞吐优先 | 延迟敏感用 G1 + `MaxGCPauseMillis=50`；吞吐优先用 Parallel |
| JDK 升级到 17 吗 | CMS 参数失效、ZGC 转正、BiasedLocking 移除，必须重设参数 |

如果不懂参数背后的决策逻辑，调优就是"碰运气"--碰巧某个参数生效就沾沾自喜，下次出问题又不会调了。

### 1.2 参数的本质：用声明式约束换取确定性

JVM 参数本质是**声明式约束**：

```bash
-XX:+UseG1GC                    # 声明：用 G1 GC
-XX:MaxGCPauseMillis=50         # 声明：目标停顿 50ms
-XX:MaxGCPauseMillis=50         # JVM 自动调整 Region 数、Mixed GC 频率来"尽力达到"
```

这与 K8s 的声明式 API 是同一种哲学：

| JVM 参数 | K8s 声明式 |
|---------|-----------|
| `-XX:MaxGCPauseMillis=50` | `replicas: 3` |
| JVM 根据目标自动调整 GC 行为 | K8s controller 自动调谐 Pod 数 |
| JVM 无法保证一定达到目标 | K8s 无法保证 Pod 一定能调度 |
| 参数是"期望状态" | YAML 是"期望状态" |

**架构师思维**：声明式参数给的是"目标"，不是"指令"。理解这点后，调参就不再是"试错"，而是"调整目标 + 观察自适应"。

### 1.3 参数耦合：调一个引发三个副作用

JVM 参数不是独立的，而是**深度耦合**。最典型的耦合关系：

```
MaxGCPauseMillis=50 ──┬──→ JVM 减小新生代（Eden 小，单次 GC 快）
                      │
                      ├──→ 但新生代小导致 Minor GC 频繁
                      │
                      ├──→ 频繁 Minor GC 让对象来不及晋升，Survivor 溢出
                      │
                      └──→ 溢出对象直接进 Old，Old 增长快触发 Mixed GC
                          
                      结果：单次 GC 短了，但总 GC 时间反而多了
```

这就是为什么"调一个参数可能引发 3 个新问题"。架构师调参的核心是**画耦合矩阵**：

| 参数 | 影响的指标 | 副作用 |
|------|-----------|--------|
| MaxGCPauseMillis ↓ | 单次 GC 停顿 ↓ | 新生代 ↓、GC 频率 ↑ |
| IHOP ↓ | Mixed GC 提前 | Mixed GC 频率 ↑、单次 Old 回收量 ↓ |
| G1ReservePercent ↑ | 疏散失败概率 ↓ | 可用堆 ↓ |
| ParallelGCThreads ↑ | GC 并行度 ↑ | 业务线程 CPU ↓ |
| SurvivorRatio ↑ | Survivor 大 | 晋升慢、Survivor 内存浪费 |

**架构师经验**：调参不是"单点优化"，是"系统优化"。每次调一个参数，必须同步观察 3 个关联指标。

### 1.4 参数与版本的强绑定：JDK 升级必踩的坑

JVM 参数与 JDK 版本深度绑定，**JDK 8 -> 11 -> 17 的参数变化是升级项目最大的坑**：

| 参数类别 | JDK 8 -> 11 | JDK 11 -> 17 |
|---------|------------|--------------|
| GC 参数 | `-XX:+UseConcMarkSweepGC` Deprecated | 完全失效 |
| GC 日志 | `-XX:+PrintGCDetails` Deprecated | 改用 `-Xlog:gc*` |
| 锁参数 | - | `-XX:+UseBiasedLocking` Deprecated（JEP 374） |
| 内存参数 | `-XX:PermSize` 已失效（JDK 8 移除） | - |
| GC 选型 | `-XX:+UseZGC` Experimental | Production（JDK 15） |

**架构师做 JDK 升级的标准流程**：

1. **参数扫描**：用 `jcmd <pid> VM.flags` 列出当前所有参数
2. **兼容性检查**：对照版本差异表，标记 Deprecated / Removed 参数
3. **替代方案**：为每个失效参数找替代（如 `-XX:+PrintGCDetails` -> `-Xlog:gc*`）
4. **回归测试**：升级后在测试环境跑全量压测，验证参数生效
5. **金丝雀**：生产环境先升级 1 台，观察 1 周

**关键认知**：JDK 升级不是"换 JDK 版本"，是"重新配置 JVM"。架构师必须把参数差异表刻在脑子里。

---

## 二、堆大小决策的本质：堆不是越大越好

### 2.1 堆大小的"收益递减曲线"

很多人误以为"堆越大，性能越好"。实际上堆大小与性能是**收益递减 + 边际负效应**：

```
性能
  ↑
  │         ┌────── 峰值
  │       ╱
  │     ╱
  │   ╱
  │ ╱
  │╱___________________
  └────────────────────→ 堆大小
       4G  8G  16G  24G  32G  48G

  - 4G-16G：性能快速提升（GC 频率下降）
  - 16G-24G：性能提升缓慢
  - 24G-32G：收益递减（GC 单次时间开始拉长）
  - 32G+：性能反而下降（指针压缩失效 + GC 标记时间长）
```

**关键拐点**：

1. **16GB**：G1 的甜蜜区，停顿与吞吐平衡
2. **24GB**：多数服务的最佳堆大小
3. **32GB**：指针压缩边界，超过后对象头变大、缓存命中率下降
4. **48GB+**：单实例堆不划算，应该"多实例分片"

**架构师经验**：32GB 堆的服务，性能往往比 24GB 堆差 5%-10%。这就是为什么大流量服务选择"24GB 堆 × 4 实例"而不是"32GB 堆 × 3 实例"。

### 2.2 内存预算的"四分法"

生产 JVM 的内存预算不是只有堆，而是**四块**：

```
┌────────────────────────────────────────────┐
│  K8s Pod limit（如 8GB）                  │
│                                            │
│  ┌──────────────────────┐                  │
│  │  JVM 堆 -Xmx（4GB） │  50%              │
│  │  ┌────────────────┐ │                  │
│  │  │  Eden/Survivor│ │                  │
│  │  │  Old           │ │                  │
│  │  │  Metaspace     │ │                  │
│  │  └────────────────┘ │                  │
│  └──────────────────────┘                  │
│  ┌──────────────────────┐                  │
│  │  直接内存（1GB）     │  12%             │
│  │  Netty ByteBuf       │                  │
│  │  NIO Buffer          │                  │
│  └──────────────────────┘                  │
│  ┌──────────────────────┐                  │
│  │  JVM 内部（0.5GB）   │  6%              │
│  │  Code Cache          │                  │
│  │  Thread Stack × 1000 │                  │
│  │  GC 内部数据结构     │                  │
│  └──────────────────────┘                  │
│  ┌──────────────────────┐                  │
│  │  OS + 其他（2.5GB）  │  32%             │
│  │  - OS page cache     │                  │
│  │  - JVM 进程本身      │                  │
│  │  - Sidecar（如 Istio）│                  │
│  │  - Heap Dump 预留    │                  │
│  └──────────────────────┘                  │
└────────────────────────────────────────────┘
```

**架构师经验**：

1. **堆占 50%**：留足堆外空间，避免 OOMKilled
2. **直接内存显式设上限**：Netty 默认用 `-Xmx` 等大，必须显式 `-XX:MaxDirectMemorySize` 限制
3. **Code Cache 别省**：默认 240M 在大服务不够，建议 256-512M
4. **OS 留 30%**：sidecar（Istio）、Heap Dump、page cache 都要内存

### 2.3 -Xms = -Xmx 的工程考量

生产环境 `-Xms = -Xmx` 是行业共识，但很多人不知道为什么：

| 维度 | `-Xms < -Xmx`（动态扩展） | `-Xms = -Xmx`（固定） |
|------|------------------------|---------------------|
| 启动时间 | 快（不预触碰） | 慢 5-30s（AlwaysPreTouch） |
| 运行抖动 | 堆扩展时延迟抖动 | 稳定 |
| 内存利用率 | 启动初期省内存 | 启动即占满 |
| GC 行为 | 堆扩展可能触发 GC | GC 行为可预测 |
| 监控告警 | max 变化，告警阈值失效 | 阈值稳定 |

**例外场景**：

- **测试环境**：`-Xms` 设小，快速启动
- **低优先级服务**：`-Xms` 设小，让出内存
- **Serverless**：`-Xms` 设小，按需扩展

**架构师思维**：参数选择不是"哪个绝对好"，是"在什么场景下哪个更合适"。

### 2.4 指针压缩的 32GB 边界：性能拐点

指针压缩（`-XX:+UseCompressedOops`）是 64 位 JVM 的关键优化：

```
开启指针压缩（堆 < 32GB）：
  对象引用 = 4 字节
  对象头 = 12 字节（Mark Word 8 + Klass 4）
  
关闭指针压缩（堆 ≥ 32GB）：
  对象引用 = 8 字节
  对象头 = 16 字节（Mark Word 8 + Klass 8）
```

**32GB 边界的本质**：

- 64 位指针用 32 位 + 偏移可以寻址 2^32 × 8 = 32GB（对象 8 字节对齐）
- 超过 32GB，32 位指针不够用

**关闭指针压缩的实际影响**：

1. **堆内存多消耗 5%-10%**：对象引用 + 对象头变大
2. **CPU 缓存命中率下降**：指针变大，cache line 容纳的对象引用变少
3. **GC 标记慢**：扫描对象图时遍历的指针变大

**实测数据**（在线问诊 IM 网关）：

| 堆大小 | 指针压缩 | GC 频率 | 平均 GC 停顿 | 吞吐 |
|--------|---------|---------|-------------|------|
| 24GB | ✅ | 4.2 次/分钟 | 38ms | 12.5w QPS |
| 32GB | ✅ | 3.1 次/分钟 | 52ms | 13.1w QPS |
| 36GB | ❌ | 3.3 次/分钟 | 78ms | 12.2w QPS |

**结论**：36GB 堆的性能反而比 32GB 差。架构师规划大堆时，要么卡在 32GB 内，要么直接上 64GB + ZGC。

---

## 三、GC 选型决策树：从"经验"到"方法论"

### 3.1 GC 选型的 4 维评估矩阵

GC 选型不是"G1 默认就行"，而是**4 维评估**：

| 维度 | 评估问题 | 影响 GC 选型 |
|------|---------|-------------|
| 堆大小 | 堆多大？ | &lt; 4GB 用 Parallel；4-32GB 用 G1；> 32GB 用 ZGC |
| 延迟敏感 | P99 延迟要求？ | &lt; 50ms 用 ZGC；50-200ms 用 G1；> 200ms 用 Parallel |
| 吞吐优先 | 是批处理还是 API？ | 批处理用 Parallel；API 用 G1/ZGC |
| JDK 版本 | JDK 多少？ | JDK 8 用 CMS（已弃用）/G1；JDK 11+ 用 G1；JDK 15+ 可选 ZGC |

### 3.2 在线问诊系统的 GC 选型实战

| 服务 | 堆 | 延迟要求 | GC | 理由 |
|------|----|---------|----|------|
| IM 网关 | 24G | P99 &lt; 50ms | G1（MaxGCPauseMillis=50） | 长连接敏感，停顿长批量心跳超时 |
| 视频问诊 SFU | 16G | P99 &lt; 100ms | G1（MaxGCPauseMillis=100） | 实时音视频相对宽容 |
| 监管上报 | 8G | P99 &lt; 500ms | G1（默认） | 24h 必达，吞吐优先 |
| 大文档存档 | 32G | P99 &lt; 200ms | ZGC（JDK 17+） | 大堆 + 低延迟 |
| 历史归档 | 8G | 无要求 | Parallel | 批处理吞吐优先 |
| Spring Boot Admin | 1G | 无要求 | Serial | 小服务，省 CPU |

**关键认知**：GC 选型不是"一刀切"，架构师需要按服务特征分别选型。

### 3.3 MaxGCPauseMillis 的"目标"陷阱

很多人设了 `-XX:MaxGCPauseMillis=50` 后发现 GC 停顿还是 200ms，以为是 JVM bug。实际上：

**MaxGCPauseMillis 是"目标"，不是"上限"**：

- G1 根据历史 GC 数据预测下次 GC 停顿
- 如果预测超过目标，G1 会减小 Region 数（减少单次 GC 工作量）
- 但 G1 不能"无中生有"--如果 Eden 太大、晋升太多，单次 GC 必然长

**正确调法（3 参数联动）**：

```bash
-XX:MaxGCPauseMillis=50
-XX:G1NewSizePercent=10          # 新生代最小 10%
-XX:G1MaxNewSizePercent=40       # 新生代最大 40%（默认 60% 太大）
-XX:InitiatingHeapOccupancyPercent=35  # 提前触发并发标记
-XX:G1ReservePercent=15          # 多预留防疏散失败
```

**架构师思维**：单个参数不会带来本质提升，参数组合才能解决问题。

### 3.4 IHOP 自适应：JDK 9+ 的隐藏优化

`InitiatingHeapOccupancyPercent`（IHOP）控制何时开始并发标记。JDK 9+ 支持**自适应 IHOP**：

- 默认开启（`-XX:+G1UseAdaptiveIHOP`）
- JVM 根据历史 GC 数据自动调整 IHOP
- 如果 Old 增长快，IHOP 自动调低（更早开始标记）
- 如果 Old 增长慢，IHOP 自动调高（晚开始，省 CPU）

**陷阱**：

- 自适应 IHOP 需要预热（前几次 GC 用默认 45%）
- 频繁 Full GC 时自适应失效（无法学习）
- 极端负载场景自适应可能误判，需要手动关

**架构师经验**：90% 场景用默认自适应即可，10% 极端场景手动设 `-XX:-G1UseAdaptiveIHOP -XX:InitiatingHeapOccupancyPercent=35`。

---

## 四、容器化重塑 JVM 参数

### 4.1 JDK 8u191 之前的"容器地狱"

JDK 8u191 之前，JVM 在容器中有两个经典问题：

**问题 1：堆大小看宿主机**

```bash
# 容器 limit 4GB，宿主机 64GB
# JDK 8u191 之前的 JVM
$ java -version
openjdk version "1.8.0_181"
$ java -XshowSettings:vm -version
Max. Heap Size (Estimated): 16.00G   # 看到的是宿主机 64GB / 4
```

JVM 看到的是宿主机 64GB，按 / 4 算堆上限 16GB，远超容器 4GB limit，启动即 OOMKilled。

**问题 2：GC 线程数看宿主机**

```bash
# 容器 limit 2 CPU，宿主机 32 CPU
# JDK 8u191 之前的 JVM
$ java -XX:+PrintFlagsFinal -version | grep ParallelGCThreads
  uintx ParallelGCThreads = 8         # 看到的是宿主机 32 CPU / 4
```

GC 时 8 个线程争抢 2 CPU 的时间片，业务线程被饿死。

### 4.2 UseContainerSupport 的本质

JDK 8u191+ 的 `+UseContainerSupport` 做了三件事：

1. **读 cgroup v1 内存限制**：从 `/sys/fs/cgroup/memory/memory.limit_in_bytes` 读容器 limit
2. **读 cgroup v1 CPU 限制**：从 `/sys/fs/cgroup/cpu/cpu.cfs_quota_us` 和 `cpu.cfs_period_us` 算容器 CPU 数
3. **默认开启**：JDK 8u191+ 不需要手动加

**坑点**：

- cgroup v2 路径不同（`/sys/fs/cgroup/cpu.max`），JDK 11 早期版本不识别
- `cpuset`（绑定 CPU）在某些 K8s 配置下 JVM 看不到
- JDK 15+ 才完整支持 cgroup v2

### 4.3 K8s limits vs JVM 参数的协同

K8s `resources.limits=4C8G` 与 JVM 参数的协同：

```bash
# K8s limit 4C8G
resources:
  limits:
    cpu: "4"
    memory: "8Gi"
  requests:
    cpu: "2"
    memory: "4Gi"

# JVM 参数（推荐）
-Xmx4g                        # limit 内存 8G 的一半（留堆外）
-Xms4g
-XX:MaxDirectMemorySize=1g
-XX:MaxMetaspaceSize=256m
-XX:ReservedCodeCacheSize=256m
-Xss512k
-XX:ParallelGCThreads=2       # 手动设，按 requests CPU 算
-XX:ConcGCThreads=1
-XX:CICompilerCount=2         # 手动设
```

**关键认知**：

1. **堆按 limit 内存算**：50% 是堆，剩 50% 给堆外
2. **GC/编译线程按 requests CPU 算**：避免 throttling 时线程争抢
3. **手动设 GC/编译线程数**：不要让 JVM 自动算（limits CPU vs requests CPU 不一致会出错）

### 4.4 CPU Throttling：K8s 限流对 JVM 的隐性伤害

K8s CPU limit 是 CFS quota 限流：默认 100ms 周期，limit=2 CPU 表示 200ms quota/100ms 周期。

业务线程用满 quota 后被内核 throttle，等到下个周期才能继续。对 JVM 的影响：

| JVM 行为 | Throttling 影响 |
|---------|----------------|
| GC 线程 | GC 本来 50ms，被 throttle 拉长到 200ms+，业务感知"GC 停顿变长" |
| JIT 编译线程 | 编译慢，预热期变长，峰值性能延后达到 |
| Safepoint 等待 | JVM 进入 Safepoint 需要所有线程到达，被 throttle 的线程迟迟不到，Safepoint 等待暴涨 |

**诊断 CPU Throttling**：

```bash
# 在 Pod 内
cat /sys/fs/cgroup/cpu/cpu.stat
nr_periods 12345
nr_throttled 6789          # 被限流的周期数
throttled_time 567890123   # 累计被限流的时间（ns）

# 计算 throttled 比例
# 6789 / 12345 = 55%   <- 超过 5% 就要警惕
```

**避免方法**：

1. `limits.cpu` 设为 `requests.cpu` 的 2-3 倍
2. CPU 密集型服务用 `cpuset`（绑定 CPU，不用 CFS quota）
3. JVM 参数手动调小 GC/编译线程数

### 4.5 在线问诊 IM 网关的容器化参数

```yaml
# K8s Deployment
spec:
  containers:
  - name: im-gateway
    resources:
      requests:
        cpu: "4"
        memory: "8Gi"
      limits:
        cpu: "8"           # 2 倍 requests，避免 throttling
        memory: "12Gi"     # 留足堆外
```

```bash
# JVM 参数
-Xmx6g                       # limit 内存 12G 的一半
-Xms6g
-XX:MaxDirectMemorySize=2g   # Netty 长连接
-XX:MaxMetaspaceSize=256m
-XX:ReservedCodeCacheSize=256m
-Xss512k
-XX:+UseG1GC
-XX:MaxGCPauseMillis=50
-XX:G1HeapRegionSize=4m
-XX:InitiatingHeapOccupancyPercent=35
-XX:G1ReservePercent=15
-XX:ParallelGCThreads=2      # 按 requests CPU 算（4 / 2）
-XX:ConcGCThreads=1
-XX:CICompilerCount=2
-XX:+UseContainerSupport
-XX:+AlwaysPreTouch
```

---

## 五、-XX 陷阱与生产模板标准化

### 5.1 -XX 参数的版本陷阱

最容易踩的版本陷阱：

| 参数 | JDK 8 | JDK 11 | JDK 17 | 升级建议 |
|------|-------|--------|--------|---------|
| `+UseConcMarkSweepGC` | ✅ | Deprecated | ❌ 失效 | 改用 `+UseG1GC` |
| `+UseParNewGC` | ✅ | Deprecated | ❌ 失效 | 改用 `+UseG1GC` |
| `+PrintGCDetails` | ✅ | Deprecated | ❌ 失效 | 改用 `-Xlog:gc*` |
| `-Xloggc:` | ✅ | Deprecated | ❌ 失效 | 改用 `-Xlog:gc*:file=` |
| `+UseBiasedLocking` | ✅ | ✅ | Deprecated | 移除（JEP 374） |
| `+UseZGC` | ❌ | Experimental | Production（JDK 15+） | 升级到 JDK 15+ |
| `PermSize`/`MaxPermSize` | ❌ | - | - | JDK 8 已移除，改用 `MetaspaceSize` |

**架构师经验**：JDK 升级前用 `jcmd <pid> VM.flags` 列出所有参数，对照版本差异表标记风险。

### 5.2 GC 日志的 Xlog 统一框架

JDK 11+ 的 Xlog 是统一日志框架，可以输出 GC、JIT、类加载、Safepoint 等所有日志：

```bash
# GC 日志（详细）
-Xlog:gc*:file=/data/logs/gc.log:time,uptime,level,tags:filecount=10,filesize=100m

# Safepoint 日志（排查停顿）
-Xlog:safepoint:file=/data/logs/safepoint.log:time,uptime,level,tags:filecount=5,filesize=50m

# 类加载日志（排查 Metaspace OOM）
-Xlog:classload:file=/data/logs/classload.log:time,uptime,level,tags:filecount=5,filesize=20m

# JIT 编译日志（排查退优化）
-Xlog:compilation:file=/data/logs/jit.log:time,uptime,level,tags:filecount=5,filesize=20m
```

**Xlog 的优势**：

1. **统一格式**：所有日志用相同时间戳、tag、level
2. **灵活过滤**：可以只看特定 tag（如 `gc`）
3. **滚动策略统一**：filecount + filesize

### 5.3 HeapDumpOnOutOfMemoryError 的工程实践

```bash
-XX:+HeapDumpOnOutOfMemoryError
-XX:HeapDumpPath=/data/dumps/
-XX:OnOutOfMemoryError="kill -9 %p"
```

**工程考量**：

1. **Dump 路径要预留足够空间**：24G 堆 dump 出来 24G 文件，目录至少 30G
2. **OOM 后立即杀进程**：JVM OOM 后状态不稳定，可能"半死不活"，`kill -9` 让 K8s 重启
3. **不要在 JVM 内部重启**：用 K8s livenessProbe 自动重启，而不是 JVM 内调用 `System.exit(1)`

**架构师经验**：生产环境必配 HeapDumpOnOutOfMemoryError，但 Dump 文件要定期清理（如保留 7 天），否则磁盘塞满。

### 5.4 DisableExplicitGC 的陷阱

很多生产配置抄了 `-XX:+DisableExplicitGC`，但这是**陷阱**：

```java
// DirectByteBuffer 依赖 System.gc() 回收直接内存
ByteBuffer directBuf = ByteBuffer.allocateDirect(1024 * 1024);
directBuf = null;  // 等待 GC
System.gc();       // 触发 Cleaner 回收直接内存

// DisableExplicitGC 后，System.gc() 无效
// 直接内存可能堆积，最终 OOM: Direct buffer memory
```

**正确做法**：

```bash
# 不推荐
-XX:+DisableExplicitGC

# 推荐（把 System.gc() 转为并发 GC）
-XX:+ExplicitGCInvokesConcurrent
```

### 5.5 AlwaysPreTouch 的工程价值

`-XX:+AlwaysPreTouch` 在启动时把所有内存页"触碰"一遍，建立虚拟地址到物理内存的映射：

| 维度 | 不开 AlwaysPreTouch | 开 AlwaysPreTouch |
|------|--------------------|------------------|
| 启动时间 | 快 | 慢 5-30s（视堆大小） |
| 运行抖动 | 堆扩展时缺页中断抖动 | 稳定 |
| 大堆必开 | 否（运行时秒级抖动） | 是 |

**架构师经验**：

- 延迟敏感型服务（IM/交易）：必开
- 大堆（> 16GB）：必开
- 启动时间敏感（Serverless）：不开
- 测试环境：不开

### 5.6 生产 JVM 参数模板（标准化）

**通用模板（中小服务，JDK 17，K8s 4C8G）**：

```bash
# 内存
-Xms4g -Xmx4g
-Xss512k
-XX:MaxDirectMemorySize=1g
-XX:MaxMetaspaceSize=256m
-XX:ReservedCodeCacheSize=256m

# GC（G1）
-XX:+UseG1GC
-XX:MaxGCPauseMillis=100
-XX:InitiatingHeapOccupancyPercent=45
-XX:G1ReservePercent=10
-XX:ParallelGCThreads=2
-XX:ConcGCThreads=1

# JIT
-XX:+TieredCompilation
-XX:CICompilerCount=2

# 容器化
-XX:+UseContainerSupport
-XX:+AlwaysPreTouch

# 日志（JDK 11+ Xlog）
-Xlog:gc*:file=/data/logs/gc.log:time,uptime,level,tags:filecount=10,filesize=100m
-Xlog:safepoint:file=/data/logs/safepoint.log:time,uptime,level,tags:filecount=5,filesize=50m

# OOM 处置
-XX:+HeapDumpOnOutOfMemoryError
-XX:HeapDumpPath=/data/dumps/
-XX:OnOutOfMemoryError="kill -9 %p"

# 其他
-XX:+ExplicitGCInvokesConcurrent
-Djava.security.egd=file:/dev/./urandom
-Dfile.encoding=UTF-8
-Duser.timezone=Asia/Shanghai
```

**IM 网关模板（延迟敏感，JDK 17，K8s 8C16G）**：

```bash
-Xms8g -Xmx8g
-Xss512k
-XX:MaxDirectMemorySize=4g               # Netty 长连接
-XX:MaxMetaspaceSize=256m
-XX:ReservedCodeCacheSize=256m

-XX:+UseG1GC
-XX:MaxGCPauseMillis=50                  # 严格 50ms
-XX:G1HeapRegionSize=4m
-XX:InitiatingHeapOccupancyPercent=35
-XX:G1ReservePercent=15
-XX:ParallelGCThreads=4
-XX:ConcGCThreads=2

-XX:+TieredCompilation
-XX:CICompilerCount=4

-XX:+UseContainerSupport
-XX:+AlwaysPreTouch

-Xlog:gc*:file=/data/logs/gc.log:time,uptime,level,tags:filecount=10,filesize=100m
-Xlog:safepoint:file=/data/logs/safepoint.log:time,uptime,level,tags:filecount=5,filesize=50m

-XX:+HeapDumpOnOutOfMemoryError
-XX:HeapDumpPath=/data/dumps/
-XX:OnOutOfMemoryError="kill -9 %p"

-XX:+ExplicitGCInvokesConcurrent
-XX:+UseStringDeduplication             # IM 消息大量重复模板
-Djava.security.egd=file:/dev/./urandom
-Dfile.encoding=UTF-8
-Duser.timezone=Asia/Shanghai
```

---

## 六、在线问诊系统的参数决策实战

### 6.1 决策流程：从业务特征到 JVM 参数

**步骤 1：业务特征画像**

| 服务 | QPS | 延迟要求 | 堆外内存 | 对象创建速率 | JDK 版本 |
|------|-----|---------|---------|------------|---------|
| IM 网关 | 12w | P99 &lt; 50ms | 4GB（Netty） | 中 | 17 |
| 视频问诊 SFU | 5k | P99 &lt; 100ms | 2GB（视频 buffer） | 高 | 17 |
| 监管上报 | 1k | 24h 必达 | 0.5GB | 低 | 11 |
| 大文档存档 | 100 | 无要求 | 1GB | 中 | 17 |

**步骤 2：堆大小决策**

```
IM 网关：
  - 10w 长连接 × 8KB（Netty ByteBuf + Channel 对象）= 800MB
  - 业务对象（消息、用户上下文）500MB
  - GC 缓冲 4-6GB
  - 推荐 -Xmx8g

视频问诊 SFU：
  - 1000 路视频 × 1MB（RTP 包 + SRTP 解密 buffer）= 1GB
  - 业务对象 500MB
  - GC 缓冲 4GB
  - 推荐 -Xmx6g
```

**步骤 3：GC 选型**

- IM 网关：延迟敏感 + 堆 8G → G1 + MaxGCPauseMillis=50
- 视频问诊 SFU：延迟相对宽容 + 堆 6G → G1 + MaxGCPauseMillis=100
- 大文档存档：堆大 16G + 延迟不敏感 → ZGC（JDK 17+）

**步骤 4：容器化参数**

按 K8s limit 反推，手动设 GC/编译线程数。

### 6.2 参数评审 Checklist

架构师做参数评审的 Checklist：

| 检查项 | 标准 |
|--------|------|
| -Xms = -Xmx | ✅ 必须 |
| MaxDirectMemorySize 显式设 | ✅ Netty/NIO 服务必须 |
| MaxMetaspaceSize 设上限 | ✅ 256-512M |
| ReservedCodeCacheSize ≥ 256M | ✅ 大服务 256-512M |
| GC 选型符合堆大小 | ✅ &lt; 32GB G1，> 32GB ZGC |
| ParallelGCThreads 手动设 | ✅ 容器化必设 |
| HeapDumpOnOutOfMemoryError | ✅ 生产必配 |
| HeapDumpPath 空间足够 | ✅ 至少堆大小 × 1.5 |
| OnOutOfMemoryError="kill -9 %p" | ✅ 生产必配 |
| AlwaysPreTouch | ✅ 延迟敏感 + 大堆必开 |
| Xlog 日志滚动 | ✅ filecount=10, filesize=100m |
| 时区与编码 | ✅ Asia/Shanghai + UTF-8 |
| java.security.egd | ✅ 加速 SecureRandom |

### 6.3 参数变更管理

生产 JVM 参数变更的流程：

1. **测试环境验证**：参数变更在测试环境跑全量压测
2. **金丝雀**：先在 1 台机器试运行 1 周
3. **全量发布**：分批发布，每批观察 1 小时
4. **回滚预案**：保留旧参数，发现问题立即回滚
5. **参数文档**：每次变更更新《JVM 参数配置规范》

**架构师思维**：参数变更不是"改配置"，是"风险变更"，必须按变更管理流程走。

---

## 七、本日核心认知

1. **参数是声明式约束，不是指令**：JVM 根据目标自适应，不是机械执行
2. **参数深度耦合**：调一个引发 3 个副作用，必须画耦合矩阵
3. **参数与版本强绑定**：JDK 升级必踩参数坑，要刻在脑子里
4. **堆不是越大越好**：32GB 是指针压缩边界，超过性能反而下降
5. **容器化重塑 JVM 参数**：JDK 8u191+ 才真正支持容器，K8s limit 与 JVM 参数要协同
6. **生产参数模板标准化**：按服务类型选模板，避免"每个服务一套参数"
7. **GC 日志统一用 Xlog**：JDK 11+ 弃用 PrintGCDetails，必须迁移到 Xlog
8. **OOM 处置三件套**：HeapDump + kill -9 + K8s livenessProbe 自动重启
