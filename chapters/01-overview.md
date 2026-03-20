# 第 1 章 项目概览与设计哲学

> "Perfection is achieved, not when there is nothing more to add, but when there is nothing left to take away."
> —— Antoine de Saint-Exupery

## 1.1 Firecracker 的诞生

2018 年，AWS 在 re:Invent 大会上正式开源了 Firecracker。这个项目并非凭空而来——它脱胎于 AWS Lambda 和 AWS Fargate 的生产实践。在此之前，AWS 内部一直在寻找一种既能提供虚拟机级别隔离、又能达到容器级别启动速度的轻量化方案。传统的 QEMU/KVM 组合虽然功能强大，但其庞大的代码体量和攻击面让安全团队夜不能寐。Firecracker 就是在这样的背景下应运而生的。

Firecracker 的名字本身就暗示了它的设计意图——像鞭炮一样快速点燃、迅速完成使命。它的核心代码库用 Rust 编写，从第一天起就以安全性和极简主义为最高原则。

### 核心流程

Firecracker 在整个系统栈中的位置及请求处理流程如下：

```
用户 / 编排系统（如 Lambda Control Plane）
       |
       | HTTP PUT/GET（Unix Socket）
       v
+------------------+
|   API Server     |  // src/api_server/
|  (REST over UDS) |
+--------+---------+
         |
         | VmmAction 枚举（通道传递）
         v
+------------------+
|      VMM         |  // src/vmm/
| (Vmm 结构体)     |
+--------+---------+
         |
         | ioctl（KVM_RUN / KVM_SET_*）
         v
+------------------+
|    KVM 内核模块   |  /dev/kvm
| (硬件虚拟化抽象)  |
+--------+---------+
         |
         | VT-x / AMD-V 硬件指令
         v
+------------------+
|   Guest Kernel   |
|   + 用户工作负载  |
+------------------+
```

### 设计取舍

**为什么选择 microVM 而非容器或传统虚拟机？** 这是 Firecracker 最根本的架构决策。容器（如 Docker）共享宿主机内核，隔离依赖 namespace 和 cgroup 等软件机制，一个内核漏洞就可能击穿所有租户边界——这对多租户 serverless 平台来说风险不可接受。传统虚拟机（如 QEMU/KVM）提供了硬件级隔离，但 QEMU 超过两百万行的代码意味着巨大的攻击面和缓慢的启动速度。microVM 方案取两者之长：利用 KVM 硬件虚拟化获得与传统 VM 同等的隔离强度，同时通过极简设备模型将攻击面和启动开销压缩到接近容器的水平。代价是放弃通用性——不支持任意 guest OS、不支持 GPU 直通、不支持热迁移——但这些在 serverless 场景中本就不需要。

## 1.2 什么是 microVM

microVM（微虚拟机）是一种精简到极致的虚拟机实现。与传统虚拟机不同，microVM 只模拟运行工作负载所必需的最少设备集合：一个串口控制台、一个基于 virtio 的网络设备、一个基于 virtio 的块设备，以及一个可编程的定时器。没有 USB 控制器，没有 GPU 模拟，没有 PCI 总线枚举——所有那些传统虚拟机为了"通用性"而背负的沉重行囊，在 microVM 的世界里统统被抛弃了。

这种极简设计带来了三个直接好处：启动时间可以压缩到 125 毫秒以内，每个 microVM 的内存开销低至 5MB 左右，而攻击面则缩小了一个数量级。在 Firecracker 的实现中，整个 VMM（Virtual Machine Monitor）进程就是一个单一的用户态程序（参见 `// src/firecracker/src/main.rs`），没有守护进程，没有复杂的进程间协调。

## 1.3 设计目标：安全、速度、极简

Firecracker 的设计目标可以归结为三个关键词：

**安全第一。** Firecracker 采用了纵深防御策略。最外层是 jailer 组件（`// src/jailer/`），它通过 Linux namespace、cgroup、seccomp 过滤器将 VMM 进程锁定在一个极度受限的沙箱中。中间层是 Rust 语言本身提供的内存安全保障——没有 buffer overflow，没有 use-after-free。最内层则是 KVM 硬件虚拟化提供的 CPU 和内存隔离。这三层防线中的任何一层被突破，攻击者仍然面对另外两层屏障。

**极速启动。** Firecracker 不需要 BIOS/UEFI 引导流程，它直接将 Linux 内核加载到 guest 内存的预定地址，设置好引导参数，然后直接跳转到内核入口点。这种 "直接内核引导"（direct kernel boot）方式绕过了传统虚拟机漫长的固件初始化过程。

**最小占用。** 每一行代码都必须证明自己存在的必要性。Firecracker 团队甚至在 `// src/vmm/src/device_manager/` 中对设备管理器做了极致裁剪——只保留了 virtio-net、virtio-block、virtio-vsock 和串口设备的支持。

## 1.4 与 QEMU 和 Cloud-Hypervisor 的比较

QEMU 是虚拟化领域的瑞士军刀，支持数十种 CPU 架构和数百种设备模拟，代码量超过两百万行。这种"大而全"的设计使其不可避免地拥有巨大的攻击面。近年来 QEMU 不断被报告安全漏洞，其中不乏可以从 guest 逃逸到 host 的高危漏洞。

Cloud-Hypervisor 是另一个用 Rust 编写的 VMM 项目，与 Firecracker 有相似的设计理念，但定位不同。Cloud-Hypervisor 面向更通用的云工作负载，支持 VFIO 设备直通、热迁移、可变数量的 vCPU 等高级特性。Firecracker 则刻意不支持这些功能——因为 serverless 场景根本不需要它们。

这就是 Firecracker "less is more" 哲学的精髓：**不是做不到，而是选择不做。** 每一个不实现的功能，都意味着更少的代码、更小的攻击面、更低的维护成本。这种克制在开源项目中极为罕见，也正是 Firecracker 最值得学习的设计智慧。

### 设计取舍

**为什么选择直接内核引导而非 BIOS/UEFI？** 传统 VM 的固件引导流程（POST → BIOS → Bootloader → Kernel）通常耗时数秒，这对于需要在 125ms 内启动的 serverless 场景完全不可接受。Firecracker 选择绕过固件层，由 VMM 直接将内核 ELF 镜像加载到 guest 内存的固定地址（x86_64 上为 `0x200000`），手动构造 `boot_params` 结构，然后将 vCPU 的 RIP 指向内核入口点。代价是只能启动 Linux 内核（且必须是支持 PVH 或 Linux boot protocol 的内核），不能运行 Windows 或其他需要固件引导的操作系统。但对于 Lambda 和容器场景，这个限制完全可以接受。

**为什么只支持最小设备集？** 每多模拟一种设备，就多一个潜在的攻击入口。Firecracker 只保留 virtio-net、virtio-block、virtio-vsock 和串口这四类设备，这不仅减少了代码量，更将设备模拟层的攻击面限制在经过充分审计的 virtio 协议实现范围内。QEMU 历史上大量 CVE 都来自于边缘设备的模拟代码（如 USB、显卡），Firecracker 通过根本不实现这些设备来消除整个攻击类别。

## 1.5 威胁模型概览

Firecracker 的威胁模型文档（`// docs/threat_model.md`）明确定义了信任边界：guest 操作系统及其中运行的所有代码都被视为不可信的。VMM 需要防御来自 guest 的所有恶意输入，包括精心构造的 I/O 请求、异常的 KVM exit、以及试图探测 VMM 实现缺陷的各种边界条件。

为什么要如此偏执？因为在多租户 serverless 平台上，一个客户的 Lambda 函数和另一个客户的函数可能运行在同一台物理机上。如果隔离被打破，后果不堪设想。Firecracker 的安全承诺不是"我们尽力而为"，而是"即使 guest 内核被完全攻陷，host 也必须安然无恙"。

## 1.6 目标用例

Firecracker 有两个核心使用场景：

**Serverless 计算。** AWS Lambda 每天处理数万亿次函数调用，每一次调用都在独立的 Firecracker microVM 中执行。快速启动、低内存开销、强隔离——这三个特性恰好完美匹配 serverless 的需求。

**安全容器运行时。** 传统容器共享宿主机内核，一个内核漏洞就可能影响所有容器。通过将每个容器（或 Pod）运行在独立的 microVM 中，Firecracker 提供了硬件级别的隔离，同时保持了接近容器的性能特征。Kata Containers 项目就支持以 Firecracker 作为底层 hypervisor。

## 本章小结

Firecracker 是一个为特定场景量身定制的 microVM 方案。它的设计哲学不是追求功能的完备性，而是在安全、速度和极简之间找到了一个精准的平衡点。理解这个设计哲学，是深入阅读 Firecracker 源码的前提——当你在代码中看到某个功能"缺失"时，那往往不是遗漏，而是一个经过深思熟虑的设计决策。在接下来的章节中，我们将逐层剥开 Firecracker 的源码，看看这种极简哲学是如何在每一个模块中得到贯彻的。
