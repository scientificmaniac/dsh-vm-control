# Publishing to the official npm registry

This document covers **`https://registry.npmjs.org/` only**. Mirrors (npmmirror, Verdaccio, Artifactory) and other package managers are out of scope; a mirror can serve reads but cannot accept publishes. Every command below is copy-pasteable and the order is the order of operations.

> One local trap worth knowing: the default registry in `~/.npmrc` on this machine is `https://registry.npmmirror.com`. Uploading there returns 404/403. This project pins the official registry in `package.json` → `publishConfig.registry`, so `npm publish` from the repo goes to npmjs regardless; but `npm login` / `npm whoami` still need an explicit `--registry`.

## 1. Package layout

```
dsh-vm-control/
├── package.json            # always shipped
├── index.js                # host entry, exports["."]
├── client.js               # browser half, exports["./client"]
├── lib/                    # host modules imported by index.js
├── locale/{zh,en}.json     # market display names
├── cordis.patch.yml        # DSH loader patch (dsh.bundle.patch)
├── dsh-market-entry.yml    # market entry
├── icon.svg
├── README.md / README.zh-CN.md
├── CHANGELOG.md / CHANGELOG.zh-CN.md
├── SECURITY.md / SECURITY.zh-CN.md
├── PUBLISHING.md / PUBLISHING.zh-CN.md
├── LICENSE
├── scripts/                # maintenance scripts — not shipped
├── test/                   # tests — not shipped
├── .github/workflows/      # CI — not shipped
└── RELEASE_NOTES/          # GitHub release notes — not shipped
```

**Only `package.json` plus the paths in `files` are packed.** This is an allow-list, not an exclusion list: anything not listed (`test/`, `scripts/`, `.github/`, `RELEASE_NOTES/`, `dist/`) stays out, so adding a new dev-only folder cannot leak into the tarball by accident.

## 2. The fields that matter in package.json

| Field | Here | Why it matters | When it breaks |
| --- | --- | --- | --- |
| `name` | `dsh-vm-control` | Permanent, unique | Taken by someone else → 403 on publish |
| `version` | `1.1.1` | semver; one publish per version | Duplicate → `EPUBLISHCONFLICT` |
| `description` | one English sentence | Search and page summary | Missing → blank summary |
| `keywords` | dsh / vmware / vmrun | Discoverability | Cosmetic |
| `license` | `MIT` | Required by community norms | Missing → npm warning |
| `author` | `scientificmaniac (https://…)` | Shown on the page | Cosmetic |
| `type` | `module` | This package is pure ESM | Missing → `.js` treated as CJS and `import` fails |
| `main` | `./index.js` | Fallback for tooling that ignores `exports` | Missing → old bundlers cannot resolve |
| `exports` | `.`, `./client`, `./package.json`, `./locale/*.json` | Decides which subpaths are importable | Missing subpath → `ERR_PACKAGE_PATH_NOT_EXPORTED` |
| `engines.node` | `>=20` | Install-time check | Too low → `EBADENGINE` |
| `files` | allow-list above | Decides tarball content | Misconfigured → missing files or shipped tests |
| `publishConfig` | `access: public` + official registry | Where and how it publishes | Missing → may target a mirror and fail |
| `repository` / `homepage` / `bugs` | GitHub URLs | Links on the npm page | Cosmetic |
| `scripts.prepublishOnly` | `node scripts/release.mjs --check-only` | Publish guard | Inconsistent version → publish aborts |

`dsh`, `meta` and `icon` are DeepSeek Harness fields; npm ignores them, the plugin market does not.

## 3. Build, pack and verify before publishing

There is no compile step (plain ESM on the host, hand-written React elements on the client), so "build" means **verify + pack**:

```bash
npm run check          # package.json version vs both CHANGELOGs vs RELEASE_NOTES + syntax of 15 modules
npm test               # 82 tests: 53 unit + 19 API + 5 client + 5 integration
npm run pack:dist      # pack into dist/ and verify the contents entry by entry
npm pack --dry-run     # just show what would be packed
```

`npm pack --dry-run` is the single most useful pre-publish command: check `total files` and the list. Any `test/`, `node_modules/` or stray `.tgz` means `files` is wrong.

**Install it locally** — this catches most "installs but does not work" cases before they are public:

```bash
npm pack                                  # dsh-vm-control-1.1.1.tgz
mkdir ../tmp-install && cd ../tmp-install
npm init -y
npm install ../dsh-vm-control/dsh-vm-control-1.1.1.tgz
node -e "import('dsh-vm-control').then(m => console.log(Object.keys(m)))"
node -e "console.log(require('dsh-vm-control/package.json').version)"
```

`npm publish --dry-run` is the same rehearsal with the `prepublishOnly` guard included; run it before the real thing.

## 4. Account, login and two-factor authentication

**Sign up**: <https://www.npmjs.com/signup>, then click the verification link in the email. The username becomes part of the package page and any scope, and cannot be changed later.

**Log in (interactive)**:

```bash
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/      # prints the username on success
```

Without a browser, `npm adduser --registry=...` walks the same flow on the command line (username, password, email, one-time code).

**2FA**:

- Enable it in the npm account settings (preferably "Authorization and writes", so both login and publish need a code).
- Interactive publishes prompt for the 6-digit code; non-interactive ones take `--otp=123456`.
- For automation use a **Granular Access Token** (Access Tokens → Generate New Token → *Granular*), grant **Read and write** or just Publish for this package, and choose whether it may bypass 2FA. Then:

  ```bash
  export NODE_AUTH_TOKEN=npm_xxx      # PowerShell: $env:NODE_AUTH_TOKEN='npm_xxx'
  npm publish --access public --registry=https://registry.npmjs.org/
  ```

- npm is tightening the rules for legacy tokens that bypass 2FA when used for **direct publishing** (npm prints a notice on `npm profile get`). If you hit a 2FA policy 403, publish interactively with `--otp`, or use OIDC (`--provenance`) in CI instead of a long-lived token.
- Never commit `.npmrc` (it holds tokens). This repo does not ignore it for you — check `git status`.

## 5. `npm publish` and its flags

```bash
npm publish --access public            # public publish (what this project uses)
npm publish --dry-run                  # rehearsal, no network write
npm publish --tag beta                 # publish under a dist-tag, leaving latest alone
npm publish --otp 123456               # supply the 2FA code
npm publish --provenance               # verifiable build provenance (CI with OIDC)
npm publish --registry https://registry.npmjs.org/   # override the target registry
```

| Flag | Purpose | When it is required |
| --- | --- | --- |
| `--access public` | Declares the package public | **First publish of a scoped package**; harmless but explicit for unscoped ones |
| `--dry-run` | Rehearsal | Before the first publish, after editing `files` |
| `--tag <name>` | Writes a dist-tag other than `latest` | Pre-releases (`beta`, `rc`) so users do not get them via `npm i` |
| `--otp <code>` | One-time password | Account has 2FA and the run is non-interactive |
| `--provenance` | SLSA provenance | CI with OIDC; unsupported locally |
| `--registry <url>` | Override registry | Local default points at a mirror |

This project already has `access` and `registry` in `publishConfig`, so the command shortens to:

```bash
npm publish
```

## 6. Public access for scoped packages

`@scope/name` packages **default to private**, and private packages need a paid plan. Free accounts must opt in explicitly:

```bash
npm publish --access public
# or persist it:
"publishConfig": { "access": "public" }
```

- A scope can be your username (`@kxfz/...`) or an organisation (npm → Organizations). Creating an org is free; public packages are free.
- **You cannot turn a public package private again** on a free account, so decide before the first `--access public`.
- This project uses the unscoped name `dsh-vm-control` (verified unclaimed on 2026-11-15), so this section does not apply to it — it is here because it is the most common first-publish obstacle.

## 7. Verifying a publish

```bash
# 1) metadata: version, dist-tags, publish time
npm view dsh-vm-control version dist-tags.latest time.modified --registry=https://registry.npmjs.org/

# 2) what the registry actually holds (compare with your local npm pack)
npm pack dsh-vm-control@1.1.1 --dry-run --registry=https://registry.npmjs.org/

# 3) a real install in a clean folder
mkdir ../verify && cd ../verify && npm init -y
npm install dsh-vm-control@1.1.1 --registry=https://registry.npmjs.org/
node -e "import('dsh-vm-control').then(m => console.log(typeof m.apply))"
```

Then open <https://www.npmjs.com/package/dsh-vm-control> and check the rendered README, version, `Repository` / `Homepage` links and the `License` badge.

**Mirror lag**: npmmirror syncs minutes to hours behind. Missing the new version there is normal; always verify against the official registry.

**Unpublishing**: within 72 hours you can `npm unpublish dsh-vm-control@1.1.1`; afterwards only `npm deprecate dsh-vm-control@1.1.1 "message"`. Versions already installed elsewhere cannot be recalled, so prefer shipping `1.1.2` over trying to undo.

## 8. Bumping the version and publishing again

```bash
npm version patch -m "chore(release): %s"    # 1.1.1 → 1.1.2 (edits package.json, commits, tags)
# or minor / major
```

The standard sequence for a new version:

1. `npm version patch` (or edit `package.json` by hand);
2. update both `CHANGELOG` files and `RELEASE_NOTES/v<new>.md` (`npm run check` enforces this);
3. `npm run release` — check + tests + pack + artifact verification;
4. `npm publish`;
5. `git push --follow-tags` (pushes the commit and tag; the GitHub release workflow follows);
6. verify as in section 7.

Semantic versioning:

| Change | Use | Example |
| --- | --- | --- |
| Bug fix, docs, packaging metadata | `patch` | 1.1.0 → 1.1.1 |
| Backwards-compatible feature | `minor` | 1.1.1 → 1.2.0 |
| Breaking change (tool arguments, config fields, data format) | `major` | 1.2.0 → 2.0.0 |

For pre-releases use `npm version 1.2.0-beta.1` plus `npm publish --tag next`, then `npm dist-tag add dsh-vm-control@1.2.0 latest` once it is stable.

## 9. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `E404` / `404 Not Found - PUT ...` | Target registry is a read-only mirror, or the name does not exist there | `npm config get registry`; use `--registry=https://registry.npmjs.org/` or `publishConfig.registry` |
| `E403 You do not have permission to publish "<name>"` | Name taken by someone else, or no rights on that scope | `npm view <name> maintainers`; publish as `@you/<name>` |
| `403 ... You may not perform that action with these credentials` | The granular token's **package scope does not include this package** (observed here: a token scoped to `dsh-ssh-vault` cannot publish `dsh-vm-control`) | `npm token list --json` and read `scopes`; mint a granular token with *All packages* (or this package) plus `package:write`, then replace the `_authToken` in `~/.npmrc` |
| `E403 ... two-factor authentication required` | Account policy enforces 2FA | `npm publish --otp=<code>`, or use a granular token with Publish rights |
| `EOTP` / `one-time password required` | Same, non-interactive run | Same as above, or OIDC in CI |
| `EPUBLISHCONFLICT` / `Cannot publish over previously published version` | Version already exists; publishes are immutable | `npm version patch` and publish again |
| `ENEEDAUTH` | Not logged in, or logged in to a mirror while publishing to npmjs | `npm login --registry=https://registry.npmjs.org/`; confirm with `npm whoami --registry=...` |
| `E402 Payment Required` | Scoped package without `--access public`, or trying to privatise a public one | Add `--access public`; private needs a paid org |
| `E400 name can only contain URL-friendly characters` | Uppercase, spaces or non-ASCII in the name | Lowercase with hyphens |
| Missing files, or `test/` shipped | `files` / `.npmignore` misconfigured | `npm pack --dry-run`; `scripts/release.mjs` verifies required entries |
| `prepublishOnly` aborts the publish | Version, CHANGELOG and release notes disagree | Fix what the script prints — the guard is doing its job |
| `ERR_MODULE_NOT_FOUND` after install | `main` / `exports` / `type` wrong | Reproduce with a local `npm pack` install; check the subpath in `exports` |
| Installs, but DSH does not load the plugin | `cordis.patch.yml` missing from `files` | Keep `cordis.patch.yml` and `lib/` in the allow-list |
| Published, but the page 404s or shows the old version | CDN cache / mirror lag | Wait a few minutes; query the registry directly with `npm view` |

## 10. The exact sequence for this project

```bash
cd "e:/ai project/dsh-vm-tools/dsh-vm-control"

# 1. what exactly is being shipped
git status --short                  # clean, only the release commit
npm run check                       # version, changelog and notes agree
npm test                            # 82 tests

# 2. rehearse
npm publish --dry-run --access public

# 3. publish (add --otp=<code> when the account enforces 2FA)
npm publish --access public

# 4. verify
npm view dsh-vm-control version dist-tags.latest --registry=https://registry.npmjs.org/
mkdir ../verify && cd ../verify && npm init -y
npm install dsh-vm-control --registry=https://registry.npmjs.org/
node -e "import('dsh-vm-control').then(m => console.log(typeof m.apply))"

# 5. sync the repo
git push --follow-tags
```

Installing it as a DSH plugin (same package, plus host-side registration):

```bash
dsh plugin --profile desktop install dsh-vm-control
# restart DSH afterwards: host tools and the settings route load at startup
```
