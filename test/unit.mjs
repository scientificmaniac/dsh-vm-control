/**
 * 单元测试：VMX 解析、vmrun 输出解析与失败归类、占用映射、存储、库存与权限。
 *
 * 这些测试**不需要 VMware**：vmrun 被替换成一个记录调用的假对象，文件系统用临时目录。
 * 真正的联调用 `test/live.mjs`。
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { VM_MESSAGES } from '../lib/locales/vm.js'
import { hasMessage, messageKeys, t } from '../lib/i18n.js'
import { formatBytes, indexSamples, vmxFromCommandLine } from '../lib/metrics.js'
import { Inventory, scanRoot } from '../lib/inventory.js'
import { Store, vmxKey } from '../lib/store.js'
import {
  CATEGORY_MESSAGE,
  classifyFailure,
  parseHostNetworks,
  parsePortForwardings,
  parseRunningVms,
  parseSnapshots,
  parseUsage,
  candidateVmrunPaths,
  discoverVmrun,
} from '../lib/vmrun.js'
import { guestFamilyOf, infoFromEntries, parseVmx, quote, readVmx, writeVmx, writeVmxText } from '../lib/vmx.js'
import { renderList, stateLabel } from '../lib/format.js'
import {
  SSH_VAULT_SAVE_FIELDS,
  aliasFor,
  buildSshPlan,
  detectDefaultKey,
  renderSshPlan,
  suggestAlias,
  suggestUsername,
  uniqueAlias,
} from '../lib/ssh-import.js'
import * as plugin from '../index.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const failures = []
let passed = 0

/**
 * 跑一个测试。
 * @param label - 测试名。
 * @param fn - 测试体。
 */
async function test(label, fn) {
  try {
    await fn()
    passed += 1
    console.log(`ok   ${label}`)
  } catch (error) {
    failures.push({ label, error })
    console.error(`FAIL ${label}\n     ${error instanceof Error ? error.stack?.split('\n').slice(0, 4).join('\n     ') : String(error)}`)
  }
}

/** 建一个临时目录。 */
const tempDir = (prefix) => mkdtemp(path.join(tmpdir(), `${prefix}-`))

/** Kali 风格的 VMX 内容。 */
const SAMPLE_VMX = [
  '# VMware 的注释，改写时必须保留',
  '.encoding = "UTF-8"',
  'config.version = "8"',
  'virtualHW.version = "22"',
  'displayName = "Kali Linux"',
  'guestOS = "debian13-64"',
  'numvcpus = "8"',
  'cpuid.coresPerSocket = "2"',
  'memsize = "4096"',
  'tools.syncTime = "FALSE"',
  'scsi0:0.fileName = "Kali Linux.vmdk"',
  'scsi0:0.present = "TRUE"',
  'ethernet0.present = "TRUE"',
  'ethernet0.connectionType = "nat"',
  'ethernet0.displayName = "VMnet3"',
  'ethernet0.virtualDev = "e1000"',
  'ethernet0.generatedAddress = "00:0C:29:86:65:45"',
  'ethernet1.present = "TRUE"',
  'ethernet1.connectionType = "bridged"',
].join('\r\n')

/**
 * 造一个假的 vmrun：只记录调用并维护一个「运行集合」。
 * @param options - 初始运行集合与失败注入。
 * @returns 假 vmrun。
 */
function fakeVmrun({ running = [], failPower } = {}) {
  const state = {
    running: new Set(running.map((vmx) => vmx.toLowerCase())),
    calls: [],
    snapshots: [],
    networks: [{ index: 8, name: 'VMnet8', type: 'nat', dhcp: 'true', subnet: '192.168.234.0', mask: '255.255.255.0' }],
    deleted: [],
  }
  const lower = (vmx) => vmx.toLowerCase()
  return {
    state,
    async probe() {
      return {
        found: true,
        executable: 'C:\\fake\\vmrun.exe',
        source: 'test',
        version: '1.17.0',
        build: '1',
        hostType: 'ws',
        commands: ['start', 'stop', 'suspend', 'pause', 'unpause', 'reset', 'list', 'deleteVM', 'listSnapshots', 'snapshot', 'revertToSnapshot', 'deleteSnapshot', 'checkToolsState', 'getGuestIPAddress', 'listHostNetworks'],
        capabilitiesKnown: true,
      }
    },
    async list() {
      return { ok: true, vms: [...state.running], raw: '', error: undefined }
    },
    invalidateList() {},
    async power(action, vmx) {
      state.calls.push({ action, vmx })
      if (failPower !== undefined) return failPower
      if (action === 'pause') return { ok: true, code: 0, stdout: '', stderr: '', command: action, category: undefined }
      if (action === 'unpause' || action === 'start') state.running.add(lower(vmx))
      if (action === 'stop' || action === 'suspend' || action === 'reset') state.running.delete(lower(vmx))
      return { ok: true, code: 0, stdout: '', stderr: '', command: action, category: undefined }
    },
    async snapshots() {
      return { ok: true, snapshots: state.snapshots, error: undefined }
    },
    async createSnapshot(_vmx, name) {
      state.snapshots.push({ name, current: true, depth: 0 })
      return { ok: true, code: 0, stdout: '', stderr: '', command: 'snapshot' }
    },
    async revertSnapshot() {
      return { ok: true, code: 0, stdout: '', stderr: '', command: 'revertToSnapshot' }
    },
    async deleteSnapshot() {
      return { ok: true, code: 0, stdout: '', stderr: '', command: 'deleteSnapshot' }
    },
    async deleteVm(vmx) {
      state.deleted.push(vmx)
      return { ok: true, code: 0, stdout: '', stderr: '', command: 'deleteVM' }
    },
    async toolsState() {
      return { ok: true, state: 'installed' }
    },
    async guestIp() {
      return { ok: true, ip: '192.168.234.129' }
    },
    async hostNetworks() {
      return { ok: true, networks: state.networks }
    },
    async portForwardings() {
      return { ok: true, forwards: [] }
    },
    describeFailure(result) {
      return `vmrun ${result?.command ?? '?'} failed`
    },
  }
}

/**
 * 造一台虚拟机目录。
 * @param root - 根目录。
 * @param folder - 子目录名。
 * @param name - displayName。
 * @param extra - 追加到 VMX 的行。
 * @returns vmx 绝对路径。
 */
async function makeVm(root, folder, name, extra = []) {
  const dir = path.join(root, folder)
  await mkdir(dir, { recursive: true })
  const vmx = path.join(dir, `${folder}.vmx`)
  await writeFile(vmx, [SAMPLE_VMX.replace('displayName = "Kali Linux"', `displayName = "${name}"`), ...extra].join('\r\n'), 'utf8')
  return vmx
}

/**
 * 造一套库存。
 * @param options - 根目录与假 vmrun。
 * @returns `{ inventory, store, vmrun, dataDir }`。
 */
async function makeInventory({ root, running = [], failPower } = {}) {
  const dataDir = await tempDir('vm-control-data')
  const store = new Store({ dir: dataDir, roots: [root] })
  const vmrun = fakeVmrun({ running, failPower })
  const inventory = new Inventory({ store, vmrun, trashDir: path.join(dataDir, 'trash'), metrics: false })
  return { inventory, store, vmrun, dataDir }
}

// —— VMX ——

await test('parseVmx 处理注释、引号转义与重复键', () => {
  const text = '# comment\r\nannotation = "a \\"quoted\\" word"\r\ndisplayName = "first"\r\ndisplayName = "second"\r\nempty = ""'
  const { entries } = parseVmx(text)
  assert.equal(entries.annotation, 'a "quoted" word')
  assert.equal(entries.displayName, 'second')
  assert.equal(entries.empty, '')
})

await test('quote 与解析互为逆运算（Windows 路径）', () => {
  const original = 'E:\\Virtual Machines\\Kali Linux\\Kali Linux.vmx'
  const text = `scsi0:0.fileName = ${quote(original)}`
  const { entries } = parseVmx(text)
  assert.equal(entries['scsi0:0.fileName'], original)
})

await test('infoFromEntries 归纳 vCPU / 内存 / 网卡 / 磁盘', () => {
  const { entries } = parseVmx(SAMPLE_VMX)
  const info = infoFromEntries(entries, { vmxPath: 'C:\\vms\\kali.vmx' })
  assert.equal(info.displayName, 'Kali Linux')
  assert.equal(info.cpus, 8)
  assert.equal(info.coresPerSocket, 2)
  assert.equal(info.sockets, 4)
  assert.equal(info.memoryMB, 4096)
  assert.equal(info.guestFamily, 'linux')
  assert.equal(info.encrypted, false)
  assert.equal(info.nics.length, 2)
  assert.equal(info.nics[0].connectionType, 'nat')
  assert.equal(info.nics[0].networkName, 'VMnet3')
  assert.equal(info.nics[0].mac, '00:0C:29:86:65:45')
  assert.equal(info.nics[1].connectionType, 'bridged')
  assert.equal(info.disks.length, 1)
  assert.equal(info.disks[0].device, 'scsi0:0')
})

await test('infoFromEntries 用 vnet 取网络名并区分光驱', () => {
  const { entries } = parseVmx([
    'displayName = "Mixed"',
    'ethernet0.connectionType = "custom"',
    'ethernet0.vnet = "VMnet8"',
    'ethernet0.displayName = "VMnet8 (NAT"',
    'sata0:0.fileName = "Ubuntu.iso"',
    'ide0:0.fileName = "auto detect"',
    'scsi0:0.fileName = "Ubuntu.vmdk"',
  ].join('\n'))
  const info = infoFromEntries(entries, {})
  assert.equal(info.nics[0].networkName, 'VMnet8')
  const byDevice = new Map(info.disks.map((disk) => [disk.device, disk]))
  assert.equal(byDevice.get('sata0:0').kind, 'cdrom')
  assert.equal(byDevice.get('ide0:0').kind, 'cdrom')
  assert.equal(byDevice.get('scsi0:0').kind, 'disk')
})

await test('guestFamilyOf 归类常见 guestOS', () => {
  assert.equal(guestFamilyOf('windows9-64'), 'windows')
  assert.equal(guestFamilyOf('debian13-64'), 'linux')
  assert.equal(guestFamilyOf('ubuntu-64'), 'linux')
  assert.equal(guestFamilyOf('darwin22-64'), 'macos')
  assert.equal(guestFamilyOf('freebsd-64'), 'bsd')
  assert.equal(guestFamilyOf(''), 'other')
})

await test('writeVmxText 只改目标键并保留其余内容', () => {
  const { text, changed } = writeVmxText(SAMPLE_VMX, { numvcpus: '4', memsize: '2048', 'tools.syncTime': 'TRUE' })
  const { entries } = parseVmx(text)
  assert.equal(entries.numvcpus, '4')
  assert.equal(entries.memsize, '2048')
  assert.equal(entries['tools.syncTime'], 'TRUE')
  assert.equal(entries.displayName, 'Kali Linux')
  assert.deepEqual(changed, ['numvcpus', 'memsize', 'tools.syncTime'])
  assert.ok(text.includes('# VMware 的注释，改写时必须保留'))
})

await test('writeVmxText 追加缺失键到最后一个非空行之后', () => {
  const { text } = writeVmxText('a = "1"\r\n\r\n', { b: '2' })
  const lines = text.split('\n')
  assert.equal(parseVmx(text).entries.b, '2')
  assert.equal(parseVmx(text).entries.a, '1')
  assert.equal(lines[0], 'a = "1"')
  assert.equal(lines[1], 'b = "2"')
})

await test('writeVmx 写盘并留下备份', async () => {
  const root = await tempDir('vm-write')
  const vmx = await makeVm(root, 'box', 'Box')
  const result = await writeVmx(vmx, { memsize: '8192' })
  assert.deepEqual(result.changed, ['memsize'])
  assert.ok(existsSync(result.backupPath))
  const parsed = await readVmx(vmx)
  assert.equal(parsed.info.memoryMB, 8192)
  const backup = await readFile(result.backupPath, 'utf8')
  assert.ok(backup.includes('memsize = "4096"'))
  await rm(root, { recursive: true, force: true })
})

// —— vmrun 输出解析 ——

const USAGE = [
  'vmrun version 1.17.0.25219725',
  '',
  'Usage: vmrun [AUTHENTICATION-FLAGS] COMMAND [PARAMETERS]',
  '',
  'AUTHENTICATION-FLAGS',
  '--------------------',
  '   -T <hostType> (ws|fusion||player)',
  '',
  'POWER COMMANDS           PARAMETERS           DESCRIPTION',
  '--------------           ----------           -----------',
  'start                    Path to vmx file     Start a VM or Team',
  '                         [gui|nogui]',
  'pause                    Path to vmx file     Pause a VM',
  '',
  'GENERAL COMMANDS         PARAMETERS           DESCRIPTION',
  '----------------         ----------           -----------',
  'list                                          List all running VMs',
  'deleteVM                 Path to vmx file     Delete a VM',
  'CreateTempfileInGuest    Path to vmx file     Create a temporary file in guest',
  '',
  'Examples:',
  'Starting a virtual machine with Workstation on a Windows host',
  '   vmrun -T ws start "c:\\my VMs\\myVM.vmx"',
].join('\n')

await test('parseUsage 读出版本与命令表并跳过表头', () => {
  const parsed = parseUsage(USAGE)
  assert.equal(parsed.version, '1.17.0.25219725')
  assert.deepEqual(parsed.commands, ['start', 'pause', 'list', 'deleteVM', 'CreateTempfileInGuest'])
  assert.ok(!parsed.commands.includes('POWER'))
  assert.ok(!parsed.commands.includes('vmrun'))
})

await test('parseRunningVms 处理 CRLF 与带空格的路径', () => {
  const text = 'Total running VMs: 2\r\nE:\\Virtual Machines\\Kali Linux\\Kali Linux.vmx\r\n/vms/ubuntu 20/ubuntu.vmx\r\n\r\n'
  assert.deepEqual(parseRunningVms(text), ['E:\\Virtual Machines\\Kali Linux\\Kali Linux.vmx', '/vms/ubuntu 20/ubuntu.vmx'])
})

await test('parseSnapshots 认出 (current) 标记', () => {
  const text = 'Total snapshots: 3\nbefore-upgrade\nclean install (current)\nafter\n'
  const snapshots = parseSnapshots(text)
  assert.deepEqual(snapshots.map((item) => item.name), ['before-upgrade', 'clean install', 'after'])
  assert.equal(snapshots[1].current, true)
})

await test('parseSnapshots 按缩进推导树层级', () => {
  const text = 'Total snapshots: 3\nroot\n   child\n      grandchild\n'
  const snapshots = parseSnapshots(text, { tree: true })
  assert.deepEqual(snapshots.map((item) => item.depth), [0, 1, 2])
})

await test('parseHostNetworks 兼容表格与单列两种输出', () => {
  const table = 'INDEX  NAME    TYPE      DHCP  SUBNET           MASK\n1      vmnet1  hostOnly  true  192.168.6.0      255.255.255.0\n8      vmnet8  nat       true  192.168.234.0    255.255.255.0'
  const parsed = parseHostNetworks(table)
  assert.equal(parsed.length, 2)
  assert.equal(parsed[1].name, 'vmnet8')
  assert.equal(parsed[1].subnet, '192.168.234.0')
  assert.deepEqual(parseHostNetworks('VMnet8\nVMnet1'), [
    { index: undefined, name: 'VMnet8', type: '', dhcp: '', subnet: '', mask: '', raw: 'VMnet8' },
    { index: undefined, name: 'VMnet1', type: '', dhcp: '', subnet: '', mask: '', raw: 'VMnet1' },
  ])
})

await test('parsePortForwardings 认得常见格式并保留原文', () => {
  const text = 'tcp:2222 -> 192.168.234.129:22 ssh\ngarbage line'
  const rows = parsePortForwardings(text)
  assert.equal(rows[0].protocol, 'tcp')
  assert.equal(rows[0].hostPort, 2222)
  assert.equal(rows[0].guestPort, 22)
  assert.equal(rows[1].raw, 'garbage line')
})

await test('classifyFailure 按优先级归类失败', () => {
  assert.equal(classifyFailure('Cannot open VM: E:\\x.vmx, The file does not exist'), 'vm-missing')
  assert.equal(classifyFailure('The virtual machine is not powered on'), 'vm-state')
  assert.equal(classifyFailure('Invalid host type'), 'bad-host-type')
  assert.equal(classifyFailure('The virtual machine is in use'), 'busy')
  assert.equal(classifyFailure('VMware Tools is not running'), 'tools')
  assert.equal(classifyFailure('Access is denied'), 'permission')
  assert.equal(classifyFailure('spawn vmrun ENOENT'), 'vmrun-missing')
  assert.equal(classifyFailure(''), 'unknown')
  assert.equal(classifyFailure('something odd happened'), 'unknown')
})

await test('每个失败类别都有本地化归因', () => {
  for (const key of Object.values(CATEGORY_MESSAGE)) {
    assert.ok(hasMessage(key), `missing message ${key}`)
  }
})

await test('discoverVmrun 优先使用显式配置，缺失时退回候选列表', async () => {
  const dir = await tempDir('vmrun-discover')
  const fake = path.join(dir, process.platform === 'win32' ? 'vmrun.exe' : 'vmrun')
  await writeFile(fake, 'x')
  const found = await discoverVmrun({ configuredPath: fake })
  assert.equal(found.path, fake)
  assert.equal(found.source, 'config')
  const missing = await discoverVmrun({ configuredPath: path.join(dir, 'nope.exe') })
  assert.ok(Array.isArray(missing.tried))
  assert.ok(candidateVmrunPaths({ platform: 'win32', env: { ProgramFiles: 'C:\\PF' } }).some((item) => item.includes('VMware Workstation')))
  await rm(dir, { recursive: true, force: true })
})

// —— 占用映射 ——

await test('vmxFromCommandLine 从真实命令行里取 vmx', () => {
  assert.equal(
    vmxFromCommandLine('"C:\\Program Files (x86)\\VMware\\VMware Workstation\\x64\\vmware-vmx.exe" -s "E:\\Virtual Machines\\Kali Linux\\Kali Linux.vmx" -m "x.lck"'),
    'E:\\Virtual Machines\\Kali Linux\\Kali Linux.vmx',
  )
  assert.equal(vmxFromCommandLine('/usr/lib/vmware/bin/vmware-vmx -s /vms/kali/kali.vmx'), '/vms/kali/kali.vmx')
  assert.equal(vmxFromCommandLine('notepad.exe'), undefined)
})

await test('indexSamples 按 vmx 去重并保留更大的那个进程', () => {
  const map = indexSamples([
    { vmx: 'E:\\A.vmx', workingSetBytes: 100, pid: 1 },
    { vmx: 'e:\\a.vmx', workingSetBytes: 200, pid: 2 },
    undefined,
  ])
  assert.equal(map.size, 1)
  assert.equal(map.get('e:\\a.vmx').pid, 2)
})

await test('formatBytes 输出人类可读单位', () => {
  assert.equal(formatBytes(0), '—')
  assert.equal(formatBytes(1536), '1.5 KB')
  assert.equal(formatBytes(2 * 1024 ** 3), '2.0 GB')
})

// —— 存储 ——

await test('Store 落盘、读取、更新、删除与搜索目录', async () => {
  const dir = await tempDir('vm-store')
  const store = new Store({ dir, roots: ['E:\\VMs'] })
  assert.deepEqual(await store.roots(), ['E:\\VMs'])
  await store.setRoots(['E:\\VMs', 'D:\\Lab'])
  assert.deepEqual(await store.roots(), ['E:\\VMs', 'D:\\Lab'])
  const record = await store.put({ vmx: 'E:\\VMs\\a\\a.vmx', name: 'A', tags: ['lab'], notes: 'hi' })
  assert.equal(record.name, 'A')
  assert.equal(record.addedAt.length > 0, true)
  assert.equal((await store.get('e:\\vms\\A\\a.vmx')).notes, 'hi')
  const patched = await store.patch('E:\\VMs\\a\\a.vmx', { pausedAt: 'now' })
  assert.equal(patched.pausedAt, 'now')
  await store.setSnapshotNote('E:\\VMs\\a\\a.vmx', 'snap1', 'before upgrade')
  assert.equal((await store.get('E:\\VMs\\a\\a.vmx')).snapshots.snap1.note, 'before upgrade')
  assert.equal(await store.remove('E:\\VMs\\a\\a.vmx'), true)
  assert.equal(await store.remove('E:\\VMs\\a\\a.vmx'), false)
  const onDisk = JSON.parse(await readFile(path.join(dir, 'vms.json'), 'utf8'))
  assert.equal(onDisk.version, 1)
  assert.deepEqual(onDisk.roots, ['E:\\VMs', 'D:\\Lab'])
  await rm(dir, { recursive: true, force: true })
})

await test('Store 遇到损坏文件时备份并重新开始', async () => {
  const dir = await tempDir('vm-store-corrupt')
  await writeFile(path.join(dir, 'vms.json'), '{ not json', 'utf8')
  const store = new Store({ dir, roots: ['E:\\VMs'] })
  assert.deepEqual(await store.listVms(), [])
  const files = await readdir(dir)
  assert.ok(files.some((file) => file.startsWith('vms.json.corrupt-')))
  await rm(dir, { recursive: true, force: true })
})

await test('vmxKey 归一化大小写与相对路径', () => {
  assert.equal(vmxKey('E:\\VMs\\A\\a.vmx'), path.resolve('E:\\VMs\\A\\a.vmx').toLowerCase())
})

// —— 库存 ——

await test('scanRoot 找到嵌套的 vmx 并跳过 .lck', async () => {
  const root = await tempDir('vm-scan')
  await makeVm(root, 'one', 'One')
  await makeVm(path.join(root, 'group'), 'two', 'Two')
  await mkdir(path.join(root, 'one', 'one.vmx.lck'), { recursive: true })
  const result = await scanRoot(root, { depth: 3 })
  assert.equal(result.vmxFiles.length, 2)
  assert.equal(result.truncated, false)
  await rm(root, { recursive: true, force: true })
})

await test('Inventory.list 合并扫描结果与运行状态', async () => {
  const root = await tempDir('vm-inv')
  const first = await makeVm(root, 'one', 'One')
  const second = await makeVm(root, 'two', 'Two')
  await writeFile(path.join(root, 'two', 'two.vmss'), 'suspend-state', 'utf8')
  const third = await makeVm(root, 'three', 'Three')
  const { inventory, store, dataDir } = await makeInventory({ root, running: [third] })
  await store.put({ vmx: third, name: 'Three' })
  await store.setPaused(third, true)

  const result = await inventory.list({ includeMetrics: false })
  const byName = new Map(result.entries.map((entry) => [entry.name, entry]))
  assert.equal(byName.get('One').state, 'stopped')
  assert.equal(byName.get('Two').state, 'suspended')
  assert.equal(byName.get('Three').state, 'paused')
  assert.equal(result.runningOk, true)
  assert.equal(result.vmrun.found, true)
  assert.ok(byName.get('One').missing === false)
  assert.equal(byName.get('One').registered, false)

  // 正在运行的排在前面
  assert.equal(result.entries[0].name, 'Three')
  await rm(root, { recursive: true, force: true })
  await rm(dataDir, { recursive: true, force: true })
})

await test('Inventory.resolve 支持名字、路径，并对重名报歧义', async () => {
  const root = await tempDir('vm-resolve')
  const vmx = await makeVm(root, 'one', 'Twin')
  await makeVm(root, 'two', 'Twin')
  const { inventory, dataDir } = await makeInventory({ root })
  const byPath = await inventory.resolve(vmx)
  assert.equal(byPath.vmx, vmx)
  await assert.rejects(() => inventory.resolve('Twin'), /匹配到多台|matches several|Twin/)
  await assert.rejects(() => inventory.resolve('nope'), /找不到|No virtual machine|nope/)
  await rm(root, { recursive: true, force: true })
  await rm(dataDir, { recursive: true, force: true })
})

await test('Inventory.power 检查状态、执行动作并确认新状态', async () => {
  const root = await tempDir('vm-power')
  const vmx = await makeVm(root, 'one', 'One')
  const { inventory, vmrun, dataDir } = await makeInventory({ root })

  const refused = await inventory.power(vmx, 'stop')
  assert.equal(refused.ok, false)
  assert.equal(refused.reason, 'state')

  const started = await inventory.power(vmx, 'start')
  assert.equal(started.ok, true)
  assert.equal(started.from, 'stopped')
  assert.equal(started.to, 'running')
  assert.equal(started.reason, 'confirmed')

  const paused = await inventory.power(vmx, 'pause')
  assert.equal(paused.to, 'paused')
  const resumed = await inventory.power(vmx, 'unpause')
  assert.equal(resumed.to, 'running')

  const stopped = await inventory.power(vmx, 'stop', { mode: 'hard' })
  assert.equal(stopped.to, 'stopped')
  assert.ok(vmrun.state.calls.some((call) => call.action === 'stop'))
  await rm(root, { recursive: true, force: true })
  await rm(dataDir, { recursive: true, force: true })
})

await test('Inventory.power 在 vmrun 失败时交回失败结果与类别', async () => {
  const root = await tempDir('vm-power-fail')
  const vmx = await makeVm(root, 'one', 'One')
  const failure = { ok: false, code: 1, stdout: '', stderr: 'Cannot open VM', command: 'start', category: 'vm-missing' }
  const { inventory, dataDir } = await makeInventory({ root, failPower: failure })
  const outcome = await inventory.power(vmx, 'start')
  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, 'vmrun')
  assert.equal(outcome.result.category, 'vm-missing')
  await rm(root, { recursive: true, force: true })
  await rm(dataDir, { recursive: true, force: true })
})

await test('Inventory.configure 改写 VMX 并要求关机', async () => {
  const root = await tempDir('vm-config')
  const vmx = await makeVm(root, 'one', 'One')
  const { inventory, vmrun, dataDir } = await makeInventory({ root })

  const changed = await inventory.configure(vmx, { cpus: 4, memoryMB: 8192, nicMode: 'hostonly', toolsSyncTime: true, notes: 'lab' })
  assert.equal(changed.ok, true)
  assert.ok(changed.changed.includes('numvcpus'))
  assert.ok(changed.backupPath.endsWith('.bak'))
  const file = await readVmx(vmx)
  assert.equal(file.info.cpus, 4)
  assert.equal(file.info.memoryMB, 8192)
  assert.equal(file.info.nics[0].connectionType, 'hostonly')
  assert.equal(file.info.toolsSyncTime, true)
  assert.equal(file.entries['cpuid.coresPerSocket'], '2')
  assert.equal((await inventory.detail(vmx)).notes, 'lab')

  assert.equal((await inventory.configure(vmx, { cpus: 0 })).reason, 'cpus')
  assert.equal((await inventory.configure(vmx, { memoryMB: 6 })).reason, 'memory')
  assert.equal((await inventory.configure(vmx, { nicMode: 'custom' })).reason, 'nicName')

  await inventory.power(vmx, 'start')
  const refused = await inventory.configure(vmx, { cpus: 2 })
  assert.equal(refused.ok, false)
  assert.equal(refused.reason, 'power')
  assert.ok(vmrun.state.calls.some((call) => call.action === 'start'))
  await rm(root, { recursive: true, force: true })
  await rm(dataDir, { recursive: true, force: true })
})

await test('Inventory.remove 支持只移除记录 / 回收站 / 彻底删除', async () => {
  const root = await tempDir('vm-remove')
  const vmx = await makeVm(root, 'one', 'One')
  const { inventory, store, vmrun, dataDir } = await makeInventory({ root })
  await store.put({ vmx, name: 'One' })

  const kept = await inventory.remove(vmx, { mode: 'keep' })
  assert.equal(kept.ok, true)
  assert.ok(existsSync(vmx))
  assert.equal(await store.get(vmx), undefined)

  const trashed = await inventory.remove(vmx, { mode: 'trash' })
  assert.equal(trashed.ok, true)
  assert.ok(trashed.trashPath.includes('One'))
  assert.equal(existsSync(vmx), false)
  assert.ok(existsSync(trashed.trashPath))

  const fresh = await makeVm(root, 'two', 'Two')
  const purged = await inventory.remove(fresh, { mode: 'purge' })
  assert.equal(purged.ok, true)
  assert.ok(vmrun.state.deleted.includes(fresh))
  await rm(root, { recursive: true, force: true })
  await rm(dataDir, { recursive: true, force: true })
})

await test('Inventory.remove 拒绝搬走含多台虚拟机的目录', async () => {
  const root = await tempDir('vm-remove-shared')
  const first = await makeVm(root, 'one', 'One')
  await writeFile(path.join(root, 'one', 'second.vmx'), SAMPLE_VMX, 'utf8')
  const { inventory, dataDir } = await makeInventory({ root })
  const outcome = await inventory.remove(first, { mode: 'trash' })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, 'shared-folder')
  assert.ok(outcome.siblings.includes('second.vmx'))
  await rm(root, { recursive: true, force: true })
  await rm(dataDir, { recursive: true, force: true })
})

await test('Inventory.register 校验路径并在重名时报错', async () => {
  const root = await tempDir('vm-register')
  const vmx = await makeVm(root, 'one', 'One')
  const other = await makeVm(root, 'two', 'Two')
  const { inventory, dataDir } = await makeInventory({ root: path.join(root, 'none') })
  const record = await inventory.register({ vmxPath: vmx, tags: ['lab'] })
  assert.equal(record.name, 'One')
  assert.deepEqual(record.tags, ['lab'])
  await assert.rejects(() => inventory.register({ vmxPath: path.join(root, 'missing.vmx') }))
  await assert.rejects(() => inventory.register({ vmxPath: other, name: 'One' }), /已被|already used|One/)
  await rm(root, { recursive: true, force: true })
  await rm(dataDir, { recursive: true, force: true })
})

await test('Inventory.createSnapshot 记下备注，deleteSnapshot 清掉它', async () => {
  const root = await tempDir('vm-snap-note')
  const vmx = await makeVm(root, 'one', 'One')
  const { inventory, store, dataDir } = await makeInventory({ root })
  const created = await inventory.createSnapshot(vmx, 'snap1', { description: 'before upgrade' })
  assert.equal(created.ok, true)
  const record = await store.get(vmx)
  assert.equal(record.snapshots.snap1.note, 'before upgrade')

  await inventory.deleteSnapshot(vmx, 'snap1')
  const after = await store.get(vmx)
  assert.equal(after.snapshots.snap1, undefined)
  await rm(root, { recursive: true, force: true })
  await rm(dataDir, { recursive: true, force: true })
})

await test('Inventory.revertSnapshot 对不存在的快照给出可用列表', async () => {
  const root = await tempDir('vm-snap-revert')
  const vmx = await makeVm(root, 'one', 'One')
  const { inventory, vmrun, dataDir } = await makeInventory({ root })
  vmrun.state.snapshots = [{ name: 'real', current: true, depth: 0 }]
  const outcome = await inventory.revertSnapshot(vmx, 'ghost')
  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, 'missing')
  assert.deepEqual(outcome.available, ['real'])
  await rm(root, { recursive: true, force: true })
  await rm(dataDir, { recursive: true, force: true })
})

await test('Inventory.snapshots 合并插件记录的说明', async () => {
  const root = await tempDir('vm-snap')
  const vmx = await makeVm(root, 'one', 'One')
  const { inventory, store, vmrun, dataDir } = await makeInventory({ root })
  vmrun.state.snapshots = [{ name: 'snap1', current: true, depth: 0 }]
  await store.put({ vmx, name: 'One' })
  await store.setSnapshotNote(vmx, 'snap1', 'before upgrade')
  const listed = await inventory.snapshots(vmx)
  assert.equal(listed.ok, true)
  assert.equal(listed.snapshots[0].note, 'before upgrade')
  await rm(root, { recursive: true, force: true })
  await rm(dataDir, { recursive: true, force: true })
})

// —— 文本渲染 ——

await test('renderList 输出状态词、规格与警告', async () => {
  const root = await tempDir('vm-format')
  const vmx = await makeVm(root, 'one', 'One')
  const { inventory, dataDir } = await makeInventory({ root })
  const result = await inventory.list({ includeMetrics: false })
  const text = renderList(result, { showPaths: true })
  assert.ok(text.includes('One'))
  assert.ok(text.includes('已停止') || text.includes('stopped'))
  assert.ok(text.includes(vmx))
  const missing = renderList({ entries: [], roots: [], notes: [], runningOk: false, metricsOk: false, metricsError: 'boom', vmrun: { found: true, hostType: 'ws', version: '1.17' } })
  assert.ok(missing.includes('vmx') === false || missing.includes('没有找到') || missing.includes('no virtual machine'))
  await rm(root, { recursive: true, force: true })
  await rm(dataDir, { recursive: true, force: true })
})

// —— 与 dsh-ssh-vault 的联动 ——

/** 一台 Linux 虚拟机的视图（只保留导入用到的字段）。 */
const SSH_ENTRY = {
  name: 'Kali Linux',
  vmx: 'E:\\VMs\\kali\\kali.vmx',
  guestFamily: 'linux',
  tags: ['lab', 'vmware'],
}

await test('suggestAlias 压出 ssh-vault 认可的别名且结果稳定', () => {
  assert.equal(suggestAlias('Kali Linux', '/x.vmx'), 'kali-linux')
  // 中文前缀被折成分隔符，剩下的 ASCII 部分保留
  assert.equal(suggestAlias('软件安全kali Linux', '/x.vmx'), 'kali-linux')
  assert.equal(suggestAlias('  --Weird__Name.. ', '/x.vmx'), 'weird__name')
  const fallback = suggestAlias('测试机', '/a/b.vmx')
  assert.match(fallback, /^vm-[a-z0-9]{6}$/)
  assert.equal(fallback, suggestAlias('测试机', '/a/b.vmx'), '同一路径应得到同一别名')
  assert.notEqual(fallback, suggestAlias('测试机', '/other.vmx'))
  assert.ok(suggestAlias('x'.repeat(80), '/a.vmx').length <= 40)
})

await test('uniqueAlias / aliasFor 让同批虚拟机的别名不撞车', () => {
  assert.equal(uniqueAlias('kali', []), 'kali')
  assert.equal(uniqueAlias('kali', ['KALI']), 'kali-2')
  assert.equal(uniqueAlias('kali', ['kali', 'kali-2']), 'kali-3')

  const entries = [
    { name: 'Kali Linux', vmx: 'E:\\a\\kali.vmx' },
    { name: '软件安全kali Linux', vmx: 'E:\\b\\kali2.vmx' },
  ]
  // 两个名字压出同一个别名，第二台必须自动让位
  assert.equal(aliasFor(entries[0], entries), 'kali-linux')
  assert.equal(aliasFor(entries[1], entries), 'kali-linux-2')
  // 自己不算冲突
  assert.equal(aliasFor(entries[0], [entries[0]]), 'kali-linux')
})

await test('suggestUsername 只对 Linux/BSD 猜 root', () => {
  assert.equal(suggestUsername('linux'), 'root')
  assert.equal(suggestUsername('bsd'), 'root')
  assert.equal(suggestUsername('windows'), '')
  assert.equal(suggestUsername('macos'), '')
  assert.equal(suggestUsername('other'), '')
})

await test('buildSshPlan 组装地址、账号、标签与等价命令', () => {
  const plan = buildSshPlan(SSH_ENTRY, {
    host: '192.168.234.129',
    guest: { attempted: true, ok: true, ip: '192.168.234.129' },
    defaultKeyPath: null,
  })
  assert.equal(plan.alias, 'kali-linux')
  assert.equal(plan.host, '192.168.234.129')
  assert.equal(plan.port, 22)
  assert.equal(plan.username, 'root')
  assert.equal(plan.authType, 'password')
  assert.deepEqual(plan.tags, ['vmware', 'lab'])
  assert.equal(plan.sshCommand, 'ssh root@192.168.234.129')
  assert.ok(plan.description.includes('Kali Linux'))
  assert.deepEqual(plan.warnings, ['need-password'])
  assert.equal(plan.importAllowed, true)
})

await test('buildSshPlan 缺地址/账号时给出警告而不是编一个值', () => {
  const plan = buildSshPlan({ name: 'Windows 10', vmx: 'E:\\VMs\\win\\win.vmx', guestFamily: 'windows', tags: [] }, { defaultKeyPath: '' })
  assert.equal(plan.host, '')
  assert.equal(plan.username, '')
  assert.equal(plan.authType, 'password')
  assert.deepEqual(plan.warnings, ['no-host', 'no-username', 'need-password'])
  assert.equal(plan.sshCommand, '')
  assert.deepEqual(plan.tags, ['vmware'])
})

await test('buildSshPlan 有默认私钥时选私钥认证并带上路径', () => {
  const keyPath = path.join('C:', 'Users', 'me', '.ssh', 'id_ed25519')
  const plan = buildSshPlan(SSH_ENTRY, { host: '10.0.0.5', defaultKeyPath: keyPath, importAllowed: false })
  assert.equal(plan.authType, 'key')
  assert.equal(plan.privateKeyPath, keyPath)
  assert.deepEqual(plan.warnings, [])
  assert.equal(plan.sshCommand, 'ssh root@10.0.0.5')
  assert.equal(plan.importAllowed, false)
})

await test('detectDefaultKey 按 ed25519 → ecdsa → rsa 的顺序找', async () => {
  const dir = await tempDir('ssh-keydir')
  assert.equal(detectDefaultKey({ sshDir: dir }), '')
  await writeFile(path.join(dir, 'id_rsa'), 'x', 'utf8')
  assert.equal(detectDefaultKey({ sshDir: dir }), path.join(dir, 'id_rsa'))
  await writeFile(path.join(dir, 'id_ed25519'), 'x', 'utf8')
  assert.equal(detectDefaultKey({ sshDir: dir }), path.join(dir, 'id_ed25519'))
  await rm(dir, { recursive: true, force: true })
})

await test('renderSshPlan 说清地址来源、命令与导入入口', () => {
  const plan = buildSshPlan(SSH_ENTRY, { host: '10.0.0.5', guest: { attempted: true, ok: true }, defaultKeyPath: '/home/me/.ssh/id_rsa' })
  const text = renderSshPlan(plan)
  assert.ok(text.includes('kali-linux'))
  assert.ok(text.includes('10.0.0.5'))
  assert.ok(text.includes('ssh root@10.0.0.5'))
  assert.ok(/设置|Settings/.test(text), '应告诉用户导入入口在设置页')

  const bare = buildSshPlan({ name: 'Box', vmx: '/box.vmx', guestFamily: 'other', tags: [] }, { defaultKeyPath: '' })
  const missing = renderSshPlan(bare)
  assert.ok(/未知|unknown/i.test(missing))
  assert.ok(/没有任何地址|without a host|地址/.test(missing))
})

await test('导入字段集合与 ssh-vault 的 save 契约逐字一致', async () => {
  const expected = ['alias', 'host', 'port', 'username', 'shell', 'description', 'tags', 'authType', 'password', 'privateKeyPath', 'passphrase']
  assert.deepEqual([...SSH_VAULT_SAVE_FIELDS].sort(), expected.slice().sort())

  // 界面是真正提交的那一端，字段名单必须与 Host 侧完全一致，否则「导入」会静默丢掉字段。
  const source = await readFile(path.join(ROOT, 'client.js'), 'utf8')
  const match = /const SSH_SAVE_FIELDS = \[([^\]]+)\]/.exec(source)
  assert.ok(match !== null, 'client.js 应声明 SSH_SAVE_FIELDS')
  const clientFields = [...match[1].matchAll(/'([^']+)'/g)].map((item) => item[1])
  assert.deepEqual(clientFields.slice().sort(), [...SSH_VAULT_SAVE_FIELDS].sort())
})

// —— 文案 ——

await test('每条文案都有中英两份非空文本', () => {
  for (const key of messageKeys()) {
    const entry = VM_MESSAGES[key]
    assert.equal(typeof entry.zh, 'string', `${key} 缺中文`)
    assert.equal(typeof entry.en, 'string', `${key} 缺英文`)
    assert.ok(entry.zh.length > 0, `${key} 中文为空`)
    assert.ok(entry.en.length > 0, `${key} 英文为空`)
  }
})

const HOST_SOURCES = ['index.js', 'lib/vmrun.js', 'lib/inventory.js', 'lib/format.js', 'lib/store.js', 'lib/vm-api.js', 'lib/platform.js', 'lib/ssh-import.js']

/**
 * 读一遍 Host 侧源码，收集所有 `t('key')` 形式引用到的文案键。
 * @returns 键集合。
 */
async function collectReferencedKeys() {
  const used = new Set()
  for (const file of HOST_SOURCES) {
    const source = await readFile(path.join(ROOT, file), 'utf8')
    for (const match of source.matchAll(/\bt\('([A-Za-z0-9_.]+)'/g)) used.add(match[1])
  }
  return used
}

await test('源码里引用的每个文案键都存在', async () => {
  const used = await collectReferencedKeys()
  const missing = [...used].filter((key) => !hasMessage(key))
  assert.deepEqual(missing, [], `缺少文案：${missing.join(', ')}`)
})

await test('Host 侧没有定义却从未使用的文案', async () => {
  // 只看 `t('…')` 会漏掉「以字面量形式被引用」的键：失败类别表（CATEGORY_MESSAGE）
  // 与提示表（CATEGORY_HINT）都是「值就是键」，所以这里按源码里出现过的字符串字面量判断。
  const literals = new Set()
  for (const file of HOST_SOURCES) {
    const source = await readFile(path.join(ROOT, file), 'utf8')
    for (const match of source.matchAll(/'([a-z][A-Za-z0-9]*\.[A-Za-z0-9_.]+)'/g)) literals.add(match[1])
  }
  // 状态词由 `vm.state.${state}` 动态拼出。
  const dynamicPrefixes = ['vm.state.']
  const unused = messageKeys().filter((key) => !literals.has(key) && !dynamicPrefixes.some((prefix) => key.startsWith(prefix)))
  assert.deepEqual(unused, [], `未使用的文案：${unused.join(', ')}`)
})

await test('每个运行状态都有本地化标签', () => {
  for (const state of ['running', 'paused', 'suspended', 'stopped', 'missing', 'unknown']) {
    assert.ok(hasMessage(`vm.state.${state}`), `缺少状态文案 ${state}`)
    assert.notEqual(stateLabel(state), state, `${state} 未翻译`)
  }
})

await test('t() 做占位符替换', () => {
  assert.equal(t('vm.state.running'), '运行中')
  assert.ok(t('vm.notFound', { ref: 'kali', hint: 'x' }).includes('kali'))
})

// —— 插件入口与权限 ——

await test('apply 注册四个工具且描述完整', async () => {
  const root = await tempDir('vm-apply')
  const registered = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    tools: {
      register(definition) {
        registered.set(definition.name, definition)
        return () => registered.delete(definition.name)
      },
    },
    inject() {},
    get() {
      return undefined
    },
  }
  plugin.apply(ctx, { searchRoots: [root], collectMetrics: false })
  assert.deepEqual([...registered.keys()].sort(), ['vm_config', 'vm_list', 'vm_power', 'vm_snapshot'])
  for (const definition of registered.values()) {
    assert.ok(definition.description.length > 80, `${definition.name} 描述过短`)
    assert.equal(definition.parameters.type, 'object')
    assert.equal(typeof definition.execute, 'function')
    assert.equal(typeof definition.output.render, 'function')
  }
  const power = registered.get('vm_power')
  assert.deepEqual(power.parameters.required, ['vm', 'action'])
  await rm(root, { recursive: true, force: true })
})

await test('permissions 关闭时工具在触碰 VMware 之前就拒绝', async () => {
  const root = await tempDir('vm-deny')
  const registered = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    tools: {
      register(definition) {
        registered.set(definition.name, definition)
        return () => registered.delete(definition.name)
      },
    },
    inject() {},
    get() {
      return undefined
    },
  }
  plugin.apply(ctx, {
    searchRoots: [root],
    collectMetrics: false,
    permissions: { power: false, snapshot: false, config: false, delete: false },
  })
  await assert.rejects(() => registered.get('vm_power').execute({ vm: 'x', action: 'start' }, {}), /permissions\.power|permissions/)
  await assert.rejects(() => registered.get('vm_snapshot').execute({ vm: 'x', action: 'create', name: 's1' }, {}), /permissions\.snapshot|permissions/)
  await assert.rejects(() => registered.get('vm_config').execute({ action: 'delete', vm: 'x', confirm: true }, {}), /permissions\.delete|permissions/)
  await rm(root, { recursive: true, force: true })
})

await test('defaultSearchRoots 返回本机平台的绝对路径', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const roots = plugin.defaultSearchRoots(platform)
    assert.ok(roots.length > 0)
    // 只能对自己所在的平台断言「绝对路径」：在 Linux 上构造出来的 `C:\Users\...`
    // 按 POSIX 语义确实不是绝对路径，那是平台差异而不是缺陷。
    if (platform === process.platform) assert.ok(roots.every((root) => path.isAbsolute(root)))
    else assert.ok(roots.every((root) => root.length > 0))
  }
})

// —— 收尾 ——

if (failures.length > 0) {
  console.error(`\n${failures.length} 个测试失败，${passed} 个通过`)
  process.exit(1)
}
console.log(`\n${passed} 个测试全部通过`)
