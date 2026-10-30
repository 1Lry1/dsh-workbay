/**
 * Regression e2e for the History tab.
 *
 * The History tab once threw
 *   "Cannot access 'historyLayout' before initialization"
 * because the view read a `const` declared 39 lines BELOW it. This test drives
 * the real UI: open the panel, click 历史/History, and assert the tab renders
 * rows (not an error boundary), with no plugin console error.
 *
 * Usage: node tests/history.e2e.mjs <base-url> <browser-exe> <repo-dir>
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const [baseUrl, browser, repo, shotPath] = process.argv.slice(2)
if (baseUrl === undefined || browser === undefined || repo === undefined) {
  console.error('usage: node tests/history.e2e.mjs <base-url> <browser-exe> <repo-dir> [shot.png]')
  process.exit(2)
}

const debugPort = 9500 + Math.floor(Math.random() * 60)
const profileDir = mkdtempSync(path.join(tmpdir(), 'gc-hist-'))
const child = spawn(browser, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${profileDir}`,
  '--window-size=1760,1040',
  'about:blank',
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForDevtools() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${debugPort}/json/version`)
      if (res.ok) return
    } catch { /* not up */ }
    await sleep(300)
  }
  throw new Error('devtools never came up')
}

const results = []
function record(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || detail === undefined ? '' : ' — ' + detail))
}

let exitCode = 0
try {
  await waitForDevtools()
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()
  const page = targets.find((target) => target.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve) => ws.addEventListener('open', resolve))
  let nextId = 1
  const pending = new Map()
  const events = []
  ws.addEventListener('message', (event) => {
    const payload = JSON.parse(event.data)
    if (payload.id !== undefined && pending.has(payload.id)) {
      const { resolve, reject } = pending.get(payload.id)
      pending.delete(payload.id)
      if (payload.error !== undefined) reject(new Error(payload.error.message))
      else resolve(payload.result)
      return
    }
    events.push(payload)
  })
  const sendRaw = (method, params) => {
    const id = nextId
    nextId += 1
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params: params === undefined ? {} : params }))
    })
  }
  const evaluate = async (expression) => {
    const result = await sendRaw('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: true,
    })
    if (result.exceptionDetails !== undefined) {
      return { __error: String(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text) }
    }
    return result.result.value
  }

  await sendRaw('Page.enable')
  await sendRaw('Runtime.enable')

  /* Point the panel at the repository: the native seat sends a sessionId and
     this test owns a repository instead. */
  await sendRaw('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      (function () {
        var repo = ${JSON.stringify(repo)}
        var original = window.fetch
        window.fetch = function (url, init) {
          try {
            if (String(url).indexOf('dsh-gitcraft/api/') !== -1 && init && typeof init.body === 'string') {
              var body = JSON.parse(init.body)
              if (body.cwd === undefined) { body.cwd = repo; delete body.sessionId }
              init = Object.assign({}, init, { body: JSON.stringify(body) })
            }
          } catch (error) {}
          return original.apply(this, arguments)
        }
      })()
    `,
  })

  await sendRaw('Page.navigate', { url: baseUrl })
  await sleep(15000)
  await evaluate(`(() => {
    const dismiss = Array.from(document.querySelectorAll('button')).find((b) => (b.innerText || '').trim() === '继续')
    if (dismiss !== undefined) dismiss.click()
    return true
  })()`)
  await sleep(1000)
  await evaluate(`(() => {
    const open = Array.from(document.querySelectorAll('button')).find((b) => (b.getAttribute('aria-label') || '') === '打开右侧边栏')
    if (open !== undefined) open.click()
    return true
  })()`)
  await sleep(2500)
  const opened = await evaluate(`(() => {
    const entry = Array.from(document.querySelectorAll('button.p2k40q_entry')).find((node) => (node.innerText || '').includes('GitCraft'))
      || Array.from(document.querySelectorAll('button.p2k40q_entry')).find((node) => (node.innerText || '').includes('Git'))
    if (entry === undefined) return false
    entry.click()
    return true
  })()`)
  record('the panel opens from the guide', opened === true)
  await sleep(6000)

  const before = events.length
  /* Click the History tab — the exact action that used to crash. */
  const clicked = await evaluate(`(() => {
    const tabs = Array.from(document.querySelectorAll('.gwc-navBtn'))
    const history = tabs.find((node) => /历史|History/.test(node.innerText || ''))
    if (history === undefined) return { error: 'no history tab', tabs: tabs.map((t) => (t.innerText || '').trim()) }
    history.click()
    return { clicked: true }
  })()`)
  record('the History tab is present and clickable', clicked.clicked === true, JSON.stringify(clicked))
  await sleep(4500)

  const history = await evaluate(`(() => {
    const root = document.querySelector('.gwc-root')
    if (root === null) return { error: 'panel gone' }
    return {
      rows: root.querySelectorAll('.gwc-commitRow').length,
      graph: root.querySelectorAll('.gwc-graph').length,
      listPresent: root.querySelector('.gwc-commitList') !== null,
      hasErrorBoundary: /initialization|ReferenceError|崩溃|crashed/i.test(root.innerText || ''),
      text: (root.innerText || '').replace(/\\s+/g, ' ').slice(0, 260),
    }
  })()`)
  record('the History tab renders commit rows without crashing',
    history.rows !== undefined && history.rows >= 1,
    JSON.stringify(history).slice(0, 300))
  record('the commit graph column is drawn', history.graph !== undefined && history.graph >= 1, 'graph=' + history.graph)
  record('no TDZ / crash text in the panel', history.hasErrorBoundary === false, String(history.text).slice(0, 200))

  const errors = events.slice(before).filter((event) =>
    event.method === 'Runtime.consoleAPICalled'
    && event.params.type === 'error'
    && (event.params.args || []).some((arg) => /initialization|gitcraft|historyLayout/i.test(String(arg.value ?? arg.description ?? ''))))
  record('clicking History logs no initialization error', errors.length === 0,
    errors.slice(0, 2).map((event) => (event.params.args || []).map((arg) => String(arg.value ?? '')).join(' ').slice(0, 200)).join(' | '))

  if (shotPath !== undefined) {
    const shot = await sendRaw('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))
    console.log('  screenshot: ' + shotPath)
  }

  await sendRaw('Browser.close').catch(() => {})
} catch (error) {
  console.error('history e2e failed: ' + error.message)
  exitCode = 1
} finally {
  try { child.kill('SIGKILL') } catch { /* gone */ }
  await sleep(400)
  try { rmSync(profileDir, { recursive: true, force: true }) } catch { /* locked */ }
}

const failed = results.filter((entry) => entry.ok !== true)
console.log('')
console.log(`history e2e: ${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) exitCode = 1
process.exit(exitCode)
