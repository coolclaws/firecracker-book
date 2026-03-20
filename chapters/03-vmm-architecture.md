# 第 3 章 VMM 架构核心抽象

> "Good architecture is not about building everything from scratch. It's about knowing which abstractions to keep and which to throw away."
> —— 改编自 Martin Fowler

## 3.1 Vmm 结构体：系统的神经中枢

打开 `// src/vmm/src/lib.rs`，你会找到整个 Firecracker 最重要的数据结构——`Vmm` 结构体。它是虚拟机所有运行时状态的持有者，也是各个子系统交互的枢纽。

`Vmm` 结构体持有以下关键字段：guest 内存的映射（通过 `vm-memory` crate 的 `GuestMemoryMmap`）、KVM 虚拟机文件描述符（`VmFd`）、vCPU 句柄列表、设备管理器、以及事件循环所需的 epoll 上下文。每一个字段都代表着虚拟机运行时的一个核心维度。

**为什么选择将所有状态集中在一个结构体中？** 这看似违反了"关注点分离"的原则，但在 VMM 的语境下却是合理的。虚拟机是一个高度耦合的系统——vCPU 需要访问内存，设备需要触发中断，快照需要遍历所有状态。将这些组件分散到独立的对象中会引入大量的跨对象引用和生命周期管理问题。Rust 的所有权模型在这里尤其苛刻：如果 `Vmm` 不集中持有这些资源，就需要大量的 `Arc<Mutex<>>` 来实现共享访问，这不仅增加了运行时开销，还容易引发死锁。

集中式设计的另一个好处是快照实现变得直截了当——序列化一个 `Vmm` 结构体，就等于序列化了虚拟机的完整状态。

### 核心流程

VMM 初始化及事件处理的核心流程如下：

```
main()
  |
  +---> Kvm::new()                    // 打开 /dev/kvm
  |       +---> kvm.create_vm()       // 获得 VmFd
  |
  +---> GuestMemoryMmap::from_ranges()  // mmap 分配 guest 内存
  |       +---> vm_fd.set_user_memory_region()  // 注册到 KVM EPT
  |
  +---> configure_system()            // 设置 boot_params、内核命令行
  |       +---> load_kernel()         // 将内核加载到 guest 内存
  |
  +---> MMIODeviceManager::new()      // 创建设备管理器
  |       +---> register_virtio_device()  // 逐一注册 net/block/vsock
  |       +---> vm_fd.register_ioevent()  // 关联 EventFd 与 MMIO 地址
  |
  +---> create_vcpus()                // 创建 VcpuFd 并配置寄存器
  |       +---> vm_fd.create_vcpu(i)
  |       +---> vcpu_fd.set_sregs() / set_regs() / set_cpuid2()
  |
  +---> 组装 Vmm 结构体
  |
  +---> 启动 vCPU 线程
          +---> vcpu_fd.run()  ──────────────────┐
                                                  |
          ┌───────────────────────────────────────┘
          |   KVM_RUN 循环（vCPU 线程）
          v
   VmExit 分发:
     +---> MmioRead/MmioWrite  +---> MMIODeviceManager 分发到具体设备
     +---> IoIn/IoOut           +---> 串口等 PIO 设备处理
     +---> Hlt                  +---> 空闲等待
     +---> Shutdown             +---> 通知主线程退出
```

### 模块关系

`Vmm` 结构体内部各子系统的协作关系：

```
                         +------------------+
                         |       Vmm        |
                         +--------+---------+
                                  |
          +-----------+-----------+-----------+-----------+
          |           |           |           |           |
          v           v           v           v           v
   +-----------+ +-----------+ +-----------+ +---------+ +-----------+
   | VmFd      | | GuestMem  | | VcpuHandle| | MMIO    | | EventFd   |
   | (KVM VM)  | | (vm-mem)  | | 列表      | | Device  | | (epoll    |
   |           | |           | |           | | Manager | |  事件源)  |
   +-----------+ +-----------+ +-----+-----+ +----+----+ +-----------+
                                     |             |
                              +------+------+      |
                              |             |      |
                              v             v      v
                         +---------+  +---------+  +---------+
                         | VcpuFd  |  | EventFd |  | Virtio  |
                         | (每线程 |  | (退出   |  | 设备实例|
                         |  独立)  |  |  信号)  |  | net/blk |
                         +---------+  +---------+  +---------+
```

## 3.2 VmmEventsObserver：事件通知机制

`VmmEventsObserver` trait（定义在 `// src/vmm/src/lib.rs` 中）是一个观察者模式的实现，用于将 VMM 内部事件通知给外部组件。当虚拟机生命周期中发生重要事件时——例如 VMM 初始化完成、即将退出——观察者会被依次通知。

这个 trait 的方法签名中有一个细节值得关注：通知方法接收的是 `&mut self`，而非 `&self`。这意味着观察者可以在收到通知时修改自身状态，例如关闭文件描述符或更新统计计数器。这个设计决策反映了 Firecracker 务实的一面——在简洁性和灵活性之间做了恰当的权衡。

**为什么需要 observer 而不是直接回调？** 因为 VMM 的生命周期事件可能需要通知多个利益相关方，而且通知的时机和顺序很重要。通过将事件观察抽象为 trait，不同的使用场景可以提供不同的实现。例如，jailer 场景和直接运行场景对 VMM 退出事件的处理逻辑完全不同。

## 3.3 Builder 模式：虚拟机的装配流水线

Firecracker 使用 builder 模式来构造虚拟机实例，相关代码集中在 `// src/vmm/src/builder.rs`。这个模块包含了从零开始组装一个可运行 microVM 所需的全部逻辑。

构建过程遵循严格的顺序：

第一步，创建 KVM 虚拟机实例并分配 guest 内存。内存布局在此阶段确定——内核加载地址、引导参数地址、MMIO 设备地址空间，每一个区域都有预定义的起始位置和大小。

第二步，配置 vCPU。这包括设置 CPUID 信息、模型特定寄存器（MSR）、以及架构相关的初始寄存器状态。在 x86_64 上，还需要配置中断控制器（LAPIC 和 IOAPIC）。

第三步，逐一创建和注册 I/O 设备。设备管理器（`// src/vmm/src/device_manager/`）为每个 virtio 设备分配 MMIO 地址空间和中断号，确保没有资源冲突。

第四步，加载 guest 内核镜像到内存中的指定位置，设置引导参数（boot parameters），配置内核命令行。

第五步，将所有组件装配到 `Vmm` 结构体中，启动 vCPU 线程，虚拟机开始运行。

**为什么不使用真正的 Builder pattern（即链式调用 `.with_xxx().build()`）？** 因为虚拟机构建的各步骤之间存在强依赖关系——内存必须在 vCPU 之前分配，中断控制器必须在设备注册之前创建。链式 Builder 模式更适合步骤之间相互独立的场景。Firecracker 的"builder"更像是一个工厂方法（factory method），它封装了复杂的构建顺序，但并不暴露中间状态。

### 设计取舍

**为什么用顺序化 builder 而非链式 Builder pattern？** Rust 生态中常见的 Builder pattern（如 `VmConfig::new().with_memory(m).with_vcpus(n).build()`）假设各配置项彼此独立，可以任意顺序设置。但 VMM 的构建过程有严格的因果依赖：KVM VM 必须先于内存注册，内存必须先于内核加载，中断控制器必须先于设备注册。如果使用链式 Builder，要么在 `build()` 时做全量校验（错误信息晦涩），要么引入复杂的类型状态（type-state）机制来在编译期强制顺序。Firecracker 选择了最直接的方案：一个顺序执行的工厂函数 `build_microvm_for_boot()`，每一步的前置条件由代码顺序天然保证，可读性和可调试性都优于花哨的类型体操。

**为什么将所有状态集中在 `Vmm` 结构体而非拆分为多个 Manager 对象？** 拆分后各 Manager 需要相互引用——`DeviceManager` 需要访问 `GuestMemory` 做 DMA，`VcpuManager` 需要访问 `VmFd` 注入中断。在 Rust 的所有权模型下，这意味着大量 `Arc<Mutex<>>`，不仅有运行时开销，还引入死锁风险。集中式设计让 `Vmm` 作为唯一 owner，各子系统通过 `&mut self` 方法依次访问，编译器保证不会出现数据竞争。快照实现也因此简化为"序列化一个结构体"。

## 3.4 设备管理的哲学

`// src/vmm/src/device_manager/mmio.rs` 中的 `MMIODeviceManager` 负责管理所有 MMIO 映射设备的地址空间分配和生命周期。它维护着一个设备注册表，记录每个设备的地址范围、中断号和类型信息。

Firecracker 对设备管理采用了"静态分配"策略——每种设备类型的 MMIO 地址空间在编译时就已经确定，运行时不会动态调整。这与传统 VMM 中复杂的 PCI 设备枚举和资源协商形成了鲜明对比。

**为什么选择静态分配？** 因为 microVM 的设备集合是固定的、已知的。没有热插拔需求，没有设备发现协议，所有设备在 VM 启动时一次性配置完毕。静态分配消除了一整类运行时错误——地址冲突、资源耗尽、设备枚举失败——这些在传统 VMM 中都是常见的 bug 来源。

设备管理器还承担了另一个重要职责：当 vCPU 因为 guest 访问 MMIO 地址而触发 VM exit 时，设备管理器负责根据地址定位到具体设备，将 I/O 请求分发给对应的设备模拟代码处理。这个分发逻辑的性能至关重要，因为 MMIO 访问是 guest 与设备交互的主要通道。

### 设计取舍

**为什么选择静态 MMIO 地址分配而非 PCI 设备枚举？** PCI 总线提供了灵活的设备发现和资源协商机制，但这种灵活性的代价是复杂性——PCI 配置空间解析、BAR（Base Address Register）分配、中断路由表维护，仅这些就需要数千行代码，且每一行都是潜在的攻击面。Firecracker 的设备集合在编译时已知（最多若干个 virtio 设备加一个串口），为每种设备类型硬编码 MMIO 地址范围（起始地址按固定步长递增）完全够用。这消除了设备枚举逻辑，使 guest 内核可以通过设备树（device tree）直接获知设备地址，无需运行时探测。代价是无法支持热插拔和动态设备数量变化——但在 microVM 场景中，设备在启动时确定、运行期间不变。

## 3.5 资源管理生命周期

Firecracker 中的资源管理遵循 Rust 的 RAII（Resource Acquisition Is Initialization）原则。KVM 文件描述符、内存映射、设备资源——所有这些都由 Rust 的所有权系统自动管理，当 `Vmm` 结构体被 drop 时，所有资源会按照依赖关系的逆序自动释放。

但有一个微妙的例外：vCPU 线程。vCPU 运行在独立的线程中，不能简单地通过 drop 来终止。`Vmm` 需要先向 vCPU 线程发送退出信号，等待线程完成清理后加入（join），然后才能释放其余资源。这个顺序不能搞错——如果先释放了 guest 内存而 vCPU 线程还在运行，就会导致未定义行为。

`// src/vmm/src/vcpu/mod.rs` 中的 `VcpuHandle` 封装了这种生命周期管理，它持有线程的 `JoinHandle` 和一个用于通信的 `EventFd`。当 `VcpuHandle` 被 drop 时，它会确保 vCPU 线程被优雅地关闭。

## 3.6 错误处理模式

Firecracker 的错误处理体现了 Rust 社区的最佳实践。VMM 模块定义了丰富的错误枚举类型（`// src/vmm/src/lib.rs` 中的 `VmmError` 等），每一种错误变体都携带了足够的上下文信息。

一个值得注意的设计选择是：Firecracker 几乎不使用 `unwrap()` 或 `expect()`。在 VMM 这种安全关键代码中，panic 意味着虚拟机突然死亡，这对于运行着客户工作负载的生产环境是不可接受的。错误被逐层向上传播，最终由顶层代码决定是否可以恢复或必须优雅退出。

**为什么不使用 `anyhow` 这样的通用错误库？** 因为 Firecracker 需要对错误进行精确的模式匹配和分类处理。不同的错误可能触发不同的恢复策略：有些错误意味着某个设备配置无效可以拒绝请求，有些错误则意味着 VMM 内部状态不一致必须终止。通用错误类型会抹杀这种区分能力。

## 本章小结

VMM 的架构设计围绕一个核心理念展开：用最简单的抽象支撑最关键的功能。`Vmm` 结构体的集中式设计、builder 模式的顺序化构建、设备管理的静态分配、以及严格的资源生命周期管理，每一个选择背后都有明确的工程理由。理解了这些架构决策，我们就能理解后续章节中每一个子系统为什么是"那样"而不是"这样"实现的。
