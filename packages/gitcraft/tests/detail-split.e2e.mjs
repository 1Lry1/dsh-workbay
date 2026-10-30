/**
 * The commit list / commit detail boundary is draggable.
 *
 * Requested: 提交详情能加拖拽拉伸.
 *
 * Fixture: a repository with several commits so the list has rows to shrink.
 *
 * Usage: node tests/detail-split.e2e.mjs <base-url> <browser-exe> <repo-path>
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const [baseUrl, browser, repoPath] = process.argv.slice(2)
if (baseUrl === undefined || browser === undefined || repoPath === undefined) {
  console.error('usage: node tests/detail-split.e2e.mjs <base-url> <browser-exe> <repo-path>')
  process.exit(2)
}

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok })
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || detail === undefined ? '' : ' — ' + detail))
}

const port = 10240 + Math.floor(Math.random() * 30)
const dir = mkdtempSync(path.join(tmpdir(), 'detailsplit-'))
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

const rowPoint = await ev(`(() => { const el=document.querySelector('.wbd-entryBtn'); if(!el) return null; let r=el.parentElement; while(r && r.getBoundingClientRect().width<120) r=r.parentElement; if(!r) return null; const b=r.getBoundingClientRect(); return {x:Math.round(b.x+b.width*0.8), y:Math.round(b.y+b.height/2)} })()`)
if (rowPoint !== null) await clickAt(rowPoint.x, rowPoint.y)
await sleep(2500)
for (let i = 0; i < 80; i += 1) {
  const ready = await ev(`(() => document.querySelectorAll('.gwc-changeRow').length > 0)()`)
  if (ready === true) break
  await sleep(600)
}

/* History → select a commit so the detail (and its splitter) appears */
await ev(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const tab = Array.from(document.querySelectorAll('.gwc-navBtn')).find((t) => /历史|History/.test(t.innerText || ''))
  if (tab) tab.click()
  await sleep(3500)
  return true
})()`)
for (let i = 0; i < 80; i += 1) {
  const rows = await ev(`(() => document.querySelectorAll('.gwc-commitRow').length)()`)
  if (typeof rows === 'number' && rows > 0) break
  await sleep(600)
}
await ev(`(() => { const row = document.querySelector('.gwc-commitRow'); if (row) row.click(); return true })()`)
for (let i = 0; i < 80; i += 1) {
  const has = await ev(`(() => document.querySelectorAll('.gwc-commitDetail .gwc-changeRow').length)()`)
  if (typeof has === 'number' && has > 0) break
  await sleep(600)
}

const before = await ev(`(() => {
  const bar = document.querySelector('.gwc-splitBar.is-detail')
  const list = document.querySelector('.gwc-historyList')
  const detail = document.querySelector('.gwc-commitDetail')
  if (bar === null || list === null || detail === null) return null
  const br = bar.getBoundingClientRect()
  return {
    list: Math.round(list.getBoundingClientRect().height),
    detail: Math.round(detail.getBoundingClientRect().height),
    bar: { x: Math.round(br.x + br.width / 2), y: Math.round(br.y + br.height / 2) },
  }
})()`)
console.log('BEFORE:', JSON.stringify(before))
record('a splitter sits between the commit list and the commit detail', before !== null, JSON.stringify(before))

if (before !== null) {
  /* drag DOWN: the list grows, the detail shrinks */
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: before.bar.x, y: before.bar.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: before.bar.x, y: before.bar.y + 110, button: 'left' })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: before.bar.x, y: before.bar.y + 110, button: 'left', clickCount: 1 })
  await sleep(1200)
  const after = await ev(`(() => {
    const list = document.querySelector('.gwc-historyList')
    const detail = document.querySelector('.gwc-commitDetail')
    return {
      list: list === null ? null : Math.round(list.getBoundingClientRect().height),
      detail: detail === null ? null : Math.round(detail.getBoundingClientRect().height),
      dockOpen: document.querySelectorAll('.wbd-docked').length === 1,
    }
  })()`)
  console.log('AFTER:', JSON.stringify(after))
  record('dragging enlarges the commit list and shrinks the commit detail',
    typeof after.list === 'number' && after.list > before.list + 40
      && typeof after.detail === 'number' && after.detail < before.detail - 40,
    JSON.stringify({ before, after }))
  record('dragging does not close the dock', after.dockOpen === true, JSON.stringify(after))

  /* the file list inside the detail must still hold its own scroll */
  const files = await ev(`(() => {
    const el = document.querySelector('.gwc-detailFiles')
    return el === null ? null : { scrollable: el.scrollHeight > el.clientHeight + 2, client: el.clientHeight }
  })()`)
  record('the 变更文件 list still owns its scroll after resizing', files === null || files.scrollable === true, JSON.stringify(files))
}

await send('Browser.close').catch(() => { })
child.kill('SIGKILL')
await sleep(400)
try { rmSync(dir, { recursive: true, force: true }) } catch { }

const failed = results.filter((r) => !r.ok)
console.log('')
console.log(`detail-split: ${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
