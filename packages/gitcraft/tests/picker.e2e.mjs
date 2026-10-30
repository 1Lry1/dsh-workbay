/**
 * UI verification of the repository picker: the panel must be able to point at
 * ANY repository in the workspace, not only the one the session cwd sits in.
 *
 * Usage: node tests/picker.e2e.mjs <base-url> <browser-exe> <workspace-dir>
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const [baseUrl, browser, workspace, shotPath] = process.argv.slice(2)
if (baseUrl === undefined || browser === undefined || workspace === undefined) {
  console.error('usage: node tests/picker.e2e.mjs <base-url> <browser-exe> <workspace-dir> [shot.png]')
  process.exit(2)
}

const debugPort = 9400 + Math.floor(Math.random() * 60)
const profileDir = mkdtempSync(path.join(tmpdir(), 'gwc-pick-'))
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

  /* Point the panel's requests at the workspace: the native seat sends a
     sessionId, and this test owns a directory tree rather than a session. */
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      (function () {
        var workspace = ${JSON.stringify(workspace)}
        var original = window.fetch
        window.fetch = function (url, init) {
          try {
            if (String(url).indexOf('dsh-gitcraft/api/') !== -1 && init && typeof init.body === 'string') {
              var body = JSON.parse(init.body)
              if (body.cwd === undefined && body.sessionId !== undefined) { body.cwd = workspace; delete body.sessionId }
              if (body.cwd === undefined) body.cwd = workspace
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
  await sleep(1200)
  await evaluate(`(() => {
    const open = Array.from(document.querySelectorAll('button')).find((b) => (b.getAttribute('aria-label') || '') === '打开右侧边栏')
    if (open !== undefined) open.click()
    return true
  })()`)
  await sleep(2500)
  await evaluate(`(() => {
    const entry = Array.from(document.querySelectorAll('button.p2k40q_entry')).find((node) => (node.innerText || '').includes('GitCraft'))
    if (entry !== undefined) entry.click()
    return true
  })()`)
  await sleep(6000)

  const header = await evaluate(`(() => {
    const chip = document.querySelector('.gwc-repoChip')
    if (chip === null) return { found: false }
    return { found: true, text: (chip.innerText || '').trim(), title: chip.getAttribute('title') }
  })()`)
  record('the header shows a repository chip', header.found === true, JSON.stringify(header))

  /* Open the picker. */
  const opened = await evaluate(`(() => {
    const chip = document.querySelector('.gwc-repoChip')
    if (chip === null) return 'no-chip'
    chip.click()
    return 'clicked'
  })()`)
  await sleep(3000)
  const picker = await evaluate(`(() => {
    const list = document.querySelector('.gwc-pickerList')
    if (list === null) return { open: false }
    const rows = Array.from(document.querySelectorAll('.gwc-repoRow')).map((row) => (row.innerText || '').trim())
    return { open: true, rows, tabs: Array.from(document.querySelectorAll('.gwc-pickerTab')).map((tab) => (tab.innerText || '').trim()) }
  })()`)
  record('the repository picker opens from the header chip', picker.open === true, opened)
  record('the scan lists every repository in the workspace (not only the cwd)',
    Array.isArray(picker.rows) && picker.rows.some((row) => row.includes('libs/ui')),
    JSON.stringify(picker.rows))
  record('noise directories are absent from the scan',
    Array.isArray(picker.rows) && picker.rows.some((row) => row.includes('node_modules')) === false,
    JSON.stringify(picker.rows))

  /* Pick a DIFFERENT repository than the workspace default and assert the panel follows. */
  const switched = await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const row = Array.from(document.querySelectorAll('.gwc-repoRow')).find((node) => (node.innerText || '').includes('libs/ui'))
    if (row === undefined) return { error: 'no libs/ui row' }
    row.click()
    await sleep(3500)
    const chip = document.querySelector('.gwc-repoChip')
    const root = document.querySelector('.gwc-root')
    return {
      chip: chip === null ? '' : (chip.innerText || '').trim(),
      text: root === null ? '' : (root.innerText || '').replace(/\\s+/g, ' ').slice(0, 260),
    }
  })()`)
  record('picking another repository switches the panel to it',
    switched.chip !== undefined && switched.chip.includes('ui'),
    JSON.stringify(switched).slice(0, 300))
  record('the panel now reads the picked repository (clean tree)',
    switched.text !== undefined && (/工作区干净|没有未提交的变更|No uncommitted|Working tree clean/.test(switched.text) || switched.text.includes('ui')),
    String(switched.text).slice(0, 220))

  /* Browse mode: drill into libs/ and confirm both repositories are marked. */
  const browse = await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const chip = document.querySelector('.gwc-repoChip')
    if (chip === null) return { error: 'no chip' }
    chip.click()
    await sleep(2500)
    const tab = Array.from(document.querySelectorAll('.gwc-pickerTab')).find((node) => (node.innerText || '').includes('浏览'))
      || Array.from(document.querySelectorAll('.gwc-pickerTab'))[1]
    if (tab === undefined) return { error: 'no browse tab' }
    tab.click()
    await sleep(2500)
    const libs = Array.from(document.querySelectorAll('.gwc-repoRow')).find((node) => (node.innerText || '').trim() === 'libs')
    if (libs === undefined) return { error: 'no libs folder', rows: Array.from(document.querySelectorAll('.gwc-repoRow')).map((r) => (r.innerText || '').trim()) }
    libs.click()
    await sleep(3000)
    return { rows: Array.from(document.querySelectorAll('.gwc-repoRow')).map((node) => (node.innerText || '').trim()) }
  })()`)
  record('browse mode drills into a folder and marks its repositories',
    Array.isArray(browse.rows) && browse.rows.some((row) => row.includes('core')) && browse.rows.some((row) => row.includes('ui')),
    JSON.stringify(browse).slice(0, 260))

  if (shotPath !== undefined) {
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))
    console.log('  screenshot: ' + shotPath)
  }

  const errors = events.filter((event) =>
    event.method === 'Runtime.consoleAPICalled'
    && event.params.type === 'error'
    && (event.params.args || []).some((arg) => String(arg.value ?? arg.description ?? '').includes('gwb')))
  record('driving the picker logs no plugin error', errors.length === 0,
    errors.slice(0, 2).map((event) => (event.params.args || []).map((arg) => String(arg.value ?? '')).join(' ').slice(0, 160)).join(' | '))

  await send('Browser.close').catch(() => {})
} catch (error) {
  console.error('picker e2e failed: ' + error.message)
  exitCode = 1
} finally {
  try { child.kill('SIGKILL') } catch { /* gone */ }
  await sleep(400)
  try { rmSync(profileDir, { recursive: true, force: true }) } catch { /* locked */ }
}

const failed = results.filter((entry) => entry.ok !== true)
console.log('')
console.log(`picker e2e: ${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) exitCode = 1
process.exit(exitCode)
