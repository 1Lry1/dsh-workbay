/**
 * UI-level end-to-end check for the workbench pages, against a RUNNING DSH.
 *
 * It drives the real renderer over CDP (like the gitcraft e2e suites): opens the
 * workbench from the left sidebar, switches to Files, expands the tree, opens a
 * markdown file into the CodeMirror chunk, then switches to Terminal, starts a
 * session and runs a command.
 *
 * Usage:
 *   node packages/dock/tests/workbay-ui.e2e.mjs <base-url> <browser-exe> [root]
 *
 * <root> defaults to the current working directory. The script writes the root
 * into localStorage before opening the panel, which is how a user's choice is
 * persisted anyway.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const [baseUrl, browserExe, rootArg] = process.argv.slice(2)
if (baseUrl === undefined || browserExe === undefined) {
  console.error('usage: node packages/dock/tests/workbay-ui.e2e.mjs <base-url> <browser-exe> [root]')
  process.exit(2)
}
const root = path.resolve(rootArg === undefined ? process.cwd() : rootArg)
const debugPort = 9500 + Math.floor(Math.random() * 120)
const profileDir = mkdtempSync(path.join(tmpdir(), 'wbd-ui-e2e-'))
const shotDir = path.join(profileDir, 'shots')
mkdirSync(shotDir, { recursive: true })

const browser = spawn(browserExe, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--hide-scrollbars',
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${profileDir}`,
  '--window-size=1700,1000',
  'about:blank',
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function devtools() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${debugPort}/json/version`)
      if (res.ok) return
    } catch { /* not up yet */ }
    await sleep(250)
  }
  throw new Error('devtools never came up')
}

const results = []
function record(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || detail === undefined ? '' : '  — ' + detail))
}

let ws
let nextId = 1
const pending = new Map()
function send(method, params = {}) {
  const id = nextId
  nextId += 1
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  })
  if (result.exceptionDetails !== undefined) {
    throw new Error(result.exceptionDetails.text + ' ' + (result.exceptionDetails.exception?.description ?? ''))
  }
  return result.result?.value
}

async function waitFor(expression, timeoutMs = 30000, label = expression) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await evaluate(expression)) return true
    } catch { /* page may be navigating */ }
    await sleep(200)
  }
  throw new Error('timeout waiting for ' + label)
}

/** Click the centre of the first element matching a selector (real mouse events). */
async function clickSelector(selector, label = selector) {
  const rect = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (el === null) return null
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return null
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })()`)
  if (rect === null) throw new Error('element not visible: ' + label)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
}

/** Click an element whose trimmed text matches one of the given strings. */
async function clickText(selector, texts) {
  const rect = await evaluate(`(() => {
    const wanted = ${JSON.stringify(texts)}
    for (const el of document.querySelectorAll(${JSON.stringify(selector)})) {
      const text = (el.textContent || '').trim()
      if (!wanted.some((w) => text === w || text.includes(w))) continue
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    }
    return null
  })()`)
  if (rect === null) throw new Error('no ' + selector + ' with text ' + texts.join('/'))
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
}

async function type(text) {
  await send('Input.insertText', { text })
}

async function pressEnter() {
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, key: 'Enter', code: 'Enter' })
  await send('Input.dispatchKeyEvent', { type: 'char', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter', text: '\r' })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, key: 'Enter', code: 'Enter' })
}

async function shot(name) {
  try {
    const { data } = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(path.join(shotDir, name + '.png'), Buffer.from(data, 'base64'))
  } catch { /* screenshots are diagnostics only */ }
}

try {
  await devtools()
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()
  const page = targets.find((target) => target.type === 'page')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  ws.addEventListener('message', (event) => {
    const payload = JSON.parse(event.data)
    if (payload.id === undefined) return
    const waiter = pending.get(payload.id)
    if (waiter === undefined) return
    pending.delete(payload.id)
    if (payload.error !== undefined) waiter.reject(new Error(payload.error.message))
    else waiter.resolve(payload.result)
  })

  await send('Page.enable')
  await send('Runtime.enable')
  await send('Page.navigate', { url: baseUrl })
  await waitFor('document.readyState === "complete"', 60000, 'document ready')

  const escapedRoot = JSON.stringify(root)
  await evaluate(`localStorage.setItem('dsh-workbay.root.v1', ${escapedRoot})`)
  await send('Page.reload', { ignoreCache: false })
  await waitFor('document.readyState === "complete"', 60000, 'reload')

  /* The dock entry lives in the left sidebar; it may appear after the shell boots. */
  await waitFor('document.querySelector(".wbd-entryBtn") !== null', 60000, 'workbench entry')
  record('dock entry is present', true)

  await clickSelector('.wbd-entryBtn', 'dock entry')
  await waitFor('document.querySelector(".wbd-titlebar") !== null', 20000, 'workbench panel')
  await shot('01-panel-open')
  const tabLabels = await evaluate('[...document.querySelectorAll(".wbd-tabLabel")].map((el) => el.textContent.trim())')
  record('all four page tabs are registered',
    Array.isArray(tabLabels) && tabLabels.length >= 4, JSON.stringify(tabLabels))

  /* ---------- files ---------- */
  await clickText('.wbd-tab', ['文件', 'Files'])
  await waitFor('document.querySelector(".wbf-row") !== null', 30000, 'file tree rows')
  await sleep(500)
  const treeNames = await evaluate('[...document.querySelectorAll(".wbf-rowName")].map((el) => el.textContent.trim())')
  record('file tree lists the workspace', Array.isArray(treeNames) && treeNames.length > 0, `${treeNames?.length} rows`)
  record('tree contains README.md', Array.isArray(treeNames) && treeNames.includes('README.md'), JSON.stringify(treeNames?.slice(0, 8)))

  await clickText('.wbf-row', ['README.md'])
  await waitFor('document.querySelector(".cm-editor") !== null || document.querySelector(".wbf-note.is-error") !== null', 30000, 'editor chunk')
  const editorText = await evaluate('document.querySelector(".cm-content")?.textContent ?? ""')
  record('CodeMirror chunk mounted', (await evaluate('document.querySelector(".cm-editor") !== null')) === true)
  record('markdown content rendered', String(editorText).includes('dsh-workbay'), String(editorText).slice(0, 60))
  await shot('02-files-readme')

  /* ---------- terminal ---------- */
  await clickText('.wbd-tab', ['终端', 'Terminal'])
  await waitFor('document.querySelector(".dswt-root") !== null', 30000, 'terminal page')
  await clickText('.dswt-btn', ['启动', 'Start'])
  await waitFor('document.querySelector(".dswt-input") !== null && document.querySelector(".dswt-input").disabled !== true', 30000, 'terminal started')
  await evaluate('document.querySelector(".dswt-input").focus()')
  await type('echo workbay-ui-ok')
  await pressEnter()
  const marker = await (async () => {
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      const text = await evaluate('[...document.querySelectorAll(".dswt-line")].map((el) => el.textContent).join("\\n")')
      if (String(text).includes('workbay-ui-ok')) return true
      await sleep(300)
    }
    return false
  })()
  record('terminal executes a command and shows output', marker === true)
  await shot('03-terminal')

  /* ---------- other pages still alive ---------- */
  const labelsNow = await evaluate('[...document.querySelectorAll(".wbd-tabLabel")].map((el) => el.textContent.trim())')
  record('tab strip still healthy after switching', Array.isArray(labelsNow) && labelsNow.length >= 4, JSON.stringify(labelsNow))
} catch (error) {
  record('fatal: ' + error.message, false)
  await shot('99-failure')
} finally {
  const failures = results.filter((entry) => entry.ok !== true).length
  console.log(`\n${results.length - failures}/${results.length} checks passed`)
  if (shotDir !== undefined) console.log('screenshots: ' + shotDir)
  try { ws?.close() } catch { /* ignore */ }
  try { browser.kill() } catch { /* ignore */ }
  await sleep(500)
  try { rmSync(profileDir, { recursive: true, force: true }) } catch { /* locked files on Windows */ }
  process.exitCode = failures === 0 ? 0 : 1
}
