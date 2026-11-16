/**
 * Esc "go back one level" contract, driven through the real shell harness.
 *
 * The user asked for: Esc unwinds the page's own layers (dialog → modal → detail
 * → selection), and only when nothing is left does it close the workbench.
 *
 * This test presses REAL Escape keys through CDP (synthetic KeyboardEvents do not
 * trigger the shell's window listener the same way) and asserts the stack.
 */
import { startRealHarness } from './real-harness.mjs'

const harness = await startRealHarness({ windowSize: '1000,900', dockWidth: 700, layout: 'auto' })
const { ev, send, close, sleep } = harness

let failures = 0
const check = (name, ok, detail) => {
  if (ok !== true) failures += 1
  console.log((ok === true ? 'ok   ' : 'FAIL ') + name + (detail === undefined ? '' : '  [' + detail + ']'))
}

const waitFor = async (selector, timeoutMs) => {
  const deadline = Date.now() + (timeoutMs === undefined ? 10000 : timeoutMs)
  while (Date.now() < deadline) {
    const hit = await ev('document.querySelector(' + JSON.stringify(selector) + ') !== null')
    if (hit === true) return true
    await sleep(120)
  }
  return false
}

const ctrlE = async () => {
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'e', code: 'KeyE', modifiers: 2, windowsVirtualKeyCode: 69, nativeVirtualKeyCode: 69 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'e', code: 'KeyE', modifiers: 2, windowsVirtualKeyCode: 69, nativeVirtualKeyCode: 69 })
  await sleep(350)
}

const escape = async () => {
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
  await sleep(350)
}

const state = async () => {
  const raw = await ev(`(function(){
    var shell = document.querySelector('.wbd-docked')
    var content = document.querySelector('.scw-content')
    var drawerHidden = content === null ? null : content.hasAttribute('hidden')
    return JSON.stringify({
      shellOpen: shell !== null,
      drawerHidden: drawerHidden,
      selected: document.querySelectorAll('.scw-row.is-selected').length,
      detail: document.querySelectorAll('.scw-commitDetail').length,
    })
  })()`)
  return JSON.parse(raw)
}

try {
  /* Start on the source-control page (the shell opens on the first page). */
  await ev(`(function(){
    var el = Array.prototype.slice.call(document.querySelectorAll('.wbd-railItem, .wbd-tab'))
      .filter(function (n) { return (n.textContent || '').indexOf('源码') >= 0 })[0]
    if (el) el.click()
    return 'ok'
  })()`)
  await waitFor('.wbd-docked .scw-row', 12000)
  const before = await state()
  check('shell is open at start', before.shellOpen === true)

  /* ---- level 1: select a changed file → drawer opens ---- */
  const clickedFile = await ev(`(function(){
    var rows = document.querySelectorAll('.scw-row')
    if (rows.length === 0) return 'no-rows'
    rows[0].click()
    return 'clicked'
  })()`)
  await sleep(700)
  const selected = await state()
  check('selecting a file opens the drawer', clickedFile === 'clicked' && selected.drawerHidden === false, clickedFile)

  /* ---- Esc #1: closes the drawer, keeps the workbench ---- */
  await escape()
  const afterFirst = await state()
  check('Esc #1 closes the detail pane', afterFirst.drawerHidden === true || afterFirst.drawerHidden === null)
  check('Esc #1 keeps the workbench open', afterFirst.shellOpen === true)

  /* ---- Esc #2: nothing left → workbench closes ---- */
  await escape()
  const afterSecond = await state()
  check('Esc #2 closes the workbench', afterSecond.shellOpen === false)

  /* ---- Ctrl+E opens the panel, and closes it again from anywhere ---- */
  await ctrlE()
  const afterCtrlE = await state()
  check('Ctrl+E opens the workbench', afterCtrlE.shellOpen === true)
  await ctrlE()
  const afterCtrlEAgain = await state()
  check('Ctrl+E toggles it closed again', afterCtrlEAgain.shellOpen === false)

  /* ---- can be reopened (user must not be stranded) ---- */
  const reopened = await ev(`(function(){
    try { window.__DSH_WORKBAY__.open() } catch (e) { return 'throw:' + e.message }
    return 'ok'
  })()`)
  await sleep(500)
  const afterReopen = await state()
  check('workbench reopens after Esc closed it', reopened === 'ok' && afterReopen.shellOpen === true, String(reopened))

  /* ---- history: commit detail is a level of its own ---- */
  await ev(`(function(){
    var modes = Array.prototype.slice.call(document.querySelectorAll('.scw-mode'))
    var history = modes.filter(function (n) { return (n.textContent || '').indexOf('历史') >= 0 })[0]
    if (history) history.click()
    return history ? 'ok' : 'missing'
  })()`)
  await sleep(900)
  await ev(`(function(){
    var rows = document.querySelectorAll('.scw-commitRow')
    if (rows.length === 0) return 'none'
    rows[0].click()
    return 'clicked'
  })()`)
  await waitFor('.wbd-docked .scw-commitDetail', 25000)
  const detailOpen = await state()
  check('commit detail opens', detailOpen.detail > 0)

  await escape()
  const afterDetailEsc = await state()
  check('Esc closes commit detail but keeps shell', afterDetailEsc.detail === 0 && afterDetailEsc.shellOpen === true)

  await escape()
  const afterFinalEsc = await state()
  check('a further Esc closes the workbench', afterFinalEsc.shellOpen === false)
} finally {
  await close()
}

console.log(failures === 0 ? 'PASS — back stack behaves as specified' : 'FAILURES: ' + failures)
process.exit(failures === 0 ? 0 : 1)
