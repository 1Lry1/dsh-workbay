# workbay 文件/终端能力：接口契约（实现前先定稿）

这份契约是 `packages/files`、`packages/terminal` 两个 bundle 的约定。客户端半侧是单文件
`window.__ModuleLoader__.load({ id, factory })`，**不能 import 仓库里的包**；重依赖（CodeMirror）
通过 chunk 懒加载。所有路由都走 `@dsh-workbay/kit` 的同源围栏。

## 1. 安全模型（所有 fs 路由共用）

- 客户端必须显式传 `root`：绝对路径、已存在、是目录。
- `rel` 一律 POSIX 分隔符（`a/b/c`），不得以 `/` 开头，不得含 `..` 段。
- 宿主解析：`path.resolve(root, rel)` → `realpathSync.native` → 必须仍在 `realpath(root)` 内（前缀比较 + 分隔符边界）。
- 越界、非法 rel、绝对路径：`403 outside-root` / `400 bad-request`。
- 单文件读取上限 `maxBytes`（默认 1 MiB，最大 8 MiB）；over → `truncated: true`。
- 写操作上限 2 MiB；默认**只读**，写需要 `allowWrite: true`（由 profile 配置决定，见 §5）。
- 不执行任何 shell 命令（终端是独立 bundle，见 §4）。

## 2. `dsh-workbay-files` 宿主路由（前缀 `/dsh-workbay-files`）

全部 `POST /api/<method>`，JSON 入参出参 `{ ok:true, data }` / `{ ok:false, error:{code,message} }`。

| method | 入参 | 出参 `data` |
|---|---|---|
| `roots` | `{}` | `{ root, drives:[{name,path}], recent:[string] }` |
| `browse` | `{ dir }` | `{ dir, parent, entries:[entry] }`（选工作区根用的目录浏览） |
| `tree` | `{ root, dir='', showHidden=false }` | `{ root, dir, entries:[entry], truncated }` |
| `search` | `{ root, query, limit=200 }` | `{ matches:[entry], truncated }` |
| `read` | `{ root, rel, maxBytes? }` | `{ content, size, mtimeMs, encoding:'utf8'|'binary', truncated }` |
| `write` | `{ root, rel, content, baseMtimeMs? }` | `{ size, mtimeMs }`；mtime 不符 → `409 conflict` |
| `stat` | `{ root, rel }` | `{ entry }` |
| `mkdir` | `{ root, rel }` | `{ entry }` |
| `rename` | `{ root, from, to }` | `{ entry }` |
| `delete` | `{ root, rel }` | `{ ok:true }`（目录需空或递归开关） |

`entry`：
```ts
{ name: string, rel: string, type: 'dir'|'file'|'symlink', size?: number, mtimeMs?: number, hasChildren?: boolean }
```

### 媒体路由（GET）

`GET /dsh-workbay-files/media?root=<abs>&rel=<rel>`

- 按扩展名给 `content-type`；未知按 `application/octet-stream`。
- 响应头：`cache-control: no-cache`、`x-content-type-options: nosniff`、
  `content-security-policy: sandbox; object-src 'none'`（svg/html 也不允许脚本）、
  `content-disposition: inline`；二进制大文件支持 Range。
- 客户端用法：`<img src>`、`<embed type="application/pdf">`、沙箱 `<iframe sandbox>` 渲染 html。

## 3. Chunk 协议（重依赖懒加载）

宿主：`GET /dsh-workbay-files/chunk/<name>.js`（终端包同形：`/dsh-workbay-terminal/chunk/<name>.js`），从 `lib/chunks/` 读文件，
`cache-control: no-cache` + `ETag`（内容 hash），304 支持；缺文件 404。

脚本格式（构建产物，**不要手写**）：
```js
globalThis.__dshChunks__ = globalThis.__dshChunks__ || {}
globalThis.__dshChunks__['dsh-workbay-files:editor'] = (env) => {
  const require = (spec) => { /* env.modules[spec] */ }
  /* … esbuild CJS bundle … */
  return module.exports
}
```

`env` 由客户端传入：`{ modules: { react, 'react/jsx-runtime': ..., 'react-dom': ... } }` —— 复用主 bundle
已经 `require` 到的同一份 React，避免双 React 实例。

客户端加载器（`loadChunk(name)`）：注入一次 `<script src>`，读 `globalThis.__dshChunks__[name]`，
调用工厂，缓存 Promise；失败删除缓存以便重试。

**editor chunk 的对外接口**：
```js
const editor = await loadChunk('dsh-workbay-files:editor')
const handle = editor.createEditor(container, {
  content, language, readOnly, line,
  onChange(text), onSave(), onCursor(line, col),
})
handle.setContent(text) / handle.destroy()
```
语言覆盖：js/ts/jsx/tsx/json/md/py/go/rust/java/c/cpp/h/cs/html/css/xml/yaml/yml/sql/sh/ps1，
未知回退 plain text。

## 4. `dsh-workbay-terminal`（前缀 `/dsh-workbay-terminal`）

两种模式，`start` 返回的 `mode` 与 SSE `hello.mode` 告知客户端：

- **`pty`（默认，Windows）**：真 PTY。宿主启动 `helper/WorkbayPty.exe`（ConPTY，
  独立 C# 进程，因为 Electron 主进程不能加载 Node 原生模块），`input` 是**原始按键**
  （`\r`、`\x03`、方向键 `\x1b[A`…），由 PTY 里的 shell 回显与编辑；可跑 vim/top、
  彩色输出、Ctrl+C。协议见 [terminal-pty.md](terminal-pty.md)。
- **`command`（回退：非 Windows / helper 缺失 / `pty:'off'`）**：逐命令进程，
  会话维护 cwd，`cd` 由宿主处理，交互式程序不可用。

| method | 入参 | 出参 |
|---|---|---|
| `start` | `{ root, cols?, rows?, shell? }` | `{ id, shell, cwd, mode }` |
| `input` | `{ id, data }` | `{ ok:true }`（pty：原始按键；command：按 `\r?\n` 切分） |
| `resize` | `{ id, cols, rows }` | `{ ok:true }`（20..500 × 5..200） |
| `restart` | `{ id }` | `{ id, shell, cwd, mode }`（同 cwd 新会话，旧会话回收） |
| `stop` | `{ id }` | `{ ok:true }` |
| `list` | `{}` | `{ sessions:[{id, cwd, startedAt, mode}] }` |

流：`GET /dsh-workbay-terminal/events?id=<id>`（SSE），事件
`{ type:'out', data }` / `{ type:'exit', code }` / `{ type:'error', message }`；
`hello` 额外带 `mode`、`cols`、`rows`。

行为约定：

- PTY 模式不做任何宿主侧解释：不拦 `cd`、不加行缓冲、不本地回显，字节进出。
- command 模式的约定保持不变：`cd` 宿主处理、cwd 跨命令保留、环境变量不保留、
  命令串行 + 队列、每条命令结束回显 `[exit N]`、每条命令额外开销 ≈ 一次 shell 启动。
- command 模式强制 UTF-8 输出（PowerShell 前置 `[Console]::OutputEncoding`，cmd 前置
  `chcp 65001>nul &`），否则中文在 OEM 代码页下会乱码（真实截图里出现过）。
- 约束：最多 8 个会话（硬上限 32）；插件 dispose 时全部 kill；30 分钟无输入自动关闭；
  输出按 4 KiB 分片、ANSI 转义原样透传；不记录到日志文件。

## 5. 配置

| 配置项 | 位置 | 默认 |
|---|---|---|
| `allowWrite` | `dsh-workbay-files` 的 cordis 行 config | `false`（profile 里显式开） |
| `maxFileBytes` | 同上 | `1 MiB` |
| `terminal.shell` | `dsh-workbay-terminal` config | `auto`（Windows 优先 `pwsh.exe`，回退 `powershell.exe`） |
| `terminal.pty` | 同上 | `auto`（`off` 强制逐命令，`on` 缺 helper 时 500） |
| `terminal.maxSessions` | 同上 | `8`（硬上限 32） |

## 6. 页面注册

两个 bundle 都通过浏览器全局注册页：

```js
window.__DSH_WORKBAY__.registerPage({
  id: 'files' | 'terminal',
  title: t('page.files') / t('page.terminal'),
  order: 10 | 40,
  icon: (size) => …,
  component: (props) => …,
})
```

工作区根存在 `localStorage['dsh-workbay.root.v1']`，两个页面共用；未选根时页面显示“选择工作区”。

## 7. 测试要求

- host：`node --test packages/files/tests/*.test.mjs`，必须覆盖越界/符号链接逃逸/大小上限/写冲突/媒体头。
- client：纯函数（tree 展开、排序、搜索高亮、ANSI 解析）单测；组件用既有 hook 运行时冒烟。
- e2e（CDP）：打开工作台 → 文件页 → 选根 → 展开目录 → 打开文件 → 编辑保存 → 终端执行命令。
- 性能预算见 `docs/performance.md`（M0 建立）。
