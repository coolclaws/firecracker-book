---
layout: home
hero:
  name: Firecracker 源码解析
  text: Rust 实现的轻量级虚拟化引擎深度剖析
  tagline: AWS 开源的安全 microVM，为 Lambda 与 Fargate 提供底层支撑
  image:
    src: /logo.png
    alt: Firecracker Logo
  actions:
    - theme: brand
      text: 开始阅读
      link: /chapters/01-overview
    - theme: alt
      text: 查看目录
      link: /contents
features:
  - icon:
      src: /icons/microvm.svg
    title: microVM 架构
    details: 精简的虚拟机监控器，每个 VM 仅约 5MB 内存开销，毫秒级启动时间，专为多租户场景设计
  - icon:
      src: /icons/rust.svg
    title: Rust 内存安全
    details: 全 Rust 实现，利用所有权系统和类型系统消除内存安全漏洞，在编译期杜绝数据竞争
  - icon:
      src: /icons/kvm.svg
    title: KVM 深度集成
    details: 直接操作 Linux KVM 接口，最小化虚拟化开销，实现接近原生的性能表现
  - icon:
      src: /icons/aws.svg
    title: AWS 生产级验证
    details: 作为 AWS Lambda 和 Fargate 的底层引擎，经受数十亿次调用的生产环境考验
---

<style>
:root {
  --vp-c-brand-1: #ff4f00;
  --vp-c-brand-2: #e64500;
  --vp-c-brand-3: #cc3c00;
  --vp-c-brand-soft: rgba(255, 79, 0, 0.14);
  --vp-home-hero-name-color: transparent;
  --vp-home-hero-name-background: linear-gradient(135deg, #ff4f00, #ff8c00);
}
</style>
