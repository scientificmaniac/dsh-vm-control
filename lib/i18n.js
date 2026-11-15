/**
 * Host 侧的双语文本表与 locale 解析。
 *
 * 为什么 Host 需要知道语言：工具输出、`/vm` 结果与设置接口的错误消息都由这里生成，
 * 而它们的读者是使用界面的人。DSH 的语言**不是**浏览器语言猜出来的，而是用户在
 * 「设置 → 通用 → 语言」里选择后写进 Host 设置的 `locale.preference`；`index.js` 通过
 * `settings.describe()` 读取它并订阅 `settings/document-updated` 跟随切换。
 * 只有完全没有显式偏好时，才退回 HTTP 请求的 `Accept-Language`。
 *
 * 保持零依赖：表就是几个普通对象，`t()` 只是查表 + 回退。
 *
 * @module dsh-vm-control/i18n
 */

import { VM_MESSAGES } from './locales/vm.js'

/** 支持的 locale 标识。 */
export const LOCALES = ['zh', 'en']

/** 没有任何信号时的默认语言，与插件作者的主要语言一致。 */
export const DEFAULT_LOCALE = 'zh'

/** DSH locale 设置条目（Loader 行 id）与字段名。 */
export const LOCALE_SETTINGS_NAMESPACE = 'locale'
/** 该条目里承载用户选择的字段。 */
export const LOCALE_PREFERENCE_FIELD = 'preference'

/** 当前生效的 locale。 */
let currentLocale = DEFAULT_LOCALE
/** 是否已经拿到过显式偏好（拿到后不再被 Accept-Language 覆盖）。 */
let explicitPreference = false
/** locale 变化订阅者。 */
const listeners = new Set()

/**
 * 把任意标识归一化成我们支持的 locale。
 *
 * DSH 允许安装 `zh`/`en` 之外的语言包，本插件没有那些文案，因此除中文外一律按英文输出。
 *
 * @param value - 语言标识，例如 `zh`、`zh-CN`、`en-US`、`ja`。
 * @returns `zh` 或 `en`。
 */
export function normalizeLocale(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return text.startsWith('zh') ? 'zh' : 'en'
}

/**
 * 读取当前 locale。
 * @returns `zh` 或 `en`。
 */
export function getLocale() {
  return currentLocale
}

/**
 * 是否已经拿到显式偏好。
 * @returns 是否有显式偏好。
 */
export function hasExplicitPreference() {
  return explicitPreference
}

/**
 * 设置 locale；只有值真的变化时才通知订阅者。
 * @param value - 语言标识。
 * @returns 生效后的 locale。
 */
export function setLocale(value) {
  const next = value === 'zh' || value === 'en' ? value : normalizeLocale(value)
  if (next === currentLocale) return currentLocale
  currentLocale = next
  for (const listener of [...listeners]) {
    try {
      listener(currentLocale)
    } catch {
      // 订阅者是命令重注册之类的副作用；它失败不该影响文案解析。
    }
  }
  return currentLocale
}

/**
 * 采用 DSH 设置里的显式偏好。
 * @param preference - `locale.preference` 的值；`undefined` 表示用户没有显式选择。
 * @returns 是否记录到了偏好。
 */
export function applyPreference(preference) {
  if (typeof preference !== 'string' || preference.trim().length === 0) return false
  explicitPreference = true
  setLocale(preference)
  return true
}

/**
 * 从 `Accept-Language` 头解析出第一个受支持的语言。
 *
 * 只在没有显式偏好时作为兜底使用：它反映的是浏览器的语言，而 DSH 在没有用户选择时
 * 正是按浏览器语言派生的，所以两者通常一致。
 *
 * @param header - 请求头值，可能是字符串或数组。
 * @returns `zh`、`en`，或 `undefined`（头里没有可用语言）。
 */
export function localeFromHeader(header) {
  const raw = Array.isArray(header) ? header.join(',') : String(header ?? '')
  const entries = raw
    .split(',')
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(';')
      const qParam = params.map((param) => param.trim()).find((param) => param.startsWith('q='))
      const quality = qParam === undefined ? 1 : Number.parseFloat(qParam.slice(2))
      return { tag: tag.trim(), index, quality: Number.isFinite(quality) ? quality : 1 }
    })
    .filter((entry) => entry.tag.length > 0 && entry.quality > 0)
  entries.sort((a, b) => (b.quality - a.quality) || (a.index - b.index))
  for (const entry of entries) {
    const lower = entry.tag.toLowerCase()
    if (lower.startsWith('zh')) return 'zh'
    if (lower.startsWith('en')) return 'en'
  }
  return undefined
}

/**
 * 记录一次请求使用的语言；已有显式偏好时忽略。
 * @param header - `Accept-Language` 头。
 * @returns 生效后的 locale。
 */
export function learnLocaleFromHeader(header) {
  if (explicitPreference) return currentLocale
  const parsed = localeFromHeader(header)
  if (parsed !== undefined) setLocale(parsed)
  return currentLocale
}

/**
 * 订阅 locale 变化。
 * @param listener - 变化回调，参数为新 locale。
 * @returns 取消订阅函数。
 */
export function onLocaleChange(listener) {
  if (typeof listener !== 'function') return () => {}
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * 从设置服务的描述里读出一条配置条目的当前值。
 * @param settings - Host 的 settings 服务。
 * @param namespace - Loader 行 id。
 * @returns 该条目的 value；读不到时为 `undefined`。
 */
export function readSettingsValue(settings, namespace = LOCALE_SETTINGS_NAMESPACE) {
  if (settings === undefined || settings === null || typeof settings.describe !== 'function') return undefined
  const rows = settings.describe()
  const entry = Array.isArray(rows) ? rows.find((row) => String(row?.ns) === namespace) : undefined
  return entry?.value
}

/**
 * 读取 DSH 当前的界面语言偏好。
 * @param settings - Host 的 settings 服务。
 * @returns `locale.preference` 的值，未设置时为 `undefined`。
 */
export function readLocalePreference(settings) {
  const value = readSettingsValue(settings, LOCALE_SETTINGS_NAMESPACE)
  const preference = value?.[LOCALE_PREFERENCE_FIELD]
  return typeof preference === 'string' && preference.length > 0 ? preference : undefined
}

/**
 * 取一条文本。
 * @param key - 字典键。
 * @param vars - 需要替换的 `{name}` 占位符。
 * @param locale - 强制使用的 locale；省略则用当前值。
 * @returns 该 locale 下的文本，缺失时回退中文，再回退键名。
 */
export function t(key, vars = {}, locale = currentLocale) {
  const entry = VM_MESSAGES[key]
  if (entry === undefined) return key
  const template = entry[locale] ?? entry.zh ?? key
  return template.replace(/\{(\w+)\}/g, (match, name) => (vars[name] === undefined ? match : String(vars[name])))
}

/**
 * 该键是否有任何文案（测试与静态检查用）。
 * @param key - 字典键。
 * @returns 是否存在。
 */
export function hasMessage(key) {
  return Object.prototype.hasOwnProperty.call(VM_MESSAGES, key)
}

/**
 * 列出所有字典键（测试用）。
 * @returns 键名数组。
 */
export function messageKeys() {
  return Object.keys(VM_MESSAGES)
}

/**
 * 测试专用：把进程内状态恢复到「没有收到任何信号」。
 */
export function resetLocaleForTests() {
  currentLocale = DEFAULT_LOCALE
  explicitPreference = false
  listeners.clear()
}
