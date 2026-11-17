/**
 * Loads the dock's client half with a stubbed browser around it.
 *
 * The file is a single self-contained bundle (`window.__ModuleLoader__.load`),
 * so `import` would execute `window` at load time and blow up in Node. The
 * harness below installs a minimal window/localStorage/React/ReactDOM and then
 * calls the captured factory — which is exactly the environment the real shell
 * gives it, minus rendering. What is pinned here is the part that has no DOM:
 * the page registry and the workbench context bus.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import vm from 'node:vm'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientPath = path.join(here, '..', 'src', 'client.js')

function memoryStorage(initial) {
  const map = new Map(Object.entries(initial ?? {}))
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: (key) => { map.delete(key) },
    snapshot: () => Object.fromEntries(map),
  }
}

/** Minimal React: the factory reads hooks and extends Component at load time. */
function fakeReact() {
  class Component {
    constructor(props) { this.props = props; this.state = {} }
  }
  return {
    Component,
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useMemo: (factory) => factory(),
    useCallback: (fn) => fn,
    useRef: (initial) => ({ current: initial }),
  }
}

/**
 * Load the bundle and return its public surface.
 *
 * `savedFactory` is captured from `window.__ModuleLoader__.load`, then invoked
 * with a `require` that answers 'react' (the factory needs it immediately) and
 * 'react-dom/client' (only `apply` needs it, so a stub is enough).
 */
function loadDock(options) {
  const storage = memoryStorage(options?.storage)
  const windowObject = {
    localStorage: storage,
    __ModuleLoader__: { load: (definition) => { windowObject.__definition = definition } },
  }
  const context = vm.createContext({
    window: windowObject,
    globalThis: undefined,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    navigator: { language: 'zh-CN' },
    document: undefined,
  })
  context.globalThis = context
  const source = readFileSync(clientPath, 'utf8')
  vm.runInContext(source, context, { filename: clientPath })
  const definition = windowObject.__definition
  assert.ok(definition !== null && typeof definition === 'object', 'the bundle must register itself')
  const react = fakeReact()
  const require = (specifier) => {
    if (specifier === 'react') return react
    if (specifier === 'react-dom/client' || specifier === 'react-dom') {
      return { createRoot: () => ({ render() {}, unmount() {} }) }
    }
    throw new Error('unexpected require: ' + specifier)
  }
  const api = definition.factory(require)
  return { api, storage, windowObject }
}

test('the bundle exposes apply, the page registry and the context bus', () => {
  const { api } = loadDock()
  assert.equal(api.name, 'dsh-workbay-dock')
  assert.equal(typeof api.apply, 'function')
  assert.equal(typeof api.registerPage, 'function')
  assert.equal(typeof api.setContext, 'function')
  assert.equal(typeof api.getContext, 'function')
  assert.equal(typeof api.subscribeContext, 'function')
})

test('registerPage validates and lists pages in order', () => {
  const { api, windowObject } = loadDock()
  assert.throws(() => api.registerPage(null), /page object/)
  assert.throws(() => api.registerPage({ component() {} }), /non-empty id/)
  assert.throws(() => api.registerPage({ id: 'x' }), /component/)

  const dock = windowObject.__DSH_WORKBAY__
  const offA = dock.registerPage({ id: 'a', title: '源码管理', order: 15, component() {} })
  dock.registerPage({ id: 'b', title: '烧录', order: 30, component() {} })
  dock.registerPage({ id: 'c', title: '终端', order: 40, component() {} })
  dock.registerPage({ id: 'hidden', title: '文件', order: 10, hidden: true, component() {} })

  assert.deepEqual([...dock.list().map((page) => page.id)], ['a', 'b', 'c'])

  /* supersededBy: the old page leaves the strip only once its replacement exists */
  dock.registerPage({ id: 'old', title: '旧页', order: 12, supersededBy: 'a', component() {} })
  assert.equal(dock.list().some((page) => page.id === 'old'), false)
  assert.equal(typeof dock.get('hidden'), 'object', 'hidden pages stay callable by id')

  offA()
  /* Unregistering the replacement un-hides the page it superseded: that is the
     "ship the new page, retire the old one, keep rollback free" rule. */
  assert.deepEqual([...dock.list().map((page) => page.id)], ['old', 'b', 'c'])
})

test('setContext merges instead of replacing, and notifies subscribers', () => {
  const { api } = loadDock()
  const seen = []
  const off = api.subscribeContext((next) => seen.push(next))

  api.setContext({ path: 'D:\\work\\proj', name: 'proj' })
  api.setContext({ branch: 'main', ahead: 2 })
  const state = api.getContext()
  assert.equal(state.path, 'D:\\work\\proj')
  assert.equal(state.name, 'proj')
  assert.equal(state.branch, 'main')
  assert.equal(state.ahead, 2)
  assert.equal(seen.length, 2)
  assert.equal(seen[1].path, 'D:\\work\\proj', 'the second patch kept the path')

  /* A page that knows nothing must not blank the bar. */
  api.setContext({ unknownKey: 'ignored' })
  assert.equal(api.getContext().name, 'proj')
  api.setContext(null)
  api.setContext('nonsense')
  assert.equal(api.getContext().branch, 'main')

  /* getContext hands out a copy: a page mutating it cannot corrupt the shell. */
  const copy = api.getContext()
  copy.name = 'mutated'
  assert.equal(api.getContext().name, 'proj')

  const before = seen.length
  off()
  api.setContext({ status: '烧录中 62%' })
  assert.equal(seen.length, before, 'the unsubscribed listener is gone')
  assert.equal(api.getContext().status, '烧录中 62%')
})

test('a section page that only knows the branch still shows the workspace', () => {
  const { api } = loadDock()
  api.setContext({ path: 'D:\\work\\proj', name: 'proj' })
  api.setContext({ branch: 'feature/tag-ui' })
  assert.deepEqual(
    { name: api.getContext().name, branch: api.getContext().branch },
    { name: 'proj', branch: 'feature/tag-ui' },
  )
})

test('tier and layout rules match the canonical kit copy', async () => {
  const { api } = loadDock()
  const kit = await import('../../kit/src/ui.js')
  for (const width of [0, 519, 520, 679, 680, 979, 980, 1279, 1280, 1920]) {
    assert.equal(api.shell.tierForWidth(width), kit.tierFor(width), 'width ' + width)
  }
  for (const tier of ['t1', 't2', 't3', 't4']) {
    for (const mode of ['auto', 'single', 'split', 'tri']) {
      assert.equal(api.shell.resolveLayoutKind(tier, mode), kit.resolveLayout(tier, mode), tier + '/' + mode)
    }
  }
  for (const mode of ['auto', 'SPLIT', '', undefined, 'tri']) {
    assert.equal(api.shell.normalizeLayoutMode(mode), kit.normalizeLayoutMode(mode), String(mode))
  }
})

test('Ctrl+E (Cmd+E) is the only sequence that toggles the workbench', () => {
  const { api } = loadDock()
  const matches = api.shell.isWorkbenchShortcut
  const key = (patch) => Object.assign({ key: 'e', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false }, patch)

  assert.equal(matches(key({ ctrlKey: true })), true, 'Ctrl+E')
  assert.equal(matches(key({ metaKey: true })), true, 'Cmd+E (macOS)')
  assert.equal(matches(key({ ctrlKey: true, key: 'E' })), true, 'uppercase E still works')
  assert.equal(matches(key({ ctrlKey: true, shiftKey: true })), false, 'Ctrl+Shift+E is a different chord')
  assert.equal(matches(key({ ctrlKey: true, altKey: true })), false, 'Ctrl+Alt+E is a different chord')
  assert.equal(matches(key({ ctrlKey: true, repeat: true })), false, 'auto-repeat must not toggle repeatedly')
  assert.equal(matches(key({ ctrlKey: true, key: 'k' })), false, 'only E')
  assert.equal(matches(key({})), false, 'plain E types a letter')
  assert.equal(matches(null), false, 'junk input')
})
test('setStatus attributes a line per page, clears it, and never wipes the others', () => {
  const { api } = loadDock()
  const seen = []
  api.subscribeContext((next) => seen.push(next))

  api.setStatus('terminal', '终端 2 会话 · 运行中')
  api.setStatus('downloader', '烧录 · 62%')
  assert.deepEqual({ ...api.getContext().statuses }, {
    terminal: '终端 2 会话 · 运行中',
    downloader: '烧录 · 62%',
  })

  /* Blank / non-string clears that page's line only. */
  api.setStatus('downloader', '   ')
  assert.deepEqual({ ...api.getContext().statuses }, { terminal: '终端 2 会话 · 运行中' })
  api.setStatus('terminal', 42)
  assert.equal(api.getContext().statuses.terminal, undefined)

  /* An id is required; a junk call is a no-op, not a crash. */
  api.setStatus('', 'orphan')
  api.setStatus(undefined, 'orphan')
  assert.deepEqual({ ...api.getContext().statuses }, {})

  /* A workspace patch must NOT blank the background-task lines. */
  api.setStatus('terminal', 'a')
  api.setContext({ name: 'proj', path: 'D:\\work\\proj' })
  assert.equal(api.getContext().statuses.terminal, 'a')
  assert.equal(api.getContext().name, 'proj')

  /* Copies are isolated: a page mutating what it read cannot corrupt the shell. */
  const snapshot = api.getContext()
  snapshot.statuses.terminal = 'mutated'
  assert.equal(api.getContext().statuses.terminal, 'a')

  assert.ok(seen.length >= 4, 'every change notifies the shell')
})

test('the shell keeps every visited page mounted (keep-alive)', () => {
  /* Switching pages must not unmount them: a terminal session, a running burn and
     a row selection all live in page state. The contract is "render every visited
     page, hide the inactive ones with CSS" — a regression to `E(current.component)`
     would look identical on screen but kill those sessions. */
  const source = readFileSync(clientPath, 'utf8')
  assert.match(source, /visited\.has\(page\.id\)/, 'inactive pages must stay in the tree')
  assert.match(source, /className: 'wbd-page'/, 'each page needs a persistent wrapper')
  assert.match(source, /\.wbd-page\.is-active\{display:flex\}/, 'only the active page is displayed')
  assert.match(source, /const \[visited, setVisited\]/, 'the visited set is what makes mounting lazy')
  assert.doesNotMatch(source, /E\(current\.component/, 'the active page must not be the only one rendered')
})

test('every workbench page publishes its context, and guards a missing bus', () => {
  /* Static contract check: the shell renders the context bar and the background
     task badges, but the PAGES own the facts. A page that silently stops
     publishing would leave the bar blank with no test failure otherwise. */
  const repoRoot = path.resolve(here, '..', '..')
  const pages = [
    { rel: 'source-control/src/client.js', publishes: /dock\.setContext\(/ },
    { rel: 'terminal/src/client.js', publishes: /dock\.setStatus\(/ },
    { rel: 'downloader/lib/client.js', publishes: /dock\.setStatus\(/ },
  ]
  for (const page of pages) {
    const source = readFileSync(path.join(repoRoot, page.rel), 'utf8')
    assert.match(source, /window\.__DSH_WORKBAY__/, page.rel + ' should read the shared global')
    assert.match(source, page.publishes, page.rel + ' should publish its context')
    /* Must degrade to a no-op: the standalone panel has no dock at all. */
    assert.match(source, /typeof dock\.(setStatus|setContext) (===|!==) 'function'/, page.rel + ' should guard the bus')
  }
})

/* ===================== titlebar load meter ===================== */

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

test('the meter is actually mounted into the titlebar action row', () => {
  const source = readFileSync(clientPath, 'utf8')
  /* Anchor on the JSX, not on the stylesheet: `wbd-titleActions` and every
     `wbd-load*` class also appear in the CSS, so a class-name match stayed green
     with the component deleted. These two assertions fail if the mount or the
     cell markup goes away. */
  assert.match(source, /\bE\(LoadMeter, \{ t \}\),/, 'LoadMeter must be rendered into the titlebar')
  assert.match(source, /\bE\('span', \{ className: 'wbd-loadDot' \}\)/, 'each cell needs its dot')
  assert.match(source, /\bE\('span', \{ className: 'wbd-loadLabel' \}/, 'each cell needs its label')
})

test('the metric words are never hidden at any tier', () => {
  const source = readFileSync(clientPath, 'utf8')
  /* The user asked for the words CPU / GPU / MEM to always be visible. Measured
     in a real browser the full row is 179px and fits the 520px minimum dock
     width, so no tier needs to drop them. A `display:none` rule keyed off
     `[data-w]` for the label or the percent sign would silently reverse this. */
  const hideRules = source.match(/\[data-w="t[1-4]"\][^{]*wbd-loadLabel[^{]*\{[^}]*display\s*:\s*none/g)
  assert.equal(hideRules, null, 'no tier may hide the metric word')
  const hidePct = source.match(/\[data-w="t[1-4]"\][^{]*wbd-loadPct[^{]*\{[^}]*display\s*:\s*none/g)
  assert.equal(hidePct, null, 'no tier may hide the percent sign')
})

test('the metric words are ASCII abbreviations in every locale', () => {
  const source = readFileSync(clientPath, 'utf8')
  /* Explicitly requested: `CPU` / `GPU` / `MEM`, not 处理器 / 显卡 / 内存 and not
     RAM. Locale dictionaries are the easy place for a well-meaning translation to
     undo this, so pin the exact strings inside each dictionary slice. */
  const zh = source.slice(source.indexOf('const ZH = {'), source.indexOf('const EN = {'))
  const en = source.slice(source.indexOf('const EN = {'), source.indexOf('const LOCALES ='))
  const want = [['load.cpu', 'CPU'], ['load.gpu', 'GPU'], ['load.mem', 'MEM']]
  for (const [key, word] of want) {
    assert.ok(zh.includes("'" + key + "': '" + word + "'"), key + ' must be ' + word + ' in ZH')
    assert.ok(en.includes("'" + key + "': '" + word + "'"), key + ' must be ' + word + ' in EN')
  }
})

test('the request path, the guard order and the envelope check are all present', () => {
  const source = readFileSync(clientPath, 'utf8')
  assert.match(source, /dsh-workbay-dock\/api\/load/)
  const body = source.slice(source.indexOf('function useLoadMeter'), source.indexOf('function LoadMeter'))
  /* Both guards must precede the request. */
  assert.ok(body.indexOf('document.hidden') < body.indexOf('api/load'), 'hidden guard precedes the request')
  assert.ok(body.indexOf('document.hasFocus()') < body.indexOf('api/load'), 'focus guard precedes the request')
  /* The kit reports failures as a 200 envelope with ok:false; treating that as
     "no data" made the user hit three dashes with no explanation. */
  assert.match(body, /envelope\.ok !== true/, 'a ok:false envelope must take the error path')
  /* Overlapping ticks would be differenced over ~0ms by the host CPU reader. */
  assert.match(body, /inFlight/, 'the hook needs a single-flight guard')
  assert.match(body, /removeEventListener\('focus'/, 'the focus listener must be removed on unmount')
})

test('both locale dictionaries carry the meter keys', () => {
  const source = readFileSync(clientPath, 'utf8')
  /* Compare against the DICTIONARY SLICES, not the whole file: counting raw
     occurrences let a key present in ZH and in a `t()` call site satisfy the
     check even after it was deleted from EN. */
  const zhStart = source.indexOf('const ZH = {')
  const enStart = source.indexOf('const EN = {')
  const enEnd = source.indexOf('const LOCALES =')
  const zh = source.slice(zhStart, enStart)
  const en = source.slice(enStart, enEnd)
  for (const key of ['load.title', 'load.cpu', 'load.gpu', 'load.mem', 'load.noGpu']) {
    assert.ok(zh.includes("'" + key + "'"), key + ' missing from ZH')
    assert.ok(en.includes("'" + key + "'"), key + ' missing from EN')
  }
})

/* Review Focus 1: the first sample has no CPU baseline, so the meter MUST retry
   once instead of sitting on "—" forever — and exactly once, not in a loop. */
test('the meter retries a null CPU reading through the latch decision', () => {
  const source = readFileSync(clientPath, 'utf8')
  /* The delay is a named constant, not a literal buried in the hook: assert the
     VALUE the spec pins, then assert the body actually uses it. */
  const retryMs = Number(/METER_RETRY_MS\s*=\s*(\d+)/.exec(source)[1])
  assert.equal(retryMs, 1500, 'retry delay is 1500ms per the spec')
  const body = source.slice(source.indexOf('function useLoadMeter'), source.indexOf('function LoadMeter'))
  /* The latch is decided by the tested pure function; the hook must delegate to
     it rather than re-implement the rule inline (which is how the TTL case got
     missed the first time). */
  assert.match(body, /meterNextRetryState\(/, 'the hook must delegate the retry decision')
  assert.match(body, /METER_RETRY_MS/, 'the retry must use the declared delay')
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

/* -------- behavior tests for the meter's pure decisions (not CSS strings) --------
   The first version of this cluster matched stylesheet text, which stayed green
   even with the component deleted. These call exported functions instead: delete
   the implementation and they fail. */
test('meter levels follow the pinned 90 / 95 thresholds', () => {
  const { api } = loadDock()
  const { level } = api.meter
  assert.equal(level(0), 'ok')
  assert.equal(level(89), 'ok')
  assert.equal(level(90), 'warn')
  assert.equal(level(94), 'warn')
  assert.equal(level(95), 'hot')
  assert.equal(level(100), 'hot')
  /* No number available is not an alarm state. */
  assert.equal(level(null), 'ok')
  assert.equal(level(undefined), 'ok')
})

test('the GPU is only reported missing once a sample has actually arrived', () => {
  const { api } = loadDock()
  const { gpuMissing } = api.meter
  /* Before the first sample every field is null. Claiming "no GPU detected" here
     tells the user something false about their hardware. */
  assert.equal(gpuMissing({ cpu: null, gpu: null, mem: null, err: '' }), false)
  /* After a sample, a null gpu really does mean no NVIDIA card. */
  assert.equal(gpuMissing({ cpu: 20, gpu: null, mem: { usedPct: 50 }, err: '' }), true)
  assert.equal(gpuMissing({ cpu: 20, gpu: { util: 3 }, mem: { usedPct: 50 }, err: '' }), false)
})

test('a failed poll marks the reading stale instead of blanking it', () => {
  const { api } = loadDock()
  const { isStale } = api.meter
  assert.equal(isStale({ cpu: 20, gpu: null, mem: null, err: '' }), false)
  assert.equal(isStale({ cpu: 20, gpu: null, mem: null, err: 'offline' }), true)
})

/* Review Focus 2: the retry must re-arm after the baseline is discarded by the
   TTL, or a returning user stares at "—" for a full 5s interval. */
test('the retry latch re-arms after a completed sample', () => {
  const { api } = loadDock()
  const { nextRetryState } = api.meter
  /* Compare FIELDS, not whole objects: `api.meter` comes out of a `vm` context,
     so its object literals carry a different Object.prototype than this realm and
     deepEqual would fail on identical values. */
  const check = (retried, cpu, wantRetried, wantSchedule) => {
    const got = nextRetryState(retried, cpu)
    assert.equal(got.retried, wantRetried, 'retried flag for (' + retried + ', ' + cpu + ')')
    assert.equal(got.schedule, wantSchedule, 'schedule flag for (' + retried + ', ' + cpu + ')')
  }
  /* First null: arm the retry. */
  check(false, null, true, true)
  /* Already retried this episode and still null: do not loop. */
  check(true, null, true, false)
  /* A real number ends the episode, so the NEXT null (TTL discard) can retry. */
  check(true, 42, false, false)
  check(false, 42, false, false)
})
