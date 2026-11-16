/**
 * Branches view e2e: the SourceTree-gap features landed there.
 *
 *   - name filter
 *   - folder grouping (two `feature/*` branches collapse into one `feature/` row)
 *   - per-row subject + relative time
 *   - per-branch "more" menu (rename / upstream / push)
 *   - merge strategy menu (default / --no-ff / squash)
 *
 * Runs against the real shell harness (real dock + real page + a real repo).
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startRealHarness } from './real-harness.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const outDir = process.env.WBM_BRANCHES_OUT ?? path.join(tmpdir(), 'wbm-branches-' + process.pid)

let failures = 0
const check = (name, ok, detail) => {
  if (ok !== true) failures += 1
  console.log((ok === true ? 'ok   ' : 'FAIL ') + name + (detail === undefined ? '' : '  [' + detail + ']'))
}

const h = await startRealHarness({ windowSize: '1100,900', dockWidth: 900, layout: 'auto', dockOpen: true })
const { ev, send, close, sleep } = h

const waitFor = async (selector, timeoutMs) => {
  const deadline = Date.now() + (timeoutMs === undefined ? 8000 : timeoutMs)
  while (Date.now() < deadline) {
    const hit = await ev('document.querySelector(' + JSON.stringify(selector) + ') !== null')
    if (hit === true) return true
    await sleep(120)
  }
  return false
}

const clickText = (selector, text) => ev(`(function(){
  var nodes = Array.prototype.slice.call(document.querySelectorAll(${JSON.stringify(selector)}))
  var hit = nodes.filter(function (n) { return (n.textContent || '').indexOf(${JSON.stringify(text)}) >= 0 })[0]
  if (!hit) return 'missing'
  hit.click()
  return 'clicked'
})()`)

const snapshot = async () => JSON.parse(await ev(`(function(){
  var rows = Array.prototype.slice.call(document.querySelectorAll('.wbd-docked .scw-branchRow'))
  return JSON.stringify({
    filter: document.querySelector('.wbd-docked .scw-branchFilter') !== null,
    folders: Array.prototype.map.call(document.querySelectorAll('.wbd-docked .scw-branchFolder'), function (n) { return (n.textContent || '').trim() }),
    rows: rows.map(function (n) { return (n.textContent || '').trim() }),
    subjects: document.querySelectorAll('.wbd-docked .scw-branchSubject').length,
    times: document.querySelectorAll('.wbd-docked .scw-branchTime').length,
    dialog: document.querySelector('.wbd-docked .scw-dialog') !== null,
  })
})()`))

try {
  await clickText('.wbd-railItem, .wbd-tab', '源码')
  await waitFor('.wbd-docked .scw-mode', 10000)
  const mode = await clickText('.wbd-docked .scw-mode', '分支')
  await waitFor('.wbd-docked .scw-branchFilter', 10000)
  /* The list itself arrives from a ranches RPC (one git spawn); wait for ROWS,
     not just the toolbar. */
  await waitFor('.wbd-docked .scw-branchRow', 12000)
  check('branches view opens', mode === 'clicked', mode)

  const base = await snapshot()
  check('filter input exists', base.filter === true)

  const tagRow = JSON.parse(await ev(`(function(){
    var rows = Array.prototype.slice.call(document.querySelectorAll('.wbd-docked .scw-branchRow'))
    var tag = rows.filter(function (n) { return (n.textContent || '').indexOf('v1.0') >= 0 })[0]
    var toolbar = Array.prototype.map.call(document.querySelectorAll('.wbd-docked .scw-toolIcon'), function (n) { return n.getAttribute('title') || '' })
    return JSON.stringify({
      found: tag !== undefined,
      buttons: tag === undefined ? [] : Array.prototype.map.call(tag.querySelectorAll('.scw-rowBtn'), function (n) { return (n.textContent || '').trim() }),
      toolbar: toolbar,
    })
  })()`))
  check('tag row is listed', tagRow.found === true)
  check('tag row offers delete-local and delete-remote',
    tagRow.buttons.indexOf('删除') >= 0 && tagRow.buttons.indexOf('删除远程') >= 0,
    JSON.stringify(tagRow.buttons))
  check('branches toolbar has new-branch / tag and NOT duplicated fetch-pull',
    tagRow.toolbar.some((title) => title.indexOf('新建分支') >= 0)
      && tagRow.toolbar.some((title) => title.indexOf('标签') >= 0)
      && tagRow.toolbar.every((title) => title.indexOf('获取') < 0 && title.indexOf('拉取') < 0),
    JSON.stringify(tagRow.toolbar))
  check('feature/ branches fold into one folder row', base.folders.some((text) => text.indexOf('feature/') >= 0), JSON.stringify(base.folders))
  check('branch rows render', base.rows.length >= 3, 'rows=' + base.rows.length)
  check('rows show the last commit subject', base.subjects >= 3, 'subjects=' + base.subjects)
  check('rows show a relative time', base.times >= 3, 'times=' + base.times)

  /* collapse / expand the folder */
  const beforeCollapse = base.rows.length
  await clickText('.wbd-docked .scw-branchFolder', 'feature/')
  await sleep(400)
  const collapsed = await snapshot()
  /* The folder holds every branch sharing the prefix (the harness repo's own
     working branch is feature/realshell too), so assert a drop, not a fixed count. */
  check('folder can be collapsed', collapsed.rows.length < beforeCollapse, beforeCollapse + ' -> ' + collapsed.rows.length)
  await clickText('.wbd-docked .scw-branchFolder', 'feature/')
  await sleep(400)
  const expanded = await snapshot()
  check('folder can be expanded again', expanded.rows.length === beforeCollapse, expanded.rows.length + ' vs ' + beforeCollapse)

  /* filter by name */
  await ev(`(function(){
    var input = document.querySelector('.wbd-docked .scw-branchFilter')
    if (input === null) return 'missing'
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, 'alpha')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return 'typed'
  })()`)
  await sleep(500)
  const filtered = await snapshot()
  check('name filter narrows the list', filtered.rows.length < base.rows.length && filtered.rows.some((text) => text.indexOf('alpha') >= 0), 'rows=' + filtered.rows.length)

  /* clear the filter */
  await ev(`(function(){
    var input = document.querySelector('.wbd-docked .scw-branchFilter')
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, '')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return 'cleared'
  })()`)
  await sleep(400)

  /* the "more" menu on a non-current local branch */
  const opened = await ev(`(function(){
    var rows = Array.prototype.slice.call(document.querySelectorAll('.wbd-docked .scw-branchRow'))
    for (var i = 0; i < rows.length; i += 1) {
      if (rows[i].className.indexOf('is-head') >= 0) continue
      var btn = rows[i].querySelector('.scw-rowBtn')
      var more = Array.prototype.filter.call(rows[i].querySelectorAll('.scw-rowBtn'), function (b) { return (b.textContent || '').trim() === '⋯' })[0]
      if (more) { more.click(); return 'clicked' }
    }
    return 'no-more-button'
  })()`)
  await sleep(500)
  const menu = await snapshot()
  const menuText = await ev(`(function(){
    var dialog = document.querySelector('.wbd-docked .scw-dialog')
    return dialog === null ? '' : (dialog.textContent || '')
  })()`)
  check('branch more-menu opens', opened === 'clicked' && menu.dialog === true, opened)
  check('more-menu offers rename / upstream / push',
    menuText.indexOf('重命名') >= 0 && menuText.indexOf('设置上游') >= 0 && menuText.indexOf('推送分支') >= 0,
    String(menuText).slice(0, 60))
  await ev(`(function(){ document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 'esc' })()`)
  await sleep(400)

  /* merge strategy menu */
  const mergeOpened = await ev(`(function(){
    var rows = Array.prototype.slice.call(document.querySelectorAll('.wbd-docked .scw-branchRow'))
    for (var i = 0; i < rows.length; i += 1) {
      if (rows[i].className.indexOf('is-head') >= 0) continue
      var merge = Array.prototype.filter.call(rows[i].querySelectorAll('.scw-rowBtn'), function (b) { return (b.textContent || '').trim() === '合并' })[0]
      if (merge) { merge.click(); return 'clicked' }
    }
    return 'no-merge-button'
  })()`)
  await sleep(500)
  const mergeText = await ev(`(function(){
    var dialog = document.querySelector('.wbd-docked .scw-dialog')
    return dialog === null ? '' : (dialog.textContent || '')
  })()`)
  check('merge menu opens with strategies',
    mergeOpened === 'clicked' && mergeText.indexOf('--no-ff') >= 0 && mergeText.indexOf('squash') >= 0,
    String(mergeText).slice(0, 60))

  const shot = await send('Page.captureScreenshot', { format: 'png' })
  if (shot.result && shot.result.data) {
    mkdirSync(outDir, { recursive: true })
    writeFileSync(path.join(outDir, 'branches.png'), Buffer.from(shot.result.data, 'base64'))
  }
} finally {
  await close()
}

console.log(failures === 0 ? 'PASS — branches view matches the SourceTree gap list' : 'FAILURES: ' + failures)
process.exit(failures === 0 ? 0 : 1)
