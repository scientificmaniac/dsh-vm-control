#!/usr/bin/env node
/**
 * 发行流程的唯一入口。
 *
 * 一次发行最容易出错的地方不是打包，而是**版本号不一致**：`package.json` 写着 1.1.0、
 * 标签打成 v1.1.1、发行说明还停在 1.0.0，三者谁也没错，但合在一起就是无法复现的产物。
 * 所以这个脚本先做一致性检查，再跑测试，最后打包并校验包内容——任何一步失败都退出非零，
 * 不带病发布。
 *
 * 用法：
 *   node scripts/release.mjs                # 检查 → 测试 → 打包 → 校验产物
 *   node scripts/release.mjs --skip-tests   # 跳过测试（仅本地快速出包时使用）
 *   node scripts/release.mjs --check-only   # 只做一致性与语法检查（CI 的第一步）
 *
 * 环境变量 `GITHUB_REF_NAME` 存在时（GitHub Actions 的 tag 构建）会额外校验标签名与
 * `package.json` 的版本是否一致——打错标签的发行版比不发还糟。
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const flags = new Set(process.argv.slice(2))
const checkOnly = flags.has('--check-only')
const skipTests = checkOnly || flags.has('--skip-tests')

const problems = []
/** 记一条失败，但不立刻退出：一次把毛病列全，比让人反复重跑要有用。 */
const fail = (message) => {
  problems.push(message)
  console.error(`  ✗ ${message}`)
}
const ok = (message) => console.log(`  ✓ ${message}`)

/**
 * 跑一条命令，继承输出；失败时记录并返回 false。
 * @param command - 可执行文件。
 * @param args - 参数。
 * @param options - `shell` 覆盖。
 * @returns 是否成功。
 */
function run(command, args, { shell = false } = {}) {
  // Windows 上的 `npm` 是 .cmd，必须经 shell 起；而 `shell: true` 配参数数组会触发
  // DEP0190，所以那条路径把命令拼成一个字符串交给 shell。
  //
  // 拼字符串就必须自己处理引号：本仓库路径里带空格（`E:\ai project\...`），不引的话
  // `--pack-destination` 会被切成两段，npm 会把 `E:\ai` 当成参数、把剩下的当成目录，
  // 报出的错还指向一个根本不存在的路径。
  const quote = (value) => (/[\s"]/.test(value) ? `"${String(value).replace(/"/g, '""')}"` : value)
  const result = shell
    ? spawnSync([command, ...args].map(quote).join(' '), { cwd: ROOT, stdio: 'inherit', shell: true })
    : spawnSync(command, args, { cwd: ROOT, stdio: 'inherit' })
  if (result.error !== undefined) {
    fail(`${command} 无法执行：${result.error.message}`)
    return false
  }
  if (result.status !== 0) {
    fail(`${command} ${args.join(' ')} 退出码 ${result.status}`)
    return false
  }
  return true
}

console.log('dsh-vm-control · 发行检查\n')

// —— 1. 版本一致性 ——

console.log('1. 版本一致性')
const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'))
const version = String(pkg.version ?? '')
const tag = `v${version}`
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) fail(`package.json 的版本号不是 semver：${version}`)
else ok(`package.json: ${version}`)

for (const file of ['CHANGELOG.md', 'CHANGELOG.zh-CN.md']) {
  const text = await readFile(path.join(ROOT, file), 'utf8')
  const pattern = new RegExp(`^## \\[${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`, 'm')
  if (!pattern.test(text)) fail(`${file} 缺少「## [${version}]」小节`)
  else ok(`${file} 含 ${version} 条目`)
}

const notesPath = path.join(ROOT, 'RELEASE_NOTES', `${tag}.md`)
if (!existsSync(notesPath)) fail(`缺少发行说明 RELEASE_NOTES/${tag}.md`)
else ok(`RELEASE_NOTES/${tag}.md`)

const refName = process.env.GITHUB_REF_NAME ?? ''
if (refName.startsWith('v')) {
  if (refName !== tag) fail(`标签 ${refName} 与 package.json 的 ${tag} 不一致`)
  else ok(`标签 ${refName} 与版本一致`)
}

// —— 2. 语法检查 ——

console.log('\n2. 语法检查')
const libFiles = (await readdir(path.join(ROOT, 'lib'), { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
  .map((entry) => `lib/${entry.name}`)
const modules = ['index.js', 'client.js', ...libFiles, 'lib/locales/vm.js', 'scripts/release.mjs']
let syntaxOk = true
for (const file of modules) {
  const result = spawnSync(process.execPath, ['--check', path.join(ROOT, file)], { stdio: 'pipe' })
  if (result.status !== 0) {
    syntaxOk = false
    fail(`${file} 语法检查失败：${String(result.stderr ?? '').split('\n')[0]}`)
  }
}
if (syntaxOk) ok(`${modules.length} 个模块通过 node --check`)

if (problems.length > 0) {
  console.error(`\n${problems.length} 项检查未通过，发行中止。`)
  process.exit(1)
}

if (checkOnly) {
  console.log('\n检查通过（--check-only：未运行测试、未打包）。')
  process.exit(0)
}

// —— 3. 测试 ——

if (skipTests) {
  console.log('\n3. 测试\n  - 已跳过（--skip-tests）')
} else {
  console.log('\n3. 测试')
  // 用 package.json 里的 test 脚本，避免这里的清单与实际测试脱节。
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  if (!run(npm, ['test'], { shell: process.platform === 'win32' })) {
    console.error('\n测试未通过，发行中止。')
    process.exit(1)
  }
}

// —— 4. 打包 ——

console.log('\n4. 打包')
const distDir = path.join(ROOT, 'dist')
await rm(distDir, { recursive: true, force: true })
await mkdir(distDir, { recursive: true })
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
if (!run(npm, ['pack', '--pack-destination', distDir], { shell: process.platform === 'win32' })) {
  console.error('\n打包失败，发行中止。')
  process.exit(1)
}

const produced = (await readdir(distDir)).filter((file) => file.endsWith('.tgz'))
const expected = `${pkg.name}-${version}.tgz`
if (!produced.includes(expected)) {
  console.error(`\n未找到预期产物 ${expected}，实际：${produced.join(', ') || '(空)'}`)
  process.exit(1)
}
if (produced.length > 1) fail(`dist 里有多余的产物：${produced.filter((file) => file !== expected).join(', ')}`)

const artifact = path.join(distDir, expected)
const bytes = await readFile(artifact)
const sha256 = createHash('sha256').update(bytes).digest('hex')
const sizeKb = (bytes.length / 1024).toFixed(1)
await writeFile(path.join(distDir, 'SHA256SUMS.txt'), `${sha256}  ${expected}\n`, 'utf8')
ok(`${expected}（${sizeKb} KB）`)
ok(`sha256 ${sha256}`)

// —— 5. 产物校验 ——

console.log('\n5. 产物校验')
const listing = spawnSync('tar', ['-tzf', artifact], { cwd: ROOT, encoding: 'utf8' })
if (listing.status !== 0) {
  fail(`无法列出包内容（tar ${listing.status}）：${String(listing.stderr ?? '').slice(0, 200)}`)
} else {
  const entries = String(listing.stdout).split(/\r?\n/).filter((line) => line.length > 0)
  const required = [
    'package/package.json',
    'package/index.js',
    'package/client.js',
    'package/lib/ssh-import.js',
    'package/lib/locales/vm.js',
    'package/locale/zh.json',
    'package/cordis.patch.yml',
    'package/dsh-market-entry.yml',
    'package/README.md',
    'package/README.zh-CN.md',
    'package/LICENSE',
  ]
  for (const entry of required) {
    if (!entries.includes(entry)) fail(`发行包里缺少 ${entry}`)
  }
  const forbidden = entries.filter((entry) => /^package\/(test|node_modules|\.github|\.git|dist)\//.test(entry) || entry.endsWith('.tgz'))
  if (forbidden.length > 0) fail(`发行包里不该出现：${forbidden.slice(0, 5).join(', ')}`)
  if (problems.length === 0) ok(`${entries.length} 个条目，必需文件齐全且没有测试/构建残留`)
}

if (problems.length > 0) {
  console.error(`\n${problems.length} 项检查未通过，发行中止（产物保留在 dist/ 供排查）。`)
  process.exit(1)
}

console.log(`\n发行包就绪：dist/${expected}`)
console.log(`  版本   ${version}`)
console.log(`  说明   RELEASE_NOTES/${tag}.md`)
console.log(`  大小   ${sizeKb} KB`)
console.log(`  校验   dist/SHA256SUMS.txt`)
console.log('\n下一步（推送后 GitHub Actions 会用同一份产物创建发行版）：')
console.log('  git push origin main')
console.log(`  git push origin ${tag}`)
