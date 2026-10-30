/**
 * Regression: the whole row must be clickable, not only the ~28px icon.
 *
 * Reported by the user: "要点击图片红色的区域才出来，点击的范围太小了" — only the
 * icon opened the dock; clicking the row's label did nothing.
 *
 * This clicks the LABEL area (the right-hand part of the row) with real mouse
 * events and requires the dock to open.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const [baseUrl, browser] = process.argv.slice(2)
const out = []
const record = (name, ok, detail) => {
  out.push({ name, ok })
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || detail === undefined ? '' : ' — ' + detail))
}

const dir = mkdtempSync(path.join(tmpdir(), 'rowclick-'))
const child = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=9985', `--user-data-dir=${dir}`, '--window-size=1700,950', 'about:blank'], { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
for (let i = 0; i < 90; i++) { try { const r = await fetch('http://127.0.0.1:9985/json/version'); if (r.ok) break } catch { } await sleep(300) }
const list = await (await fetch('http://127.0.0.1:9985/json/list')).json()
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r))
let id = 1
const pending = new Map()
ws.addEventListener('message', (e) => {
  const p = JSON.parse(e.data)
  if (p.id && pending.has(p.id)) {
    const { resolve, reject } = pending.get(p.id)
    pending.delete(p.id)
    p.error ? reject(new Error(p.error.message)) : resolve(p.result)
  }
})
const send = (m, p) => { const i = id++; return new Promise((res, rej) => { pending.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })) }) }
const evaluate = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true }); if (r.exceptionDetails) return { __error: String(r.exceptionDetails.exception?.description || '').slice(0, 400) }; return r.result.value }

await send('Page.enable')
await send('Runtime.enable')
await send('Page.navigate', { url: baseUrl })
await sleep(22000)
await evaluate(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>(x.innerText||'').trim()==='继续'); if(b)b.click(); return !!b})()`)
await sleep(2000)

/* Locate the row that contains both the entry and the label, then pick a point
   over the LABEL — far to the right of the icon. */
const target = await evaluate(`(() => {
  const el = document.querySelector('.wbd-entryBtn')
  if (el === null) return { error: 'no entry' }
  const entryRect = el.getBoundingClientRect()
  /* Walk up until the ancestor's text includes the label and it is wide. */
  let row = el.parentElement
  while (row !== null && row.getBoundingClientRect().width < 120) row = row.parentElement
  if (row === null) return { error: 'no wide row' }
  const r = row.getBoundingClientRect()
  return {
    rowText: (row.innerText || '').trim(),
    rowWidth: Math.round(r.width),
    iconRight: Math.round(entryRect.right),
    /* 80% across the row: squarely over the text, nowhere near the icon. */
    labelPoint: { x: Math.round(r.x + r.width * 0.8), y: Math.round(r.y + r.height / 2) },
  }
})()`)
console.log('ROW:', JSON.stringify(target))
record('the row is wide enough to have a label area', typeof target.rowWidth === 'number' && target.rowWidth >= 120, JSON.stringify(target).slice(0, 200))

if (target.labelPoint) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.labelPoint.x, y: target.labelPoint.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.labelPoint.x, y: target.labelPoint.y, button: 'left', clickCount: 1 })
  await sleep(4000)
}

const after = await evaluate(`(() => ({
  docked: document.querySelectorAll('.wbd-docked').length,
  overlay: document.querySelectorAll('.wbd-overlay').length,
  hasGitCraft: (document.querySelector('.wbd-docked') || { innerHTML: '' }).innerHTML?.includes('gwc-root') ?? false,
  pad: getComputedStyle(document.body).paddingRight,
}))()`)
console.log('AFTER CLICK ON LABEL:', JSON.stringify(after))
record('clicking the row LABEL opens the dock', (after.docked === 1 || after.overlay === 1) && after.hasGitCraft === true, JSON.stringify(after))

await send('Browser.close').catch(() => { })
child.kill('SIGKILL')
await sleep(400)
try { rmSync(dir, { recursive: true, force: true }) } catch { }

const failed = out.filter((x) => !x.ok)
console.log('')
console.log(`row-click: ${out.length - failed.length}/${out.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
