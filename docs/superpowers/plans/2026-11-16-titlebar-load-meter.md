# 工作台标题栏负载指示（CPU / GPU / MEM）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在工作台 dock 标题栏常驻一条三段式负载读数（CPU / GPU / MEM），每指标固定本色、≥90% 转红，只在面板打开且有焦点时每 5 秒采样。

**Architecture:** 采样在宿主半边（`packages/dock/src/load.js`，纯函数 + 注入时钟），经既有 `mountJsonApi` 暴露为 `POST /dsh-workbay-dock/api/load`；客户端半边新增 `LoadMeter` 组件挂在 `.wbd-titleActions` 首位，靠 dock 已有的 `data-w` 档位做窄档降级。宿主无定时器——只有客户端问才采。

**Tech Stack:** Node ESM（`node:test` + `node:assert/strict`）、`@dsh-workbay/kit` 的 `mountJsonApi`、React（经 `window.__ModuleLoader__` 加载的单文件 bundle）、纯 CSS（无构建步骤改动）。

**Spec:** [docs/2026-11-16-titlebar-load-meter-design.md](../2026-11-16-titlebar-load-meter-design.md)

## Global Constraints

- 阈值：**90%** 转红；**95%** 起加 1.6s opacity 呼吸（`prefers-reduced-motion: reduce` 下常亮）。不得改成 80%。
- 阈值的**权威定义**在 `load.js` 的 `WARN_PCT` / `HOT_PCT`。客户端半边是单文件 bundle（`window.__ModuleLoader__.load`），
  **无法 import 宿主模块**，只能在 `client.js` 里写一份 `METER_WARN_PCT` / `METER_HOT_PCT` 镜像；
  两者一致由 Task 3 的静态测试钉住（读两份源码比对数字）。除此之外**不许再有第三份**。
- CPU 基线**超过 30 秒作废**（`BASELINE_TTL_MS = 30000`），作废时返回 `cpu: null`。
- GPU 结果缓存 **4000ms**；`nvidia-smi` 超时 **3000ms**，`windowsHide: true`。
- 客户端轮询 **5000ms**，回调里先判 `document.hidden` 与 `document.hasFocus()`；不满足直接跳过（不采样、不请求）。
- GPU 不可用时**保持位置**：显示 `—`，不隐藏那一格。
- 颜色：CPU `#38bdf8`、GPU `#a78bfa`、MEM `#fbbf24`、越线 `#e5534b`；浅色主题 CPU `#0284c7` / GPU `#7c3aed` / MEM `#b45309`。
- 动画只改 `opacity`，禁止动画 `box-shadow` / `filter` / `backdrop-filter`。
- 数字一律 `font-variant-numeric: tabular-nums`。
- 所有新增文案必须同时进 `ZH` 与 `EN` 字典（`client.js` 的 `LOCALES` 只注册了这两个）。
- 宿主半边改动**必须完整重启 DSH** 才生效；本计划不依赖热更新验证。

## Review Focus

1. **`os.cpus()` 首次调用返回 `null`** —— 用户第一次打开工作台时 CPU 会显示 `—`。组件必须 1.5 秒后单次重试并停止；不能无限刷、也不能永久卡在 `—`。
2. **长时间不打开工作台后打开** —— 上次基线可能是一小时前，直接差分得到的是"这一小时的平均值"。必须靠 `BASELINE_TTL_MS` 作废并返回 `null`，再由客户端重试。
3. **dock 面板收起 / 切到别的页 / DSH 窗口失焦** —— 定时器必须真的停下来。收起时组件卸载（`isOpen` 早返回），失焦时回调跳过。断言方式：`hasFocus()` 返回 false 期间 `fetch` 调用次数为 0。
4. **没有 N 卡 / `nvidia-smi` 不存在** —— `gpu: null`，UI 显示 `—`，位置不塌。不能抛错、不能把整个接口搞成 500。
5. **宿主并发请求**（紧凑档下客户端可能短间隔重试）—— 必须有 `busy` 挡板，重叠请求返回上一份缓存而不是再起一个 `nvidia-smi`。

---

### Task 1: 采样核心 `load.js`

**Files:**
- Create: `packages/dock/src/load.js`
- Test: `packages/dock/tests/load.test.mjs`

**Interfaces:**
- Consumes: 无（本任务是最底层）
- Produces:
  - `export const WARN_PCT = 90`
  - `export const HOT_PCT = 95`
  - `export const BASELINE_TTL_MS = 30000`
  - `export const GPU_CACHE_MS = 4000`
  - `createCpuReader(deps) -> (() => number | null)`，`deps = { nowMs, readCpus }`
  - `readMemory(deps) -> { usedPct, usedGB, totalGB }`，`deps = { readMem }`
  - `createGpuReader(deps) -> (() => Promise<Gpu|null>)`，`deps = { nowMs, spawnOnce }`
  - `sampleLoad(deps) -> Promise<{ at, cpu, gpu, mem }>`（async），`deps = { nowMs, cpu, readMem, gpu }`,
    其中 `cpu` 与 `gpu` 都是 **reader 函数**（Task 2 在模块级各建一次，跨请求复用状态）

> 为什么 CPU 也是工厂而不是模块级变量：模块级状态会在测试之间泄漏
> （第一个用例建好的基线会让第二个用例读到 `dt = 0`）。工厂把状态关在闭包里，
> 宿主半边照样只建一次。

- [ ] **Step 1: Write the failing test**

`packages/dock/tests/load.test.mjs`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  WARN_PCT, HOT_PCT, BASELINE_TTL_MS,
  createCpuReader, readMemory, createGpuReader, sampleLoad,
} from '../src/load.js'

const GB = 1073741824
/* user = total - idle, so a delta of (idle +i, total +t) is (t-i)/t busy. */
const cpusAt = (idle, total) => () => [{ times: { user: total - idle, nice: 0, sys: 0, idle, irq: 0 } }]

test('cpu: first sample has no baseline and returns null', () => {
  let clock = 1000
  const read = createCpuReader({ nowMs: () => clock, readCpus: cpusAt(100, 200) })
  assert.equal(read(), null)
})

test('cpu: second sample is the tick delta percentage', () => {
  let clock = 1000
  const deps = { nowMs: () => clock, readCpus: cpusAt(100, 200) }
  const read = createCpuReader(deps)
  read()
  clock += 1000
  /* dt = 300-200 = 100 ticks, di = 150-100 = 50 idle → 1 - 50/100 = 50% */
  deps.readCpus = cpusAt(150, 300)
  assert.equal(read(), 50)
})

test('cpu: a baseline older than TTL is discarded and returns null', () => {
  let clock = 1000
  const deps = { nowMs: () => clock, readCpus: cpusAt(100, 200) }
  const read = createCpuReader(deps)
  read()
  clock += BASELINE_TTL_MS + 1
  deps.readCpus = cpusAt(150, 300)
  assert.equal(read(), null)
  /* …and the stale read becomes the NEW baseline, so the next call works. */
  clock += 1000
  deps.readCpus = cpusAt(200, 400)
  assert.equal(typeof read(), 'number')
})

test('cpu: two readers do not share a baseline', () => {
  const a = createCpuReader({ nowMs: () => 1000, readCpus: cpusAt(100, 200) })
  const b = createCpuReader({ nowMs: () => 1000, readCpus: cpusAt(100, 200) })
  assert.equal(a(), null)
  assert.equal(b(), null)      // b is not polluted by a's baseline
})

test('memory: usedPct derives from total minus free', () => {
  const mem = readMemory({ readMem: () => ({ total: 16 * GB, free: 4 * GB }) })
  assert.equal(mem.usedPct, 75)
  assert.equal(mem.totalGB, 16)
  assert.equal(mem.usedGB, 12)
})

test('gpu: no nvidia-smi yields null, not a throw', async () => {
  const read = createGpuReader({ nowMs: () => 1000, spawnOnce: async () => null })
  assert.equal(await read(), null)
})

test('gpu: parses the csv row into a structured reading', async () => {
  const read = createGpuReader({
    nowMs: () => 1000,
    spawnOnce: async () => 'NVIDIA GeForce MX350, 12, 68, 68, 2048\n',
  })
  assert.deepEqual(await read(), {
    name: 'NVIDIA GeForce MX350', util: 12, temp: 68, memUsed: 68, memTotal: 2048,
  })
})

test('gpu: a second call inside the cache window does not respawn', async () => {
  let clock = 1000
  let calls = 0
  const read = createGpuReader({
    nowMs: () => clock,
    spawnOnce: async () => { calls += 1; return 'GPU, 5, 60, 100, 2048' },
  })
  await read()
  clock += 1000
  await read()
  assert.equal(calls, 1)
})

test('gpu: overlapping calls share one spawn (busy gate)', async () => {
  let release
  let calls = 0
  const read = createGpuReader({
    nowMs: () => 1000,
    spawnOnce: () => { calls += 1; return new Promise((resolve) => { release = resolve }) },
  })
  const first = read()
  const second = read()
  release('GPU, 5, 60, 100, 2048')
  await Promise.all([first, second])
  assert.equal(calls, 1)
})

test('sampleLoad composes the three readings and stamps the time', async () => {
  const out = await sampleLoad({
    nowMs: () => 4242,
    cpu: createCpuReader({ nowMs: () => 4242, readCpus: cpusAt(100, 200) }),
    readMem: () => ({ total: 16 * GB, free: 4 * GB }),
    gpu: async () => null,
  })
  assert.equal(out.at, 4242)
  assert.equal(out.cpu, null)      // first sample, no baseline yet
  assert.equal(out.gpu, null)
  assert.equal(out.mem.totalGB, 16)
  assert.equal(out.mem.usedGB, 12)
  assert.equal(out.mem.usedPct, 75)
})

test('thresholds are single-sourced at 90 and 95', () => {
  assert.equal(WARN_PCT, 90)
  assert.equal(HOT_PCT, 95)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test packages/dock/tests/load.test.mjs`
Expected: FAIL —— `Cannot find module '../src/load.js'`

- [ ] **Step 3: Implement `packages/dock/src/load.js`**

```js
/** Host-side CPU / GPU / MEM sampler. No timers: only the client asks. */
import { spawn } from 'node:child_process'

export const WARN_PCT = 90
export const HOT_PCT = 95
export const BASELINE_TTL_MS = 30000
export const GPU_CACHE_MS = 4000
export const GPU_TIMEOUT_MS = 3000

export function createCpuReader(deps) { … }
export function readMemory(deps) { … }
export function createGpuReader(deps) { … }
export async function sampleLoad(deps) { … }
```

实现要点（签名与测试已定，以下是测试查不到的）：

- `createCpuReader` 闭包持 `let baseline = null`，存 `{ idle, total, at }`。
  每次调用先算当前 `{ idle, total }`；`baseline` 为 null、`dt <= 0`、
  或 `nowMs() - baseline.at > BASELINE_TTL_MS` ⇒ **先把当前值写进 baseline**，再返回 `null`。
  否则算 `Math.round((1 - di / dt) * 100)` 并 clamp `[0, 100]`，然后更新 baseline。
- `readMemory` 返回 `usedPct`（整数）、`usedGB` / `totalGB`（一位小数，`/ 1073741824`）。
- `createGpuReader` 闭包持 `{ value, at, busy }`：
  `busy` 为真 ⇒ 直接返回 `value`（不发请求）；`nowMs() - at < GPU_CACHE_MS` ⇒ 返回 `value`；
  否则置 `busy`，`await spawnOnce()`，解析结果，写 `{ value, at: nowMs(), busy: false }`。
  解析：取第一行、`split(',')`、`map(trim)`；段数 < 5 或 `Number.isNaN(Number(p[1]))` ⇒ `value = null`。
- `spawnOnce` 默认实现（`load.js` 内，不导出）：
  `spawn('nvidia-smi', ['--query-gpu=name,utilization.gpu,temperature.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'], { windowsHide: true })`；
  收 stdout；3 秒 `setTimeout` 后 `kill()`；`close` / `error` 都 resolve（失败 resolve `null`，**不 reject**）。
- `sampleLoad` 一次 `cpu()` + 一次 `readMem()` + `await gpu()`，返回 `{ at: nowMs(), cpu, gpu, mem }`。

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test packages/dock/tests/load.test.mjs`
Expected: PASS（11 个测试全绿）

- [ ] **Step 5: Commit**

```bash
git add packages/dock/src/load.js packages/dock/tests/load.test.mjs
git commit -m "feat(dock): host-side CPU/GPU/MEM sampler with baseline TTL and GPU cache"
```

---

### Task 2: 宿主路由 `/api/load`

**Files:**
- Modify: `packages/dock/src/index.js`（`METHODS` 附近，静态方法表里加一个 `load` 键，走 `loadReader` 闭包）
- Test: `packages/dock/tests/restart.test.mjs`（同文件追加，复用已有的 `createServer` 夹具风格）

**Interfaces:**
- Consumes: Task 1 的 `sampleLoad`、`createGpuReader`
- Produces: `POST /dsh-workbay-dock/api/load` 返回 `{ ok: true, data: { at, cpu, gpu, mem } }`

- [ ] **Step 1: Write the failing test**

追加到 `packages/dock/tests/restart.test.mjs`（复用该文件顶部已有的 ctx 夹具构造方式）：

```js
test('POST /api/load returns the sampled envelope', async () => {
  let handler = null
  const ctx = { /* 同 restart 测试的夹具 */ }
  apply(ctx)
  assert.equal(typeof handler, 'function')
  const server = createServer((req, res) => { void handler(req, res) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + server.address().port
  try {
    const response = await fetch(base + '/dsh-workbay-dock/api/load', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(body.ok, true)
    assert.equal(typeof body.data.at, 'number')
    assert.equal('cpu' in body.data, true)
    assert.equal('gpu' in body.data, true)
    assert.equal(typeof body.data.mem.usedPct, 'number')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test packages/dock/tests/restart.test.mjs`
Expected: FAIL —— 404 `unknown method "load"`

- [ ] **Step 3: Add the `load` method to `src/index.js`**

`src/index.js` 顶部加 `import os from 'node:os'` 与
`import { createCpuReader, createGpuReader, readMemory, sampleLoad } from './load.js'`。

在 **模块级**（`apply` 外面，与 `const pages = new Map()` 同级）建一次 reader：

```js
/* Reader instances live at module scope: the CPU baseline and the GPU cache must
   survive across requests, and `apply` may run more than once. */
const readCpu = createCpuReader({ nowMs: Date.now, readCpus: () => os.cpus() })
const readGpu = createGpuReader({ nowMs: Date.now })
const readMem = () => ({ total: os.totalmem(), free: os.freemem() })
const loadOnce = () => sampleLoad({ nowMs: Date.now, cpu: readCpu, readMem, gpu: readGpu })
```

在 `apply` 的 `methods` 对象里（与 `restart` 同级）加：

```js
async load() {
  return loadOnce()
}
```

`createGpuReader` 不传 `spawnOnce` ⇒ 用 `load.js` 里的默认实现。

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test packages/dock/tests/restart.test.mjs`
Expected: PASS（3 个测试：2 个原有的 restart + 1 个新的 load）

- [ ] **Step 5: Commit**

```bash
git add packages/dock/src/index.js packages/dock/tests/restart.test.mjs
git commit -m "feat(dock): expose POST /api/load for the titlebar meter"
```

---

### Task 3: 客户端 `LoadMeter` + 样式 + i18n

**Files:**
- Modify: `packages/dock/src/client.js`
  - i18n：`ZH`（约 59-88 行）与 `EN`（约 90-120 行）各加 `load.title` / `load.cpu` / `load.gpu` / `load.mem` / `load.noGpu` / `load.offline`
  - 组件：新增 `useLoadMeter()` 与 `LoadMeter`（放在 `WorkbenchContextBar` 附近，约 686 行前）
  - 挂载：`titlebar` 的 `.wbd-titleActions` 首位（约 1131 行）
  - 样式：`.wbd-*` 样式表尾部（约 1343 行 `.wbd-titleActions` 之后）
- Test: `packages/dock/tests/client.test.mjs`（追加静态断言）

**Interfaces:**
- Consumes: `POST /dsh-workbay-dock/api/load`（Task 2）；`WARN_PCT` / `HOT_PCT` 的**字面值**在客户端重复声明一次并在测试里与 `load.js` 比对（单文件 bundle 无法 import 宿主模块）
- Produces: `LoadMeter`（内部使用，无外部导出）

- [ ] **Step 1: Write the failing test**

追加到 `packages/dock/tests/client.test.mjs`：

```js
test('the meter declares the same thresholds as the host sampler', () => {
  const source = readFileSync(clientPath, 'utf8')
  const hostSource = readFileSync(path.join(here, '..', 'src', 'load.js'), 'utf8')
  const hostWarn = Number(/WARN_PCT\s*=\s*(\d+)/.exec(hostSource)[1])
  const hostHot = Number(/HOT_PCT\s*=\s*(\d+)/.exec(hostSource)[1])
  const clientWarn = Number(/METER_WARN_PCT\s*=\s*(\d+)/.exec(source)[1])
  const clientHot = Number(/METER_HOT_PCT\s*=\s*(\d+)/.exec(source)[1])
  assert.equal(clientWarn, hostWarn)
  assert.equal(clientHot, hostHot)
})

test('the meter registers into the titlebar action row', () => {
  const source = readFileSync(clientPath, 'utf8')
  assert.match(source, /wbd-titleActions/)
  assert.match(source, /dsh-workbay-dock\/api\/load/)
  /* Narrow tiers hide the label and the percent sign by CSS, so both spans exist
     unconditionally and both carry a hide rule. */
  assert.match(source, /wbd-loadLabel/)
  assert.match(source, /wbd-loadDot/)
  assert.match(source, /wbd-loadPct/)
  assert.match(source, /data-w="t1"\].*wbd-loadLabel/, 't1 must hide the label')
})

test('both locale dictionaries carry the meter keys', () => {
  const source = readFileSync(clientPath, 'utf8')
  for (const key of ['load.title', 'load.cpu', 'load.gpu', 'load.mem', 'load.noGpu']) {
    const hits = source.split("'" + key + "'").length - 1
    assert.ok(hits >= 2, key + ' must appear in ZH and EN, found ' + hits)
  }
})

/* Review Focus 1: the first sample has no CPU baseline, so the meter MUST retry
   once instead of sitting on "—" forever — and exactly once, not in a loop. */
test('the meter retries a null CPU reading exactly once', () => {
  const source = readFileSync(clientPath, 'utf8')
  const body = source.slice(source.indexOf('function useLoadMeter'), source.indexOf('function LoadMeter'))
  assert.match(body, /cpu === null/, 'must branch on a missing CPU baseline')
  assert.match(body, /retried/, 'must hold a one-shot retry flag')
  assert.match(body, /1500/, 'retry delay is 1500ms per the spec')
})

/* Review Focus 3: an unfocused / hidden window must not sample at all. */
test('the meter skips sampling when the window is hidden or unfocused', () => {
  const source = readFileSync(clientPath, 'utf8')
  const body = source.slice(source.indexOf('function useLoadMeter'), source.indexOf('function LoadMeter'))
  assert.match(body, /document\.hidden/, 'must check document.hidden')
  assert.match(body, /document\.hasFocus\(\)/, 'must check document.hasFocus()')
  /* Both guards must sit BEFORE the fetch, not after it. */
  assert.ok(
    body.indexOf('document.hasFocus()') < body.indexOf('api/load'),
    'the focus guard must precede the request',
  )
  assert.match(body, /removeEventListener\('focus'/, 'the focus listener must be removed on unmount')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test packages/dock/tests/client.test.mjs`
Expected: FAIL —— `METER_WARN_PCT` 正则匹配不到（`null[1]` 抛 TypeError）

- [ ] **Step 3: Implement the component, styles and copy in `client.js`**

实现要点：

- `const METER_WARN_PCT = 90` / `const METER_HOT_PCT = 95`，紧跟 `WORKBENCH_ZOOM` 之后声明。
- `useLoadMeter()`：`useState({ cpu: null, gpu: null, mem: null, err: '' })`；
  `useEffect` 里 `const tick = async () => { if (document.hidden || !document.hasFocus()) return; … fetch POST … }`，
  `const id = setInterval(tick, 5000)`，`window.addEventListener('focus', tick)`，清理时两个都撤。
  `cpu === null` 时 `setTimeout(tick, 1500)` 单次重试（用一个 `retried` ref 防重复）。
  请求失败 ⇒ 保留旧值 + `err` 置文本，不抛。
- `LoadMeter({ t })` 渲染（**组件不做档位分支**——窄档只靠 CSS 隐藏标签与 `%`，
  这样 "档位" 与 "数据" 两件事互不纠缠）：
  - 根 `<span className="wbd-load" title={…完整读法…}>`
  - 三格 `<span className="wbd-loadCell" data-tone="cpu|gpu|mem" data-level="ok|warn|hot">`
  - 每格内顺序固定：`<span className="wbd-loadDot" />`、`<span className="wbd-loadLabel">CPU</span>`、
    `<span className="wbd-loadNum">35</span>`、`<span className="wbd-loadPct">%</span>`
  - 值为 `null` ⇒ `.wbd-loadNum` 渲染 `—`、`.wbd-loadPct` 不渲染（`—` 后面挂个 `%` 很怪）
  - `gpu === null` ⇒ 同上，`title` 换成 `t('load.noGpu')`
- `data-level`：`v >= METER_HOT_PCT ? 'hot' : v >= METER_WARN_PCT ? 'warn' : 'ok'`；`v` 为 null 时 `'ok'`。
- 挂载点：`E('span', { className: 'wbd-titleActions' }, E(LoadMeter, { t }), /* 原有两个按钮 */)`。
  **注意 `titlebar` 本就构造在 `if (!isOpen) return null` 之后**（约 1061 行的早返回），
  所以挂在这里天然满足"关掉工作台即卸载、定时器随之消失"，实现者不要额外加条件。
- 样式（追加到样式表末尾）：`.wbd-load{display:inline-flex;align-items:center;gap:8px;flex:none;font-size:11px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#b6bac1)}`；
  `.wbd-loadCell{display:inline-flex;align-items:center;gap:3px}`；
  `.wbd-loadDot{width:6px;height:6px;border-radius:50%;flex:none}`；
  `[data-tone="cpu"] .wbd-loadDot{background:#38bdf8}` / `gpu` `#a78bfa` / `mem` `#fbbf24`；
  `[data-level="warn"] .wbd-loadNum, [data-level="hot"] .wbd-loadNum{color:#e5534b;font-weight:600}`；
  `[data-level="hot"] .wbd-loadDot{animation:wbdLoadBreath 1.6s ease-in-out infinite}`；
  `@keyframes wbdLoadBreath{0%,100%{opacity:.45}50%{opacity:1}}`；
  `@media (prefers-reduced-motion:reduce){.wbd-loadDot{animation:none!important;opacity:1}}`；
  `html[data-theme="light"]` 下覆盖三个 dot 颜色为 `#0284c7` / `#7c3aed` / `#b45309`。
- 窄档降级（CSS 单点，与 spec 一致）：
  `[data-w="t1"] .wbd-loadLabel,[data-w="t1"] .wbd-loadPct,[data-w="t2"] .wbd-loadLabel,[data-w="t2"] .wbd-loadPct{display:none}`。

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test packages/dock/tests/client.test.mjs`
Expected: PASS（含新增 5 个测试）

- [ ] **Step 5: Commit**

```bash
git add packages/dock/src/client.js packages/dock/tests/client.test.mjs
git commit -m "feat(dock): titlebar CPU/GPU/MEM meter with per-metric colours"
```

---

### Task 4: 构建、同步与真机验证

**Files:**
- 不改源码；执行既有脚本

**Interfaces:**
- Consumes: Task 1-3 的全部产物
- Produces: 无

- [ ] **Step 1: Run the full dock test suite**

Run: `pnpm --filter dsh-workbay-dock run test`
Expected: PASS，含新增的 `load.test.mjs`

- [ ] **Step 2: Build the suite bundle**

Run: `pnpm run build`
Expected: 无错误退出；`packages/suite/vendor` 与 `client.js` 已更新

- [ ] **Step 3: Sync to the desktop profile**

Run: `node scripts/sync-to-profile.mjs`
Expected: 打印同步成功的包列表

- [ ] **Step 4: Verify the profile**

Run: `node scripts/verify-profile.mjs`
Expected: 全绿

- [ ] **Step 5: Restart DSH completely, then verify by eye**

宿主半边改动**必须完整重启 DSH**（不是"重启工作台"按钮，也不是刷页面）。
重启后：打开工作台 dock → 标题栏 `⟳` 左边应出现三段读数。

用 devtools（Network 面板只过滤 `api/load`）核三件事，**不额外加日志代码**：

| 操作 | 期望 |
|---|---|
| 工作台打开、DSH 在前台，静置 20 秒 | 约 4 次请求，间隔 5 秒；读数在变 |
| 收起工作台 | 请求数停在原地，**不再增长** |
| 工作台打开但切到别的窗口 30 秒 | 请求数不增长；回到 DSH 后立刻补 1 次 |

再核两件肉眼可见的事：

- 首次打开时 CPU 短暂显示 `—`，约 1.5 秒后出现数字（证明 baseline 重试生效）。
- 标题栏在 620px 停靠宽度下显示 `● 35 · ● 0 · ● 69`；把面板拖宽过 980px 后出现 `CPU 35% · GPU 0% · MEM 69%`。

- [ ] **Step 6: Commit the build artifacts' sync result and report**

```bash
git add -A
git commit -m "chore(dock): sync titlebar load meter to the desktop profile"
```

报告里写清：单测数量、`verify-profile` 结果、上面五项真机观察的实测值，以及
"已完整重启 DSH / 仅刷新页面"的实际状态（区别是"待重启"还是"失败"）。

---

## 交付后仍未覆盖的事（明确不做）

- 历史曲线 / 趋势 / 每核占用 / CPU 温度：spec 的非目标。
- AMD / Intel 核显占用率：只有 `nvidia-smi` 这条路，拿不到就 `—`。
- 阈值配置界面：90 / 95 写死，单源在 `load.js`。
- 宿主侧定时器 / 后台采样：只有客户端问才采。
