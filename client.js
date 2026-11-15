/**
 * 虚拟机插件的浏览器半边：设置页 + 对话内卡片。
 *
 * 与 Host 侧一样零依赖、零构建——手写 React 元素，只 require 宿主提供的 'react'。
 * 数据经同源、document-relative 的 POST 走 `/vm-control/*`（见 lib/vm-api.js）。
 * 文案交给宿主的 locale 服务：注册 `vm-control` 命名空间的中英字典，slot 组件用宿主
 * 注入的 t，所以切换语言后设置页与对话卡片会立刻跟着变；没有 locale 服务的老宿主
 * 退回按 <html lang> 判断。
 *
 * 界面这一层的取舍：
 * - **状态实时化**：打开设置页后按固定间隔拉一次 `list`，页面隐藏时停止。资源占用本来
 *   就有 2.5 秒的宿主侧缓存，所以这个间隔不会真的每秒去问 PowerShell。
 * - **危险动作分三级**：「只移除记录」「移到回收站」「彻底删除」是三个不同的按钮，
 *   而不是一个「删除」加一个复选框。默认关闭的 `permissions.delete` 只会禁掉第三个。
 * - **失败就地显示**：动作的错误出现在那张卡片上，而不是页面顶端——点按钮的人正看着
 *   按钮旁边。
 */
window.__ModuleLoader__.load({
  id: 'dsh-vm-control',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useContext, useEffect, useRef, useState } = React

    // —— 文案 ——
    const DICT = {
      zh: {
        sectionTitle: 'VMware 虚拟机',
        heading: 'VMware 虚拟机',
        intro: '集中管理本机的 VMware 虚拟机：电源、快照、实时占用与网络配置。插件只调用 VMware 自带的 vmrun，不改变虚拟机文件结构。',
        refresh: '刷新',
        refreshing: '刷新中…',
        add: '添加虚拟机',
        addHint: '指向磁盘上已有的 .vmx；插件只记录路径，不复制也不移动文件',
        vmxPlaceholder: 'E:\\Virtual Machines\\Kali\\Kali.vmx',
        addSubmit: '添加',
        empty: '还没有发现虚拟机。加一个搜索目录，或直接添加某个 .vmx 文件。',
        loading: '加载中…',
        lastUpdated: '更新于',
        never: '尚未刷新',
        rootsTitle: '搜索目录',
        rootsHint: '插件会扫描这些目录（含子目录）里的 .vmx。把虚拟机根目录加进来，之后新建的虚拟机自动出现。',
        rootsEmpty: '还没有搜索目录：只能手动添加 .vmx。',
        rootsPlaceholder: 'E:\\Virtual Machines',
        rootsAdd: '加入目录',
        rootsRemove: '移除',
        rootsSaved: '已保存搜索目录',
        rootsNeedAbsolute: '请填写绝对路径。',
        rootsMissing: '目录不存在',
        vmrunMissing: '找不到 vmrun：装好 VMware Workstation / Player / Fusion，或在插件配置里指定 vmrunPath。',
        permsTitle: '权限',
        permPower: '电源',
        permSnapshot: '快照',
        permConfig: '参数',
        permDelete: '删除',
        permOn: '开启',
        permOff: '关闭',
        permHint: '由插件配置的 permissions 决定，改完需要重启 DSH。',
        stateRunning: '运行中',
        statePaused: '已暂停',
        stateSuspended: '已挂起',
        stateStopped: '已停止',
        stateMissing: '文件缺失',
        stateUnknown: '未知',
        cpuLabel: 'CPU',
        memLabel: '内存',
        threadsLabel: '线程',
        nicLabel: '网卡',
        pathLabel: '路径',
        hwLabel: '硬件版本',
        encryptedBadge: '加密',
        registeredBadge: '已登记',
        externalBadge: '搜索发现',
        missingBadge: '文件已不在磁盘上',
        noNic: '没有网卡',
        start: '启动',
        startGui: '带界面启动',
        stop: '关机',
        suspend: '挂起',
        pause: '暂停',
        resume: '恢复',
        reset: '重启',
        soft: '软',
        hard: '硬',
        modeHint: '软 = 通知客户机自行关机（需要 Tools）；硬 = 立即断电',
        snapshots: '快照',
        snapshotName: '快照名',
        snapshotNote: '说明（可选）',
        snapshotCreate: '拍快照',
        snapshotRevert: '回滚',
        snapshotDelete: '删除快照',
        snapshotEmpty: '这台虚拟机还没有快照。',
        snapshotCurrent: '当前',
        snapshotRevertConfirm: '回滚到「{name}」？该快照之后写入的磁盘内容会丢失。',
        snapshotDeleteConfirm: '删除快照「{name}」？',
        config: '参数',
        configTitle: '虚拟机参数',
        configHint: '参数写在 vmx 里，只能在关机状态下修改；改前会留一份 .bak。',
        configNeedsOff: '虚拟机当前是{state}，请先关机再改参数。',
        cpus: 'vCPU 数量',
        memory: '内存（MB）',
        nicMode: '网卡连接方式',
        nicName: '虚拟网络名',
        nicCustom: '自定义',
        nicNat: 'NAT',
        nicBridged: '桥接',
        nicHostonly: '仅主机',
        toolsSync: '让 VMware Tools 同步客户机时间',
        displayName: '显示名称',
        notesLabel: '备注',
        tagsLabel: '标签（逗号分隔）',
        credentialRef: '加密口令的凭据名（可选）',
        credentialRefHint: '只保存凭据引用，不保存口令本身',
        save: '保存',
        cancel: '取消',
        saved: '已保存',
        openFolder: '打开目录',
        opened: '已打开',
        remove: '删除',
        removeTitle: '删除这台虚拟机',
        removeHint: '三种语义互不相同，请选一个：',
        removeKeep: '只移除记录',
        removeKeepHint: '磁盘上的文件完全不动，下次扫描到还会出现',
        removeTrash: '移到回收站',
        removeTrashHint: '整个虚拟机目录移到插件的 trash 目录，可手动还原',
        removePurge: '彻底删除',
        removePurgeHint: '调用 vmrun deleteVM，连磁盘文件一起删掉，不可恢复',
        removePurgeConfirm: '彻底删除「{name}」？虚拟机的磁盘文件会一起消失。',
        removeDone: '已删除',
        guestInfo: '客户机信息',
        guestFetching: '查询中…',
        toolsState: 'Tools 状态',
        guestIp: '客户机 IP',
        guestUnavailable: '取不到客户机信息：虚拟机未运行，或 VMware Tools 未就绪。',
        busy: '处理中…',
        invalidValue: '请填写合法的数值。',
        transportError: '无法连接到宿主：路由不可用。',
        routeMissing: '宿主没有注册设置接口：插件文件已更新，但宿主进程仍在运行旧代码。请重启 DSH Desktop。',
        notAuthorized: '请求被宿主拒绝（未认证）。请刷新页面后重试。',
        permDenied: '插件配置禁止该操作（permissions.{scope} = false）。',
        diagTitle: '错误日志',
        diagIntro: '默认不写日志。开启后，工具与设置接口的报错会记进下面的文件，排查问题时可以直接看。',
        diagEnable: '开启日志',
        diagDisable: '关闭日志',
        diagOn: '已开启',
        diagOff: '已关闭',
        diagPath: '日志文件',
        diagOpen: '打开日志目录',
        diagClear: '清空日志',
        diagCleared: '已清空',
        diagEmpty: '暂无日志记录。',
        diagHint: '加密口令不会写进日志：形如 -vp <口令> 的内容会被替换成 ***。',
        diagBusy: '处理中…',
        dockHint: '虚拟机状态：发送第一条消息后并入对话记录',
        running: '执行中…',
        noOutput: '（无输出）',
        failed: '失败',
        toolList: '列出虚拟机',
      },
      en: {
        sectionTitle: 'VMware VMs',
        heading: 'VMware virtual machines',
        intro: 'Manage local VMware VMs in one place: power, snapshots, live resource use and network configuration. The plugin only drives VMware\'s own vmrun and never rewrites the VM file layout.',
        refresh: 'Refresh',
        refreshing: 'Refreshing…',
        add: 'Add VM',
        addHint: 'Point at an existing .vmx; the plugin records the path and never copies or moves files',
        vmxPlaceholder: 'E:\\Virtual Machines\\Kali\\Kali.vmx',
        addSubmit: 'Add',
        empty: 'No VMs found yet. Add a search root, or add a single .vmx file.',
        loading: 'Loading…',
        lastUpdated: 'updated',
        never: 'not refreshed yet',
        rootsTitle: 'Search roots',
        rootsHint: 'These folders (and their subfolders) are scanned for .vmx files. Add your VM root and new VMs show up automatically.',
        rootsEmpty: 'No search roots yet: only manually added .vmx files appear.',
        rootsPlaceholder: 'E:\\Virtual Machines',
        rootsAdd: 'Add folder',
        rootsRemove: 'Remove',
        rootsSaved: 'Search roots saved',
        rootsNeedAbsolute: 'An absolute path is required.',
        rootsMissing: 'folder missing',
        vmrunMissing: 'vmrun was not found: install VMware Workstation / Player / Fusion, or set vmrunPath in the plugin config.',
        permsTitle: 'Permissions',
        permPower: 'Power',
        permSnapshot: 'Snapshots',
        permConfig: 'Config',
        permDelete: 'Delete',
        permOn: 'on',
        permOff: 'off',
        permHint: 'Set by the plugin permissions config; restart DSH after changing it.',
        stateRunning: 'running',
        statePaused: 'paused',
        stateSuspended: 'suspended',
        stateStopped: 'stopped',
        stateMissing: 'file missing',
        stateUnknown: 'unknown',
        cpuLabel: 'CPU',
        memLabel: 'memory',
        threadsLabel: 'threads',
        nicLabel: 'NIC',
        pathLabel: 'path',
        hwLabel: 'hardware',
        encryptedBadge: 'encrypted',
        registeredBadge: 'added',
        externalBadge: 'discovered',
        missingBadge: 'the vmx file is gone',
        noNic: 'no NIC',
        start: 'Start',
        startGui: 'Start with GUI',
        stop: 'Stop',
        suspend: 'Suspend',
        pause: 'Pause',
        resume: 'Resume',
        reset: 'Reset',
        soft: 'soft',
        hard: 'hard',
        modeHint: 'soft asks the guest to shut down (needs Tools); hard cuts power immediately',
        snapshots: 'Snapshots',
        snapshotName: 'Snapshot name',
        snapshotNote: 'Note (optional)',
        snapshotCreate: 'Take snapshot',
        snapshotRevert: 'Revert',
        snapshotDelete: 'Delete',
        snapshotEmpty: 'This VM has no snapshots yet.',
        snapshotCurrent: 'current',
        snapshotRevertConfirm: 'Revert to "{name}"? Disk changes made after that snapshot are lost.',
        snapshotDeleteConfirm: 'Delete snapshot "{name}"?',
        config: 'Config',
        configTitle: 'VM parameters',
        configHint: 'These live in the vmx and can only change while the VM is powered off; a .bak is left behind.',
        configNeedsOff: 'The VM is {state}; power it off before changing parameters.',
        cpus: 'vCPUs',
        memory: 'Memory (MB)',
        nicMode: 'NIC connection type',
        nicName: 'Virtual network',
        nicCustom: 'custom',
        nicNat: 'NAT',
        nicBridged: 'bridged',
        nicHostonly: 'host-only',
        toolsSync: 'Let VMware Tools sync guest time',
        displayName: 'Display name',
        notesLabel: 'Note',
        tagsLabel: 'Tags (comma separated)',
        credentialRef: 'Credential name for the encryption password (optional)',
        credentialRefHint: 'Only the reference is stored, never the password itself',
        save: 'Save',
        cancel: 'Cancel',
        saved: 'Saved',
        openFolder: 'Open folder',
        opened: 'Opened',
        remove: 'Delete',
        removeTitle: 'Delete this VM',
        removeHint: 'Three different meanings; pick one:',
        removeKeep: 'Drop the entry',
        removeKeepHint: 'Files stay untouched; the next scan finds it again',
        removeTrash: 'Move to trash',
        removeTrashHint: 'Move the whole VM folder into the plugin trash so it can be restored by hand',
        removePurge: 'Delete with files',
        removePurgeHint: 'Runs vmrun deleteVM: the disk files go too, and it cannot be undone',
        removePurgeConfirm: 'Delete "{name}" with its disk files? This cannot be undone.',
        removeDone: 'Deleted',
        guestInfo: 'Guest info',
        guestFetching: 'Asking…',
        toolsState: 'Tools state',
        guestIp: 'Guest IP',
        guestUnavailable: 'Guest information is unavailable: the VM is not running, or VMware Tools is not ready.',
        busy: 'Working…',
        invalidValue: 'Enter a valid number.',
        transportError: 'Cannot reach the host: route unavailable.',
        routeMissing: 'The host has no settings route: the plugin files are updated but the host process is still running the old code. Restart DSH Desktop.',
        notAuthorized: 'The host rejected the request (not authenticated). Refresh the page and try again.',
        permDenied: 'The plugin configuration forbids this operation (permissions.{scope} = false).',
        diagTitle: 'Error log',
        diagIntro: 'Nothing is logged by default. Turn it on to record tool and settings failures into the file below.',
        diagEnable: 'Turn on',
        diagDisable: 'Turn off',
        diagOn: 'On',
        diagOff: 'Off',
        diagPath: 'Log file',
        diagOpen: 'Open log folder',
        diagClear: 'Clear log',
        diagCleared: 'Cleared',
        diagEmpty: 'No entries yet.',
        diagHint: 'Encryption passwords are never logged: anything shaped like -vp <password> becomes ***.',
        diagBusy: 'Working…',
        dockHint: 'VM state: it moves into the transcript after your first message',
        running: 'Running…',
        noOutput: 'No output',
        failed: 'failed',
        toolList: 'List VMs',
      },
    }

    // —— 语言：交给宿主的 locale 服务 ——
    const NS = 'vm-control'
    const LocaleContext = React.createContext(null)

    /**
     * 兜底取词：没有 locale 服务（或组件不在 withLocale 内）时使用。
     * @param key - 字典键。
     * @param vars - 占位符替换。
     * @returns 文案。
     */
    const fallbackT = (key, vars) => {
      const lang = String(globalThis.document?.documentElement?.lang ?? '').toLowerCase().startsWith('zh') ? 'zh' : 'en'
      const template = DICT[lang]?.[key] ?? DICT.zh[key] ?? key
      if (vars === undefined) return template
      return template.replace(/\{(\w+)\}/g, (match, name) => (vars[name] === undefined ? match : String(vars[name])))
    }

    /** 组件内取 t：优先用 withLocale 注入的那个。 */
    const useT = () => useContext(LocaleContext) ?? fallbackT

    /**
     * 把要注册的 slot 组件包一层：宿主传进来的 t 放进 context。
     * @param Component - 被注册的组件。
     * @returns 包了 Provider 的组件。
     */
    function withLocale(Component) {
      return function LocaleRoot(props) {
        const t = props.t ?? fallbackT
        return h(LocaleContext.Provider, { value: t }, h(Component, props))
      }
    }

    // —— 配色：沿用宿主 primitives 的 token，缺失时退回中性色 ——
    const C = {
      text: 'var(--dsw-alias-label-primary, currentColor)',
      textDim: 'var(--dsw-alias-label-secondary, currentColor)',
      textDimmed: 'var(--dsw-alias-label-dimmed, currentColor)',
      border: 'var(--dsw-alias-border-l3, rgba(127,127,127,0.45))',
      borderSubtle: 'var(--dsw-alias-border-l4, rgba(127,127,127,0.28))',
      inputBg: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.10))',
      primaryFill: 'var(--dsw-alias-button-primary-fill, #4f7cff)',
      primaryText: 'var(--dsw-alias-label-primary-foreground, #ffffff)',
      radiusSm: 'var(--dsw-radius-sm, 6px)',
      radiusMd: 'var(--dsw-radius-md, 8px)',
      surface: 'rgba(127,127,127,0.08)',
      surfaceStrong: 'rgba(127,127,127,0.14)',
      ok: 'var(--dsw-alias-state-success-primary, #2e9e5b)',
      bad: 'var(--dsw-alias-state-error-primary, #d64545)',
      warn: 'var(--dsw-alias-state-warn-primary, #c98a12)',
      info: 'var(--dsw-alias-state-business-primary, #4f7cff)',
    }

    const MONO = 'ui-monospace, SFMono-Regular, Consolas, "Courier New", monospace'

    const S = {
      page: { display: 'flex', flexDirection: 'column', gap: '14px', color: C.text, fontSize: '13px', lineHeight: 1.6 },
      head: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px' },
      titleRow: { display: 'flex', alignItems: 'center', gap: '8px' },
      titleIcon: { flex: 'none', color: C.text },
      h: { margin: 0, fontSize: '15px', fontWeight: 600, color: C.text },
      intro: { margin: '4px 0 0', color: C.textDim, maxWidth: '66ch' },
      meta: { marginTop: '6px', color: C.textDim, fontSize: '12px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      metaRow: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '2px', color: C.textDim, fontSize: '12px', minWidth: 0 },
      metaPath: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0, fontFamily: MONO },
      button: {
        appearance: 'none', WebkitAppearance: 'none', boxSizing: 'border-box', flex: 'none',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '4px',
        height: '26px', padding: '0 9px',
        border: `0.5px solid ${C.border}`, borderRadius: C.radiusSm,
        background: 'transparent', color: C.text,
        font: 'inherit', fontSize: '12px', lineHeight: '18px', cursor: 'pointer', whiteSpace: 'nowrap',
      },
      miniButton: {
        appearance: 'none', WebkitAppearance: 'none', boxSizing: 'border-box', flex: 'none',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        height: '22px', padding: '0 8px',
        border: `0.5px solid ${C.border}`, borderRadius: C.radiusSm,
        background: 'transparent', color: C.text,
        font: 'inherit', fontSize: '11px', lineHeight: '16px', cursor: 'pointer', whiteSpace: 'nowrap',
      },
      primary: { border: 'none', background: C.primaryFill, color: C.primaryText },
      danger: { borderColor: C.bad, color: C.bad },
      card: { border: `0.5px solid ${C.borderSubtle}`, borderRadius: C.radiusMd, background: C.surface, padding: '12px', display: 'flex', flexDirection: 'column', gap: '8px' },
      cardHead: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      name: { fontWeight: 600, fontSize: '13px' },
      badge: { border: `0.5px solid ${C.border}`, borderRadius: '999px', padding: '1px 8px', fontSize: '11px', color: C.textDim },
      badgeBad: { border: `0.5px solid ${C.bad}`, borderRadius: '999px', padding: '1px 8px', fontSize: '11px', color: C.bad },
      kv: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 12px', color: C.textDim, fontSize: '12px' },
      chips: { display: 'flex', gap: '6px', flexWrap: 'wrap' },
      chip: {
        display: 'inline-flex', alignItems: 'baseline', gap: '5px',
        border: `0.5px solid ${C.borderSubtle}`, borderRadius: C.radiusSm,
        padding: '1px 7px', background: C.inputBg, fontSize: '11.5px', color: C.text,
      },
      chipLabel: { color: C.textDim, fontSize: '10.5px', textTransform: 'uppercase', letterSpacing: '.04em' },
      row: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' },
      divider: { height: '0.5px', background: C.borderSubtle, margin: '2px 0' },
      form: { border: `0.5px solid ${C.border}`, borderRadius: C.radiusMd, background: C.surfaceStrong, padding: '12px', display: 'flex', flexDirection: 'column', gap: '10px' },
      fields: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '10px' },
      field: { display: 'flex', flexDirection: 'column', gap: '3px' },
      label: { fontSize: '12px', color: C.textDim },
      input: {
        boxSizing: 'border-box', height: '28px', width: '100%', padding: '0 8px',
        border: `0.5px solid ${C.borderSubtle}`, borderRadius: C.radiusSm,
        background: C.inputBg, color: C.text, font: 'inherit', fontSize: '12px',
      },
      hint: { fontSize: '11px', color: C.textDim },
      error: { color: C.bad, fontSize: '12px' },
      okText: { color: C.ok, fontSize: '12px', fontWeight: 600 },
      badText: { color: C.bad, fontSize: '12px', fontWeight: 600 },
      pre: {
        margin: 0, padding: '8px', borderRadius: C.radiusSm, background: C.inputBg, border: `0.5px solid ${C.borderSubtle}`,
        fontSize: '11.5px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '220px', overflow: 'auto', fontFamily: MONO,
      },
      dot: { width: '8px', height: '8px', borderRadius: '50%', flex: 'none' },
      segmented: { display: 'inline-flex', border: `0.5px solid ${C.border}`, borderRadius: C.radiusSm, overflow: 'hidden' },
      segment: { height: '22px', padding: '0 8px', border: 'none', background: 'transparent', color: C.textDim, font: 'inherit', fontSize: '11px', cursor: 'pointer' },
      segmentActive: { background: C.inputBg, color: C.text, fontWeight: 600 },
    }

    /** 状态点颜色。 */
    const STATE_DOT = {
      running: { background: C.ok },
      paused: { background: C.warn },
      suspended: { background: C.info },
      stopped: { background: C.textDim },
      missing: { background: C.bad },
      unknown: { background: C.textDim },
    }

    const SCOPE = 'dsh-vm-control'
    const CSS = [
      `.${SCOPE} button { transition: background-color .12s ease, border-color .12s ease; }`,
      `.${SCOPE} button:not([data-variant="primary"]):hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.12)); }`,
      `.${SCOPE} button:not([data-variant="primary"]):active:not(:disabled) { background: var(--dsw-alias-interactive-bg-active, rgba(127,127,127,0.18)); }`,
      `.${SCOPE} button[data-variant="primary"]:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-button-primary-fill, #4f7cff)); }`,
      `.${SCOPE} button:disabled { opacity: .4; cursor: not-allowed; }`,
      `.${SCOPE} button:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, currentColor); outline-offset: 1px; }`,
      `.${SCOPE} input::placeholder { color: var(--dsw-alias-label-dimmed, currentColor); }`,
    ].join('\n')

    /**
     * 调一次宿主路由。
     * @param action - 路由末段。
     * @param payload - JSON 请求体。
     * @param t - 当前语言的取词函数。
     * @returns `{ ok: true, value }` 或 `{ ok: false, error }`。
     */
    async function call(action, payload, t = fallbackT) {
      let response
      try {
        // document-relative：页面用 <base href="./">，绝对路径会逃出部署前缀。
        response = await fetch(`vm-control/${action}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload ?? {}),
        })
      } catch {
        return { ok: false, error: t('transportError') }
      }
      // 404 与 401/403 的含义完全不同：前者是宿主根本没注册路由，后者只是这次请求没被信任。
      if (response.status === 404) return { ok: false, error: t('routeMissing') }
      if (response.status === 401 || response.status === 403) return { ok: false, error: t('notAuthorized') }
      if (!response.ok) return { ok: false, error: `${t('transportError')} (HTTP ${response.status})` }
      try {
        const envelope = await response.json()
        if (envelope && envelope.ok === true) return { ok: true, value: envelope.value }
        const message = envelope && envelope.error && envelope.error.message ? envelope.error.message : t('transportError')
        return { ok: false, error: message }
      } catch {
        return { ok: false, error: t('transportError') }
      }
    }

    /**
     * 字节数 → 人类可读。
     * @param bytes - 字节数。
     * @returns 形如 `2.1 GB`。
     */
    function formatBytes(bytes) {
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

    /**
     * ISO 时间 → 本地短格式。
     * @param value - ISO 字符串。
     * @returns `HH:mm:ss`；无效时 `—`。
     */
    function formatClock(value) {
      const date = value instanceof Date ? value : new Date(value)
      if (Number.isNaN(date.getTime())) return '—'
      return date.toLocaleTimeString()
    }

    /** 状态词：把 `running` 之类的键翻成当前语言。 */
    function stateLabel(state, t) {
      const key = `state${String(state ?? 'unknown').replace(/^./, (c) => c.toUpperCase())}`
      const label = t(key)
      return label === key ? t('stateUnknown') : label
    }

    /** 一行表单字段。 */
    function Field(props) {
      return h('label', { style: S.field },
        h('span', { style: S.label }, props.label),
        props.children,
        props.hint ? h('span', { style: S.hint }, props.hint) : null)
    }

    /** 一个小信息块。 */
    function Chip(props) {
      return h('span', { style: S.chip },
        h('span', { style: S.chipLabel }, props.label),
        h('span', null, props.value))
    }

    /** 软/硬切换。 */
    function ModeSwitch(props) {
      const t = useT()
      return h('span', { style: S.segmented, title: t('modeHint') },
        ...['soft', 'hard'].map((mode) => h('button', {
          key: mode,
          style: mode === props.value ? { ...S.segment, ...S.segmentActive } : S.segment,
          onClick: () => props.onChange(mode),
        }, t(mode))))
    }

    /**
     * 诊断日志卡片：一个开关、日志路径、最近几条记录。
     * 自我约束与 SSH 保险库插件一致：关闭时插件完全不写日志。
     */
    function DiagnosticsCard() {
      const t = useT()
      const tRef = useRef(t)
      tRef.current = t
      const [state, setState] = useState({ status: 'loading', enabled: false, path: '', bytes: 0, entries: [], error: '' })
      const [busy, setBusy] = useState(false)
      const [cleared, setCleared] = useState(false)

      const apply = (value) => {
        setState({
          status: 'ready',
          enabled: value?.enabled === true,
          path: typeof value?.path === 'string' ? value.path : '',
          bytes: Number.isFinite(value?.bytes) ? value.bytes : 0,
          entries: Array.isArray(value?.entries) ? value.entries : [],
          error: '',
        })
      }

      const load = useCallback(async () => {
        const result = await call('diagnostics', undefined, tRef.current)
        if (result.ok) apply(result.value)
        else setState((s) => ({ ...s, status: 'ready', error: result.error }))
      }, [])

      useEffect(() => { load() }, [load])

      const run = async (action, payload) => {
        setBusy(true)
        const result = await call(action, payload, tRef.current)
        setBusy(false)
        if (result.ok) apply(result.value)
        else setState((s) => ({ ...s, error: result.error }))
        return result.ok
      }

      const size = state.bytes > 0 ? ` · ${(state.bytes / 1024).toFixed(1)} KB` : ''

      return h('div', { style: S.card },
        h('div', { style: S.cardHead },
          h('span', { style: S.name }, t('diagTitle')),
          h('span', { style: state.enabled ? S.okText : { ...S.badge, borderColor: 'transparent' } },
            state.enabled ? t('diagOn') : t('diagOff'))),
        h('div', { style: S.hint }, t('diagIntro')),
        state.path.length > 0
          ? h('div', { style: S.metaRow },
            h('span', { style: S.label }, t('diagPath')),
            h('span', { style: S.metaPath, title: state.path }, `${state.path}${size}`))
          : null,
        h('div', { style: S.row },
          h('button', {
            ...(state.enabled ? {} : { 'data-variant': 'primary' }),
            style: state.enabled ? S.button : { ...S.button, ...S.primary },
            disabled: busy || state.status === 'loading',
            onClick: () => { setCleared(false); run('setDiagnostics', { enabled: !state.enabled }) },
          }, state.enabled ? t('diagDisable') : t('diagEnable')),
          h('button', { style: S.button, disabled: busy, onClick: () => run('openLogs', {}) }, t('diagOpen')),
          h('button', {
            style: { ...S.button, ...S.danger },
            disabled: busy,
            onClick: async () => { if (await run('clearDiagnostics', {})) setCleared(true) },
          }, t('diagClear')),
          busy ? h('span', { style: S.hint }, t('diagBusy')) : null,
          cleared && !busy ? h('span', { style: S.okText }, t('diagCleared')) : null),
        state.entries.length > 0
          ? h('pre', { style: S.pre }, state.entries.join('\n\n'))
          : h('div', { style: S.hint }, t('diagEmpty')),
        h('div', { style: S.hint }, t('diagHint')),
        state.error.length > 0 ? h('div', { style: S.error }, state.error) : null)
    }

    /**
     * 快照面板：列表 + 新建 + 回滚 + 删除。
     * @param props - 虚拟机条目与刷新回调。
     */
    function SnapshotPanel(props) {
      const t = useT()
      const entry = props.entry
      const [state, setState] = useState({ status: 'loading', items: [], error: '' })
      const [name, setName] = useState('')
      const [note, setNote] = useState('')
      const [busy, setBusy] = useState(false)

      const load = useCallback(async () => {
        const result = await call('snapshots', { id: entry.id }, t)
        if (result.ok) setState({ status: 'ready', items: result.value.snapshots ?? [], error: '' })
        else setState({ status: 'ready', items: [], error: result.error })
      }, [entry.id])

      useEffect(() => { load() }, [load])

      const run = async (action, payload) => {
        setBusy(true)
        const result = await call(action, payload, t)
        setBusy(false)
        if (!result.ok) {
          setState((s) => ({ ...s, error: result.error }))
          return false
        }
        await load()
        props.onChanged(result.value?.message ?? '')
        return true
      }

      return h('div', { style: S.form },
        h('div', { style: S.cardHead }, h('span', { style: S.name }, t('snapshots'))),
        state.items.length === 0
          ? h('div', { style: S.hint }, state.status === 'loading' ? t('loading') : t('snapshotEmpty'))
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
            ...state.items.map((snapshot) => h('div', { key: snapshot.name, style: { ...S.row, justifyContent: 'space-between' } },
              h('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } },
                h('span', { style: { fontFamily: MONO } }, snapshot.name),
                snapshot.current === true ? h('span', { style: S.badge }, t('snapshotCurrent')) : null,
                snapshot.note ? h('span', { style: { ...S.hint, marginLeft: '6px' } }, snapshot.note) : null,
                snapshot.createdAt ? h('span', { style: { ...S.hint, marginLeft: '6px' } }, formatClock(snapshot.createdAt)) : null),
              h('span', { style: S.row },
                h('button', {
                  style: S.miniButton,
                  disabled: busy,
                  onClick: () => {
                    if (!window.confirm(t('snapshotRevertConfirm', { name: snapshot.name }))) return
                    run('snapshotRevert', { id: entry.id, name: snapshot.name })
                  },
                }, t('snapshotRevert')),
                h('button', {
                  style: { ...S.miniButton, ...S.danger },
                  disabled: busy,
                  onClick: () => {
                    if (!window.confirm(t('snapshotDeleteConfirm', { name: snapshot.name }))) return
                    run('snapshotDelete', { id: entry.id, name: snapshot.name })
                  },
                }, t('snapshotDelete')))))),
        h('div', { style: S.fields },
          h(Field, { label: t('snapshotName') },
            h('input', { style: S.input, value: name, onChange: (e) => setName(e.target.value) })),
          h(Field, { label: t('snapshotNote') },
            h('input', { style: S.input, value: note, onChange: (e) => setNote(e.target.value) }))),
        h('div', { style: S.row },
          h('button', {
            'data-variant': 'primary',
            style: { ...S.button, ...S.primary },
            disabled: busy || name.trim().length === 0,
            onClick: async () => {
              if (await run('snapshotCreate', { id: entry.id, name: name.trim(), description: note.trim() })) {
                setName('')
                setNote('')
              }
            },
          }, t('snapshotCreate')),
          h('button', { style: S.button, disabled: busy, onClick: props.onClose }, t('cancel')),
          busy ? h('span', { style: S.hint }, t('busy')) : null),
        state.error.length > 0 ? h('div', { style: S.error }, state.error) : null)
    }

    /**
     * 参数面板：改 VMX 里可安全调整的几项。
     * @param props - 条目、权限与回调。
     */
    function ConfigPanel(props) {
      const t = useT()
      const entry = props.entry
      const [form, setForm] = useState({
        displayName: entry.name,
        cpus: String(entry.cpus || 1),
        memory: String(entry.memoryMB || 1024),
        nicMode: entry.nics?.[0]?.connectionType ?? 'nat',
        nicName: entry.nics?.[0]?.networkName ?? '',
        toolsSync: entry.toolsSyncTime === true,
        notes: entry.notes ?? '',
        tags: (entry.tags ?? []).join(', '),
        credentialRef: entry.credentialRef ?? '',
      })
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [networks, setNetworks] = useState([])

      useEffect(() => {
        let alive = true
        call('networks', {}, t).then((result) => {
          if (alive && result.ok) setNetworks(result.value.networks ?? [])
        })
        return () => { alive = false }
      }, [])

      const off = entry.state !== 'stopped'
      const update = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }))

      const submit = async () => {
        setError('')
        const cpus = Number(form.cpus)
        const memory = Number(form.memory)
        if (!Number.isInteger(cpus) || cpus < 1 || cpus > 128) {
          setError(t('invalidValue'))
          return
        }
        if (!Number.isInteger(memory) || memory < 4 || memory > 1048576) {
          setError(t('invalidValue'))
          return
        }
        setBusy(true)
        const result = await call('saveConfig', {
          id: entry.id,
          displayName: form.displayName,
          cpus,
          memoryMB: memory,
          nicMode: form.nicMode,
          nicName: form.nicName,
          toolsSyncTime: form.toolsSync,
          notes: form.notes,
          tags: form.tags.split(',').map((tag) => tag.trim()).filter((tag) => tag.length > 0),
          credentialRef: form.credentialRef,
        }, t)
        setBusy(false)
        if (!result.ok) {
          setError(result.error)
          return
        }
        props.onChanged(result.value?.message ?? t('saved'))
      }

      return h('div', { style: S.form },
        h('div', { style: S.cardHead },
          h('span', { style: S.name }, t('configTitle')),
          off ? h('span', { style: S.badgeBad }, t('configNeedsOff', { state: stateLabel(entry.state, t) })) : null),
        h('div', { style: S.hint }, t('configHint')),
        h('div', { style: S.fields },
          h(Field, { label: t('displayName') },
            h('input', { style: S.input, value: form.displayName, onChange: update('displayName') })),
          h(Field, { label: t('cpus') },
            h('input', { style: S.input, value: form.cpus, inputMode: 'numeric', onChange: update('cpus') })),
          h(Field, { label: t('memory') },
            h('input', { style: S.input, value: form.memory, inputMode: 'numeric', onChange: update('memory') })),
          h(Field, { label: t('nicMode') },
            h('select', { style: S.input, value: form.nicMode, onChange: update('nicMode') },
              h('option', { value: 'nat' }, t('nicNat')),
              h('option', { value: 'bridged' }, t('nicBridged')),
              h('option', { value: 'hostonly' }, t('nicHostonly')),
              h('option', { value: 'custom' }, t('nicCustom')))),
          form.nicMode === 'custom'
            ? h(Field, { label: t('nicName') },
              h('input', {
                style: S.input,
                value: form.nicName,
                list: 'dsh-vm-control-networks',
                onChange: update('nicName'),
              }),
              h('datalist', { id: 'dsh-vm-control-networks' },
                ...networks.map((network) => h('option', { key: network.name, value: network.name }))))
            : null,
          h(Field, { label: t('credentialRef'), hint: t('credentialRefHint') },
            h('input', { style: S.input, value: form.credentialRef, onChange: update('credentialRef') }))),
        h('div', { style: S.fields },
          h(Field, { label: t('notesLabel') },
            h('input', { style: S.input, value: form.notes, onChange: update('notes') })),
          h(Field, { label: t('tagsLabel') },
            h('input', { style: S.input, value: form.tags, onChange: update('tags') }))),
        h('label', { style: S.row },
          h('input', {
            type: 'checkbox',
            checked: form.toolsSync,
            onChange: (event) => setForm((current) => ({ ...current, toolsSync: event.target.checked })),
          }),
          t('toolsSync')),
        error.length > 0 ? h('div', { style: S.error }, error) : null,
        h('div', { style: S.row },
          h('button', {
            'data-variant': 'primary',
            style: { ...S.button, ...S.primary },
            disabled: busy || off || props.readOnly === true,
            onClick: submit,
          }, busy ? t('busy') : t('save')),
          h('button', { style: S.button, disabled: busy, onClick: props.onClose }, t('cancel')),
          off ? h('span', { style: S.hint }, t('configNeedsOff', { state: stateLabel(entry.state, t) })) : null))
    }

    /**
     * 删除面板：三种语义各一个按钮。
     * @param props - 条目与回调。
     */
    function RemovePanel(props) {
      const t = useT()
      const entry = props.entry
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')

      const run = async (mode) => {
        setError('')
        if (mode === 'purge' && !window.confirm(t('removePurgeConfirm', { name: entry.name }))) return
        setBusy(true)
        const result = await call('delete', {
          id: entry.id,
          mode,
          confirm: mode === 'purge',
        }, t)
        setBusy(false)
        if (!result.ok) {
          setError(result.error)
          return
        }
        props.onChanged(result.value?.message ?? t('removeDone'))
      }

      return h('div', { style: S.form },
        h('div', { style: S.cardHead }, h('span', { style: S.name }, t('removeTitle'))),
        h('div', { style: S.hint }, t('removeHint')),
        h('div', { style: S.row },
          h('button', {
            style: S.button,
            disabled: busy,
            title: t('removeKeepHint'),
            onClick: () => run('keep'),
          }, t('removeKeep')),
          h('button', {
            style: S.button,
            disabled: busy,
            title: t('removeTrashHint'),
            onClick: () => run('trash'),
          }, t('removeTrash')),
          h('button', {
            style: { ...S.button, ...S.danger },
            disabled: busy || props.canDelete !== true,
            title: props.canDelete === true ? t('removePurgeHint') : t('permDenied', { scope: 'delete' }),
            onClick: () => run('purge'),
          }, t('removePurge')),
          h('button', { style: S.button, disabled: busy, onClick: props.onClose }, t('cancel'))),
        h('div', { style: S.hint }, t('removeTrashHint')),
        error.length > 0 ? h('div', { style: S.error }, error) : null)
    }

    /** 设置页主体。 */
    function VmControlSettings() {
      const t = useT()
      const tRef = useRef(t)
      tRef.current = t
      const [state, setState] = useState({
        status: 'loading',
        vms: [],
        roots: [],
        notes: [],
        permissions: { power: true, snapshot: true, config: true, delete: false },
        vmrun: { found: false, path: '', version: '', hostType: '', capabilities: [], error: '' },
        version: '',
        dataDir: '',
        trashDir: '',
        error: '',
        at: 0,
      })
      const [panel, setPanel] = useState(null)
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState(null)
      const [modes, setModes] = useState({})
      const [rootsOpen, setRootsOpen] = useState(false)
      const [rootsDraft, setRootsDraft] = useState('')
      const [addOpen, setAddOpen] = useState(false)
      const [addDraft, setAddDraft] = useState({ vmx: '', name: '' })
      const [guests, setGuests] = useState({})

      const load = useCallback(async (options = {}) => {
        const result = await call('list', { refresh: options.refresh === true }, tRef.current)
        if (!result.ok) {
          setState((s) => ({ ...s, status: 'ready', error: result.error }))
          return
        }
        const value = result.value
        setState({
          status: 'ready',
          vms: value.vms ?? [],
          roots: value.roots ?? [],
          notes: value.notes ?? [],
          permissions: value.permissions ?? { power: true, snapshot: true, config: true, delete: false },
          vmrun: value.vmrun ?? { found: false },
          version: value.version ?? '',
          dataDir: value.dataDir ?? '',
          trashDir: value.trashDir ?? '',
          error: '',
          at: value.now ?? Date.now(),
        })
      }, [])

      useEffect(() => { load() }, [load])

      // 定时刷新：页面可见时才拉，隐藏时停——后台标签页没有理由每秒问 PowerShell。
      useEffect(() => {
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          load()
        }, 7000)
        return () => clearInterval(timer)
      }, [load])

      const refresh = async () => {
        setBusy('refresh')
        await load({ refresh: true })
        setBusy('')
      }

      /**
       * 执行一次会改变状态的动作，并在成功后刷新列表。
       * @param key - 忙碌标识。
       * @param action - 路由名。
       * @param payload - 请求体。
       * @param id - 关联的虚拟机 id（用于就地提示）。
       * @param optimisticMessage - 成功后的提示。
       */
      const act = async (key, action, payload, id, optimisticMessage) => {
        setBusy(`${id ?? ''}:${key}`)
        setNotice(null)
        const result = await call(action, payload, tRef.current)
        setBusy('')
        if (!result.ok) {
          setNotice({ id, kind: 'error', text: result.error })
          return false
        }
        setNotice({ id, kind: 'ok', text: result.value?.message ?? optimisticMessage ?? '' })
        await load({ refresh: true })
        return true
      }

      const permissions = state.permissions
      const capabilities = state.vmrun.capabilities ?? []
      const canCapability = (command) => capabilities.length === 0 || capabilities.includes(command)

      /**
       * 向 VMware Tools 问一次客户机信息。
       *
       * 它是唯一「按需」的慢调用：每台运行中的虚拟机都要问一次 vmrun，Tools 没起来时会等
       * 到超时。所以不做自动轮询，只在用户点按钮时执行，结果留在这张卡片上。
       *
       * @param vm - 虚拟机条目。
       */
      const fetchGuest = async (vm) => {
        setBusy(`${vm.id}:guest`)
        setNotice(null)
        const result = await call('guest', { id: vm.id }, tRef.current)
        setBusy('')
        if (!result.ok) {
          setNotice({ id: vm.id, kind: 'error', text: result.error })
          return
        }
        setGuests((current) => ({ ...current, [vm.id]: result.value.guest }))
        if (result.value.guest.available !== true) {
          setNotice({ id: vm.id, kind: 'error', text: tRef.current('guestUnavailable') })
        }
      }

      const dotFor = (vm) => ({ ...S.dot, ...(STATE_DOT[vm.state] ?? STATE_DOT.unknown) })

      const header = h('div', { style: S.head },
        h('div', { style: { minWidth: 0 } },
          h('div', { style: S.titleRow },
            h('svg', {
              viewBox: '0 0 24 24', width: 18, height: 18, style: S.titleIcon, 'aria-hidden': true,
              fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
            },
            h('rect', { x: 2.5, y: 4, width: 19, height: 13, rx: 2.5 }),
            h('path', { d: 'M8 20.5h8M12 17v3.5' }),
            h('rect', { x: 5.5, y: 7, width: 6, height: 4, rx: 1 }),
            h('path', { d: 'M14.5 7.5h3.5M14.5 10h2.5M5.5 14h12' })),
            h('h3', { style: S.h }, t('heading'))),
          h('p', { style: S.intro }, t('intro')),
          state.status === 'ready' && state.error.length === 0
            ? h('div', { style: { display: 'flex', flexDirection: 'column', minWidth: 0 } },
              h('div', {
                style: S.meta,
                title: state.vmrun.path,
              }, [
                `dsh-vm-control v${state.version || '—'}`,
                state.vmrun.found
                  ? `${state.vmrun.hostType || '—'} · vmrun ${state.vmrun.version || '—'}`
                  : t('vmrunMissing'),
                `${t('lastUpdated')} ${state.at > 0 ? formatClock(state.at) : t('never')}`,
              ].join('　·　')))
            : null),
        h('div', { style: { ...S.row, flex: 'none' } },
          h('button', { style: S.button, disabled: busy === 'refresh', onClick: refresh },
            busy === 'refresh' ? t('refreshing') : t('refresh')),
          h('button', {
            'data-variant': 'primary',
            style: { ...S.button, ...S.primary },
            onClick: () => { setAddOpen(!addOpen); setPanel(null) },
          }, t('add'))))

      const rootsCard = h('div', { style: S.card },
        h('div', { style: S.cardHead },
          h('span', { style: S.name }, t('rootsTitle')),
          h('span', { style: S.hint }, `${state.roots.length}`),
          h('button', {
            style: S.miniButton,
            onClick: () => setRootsOpen(!rootsOpen),
          }, rootsOpen ? t('cancel') : t('rootsAdd'))),
        h('div', { style: S.hint }, t('rootsHint')),
        rootsOpen
          ? h('div', null,
            h('div', { style: S.fields },
              ...state.roots.map((root) => h('div', { key: root.path, style: { ...S.row, justifyContent: 'space-between' } },
                h('span', { style: { ...S.metaPath, flex: '1 1 auto' }, title: root.path }, root.path),
                root.exists !== true ? h('span', { style: S.badgeBad }, t('rootsMissing')) : null,
                h('button', {
                  style: S.miniButton,
                  disabled: busy === 'roots',
                  onClick: async () => {
                    setBusy('roots')
                    const result = await call('setRoots', {
                      roots: state.roots.filter((item) => item.path !== root.path).map((item) => item.path),
                    }, tRef.current)
                    setBusy('')
                    if (result.ok) {
                      setNotice({ id: null, kind: 'ok', text: t('rootsSaved') })
                      await load({ refresh: true })
                    } else {
                      setNotice({ id: null, kind: 'error', text: result.error })
                    }
                  },
                }, t('rootsRemove'))))),
            h('div', { style: S.row },
              h('input', {
                style: { ...S.input, flex: '1 1 240px' },
                value: rootsDraft,
                placeholder: t('rootsPlaceholder'),
                onChange: (event) => setRootsDraft(event.target.value),
              }),
              h('button', {
                style: S.button,
                disabled: busy === 'roots' || rootsDraft.trim().length === 0,
                onClick: async () => {
                  const candidate = rootsDraft.trim()
                  if (!/^[A-Za-z]:[\\/]/.test(candidate) && !candidate.startsWith('/')) {
                    setNotice({ id: null, kind: 'error', text: t('rootsNeedAbsolute') })
                    return
                  }
                  setBusy('roots')
                  const result = await call('setRoots', {
                    roots: [...state.roots.map((item) => item.path), candidate],
                  }, tRef.current)
                  setBusy('')
                  if (result.ok) {
                    setRootsDraft('')
                    setNotice({ id: null, kind: 'ok', text: t('rootsSaved') })
                    await load({ refresh: true })
                  } else {
                    setNotice({ id: null, kind: 'error', text: result.error })
                  }
                },
              }, t('rootsAdd'))))
          : state.roots.length === 0
            ? h('div', { style: S.hint }, t('rootsEmpty'))
            : h('div', { style: S.kv },
              ...state.roots.flatMap((root) => [
                h('span', { key: `${root.path}-p`, style: S.metaPath, title: root.path }, root.path),
                h('span', { key: `${root.path}-s` }, root.exists === true ? '' : t('rootsMissing')),
              ])))

      const addCard = addOpen
        ? h('div', { style: S.form },
          h('div', { style: S.cardHead }, h('span', { style: S.name }, t('add'))),
          h('div', { style: S.fields },
            h(Field, { label: 'vmx', hint: t('addHint') },
              h('input', {
                style: S.input,
                value: addDraft.vmx,
                placeholder: t('vmxPlaceholder'),
                onChange: (event) => setAddDraft((current) => ({ ...current, vmx: event.target.value })),
              })),
            h(Field, { label: t('displayName') },
              h('input', {
                style: S.input,
                value: addDraft.name,
                onChange: (event) => setAddDraft((current) => ({ ...current, name: event.target.value })),
              }))),
          h('div', { style: S.row },
            h('button', {
              'data-variant': 'primary',
              style: { ...S.button, ...S.primary },
              disabled: busy === 'add' || addDraft.vmx.trim().length === 0,
              onClick: async () => {
                setBusy('add')
                const result = await call('register', {
                  vmx: addDraft.vmx.trim(),
                  name: addDraft.name.trim(),
                }, tRef.current)
                setBusy('')
                if (!result.ok) {
                  setNotice({ id: null, kind: 'error', text: result.error })
                  return
                }
                setAddDraft({ vmx: '', name: '' })
                setAddOpen(false)
                setNotice({ id: null, kind: 'ok', text: result.value?.message ?? '' })
                await load({ refresh: true })
              },
            }, busy === 'add' ? t('busy') : t('addSubmit')),
            h('button', { style: S.button, onClick: () => setAddOpen(false) }, t('cancel'))))
        : null

      const renderVm = (vm) => {
        const mode = modes[vm.id] ?? 'soft'
        const guest = guests[vm.id]
        const isPanel = panel !== null && panel.id === vm.id
        const vmBusy = busy.startsWith(`${vm.id}:`)
        const noticeHere = notice !== null && notice.id === vm.id ? notice : null
        const running = vm.state === 'running'
        const paused = vm.state === 'paused'
        const stopped = vm.state === 'stopped'
        const suspended = vm.state === 'suspended'

        return h('div', { key: vm.id, style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
          h('div', { style: S.card },
            h('div', { style: S.cardHead },
              h('span', { style: dotFor(vm), title: stateLabel(vm.state, t) }),
              h('span', { style: S.name }, vm.name),
              h('span', { style: { ...S.badge, color: C.text } }, stateLabel(vm.state, t)),
              vm.guestOS ? h('span', { style: S.badge }, vm.guestOS) : null,
              vm.encrypted ? h('span', { style: S.badge }, t('encryptedBadge')) : null,
              vm.registered ? h('span', { style: S.badge }, t('registeredBadge')) : h('span', { style: S.badge }, t('externalBadge')),
              vm.missing ? h('span', { style: S.badgeBad }, t('missingBadge')) : null),
            h('div', { style: S.chips },
              h(Chip, { label: 'vCPU', value: vm.cpus > 0 ? String(vm.cpus) : '—' }),
              h(Chip, { label: t('memLabel'), value: vm.memoryMB > 0 ? `${vm.memoryMB} MB` : '—' }),
              vm.resources
                ? h(Chip, { label: t('cpuLabel'), value: `${Number(vm.resources.cpuPercent ?? 0).toFixed(1)}%` })
                : null,
              vm.resources
                ? h(Chip, { label: 'RSS', value: formatBytes(vm.resources.workingSetBytes) })
                : null,
              vm.resources && vm.resources.threads > 0
                ? h(Chip, { label: t('threadsLabel'), value: String(vm.resources.threads) })
                : null,
              vm.hwVersion ? h(Chip, { label: t('hwLabel'), value: vm.hwVersion }) : null),
            (vm.nics ?? []).length > 0
              ? h('div', { style: S.kv },
                ...vm.nics.flatMap((nic) => [
                  h('span', { key: `${nic.index}-k`, style: S.label }, `${t('nicLabel')} ${nic.index}`),
                  h('span', { key: `${nic.index}-v`, style: { fontFamily: MONO, fontSize: '11.5px' } }, [
                    nic.connectionType,
                    nic.networkName,
                    nic.virtualDev,
                    nic.mac,
                    nic.startConnected ? '' : `(${t('nicLabel')} off)`,
                  ].filter((part) => typeof part === 'string' && part.length > 0).join(' · ')),
                ]))
              : h('div', { style: S.hint }, t('noNic')),
            guest !== undefined
              ? h('div', { style: S.kv },
                h('span', { style: S.label }, t('toolsState')),
                h('span', null, guest.tools || '—'),
                h('span', { style: S.label }, t('guestIp')),
                h('span', { style: { fontFamily: MONO } }, guest.ip || '—'))
              : null,
            h('div', { style: { ...S.metaRow } },
              h('span', { style: S.label }, t('pathLabel')),
              h('span', { style: { ...S.metaPath, flex: '1 1 auto' }, title: vm.vmx }, vm.vmx)),
            h('div', { style: S.divider }),
            h('div', { style: S.row },
              h('button', {
                style: S.button,
                disabled: vmBusy || !(stopped || suspended) || permissions.power !== true,
                onClick: () => act('start', 'power', { id: vm.id, action: 'start' }, vm.id),
              }, t('start')),
              h('button', {
                style: S.button,
                disabled: vmBusy || !(stopped || suspended) || permissions.power !== true,
                onClick: () => act('startGui', 'power', { id: vm.id, action: 'start', gui: true }, vm.id),
              }, t('startGui')),
              h(ModeSwitch, { value: mode, onChange: (next) => setModes((current) => ({ ...current, [vm.id]: next })) }),
              h('button', {
                style: S.button,
                disabled: vmBusy || !(running || paused) || permissions.power !== true,
                onClick: () => act('stop', 'power', { id: vm.id, action: 'stop', mode }, vm.id),
              }, t('stop')),
              h('button', {
                style: S.button,
                disabled: vmBusy || !running || permissions.power !== true,
                onClick: () => act('suspend', 'power', { id: vm.id, action: 'suspend', mode }, vm.id),
              }, t('suspend')),
              h('button', {
                style: S.button,
                disabled: vmBusy || !running || permissions.power !== true || !canCapability('pause'),
                onClick: () => act('pause', 'power', { id: vm.id, action: 'pause' }, vm.id),
              }, t('pause')),
              h('button', {
                style: S.button,
                disabled: vmBusy || !(paused || running) || permissions.power !== true || !canCapability('unpause'),
                onClick: () => act('resume', 'power', { id: vm.id, action: 'unpause' }, vm.id),
              }, t('resume')),
              h('button', {
                style: S.button,
                disabled: vmBusy || !(running || paused) || permissions.power !== true,
                onClick: () => act('reset', 'power', { id: vm.id, action: 'reset', mode }, vm.id),
              }, t('reset'))),
            h('div', { style: S.row },
              h('button', {
                style: S.button,
                disabled: vm.missing,
                onClick: () => setPanel(isPanel && panel.kind === 'snapshots' ? null : { id: vm.id, kind: 'snapshots' }),
              }, t('snapshots')),
              h('button', {
                style: S.button,
                disabled: vm.missing || permissions.config !== true,
                title: permissions.config === true ? t('configHint') : t('permDenied', { scope: 'config' }),
                onClick: () => setPanel(isPanel && panel.kind === 'config' ? null : { id: vm.id, kind: 'config' }),
              }, t('config')),
              h('button', {
                style: S.button,
                disabled: vm.missing || !(running || paused),
                title: t('guestInfo'),
                onClick: () => fetchGuest(vm),
              }, vmBusy && busy.endsWith(':guest') ? t('guestFetching') : t('guestInfo')),
              h('button', {
                style: S.button,
                disabled: vm.missing,
                onClick: () => act('open', 'openFolder', { id: vm.id }, vm.id, t('opened')),
              }, t('openFolder')),
              h('button', {
                style: { ...S.button, ...S.danger },
                onClick: () => setPanel(isPanel && panel.kind === 'remove' ? null : { id: vm.id, kind: 'remove' }),
              }, t('remove')),
              vmBusy ? h('span', { style: S.hint }, t('busy')) : null),
            noticeHere !== null
              ? h('div', { style: noticeHere.kind === 'error' ? S.error : S.okText }, noticeHere.text)
              : null),
          isPanel && panel.kind === 'snapshots'
            ? h(SnapshotPanel, {
              entry: vm,
              onClose: () => setPanel(null),
              onChanged: (message) => {
                setNotice({ id: vm.id, kind: 'ok', text: message })
                load({ refresh: true })
              },
            })
            : null,
          isPanel && panel.kind === 'config'
            ? h(ConfigPanel, {
              entry: vm,
              readOnly: permissions.config !== true,
              onClose: () => setPanel(null),
              onChanged: (message) => {
                setPanel(null)
                setNotice({ id: vm.id, kind: 'ok', text: message })
                load({ refresh: true })
              },
            })
            : null,
          isPanel && panel.kind === 'remove'
            ? h(RemovePanel, {
              entry: vm,
              canDelete: permissions.delete === true && canCapability('deleteVM'),
              onClose: () => setPanel(null),
              onChanged: (message) => {
                setPanel(null)
                setNotice(null)
                load({ refresh: true })
                if (typeof message === 'string' && message.length > 0) setNotice({ id: null, kind: 'ok', text: message })
              },
            })
            : null)
      }

      const permBadges = h('div', { style: { ...S.row, marginTop: '4px' } },
        h('span', { style: S.hint }, `${t('permsTitle')}:`),
        ...['power', 'snapshot', 'config', 'delete'].map((scope) => h('span', {
          key: scope,
          style: permissions[scope] === true ? S.badge : S.badgeBad,
          title: t('permHint'),
        }, `${t(`perm${scope.replace(/^./, (c) => c.toUpperCase())}`)} ${permissions[scope] === true ? t('permOn') : t('permOff')}`)))

      return h('div', { className: SCOPE, style: S.page },
        h('style', { key: 'scope-style' }, CSS),
        header,
        permBadges,
        state.error.length > 0 ? h('div', { style: S.error }, state.error) : null,
        state.notes.length > 0
          ? h('div', { style: S.hint }, state.notes.map((note) => (note.kind === 'root-missing' ? `${t('rootsMissing')}: ${note.path}` : `${note.path} (${note.depth})`)).join('　·　'))
          : null,
        rootsCard,
        addCard,
        notice !== null && notice.id === null
          ? h('div', { style: notice.kind === 'error' ? S.error : S.okText }, notice.text)
          : null,
        state.status === 'loading'
          ? h('div', { style: { color: C.textDim } }, t('loading'))
          : state.vms.length === 0
            ? h('div', { style: { color: C.textDim } }, t('empty'))
            : state.vms.map(renderVm),
        h(DiagnosticsCard, { key: 'diagnostics-card' }))
    }

    // —— 对话内卡片：按工具名分发，只影响本插件自己的四个工具 ——

    /**
     * 从工具节点里取出这次调用的形状。
     * @param block - 工具节点。
     * @returns 归一化视图，或 null。
     */
    function callOf(block) {
      if (block === null || typeof block !== 'object') return null
      const settled = Object.prototype.hasOwnProperty.call(block, 'kind')
      const call = settled ? block.call : block
      if (call === null || typeof call !== 'object') return null
      let args = {}
      try {
        const parsed = JSON.parse(call.argsRaw)
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed
      } catch {
        args = {}
      }
      return {
        settled,
        name: typeof call.name === 'string' ? call.name : '',
        args,
        text: settled ? resultTextOf(block) : '',
        isError: block.isError === true,
      }
    }

    /**
     * 取结果里的唯一文本块。
     * @param block - 已结算的工具节点。
     * @returns 输出文本。
     */
    function resultTextOf(block) {
      const content = block.content
      if (!Array.isArray(content) || content.length !== 1) return ''
      const only = content[0]
      if (only === null || typeof only !== 'object' || only.type !== 'text' || typeof only.text !== 'string') return ''
      const fenced = /^```[a-z]*\n([\s\S]*?)\n```$/.exec(only.text)
      return fenced === null ? only.text : fenced[1]
    }

    /**
     * 卡片标题：尽量复述这次调用做了什么。
     * @param call - 调用视图。
     * @param t - 取词函数。
     * @returns 标题文本。
     */
    function headlineOf(call, t) {
      const vm = typeof call.args.vm === 'string' ? call.args.vm : ''
      if (call.name === 'vm_power') return `${vm} ${call.args.action ?? ''}`.trim()
      if (call.name === 'vm_snapshot') return `${vm} ${call.args.action ?? 'list'}${call.args.name ? ` ${call.args.name}` : ''}`.trim()
      if (call.name === 'vm_config') return `${call.args.action ?? 'list'}${vm ? ` ${vm}` : ''}`.trim()
      if (call.name === 'vm_list') return vm.length > 0 ? vm : t('toolList')
      return call.name
    }

    const T = {
      card: {
        border: `0.5px solid ${C.border}`, borderRadius: C.radiusMd, overflow: 'hidden',
        background: 'rgba(0,0,0,0.14)',
      },
      head: {
        display: 'flex', alignItems: 'center', gap: '8px', padding: '5px 10px',
        borderBottom: `0.5px solid ${C.borderSubtle}`, color: C.textDim,
        fontFamily: MONO, fontSize: '11.5px', lineHeight: 1.5,
      },
      headText: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: C.text },
      pre: {
        margin: 0, padding: '8px 10px', maxHeight: '320px', overflow: 'auto',
        fontFamily: MONO, fontSize: '12px', lineHeight: 1.55,
        color: C.text, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      },
      empty: { padding: '8px 10px', color: C.textDim, fontSize: '11.5px', fontFamily: MONO },
      badge: {
        marginLeft: 'auto', flex: 'none', padding: '0 6px', borderRadius: '999px',
        border: `0.5px solid ${C.border}`, fontSize: '10.5px', color: C.textDim,
      },
      dot: { width: '7px', height: '7px', borderRadius: '50%', flex: 'none', background: C.textDim },
      dotOk: { width: '7px', height: '7px', borderRadius: '50%', flex: 'none', background: C.ok },
      dotRunning: { width: '7px', height: '7px', borderRadius: '50%', flex: 'none', background: C.info },
      dotError: { width: '7px', height: '7px', borderRadius: '50%', flex: 'none', background: C.bad },
    }

    /**
     * 对话里的虚拟机操作卡片：标题是动作，下面是一个可滚动的文本区。
     * @param props - toolview 运行时注入的阶段数据。
     * @returns 卡片视图。
     */
    function VmToolRow(props) {
      const t = useT()
      const call = callOf(props?.block)
      if (call === null) return null
      const running = !call.settled
      const failed = call.isError
      const headline = headlineOf(call, t)
      return h('div', { style: T.card },
        h('div', { style: T.head },
          h('span', { style: failed ? T.dotError : running ? T.dotRunning : T.dot, 'aria-hidden': true }),
          h('span', { style: T.headText, title: headline }, headline),
          failed ? h('span', { style: T.badge }, t('failed')) : null),
        call.text.length > 0
          ? h('pre', { style: T.pre }, call.text)
          : h('div', { style: T.empty }, running ? t('running') : t('noOutput')))
    }

    /**
     * `/vm` 命令自己的行：让它的输出也呈终端样式，而不是通用的折叠 <pre>。
     * @param props - 命令行注入的节点。
     * @returns 卡片视图。
     */
    function VmCommandRow(props) {
      const t = useT()
      const node = props?.node
      const outcome = node?.outcome
      const running = outcome === null || outcome === undefined
      const text = typeof outcome?.text === 'string' ? outcome.text : ''
      const failed = outcome?.kind === 'error'
      const name = typeof node?.name === 'string' && node.name.length > 0 ? node.name : 'vm'
      return h('div', { style: T.card },
        h('div', { style: T.head },
          h('span', { style: failed ? T.dotError : running ? T.dotRunning : T.dotOk, 'aria-hidden': true }),
          h('span', { style: T.headText }, `/${name}`),
          failed ? h('span', { style: T.badge }, t('failed')) : null),
        text.length > 0
          ? h('pre', { style: T.pre }, text)
          : h('div', { style: T.empty }, running ? t('running') : t('noOutput')))
    }

    /**
     * 从 Chat 目标快照里取出 `/vm` 的命令节点。
     *
     * DSH 的 Chat 视图只在「至少有一个非命令节点」时才被当作活跃视图，所以新会话里单独跑
     * `/vm` 的结果默认不可见。下面把这些节点找出来，交给 dock 在首条消息之前代为显示。
     *
     * @param snapshot - Chat 目标快照。
     * @returns 命令数据数组；快照不可读时为 null。
     */
    function vmCommandNodesOf(snapshot) {
      if (snapshot === undefined || snapshot === null || !Array.isArray(snapshot.order)) return null
      const nodes = snapshot.nodes
      if (nodes === undefined || typeof nodes.get !== 'function') return null
      const commands = []
      for (const key of snapshot.order) {
        const node = nodes.get(key)
        if (node?.kind === 'command' && node.data?.name === 'vm') commands.push(node.data)
      }
      return commands
    }

    /**
     * Chat 视图是否已经有非命令内容。
     * @param snapshot - Chat 目标快照。
     * @returns 有普通消息时为 true。
     */
    function chatHasTranscript(snapshot) {
      if (snapshot === undefined || snapshot === null || !Array.isArray(snapshot.order)) return false
      const nodes = snapshot.nodes
      if (nodes === undefined || typeof nodes.get !== 'function') return false
      return snapshot.order.some((key) => nodes.get(key)?.kind !== 'command')
    }

    /**
     * 首条消息之前的 `/vm` 结果面板。
     * @param props - 注入的两个 hook 与 locale 的 t。
     * @returns dock 卡片，或 null。
     */
    function VmResultDock(props) {
      const t = useT()
      const session = props.useVmSession((snapshot) => snapshot)
      const chat = props.useVmChat((snapshot) => snapshot)
      const commands = vmCommandNodesOf(chat)
      if (session?.blank !== true || chatHasTranscript(chat) || commands === null || commands.length === 0) return null
      return h('div', {
        style: { display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '38vh', overflowY: 'auto' },
        'data-vm-control-dock': '',
      },
      h('div', { style: { color: C.textDim, fontSize: '11px' } }, t('dockHint')),
      ...commands.map((command, index) => h(VmCommandRow, {
        key: `vm-${command.commandId ?? command.seq ?? index}`,
        node: command,
      })))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const locale = ctx.get('locale')
        if (locale !== undefined) {
          ctx.effect(() => locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'vm-control: dictionaries')
        }
        const loc = locale === undefined ? {} : { locale: NS }
        const label = () => (locale === undefined ? fallbackT('sectionTitle') : locale.bind(NS)('sectionTitle'))
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'vm-control',
          order: 30,
          label,
          ...loc,
        }, withLocale(VmControlSettings)))

        // 四个工具的对话内卡片：只占我们自己的名字，不覆盖任何内置 UI。
        ctx.slots.inject('tool.call.toolview', function* () {
          for (const key of ['vm_list', 'vm_power', 'vm_snapshot', 'vm_config']) {
            yield ctx.slots.register({ name: 'tool.call.toolview', key, ...loc }, withLocale(VmToolRow))
          }
        })

        ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register({
          name: 'conversation.chat.commandview',
          key: 'vm',
          ...loc,
        }, withLocale(VmCommandRow)))

        // 新会话里「只有命令、还没有任何消息」时宿主不把 Chat 视图当活跃视图，
        // `/vm` 结果因此不可见；把它渲染到输入框上方的 dock 里补上这个空档。
        const EMPTY_SOURCE = { getSnapshot: () => undefined, subscribe: () => () => {} }
        ctx.inject(['sessions', 'uiConversation'], (dockCtx) => {
          const sessions = dockCtx.sessions
          const uiConversation = dockCtx.uiConversation
          dockCtx.slots.inject('conversation.input.dock', () => dockCtx.slots.register({
            name: 'conversation.input.dock',
            id: 'vm-control-result',
            order: 6,
            ...loc,
            inject: (sessionId) => {
              let sessionSource = EMPTY_SOURCE
              let chatSource = EMPTY_SOURCE
              try {
                const binding = sessions.binding(sessionId)
                if (binding !== undefined) {
                  sessionSource = binding.session
                  chatSource = uiConversation.binding(binding).target('chat') ?? EMPTY_SOURCE
                }
              } catch {
                // 会话正在销毁等边界情况：让面板安静地不显示。
              }
              return {
                hooks: {
                  vmSession: sessionSource,
                  vmChat: chatSource,
                },
              }
            },
          }, withLocale(VmResultDock)))
        })
      },
    }
  },
})
