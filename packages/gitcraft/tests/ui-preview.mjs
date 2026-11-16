/**
 * Render a realistic GitCraft panel from the plugin's REAL stylesheet, so the
 * layout can be reviewed as a picture instead of guessed at from CSS.
 *
 * Usage: node packages/gitcraft/tests/ui-preview.mjs [browser-exe] [out.png] [width]
 */
import { spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientSource = path.join(here, '..', 'src', 'client.js')
const browser = process.argv[2] ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const outFile = path.resolve(process.argv[3] ?? path.join(here, '..', 'docs', 'ui-preview.png'))
const width = Number(process.argv[4] ?? 560)
/* `files` renders the Files page, `branches` the Branches page, anything else
   the Changes page. */
const FILES_PAGE = process.argv[5] === 'files'
const BRANCHES_PAGE = process.argv[5] === 'branches'

const source = readFileSync(clientSource, 'utf8')
const open = 'const CSS = `'
const start = source.indexOf(open) + open.length
const CSS = source.slice(start, source.indexOf('\n`', start))

function pathsOf(name) {
  const m = new RegExp('\\b' + name + ": \\[([^\\]]*)\\]").exec(source)
  if (m === null) return []
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
}
const icon = (name, size = 13) => {
  const paths = pathsOf(name)
  if (paths.length === 0) return ''
  return `<svg class="gwc-icon" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${paths.map((d) => `<path d="${d}"/>`).join('')}</svg>`
}

const row = (kind, letter, name, dir, add, del, selected) => `<div class="gwc-changeRow${selected ? ' is-selected' : ''}">
  <span class="gwc-statusBadge kind-${kind}">${letter}</span>
  <span class="gwc-changeName">${name}</span>
  <span class="gwc-changeDir">${dir}</span>
  <span class="gwc-changeStat">${add ? `<span class="gwc-add">+${add}</span>` : ''}${del ? `<span class="gwc-del">−${del}</span>` : ''}</span>
  <span class="gwc-changeActions"><button class="gwc-iconBtn" style="width:20px;height:20px">${icon('plus', 12)}</button><button class="gwc-iconBtn" style="width:20px;height:20px">${icon('undo', 12)}</button></span>
</div>`

const group = (title, action, rows) => `<div class="gwc-group">
  <div class="gwc-groupHead"><span class="gwc-groupTitle">${title}</span><span class="gwc-groupActions">${action}</span></div>
  ${rows}
</div>`

const navBtn = (iconName, label, active, count) => `<button class="gwc-navBtn${active ? ' is-active' : ''}">${icon(iconName)}<span class="gwc-navLabel">${label}</span>${count ? `<span class="gwc-badge">${count}</span>` : ''}</button>`

/* ---- Files page markup: search + single-file history ---- */
const fileRow = (name, dir, selected) => `<div class="gwc-fileRow${selected ? ' is-selected' : ''}">
  <span class="gwc-fileRowName">${name}</span>
  <span class="gwc-fileRowDir">${dir}</span>
</div>`

const contentRow = (name, dir, line, text) => `<div class="gwc-fileRow">
  <span class="gwc-fileRowName">${name}</span>
  <span class="gwc-fileRowDir">${dir}</span>
  <span class="gwc-fileRowLine">${line}</span>
  <span class="gwc-fileRowText">${text}</span>
</div>`

const logRow = (hash, subject, author, time, add, del) => `<div class="gwc-fileLogRow">
  <span class="gwc-fileLogHash">${hash}</span>
  <span class="gwc-fileLogSubject">${subject}</span>
  <span class="gwc-fileLogMeta">
    <span class="gwc-fileLogAuthor">${author}</span>
    <span class="gwc-fileLogTime">${time}</span>
    <span class="gwc-fileLogStat"><span class="gwc-add">+${add}</span><span class="gwc-del">−${del}</span></span>
  </span>
</div>`

const filesBody = `<div class="gwc-files">
  <div class="gwc-fileBar">
    <div class="gwc-fileSearch">${icon('search')}
      <input class="gwc-input gwc-fileInput" value="index" readonly>
      <button class="gwc-fileClear">${icon('close', 11)}</button>
    </div>
    <div class="gwc-fileModes">
      <button class="gwc-fileMode is-active">文件名</button>
      <button class="gwc-fileMode">内容</button>
    </div>
  </div>
  <div class="gwc-filesMain">
    <div class="gwc-fileResults">
      ${fileRow('index.ts', 'src/core', true)}
      ${fileRow('index.css', 'src/ui', false)}
      ${fileRow('index.test.ts', 'src/core/__tests__', false)}
      ${fileRow('index.html', 'public', false)}
    </div>
    <div class="gwc-fileHistory">
      <div class="gwc-fileHistoryHead">
        <span class="gwc-fileHistoryPath">src/core/index.ts</span>
        <button class="gwc-iconBtn" style="width:20px;height:20px">${icon('refresh', 12)}</button>
      </div>
      <div class="gwc-fileLog">
        <div class="gwc-fileLogCount">共 4 次提交</div>
        ${logRow('a3f8c21', 'feat(core): 抽出 store 的 apply 通道', 'Li Lei', '2026/10/31', 48, 12)}
        ${logRow('7d2e9b4', 'fix(core): 修掉 watcher 自取消快照的问题', 'Li Lei', '2026/10/30', 6, 9)}
        ${logRow('1c55ae0', 'refactor: 拆分 gitcraft 客户端', 'Wang Wu', '2026/10/28', 210, 88)}
        ${logRow('9b01f7d', 'chore: 初始版本', 'Wang Wu', '2026/10/20', 340, 0)}
      </div>
    </div>
  </div>
</div>`

/* ---- Branches page: tag publish state ---- */
const refRow = ({ name, head, unpublished, missingN, showsPublish }) => `<div class="gwc-branchRow${head ? ' is-head' : ''}">
  <span class="gwc-branchRowName">${name}</span>
  ${head ? '<span class="gwc-refPill is-local">HEAD</span>' : ''}
  ${unpublished ? '<span class="gwc-syncMini is-unpublished">未发布</span>' : ''}
  ${missingN ? `<span class="gwc-syncMini is-unpublished">缺 ${missingN} 个远程</span>` : ''}
  <span class="gwc-branchRowActions">
    ${showsPublish ? '<button class="gwc-btn is-primary" style="display:inline-block">发布到远程</button>' : ''}
    <button class="gwc-iconBtn" style="width:22px;height:22px">${icon('undo', 12)}</button>
  </span>
</div>`

const branchesBody = `<div class="gwc-branches">
  <div class="gwc-branchBar">
    <button class="gwc-btn">新建分支</button>
    <button class="gwc-iconBtn" style="width:22px;height:22px">${icon('refresh', 12)}</button>
  </div>
  <div class="gwc-group">
    <div class="gwc-groupHead"><span class="gwc-groupTitle">本地分支</span></div>
    ${refRow({ name: 'main', head: true })}
    ${refRow({ name: 'feature/tag-ui' })}
  </div>
  <div class="gwc-group">
    <div class="gwc-groupHead"><span class="gwc-groupTitle">远程分支</span></div>
    ${refRow({ name: 'origin/main' })}
  </div>
  <div class="gwc-group">
    <div class="gwc-groupHead"><span class="gwc-groupTitle">标签</span></div>
    ${refRow({ name: 'release-demo', unpublished: true, showsPublish: true })}
    ${refRow({ name: 'v1.0.0', showsPublish: false })}
  </div>
</div>`

const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#0f1115;font-family:"Segoe UI",system-ui,sans-serif;padding:0;width:${width}px}
.wrap{height:760px;display:flex;flex-direction:column;background:#1a1d23}
${CSS}
/* In this preview the actions are always shown, so the screenshot does not
   depend on a hover a headless browser never performs. */
.gwc-branchRowActions{display:flex !important}
</style>
<div class="wrap gwc-root gwc-mode-columns">
  <div class="gwc-header">
    <div class="gwc-headerMain">
      <button class="gwc-repoChip">${icon('repo')}<span class="gwc-repoChipName">dsh-workbay</span>${icon('chevronDown', 11)}</button>
      <span class="gwc-branchIcon">${icon('branches')}</span>
      <span class="gwc-branchName">main</span>
      <span class="gwc-sync">领先 2 · 落后 1</span>
    </div>
    <div class="gwc-headerActions">
      <button class="gwc-iconBtn">${icon('refresh', 14)}</button>
      <button class="gwc-iconBtn">${icon('fetch', 14)}</button>
      <button class="gwc-iconBtn has-dot">${icon('pull', 14)}<span class="gwc-dot"></span></button>
      <button class="gwc-iconBtn has-dot">${icon('push', 14)}<span class="gwc-dot"></span></button>
    </div>
  </div>
  <div class="gwc-nav">
    ${navBtn('changes', '变更', !FILES_PAGE && !BRANCHES_PAGE, 7)}
    ${navBtn('search', '文件', FILES_PAGE)}
    ${navBtn('history', '历史')}
    ${navBtn('branches', '分支', BRANCHES_PAGE)}
    ${navBtn('stash', '贮藏')}
  </div>
  ${BRANCHES_PAGE ? `<div class="gwc-body">${branchesBody}</div>` : FILES_PAGE ? filesBody : `<div class="gwc-body">
    <div class="gwc-changesWrap">
      <div class="gwc-changeListPane is-solo">
        ${group('已暂存 (2)', '<button class="gwc-btn">全部取消暂存</button><button class="gwc-btn is-danger">全部撤销</button>',
          row('modified', 'M', 'index.ts', 'src/core', 12, 3) + row('added', 'A', 'App.tsx', 'src/ui', 48, 0))}
        ${group('更改 (3)', '<button class="gwc-btn">全部暂存</button><button class="gwc-btn is-danger">全部撤销</button>',
          row('modified', 'M', 'main.js', 'src', 5, 5, true) + row('deleted', 'D', 'old.js', 'src/legacy', 0, 31) + row('modified', 'M', 'styles.css', 'src/ui', 2, 1))}
        ${group('未跟踪 (2)', '',
          row('untracked', 'U', 'scratch.tmp', '', 3, 0) + row('untracked', 'U', 'notes.md', 'docs', 9, 0))}
      </div>
      <div class="gwc-commitBox">
        <textarea class="gwc-commitInput" placeholder="提交说明（Ctrl+Enter 提交）"></textarea>
        <div class="gwc-commitRow">
          <label class="gwc-check"><input type="checkbox"> 修正上次提交</label>
          <button class="gwc-btn is-primary">提交 2 个文件</button>
        </div>
      </div>
    </div>
  </div>`}
</div>`

const dir = mkdtempSync(path.join(tmpdir(), 'gwc-ui-'))
const file = path.join(dir, 'index.html')
const shotPath = path.join(dir, 'shot.png')
writeFileSync(file, html)
const url = 'file:///' + file.split(path.sep).join('/')

await new Promise((resolve) => {
  const child = spawn(browser, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--no-default-browser-check', '--force-device-scale-factor=2', `--window-size=${width},800`,
    '--virtual-time-budget=1500', `--screenshot=${shotPath}`, url,
  ], { stdio: 'ignore' })
  child.on('close', resolve)
})

mkdirSync(path.dirname(outFile), { recursive: true })
copyFileSync(shotPath, outFile)
console.log('wrote ' + outFile)
try { rmSync(dir, { recursive: true, force: true }) } catch { }
