# 第 14 章 Snapshot 与 Restore

> "The best way to predict the future is to save the present." —— Alan Kay（改编）

如果每次创建 microVM 都需要从头启动内核、初始化用户空间、加载应用程序，那么即使 Firecracker 的启动速度再快，对于需要亚毫秒级响应的无服务器场景来说仍然不够。Snapshot/Restore 功能提供了一种捷径：将一个已经完全初始化好的 microVM 的状态保存到磁盘，然后在需要时瞬间恢复。这是 Firecracker 实现 "warm start" 的核心技术。

## 14.1 快照架构概览

Firecracker 的快照系统将 microVM 的完整状态分为两个部分：

**VMM 状态快照**（vmstate）：包含所有设备状态、vCPU 寄存器、中断控制器状态等结构化数据，序列化为一个紧凑的二进制文件。

**Guest 内存快照**（memory）：guest 的全部物理内存内容，以原始二进制形式保存。

这种分离设计有几个重要的好处。首先，内存文件可以很大（数百 MB），而 vmstate 通常只有几十 KB，分离后可以针对两者使用不同的存储和传输策略。其次，内存快照支持增量（diff）模式，只保存自上次快照以来被修改的内存页，这大大减小了快照的大小和创建时间。

快照相关的 API 端点定义在 `// src/vmm/src/rpc_interface.rs` 中，核心实现位于 `// src/vmm/src/persist.rs` 以及各设备的状态序列化代码中。

### 模块关系

```
Snapshot 系统模块协作

+------------------+
|   HTTP API 层    |  PUT /snapshot/create, PUT /snapshot/load
+------------------+
         |
         v
+------------------+
| rpc_interface.rs |  VmmAction::CreateSnapshot / LoadSnapshot
+------------------+
         |
         v
+------------------+     +-------------------+
|   persist.rs     |---->|   versionize      |
| (快照协调中心)    |     | (版本化序列化框架) |
+------------------+     +-------------------+
    |          |
    v          v
+--------+ +-------------------+
| memory | | device_manager/   |
| dump/  | | persist.rs        |
| restore| | (各设备状态导出)   |
+--------+ +-------------------+
    |          |
    v          v
+--------+ +-------------------+
| guest  | | 各设备 State 结构  |
| memory | | - VcpuState       |
| file   | | - VirtioNetState  |
+--------+ | - VirtioBlockState|
           | - SerialState     |
           +-------------------+
```

## 14.2 versionize：版本化序列化框架

状态序列化是快照系统中最具挑战性的部分。Firecracker 使用自研的 `versionize` crate（位于 `// src/versionize` 或作为外部依赖引入）来解决这个问题。为什么不用 serde + bincode 等成熟方案？

答案是版本兼容性。Firecracker 的每个版本都可能修改设备状态的结构——添加新字段、改变字段类型、删除废弃字段。快照文件需要在不同版本的 Firecracker 之间保持一定的兼容性，这意味着序列化框架必须原生支持 schema 演化。

versionize 通过以下机制实现版本兼容：

- 每个可序列化的结构体都标注了版本号
- 每个字段都可以声明它从哪个版本开始存在
- 序列化时记录当前版本，反序列化时根据记录的版本决定哪些字段存在
- 新增的字段可以指定默认值，使得旧版本的快照可以在新版本中恢复

这种设计使得 Firecracker 可以在升级版本后仍然加载旧版本创建的快照，这对于生产环境中的滚动升级至关重要。`// src/vmm/src/device_manager/persist.rs` 中可以看到各设备状态结构体如何使用 versionize 宏来声明版本信息。

### 设计取舍

为什么自研 versionize 而不使用 serde + bincode 或 Protocol Buffers？核心原因在于 schema 演化的可控性。serde + bincode 在字段增删时会破坏二进制兼容性，除非引入额外的版本管理层。Protocol Buffers 虽然原生支持 schema 演化，但它引入了一个庞大的外部依赖和代码生成步骤，与 Firecracker 最小化依赖的哲学相悖。此外，protobuf 的序列化格式包含字段标签等元数据开销，而 versionize 的紧凑二进制格式在快照这种性能敏感的场景中更高效。versionize 的缺点是维护成本——每次结构变更都需要手动标注版本信息——但对于 Firecracker 这种字段变更频率不高的项目，这个成本是可接受的。

## 14.3 创建快照的完整流程

当用户通过 API 请求创建快照时（`PUT /snapshot/create`），以下步骤依次执行：

**第一步：暂停 vCPU**。所有 vCPU 线程被暂停，guest 执行完全停止。这是保证状态一致性的前提——不能在 guest 运行时捕获状态，否则可能得到一个"半修改"的不一致快照。

**第二步：保存 vCPU 状态**。通过 KVM 的 `KVM_GET_REGS`、`KVM_GET_SREGS`、`KVM_GET_MSRS` 等 ioctl 获取每个 vCPU 的全部寄存器状态。在 aarch64 上，对应的是 `KVM_GET_ONE_REG` 接口。这些寄存器数据包括通用寄存器、段寄存器、控制寄存器、浮点/SIMD 状态等。

**第三步：保存设备状态**。每个设备（串口、virtio-net、virtio-block 等）实现了状态导出接口，将自己的内部状态转换为可序列化的结构体。对于 virtio 设备，这包括 virtqueue 的配置（描述符表地址、可用环索引、已用环索引等）和设备特定的状态。

**第四步：保存中断控制器状态**。通过 KVM ioctl 获取 IOAPIC（x86）或 GIC（ARM）的完整状态。

**第五步：序列化并写入文件**。将所有状态通过 versionize 序列化为二进制格式，写入用户指定的文件路径。

**第六步：保存 guest 内存**。将 guest 的物理内存内容写入另一个文件。对于全量快照，直接 dump 整个内存区域；对于增量快照，只写入脏页。

### 核心流程

```
快照创建流程（PUT /snapshot/create）

  API 请求到达
      |
      +---> 暂停所有 vCPU 线程
      |
      +---> 保存 vCPU 状态
      |       +---> KVM_GET_REGS（通用寄存器）
      |       +---> KVM_GET_SREGS（段寄存器）
      |       +---> KVM_GET_MSRS（MSR 寄存器）
      |
      +---> 保存设备状态
      |       +---> 串口 SerialState
      |       +---> virtio-net VirtioNetState
      |       +---> virtio-block VirtioBlockState
      |       +---> virtqueue 配置（desc table, avail/used ring）
      |
      +---> 保存中断控制器状态
      |       +---> IOAPIC (x86) / GIC (ARM)
      |
      +---> versionize 序列化 ---> vmstate 文件
      |
      +---> 保存 guest 内存
              +---> [全量] dump 整个内存区域 ---> memory 文件
              +---> [增量] KVM_GET_DIRTY_LOG ---> 脏页位图 + 脏页数据


快照恢复流程（PUT /snapshot/load）

  API 请求到达
      |
      +---> 创建新的 KVM VM 实例
      |
      +---> 恢复 guest 内存
      |       +---> 加载全量 memory 文件
      |       +---> [如有增量] 覆盖脏页
      |
      +---> versionize 反序列化 vmstate 文件
      |
      +---> 重建设备（从 State 恢复，非零初始化）
      |
      +---> 恢复中断控制器（IOAPIC / GIC）
      |
      +---> 恢复 vCPU 寄存器状态
      |       +---> KVM_SET_REGS / KVM_SET_SREGS / KVM_SET_MSRS
      |
      +---> 启动 vCPU 线程，guest 从暂停点继续执行
```

## 14.4 全量快照与增量快照

Firecracker 支持两种内存快照模式，这是在创建快照时通过 API 参数指定的：

**全量快照**（Full）将 guest 的全部内存写入磁盘。简单可靠，但文件大小等于 guest 内存大小。一个 256MB 内存的 microVM 就会产生 256MB 的内存快照文件。

**增量快照**（Diff）利用 KVM 的脏页追踪功能，只保存自上次快照以来被修改（"变脏"）的内存页。Firecracker 通过 `KVM_GET_DIRTY_LOG` ioctl 获取脏页位图，然后只写出标记为脏的页面。增量快照文件包含脏页的位图和对应的页数据。

增量快照的优势在于大幅减小文件体积。对于一个内存基本稳定的 microVM，增量快照可能只有几 MB，远小于全量快照。但增量快照依赖于一个"基础"全量快照，恢复时需要先加载基础快照再应用增量。

为什么 Firecracker 不支持多级增量链？因为增量链越长，恢复时需要合并的层越多，恢复时间和复杂度都会增加。Firecracker 的设计选择是保持简单：一个全量基础加最多一个增量。这足以满足主要使用场景（快速更新快照），同时避免了复杂的合并逻辑。

### 设计取舍

增量快照的设计面临两个关键取舍。第一是脏页追踪的粒度：KVM 的 `KVM_GET_DIRTY_LOG` 以 4KB 页为单位追踪，即使只修改了一个字节也会标记整个页为脏。更细粒度的追踪（如字节级）会带来巨大的元数据开销和性能损耗，4KB 页粒度是硬件支持的自然边界，也是存储效率与追踪成本之间的最佳平衡点。第二是增量链的深度限制：Firecracker 只允许"一个全量 + 一个增量"的两层结构，而非像容器镜像那样支持多层叠加。多级增量链在恢复时需要按序合并每一层，既增加恢复延迟也增加实现复杂度，还引入了链中任一层损坏导致整个快照不可用的风险。对于 Firecracker 追求的毫秒级恢复场景，这种复杂性得不偿失。

## 14.5 恢复流程

从快照恢复一个 microVM（`PUT /snapshot/load`）本质上是创建过程的逆操作，但有一些微妙的差异：

**第一步：创建 KVM VM 实例**。与正常启动一样，首先创建一个新的 VM。

**第二步：恢复 guest 内存**。将快照中的内存内容加载到 VM 的 guest 内存区域。如果有增量快照，先加载全量基础，再在其上覆盖增量的脏页。

**第三步：反序列化 vmstate**。读取状态文件，通过 versionize 反序列化为各设备的状态结构体。

**第四步：重建设备**。根据反序列化的状态重新创建每个设备，但不是从零初始化，而是将设备状态设置为快照时的状态。这包括恢复 virtqueue 的配置、设备特定的状态标志等。

**第五步：恢复 vCPU 状态**。通过 `KVM_SET_REGS`、`KVM_SET_SREGS` 等 ioctl 将 vCPU 寄存器恢复到快照时的值。

**第六步：恢复中断控制器**。将 IOAPIC 或 GIC 的状态恢复。

**第七步：恢复运行**。启动 vCPU 线程，guest 从暂停点继续执行。对于 guest 内核来说，它完全不知道自己曾被暂停和恢复——时间在它看来是连续的（虽然实际上可能已经过去了很久）。

恢复的顺序同样有严格要求。例如，设备重建必须在内存恢复之后，因为设备可能需要访问 guest 内存中的共享结构（如 virtqueue 描述符表）。中断控制器的恢复必须在 vCPU 恢复之前，否则 vCPU 可能在中断控制器未就绪时尝试处理中断。

## 14.6 使用场景

快照功能在 Firecracker 的主要使用场景中发挥着关键作用：

**快速启动（Warm Start）**：预先创建并初始化一个 microVM，在应用程序完全就绪后创建快照。后续需要新实例时，直接从快照恢复，跳过了内核启动、systemd 初始化、应用加载等漫长过程。恢复时间通常在 5-10ms 级别，比冷启动快一到两个数量级。

**版本预热**：对于无服务器函数的新版本部署，可以预先创建快照，使得首次调用时也能获得接近后续调用的响应时间。

**内存去重基础**：多个从同一快照恢复的 microVM 共享相同的基础内存页（通过文件系统的 page cache），只有被修改的页才会产生额外的内存分配，这在高密度部署场景中显著节省了 host 内存。

## 14.7 限制与注意事项

快照功能存在一些固有的限制。恢复后的 microVM 可能面临时间跳变问题，因为 guest 内核的时钟在暂停期间没有推进。网络连接在恢复后可能已经超时断开。随机数生成器的状态被克隆，如果从同一快照恢复多个实例，可能产生相同的随机数序列——Firecracker 通过在恢复后注入额外的熵来缓解这个问题。

此外，快照只能在相同硬件架构和兼容的 Firecracker 版本之间使用，不支持跨架构恢复。versionize 的版本兼容性也有其边界，通常只保证相邻几个版本之间的兼容。

## 本章小结

本章分析了 Firecracker 的 Snapshot/Restore 系统。快照将 microVM 状态分为 vmstate（设备和 CPU 状态的序列化数据）和 memory（guest 内存内容）两个文件。versionize crate 提供版本化序列化能力，解决了跨版本兼容的难题。内存快照支持全量和增量两种模式，增量模式通过 KVM 脏页追踪只保存变化的页面。恢复流程按照严格的顺序重建 VM、内存、设备和 vCPU 状态。快照功能使得 Firecracker 能够实现毫秒级的 warm start，这是无服务器计算场景中实现极低延迟冷启动的核心技术。
