<div align="center">

# dsh-vm-control

**简体中文** | [English](README.md)

**DeepSeek Harness 的 VMware 虚拟机管理插件：电源、快照、实时占用、网络配置与 VMX 参数，一处管完。**

[![tests](https://github.com/scientificmaniac/dsh-vm-control/actions/workflows/test.yml/badge.svg)](https://github.com/scientificmaniac/dsh-vm-control/actions/workflows/test.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[更新日志](CHANGELOG.zh-CN.md) · [安全说明](SECURITY.zh-CN.md)

</div>

## 概述

插件调用 VMware 自带的 `vmrun`（Workstation / Player / Fusion 都带），提供三条互补的通道：

- **模型面向的四个工具** —— `vm_list`、`vm_power`、`vm_snapshot`、`vm_config`，智能体可以按虚拟机名或 vmx 路径操作本机虚拟机。
- **设置页** —— 卡片式列出台数、规格、实时 CPU/内存占用、网卡与路径，并提供电源、快照、参数与删除按钮。列表按固定间隔自动刷新，页面隐藏时停止。
- **对话里的 `/vm` 命令** —— 不经过模型直接看状态、开关机、拍快照。
- **与 dsh-ssh-vault 的联动** —— 选中虚拟机后一键把地址、端口、账号与认证方式导入 SSH 保险库；对方未安装时降级为可复制的命令。见[联动说明](#与-dsh-ssh-vault-的联动)。

它**不会**改变虚拟机的文件布局，也不做磁盘格式转换：所有动作最终都落成一条 `vmrun` 命令，或对 VMX 文本的定点改写。

## 环境要求

| 项目 | 要求 |
| --- | --- |
| Node | ≥ 20 |
| VMware | Workstation Pro / Workstation / Player / Fusion（自带 `vmrun`） |
| 平台 | Windows、macOS、Linux |
| 权限 | 运行 DSH 的账号能读写虚拟机目录；GUI 启动需要交互式桌面会话 |

`vmrun` 的发现顺序：显式配置 `vmrunPath` → 环境变量 `VMRUN_PATH` → Windows 注册表（`HKLM\SOFTWARE\...\VMware Workstation|Player`）→ 常见安装目录 → `PATH`。找不到时设置页与工具都会说明「装什么、或配哪个字段」，而不是抛一个 `ENOENT`。

## 安装

```bash
# 已发布到 npm 时
dsh plugin --profile desktop install dsh-vm-control

# 或在插件目录里从本地安装
dsh plugin --profile desktop install .
```

安装后**重启 DSH**：Host 侧工具与设置路由在启动时加载。

## 快速开始

1. 打开 **设置 → VMware 虚拟机**。
2. 「搜索目录」里加入存放虚拟机的根目录（例如 `E:\Virtual Machines`）。插件会扫描其中的 `*.vmx`，之后新建的虚拟机自动出现；不在搜索目录里的虚拟机也可以直接「添加虚拟机」指向某个 `.vmx`。
3. 卡片上直接开机关机、拍快照、改参数。
4. 在对话里说「把 Kali 启动起来，然后看一眼内存占用」，模型调用 `vm_power` 与 `vm_list`。

## 工具

| 工具 | 作用 | 典型说法 |
| --- | --- | --- |
| `vm_list` | 列出虚拟机：状态、规格、实时占用、网卡、路径；`vm=` 给单台详情 | 「现在有哪些虚拟机在跑」 |
| `vm_power` | `start` / `stop` / `suspend` / `pause` / `unpause` / `reset` / `status` | 「把 CentOS 7 关掉」 |
| `vm_snapshot` | `list` / `create` / `revert` / `delete` | 「给 Ubuntu 拍一个升级前的快照」 |
| `vm_config` | `list` / `show` / `set` / `networks` / `ssh` / `register` / `unregister` / `delete` | 「把 Kali 的 CPU 调到 4 核」 |

约定：

- **先看状态再动手。** `vm_power` 会先判定当前状态：对已关机的虚拟机执行 `stop`、对运行中的执行 `start` 都会被拒绝并说明原因，而不是让 vmrun 抛一句 `The virtual machine is not powered on`。
- **动作之后确认。** `vmrun start` 成功返回只代表命令被接受；工具会等状态真的变化（最多到各自的超时）再报告结果。等不到时会明说「已发出但未能确认」，不会把不确定说成成功。
- **软/硬两种力度。** `stop` / `suspend` / `reset` 默认 `soft`（请客户机自行处理，需要 VMware Tools），`hard` 相当于拔电源。
- **加密虚拟机**用 `credential_ref` 指向 DSH 凭据，插件只存引用；口令仅在 VMware 明确报「这台虚拟机是加密的」时才向凭据服务索取。
- **删除分三种。** `keep_files`（只移除记录）、默认（把目录移到插件回收站）、`purge`（`vmrun deleteVM`，连磁盘一起删，需要显式 `confirm` 与 `permissions.delete`）。

## `/vm` 命令

```
/vm                             列出全部虚拟机
/vm Kali Linux status           单台详情（含快照）
/vm Kali Linux start            开机（另有 stop / suspend / pause / resume / reset）
/vm Kali Linux snapshots        列出快照
/vm Kali Linux snap before-upgrade   新建快照
/vm Kali Linux delete confirm   移到回收站（需要 permissions.delete）
```

命令名用 `vm` 而不是 `vmware`，是为了在输入框里少打字；参数里中英文标点都认。

## 与 dsh-ssh-vault 的联动

虚拟机装好 sshd 之后，最顺手的下一步是把它加进 SSH 保险库（`dsh-ssh-vault`）。插件把这一步做成「选中虚拟机 → 点导入 → 确认」。

**触发入口**

| 入口 | 行为 |
| --- | --- |
| 设置页 · 虚拟机卡片 ·「SSH 导入」 | 打开导入面板：探测保险库、准备建议值、确认后写入 |
| `vm_config action=ssh vm=<名字>` | 只给建议（别名 / 地址 / 账号 / 认证 / 等价命令）与入口说明 |

工具刻意**不能**直接写保险库：密文由 dsh-ssh-vault 用自己的密钥加密，其它插件没有正当途径写那个文件。模型能做的是把数据准备好、告诉你点哪里；写入由你在设置页确认。

**导入的字段范围**

| 字段 | 来源 |
| --- | --- |
| `alias` | 虚拟机名规范化（非 ASCII 折成分隔符）；同批虚拟机重名时自动加 `-2` |
| `host` | VMware Tools 报告的客户机 IP；取不到就留空由你填 |
| `port` | 默认 22，可在面板里改 |
| `username` | Linux / BSD 客户机建议 `root`，其它留空 |
| `authType` / `privateKeyPath` / `password` / `passphrase` | 存在默认私钥（`~/.ssh/id_ed25519` → `id_ecdsa` → `id_rsa`）就用私钥认证，否则选口令认证，由你输入 |
| `description` / `tags` | `<虚拟机名> · VMware`，标签为 `vmware` + 虚拟机自身的标签 |

**不导入的字段**：`sudoPassword`、`bindAddress`、私钥文件上传、别名改名。这些要么与虚拟机无关，要么需要你在保险库页面里自己决定——字段范围固定在一个白名单里，多传一个字段就等于替用户做了他没同意的决定。

**成功与失败**

- 成功：`已导入到 SSH 保险库：<别名>`，并提示之后可以用 `ssh_run` 的别名执行命令。同名主机存在时是**更新**，提示会写明「已更新」。
- 失败：原样显示 dsh-ssh-vault 的报错（别名字符非法、缺口令、私钥不可读……），判定权在对方；本地只做格式预检，省一次往返。
- 面板提前警告「保险库里已有同名主机，保存会覆盖」，并给一个「换一个别名」按钮。

**未安装 / 不可用时**

面板打开时先 `POST ssh-vault/list` 探测（2.5 秒超时）：

| 探测结果 | 表现 |
| --- | --- |
| 路由不存在（404，或返回 HTML fallback） | 「未检测到 dsh-ssh-vault」+ 安装命令 + **仍然可复制** SSH 命令，手工加进任何 SSH 客户端 |
| 401 / 403 | 提示宿主拒绝了这次请求，刷新后重试 |
| 其它错误 | 显示具体原因；编辑与复制不受影响 |

也就是说，联动缺席时**没有任何功能被锁死**：电源、快照、参数、删除照常，导入退化成「帮你把命令拼好」。

**权限**：导入受 `permissions.config` 影响——为 `false` 时面板里的导入按钮禁用并说明原因（写另一个插件的配置属于 config 级操作）。探测与复制不受影响。

**安全**：口令只出现在提交给 dsh-ssh-vault 的那一次请求里，本插件不落盘、不写日志、也不回读保险库；不会把虚拟机的加密口令当作 SSH 口令复用。

## 权限模型

四个开关都在 Loader 配置的 `permissions` 下，**默认只关掉最危险的一个**：

| 作用域 | 默认 | 覆盖的能力 |
| --- | --- | --- |
| `power` | `true` | 启动、关机、挂起、暂停、恢复、重置 |
| `snapshot` | `true` | 创建 / 回滚 / 删除快照（列快照始终允许） |
| `config` | `true` | 改写 VMX、登记 / 取消登记 |
| `delete` | **`false`** | 仅 `purge`（连磁盘删除）；「只移除记录」与「移到回收站」不受此限制 |

被关掉的能力在**工具层与设置接口层各拒绝一次**：只拦一层的话，另一条通道就成了绕过它的后门。拒绝消息会明确指出这是插件配置，而不是 VMware 的拒绝。

```yaml
- id: vm-control
  name: 'dsh-vm-control'
  config:
    permissions:
      delete: false      # 需要彻底删除时改成 true 并重启 DSH
```

## 配置项

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `dataDir` | `%DSH_HOME%/vm-control` | 插件数据（`vms.json`、日志、回收站） |
| `searchRoots` | 平台默认的 VMware 目录 | 首次运行时写入的搜索目录，之后以设置页为准 |
| `scanDepth` | `3` | 扫描深度；更深的虚拟机需要直接添加或提高此值 |
| `vmrunPath` | 自动发现 | `vmrun` 绝对路径 |
| `vmType` | `auto` | `ws` / `player` / `fusion` / `auto`；auto 会逐个尝试 |
| `vmrunTimeoutMs` | `90000` | 单次 vmrun 调用的默认超时 |
| `timeoutMs` | 按动作 | 等待状态变化的默认上限 |
| `permissions` | 见上表 | 四个作用域开关 |
| `collectMetrics` | `true` | 是否采集宿主侧 CPU/内存占用 |
| `logging` | `false` | `true` 或 `{ enabled, dir, maxBytes }`；关闭时不写任何日志 |

## 状态与资源是怎么判断的

这部分值得说清楚，因为它决定了界面上的数字能不能信：

- **运行态**以 `vmrun list` 为准。它把暂停中的虚拟机也算「运行中」，所以「暂停」这一状态由插件自己记住（`pause` 之后写入记录）——通过 VMware 窗口暂停的虚拟机会显示为运行中，这是已知且无法从命令行消除的差别。
- **残留的 `.vmx.lck` 目录不可信。** VMware 崩溃或强制断电后不会清理它；早期实现按锁目录判断，结果把七台关机状态的虚拟机全部显示成「运行中」。现在只有在 `vmrun list` 读取失败时才退回文件启发式。
- **挂起**看 `.vmss` 镜像文件：挂起本质上是关机 + 内存镜像，`vmrun list` 不会包含它。
- **资源占用**来自宿主进程：每台运行中的虚拟机对应一个 `vmware-vmx` 进程，命令行里带着它服务的 vmx 路径，于是「进程 → 虚拟机」的映射是确定的。Windows 用 PowerShell 一次取回 CPU%、工作集、私有字节、线程数与 IO；macOS / Linux 退回 `ps`，只有 CPU 与 RSS（那些平台上没有等价物，缺的字段留空而不是编一个值）。
- **网络信息**读自 VMX：连接方式（nat / bridged / hostonly / custom）、虚拟网络名（17.x 在 `vnet`，老版本在 `networkName`）、虚拟设备型号、MAC。客户机内部 IP 需要 VMware Tools，只在点「客户机信息」时按需查询。
- **采集失败不会让列表消失**：占用读不到时那一栏留空并给出原因，虚拟机本身照常可管。

## 错误处理

vmrun 的报错是英文散文，同一句 `Cannot open VM` 既可能是路径错、也可能是被锁。插件把失败归成固定类别，并在结果里给出「该往哪里修」：

| 类别 | 含义 |
| --- | --- |
| `vm-missing` | vmx 不存在、被移动，或所在磁盘没挂载 |
| `vm-state` | 当前状态不允许这个动作 |
| `busy` | 文件被占用：另一个 VMware 窗口持有它，或上一次切换还没结束 |
| `tools` | VMware Tools 未安装 / 未运行，客户机相关的操作不可用 |
| `permission` | 宿主拒绝了文件或进程操作 |
| `encrypted` | 虚拟机加密，需要 `-vp` 口令（配置 `credential_ref`） |
| `bad-host-type` | `-T` 类型不对（Workstation 用 `ws`，Player 用 `player`，Fusion 用 `fusion`） |
| `vmrun-missing` | 找不到 `vmrun` |
| `timeout` | 命令在时限内没有返回；先确认状态再决定是否重试 |

设置页的「错误日志」默认关闭；开启后工具与接口的失败会带堆栈写入 `dataDir/logs/diagnostics.log`，形如 `-vp <口令>` 的内容在落盘前被抹成 `***`。

## 版本兼容与可扩展性

- **能力探测而非版本号比较。** 插件直接跑一次不带参数的 `vmrun`，从它的用法输出里读出命令表，于是「这个版本支不支持 `deleteVM` / `clone` / `listHostNetworks`」有确定答案；界面会据此禁用不支持的按钮，工具会解释是哪一版缺了什么。
- **主机类型自动协商。** `vmType: auto` 时依次用 `ws` / `player` / `fusion` 试一次 `list`，第一个成功的胜出；之后所有调用沿用该类型。
- **加一条新动作**：在 `lib/vmrun.js` 里加一个方法（参数拼装 + 超时），在 `lib/inventory.js` 里加语义检查（状态、权限边界），在 `index.js`/`lib/vm-api.js` 里暴露出去，最后在 `lib/format.js` 里给它一句人话。分层是刻意的：新增动作不需要碰 UI 的其它部分。
- **加一个新工具**：`index.js` 里 `ctx.effect(() => ctx.tools.register(registerTool({...})))` 即可；客户端只要在 `tool.call.toolview` 的键列表里加上工具名，就会自动获得同一套卡片。

## 已知限制

- 通过 VMware 界面暂停的虚拟机，插件显示为「运行中」（没有可查的命令行状态位）。
- macOS / Linux 上只有 CPU 与 RSS，没有 IO 细分与线程数。
- 改写 VMX 只能在关机状态下进行（VMware 自己也写同一个文件）；挂起状态允许但会提示挂起镜像可能与新硬件不匹配。
- `purge` 删除不可恢复；回收站只是「目录搬走」，不写入系统回收站。
- 加密虚拟机的口令只能通过命令行 `-vp` 传给 vmrun（VMware 没有别的通道），因此那个进程存活期间本机进程列表里能看到它。插件只在 VMware 明确要求时才这么做。
- 只管理本机 VMware 产品；ESXi / vCenter 的 `-T viserver` 形态不在范围内。

## 安全

- 设置接口挂在 `/vm-control/` 前缀下，经宿主 `connection.requestRejection` 做 Host/Origin 校验与浏览器认证；与内置 `/api` 使用同一套判定。
- 除 `register` 外，所有动作都先把 id 解析成库存里真实存在的虚拟机，**从不使用请求体里的路径**去读写文件或启动进程；`register` 要求绝对路径、`.vmx` 后缀且文件确实存在。
- 打开目录只打开插件自己算出来的路径（虚拟机目录、回收站、日志目录），不接受调用方指定。

## 插件结构

| 文件 | 职责 |
| --- | --- |
| `index.js` | 插件入口：四个工具、权限闸门、`/vm` 命令、设置路由与语言同步 |
| `client.js` | 浏览器半边：设置页、工具卡片、`/vm` 命令视图、dock 兜底面板 |
| `lib/vmrun.js` | vmrun 发现、主机类型协商、能力探测、命令封装与失败归类 |
| `lib/vmx.js` | VMX 文本解析与定点改写（改写前留 `.bak`） |
| `lib/inventory.js` | 把「磁盘上的 vmx」「vmrun 说谁在运行」「插件记住了什么」合成一张表，并提供带状态检查的动作 |
| `lib/metrics.js` | 宿主进程占用采集（PowerShell / `ps`）与字节格式化 |
| `lib/store.js` | `vms.json` 的读写：原子写、串行化、损坏自愈 |
| `lib/vm-api.js` | 设置接口 `/vm-control/*`（信任栅栏 + 权限二次判定） |
| `lib/format.js` | 把数据渲染成模型可读的文本 |
| `lib/i18n.js`、`lib/locales/vm.js` | 中英文案与运行时切换 |
| `lib/diagnostics.js` | 可开关的错误日志（落盘前抹除 `-vp` 口令） |
| `test/*.mjs` | 单元、接口、客户端冒烟、只读联调 |

分层的规矩很简单：新增一条动作时，**参数拼装进 `vmrun.js`，语义检查进 `inventory.js`，出口进 `index.js` 与 `vm-api.js`，人话进 `format.js`**。这样加动作不需要改动界面，也不会出现「工具能做、界面不能」的两套逻辑。

## 已验证环境

| 环境 | 结果 |
| --- | --- |
| Windows 11 · VMware Workstation 17.6（vmrun 1.17.0）· Node 26 | 7 台真实虚拟机：状态、规格、网卡、磁盘、网络表、进程采集全部通过 |
| dsh-ssh-vault 2.3.0（真实源码，临时保险库） | 口令 / 私钥两种认证的保存、覆盖语义、别名校验、列表脱敏全部通过 |
| 无 VMware 的机器 | 单元 / 接口 / 客户端测试全部通过；列表与工具给出「找不到 vmrun」的引导 |

macOS（Fusion）与 Linux 走同一套代码路径与 `ps` 采集，但未在真实 Fusion 主机上跑过；如果你遇到了差异，欢迎提 issue 并附上 `vmrun` 的版本与输出。

## 发行与打包

插件没有编译步骤（Host 侧是纯 ESM，客户端是手写 React 元素），所以「构建」实际是**校验**：

```bash
npm run check      # 版本 / 变更日志 / 发行说明三者一致 + 全部模块语法
npm run release    # 检查 → 测试 → 打包 → 校验产物
npm run pack:dist  # 跳过测试直接出包（离线出包用）
```

`npm run release` 在 `dist/` 生成 `dsh-vm-control-<版本>.tgz` 与 `SHA256SUMS.txt`，并核对包内含 `index.js`、`client.js`、`lib/**`、`cordis.patch.yml`、`dsh-market-entry.yml`、`README*`、`LICENSE`，同时确保 `test/`、`node_modules`、`.github` 没有被带进去。

**发一次版**

1. 改 `package.json` 的版本，在两份 `CHANGELOG` 里加同版本小节，写 `RELEASE_NOTES/v<版本>.md`；
2. `npm run release` —— 三者不一致会立刻失败，不必等 CI 告诉你；
3. 提交、打标签、推送：

   ```bash
   git commit -am "chore(release): v1.1.0"
   git tag -a v1.1.0 -m "dsh-vm-control 1.1.0"
   git push origin main && git push origin v1.1.0
   ```

4. 推标签会触发 `.github/workflows/release.yml`：**重新**跑测试与打包（不复用旧产物），把 `.tgz` 与 `SHA256SUMS.txt` 附到 GitHub Release，正文取自 `RELEASE_NOTES/v<版本>.md`。

`SHA256SUMS.txt` 对应的是 **Actions 打出的那一个包**。本地重新 `npm run release` 得到的字节数会略有不同（npm 会把文件时间写进 tar 头），所以校验和要以发行附件里的那份为准；包的**内容**（文件清单与各文件内容）由第 5 步逐条核对，与本地一致。

标签与 `package.json` 版本不一致时，发行工作流会直接失败——打错标签的发行版比不发更糟。

## 测试

```bash
npm test                                   # 单元 + 接口 + 客户端冒烟，不需要 VMware
node test/live.mjs                         # 只读联调：真的去问本机的 VMware
node test/live.mjs "E:\Virtual Machines"   # 指定搜索目录
```

联调测试**不**会开关机、拍快照或删除任何东西；它验证版探测、真实 `vmrun list`、真实 VMX 解析、网络表与进程占用采集。四个测试文件的分工是：

- `test/unit.mjs` —— 解析、归类、存储、库存语义、权限与 SSH 导入的建议值（把 vmrun 换成假对象）；
- `test/api.mjs` —— 设置接口的信封、信任栅栏、权限二次判定与路径来源；
- `test/client-smoke.mjs` —— 在 `node:vm` 里跑 `client.js` 的工厂，检查注册接线与中英文案双向一致；
- `test/ssh-vault-link.mjs` —— 加载 **dsh-ssh-vault 的真实源码**，把我们的 payload 提交给它的保存接口，验证字段名、别名校验、覆盖语义与口令不外泄；
- `test/live.mjs` —— 对着真实 VMware 的只读联调。

`ssh-vault-link` 需要把 dsh-ssh-vault 克隆在本仓库旁边；找不到就打印一行 skip 并退出 0，因此 CI 里不会因为它缺席而失败。

## 许可

MIT
