/**
 * Interaction regression for the dock.
 *
 * Reported bug: "工作台中点击 downloader 会关闭工作台".
 *
 * Cause: the row hit-test walked up to an ancestor that contains the entry, and
 * `document.body` contains it for EVERY click — so clicking the dock's own tabs
 * (or any sidebar row) toggled the dock shut.
 *
 * This walks the whole interaction chain with REAL mouse events and requires the
 * dock to survive everything except an explicit toggle.
 *
 * Usage: node tests/interaction.e2e.mjs <base-url> <browser-exe>
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const [baseUrl, browser] = process.argv.slice(2)
if (baseUrl === undefined || browser === undefined) {
  console.error('usage: node tests/interaction.e2e.mjs <base-url> <browser-exe>')
  process.exit(2)
}

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok })
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || detail === undefined ? '' : ' — ' + detail))
}

const port = 9990 + Math.floor(Math.random() * 30)
const dir = mkdtempSync(path.join(tmpdir(), 'interact-'))
const child = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, '--window-size=1700,950', 'about:blank'], { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

for (let i = 0; i < 90; i += 1) { try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) break } catch { /* not up */ } await sleep(300) }
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r))
let nextId = 1
const pending = new Map()
const events = []
ws.addEventListener('message', (e) => {
  const p = JSON.parse(e.data)
  if (p.id !== undefined && pending.has(p.id)) {
    const { resolve, reject } = pending.get(p.id)
    pending.delete(p.id)
    p.error ? reject(new Error(p.error.message)) : resolve(p.result)
    return
  }
  events.push(p)
})
const send = (m, p) => { const i = nextId++; return new Promise((res, rej) => { pending.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })) }) }
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true })
  if (r.exceptionDetails !== undefined) return { __error: String(r.exceptionDetails.exception?.description ?? '') .slice(0, 400) }
  return r.result.value
}

const clickAt = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await sleep(1500)
}

const state = () => evaluate(`(() => {
  const dock = document.querySelector('.wbd-docked')
  return {
    open: dock !== null || document.querySelector('.wbd-overlay') !== null,
    tabs: dock === null ? [] : Array.from(dock.querySelectorAll('.wbd-tab')).map((t) => (t.innerText || '').trim()),
    active: dock === null ? null : (dock.querySelector('.wbd-tab.is-active') || {}).innerText ?? null,
    pages: window.__DSH_WORKBAY__?.list?.().map((p) => p.id) ?? null,
  }
})()`)

const rectOf = (selector) => evaluate(`(() => {
  const el = document.querySelector(${JSON.stringify(selector)})
  if (el === null) return null
  const r = el.getBoundingClientRect()
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
})()`)

await send('Page.enable')
await send('Runtime.enable')
await send('Page.navigate', { url: baseUrl })
await sleep(22000)
await evaluate(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>(x.innerText||'').trim()==='继续'); if(b)b.click(); return !!b})()`)
await sleep(2000)

/* ---- open via the row (label area) ---- */
const rowPoint = await evaluate(`(() => {
  const el = document.querySelector('.wbd-entryBtn')
  if (el === null) return null
  let row = el.parentElement
  while (row !== null && row.getBoundingClientRect().width < 120) row = row.parentElement
  if (row === null) return null
  const r = row.getBoundingClientRect()
  return { x: Math.round(r.x + r.width * 0.8), y: Math.round(r.y + r.height / 2) }
})()`)
if (rowPoint !== null) await clickAt(rowPoint.x, rowPoint.y)
let s = await state()
record('the dock opens from the sidebar row', s.open === true, JSON.stringify(s).slice(0, 200))
const pageCount = Array.isArray(s.pages) ? s.pages.length : 0
/* The strip lists EVERY registered page, so tabs and pages have equal length. */
record('it carries the registered pages',
  Array.isArray(s.tabs) && s.tabs.length === pageCount,
  JSON.stringify({ pages: s.pages, tabs: s.tabs }))
if (pageCount < 2) console.log('  note  only one page registered — the tab-switch checks below need two')

/* ---- THE REPORTED BUG: clicking the other tab must not close it ---- */
const downloaderTab = await evaluate(`(() => {
  const tab = Array.from(document.querySelectorAll('.wbd-tab')).find((t) => /Downloader/i.test(t.innerText || ''))
  if (tab === undefined) return null
  const r = tab.getBoundingClientRect()
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
})()`)
if (downloaderTab !== null) await clickAt(downloaderTab.x, downloaderTab.y)
s = await state()
record('clicking the Downloader tab does NOT close the dock', s.open === true, JSON.stringify(s).slice(0, 240))
record('and it actually switches the page', /Downloader/i.test(String(s.active)), String(s.active))

/* ---- clicking back to GitCraft keeps it open ---- */
const gitcraftTab = await evaluate(`(() => {
  const tab = Array.from(document.querySelectorAll('.wbd-tab')).find((t) => /GitCraft/i.test(t.innerText || ''))
  if (tab === undefined) return null
  const r = tab.getBoundingClientRect()
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
})()`)
if (gitcraftTab !== null) await clickAt(gitcraftTab.x, gitcraftTab.y)
s = await state()
record('switching back to GitCraft keeps the dock open', s.open === true && /GitCraft/i.test(String(s.active)), JSON.stringify({ open: s.open, active: s.active }))

/* ---- clicking INSIDE the panel body must not close it either ---- */
const insidePanel = await evaluate(`(() => {
  const dock = document.querySelector('.wbd-docked')
  if (dock === null) return null
  const r = dock.getBoundingClientRect()
  /* empty area of the panel body, away from controls */
  return { x: Math.round(r.x + r.width * 0.5), y: Math.round(r.y + r.height * 0.6) }
})()`)
if (insidePanel !== null) await clickAt(insidePanel.x, insidePanel.y)
s = await state()
record('clicking inside the panel body does NOT close the dock', s.open === true, JSON.stringify({ open: s.open }))

/* ---- clicking an unrelated sidebar row must not toggle it ---- */
const otherRow = await evaluate(`(() => {
  const rows = Array.from(document.querySelectorAll('button, [role="button"], a, li'))
  const target = rows.find((el) => /^(插件|Plugins)$/i.test((el.innerText || '').trim()))
  if (target === undefined) return null
  const r = target.getBoundingClientRect()
  if (r.width === 0) return null
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
})()`)
if (otherRow !== null) {
  await clickAt(otherRow.x, otherRow.y)
  s = await state()
  record('clicking another sidebar row does NOT toggle the dock', s.open === true, JSON.stringify({ open: s.open }))
  /* return to the conversation */
  await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT)
    let row = null
    while (walker.nextNode()) {
      const node = walker.currentNode
      const own = Array.from(node.childNodes).filter((c) => c.nodeType === 3).map((c) => (c.textContent || '').trim()).join('')
      if (own.length > 0 && own.length < 12 && /^\\d+\\s*(分钟|小时|天)$/.test(own)) {
        row = node.closest('button, [role="button"], a, li') || node.parentElement
        if (row !== null) break
      }
    }
    if (row !== null) row.click()
    await sleep(3000)
    return true
  })()`)
  s = await state()
  record('the dock survives a navigation', s.open === true, JSON.stringify({ open: s.open }))
}

/* ---- an explicit toggle still closes it ---- */
const entryAgain = await evaluate(`(() => {
  const el = document.querySelector('.wbd-entryBtn')
  if (el === null) return null
  const r = el.getBoundingClientRect()
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
})()`)
if (entryAgain !== null) await clickAt(entryAgain.x, entryAgain.y)
s = await state()
record('clicking the entry again closes it', s.open === false, JSON.stringify({ open: s.open }))

const errors = events.filter((e) => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error'
  && (e.params.args || []).some((a) => /workbench|gitcraft|dock/i.test(String(a.value ?? a.description ?? ''))))
record('no plugin console error during the walk', errors.length === 0,
  errors.slice(0, 2).map((e) => (e.params.args || []).map((a) => String(a.value ?? '')).join(' ').slice(0, 200)).join(' | '))

await send('Browser.close').catch(() => { })
child.kill('SIGKILL')
await sleep(400)
try { rmSync(dir, { recursive: true, force: true }) } catch { }

const failed = results.filter((r) => !r.ok)
console.log('')
console.log(`interaction: ${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
