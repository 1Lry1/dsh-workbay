# dsh-workbay-terminal

> 工作台里的**真终端**页面：ConPTY + xterm.js + 多 tab。
> 宿主半侧是普通 ESM；浏览器半侧是单文件 `__ModuleLoader__` bundle；重依赖（xterm）
> 通过懒加载 chunk 提供。
>
> A **real terminal** page for the workbench: ConPTY + xterm.js + tabs. The host half is
> plain ESM, the browser half is one `__ModuleLoader__` bundle, and xterm ships as a lazy
> chunk.

契约：`docs/files-api.md` §4/§5/§6、`docs/terminal-pty.md`（冻结）。
本包宿主侧只依赖 Node 内置模块 + `@dsh-workbay/kit`。

## 架构

```
浏览器 (xterm.js, 多 tab)
   │  POST /dsh-workbay-terminal/api/{start,input,resize,restart,stop,list}
   │  GET  /dsh-workbay-terminal/events?id=      (SSE: hello/out/exit/error)
   ▼
宿主 (Electron 主进程里的插件)
   │  stdio 帧协议：1B type + uint32 LE len + payload
   ▼
helper/WorkbayPty.exe  (C# / ConPTY)
   ▼
powershell.exe -NoLogo -NoProfile -NoExit   （真正的控制台进程）
```

为什么 PTY 要独立进程：Electron 主进程不能加载 Node 原生模块（ABI 不匹配、没有编译
工具链），所以用 in-box `csc.exe` 编一个 .NET Framework 的 ConPTY helper，宿主只做帧桥接。
协议与退出码见 [helper/README.md](helper/README.md)。

## 模式

| mode | 条件 | 行为 |
|---|---|---|
| `pty` | Windows 且 helper 存在（默认 `pty: auto`） | 真 PTY：原始按键、shell 回显、彩色、Ctrl+C、vim/top 等交互程序 |
| `command` | 非 Windows / helper 缺失 / `pty: 'off'` | 逐命令进程回退：cwd 由宿主维护、每条命令一个新进程、交互程序不可用 |

`pty: 'on'` 时 helper 缺失会 `500 pty-unavailable`，不会悄悄降级。
helper 选择顺序：config `ptyHelper` > 环境变量 `DSH_WORKBAY_TERMINAL_PTY_HELPER` >
包内 `helper/WorkbayPty.exe`（前两个只用于测试/开发）。

默认 `shell: auto`：Windows 上优先 **PowerShell 7（`pwsh.exe`，默认 UTF-8）**，没有才回退
`powershell.exe`；其它平台 `pwsh` → `bash` → `sh`。也可以显式写 `pwsh` / `powershell` /
`cmd` / 绝对路径。

## 页面

- **多 tab**：`+` 新建、`×` 关闭、中键关闭、双击重命名；切 tab 只隐藏不销毁，
  每个 tab 一个 xterm 实例 + 一个宿主 session + 一条 SSE。
- **键盘**：`xterm.onData` 原样发给 PTY（不本地回显）；`Ctrl+Shift+C/V` 复制粘贴；
  `Ctrl+L` 清屏（`\x0c`）；尺寸变化 200ms 防抖后 `resize`。
- **主题**：从 DSH 的 `--dsw-alias-*` / `--dsw-font-family-mono` 读取，附明暗两套 ANSI 配色。
- **状态条**：shell / cwd / 模式（PTY、非 PTY）/ tab 数；会话退出保留 scrollback 并可 Restart。
- **切页保持**：工作台切到其它页面时 dock 会卸载本页；终端在中止 SSE、销毁 xterm 后
  **不 stop 宿主会话**，把 tab 元数据写入 `localStorage['dsh-workbay.terminal.tabs.v2']`。
  再进入时 `api/list` 找回存活会话并重新挂 SSE（“会话已恢复”），丢失的会话显示
  Restart；只有显式关闭 tab 才真正 stop。tab 上限 8（宿主 maxSessions 默认值）。
- 工作区根由文件页写入 `localStorage['dsh-workbay.root.v1']`；没有根时显示空状态。

## 宿主路由

| 路由 | 说明 |
|---|---|
| `POST /api/start` `{root, cols?, rows?, shell?}` | `{id, shell, cwd, mode}` |
| `POST /api/input` `{id, data}` | pty：原始按键；command：按 `\r?\n` 切分 |
| `POST /api/resize` `{id, cols, rows}` | clamp 20..500 × 5..200 |
| `POST /api/restart` `{id}` | 同 cwd/mode 新会话，旧会话回收 |
| `POST /api/stop` `{id}` | 杀进程树，发会话级 `exit` |
| `POST /api/list` `{}` | `{sessions:[{id, cwd, startedAt, mode}]}` |
| `GET /events?id=` | SSE：`hello{mode,cols,rows}` / `out` / `exit` / `error` + 20s 心跳 |
| `GET /chunk/<name>.js` | 懒加载 chunk（xterm），ETag + 304，防穿越 |

全部挂在 DSH 自己的 web server 上，走 kit 的同源围栏（loopback / same-origin）。

## 限额与生命周期

- 最多 8 个会话（硬上限 32），每个会话一个 PTY/命令进程。
- 30 分钟无输入自动关闭；插件 dispose 时全部杀掉。
- 输出按 4 KiB 分片、ANSI 原样透传；不落盘、不记录命令文本。
- command 模式额外强制 UTF-8 输出（PowerShell 前置 `[Console]::OutputEncoding`，
  cmd 前置 `chcp 65001>nul &`），否则中文会按 OEM 代码页输出成乱码。

## 构建 helper

```powershell
& 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe' /nologo /optimize+ /target:exe `
  /out:packages\terminal\helper\WorkbayPty.exe packages\terminal\helper\WorkbayPty.cs
```

`WorkbayPty.exe` 和 downloader 的 helper 一样是**入库的二进制**（源码同时提交）。
构建前确保没有 helper 在运行，否则 csc 会报 `CS0016`。

## 测试

```powershell
# 从 packages/terminal 运行
node --test tests/pty-helper.test.mjs   # helper：帧协议/UTF-8/ANSI/退出码/自清理
node --test tests/host.test.mjs         # 宿主：pty + command + fake-helper + chunk 路由
node --test tests/client.test.mjs       # 客户端：tab reducer、SSE 解析、chunk 加载、行编辑
node --test                             # 全部（约 1 分钟）
```

helper 测试在非 Windows 或 exe 缺失时跳过；宿主用能力探针决定是否跑真实 PTY 用例，
helper 坏掉时是 skip-with-reason，而不是红 CI。

## 已知限制

- 没有 session 持久化：关闭 DSH 后 shell 不保留。
- 切页时会话保留在宿主侧，但 scrollback 不保留（重进只显示“会话已恢复”）。
- 剪贴板走浏览器权限；`Ctrl+Shift+C/V` 是显式绑定，不是系统默认。
- Windows 上 ConPTY 需要 Win10 1809+；更老的系统自动落到 command 模式。
