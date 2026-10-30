/**
 * Verify the Changes view scrolls its file list and its diff independently.
 *
 * The complaint: with a long change list, the diff was pushed below the fold, so
 * seeing a file's modification meant scrolling past every other file. After the
 * fix the diff must be visible as soon as a file is selected, with the list
 * scrolling in its own pane above it.
 *
 * Usage: node tests/diff-layout.e2e.mjs <base-url> <browser-exe> <repo-path> [shot.png]
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const [baseUrl, browser, repoPath, shotPath] = process.argv.slice(2)
if (baseUrl === undefined || browser === undefined || repoPath === undefined) {
  console.error('usage: node tests/diff-layout.e2e.mjs <base-url> <browser-exe> <repo-path> [shot.png]')
  process.exit(2)
}

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok })
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || detail === undefined ? '' : ' — ' + detail))
}

const port = 10020 + Math.floor(Math.random() * 30)
const dir = mkdtempSync(path.join(tmpdir(), 'dlayout-'))
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
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true })
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
/* Pin every gitcraft request to the fixture repository. */
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `(function(){var repo=${JSON.stringify(repoPath)};var of=window.fetch;window.fetch=function(u,i){try{if(String(u).indexOf('dsh-gitcraft/api/')!==-1&&i&&typeof i.body==='string'){var b=JSON.parse(i.body);b.cwd=repo;delete b.sessionId;b.repoRoot=repo;i=Object.assign({},i,{body:JSON.stringify(b)})}}catch(e){}return of.apply(this,arguments)}})()`,
})
await send('Page.navigate', { url: baseUrl })
await sleep(22000)
await evaluate(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>(x.innerText||'').trim()==='继续'); if(b)b.click(); return !!b})()`)
await sleep(1500)

/* open the dock from the sidebar row */
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

const opening = await evaluate(`(() => ({
  dock: document.querySelectorAll('.wbd-docked').length,
  root: document.querySelectorAll('.gwc-root').length,
  needsRepo: /选择|Pick/.test((document.querySelector('.gwc-root') || { innerText: '' }).innerText || '')
    && document.querySelectorAll('.gwc-changeRow').length === 0,
}))()`)
record('the dock and the git panel are open', opening.dock === 1 && opening.root === 1, JSON.stringify(opening))
record('with no repository it ASKS for one instead of spinning',
  opening.needsRepo === true, JSON.stringify(opening))

/* Pick the fixture repository through the panel's own picker. */
const picked = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const root = document.querySelector('.gwc-root')
  if (root === null) return { error: 'no panel' }
  const openBtn = Array.from(root.querySelectorAll('button'))
    .find((b) => /选择|Pick/i.test((b.innerText || '').trim()))
  if (openBtn === undefined) return { error: 'no pick button', text: (root.innerText || '').slice(0, 160) }
  openBtn.click()
  await sleep(2500)
  const chip = document.querySelector('.wbd-docked .gwc-repoChip')
  if (chip !== null) { chip.click(); await sleep(2000) }
  const input = document.querySelector('.gwc-lib-input')
  if (input === null) return { error: 'no path input', picker: document.querySelectorAll('.gwc-picker').length }
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, ${JSON.stringify(repoPath)})
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await sleep(4500)
  const verdict = document.querySelector('.gwc-lib-verdict')
  const addBtn = Array.from(document.querySelectorAll('.gwc-modalFoot button'))
    .find((b) => /添加|Add/i.test((b.innerText || '').trim()))
  if (addBtn === undefined) return { error: 'no add button' }
  addBtn.click()
  await sleep(5000)
  return {
    verdict: verdict === null ? '' : (verdict.innerText || '').trim(),
    rows: document.querySelectorAll('.gwc-changeRow').length,
  }
})()`)
console.log('PICK:', JSON.stringify(picked))
record('a repository picked by full path loads its changes',
  typeof picked.rows === 'number' && picked.rows >= 20, JSON.stringify(picked).slice(0, 240))

const beforeSelect = await evaluate(`(() => ({
  changeRows: document.querySelectorAll('.gwc-changeRow').length,
  listPane: document.querySelectorAll('.gwc-changeListPane').length,
  diffPane: document.querySelectorAll('.gwc-diffScroll').length,
  splitter: document.querySelectorAll('.gwc-splitBar').length,
}))()`)
record('the change list is long enough to overflow', beforeSelect.changeRows >= 20, 'rows=' + beforeSelect.changeRows)
record('no diff pane / splitter before a file is picked', beforeSelect.diffPane === 0 && beforeSelect.splitter === 0, JSON.stringify(beforeSelect))

/* pick the first changed file */
await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const row = document.querySelector('.gwc-changeRow')
  if (row !== null) row.click()
  await sleep(3500)
  return true
})()`)
const layout = await evaluate(`(() => {
  const list = document.querySelector('.gwc-changeListPane')
  const diff = document.querySelector('.gwc-diffScroll')
  const head = document.querySelector('.gwc-diffHead')
  const splitter = document.querySelector('.gwc-splitBar')
  if (list === null || diff === null) return { missing: true }
  const lr = list.getBoundingClientRect()
  const dr = diff.getBoundingClientRect()
  const hr = head === null ? null : head.getBoundingClientRect()
  return {
    listTop: Math.round(lr.top), listBottom: Math.round(lr.bottom),
    listScrollable: list.scrollHeight > list.clientHeight + 1,
    diffTop: Math.round(dr.top), diffBottom: Math.round(dr.bottom),
    diffScrollable: diff.scrollHeight > diff.clientHeight + 1,
    diffVisibleInViewport: dr.top >= 0 && dr.bottom <= window.innerHeight + 1 && dr.height > 40,
    headerVisible: hr !== null && hr.top >= dr.top - 1 && hr.bottom <= dr.bottom + 1,
    splitterBetween: splitter !== null && splitter.getBoundingClientRect().top >= lr.bottom - 1,
    hasHunk: document.querySelectorAll('.gwc-hunk').length > 0,
    viewport: window.innerHeight,
  }
})()`)
console.log('LAYOUT:', JSON.stringify(layout))

record('a file selection produces separate list and diff panes', layout.missing !== true, JSON.stringify(layout).slice(0, 200))
record('the diff is visible WITHOUT scrolling the list away',
  layout.diffVisibleInViewport === true, JSON.stringify({ diffTop: layout.diffTop, diffBottom: layout.diffBottom, viewport: layout.viewport }))
record('the diff actually renders hunks', layout.hasHunk === true, String(layout.hasHunk))
record('the diff header sits at the top of the diff pane', layout.headerVisible === true, JSON.stringify({ header: layout.headerVisible }))
record('the file list scrolls in its own pane', layout.listScrollable === true, JSON.stringify({ listScrollable: layout.listScrollable }))
record('a splitter separates the two panes', layout.splitterBetween === true, JSON.stringify({ splitterBetween: layout.splitterBetween }))

/* Before any manual split the panes must FIT their content — the reported
   "这一块留白" was the diff pane keeping leftover height under a short diff. */
const fit = await evaluate(`(() => {
  const diff = document.querySelector('.gwc-diffScroll')
  if (diff === null) return null
  const inner = diff.firstElementChild
  const dr = diff.getBoundingClientRect()
  const ir = inner === null ? null : inner.getBoundingClientRect()
  return {
    paneHeight: Math.round(dr.height),
    contentHeight: ir === null ? null : Math.round(ir.height),
    blank: ir === null ? null : Math.round(dr.bottom - ir.bottom),
    auto: diff.className.includes('is-auto'),
    wrapHeight: (document.querySelector('.gwc-changesWrap') || { getBoundingClientRect: () => ({ height: 0 }) }).getBoundingClientRect().height,
  }
})()`)
console.log('FIT:', JSON.stringify(fit))
/* The report was about a LARGE void (the pane used to take every remaining pixel,
   ~300px under a short diff). A little slack is normal for a split pane and the
   user can drag the splitter; assert the void is gone, not that it is 0. */
record('the diff pane no longer leaves a large blank block under a short diff',
  fit !== null && fit.auto === true && typeof fit.blank === 'number' && fit.blank <= 64,
  JSON.stringify(fit))
record('the diff pane never takes more than its 70% cap',
  fit !== null && fit.paneHeight !== null && fit.paneHeight <= Math.round(fit.wrapHeight * 0.72) + 2,
  JSON.stringify(fit))

/* drag the splitter up: the list gives space to the diff */
const splitPoint = await evaluate(`(() => {
  const s = document.querySelector('.gwc-splitBar')
  if (s === null) return null
  const r = s.getBoundingClientRect()
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
})()`)
const beforeDrag = await evaluate(`(() => {
  const list = document.querySelector('.gwc-changeListPane')
  return list === null ? null : Math.round(list.getBoundingClientRect().height)
})()`)
if (splitPoint !== null) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: splitPoint.x, y: splitPoint.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: splitPoint.x, y: splitPoint.y - 120, button: 'left' })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: splitPoint.x, y: splitPoint.y - 120, button: 'left', clickCount: 1 })
  await sleep(1200)
}
const afterDrag = await evaluate(`(() => {
  const list = document.querySelector('.gwc-changeListPane')
  const diff = document.querySelector('.gwc-diffScroll')
  return {
    list: list === null ? null : Math.round(list.getBoundingClientRect().height),
    diff: diff === null ? null : Math.round(diff.getBoundingClientRect().height),
    dockStillOpen: document.querySelectorAll('.wbd-docked').length === 1,
  }
})()`)
console.log('DRAG:', JSON.stringify({ beforeDrag, afterDrag }))
record('dragging the splitter resizes the panes',
  typeof afterDrag.list === 'number' && typeof beforeDrag === 'number' && afterDrag.list < beforeDrag - 30,
  JSON.stringify({ beforeDrag, afterDrag }))
record('dragging the splitter does not close the dock', afterDrag.dockStillOpen === true, String(afterDrag.dockStillOpen))

if (shotPath !== undefined) {
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
console.log(`diff-layout: ${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
