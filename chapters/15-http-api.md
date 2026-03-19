# 第 15 章 HTTP API 设计

> "Make the common case fast and the rare case correct." —— Butler Lampson

Firecracker 没有图形界面，没有 libvirt 集成，甚至没有复杂的命令行参数。它的全部控制接口就是一个 Unix Domain Socket 上的 HTTP API。这种极简的接口设计不是偷懒，而是经过深思熟虑的架构决策：一个纯粹的、无状态的、基于 HTTP 语义的 API，让 microVM 的管理变成了简单的 HTTP 请求/响应交互。

## 15.1 为什么选择 Unix Socket 而非 TCP

Firecracker 的 API 监听在一个 Unix Domain Socket 上，而不是 TCP 端口。这个选择背后有三层考量：

**安全性**：Unix Socket 受文件系统权限保护。只有拥有正确文件权限的进程才能连接，不需要额外的认证机制。TCP 端口则对任何能访问网络的进程开放，需要额外的认证和加密层。对于一个安全敏感的 VMM 来说，减少一个攻击维度意义重大。

**性能**：Unix Socket 的通信不经过网络协议栈，没有 TCP 握手、拥塞控制、Nagle 算法等开销。对于 host 内部的进程间通信，Unix Socket 的延迟和吞吐都优于 TCP loopback。

**部署简洁性**：不需要分配和管理端口号，不用担心端口冲突。在高密度部署场景中，一台 host 可能运行数千个 Firecracker 实例，每个都需要独立的 API 端点。使用文件路径比端口号更容易管理，而且与 Jailer 的 chroot 环境天然集成——每个 jail 中的 socket 文件是隔离的。

## 15.2 micro_http：最小化的 HTTP 实现

Firecracker 没有使用 hyper、actix-web 或任何第三方 HTTP 框架，而是实现了自己的 `micro_http` crate，位于 `// src/micro_http/src/`。这个决策延续了 Firecracker 一贯的"最小化依赖"原则。

micro_http 只实现了 HTTP/1.1 协议中 Firecracker 需要的子集：

- 支持 GET 和 PUT 方法（Firecracker 不使用 POST、DELETE 等）
- 固定大小的请求体缓冲区，防止内存耗尽攻击
- 单线程同步处理，无需异步运行时
- 基本的 HTTP 头解析，只关注 Content-Length 和 Content-Type

为什么用 PUT 而不是 POST 来创建资源？因为 Firecracker 的 API 设计遵循 REST 语义中 PUT 的幂等性约定。例如 `PUT /machine-config` 是设置机器配置，无论调用多少次，只要参数相同，结果就相同。这种幂等性简化了客户端的重试逻辑——如果请求超时，客户端可以安全地重发。

micro_http 的代码量极小（约千行），这意味着更少的 bug、更小的攻击面、更容易审计。使用成熟的第三方库当然更方便，但每引入一个依赖就引入了该依赖的全部攻击面和维护负担。对于 Firecracker 这种安全关键的基础设施软件，自研一个最小化实现是值得的。

## 15.3 API Server 架构

API Server 的实现位于 `// src/vmm/src/rpc_interface.rs` 以及 `// src/api_server/src/` 目录中。其架构可以分为三个层次：

**传输层**：micro_http 负责接收 HTTP 请求并解析为结构化数据。它监听 Unix Socket，读取请求数据，解析 HTTP 方法、路径和请求体。

**路由层**：根据请求的路径和方法，将请求分发到对应的处理逻辑。路由本质上是一个 match 表达式，将 URL 路径映射到枚举类型的请求。

**处理层**：每种请求类型有对应的处理函数，负责解析 JSON 请求体、验证参数、执行操作并返回结果。

请求的处理流程如下：API Server 线程接收到 HTTP 请求后，将其转换为内部的 `VmmAction` 枚举，通过 channel 发送给 VMM 主线程。VMM 主线程处理请求并通过另一个 channel 返回结果。API Server 线程将结果转换为 HTTP 响应发送给客户端。

这种通过 channel 传递请求的设计使得 API Server 和 VMM 逻辑完全解耦。API Server 不直接操作 VMM 状态，只负责协议转换和消息传递。这不仅简化了并发控制（所有 VMM 状态修改都在单一线程上），还使得两部分可以独立测试。

## 15.4 核心 API 端点

Firecracker 提供了一组精心设计的 API 端点，覆盖了 microVM 生命周期的各个方面：

**`PUT /machine-config`**：配置 vCPU 数量和内存大小。这是最基本的 VM 配置，必须在启动前设置。请求体示例：`{"vcpu_count": 2, "mem_size_mib": 256}`。

**`PUT /boot-source`**：指定内核镜像路径和启动参数。`kernel_image_path` 指向 host 上的内核文件（经过 Jailer 时需要在 chroot 内可见），`boot_args` 是传递给内核的命令行。可选的 `initrd_path` 指定 initrd 文件。

**`PUT /drives/{drive_id}`**：添加或修改块设备。每个 drive 需要指定 `path_on_host`（后端文件或设备）和 `is_root_device`（是否为根文件系统）。支持 `is_read_only` 标志和速率限制配置。

**`PUT /network-interfaces/{iface_id}`**：配置网络接口。指定 `host_dev_name`（host 上的 TAP 设备名）和可选的 guest MAC 地址。同样支持速率限制。

**`PUT /actions`**：执行控制动作。`InstanceStart` 启动 microVM，`SendCtrlAltDel` 发送关机请求。这个端点是触发状态转换的入口。

**`PUT /snapshot/create`** 和 **`PUT /snapshot/load`**：创建和恢复快照，上一章已详细分析。

**`GET /`** 和 **`GET /machine-config`**：查询 VM 信息和当前配置。

所有配置端点使用 PUT 方法，所有查询端点使用 GET 方法，动作端点也使用 PUT 方法。Firecracker 的 API 设计有一个显著特点：几乎所有端点都是"先配置，后启动"的模式。在 `InstanceStart` 之前，你可以反复修改配置；一旦启动，大部分配置就不可更改了。这种两阶段模型简化了状态管理——不需要处理"运行中修改配置"这一复杂场景（少数例外如块设备的热插拔除外）。

## 15.5 请求验证

每个 API 请求在到达 VMM 核心逻辑之前都经过严格的验证。验证发生在多个层面：

**HTTP 层**：micro_http 验证请求格式，拒绝过大的请求体（防止 DoS），检查 Content-Type 是否为 application/json。

**JSON 解析层**：使用 serde 将 JSON 反序列化为强类型的 Rust 结构体。任何字段缺失、类型错误或多余字段都会被立即拒绝。Rust 的类型系统在这里提供了第一道防线。

**业务逻辑层**：在 `// src/vmm/src/resources.rs` 和 `// src/vmm/src/vmm_config/` 下的各模块中，实现了详细的业务规则验证。例如：vCPU 数量必须在 1 到 32 之间、内存大小必须是页对齐的、内核镜像文件必须存在且可读、不能在 VM 运行后修改 boot source 等。

验证失败时，API 返回 HTTP 400 状态码和详细的错误描述。错误信息的设计也值得注意——它们包含足够的上下文让用户理解问题所在，但不泄露内部实现细节。

## 15.6 异步动作处理

大部分 API 请求是同步的——客户端发送请求，等待配置完成，收到响应。但有些操作本质上是异步的，最典型的是 `InstanceStart`。

启动 microVM 是一个耗时操作（相对于配置而言），API Server 在发送启动请求到 VMM 线程后，会等待 VMM 线程的完成通知再返回响应。这意味着客户端收到 200 响应时，microVM 已经在运行了。

为什么不采用真正的异步模式（如返回 202 Accepted + 轮询状态）？因为 Firecracker 的启动足够快（百毫秒级），同步等待的延迟完全可以接受。引入异步模式会增加客户端的复杂度（需要轮询或 webhook），收益却不大。保持简单的请求-响应模型是更好的工程权衡。

## 本章小结

本章分析了 Firecracker 的 HTTP API 设计。API 通过 Unix Domain Socket 提供服务，兼顾了安全性、性能和部署简洁性。自研的 micro_http crate 实现了最小化的 HTTP/1.1 子集，保持了极小的代码量和攻击面。API Server 通过 channel 与 VMM 主线程通信，实现了清晰的关注点分离。核心端点覆盖了机器配置、内核设置、块设备、网络接口和生命周期管理，遵循"先配置后启动"的两阶段模型。多层次的请求验证确保了只有合法的配置才能到达 VMM 核心。这个看似简单的 API 背后，是对接口设计、安全性和工程简洁性的深入思考。
