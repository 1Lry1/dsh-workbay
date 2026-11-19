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

test('stage all / unstage all work on a change set far too large for one command line', async () => {
  /*
   * THE REPORTED BUG: "点击全部暂存时提示找不到 git 命令".
   *
   * Root cause reproduced: the UI expanded「全部暂存」into one path per change and
   * passed them all as argv. Win32 caps a command line at ~32767 chars, so a few
   * thousand files made spawn() throw ENAMETOOLONG — which the host reported as
   * `git-missing`, i.e. "git is not installed". git was there all along.
   *
   * This test creates a change set whose argv WOULD exceed the cap, then asserts
   * the bulk endpoints still work, which is only true if they stopped
   * enumerating paths.
   */
  const many = path.join(repo, 'many')
  mkdirSync(many, { recursive: true })
  const count = 1200
  for (let i = 0; i < count; i += 1) {
    /* A long-ish name so the would-be argv is comfortably over the Win32 cap. */
    writeFileSync(path.join(many, 'generated-file-with-a-fairly-long-name-' + String(i).padStart(5, '0') + '.txt'), 'x\n')
  }
  const wouldBeArgv = Array.from({ length: count }, (_, i) =>
    'many/generated-file-with-a-fairly-long-name-' + String(i).padStart(5, '0') + '.txt').join(' ').length
  assert.ok(wouldBeArgv > 32767, 'the old path list would have blown the argv cap: ' + wouldBeArgv + ' chars')

  /* Stage all: one `git add -A`, no path list. */
  let out = await call('stage', { cwd: repo, all: true })
  assert.equal(out.ok, true, JSON.stringify(out).slice(0, 300))
  const stagedCount = out.data.changes.filter((entry) => entry.staged).length
  assert.ok(stagedCount >= count, 'all of them are staged: ' + stagedCount)

  /* Unstage all: also path-list free. */
  out = await call('unstage', { cwd: repo, all: true })
  assert.equal(out.ok, true, JSON.stringify(out).slice(0, 300))
  assert.equal(out.data.changes.filter((entry) => entry.staged).length, 0, 'nothing left staged')

  /* A path-list call with the same set must FAIL as too-long rather than
     pretend git is missing — that distinction is the actual bug fix. */
  const paths = Array.from({ length: count }, (_, i) => 'many/generated-file-with-a-fairly-long-name-' + String(i).padStart(5, '0') + '.txt')
  out = await call('stage', { cwd: repo, paths })
  assert.equal(out.ok, false)
  assert.equal(out.error.code, 'argv-too-long', 'must not be reported as git-missing: ' + JSON.stringify(out.error))
  assert.doesNotMatch(JSON.stringify(out.error), /git-missing/)

  sh(repo, ['clean', '-d', '--force', '--quiet'])
})

test('discard all requires confirmation and then throws every change away', async () => {
  writeFileSync(path.join(repo, 'a.txt'), 'one\nMODIFIED\nthree\n')
  writeFileSync(path.join(repo, 'staged.txt'), 'will be staged\n')
  writeFileSync(path.join(repo, 'untracked.txt'), 'junk\n')
  sh(repo, ['add', 'staged.txt'])

  /* Without `confirm` it must refuse: this deletes work permanently. */
  let out = await call('discard', { cwd: repo, all: true })
  assert.equal(out.ok, false, JSON.stringify(out))
  assert.equal(out.error.code, 'confirm-required')
  assert.equal(readText(path.join(repo, 'a.txt')), 'one\nMODIFIED\nthree\n', 'nothing was touched')

  out = await call('discard', { cwd: repo, all: true, confirm: true })
  assert.equal(out.ok, true, JSON.stringify(out).slice(0, 300))

  /* Every kind of change is gone... */
  assert.equal(readText(path.join(repo, 'a.txt')), 'one\ntwo\nthree\n', 'the tracked edit was reverted')
  assert.equal(existsSync(path.join(repo, 'staged.txt')), false, 'the staged new file was removed')
  assert.equal(existsSync(path.join(repo, 'untracked.txt')), false, 'the untracked file was removed')
  assert.deepEqual(out.data.changes, [], 'the panel now shows a clean tree')
  assert.equal(out.data.operation, null, 'no half-finished operation was left behind')
})

test('discard all keeps ignored build output (it is not the user\'s edit)', async () => {
  writeFileSync(path.join(repo, '.gitignore'), 'build/\n')
  sh(repo, ['add', '.gitignore'])
  sh(repo, ['commit', '-q', '-m', 'chore: ignore build output'])
  mkdirSync(path.join(repo, 'build'), { recursive: true })
  writeFileSync(path.join(repo, 'build', 'artifact.bin'), 'compiled\n')
  writeFileSync(path.join(repo, 'stray.txt'), 'a real edit\n')

  const out = await call('discard', { cwd: repo, all: true, confirm: true })
  assert.equal(out.ok, true, JSON.stringify(out).slice(0, 300))
  assert.equal(existsSync(path.join(repo, 'build', 'artifact.bin')), true, 'ignored output was NOT deleted')
  assert.equal(existsSync(path.join(repo, 'stray.txt')), false, 'the real untracked edit was deleted')
})

test('diff returns hunks the client can render', async () => {
  /* Re-establish the edit these assertions need: the bulk tests above
     legitimately discard the whole tree, so this test must not depend on
     whatever they happened to leave behind. */
  writeFileSync(path.join(repo, 'a.txt'), 'one\nTWO\nthree\n')
  const out = await call('diff', { cwd: repo, path: 'a.txt', base: 'worktree' })
  assert.equal(out.ok, true)
  assert.match(out.data.patch, /-one|-TWO|\+TWO/)
  assert.ok(out.data.hunks.length >= 1)
  assert.equal(out.data.hunks[0].index, 0)
  assert.ok(out.data.hunks[0].added >= 1)
})

test('the diff cache never serves a stale working-tree patch', async () => {
  /* The cache is keyed by the file's mtime/size and the index mtime, so an edit
     must be visible immediately even when no watcher is running. */
  writeFileSync(path.join(repo, 'a.txt'), 'one\nFIRST VERSION\n')
  const first = await call('diff', { cwd: repo, path: 'a.txt', base: 'worktree' })
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.match(first.data.patch, /FIRST VERSION/)

  writeFileSync(path.join(repo, 'a.txt'), 'one\nSECOND VERSION\nplus an extra line\n')
  const second = await call('diff', { cwd: repo, path: 'a.txt', base: 'worktree' })
  assert.equal(second.ok, true, JSON.stringify(second))
  assert.match(second.data.patch, /SECOND VERSION/)
  assert.doesNotMatch(second.data.patch, /FIRST VERSION/)

  /* Repeat the SAME request: it may come from the cache, and the answer must be
     identical to the fresh one. */
  const again = await call('diff', { cwd: repo, path: 'a.txt', base: 'worktree' })
  assert.equal(again.data.patch, second.data.patch)
  sh(repo, ['checkout', '--', 'a.txt'])
})

test('the diff cache honours its byte budget', async () => {
  /* The cache lives in process memory; a tiny budget here proves the eviction
     loop actually runs, without generating 32 MB of patches. Each iteration
     rewrites the same tracked file with a different size, so every request is a
     NEW cache key (>1 KB of patch) and the budget must evict the older ones. */
  const original = plugin.__test.diffCacheStats()
  plugin.__test.setDiffCacheBudget(1024)
  for (let round = 0; round < 4; round += 1) {
    writeFileSync(path.join(repo, 'a.txt'), 'one\n' + ('line ' + round + '\n').repeat(200))
    const out = await call('diff', { cwd: repo, path: 'a.txt', base: 'worktree' })
    assert.equal(out.ok, true, JSON.stringify(out))
    assert.ok(out.data.patch.length > 1024, 'the patch is bigger than the whole budget')
  }
  const squeezed = plugin.__test.diffCacheStats()
  assert.ok(squeezed.entries <= 1, 'a tiny byte budget keeps at most one patch: ' + JSON.stringify(squeezed))
  assert.ok(squeezed.bytes <= 200 * 1024, 'the held patch is bounded: ' + JSON.stringify(squeezed))
  plugin.__test.setDiffCacheBudget(original.maxBytes)
  sh(repo, ['checkout', '--', 'a.txt'])
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
  /* Assert on a FRESH file, and remove it before asserting: `new.txt` used to be
     deleted at the end, so a leftover from an earlier run (or a file the same
     name written by a concurrent test) made this flaky in both directions. */
  const target = path.join(repo, 'untracked-diff-probe.txt')
  try { rmSync(target, { force: true }) } catch { /* already gone */ }
  writeFileSync(target, 'hello\nworld\n')
  const out = await call('untrackedDiff', { cwd: repo, path: 'untracked-diff-probe.txt' })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.match(out.data.patch, /\+hello/)
  assert.equal(out.data.binary, false)
  rmSync(target, { force: true })
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

test('stash push --staged leaves unstaged edits in the worktree', async () => {
  sh(repo, ['checkout', '--', 'a.txt', 'b.txt'])
  writeFileSync(path.join(repo, 'a.txt'), 'staged part\n')
  sh(repo, ['add', 'a.txt'])
  writeFileSync(path.join(repo, 'b.txt'), 'unstaged part\n')

  const out = await call('stashPush', { cwd: repo, message: 'staged only', staged: true })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.data.snapshot.changes.some((entry) => entry.path === 'a.txt'), false, 'the staged file left the worktree')
  const changed = out.data.snapshot.changes.find((entry) => entry.path === 'b.txt')
  assert.ok(changed, 'the other unstaged file remains')
  assert.equal(changed.staged, false)
  assert.equal(readText(path.join(repo, 'b.txt')), 'unstaged part\n')

  const list = await call('stashList', { cwd: repo })
  assert.equal(list.ok, true)
  assert.ok(list.data.stash.some((entry) => /staged only/.test(entry.subject)))
  const pop = await call('stashPop', { cwd: repo, index: 0 })
  assert.equal(pop.ok, true, JSON.stringify(pop))
  sh(repo, ['checkout', '--', 'a.txt', 'b.txt'])
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

test('discard restores a conflicted path to its HEAD version', async () => {
  /* Regression: `git restore --worktree -- <path>` refuses an unmerged path with
     "error: path '<p>' is unmerged", so discarding a conflicted file always
     failed. Discard must rewrite index AND worktree from HEAD for those paths. */
  sh(repo, ['checkout', '-q', '-b', 'discard-topic', 'main'])
  writeFileSync(path.join(repo, 'unmerged.txt'), 'topic discard\n')
  sh(repo, ['add', 'unmerged.txt'])
  sh(repo, ['commit', '-q', '-m', 'feat: unmerged.txt on the topic side'])
  sh(repo, ['checkout', '-q', 'main'])
  writeFileSync(path.join(repo, 'unmerged.txt'), 'main discard\n')
  sh(repo, ['add', 'unmerged.txt'])
  sh(repo, ['commit', '-q', '-m', 'feat: unmerged.txt on main'])
  const headContent = readText(path.join(repo, 'unmerged.txt'))

  const merged = await call('merge', { cwd: repo, rev: 'discard-topic' })
  assert.equal(merged.ok, true, 'merge must be able to run: ' + JSON.stringify(merged).slice(0, 300))
  assert.equal(merged.data.conflicted, true)
  assert.ok(merged.data.snapshot.conflictedFiles.includes('unmerged.txt'), 'merge left a UU path')
  const before = merged.data.snapshot.changes.find((entry) => entry.path === 'unmerged.txt')
  assert.ok(before !== undefined)
  assert.equal(before.conflicted, true)
  assert.equal(before.kind, 'conflicted')

  const out = await call('discard', { cwd: repo, paths: ['unmerged.txt'] })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.deepEqual(out.data.conflictedFiles, [], 'no unmerged path is left')
  assert.equal(out.data.changes.some((entry) => entry.path === 'unmerged.txt'), false, 'path is clean')
  assert.equal(out.data.operation, 'merge', 'the merge is still in progress, only the conflict is gone')
  assert.equal(sh(repo, ['status', '--porcelain', '--', 'unmerged.txt']).trim(), '')
  assert.equal(sh(repo, ['diff', '--name-only', '--diff-filter=U']).trim(), '', 'no unmerged index stages')
  assert.equal(readText(path.join(repo, 'unmerged.txt')), headContent, "file content is HEAD's version")

  // Leave the shared fixture repository the way this test found it.
  sh(repo, ['merge', '--abort'])
  sh(repo, ['checkout', '-q', 'main'])
  sh(repo, ['branch', '-D', 'discard-topic'])
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

/* ------------------------------------------------------------------ tag undo */

/** Run a git command in the bare remote and return its stdout. */
const remoteTags = () => sh(remote, ['for-each-ref', '--format=%(refname:short)', 'refs/tags']).split('\n').filter((line) => line.trim() !== '')

test('tagPush publishes exactly one tag; other local tags stay unpublished', async () => {
  await call('tagCreate', { cwd: repo, name: 'push-one' })
  await call('tagCreate', { cwd: repo, name: 'push-two' })

  const out = await call('tagPush', { cwd: repo, name: 'push-one' })
  assert.equal(out.ok, true, JSON.stringify(out))

  const onRemote = remoteTags()
  assert.ok(onRemote.includes('push-one'), 'the pushed tag reached the remote: ' + JSON.stringify(onRemote))
  assert.equal(onRemote.includes('push-two'), false, 'a sibling tag must not be swept along: ' + JSON.stringify(onRemote))
})

test('tagReset removes a tag locally AND on the remote, leaving commits intact', async () => {
  await call('tagCreate', { cwd: repo, name: 'revoke-me' })
  await call('tagPush', { cwd: repo, name: 'revoke-me' })
  assert.ok(remoteTags().includes('revoke-me'), 'precondition: the tag is published')
  const headBefore = sh(repo, ['rev-parse', 'HEAD']).trim()

  /* remoteToo defaults to "wherever it already is", i.e. both. */
  const out = await call('tagReset', { cwd: repo, name: 'revoke-me' })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.data.removedRemote, true)

  const branches = await call('branches', { cwd: repo })
  assert.equal(branches.data.branches.some((entry) => entry.kind === 'tag' && entry.name === 'revoke-me'), false,
    'the local tag is gone')
  assert.equal(remoteTags().includes('revoke-me'), false, 'the remote tag is gone')
  /* Undoing a tag is a REF operation: history must not move. */
  assert.equal(sh(repo, ['rev-parse', 'HEAD']).trim(), headBefore, 'HEAD did not move')
})

test('tagReset with remoteToo:false keeps the published tag (and it survives a fetch)', async () => {
  await call('tagCreate', { cwd: repo, name: 'local-only-undo' })
  await call('tagPush', { cwd: repo, name: 'local-only-undo' })

  const out = await call('tagReset', { cwd: repo, name: 'local-only-undo', remoteToo: false })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.data.removedRemote, false)

  let branches = await call('branches', { cwd: repo })
  assert.equal(branches.data.branches.some((entry) => entry.name === 'local-only-undo'), false, 'local ref removed')
  assert.ok(remoteTags().includes('local-only-undo'), 'the remote copy is intentionally kept')

  /* ...and the doc-worthy consequence: it comes back on the next tag fetch. */
  await call('fetch', { cwd: repo, tags: true })
  branches = await call('branches', { cwd: repo })
  assert.ok(branches.data.branches.some((entry) => entry.kind === 'tag' && entry.name === 'local-only-undo'),
    'a fetch --tags restores the still-published tag, which is why remoteToo defaults on')

  /* Clean up so later tests see a bare remote. */
  await call('tagReset', { cwd: repo, name: 'local-only-undo', remoteToo: true })
  assert.equal(remoteTags().includes('local-only-undo'), false)
})

test('tagReset rejects an unknown tag instead of reporting success', async () => {
  const out = await call('tagReset', { cwd: repo, name: 'never-existed' })
  assert.equal(out.ok, false, JSON.stringify(out))
  assert.equal(out.error.code, 'tag-not-found')
  assert.match(out.error.message, /never-existed/)
  /* A rejected undo must not have created anything on the remote. */
  assert.equal(remoteTags().includes('never-existed'), false)
})

test('snapshot carries the ahead/behind counts the toolbar dots are driven by', async () => {
  /* A commit that is not pushed yet -> ahead > 0, so Push lights up. */
  writeFileSync(path.join(repo, 'dot.txt'), 'unpushed\n')
  sh(repo, ['add', 'dot.txt'])
  sh(repo, ['commit', '-q', '-m', 'feat: unpushed for the dot test'])
  let out = await call('snapshot', { cwd: repo })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.data.ahead, 1, 'one unpushed commit')
  assert.equal(out.data.behind, 0)

  await call('push', { cwd: repo })
  out = await call('snapshot', { cwd: repo })
  assert.equal(out.data.ahead, 0, 'a push clears the dot')
  assert.equal(out.data.behind, 0)
})

test('fetch still succeeds when ONE unrelated remote is unreachable', async () => {
  /*
   * THE REPORTED BUG: "有时候获取时会报错".
   *
   * `git fetch --all` is all-or-nothing: one dead second remote makes git exit
   * non-zero even though origin fetched perfectly, and the panel showed the
   * whole fetch as failed. It looked random because the cause was an unrelated
   * remote. The host now fetches each remote separately and reports a PARTIAL
   * result instead of an error.
   */
  sh(repo, ['remote', 'add', 'broken-mirror', path.join(sandbox, 'no-such-remote.git')])
  try {
    const out = await call('fetch', { cwd: repo })
    assert.equal(out.ok, true, 'a healthy origin must not be reported as a failure: ' + JSON.stringify(out).slice(0, 300))
    assert.equal(out.data.partial, true, 'the dead mirror is reported as partial')
    assert.ok(out.data.failedRemotes.some((entry) => entry.remote === 'broken-mirror'), JSON.stringify(out.data.failedRemotes))
    assert.ok(out.data.succeededRemotes.includes('origin'), JSON.stringify(out.data.succeededRemotes))
    /* The snapshot still comes back, so the panel never loses its state. */
    assert.equal(typeof out.data.snapshot.root, 'string')

    /* Fetching ONLY the good remote is a clean success, not a partial one. */
    const single = await call('fetch', { cwd: repo, remote: 'origin' })
    assert.equal(single.ok, true)
    assert.equal(single.data.partial, false)
  } finally {
    sh(repo, ['remote', 'remove', 'broken-mirror'])
  }
})

test('fetch on a repository with no remote says so instead of failing obscurely', async () => {
  const noRemote = path.join(sandbox, 'lonely')
  mkdirSync(noRemote, { recursive: true })
  sh(noRemote, ['init', '-q', '-b', 'main'])
  const out = await call('fetch', { cwd: noRemote })
  assert.equal(out.ok, false)
  assert.equal(out.error.code, 'no-remote', JSON.stringify(out.error))
})

test('fetch fails when EVERY remote is unreachable (that is a real failure)', async () => {
  sh(repo, ['remote', 'rename', 'origin', 'origin-away'])
  sh(repo, ['remote', 'set-url', 'origin-away', path.join(sandbox, 'gone.git')])
  try {
    const out = await call('fetch', { cwd: repo })
    assert.equal(out.ok, false)
    assert.equal(out.error.code, 'fetch-failed')
    assert.match(out.error.message, /origin-away/)
  } finally {
    sh(repo, ['remote', 'set-url', 'origin-away', remote])
    sh(repo, ['remote', 'rename', 'origin-away', 'origin'])
  }
})

test('log and branches are cached, and a write makes the cache stale immediately', async () => {
  /*
   * Switching Changes -> History -> Branches used to pay a full git spawn every
   * time (~110 ms each on a cold Windows profile). Both lists are now cached on
   * the watcher revision, which is what makes tab switching instant. The cache
   * MUST NOT survive a write, or the panel would show a commit list without the
   * commit it just made.
   *
   * Timing is the observable here: a cached answer is orders of magnitude
   * cheaper than a spawn, and `Date.now()` around it is unambiguous.
   */
  const timeOf = async (promise) => {
    const t0 = Date.now()
    const value = await promise
    return { ms: Date.now() - t0, value }
  }

  /* Warm it once so a missing watcher does not skew the comparison. */
  await call('log', { cwd: repo, limit: 20 })
  await call('log', { cwd: repo, limit: 20 })
  /* The observable is "no git spawn", not "faster than the previous call": a
     cached answer is sub-millisecond, while ANY spawn costs ~100 ms here. Using
     an absolute bound avoids depending on which run happened to be cold. */
  const cached = await timeOf(call('log', { cwd: repo, limit: 20 }))
  assert.equal(cached.value.ok, true)
  assert.ok(cached.ms < 40, 'a cached log answers without spawning git: ' + cached.ms + ' ms')

  await call('branches', { cwd: repo })
  const branchesFast = await timeOf(call('branches', { cwd: repo }))
  assert.equal(branchesFast.value.ok, true)
  assert.ok(branchesFast.ms < 40, 'a cached branch list answers without spawning git: ' + branchesFast.ms + ' ms')

  /* A commit must invalidate both. */
  writeFileSync(path.join(repo, 'cache-probe.txt'), 'x\n')
  await call('stage', { cwd: repo, paths: ['cache-probe.txt'] })
  const commit = await call('commit', { cwd: repo, message: 'test: cache invalidation probe' })
  assert.equal(commit.ok, true, JSON.stringify(commit).slice(0, 200))

  const afterCommit = await call('log', { cwd: repo, limit: 20 })
  assert.match(afterCommit.data.commits[0].subject, /cache invalidation probe/,
    'the commit list reflects the new commit immediately')

  /* A new tag must show up in the branch/tag list immediately too. */
  await call('tagCreate', { cwd: repo, name: 'cache-probe-tag' })
  const afterTag = await call('branches', { cwd: repo })
  assert.ok(afterTag.data.branches.some((entry) => entry.name === 'cache-probe-tag'),
    'the ref list is not stale after a write')
  await call('tagDelete', { cwd: repo, name: 'cache-probe-tag' })
})

test('search finds files by name and by content', async () => {
  /* Name mode: substring, ranked with basename hits first. */
  writeFileSync(path.join(repo, 'searchable-alpha.txt'), 'alpha content here\n')
  mkdirSync(path.join(repo, 'searchable-dir'), { recursive: true })
  writeFileSync(path.join(repo, 'searchable-dir', 'notes.md'), 'nothing to see\n')
  sh(repo, ['add', '.'])
  sh(repo, ['commit', '-q', '-m', 'test: add search fixtures'])

  let out = await call('search', { cwd: repo, query: 'searchable-alpha', mode: 'name' })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.data.mode, 'name')
  assert.ok(out.data.files.some((file) => file.path === 'searchable-alpha.txt'), JSON.stringify(out.data.files))

  /* A query that only matches a DIRECTORY segment must still find the file. */
  out = await call('search', { cwd: repo, query: 'searchable-dir', mode: 'name' })
  assert.ok(out.data.files.some((file) => file.path === 'searchable-dir/notes.md'), JSON.stringify(out.data.files))

  /* Case-insensitive by default, case-sensitive on request. */
  out = await call('search', { cwd: repo, query: 'SEARCHABLE-ALPHA', mode: 'name' })
  assert.ok(out.data.files.length > 0, 'case-insensitive by default')
  out = await call('search', { cwd: repo, query: 'SEARCHABLE-ALPHA', mode: 'name', caseSensitive: true })
  assert.equal(out.data.files.length, 0, 'caseSensitive is honoured')

  /* Content mode: reports path + line + the matching text. */
  out = await call('search', { cwd: repo, query: 'alpha content here', mode: 'content' })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.data.mode, 'content')
  const hit = out.data.matches.find((match) => match.path === 'searchable-alpha.txt')
  assert.ok(hit !== undefined, JSON.stringify(out.data.matches).slice(0, 300))
  assert.equal(hit.line, 1, 'the line number is 1-based')
  assert.match(hit.text, /alpha content here/)

  /* A query with no match is DATA, not an error (git grep exits 1). */
  out = await call('search', { cwd: repo, query: 'zzz-definitely-not-present', mode: 'content' })
  assert.equal(out.ok, true, 'no match must not be reported as a failure: ' + JSON.stringify(out.error))
  assert.deepEqual(out.data.matches, [])

  /* An empty query short-circuits instead of scanning the whole tree. */
  out = await call('search', { cwd: repo, query: '   ' })
  assert.equal(out.ok, true)
  assert.deepEqual(out.data.files, [])
  assert.deepEqual(out.data.matches, [])
})

test('fileHistory follows renames and reports per-commit line counts', async () => {
  /*
   * Two things make a file's history useful and both were missing:
   *   - `--follow`, without which the commits before a RENAME are invisible and
   *     the history looks like it started yesterday;
   *   - per-commit +/- counts, so a row says how big each change was.
   */
  const original = path.join(repo, 'renamed-file.txt')
  writeFileSync(original, 'line one\nline two\n')
  sh(repo, ['add', 'renamed-file.txt'])
  sh(repo, ['commit', '-q', '-m', 'test: create renamed-file'])

  writeFileSync(original, 'line one\nline two\nline three\n')
  sh(repo, ['commit', '-q', '-am', 'test: add a line to renamed-file'])

  /* Rename WITHOUT changing the content, so this commit is a pure rename. */
  sh(repo, ['mv', 'renamed-file.txt', 'renamed-now.txt'])
  sh(repo, ['commit', '-q', '-m', 'test: rename the file'])

  const out = await call('fileHistory', { cwd: repo, path: 'renamed-now.txt' })
  assert.equal(out.ok, true, JSON.stringify(out).slice(0, 300))
  assert.equal(out.data.path, 'renamed-now.txt')
  const subjects = out.data.commits.map((commit) => commit.subject)
  assert.ok(subjects.includes('test: rename the file'), JSON.stringify(subjects))
  assert.ok(subjects.includes('test: add a line to renamed-file'),
    '--follow must reach back past the rename: ' + JSON.stringify(subjects))
  assert.ok(subjects.includes('test: create renamed-file'),
    'the original creation commit is part of the history: ' + JSON.stringify(subjects))

  /* The commit that added one line reports +1 on THIS file only. */
  const added = out.data.commits.find((commit) => commit.subject === 'test: add a line to renamed-file')
  assert.equal(added.added, 1, JSON.stringify(added))
  assert.equal(added.deleted, 0)

  /* Every row carries the fields the UI renders. */
  for (const commit of out.data.commits) {
    assert.equal(typeof commit.hash, 'string')
    assert.equal(typeof commit.short, 'string')
    assert.equal(typeof commit.authorName, 'string')
    assert.equal(typeof commit.authorTime, 'number')
    assert.equal(typeof commit.added, 'number')
    assert.equal(typeof commit.deleted, 'number')
  }

  /* A path with no history is empty data, not an error. */
  const none = await call('fileHistory', { cwd: repo, path: 'never-existed.txt' })
  assert.equal(none.ok, true, JSON.stringify(none.error))
  assert.deepEqual(none.data.commits, [])
})

test('a text file is never flagged binary just because a sibling was', async () => {
  /*
   * THE REPORTED BUG: "为什么记录中是显示二进制文件呢，应该是有修改记录的".
   *
   * `git log --numstat` reports a binary file as `-\t-`. The first version of
   * `applyNumstat` summed the WHOLE commit block, so any commit that also
   * touched a font/image marked the purely textual source file as binary — and
   * its line counts were never added either.
   *
   * Both halves matter: `binary` must be false AND the counts must be right.
   */
  const textFile = path.join(repo, 'mixed-a.c')
  writeFileSync(textFile, 'int a = 0;\n')
  sh(repo, ['add', 'mixed-a.c'])
  sh(repo, ['commit', '-q', '-m', 'test: create mixed-a.c'])

  /* One commit that edits the source AND adds a binary asset. */
  writeFileSync(textFile, 'int a = 0;\nint b = 1;\n')
  writeFileSync(path.join(repo, 'mixed-asset.bin'), Buffer.from([0, 1, 2, 0, 255, 7, 9]))
  sh(repo, ['add', '.'])
  sh(repo, ['commit', '-q', '-m', 'test: edit source and add a binary asset'])

  const out = await call('fileHistory', { cwd: repo, path: 'mixed-a.c' })
  assert.equal(out.ok, true, JSON.stringify(out).slice(0, 300))
  const withBinary = out.data.commits.find((commit) => commit.subject === 'test: edit source and add a binary asset')
  assert.ok(withBinary !== undefined, JSON.stringify(out.data.commits.map((c) => c.subject)))
  assert.equal(withBinary.binary, false, 'a text file must not inherit a sibling\'s binary flag')
  assert.equal(withBinary.added, 1, 'and its own line count must still be counted')
  assert.equal(withBinary.deleted, 0)

  /* Nothing else in this text file's history may be flagged either. */
  assert.deepEqual(out.data.commits.filter((c) => c.binary).map((c) => c.subject), [])
})

test('a genuinely binary file still reports binary (the flag is not just disabled)', async () => {
  /* The obvious over-correction would be to stop setting `binary` at all. */
  writeFileSync(path.join(repo, 'real-binary.bin'), Buffer.from([0, 255, 1, 254, 0, 42]))
  sh(repo, ['add', 'real-binary.bin'])
  sh(repo, ['commit', '-q', '-m', 'test: add a real binary'])

  const out = await call('fileHistory', { cwd: repo, path: 'real-binary.bin' })
  assert.equal(out.ok, true, JSON.stringify(out).slice(0, 300))
  assert.equal(out.data.commits.length, 1)
  assert.equal(out.data.commits[0].binary, true, 'a real binary file must say so')
})

test('fileHistory survives a BRACE-form rename (dir/{old => new}/file)', async () => {
  /*
   * git does not always print `old => new`. When only a DIRECTORY changes, the
   * numstat row is `src/{old => new}/keep.md` — a form that a naive
   * `split('=>')` turns into `src/{old` and `new}/keep.md`, neither of which is
   * a real path. The filter then matches nothing and every count silently
   * becomes 0, which looks exactly like "no changes".
   */
  mkdirSync(path.join(repo, 'brace-old'), { recursive: true })
  writeFileSync(path.join(repo, 'brace-old', 'keep.md'), 'one\ntwo\n')
  sh(repo, ['add', '.'])
  sh(repo, ['commit', '-q', '-m', 'test: create brace-old/keep.md'])

  mkdirSync(path.join(repo, 'brace-new'), { recursive: true })
  sh(repo, ['mv', 'brace-old/keep.md', 'brace-new/keep.md'])
  sh(repo, ['commit', '-q', '-m', 'test: move keep.md between directories'])

  writeFileSync(path.join(repo, 'brace-new', 'keep.md'), 'one\ntwo\nthree\n')
  sh(repo, ['commit', '-q', '-am', 'test: add a third line'])

  const out = await call('fileHistory', { cwd: repo, path: 'brace-new/keep.md' })
  assert.equal(out.ok, true, JSON.stringify(out).slice(0, 300))
  const subjects = out.data.commits.map((commit) => commit.subject)
  assert.ok(subjects.includes('test: create brace-old/keep.md'),
    'the pre-move commit must still be in the history: ' + JSON.stringify(subjects))

  const created = out.data.commits.find((commit) => commit.subject === 'test: create brace-old/keep.md')
  assert.equal(created.added, 2, 'the creation commit still counts its 2 lines (old path)')
  const renamed = out.data.commits.find((commit) => commit.subject === 'test: move keep.md between directories')
  assert.equal(renamed.added + renamed.deleted, 0, 'the move itself changed no lines')
})

test('tagRemoteState says which tags still need publishing', async () => {
  /*
   * Tags have no remote-tracking ref, so "is this tag published?" is only
   * answerable by the remote. The panel needs it to decide where to show a
   * publish button.
   */
  await call('tagCreate', { cwd: repo, name: 'published-tag' })
  await call('tagCreate', { cwd: repo, name: 'local-only-tag' })
  await call('tagPush', { cwd: repo, name: 'published-tag' })

  const out = await call('tagRemoteState', { cwd: repo })
  assert.equal(out.ok, true, JSON.stringify(out).slice(0, 300))
  assert.deepEqual(out.data.remotes, ['origin'])
  assert.deepEqual(out.data.published['published-tag'], ['origin'], 'the pushed tag is reported on origin')
  assert.equal(out.data.published['local-only-tag'], undefined, 'the local-only tag is not reported as published')
  assert.ok(out.data.localTags.includes('published-tag'))
  assert.ok(out.data.localTags.includes('local-only-tag'))
  assert.ok(out.data.unpublished.includes('local-only-tag'), JSON.stringify(out.data.unpublished))
  assert.equal(out.data.unpublished.includes('published-tag'), false)
  assert.deepEqual(out.data.failures, [])

  /* Publishing it moves it out of the unpublished set. */
  await call('tagPush', { cwd: repo, name: 'local-only-tag' })
  const after = await call('tagRemoteState', { cwd: repo })
  assert.equal(after.data.unpublished.includes('local-only-tag'), false)
  assert.deepEqual(after.data.published['local-only-tag'], ['origin'])
})

test('tagPush publishes exactly one tag and leaves a sibling local', async () => {
  await call('tagCreate', { cwd: repo, name: 'one-tag' })
  await call('tagCreate', { cwd: repo, name: 'two-tag' })
  const out = await call('tagPush', { cwd: repo, name: 'one-tag' })
  assert.equal(out.ok, true, JSON.stringify(out).slice(0, 300))
  /* The whole point: the sibling must NOT be swept along the way `--tags` would. */
  const state = await call('tagRemoteState', { cwd: repo })
  assert.ok(state.data.published['one-tag'] !== undefined)
  assert.equal(state.data.published['two-tag'], undefined, JSON.stringify(state.data.published))
})

test('blame pairs every line with ITS commit author, even when a commit reappears', async () => {
  /* `--porcelain` prints a commit's author block only ONCE; if the same old commit
     owns lines on both sides of a newer edit, a naive parser inherits the middle
     author for the trailing block. This is the "作者和哈希值对不上" bug. */
  const file = 'blame-mix.txt'
  writeFileSync(path.join(repo, file), 'one\ntwo\nthree\nfour\n')
  sh(repo, ['add', file])
  sh(repo, ['-c', 'user.name=Base Author', '-c', 'user.email=base@example.com', 'commit', '-q', '-m', 'base: add mix file'])
  writeFileSync(path.join(repo, file), 'one\nTWO CHANGED\nTHREE CHANGED\nfour\n')
  sh(repo, ['add', file])
  sh(repo, ['-c', 'user.name=Middle Author', '-c', 'user.email=middle@example.com', 'commit', '-q', '-m', 'middle: change two lines'])

  const out = await call('blame', { cwd: repo, path: file })
  assert.equal(out.ok, true, JSON.stringify(out))
  const rows = out.data.lines
  assert.equal(rows.length, 4)
  for (const row of rows) assert.ok(String(row.author).trim() !== '', 'every line names an author')

  const byHash = new Map()
  for (const row of rows) {
    const hash = String(row.hash)
    if (byHash.has(hash)) assert.equal(byHash.get(hash), row.author, 'the same commit must always name the same author')
    else byHash.set(hash, row.author)
  }
  /* The untouched first and last lines belong to the SAME old commit, and that
     commit appears non-contiguously in the output. */
  assert.equal(rows[0].hash, rows[3].hash)
  assert.equal(rows[0].author, 'Base Author')
  assert.equal(rows[3].author, 'Base Author')
  assert.equal(rows[1].author, 'Middle Author')
  rmSync(path.join(repo, file), { force: true })
  sh(repo, ['add', '-A'])
  sh(repo, ['-c', 'user.name=Base Author', '-c', 'user.email=base@example.com', 'commit', '-q', '-m', 'cleanup: drop blame mix file'])
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

test('commitDetail returns a clean body, with no record separator glued on', async () => {
  /*
   * The pretty format ends with `%x1e`, so `%B` (the LAST field) came back with
   * that control character still attached. It rendered as an invisible char in
   * the commit popup and, worse, broke the "body is the same as the subject"
   * check — so a commit without a body echoed its subject twice.
   */
  writeFileSync(path.join(repo, 'body-probe.txt'), 'x\n')
  sh(repo, ['add', 'body-probe.txt'])
  sh(repo, ['commit', '-q', '-m', 'test: body probe', '-m', 'Second paragraph.'])

  const withBody = await call('commitDetail', { cwd: repo, rev: 'HEAD' })
  assert.equal(withBody.ok, true, JSON.stringify(withBody).slice(0, 300))
  assert.doesNotMatch(withBody.data.body, /\u001e/, 'the record separator must be stripped')
  assert.match(withBody.data.body, /Second paragraph\./)
  assert.equal(withBody.data.body.endsWith('\n'), false, 'no trailing newline is kept')

  /* A subject-only commit must report an EMPTY body so the UI can skip it. */
  sh(repo, ['commit', '-q', '--allow-empty', '-m', 'test: subject only'])
  const noBody = await call('commitDetail', { cwd: repo, rev: 'HEAD' })
  assert.equal(noBody.ok, true)
  assert.equal(noBody.data.body.trim(), '', 'a body-less commit reports no extra body, got: '
    + JSON.stringify(noBody.data.body))
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

test('ignore adds an anchored root .gitignore rule and untracks without deleting', async () => {
  writeFileSync(path.join(repo, 'ignored-probe.txt'), 'tracked probe\n')
  sh(repo, ['add', 'ignored-probe.txt'])
  sh(repo, ['commit', '-q', '-m', 'test: ignored probe'])

  const tracked = await call('ignore', { cwd: repo, path: 'ignored-probe.txt' })
  assert.equal(tracked.ok, true, JSON.stringify(tracked).slice(0, 400))
  assert.equal(tracked.data.tracked, true)
  assert.equal(existsSync(path.join(repo, 'ignored-probe.txt')), true, 'the working file must survive')
  assert.equal(sh(repo, ['ls-files', '--', 'ignored-probe.txt']).trim(), '', 'the path must leave the index')
  assert.match(readText(path.join(repo, '.gitignore')), /^\/ignored-probe\.txt$/m)

  writeFileSync(path.join(repo, 'scratch-ignore.tmp'), 'scratch\n')
  const untracked = await call('ignore', { cwd: repo, path: 'scratch-ignore.tmp' })
  assert.equal(untracked.ok, true, JSON.stringify(untracked).slice(0, 400))
  assert.equal(untracked.data.tracked, false)
  const ignored = sh(repo, ['check-ignore', '-q', '--', 'scratch-ignore.tmp'])
  assert.equal(ignored, '')
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

test('every method that mutates refs or the index is serialised per repository', async () => {
  /*
   * WRITE_METHODS is what routes a call through withRepoLock. A mutator missing
   * from it races the panel's own polling and hunk staging against a concurrent
   * `git` process — the symptom is an intermittent failure in an unrelated test
   * (stageHunk failed exactly once this way). Assert the set covers the
   * operations instead of trusting whoever added the last method.
   */
  const src = await import('node:fs').then(({ readFileSync }) => readFileSync(new URL('../src/index.js', import.meta.url), 'utf8'))
  const setBody = /const WRITE_METHODS = new Set\(\[([\s\S]*?)\]\)/.exec(src)
  assert.ok(setBody !== null, 'WRITE_METHODS is declared as one Set literal')
  const listed = new Set([...setBody[1].matchAll(/'([^']+)'/g)].map((m) => m[1]))

  /* Every exported handler that runs a ref/index-mutating git command. */
  const MUST_BE_LOCKED = [
    'stage', 'unstage', 'discard', 'stageHunk', 'unstageHunk', 'discardHunk',
    'commit', 'amend', 'cherryPick', 'revert', 'reset', 'checkout',
    'branchCreate', 'branchDelete', 'merge', 'rebase', 'fetch', 'pull', 'push',
    'pushTags', 'tagCreate', 'tagDelete', 'tagDeleteRemote', 'tagPush', 'tagReset',
    'stashPush', 'stashDrop', 'conflictResolve', 'cleanUntracked', 'ignore',
  ]
  const missing = MUST_BE_LOCKED.filter((name) => !listed.has(name))
  assert.deepEqual(missing, [], 'these mutators are not routed through the repo lock: ' + missing.join(', '))
})

test('repoRoot pins the repository and refuses a cwd outside it', async () => {
  const out = await call('snapshot', { cwd: sandbox, repoRoot: repo })
  assert.equal(out.ok, true, JSON.stringify(out))
  const bad = await call('snapshot', { cwd: sandbox, repoRoot: remote })
  assert.equal(bad.ok, false)
})
