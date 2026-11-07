/**
 * Render the composed page in each mode and save screenshots.
 * Not a test — a way to actually LOOK at the result.
 */
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'

const here = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(here, '..', '..', '..')
const EDGE = process.env.WORKBAY_BROWSER ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const REACTDIR = process.env.WORKBAY_REACT_DIR ?? path.join(tmpdir(), 'wbreact', 'node_modules')
const OUT = path.join(REPO, 'packages', 'source-control', 'docs')

const work = mkdtempSync(path.join(tmpdir(), 'shot-'))
const gitRepo = path.join(work, 'repo')
const git = (a, c) => execFileSync('git', a, { cwd: c, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

mkdirSync(gitRepo, { recursive: true })
git(['init', '-q', '-b', 'feature/composed-page'], gitRepo)
git(['config', 'user.email', 'dev@example.com'], gitRepo); git(['config', 'user.name', 'Dev']) 
mkdirSync(path.join(gitRepo, 'src', 'components'), { recursive: true })
mkdirSync(path.join(gitRepo, 'docs'), { recursive: true })
writeFileSync(path.join(gitRepo, 'src', 'app.ts'), 'export const app = create()\n')
writeFileSync(path.join(gitRepo, 'src', 'components', 'Tree.ts'), 'export const Tree = () => null\n')
writeFileSync(path.join(gitRepo, 'src', 'client.js'), 'export const client = 1\n')
writeFileSync(path.join(gitRepo, 'docs', 'guide.md'), '# guide\n')
writeFileSync(path.join(gitRepo, 'README.md'), '# demo\n')
git(['add', '-A'], gitRepo)
git(['commit', '-q', '-m', 'feat: initial workbench pages'], gitRepo)
writeFileSync(path.join(gitRepo, 'src', 'app.ts'), 'export const app = create()\nexport const extra = 1\n')
git(['add', '-A'], gitRepo)
git(['commit', '-q', '-m', 'feat: wire the composed page into the suite'], gitRepo)
writeFileSync(path.join(gitRepo, 'src', 'components', 'Tree.ts'), 'export const Tree = () => null\n// virtualised rows\n')
git(['add', 'src/components/Tree.ts'], gitRepo)
writeFileSync(path.join(gitRepo, 'src', 'client.js'), 'export const client = 2\nexport const search = true\n')
writeFileSync(path.join(gitRepo, 'docs', 'panes.md'), '# panes contract\n')
writeFileSync(path.join(gitRepo, 'CHANGELOG.md'), '- added search\n')

const routes = []
for (const [entry, config] of [
  [path.join(REPO, 'packages/files/src/index.js'), { allowWrite: true, maxFileBytes: 1048576 }],
  [path.join(REPO, 'packages/gitcraft/src/index.js'), { refreshIntervalMs: 15000, timeoutMs: 30000, networkTimeoutMs: 180000, defaultDiffView: 'unified' }],
]) {
  const mod = await import('file:///' + entry.split(path.sep).join('/'))
  const ctx = {
    webServer: { register(r) { routes.push(r); return () => {} } },
    effect(fn) { try { const d = fn(); return typeof d === 'function' ? d : () => {} } catch (e) { return () => {} } },
    get() {}, provide() {}, inject(n, cb) { cb(ctx) }, logger: { error() {}, warn() {}, info() {} },
  }
  mod.apply(ctx, config)
}

const assets = new Map()
const add = (url, file) => { if (existsSync(file)) assets.set(url, readFileSync(file)) }
add('/react.js', path.join(REACTDIR, 'react/umd/react.production.min.js'))
add('/react-dom.js', path.join(REACTDIR, 'react-dom/umd/react-dom.production.min.js'))
add('/b-dock.js', path.join(REPO, 'packages/dock/src/client.js'))
add('/b-files.js', path.join(REPO, 'packages/files/src/client.js'))
add('/b-gitcraft.js', path.join(REPO, 'packages/gitcraft/src/client.js'))
add('/b-sc.js', path.join(REPO, 'packages/source-control/src/client.js'))
add('/dsh-workbay-files/chunk/editor.js', path.join(REPO, 'packages/files/lib/chunks/editor.js'))

const html = `<!doctype html><html><head><meta charset="utf-8">
<style>
html,body{margin:0;height:100%;background:#14161a;color:#e6e8eb;font:13px/1.4 "Segoe UI",system-ui,sans-serif}
#root{height:100%;padding:10px;box-sizing:border-box}
</style></head><body><div id="root"></div>
<script>window.__REG__=[];window.__ModuleLoader__={load(d){window.__REG__.push(d);return()=>{}}}</script>
<script src="/react.js"></script><script src="/react-dom.js"></script>
<script>
window.__DSH_WORKBAY__={_pages:[],_subs:[],registerPage(p){this._pages.push(p);for(var i=0;i<this._subs.length;i++)this._subs[i]();return function(){}},list(){return this._pages.slice()},get(id){for(var i=0;i<this._pages.length;i++)if(this._pages[i].id===id)return this._pages[i];return null},subscribe(f){this._subs.push(f);return function(){}},open(){},close(){},toggle(){},isOpen(){return false}}
window.__ERRORS__=[];addEventListener('error',e=>window.__ERRORS__.push(String(e.message)))
function seedRequire(n){if(n==='react')return window.React;if(n==='react-dom')return window.ReactDOM;if(n==='react-dom/client')return window.ReactDOM;if(n==='react/jsx-runtime')return{createElement:window.React.createElement,Fragment:window.React.Fragment};throw new Error('miss '+n)}
window.__WS__=${JSON.stringify(gitRepo)}
window.__BOOT__=async function(){
  var out={errors:[]}
  var services=new Map()
  services.set('locale',{register(){},subscribe(){return()=>{}},getSnapshot(){return{active:'zh'}}})
  services.set('slots',{register(){return()=>{}},inject(){return()=>{}}})
  function mk(){var c={effect(fn){try{var d=fn();return typeof d==='function'?d:()=>{}}catch(e){out.errors.push('eff:'+e.message);return()=>{}}},get(n){return services.get(n)},provide(n,v){services.set(n,v)},inject(n,cb){try{cb(c)}catch(e){out.errors.push('inj:'+e.message)}},logger:{error(){},warn(){},info(){}}};return c}
  for(var i=0;i<window.__REG__.length;i++){var r=window.__REG__[i];try{var p=r.factory(seedRequire);if(typeof p.apply==='function')await p.apply(mk())}catch(e){out.errors.push(r.id+': '+e.message)}}
  return out
}
window.__MOUNT__=function(){
  localStorage.setItem('dsh-workbay.sc.root.v1',window.__WS__)
  localStorage.setItem('dsh-workbay.sc.repo.v1',window.__WS__)
  localStorage.setItem('dsh-workbay.root.v1',window.__WS__)
  var pg=window.__DSH_WORKBAY__.get('source-control')
  var root=window.ReactDOM.createRoot(document.getElementById('root'))
  root.render(window.React.createElement(pg.component,{t:k=>k,dock:window.__DSH_WORKBAY__}))
  return {ok:true}
}
</script>
<script src="/b-dock.js"></script><script src="/b-files.js"></script><script src="/b-gitcraft.js"></script><script src="/b-sc.js"></script>
</body></html>`

const server = createServer((req, res) => {
  for (const r of routes) if (req.url.startsWith(r.path)) return r.handler(req, res)
  const clean = req.url.split('?')[0]
  if (clean === '/' || clean === '/index.html') { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(html); return }
  if (assets.has(clean)) { res.setHeader('content-type', 'text/javascript; charset=utf-8'); res.end(assets.get(clean)); return }
  res.statusCode = 404; res.end('{}')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = 'http://127.0.0.1:' + server.address().port

mkdirSync(OUT, { recursive: true })
const prof = mkdtempSync(path.join(tmpdir(), 'shot-cdp-'))
const child = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--window-size=1280,760', '--remote-debugging-port=0', '--user-data-dir=' + prof, base + '/'], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let wsUrl = null
for (let i = 0; i < 100 && !wsUrl; i += 1) {
  try {
    const txt = readFileSync(path.join(prof, 'DevToolsActivePort'), 'utf8').split('\n')
    const list = await (await fetch('http://127.0.0.1:' + Number(txt[0]) + '/json/list')).json()
    const t = list.find((x) => x.type === 'page'); if (t) wsUrl = t.webSocketDebuggerUrl
  } catch (e) {}
  if (!wsUrl) await sleep(200)
}
let idc = 0; const pending = new Map()
const ws = new WebSocket(wsUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
const send = (method, params) => new Promise((res) => { const id = ++idc; pending.set(id, res); ws.send(JSON.stringify({ id, method, params: params ?? {} })) })
const ev = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })
  const x = r.result
  if (x && x.exceptionDetails) return { __exc: x.exceptionDetails.text }
  return x && x.result ? x.result.value : undefined
}
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  const data = r.result && r.result.data
  if (!data) { console.log('  no image for ' + name); return }
  writeFileSync(path.join(OUT, name), Buffer.from(data, 'base64'))
  console.log('  wrote docs/' + name)
}

await send('Runtime.enable'); await send('Page.enable'); await sleep(1800)
await ev('window.__BOOT__().then(r=>JSON.stringify(r))')
await ev('JSON.stringify(window.__MOUNT__())')
await sleep(2000)

/* Expand two levels so nested loading rows appear — that is where the rows used to
   overlap, and a screenshot is the only way to be sure they no longer do. */
const clickRow = (text) => ev(`(function () {
  var rows = [].slice.call(document.querySelectorAll('.scw-row'))
  var target = rows.filter(function (r) { return r.textContent.indexOf(${JSON.stringify(text)}) >= 0 })[0]
  if (!target) return 'missing:' + ${JSON.stringify(text)}
  target.click()
  return 'ok'
})()`)
console.log('  expand src:', await clickRow('src'))
await sleep(1600)
console.log('  expand components:', await clickRow('components'))
await sleep(1600)
await shot('panel-files.png')

const clickMode = (label) => ev(`(function(){
  var ms=[].slice.call(document.querySelectorAll('.scw-mode'))
  var m=ms.filter(function(x){return x.textContent.indexOf(${JSON.stringify(label)})>=0})[0]
  if(m) m.click()
})()`)

await clickMode('变更'); await sleep(900); await shot('panel-changes.png')
const strip2 = JSON.parse(await ev(`JSON.stringify((function () {
  var el = document.querySelector('.scw-modes')
  var r = el.getBoundingClientRect()
  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
})())`))
const crop2 = await send('Page.captureScreenshot', { format: 'png', clip: Object.assign({ scale: 2 }, strip2) })
if (crop2.result && crop2.result.data) writeFileSync(path.join(OUT, 'panel-mode-strip.png'), Buffer.from(crop2.result.data, 'base64'))
console.log('  wrote docs/panel-mode-strip.png')
/* The mode strip is small and easy to judge wrongly from a full screenshot; crop it
   so the count badge can actually be inspected. */
const stripRect = JSON.parse(await ev(`JSON.stringify((function () {
  var el = document.querySelector('.scw-modes')
  if (!el) return null
  var r = el.getBoundingClientRect()
  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
})())`))
if (stripRect !== null) {
  const crop = await send('Page.captureScreenshot', { format: 'png', clip: Object.assign({ scale: 3 }, stripRect) })
  if (crop.result && crop.result.data) writeFileSync(path.join(OUT, 'panel-mode-strip.png'), Buffer.from(crop.result.data, 'base64'))
  console.log('  wrote docs/panel-mode-strip.png')
}
await clickMode('历史'); await sleep(1600); await shot('panel-history.png')
/* Commit detail: the message body used to be crushed to a sliver by the file list. */
await ev(`(function () {
  var rows = [].slice.call(document.querySelectorAll('.scw-commitRow'))
  if (rows[0]) rows[0].click()
})()`)
await sleep(2200); await shot('panel-commit-detail.png')
/* The patch header: centred path + muted revision chip. */
await ev(`(function () {
  var b = [].slice.call(document.querySelectorAll('.scw-commitOps .scw-toolBtn')).filter(function (n) { return n.textContent.indexOf('完整改动') >= 0 })[0]
  if (b) b.click()
})()`)
await sleep(2600); await shot('panel-patch-header.png')
await ev(`(function () { var b = document.querySelector('.scw-commitPatch .scw-back'); if (b) b.click() })()`)
await sleep(600)
await clickMode('分支'); await sleep(1600); await shot('panel-branches.png')
/* The folder picker, which is now a small file manager. */
await ev(`(function () {
  var chip = document.querySelector('.scw-repoChip')
  if (chip) chip.click()
})()`)
await sleep(700)
await ev(`(function () {
  var items = [].slice.call(document.querySelectorAll('.scw-menuItem'))
  var b = items.filter(function (n) { return n.textContent.indexOf('浏览文件夹') >= 0 })[0]
  if (b) b.click()
})()`)
await sleep(1800)
await shot('panel-root-picker.png')
await ev(`(function () {
  var b = [].slice.call(document.querySelectorAll('.scw-dialog .scw-btn')).filter(function (n) { return n.textContent.indexOf('取消') >= 0 })[0]
  if (b) b.click()
})()`)
await sleep(500)
const brRect = JSON.parse(await ev(`JSON.stringify((function () {
  var el = document.querySelector('.scw-treePane')
  var r = el.getBoundingClientRect()
  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.min(420, Math.round(r.height)) }
})())`))
const brCrop = await send('Page.captureScreenshot', { format: 'png', clip: Object.assign({ scale: 2 }, brRect) })
if (brCrop.result && brCrop.result.data) writeFileSync(path.join(OUT, 'panel-branches-crop.png'), Buffer.from(brCrop.result.data, 'base64'))
console.log('  wrote docs/panel-branches-crop.png')
await clickMode('文件'); await sleep(800)

/* search */
await ev(`(function(){
  var el=document.querySelector('.scw-searchInput')
  var setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set
  setter.call(el,'tree'); el.dispatchEvent(new Event('input',{bubbles:true}))
})()`)
await sleep(1400); await shot('panel-search.png')

/* clear, then open a changed file to show source+diff */
await ev(`(function(){var el=document.querySelector('.scw-searchInput');var s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(el,'');el.dispatchEvent(new Event('input',{bubbles:true}))})()`)
await sleep(700)
/* expand src first: in 文件 mode the file lives inside a collapsed directory */
await ev(`(function(){
  var rows=[].slice.call(document.querySelectorAll('.scw-treePane .scw-row'))
  var d=rows.filter(function(r){return r.textContent.indexOf('src')>=0})[0]
  if(d) d.click()
})()`)
await sleep(1800)
await ev(`(function(){
  var rows=[].slice.call(document.querySelectorAll('.scw-treePane .scw-row'))
  var t=rows.filter(function(r){return r.textContent.indexOf('client.js')>=0})[0]
  if(t) t.click()
})()`)
await sleep(3000); await shot('panel-diff.png')
/* Hunk buttons live ON the hunk header now; capture that specifically. */
await clickMode('变更')
await sleep(900)
await ev(`(function () {
  var row = document.querySelector('.scw-changeList .scw-row')
  if (row) row.click()
})()`)
await sleep(2600)
await ev(`(function () {
  var tabs = [].slice.call(document.querySelectorAll('.scw-tab'))
  var d = tabs.filter(function (x) { return x.textContent.indexOf('变更') >= 0 })[0]
  if (d) d.click()
})()`)
await sleep(2400)
await shot('panel-diff-hunks.png')

console.log('\nerrors:', await ev('JSON.stringify(window.__ERRORS__)'))

try { await send('Browser.close', {}) } catch (e) {}
try { child.kill('SIGKILL') } catch (e) {}
await sleep(300)
try { server.close() } catch (e) {}
try { rmSync(prof, { recursive: true, force: true }) } catch (e) {}
try { rmSync(work, { recursive: true, force: true }) } catch (e) {}
process.exit(0)











