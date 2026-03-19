# 第 2 章 Repo 结构与模块依赖

> "Any intelligent fool can make things bigger and more complex. It takes a touch of genius — and a lot of courage — to move in the opposite direction."
> —— E.F. Schumacher

## 2.1 顶层目录布局

克隆 Firecracker 仓库后，首先映入眼帘的是一个清晰而克制的目录结构。与许多大型开源项目不同，Firecracker 没有令人眼花缭乱的子目录嵌套，其顶层布局一目了然：

```
firecracker/
├── src/           # 所有 Rust 源码
├── tests/         # 集成测试与性能测试
├── tools/         # 构建与发布工具
├── docs/          # 设计文档与 API 规范
├── resources/     # 测试用 rootfs 和内核
└── Cargo.toml     # Workspace 根配置
```

**为什么这样设计？** 因为 Firecracker 团队信奉"convention over configuration"。所有可执行代码都集中在 `src/` 下，测试和工具严格分离。这种布局让新贡献者可以在几分钟内建立起对项目的整体认知。

## 2.2 核心 Crate 解析

`src/` 目录下的每一个子目录都是一个独立的 Rust crate，它们通过 Cargo workspace 组织在一起（参见 `// Cargo.toml` 中的 `[workspace]` 定义）。让我们逐一认识这些核心模块：

**firecracker（`// src/firecracker/`）。** 这是整个项目的入口 crate，包含 `main()` 函数。它负责解析命令行参数、初始化日志系统、启动 API server，然后将控制权交给 VMM 核心。这个 crate 的代码量很小，因为它的职责仅仅是"胶水"——把各个组件粘合在一起。

**vmm（`// src/vmm/`）。** 这是 Firecracker 的心脏，也是代码量最大的 crate。它包含了虚拟机的完整生命周期管理：创建、配置、启动、暂停、恢复和销毁。VMM crate 内部又细分为若干子模块——设备管理器（`device_manager`）、vCPU 管理（`vcpu`）、内存管理等。我们将在后续章节深入剖析这个 crate 的每一个角落。

**api_server（`// src/api_server/`）。** Firecracker 通过 Unix domain socket 暴露一个 RESTful API，用于接收虚拟机配置和管理指令。这个 crate 实现了一个轻量级的 HTTP server，将 API 请求反序列化后转发给 VMM 处理。为什么选择 HTTP over Unix socket 而不是 gRPC 或自定义协议？因为 HTTP 是最通用的 API 协议，几乎所有编程语言都有现成的客户端库，而 Unix socket 则确保了只有本机进程才能访问这个接口。

**jailer（`// src/jailer/`）。** jailer 是 Firecracker 安全模型中不可或缺的一环。它是一个独立的可执行程序，负责在启动 Firecracker 进程之前设置好所有安全约束：创建新的 PID/network/mount namespace，配置 cgroup 资源限制，加载 seccomp 过滤器，然后以最低权限 `exec()` 进 Firecracker 二进制。jailer 的代码相对简单，但每一行都事关安全边界。

**seccompiler（`// src/seccompiler/`）。** 这个 crate 提供了一种声明式的方式来定义 seccomp-BPF 过滤规则。Firecracker 的 seccomp 策略定义在 JSON 文件中（`// resources/seccomp/`），seccompiler 在构建时将这些 JSON 编译为高效的 BPF 程序。为什么不直接手写 BPF 字节码？因为 BPF 程序极易出错，声明式定义加上编译器验证可以大幅降低配置安全策略时引入漏洞的风险。

**snapshot（`// src/snapshot/`）。** 快照功能允许将一个运行中的 microVM 的完整状态序列化到磁盘，然后在毫秒级时间内恢复。这对于 Lambda 的 SnapStart 功能至关重要。snapshot crate 定义了状态序列化的格式和版本兼容性策略，确保不同版本的 Firecracker 可以正确恢复旧版本创建的快照。

## 2.3 Cargo Workspace 与构建系统

Firecracker 使用 Cargo workspace 来管理多 crate 项目（`// Cargo.toml`）。Workspace 的好处是所有 crate 共享同一个 `Cargo.lock` 文件，确保依赖版本的一致性。同时，workspace 级别的编译可以在 crate 之间复用编译产物，显著加速增量构建。

在 feature flags 方面，Firecracker 保持了一贯的克制。不同于某些项目用大量 feature flag 来控制可选功能，Firecracker 的 feature flag 主要用于区分目标架构（`x86_64` vs `aarch64`）和测试场景。这种做法避免了 feature flag 组合爆炸导致的测试矩阵膨胀问题。

构建过程通过 `// tools/devtool` 脚本统一管理。这个脚本封装了容器化构建环境的创建、编译、测试和代码风格检查等流程。为什么需要容器化构建？因为 Firecracker 依赖特定版本的 Linux 内核头文件和工具链，容器化确保了所有开发者和 CI 环境的一致性。

## 2.4 Crate 依赖关系图

理解 crate 之间的依赖关系是导航代码库的关键。Firecracker 的依赖关系呈现出清晰的分层结构：

```
firecracker (入口)
  ├── api_server
  │     └── vmm
  ├── vmm (核心)
  │     ├── snapshot
  │     ├── seccompiler
  │     ├── kvm-ioctls (外部 crate)
  │     ├── vm-memory (外部 crate)
  │     └── virtio 设备实现
  └── jailer (独立二进制)
```

注意 jailer 在依赖图中是一个孤立节点——它不依赖 vmm 或 api_server。这不是偶然的设计。jailer 必须是一个尽可能简单的程序，因为它以 root 权限运行（用于设置 namespace 和 cgroup），任何不必要的依赖都会增加特权代码的攻击面。

vmm crate 对外部依赖也极为审慎。核心虚拟化功能依赖 `rust-vmm` 组织下的一系列经过安全审计的基础库，如 `kvm-ioctls`、`vm-memory`、`vm-superio` 等。这些库由社区共同维护，被多个 VMM 项目共享，形成了一个可复用的虚拟化组件生态系统。

## 2.5 如何高效导航代码库

对于初次接触 Firecracker 代码库的开发者，建议采用以下路线：

首先从 `// src/firecracker/src/main.rs` 开始，理解程序的启动流程。然后跟随 API 请求的处理路径进入 `// src/api_server/src/lib.rs`，观察请求如何被路由到 VMM。接着深入 `// src/vmm/src/lib.rs`，这里是整个系统的神经中枢。最后，根据你感兴趣的方向，选择性地探索设备实现（`// src/vmm/src/devices/`）或 vCPU 管理（`// src/vmm/src/vcpu/`）等子模块。

每个 crate 的根模块（`lib.rs` 或 `main.rs`）通常包含该模块的架构概述注释，这些注释是理解模块设计意图的最佳起点。

## 本章小结

Firecracker 的仓库结构体现了其设计哲学的一致性——清晰、克制、层次分明。核心 crate 各司其职，依赖关系简洁有向，安全敏感的组件（如 jailer）被刻意隔离。理解了这个全景图，我们就有了一张可靠的地图，可以在后续章节中自信地深入每一个模块的细节。
