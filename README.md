# dsh-workbench

DeepSeek Harness（DSH）的**工作台**：侧栏一个入口，右侧一块固定面板，Git 和硬件烧录两个页面并排使用，与具体会话无关。

这个仓库把原本三个独立工程收敛成一个 **pnpm workspace**：

```
packages/
├─ dock/        dsh-workbench-dock    壳：左侧栏入口 + 右侧停靠浮层 + 页面注册表
├─ gitcraft/    dsh-gitcraft          页面：SourceTree 级 Git 面板（54 个 RPC）
├─ downloader/  dsh-downloader        页面：蓝牙芯片烧录 + 1.5 Mbps 串口日志
├─ kit/         @dsh-workbench/kit    共享 host 工具：同源围栏 / JSON 体 / RPC 信封
└─ suite/       dsh-workbench-suite   聚合金：一次装好上面三个（实验性）
```

```
左侧栏 [工作台] ──点击──▶ 右侧停靠面板
                          ┌──────────────────────────────┐
                          │ 工作台  已停靠右侧      ⤢ ⇥  │
                          │ [GitCraft] [Downloader]      │
                          │                              │
                          │   当前页面内容（与会话并排）  │
                          └──────────────────────────────┘
```

## 为什么不是一个大插件

三个 bundle 的**故障域、发布节奏和分发对象都不一样**，合并成一个包会把这些边界焊死：

| 维度 | dock（壳） | gitcraft（页面） | downloader（页面） |
|---|---|---|---|
| host 侧 | 2 个只读方法 | 54 个 RPC，git 子进程 | 串口 + 烧录 IPC + SSE，拉起两个 exe（含 32 位桥） |
| 依赖 | 无 | 本机 `git` | 官方 Downloader、CP210x 驱动、真实板卡 |
| 更新节奏 | 稳定（0.2.x） | 快（0.1.x 持续迭代，14 个 e2e） | 随硬件/固件变化 |
| 面向 | 想挂页面的第三方 | 社区（可独立发 npm） | 内部工具 |
| 引擎范围 | `>=0.2.1-rc.1 <0.3.0-0` | `>=0.1.6-alpha.2` | `>=0.2.1-rc.1 <0.3.0-0` |

一个 bundle 起不来可能让整棵插件树启动失败（`duplicate prefix route` 就会），所以烧录侧的异常不该带崩 Git 面板——反过来也一样。

## 页面协议

页面是**浏览器侧**注册的 React 组件，注册表放在一个浏览器全局上，两个 bundle 的加载顺序无所谓：

```js
window.__DSH_WORKBENCH_DOCK__.registerPage({
  id: 'myplugin',          // 必填，非空
  title: '我的页面',
  order: 40,               // 升序，GitCraft=20，Downloader=30
  icon: (size) => <Icon size={size} />,
  component: ({ t, dock }) => <MyPanel />,
})
```

若 dock 还没加载，短轮询等它出现（现有两个页面插件都这么做）。完整约定与三个已被踩过的坑见 [packages/dock/README.md](packages/dock/README.md)。

## 安装到 DSH

profile 目录：`C:\Users\<user>\.dsh\profiles\<profile>`（本机是 `desktop`）。

**方式 A —— 三个独立 bundle（推荐，已验证）**：`package.json` 里

```jsonc
{
  "dsh": { "profile": { "bundles": [
    "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app",
    "dsh-workbench-dock", "dsh-gitcraft", "dsh-downloader"
  ] } },
  "dependencies": {
    "dsh-workbench-dock": "file:<repo>/packages/dock",
    "dsh-gitcraft":       "file:<repo>/packages/gitcraft",
    "dsh-downloader":     "file:<repo>/packages/downloader",
    "@dsh-workbench/kit": "file:<repo>/packages/kit"
  }
}
```

```powershell
pnpm install            # 或 dsh plugin --profile desktop add file:...
```

**方式 B —— 聚合金（实验性）**：bundles 里只加 `dsh-workbench-suite`，其余交给它的 patch。见 [packages/suite/README.md](packages/suite/README.md)。

装完**重启 DSH**，左侧栏出现「工作台」。

> `@dsh-workbench/kit` 必须能被 DSH 的运行时解析到：它被 dock 和 gitcraft 的 host 半侧 import，所以 profile 的 `node_modules` 里要有它。用 `pnpm install` 时 pnpm 会按 `file:` 依赖自动装好；手工拷贝插件目录时容易漏，表现为 host 半侧加载失败。

## 开发

```powershell
pnpm install                     # workspace 依赖
pnpm test                        # 所有包的单测/集成测
pnpm --filter @dsh-workbench/kit run test
pnpm --filter dsh-gitcraft run test
```

浏览器 e2e（需要运行中的 DSH + 一个 Chromium 内核浏览器）：

```powershell
node packages/gitcraft/tests/ui.e2e.mjs  <base-url> <browser-exe> <repo>
node packages/dock/tests/split.e2e.mjs   <base-url> <browser-exe> <repo> [shot.png]
node packages/downloader/smoke-test.mjs  # 25 项自检，需改文件顶部两个绝对路径
```

## 设计约束（别踩）

1. **客户端半侧不能 import 本仓库的包**。DSH 用 `window.__ModuleLoader__.load({ id, factory })` 加载客户端插件，一个插件就是一个自包含文件 + 宿主 `require` 种子表。所以页面注册那段小代码在两个页面插件里各留一份，这是刻意的。
2. **`@dsh-workbench/kit` 只服务 host 半侧**。它不导出任何浏览器可用的东西。
3. **downloaders 不用 kit 的 RPC 信封**：它的 host 还要输出 SSE 与二进制帧，硬套会降低可读性。
4. **不要同时挂 suite 和单包**，会重复 insert 同一行导致整棵树启动失败。
5. 每个包的 `cordis.patch.yml` 里都只有一条 `insert`；`id` 是全局唯一的 loader id。

## 常见问题

**改了 `packages/*` 但界面上没变化** — `file:` 依赖是**拷贝**进 profile 的 `node_modules`，不是软链。重启 DSH 前必须先重装 profile：

```powershell
# 先退出 DSH（不是最小化），再执行
pwsh -File scripts/refresh-profile.ps1 -Profile desktop
# 或：cd C:\Users\<user>\.dsh\profiles\desktop; pnpm install
```

**`pnpm install` 报 `ERR_PNPM_EPERM ... rename ... dsh-downloader`** — downloader 的串口 helper `AbSerialHost.exe`（烧录时会再起 `DownloaderIpcBridge.exe`）还活着，文件被占用。退出 DSH 后它们会跟着退出；顽固残留就手动结束：

```powershell
Get-Process AbSerialHost, DownloaderIpcBridge -ErrorAction SilentlyContinue | Stop-Process
```

**界面里「工作台」有了但没有页面** — 页面注册表是浏览器全局 `window.__DSH_WORKBENCH_DOCK__`，两个页面插件都在等它。若 dock 没被加载（`bundles` 里漏了 `dsh-workbench-dock`），页面就无处注册；反之若页面包漏了，Tab 条只有工作台本身。检查 profile 的 `dsh.profile.bundles` 三行齐全。

**host 半侧加载失败、日志报 `Cannot find package '@dsh-workbench/kit'`** — profile 的 `node_modules` 里缺 kit。`pnpm install` 会按 `file:../kit` 自动带上；手工拷贝插件目录时最容易漏。

## License

MIT
