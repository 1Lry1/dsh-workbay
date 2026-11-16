/**
 * Reusable "real shell" harness for interaction tests.
 *
 * Boots the real dock client + real pages inside headless Chromium so a test can
 * click/scroll the DOM a user actually sees. Returns CDP helpers plus a cleanup.
 *
 *   const h = await startRealHarness({ windowSize: '1400,900' })
 *   await h.ev('...')            // evaluate in the page
 *   await h.send('Page.captureScreenshot', {...})
 *   await h.close()
 */
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..', '..')
const REACTDIR = process.env.WORKBAY_REACT_DIR ?? path.join(tmpdir(), 'wbreact', 'node_modules')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function startRealHarness(options = {}) {
  const browser = options.browser ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  const windowSize = options.windowSize ?? '1400,900'
  const dockWidth = String(options.dockWidth ?? 1000)
  const layout = options.layout ?? 'auto'
  const dockOpen = options.dockOpen !== false

  const work = mkdtempSync(path.join(tmpdir(), 'realshell-'))
  const gitRepo = path.join(work, 'repo')
  const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  mkdirSync(path.join(gitRepo, 'src', 'core'), { recursive: true })
  mkdirSync(path.join(gitRepo, 'docs'), { recursive: true })
  git(['init', '-q', '-b', 'feature/realshell'], gitRepo)
  git(['config', 'user.email', 'qa@example.com'], gitRepo)
  git(['config', 'user.name', 'QA'], gitRepo)
  writeFileSync(path.join(gitRepo, 'src', 'main.c'), 'int main(void) {\n  return 0;\n}\n')
  writeFileSync(path.join(gitRepo, 'src', 'core', 'stack.c'), 'void stack_init(void) {}\n')
  writeFileSync(path.join(gitRepo, 'docs', 'guide.md'), '# guide\n')
  writeFileSync(path.join(gitRepo, 'README.md'), '# demo\n')
  git(['add', '-A'], gitRepo)
  git(['commit', '-q', '-m', 'chore: seed'], gitRepo)
  /* A second author, so blame has more than one colour to show. */
  writeFileSync(path.join(gitRepo, 'src', 'main.c'), 'int main(void) {\n  return 0;\n}\n/* touched by the second author */\n')
  git(['-c', 'user.name=Second Dev', '-c', 'user.email=second@example.com', 'commit', '-q', '-am', 'fix: note by second author'], gitRepo)
  /* A third author: the blame legend must assign a DIFFERENT colour to each. */
  writeFileSync(path.join(gitRepo, 'src', 'main.c'), 'int main(void) {\n  return 0;\n}\n/* touched by the second author */\n/* third author was here */\n')
  git(['-c', 'user.name=Third Dev', '-c', 'user.email=third@example.com', 'commit', '-q', '-am', 'fix: third author note'], gitRepo)
  writeFileSync(path.join(gitRepo, 'src', 'main.c'), 'int main(void) { return 1; }\n')
  writeFileSync(path.join(gitRepo, 'CHANGELOG.md'), '- one\n')
  /* Extra refs so the Branches view has something worth testing: two branches
     under one folder prefix (the foldering rule) and a tag. */
  git(['branch', 'feature/alpha'], gitRepo)
  git(['branch', 'feature/beta'], gitRepo)
  git(['tag', 'v1.0'], gitRepo)

  /* Optional memory-map page: a throwaway SDK tree + a fake interpreter, so the
     memmap e2e never depends on Python being installed on the machine. */
  const memmapOption = options.memmap === undefined || options.memmap === null || options.memmap === false
    ? null
    : (options.memmap === true ? {} : options.memmap)
  const memmapRoot = memmapOption === null ? '' : (memmapOption.workspace ?? path.join(work, 'sdk'))
  if (memmapOption !== null) {
    mkdirSync(memmapRoot, { recursive: true })
    if (memmapOption.sibling === true) {
      /* The map-less project sits NEXT TO an SDK that owns a map: this is the
         "nearby candidates" case (…/ido/project-a/demo beside …/ido/579x_SDK). */
      const sibling = path.join(path.dirname(memmapRoot), '579x_SDK')
      mkdirSync(path.join(sibling, 'tools', 'memmap_report'), { recursive: true })
      writeFileSync(path.join(sibling, 'tools', 'memmap_report', 'memmap_report.py'), '#!/usr/bin/env python3\n', 'utf8')
      mkdirSync(path.join(sibling, 'app', 'projects', 'standard', 'Output', 'bin'), { recursive: true })
      writeFileSync(path.join(sibling, 'app', 'projects', 'standard', 'Output', 'bin', 'map.txt'), 'Memory Configuration\nsibling map\n', 'utf8')
    }
    if (memmapOption.empty !== true && memmapOption.project === true) {
      /* A standalone project: no tools/ copy at all — the bundled script must be
         used, and the map sits directly under the project root. */
      mkdirSync(path.join(memmapRoot, 'Output', 'bin'), { recursive: true })
      writeFileSync(path.join(memmapRoot, 'Output', 'bin', 'map.txt'), 'Memory Configuration\nrealshell project map\n', 'utf8')
    } else if (memmapOption.empty !== true) {
      mkdirSync(path.join(memmapRoot, 'tools', 'memmap_report'), { recursive: true })
      writeFileSync(path.join(memmapRoot, 'tools', 'memmap_report', 'memmap_report.py'), '#!/usr/bin/env python3\n', 'utf8')
      mkdirSync(path.join(memmapRoot, 'app', 'projects', 'standard', 'Output', 'bin'), { recursive: true })
      writeFileSync(path.join(memmapRoot, 'app', 'projects', 'standard', 'Output', 'bin', 'map.txt'), 'Memory Configuration\nrealshell map\n', 'utf8')
      /* A second project whose map is OLDER, so standard stays the auto-run
         choice while the picker still offers both. */
      const secondMapDir = path.join(memmapRoot, 'app', 'projects', 'watch466', 'Output', 'bin')
      mkdirSync(secondMapDir, { recursive: true })
      const secondMap = path.join(secondMapDir, 'map.txt')
      writeFileSync(secondMap, 'Memory Configuration\nrealshell watch map\n', 'utf8')
      const backdated = new Date(Date.now() - 60_000)
      utimesSync(secondMap, backdated, backdated)
    }
  }
  const fakeRunner = path.join(repo, 'packages/memmap/tests/fixtures/fake_memmap_runner.mjs')
  const hostBundles = [
    [path.join(repo, 'packages/files/src/index.js'), { allowWrite: true, maxFileBytes: 1048576 }],
    [path.join(repo, 'packages/gitcraft/src/index.js'), { refreshIntervalMs: 15000, timeoutMs: 30000, networkTimeoutMs: 180000, defaultDiffView: 'unified' }],
  ]
  if (memmapOption !== null) {
    hostBundles.push([path.join(repo, 'packages/memmap/src/index.js'), {
      python: [process.execPath, fakeRunner],
      dataDir: memmapOption.dataDir ?? path.join(work, 'memmap-data'),
      timeoutMs: 60000,
      keepRuns: 5,
    }])
  }

  const routes = []
  for (const [entry, config] of hostBundles) {
    const mod = await import('file:///' + entry.split(path.sep).join('/'))
    const ctx = {
      webServer: { register(r) { routes.push(r); return () => {} } },
      effect(fn) { try { const d = fn(); return typeof d === 'function' ? d : () => {} } catch { return () => {} } },
      get() {}, provide() {}, inject(n, cb) { cb(ctx) }, logger: { error() {}, warn() {}, info() {} },
    }
    mod.apply(ctx, config)
  }

  const assets = new Map()
  const add = (url, file) => { try { assets.set(url, readFileSync(file)) } catch { /* optional */ } }
  add('/react.js', path.join(REACTDIR, 'react/umd/react.production.min.js'))
  add('/react-dom.js', path.join(REACTDIR, 'react-dom/umd/react-dom.production.min.js'))
  add('/b-dock.js', path.join(repo, 'packages/dock/src/client.js'))
  add('/b-files.js', path.join(repo, 'packages/files/src/client.js'))
  add('/b-gitcraft.js', path.join(repo, 'packages/gitcraft/src/client.js'))
  add('/b-source-control.js', path.join(repo, 'packages/source-control/src/client.js'))
  add('/b-memmap.js', path.join(repo, 'packages/memmap/src/client.js'))
  add('/dsh-workbay-files/chunk/editor.js', path.join(repo, 'packages/files/lib/chunks/editor.js'))

  const html = `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;background:#14161a;color:#e6e8eb;font:13px/1.4 "Segoe UI",system-ui,sans-serif}</style>
</head><body>
<script>window.__REG__=[];window.__ERRORS__=[];
addEventListener('error',e=>window.__ERRORS__.push('error: '+String(e.message)));
addEventListener('unhandledrejection',e=>window.__ERRORS__.push('reject: '+String(e.reason)));
window.__ModuleLoader__={load(d){window.__REG__.push(d);return()=>{}}}</script>
<script src="/react.js"></script><script src="/react-dom.js"></script>
<script>
window.__DSH_WORKBAY__={_pages:[],_subs:[],registerPage(p){this._pages.push(p);for(var i=0;i<this._subs.length;i++){(function(f){try{f()}catch(e){window.__ERRORS__.push('sub: '+e.message)}})(this._subs[i])}return function(){}},list(){return this._pages.slice()},get(id){for(var i=0;i<this._pages.length;i++)if(this._pages[i].id===id)return this._pages[i];return null},subscribe(f){this._subs.push(f);return function(){}},open(){},close(){},toggle(){},isOpen(){return false}}
function seedRequire(n){if(n==='react')return window.React;if(n==='react-dom')return window.ReactDOM;if(n==='react-dom/client')return window.ReactDOM;if(n==='react/jsx-runtime')return{createElement:window.React.createElement,Fragment:window.React.Fragment};throw new Error('miss '+n)}
window.__SLOT_ENTRIES__=(window.__SLOT_ENTRIES__||[]);window.__WS__=${JSON.stringify(gitRepo)};window.__MM__=${JSON.stringify(memmapRoot)};
window.__BOOT__=async function(){
  var services=new Map();
  services.set('locale',{register(){},subscribe(){return()=>{}},getSnapshot(){return{active:'zh'}}});
services.set('slots',{_views:[],_entries:[],register(d,c){this._entries.push({def:d,comp:c});window.__SLOT_ENTRIES__.push({def:d,comp:c});return function(){}},inject(n,fn){try{fn()}catch(e){window.__ERRORS__.push('slots:'+e.message)}return function(){}}});
  function mk(){return {effect(fn){try{var d=fn();return typeof d==='function'?d:()=>{}}catch(e){window.__ERRORS__.push('eff:'+e.message);return()=>{}}},get(n){return services.get(n)},provide(n,v){services.set(n,v)},inject(n,cb){try{cb(mk())}catch(e){window.__ERRORS__.push('inj:'+e.message)}},logger:{error(){},warn(){},info(){}}}}
  for(var i=0;i<window.__REG__.length;i++){var r=window.__REG__[i];try{var p=r.factory(seedRequire);if(typeof p.apply==='function')await p.apply(mk())}catch(e){window.__ERRORS__.push(r.id+': '+e.message)}}
  return true
};
</script>
<script src="/b-dock.js"></script><script src="/b-files.js"></script><script src="/b-gitcraft.js"></script><script src="/b-source-control.js"></script>${memmapOption !== null ? '<script src="/b-memmap.js"></script>' : ''}
</body></html>`

  const server = createServer((req, res) => {
    for (const r of routes) if (req.url.startsWith(r.path)) return r.handler(req, res)
    const clean = req.url.split('?')[0]
    if (clean === '/' || clean === '/index.html') { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(html); return }
    if (assets.has(clean)) { res.setHeader('content-type', 'text/javascript; charset=utf-8'); res.end(assets.get(clean)); return }
    res.statusCode = 404; res.end('{}')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + server.address().port

  const profileDir = mkdtempSync(path.join(tmpdir(), 'realshell-cdp-'))
  const child = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--window-size=' + windowSize, '--remote-debugging-port=0', '--user-data-dir=' + profileDir, base + '/'], { stdio: 'ignore' })

  let wsUrl = null
  for (let i = 0; i < 120 && !wsUrl; i += 1) {
    try {
      const txt = readFileSync(path.join(profileDir, 'DevToolsActivePort'), 'utf8').split('\n')
      const list = await (await fetch('http://127.0.0.1:' + Number(txt[0]) + '/json/list')).json()
      const page = list.find((entry) => entry.type === 'page')
      if (page) wsUrl = page.webSocketDebuggerUrl
    } catch { /* not up yet */ }
    if (!wsUrl) await sleep(200)
  }
  if (!wsUrl) throw new Error('devtools never came up')

  let idc = 0
  const pending = new Map()
  const ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id) }
  }
  const send = (method, params) => new Promise((resolve) => { const id = ++idc; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params: params ?? {} })) })
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    const x = r.result
    if (x && x.exceptionDetails) return { __exc: x.exceptionDetails.text }
    return x && x.result ? x.result.value : undefined
  }
  await send('Runtime.enable'); await send('Page.enable'); await sleep(1200)

  await ev(`(function(){
    try {
      localStorage.setItem('dsh-workbay-dock.mode.v1','docked')
      localStorage.setItem('dsh-workbay-dock.dockw.v1','${dockWidth}')
      localStorage.setItem('dsh-workbay-dock.layout.v1','${layout}')
      localStorage.setItem('dsh-workbay-dock.open.v1', '${dockOpen ? 'true' : 'false'}')
      localStorage.setItem('dsh-workbay.zoom.v1','1.1')
      localStorage.setItem('dsh-workbay.sc.root.v1', window.__WS__)
      localStorage.setItem('dsh-workbay.sc.repo.v1', window.__WS__)
      localStorage.setItem('dsh-workbay.root.v1', window.__WS__)
      if (window.__MM__) localStorage.setItem('dsh-workbench-memmap.root.v1', window.__MM__)
    } catch (e) { return 'ls-fail:' + e.message }
    return 'seeded'
  })()`)
  await ev('window.__BOOT__()')
  await sleep(2600)

  const close = async () => {
    try { await send('Browser.close') } catch { /* ignore */ }
    try { child.kill('SIGKILL') } catch { /* ignore */ }
    await sleep(200)
    try { server.close() } catch { /* ignore */ }
    try { rmSync(profileDir, { recursive: true, force: true }) } catch { /* ignore */ }
    try { rmSync(work, { recursive: true, force: true }) } catch { /* ignore */ }
  }

  return { send, ev, close, base, gitRepo, memmapRoot, sleep, work }
}
