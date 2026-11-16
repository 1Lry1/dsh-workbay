/**
 * Regression: the docked panel must NOT cover the conversation in ANY layout.
 *
 * The bug: the panel carries `zoom: 1.1`, so a 1400px CSS width rendered 1541px
 * physically while `body{padding-right}` reserved only 1400px → 141px of the
 * conversation sat under the panel (worse in 双栏/三栏 because the layout switch
 * widens the panel).
 *
 * The test measures the REAL rendered box against the REAL reserved padding for
 * auto / single / split / tri and fails on more than 2px of disagreement.
 *
 * Run: node packages/dock/tests/dock-overlap.e2e.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { startRealHarness } from './real-harness.mjs'

const outDir = process.env.WBM_OVERLAP_OUT ?? path.join(tmpdir(), 'wbm-overlap-' + process.pid)
mkdirSync(outDir, { recursive: true })

let failures = 0
const check = (name, ok, detail) => {
  console.log((ok === true ? 'ok   ' : 'FAIL ') + name + (detail === undefined ? '' : '  [' + detail + ']'))
  if (ok !== true) failures += 1
}

const h = await startRealHarness({ windowSize: '1920,1000', dockWidth: 900, layout: 'auto', dockOpen: true })
const { ev, send, close, sleep } = h

const measure = async () => JSON.parse(await ev(`(function(){
  var dock = document.querySelector('.wbd-docked')
  if (!dock) return JSON.stringify({ error: 'not docked' })
  var rect = dock.getBoundingClientRect()
  var bodyPad = parseFloat(getComputedStyle(document.body).paddingRight) || 0
  var reserveLeft = window.innerWidth - bodyPad
  return JSON.stringify({
    innerWidth: window.innerWidth,\n    panelWidth: Math.round(rect.width),
    panelLeft: Math.round(rect.left),
    padding: Math.round(bodyPad),
    conversationWidth: Math.round(reserveLeft),
    overlap: Math.round(reserveLeft - rect.left),
    tier: dock.getAttribute('data-w'),
    layout: dock.getAttribute('data-layout'),
  })
})()`))

const clickLayout = async (label) => {
  const clicked = await ev(`(function(){
    var b = [].slice.call(document.querySelectorAll('.wbd-docked .wbd-lsBtn')).filter(function (n) {
      return (n.getAttribute('aria-label') || '') === ${JSON.stringify(label)}
    })[0]
    if (!b || b.disabled) return 'missing'
    b.click()
    return 'clicked'
  })()`)
  await sleep(500)
  return clicked
}

try {
  const auto = await measure()
  check('auto layout: panel width equals the reserved space', Math.abs(auto.panelWidth - auto.padding) <= 2, JSON.stringify(auto))

  const cases = [
    ['单栏', 'single'],
    ['主从双栏', 'split'],
    ['三栏', 'tri'],
  ]
  for (const [label, expected] of cases) {
    const clicked = await clickLayout(label)
    const state = await measure()
    check(label + ': the layout switch applied', clicked === 'clicked' && state.layout === expected, clicked + ' / ' + state.layout)
    check(label + ': the panel does NOT cover the conversation', Math.abs(state.panelWidth - state.padding) <= 2 && state.overlap >= -2 && state.overlap <= 2,
      JSON.stringify({ panel: state.panelWidth, reserved: state.padding, overlap: state.overlap }))
    check(label + ': the conversation keeps at least 320px', state.conversationWidth >= 320, 'conversation=' + state.conversationWidth)
  }

  const tri = await measure()
  /* 1px is the panel's own border: width is the content box, the border sits outside. */
  check('tri width stays inside the window', Math.abs(tri.panelWidth + tri.conversationWidth - tri.innerWidth) <= 4,
    tri.panelWidth + ' + ' + tri.conversationWidth + ' vs ' + tri.innerWidth)

  const shot = await send('Page.captureScreenshot', { format: 'png' })
  if (shot.result && shot.result.data) writeFileSync(path.join(outDir, 'dock-overlap-tri.png'), Buffer.from(shot.result.data, 'base64'))
  const errors = JSON.parse(await ev('JSON.stringify(window.__ERRORS__ || [])'))
  check('no page errors', errors.length === 0, JSON.stringify(errors))
} finally {
  await close()
}

console.log('')
console.log(failures === 0 ? 'PASS — docked panel never covers the conversation' : 'FAILURES: ' + failures)
console.log('artifacts: ' + outDir)
process.exit(failures === 0 ? 0 : 1)
