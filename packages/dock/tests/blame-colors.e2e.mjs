/** Probe: blame gutter colours one author distinctly, and the layout stays aligned. */
import { startRealHarness } from './real-harness.mjs'
import { writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const outDir = process.env.WBM_BLAME_OUT ?? path.join(tmpdir(), 'wbm-blame-' + process.pid)
const h = await startRealHarness({ windowSize: '1100,900', dockWidth: 860, layout: 'auto', dockOpen: true })
const { ev, send, close, sleep } = h

const clickText = (selector, text) => ev(`(function(){
  var nodes = Array.prototype.slice.call(document.querySelectorAll(${JSON.stringify(selector)}))
  var hit = nodes.filter(function (n) { return (n.textContent || '').indexOf(${JSON.stringify(text)}) >= 0 })[0]
  if (!hit) return 'missing'
  hit.click()
  return 'clicked'
})()`)

let ok = 1
try {
  await clickText('.wbd-railItem, .wbd-tab', '源码')
  await sleep(1400)
  /* pick a changed file (changes view is the default) */
  const picked = await ev(`(function(){
    var rows = Array.prototype.slice.call(document.querySelectorAll('.wbd-docked .scw-row'))
    if (rows.length === 0) return 'no-rows'
    rows[0].click()
    return 'clicked'
  })()`)
  await sleep(900)
  const tab = await clickText('.wbd-docked .scw-tab', '逐行作者')
  await sleep(1400)
  const state = JSON.parse(await ev(`(function(){
    var rows = Array.prototype.slice.call(document.querySelectorAll('.wbd-docked .scw-blameRow'))
    var hashes = Array.prototype.slice.call(document.querySelectorAll('.wbd-docked .scw-blameHash'))
    var colors = hashes.map(function (n) { return getComputedStyle(n).color })
    var borders = rows.map(function (n) { return getComputedStyle(n).borderLeftColor })
    var unique = Array.from(new Set(colors.concat(borders)))
    var authorsShown = Array.prototype.map.call(document.querySelectorAll('.wbd-docked .scw-blameMeta'), function (n) { return (n.textContent || '').trim() })
    var chips = Array.prototype.map.call(document.querySelectorAll('.wbd-docked .scw-blameChip'), function (n) { return (n.textContent || '').trim() })
    return JSON.stringify({
      rows: rows.length,
      hashColors: colors.slice(0, 8),
      borderColors: borders.slice(0, 8),
      uniqueColors: unique.length,
      authorsShown: authorsShown,
      blankAuthors: authorsShown.filter(function (name) { return name === '' }).length,
      hashLengths: hashes.map(function (n) { return (n.textContent || '').trim().length }),
      legendChips: chips,
      groupStarts: document.querySelectorAll('.wbd-docked .scw-blameRow.is-group-start').length,
      pairs: Array.prototype.map.call(rows, function (n) {
        var hashCell = n.querySelector('.scw-blameHash')
        var authorCell = n.querySelector('.scw-blameMeta')
        return { hash: ((hashCell && hashCell.textContent) || '').trim(), author: ((authorCell && authorCell.textContent) || '').trim() }
      }),
      sameColumnX: rows.length === 0 ? [] : Array.prototype.map.call(rows, function (n) { return Math.round(n.getBoundingClientRect().left) }).filter(function (v, i, a) { return a.indexOf(v) === i }),
    })
  })()`))
  console.log(JSON.stringify({ picked, tab, state }, null, 2))
  const checks = {
    threeAuthors: new Set(state.authorsShown).size >= 3,
    everyRowNamesItsAuthor: state.blankAuthors === 0,
    everyRowShowsAHash: state.hashLengths.every((length) => length === 7),
    coloursDistinct: state.uniqueColors >= 3,
    legendListsAuthors: state.legendChips.length >= 3,
    groupDividers: state.groupStarts >= 1,
    continuationRowsInheritAuthor: state.authorsShown.length > new Set(state.authorsShown).size,
    adjacentAuthorsDiffer: state.borderColors.every((color, index) => index === 0 || state.authorsShown[index] === state.authorsShown[index - 1] || color !== state.borderColors[index - 1]),
    aligned: state.sameColumnX.length === 1,
    hashAndAuthorAgree: (function () {
      const byHash = new Map()
      for (const pair of state.pairs) {
        if (pair.hash === '') continue
        if (byHash.has(pair.hash) && byHash.get(pair.hash) !== pair.author) return false
        byHash.set(pair.hash, pair.author)
      }
      return true
    })(),
  }
  console.log('checks: ' + JSON.stringify(checks))
  ok = Object.values(checks).every((value) => value === true) ? 0 : 1
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  if (shot.result && shot.result.data) mkdirSync(outDir, { recursive: true }); writeFileSync(path.join(outDir, 'blame-colors.png'), Buffer.from(shot.result.data, 'base64'))
} finally {
  await close()
}
console.log(ok === 0 ? 'PASS — blame colours distinguish authors' : 'FAIL — blame colours missing')
process.exit(ok)
