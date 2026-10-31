# dsh-workbay

[![CI](https://github.com/1Lry1/dsh-workbay/actions/workflows/ci.yml/badge.svg)](https://github.com/1Lry1/dsh-workbay/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/1Lry1/dsh-workbay)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](package.json)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin-4d6bfe)](https://github.com/1Lry1/dsh-workbay)

[Chinese](README.md) | **English**

The **workbench** for DeepSeek Harness (DSH): one entry in the sidebar, one fixed panel on the right, with the Git and hardware-flashing pages used side by side, independent of any particular conversation.

This repository consolidates what used to be three standalone projects into a single **pnpm workspace**:

```
packages/
├─ dock/        dsh-workbay-dock    shell: left-sidebar entry + right-side dock overlay + page registry
├─ gitcraft/    dsh-gitcraft          page: SourceTree-grade Git panel (58 RPCs)
├─ downloader/  dsh-downloader        page: Bluetooth chip flashing + 1.5 Mbps serial log
├─ kit/         @dsh-workbay/kit    shared host helpers: same-origin fence / JSON body / RPC envelope
└─ suite/       dsh-workbay-suite   aggregator: installs all three at once (experimental)
```

```
Sidebar [Workbench] ──click──▶ Dock panel on the right
                               ┌────────────────────────────────────┐
                               │ Workbench   Docked right     ⤢ ⇥   │
                               │ [GitCraft] [Downloader]            │
                               │                                    │
                               │ Current page (beside conversation) │
                               └────────────────────────────────────┘
```

## Why not one big plugin

The three bundles have **different failure domains, release cadences and distribution targets**; merging them into one package would weld those boundaries shut:

| Dimension | dock (shell) | gitcraft (page) | downloader (page) |
|---|---|---|---|
| host side | 2 read-only methods | 58 RPCs, `git` child processes | Serial port + flashing IPC + SSE, spawns two exes (including a 32-bit bridge) |
| dependencies | None | A local `git` | Official Downloader, CP210x driver, a real board |
| release cadence | Stable (0.2.x) | Fast (0.1.x, iterating continuously, 13 e2e) | Tracks hardware/firmware changes |
| audience | Third parties who want to mount pages | Community (can be published to npm independently) | Internal tooling |
| engine range | `>=0.2.1-rc.1 <0.3.0-0` | `>=0.1.6-alpha.2` | `>=0.2.1-rc.1 <0.3.0-0` |

A single bundle that fails to start can make the whole plugin tree fail to boot (a `duplicate prefix route` will do it), so an exception on the flashing side must not crash the Git panel — and vice versa.

## Page protocol

Pages are React components registered on the **browser side**; the registry lives on a browser global, so the load order of the two bundles does not matter:

```js
window.__DSH_WORKBAY__.registerPage({
  id: 'myplugin',          // required, non-empty
  title: 'My page',
  order: 40,               // ascending; GitCraft=20, Downloader=30
  icon: (size) => <Icon size={size} />,
  component: ({ t, dock }) => <MyPanel />,
})
```

If dock has not loaded yet, poll briefly until it appears (both existing page plugins do this). For the complete contract and the three pitfalls already hit in practice, see [packages/dock/README.md](packages/dock/README.md).

## Installing it on someone else's machine (from GitHub)

The packages are **not on npm** and there is no release tarball yet, so a third party installs from a clone through `file:` dependencies. Requirements:

| Prerequisite | Requirement |
|---|---|
| OS | Windows 10/11 (the downloader drives two Windows helper executables and COM serial ports) |
| DSH desktop | `>=0.2.1-rc.1 <0.3.0-0` |
| Git | any recent version (gitcraft shells out to the local `git`) |
| Node.js / pnpm | Node `>=18`; pnpm 11 (`corepack enable` picks up the `packageManager` pin, 11.28.5) |

```powershell
# 1) clone and install the workspace
git clone https://github.com/1Lry1/dsh-workbay.git D:\tools\dsh-workbay
cd D:\tools\dsh-workbay
pnpm install

# 2) print the profile snippet, with paths already resolved
pnpm run profile:snippet
```

```powershell
# 3) find the profile (usually "desktop"; list them if unsure)
Get-ChildItem $env:USERPROFILE\.dsh\profiles
# edit <profile>\package.json: paste the three bundle names and the four dependencies
```

```powershell
# 4) install into the profile, then quit DSH completely and reopen it
cd $env:USERPROFILE\.dsh\profiles\desktop
pnpm install
```

The "Workbench" entry appears in the left sidebar when it worked.

The downloader page additionally needs (the plugin loads without them, but flashing is unavailable):

```powershell
[Environment]::SetEnvironmentVariable('DSH_DOWNLOADER_DIR', '<vendor Downloader install dir>', 'User')
[Environment]::SetEnvironmentVariable('DSH_DOWNLOADER_WORKSPACE', '<SDK project root>', 'User')
```

Update later with `pnpm run update` (see below). Getting rid of these manual steps requires publishing to npm or shipping release tarballs — then `dsh plugin add` is a one-liner.

## Installing into DSH

Profile directory: `C:\Users\<user>\.dsh\profiles\<profile>` (on this machine: `desktop`).

**Option A — three independent bundles (recommended, verified)**: in `package.json`:

```jsonc
{
  "dsh": { "profile": { "bundles": [
    "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app",
    "dsh-workbay-dock", "dsh-gitcraft", "dsh-downloader"
  ] } },
  "dependencies": {
    "dsh-workbay-dock": "file:<repo>/packages/dock",
    "dsh-gitcraft":       "file:<repo>/packages/gitcraft",
    "dsh-downloader":     "file:<repo>/packages/downloader",
    "@dsh-workbay/kit": "file:<repo>/packages/kit"
  }
}
```

```powershell
pnpm install            # or: dsh plugin --profile desktop add file:...
```

**Option B — the suite aggregator (experimental)**: add only `dsh-workbay-suite` to `bundles` and let its patch do the rest. See [packages/suite/README.md](packages/suite/README.md).

After installing, **restart DSH**; a "Workbench" entry appears in the left sidebar.

> `@dsh-workbay/kit` must be resolvable by the DSH runtime: it is imported by the host halves of dock and gitcraft, so it has to be present in the profile's `node_modules`. `pnpm install` installs it automatically as a `file:` dependency; copying plugin directories by hand easily misses it, which shows up as the host half failing to load.

### Updating from GitHub

The profile installs from this local clone (`file:` dependencies are copies, not links), so "use the GitHub version" means: pull the clone, then reinstall the profile.

```powershell
# 1) quit DSH completely (not minimized)
# 2) in the clone:
cd <repo>
pnpm run update          # git fetch + ff-only + tests + reinstall the profile
pnpm run update:fast     # same, skipping the tests
```

`pnpm run update` only fast-forwards: it refuses a dirty working tree or local commits instead of merging. Like `install:profile`, it aborts while DSH or `AbSerialHost.exe` / `DownloaderIpcBridge.exe` still holds the plugin files (pnpm reports `ERR_PNPM_EPERM`).

## Development

```powershell
pnpm install                     # workspace dependencies
pnpm test                        # unit/integration tests for all packages
pnpm --filter @dsh-workbay/kit run test
pnpm --filter dsh-gitcraft run test
```

Browser e2e (needs a running DSH plus a Chromium-based browser):

```powershell
node packages/gitcraft/tests/ui.e2e.mjs  <base-url> <browser-exe> <repo>
node packages/dock/tests/split.e2e.mjs   <base-url> <browser-exe> <repo> [shot.png]
node packages/downloader/smoke-test.mjs  # 25 checks; set the DSH_DOWNLOADER_* env vars first, unset cases auto-SKIP
```

## Design constraints (don't break these)

1. **A client half cannot import packages from this repo.** DSH loads client plugins with `window.__ModuleLoader__.load({ id, factory })`: one plugin is a single self-contained file plus the host's `require` seed table. That is why the small page-registration snippet is kept in both page plugins — deliberately so.
2. **`@dsh-workbay/kit` serves the host half only.** It exports nothing usable in the browser.
3. **The downloader does not use kit's RPC envelope**: its host also emits SSE and binary frames, and forcing the envelope on top would hurt readability.
4. **Do not mount both the suite and the individual packages** — the same row would be inserted twice, and the whole tree would fail to start.
5. Every package's `cordis.patch.yml` contains exactly one `insert`; `id` is a globally unique loader id.

## FAQ

**I changed `packages/*` but the UI shows no difference** — `file:` dependencies are **copied** into the profile's `node_modules`, not symlinked. You must reinstall the profile before restarting DSH:

```powershell
# Quit DSH first (not just minimize), then from the clone:
pnpm run install:profile
# or: cd $env:USERPROFILE\.dsh\profiles\desktop; pnpm install
```

**`pnpm install` fails with `ERR_PNPM_EPERM ... rename ... dsh-downloader`** — the downloader's serial helper `AbSerialHost.exe` (which in turn starts `DownloaderIpcBridge.exe` during flashing) is still alive and holding the files. They exit together with DSH; for stubborn leftovers, terminate them manually:

```powershell
Get-Process AbSerialHost, DownloaderIpcBridge -ErrorAction SilentlyContinue | Stop-Process
```

**The UI shows "Workbench" but has no pages** — the page registry is the browser global `window.__DSH_WORKBAY__`, and both page plugins wait for it. If dock was not loaded (`dsh-workbay-dock` missing from `bundles`), the pages have nowhere to register; conversely, if a page package is missing, the tab bar has only the workbench itself. Check that all three lines are present in the profile's `dsh.profile.bundles`.

**The host half fails to load and the log says `Cannot find package '@dsh-workbay/kit'`** — kit is missing from the profile's `node_modules`. `pnpm install` picks it up automatically via `file:../kit`; copying plugin directories by hand is the easiest way to miss it.

## Contributing and security

- Dev loop, layout, page-registration contract and commit conventions: **[CONTRIBUTING.md](CONTRIBUTING.md)**
- Vulnerability reporting and the threat model (routes are loopback-only, plugins run git/serial operations locally by design, no telemetry): **[SECURITY.md](SECURITY.md)**
- CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)): `pnpm test` on Windows, plus a `node --check` syntax gate on Linux

## License

MIT
