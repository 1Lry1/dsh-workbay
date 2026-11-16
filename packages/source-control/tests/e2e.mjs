/**
 * End-to-end verification of the composed source-control page.
 *
 * This is the test that answers "does the feature actually work", as opposed to
 * "do the unit tests pass". It serves the REAL host halves (files + gitcraft) and
 * the REAL client bundles on ONE origin — the way DSH does — and then drives the
 * real UI in headless Edge against a REAL throwaway git repository:
 *
 *   boot     all four bundles materialise and apply without error
 *   render   the shell draws header + tree + commit box; status letters appear
 *   expand   clicking a directory loads and shows its children
 *   diff     clicking a changed file renders the patch in the diff pane
 *   source   switching tabs shows the file in the editor pane
 *   stage    the row action stages through the real git host
 *   commit   the commit box commits, and the REAL repository HEAD advances
 *
 * SKIPPED (exit 0 with a SKIP line) when no browser is found, because CI and
 * headless machines differ — a missing browser is an environment fact, not a
 * failure of the page.
 *
 * Usage:  node tests/e2e.mjs [browser-exe]
 * Env:    WORKBAY_BROWSER    browser executable
 *         WORKBAY_REACT_DIR  directory containing node_modules/react + react-dom
 *
 * The React dependency is real, not a stub: mounting two independent bundles into
 * containers the shell owns only works if the React contract is honoured, and a
 * hand-written fake would prove nothing about the thing being verified.
 */
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'

const here = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(here, '..', '..', '..')
const EDGE = process.argv[2] ?? process.env.WORKBAY_BROWSER ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const REACTDIR = process.env.WORKBAY_REACT_DIR ?? path.join(tmpdir(), 'wbreact', 'node_modules')

/* ============================== report ============================== */

const report = []
let failures = 0
function check(name, ok, detail) {
  report.push({ name, ok })
  if (ok !== true) failures += 1
  console.log((ok === true ? '  ok   ' : '  FAIL ') + name + (detail === undefined || ok === true ? '' : ' — ' + String(detail).slice(0, 200)))
}

function skip(reason) {
  console.log('SKIP: ' + reason)
  process.exit(0)
}

/* ============================== preconditions ============================== */

if (existsSync(EDGE) === false) skip('no browser at ' + EDGE)
for (const f of ['react/umd/react.production.min.js', 'react-dom/umd/react-dom.production.min.js']) {
  if (existsSync(path.join(REACTDIR, f)) === false) {
    skip('no react build at ' + path.join(REACTDIR, f) + ' (run: npm i react@18 react-dom@18 in that dir)')
  }
}
try { execFileSync('git', ['--version'], { stdio: 'ignore' }) } catch (error) { skip('git is not on PATH') }

const work = mkdtempSync(path.join(tmpdir(), 'sc-e2e-'))
const gitRepo = path.join(work, 'repo')
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

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
  /* ============================== 1. a real repository ============================== */
  mkdirSync(gitRepo, { recursive: true })
  git(['init', '-q', '-b', 'main'], gitRepo)
  git(['config', 'user.email', 'e2e@example.com'], gitRepo)
  git(['config', 'user.name', 'E2E'], gitRepo)
  writeFileSync(path.join(gitRepo, 'alpha.ts'), 'export const a = 1\n')
  writeFileSync(path.join(gitRepo, 'beta.ts'), 'export const b = 2\n')
  /* Tracked now, deleted after the commit: the files tab must still show the D record. */
  writeFileSync(path.join(gitRepo, 'gone.ts'), 'export const gone = 0\n')
  mkdirSync(path.join(gitRepo, 'src'), { recursive: true })
  writeFileSync(path.join(gitRepo, 'src', 'deep.ts'), 'export const d = 3\n')
  git(['add', '-A'], gitRepo)
  git(['commit', '-q', '-m', 'initial'], gitRepo)
  rmSync(path.join(gitRepo, 'gone.ts'))

  /* A remote makes the branches page show its web address and remote rows. */
  git(['remote', 'add', 'origin', 'https://gitea.idoocn.com:30443/linf/demo.git'], gitRepo)
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD'], gitRepo)

  /* one modified + one untracked: two different badges, and a diff that must show */
  writeFileSync(path.join(gitRepo, 'alpha.ts'), 'export const a = 42\nexport const extra = 1\n')
  writeFileSync(path.join(gitRepo, 'src', 'newfile.ts'), 'export const n = 9\n')

  /* ============================== 2. the real hosts ============================== */
  const routes = []
  for (const [label, entry, config] of [
    ['files', path.join(REPO, 'packages/files/src/index.js'), { allowWrite: true, maxFileBytes: 1048576 }],
    ['gitcraft', path.join(REPO, 'packages/gitcraft/src/index.js'), { refreshIntervalMs: 15000, timeoutMs: 30000, networkTimeoutMs: 180000, defaultDiffView: 'unified' }],
  ]) {
    const mod = await import('file:///' + entry.split(path.sep).join('/'))
    const ctx = {
      webServer: { register(r) { routes.push(r); return () => {} } },
      effect(fn) { try { const d = fn(); return typeof d === 'function' ? d : () => {} } catch (error) { return () => {} } },
      get() { return undefined },
      provide() {},
      inject(names, callback) { callback(ctx) },
      logger: { error() {}, warn() {}, info() {} },
    }
    mod.apply(ctx, config)
    console.log('mounted host:', label)
  }

  /* ============================== 3. one origin ============================== */
  const assets = new Map()
  for (const [url, file] of [
    ['/react.js', path.join(REACTDIR, 'react/umd/react.production.min.js')],
    ['/react-dom.js', path.join(REACTDIR, 'react-dom/umd/react-dom.production.min.js')],
    ['/b-dock.js', path.join(REPO, 'packages/dock/src/client.js')],
    ['/b-files.js', path.join(REPO, 'packages/files/src/client.js')],
    ['/b-gitcraft.js', path.join(REPO, 'packages/gitcraft/src/client.js')],
    ['/b-source-control.js', path.join(REPO, 'packages/source-control/src/client.js')],
    ['/dsh-workbay-files/chunk/editor.js', path.join(REPO, 'packages/files/lib/chunks/editor.js')],
  ]) {
    if (existsSync(file) === true) assets.set(url, readFileSync(file))
    else console.log('  note: missing asset', url, '(the editor degrades to a plain <pre>)')
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
window.__WORKSPACE__ = ${JSON.stringify(gitRepo)}
function bootBundles() {
  const out = { applied: [], errors: [] }
  const services = new Map()
  services.set('locale', { register() {}, subscribe() { return () => {} }, getSnapshot() { return { active: 'zh' } } })
  services.set('slots', { register() { return () => {} }, inject() { return () => {} } })
  function mkctx() {
    const ctx = {
      effect(fn) { try { const d = fn(); return typeof d === 'function' ? d : () => {} } catch (e) { out.errors.push('effect: ' + e.message); return () => {} } },
      get(n) { return services.get(n) },
      provide(n, v) { services.set(n, v) },
      inject(n, cb) { try { cb(ctx) } catch (e) { out.errors.push('inject: ' + e.message) } },
      logger: { error() {}, warn() {}, info() {} },
    }
    return ctx
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
function mountShell() {
  localStorage.setItem('dsh-workbay.sc.root.v1', window.__WORKSPACE__)
  localStorage.setItem('dsh-workbay.sc.repo.v1', window.__WORKSPACE__)
  localStorage.setItem('dsh-workbay.root.v1', window.__WORKSPACE__)
  const dock = window.__DSH_WORKBAY__
  const page = dock.get('source-control')
  if (!page) return { error: 'page not registered; have ' + dock.list().map((p) => p.id).join(',') }
  const root = window.ReactDOM.createRoot(document.getElementById('root'))
  root.render(window.React.createElement(page.component, { t: (k) => k, dock }))
  return { ok: true }
}
</script>
<script src="/b-dock.js"></script>
<script src="/b-files.js"></script>
<script src="/b-gitcraft.js"></script>
<script src="/b-source-control.js"></script>
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

  /* ============================== 4. drive a real browser ============================== */
  profileDir = mkdtempSync(path.join(tmpdir(), 'sc-cdp-'))
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
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    const res = r.result
    if (res && res.exceptionDetails) return { __exception: res.exceptionDetails.text }
    return res && res.result ? res.result.value : undefined
  }

  /** Wait until the page really reached a state (slow CI/first paint under load). */
  const waitFor = async (expression, timeoutMs = 10000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if ((await evaluate('Boolean(' + expression + ')')) === true) return true
      await sleep(250)
    }
    return false
  }

  await send('Runtime.enable')
  await sleep(1800)

  /* ---- boot ---- */
  const boot = JSON.parse(await evaluate('JSON.stringify(bootBundles())'))
  check('all four bundles applied without error', boot.errors.length === 0, JSON.stringify(boot.errors))
  check('three pages registered: files, gitcraft, source-control',
    (await evaluate('JSON.stringify(window.__DSH_WORKBAY__.list().map(function(p){return p.id}))')) === '["files","gitcraft","source-control"]')

  /* ---- mount ---- */
  const mounted = JSON.parse(await evaluate('JSON.stringify(mountShell())'))
  check('the shell mounts', mounted.ok === true, JSON.stringify(mounted))
  await waitFor("document.querySelectorAll('.scw-rowName').length > 0")
  await sleep(150)

  const dom = JSON.parse(await evaluate(`JSON.stringify((function () {
    var q = function (s) { return document.querySelector(s) }
    var all = function (s) { return [].slice.call(document.querySelectorAll(s)) }
    return {
      shell: q('.scw-root') !== null,
      header: q('.scw-head') !== null,
      tree: q('.scw-treePane') !== null,
      commit: q('.scw-commit') !== null,
      rows: all('.scw-rowName').map(function (n) { return n.textContent }),
      letters: all('.scw-letter').map(function (n) { return n.textContent }),
      errors: window.__ERRORS__,
    }
  })())`))
  check('the shell renders header + tree + commit box', dom.shell === true && dom.header === true && dom.tree === true && dom.commit === true, JSON.stringify(dom))
  check('the tree lists the repository root', Array.isArray(dom.rows) && dom.rows.indexOf('alpha.ts') >= 0, JSON.stringify(dom.rows))
  check('the modified file carries an M badge', Array.isArray(dom.letters) && dom.letters.indexOf('M') >= 0, JSON.stringify(dom.letters))
  check('no console errors after render', Array.isArray(dom.errors) && dom.errors.length === 0, JSON.stringify(dom.errors))

  /* ---- expand ---- */
  await evaluate(`(function () {
    var rows = [].slice.call(document.querySelectorAll('.scw-row'))
    var src = rows.filter(function (r) { return r.textContent.indexOf('src') >= 0 })[0]
    if (src) src.click()
  })()`)
  await sleep(1200)
  const nested = JSON.parse(await evaluate('JSON.stringify([].slice.call(document.querySelectorAll(".scw-rowName")).map(function(n){return n.textContent}))'))
  check('expanding a directory reveals its children', nested.indexOf('newfile.ts') >= 0 || nested.indexOf('deep.ts') >= 0, JSON.stringify(nested))

  /* ---- diff pane ---- */
  await evaluate(`(function () {
    var rows = [].slice.call(document.querySelectorAll('.scw-row'))
    var t = rows.filter(function (r) { return r.textContent.indexOf('alpha.ts') >= 0 })[0]
    if (t) t.click()
  })()`)
  /* A click on a changed file opens its SOURCE (that is what "open this file"
     means). The patch is the 变更 tab, one click away. */
  await evaluate(`(function () {
    var tabs = [].slice.call(document.querySelectorAll('.scw-tab'))
    var diff = tabs.filter(function (x) { return /变更|Changes/.test(x.textContent) })[0]
    if (diff) diff.click()
  })()`)
  await sleep(2200)
  const diff = JSON.parse(await evaluate(`JSON.stringify((function () {
    var host = document.querySelector('.scw-paneHost')
    return {
      rows: document.querySelectorAll('.gwc-row').length,
      text: host ? host.innerText.slice(0, 200) : '',
    }
  })())`))
  check('the 变更 tab renders the patch in the diff pane', diff.rows > 0 && diff.text.indexOf('@@') >= 0, JSON.stringify(diff))
  /* ---- source pane ---- */
  await evaluate(`(function () {
    var tabs = [].slice.call(document.querySelectorAll('.scw-tab'))
    var t = tabs.filter(function (x) { return /源码|Source/.test(x.textContent) })[0]
    if (t) t.click()
  })()`)
  await sleep(2000)
  const src2 = JSON.parse(await evaluate(`JSON.stringify((function () {
    var slots = [].slice.call(document.querySelectorAll('.scw-paneSlot'))
    return {
      editor: document.querySelector('.cm-editor') !== null,
      text: slots.map(function (s) { return (s.innerText || '').slice(0, 120) }),
    }
  })())`))
  check('the source tab shows the file in the editor pane', src2.editor === true || (src2.text[0] || '').indexOf('export const a = 42') >= 0, JSON.stringify(src2))

  /* ---- stage ---- */
  await evaluate(`(function () {
    var rows = [].slice.call(document.querySelectorAll('.scw-row'))
    var t = rows.filter(function (r) { return r.textContent.indexOf('alpha.ts') >= 0 })[0]
    if (!t) return
    var btn = [].slice.call(t.querySelectorAll('.scw-rowBtn')).filter(function (b) { return /暂存|Stage/.test(b.textContent) })[0]
    if (btn) btn.click()
  })()`)
  await sleep(2500)
  const staged = git(['diff', '--cached', '--name-only'], gitRepo).trim()
  check('the row action stages the file through the real git host', staged.indexOf('alpha.ts') >= 0, 'staged: ' + JSON.stringify(staged))
  const stageSections = JSON.parse(await evaluate(`JSON.stringify({
    sections: [].slice.call(document.querySelectorAll('.scw-subgroup')).map(function (n) { return n.textContent }),
  })`))
  check('the change list separates staged and unstaged files',
    stageSections.sections.some((text) => /已暂存|Staged/.test(text))
    && stageSections.sections.some((text) => /未暂存|Unstaged/.test(text)), stageSections)

  /* A failed commit must NOT clear the message box (the user has to retry after
     fixing the cause). Force a real git failure with a transient index lock. */
  writeFileSync(path.join(gitRepo, '.git', 'index.lock'), '')
  await evaluate(`(function () {
    var ta = document.querySelector('.scw-commitInput')
    if (!ta) return
    var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, 'e2e: message that must survive a failed commit')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await sleep(300)
  await evaluate(`(function () {
    var btn = [].slice.call(document.querySelectorAll('.scw-btn')).filter(function (b) { return /提交|Commit/.test(b.textContent) })[0]
    if (btn && !btn.disabled) btn.click()
  })()`)
  await sleep(1800)
  const failedCommit = JSON.parse(await evaluate(`JSON.stringify({
    value: document.querySelector('.scw-commitInput') ? document.querySelector('.scw-commitInput').value : null,
    error: document.querySelector('.scw-bar.is-error') ? document.querySelector('.scw-bar.is-error').textContent : null,
  })`))
  check('a failed commit keeps the message for retry',
    failedCommit.value === 'e2e: message that must survive a failed commit' && failedCommit.error !== null, failedCommit)
  rmSync(path.join(gitRepo, '.git', 'index.lock'), { force: true })

  /* ---- commit ---- */
  await evaluate(`(function () {
    var ta = document.querySelector('.scw-commitInput')
    if (!ta) return
    var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, 'e2e: commit from the composed page')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await sleep(500)
  await evaluate(`(function () {
    var btn = [].slice.call(document.querySelectorAll('.scw-btn')).filter(function (b) { return /提交|Commit/.test(b.textContent) })[0]
    if (btn && !btn.disabled) btn.click()
  })()`)
  await sleep(3000)

  const logAfter = git(['log', '--oneline', '-3'], gitRepo).trim()
  check('the commit box committed to the REAL repository', logAfter.indexOf('e2e: commit from the composed page') >= 0, logAfter)

  /* ============================== the five modes ============================== */

  /* These are what make this page a replacement for the files page and the git
     page rather than a third thing beside them, so they get the same treatment as
     the commit flow: driven for real, asserted on the DOM. */
  const clickMode = async (label) => evaluate(`(function () {
    var modes = [].slice.call(document.querySelectorAll('.scw-mode'))
    var target = modes.filter(function (m) { return m.textContent.indexOf(${JSON.stringify(label)}) >= 0 })[0]
    if (!target) return 'missing'
    target.click()
    return 'ok'
  })()`)

  const modeLabels = await evaluate('JSON.stringify([].slice.call(document.querySelectorAll(".scw-mode")).map(function(n){return n.textContent}))')
  check('the left pane offers five modes', String(modeLabels).indexOf('变更') >= 0 && String(modeLabels).indexOf('历史') >= 0
    && String(modeLabels).indexOf('分支') >= 0 && String(modeLabels).indexOf('贮藏') >= 0, modeLabels)

  /* ---- 变更: grouping ---- */
  await clickMode('变更')
  await sleep(900)
  const changesDom = JSON.parse(await evaluate(`JSON.stringify({
    groups: [].slice.call(document.querySelectorAll('.scw-groupName')).map(function(n){return n.textContent}),
    rows: [].slice.call(document.querySelectorAll('.scw-changeList .scw-rowName')).map(function(n){return n.textContent}),
    letters: [].slice.call(document.querySelectorAll('.scw-changeList .scw-letter')).map(function(n){return n.textContent}),
  })`))
  check('the 变更 mode groups changes instead of listing them flat',
    Array.isArray(changesDom.groups) && changesDom.groups.length > 0, changesDom.groups)
  check('the untracked file appears with a U badge in 变更',
    Array.isArray(changesDom.letters) && changesDom.letters.indexOf('U') >= 0, changesDom.letters)
  check('变更 groups by change type: deleted and added',
    changesDom.groups.some(function (s) { return /删除|Deleted/.test(s) })
    && changesDom.groups.some(function (s) { return /新增|Added/.test(s) }), changesDom.groups)

  /* A type group collapses and expands from its header. */
  await evaluate(`(function () {
    var header = [].slice.call(document.querySelectorAll('.scw-group')).filter(function (g) {
      return /删除|Deleted/.test(g.textContent)
    })[0]
    if (header) header.click()
  })()`)
  await sleep(350)
  const collapsedGroups = JSON.parse(await evaluate(`JSON.stringify({
    rows: document.querySelectorAll('.scw-changeList .scw-rowName').length,
    collapsed: document.querySelectorAll('.scw-group.is-collapsed').length,
  })`))
  check('clicking a change-type header collapses its rows',
    collapsedGroups.collapsed >= 1 && collapsedGroups.rows < changesDom.rows.length, collapsedGroups)
  await evaluate(`(function () {
    var header = document.querySelector('.scw-group.is-collapsed')
    if (header) header.click()
  })()`)
  await sleep(350)
  const expandedRows = await evaluate('document.querySelectorAll(".scw-changeList .scw-rowName").length')
  check('clicking it again expands the rows back', expandedRows === changesDom.rows.length, expandedRows)

  /* ---- 历史 ---- */
  await clickMode('历史')
  await waitFor("document.querySelectorAll('.scw-commitRow').length >= 2")
  const historyDom = JSON.parse(await evaluate(`JSON.stringify({
    commits: [].slice.call(document.querySelectorAll('.scw-commitSubject')).map(function(n){return n.textContent}),
    graphs: document.querySelectorAll('.scw-commitRow .scw-graph').length,
    titles: [].slice.call(document.querySelectorAll('.scw-commitRow')).map(function(n){return n.getAttribute('title') || ''}),
  })`))
  check('the 历史 mode lists the real commits', Array.isArray(historyDom.commits) && historyDom.commits.length >= 2, historyDom.commits)
  /* The short hash is no longer a visible column — it was noise next to the graph. It
   must still be REACHABLE: the row tooltip carries the full hash. */
  check('the commit list draws a graph instead of a hash column',
    historyDom.graphs >= 2, historyDom.graphs)
  check('the full hash is still reachable from the row tooltip',
    Array.isArray(historyDom.titles) && historyDom.titles.filter(function (x) { return /^[0-9a-f]{40}/.test(x) }).length >= 2,
    (historyDom.titles || []).slice(0, 2))

  /* Right-click a history row: normal commit operations live here too. */
  await evaluate(`(function () {
    var row = document.querySelector('.scw-commitRow')
    if (!row) return 'no-row'
    var rect = row.getBoundingClientRect()
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 20, clientY: rect.top + 10 }))
    return 'ok'
  })()`)
  await sleep(450)
  const historyMenu = JSON.parse(await evaluate(`JSON.stringify({
    open: document.querySelectorAll('.scw-dialog').length > 0,
    title: document.querySelector('.scw-dialogHead') ? document.querySelector('.scw-dialogHead').textContent : '',
    items: [].slice.call(document.querySelectorAll('.scw-menuItem')).map(function (n) { return n.textContent }),
  })`))
  check('a history row right-click opens the commit menu', historyMenu.open === true && String(historyMenu.title).length > 0, historyMenu)
  check('the commit menu offers view / copy / branch / cherry-pick / reset',
    historyMenu.items.some(function (s) { return /查看详情|View details/.test(s) })
    && historyMenu.items.some(function (s) { return /复制短哈希|Copy short hash/.test(s) })
    && historyMenu.items.some(function (s) { return /新建分支|New branch/.test(s) })
    && historyMenu.items.some(function (s) { return /拣选|cherry|Cherry/.test(s) })
    && historyMenu.items.some(function (s) { return /复位|重置|Reset/.test(s) }), historyMenu.items)
  check('the commit menu opens the commit in a browser (remote configured)',
    historyMenu.items.some(function (s) { return /在浏览器打开|Open in browser/.test(s) }), historyMenu.items)
  await evaluate(`(function () {
    var dialog = document.querySelector('.scw-dialog')
    if (dialog) dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })()`)
  await sleep(300)


  /* ---- 历史: commit detail ---- */
  await evaluate(`(function () {
    var rows = [].slice.call(document.querySelectorAll('.scw-commitRow'))
    var target = rows.filter(function (r) { return r.textContent.indexOf('initial') >= 0 })[0]
    if (target) target.click()
  })()`)
  await waitFor("document.querySelector('.scw-commitPatch') !== null || document.querySelector('.scw-commitDetail') !== null")
  const detailDom = JSON.parse(await evaluate(`JSON.stringify({
    present: document.querySelector('.scw-commitPatch') !== null || document.querySelector('.scw-commitDetail') !== null,
    subject: document.querySelector('.scw-commitSubject.is-large') ? document.querySelector('.scw-commitSubject.is-large').textContent : null,
    filesLabel: document.querySelector('.scw-commitFilesLabel') ? document.querySelector('.scw-commitFilesLabel').textContent : null,
    files: [].slice.call(document.querySelectorAll('.scw-commitFileName')).map(function(n){return n.textContent}),
  })`))
  /* A version opens its whole patch first; the file list is one Back away. */
  check('selecting a commit opens its patch view',
    detailDom.present === true, detailDom)
  await evaluate(`(function () {
    var back = document.querySelector('.scw-commitPatch .scw-back')
    if (back) back.click()
  })()`)
  await waitFor("document.querySelector('.scw-commitDetail') !== null")
  const listDom = JSON.parse(await evaluate(`JSON.stringify({
    present: document.querySelector('.scw-commitDetail') !== null,
    files: [].slice.call(document.querySelectorAll('.scw-commitFileName')).map(function (n) { return n.textContent }),
  })`))
  check('Back from the patch shows the commit file list',
    listDom.present === true && Array.isArray(listDom.files) && listDom.files.length > 0, listDom)

  /* A commit made OUTSIDE the workbench (IDE/CLI) must appear after 刷新.
     gitcraft caches the log by watcher revision; the source-control page does
     not run that long-poll watcher, so the cache used to stay at revision 0. */
  writeFileSync(path.join(gitRepo, 'refresh-probe.ts'), 'export const probe = 1\n')
  git(['add', 'refresh-probe.ts'], gitRepo)
  git(['commit', '-q', '-m', 'refresh-probe'], gitRepo)
  const refreshClicked = await evaluate(`(function () {
    var buttons = [].slice.call(document.querySelectorAll('button'))
    var btn = buttons.filter(function (b) {
      return /刷新|Refresh/.test(b.title || '') || /刷新|Refresh/.test(b.getAttribute('aria-label') || '')
    })[0]
    if (!btn) return 'missing'
    btn.click()
    return 'ok'
  })()`)
  const refreshed = await waitFor("document.body.innerText.indexOf('refresh-probe') >= 0", 12000)
  check('刷新 reloads history after an external commit', refreshClicked === 'ok' && refreshed === true,
    { refreshClicked, refreshed })

  /* ---- 分支 ---- */
  await clickMode('分支')
  await waitFor("document.querySelector('.scw-branchRow') !== null")
  const branchDom = JSON.parse(await evaluate(`JSON.stringify({
    branches: [].slice.call(document.querySelectorAll('.scw-branchName')).map(function(n){return n.textContent}),
    head: document.querySelectorAll('.scw-branchRow.is-head').length,
  })`))
  check('the 分支 mode lists the branch and marks HEAD', Array.isArray(branchDom.branches) && branchDom.branches.length >= 1 && branchDom.head === 1, branchDom)

  /* Remote web address (converted from https://….git) + right-click menus. */
  let branchUi = { url: null, remoteGroups: 0 }
  for (let attempt = 0; attempt < 24; attempt += 1) {
    branchUi = JSON.parse(await evaluate(`JSON.stringify({
      url: document.querySelector('.scw-remoteUrl') ? document.querySelector('.scw-remoteUrl').textContent : null,
      remoteGroups: document.querySelectorAll('.scw-remoteGroup').length,
    })`))
    if (branchUi.url !== null) break
    await sleep(250)
  }
  check('the branches page shows the remote web address',
    branchUi.remoteGroups >= 1 && /^https:\/\/gitea\.idoocn\.com\.?/.test(String(branchUi.url)), branchUi)

  await evaluate(`(function () {
    var row = document.querySelector('.scw-branchRow')
    if (!row) return 'no-row'
    var rect = row.getBoundingClientRect()
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 20, clientY: rect.top + 10 }))
    return 'ok'
  })()`)
  await sleep(450)
  const branchMenu = JSON.parse(await evaluate(`JSON.stringify({
    open: document.querySelectorAll('.scw-dialog').length > 0,
    title: document.querySelector('.scw-dialogHead') ? document.querySelector('.scw-dialogHead').textContent : '',
    items: [].slice.call(document.querySelectorAll('.scw-menuItem')).map(function (n) { return n.textContent }),
  })`))
  check('a branch row right-click opens its menu', branchMenu.open === true && String(branchMenu.title).length > 0, branchMenu)
  check('the branch menu offers copy / open in browser / rename',
    branchMenu.items.some(function (s) { return /复制名称|Copy name/.test(s) })
    && branchMenu.items.some(function (s) { return /在浏览器打开|Open in browser/.test(s) })
    && branchMenu.items.some(function (s) { return /重命名|Rename/.test(s) }), branchMenu.items)
  await evaluate(`(function () {
    var dialog = document.querySelector('.scw-dialog')
    if (dialog) dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })()`)
  await sleep(300)

  await evaluate(`(function () {
    var row = document.querySelector('.scw-remoteGroup')
    if (!row) return 'no-row'
    var rect = row.getBoundingClientRect()
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 20, clientY: rect.top + 10 }))
    return 'ok'
  })()`)
  await sleep(450)
  const remoteMenu = JSON.parse(await evaluate(`JSON.stringify({
    open: document.querySelectorAll('.scw-dialog').length > 0,
    items: [].slice.call(document.querySelectorAll('.scw-menuItem')).map(function (n) { return n.textContent }),
  })`))
  check('the remote group menu offers copy URL and fetch',
    remoteMenu.open === true && remoteMenu.items.some(function (s) { return /复制远程地址|Copy remote URL/.test(s) })
    && remoteMenu.items.some(function (s) { return /获取此远程|Fetch this remote/.test(s) }), remoteMenu.items)
  await evaluate(`(function () {
    var dialog = document.querySelector('.scw-dialog')
    if (dialog) dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })()`)
  await sleep(300)


  /* ---- 贮藏 (empty here, but the panel must render honestly) ---- */
  await clickMode('贮藏')
  await sleep(1500)
  const stashDom = JSON.parse(await evaluate(`JSON.stringify({
    rows: document.querySelectorAll('.scw-stashRow').length,
    state: document.querySelector('.scw-treeState') ? document.querySelector('.scw-treeState').textContent : null,
  })`))
  check('the 贮藏 mode says it is empty rather than rendering nothing', stashDom.rows === 0 && stashDom.state !== null, stashDom)

  /* ---- 文件 back ---- */
  await clickMode('文件')
  await sleep(900)
  const filesDom = JSON.parse(await evaluate('JSON.stringify([].slice.call(document.querySelectorAll(".scw-treePane .scw-rowName")).map(function(n){return n.textContent}))'))
  check('the 文件 mode comes back to the tree', Array.isArray(filesDom) && filesDom.length > 0, filesDom)

  /* ---- 文件: "changes only" must include DELETED files (no disk entry) ---- */
  await evaluate(`(function () {
    var btn = [].slice.call(document.querySelectorAll('.scw-toolIcon')).filter(function (b) {
      return /只看变更|Changes only/.test(b.title || '')
    })[0]
    if (btn) btn.click()
    return btn ? 'ok' : 'missing'
  })()`)
  await waitFor("document.querySelector('.scw-row.is-missing') !== null")
  const deletedFilter = JSON.parse(await evaluate(`JSON.stringify({
    rows: [].slice.call(document.querySelectorAll('.scw-row.is-missing')).map(function (n) { return n.textContent }),
    letters: [].slice.call(document.querySelectorAll('.scw-row.is-missing .scw-letter')).map(function (n) { return n.textContent }),
  })`))
  check('changes-only lists the deleted file as a D record',
    deletedFilter.rows.some(function (s) { return /gone\.ts/.test(s) }) && deletedFilter.letters.indexOf('D') >= 0, JSON.stringify(deletedFilter))
  await evaluate(`(function () {
    var row = [].slice.call(document.querySelectorAll('.scw-row.is-missing')).filter(function (r) { return /gone\.ts/.test(r.textContent) })[0]
    if (row) row.click()
  })()`)
  await waitFor("document.querySelectorAll('.gwc-row').length > 0")
  const deletedDiff = JSON.parse(await evaluate(`JSON.stringify({
    rows: document.querySelectorAll('.gwc-row').length,
    text: document.querySelector('.scw-paneHost') ? document.querySelector('.scw-paneHost').innerText.slice(0, 200) : '',
  })`))
  check('clicking the deleted file opens its deletion patch',
    deletedDiff.rows > 0 && (deletedDiff.text.indexOf('gone.ts') >= 0 || deletedDiff.text.indexOf('deleted') >= 0 || deletedDiff.text.indexOf('@@') >= 0), deletedDiff)

  /* Back to all files for the remaining file-tree checks. */
  await evaluate(`(function () {
    var btn = [].slice.call(document.querySelectorAll('.scw-toolIcon')).filter(function (b) {
      return /显示全部文件|Show all files/.test(b.title || '')
    })[0]
    if (btn) btn.click()
  })()`)
  await sleep(400)

  /* ============================== search ============================== */

  const typeSearch = async (text) => evaluate(`(function () {
    var el = document.querySelector('.scw-searchInput')
    if (!el) return 'missing'
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(el, ${JSON.stringify(text)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  })()`)

  await typeSearch('alpha')
  await sleep(1400)
  const nameSearch = JSON.parse(await evaluate(`JSON.stringify({
    rows: [].slice.call(document.querySelectorAll('.scw-searchResults .scw-rowName')).map(function(n){return n.textContent}),
    hits: document.querySelectorAll('.scw-hit').length,
  })`))
  check('searching by name finds the file and highlights the match',
    Array.isArray(nameSearch.rows) && nameSearch.rows.indexOf('alpha.ts') >= 0 && nameSearch.hits > 0, nameSearch)

  /* Content mode, through the same box. */
  await evaluate(`(function () {
    var tabs = [].slice.call(document.querySelectorAll('.scw-searchMode'))
    var content = tabs.filter(function (x) { return /内容|Content/.test(x.textContent) })[0]
    if (content) content.click()
  })()`)
  await sleep(400)
  await typeSearch('extra')
  await sleep(1800)
  const contentSearch = JSON.parse(await evaluate(`JSON.stringify({
    matchRows: document.querySelectorAll('.scw-matchRow').length,
    texts: [].slice.call(document.querySelectorAll('.scw-matchText')).map(function(n){return n.textContent}),
  })`))
  check('searching by content finds the line inside the file',
    contentSearch.matchRows > 0 && contentSearch.texts.join(' ').indexOf('extra') >= 0, contentSearch)

  /* Clicking a content hit must move the editor to that line, not line 1. */
  await evaluate(`(function () {
    var row = document.querySelector('.scw-matchRow')
    if (row) row.click()
  })()`)
  await waitFor("document.querySelector('.cm-activeLine') !== null")
  const jumped = JSON.parse(await evaluate(`JSON.stringify({
    active: document.querySelector('.cm-activeLine') ? document.querySelector('.cm-activeLine').textContent : '',
    gutter: document.querySelector('.cm-activeLineGutter') ? document.querySelector('.cm-activeLineGutter').textContent : '',
    errors: window.__ERRORS__,
  })`))
  check('clicking a content hit opens the file at the matching line',
    String(jumped.active).indexOf('extra') >= 0 || String(jumped.gutter).trim() === '2', jumped)

  /* Esc returns to browsing: the search box is the innermost scope. */
  await evaluate(`(function () {
    var el = document.querySelector('.scw-searchInput')
    if (el) el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })()`)
  await sleep(700)
  const afterEsc = JSON.parse(await evaluate(`JSON.stringify({
    value: document.querySelector('.scw-searchInput') ? document.querySelector('.scw-searchInput').value : null,
    resultsGone: document.querySelectorAll('.scw-searchResults').length === 0,
  })`))
  check('Esc clears the search and returns to the tree', afterEsc.value === '' && afterEsc.resultsGone === true, afterEsc)
  /* Typing must not rebuild the input.
     The search used to return a DIFFERENT child list, so React reconciled index 0
     differently and unmounted the input on the first keystroke — you could type one
     character and then nothing. Two checks: the node identity survives a full search
     cycle, and several keystrokes accumulate. */
  /* Back to NAME mode: the content-mode test above left the box in content mode, and
     "alpha" does not appear in the file's contents. */
  await evaluate(`(function () {
    var tabs = [].slice.call(document.querySelectorAll('.scw-searchMode'))
    var name = tabs.filter(function (x) { return /文件名|Files/.test(x.textContent) })[0]
    if (name) name.click()
  })()`)
  await sleep(500)
  await evaluate(`window.__SEARCH_REF__ = document.querySelector('.scw-searchInput')`)
  await typeSearch('alpha')
  await sleep(1500)
  check('the search input survives a search cycle (same DOM node)',
    (await evaluate(`window.__SEARCH_REF__ === document.querySelector('.scw-searchInput')`)) === true)

  await typeSearch('alpha.')
  await sleep(1300)
  await typeSearch('alpha')
  await sleep(1500)
  const accumulated = JSON.parse(await evaluate(`JSON.stringify({
    value: document.querySelector('.scw-searchInput') ? document.querySelector('.scw-searchInput').value : null,
    rows: [].slice.call(document.querySelectorAll('.scw-searchResults .scw-rowName')).map(function (n) { return n.textContent }),
  })`))
  check('typing keeps accumulating instead of stopping after one character',
    accumulated.value === 'alpha', accumulated)
  check('and the results track the full query',
    Array.isArray(accumulated.rows) && accumulated.rows.indexOf('alpha.ts') >= 0, accumulated)

  await evaluate(`(function () { var el = document.querySelector('.scw-searchInput'); if (el) el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })()`)
  await sleep(700)

  /* ---- right-click row menu (replaces the old hover @ button) ---- */
  await evaluate(`(function () {
    var rows = [].slice.call(document.querySelectorAll('.scw-row'))
    var row = rows.filter(function (r) { return r.textContent.indexOf('alpha.ts') >= 0 && r.className.indexOf('is-dir') < 0 })[0]
    if (!row) return 'no-row'
    var rect = row.getBoundingClientRect()
    row.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: rect.left + 20, clientY: rect.top + 10,
    }))
    return 'ok'
  })()`)
  await sleep(500)
  const rowMenu = JSON.parse(await evaluate(`JSON.stringify({
    open: document.querySelectorAll('.scw-dialog').length > 0,
    title: document.querySelector('.scw-dialogHead') ? document.querySelector('.scw-dialogHead').textContent : '',
    body: document.querySelector('.scw-dialogBody') ? document.querySelector('.scw-dialogBody').textContent : '',
    items: [].slice.call(document.querySelectorAll('.scw-menuItem')).map(function (n) { return n.textContent }),
    atButtons: [].slice.call(document.querySelectorAll('.scw-row .scw-rowBtn')).filter(function (n) { return n.textContent === '@' }).length,
  })`))
  check('right-click opens the file menu', rowMenu.open === true && /alpha\.ts/.test(rowMenu.title), rowMenu)
  check('the row menu offers add-to-chat, reveal, ignore and delete',
    rowMenu.items.some(function (s) { return /加入对话|Add to chat/.test(s) })
    && rowMenu.items.some(function (s) { return /打开文件所在目录|Reveal/.test(s) })
    && rowMenu.items.some(function (s) { return /添加忽略|Add to \.gitignore/.test(s) })
    && rowMenu.items.some(function (s) { return /删除|Delete/.test(s) }), rowMenu.items)
  check('the row menu body is the absolute host path', /^[A-Za-z]:[\\/]/.test(rowMenu.body), rowMenu.body)
  check('the hover @ button is gone', rowMenu.atButtons === 0, rowMenu.atButtons)
  await evaluate(`(function () {
    var dialog = document.querySelector('.scw-dialog')
    if (dialog) dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })()`)
  await sleep(300)

  /* Undo-commit: reset the branch to the first commit and restore the removed
     commit's message into the box (VS Code behaviour). */
  await clickMode('历史')
  await waitFor("document.querySelectorAll('.scw-commitRow').length >= 2")
  await evaluate(`(function () {
    var rows = [].slice.call(document.querySelectorAll('.scw-commitRow'))
    var target = rows.filter(function (r) { return r.textContent.indexOf('initial') >= 0 })[0]
    if (!target) return 'no-target'
    var rect = target.getBoundingClientRect()
    target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 20, clientY: rect.top + 10 }))
    return 'ok'
  })()`)
  await sleep(450)
  await evaluate(`(function () {
    var item = [].slice.call(document.querySelectorAll('.scw-menuItem')).filter(function (n) {
      return /^复位$|^Reset$/.test((n.textContent || '').trim())
    })[0]
    if (item) item.click()
  })()`)
  await sleep(350)
  const resetPicked = await evaluate(`(function () {
    var item = [].slice.call(document.querySelectorAll('.scw-menuItem')).filter(function (n) {
      return /软复位|Soft/.test(n.textContent)
    })[0]
    if (!item) return 'missing'
    item.click()
    return 'ok'
  })()`)
  await sleep(3000)
  const undone = JSON.parse(await evaluate(`JSON.stringify({
    message: document.querySelector('.scw-commitInput') ? document.querySelector('.scw-commitInput').value : null,
  })`))
  const resetHead = git(['log', '-1', '--format=%s'], gitRepo).trim()
  check('a soft reset restores the removed commit message into the commit box',
    resetPicked === 'ok' && resetHead === 'initial' && undone.message === 'refresh-probe',
    JSON.stringify({ resetPicked, resetHead, undone }))

  const finalErrors = JSON.parse(await evaluate('JSON.stringify(window.__ERRORS__)'))
  check('no console errors across the whole flow', Array.isArray(finalErrors) && finalErrors.length === 0, JSON.stringify(finalErrors))
} finally {
  cleanup()
}

console.log('')
console.log('e2e: ' + (report.length - failures) + '/' + report.length + ' passed')
process.exit(failures === 0 ? 0 : 1)









