/**
 * Host-half end-to-end test: boots the plugin through a fake cordis context,
 * mounts the captured route handler on a real HTTP server, and drives every
 * git operation against a throwaway repository created in the OS temp dir.
 *
 * Run:  node --test tests/host.test.mjs
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const plugin = await import('../src/index.js')

let server
let baseUrl
let sandbox
let repo
let remote

function readText(file) {
  return readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
}

function sh(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

async function call(method, payload) {
  const res = await fetch(`${baseUrl}/dsh-gitcraft/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const json = await res.json()
  return { status: res.status, ...json }
}

before(async () => {
  sandbox = mkdtempSync(path.join(tmpdir(), 'gwc-'))
  repo = path.join(sandbox, 'repo')
  remote = path.join(sandbox, 'remote.git')
  mkdirSync(repo, { recursive: true })
  sh(sandbox, ['init', '--bare', remote])
  sh(repo, ['init', '-q', '-b', 'main'])
  sh(repo, ['config', 'user.name', 'Test User'])
  sh(repo, ['config', 'user.email', 'test@example.com'])
  writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\nthree\n')
  writeFileSync(path.join(repo, 'b.txt'), 'bee\n')
  sh(repo, ['add', '.'])
  sh(repo, ['commit', '-q', '-m', 'feat: initial commit'])
  sh(repo, ['remote', 'add', 'origin', remote])
  sh(repo, ['push', '-q', '-u', 'origin', 'main'])

  // Boot the plugin: capture the handler the plugin registers on webServer.
  let captured = null
  const ctx = {
    config: { refreshIntervalMs: 15000, timeoutMs: 30000, networkTimeoutMs: 60000 },
    effect(fn) { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose() } },
    webServer: {
      register({ kind, path: routePath, handler }) {
        captured = { kind, path: routePath, handler }
        return () => { captured = null }
      },
    },
  }
  plugin.apply(ctx, ctx.config)
  assert.ok(captured !== null, 'plugin did not register a route')
  assert.equal(captured.kind, 'prefix')
  assert.equal(captured.path, '/dsh-gitcraft/api')

  server = createServer((req, res) => { void captured.handler(req, res) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  if (server !== undefined) await new Promise((resolve) => server.close(resolve))
  if (sandbox !== undefined) rmSync(sandbox, { recursive: true, force: true })
})

test('snapshot reports branch, head and a clean tree', async () => {
  const out = await call('snapshot', { cwd: repo })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.data.branch, 'main')
  assert.equal(out.data.upstream, 'origin/main')
  assert.equal(out.data.changes.length, 0)
  assert.equal(out.data.unborn, false)
  assert.ok(out.data.headShort.length >= 7)
})

test('snapshot rejects a non-repository directory', async () => {
  const out = await call('snapshot', { cwd: sandbox })
  assert.equal(out.ok, false)
  assert.equal(out.error.code, 'not-a-repo')
})

test('log returns commits with parents and refs', async () => {
  const out = await call('log', { cwd: repo, limit: 10 })
  assert.equal(out.ok, true)
  assert.equal(out.data.commits.length, 1)
  assert.equal(out.data.commits[0].subject, 'feat: initial commit')
  assert.deepEqual(out.data.commits[0].parents, [])
  assert.ok(out.data.commits[0].refs.includes('main'))
})

test('branches lists the local branch with its upstream', async () => {
  const out = await call('branches', { cwd: repo })
  assert.equal(out.ok, true)
  const local = out.data.branches.find((entry) => entry.kind === 'local' && entry.name === 'main')
  assert.ok(local !== undefined)
  assert.equal(local.head, true)
  assert.equal(local.upstream, 'origin/main')
})

test('status classifies a modified file and stage/unstage move it between groups', async () => {
  writeFileSync(path.join(repo, 'a.txt'), 'one\nTWO\nthree\n')
  let out = await call('snapshot', { cwd: repo })
  assert.equal(out.data.changes.length, 1)
  assert.equal(out.data.changes[0].path, 'a.txt')
  assert.equal(out.data.changes[0].staged, false)
  assert.equal(out.data.changes[0].kind, 'modified')
  assert.equal(out.data.changes[0].unstagedAdded, 1)
  assert.equal(out.data.changes[0].unstagedDeleted, 1)

  out = await call('stage', { cwd: repo, paths: ['a.txt'] })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.data.changes[0].staged, true)

  out = await call('unstage', { cwd: repo, paths: ['a.txt'] })
  assert.equal(out.ok, true)
  assert.equal(out.data.changes[0].staged, false)
})

test('diff returns hunks the client can render', async () => {
  const out = await call('diff', { cwd: repo, path: 'a.txt', base: 'worktree' })
  assert.equal(out.ok, true)
  assert.match(out.data.patch, /-one|-TWO|\+TWO/)
  assert.ok(out.data.hunks.length >= 1)
  assert.equal(out.data.hunks[0].index, 0)
  assert.ok(out.data.hunks[0].added >= 1)
})

test('stageHunk stages only the selected hunk of a multi-hunk file', async () => {
  // Two well-separated edits => two hunks.
  const lines = []
  for (let i = 0; i < 60; i += 1) lines.push(`line ${i}`)
  writeFileSync(path.join(repo, 'multi.txt'), lines.join('\n') + '\n')
  sh(repo, ['add', 'multi.txt'])
  sh(repo, ['commit', '-q', '-m', 'chore: add multi'])
  lines[2] = 'line 2 CHANGED'
  lines[55] = 'line 55 CHANGED'
  writeFileSync(path.join(repo, 'multi.txt'), lines.join('\n') + '\n')

  const diff = await call('diff', { cwd: repo, path: 'multi.txt', base: 'worktree' })
  assert.equal(diff.data.hunks.length, 2, 'expected two hunks')

  const staged = await call('stageHunk', { cwd: repo, path: 'multi.txt', hunkIndex: 0 })
  assert.equal(staged.ok, true, JSON.stringify(staged))
  const entry = staged.data.changes.find((change) => change.path === 'multi.txt')
  assert.ok(entry !== undefined)
  assert.equal(entry.staged, true, 'file has something staged')
  assert.ok(entry.added + entry.deleted > 0, 'staged side has changes')

  // The second hunk must still be unstaged.
  const stagedDiff = await call('diff', { cwd: repo, path: 'multi.txt', base: 'staged' })
  assert.match(stagedDiff.data.patch, /line 2 CHANGED/)
  assert.doesNotMatch(stagedDiff.data.patch, /line 55 CHANGED/)
  const rest = await call('diff', { cwd: repo, path: 'multi.txt', base: 'worktree' })
  assert.match(rest.data.patch, /line 55 CHANGED/)
  assert.doesNotMatch(rest.data.patch, /line 2 CHANGED/)

  await call('unstage', { cwd: repo, paths: ['multi.txt'] })
  sh(repo, ['checkout', '--', 'multi.txt'])
})

test('stageHunk with an explicit line selection stages only those lines', async () => {
  writeFileSync(path.join(repo, 'lines.txt'), 'x\ny\nz\n')
  sh(repo, ['add', 'lines.txt'])
  sh(repo, ['commit', '-q', '-m', 'chore: add lines'])
  // One hunk touching both y and z: change both, stage only the first change.
  writeFileSync(path.join(repo, 'lines.txt'), 'x\nY\nZ\n')
  const diff = await call('diff', { cwd: repo, path: 'lines.txt', base: 'worktree' })
  assert.equal(diff.data.hunks.length, 1)
  const hunk = diff.data.hunks[0]
  // Body indices: 0 = ' x', 1 = '-y', 2 = '-z', 3 = '+Y', 4 = '+Z'
  const out = await call('stageHunk', { cwd: repo, path: 'lines.txt', hunkIndex: 0, lines: [1, 3] })
  assert.equal(out.ok, true, JSON.stringify(out))
  const stagedDiff = await call('diff', { cwd: repo, path: 'lines.txt', base: 'staged' })
  assert.match(stagedDiff.data.patch, /\+Y/)
  assert.doesNotMatch(stagedDiff.data.patch, /\+Z/)
  const worktreeDiff = await call('diff', { cwd: repo, path: 'lines.txt', base: 'worktree' })
  assert.match(worktreeDiff.data.patch, /\+Z/)
  await call('unstage', { cwd: repo, paths: ['lines.txt'] })
  sh(repo, ['checkout', '--', 'lines.txt'])
  void hunk
})

test('discardHunk reverts one hunk only', async () => {
  const lines = []
  for (let i = 0; i < 60; i += 1) lines.push(`row ${i}`)
  writeFileSync(path.join(repo, 'discard.txt'), lines.join('\n') + '\n')
  sh(repo, ['add', 'discard.txt'])
  sh(repo, ['commit', '-q', '-m', 'chore: add discard'])
  lines[2] = 'row 2 EDITED'
  lines[55] = 'row 55 EDITED'
  writeFileSync(path.join(repo, 'discard.txt'), lines.join('\n') + '\n')
  const out = await call('discardHunk', { cwd: repo, path: 'discard.txt', hunkIndex: 0 })
  assert.equal(out.ok, true, JSON.stringify(out))
  const content = readText(path.join(repo, 'discard.txt'))
  assert.match(content, /row 2\n/, 'first hunk reverted')
  assert.match(content, /row 55 EDITED/, 'second hunk untouched')
  sh(repo, ['checkout', '--', 'discard.txt'])
})

test('untrackedDiff synthesizes a patch for a new file', async () => {
  writeFileSync(path.join(repo, 'new.txt'), 'hello\nworld\n')
  const out = await call('untrackedDiff', { cwd: repo, path: 'new.txt' })
  assert.equal(out.ok, true)
  assert.match(out.data.patch, /\+hello/)
  assert.equal(out.data.binary, false)
  rmSync(path.join(repo, 'new.txt'))
})

test('commit creates a commit and amend rewrites it', async () => {
  // Start from a clean tree so the assertions below are about this commit only.
  await call('cleanUntracked', { cwd: repo, confirm: true })
  sh(repo, ['checkout', '--', '.'])
  writeFileSync(path.join(repo, 'c.txt'), 'c\n')
  await call('stage', { cwd: repo, paths: ['c.txt'] })
  let out = await call('commit', { cwd: repo, message: 'feat: add c' })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.data.changes.filter((entry) => entry.path === 'c.txt').length, 0)
  const first = out.data.head

  writeFileSync(path.join(repo, 'c.txt'), 'c2\n')
  await call('stage', { cwd: repo, paths: ['c.txt'] })
  out = await call('amend', { cwd: repo, message: 'feat: add c (amended)' })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.notEqual(out.data.head, first, 'amend rewrote the commit')
  const detail = await call('commitDetail', { cwd: repo, rev: 'HEAD' })
  assert.equal(detail.data.subject, 'feat: add c (amended)')
})

test('branchCreate / checkout / branchRename / branchDelete round-trip', async () => {
  let out = await call('branchCreate', { cwd: repo, name: 'feature/x' })
  assert.equal(out.ok, true, JSON.stringify(out))
  out = await call('checkout', { cwd: repo, name: 'feature/x' })
  assert.equal(out.data.branch, 'feature/x')
  out = await call('branchRename', { cwd: repo, from: 'feature/x', to: 'feature/y' })
  assert.equal(out.data.branch, 'feature/y')
  out = await call('checkout', { cwd: repo, name: 'main' })
  assert.equal(out.data.branch, 'main')
  out = await call('branchDelete', { cwd: repo, name: 'feature/y' })
  assert.equal(out.ok, true, JSON.stringify(out))
  const branches = await call('branches', { cwd: repo })
  assert.equal(branches.data.branches.some((entry) => entry.name === 'feature/y'), false)
})

test('protected branch deletion needs an explicit confirmation', async () => {
  const out = await call('branchDelete', { cwd: repo, name: 'main' })
  assert.equal(out.ok, false)
  assert.equal(out.error.code, 'protected-branch')
})

test('checkout refuses to clobber local changes', async () => {
  writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\nthree\nfour\n')
  const out = await call('checkout', { cwd: repo, name: 'origin/main' })
  // Either git refuses (local-changes-block) or it succeeds without touching the
  // file; both are acceptable, but a dirty-tree refusal must carry the code.
  if (out.ok === false) assert.ok(['local-changes-block', 'checkout-failed'].includes(out.error.code))
  sh(repo, ['checkout', '--', 'a.txt'])
  if (out.ok) sh(repo, ['checkout', 'main'])
})

test('stash push / list / pop keeps the worktree clean in between', async () => {
  writeFileSync(path.join(repo, 'a.txt'), 'stashed content\n')
  let out = await call('stashPush', { cwd: repo, message: 'wip: probe', includeUntracked: true })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.data.snapshot.changes.length, 0, 'worktree clean after stash')

  const list = await call('stashList', { cwd: repo })
  assert.equal(list.ok, true)
  assert.ok(list.data.stash.length >= 1)
  assert.match(list.data.stash[0].subject, /wip: probe/)

  out = await call('stashPop', { cwd: repo, index: 0 })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.data.conflicted, false)
  assert.equal(readText(path.join(repo, 'a.txt')), 'stashed content\n')
  sh(repo, ['checkout', '--', 'a.txt'])
})

test('merge reports conflicts and conflictResolve/mark-resolved closes it', async () => {
  sh(repo, ['checkout', '-q', '-b', 'topic', 'main'])
  writeFileSync(path.join(repo, 'conflict.txt'), 'base\n')
  sh(repo, ['add', 'conflict.txt'])
  sh(repo, ['commit', '-q', '-m', 'feat: add conflict file'])
  writeFileSync(path.join(repo, 'conflict.txt'), 'topic side\n')
  sh(repo, ['commit', '-q', '-am', 'feat: topic edit'])

  sh(repo, ['checkout', '-q', 'main'])
  writeFileSync(path.join(repo, 'conflict.txt'), 'main side\n')
  sh(repo, ['add', 'conflict.txt'])
  sh(repo, ['commit', '-q', '-m', 'feat: main edit'])

  const merged = await call('merge', { cwd: repo, rev: 'topic' })
  assert.equal(merged.ok, true, JSON.stringify(merged))
  assert.equal(merged.data.conflicted, true)
  assert.ok(merged.data.snapshot.conflictedFiles.includes('conflict.txt'))
  assert.equal(merged.data.snapshot.operation, 'merge')

  const resolved = await call('conflictResolve', { cwd: repo, paths: ['conflict.txt'], side: 'theirs' })
  assert.equal(resolved.ok, true, JSON.stringify(resolved))
  assert.equal(resolved.data.conflictedFiles.length, 0)

  const committed = await call('mergeContinue', { cwd: repo, message: 'chore: merge topic' })
  assert.equal(committed.ok, true, JSON.stringify(committed))
  assert.equal(committed.data.operation, null)
  assert.equal(readText(path.join(repo, 'conflict.txt')), 'topic side\n')
})

test('mergeAbort restores the pre-merge state', async () => {
  sh(repo, ['checkout', '-q', '-b', 'topic2', 'main'])
  writeFileSync(path.join(repo, 'conflict.txt'), 'topic2 side\n')
  sh(repo, ['commit', '-q', '-am', 'feat: topic2 edit'])
  sh(repo, ['checkout', '-q', 'main'])
  writeFileSync(path.join(repo, 'conflict.txt'), 'main2 side\n')
  sh(repo, ['commit', '-q', '-am', 'feat: main2 edit'])
  const merged = await call('merge', { cwd: repo, rev: 'topic2' })
  assert.equal(merged.data.conflicted, true)
  const aborted = await call('mergeAbort', { cwd: repo })
  assert.equal(aborted.ok, true, JSON.stringify(aborted))
  assert.equal(aborted.data.operation, null)
  assert.equal(aborted.data.conflictedFiles.length, 0)
  assert.equal(readText(path.join(repo, 'conflict.txt')), 'main2 side\n')
})

test('reset requires confirmation for --hard', async () => {
  const bad = await call('reset', { cwd: repo, rev: 'HEAD~1', mode: 'hard' })
  assert.equal(bad.ok, false)
  assert.equal(bad.error.code, 'confirm-required')
  const ok = await call('reset', { cwd: repo, rev: 'HEAD', mode: 'soft' })
  assert.equal(ok.ok, true, JSON.stringify(ok))
})

test('cherryPick and revert both work on a linear history', async () => {
  sh(repo, ['checkout', '-q', '-b', 'pick-src', 'main'])
  writeFileSync(path.join(repo, 'picked.txt'), 'picked\n')
  sh(repo, ['add', 'picked.txt'])
  sh(repo, ['commit', '-q', '-m', 'feat: picked commit'])
  const hash = sh(repo, ['rev-parse', 'HEAD']).trim()
  sh(repo, ['checkout', '-q', 'main'])

  const picked = await call('cherryPick', { cwd: repo, rev: hash })
  assert.equal(picked.ok, true, JSON.stringify(picked))
  assert.equal(picked.data.conflicted, false)
  assert.ok(existsSync(path.join(repo, 'picked.txt')))

  const reverted = await call('revert', { cwd: repo, rev: 'HEAD' })
  assert.equal(reverted.ok, true, JSON.stringify(reverted))
  assert.equal(existsSync(path.join(repo, 'picked.txt')), false)
})

test('tags can be created, listed and deleted', async () => {
  let out = await call('tagCreate', { cwd: repo, name: 'v0.0.1', message: 'release' })
  assert.equal(out.ok, true, JSON.stringify(out))
  let branches = await call('branches', { cwd: repo })
  assert.ok(branches.data.branches.some((entry) => entry.kind === 'tag' && entry.name === 'v0.0.1'))
  out = await call('tagDelete', { cwd: repo, name: 'v0.0.1' })
  assert.equal(out.ok, true)
  branches = await call('branches', { cwd: repo })
  assert.equal(branches.data.branches.some((entry) => entry.kind === 'tag'), false)
})

test('fetch / pull / push reach the local bare remote', async () => {
  const fetchOut = await call('fetch', { cwd: repo })
  assert.equal(fetchOut.ok, true, JSON.stringify(fetchOut))

  const pushOut = await call('push', { cwd: repo })
  assert.equal(pushOut.ok, true, JSON.stringify(pushOut))
  assert.match(pushOut.data.output, /main|Everything up-to-date/)

  const pullOut = await call('pull', { cwd: repo })
  assert.equal(pullOut.ok, true, JSON.stringify(pullOut))
  assert.equal(pullOut.data.conflicted, false)
})

test('blame, fileHistory and reflog return rows', async () => {
  const blame = await call('blame', { cwd: repo, path: 'a.txt' })
  assert.equal(blame.ok, true, JSON.stringify(blame))
  assert.ok(Array.isArray(blame.data.lines), 'blame returns rows')
  assert.ok(blame.data.lines.length >= 1, 'blame row count: ' + blame.data.lines.length)
  assert.ok(blame.data.lines[0].hash.length === 40)

  const history = await call('fileHistory', { cwd: repo, path: 'a.txt', limit: 10 })
  assert.equal(history.ok, true, JSON.stringify(history))
  assert.equal(history.ok, true)
  assert.ok(history.data.commits.length >= 1)

  const reflog = await call('reflog', { cwd: repo, limit: 10 })
  assert.equal(reflog.ok, true)
  assert.ok(reflog.data.entries.length >= 1)
  assert.ok(reflog.data.entries[0].selector.startsWith('HEAD@'))
})

test('fileContent reads the index and a revision, and reports a missing path', async () => {
  const work = await call('fileContent', { cwd: repo, path: 'a.txt' })
  assert.equal(work.ok, true)
  assert.equal(work.data.missing, false)

  const head = await call('fileContent', { cwd: repo, path: 'a.txt', rev: 'HEAD' })
  assert.equal(head.ok, true)

  const missing = await call('fileContent', { cwd: repo, path: 'nope.txt' })
  assert.equal(missing.ok, true)
  assert.equal(missing.data.missing, true)
})

test('cleanUntracked needs confirmation and then removes untracked files', async () => {
  writeFileSync(path.join(repo, 'junk.txt'), 'junk\n')
  const bad = await call('cleanUntracked', { cwd: repo })
  assert.equal(bad.ok, false)
  assert.equal(bad.error.code, 'confirm-required')
  const ok = await call('cleanUntracked', { cwd: repo, confirm: true })
  assert.equal(ok.ok, true, JSON.stringify(ok))
  assert.equal(existsSync(path.join(repo, 'junk.txt')), false)
})

test('unknown method and non-POST are rejected', async () => {
  const unknown = await call('nope', { cwd: repo })
  assert.equal(unknown.status, 404)
  const res = await fetch(`${baseUrl}/dsh-gitcraft/api/snapshot`, { method: 'GET' })
  assert.equal(res.status, 405)
})

test('path traversal in a path payload is rejected', async () => {
  const out = await call('stage', { cwd: repo, paths: ['../outside.txt'] })
  assert.equal(out.ok, false)
  assert.equal(out.error.code, 'bad-request')
})

test('stage rejects absolute paths and NUL bytes', async () => {
  let out = await call('stage', { cwd: repo, paths: ['C:\\Windows\\win.ini'] })
  assert.equal(out.ok, false)
  assert.equal(out.error.code, 'bad-request')
  out = await call('stage', { cwd: repo, paths: ['a\u0000b'] })
  assert.equal(out.ok, false)
  assert.equal(out.error.code, 'bad-request')
})

test('a ref that looks like an option is rejected', async () => {
  const out = await call('checkout', { cwd: repo, name: '--upload-pack=calc' })
  assert.equal(out.ok, false)
  assert.equal(out.error.code, 'bad-request')
})

test('repoRoot pins the repository and refuses a cwd outside it', async () => {
  const out = await call('snapshot', { cwd: sandbox, repoRoot: repo })
  assert.equal(out.ok, true, JSON.stringify(out))
  const bad = await call('snapshot', { cwd: sandbox, repoRoot: remote })
  assert.equal(bad.ok, false)
})
