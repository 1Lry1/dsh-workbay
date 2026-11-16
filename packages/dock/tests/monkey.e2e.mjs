/**
 * Monkey / random-interaction test for the workbench.
 *
 * Drives the REAL dock shell + REAL pages (see real-harness.mjs) with random
 * clicks, wheel scrolls, drags, tab/layout switches and key presses, then audits
 * ten invariants that together mean "the screen is still sane".
 *
 * Safety: a deny-list skips anything destructive (burn / erase / commit / discard
 * / delete / stop). Everything else is fair game.
 *
 * Usage: node _design-mockups/monkey.mjs [rounds] [seed]
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startRealHarness } from './real-harness.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
/* 失败截图与报告写到临时目录，别弄脏仓库。 */
const outDir = process.env.WBM_MONKEY_OUT ?? path.join(tmpdir(), 'wbm-monkey-' + process.pid)
const rounds = Number(process.argv[2] ?? 500)
const seed = Number(process.argv[3] ?? Date.now() % 100000)

const harness = await startRealHarness({ windowSize: '1400,900', dockWidth: 1000, layout: 'auto' })
const { ev, send, close, sleep } = harness

/* ---- page-side monkey: action pool + audit ---- */
const install = `
window.__INPUT_MODE__ = 'none'
document.addEventListener('keydown', function () { window.__INPUT_MODE__ = 'key' }, true)
document.addEventListener('pointerdown', function () { window.__INPUT_MODE__ = 'mouse' }, true)
window.__MONKEY__ = (function () {
  var state = { rng: 1 }
  function seedRng(s) { state.rng = s >>> 0 }
  function rnd() { state.rng = (state.rng * 1664525 + 1013904223) >>> 0; return state.rng / 4294967296 }
  function pick(list) { return list.length === 0 ? null : list[Math.floor(rnd() * list.length)] }
  var DENY = ['烧录', '擦除', '提交', '丢弃', '删除', '停止', '断开', '暂存', '撤销', '关闭', '重启', '新建终端', '全部', '收起', '停靠']
  function denied(el) {
    var text = (el.textContent || '') + ' ' + (el.getAttribute && (el.getAttribute('title') || el.getAttribute('aria-label') || '') || '')
    for (var i = 0; i < DENY.length; i += 1) if (text.indexOf(DENY[i]) >= 0) return true
    return false
  }
  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false
    var r = el.getBoundingClientRect()
    if (r.width < 4 || r.height < 4) return false
    var s = getComputedStyle(el)
    if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) return false
    return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth
  }
  function all(selector) { return Array.prototype.slice.call(document.querySelectorAll(selector)) }
  function clickablePool() {
    var nodes = all('.wbd-docked button, .wbd-docked [role=tab], .wbd-docked .scw-row, .wbd-docked .wbd-railItem, .wbd-docked input[type=checkbox]')
    return nodes.filter(function (el) {
      if (!visible(el) || denied(el) || el.disabled === true) return false
      /* 外壳的收/关按钮在测试环境里无法重新打开面板（没有侧栏入口），
         排除它们，否则一次随机点击就把整个被测对象关掉。 */
      if (el.closest && el.closest('.wbd-titleActions')) return false
      return true
    })
  }
  function scrollPool() {
    return all('.wbd-docked .scw-tree, .wbd-docked .abw-log, .wbd-docked .xterm-viewport, .wbd-docked .scw-content, .wbd-docked .dswt-body')
      .filter(function (el) { return visible(el) && el.scrollHeight > el.clientHeight + 8 })
  }
  function doClick() {
    var el = pick(clickablePool())
    if (el === null) return 'click:none'
    try { el.click() } catch (e) { return 'click:throw:' + e.message }
    return 'click:' + (el.className || el.tagName)
  }
  function doScroll() {
    var el = pick(scrollPool())
    if (el === null) return 'scroll:none'
    var before = el.scrollTop
    el.scrollTop = Math.floor(rnd() * Math.max(1, el.scrollHeight - el.clientHeight))
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: (rnd() < 0.5 ? -1 : 1) * Math.floor(rnd() * 800), bubbles: true, cancelable: true }))
    return 'scroll:' + (el.className || 'el') + ':' + (before !== el.scrollTop ? 'moved' : 'stuck')
  }
  function doDrag() {
    var grip = all('.wbd-docked .scw-grip, .wbd-docked .wbd-dockGrip').filter(visible)[0]
    if (!grip) return 'drag:none'
    var r = grip.getBoundingClientRect()
    var x = r.left + r.width / 2
    var y = r.top + r.height / 2
    function pointer(type, px) {
      grip.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: px, clientY: y, pointerId: 1, pointerType: 'mouse', buttons: 1 }))
    }
    pointer('pointerdown', x)
    document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x + (rnd() < 0.5 ? -80 : 80), clientY: y, pointerId: 1, pointerType: 'mouse', buttons: 1 }))
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', buttons: 0 }))
    return 'drag:grip'
  }
  function doLayout() {
    var el = pick(all('.wbd-docked .wbd-lsBtn').filter(visible))
    if (!el) return 'layout:none'
    el.click()
    return 'layout:' + el.textContent
  }
  function doTab() {
    var el = pick(all('.wbd-docked .wbd-tab, .wbd-docked .wbd-railItem').filter(function (el) { return visible(el) }))
    if (!el) return 'tab:none'
    el.click()
    return 'tab:' + el.textContent
  }
  function doKey() {
    var keys = ['Escape', 'Tab', 'ArrowRight', 'ArrowLeft', 'Enter', ' ']
    var key = keys[Math.floor(rnd() * keys.length)]
    var target = document.activeElement || document.body
    target.dispatchEvent(new KeyboardEvent('keydown', { key: key, bubbles: true, cancelable: true }))
    return 'key:' + key
  }
  function step() {
    var roll = rnd()
    if (roll < 0.38) return doClick()
    if (roll < 0.62) return doScroll()
    if (roll < 0.72) return doDrag()
    if (roll < 0.82) return doLayout()
    if (roll < 0.92) return doTab()
    return doKey()
  }

  function clipped(selector) {
    var out = []
    all(selector).forEach(function (el) {
      if (!visible(el)) return
      if (el.scrollWidth > el.clientWidth + 2 && !el.getAttribute('title')) out.push(el.className + ':' + (el.textContent || '').slice(0, 18))
    })
    return out
  }
  function occluded() {
    var out = []
    var pool = clickablePool().slice(0, 40)
    for (var i = 0; i < pool.length && out.length < 3; i += 1) {
      var el = pool[i]
      var r = el.getBoundingClientRect()
      var x = r.left + r.width / 2
      var y = r.top + r.height / 2
      /* 列表里滚出视口的行属于正常现象，不是遮挡：只检查中心落在视口内的控件。 */
      if (x < 2 || y < 2 || x > innerWidth - 2 || y > innerHeight - 2) continue
      var hit = document.elementFromPoint(x, y)
      if (hit === null) { out.push('null:' + el.className); continue }
      if (hit === el || el.contains(hit) || hit.contains(el)) continue
      /* 抽屉 / 弹窗是「有意的覆盖」，不算遮挡缺陷。任何 fixed 定位的浮层
         （backdrop / modal）都按此处理，否则会把正常弹窗误报成遮挡。 */
      var overlay = hit.closest ? hit.closest('.scw-content, .wbd-window, [role=dialog], [aria-modal=true], .scw-backdrop, .wbf-modalBackdrop') : null
      if (overlay !== null) continue
      var cs2 = getComputedStyle(hit)
      if (cs2.position === 'fixed' || cs2.position === 'absolute') continue
      if (/Backdrop|modal|overlay/i.test(String(hit.className || ''))) continue
      out.push('occluded:' + el.className + ' <- ' + (String(hit.className) || hit.tagName) + ' @ ' + JSON.stringify([Math.round(x), Math.round(y)]) + ' stack=' + document.elementsFromPoint(x, y).slice(0, 5).map(function (n) { return String(n.className) || n.tagName }).join('>'))
    }
    return out
  }
  function scrollStuck() {
    var stuck = []
    scrollPool().forEach(function (el) {
      var before = el.scrollTop
      el.scrollTop = before + 200
      if (el.scrollTop === before && el.scrollHeight > el.clientHeight + 8) stuck.push(el.className)
      el.scrollTop = before
    })
    return stuck
  }
  function audit() {
    var out = []
    function add(name, ok, detail) { out.push({ name: name, ok: ok === true, detail: detail === undefined ? '' : String(detail) }) }
    add('no-uncaught-errors', (window.__ERRORS__ || []).length === 0, (window.__ERRORS__ || []).slice(0, 2).join(' | '))
    add('no-error-boundary', document.body.innerText.indexOf('Page crashed') < 0, '')
    var root = document.documentElement
    add('no-horizontal-overflow', root.scrollWidth <= root.clientWidth + 2, root.scrollWidth + '/' + root.clientWidth)
    var clip = clipped('.wbd-tabLabel, .wbd-railLabel, .scw-rowName, .scw-tabLabel, .abw-btn, .dswt-tabLabel, .wbd-ctxName')
    add('labels-not-clipped', clip.length === 0, clip.slice(0, 3).join(' ; '))
    var occ = occluded()
    add('controls-not-occluded', occ.length === 0, occ.slice(0, 3).join(' ; '))
    var stuck = scrollStuck()
    add('scrollers-usable', stuck.length === 0, stuck.slice(0, 3).join(' ; '))
    var drawer = document.querySelector('.wbd-docked .scw-content[hidden]')
    var drawerVisible = drawer !== null && visible(drawer)
    add('drawer-not-stuck', drawerVisible !== true, drawerVisible ? 'hidden content is visible' : '')
    var screen = document.querySelector('.wbd-docked .xterm-screen')
    add('terminal-usable-width', screen === null || screen.getBoundingClientRect().width > 200, screen === null ? 'no-terminal' : Math.round(screen.getBoundingClientRect().width))
    var active = document.activeElement
    var focusOk = true
    var focusDetail = ''
    if (active && active !== document.body && active.nodeType === 1 && visible(active) && window.__INPUT_MODE__ === 'key') {
      var s = getComputedStyle(active)
      var ring = (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || (s.boxShadow && s.boxShadow !== 'none')
      if (!ring) { focusOk = false; focusDetail = 'no visible focus ring on ' + active.className }
    }
    add('focus-ring-visible', focusOk, focusDetail)
    var shell = document.querySelector('.wbd-docked')
    add('shell-present', shell !== null && shell.getBoundingClientRect().width > 400, shell === null ? 'missing' : Math.round(shell.getBoundingClientRect().width))
    var backdrop = document.querySelector('.wbf-modalBackdrop, .scw-backdrop')
    var escapable = backdrop === null || backdrop.querySelector('button') !== null
    add('modal-escapable', escapable, backdrop === null ? '' : 'backdrop without any button')
    return out
  }
  return { seed: seedRng, step: step, audit: audit }
})()
`

await ev(install)
await ev('window.__MONKEY__.seed(' + seed + ')')

/* Start on the source-control page so there is real content to poke. */
await ev(`(function(){
  var el = Array.prototype.slice.call(document.querySelectorAll('.wbd-railItem, .wbd-tab'))
    .filter(function (n) { return (n.textContent || '').indexOf('源码') >= 0 })[0]
  if (el) el.click()
  return el ? 'ok' : 'missing'
})()`)
await sleep(1500)

const failures = []
const actionCounts = {}
for (let round = 1; round <= rounds; round += 1) {
  let action = await ev('window.__MONKEY__.step()')
  if (round % 7 === 0) {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
    action = 'realTab'
  }
  const key = String(action).split(':')[0]
  actionCounts[key] = (actionCounts[key] || 0) + 1
  await sleep(120 + Math.floor(Math.random() * 180))
  /* Esc closes the panel BY DESIGN. That is not a failure — but it MUST reopen,
     otherwise the user is stranded with no workbench. Verify the round-trip. */
  const shellState = await ev(`(function(){
    if (document.querySelector('.wbd-docked') !== null) return 'present'
    try { window.__DSH_WORKBAY__.open() } catch (e) { return 'open-threw:' + e.message }
    return 'reopened'
  })()`)
  if (shellState === 'reopened') {
    actionCounts.reopen = (actionCounts.reopen || 0) + 1
    await sleep(450)
  }
  if (String(shellState).indexOf('open-threw') >= 0) {
    failures.push({ round, action, audit: [{ name: 'reopen', ok: false, detail: String(shellState) }] })
  }
  if (String(action).indexOf('throw') >= 0) failures.push({ round, action, audit: [{ name: 'action-threw', ok: false, detail: String(action) }] })
  if (round % 5 === 0 || round === rounds) {
    const auditRaw = await ev('JSON.stringify(window.__MONKEY__.audit())')
    let audit = []
    try { audit = JSON.parse(auditRaw) } catch { audit = [{ name: 'audit-parse', ok: false, detail: String(auditRaw) }] }
    const bad = audit.filter((entry) => entry.ok !== true)
    if (bad.length > 0) {
      failures.push({ round, action, audit: bad })
      const shot = await send('Page.captureScreenshot', { format: 'png' })
      if (shot.result && shot.result.data) {
        const dir = outDir
        mkdirSync(dir, { recursive: true })
        writeFileSync(path.join(dir, 'round-' + round + '.png'), Buffer.from(shot.result.data, 'base64'))
      }
      if (failures.length >= 25) break
    }
  }
}

const summary = {
  rounds,
  seed,
  actionCounts,
  failureRounds: failures.length,
  failures: failures.slice(0, 10),
}
console.log(JSON.stringify(summary, null, 2))
mkdirSync(outDir, { recursive: true })
writeFileSync(path.join(outDir, 'monkey-report.json'), JSON.stringify(summary, null, 2))
console.error('artifacts: ' + outDir)
await close()
process.exit(failures.length === 0 ? 0 : 1)
