/**
 * 可开关的诊断日志。
 *
 * 插件默认**不写任何日志**：开关关着的时候 `log()` 在第一行就返回，既不进内存也不碰磁盘，
 * 所以「关掉日志」是真的安静，而不是把日志写得少一点。打开之后：
 *
 * - 错误与事件写进 `<dir>/diagnostics.log`（单一文件，超过上限自动轮转到 `.1`）；
 * - 同一份内容镜像到宿主 logger，方便在 DSH 的日志里一起看；
 * - 最近若干条留在内存里，设置页可以直接读出来，不用去翻文件。
 *
 * 开关本身落在 `<dir>/diagnostics.json`，重启后保持——用户点了一次「开启」，不该在下一次
 * 启动时又悄悄变回关闭。
 *
 * 虚拟机插件本身不处理口令，但 `-vp` 加密口令会经过调用参数，因此每条内容仍然过一遍
 * `redactSecrets`，并且调用方**从不把整份参数传进来**。
 *
 * @module dsh-vm-control/diagnostics
 */

import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 默认的单个日志文件上限（字节）。 */
export const DEFAULT_MAX_BYTES = 512 * 1024
/** 内存里保留的最近条目数。 */
const DEFAULT_MAX_ENTRIES = 200
/** 设置页一次最多回显多少条。 */
export const READ_ENTRIES = 40
/** 开关状态文件与日志文件名。 */
const STATE_FILE = 'diagnostics.json'
const LOG_FILE = 'diagnostics.log'
/** 轮转后的归档后缀。 */
const ARCHIVE_SUFFIX = '.1'

/** 日志级别，数值越大越啰嗦。 */
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 }

/**
 * 抹掉文本里看起来像口令的东西。
 *
 * 覆盖两条真实路径：错误消息里回显的 `password=...`，以及 vmrun 的 `-vp <口令>`
 * 出现在命令行里时被一起记录的形态。
 *
 * @param text - 任意要写进日志的文本。
 * @returns 处理后的文本。
 */
export function redactSecrets(text) {
  return String(text ?? '')
    .replace(/(\b(?:password|passwd|passphrase|secret|token|credentialRef)\b\s*[=:]\s*)\S+/gi, '$1***')
    .replace(/(\s-vp\s+)\S+/g, '$1***')
}

/**
 * 把一个错误整理成一行消息。
 * @param error - 抛出的东西，通常是 Error。
 * @returns 消息文本。
 */
function messageOf(error) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/**
 * 把上下文对象拍平成 `key=value` 单行，空值直接丢掉。
 * @param context - 上下文对象。
 * @returns 形如 `vm=kali action=start` 的单行；没有可用字段时为空串。
 */
function contextLine(context) {
  if (context === undefined || context === null || typeof context !== 'object') return ''
  return Object.entries(context)
    .filter(([, value]) => value !== undefined && value !== null && String(value).length > 0)
    .map(([key, value]) => `${key}=${redactSecrets(String(value))}`)
    .join(' ')
}

/**
 * 生成一条日志块：首行是元信息，其余行缩进，便于在纯文本里辨认。
 * @param at - ISO 时间。
 * @param level - 级别名。
 * @param scope - 来源，如 `tool:vm_power`。
 * @param message - 摘要。
 * @param detail - 可选的详情（堆栈等）。
 * @returns 日志块文本。
 */
function formatEntry(at, level, scope, message, detail) {
  const head = `[${at}] ${level.toUpperCase()} ${scope} — ${redactSecrets(message)}`
  const text = typeof detail === 'string'
    ? detail
    : detail === undefined || detail === null ? '' : String(detail)
  const body = text.trim().length > 0
    ? text.split(/\r?\n/).map((line) => `    ${redactSecrets(line)}`).join('\n')
    : ''
  return body.length > 0 ? `${head}\n${body}` : head
}

/**
 * 判断一行是不是一条日志的首行。
 * @param line - 待判断的行。
 * @returns 是否为条目起始行。
 */
function isEntryHead(line) {
  return /^\[\d{4}-\d{2}-\d{2}T[^\]]*\] (?:ERROR|WARN|INFO|DEBUG) /.test(line)
}

/** 日志尾部的空行/分隔符，读回时要去掉。 */
const ENTRY_SEPARATOR = '\n\n'

/**
 * 诊断日志：开关、落盘、镜像、回读。
 */
export class Diagnostics {
  #dir
  #mirror
  #maxBytes
  #maxEntries
  #enabled
  #threshold
  #entries = []
  #ready

  /**
   * @param options - 日志配置。
   * @param options.dir - 日志目录。
   * @param options.enabled - 初始开关；持久化的开关优先。
   * @param options.mirror - 可选的宿主 logger。
   * @param options.maxBytes - 单个文件上限。
   */
  constructor({ dir, enabled = false, mirror, maxBytes } = {}) {
    this.#dir = dir
    this.#mirror = mirror
    this.#maxBytes = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_BYTES
    this.#maxEntries = DEFAULT_MAX_ENTRIES
    this.#enabled = enabled === true
    this.#threshold = LEVELS[enabled === true ? 'error' : 'error']
    // 初始开关与持久化状态合并是异步的；第一次真正写日志前会 await 这个 promise。
    this.#ready = this.#loadState()
  }

  /** 日志目录。 */
  get dir() {
    return this.#dir
  }

  /** 当前是否开启。 */
  get enabled() {
    return this.#enabled
  }

  /**
   * 暴露给依赖方的 logger 门面：宿主 logger 的 info/warn/error 都要经过开关。
   *
   * 依赖方（例如 Vmrun）只在这种形态下才拿得到「安静时不吵」的日志，
   * 而不是自己判断开关。
   */
  get logger() {
    return {
      info: (message) => this.info('lib', message),
      warn: (message) => this.warn('lib', message),
      error: (message) => this.error('lib', message),
    }
  }

  /** 读一次持久化的开关；文件不存在或损坏都按「关」处理。 */
  async #loadState() {
    try {
      const raw = JSON.parse(await readFile(join(this.#dir, STATE_FILE), 'utf8'))
      if (typeof raw.enabled === 'boolean') this.#enabled = raw.enabled
    } catch {
      // 从未开过日志：保持构造参数给的初始值。
    }
  }

  /** 确保目录存在。 */
  async ensureDir() {
    await mkdir(this.#dir, { recursive: true })
  }

  /**
   * 写一条日志。
   * @param level - `error` / `warn` / `info` / `debug`。
   * @param scope - 来源。
   * @param message - 摘要。
   * @param context - 可选的结构化上下文（会被抹掉敏感值）。
   * @param detail - 可选的详情。
   */
  async log(level, scope, message, context, detail) {
    if (!this.#enabled) return
    if ((LEVELS[level] ?? 0) > LEVELS[this.#threshold]) return
    await this.#ready
    if (!this.#enabled) return
    const at = new Date().toISOString()
    const line = contextLine(context)
    const summary = line.length > 0 ? `${message} (${line})` : message
    const block = formatEntry(at, level, scope, summary, detail)
    this.#entries.push(block)
    if (this.#entries.length > this.#maxEntries) this.#entries.splice(0, this.#entries.length - this.#maxEntries)
    const mirror = level === 'error' ? this.#mirror?.error : level === 'warn' ? this.#mirror?.warn : this.#mirror?.info
    try {
      mirror?.call(this.#mirror, `vm-control: ${summary}`)
    } catch {
      // 宿主 logger 出问题不该连带日志本身失败。
    }
    try {
      await this.ensureDir()
      const target = join(this.#dir, LOG_FILE)
      let size = 0
      try {
        size = (await stat(target)).size
      } catch {
        size = 0
      }
      if (size + block.length > this.#maxBytes) {
        await rename(target, `${target}${ARCHIVE_SUFFIX}`).catch(() => undefined)
      }
      await appendFile(target, `${block}${ENTRY_SEPARATOR}`, 'utf8')
    } catch {
      // 磁盘写不进去时，内存里的条目仍然可用。
    }
  }

  /** 记录一条错误。 */
  error(scope, error, context) {
    const detail = error instanceof Error ? error.stack ?? error.message : undefined
    void this.log('error', scope, messageOf(error), context, detail)
  }

  /** 记录一条警告。 */
  warn(scope, message, context, detail) {
    void this.log('warn', scope, message, context, detail)
  }

  /** 记录一条信息。 */
  info(scope, message, context, detail) {
    void this.log('info', scope, message, context, detail)
  }

  /**
   * 打开或关闭日志，并持久化。
   * @param enabled - 目标状态。
   */
  async setEnabled(enabled) {
    await this.#ready
    this.#enabled = enabled === true
    await this.ensureDir()
    await writeFile(join(this.#dir, STATE_FILE), `${JSON.stringify({ enabled: this.#enabled }, null, 2)}\n`, 'utf8')
  }

  /** 清空日志文件与内存条目。 */
  async clear() {
    this.#entries = []
    await rm(join(this.#dir, LOG_FILE), { force: true }).catch(() => undefined)
    await rm(join(this.#dir, `${LOG_FILE}${ARCHIVE_SUFFIX}`), { force: true }).catch(() => undefined)
  }

  /** 文件路径，供设置页展示。 */
  get filePath() {
    return join(this.#dir, LOG_FILE)
  }

  /**
   * 设置页需要的快照：开关、路径、大小、最近条目。
   * @returns 状态对象。
   */
  async status() {
    await this.#ready
    let bytes = 0
    try {
      bytes = (await stat(this.filePath)).size
    } catch {
      bytes = 0
    }
    return {
      enabled: this.#enabled,
      path: this.filePath,
      bytes,
      entries: this.#entries.slice(-READ_ENTRIES),
    }
  }
}
