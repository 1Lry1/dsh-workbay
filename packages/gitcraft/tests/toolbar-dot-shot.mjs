/**
 * Visual check for the GitCraft toolbar dots: renders the real header markup and
 * the real stylesheet from src/client.js in four sync states, then measures that
 * the dot does NOT change the 24px button box (a badge in the layout flow would
 * push the neighbouring buttons, the same class of bug the sidebar entry had).
 *
 * Usage: node tests/toolbar-dot-shot.mjs [browser-exe] [out.png]
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientSource = path.join(here, '..', 'src', 'client.js')
const browser = process.argv[2] ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const outFile = path.resolve(process.argv[3] ?? path.join(here, '..', 'docs', 'toolbar-dot.png'))

const source = readFileSync(clientSource, 'utf8')
const open = 'const CSS = `'
const start = source.indexOf(open) + open.length
const CSS = source.slice(start, source.indexOf('\n`', start))
if (!CSS.includes('.gwc-dot')) throw new Error('the extracted stylesheet has no .gwc-dot rule')

/* Icons, taken from the plugin so the picture cannot go stale. */
function pathsOf(name) {
  const m = new RegExp(name + ": \\[([^\\]]*)\\]").exec(source)
  if (m === null) return []
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
}
const svg = (name, size = 14) => {
  const paths = pathsOf(name)
  return `<svg class="gwc-icon" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${paths.map((d) => `<path d="${d}"/>`).join('')}</svg>`
}

const button = (name, label, dot) => `<button class="gwc-iconBtn${dot ? ' has-dot' : ''}" aria-label="${label}">${svg(name)}${dot ? '<span class="gwc-dot" aria-hidden="true"></span>' : ''}</button>`

const row = (title, detail, pullDot, pushDot) => `<div class="case">
  <div class="caseHead"><b>${title}</b><span>${detail}</span></div>
  <div class="gwc-header"><div class="gwc-headerMain"><span class="gwc-branchName">main</span></div>
    <div class="gwc-headerActions">
      ${button('repo', '切换仓库', false)}
      ${button('refresh', '刷新', false)}
      ${button('fetch', '抓取', false)}
      ${button('pull', '拉取', pullDot)}
      ${button('push', '推送', pushDot)}
    </div></div>
  <div class="measure" data-case="${title}"></div>
</div>`

const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;padding:16px 20px;background:#1a1d23;font-family:"Segoe UI",system-ui,sans-serif;color:#e6e6e6}
${CSS}
.case{margin-bottom:18px}
.caseHead{display:flex;gap:10px;align-items:baseline;margin-bottom:2px}
.caseHead b{font-size:13px;font-weight:600}
.caseHead span{font-size:11px;color:#8a8f98}
h1{font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#8a8f98;margin:0 0 14px}
</style>
<h1>GitCraft toolbar · 拉取/推送 红点</h1>
${row('同步', '无待办', false, false)}
${row('只落后', '远程有新提交 → 拉取亮', true, false)}
${row('只领先', '有未推送提交 → 推送亮', false, true)}
${row('已分叉', '两边都有 → 都亮', true, true)}
<pre id="out" hidden></pre>
<script>
/* Measure every header: with and without dots the five buttons must be identical. */
const cases = []
for (const wrap of document.querySelectorAll('.case')) {
  const title = wrap.querySelector('b').textContent
  const header = wrap.querySelector('.gwc-headerActions')
  const buttons = [...header.querySelectorAll('.gwc-iconBtn')]
  const dots = [...header.querySelectorAll('.gwc-dot')]
  const boxes = buttons.map((b) => { const r = b.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height) })
  cases.push({
    title,
    headerW: Math.round(header.getBoundingClientRect().width),
    headerH: Math.round(header.getBoundingClientRect().height),
    boxes,
    dotCount: dots.length,
  })
}
document.getElementById('out').textContent = 'RESULT:' + JSON.stringify(cases)
</script>`

const dir = mkdtempSync(path.join(tmpdir(), 'gwc-dot-'))
const file = path.join(dir, 'index.html')
const shotPath = path.join(dir, 'shot.png')
writeFileSync(file, html)
const url = 'file:///' + file.split(path.sep).join('/')

const dump = await new Promise((resolve) => {
  const child = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--force-device-scale-factor=2', '--window-size=520,420', '--virtual-time-budget=1500', '--dump-dom', url,
  ], { stdio: ['ignore', 'pipe', 'ignore'] })
  let out = ''
  child.stdout.on('data', (c) => { out += c })
  child.on('close', () => resolve(out))
})
await new Promise((resolve) => {
  const child = spawn(browser, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    '--force-device-scale-factor=2', '--window-size=520,420', '--virtual-time-budget=1500', `--screenshot=${shotPath}`, url,
  ], { stdio: 'ignore' })
  child.on('close', resolve)
})

/* The DOM dump HTML-escapes nothing inside <pre> textContent, but the JSON does
   contain nested arrays; anchor on the closing "</pre>" rather than on the first
   "]" (which closes the inner `boxes` array and truncates the payload). */
const raw = /RESULT:([\s\S]*?)<\/pre>/.exec(dump)
if (raw === null) {
  console.error('no layout result; DOM head:')
  console.error(dump.slice(0, 500))
  process.exit(2)
}
const cases = JSON.parse(raw[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim())
if (cases.length === 0) throw new Error('empty layout result')

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (detail === undefined ? '' : '  ' + detail))
}
console.log(JSON.stringify(cases, null, 1))

const synced = cases.find((c) => c.title === '同步')
check('the four states show 0/1/1/2 dots',
  cases.map((c) => c.dotCount).join(',') === '0,1,1,2',
  cases.map((c) => c.title + '=' + c.dotCount).join(' '))
check('every button stays 24x24 in every state',
  cases.every((c) => c.boxes.every((b) => b === '24x24')),
  JSON.stringify(cases.map((c) => c.boxes)))
check('the button row is the same width with and without dots',
  cases.every((c) => c.headerW === synced.headerW),
  JSON.stringify(cases.map((c) => c.headerW)))
check('the button row is the same height with and without dots',
  cases.every((c) => c.headerH === synced.headerH),
  JSON.stringify(cases.map((c) => c.headerH)))

const { copyFileSync, mkdirSync } = await import('node:fs')
mkdirSync(path.dirname(outFile), { recursive: true })
copyFileSync(shotPath, outFile)
console.log('wrote ' + outFile)
try { rmSync(dir, { recursive: true, force: true }) } catch { /* windows lock */ }

const failures = results.filter((r) => !r.ok).length
console.log(`\ntoolbar-dot: ${results.length - failures}/${results.length} passed`)
process.exit(failures === 0 ? 0 : 1)
