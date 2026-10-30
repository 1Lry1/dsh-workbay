# 架构说明

## 三个半侧

DSH 的一个插件包 = 两个半侧：

| 半侧 | 入口 | 形态 | 能做什么 |
|---|---|---|---|
| host | `main`（`src/index.js` / `lib/index.js`） | 普通 ESM，Node 加载 | 注册 HTTP 路由、注入服务、`ctx.inject` 拿 sessions 等 |
| client | `exports["./client"]` | `window.__ModuleLoader__.load({ id, factory })` 单文件 | 只能 `require` 宿主种子里有的模块（`react` 等），注册 UI 槽位/页面 |

两条硬约束直接决定了本仓库的形状：

1. **client 侧无法 `import` 任何 npm 包**，所以公共代码不能在浏览器侧做成依赖，只能复制或生成。
2. **host 侧是正常 ESM**，所以公共代码可以做成 workspace 包（`@dsh-workbench/kit`）。

## 页面注册：跨 bundle 契约

壳（dock）与页面（gitcraft / downloader）是两个独立 bundle，**加载顺序无保证**。因此注册表放在一个浏览器全局：

```js
window.__DSH_WORKBENCH_DOCK__ = {
  registerPage({ id, title, order, icon, component }) -> unsubscribe,
  list(), subscribe(fn),
  open(), close(), toggle(), isOpen(),
}
```

踩过的真实事故（[dock README](../packages/dock/README.md) 有完整记录）：页面先注册进一个 stub、dock 后加载时新建对象覆盖了它，浮层显示「没有页面」而 `list()` 却有 1 个。现在的实现让 dock **采纳**已存在的对象（把控制面嫁接到同一个对象上），并且浮层每 250ms 重读页面表，不依赖订阅时序。

这也是「合并成一个大插件」唯一的实质技术收益：同包内可以直接 `import` 页面组件，不必走全局。但代价是故障域、版本、分发全部绑死（见根 README 的对比表），所以本仓库选择保留契约、用文档和测试守住它。

## 为什么 kit 只有 host 侧

`@dsh-workbench/kit` 提供三件东西：

1. 同源围栏 `isTrustedRequest(req)`：loopback TCP peer（桌面壳把渲染进程放在 `dsh-app://` 下，转发过来的请求没有 loopback Host）、loopback Host、`Sec-Fetch-Site: same-origin/same-site` 三者任一即可；
2. 有上限的 JSON 体读取（空体转 `{}`，超限 413）；
3. `POST <prefix>/<method>` 的 JSON RPC 表面：统一 `{ ok: true, data }` / `{ ok: false, error: { code, message } }` 信封，支持 `run` 钩子做串行化（GitCraft 的按仓库写锁）。

dock 和 gitcraft 用第 1–3 项；downloader 只用得到第 1、2 项的等价逻辑，但它的 host 还要输出 SSE 和二进制帧，套用第 3 项反而更绕，所以保持独立实现。

错误映射是**鸭子类型**的：只要错误对象带 `status: number` + `code: string` 就按它的语义回给调用方，否则 500 + `internal`。这样两个页面插件不必把自己的 `PanelError` / `DockError` 改成 kit 的类型。

## 聚合金（suite）

`packages/suite` 不含代码，靠 `dsh.bundle.patch` 一次 insert 三行 loader。这样 profile 的 `dsh.profile.bundles` 只写一个名字即可。

**限制**：suite 和三个单包**不能同时出现在 bundles 里**，否则同一条 loader 行被插入两次，前缀路由重复注册，DSH 以 `duplicate prefix route` 拒绝启动整棵插件树。

**状态**：实验性。cordis patch 本身支持多行 insert，但 DSH 插件管理器是否允许一个 bundle 挂载别家的包，本机尚未实测；未验证前用三个独立 bundle。

## 版本策略

- `dock` / `gitcraft` / `downloader` 各自语义化版本，可独立发布、独立回滚。
- `suite` 用 lockstep 版本表达「这套组合经过验证」，不随子包细节变化。
- `kit` 是 `file:` 依赖，会被一起拷进 profile；如果将来把 `dsh-gitcraft` 发到 npm，`@dsh-workbench/kit` 也要一起发布（或者让 gitcraft 自包含）。

## 目录收敛的来龙去脉

这三个插件原本是三个独立工程（各自的 `package.json`、各自的 `cordis.patch.yml`），
后来发现它们的组合关系已经稳定成「一个壳 + 两个页面」，于是收敛进同一个
pnpm workspace：

- 壳与页面之间**只通过页面注册协议耦合**，代码上互不 import；
- 公共的 host 侧重复代码（同源围栏、限长 JSON 体、RPC 信封）抽成 `packages/kit`；
- 各自仍可独立发版、独立安装、独立回滚。

迁移时旧目录可以保留 junction 指向新位置作为过渡，但 junction 属于本机状态，
不要提交进仓库；确认新路径可用后，把 profile 的 `file:` 依赖改成 `packages/*`
的真实路径并删掉 junction。
