/**
 * 联调测试：对着**真实**的 VMware 跑一遍只读路径。
 *
 * 单元测试里的 vmrun 是假的，它能证明逻辑自洽，但证明不了「解析真实输出这件事」。
 * 这个文件用真实的 vmrun 与真实的 vmx 验证：版探测、运行列表、VMX 解析、网络表、
 * 宿主进程占用，以及最终渲染出的文本。
 *
 * **只读**：不启动、不关机、不拍快照、不删除。需要写操作的验证请在虚拟机里手工确认，
 * 或明确知道后果后自己调用工具——测试脚本不该在别人的机器上按电源键。
 *
 * 用法：
 *   node test/live.mjs                      # 用插件默认的搜索目录
 *   node test/live.mjs "E:\\Virtual Machines"  # 指定搜索目录（可给多个）
 *   DSH_VM_ROOTS="E:\\VMs;D:\\Lab" node test/live.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { Diagnostics } from '../lib/diagnostics.js'
import { Inventory } from '../lib/inventory.js'
import { Store } from '../lib/store.js'
import { formatBytes } from '../lib/metrics.js'
import { discoverVmrun, Vmrun } from '../lib/vmrun.js'
import { renderDetail, renderList, renderSnapshots } from '../lib/format.js'
import { defaultSearchRoots } from '../index.js'

const failures = []
let passed = 0
let skipped = 0

async function test(label, fn) {
  try {
    await fn()
    passed += 1
    console.log(`ok   ${label}`)
  } catch (error) {
    failures.push(label)
    console.error(`FAIL ${label}\n     ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 从命令行参数 / 环境变量 / 默认值里取搜索目录。 */
function rootsFromArgs() {
  const args = process.argv.slice(2).filter((arg) => !arg.startsWith('-'))
  if (args.length > 0) return args
  const env = process.env.DSH_VM_ROOTS
  if (typeof env === 'string' && env.trim().length > 0) {
    return env.split(/[;|]/).map((item) => item.trim()).filter((item) => item.length > 0)
  }
  return defaultSearchRoots().filter((root) => existsSync(root))
}

const found = await discoverVmrun({ configuredPath: process.env.VMRUN_PATH })
if (found.path === undefined) {
  console.log('skip: 这台机器上找不到 vmrun，联调测试跳过（单元测试仍然覆盖了全部逻辑）')
  process.exit(0)
}

console.log(`vmrun: ${found.path}  (来源: ${found.source})`)
const vmrun = new Vmrun({ executable: found.path })
const probe = await vmrun.probe()

await test('probe 读出真实版本、主机类型与命令表', () => {
  assert.equal(probe.found, true)
  assert.ok(probe.version.length > 0, '版本应非空')
  assert.ok(['ws', 'player', 'fusion'].includes(probe.hostType), `主机类型异常: ${probe.hostType}`)
  assert.ok(probe.commands.includes('list'), '命令表应包含 list')
  console.log(`     version=${probe.version} hostType=${probe.hostType} commands=${probe.commands.length}`)

  // 只读动作必须都在；缺了说明这台 vmrun 太旧，插件应给出解释而不是崩。
  for (const required of ['list', 'start', 'stop', 'listSnapshots']) {
    assert.ok(probe.commands.includes(required), `缺少 ${required}`)
  }
})

await test('list 返回真实的运行集合', async () => {
  const listed = await vmrun.list({ refresh: true })
  assert.equal(listed.ok, true, `vmrun list 失败: ${listed.error?.stderr ?? ''}`)
  assert.ok(Array.isArray(listed.vms))
  console.log(`     运行中: ${listed.vms.length} 台${listed.vms.length > 0 ? ` → ${listed.vms.join(', ')}` : ''}`)
})

const roots = rootsFromArgs()
console.log(`搜索目录: ${roots.length > 0 ? roots.join(', ') : '(无)'}`)

const dataDir = await mkdtemp(path.join(tmpdir(), 'vm-control-live-'))
const diagnostics = new Diagnostics({ dir: path.join(dataDir, 'logs') })
const store = new Store({ dir: dataDir, roots, logger: diagnostics.logger })
const inventory = new Inventory({
  store,
  vmrun,
  trashDir: path.join(dataDir, 'trash'),
  metrics: true,
  logger: diagnostics.logger,
})

const listed = await inventory.list({ includeMetrics: true })

if (listed.entries.length === 0) {
  skipped += 1
  console.log('skip: 搜索目录里没有虚拟机；可用 `node test/live.mjs "E:\\Virtual Machines"` 指定目录')
} else {
  await test('Inventory.list 读出真实虚拟机并渲染成文本', () => {
    const text = renderList(listed, { showPaths: true, limit: 10 })
    assert.ok(text.includes('vmrun'), '列表头部应带 vmrun 版本')
    console.log('\n' + text.split('\n').slice(0, 12).join('\n') + '\n')
  })

  await test('每台真实虚拟机都能解析出规格与网卡', async () => {
    for (const entry of listed.entries) {
      assert.ok(entry.name.length > 0, `${entry.vmx} 缺少名称`)
      if (entry.missing) continue
      assert.ok(entry.cpus > 0, `${entry.name} cpus 解析失败`)
      assert.ok(entry.memoryMB > 0, `${entry.name} memoryMB 解析失败`)
      assert.ok(Array.isArray(entry.nics), `${entry.name} nics 不是数组`)
      if (entry.resources !== undefined) {
        assert.ok(entry.resources.workingSetBytes >= 0)
        console.log(`     ${entry.name}: ${entry.resources.cpuPercent.toFixed(1)}% cpu · ${formatBytes(entry.resources.workingSetBytes)} rss · ${entry.resources.threads} threads`)
      }
    }
  })

  await test('detail 能取到快照与完整详情', async () => {
    const first = listed.entries[0]
    const detail = await inventory.detail(first.vmx, { includeSnapshots: true })
    assert.equal(detail.vmx, first.vmx)
    assert.ok(Array.isArray(detail.snapshots), '快照应为数组')
    const text = renderDetail(detail)
    assert.ok(text.includes(first.name))
    console.log('\n' + text.split('\n').slice(0, 14).join('\n') + '\n')
    if (detail.snapshots.length > 0) console.log(renderSnapshots(detail, detail.snapshots))
  })

  await test('resolve 支持名字与路径两种引用', async () => {
    const first = listed.entries[0]
    const byPath = await inventory.resolve(first.vmx)
    assert.equal(byPath.vmx, first.vmx)
    const byName = await inventory.resolve(first.name)
    assert.equal(byName.vmx.toLowerCase(), first.vmx.toLowerCase())
  })
}

await test('listHostNetworks 解析真实网络表', async () => {
  const networks = await inventory.hostNetworks()
  if (networks.ok !== true) {
    console.log('     (这台机器没有可读的虚拟网络表，跳过)')
    return
  }
  assert.ok(Array.isArray(networks.networks))
  const names = networks.networks.map((network) => network.name)
  console.log(`     虚拟网络: ${names.join(', ') || '(无)'}`)
  assert.ok(names.every((name) => typeof name === 'string' && name.length > 0))
})

await test('宿主进程占用采集在真实机器上可用', async () => {
  const collected = await import('../lib/metrics.js').then((module) => module.collectProcessMetrics())
  assert.equal(collected.ok, true, `采集失败: ${collected.error ?? ''}`)
  console.log(`     采集到 ${collected.samples.length} 个 vmware-vmx 样本（没有虚拟机在运行时为 0 是正常的）`)
})

await rm(dataDir, { recursive: true, force: true })

if (failures.length > 0) {
  console.error(`\n${failures.length} 个联调测试失败，${passed} 个通过，${skipped} 个跳过`)
  process.exit(1)
}
console.log(`\n${passed} 个联调测试全部通过${skipped > 0 ? `（${skipped} 个跳过）` : ''}`)
