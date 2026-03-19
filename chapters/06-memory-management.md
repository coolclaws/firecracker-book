# 第 6 章 内存管理与 GuestMemory

> "Memory is the treasury and guardian of all things."
> —— Marcus Tullius Cicero

虚拟化的核心挑战之一，是如何让 Guest 操作系统以为自己拥有一段完整、连续的物理内存，而实际上这些内存不过是 Host 进程地址空间中的一片映射区域。Firecracker 在内存管理上的设计哲学与其整体架构一脉相承：用最简单的模型解决问题，拒绝不必要的复杂性。

## GuestMemoryMmap 抽象

Firecracker 的内存管理建立在 `rust-vmm` 社区的 `vm-memory` crate 之上。核心抽象是 `GuestMemoryMmap`，它实现了 `GuestMemory` trait，为上层提供统一的内存访问接口。

```
// src/vmm/src/vstate/memory.rs
```

`GuestMemoryMmap` 本质上是一组 `GuestRegionMmap` 的有序集合，每个 region 对应一段连续的 Guest 物理地址范围。这种设计的原因在于：Guest 的物理地址空间并不总是连续的——特别是在 x86_64 架构下，存在一段不可用的地址空洞。通过将内存划分为多个 region，Firecracker 可以灵活地跳过这些空洞，同时保持每个 region 内部的连续性。

`GuestMemory` trait 提供了一系列关键方法：`read_obj`、`write_obj` 用于读写结构化数据，`read_slice`、`write_slice` 用于批量数据操作，`get_host_address` 则提供了从 Guest 物理地址（GPA）到 Host 虚拟地址（HVA）的转换能力。这些方法内部都会进行边界检查，确保访问不会越过 region 的边界。

## Guest 物理地址到 Host 虚拟地址的转换

地址转换是整个内存子系统最关键的操作。当 VMM 需要访问 Guest 内存中的某个位置时——比如读取 Guest 写入 virtqueue 的描述符——它需要将 Guest 物理地址转换为自己进程空间中的指针。

转换过程分为两步：首先，在 `GuestMemoryMmap` 维护的有序 region 列表中，通过二分查找定位到包含目标 GPA 的 region；然后，利用该 region 的基地址偏移量，计算出对应的 HVA。公式很简单：

```
HVA = region_host_base + (GPA - region_guest_base)
```

这种转换之所以高效，是因为 Firecracker 在 VMM 启动时就通过 `mmap` 建立了完整的映射，之后的地址转换只是简单的指针算术运算，无需任何系统调用。

## mmap 内存映射

Firecracker 使用 `mmap` 系统调用来分配 Guest 内存。具体来说，每个 `GuestRegionMmap` 在创建时会调用 `mmap` 分配一段匿名私有内存（`MAP_ANONYMOUS | MAP_PRIVATE`），大小对应该 region 的长度。

```
// src/vmm/src/vstate/memory.rs
```

这段 `mmap` 映射随后会通过 `KVM_SET_USER_MEMORY_REGION` ioctl 注册给 KVM。KVM 会在其内部的 EPT（Extended Page Table，扩展页表）或 NPT（Nested Page Table，嵌套页表）中建立 GPA 到 HPA（Host 物理地址）的映射。当 Guest 访问某个 GPA 时，硬件会自动完成两级地址转换：GPA -> HPA，中间无需 VMM 介入。

为什么使用 `MAP_PRIVATE` 而非 `MAP_SHARED`？因为 Firecracker 的设计理念是每个 microVM 完全隔离。`MAP_PRIVATE` 确保即使进程 fork（比如在 snapshot 场景下），父子进程的内存修改互不影响，利用了 Copy-on-Write 机制。

## 架构相关的内存布局

x86_64 架构的内存布局存在一个历史遗留的特殊性：从 3.25 GiB（`0xD000_0000`）到 4 GiB（`0x1_0000_0000`）之间的地址空间被保留给 MMIO 设备（如 Local APIC、IOAPIC、PCI 配置空间等）。这意味着 Guest 的物理内存必须跳过这段区域。

```
// src/vmm/src/arch/x86_64/mod.rs
```

对于小于 3.25 GiB 的内存配置，Firecracker 只需要创建一个 region，从地址 0 开始映射。但当内存超过 3.25 GiB 时，就需要两个 region：第一个从 0 到 3.25 GiB，第二个从 4 GiB 开始，容纳剩余的内存。Guest 内核会识别这种不连续的内存布局，并正确使用两段内存。

aarch64 架构则相对简单，其 MMIO 区域位于内存空间的低地址段，Guest RAM 从更高的固定地址开始，通常只需要一个连续的 region 即可。

这种架构差异被封装在 `arch` 模块中，上层代码通过统一的 `create_guest_memory` 接口创建内存，无需关心具体的布局细节。这是一个典型的关注点分离设计。

## 为什么选择简单的扁平内存模型

相比于 QEMU 支持的复杂内存拓扑（NUMA 节点、内存热插拔、balloon 设备、内存后端文件等），Firecracker 选择了一种极简的扁平内存模型：在 microVM 启动时一次性分配所有内存，运行期间不支持动态调整。

这个设计决策背后有几个深层原因：

**可预测性。** Serverless 场景下，函数的内存需求在部署时就已确定。动态内存调整引入了不确定性——balloon 设备需要 Guest 配合释放内存，而这个过程的时间和效果都不可控。预分配的模型让资源使用完全可预测。

**安全性。** 内存热插拔需要在运行时修改 KVM 的内存映射，增加了攻击面。简单的静态映射大幅减少了内存管理路径上的代码量，从而降低了安全风险。

**启动速度。** 一次性 `mmap` 加 `KVM_SET_USER_MEMORY_REGION` 的开销极小。配合 Linux 的 demand paging 机制，`mmap` 只是建立了虚拟地址映射，实际的物理页面分配会延迟到首次访问时发生。这意味着即使配置了 512 MiB 的 Guest 内存，如果 Guest 只使用了 100 MiB，Host 上也只会实际分配 100 MiB 的物理页面。

**与 snapshot 的协同。** Firecracker 的 snapshot/restore 功能需要保存和恢复 Guest 内存。扁平的内存模型使得 snapshot 实现非常直接——只需将 mmap 区域的内容序列化到文件即可，无需处理复杂的内存拓扑关系。

## 本章小结

Firecracker 的内存管理体现了"够用就好"的设计哲学。`GuestMemoryMmap` 提供了高效的地址转换机制，`mmap` + KVM 的组合利用硬件辅助虚拟化实现了接近原生的内存访问性能，而架构相关的内存布局差异被干净地封装在 `arch` 模块中。放弃内存热插拔和复杂的内存后端，换来的是更小的代码量、更低的安全风险和更快的启动速度。在 Serverless 的语境下，这些取舍恰如其分。
