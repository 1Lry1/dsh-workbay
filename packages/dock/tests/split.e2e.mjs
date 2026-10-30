/**
 * Browser verification of the three requirements from this round:
 *
 *   1. the entry button sits in the LEFT SIDEBAR'S TOP ROW (sidebar.panellist,
 *      next to 插件 / 自动化任务 / 更多) — not in the footer;
 *   2. the panel DOCKS on the right so the conversation and the workbench are
 *      visible and usable at the same time (split view);
 *   3. the repository picker takes a FULL PATH with live validation, the way
 *      SourceTree's "Add Working Copy" dialog does.
 *
 * Usage: node tests/split.e2e.mjs <base-url> <browser-exe> <repo-path> [shot.png]
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const [baseUrl, browser, repoPath, shotPath] = process.argv.slice(2)
if (baseUrl === undefined || browser === undefined || repoPath === undefined) {
  console.error('usage: node tests/split.e2e.mjs <base-url> <browser-exe> <repo-path> [shot.png]')
  process.exit(2)
}

const debugPort = 9900 + Math.floor(Math.random() * 50)
const profileDir = mkdtempSync(path.join(tmpdir(), 'split-e2e-'))
const child = spawn(browser, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${profileDir}`,
  '--window-size=1800,1000',
  'about:blank',
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function devtools() {
  for (let attempt = 0; attempt < 90; attempt += 1) {
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
  await send('Page.navigate', { url: baseUrl })
  await sleep(17000)
  await evaluate(`(() => {
    const dismiss = Array.from(document.querySelectorAll('button')).find((b) => (b.innerText || '').trim() === '继续')
    if (dismiss !== undefined) dismiss.click()
    return true
  })()`)
  await sleep(1500)

  /* ---- 1) entry position: top row of the left sidebar ---- */
  const entry = await evaluate(`(() => {
    const btn = document.querySelector('.wbd-entryBtn')
    if (btn === null) return { present: false }
    const rect = btn.getBoundingClientRect()
    /* The other rows in that seat: 插件 / 自动化任务 / 更多. */
    const peers = ['插件', '自动化任务', '更多', 'Plugins', 'Automations', 'More']
    const peerRects = []
    for (const el of document.querySelectorAll('button, [role="button"], a')) {
      const text = (el.innerText || '').trim()
      if (peers.includes(text)) {
        const r = el.getBoundingClientRect()
        if (r.width > 0 && r.height > 0) peerRects.push({ text, x: Math.round(r.x), y: Math.round(r.y) })
      }
    }
    return {
      present: true,
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      label: btn.getAttribute('aria-label') || btn.title || '',
      peers: peerRects,
      footerGone: document.querySelector('.wbd-footerBtn') === null,
    }
  })()`)
  record('the entry button exists', entry.present === true, JSON.stringify(entry).slice(0, 200))
  record('the old footer button is gone', entry.footerGone === true, JSON.stringify(entry.footerGone))
  record('the entry is in the LEFT sidebar (left third)',
    typeof entry.x === 'number' && entry.x < 200, 'x=' + entry.x)
  record('it sits in the same block as 插件 / 自动化任务 / 更多',
    Array.isArray(entry.peers) && entry.peers.length >= 2 && entry.peers.some((peer) => Math.abs(peer.x - entry.x) < 40),
    JSON.stringify(entry.peers))

  /* ---- 2) docked split view ---- */
  /* A REAL mouse click, not element.click(). The entry sits inside the host's
     own <button class="…panelRow">, and a nested <button> swallows real clicks
     while still answering synthetic ones — that bug shipped once and made the
     button look dead to the user while every test passed. */
  const entryPoint = await evaluate(`(() => {
    const el = document.querySelector('.wbd-entryBtn')
    if (el === null) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })()`)
  if (entryPoint !== null) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: entryPoint.x, y: entryPoint.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: entryPoint.x, y: entryPoint.y, button: 'left', clickCount: 1 })
    await sleep(3500)
  }

  const docked = await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const btn = document.querySelector('.wbd-entryBtn')
    if (btn === null) return { error: 'no entry button' }
    await sleep(3500)
    const docked = document.querySelector('.wbd-docked')
    const body = document.body
    const style = getComputedStyle(body)
    const dockRect = docked === null ? null : docked.getBoundingClientRect()
    /* The conversation must still be on screen and not covered by the dock. */
    const composer = document.querySelector('textarea, [class*="composer"]')
    const composerRect = composer === null ? null : composer.getBoundingClientRect()
    return {
      docked: docked !== null,
      overlay: document.querySelector('.wbd-overlay') !== null,
      width: dockRect === null ? 0 : Math.round(dockRect.width),
      rightEdge: dockRect === null ? 0 : Math.round(dockRect.right),
      viewport: window.innerWidth,
      bodyPadRight: style.paddingRight,
      composerVisible: composerRect !== null && composerRect.width > 0,
      composerRight: composerRect === null ? null : Math.round(composerRect.right),
      dockLeft: dockRect === null ? null : Math.round(dockRect.left),
      hasGitCraft: docked === null ? false : docked.innerHTML.indexOf('gwc-root') !== -1,
    }
  })()`)
  record('clicking the entry docks the panel (split view, not a floating overlay)',
    docked.docked === true && docked.overlay === false, JSON.stringify(docked).slice(0, 240))
  record('the dock takes the right edge of the viewport',
    docked.rightEdge === docked.viewport && docked.width >= 360,
    `right=${docked.rightEdge} viewport=${docked.viewport} width=${docked.width}`)
  record('the conversation keeps its own space (body padded by the dock width)',
    /px/.test(String(docked.bodyPadRight)) && parseFloat(docked.bodyPadRight) >= 360,
    'padding-right=' + docked.bodyPadRight)
  record('the conversation composer is still visible beside the dock',
    docked.composerVisible === true && docked.composerRight !== null && docked.composerRight <= docked.dockLeft + 4,
    JSON.stringify({ composerRight: docked.composerRight, dockLeft: docked.dockLeft }))
  record('the gitcraft page renders inside the docked column', docked.hasGitCraft === true, JSON.stringify(docked.hasGitCraft))

  /* ---- 3) picker: full-path entry with live validation (SourceTree shape) ---- */
  const picker = await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const chip = document.querySelector('.wbd-docked .gwc-repoChip')
    if (chip === null) return { error: 'no repo chip in docked panel' }
    chip.click()
    await sleep(2500)
    const input = document.querySelector('.gwc-lib-input')
    const openError = document.querySelector('.gwc-toast.is-error')
    return {
      opened: document.querySelector('.gwc-picker') !== null,
      hasPathInput: input !== null,
      tabs: Array.from(document.querySelectorAll('.gwc-pickerTab')).map((t) => (t.innerText || '').trim()),
      errorToast: openError === null ? '' : (openError.textContent || '').trim(),
    }
  })()`)
  record('the picker opens with a path field (SourceTree style)',
    picker.opened === true && picker.hasPathInput === true, JSON.stringify(picker).slice(0, 260))
  record('the picker no longer fails with "cwd or sessionId is required"',
    String(picker.errorToast) === '', JSON.stringify(picker.errorToast))

  const typed = await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const input = document.querySelector('.gwc-lib-input')
    if (input === null) return { error: 'no input' }
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(repoPath)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(4500)
    const verdict = document.querySelector('.gwc-lib-verdict')
    const addBtn = Array.from(document.querySelectorAll('.gwc-modalFoot button')).find((b) => /添加|Add/.test(b.innerText || ''))
    return {
      verdictClass: verdict === null ? '' : verdict.className,
      verdictText: verdict === null ? '' : (verdict.innerText || '').trim(),
      addEnabled: addBtn === undefined ? null : addBtn.disabled === false,
    }
  })()`)
  record('typing a repository path yields a positive verdict',
    /is-good/.test(String(typed.verdictClass)) === true, JSON.stringify(typed).slice(0, 260))
  record('the verdict names it as a Git repository',
    /Git 仓库|Git repository/i.test(String(typed.verdictText)), String(typed.verdictText))
  record('the Add button becomes enabled', typed.addEnabled === true, JSON.stringify(typed.addEnabled))

  const applied = await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const addBtn = Array.from(document.querySelectorAll('.gwc-modalFoot button')).find((b) => /添加|Add/.test(b.innerText || ''))
    if (addBtn === undefined) return { error: 'no add button' }
    addBtn.click()
    await sleep(4000)
    const chip = document.querySelector('.wbd-docked .gwc-repoChip')
    const root = document.querySelector('.wbd-docked .gwc-root')
    return {
      chip: chip === null ? '' : (chip.innerText || '').trim(),
      branch: root === null ? '' : ((root.querySelector('.gwc-branchName') || {}).textContent || '').trim(),
      text: root === null ? '' : (root.innerText || '').replace(/\\s+/g, ' ').slice(0, 160),
    }
  })()`)
  const expectedName = path.basename(repoPath).replace(/\\/g, '/')
  record('adding the path switches the panel to that repository',
    String(applied.chip).includes(expectedName), JSON.stringify({ expectedName, applied }).slice(0, 280))
  record('the panel reads the repository branch', /main/.test(String(applied.branch)), 'branch=' + applied.branch)

  if (shotPath !== undefined) {
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))
    console.log('  screenshot: ' + shotPath)
  }

  const consoleErrors = events.filter((event) =>
    event.method === 'Runtime.consoleAPICalled'
    && event.params.type === 'error'
    && (event.params.args || []).some((arg) => /workbench|gitcraft|dock/i.test(String(arg.value ?? arg.description ?? ''))))
  record('no plugin console error during the walk', consoleErrors.length === 0,
    consoleErrors.slice(0, 2).map((event) => (event.params.args || []).map((arg) => String(arg.value ?? '')).join(' ').slice(0, 180)).join(' | '))

  await send('Browser.close').catch(() => {})
} catch (error) {
  console.error('split e2e failed: ' + error.message)
  exitCode = 1
} finally {
  try { child.kill('SIGKILL') } catch { /* gone */ }
  await sleep(400)
  try { rmSync(profileDir, { recursive: true, force: true }) } catch { /* locked */ }
}

const failed = results.filter((entry) => entry.ok !== true)
console.log('')
console.log(`split e2e: ${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) exitCode = 1
process.exit(exitCode)
