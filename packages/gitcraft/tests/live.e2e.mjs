/**
 * Live end-to-end test against a RUNNING DSH instance.
 *
 * It drives the plugin exactly as the browser half does (same-origin POSTs to
 * /dsh-gitcraft/api/<method>) against a real repository, so the test
 * covers: the route actually mounted by DSH, the trust fence, the real git
 * binary and the write serialisation.
 *
 * Usage:  node tests/live.e2e.mjs <base-url> <repo-dir>
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { writeFileSync, readFileSync } from 'node:fs'
import path from 'node:path'

const baseUrl = process.argv[2]
const repo = process.argv[3]
if (baseUrl === undefined || repo === undefined) {
  console.error('usage: node tests/live.e2e.mjs <base-url> <repo-dir>')
  process.exit(2)
}

const endpoint = baseUrl.replace(/\/+$/, '') + '/dsh-gitcraft/api/'
const results = []

async function call(method, payload) {
  const res = await fetch(endpoint + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { status: res.status, ...json }
}

function sh(args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function check(name, fn) {
  return (async () => {
    try {
      await fn()
      results.push({ name, ok: true })
      console.log('  ok   ' + name)
    } catch (error) {
      results.push({ name, ok: false, message: error.message })
      console.log('  FAIL ' + name + ' — ' + error.message)
    }
  })()
}

const steps = []

steps.push(await check('the route is mounted on the running DSH server', async () => {
  const out = await call('snapshot', { cwd: repo })
  assert.equal(out.ok, true, JSON.stringify(out).slice(0, 300))
  assert.equal(out.data.branch, 'main')
  assert.equal(out.data.changes.length, 0)
}))

steps.push(await check('an unknown method answers 404 through DSH', async () => {
  const out = await call('definitely-not-a-method', { cwd: repo })
  assert.equal(out.status, 404)
  assert.equal(out.error.code, 'not-found')
}))

steps.push(await check('read: log returns the commit and its tag ref', async () => {
  const out = await call('log', { cwd: repo, limit: 10 })
  assert.equal(out.ok, true)
  assert.equal(out.data.commits.length, 1)
  assert.equal(out.data.commits[0].subject, 'feat: initial scaffold')
  assert.ok(out.data.commits[0].refs.some((ref) => ref.includes('v0.1.0') || ref.includes('tag')), JSON.stringify(out.data.commits[0].refs))
}))

steps.push(await check('read: branches lists local branch + tag', async () => {
  const out = await call('branches', { cwd: repo })
  assert.equal(out.ok, true)
  assert.ok(out.data.branches.some((entry) => entry.kind === 'local' && entry.name === 'main'))
  assert.ok(out.data.branches.some((entry) => entry.kind === 'tag' && entry.name === 'v0.1.0'))
}))

steps.push(await check('write: two well-separated edits produce two hunks', async () => {
  const lines = readFileSync(path.join(repo, 'app.txt'), 'utf8').replace(/\r\n/g, '\n').split('\n')
  lines[2] = 'line 3 EDITED'
  lines[27] = 'line 28 EDITED'
  writeFileSync(path.join(repo, 'app.txt'), lines.join('\n'))
  const out = await call('diff', { cwd: repo, path: 'app.txt', base: 'worktree' })
  assert.equal(out.ok, true)
  assert.equal(out.data.hunks.length, 2, 'expected two hunks, got ' + out.data.hunks.length)
}))

steps.push(await check('write: stage only the first hunk (SourceTree-style partial staging)', async () => {
  const out = await call('stageHunk', { cwd: repo, path: 'app.txt', hunkIndex: 0 })
  assert.equal(out.ok, true, JSON.stringify(out).slice(0, 300))
  const staged = await call('diff', { cwd: repo, path: 'app.txt', base: 'staged' })
  assert.match(staged.data.patch, /line 3 EDITED/)
  assert.doesNotMatch(staged.data.patch, /line 28 EDITED/)
  const rest = await call('diff', { cwd: repo, path: 'app.txt', base: 'worktree' })
  assert.match(rest.data.patch, /line 28 EDITED/)
  assert.doesNotMatch(rest.data.patch, /line 3 EDITED/)
}))

steps.push(await check('write: commit the staged hunk, leaving the rest unstaged', async () => {
  const out = await call('commit', { cwd: repo, message: 'feat(app): change line 3 only' })
  assert.equal(out.ok, true, JSON.stringify(out).slice(0, 300))
  assert.equal(out.data.head.length, 40)
  const entry = out.data.changes.find((change) => change.path === 'app.txt')
  assert.ok(entry !== undefined, 'app.txt is still modified')
  assert.equal(entry.staged, false, 'nothing left staged')
}))

steps.push(await check('write: line-level selection inside one hunk', async () => {
  writeFileSync(path.join(repo, 'sel.txt'), 'aa\nbb\ncc\n')
  sh(['add', 'sel.txt'])
  sh(['commit', '-qm', 'chore: add sel'])
  writeFileSync(path.join(repo, 'sel.txt'), 'AA\nbb\nCC\n')
  const diff = await call('diff', { cwd: repo, path: 'sel.txt', base: 'worktree' })
  const hunk = diff.data.hunks[0]
  assert.ok(hunk !== undefined)
  // body: ' aa' / '-bb'? — pick the changed +AA pair by inspection of the body
  const bodyLines = hunk.body.split('\n')
  const wanted = []
  bodyLines.forEach((line, index) => {
    if (line.startsWith('+AA') || line.startsWith('-aa') || line.startsWith('+CC') || line.startsWith('-cc')) {
      if (line.startsWith('+AA') || line.startsWith('-aa')) wanted.push(index)
    }
  })
  assert.ok(wanted.length >= 1, 'first change found in body: ' + JSON.stringify(bodyLines))
  const out = await call('stageHunk', { cwd: repo, path: 'sel.txt', hunkIndex: 0, lines: wanted })
  assert.equal(out.ok, true, JSON.stringify(out).slice(0, 300))
  const staged = await call('diff', { cwd: repo, path: 'sel.txt', base: 'staged' })
  assert.match(staged.data.patch, /\+AA/)
  assert.doesNotMatch(staged.data.patch, /\+CC/)
  await call('unstage', { cwd: repo, paths: ['sel.txt'] })
  sh(['checkout', '--', 'sel.txt'])
}))

steps.push(await check('write: stash round-trip', async () => {
  writeFileSync(path.join(repo, 'stash.txt'), 'stashed\n')
  const pushed = await call('stashPush', { cwd: repo, message: 'e2e stash', includeUntracked: true })
  assert.equal(pushed.ok, true, JSON.stringify(pushed).slice(0, 300))
  const list = await call('stashList', { cwd: repo })
  assert.ok(list.data.stash.some((entry) => /e2e stash/.test(entry.subject)))
  const popped = await call('stashPop', { cwd: repo, index: 0 })
  assert.equal(popped.ok, true)
  assert.equal(readFileSync(path.join(repo, 'stash.txt'), 'utf8').replace(/\r\n/g, '\n'), 'stashed\n')
  sh(['clean', '-fd'])
}))

steps.push(await check('write: branch create / checkout / delete', async () => {
  let out = await call('branchCreate', { cwd: repo, name: 'e2e/side' })
  assert.equal(out.ok, true, JSON.stringify(out).slice(0, 200))
  out = await call('checkout', { cwd: repo, name: 'e2e/side' })
  assert.equal(out.data.branch, 'e2e/side')
  out = await call('checkout', { cwd: repo, name: 'main' })
  assert.equal(out.data.branch, 'main')
  out = await call('branchDelete', { cwd: repo, name: 'e2e/side' })
  assert.equal(out.ok, true, JSON.stringify(out).slice(0, 200))
}))

steps.push(await check('write: merge conflict is reported with the conflicted file', async () => {
  sh(['checkout', '-qb', 'e2e/topic'])
  writeFileSync(path.join(repo, 'conflict.txt'), 'topic\n')
  sh(['add', 'conflict.txt'])
  sh(['commit', '-qm', 'feat: topic side'])
  sh(['checkout', '-q', 'main'])
  writeFileSync(path.join(repo, 'conflict.txt'), 'main\n')
  sh(['add', 'conflict.txt'])
  sh(['commit', '-qm', 'feat: main side'])
  const merged = await call('merge', { cwd: repo, rev: 'e2e/topic' })
  assert.equal(merged.ok, true, JSON.stringify(merged).slice(0, 200))
  assert.equal(merged.data.conflicted, true)
  assert.ok(merged.data.snapshot.conflictedFiles.includes('conflict.txt'))
  assert.equal(merged.data.snapshot.operation, 'merge')
  const resolved = await call('conflictResolve', { cwd: repo, paths: ['conflict.txt'], side: 'theirs' })
  assert.equal(resolved.data.conflictedFiles.length, 0)
  const done = await call('mergeContinue', { cwd: repo, message: 'chore: merge topic' })
  assert.equal(done.data.operation, null)
}))

steps.push(await check('read: blame / fileHistory / reflog answer on the live server', async () => {
  const blame = await call('blame', { cwd: repo, path: 'app.txt' })
  assert.equal(blame.ok, true, JSON.stringify(blame).slice(0, 200))
  assert.ok(blame.data.lines.length >= 1)
  const history = await call('fileHistory', { cwd: repo, path: 'app.txt', limit: 5 })
  assert.equal(history.ok, true)
  assert.ok(history.data.commits.length >= 1)
  const reflog = await call('reflog', { cwd: repo, limit: 5 })
  assert.equal(reflog.ok, true)
  assert.ok(reflog.data.entries.length >= 1)
}))

steps.push(await check('guard: a ref that looks like an option is refused', async () => {
  const out = await call('checkout', { cwd: repo, name: '--upload-pack=calc' })
  assert.equal(out.ok, false)
  assert.equal(out.error.code, 'bad-request')
}))

steps.push(await check('guard: protected branch deletion needs a confirmation', async () => {
  const out = await call('branchDelete', { cwd: repo, name: 'main' })
  assert.equal(out.ok, false)
  assert.equal(out.error.code, 'protected-branch')
}))

steps.push(await check('guard: hard reset needs confirm', async () => {
  const out = await call('reset', { cwd: repo, rev: 'HEAD~1', mode: 'hard' })
  assert.equal(out.ok, false)
  assert.equal(out.error.code, 'confirm-required')
}))

await Promise.all(steps)
const failed = results.filter((entry) => entry.ok !== true)
console.log('')
console.log(`live e2e: ${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) {
  for (const entry of failed) console.log('  failed: ' + entry.name + ' — ' + entry.message)
  process.exit(1)
}
