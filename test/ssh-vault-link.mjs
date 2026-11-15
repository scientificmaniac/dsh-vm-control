/**
 * 联动契约测试：把我们「整理出来的字段」真的喂给 dsh-ssh-vault 的保存接口。
 *
 * 这一条比其它测试都硬：它不模拟对方，而是直接加载**对方的源码**，用它的 `Vault` 与
 * `createVaultApi` 起一套内存里的保险库，然后提交我们界面上会提交的那一份 payload。
 * 于是「字段名对不对、别名校验过不过、口令有没有落进记录、更新语义是不是覆盖」这些
 * 问题不再是推测。
 *
 * 找不到对方源码时**跳过而不是失败**：本仓库可以独立克隆，没理由要求旁边躺着另一个
 * 插件。CI 里因此会打印一行 skip，本地开发机上则真的会跑。
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { SSH_VAULT_SAVE_FIELDS, buildSshPlan } from '../lib/ssh-import.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SIBLING = path.resolve(ROOT, '..', 'dsh-ssh-vault-main', 'dsh-ssh-vault-main')
const VAULT_API = path.join(SIBLING, 'lib', 'vault-api.js')
const VAULT_MODULE = path.join(SIBLING, 'lib', 'vault.js')

const present = await stat(VAULT_API).then(() => true).catch(() => false)
if (!present) {
  console.log('skip: 未找到 dsh-ssh-vault 源码（把它克隆到本仓库旁边即可运行这一组联动测试）')
  process.exit(0)
}

const { createVaultApi } = await import(pathToFileURL(VAULT_API).href)
const { Vault } = await import(pathToFileURL(VAULT_MODULE).href)

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

const PREFIX = '/ssh-vault'

/** 造一个假请求。 */
function makeReq({ method = 'POST', url = `${PREFIX}/list`, body, headers = {} } = {}) {
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

/** 造一个假响应，并返回读取函数。 */
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
      return {
        status: captured.status,
        envelope: captured.body.length > 0 ? JSON.parse(captured.body) : undefined,
      }
    },
  }
}

/**
 * 起一套真实的 ssh-vault 设置接口（数据目录是临时的）。
 * @returns `{ invoke, vault, dir }`。
 */
async function makeVaultApi() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ssh-vault-link-'))
  const vault = new Vault({
    dir,
    // dpapi 只在 Windows 上有；其余平台用主口令，两个平台都能真正跑通。
    keyProtection: process.platform === 'win32' ? 'dpapi' : 'passphrase',
    masterPassword: 'link-test-passphrase',
  })
  const handler = createVaultApi({
    vault,
    vaultDir: dir,
    probe: async () => ({ ok: true, detail: '', notes: [] }),
  })
  const invoke = async (action, body) => {
    const { res, read } = makeRes()
    await handler(makeReq({ url: `${PREFIX}/${action}`, body }), res)
    return read()
  }
  return { invoke, vault, dir }
}

/**
 * 我们界面会提交的 payload —— 必须逐字复刻 `client.js` 里 `submit` 的组装逻辑，
 * 否则这组测试验证的就是另一个东西。字段集合再与 Host 侧白名单对齐一次。
 *
 * @param plan - 导入建议。
 * @param options - `password` 或 `passphrase`，以及可覆盖的字段。
 * @returns 提交体。
 */
function payloadFrom(plan, { password = '', passphrase = '', ...override } = {}) {
  const draft = {
    alias: plan.alias,
    host: plan.host,
    port: plan.port,
    username: plan.username,
    shell: plan.shell,
    description: plan.description,
    tags: plan.tags,
    authType: plan.authType,
    ...override,
  }
  if (plan.authType === 'key') {
    draft.privateKeyPath = plan.privateKeyPath
    if (passphrase.length > 0) draft.passphrase = passphrase
  } else {
    draft.password = password
  }
  const payload = {}
  for (const field of SSH_VAULT_SAVE_FIELDS) {
    if (draft[field] !== undefined) payload[field] = draft[field]
  }
  return payload
}

/** 一台典型 Linux 虚拟机的视图。 */
const ENTRY = {
  name: 'Kali Linux',
  vmx: 'E:\\VMs\\kali\\kali.vmx',
  guestFamily: 'linux',
  tags: ['lab'],
}

const plan = buildSshPlan(ENTRY, { host: '192.168.234.129', defaultKeyPath: null })

await test('对方接口接受我们提交的口令认证记录', async () => {
  const { invoke, dir } = await makeVaultApi()
  const payload = payloadFrom(plan, { password: 's3cret-pass' })
  assert.deepEqual(Object.keys(payload).filter((key) => !SSH_VAULT_SAVE_FIELDS.includes(key)), [])
  const saved = await invoke('save', payload)
  assert.equal(saved.envelope?.ok, true, JSON.stringify(saved.envelope))
  assert.equal(saved.envelope.value.alias, 'kali-linux')
  assert.equal(saved.envelope.value.created, true)

  const listed = await invoke('list', {})
  assert.equal(listed.envelope.ok, true)
  const host = listed.envelope.value.hosts.find((item) => item.alias === 'kali-linux')
  assert.ok(host !== undefined, '保存后应能在列表里看到')
  assert.equal(host.port, 22)
  assert.equal(host.authType, 'password')
  assert.equal(host.hasPassword, true)
  // 对方的列表从不回传口令，也不回传完整地址——我们的界面因此不可能把它泄出去。
  assert.equal(JSON.stringify(listed.envelope).includes('s3cret-pass'), false)
  assert.equal(host.host.includes('192.168.234.129'), false)
  assert.deepEqual(host.tags, ['vmware', 'lab'])
  await rm(dir, { recursive: true, force: true })
})

await test('同名保存是更新而不是新增', async () => {
  const { invoke, dir } = await makeVaultApi()
  await invoke('save', payloadFrom(plan, { password: 'a' }))
  const second = await invoke('save', payloadFrom(plan, { password: 'b', port: 2222 }))
  assert.equal(second.envelope.ok, true)
  assert.equal(second.envelope.value.created, false)
  const listed = await invoke('list', {})
  assert.equal(listed.envelope.value.hosts.filter((host) => host.alias === 'kali-linux').length, 1)
  assert.equal(listed.envelope.value.hosts[0].port, 2222)
  await rm(dir, { recursive: true, force: true })
})

await test('私钥认证的字段形状同样被接受', async () => {
  const { invoke, dir } = await makeVaultApi()
  const keyPath = path.join('C:', 'Users', 'me', '.ssh', 'id_ed25519')
  const keyPlan = buildSshPlan(ENTRY, { host: '10.0.0.7', defaultKeyPath: keyPath })
  const saved = await invoke('save', payloadFrom(keyPlan, { passphrase: 'kf' }))
  assert.equal(saved.envelope.ok, true, JSON.stringify(saved.envelope))
  const listed = await invoke('list', {})
  const host = listed.envelope.value.hosts[0]
  assert.equal(host.authType, 'key')
  assert.equal(host.privateKeyPath, keyPath)
  await rm(dir, { recursive: true, force: true })
})

await test('未经规范化的别名会被对方拒绝（这就是 suggestAlias 存在的理由）', async () => {
  const { invoke, dir } = await makeVaultApi()
  const rejected = await invoke('save', payloadFrom(plan, { alias: '软件安全kali', password: 'x' }))
  assert.equal(rejected.envelope.ok, false)
  assert.ok(String(rejected.envelope.error.message).length > 0)
  await rm(dir, { recursive: true, force: true })
})

await test('我们生成的别名总能通过对方的校验', async () => {
  const names = ['Kali Linux', '软件安全kali Linux', '测试机', 'a', 'Ubuntu 24.04', 'win-10_x64']
  const { invoke, dir } = await makeVaultApi()
  for (const name of names) {
    const entry = { name, vmx: `E:\\VMs\\${name}\\${name}.vmx`, guestFamily: 'linux', tags: [] }
    const itemPlan = buildSshPlan(entry, { host: '10.0.0.1', defaultKeyPath: null })
    const saved = await invoke('save', payloadFrom(itemPlan, { password: 'x' }))
    assert.equal(saved.envelope.ok, true, `${name} → ${itemPlan.alias}: ${JSON.stringify(saved.envelope)}`)
  }
  await rm(dir, { recursive: true, force: true })
})

if (failures.length > 0) {
  console.error(`\n${failures.length} 个联动测试失败，${passed} 个通过`)
  process.exit(1)
}
console.log(`\n${passed} 个联动测试全部通过`)
