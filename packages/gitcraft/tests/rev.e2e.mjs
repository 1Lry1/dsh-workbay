/**
 * Regression e2e for "rev is required".
 *
 * The panel used to call the commit-scoped diff WITHOUT a rev while browsing a
 * commit's file list, and the host answered `rev is required` — surfaced to the
 * user as a "操作失败" toast. This test drives exactly that path:
 *
 *   History tab → select a commit → click a changed file → read the diff
 *
 * and asserts the diff renders (no error toast, no request without a rev).
 *
 * Usage: node tests/rev.e2e.mjs <base-url> <browser-exe> <repo-dir> [shot.png]
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const [baseUrl, browser, repo, shotPath] = process.argv.slice(2)
if (baseUrl === undefined || browser === undefined || repo === undefined) {
  console.error('usage: node tests/rev.e2e.mjs <base-url> <browser-exe> <repo-dir> [shot.png]')
  process.exit(2)
}

const debugPort = 9700 + Math.floor(Math.random() * 60)
const profileDir = mkdtempSync(path.join(tmpdir(), 'rev-e2e-'))
const child = spawn(browser, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${profileDir}`,
  '--window-size=1760,1040',
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

  /* Record every diff request the panel makes, so a rev-less commit diff is
     visible even if the UI swallowed the failure. */
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      (function () {
        var repo = ${JSON.stringify(repo)}
        /* The panel only loads a repository when one is selected (the dock has no
           session scope), so seed the stored choice before anything runs. */
        try { window.localStorage.setItem('dsh-gitcraft.ref.v1', JSON.stringify({ path: repo })) } catch (e) {}
        window.__GWC_REQUESTS__ = []
        var original = window.fetch
        window.fetch = function (url, init) {
          try {
            var name = String(url)
            if (name.indexOf('dsh-gitcraft/api/') !== -1 && init && typeof init.body === 'string') {
              var body = JSON.parse(init.body)
              if (body.cwd === undefined) body.cwd = repo
              if (body.repoRoot === undefined) body.repoRoot = repo
              window.__GWC_REQUESTS__.push({ method: name.split('/').pop(), body: body })
              init = Object.assign({}, init, { body: JSON.stringify(body) })
            }
          } catch (error) {}
          return original.apply(this, arguments)
        }
      })()
    `,
  })

  await send('Page.navigate', { url: baseUrl })
  await sleep(15000)
  await evaluate(`(() => {
    const dismiss = Array.from(document.querySelectorAll('button')).find((b) => (b.innerText || '').trim() === '继续')
    if (dismiss !== undefined) dismiss.click()
    return true
  })()`)
  await sleep(1000)

  /* Open the panel through the LEFT SIDEBAR entry (the header button is gone),
     then switch to History. */
  const rowPoint = await evaluate(`(() => {
    const el = document.querySelector('.wbd-entryBtn')
    if (el === null) return null
    let row = el.parentElement
    while (row !== null && row.getBoundingClientRect().width < 120) row = row.parentElement
    if (row === null) return null
    const r = row.getBoundingClientRect()
    return { x: Math.round(r.x + r.width * 0.8), y: Math.round(r.y + r.height / 2) }
  })()`)
  if (rowPoint !== null) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rowPoint.x, y: rowPoint.y })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rowPoint.x, y: rowPoint.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rowPoint.x, y: rowPoint.y, button: 'left', clickCount: 1 })
  }
  /* wait for the panel to hold a repository before switching tabs */
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const ready = await evaluate(`(() => document.querySelectorAll('.gwc-changeRow').length > 0)()`)
    if (ready === true) break
    await sleep(600)
  }

  const opened = await evaluate(`(() => document.querySelectorAll('.gwc-root').length)()`)
  record('the gitcraft panel is open', opened === 1, 'panels=' + opened)

  /* Switch to the History tab and pick a commit. */
  const history = await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const tab = Array.from(document.querySelectorAll('.gwc-navBtn')).find((t) => /历史|History/.test(t.innerText || ''))
    if (tab === undefined) return { error: 'no history tab' }
    tab.click()
    /* git log takes seconds on this machine: poll instead of a fixed wait */
    for (let attempt = 0; attempt < 25; attempt += 1) {
      await sleep(600)
      if (document.querySelectorAll('.gwc-commitRow').length > 0) break
    }
    const rows = document.querySelectorAll('.gwc-commitRow')
    if (rows.length === 0) return { error: 'no commits' }
    rows[0].click()
    await sleep(3500)
    return { rows: rows.length, files: document.querySelectorAll('.gwc-commitDetail .gwc-changeRow').length }
  })()`)
  record('a commit is selected and its file list is shown', history.files >= 1, JSON.stringify(history))

  /* THE REGRESSION: click a file in the commit's file list. */
  const diff = await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const file = document.querySelector('.gwc-commitDetail .gwc-changeRow')
    if (file === null) return { error: 'no file row' }
    const label = (file.innerText || '').trim()
    file.click()
    await sleep(4000)
    const root = document.querySelector('.gwc-root')
    const toast = root === null ? '' : (root.querySelector('.gwc-toast.is-error') || {}).textContent || ''
    return {
      label,
      errorToast: String(toast).trim(),
      hasDiff: root === null ? false : root.querySelectorAll('.gwc-hunk').length > 0,
      diffText: root === null ? '' : (root.querySelector('.gwc-diff') || {}).textContent || '',
    }
  })()`)
  record('clicking a commit file shows its diff (no "rev is required")',
    diff.hasDiff === true && String(diff.errorToast) === '',
    JSON.stringify({ label: diff.label, error: diff.errorToast, hasDiff: diff.hasDiff }).slice(0, 300))

  /* And the request itself must have carried a rev. */
  const requests = await evaluate(`(() => {
    const list = window.__GWC_REQUESTS__ || []
    return list.filter((entry) => entry.method === 'diff')
  })()`)
  const commitDiffs = requests.filter((entry) => entry.body !== undefined && entry.body.base === 'commit')
  record('every commit-scoped diff request carried a rev',
    commitDiffs.length >= 1 && commitDiffs.every((entry) => typeof entry.body.rev === 'string' && entry.body.rev !== ''),
    JSON.stringify(commitDiffs.map((entry) => entry.body)).slice(0, 300))

  const runtimeErrors = events.filter((event) =>
    event.method === 'Runtime.consoleAPICalled'
    && event.params.type === 'error'
    && (event.params.args || []).some((arg) => /rev is required|gitcraft/i.test(String(arg.value ?? arg.description ?? ''))))
  record('no rev/resolution error was logged', runtimeErrors.length === 0,
    runtimeErrors.slice(0, 2).map((event) => (event.params.args || []).map((arg) => String(arg.value ?? '')).join(' ').slice(0, 180)).join(' | '))

  if (shotPath !== undefined) {
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))
    console.log('  screenshot: ' + shotPath)
  }

  await send('Browser.close').catch(() => {})
} catch (error) {
  console.error('rev e2e failed: ' + error.message)
  exitCode = 1
} finally {
  try { child.kill('SIGKILL') } catch { /* gone */ }
  await sleep(400)
  try { rmSync(profileDir, { recursive: true, force: true }) } catch { /* locked */ }
}

const failed = results.filter((entry) => entry.ok !== true)
console.log('')
console.log(`rev e2e: ${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) exitCode = 1
process.exit(exitCode)
