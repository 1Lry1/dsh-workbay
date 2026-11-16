/**
 * The pre-restart check that actually matters: load the INSTALLED merged client
 * bundle (the exact file DSH will load), boot it with real React, and confirm
 * the composed page can reach the other two pages' panes.
 *
 * This is the one thing the earlier e2e could NOT prove, because it loaded the
 * four bundles separately. In the suite build all four are concatenated into ONE
 * module, which is exactly where `dock.get()` and the cross-bundle pane lookup
 * could behave differently.
 *
 * Usage:  node scripts/preflight-suite-client.mjs [profileDir]
 * Env:    WORKBAY_REACT_DIR  dir containing node_modules/react + react-dom
 */
import { readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'

const profileDir = process.argv[2] ?? path.join(os.homedir(), '.dsh', 'profiles', 'desktop')
const suiteDir = path.join(profileDir, 'node_modules', 'dsh-workbay-suite')
const clientPath = path.join(suiteDir, 'client.js')
const REACTDIR = process.env.WORKBAY_REACT_DIR ?? path.join(tmpdir(), 'wbreact', 'node_modules')
const EDGE = process.env.WORKBAY_BROWSER ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

if (existsSync(clientPath) === false) { console.error('FAIL  no client.js at ' + clientPath); process.exit(1) }
if (existsSync(EDGE) === false) { console.log('SKIP: no browser at ' + EDGE); process.exit(0) }
for (const f of ['react/umd/react.production.min.js', 'react-dom/umd/react-dom.production.min.js']) {
  if (existsSync(path.join(REACTDIR, f)) === false) { console.log('SKIP: no react build in ' + REACTDIR); process.exit(0) }
}

const work = mkdtempSync(path.join(tmpdir(), 'sc-preflight-'))
const fs = await import('node:fs')
fs.copyFileSync(path.join(REACTDIR, 'react/umd/react.production.min.js'), path.join(work, 'react.js'))
fs.copyFileSync(path.join(REACTDIR, 'react-dom/umd/react-dom.production.min.js'), path.join(work, 'react-dom.js'))
fs.copyFileSync(clientPath, path.join(work, 'suite-client.js'))
if (existsSync(path.join(suiteDir, 'vendor/files/lib/chunks/editor.js'))) {
  fs.mkdirSync(path.join(work, 'chunk'), { recursive: true })
  fs.copyFileSync(path.join(suiteDir, 'vendor/files/lib/chunks/editor.js'), path.join(work, 'chunk/editor.js'))
}

const html = `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;font:12px system-ui}#root{height:100%}</style></head>
<body><div id="root"></div>
<script src="/react.js"></script>
<script src="/react-dom.js"></script>
<script>
window.__ERRORS__ = []
addEventListener('error', function (e) { window.__ERRORS__.push(String(e.message)) })
addEventListener('unhandledrejection', function (e) { window.__ERRORS__.push('rejection: ' + String((e.reason && e.reason.message) || e.reason)) })
/* The DSH host surfaces the workbench registry as a browser global. */
window.__DSH_WORKBAY__ = {
  _pages: [], _subs: [],
  registerPage: function (p) { this._pages.push(p); for (var i = 0; i < this._subs.length; i++) this._subs[i](); return function () {} },
  list: function () { return this._pages.slice() },
  get: function (id) { for (var i = 0; i < this._pages.length; i++) if (this._pages[i].id === id) return this._pages[i]; return null },
  subscribe: function (fn) { this._subs.push(fn); return function () {} },
  open: function () {}, close: function () {}, toggle: function () {}, isOpen: function () { return false }
}
window.__REG__ = []
window.__ModuleLoader__ = { load: function (def) { window.__REG__.push(def); return function () {} } }
function seedRequire(name) {
  if (name === 'react') return window.React
  if (name === 'react-dom') return window.ReactDOM
  if (name === 'react-dom/client') return window.ReactDOM
  if (name === 'react/jsx-runtime') return { createElement: window.React.createElement, Fragment: window.React.Fragment }
  throw new Error('seed miss: ' + name)
}
</script>
<script src="/suite-client.js"></script>
<script>
window.__CHECK__ = async function () {
  var out = { registrations: [], applied: null, errors: [], pages: [], panes: {}, commands: {}, getWorks: null }
  out.registrations = (window.__REG__ || []).map(function (r) { return r.id })
  out.diag = {
    dockDefinedAtCheck: typeof window.__DSH_WORKBAY__,
    regCount: (window.__REG__ || []).length,
    pagesBeforeApply: window.__DSH_WORKBAY__.list().map(function (p) { return p.id }),
  }
  var services = new Map()
  services.set('locale', { register: function () {}, subscribe: function () { return function () {} }, getSnapshot: function () { return { active: 'zh' } } })
  services.set('slots', { register: function () { return function () {} }, inject: function () { return function () {} } })
  /* The @ picker rewrite needs these two. The sessions service reports a fixed
     cwd, and the reference source mimics @deepseek-ai/dsh-client-ui-reference
     exactly: a relative mention in, so the wrapper has something to absolutize. */
  window.__DEBUG_SESSION_CWD__ = 'D:\\\\AI_workspace'
  window.__REF_SOURCE__ = {
    trigger: '@',
    name: 'reference',
    onPick: function (pick) {
      if (pick.action === 'drill') return { text: pick.candidate.ref, continue: true }
      return { insert: { source: 'reference', ref: pick.candidate.ref, label: pick.candidate.label, appearance: pick.candidate.appearance || 'file', clipboardText: pick.candidate.ref } }
    },
  }
  services.set('sessions', { list: { getSnapshot: function () { return { byId: { s1: { cwd: window.__DEBUG_SESSION_CWD__ } } } } } })
  services.set('inputTriggers', { live: { sources: [window.__REF_SOURCE__] }, registerSource: function (s) { this.live.sources.push(s); return function () {} } })
  function mkctx() {
    var ctx = {
      effect: function (fn) { try { var d = fn(); return typeof d === 'function' ? d : function () {} } catch (e) { out.errors.push('effect: ' + e.message); return function () {} } },
      get: function (n) { return services.get(n) },
      provide: function (n, v) { services.set(n, v) },
      inject: function (n, cb) { try { cb(ctx) } catch (e) { out.errors.push('inject: ' + e.message) } },
      logger: { error: function () {}, warn: function () {}, info: function () {} }
    }
    return ctx
  }
  try {
    var reg = window.__REG__[0]
    var plugin = reg.factory(seedRequire)
    if (typeof plugin.apply === 'function') await plugin.apply(mkctx())
    out.applied = true
  } catch (e) {
    out.errors.push('apply: ' + (e && e.message))
    out.applied = false
  }
  var dock = window.__DSH_WORKBAY__
  out.diag.pagesAfterApply = dock.list().map(function (p) { return p.id })
  out.pages = dock.list().map(function (p) { return p.id })
  /* The @ picker rewrite, driven through the real pick() path: a relative file
     mention must come back absolute, with the chip label untouched. */
  try {
    var source = window.__REF_SOURCE__
    var picked = source.onPick({ candidate: { ref: '@build.bat', label: 'build.bat' }, session: { sessionId: 's1' }, action: 'pick', via: 'menu', position: 'inline', span: {} })
    out.absoluteRef = {
      ref: picked && picked.insert ? picked.insert.ref : null,
      label: picked && picked.insert ? picked.insert.label : null,
    }
  } catch (e) {
    out.errors.push('absoluteRef: ' + (e && e.message))
  }
  /* THE point of this check: can the shell reach the other pages by id, and do
     those pages actually publish the panes it needs? */
  out.getWorks = typeof dock.get === 'function'
  var files = dock.get('files')
  var git = dock.get('gitcraft')
  var sc = dock.get('source-control')
  out.panes = {
    filesSource: !!(files && files.panes && typeof files.panes.source === 'function'),
    gitcraftDiff: !!(git && git.panes && typeof git.panes.diff === 'function'),
  }
  out.commands = {
    filesOpenFile: !!(files && files.commands && typeof files.commands.openFile === 'function'),
    filesHasDirty: !!(files && files.commands && typeof files.commands.hasDirty === 'function'),
    gitShowDiff: !!(git && git.commands && typeof git.commands.showDiff === 'function'),
  }
  /* And can the shell actually mount its component? */
  if (sc && typeof sc.component === 'function') {
    try {
      var root = window.ReactDOM.createRoot(document.getElementById('root'))
      root.render(window.React.createElement(sc.component, { t: function (k) { return k }, dock: dock }))
      out.mounted = true
    } catch (e) { out.errors.push('mount: ' + e.message); out.mounted = false }
  }
  return out
}
</script>
</body></html>`

fs.writeFileSync(path.join(work, 'index.html'), html)

const { createServer } = await import('node:http')
const server = createServer((req, res) => {
  const clean = req.url.split('?')[0]
  if (clean === '/' || clean === '/index.html') {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(fs.readFileSync(path.join(work, 'index.html')))
    return
  }
  const name = clean.slice(1)
  const candidate = path.join(work, name)
  if (existsSync(candidate)) {
    res.setHeader('content-type', 'text/javascript; charset=utf-8')
    res.end(fs.readFileSync(candidate))
    return
  }
  res.statusCode = 404
  res.end('{}')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = 'http://127.0.0.1:' + server.address().port

const profileCd = mkdtempSync(path.join(tmpdir(), 'sc-pf-cdp-'))
const browser = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', '--user-data-dir=' + profileCd, base + '/'], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let wsUrl = null
for (let i = 0; i < 100 && wsUrl === null; i += 1) {
  try {
    const txt = fs.readFileSync(path.join(profileCd, 'DevToolsActivePort'), 'utf8').split('\n')
    const list = await (await fetch('http://127.0.0.1:' + Number(txt[0]) + '/json/list')).json()
    const t = list.find((x) => x.type === 'page')
    if (t) wsUrl = t.webSocketDebuggerUrl
  } catch (e) { void e }
  if (wsUrl === null) await sleep(200)
}
if (wsUrl === null) { console.error('FAIL  browser never came up'); process.exit(1) }

let idc = 0
const pending = new Map()
const ws = new WebSocket(wsUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
}
const send = (method, params) => new Promise((res) => { const id = ++idc; pending.set(id, res); ws.send(JSON.stringify({ id, method, params: params ?? {} })) })
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  const res = r.result
  if (res && res.exceptionDetails) return { __exc: res.exceptionDetails.text }
  return res && res.result ? res.result.value : undefined
}

await send('Runtime.enable')
await sleep(2000)

const result = JSON.parse(await evaluate('window.__CHECK__().then(function(r){ return JSON.stringify(r) })'))
await sleep(1200)
const dom = JSON.parse(await evaluate(`JSON.stringify((function(){
  return {
    shell: document.querySelector('.scw-root') !== null,
    rows: [].slice.call(document.querySelectorAll('.scw-rowName')).map(function(n){return n.textContent}),
    empty: document.querySelector('.scw-emptyTitle') ? document.querySelector('.scw-emptyTitle').textContent : null,
    errors: window.__ERRORS__
  }
})())`))

let failures = 0
const check = (name, ok, detail) => {
  if (ok !== true) failures += 1
  console.log((ok === true ? '  ok    ' : '  FAIL  ') + name + (ok === true || detail === undefined ? '' : '  — ' + JSON.stringify(detail)))
}

console.log('installed client: ' + clientPath)
console.log('')
check('the merged client registers ONE module', result.registrations.length === 1, result.registrations)
check('its id is dsh-workbay-suite', result.registrations[0] === 'dsh-workbay-suite', result.registrations)
check('the plugin applies without error', result.applied === true && result.errors.length === 0, result.errors)
check('every workbench page registers', JSON.stringify(result.pages) === '["files","terminal","gitcraft","downloader","source-control","memmap"]'
  || (result.pages.length === 6 && ['files', 'source-control', 'gitcraft', 'terminal', 'downloader', 'memmap'].every(function (id) { return result.pages.indexOf(id) >= 0 })), result.pages)
check('the @ picker inserts an ABSOLUTE path', !!result.absoluteRef && result.absoluteRef.ref === '@D:\\AI_workspace\\build.bat', result.absoluteRef)
check('the @ picker keeps the short chip label', !!result.absoluteRef && result.absoluteRef.label === 'build.bat', result.absoluteRef)
check('dock.get() exists in the merged build', result.getWorks === true)
check('files publishes panes.source', result.panes.filesSource === true, result.panes)
check('gitcraft publishes panes.diff', result.panes.gitcraftDiff === true, result.panes)
check('files commands: openFile / hasDirty', result.commands.filesOpenFile === true && result.commands.filesHasDirty === true, result.commands)
check('gitcraft command: showDiff', result.commands.gitShowDiff === true, result.commands)
check('the shell component mounts', result.mounted === true)
check('the shell renders its root', dom.shell === true, dom)
check('no console errors', Array.isArray(dom.errors) && dom.errors.length === 0, dom.errors)

console.log('')
console.log('diag: ' + JSON.stringify(result.diag))
console.log('shell tree rows: ' + JSON.stringify(dom.rows))
console.log('shell empty state: ' + JSON.stringify(dom.empty))

try { await send('Browser.close', {}) } catch (e) { void e }
try { browser.kill('SIGKILL') } catch (e) { void e }
await sleep(300)
try { server.close() } catch (e) { void e }
try { rmSync(profileCd, { recursive: true, force: true }) } catch (e) { void e }
try { rmSync(work, { recursive: true, force: true }) } catch (e) { void e }

console.log('')
console.log(failures === 0 ? 'SUITE-CLIENT PASS — the installed merged bundle composes correctly' : ('FAILURES: ' + failures))
process.exit(failures === 0 ? 0 : 1)




