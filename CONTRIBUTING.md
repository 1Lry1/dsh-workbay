# Contributing to dsh-workbay

Thanks for helping out. This repository is a **pnpm workspace** holding a family
of DeepSeek Harness (DSH) plugins: a dock shell (`dsh-workbay-dock`) and two
pages that register into it (`dsh-gitcraft`, `dsh-downloader`), plus a shared
host-side kit and an experimental aggregator bundle.

It is **Windows-only** by construction: the packages drive a local `git` binary,
serial/COM ports and two Win32 helper executables, and DSH itself is a Windows
desktop app. Bug reports need a Windows version; so does a useful review.

## Repository layout

| Path | Package | Role | Tests |
|---|---|---|---|
| `packages/dock` | `dsh-workbay-dock` | The shell: header button, right-side panel, page registry | e2e only (needs a live DSH) |
| `packages/gitcraft` | `dsh-gitcraft` | Git page: branch tree, staging, commit, merge, blame, reflog | `node --test` + e2e |
| `packages/downloader` | `dsh-downloader` | Flash + 1.5 Mbps serial log page (vendor engine, IPC helpers) | smoke/http scripts (need the vendor engine) |
| `packages/kit` | `@dsh-workbay/kit` | Shared **host-only** helpers: same-origin fence, bounded JSON body, `{ ok, data }` RPC envelope | `node --test` |
| `packages/suite` | `dsh-workbay-suite` | One bundle that inserts the other three (experimental) | none |

Each plugin package has a `cordis.patch.yml` that inserts exactly one loader
row; the `id` inside is globally unique. `packages/downloader/helper/*.exe` and
`ipc-helper/*.exe` are vendored binaries and are tracked on purpose — keep them
in sync with the `.cs` sources next to them.

## Requirements

- Windows 10/11.
- Node.js >= 18 (CI uses 22).
- pnpm 11 — the root `package.json` pins `packageManager: pnpm@11.28.5`, so
  `corepack enable` is the least surprising way to get a matching version.
- `git` on `PATH`: the gitcraft host tests spawn it and create real repos.
- To click through the UI: a DSH install plus a profile, and a Chromium-based
  browser for the e2e scripts.

## Development loop

```powershell
pnpm install        # workspace dependencies (nodeLinker: hoisted, as in a DSH profile)
pnpm test           # everything that is runnable without DSH: kit + gitcraft
```

Per package:

```powershell
pnpm --filter @dsh-workbay/kit run test
pnpm --filter dsh-gitcraft run test
# equivalently, from packages/gitcraft:
node --test tests/host.test.mjs tests/client.test.mjs tests/workspace.test.mjs
```

`dock`, `downloader` and `suite` have no `test` script, because their checks need
a running DSH, a browser, or real hardware. Their e2e scripts are run by hand:

```powershell
# <base-url> is the URL DSH serves (e.g. http://127.0.0.1:3080/),
# <browser-exe> is a Chromium-based browser, <repo> a throwaway git repo to drive.
node packages/gitcraft/tests/ui.e2e.mjs     <base-url> <browser-exe> <repo>
node packages/dock/tests/split.e2e.mjs      <base-url> <browser-exe> <repo> [shot.png]
node packages/dock/tests/interaction.e2e.mjs <base-url> <browser-exe>
node packages/dock/tests/row-click.e2e.mjs   <base-url> <browser-exe>
```

The downloader smoke test talks to the vendor engine and helpers through
environment variables instead of hardcoded paths — set them (or leave them empty
and the checks that need them report as skipped/failed, visibly):

```powershell
$env:DSH_DOWNLOADER_DIR          = '<vendor Downloader install dir>'
$env:DSH_DOWNLOADER_WORKSPACE    = '<dir holding SDK projects>'
$env:DSH_DOWNLOADER_SAMPLE_REPO  = '<a real git repo>'
node packages/downloader/smoke-test.mjs
node packages/downloader/http-test.mjs
```

CI (`.github/workflows/ci.yml`) runs the two jobs you should keep green before
opening a PR: `test` (windows-latest, `pnpm -r --if-present run test`) and
`syntax` (ubuntu-latest, `node --check` on every `.js`/`.mjs` under `packages/`).

## Installing a build into a DSH profile

`file:` dependencies are **copied** into the profile's `node_modules`, not
symlinked, so edits under `packages/*` do nothing until the profile is
reinstalled. Always close DSH first (not minimized): the downloader keeps
`AbSerialHost.exe` and, after a flashing session, `DownloaderIpcBridge.exe`
alive, and they hold files open inside the plugin directory, which makes
`pnpm install` fail with `ERR_PNPM_EPERM ... rename ... dsh-downloader`.

```powershell
# From a fully closed DSH:
pnpm run install:profile
# or, for a profile not named "desktop":
pwsh -File scripts/refresh-profile.ps1 -Profile <profile>

# Equivalent manual route:
cd $env:USERPROFILE\.dsh\profiles\<profile>
pnpm install
```

`scripts/refresh-profile.ps1` refuses to run when DSH or a helper process is
still alive, and verifies afterwards that `@dsh-workbay/kit` landed in the
profile (a profile that copied only the plugin folders crashes on that import).
Restart DSH after it succeeds.

To pick up what is on GitHub rather than your local edits:

```powershell
pnpm run update        # fetch + fast-forward + tests, then reinstall the profile
pnpm run update:fast   # same without the test run
```

`scripts/update-from-github.ps1` only ever fast-forwards — a dirty tree or local
commits make it stop instead of merging — and it leaves the profile untouched if
the suite fails.

## Two hard constraints

These decide the shape of the repository; a patch that breaks them will be
rejected even if it works locally.

1. **A client half is one self-contained file.** DSH loads browser code via
   `window.__ModuleLoader__.load({ id, factory })` from a single file
   (`packages/dock/src/client.js`, `packages/gitcraft/src/client.js`,
   `packages/downloader/lib/client.js`). Inside the factory you may only
   `require` modules the host seeds (e.g. `react`); you **cannot** import npm
   packages and you cannot import `@dsh-workbay/kit` or any other workspace
   package. Shared browser-side code is therefore duplicated or generated on
   purpose — that is a feature, not a missed refactor.
2. **`@dsh-workbay/kit` is host-only.** It is ordinary ESM for Node, used by
   the dock and gitcraft host halves for the same-origin fence, the bounded JSON
   body reader and the `POST /<prefix>/<method>` RPC envelope. It exports nothing
   usable in a browser.

Also: one `insert` per `cordis.patch.yml` with a globally unique loader `id`, and
never list `dsh-workbay-suite` together with the three individual bundles in
`dsh.profile.bundles` — the same loader row would be inserted twice and DSH
rejects the whole tree with `duplicate prefix route`.

## Adding a new workbench page

A page is a browser-side React component registered into the dock's global
registry. Load order between bundles is **not** guaranteed, so page bundles poll
for the registry (both existing pages try once, then every 250 ms up to 40 times,
and give up quietly) instead of assuming the dock loaded first. Skeleton —
pseudo-code, inside your client half's factory:

```js
const registerWithDock = () => {
  const dock = window.__DSH_WORKBAY__
  if (dock === undefined || dock === null || typeof dock.registerPage !== 'function') return false
  const off = dock.registerPage({
    id: 'myplugin',        // required, non-empty, unique across pages
    title: t('title'),     // tab label; localize it with the page's own `t`
    order: 40,             // ascending; GitCraft = 20, Downloader = 30
    icon: (size) => React.createElement(Icon, { size }),
    component: (props) => React.createElement(MyPanel, { t, ...props }),
  })
  ctx.effect(() => off, 'myplugin: workbench page')   // unsubscribe with the seat
  return true
}

if (!registerWithDock()) {
  let attempts = 0
  const timer = setInterval(() => {
    attempts += 1
    if (registerWithDock() || attempts >= 40) clearInterval(timer)
  }, 250)
  ctx.effect(() => () => clearInterval(timer), 'myplugin: dock discovery')
}
```

`registerPage` returns an unsubscribe function; wire it through `ctx.effect` so a
dev reload does not leave duplicate tabs. Never create your own
`window.__DSH_WORKBAY__` — a page that registers into a stub before the
dock loads is exactly the incident that made the dock **adopt** an existing
registry object (grafting its control surface onto it) and re-read the page table
every 250 ms instead of trusting subscription order. The full contract and the
three real incidents behind it are in
[`packages/dock/README.md`](packages/dock/README.md). On the host side, register
a prefix route (e.g. `path: '/myplugin/api'`) and fence it with
`isTrustedRequest` from the kit, so only loopback/same-origin callers reach it.

## Never commit

- Absolute local paths from your own machine: home/profile directories, drive
  letters, junction points, and anything under the DSH install tree.
- Environment values: tokens, API keys, cookies, serial port names, vendor
  install paths, customer or project names — including inside screenshots and
  log excerpts.
- DSH profile contents: the profile's `package.json`/`pnpm-lock.yaml`/
  `node_modules` belong to the user's machine, not to this repo.
- Local test output: `node_modules/`, `*.log`, `*.bak*`, `tests/**/*.tmp`,
  `tests/**/fixtures/**/.git/`, `*.tgz` (all covered by `.gitignore`, but check
  `git status` before committing).

If a log line is the only way to explain a bug, redact it to `<redacted>`
instead of pasting the real value.

## Commit messages

Conventional-commit-like, imperative mood, <= 72 characters for the subject:

```
feat(gitcraft): stage individual hunks from the diff view
fix(dock): adopt a page registry that loaded before the shell
test(kit): cover the loopback fence with a same-origin header
docs(downloader): document the two IPC helper processes
chore(ci): run the test suite on windows-latest
```

`type` is one of `feat`, `fix`, `test`, `docs`, `refactor`, `chore`, `perf`;
`scope` is the package (`dock`, `gitcraft`, `downloader`, `kit`, `suite`) or a
cross-cutting area (`ci`, `docs`, `repo`). The body explains **why**, not what
the diff already shows. One logical change per commit; do not mix a refactor
with a behavior change.

## Pull requests

Fill in the PR template (`What` / `Why` / `How tested`), keep `pnpm test` green,
and say which DSH version and Windows build you checked a UI change against. For
security issues, do **not** open a pull request or a public issue — see
[`SECURITY.md`](SECURITY.md).

---

## 中文

**环境**：Windows 10/11、Node.js >= 18（CI 用 22）、pnpm 11（根
`package.json` 的 `packageManager` 已锁定版本，用 `corepack enable` 最省心）、
`git` 在 `PATH` 上。

**开发流程**：

```powershell
pnpm install
pnpm test                                   # 只跑不需要 DSH 的测试：kit + gitcraft
pnpm --filter @dsh-workbay/kit run test
pnpm --filter dsh-gitcraft run test
```

`dock` / `downloader` / `suite` 没有 `test` 脚本，它们的 e2e 与冒烟测试需要
**运行中的 DSH + Chromium 内核浏览器**，或真实的板卡与串口，只能手工执行
（命令见上方英文部分；downloader 的冒烟测试用 `DSH_DOWNLOADER_*` 环境变量
定位厂商引擎，不要写死本机路径）。

**装进 DSH profile**：`file:` 依赖是**拷贝**而不是软链，改完 `packages/*`
必须重装 profile，而且**先完全退出 DSH**（下载器的 `AbSerialHost.exe` /
`DownloaderIpcBridge.exe` 会占用插件目录，否则 `pnpm install` 报
`ERR_PNPM_EPERM`）：

```powershell
pnpm run install:profile
# 换个 profile：
pwsh -File scripts/refresh-profile.ps1 -Profile <profile>
```

完成后重启 DSH。

**两条硬约束**：

1. client 半侧是**单文件**：`window.__ModuleLoader__.load({ id, factory })`，
   factory 里只能 `require` 宿主种子表里的模块（如 `react`），**不能 import
   任何 npm 包或本仓库的包**；浏览器侧公共代码只能复制或生成。
2. `@dsh-workbay/kit` **只给 host 半侧**用，浏览器侧不导出任何东西。

另外：每个 `cordis.patch.yml` 只有一条 `insert`，`id` 全局唯一；
`dsh-workbay-suite` 不能和三个单包同时挂在 `bundles` 里，否则同一行被
insert 两次，DSH 会以 `duplicate prefix route` 拒绝启动。

**新增页面**：调用 `window.__DSH_WORKBAY__.registerPage({ id, title,
order, icon, component })`，`id` 必填且唯一，`order` 升序（GitCraft=20，
Downloader=30），返回值是退订函数；dock 可能还没加载，要短轮询等它出现，
不要自己新建注册表对象。完整契约见
[`packages/dock/README.md`](packages/dock/README.md)。

**绝对不要提交**：本机绝对路径、token/密钥/环境变量值、DSH profile 的内容、
客户或项目名称（截图和日志里也要抹掉）、junction、以及 `node_modules` 和
测试临时产物。日志里必须保留的片段请替换成 `<redacted>`。

**提交信息**：`type(scope): 祈使句摘要`，例如
`fix(gitcraft): keep hunk staging across refetch`；`type` 用
feat / fix / test / docs / refactor / chore / perf，`scope` 用包名或
`ci` / `docs` / `repo`，正文说明**为什么**。

**安全问题**：不要开公开 issue 或 PR，按 [`SECURITY.md`](SECURITY.md) 的
私下渠道报告。
