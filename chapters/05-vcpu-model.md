# 第 5 章 vCPU 模型与寄存器状态

> "The CPU is the actor; the registers are its memory of what it was doing; the run loop is the stage on which all computation performs."
> —— Charles Petzold, *Code*

## 5.1 VcpuHandle：线程管理的艺术

在 Firecracker 中，每个 vCPU 运行在一个独立的 OS 线程上。`VcpuHandle`（定义在 `// src/vmm/src/vcpu/mod.rs`）是 VMM 主线程与 vCPU 线程之间的控制通道。它持有三个关键资源：线程的 `JoinHandle` 用于等待线程退出，`EventFd` 用于向 vCPU 线程发送控制信号，以及一个用于传递请求和响应的通道。

**为什么每个 vCPU 需要一个独立线程？** 这是 KVM API 的设计约束决定的。`KVM_RUN` ioctl 会阻塞调用线程直到 guest 代码触发 VM exit。如果在单线程中运行多个 vCPU，就必须使用非阻塞模式加 epoll，这会显著增加代码复杂度且降低性能。一个线程对应一个 vCPU 是最自然、最高效的模型。

`VcpuHandle` 的设计还体现了 Rust 所有权系统的优势。`VcpuFd`（KVM vCPU 文件描述符的封装）被 move 进 vCPU 线程的闭包中，确保了只有该线程能够操作这个 vCPU。主线程通过 `VcpuHandle` 提供的消息接口与 vCPU 线程通信，而不是直接共享 `VcpuFd`。这种设计在编译期就杜绝了 vCPU 文件描述符的数据竞争。

## 5.2 vCPU Run Loop：Guest 代码的执行引擎

vCPU 线程的核心是一个紧凑的 run loop（参见 `// src/vmm/src/vcpu/mod.rs` 中的相关实现）。这个循环的结构可以概括为：

```
loop {
    检查控制信号（是否需要暂停/退出）
    调用 KVM_RUN 进入 guest 模式
    处理 VM exit 原因
    决定是否继续循环
}
```

当调用 `vcpu_fd.run()` 时，CPU 通过 `VMLAUNCH` 或 `VMRESUME` 指令（x86_64）切换到 guest 模式。此时 CPU 执行的是 guest 内核或用户态代码，host 操作系统暂时"失去"了对这个 CPU 核心的控制。直到发生以下事件之一，CPU 才会通过 VM exit 返回 host 模式：

- Guest 执行了 I/O 指令（`IN`/`OUT`）
- Guest 访问了 MMIO 地址空间
- Guest 执行了 `HLT` 指令
- 外部中断需要注入到 guest
- Guest 触发了异常条件

`KVM_RUN` 返回后，vCPU 线程需要检查共享内存区域（`kvm_run` 结构体）中的 exit reason 字段，据此决定如何处理这次 VM exit。这个共享内存区域在 vCPU 创建时通过 `mmap` 映射，避免了每次 VM exit 都需要额外的系统调用来获取退出信息。

## 5.3 CPUID 配置：向 Guest 展示虚拟 CPU

CPUID 是 x86 架构中用于查询 CPU 特性的指令。Guest 操作系统在启动时会大量使用 CPUID 来检测可用的 CPU 功能集。Firecracker 需要精心控制 CPUID 返回的信息（相关代码位于 `// src/vmm/src/cpu_config/x86_64/` 目录下），原因有两个：

第一，**安全性。** 不加过滤地暴露 host CPU 的所有特性可能泄漏 host 环境信息，也可能让 guest 使用某些 Firecracker 没有正确虚拟化的 CPU 功能，导致不可预测的行为。

第二，**可迁移性。** 快照恢复时，目标 host 的 CPU 可能与源 host 不同。通过限制 CPUID 到一个"最小公共子集"，Firecracker 提高了快照在不同硬件之间迁移的成功率。

CPUID 配置通过 `KVM_SET_CPUID2` ioctl 完成。Firecracker 先从 KVM 获取 host CPU 支持的完整 CPUID 信息，然后逐条过滤和修改，最终将一个精心裁剪的 CPUID 表设置到 vCPU 上。

## 5.4 MSR 设置：模型特定寄存器

MSR（Model Specific Registers）是 x86 CPU 中用于控制各种底层特性的寄存器集合。Firecracker 在 vCPU 初始化阶段需要配置一系列关键 MSR（参见 `// src/vmm/src/cpu_config/x86_64/` 中的 MSR 相关模块），包括但不限于：

- `MSR_IA32_SYSENTER_*` 系列：配置快速系统调用入口点
- `MSR_IA32_TSC`：时间戳计数器相关配置
- `MSR_IA32_MISC_ENABLE`：CPU 杂项功能开关

**为什么 MSR 配置需要如此谨慎？** 因为 MSR 直接影响 CPU 的行为模式。一个错误的 MSR 值可能导致 guest 内核在毫无征兆的情况下崩溃——例如，如果 `SYSENTER` 相关 MSR 未正确初始化，guest 中的每一次系统调用都会触发异常。更危险的是，某些 MSR 涉及安全特性（如 Spectre 缓解措施），配置不当可能打开侧信道攻击的窗口。

Firecracker 的 MSR 配置策略是"白名单制"——只设置已知必需的 MSR，对未知或不需要的 MSR 保持 KVM 的默认值。这种保守策略与 CPUID 过滤的哲学一脉相承：不确定的东西，宁可不碰。

## 5.5 寄存器状态管理

vCPU 的寄存器状态分为两大类，对应两组 KVM ioctl：

**通用寄存器（`KVM_GET/SET_REGS`）。** 包括 RAX、RBX、RCX、RDX 等通用目的寄存器，以及 RIP（指令指针）、RSP（栈指针）、RFLAGS（标志寄存器）等。在虚拟机首次启动时，Firecracker 将 RIP 设置为内核入口点地址，RSP 设置为初始栈顶，其余通用寄存器清零。

**特殊寄存器（`KVM_GET/SET_SREGS`）。** 包括段寄存器（CS、DS、ES 等）、控制寄存器（CR0、CR3、CR4）、中断描述符表寄存器（IDTR）和全局描述符表寄存器（GDTR）。这些寄存器决定了 CPU 的运行模式——实模式还是保护模式，是否启用分页，中断如何路由。

Firecracker 的直接内核引导要求在进入内核之前将 CPU 设置为特定状态。在 x86_64 上（参见 `// src/vmm/src/arch/x86_64/`），这意味着 CPU 需要处于 64 位长模式（long mode），分页已启用，段寄存器指向平坦（flat）的代码和数据段。这些初始状态的配置逻辑是启动流程中最底层也最关键的部分——任何一个位设置错误，guest 内核都无法正确启动。

寄存器状态的 get/set 接口在快照功能中同样扮演核心角色。创建快照时，Firecracker 通过 `KVM_GET_REGS` 和 `KVM_GET_SREGS` 读取每个 vCPU 的完整寄存器状态并序列化到磁盘。恢复快照时，通过对应的 SET ioctl 将寄存器状态精确还原。

## 5.6 VM Exit 处理

VM exit 处理是 vCPU run loop 中最复杂的部分。Firecracker 需要处理的主要退出原因包括：

**I/O exit（`VcpuExit::IoIn` / `VcpuExit::IoOut`）。** Guest 执行 `IN` 或 `OUT` 指令访问 I/O 端口时触发。Firecracker 只使用少量 I/O 端口（主要是串口 `0x3f8`），其余的 I/O 访问会被忽略或记录警告。

**MMIO exit（`VcpuExit::MmioRead` / `VcpuExit::MmioWrite`）。** Guest 访问未被 EPT 映射的物理地址时触发。Firecracker 的所有 virtio 设备都通过 MMIO 接口与 guest 通信，因此 MMIO exit 是设备交互的主要路径。设备管理器根据访问地址定位到具体设备，将读写请求转发给对应的设备模拟代码。

**HLT exit（`VcpuExit::Hlt`）。** Guest 执行 `HLT` 指令表示当前 CPU 空闲。Firecracker 将此视为 vCPU 正常暂停，等待外部中断唤醒。

**Shutdown exit。** Guest 请求关机。Firecracker 将此视为虚拟机生命周期的正常结束。

**为什么 exit 处理的性能如此关键？** 因为每一次 VM exit 都涉及 CPU 模式切换——从 guest 模式切换到 host 模式，再切换回去。这个过程的硬件开销约为几微秒，但如果 exit 频率过高（例如每秒数十万次），累积开销就会显著影响 guest 性能。Firecracker 通过 virtio 的 ioeventfd 和 irqfd 机制将部分高频 I/O 路径下沉到内核中处理，避免了不必要的用户态 VM exit。

## 5.7 x86_64 与 aarch64 的差异

Firecracker 同时支持 x86_64 和 aarch64 两种架构，架构相关代码分别位于 `// src/vmm/src/arch/x86_64/` 和 `// src/vmm/src/arch/aarch64/`。两种架构的 vCPU 模型存在根本性差异：

在 x86_64 上，中断控制器（LAPIC + IOAPIC）由 KVM 在内核中模拟，Firecracker 只需要通过 `KVM_CREATE_IRQCHIP` 创建即可。而在 aarch64 上，GIC（Generic Interrupt Controller）的配置更加复杂，需要 Firecracker 参与更多的设置工作。

CPUID 和 MSR 是 x86 特有的概念，aarch64 上不存在。取而代之的是，aarch64 通过设备树（Device Tree Blob）向 guest 描述硬件拓扑，通过系统寄存器（如 `MPIDR_EL1`）暴露 CPU 信息。

启动协议也不同。x86_64 使用 Linux 的 boot protocol，需要设置特定的内存布局和寄存器状态。aarch64 则遵循 ARM 的启动规范，内核入口点的约定和寄存器初始状态与 x86_64 完全不同。

Firecracker 通过 Rust 的条件编译（`#[cfg(target_arch = "x86_64")]`）优雅地隔离了这些架构差异，确保共享代码最大化的同时保持各架构实现的清晰独立。

## 本章小结

vCPU 模型是 Firecracker 中硬件虚拟化与软件模拟的交汇点。从 `VcpuHandle` 的线程管理，到 run loop 的执行调度，从 CPUID/MSR 的精细配置，到 VM exit 的高效处理，每一个环节都直接影响虚拟机的性能和安全性。理解了 vCPU 模型的工作原理，我们就掌握了 microVM 最核心的运行时机制——guest 代码究竟是如何在一个被严格隔离的环境中全速执行的。
