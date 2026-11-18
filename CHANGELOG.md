# Changelog

All notable changes to this plugin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the versions follow
[Semantic Versioning](https://semver.org/).

## [1.1.1] - 2026-11-18

### Fixed

- **`vm_power start` with `gui: true` could never return.** The root cause was not the timeout length but that `runProcess` only listened for the child's `close` event: `close` fires once *all* stdio streams are shut, and `vmrun start <vmx> gui` spawns `vmware.exe`, which inherits those pipes. Killing `vmrun.exe` on timeout left the window holding the pipes, so `close` never arrived and the promise never settled — the host saw an unresponsive tool call rather than a timeout, and manual interruption recorded `TOOL_OUTCOME_UNKNOWN`. `exit` now schedules a 250 ms fallback settle: the normal path still lets `close` win (so stdout stays complete), while a pipe held by a grandchild is drained by the fallback. The grandchild is the VM itself, so it is never killed to close a pipe.
- **Power waits now share one budget.** The vmrun timeout and the following state confirmation were timed separately (120 s start + 45 s confirm), so a stalled call could hang for 165 s. `timeoutMs` is now the total for the whole call and confirmation gets only what is left; a 5 s minimum window is kept because `vmrun list` often reflects the new state only a few hundred ms after the command returns, and reporting "unconfirmed" without a single check would be a false negative.
- **GUI starts default to a 60 s timeout** (`GUI_START_TIMEOUT_MS`). A window appearing does not mean the VM is ready, and waiting longer only turns "started" into "timed out".
- **A vmrun timeout is no longer reported as a failed operation.** Killing the command on timeout only means it did not return in time — the start request had already been handed to VMware, so the VM may well be up. The old code reported failure, which misreported a successful start and invited a retry. Timeouts and cancellations now continue to the state confirmation and let the actual state decide, flagged as `indeterminate` in the result; only an explicit vmrun error (missing vmx, …) counts as failure. Verified live: a `gui` start given a 2 s timeout had its command killed and the tool still reported `stopped → running`, stating that the conclusion came from the actual state rather than vmrun's exit code.
- **The "suspended" state was never detected correctly.** The code looked for `<name>.vmss`, but VMware writes `<name>-<hash>.vmss` (observed: `CentOS 7-b846c30e.vmss`). Every suspended VM was therefore shown as stopped, and the `suspended` state word never appeared on a real machine — so a suspended VM neither looked suspended nor got the "start resumes it" guidance. The lookup now scans the folder for `<name>-*.vmss` while keeping the exact match, with the `-` in the prefix so `CentOS 7 最小系统` is not mistaken for a suspend image of `CentOS 7`.

### Changed

- The "unconfirmed" power result is now phrased as "issued, not confirmed" with the facts that were established, keeping "no result was seen" apart from "the operation failed" and pointing at a state read instead of a resend. `vm.powerTimeout` is replaced by `vm.powerIssuedUnconfirmed` + `vm.powerFacts`.
- Tool descriptions now say to prefer `gui=false`, that the timeout is a total for the call, and not to resend on an unconfirmed result.
- A confirmed headless start adds a line noting it is faster than a GUI start and needs no desktop session.
- New regression tests: `runProcess` must settle on time when a grandchild inherits the pipes; the confirmation budget must not exceed `timeoutMs`; a timeout must be treated as an unknown outcome rather than a failure; explicit errors must still fail; the renderer must state where the conclusion came from; suspend images must be found under VMware's `<name>-<hash>.vmss` naming without misfiring on a name that shares the prefix.

## [1.1.0] - 2026-11-15

### Added

- dsh-ssh-vault integration: the "SSH import" action on a VM card turns the address, port, user and auth into one vault entry and writes it on confirm; `vm_config action=ssh` returns the same proposal plus where to click.
- The proposal asks VMware Tools for the guest IP; when it is unavailable the field stays empty with a hint instead of inventing an address.
- Alias normalisation: non-ASCII folded into separators, with a deterministic `-2` suffix when two VMs collide (ordered by vmx path codepoints, so the result is identical across platforms).
- Default key detection (`~/.ssh/id_ed25519` → `id_ecdsa` → `id_rsa`); a hit makes key auth the default, so key users really do get one click.
- Three distinct probe outcomes (not installed / not authenticated / other) each get their own message; when the sibling is absent the SSH command stays copyable and nothing else is locked.
- `test/ssh-vault-link.mjs`: loads the sibling's real source, starts an in-memory vault and submits our payload, verifying the field contract, alias validation, overwrite semantics and that passwords never come back out.

### Changed

- `vm_config` gained the `ssh` action and a `host` parameter; the tool description explains why the model cannot write the vault itself (the ciphertext only answers to the sibling's key).
- Import follows `permissions.config`; probing and copying do not.
- Version bumped to 1.1.0.

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
