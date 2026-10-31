/**
 * Client-half tests for `dsh-workbay-files`.
 *
 * The browser bundle is a single `window.__ModuleLoader__.load({ id, factory })`
 * file, so these tests boot it exactly the way the DSH client loader does and
 * then pin the pure helpers the page is built from: tree flatten/sort, viewer
 * classification, markdown escaping, the dirty-state reducer, root persistence
 * and path handling. Registration against the workbench dock is covered too.
 *
 * Run:  node --test tests/client.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientPath = path.join(here, '..', 'src', 'client.js')
const source = readFileSync(clientPath, 'utf8')

/* ============================== harness ============================== */

function makeReact() {
  const Fragment = Symbol('Fragment')
  return {
    Fragment,
    createElement(type, props, ...children) {
      const normalized = props === null || props === undefined ? {} : props
      /* Real React exposes children on props too; several components use it. */
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

/**
 * Boot the bundle like the DSH module loader: provide window/document/navigator
 * and a `require` that only knows React, then capture the returned module.
 */
function boot(options) {
  const opts = options === undefined ? {} : options
  const registered = []
  const styleTags = []
  const listeners = new Map()
  const storage = new Map(Object.entries(opts.storage === undefined ? {} : opts.storage))
  const document = {
    baseURI: 'http://127.0.0.1:3080/',
    head: {
      appendChild(node) { styleTags.push(node) },
    },
    documentElement: {
      appendChild(node) { styleTags.push(node) },
    },
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
        assert.equal(spec.id, 'dsh-workbay-files')
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

/* ============================== module contract ============================== */

test('bundle exports apply and the frozen page contract helpers', () => {
  assert.equal(typeof booted.entry.mod.apply, 'function')
  assert.equal(booted.entry.mod.name, 'dsh-workbay-files')
  assert.equal(api.PAGE_ID, 'files')
  assert.equal(api.TREE_ROW_LIMIT, 400)
})

test('registers exactly one workbench page: files, order 10', () => {
  const dock = makeDock()
  const local = boot({ dock })
  local.entry.mod.apply(local.ctx)
  assert.equal(dock.pages.length, 1)
  const page = dock.pages[0]
  assert.equal(page.id, 'files')
  assert.equal(page.order, 10)
  assert.equal(page.title, 'Files')
  assert.equal(typeof page.icon, 'function')
  assert.equal(typeof page.component, 'function')

  const icon = page.icon(16)
  assert.equal(typeof icon.type, 'function', 'icon is an E(Icon) element')
  const renderedIcon = icon.type(icon.props)
  assert.equal(renderedIcon.type, 'svg')
  assert.equal(renderedIcon.props.width, 16)

  assert.equal(local.styleTags.length, 1)
  assert.equal(local.styleTags[0].attributes['data-dsh-workbay-files'], '')
  assert.equal(local.localeRegistrations.length, 1)
  assert.equal(local.localeRegistrations[0].namespace, 'dsh-workbay-files')
  assert.deepEqual(Object.keys(local.localeRegistrations[0].dictionaries).sort(), ['en', 'zh'])
  disposeBoot(local)
})

test('the registered page title follows the active locale', () => {
  const dock = makeDock()
  const local = boot({ dock, locale: 'zh-CN' })
  local.entry.mod.apply(local.ctx)
  assert.equal(dock.pages[0].title, '文件')
  assert.equal(local.localeRegistrations[0].namespace, 'dsh-workbay-files')
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
  assert.equal(dock.pages[0].id, 'files')
  disposeBoot(local)
})

/* ============================== tree ============================== */

test('sortEntries puts directories first, then natural name order', () => {
  const entries = [
    { name: 'b.txt', rel: 'b.txt', type: 'file' },
    { name: 'A', rel: 'A', type: 'dir' },
    { name: 'a10.txt', rel: 'a10.txt', type: 'file' },
    { name: 'node_modules', rel: 'node_modules', type: 'dir' },
    { name: 'a2.txt', rel: 'a2.txt', type: 'file' },
  ]
  const sorted = api.sortEntries(entries)
  assert.deepEqual(sorted.map((entry) => entry.name), ['A', 'node_modules', 'a2.txt', 'a10.txt', 'b.txt'])
  assert.deepEqual(entries.map((entry) => entry.name), ['b.txt', 'A', 'a10.txt', 'node_modules', 'a2.txt'], 'input must not be mutated')
})

test('flattenTree expands lazily, hides dotfiles by default and keeps depth', () => {
  const tree = {
    '': {
      status: 'ready',
      truncated: false,
      entries: [
        { name: '.env', rel: '.env', type: 'file' },
        { name: 'src', rel: 'src', type: 'dir' },
        { name: 'z.txt', rel: 'z.txt', type: 'file' },
      ],
    },
    src: {
      status: 'ready',
      truncated: true,
      entries: [{ name: 'index.js', rel: 'src/index.js', type: 'file' }],
    },
  }
  const rows = api.flattenTree(tree, new Set(['src']), { showHidden: false })
  assert.deepEqual(rows.map((row) => [row.kind, row.rel, row.depth, row.expanded]), [
    ['entry', 'src', 0, true],
    ['entry', 'src/index.js', 1, false],
    ['truncated', 'src', 1, undefined],
    ['entry', 'z.txt', 0, false],
  ])
  const withHidden = api.flattenTree(tree, new Set(), { showHidden: true })
  assert.ok(withHidden.some((row) => row.rel === '.env'))
  const collapsed = api.flattenTree(tree, new Set(), { showHidden: false })
  assert.deepEqual(collapsed.map((row) => row.rel), ['src', 'z.txt'], 'collapsed dirs contribute no children')
})

test('flattenTree renders loading and error pseudo rows for expanded dirs', () => {
  const base = {
    '': { status: 'ready', entries: [{ name: 'a', rel: 'a', type: 'dir' }] },
  }
  const loading = api.flattenTree(Object.assign({}, base, { a: { status: 'loading' } }), new Set(['a']), {})
  assert.equal(loading[1].kind, 'status')
  assert.equal(loading[1].status, 'loading')
  assert.equal(loading[1].depth, 1)

  const failed = api.flattenTree(Object.assign({}, base, { a: { status: 'error', error: 'boom' } }), new Set(['a']), {})
  assert.equal(failed[1].kind, 'status')
  assert.equal(failed[1].status, 'error')
  assert.equal(failed[1].message, 'boom')

  const badRoot = api.flattenTree({ '': { status: 'error', error: 'nope' } }, new Set(), {})
  assert.deepEqual(badRoot, [], 'the root loading/error state is rendered outside the flat list')
})

test('flattenTree gives every row a unique React key', () => {
  const tree = {
    '': { status: 'ready', entries: [{ name: 'a', rel: 'a', type: 'dir' }, { name: 'b', rel: 'b', type: 'file' }] },
    a: { status: 'ready', entries: [{ name: 'c', rel: 'a/c', type: 'file' }] },
  }
  const rows = api.flattenTree(tree, new Set(['a']), {})
  const keys = rows.map((row) => row.key)
  assert.equal(new Set(keys).size, keys.length)
})

/* ============================== classification ============================== */

test('classifyFile maps extensions to viewers', () => {
  const cases = {
    'photo.PNG': 'image',
    'animation.gif': 'image',
    'vector.svg': 'image',
    'manual.pdf': 'pdf',
    'index.html': 'html',
    'README.md': 'markdown',
    'notes.markdown': 'markdown',
    'data.json': 'json',
    'data.jsonc': 'json',
    'archive.zip': 'binary',
    'tool.exe': 'binary',
    'font.woff2': 'binary',
    'app.js': 'text',
    'main.py': 'text',
    'Makefile': 'unknown',
    '.gitignore': 'unknown',
    'noext': 'unknown',
  }
  for (const [name, kind] of Object.entries(cases)) {
    assert.equal(api.classifyFile(name), kind, name)
  }
})

test('languageOf covers the editor contract and falls back to text', () => {
  const cases = {
    'a.js': 'js', 'a.mjs': 'js', 'a.cjs': 'js', 'a.jsx': 'jsx',
    'a.ts': 'ts', 'a.tsx': 'tsx', 'a.json': 'json', 'a.md': 'md',
    'a.py': 'py', 'a.go': 'go', 'a.rs': 'rust', 'a.java': 'java',
    'a.c': 'c', 'a.cpp': 'cpp', 'a.h': 'h', 'a.cs': 'cs',
    'a.html': 'html', 'a.css': 'css', 'a.xml': 'xml',
    'a.yaml': 'yaml', 'a.yml': 'yml', 'a.sql': 'sql',
    'a.sh': 'sh', 'a.ps1': 'ps1', 'LICENSE': 'text', 'a.weird': 'text',
  }
  for (const [name, language] of Object.entries(cases)) {
    assert.equal(api.languageOf(name), language, name)
  }
})

test('readable/editable kind sets line up with the viewers', () => {
  for (const kind of ['text', 'unknown', 'markdown', 'json']) {
    assert.equal(api.isReadableKind(kind), true, kind + ' must be read')
    assert.equal(api.isEditableKind(kind), true, kind + ' must be editable')
  }
  for (const kind of ['image', 'pdf', 'html', 'binary']) {
    assert.equal(api.isReadableKind(kind), false, kind + ' is streamed via /media')
    assert.equal(api.isEditableKind(kind), false, kind + ' must not be editable')
  }
})

/* ============================== markdown ============================== */

test('escapeHtml neutralises every HTML-significant character', () => {
  assert.equal(api.escapeHtml('<img src=x onerror="alert(\'x\')">&'), '&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;')
})

test('markdownToHtml escapes embedded HTML before adding its own tags', () => {
  const html = api.markdownToHtml('# Hi\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>')
  assert.ok(html.startsWith('<h1>Hi</h1>'))
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
  assert.ok(html.includes('&lt;img src=x onerror=alert(2)&gt;'))
  assert.equal(html.includes('<script>'), false)
  assert.equal(html.includes('<img'), false)
})

test('markdownToHtml supports headings, lists, fences, bold, italic and inline code', () => {
  const html = api.markdownToHtml([
    '## Title',
    '',
    '- one',
    '- two',
    '',
    '1. first',
    '2. second',
    '',
    '```js',
    'const x = "<b>"',
    '```',
    '',
    'Some **bold** and *italic* and `code<tag>` text.',
    '',
    '---',
    '',
    '> quoted **text**',
  ].join('\n'))
  assert.ok(html.includes('<h2>Title</h2>'))
  assert.ok(html.includes('<ul><li>one</li><li>two</li></ul>'))
  assert.ok(html.includes('<ol><li>first</li><li>second</li></ol>'))
  assert.ok(html.includes('<pre><code class="language-js">const x = &quot;&lt;b&gt;&quot;</code></pre>'))
  assert.ok(html.includes('<strong>bold</strong>'))
  assert.ok(html.includes('<em>italic</em>'))
  assert.ok(html.includes('<code>code&lt;tag&gt;</code>'))
  assert.ok(html.includes('<hr>'))
  assert.ok(html.includes('<blockquote><p>quoted <strong>text</strong></p></blockquote>'))
})

test('markdownToHtml links open in a new tab and refuse javascript: URLs', () => {
  const safe = api.markdownToHtml('[docs](https://example.com/a?b=1&c=2) [mail](mailto:a@b.c) [rel](./other.md)')
  assert.ok(safe.includes('<a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noreferrer noopener">docs</a>'))
  assert.ok(safe.includes('href="mailto:a@b.c"'))
  assert.ok(safe.includes('href="./other.md"'))

  const blocked = api.markdownToHtml('[x](javascript:alert(1)) [y](data:text/html;base64,xx) [z](//evil.example/x)')
  assert.equal(blocked.includes('href="javascript:'), false)
  assert.equal(blocked.includes('href="data:'), false)
  assert.equal(blocked.includes('href="//evil'), false)
})

/* ============================== dirty reducer ============================== */

function baseTab(overrides) {
  return Object.assign({
    rel: 'a.txt',
    name: 'a.txt',
    kind: 'text',
    language: 'text',
    status: 'ready',
    error: null,
    content: 'hello',
    savedContent: 'hello',
    dirty: false,
    saving: false,
    editing: false,
    conflict: false,
    externalMtimeMs: null,
    mtimeMs: 100,
    size: 5,
    truncated: false,
    encoding: 'utf8',
    mediaTick: 0,
  }, overrides === undefined ? {} : overrides)
}

test('reduceTab marks content edits dirty until they match the saved text', () => {
  const edited = api.reduceTab(baseTab(), { type: 'content', content: 'hello!' })
  assert.equal(edited.dirty, true)
  assert.equal(edited.content, 'hello!')
  const reverted = api.reduceTab(edited, { type: 'content', content: 'hello' })
  assert.equal(reverted.dirty, false)
  const unchanged = api.reduceTab(baseTab(), { type: 'content', content: 'hello' })
  assert.equal(unchanged.dirty, false)
})

test('reduceTab clears dirty on load and save, preserving newer edits', () => {
  const loaded = api.reduceTab(baseTab({ dirty: true, content: 'x' }), { type: 'loaded', content: 'disk', mtimeMs: 200, size: 4 })
  assert.equal(loaded.dirty, false)
  assert.equal(loaded.content, 'disk')
  assert.equal(loaded.savedContent, 'disk')
  assert.equal(loaded.mtimeMs, 200)

  const saved = api.reduceTab(baseTab({ dirty: true, content: 'new', savedContent: 'hello' }), { type: 'saved', savedContent: 'new', mtimeMs: 300, size: 3 })
  assert.equal(saved.dirty, false)
  assert.equal(saved.savedContent, 'new')
  assert.equal(saved.mtimeMs, 300)

  const typedDuringSave = api.reduceTab(baseTab({ dirty: true, content: 'newer' }), { type: 'saved', savedContent: 'new', mtimeMs: 300, size: 3 })
  assert.equal(typedDuringSave.content, 'newer', 'content typed during a write must survive')
  assert.equal(typedDuringSave.savedContent, 'new')
  assert.equal(typedDuringSave.dirty, true, 'still dirty because the latest keystroke was not written')
})

test('reduceTab handles conflict, external change, loading and editing state', () => {
  const conflict = api.reduceTab(baseTab({ saving: true }), { type: 'conflict', value: true })
  assert.equal(conflict.conflict, true)
  assert.equal(conflict.saving, false)
  assert.equal(api.reduceTab(conflict, { type: 'conflict', value: false }).conflict, false)

  assert.equal(api.reduceTab(baseTab(), { type: 'external', mtimeMs: 999 }).externalMtimeMs, 999)
  assert.equal(api.reduceTab(baseTab({ externalMtimeMs: 999 }), { type: 'loaded' }).externalMtimeMs, null)

  const reloading = api.reduceTab(baseTab(), { type: 'reloading' })
  assert.equal(reloading.status, 'loading')
  assert.equal(reloading.error, null)

  const failed = api.reduceTab(baseTab(), { type: 'failed', message: 'nope' })
  assert.equal(failed.status, 'error')
  assert.equal(failed.error, 'nope')

  assert.equal(api.reduceTab(baseTab(), { type: 'editing', value: true }).editing, true)
  assert.equal(api.reduceTab(baseTab(), { type: 'saving', value: true }).saving, true)
  assert.equal(api.reduceTab(baseTab(), { type: 'bogus' }).content, 'hello')
})

test('reduceTab jump moves the editor target without losing the buffer', () => {
  const dirty = baseTab({ content: 'unsaved', dirty: true, line: 0, lineToken: 0 })
  const jumped = api.reduceTab(dirty, { type: 'jump', line: 42, lineToken: 2, editing: true })
  assert.equal(jumped.line, 42)
  assert.equal(jumped.lineToken, 2)
  assert.equal(jumped.editing, true)
  assert.equal(jumped.content, 'unsaved', 'the in-memory buffer survives a search jump')
  assert.equal(jumped.dirty, true)
  const next = api.reduceTab(jumped, { type: 'jump', line: 7, lineToken: 3 })
  assert.equal(next.line, 7)
  assert.equal(next.lineToken, 3)
  assert.equal(next.editing, true, 'jump defaults to preserving the edit mode')
})

/* ============================== roots / paths ============================== */

test('parseStoredRoot accepts the plain-string contract and the legacy JSON shape', () => {
  assert.equal(api.parseStoredRoot('C:\\work\\repo'), 'C:\\work\\repo')
  assert.equal(api.parseStoredRoot('  /home/me/repo/  '), '/home/me/repo')
  assert.equal(api.parseStoredRoot('{"path":"D:\\\\work","at":1}'), 'D:\\work')
  assert.equal(api.parseStoredRoot('{"path":""}'), null)
  assert.equal(api.parseStoredRoot('  '), null)
  assert.equal(api.parseStoredRoot(null), null)
  assert.equal(api.parseStoredRoot(undefined), null)
})

test('normalizeRootPath keeps drive roots and strips trailing separators', () => {
  assert.equal(api.normalizeRootPath('C:\\'), 'C:\\')
  assert.equal(api.normalizeRootPath('C:/'), 'C:/')
  assert.equal(api.normalizeRootPath('C:\\work\\repo\\'), 'C:\\work\\repo')
  assert.equal(api.normalizeRootPath('/home/me/'), '/home/me')
  assert.equal(api.normalizeRootPath('/'), '/')
  assert.equal(api.normalizeRootPath('  '), '')
  assert.equal(api.workspaceNameOf('C:\\work\\repo'), 'repo')
  assert.equal(api.workspaceNameOf('/home/me/repo/'), 'repo')
})

test('browseEntryPath understands absolute, relative and Windows browse entries', () => {
  assert.equal(api.browseEntryPath('/a/b', { name: 'c' }), '/a/b/c')
  assert.equal(api.browseEntryPath('/a/b/', { name: 'c' }), '/a/b/c')
  assert.equal(api.browseEntryPath('C:\\a', { name: 'b' }), 'C:\\a\\b')
  assert.equal(api.browseEntryPath('C:\\', { name: 'b' }), 'C:\\b')
  assert.equal(api.browseEntryPath('/a', { rel: 'x/y' }), '/a/x/y')
  assert.equal(api.browseEntryPath('/a', { rel: '/abs/path' }), '/abs/path')
  assert.equal(api.browseEntryPath('/a', { rel: 'C:\\abs' }), 'C:\\abs')
  assert.equal(api.browseEntryPath('/a', { path: '/from/host' }), '/from/host')
})

test('rel/path helpers are POSIX-normalising', () => {
  assert.equal(api.normalizeRel('\\a\\b\\'), 'a/b')
  assert.equal(api.joinRel('a', 'b.txt'), 'a/b.txt')
  assert.equal(api.joinRel('', 'b.txt'), 'b.txt')
  assert.equal(api.baseNameOfRel('a/b/c.txt'), 'c.txt')
  assert.equal(api.dirNameOfRel('a/b/c.txt'), 'a/b')
  assert.deepEqual(api.ancestorDirsOf('a/b/c.txt'), ['a', 'a/b'])
})

test('formatBytes is human readable', () => {
  assert.equal(api.formatBytes(0), '0 B')
  assert.equal(api.formatBytes(1023), '1023 B')
  assert.equal(api.formatBytes(1024), '1 KB')
  assert.equal(api.formatBytes(1536), '1.5 KB')
  assert.equal(api.formatBytes(1048576), '1 MB')
  assert.equal(api.formatBytes(undefined), '0 B')
})

/* ============================== search panel: pure helpers ============================== */

test('buildSearchRequest maps §2.1 toggles, modes and globs', () => {
  let state = api.createSearchState()
  state = api.reduceSearchState(state, { type: 'open' })
  state = api.reduceSearchState(state, { type: 'query', query: '  Needle  ' })
  const basic = api.buildSearchRequest(state, 'C:\\work')
  assert.deepEqual(basic, { root: 'C:\\work', mode: 'content', query: '  Needle  ', maxResults: api.SEARCH_PANEL_MAX_RESULTS })
  assert.equal(api.buildSearchRequest(state, ''), null)
  assert.equal(api.buildSearchRequest(api.reduceSearchState(state, { type: 'query', query: '   ' }), 'C:\\work'), null)

  let toggled = state
  toggled = api.reduceSearchState(toggled, { type: 'flag', flag: 'caseSensitive' })
  toggled = api.reduceSearchState(toggled, { type: 'flag', flag: 'wholeWord' })
  toggled = api.reduceSearchState(toggled, { type: 'flag', flag: 'regex' })
  toggled = api.reduceSearchState(toggled, { type: 'glob', field: 'include', value: ' src/**/*.ts , **/test/** ' })
  toggled = api.reduceSearchState(toggled, { type: 'glob', field: 'exclude', value: ' **/dist/** , !**/vendor/** ' })
  const request = api.buildSearchRequest(toggled, '/home/me')
  assert.equal(request.mode, 'content')
  assert.equal(request.caseSensitive, true)
  assert.equal(request.wholeWord, true)
  assert.equal(request.regex, true)
  assert.equal(request.include, 'src/**/*.ts,**/test/**')
  assert.equal(request.exclude, '**/dist/**,!**/vendor/**')

  const name = api.buildSearchRequest(api.reduceSearchState(state, { type: 'mode', mode: 'name' }), 'C:\\work')
  assert.equal(name.mode, 'name')

  const noExclude = api.reduceSearchState(state, { type: 'glob', field: 'exclude', value: ',' })
  const explicit = api.buildSearchRequest(noExclude, 'C:\\work')
  assert.equal(Object.prototype.hasOwnProperty.call(explicit, 'exclude'), true, 'commas mean "no default excludes" per §2.1')
  assert.equal(explicit.exclude, '')

  const emptyExclude = api.buildSearchRequest(state, 'C:\\work')
  assert.equal(Object.prototype.hasOwnProperty.call(emptyExclude, 'exclude'), false, 'empty field keeps the default excludes')
})

test('parseGlobInput normalises tokens and reports invalid displays', () => {
  assert.deepEqual(api.parseGlobInput(''), { raw: '', tokens: [], invalid: [], valid: true, normalized: '' })
  const parsed = api.parseGlobInput(' src/**/*.ts , !vendor/** , ?.md ')
  assert.deepEqual(parsed.tokens, ['src/**/*.ts', '!vendor/**', '?.md'])
  assert.equal(parsed.normalized, 'src/**/*.ts,!vendor/**,?.md')
  assert.equal(parsed.valid, true)

  assert.deepEqual(api.parseGlobInput('!').invalid, ['!'])
  assert.deepEqual(api.parseGlobInput('a b').invalid, ['a b'])
  assert.equal(api.parseGlobInput('!').valid, false)
  assert.equal(api.parseGlobInput(Array.from({ length: 51 }, (_, index) => 'a' + index).join(',')).valid, false)
})

test('normalizeSearchResponse groups, normalises and sorts per §2.1', () => {
  const data = api.normalizeSearchResponse({
    root: 'C:\\work',
    mode: 'content',
    query: 'foo',
    files: [
      {
        rel: 'src\\b.ts',
        size: 10,
        mtimeMs: 2,
        matches: [
          { line: 5, column: 4, length: 3, text: 'xfoo', before: ['ctx', 7], after: ['nope'] },
          { line: 'bad', column: -2, length: -1, text: 7 },
        ],
      },
      { rel: 'src/a.ts', size: 'x', matches: [{ line: 2, column: 0, length: 3, text: 'foo two' }, { line: 1, column: 4, length: 3, text: 'a foo' }] },
      { rel: '', matches: [] },
      null,
    ],
    totalMatches: 3,
    scannedFiles: 4,
    truncated: true,
    elapsedMs: 12,
  }, 'content', 'foo')
  assert.deepEqual(data.files.map((file) => file.rel), ['src/a.ts', 'src/b.ts'])
  assert.deepEqual(data.files[0].matches.map((match) => match.line), [1, 2])
  assert.deepEqual(data.files[1].matches.map((match) => match.line), [1, 5], 'invalid line falls back to 1 and sorts first')
  assert.equal(data.files[1].matches[1].text, 'xfoo')
  assert.deepEqual(data.files[1].matches[1].before, ['ctx'])
  assert.equal(data.files[0].size, 0)
  assert.equal(data.truncated, true)
  assert.equal(data.elapsedMs, 12)
  assert.equal(data.totalMatches, 3)

  const name = api.normalizeSearchResponse({ files: [{ rel: 'b.txt', matches: [] }, { rel: 'a.txt', matches: [] }] }, 'name', 'txt')
  assert.equal(name.mode, 'name')
  assert.equal(name.totalMatches, 2)
  assert.deepEqual(name.files.map((file) => file.rel), ['a.txt', 'b.txt'])
})

test('flattenSearchResults creates collapsible file groups with stable keys', () => {
  const result = api.normalizeSearchResponse({
    files: [
      { rel: 'src/a.ts', matches: [{ line: 1, column: 0, length: 2, text: 'foo' }, { line: 2, column: 1, length: 2, text: ' foo' }] },
      { rel: 'b.md', matches: [{ line: 9, column: 0, length: 2, text: 'foo' }] },
    ],
  }, 'content', 'foo')
  const rows = api.flattenSearchResults(result, {})
  assert.deepEqual(rows.map((row) => [row.kind, row.rel, row.line]), [
    ['file', 'b.md', 1],
    ['match', 'b.md', 9],
    ['file', 'src/a.ts', 1],
    ['match', 'src/a.ts', 1],
    ['match', 'src/a.ts', 2],
  ])
  assert.equal(rows[2].matchCount, 2)
  assert.equal(rows[2].dir, 'src')
  assert.equal(rows[2].name, 'a.ts')
  const keys = rows.map((row) => row.key)
  assert.equal(new Set(keys).size, keys.length)

  const collapsed = api.flattenSearchResults(result, { 'src/a.ts': true })
  assert.deepEqual(collapsed.map((row) => row.rel), ['b.md', 'b.md', 'src/a.ts'])
  assert.equal(collapsed[2].collapsed, true)
  assert.equal(collapsed[2].matchCount, 2)

  const nameMode = api.normalizeSearchResponse({ files: [{ rel: 'src/a.ts', matches: [] }, { rel: 'b.md', matches: [] }] }, 'name', 'a')
  assert.deepEqual(api.flattenSearchResults(nameMode, {}).map((row) => row.kind), ['file', 'file'])
})

test('splitHighlight slices the host line into plain segments (no HTML)', () => {
  assert.deepEqual(api.splitHighlight('hello foo world', 6, 3), [
    { text: 'hello ', highlight: false },
    { text: 'foo', highlight: true },
    { text: ' world', highlight: false },
  ])
  assert.deepEqual(api.splitHighlight('foo', 0, 3), [{ text: 'foo', highlight: true }])
  assert.deepEqual(api.splitHighlight('foo', 4, 99), [{ text: 'foo', highlight: false }])
  assert.deepEqual(api.splitHighlight('foo', 1, 0), [{ text: 'foo', highlight: false }])
  assert.deepEqual(api.splitHighlight('foo', Number.NaN, Number.NaN), [{ text: 'foo', highlight: false }])
  const xss = api.splitHighlight('<img src=x onerror=alert(1)>', 0, 4)
  assert.equal(xss[0].text, '<img')
  assert.equal(xss[0].highlight, true)
  assert.equal(xss.map((segment) => segment.text).join(''), '<img src=x onerror=alert(1)>')
})

test('reduceSearchState drives open/query/request/response/stale/error/cancel transitions', () => {
  let state = api.createSearchState()
  assert.equal(state.open, false)
  state = api.reduceSearchState(state, { type: 'open' })
  assert.equal(state.open, true)

  state = api.reduceSearchState(state, { type: 'query', query: 'foo' })
  assert.equal(state.query, 'foo')
  assert.equal(state.focusIndex, -1)

  state = api.reduceSearchState(state, { type: 'request', seq: 5 })
  assert.equal(state.status, 'loading')
  assert.equal(state.seq, 5)

  const data = api.normalizeSearchResponse({ files: [{ rel: 'a.ts', matches: [{ line: 1, column: 0, length: 3, text: 'foo' }] }] }, 'content', 'foo')
  const updated = api.reduceSearchState(state, { type: 'response', seq: 5, data })
  assert.equal(updated.status, 'ready')
  assert.equal(updated.data.files.length, 1)
  const stale = api.reduceSearchState(updated, { type: 'response', seq: 4, data: { files: [] } })
  assert.equal(stale, updated, 'a stale response must not replace newer state')
  const staleError = api.reduceSearchState(updated, { type: 'error', seq: 3, message: 'nope' })
  assert.equal(staleError, updated)

  const failed = api.reduceSearchState(state, { type: 'error', seq: 5, message: 'Invalid regular expression' })
  assert.equal(failed.status, 'error')
  assert.equal(failed.data, null)

  const cancelled = api.reduceSearchState(state, { type: 'cancel', seq: 6 })
  assert.equal(cancelled.seq, 6)
  assert.equal(cancelled.status, 'idle')
  assert.equal(cancelled.data, null)
  const keep = api.reduceSearchState(updated, { type: 'cancel', seq: 7 })
  assert.equal(keep.status, 'ready')
  assert.equal(keep.data.files.length, 1)

  let toggled = api.reduceSearchState(updated, { type: 'flag', flag: 'wholeWord' })
  assert.equal(toggled.wholeWord, true)
  toggled = api.reduceSearchState(toggled, { type: 'flag', flag: 'wholeWord' })
  assert.equal(toggled.wholeWord, false)

  const named = api.reduceSearchState(updated, { type: 'mode', mode: 'name' })
  assert.equal(named.mode, 'name')
  assert.equal(named.data, null)
  assert.equal(named.seq, updated.seq + 1)
  assert.equal(api.reduceSearchState(updated, { type: 'mode', mode: 'bogus' }).mode, 'content')

  const glob = api.reduceSearchState(updated, { type: 'glob', field: 'exclude', value: '**/dist/**' })
  assert.equal(glob.exclude, '**/dist/**')
  const opened = api.reduceSearchState(glob, { type: 'globOpen', field: 'excludeOpen' })
  assert.equal(opened.excludeOpen, true)

  const collapsed = api.reduceSearchState(updated, { type: 'collapse', rel: 'a.ts' })
  assert.equal(collapsed.collapsed['a.ts'], true)
  const expandedAgain = api.reduceSearchState(collapsed, { type: 'collapse', rel: 'a.ts' })
  assert.equal(expandedAgain.collapsed['a.ts'], false)

  assert.equal(api.reduceSearchState(updated, { type: 'focus', index: 3 }).focusIndex, 3)
  assert.equal(api.reduceSearchState(updated, { type: 'focus', index: 'x' }).focusIndex, -1)

  const closed = api.reduceSearchState(updated, { type: 'close', seq: 9 })
  assert.equal(closed.open, false)
  assert.equal(closed.data, null)
  assert.equal(closed.seq, 9)
  assert.equal(closed.query, 'foo', 'the query is remembered for the next open')

  const pending = api.reduceSearchState(api.reduceSearchState(state, { type: 'query', query: 'bar' }), { type: 'pending' })
  assert.equal(pending.status, 'loading')

  const reset = api.reduceSearchState(updated, { type: 'reset' })
  assert.deepEqual(reset, api.createSearchState())
})

test('moveSearchFocus clamps and enters the list from both directions', () => {
  assert.equal(api.moveSearchFocus(-1, 0, 1), -1)
  assert.equal(api.moveSearchFocus(-1, 3, 1), 0)
  assert.equal(api.moveSearchFocus(-1, 3, -1), 2)
  assert.equal(api.moveSearchFocus(0, 3, -1), 0)
  assert.equal(api.moveSearchFocus(2, 3, 1), 2)
  assert.equal(api.moveSearchFocus(1, 3, 1), 2)
})

test('normalizeNameSearchEntries supports the §2.1 shape and the legacy tree response', () => {
  const current = api.normalizeNameSearchEntries({ files: [{ rel: 'src/b.ts', size: 4, mtimeMs: 7 }, { rel: 'src/a.ts' }] })
  assert.deepEqual(current.map((entry) => entry.rel), ['src/a.ts', 'src/b.ts'])
  assert.equal(current[1].name, 'b.ts')
  assert.equal(current[1].size, 4)
  assert.equal(current[1].mtimeMs, 7)
  assert.equal(current[1].type, 'file')

  const legacy = api.normalizeNameSearchEntries({ matches: [{ rel: 'b.txt', name: 'b.txt', type: 'file' }, { rel: 'a.txt', name: 'a.txt', type: 'file' }] })
  assert.deepEqual(legacy.map((entry) => entry.rel), ['a.txt', 'b.txt'])
  assert.deepEqual(api.normalizeNameSearchEntries({ nope: true }), [])
  assert.deepEqual(api.normalizeNameSearchEntries(null), [])
})

test('isAbortError recognises AbortController failures', () => {
  assert.equal(api.isAbortError({ name: 'AbortError' }), true)
  assert.equal(api.isAbortError({ code: 'aborted' }), true)
  assert.equal(api.isAbortError(new Error('boom')), false)
  assert.equal(api.isAbortError(null), false)
})

/* ============================== search panel: component smoke ============================== */

function makeSearchState() {
  let state = api.createSearchState()
  state = api.reduceSearchState(state, { type: 'open' })
  state = api.reduceSearchState(state, { type: 'query', query: 'foo' })
  state = api.reduceSearchState(state, { type: 'request', seq: 1 })
  const data = api.normalizeSearchResponse({
    root: 'C:\\work',
    mode: 'content',
    query: 'foo',
    files: [
      { rel: 'src/a.ts', size: 20, mtimeMs: 5, matches: [{ line: 2, column: 4, length: 3, text: 'let foo = 1' }, { line: 8, column: 0, length: 3, text: 'foo bar' }] },
      { rel: 'docs/b.md', size: 9, mtimeMs: 6, matches: [{ line: 1, column: 0, length: 3, text: 'foo doc' }] },
    ],
    totalMatches: 3,
    scannedFiles: 9,
    truncated: false,
    elapsedMs: 42,
  }, 'content', 'foo')
  return api.reduceSearchState(state, { type: 'response', seq: 1, data })
}

function searchHandlers(overrides) {
  const calls = []
  const record = (name) => (...args) => calls.push([name].concat(args))
  return {
    calls,
    props: Object.assign({
      t: translate,
      state: makeSearchState(),
      root: 'C:\\work',
      onQueryChange: record('query'),
      onRun: record('run'),
      onCancel: record('cancel'),
      onClose: record('close'),
      onModeChange: record('mode'),
      onToggleFlag: record('flag'),
      onToggleGlobOpen: record('globOpen'),
      onGlobChange: record('glob'),
      onCollapse: record('collapse'),
      onOpenRow: record('openRow'),
      onFocus: record('focus'),
      onPickRoot: record('pickRoot'),
      onClear: record('clear'),
    }, overrides === undefined ? {} : overrides),
  }
}

test('SearchPanel renders controls, grouped results, highlight spans and status', () => {
  const handlers = searchHandlers()
  const panel = E(api.components.SearchPanel, handlers.props)
  const text = textOf(panel)
  assert.ok(text.includes('Content'))
  assert.ok(text.includes('Files'))
  assert.ok(text.includes('Aa'))
  assert.ok(text.includes('ab'))
  assert.ok(text.includes('.*'))
  assert.ok(text.includes('files to include'))
  assert.ok(text.includes('files to exclude'))
  assert.ok(text.includes('3 results in 2 files'))
  assert.ok(text.includes('42 ms'))
  assert.ok(text.includes('a.ts'))
  assert.ok(text.includes('src'))
  assert.ok(text.includes('b.md'))
  assert.ok(text.includes('let') && text.includes('= 1'))

  const fileRows = nodesOf(panel, (node) => typeof node.props.className === 'string' && node.props.className.split(' ').includes('wbf-srFile'))
  assert.equal(fileRows.length, 2)
  const matchRows = nodesOf(panel, (node) => typeof node.props.className === 'string' && node.props.className.split(' ').includes('wbf-srMatch'))
  assert.equal(matchRows.length, 3)
  const hits = nodesOf(panel, (node) => typeof node.props.className === 'string' && node.props.className.includes('wbf-srHit'))
  assert.equal(hits.length, 3)
  assert.ok(textOf(matchRows[0]).includes('1'))
  assert.ok(textOf(matchRows[0]).includes('foo') && textOf(matchRows[0]).includes('doc'))
})

test('SearchPanel dispatches mode/flag/glob/clear/collapse/close and keyboard focus', () => {
  const handlers = searchHandlers()
  const panel = E(api.components.SearchPanel, handlers.props)

  const modeButtons = nodesOf(panel, (node) => node.type === 'button' && typeof node.props.className === 'string' && node.props.className.includes('wbf-srMode'))
  assert.equal(modeButtons.length, 2)
  modeButtons[1].props.onClick()
  assert.deepEqual(handlers.calls[0], ['mode', 'name'])

  const flags = nodesOf(panel, (node) => node.type === 'button' && typeof node.props.className === 'string' && node.props.className.includes('wbf-srFlag'))
  assert.equal(flags.length, 3)
  flags[0].props.onClick()
  assert.deepEqual(handlers.calls[1], ['flag', 'caseSensitive'])

  const globHeads = nodesOf(panel, (node) => node.type === 'button' && typeof node.props.className === 'string' && node.props.className.includes('wbf-srGlobHead'))
  assert.equal(globHeads.length, 2)
  globHeads[0].props.onClick()
  assert.deepEqual(handlers.calls[2], ['globOpen', 'includeOpen'])

  const clear = nodesOf(panel, (node) => node.type === 'button' && node.props.title === 'Clear search')
  assert.equal(clear.length, 1)
  clear[0].props.onClick()
  assert.deepEqual(handlers.calls[3], ['clear'])

  const fileRows = nodesOf(panel, (node) => typeof node.props.className === 'string' && node.props.className.split(' ').includes('wbf-srFile'))
  fileRows[0].props.onClick()
  assert.deepEqual(handlers.calls[4], ['collapse', 'docs/b.md'])

  const matchRows = nodesOf(panel, (node) => typeof node.props.className === 'string' && node.props.className.split(' ').includes('wbf-srMatch'))
  matchRows[0].props.onClick()
  assert.equal(handlers.calls[5][0], 'openRow')
  assert.equal(handlers.calls[5][1].line, 1)
  assert.equal(handlers.calls[5][1].rel, 'docs/b.md')

  const panelRoot = nodesOf(panel, (node) => typeof node.props.className === 'string' && node.props.className.includes('wbf-searchPanel'))[0]
  const key = (name, extra) => Object.assign({ key: name, preventDefault() {}, stopPropagation() {} }, extra === undefined ? {} : extra)
  panelRoot.props.onKeyDown(key('ArrowDown'))
  assert.deepEqual(handlers.calls[6], ['focus', 0])
  panelRoot.props.onKeyDown(key('ArrowUp'))
  assert.deepEqual(handlers.calls[7], ['focus', 4])
  panelRoot.props.onKeyDown(key('Enter'))
  assert.ok(handlers.calls.some((call) => call[0] === 'run' || call[0] === 'openRow'))
  panelRoot.props.onKeyDown(key('Escape'))
  assert.deepEqual(handlers.calls[handlers.calls.length - 1], ['close'])
})

test('SearchPanel opens the focused match on Enter and toggles file groups', () => {
  const handlers = searchHandlers()
  let state = handlers.props.state
  state = api.reduceSearchState(state, { type: 'focus', index: 1 })
  const panel = E(api.components.SearchPanel, Object.assign({}, handlers.props, { state }))
  const panelRoot = nodesOf(panel, (node) => typeof node.props.className === 'string' && node.props.className.includes('wbf-searchPanel'))[0]
  const key = (name, extra) => Object.assign({ key: name, preventDefault() {}, stopPropagation() {} }, extra === undefined ? {} : extra)
  panelRoot.props.onKeyDown(key('Enter'))
  assert.equal(handlers.calls[handlers.calls.length - 1][0], 'openRow')
  assert.equal(handlers.calls[handlers.calls.length - 1][1].line, 1)

  state = api.reduceSearchState(handlers.props.state, { type: 'focus', index: 0 })
  const filePanel = E(api.components.SearchPanel, Object.assign({}, handlers.props, { state }))
  const fileRoot = nodesOf(filePanel, (node) => typeof node.props.className === 'string' && node.props.className.includes('wbf-searchPanel'))[0]
  fileRoot.props.onKeyDown(key('Enter'))
  assert.deepEqual(handlers.calls[handlers.calls.length - 1], ['collapse', 'docs/b.md'])

  fileRoot.props.onKeyDown(key('Enter', { ctrlKey: true }))
  assert.equal(handlers.calls[handlers.calls.length - 2][0], 'openRow')
  assert.equal(handlers.calls[handlers.calls.length - 1][0], 'close')
})

test('SearchPanel renders collapsed groups, name mode, errors, glob displays and the no-root state', () => {
  const handlers = searchHandlers()
  let state = api.reduceSearchState(handlers.props.state, { type: 'collapse', rel: 'src/a.ts' })
  const collapsed = E(api.components.SearchPanel, Object.assign({}, handlers.props, { state }))
  const collapsedMatches = nodesOf(collapsed, (node) => typeof node.props.className === 'string' && node.props.className.split(' ').includes('wbf-srMatch'))
  assert.equal(collapsedMatches.length, 1, 'collapsed file hides its matches')
  assert.ok(textOf(collapsed).includes('2'), 'collapsed group still shows its count badge')

  let nameState = api.reduceSearchState(handlers.props.state, { type: 'mode', mode: 'name' })
  nameState = api.reduceSearchState(nameState, { type: 'request', seq: 2 })
  const nameData = api.normalizeSearchResponse({ files: [{ rel: 'src/a.ts', matches: [] }, { rel: 'docs/b.md', matches: [] }] }, 'name', 'foo')
  nameState = api.reduceSearchState(nameState, { type: 'response', seq: 2, data: nameData })
  const namePanel = E(api.components.SearchPanel, Object.assign({}, handlers.props, { state: nameState }))
  assert.ok(textOf(namePanel).includes('Files'))
  const nameRows = nodesOf(namePanel, (node) => typeof node.props.className === 'string' && node.props.className.split(' ').includes('wbf-srFile'))
  assert.equal(nameRows.length, 2)

  const errorState = api.reduceSearchState(
    api.reduceSearchState(api.createSearchState(), { type: 'open' }),
    { type: 'error', seq: 0, message: translate('error.badRegex') },
  )
  const errored = E(api.components.SearchPanel, Object.assign({}, handlers.props, { state: errorState }))
  assert.ok(textOf(errored).includes('Invalid regular expression'))

  const globState = Object.assign({}, handlers.props.state, {
    includeOpen: true,
    include: 'src/**/*.ts,!vendor/**',
    excludeOpen: true,
    exclude: 'bad token',
  })
  const globPanel = E(api.components.SearchPanel, Object.assign({}, handlers.props, { state: globState }))
  assert.ok(textOf(globPanel).includes('src/**/*.ts'))
  assert.ok(textOf(globPanel).includes('Invalid globs: bad token'))

  const noRoot = E(api.components.SearchPanel, Object.assign({}, handlers.props, { root: '' }))
  assert.ok(textOf(noRoot).includes('No workspace selected yet'))
})

test('SearchPanel in name mode opens a file row instead of collapsing it', () => {
  const handlers = searchHandlers()
  let state = makeSearchState()
  state = api.reduceSearchState(state, { type: 'mode', mode: 'name' })
  state = api.reduceSearchState(state, { type: 'request', seq: 2 })
  const data = api.normalizeSearchResponse({ files: [{ rel: 'src/a.ts', matches: [] }, { rel: 'docs/b.md', matches: [] }] }, 'name', 'a')
  state = api.reduceSearchState(state, { type: 'response', seq: 2, data })
  const panel = E(api.components.SearchPanel, Object.assign({}, handlers.props, { state }))
  const rows = nodesOf(panel, (node) => typeof node.props.className === 'string' && node.props.className.split(' ').includes('wbf-srFile'))
  assert.equal(rows.length, 2)
  rows[0].props.onClick()
  assert.equal(handlers.calls[handlers.calls.length - 1][0], 'openRow')
  assert.equal(handlers.calls[handlers.calls.length - 1][1].line, 1)
})

/* ============================== i18n ============================== */

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
  assert.ok(used.size > 70, 'expected the page to use the dictionaries extensively')
  const missingEn = []
  const missingZh = []
  for (const key of used) {
    if (key.endsWith('.')) continue /* dynamic prefix: t('viewer.' + kind) */
    if (!Object.prototype.hasOwnProperty.call(api.dictionaries.en, key)) missingEn.push(key)
    if (!Object.prototype.hasOwnProperty.call(api.dictionaries.zh, key)) missingZh.push(key)
  }
  assert.deepEqual(missingEn, [])
  assert.deepEqual(missingZh, [])
  for (const kind of ['text', 'image', 'pdf', 'html', 'markdown', 'json', 'binary']) {
    assert.ok(Object.prototype.hasOwnProperty.call(api.dictionaries.en, 'viewer.' + kind), 'viewer.' + kind)
  }
})

/* ============================== component smoke ============================== */

const E = booted.React.createElement

function translate(key, values) {
  const template = Object.prototype.hasOwnProperty.call(api.dictionaries.en, key) ? api.dictionaries.en[key] : key
  return String(template).replace(/\{(\w+)\}/g, (match, name) => {
    if (values === undefined || values[name] === undefined) return match
    return String(values[name])
  })
}

/** Execute function components with the stubbed hooks and return host nodes + text. */
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

function clickHandlerOf(node) {
  return node.props === undefined ? undefined : node.props.onClick
}

test('viewers choose the right host element for every kind', () => {
  const viewer = (tab, extra) => E(api.components.Viewer, Object.assign({
    tab: Object.assign(baseTab(), tab),
    t: translate,
    editing: false,
    src: 'http://127.0.0.1:3080/dsh-workbay-files/media?root=R&rel=a',
    onChange() {},
    onSave() {},
  }, extra === undefined ? {} : extra))

  const image = viewer({ name: 'a.png', kind: 'image' })
  const img = nodesOf(image, (node) => node.type === 'img')
  assert.equal(img.length, 1)
  assert.ok(img[0].props.src.includes('/dsh-workbay-files/media?'))

  const pdf = viewer({ name: 'a.pdf', kind: 'pdf' })
  const embed = nodesOf(pdf, (node) => node.type === 'embed')
  assert.equal(embed.length, 1)
  assert.equal(embed[0].props.type, 'application/pdf')

  const html = viewer({ name: 'a.html', kind: 'html' })
  const frame = nodesOf(html, (node) => node.type === 'iframe')
  assert.equal(frame.length, 1)
  assert.equal(frame[0].props.sandbox, '')
  assert.ok(frame[0].props.src.includes('/dsh-workbay-files/media?'))

  const markdown = viewer({ name: 'a.md', kind: 'markdown', content: '# Title\n\n**bold**' })
  const md = nodesOf(markdown, (node) => node.props !== undefined && node.props.dangerouslySetInnerHTML !== undefined)
  assert.equal(md.length, 1)
  assert.ok(md[0].props.dangerouslySetInnerHTML.__html.includes('<h1>Title</h1>'))
  assert.ok(md[0].props.dangerouslySetInnerHTML.__html.includes('<strong>bold</strong>'))

  const json = viewer({ name: 'a.json', kind: 'json', content: '{"b":2,"a":1}' })
  assert.ok(textOf(json).includes('"a": 1'))

  const binary = viewer({ name: 'a.zip', kind: 'binary', size: 2048 })
  assert.ok(textOf(binary).includes('Binary'))
  assert.ok(textOf(binary).includes('2 KB'))
  const download = nodesOf(binary, (node) => node.type === 'a' && node.props.download !== undefined)
  assert.ok(download.length >= 1)

  const plain = viewer({ name: 'a.unknown', kind: 'text', content: 'hello world' })
  assert.ok(textOf(plain).includes('hello world'), 'text viewer falls back to a <pre> until the chunk loads')
})

test('Viewer forwards a search hit line to the editor mount', () => {
  const textTab = Object.assign(baseTab(), { rel: 'src/a.ts', name: 'a.ts', kind: 'text', language: 'ts', line: 42, lineToken: 3 })
  const textViewer = api.components.Viewer({
    tab: textTab, t: translate, editing: false, src: 'http://x/media', onChange() {}, onSave() {},
  })
  assert.equal(textViewer.props.line, 42)
  assert.equal(textViewer.props.lineToken, 3)

  const markdownTab = Object.assign({}, textTab, { rel: 'README.md', name: 'README.md', kind: 'markdown', editing: true })
  const markdownViewer = api.components.Viewer({
    tab: markdownTab, t: translate, editing: true, src: 'http://x/media', onChange() {}, onSave() {},
  })
  assert.equal(markdownViewer.props.line, 42)
  assert.equal(markdownViewer.props.lineToken, 3)

  const imageViewer = api.components.Viewer({
    tab: Object.assign({}, textTab, { rel: 'a.png', name: 'a.png', kind: 'image' }),
    t: translate, editing: false, src: 'http://x/media', onChange() {}, onSave() {},
  })
  assert.equal(nodesOf(imageViewer, (node) => node.type === 'img').length, 1, 'line navigation never changes the image viewer')
})

test('FileHeader shows path, badges and the edit action for text files', () => {
  const header = E(api.components.FileHeader, {
    t: translate,
    tab: baseTab({ rel: 'src/a.ts', name: 'a.ts', language: 'ts', size: 42 }),
    editing: false,
    onToggleEdit() {},
    onSave() {},
    onReload() {},
    onClose() {},
    onRevert() {},
  })
  const text = textOf(header)
  assert.ok(text.includes('src/a.ts'))
  assert.ok(text.includes('Text'))
  assert.ok(text.includes('ts'))
  assert.ok(text.includes('42 B'))
  assert.ok(text.includes('Edit'))

  const dirty = E(api.components.FileHeader, {
    t: translate,
    tab: baseTab({ rel: 'a.txt', name: 'a.txt', dirty: true, editing: true, saving: true }),
    editing: true,
    onToggleEdit() {},
    onSave() {},
    onReload() {},
    onClose() {},
    onRevert() {},
  })
  const dirtyText = textOf(dirty)
  assert.ok(dirtyText.includes('Unsaved'))
  assert.ok(dirtyText.includes('Preview'))
  assert.ok(dirtyText.includes('Saving…'))
})

test('TabStrip renders a dirty dot and close affordances', () => {
  const strip = E(api.components.TabStrip, {
    t: translate,
    tabs: [baseTab({ rel: 'a.txt', name: 'a.txt', dirty: true }), baseTab({ rel: 'b.txt', name: 'b.txt' })],
    activeRel: 'a.txt',
    onActivate() {},
    onClose() {},
  })
  assert.ok(textOf(strip).includes('a.txt'))
  assert.ok(textOf(strip).includes('b.txt'))
  const dots = nodesOf(strip, (node) => typeof node.props.className === 'string' && node.props.className.includes('wbf-tabDot'))
  assert.equal(dots.length, 1)
  const active = nodesOf(strip, (node) => typeof node.props.className === 'string' && node.props.className.includes('is-active'))
  assert.ok(active.length >= 1)
})

test('ConflictBar offers reload and overwrite, localised', () => {
  const bar = E(api.components.ConflictBar, {
    t: translate,
    tab: baseTab({ conflict: true, dirty: true }),
    onReload() {},
    onOverwrite() {},
  })
  const text = textOf(bar)
  assert.ok(text.includes('The file changed on disk after you opened it.'))
  assert.ok(text.includes('Reload from disk'))
  assert.ok(text.includes('Overwrite disk file'))
  const buttons = nodesOf(bar, (node) => node.type === 'button')
  assert.ok(buttons.length >= 2)
  for (const button of buttons) assert.equal(typeof clickHandlerOf(button), 'function')
})

test('RootPicker lists the current workspace, drives, recents and the use-folder footer', () => {
  const picker = E(api.components.RootPicker, {
    t: translate,
    open: true,
    current: null,
    rootsInfo: {
      status: 'ready',
      error: null,
      data: {
        root: 'C:\\work',
        drives: [{ name: 'C:', path: 'C:\\' }],
        recent: ['D:\\repo'],
      },
    },
    onClose() {},
    onPick() {},
  })
  const text = textOf(picker)
  assert.ok(text.includes('Choose workspace root'))
  assert.ok(text.includes('Current workspace'))
  assert.ok(text.includes('C:'))
  assert.ok(text.includes('Drives'))
  assert.ok(text.includes('Recent'))
  assert.ok(text.includes('Use this folder'))
  assert.ok(text.includes('work'), 'suggested workspace is listed by its base name')
})

test('TreePanel renders a flat list, hides dotfiles by default and marks node_modules', () => {
  const tree = {
    '': {
      status: 'ready',
      truncated: true,
      entries: [
        { name: '.env', rel: '.env', type: 'file' },
        { name: 'node_modules', rel: 'node_modules', type: 'dir' },
        { name: 'src', rel: 'src', type: 'dir' },
        { name: 'z.txt', rel: 'z.txt', type: 'file' },
      ],
    },
  }
  const panel = E(api.components.TreePanel, {
    t: translate,
    root: 'R',
    tree,
    expanded: new Set(),
    rows: api.flattenTree(tree, new Set(), { showHidden: false }),
    rowLimit: api.TREE_ROW_LIMIT,
    showHidden: false,
    searchQuery: '',
    search: { status: 'idle', matches: [], truncated: false, error: null },
    activeRel: null,
    onQueryChange() {},
    onClearSearch() {},
    onToggleHidden() {},
    onRefresh() {},
    onToggleDir() {},
    onOpenFile() {},
    onRetryDir() {},
    onShowMore() {},
    onOpenSearchResult() {},
  })
  const text = textOf(panel)
  assert.ok(text.includes('node_modules'))
  assert.ok(text.includes('src'))
  assert.equal(text.includes('.env'), false)
  assert.ok(text.includes('Too many entries'))
  const rows = nodesOf(panel, (node) => typeof node.props.className === 'string' && node.props.className.split(' ').includes('wbf-row'))
  assert.equal(rows.length, 3)
})

test('viewer empty state points at choosing a workspace', () => {
  const empty = E(api.components.ViewerEmpty, { t: translate, hasRoot: false, onChoose() {} })
  const text = textOf(empty)
  assert.ok(text.includes('No workspace selected yet'))
  assert.ok(text.includes('Choose workspace'))
  const button = nodesOf(empty, (node) => node.type === 'button')
  assert.equal(button.length, 1)
})

/* ============================== lazy editor chunk ============================== */

test('loadChunk calls a pre-registered chunk factory with the host React', async () => {
  const previous = globalThis.__dshChunks__
  const calls = []
  globalThis.__dshChunks__ = {
    'dsh-workbay-files:editor': (env) => {
      calls.push(env)
      return { createEditor() { return { setContent() {}, destroy() {} } } }
    },
  }
  try {
    const mod = await api.loadChunk()
    assert.equal(calls.length, 1)
    assert.equal(calls[0].modules.react, booted.React)
    assert.equal(typeof mod.createEditor, 'function')
    const cached = await api.loadChunk()
    assert.equal(cached, mod, 'the chunk promise is cached')
    assert.equal(calls.length, 1, 'a cached chunk is not re-created')
  } finally {
    if (previous === undefined) delete globalThis.__dshChunks__
    else globalThis.__dshChunks__ = previous
  }
})

test('loadChunk injects /dsh-workbay-files/chunk/editor.js once and reads the registry', async () => {
  const previous = globalThis.__dshChunks__
  delete globalThis.__dshChunks__
  const local = boot()
  try {
    const pending = local.testApi.loadChunk()
    const scripts = local.styleTags.filter((node) => node.tag === 'script')
    assert.equal(scripts.length, 1)
    assert.ok(scripts[0].src.includes('/dsh-workbay-files/chunk/editor.js'), scripts[0].src)
    assert.equal(scripts[0].async, true)
    let seen = null
    globalThis.__dshChunks__ = {
      'dsh-workbay-files:editor': (env) => {
        seen = env
        return { createEditor() { return { destroy() {} } } }
      },
    }
    scripts[0].onload()
    const mod = await pending
    assert.equal(seen.modules.react, local.React)
    assert.equal(typeof mod.createEditor, 'function')
  } finally {
    if (previous === undefined) delete globalThis.__dshChunks__
    else globalThis.__dshChunks__ = previous
  }
})

test('mediaUrl encodes root and rel and appends the cache-busting tick', () => {
  const url = api.mediaUrl('C:\\my work', 'a b/c d.png', 1234)
  assert.ok(url.includes('/dsh-workbay-files/media?'))
  assert.ok(url.includes('root=C%3A%5Cmy+work'))
  assert.ok(url.includes('rel=a+b%2Fc+d.png'))
  assert.ok(url.includes('v=1234'))
  assert.ok(api.mediaUrl('R', 'a.png', 0).endsWith('rel=a.png'))
})

/* ============================== static checks ============================== */

test('the bundle is plain browser JavaScript: no JSX, no imports', () => {
  assert.equal(/^\s*import\s/m.test(source), false, 'client bundles cannot use import statements')
  assert.equal(/^\s*export\s/m.test(source), false, 'client bundles cannot use export statements')
  assert.equal(source.includes('<div'), false, 'no JSX elements')
  assert.equal(source.includes('ReactDOM.render'), false)
})

test('node --check accepts the client bundle', () => {
  const result = spawnSync(process.execPath, ['--check', clientPath], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})
