/**
 * Client-bundle smoke test: the browser half must be loadable, register exactly
 * one tab through the module loader contract, and render its panel with stubbed
 * React/DOM + a fake better-sidebar service.
 *
 * Run:  node --test tests/client.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientPath = path.join(here, '..', 'src', 'client.js')
const source = readFileSync(clientPath, 'utf8')

/** A minimal React stand-in: createElement builds a tree we can inspect. */
function makeReact() {
  const React = {
    Fragment: 'FRAGMENT',
    createElement(type, props, ...children) {
      return { type, props: props === null || props === undefined ? {} : props, children: children.flat() }
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
  return React
}

/** Collect every element in a tree, depth-first, executing function components. */
function walk(node, visit) {
  if (node === null || node === undefined || typeof node === 'boolean') return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (typeof node !== 'object' || node.type === undefined) return
  visit(node)
  for (const child of node.children) walk(child, visit)
}

/** Render a tree by executing every function component (hooks are stubs). */
function render(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return []
  if (Array.isArray(node)) return node.flatMap((child) => render(child))
  if (typeof node === 'string' || typeof node === 'number') return [node]
  if (typeof node !== 'object' || node.type === undefined) return []
  if (typeof node.type === 'function') {
    if (node.type === 'FRAGMENT') return node.children.flatMap((child) => render(child))
    return render(node.type(node.props, node.children))
  }
  return node.children.flatMap((child) => render(child))
}

function textOf(node) {
  return render(node).filter((entry) => typeof entry === 'string' || typeof entry === 'number').join(' ')
}

/** Boot the bundle the way the DSH client module loader does. */
function boot({ betterSidebar, native, locale, dock, react, fetch }) {
  const activeLocale = locale === undefined ? 'en' : locale
  const registered = []
  const styleTags = []
  const document = {
    head: { appendChild(node) { styleTags.push(node) } },
    createElement(tag) {
      return { tag, attributes: {}, textContent: '', setAttribute(name, value) { this.attributes[name] = value }, remove() {} }
    },
    baseURI: 'http://127.0.0.1:3080/',
  }
  const window = {
    /* The workbench dock publishes its page registry on this global, and the
       plugin registers into it during apply. */
    __DSH_WORKBAY__: dock,
    __ModuleLoader__: {
      load({ id, factory }) {
        assert.equal(id, 'dsh-gitcraft')
        const React = react === undefined ? makeReact() : react()
        const require = (name) => {
          if (name === 'react') return React
          throw new Error('unexpected require: ' + name)
        }
        const mod = factory(require)
        registered.push({ id, mod, React })
      },
    },
    localStorage: { getItem() { return null }, setItem() {}, removeItem() {} },
    addEventListener() {},
    removeEventListener() {},
  }
  const effects = []
  const injections = []
  const ctx = {
    effect(fn, label) {
      const dispose = fn()
      effects.push({ label, dispose })
      return () => { if (typeof dispose === 'function') dispose() }
    },
    get(name) {
      if (name === 'betterSidebar') return betterSidebar
      if (name === 'locale') return { register() {}, getSnapshot() { return { active: activeLocale } }, subscribe() { return () => {} } }
      if (name === 'sidebarRightTabs') return native === undefined ? undefined : native.tabs
      if (name === 'slots') return native === undefined ? undefined : native.slots
      return undefined
    },
    inject(names, callback) {
      injections.push(names)
      const available = names.every((name) => ctx.get(name) !== undefined)
      if (!available) {
        return { dispose() {} }
      }
      const fiber = { disposed: false, dispose() { this.disposed = true } }
      callback({
        ...ctx,
        effect: ctx.effect,
        get: ctx.get,
      })
      return fiber
    },
  }
  // eslint-disable-next-line no-new-func
  const factoryFn = new Function('window', 'document', 'navigator', 'fetch', source)
  const noNetwork = async () => { throw new Error('no network in tests') }
  factoryFn(window, document, { language: 'en-US' }, fetch === undefined ? noNetwork : fetch)
  const entry = registered[0]
  entry.mod.apply(ctx)
  return { registered, effects, injections, styleTags, ctx, React: entry.React }
}

test('the bundle registers itself through the module loader contract', () => {
  const booted = boot({ betterSidebar: undefined, native: undefined })
  assert.equal(booted.registered.length, 1)
  assert.equal(booted.registered[0].id, 'dsh-gitcraft')
  assert.equal(typeof booted.registered[0].mod.apply, 'function')
})

test('it injects the stylesheet and removes it on dispose', () => {
  const booted = boot({ betterSidebar: undefined, native: undefined })
  assert.ok(booted.styleTags.length >= 1, 'a style tag was appended')
  const style = booted.styleTags[0]
  assert.match(style.textContent, /\.gwc-root/)
  assert.match(style.textContent, /--dsw-alias-bg-base/)
  const styleEffect = booted.effects.find((entry) => String(entry.label).includes('panel styles'))
  assert.ok(styleEffect !== undefined)
})

test('it registers a PAGE with the workbench dock and no better-sidebar tab', () => {
  const dock = { pages: [], registerPage(page) { this.pages.push(page); return () => {} }, list() { return this.pages }, subscribe() { return () => {} } }
  const registered = []
  const betterSidebar = {
    registerTab(descriptor) { registered.push(descriptor); return () => {} },
  }
  const booted = boot({ betterSidebar, native: undefined, dock })
  void booted
  /* The plugin must announce itself to the dock … */
  assert.equal(dock.pages.length, 1, 'one page registered with the dock')
  /* … and must NOT touch better-sidebar's tab strip. */
  assert.equal(registered.length, 0, 'no better-sidebar tab registered')
  const page = dock.pages[0]
  assert.equal(page.id, 'gitcraft')
  assert.equal(typeof page.component, 'function')
  assert.equal(typeof page.title, 'string')
})

test('it registers nothing with the native right-sidebar registry either', () => {
  const dock = { pages: [], registerPage(page) { this.pages.push(page); return () => {} }, list() { return this.pages }, subscribe() { return () => {} } }
  const tabsRegistered = []
  const native = {
    tabs: { register(d) { tabsRegistered.push(d); return () => {} } },
    slots: { inject(_n, cb) { return cb() }, register() { return () => {} } },
  }
  boot({ betterSidebar: undefined, native, dock })
  assert.equal(tabsRegistered.length, 0, 'the dock owns the sidebar seat, not this plugin')
})

test('the workbench page renders the panel chrome in English', () => {
  const dock = { pages: [], registerPage(page) { this.pages.push(page); return () => {} }, list() { return this.pages }, subscribe() { return () => {} } }
  const booted = boot({ betterSidebar: undefined, native: undefined, dock })
  const page = dock.pages[0]
  const tree = page.component({
    ctx: booted.ctx,
    sessionId: 's1',
    cwd: 'D:\\repo',
    t: (key) => key,
  })
  assert.ok(tree !== null && tree !== undefined, 'the panel rendered')
  const text = textOf(tree)
  assert.match(text, /Changes|变更/)
  assert.match(text, /History|历史/)
  assert.match(text, /Branches|分支/)
  assert.match(text, /Stash|贮藏/)
})

test('the workbench page renders in Chinese when the locale says so', () => {
  const dock = { pages: [], registerPage(page) { this.pages.push(page); return () => {} }, list() { return this.pages }, subscribe() { return () => {} } }
  const booted = boot({ betterSidebar: undefined, native: undefined, dock, locale: 'zh-CN' })
  const page = dock.pages[0]
  const tree = page.component({
    ctx: booted.ctx,
    sessionId: 's1',
    cwd: 'D:\\repo',
    t: (key) => key,
  })
  const text = textOf(tree)
  assert.match(text, /变更/)
  assert.match(text, /历史/)
  assert.match(text, /分支/)
})
test('the API base is mount-relative so a reverse proxy prefix still resolves', () => {
  assert.match(source, /const API_BASE = 'dsh-gitcraft\/api'/)
  assert.doesNotMatch(source, /const API_BASE = '\/dsh-gitcraft/)
  assert.match(source, /new URL\(API_BASE \+ '\/', document\.baseURI\)/)
})

test('every mutating call goes through the shared run() guard', () => {
  for (const method of ['stage', 'unstage', 'discard', 'commit', 'merge', 'rebase', 'cherryPick', 'revert', 'reset', 'stashPush', 'tagCreate', 'branchDelete']) {
    assert.match(source, new RegExp("call\\('" + method + "'"), 'client references ' + method)
  }
})

test('the repo picker wires the workspace scan and browse endpoints', () => {
  assert.match(source, /call\('workspace'/)
  assert.match(source, /call\('browse'/)
  assert.match(source, /function RepoPicker/)
  // the picker must be reachable from the header, not only from an empty state
  assert.match(source, /gwc-repoChip/)
  assert.match(source, /setPickerOpen\(true\)/)
})

test('a picked repository overrides the session scope', () => {
  assert.match(source, /chosenRepo/)
  assert.ok(source.includes('typeof chosenRepo ===') && source.includes('? chosenRepo : scopeRepo'), 'chosen repo overrides the scope root')
  assert.match(source, /storeRepo\(/)
})
test('no render value is read before its own initialization (TDZ guard)', () => {
  /*
   * Two real crashes came from this: `historyLayout` was read above its
   * definition, and `diffInnerRef` was used inside JSX above its definition —
   * the latter only threw once a file was selected, so the panel looked fine
   * until you clicked one.
   *
   * Only hook-created values and the view/pane consts built from them take part
   * in render order; scanning every identifier flags ordinary words like
   * `style` or `header` that appear in JSX long before their own declaration.
   * String literals and comments are blanked out for the same reason.
   */
  const body = source.slice(source.indexOf('function Panel(props)'))

  /* Blank strings and comments so words inside them cannot match. */
  /* Comments FIRST: an apostrophe inside a comment would otherwise open a bogus
     string that swallows real code up to the next apostrophe. */
  const scrub = (text) => text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
    .replace(/'(?:\\.|[^'\\])*'/g, (m) => ' '.repeat(m.length))
    .replace(/"(?:\\.|[^"\\])*"/g, (m) => ' '.repeat(m.length))
    .replace(/`(?:\\.|[^`\\])*`/g, (m) => ' '.repeat(m.length))

  const scrubbed = scrub(body)

  /* Declarations that matter: hooks, plus names that read as views/panes/refs. */
  const declarations = new Map()
  for (const match of scrubbed.matchAll(/^ {6}const (\w+) = /gm)) {
    const name = match[1]
    const rest = scrubbed.slice(match.index, match.index + 80)
    const isHook = / = use(State|Ref|Memo|Callback)\b/.test(rest)
    const isView = /(View|Pane|Layout|Ref|Rect|Anchor)$/.test(name)
    if (!isHook && !isView) continue
    if (!declarations.has(name)) declarations.set(name, match.index)
  }
  assert.ok(declarations.size > 5, 'found order-sensitive panel consts: ' + declarations.size)

  const offenders = []
  for (const [name, declaredAt] of declarations) {
    /* The declaration's own name sits right after "const ". */
    const ownIndex = declaredAt + 'const '.length
    const pattern = new RegExp('\\b' + name + '\\b', 'g')
    let firstUse = -1
    for (const match of scrubbed.matchAll(pattern)) {
      if (match.index === ownIndex) continue
      firstUse = match.index
      break
    }
    if (firstUse !== -1 && firstUse < declaredAt) {
      offenders.push(name + ' (used@' + firstUse + ' decl@' + declaredAt + ')')
    }
  }
  assert.deepEqual(offenders, [], 'values read before initialization: ' + offenders.join(', '))
})

test('the history view computes its graph layout before rendering rows', () => {
  const layoutAt = source.indexOf('const historyLayout = useMemo')
  const viewAt = source.indexOf('const historyView =')
  assert.ok(layoutAt !== -1 && viewAt !== -1)
  assert.ok(layoutAt < viewAt, 'historyLayout must be declared before historyView')
})
test('a commit-scoped diff always carries its rev (rev is required regression)', () => {
  /*
   * Browsing a commit's file list used to call loadDiff(path, 'commit')
   * WITHOUT a rev, and the host answered "rev is required" — a toast the user
   * saw as "gitcraft 出错了". Both call sites must pass one.
   */
  const calls = [...source.matchAll(/loadDiff\(([^)]*)\)/g)].map((m) => m[1])
  const commitCalls = calls.filter((args) => args.includes("'commit'"))
  assert.ok(commitCalls.length >= 1, 'found commit-scoped diff calls: ' + JSON.stringify(calls))
  for (const args of commitCalls) {
    const parts = args.split(',').map((part) => part.trim())
    assert.ok(parts.length >= 3, 'commit diff must pass a rev: loadDiff(' + args + ')')
    assert.ok(parts[2] !== undefined && parts[2] !== '', 'rev must not be empty: loadDiff(' + args + ')')
  }
  // The guard inside loadDiff must also refuse a rev-less commit diff.
  assert.match(source, /baseKind === 'commit' && \(typeof rev !== 'string' \|\| rev === ''\)/)
})
test('clicking a file in a commit opens its diff in the history page', () => {
  /* It used to call setNav('changes') and jump away, losing the commit being read.
     Now it sets the in-page target and loads the commit-scoped diff. */
  assert.match(source, /setHistoryFile\(filePath\)/)
  assert.match(source, /loadDiff\(filePath, 'commit', selectedCommit\)/)
  assert.equal(/onFileClick: \(filePath\) => \{\s*setNav\('changes'\)/.test(source), false,
    'history file clicks must not navigate to the changes tab')
  assert.match(source, /className: 'gwc-historyDiff'/)
})
test('a global surface can snapshot from repoRoot alone (no cwd, no sessionId)', () => {
  /*
   * The docked workbench has neither a cwd nor a sessionId — only the repository
   * the user picked. Requiring cwd/session left it stuck on "正在读取仓库…".
   */
  assert.ok(source.includes('const hasRepo = typeof repoRoot'), 'a repoRoot-only request is allowed')
  assert.match(source, /if \(!hasCwd && !hasSession && !hasRepo\)/)
  assert.ok(source.includes("hasCwd ? { cwd } : hasSession ? { sessionId } : {}"), 'payload may be repoRoot-only')
})

test('the picker validates a typed path and gates Add on it', () => {
  assert.match(source, /call\('verifyPath'/)
  assert.match(source, /canAdd = check\.info !== null && check\.info !== undefined && check\.info\.isRepo === true/)
  for (const key of ['picker.pathLabel', 'picker.typeLabel', 'picker.thisIsRepo', 'picker.invalidPath', 'picker.add']) {
    assert.ok(source.includes("'" + key + "'"), 'missing i18n key ' + key)
  }
})

test('the picker takes drive roots from the host, not from a hard-coded list', () => {
  assert.ok(source.includes('listing.drives'), 'drives come from the browse response')
  assert.ok(source.indexOf('String.fromCharCode(code)') === -1, 'no hard-coded C..Z drive loop in the client')
})

/* ========================================================================
 * Refresh behaviour (the reported "History does not refresh after pull" bug).
 *
 * The React stand-in above never runs effects, so it cannot observe a revision
 * bump. These tests mount the real Panel with a small hook runtime instead:
 * state updates re-render, effects run when their deps change, and a scripted
 * fetch answers `snapshot` / `log` / `branches` while holding `watch` open —
 * exactly the `/watch` long-poll the host exposes. A "pull" is then simulated
 * by resolving that long-poll with `changed: true` after moving HEAD.
 * ===================================================================== */

/** A tiny hook-capable React stand-in: enough for the GitCraft panel. */
function makeHookReact() {
  const runtime = {
    instances: new Map(),
    current: null,
    dirty: false,
    root: null,
    elements: [],
    textParts: [],
  }
  const sameDeps = (previous, next) => {
    if (!Array.isArray(previous) || !Array.isArray(next)) return false
    if (previous.length !== next.length) return false
    for (let index = 0; index < previous.length; index += 1) {
      if (!Object.is(previous[index], next[index])) return false
    }
    return true
  }
  const React = {
    Fragment: 'FRAGMENT',
    createElement(type, props, ...children) {
      return { type, props: props === null || props === undefined ? {} : props, children: children.flat() }
    },
    useState(initial) {
      const instance = runtime.current
      const index = instance.index++
      if (!(index in instance.hooks)) instance.hooks[index] = typeof initial === 'function' ? initial() : initial
      const setValue = (next) => {
        const previous = instance.hooks[index]
        const value = typeof next === 'function' ? next(previous) : next
        if (Object.is(value, previous)) return
        instance.hooks[index] = value
        runtime.dirty = true
      }
      return [instance.hooks[index], setValue]
    },
    useRef(initial) {
      const instance = runtime.current
      const index = instance.index++
      if (!(index in instance.hooks)) instance.hooks[index] = { current: initial }
      return instance.hooks[index]
    },
    useMemo(factory, deps) {
      const instance = runtime.current
      const index = instance.index++
      const previous = instance.hooks[index]
      if (previous !== undefined && sameDeps(previous.deps, deps)) return previous.value
      const value = factory()
      instance.hooks[index] = { value, deps }
      return value
    },
    useCallback(fn, deps) {
      const instance = runtime.current
      const index = instance.index++
      const previous = instance.hooks[index]
      if (previous !== undefined && sameDeps(previous.deps, deps)) return previous.fn
      instance.hooks[index] = { fn, deps }
      return fn
    },
    useEffect(fn, deps) {
      const instance = runtime.current
      const index = instance.index++
      const previous = instance.hooks[index]
      if (previous !== undefined && sameDeps(previous.deps, deps)) return
      instance.hooks[index] = { deps, cleanup: previous === undefined ? undefined : previous.cleanup }
      instance.pending.push({ index, fn })
    },
    memo(fn) { return fn },
  }
  runtime.React = React

  const renderNode = (node, path) => {
    if (node === null || node === undefined || typeof node === 'boolean') return
    if (typeof node === 'string' || typeof node === 'number') {
      runtime.textParts.push(String(node))
      return
    }
    if (Array.isArray(node)) {
      node.forEach((child, index) => renderNode(child, path + '.' + index))
      return
    }
    if (typeof node !== 'object' || node.type === undefined) return
    if (node.type === React.Fragment) {
      renderNode(node.children, path + '.f')
      return
    }
    if (typeof node.type === 'function') {
      const name = node.type.name === '' ? 'anonymous' : node.type.name
      const key = path + ':' + name
      let instance = runtime.instances.get(key)
      if (instance === undefined) {
        instance = { key, index: 0, hooks: [], pending: [] }
        runtime.instances.set(key, instance)
      }
      instance.index = 0
      instance.pending = []
      const previous = runtime.current
      runtime.current = instance
      let output
      try {
        output = node.type({ ...node.props, children: node.children.length === 1 ? node.children[0] : node.children })
      } finally {
        runtime.current = previous
      }
      renderNode(output, path + '>' + name)
      return
    }
    runtime.elements.push(node)
    renderNode(node.children, path)
  }

  runtime.render = () => {
    let passes = 0
    do {
      passes += 1
      if (passes > 50) throw new Error('hook runtime did not settle')
      runtime.dirty = false
      runtime.elements = []
      runtime.textParts = []
      renderNode(runtime.root, 'root')
      for (const instance of runtime.instances.values()) {
        const pending = instance.pending
        instance.pending = []
        for (const effect of pending) {
          const slot = instance.hooks[effect.index]
          if (slot !== undefined && typeof slot.cleanup === 'function') slot.cleanup()
          const cleanup = effect.fn()
          if (slot !== undefined) slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined
        }
      }
    } while (runtime.dirty)
  }

  /** Let scripted fetches / the watch loop settle, re-rendering on state changes. */
  runtime.flush = async () => {
    for (let tick = 0; tick < 30; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (runtime.dirty) runtime.render()
    }
  }
  runtime.text = () => runtime.textParts.join(' ')

  return runtime
}

/** Raw text of an element tree WITHOUT executing function components. */
function rawText(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (Array.isArray(node)) return node.map(rawText).join(' ')
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (typeof node !== 'object') return ''
  return rawText(node.children)
}

function clickNav(runtime, label) {
  const button = runtime.elements.find((element) => {
    const className = element.props.className
    return typeof element.props.onClick === 'function'
      && typeof className === 'string'
      && className.startsWith('gwc-navBtn')
      && rawText(element).includes(label)
  })
  assert.ok(button !== undefined, 'nav button for ' + label)
  button.props.onClick()
}

/**
 * Scripted host: snapshot head/subject are mutable, `log` returns the current
 * head as one commit, `watch` parks until the test resolves it ("the repository
 * changed"). No timers are used, so a pending watch promise cannot leak.
 */
function makeFixture() {
  const state = {
    head: 'a'.repeat(40),
    subject: 'before pull',
    logCalls: 0,
    branchCalls: 0,
    failLog: false,
    watchResolvers: [],
  }
  const reply = (body) => ({ status: 200, json: async () => body })
  const snapshot = () => ({
    root: 'D:\\repo',
    head: state.head,
    headShort: state.head.slice(0, 7),
    unborn: false,
    branch: 'main',
    detached: false,
    upstream: 'origin/main',
    ahead: 0,
    behind: 0,
    changes: [],
    operation: null,
    conflictedFiles: [],
    gitDir: null,
    refreshIntervalMs: 5000,
    defaultDiffView: 'unified',
    truncated: false,
  })
  const fetchStub = (url) => {
    const method = String(url).split('/').pop()
    if (method === 'snapshot') return Promise.resolve(reply({ ok: true, data: snapshot() }))
    if (method === 'watch') {
      return new Promise((resolve) => {
        state.watchResolvers.push((result) => resolve(reply({ ok: true, data: result })))
      })
    }
    if (method === 'log') {
      state.logCalls += 1
      if (state.failLog) {
        return Promise.resolve(reply({ ok: false, error: { code: 'network', message: 'transient git failure' } }))
      }
      return Promise.resolve(reply({
        ok: true,
        data: {
          commits: [{
            hash: state.head,
            short: state.head.slice(0, 7),
            subject: state.subject,
            parents: [],
            refs: [],
            authorName: 'tester',
            authorTime: 0,
          }],
          hasMore: false,
        },
      }))
    }
    if (method === 'branches') {
      state.branchCalls += 1
      return Promise.resolve(reply({ ok: true, data: { branches: [] } }))
    }
    return Promise.resolve(reply({ ok: true, data: {} }))
  }
  state.resolveWatch = (result) => {
    const resolvers = state.watchResolvers
    state.watchResolvers = []
    for (const resolve of resolvers) resolve(result)
  }
  return { state, fetch: fetchStub }
}

/** Mount the registered page with the hook runtime. */
async function mountPanel() {
  const fixture = makeFixture()
  const runtime = makeHookReact()
  const dock = { pages: [], registerPage(page) { this.pages.push(page); return () => {} }, list() { return this.pages }, subscribe() { return () => {} } }
  const booted = boot({ betterSidebar: undefined, native: undefined, dock, react: () => runtime.React, fetch: fixture.fetch })
  runtime.root = dock.pages[0].component({ ctx: booted.ctx, sessionId: 's1', cwd: 'D:\\repo' })
  runtime.render()
  await runtime.flush()
  return { fixture, runtime }
}

test('History reloads when the watched revision moves while it is active', async () => {
  const { fixture, runtime } = await mountPanel()
  /* Nothing is fetched eagerly: History is not the active view. */
  assert.equal(fixture.state.logCalls, 0, 'History must not load while inactive')

  clickNav(runtime, 'History')
  await runtime.flush()
  assert.equal(fixture.state.logCalls, 1, 'activation loads the commit list once')
  assert.match(runtime.text(), /before pull/)

  /* A pull / external commit moves HEAD; the long-poll reports it. */
  fixture.state.head = 'b'.repeat(40)
  fixture.state.subject = 'after pull'
  fixture.state.resolveWatch({ supported: true, revision: 1, changed: true, root: 'D:\\repo' })
  await runtime.flush()
  assert.equal(fixture.state.logCalls, 2, 'exactly one reload for the new revision')
  assert.match(runtime.text(), /after pull/, 'the commit list shows the new HEAD')
  assert.doesNotMatch(runtime.text(), /before pull/)

  /* The same revision reported again must NOT reload (burst coalescing). */
  fixture.state.resolveWatch({ supported: true, revision: 2, changed: true, root: 'D:\\repo' })
  await runtime.flush()
  assert.equal(fixture.state.logCalls, 2, 'a repeated revision does not reload')
})

test('an inactive History view reloads lazily on activation, and so do branches', async () => {
  const { fixture, runtime } = await mountPanel()

  fixture.state.head = 'c'.repeat(40)
  fixture.state.subject = 'pulled while on Changes'
  fixture.state.resolveWatch({ supported: true, revision: 1, changed: true, root: 'D:\\repo' })
  await runtime.flush()
  assert.equal(fixture.state.logCalls, 0, 'no eager fetch while History is inactive')
  assert.equal(fixture.state.branchCalls, 0, 'no eager fetch while Branches is inactive')

  clickNav(runtime, 'History')
  await runtime.flush()
  assert.equal(fixture.state.logCalls, 1, 'activation picks up the missed revision')
  assert.match(runtime.text(), /pulled while on Changes/)

  clickNav(runtime, 'Branches')
  await runtime.flush()
  assert.equal(fixture.state.branchCalls, 1, 'the branch/tag list refreshes on activation')
})

test('a failed History reload keeps the previous commits and shows the error', async () => {
  const { fixture, runtime } = await mountPanel()
  clickNav(runtime, 'History')
  await runtime.flush()
  assert.equal(fixture.state.logCalls, 1)
  assert.match(runtime.text(), /before pull/)

  fixture.state.failLog = true
  fixture.state.head = 'd'.repeat(40)
  fixture.state.subject = 'never rendered'
  fixture.state.resolveWatch({ supported: true, revision: 1, changed: true, root: 'D:\\repo' })
  await runtime.flush()
  assert.equal(fixture.state.logCalls, 2, 'the revision triggered a reload attempt')
  assert.match(runtime.text(), /before pull/, 'the previous list is kept on failure')
  assert.doesNotMatch(runtime.text(), /never rendered/)
  assert.match(runtime.text(), /transient git failure/, 'the existing error toast is shown')

  /* A failed revision is not retried in a loop. */
  await runtime.flush()
  assert.equal(fixture.state.logCalls, 2, 'no retry storm after a failed reload')
})

