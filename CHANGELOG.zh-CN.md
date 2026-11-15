# 更新日志

本文件记录本插件所有值得注意的改动。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.0] - 2026-11-15

首个版本。

### 新增

- 四个模型面向工具：`vm_list`（状态 / 规格 / 实时占用 / 网络 / 路径）、`vm_power`（启动、关机、挂起、暂停、恢复、重置、状态查询）、`vm_snapshot`（列出 / 创建 / 回滚 / 删除）、`vm_config`（查看、改写 VMX 参数、登记、取消登记、删除）。
- 设置页「VMware 虚拟机」：卡片式状态与占用显示、电源操作（软 / 硬两种力度）、快照面板、参数面板、三种删除语义（只移除记录 / 移到回收站 / 彻底删除）、搜索目录管理、错误日志开关。
- 对话内 `/vm` 命令：列状态、单台详情、电源操作、快照。
- 四个工具的对话内卡片，以及新会话里「只有命令」时把结果渲染到输入框上方 dock 的兜底面板。
- 权限模型：`permissions.power/snapshot/config/delete`，`delete` 默认关闭；工具层与设置接口层各判一次。
- `vmrun` 发现（配置 → 环境变量 → Windows 注册表 → 安装目录 → PATH）与主机类型自动协商（ws / player / fusion）。
- 能力探测：从 `vmrun` 的用法输出解析版本与命令表，界面据此禁用不支持的按钮。
- 失败归类：vm-missing / vm-state / busy / tools / permission / encrypted / bad-host-type / vmrun-missing / timeout，每类附「该往哪里修」。
- 电源动作之后等待并确认状态变化；等不到时明确报告「已发出但未确认」。
- 宿主进程占用采集：Windows 用 PowerShell（CPU%、工作集、私有字节、线程、IO），macOS / Linux 退回 `ps`（CPU、RSS）。
- 中文 / 英文双语，跟随 DSH 的「设置 → 通用 → 语言」；界面与工具输出同时切换。
- 零依赖、零构建：Host 侧纯 ESM，客户端手写 React 元素。

### 设计说明

- **运行态以 `vmrun list` 为准。** 残留的 `.vmx.lck` 目录在崩溃或强制关机后不会被清理，按它判断会把关机中的虚拟机显示成运行中；文件启发式只在列表读取失败时使用。
- **暂停状态由插件记录。** `vmrun list` 把暂停中的虚拟机也算运行中，没有第二个可查的状态位；通过 VMware 界面暂停的虚拟机因此显示为运行中。
- **改名 / 删除都要求显式意图。** 删除必须给出模式，`purge` 还需要 `confirm`；重名虚拟机在列表里自动带上路径，解析时遇到歧义直接报错而不是猜。
