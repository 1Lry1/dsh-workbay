/**
 * Client-half tests for `dsh-workbay-terminal` (xterm.js + tabs).
 *
 * The page is one `window.__ModuleLoader__.load({ id, factory })` file, so the
 * harness boots it exactly like the DSH client loader and then pins the pure
 * helpers, the lazy-chunk protocol, page registration and the React components
 * (with stubbed hooks/DOM, since Node has neither).
 *
 * Run:  node --test tests/client.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientPath = path.join(here, '..', 'src', 'client.js')
const chunkSourcePath = path.join(here, '..', 'src', 'chunks', 'xterm.js')
const builtChunkPath = path.join(here, '..', 'lib', 'chunks', 'xterm.js')
const source = readFileSync(clientPath, 'utf8')
const chunkSource = readFileSync(chunkSourcePath, 'utf8')

/* ============================== harness ============================== */

function makeReact() {
  const Fragment = Symbol('Fragment')
  return {
    Fragment,
    createElement(type, props, ...children) {
      const normalized = props === null || props === undefined ? {} : props
      normalized.children = children.length === 0 ? undefined : (children.length === 1 ? children[0] : children)
      return { type, props: normalized, children: children.flat() }
    },
    useState(initial) {
      const value = typeof initial === 'function' ? initial() : initial
      return [value, () => {}]
    },
    useEffect() {},
    useMemo(fn) { return fn() },
    useRef(value) { return { current: value } },
    useCallback(fn) { return fn },
    memo(fn) { return fn },
  }
}

function makeDock() {
  const pages = []
  return {
    pages,
    registerPage(page) {
      pages.push(page)
      return () => {
        const index = pages.indexOf(page)
        if (index >= 0) pages.splice(index, 1)
      }
    },
    list() { return pages.slice() },
    subscribe() { return () => {} },
  }
}

function makeCtx(locale) {
  const effects = []
  const localeRegistrations = []
  const localeService = {
    register(namespace, dictionaries) {
      localeRegistrations.push({ namespace, dictionaries })
      return () => {}
    },
    getSnapshot() { return { active: locale === undefined ? 'en' : locale } },
    subscribe() { return () => {} },
  }
  const ctx = {
    effect(fn, label) {
      const dispose = fn()
      effects.push({ label, dispose })
      return () => { if (typeof dispose === 'function') dispose() }
    },
    get(name) {
      if (name === 'locale') return localeService
      return undefined
    },
  }
  return { ctx, effects, localeRegistrations }
}

function boot(options) {
  const opts = options === undefined ? {} : options
  const registered = []
  const styleTags = []
  const listeners = new Map()
  const storage = new Map(Object.entries(opts.storage === undefined ? {} : opts.storage))
  const document = {
    baseURI: 'http://127.0.0.1:3080/',
    head: { appendChild(node) { styleTags.push(node) } },
    documentElement: { appendChild(node) { styleTags.push(node) } },
    createElement(tag) {
      return {
        tag,
        attributes: {},
        textContent: '',
        setAttribute(name, value) { this.attributes[name] = value },
        remove() { this.removed = true },
      }
    },
  }
  const window = {
    __DSH_WORKBAY__: opts.dock,
    __ModuleLoader__: {
      load(spec) {
        assert.equal(spec.id, 'dsh-workbay-terminal')
        const React = opts.react === undefined ? makeReact() : opts.react()
        const mod = spec.factory((name) => {
          if (name === 'react') return React
          throw new Error('unexpected require: ' + name)
        })
        registered.push({ id: spec.id, mod, React })
      },
    },
    localStorage: {
      getItem(key) { return storage.has(key) ? storage.get(key) : null },
      setItem(key, value) { storage.set(key, String(value)) },
      removeItem(key) { storage.delete(key) },
    },
    addEventListener(name, listener) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(listener)
    },
    removeEventListener(name, listener) {
      const list = listeners.get(name)
      if (list === undefined) return
      const index = list.indexOf(listener)
      if (index >= 0) list.splice(index, 1)
    },
  }
  const noNetwork = async () => { throw new Error('no network in unit tests') }
  // eslint-disable-next-line no-new-func
  const run = new Function('window', 'document', 'navigator', 'fetch', source)
  run(window, document, { language: opts.navigatorLanguage === undefined ? 'en-US' : opts.navigatorLanguage }, opts.fetch === undefined ? noNetwork : opts.fetch)
  assert.equal(registered.length, 1, 'the bundle must call __ModuleLoader__.load exactly once')
  const entry = registered[0]
  const ctxParts = makeCtx(opts.locale)
  return {
    entry,
    window,
    document,
    styleTags,
    listeners,
    storage,
    ctx: ctxParts.ctx,
    effects: ctxParts.effects,
    localeRegistrations: ctxParts.localeRegistrations,
    React: entry.React,
    testApi: entry.mod === null || entry.mod === undefined ? null : entry.mod.__test,
  }
}

function disposeBoot(booted) {
  for (const effect of booted.effects) {
    if (effect !== null && effect !== undefined && typeof effect.dispose === 'function') effect.dispose()
  }
}

const booted = boot()
const api = booted.testApi
const E = booted.React.createElement

/* ============================== component render harness ============================== */

function renderTree(node) {
  const out = []
  const walk = (current) => {
    if (current === null || current === undefined || typeof current === 'boolean') return
    if (Array.isArray(current)) {
      for (const child of current) walk(child)
      return
    }
    if (typeof current === 'string' || typeof current === 'number') {
      out.push(current)
      return
    }
    if (typeof current !== 'object' || current.type === undefined) return
    if (current.type === booted.React.Fragment) {
      for (const child of current.children) walk(child)
      return
    }
    if (typeof current.type === 'function') {
      walk(current.type(current.props, current.children))
      return
    }
    out.push(current)
    for (const child of current.children) walk(child)
  }
  walk(node)
  return out
}

function textOf(node) {
  return renderTree(node).filter((entry) => typeof entry === 'string' || typeof entry === 'number').join(' ')
}

function nodesOf(node, predicate) {
  return renderTree(node).filter((entry) => typeof entry === 'object' && entry !== null && entry.type !== undefined && predicate(entry))
}

function translate(key, values) {
  const template = Object.prototype.hasOwnProperty.call(api.dictionaries.en, key) ? api.dictionaries.en[key] : key
  return String(template).replace(/\{(\w+)\}/g, (match, name) => {
    if (values === undefined || values[name] === undefined) return match
    return String(values[name])
  })
}

/* ============================== bundle contract ============================== */

test('bundle exports apply and the terminal test helpers', () => {
  assert.equal(typeof booted.entry.mod.apply, 'function')
  assert.equal(booted.entry.mod.name, 'dsh-workbay-terminal')
  assert.equal(api.PAGE_ID, 'terminal')
  assert.equal(api.CHUNK_NAME, 'dsh-workbay-terminal:xterm')
  assert.equal(api.CHUNK_ROUTE, '/dsh-workbay-terminal/chunk/xterm.js')
  assert.equal(api.COMMAND_PROMPT, '$ ')
})

test('registers exactly one workbench page: terminal, order 40', () => {
  const dock = makeDock()
  const local = boot({ dock })
  local.entry.mod.apply(local.ctx)
  assert.equal(dock.pages.length, 1)
  const page = dock.pages[0]
  assert.equal(page.id, 'terminal')
  assert.equal(page.order, 40)
  assert.equal(page.title, 'Terminal')
  assert.equal(typeof page.icon, 'function')
  assert.equal(typeof page.component, 'function')
  const icon = page.icon(16)
  assert.equal(typeof icon.type, 'function')
  const renderedIcon = icon.type(icon.props)
  assert.equal(renderedIcon.type, 'svg')
  assert.equal(renderedIcon.props.width, 16)
  assert.equal(local.styleTags.length, 1)
  assert.equal(local.styleTags[0].attributes['data-dsh-workbay-terminal'], '')
  assert.equal(local.localeRegistrations.length, 1)
  assert.equal(local.localeRegistrations[0].namespace, 'dsh-workbay-terminal')
  assert.deepEqual(Object.keys(local.localeRegistrations[0].dictionaries).sort(), ['en', 'zh'])
  disposeBoot(local)
})

test('the registered page title follows the active locale', () => {
  const dock = makeDock()
  const local = boot({ dock, locale: 'zh-CN' })
  local.entry.mod.apply(local.ctx)
  assert.equal(dock.pages[0].title, '终端')
  disposeBoot(local)
})

test('polls for the dock global when it appears after the bundle loads', async () => {
  const dock = makeDock()
  const local = boot({ dock: undefined })
  local.entry.mod.apply(local.ctx)
  assert.equal(dock.pages.length, 0)
  local.window.__DSH_WORKBAY__ = dock
  await new Promise((resolve) => setTimeout(resolve, 700))
  assert.equal(dock.pages.length, 1)
  assert.equal(dock.pages[0].id, 'terminal')
  disposeBoot(local)
})

/* ============================== pure helpers ============================== */

test('parseRootValue accepts plain strings, JSON and JSON-encoded strings', () => {
  assert.equal(api.parseRootValue('C:\\work\\repo'), 'C:\\work\\repo')
  assert.equal(api.parseRootValue('  /home/me  '), '/home/me')
  assert.equal(api.parseRootValue('{"path":"D:\\\\work"}'), 'D:\\work')
  assert.equal(api.parseRootValue('{"root":"E:/repo"}'), 'E:/repo')
  assert.equal(api.parseRootValue('"F:/quoted"'), 'F:/quoted')
  assert.equal(api.parseRootValue('{"path":""}'), '')
  assert.equal(api.parseRootValue(''), '')
  assert.equal(api.parseRootValue(null), '')
  assert.equal(api.parseRootValue(undefined), '')
})

test('clampDimensions clamps to sane PTY bounds and falls back', () => {
  assert.deepEqual(api.clampDimensions(80, 24), { cols: 80, rows: 24 })
  assert.deepEqual(api.clampDimensions(1, 1), { cols: api.MIN_COLS, rows: api.MIN_ROWS })
  assert.deepEqual(api.clampDimensions(99999, 99999), { cols: api.MAX_COLS, rows: api.MAX_ROWS })
  assert.deepEqual(api.clampDimensions('x', null), { cols: api.DEFAULT_COLS, rows: api.DEFAULT_ROWS })
  assert.deepEqual(api.clampDimensions(50, 10, { cols: 90, rows: 30 }), { cols: 50, rows: 10 })
  assert.deepEqual(api.clampDimensions(Number.NaN, Number.NaN, { cols: 120, rows: 40 }), { cols: 120, rows: 40 })
  assert.equal(api.clampDimensions(80.7, 24.2).cols, 81)
})

test('createTab and reduceTabs cover add/activate/close/rename/patch/exit', () => {
  const first = api.createTab('tab-1', 'Terminal 1', 'C:\\work')
  assert.equal(first.key, 'tab-1')
  assert.equal(first.phase, 'starting')
  assert.equal(first.mode, 'command')
  assert.equal(first.root, 'C:\\work')

  let state = { tabs: [], activeKey: '' }
  state = api.reduceTabs(state, { type: 'add', tab: first })
  assert.equal(state.tabs.length, 1)
  assert.equal(state.activeKey, 'tab-1')

  const second = api.createTab('tab-2', 'Terminal 2', 'C:\\work')
  state = api.reduceTabs(state, { type: 'add', tab: second })
  assert.equal(state.tabs.length, 2)
  assert.equal(state.activeKey, 'tab-2')
  assert.equal(api.reduceTabs(state, { type: 'add', tab: second }), state, 'duplicate keys are ignored')

  state = api.reduceTabs(state, { type: 'activate', key: 'tab-1' })
  assert.equal(state.activeKey, 'tab-1')
  state = api.reduceTabs(state, { type: 'activate', key: 'missing' })
  assert.equal(state.activeKey, 'tab-1')

  state = api.reduceTabs(state, { type: 'rename', key: 'tab-1', title: '  build  ' })
  assert.equal(state.tabs[0].title, 'build')
  assert.equal(state.tabs[0].renamed, true)
  assert.equal(api.reduceTabs(state, { type: 'rename', key: 'tab-1', title: '   ' }), state)

  state = api.reduceTabs(state, { type: 'patch', key: 'tab-2', patch: { phase: 'running', mode: 'pty', shell: 'pwsh' } })
  assert.equal(state.tabs[1].phase, 'running')
  assert.equal(state.tabs[1].mode, 'pty')

  state = api.reduceTabs(state, { type: 'exit', key: 'tab-2', code: 0 })
  assert.equal(state.tabs[1].phase, 'exited')
  assert.equal(state.tabs[1].exitCode, 0)

  /* Closing the active tab falls back to the neighbour at the same index. */
  state = api.reduceTabs(state, { type: 'close', key: 'tab-1' })
  assert.deepEqual(state.tabs.map((tab) => tab.key), ['tab-2'])
  assert.equal(state.activeKey, 'tab-2')
  state = api.reduceTabs(state, { type: 'close', key: 'tab-2' })
  assert.deepEqual(state.tabs, [])
  assert.equal(state.activeKey, '')
  assert.equal(api.reduceTabs(state, { type: 'close', key: 'nope' }), state)
})

test('parseSsePayload accepts json event frames and ignores garbage', () => {
  assert.deepEqual(api.parseSsePayload('{"type":"hello","mode":"pty","id":"s1"}'), { type: 'hello', mode: 'pty', id: 's1' })
  assert.deepEqual(api.parseSsePayload('{"type":"out","data":"hi"}'), { type: 'out', data: 'hi' })
  assert.deepEqual(api.parseSsePayload('{"type":"exit","code":0}'), { type: 'exit', code: 0 })
  assert.equal(api.parseSsePayload('not json'), null)
  assert.equal(api.parseSsePayload('{"data":"no type"}'), null)
  assert.equal(api.parseSsePayload('null'), null)
  assert.equal(api.parseSsePayload('[]'), null)
  assert.equal(api.parseSsePayload(''), null)
  assert.equal(api.parseSsePayload(undefined), null)
})

test('the command-mode line editor echoes, edits, walks history and submits', () => {
  let state = api.createCommandEditorState()
  state = api.commandEditorReducer(state, { type: 'insert', text: 'echo' })
  state = api.commandEditorReducer(state, { type: 'insert', text: ' hi' })
  assert.equal(state.line, 'echo hi')
  assert.equal(api.commandEcho(state.line), '\r\u001b[2K$ echo hi')

  state = api.commandEditorReducer(state, { type: 'backspace' })
  assert.equal(state.line, 'echo h')
  state = api.commandEditorReducer(state, { type: 'insert', text: 'i' })
  assert.equal(state.line, 'echo hi')

  const submitted = api.submitCommandLine(state)
  assert.equal(submitted.command, 'echo hi')
  assert.equal(submitted.state.line, '')
  assert.deepEqual(submitted.state.history, ['echo hi'])

  /* Up recalls the newest entry, Up again the previous one, Down walks forward. */
  let editor = submitted.state
  editor = api.commandEditorReducer(editor, { type: 'insert', text: 'second' })
  editor = api.submitCommandLine(editor).state
  editor = api.commandEditorReducer(editor, { type: 'up' })
  assert.equal(editor.line, 'second')
  editor = api.commandEditorReducer(editor, { type: 'up' })
  assert.equal(editor.line, 'echo hi')
  editor = api.commandEditorReducer(editor, { type: 'down' })
  assert.equal(editor.line, 'second')
  editor = api.commandEditorReducer(editor, { type: 'down' })
  assert.equal(editor.line, '')

  /* A draft typed before history navigation is restored on the way back. */
  let draft = api.commandEditorReducer(
    { line: 'draft', history: ['echo hi', 'second'], index: 2, draft: '' },
    { type: 'up' },
  )
  assert.equal(draft.line, 'second')
  draft = api.commandEditorReducer(draft, { type: 'down' })
  assert.equal(draft.line, 'draft')

  assert.equal(api.commandEditorReducer(draft, { type: 'clear' }).line, '')
  assert.deepEqual(api.commandEditorReducer({ line: 'x', history: [], index: 0, draft: '' }, { type: 'up' }).line, 'x')
  assert.deepEqual(api.submitCommandLine({ line: '   ', history: [], index: 0, draft: '' }).state.history, [])
})

test('history is capped at 100 entries', () => {
  let state = api.createCommandEditorState()
  for (let index = 0; index < 130; index += 1) {
    state = api.commandEditorReducer(state, { type: 'insert', text: 'cmd' + index })
    state = api.submitCommandLine(state).state
  }
  assert.equal(state.history.length, 100)
  assert.equal(state.history[99], 'cmd129')
})

test('input normalisation strips command-mode controls and turns paste newlines into CR', () => {
  assert.equal(api.normalizeCommandInput('a\rb\nc'), 'abc')
  assert.equal(api.normalizeCommandInput('a\u0000b\u0007c\u007f'), 'abc')
  assert.equal(api.normalizeCommandInput('ls -la'), 'ls -la')
  assert.equal(api.normalizeTerminalPaste('a\r\nb\nc'), 'a\rb\rc')
  assert.equal(api.normalizeTerminalPaste(''), '')
})

test('themeFromVars builds a dark and a light palette from DSH variables', () => {
  const dark = api.themeFromVars({
    background: '#14161a',
    foreground: '#e6e6e6',
    brand: '#4d6bfe',
    mono: '"JetBrains Mono", monospace',
  })
  assert.equal(dark.background, '#14161a')
  assert.equal(dark.foreground, '#e6e6e6')
  assert.equal(dark.cursor, '#4d6bfe')
  assert.equal(dark.fontFamily, '"JetBrains Mono", monospace')
  assert.equal(dark.black, '#1e1e1e')
  assert.equal(dark.brightWhite, '#ffffff')
  assert.equal(dark.selectionBackground, 'rgba(77,107,254,0.35)')

  const light = api.themeFromVars({ background: '#ffffff', foreground: '#222222', brand: '#0451a5' })
  assert.equal(light.background, '#ffffff')
  assert.equal(light.black, '#000000')
  assert.equal(light.brightBlack, '#666666')

  const fallback = api.themeFromVars(undefined)
  assert.equal(fallback.background, '#14161a')
  assert.equal(fallback.foreground, '#e6e6e6')
  assert.equal(fallback.cursor, '#4d6bfe')
  assert.equal(typeof fallback.fontFamily, 'string')
  assert.equal(typeof fallback.fontSize, 'number')
})

test('colour helpers understand hex, rgb and fallbacks', () => {
  assert.equal(api.isDarkColor('#000000'), true)
  assert.equal(api.isDarkColor('#ffffff'), false)
  assert.equal(api.isDarkColor('rgb(20, 22, 26)'), true)
  assert.equal(api.isDarkColor('rgb(240,240,240)'), false)
  assert.equal(api.isDarkColor('not-a-colour'), true)
  assert.equal(api.isDarkColor(undefined), true)
  assert.equal(api.colorLuminance('#fff'), 1)
  assert.equal(api.colorLuminance('#000'), 0)
  assert.equal(api.colorLuminance('red'), null)
  assert.equal(api.withAlpha('#4d6bfe', 0.5), 'rgba(77,107,254,0.5)')
  assert.equal(api.withAlpha('', 0.5), 'rgba(77,107,254,0.5)')
})

/* ============================== lazy chunk ============================== */

test('loadChunk calls a pre-registered chunk factory with the host React', async () => {
  const previous = globalThis.__dshChunks__
  const calls = []
  globalThis.__dshChunks__ = {
    'dsh-workbay-terminal:xterm': (env) => {
      calls.push(env)
      return { createTerminal() { return { dispose() {} } }, css: '.xterm{}' }
    },
  }
  try {
    const mod = await api.loadChunk()
    assert.equal(calls.length, 1)
    assert.equal(calls[0].modules.react, booted.React)
    assert.equal(typeof mod.createTerminal, 'function')
    const cached = await api.loadChunk()
    assert.equal(cached, mod)
    assert.equal(calls.length, 1, 'a cached chunk is not re-created')
  } finally {
    if (previous === undefined) delete globalThis.__dshChunks__
    else globalThis.__dshChunks__ = previous
  }
})

test('loadChunk injects /dsh-workbay-terminal/chunk/xterm.js once and reads the registry', async () => {
  const previous = globalThis.__dshChunks__
  delete globalThis.__dshChunks__
  const local = boot()
  try {
    const pending = local.testApi.loadChunk()
    const scripts = local.styleTags.filter((node) => node.tag === 'script')
    assert.equal(scripts.length, 1)
    assert.ok(scripts[0].src.includes('/dsh-workbay-terminal/chunk/xterm.js'), scripts[0].src)
    assert.equal(scripts[0].async, true)
    let seen = null
    globalThis.__dshChunks__ = {
      'dsh-workbay-terminal:xterm': (env) => {
        seen = env
        return { createTerminal() { return { dispose() {} } }, css: '.xterm{}' }
      },
    }
    scripts[0].onload()
    const mod = await pending
    assert.equal(seen.modules.react, local.React)
    assert.equal(typeof mod.createTerminal, 'function')
  } finally {
    if (previous === undefined) delete globalThis.__dshChunks__
    else globalThis.__dshChunks__ = previous
  }
})

test('injectXtermCss adds exactly one style tag per bundle', () => {
  const local = boot()
  local.testApi.injectXtermCss('.xterm{color:red}')
  local.testApi.injectXtermCss('.xterm{color:blue}')
  const styles = local.styleTags.filter((node) => node.tag === 'style')
  assert.equal(styles.length, 1)
  assert.equal(styles[0].textContent, '.xterm{color:red}')
  assert.equal(styles[0].attributes['data-dsh-workbay-terminal-xterm'], '')
  local.testApi.injectXtermCss('')
  assert.equal(local.styleTags.filter((node) => node.tag === 'style').length, 1)
})

test('the built xterm chunk registers itself and exports createTerminal + css', (t) => {
  if (!existsSync(builtChunkPath)) {
    t.skip('lib/chunks/xterm.js not built — run `pnpm run build` first')
    return
  }
  const built = readFileSync(builtChunkPath, 'utf8')
  assert.ok(built.includes('dsh-workbay-terminal:xterm'), 'chunk key is registered in the built file')
  assert.ok(built.includes('createTerminal'), 'built chunk mentions the createTerminal export')
  assert.ok(built.includes('css'), 'built chunk mentions the css export')
  assert.ok(built.includes('.xterm'), 'xterm.css is embedded as text in the chunk')
  const sandbox = { globalThis: {}, console }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(built, sandbox, { filename: 'xterm-chunk.js', timeout: 10000 })
  const registry = sandbox.__dshChunks__
  assert.ok(registry !== null && registry !== undefined, 'built chunk creates __dshChunks__')
  assert.equal(typeof registry['dsh-workbay-terminal:xterm'], 'function')
  assert.ok(chunkSource.includes('export function createTerminal'))
  assert.ok(chunkSource.includes('export const css'))
})

/* ============================== component smoke ============================== */

test('TabBar renders one tab control per tab, highlight, close and new buttons', () => {
  const tabs = [
    api.createTab('tab-1', 'Terminal 1', 'C:\\work'),
    Object.assign(api.createTab('tab-2', 'build', 'C:\\work'), { phase: 'running', mode: 'pty' }),
  ]
  const bar = E(api.components.TabBar, {
    t: translate,
    tabs,
    activeKey: 'tab-1',
    renamingKey: '',
    renameDraft: '',
    onActivate() {},
    onClose() {},
    onNew() {},
    onBeginRename() {},
    onRenameDraft() {},
    onRenameCommit() {},
    onRenameCancel() {},
  })
  const text = textOf(bar)
  assert.ok(text.includes('Terminal 1'))
  assert.ok(text.includes('build'))
  const active = nodesOf(bar, (node) => typeof node.props.className === 'string' && node.props.className.split(' ').includes('is-active'))
  assert.equal(active.length, 1)
  const closes = nodesOf(bar, (node) => typeof node.props.className === 'string' && node.props.className.includes('dswt-tabClose'))
  assert.equal(closes.length, 2)
  const newButton = nodesOf(bar, (node) => node.type === 'button' && node.props.className === 'dswt-newTab')
  assert.equal(newButton.length, 1)
  const dots = nodesOf(bar, (node) => typeof node.props.className === 'string' && node.props.className.includes('dswt-tabDot'))
  assert.equal(dots.length, 2)
  assert.ok(dots.some((node) => node.props.className.includes('is-running')))
})

test('TabBar renders a rename input for the tab being renamed', () => {
  const bar = E(api.components.TabBar, {
    t: translate,
    tabs: [api.createTab('tab-1', 'Terminal 1', 'C:\\work')],
    activeKey: 'tab-1',
    renamingKey: 'tab-1',
    renameDraft: 'my shell',
    onActivate() {},
    onClose() {},
    onNew() {},
    onBeginRename() {},
    onRenameDraft() {},
    onRenameCommit() {},
    onRenameCancel() {},
  })
  const input = nodesOf(bar, (node) => node.type === 'input')
  assert.equal(input.length, 1)
  assert.equal(input[0].props.value, 'my shell')
  const text = textOf(bar)
  assert.equal(text.includes('Terminal 1'), false)
})

test('StatusBar shows shell/cwd/mode/tab count and the non-PTY badge', () => {
  const tab = Object.assign(api.createTab('tab-1', 'Terminal 1', 'C:\\work'), {
    phase: 'running',
    mode: 'command',
    shell: 'pwsh',
    cwd: 'C:\\work\\repo',
  })
  const command = E(api.components.StatusBar, { t: translate, tab, tabCount: 2 })
  const commandText = textOf(command)
  assert.ok(commandText.includes('pwsh'))
  assert.ok(commandText.includes('C:\\work\\repo'))
  assert.ok(commandText.includes('non-PTY'))
  assert.ok(commandText.includes('2'))
  assert.ok(commandText.includes('Running'))

  const ptyDark = E(api.components.StatusBar, { t: translate, tab: Object.assign({}, tab, { mode: 'pty' }), tabCount: 1 })
  assert.ok(textOf(ptyDark).includes('PTY'))
  assert.equal(textOf(ptyDark).includes('non-PTY'), false)
})

test('TerminalTab renders its terminal host and honours active/display:none', () => {
  const tab = api.createTab('tab-1', 'Terminal 1', 'C:\\work')
  const hidden = E(api.components.TerminalTab, {
    t: translate,
    tabKey: 'tab-1',
    root: 'C:\\work',
    active: false,
    theme: api.themeFromVars(undefined),
    onStatus() {},
    onTitle() {},
  })
  const hiddenHost = nodesOf(hidden, (node) => typeof node.props.className === 'string' && node.props.className.includes('dswt-termHost'))
  assert.equal(hiddenHost.length, 1)
  assert.equal(hiddenHost[0].props.className, 'dswt-termHost')
  const hiddenPanel = nodesOf(hidden, (node) => typeof node.props.className === 'string' && node.props.className.includes('dswt-panel'))
  assert.equal(hiddenPanel.length, 1)
  assert.equal(hiddenPanel[0].props.style.display, 'none')
  assert.ok(textOf(hidden).includes('Starting terminal…'))

  const shown = E(api.components.TerminalTab, {
    t: translate,
    tabKey: 'tab-1',
    root: 'C:\\work',
    active: true,
    theme: api.themeFromVars(undefined),
    onStatus() {},
    onTitle() {},
  })
  const shownPanel = nodesOf(shown, (node) => typeof node.props.className === 'string' && node.props.className.includes('dswt-panel'))
  assert.equal(shownPanel[0].props.style.display, 'flex')
})

test('RootEmpty explains that the Files page owns the picker', () => {
  const empty = E(api.components.RootEmpty, { t: translate, onRecheck() {} })
  const text = textOf(empty)
  assert.ok(text.includes('No workspace selected yet'))
  assert.ok(text.includes('Files page'))
  assert.ok(text.includes('Recheck'))
  const button = nodesOf(empty, (node) => node.type === 'button')
  assert.equal(button.length, 1)
})

test('Page shows the empty workspace state and the page chrome with a root', () => {
  const withoutRoot = boot({ storage: {} })
  const emptyPage = E(withoutRoot.testApi.components.Page, { t: translate })
  assert.ok(textOf(emptyPage).includes('No workspace selected yet'))
  assert.equal(nodesOf(emptyPage, (node) => typeof node.props.className === 'string' && node.props.className.includes('dswt-tabbar')).length, 0)

  const withRoot = boot({ storage: { 'dsh-workbay.root.v1': 'C:\\work' } })
  const page = E(withRoot.testApi.components.Page, { t: translate })
  const pageText = textOf(page)
  assert.ok(pageText.includes('No terminal open'), 'first tab is created in an effect, so the stubbed render shows the empty-tab state')
  assert.equal(nodesOf(page, (node) => typeof node.props.className === 'string' && node.props.className.includes('dswt-tabbar')).length, 1)
  assert.equal(nodesOf(page, (node) => node.type === 'button' && node.props.className === 'dswt-newTab').length, 1)
  assert.ok(pageText.includes('non-PTY'))
})

/* ============================== effect-level wiring ============================== */

/**
 * A deliberately tiny hook runtime: enough to mount ONE function component and
 * run its effects, which lets these tests exercise the session engine (lazy
 * chunk → start → SSE → command-mode editor → restart → teardown) without a
 * browser or a real React renderer.
 */
function createHookRuntime() {
  let hooks = []
  let cursor = 0
  let queue = []
  let component = null
  let props = null
  let tree = null
  let scheduled = false
  let alive = false

  function setAt(index, value) {
    const hook = hooks[index]
    hook.state = typeof value === 'function' ? value(hook.state) : value
    if (!scheduled && alive) {
      scheduled = true
      queueMicrotask(() => {
        scheduled = false
        if (alive) render()
      })
    }
  }

  function makeElement(tag) {
    return {
      tag,
      listeners: [],
      attributes: {},
      style: {},
      addEventListener(name, fn) { this.listeners.push([name, fn]) },
      removeEventListener(name, fn) {
        this.listeners = this.listeners.filter((entry) => entry[0] !== name || entry[1] !== fn)
      },
      appendChild() {},
      focus() {},
      remove() {},
      setAttribute(name, value) { this.attributes[name] = value },
    }
  }

  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, input, ...children) {
      const elementProps = input === null || input === undefined ? {} : input
      if (elementProps.ref && typeof type === 'string'
        && (elementProps.ref.current === null || elementProps.ref.current === undefined)) {
        elementProps.ref.current = makeElement(type)
      }
      elementProps.children = children.length === 0 ? undefined : (children.length === 1 ? children[0] : children)
      return { type, props: elementProps, children: children.flat() }
    },
    useState(initial) {
      const index = cursor
      cursor += 1
      if (!hooks[index]) hooks[index] = { kind: 'state', state: typeof initial === 'function' ? initial() : initial }
      return [hooks[index].state, (value) => setAt(index, value)]
    },
    useRef(initial) {
      const index = cursor
      cursor += 1
      if (!hooks[index]) hooks[index] = { kind: 'ref', current: initial }
      return hooks[index]
    },
    useMemo(fn) { cursor += 1; return fn() },
    useCallback(fn) { cursor += 1; return fn },
    useEffect(fn, deps) {
      const index = cursor
      cursor += 1
      if (!hooks[index]) hooks[index] = { kind: 'effect', deps: null, cleanup: null }
      const hook = hooks[index]
      const next = deps === undefined ? [] : deps
      const changed = hook.deps === null || hook.deps.length !== next.length
        || next.some((value, position) => value !== hook.deps[position])
      if (changed) {
        hook.deps = next.slice()
        queue.push({ hook, fn })
      }
    },
    memo(fn) { return fn },
  }

  function render() {
    cursor = 0
    queue = []
    tree = component(props)
    const pending = queue
    for (const item of pending) {
      if (typeof item.hook.cleanup === 'function') {
        try { item.hook.cleanup() } catch (error) { void error }
      }
      item.hook.cleanup = item.fn()
    }
    return tree
  }

  return {
    React,
    mount(nextComponent, nextProps) {
      component = nextComponent
      props = nextProps
      alive = true
      hooks = []
      render()
      return tree
    },
    tree: () => tree,
    unmount() {
      alive = false
      for (const hook of hooks) {
        if (hook !== null && hook !== undefined && hook.kind === 'effect' && typeof hook.cleanup === 'function') {
          try { hook.cleanup() } catch (error) { void error }
          hook.cleanup = null
        }
      }
    },
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function renderText(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (Array.isArray(node)) return node.map(renderText).join('')
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (typeof node !== 'object' || node.type === undefined) return ''
  if (typeof node.type === 'function') return renderText(node.type(node.props, node.children))
  return (node.children || []).map(renderText).join('')
}

function findButtons(node, out) {  const found = out === undefined ? [] : out
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) findButtons(child, found)
    return found
  }
  if (typeof node.type === 'function') {
    findButtons(node.type(node.props, node.children), found)
    return found
  }
  if (node.type === 'button') found.push(node)
  for (const child of node.children || []) findButtons(child, found)
  return found
}

function makeSessionWorld(mode, worldOptions) {
  const options = worldOptions === undefined ? {} : worldOptions
  const runtime = createHookRuntime()
  const fetchCalls = []
  const eventSources = []
  const handles = []
  const statuses = []
  let handleOptions = null
  let chunkEnv = null

  const fakeFetch = async (url, requestOptions) => {
    const method = String(url).split('/api/')[1] || ''
    let payload = {}
    try { payload = JSON.parse(requestOptions.body) } catch (error) { void error }
    fetchCalls.push({ method, payload })
    let data = { ok: true }
    if (method === 'start') data = { id: 's1', shell: 'pwsh', cwd: payload.root, mode }
    else if (method === 'restart') data = { id: 's2', shell: 'pwsh', cwd: 'C:/w', mode }
    if (method === 'restart' && options.restartNotFound === true) {
      return {
        json: async () => ({ ok: false, error: { code: 'not-found', message: 'unknown session' } }),
      }
    }
    return { json: async () => ({ ok: true, data }) }
  }

  class FakeEventSource {
    constructor(url) {
      this.url = url
      this.closed = false
      eventSources.push(this)
    }
    close() { this.closed = true }
  }

  const previousEventSource = globalThis.EventSource
  const previousChunks = globalThis.__dshChunks__
  globalThis.EventSource = FakeEventSource
  globalThis.__dshChunks__ = {
    'dsh-workbay-terminal:xterm': (env) => {
      chunkEnv = env
      return {
        css: '.xterm{color:red}',
        createTerminal(options) {
          handleOptions = options
          const handle = {
            writes: [],
            disposed: false,
            focusCalls: 0,
            write(text) { handle.writes.push(String(text)) },
            writeln(text) { handle.writes.push(String(text) + '\n') },
            reset() { handle.writes.push('<reset>') },
            dispose() { handle.disposed = true },
            focus() { handle.focusCalls += 1 },
            fit() {},
            get cols() { return 80 },
            get rows() { return 24 },
            bufferText() { return handle.writes.join('') },
            getSelection() { return '' },
          }
          handles.push(handle)
          return handle
        },
      }
    },
  }

  let local = null
  try {
    local = boot({ react: () => runtime.React, fetch: fakeFetch })
  } catch (error) {
    globalThis.EventSource = previousEventSource
    if (previousChunks === undefined) delete globalThis.__dshChunks__
    else globalThis.__dshChunks__ = previousChunks
    throw error
  }
  const localApi = local.testApi
  const t = (key, values) => {
    const dict = localApi.dictionaries.en
    const template = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key
    return String(template).replace(/\{(\w+)\}/g, (match, name) => (
      values !== undefined && values[name] !== undefined ? String(values[name]) : match
    ))
  }

  function mount(extra) {
    const base = {
      t,
      tabKey: 'tab-1',
      root: 'C:/w',
      active: true,
      theme: localApi.themeFromVars(undefined),
      onStatus: (key, patch) => statuses.push(patch),
      onTitle: () => {},
    }
    runtime.mount(localApi.components.TerminalTab, Object.assign(base, extra === undefined ? {} : extra))
  }

  function cleanup() {
    runtime.unmount()
    globalThis.EventSource = previousEventSource
    if (previousChunks === undefined) delete globalThis.__dshChunks__
    else globalThis.__dshChunks__ = previousChunks
  }

  return {
    runtime,
    api: localApi,
    fetchCalls,
    eventSources,
    handles,
    statuses,
    mount,
    cleanup,
    get chunkEnv() { return chunkEnv },
    get handleOptions() { return handleOptions },
    text: () => renderText(runtime.tree()),
    buttons: () => findButtons(runtime.tree()),
  }
}

/* ---- page-level world (restore / persistence / close) ---- */

function rawNodes(node, out) {
  const found = out === undefined ? [] : out
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) rawNodes(child, found)
    return found
  }
  found.push(node)
  for (const child of node.children || []) rawNodes(child, found)
  return found
}

function makePageWorld(options) {
  const opts = options === undefined ? {} : options
  const runtime = createHookRuntime()
  const fetchCalls = []
  const eventSources = []
  const sessions = Array.isArray(opts.sessions) ? opts.sessions : []

  const fakeFetch = async (url, request) => {
    const method = String(url).split('/api/')[1] || ''
    let payload = {}
    try { payload = JSON.parse(request.body) } catch (error) { void error }
    fetchCalls.push({ method, payload })
    let data = { ok: true }
    if (method === 'list') {
      data = {
        sessions: sessions.map((session) => ({
          id: session.id,
          cwd: session.cwd,
          startedAt: session.startedAt === undefined ? 1 : session.startedAt,
          mode: session.mode === 'pty' ? 'pty' : 'command',
        })),
      }
    } else if (method === 'start') {
      data = { id: 'started-' + String(fetchCalls.length), shell: 'pwsh', cwd: payload.root, mode: 'command' }
    } else if (method === 'restart') {
      data = { id: 'restarted-' + String(fetchCalls.length), shell: 'pwsh', cwd: 'C:/w', mode: 'pty' }
    }
    return { json: async () => ({ ok: true, data }) }
  }

  class FakeEventSource {
    constructor(url) {
      this.url = url
      this.closed = false
      eventSources.push(this)
    }
    close() { this.closed = true }
  }

  const previousEventSource = globalThis.EventSource
  const previousChunks = globalThis.__dshChunks__
  globalThis.EventSource = FakeEventSource
  globalThis.__dshChunks__ = {
    'dsh-workbay-terminal:xterm': () => ({
      css: '.xterm{color:red}',
      createTerminal() {
        const handle = {
          writes: [],
          disposed: false,
          write(text) { handle.writes.push(String(text)) },
          writeln(text) { handle.writes.push(String(text) + '\n') },
          reset() { handle.writes.push('<reset>') },
          dispose() { handle.disposed = true },
          focus() {},
          fit() {},
          get cols() { return 80 },
          get rows() { return 24 },
          getSelection() { return '' },
        }
        return handle
      },
    }),
  }

  let local = null
  try {
    local = boot({
      react: () => runtime.React,
      fetch: fakeFetch,
      storage: opts.storage === undefined ? {} : opts.storage,
    })
  } catch (error) {
    globalThis.EventSource = previousEventSource
    if (previousChunks === undefined) delete globalThis.__dshChunks__
    else globalThis.__dshChunks__ = previousChunks
    throw error
  }
  const localApi = local.testApi
  const dict = localApi.dictionaries.en
  const t = (key, values) => {
    const template = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key
    return String(template).replace(/\{(\w+)\}/g, (match, name) => (
      values !== undefined && values[name] !== undefined ? String(values[name]) : match
    ))
  }

  return {
    runtime,
    api: localApi,
    fetchCalls,
    eventSources,
    t,
    mount() {
      runtime.mount(localApi.components.Page, { t })
      return runtime.tree()
    },
    unmount() { runtime.unmount() },
    dispose() {
      runtime.unmount()
      globalThis.EventSource = previousEventSource
      if (previousChunks === undefined) delete globalThis.__dshChunks__
      else globalThis.__dshChunks__ = previousChunks
    },
    text: () => renderText(runtime.tree()),
    storageGet(key) { return local.window.localStorage.getItem(key) },
    elements(type) {
      return rawNodes(runtime.tree()).filter((node) => node.type === type)
    },
    terminalTabs() {
      return this.elements(localApi.components.TerminalTab)
    },
    tabBar() {
      const bars = this.elements(localApi.components.TabBar)
      return bars.length === 0 ? null : bars[0]
    },
  }
}

test('command-mode session engine: chunk → start → echo → submit → exit → restart → teardown', { timeout: 15000 }, async () => {
  const world = makeSessionWorld('command')
  world.mount()
  await sleep(40)

  assert.equal(world.chunkEnv.modules.react, world.runtime.React)
  assert.equal(world.eventSources.length, 1)
  assert.ok(world.eventSources[0].url.includes('/dsh-workbay-terminal/events?id=s1'))
  const startCall = world.fetchCalls.find((call) => call.method === 'start')
  assert.deepEqual(startCall.payload, { root: 'C:/w', cols: 80, rows: 24 })
  assert.equal(world.handleOptions.container.tag, 'div')
  assert.ok(world.statuses.some((patch) => patch.phase === 'connecting'))

  const stream = world.eventSources[0]
  const handle = world.handles[0]
  stream.onmessage({ data: JSON.stringify({ type: 'hello', id: 's1', mode: 'command', shell: 'pwsh', cwd: 'C:/w' }) })
  await sleep(20)
  assert.ok(handle.writes.join('').includes('$ '))
  assert.ok(world.statuses.some((patch) => patch.phase === 'running' && patch.mode === 'command'))

  const data = world.handleOptions.onData
  data('e'); data('c'); data('h'); data('o')
  await sleep(20)
  assert.ok(handle.writes.join('').includes('$ echo'))
  assert.equal(world.fetchCalls.filter((call) => call.method === 'input').length, 0, 'no input before Enter')
  data('\r')
  await sleep(30)
  const inputCall = world.fetchCalls.filter((call) => call.method === 'input').pop()
  assert.equal(inputCall.payload.id, 's1')
  assert.equal(inputCall.payload.data, 'echo\n')

  stream.onmessage({ data: JSON.stringify({ type: 'out', data: 'OUT\r\n' }) })
  await sleep(180)
  assert.ok(handle.writes.join('').includes('OUT\r\n'))
  assert.equal(handle.writes[handle.writes.length - 1], '$ ', 'prompt is redrawn after a quiet output burst')

  stream.onmessage({ data: JSON.stringify({ type: 'exit', code: 0 }) })
  await sleep(20)
  assert.ok(handle.writes.join('').includes('[exited with code 0]'))
  assert.ok(world.text().includes('Restart'))
  const restart = world.buttons().find((button) => renderText(button).includes('Restart'))
  assert.ok(restart !== undefined)
  restart.props.onClick()
  await sleep(30)
  assert.ok(world.fetchCalls.some((call) => call.method === 'restart' && call.payload.id === 's1'))
  assert.equal(world.eventSources.length, 2)
  assert.ok(world.eventSources[1].url.includes('id=s2'))

  world.cleanup()
  await sleep(30)
  assert.equal(handle.disposed, true)
  /* §3.1: a page switch unmounts the tab but must NOT stop the host session. */
  assert.equal(world.fetchCalls.some((call) => call.method === 'stop'), false, 'unmount must not call api/stop')
  assert.equal(world.eventSources[1].closed, true)
})

test('pty-mode session engine: raw keys, Ctrl+L, debounced + clamped resize', { timeout: 15000 }, async () => {
  const world = makeSessionWorld('pty')
  world.mount()
  await sleep(40)
  assert.ok(world.statuses.some((patch) => patch.mode === 'pty'))

  const stream = world.eventSources[0]
  const handle = world.handles[0]
  stream.onmessage({ data: JSON.stringify({ type: 'hello', id: 's1', mode: 'pty', shell: 'pwsh', cwd: 'C:/w' }) })
  await sleep(20)
  const writesBefore = handle.writes.length

  const data = world.handleOptions.onData
  data('a')
  await sleep(20)
  const firstInput = world.fetchCalls.filter((call) => call.method === 'input').pop()
  assert.equal(firstInput.payload.data, 'a', 'PTY input is forwarded verbatim')
  assert.equal(handle.writes.length, writesBefore, 'no local echo in pty mode')

  data('\u000c')
  await sleep(20)
  assert.equal(world.fetchCalls.filter((call) => call.method === 'input').pop().payload.data, '\u000c')

  const onResize = world.handleOptions.onResize
  onResize(120, 40)
  await sleep(260)
  let resize = world.fetchCalls.filter((call) => call.method === 'resize').pop()
  assert.equal(resize.payload.cols, 120)
  assert.equal(resize.payload.rows, 40)
  onResize(1, 1)
  await sleep(260)
  resize = world.fetchCalls.filter((call) => call.method === 'resize').pop()
  assert.equal(resize.payload.cols, world.api.MIN_COLS)
  assert.equal(resize.payload.rows, world.api.MIN_ROWS)

  stream.onmessage({ data: JSON.stringify({ type: 'out', data: 'hello pty' }) })
  await sleep(20)
  assert.ok(handle.writes.join('').endsWith('hello pty'))

  world.cleanup()
  await sleep(30)
  assert.equal(handle.disposed, true)
  assert.equal(world.fetchCalls.some((call) => call.method === 'stop'), false, 'unmount must not call api/stop')
})

/* ============================== tab persistence §3.1 ============================== */

const ROOT_KEY = 'dsh-workbay.root.v1'

function savedTab(tabId, extra) {
  return Object.assign({
    tabId,
    title: 'Tab ' + tabId,
    root: 'C:/w',
    sessionId: '',
    cwd: 'C:/w',
    mode: 'command',
  }, extra === undefined ? {} : extra)
}

test('tab store encodes the v2 shape and decodes it tolerantly', () => {
  const first = api.createTab('tab-a', 'Alpha', 'C:/w')
  first.sessionId = 's1'
  first.cwd = 'C:/w/sub'
  first.mode = 'pty'
  const second = api.createTab('tab-b', '', 'D:/other')
  second.mode = 'weird'

  const encoded = api.encodeTabStore([first, second, { key: '' }, null])
  assert.equal(encoded.version, api.TAB_STORE_VERSION)
  assert.equal(encoded.tabs.length, 2)
  assert.deepEqual(Object.keys(encoded.tabs[0]).sort(), ['cwd', 'mode', 'root', 'sessionId', 'tabId', 'title'])
  assert.equal(encoded.tabs[0].tabId, 'tab-a')
  assert.equal(encoded.tabs[0].sessionId, 's1')
  assert.equal(encoded.tabs[0].mode, 'pty')
  assert.equal(encoded.tabs[1].title, 'tab-b', 'an empty title falls back to the tab id')
  assert.equal(encoded.tabs[1].mode, 'command', 'an unknown mode degrades to command')

  const decoded = api.decodeTabStore(JSON.stringify(encoded))
  assert.deepEqual(decoded, encoded, 'valid stores round-trip unchanged')

  assert.deepEqual(api.decodeTabStore('not json').tabs, [])
  assert.deepEqual(api.decodeTabStore('').tabs, [])
  assert.deepEqual(api.decodeTabStore(JSON.stringify({ version: 1, tabs: [savedTab('t')] })).tabs, [])
  assert.deepEqual(api.decodeTabStore(JSON.stringify({ version: 2, tabs: 'nope' })).tabs, [])

  const messy = api.decodeTabStore(JSON.stringify({
    version: 2,
    tabs: [
      null,
      { tabId: 't1', title: '  A\nB  ', sessionId: ' s1 ', mode: 'pty', cwd: 'C:/x' },
      { tabId: 't1', title: 'duplicate id' },
      { tabId: 't2', mode: 'weird', title: 'x'.repeat(120) },
      { tabId: '' },
      'junk',
    ],
  }))
  assert.equal(messy.tabs.length, 2, 'duplicate ids and junk entries are dropped')
  assert.equal(messy.tabs[0].title, 'A B')
  assert.equal(messy.tabs[0].sessionId, 's1')
  assert.equal(messy.tabs[1].mode, 'command')
  assert.equal(messy.tabs[1].title.length, 64)
})

test('the debounced writer persists only the latest change and flushes on demand', () => {
  const writes = []
  let scheduled = null
  const writer = api.createDebouncedWriter({
    write: (value) => writes.push(value),
    delay: 300,
    setTimer: (fn) => { scheduled = fn; return 1 },
    clearTimer: () => { scheduled = null },
  })
  writer.schedule(['a'])
  writer.schedule(['a', 'b'])
  assert.equal(writes.length, 0, 'nothing is written before the debounce fires')
  assert.equal(typeof scheduled, 'function')
  scheduled()
  assert.deepEqual(writes, [['a', 'b']], 'the merged latest value is written once')

  writer.schedule(['c'])
  writer.flush()
  assert.deepEqual(writes[writes.length - 1], ['c'])
  assert.equal(writer.hasPending(), false)

  writer.schedule(['d'])
  writer.cancel()
  assert.equal(writer.hasPending(), false)
  assert.equal(writes.length, 2)
})

test('the restore planner attaches, restarts, exits and enforces the cap', () => {
  const saved = [
    savedTab('t1', { sessionId: 's1', mode: 'pty', cwd: 'C:/w/a' }),
    savedTab('t2', { sessionId: 'gone' }),
    savedTab('t3', { sessionId: '' }),
    savedTab('t4', { sessionId: 's2' }),
    savedTab('t5', { sessionId: 's3' }),
  ]
  const live = [
    { id: 's1', cwd: 'C:/w/a' },
    { id: 's2', cwd: 'C:/w' },
    { id: 's3', cwd: 'C:/w' },
    { id: 'extra', cwd: 'C:/other' },
  ]
  const plan = api.planRestore(saved, live, 4)
  assert.equal(plan.attachedCount, 2)
  assert.deepEqual(plan.tabs.map((entry) => entry.action), ['attach', 'restart', 'restart', 'attach', 'exit'])
  assert.equal(plan.tabs[0].session.id, 's1')
  assert.equal(plan.tabs[1].reason, 'gone')
  assert.equal(plan.tabs[2].reason, 'no-session')
  assert.equal(plan.tabs[3].session.id, 's2')
  assert.equal(plan.tabs[4].reason, 'cap')
  assert.equal(plan.cap, 4)

  const duplicate = api.planRestore(
    [savedTab('a', { sessionId: 's1' }), savedTab('b', { sessionId: 's1' })],
    [{ id: 's1' }],
    8,
  )
  assert.deepEqual(duplicate.tabs.map((entry) => entry.action), ['attach', 'exit'])
  assert.equal(duplicate.tabs[1].reason, 'duplicate')
  assert.equal(duplicate.tabs[1].entry.sessionId, '', 'a duplicate claim cannot reattach the same session')
  assert.equal(duplicate.attachedCount, 1)

  const noCap = api.planRestore([savedTab('t1', { sessionId: 's1' })], [{ id: 's1' }], undefined)
  assert.equal(noCap.cap, api.MAX_TABS)
  assert.equal(api.planRestore([], [], 8).attachedCount, 0)
})

test('Page restores saved tabs by reattaching live sessions (and never starts new ones)', async () => {
  const store = {
    version: 2,
    tabs: [
      savedTab('t1', { title: 'One', sessionId: 's1', cwd: 'C:/w/a', mode: 'pty' }),
      savedTab('t2', { title: 'Two', sessionId: 'gone' }),
    ],
  }
  const world = makePageWorld({
    storage: { [ROOT_KEY]: 'C:/w', [api.TAB_STORE_KEY]: JSON.stringify(store) },
    sessions: [{ id: 's1', cwd: 'C:/w/a', mode: 'pty' }],
  })
  try {
    world.mount()
    await sleep(80)
    assert.equal(world.fetchCalls.filter((call) => call.method === 'list').length, 1, 'api/list drives the restore')
    assert.equal(world.fetchCalls.some((call) => call.method === 'start'), false, 'restore must not start sessions')

    const tabs = world.terminalTabs()
    assert.equal(tabs.length, 2)
    assert.equal(tabs[0].props.restored, true)
    assert.equal(tabs[0].props.restoreSession.id, 's1')
    assert.equal(tabs[0].props.restoreSession.mode, 'pty')
    assert.equal(tabs[1].props.restored, false)
    assert.equal(tabs[1].props.dormant, true, 'a vanished tab waits for Restart instead of auto-starting')
    assert.equal(tabs[1].props.storedSessionId, 'gone')
    assert.ok(String(tabs[1].props.restoreNotice).includes('gone'), 'a vanished tab explains itself')
    assert.ok(world.text().includes('Restored 1 session(s)'), 'the status bar reports the restored count')

    world.unmount()
    assert.equal(world.fetchCalls.some((call) => call.method === 'stop'), false, 'page switch must not stop sessions')
    const persisted = api.decodeTabStore(world.storageGet(api.TAB_STORE_KEY))
    assert.equal(persisted.tabs.length, 2)
    assert.equal(persisted.tabs[0].sessionId, 's1')
    assert.equal(persisted.tabs[0].mode, 'pty')
  } finally {
    world.dispose()
  }
})

test('a remount after a page switch reattaches the same sessions instead of starting new ones', async () => {
  const first = makePageWorld({
    storage: {
      [ROOT_KEY]: 'C:/w',
      [api.TAB_STORE_KEY]: JSON.stringify({ version: 2, tabs: [savedTab('t1', { sessionId: 's1', mode: 'pty' })] }),
    },
    sessions: [{ id: 's1', cwd: 'C:/w', mode: 'pty' }],
  })
  let persisted = ''
  try {
    first.mount()
    await sleep(60)
    assert.equal(first.terminalTabs().length, 1)
    first.unmount()
    persisted = first.storageGet(api.TAB_STORE_KEY)
  } finally {
    first.dispose()
  }

  const second = makePageWorld({
    storage: { [ROOT_KEY]: 'C:/w', [api.TAB_STORE_KEY]: persisted },
    sessions: [{ id: 's1', cwd: 'C:/w', mode: 'pty' }],
  })
  try {
    second.mount()
    await sleep(60)
    assert.equal(second.fetchCalls.filter((call) => call.method === 'list').length, 1)
    assert.equal(second.fetchCalls.some((call) => call.method === 'start'), false)
    assert.equal(second.fetchCalls.some((call) => call.method === 'stop'), false)
    const tabs = second.terminalTabs()
    assert.equal(tabs.length, 1)
    assert.equal(tabs[0].props.restoreSession.id, 's1')
  } finally {
    second.dispose()
  }
})

test('an explicit tab close stops the session and removes it from storage', async () => {
  const world = makePageWorld({
    storage: {
      [ROOT_KEY]: 'C:/w',
      [api.TAB_STORE_KEY]: JSON.stringify({ version: 2, tabs: [savedTab('t1', { sessionId: 's1' })] }),
    },
    sessions: [{ id: 's1', cwd: 'C:/w', mode: 'command' }],
  })
  try {
    world.mount()
    await sleep(60)
    const bar = world.tabBar()
    assert.ok(bar !== null)
    bar.props.onClose('t1')
    await sleep(40)
    assert.ok(world.fetchCalls.some((call) => call.method === 'stop' && call.payload.id === 's1'), 'close stops the session')
    world.unmount()
    const persisted = api.decodeTabStore(world.storageGet(api.TAB_STORE_KEY))
    assert.equal(persisted.tabs.length, 0)
  } finally {
    world.dispose()
  }
})

test('the + button refuses to exceed the tab cap with a localized hint', async () => {
  const tabs = []
  const sessions = []
  for (let index = 0; index < api.MAX_TABS; index += 1) {
    tabs.push(savedTab('t' + String(index), { sessionId: 's' + String(index) }))
    sessions.push({ id: 's' + String(index), cwd: 'C:/w', mode: 'command' })
  }
  const world = makePageWorld({
    storage: { [ROOT_KEY]: 'C:/w', [api.TAB_STORE_KEY]: JSON.stringify({ version: 2, tabs }) },
    sessions,
  })
  try {
    world.mount()
    await sleep(80)
    assert.equal(world.terminalTabs().length, api.MAX_TABS)
    const bar = world.tabBar()
    bar.props.onNew()
    await sleep(30)
    assert.ok(world.text().includes('At most ' + String(api.MAX_TABS)), 'the cap hint is localized and shown')
    assert.equal(world.terminalTabs().length, api.MAX_TABS, 'no tab is added beyond the cap')
    assert.equal(world.fetchCalls.some((call) => call.method === 'start'), false)
  } finally {
    world.dispose()
  }
})

test('TerminalTab reattaches a restored session instead of calling api/start', { timeout: 15000 }, async () => {
  const world = makeSessionWorld('pty')
  try {
    world.mount({
      restored: true,
      restoreSession: { id: 's9', cwd: 'C:/r', mode: 'pty' },
      restartable: true,
      restoreNotice: '',
    })
    await sleep(40)
    assert.equal(world.fetchCalls.some((call) => call.method === 'start'), false, 'a restored tab must not start a session')
    assert.equal(world.eventSources.length, 1)
    assert.ok(world.eventSources[0].url.includes('/dsh-workbay-terminal/events?id=s9'))
    assert.equal(world.handleOptions.container.tag, 'div')

    const handle = world.handles[0]
    world.eventSources[0].onmessage({
      data: JSON.stringify({ type: 'hello', id: 's9', mode: 'pty', cwd: 'C:/host-cwd', shell: 'pwsh' }),
    })
    await sleep(20)
    assert.ok(handle.writes.join('').includes('Session restored'), 'the terminal says the session was restored')
    assert.ok(world.statuses.some((patch) => patch.phase === 'running' && patch.sessionId === 's9'))
    assert.ok(world.statuses.some((patch) => patch.cwd === 'C:/host-cwd'), 'hello cwd is validated/adopted over the stored value')
    assert.ok(world.statuses.some((patch) => patch.mode === 'pty'))
  } finally {
    world.cleanup()
    await sleep(30)
  }
  assert.equal(world.fetchCalls.some((call) => call.method === 'stop'), false, 'unmount still must not stop the session')
})

test('a vanished restored tab waits for Restart, then falls back to a fresh session on 404', { timeout: 15000 }, async () => {
  const world = makeSessionWorld('command', { restartNotFound: true })
  try {
    world.mount({
      dormant: true,
      restored: false,
      storedSessionId: 'gone',
      storedMode: 'command',
      restartable: true,
      restoreNotice: 'The previous session is gone',
    })
    await sleep(40)
    assert.equal(world.fetchCalls.some((call) => call.method === 'start'), false, 'a dormant tab must not auto-start')
    assert.equal(world.fetchCalls.some((call) => call.method === 'restart'), false)
    assert.equal(world.eventSources.length, 0, 'no stream before the user restarts')
    assert.ok(world.text().includes('The previous session is gone'))

    const restart = world.buttons().find((button) => renderText(button).includes('Restart'))
    assert.ok(restart !== undefined, 'the exit bar offers Restart')
    restart.props.onClick()
    await sleep(60)
    assert.ok(
      world.fetchCalls.some((call) => call.method === 'restart' && call.payload.id === 'gone'),
      'Restart first tries api/restart with the stored session id',
    )
    assert.ok(
      world.fetchCalls.some((call) => call.method === 'start' && call.payload.root === 'C:/w'),
      'api/restart 404 falls back to a fresh api/start in the same root: ' + JSON.stringify(world.fetchCalls),
    )
    assert.equal(world.eventSources.length, 1)
  } finally {
    world.cleanup()
    await sleep(30)
  }
  assert.equal(world.fetchCalls.some((call) => call.method === 'stop'), false)
})

test('an empty store opens one fresh tab when a root exists, and none without a root', async () => {
  const withRoot = makePageWorld({ storage: { [ROOT_KEY]: 'C:/w' } })
  try {
    withRoot.mount()
    await sleep(80)
    assert.equal(withRoot.fetchCalls.filter((call) => call.method === 'list').length, 1)
    const tabs = withRoot.terminalTabs()
    assert.equal(tabs.length, 1, 'a fresh tab is opened once the restore finds nothing')
    assert.equal(tabs[0].props.restoreSession, null)
    assert.equal(tabs[0].props.dormant, false)
    await sleep(20)
    assert.equal(withRoot.terminalTabs().length, 1, 'the auto-open must not race into a second tab')
  } finally {
    withRoot.dispose()
  }

  const withoutRoot = makePageWorld({ storage: {} })
  try {
    withoutRoot.mount()
    await sleep(80)
    assert.equal(withoutRoot.terminalTabs().length, 0)
    assert.ok(withoutRoot.text().includes('No workspace selected yet'))
  } finally {
    withoutRoot.dispose()
  }
})

test('saved tabs survive a cleared workspace root (each tab keeps its own root)', async () => {
  const world = makePageWorld({
    /* No ROOT_KEY: the Files page has cleared the workspace, but the saved
       sessions still exist and must come back. */
    storage: {
      [api.TAB_STORE_KEY]: JSON.stringify({
        version: 2,
        tabs: [savedTab('t1', { sessionId: 's1', root: 'C:/old', cwd: 'C:/old', mode: 'pty' })],
      }),
    },
    sessions: [{ id: 's1', cwd: 'C:/old', mode: 'pty' }],
  })
  try {
    world.mount()
    await sleep(80)
    assert.equal(world.text().includes('No workspace selected yet'), false, 'restored tabs are shown even without a current root')
    const tabs = world.terminalTabs()
    assert.equal(tabs.length, 1)
    assert.equal(tabs[0].props.root, 'C:/old', 'the tab keeps its own root')
    assert.equal(tabs[0].props.restoreSession.id, 's1')
  } finally {
    world.dispose()
  }
})

/* ============================== i18n / static ============================== */

test('zh/en dictionaries cover exactly the same keys', () => {
  const en = Object.keys(api.dictionaries.en).sort()
  const zh = Object.keys(api.dictionaries.zh).sort()
  assert.deepEqual(zh, en)
})

test('every literal t() key used in the bundle exists in both dictionaries', () => {
  const used = new Set()
  const pattern = /\bt\('([A-Za-z0-9._-]+)'/g
  let match = pattern.exec(source)
  while (match !== null) {
    used.add(match[1])
    match = pattern.exec(source)
  }
  assert.ok(used.size > 20, 'expected the page to use the dictionaries extensively')
  const missingEn = []
  const missingZh = []
  for (const key of used) {
    if (!Object.prototype.hasOwnProperty.call(api.dictionaries.en, key)) missingEn.push(key)
    if (!Object.prototype.hasOwnProperty.call(api.dictionaries.zh, key)) missingZh.push(key)
  }
  assert.deepEqual(missingEn, [])
  assert.deepEqual(missingZh, [])
  for (const key of ['status.starting', 'status.connecting', 'status.running', 'status.exited', 'status.error', 'status.idle']) {
    assert.ok(Object.prototype.hasOwnProperty.call(api.dictionaries.en, key), key)
  }
})

test('the page bundle is plain browser JavaScript: no JSX, no imports', () => {
  assert.equal(/^\s*import\s/m.test(source), false)
  assert.equal(/^\s*export\s/m.test(source), false)
  assert.equal(source.includes('<div'), false)
})

test('node --check accepts the page bundle and the xterm chunk source', () => {
  for (const file of [clientPath, chunkSourcePath]) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
    assert.equal(result.status, 0, file + ': ' + result.stderr)
  }
})
