# 第 10 章 virtio-vsock 主客通信

> "The most important thing in communication is hearing what isn't said."
> —— Peter Drucker

在前面的章节中，我们看到了 virtio-net 如何为 Guest 提供网络连接，virtio-block 如何提供持久化存储。但在实际的 microVM 管理场景中，还有一类通信需求不适合走网络协议栈——Host 与 Guest 之间的控制通道通信。virtio-vsock 正是为此而生的轻量级通信机制，它提供了一条绕过网络栈的直连通道，成为 Firecracker 生态中不可或缺的基础设施。

## AF_VSOCK 概述

vsock（Virtual Socket）是 Linux 内核提供的一种 socket 地址族（`AF_VSOCK`），专为虚拟机与 Host 之间的通信设计。与 `AF_INET` 使用 IP 地址和端口号不同，`AF_VSOCK` 使用 CID（Context Identifier）和端口号来标识通信端点。

每个虚拟机被分配一个唯一的 CID，Host 的 CID 固定为 2（`VMADDR_CID_HOST`）。通信时，一方通过 `connect(CID, port)` 发起连接，另一方通过 `bind` + `listen` + `accept` 接受连接。编程模型与 TCP socket 几乎一致，应用开发者无需学习新的 API。

为什么不直接使用 virtio-net 完成 Host-Guest 通信？几个核心原因：

**协议栈开销。** 通过 virtio-net 通信需要经过完整的 TCP/IP 协议栈——ARP 解析、IP 路由、TCP 握手和拥塞控制。对于同一物理机上的 Host-Guest 通信，这些操作纯属多余。vsock 直接在 virtio 层传输数据，省去了所有网络协议开销。

**网络隔离。** Serverless 环境中，microVM 的网络配置通常受到严格限制。使用 vsock 作为管理通道，可以将管理面通信与数据面网络完全隔离，即使 Guest 的网络配置出现问题，管理通道仍然可用。

**简化配置。** vsock 不需要 IP 地址分配、路由配置或防火墙规则。一个 CID 和端口号就足以建立连接，大幅简化了 microVM 的初始化流程。

## Vsock 设备架构

Firecracker 的 vsock 设备实现分为三层：

```
// src/vmm/src/devices/virtio/vsock/
```

**VirtioDevice 层。** `Vsock` 结构体实现了 `VirtioDevice` trait，管理 virtqueue 和设备状态。vsock 设备有三个 virtqueue：RX queue（Host 向 Guest 发送数据）、TX queue（Guest 向 Host 发送数据）和 Event queue（异步事件通知，但 Firecracker 当前未使用此队列）。

**Vsock 协议层。** 处理 vsock 协议的连接管理和数据传输逻辑。每个 vsock 连接由一个 `(src_cid, src_port, dst_cid, dst_port)` 四元组唯一标识。协议层维护一个连接表，跟踪所有活跃连接的状态。

**Backend 层。** 通过 `VsockBackend` trait 抽象后端实现，负责与 Host 侧的通信端点交互。

### 模块关系

```
+--------------------------------------------------+
|              Vsock (VirtioDevice trait)           |
|  管理 RX/TX/Event 三个 virtqueue 与设备生命周期    |
+--------------------------------------------------+
        |                          |
        v                          v
+------------------+    +---------------------+
| VsockPacket      |    | 连接表              |
| 解析/构建 vsock  |    | HashMap<ConnKey,     |
| 数据包头部与负载  |    |   ConnState>         |
+------------------+    | 跟踪连接状态与信用值  |
                        +---------------------+
                                   |
                                   v
                        +---------------------+
                        | VsockBackend trait   |
                        | 抽象后端接口          |
                        +---------------------+
                                   |
                                   v
                        +---------------------+
                        | VsockUnixBackend    |
                        | Unix 域 socket 实现  |
                        | Host 侧 UDS 连接管理 |
                        +---------------------+
```

## 面向连接的通信模型

### 核心流程

```
Guest 应用                    VMM (Firecracker)              Host 服务
    |                              |                            |
    | connect(HOST_CID, port)      |                            |
    |---> Guest 内核构建           |                            |
    |     VSOCK_OP_REQUEST         |                            |
    |     放入 TX queue            |                            |
    |                              |                            |
    |          ioeventfd 通知 ---> |                            |
    |                              | 从 TX queue 取出请求包     |
    |                              | 查找目标端口对应的 UDS     |
    |                              |---> connect(UDS path) ---> |
    |                              |                            |
    |                              | <--- 连接接受 ------------ |
    |                              | 构建 VSOCK_OP_RESPONSE     |
    |                              | 放入 RX queue              |
    |          irqfd 中断 <------- |                            |
    |                              |                            |
    | 连接进入 ESTABLISHED         |                            |
    |                              |                            |
    |====== 数据传输阶段 (VSOCK_OP_RW) ========================|
    |                              |                            |
    | write(data) ---> TX queue    |                            |
    |                              |---> UDS write(data) -----> |
    |                              |                            |
    |                              | <--- UDS read(data) ------ |
    | <--- RX queue <------------- |                            |
    | read(data)                   |                            |
    |                              |                            |
    |====== 连接关闭 ==========================================|
    |                              |                            |
    | VSOCK_OP_SHUTDOWN ---------> |---> close(UDS) ----------> |
    | <--- VSOCK_OP_RST <--------- |                            |
```

vsock 提供的是面向连接的、可靠的字节流传输——类似于 TCP，但更加轻量。连接建立的过程如下：

1. **Guest 发起连接：** Guest 应用调用 `connect(HOST_CID, port)`，Guest 内核的 vsock 驱动构建一个 `VIRTIO_VSOCK_OP_REQUEST` 数据包，通过 TX queue 发送给 VMM。
2. **VMM 转发请求：** VMM 从 TX queue 取出请求包，通过 Backend 转发给 Host 侧对应的监听端点。
3. **Host 接受连接：** Host 侧的 Backend 收到连接请求后，返回一个 `VIRTIO_VSOCK_OP_RESPONSE` 数据包，VMM 将其放入 RX queue。
4. **连接建立：** Guest 驱动收到响应后，连接进入 ESTABLISHED 状态，双方可以开始数据传输。

数据传输使用 `VIRTIO_VSOCK_OP_RW` 操作码。流量控制通过每个连接维护的信用值（credit）实现：接收方通过 `buf_alloc`（缓冲区总容量）和 `fwd_cnt`（已消费的字节数）告知发送方可用的缓冲区空间，发送方据此控制发送速率，防止接收方被淹没。

### 设计取舍

基于信用的流量控制（credit-based flow control）是 vsock 在可靠性与简洁性之间的关键设计选择。替代方案包括类似 TCP 的滑动窗口协议或完全不做流控（依赖底层 virtqueue 的背压）。TCP 的滑动窗口带来了重传、拥塞控制、RTT 估算等复杂机制——这些对于同机 Host-Guest 通信完全多余，因为传输路径不会丢包也不存在拥塞。而完全不做流控则可能导致快速发送方耗尽接收方的缓冲区。信用机制取了中间路线：接收方通过 `buf_alloc` 和 `fwd_cnt` 两个字段即可精确告知可用空间，发送方据此自行限速，无需确认、重传或定时器，实现代码极为精简。

连接关闭使用 `VIRTIO_VSOCK_OP_SHUTDOWN` 和 `VIRTIO_VSOCK_OP_RST` 操作码，支持单向关闭（类似 TCP 的半关闭）。

## VsockBackend trait 与 Unix 域 socket 后端

`VsockBackend` trait 将 vsock 设备的传输逻辑与后端实现解耦。

```
// src/vmm/src/devices/virtio/vsock/backend.rs
```

Firecracker 提供的默认后端实现是基于 Unix 域 socket（UDS）的。其工作方式是：VMM 在 Host 上创建一个 UDS 监听地址，当 Guest 发起 vsock 连接时，VMM 在 Host 上建立对应的 UDS 连接，将 vsock 数据包的内容透传到 UDS。

具体来说，当 Guest 连接到 `(HOST_CID, port)` 时，Backend 会尝试连接到 Host 上预先注册的与该端口对应的 UDS 路径。这种映射允许 Host 上不同的服务监听不同的端口，实现多路复用。

为什么选择 Unix 域 socket 作为后端？因为 UDS 是 Linux 上性能最好的本地 IPC 机制之一——数据不经过网络协议栈，直接在内核缓冲区之间拷贝。同时 UDS 支持文件描述符传递和凭证验证（`SO_PEERCRED`），为安全性提供了额外的保障。

## 数据包格式与流转

vsock 数据包的格式由 virtio-vsock 规范定义，包含一个固定大小的头部：

```
// src/vmm/src/devices/virtio/vsock/packet.rs
```

头部字段包括：`src_cid`、`dst_cid`、`src_port`、`dst_port`（标识连接）、`len`（数据长度）、`type`（传输类型，通常为 `VIRTIO_VSOCK_TYPE_STREAM`）、`op`（操作码）、`flags`（标志位）、`buf_alloc` 和 `fwd_cnt`（流量控制信用值）。

一个完整的数据传输周期：Guest 应用调用 `write()`，Guest 内核将数据封装为 vsock 包放入 TX queue；VMM 从 TX queue 取出包，解析头部确定目标连接，将数据负载写入对应的 UDS 文件描述符。反方向类似：UDS 可读时，VMM 读取数据，封装为 vsock 包放入 RX queue，Guest 驱动从 RX queue 取出并递交给 Guest 应用。

在 Firecracker 的实现中，数据包的头部和负载数据都直接存储在 Guest 内存的 virtqueue 缓冲区中。VMM 通过 `GuestMemory` 接口原地读写这些数据，避免了不必要的内存拷贝。

## 典型应用场景

vsock 在 Firecracker 生态中有几个核心应用场景：

**Guest Agent 通信。** 在 microVM 内部运行的 agent 程序通过 vsock 与 Host 上的管理服务通信，接收任务指令（如"执行某个函数"）并返回结果。这是 AWS Lambda 使用 Firecracker 时的核心通信通道——函数调用的请求和响应都通过 vsock 传递，而非网络接口。

**指标收集。** Guest 内部的监控组件通过 vsock 将性能指标（CPU 使用率、内存占用、函数执行时间等）推送到 Host 上的指标聚合服务。相比通过网络发送指标数据，vsock 的延迟更低、配置更简单。

**日志传输。** 函数执行产生的日志通过 vsock 流式传输到 Host，避免了在 Guest 内部存储日志的磁盘空间开销。

**安全引导验证。** Host 可以通过 vsock 在 Guest 启动后立即与其通信，验证 Guest 环境的完整性。

## 为什么选择 vsock 而非 virtio-serial

在 vsock 出现之前，虚拟机与 Host 的通信通常使用 virtio-serial——一种提供多端口字符设备的 virtio 类型。QEMU 的 Guest Agent（qemu-ga）就是基于 virtio-serial 实现的。但 Firecracker 选择了 vsock，原因如下：

**标准的 socket API。** vsock 使用标准的 Berkeley socket 接口（`socket`、`bind`、`connect`、`accept`、`read`、`write`），应用程序无需任何特殊的库或驱动接口。而 virtio-serial 在 Guest 中表现为字符设备（`/dev/vportNpN`），需要使用文件 I/O 接口，缺乏连接管理和多路复用能力。

**多连接支持。** vsock 天然支持多个并发连接，每个连接由端口号区分。virtio-serial 虽然支持多端口，但每个端口需要预先配置，运行时无法动态创建。

**流量控制。** vsock 内建了基于信用的流量控制机制，确保数据传输不会超出接收方的处理能力。virtio-serial 缺乏此机制，需要应用层自行实现。

**Guest 内核原生支持。** vsock 驱动已经合入 Linux 主线内核多年，无需额外安装驱动或模块。Guest 应用可以像使用 TCP socket 一样使用 vsock，迁移成本几乎为零。

## 本章小结

virtio-vsock 为 Firecracker 提供了一条高效、安全的 Host-Guest 通信通道。它绕过了网络协议栈的开销，通过标准的 socket API 提供了面向连接的可靠传输。Unix 域 socket 后端将 vsock 连接桥接到 Host 上的服务，实现了灵活的服务对接。在 AWS Lambda 等 Serverless 场景中，vsock 是函数调用请求传递、指标收集和日志传输的首选通道。选择 vsock 而非 virtio-serial，体现了 Firecracker 对标准接口和简洁设计的一贯追求。至此，Firecracker 的三种 virtio 设备——net、block、vsock——都已分析完毕，它们共同构成了 microVM 与外部世界交互的完整接口。
