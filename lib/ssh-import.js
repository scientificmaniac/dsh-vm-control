/**
 * 与 `dsh-ssh-vault` 的联动：把一台虚拟机的 SSH 接入信息整理成**它家愿意接收的形状**。
 *
 * 为什么是「整理」而不是「写入」：保险库的密文由 ssh-vault 自己保管，密钥材料从不离开
 * 它的进程，别的插件没有任何正当途径去写那个文件。所以这里只负责两件事——
 *
 * 1. 从虚拟机侧能确定的事实里拼出建议值（别名、地址、账号、认证方式、备注、标签）；
 * 2. 把「保存请求」的字段契约固定在 `SSH_VAULT_SAVE_FIELDS` 里，由界面按它提交。
 *
 * 真正的写入走 ssh-vault 自己的设置接口（`POST ssh-vault/save`，同源、带会话）。这条
 * 路径的好处是校验、加密、覆盖语义都由它一家说了算，我们不会造出第二条写入通道；
 * 代价是它没装时这条路直接不存在——所以界面必须有降级形态，见 `renderSshPlan`。
 *
 * 数据范围是刻意收窄的：只传 host / port / username / 认证凭据（口令或私钥路径）与
 * 说明性字段。`sudoPassword`、`bindAddress`、私钥文件上传、别名改名都不在范围内——
 * 那些要么与虚拟机无关，要么需要用户在自己的保险库页面里决定。
 *
 * @module dsh-vm-control/ssh-import
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { t } from './i18n.js'

/**
 * ssh-vault `POST ssh-vault/save` 接受的字段。
 *
 * 界面提交时只允许出现这些键（多出来的会被对方忽略，但少一个就少一条信息）。改这里的
 * 同时必须改界面里 `saveSshHost` 的组装逻辑，测试会盯住两边是否一致。
 */
export const SSH_VAULT_SAVE_FIELDS = Object.freeze([
  'alias',
  'host',
  'port',
  'username',
  'shell',
  'description',
  'tags',
  'authType',
  'password',
  'privateKeyPath',
  'passphrase',
])

/** 建议私钥的候选顺序：现代优先。 */
const KEY_CANDIDATES = ['id_ed25519', 'id_ecdsa', 'id_rsa']

/**
 * 找一把「大概会被用上」的默认私钥。
 *
 * 只作为建议：用户可以在界面里改掉。存在就填，是为了让「本来就用密钥登录」的人真的
 * 做到一次点击；不存在就不编。
 *
 * @param options - `sshDir` 可覆盖默认位置（测试用）。
 * @returns 私钥路径；没有时返回空串。
 */
export function detectDefaultKey({ sshDir = path.join(homedir(), '.ssh') } = {}) {
  for (const name of KEY_CANDIDATES) {
    const candidate = path.join(sshDir, name)
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      // 目录不可读：当作没有默认密钥，交给用户在界面上填。
    }
  }
  return ''
}

/**
 * 把虚拟机名压成一个 ssh-vault 能接受的别名。
 *
 * 规则来自对方：`^[A-Za-z0-9._-]+$`。中文名按「降到 ASCII」处理——非 ASCII 字符变分隔符，
 * 于是「软件安全kali Linux」得到 `kali-linux`，而不是一串下划线。压不出两个字符以上时
 * 用 `vm-<vmx 路径的短哈希>` 兜底，保证同名虚拟机也能得到一个稳定、可复现的别名。
 *
 * @param name - 虚拟机名。
 * @param vmxPath - vmx 路径（用于兜底哈希）。
 * @param options - `maxLength` 上限。
 * @returns 合法别名（小写）。
 */
export function suggestAlias(name, vmxPath, { maxLength = 40 } = {}) {
  const text = String(name ?? '')
  const ascii = text
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]+/g, '-')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '')
    .slice(0, maxLength)
    .replace(/[-_.]+$/g, '')
  if (ascii.length >= 2) return ascii
  return `vm-${shortHash(String(vmxPath ?? ''))}`
}

/**
 * FNV-1a → base36，截 6 位。
 *
 * 只用来给「名字压不出合法别名」的虚拟机一个稳定后缀，不承担任何安全职责。
 *
 * @param value - 输入字符串。
 * @returns 短哈希。
 */
function shortHash(value) {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36).padStart(6, '0').slice(0, 6)
}

/**
 * 在已占用的别名里找一个可用的：`base`、`base-2`、`base-3`…
 *
 * 只处理「我们看得见的冲突」（同一批虚拟机里两个名字压出了同一个别名，比如
 * 「Kali Linux」和「软件安全kali Linux」）。保险库里已有的同名主机看不到，那一步由
 * 界面提示「保存会覆盖」并给出改名按钮。
 *
 * @param base - 建议别名。
 * @param taken - 已占用的别名集合（大小写不敏感）。
 * @returns 可用别名。
 */
export function uniqueAlias(base, taken) {
  const used = new Set([...taken].map((alias) => String(alias).toLowerCase()))
  if (!used.has(base.toLowerCase())) return base
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base}-${index}`
    if (!used.has(candidate.toLowerCase())) return candidate
  }
  return `${base}-${Date.now().toString(36).slice(-4)}`
}

/**
 * 结合「同一批虚拟机」给出不撞车的别名。
 *
 * 名字压成别名的过程会丢信息：「Kali Linux」和「软件安全kali Linux」都会变成
 * `kali-linux`。给两台机器同一个建议别名是没意义的，所以这里先按库存排一遍再定。
 *
 * @param entry - 目标虚拟机视图。
 * @param entries - 同批虚拟机视图数组。
 * @returns 可用别名。
 */
export function aliasFor(entry, entries) {
  const list = Array.isArray(entries) ? entries : []
  // 按 vmx 路径的**码点顺序**排序后依次分配：谁先拿到基础别名必须是可复现的。
  // 用码点而不是 localeCompare，是因为后者随系统语言变化——同一批机器在中文 Windows 与
  // Linux CI 上会得到不同的别名，那会让「导入」变成一件不可预测的事。
  const keyOf = (item) => String(item.vmx).toLowerCase()
  const sorted = [...list].sort((left, right) => {
    const a = keyOf(left)
    const b = keyOf(right)
    if (a === b) return 0
    return a < b ? -1 : 1
  })
  const used = new Set()
  for (const item of sorted) {
    const alias = uniqueAlias(suggestAlias(item.name, item.vmx), used)
    used.add(alias.toLowerCase())
    if (String(item.vmx).toLowerCase() === String(entry.vmx).toLowerCase()) return alias
  }
  // 目标不在这一批里（例如刚被扫描移出）：退回基础别名，仍然避免和已知的重名。
  return uniqueAlias(suggestAlias(entry.name, entry.vmx), used)
}

/**
 * 猜测登录账号。
 *
 * Linux / BSD 客户机的默认运维账号通常是 root，Windows 客户机默认没有 SSH 服务。
 * 这只是一个建议值，界面里永远可改，且提示语会说明它是猜的。
 *
 * @param guestFamily - vmx 里判断出的客户机族。
 * @returns 建议账号；没有合理猜测时为空串。
 */
export function suggestUsername(guestFamily) {
  if (guestFamily === 'linux' || guestFamily === 'bsd') return 'root'
  return ''
}

/**
 * 组装一份导入建议。
 *
 * @param entry - 虚拟机视图（来自 `Inventory.detail`）。
 * @param options - 覆盖项。
 * @param options.host - 已确定的地址（优先于 guest）。
 * @param options.guest - `{ attempted, ok, ip, tools }`，VMware Tools 的查询结果。
 * @param options.defaultKeyPath - 私钥建议路径；传 `null` 表示不做探测。
 * @param options.alias - 覆盖别名建议。
 * @param options.importAllowed - 插件配置是否允许导入。
 * @returns 计划对象（可直接序列化给浏览器）。
 */
export function buildSshPlan(entry, { host = '', guest, defaultKeyPath, alias, importAllowed = true } = {}) {
  const resolvedKey = defaultKeyPath === undefined ? detectDefaultKey() : (defaultKeyPath ?? '')
  const resolvedAlias = typeof alias === 'string' && alias.trim().length > 0
    ? alias.trim()
    : suggestAlias(entry.name, entry.vmx)
  const resolvedHost = typeof host === 'string' && host.trim().length > 0 ? host.trim() : ''
  const username = suggestUsername(entry.guestFamily)
  const port = 22
  const authType = resolvedKey.length > 0 ? 'key' : 'password'
  const tags = []
  for (const tag of ['vmware', ...(Array.isArray(entry.tags) ? entry.tags : [])]) {
    if (typeof tag === 'string' && tag.length > 0 && !tags.includes(tag)) tags.push(tag)
  }

  const warnings = []
  if (resolvedHost.length === 0) warnings.push('no-host')
  if (username.length === 0) warnings.push('no-username')
  if (authType === 'password') warnings.push('need-password')

  return {
    vmx: entry.vmx,
    name: entry.name,
    guestFamily: entry.guestFamily,
    alias: resolvedAlias,
    host: resolvedHost,
    port,
    username,
    shell: 'bash',
    authType,
    privateKeyPath: resolvedKey,
    description: `${entry.name} · VMware`,
    tags,
    sshCommand: resolvedHost.length > 0
      ? (port === 22 ? `ssh ${username.length > 0 ? `${username}@` : ''}${resolvedHost}` : `ssh -p ${port} ${username.length > 0 ? `${username}@` : ''}${resolvedHost}`)
      : '',
    guest: guest ?? { attempted: false },
    warnings,
    importAllowed,
  }
}

/**
 * 把计划渲染成模型可读的文本。
 *
 * 结尾那句「在设置页点一下」不是客套：模型没有写保险库的通道，把它说清楚才不会让调用方
 * 反复尝试一个它做不到的动作。
 *
 * @param plan - `buildSshPlan` 的结果。
 * @returns 文本。
 */
export function renderSshPlan(plan) {
  const lines = [t('ssh.planHeader', { name: plan.name, alias: plan.alias })]
  if (plan.host.length > 0) {
    const source = plan.guest?.attempted === true && plan.guest.ok === true ? t('ssh.planHostFromTools') : ''
    lines.push(t('ssh.planHost', { host: plan.host, source }))
  } else {
    lines.push(t('ssh.planHostMissing'))
  }
  lines.push(t('ssh.planAccount', { port: plan.port, user: plan.username.length > 0 ? plan.username : t('ssh.planAccountUnknown') }))
  lines.push(plan.authType === 'key'
    ? t('ssh.planAuthKey', { path: plan.privateKeyPath })
    : t('ssh.planAuthPassword'))
  lines.push(t('ssh.planTags', { tags: plan.tags.join(', ') }))
  if (plan.sshCommand.length > 0) lines.push(t('ssh.planCommand', { command: plan.sshCommand }))
  for (const warning of plan.warnings) {
    if (warning === 'no-host') lines.push(t('ssh.planWarnHost'))
    if (warning === 'no-username') lines.push(t('ssh.planWarnUser'))
    if (warning === 'need-password') lines.push(t('ssh.planWarnPassword'))
  }
  lines.push(plan.importAllowed === false ? t('ssh.planImportForbidden') : t('ssh.planHowTo'))
  return lines.join('\n')
}
