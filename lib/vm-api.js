/**
 * 设置界面的 HTTP API。
 *
 * 与模型面向的工具相比，这条通道多了两件事，也正是它存在的理由：
 *
 * 1. **界面能表达「确认」。** 删除分三种语义（只移除记录 / 移到回收站 / 连磁盘删除），
 *    模型只能靠参数猜，人可以在卡片上点选。
 * 2. **界面能显示实时数据。** 列表每几秒刷新一次，工具调用做不到这件事。
 *
 * 权限在这里**再判一次**：`index.js` 的工具层已经拦过，但设置接口是另一条进入路径，
 * 只拦一层的话被关掉的能力会从这里绕过去。`delete` 尤其如此——它是默认关闭的那一个。
 *
 * 路径安全性：除 `register` 之外，所有动作都先用 `inventory.resolve` 把 id 解析成库存里
 * 真实存在的虚拟机，**从不直接使用请求体里的路径**去读写文件或启动进程。`register` 是
 * 唯一接受路径的入口，并且要求绝对路径 + `.vmx` 后缀 + 文件确实存在。
 *
 * @module dsh-vm-control/vm-api
 */

import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import {
  renderConfigOutcome,
  renderDetail,
  renderPowerOutcome,
  renderRemoveOutcome,
  renderSnapshots,
} from './format.js'
import { learnLocaleFromHeader, t } from './i18n.js'
import { aliasFor, buildSshPlan } from './ssh-import.js'

/**
 * 路由前缀。
 *
 * **不要带尾斜杠**：Web 服务器的 `kind: 'prefix'` 按「`path` 或 `path + '/'`」匹配，
 * 注册 `/vm-control/` 时 `/vm-control/list` 两者都不命中，请求会落到 fallback。
 */
export const API_PREFIX = '/vm-control'

/** 请求体上限：这里没有上传，256 KB 已经远超任何合法表单。 */
const MAX_BODY_BYTES = 256 * 1024

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
}

/**
 * 写一个 JSON 响应。
 * @param res - HTTP 响应对象。
 * @param status - 状态码。
 * @param body - 可序列化的响应体。
 */
function writeJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

/** 写一个成功 envelope。 */
const ok = (res, value) => writeJson(res, 200, { ok: true, value })

/** 写一个失败 envelope。 */
const fail = (res, code, message, status = 200) => writeJson(res, status, { ok: false, error: { code, message } })

/**
 * 读取有界的 JSON 请求体。
 * @param req - HTTP 请求对象。
 * @returns 解析后的对象；为空、超限或非法 JSON 时返回 `undefined`。
 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      req.destroy()
      return undefined
    }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim().length === 0) return {}
  try {
    const parsed = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * 用系统文件管理器打开一个目录。
 *
 * 只被内部以库存里解析出的路径调用，**从不接受请求方传入的路径**——否则这就成了一个
 * 「按需启动本机程序」的接口。
 *
 * @param target - 要打开的目录。
 */
function defaultOpenFolder(target) {
  const [command, args] = process.platform === 'win32'
    ? ['explorer.exe', [target]]
    : process.platform === 'darwin'
      ? ['open', [target]]
      : ['xdg-open', [target]]
  return new Promise((resolve, reject) => {
    // 用 spawn 而不是 execFile：文件管理器是 GUI 程序，没有理由等它退出。
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

/**
 * 动作 → 需要的权限。`list` / `snapshots` / `show` 这类只读动作不在表里，永远放行。
 */
const ACTION_PERMISSION = Object.freeze({
  power: 'power',
  snapshotCreate: 'snapshot',
  snapshotRevert: 'snapshot',
  snapshotDelete: 'snapshot',
  saveConfig: 'config',
  register: 'config',
  unregister: 'config',
  setRoots: 'config',
  delete: 'delete',
})

/**
 * 构造设置接口处理器。
 *
 * @param options - 依赖注入。
 * @param options.inventory - 虚拟机库存。
 * @param options.store - 数据存储。
 * @param options.permissions - 生效的权限对象。
 * @param options.dataDir - 插件数据目录。
 * @param options.diagnostics - 诊断日志。
 * @param options.logger - 可选日志接口。
 * @param options.pluginVersion - 返回版本号的异步函数。
 * @param options.requestRejection - 可选：把请求交给宿主的 Connection 信任栅栏。
 * @param options.passwordFor - 解析加密虚拟机口令的回调。
 * @param options.openFolder - 打开目录的实现（测试可替换）。
 * @returns `(req, res) => Promise<void>` 形式的处理器。
 */
export function createVmApi({
  inventory,
  store,
  permissions,
  dataDir,
  diagnostics,
  logger,
  pluginVersion,
  requestRejection,
  passwordFor,
  openFolder,
}) {
  const open = openFolder ?? defaultOpenFolder

  /**
   * 把 body 里的 id 解析成库存里的虚拟机。
   * @param body - 请求体。
   * @returns `{ vmx, record }`。
   */
  const resolveVm = async (body) => {
    const ref = typeof body.id === 'string' && body.id.trim().length > 0
      ? body.id.trim()
      : typeof body.vm === 'string' ? body.vm.trim() : ''
    if (ref.length === 0) throw new Error(t('api.vmRequired'))
    return inventory.resolve(ref)
  }

  /**
   * 列表：界面刷新唯一需要的数据。
   * @param body - 请求体。
   * @returns 视图对象。
   */
  const listView = async (body) => {
    if (body.refresh === true) inventory.invalidate()
    const [result, roots, probe, version] = await Promise.all([
      inventory.list({
        includeMetrics: true,
        includeGuest: body.includeGuest === true,
        includeStopped: true,
      }),
      inventory.roots(),
      inventory.vmrun.probe(),
      typeof pluginVersion === 'function' ? pluginVersion() : Promise.resolve('unknown'),
    ])
    return {
      vms: result.entries,
      roots,
      notes: result.notes,
      runningOk: result.runningOk,
      metricsOk: result.metricsOk,
      metricsError: result.metricsError ?? '',
      vmrun: {
        found: probe.found === true,
        path: probe.executable ?? '',
        source: probe.source ?? '',
        version: probe.version ?? '',
        hostType: probe.hostType ?? '',
        capabilities: probe.commands ?? [],
        capabilitiesKnown: probe.capabilitiesKnown === true,
        error: probe.error ?? '',
      },
      permissions,
      dataDir,
      trashDir: inventory.trashDir,
      version,
      now: Date.now(),
    }
  }

  /**
   * 分发一次 API 调用。
   * @param action - 路由末段。
   * @param body - 已解析的请求体。
   * @returns `{ value }` 或 `{ error }`。
   */
  const dispatch = async (action, body) => {
    if (action === 'list') return { value: await listView(body) }

    if (action === 'power') {
      const item = await resolveVm(body)
      const requested = String(body.action ?? '').toLowerCase()
      const outcome = await inventory.power(item.vmx, requested, {
        mode: body.mode === 'hard' ? 'hard' : 'soft',
        gui: body.gui === true,
        passwordFor: typeof passwordFor === 'function' ? passwordFor : undefined,
      })
      return {
        value: {
          ok: outcome.ok,
          entry: outcome.entry,
          message: renderPowerOutcome(outcome, { describeFailure: (result) => inventory.vmrun.describeFailure(result) }),
        },
      }
    }

    if (action === 'snapshots') {
      const item = await resolveVm(body)
      const listed = await inventory.snapshots(item.vmx)
      const entry = await inventory.detail(item.vmx)
      if (listed.ok !== true) {
        return { error: inventory.vmrun.describeFailure(listed.error) }
      }
      return { value: { snapshots: listed.snapshots, message: renderSnapshots(entry, listed.snapshots) } }
    }

    if (action === 'snapshotCreate') {
      const item = await resolveVm(body)
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (name.length === 0) return { error: t('api.snapshotNameRequired') }
      const outcome = await inventory.createSnapshot(item.vmx, name, { description: body.description })
      if (outcome.ok !== true) return { error: inventory.vmrun.describeFailure(outcome.result) }
      const entry = await inventory.detail(item.vmx)
      return {
        value: {
          snapshots: outcome.snapshots,
          message: t('vm.snapshotCreated', { name: entry.name, snapshot: name }),
        },
      }
    }

    if (action === 'snapshotRevert') {
      const item = await resolveVm(body)
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (name.length === 0) return { error: t('api.snapshotNameRequired') }
      const outcome = await inventory.revertSnapshot(item.vmx, name)
      const entry = await inventory.detail(item.vmx)
      if (outcome.reason === 'missing') {
        return {
          error: t('vm.snapshotMissing', {
            name: entry.name,
            snapshot: name,
            list: outcome.available.length > 0 ? outcome.available.join(', ') : t('vm.field.none'),
          }),
        }
      }
      if (outcome.ok !== true) return { error: inventory.vmrun.describeFailure(outcome.result) }
      return { value: { entry, message: t('vm.snapshotReverted', { name: entry.name, snapshot: name }) } }
    }

    if (action === 'snapshotDelete') {
      const item = await resolveVm(body)
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (name.length === 0) return { error: t('api.snapshotNameRequired') }
      const result = await inventory.deleteSnapshot(item.vmx, name, { children: body.children === true })
      if (result.ok !== true) return { error: inventory.vmrun.describeFailure(result) }
      const entry = await inventory.detail(item.vmx)
      return {
        value: {
          entry,
          message: t('vm.snapshotDeleted', {
            name: entry.name,
            snapshot: name,
            children: body.children === true ? t('vm.snapshotWithChildren') : '',
          }),
        },
      }
    }

    if (action === 'detail') {
      const item = await resolveVm(body)
      const entry = await inventory.detail(item.vmx, {
        includeSnapshots: true,
        includeGuest: body.includeGuest === true,
      })
      return { value: { entry: { ...entry, message: renderDetail(entry) } } }
    }

    if (action === 'guest') {
      const item = await resolveVm(body)
      const guest = await inventory.guestInfo(item.vmx, { wait: body.wait === true })
      return { value: { guest } }
    }

    // 与 dsh-ssh-vault 的联动只到「准备数据」这一步：真正的写入由浏览器直接提交给
    // ssh-vault 自己的 `/ssh-vault/save`（同源、带会话），因为保险库的密文只能由它写。
    // 这里因此不需要网络调用，也不可能因为对方缺席而失败——缺席由界面的探测结果显示。
    if (action === 'sshPlan') {
      const item = await resolveVm(body)
      const entry = await inventory.detail(item.vmx)
      const providedHost = typeof body.host === 'string' ? body.host.trim() : ''
      let host = providedHost
      let guest = { attempted: false }
      if (host.length === 0 && body.useGuest !== false && entry.state === 'running') {
        const info = await inventory.guestInfo(item.vmx)
        guest = {
          attempted: true,
          ok: info.available === true,
          ip: info.ip,
          tools: info.tools,
        }
        if (info.available === true) host = info.ip
      }
      const listed = await inventory.list({ includeMetrics: false })
      return {
        value: {
          plan: buildSshPlan(entry, {
            host,
            guest,
            alias: typeof body.alias === 'string' && body.alias.trim().length > 0
              ? body.alias
              : aliasFor(entry, listed.entries),
            importAllowed: permissions?.config === true,
          }),
        },
      }
    }

    if (action === 'networks') {
      const listed = await inventory.hostNetworks()
      if (listed.ok !== true) return { error: inventory.vmrun.describeFailure(listed.error) }
      return { value: { networks: listed.networks } }
    }

    if (action === 'saveConfig') {
      const item = await resolveVm(body)
      const outcome = await inventory.configure(item.vmx, {
        cpus: body.cpus,
        memoryMB: body.memoryMB,
        nicMode: body.nicMode,
        nicName: body.nicName,
        toolsSyncTime: body.toolsSyncTime,
        displayName: body.displayName,
        notes: body.notes,
        tags: body.tags,
        credentialRef: body.credentialRef,
      })
      return {
        value: {
          ok: outcome.ok,
          entry: outcome.entry,
          message: renderConfigOutcome(outcome),
        },
      }
    }

    if (action === 'register') {
      const vmx = typeof body.vmx === 'string' ? body.vmx.trim() : ''
      if (vmx.length === 0) return { error: t('api.vmxRequired') }
      if (!path.isAbsolute(vmx)) return { error: t('api.vmxNotAbsolute', { path: vmx }) }
      if (!/\.vmx$/i.test(vmx)) return { error: t('api.vmxNotVmx', { path: vmx }) }
      const record = await inventory.register({
        vmxPath: vmx,
        name: body.name,
        tags: body.tags,
        notes: body.notes,
        credentialRef: body.credentialRef,
      })
      return { value: { record, message: t('vm.registered', { name: record.name, path: record.vmx }) } }
    }

    if (action === 'unregister') {
      const item = await resolveVm(body)
      const entry = await inventory.detail(item.vmx).catch(() => undefined)
      const removed = await inventory.unregister(item.vmx)
      const name = entry?.name ?? path.basename(item.vmx, path.extname(item.vmx))
      return {
        value: {
          removed,
          message: entry?.missing === true ? t('vm.unregisterMissing', { name }) : t('vm.unregistered', { name }),
        },
      }
    }

    if (action === 'delete') {
      const item = await resolveVm(body)
      const mode = body.mode === 'purge' ? 'purge' : body.mode === 'keep' ? 'keep' : 'trash'
      // purge 连磁盘一起删，必须显式确认；trash 与 keep 都是可恢复 / 不动文件的，不再追问。
      if (mode === 'purge' && body.confirm !== true) return { error: t('api.confirmRequired') }
      const outcome = await inventory.remove(item.vmx, { mode })
      const message = renderRemoveOutcome(outcome)
      if (outcome.ok !== true) return { error: message }
      return { value: { ok: true, message, mode: outcome.mode, trashPath: outcome.trashPath ?? '' } }
    }

    if (action === 'setRoots') {
      const roots = Array.isArray(body.roots) ? body.roots : []
      if (roots.some((root) => typeof root !== 'string' || !path.isAbsolute(root.trim()))) {
        return { error: t('api.rootsInvalid') }
      }
      const saved = await store.setRoots(roots.map((root) => root.trim()).filter((root) => root.length > 0))
      inventory.invalidate()
      return { value: { roots: saved } }
    }

    if (action === 'openFolder') {
      const item = await resolveVm(body)
      const folder = path.dirname(item.vmx)
      try {
        await open(folder)
        return { value: { opened: true, path: folder } }
      } catch (error) {
        return { error: t('api.folderOpenFailed', { message: error instanceof Error ? error.message : String(error) }) }
      }
    }

    if (action === 'openTrash') {
      // 与 openFolder 同一原则：路径只来自插件自身。
      try {
        await mkdir(inventory.trashDir, { recursive: true })
        await open(inventory.trashDir)
        return { value: { opened: true, path: inventory.trashDir } }
      } catch (error) {
        return { error: t('api.folderOpenFailed', { message: error instanceof Error ? error.message : String(error) }) }
      }
    }

    if (action === 'diagnostics' || action === 'setDiagnostics' || action === 'clearDiagnostics' || action === 'openLogs') {
      if (diagnostics === undefined) return { error: t('api.diagnosticsUnavailable') }
      if (action === 'diagnostics') return { value: await diagnostics.status() }
      if (action === 'setDiagnostics') {
        await diagnostics.setEnabled(body.enabled === true)
        return { value: await diagnostics.status() }
      }
      if (action === 'clearDiagnostics') {
        await diagnostics.clear()
        return { value: await diagnostics.status() }
      }
      try {
        await diagnostics.ensureDir()
        await open(diagnostics.dir)
        return { value: { opened: true, path: diagnostics.dir } }
      } catch (error) {
        return { error: t('api.folderOpenFailed', { message: error instanceof Error ? error.message : String(error) }) }
      }
    }

    return { error: t('api.unknownAction', { action }) }
  }

  /**
   * 一次 HTTP 请求的处理入口。
   * @param req - HTTP 请求。
   * @param res - HTTP 响应。
   */
  return async function handle(req, res) {
    try {
      // 信任栅栏先于一切：这条路由能开关机、改 VMX、删目录。
      const rejection = typeof requestRejection === 'function' ? requestRejection(req) : undefined
      if (rejection !== undefined) {
        res.writeHead(rejection, {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        })
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      try {
        learnLocaleFromHeader(req?.headers?.['accept-language'])
      } catch {
        // 头缺失或形状异常都不影响请求本身。
      }
      if (req.method !== 'POST') {
        fail(res, 'method-not-allowed', t('api.methodPostOnly'), 405)
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const rest = url.pathname.startsWith(API_PREFIX) ? url.pathname.slice(API_PREFIX.length) : ''
      const action = rest.startsWith('/') ? rest.slice(1) : rest
      if (action.length === 0 || action.includes('/')) {
        fail(res, 'not-found', t('api.routeUnknown'), 404)
        return
      }
      const body = await readJsonBody(req)
      if (body === undefined) {
        fail(res, 'bad-request', t('api.bodyInvalid'), 400)
        return
      }
      // 权限闸门：只读动作不在表里，因此永远放行。
      const scope = ACTION_PERMISSION[action]
      if (scope !== undefined && permissions?.[scope] !== true) {
        fail(res, 'permission-denied', t('api.permissionDenied', { scope }))
        return
      }
      const outcome = await dispatch(action, body)
      if (outcome.error !== undefined) fail(res, 'request-failed', outcome.error)
      else ok(res, outcome.value)
    } catch (error) {
      logger?.warn?.(`vm-control: settings request failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
      fail(res, 'internal', error instanceof Error ? error.message : String(error), 500)
    }
  }
}
