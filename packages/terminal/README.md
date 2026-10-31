# dsh-workbay-terminal

> 工作台里的**持久命令控制台**：在本机工作区根目录上常驻一个 shell 进程，命令按行写入
> stdin，stdout/stderr 通过 SSE 流式回传。**不是完整 TTY**（Node 没有原生 ConPTY），
> 所以没有字符级光标/全屏 TUI，但 `git`、构建、脚本、`npm` 这类按行交互的命令都可用。
>
> A **persistent command console** for the workbench: one long-lived shell process rooted
> at the chosen workspace directory, commands written to stdin by line, output streamed
> back over SSE. Not a full TTY (no native ConPTY in Node), so character-level cursor
> tricks and full-screen TUIs do not work — line-oriented tools do.

契约：`docs/files-api.md` §4/§5/§6（冻结）。本包只依赖 Node 内置模块 + `@dsh-workbay/kit`（宿主侧）。

## 功能

- **一个页面**：`{ id: 'terminal', title, order: 40, icon, component }` 注册进
  `window.__DSH_WORKBAY__`（跨 bundle 全局注册表；dock 可能后加载，页面会短轮询等待）。
- **工作区根**：只读 `localStorage['dsh-workbay.root.v1']`（由文件页写入）；没有工作区时
  显示明确空状态。文件页负责选择器，本页不写这个键。
- **控制台**：等宽输出区（**5000 行**上限，超出丢最旧）、基础 ANSI SGR（16 色 + 粗体 +
  reset，其它转义直接剥离）、单行输入 + 历史（↑/↓）、Enter 执行、`Ctrl+L` 清屏、
  Start/Stop 按钮、状态行（shell / cwd / session id / 状态）、SSE 断开后**只重连一次**，
  卸载时关闭流并清理所有定时器。
- **i18n**：内置 zh/en 字典，随宿主 locale 服务切换。

## 宿主路由（前缀 `/dsh-workbay-terminal`）

JSON 路由统一走 kit 的信封（`{ ok:true, data }` / `{ ok:false, error:{code,message} }`）：

| method | 入参 | 出参 `data` |
|---|---|---|
| `POST /api/start` | `{ root }` | `{ id, shell, cwd }` |
| `POST /api/input` | `{ id, data }` | `{ ok:true }` |
| `POST /api/stop` | `{ id }` | `{ ok:true }` |
| `POST /api/list` | `{}` | `{ sessions:[{id,cwd,startedAt}] }` |

SSE：`GET /events?id=<id>`，事件为 `data: {json}`：

- `{ type:'hello', id, shell, cwd }`
- `{ type:'out', data }`（每片 ≤ 4 KiB）
- `{ type:'exit', code }`
- `{ type:'error', message }`
- 每 20 s 一条 `: ping` 注释心跳；连接关闭即清理订阅。

## Shell 策略

- 默认 `powershell` → Windows 上为 `powershell.exe -NoLogo -NoProfile -NonInteractive -Command <REPL 脚本>`；
  其它平台上 `powershell` 视作 `pwsh`。
  这里**不用** `-Command -`：它对管道 stdin 的缓冲行为在不同 Windows 主机上不一致
  （CI 上会等到 EOF 才执行，本地却是逐行），所以改成一个固定的读-执行-刷新循环：
  `[Console]::In.ReadLine()` → `Invoke-Expression` → `[Console]::Out.Flush()`，
  并把 stdout 编码固定为 UTF-8（5.1 默认是 OEM 代码页）。
- 配置 `shell` 可换成 `pwsh` / `cmd` / `bash` / `sh` / 绝对路径。参数向量由 shell 家族
  决定（PowerShell 固定四个参数；POSIX shell 不带参数），**永远不做字符串拼接**。
- `spawn(binary, argv, { cwd: root, windowsHide: true, stdio: ['pipe','pipe','pipe'] })`，
  环境变量走白名单（`PATH`/`SystemRoot`/`TEMP`/`HOME` 等），不把 DSH 进程的全部环境
  变量（可能含凭据）泄露给用户 shell。
- `start` 之后**所有**用户输入只经 `input` 原样写入 stdin（不补换行、不加提示符）。
- `stop`：Windows 用 `taskkill /T /F /PID <pid>` 杀整棵进程树，其它平台 `SIGTERM` +
  3 s 后 `SIGKILL`；进程真正关闭后发出 `exit`。
- shell 不存在 → `500 shell-missing`；`start` 前会等 `spawn` 事件，不会先回成功。

## 限额与生命周期

| 项 | 默认 | 行为 |
|---|---|---|
| `maxSessions` | `4` | 超出 → `409 session-limit`（并发 start 也不会突破） |
| `idleTimeoutMs` | `30 min` | 无输入自动 `stop`；`0` 关闭该行为 |
| `shell` | `powershell` | 见上 |
| 输出 | 不落盘 | 只有每根管道一个 `StringDecoder`（保证 UTF-8 序列完整），进程关闭后无残留 |
| dispose | 全部 kill | `ctx.effect` 清理钩子杀掉每一个会话，并清掉所有定时器 |

命令文本**从不写日志**：宿主侧没有任何 input 日志（输出也不写）。测试断言与实现都遵守这一点。

## 安全

- 路由与 SSE 都先过 kit 的同源围栏（loopback peer / loopback Host / `Sec-Fetch-Site`），
  跨站页面不能开 shell。
- `root` 必须是绝对路径、已存在、是目录（否则 `400 bad-request`）；本包不校验「root 是否
  在某个工作区内」——调用方（文件页/宿主配置）负责根的选择与限制。
- 无 shell 字符串拼接；`taskkill` 的 PID 来自 `child.pid`（整数）。
- 只读根目录约定：终端能执行命令，权限等价于启动 DSH 的用户；这是产品设计（本地工作台），
  不是沙箱。需要隔离时应在操作系统/DSH 沙箱层解决。

## 测试

```powershell
node --test packages/terminal/tests/host.test.mjs
# 或
pnpm --filter dsh-workbay-terminal test
```

`tests/host.test.mjs` 用假 cordis ctx 启动真实 HTTP server，在系统临时目录里创建会话、
通过 stdin 执行 `echo workbay-ok` 并断言 SSE 收到输出、stop 后收到 `exit` 且 `list` 为空；
另覆盖非法 root（相对/不存在/非目录）、未知 id 404、非 POST 405、不可信 Host 403、
`maxSessions` 409、空闲自动关闭、shell 缺失 500、events 缺 id 400 等 15 个用例。
`after` 钩子统一 dispose 并删除临时目录，**不会留下 shell 进程**。

## 已知限制（诚实清单）

- **无 PTY**：没有字符级输入、光标控制、`nano`/`vim`/`top` 这类全屏程序无法正常使用；
  `Ctrl+C` 之类信号键不转发（要中断就 Stop 后重启，或命令自己处理）。
- **Windows PowerShell 5.1 编码**：其重定向 stdin/stdout 使用系统 ANSI/OEM 代码页，非 ASCII
  命令文本可能乱码；需要完整 Unicode 时把 `shell` 配成 `pwsh`（PowerShell 7 默认 UTF-8）。
- ANSI 只渲染 16 色 + 粗体；256 色/真彩色和光标移动等序列会被剥离。
- 输出按「每事件 ≤4096 字符」切片（UTF-8 由 `StringDecoder` 保证不截断多字节序列）。
- **未在真实 DSH 中验证**的部分：`ctx.webServer.register({ kind:'prefix' })` 的真实路由匹配、
  `window.__ModuleLoader__` 装载与 dock 的页面注册时序、`ctx.get('locale')` 服务形状。
  这些是仓库既有契约（dock/gitcraft 同款写法），本包按契约实现并有本地 stub 冒烟，
  但没有可用的 DSH 运行时做端到端验证。

## 文件

| 文件 | 作用 |
|---|---|
| `src/index.js` | 宿主：路由、shell 会话、SSE、限额、dispose |
| `src/client.js` | 浏览器：单文件 ModuleLoader 页面（无 import / 无 JSX） |
| `tests/host.test.mjs` | 宿主端到端测试（真 HTTP + 真 shell，临时目录） |
| `cordis.patch.yml` | bundle patch：`shell` / `maxSessions` / `idleTimeoutMs` |
| `icon.svg` | 页面图标源文件（注册时用内联 SVG，保持一致） |
