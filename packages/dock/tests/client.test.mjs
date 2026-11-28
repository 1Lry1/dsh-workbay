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
