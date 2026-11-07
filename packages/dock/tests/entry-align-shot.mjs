/**
 * Before/after visual: render the sidebar seat with the OLD and the NEW entry
 * styles into one dark page and screenshot it, so alignment changes are
 * reviewable by eye (numbers alone hide optical-size problems).
 *
 * Usage: node packages/dock/tests/entry-align-shot.mjs [browser-exe] [out.png]
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientSource = path.join(here, '..', 'src', 'client.js')
const browser = process.argv[2] ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const outFile = path.resolve(process.argv[3] ?? path.join(here, '..', 'docs', 'entry-align.png'))

const source = readFileSync(clientSource, 'utf8')
const open = 'const CSS = `'
const cssStart = source.indexOf(open) + open.length
const NEW_CSS = source.slice(cssStart, source.indexOf('\n`', cssStart))
const OLD_ENTRY = '.wbd-entryBtn{display:inline-flex;align-items:center;justify-content:center;min-width:28px;height:28px;cursor:pointer;border:none;border-radius:7px;background:transparent;color:inherit}'

const HOST_CSS = `
*{box-sizing:border-box}
body{margin:0;background:#1a1d23;font-family:"Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.seat{width:280px;padding:6px 12px;color:#e6e6e6;font-size:14px}
.panelList{flex-direction:column;gap:2px;margin:0 0 8px;padding:0;display:flex;list-style:none}
.panelRow{border-radius:8px;min-height:36px;color:#e6e6e6;font:inherit;text-align:left;background:0 0;border:none;align-items:center;gap:8px;margin:0 2px;padding:7px 8px;line-height:22px;display:flex;width:calc(100% - 4px);cursor:pointer}
.panelGlyph{flex:none;justify-content:center;align-items:center;display:inline-flex}
.panelTitle{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}
h4{margin:14px 12px 4px;color:#8a8f98;font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase}
.grid{display:flex;gap:0}
.col{flex:1}
.col+.col{border-left:1px solid #2c3038}
`

/* Glyphs of the peers, at their real optical size (~14×14 ink in a 16px box). */
const peersvg = (d) => `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`
const PLUGIN = peersvg('<path d="M8 1.6v3.1M8 11.3v3.1M1.6 8h3.1M11.3 8h3.1"/><rect x="4.8" y="4.8" width="6.4" height="6.4" rx="1.2"/>')
const TASKS = peersvg('<circle cx="8" cy="8" r="6.4"/><path d="M8 4.4V8l2.6 1.6"/>')
const MORE = peersvg('<rect x="1.8" y="1.8" width="5.2" height="5.2" rx="1.2"/><rect x="9" y="1.8" width="5.2" height="5.2" rx="1.2"/><rect x="1.8" y="9" width="5.2" height="5.2" rx="1.2"/><path d="M11.6 9v5.2M9 11.6h5.2"/>')

/* Read the glyph from the plugin itself, so the picture can never go stale. */
const glyphMatch = source.match(/workbench: \[([^\]]*)\]/)
if (glyphMatch === null) throw new Error('could not find the workbench glyph paths in src/client.js')
const WB_PATHS = [...glyphMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
const OLD_WB_PATHS = ['M1.8 4.2h12.4v8.2H1.8z', 'M1.8 7.4h12.4', 'M6.2 7.4v5']
const svgOf = (paths) => `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${paths.map((d) => `<path d="${d}"/>`).join('')}</svg>`
const wbsvg = (size) => svgOf(WB_PATHS).replace('width="16" height="16"', `class="wbd-icon" width="${size}" height="${size}"`)
const OLD_WB = `<svg class="wbd-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${OLD_WB_PATHS.map((d) => `<path d="${d}"/>`).join('')}</svg>`

const row = (label, glyphHtml) => `<li><button class="panelRow" aria-label="${label}"><span class="panelGlyph">${glyphHtml}</span><span class="panelTitle">${label}</span></button></li>`

const seat = (entryHtml) => `<div class="seat"><ul class="panelList">
  ${row('插件', PLUGIN)}
  ${row('自动化任务', TASKS)}
  ${row('工作台', entryHtml)}
  ${row('更多', MORE)}
</ul></div>`

/* The "before" column re-adds the old rule, scoped to itself so both variants
   can be shown side by side from ONE extraction of the current stylesheet. */
const page = `<!doctype html><meta charset="utf-8"><style>
${HOST_CSS}
${NEW_CSS}
.col-old .wbd-entryBtn{display:inline-flex;align-items:center;justify-content:center;min-width:28px;height:28px;cursor:pointer;border:none;border-radius:7px;background:transparent;color:inherit}
</style>
<div class="grid">
  <div class="col col-old">
    <h4>before · 28px entry</h4>
    ${seat(`<span class="wbd-entryBtn" role="button" tabindex="0">${OLD_WB}</span>`)}
  </div>
  <div class="col">
    <h4>after · matches 插件 / 更多</h4>
    ${seat(`<span class="wbd-entryBtn" role="button" tabindex="0">${wbsvg(16)}</span>`)}
  </div>
</div>`

const dir = mkdtempSync(path.join(tmpdir(), 'wbd-shot-'))
const file = path.join(dir, 'index.html')
writeFileSync(file, page)
const width = 640
const height = 240
const shotPath = path.join(dir, 'shot.png')

await new Promise((resolve) => {
  const child = spawn(browser, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    '--force-device-scale-factor=2',
    `--window-size=${width},${height}`,
    '--virtual-time-budget=1500',
    `--screenshot=${shotPath}`,
    'file:///' + file.split(path.sep).join('/'),
  ], { stdio: 'ignore' })
  child.on('close', resolve)
})

try {
  const { copyFileSync, mkdirSync } = await import('node:fs')
  mkdirSync(path.dirname(outFile), { recursive: true })
  copyFileSync(shotPath, outFile)
  console.log('wrote ' + outFile)
} finally {
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* windows lock */ }
}
