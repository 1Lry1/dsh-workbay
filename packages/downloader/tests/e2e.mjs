/**
 * End-to-end smoke test for the Downloader page.
 *
 * Unlike the unit tests, this mounts the REAL client bundle with REAL React in a
 * headless browser and drives the real UI. It exists because of a specific bug:
 * the tool-path button called `window.prompt`, which Electron does not implement —
 * the click did nothing. Then the fix put the dialog's state inside a `useEffect`
 * closure and the whole page crashed with `toolDialog is not defined`.
 *
 * Neither bug is reachable by static checks or pure-function tests. What this
 * covers is exactly the gap:
 *
 *   render   the page mounts and paints without a runtime error
 *   buttons  the tool-path button exists and is clickable
 *   dialog   clicking it opens an INLINE dialog (input + 保存 / 取消)
 *   cancel   cancelling closes it again
 *
 * Hardware is not involved: no serial port, no Downloader.exe. The host half is
 * mounted against a throwaway log directory.
 *
 * SKIPPED (exit 0 with a SKIP line) when no browser is found — a missing browser
 * is an environment fact, not a failure of the page.
 *
 * Usage:  node tests/e2e.mjs [browser-exe]
 * Env:    WORKBAY_BROWSER    browser executable
 *         WORKBAY_REACT_DIR  directory containing node_modules/react + react-dom
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'

const here = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(here, '..', '..', '..')
const EDGE = process.argv[2] ?? process.env.WORKBAY_BROWSER ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const REACTDIR = process.env.WORKBAY_REACT_DIR ?? path.join(tmpdir(), 'wbreact', 'node_modules')

let failures = 0
function check(name, ok, detail) {
  if (ok !== true) failures += 1
  console.log((ok === true ? '  ok   ' : '  FAIL ') + name + (detail === undefined || ok === true ? '' : ' — ' + String(detail).slice(0, 240)))
}
function skip(reason) {
  console.log('SKIP: ' + reason)
  process.exit(0)
}

if (existsSync(EDGE) === false) skip('no browser at ' + EDGE)
for (const f of ['react/umd/react.production.min.js', 'react-dom/umd/react-dom.production.min.js']) {
  if (existsSync(path.join(REACTDIR, f)) === false) skip('no react build at ' + path.join(REACTDIR, f))
}

const work = mkdtempSync(path.join(tmpdir(), 'dl-e2e-'))
/* The host writes its JSONL log here; pointing it at a temp dir keeps the real
   ~/.dsh/workbay/logs untouched. Must be set BEFORE the host module loads. */
process.env.DSH_DOWNLOADER_LOG_DIR = path.join(work, 'logs')

let server = null
let child = null
let profileDir = null
function cleanup() {
  try { if (child !== null) child.kill('SIGKILL') } catch (error) { void error }
  try { if (server !== null) server.close() } catch (error) { void error }
  try { if (profileDir !== null) rmSync(profileDir, { recursive: true, force: true }) } catch (error) { void error }
  try { rmSync(work, { recursive: true, force: true }) } catch (error) { void error }
}

try {
  /* ============================== 1. the real host ============================== */
  const routes = []
  const mod = await import('file:///' + path.join(REPO, 'packages/downloader/lib/index.js').split(path.sep).join('/'))
  /* The host injects `webServer` and `tools`; both are stubbed here. `tools` is only
     used to expose AI-facing helpers, which this test never calls. */
  const ctx = {
    webServer: { register(r) { routes.push(r); return () => {} } },
    tools: { register() { return () => {} } },
    effect(fn) { try { const d = fn(); return typeof d === 'function' ? d : () => {} } catch (error) { return () => {} } },
    get() { return undefined },
    provide() {},
    inject(names, callback) { callback(ctx) },
    logger: { error() {}, warn() {}, info() {} },
  }
  mod.apply(ctx, {})
  console.log('mounted host: downloader')

  /* ============================== 2. one origin ============================== */
  const assets = new Map()
  for (const [url, file] of [
    ['/react.js', path.join(REACTDIR, 'react/umd/react.production.min.js')],
    ['/react-dom.js', path.join(REACTDIR, 'react-dom/umd/react-dom.production.min.js')],
    ['/b-downloader.js', path.join(REPO, 'packages/downloader/lib/client.js')],
  ]) {
    if (existsSync(file) === true) assets.set(url, readFileSync(file))
  }

  const html = `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;font:12px system-ui}#root{height:100%}</style></head>
<body><div id="root"></div>
<script>window.__REG__ = []; window.__ModuleLoader__ = { load(def) { window.__REG__.push(def); return () => {} } }</script>
<script src="/react.js"></script>
<script src="/react-dom.js"></script>
<script>
window.__DSH_WORKBAY__ = {
  _pages: [], _subs: [],
  registerPage(p) { this._pages.push(p); for (const s of this._subs) s(); return () => {} },
  list() { return this._pages.slice() },
  get(id) { return this._pages.find((x) => x.id === id) || null },
  subscribe(fn) { this._subs.push(fn); return () => {} },
  open() {}, close() {}, toggle() {}, isOpen() { return false },
}
window.__ERRORS__ = []
addEventListener('error', (e) => window.__ERRORS__.push(String(e.message)))
addEventListener('unhandledrejection', (e) => window.__ERRORS__.push('rejection: ' + String((e.reason && e.reason.message) || e.reason)))
function seedRequire(name) {
  if (name === 'react') return window.React
  if (name === 'react-dom') return window.ReactDOM
  if (name === 'react-dom/client') return window.ReactDOM
  if (name === 'react/jsx-runtime') return { createElement: window.React.createElement, Fragment: window.React.Fragment }
  throw new Error('seed miss: ' + name)
}
function bootBundles() {
  const out = { applied: [], errors: [] }
  const services = new Map()
  services.set('locale', { register() {}, subscribe() { return () => {} }, getSnapshot() { return { active: 'zh' } } })
  function mkctx() {
    const c = {
      effect(fn) { try { const d = fn(); return typeof d === 'function' ? d : () => {} } catch (e) { out.errors.push('effect: ' + e.message); return () => {} } },
      get(n) { return services.get(n) },
      provide(n, v) { services.set(n, v) },
      inject(n, cb) { try { cb(c) } catch (e) { out.errors.push('inject: ' + e.message) } },
      logger: { error() {}, warn() {}, info() {} },
    }
    return c
  }
  for (const reg of (window.__REG__ || [])) {
    try {
      const plugin = reg.factory(seedRequire)
      if (typeof plugin.apply === 'function') plugin.apply(mkctx())
      out.applied.push(reg.id)
    } catch (e) { out.errors.push(reg.id + ': ' + (e && e.message)) }
  }
  return out
}
function mountPage() {
  const dock = window.__DSH_WORKBAY__
  const page = dock.get('downloader')
  if (!page) return { error: 'page not registered; have ' + dock.list().map((p) => p.id).join(',') }
  const root = window.ReactDOM.createRoot(document.getElementById('root'))
  root.render(window.React.createElement(page.component, { t: (k) => k, dock }))
  return { ok: true }
}
</script>
<script src="/b-downloader.js"></script>
</body></html>`

  server = createServer((req, res) => {
    for (const r of routes) {
      if (req.url.startsWith(r.path)) return r.handler(req, res)
    }
    const clean = req.url.split('?')[0]
    if (clean === '/' || clean === '/index.html') {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(html)
      return
    }
    if (assets.has(clean)) {
      res.setHeader('content-type', 'text/javascript; charset=utf-8')
      res.end(assets.get(clean))
      return
    }
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + server.address().port

  /* ============================== 3. a real browser ============================== */
  profileDir = mkdtempSync(path.join(tmpdir(), 'dl-cdp-'))
  child = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', '--user-data-dir=' + profileDir, base + '/'], { stdio: 'ignore' })

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  let wsUrl = null
  for (let i = 0; i < 100 && wsUrl === null; i += 1) {
    try {
      const txt = readFileSync(path.join(profileDir, 'DevToolsActivePort'), 'utf8').split('\n')
      const list = await (await fetch('http://127.0.0.1:' + Number(txt[0]) + '/json/list')).json()
      const target = list.find((t) => t.type === 'page')
      if (target !== undefined) wsUrl = target.webSocketDebuggerUrl
    } catch (error) { void error }
    if (wsUrl === null) await sleep(200)
  }
  if (wsUrl === null) throw new Error('the browser never exposed a debugging target')

  let idc = 0
  const pending = new Map()
  const ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
  }
  const send = (method, params) => new Promise((resolve) => {
    const id = ++idc
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params: params === undefined ? {} : params }))
  })
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    const res = r.result
    if (res && res.exceptionDetails) return { __exception: res.exceptionDetails.text }
    return res && res.result ? res.result.value : undefined
  }

  await send('Runtime.enable')
  await send('Page.enable')
  await sleep(1500)

  /* ---- boot ---- */
  const boot = JSON.parse(await ev('JSON.stringify(bootBundles())'))
  check('the downloader bundle applies without error', boot.errors.length === 0, JSON.stringify(boot.errors))
  check('the downloader page registers', (await ev('JSON.stringify(window.__DSH_WORKBAY__.list().map(function(p){return p.id}))')) === '["downloader"]')

  /* ---- render ---- */
  const mounted = JSON.parse(await ev('JSON.stringify(mountPage())'))
  check('the page mounts', mounted.ok === true, JSON.stringify(mounted))
  await sleep(1800)

  const rendered = JSON.parse(await ev(`JSON.stringify({
    root: document.querySelector('.abw') !== null,
    alive: document.getElementById('root').children.length > 0,
    labels: [].slice.call(document.querySelectorAll('.abw-btn')).map(function (n) { return n.textContent.trim() }),
    crashed: document.body.innerText.indexOf('Page crashed') >= 0,
    errors: window.__ERRORS__.slice(0, 3),
  })`))
  /* This is the assertion the crash would have failed: a runtime scope error leaves
     the page blank with "Page crashed" and an empty root. */
  check('the page paints without crashing', rendered.root === true && rendered.alive === true && rendered.crashed === false, rendered)
  check('no runtime errors were raised while rendering', rendered.errors.length === 0, rendered.errors)
  check('the tool-path button is present', Array.isArray(rendered.labels) && rendered.labels.some(function (x) { return x.indexOf('工具路径') >= 0 }), rendered.labels)

  /* ---- the button opens an INLINE dialog ----
     window.prompt would do nothing at all here (Electron does not implement it, and
     headless Chromium returns immediately). The page must draw its own dialog. */
  await ev(`(function () {
    var b = [].slice.call(document.querySelectorAll('.abw-btn')).filter(function (n) { return n.textContent.indexOf('工具路径') >= 0 })[0]
    if (b) b.click()
  })()`)
  await sleep(700)
  const dialog = JSON.parse(await ev(`JSON.stringify({
    inputs: document.querySelectorAll('input[type=text]').length,
    buttons: [].slice.call(document.querySelectorAll('.abw-btn')).map(function (n) { return n.textContent.trim() }),
    text: document.body.innerText.indexOf('Downloader.exe 的位置') >= 0,
  })`))
  check('clicking 工具路径 opens an inline dialog with a path input',
    dialog.inputs >= 1 && dialog.text === true, dialog)
  check('the dialog offers 保存 and 取消',
    dialog.buttons.indexOf('保存') >= 0 && dialog.buttons.indexOf('取消') >= 0, dialog.buttons)

  await ev(`(function () {
    var b = [].slice.call(document.querySelectorAll('.abw-btn')).filter(function (n) { return n.textContent.trim() === '取消' })[0]
    if (b) b.click()
  })()`)
  await sleep(500)
  const afterCancel = JSON.parse(await ev(`JSON.stringify({
    inputs: document.querySelectorAll('input[type=text]').length,
    crashed: document.body.innerText.indexOf('Page crashed') >= 0,
  })`))
  check('cancelling closes the dialog and does not crash the page',
    afterCancel.inputs === 0 && afterCancel.crashed === false, afterCancel)

  const finalErrors = JSON.parse(await ev('JSON.stringify(window.__ERRORS__)'))
  check('no console errors across the whole flow', finalErrors.length === 0, finalErrors)
} finally {
  cleanup()
}

console.log('')
console.log(failures === 0 ? 'DOWNLOADER E2E PASS' : ('FAILURES: ' + failures))
process.exit(failures === 0 ? 0 : 1)

