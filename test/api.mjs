/**
 * 设置接口测试：信封格式、信任栅栏、权限闸门与路径来源。
 *
 * 重点不是「能不能列出虚拟机」，而是**不该能做的事确实做不到**：
 * 请求体里的路径不得被当成文件系统指令、关掉的权限必须在这里也拒绝一次、
 * 未认证的请求必须连请求体都读不到。
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { Diagnostics } from '../lib/diagnostics.js'
import { Inventory } from '../lib/inventory.js'
import { Store } from '../lib/store.js'
import { API_PREFIX, createVmApi } from '../lib/vm-api.js'

const failures = []
let passed = 0

async function test(label, fn) {
  try {
    await fn()
    passed += 1
    console.log(`ok   ${label}`)
  } catch (error) {
    failures.push(label)
    console.error(`FAIL ${label}\n     ${error instanceof Error ? error.stack?.split('\n').slice(0, 4).join('\n     ') : String(error)}`)
  }
}

const tempDir = (prefix) => mkdtemp(path.join(tmpdir(), `${prefix}-`))

/**
 * 造一个假请求。
 * @param options - 方法、路径、请求体与头。
 * @returns 形如 IncomingMessage 的对象。
 */
function makeReq({ method = 'POST', url = API_PREFIX + '/list', body, headers = {} } = {}) {
  const text = body === undefined ? '' : JSON.stringify(body)
  return {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      if (text.length > 0) yield Buffer.from(text, 'utf8')
    },
    destroy() {},
  }
}

/**
 * 造一个假响应。
 * @returns `{ res, read }`。
 */
function makeRes() {
  const captured = { status: 0, headers: {}, body: '' }
  const res = {
    writeHead(status, headers) {
      captured.status = status
      captured.headers = headers ?? {}
      return res
    },
    end(body) {
      captured.body = typeof body === 'string' ? body : String(body ?? '')
    },
  }
  return {
    res,
    read() {
      // 信任栅栏的拒绝是纯文本（与宿主内置路由一致），其余是 JSON 信封。
      const isJson = String(captured.headers['content-type'] ?? '').includes('application/json')
      return {
        status: captured.status,
        headers: captured.headers,
        body: isJson && captured.body.length > 0 ? JSON.parse(captured.body) : undefined,
        text: captured.body,
      }
    },
  }
}

/**
 * 发一次请求。
 * @param api - 处理器。
 * @param options - 请求参数。
 * @returns 解析后的响应。
 */
async function request(api, options) {
  const { res, read } = makeRes()
  await api(makeReq(options), res)
  return read()
}

const SAMPLE_VMX = ['displayName = "One"', 'numvcpus = "2"', 'memsize = "2048"', 'guestOS = "debian12-64"', 'ethernet0.connectionType = "nat"'].join('\r\n')

/**
 * 造一台虚拟机。
 * @param root - 根目录。
 * @param folder - 目录名。
 * @returns vmx 路径。
 */
async function makeVm(root, folder) {
  const dir = path.join(root, folder)
  await mkdir(dir, { recursive: true })
  const vmx = path.join(dir, `${folder}.vmx`)
  await writeFile(vmx, SAMPLE_VMX, 'utf8')
  return vmx
}

/**
 * 造一套 API。
 * @param options - 权限与根目录。
 * @returns `{ api, inventory, vmx, opened, dataDir }`。
 */
async function makeApi({ permissions = { power: true, snapshot: true, config: true, delete: true }, running = [], reject } = {}) {
  const root = await tempDir('vm-api-root')
  const dataDir = await tempDir('vm-api-data')
  const vmx = await makeVm(root, 'one')
  const store = new Store({ dir: dataDir, roots: [root] })
  const state = { running: new Set(running.map((item) => item.toLowerCase())), calls: [], snapshots: [{ name: 'snap1', current: true, depth: 0 }] }
  const lower = (value) => value.toLowerCase()
  const vmrun = {
    state,
    async probe() {
      return {
        found: true, executable: 'C:\\fake\\vmrun.exe', source: 'test', version: '1.17.0', hostType: 'ws',
        commands: ['start', 'stop', 'pause', 'unpause', 'reset', 'list', 'deleteVM', 'listSnapshots', 'snapshot', 'revertToSnapshot', 'deleteSnapshot', 'checkToolsState', 'getGuestIPAddress', 'listHostNetworks'],
        capabilitiesKnown: true,
      }
    },
    async list() { return { ok: true, vms: [...state.running], raw: '' } },
    invalidateList() {},
    async power(action, target) {
      state.calls.push({ action, vmx: target })
      if (action === 'start' || action === 'unpause') state.running.add(lower(target))
      if (action === 'stop' || action === 'suspend') state.running.delete(lower(target))
      return { ok: true, code: 0, stdout: '', stderr: '', command: action, category: undefined }
    },
    async snapshots() { return { ok: true, snapshots: state.snapshots, error: undefined } },
    async createSnapshot() { return { ok: true, code: 0, stdout: '', stderr: '', command: 'snapshot' } },
    async revertSnapshot() { return { ok: true, code: 0, stdout: '', stderr: '', command: 'revertToSnapshot' } },
    async deleteSnapshot() { return { ok: true, code: 0, stdout: '', stderr: '', command: 'deleteSnapshot' } },
    async deleteVm() { return { ok: true, code: 0, stdout: '', stderr: '', command: 'deleteVM' } },
    async toolsState() { return { ok: true, state: 'installed' } },
    async guestIp() { return { ok: true, ip: '192.168.234.129' } },
    async hostNetworks() { return { ok: true, networks: [{ index: 8, name: 'vmnet8', type: 'nat', dhcp: 'true', subnet: '192.168.234.0', mask: '255.255.255.0' }] } },
    async portForwardings() { return { ok: true, forwards: [] } },
    describeFailure(result) { return `vmrun ${result?.command ?? '?'} failed: ${result?.stderr ?? ''}` },
  }
  const inventory = new Inventory({ store, vmrun, trashDir: path.join(dataDir, 'trash'), metrics: false })
  const opened = []
  const diagnostics = new Diagnostics({ dir: path.join(dataDir, 'logs') })
  const api = createVmApi({
    inventory,
    store,
    permissions,
    dataDir,
    diagnostics,
    pluginVersion: async () => '9.9.9',
    requestRejection: reject,
    openFolder: async (target) => { opened.push(target) },
  })
  return { api, inventory, vmx, opened, dataDir, root, state }
}

await test('list 返回虚拟机、权限、vmrun 能力与版本', async () => {
  const { api, vmx, dataDir } = await makeApi()
  const response = await request(api, { body: {} })
  assert.equal(response.status, 200)
  assert.equal(response.body.ok, true)
  const value = response.body.value
  assert.equal(value.vms.length, 1)
  assert.equal(value.vms[0].vmx, vmx)
  assert.equal(value.vms[0].state, 'stopped')
  assert.equal(value.permissions.delete, true)
  assert.equal(value.vmrun.found, true)
  assert.equal(value.vmrun.version, '1.17.0')
  assert.equal(value.version, '9.9.9')
  assert.equal(value.dataDir, dataDir)
  assert.ok(Array.isArray(value.vmrun.capabilities))
  await rm(path.dirname(vmx), { recursive: true, force: true })
})

await test('非 POST 请求被拒且不进入分发', async () => {
  const { api } = await makeApi()
  const response = await request(api, { method: 'GET', url: `${API_PREFIX}/list` })
  assert.equal(response.status, 405)
  assert.equal(response.body.ok, false)
})

await test('未知动作与非法请求体给出明确错误', async () => {
  const { api } = await makeApi()
  const unknown = await request(api, { url: `${API_PREFIX}/nope`, body: {} })
  assert.equal(unknown.body.ok, false)
  assert.ok(unknown.body.error.message.length > 0)

  const { res, read } = makeRes()
  const req = {
    method: 'POST',
    url: `${API_PREFIX}/list`,
    headers: {},
    async *[Symbol.asyncIterator]() { yield Buffer.from('{ not json', 'utf8') },
    destroy() {},
  }
  await api(req, res)
  assert.equal(read().status, 400)
})

await test('信任栅栏先于一切：被拒绝的请求拿不到任何数据', async () => {
  const { api } = await makeApi({ reject: () => 401 })
  const response = await request(api, { body: {} })
  assert.equal(response.status, 401)
  assert.equal(response.body, undefined)
  assert.equal(response.text, 'unauthorized')
})

await test('权限闸门在接口层再拒一次', async () => {
  const { api, vmx } = await makeApi({ permissions: { power: false, snapshot: false, config: false, delete: false } })
  for (const [action, body] of [
    ['power', { id: vmx, action: 'start' }],
    ['snapshotCreate', { id: vmx, name: 's1' }],
    ['saveConfig', { id: vmx, cpus: 2 }],
    ['delete', { id: vmx, mode: 'keep' }],
  ]) {
    const response = await request(api, { url: `${API_PREFIX}/${action}`, body })
    assert.equal(response.body.ok, false, `${action} 应被拒绝`)
    assert.ok(response.body.error.message.includes('permissions'), `${action} 错误消息应提到权限`)
  }
  // 只读动作仍然放行
  const listed = await request(api, { url: `${API_PREFIX}/snapshots`, body: { id: vmx } })
  assert.equal(listed.body.ok, true)
})

await test('power 动作返回消息与刷新后的条目', async () => {
  const { api, vmx } = await makeApi()
  const response = await request(api, { url: `${API_PREFIX}/power`, body: { id: vmx, action: 'start' } })
  assert.equal(response.body.ok, true)
  assert.equal(response.body.value.ok, true)
  assert.equal(response.body.value.entry.state, 'running')
  assert.ok(response.body.value.message.length > 0)

  const stopped = await request(api, { url: `${API_PREFIX}/power`, body: { id: vmx, action: 'stop', mode: 'hard' } })
  assert.equal(stopped.body.value.entry.state, 'stopped')
})

await test('saveConfig 在运行中拒绝改写并说明原因', async () => {
  const { api, vmx } = await makeApi({ running: [] })
  await request(api, { url: `${API_PREFIX}/power`, body: { id: vmx, action: 'start' } })
  const response = await request(api, { url: `${API_PREFIX}/saveConfig`, body: { id: vmx, cpus: 4 } })
  assert.equal(response.body.ok, true)
  assert.equal(response.body.value.ok, false)
  assert.ok(/关机|powered off/i.test(response.body.value.message))
})

await test('saveConfig 关机时写入 VMX', async () => {
  const { api, vmx } = await makeApi()
  const response = await request(api, { url: `${API_PREFIX}/saveConfig`, body: { id: vmx, cpus: 4, memoryMB: 4096, notes: 'lab box' } })
  assert.equal(response.body.ok, true)
  assert.equal(response.body.value.ok, true)
  assert.equal(response.body.value.entry.cpus, 4)
  assert.equal(response.body.value.entry.memoryMB, 4096)
  assert.equal(response.body.value.entry.notes, 'lab box')
})

await test('snapshots / snapshotCreate / snapshotDelete 走同一条状态链', async () => {
  const { api, vmx } = await makeApi()
  const listed = await request(api, { url: `${API_PREFIX}/snapshots`, body: { id: vmx } })
  assert.equal(listed.body.ok, true)
  assert.equal(listed.body.value.snapshots[0].name, 'snap1')

  const created = await request(api, { url: `${API_PREFIX}/snapshotCreate`, body: { id: vmx, name: 'before-upgrade', description: 'notes' } })
  assert.equal(created.body.ok, true)
  assert.ok(created.body.value.message.length > 0)

  const removed = await request(api, { url: `${API_PREFIX}/snapshotDelete`, body: { id: vmx, name: 'snap1' } })
  assert.equal(removed.body.ok, true)
})

await test('delete：purge 需要确认，trash 不移除运行中的虚拟机', async () => {
  const { api, vmx } = await makeApi()
  const noConfirm = await request(api, { url: `${API_PREFIX}/delete`, body: { id: vmx, mode: 'purge' } })
  assert.equal(noConfirm.body.ok, false)

  await request(api, { url: `${API_PREFIX}/power`, body: { id: vmx, action: 'start' } })
  const running = await request(api, { url: `${API_PREFIX}/delete`, body: { id: vmx, mode: 'trash' } })
  assert.equal(running.body.ok, false)

  await request(api, { url: `${API_PREFIX}/power`, body: { id: vmx, action: 'stop' } })
  const trashed = await request(api, { url: `${API_PREFIX}/delete`, body: { id: vmx, mode: 'trash' } })
  assert.equal(trashed.body.ok, true)
  assert.ok(trashed.body.value.trashPath.length > 0)
  assert.equal(existsSync(vmx), false)
})

await test('delete：keep 只移除记录', async () => {
  const { api, vmx, inventory } = await makeApi()
  await inventory.register({ vmxPath: vmx })
  const response = await request(api, { url: `${API_PREFIX}/delete`, body: { id: vmx, mode: 'keep' } })
  assert.equal(response.body.ok, true)
  assert.equal(existsSync(vmx), true)
  assert.equal((await inventory.store.listVms()).length, 0)
})

await test('register 校验绝对路径与扩展名', async () => {
  const { api, vmx } = await makeApi()
  const relative = await request(api, { url: `${API_PREFIX}/register`, body: { vmx: 'relative/one.vmx' } })
  assert.equal(relative.body.ok, false)

  const wrongExtension = await request(api, { url: `${API_PREFIX}/register`, body: { vmx: path.join(path.dirname(vmx), 'readme.txt') } })
  assert.equal(wrongExtension.body.ok, false)
  assert.ok(/vmx/i.test(wrongExtension.body.error.message))

  const missing = await request(api, { url: `${API_PREFIX}/register`, body: { vmx: path.join(path.dirname(vmx), 'missing.vmx') } })
  assert.equal(missing.body.ok, false)

  const good = await request(api, { url: `${API_PREFIX}/register`, body: { vmx, tags: ['lab'] } })
  assert.equal(good.body.ok, true)
  assert.equal(good.body.value.record.name, 'One')
})

await test('openFolder 只打开库存里解析出的目录，忽略请求体里的 path', async () => {
  const { api, vmx, opened } = await makeApi()
  const response = await request(api, {
    url: `${API_PREFIX}/openFolder`,
    body: { id: vmx, path: 'C:\\Windows\\System32' },
  })
  assert.equal(response.body.ok, true)
  assert.deepEqual(opened, [path.dirname(vmx)])
})

await test('setRoots 拒绝相对路径并持久化合法目录', async () => {
  const { api, root } = await makeApi()
  const bad = await request(api, { url: `${API_PREFIX}/setRoots`, body: { roots: ['relative/dir'] } })
  assert.equal(bad.body.ok, false)

  const good = await request(api, { url: `${API_PREFIX}/setRoots`, body: { roots: [root] } })
  assert.equal(good.body.ok, true)
  const listed = await request(api, { body: {} })
  assert.equal(listed.body.value.roots[0].path, root)
})

await test('guest 返回 Tools 状态与客户机 IP', async () => {
  const { api, vmx } = await makeApi({ running: [] })
  const response = await request(api, { url: `${API_PREFIX}/guest`, body: { id: vmx } })
  assert.equal(response.body.ok, true)
  assert.equal(response.body.value.guest.ip, '192.168.234.129')
  assert.equal(response.body.value.guest.available, true)
})

await test('sshPlan 运行中向 VMware Tools 要地址并给出导入建议', async () => {
  const { api, vmx } = await makeApi()
  await request(api, { url: `${API_PREFIX}/power`, body: { id: vmx, action: 'start' } })
  const response = await request(api, { url: `${API_PREFIX}/sshPlan`, body: { id: vmx } })
  assert.equal(response.body.ok, true)
  const plan = response.body.value.plan
  assert.equal(plan.host, '192.168.234.129')
  assert.equal(plan.port, 22)
  assert.equal(plan.username, 'root')
  assert.ok(plan.alias.length > 0)
  assert.equal(plan.importAllowed, true)
  // 计划里永远没有口令：界面在提交时才拿，Host 侧从不经手。
  assert.equal(Object.prototype.hasOwnProperty.call(plan, 'password'), false)
})

await test('sshPlan 尊重显式地址，关机时不再打扰 Tools', async () => {
  const { api, vmx, state } = await makeApi()
  const response = await request(api, { url: `${API_PREFIX}/sshPlan`, body: { id: vmx, host: '10.1.2.3' } })
  assert.equal(response.body.ok, true)
  assert.equal(response.body.value.plan.host, '10.1.2.3')
  assert.equal(response.body.value.plan.guest.attempted, false)
  assert.deepEqual(state.calls, [], '关机的虚拟机不该被问客户机 IP')
})

await test('sshPlan 在 permissions.config 关闭时标记不可导入', async () => {
  const { api, vmx } = await makeApi({ permissions: { power: true, snapshot: true, config: false, delete: false } })
  const response = await request(api, { url: `${API_PREFIX}/sshPlan`, body: { id: vmx, host: '10.1.2.3' } })
  assert.equal(response.body.ok, true)
  assert.equal(response.body.value.plan.importAllowed, false)
})

await test('诊断接口可读可写', async () => {
  const { api } = await makeApi()
  const initial = await request(api, { url: `${API_PREFIX}/diagnostics`, body: {} })
  assert.equal(initial.body.ok, true)
  const enabled = await request(api, { url: `${API_PREFIX}/setDiagnostics`, body: { enabled: true } })
  assert.equal(enabled.body.ok, true)
  const cleared = await request(api, { url: `${API_PREFIX}/clearDiagnostics`, body: {} })
  assert.equal(cleared.body.ok, true)
})

if (failures.length > 0) {
  console.error(`\n${failures.length} 个测试失败，${passed} 个通过`)
  process.exit(1)
}
console.log(`\n${passed} 个测试全部通过`)
