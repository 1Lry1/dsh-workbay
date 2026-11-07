# 页面嵌入契约（panes / commands）

> 版本：0.1（2026-11）
> 适用：`dsh-workbay-dock` 的页面注册表，以及任何想被别的页面**嵌入**的页面。

---

## 1. 为什么需要这个契约

工作台的页面各自是独立 bundle、独立闭包，`client` 半侧**不能 import 本仓库的任何包**
（`docs/architecture.md:14`）。所以一个页面想复用另一个页面的 UI，只有三条路：

| 路 | 代价 |
|---|---|
| 复制代码 | 两份实现会漂移 |
| 合成一个 bundle | 故障域、发版、安装全绑死 |
| **跨 bundle 挂 DOM 节点** | 需要一层契约 ← **本文** |

第三种是唯一不牺牲故障域的。它的先例在仓库里本来就有：dock 的浮层就是用
`ReactDOM.createRoot(container)` 挂到自建节点上（`packages/dock/src/client.js:862`）。

---

## 2. 注册一个可被嵌入的页面

页面照常注册，**额外**提供两个可选字段。不提供它们时，行为与以前完全一致。

```js
dock.registerPage({
  id: 'files',
  title: '文件',
  order: 10,
  icon: (size) => <Icon size={size} />,
  component: () => <FullPage />,        // 独立成页时渲染这个

  // 可选：可被别的页面嵌入的面板
  panes: {
    source: (container, context) => ({ dispose, handle }),
  },

  // 可选：宿主可以调用的命令
  commands: {
    openFile(rel) {},
    hasDirty(rel) { return false },
    reload(rel) {},
  },
})
```

### 2.1 `panes.<name>(container, context)`

**容器由宿主拥有，React root 由你拥有。** 你在 `container` 里 `createRoot` 并渲染，
宿主不碰你渲染出来的东西。

`context` 是宿主下发的**稳定上下文**，只在挂载时给一次：

| 字段 | 含义 |
|---|---|
| `repoRoot` | 仓库根的绝对路径（gitcraft 需要它构造 RPC） |
| `workspaceRoot` | 工作区根的绝对路径 |
| `t` | 翻译函数 |
| `visible` | 挂载时是否可见 |
| `onHunkAction(ref)` | 可选。宿主愿意接收 hunk 级操作时提供；面板据此渲染按钮 |

**返回值**：`{ dispose, handle }`

- `dispose()` — 宿主在容器卸载时调用，你必须在这里 `root.unmount()`
- `handle` — 你的命令句柄，宿主拿不到你的内部状态，只能通过它

也接受只返回一个函数（旧形状），那种情况下没有 `handle`。

### 2.2 最重要的规则：**挂载给上下文，变化走命令**

```js
// 对：挂一次，之后用命令推送
panes: { diff: (container, context) => { const h = mountDiff(container, context); return { dispose, handle: h } } }
commands: { showDiff(path) { /* 推给已挂载的面板 */ } }
```

```js
// 错：把「当前选中的文件」塞进 context
panes: { diff: (container, { activeRel }) => … }   // activeRel 会被永久冻结
```

**这个坑是端到端测试抓到的**：`activeRel` 在挂载那一刻被快照，之后用户再点别的文件，
面板仍然显示第一个——而且**不报错**。`context` 只放「面板挂载期间不会变」的东西。

---

## 3. 宿主的责任

### 3.1 用回调 ref 挂载，不是 effect

面板容器往往**只在选中文件之后才存在**（之前是空态）。所以：

```js
// 对：节点attach的那一刻挂载
const refCb = useCallback((node) => {
  if (node === null) { disposePane(); return }
  mountPane(node)
}, [mountPane])
E('div', { ref: refCb })
```

```js
// 错：effect 只跑一次，那时 ref.current 还是 null
useEffect(() => { mountPane(hostRef.current) }, [])
```

这个坑同样由端到端测试抓到：两个面板都是空的，**控制台零错误**。

### 3.2 隐藏用 `hidden`，不要卸载

```js
E('div', { className: 'slot', ref: refCb, hidden: activeTab !== 'diff' })
```

卸载会丢掉编辑器的未保存内容和 diff 的滚动位置，切回来是一次冷启动。
`hidden` 保留挂载，切换是瞬时的——但**宿主必须告诉面板它被隐藏了**，否则它会继续轮询。

### 3.3 从注册表取页面要用 `get(id)`

`list()` 是给 Tab 条用的，它会**过滤掉** `hidden: true` 和已被 `supersededBy` 取代的页面。
`get(id)` 不过滤，所以被隐藏的页面仍然可以被嵌入。

---

## 4. 版本与兼容

- 两个字段都是**可选**的。老页面不实现 `panes`，行为不变。
- `commands` 是普通对象，加一个新命令是向后兼容的；删一个会静默降级（宿主调用时判断存在性）。
- 契约**没有版本号**，靠「只加不改」维护。真要破坏性变更，加新的 pane 名字，别改旧的。

---

## 5. 现有实现

| 页面 | 提供 | 命令 |
|---|---|---|
| `dsh-workbay-files` | `panes.source`（编辑器 + 文本/图片/PDF/二进制查看器） | `openFile` / `hasDirty` / `reload` |
| `dsh-gitcraft` | `panes.diff`（统一 diff 渲染 + 按块操作按钮） | `showDiff(path, options)` |
| `dsh-workbay-source-control` | 只消费，不提供 | — |

### 3.4 `showDiff` 的 options

```js
commands.showDiff(path, { base: 'worktree' })   // 默认：未暂存的改动
commands.showDiff(path, { base: 'staged' })     // 已暂存：git diff --cached
commands.showDiff(path, { base: 'commit', rev }) // 某个提交里的这个文件
```

**`base` 不是可选的美化项。** 已暂存的文件在工作区里已经没有差异了，
用 `worktree` 去看会得到空 patch，用户会以为自己的改动消失了。这是**静默错误**——
没有报错，只是显示错的那一侧。

`path` 是**仓库相对**路径（git host 的坐标系），不是工作区相对。两个 host 在这里不一致，
转换必须在宿主侧完成（见 `packages/source-control/src/client.js` 的 `toRepoPath`）。

### 3.5 hunk 级操作（`onHunkAction`）

宿主想提供「按块暂存」时，在挂载上下文里给一个回调：

```js
panes: { diff: (container, api) => { /* api.onHunkAction 存在就渲染按钮 */ } }
```

面板回调的形状：

```js
onHunkAction({ path, hunkIndex, action })   // action: 'stageHunk' | 'unstageHunk' | 'discardHunk'
```

分工是刻意的：**面板负责渲染和报告，不负责决定能不能写**。
只读安装里宿主不给这个回调，面板就不渲染按钮——一个永远失败的按钮比没有按钮更糟。
RPC 和路径 join 都留在宿主，因为那两件东西只有宿主知道。

消费方是 `packages/source-control/src/client.js`，它的端到端验证在
`packages/source-control/tests/e2e.mjs`（真仓库 + 真 React + 真 git）。

