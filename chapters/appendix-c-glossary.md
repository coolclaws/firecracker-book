# 附录 C 名词解释

> "The limits of my language mean the limits of my world."
> —— Ludwig Wittgenstein

技术领域的术语如同一门独立的语言。在阅读 Firecracker 源码的过程中，读者会频繁遇到来自虚拟化、操作系统、网络和安全等多个领域的专有名词。本附录按字母顺序收录全书涉及的核心术语，并给出简明的中文解释，帮助读者扫除阅读障碍。

## B

**BPF (Berkeley Packet Filter)：** 最初设计用于网络数据包过滤的内核虚拟机。现代 Linux 中，seccomp 使用 BPF 字节码来定义系统调用过滤规则。Firecracker 的每个线程都加载了定制的 BPF 过滤程序，仅允许执行必需的系统调用。

**bzImage：** Linux 内核的压缩引导镜像格式。"bz" 代表 "big zImage"，包含引导加载代码和压缩后的内核。Firecracker 在 x86_64 平台上支持加载 bzImage 格式的内核，会解析其 setup header 以定位内核入口点。

## C

**cgroup (Control Group)：** Linux 内核提供的资源限制机制，可以对一组进程的 CPU、内存、I/O 带宽等资源使用量进行限额。Jailer 利用 cgroup 将 Firecracker 进程的资源消耗控制在预设范围内，防止单个 microVM 耗尽宿主机资源。

**chroot：** Unix 系统调用，将进程的根文件系统切换到指定目录，使其无法访问该目录以外的文件。Jailer 使用 chroot 将 Firecracker 进程限制在一个最小化的文件系统环境中。

**CPUID：** x86 架构的指令，用于查询处理器支持的功能特性。Firecracker 通过 KVM 接口过滤和定制暴露给 Guest 的 CPUID 信息，隐藏宿主机的部分硬件特征，确保 Guest 看到的是一个标准化的虚拟 CPU。

## E

**E820：** x86 平台上 BIOS 向操作系统报告物理内存布局的标准机制。Firecracker 构造 E820 内存映射表，告知 Guest 内核哪些地址范围是可用内存、哪些是保留区域（如 MMIO 地址空间）。

**ELF (Executable and Linkable Format)：** Unix 系统上可执行文件、目标文件和共享库的标准格式。Firecracker 支持加载 ELF 格式的内核镜像，解析其 program header 将各个段映射到 Guest 内存的正确位置。

**epoll：** Linux 提供的高性能 I/O 事件通知机制。Firecracker 的事件循环基于 epoll 构建，使用单线程监听来自 vCPU、virtio 设备、API 等多个来源的事件，实现高效的非阻塞 I/O 多路复用。

**EventFd：** Linux 内核提供的轻量级事件通知原语，本质上是一个内核维护的 64 位计数器。Firecracker 广泛使用 EventFd 进行线程间通信和设备中断通知——例如 virtio 设备通过写入 EventFd 触发 Guest 中断。

## F

**FDT (Flattened Device Tree)：** ARM 平台上描述硬件拓扑的数据结构，以扁平化的二进制格式编码。Firecracker 在 aarch64 平台上构建 FDT，向 Guest 内核描述可用的 CPU、内存、中断控制器和 virtio 设备等硬件信息。

## G

**GIC (Generic Interrupt Controller)：** ARM 架构的标准中断控制器。Firecracker 在 aarch64 平台上通过 KVM 接口配置 GICv2 或 GICv3，负责将虚拟中断路由到目标 vCPU。功能上等同于 x86 平台的 IOAPIC。

## I

**IOAPIC (I/O Advanced Programmable Interrupt Controller)：** x86 平台的 I/O 中断控制器，负责将外部设备中断路由到指定的 CPU 核心。Firecracker 在 x86_64 平台上通过 KVM 的 irqchip 功能模拟 IOAPIC，处理 virtio 设备的中断分发。

**ioctl (I/O Control)：** Unix 系统调用，用于对设备文件执行特定的控制操作。Firecracker 与 KVM 的全部交互都通过 ioctl 完成：创建 VM、配置 vCPU、设置内存区域、注入中断等操作各有对应的 ioctl 命令号。

## J

**Jailer：** Firecracker 项目提供的安全隔离工具。它在启动 Firecracker 进程之前，依次应用 cgroup 资源限制、chroot 文件系统隔离、namespace 进程隔离、用户降权和 seccomp 系统调用过滤等多层安全措施，将 VMM 进程锁定在最小权限环境中。

## K

**KVM (Kernel-based Virtual Machine)：** Linux 内核内置的虚拟化基础设施。KVM 将 Linux 内核转变为 Type-1 hypervisor，通过 `/dev/kvm` 设备文件暴露 ioctl 接口。Firecracker 是一个基于 KVM 的轻量级 VMM，利用 KVM 提供的硬件虚拟化能力运行 Guest 操作系统。

## M

**microVM：** Firecracker 创建的轻量级虚拟机实例。与传统虚拟机相比，microVM 省去了 BIOS/UEFI 引导、PCI 总线和大量遗留设备的模拟，启动时间可压缩至毫秒级别，内存开销控制在数 MB 以内。

**MMIO (Memory-Mapped I/O)：** 将设备寄存器映射到物理地址空间的 I/O 方式。Guest CPU 通过普通的内存读写指令访问设备。Firecracker 选择 MMIO 而非 PCI 作为 virtio 设备的传输层，简化了设备发现和配置流程。

**mmap (Memory Map)：** 将文件或匿名内存映射到进程虚拟地址空间的系统调用。Firecracker 使用 mmap 分配 Guest 物理内存——一块匿名映射的 Host 用户态内存被注册为 KVM 的内存区域，Guest 对物理地址的访问被 KVM 硬件透明地重定向到这块映射。

**MSR (Model-Specific Register)：** x86 处理器中用于配置和监控 CPU 行为的特殊寄存器。Firecracker 通过 KVM 接口控制 Guest 可访问的 MSR 列表，阻止 Guest 读写可能泄露宿主机信息或影响安全的寄存器。

## N

**namespace：** Linux 内核提供的资源隔离机制。不同类型的 namespace 分别隔离进程 ID（PID）、网络栈（NET）、挂载点（MNT）、用户 ID（USER）等。Jailer 为每个 Firecracker 实例创建独立的 namespace，使其拥有隔离的系统视图。

## P

**PCI (Peripheral Component Interconnect)：** 传统的外围设备互连总线标准。QEMU 等完整 VMM 通过模拟 PCI 总线连接虚拟设备。Firecracker 有意跳过 PCI 模拟，转而使用更简单的 MMIO 传输层，以减少代码复杂度和攻击面。

## R

**Rate Limiter（速率限制器）：** Firecracker 内置的 I/O 流量控制机制。使用令牌桶算法，可以分别对网络和块设备的吞吐量（字节/秒）和操作频率（操作数/秒）进行限制，防止单个 microVM 的 I/O 活动影响其他租户。

## S

**seccomp (Secure Computing Mode)：** Linux 内核的安全机制，通过加载 BPF 过滤程序限制进程可执行的系统调用。Firecracker 为不同线程角色（VMM 主线程、vCPU 线程、API 线程）配置了各自最小化的系统调用白名单。

**Snapshot（快照）：** 将运行中 microVM 的完整状态（vCPU 寄存器、设备状态、内存内容）持久化到磁盘的机制。支持全量快照和增量快照（仅保存脏页）。快照文件可用于快速恢复虚拟机，实现毫秒级冷启动。

## T

**TAP (Network TAP Device)：** Linux 内核提供的虚拟二层网络设备。应用程序可以通过读写 TAP 设备的文件描述符来收发以太网帧。Firecracker 的 virtio-net 设备将 Guest 的网络流量桥接到宿主机的 TAP 设备上。

## V

**vCPU (Virtual CPU)：** 虚拟化环境中呈现给 Guest 的逻辑处理器。Firecracker 为每个 vCPU 创建独立的线程，在循环中调用 `KVM_RUN` ioctl 驱动 Guest 代码执行，并在 VM Exit 时处理 I/O 等需要 VMM 介入的操作。

**virtio：** OASIS 组织制定的半虚拟化 I/O 标准框架。Guest 驱动程序与 Host 设备后端通过共享内存中的环形缓冲区（virtqueue）高效交换数据，避免了全虚拟化设备模拟的性能开销。Firecracker 实现了 virtio-blk、virtio-net 和 virtio-vsock 三种设备。

**VMM (Virtual Machine Monitor)：** 虚拟机监控器，也称为 hypervisor 的用户态组件。负责创建和管理虚拟机，模拟虚拟硬件设备，处理 Guest 的 I/O 请求。Firecracker 本身就是一个专为无服务器计算优化的轻量级 VMM。

**vsock (Virtual Socket)：** virtio 定义的虚拟套接字设备，提供 Guest 与 Host 之间低延迟、高效率的通信通道。与 TAP 网络设备不同，vsock 无需 IP 配置，使用 CID（Context Identifier）标识通信端点。Firecracker 通过 Unix 域套接字实现 vsock 后端。

## 本章小结

本附录收录了贯穿全书的核心技术术语，涵盖虚拟化基础（KVM、vCPU、MMIO）、设备模型（virtio、TAP、vsock）、安全机制（seccomp、namespace、cgroup）、平台架构（CPUID、GIC、IOAPIC）和系统编程（ioctl、mmap、epoll）等多个维度。这些术语构成了理解 Firecracker 源码的基本词汇表。当阅读过程中遇到不熟悉的概念时，可随时翻阅本附录获取简明释义，再结合对应章节的深入讲解建立完整认知。
