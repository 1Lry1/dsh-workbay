# dsh-workbay

[![CI](https://github.com/1Lry1/dsh-workbay/actions/workflows/ci.yml/badge.svg)](https://github.com/1Lry1/dsh-workbay/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/1Lry1/dsh-workbay)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](package.json)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin-4d6bfe)](https://github.com/1Lry1/dsh-workbay)

**中文** | [English](README.en.md)

DeepSeek Harness（DSH）的**工作台**：侧栏一个入口，右侧一块固定面板，文件、Git、终端、硬件烧录四个页面并排使用，与具体会话无关。

这个仓库把能力收敛成一个 **pnpm workspace**：

```
packages/
├─ dock/        dsh-workbay-dock      壳：左侧栏入口 + 右侧停靠浮层 + 页面注册表
├─ files/       dsh-workbay-files     页面：文件树 + 查看器 + CodeMirror 编辑器（chunk 懒加载）
├─ terminal/    dsh-workbay-terminal  页面：真终端（ConPTY）+ 多 tab（xterm.js，SSE 流式）
├─ gitcraft/    dsh-gitcraft          页面：SourceTree 级 Git 面板（58 个 RPC）
├─ downloader/  dsh-downloader        页面：蓝牙芯片烧录 + 1.5 Mbps 串口日志
├─ kit/         @dsh-workbay/kit      共享 host 工具：同源围栏 / JSON 体 / RPC 信封
└─ suite/       dsh-workbay-suite     聚合金：一次装好上面五个（实验性）
```

```
左侧栏 [工作台] ──点击──▶ 右侧停靠面板
                          ┌────────────────────────────────────────┐
                          │ 工作台  已停靠右侧              ⤢ ⇥    │
                          │ [文件] [终端] [GitCraft] [Downloader]  │
                          │                                        │
                          │         当前页面内容（与会话并排）       │
                          └────────────────────────────────────────┘
```

## 为什么不是一个大插件

三个 bundle 的**故障域、发布节奏和分发对象都不一样**，合并成一个包会把这些边界焊死：

| 维度 | dock（壳） | gitcraft（页面） | downloader（页面） |
|---|---|---|---|
| host 侧 | 2 个只读方法 | 58 个 RPC，git 子进程 | 串口 + 烧录 IPC + SSE，拉起两个 exe（含 32 位桥） |
| 依赖 | 无 | 本机 `git` | 官方 Downloader、CP210x 驱动、真实板卡 |
| 更新节奏 | 稳定（0.2.x） | 快（0.1.x 持续迭代，13 个 e2e） | 随硬件/固件变化 |
| 面向 | 想挂页面的第三方 | 社区（可独立发 npm） | 内部工具 |
| 引擎范围 | `>=0.2.1-rc.1 <0.3.0-0` | `>=0.1.6-alpha.2` | `>=0.2.1-rc.1 <0.3.0-0` |

一个 bundle 起不来可能让整棵插件树启动失败（`duplicate prefix route` 就会），所以烧录侧的异常不该带崩 Git 面板——反过来也一样。

## 页面协议

页面是**浏览器侧**注册的 React 组件，注册表放在一个浏览器全局上，两个 bundle 的加载顺序无所谓：

```js
window.__DSH_WORKBAY__.registerPage({
  id: 'myplugin',          // 必填，非空
  title: '我的页面',
  order: 40,               // 升序，GitCraft=20，Downloader=30
  icon: (size) => <Icon size={size} />,
  component: ({ t, dock }) => <MyPanel />,
})
```

若 dock 还没加载，短轮询等它出现（现有两个页面插件都这么做）。完整约定与三个已被踩过的坑见 [packages/dock/README.md](packages/dock/README.md)。

## 给别人装（从 GitHub 克隆）

本项目**刻意不发布 npm 包**：GitHub 源码就是唯一分发方式，别人克隆后按下面四步装。目标机器要求：

| 前置 | 要求 |
|---|---|
| 系统 | Windows 10/11（downloader 依赖两个 Windows helper exe 和 COM 串口） |
| DSH 桌面版 | `>=0.2.1-rc.1 <0.3.0-0` |
| Git | 任意较新版本（gitcraft 会调用本机 `git`） |
| Node.js / pnpm | Node `>=18`；pnpm 11（`corepack enable` 会按 `package.json` 的 `packageManager` 取到 11.28.5） |

```powershell
# 1) 克隆并装好 workspace 依赖
git clone https://github.com/1Lry1/dsh-workbay.git D:\tools\dsh-workbay
cd D:\tools\dsh-workbay
pnpm install

# 2) 生成要粘贴的 profile 片段（路径已按克隆位置展开）
pnpm run profile:snippet
```

```powershell
# 3) 找到自己的 profile（默认叫 desktop；不确定就列一下）
Get-ChildItem $env:USERPROFILE\.dsh\profiles
# 编辑 <profile>\package.json：把脚本打印的 bundles 三行和 dependencies 四项粘进去
```

```powershell
# 4) 装进 profile，然后“完全退出” DSH 再打开
cd $env:USERPROFILE\.dsh\profiles\desktop
pnpm install
```

左侧栏出现「工作台」即成功。

**downloader 页额外需要**（不设也能装，只是烧录不可用）：

```powershell
[Environment]::SetEnvironmentVariable('DSH_DOWNLOADER_DIR', '<厂商 Downloader 安装目录>', 'User')
[Environment]::SetEnvironmentVariable('DSH_DOWNLOADER_WORKSPACE', '<SDK 工程根目录>', 'User')
```

之后更新用 `pnpm run update`（见下）。如果哪天想要 `dsh plugin add` 一行安装，再考虑发 npm 或做 Release tarball 即可。

## 安装到 DSH

profile 目录：`C:\Users\<user>\.dsh\profiles\<profile>`（本机是 `desktop`）。

**方式 A —— 五个独立 bundle（推荐，已验证）**：`package.json` 里

```jsonc
{
  "dsh": { "profile": { "bundles": [
    "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app",
    "dsh-workbay-dock", "dsh-workbay-files", "dsh-workbay-terminal",
    "dsh-gitcraft", "dsh-downloader"
  ] } },
  "dependencies": {
    "dsh-workbay-dock":     "file:<repo>/packages/dock",
    "dsh-workbay-files":    "file:<repo>/packages/files",
    "dsh-workbay-terminal": "file:<repo>/packages/terminal",
    "dsh-gitcraft":         "file:<repo>/packages/gitcraft",
    "dsh-downloader":       "file:<repo>/packages/downloader",
    "@dsh-workbay/kit":     "file:<repo>/packages/kit"
  }
}
```

```powershell
pnpm run build          # 生成 files 页的 CodeMirror chunk（lib/chunks，gitignored）
pnpm install            # 或 dsh plugin --profile desktop add file:...
```

**方式 B —— 聚合金（实验性）**：bundles 里只加 `dsh-workbay-suite`，它一次插入五个 loader 行。见 [packages/suite/README.md](packages/suite/README.md)。

装完**重启 DSH**，左侧栏出现「工作台」。

> `@dsh-workbay/kit` 必须能被 DSH 的运行时解析到：它被 dock 和 gitcraft 的 host 半侧 import，所以 profile 的 `node_modules` 里要有它。用 `pnpm install` 时 pnpm 会按 `file:` 依赖自动装好；手工拷贝插件目录时容易漏，表现为 host 半侧加载失败。

### 在 DSH 关闭后自动安装（推荐）

`refresh-profile.ps1` 不能在 DSH 运行时执行：应用锁着插件目录，而且工作台里的终端本身就是 DSH 的子进程。所以在**工作台终端里**直接跑 `pnpm run install:profile` 必然会看到
`close DSH first, then run this script again`——这是保护，不是故障。

用这个入口可以省掉"先关再手动跑"的来回：

```powershell
pnpm run install:profile:on-exit
# 它启动一个 WMI 分离进程等待 DSH 退出，然后自动构建 + 安装。
# 现在完全退出 DSH（含托盘），装完再打开 DSH 即可；日志在 %TEMP%\dsh-workbay-install.log
```

### 更新到最新版（从 GitHub）

插件以本机克隆为安装源（`file:` 是拷贝，不是软链），所以「用 GitHub 上的版本」= 拉取克隆 + 重装 profile：

```powershell
# 1) 完全退出 DSH（不是最小化）
# 2) 在克隆目录里：
cd <repo>
pnpm run update          # git fetch + ff-only + 跑测试 + 重装 profile
pnpm run update:fast     # 同上，跳过测试
```

`pnpm run update` 只做 fast-forward：工作区脏或有本地提交时会拒绝执行，不会偷偷合并。
它和 `install:profile` 一样会在 DSH 还开着、或 `AbSerialHost.exe` / `DownloaderIpcBridge.exe` 还占着文件时中止（pnpm 会报 `ERR_PNPM_EPERM`）。

## 开发

```powershell
pnpm install                     # workspace 依赖
pnpm test                        # 所有包的单测/集成测
pnpm --filter @dsh-workbay/kit run test
pnpm --filter dsh-gitcraft run test
```

浏览器 e2e（需要运行中的 DSH + 一个 Chromium 内核浏览器）：

```powershell
node packages/gitcraft/tests/ui.e2e.mjs  <base-url> <browser-exe> <repo>
node packages/dock/tests/split.e2e.mjs   <base-url> <browser-exe> <repo> [shot.png]
node packages/downloader/smoke-test.mjs  # 25 项自检；先设 DSH_DOWNLOADER_* 环境变量，未设置的用例自动 SKIP
```

## 设计约束（别踩）

1. **客户端半侧不能 import 本仓库的包**。DSH 用 `window.__ModuleLoader__.load({ id, factory })` 加载客户端插件，一个插件就是一个自包含文件 + 宿主 `require` 种子表。所以页面注册那段小代码在两个页面插件里各留一份，这是刻意的。
2. **`@dsh-workbay/kit` 只服务 host 半侧**。它不导出任何浏览器可用的东西。
3. **downloaders 不用 kit 的 RPC 信封**：它的 host 还要输出 SSE 与二进制帧，硬套会降低可读性。
4. **不要同时挂 suite 和单包**，会重复 insert 同一行导致整棵树启动失败。
5. 每个包的 `cordis.patch.yml` 里都只有一条 `insert`；`id` 是全局唯一的 loader id。

## 常见问题

**改了 `packages/*` 但界面上没变化** — `file:` 依赖是**拷贝**进 profile 的 `node_modules`，不是软链。重启 DSH 前必须先重装 profile：

```powershell
# 先退出 DSH（不是最小化），再在克隆目录执行
pnpm run install:profile
# 或：cd $env:USERPROFILE\.dsh\profiles\desktop; pnpm install
```

**`pnpm install` 报 `ERR_PNPM_EPERM ... rename ... dsh-downloader`** — downloader 的串口 helper `AbSerialHost.exe`（烧录时会再起 `DownloaderIpcBridge.exe`）还活着，文件被占用。退出 DSH 后它们会跟着退出；顽固残留就手动结束：

```powershell
Get-Process AbSerialHost, DownloaderIpcBridge -ErrorAction SilentlyContinue | Stop-Process
```

**界面里「工作台」有了但没有页面** — 页面注册表是浏览器全局 `window.__DSH_WORKBAY__`，两个页面插件都在等它。若 dock 没被加载（`bundles` 里漏了 `dsh-workbay-dock`），页面就无处注册；反之若页面包漏了，Tab 条只有工作台本身。检查 profile 的 `dsh.profile.bundles` 三行齐全。

**host 半侧加载失败、日志报 `Cannot find package '@dsh-workbay/kit'`** — profile 的 `node_modules` 里缺 kit。`pnpm install` 会按 `file:../kit` 自动带上；手工拷贝插件目录时最容易漏。

## 参与与安全

- 开发流程、目录约定、页面注册契约和提交规范：**[CONTRIBUTING.md](CONTRIBUTING.md)**
- 漏洞报告渠道与威胁模型（路由只对 loopback 开放、插件按设计在本机执行 git/串口操作、无遥测）：**[SECURITY.md](SECURITY.md)**
- CI（[.github/workflows/ci.yml](.github/workflows/ci.yml)）：Windows 上跑 `pnpm test`，Linux 上做一遍 `node --check` 语法门禁

## License

MIT
