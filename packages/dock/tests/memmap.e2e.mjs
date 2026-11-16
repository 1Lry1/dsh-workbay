/**
 * Real-shell e2e for the 内存分析 (memmap) page.
 *
 * Boots the REAL dock + the REAL memmap page against a throwaway SDK tree and a
 * fake interpreter (the harness injects `node fake_memmap_runner.mjs`), so this
 * test is deterministic on a machine without Python. It covers the three states
 * a user meets: the auto-run result at T2, the same page at T4 (two columns), and
 * a workspace that has no memmap tool (empty state).
 *
 * Run: node packages/dock/tests/memmap.e2e.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { startRealHarness } from './real-harness.mjs'

const outDir = process.env.WBM_MEMMAP_OUT ?? path.join(tmpdir(), 'wbm-memmap-' + process.pid)
mkdirSync(outDir, { recursive: true })

let failures = 0
const check = (name, ok, detail) => {
  if (ok === true) {
    console.log('ok   ' + name + (detail === undefined ? '' : '  [' + detail + ']'))
    return
  }
  failures += 1
  console.log('FAIL ' + name + (detail === undefined ? '' : '  [' + detail + ']'))
}

const clickText = (ev, selector, text) => ev(`(function(){
  var nodes = Array.prototype.slice.call(document.querySelectorAll(${JSON.stringify(selector)}))
  var hit = nodes.filter(function (n) { return (n.textContent || '').indexOf(${JSON.stringify(text)}) >= 0 })[0]
  if (!hit) return 'missing'
  hit.click()
  return 'clicked'
})()`)

const makeWaitFor = (ev, sleep) => async (selector, timeoutMs) => {
  const deadline = Date.now() + (timeoutMs === undefined ? 15000 : timeoutMs)
  while (Date.now() < deadline) {
    const hit = await ev('document.querySelector(' + JSON.stringify(selector) + ') !== null')
    if (hit === true) return true
    await sleep(120)
  }
  return false
}

const openMemmap = async (ev, sleep) => {
  await clickText(ev, '.wbd-railItem, .wbd-tab', '内存')
  await sleep(400)
}

const screenshot = async (send, name) => {
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  if (shot.result && shot.result.data) writeFileSync(path.join(outDir, name), Buffer.from(shot.result.data, 'base64'))
}

async function caseResult() {
  const h = await startRealHarness({ windowSize: '1100,900', dockWidth: 900, layout: 'auto', dockOpen: true, memmap: true })
  const { ev, send, close, sleep } = h
  const waitFor = makeWaitFor(ev, sleep)
  try {
    await openMemmap(ev, sleep)
    const ready = await waitFor('.wbd-docked .mm-cards', 20000)
    check('the page auto-runs and shows the storage cards', ready === true)

    const state = JSON.parse(await ev(`(function(){
      var cards = Array.prototype.slice.call(document.querySelectorAll('.wbd-docked .mm-card'))
      var rows = Array.prototype.slice.call(document.querySelectorAll('.wbd-docked .mm-tr:not(.is-head)'))
      var history = Array.prototype.slice.call(document.querySelectorAll('.wbd-docked .mm-historyRow'))
      var stats = Array.prototype.map.call(document.querySelectorAll('.wbd-docked .mm-cardPct'), function (n) { return (n.textContent || '').trim() })
      var names = Array.prototype.map.call(document.querySelectorAll('.wbd-docked .mm-cardName'), function (n) { return (n.textContent || '').trim() })
      var regions = Array.prototype.map.call(document.querySelectorAll('.wbd-docked .mm-regionName'), function (n) { return (n.textContent || '').trim() })
      return JSON.stringify({
        cards: cards.length,
        names: names,
        stats: stats,
        regionRows: rows.length,
        regions: regions,
        history: history.length,
        hasReportButton: document.querySelectorAll('.wbd-docked .mm-btn.is-primary').length,
        hasPythonChip: (document.querySelector('.wbd-docked .mm-head') || {}).textContent || '',
        projectChip: document.querySelectorAll('.wbd-docked .mm-chip.is-proj').length,
        mapButtonText: ((document.querySelector('.wbd-docked .mm-mapName') || {}).textContent || '').trim(),
        errors: (window.__ERRORS__ || []).slice(0, 4),
      })
    })()`))
    check('three storage cards render with percentages', state.cards === 3 && state.stats.length === 3, JSON.stringify(state.stats))
    check('the three cards are internal RAM / PSRAM / Flash', state.names.join('|') === '内部 RAM|PSRAM|Flash', state.names.join('|'))
    check('region rows come from the report (sram/psram/flash)', state.regions.join(',') === 'sram,psram,flash', state.regions.join(','))
    check('the run is in the history list', state.history >= 1, 'history=' + state.history)
    check('the full-report button is offered', state.hasReportButton >= 1)
    check('python version is shown in the header', /3\.9\.10-fake/.test(state.hasPythonChip), state.hasPythonChip.slice(0, 40))
    check('the SDK copy of the tool is used when the workspace has one', state.hasPythonChip.indexOf('SDK 工具') >= 0, state.hasPythonChip.slice(0, 60))
    check('the header names the project being analysed', state.hasPythonChip.indexOf('工程 standard') >= 0 && state.projectChip === 1, state.hasPythonChip.slice(0, 70))
    check('the header names the current map file', state.mapButtonText === 'map.txt', state.mapButtonText)
    check('no page errors', state.errors.length === 0, JSON.stringify(state.errors))
    /* The map picker: every candidate is switchable, even with a single project. */
    const opened = await ev("(function(){var b=document.querySelector('.wbd-docked .mm-mapBtn'); if(!b) return 'missing'; b.click(); return 'clicked'})()")
    await waitFor('.wbd-docked .mm-picker', 8000)
    await screenshot(send, 'memmap-t2-picker-open.png')
    const picked = JSON.parse(await ev(`(function(){
      var choices = Array.prototype.slice.call(document.querySelectorAll('.wbd-docked .mm-choice'))
      var target = choices.filter(function (n) { return (n.textContent || '').indexOf('watch466') >= 0 })[0]
      var info = {
        count: choices.length,
        projects: choices.map(function (n) { var p = n.querySelector('.mm-choiceProject'); return (p && p.textContent || '').trim() }),
        currentMarked: document.querySelectorAll('.wbd-docked .mm-choice.is-current').length,
        hasManualBox: document.querySelectorAll('.wbd-docked .mm-picker .mm-input').length,
      }
      if (!target) { info.clicked = 'missing'; return JSON.stringify(info) }
      target.click()
      info.clicked = 'clicked'
      return JSON.stringify(info)
    })()`))
    check('the map picker opens from the header and lists every candidate', opened === 'clicked' && picked.count >= 2 && picked.projects.indexOf('standard') >= 0 && picked.projects.indexOf('watch466') >= 0, JSON.stringify(picked.projects))
    check('the picker marks the current map and offers the manual path box', picked.currentMarked === 1 && picked.hasManualBox === 1, JSON.stringify({ current: picked.currentMarked, manual: picked.hasManualBox }))
    await ev('new Promise(function (resolve) { setTimeout(resolve, 600) })')
    const switched = JSON.parse(await ev(`(function(){
      return JSON.stringify({
        head: (document.querySelector('.wbd-docked .mm-head') || {}).textContent || '',
        picker: document.querySelectorAll('.wbd-docked .mm-picker').length,
        runButton: document.querySelectorAll('.wbd-docked .mm-btn.is-primary').length,
        errors: (window.__ERRORS__ || []).slice(0, 3),
      })
    })()`))
    check('picking another project runs that map and closes the picker', picked.clicked === 'clicked' && switched.head.indexOf('工程 watch466') >= 0 && switched.picker === 0, switched.head.slice(0, 80))
    check('no page errors after switching maps', switched.errors.length === 0, JSON.stringify(switched.errors))
    await screenshot(send, 'memmap-t2-picker.png')
    await screenshot(send, 'memmap-t2.png')

    /* Full report: blob iframe inside the page. */
    const clicked = await clickText(ev, '.wbd-docked .mm-btn.is-primary', '完整报告')
    await waitFor('.wbd-docked .mm-reportFrame', 15000)
    const reportState = JSON.parse(await ev(`(function(){
      var frame = document.querySelector('.wbd-docked .mm-reportFrame')
      return JSON.stringify({
        clicked: ${JSON.stringify(clicked)},
        present: frame !== null,
        src: frame === null ? '' : frame.getAttribute('src'),
        hasBackdrop: document.querySelectorAll('.wbd-docked .mm-report').length,
      })
    })()`))
    check('the full report opens in an embedded iframe', reportState.present === true && String(reportState.src).indexOf('blob:') === 0, String(reportState.src).slice(0, 20))
    await screenshot(send, 'memmap-t2-report.png')

    /* Esc closes the report, NOT the page. */
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
    await sleep(400)
    const afterEsc = JSON.parse(await ev(`(function(){
      return JSON.stringify({
        report: document.querySelectorAll('.wbd-docked .mm-reportFrame').length,
        page: document.querySelectorAll('.wbd-docked .mm-cards').length,
        shell: document.querySelectorAll('.wbd-docked .mm-root').length,
      })
    })()`))
    check('Esc closes the report but keeps the page', afterEsc.report === 0 && afterEsc.page === 1 && afterEsc.shell === 1, JSON.stringify(afterEsc))
  } finally {
    await close()
  }
}

async function caseWide() {
  const h = await startRealHarness({ windowSize: '1500,950', dockWidth: 1360, layout: 'auto', dockOpen: true, memmap: true })
  const { ev, send, close, sleep } = h
  const waitFor = makeWaitFor(ev, sleep)
  try {
    await openMemmap(ev, sleep)
    const ready = await waitFor('.wbd-docked .mm-cards', 20000)
    check('T4: the result renders after the auto run', ready === true)
    const layout = JSON.parse(await ev(`(function(){
      var body = document.querySelector('.wbd-docked .mm-body')
      var main = document.querySelector('.wbd-docked .mm-colMain')
      var side = document.querySelector('.wbd-docked .mm-colSide')
      return JSON.stringify({
        tier: (document.querySelector('.wbd-docked .wbd-root') || {}).getAttribute ? null : null,
        wide: body === null ? null : body.className,
        mainLeft: main === null ? 0 : Math.round(main.getBoundingClientRect().left),
        sideLeft: side === null ? 0 : Math.round(side.getBoundingClientRect().left),
        sameTop: main !== null && side !== null && Math.abs(main.getBoundingClientRect().top - side.getBoundingClientRect().top) < 4,
      })
    })()`))
    check('T4: the summary and the side column sit side by side', /is-wide/.test(String(layout.wide)) === true && layout.sideLeft > layout.mainLeft && layout.sameTop === true, JSON.stringify(layout))
    await screenshot(send, 'memmap-t4.png')
  } finally {
    await close()
  }
}

async function caseProject() {
  /* A standalone project: no tools/ dir, only Output/bin/map.txt. This is the case
     that used to say "没有内存分析工具" — the bundled script must handle it. */
  const h = await startRealHarness({ windowSize: '1100,900', dockWidth: 900, layout: 'auto', dockOpen: true, memmap: { project: true } })
  const { ev, send, close, sleep } = h
  const waitFor = makeWaitFor(ev, sleep)
  try {
    await openMemmap(ev, sleep)
    const ready = await waitFor('.wbd-docked .mm-cards', 20000)
    check('a project without its own tools/ is analysed by the bundled script', ready === true)
    const state = JSON.parse(await ev(`(function(){
      var head = (document.querySelector('.wbd-docked .mm-head') || {}).textContent || ''
      return JSON.stringify({
        cards: document.querySelectorAll('.wbd-docked .mm-card').length,
        regions: Array.prototype.map.call(document.querySelectorAll('.wbd-docked .mm-regionName'), function (n) { return (n.textContent || '').trim() }),
        head: head,
        errors: (window.__ERRORS__ || []).slice(0, 3),
      })
    })()`))
    check('the project page renders the same summary', state.cards === 3 && state.regions.length === 3, JSON.stringify(state.regions))
    check('the header says the tool is built in', state.head.indexOf('内置工具') >= 0, state.head.slice(0, 60))
    check('no page errors', state.errors.length === 0, JSON.stringify(state.errors))
    await screenshot(send, 'memmap-t2-project.png')
  } finally {
    await close()
  }
}

async function caseNearby() {
  /* No map in this workspace, but the SDK next door has one: the page must offer
     it as a clickable candidate and then analyse it (the real demo situation). */
  const h = await startRealHarness({ windowSize: '1100,900', dockWidth: 900, layout: 'auto', dockOpen: true, memmap: { empty: true, sibling: true } })
  const { ev, send, close, sleep } = h
  const waitFor = makeWaitFor(ev, sleep)
  try {
    await openMemmap(ev, sleep)
    const hasSuggestions = await waitFor('.wbd-docked .mm-suggestRow', 15000)
    const offered = await ev("JSON.stringify(Array.prototype.map.call(document.querySelectorAll('.wbd-docked .mm-suggestRow'), function (n) { return (n.textContent || '').trim() }))")
    check('a map found in the neighbouring SDK is offered as a candidate', hasSuggestions === true && offered.indexOf('standard') >= 0, offered)
    await screenshot(send, 'memmap-t2-nearby.png')
    await ev("(document.querySelector('.wbd-docked .mm-suggestRow') || { click: function () {} }).click()")
    const ready = await waitFor('.wbd-docked .mm-cards', 20000)
    const state = JSON.parse(await ev(`(function(){
      var head = (document.querySelector('.wbd-docked .mm-head') || {}).textContent || ''
      return JSON.stringify({
        cards: document.querySelectorAll('.wbd-docked .mm-card').length,
        regions: document.querySelectorAll('.wbd-docked .mm-regionName').length,
        head: head,
        errors: (window.__ERRORS__ || []).slice(0, 3),
      })
    })()`))
    check('clicking the candidate runs the analysis', ready === true && state.cards === 3 && state.regions === 3, JSON.stringify(state))
    check('the run uses the built-in tool', state.head.indexOf('内置工具') >= 0, state.head.slice(0, 60))
    check('no page errors', state.errors.length === 0, JSON.stringify(state.errors))
  } finally {
    await close()
  }
}

async function caseEmpty() {
  /* No map anywhere: the page must offer the manual absolute path box instead of
     telling the user the tool is missing (the tool ships with the plugin). */
  const h = await startRealHarness({ windowSize: '1100,900', dockWidth: 900, layout: 'auto', dockOpen: true, memmap: { empty: true } })
  const { ev, send, close, sleep } = h
  const waitFor = makeWaitFor(ev, sleep)
  try {
    await openMemmap(ev, sleep)
    const hasTitle = await waitFor('.wbd-docked .mm-emptyTitle', 15000)
    const state = JSON.parse(await ev(`(function(){
      return JSON.stringify({
        title: ((document.querySelector('.wbd-docked .mm-emptyTitle') || {}).textContent || '').trim(),
        hasInput: document.querySelectorAll('.wbd-docked .mm-input').length,
        hasRunButton: document.querySelectorAll('.wbd-docked .mm-btn.is-primary').length,
        hasBundledChip: ((document.querySelector('.wbd-docked .mm-head') || {}).textContent || '').indexOf('内置工具') >= 0,
      })
    })()`))
    check('a workspace without a map shows the build-output empty state', hasTitle === true && state.title.indexOf('没有构建产物') >= 0, state.title)
    check('the empty state offers a manual absolute map path', state.hasInput === 1 && state.hasRunButton >= 1, JSON.stringify({ input: state.hasInput, run: state.hasRunButton }))
    check('the bundled tool is still reported in the header', state.hasBundledChip === true)
    await screenshot(send, 'memmap-t2-empty.png')
  } finally {
    await close()
  }
}

try {
  await caseResult()
  await caseProject()
  await caseNearby()
  await caseWide()
  await caseEmpty()
} catch (error) {
  failures += 1
  console.log('FAIL harness crashed: ' + (error === null || error === undefined ? 'unknown' : error.message))
}

console.log('')
console.log(failures === 0 ? 'PASS — memmap page works end to end' : 'FAILURES: ' + failures)
console.log('artifacts: ' + outDir)
process.exit(failures === 0 ? 0 : 1)
