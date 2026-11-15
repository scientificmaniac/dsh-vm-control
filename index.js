/**
 * VMware 虚拟机插件 —— 让智能体与用户一起管理本机的 VMware 虚拟机。
 *
 * 暴露四个模型面向的工具：
 * - `vm_list`     列出虚拟机：运行状态、规格、实时占用、网络与路径
 * - `vm_power`    启动 / 关机 / 挂起 / 暂停 / 恢复 / 重置，并在之后确认状态真的变了
 * - `vm_snapshot` 列出 / 创建 / 回滚 / 删除快照
 * - `vm_config`   查看与改写 VMX 参数，登记 / 取消登记 / 删除虚拟机
 *
 * 另有两条面向人的通道：设置页（`client.js` + `lib/vm-api.js`）与对话里的 `/vm` 命令。
 *
 * 权限是显式配置项而不是隐含约定：`permissions.power/snapshot/config/delete` 四个开关，
 * 默认只关掉最危险的那个（delete）。被关掉的能力在工具层与设置接口层各拒绝一次——
 * 只拦一层的话，另一条通道会变成绕过它的后门。
 *
 * @module dsh-vm-control
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { Diagnostics } from './lib/diagnostics.js'
import {
  LOCALE_SETTINGS_NAMESPACE,
  applyPreference,
  onLocaleChange,
  readLocalePreference,
  t,
} from './lib/i18n.js'
import { Inventory } from './lib/inventory.js'
import {
  entrySummary,
  isPowerAction,
  renderConfigOutcome,
  renderDetail,
  renderList,
  renderPowerOutcome,
  renderRemoveOutcome,
  renderSnapshots,
  stateLabel,
} from './lib/format.js'
import { assertSupportedPlatform } from './lib/platform.js'
import { aliasFor, buildSshPlan, renderSshPlan } from './lib/ssh-import.js'
import { Store } from './lib/store.js'
import { API_PREFIX, createVmApi } from './lib/vm-api.js'
import { Vmrun } from './lib/vmrun.js'

/** 插件名（同时是 Loader 行的 id）。 */
export const name = 'vm-control'
/** 依赖的 Host 服务：没有工具注册表就无法工作。 */
export const inject = ['tools']

/**
 * 权限默认值。
 *
 * `delete` 默认关闭不是保守，而是因为它的三个模式里有一个不可撤销：`purge` 会连磁盘
 * 一起删掉。默认打开它等于把「误删一台刚装好的虚拟机」变成一次普通的工具调用。
 */
const DEFAULT_PERMISSIONS = Object.freeze({
  power: true,
  snapshot: true,
  config: true,
  delete: false,
})

/** 配置允许的权限键。 */
const PERMISSION_SCOPES = Object.freeze(['power', 'snapshot', 'config', 'delete'])

/**
 * 默认数据目录：与 DSH 其它私有数据同处一地。
 * @returns 绝对路径。
 */
export function defaultDataDir() {
  const home = process.env.DSH_HOME ?? path.join(homedir(), '.dsh')
  return path.join(home, 'vm-control')
}

/**
 * 首次运行时使用的搜索目录。
 *
 * 只给 VMware 自己会用的默认位置——插件没有能力猜出「你把虚拟机放在 E 盘」，
 * 猜错的结果是首次打开设置页一台虚拟机也看不到，所以宁可给一个真实存在可能很高的
 * 位置，并把「添加搜索目录」放在界面最显眼的地方。
 *
 * @param platform - `process.platform`。
 * @returns 绝对路径数组。
 */
export function defaultSearchRoots(platform = process.platform) {
  const home = homedir()
  if (platform === 'win32') return [path.join(home, 'Documents', 'Virtual Machines')]
  if (platform === 'darwin') return [path.join(home, 'Virtual Machines'), path.join(home, 'Documents', 'Virtual Machines')]
  return [path.join(home, 'vmware'), path.join(home, 'Virtual Machines')]
}

/**
 * 把字符串结果包装成最小可用的工具定义。
 * @param options - 工具名、描述、参数与执行函数。
 * @returns 可直接注册的工具定义。
 */
function textTool({ name: toolName, description, parameters, execute }) {
  return {
    name: toolName,
    description,
    parameters,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : String(value) }],
    },
    execute,
  }
}

/**
 * 把配置里的权限合并进默认值。
 * @param raw - Loader 行里的 `permissions`。
 * @returns 完整的权限对象。
 */
function normalizePermissions(raw) {
  const result = { ...DEFAULT_PERMISSIONS }
  if (raw === null || typeof raw !== 'object') return result
  for (const scope of PERMISSION_SCOPES) {
    if (typeof raw[scope] === 'boolean') result[scope] = raw[scope]
  }
  return result
}

/**
 * 插件入口。
 * @param ctx - 插件上下文。
 * @param config - Loader 行中的配置。
 */
export function apply(ctx, config = {}) {
  assertSupportedPlatform()

  const dataDir = typeof config.dataDir === 'string' && config.dataDir.length > 0 ? config.dataDir : defaultDataDir()
  const permissions = normalizePermissions(config.permissions)
  const collectMetrics = config.collectMetrics !== false
  const scanDepth = Number.isFinite(config.scanDepth) ? config.scanDepth : undefined
  const defaultTimeoutMs = Number.isFinite(config.timeoutMs) ? config.timeoutMs : undefined

  // —— 可开关的诊断日志 ——
  //
  // 默认关闭，关着的时候不写内存也不碰磁盘。打开之后工具与设置接口的失败会带堆栈落盘。
  // 配置形态两种都认：`logging: true` 与 `logging: { enabled, dir, maxBytes }`。
  const loggingConfig = typeof config.logging === 'object' && config.logging !== null ? config.logging : {}
  const diagnostics = new Diagnostics({
    dir: typeof loggingConfig.dir === 'string' && loggingConfig.dir.length > 0 ? loggingConfig.dir : path.join(dataDir, 'logs'),
    enabled: typeof config.logging === 'boolean' ? config.logging : loggingConfig.enabled === true,
    mirror: ctx.logger,
    maxBytes: Number.isFinite(loggingConfig.maxBytes) ? loggingConfig.maxBytes : undefined,
  })

  const store = new Store({
    dir: dataDir,
    roots: Array.isArray(config.searchRoots) && config.searchRoots.length > 0
      ? config.searchRoots.filter((root) => typeof root === 'string' && root.length > 0)
      : defaultSearchRoots(),
    logger: diagnostics.logger,
  })

  const vmrun = new Vmrun({
    configuredPath: typeof config.vmrunPath === 'string' && config.vmrunPath.length > 0 ? config.vmrunPath : undefined,
    hostType: typeof config.vmType === 'string' ? config.vmType : 'auto',
    timeoutMs: Number.isFinite(config.vmrunTimeoutMs) ? config.vmrunTimeoutMs : 90000,
    logger: diagnostics.logger,
  })

  const inventory = new Inventory({
    store,
    vmrun,
    trashDir: path.join(dataDir, 'trash'),
    scanDepth,
    metrics: collectMetrics,
    logger: diagnostics.logger,
  })

  /**
   * 权限闸门：没开就直接抛错，错误消息说明这是插件配置而不是 VMware 的拒绝。
   * @param scope - `power` / `snapshot` / `config` / `delete`。
   */
  const requirePermission = (scope) => {
    if (permissions[scope] === true) return
    throw new Error(t('vm.permissionDenied', { scope }))
  }

  /**
   * 把工具的 `execute` 包一层：失败写诊断日志，然后原样抛出。
   * @param toolName - 工具名。
   * @param execute - 原执行函数。
   * @returns 包好的执行函数。
   */
  const traceTool = (toolName, execute) => async (args, exec) => {
    try {
      return await execute(args, exec)
    } catch (error) {
      diagnostics.error(`tool:${toolName}`, error, { vm: args?.vm, action: args?.action })
      throw error
    }
  }

  /**
   * 注册工具：在 `textTool` 之上补上失败日志。
   * @param spec - 工具定义。
   * @returns 可直接交给 `ctx.tools.register` 的定义。
   */
  const registerTool = (spec) => textTool({ ...spec, execute: traceTool(spec.name, spec.execute) })

  /**
   * 解析一次性加密口令：只经由 DSH 凭据服务，插件不保存明文。
   *
   * 只有 vmrun 明确报「这台虚拟机是加密的」时才会被调用，因此绝大多数调用既不会读凭据，
   * 也不会让口令出现在任何命令行上。
   *
   * @param record - 插件记录（可能带 credentialRef）。
   * @returns 口令；没有配置时返回 undefined。
   */
  const resolveVmPassword = async (record) => {
    const ref = typeof record?.credentialRef === 'string' ? record.credentialRef.trim() : ''
    if (ref.length === 0) return undefined
    const credentials = ctx.get('credentials')
    if (credentials === undefined) throw new Error(t('err.credentialsAbsent', { ref }))
    const resolved = await credentials.resolve(ref)
    if (resolved === undefined || typeof resolved.value !== 'string') throw new Error(t('err.credentialUnresolved', { ref }))
    return resolved.value
  }

  /**
   * 把 vmrun 失败交给统一渲染。
   * @param result - vmrun 结果。
   * @returns 文本。
   */
  const describeFailure = (result) => vmrun.describeFailure(result)

  /**
   * 统一的动作执行外壳：把 inventory 的异常翻成可读文本（而不是让工具直接报错），
   * 同时保证「找不到虚拟机」这类问题有明确提示。
   *
   * @param fn - 实际动作。
   * @returns 文本结果。
   */
  const guarded = async (fn) => {
    try {
      return await fn()
    } catch (error) {
      if (error instanceof Error) throw error
      throw new Error(String(error))
    }
  }

  ctx.effect(() => ctx.tools.register(registerTool({
    name: 'vm_list',
    description: 'List VMware virtual machines on this machine with their power state, CPU/memory specification, live host-side '
      + 'resource use (CPU %, resident memory, threads), network adapters and vmx path. '
      + 'VMs are discovered from the configured search roots, so a newly created VM shows up without registration. '
      + 'Use the returned name or vmx path with vm_power, vm_snapshot and vm_config. '
      + 'Set include_guest=true only when you also need the VMware Tools state and the guest IP address: it is much slower '
      + 'because it asks each running guest, and it fails for guests without working Tools.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        vm: {
          type: 'string',
          description: 'Only show this VM (name or vmx path). Returns the full detail view instead of the list.',
        },
        root: {
          type: 'string',
          description: 'Only show VMs whose folder is under this path. Useful when a wide search root returns too many VMs.',
        },
        include_guest: {
          type: 'boolean',
          description: 'Also query VMware Tools for the tools state and guest IP. Slow; needs running VMs with working Tools.',
        },
        include_stopped: {
          type: 'boolean',
          description: 'Include powered-off VMs. Default true; pass false to see only running, paused and suspended ones.',
        },
        show_path: {
          type: 'boolean',
          description: 'Always print the vmx path. VMs sharing a name are shown with their path regardless.',
        },
        limit: {
          type: 'integer',
          description: 'Maximum number of VMs to print. Defaults to 40.',
        },
      },
    },
    execute: async (args) => guarded(async () => {
      if (typeof args.vm === 'string' && args.vm.trim().length > 0) {
        const entry = await inventory.detail(args.vm.trim(), {
          includeSnapshots: true,
          includeGuest: args.include_guest === true,
        })
        return renderDetail(entry)
      }
      const result = await inventory.list({
        includeMetrics: collectMetrics,
        includeGuest: args.include_guest === true,
        includeStopped: args.include_stopped !== false,
      })
      const root = typeof args.root === 'string' ? args.root.trim().toLowerCase() : ''
      const entries = root.length === 0
        ? result.entries
        : result.entries.filter((entry) => entry.folder.toLowerCase().startsWith(root))
      return renderList({ ...result, entries }, {
        limit: Number.isFinite(args.limit) ? Math.max(1, args.limit) : 40,
        showPaths: args.show_path === true,
      })
    }),
  })))

  ctx.effect(() => ctx.tools.register(registerTool({
    name: 'vm_power',
    description: 'Change the power state of a VMware virtual machine: start, stop, suspend, pause, unpause, reset, or report status. '
      + 'The tool checks the current state first and refuses a nonsensical transition with an explanation instead of letting vmrun fail. '
      + 'After issuing the command it waits for the state to actually change and reports the confirmed new state, because a successful '
      + 'vmrun exit only means the command was accepted — the VM can still die a second later. '
      + 'Defaults: stop/suspend/reset are soft (ask the guest to shut down), start is headless (nogui). '
      + 'Requires permissions.power in the plugin config.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        vm: {
          type: 'string',
          description: 'VM name or vmx path. Names must be unique; when two VMs share a name use the path.',
        },
        action: {
          type: 'string',
          enum: ['start', 'stop', 'suspend', 'pause', 'unpause', 'reset', 'status'],
          description: 'start powers on (and resumes a suspended VM), stop powers off, suspend writes a suspend image, '
            + 'pause/unpause freezes and unfreezes without touching disk, reset restarts, status only reports.',
        },
        mode: {
          type: 'string',
          enum: ['soft', 'hard'],
          description: 'How hard to stop/suspend/reset. soft asks the guest (needs VMware Tools for a clean shutdown), '
            + 'hard cuts power like pulling the plug. Defaults to soft; use hard only for a frozen guest.',
        },
        gui: {
          type: 'boolean',
          description: 'Start with the VMware window (gui) instead of headless (nogui, the default). A GUI window needs an interactive '
            + 'desktop session; under a service account it may appear on another desktop or not at all.',
        },
        timeoutMs: {
          type: 'number',
          description: 'How long to wait for the state change, in milliseconds. Defaults to the per-action limit (120-180s).',
        },
      },
      required: ['vm', 'action'],
    },
    execute: async (args, exec) => guarded(async () => {
      requirePermission('power')
      const action = String(args.action ?? '').toLowerCase()
      if (!isPowerAction(action)) throw new Error(t('api.powerInvalidAction', { action }))
      const outcome = await inventory.power(args.vm, action, {
        mode: args.mode === 'hard' ? 'hard' : 'soft',
        gui: args.gui === true,
        timeoutMs: Number.isFinite(args.timeoutMs) ? args.timeoutMs : defaultTimeoutMs,
        signal: exec.signal,
        passwordFor: resolveVmPassword,
      })
      return renderPowerOutcome(outcome, { describeFailure })
    }),
  })))

  ctx.effect(() => ctx.tools.register(registerTool({
    name: 'vm_snapshot',
    description: 'Manage VMware snapshots of one virtual machine: list, create, revert or delete. '
      + 'Snapshot names must be unique within the VM. A revert discards every disk change made after that snapshot — that is the '
      + 'point of a revert, not a failure. vmrun does not store descriptions, so a description passed here is kept in the plugin '
      + 'data file and shown next to the snapshot name. Requires permissions.snapshot for create/revert/delete; listing is always allowed.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        vm: { type: 'string', description: 'VM name or vmx path.' },
        action: {
          type: 'string',
          enum: ['list', 'create', 'revert', 'delete'],
          description: 'list shows existing snapshots, create takes a new one, revert restores it, delete removes it.',
        },
        name: {
          type: 'string',
          description: 'Snapshot name. Required for create, revert and delete.',
        },
        description: {
          type: 'string',
          description: 'Optional note stored by the plugin next to the snapshot name (VMware keeps no description field).',
        },
        include_children: {
          type: 'boolean',
          description: 'On delete, also remove the snapshots that descend from this one. Without it VMware refuses to delete '
            + 'a snapshot that has children.',
        },
      },
      required: ['vm', 'action'],
    },
    execute: async (args, exec) => guarded(async () => {
      const action = String(args.action ?? 'list').toLowerCase()
      const vm = args.vm
      if (action === 'list') {
        const item = await inventory.resolve(vm)
        const listed = await inventory.snapshots(item.vmx)
        const entry = await inventory.detail(item.vmx)
        return [entrySummary(entry), renderSnapshots(entry, listed.snapshots)].join('\n')
      }
      requirePermission('snapshot')
      const name = typeof args.name === 'string' ? args.name.trim() : ''
      if (action === 'create') {
        const outcome = await inventory.createSnapshot(vm, name, { description: args.description, signal: exec.signal })
        if (outcome.ok !== true) return describeFailure(outcome.result)
        const item = await inventory.resolve(vm)
        const entry = await inventory.detail(item.vmx)
        return [
          t('vm.snapshotCreated', { name: entry.name, snapshot: name }),
          renderSnapshots(entry, outcome.snapshots),
        ].join('\n')
      }
      if (action === 'revert') {
        const outcome = await inventory.revertSnapshot(vm, name, { signal: exec.signal })
        if (outcome.reason === 'missing') {
          const item = await inventory.resolve(vm)
          const entry = await inventory.detail(item.vmx)
          return t('vm.snapshotMissing', {
            name: entry.name,
            snapshot: name,
            list: outcome.available.length > 0 ? outcome.available.join(', ') : t('vm.field.none'),
          })
        }
        if (outcome.ok !== true) return describeFailure(outcome.result)
        const item = await inventory.resolve(vm)
        const entry = await inventory.detail(item.vmx)
        return t('vm.snapshotReverted', { name: entry.name, snapshot: name })
      }
      if (action === 'delete') {
        const result = await inventory.deleteSnapshot(vm, name, {
          children: args.include_children === true,
          signal: exec.signal,
        })
        if (result.ok !== true) return describeFailure(result)
        const item = await inventory.resolve(vm)
        const entry = await inventory.detail(item.vmx)
        return t('vm.snapshotDeleted', {
          name: entry.name,
          snapshot: name,
          children: args.include_children === true ? t('vm.snapshotWithChildren') : '',
        })
      }
      throw new Error(t('api.snapshotInvalidAction', { action }))
    }),
  })))

  ctx.effect(() => ctx.tools.register(registerTool({
    name: 'vm_config',
    description: 'Inspect or change virtual machine configuration, and manage the plugin inventory. '
      + 'action=show prints the VMX-derived facts (guest OS, vCPU/socket layout, memory, firmware, hardware version, NICs, disks, '
      + 'live resource use, snapshots). action=set rewrites VMX entries — vCPUs, memory, the first NIC connection type and network, '
      + 'tools.syncTime, displayName — and requires the VM to be powered off, because VMware writes the same file while it runs; '
      + 'a backup of the previous VMX is left next to it. action=networks lists host virtual networks for custom NIC mode. '
      + 'action=ssh prepares the SSH access details of a VM (alias, host, port, user, auth) for import into the dsh-ssh-vault '
      + 'plugin; it never writes into that vault itself — the user confirms the import on the settings page, because the vault is '
      + 'encrypted with ssh-vault\'s own key. '
      + 'action=register adds a vmx that lives outside the search roots; unregister drops the entry only; delete removes the VM '
      + '(trash by default, purge with files only when permissions.delete is enabled AND confirm=true).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'show', 'set', 'networks', 'ssh', 'register', 'unregister', 'delete'],
          description: 'list is the same output as vm_list; show details one VM; set rewrites VMX parameters; networks lists host '
            + 'virtual networks; ssh proposes the SSH fields for a dsh-ssh-vault import; register/unregister manage the plugin '
            + 'inventory; delete removes a VM.',
        },
        vm: { type: 'string', description: 'VM name or vmx path. Required for show, set, ssh, unregister and delete.' },
        host: {
          type: 'string',
          description: 'On ssh: the address to use. Omit to ask VMware Tools for the guest IP (only possible while the VM runs).',
        },
        vmx: { type: 'string', description: 'Absolute path to a .vmx file. Required for register.' },
        name: { type: 'string', description: 'Display name recorded by the plugin. Defaults to the VMX displayName on register.' },
        display_name: { type: 'string', description: 'On set: write this value into the VMX displayName entry.' },
        cpus: { type: 'integer', description: 'On set: number of vCPUs (1-128). Cores per socket is clamped to fit.' },
        memoryMB: { type: 'integer', description: 'On set: memory size in MB, a multiple of 4.' },
        nic_mode: {
          type: 'string',
          enum: ['nat', 'bridged', 'hostonly', 'custom'],
          description: 'On set: connection type of the first NIC.',
        },
        nic_name: {
          type: 'string',
          description: 'On set: virtual network name for nic_mode=custom, e.g. VMnet2 (see action=networks).',
        },
        tools_sync_time: { type: 'boolean', description: 'On set: tools.syncTime — let VMware Tools keep guest time in sync.' },
        notes: { type: 'string', description: 'Free-form note stored by the plugin (not in the VMX).' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Labels stored by the plugin.' },
        credential_ref: {
          type: 'string',
          description: 'Name of a DSH credential holding the encryption password of an encrypted VM. The plugin stores only the '
            + 'reference; vmrun receives the password on its command line only when VMware reports the VM is encrypted.',
        },
        confirm: { type: 'boolean', description: 'Required for delete: confirms the irreversible intent.' },
        purge: {
          type: 'boolean',
          description: 'On delete: also delete the VM files (vmrun deleteVM). Without it the VM folder is moved into the '
            + 'plugin trash so the deletion is reversible. Needs permissions.delete.',
        },
        keep_files: {
          type: 'boolean',
          description: 'On delete: only drop the plugin entry, leave every file on disk.',
        },
      },
      required: ['action'],
    },
    execute: async (args) => guarded(async () => {
      const action = String(args.action ?? 'list').toLowerCase()
      if (action === 'list') {
        const result = await inventory.list({ includeMetrics: collectMetrics })
        return renderList(result, { limit: 40 })
      }
      if (action === 'networks') {
        const listed = await inventory.hostNetworks()
        if (listed.ok !== true) return describeFailure(listed.error)
        if (listed.networks.length === 0) return t('vm.field.none')
        return listed.networks
          .map((network) => `- ${network.name}${network.type.length > 0 ? `  ${network.type}` : ''}${network.subnet.length > 0 ? `  ${network.subnet}/${network.mask}` : ''}`)
          .join('\n')
      }
      if (action === 'show') {
        const entry = await inventory.detail(args.vm, { includeSnapshots: true })
        return renderDetail(entry)
      }
      if (action === 'ssh') {
        const entry = await inventory.detail(args.vm)
        let host = typeof args.host === 'string' ? args.host.trim() : ''
        let guest = { attempted: false }
        if (host.length === 0 && entry.state === 'running') {
          const info = await inventory.guestInfo(entry.vmx)
          guest = { attempted: true, ok: info.available === true, ip: info.ip, tools: info.tools }
          if (info.available === true) host = info.ip
        }
        // 导入本身由用户在设置页确认：保险库的密文只有 ssh-vault 自己能写，
        // 模型没有那条通道，把它说清楚比让它反复尝试一个做不到的动作要好。
        const listed = await inventory.list({ includeMetrics: false })
        return renderSshPlan(buildSshPlan(entry, {
          host,
          guest,
          alias: aliasFor(entry, listed.entries),
          importAllowed: permissions.config === true,
        }))
      }
      if (action === 'set') {
        requirePermission('config')
        const outcome = await inventory.configure(args.vm, {
          cpus: args.cpus,
          memoryMB: args.memoryMB,
          nicMode: args.nic_mode,
          nicName: args.nic_name,
          toolsSyncTime: args.tools_sync_time,
          displayName: args.display_name,
          notes: args.notes,
          tags: args.tags,
          credentialRef: args.credential_ref,
        })
        return renderConfigOutcome(outcome)
      }
      if (action === 'register') {
        requirePermission('config')
        if (typeof args.vmx !== 'string' || args.vmx.trim().length === 0) throw new Error(t('api.vmxRequired'))
        if (!path.isAbsolute(args.vmx.trim())) throw new Error(t('api.vmxNotAbsolute', { path: args.vmx }))
        const record = await inventory.register({
          vmxPath: args.vmx,
          name: args.name,
          tags: args.tags,
          notes: args.notes,
          credentialRef: args.credential_ref,
        })
        return t('vm.registered', { name: record.name, path: record.vmx })
      }
      if (action === 'unregister') {
        requirePermission('config')
        // 名字必须在移除记录**之前**取：移除之后它可能既不在库存里也扫不到。
        const item = await inventory.resolve(args.vm)
        const entry = await inventory.detail(item.vmx).catch(() => undefined)
        const name = entry?.name ?? path.basename(item.vmx, path.extname(item.vmx))
        await inventory.unregister(item.vmx)
        return entry?.missing === true ? t('vm.unregisterMissing', { name }) : t('vm.unregistered', { name })
      }
      if (action === 'delete') {
        requirePermission('delete')
        if (args.confirm !== true) throw new Error(t('vm.deleteNeedsConfirm'))
        const mode = args.keep_files === true ? 'keep' : args.purge === true ? 'purge' : 'trash'
        const outcome = await inventory.remove(args.vm, { mode })
        return renderRemoveOutcome(outcome)
      }
      throw new Error(t('api.unknownAction', { action }))
    }),
  })))

  // —— 界面语言：跟随 DSH 的「设置 → 通用 → 语言」——
  //
  // 用户的显式选择由 `@deepseek-ai/dsh-client-locale` 写进 Host 设置（`locale.preference`），
  // 所以 Host 侧也能读到。settings 服务可能比本插件晚就绪，因此首次读取重试几次；
  // 之后的切换由文档更新事件驱动。
  ctx.inject(['settings'], (settingsCtx) => {
    const sync = () => {
      try {
        const preference = readLocalePreference(settingsCtx.settings)
        if (preference !== undefined) applyPreference(preference)
      } catch {
        // settings 尚未就绪：留给下一次重试或文档更新事件。
      }
    }
    settingsCtx.effect(() => {
      const off = settingsCtx.on('settings/document-updated', (namespace) => {
        if (String(namespace) !== LOCALE_SETTINGS_NAMESPACE) return
        sync()
      })
      sync()
      const timers = [250, 1000, 3000].map((delay) => {
        const timer = setTimeout(sync, delay)
        timer.unref?.()
        return timer
      })
      return () => {
        off()
        for (const timer of timers) clearTimeout(timer)
      }
    }, 'vm-control: locale preference')
  })

  // —— 设置界面的管理接口 ——
  //
  // 这条路由能开关机、改 VMX、删文件，所以必须和宿主 /api 一样过 Connection 的信任栅栏：
  // Host/Origin 校验 + 浏览器登录认证。connection 服务缺失时（非 Web 组合）退回放行，
  // 由宿主自身的鉴权层兜底。
  ctx.inject(['webServer'], (webCtx) => {
    const api = createVmApi({
      inventory,
      store,
      permissions,
      dataDir,
      diagnostics,
      logger: diagnostics.logger,
      pluginVersion: async () => {
        try {
          return JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8')).version ?? 'unknown'
        } catch {
          return 'unknown'
        }
      },
      requestRejection: (req) => ctx.get('connection')?.requestRejection?.(req),
      passwordFor: resolveVmPassword,
    })
    webCtx.effect(() => webCtx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler: api }))
  })

  // —— 对话里的 `/vm` 快捷调用 ——
  ctx.inject(['commands'], (cmdCtx) => {
    /** 当前 `/vm` 的注销句柄。 */
    let disposeCommand

    /**
     * 命令定义做成工厂函数：`description` 与 `input.hint` 是注册时捕获的静态字符串，
     * 语言切换时要换一份定义才能让 `/` 菜单跟着变。
     */
    const definition = () => ({
      name: 'vm',
      description: t('cmd.description'),
      input: { hint: t('cmd.hint') },
      handler: async (invocation) => {
        const raw = String(invocation.rawInput ?? '').trim()
        const usage = t('cmd.usage')
        try {
          if (raw.length === 0) {
            const result = await inventory.list({ includeMetrics: collectMetrics })
            if (result.entries.length === 0) {
              return { kind: 'error', text: [t('cmd.empty'), ...(result.notes ?? []).map((note) => note.path)].join('\n') }
            }
            return { kind: 'success', text: renderList(result, { limit: 40 }) }
          }
          // 只给名字就是「看这一台」；第二段是动作。
          const tokens = raw.split(/\s+/)
          const ref = tokens[0]
          const action = (tokens[1] ?? 'status').toLowerCase()
          const rest = tokens.slice(2).join(' ').trim()

          if (action === 'status' || action === 'show') {
            const entry = await inventory.detail(ref, { includeSnapshots: true })
            return { kind: 'success', text: renderDetail(entry) }
          }
          if (action === 'snapshots' || action === 'snaps') {
            const item = await inventory.resolve(ref)
            const listed = await inventory.snapshots(item.vmx)
            const entry = await inventory.detail(item.vmx)
            return { kind: listed.ok ? 'success' : 'error', text: [entrySummary(entry), renderSnapshots(entry, listed.snapshots)].join('\n') }
          }
          if (action === 'snap' || action === 'snapshot') {
            requirePermission('snapshot')
            if (rest.length === 0) return { kind: 'error', text: t('api.snapshotNameRequired') }
            const outcome = await inventory.createSnapshot(ref, rest)
            if (outcome.ok !== true) return { kind: 'error', text: describeFailure(outcome.result) }
            const item = await inventory.resolve(ref)
            const entry = await inventory.detail(item.vmx)
            return { kind: 'success', text: [t('vm.snapshotCreated', { name: entry.name, snapshot: rest }), renderSnapshots(entry, outcome.snapshots)].join('\n') }
          }
          if (action === 'delete' || action === 'rm') {
            // 命令是用户直接敲的，不是模型生成的；仍然要求再写一个词，避免误触。
            if (rest !== 'confirm') return { kind: 'error', text: t('vm.deleteNeedsConfirm') }
            requirePermission('delete')
            const outcome = await inventory.remove(ref, { mode: 'trash' })
            return { kind: outcome.ok ? 'success' : 'error', text: renderRemoveOutcome(outcome) }
          }
          if (isPowerAction(action) || action === 'resume') {
            requirePermission('power')
            const normalizedAction = action === 'resume' ? 'unpause' : action
            const outcome = await inventory.power(ref, normalizedAction, { passwordFor: resolveVmPassword })
            return {
              kind: outcome.ok ? 'success' : 'error',
              text: renderPowerOutcome(outcome, { describeFailure }),
            }
          }
          return { kind: 'error', text: t('cmd.unknownAction', { action, usage }) }
        } catch (error) {
          diagnostics.error('command:vm', error)
          const message = error instanceof Error ? error.message : String(error)
          return { kind: 'error', text: `${message}\n${usage}` }
        }
      },
    })

    /** 注册（或按当前语言重新注册）`/vm`。 */
    const registerCommand = () => {
      disposeCommand?.()
      disposeCommand = cmdCtx.commands.register(definition())
    }
    registerCommand()

    cmdCtx.effect(() => {
      const off = onLocaleChange(() => registerCommand())
      return () => {
        off()
        disposeCommand?.()
      }
    }, 'vm-control: localized command definition')
  })

  /** 关闭时释放诊断的挂起写入（无资源需要显式回收，这里只留一个明确的生命周期点）。 */
  ctx.effect(() => () => {
    void diagnostics.status().catch(() => undefined)
  }, 'vm-control: diagnostics flush')
}

/**
 * 暴露状态词，供测试与外部扩展复用。
 * @param state - 状态名。
 * @returns 当前语言标签。
 */
export { stateLabel }
