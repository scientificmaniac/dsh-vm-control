/**
 * VMX 配置文件的读、解析与就地改写。
 *
 * VMX 是 VMware 的纯文本配置：每行 `key = "value"`，`#` 开头是注释。它同时是
 * 「这台虚拟机是什么」的唯一权威来源——`vmrun` 只管开关机与快照，CPU、内存、网卡、
 * 磁盘都写在 VMX 里。因此本模块承担三件事：
 *
 * 1. 把 VMX 解析成对象，供列表、状态卡片与工具输出使用；
 * 2. 从键名里归纳出 vCPU / 内存 / 网卡 / 磁盘这些结构化事实（键名随 VMware 版本变化，
 *    只能按前缀归并，不能写死一份键表）；
 * 3. 就地改写指定键并保留其余行——手工整理过的 VMX（注释、顺序、空行）不该被插件
 *    重排成另一副样子。
 *
 * **只在关机时改写**：VMware 自己在虚拟机运行时也会写 VMX，两边同时写会互相覆盖。
 * 这个约束由调用方（`lib/inventory.js` / `index.js`）在调用 `writeVmx` 前检查。
 *
 * @module dsh-vm-control/vmx
 */

import { readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** `key = "value"` 行；键允许点、冒号、数字与方括号（如 `ethernet0.pciSlotNumber`）。 */
const ENTRY_RE = /^\s*([A-Za-z0-9_.:[\]()@-]+)\s*=\s*(.*)$/

/** 解析缓存：小写路径 → `{ mtimeMs, size, parsed }`。VMX 很小，但列表会反复读同一批文件。 */
const CACHE = new Map()

/**
 * 去掉值两侧的引号并还原转义。
 * @param raw - 等号右侧的原始文本。
 * @returns 解析后的值。
 */
function unquote(raw) {
  const text = String(raw ?? '').trim()
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    // VMware 只转义引号与反斜杠；其余反斜杠是路径分隔符，必须原样保留。
    return text.slice(1, -1).replace(/\\(["\\])/g, '$1')
  }
  return text
}

/**
 * 把一个值写成 VMX 的形态：引号包裹，内部引号与反斜杠转义。
 * @param value - 任意值。
 * @returns 带引号的字符串。
 */
export function quote(value) {
  return `"${String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * 解析 VMX 文本。
 *
 * 重复键保留最后一个值（VMware 自己的语义也是最靠后的生效），但 `order` 只记录首次出现，
 * 这样改写时不会把后面那行漏掉。
 *
 * @param text - VMX 文件内容。
 * @returns `{ entries, lines }`：`entries` 是键值对象，`lines` 是原始行数组（改写时复用）。
 */
export function parseVmx(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const entries = Object.create(null)
  for (const line of lines) {
    if (line.length === 0) continue
    const trimmed = line.trimStart()
    if (trimmed.startsWith('#') || trimmed.startsWith('!')) continue
    const match = ENTRY_RE.exec(line)
    if (match === null) continue
    entries[match[1]] = unquote(match[2])
  }
  return { entries, lines }
}

/**
 * 把一台虚拟机的 VMX 键值归纳成结构化信息。
 *
 * 所有字段都是「能读到就给，读不到就省略」，因为不同 VMware 版本的键名并不一致：
 * 例如内存永远是 `memsize`，但网卡描述在 17.x 里多出 `displayName` 与 `linkState`。
 *
 * @param entries - `parseVmx` 得到的键值对象。
 * @param options - 名称与路径兜底。
 * @returns 结构化信息。
 */
export function infoFromEntries(entries, { name, vmxPath } = {}) {
  const pick = (key, fallback) => (entries[key] === undefined || entries[key] === '' ? fallback : entries[key])
  const num = (key, fallback) => {
    const value = Number.parseInt(entries[key] ?? '', 10)
    return Number.isFinite(value) ? value : fallback
  }

  const displayName = pick('displayName', name ?? (vmxPath === undefined ? '' : path.basename(vmxPath, path.extname(vmxPath))))
  const guestOS = pick('guestOS', '')
  const cpus = num('numvcpus', 1)
  // 单颗多核与多颗单核在 VMX 里是不同的写法；coresPerSocket 缺省按「每个插槽 1 核」。
  const coresPerSocket = num('cpuid.coresPerSocket', 1)
  const memoryMB = num('memsize', 0)
  const encrypted = Object.keys(entries).some((key) => key.startsWith('encryption.'))

  /** 网卡：按 ethernetN 归并，出现在任何一个 ethernetN.* 键里即视为存在。 */
  const nicIndexes = new Set()
  for (const key of Object.keys(entries)) {
    const match = /^ethernet(\d+)\./.exec(key)
    if (match !== null) nicIndexes.add(Number(match[1]))
  }
  const nics = [...nicIndexes].sort((a, b) => a - b).map((index) => {
    const prefix = `ethernet${index}.`
    const connectionType = entries[`${prefix}connectionType`] ?? 'bridged'
    return {
      index,
      present: String(entries[`${prefix}present`] ?? 'TRUE').toUpperCase() !== 'FALSE',
      connectionType,
      // 虚拟网络名的键名跟着版本走：17.x 写 `vnet`（如 `VMnet8`），更早的写 `networkName`，
      // 而 `displayName` 是给人看的字符串（可能形如 `VMnet8 (NAT`，括号都不配对），只能垫底。
      networkName: entries[`${prefix}networkName`] ?? entries[`${prefix}vnet`] ?? entries[`${prefix}displayName`] ?? '',
      virtualDev: entries[`${prefix}virtualDev`] ?? '',
      addressType: entries[`${prefix}addressType`] ?? '',
      mac: entries[`${prefix}address`] ?? entries[`${prefix}generatedAddress`] ?? '',
      startConnected: String(entries[`${prefix}startConnected`] ?? 'TRUE').toUpperCase() !== 'FALSE',
      linkState: String(entries[`${prefix}linkState`] ?? 'up').toLowerCase() !== 'down',
    }
  })

  /** 磁盘：`scsi0:0.fileName` 这类键；只取有 fileName 的设备。 */
  const disks = []
  for (const [key, value] of Object.entries(entries)) {
    const match = /^(scsi|sata|nvme|ide)(\d+):(\d+)\.fileName$/.exec(key)
    if (match === null || value === '') continue
    const [, bus, controller, unit] = match
    // 同一个 `busN:M.fileName` 既可能是硬盘也可能是光驱：VMware 把 ISO 挂载和物理光驱
    // 都写在这里。混成「磁盘」会让详情里出现一行 `ide0:0 → auto detect` 而没有任何解释。
    const deviceType = String(entries[`${bus}${controller}:${unit}.deviceType`] ?? '').toLowerCase()
    const lowerFile = value.toLowerCase()
    const kind = deviceType.includes('cdrom') || /\.iso$/.test(lowerFile) || lowerFile === 'auto detect' || lowerFile === 'rawdevice'
      ? 'cdrom'
      : 'disk'
    disks.push({
      device: `${bus}${controller}:${unit}`,
      bus,
      kind,
      fileName: value,
      present: String(entries[`${bus}${controller}:${unit}.present`] ?? 'TRUE').toUpperCase() !== 'FALSE',
    })
  }
  disks.sort((a, b) => a.device.localeCompare(b.device))

  return {
    displayName,
    guestOS,
    guestFamily: guestFamilyOf(guestOS),
    cpus,
    coresPerSocket,
    sockets: coresPerSocket > 0 ? Math.max(1, Math.round(cpus / coresPerSocket)) : 1,
    memoryMB,
    firmware: pick('firmware', 'bios'),
    hwVersion: pick('virtualHW.version', ''),
    toolsSyncTime: String(entries['tools.syncTime'] ?? '').toUpperCase() === 'TRUE',
    annotation: entries.annotation ?? '',
    uuid: entries['uuid.bios'] ?? entries['uuid.location'] ?? '',
    encrypted,
    nics,
    disks,
  }
}

/** guestOS 前缀 → 大类。用于界面徽章与「这台是不是 Windows」这类判断。 */
const GUEST_FAMILIES = [
  [/^win|^windows/i, 'windows'],
  [/^darwin|^macos/i, 'macos'],
  [/^ubuntu|^debian|^centos|^rhel|^fedora|^sles|^opensuse|^otherlinux|^other[0-9]*linux|^linux|^kali|^arch|^photon|^oracle/i, 'linux'],
  [/^freebsd|^openbsd|^netbsd|^solaris|^other$/i, 'bsd'],
]

/**
 * 把 `guestOS` 归成大类。
 * @param guestOS - VMX 里的 `guestOS` 值，如 `debian13-64`、`windows9-64`。
 * @returns `windows` / `linux` / `macos` / `bsd` / `other`。
 */
export function guestFamilyOf(guestOS) {
  const text = String(guestOS ?? '')
  if (text.length === 0) return 'other'
  for (const [pattern, family] of GUEST_FAMILIES) {
    if (pattern.test(text)) return family
  }
  return 'other'
}

/**
 * 就地改写 VMX 文本里的若干键。
 *
 * 已存在的键替换其值、保留缩进与引号风格；不存在的键追加到文件末尾。注释与空行原样保留。
 *
 * @param text - 原 VMX 内容。
 * @param updates - 键 → 新值；值会被 `quote` 包成字符串。
 * @returns `{ text, changed }`：改写后的文本与被实际改动的键（含新增）。
 */
export function writeVmxText(text, updates) {
  const lines = String(text ?? '').split(/\r?\n/)
  const changed = []
  const pending = new Map(Object.entries(updates ?? {}))
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const match = ENTRY_RE.exec(line)
    if (match === null) continue
    const key = match[1]
    if (!pending.has(key)) continue
    const next = quote(pending.get(key))
    const indent = line.slice(0, line.length - line.trimStart().length)
    lines[index] = `${indent}${key} = ${next}`
    pending.delete(key)
    changed.push(key)
  }
  if (pending.size > 0) {
    // 末尾若有空行，把新键插在最后一个非空行之后，避免追加到文件末尾造出一堆孤立空行。
    let insertAt = lines.length
    while (insertAt > 0 && lines[insertAt - 1].trim().length === 0) insertAt -= 1
    const additions = [...pending.entries()].map(([key, value]) => `${key} = ${quote(value)}`)
    lines.splice(insertAt, 0, ...additions)
    changed.push(...pending.keys())
  }
  return { text: lines.join('\n'), changed }
}

/**
 * 读取并解析一个 VMX，按 mtime + 大小做缓存。
 *
 * @param vmxPath - VMX 绝对路径。
 * @returns `{ path, mtimeMs, entries, info, text }`。
 * @throws 文件不存在或不可读时抛出原始错误（调用方按「文件缺失」处理）。
 */
export async function readVmx(vmxPath) {
  const key = vmxPath.toLowerCase()
  const info = await stat(vmxPath)
  const cached = CACHE.get(key)
  if (cached !== undefined && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.value
  const text = await readFile(vmxPath, 'utf8')
  const { entries } = parseVmx(text)
  const value = {
    path: vmxPath,
    mtimeMs: info.mtimeMs,
    size: info.size,
    text,
    entries,
    info: infoFromEntries(entries, { vmxPath }),
  }
  CACHE.set(key, { mtimeMs: info.mtimeMs, size: info.size, value })
  return value
}

/**
 * 把一组改动写回 VMX 文件，并在写之前留一份 `.vmx.bak`。
 *
 * 备份不是礼貌，而是必要的：VMX 里有 uuid、MAC 地址、设备槽位，手滑写错一个键就可能让
 * 虚拟机「看起来在但起不来」。备份保留上一次的完整内容，出问题时可以整份还原。
 *
 * @param vmxPath - VMX 绝对路径。
 * @param updates - 键 → 新值。
 * @returns `{ changed, backupPath }`。
 */
export async function writeVmx(vmxPath, updates) {
  const text = await readFile(vmxPath, 'utf8')
  const { text: next, changed } = writeVmxText(text, updates)
  if (changed.length === 0) return { changed, backupPath: undefined }
  const backupPath = `${vmxPath}.dsh-vm-control.bak`
  await writeFile(backupPath, text, 'utf8')
  await writeFile(vmxPath, next, 'utf8')
  // 让下一次 readVmx 一定重新解析：mtime 在同一秒内的两次写盘可能被文件系统视作未变。
  CACHE.delete(vmxPath.toLowerCase())
  return { changed, backupPath }
}

/**
 * 清空解析缓存（测试用，或文件被外部改动后强制刷新）。
 * @param vmxPath - 可选：只清这一条。
 */
export function clearVmxCache(vmxPath) {
  if (typeof vmxPath === 'string') CACHE.delete(vmxPath.toLowerCase())
  else CACHE.clear()
}
