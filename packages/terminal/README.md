# dsh-workbay-terminal

> 工作台里的**命令控制台**：会话常驻（记录工作目录与 shell），但**每条命令一个进程**——
> 输入按行切分，每行启动一次 shell，stdout/stderr 通过 SSE 流式回传，`cd` 由宿主处理所以
> 工作目录跨命令保留。**不是完整 TTY**（Node 没有原生 ConPTY），没有字符级光标/全屏 TUI，
> 但 `git`、构建、脚本、`npm` 这类按行交互的命令都可用。
>
> A **command console** for the workbench: the session persists (it owns the cwd and the
> shell choice) but **every command line runs as its own process**; output streams back
> over SSE and `cd` is handled host-side, so the working directory survives between
> commands. Not a full TTY (no native ConPTY in Node): no character-level input or
> full-screen TUI, but line-oriented tools work.

契约：`docs/files-api.md` §4/§5/§6（冻结）。本包只依赖 Node 内置模块 + `@dsh-workbay/kit`（宿主侧）。

## 为什么是「每条命令一个进程」

早期实现是一个常驻 shell（`powershell -NoLogo -NoProfile -Command -`），命令写入它的 stdin。
本机正常，但 GitHub 的 `windows-latest` runner 上**不消费管道 stdin**（会话活着、`hello`
正常、写入的命令永远不执行）；`-EncodedCommand` + `[Console]::OpenStandardInput()` 同样失败。
Node 没有 PTY 可退，所以改为**每条命令一次进程**：命令是 argv 的一个元素，不再依赖任何
stdin 消费行为，在任何主机上都是确定的。

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
| `POST /api/start` | `{ root }` | `{ id, shell, cwd }`（只建会话，不启动进程） |
| `POST /api/input` | `{ id, data }` | `{ ok:true }`（按 `\r?\n` 切分，剩余半行缓冲） |
| `POST /api/stop` | `{ id }` | `{ ok:true }` |
| `POST /api/list` | `{}` | `{ sessions:[{id,cwd,startedAt}] }`（`cd` 后 cwd 已更新） |

SSE：`GET /events?id=<id>`，事件为 `data: {json}`：

- `{ type:'hello', id, shell, cwd }`
- `{ type:'out', data }`（每片 ≤ 4 KiB；含 ANSI 转义）
- `{ type:'exit', code }`（**仅会话级**：stop / dispose / 空闲超时）
- `{ type:'error', message }`
- 每 20 s 一条 `: ping` 注释心跳；连接关闭即清理订阅。

单条命令结束后**不会**发 `exit`，而是回一个普通 `out` 标记 `\r\n[exit N]\r\n`，会话继续。

## Shell 策略（每条命令一个进程）

- `start` 只校验 root 与 shell、记录会话 `{id, cwd, shell}`；不跑任何进程。
- `input` 的完整行按 shell 家族启动**一个**子进程：
  - PowerShell：`['-NoLogo','-NoProfile','-NonInteractive','-Command', line]`
  - cmd：`['/D','/Q','/C', line]`
  - POSIX（bash/sh/…）：`['-c', line]`
  - `spawn(binary, argv, { cwd: session.cwd, windowsHide:true, stdio:['ignore','pipe','pipe'], env: allowlist })`。
    命令行永远是**一个 argv 元素**，从不做字符串拼接。
- **cwd 由宿主保存**：`cd <dir>`（整行匹配、可带引号）由宿主解析相对 cwd、校验目录存在、
  更新 `session.cwd` 并把新路径作为 `out` 回显；它**不启动进程**，所以下一条命令在新目录执行。
  不合法的 `cd` 只回显错误，cwd 不变。`cd` 没有目标时回显当前 cwd。
- **环境变量不跨命令保留**：每个进程都从白名单（`PATH`/`SystemRoot`/`TEMP`/`HOME` 等）
  重新构造环境，且 `-NoProfile` 不加载用户 profile；因此 `$env:FOO=…`、别名、函数都不会
  带到下一条命令。需要持久配置时请写进脚本文件或改用项目级工具。
- **一次只跑一条**：同一会话内多余的行排队，前一条结束后自动开始下一条。
- **stop**：Windows 用 `taskkill /T /F /PID <pid>` 杀正在运行的整棵进程树，其它平台
  `SIGTERM` + 3 s 后 `SIGKILL`；随后发出会话级 `{ type:'exit', code }` 并删除会话。
  `stop` 会丢弃半行缓冲与排队中的命令。
- **shell 发现**：配置为绝对路径时必须存在；裸名字（默认 `powershell`）通过允许列表里的
  `PATH`/`PATHEXT` 解析（Windows 上 `powershell`→`powershell.exe`，其它平台→`pwsh`）。
  找不到 → `500 shell-missing`；**不做 spawn 探测**。

## 限额与生命周期

| 项 | 默认 | 行为 |
|---|---|---|
| `maxSessions` | `4` | 超出 → `409 session-limit` |
| `idleTimeoutMs` | `30 min` | 无输入自动 stop（会杀掉正在运行的进程树）；`0` 关闭该行为 |
| 半行缓冲 | 64 KiB | 超限丢弃并回 `error` 事件，不会无限增长 |
| 输出分片 | ≤ 4096 字符 | `StringDecoder` 保证不截断 UTF-8 序列 |
| 请求体 | 64 KiB | kit 的 `maxBodyBytes` |
| dispose | 全部 kill | `ctx.effect` 清理钩子杀掉运行中的命令树并清空所有会话/队列 |

命令文本**从不写日志**：宿主侧没有任何 input 日志（输出也不写）。测试断言与实现都遵守这一点。

## 安全

- 路由与 SSE 都先过 kit 的同源围栏（loopback peer / loopback Host / `Sec-Fetch-Site`），
  跨站页面不能执行命令。
- `root` 必须是绝对路径、已存在、是目录（否则 `400 bad-request`）；本包不校验「root 是否
  在某个工作区内」——调用方（文件页/宿主配置）负责根的选择与限制。
- 无 shell 字符串拼接：命令是 argv 元素；`cd` 是宿主侧路径运算，不经过 shell。
  `taskkill` 的 PID 来自 `child.pid`（整数）。
- 权限等价于启动 DSH 的用户；这是产品设计（本地工作台），不是沙箱。需要隔离时应在
  操作系统/DSH 沙箱层解决。

## 测试

```powershell
# 从 packages/terminal 运行
node --check src/index.js
node --test
# 或
pnpm --filter dsh-workbay-terminal test
```

`tests/host.test.mjs` 用假 cordis ctx 启动真实 HTTP server，在系统临时目录里跑真实命令：

- 单条 `echo workbay-ok` → SSE 收到 `out`，随后收到 `[exit N]` 且会话仍存活；
- 连续两条命令、一次 input 里排队两行（并校验顺序）、半行缓冲到换行才执行；
- `cd nested` 后 `list().cwd` 更新，下一条命令在子目录里执行；非法 `cd` 保持 cwd；
- `stop` 杀掉正在 sleep 的命令（stop 不等待命令自然结束）并删除会话；
- 空闲超时 stop 会杀掉正在运行的命令树：命令原本 4 s 后写「survived」标记文件，
  测试断言该文件**永远不会出现**（无孤儿进程）；
- 非法 root（相对/不存在/非目录）、未知 id 404、非 POST 405、不可信 Host 403、
  events 缺 id 400、`data` 非字符串 400、`maxSessions` 409、shell 缺失 500、
  默认 `powershell.exe`、空闲无命令自动关闭。

共 **23 个用例**，全绿约 14 s。`after` 钩子统一 dispose、关闭 server、删除临时目录，
**不会留下子进程**。

## 已知限制（诚实清单）

- **无 PTY / 无交互 stdin**：没有字符级输入、光标控制、`nano`/`vim`/`top` 这类全屏程序
  无法使用；`Ctrl+C` 不转发（要中断就 Stop，或命令自己处理超时）。
- **每条命令一次进程启动开销**（Windows PowerShell 约 200–500 ms）；`cd` 不启动进程，
  但其余每条命令都有这份固定成本。
- **环境变量/别名/函数不跨命令保留**（每次都是新进程 + `-NoProfile`）。
- **`cd` 只处理整行**：`cd sub && make` 这样的复合命令不会被宿主识别（会整行交给 shell，
  其中 `cd` 只影响该子进程）。需要切换目录请单独发一行 `cd`。
- **Windows 命令行长度**：命令作为 argv 传入，受 CreateProcess 命令行上限（约 32K 字符）
  约束；请求体上限 64 KiB，超长单行会启动失败（会看到 error + `[exit -1]`）。
- **Windows PowerShell 5.1 输出编码**：stdout 被重定向时仍使用系统 ANSI/OEM 代码页，
  非 ASCII **输出**可能乱码（命令文本走 argv，不受 stdin 代码页影响）；需要完整 Unicode
  输出时把 `shell` 配成 `pwsh`（PowerShell 7 默认 UTF-8）。
- ANSI 只渲染 16 色 + 粗体；256 色/真彩色和光标移动等序列会被剥离。
- **未在真实 DSH 中验证**的部分：`ctx.webServer.register({ kind:'prefix' })` 的真实路由匹配、
  `window.__ModuleLoader__` 装载与 dock 的页面注册时序、`ctx.get('locale')` 服务形状。
  这些是仓库既有契约（dock/gitcraft 同款写法），本包按契约实现并有本地 stub 冒烟，
  但没有可用的 DSH 运行时做端到端验证。

## 文件

| 文件 | 作用 |
|---|---|
| `src/index.js` | 宿主：路由、会话/cwd、逐条命令、SSE、限额、dispose |
| `src/client.js` | 浏览器：单文件 ModuleLoader 页面（无 import / 无 JSX） |
| `tests/host.test.mjs` | 宿主端到端测试（真 HTTP + 真 shell，临时目录） |
| `cordis.patch.yml` | bundle patch：`shell` / `maxSessions` / `idleTimeoutMs` |
| `icon.svg` | 页面图标源文件（注册时用内联 SVG，保持一致） |
