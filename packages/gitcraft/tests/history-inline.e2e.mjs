/**
 * History page: no duplicate stat block, and commit diffs open IN PLACE.
 *
 * Reported: the red-outlined region (a `git show --stat` dump) duplicated the
 * "变更文件" list right below it; and clicking a file inside a commit jumped to the
 * Changes tab, losing the commit being read.
 *
 * Usage: node tests/history-inline.e2e.mjs <base-url> <browser-exe> <repo-path> [shot.png]
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const [baseUrl, browser, repoPath, shotPath] = process.argv.slice(2)
if (baseUrl === undefined || browser === undefined || repoPath === undefined) {
  console.error('usage: node tests/history-inline.e2e.mjs <base-url> <browser-exe> <repo-path> [shot.png]')
  process.exit(2)
}

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok })
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || detail === undefined ? '' : ' — ' + detail))
}

const port = 10160 + Math.floor(Math.random() * 30)
const dir = mkdtempSync(path.join(tmpdir(), 'histinline-'))
const child = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, '--window-size=1700,950', 'about:blank'], { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

for (let i = 0; i < 90; i += 1) { try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) break } catch { /* up */ } await sleep(300) }
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r))
let nextId = 1
const pending = new Map()
ws.addEventListener('message', (e) => {
  const p = JSON.parse(e.data)
  if (p.id !== undefined && pending.has(p.id)) {
    const { resolve, reject } = pending.get(p.id)
    pending.delete(p.id)
    p.error ? reject(new Error(p.error.message)) : resolve(p.result)
  }
})
const send = (m, p) => { const i = nextId++; return new Promise((res, rej) => { pending.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })) }) }
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true, userGesture: true })
  if (r.exceptionDetails !== undefined) return { __error: String(r.exceptionDetails.exception?.description ?? '').slice(0, 400) }
  return r.result.value
}
const clickAt = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await sleep(1200)
}

await send('Page.enable')
await send('Runtime.enable')
const preload = `(function(){
  var repo = ${JSON.stringify(repoPath)}
  try { window.localStorage.setItem('dsh-gitcraft.ref.v1', JSON.stringify({ path: repo })) } catch (e) {}
  var of = window.fetch
  window.fetch = function (u, i) {
    try { if (String(u).indexOf('dsh-gitcraft/api/') !== -1 && i && typeof i.body === 'string') {
      var b = JSON.parse(i.body); if (b.cwd === undefined) b.cwd = repo; if (b.repoRoot === undefined) b.repoRoot = repo
      delete b.sessionId; i = Object.assign({}, i, { body: JSON.stringify(b) }) } } catch (e) {}
    return of.apply(this, arguments)
  }
})()`
await send('Page.addScriptToEvaluateOnNewDocument', { source: preload })
await send('Page.navigate', { url: baseUrl })
await sleep(22000)
await ev(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>(x.innerText||'').trim()==='继续'); if(b)b.click(); return !!b})()`)
await sleep(1500)

/* open the dock */
const rowPoint = await ev(`(() => { const el=document.querySelector('.wbd-entryBtn'); if(!el) return null; let r=el.parentElement; while(r && r.getBoundingClientRect().width<120) r=r.parentElement; if(!r) return null; const b=r.getBoundingClientRect(); return {x:Math.round(b.x+b.width*0.8), y:Math.round(b.y+b.height/2)} })()`)
if (rowPoint !== null) await clickAt(rowPoint.x, rowPoint.y)
await sleep(2500)

/* Wait for the panel to actually hold a repository before switching tabs: the
   nav effect needs a loaded snapshot, and switching earlier leaves the list empty. */
for (let i = 0; i < 80; i += 1) {
  const ready = await ev(`(() => document.querySelectorAll('.gwc-changeRow').length > 0)()`)
  if (ready === true) break
  await sleep(600)
}

/* go to History and select the newest commit */
await ev(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const tab = Array.from(document.querySelectorAll('.gwc-navBtn')).find((t) => /历史|History/.test(t.innerText || ''))
  if (tab) tab.click()
  await sleep(3500)
  return true
})()`)

for (let i = 0; i < 25; i += 1) {
  const rows = await ev(`(() => document.querySelectorAll('.gwc-commitRow').length)()`)
  if (typeof rows === 'number' && rows > 0) break
  await sleep(600)
}
await ev(`(() => { const row = document.querySelector('.gwc-commitRow'); if (row) row.click(); return true })()`)

/* wait for the detail to arrive */
for (let i = 0; i < 20; i += 1) {
  const has = await ev(`(() => document.querySelectorAll('.gwc-commitDetail .gwc-changeRow').length)()`)
  if (typeof has === 'number' && has > 0) break
  await sleep(600)
}

const detail = await ev(`(() => {
  const root = document.querySelector('.gwc-root')
  return {
    statBlocks: document.querySelectorAll('.gwc-detailStat').length,
    fileRows: document.querySelectorAll('.gwc-commitDetail .gwc-changeRow').length,
    text: root === null ? '' : (root.innerText || '').replace(/\\s+/g, ' ').slice(0, 200),
  }
})()`)
record('the commit detail lists its changed files', detail.fileRows > 0, JSON.stringify({ fileRows: detail.fileRows }))
record('the duplicated --stat block is gone', detail.statBlocks === 0, 'stat blocks=' + detail.statBlocks)

/* click a file: the diff must open HERE, not on the Changes tab */
const clicked = await ev(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const row = document.querySelector('.gwc-commitDetail .gwc-changeRow')
  if (row === null) return { error: 'no file row' }
  row.click()
  await sleep(4000)
  const activeNav = Array.from(document.querySelectorAll('.gwc-navBtn')).find((t) => t.className.includes('is-active'))
  return {
    activeNav: activeNav === null ? null : (activeNav.innerText || '').trim(),
    historyDiff: document.querySelectorAll('.gwc-historyDiff').length,
    hunks: document.querySelectorAll('.gwc-historyDiff .gwc-hunk').length,
    changesVisible: document.querySelectorAll('.gwc-changeListPane').length,
  }
})()`)
console.log('CLICK:', JSON.stringify(clicked))
record('clicking a commit file keeps the History tab active',
  clicked.activeNav !== null && /历史|History/.test(String(clicked.activeNav)), String(clicked.activeNav))
record('the diff opens inside the History page', clicked.historyDiff === 1 && clicked.hunks > 0,
  JSON.stringify({ historyDiff: clicked.historyDiff, hunks: clicked.hunks }))
record('it does not switch to the Changes view', clicked.changesVisible === 0, 'change panes=' + clicked.changesVisible)

/* ---- the upper area is resizable against the diff ---- */
const beforeDrag = await ev(`(() => {
  const main = document.querySelector('.gwc-historyMain')
  const diff = document.querySelector('.gwc-historyDiff')
  /* the History page now has TWO splitters (list/detail and detail-area/diff) */
  const bar = document.querySelector('.gwc-splitBar.is-historyDiff')
  if (main === null || diff === null || bar === null) return null
  const br = bar.getBoundingClientRect()
  return {
    main: Math.round(main.getBoundingClientRect().height),
    diff: Math.round(diff.getBoundingClientRect().height),
    bar: { x: Math.round(br.x + br.width / 2), y: Math.round(br.y + br.height / 2) },
  }
})()`)
console.log('BEFORE DRAG:', JSON.stringify(beforeDrag))
record('a splitter sits between the file list and the diff', beforeDrag !== null, JSON.stringify(beforeDrag))

if (beforeDrag !== null) {
  /* drag the splitter UP: the list shrinks, the diff grows */
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: beforeDrag.bar.x, y: beforeDrag.bar.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: beforeDrag.bar.x, y: beforeDrag.bar.y - 120, button: 'left' })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: beforeDrag.bar.x, y: beforeDrag.bar.y - 120, button: 'left', clickCount: 1 })
  await sleep(1200)
  const afterDrag = await ev(`(() => {
    const main = document.querySelector('.gwc-historyMain')
    const diff = document.querySelector('.gwc-historyDiff')
    return {
      main: main === null ? null : Math.round(main.getBoundingClientRect().height),
      diff: diff === null ? null : Math.round(diff.getBoundingClientRect().height),
      dockOpen: document.querySelectorAll('.wbd-docked').length === 1,
    }
  })()`)
  console.log('AFTER DRAG:', JSON.stringify(afterDrag))
  record('dragging the splitter enlarges the diff and shrinks the list',
    typeof afterDrag.main === 'number' && afterDrag.main < beforeDrag.main - 40
      && typeof afterDrag.diff === 'number' && afterDrag.diff > beforeDrag.diff + 40,
    JSON.stringify({ beforeDrag, afterDrag }))
  record('dragging does not close the dock', afterDrag.dockOpen === true, JSON.stringify(afterDrag))
}

/* closing the inline diff returns to the plain history list */
const closed = await ev(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const btn = document.querySelector('.gwc-historyDiffActions button[aria-label]')
  const closeBtn = Array.from(document.querySelectorAll('.gwc-historyDiffActions button')).find((b) => /关闭|Close/.test(b.getAttribute('aria-label') || ''))
  const target = closeBtn || btn
  if (target) target.click()
  await sleep(1200)
  return { historyDiff: document.querySelectorAll('.gwc-historyDiff').length }
})()`)
record('the inline diff can be closed', closed.historyDiff === 0, JSON.stringify(closed))

if (shotPath !== undefined) {
  await ev(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const row = document.querySelector('.gwc-commitDetail .gwc-changeRow')
    if (row) row.click()
    await sleep(3000)
    return true
  })()`)
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))
  console.log('  screenshot: ' + shotPath)
}

await send('Browser.close').catch(() => { })
child.kill('SIGKILL')
await sleep(400)
try { rmSync(dir, { recursive: true, force: true }) } catch { }

const failed = results.filter((r) => !r.ok)
console.log('')
console.log(`history-inline: ${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
