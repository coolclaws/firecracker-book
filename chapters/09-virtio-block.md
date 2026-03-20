# 第 9 章 virtio-block 块设备

> "Data is a precious thing and will last longer than the systems themselves."
> —— Tim Berners-Lee

块设备是虚拟机的持久化存储基础。Guest 操作系统的根文件系统、应用数据、日志文件——所有需要在内存之外存储的数据都依赖块设备。Firecracker 的 virtio-block 实现聚焦于简洁与安全，用最小的代码量提供了一个功能完备的虚拟磁盘。

## Block 设备结构

Block 设备的核心结构定义在 `Block` 中，同样实现了 `VirtioDevice` trait。

```
// src/vmm/src/devices/virtio/block/device.rs
```

与 Net 设备的双队列不同，Block 设备只有一个 virtqueue，所有的读写请求都通过这个队列传递。这是因为块设备的 I/O 模式与网络有本质不同：网络是全双工的，收发同时进行；而块 I/O 是请求-响应模式，一个队列足以承载。

### 设计取舍

单队列设计是 Firecracker 在性能与复杂度之间做出的典型权衡。QEMU 和现代 virtio-blk 规范支持 multiqueue（多队列），允许多个 vCPU 并行提交 I/O 请求以提升吞吐量。Firecracker 放弃了 multiqueue，原因在于：其目标场景（Serverless 函数执行）通常只配置 1-2 个 vCPU，单队列不会成为瓶颈；multiqueue 引入的队列选择逻辑和并发控制会增加代码复杂度与攻击面；同时单队列使得速率限制的实现更加直观——所有请求经过同一路径，限流点唯一且明确。

Block 设备的关键成员包括：后端磁盘文件的文件描述符、设备配置（容量、是否只读等）、可选的 RateLimiter，以及一个标识设备 ID 的字符串。设备 ID 允许 Guest 内部通过 `/dev/disk/by-id/` 路径稳定地引用磁盘，而不依赖于设备发现的顺序。

## 后端文件抽象

Firecracker 的块设备后端是一个普通的 Host 文件。这个文件可以是原始的磁盘镜像（raw image），也可以是稀疏文件（sparse file）。Firecracker 有意不支持 qcow2 等复杂的镜像格式。

```
// src/vmm/src/devices/virtio/block/io/
```

为什么不支持 qcow2？首先，qcow2 的解析代码复杂度高，QEMU 的 qcow2 实现曾多次爆出安全漏洞。其次，qcow2 的核心价值——快照、写时复制、压缩——在 Serverless 场景下可以通过其他方式实现（如外部的镜像管理系统或文件系统层面的 snapshot）。用 raw 格式，VMM 内部不需要任何镜像格式解析逻辑，I/O 路径上少一层间接意味着少一个出错的可能。

### 设计取舍

选择 raw 文件后端而非 qcow2 是安全性与功能丰富性之间的取舍。qcow2 提供了快照、增量备份、加密等丰富功能，但这些功能在 Firecracker 的短生命周期 microVM 场景中价值有限——函数执行环境通常是无状态的，镜像由外部编排系统管理。相比之下，qcow2 解析器带来的攻击面是实实在在的风险：QEMU 的 qcow2 代码曾因整数溢出、越界读写等问题产生多个 CVE。Firecracker 将镜像格式管理推给了外部工具链（如在 Host 侧使用 overlayfs 或 device-mapper snapshot），用架构层面的隔离替代了 VMM 内部的格式抽象。

后端文件在打开时会根据配置决定是否设置 `O_DIRECT` 标志。`O_DIRECT` 绕过 Linux 页缓存，直接进行磁盘 I/O，适用于 Guest 自身有缓存管理的场景。不使用 `O_DIRECT` 则允许 Host 页缓存发挥作用，对于读密集型负载可以显著提升性能。

## 请求解析

Guest 驱动通过 virtqueue 提交的每个块 I/O 请求都是一个描述符链，由三部分组成：

**请求头（Request Header）。** 第一个描述符指向一个 `virtio_blk_req` 结构，包含请求类型（`type`）和目标扇区号（`sector`）。支持的请求类型有：
- `VIRTIO_BLK_T_IN`（0）：读操作
- `VIRTIO_BLK_T_OUT`（1）：写操作
- `VIRTIO_BLK_T_FLUSH`（4）：刷新缓存到磁盘
- `VIRTIO_BLK_T_GET_ID`（8）：获取设备 ID 字符串

**数据缓冲区。** 中间的一个或多个描述符指向数据缓冲区。对于读操作，这些缓冲区标记为设备可写（`VIRTQ_DESC_F_WRITE`），设备会将读到的数据写入其中；对于写操作，缓冲区包含 Guest 待写入的数据。

**状态字节。** 最后一个描述符指向一个单字节的状态缓冲区，设备在完成请求后写入 `VIRTIO_BLK_S_OK`（0）、`VIRTIO_BLK_S_IOERR`（1）或 `VIRTIO_BLK_S_UNSUPP`（2）。

```
// src/vmm/src/devices/virtio/block/request.rs
```

Firecracker 在解析请求时进行了严格的边界检查：扇区号不能超出设备容量，数据缓冲区的长度必须对齐到扇区大小（512 字节），写操作不能发往只读设备。任何违规的请求都会被标记为错误状态返回，而不会导致 VMM 崩溃或产生未定义行为。

## I/O 处理流程

### 核心流程

```
Guest 应用发起 read()/write()
        |
        v
+-------------------+
| Guest 块设备驱动   |  构建 virtio_blk_req 描述符链
+-------------------+  (请求头 + 数据缓冲区 + 状态字节)
        |
        | 写入 available ring, 触发 MMIO notify
        v
+-------------------+
| ioeventfd         |  内核 eventfd 通知
+-------------------+
        |
        v
+-------------------+
| Block handler     |  从 available ring 弹出描述符链
| (VMM 用户态)      |  解析请求头 (type, sector)
+-------------------+
        |
        +---> 读操作:  pread()  从后端文件读, 写入 Guest 缓冲区
        +---> 写操作:  pwrite() 从 Guest 缓冲区读, 写入后端文件
        +---> Flush:   fsync()/fdatasync() 落盘
        +---> Get ID:  写入设备 ID 字符串
        |
        v
+-------------------+
| 写入状态字节       |  VIRTIO_BLK_S_OK / S_IOERR / S_UNSUPP
| 放入 used ring    |
+-------------------+
        |
        v
+-------------------+
| irqfd             |  向 Guest 注入中断, 通知请求完成
+-------------------+
```

完整的块 I/O 处理流程如下：

1. **Guest 驱动** 构建请求描述符链，放入 available ring，写入 MMIO notify 寄存器。
2. **ioeventfd** 触发 VMM 事件循环中的 Block handler。
3. **VMM** 从 available ring 弹出描述符链，解析请求头。
4. 根据请求类型执行操作：
   - **读操作：** 调用 `pread` 从后端文件的指定偏移读取数据，通过 `GuestMemory` 写入 Guest 的数据缓冲区。
   - **写操作：** 通过 `GuestMemory` 从 Guest 数据缓冲区读取数据，调用 `pwrite` 写入后端文件的指定偏移。
   - **Flush 操作：** 调用 `fsync` 或 `fdatasync` 确保数据落盘。
   - **Get ID 操作：** 将设备 ID 字符串写入 Guest 缓冲区。
5. **VMM** 写入状态字节，将描述符链放入 used ring。
6. **VMM** 通过 irqfd 向 Guest 注入中断。

注意这里使用 `pread`/`pwrite` 而非 `read`/`write`。前者接受显式的偏移参数，不依赖文件描述符的当前位置，因此是线程安全的——多个请求可以并发处理同一个文件描述符而无需加锁。

## 速率限制

与 Net 设备类似，Block 设备也集成了 RateLimiter，但维度有所不同。块设备的速率限制通常关注两个指标：IOPS（每秒 I/O 操作数）和吞吐量（每秒字节数）。

```
// src/vmm/src/devices/virtio/block/device.rs
```

在每个 I/O 请求处理前，handler 会向 RateLimiter 请求令牌。如果 IOPS 令牌或吞吐量令牌任一不足，请求处理会被延迟。延迟的机制是：将 virtqueue 的处理暂停，注册一个定时器事件，待令牌补充后恢复处理。

块设备的速率限制在多租户环境中尤为重要。磁盘 I/O 是典型的共享资源——多个 microVM 可能共享同一块物理磁盘。没有限流，一个 microVM 的大量随机写操作可能耗尽磁盘的 IOPS 预算，导致其他 microVM 的 I/O 延迟飙升。

## 缓存模式考量

Firecracker 的块设备支持两种主要的缓存行为，由后端文件的打开方式决定：

**Writeback 模式（默认）。** 写操作完成意味着数据已写入 Host 页缓存，但不一定落盘。Guest 需要通过 flush 操作显式地将数据持久化。这种模式性能最好，因为小写操作可以被页缓存合并。

**Direct I/O 模式。** 使用 `O_DIRECT` 打开文件，绕过页缓存。每次写操作直接到达存储设备（或其硬件缓存）。延迟更可预测，但小 I/O 的吞吐量可能下降。

对于 Serverless 场景，Writeback 模式通常是更好的选择——函数执行产生的临时数据不需要强持久性保证，而页缓存带来的性能提升在短生命周期的 microVM 中尤为明显，因为 Guest 多次读取同一文件的内容可以直接从 Host 缓存中获取。

## 设备配置与创建

Block 设备通过 Firecracker 的 REST API 创建。API 接收的关键参数包括：`drive_id`（设备标识符）、`path_on_host`（后端文件路径）、`is_root_device`（是否为根磁盘）、`is_read_only`（是否只读）、`rate_limiter`（可选的速率限制配置）。

```
// src/vmm/src/resources.rs
```

根磁盘会被赋予特殊的 virtio 设备索引，确保 Guest 内核的 `root=` 启动参数能够正确找到它。非根磁盘按添加顺序分配索引。每个 Block 设备在 MMIO 地址空间中占据一段独立的区域，VMM 在启动时为其分配地址范围和中断号。

设备创建过程中，VMM 会打开后端文件并验证其可访问性，读取文件大小以确定设备容量（以 512 字节扇区为单位），然后构建 `Block` 实例。整个过程是同步的，在 microVM 启动前完成。

## 本章小结

virtio-block 的实现是 Firecracker 简洁设计哲学的典范。一个 virtqueue 承载所有 I/O 请求，raw 格式的后端文件避免了镜像格式解析的复杂性和安全风险，`pread`/`pwrite` 提供了天然的线程安全性。速率限制从 IOPS 和吞吐量两个维度保障了多租户环境下的 I/O 公平性。请求解析中的严格边界检查确保了恶意 Guest 无法通过畸形请求影响 Host 的稳定性。每一个被省略的功能（qcow2 支持、multiqueue、异步 I/O）都是经过审慎权衡后的选择，服务于 Firecracker "安全优先、够用即止"的核心理念。
