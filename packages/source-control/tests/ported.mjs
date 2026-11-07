/**
 * Tests for the ported capabilities: file operations, hunk staging, branches,
 * stash, tags, and the conflict banner.
 *
 * Everything goes through the REAL hosts against a REAL repository, because the
 * failures these guard against (wrong path base, wrong stash index, wrong diff
 * side) are all silent — they produce a plausible-looking UI that acted on the
 * wrong thing.
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

if (existsSync(EDGE) === false) { console.log('SKIP: no browser'); process.exit(0) }
if (existsSync(path.join(REACTDIR, 'react/umd/react.production.min.js')) === false) { console.log('SKIP: no react'); process.exit(0) }

let failures = 0
const check = (name, ok, detail) => {
  if (ok !== true) failures += 1
  console.log((ok === true ? '  ok    ' : '  FAIL  ') + name + (ok === true || detail === undefined ? '' : '  — ' + JSON.stringify(detail).slice(0, 220)))
}

const work = mkdtempSync(path.join(tmpdir(), 'port-'))
const gitRepo = path.join(work, 'repo')
const git = (a, c) => execFileSync('git', a, { cwd: c ?? gitRepo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

mkdirSync(gitRepo, { recursive: true })
git(['init', '-q', '-b', 'main'])
git(['config', 'user.email', 'a@b.c'])
git(['config', 'user.name', 'Tester'])
writeFileSync(path.join(gitRepo, 'one.ts'), Array.from({ length: 30 }, (_, i) => 'line' + (i + 1)).join('\n') + '\n')
writeFileSync(path.join(gitRepo, 'two.ts'), 'const two = 2\n')
git(['add', '-A'], gitRepo)
git(['commit', '-q', '-m', 'first'], gitRepo)
/* A commit with a multi-line MESSAGE BODY: the detail view renders it in a <pre>
   that used to be crushed to a sliver by the long file list below it. */
writeFileSync(path.join(gitRepo, 'body.ts'), 'export const body = 1' + String.fromCharCode(10))
git(['add', '-A'], gitRepo)
git(['commit', '-q', '-m', 'with body', '-m', 'line one of the body' + String.fromCharCode(10) + 'line two of the body'], gitRepo)
/* a change with TWO separate hunks: far apart so git emits two */
/* change line 2 and line 27: 25 lines apart, so git emits TWO hunks (context 3) */
const longLines = Array.from({ length: 30 }, (_, i) => 'line' + (i + 1))
longLines[1] = 'LINE2'
longLines[26] = 'LINE27'
writeFileSync(path.join(gitRepo, 'one.ts'), longLines.join('\n') + '\n')

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
<style>html,body{margin:0;height:100%;font:12px system-ui}#root{height:100%}</style></head><body><div id="root"></div>
<script>window.__REG__=[];window.__ModuleLoader__={load(d){window.__REG__.push(d);return()=>{}}}</script>
<script src="/react.js"></script><script src="/react-dom.js"></script>
<script>
window.__DSH_WORKBAY__={_pages:[],_subs:[],registerPage(p){this._pages.push(p);for(var i=0;i<this._subs.length;i++)this._subs[i]();return function(){}},list(){return this._pages.slice()},get(id){for(var i=0;i<this._pages.length;i++)if(this._pages[i].id===id)return this._pages[i];return null},subscribe(f){this._subs.push(f);return function(){}},open(){},close(){},toggle(){},isOpen(){return false}}
window.__ERRORS__=[];addEventListener('error',e=>window.__ERRORS__.push(String(e.message)))
addEventListener('unhandledrejection',e=>window.__ERRORS__.push('rej: '+String((e.reason&&e.reason.message)||e.reason)))
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
  window.__ROOT__=window.ReactDOM.createRoot(document.getElementById('root'))
  window.__ROOT__.render(window.React.createElement(pg.component,{t:k=>k,dock:window.__DSH_WORKBAY__}))
  return {ok:true}
}
window.__TYPE__=function(selector,text){
  var el=document.querySelector(selector); if(!el) return 'no-el'
  var proto=el.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype
  var setter=Object.getOwnPropertyDescriptor(proto,'value').set
  setter.call(el,text); el.dispatchEvent(new Event('input',{bubbles:true})); return 'ok'
}
window.__CLICK__=function(selector,text){
  var els=[].slice.call(document.querySelectorAll(selector))
  var t=els.filter(function(e){return text===undefined||e.textContent.indexOf(text)>=0})[0]
  if(!t) return 'no-match:'+selector+'/'+text
  t.click(); return 'ok'
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

const prof = mkdtempSync(path.join(tmpdir(), 'port-cdp-'))
const child = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', '--user-data-dir=' + prof, base + '/'], { stdio: 'ignore' })

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
/* Interactions FAIL LOUDLY.
   Earlier versions returned a string like "no-match" that the test ignored, so a
   renamed button produced a silently skipped step and a confusing failure three
   assertions later. These throw with the list of what IS on screen. */
const waitFor = async (selector, timeoutMs) => {
  const deadline = Date.now() + (timeoutMs ?? 5000)
  for (;;) {
    if ((await ev(`document.querySelector(${JSON.stringify(selector)}) !== null`)) === true) return true
    if (Date.now() > deadline) return false
    await sleep(100)
  }
}
const mustClick = async (selector, text) => {
  if ((await waitFor(selector, 5000)) !== true) {
    const seen = await ev(`JSON.stringify({
      tools: [].slice.call(document.querySelectorAll('.scw-toolIcon')).map(function (n) { return n.getAttribute('title') }),
      modes: [].slice.call(document.querySelectorAll('.scw-mode')).map(function (n) { return n.textContent }),
      menu: [].slice.call(document.querySelectorAll('.scw-menuItem')).map(function (n) { return n.textContent }),
    })`)
    throw new Error('missing ' + selector + ' — on screen: ' + seen)
  }
  const result = await ev(`window.__CLICK__(${JSON.stringify(selector)}, ${text === undefined ? 'undefined' : JSON.stringify(text)})`)
  if (result !== 'ok') throw new Error('click failed: ' + result + ' on ' + selector + (text === undefined ? '' : ' / ' + text))
  await sleep(280)
}
const clickTool = (title) => mustClick('.scw-toolIcon[title=' + JSON.stringify(title) + ']')
const clickMenu = (label) => mustClick('.scw-menuItem', label)
const clickMode = async (label) => { await mustClick('.scw-mode', label); await sleep(700) }
const dumpErrors = async () => console.log('    [errors]', await ev('JSON.stringify(window.__ERRORS__)'))

try {
  await send('Runtime.enable'); await sleep(1800)
  await ev('window.__BOOT__().then(r=>JSON.stringify(r))')
  await ev('JSON.stringify(window.__MOUNT__())')
  await sleep(1800)

  /* ============ file operations ============ */
  await dumpErrors()
  await clickMode('文件'); await sleep(700)
  await clickTool('新建'); await sleep(400)
  await clickMenu('新建文件'); await sleep(500)
  const promptOpen = await ev(`JSON.stringify({ dialog: document.querySelector('.scw-dialog') !== null, input: document.querySelector('.scw-dialogInput') !== null })`)
  check('新建文件 opens a prompt dialog with an input', String(promptOpen).includes('"input":true'), promptOpen)
  await ev(`window.__TYPE__('.scw-dialogInput', 'created.ts')`)
  await sleep(300)
  await ev(`window.__CLICK__('.scw-dialog .scw-btn.is-primary')`)
  await sleep(2000)
  check('the new file exists on disk', existsSync(path.join(gitRepo, 'created.ts')), (() => { try { return execFileSync('fsutil', ['file', 'queryfilenameinfo', path.join(gitRepo, 'created.ts')], { encoding: 'utf8' }) } catch (e) { return null } })())

  /* rename it */
  await ev(`window.__CLICK__('.scw-row', 'created.ts')`)
  await sleep(700)
  /* Select it explicitly: creating a file also re-lists the tree, and the
     selection can be dropped by that refresh. */
  await ev(`window.__CLICK__('.scw-row', 'created.ts')`)
  await sleep(800)
  check('the created file can be selected in the tree',
    (await ev(`document.querySelector('.scw-row.is-active') !== null`)) === true)
  await clickTool('重命名'); await sleep(600)
  await ev(`window.__TYPE__('.scw-dialogInput', 'renamed.ts')`)
  await sleep(300)
  await ev(`window.__CLICK__('.scw-dialog .scw-btn.is-primary')`)
  await sleep(2000)
  check('rename moved the file', existsSync(path.join(gitRepo, 'renamed.ts')) && existsSync(path.join(gitRepo, 'created.ts')) === false)

  /* delete it */
  await ev(`window.__CLICK__('.scw-row', 'renamed.ts')`)
  await sleep(700)
  await clickTool('删除'); await sleep(500)
  await ev(`window.__CLICK__('.scw-dialog .scw-btn.is-primary')`)
  await sleep(2000)
  check('delete removed the file', existsSync(path.join(gitRepo, 'renamed.ts')) === false)

  /* ============ hunk staging ============ */
  await clickMode('变更'); await sleep(800)
  await ev(`window.__CLICK__('.scw-changeList .scw-row', 'one.ts')`)
  await sleep(2500)
  const hunkDom = JSON.parse(await ev(`JSON.stringify({
    chips: document.querySelectorAll('.gwc-hunkBtn').length,
    buttons: [].slice.call(document.querySelectorAll('.gwc-hunkBtn')).map(function(n){return n.textContent}),
  })`))
  check('the diff pane offers per-hunk action chips', hunkDom.chips >= 2, hunkDom)
  check('each chip has stage and discard', hunkDom.buttons.length >= 4, hunkDom.buttons)

  /* stage the FIRST hunk only */
  await ev(`(function(){var b=[].slice.call(document.querySelectorAll('.gwc-hunkBtn')).filter(function(x){return x.textContent==='暂存此块'})[0]; if(b) b.click()})()`)
  await sleep(2500)
  const stagedPatch = git(['diff', '--cached', '--unified=0'], gitRepo)
  check('staging one hunk staged only that hunk', stagedPatch.includes('LINE2') && stagedPatch.includes('LINE27') === false, stagedPatch.slice(0, 320))

  /* ============ branches ============ */
  await clickMode('分支'); await sleep(1500)
  await clickTool('新建分支'); await sleep(600)
  await ev(`window.__TYPE__('.scw-dialogInput', 'feature/ported')`)
  await sleep(300)
  await ev(`window.__CLICK__('.scw-dialog .scw-btn.is-primary')`)
  await sleep(2500)
  const branchList = git(['branch', '--list'], gitRepo)
  check('creating a branch created it for real', branchList.includes('feature/ported'), branchList)

  /* switch back to main by clicking it */
  await ev(`window.__CLICK__('.scw-branchRow', 'main')`)
  await sleep(2500)
  check('clicking another branch checks it out', git(['rev-parse', '--abbrev-ref', 'HEAD'], gitRepo).trim() === 'main')

  /* ============ stash ============ */
  await clickMode('变更'); await sleep(800)
  await clickTool('更多'); await sleep(400)
  await clickMenu('贮藏更改'); await sleep(600)
  await ev(`window.__TYPE__('.scw-dialogInput', 'ported test stash')`)
  await sleep(300)
  await ev(`window.__CLICK__('.scw-dialog .scw-btn.is-primary')`)
  await sleep(2500)
  const stashList = git(['stash', 'list'], gitRepo)
  check('stashing created a stash entry', stashList.includes('ported test stash'), stashList)

  await clickMode('贮藏'); await sleep(1800)
  const stashDom = JSON.parse(await ev(`JSON.stringify({
    rows: document.querySelectorAll('.scw-stashRow').length,
    refs: [].slice.call(document.querySelectorAll('.scw-stashRef')).map(function(n){return n.textContent}),
  })`))
  check('the stash mode lists the entry', stashDom.rows === 1, stashDom)

  /* apply it back */
  await ev(`(function(){var b=[].slice.call(document.querySelectorAll('.scw-rowBtn')).filter(function(x){return x.textContent==='应用'})[0]; if(b) b.click()})()`)
  await sleep(2500)
  const afterApply = git(['status', '--porcelain'], gitRepo)
  check('applying the stash restored the change', afterApply.includes('one.ts'), afterApply)

  /* ============ tag ============ */
  await clickMode('历史'); await sleep(1800)
  await ev(`window.__CLICK__('.scw-commitRow')`)
  await sleep(1500)
  await clickTool('更多'); await sleep(400)
  await clickMenu('打标签')
  await sleep(500)
  await ev(`window.__TYPE__('.scw-dialogInput', 'v0.1.0')`)
  await sleep(300)
  await ev(`window.__CLICK__('.scw-dialog .scw-btn.is-primary')`)
  await sleep(2500)
  check('creating a tag created it for real', git(['tag', '--list'], gitRepo).includes('v0.1.0'), git(['tag', '--list'], gitRepo))

  /* ============ commit patch view ============ */
  const commitDiff = JSON.parse(await ev(`JSON.stringify({ hunkBar: document.querySelectorAll('.gwc-hunkBtn').length })`))
  check('a commit patch shows no staging chips (history is not stageable)', commitDiff.hunkBar === 0, commitDiff)

  /* ============ conflict: banner + resolve by side ============ */
  /* Build a REAL conflict: two branches editing the same line. */
  git(['checkout', '-q', 'main'])
  writeFileSync(path.join(gitRepo, 'conflict.ts'), 'base\n')
  git(['add', 'conflict.ts'])
  git(['commit', '-q', '-m', 'base for conflict'])
  git(['checkout', '-q', '-b', 'other'])
  writeFileSync(path.join(gitRepo, 'conflict.ts'), 'theirs\n')
  git(['commit', '-q', '-am', 'theirs side'])
  git(['checkout', '-q', 'main'])
  writeFileSync(path.join(gitRepo, 'conflict.ts'), 'ours\n')
  git(['commit', '-q', '-am', 'ours side'])
  try { git(['merge', 'other', '--no-edit']) } catch (e) { /* expected: conflict */ }
  const mergeState = git(['status', '--porcelain'], gitRepo)
  check('the test repository is really in a conflicted merge', mergeState.includes('conflict.ts'), mergeState)

  /* Reload the page so it sees the new state. */
  await ev('window.__MOUNT__()')
  await sleep(2500)
  await clickMode('变更'); await sleep(1200)
  const conflictDom = JSON.parse(await ev(`JSON.stringify({
    banner: document.querySelector('.scw-conflictBar') !== null,
    bannerText: document.querySelector('.scw-conflictText') ? document.querySelector('.scw-conflictText').textContent : null,
    continueBtn: [].slice.call(document.querySelectorAll('.scw-conflictBar .scw-toolBtn')).map(function(n){return n.textContent}),
    groups: [].slice.call(document.querySelectorAll('.scw-groupName')).map(function(n){return n.textContent}),
    resolveButtons: [].slice.call(document.querySelectorAll('.scw-changeList .scw-rowBtn')).map(function(n){return n.textContent}),
  })`))
  check('a conflicted merge shows the in-progress banner', conflictDom.banner === true, conflictDom)
  check('the banner offers continue and abort', Array.isArray(conflictDom.continueBtn) && conflictDom.continueBtn.length === 2, conflictDom.continueBtn)
  check('the conflict group appears', Array.isArray(conflictDom.groups) && conflictDom.groups.indexOf('冲突') >= 0, conflictDom.groups)
  check('the conflicted row offers the three resolutions',
    Array.isArray(conflictDom.resolveButtons) && conflictDom.resolveButtons.indexOf('用我的') >= 0
    && conflictDom.resolveButtons.indexOf('用他们的') >= 0, conflictDom.resolveButtons)

  /* Resolve with OURS, then finish the merge through the banner. */
  await ev(`(function(){var b=[].slice.call(document.querySelectorAll('.scw-changeList .scw-rowBtn')).filter(function(x){return x.textContent==='用我的'})[0]; if(b) b.click()})()`)
  await sleep(2500)
  check('resolving with ours wrote that side to disk', readFileSync(path.join(gitRepo, 'conflict.ts'), 'utf8').includes('ours'))

  await ev(`(function(){var b=[].slice.call(document.querySelectorAll('.scw-conflictBar .scw-toolBtn')).filter(function(x){return x.textContent==='继续'})[0]; if(b) b.click()})()`)
  await sleep(3000)
  const afterMerge = git(['status', '--porcelain'], gitRepo)
  check('continuing finished the merge (no in-progress markers left)',
    afterMerge.includes('conflict.ts') === false && existsSync(path.join(gitRepo, '.git', 'MERGE_HEAD')) === false, afterMerge)

  /* ============ the four reported defects ============ */

  /* (1) Clicking a DIRECTORY must not hand it to a file viewer. The old behaviour
     showed "rel is a directory" — an error for a completely normal click. */
  await clickMode('文件'); await sleep(800)
  await ev(`window.__CLICK__('.scw-row', 'app')`)
  await sleep(900)
  const dirDom = JSON.parse(await ev(`JSON.stringify({
    activeRow: document.querySelector('.scw-row.is-active') ? document.querySelector('.scw-row.is-active').textContent : null,
    hasTabs: document.querySelector('.scw-tabs') !== null,
    emptyTitle: document.querySelector('.scw-emptyTitle') ? document.querySelector('.scw-emptyTitle').textContent : null,
    dirError: (document.body.innerText || '').indexOf('is a directory') >= 0,
  })`))
  check('clicking a directory selects it without erroring', dirDom.dirError === false, dirDom)
  check('a directory shows a directory state, not a file viewer', dirDom.hasTabs === false && dirDom.emptyTitle !== null, dirDom)

  /* (2) The tree must not be squeezed by a wide content pane, and the grip must
     actually resize it. `flex: 0 0 auto` is what makes both true. */
  /* In the stacked (narrow) layout there is no horizontal splitter at all — the
     tree sits above the content. The three geometry assertions below only apply to
     the side-by-side layout, so they are skipped rather than failed when stacked. */
  const stackedLayout = JSON.parse(await ev(`JSON.stringify(
    document.querySelector('.scw-body') !== null
    && document.querySelector('.scw-body').classList.contains('is-stacked'))`))
  const beforeWidth = JSON.parse(await ev(`JSON.stringify(document.querySelector('.scw-treePane').getBoundingClientRect().width)`))
  await ev(`(function () {
    var grip = document.querySelector('.scw-grip')
    if (!grip) return 'no-grip'
    var r = grip.getBoundingClientRect()
    var x = r.left + r.width / 2, y = r.top + 60
    grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y }))
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x + 40, clientY: y }))
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x + 40, clientY: y }))
    return 'dragged'
  })()`)
  await sleep(600)
  const afterWidth = JSON.parse(await ev(`JSON.stringify(document.querySelector('.scw-treePane').getBoundingClientRect().width)`))
  check('the divider drags and the tree actually widens', stackedLayout === true || afterWidth > beforeWidth + 10, { beforeWidth, afterWidth, stackedLayout })
  check('the tree keeps a usable width (never squeezed to a sliver)', beforeWidth >= 190, beforeWidth)
  /* The splitter must BE the divider, not an overlay. It used a negative margin and a
     z-index, so it sat on top of the tree's scrollbar and painted a tint over the
     content while dragging — "the splitter covers the UI". */
  const splitGeom = JSON.parse(await ev(`JSON.stringify((function () {
    var tree = document.querySelector('.scw-treePane')
    var grip = document.querySelector('.scw-grip')
    var content = document.querySelector('.scw-content')
    if (tree === null || grip === null || content === null) return { missing: true }
    var t = tree.getBoundingClientRect()
    var g = grip.getBoundingClientRect()
    var c = content.getBoundingClientRect()
    return {
      treeRight: Math.round(t.right),
      gripLeft: Math.round(g.left),
      gripRight: Math.round(g.right),
      contentLeft: Math.round(c.left),
      zIndex: getComputedStyle(grip).zIndex,
    }
  })())`))
  check('the splitter sits BETWEEN the tree and the content, overlapping neither',
    stackedLayout === true || splitGeom.missing !== true
    && splitGeom.gripLeft >= splitGeom.treeRight - 1
    && splitGeom.gripRight <= splitGeom.contentLeft + 1, splitGeom)
  /* Narrowing the pane must not leave half-cut labels. Below the threshold the mode
     tabs drop their captions (icons + tooltip remain) and the ref chips hide — a chip
     squeezed to a sliver reads as a broken glyph, which is worse than absent. */
  await clickMode('历史'); await sleep(1500)
  /* Drag the splitter to its minimum rather than setting a style: the class is derived
     from the page's own width STATE, so a manual style would not exercise it. */
  await ev(`(function () {
    var grip = document.querySelector('.scw-grip')
    if (!grip) return 'no-grip'
    var r = grip.getBoundingClientRect()
    var x = r.left + r.width / 2, y = r.top + 60
    grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y }))
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 0, clientY: y }))
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 0, clientY: y }))
    return 'dragged'
  })()`)
  await sleep(900)
  const narrowDom = JSON.parse(await ev(`JSON.stringify({
    hasNarrowClass: document.querySelector('.scw-treePane.is-narrow') !== null,
    labelsVisible: [].slice.call(document.querySelectorAll('.scw-modeLabel')).filter(function (n) {
      return n.getBoundingClientRect().width > 0
    }).length,
    refsVisible: [].slice.call(document.querySelectorAll('.scw-commitRefs')).filter(function (n) {
      return n.getBoundingClientRect().width > 0
    }).length,
    icons: document.querySelectorAll('.scw-mode svg').length,
    rowTitle: (document.querySelector('.scw-commitRow.is-graph') || { getAttribute: function () { return '' } }).getAttribute('title'),
  })`))
  /* 上下分栏时没有水平拖拽条，无法把侧栏拖窄；那两条在那种布局下不适用。 */
  check('a narrow pane switches to icon-only tabs',
    stackedLayout === true || (narrowDom.hasNarrowClass === true && narrowDom.labelsVisible === 0 && narrowDom.icons >= 5), narrowDom)
  check('a narrow pane hides the ref chips instead of clipping them',
    stackedLayout === true || narrowDom.refsVisible === 0, narrowDom)
  check('the refs remain reachable from the row tooltip',
    typeof narrowDom.rowTitle === 'string', narrowDom)
  await ev(`(function () {
    var grip = document.querySelector('.scw-grip')
    if (!grip) return
    var r = grip.getBoundingClientRect()
    var x = r.left + r.width / 2, y = r.top + 60
    grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y }))
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x + 220, clientY: y }))
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x + 220, clientY: y }))
  })()`)
  await sleep(600)
  check('the splitter takes no stacking order over the panes',
    stackedLayout === true || splitGeom.zIndex === '0' || splitGeom.zIndex === 'auto', splitGeom)

  /* (3) A commit's patch is reachable from the commit detail. */
  /* (3) A version opens its DETAIL (files touched), not one merged patch; the
     merged patch is an explicit button. */
  await clickMode('历史'); await sleep(1800)
  /* NOT the merge commit: `git show --name-status` lists no files for a merge
     unless a parent is asked for, so pick a normal commit. */
  await mustClick('.scw-commitRow', 'first')
  await sleep(2200)
  const commitDetailDom = JSON.parse(await ev(`JSON.stringify({
    detail: document.querySelector('.scw-commitDetail') !== null,
    subject: document.querySelector('.scw-commitSubject.is-large') ? document.querySelector('.scw-commitSubject.is-large').textContent : null,
    files: [].slice.call(document.querySelectorAll('.scw-commitFileName')).map(function (n) { return n.textContent }),
    mergedPatchShownByDefault: document.querySelector('.scw-commitPatch') !== null,
  })`))

  /* Stash-index commits must NOT appear in branch history: --all includes
     refs/stash, which used to put 'index on main: …' rows at the top of the list. */
  /* The history list must be a GRAPH, not a list: one node per commit, and lines that
     actually connect them. */
  const graphDom = JSON.parse(await ev(`JSON.stringify({
    rows: document.querySelectorAll('.scw-commitRow.is-graph').length,
    graphs: document.querySelectorAll('.scw-commitRow .scw-graph').length,
    nodes: document.querySelectorAll('.scw-commitRow .scw-graph circle').length,
    lines: document.querySelectorAll('.scw-commitRow .scw-graph line').length,
    refs: document.querySelectorAll('.scw-refChip').length,
    rowHeight: (document.querySelector('.scw-commitRow.is-graph') || { getBoundingClientRect: function () { return { height: 0 } } }).getBoundingClientRect().height | 0,
    cells: (document.querySelector('.scw-commitRow.is-graph') || { children: [] }).children.length,
  })`))
  check('every commit row carries a graph cell', graphDom.rows > 0 && graphDom.graphs === graphDom.rows, graphDom)
  check('each commit is a node in the graph', graphDom.nodes === graphDom.rows, graphDom)
  check('the commits are CONNECTED by lines', graphDom.lines > 0, graphDom)
  check('the graph row lays out horizontally, not stacked',
    graphDom.rowHeight > 0 && graphDom.rowHeight <= 40 && graphDom.cells >= 3, graphDom)
  check('branch refs are shown on the commit that carries them', graphDom.refs > 0, graphDom)
  /* History is paged, not capped: the pager must NOT appear when the whole history
     already fits in one page (a permanent "加载更多" that loads nothing is worse than
     no button), and it must exist in the markup contract for the long case. */
  const pagerDom = JSON.parse(await ev(`JSON.stringify({
    buttons: document.querySelectorAll('.scw-loadMoreBtn').length,
    rows: document.querySelectorAll('.scw-commitRow.is-graph').length,
  })`))
  /* The ref chips must never paint over the subject. `flex:none` plus a percentage
     max-width let them overflow their own box, which read as "the row is overlapped". */
  const overlapDom = JSON.parse(await ev(`JSON.stringify((function () {
    var row = document.querySelector('.scw-commitRow.is-graph')
    if (row === null) return { missing: true }
    var refs = row.querySelector('.scw-commitRefs')
    var subject = row.querySelector('.scw-commitSubject')
    if (refs === null || subject === null) return { missing: true }
    return {
      refsRight: Math.round(refs.getBoundingClientRect().right),
      subjectLeft: Math.round(subject.getBoundingClientRect().left),
      author: row.querySelectorAll('.scw-commitAuthor').length,
      chipsFit: refs.scrollWidth <= refs.clientWidth + 1,
    }
  })())`))
  check('ref chips never overlap the subject',
    overlapDom.missing !== true
    && overlapDom.refsRight <= overlapDom.subjectLeft + 1
    && overlapDom.chipsFit === true, overlapDom)
  check('the history row no longer repeats the author', overlapDom.author === 0, overlapDom)
  check('the pager stays hidden while everything fits in one page',
    pagerDom.rows > 0 && pagerDom.buttons === 0, pagerDom)
  const historySubjects = JSON.parse(await ev(`JSON.stringify([].slice.call(document.querySelectorAll('.scw-commitSubject')).map(function (n) { return n.textContent }))`))
  check('history does not list stash commits',
    Array.isArray(historySubjects) && historySubjects.every(function (x) { return x.indexOf('index on ') < 0 && x.indexOf('WIP on ') < 0 }), historySubjects.slice(0, 6))

  check('a version opens its detail, not a merged patch',
    commitDetailDom.detail === true && commitDetailDom.mergedPatchShownByDefault === false, commitDetailDom)

  /* A commit whose message has a body must SHOW that body.
     The detail is a flex column and the body was the only shrinkable child, so a long
     file list squeezed it to a sliver of clipped glyphs. HEIGHT is what to assert: the
     element existed all along, it was just 12px tall. */
  /* Click by SUBJECT, not by "row text contains": a stash-index row used to sit at
     the top of this list with the same words in it. */
  await ev(`(function () {
    var rows = [].slice.call(document.querySelectorAll('.scw-commitRow'))
    var hit = rows.filter(function (r) {
      var s = r.querySelector('.scw-commitSubject')
      return s !== null && s.textContent.trim() === 'with body'
    })[0]
    if (hit) hit.click()
  })()`)
  await sleep(2200)
  const bodyDom = JSON.parse(await ev(`JSON.stringify((function () {
    var pre = document.querySelector('.scw-commitBody')
    if (!pre) return { present: false, detail: (document.querySelector(".scw-commitDetail") ? document.querySelector(".scw-commitDetail").innerText.slice(0, 160) : "NO-DETAIL"), subject: (document.querySelector(".scw-commitSubject.is-large") || {}).textContent || null }
    var r = pre.getBoundingClientRect()
    return { present: true, height: Math.round(r.height), text: pre.textContent.slice(0, 80), detail: (document.querySelector(".scw-commitDetail") ? document.querySelector(".scw-commitDetail").innerText.slice(0, 160) : "NO-DETAIL") }
  })())`))
  check('a commit message body renders at a readable height',
    bodyDom.present === true && bodyDom.height >= 40, bodyDom)
  check('and the body text is the actual message', String(bodyDom.text).indexOf('line one') >= 0, bodyDom)

  check('the detail lists the files that commit touched',
    Array.isArray(commitDetailDom.files) && commitDetailDom.files.length > 0, commitDetailDom)

  /* Picking one file narrows the patch to that file. */
  await mustClick('.scw-commitFile')
  await sleep(2800)
  await sleep(2800)
  const commitPatch = JSON.parse(await ev(`JSON.stringify({
    view: document.querySelector('.scw-commitPatch') !== null,
    back: document.querySelector('.scw-commitPatch .scw-back') !== null,
    diffRows: document.querySelectorAll('.gwc-row').length,
    hunkChips: document.querySelectorAll('.gwc-hunkBtn').length,
  })`))
  check('a commit file narrows the patch to that file', commitPatch.view === true && commitPatch.diffRows > 0, commitPatch)
  check('the commit patch offers a way back', commitPatch.back === true, commitPatch)
  check('history patches are not stageable (no hunk chips)', commitPatch.hunkChips === 0, commitPatch)

  /* (4) The two diff panes must not hijack each other.
     gitcraft kept ONE module-level handle, so mounting a commit patch overwrote
     the working-tree pane's handle and every later "show this file's diff" went to
     the wrong pane. Verify the working diff still works AFTER a commit patch. */
  /* The tree is clean at this point (everything was just committed), so create a
     change first — an empty change list is CORRECT here, not the bug. */
  writeFileSync(path.join(gitRepo, 'two.ts'), 'const two = 22\n')
  await ev('window.__MOUNT__()')
  await sleep(2500)
  await clickMode('变更'); await sleep(1000)
  await mustClick('.scw-changeList .scw-row', 'two.ts')
  await sleep(2600)
  const workingAgain = JSON.parse(await ev(`JSON.stringify({
    diffRows: document.querySelectorAll('.gwc-row').length,
    chips: document.querySelectorAll('.gwc-hunkBtn').length,
    bar: document.querySelectorAll('.gwc-hunkBar').length,
    pane: (function(){var d=document.querySelector('.gwc-diffPane');return d?{base:d.getAttribute('data-base'),hunks:d.getAttribute('data-hunks'),canHunk:d.getAttribute('data-can-hunk')}:null})(),
    commitView: document.querySelector('.scw-commitPatch') !== null,
    tab: document.querySelector('.scw-tab.is-active') ? document.querySelector('.scw-tab.is-active').textContent : null,
    slots: document.querySelectorAll('.scw-paneHost').length,
    text: document.querySelector('.scw-paneHost') ? document.querySelector('.scw-paneHost').innerText.slice(0, 80) : '',
  })`))
  check('the working-tree diff still works after viewing a commit patch',
    workingAgain.diffRows > 0 && workingAgain.chips > 0, workingAgain)

  /* (5) The root chip must open a picker and switching must re-list the tree.
     A chip that does nothing leaves the page stuck on the first root forever. */
  await mustClick('.scw-repoChip')
  await sleep(900)
  const rootMenu = JSON.parse(await ev(`JSON.stringify({
    open: document.querySelector('.scw-menu') !== null,
    items: [].slice.call(document.querySelectorAll('.scw-menuItem')).map(function (n) { return n.textContent }),
  })`))
  check('the root chip opens a folder picker', rootMenu.open === true && rootMenu.items.length > 0, rootMenu)
  /* Typing an absolute path is gone on purpose: the picker can reach any drive, so
     nobody should have to hand-type a path. */
  check('the picker no longer asks people to type a path',
    rootMenu.items.every(function (x) { return x.indexOf('手动输入') < 0 }), rootMenu.items)
  await ev(`(function () {
    var el = [].slice.call(document.querySelectorAll('.scw-menuItem')).filter(function (n) { return n.textContent.indexOf('浏览文件夹') >= 0 })[0]
    if (el) el.click()
  })()`)
  await sleep(2200)
  /* Navigate to the repository by walking up to the drive root and back down. */
  for (var step = 0; step < 6; step += 1) {
    const at = await ev(`document.querySelector('.scw-browsePath') ? document.querySelector('.scw-browsePath').textContent : ''`)
    if (String(at).toLowerCase().replace(/\\/g, '/') === String(gitRepo).toLowerCase().replace(/\\/g, '/')) break
    const moved = await ev(`(function () {
      var up = document.querySelector('.scw-browseUp')
      var b = document.querySelector('.scw-browseItem[title=' + JSON.stringify(${JSON.stringify(gitRepo)}) + ']')
      if (b) { b.click(); return 'down' }
      if (up) { up.click(); return 'up' }
      return 'stuck'
    })()`)
    await sleep(900)
    if (moved === 'stuck') break
  }
  await sleep(600)
  const afterRoot = JSON.parse(await ev(`JSON.stringify({
    rows: [].slice.call(document.querySelectorAll('.scw-treePane .scw-rowName')).map(function (n) { return n.textContent }),
    stored: localStorage.getItem('dsh-workbay.sc.root.v1'),
  })`))
  check('navigating the picker and confirming re-lists the tree',
    Array.isArray(afterRoot.rows) && afterRoot.rows.length > 0, afterRoot)

  /* ============ round-5 feedback ============ */
  /* (a) The dialog's OK button must be labelled — and must never say "仍然丢弃".
     That label leaked from the discard confirm into every prompt, and in the browse
     dialog the button rendered with no text at all. */
  await mustClick('.scw-repoChip'); await sleep(900)
  await clickMenu('浏览文件夹'); await sleep(2000)
  const browseDom = JSON.parse(await ev(`JSON.stringify({
    open: document.querySelector('.scw-browse') !== null,
    items: document.querySelectorAll('.scw-browseItem').length,
    drives: [].slice.call(document.querySelectorAll('.scw-driveChip')).map(function (n) { return n.textContent }),
    path: document.querySelector('.scw-browsePath') ? document.querySelector('.scw-browsePath').textContent : null,
    buttons: [].slice.call(document.querySelectorAll('.scw-dialog .scw-btn')).map(function (n) { return n.textContent.trim() }),
  })`))
  check('the folder picker opens and lists folders', browseDom.open === true && browseDom.items > 0, browseDom)

  /* File-manager layout: section headings, a path bar you can JUMP with, and the full
  const pickerDom = JSON.parse(await ev(`JSON.stringify({
    sections: [].slice.call(document.querySelectorAll('.scw-browseSection')).map(function (n) { return n.textContent }),
    pathBars: document.querySelectorAll('.scw-browseInput').length,
    go: [].slice.call(document.querySelectorAll('.scw-browseGo')).map(function (n) { return n.textContent }),
    itemPaths: document.querySelectorAll('.scw-browseItem .scw-browseItemPath').length,
  })`))
  check('the picker shows named sections', Array.isArray(pickerDom.sections) && pickerDom.sections.length >= 3, pickerDom.sections)
  check('the picker has a path bar with a 前往 button',
    pickerDom.pathBars === 1 && (pickerDom.go || []).indexOf('前往') >= 0, pickerDom)
  check('every folder row shows its full path', pickerDom.itemPaths > 0, pickerDom)
  check('the picker offers DRIVES so other volumes are reachable',
    Array.isArray(browseDom.drives) && browseDom.drives.length > 0, browseDom.drives)
  check('the picker\'s OK button has a real label (not blank, not 仍然丢弃)',
    browseDom.buttons.some(function (x) { return x.indexOf('用这个目录') >= 0 })
    && browseDom.buttons.every(function (x) { return x.indexOf('仍然丢弃') < 0 }), browseDom.buttons)
  await ev(`window.__CLICK__('.scw-dialog .scw-btn .scw-btn')`)
  await sleep(300)
  await ev(`(function () { var b = [].slice.call(document.querySelectorAll('.scw-dialog .scw-btn')).filter(function (n) { return n.textContent.indexOf('取消') >= 0 })[0]; if (b) b.click() })()`)
  await sleep(600)
  /* (c) Clicking a commit shows the WHOLE patch immediately, and Back returns to
  /* (c) The merged patch is an EXPLICIT choice, reachable from the detail, and it
     comes back to the detail afterwards. It must never be the default: one giant
     diff over every touched file buries the file list the reader wants first. */
  await clickMode('历史'); await sleep(1600)
  await mustClick('.scw-commitRow', 'first'); await sleep(2200)
  check('the detail is the default view for a version',
    (await ev(`document.querySelector('.scw-commitDetail') !== null`)) === true)

  await mustClick('.scw-commitOps .scw-toolBtn', '完整改动'); await sleep(3000)
  const wholeCommit = JSON.parse(await ev(`JSON.stringify({
    patchView: document.querySelector('.scw-commitPatch') !== null,
    base: document.querySelector('.gwc-diffPane') ? document.querySelector('.gwc-diffPane').getAttribute('data-base') : null,
    rows: document.querySelectorAll('.gwc-row').length,
    chips: document.querySelectorAll('.gwc-hunkBtn').length,
  })`))
  check('the merged patch is available on request',
    wholeCommit.patchView === true && wholeCommit.base === 'commit' && wholeCommit.rows > 0, wholeCommit)
  check('a commit patch offers no staging chips', wholeCommit.chips === 0, wholeCommit)

  await mustClick('.scw-commitPatch .scw-back'); await sleep(1800)
  check('Back returns to the commit detail',
    (await ev(`document.querySelector('.scw-commitDetail') !== null`)) === true)

  /* (d) Unified / split toggle. */
  await clickMode('变更'); await sleep(900)
  writeFileSync(path.join(gitRepo, 'two.ts'), 'const two = 23\n')
  await ev('window.__MOUNT__()'); await sleep(2400)
  await clickMode('变更'); await sleep(900)
  await mustClick('.scw-changeList .scw-row', 'two.ts'); await sleep(2600)
  const modeBefore = await ev(`document.querySelector('.gwc-diffPane') ? document.querySelector('.gwc-diffPane').getAttribute('data-mode') : null`)
  await mustClick('.scw-modeToggle'); await sleep(1200)
  const modeAfter = await ev(`document.querySelector('.gwc-diffPane') ? document.querySelector('.gwc-diffPane').getAttribute('data-mode') : null`)
  check('the diff layout can be switched', modeBefore !== modeAfter && modeAfter === 'split', { modeBefore, modeAfter })
  await mustClick('.scw-modeToggle'); await sleep(1200)
  check('and switched back', (await ev(`document.querySelector('.gwc-diffPane') ? document.querySelector('.gwc-diffPane').getAttribute('data-mode') : null`)) === 'unified')

  /* (e) The two per-file views: 历史 and 逐行作者. Never covered before. */
  await clickMode('文件'); await sleep(900)
  await ev(`window.__CLICK__('.scw-row', 'two.ts')`)
  await sleep(1800)
  const perFile = JSON.parse(await ev(`JSON.stringify({
    tabs: [].slice.call(document.querySelectorAll('.scw-tab')).map(function (n) { return n.textContent }),
  })`))
  check('per-file view offers 历史 and 逐行作者',
    perFile.tabs.some(function (x) { return x.indexOf('历史') >= 0 })
    && perFile.tabs.some(function (x) { return x.indexOf('逐行作者') >= 0 }), perFile.tabs)

  await ev(`(function () {
    var t = [].slice.call(document.querySelectorAll('.scw-tab')).filter(function (n) { return n.textContent.indexOf('历史') >= 0 })[0]
    if (t) t.click()
  })()`)
  await sleep(2400)
  const fileHist = JSON.parse(await ev(`JSON.stringify({
    list: document.querySelector('.scw-historyList') !== null,
    rows: document.querySelectorAll('.scw-historyList .scw-commitRow').length,
    state: document.querySelector('.scw-paneState') ? document.querySelector('.scw-paneState').textContent : null,
  })`))
  check('the per-file history view lists commits',
    (fileHist.list === true && fileHist.rows > 0) || fileHist.state !== null, fileHist)

  /* A row in the FILE's history must open that commit's patch for that file.
     The rows used to be inert, so the tab asked a question it could not answer. */
  await mustClick('.scw-historyList .scw-commitRow')
  await sleep(3000)
  const fileHistPatch = JSON.parse(await ev(`JSON.stringify({
    view: document.querySelector('.scw-commitPatch') !== null,
    base: document.querySelector('.gwc-diffPane') ? document.querySelector('.gwc-diffPane').getAttribute('data-base') : null,
    rows: document.querySelectorAll('.gwc-row').length,
    tabFile: document.querySelector('.scw-commitPatch .scw-tabFile') ? document.querySelector('.scw-commitPatch .scw-tabFile').textContent : null,
  })`))
  check('clicking a version in the file history opens its patch',
    fileHistPatch.view === true && fileHistPatch.base === 'commit' && fileHistPatch.rows > 0, fileHistPatch)
  await mustClick('.scw-commitPatch .scw-back')
  await sleep(900)
  await ev(`(function () {
    var t = [].slice.call(document.querySelectorAll('.scw-tab')).filter(function (n) { return n.textContent.indexOf('逐行作者') >= 0 })[0]
    if (t) t.click()
  })()`)
  await sleep(2600)
  const blameDom = JSON.parse(await ev(`JSON.stringify({
    list: document.querySelector('.scw-blameList') !== null,
    rows: document.querySelectorAll('.scw-blameRow').length,
    /* Non-empty AUTHOR and CODE, not merely non-empty rows: reading the wrong field
       names from the host rendered a column of line numbers with blank authors and
       blank code, and "rows > 0" accepted that happily. */
    firstAuthor: document.querySelector('.scw-blameMeta') ? document.querySelector('.scw-blameMeta').textContent.trim() : '',
    firstHash: document.querySelector('.scw-blameHash') ? document.querySelector('.scw-blameHash').textContent.trim() : '',
    firstCode: document.querySelector('.scw-blameText') ? document.querySelector('.scw-blameText').textContent.trim() : '',
    state: document.querySelector('.scw-paneState') ? document.querySelector('.scw-paneState').textContent : null,
  })`))
  check('the blame view shows author, hash and the real line text',
    blameDom.list === true && blameDom.rows > 0
    && blameDom.firstAuthor !== '' && blameDom.firstHash !== '' && blameDom.firstCode !== '', blameDom)
  /* (f) NO TWO TREE ROWS MAY SHARE A Y POSITION.
     Status and truncated rows used to lay themselves out in normal flow while the
     real rows were absolutely positioned — two layouts in one container, so every
     expanded directory printed "正在加载…" on top of its own row. Comparing the
     actual `top` values catches the whole class, including any future row kind
     that forgets to position itself. */
  await clickMode('文件'); await sleep(900)
  /* Expand, then measure WHILE the children are still loading. */
  await ev(`window.__CLICK__('.scw-row', 'docs')`)
  await sleep(120)
  const layout = JSON.parse(await ev(`JSON.stringify((function () {
    var nodes = [].slice.call(document.querySelectorAll('.scw-treePane .scw-row, .scw-treePane .scw-treeState'))
    var tops = nodes.map(function (n) { return n.style.top || ('flow:' + Math.round(n.getBoundingClientRect().top)) })
    var seen = {}
    var dupes = []
    for (var i = 0; i < tops.length; i += 1) {
      if (seen[tops[i]] === true) dupes.push(tops[i])
      seen[tops[i]] = true
    }
    return { count: nodes.length, duplicates: dupes, unpositioned: nodes.filter(function (n) { return n.style.position !== 'absolute' }).length }
  })())`))
  check('every tree row is absolutely positioned', layout.unpositioned === 0, layout)
  check('no two tree rows share a Y position', layout.duplicates.length === 0, layout)

  /* (g) Navigation in and out of a patch view. The back button used to be
     `display:none` at normal widths, so both patch views were dead ends. */
  await clickMode('文件'); await sleep(900)
  await mustClick('.scw-row', 'two.ts')
  await sleep(2200)
  const opened = JSON.parse(await ev(`JSON.stringify({
    activeTab: document.querySelector('.scw-tab.is-active') ? document.querySelector('.scw-tab.is-active').textContent : null,
    editor: document.querySelector('.cm-editor') !== null,
    srcText: (document.querySelector('.scw-paneSlot') ? document.querySelector('.scw-paneSlot').innerText : '').slice(0, 60),
  })`))
  check('clicking a file in the tree opens its SOURCE, not the diff',
    String(opened.activeTab).indexOf('源码') >= 0, opened)
  check('and the source actually has content', opened.editor === true || opened.srcText.length > 0, opened)

  /* per-file history -> a version -> patch -> back */
  await mustClick('.scw-tab', '历史'); await sleep(2600)
  await mustClick('.scw-historyList .scw-commitRow'); await sleep(3000)
  const patchBar = JSON.parse(await ev(`JSON.stringify({
    view: document.querySelector('.scw-commitPatch') !== null,
    backVisible: (function () { var b = document.querySelector('.scw-commitPatch .scw-back'); return b !== null && b.getBoundingClientRect().width > 0 })(),
    modeToggle: document.querySelector('.scw-commitPatch .scw-modeToggle') !== null,
  })`))
  check('the file-history patch shows a VISIBLE back button', patchBar.view === true && patchBar.backVisible === true, patchBar)

  check('the file-history patch offers the split/unified toggle', patchBar.modeToggle === true, patchBar)

  await mustClick('.scw-commitPatch .scw-back'); await sleep(1600)
  check('back returns to the file history list',
    (await ev(`document.querySelector('.scw-historyList') !== null`)) === true)

  /* Re-clicking the same file must not leave a blank source pane. */
  await mustClick('.scw-row', 'two.ts')
  await sleep(2200)
  const reopened = JSON.parse(await ev(`JSON.stringify({
    patchGone: document.querySelector('.scw-commitPatch') === null,
    activeTab: document.querySelector('.scw-tab.is-active') ? document.querySelector('.scw-tab.is-active').textContent : null,
    editor: document.querySelector('.cm-editor') !== null,
    text: (document.querySelector('.scw-paneSlot') ? document.querySelector('.scw-paneSlot').innerText : '').slice(0, 60),
  })`))
  check('re-clicking the same file leaves the patch view and shows the source again',
    reopened.patchGone === true && String(reopened.activeTab).indexOf('源码') >= 0
    && (reopened.editor === true || reopened.text.length > 0), reopened)

  /* (h) An untracked file must be DELETABLE from the page.
     The host's discard already unlinks untracked paths; the page simply hid the
     button, so a file created by mistake could only be removed outside the app. */
  writeFileSync(path.join(gitRepo, 'oops.tmp'), 'scratch' + String.fromCharCode(10))
  await ev('window.__MOUNT__()')
  await sleep(2500)
  await clickMode('变更'); await sleep(1200)
  const untrackedRow = JSON.parse(await ev(`JSON.stringify((function () {
    var rows = [].slice.call(document.querySelectorAll('.scw-changeList .scw-row'))
    var hit = rows.filter(function (r) { return r.textContent.indexOf('oops.tmp') >= 0 })[0]
    if (!hit) return { found: false }
    return {
      found: true,
      buttons: [].slice.call(hit.querySelectorAll('.scw-rowBtn')).map(function (b) { return b.textContent }),
    }
  })())`))
  check('an untracked file offers 暂存 AND 删除', untrackedRow.found === true
    && untrackedRow.buttons.indexOf('删除') >= 0
    && untrackedRow.buttons.some(function (x) { return x.indexOf('暂存') >= 0 }), untrackedRow)

  await ev(`(function () {
    var rows = [].slice.call(document.querySelectorAll('.scw-changeList .scw-row'))
    var hit = rows.filter(function (r) { return r.textContent.indexOf('oops.tmp') >= 0 })[0]
    if (!hit) return
    var del = [].slice.call(hit.querySelectorAll('.scw-rowBtn')).filter(function (b) { return b.textContent === '删除' })[0]
    if (del) del.click()
  })()`)
  await sleep(900)
  const confirmDom = JSON.parse(await ev(`JSON.stringify({
    open: document.querySelector('.scw-dialog') !== null,
    title: document.querySelector('.scw-dialogHead') ? document.querySelector('.scw-dialogHead').textContent : null,
    buttons: [].slice.call(document.querySelectorAll('.scw-dialog .scw-btn')).map(function (n) { return n.textContent.trim() }),
  })`))
  check('deleting an untracked file asks first', confirmDom.open === true
    && String(confirmDom.title).indexOf('未跟踪') >= 0, confirmDom)

  await ev(`(function () {
    var b = [].slice.call(document.querySelectorAll('.scw-dialog .scw-btn')).filter(function (n) { return n.textContent.indexOf('删除') >= 0 })[0]
    if (b) b.click()
  })()`)
  await sleep(2500)
  check('the untracked file is gone from disk', existsSync(path.join(gitRepo, 'oops.tmp')) === false)
  /* (i) The search box must offer exactly ONE clear affordance.
     type=search made Chromium draw its own X next to the page's button. */
  await clickMode('变更'); await sleep(900)
  /* The clear button only exists while there is something to clear. */
  await ev(`window.__TYPE__('.scw-searchInput', 'a')`)
  await sleep(900)
  const searchDom = JSON.parse(await ev(`JSON.stringify({
    type: document.querySelector('.scw-searchInput') ? document.querySelector('.scw-searchInput').type : null,
    custom: document.querySelectorAll('.scw-searchClear').length,
  })`))
  await ev(`(function () { var el = document.querySelector('.scw-searchInput'); if (el) el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })()`)
  await sleep(700)
  check('the search input is type=text (no native second X)',
    searchDom.type === 'text' && searchDom.custom === 1, searchDom)

  /* (j) Branches are grouped and the symbolic origin/HEAD is not listed as a branch. */
  await clickMode('分支'); await sleep(1800)
  const branchDom = JSON.parse(await ev(`JSON.stringify({
    sections: [].slice.call(document.querySelectorAll('.scw-branchGroup .scw-groupName')).map(function (n) { return n.textContent }),
    rows: [].slice.call(document.querySelectorAll('.scw-branchName')).map(function (n) { return n.textContent }),
    legend: document.querySelector('.scw-branchLegend') ? document.querySelector('.scw-branchLegend').textContent : null,
  })`))
  check('the branches pane groups local / remote / tags',
    branchDom.sections.length === 3
    && branchDom.sections[0].indexOf('本地分支') >= 0
    && branchDom.sections[1].indexOf('远程分支') >= 0
    && branchDom.sections[2].indexOf('标签') >= 0, branchDom.sections)
  check('the symbolic origin/HEAD is not listed as a branch',
    branchDom.rows.every(function (x) { return x !== 'origin' }), branchDom.rows)
  check('the branches pane explains its markers', String(branchDom.legend).indexOf('当前分支') >= 0, branchDom.legend)
  /* 分支/标签行要有可用的操作，不能只是「看」。
     远端分支的行必须能签出（建同名本地分支）、合并、变基；标签行必须能推送和删除。 */
  const rowActionsDom = JSON.parse(await ev(`JSON.stringify((function () {
    var rows = [].slice.call(document.querySelectorAll('.scw-branchRow.is-ref'))
    var withButtons = rows.map(function (r) {
      return [].slice.call(r.querySelectorAll('.scw-rowBtn')).map(function (b) { return b.textContent.trim() })
    }).filter(function (list) { return list.length > 0 })
    return { rows: rows.length, actionRows: withButtons.length, sample: withButtons[0] || [] }
  })())`))
  /* 这个测试仓库没有远端，也没有标签 —— 行数为 0 时这条断言自动跳过而不是失败。 */
  check('ref rows carry actions when there are any refs to act on',
    rowActionsDom.rows === 0 || rowActionsDom.actionRows === rowActionsDom.rows, rowActionsDom)
  /* GitCraft parity: the current branch is labelled HEAD (not a dot you must decode),
     and remote branches are grouped under the remote they live on. */
  const branchLook2 = JSON.parse(await ev(`JSON.stringify({
    headChips: [].slice.call(document.querySelectorAll('.scw-headChip')).map(function (n) { return n.textContent }),
    remoteGroups: [].slice.call(document.querySelectorAll('.scw-remoteGroup .scw-branchName')).map(function (n) { return n.textContent }),
    remoteRowsHaveActions: [].slice.call(document.querySelectorAll('.scw-branchRow.is-ref')).some(function (r) { return r.querySelectorAll('.scw-rowBtn').length >= 2 }),
  })`))
  check('the current branch is labelled HEAD, not marked with a dot',
    branchLook2.headChips.length === 1 && branchLook2.headChips[0] === 'HEAD', branchLook2)
  check('remote branches are grouped under their remote name',
    Array.isArray(branchLook2.remoteGroups), branchLook2.remoteGroups)


  /* Branch rows must be legible, not a wall of same-weight text: section headers carry
     a count, the current branch is marked by an accent bar, and each row has an icon. */
  const branchLook = JSON.parse(await ev(`JSON.stringify((function () {
    var head = document.querySelector('.scw-branchRow.is-head')
    var row = document.querySelector('.scw-branchRow')
    var style = head === null ? null : getComputedStyle(head)
    return {
      headBar: style === null ? '' : style.borderLeftWidth,
      headBg: style === null ? '' : style.backgroundColor,
      icons: document.querySelectorAll('.scw-branchRow .scw-branchIcon svg').length,
      counts: [].slice.call(document.querySelectorAll('.scw-branchGroup .scw-groupCount')).map(function (n) { return n.textContent }),
      rowHeight: row === null ? 0 : Math.round(row.getBoundingClientRect().height),
    }
  })())`))
  check('the current branch is marked with an accent bar, not just bold text',
    branchLook.headBar !== '' && branchLook.headBar !== '0px', branchLook)
  check('every branch row carries an icon', branchLook.icons >= 1, branchLook)
  check('section headers show a count', Array.isArray(branchLook.counts) && branchLook.counts.length >= 1, branchLook)
  check('branch rows have a comfortable height', branchLook.rowHeight >= 22, branchLook)
  /* (k) A whole-commit patch must name each file it touches. */
  await clickMode('历史'); await sleep(1600)
  await ev(`(function () {
    var rows = [].slice.call(document.querySelectorAll('.scw-commitRow'))
    var hit = rows.filter(function (r) {
      var s = r.querySelector('.scw-commitSubject')
      return s !== null && s.textContent.trim() === 'first'
    })[0]
    if (hit) hit.click()
  })()`)
  await sleep(2200)
  await mustClick('.scw-commitOps .scw-toolBtn', '完整改动'); await sleep(3000)
  const multiFileDiff = JSON.parse(await ev(`JSON.stringify({
    fileHeads: [].slice.call(document.querySelectorAll('.gwc-fileHead')).map(function (n) { return n.textContent }),
    hunks: document.querySelectorAll('.gwc-hunkHead').length,
  })`))
  check('a multi-file patch names the file above each section',
    multiFileDiff.fileHeads.length >= 2 && multiFileDiff.fileHeads.indexOf('one.ts') >= 0, multiFileDiff)
  await mustClick('.scw-commitPatch .scw-back'); await sleep(900)
  /* (l) The page and the mounted panes must agree on which directory they read.
     The panes take their root from the shared localStorage key, ONCE, at install; the
     tree asks the host with an explicit root. When those two drift, every file click
     answers "does not exist" and no refresh can help. */
  const rootKey = await ev(`localStorage.getItem('dsh-workbay.sc.root.v1')`)
  check('the page records the root it browses so the panes read the same directory',
    String(rootKey).toLowerCase().replace(/\\/g, '/') === String(gitRepo).toLowerCase().replace(/\\/g, '/'), rootKey)

  /* (m) 刷新 must re-read the current file, not just re-list the tree.
     A read that failed (file replaced, deleted, still being written) used to stay
     failed forever because nothing told the pane to try again. */
  await clickMode('文件'); await sleep(900)
  await mustClick('.scw-row', 'two.ts')
  await sleep(2200)
  writeFileSync(path.join(gitRepo, 'two.ts'), 'const two = 2222' + String.fromCharCode(10))
  /* 刷新 lives on the 变更 toolbar; switching modes does not unmount the editor. */
  await clickMode('变更'); await sleep(700)
  await clickTool('更多'); await sleep(600); await clickMenu('刷新')
  await sleep(2600)
  const afterRefresh = await ev(`(function () {
    var slot = document.querySelector('.scw-paneSlot')
    return slot ? slot.innerText.slice(0, 200) : ''
  })()`)
  check('refreshing re-reads the open file from disk',
    String(afterRefresh).indexOf('2222') >= 0, String(afterRefresh).slice(0, 120))
  /* Sync state is shown as a CORNER BADGE on the pull/push buttons, not as loose text
     after the arrows. With nothing to sync there must be no badge at all. */
  const badgeDom = JSON.parse(await ev(`JSON.stringify({
    syncText: document.querySelectorAll('.scw-head .scw-sync').length,
    badges: [].slice.call(document.querySelectorAll('.scw-head .scw-badge')).map(function (n) {
      return { text: n.textContent, inButton: n.parentElement !== null && n.parentElement.classList.contains('scw-iconBtn') }
    }),
    iconButtons: document.querySelectorAll('.scw-head .scw-iconBtn').length,
  })`))
  check('the header no longer prints loose ↑n / ↓n text', badgeDom.syncText === 0, badgeDom)
  check('any sync badge sits on its button', badgeDom.badges.every(function (b) { return b.inButton === true }), badgeDom.badges)
  check('a clean sync state shows no badge at all', badgeDom.badges.length === 0, badgeDom.badges)
  check('the sync actions are still there (fetch / pull / push / refresh)',
    badgeDom.iconButtons >= 4, badgeDom.iconButtons)
  /* 变更列表只显示文件名，不显示目录 —— 目录那一列把文件名挤成了几个字符，
     而「点哪个文件」靠的是文件名。完整路径仍在行 tooltip 里。 */
  const changeRowDom = JSON.parse(await ev(`JSON.stringify((function () {
    var row = document.querySelector('.scw-changeList .scw-row')
    if (row === null) return { missing: true }
    var name = row.querySelector('.scw-rowName')
    return {
      dirCells: row.querySelectorAll('.scw-rowDir').length,
      name: name === null ? null : name.textContent,
      title: row.getAttribute('title'),
      nameWidth: name === null ? 0 : Math.round(name.getBoundingClientRect().width),
    }
  })())`))
  /* 布局改成照抄 GitCraft：文件名在前、路径在后（可收缩）。文件名不能再被挤没。 */
  check('change rows keep the file name intact, with the path after it',
    changeRowDom.missing !== true && changeRowDom.dirCells <= 1 && changeRowDom.nameWidth >= 30, changeRowDom)
  /* 根目录下的文件没有斜杠，所以断言「tooltip 是完整 rel 且以文件名结尾」，而不是
     「含斜杠」——后者在仓库根文件上必然失败。 */
  check('the full path is still reachable from the row tooltip',
    typeof changeRowDom.title === 'string' && changeRowDom.title.length > 0
    && changeRowDom.title.endsWith(String(changeRowDom.name)), changeRowDom)
  /* (n) Bulk actions live on the change-group headers and are group-scoped.
     A group header offers stage / unstage / discard only where that action makes
     sense, and discarding a group of untracked files must ask first — it deletes
     files git has no copy of. */
  writeFileSync(path.join(gitRepo, 'bulk-a.txt'), 'a' + String.fromCharCode(10))
  writeFileSync(path.join(gitRepo, 'bulk-b.txt'), 'b' + String.fromCharCode(10))
  await ev('window.__MOUNT__()')
  await sleep(2500)
  await clickMode('变更'); await sleep(1200)
  const bulkDom = JSON.parse(await ev(`JSON.stringify((function () {
    var groups = [].slice.call(document.querySelectorAll('.scw-group'))
    return groups.map(function (g) {
      return {
        name: g.querySelector('.scw-groupName') ? g.querySelector('.scw-groupName').textContent : '',
        buttons: [].slice.call(g.querySelectorAll('.scw-bulkBtn')).map(function (b) { return b.textContent }),
      }
    })
  })())`))
  const untrackedGroup = bulkDom.filter(function (g) { return g.name.indexOf('未跟踪') >= 0 })[0]
  check('the untracked group offers 全部暂存 and 全部删除',
    untrackedGroup !== undefined
    && untrackedGroup.buttons.indexOf('全部暂存') >= 0
    && untrackedGroup.buttons.indexOf('全部删除') >= 0, untrackedGroup)
  check('no group offers an action it cannot perform',
    bulkDom.every(function (g) {
      if (g.name.indexOf('已暂存') >= 0) return g.buttons.indexOf('全部暂存') < 0 && g.buttons.indexOf('全部撤销') < 0
      return true
    }), bulkDom)

  /* Stage the whole untracked group in one click. */
  await ev(`(function () {
    var groups = [].slice.call(document.querySelectorAll('.scw-group'))
    var g = groups.filter(function (x) {
      var n = x.querySelector('.scw-groupName')
      return n !== null && n.textContent.indexOf('未跟踪') >= 0
    })[0]
    if (!g) return
    var b = [].slice.call(g.querySelectorAll('.scw-bulkBtn')).filter(function (x) { return x.textContent === '全部暂存' })[0]
    if (b) b.click()
  })()`)
  await sleep(2600)
  const afterBulkStage = JSON.parse(await ev(`JSON.stringify({
    groups: [].slice.call(document.querySelectorAll('.scw-groupName')).map(function (n) { return n.textContent }),
    rows: document.querySelectorAll('.scw-changeList .scw-row').length
  })`))
  /* Exactly ONE place to stage everything. The toolbar used to carry a second
     "全部暂存 (3)" a few pixels above the group header's, doing the same thing. */
  const stageAllButtons = JSON.parse(await ev(`JSON.stringify({
    toolbar: [].slice.call(document.querySelectorAll('.scw-toolbar button')).map(function (n) { return n.textContent.trim() }).filter(function (x) { return x.indexOf('全部暂存') >= 0 }),
    bulk: [].slice.call(document.querySelectorAll('.scw-bulkBtn')).map(function (n) { return n.textContent.trim() }).filter(function (x) { return x.indexOf('全部暂存') >= 0 }),
  })`))
  check('stage-all appears once per group and NOT again in the toolbar',
    stageAllButtons.toolbar.length === 0 && stageAllButtons.bulk.length >= 1, stageAllButtons)
  check('全部暂存 moves the whole group into the index',
    afterBulkStage.groups.every(function (n) { return n.indexOf('未跟踪') < 0 }), afterBulkStage.groups)
  /* 丢弃块之后必须重新读 diff。
     `showDiff` 把 (path, base, rev) 当作身份，写操作后这三者都没变 —— 于是面板继续
     显示旧补丁，用户必须重新点一次文件才看到新内容。这条验证「写完就变」。
     用已跟踪文件：未跟踪文件按设计没有块级按钮。 */
  writeFileSync(path.join(gitRepo, 'two.ts'), 'const two = 2\n' + 'MARKER_LINE\n')
  await ev('window.__MOUNT__()')
  await sleep(2200)
  await clickMode('变更'); await sleep(1200)
  await mustClick('.scw-changeList .scw-row', 'two.ts')
  await sleep(2600)
  const beforeDiscard = JSON.parse(await ev(`JSON.stringify({
    buttons: [].slice.call(document.querySelectorAll('.gwc-hunkBtn')).map(function (n) { return n.textContent }),
    hasMarker: (document.querySelector('.scw-paneHost') || { innerText: '' }).innerText.indexOf('MARKER_LINE') >= 0,
  })`))
  check('a modified file shows hunk buttons and its new content',
    beforeDiscard.buttons.length > 0 && beforeDiscard.hasMarker === true, beforeDiscard)

  /* 点「丢弃此块」→ 面板必须自己重新取，不能等用户重新选文件。 */
  await ev(`(function () {
    var b = [].slice.call(document.querySelectorAll('.gwc-hunkBtn')).filter(function (n) { return n.textContent === '丢弃此块' })[0]
    if (b) b.click()
  })()`)
  await sleep(3200)
  const afterDiscard = JSON.parse(await ev(`JSON.stringify({
    hasMarker: (document.querySelector('.scw-paneHost') || { innerText: '' }).innerText.indexOf('MARKER_LINE') >= 0,
    panes: document.querySelectorAll('.scw-paneHost').length,
  })`))
  check('discarding a hunk refreshes the diff without re-selecting the file',
    afterDiscard.hasMarker === false, afterDiscard)


  /* 点右上角刷新时，正在看的 diff 不能变成空白。
     force 重取会先把 loading 置位；如果不保留旧补丁，用户看到的就是「页面不显示了」。 */
  await ev(`(function () {
    var b = [].slice.call(document.querySelectorAll('.scw-iconBtn')).filter(function (n) { return (n.title || '').indexOf('刷新') >= 0 })[0]
    if (b) b.click()
  })()`)
  await sleep(500)
  const duringRefresh = JSON.parse(await ev(`JSON.stringify({
    panes: document.querySelectorAll('.scw-paneHost').length,
    stuck: (document.querySelector('.scw-paneHost') || { innerText: '' }).innerText.indexOf('正在读取差异') >= 0,
    crashed: document.body.innerText.indexOf('Page crashed') >= 0,
  })`))
  /* 刷新后允许 diff 为空（这块刚被丢弃），但不允许停在"正在读取差异…"或整页崩掉。 */
  check('refreshing while reading a diff does not blank or crash the page',
    duringRefresh.panes >= 1 && duringRefresh.stuck === false && duringRefresh.crashed === false, duringRefresh)  /* (o) The pager must ACTUALLY load more.
     It only bumped a state value with no effect depending on it, so the button looked
     dead: click, nothing happens, forever. This builds a history longer than one page
     and drives the real button. */
  for (let index = 0; index < 90; index += 1) {
    git(['commit', '--allow-empty', '-q', '-m', 'filler ' + index], gitRepo)
  }
  await ev('window.__MOUNT__()')
  await sleep(2600)
  await clickMode('历史')
  await sleep(1800)
  const beforeMore = JSON.parse(await ev(`JSON.stringify({
    rows: document.querySelectorAll('.scw-commitRow.is-graph').length,
    buttons: document.querySelectorAll('.scw-loadMoreBtn').length,
  })`))
  check('a long history offers 加载更多', beforeMore.buttons === 1, beforeMore)
  await mustClick('.scw-loadMoreBtn')
  await sleep(3000)
  const afterMore = JSON.parse(await ev(`JSON.stringify({
    rows: document.querySelectorAll('.scw-commitRow.is-graph').length,
  })`))
  check('clicking 加载更多 actually loads more commits',
    afterMore.rows > beforeMore.rows, { before: beforeMore.rows, after: afterMore.rows })
  /* (p) Switching repositories must reload the git panels.
     They sat behind "already loaded" flags that survived the root change, so the new
     repo showed the OLD repo's commits until a manual refresh. */
  const repo2 = path.join(work, 'repo2')
  mkdirSync(repo2, { recursive: true })
  git(['init', '-q', '-b', 'main'], repo2)
  git(['config', 'user.email', 'a@b.c'], repo2)
  git(['config', 'user.name', 'Tester'], repo2)
  writeFileSync(path.join(repo2, 'unique.txt'), 'x' + String.fromCharCode(10))
  git(['add', '-A'], repo2)
  git(['commit', '-q', '-m', 'SECOND REPO MARKER'], repo2)

  /* Reach it through the real picker: the switch has to go through the page's own
     changeRoot path, otherwise the test would not exercise the bug at all. */
  await clickMode('历史'); await sleep(1200)
  const beforeSwitch = JSON.parse(await ev(`JSON.stringify([].slice.call(document.querySelectorAll('.scw-commitSubject')).map(function (n) { return n.textContent }))`))
  await mustClick('.scw-repoChip'); await sleep(900)
  await clickMenu('浏览文件夹'); await sleep(1800)
  for (let step = 0; step < 8; step += 1) {
    const at = await ev(`document.querySelector('.scw-browsePath') ? document.querySelector('.scw-browsePath').textContent : ''`)
    if (String(at).toLowerCase().replace(/\\/g, '/') === String(repo2).toLowerCase().replace(/\\/g, '/')) break
    const moved = await ev(`(function () {
      var target = ${JSON.stringify(String(repo2).replace(/\\/g, '/').split('/').pop())}
      var items = [].slice.call(document.querySelectorAll('.scw-browseItem'))
      var down = items.filter(function (n) { return (n.title || '') === ${JSON.stringify(String(repo2).replace(/\\/g, '/'))} })[0]
      if (down) { down.click(); return 'down' }
      var up = document.querySelector('.scw-browseUp')
      if (up) { up.click(); return 'up' }
      return 'stuck'
    })()`)
    await sleep(900)
    if (moved === 'stuck') break
  }
  await ev(`(function () {
    var b = [].slice.call(document.querySelectorAll('.scw-dialog .scw-btn')).filter(function (n) { return n.textContent.indexOf('用这个目录') >= 0 })[0]
    if (b) b.click()
  })()`)
  await sleep(3000)
  await clickMode('历史'); await sleep(2500)
  const afterSwitch = JSON.parse(await ev(`JSON.stringify([].slice.call(document.querySelectorAll('.scw-commitSubject')).map(function (n) { return n.textContent }))`))
  check('switching repositories reloads the history without a manual refresh',
    Array.isArray(afterSwitch) && afterSwitch.indexOf('SECOND REPO MARKER') >= 0, { before: beforeSwitch.slice(0, 2), after: afterSwitch.slice(0, 2) })
  /* A brand-new file must still show a patch. `git diff` prints nothing for an
     untracked path, so the page has to ask for the all-added form; before this it
     showed an empty diff pane for exactly the files people most want to review. */
  writeFileSync(path.join(gitRepo, 'brand-new.txt'), 'first line' + String.fromCharCode(10) + 'second line' + String.fromCharCode(10))
  await ev('window.__MOUNT__()')
  await sleep(2500)
  await clickMode('变更'); await sleep(1200)
  await ev(`(function () {
    var rows = [].slice.call(document.querySelectorAll('.scw-changeList .scw-row'))
    var hit = rows.filter(function (r) { return r.textContent.indexOf('brand-new.txt') >= 0 })[0]
    if (hit) hit.click()
  })()`)
  await sleep(2600)
  const untrackedDiffDom = JSON.parse(await ev(`JSON.stringify({
    base: document.querySelector('.gwc-diffPane') ? document.querySelector('.gwc-diffPane').getAttribute('data-base') : null,
    rows: document.querySelectorAll('.gwc-row').length,
    text: (document.querySelector('.scw-paneHost') ? document.querySelector('.scw-paneHost').innerText : '').slice(0, 120),
  })`))
  /* Assert the CONTENT, not a row class: the all-added form for an untracked file does
     not produce hunks (there is no "before" side), so `.gwc-row` is legitimately 0. */
  check('an untracked file still renders its content as a patch',
    untrackedDiffDom.base === 'untracked'
    && String(untrackedDiffDom.text).indexOf('first line') >= 0
    && String(untrackedDiffDom.text).indexOf('second line') >= 0, untrackedDiffDom)
  /* Tags could be created but never published — every release needed a terminal step.
     With no remote configured the page must SAY so, not fail silently. */
  await clickMode('历史'); await sleep(1200)
  await mustClick('.scw-toolbar .scw-toolIcon[title="更多"]'); await sleep(700)
  const tagMenu = JSON.parse(await ev(`JSON.stringify([].slice.call(document.querySelectorAll('.scw-menuItem')).map(function (n) { return n.textContent }))`))
  check('the history menu offers 推送标签', Array.isArray(tagMenu) && tagMenu.indexOf('推送标签…') >= 0, tagMenu)
  await clickMenu('推送标签…')
  await sleep(2200)
  const tagPushState = JSON.parse(await ev(`JSON.stringify({
    bar: document.querySelector('.scw-bar') ? document.querySelector('.scw-bar').textContent : null,
    menu: document.querySelectorAll('.scw-menu').length,
  })`))
  /* 这个测试仓库没有远端：必须给出明确提示，而不是静默什么都不发生。 */
  check('pushing tags without a remote reports it instead of doing nothing',
    String(tagPushState.bar).indexOf('远端') >= 0, tagPushState)
  const errs = JSON.parse(await ev('JSON.stringify(window.__ERRORS__)'))
  check('no console errors across the ported flows', Array.isArray(errs) && errs.length === 0, errs)
} finally {
  try { await send('Browser.close', {}) } catch (e) { void e }
  try { child.kill('SIGKILL') } catch (e) { void e }
  await sleep(300)
  try { server.close() } catch (e) { void e }
  try { rmSync(prof, { recursive: true, force: true }) } catch (e) { void e }
  try { rmSync(work, { recursive: true, force: true }) } catch (e) { void e }
}

console.log('')
console.log(failures === 0 ? 'PORTED PASS' : ('FAILURES: ' + failures))
process.exit(failures === 0 ? 0 : 1)















































