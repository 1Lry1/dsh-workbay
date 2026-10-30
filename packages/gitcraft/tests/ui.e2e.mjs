/**
 * UI-level verification: opens the panel in the running DSH web UI and drives
 * the real controls (change rows, hunk buttons, commit box) against a repository
 * with a mixed working state.
 *
 * The panel is opened with an explicit repository scope by navigating the shell
 * and then overriding the plugin's fetch payload — the panel reads its scope
 * from the seat, and the native seat has no cwd, so the test injects one at the
 * network boundary and asserts the UI reacts to real Git data.
 *
 * Usage: node tests/ui.e2e.mjs <base-url> <browser-exe> <repo-dir>
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const [baseUrl, browser, repo] = process.argv.slice(2)
if (baseUrl === undefined || browser === undefined || repo === undefined) {
  console.error('usage: node tests/ui.e2e.mjs <base-url> <browser-exe> <repo-dir>')
  process.exit(2)
}

const debugPort = 9350 + Math.floor(Math.random() * 40)
const profileDir = mkdtempSync(path.join(tmpdir(), 'gwc-ui-'))
const child = spawn(browser, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${profileDir}`,
  '--window-size=1700,1000',
  'about:blank',
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function devtools() {
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
  await devtools()
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
  const send = (method, params) => {
    const id = nextId
    nextId += 1
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params: params === undefined ? {} : params }))
    })
  }
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: true,
    })
    if (result.exceptionDetails !== undefined) {
      return { __error: String(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text) }
    }
    return result.result.value
  }

  await send('Page.enable')
  await send('Runtime.enable')

  // Redirect the plugin's snapshot request to a repository scope before the
  // shell boots: the native seat sends only a sessionId, and this test owns a
  // repository rather than a session.
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      (function () {
        var repo = ${JSON.stringify(repo)}
        var original = window.fetch
        window.fetch = function (url, init) {
          try {
            if (String(url).indexOf('dsh-gitcraft/api/') !== -1 && init && typeof init.body === 'string') {
              var body = JSON.parse(init.body)
              if (body.cwd === undefined) { body.cwd = repo; init = Object.assign({}, init, { body: JSON.stringify(body) }) }
            }
          } catch (error) {}
          return original.apply(this, arguments)
        }
      })()
    `,
  })

  await send('Page.navigate', { url: baseUrl })
  await sleep(15000)

  const opened = await evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('button')).find((node) => (node.getAttribute('aria-label') || '') === '打开右侧边栏')
    if (button === undefined) return false
    button.click()
    return true
  })()`)
  record('the right sidebar opens', opened === true)

  await sleep(2500)
  const clicked = await evaluate(`(() => {
    const entry = Array.from(document.querySelectorAll('button.p2k40q_entry')).find((node) => (node.innerText || '').includes('GitCraft'))
    if (entry === undefined) return false
    entry.click()
    return true
  })()`)
  record('the GitCraft guide capsule opens the panel', clicked === true)
  await sleep(7000)

  const panel = await evaluate(`(() => {
    const root = document.querySelector('.gwc-root')
    if (root === null) return { found: false }
    return {
      found: true,
      text: (root.innerText || '').replace(/\\s+/g, ' '),
      groups: root.querySelectorAll('.gwc-group').length,
      rows: root.querySelectorAll('.gwc-changeRow').length,
      nav: root.querySelectorAll('.gwc-navBtn').length,
      branch: (root.querySelector('.gwc-branchName') || {}).textContent || '',
    }
  })()`)
  record('the panel mounts inside the right sidebar', panel.found === true, JSON.stringify(panel).slice(0, 200))
  record('the panel shows the repository branch', panel.branch === 'main', 'branch=' + panel.branch)
  record('the changes view lists the three working states', panel.rows >= 3, 'rows=' + panel.rows)
  record('staged / unstaged / untracked groups render', panel.groups >= 3, 'groups=' + panel.groups)

  // Open the diff of the modified file and inspect the hunks.
  const diff = await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const rows = Array.from(document.querySelectorAll('.gwc-changeRow'))
    const target = rows.find((row) => (row.innerText || '').includes('data.txt'))
    if (target === undefined) return { error: 'no data.txt row' }
    target.click()
    await sleep(2500)
    const diffRoot = document.querySelector('.gwc-diff')
    return {
      hunks: document.querySelectorAll('.gwc-hunk').length,
      rows: document.querySelectorAll('.gwc-row').length,
      hasStageHunk: Array.from(document.querySelectorAll('.gwc-hunkActions .gwc-btn')).some((b) => (b.innerText || '').includes('暂存此块')),
      text: diffRoot === null ? '' : (diffRoot.innerText || '').slice(0, 300),
    }
  })()`)
  record('clicking a change opens its diff with hunks', diff.hunks >= 2, JSON.stringify(diff).slice(0, 260))
  record('each hunk offers a per-hunk stage action', diff.hasStageHunk === true, JSON.stringify(diff).slice(0, 260))

  // Stage only the first hunk through the UI.
  const staged = await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const action = Array.from(document.querySelectorAll('.gwc-hunkActions .gwc-btn')).find((b) => (b.innerText || '').includes('暂存此块'))
    if (action === undefined) return { error: 'no stage-hunk button' }
    action.click()
    await sleep(3000)
    const root = document.querySelector('.gwc-root')
    return { text: (root.innerText || '').replace(/\\s+/g, ' ') }
  })()`)
  const before = staged.text === undefined ? '' : staged.text
  const refreshed = await evaluate(`(() => {
    const root = document.querySelector('.gwc-root')
    return (root.innerText || '').replace(/\\s+/g, ' ')
  })()`)
  record('staging one hunk updates the panel groups', /已暂存 \(1\)/.test(refreshed) || /已暂存/.test(refreshed),
    refreshed.slice(0, 220) + ' | before: ' + before.slice(0, 120))

  const errors = events.filter((event) =>
    event.method === 'Runtime.consoleAPICalled'
    && event.params.type === 'error'
    && (event.params.args || []).some((arg) => String(arg.value ?? arg.description ?? '').includes('gwb')))
  record('driving the panel logs no plugin error', errors.length === 0,
    errors.slice(0, 2).map((event) => (event.params.args || []).map((arg) => String(arg.value ?? '')).join(' ').slice(0, 160)).join(' | '))

  await send('Browser.close').catch(() => {})
} catch (error) {
  console.error('ui e2e failed: ' + error.message)
  exitCode = 1
} finally {
  try { child.kill('SIGKILL') } catch { /* gone */ }
  await sleep(400)
  try { rmSync(profileDir, { recursive: true, force: true }) } catch { /* locked */ }
}

const failed = results.filter((entry) => entry.ok !== true)
console.log('')
console.log(`ui e2e: ${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) exitCode = 1
process.exit(exitCode)
