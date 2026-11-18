<div align="center">

# dsh-vm-control

[简体中文](README.zh-CN.md) | **English**

**VMware VM management for the DeepSeek Harness: power, snapshots, live resource use, network layout and VMX parameters in one place.**

<!-- npm -->
[![npm version](https://img.shields.io/npm/v/dsh-vm-control.svg)](https://www.npmjs.com/package/dsh-vm-control)
[![npm downloads](https://img.shields.io/npm/dm/dsh-vm-control.svg)](https://www.npmjs.com/package/dsh-vm-control)
[![npm license](https://img.shields.io/npm/l/dsh-vm-control.svg)](https://www.npmjs.com/package/dsh-vm-control)
[![node](https://img.shields.io/node/v/dsh-vm-control.svg)](https://nodejs.org/)
[![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](package.json)

<!-- repo -->
[![tests](https://github.com/scientificmaniac/dsh-vm-control/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/scientificmaniac/dsh-vm-control/actions/workflows/test.yml)
[![GitHub stars](https://img.shields.io/github/stars/scientificmaniac/dsh-vm-control.svg)](https://github.com/scientificmaniac/dsh-vm-control)
[![GitHub issues](https://img.shields.io/github/issues/scientificmaniac/dsh-vm-control.svg)](https://github.com/scientificmaniac/dsh-vm-control/issues)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/scientificmaniac/dsh-vm-control/pulls)

[Changelog](CHANGELOG.md) · [Security](SECURITY.md)

</div>

## Overview

The plugin drives VMware's own `vmrun` (shipped with Workstation / Player / Fusion) and offers three complementary surfaces:

- **Four model-facing tools** — `vm_list`, `vm_power`, `vm_snapshot`, `vm_config`. The agent addresses VMs by name or vmx path.
- **Settings panel** — cards with state, specification, live CPU/memory use, NICs and paths, plus power, snapshot, config and delete actions. The list refreshes on an interval and stops while the page is hidden.
- **`/vm` command** — inspect state, power and snapshot without going through the model.
- **dsh-ssh-vault integration** — pick a VM and push its address, port, user and auth into the SSH vault in one step; degrades to a copyable command when that plugin is absent. See [the integration section](#dsh-ssh-vault-integration).

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
| `vm_config` | `list` / `show` / `set` / `networks` / `ssh` / `register` / `unregister` / `delete` | "give Kali 4 vCPUs" |

Conventions:

- **State is checked before acting.** `vm_power` refuses a nonsensical transition with an explanation instead of letting vmrun return `The virtual machine is not powered on`.
- **Actions are confirmed.** A successful `vmrun start` only means the command was accepted; the tool waits for the state to actually change and otherwise reports "issued but unconfirmed" rather than claiming success. An unconfirmed result means "no result was seen", not "the operation failed" — read the state again instead of resending. `timeoutMs` is the total budget for the whole call (vmrun plus the confirmation that follows), not a separate timer for each.
- **A timeout is not a failure.** Killing vmrun on timeout only means it did not return in time; the start request had already reached VMware. The tool therefore does not report failure — it reads the real state and concludes from that, saying so in the output. Only an explicit vmrun error (a missing vmx, say) counts as failure.
- **Prefer a headless start.** `gui: true` waits for the VMware window, is markedly slower and needs a desktop session; use the default `nogui` for scripted work and open the VMware window separately when someone needs to watch. GUI starts therefore get their own 60 s default timeout.
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

## dsh-ssh-vault integration

Once a VM runs sshd, the natural next step is to add it to the SSH vault (`dsh-ssh-vault`). This plugin turns that into "pick the VM → press import → confirm".

**Entry points**

| Entry | What happens |
| --- | --- |
| Settings · VM card · "SSH import" | Opens the panel: probes the vault, prepares suggested values, writes on confirm |
| `vm_config action=ssh vm=<name>` | Returns the proposal (alias / host / user / auth / equivalent command) plus where to click |

Tools deliberately **cannot** write the vault: its ciphertext is encrypted with ssh-vault's own key and no other plugin has a legitimate way to write that file. The model prepares the data and tells you where to confirm.

**Field scope**

| Field | Source |
| --- | --- |
| `alias` | The VM name normalised (non-ASCII folded into separators); a `-2` suffix when two VMs collide |
| `host` | The guest IP reported by VMware Tools; left empty when unavailable |
| `port` | 22 by default, editable in the panel |
| `username` | `root` suggested for Linux / BSD guests, empty otherwise |
| `authType` / `privateKeyPath` / `password` / `passphrase` | Key auth when a default key exists (`~/.ssh/id_ed25519` → `id_ecdsa` → `id_rsa`), password auth otherwise (you type it) |
| `description` / `tags` | `<VM name> · VMware`, tags `vmware` plus the VM's own tags |

**Not imported**: `sudoPassword`, `bindAddress`, private-key uploads, alias renames. They are either unrelated to the VM or belong to you in the vault's own page — the field list is a fixed allow-list, because sending one extra field means deciding something on the user's behalf.

**Success and failure**

- Success: `Imported into the SSH vault as <alias>` plus a hint that `ssh_run` can use it. An existing alias is an **update**, and the message says so.
- Failure: ssh-vault's own message is shown verbatim (invalid alias, missing password, unreadable key …). It owns those rules; the local form only pre-checks formats to save a round trip.
- The panel warns when the alias already exists ("saving overwrites it") and offers a one-press rename.

**When it is missing or unavailable**

The panel probes with `POST ssh-vault/list` (2.5 s timeout):

| Probe result | Behaviour |
| --- | --- |
| Route missing (404, or an HTML fallback) | "dsh-ssh-vault was not detected" + install command + the SSH command stays **copyable** for any other client |
| 401 / 403 | Says the host rejected the request; refresh and retry |
| Other error | Shows the reason; editing and copying still work |

So an absent sibling locks nothing: power, snapshots, parameters and deletion behave as before, and the import degrades into "the command, already assembled".

**Permissions**: the import follows `permissions.config` — when false the button is disabled with an explanation (writing another plugin's configuration is a config-level action). Probing and copying stay available.

**Security**: the password appears only in the single request to dsh-ssh-vault; this plugin does not persist it, log it, or read the vault back, and it never reuses the VM encryption password as an SSH password.

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
| `timeoutMs` | per action | Total budget for a whole power call (vmrun plus confirmation); GUI starts default to 60 s |
| `permissions` | see above | Four capability switches |
| `collectMetrics` | `true` | Sample host-side CPU/memory use |
| `logging` | `false` | `true` or `{ enabled, dir, maxBytes }`; off means nothing is written |

## How state and resources are determined

This decides whether the numbers on screen can be trusted:

- **Running state comes from `vmrun list`.** It also counts paused VMs as running, so "paused" is remembered by the plugin (written after a `pause`). A VM paused from the VMware window shows as running — a known difference that has no command-line equivalent.
- **Leftover `.vmx.lck` directories are not evidence.** VMware does not clean them up after a crash or a hard power-off; an earlier implementation trusted them and reported seven powered-off VMs as running. The file heuristic is now only used when `vmrun list` fails.
- **Suspended** is detected by the `.vmss` image: a suspend is a power-off plus a memory image, so `vmrun list` omits it. Note that VMware names it `<name>-<hash>.vmss` (for example `CentOS 7-b846c30e.vmss`); the hash is generated by VMware and never written into the vmx, so the folder is scanned by prefix rather than by building a fixed file name.
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
| dsh-ssh-vault 2.3.0 (real source, temp vault) | Password and key auth saves, overwrite semantics, alias validation and masked listing all pass |
| A machine without VMware | Unit / API / client tests pass; the list and tools explain what to install |

macOS (Fusion) and Linux share the same code paths and the `ps` sampler, but have not been exercised on a real Fusion host. If you hit a difference, an issue with the `vmrun` version and output is welcome.

## Releasing

There is no compile step (plain ESM on the host, hand-written React elements on the client), so "build" here means **verify**:

```bash
npm run check      # version, changelog and release notes agree, plus module syntax
npm run release    # check → tests → pack → artifact verification
npm run pack:dist  # pack without tests (offline packaging)
```

`npm run release` writes `dist/dsh-vm-control-<version>.tgz` and `SHA256SUMS.txt`, then asserts the tarball contains `index.js`, `client.js`, `lib/**`, `cordis.patch.yml`, `dsh-market-entry.yml`, `README*` and `LICENSE`, and that `test/`, `node_modules` and `.github` stayed out.

**Cutting a release**

1. Bump the version in `package.json`, add the same section to both `CHANGELOG` files, and write `RELEASE_NOTES/v<version>.md`;
2. `npm run release` — any disagreement between those three fails immediately instead of in CI;
3. Commit, tag, push:

   ```bash
   git commit -am "chore(release): v1.1.0"
   git tag -a v1.1.0 -m "dsh-vm-control 1.1.0"
   git push origin main && git push origin v1.1.0
   ```

4. The tag triggers `.github/workflows/release.yml`, which **re-runs** the tests and packaging (no reuse of older artifacts), then attaches the `.tgz` and `SHA256SUMS.txt` to a GitHub Release whose body comes from `RELEASE_NOTES/v<version>.md`.

`SHA256SUMS.txt` describes **the artifact built by Actions**. Re-running `npm run release` locally produces slightly different bytes (npm writes file mtimes into the tar headers), so trust the checksum attached to the release; the package *contents* are verified entry by entry in step 5 and match locally.

A tag that disagrees with `package.json` makes the release job fail — a mislabelled release is worse than no release.

## Tests

```bash
npm test                                   # unit + API + client smoke, no VMware required
node test/live.mjs                         # read-only live run against the local VMware
node test/live.mjs "E:\Virtual Machines"   # explicit search root
```

The live test never powers, snapshots or deletes anything; it verifies version detection, the real `vmrun list`, real VMX parsing, the host network table and process sampling. The four files divide as follows:

- `test/unit.mjs` — parsing, classification, storage, inventory semantics, permissions and the SSH import suggestions (with vmrun replaced by a fake);
- `test/api.mjs` — the settings API envelope, trust gate, second permission check and path sourcing;
- `test/client-smoke.mjs` — runs the `client.js` factory inside `node:vm` and checks the registration wiring plus zh/en dictionary parity;
- `test/ssh-vault-link.mjs` — loads **dsh-ssh-vault's real source**, starts its vault in a temp dir and submits the payload the panel would submit, verifying field names, alias validation, overwrite semantics and that passwords never come back out;
- `test/live.mjs` — read-only verification against a real VMware installation.

`ssh-vault-link` needs dsh-ssh-vault cloned next to this repository; when it is absent the test prints a skip line and exits 0, so CI never fails because of a sibling that is not there.

## License

MIT
