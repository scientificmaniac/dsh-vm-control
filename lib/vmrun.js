/**
 * `vmrun` 适配层 —— 插件与 VMware 之间唯一的执行通道。
 *
 * 三件事都在这一层解决，上层（工具 / 设置接口）因此不必知道 VMware 的版本差异：
 *
 * 1. **找到可执行文件。** VMware 的安装路径随产品（Workstation / Player / Fusion）、
 *    版本（17.x 起目录名带 "Pro"）与平台而变，还要考虑用户自定义安装目录与 PATH。
 *    发现顺序：显式配置 → 环境变量 → Windows 注册表 → 常见安装目录 → PATH。
 * 2. **探测能力。** 直接跑一次不带参数的 `vmrun`：它会把版本与完整命令表打到
 *    stdout，于是「这个版本支不支持 deleteVM / clone / listHostNetworks」不再靠猜。
 *    旧版本缺少某条命令时，插件给出一句能定位到版本的话，而不是一句 exit code 1。
 * 3. **把失败翻译成原因。** vmrun 的报错是英文散文，同一句「Cannot open VM」既可能是
 *    路径错、也可能是被锁。这里归类成固定类别，再交给 `locales/vm.js` 里的
 *    「该往哪里修」。
 *
 * @module dsh-vm-control/vmrun
 */

import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { t } from './i18n.js'

/** 单次 vmrun 调用的绝对上限。 */
export const MAX_TIMEOUT_MS = 30 * 60 * 1000

/**
 * 子进程退出后，最多再等多久收尾 stdio 管道。
 *
 * 正常情况下 `close` 会先到，这个计时器不会被用到。它只兜住一种真实场景：`vmrun` 拉起的
 * 图形窗口继承了管道并继续持有它，`close` 因此永不触发。详见 `runProcess` 里 `exit` 监听处的说明。
 */
const EXIT_FALLBACK_MS = 250

/** 支持的主机类型；`auto` 表示逐个探测。 */
export const HOST_TYPES = Object.freeze(['ws', 'player', 'fusion'])

/** 解析失败时假定可用的命令集（Workstation 1.17 的完整列表）。 */
export const WORKSTATION_COMMANDS = Object.freeze([
  'start', 'stop', 'reset', 'suspend', 'pause', 'unpause',
  'listSnapshots', 'snapshot', 'deleteSnapshot', 'revertToSnapshot',
  'listHostNetworks', 'listPortForwardings', 'setPortForwarding', 'deletePortForwarding',
  'runProgramInGuest', 'fileExistsInGuest', 'directoryExistsInGuest', 'setSharedFolderState',
  'addSharedFolder', 'removeSharedFolder', 'enableSharedFolders', 'disableSharedFolders',
  'listProcessesInGuest', 'killProcessInGuest', 'runScriptInGuest', 'deleteFileInGuest',
  'createDirectoryInGuest', 'deleteDirectoryInGuest', 'listDirectoryInGuest',
  'CopyFileFromHostToGuest', 'CopyFileFromGuestToHost', 'renameFileInGuest',
  'typeKeystrokesInGuest', 'connectNamedDevice', 'disconnectNamedDevice',
  'captureScreen', 'writeVariable', 'readVariable', 'getGuestIPAddress',
  'list', 'upgradevm', 'installTools', 'checkToolsState', 'deleteVM', 'clone',
])

/** 失败类别 → 文案键。上层渲染时据此补一行归因。 */
export const CATEGORY_MESSAGE = Object.freeze({
  'vmrun-missing': 'err.catVMRunMissing',
  'vm-missing': 'err.catVmMissing',
  'bad-host-type': 'err.catHostType',
  'vm-state': 'err.catVmState',
  busy: 'err.catBusy',
  tools: 'err.catTools',
  permission: 'err.catPermission',
  timeout: 'err.catTimeout',
  encrypted: 'err.catEncrypted',
  unsupported: 'err.catUnknown',
  unknown: 'err.catUnknown',
})

/** 失败类别 → 修复方向文案键。 */
export const CATEGORY_HINT = Object.freeze({
  'vmrun-missing': 'err.hintVMRunMissing',
  'vm-missing': 'err.hintVmMissing',
  'bad-host-type': 'err.hintHostType',
  'vm-state': 'err.hintVmState',
  busy: 'err.hintBusy',
  tools: 'err.hintTools',
  permission: 'err.hintPermission',
  timeout: 'err.hintTimeout',
  encrypted: 'err.hintEncrypted',
  unsupported: 'err.hintUnknown',
  unknown: 'err.hintUnknown',
})

/**
 * 按 stderr 的形态归类失败。顺序即优先级：越具体的判断越靠前。
 *
 * 「状态不对」排在「被占用」之前是刻意的：`The virtual machine is not powered on` 也带着
 * 让人误读成锁的关键词，先判状态能省掉一次错误的排查方向。
 */
const FAILURE_PATTERNS = [
  ['vmrun-missing', /ENOENT|not recognized as an internal or external command|command not found|cannot find the file specified/i],
  ['bad-host-type', /invalid host ?type|unrecognized host ?type|invalid -T/i],
  ['vm-missing', /cannot open vm|failed to open|does not exist|no such file|cannot find the virtual machine|not a valid virtual machine|invalid virtual machine/i],
  ['encrypted', /is encrypted|encrypted virtual machine|encryption password|passphrase/i],
  // Tools 必须先于「状态」判定：`VMware Tools is not running` 里的 "not running" 会被状态
  // 规则先吃掉，结论就会从「客户机里没装 Tools」歪成「虚拟机没开机」。
  ['tools', /vmware tools|tools are not|guest operations|tools not installed|tools is not running/i],
  ['vm-state', /is not powered on|is already powered on|is powered off|invalid power state|is suspended|not in a state/i],
  ['busy', /is in use|is locked|another program|resource is busy|in transition|cannot acquire/i],
  ['permission', /permission denied|access is denied|privilege|administrator rights|elevation/i],
  ['timeout', /timed out|timeout|did not respond/i],
]

/**
 * 归类一次失败。
 * @param text - stderr 与 stdout 合并后的文本。
 * @returns 类别名；无法判断时为 `unknown`。
 */
export function classifyFailure(text) {
  const haystack = String(text ?? '')
  if (haystack.trim().length === 0) return 'unknown'
  for (const [category, pattern] of FAILURE_PATTERNS) {
    if (pattern.test(haystack)) return category
  }
  return 'unknown'
}

/**
 * 从 vmrun 的用法输出里解析版本与命令表。
 *
 * 用法输出的结构是「命令 + 两个以上空格 + 参数 + 说明」，段落标题是大写单词。
 * 因此判定一条命令的条件是：行首单词、后面跟着两列空白，且整行不是 `POWER COMMANDS`
 * 这类标题。
 *
 * @param text - 不带参数运行 vmrun 时的输出。
 * @returns `{ version, build, commands }`。
 */
export function parseUsage(text) {
  const source = String(text ?? '')
  const versionMatch = /vmrun version ([0-9][0-9.]*)(?:\s+build-([0-9]+))?/i.exec(source)
  const commands = []
  for (const line of source.split(/\r?\n/)) {
    if (line.trim().length === 0) continue
    // 段落标题：全大写单词 + 可选复数，后面跟的是 PARAMETERS 之类的列名。
    if (/^[A-Z][A-Z\s-]+$/.test(line.trim())) continue
    if (/^[A-Z\s]+\s+(COMMANDS|FLAGS)\b/.test(line)) continue
    const match = /^([A-Za-z][A-Za-z0-9]*)\s{2,}\S/.exec(line)
    if (match === null) continue
    const token = match[1]
    // 表头（POWER / SNAPSHOT …）与说明里的普通单词都排除：命令名不含空格且不以大写纯词出现。
    if (/^[A-Z]+$/.test(token)) continue
    if (!commands.includes(token)) commands.push(token)
  }
  return {
    version: versionMatch === null ? '' : versionMatch[1],
    build: versionMatch === null ? undefined : versionMatch[2],
    commands,
  }
}

/**
 * 解析 `vmrun list` 的输出。
 *
 * 首行是 `Total running VMs: N`，其后每行一个 vmx 绝对路径（含空格，不能按空格切分）。
 *
 * @param text - 命令输出。
 * @returns 运行中的 vmx 路径数组。
 */
export function parseRunningVms(text) {
  const vms = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const text_ = line.trim()
    if (text_.length === 0) continue
    if (/^total running vms:/i.test(text_)) continue
    if (!/\.vmx$/i.test(text_)) continue
    vms.push(text_)
  }
  return vms
}

/**
 * 解析 `vmrun listSnapshots` 的输出。
 *
 * 默认输出只有名字；`showTree` 会给出缩进树，缩进即层级。`(current)` 标记当前快照，
 * 它是「回滚会回到哪一个」的答案，必须保留给用户看。
 *
 * @param text - 命令输出。
 * @param options - `tree` 为真时按缩进推导层级。
 * @returns `{ name, current, depth }` 数组。
 */
export function parseSnapshots(text, { tree = false } = {}) {
  const snapshots = []
  const indents = []
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    if (line.trim().length === 0) continue
    if (/^\s*total snapshots:/i.test(line)) continue
    const indent = line.length - line.trimStart().length
    let name = line.trim()
    const current = /\(current\)$/i.test(name)
    if (current) name = name.replace(/\s*\(current\)$/i, '').trim()
    if (name.length === 0) continue
    let depth = 0
    if (tree === true) {
      while (indents.length > 0 && indents[indents.length - 1] >= indent) indents.pop()
      depth = indents.length
      indents.push(indent)
    }
    snapshots.push({ name, current, depth })
  }
  return snapshots
}

/**
 * 解析 `vmrun listHostNetworks` 的输出。
 *
 * 17.x 输出的是表格（`INDEX  NAME  TYPE  DHCP  SUBNET  MASK`），但更老的版本只有一列名字。
 * 两种都认：能切成列就给结构化字段，切不开就只保留名字——界面上「选一个网络」这个用途
 * 对两种形态都成立。
 *
 * @param text - 命令输出。
 * @returns `{ index, name, type, dhcp, subnet, mask, raw }` 数组。
 */
export function parseHostNetworks(text) {
  const networks = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const value = line.trim()
    if (value.length === 0) continue
    if (/^total host networks:/i.test(value)) continue
    if (/^index\s+name\b/i.test(value)) continue
    const cells = value.split(/\s{2,}|\t+/).map((cell) => cell.trim()).filter((cell) => cell.length > 0)
    if (cells.length >= 2 && /^\d+$/.test(cells[0])) {
      networks.push({
        index: Number(cells[0]),
        name: cells[1],
        type: cells[2] ?? '',
        dhcp: cells[3] ?? '',
        subnet: cells[4] ?? '',
        mask: cells[5] ?? '',
        raw: value,
      })
      continue
    }
    networks.push({ index: undefined, name: value, type: '', dhcp: '', subnet: '', mask: '', raw: value })
  }
  return networks
}

/**
 * 解析 `vmrun listPortForwardings <network>` 的输出。
 *
 * vmrun 在这里没有稳定的机器可读格式，所以解析是尽力而为的：认得出来的行给结构化字段，
 * 认不出来的行原样保留，界面照原样显示。
 *
 * @param text - 命令输出。
 * @returns `{ protocol, hostPort, guestIp, guestPort, description, raw }` 数组。
 */
export function parsePortForwardings(text) {
  const rows = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const value = line.trim()
    if (value.length === 0) continue
    if (/^total port ?forwardings:/i.test(value)) continue
    const match = /^(tcp|udp)\s*:?\s*(\d+)\s*(?:->|:)\s*(\S+)\s*(.*)$/i.exec(value)
    if (match === null) {
      rows.push({ raw: value })
      continue
    }
    // 目标一侧形如 `192.168.234.129:22`；IPv6 会带方括号（`[::1]:22`）。
    const target = match[3]
    const cut = target.startsWith('[') ? target.indexOf(']:') + 1 : target.lastIndexOf(':')
    const guestIp = cut > 0 ? target.slice(0, cut) : target
    const portText = cut > 0 ? target.slice(cut + 1) : ''
    const guestPort = /^\d+$/.test(portText) ? Number(portText) : undefined
    rows.push({
      protocol: match[1].toLowerCase(),
      hostPort: Number(match[2]),
      guestIp,
      guestPort,
      description: (match[4] ?? '').trim(),
      raw: value,
    })
  }
  return rows
}

/**
 * 运行一个进程并收集输出，支持超时与取消。
 *
 * 用 spawn 而不是 execFile 是为了三件事：取消时要能立刻杀掉子进程、要能区分「超时」
 * 与「被取消」、以及不必为长输出准备 `maxBuffer`。
 *
 * @param executable - 可执行文件。
 * @param args - 参数数组。
 * @param options - 超时与取消信号。
 * @returns 归一化的进程结果。
 */
export function runProcess(executable, args, { timeoutMs = 60000, signal, env } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(executable, args, {
        windowsHide: true,
        env: env === undefined ? process.env : { ...process.env, ...env },
      })
    } catch (error) {
      resolve({
        code: null,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        timedOut: false,
        aborted: false,
        spawnError: error,
      })
      return
    }
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let aborted = false
    let settled = false
    let timer
    /** `exit` 之后用来收尾管道的兜底计时器；正常路径由 `close` 抢先落定，届时清掉它。 */
    const fallbacks = new Set()
    if (typeof child.stdout?.setEncoding === 'function') child.stdout.setEncoding('utf8')
    if (typeof child.stderr?.setEncoding === 'function') child.stderr.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => { stdout += chunk })
    child.stderr?.on('data', (chunk) => { stderr += chunk })

    const finish = (code, spawnError) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      for (const fallback of fallbacks) clearTimeout(fallback)
      fallbacks.clear()
      if (signal !== undefined) signal.removeEventListener?.('abort', onAbort)
      resolve({ code, stdout, stderr, timedOut, aborted, spawnError })
    }
    const kill = () => {
      try {
        child.kill()
      } catch {
        // 已经退出：kill 抛错不影响结果。
      }
    }
    timer = setTimeout(() => {
      timedOut = true
      // 超时后不能只靠 `close` 落定：见下面 `exit` 监听处的说明。
      kill()
    }, Math.min(Math.max(timeoutMs, 1000), MAX_TIMEOUT_MS))
    timer.unref?.()

    const onAbort = () => {
      aborted = true
      kill()
    }
    if (signal !== undefined) {
      if (signal.aborted === true) onAbort()
      else signal.addEventListener?.('abort', onAbort, { once: true })
    }

    child.on('error', (error) => finish(null, error))
    child.on('close', (code) => finish(code ?? null, undefined))
    // `close` 要等**所有** stdio 管道关闭才触发，而 `exit` 在直接子进程退出时就触发。
    // 两者在一种场景下会分叉，而正是这个场景让电源工具卡死过：
    //
    // `vmrun start <vmx> gui` 会拉起 vmware.exe 图形窗口，那个进程**继承了本进程的
    // stdout/stderr 管道**。超时后我们 kill 掉 vmrun.exe，但 vmware.exe 仍在运行、
    // 仍持有管道，于是 `close` 一直等不到 —— promise 永不落定，`inventory.power()`
    // 之后的「等待状态确认」根本轮不到执行，宿主看到的就是一次无响应的工具调用。
    //
    // 因此 `exit` 之后补一个短兜底：正常情况 `close` 先到，兜底不会生效；管道被孙进程
    // 占住时由它落定。孙进程是虚拟机本身，不能为了收管道去杀它。
    child.on('exit', (code) => {
      if (settled) return
      const fallback = setTimeout(() => finish(code ?? null, undefined), EXIT_FALLBACK_MS)
      fallback.unref?.()
      fallbacks.add(fallback)
    })
  })
}

/**
 * 在 Windows 注册表里读一个值（用于定位 VMware 安装目录）。
 * @param key - 注册表键。
 * @param name - 值名。
 * @returns 值文本；读不到时为 undefined。
 */
async function queryRegistryValue(key, name) {
  return new Promise((resolve) => {
    execFile('reg', ['query', key, '/v', name], { windowsHide: true, timeout: 4000 }, (error, stdout) => {
      if (error) {
        resolve(undefined)
        return
      }
      // 输出形如：`    InstallPath    REG_SZ    C:\Program Files (x86)\VMware\VMware Workstation\`
      const match = new RegExp(`${name}\\s+REG_[A-Z_]+\\s+(.+)`, 'i').exec(String(stdout ?? ''))
      resolve(match === null ? undefined : match[1].trim())
    })
  })
}

/**
 * 候选可执行文件路径（按优先级）。
 * @param options - 平台与环境。
 * @returns 绝对路径数组。
 */
export function candidateVmrunPaths({ platform = process.platform, env = process.env } = {}) {
  const candidates = []
  if (platform === 'win32') {
    const programFiles = [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432].filter((value) => typeof value === 'string' && value.length > 0)
    for (const root of programFiles) {
      for (const product of ['VMware Workstation', 'VMware Workstation Pro', 'VMware Player']) {
        candidates.push(path.join(root, 'VMware', product, 'vmrun.exe'))
      }
    }
  } else if (platform === 'darwin') {
    candidates.push('/Applications/VMware Fusion.app/Contents/Library/vmrun')
    candidates.push('/Applications/VMware Fusion Tech Preview.app/Contents/Library/vmrun')
    candidates.push('/Applications/VMware Fusion.app/Contents/Public/vmrun')
  } else {
    candidates.push('/usr/bin/vmrun', '/usr/local/bin/vmrun', '/opt/vmware/bin/vmrun', '/usr/lib/vmware/bin/vmrun')
  }
  return candidates
}

/**
 * 在 PATH 里找一个可执行文件（不启动子进程）。
 * @param name - 文件名。
 * @param env - 环境变量。
 * @returns 绝对路径；找不到时为 undefined。
 */
export function findInPath(name, env = process.env) {
  const raw = env.PATH ?? env.Path ?? ''
  for (const dir of String(raw).split(path.delimiter)) {
    if (dir.trim().length === 0) continue
    const target = path.join(dir.trim(), name)
    if (existsSync(target)) return target
  }
  return undefined
}

/**
 * 定位 vmrun。
 *
 * @param options - 显式路径、平台与环境。
 * @returns `{ path, source }`；找不到时 `path` 为 undefined，`source` 说明查过哪里。
 */
export async function discoverVmrun({ configuredPath, platform = process.platform, env = process.env } = {}) {
  const tried = []
  if (typeof configuredPath === 'string' && configuredPath.trim().length > 0) {
    const target = configuredPath.trim()
    if (existsSync(target)) return { path: target, source: 'config', tried }
    tried.push(`config:${target}`)
  }
  const fromEnv = env.VMRUN_PATH
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0 && existsSync(fromEnv.trim())) {
    return { path: fromEnv.trim(), source: 'env', tried }
  }

  if (platform === 'win32') {
    // 64 位与 32 位视图都要查：Workstation 是 32 位安装程序，键落在 WOW6432Node 下。
    const keys = [
      'HKLM\\SOFTWARE\\VMware, Inc.\\VMware Workstation',
      'HKLM\\SOFTWARE\\WOW6432Node\\VMware, Inc.\\VMware Workstation',
      'HKLM\\SOFTWARE\\VMware, Inc.\\VMware Player',
      'HKLM\\SOFTWARE\\WOW6432Node\\VMware, Inc.\\VMware Player',
    ]
    for (const key of keys) {
      const installPath = await queryRegistryValue(key, 'InstallPath')
      if (installPath === undefined || installPath.length === 0) continue
      const target = path.join(installPath, 'vmrun.exe')
      if (existsSync(target)) return { path: target, source: `registry:${key}`, tried }
      tried.push(`registry:${target}`)
    }
  }

  for (const candidate of candidateVmrunPaths({ platform, env })) {
    if (existsSync(candidate)) return { path: candidate, source: 'install-dir', tried }
    tried.push(candidate)
  }
  const inPath = findInPath(platform === 'win32' ? 'vmrun.exe' : 'vmrun', env)
  if (inPath !== undefined) return { path: inPath, source: 'PATH', tried }
  return { path: undefined, source: 'missing', tried }
}

/**
 * 主机类型 → 产品文案键。
 * @param hostType - `ws` / `player` / `fusion`。
 * @returns 文案键。
 */
export function productKeyFor(hostType) {
  if (hostType === 'ws') return 'vm.product.ws'
  if (hostType === 'player') return 'vm.product.player'
  if (hostType === 'fusion') return 'vm.product.fusion'
  return 'vm.product.unknown'
}

/** 电源动作集合，与 `vmrun` 的命令名一一对应。 */
export const POWER_ACTIONS = Object.freeze(['start', 'stop', 'suspend', 'pause', 'unpause', 'reset', 'status'])

/** 各动作的默认超时：关机/启动天然慢，暂停/恢复很快。 */
const DEFAULT_ACTION_TIMEOUT = Object.freeze({
  start: 120000,
  stop: 180000,
  reset: 120000,
  suspend: 120000,
  pause: 30000,
  unpause: 30000,
  status: 20000,
})

/**
 * GUI 启动的默认超时。
 *
 * `vmrun start <vmx> gui` 在图形窗口真正出现之前可能一直不返回，而窗口出现并不代表
 * 虚拟机已就绪——继续等下去只会把一次「已启动」拖成一次「超时」。所以 GUI 模式刻意
 * 用比无头模式更短的时限：到点即交出「已发出，未确认」，由后续状态查询收尾。
 */
export const GUI_START_TIMEOUT_MS = 60000

/**
 * vmrun 的封装。
 *
 * 对外只暴露语义化方法（`power` / `snapshots` / `deleteVm` …），参数拼装、类型回退与
 * 失败归类都在内部完成，因此上层不必重复写 `['-T', type, ...]`。
 */
export class Vmrun {
  #executable
  #configuredPath
  #configuredType
  #resolvedType
  #probeSource = 'unknown'
  #timeoutMs
  #logger
  #probePromise
  #probe
  #listCache = null
  #listCacheAt = 0

  /**
   * @param options - 可执行文件与类型。
   * @param options.executable - vmrun 绝对路径；未给时由 {@link discoverVmrun} 解析。
   * @param options.configuredPath - 用户显式配置的路径（发现时的第一优先级）。
   * @param options.hostType - `ws` / `player` / `fusion` / `auto`。
   * @param options.timeoutMs - 单次调用默认超时。
   * @param options.logger - 可选日志接口。
   */
  constructor({ executable, configuredPath, hostType = 'auto', timeoutMs = 90000, logger } = {}) {
    this.#executable = executable
    this.#configuredPath = configuredPath
    this.#configuredType = HOST_TYPES.includes(hostType) ? hostType : 'auto'
    this.#resolvedType = this.#configuredType === 'auto' ? null : this.#configuredType
    this.#timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, MAX_TIMEOUT_MS) : 90000
    this.#logger = logger
    this.#probePromise = null
    if (typeof executable === 'string' && executable.length > 0) this.#probeSource = 'given'
  }

  /** 当前使用的 vmrun 路径。 */
  get executable() {
    return this.#executable
  }

  /** 已解析的主机类型；尚未探测时为 null。 */
  get hostType() {
    return this.#resolvedType
  }

  /**
   * 探测 vmrun：版本、命令表与主机类型。
   *
   * 结果缓存到实例上——它只在 VMware 升级或插件重载时才会变，而列表刷新是高频操作。
   *
   * @param options - `refresh` 强制重新探测。
   * @returns `{ found, executable, version, build, hostType, commands, capabilitiesKnown, error }`
   */
  async probe({ refresh = false } = {}) {
    if (refresh !== true && this.#probe !== undefined) return this.#probe
    if (refresh !== true && this.#probePromise !== null) return this.#probePromise
    this.#probePromise = (async () => {
      if (typeof this.#executable !== 'string' || this.#executable.length === 0) {
        const found = await discoverVmrun({ configuredPath: this.#configuredPath })
        this.#executable = found.path
        this.#probeSource = found.source
      }
      if (typeof this.#executable !== 'string' || this.#executable.length === 0) {
        this.#probe = {
          found: false,
          executable: '',
          source: 'missing',
          version: '',
          build: undefined,
          hostType: this.#resolvedType ?? 'unknown',
          commands: [...WORKSTATION_COMMANDS],
          capabilitiesKnown: false,
          error: t('vm.vmrunMissing'),
        }
        return this.#probe
      }
      const usage = await runProcess(this.#executable, [], { timeoutMs: 10000 })
      const parsed = parseUsage(`${usage.stdout}\n${usage.stderr}`)
      const capabilitiesKnown = parsed.commands.length > 0
      if (!capabilitiesKnown) {
        // 用法输出读不出来不是致命问题：按完整命令集继续，失败时再解释。
        this.#logger?.warn?.(t('err.capabilitiesUnknown'))
      }
      if (this.#resolvedType === null) this.#resolvedType = await this.#detectHostType()
      this.#probe = {
        found: true,
        executable: this.#executable,
        source: this.#probeSource,
        version: parsed.version,
        build: parsed.build,
        hostType: this.#resolvedType ?? 'unknown',
        commands: capabilitiesKnown ? parsed.commands : [...WORKSTATION_COMMANDS],
        capabilitiesKnown,
        error: undefined,
      }
      return this.#probe
    })()
    try {
      return await this.#probePromise
    } finally {
      this.#probePromise = null
    }
  }

  /**
   * 逐个尝试主机类型，用 `list` 作为探针。
   *
   * 不读注册表来判断产品：同一台机器可能同时装了 Workstation 与 Player，而 `-T` 是该
   * 进程唯一认的事实。代价只是一次 `list`（毫秒级）。
   *
   * @returns 可用的主机类型；都不行时退回平台默认值。
   */
  async #detectHostType() {
    if (typeof this.#executable !== 'string') return undefined
    const preference = process.platform === 'darwin' ? ['fusion', 'ws', 'player'] : ['ws', 'player', 'fusion']
    for (const type of preference) {
      const result = await runProcess(this.#executable, ['-T', type, 'list'], { timeoutMs: 15000 })
      if (result.code === 0) return type
      if (!/invalid host ?type|unrecognized|unknown host/i.test(`${result.stderr}${result.stdout}`)) {
        // 报错与类型无关（例如 VMware 服务没起）：继续试没有意义，直接用这个类型。
        return type
      }
    }
    return preference[0]
  }

  /**
   * 该 vmrun 是否宣称支持某条命令。
   * @param command - 命令名，如 `deleteVM`。
   * @returns 支持时为 true（能力未知时按支持处理）。
   */
  async supports(command) {
    const probe = await this.probe()
    return probe.commands.includes(command)
  }

  /**
   * 拼出完整的参数数组：认证标志必须在命令之前。
   * @param args - 命令与参数。
   * @param options - 可选的加密口令。
   * @returns 完整参数数组。
   */
  #fullArgs(args, { password } = {}) {
    const head = []
    if (typeof this.#resolvedType === 'string' && this.#resolvedType.length > 0) head.push('-T', this.#resolvedType)
    if (typeof password === 'string' && password.length > 0) head.push('-vp', password)
    return [...head, ...args]
  }

  /**
   * 执行一次 vmrun 并归一化结果。
   *
   * @param args - 命令与参数。
   * @param options - 超时、取消信号与加密口令。
   * @returns 归一化结果。
   */
  async run(args, { timeoutMs = this.#timeoutMs, signal, password } = {}) {
    // 第一次调用时先探测：既拿到主机类型，也拿到命令表。probe 本身用 runProcess，
    // 不会经由 run，所以这里没有递归。
    if (this.#probe === undefined) await this.probe()
    const command = args[0] ?? ''
    if (typeof this.#executable !== 'string' || this.#executable.length === 0) {
      return {
        ok: false,
        code: null,
        stdout: '',
        stderr: t('vm.vmrunMissing'),
        command,
        category: 'vmrun-missing',
        timedOut: false,
        aborted: false,
        args,
      }
    }
    // 能力已知而命令表里没有它：直接给出「哪个版本缺了什么」，而不是让 vmrun 打一段用法。
    if (this.#probe?.capabilitiesKnown === true && command.length > 0 && !this.#probe.commands.includes(command)) {
      return {
        ok: false,
        code: null,
        stdout: '',
        stderr: t('err.unsupportedCommand', {
          command,
          version: this.#probe.version.length > 0 ? this.#probe.version : '—',
          hostType: this.#probe.hostType,
        }),
        command,
        category: 'unsupported',
        timedOut: false,
        aborted: false,
        durationMs: 0,
        args,
      }
    }
    const started = Date.now()
    const result = await runProcess(this.#executable, this.#fullArgs(args, { password }), { timeoutMs, signal })
    const ok = result.code === 0 && result.timedOut !== true && result.aborted !== true
    const merged = `${result.stderr}\n${result.stdout}`
    let category
    if (ok) category = undefined
    else if (result.aborted === true) category = 'timeout'
    else if (result.timedOut === true) category = 'timeout'
    else if (result.spawnError !== undefined) category = 'vmrun-missing'
    else category = classifyFailure(merged)
    const normalized = {
      ok,
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      command,
      category,
      timedOut: result.timedOut === true,
      aborted: result.aborted === true,
      durationMs: Date.now() - started,
      args,
    }
    if (!ok) {
      this.#logger?.warn?.(`vmrun ${command} failed (${category ?? 'unknown'}, code ${result.code}): ${result.stderr.trim().slice(0, 400)}`)
    }
    return normalized
  }

  /**
   * 列出运行中的虚拟机；短 TTL 缓存，避免一次刷新打出一串 `vmrun list`。
   * @param options - `refresh` 跳过缓存。
   * @returns `{ ok, vms, error, raw }`。
   */
  async list({ refresh = false, ttlMs = 1500 } = {}) {
    const now = Date.now()
    if (refresh !== true && this.#listCache !== null && now - this.#listCacheAt < ttlMs) return this.#listCache
    await this.probe()
    const result = await this.run(['list'], { timeoutMs: 20000 })
    const value = result.ok
      ? { ok: true, vms: parseRunningVms(result.stdout), raw: result.stdout, error: undefined }
      : { ok: false, vms: [], raw: result.stdout, error: result }
    this.#listCache = value
    this.#listCacheAt = now
    return value
  }

  /** 让下一次 `list` 一定重新问 VMware。 */
  invalidateList() {
    this.#listCache = null
    this.#listCacheAt = 0
  }

  /**
   * 执行一次电源动作。
   * @param action - `start` / `stop` / `suspend` / `pause` / `unpause` / `reset`。
   * @param vmxPath - vmx 绝对路径。
   * @param options - 关机方式、是否 GUI、超时、取消信号与加密口令。
   * @returns 归一化结果。
   */
  async power(action, vmxPath, { mode = 'soft', gui = false, timeoutMs, signal, password } = {}) {
    const softness = mode === 'hard' ? 'hard' : 'soft'
    let args
    if (action === 'start') args = ['start', vmxPath, gui === true ? 'gui' : 'nogui']
    else if (action === 'stop') args = ['stop', vmxPath, softness]
    else if (action === 'reset') args = ['reset', vmxPath, softness]
    else if (action === 'suspend') args = ['suspend', vmxPath, softness]
    else if (action === 'pause') args = ['pause', vmxPath]
    else if (action === 'unpause') args = ['unpause', vmxPath]
    else throw new Error(t('api.powerInvalidAction', { action: String(action) }))
    const defaultTimeout = (action === 'start' && gui === true)
      ? GUI_START_TIMEOUT_MS
      : DEFAULT_ACTION_TIMEOUT[action] ?? this.#timeoutMs
    const result = await this.run(args, {
      timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : defaultTimeout,
      signal,
      password,
    })
    this.invalidateList()
    return { ...result, action }
  }

  /**
   * 列出快照。
   * @param vmxPath - vmx 绝对路径。
   * @param options - `tree` 请求缩进树。
   * @returns `{ ok, snapshots, error }`。
   */
  async snapshots(vmxPath, { tree = true, signal } = {}) {
    const result = await this.run(['listSnapshots', vmxPath, ...(tree ? ['showTree'] : [])], { timeoutMs: 30000, signal })
    return result.ok
      ? { ok: true, snapshots: parseSnapshots(result.stdout, { tree }), error: undefined }
      : { ok: false, snapshots: [], error: result }
  }

  /** 创建快照。 */
  async createSnapshot(vmxPath, name, { signal } = {}) {
    return this.run(['snapshot', vmxPath, name], { timeoutMs: 180000, signal })
  }

  /** 回滚到快照。 */
  async revertSnapshot(vmxPath, name, { signal } = {}) {
    const result = await this.run(['revertToSnapshot', vmxPath, name], { timeoutMs: 300000, signal })
    this.invalidateList()
    return result
  }

  /** 删除快照。 */
  async deleteSnapshot(vmxPath, name, { children = false, signal } = {}) {
    return this.run(['deleteSnapshot', vmxPath, name, ...(children ? ['andDeleteChildren'] : [])], { timeoutMs: 180000, signal })
  }

  /** 删除虚拟机及其磁盘文件。 */
  async deleteVm(vmxPath, { signal } = {}) {
    const result = await this.run(['deleteVM', vmxPath], { timeoutMs: 300000, signal })
    this.invalidateList()
    return result
  }

  /**
   * 读 VMware Tools 状态。
   * @param vmxPath - vmx 绝对路径。
   * @returns `{ ok, state }`；`state` 形如 `installed` / `notInstalled` / `notRunning`。
   */
  async toolsState(vmxPath, { signal } = {}) {
    const result = await this.run(['checkToolsState', vmxPath], { timeoutMs: 20000, signal })
    return { ok: result.ok, state: result.stdout.trim(), error: result.ok ? undefined : result }
  }

  /**
   * 取客户机 IP（需要 VMware Tools 就绪）。
   * @param vmxPath - vmx 绝对路径。
   * @param options - `wait` 让 vmrun 等待 Tools 回报。
   */
  async guestIp(vmxPath, { wait = false, signal } = {}) {
    const result = await this.run(['getGuestIPAddress', vmxPath, ...(wait ? ['-wait'] : [])], { timeoutMs: 45000, signal })
    return { ok: result.ok, ip: result.stdout.trim(), error: result.ok ? undefined : result }
  }

  /**
   * 列出宿主虚拟网络（供「自定义网络」下拉框）。
   * @returns `{ ok, networks, error }`。
   */
  async hostNetworks({ signal } = {}) {
    const result = await this.run(['listHostNetworks'], { timeoutMs: 20000, signal })
    return result.ok
      ? { ok: true, networks: parseHostNetworks(result.stdout), error: undefined }
      : { ok: false, networks: [], error: result }
  }

  /**
   * 列出某个虚拟网络上的端口映射（NAT 转发）。
   * @param network - 虚拟网络名，如 `VMnet8`。
   * @returns `{ ok, forwards, error }`。
   */
  async portForwardings(network, { signal } = {}) {
    const result = await this.run(['listPortForwardings', network], { timeoutMs: 20000, signal })
    return result.ok
      ? { ok: true, forwards: parsePortForwardings(result.stdout), error: undefined }
      : { ok: false, forwards: [], error: result }
  }

  /**
   * 读一个运行期变量（`runtimeConfig`）。
   * @param vmxPath - vmx 绝对路径。
   * @param name - 变量名。
   * @param kind - `runtimeConfig` / `guestEnv` / `guestVar`。
   */
  async readVariable(vmxPath, name, { kind = 'runtimeConfig', signal } = {}) {
    const result = await this.run(['readVariable', vmxPath, kind, name], { timeoutMs: 20000, signal })
    return { ok: result.ok, value: result.stdout.trim(), error: result.ok ? undefined : result }
  }

  /**
   * 把一次失败渲染成多行文本：标题行 + 原始 stderr + 归因 + 修复方向。
   *
   * @param result - {@link Vmrun.run} 的结果。
   * @param options - `incomplete` 为真时把「输出不完整」放在第一行。
   * @returns 面向模型 / 界面的文本。
   */
  describeFailure(result, { incomplete = true } = {}) {
    const parts = []
    if (incomplete && result.timedOut === true) parts.push(t('err.incompleteTimeout'))
    const head = result.code === null
      ? t('err.vmrunFailedNoCode', { command: result.command })
      : t('err.vmrunFailed', { command: result.command, code: result.code })
    const detail = [result.stderr, result.stdout].map((part) => String(part ?? '').trim()).filter((part) => part.length > 0).join('\n')
    parts.push(detail.length > 0 ? `${head}\n${detail}` : head)
    const category = result.category ?? 'unknown'
    const messageKey = CATEGORY_MESSAGE[category]
    if (messageKey !== undefined) parts.push(t(messageKey))
    const hintKey = CATEGORY_HINT[category]
    if (hintKey !== undefined) parts.push(t(hintKey))
    return parts.join('\n')
  }
}
