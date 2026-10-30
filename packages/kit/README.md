# @dsh-workbench/kit

DSH 工作台各 bundle 共用的 **host 半侧**工具。只服务于 Node 侧，浏览器侧刻意不复用（原因见下）。

## 为什么只有 host 侧

DSH 的客户端插件不是 ESM 模块，而是：

```js
window.__ModuleLoader__.load({
  id: 'dsh-gitcraft',
  factory: (require) => { const React = require('react'); /* ... */ },
})
```

一个插件 = 一个自包含文件 + 宿主提供的 `require` 种子表。浏览器侧**无法 `import '@dsh-workbench/kit'`**，所以「工作台页面注册」那段几十行小代码在两个页面插件里各留一份，而不是抽成公共依赖。

## 提供什么

| 导出 | 作用 |
|---|---|
| `ApiError` / `badRequest(message)` | 带 HTTP status、可安全暴露给调用方的错误 |
| `messageOf(error)` | 统一的错误取文 |
| `isTrustedRequest(req)` | 同源围栏：loopback peer / loopback Host / `Sec-Fetch-Site` same-origin |
| `sendJson(res, status, body)` | JSON 响应（带 `no-store`、精确 `content-length`） |
| `readJsonBody(req, limit)` | 有上限的 JSON 读取，空体转 `{}`，超限 413 |
| `createJsonApiHandler({ prefix, methods, maxBodyBytes, run })` | `POST <prefix>/<method>` → `{ ok, data }` / `{ ok: false, error }` |
| `mountJsonApi(ctx, options)` | 在插件 `apply` 里注册前缀路由，随 `ctx` 销毁 |

`run` 钩子用于串行化，例如 GitCraft 的「同一仓库的写操作串行执行」：

```js
mountJsonApi(ctx, {
  prefix: '/dsh-gitcraft/api',
  methods: METHODS,
  maxBodyBytes: 2 * 1024 * 1024,
  run: (method, payload, invoke) =>
    WRITE_METHODS.has(method)
      ? withRepoLock(lockKeyOf(payload), invoke)
      : invoke(),
  label: 'dsh-gitcraft',
})
```

错误映射：`ApiError` → 用它的 `status/code`；其它带 `status(number) + code(string)` 的错误（两个页面插件各自的 `PanelError` / `DockError`）→ 同样按原样映射；其余 → 500 `internal`，只暴露 `message`。

## 谁在用

- `dsh-workbench-dock`：2 个方法（`ping` / `registry`）
- `dsh-gitcraft`：54 个方法，带写锁钩子
- `dsh-downloader`：**不用**。它的 host 还要输出 SSE 与二进制帧，不是纯 JSON RPC 映射表，硬套会降低可读性。

## 测试

```powershell
node --test packages/kit/tests/host.test.mjs
```
