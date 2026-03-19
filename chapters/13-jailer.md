# 第 13 章 jailer 沙盒隔离

> "Security is always excessive until it's not enough." —— Robbie Sinclair

Firecracker 本身提供了虚拟化隔离，但虚拟化不是万能的。如果 VMM 进程本身被攻破——例如通过 guest 利用 KVM 或设备模拟的漏洞——那么攻击者将获得 host 上 VMM 进程的全部权限。Jailer 正是为了应对这一场景而设计的：它在 Firecracker 进程周围构建多层操作系统级别的沙盒，即使 VMM 被攻破，攻击者能造成的危害也被严格限制。

## 13.1 为什么是独立的二进制文件

Jailer 的代码位于 `// src/jailer/src/main.rs`，它被编译为一个独立的二进制文件而不是 Firecracker 的一部分。这个设计决策背后有深刻的安全考量。

沙盒的建立需要特权操作：创建 chroot 环境、配置 cgroup、设置命名空间、切换用户身份。如果将这些操作嵌入 Firecracker 本身，那么 Firecracker 就需要以 root 身份运行，这违背了最小权限原则。通过将特权操作隔离到 Jailer 中，可以实现一个清晰的权限降级流程：Jailer 以 root 启动，完成所有特权配置后，以非特权用户身份 exec 启动 Firecracker。一旦 Firecracker 开始运行，root 权限就不复存在。

这种 "setup-then-drop-privileges" 模式在安全敏感的系统中非常常见（如 Chromium 的 sandbox broker），它确保了运行时进程只拥有最低限度的权限。

## 13.2 Jailer 启动序列全貌

Jailer 的启动是一个精心编排的多阶段流程，在 `// src/jailer/src/env.rs` 中实现。以下是完整的执行步骤：

**第一阶段：参数解析与环境准备**

Jailer 接受一系列命令行参数，包括 Firecracker 二进制路径、jail ID、UID/GID、cgroup 配置等。这些参数定义了沙盒的具体形态。

**第二阶段：创建 jail 目录结构**

Jailer 在 `/srv/jailer/firecracker/<id>/root/` 下创建 chroot 根目录。这个路径包含了唯一标识符，确保多个 microVM 的 jail 不会冲突。目录结构极其简单——只包含 Firecracker 二进制文件和必要的设备节点（如 `/dev/kvm`、`/dev/urandom`、`/dev/net/tun`）。

**第三阶段：cgroup 配置**

Jailer 将即将创建的 Firecracker 进程加入指定的 cgroup，以限制其资源使用。

**第四阶段：命名空间隔离**

Jailer 调用 `unshare()` 系统调用创建新的命名空间。

**第五阶段：chroot 与权限降级**

执行 `chroot()` 切换根文件系统，然后通过 `setgroups()`、`setgid()`、`setuid()` 降级到非特权用户。

**第六阶段：exec Firecracker**

最后，Jailer 调用 `exec()` 将自身替换为 Firecracker 进程。此时 Firecracker 继承了所有沙盒限制，但不知道也不关心这些限制是如何建立的。

## 13.3 chroot jail 的意义

chroot 将进程的文件系统根目录重新定位到一个最小化的目录树中。在 chroot 之后，Firecracker 看到的整个文件系统只有 Jailer 预先放置的几个文件。即使攻击者获得了 Firecracker 进程的控制权，也无法访问 host 上的任何其他文件。

Jailer 在 chroot 目录中创建的设备节点通过 `mknod` 系统调用生成，只包含 Firecracker 运行所需的最小集合。`/dev/kvm` 提供虚拟化支持，`/dev/urandom` 提供随机数，`/dev/net/tun` 支持网络设备。没有 `/dev/sda`，没有 `/proc`，没有 `/sys`——一切不必要的接口都被切断。

## 13.4 cgroup 资源限制

cgroup（Control Groups）是 Linux 内核提供的资源限制机制。Jailer 支持 cgroup v1 和 v2 两种接口，实现位于 `// src/jailer/src/cgroup.rs`。

为什么要同时支持 v1 和 v2？因为 cgroup 的世界正处于迁移期。旧版本的 Linux 发行版使用 v1，新版本（如 Ubuntu 22.04+）默认使用 v2。作为基础设施软件，Firecracker 必须在两种环境中都能正常工作。Jailer 通过检测 `/sys/fs/cgroup` 的挂载类型来判断当前系统使用的 cgroup 版本，然后选择对应的配置路径。

Jailer 通过命令行参数接受 cgroup 配置，将 Firecracker 进程加入指定的 cgroup 层级。典型的资源限制包括：

- **CPU**：通过 `cpuset` 将 vCPU 绑定到特定的物理核心，避免跨核调度的缓存抖动
- **内存**：通过 `memory.limit_in_bytes`（v1）或 `memory.max`（v2）限制 VMM 进程的内存使用
- **CPU 时间**：通过 `cpu.cfs_quota_us` 和 `cpu.cfs_period_us` 限制 CPU 时间配额

这些限制确保了一个 microVM 不能通过耗尽 host 资源来影响其他 microVM 或 host 上的其他服务。

## 13.5 命名空间隔离

Linux 命名空间是内核级别的隔离机制，每种命名空间隔离一种系统资源的视图。Jailer 使用了以下命名空间：

**PID 命名空间**：在新的 PID 命名空间中，Firecracker 进程的 PID 为 1，它看不到 host 上的任何其他进程。即使攻击者能发送信号或读取 `/proc`，也只能看到 microVM 相关的进程。

**Mount 命名空间**：配合 chroot 使用，确保挂载操作不会影响 host 的文件系统。Jailer 在新的 mount 命名空间中将 chroot 目录重新挂载，并添加必要的 tmpfs 挂载点。

**Network 命名空间**：Firecracker 运行在独立的网络命名空间中，只能看到预先配置好的网络接口（通常是 TAP 设备）。它无法直接访问 host 的网络栈，从而防止了网络层面的逃逸攻击。

为什么不使用 User 命名空间？User 命名空间可以让非特权用户创建隔离环境，但它也引入了额外的内核攻击面。Firecracker 的设计选择是：在 Jailer 中使用真实的 root 权限完成配置，然后切换到真实的非特权用户。这比依赖 user namespace 的映射更加简单和安全。

## 13.6 UID/GID 映射与权限模型

Jailer 要求调用者指定运行 Firecracker 的 UID 和 GID。这些必须是非 root 用户（UID > 0）。Jailer 在完成所有特权操作后，依次调用：

1. `setgroups(0, NULL)` —— 清除所有补充组
2. `setgid(gid)` —— 设置组 ID
3. `setuid(uid)` —— 设置用户 ID

这个顺序很重要。如果先 setuid 再 setgid，进程将失去更改组的权限。而 setgroups 必须在 setgid 之前调用，因为某些系统在 setgid 后不允许修改补充组列表。

在生产环境中，通常为每个 microVM 分配一个唯一的 UID，这样即使在极端情况下（如 chroot 逃逸），不同 microVM 的进程也无法互相干扰，因为它们以不同的系统用户身份运行。

## 13.7 seccomp 的集成点

虽然 seccomp 过滤器的加载发生在 Firecracker 进程内部（而非 Jailer 中），但 Jailer 通过环境设置为 seccomp 的有效运行创造了条件。chroot 环境中没有 `/proc/self/status` 以外的敏感接口，命名空间隔离确保了即使 seccomp 被绕过，攻击面仍然是最小的。

Jailer 和 seccomp 的分工体现了纵深防御的理念：Jailer 负责进程级别的隔离（文件系统、网络、资源），seccomp 负责系统调用级别的过滤。两者互为补充，任何单一层的失败都不会导致完全的安全崩溃。

## 本章小结

本章深入分析了 Jailer 的设计与实现。作为 Firecracker 的安全伴侣，Jailer 是一个独立的特权二进制文件，负责在 Firecracker 进程周围构建多层沙盒：chroot 限制文件系统访问，cgroup 限制资源使用，命名空间隔离进程、网络和挂载视图，UID 降级确保最小权限运行。Jailer 的启动序列遵循"以特权配置，以非特权运行"的原则，通过 exec 实现干净的权限转换。这种将安全配置与业务逻辑分离到不同二进制文件的设计，既保证了安全性，又保持了 Firecracker 本身代码的简洁性。理解 Jailer，就是理解 Firecracker 如何在 KVM 虚拟化之上再叠加操作系统级的纵深防御。
