# Changelog

All notable changes to this plugin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the versions follow
[Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-11-15

First release.

### Added

- Four model-facing tools: `vm_list` (state, spec, live resource use, network, path), `vm_power` (start, stop, suspend, pause, unpause, reset, status), `vm_snapshot` (list, create, revert, delete), `vm_config` (show, rewrite VMX parameters, register, unregister, delete).
- "VMware VMs" settings page: state and resource cards, power actions with soft/hard strength, snapshot panel, parameter panel, three deletion semantics (drop entry / move to trash / delete with files), search-root management, error-log switch.
- `/vm` command for the conversation: list, single-VM detail, power actions, snapshots.
- In-conversation cards for all four tools, plus a dock panel that shows `/vm` output in a fresh session where the chat view is not yet active.
- Permission model: `permissions.power/snapshot/config/delete`, with `delete` off by default; enforced in both the tool layer and the settings API.
- `vmrun` discovery (config → environment → Windows registry → install dirs → PATH) and automatic host type negotiation (ws / player / fusion).
- Capability probing: version and command list parsed from `vmrun`'s own usage text; the UI disables unsupported buttons accordingly.
- Failure classification: vm-missing / vm-state / busy / tools / permission / encrypted / bad-host-type / vmrun-missing / timeout, each with a "where to fix it" line.
- Power actions wait for and confirm the state change, and report "issued but unconfirmed" when the state does not settle.
- Host-side resource sampling: PowerShell on Windows (CPU %, working set, private bytes, threads, IO), `ps` fallback on macOS/Linux (CPU, RSS).
- Chinese / English throughout, following DSH's Settings → General → Language; both the UI and tool output switch.
- Zero dependencies, zero build: plain ESM on the host, hand-written React elements on the client.

### Design notes

- **Running state comes from `vmrun list`.** Leftover `.vmx.lck` directories survive crashes and hard power-offs; trusting them reported powered-off VMs as running. The file heuristic is now only a fallback when the list cannot be read.
- **Pause state is recorded by the plugin.** `vmrun list` counts paused VMs as running and exposes no second status bit, so a VM paused from the VMware window shows as running.
- **Rename and delete require explicit intent.** Deleting needs a mode, and `purge` needs `confirm`; VMs sharing a name are listed with their path, and ambiguous lookups fail instead of guessing.
