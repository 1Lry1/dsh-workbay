/**
 * Prove the refresh is change-driven, not timed.
 *
 * Two things must hold:
 *   1. An IDLE repository produces no reload at all — no "正在读取差异…" flash, no
 *      snapshot churn — for well over the old 15s interval.
 *   2. Editing a file makes the panel pick it up within a couple of seconds,
 *      without any manual refresh.
 *
 * Usage: node tests/watch.e2e.mjs <base-url> <browser-exe> <repo-path>
 */
import { spawn } from 'node:child_process'
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const [baseUrl, browser, repoPath] = process.argv.slice(2)
if (baseUrl === undefined || browser === undefined || repoPath === undefined) {
  console.error('usage: node tests/watch.e2e.mjs <base-url> <browser-exe> <repo-path>')
  process.exit(2)
}

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok })
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || detail === undefined ? '' : ' — ' + detail))
}

const port = 10110 + Math.floor(Math.random() * 30)
const dir = mkdtempSync(path.join(tmpdir(), 'watch-'))
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
  await sleep(1000)
}

await send('Page.enable')
await send('Runtime.enable')
const preload = `(function(){
  var repo = ${JSON.stringify(repoPath)}
  try { window.localStorage.setItem('dsh-gitcraft.ref.v1', JSON.stringify({ path: repo })) } catch (e) {}
  var of = window.fetch
  window.fetch = function (u, i) {
    try {
      if (String(u).indexOf('dsh-gitcraft/api/') !== -1 && i && typeof i.body === 'string') {
        var b = JSON.parse(i.body)
        if (b.cwd === undefined) b.cwd = repo
        if (b.repoRoot === undefined) b.repoRoot = repo
        delete b.sessionId
        i = Object.assign({}, i, { body: JSON.stringify(b) })
      }
    } catch (e) {}
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

/* Wait for the list, click a file, then wait for its hunks: clicking before the
   row exists selects nothing, which is what made this test fail earlier. */
let rows = 0
for (let attempt = 0; attempt < 30; attempt += 1) {
  rows = await ev(`(() => document.querySelectorAll('.gwc-changeRow').length)()`)
  if (typeof rows === 'number' && rows > 0) break
  await sleep(600)
}
await ev(`(() => { const row = document.querySelector('.gwc-changeRow'); if (row) row.click(); return true })()`)

let hasDiff = false
for (let attempt = 0; attempt < 25; attempt += 1) {
  await sleep(600)
  hasDiff = await ev(`(() => document.querySelectorAll('.gwc-hunk').length > 0)()`)
  if (hasDiff === true) break
}
const ready = { rows, hasDiff }
record('the panel shows a repository with a rendered diff', ready.rows > 0 && ready.hasDiff === true, JSON.stringify(ready))

/* ---- 1) idle for well past the old 15s interval: no reload, no flash ---- */
const watchCalls = await ev(`(() => { window.__WATCH_CALLS__ = 0; const of = window.fetch; window.fetch = function (u, i) { try { if (String(u).indexOf('api/watch') !== -1) window.__WATCH_CALLS__ += 1 } catch (e) {} return of.apply(this, arguments) }; return true })()`)
const samples = []
for (let i = 0; i < 34; i += 1) {
  const text = await ev(`(() => { const d = document.querySelector('.gwc-diffScroll'); return d === null ? null : (d.innerText || '') })()`)
  samples.push(typeof text === 'string' ? text : '')
  await sleep(700)
}
const flashed = samples.filter((s) => /正在读取差异|Loading diff/.test(s)).length
const calls = await ev(`(() => window.__WATCH_CALLS__ || 0)()`)
record('an idle repository never flashes the diff loading state', flashed === 0, 'samples=' + samples.length + ' flashed=' + flashed)
record('it keeps long-polling instead of re-reading the diff', calls >= 1, 'watch calls=' + calls)

/* ---- 2) edit a changed file: the panel must pick it up by itself ---- */
const beforeText = await ev(`(() => { const d = document.querySelector('.gwc-diff'); return d === null ? '' : (d.innerText || '') })()`)
const changedFile = await ev(`(() => {
  const rows = Array.from(document.querySelectorAll('.gwc-changeRow'))
  if (rows.length === 0) return ''
  return (rows[0].innerText || '').trim()
})()`)
console.log('  first row:', JSON.stringify(String(changedFile).slice(0, 60)))

/* Append to the file whose diff is currently displayed: the panel must show the
   new line without any manual refresh. */
const diffPath = await ev(`(() => {
  const el = document.querySelector('.gwc-diffTitle')
  return el === null ? null : (el.getAttribute('title') || el.textContent || '').trim()
})()`)
console.log('  diff path:', JSON.stringify(String(diffPath).slice(0, 80)))

const targetFile = typeof diffPath === 'string' && diffPath !== '' ? diffPath : 'a.txt'
const absolute = path.isAbsolute(targetFile) ? targetFile : path.join(repoPath, targetFile)
const marker = 'watch-e2e-' + Date.now()
appendFileSync(absolute, '\n// ' + marker + '\n')

let picked = false
let waited = 0
while (waited < 15000 && picked === false) {
  await sleep(600)
  waited += 600
  const text = await ev(`(() => { const d = document.querySelector('.gwc-diff'); return d === null ? '' : (d.innerText || '') })()`)
    if (typeof text === 'string' && text.includes(marker)) picked = true
}
record('an actual file edit refreshes the panel automatically', picked === true, 'waited=' + waited + 'ms')

await send('Browser.close').catch(() => { })
child.kill('SIGKILL')
await sleep(400)
try { rmSync(dir, { recursive: true, force: true }) } catch { }

const failed = results.filter((r) => !r.ok)
console.log('')
console.log(`watch: ${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
