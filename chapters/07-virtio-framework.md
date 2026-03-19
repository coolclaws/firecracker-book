# 第 7 章 virtio 设备框架

> "Any sufficiently advanced technology is indistinguishable from magic."
> —— Arthur C. Clarke

如果说 KVM 解决了 CPU 和内存虚拟化的问题，那么 I/O 虚拟化就是 virtio 的舞台。virtio 是一套标准化的半虚拟化 I/O 框架，它通过在 Guest 和 Host 之间建立一条高效的数据通道，避免了传统全虚拟化设备模拟中昂贵的 trap-and-emulate 开销。Firecracker 从第一天起就选择了 virtio 作为唯一的 I/O 虚拟化方案，这一决策深刻地塑造了它的设备架构。

## virtio 规范概述

virtio 规范（目前广泛使用的是 1.0 和 1.1 版本）定义了一套通用的设备抽象：每个 virtio 设备由一组 virtqueue 组成，virtqueue 是 Guest 和 Host 之间传递数据的共享内存环形缓冲区。规范同时定义了三种传输层（transport）——PCI、MMIO 和 Channel I/O——用于设备发现和配置寄存器的访问。

Firecracker 实现了 virtio 规范的一个精心裁剪的子集。它只支持 MMIO transport，只实现了 net、block 和 vsock 三种设备类型，并且只支持 split virtqueue（而非 packed virtqueue）。这种克制是有意为之的：每少一个功能，就少一个潜在的攻击面。

## VirtioDevice trait

Firecracker 将 virtio 设备的公共行为抽象为 `VirtioDevice` trait，所有具体设备（Net、Block、Vsock）都必须实现它。

```
// src/vmm/src/devices/virtio/mod.rs
```

这个 trait 定义了设备生命周期中的关键操作：`device_type` 返回设备类型标识；`queues` 和 `queue_events` 提供对 virtqueue 和对应 EventFd 的访问；`avail_features` 和 `acked_features` 管理特性协商；`activate` 在 Guest 驱动完成初始化后激活设备，启动实际的 I/O 处理；`read_config` 和 `write_config` 处理设备特定的配置空间访问。

为什么要设计这样一个 trait？因为 MMIO transport 层需要以统一的方式管理所有设备——无论是网卡还是块设备，它们的 MMIO 寄存器布局是相同的，设备状态机转换逻辑是相同的，只是具体的 I/O 处理不同。`VirtioDevice` trait 将变化的部分（具体设备逻辑）与不变的部分（transport 层逻辑）分离，是经典的策略模式应用。

## virtqueue 实现

virtqueue 是 virtio 框架的核心数据结构，由三个部分组成：

**Descriptor Table（描述符表）。** 一个固定大小的数组，每个条目描述一段 Guest 内存缓冲区——包括 GPA 地址、长度、标志位和链表指针。描述符可以通过 `next` 字段链成链表，表示一个多段的 I/O 请求。`VIRTQ_DESC_F_WRITE` 标志表示该缓冲区对设备可写（即设备写入、Guest 读取）。

```
// src/vmm/src/devices/virtio/queue.rs
```

**Available Ring（可用环）。** Guest 驱动通过这个环向设备提交待处理的描述符链。Guest 写入描述符链的头部索引，然后更新 `idx` 字段。设备侧通过比较自己记录的 `next_avail` 与环中的 `idx` 来检测是否有新请求。

**Used Ring（已用环）。** 设备通过这个环向 Guest 返回已处理完的描述符链。设备写入描述符链的头部索引和已写入的字节数，然后更新 `idx` 字段，最后通过中断通知 Guest。

整个 virtqueue 的工作流程形成了一个清晰的生产者-消费者模型：Guest 是 available ring 的生产者和 used ring 的消费者，设备则相反。这种设计的精妙之处在于，双方通过各自独占的索引字段进行同步，无需任何锁机制。

Firecracker 中 virtqueue 的实现位于 `Queue` 结构体中。`pop` 方法从 available ring 取出下一个描述符链，返回一个 `DescriptorChain` 迭代器；`add_used` 方法将处理完的描述符链放回 used ring。边界检查和内存访问的安全性由 `GuestMemory` 的接口保证。

## MMIO Transport：为什么不用 PCI

在传统虚拟化方案中，virtio 设备通常通过 PCI transport 呈现给 Guest，因为 PCI 总线提供了成熟的设备发现和配置机制。但 Firecracker 选择了更简单的 MMIO transport。

```
// src/vmm/src/devices/virtio/mmio.rs
```

MMIO transport 将设备的配置寄存器映射到 Guest 物理地址空间的一段固定区域。Guest 通过内存读写操作访问这些寄存器，而 KVM 会将这些访问 trap 到 VMM 中处理。每个 MMIO 设备通过 device tree（aarch64）或内核命令行参数（x86_64）告知 Guest 其地址范围和中断号。

不用 PCI 的理由很充分：PCI transport 需要模拟 PCI 配置空间、PCI BAR 分配、MSI-X 中断表等一系列复杂机制。这些代码不仅增加了 VMM 的体积，也显著扩大了攻击面。MMIO transport 的寄存器接口只有几十个字节，实现代码不到千行，而功能上完全满足 Firecracker 的需求。

代价是什么？MMIO transport 不支持自动设备发现（需要显式传递设备信息），设备数量受限于可用的 MMIO 地址空间和中断号。但在 Firecracker 的场景下，一个 microVM 最多只需要几个设备，这些限制完全可以接受。

## 设备状态生命周期

virtio 规范定义了一个严格的设备初始化状态机，Guest 驱动必须按顺序设置以下状态位：

1. **ACKNOWLEDGE（1）**：Guest 发现并识别了设备。
2. **DRIVER（2）**：Guest 知道如何驱动该设备。
3. **FEATURES_OK（8）**：特性协商完成。
4. **DRIVER_OK（4）**：驱动初始化完成，设备可以开始工作。

Firecracker 在 `MmioTransport` 的 `write` 方法中严格检查状态转换的合法性。当 Guest 设置 `DRIVER_OK` 位时，`MmioTransport` 会调用底层 `VirtioDevice` 的 `activate` 方法，启动设备的 I/O 处理循环。如果 Guest 设置了 `FAILED（128）` 位，则表示驱动初始化失败。

## 特性协商

virtio 设备和驱动各自声明自己支持的特性位（feature bits）。初始化过程中，Guest 驱动读取设备支持的特性，取交集后写回。设备侧确认后设置 `FEATURES_OK`。

Firecracker 中每种设备定义了自己支持的特性集。例如，Net 设备支持 `VIRTIO_NET_F_GUEST_CSUM`（Guest 可以处理校验和）和 `VIRTIO_NET_F_MAC`（设备提供 MAC 地址）等。特性协商的机制保证了前向兼容性——新版本的设备和旧版本的驱动可以通过协商找到双方都支持的功能子集。

## 中断信号与 EventFd

Guest 和 Host 之间的异步通知机制依赖 Linux 的 `eventfd` 系统调用。Firecracker 为每个 virtqueue 注册两个 EventFd：

**ioeventfd：** 绑定到 virtqueue 的 notify 寄存器地址。当 Guest 写入该地址通知设备有新请求时，KVM 直接递增 eventfd 计数器，无需 VM Exit 到 VMM 用户态。这是一个关键的性能优化——数据面通知几乎零开销。

**irqfd：** 绑定到虚拟中断号。当设备处理完请求需要通知 Guest 时，VMM 写入 irqfd，KVM 会自动向 Guest 注入一个虚拟中断。同样无需额外的 VM Exit。

```
// src/vmm/src/devices/virtio/mmio.rs
```

ioeventfd 和 irqfd 的组合，使得 virtio 数据面的通知路径完全在内核中完成，避免了用户态-内核态的上下文切换。这是 Firecracker 实现高性能 I/O 的关键基础设施。

## 本章小结

virtio 框架是 Firecracker I/O 虚拟化的基石。`VirtioDevice` trait 定义了设备的统一接口，virtqueue 的三环结构提供了高效的无锁数据传输通道，MMIO transport 以最小的代码量实现了设备配置和发现。EventFd 机制将数据面通知路径下沉到内核，消除了不必要的上下文切换。选择 MMIO 而非 PCI、选择 split 而非 packed virtqueue——每一个取舍都指向同一个目标：在满足功能需求的前提下，最小化代码复杂度和攻击面。接下来的三章，我们将看到这个框架如何被具体设备所使用。
