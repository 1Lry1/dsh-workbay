/**
 * Geometry check for the workbench entry in the LEFT sidebar row seat.
 *
 * The host wraps `sidebar.panellist` entries in its own
 * <button class="…panelRow">; the entry must occupy exactly the box of the
 * host's own 16px glyphs, or the row grows and the label drifts away from
 * 插件 / 自动化任务 / 更多.
 *
 * This renders the host's real CSS (copied from @deepseek-ai/dsh-client-ui-sidebar
 * SidebarRoot.module.css) plus the entry CSS taken from src/client.js, then
 * asserts that the workbench row matches its peers.
 *
 * Usage: node tests/entry-align.mjs [browser-exe]
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientSource = path.join(here, '..', 'src', 'client.js')

const browser = process.argv[2] ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

/* Host CSS: the subset that decides the row box (verbatim from the host). */
const HOST_CSS = `
.wtg9ga_root{--dsh-sidebar-inline-padding:12px;height:100%;width:280px;padding:6px var(--dsh-sidebar-inline-padding);box-sizing:border-box;color:#e6e6e6;flex-direction:column;font-size:14px;display:flex;font-family:system-ui,sans-serif}
.wtg9ga_panelList{flex-direction:column;flex:none;gap:2px;margin-bottom:8px;display:flex;list-style:none;padding:0}
.wtg9ga_panelRow{box-sizing:border-box;border-radius:8px;min-height:36px;color:#e6e6e6;font:inherit;text-align:left;cursor:pointer;background:0 0;border:none;align-items:center;gap:8px;margin:0 2px;padding:7px 8px;line-height:22px;display:flex}
.wtg9ga_panelGlyph{flex:none;justify-content:center;align-items:center;display:inline-flex}
.wtg9ga_panelTitle{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}
`

const readText = (file) => {
  /* Reuse the plugin's own stylesheet: one source of truth. */
  return import('node:fs').then(({ readFileSync }) => readFileSync(file, 'utf8'))
}

const source = await readText(clientSource)
/* The stylesheet is one backtick template that ends with a backtick on its own
   line. Slice by index: a regex with a lookahead for that terminator eats the
   LAST character of the template (the final `}`), which silently truncates the
   stylesheet and made this harness pass against the very bug it looks for. */
const CSS_OPEN = 'const CSS = `'
const cssStart = source.indexOf(CSS_OPEN)
if (cssStart < 0) throw new Error('could not find the plugin CSS template in src/client.js')
const cssEnd = source.indexOf('\n`', cssStart + CSS_OPEN.length)
if (cssEnd < 0) throw new Error('unterminated plugin CSS template in src/client.js')
const ENTRY_CSS = source.slice(cssStart + CSS_OPEN.length, cssEnd)
if (ENTRY_CSS.length < 200) throw new Error('the extracted plugin CSS looks truncated (' + ENTRY_CSS.length + ' chars)')
if (!ENTRY_CSS.trimEnd().endsWith('}')) throw new Error('the extracted plugin CSS must end with a complete rule')
if (!ENTRY_CSS.includes('.wbd-entryBtn')) throw new Error('the extracted plugin CSS has no .wbd-entryBtn rule')

/** The workbench glyph, read from the plugin so the test tracks the real drawing. */
function iconPathsOf(source) {
  const match = source.match(/workbench: \[([^\]]*)\]/)
  if (match === null) throw new Error('could not find the workbench glyph paths in src/client.js')
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
}

const WB_PATHS = iconPathsOf(source)
const wbSvg = `<svg class="wbd-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${WB_PATHS.map((d) => `<path d="${d}"/>`).join('')}</svg>`

/* One row EXACTLY like the host builds it, including the display:contents DIV the
   slot renderer inserts between the glyph wrapper and the entry:
     button.panelRow > span.panelGlyph > div[display:contents] > span.wbd-entryBtn */
const row = (label, glyphHtml) => `
<button type="button" class="wtg9ga_panelRow" aria-label="${label}">
  <span class="wtg9ga_panelGlyph">
    <div style="display:contents"><span class="wbd-entryBtn" role="button" tabindex="0">${glyphHtml}</span></div>
  </span>
  <span class="wtg9ga_panelTitle">${label}</span>
</button>`

/* Peers use the host's own glyph size (16px in the same 22px line box). */
const peerRow = (label, d) => `
<button type="button" class="wtg9ga_panelRow" aria-label="${label}">
  <span class="wtg9ga_panelGlyph"><svg class="wbd-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${d}</svg></span>
  <span class="wtg9ga_panelTitle">${label}</span>
</button>`

const page = (entryCss) => `<!doctype html><meta charset="utf-8"><style>
${HOST_CSS}
${entryCss}
</style>
<nav class="wtg9ga_panelList">
${peerRow('插件', '<rect x="4.8" y="4.8" width="6.4" height="6.4" rx="1.2"/>')}
${peerRow('自动化任务', '<circle cx="8" cy="8" r="6.4"/>')}
${row('工作台', wbSvg)}
${peerRow('更多', '<rect x="1.8" y="1.8" width="5.2" height="5.2" rx="1.2"/>')}
</nav>
<pre id="out"></pre>
<script>
const rows = [...document.querySelectorAll('.wtg9ga_panelRow')]
const info = rows.map((r) => {
  const rr = r.getBoundingClientRect()
  const glyph = r.querySelector('.wtg9ga_panelGlyph').getBoundingClientRect()
  const title = r.querySelector('.wtg9ga_panelTitle').getBoundingClientRect()
  const entry = r.querySelector('.wbd-entryBtn')
  const icon = entry === null ? null : entry.querySelector('svg').getBoundingClientRect()
  return {
    label: r.getAttribute('aria-label'),
    rowH: Math.round(rr.height * 100) / 100,
    rowY: Math.round(rr.top * 100) / 100,
    glyphCx: Math.round((glyph.left + glyph.width / 2) * 100) / 100,
    glyphW: Math.round(glyph.width * 100) / 100,
    labelX: Math.round(title.left * 100) / 100,
    iconW: icon === null ? null : Math.round(icon.width * 100) / 100,
    iconCx: icon === null ? null : Math.round((icon.left + icon.width / 2) * 100) / 100,
    /* Ink box of the DRAWN paths (getBBox walks the real path data, so relative
       commands are honoured). Stroke is excluded; every glyph here uses 1.4. */
    inkW: (() => { const s = r.querySelector('.wtg9ga_panelGlyph svg'); if (s === null) return null; const b = s.getBBox(); return Math.round(b.width * 100) / 100 })(),
    inkH: (() => { const s = r.querySelector('.wtg9ga_panelGlyph svg'); if (s === null) return null; const b = s.getBBox(); return Math.round(b.height * 100) / 100 })(),
  }
})
document.getElementById('out').textContent = 'RESULT:' + JSON.stringify(info)
</script>`

/** Render one variant of the stylesheet and read the row geometry back. */
async function measureRows(entryCss) {
  const dir = mkdtempSync(path.join(tmpdir(), 'wbd-align-'))
  const file = path.join(dir, 'index.html')
  writeFileSync(file, page(entryCss))

  const dump = await new Promise((resolve) => {
    const child = spawn(browser, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--window-size=1200,900', '--virtual-time-budget=2000', '--dump-dom', 'file:///' + file.split(path.sep).join('/'),
    ], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.on('close', () => resolve(out))
    setTimeout(() => { try { child.kill() } catch { /* already gone */ } }, 30000)
  })
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* windows lock */ }

  const match = dump.match(/RESULT:(\[[\s\S]*?\])/)
  if (match === null) {
    console.error('could not read the layout result from the browser; DOM dump head:')
    console.error(dump.slice(0, 600))
    process.exit(2)
  }
  return JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'))
}

const rowsOut = await measureRows(ENTRY_CSS)
const peer = rowsOut.filter((r) => r.label !== '工作台')
const mine = rowsOut.find((r) => r.label === '工作台')
if (mine === undefined || peer.length === 0) { console.error('rows missing: ' + JSON.stringify(rowsOut)); process.exit(2) }

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (detail === undefined ? '' : '  ' + detail))
}

const peerRowH = Math.max(...peer.map((r) => r.rowH))
const peerGlyphCx = peer[0].glyphCx
const peerLabelX = peer[0].labelX
console.log('measured: ' + JSON.stringify(rowsOut, null, 1))

check('the workbench row is as tall as its peers', Math.abs(mine.rowH - peerRowH) < 0.6,
  'row ' + mine.rowH + 'px vs peer ' + peerRowH + 'px')
check('the glyph box is 16px wide like its peers', Math.abs(mine.glyphW - 16) < 0.6, mine.glyphW + 'px')
check('the glyph centre matches its peers', Math.abs(mine.glyphCx - peerGlyphCx) < 0.6,
  mine.glyphCx + ' vs ' + peerGlyphCx)
check('the label starts where its peers start', Math.abs(mine.labelX - peerLabelX) < 0.6,
  mine.labelX + ' vs ' + peerLabelX)
check('the drawn icon is the same size as the peer glyphs', mine.iconW !== null && Math.abs(mine.iconW - 16) < 0.6,
  String(mine.iconW))
check('rows do not drift apart vertically',
  peer.every((r) => Math.abs((r.rowY - (peer[0].rowY)) - (rowsOut.indexOf(r) * (peerRowH + 2))) < 1.5),
  JSON.stringify(rowsOut.map((r) => r.rowY)))
/* Optical, not just geometric: the ink of the workbench glyph must be the same
   square the peer glyphs occupy in the same 16px box. The old drawing was a
   12.4×8.2 bar — centred, yet visibly lower and smaller than its peers.
   getBBox() measures the real path data, so this cannot be fooled by regex. */
const peerInk = peer[0].inkW === null ? 13 : Math.max(...peer.map((r) => r.inkW))
const peerInkH = peer[0].inkH === null ? 13 : Math.max(...peer.map((r) => r.inkH))
check('the glyph ink is as large as its peers', mine.inkW !== null && mine.inkW >= peerInk - 1.5,
  `ink ${mine.inkW}x${mine.inkH}px vs peer ${peerInk}x${peerInkH}px`)
check('the glyph is square, not a wide flat bar',
  mine.inkW !== null && Math.abs(mine.inkW - mine.inkH) <= 2.5, `${mine.inkW} vs ${mine.inkH}`)

const failed = results.filter((r) => !r.ok).length

/* Self-check: the same assertions must FAIL against the old 28px rule. A harness
   that passes both ways would have let this regression ship twice. */
const OLD_CSS = '.wbd-entryBtn{display:inline-flex;align-items:center;justify-content:center;min-width:28px;height:28px;cursor:pointer;border:none;border-radius:7px;background:transparent;color:inherit}'
const buggyRows = await measureRows(ENTRY_CSS + '\n' + OLD_CSS)
const buggyMine = buggyRows.find((r) => r.label === '工作台')
const buggyPeer = buggyRows.filter((r) => r.label !== '工作台')[0]
const buggyDetected = buggyMine !== undefined && buggyPeer !== undefined &&
  (Math.abs(buggyMine.rowH - buggyPeer.rowH) >= 1 || Math.abs(buggyMine.labelX - buggyPeer.labelX) >= 1)
check('the harness actually detects the old 28px rule', buggyDetected,
  buggyMine === undefined ? 'no row' : 'buggy row ' + buggyMine.rowH + 'px / label ' + buggyMine.labelX + ' vs peer ' + buggyPeer.rowH + 'px / ' + buggyPeer.labelX)

const failures = results.filter((r) => !r.ok).length
console.log(`\nentry-align: ${results.length - failures}/${results.length} passed`)
process.exit(failures === 0 ? 0 : 1)
