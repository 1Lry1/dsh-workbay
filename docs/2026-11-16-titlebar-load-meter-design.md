# 工作台标题栏负载指示（CPU / GPU / MEM）· 设计

日期：2026-11-16
状态：已批准（2026-11-16 21:04，宿主确认三点：窄档用色块区分、阈值 90%、GPU 不可用时保持位置）
规模：小改动（1 个宿主方法 + 1 个客户端组件 + 样式 + 测试）

## 意图

工作台 dock 标题栏常驻一条三段式负载读数，让人**不用切窗口就能判断"现在还能不能再派重活"**。

参考对象是 luanyujia-workbench 的顶栏「负载胶囊」：`CPU 35.5% · GPU — · MEM 69.3%`，
只在窗口有焦点时每 5 秒取一次数，≥90% 变色。

与原作的两处不同：

1. **位置**：原作在 DSH 顶栏；这里按需求放在 **dock 面板标题栏**（`.wbd-titleActions`，
   `⟳ 重启` 按钮左边）。
2. **配色**：原作三指标共用一个颜色、按水位整体变色（<70 绿 / ≥70 橙 / ≥90 红），
   分不清哪个数字是 CPU 哪个是 GPU。这里改成**每指标固定本色 + 越线转红**。

## 目标 / 非目标

**目标**

- 一眼分辨三个指标分别是什么（靠颜色，不靠读标签）。
- 负载越线时立刻可见（≥90% 该指标转红）。
- 只在工作台打开且窗口有焦点时采样；后台完全停。

**非目标**

- 不做历史曲线 / 趋势图 / 每核占用 / CPU 温度（原作也没有）。
- 不做 AMD / Intel 核显占用率（只有 `nvidia-smi` 这条路；拿不到就显示 `—`）。
- 不做阈值配置界面（阈值写死 90，够用）。
- 不做告警、通知、日志。这是指示器，不是监控系统。

## 颜色

| 指标 | 本色（暗色主题） | 本色（浅色主题） | 依据 |
|---|---|---|---|
| CPU | `#38bdf8` 青 | `#0284c7` | 与"处理器"惯用色一致 |
| GPU | `#a78bfa` 紫 | `#7c3aed` | 与 CPU 拉开色相，冷暖分明 |
| MEM | `#fbbf24` 琥珀 | `#b45309` | 三色互不邻近 |
| 越线 ≥90% | `#e5534b` 红 | 同色 | 覆盖各自本色 |
| 越线 ≥95% | 红 + 1.6s 透明度呼吸（`prefers-reduced-motion` 下常亮） | 同 | 复用 `tabWorkGlow` 那套"只动 opacity"的做法，不动 `box-shadow`/`filter`（省 GPU） |

浅色主题靠 `html[data-theme="light"]` 覆盖（DSH 已有的主题钩子）。

## 排版与降级

dock 面板默认停靠宽度 620px ⇒ **默认就是 t1 紧凑档**（`TIER_MIN_WIDTH.t2 = 680`），
而 `.wbd-docked .wbd-titlebar` 还要给 DSH 窗口按钮预留 140px 右内边距。
所以紧凑形态是常态，不是边角情况。

| 档位 | 形态 | 示例 |
|---|---|---|
| t1 / t2 | 无标签，色块即标签 | `● 35 · ● 0 · ● 69` |
| t3 / t4 | 带标签 | `CPU 35 · GPU 0 · MEM 69` |

- 数字一律 `font-variant-numeric: tabular-nums`，读数跳动时不抖宽度。
- 分子比分号省宽度；`%` 只在 t3+ 出现。
- 单位缺失时显示 `—`（不隐藏、不塌缩）：位置稳定，不会因为 GPU 不可用就整个跳一下。
- `title` 悬停给完整读法：`CPU 35% · GPU MX350 0% 68°C 显存 68/2048 MB · 内存 69% 11.2/15.8 GB`。

## 数据来源（宿主半边）

浏览器读不到 `os.cpus()`、也起不了子进程，所以必须走宿主。新增 `POST /dsh-workbay-dock/api/load`，
复用 `mountJsonApi` + `@dsh-workbay/kit` 的既有信任围栏（loopback 白名单 + 必须 `application/json`），
**不新增端口、不新增鉴权**。

```
{ ok: true, data: {
    at: 1731...,
    cpu: 35 | null,
    gpu: { name, util, temp, memUsed, memTotal } | null,
    mem: { usedPct, usedGB, totalGB },
} }
```

- **CPU**：`os.cpus()` 累计 tick 差分（同原作，零子进程）。
  模块级保存上一份 `{idle, total, at}`；**上一份超过 30 秒就作废**——否则算出来的是
  "这半小时的平均值"，不是"现在多少"。作废时保存新基线并返回 `null`。
- **内存**：`os.totalmem()/freemem()`，即时同步读。
- **GPU**：`nvidia-smi --query-gpu=name,utilization.gpu,temperature.gpu,memory.used,memory.total
  --format=csv,noheader,nounits`，`windowsHide: true`，3 秒超时。
  结果缓存 4 秒，避免紧凑档下短间隔重试把子进程堆起来。没 N 卡 ⇒ `gpu: null`。
- **并发**：一个 `busy` 标志挡住重叠请求；不排队、直接返回上一份缓存。
- **不做宿主侧定时器**：只有客户端问才采。工作台关掉 = 一次都不采。

## 客户端

- `LoadMeter` 组件挂在 `.wbd-titleActions` 首位，**只在 dock 打开时挂载**（`isOpen` 早返回），
  关掉即卸载、定时器随之消失。
- 轮询：`setInterval` 5s，回调里先判 `document.hidden` 与 `document.hasFocus()`，不满足直接跳过；
  另听 `window focus` 立即补一次。
- `cpu === null`（首次无基线）⇒ 1.5 秒后单次重试，拿到值就停；不无限重试。
- 请求失败 ⇒ 保留上一次读数并置灰，悬停显示错误文本；不弹窗、不刷 console。
- 窄档降级靠根节点的 `data-w`（dock 已有），CSS 控制标签显隐，组件不分支。

## 涉及文件

| 文件 | 改动 |
|---|---|
| `packages/dock/src/load.js` | 新增。采样核心，纯函数化以便测试（注入时钟与读取器） |
| `packages/dock/src/index.js` | 新增 `load` 方法到 `methods` |
| `packages/dock/src/client.js` | `LoadMeter` 组件 + `useLoadMeter` + 样式 + i18n 键（各语言字典都要补） |
| `packages/dock/tests/load.test.mjs` | 新增。CPU 差分 / 30 秒作废 / GPU 无卡 / 并发挡板 |
| 本文档 | — |

## 生效方式

**宿主半边改动必须完整重启 DSH 才生效**，热更新和刷新页面都不够。
（`scripts/restart` 那条 HMR 路径已知不重载 vendor 动态 import 的宿主模块——见 2026-11-16 的已知限制。）
验证顺序：单测 → `pnpm run build` → `sync-to-profile` → 完整重启 DSH → 打开工作台看真实读数。

## 留给实现者的判断

- 组件命名与拆分粒度。
- `load.js` 里注入点的具体形状。
- 窄档 `● 35` 的分隔符用 `·` 还是留空格（看图再定）。

## 已定（2026-11-16 宿主裁决）

1. **窄档形态**：接受 `● 35 · ● 0 · ● 69`——靠颜色当标签，不藏格子。
2. **越线阈值**：**90%**（不降到 80）。
3. **GPU 不可用**：显示 `GPU —` / 窄档 `● —`，**保持位置**，不隐藏那一格。

「待你确认的三点」自此关闭。
