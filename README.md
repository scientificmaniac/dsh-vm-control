<div align="center">

# dsh-vm-control

[简体中文](README.zh-CN.md) | **English**

**VMware VM management for the DeepSeek Harness: power, snapshots, live resource use, network layout and VMX parameters in one place.**

[![tests](https://github.com/scientificmaniac/dsh-vm-control/actions/workflows/test.yml/badge.svg)](https://github.com/scientificmaniac/dsh-vm-control/actions/workflows/test.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[Changelog](CHANGELOG.md) · [Security](SECURITY.md)

</div>

## Overview

The plugin drives VMware's own `vmrun` (shipped with Workstation / Player / Fusion) and offers three complementary surfaces:

- **Four model-facing tools** — `vm_list`, `vm_power`, `vm_snapshot`, `vm_config`. The agent addresses VMs by name or vmx path.
- **Settings panel** — cards with state, specification, live CPU/memory use, NICs and paths, plus power, snapshot, config and delete actions. The list refreshes on an interval and stops while the page is hidden.
- **`/vm` command** — inspect state, power and snapshot without going through the model.

It never changes the VM file layout and never converts disks: every action becomes either one `vmrun` command or a targeted rewrite of VMX text.

## Requirements

| Item | Requirement |
| --- | --- |
| Node | ≥ 20 |
| VMware | Workstation Pro / Workstation / Player / Fusion (all ship `vmrun`) |
| Platform | Windows, macOS, Linux |
| Access | The DSH account must be able to read/write the VM folders; GUI starts need an interactive desktop session |

`vmrun` discovery order: explicit `vmrunPath` → `VMRUN_PATH` → Windows registry (`HKLM\SOFTWARE\...\VMware Workstation|Player`) → common install dirs → `PATH`. When nothing is found, both the tools and the settings page say what to install or which field to set instead of surfacing an `ENOENT`.

## Install

```bash
dsh plugin --profile desktop install dsh-vm-control
# or, inside the checkout
dsh plugin --profile desktop install .
```

**Restart DSH afterwards** — host-side tools and routes are loaded at startup.

## Quick start

1. Open **Settings → VMware VMs**.
2. Add the folder that holds your VMs under "Search roots" (for example `E:\Virtual Machines`). Existing `*.vmx` files appear; VMs created later show up automatically. VMs outside the roots can be added individually with "Add VM".
3. Use the card buttons to power, snapshot and reconfigure.
4. In the conversation, ask "start Kali and tell me how much memory it uses" — the model calls `vm_power` then `vm_list`.

## Tools

| Tool | Purpose | Typical phrasing |
| --- | --- | --- |
| `vm_list` | State, spec, live resource use, NICs, path; `vm=` for one VM | "which VMs are running" |
| `vm_power` | `start` / `stop` / `suspend` / `pause` / `unpause` / `reset` / `status` | "shut CentOS 7 down" |
| `vm_snapshot` | `list` / `create` / `revert` / `delete` | "snapshot Ubuntu before the upgrade" |
| `vm_config` | `list` / `show` / `set` / `networks` / `register` / `unregister` / `delete` | "give Kali 4 vCPUs" |

Conventions:

- **State is checked before acting.** `vm_power` refuses a nonsensical transition with an explanation instead of letting vmrun return `The virtual machine is not powered on`.
- **Actions are confirmed.** A successful `vmrun start` only means the command was accepted; the tool waits for the state to actually change and otherwise reports "issued but unconfirmed" rather than claiming success.
- **Two strengths.** `stop` / `suspend` / `reset` default to `soft` (ask the guest, needs VMware Tools); `hard` cuts power.
- **Encrypted VMs** use `credential_ref` (a DSH credential name). Only the reference is stored, and the password is fetched only when VMware reports that the VM is encrypted.
- **Three deletion semantics.** `keep_files` (drop the entry), default (move the folder into the plugin trash), `purge` (`vmrun deleteVM`, files included — needs `confirm` and `permissions.delete`).

## `/vm` command

```
/vm                                   list every VM
/vm Kali Linux status                 detail for one VM (with snapshots)
/vm Kali Linux start                  power on (also stop / suspend / pause / resume / reset)
/vm Kali Linux snapshots              list snapshots
/vm Kali Linux snap before-upgrade    create a snapshot
/vm Kali Linux delete confirm         move into the plugin trash (needs permissions.delete)
```

## Permissions

All four scopes live under `permissions` in the Loader config. Only the most destructive one is off by default:

| Scope | Default | Covers |
| --- | --- | --- |
| `power` | `true` | start, stop, suspend, pause, unpause, reset |
| `snapshot` | `true` | create / revert / delete snapshots (listing is always allowed) |
| `config` | `true` | VMX rewrites, register / unregister |
| `delete` | **`false`** | `purge` only (files included); "drop entry" and "move to trash" are not gated |

A disabled capability is refused **twice**: once in the tool layer and once in the settings API. Gating only one of them would leave the other as a bypass. The refusal message says it is a plugin configuration, not a VMware rejection.

```yaml
- id: vm-control
  name: 'dsh-vm-control'
  config:
    permissions:
      delete: false      # set true and restart DSH when you need purge
```

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `dataDir` | `%DSH_HOME%/vm-control` | Plugin data (`vms.json`, logs, trash) |
| `searchRoots` | platform VMware folders | Written on first run; the settings page then owns the list |
| `scanDepth` | `3` | Scan depth; deeper VMs must be added individually or the value raised |
| `vmrunPath` | auto-discovered | Absolute path to `vmrun` |
| `vmType` | `auto` | `ws` / `player` / `fusion` / `auto` (auto tries each) |
| `vmrunTimeoutMs` | `90000` | Default timeout per vmrun call |
| `timeoutMs` | per action | Default cap when waiting for a state change |
| `permissions` | see above | Four capability switches |
| `collectMetrics` | `true` | Sample host-side CPU/memory use |
| `logging` | `false` | `true` or `{ enabled, dir, maxBytes }`; off means nothing is written |

## How state and resources are determined

This decides whether the numbers on screen can be trusted:

- **Running state comes from `vmrun list`.** It also counts paused VMs as running, so "paused" is remembered by the plugin (written after a `pause`). A VM paused from the VMware window shows as running — a known difference that has no command-line equivalent.
- **Leftover `.vmx.lck` directories are not evidence.** VMware does not clean them up after a crash or a hard power-off; an earlier implementation trusted them and reported seven powered-off VMs as running. The file heuristic is now only used when `vmrun list` fails.
- **Suspended** is detected by the `.vmss` image: a suspend is a power-off plus a memory image, so `vmrun list` omits it.
- **Resource use comes from host processes.** Each running VM has a `vmware-vmx` process whose command line names the vmx it serves, so the process → VM mapping is exact. Windows gets CPU %, working set, private bytes, threads and IO from one PowerShell call; macOS/Linux fall back to `ps` with CPU and RSS only (no equivalent exists there, and missing fields stay empty instead of being invented).
- **Network layout comes from the VMX**: connection type (nat / bridged / hostonly / custom), virtual network (`vnet` on 17.x, `networkName` on older builds), device model and MAC. The in-guest IP needs VMware Tools and is fetched on demand only.
- **Sampling failures never hide the list**: the columns go empty with a reason and the VMs stay manageable.

## Error handling

vmrun errors are English prose where the same `Cannot open VM` may mean a bad path or a lock. Failures are classified, and each category carries where to fix it:

| Category | Meaning |
| --- | --- |
| `vm-missing` | the vmx is gone, moved, or its disk is unmounted |
| `vm-state` | the current state does not allow this action |
| `busy` | files are in use by another VMware window or a transition |
| `tools` | VMware Tools is missing or not running |
| `permission` | the host refused a file or process operation |
| `encrypted` | the VM is encrypted and needs `-vp` (configure `credential_ref`) |
| `bad-host-type` | wrong `-T` (ws / player / fusion) |
| `vmrun-missing` | `vmrun` not found |
| `timeout` | no answer within the limit; check the state before retrying |

The settings page's "Error log" is off by default; when enabled, tool and API failures are written with a stack to `dataDir/logs/diagnostics.log`, and anything shaped like `-vp <password>` is redacted first.

## Version compatibility and extensibility

- **Capability probing, not version-number comparison.** The plugin runs `vmrun` once with no arguments and parses its usage text, so "does this build support `deleteVM` / `clone` / `listHostNetworks`" has a definite answer; the UI disables unsupported buttons and the tools explain what the build lacks.
- **Host type is negotiated.** With `vmType: auto`, `ws` / `player` / `fusion` are each tried once with `list`, and the first success wins for the whole session.
- **Adding an action**: a method in `lib/vmrun.js` (argument assembly + timeout), semantic checks in `lib/inventory.js` (state, permission boundary), exposure in `index.js` / `lib/vm-api.js`, and one human sentence in `lib/format.js`. The layering is deliberate: new actions do not touch the rest of the UI.
- **Adding a tool**: register it in `index.js` and add its name to the `tool.call.toolview` key list in `client.js` to inherit the same card.

## Known limitations

- VMs paused from the VMware window appear as running.
- macOS / Linux expose only CPU and RSS — no IO breakdown or thread count.
- VMX rewrites require the VM to be powered off (VMware writes the same file); suspended is allowed with a warning that the suspend image may mismatch the new hardware.
- `purge` is irreversible; the trash only moves the folder and does not use the OS recycle bin.
- An encrypted VM's password can only reach vmrun on its command line (`-vp`) — VMware offers no other channel — so it is visible in the local process list for that process's lifetime. The plugin only does this when VMware asks for it.
- Only local VMware products are managed; ESXi / vCenter (`-T viserver`) is out of scope.

## Security

- The settings API lives under `/vm-control/` and goes through the host's `connection.requestRejection` (Host/Origin checks plus browser authentication), the same gate as the built-in `/api`.
- Except for `register`, every action first resolves the id against the inventory; **no request-body path is ever used** to read, write or spawn. `register` requires an absolute path, a `.vmx` suffix and an existing file.
- "Open folder" only opens paths the plugin computed itself (VM folder, trash, log folder) and ignores caller-supplied paths.

## Project layout

| File | Responsibility |
| --- | --- |
| `index.js` | Entry point: the four tools, permission gates, `/vm` command, settings route and locale sync |
| `client.js` | Browser half: settings page, tool cards, `/vm` command view, dock fallback panel |
| `lib/vmrun.js` | vmrun discovery, host-type negotiation, capability probing, command wrapper, failure classification |
| `lib/vmx.js` | VMX text parsing and targeted rewrites (a `.bak` is left behind) |
| `lib/inventory.js` | Merges "the vmx on disk", "what vmrun says is running" and "what the plugin remembers" into one table, and owns the state-aware actions |
| `lib/metrics.js` | Host process sampling (PowerShell / `ps`) and byte formatting |
| `lib/store.js` | `vms.json` reads and writes: atomic, serialized, self-healing |
| `lib/vm-api.js` | Settings API `/vm-control/*` (trust gate + second permission check) |
| `lib/format.js` | Renders data into model-readable text |
| `lib/i18n.js`, `lib/locales/vm.js` | Bilingual messages and runtime switching |
| `lib/diagnostics.js` | Optional error log (redacts `-vp` passwords before writing) |
| `test/*.mjs` | Unit, API, client smoke and read-only live tests |

The layering rule is simple: a new action puts **argument assembly in `vmrun.js`, semantic checks in `inventory.js`, exposure in `index.js` / `vm-api.js`, and one human sentence in `format.js`**. That keeps new actions out of the UI and prevents "the tool can do it, the panel cannot" from becoming two implementations.

## Verified environment

| Environment | Result |
| --- | --- |
| Windows 11 · VMware Workstation 17.6 (vmrun 1.17.0) · Node 26 | 7 real VMs: state, spec, NICs, disks, host network table and process sampling all pass |
| A machine without VMware | Unit / API / client tests pass; the list and tools explain what to install |

macOS (Fusion) and Linux share the same code paths and the `ps` sampler, but have not been exercised on a real Fusion host. If you hit a difference, an issue with the `vmrun` version and output is welcome.

## Tests

```bash
npm test                                   # unit + API + client smoke, no VMware required
node test/live.mjs                         # read-only live run against the local VMware
node test/live.mjs "E:\Virtual Machines"   # explicit search root
```

The live test never powers, snapshots or deletes anything; it verifies version detection, the real `vmrun list`, real VMX parsing, the host network table and process sampling. The four files divide as follows:

- `test/unit.mjs` — parsing, classification, storage, inventory semantics and permissions (with vmrun replaced by a fake);
- `test/api.mjs` — the settings API envelope, trust gate, second permission check and path sourcing;
- `test/client-smoke.mjs` — runs the `client.js` factory inside `node:vm` and checks the registration wiring plus zh/en dictionary parity;
- `test/live.mjs` — read-only verification against a real VMware installation.

## License

MIT
