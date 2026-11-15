/**
 * 插件的轻量数据文件。
 *
 * 与 SSH 保险库不同，这里**没有口令**：VMX 路径、备注、标签、搜索目录、快照备注、
 * 以及「这台虚拟机上一次是被插件暂停的」这类状态，都不构成需要加密的秘密。因此它是一份
 * 普通 JSON，可读、可手改、可进版本库——排查问题时能直接打开看，比密文有用。
 *
 * 唯一敏感的是 `credentialRef`（加密虚拟机的凭据名）：它只是**引用**，真实口令由宿主的
 * 凭据服务保管，磁盘上不会出现明文。
 *
 * 写入走「临时文件 + rename」，并在进程内串行化：一次刷新可能同时更新暂停状态与快照备注，
 * 两个并发写会把对方的结果覆盖掉。
 *
 * @module dsh-vm-control/store
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { t } from './i18n.js'

/** 数据文件格式版本。 */
export const STORE_VERSION = 1
/** 数据文件名。 */
const STORE_FILE = 'vms.json'

/**
 * 把 vmx 路径归一化成内部键：绝对路径 + 小写。
 *
 * Windows 上同一个文件可以用大小写不同的路径打开，而 `vmrun list` 回显的是 VMware 自己
 * 记录的写法；不归一化就会出现「同一台虚拟机两条记录」。
 *
 * @param vmxPath - vmx 路径。
 * @returns 内部键。
 */
export function vmxKey(vmxPath) {
  return path.resolve(String(vmxPath ?? '')).toLowerCase()
}

/**
 * 把一条记录整理成可安全返回给界面的形状。
 * @param record - 存储记录。
 * @returns 视图对象。
 */
export function recordView(record) {
  return {
    vmx: record.vmx,
    name: record.name,
    tags: Array.isArray(record.tags) ? record.tags : [],
    notes: record.notes ?? '',
    credentialRef: record.credentialRef ?? '',
    pausedAt: record.pausedAt ?? '',
    snapshots: record.snapshots ?? {},
    addedAt: record.addedAt ?? '',
    updatedAt: record.updatedAt ?? '',
  }
}

/**
 * 插件数据存储。
 */
export class Store {
  #dir
  #logger
  #defaultRoots
  #state = null
  #chain = Promise.resolve()

  /**
   * @param options - 目录与默认搜索目录。
   * @param options.dir - 数据目录（默认在 DSH_HOME 下）。
   * @param options.roots - 首次运行时写入的搜索目录。
   * @param options.logger - 可选日志接口。
   */
  constructor({ dir, roots, logger } = {}) {
    this.#dir = dir
    this.#logger = logger
    this.#defaultRoots = Array.isArray(roots) ? roots.filter((root) => typeof root === 'string' && root.length > 0) : []
  }

  /** 数据目录。 */
  get dir() {
    return this.#dir
  }

  /** 数据文件路径。 */
  get filePath() {
    return path.join(this.#dir, STORE_FILE)
  }

  /** 在存储锁内执行一次读改写。 */
  #locked(fn) {
    const run = this.#chain.then(fn, fn)
    this.#chain = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * 读取整份状态（带进程内缓存）。
   * @returns 状态对象。
   */
  async read() {
    return this.#locked(async () => this.#load())
  }

  /** 载入数据文件；损坏时备份并重新开始。 */
  async #load() {
    if (this.#state !== null) return this.#state
    const empty = () => ({
      version: STORE_VERSION,
      roots: [...this.#defaultRoots],
      vms: {},
    })
    if (!existsSync(this.filePath)) {
      this.#state = empty()
      return this.#state
    }
    try {
      const raw = JSON.parse(await readFile(this.filePath, 'utf8'))
      const vms = {}
      for (const [key, value] of Object.entries(raw?.vms ?? {})) {
        if (value === null || typeof value !== 'object') continue
        if (typeof value.vmx !== 'string' || value.vmx.length === 0) continue
        vms[key] = {
          vmx: value.vmx,
          name: typeof value.name === 'string' && value.name.length > 0 ? value.name : path.basename(value.vmx, path.extname(value.vmx)),
          tags: Array.isArray(value.tags) ? value.tags.filter((tag) => typeof tag === 'string' && tag.length > 0) : [],
          notes: typeof value.notes === 'string' ? value.notes : '',
          credentialRef: typeof value.credentialRef === 'string' ? value.credentialRef : '',
          pausedAt: typeof value.pausedAt === 'string' ? value.pausedAt : '',
          snapshots: value.snapshots !== null && typeof value.snapshots === 'object' ? value.snapshots : {},
          addedAt: value.addedAt ?? '',
          updatedAt: value.updatedAt ?? '',
        }
      }
      this.#state = {
        version: STORE_VERSION,
        roots: Array.isArray(raw?.roots) ? raw.roots.filter((root) => typeof root === 'string' && root.length > 0) : [...this.#defaultRoots],
        vms,
      }
    } catch (error) {
      const backup = `${this.filePath}.corrupt-${Date.now()}.bak`
      try {
        await rename(this.filePath, backup)
      } catch {
        // 备份失败也要继续：一个坏文件不该让插件彻底不可用。
      }
      this.#logger?.warn?.(t('store.corrupt', {
        backup,
        message: error instanceof Error ? error.message : String(error),
      }))
      this.#state = empty()
    }
    return this.#state
  }

  /** 原子落盘。 */
  async #write() {
    const state = this.#state
    await mkdir(this.#dir, { recursive: true })
    const temp = `${this.filePath}.${process.pid}.tmp`
    try {
      await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
      await rename(temp, this.filePath)
    } catch (error) {
      this.#logger?.error?.(t('store.writeFailed', { message: error instanceof Error ? error.message : String(error) }))
      throw error
    }
  }

  /**
   * 当前搜索目录。
   * @returns 目录数组。
   */
  async roots() {
    const state = await this.read()
    return [...state.roots]
  }

  /**
   * 覆盖搜索目录。
   * @param roots - 绝对路径数组。
   * @returns 生效后的目录数组。
   */
  async setRoots(roots) {
    return this.#locked(async () => {
      const state = await this.#load()
      state.roots = roots
      await this.#write()
      return [...state.roots]
    })
  }

  /**
   * 列出已登记的虚拟机记录（按名称排序）。
   * @returns 记录数组。
   */
  async listVms() {
    return this.#locked(async () => {
      const state = await this.#load()
      return Object.values(state.vms).sort((a, b) => String(a.name).localeCompare(String(b.name)))
    })
  }

  /**
   * 读一条记录。
   * @param vmxPath - vmx 路径。
   * @returns 记录，或 undefined。
   */
  async get(vmxPath) {
    return this.#locked(async () => {
      const state = await this.#load()
      return state.vms[vmxKey(vmxPath)]
    })
  }

  /**
   * 新增 / 覆盖一条记录。
   * @param record - 至少包含 `vmx` 与 `name`。
   * @returns 写入后的记录。
   */
  async put(record) {
    return this.#locked(async () => {
      const state = await this.#load()
      const key = vmxKey(record.vmx)
      const now = new Date().toISOString()
      const previous = state.vms[key]
      const next = {
        vmx: path.resolve(record.vmx),
        name: record.name,
        tags: Array.isArray(record.tags) ? record.tags : [],
        notes: record.notes ?? '',
        credentialRef: record.credentialRef ?? '',
        pausedAt: record.pausedAt ?? previous?.pausedAt ?? '',
        snapshots: record.snapshots ?? previous?.snapshots ?? {},
        addedAt: previous?.addedAt ?? now,
        updatedAt: now,
      }
      state.vms[key] = next
      await this.#write()
      return next
    })
  }

  /**
   * 就地更新一条记录。
   * @param vmxPath - vmx 路径。
   * @param patch - 要覆盖的字段。
   * @returns 更新后的记录；记录不存在时为 undefined。
   */
  async patch(vmxPath, patch) {
    return this.#locked(async () => {
      const state = await this.#load()
      const key = vmxKey(vmxPath)
      const previous = state.vms[key]
      if (previous === undefined) return undefined
      state.vms[key] = { ...previous, ...patch, vmx: previous.vmx, updatedAt: new Date().toISOString() }
      await this.#write()
      return state.vms[key]
    })
  }

  /**
   * 删除一条记录。
   * @param vmxPath - vmx 路径。
   * @returns 是否确实删除了记录。
   */
  async remove(vmxPath) {
    return this.#locked(async () => {
      const state = await this.#load()
      const key = vmxKey(vmxPath)
      if (state.vms[key] === undefined) return false
      delete state.vms[key]
      await this.#write()
      return true
    })
  }

  /**
   * 记录 / 清除「被插件暂停」这一事实。
   *
   * VMware 的 `vmrun list` 把暂停中的虚拟机也算作运行中，没有第二处可查的状态位；
   * 想让界面把「暂停」和「运行」分开显示，只能记住我们自己下发的 pause。
   * 通过 VMware 界面暂停的虚拟机会显示为运行中——这一点在界面提示里已说明。
   *
   * @param vmxPath - vmx 路径。
   * @param paused - 是否暂停中。
   */
  async setPaused(vmxPath, paused) {
    return this.patch(vmxPath, { pausedAt: paused === true ? new Date().toISOString() : '' })
  }

  /**
   * 记下一条快照备注（vmrun 本身不保存描述，只能记在这里）。
   * @param vmxPath - vmx 路径。
   * @param name - 快照名。
   * @param note - 备注。
   * @returns 更新后的记录。
   */
  async setSnapshotNote(vmxPath, name, note) {
    return this.#locked(async () => {
      const state = await this.#load()
      const key = vmxKey(vmxPath)
      const previous = state.vms[key]
      if (previous === undefined) return undefined
      const snapshots = { ...(previous.snapshots ?? {}) }
      if (typeof note === 'string' && note.length > 0) snapshots[name] = { note, at: new Date().toISOString() }
      else delete snapshots[name]
      state.vms[key] = { ...previous, snapshots, updatedAt: new Date().toISOString() }
      await this.#write()
      return state.vms[key]
    })
  }
}
