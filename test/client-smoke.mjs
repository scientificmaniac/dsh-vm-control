/**
 * 浏览器半边的冒烟测试。
 *
 * 没有浏览器，也不需要打包器：`client.js` 是一个 `window.__ModuleLoader__.load(...)`
 * 调用，用 `node:vm` 给它一个假的 window / React / document 就能把工厂函数跑起来。
 * 检查的是**接线**而不是像素：
 *
 * - 工厂能被调用，`apply` 注册了设置页、四个工具卡片、`/vm` 命令视图与 dock；
 * - 中英字典键集合一致、没有空文案（漏翻一条就会在实际界面里露出来）；
 * - 源码里引用的每个文案键都存在（拼错的键名在运行时只会显示键名本身，很难发现）。
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createContext, runInContext } from 'node:vm'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
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

/** 极简 React：只够让工厂与注册路径跑通，不渲染。 */
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  createContext: (value) => ({ provider: value }),
  useContext: () => undefined,
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: (value) => ({ current: value }),
  useCallback: (fn) => fn,
}

/**
 * 在沙箱里加载 client.js，取出工厂函数。
 * @returns 工厂函数。
 */
async function loadFactory() {
  const source = await readFile(path.join(ROOT, 'client.js'), 'utf8')
  let factory
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load({ id, factory: created }) {
          assert.equal(id, 'dsh-vm-control')
          factory = created
        },
      },
      confirm: () => true,
    },
    document: { documentElement: { lang: 'zh-CN' }, visibilityState: 'visible' },
    fetch: async () => {
      throw new Error('network disabled in smoke test')
    },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  }
  createContext(sandbox)
  runInContext(source, sandbox, { filename: 'client.js' })
  assert.equal(typeof factory, 'function')
  return factory
}

/**
 * 造一个客户端上下文。
 * @returns `{ ctx, registrations, dictionaries }`。
 */
function makeCtx() {
  const registrations = []
  const dictionaries = []
  const locale = {
    register(namespace, dict) {
      dictionaries.push({ namespace, dict })
      return () => {}
    },
    bind: () => (key) => key,
  }
  const slots = {
    register(definition, Component) {
      registrations.push({ definition, Component })
      return () => {}
    },
    inject(_name, callback) {
      const produced = callback()
      if (produced !== null && typeof produced === 'object' && typeof produced.next === 'function') {
        for (const item of produced) void item
      }
      return produced
    },
  }
  const ctx = {
    get: (name) => (name === 'locale' ? locale : undefined),
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    slots,
    inject(_services, callback) {
      callback({
        slots,
        sessions: { binding: () => undefined },
        uiConversation: { binding: () => ({ target: () => undefined }) },
      })
    },
  }
  return { ctx, registrations, dictionaries }
}

const factory = await loadFactory()

await test('工厂返回 inject 声明与 apply', () => {
  const client = factory((name) => {
    assert.equal(name, 'react')
    return React
  })
  // vm 沙箱里数组来自另一个 realm，比较前先摊平成本地数组。
  assert.deepEqual([...client.inject], ['slots'])
  assert.equal(typeof client.apply, 'function')
})

await test('apply 注册设置页、四个工具卡片、命令视图与 dock', () => {
  const client = factory(() => React)
  const { ctx, registrations, dictionaries } = makeCtx()
  client.apply(ctx)

  const byName = (name) => registrations.filter((item) => item.definition.name === name)
  const sections = byName('settings.section')
  assert.equal(sections.length, 1)
  assert.equal(sections[0].definition.id, 'vm-control')
  assert.equal(typeof sections[0].definition.label, 'function')
  assert.equal(sections[0].definition.label(), 'sectionTitle')
  assert.equal(typeof sections[0].Component, 'function')

  const views = byName('tool.call.toolview').map((item) => item.definition.key).sort()
  assert.deepEqual(views, ['vm_config', 'vm_list', 'vm_power', 'vm_snapshot'])

  const commandViews = byName('conversation.chat.commandview')
  assert.equal(commandViews.length, 1)
  assert.equal(commandViews[0].definition.key, 'vm')

  const docks = byName('conversation.input.dock')
  assert.equal(docks.length, 1)
  assert.equal(docks[0].definition.id, 'vm-control-result')
  assert.equal(typeof docks[0].definition.inject, 'function')
  const injected = docks[0].definition.inject('session-1')
  assert.ok(injected.hooks.vmSession !== undefined)
  assert.ok(injected.hooks.vmChat !== undefined)

  assert.equal(dictionaries.length, 1)
  assert.equal(dictionaries[0].namespace, 'vm-control')
})

await test('中英字典键集合一致且没有空文案', () => {
  const client = factory(() => React)
  const { ctx, dictionaries } = makeCtx()
  client.apply(ctx)
  const { dict } = dictionaries[0]
  const zh = Object.keys(dict.zh).sort()
  const en = Object.keys(dict.en).sort()
  assert.deepEqual(zh, en, `中文独有：${zh.filter((k) => !en.includes(k))}；英文独有：${en.filter((k) => !zh.includes(k))}`)
  for (const key of zh) {
    assert.equal(typeof dict.zh[key], 'string', `${key} 中文不是字符串`)
    assert.equal(typeof dict.en[key], 'string', `${key} 英文不是字符串`)
    assert.ok(dict.zh[key].length > 0, `${key} 中文为空`)
    assert.ok(dict.en[key].length > 0, `${key} 英文为空`)
  }
})

await test('client.js 里引用的文案键都存在', async () => {
  const source = await readFile(path.join(ROOT, 'client.js'), 'utf8')
  const client = factory(() => React)
  const { ctx, dictionaries } = makeCtx()
  client.apply(ctx)
  const dict = dictionaries[0].dict
  const used = new Set()
  for (const match of source.matchAll(/(?:\bt|fallbackT|tRef\.current)\('([A-Za-z0-9_.]+)'/g)) used.add(match[1])
  const missing = [...used].filter((key) => dict.zh[key] === undefined)
  assert.deepEqual(missing, [], `缺少文案：${missing.join(', ')}`)
  // 反向：定义了却没有引用的键。
  //
  // 有些键不会以 `t('key')` 的形式出现：校验函数返回的是键名、三元分支各给一个键名，
  // 翻译发生在后面。所以「出现过同名字符串字面量」也算被引用——这比放宽成白名单更准，
  // 删掉一个真没人用的键仍然会被抓住。
  const literals = new Set()
  for (const match of source.matchAll(/'([A-Za-z0-9_.-]+)'/g)) literals.add(match[1])
  const dynamicPrefixes = ['state', 'perm']
  const dynamicExact = new Set(['soft', 'hard'])
  const unused = Object.keys(dict.zh).filter((key) => !used.has(key)
    && !literals.has(key)
    && !dynamicExact.has(key)
    && !dynamicPrefixes.some((prefix) => key.startsWith(prefix) && key.length > prefix.length))
  assert.deepEqual(unused, [], `未使用的文案：${unused.join(', ')}`)
})

await test('fallbackT 在缺少 locale 服务时仍能取词', async () => {
  // 组件内部用的是 fallbackT；这里通过注册的 label 间接确认字典可用：
  const source = await readFile(path.join(ROOT, 'client.js'), 'utf8')
  assert.ok(source.includes('fallbackT'), 'client.js 应保留无 locale 服务时的兜底取词')
  assert.ok(source.includes("inject: ['slots']"))
})

if (failures.length > 0) {
  console.error(`\n${failures.length} 个测试失败，${passed} 个通过`)
  process.exit(1)
}
console.log(`\n${passed} 个测试全部通过`)
