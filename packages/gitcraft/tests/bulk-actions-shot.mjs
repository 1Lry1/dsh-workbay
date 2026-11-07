/**
 * Visual + geometry check for the change-group bulk actions
 * (全部暂存 / 全部取消暂存 / 全部撤销), rendered from the plugin's real
 * stylesheet so the screenshot cannot drift from the shipped CSS.
 *
 * Usage: node tests/bulk-actions-shot.mjs [browser-exe] [out.png]
 */
import { spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientSource = path.join(here, '..', 'src', 'client.js')
const browser = process.argv[2] ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const outFile = path.resolve(process.argv[3] ?? path.join(here, '..', 'docs', 'bulk-actions.png'))

const source = readFileSync(clientSource, 'utf8')
const open = 'const CSS = `'
const start = source.indexOf(open) + open.length
const CSS = source.slice(start, source.indexOf('\n`', start))
for (const needed of ['.gwc-groupActions', '.gwc-btn', '.gwc-groupHead', '.gwc-changeRow']) {
  if (!CSS.includes(needed)) throw new Error('extracted stylesheet is missing ' + needed)
}

const row = (status, name, dir) => `<div class="gwc-changeRow">
  <span class="gwc-statusBadge kind-modified">${status}</span>
  <span class="gwc-changeName">${name}</span>
  <span class="gwc-changeDir">${dir}</span>
  <span class="gwc-changeStat"><span class="gwc-add">+12</span><span class="gwc-del">−3</span></span>
</div>`

const group = (id, title, actions, rows) => `<div class="gwc-group">
  <div class="gwc-groupHead">
    <span class="gwc-groupTitle">${title}</span>
    <span class="gwc-groupActions">${actions}</span>
  </div>
  ${rows}
</div>`

const btn = (label, danger) => `<button class="gwc-btn${danger ? ' is-danger' : ''}">${label}</button>`

const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;padding:16px 0;background:#1a1d23;font-family:"Segoe UI",system-ui,sans-serif;color:#e6e6e6;width:420px}
${CSS}
.gwc-root{height:auto}
h1{font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#8a8f98;margin:0 0 10px;padding:0 10px}
</style>
<h1>变更 · 分组批量操作</h1>
<div class="gwc-root">
${group('staged', '已暂存 (2)', btn('全部取消暂存') + btn('全部撤销', true), row('M', 'index.ts', 'src/core') + row('M', 'App.tsx', 'src/ui'))}
${group('unstaged', '更改 (3)', btn('全部暂存') + btn('全部撤销', true), row('M', 'main.js', 'src') + row('D', 'old.js', 'src/legacy') + row('M', 'styles.css', 'src/ui'))}
</div>
<pre id="out" hidden></pre>
<script>
const heads = [...document.querySelectorAll('.gwc-groupHead')].map((h) => {
  const actions = h.querySelector('.gwc-groupActions')
  const buttons = [...h.querySelectorAll('button')]
  const hr = h.getBoundingClientRect()
  const ar = actions.getBoundingClientRect()
  return {
    title: h.querySelector('.gwc-groupTitle').textContent,
    labels: buttons.map((b) => b.textContent),
    headW: Math.round(hr.width),
    headH: Math.round(hr.height),
    actionsRight: Math.round(ar.right),
    /* Every button on ONE line => their vertical centres agree. */
    centers: buttons.map((b) => { const r = b.getBoundingClientRect(); return Math.round(r.top + r.height / 2) }),
    dangerStyled: buttons.map((b) => b.className.includes('is-danger')),
  }
})
document.getElementById('out').textContent = 'RESULT:' + JSON.stringify(heads)
</script>`

const dir = mkdtempSync(path.join(tmpdir(), 'gwc-bulk-'))
const file = path.join(dir, 'index.html')
const shotPath = path.join(dir, 'shot.png')
writeFileSync(file, html)
const url = 'file:///' + file.split(path.sep).join('/')

const dump = await new Promise((resolve) => {
  const child = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--window-size=420,420', '--virtual-time-budget=1500', '--dump-dom', url,
  ], { stdio: ['ignore', 'pipe', 'ignore'] })
  let out = ''
  child.stdout.on('data', (c) => { out += c })
  child.on('close', () => resolve(out))
})
await new Promise((resolve) => {
  const child = spawn(browser, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    '--force-device-scale-factor=2', '--window-size=420,420', '--virtual-time-budget=1500', `--screenshot=${shotPath}`, url,
  ], { stdio: 'ignore' })
  child.on('close', resolve)
})

const raw = /RESULT:([\s\S]*?)<\/pre>/.exec(dump)
if (raw === null) { console.error('no layout result; head:\n' + dump.slice(0, 500)); process.exit(2) }
const heads = JSON.parse(raw[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim())

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (detail === undefined ? '' : '  ' + detail))
}
console.log(JSON.stringify(heads, null, 1))

check('the staged group offers 全部取消暂存 + 全部撤销',
  heads[0].labels.join('|') === '全部取消暂存|全部撤销', heads[0].labels.join('|'))
check('the unstaged group offers 全部暂存 + 全部撤销',
  heads[1].labels.join('|') === '全部暂存|全部撤销', heads[1].labels.join('|'))
check('both groups show the discard button', heads.every((h) => h.labels.includes('全部撤销')))
check('the discard button is the danger-styled one',
  heads.every((h) => { const i = h.labels.indexOf('全部撤销'); return h.dangerStyled[i] === true }))
check('each group keeps both buttons on ONE line',
  heads.every((h) => new Set(h.centers).size === 1), JSON.stringify(heads.map((h) => h.centers)))
/* A wrapped action row would make the head noticeably taller than the 4px
   padding + ~22px button of a single line. 40px is comfortably above that and
   still far below a two-line layout. */
check('the action row does not wrap (group head stays one row)',
  heads.every((h) => h.headH <= 40), JSON.stringify(heads.map((h) => h.headH)))
/* Right-aligned means the action row ends at the head's right padding edge,
   i.e. within the 10px horizontal padding of the group head. */
check('the actions are right-aligned inside their group head',
  heads.every((h) => h.headW - h.actionsRight >= 6 && h.headW - h.actionsRight <= 14),
  JSON.stringify(heads.map((h) => [h.headW - h.actionsRight])))

mkdirSync(path.dirname(outFile), { recursive: true })
copyFileSync(shotPath, outFile)
console.log('wrote ' + outFile)
try { rmSync(dir, { recursive: true, force: true }) } catch { /* windows lock */ }

const failures = results.filter((r) => !r.ok).length
console.log(`\nbulk-actions: ${results.length - failures}/${results.length} passed`)
process.exit(failures === 0 ? 0 : 1)
