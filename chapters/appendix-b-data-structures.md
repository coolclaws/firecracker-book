# 附录 B 核心数据结构速查

> "Bad programmers worry about the code. Good programmers worry about data structures and their relationships."
> —— Linus Torvalds

数据结构是程序的骨架。理解 Firecracker 的核心数据结构及其相互关系，就等于掌握了整个系统的蓝图。本附录以速查表的形式汇总全书涉及的关键 struct、enum 和 trait，标注其源文件位置与核心字段，供读者在阅读源码时随时查阅。

## 一、VMM 核心结构

### Vmm

- **源文件：** `src/vmm/src/lib.rs`
- **职责：** 虚拟机监控器的顶层结构，持有一个 microVM 实例的所有运行时状态
- **关键字段：**
  - `guest_memory: GuestMemoryMmap` —— Guest 物理内存的映射
  - `vcpus_handles: Vec<VcpuHandle>` —— 所有 vCPU 线程的控制句柄
  - `mmio_device_manager: MMIODeviceManager` —— MMIO 设备总线管理器
  - `vm: Vm` —— 对 KVM VM 文件描述符的封装
  - `pio_device_manager: PortIODeviceManager` —— PIO 设备管理器（x86_64 特有）

### VmResources

- **源文件：** `src/vmm/src/resources.rs`
- **职责：** 在 VMM 构建之前，暂存所有用户通过 API 提交的虚拟机配置
- **关键字段：**
  - `machine_config: MachineConfig` —— CPU 数量、内存大小等基础配置
  - `boot_config: Option<BootConfig>` —— 内核与引导参数配置
  - `block_devices: Vec<BlockDeviceConfig>` —— 块设备配置列表
  - `net_devices: Vec<NetworkInterfaceConfig>` —— 网络设备配置列表
  - `vsock_device: Option<VsockDeviceConfig>` —— vsock 设备配置

### MachineConfig

- **源文件：** `src/vmm/src/resources.rs`
- **职责：** 描述虚拟机的基础硬件配置
- **关键字段：**
  - `vcpu_count: u8` —— vCPU 核心数
  - `mem_size_mib: usize` —— 内存大小（MiB）
  - `smt: bool` —— 是否启用同步多线程
  - `track_dirty_pages: bool` —— 是否追踪脏页（用于增量快照）

### BootConfig

- **源文件：** `src/vmm/src/resources.rs`
- **职责：** 指定 Guest 内核的启动参数
- **关键字段：**
  - `kernel_file: File` —— 内核镜像文件（ELF 或 bzImage 格式）
  - `initrd_file: Option<File>` —— 可选的 initrd/initramfs 文件
  - `boot_args: String` —— 内核命令行参数

## 二、vCPU 相关结构

### VcpuHandle

- **源文件：** `src/vmm/src/vcpu/mod.rs`
- **职责：** 主线程持有的 vCPU 控制句柄，用于向 vCPU 线程发送指令
- **关键字段：**
  - `vcpu_thread: thread::JoinHandle<()>` —— vCPU 线程的 JoinHandle
  - `event_sender: Sender<VcpuEvent>` —— 向 vCPU 线程发送事件的通道
  - `response_receiver: Receiver<VcpuResponse>` —— 接收 vCPU 响应的通道

### GuestMemoryMmap

- **源文件：** 来自 `vm-memory` crate
- **职责：** 将 Guest 物理地址空间映射到 Host 用户态虚拟地址
- **关键特性：**
  - 由多个 `GuestRegionMmap` 区域组成，支持不连续的物理地址布局
  - 提供 `read_obj` / `write_obj` 等类型安全的内存访问方法
  - 实现了 `GuestMemory` trait，被 VMM 各组件广泛引用

## 三、设备模型结构

### VirtioDevice trait

- **源文件：** `src/vmm/src/devices/virtio/mod.rs`
- **职责：** 所有 virtio 设备必须实现的接口契约
- **关键方法：**
  - `device_type() -> u32` —— 返回设备类型标识
  - `queues() -> &[Queue]` —— 返回设备拥有的 virtqueue 列表
  - `activate(mem: GuestMemoryMmap)` —— 激活设备，开始处理 I/O
  - `read_config() / write_config()` —— 读写设备配置空间

### Net

- **源文件：** `src/vmm/src/devices/virtio/net/device.rs`
- **职责：** virtio-net 网络设备的实现
- **关键字段：**
  - `tap: Tap` —— 底层 TAP 设备的文件描述符封装
  - `queues: Vec<Queue>` —— RX 与 TX 两个 virtqueue
  - `rx_rate_limiter: RateLimiter` —— 接收方向的速率限制器
  - `tx_rate_limiter: RateLimiter` —— 发送方向的速率限制器
  - `mmds_ns: Option<MmdsNetworkStack>` —— 可选的 MMDS 网络栈

### Block

- **源文件：** `src/vmm/src/devices/virtio/block/device.rs`
- **职责：** virtio-blk 块设备的实现
- **关键字段：**
  - `disk: DiskProperties` —— 磁盘文件及其属性
  - `queues: Vec<Queue>` —— 请求处理 virtqueue
  - `rate_limiter: RateLimiter` —— I/O 速率限制器
  - `is_read_only: bool` —— 是否为只读设备

### Vsock

- **源文件：** `src/vmm/src/devices/virtio/vsock/device.rs`
- **职责：** virtio-vsock 设备的实现，提供 Guest 与 Host 之间的套接字通信
- **关键字段：**
  - `cid: u64` —— Guest 的 Context Identifier
  - `queues: Vec<Queue>` —— RX、TX 和 Event 三个 virtqueue
  - `backend: VsockUnixBackend` —— Unix 域套接字后端

### SerialDevice

- **源文件：** `src/vmm/src/devices/legacy/serial.rs`
- **职责：** 模拟 16550 UART 串口设备，用于 Guest 控制台输出
- **关键字段：**
  - `interrupt_evt: EventFd` —— 中断通知的 EventFd
  - `out: Option<Box<dyn Write + Send>>` —— 输出目标（通常是标准输出）

## 四、API 与控制结构

### ApiRequest / ApiResponse

- **源文件：** `src/vmm/src/rpc_interface.rs`
- **职责：** 定义 HTTP API 层与 VMM 之间的通信协议
- **ApiRequest 主要变体：**
  - `InstanceInfo` —— 查询实例信息
  - `PutMachineConfiguration(MachineConfig)` —— 设置机器配置
  - `PutBootSource(BootConfig)` —— 设置启动源
  - `InsertBlockDevice(BlockDeviceConfig)` —— 插入块设备
  - `InsertNetworkDevice(NetworkInterfaceConfig)` —— 插入网络设备
  - `CreateSnapshot(SnapshotParams)` —— 创建快照
  - `ResumeVm` / `PauseVm` —— 恢复 / 暂停虚拟机

### SnapshotParams

- **源文件：** `src/vmm/src/persist.rs`
- **职责：** 描述快照创建或恢复操作的参数
- **关键字段：**
  - `snapshot_path: PathBuf` —— 快照文件的存储路径
  - `mem_file_path: PathBuf` —— 内存转储文件的存储路径
  - `snapshot_type: SnapshotType` —— 全量快照或增量快照

## 五、安全相关结构

### SeccompFilter

- **源文件：** `src/seccompiler/src/lib.rs`
- **职责：** 表示一组编译后的 seccomp-BPF 过滤规则
- **工作方式：**
  - 通过 JSON 配置文件定义允许的系统调用白名单
  - 编译为 BPF 字节码后通过 `prctl(PR_SET_SECCOMP)` 加载到内核
  - 为 VMM 主线程、vCPU 线程和 API 线程分别配置独立的过滤规则

### Jailer（运行时配置）

- **源文件：** `src/jailer/src/env.rs`
- **职责：** Jailer 进程的环境配置，定义沙箱的各项参数
- **关键字段：**
  - `chroot_dir: PathBuf` —— chroot 根目录
  - `exec_file_path: PathBuf` —— Firecracker 可执行文件路径
  - `uid: u32 / gid: u32` —— 降权后的用户与组 ID
  - `cgroup_ver: CgroupVersion` —— cgroup 版本（v1 或 v2）
  - `resource_limits: ResourceLimits` —— 文件描述符数量等资源限制

## 六、数据结构关系图

从宏观上看，Firecracker 的数据结构形成了清晰的层次关系：用户通过 API 提交的配置首先汇聚到 `VmResources` 中，然后由 builder 模块将其转化为运行时的 `Vmm` 实例。`Vmm` 内部持有 `GuestMemoryMmap`（内存）、`VcpuHandle`（计算）和各类设备（I/O）三大核心资源。`SeccompFilter` 和 Jailer 则从外部包裹整个 VMM，构成安全边界。

理解这些数据结构之间的所有权关系（谁持有谁、谁借用谁），是掌握 Firecracker Rust 代码的关键。每个 `Arc<Mutex<T>>` 的使用背后，都反映了一个跨线程共享的设计决策。

## 本章小结

本附录汇总了 Firecracker 源码中最核心的数据结构。这些 struct、enum 和 trait 构成了整个 VMM 的骨架：从顶层的 `Vmm` 和 `VmResources`，到底层的 `GuestMemoryMmap` 和各类 virtio 设备实现，再到横切关注点的 `SeccompFilter` 和 `ApiRequest`。建议读者在阅读源码时将本附录作为索引使用——当遇到不熟悉的类型时，可以快速回查其职责、关键字段和源文件位置，从而保持阅读的连贯性。
