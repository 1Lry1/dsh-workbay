/**
 * Visual check for the Files-page commit POPUP: renders the real modal markup
 * with the plugin's own stylesheet, so the layout can be reviewed as a picture.
 *
 * Usage: node packages/gitcraft/tests/commit-popup-shot.mjs [exe] [out.png] [width]
 */
import { spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const browser = process.argv[2] ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const outFile = path.resolve(process.argv[3] ?? path.join(here, '..', 'docs', 'ui-commit-popup.png'))
const width = Number(process.argv[4] ?? 900)

const source = readFileSync(path.join(here, '..', 'src', 'client.js'), 'utf8')
const open = 'const CSS = `'
const start = source.indexOf(open) + open.length
const CSS = source.slice(start, source.indexOf('\n`', start))
for (const needed of ['.gwc-commitPopup', '.gwc-modal.is-wide', '.gwc-diff', '.gwc-hunk']) {
  if (!CSS.includes(needed)) throw new Error('extracted CSS is missing ' + needed)
}

function pathsOf(name) {
  const m = new RegExp('\\b' + name + ": \\[([^\\]]*)\\]").exec(source)
  return m === null ? [] : [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
}
const icon = (name, size = 13) => {
  const paths = pathsOf(name)
  if (paths.length === 0) return ''
  return `<svg class="gwc-icon" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${paths.map((d) => `<path d="${d}"/>`).join('')}</svg>`
}

/* A diff rendered the way DiffHunk would: hunk head + rows. */
const hunk = (header, rows) => `<div class="gwc-hunk">
  <div class="gwc-hunkHead"><span class="gwc-hunkTitle">${header}</span></div>
  <div class="gwc-lines">${rows.map(([kind, num, text]) => `<div class="gwc-row ${kind === 'add' ? 'is-add' : kind === 'del' ? 'is-del' : ''}">
    <span class="gwc-gutter">${num}</span><span class="gwc-sign">${kind === 'add' ? '+' : kind === 'del' ? '−' : ' '}</span><span class="gwc-text">${text}</span>
  </div>`).join('')}</div>
</div>`

const popup = `<div class="gwc-modalBackdrop">
  <div class="gwc-modal is-wide">
    <div class="gwc-modalHead">
      <span class="gwc-modalTitle">a3f8c21 · feat(files): add a commit popup to the Files page</span>
      <button class="gwc-iconBtn">${icon('close')}</button>
    </div>
    <div class="gwc-modalBody">
      <div class="gwc-commitPopup">
        <div class="gwc-commitPopupMeta">
          <span class="gwc-commitPopupHash">a3f8c21c9e41b7d05f2a</span>
          <span>Li Lei</span>
          <span>2026/11/04 10:41</span>
          <span class="gwc-commitPopupFile">src/ui/files-panel.ts</span>
        </div>
        <pre class="gwc-commitPopupBody">Clicking a row in the Files page used to jump to the History tab, which dropped the file being read. Reading one commit is a detail, not a navigation.</pre>
        <div class="gwc-commitPopupOthers">
          <span class="gwc-commitPopupOthersTitle">同一提交还改了 2 个文件</span>
          <span class="gwc-commitPopupOther">index.ts</span>
          <span class="gwc-commitPopupOther">store.ts</span>
        </div>
        <div class="gwc-commitPopupDiffBar">
          <span class="gwc-commitPopupDiffTitle">这次提交对该文件的修改</span>
        </div>
        <div class="gwc-commitPopupDiff">
          <div class="gwc-diff">
            ${hunk('@@ -41,7 +41,19 @@', [
              ['ctx', 41, 'const rows = useMemo(() => commits.map(toRow), [commits])'],
              ['ctx', 42, ''],
              ['del', 43, 'return E(\'div\', { className: "gwc-files" }, rows)'],
              ['add', 43, 'return E(\'div\', { className: "gwc-files" },' ],
              ['add', 44, '  E(Modal, { wide: true, onClose: closePopup },' ],
              ['add', 45, '    E(\'div\', { className: "gwc-commitPopup" }, detail, diff)),'],
              ['add', 46, '  rows)'],
              ['ctx', 47, '}'],
            ])}
          </div>
        </div>
      </div>
    </div>
  </div>
</div>`

const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#14161a;font-family:"Segoe UI",system-ui,sans-serif;width:${width}px}
.gwc-root{height:${Math.round(width * 0.76)}px;background:#1a1d23;display:flex;flex-direction:column}
${CSS}
</style>
<div class="gwc-root gwc-mode-columns">${popup}</div>`

const dir = mkdtempSync(path.join(tmpdir(), 'gwc-popup-'))
const file = path.join(dir, 'index.html')
const shotPath = path.join(dir, 'shot.png')
writeFileSync(file, html)

await new Promise((resolve) => {
  const child = spawn(browser, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--no-default-browser-check', '--force-device-scale-factor=2', `--window-size=${width},${Math.round(width * 0.78)}`,
    '--virtual-time-budget=1500', `--screenshot=${shotPath}`, 'file:///' + file.split(path.sep).join('/'),
  ], { stdio: 'ignore' })
  child.on('close', resolve)
})

mkdirSync(path.dirname(outFile), { recursive: true })
copyFileSync(shotPath, outFile)
console.log('wrote ' + outFile)
try { rmSync(dir, { recursive: true, force: true }) } catch { }
