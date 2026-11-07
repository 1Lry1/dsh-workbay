# 性能预算与测量方法

“不能卡顿”需要可量化的门槛，否则每个里程碑只能靠感觉。这份文档定义**预算**、**测量点**和**回归方式**。

## 1. 预算（超预算即视为回归）

| 场景 | 指标 | 预算 |
|---|---|---|
| 打开/关闭工作台面板 | 点击 → 首帧（`Performance.now` 到下一帧） | p95 < 150 ms |
| 切换页签（files / gitcraft / downloader / terminal） | 点击 → 目标页首帧 | p95 < 80 ms |
| 文件树展开一个目录（≤500 项） | 点击 → 行渲染完成 | p95 < 120 ms |
| 文件树滚动（10k 展开项） | 长任务 | 无 > 50 ms 的长任务；60 fps |
| 打开 100 KiB 文本 | 点击 → 编辑器可交互 | p95 < 300 ms |
| 打开 2 MiB 图片 | 点击 → `<img>` onload | p95 < 800 ms |
| 文件内容搜索（仓库 ~1000 文件） | 输入 → 结果渲染 | p95 < 500 ms（宿主 6s 软上限） |
| 编辑保存（本地盘） | Ctrl+S → 保存成功提示 | p95 < 500 ms |
| 终端输出 | 子进程写入 → DOM 可见 | p95 < 100 ms（1 KiB 行） |
| git 快照 | 冷读 | p95 < 250 ms |
| SSE/轮询空闲 CPU | 面板打开但不操作，30 s 平均 | < 2 % CPU |
| 常驻内存增量 | 打开 4 页后 vs 打开前 | < 40 MB |

## 2. 测量点（客户端内置，不依赖外部工具）

主 bundle 里保留一个轻量 `perf` 标记（`performance.mark/measure`，前缀 `workbay:`）：

| 标记 | 状态 |
|---|---|
| `workbay:tree:<dir>` | ✅ 已实现（`files/src/client.js`，`<root>` 表示工作区根） |
| `workbay:file-open:<ext>` | ✅ 已实现（扩展名，无扩展名为 `none`） |
| `workbay:save` | ✅ 已实现 |
| `workbay:search:content` | ✅ 已实现 |
| `workbay:dock-open` / `workbay:dock-close` | ⬜ 未实现 |
| `workbay:page:<id>`（切页） | ⬜ 未实现 |
| `workbay:terminal:echo` | ⬜ 未实现 |

所有标记只在 `localStorage['dsh-workbay.perf'] === '1'` 时启用，默认零开销。

**「零开销」是实测过的，不是声称的**：flag 关闭时 `performance.mark` 调用次数为 **0**
（200 次模块启动采样，开启与关闭的启动耗时差在噪声内，-0.6%）。
之所以要在 `mark()` 第一行就 `return`，是因为 `performance.mark` 本身会分配一条
entry 并出现在 profile 里——不能无条件调用再丢弃。

用法：`localStorage['dsh-workbay.perf'] = '1'`，刷新页面，然后在 DevTools
Performance 面板或 CDP 里读 `performance.getEntriesByType('measure')`。

## 3. e2e 性能门禁（CDP）

复用 `packages/gitcraft/tests/browser.e2e.mjs` 的 CDP 启动器，新增 `packages/dock/tests/perf.e2e.mjs`：

1. 打开工作台，读取 `performance.getEntriesByType('measure')` 拿上述标记；
2. 运行 `Performance.getMetrics` 抓 `TaskDuration`，与空闲基线比较；
3. 每个场景跑 3 次取 p95，对照预算表输出 PASS/FAIL；
4. CI 中作为**软门禁**（失败告警），里程碑验收时作为**硬门禁**。

## 4. 已知热点与对策（实现时遵守）

| 热点 | 现状 | 对策 |
|---|---|---|
| dock 页面表 250 ms 轮询 | 常驻定时器 | 改成 `subscribe` 推送；仅在检测到“跨 bundle stub”时保留兜底轮询（2 s） |
| 每次切页整页重挂 | React 卸载/重建 | keep-alive：隐藏不卸载；首次进入才加载 chunk |
| 文件树全量渲染 | 400 行硬截断（`TREE_ROW_LIMIT`），未虚拟化 | 扁平化 + 窗口化（只渲染可视区 ± 缓冲）。**当前工作区最多 1,994 条目、上限 400 行，尚未触发**；树行超过 1500 时再做 |
| 目录反复 stat | — | 宿主侧目录级缓存 + `fs.watch` 失效（`files` host 目前**无缓存**） |
| git 快照 9 个 spawn | 已降到 3 个 + 400 ms 缓存 | 保持 |
| 编辑器/xterm 进主包 | — | chunk 懒加载（`docs/files-api.md` §3） |
| 大文件渲染 | — | 只读分页/截断标记；图片 `loading=lazy`；二进制只给下载 |

### 已修复（2026-11，勿回归）

| 项 | 修复前 | 修复后 | 守护测试 |
|---|---|---|---|
| `tree` 为每个目录做 `opendirSync+readSync` 只为填一个无人读的 `hasChildren` | 真实工作区每目录 ~0.49 ms（`lstat` 的 45×），随目录数线性增长 | 字段删除 | `files/tests/host.test.mjs`「tree lists one level…」断言 `hasChildren` 不存在 |
| `localeCompare` 每次比较新建 ICU collator | 单次 ~11.3 µs；flatten 10,200 行 **82 ms** | 模块级 `Intl.Collator`；flatten **0.74 ms（-99%）** | 同上（`sortEntries` 行为不变） |
| `flattenTree` 每次展开都对每个已展开目录重新排序 | 同上 82 ms | `WeakMap` 按 entries 数组身份缓存 | 同上 |
| 窗口隐藏时轮询照跑 | 最小化 DSH 后 `stat` / `/watch` 继续发请求 | 读 `document.visibilityState`，隐藏即跳过 | `files/tests/client.test.mjs`「the modified-on-disk poll sends no request while the window is hidden」 |
| 全局 Ctrl+S 抢键 | 在任何输入框里按都去保存打开的文件 | 焦点在文本域或 CodeMirror 内时放行 | `files/tests/client.test.mjs`「Ctrl+S in a text field does NOT save the open file」 |

## 5. 回归流程

1. 开发时：`localStorage['dsh-workbay.perf']='1'` → DevTools Performance 抽查长任务；
2. 提交前：跑 `node packages/dock/tests/perf.e2e.mjs <base-url> <browser-exe>`；
3. 里程碑收尾：把当次 p95 数值记到本文件底部的“历史”表，便于对比。
