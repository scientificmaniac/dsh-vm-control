/**
 * 虚拟机资源占用采集。
 *
 * VMware 的 `vmrun` 不提供任何性能计数器——它只会开关机、拍快照、跑客户机命令。
 * 「这台虚拟机现在吃多少 CPU / 内存」只能从宿主侧拿：每台运行中的虚拟机对应一个
 * `vmware-vmx` 进程，该进程的命令行里带着它服务的 vmx 路径，于是「进程 → 虚拟机」
 * 的映射是确定的，不需要去猜 PID。
 *
 * 两条实现：
 * - Windows 用 PowerShell 一次问完 `Win32_Process`（命令行）与
 *   `Win32_PerfFormattedData_PerfProc_Process`（CPU 百分比、工作集、线程数、IO）。
 *   两次快照各问一次是最准的，但代价太高；格式化后的性能计数器本身就是一次采样，
 *   对「看一眼现在多少」足够。
 * - macOS / Linux 退回 `ps`：只有 CPU 百分比与 RSS，没有 IO 细分。这不是缺陷，
 *   而是那些平台上没有等价物；缺的字段留空，界面按「不可用」展示。
 *
 * 采集失败永远不抛错：资源占用是锦上添花，不能让整个虚拟机列表因为一次计数器读取
 * 失败而消失。
 *
 * @module dsh-vm-control/metrics
 */

import path from 'node:path'
import { runProcess } from './vmrun.js'

/** 采集超时：PowerShell 启动本身要几百毫秒，几秒足够。 */
const COLLECT_TIMEOUT_MS = 20000

/**
 * Windows 侧的一次性采集脚本。
 *
 * 输出统一是 JSON 数组；空数组也要输出，否则「没有运行中的虚拟机」与「采集失败」
 * 在结果里就分不开了。
 */
const WINDOWS_SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue'",
  '$cores=[Environment]::ProcessorCount',
  '$perf=@{}',
  "foreach($p in @(Get-CimInstance -ClassName Win32_PerfFormattedData_PerfProc_Process -Filter \"Name LIKE 'vmware-vmx%'\")){ if($p.IDProcess){ $perf[[int]$p.IDProcess]=$p } }",
  '$rows=New-Object System.Collections.ArrayList',
  "foreach($p in @(Get-CimInstance -ClassName Win32_Process -Filter \"Name='vmware-vmx.exe'\")){",
  '  $m=$perf[[int]$p.ProcessId]',
  '  $row=[ordered]@{}',
  '  $row.pid=[int]$p.ProcessId',
  '  $row.cmdline=[string]$p.CommandLine',
  '  if($m -ne $null){',
  '    $row.cpuPercent=[math]::Round(([double]$m.PercentProcessorTime)/[math]::Max(1,$cores),2)',
  '    $row.cpuPercentRaw=[double]$m.PercentProcessorTime',
  '    $row.workingSetBytes=[double]$m.WorkingSet',
  '    $row.privateBytes=[double]$m.PrivateBytes',
  '    $row.threads=[int]$m.ThreadCount',
  '    $row.ioReadBytesPerSecond=[double]$m.IOReadBytesPersec',
  '    $row.ioWriteBytesPerSecond=[double]$m.IOWriteBytesPersec',
  '    $row.elapsedSeconds=[double]$m.ElapsedTime',
  '  } else {',
  '    $row.cpuPercent=0; $row.cpuPercentRaw=0',
  '    $row.workingSetBytes=[double]$p.WorkingSetSize; $row.privateBytes=0; $row.threads=0',
  '    $row.ioReadBytesPerSecond=0; $row.ioWriteBytesPerSecond=0; $row.elapsedSeconds=0',
  '  }',
  '  [void]$rows.Add([pscustomobject]$row)',
  '}',
  '$out=@($rows)',
  'if($out.Count -eq 0){ \'[]\' } else { ConvertTo-Json -InputObject $out -Compress -Depth 3 }',
].join('\n')

/**
 * 从 `vmware-vmx` 的命令行里取出它服务的 vmx 路径。
 *
 * 形如：
 * `"C:\Program Files (x86)\VMware\VMware Workstation\x64\vmware-vmx.exe" -s "E:\VMs\Kali\Kali.vmx" -m "..."`
 * 以及 Linux 上的 `/usr/lib/vmware/bin/vmware-vmx -s "/vms/kali.vmx" ...`。
 * 取引号里第一个以 .vmx 结尾的片段；没有引号时退回按空白切分找后缀。
 *
 * @param cmdline - 进程命令行。
 * @returns 绝对路径；识别不出时为 undefined。
 */
export function vmxFromCommandLine(cmdline) {
  const text = String(cmdline ?? '')
  if (text.length === 0) return undefined
  const quoted = /"([^"]*\.vmx)"/i.exec(text)
  if (quoted !== null) return quoted[1]
  for (const token of text.split(/\s+/)) {
    if (/\.vmx$/i.test(token)) return token.replace(/^["']|["']$/g, '')
  }
  return undefined
}

/**
 * 把一条进程记录整理成占用对象。
 * @param raw - PowerShell / ps 输出的原始记录。
 * @param vmx - 解析出的 vmx 路径。
 * @returns 归一化的占用对象；vmx 识别不出时返回 undefined。
 */
function toSample(raw, vmx) {
  if (vmx === undefined) return undefined
  return {
    vmx: path.resolve(vmx),
    pid: Number(raw.pid),
    cpuPercent: Number.isFinite(raw.cpuPercent) ? raw.cpuPercent : 0,
    cpuPercentRaw: Number.isFinite(raw.cpuPercentRaw) ? raw.cpuPercentRaw : 0,
    workingSetBytes: Number.isFinite(raw.workingSetBytes) ? raw.workingSetBytes : 0,
    privateBytes: Number.isFinite(raw.privateBytes) ? raw.privateBytes : 0,
    threads: Number.isFinite(raw.threads) ? raw.threads : 0,
    ioReadBytesPerSecond: Number.isFinite(raw.ioReadBytesPerSecond) ? raw.ioReadBytesPerSecond : 0,
    ioWriteBytesPerSecond: Number.isFinite(raw.ioWriteBytesPerSecond) ? raw.ioWriteBytesPerSecond : 0,
    elapsedSeconds: Number.isFinite(raw.elapsedSeconds) ? raw.elapsedSeconds : 0,
  }
}

/**
 * 把进程样本数组整理成「vmx 小写路径 → 占用」的映射。
 *
 * 同一台虚拟机的多个 vmx 进程（例如开了多个窗口）只会保留最大的那个：卡片上要的是
 * 「这台虚拟机占多少」，不是「有几个进程」。
 *
 * @param samples - 进程样本数组。
 * @returns Map。
 */
export function indexSamples(samples) {
  const map = new Map()
  for (const sample of samples) {
    if (sample === undefined) continue
    const key = sample.vmx.toLowerCase()
    const previous = map.get(key)
    if (previous === undefined || sample.workingSetBytes > previous.workingSetBytes) map.set(key, sample)
  }
  return map
}

/**
 * Windows 侧采集。
 * @returns `{ ok, samples, cores, error }`。
 */
async function collectWindows() {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
  const exe = process.env.DSH_VM_CONTROL_POWERSHELL
    ?? path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const result = await runProcess(exe, ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_SCRIPT], {
    timeoutMs: COLLECT_TIMEOUT_MS,
  })
  if (result.timedOut === true || result.aborted === true) return { ok: false, samples: [], error: 'timeout' }
  const text = result.stdout.trim()
  if (text.length === 0) {
    // 空输出既可能是「没有 vmware-vmx 进程」，也可能是脚本执行失败；stderr 有内容就按失败处理。
    if (result.code === 0) return { ok: true, samples: [] }
    return { ok: false, samples: [], error: result.stderr.trim() || 'no output' }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, samples: [], error: 'unparsable output' }
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  const samples = rows
    .map((row) => toSample({
      pid: Number(row.pid),
      cpuPercent: Number(row.cpuPercent),
      cpuPercentRaw: Number(row.cpuPercentRaw),
      workingSetBytes: Number(row.workingSetBytes),
      privateBytes: Number(row.privateBytes),
      threads: Number(row.threads),
      ioReadBytesPerSecond: Number(row.ioReadBytesPerSecond),
      ioWriteBytesPerSecond: Number(row.ioWriteBytesPerSecond),
      elapsedSeconds: Number(row.elapsedSeconds),
    }, vmxFromCommandLine(row.cmdline)))
    .filter((sample) => sample !== undefined)
  return {
    ok: true,
    samples,
    cores: Number.parseInt(process.env.NUMBER_OF_PROCESSORS ?? '', 10) || undefined,
  }
}

/**
 * macOS / Linux 侧采集：`ps` 只有 CPU 与 RSS。
 * @returns `{ ok, samples, error }`。
 */
async function collectPosix() {
  const result = await runProcess('ps', ['-eo', 'pid=,pcpu=,rss=,args='], { timeoutMs: COLLECT_TIMEOUT_MS })
  if (result.code !== 0 || result.timedOut === true) {
    return { ok: false, samples: [], error: result.stderr.trim() || 'ps failed' }
  }
  const samples = []
  for (const line of result.stdout.split(/\r?\n/)) {
    const text = line.trim()
    if (text.length === 0) continue
    if (!/vmware-vmx/i.test(text)) continue
    const match = /^(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/.exec(text)
    if (match === null) continue
    const vmx = vmxFromCommandLine(match[4])
    if (vmx === undefined) continue
    samples.push({
      vmx: path.resolve(vmx),
      pid: Number(match[1]),
      cpuPercent: Number(match[2]),
      cpuPercentRaw: Number(match[2]),
      // ps 的 rss 单位是 KB。
      workingSetBytes: Number(match[3]) * 1024,
      privateBytes: 0,
      threads: 0,
      ioReadBytesPerSecond: 0,
      ioWriteBytesPerSecond: 0,
      elapsedSeconds: 0,
    })
  }
  return { ok: true, samples }
}

/**
 * 采集当前宿主上所有运行中虚拟机的资源占用。
 *
 * @param options - 平台覆盖（测试用）。
 * @returns `{ ok, samples, error }`；失败时 `samples` 是空数组，`ok` 为 false。
 */
export async function collectProcessMetrics({ platform = process.platform } = {}) {
  try {
    const result = await (platform === 'win32' ? collectWindows() : collectPosix())
    return { ...result, at: Date.now() }
  } catch (error) {
    return { ok: false, samples: [], error: error instanceof Error ? error.message : String(error), at: Date.now() }
  }
}

/**
 * 把字节数格式化成人类可读的短形式。
 * @param bytes - 字节数。
 * @returns 形如 `2.1 GB` 的文本；无效输入返回 `—`。
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[index]}`
}
