/**
 * 虚拟机库存：把「磁盘上的 vmx 文件」「VMware 认为在运行什么」「插件记住了什么」
 * 这三份事实合成一张表。
 *
 * 三份事实的来源和可信度各不相同，因此各自的取舍在下面每处都有交代：
 *
 * - **磁盘**是权威的来源。搜索目录里的 `*.vmx` 都会被扫出来（深度有限），所以新装一台
 *   虚拟机不需要先「登记」；登记只是为了让不在搜索目录里的虚拟机也能被管到。
 * - **`vmrun list`** 只回答「谁在运行」。它把暂停中的虚拟机也算运行中，也不告诉你
 *   「挂起」（挂起是关机状态，只是带着 .vmss 镜像），于是运行态要靠 `vmrun list` +
 *   `.lck` 目录 + `.vmss` 文件三者合起来判断。
 * - **插件自己的记录**负责那些 VMware 不存的东西：备注、标签、快照说明，以及「这台是
 *   被插件暂停的」。最后一项不是冗余——没有它，「暂停」和「运行」在界面上就分不开。
 *
 * 所有动作方法都返回结构化结果，文案由 `lib/format.js` 生成：同一份数据既要给模型看，
 * 也要给设置页看，把渲染集中在一处才不会两边说法不一致。
 *
 * @module dsh-vm-control/inventory
 */

import { mkdir, readdir, rename, stat } from 'node:fs/promises'
import path from 'node:path'
import { readVmx, writeVmx } from './vmx.js'
import { collectProcessMetrics, indexSamples } from './metrics.js'
import { vmxKey } from './store.js'
import { t } from './i18n.js'

/** 默认扫描深度：`根/vm名/vm.vmx` 是两层，留一层余量给 `根/分类/vm名/vm.vmx`。 */
export const DEFAULT_SCAN_DEPTH = 3
/** 单次扫描的目录项上限：防止有人把搜索目录指到整个磁盘。 */
const MAX_SCAN_ENTRIES = 20000
/** 扫描结果缓存时长。 */
const SCAN_TTL_MS = 8000
/** 运行态缓存时长：比扫描短得多，因为它才是「实时」的那一半。 */
const RUNNING_TTL_MS = 1500
/** 占用采集缓存时长。 */
const METRICS_TTL_MS = 2500

/** 电源动作 → 允许的起始状态。`suspended` 的虚拟机用 `start` 唤醒，这是 vmrun 的语义。 */
const POWER_GUARDS = Object.freeze({
  start: ['stopped', 'suspended'],
  stop: ['running', 'paused'],
  suspend: ['running'],
  pause: ['running'],
  unpause: ['paused', 'running'],
  reset: ['running', 'paused'],
})

/** 电源动作完成后应该看到的状态。 */
const POWER_TARGET = Object.freeze({
  start: 'running',
  stop: 'stopped',
  suspend: 'suspended',
  pause: 'paused',
  unpause: 'running',
  reset: 'running',
})

/** 与界面无关的噪声目录：扫到它们既慢又没有 vmx。 */
const SKIP_DIRS = new Set(['node_modules', '.git', '$recycle.bin', 'system volume information', 'windows', 'program files', 'program files (x86)'])

/**
 * 深度优先扫描一个目录，收集 vmx 文件。
 *
 * @param root - 起始目录。
 * @param options - 深度与上限。
 * @returns `{ vmxFiles, truncated }`。
 */
export async function scanRoot(root, { depth = DEFAULT_SCAN_DEPTH, maxEntries = MAX_SCAN_ENTRIES } = {}) {
  const found = []
  let visited = 0
  let truncated = false
  const walk = async (dir, level) => {
    if (level > depth || truncated) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      visited += 1
      if (visited > maxEntries) {
        truncated = true
        return
      }
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        const lower = entry.name.toLowerCase()
        if (SKIP_DIRS.has(lower) || lower.endsWith('.lck')) continue
        await walk(full, level + 1)
        continue
      }
      if (!entry.isFile()) continue
      if (!/\.vmx$/i.test(entry.name)) continue
      // VMware 自己会留下 `vmx~` 之类的备份文件；`.vmx` 严格结尾已经把它们排除。
      found.push(full)
    }
  }
  await walk(root, 0)
  return { vmxFiles: found, truncated }
}

/**
 * 判断一个路径是否存在（不抛错）。
 * @param target - 路径。
 * @returns 存在时为 true。
 */
async function exists(target) {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

/** 虚拟机库存与生命周期操作。 */
export class Inventory {
  #store
  #vmrun
  #logger
  #scanDepth
  #trashDir
  #collectMetrics
  #scanCache = null
  #scanCacheAt = 0
  #runningCache = null
  #runningCacheAt = 0
  #metricsCache = null
  #metricsCacheAt = 0

  /**
   * @param options - 依赖与配置。
   * @param options.store - 数据存储。
   * @param options.vmrun - vmrun 封装。
   * @param options.trashDir - 「移到回收站」的目标目录。
   * @param options.scanDepth - 搜索目录的扫描深度。
   * @param options.metrics - 是否允许采集宿主进程占用（关掉后列表不再问 PowerShell）。
   * @param options.logger - 可选日志接口。
   */
  constructor({ store, vmrun, trashDir, scanDepth = DEFAULT_SCAN_DEPTH, metrics = true, logger } = {}) {
    this.#store = store
    this.#vmrun = vmrun
    this.#trashDir = trashDir
    this.#scanDepth = Number.isFinite(scanDepth) && scanDepth >= 0 ? scanDepth : DEFAULT_SCAN_DEPTH
    this.#collectMetrics = metrics === true
    this.#logger = logger
  }

  /** 回收站目录。 */
  get trashDir() {
    return this.#trashDir
  }

  /** vmrun 封装（设置接口用它渲染失败、读能力表）。 */
  get vmrun() {
    return this.#vmrun
  }

  /** 数据存储（设置接口改搜索目录时用）。 */
  get store() {
    return this.#store
  }

  /** 搜索目录（含是否存在的判断）。 */
  async roots() {
    const roots = await this.#store.roots()
    return Promise.all(roots.map(async (root) => ({ path: root, exists: await exists(root) })))
  }

  /**
   * 扫描全部搜索目录（带缓存）。
   * @param options - `refresh` 跳过缓存。
   * @returns `{ files, notes }`；`notes` 是「目录不存在 / 扫描被截断」这类需要告知用户的事实。
   */
  async #scan({ refresh = false } = {}) {
    const now = Date.now()
    if (refresh !== true && this.#scanCache !== null && now - this.#scanCacheAt < SCAN_TTL_MS) return this.#scanCache
    const roots = await this.roots()
    const files = []
    const notes = []
    for (const root of roots) {
      if (root.exists !== true) {
        notes.push({ kind: 'root-missing', path: root.path })
        continue
      }
      const result = await scanRoot(root.path, { depth: this.#scanDepth })
      files.push(...result.vmxFiles)
      if (result.truncated === true) notes.push({ kind: 'scan-truncated', path: root.path, depth: this.#scanDepth })
    }
    const value = { files, notes }
    this.#scanCache = value
    this.#scanCacheAt = now
    return value
  }

  /**
   * 当前运行中的虚拟机集合（vmx 小写路径）。
   * @param options - `refresh` 跳过缓存。
   * @returns `{ ok, set, error }`。
   */
  async #running({ refresh = false } = {}) {
    const now = Date.now()
    if (refresh !== true && this.#runningCache !== null && now - this.#runningCacheAt < RUNNING_TTL_MS) return this.#runningCache
    const listed = await this.#vmrun.list({ refresh })
    const set = new Set(listed.vms.map((vmx) => vmxKey(vmx)))
    const value = { ok: listed.ok, set, error: listed.error }
    this.#runningCache = value
    this.#runningCacheAt = now
    return value
  }

  /**
   * 宿主进程占用（vmx 小写路径 → 样本）。
   * @param options - `enabled` 为 false 时直接返回空表。
   * @returns `{ ok, map, error }`。
   */
  async #metrics({ enabled = true, refresh = false } = {}) {
    if (enabled !== true || this.#collectMetrics !== true) return { ok: true, map: new Map(), error: undefined }
    const now = Date.now()
    if (refresh !== true && this.#metricsCache !== null && now - this.#metricsCacheAt < METRICS_TTL_MS) return this.#metricsCache
    const collected = await collectProcessMetrics()
    const map = indexSamples(collected.samples ?? [])
    const value = { ok: collected.ok === true, map, error: collected.error }
    this.#metricsCache = value
    this.#metricsCacheAt = now
    return value
  }

  /** 让下一次读取一定重新问 VMware。 */
  invalidate() {
    this.#scanCache = null
    this.#scanCacheAt = 0
    this.#runningCache = null
    this.#runningCacheAt = 0
    this.#metricsCache = null
    this.#metricsCacheAt = 0
  }

  /**
   * 列出全部已知虚拟机。
   *
   * @param options - 过滤与开关。
   * @param options.refresh - 跳过缓存。
   * @param options.includeMetrics - 是否采集占用（默认 true）。
   * @param options.includeGuest - 是否向 VMware Tools 询问客户机信息（慢，默认 false）。
   * @param options.includeStopped - 是否包含已停止的虚拟机（默认 true）。
   * @returns `{ entries, roots, notes, running, metricsOk, vmrun }`。
   */
  async list({ refresh = false, includeMetrics = true, includeGuest = false, includeStopped = true } = {}) {
    const [scan, registered, running, metrics, vmrun] = await Promise.all([
      this.#scan({ refresh }),
      this.#store.listVms(),
      this.#running({ refresh }),
      this.#metrics({ enabled: includeMetrics, refresh }),
      this.#vmrun.probe(),
    ])

    /** 小写路径 → 记录；扫描到的与登记的合并，登记的优先（它带着备注等元数据）。 */
    const merged = new Map()
    for (const record of registered) merged.set(vmxKey(record.vmx), { vmx: record.vmx, record })
    for (const file of scan.files) {
      const key = vmxKey(file)
      if (!merged.has(key)) merged.set(key, { vmx: file, record: undefined })
    }

    const entries = []
    for (const item of merged.values()) {
      const entry = await this.#describeItem(item, { running, metrics, includeGuest })
      if (includeStopped !== true && entry.state === 'stopped') continue
      entries.push(entry)
    }
    entries.sort((a, b) => {
      // 运行中的排在前面：一张关心「现在怎么样」的列表，把已关机的混在中间没有意义。
      const rank = (entry) => (entry.state === 'running' || entry.state === 'paused' ? 0 : entry.state === 'suspended' ? 1 : 2)
      const delta = rank(a) - rank(b)
      return delta !== 0 ? delta : String(a.name).localeCompare(String(b.name))
    })

    return {
      entries,
      roots: scan.notes,
      notes: scan.notes,
      runningOk: running.ok,
      metricsOk: metrics.ok,
      metricsError: metrics.error,
      vmrun,
    }
  }

  /**
   * 把一条候选整理成视图。
   * @param item - `{ vmx, record }`。
   * @param context - 运行集合与占用。
   * @returns 视图对象。
   */
  async #describeItem(item, { running, metrics, includeGuest = false }) {
    const vmx = item.vmx
    const record = item.record
    const state = await this.#stateOf(vmx, running, record)
    const base = {
      id: vmx,
      vmx,
      folder: path.dirname(vmx),
      name: record?.name ?? path.basename(vmx, path.extname(vmx)),
      registered: record !== undefined,
      missing: state === 'missing',
      state,
      tags: record?.tags ?? [],
      notes: record?.notes ?? '',
      credentialRef: record?.credentialRef ?? '',
      pausedAt: record?.pausedAt ?? '',
      snapshotNotes: record?.snapshots ?? {},
      guestOS: '',
      guestFamily: 'other',
      cpus: 0,
      coresPerSocket: 1,
      sockets: 0,
      memoryMB: 0,
      firmware: 'bios',
      hwVersion: '',
      toolsSyncTime: false,
      encrypted: false,
      annotation: '',
      nics: [],
      disks: [],
      resources: undefined,
      guest: undefined,
    }
    if (state === 'missing') return base
    let file
    try {
      file = await readVmx(vmx)
    } catch (error) {
      this.#logger?.warn?.(`vm-control: cannot read ${vmx}: ${error instanceof Error ? error.message : String(error)}`)
      return { ...base, state: 'missing', missing: true }
    }
    const sample = metrics.map.get(vmxKey(vmx))
    const entry = {
      ...base,
      name: record?.name && record.name.length > 0 ? record.name : file.info.displayName,
      guestOS: file.info.guestOS,
      guestFamily: file.info.guestFamily,
      cpus: file.info.cpus,
      coresPerSocket: file.info.coresPerSocket,
      sockets: file.info.sockets,
      memoryMB: file.info.memoryMB,
      firmware: file.info.firmware,
      hwVersion: file.info.hwVersion,
      toolsSyncTime: file.info.toolsSyncTime,
      encrypted: file.info.encrypted || file.info.guestOS === 'vmware-encrypted',
      annotation: file.info.annotation,
      nics: file.info.nics,
      disks: file.info.disks,
      resources: sample === undefined
        ? undefined
        : {
            pid: sample.pid,
            cpuPercent: sample.cpuPercent,
            cpuPercentRaw: sample.cpuPercentRaw,
            workingSetBytes: sample.workingSetBytes,
            privateBytes: sample.privateBytes,
            threads: sample.threads,
            ioReadBytesPerSecond: sample.ioReadBytesPerSecond,
            ioWriteBytesPerSecond: sample.ioWriteBytesPerSecond,
            elapsedSeconds: sample.elapsedSeconds,
          },
      snapshotCount: record === undefined ? undefined : Object.keys(record.snapshots ?? {}).length,
    }
    if (includeGuest === true && state === 'running') {
      entry.guest = await this.guestInfo(vmx, { record })
    }
    return entry
  }

  /**
   * 判断一台虚拟机的状态。
   *
   * 顺序是有意义的：先信 `vmrun list`（VMware 自己的话），再信锁目录（正在切换），
   * 最后看挂起镜像。
   *
   * @param vmxPath - vmx 路径。
   * @param running - 运行集合。
   * @param record - 插件记录（用于暂停标记）。
   * @returns 状态名。
   */
  async #stateOf(vmxPath, running, record) {
    if (!(await exists(vmxPath))) return 'missing'
    const key = vmxKey(vmxPath)
    if (running.set.has(key)) return record?.pausedAt ? 'paused' : 'running'
    const parsed = path.parse(vmxPath)
    const suspended = await exists(path.join(parsed.dir, `${parsed.name}.vmss`))
    // `vmrun list` 成功时它就是权威。残留的 `.vmx.lck` 目录**不能**当成「正在运行」：
    // VMware 崩溃或强制关机后不会清理它，按锁判断会把一堆关机的虚拟机显示成运行中
    // （真实机器上第一次跑联调就踩到了这一点）。只在列表读失败时才退回文件的启发式。
    if (running.ok === true) return suspended ? 'suspended' : 'stopped'
    if (await exists(`${vmxPath}.lck`)) return record?.pausedAt ? 'paused' : 'running'
    return suspended ? 'suspended' : 'stopped'
  }

  /**
   * 把用户给的引用解析成一台虚拟机。
   *
   * 接受三种写法：vmx 绝对路径、插件 id（就是 vmx 路径）、以及虚拟机名。名字冲突时
   * 不猜——把候选列出来让调用方改用路径，猜错的下场可能是关错机器。
   *
   * @param ref - 引用。
   * @throws 找不到或有歧义时抛错（消息已本地化）。
   * @returns `{ vmx, record }`。
   */
  async resolve(ref) {
    const text = typeof ref === 'string' ? ref.trim() : ''
    if (text.length === 0) throw new Error(t('api.vmRequired'))
    const known = await this.#known()
    const byPath = known.get(vmxKey(text))
    if (byPath !== undefined) return byPath
    const lower = text.toLowerCase()
    const byName = [...known.values()].filter((item) => item.name.toLowerCase() === lower
      || path.basename(item.vmx, path.extname(item.vmx)).toLowerCase() === lower)
    if (byName.length === 1) return byName[0]
    if (byName.length > 1) {
      throw new Error(t('vm.ambiguous', { ref: text, list: byName.map((item) => item.vmx).join(' | ') }))
    }
    const names = [...known.values()].map((item) => item.name).sort()
    throw new Error(t('vm.notFound', {
      ref: text,
      hint: names.length > 0 ? t('vm.knownVms', { list: names.join(', ') }) : t('vm.knownVmsEmpty'),
    }))
  }

  /**
   * 全部已知虚拟机（登记 + 扫描），以小写路径为键。
   * @returns Map。
   */
  async #known() {
    const [scan, registered] = await Promise.all([this.#scan(), this.#store.listVms()])
    const map = new Map()
    for (const record of registered) {
      map.set(vmxKey(record.vmx), { vmx: record.vmx, record, name: record.name })
    }
    for (const file of scan.files) {
      const key = vmxKey(file)
      if (map.has(key)) continue
      // 名字必须与列表里显示的一致，否则「关掉 Kali Linux」会因为手里只有文件名而找不到。
      // vmx 读取有 mtime 缓存，这里多读一次不会变成重复 I/O。
      let name = path.basename(file, path.extname(file))
      try {
        const parsed = await readVmx(file)
        if (parsed.info.displayName.length > 0) name = parsed.info.displayName
      } catch {
        // 读不了就退回文件名：至少路径仍可用来定位。
      }
      map.set(key, { vmx: file, record: undefined, name })
    }
    return map
  }

  /**
   * 读一台虚拟机的详情。
   * @param ref - 引用。
   * @param options - 是否附带快照与客户机信息。
   * @returns 视图对象（可能带 `snapshots` / `guest`）。
   */
  async detail(ref, { includeSnapshots = false, includeGuest = false } = {}) {
    const item = await this.resolve(ref)
    const running = await this.#running()
    const metrics = await this.#metrics()
    const entry = await this.#describeItem(item, { running, metrics, includeGuest })
    if (includeSnapshots === true && entry.state !== 'missing') {
      const listed = await this.#vmrun.snapshots(item.vmx)
      entry.snapshots = listed.snapshots.map((snapshot) => {
        const meta = entry.snapshotNotes?.[snapshot.name]
        return {
          ...snapshot,
          note: meta?.note ?? '',
          createdAt: meta?.at ?? '',
        }
      })
      if (listed.ok !== true) entry.snapshotsError = listed.error
    }
    return entry
  }

  /**
   * 向 VMware Tools 询问客户机信息。
   *
   * VMware Tools 没装 / 没跑时这里必然失败，那是正常状态而不是错误，因此返回
   * `{ available: false, reason }` 而不是抛错。
   *
   * @param ref - 引用或 vmx 路径。
   * @param options - 记录（用于 NAT 端口映射）与是否等待。
   * @returns `{ available, tools, ip, forwards, reason }`。
   */
  async guestInfo(ref, { wait = false } = {}) {
    const known = await this.#known()
    const item = known.get(vmxKey(ref))
    const vmx = item?.vmx ?? ref
    const [tools, ip] = await Promise.all([
      this.#vmrun.toolsState(vmx),
      this.#vmrun.guestIp(vmx, { wait }),
    ])
    return {
      available: ip.ok === true && ip.ip.length > 0,
      tools: tools.ok === true ? tools.state : '',
      ip: ip.ok === true ? ip.ip : '',
      reason: ip.ok === true ? undefined : (ip.error?.category === 'tools' ? 'tools' : 'unavailable'),
    }
  }

  /**
   * 取某个虚拟网络的端口映射（NAT 转发），供详情视图使用。
   * @param network - 虚拟网络名。
   * @returns `{ ok, forwards, error }`。
   */
  async portForwardings(network) {
    return this.#vmrun.portForwardings(network)
  }

  /**
   * 宿主虚拟网络列表（供「自定义网络」选择）。
   * @returns `{ ok, networks, error }`。
   */
  async hostNetworks() {
    return this.#vmrun.hostNetworks()
  }

  /**
   * 执行一次电源动作，并在结束后确认状态确实变了。
   *
   * 「确认」这一步不是为了好看：`vmrun start` 成功返回只代表命令被接受，虚拟机可能因为
   * 缺内存、快照损坏、磁盘被占用而在几秒后退出。把结果停在「已发出」等于把判断留给用户。
   *
   * @param ref - 引用。
   * @param action - `start` / `stop` / `suspend` / `pause` / `unpause` / `reset` / `status`。
   * @param options - 关机方式、GUI、超时、取消信号、口令解析。
   * @returns `{ ok, entry, action, from, to, result, reason, notes }`。
   */
  async power(ref, action, { mode = 'soft', gui = false, timeoutMs, signal, passwordFor } = {}) {
    const item = await this.resolve(ref)
    const before = await this.detail(item.vmx)
    if (action === 'status') {
      return { ok: true, action, entry: before, from: before.state, to: before.state, result: undefined, reason: 'status', notes: [] }
    }
    const guards = POWER_GUARDS[action]
    if (guards === undefined) throw new Error(t('api.powerInvalidAction', { action: String(action) }))
    if (!guards.includes(before.state)) {
      return { ok: false, action, entry: before, from: before.state, to: before.state, result: undefined, reason: 'state', notes: [] }
    }
    const notes = []
    let result = await this.#vmrun.power(action, item.vmx, { mode, gui, timeoutMs, signal })
    if (!result.ok && result.category === 'encrypted' && typeof passwordFor === 'function') {
      // 加密虚拟机：口令只能在被明确需要时才取，这样绝大多数调用不会在命令行上留下它。
      const password = await passwordFor(item.record)
      if (typeof password === 'string' && password.length > 0) {
        result = await this.#vmrun.power(action, item.vmx, { mode, gui, timeoutMs, signal, password })
      }
    }
    if (!result.ok) {
      this.invalidate()
      return { ok: false, action, entry: before, from: before.state, to: before.state, result, reason: 'vmrun', notes }
    }
    if (action === 'pause') await this.#markPaused(item.vmx, before.name, true)
    if (action === 'unpause' || action === 'stop' || action === 'suspend') {
      await this.#markPaused(item.vmx, before.name, false)
    }
    if (action === 'start' && gui === true) notes.push('start-gui')
    this.invalidate()
    const target = POWER_TARGET[action] ?? before.state
    const waitMs = Math.min(timeoutMs ?? 45000, 120000)
    const confirmed = await this.#waitForState(item.vmx, target, { timeoutMs: waitMs })
    const after = await this.detail(item.vmx)
    return {
      ok: true,
      action,
      entry: after,
      from: before.state,
      to: after.state,
      result,
      reason: confirmed ? 'confirmed' : 'unconfirmed',
      target,
      timeoutMs: waitMs,
      notes,
    }
  }

  /**
   * 记录 / 清除暂停标记。
   *
   * 只被扫描到、没登记过的虚拟机也要能记住「它是被暂停的」——否则用一次暂停之后，
   * 界面仍然显示运行中。这里按需补一条记录，名字沿用展示名，避免之后列表里出现
   * 文件名而不是虚拟机名。
   *
   * @param vmxPath - vmx 路径。
   * @param name - 展示名。
   * @param paused - 是否暂停中。
   */
  async #markPaused(vmxPath, name, paused) {
    const record = await this.#store.get(vmxPath)
    if (record === undefined) {
      // 没有记录时直接带着 pausedAt 落盘：先 put 再 setPaused 会留下两次写盘，
      // 而中间那一刻的状态是「运行中」，后续等待会一直等不到目标状态。
      if (paused !== true) return
      await this.#store.put({ vmx: vmxPath, name, pausedAt: new Date().toISOString() })
      return
    }
    await this.#store.setPaused(vmxPath, paused)
  }

  /**
   * 轮询等待状态到位。
   * @param vmxPath - vmx 路径。
   * @param target - 目标状态。
   * @param options - 超时与轮询间隔。
   * @returns 是否在时限内看到目标状态。
   */
  async #waitForState(vmxPath, target, { timeoutMs = 45000, intervalMs = 1000 } = {}) {
    const deadline = Date.now() + Math.max(timeoutMs, 1000)
    while (Date.now() < deadline) {
      this.#runningCache = null
      const running = await this.#running({ refresh: true })
      const record = await this.#store.get(vmxPath)
      const state = await this.#stateOf(vmxPath, running, record)
      if (state === target) return true
      if (target !== 'running' && state === 'missing') return false
      // 定时器**不 unref**：这里是在 await 一个结果，unref 会让「事件循环已空」的进程
      // 直接退出，留下一个永不 resolve 的 promise。等待本身有 timeoutMs 兜底。
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
    return false
  }

  /**
   * 列出快照。
   * @param ref - 引用。
   * @returns `{ ok, snapshots, error, entry }`。
   */
  async snapshots(ref) {
    const item = await this.resolve(ref)
    const listed = await this.#vmrun.snapshots(item.vmx)
    const record = item.record ?? (await this.#store.get(item.vmx))
    const notes = record?.snapshots ?? {}
    const snapshots = listed.snapshots.map((snapshot) => ({
      ...snapshot,
      note: notes[snapshot.name]?.note ?? '',
      createdAt: notes[snapshot.name]?.at ?? '',
    }))
    return { ok: listed.ok, snapshots, error: listed.error, vmx: item.vmx }
  }

  /**
   * 创建快照。
   * @param ref - 引用。
   * @param name - 快照名。
   * @param options - 备注与取消信号。
   * @returns `{ ok, result, snapshots }`。
   */
  async createSnapshot(ref, name, { description, signal } = {}) {
    const snapshotName = String(name ?? '').trim()
    if (snapshotName.length === 0) throw new Error(t('api.snapshotNameRequired'))
    const item = await this.resolve(ref)
    const result = await this.#vmrun.createSnapshot(item.vmx, snapshotName, { signal })
    if (result.ok && typeof description === 'string' && description.length > 0) {
      // vmrun 不保存描述，只能记在插件自己的数据里；记录不存在时先补一条。
      const record = item.record ?? await this.#store.put({
        vmx: item.vmx,
        name: path.basename(item.vmx, path.extname(item.vmx)),
      })
      await this.#store.setSnapshotNote(record.vmx, snapshotName, description)
    }
    return result.ok
      ? { ok: true, result, snapshots: (await this.snapshots(item.vmx)).snapshots }
      : { ok: false, result, snapshots: [] }
  }

  /**
   * 回滚到快照。
   * @param ref - 引用。
   * @param name - 快照名。
   * @returns 归一化结果。
   */
  async revertSnapshot(ref, name, { signal } = {}) {
    const item = await this.resolve(ref)
    const existing = await this.#vmrun.snapshots(item.vmx, { tree: false })
    if (existing.ok && !existing.snapshots.some((snapshot) => snapshot.name === name)) {
      return {
        ok: false,
        reason: 'missing',
        available: existing.snapshots.map((snapshot) => snapshot.name),
        result: undefined,
      }
    }
    this.invalidate()
    const result = await this.#vmrun.revertSnapshot(item.vmx, name, { signal })
    this.invalidate()
    return { ok: result.ok, result, reason: result.ok ? undefined : 'vmrun' }
  }

  /**
   * 删除快照。
   * @param ref - 引用。
   * @param name - 快照名。
   * @param options - 是否连同子快照。
   * @returns 归一化结果。
   */
  async deleteSnapshot(ref, name, { children = false, signal } = {}) {
    const item = await this.resolve(ref)
    const result = await this.#vmrun.deleteSnapshot(item.vmx, name, { children, signal })
    if (result.ok && item.record !== undefined) await this.#store.setSnapshotNote(item.vmx, name, '')
    return result
  }

  /**
   * 登记一台虚拟机。
   * @param options - vmx 路径与元数据。
   * @returns 记录。
   */
  async register({ vmxPath, name, tags, notes, credentialRef } = {}) {
    const target = path.resolve(String(vmxPath ?? '').trim())
    const info = await stat(target).catch(() => undefined)
    if (info === undefined || !info.isFile()) throw new Error(t('api.vmxMissing', { path: target }))
    if (!/\.vmx$/i.test(target)) throw new Error(t('api.vmxNotVmx', { path: target }))
    let file
    try {
      file = await readVmx(target)
    } catch (error) {
      throw new Error(t('api.vmxMissing', { path: target }))
    }
    const displayName = typeof name === 'string' && name.trim().length > 0 ? name.trim() : file.info.displayName
    // 同名不同机：报错而不是自动改名。名字是模型与用户唯一的常用句柄，重复会让「关掉 kali」
    // 变成一次猜测。
    const known = await this.#known()
    for (const item of known.values()) {
      if (item.name.toLowerCase() === displayName.toLowerCase() && vmxKey(item.vmx) !== vmxKey(target)) {
        throw new Error(t('api.nameTaken', { name: displayName, path: item.vmx }))
      }
    }
    return this.#store.put({
      vmx: target,
      name: displayName,
      tags: Array.isArray(tags) ? tags : [],
      notes: typeof notes === 'string' ? notes : '',
      credentialRef: typeof credentialRef === 'string' ? credentialRef : '',
    })
  }

  /**
   * 取消登记（不动磁盘文件）。
   * @param ref - 引用。
   * @returns `{ removed, vmx }`。
   */
  async unregister(ref) {
    const item = await this.resolve(ref)
    const removed = await this.#store.remove(item.vmx)
    this.invalidate()
    return { removed, vmx: item.vmx }
  }

  /**
   * 删除一台虚拟机。
   *
   * 三种语义彼此独立，默认必须是「可恢复」的那个：
   * - `keep`   —— 只从插件列表移除，磁盘不动；
   * - `trash`  —— 把整个虚拟机目录移到插件回收站（默认）；
   * - `purge`  —— `vmrun deleteVM`，连同磁盘文件一起删掉，不可恢复。
   *
   * 移动目录前会检查目录里是否还有别的 `.vmx`：一起带走别人的虚拟机会是灾难。
   *
   * @param ref - 引用。
   * @param options - 模式与取消信号。
   * @returns `{ ok, mode, entry, result, trashPath }`。
   */
  async remove(ref, { mode = 'trash', signal } = {}) {
    const item = await this.resolve(ref)
    const entry = await this.detail(item.vmx)
    if (mode === 'keep') {
      const removed = await this.#store.remove(item.vmx)
      this.invalidate()
      return { ok: true, mode, entry, removed, result: undefined, trashPath: undefined }
    }
    if (mode === 'purge') {
      if (entry.state !== 'stopped' && entry.state !== 'suspended' && entry.state !== 'missing') {
        return { ok: false, mode, entry, reason: 'state', result: undefined }
      }
      if (entry.state === 'missing') {
        const removed = await this.#store.remove(item.vmx)
        this.invalidate()
        return { ok: true, mode: 'keep', entry, removed, result: undefined, trashPath: undefined }
      }
      const result = await this.#vmrun.deleteVm(item.vmx, { signal })
      if (result.ok) await this.#store.remove(item.vmx)
      this.invalidate()
      return { ok: result.ok, mode, entry, result, trashPath: undefined }
    }
    // trash：整个目录搬走。先确认目录里没有别的虚拟机。
    const folder = path.dirname(item.vmx)
    const siblings = (await readdir(folder).catch(() => [])).filter((file) => /\.vmx$/i.test(file) && file.toLowerCase() !== path.basename(item.vmx).toLowerCase())
    if (siblings.length > 0) {
      return { ok: false, mode: 'trash', entry, reason: 'shared-folder', siblings, result: undefined }
    }
    if (entry.state === 'running' || entry.state === 'paused') {
      return { ok: false, mode: 'trash', entry, reason: 'state', result: undefined }
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const safeName = String(entry.name).replace(/[\\/:*?"<>|]/g, '_')
    const target = path.join(this.#trashDir, `${safeName}-${stamp}`)
    try {
      // 回收站目录首次使用时并不存在，rename 不会替我们建父目录。
      await mkdir(this.#trashDir, { recursive: true })
      await rename(folder, target)
    } catch (error) {
      return { ok: false, mode: 'trash', entry, reason: 'rename-failed', detail: error instanceof Error ? error.message : String(error), result: undefined }
    }
    await this.#store.remove(item.vmx)
    this.invalidate()
    return { ok: true, mode: 'trash', entry, result: undefined, trashPath: target }
  }

  /**
   * 改写一台虚拟机的硬件参数。
   *
   * 只改 VMX，不碰磁盘。关机是硬要求：VMware 在运行中也会写同一个文件。
   *
   * @param ref - 引用。
   * @param patch - 参数（cpus / memoryMB / nicMode / nicName / toolsSyncTime / displayName / notes / tags / credentialRef）。
   * @returns `{ ok, entry, changed, backupPath, warnings, reason, state }`。
   */
  async configure(ref, patch = {}) {
    const item = await this.resolve(ref)
    const entry = await this.detail(item.vmx)
    const updates = {}
    const warnings = []
    if (patch.cpus !== undefined) {
      const cpus = Number(patch.cpus)
      if (!Number.isInteger(cpus) || cpus < 1 || cpus > 128) {
        return { ok: false, reason: 'cpus', entry, changed: [], warnings }
      }
      updates.numvcpus = String(cpus)
      // 每个插槽的核数不能超过总核数，否则 VMware 会拒绝启动。
      const cores = Math.min(Number(entry.coresPerSocket) || 1, cpus)
      updates['cpuid.coresPerSocket'] = String(cores)
    }
    if (patch.memoryMB !== undefined) {
      const memory = Number(patch.memoryMB)
      if (!Number.isInteger(memory) || memory < 4 || memory > 1048576 || memory % 4 !== 0) {
        return { ok: false, reason: 'memory', entry, changed: [], warnings }
      }
      updates.memsize = String(memory)
    }
    if (patch.nicMode !== undefined) {
      const mode = String(patch.nicMode)
      if (!['nat', 'bridged', 'hostonly', 'custom'].includes(mode)) {
        return { ok: false, reason: 'nicMode', entry, changed: [], warnings }
      }
      updates['ethernet0.connectionType'] = mode
      if (mode === 'custom') {
        const network = typeof patch.nicName === 'string' ? patch.nicName.trim() : ''
        if (network.length === 0) return { ok: false, reason: 'nicName', entry, changed: [], warnings }
        updates['ethernet0.networkName'] = network
        updates['ethernet0.displayName'] = network
      }
    }
    if (patch.toolsSyncTime !== undefined) {
      updates['tools.syncTime'] = patch.toolsSyncTime === true ? 'TRUE' : 'FALSE'
    }
    if (typeof patch.displayName === 'string' && patch.displayName.trim().length > 0) {
      updates.displayName = patch.displayName.trim()
    }

    const hardwareKeys = Object.keys(updates)
    if (hardwareKeys.length > 0) {
      // 运行中与暂停中都拒绝：VMware 正在写同一个 VMX。挂起状态允许但会给出警告——
      // 挂起镜像记录的硬件配置可能已经与新的 VMX 不一致。
      if (entry.state !== 'stopped' && entry.state !== 'suspended') {
        return { ok: false, reason: 'power', entry, changed: [], warnings, state: entry.state }
      }
      if (entry.state === 'suspended') warnings.push('suspended')
      const written = await writeVmx(item.vmx, updates)
      entry.changed = written.changed
      entry.backupPath = written.backupPath
    }

    const meta = {}
    if (typeof patch.notes === 'string') meta.notes = patch.notes
    if (Array.isArray(patch.tags)) meta.tags = patch.tags.filter((tag) => typeof tag === 'string' && tag.length > 0)
    if (typeof patch.credentialRef === 'string') meta.credentialRef = patch.credentialRef.trim()
    if (typeof patch.displayName === 'string' && patch.displayName.trim().length > 0) meta.name = patch.displayName.trim()
    if (Object.keys(meta).length > 0) {
      const record = item.record ?? await this.#store.put({
        vmx: item.vmx,
        name: meta.name ?? path.basename(item.vmx, path.extname(item.vmx)),
      })
      await this.#store.patch(record.vmx, meta)
    }
    this.invalidate()
    const changed = [...(entry.changed ?? [])]
    if (Object.keys(meta).length > 0) changed.push(...Object.keys(meta))
    return {
      ok: changed.length > 0,
      reason: changed.length > 0 ? undefined : 'no-changes',
      entry: await this.detail(item.vmx),
      changed: hardwareKeys.length > 0 ? hardwareKeys : changed,
      backupPath: entry.backupPath,
      warnings,
    }
  }
}
