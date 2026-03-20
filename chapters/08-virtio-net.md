# 第 8 章 virtio-net 网络虚拟化

> "The Net is a waste of time, and that's exactly what's right about it."
> —— William Gibson

网络是云计算的命脉。对于 Serverless 场景中的 microVM，每一次函数调用的请求和响应都流经网络路径。Firecracker 的 virtio-net 实现在保证安全隔离的前提下，追求尽可能低的网络延迟和高的吞吐量。本章将从设备结构开始，沿着数据包的流动路径，深入分析 Firecracker 网络虚拟化的完整实现。

## Net 设备结构

Firecracker 的 Net 设备定义在 `Net` 结构体中，它实现了 `VirtioDevice` trait。

```
// src/vmm/src/devices/virtio/net/device.rs
```

每个 Net 设备包含两个 virtqueue：RX queue（接收队列，设备向 Guest 写入数据包）和 TX queue（发送队列，Guest 向设备提交待发送的数据包）。此外还有一个配置空间，存储 MAC 地址等信息，以及一个可选的 RateLimiter 用于流量控制。

为什么只有两个队列？virtio 规范允许 multiqueue 配置，多个队列对可以分别绑定到不同的 vCPU，提升多核场景下的并发吞吐。但 Firecracker 目前只支持单队列对，原因在于其目标场景——轻量级 Serverless 函数——通常只有 1-2 个 vCPU，multiqueue 带来的收益有限，而增加的代码复杂度和攻击面是实实在在的。

## TAP 后端

Firecracker 使用 Linux TAP 设备作为网络后端。TAP 是一个二层（L2）虚拟网络接口，它在内核中创建一个网络设备节点，用户态程序可以通过文件描述符读写以太网帧。

```
// src/vmm/src/devices/virtio/net/tap.rs
```

在 microVM 启动前，管理进程（通常是 Jailer 或外部编排系统）会预先创建 TAP 设备并配置好网络（IP 地址、路由规则、iptables 等）。Firecracker VMM 接收 TAP 设备的文件描述符，将其与 Net 设备关联。

TAP 设备被设置为非阻塞模式（`O_NONBLOCK`），这对 Firecracker 的事件驱动架构至关重要。当 TAP 设备上有数据可读时，epoll 会通知 VMM 的事件循环；VMM 随即从 TAP 读取数据包并注入 Guest 的 RX queue。如果使用阻塞模式，一次读操作可能阻塞整个事件循环，影响所有设备的响应性。

### 设计取舍

为什么选择 TAP 后端而非其他方案？主要的替代方案有两个：vhost-net 和 vhost-user。vhost-net 是 Linux 内核模块，它将 virtio 数据面处理下沉到内核态，通过直接在 Guest 内存和 socket buffer 之间拷贝数据来消除用户态中转，通常能提升 20-30% 的网络吞吐量。但 vhost-net 将设备模拟代码放在内核中，扩大了 TCB（Trusted Computing Base），与 Firecracker 的安全优先原则相矛盾。vhost-user 将设备模拟放在独立的用户态进程中，通过共享内存通信，隔离性更好，但引入了额外的进程管理复杂度和 IPC 延迟。TAP 后端是最简单的方案：所有数据面逻辑都在 VMM 进程内完成，代码路径清晰可审计，且 TAP 是 Linux 中最成熟、最稳定的虚拟网络接口。性能上的差距通过批量处理和 ioeventfd/irqfd 快速路径得到了部分弥补。

## 数据包发送：从 Guest 到 Host

当 Guest 应用程序发送一个网络数据包时，数据经历以下路径：

1. **Guest 内核协议栈** 构建完整的以太网帧，写入 virtio-net 驱动分配的共享内存缓冲区。
2. **Guest virtio-net 驱动** 将缓冲区的描述符添加到 TX available ring，然后写入 MMIO notify 寄存器。
3. **KVM ioeventfd** 捕获 notify 写操作，触发 VMM 事件循环中的 TX handler。
4. **VMM TX handler** 从 TX available ring 弹出描述符链，通过 `GuestMemory` 将数据从 Guest 内存读取到临时缓冲区，然后写入 TAP 文件描述符。
5. **Linux 内核** 通过 TAP 设备将帧注入 Host 网络栈，后续的路由和转发由 Host 网络配置决定。
6. **VMM** 将已处理的描述符放入 TX used ring，通过 irqfd 向 Guest 注入中断。

```
// src/vmm/src/devices/virtio/net/device.rs
```

### 核心流程

以下是数据包 TX（发送）和 RX（接收）的完整路径：

```
TX 路径 (Guest ---> Host)
=========================

Guest 应用
    | sendmsg()
    v
Guest 内核协议栈
    | 构建以太网帧
    v
Guest virtio-net 驱动
    | 写入 Descriptor Table
    | 更新 TX Available Ring
    | 写入 MMIO notify
    v
+---+--- ioeventfd ----+---> VMM 事件循环
                        |
                        v
                  TX Handler
                  +---> pop Available Ring
                  +---> GuestMemory.read (GPA ---> HVA)
                  +---> 写入 TAP fd
                  +---> 更新 TX Used Ring
                  +---> irqfd 注入中断
                        |
                        v
                  Linux TAP 设备
                        |
                        v
                  Host 网络栈 / 物理网卡


RX 路径 (Host ---> Guest)
=========================

Host 网络栈 / 物理网卡
    |
    v
Linux TAP 设备
    | epoll 通知可读
    v
VMM 事件循环
    |
    v
RX Handler
    +---> 从 TAP fd 读取帧数据
    +---> pop RX Available Ring (Guest 预分配的空缓冲区)
    |         |
    |    +----+----+
    |    |         |
    |  有缓冲区  无缓冲区
    |    |         |
    |    |         v
    |    |    暂存 deferred frame
    |    |    等待 Guest 补充缓冲区
    |    v
    +---> GuestMemory.write (数据 ---> Guest 缓冲区)
    +---> 更新 RX Used Ring
    +---> irqfd 注入中断
              |
              v
        Guest virtio-net 驱动
              | 从 Used Ring 取出数据
              v
        Guest 内核协议栈
              |
              v
        Guest 应用 recvmsg()
```

TX 处理中一个重要的优化是批量处理（batch processing）。VMM 不会每收到一个 notify 就只处理一个描述符，而是在一次事件回调中尽可能多地处理 available ring 中的所有待发送包。这减少了事件处理的固定开销。

## 数据包接收：从 Host 到 Guest

接收路径是发送的逆过程，但实现上有一些额外的复杂性：

1. **TAP 设备** 收到一个来自 Host 网络的以太网帧，epoll 通知 VMM。
2. **VMM RX handler** 从 TAP 文件描述符读取帧数据到临时缓冲区。
3. **VMM** 从 RX available ring 弹出一个描述符链——这个缓冲区是 Guest 驱动预先分配并提交的"空缓冲区"。
4. **VMM** 通过 `GuestMemory` 将帧数据写入 Guest 内存中描述符指向的缓冲区。
5. **VMM** 更新 RX used ring，通过 irqfd 注入中断。
6. **Guest virtio-net 驱动** 在中断处理中从 used ring 取出数据，提交给 Guest 内核协议栈。

RX 路径的一个关键挑战是：当 Guest 驱动没有及时补充空缓冲区时，RX available ring 可能为空。此时 VMM 无法将收到的数据包注入 Guest。Firecracker 的处理策略是将数据包暂存（deferred frame），并在下一次 Guest 补充缓冲区时重试。如果暂存区也已满，则丢弃数据包——这与真实网卡在缓冲区耗尽时的行为一致。

## MMIO 中断流

网络设备的中断流值得单独说明，因为它直接影响延迟。Firecracker 使用 `irqfd` 机制注入中断：VMM 向 irqfd 文件描述符写入一个 `1`，KVM 会在下次 VM Entry 时将虚拟中断递交给 Guest。

每次向 used ring 添加条目后是否立即触发中断，取决于 Guest 驱动设置的 `VRING_AVAIL_F_NO_INTERRUPT` 标志。如果 Guest 驱动正在 polling 模式下工作（如 Linux NAPI），它会暂时禁用中断以减少中断风暴。Firecracker 尊重这一标志，只在 Guest 期望中断时才触发，避免无谓的 VM Exit。

## 速率限制

Firecracker 为 Net 设备提供了内置的 RateLimiter，支持对带宽和包速率分别设置令牌桶限制。

```
// src/vmm/src/rate_limiter/mod.rs
```

RateLimiter 使用经典的令牌桶算法（token bucket），支持两个参数：桶大小（burst capacity）和补充速率（refill rate）。每次处理数据包前，TX 和 RX handler 都会检查 RateLimiter 是否允许本次操作。如果令牌不足，当前的处理会被暂停，直到定时器补充了足够的令牌。

速率限制在多租户环境中不可或缺。没有它，一个 microVM 的网络突发流量可能影响同一 Host 上其他 microVM 的网络性能。通过在 VMM 层实施限制，而非依赖 Host 网络层的 tc（traffic control），Firecracker 获得了更精细的控制粒度和更低的延迟抖动。

## 性能考量

Firecracker 在网络性能上做了多项针对性优化：

**零拷贝的局限。** 目前 Firecracker 的网络路径并非完全零拷贝——数据需要在 Guest 内存和 TAP 文件描述符之间至少拷贝一次。真正的零拷贝（如 vhost-net）需要将数据面下沉到内核模块，这与 Firecracker 将所有设备逻辑保留在用户态以缩小 TCB（Trusted Computing Base）的设计原则相矛盾。

**缓冲区管理。** Firecracker 使用固定大小的临时缓冲区来中转数据包，避免了动态内存分配的开销。缓冲区大小设定为 65562 字节，足以容纳最大的以太网帧（含 virtio-net header）。

**事件合并。** 在高吞吐场景下，一次事件回调中批量处理多个数据包，摊薄了每个包的事件处理固定开销。

### 设计取舍

批量处理（batch processing）是在延迟和吞吐量之间的一个经典权衡。逐包处理模式下，每个数据包到达后立即处理并通知 Guest，延迟最低但每包开销最大（每次都要触发 irqfd 中断注入）。完全批量模式下，积攒大量数据包后一次性处理并发送一次中断，吞吐量最高但可能引入毫秒级延迟。Firecracker 采用了折中方案：在一次事件回调中处理所有当前可用的数据包（"drain available ring"），然后发送一次中断。这意味着批量大小是自适应的——低负载时通常只有一个包，行为接近逐包处理；高负载时 available ring 中积累了多个包，自然形成批量。这种设计无需额外的定时器或水位线参数，实现简单且效果良好。

## 本章小结

virtio-net 是 Firecracker 中最复杂的 virtio 设备实现。TAP 后端提供了与 Host 网络的桥接能力，RX/TX 双队列实现了全双工的数据通路，RateLimiter 保障了多租户场景下的网络公平性。在每个设计决策中——单队列而非多队列、用户态 TAP 而非内核态 vhost-net——Firecracker 都在性能和安全之间找到了适合 Serverless 场景的平衡点。数据包从 Guest 应用到 Host 网络的每一跳都清晰可追踪，这种透明性本身就是安全的一部分。
