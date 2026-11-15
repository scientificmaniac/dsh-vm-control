/**
 * 虚拟机插件的双语文案。
 *
 * 键名按来源分组：`vm.*` 是工具输出与状态词，`err.*` 是失败归因（每条都给出「该往哪里修」），
 * `api.*` 是设置接口的错误，`cmd.*` 是 `/vm` 命令。两边必须一一对应——`test/unit.mjs`
 * 会逐键比对，缺一边就算失败，免得某天英文界面里冒出中文句子。
 *
 * @module dsh-vm-control/locales/vm
 */

/** 文案表：键名 → `{ zh, en }`。 */
export const VM_MESSAGES = {
  // —— 平台 ——
  'platform.unsupported': {
    zh: 'dsh-vm-control 需要 VMware 提供的 vmrun，目前只支持 Windows、macOS 与 Linux，当前平台是 {platform}（{raw}）。',
    en: 'dsh-vm-control drives VMware\'s vmrun, which ships for Windows, macOS and Linux only; the current platform is {platform} ({raw}).',
  },

  // —— 状态词 ——
  'vm.state.running': { zh: '运行中', en: 'running' },
  'vm.state.paused': { zh: '已暂停', en: 'paused' },
  'vm.state.suspended': { zh: '已挂起', en: 'suspended' },
  'vm.state.stopped': { zh: '已停止', en: 'stopped' },
  'vm.state.missing': { zh: '文件缺失', en: 'missing' },
  'vm.state.unknown': { zh: '未知', en: 'unknown' },

  // —— 产品与主机类型 ——
  'vm.product.ws': { zh: 'VMware Workstation', en: 'VMware Workstation' },
  'vm.product.player': { zh: 'VMware Player', en: 'VMware Player' },
  'vm.product.fusion': { zh: 'VMware Fusion', en: 'VMware Fusion' },
  'vm.product.unknown': { zh: 'VMware', en: 'VMware' },
  'vm.typeMissing': { zh: '未探测', en: 'not probed' },

  // —— 列表输出 ——
  'vm.listHeader': {
    zh: '{product}（vmrun {version}，类型 {hostType}）· 共 {count} 台虚拟机：{running} 运行 / {paused} 暂停 / {suspended} 挂起 / {stopped} 停止',
    en: '{product} (vmrun {version}, type {hostType}) — {count} VMs: {running} running / {paused} paused / {suspended} suspended / {stopped} stopped',
  },
  'vm.listHeaderNoVms': {
    zh: '{product}（vmrun {version}，类型 {hostType}）· 搜索目录里没有找到虚拟机',
    en: '{product} (vmrun {version}, type {hostType}) — no virtual machine found in the search roots',
  },
  'vm.line': {
    zh: '- {name}  [{state}]  {cpus} vCPU / {memory} MB{resource}{network}',
    en: '- {name}  [{state}]  {cpus} vCPU / {memory} MB{resource}{network}',
  },
  'vm.moreVms': {
    zh: '……还有 {n} 台未列出：用 vm_list 的 root 或 vm 参数缩小范围。',
    en: '…{n} more not shown: narrow the scope with vm_list root or vm.',
  },
  'vm.resourceAllocated': {
    zh: '  cpu {cpu}% · 内存 {rss} / {memory} MB · 线程 {threads}',
    en: '  cpu {cpu}% · memory {rss} of {memory} MB · {threads} threads',
  },
  'vm.resourceAllocatedNoThreads': {
    zh: '  cpu {cpu}% · 内存 {rss} / {memory} MB',
    en: '  cpu {cpu}% · memory {rss} of {memory} MB',
  },
  'vm.pathLine': { zh: '  vmx: {path}', en: '  vmx: {path}' },
  'vm.notesLine': { zh: '  备注: {notes}', en: '  note: {notes}' },
  'vm.tagsLine': { zh: '  标签: {tags}', en: '  tags: {tags}' },
  'vm.nicLine': {
    zh: '  网卡 {index}: {mode}{network} · {dev} · {mac}{connected}',
    en: '  nic {index}: {mode}{network} · {dev} · {mac}{connected}',
  },
  'vm.nicConnected': { zh: ' · 启动时连接', en: ' · connects at power on' },
  'vm.diskLine': { zh: '  {device} → {file}', en: '  {device} → {file}' },
  'vm.diskKindCdrom': { zh: '光驱', en: 'cdrom' },
  'vm.cpuDetail': { zh: '{cpus}（{sockets} 插槽 × {cores} 核）', en: '{cpus} ({sockets} sockets × {cores} cores)' },
  'vm.guestLine': { zh: '  VMware Tools: {tools}{ip}', en: '  VMware Tools: {tools}{ip}' },

  // —— 详情用的字段名 ——
  'vm.field.state': { zh: '状态', en: 'state' },
  'vm.field.guestOs': { zh: '客户机系统', en: 'guest OS' },
  'vm.field.cpu': { zh: 'vCPU', en: 'vCPU' },
  'vm.field.memory': { zh: '内存', en: 'memory' },
  'vm.field.hw': { zh: '硬件版本', en: 'hardware version' },
  'vm.field.firmware': { zh: '固件', en: 'firmware' },
  'vm.field.tools': { zh: 'VMware Tools', en: 'VMware Tools' },
  'vm.field.encrypted': { zh: '加密', en: 'encrypted' },
  'vm.field.folder': { zh: '目录', en: 'folder' },
  'vm.field.yes': { zh: '是', en: 'yes' },
  'vm.field.none': { zh: '无', en: 'none' },

  // —— 查找与解析 ——
  'vm.notFound': {
    zh: '找不到虚拟机「{ref}」。{hint}',
    en: 'No virtual machine named "{ref}". {hint}',
  },
  'vm.knownVms': { zh: '当前可用：{list}。', en: 'Available: {list}.' },
  'vm.knownVmsEmpty': {
    zh: '当前没有任何虚拟机，先在设置页添加 vmx 或填写搜索目录。',
    en: 'There are no VMs yet: add a vmx file or a search root in Settings.',
  },
  'vm.ambiguous': {
    zh: '「{ref}」匹配到多台虚拟机：{list}。请改用完整 vmx 路径。',
    en: '"{ref}" matches several VMs: {list}. Use the full vmx path instead.',
  },
  'vm.permissionDenied': {
    zh: '插件配置禁止该操作（permissions.{scope} = false）。这是 Loader 里的权限设置，不是 VMware 的拒绝；'
      + '需要时在插件配置里改成 true 并重启 DSH。',
    en: 'The plugin configuration forbids this operation (permissions.{scope} = false). This is the Loader permission gate, '
      + 'not a refusal from VMware; set it to true in the plugin config and restart DSH if you need it.',
  },
  'vm.vmrunMissing': {
    zh: '找不到 vmrun。VMware Workstation / Player / Fusion 都自带它：确认已安装 VMware，'
      + '或在插件配置的 vmrunPath 里写绝对路径（如 C:\\Program Files (x86)\\VMware\\VMware Workstation\\vmrun.exe）。',
    en: 'vmrun was not found. VMware Workstation / Player / Fusion ships it: check that VMware is installed, '
      + 'or set an absolute vmrunPath in the plugin config (for example C:\\Program Files (x86)\\VMware\\VMware Workstation\\vmrun.exe).',
  },
  'vm.noRoots': {
    zh: '没有可搜索的目录：在设置页的「搜索目录」里加入虚拟机所在目录，或直接添加某个 .vmx 文件。',
    en: 'No search roots configured: add the folder that holds your VMs under "Search roots" in Settings, or add a single .vmx file.',
  },
  'vm.rootMissing': { zh: '搜索目录不存在：{path}', en: 'Search root does not exist: {path}' },
  'vm.scanTruncated': {
    zh: '搜索目录 {path} 的扫描在 {n} 层后停止，更深的虚拟机需要单独添加或提高 scanDepth。',
    en: 'The scan of {path} stopped at depth {n}; deeper VMs need to be added individually or scanDepth raised.',
  },
  'vm.guestUnavailable': {
    zh: '取不到客户机信息：虚拟机未运行，或 VMware Tools 未安装 / 未就绪。',
    en: 'Guest information is unavailable: the VM is not running, or VMware Tools is not installed / not ready.',
  },

  // —— 电源操作 ——
  'vm.powerDone': {
    zh: '{name}：{from} → {to}（{action}）',
    en: '{name}: {from} → {to} ({action})',
  },
  'vm.powerAlready': {
    zh: '{name} 已经是{state}，没有执行 {action}。',
    en: '{name} is already {state}; {action} was not run.',
  },
  'vm.powerTimeout': {
    zh: '已发出 {action}，但 {ms}ms 内状态仍是 {state}。虚拟机的启动 / 关机可能比这个时限更慢；'
      + '稍后再用 vm_list 或 action=status 确认，不要重复下发同一条命令。',
    en: 'The {action} command was issued, but the state is still {state} after {ms}ms. Boot and shutdown can take longer than this limit; '
      + 'check again with vm_list or action=status instead of sending the same command twice.',
  },
  'vm.powerFailed': { zh: '{name} — {action} 失败：', en: '{name} — {action} failed:' },
  'vm.deleteNeedsStopped': {
    zh: '{name} 当前是{state}：先把虚拟机关机（vm_power stop），再删除。',
    en: '{name} is {state}: stop it first (vm_power stop), then delete.',
  },
  'vm.deleteFailed': { zh: '删除 {name} 失败：', en: 'Deleting {name} failed:' },
  'vm.stateWarning': {
    zh: '注意：{reason} 下面的运行态可能不准确，请以 VMware 窗口为准。',
    en: 'Note: {reason} the states below may be inaccurate; trust the VMware window instead.',
  },
  'vm.stateWarningStale': { zh: '无法读取运行中的虚拟机列表；', en: 'the running-VM list could not be read;' },
  'vm.metricsUnavailable': {
    zh: '资源占用采集不可用（{error}）：CPU 与内存一栏会留空，虚拟机本身不受影响。',
    en: 'Resource sampling is unavailable ({error}): the CPU and memory columns stay empty; the VMs themselves are unaffected.',
  },
  'vm.startGuiHint': {
    zh: '已用图形界面启动；若 DSH 以服务身份运行，窗口可能出现在另一个桌面会话里。'
      + '无人值守场景请用 gui=false（nogui）。',
    en: 'Started with the GUI; if DSH runs as a service the window may appear in another desktop session. '
      + 'Use gui=false (nogui) for unattended use.',
  },

  // —— 快照 ——
  'vm.snapshotsHeader': { zh: '快照（{count}）：', en: 'Snapshots ({count}):' },
  'vm.snapshotsNone': { zh: '这台虚拟机还没有快照。', en: 'This VM has no snapshots yet.' },
  'vm.snapshotLine': {
    zh: '- {name}{current}{depth}{note}{created}',
    en: '- {name}{current}{depth}{note}{created}',
  },
  'vm.snapshotCreated': { zh: '已为 {name} 创建快照「{snapshot}」。', en: 'Created snapshot "{snapshot}" on {name}.' },
  'vm.snapshotReverted': {
    zh: '已把 {name} 回滚到快照「{snapshot}」。快照之后写入的磁盘内容已丢失，这是回滚的语义，不是失败。',
    en: 'Reverted {name} to snapshot "{snapshot}". Disk changes made after that snapshot are gone — that is what a revert means, not a failure.',
  },
  'vm.snapshotDeleted': { zh: '已删除 {name} 上的快照「{snapshot}」{children}。', en: 'Deleted snapshot "{snapshot}" from {name}{children}.' },
  'vm.snapshotWithChildren': { zh: '（含其子快照）', en: ' (including child snapshots)' },
  'vm.snapshotMissing': {
    zh: '{name} 上没有名为「{snapshot}」的快照。可用：{list}。',
    en: '{name} has no snapshot named "{snapshot}". Available: {list}.',
  },
  'vm.snapshotNote': { zh: '（备注：{note}）', en: ' (note: {note})' },
  'vm.snapshotCreatedAt': { zh: '（创建于 {at}）', en: ' (created {at})' },
  'vm.snapshotCurrent': { zh: ' ← 当前', en: ' ← current' },
  'vm.snapshotDepth': { zh: '（层级 {n}）', en: ' (depth {n})' },

  // —— 配置 ——
  'vm.configNeedsPowerOff': {
    zh: '{name} 当前是{state}。VMX 只能在关机状态下改写——请先关机（vm_power stop），'
      + '或改用 VMware 界面里的「虚拟机设置」在运行中调整可热插拔的设备。',
    en: '{name} is {state}. The VMX can only be rewritten while the VM is powered off — stop it first (vm_power stop), '
      + 'or change hot-pluggable devices from the VMware UI instead.',
  },
  'vm.configSuspended': {
    zh: '提示：{name} 处于挂起状态，改写 VMX 后挂起镜像可能与新硬件配置不匹配；建议关机后再改。',
    en: 'Note: {name} is suspended; after rewriting the VMX the suspend image may no longer match the new hardware. Powering it off first is safer.',
  },
  'vm.configBackup': { zh: '（改前的 VMX 已备份到 {path}）', en: '(the previous VMX was backed up to {path})' },
  'vm.configLine': { zh: '  {key}: {value}', en: '  {key}: {value}' },
  'vm.configChanged': { zh: '已更新 {name} 的配置：{changes}', en: 'Updated {name}: {changes}' },
  'vm.configNoChanges': {
    zh: '没有需要写入的改动（给出的值与当前配置相同）。',
    en: 'Nothing to write: every given value already matches the current configuration.',
  },
  'vm.registered': {
    zh: '已添加 {name}（{path}）。插件只记录路径，不会复制或移动虚拟机文件。',
    en: 'Added {name} ({path}). The plugin only records the path; VM files are not copied or moved.',
  },
  'vm.unregistered': {
    zh: '已从插件列表移除 {name}，磁盘上的虚拟机文件保持原样。',
    en: 'Removed {name} from the plugin list; the VM files on disk are untouched.',
  },
  'vm.unregisterMissing': {
    zh: '已从插件列表移除失效记录 {name}（其 vmx 文件已不存在）。',
    en: 'Removed the stale entry {name} (its vmx file no longer exists).',
  },
  'vm.deletedPurge': {
    zh: '已删除 {name} 及其全部磁盘文件（vmrun deleteVM）。这一步不可恢复。',
    en: 'Deleted {name} and all of its disk files (vmrun deleteVM). This cannot be undone.',
  },
  'vm.deletedTrash': {
    zh: '已把 {name} 的目录整体移动到回收站目录 {trash}。确认无误后可自行删除该目录。',
    en: 'Moved the folder of {name} into the plugin trash at {trash}. Delete that folder yourself once you are sure.',
  },
  'vm.deleteNeedsConfirm': {
    zh: '删除不可撤销（彻底删除会连磁盘文件一起删掉）。确认时把 confirm 设为 true，并选择 purge=true（彻底删除）'
      + '或 keep_files=true（只移除记录）。',
    en: 'Deletion cannot be undone (purge removes the disk files too). Pass confirm=true and choose either purge=true '
      + '(delete everything) or keep_files=true (drop the entry only).',
  },
  'vm.trashBlocked': {
    zh: '没有移动 {name}：目录 {folder} 里还有其它虚拟机（{others}）。移动整个目录会一起带走它们，'
      + '请用 keep_files=true 只移除记录，或手工整理目录后再删。',
    en: 'Not moving {name}: the folder {folder} still holds other VMs ({others}). Moving it would take them along; '
      + 'use keep_files=true to drop just the entry, or tidy the folder first.',
  },

  // —— 失败归因（分类 + 修复方向） ——
  'err.catVmMissing': {
    zh: '目标层：vmx 文件不存在或不可读——路径拼错、虚拟机被移动，或所在磁盘没挂载。',
    en: 'Target layer: the vmx file is missing or unreadable — a mistyped path, a moved VM, or an unmounted disk.',
  },
  'err.catVMRunMissing': {
    zh: '环境层：找不到 vmrun 可执行文件，VMware 可能未安装或安装路径未在插件配置里指定。',
    en: 'Environment layer: the vmrun executable is missing; VMware may not be installed, or vmrunPath is not set.',
  },
  'err.catHostType': {
    zh: '环境层：vmrun 不认这个主机类型（-T）。Workstation 用 ws，Player 用 player，Fusion 用 fusion。',
    en: 'Environment layer: vmrun rejected the host type (-T). Use ws for Workstation, player for Player, fusion for Fusion.',
  },
  'err.catVmState': {
    zh: '状态层：虚拟机当前的状态不允许这个操作（例如对已关机的虚拟机执行 suspend，或对运行中的执行 start）。',
    en: 'State layer: the VM\'s current state does not allow this operation (suspending a powered-off VM, starting a running one, …).',
  },
  'err.catBusy': {
    zh: '占用层：虚拟机文件被占用——另一个 VMware 窗口 / 进程正在使用它，或上一次状态切换还没结束。',
    en: 'Lock layer: the VM files are in use — another VMware window or process holds them, or the previous transition has not finished.',
  },
  'err.catTools': {
    zh: '客户机层：VMware Tools 未安装或未运行，需要 Tools 的操作（客户机 IP、客户机内命令）无法执行。',
    en: 'Guest layer: VMware Tools is not installed or not running, so operations that need it (guest IP, in-guest commands) cannot run.',
  },
  'err.catPermission': {
    zh: '权限层：宿主拒绝了文件或进程操作。Windows 上常见于以服务身份运行 DSH、或虚拟机位于受保护目录。',
    en: 'Permission layer: the host refused a file or process operation. On Windows this is common when DSH runs as a service, or the VM lives in a protected folder.',
  },
  'err.catTimeout': {
    zh: '超时层：vmrun 在时限内没有返回。关机 / 启动本身可能很慢，先确认状态再决定是否重试。',
    en: 'Timeout layer: vmrun did not return in time. Power operations can be slow; check the state before retrying.',
  },
  'err.catEncrypted': {
    zh: '加密层：这台虚拟机是加密的，vmrun 需要加密口令（-vp）才能操作。',
    en: 'Encryption layer: this VM is encrypted, so vmrun needs the encryption password (-vp) to work with it.',
  },
  'err.catUnknown': {
    zh: '未分类层：vmrun 返回了非零退出码，但没有匹配到已知错误形态，原始输出是唯一线索。',
    en: 'Unclassified layer: vmrun exited non-zero without matching a known failure shape; the raw output is the only clue.',
  },
  'err.vmrunFailed': {
    zh: 'vmrun {command} 失败（退出码 {code}）：',
    en: 'vmrun {command} failed (exit code {code}):',
  },
  'err.vmrunFailedNoCode': {
    zh: 'vmrun {command} 失败：',
    en: 'vmrun {command} failed:',
  },
  'err.incompleteTimeout': {
    zh: '⚠ 输出不完整：vmrun 在超时后被终止，虚拟机状态可能仍在变化。',
    en: '⚠ INCOMPLETE OUTPUT: vmrun was terminated after the timeout and the VM state may still be changing.',
  },
  'err.hintVmMissing': {
    zh: '修复方向：在设置页确认 vmx 路径仍然有效；vm_list 会把「已登记但文件缺失」的虚拟机标成 missing。',
    en: 'Fix: verify the vmx path still exists in Settings; vm_list marks registered VMs whose file is gone as missing.',
  },
  'err.hintVmState': {
    zh: '修复方向：先用 vm_list 或 action=status 看当前状态，再选择对应的动作（停止后才能 start，运行中才能 pause）。',
    en: 'Fix: check the current state with vm_list or action=status first, then pick a matching action (start needs a stopped VM, pause needs a running one).',
  },
  'err.hintBusy': {
    zh: '修复方向：关掉正在使用该虚拟机的 VMware 窗口，或等上一次操作结束；反复重试只会继续撞锁。',
    en: 'Fix: close the VMware window that holds this VM, or wait for the previous operation to finish; retrying only hits the same lock.',
  },
  'err.hintTools': {
    zh: '修复方向：启动虚拟机后在 VMware 里安装 / 更新 VMware Tools，再重试 guest 信息相关操作。',
    en: 'Fix: install or update VMware Tools inside the VM after starting it, then retry the guest-related operation.',
  },
  'err.hintPermission': {
    zh: '修复方向：确认运行 DSH 的账号对虚拟机目录有读写权限；Windows 下不要以受限服务账号运行需要 GUI 的启动。',
    en: 'Fix: make sure the account running DSH can read and write the VM folder; on Windows do not run GUI starts under a restricted service account.',
  },
  'err.hintHostType': {
    zh: '修复方向：在插件配置里把 vmType 改成 ws / player / fusion，或保持 auto 让插件逐个尝试。',
    en: 'Fix: set vmType to ws / player / fusion in the plugin config, or keep auto so the plugin tries each in turn.',
  },
  'err.hintVMRunMissing': {
    zh: '修复方向：安装 VMware Workstation / Player / Fusion，或在插件配置里用 vmrunPath 指定绝对路径。',
    en: 'Fix: install VMware Workstation / Player / Fusion, or point vmrunPath at an absolute path in the plugin config.',
  },
  'err.hintEncrypted': {
    zh: '修复方向：在设置页给这台虚拟机填 credentialRef（DSH 凭据名）。口令由宿主凭据服务在调用时解析，'
      + '插件不保存明文；注意 vmrun 只接受命令行上的 -vp，口令会在该进程的短暂生命周期内出现在本机进程列表里。',
    en: 'Fix: give this VM a credentialRef in Settings (a DSH credential name). The host credential service resolves it at call time and '
      + 'the plugin stores no plaintext; note vmrun only accepts -vp on its command line, so the password is visible in the local process list for that short window.',
  },
  'err.hintTimeout': {
    zh: '修复方向：用 action=status 看状态是否已经变化；确实没变再重试，并考虑把 timeoutMs 调大。',
    en: 'Fix: check with action=status whether the state already changed; retry only if it did not, and consider a larger timeoutMs.',
  },
  'err.credentialsAbsent': {
    zh: '这台虚拟机需要加密口令（credentialRef={ref}），但当前 DSH 没有凭据服务，无法解析。'
      + '请改用非加密虚拟机，或在不加密的 DSH 组合里运行。',
    en: 'This VM needs its encryption password (credentialRef={ref}), but the running DSH has no credential service to resolve it. '
      + 'Use an unencrypted VM, or run on a DSH build that provides credentials.',
  },
  'err.credentialUnresolved': {
    zh: '凭据「{ref}」没有解析出可用的口令：请在 DSH 凭据设置里确认它已配置且未过期。',
    en: 'The credential "{ref}" did not resolve to a usable password: check that it is configured and current in the DSH credential settings.',
  },
  'err.hintUnknown': {
    zh: '修复方向：把原始 stderr 一起看；在设置页打开「错误日志」后，同样的报错会带堆栈落盘。',
    en: 'Fix: read the raw stderr; after enabling the error log in Settings the same failure is recorded with a stack trace.',
  },
  'err.unsupportedCommand': {
    zh: '当前 vmrun（{version}，类型 {hostType}）不支持命令「{command}」：它的用法说明里没有这一项。'
      + '这通常意味着 VMware 版本较旧，或主机类型选错（Player 缺少部分管理命令）。可升级 VMware 或改用 Workstation。',
    en: 'This vmrun ({version}, type {hostType}) does not support the "{command}" command: it is absent from its usage text. '
      + 'That usually means an older VMware build or the wrong host type (Player omits some management commands). Upgrade VMware or use Workstation.',
  },
  'err.capabilitiesUnknown': {
    zh: '提示：没能从 vmrun 的用法输出里解析出命令列表，已按 Workstation 的完整命令集处理；失败时可能只是命令不被支持。',
    en: 'Note: the command list could not be parsed from vmrun\'s usage text, so the full Workstation command set is assumed; a failure here may simply mean the command is unsupported.',
  },

  // —— 设置接口错误 ——
  'api.methodPostOnly': { zh: '只接受 POST 请求。', en: 'Only POST requests are accepted.' },
  'api.routeUnknown': { zh: '未知的设置接口路径。', en: 'Unknown settings API route.' },
  'api.bodyInvalid': { zh: '请求体不是合法 JSON 对象（或超过大小上限）。', en: 'The request body is not a valid JSON object (or exceeds the size limit).' },
  'api.unknownAction': { zh: '未知操作：{action}', en: 'Unknown action: {action}' },
  'api.permissionDenied': {
    zh: '插件配置禁止该操作：permissions.{scope} 为 false。改配置后需要重启 DSH。',
    en: 'The plugin configuration forbids this operation: permissions.{scope} is false. Restart DSH after changing it.',
  },
  'api.vmRequired': { zh: '缺少虚拟机标识（id 或 vmx 路径）。', en: 'A VM identifier (id or vmx path) is required.' },
  'api.confirmRequired': {
    zh: '删除是不可撤销的操作，请在界面里再确认一次（confirm）。',
    en: 'Deleting cannot be undone; confirm once more in the UI (confirm).',
  },
  'api.cpusInvalid': { zh: 'vCPU 数量必须是 1 到 {max} 之间的整数。', en: 'The vCPU count must be an integer between 1 and {max}.' },
  'api.memoryInvalid': { zh: '内存必须是 4 到 {max} MB 之间的整数（按 4 MB 对齐）。', en: 'Memory must be an integer between 4 and {max} MB, in steps of 4 MB.' },
  'api.nicModeInvalid': {
    zh: '网卡连接方式只支持 nat / bridged / hostonly / custom。',
    en: 'The NIC connection type must be nat, bridged, hostonly or custom.',
  },
  'api.nicNameRequired': { zh: 'connectionType=custom 时必须给出虚拟网络名（如 VMnet2）。', en: 'connectionType=custom requires a virtual network name (for example VMnet2).' },
  'api.vmxRequired': { zh: '请给出 .vmx 文件的绝对路径。', en: 'An absolute path to a .vmx file is required.' },
  'api.vmxNotAbsolute': { zh: '请给出绝对路径：{path}', en: 'An absolute path is required: {path}' },
  'api.vmxMissing': { zh: '该路径不存在或是目录：{path}', en: 'That path does not exist, or is a directory: {path}' },
  'api.vmxNotVmx': { zh: '这不是 .vmx 文件：{path}', en: 'That is not a .vmx file: {path}' },
  'api.nameTaken': {
    zh: '虚拟机名「{name}」已被 {path} 使用；给这台换一个名字，或直接用 vmx 路径引用。',
    en: 'The VM name "{name}" is already used by {path}; pick another name, or refer to this VM by its vmx path.',
  },
  'api.rootsInvalid': { zh: '搜索目录必须是绝对路径的字符串数组。', en: 'Search roots must be an array of absolute path strings.' },
  'api.snapshotNameRequired': { zh: '快照名不能为空。', en: 'A snapshot name is required.' },
  'api.folderOpenFailed': { zh: '无法打开目录：{message}', en: 'Could not open the folder: {message}' },
  'api.diagnosticsUnavailable': { zh: '当前没有可用的诊断日志。', en: 'No diagnostics log is available.' },
  'api.powerInvalidAction': { zh: '不支持的电源动作：{action}', en: 'Unsupported power action: {action}' },
  'api.snapshotInvalidAction': { zh: '不支持的快照动作：{action}', en: 'Unsupported snapshot action: {action}' },

  // —— 数据文件 ——
  'store.corrupt': {
    zh: '插件数据文件已损坏，已备份为 {backup} 并重新开始：{message}',
    en: 'The plugin data file was corrupt; it was backed up to {backup} and a fresh one was started: {message}',
  },
  'store.writeFailed': { zh: '写入插件数据文件失败：{message}', en: 'Writing the plugin data file failed: {message}' },

  // —— /vm 命令 ——
  'cmd.description': {
    zh: '查看本机 VMware 虚拟机状态，或对指定虚拟机执行电源与快照操作',
    en: 'Show local VMware VM state, or run power and snapshot actions on a VM',
  },
  'cmd.hint': {
    zh: '虚拟机名 start|stop|suspend|pause|resume|reset|status|snapshots|snap <快照名>（直接回车列出全部）',
    en: 'vm-name start|stop|suspend|pause|resume|reset|status|snapshots|snap <name> (press Enter alone to list all)',
  },
  'cmd.usage': {
    zh: '用法：`/vm` 列出全部；`/vm 名称 status` 看单台；`/vm 名称 start|stop|suspend|pause|resume|reset` 执行电源操作；'
      + '`/vm 名称 snapshots` 列快照；`/vm 名称 snap 快照名` 新建快照。',
    en: 'Usage: `/vm` lists everything; `/vm name status` inspects one; `/vm name start|stop|suspend|pause|resume|reset` powers it; '
      + '`/vm name snapshots` lists snapshots; `/vm name snap name` creates one.',
  },
  'cmd.empty': {
    zh: '没有找到虚拟机。先在「设置 → VMware 虚拟机」里添加搜索目录或 vmx 文件。',
    en: 'No VMs found. Add a search root or a vmx file in Settings → VMware VMs first.',
  },
  'cmd.unknownAction': {
    zh: '不认识的动作「{action}」。{usage}',
    en: 'Unknown action "{action}". {usage}',
  },
}
