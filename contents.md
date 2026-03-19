# 目录

## 第一部分：全景

- [第 1 章 项目概览与设计哲学](/chapters/01-overview)
- [第 2 章 Repo 结构与模块依赖](/chapters/02-repo-structure)

## 第二部分：核心虚拟化

- [第 3 章 VMM 架构核心抽象](/chapters/03-vmm-architecture)
- [第 4 章 KVM 接口封装](/chapters/04-kvm-wrapper)
- [第 5 章 vCPU 模型与寄存器状态](/chapters/05-vcpu-model)
- [第 6 章 内存管理与 GuestMemory](/chapters/06-memory-management)

## 第三部分：virtio 设备

- [第 7 章 virtio 设备框架](/chapters/07-virtio-framework)
- [第 8 章 virtio-net 网络虚拟化](/chapters/08-virtio-net)
- [第 9 章 virtio-block 块设备](/chapters/09-virtio-block)
- [第 10 章 virtio-vsock 主客通信](/chapters/10-virtio-vsock)
- [第 11 章 串口与中断控制器](/chapters/11-serial-interrupts)

## 第四部分：启动与管理

- [第 12 章 microVM 启动序列](/chapters/12-boot-sequence)
- [第 13 章 jailer 沙盒隔离](/chapters/13-jailer)
- [第 14 章 Snapshot 与 Restore](/chapters/14-snapshot-restore)

## 第五部分：API 与配置

- [第 15 章 HTTP API 设计](/chapters/15-http-api)
- [第 16 章 配置管理与验证](/chapters/16-config-validation)

## 第六部分：运行时

- [第 17 章 epoll 事件循环](/chapters/17-epoll-event-loop)
- [第 18 章 seccomp 过滤器](/chapters/18-seccomp)

## 第七部分：安全与性能

- [第 19 章 威胁模型与安全设计](/chapters/19-threat-model)
- [第 20 章 性能优化与启动时间](/chapters/20-performance)

## 第八部分：生态

- [第 21 章 日志与指标系统](/chapters/21-logging-metrics)
- [第 22 章 与 AWS Lambda 的集成](/chapters/22-aws-lambda)

## 附录

- [附录 A 推荐阅读路径](/chapters/appendix-a-reading-path)
- [附录 B 核心数据结构速查](/chapters/appendix-b-data-structures)
- [附录 C 名词解释](/chapters/appendix-c-glossary)
