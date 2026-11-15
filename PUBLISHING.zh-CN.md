# 发布到 npm 官方仓库

本文只讲 **npm 官方仓库**（`https://registry.npmjs.org/`），不涉及私有 registry、npmmirror 等镜像的**上传**（镜像只读），也不涉及 yarn / pnpm / bun 的发布流程。所有命令都可以直接复制执行，顺序即操作顺序。

> 本机有一个容易踩的坑：`~/.npmrc` 里默认 registry 是镜像 `https://registry.npmmirror.com`。镜像**不能发布**，`npm publish` 会 404/403。本项目已在 `package.json` 的 `publishConfig.registry` 里钉住官方地址，因此从仓库里直接 `npm publish` 就会发到 npmjs；但 `npm login` / `npm whoami` 这类命令仍要显式带 `--registry`。

## 1. 包的目录结构

```
dsh-vm-control/
├── package.json            # 唯一必需的元数据文件，永远进包
├── index.js                # Host 入口，exports["."]
├── client.js               # 浏览器半边，exports["./client"]
├── lib/                    # Host 模块（index.js 用相对路径导入）
│   ├── vmrun.js  vmx.js  inventory.js  metrics.js  store.js
│   ├── vm-api.js  format.js  ssh-import.js  diagnostics.js  platform.js  i18n.js
│   └── locales/vm.js
├── locale/zh.json  locale/en.json    # 市场展示名
├── cordis.patch.yml        # DSH 装载补丁（dsh.bundle.patch 指向它）
├── dsh-market-entry.yml    # 市场条目
├── icon.svg
├── README.md / README.zh-CN.md
├── CHANGELOG.md / CHANGELOG.zh-CN.md
├── SECURITY.md / SECURITY.zh-CN.md
├── PUBLISHING.md / PUBLISHING.zh-CN.md
├── LICENSE
├── scripts/                # 维护脚本（release.mjs），不进包
├── test/                   # 测试，不进包
├── .github/workflows/      # CI，不进包
└── RELEASE_NOTES/          # GitHub 发行说明，不进包
```

**进包的只有 `package.json` 与 `files` 白名单里的路径。** 这不是"排除"逻辑，而是白名单：没列出来的（`test/`、`scripts/`、`.github/`、`RELEASE_NOTES/`、`dist/`）一律不进包。好处是新增一个开发用目录时不会不小心把它发出去。

## 2. package.json 关键字段

| 字段 | 本项目取值 | 作用 | 出错会怎样 |
| --- | --- | --- | --- |
| `name` | `dsh-vm-control` | 包名，发布后**永久占用** | 被占用 → `npm view` 能查到；不属于你 → 403 |
| `version` | `1.1.1` | semver，同一版本只能发布一次 | 重复 → `EPUBLISHCONFLICT` |
| `description` | 一句话英文描述 | npm 搜索与页面摘要 | 空 → 页面无摘要 |
| `keywords` | dsh / vmware / vmrun… | 搜索排序 | 缺失只影响可发现性 |
| `license` | `MIT` | 必须；社区规范 | 缺失 → npm 警告，企业用户会犹豫 |
| `author` | `scientificmaniac (https://…)` | 页面上的人名 | 缺失只影响展示 |
| `type` | `module` | 本包是纯 ESM | 缺失 → `.js` 会被当 CJS，`import` 直接失败 |
| `main` | `./index.js` | 给不认 `exports` 的老工具兜底 | 缺失 → 老打包器找不到入口 |
| `exports` | `.` / `./client` / `./package.json` / `./locale/*.json` | 决定**哪些子路径可以被 import** | 子路径未导出 → `ERR_PACKAGE_PATH_NOT_EXPORTED` |
| `engines.node` | `>=20` | 安装时检查并警告 | 版本过低 → `EBADENGINE` |
| `files` | 白名单（见上） | 决定 tarball 内容 | 配错 → 缺文件或把测试发出去 |
| `publishConfig` | `access: public` + 官方 registry | 发布目标与可见性 | 缺失 → 可能按镜像地址发布而失败 |
| `repository` / `homepage` / `bugs` | GitHub 地址 | 页面右侧链接 | 缺失只影响展示 |
| `scripts.prepublishOnly` | `node scripts/release.mjs --check-only` | 发布前守卫 | 不一致时 `npm publish` 直接失败 |

`dsh`、`meta`、`icon` 是 DeepSeek Harness 自己的字段，npm 不读它们，但插件市场会用，因此保留。

## 3. 发布前的构建、打包与验证

本项目没有编译步骤（Host 侧纯 ESM，客户端是手写 React 元素），所以"构建"实际上是**校验 + 打包**：

```bash
npm run check          # 版本号 / 两份 CHANGELOG / RELEASE_NOTES 三者一致 + 15 个模块语法
npm test               # 82 项：单元 53 + 接口 19 + 客户端 5 + 联动 5
npm run pack:dist      # 出包到 dist/ 并逐条校验包内容（不跑测试）
npm pack --dry-run     # 只想看"会打进包里哪些文件"
```

`npm pack --dry-run` 的输出是发布前最该看的东西：`total files` 与文件名列表。看到 `test/`、`node_modules/` 或某个 `.tgz` 就说明 `files` 配错了。

**本地装机验证**（这一步能在发布前抓到 90% 的"装得上但用不了"问题）：

```bash
npm pack                                  # 生成 dsh-vm-control-1.1.1.tgz
mkdir ../tmp-install && cd ../tmp-install
npm init -y
npm install ../dsh-vm-control/dsh-vm-control-1.1.1.tgz
node -e "import('dsh-vm-control').then(m => console.log(Object.keys(m)))"
node -e "console.log(require('dsh-vm-control/package.json').version)"
```

`npm publish --dry-run` 与 `npm pack --dry-run` 等价（不发网络），多一层 `prepublishOnly` 守卫，建议发布前跑一次。

## 4. 账号注册、登录与双因素认证

**注册**：<https://www.npmjs.com/signup> → 邮箱收到验证信 → 点链接激活。用户名会成为包页面与 scope 的一部分，改不了。

**登录（交互式）**：

```bash
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/      # 回显用户名即成功
```

`npm login` 会打开浏览器走 OAuth；没有图形界面时用 `npm adduser --registry=...` 走命令行流程（用户名 / 密码 / 邮箱 / 一次性验证码）。

**双因素认证（2FA）**：

- 在 npm 账号设置里开启（推荐 "Authorization and writes"，即登录与发布都要求 OTP）。
- 开启后交互式发布会提示输入 6 位动态码；非交互场景用参数：`npm publish --otp=123456`。
- 自动化（CI）用 **Granular Access Token**：npm → Access Tokens → Generate New Token → 选 *Granular*，权限给 **Read and write**（或只给目标包 Publish），按需勾选 bypass 2FA。写进环境变量：

  ```bash
  export NODE_AUTH_TOKEN=npm_xxx      # PowerShell: $env:NODE_AUTH_TOKEN='npm_xxx'
  npm publish --access public --registry=https://registry.npmjs.org/
  ```

- 注意：npm 正在收紧"可绕过 2FA 的旧式 token"用于**直接发布**（`npm` 会在 `npm profile get` 时提示）。若遇到 403 且提示 2FA 策略，就用 `--otp` 交互发布，或在 CI 里用 OIDC（`--provenance`）替代长期 token。
- 不要把 `.npmrc` 提交进仓库；本项目的 `.gitignore` 不包含它，请自行确认 `git status` 里没有它。

## 5. `npm publish` 与常用参数

```bash
npm publish --access public            # 公开发布（本项目首次发布用这个）
npm publish --dry-run                  # 只打印将要发布的内容，不发网络
npm publish --tag beta                 # 发到 beta 这个 dist-tag，不动 latest
npm publish --otp 123456               # 开了 2FA 时提交动态码
npm publish --provenance               # CI 中生成可验证的构建来源（需 OIDC 权限）
npm publish --registry https://registry.npmjs.org/   # 临时指定目标仓库
```

| 参数 | 用途 | 什么时候必须 |
| --- | --- | --- |
| `--access public` | 声明包是公开的 | **scoped 包首次发布必须**；unscoped 默认公开，写上是为了防止误配 |
| `--dry-run` | 演练，不写仓库 | 首次发布前、改了 `files` 后 |
| `--tag <name>` | 写入指定 dist-tag（默认 `latest`） | 预发布（`beta`、`rc`），避免用户 `npm i` 装到未完成版 |
| `--otp <code>` | 一次性验证码 | 账号开启 2FA 且非交互执行 |
| `--provenance` | 生成 SLSA 溯源 | 有 OIDC 的 CI；本地不支持 |
| `--registry <url>` | 覆盖 registry | 本机默认是镜像时必须 |

本项目已把 `access` 与 `registry` 写进 `publishConfig`，所以命令可以短到：

```bash
npm publish
```

## 6. 作用域包（scoped package）的公开访问

形如 `@scope/name` 的包**默认按私有发布**，私有包需要付费计划；免费用户必须显式公开：

```bash
npm publish --access public
# 或一次性写进 package.json，之后 npm publish 不必再带参数
"publishConfig": { "access": "public" }
```

- `scope` 可以是用户名（`@kxfz/xxx`）或已创建的组织（npm → Organizations）。创建组织本身免费，公开包不收费。
- **公开后不能改回私有**（免费账号），所以第一次 `--access public` 之前想清楚。
- 同一账号可以同时有 unscoped 与 scoped 包；内部引用时 `require('@scope/name')`。
- 本项目使用 unscoped 名称 `dsh-vm-control`（2026-11-15 查询为未占用），因此不存在这一节的门槛。

## 7. 发布后验证

```bash
# 1) 元信息：版本、dist-tag、发布时间
npm view dsh-vm-control version dist-tags.latest time.modified --registry=https://registry.npmjs.org/

# 2) 官方仓库里的包内容（与本地 npm pack 对照）
npm pack dsh-vm-control@1.1.1 --dry-run --registry=https://registry.npmjs.org/

# 3) 干净目录里真装一次
mkdir ../verify && cd ../verify && npm init -y
npm install dsh-vm-control@1.1.1 --registry=https://registry.npmjs.org/
node -e "import('dsh-vm-control').then(m => console.log(typeof m.apply))"
```

浏览器打开 <https://www.npmjs.com/package/dsh-vm-control> 确认：README 渲染、版本号、`Repository`/`Homepage` 链接、`License` 徽标。

**镜像延迟**：npmmirror 同步有几分钟到几十分钟的滞后，在镜像上查不到新版本是正常的；验证一律以官方 registry 为准。

**撤销**：发布后 72 小时内可 `npm unpublish dsh-vm-control@1.1.1`（连同 tarball）；超过 72 小时只能 `npm deprecate dsh-vm-control@1.1.1 "说明"`。已经被别人装走的版本无法收回，所以宁可发 `1.1.2`，不要指望撤回。

## 8. 更新版本号与重新发布

```bash
npm version patch -m "chore(release): %s"    # 1.1.1 → 1.1.2（会改 package.json、提交、打 tag）
# 或 minor / major
```

发布一个新版本的标准顺序：

1. `npm version patch`（或手工改 `package.json`）；
2. 同步两份 `CHANGELOG` 与 `RELEASE_NOTES/v<新版本>.md`（`npm run check` 会强制这一点）；
3. `npm run release` —— 检查 + 测试 + 打包 + 产物校验；
4. `npm publish`；
5. `git push --follow-tags`（把提交与 tag 一起推走，GitHub 的 release 工作流会跟着建发行版）；
6. 用第 7 节的方式验证新版本。

语义化版本约定：

| 变更 | 用 | 例子 |
| --- | --- | --- |
| 修 bug、文档、打包元数据 | `patch` | 1.1.0 → 1.1.1 |
| 新增向后兼容的功能 | `minor` | 1.1.1 → 1.2.0 |
| 破坏性变更（工具参数、配置字段、数据格式） | `major` | 1.2.0 → 2.0.0 |

预发布用 `npm version 1.2.0-beta.1` + `npm publish --tag next`，等稳定后再 `npm dist-tag add dsh-vm-control@1.2.0 latest`。

## 9. 常见错误排查

| 现象 | 原因 | 处置 |
| --- | --- | --- |
| `E404` / `404 Not Found - PUT ...` | 目标 registry 不是官方（镜像只读），或包名被占用/不存在于该 registry | `npm config get registry`；用 `--registry=https://registry.npmjs.org/` 或 `publishConfig.registry` |
| `E403 You do not have permission to publish "<name>"` | 名字已被别人占用，或当前账号无权写入该 scope | `npm view <name> maintainers`；换成自己的 scope `@user/<name>` |
| `403 ... You may not perform that action with these credentials` | granular token 的 **package scope 不包含这个包**（本机实测：token 只授权了 `dsh-ssh-vault`，去发 `dsh-vm-control` 就得到这一句） | `npm token list --json` 看 `scopes`；新建一个 scope 为 *All packages*（或含目标包）且带 `package:write` 的 granular token，替换 `~/.npmrc` 里的 `_authToken` |
| `E403 ... two-factor authentication required` | 账号强制 2FA | `npm publish --otp=<6 位码>`，或改用带 Publish 权限的 granular token |
| `EOTP` / `one-time password required` | 同上，交互式未给码 | 同上；CI 里用 `--otp` 或 OIDC |
| `EPUBLISHCONFLICT` / `Cannot publish over previously published version` | 该版本号已存在（发布不可变） | `npm version patch` 后重发；不要试图覆盖 |
| `ENEEDAUTH` | 没登录，或登录的是镜像而发布目标是官方 | `npm login --registry=https://registry.npmjs.org/`；`npm whoami --registry=...` 验证 |
| `E402 Payment Required` / 私有包相关 | scoped 包未加 `--access public`，或试图把公开包改为私有 | 加 `--access public`；私有需付费组织 |
| `E400 name can only contain URL-friendly characters` | 包名含大写、空格、中文 | 全小写 + `-` 分隔 |
| 包里缺文件 / 多了 `test/` | `files` 白名单或 `.npmignore` 配错 | `npm pack --dry-run` 看清单；本项目的 `scripts/release.mjs` 会逐条核对必需文件 |
| `prepublishOnly` 失败导致发不出去 | 版本 / CHANGELOG / 发行说明不一致 | 按脚本输出补齐；这是守卫，不是故障 |
| 安装后 `ERR_MODULE_NOT_FOUND` / `Cannot find module` | `main` / `exports` / `type` 配错 | `npm pack` 后本地装一次复现；核对 `exports` 子路径 |
| 装上了但 DSH 不加载插件 | `dsh.bundle.patch` 指向的 `cordis.patch.yml` 不在 `files` 里 | 确认 `files` 含 `cordis.patch.yml` 与 `lib/` |
| 发布成功但页面 404 / 版本没更新 | CDN 缓存、镜像滞后 | 等 1–5 分钟；`npm view` 直接查 registry |

## 10. 本项目的实际命令序列

```bash
cd "e:/ai project/dsh-vm-tools/dsh-vm-control"

# 1. 确认要发的内容
git status --short                  # 干净，只包含本次要发的提交
npm run check                       # 版本、变更日志、发行说明一致
npm test                            # 82 项测试

# 2. 演练
npm publish --dry-run --access public

# 3. 发布（若账号开了 2FA，追加 --otp=<六位码>）
npm publish --access public

# 4. 验证
npm view dsh-vm-control version dist-tags.latest --registry=https://registry.npmjs.org/
mkdir ../verify && cd ../verify && npm init -y
npm install dsh-vm-control --registry=https://registry.npmjs.org/
node -e "import('dsh-vm-control').then(m => console.log(typeof m.apply))"

# 5. 同步仓库
git push --follow-tags
```

作为 DSH 插件的安装方式（与 npm 安装等价，多了宿主侧的注册步骤）：

```bash
dsh plugin --profile desktop install dsh-vm-control
# 装完重启 DSH：Host 侧工具与设置路由在启动时加载
```
