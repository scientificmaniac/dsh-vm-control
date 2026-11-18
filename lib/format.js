/**
 * 把虚拟机数据渲染成文本。
 *
 * 同一份事实有两个读者：模型（工具结果）和用户（设置页、`/vm` 命令）。两边必须说法一致，
 * 否则「模型说它已停止、界面说它在运行」这类矛盾会把人拖进无谓的排查。因此所有面向文本的
 * 措辞都集中在这里，界面只负责把同样的字段排成卡片。
 *
 * 输出遵循 SSH 保险库插件已经确立的格式约定：首行给结论（含数量与来源），其下每台虚拟机
 * 一条主行 + 缩进的补充行，失败追加归因与修复方向。
 *
 * @module dsh-vm-control/format
 */

import { t } from './i18n.js'
import { formatBytes } from './metrics.js'
import { POWER_ACTIONS, productKeyFor } from './vmrun.js'

/**
 * 状态词。
 * @param state - `running` / `paused` / `suspended` / `stopped` / `missing` / `unknown`。
 * @returns 当前语言的标签。
 */
export function stateLabel(state) {
  const key = `vm.state.${state}`
  const label = t(key)
  return label === key ? t('vm.state.unknown') : label
}

/**
 * 统计各状态的数量。
 * @param entries - 虚拟机视图数组。
 * @returns `{ running, paused, suspended, stopped, missing }`。
 */
export function countStates(entries) {
  const counts = { running: 0, paused: 0, suspended: 0, stopped: 0, missing: 0 }
  for (const entry of entries) {
    if (counts[entry.state] === undefined) counts.stopped += 1
    else counts[entry.state] += 1
  }
  return counts
}

/**
 * 一台虚拟机的简短摘要行（不含缩进补充）。
 * @param entry - 虚拟机视图。
 * @returns 形如 `- Kali Linux  [运行中]  8 vCPU / 4096 MB` 的文本。
 */
export function entrySummary(entry) {
  return t('vm.line', {
    name: entry.name,
    state: stateLabel(entry.state),
    cpus: entry.cpus,
    memory: entry.memoryMB,
    resource: '',
    network: '',
  }).replace(/\s+$/, '')
}

/**
 * 渲染资源占用行。
 * @param entry - 虚拟机视图。
 * @returns 文本行；没有占用数据时为空串。
 */
export function resourceLine(entry) {
  const resources = entry.resources
  if (resources === undefined) return ''
  const cpu = Number.isFinite(resources.cpuPercent) ? resources.cpuPercent.toFixed(1) : '0.0'
  const rss = formatBytes(resources.workingSetBytes)
  const threads = resources.threads
  return threads > 0
    ? t('vm.resourceAllocated', { cpu, rss, memory: entry.memoryMB, threads })
    : t('vm.resourceAllocatedNoThreads', { cpu, rss, memory: entry.memoryMB })
}

/**
 * 渲染网卡行。
 * @param entry - 虚拟机视图。
 * @returns 每个网卡一行；没有网卡时为空数组。
 */
export function networkLines(entry) {
  if (!Array.isArray(entry.nics) || entry.nics.length === 0) return []
  return entry.nics.map((nic) => t('vm.nicLine', {
    index: nic.index,
    mode: nic.connectionType,
    network: nic.networkName.length > 0 ? ` ${nic.networkName}` : '',
    dev: nic.virtualDev.length > 0 ? nic.virtualDev : '—',
    mac: nic.mac.length > 0 ? nic.mac : '—',
    connected: nic.startConnected === true ? t('vm.nicConnected') : '',
  }))
}

/**
 * 磁盘行里的文件名，光驱加一个标注。
 *
 * `ide0:0 → auto detect` 本身没有信息量；标出它是光驱，读者才知道为什么这一行的目标
 * 不是一个 vmdk。
 *
 * @param disk - 磁盘对象。
 * @returns 展示用文件名。
 */
function diskTarget(disk) {
  const file = String(disk.fileName ?? '')
  return disk.kind === 'cdrom' ? `${file} (${t('vm.diskKindCdrom')})` : file
}

/**
 * 渲染一台虚拟机的补充行（占用、网络、路径、备注）。
 * @param entry - 虚拟机视图。
 * @param options - `showPath` 是否给 vmx 路径，`showDisks` 是否展开磁盘。
 * @returns 文本行数组。
 */
export function entryDetailLines(entry, { showPath = false, showDisks = false } = {}) {
  const lines = []
  if (entry.state === 'missing') {
    lines.push(t('vm.pathLine', { path: entry.vmx }))
    return lines
  }
  const resources = resourceLine(entry)
  if (resources.length > 0) lines.push(resources)
  lines.push(...networkLines(entry))
  if (showDisks === true && Array.isArray(entry.disks)) {
    for (const disk of entry.disks) lines.push(t('vm.diskLine', { device: disk.device, file: diskTarget(disk) }))
  }
  if (showPath === true) lines.push(t('vm.pathLine', { path: entry.vmx }))
  if (entry.notes.length > 0) lines.push(t('vm.notesLine', { notes: entry.notes }))
  if (Array.isArray(entry.tags) && entry.tags.length > 0) lines.push(t('vm.tagsLine', { tags: entry.tags.join(', ') }))
  return lines
}

/**
 * 渲染 `vm_list` 的完整结果。
 *
 * @param result - `Inventory.list` 的返回值。
 * @param options - `limit` 最多列几台，`showPaths` 是否总给路径。
 * @returns 面向模型 / 对话的文本。
 */
export function renderList(result, { limit = 40, showPaths = false } = {}) {
  const entries = Array.isArray(result.entries) ? result.entries : []
  const probe = result.vmrun ?? { found: false, hostType: 'unknown', version: '' }
  const counts = countStates(entries)
  const product = t(productKeyFor(probe.hostType))
  const lines = []
  if (probe.found !== true) {
    lines.push(t('vm.listHeaderNoVms', { product, version: '—', hostType: '—' }))
    lines.push(t('vm.vmrunMissing'))
  } else if (entries.length === 0) {
    lines.push(t('vm.listHeaderNoVms', {
      product,
      version: probe.version.length > 0 ? probe.version : '—',
      hostType: probe.hostType ?? t('vm.typeMissing'),
    }))
    lines.push(t('vm.noRoots'))
  } else {
    lines.push(t('vm.listHeader', {
      product,
      version: probe.version.length > 0 ? probe.version : '—',
      hostType: probe.hostType ?? t('vm.typeMissing'),
      count: entries.length,
      running: counts.running,
      paused: counts.paused,
      suspended: counts.suspended,
      stopped: counts.stopped + counts.missing,
    }))
  }

  if (result.runningOk === false) {
    lines.push(t('vm.stateWarning', { reason: t('vm.stateWarningStale') }))
  }
  if (result.metricsOk === false) {
    lines.push(t('vm.metricsUnavailable', { error: String(result.metricsError ?? '—') }))
  }
  for (const note of result.notes ?? []) {
    if (note.kind === 'root-missing') lines.push(t('vm.rootMissing', { path: note.path }))
    if (note.kind === 'scan-truncated') lines.push(t('vm.scanTruncated', { path: note.path, n: note.depth }))
  }

  // 同名的虚拟机必须带路径，否则调用方无法区分；其余按需。
  const duplicates = new Set()
  const seen = new Map()
  for (const entry of entries) {
    const key = entry.name.toLowerCase()
    seen.set(key, (seen.get(key) ?? 0) + 1)
    if (seen.get(key) > 1) duplicates.add(key)
  }

  const shown = entries.slice(0, Math.max(1, limit))
  for (const entry of shown) {
    lines.push(entrySummary(entry))
    const showPath = showPaths === true || duplicates.has(entry.name.toLowerCase()) || entry.missing === true
    lines.push(...entryDetailLines(entry, { showPath }))
  }
  if (entries.length > shown.length) lines.push(t('vm.moreVms', { n: entries.length - shown.length }))
  return lines.filter((line) => line.length > 0).join('\n')
}

/**
 * 渲染单台虚拟机的详情。
 * @param entry - 视图（可带 `snapshots`）。
 * @returns 文本。
 */
export function renderDetail(entry) {
  const lines = [entrySummary(entry), t('vm.pathLine', { path: entry.vmx })]
  lines.push(t('vm.configLine', { key: t('vm.field.state'), value: stateLabel(entry.state) }))
  if (entry.state !== 'missing') {
    lines.push(t('vm.configLine', { key: t('vm.field.guestOs'), value: `${entry.guestOS || '—'} (${entry.guestFamily})` }))
    lines.push(t('vm.configLine', {
      key: t('vm.field.cpu'),
      value: t('vm.cpuDetail', { cpus: entry.cpus, sockets: entry.sockets, cores: entry.coresPerSocket }),
    }))
    lines.push(t('vm.configLine', {
      key: t('vm.field.memory'),
      value: `${entry.memoryMB} MB${entry.resources ? ` · ${formatBytes(entry.resources.workingSetBytes)} RSS` : ''}`,
    }))
    lines.push(t('vm.configLine', {
      key: t('vm.field.hw'),
      value: `${entry.hwVersion || '—'} · ${t('vm.field.firmware')} ${entry.firmware}`,
    }))
    lines.push(t('vm.configLine', {
      key: t('vm.field.tools'),
      value: `${entry.toolsSyncTime ? 'syncTime=TRUE' : 'syncTime=FALSE'}${entry.encrypted ? ` · ${t('vm.field.encrypted')} ${t('vm.field.yes')}` : ''}`,
    }))
    lines.push(t('vm.configLine', { key: t('vm.field.folder'), value: entry.folder }))
    lines.push(...networkLines(entry))
    if (Array.isArray(entry.disks) && entry.disks.length > 0) {
      for (const disk of entry.disks) lines.push(t('vm.diskLine', { device: disk.device, file: diskTarget(disk) }))
    }
    if (entry.resources !== undefined) {
      const io = entry.resources.ioReadBytesPerSecond > 0 || entry.resources.ioWriteBytesPerSecond > 0
        ? ` · io ${formatBytes(entry.resources.ioReadBytesPerSecond)}/s r, ${formatBytes(entry.resources.ioWriteBytesPerSecond)}/s w`
        : ''
      lines.push(`${resourceLine(entry)}${io}`)
    }
    if (entry.guest !== undefined) {
      lines.push(t('vm.guestLine', {
        tools: entry.guest.tools.length > 0 ? entry.guest.tools : '—',
        ip: entry.guest.ip.length > 0 ? ` · ip ${entry.guest.ip}` : '',
      }))
      // Tools 没就绪时 IP 一定拿不到：这是常态而不是错误，但要让人知道为什么那一栏是空的。
      if (entry.guest.available !== true) lines.push(t('vm.guestUnavailable'))
    }
    if (entry.notes.length > 0) lines.push(t('vm.notesLine', { notes: entry.notes }))
    if (Array.isArray(entry.tags) && entry.tags.length > 0) lines.push(t('vm.tagsLine', { tags: entry.tags.join(', ') }))
  }
  if (Array.isArray(entry.snapshots)) {
    lines.push(renderSnapshots(entry, entry.snapshots))
  }
  return lines.filter((line) => line.length > 0).join('\n')
}

/**
 * 渲染快照列表。
 * @param entry - 虚拟机视图（用于名字）。
 * @param snapshots - 快照数组。
 * @returns 文本。
 */
export function renderSnapshots(entry, snapshots) {
  if (!Array.isArray(snapshots) || snapshots.length === 0) return t('vm.snapshotsNone')
  const lines = [t('vm.snapshotsHeader', { count: snapshots.length })]
  for (const snapshot of snapshots) {
    lines.push(t('vm.snapshotLine', {
      name: snapshot.name,
      current: snapshot.current === true ? t('vm.snapshotCurrent') : '',
      depth: snapshot.depth > 0 ? t('vm.snapshotDepth', { n: snapshot.depth }) : '',
      note: snapshot.note !== undefined && snapshot.note.length > 0 ? t('vm.snapshotNote', { note: snapshot.note }) : '',
      created: snapshot.createdAt !== undefined && snapshot.createdAt.length > 0
        ? t('vm.snapshotCreatedAt', { at: String(snapshot.createdAt).slice(0, 19).replace('T', ' ') })
        : '',
    }))
  }
  return lines.join('\n')
}

/**
 * 渲染一次电源操作的结果。
 * @param outcome - `Inventory.power` 的返回值。
 * @param options - `describeFailure` 用于把 vmrun 失败翻成多行文本。
 * @returns 文本。
 */
export function renderPowerOutcome(outcome, { describeFailure } = {}) {
  const name = outcome.entry?.name ?? ''
  const action = outcome.action
  if (outcome.reason === 'status') {
    return renderDetail(outcome.entry)
  }
  if (outcome.reason === 'state') {
    return t('vm.powerAlready', { name, state: stateLabel(outcome.from), action })
  }
  if (outcome.reason === 'vmrun') {
    const head = t('vm.powerFailed', { name, action })
    const detail = typeof describeFailure === 'function' && outcome.result !== undefined
      ? describeFailure(outcome.result)
      : ''
    return [head, detail].filter((line) => line.length > 0).join('\n')
  }
  const lines = [t('vm.powerDone', { name, from: stateLabel(outcome.from), to: stateLabel(outcome.to), action })]
  // 命令本身没拿到干净返回（超时或被取消），结论完全来自事后状态。这不是失败，
  // 但必须说清楚：读者要能分辨「vmrun 说了成功」和「我看状态看到它是成功的」。
  if (outcome.indeterminate === true) {
    lines.push(t('vm.powerIssuedThenConfirmed', { action }))
  }
  if (outcome.reason === 'unconfirmed') {
    // 「没确认」和「失败」是两件事，必须分开说：工具确实把命令发出去了，只是没在时限内
    // 看到状态变化。写成「仍是 X」会把读者推向「重试」，而正确动作是「先读一次真实状态」。
    lines.push(t('vm.powerIssuedUnconfirmed', {
      facts: t('vm.powerFacts', {
        from: stateLabel(outcome.from),
        to: stateLabel(outcome.to),
        ms: outcome.timeoutMs ?? 0,
      }),
    }))
  }
  if (Array.isArray(outcome.notes) && outcome.notes.includes('start-gui')) lines.push(t('vm.startGuiHint'))
  else if (action === 'start' && outcome.reason === 'confirmed') lines.push(t('vm.startHeadlessHint'))
  lines.push(entrySummary(outcome.entry))
  const resources = resourceLine(outcome.entry)
  if (resources.length > 0) lines.push(resources)
  return lines.join('\n')
}

/**
 * 渲染配置改写的结果。
 * @param outcome - `Inventory.configure` 的返回值。
 * @returns 文本。
 */
export function renderConfigOutcome(outcome) {
  const entry = outcome.entry
  const name = entry?.name ?? ''
  if (outcome.reason === 'power') {
    return t('vm.configNeedsPowerOff', { name, state: stateLabel(outcome.state ?? entry.state) })
  }
  if (outcome.reason === 'no-changes') {
    return t('vm.configNoChanges')
  }
  if (outcome.reason === 'cpus') return t('api.cpusInvalid', { max: 128 })
  if (outcome.reason === 'memory') return t('api.memoryInvalid', { max: 1048576 })
  if (outcome.reason === 'nicMode') return t('api.nicModeInvalid')
  if (outcome.reason === 'nicName') return t('api.nicNameRequired')
  const lines = [t('vm.configChanged', { name, changes: (outcome.changed ?? []).join(', ') })]
  if (outcome.backupPath !== undefined && outcome.backupPath.length > 0) {
    lines.push(t('vm.configBackup', { path: outcome.backupPath }))
  }
  if (Array.isArray(outcome.warnings) && outcome.warnings.includes('suspended')) {
    lines.push(t('vm.configSuspended', { name }))
  }
  lines.push(renderDetail(entry))
  return lines.filter((line) => line.length > 0).join('\n')
}

/**
 * 渲染删除 / 移除的结果。
 * @param outcome - `Inventory.remove` 的返回值。
 * @returns 文本。
 */
export function renderRemoveOutcome(outcome) {
  const entry = outcome.entry
  const name = entry?.name ?? ''
  if (outcome.ok !== true) {
    if (outcome.reason === 'shared-folder') {
      return t('vm.trashBlocked', { name, folder: entry.folder, others: (outcome.siblings ?? []).join(', ') })
    }
    if (outcome.reason === 'state') {
      return t('vm.deleteNeedsStopped', { name, state: stateLabel(entry.state) })
    }
    if (outcome.reason === 'rename-failed') {
      return [t('vm.deleteFailed', { name }), String(outcome.detail ?? '')].filter((line) => line.length > 0).join('\n')
    }
    return [t('vm.deleteFailed', { name }), outcome.result?.stderr?.trim() ?? ''].filter((line) => line.length > 0).join('\n')
  }
  if (outcome.mode === 'purge') return t('vm.deletedPurge', { name })
  if (outcome.mode === 'trash') return t('vm.deletedTrash', { name, trash: outcome.trashPath ?? '' })
  return t('vm.unregistered', { name })
}

/**
 * 判断一个动作名是否属于电源动作。
 * @param action - 动作名。
 * @returns 是否有效。
 */
export function isPowerAction(action) {
  return POWER_ACTIONS.includes(action)
}
