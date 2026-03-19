import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Firecracker 源码解析',
  description: 'AWS 开源的安全 microVM——Rust 实现的轻量级虚拟化引擎深度剖析',
  lang: 'zh-CN',
  head: [
    ['link', { rel: 'icon', href: '/logo.png' }],
  ],
  themeConfig: {
    logo: '/logo.png',
    nav: [
      { text: '首页', link: '/' },
      { text: '目录', link: '/contents' },
      { text: 'GitHub', link: 'https://github.com/firecracker-microvm/firecracker' },
    ],
    sidebar: [
      {
        text: '目录',
        link: '/contents',
      },
      {
        text: '第一部分：全景',
        collapsed: false,
        items: [
          { text: '第 1 章 项目概览与设计哲学', link: '/chapters/01-overview' },
          { text: '第 2 章 Repo 结构与模块依赖', link: '/chapters/02-repo-structure' },
        ],
      },
      {
        text: '第二部分：核心虚拟化',
        collapsed: false,
        items: [
          { text: '第 3 章 VMM 架构核心抽象', link: '/chapters/03-vmm-architecture' },
          { text: '第 4 章 KVM 接口封装', link: '/chapters/04-kvm-wrapper' },
          { text: '第 5 章 vCPU 模型与寄存器状态', link: '/chapters/05-vcpu-model' },
          { text: '第 6 章 内存管理与 GuestMemory', link: '/chapters/06-memory-management' },
        ],
      },
      {
        text: '第三部分：virtio 设备',
        collapsed: false,
        items: [
          { text: '第 7 章 virtio 设备框架', link: '/chapters/07-virtio-framework' },
          { text: '第 8 章 virtio-net 网络虚拟化', link: '/chapters/08-virtio-net' },
          { text: '第 9 章 virtio-block 块设备', link: '/chapters/09-virtio-block' },
          { text: '第 10 章 virtio-vsock 主客通信', link: '/chapters/10-virtio-vsock' },
          { text: '第 11 章 串口与中断控制器', link: '/chapters/11-serial-interrupts' },
        ],
      },
      {
        text: '第四部分：启动与管理',
        collapsed: false,
        items: [
          { text: '第 12 章 microVM 启动序列', link: '/chapters/12-boot-sequence' },
          { text: '第 13 章 jailer 沙盒隔离', link: '/chapters/13-jailer' },
          { text: '第 14 章 Snapshot 与 Restore', link: '/chapters/14-snapshot-restore' },
        ],
      },
      {
        text: '第五部分：API 与配置',
        collapsed: false,
        items: [
          { text: '第 15 章 HTTP API 设计', link: '/chapters/15-http-api' },
          { text: '第 16 章 配置管理与验证', link: '/chapters/16-config-validation' },
        ],
      },
      {
        text: '第六部分：运行时',
        collapsed: false,
        items: [
          { text: '第 17 章 epoll 事件循环', link: '/chapters/17-epoll-event-loop' },
          { text: '第 18 章 seccomp 过滤器', link: '/chapters/18-seccomp' },
        ],
      },
      {
        text: '第七部分：安全与性能',
        collapsed: false,
        items: [
          { text: '第 19 章 威胁模型与安全设计', link: '/chapters/19-threat-model' },
          { text: '第 20 章 性能优化与启动时间', link: '/chapters/20-performance' },
        ],
      },
      {
        text: '第八部分：生态',
        collapsed: false,
        items: [
          { text: '第 21 章 日志与指标系统', link: '/chapters/21-logging-metrics' },
          { text: '第 22 章 与 AWS Lambda 的集成', link: '/chapters/22-aws-lambda' },
        ],
      },
      {
        text: '附录',
        collapsed: false,
        items: [
          { text: '附录 A 推荐阅读路径', link: '/chapters/appendix-a-reading-path' },
          { text: '附录 B 核心数据结构速查', link: '/chapters/appendix-b-data-structures' },
          { text: '附录 C 名词解释', link: '/chapters/appendix-c-glossary' },
        ],
      },
    ],
    outline: {
      level: [2, 3],
      label: '本页目录',
    },
    search: {
      provider: 'local',
      options: {
        translations: {
          button: { buttonText: '搜索', buttonAriaLabel: '搜索' },
          modal: {
            noResultsText: '未找到相关结果',
            resetButtonTitle: '清除查询',
            footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' },
          },
        },
      },
    },
    footer: {
      message: '基于 VitePress 构建',
      copyright: 'Firecracker 源码解析 | 2024-2025',
    },
    docFooter: {
      prev: '上一章',
      next: '下一章',
    },
  },
  vite: {
    css: {
      preprocessorOptions: {},
    },
  },
})
