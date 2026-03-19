# 第 19 章 威胁模型与安全设计

> "If you know the enemy and know yourself, you need not fear the result of a hundred battles." —— Sun Tzu

安全不是功能的附属品，而是 Firecracker 存在的根本理由。AWS Lambda 和 Fargate 需要在同一物理主机上运行来自不同租户的代码，任何隔离失败都可能导致数据泄露或权限提升。本章将系统性地剖析 Firecracker 的威胁模型和安全设计哲学。

## Firecracker 威胁模型文档

Firecracker 项目维护了一份公开的威胁模型文档（`// docs/threat_model.md`），这在开源项目中并不常见。这份文档明确定义了系统的安全目标、信任假设和已知局限性，为安全研究者和运维人员提供了清晰的安全基线。

威胁模型的核心安全目标可以概括为：**阻止 guest 虚拟机访问属于 host 或其他 guest 的资源**。这个看似简单的目标背后隐藏着巨大的工程复杂性，因为 VMM 作为 host 上的用户态进程，天然拥有对 host 资源的访问能力——而 guest 的每一次 I/O 操作都需要 VMM 代为执行。

为什么要公开威胁模型？因为安全领域的 Kerckhoffs 原则告诉我们：系统的安全性不应依赖于设计的保密性。公开的威胁模型邀请外部审查，有助于发现被内部团队忽视的盲区。

## 信任边界

Firecracker 定义了三个明确的信任域和它们之间的边界：

**Host 域**是最高信任级别，包括 host 操作系统内核和 hypervisor（KVM）。Firecracker 假设 host 内核是可信的——如果 host 内核被攻破，所有安全保证都不再成立。这一假设是务实的，因为保护 host 内核是操作系统安全的范畴，不在 VMM 的职责范围内。

**VMM 域**是中等信任级别，包括 Firecracker VMM 进程本身。VMM 被视为潜在的攻击目标——如果 guest 利用 KVM 漏洞或设备模拟缺陷获得了 VMM 进程内的代码执行能力，seccomp 和 jailer 仍应阻止其进一步扩展。

**Guest 域**是最低信任级别（实际上是不信任）。Guest 虚拟机内运行的代码被视为完全不可信的，可能是恶意的。所有从 guest 到 VMM 的交互都必须经过严格的输入验证。

**API 域**的信任级别介于 host 和 VMM 之间。API 调用者被认为是经过身份验证的操作者（通过 Unix socket 的文件系统权限控制），但 API 输入仍需严格校验以防注入攻击。

这种层次化的信任模型决定了每个边界上的数据流方向和验证强度。从低信任域到高信任域的数据流必须经过最严格的验证——这就是 Firecracker 中 virtio 设备模拟代码对 guest 提供的描述符进行边界检查的根本原因（`// src/vmm/src/devices/virtio/`）。

## 攻击面分析

攻击面是攻击者可能与系统交互的所有入口点的总和。Firecracker 的攻击面主要包括：

**KVM 接口**：guest 通过特权指令和内存映射与 KVM 交互。KVM 的代码量虽然远小于完整虚拟化方案（如 QEMU），但仍然是最关键的攻击面。Firecracker 通过仅启用必需的 KVM 功能来缩减这一攻击面。

**设备模拟**：这是 VMM 用户态代码中最大的攻击面。每个模拟设备都处理来自 guest 的输入，任何解析错误都可能被利用。Firecracker 采用最小设备集策略——只实现 virtio-net、virtio-block、virtio-vsock、串口和键盘控制器，总共不到十个设备，而 QEMU 模拟数百个设备。这种精简不仅减少了代码量，更从根本上缩小了攻击面。

**API 接口**：HTTP API 通过 Unix Domain Socket 暴露，文件系统权限限制了访问者范围。API 解析器对所有输入进行严格的类型检查和范围验证。

**vsock 通信**：host 与 guest 之间的 vsock 通道是双向攻击面，Firecracker 确保 vsock 数据处理不会导致缓冲区溢出或资源耗尽。

## 防御层次

Firecracker 的安全不依赖单一防御机制，而是构建了多层重叠的防御体系（`// src/jailer/`、`// src/seccompiler/`）：

**第一层：KVM 硬件隔离**。Intel VT-x 和 ARM VHE 提供的硬件虚拟化扩展是最基础的隔离机制。guest 代码在受限的 CPU 模式下运行，无法直接访问 host 内存或 I/O 设备。EPT/Stage-2 页表确保 guest 的物理地址空间与 host 完全隔离。

**第二层：最小化 VMM**。Firecracker 的代码量约为 QEMU 的 1/100，这意味着潜在的漏洞数量也相应减少。代码使用 Rust 编写，消除了内存安全类漏洞（缓冲区溢出、UAF、双重释放等），这类漏洞在 C/C++ 虚拟化项目中占据了已知 CVE 的大部分。

**第三层：jailer 沙箱**。jailer 将 VMM 进程限制在独立的 PID/mount/network namespace 中，即使 VMM 被攻破，攻击者也无法看到 host 上的其他进程或文件系统。cgroup 限制防止资源耗尽攻击。

**第四层：seccomp 过滤器**。如上一章所述，seccomp 将可用的系统调用限制在最小集合，削弱了攻击者在 VMM 进程内的操作能力。

## 侧信道攻击缓解

自 2018 年 Spectre 和 Meltdown 被披露以来，侧信道攻击成为虚拟化安全的重要威胁。Firecracker 的应对策略是多维度的。

在微架构层面，Firecracker 依赖 host 内核的缓解措施，包括页表隔离（KPTI）、间接分支预测屏障（IBPB）和推测存储旁路禁用（SSBD）。Firecracker 文档中维护了推荐的 host 内核配置和 CPU 微码版本。

在架构层面，Firecracker 建议为每个 microVM 分配独立的物理 CPU 核心（通过 CPU pinning），消除同一核心上不同 VM 之间的缓存侧信道。在无法做到完全隔离时，至少应确保同一核心上的 VM 属于同一租户。

Firecracker 本身不实现侧信道缓解机制——这是有意为之的设计决策。侧信道防御属于硬件和内核层面的职责，VMM 层面的干预既不充分也不高效。这种清晰的职责划分避免了虚假的安全感。

## 漏洞披露与安全审计

Firecracker 维护了专门的安全漏洞报告渠道，遵循负责任披露（responsible disclosure）流程。安全研究者通过专用邮箱报告漏洞，Firecracker 团队承诺在 90 天内完成修复并发布安全公告。

在安全审计方面，Firecracker 接受过多次第三方安全审计。审计发现的问题通常集中在设备模拟代码中的边界检查不足、错误处理路径中的资源泄露等。每次审计后，Firecracker 团队不仅修复发现的具体问题，还会审视相关代码模式并进行系统性排查。

## 与容器隔离的对比

Firecracker 经常被拿来与容器隔离方案（如 Docker + seccomp + AppArmor）进行比较。两者的根本区别在于隔离边界的性质。

容器共享 host 内核，隔离依赖内核的 namespace 和 cgroup 功能。任何内核漏洞（如 `dirty pipe`、`dirty cow`）都可能导致容器逃逸。而 Firecracker 的 guest 运行在独立的虚拟 CPU 和虚拟内存空间中，guest 内核与 host 内核完全不同——guest 内核漏洞不影响 host 安全。

这并不意味着 Firecracker 绝对安全——KVM 漏洞同样可能被利用。但 KVM 的攻击面远小于完整的内核系统调用接口，且硬件虚拟化扩展提供的隔离机制经过处理器厂商的严格验证。

性能方面，Firecracker 的开销比传统虚拟化低得多（接近容器），但比纯容器方案略高。对于安全敏感的多租户环境，这一点额外开销是完全值得的。

## 本章小结

Firecracker 的安全设计不是事后附加的补丁，而是从第一天起就作为核心架构约束来对待的。公开的威胁模型、明确的信任边界、最小化的攻击面、多层纵深防御——这些设计元素共同构建了一个在工业级多租户环境中经受住考验的安全架构。理解这一威胁模型，不仅有助于正确部署 Firecracker，也为设计其他安全关键系统提供了可借鉴的方法论。
