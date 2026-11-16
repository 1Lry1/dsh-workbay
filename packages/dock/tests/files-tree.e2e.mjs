/**
 * Probe: 文件 (files) tree behaviour in the real shell harness.
 *
 * Locks the two reported defects:
 *   1. clicking a directory expands/collapses it — it must NOT open the
 *      full-screen content pane;
 *   2. the "changes only" filter must not leave rows stuck on 「正在加载…」,
 *      and a directory it auto-expanded must be collapsible again.
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startRealHarness } from './real-harness.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const outDir = process.env.WBM_TREE_OUT ?? path.join(tmpdir(), 'wbm-tree-' + process.pid)
const h = await startRealHarness({ windowSize: '1000,900', dockWidth: 760, layout: 'auto' })
const { ev, send, close, sleep } = h

let failures = 0
const check = (name, ok, detail) => {
  if (ok !== true) failures += 1
  console.log((ok === true ? 'ok   ' : 'FAIL ') + name + (detail === undefined ? '' : '  [' + detail + ']'))
}

const snapshot = async () => JSON.parse(await ev(`(function(){
  var root = document.querySelector('.scw-root')
  var content = document.querySelector('.scw-content')
  var rows = Array.prototype.slice.call(document.querySelectorAll('.scw-row'))
  return JSON.stringify({
    mode: ((document.querySelector('.scw-mode.is-active') || {}).textContent) || '',
    drawerOpen: content !== null && !content.hasAttribute('hidden')
      && root !== null && root.className.indexOf('is-drawer') >= 0,
    rowCount: rows.length,
    dirs: rows.filter(function (n) { return n.className.indexOf('is-dir') >= 0 })
      .map(function (n) { return { rel: n.getAttribute('title') || '', dirty: n.querySelector('.scw-dirDot') !== null } }),
    loadingRows: document.querySelectorAll('.scw-treeState.is-in-tree').length,
  })
})()`))

const clickDir = (rel) => ev(`(function(){
  var dirs = Array.prototype.slice.call(document.querySelectorAll('.scw-row.is-dir'))
  var target = ${JSON.stringify(rel)} === '' ? dirs[0] : dirs.filter(function (n) { return (n.getAttribute('title') || '') === ${JSON.stringify(rel)} })[0]
  if (!target) return 'none'
  target.click()
  return target.getAttribute('title') || '?'
})()`)

try {
  await ev(`(function(){
    var el = Array.prototype.slice.call(document.querySelectorAll('.wbd-railItem, .wbd-tab'))
      .filter(function (n) { return (n.textContent || '').indexOf('源码') >= 0 })[0]
    if (el) el.click()
    return 'ok'
  })()`)
  await sleep(1300)

  await ev(`(function(){
    var files = Array.prototype.slice.call(document.querySelectorAll('.scw-mode'))
      .filter(function (n) { return (n.textContent || '').indexOf('文件') >= 0 })[0]
    if (files) files.click()
    return files ? 'ok' : 'missing'
  })()`)
  await sleep(900)

  const base = await snapshot()
  check('files view is open', base.mode.indexOf('文件') >= 0, base.mode)
  check('tree has directories to click', base.dirs.length > 0, 'dirs=' + base.dirs.length)

  /* 1) directory click expands, and never opens the drawer */
  const expandedRel = await clickDir('')
  await sleep(800)
  const expanded = await snapshot()
  check('directory click does not open the content pane', expanded.drawerOpen === false, expandedRel)
  check('directory click expands the directory', expanded.rowCount > base.rowCount, base.rowCount + ' -> ' + expanded.rowCount)

  await clickDir(expandedRel)
  await sleep(500)
  const collapsed = await snapshot()
  check('second click collapses the directory', collapsed.rowCount === base.rowCount, base.rowCount + ' vs ' + collapsed.rowCount)

  /* 2) changes-only filter: no stuck loading rows, auto-expanded dirs collapsible */
  const filterClicked = await ev(`(function(){
    var buttons = Array.prototype.slice.call(document.querySelectorAll('.scw-toolIcon, .scw-iconBtn, .scw-toolBtn'))
    var filter = buttons.filter(function (n) { return (n.getAttribute('title') || '').indexOf('变更') >= 0 })[0]
    if (!filter) return 'missing'
    filter.click()
    return filter.getAttribute('title')
  })()`)
  await sleep(1800)
  const filtered = await snapshot()
  check('filter button exists', filterClicked !== 'missing', filterClicked)
  check('filtered tree has no stuck loading rows', filtered.loadingRows === 0, 'loadingRows=' + filtered.loadingRows)
  check('filtered tree hides clean files', filtered.rowCount < base.rowCount, base.rowCount + ' -> ' + filtered.rowCount)

  const dirtyDir = filtered.dirs.filter((entry) => entry.dirty === true)[0]
  if (dirtyDir === undefined) {
    check('a dirty directory is visible in the filtered tree', false, 'none')
  } else {
    const beforeCollapse = filtered.rowCount
    await clickDir(dirtyDir.rel)
    await sleep(700)
    const afterCollapse = await snapshot()
    check('an auto-expanded directory can be collapsed', afterCollapse.rowCount < beforeCollapse, beforeCollapse + ' -> ' + afterCollapse.rowCount + ' via ' + dirtyDir.rel)
    check('no loading row after collapsing', afterCollapse.loadingRows === 0, 'loadingRows=' + afterCollapse.loadingRows)
  }
} finally {
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  if (shot.result && shot.result.data) { mkdirSync(outDir, { recursive: true }); writeFileSync(path.join(outDir, 'files-tree.png'), Buffer.from(shot.result.data, 'base64')) }
  await close()
}

console.log(failures === 0 ? 'PASS — file tree behaves as specified' : 'FAILURES: ' + failures)
process.exit(failures === 0 ? 0 : 1)
