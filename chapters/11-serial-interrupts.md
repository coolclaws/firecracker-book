# 第 11 章 串口与中断控制器

> "The cheapest, most reliable components are the ones that aren't there." —— Gordon Bell

在虚拟化的世界里，设备模拟是性能开销的主要来源之一。Firecracker 选择只模拟最少量的遗留设备，而串口（Serial）和中断控制器正是这"最少量"中不可或缺的部分。串口为 guest 提供了最基本的控制台输出能力，中断控制器则是 guest 内核与外部设备通信的神经系统。本章将深入分析这两个关键子系统的实现。

## 11.1 UART 16550A 串口模拟

串口是计算机历史上最古老、最简单的通信接口之一。Firecracker 选择模拟 UART 16550A 这一经典芯片，原因很直接：Linux 内核对它的支持已经极其成熟，无需任何额外驱动即可使用。

串口模拟的核心实现位于 `// src/vmm/src/devices/legacy/serial.rs`。整个模拟器本质上是一个状态机，维护着 16550A 芯片的关键寄存器：

- **THR**（Transmit Holding Register）：guest 写入此寄存器时，数据被发送到 host 端
- **RBR**（Receiver Buffer Register）：host 向 guest 发送数据时，数据暂存于此
- **IER**（Interrupt Enable Register）：控制哪些事件可以触发中断
- **LSR**（Line Status Register）：指示当前线路状态，如发送缓冲区是否为空
- **IIR**（Interrupt Identification Register）：标识当前待处理的中断类型

当 guest 内核通过 `printk` 输出日志时，数据流经过以下路径：guest 内核写入串口 I/O 端口（x86 上为 `0x3F8`），触发 VM Exit，KVM 将控制权交还给 Firecracker，Firecracker 的串口模拟器处理这次写操作，将字节数据写入与 host 端关联的文件描述符（通常是 stdout 或日志文件）。这个过程虽然涉及多次上下文切换，但由于串口本身就是低速设备，性能影响可以忽略。

为什么不直接使用 virtio-console？答案是启动阶段的需求。在 guest 内核加载 virtio 驱动之前，只有遗留设备可用。串口在内核启动的最早期就能工作，这对于调试 boot 问题至关重要。Firecracker 同时支持串口和 virtio-console，前者用于早期启动输出，后者用于运行时高性能通信。

## 11.2 x86 中断控制器：从 PIC 到 IOAPIC

中断是硬件通知 CPU 有事件需要处理的机制。在 x86 架构上，中断控制器的演化经历了三个阶段：i8259 PIC、IOAPIC 和 LAPIC。Firecracker 需要理解并配合这三者的工作。

**i8259 PIC** 是最古老的中断控制器，每片支持 8 条 IRQ 线，两片级联支持 15 个中断源。KVM 在内核态模拟了 PIC 的基本行为，Firecracker 通过 `KVM_CREATE_IRQCHIP` ioctl 让 KVM 创建虚拟 PIC。虽然现代系统主要使用 APIC，但 PIC 在引导阶段仍被 Linux 内核使用，这就是为什么 Firecracker 不能省略它。

**IOAPIC**（I/O Advanced Programmable Interrupt Controller）是 PIC 的现代替代品，支持 24 条中断线和更灵活的路由策略。IOAPIC 的配置位于 `// src/vmm/src/vstate/vm.rs` 中的 VM 初始化流程。Firecracker 通过 KVM 的 `KVM_SET_GSI_ROUTING` 接口配置 IRQ 路由表，将设备中断映射到 guest 的中断向量。

**LAPIC**（Local APIC）位于每个 vCPU 内部，负责接收来自 IOAPIC 的中断并通知对应的 vCPU。KVM 完全在内核态模拟了 LAPIC，Firecracker 无需额外处理。

IRQ 路由的核心设计思想是：将中断从设备（如串口 IRQ4）映射到 guest 可见的中断向量。路由表定义在 `// src/vmm/src/builder.rs` 的 microVM 构建流程中。Firecracker 为每个遗留设备分配固定的 IRQ 号，为 virtio 设备分配动态 IRQ 号，然后通过 KVM 的 GSI routing 机制统一管理。

## 11.3 ARM 中断控制器：GICv2/GICv3

在 aarch64 架构上，中断控制器是 ARM 定义的 GIC（Generic Interrupt Controller）。Firecracker 支持 GICv2 和 GICv3 两个版本，实现位于 `// src/vmm/src/vstate/vm.rs` 以及相关的 arch 模块。

GICv2 由 Distributor 和 CPU Interface 两部分组成。Distributor 负责接收所有中断源并将它们分发到合适的 CPU Interface，CPU Interface 再通知对应的 vCPU。GICv3 引入了 Redistributor 层，每个 CPU 有自己的 Redistributor，改善了多核场景下的中断分发效率。

Firecracker 通过 KVM 的 `KVM_CREATE_DEVICE` 接口创建 GIC 设备，并配置其 MMIO 地址。与 x86 不同，ARM 上的中断控制器地址映射需要在 Device Tree 中声明，guest 内核通过解析 Device Tree 来发现 GIC 的存在。这种设计体现了 ARM 平台的哲学：设备发现应该是数据驱动的，而非硬编码的。

选择 GICv2 还是 GICv3 取决于 host 硬件的支持情况。Firecracker 的初始化代码会先尝试创建 GICv3，如果失败则回退到 GICv2。这种 fallback 策略保证了在不同代际的 ARM 硬件上都能正常工作。

### 设计取舍

同时支持 x86（PIC/IOAPIC/LAPIC）和 ARM（GICv2/GICv3）两套中断模型是 Firecracker 跨平台战略的必然代价。替代方案是只支持一种架构以简化代码，或者构建一个统一的中断抽象层屏蔽差异。Firecracker 选择了中间路线：将中断控制器的创建和配置逻辑放入各自的 arch 模块（`x86_64` 和 `aarch64`），通过 KVM 接口将具体的中断模拟卸载到内核态，而在设备层使用统一的 irqfd 机制注入中断。这样做的好处是：设备模拟代码（virtio-net、virtio-block 等）完全不感知底层中断架构，只需向 irqfd 写入即可；架构差异被限制在启动阶段的初始化代码中，运行时路径保持统一。将 PIC 和 APIC 的模拟委托给 KVM 而非自行实现，也大幅减少了用户态代码量和潜在 bug。

## 11.4 中断触发：从设备到 Guest

### 核心流程

```
设备事件发生 (如: 网络包到达、块 I/O 完成)
        |
        v
+------------------------+
| Firecracker 设备模拟   |  用户态处理完成后
| (virtio handler)       |  需要通知 Guest
+------------------------+
        |
        | write() to irqfd (eventfd)
        v
+------------------------+
| KVM 内核模块           |  通过 eventfd 感知中断请求
+------------------------+
        |
        +---> x86 路径                    +---> ARM 路径
        |                                 |
        v                                 v
+----------------+                 +----------------+
| IOAPIC         |                 | GIC            |
| 查询 GSI 路由表 |                 | Distributor    |
| 映射到中断向量  |                 | 分发到目标 CPU  |
+----------------+                 +----------------+
        |                                 |
        v                                 v
+----------------+                 +----------------+
| LAPIC          |                 | Redistributor  |
| (目标 vCPU)    |                 | (GICv3) 或     |
+----------------+                 | CPU Interface  |
        |                          | (GICv2)        |
        v                          +----------------+
+----------------+                        |
| vCPU 在下次    |                        v
| KVM_RUN 进入   | <----- 同样 -----+  vCPU 响应
| Guest 时响应   |                     中断
+----------------+
```

### 模块关系

```
+-------------------------------------------------------+
|                    中断控制器层级                        |
+-------------------------------------------------------+
|                                                       |
|   x86_64 架构                    aarch64 架构          |
|   +-----------+                  +-------------+      |
|   | i8259 PIC |  遗留设备        | GICv3        |     |
|   | (KVM 模拟) |  引导阶段使用    | +-----------+ |     |
|   +-----------+                  | |Distributor| |     |
|        |                         | +-----------+ |     |
|        v                         | |Redistrib. | |     |
|   +-----------+                  | |(per-CPU)  | |     |
|   | IOAPIC    |  现代中断路由     | +-----------+ |     |
|   | 24 条 IRQ |  GSI routing     +-------------+      |
|   +-----------+                         |              |
|        |                         +-------------+      |
|        v                         | GICv2        |     |
|   +-----------+                  | (fallback)   |     |
|   | LAPIC     |                  +-------------+      |
|   | (per-vCPU)|                                       |
|   +-----------+                                       |
|                                                       |
+-------------------------------------------------------+
|  irqfd (eventfd) — 用户态到内核态的异步中断注入通道      |
+-------------------------------------------------------+
```

当一个 virtio 设备需要通知 guest 时（例如网络包到达），完整的中断传递链如下：

1. Firecracker 的设备模拟代码调用 `irqfd` 的 write 操作
2. KVM 通过 eventfd 机制感知到中断请求
3. KVM 将中断注入到虚拟中断控制器（IOAPIC 或 GIC）
4. 中断控制器将中断路由到目标 vCPU 的 LAPIC 或 CPU Interface
5. vCPU 在下次进入 guest 模式时响应中断

`irqfd` 是这个流程中的关键优化。它允许 Firecracker 在用户态通过简单的 eventfd write 操作触发中断注入，而无需执行额外的 ioctl 系统调用。这个机制在 `// src/vmm/src/devices/virtio/` 下的各设备实现中被广泛使用。

为什么要用 irqfd 而不是 `KVM_INTERRUPT` ioctl？因为 irqfd 是异步的，不需要等待 vCPU 线程的配合。在 Firecracker 的多线程模型中，设备处理和 vCPU 执行在不同的线程上进行，irqfd 使得中断注入可以完全解耦，避免了线程间同步的开销。

## 11.5 最小化设备模拟的哲学

Firecracker 只模拟了串口、i8259 PIC（通过 KVM）、RTC（x86）和 keyboard controller（x86，仅用于复位）这几个遗留设备。所有高性能 I/O 都通过 virtio 完成。这种极简主义的设备模拟策略是经过深思熟虑的。

每多模拟一个设备，就多了一个潜在的攻击面。QEMU 历史上大量的 CVE 都来自设备模拟代码中的 bug。Firecracker 通过将设备模拟代码压缩到最小，从根本上减少了安全风险。同时，更少的设备意味着更少的 VM Exit，更短的启动时间，以及更小的内存占用。

## 本章小结

本章分析了 Firecracker 中串口和中断控制器的实现。串口模拟为 guest 提供了最基本的控制台能力，中断控制器（x86 上的 PIC/IOAPIC/LAPIC，ARM 上的 GIC）构成了设备与 CPU 之间的通信桥梁。irqfd 机制实现了高效的异步中断注入。Firecracker 坚持最小化设备模拟的策略，只保留引导和基本调试所必需的遗留设备，将安全性和性能放在功能丰富性之上。这种"少即是多"的设计哲学，正是 Firecracker 能在无服务器场景中实现毫秒级启动和极小攻击面的关键原因。
