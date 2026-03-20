# 第 12 章 microVM 启动序列

> "A journey of a thousand miles begins with a single step." —— 老子《道德经》

从一个 HTTP API 调用到 guest 内核打印出第一行日志，中间究竟发生了什么？microVM 的启动序列是 Firecracker 中最精密的编排流程之一，它需要在正确的时间、以正确的顺序完成内存布局、内核加载、设备初始化和 vCPU 启动等一系列操作。本章将沿着 `build_microvm()` 函数的执行路径，完整剖析这一启动过程。

## 12.1 启动的起点：build_microvm()

一切始于 `// src/vmm/src/builder.rs` 中的 `build_microvm()` 函数。当用户通过 HTTP API 发送 `InstanceStart` 请求后，经过配置验证，控制流最终到达这个函数。它是整个启动序列的总调度器，按照严格的顺序完成以下步骤：

1. 创建 KVM VM 实例
2. 配置 guest 内存
3. 加载内核镜像
4. 配置启动参数
5. 初始化中断控制器
6. 创建并配置设备
7. 配置 vCPU
8. 启动 vCPU 线程

这个顺序不是随意的。每一步都依赖于前一步的结果。例如，内核加载需要先有 guest 内存；设备初始化需要先有中断控制器；vCPU 配置需要知道内核的入口地址。`build_microvm()` 的设计体现了一个原则：将复杂的启动过程分解为可测试的独立步骤，同时保证步骤间的依赖关系明确可见。

### 核心流程

```
HTTP API: InstanceStart 请求
        |
        v
+---------------------------+
| build_microvm()           |  总调度入口
+---------------------------+
        |
        v
+---------------------------+
| 1. KVM_CREATE_VM          |  创建 VM 文件描述符
+---------------------------+
        |
        v
+---------------------------+
| 2. 配置 Guest 内存         |  mmap 分配内存区域
|    KVM_SET_USER_MEMORY     |  注册到 KVM
+---------------------------+
        |
        v
+---------------------------+
| 3. 加载内核镜像            |
|    x86: bzImage protocol  |  +---> 解析 setup header
|    ARM: PE Image          |  +---> 写入 Guest 内存
+---------------------------+
        |
        v
+---------------------------+
| 4. 配置启动参数            |
|    x86: boot_params +     |  +---> E820 内存表
|         cmdline           |  +---> 内核命令行
|    ARM: FDT               |  +---> Device Tree blob
+---------------------------+
        |
        v
+---------------------------+
| 5. (可选) 加载 initrd     |  写入内核上方的内存区域
+---------------------------+
        |
        v
+---------------------------+
| 6. 初始化中断控制器        |
|    x86: KVM_CREATE_IRQCHIP|  PIC + IOAPIC + LAPIC
|    ARM: KVM_CREATE_DEVICE |  GICv3 (或 fallback GICv2)
+---------------------------+
        |
        v
+---------------------------+
| 7. 创建并配置设备          |
|    +---> virtio-net       |  分配 MMIO 地址 + IRQ
|    +---> virtio-block     |  注册 ioeventfd/irqfd
|    +---> virtio-vsock     |
|    +---> serial (legacy)  |
+---------------------------+
        |
        v
+---------------------------+
| 8. 配置 vCPU              |
|    x86: 64-bit long mode  |  设置 CR0/CR3/CR4, 页表,
|         RIP=内核入口       |  RSI=boot_params 地址
|    ARM: PC=内核入口        |  x0=FDT 地址, EL1 模式
+---------------------------+
        |
        v
+---------------------------+
| 9. 启动 vCPU 线程         |  每个 vCPU 一个线程
|    KVM_RUN 主循环          |  Guest 内核开始执行
+---------------------------+
```

## 12.2 内核加载：x86 的 bzImage 协议

在 x86_64 架构上，Firecracker 支持加载标准的 Linux bzImage 格式内核。内核加载的实现位于 `// src/vmm/src/builder.rs` 以及底层的 linux-loader crate 中。

bzImage 文件的头部包含一个 Linux Boot Protocol 定义的 setup header，其中记录了关键信息：内核的 setup 代码大小、保护模式代码的加载地址、内核版本等。Firecracker 解析这个 header，验证协议版本（要求 >= 2.01），然后将内核的保护模式部分加载到 guest 内存中指定的地址（通常是 `0x0100_0000`，即 16MB 处）。

为什么加载到 16MB 处而不是更低的地址？因为低地址区域被预留给了 real-mode 代码、boot parameters、命令行字符串以及 BIOS 数据区等结构。将内核放在高地址可以避免与这些结构冲突。

加载过程的关键步骤：

```
1. 读取并验证 bzImage header
2. 计算保护模式内核在文件中的偏移
3. 将保护模式内核数据写入 guest 内存
4. 返回内核入口点地址
```

Firecracker 不支持加载未压缩的 vmlinux 格式内核（对于 x86），这是一个有意的简化决策。bzImage 是标准发行版内核的默认格式，支持它就能满足绝大多数使用场景。

## 12.3 启动参数与 E820 内存映射

内核需要知道自己运行的环境信息，这通过 boot parameters 结构体传递。在 x86 上，这个结构体定义在 `// src/vmm/src/arch/x86_64/layout.rs` 中引用的内存布局位置，其格式遵循 Linux 的 `struct boot_params` 规范。

Firecracker 需要填充的关键字段包括：

**E820 内存映射表** 是其中最重要的部分。E820 是 x86 平台描述物理内存布局的标准方法。Firecracker 根据配置的 guest 内存大小，构建一个简化的 E820 表，通常包含以下条目：

- 低端内存区域（640KB 以下的可用 RAM）
- MMIO 空洞（如 VGA 和 BIOS ROM 区域）
- 高端内存区域（1MB 以上的主要可用 RAM）

这个内存映射表告诉内核哪些物理地址范围可以使用，哪些被硬件保留。虽然 microVM 没有真实的 VGA 或 BIOS ROM，但 Linux 内核期望看到标准的内存布局，因此 Firecracker 必须模拟这种布局以保证兼容性。

**内核命令行** 通过 boot parameters 中的指针传递给内核。命令行字符串被写入 guest 内存的特定位置（在 `// src/vmm/src/arch/x86_64/layout.rs` 中定义），boot parameters 中记录其地址和长度。用户通过 API 设置的 `boot_args` 字符串最终就是通过这个机制到达 guest 内核的。典型的命令行包含 `console=ttyS0 reboot=k panic=1` 等参数，其中 `console=ttyS0` 将串口配置为控制台输出，`reboot=k` 使用键盘控制器复位，`panic=1` 让内核在 panic 后 1 秒重启。

### 设计取舍

Firecracker 选择直接通过 Linux Boot Protocol 传递启动参数，而非模拟 BIOS/UEFI 固件来完成这一工作。传统虚拟机（如 QEMU）可以搭配 SeaBIOS 或 OVMF 固件，由固件负责硬件探测、内存映射构建和内核加载。这种方式兼容性极强（甚至可以启动 Windows），但固件执行本身需要数百毫秒甚至数秒。Firecracker 直接在 VMM 中构建 boot_params 结构体、填充 E820 表、设置内核命令行，并将 vCPU 直接配置为 64-bit 长模式——完全跳过了 real mode 到 protected mode 的切换过程。代价是只能启动符合 Linux Boot Protocol 的内核，无法运行其他操作系统。但对于 Serverless 场景，这个限制完全可以接受，换来的是将固件阶段的耗时压缩为零。ARM 侧使用 FDT 的方案同样遵循这一思路：用数据结构直接描述硬件拓扑，无需固件层的动态探测。

## 12.4 initrd 加载

如果用户配置了 initrd（初始内存文件系统），Firecracker 会将其加载到 guest 内存的高端地址区域。initrd 的加载地址需要满足两个条件：不与内核重叠，且地址对齐到页边界。

加载逻辑会计算内核占用的最高地址，然后在其上方找到合适的位置放置 initrd。initrd 的起始地址和大小会被记录到 boot parameters 中，内核启动后据此找到并挂载 initrd。

为什么 initrd 对 Firecracker 的使用场景特别重要？因为在无服务器环境中，许多函数的根文件系统就是一个 initrd 或 initramfs。它被直接加载到内存中，无需块设备驱动，可以显著减少启动时间。

## 12.5 aarch64 启动：Device Tree 与 FDT

ARM 架构使用完全不同的启动协议。没有 BIOS、没有 E820 表，取而代之的是 Flattened Device Tree（FDT）。FDT 是一个描述硬件拓扑的二进制数据结构，内核通过解析它来发现系统中有哪些设备、它们的地址和中断号是什么。

Firecracker 在 `// src/vmm/src/arch/aarch64/` 目录下构建 FDT，包含以下关键节点：

- **memory 节点**：描述 guest 可用的物理内存范围
- **chosen 节点**：包含内核命令行和 initrd 地址
- **GIC 节点**：描述中断控制器的类型和地址
- **timer 节点**：描述 ARM 通用定时器的中断号
- **virtio-mmio 节点**：为每个 virtio 设备声明 MMIO 地址和中断号
- **serial 节点**：描述串口设备

FDT 被写入 guest 内存的指定位置，内核入口时 x0 寄存器指向 FDT 的地址。这比 x86 的启动协议更加优雅——所有硬件信息都通过一个统一的数据结构传递，而不是分散在多个表和约定中。

aarch64 上内核的加载也有所不同。Firecracker 加载的是 PE（Portable Executable）格式的 Image，这是 ARM64 Linux 内核的标准格式。内核被加载到内存起始位置附近的对齐地址，入口点通常就是镜像加载地址本身。

## 12.6 vCPU 初始化与启动

所有准备工作完成后，最后一步是创建并启动 vCPU。在 x86 上，vCPU 需要配置为 64-bit 长模式状态，这涉及设置一系列特殊寄存器，具体在 `// src/vmm/src/vstate/vcpu/x86_64.rs` 中实现：

- **段寄存器**（CS、DS、SS 等）：配置为 flat 64-bit 模式
- **控制寄存器**（CR0、CR3、CR4）：启用分页和保护模式
- **页表**：Firecracker 构建一个简单的恒等映射页表
- **RIP**：设置为内核入口点地址
- **RSI**：指向 boot parameters 的地址

在 aarch64 上，vCPU 的初始化相对简单。寄存器 PC 设置为内核入口地址，x0 设置为 FDT 地址。ARM 的 boot protocol 要求 MMU 关闭，CPU 处于 EL1 异常级别。

vCPU 配置完成后，Firecracker 为每个 vCPU 创建一个专用线程，线程的主循环调用 `KVM_RUN` ioctl 让 vCPU 开始执行 guest 代码。至此，内核开始运行，microVM 的启动过程完成。

## 12.7 启动时间优化

Firecracker 著名的 "125ms 启动时间" 不是偶然的，而是对启动序列中每一步的精心优化：

- **跳过 BIOS/UEFI**：直接从 Linux boot protocol 开始，省去了固件初始化
- **最小设备集**：只创建必需的设备，减少初始化时间
- **预配置 vCPU**：直接设置为 64-bit 模式，跳过 real mode 到 protected mode 的切换
- **内存预分配**：通过 hugetlbfs 或 memfd 避免运行时的页表填充

这些优化的本质是：去除传统虚拟机启动过程中所有不必要的步骤，只保留让 Linux 内核运行所需的最小工作集。

## 本章小结

本章完整追踪了 microVM 从 API 调用到 guest 内核运行的启动序列。核心流程由 `build_microvm()` 函数编排，依次完成 VM 创建、内存配置、内核加载、boot parameters 设置、设备初始化和 vCPU 启动。x86 遵循 Linux Boot Protocol，通过 bzImage header、E820 内存表和 boot_params 结构传递启动信息；aarch64 则使用 FDT 统一描述硬件拓扑。Firecracker 通过跳过固件层、最小化设备集和直接配置 64-bit 运行环境，将启动时间压缩到百毫秒级别。理解这个启动序列，是理解 Firecracker 如何实现"极速启动"这一核心承诺的关键。
