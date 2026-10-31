# 终端 PTY 方案（ConPTY helper + xterm 客户端）

目标：把 `dsh-workbay-terminal` 从“逐命令控制台”升级成**真终端**：
真 PTY（可跑交互式程序、彩色输出、Ctrl+C）、客户端 xterm.js、多 tab。

约束：插件 host 半侧跑在 DSH 的 Electron 主进程里，**不能加载 Node 原生模块**
（ABI 不匹配、没有编译工具链）。所以 PTY 由**独立 C# 辅助进程**提供，host 只管道桥接。

## 1. `WorkbayPty.exe`（C# / .NET Framework 4.8，csc 编译）

源码 `packages/terminal/helper/WorkbayPty.cs`，产物 `packages/terminal/helper/WorkbayPty.exe`
（和 downloader 的 `helper/*.exe` 一样，二进制入库，源码一起提交）。

启动参数（固定形状，全部由 host 传入，不接受用户拼接的字符串）：

```
WorkbayPty.exe --shell <exe 绝对路径> --shell-args <base64(JSON 数组)> --cwd <目录> --cols <n> --rows <n>
```

- `--shell-args` 是 JSON 数组的 base64（UTF-8），例如 PowerShell 的
  `["-NoLogo","-NoProfile","-NoExit"]`（`-NoExit` 让 PTY 里的 shell 常驻）。
- 不支持/缺失的参数 → 退出码 2，stderr 说明。

### 帧协议（stdin / stdout，二进制）

```
+------+----------------+----------------+
| type | uint32 LE 长度 | payload (bytes)|
| 1B   | 4B             | N              |
+------+----------------+----------------+
```

host → helper（写 helper.stdin）：

| type | payload | 含义 |
|---|---|---|
| `D` | 原始字节 | 写进 PTY 输入（键盘输入，含 `\x03` 等） |
| `R` | 4B：uint16 cols + uint16 rows | 调整 PTY 尺寸 |
| `X` | 4B：uint32 pid（0=全部） | 终止进程树 |

helper → host（读 helper.stdout）：

| type | payload | 含义 |
|---|---|---|
| `D` | 原始字节 | PTY 输出（UTF-8，不保证按字符对齐） |
| `X` | 4B：int32 exit code | shell 已退出，helper 随后退出 |

- helper 的 stderr 只写诊断文本，host 只在启动失败时读。
- host 关闭 stdin（EOF）→ helper 杀掉 shell 进程树并退出。
- helper 退出码：0 正常、2 参数错误、3 PTY 创建失败、4 进程创建失败。

## 2. 宿主（`packages/terminal/src/index.js`）

新增模式，`start` 返回 `{ id, shell, cwd, mode }`，`mode` 为 `pty` 或 `command`：

- `pty`（Windows 且 helper 存在）：每个会话一个 helper 进程；`input` 把 `data`
  当**原始按键**写入（`\r`=回车、`\x03`=Ctrl+C、方向键是 `\x1b[A`…），由 PTY 里的
  shell 回显/编辑；`resize` 发帧 `R`；`stop` 发 `X` 并收尸。
  输出用 `StringDecoder('utf8')` 增量解码，SSE 仍发 `{type:'out',data}` 文本。
- `command`（非 Windows / 没有 helper）：保留现有逐命令模型作为回退，
  `hello.mode` 里告知客户端。客户端据此决定要不要本地回显和行编辑。

新增 method：

| method | 入参 | 出参 |
|---|---|---|
| `resize` | `{ id, cols, rows }` | `{ ok:true }` |
| `restart` | `{ id }` | `{ id, cwd, mode }`（同 cwd 新会话，旧会话被回收） |

`start` 额外可选 `{ cols, rows, shell? }`；`shell` 仅配置里允许时生效（默认沿用配置）。
配置默认 `shell: auto`：Windows 上按 `pwsh.exe` → `powershell.exe` 解析，其它平台 `pwsh` → `bash` → `sh`。

安全：helper 的 argv 全部来自固定模板 + 配置路径，用户输入只走 PTY stdin；
`--shell-args` 只接受 JSON 数组；`cwd` 必须是存在的目录。

## 3. 客户端（xterm.js，多 tab）

- 重依赖进 chunk：`packages/terminal/src/chunks/xterm.js`，用 `@xterm/xterm` +
  `@xterm/addon-fit`，CSS 以文本形式打进 chunk（`loader: {'.css':'text'}`），
  客户端注入一次 `<style>`；chunk key `dsh-workbay-terminal:xterm`。
- 页面结构：顶部 tab 条（`+` 新建、`×` 关闭、双击重命名、中键关闭）+ 终端区 + 状态条。
  每个 tab 一个 session、一个 xterm 实例；切 tab 用 `display` 隐藏，**不销毁**。
- 键盘：xterm `onData` → `POST input`（原样字节）；`onResize` → `POST resize`；
  Ctrl+C 由 PTY 处理（`\x03`），Ctrl+Shift+C/V 复制粘贴，Ctrl+L 清屏（`\x0c`）。
- 主题：从 `--dsw-alias-*` 读前景/背景/光标色，ANSI 16 色给一套明暗两套配色。
- 未选工作区时显示空状态（根路径仍由文件页写入 `localStorage['dsh-workbay.root.v1']`）。
- 断线：SSE `error`/关闭自动重连一次；会话消失提示并允许 `restart`。
- `mode === 'command'` 时：本地回显 + 退格 + 上下历史，回车才发整行（`\r`），
  输出原样打印；状态条标注“非 PTY 模式”。

### 3.1 跨页面切换保持会话（必须）

dock 切页会卸载页面组件；终端必须**恢复**而不是重开：

- 页面卸载时：中止 SSE、销毁 xterm，但**不调用 `api/stop`**，宿主会话继续存活
  （受 30 分钟空闲超时约束）。
- tab 元数据持久化到 `localStorage['dsh-workbay.terminal.tabs.v2']`
  （防抖 300ms）：`{ version:2, tabs:[{ tabId, title, root, sessionId, cwd, mode }] }`。
- 页面挂载时：读存储 → `api/list` → 对仍存在的 `sessionId` 重新 `GET events` 并重建 xterm
  （`hello` 校验 mode/cwd）；已消失的 tab 标为 exited 并提供 Restart（`api/restart`）。
- 新建 tab 的上限 = 宿主 `maxSessions`（默认 8）；恢复时超出上限的 tab 标记 exited。
- 只有用户显式关闭 tab（`×`/中键）才 `api/stop` 并从存储中删除。
- 状态条显示恢复数量（如“已恢复 2 个会话”），避免用户误以为新开。

## 4. 回退与兼容

- helper 不存在 / 非 Windows → `command` 模式，页面功能不缺失（只是不能跑全屏 TUI）。
- 旧客户端只认 `out/exit/error` + `input/stop/list`，新 host 全部保留；
  新客户端读 `hello.mode` 决定行为，不认识 `mode` 时按 `command` 处理。
- 逐命令模式的 UTF-8 乱码修复：PowerShell 每条命令前置
  `[Console]::OutputEncoding=[Text.Encoding]::UTF8`，cmd 前置 `chcp 65001>nul &`。

## 5. 测试

- helper：Node 脚本直接 spawn，验证 ① echo 文本 ② 中文 UTF-8 ③ ANSI 颜色透传
  ④ `R` 帧不崩 ⑤ `X` 帧退出码 ⑥ EOF 自清理 ⑦ 参数错误码。
- host：单元测试覆盖 `pty` 与 `command` 两种模式（无 helper 时自动回退）、
  `resize`/`restart`、并发会话、SSE 帧、stop 清树。
- e2e：CDP 打开终端页 → 新建 tab → 输入 `echo` → 断言 xterm 缓冲出现结果 →
  再开一个 tab 断言互不影响。
