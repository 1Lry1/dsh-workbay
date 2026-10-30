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
function boot({ betterSidebar, native, locale, dock }) {
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
        const React = makeReact()
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
  factoryFn(window, document, { language: 'en-US' }, async () => { throw new Error('no network in tests') })
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
