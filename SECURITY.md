# Security notes

## Threat model

The plugin runs locally and operates on local VMware virtual machines and their files. It assumes:

- the OS account running DSH is trusted;
- the DSH web server has already authenticated the request and checked its origin, per host policy;
- VMware, `vmrun` and the VM disks all belong to the same user.

It does **not** try to defend against: a local administrator, an attacker who already holds a DSH session, or a tampered VMware installation.

## Settings API

- Routes live under `/vm-control/` and accept POST only.
- Every request first passes the host's `connection.requestRejection` (Host/Origin checks plus browser authentication). When that service is absent (non-web setups) the request is allowed through and the host's own auth layer is the backstop — the same trade-off as the built-in `/api`.
- Except for `register`, action ids are resolved against the inventory: **no request-body path** is ever used to read, write or spawn.
- `register` requires an absolute path, a `.vmx` suffix and an existing file; directories and other extensions are rejected.
- "Open folder" only opens paths the plugin computed itself (VM folder, trash, log folder).
- Permissions are enforced a second time here, so a capability disabled in `permissions` cannot be reached by bypassing the tool layer.

## Passwords

- The plugin stores **no password**. An encrypted VM only carries a `credential_ref` (a DSH credential name); the host credential service resolves the value when needed.
- The password is requested only after `vmrun` reports that the VM is encrypted, and is handed to `vmrun` via `-vp`. VMware offers no other channel, so it is visible in the local process list for that process's lifetime. That exposure cannot be removed inside this plugin; it simply does not occur unless you manage encrypted VMs.
- The diagnostics log redacts anything shaped like `-vp <password>`, `password=...` or `passphrase=...` before writing. That is a guard rail, not a complete DLP.

## Cross-plugin import (dsh-ssh-vault)

- This plugin **never holds the vault key** and never reads or writes ssh-vault's data files. The browser submits to ssh-vault's own `/ssh-vault/save`: same origin, cookies included, the same trust level as saving on its settings page.
- The imported fields are a fixed allow-list (`SSH_VAULT_SAVE_FIELDS` in `lib/ssh-import.js`); `sudoPassword`, `bindAddress`, key uploads and renames are out of scope.
- The SSH password exists only inside that one request: this plugin does not persist it, log it, read the vault back, or reuse the VM encryption password as an SSH password.
- Probing (`POST ssh-vault/list`) is read-only, and the sibling's list is already masked (addresses and users are obfuscated, passwords never returned).
- When the sibling is missing or the request is not trusted, the panel degrades to a copyable command — no permission changes, no new write path.
- The import button follows `permissions.config`; disabling it removes only this write path, leaving power, snapshots and parameters untouched.

## Destructive operations

- Deletion has three semantics; the default moves the folder to the plugin trash. Deleting files requires `permissions.delete: true` **and** `confirm: true`.
- Before moving a VM folder the plugin checks for other `.vmx` files inside it and refuses, so nobody's second VM gets carried along.
- Before rewriting a VMX the original is backed up to `<vmx>.dsh-vm-control.bak`; rewrites happen only while the VM is powered off (or suspended, with a warning).
- Power actions check the current state first, so "stopping an already stopped VM" does not happen. `hard` cuts power immediately, like pulling the plug, and can corrupt the guest filesystem.

## Reporting

Use the repository's issue template. Do not paste passwords, VM paths or raw logs into a public issue.
