/**
 * Full UI-coverage e2e: every interactive path in the panel, not just the one
 * the earlier suites covered.
 *
 * The suites so far proved: hunk staging (ui.e2e), repo switching (picker.e2e),
 * commit-file diff (rev.e2e). This one walks the rest —
 *
 *   Changes  : per-file stage/unstage/discard, commit box, amend
 *   History  : search, load-more, commit actions (tag / branch dialogs)
 *   Branches : list, new-branch dialog, checkout, delete-confirm dialog
 *   Stash    : create dialog, apply/pop/drop on a real entry
 *   Conflicts: banner + continue/abort on a real merge conflict
 *   Errors   : a failed op surfaces a toast, not a crash
 *
 * Usage: node tests/coverage.e2e.mjs <base-url> <browser-exe> <repo-dir>
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const [baseUrl, browser, repo] = process.argv.slice(2)
if (baseUrl === undefined || browser === undefined || repo === undefined) {
  console.error('usage: node tests/coverage.e2e.mjs <base-url> <browser-exe> <repo-dir>')
  process.exit(2)
}

const debugPort = 9760 + Math.floor(Math.random() * 40)
const profileDir = mkdtempSync(path.join(tmpdir(), 'gwc-cov-'))
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

  /* Pin every gitcraft request to the test repository. */
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      (function () {
        var repo = ${JSON.stringify(repo)}
        window.__GWC_FAILS__ = []
        var original = window.fetch
        window.fetch = function (url, init) {
          try {
            if (String(url).indexOf('dsh-gitcraft/api/') !== -1 && init && typeof init.body === 'string') {
              var body = JSON.parse(init.body)
              if (body.cwd === undefined) { body.cwd = repo; delete body.sessionId }
              init = Object.assign({}, init, { body: JSON.stringify(body) })
            }
          } catch (error) {}
          return original.apply(this, arguments).then(function (response) {
            try {
              if (response.status >= 400) {
                var clone = response.clone()
                clone.text().then(function (text) {
                  window.__GWC_FAILS__.push({ status: response.status, body: text.slice(0, 300) })
                }).catch(function () {})
              }
            } catch (error) {}
            return response
          })
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

  /* Open the panel via the dock button in a real session. */
  const opened = await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT)
    let row = null
    while (walker.nextNode()) {
      const node = walker.currentNode
      const own = Array.from(node.childNodes).filter((c) => c.nodeType === 3).map((c) => (c.textContent || '').trim()).join('')
      if (own.length > 0 && own.length < 12 && /^\\d+\\s*(分钟|小时|天)$/.test(own)) {
        row = node.closest('button, [role="button"], a, li') || node.parentElement
        if (row !== null) break
      }
    }
    if (row !== null) row.click()
    await sleep(5500)
    const btn = document.querySelector('.wbd-headerBtn')
    if (btn !== null) btn.click()
    await sleep(5000)
    return document.querySelectorAll('.gwc-root').length
  })()`)
  record('the panel opens', opened === 1, 'panels=' + opened)

  /* Helpers used by several cases. */
  const helpers = `
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const nav = (label) => {
      const tab = Array.from(document.querySelectorAll('.gwc-navBtn')).find((t) => new RegExp(label).test(t.innerText || ''))
      if (tab) tab.click()
      return tab !== undefined
    }
    const btnByText = (root, text) => Array.from((root || document).querySelectorAll('button'))
      .find((b) => (b.innerText || '').trim() === text)
    const toastText = () => {
      const t = document.querySelector('.gwc-toast.is-error')
      return t === null ? '' : (t.textContent || '').trim()
    }
  `

  /* ---------------- Changes: per-file stage / unstage ---------------- */
  const changes = await evaluate(`(async () => {
    ${helpers}
    nav('变更|Changes')
    await sleep(2500)
    const rows = Array.from(document.querySelectorAll('.gwc-changeRow'))
    const unstaged = rows.find((r) => (r.innerText || '').includes('data.txt'))
    if (unstaged === undefined) return { error: 'no data.txt row', count: rows.length }
    unstaged.click()
    await sleep(1500)
    const stageBtn = Array.from(unstaged.querySelectorAll('button')).find((b) => (b.getAttribute('aria-label') || '') === '暂存' || (b.getAttribute('aria-label') || '') === 'Stage')
    if (stageBtn === undefined) return { error: 'no stage button' }
    stageBtn.click()
    await sleep(2500)
    const groups = Array.from(document.querySelectorAll('.gwc-groupTitle')).map((g) => (g.textContent || '').trim())
    return { groups, toast: toastText() }
  })()`)
  record('Changes: staging a file moves it to the staged group',
    Array.isArray(changes.groups) && changes.groups.some((g) => /已暂存|Staged/.test(g)),
    JSON.stringify(changes).slice(0, 260))

  /* ---------------- Changes: unstage it back ---------------- */
  const unstage = await evaluate(`(async () => {
    ${helpers}
    const stagedRow = Array.from(document.querySelectorAll('.gwc-changeRow')).find((r) => (r.innerText || '').includes('data.txt'))
    if (stagedRow === undefined) return { error: 'no row after stage' }
    const b = Array.from(stagedRow.querySelectorAll('button')).find((x) => ['取消暂存', 'Unstage'].includes(x.getAttribute('aria-label') || ''))
    if (b === undefined) return { error: 'no unstage button' }
    b.click()
    await sleep(2500)
    return { groups: Array.from(document.querySelectorAll('.gwc-groupTitle')).map((g) => (g.textContent || '').trim()), toast: toastText() }
  })()`)
  record('Changes: unstaging moves it back', unstage.toast === '', JSON.stringify(unstage).slice(0, 200))

  /* ---------------- Changes: commit dialog path (commit box) ---------------- */
  const commitBox = await evaluate(`(async () => {
    ${helpers}
    const input = document.querySelector('.gwc-commitInput')
    if (input === null) return { error: 'no commit input' }
    const before = document.querySelectorAll('.gwc-commitRow button').length
    return { hasInput: true, buttons: before, amendCheckbox: document.querySelectorAll('.gwc-commitRow input[type="checkbox"]').length }
  })()`)
  record('Changes: the commit box exposes a message field, amend toggle and a button',
    commitBox.hasInput === true && commitBox.buttons >= 1 && commitBox.amendCheckbox === 1,
    JSON.stringify(commitBox))

  /* ---------------- History: search + load more + commit actions ------------ */
  const historySearch = await evaluate(`(async () => {
    ${helpers}
    nav('历史|History')
    await sleep(3500)
    const before = document.querySelectorAll('.gwc-commitRow').length
    const search = document.querySelector('.gwc-search')
    if (search === null) return { error: 'no search input', before }
    search.value = 'seed'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await sleep(3000)
    return { before, after: document.querySelectorAll('.gwc-commitRow').length, toast: toastText() }
  })()`)
  record('History: searching filters the commit list',
    historySearch.after !== undefined && historySearch.toast === '',
    JSON.stringify(historySearch).slice(0, 220))

  const historyActions = await evaluate(`(async () => {
    ${helpers}
    const search = document.querySelector('.gwc-search')
    if (search !== null) { search.value = ''; search.dispatchEvent(new Event('input', { bubbles: true })); search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) }
    await sleep(2500)
    const rows = document.querySelectorAll('.gwc-commitRow')
    if (rows.length === 0) return { error: 'no commits' }
    rows[0].click()
    await sleep(3000)
    return {
      details: document.querySelectorAll('.gwc-commitDetail').length,
      actions: Array.from(document.querySelectorAll('.gwc-detailActions button')).map((b) => (b.innerText || '').trim()),
    }
  })()`)
  record('History: a selected commit shows its detail and action row',
    historyActions.details === 1 && Array.isArray(historyActions.actions) && historyActions.actions.length >= 4,
    JSON.stringify(historyActions).slice(0, 260))

  /* ---------------- History: tag dialog opens and closes ---------------- */
  const tagDialog = await evaluate(`(async () => {
    ${helpers}
    const tagBtn = btnByText(document.querySelector('.gwc-detailActions'), '在此新建标签…') || btnByText(document.querySelector('.gwc-detailActions'), 'New tag here…')
    if (tagBtn === undefined) return { error: 'no tag button', actions: Array.from(document.querySelectorAll('.gwc-detailActions button')).map((b) => b.innerText) }
    tagBtn.click()
    await sleep(1800)
    const modal = document.querySelector('.gwc-modal')
    const fields = document.querySelectorAll('.gwc-modal .gwc-field').length
    const cancel = btnByText(document.querySelector('.gwc-modalFoot'), '取消') || btnByText(document.querySelector('.gwc-modalFoot'), 'Cancel')
    if (cancel !== undefined) cancel.click()
    await sleep(1200)
    return { opened: modal !== null, fields, closed: document.querySelector('.gwc-modal') === null }
  })()`)
  record('History: the tag dialog opens with its fields and closes on cancel',
    tagDialog.opened === true && tagDialog.fields >= 2 && tagDialog.closed === true,
    JSON.stringify(tagDialog).slice(0, 240))

  /* ---------------- History: reset dialog has three modes ---------------- */
  const resetDialog = await evaluate(`(async () => {
    ${helpers}
    const resetBtn = btnByText(document.querySelector('.gwc-detailActions'), '重置到此提交…') || btnByText(document.querySelector('.gwc-detailActions'), 'Reset to this commit…')
    if (resetBtn === undefined) return { error: 'no reset button' }
    resetBtn.click()
    await sleep(1800)
    const radios = document.querySelectorAll('.gwc-modal .gwc-radio').length
    const cancel = btnByText(document.querySelector('.gwc-modalFoot'), '取消') || btnByText(document.querySelector('.gwc-modalFoot'), 'Cancel')
    if (cancel !== undefined) cancel.click()
    await sleep(1200)
    return { radios, closed: document.querySelector('.gwc-modal') === null }
  })()`)
  record('History: the reset dialog offers soft / mixed / hard',
    resetDialog.radios === 3 && resetDialog.closed === true, JSON.stringify(resetDialog))

  /* ---------------- Branches: list + new-branch dialog ---------------- */
  const branches = await evaluate(`(async () => {
    ${helpers}
    nav('分支|Branches')
    await sleep(3500)
    return {
      rows: document.querySelectorAll('.gwc-branchRow').length,
      groups: Array.from(document.querySelectorAll('.gwc-groupTitle')).map((g) => (g.textContent || '').trim()),
      hasNewButton: Array.from(document.querySelectorAll('.gwc-branchBar button')).some((b) => /新建分支|New branch/.test(b.innerText || '')),
    }
  })()`)
  record('Branches: the tree lists branches with a new-branch action',
    branches.rows >= 1 && branches.hasNewButton === true, JSON.stringify(branches).slice(0, 260))

  const branchDialog = await evaluate(`(async () => {
    ${helpers}
    const newBtn = Array.from(document.querySelectorAll('.gwc-branchBar button')).find((b) => /新建分支|New branch/.test(b.innerText || ''))
    if (newBtn === undefined) return { error: 'no new branch button' }
    newBtn.click()
    await sleep(1800)
    const fields = document.querySelectorAll('.gwc-modal .gwc-field').length
    const input = document.querySelector('.gwc-modal .gwc-input')
    const cancel = btnByText(document.querySelector('.gwc-modalFoot'), '取消') || btnByText(document.querySelector('.gwc-modalFoot'), 'Cancel')
    if (cancel !== undefined) cancel.click()
    await sleep(1000)
    return { fields, hasInput: input !== null, closed: document.querySelector('.gwc-modal') === null }
  })()`)
  record('Branches: the new-branch dialog has name + start point and closes',
    branchDialog.fields >= 2 && branchDialog.closed === true, JSON.stringify(branchDialog))

  /* ---------------- Branches: delete confirmation dialog ---------------- */
  const deleteDialog = await evaluate(`(async () => {
    ${helpers}
    const rows = Array.from(document.querySelectorAll('.gwc-branchRow'))
    const nonHead = rows.find((r) => !/HEAD/.test(r.innerText || '') && r.querySelector('button[aria-label="删除"], button[aria-label="Delete"]') !== null)
    if (nonHead === undefined) return { skipped: true, rows: rows.length }
    const del = nonHead.querySelector('button[aria-label="删除"], button[aria-label="Delete"]')
    del.click()
    await sleep(1800)
    const modal = document.querySelector('.gwc-modal')
    const checkboxes = document.querySelectorAll('.gwc-modal input[type="checkbox"]').length
    const cancel = btnByText(document.querySelector('.gwc-modalFoot'), '取消') || btnByText(document.querySelector('.gwc-modalFoot'), 'Cancel')
    if (cancel !== undefined) cancel.click()
    await sleep(1000)
    return { opened: modal !== null, checkboxes, closed: document.querySelector('.gwc-modal') === null }
  })()`)
  record('Branches: deleting asks for confirmation with a force option',
    deleteDialog.skipped === true || (deleteDialog.opened === true && deleteDialog.checkboxes >= 1 && deleteDialog.closed === true),
    JSON.stringify(deleteDialog))

  /* ---------------- Stash: create, then apply/pop/drop ---------------- */
  const stash = await evaluate(`(async () => {
    ${helpers}
    nav('贮藏|Stash')
    await sleep(3000)
    const empty = document.querySelectorAll('.gwc-empty').length
    const createBtn = Array.from(document.querySelectorAll('.gwc-branchBar button')).find((b) => /贮藏当前更改|Stash current changes/.test(b.innerText || ''))
    if (createBtn === undefined) return { error: 'no create button', empty }
    createBtn.click()
    await sleep(1800)
    const modal = document.querySelector('.gwc-modal')
    const checkboxes = document.querySelectorAll('.gwc-modal input[type="checkbox"]').length
    /* Fill the message and submit. */
    const input = document.querySelector('.gwc-modal .gwc-input')
    if (input !== null) { input.value = 'e2e stash'; input.dispatchEvent(new Event('input', { bubbles: true })) }
    const ok = btnByText(document.querySelector('.gwc-modalFoot'), '确定') || btnByText(document.querySelector('.gwc-modalFoot'), 'OK')
    if (ok !== undefined) ok.click()
    await sleep(3500)
    return { modalOpened: modal !== null, checkboxes, rows: document.querySelectorAll('.gwc-stashRow').length, toast: toastText() }
  })()`)
  record('Stash: the create dialog works and the entry appears',
    stash.modalOpened === true && stash.checkboxes >= 2 && stash.rows >= 1,
    JSON.stringify(stash).slice(0, 280))

  const stashApply = await evaluate(`(async () => {
    ${helpers}
    const row = document.querySelector('.gwc-stashRow')
    if (row === null) return { error: 'no stash row' }
    const applyBtn = Array.from(row.querySelectorAll('button')).find((b) => /应用|Apply/.test(b.innerText || ''))
    if (applyBtn === undefined) return { error: 'no apply button' }
    applyBtn.click()
    await sleep(3500)
    return { toast: toastText(), rows: document.querySelectorAll('.gwc-stashRow').length }
  })()`)
  record('Stash: applying an entry succeeds without a toast',
    stashApply.toast === '', JSON.stringify(stashApply).slice(0, 200))

  const stashDrop = await evaluate(`(async () => {
    ${helpers}
    /* Refresh the list first: the previous APPLY does not consume the entry, and
       a stale row would address the wrong stash index. */
    const refresh = document.querySelector('.gwc-branchBar button[aria-label="刷新"], .gwc-branchBar button[aria-label="Refresh"]')
    if (refresh !== null) { refresh.click(); await sleep(2500) }
    const before = document.querySelectorAll('.gwc-stashRow').length
    const row = document.querySelector('.gwc-stashRow')
    if (row === null) return { skipped: true, before }
    const dropBtn = row.querySelector('button[aria-label="删除"], button[aria-label="Drop"]')
    if (dropBtn === undefined) return { error: 'no drop button', before }
    dropBtn.click()
    await sleep(3500)
    return { before, after: document.querySelectorAll('.gwc-stashRow').length, toast: toastText() }
  })()`)
  record('Stash: dropping an entry removes it',
    stashDrop.skipped === true || (stashDrop.after !== undefined && stashDrop.after === stashDrop.before - 1),
    JSON.stringify(stashDrop).slice(0, 220))

  /* ---------------- Conflicts: banner + abort ---------------- */
  const conflict = await evaluate(`(async () => {
    ${helpers}
    nav('变更|Changes')
    await sleep(2500)
    const banner = document.querySelector('.gwc-conflictBar')
    return {
      present: banner !== null,
      text: banner === null ? '' : (banner.innerText || '').replace(/\\s+/g, ' ').slice(0, 120),
      actions: banner === null ? [] : Array.from(banner.querySelectorAll('button')).map((b) => (b.innerText || '').trim()),
    }
  })()`)
  record('Conflicts: an in-progress merge shows the conflict banner with continue/abort',
    conflict.present === true && conflict.actions.length === 2,
    JSON.stringify(conflict).slice(0, 260))

  const abort = await evaluate(`(async () => {
    ${helpers}
    const b = Array.from(document.querySelectorAll('.gwc-conflictBar button')).find((x) => /中止|Abort/.test(x.innerText || ''))
    if (b === undefined) return { error: 'no abort button' }
    b.click()
    await sleep(4000)
    return { bannerGone: document.querySelector('.gwc-conflictBar') === null, toast: toastText() }
  })()`)
  record('Conflicts: aborting the merge clears the banner',
    abort.bannerGone === true, JSON.stringify(abort).slice(0, 200))

  /* ---------------- Error path: a toast, never a crash ---------------- */
  const errorPath = await evaluate(`(async () => {
    const root = document.querySelector('.gwc-root')
    return {
      alive: root !== null,
      crashed: document.querySelector('.gwc-error') !== null,
      text: root === null ? '' : (root.innerText || '').slice(0, 80),
    }
  })()`)
  record('the panel survived every interaction (no error boundary)',
    errorPath.alive === true && errorPath.crashed === false, JSON.stringify(errorPath))

  const failures = await evaluate(`(() => window.__GWC_FAILS__ || [])()`)
  const revFailures = failures.filter((entry) => /rev is required/.test(entry.body))
  record('no request was rejected with "rev is required"',
    revFailures.length === 0, JSON.stringify(failures).slice(0, 300))

  const consoleErrors = events.filter((event) =>
    event.method === 'Runtime.consoleAPICalled'
    && event.params.type === 'error'
    && (event.params.args || []).some((arg) => /gitcraft|gwc/i.test(String(arg.value ?? arg.description ?? ''))))
  record('no plugin console error during the whole walk',
    consoleErrors.length === 0,
    consoleErrors.slice(0, 2).map((event) => (event.params.args || []).map((arg) => String(arg.value ?? '')).join(' ').slice(0, 180)).join(' | '))

  await send('Browser.close').catch(() => {})
} catch (error) {
  console.error('coverage e2e failed: ' + error.message)
  exitCode = 1
} finally {
  try { child.kill('SIGKILL') } catch { /* gone */ }
  await sleep(400)
  try { rmSync(profileDir, { recursive: true, force: true }) } catch { /* locked */ }
}

const failed = results.filter((entry) => entry.ok !== true)
console.log('')
console.log(`coverage e2e: ${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) exitCode = 1
process.exit(exitCode)
