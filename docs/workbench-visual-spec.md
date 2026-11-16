# 工作台视觉规格（字体 / 密度 / 基线）

这份表是"再往下调字号时该改哪里"的单一出处。所有值都是**面板 CSS px**；
面板有 `zoom: 1.1`，所以实际观感约为表内值 ×1.1。

## 1. 排版阶梯

| 角色 | 用于 | 520（T1 紧凑） | 1000（T3 宽） | 实际渲染（×1.1） |
|---|---|---|---|---|
| 正文 | 行名、列表项、按钮文字、输入 | 13px | 13px | 14.3px |
| 次要 | 路径、目录、元信息、侧栏条目 | 11.5–12px | 11.5–12px | 12.7–13.2px |
| 辅助 | 分组标题、工具栏、状态栏、徽标 | 10.5–11.5px | 10.5–11.5px | 11.6–12.7px |
| 标题 | 面板标题、页签 | 13px | 13px | 14.3px |
| 等宽 | 校验码、会话 ID、日志 | 12px | 12px | 13.2px |
| 终端正文 | xterm | 13px | 13px | 14.3px |

辅助信息**不再低于 10.5px**——低于这个值在 1.1 缩放下已接近 11px，
中文会糊成一团（这是上一版的主要问题）。

## 2. 垂直节奏

| 元素 | 高度 |
|---|---|
| 面板标题栏 | 44px |
| 上下文条 / 任务条 | 60px（T1 52px） |
| 页签条 | 42px（pill 28px） |
| 列表行（树/变更） | 28px |
| 日志行 | 20px |
| 工具栏 | 34–38px |
| 状态栏 | 26px |
| 输入框 | 26–28px |
| 提交框 | 52px（最高 120px） |

## 3. 改哪里

| 想调 | 位置 |
|---|---|
| 外壳（标题/上下文/页签/状态栏） | `packages/dock/src/client.js` 末尾 `/* readability baseline */` 块 |
| 源码管理 | `packages/source-control/src/client.js` 同名块 |
| Downloader | `packages/downloader/lib/client.js` 同名块 + `ROW_HEIGHT = 20` |
| 终端 | `packages/terminal/src/client.js` 同名块 + `chunks/xterm.js` 的 `fontSize: 13` |
| 树行高 | `packages/source-control/src/client.js` 的 `TREE_ROW_HEIGHT = 28` |

改完必须：`pnpm run build` → `pnpm --filter dsh-workbay-dock run visual:update`（接受新基线）
→ `pnpm --filter dsh-workbay-dock run test:visual`（确认 0 差异）。

## 4. 视觉基线

13 张 golden：`packages/dock/tests/golden/`

- 源码管理：`composed-t1-520 / t2-680 / t2-drawer / t3-1000 / t4-1400`
- Downloader：`dl-t1-520 / t2-680 / t3-1000 / t4-1400`
- 终端：`term-t1-520 / t2-680 / t3-1000 / t4-1400`

判定：任一通道差值 > 8 的像素占比 **≤ 0.5%** 通过；
`--update` 一键重录，`--self-test` 校验解码/比较逻辑。
