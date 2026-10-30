/**
 * Workspace-discovery tests: the repo picker must see EVERY repository inside
 * the session workspace, not only the one under the session cwd.
 *
 * Run:  node --test tests/workspace.test.mjs
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const plugin = await import('../src/index.js')

let server
let baseUrl
let sandbox
let workspace

function sh(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function makeRepo(dir, message) {
  mkdirSync(dir, { recursive: true })
  sh(dir, ['init', '-q', '-b', 'main'])
  sh(dir, ['config', 'user.name', 'WS Tester'])
  sh(dir, ['config', 'user.email', 'ws@example.com'])
  writeFileSync(path.join(dir, 'file.txt'), message + '\n')
  sh(dir, ['add', '.'])
  sh(dir, ['commit', '-q', '-m', message])
}

/**
 * Call one RPC method over the in-test HTTP server.
 *
 * `connection: close` matters: Node's global fetch keeps sockets alive, and this
 * server is created per test file with its own keep-alive timing, so a pooled
 * socket can be reset underneath a later request (`read ECONNRESET`). That
 * failure used to look like a flaky assertion — it was the transport, not the
 * panel. One retry covers the remaining edge (a close racing the next request).
 */
async function callOnce(method, payload) {
  const res = await fetch(`${baseUrl}/dsh-gitcraft/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', connection: 'close' },
    body: JSON.stringify(payload),
  })
  const json = await res.json()
  return { status: res.status, ...json }
}

async function call(method, payload) {
  try {
    return await callOnce(method, payload)
  } catch (error) {
    const code = error !== null && error !== undefined && error.cause !== undefined ? error.cause.code : undefined
    if (code !== 'ECONNRESET' && code !== 'EPIPE') throw error
    return callOnce(method, payload)
  }
}

before(async () => {
  sandbox = mkdtempSync(path.join(tmpdir(), 'gwc-ws-'))
  /* GitHub's Windows runners hand out TMP as an 8.3 short path
     (C:\Users\RUNNER~1\...), while git reports the long form. The host now
     canonicalises before comparing; pin the fixture to its long form too so a
     regression in that comparison cannot be masked by the fixture layout. */
  sandbox = realpathSync(sandbox)
  // A workspace that is NOT itself a repository and holds several repositories
  // at different depths, plus decoys that must be skipped.
  workspace = path.join(sandbox, 'workspace')
  mkdirSync(workspace, { recursive: true })
  makeRepo(path.join(workspace, 'app'), 'feat: app')
  makeRepo(path.join(workspace, 'libs', 'core'), 'feat: core')
  makeRepo(path.join(workspace, 'libs', 'ui'), 'feat: ui')
  makeRepo(path.join(workspace, 'deep', 'a', 'b', 'inner'), 'feat: inner')
  // decoys: a skipped directory that DOES hold a repo, and a plain directory
  makeRepo(path.join(workspace, 'node_modules', 'dep'), 'feat: dependency')
  mkdirSync(path.join(workspace, 'plain', 'nested'), { recursive: true })
  writeFileSync(path.join(workspace, 'plain', 'nested', 'note.txt'), 'hi\n')

  let captured = null
  const ctx = {
    effect(fn) { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose() } },
    webServer: {
      register({ kind, path: routePath, handler }) {
        captured = { kind, path: routePath, handler }
        return () => { captured = null }
      },
    },
    inject() { return { dispose() {} } },
  }
  plugin.apply(ctx, { timeoutMs: 30000 })
  assert.ok(captured !== null)
  server = createServer((req, res) => { void captured.handler(req, res) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  if (server !== undefined) await new Promise((resolve) => server.close(resolve))
  if (sandbox !== undefined) rmSync(sandbox, { recursive: true, force: true })
})

test('workspace scans every repository under the workspace root', async () => {
  const out = await call('workspace', { cwd: workspace })
  assert.equal(out.ok, true, JSON.stringify(out).slice(0, 400))
  const relatives = out.data.repos.map((entry) => entry.relative).sort()
  assert.deepEqual(relatives, ['app', 'deep/a/b/inner', 'libs/core', 'libs/ui'])
  assert.equal(out.data.workspaceIsRepo, false)
  assert.equal(out.data.truncated, false)
  for (const entry of out.data.repos) {
    assert.equal(entry.branch, 'main')
    assert.equal(typeof entry.headShort, 'string')
    assert.ok(entry.headShort.length >= 7)
  }
})

test('workspace scan skips node_modules and other noise directories', async () => {
  const out = await call('workspace', { cwd: workspace })
  assert.equal(out.data.repos.some((entry) => entry.relative.includes('node_modules')), false)
})

test('workspace scan starts from the session cwd but reports the whole workspace', async () => {
  // The session cwd is one repository; the scan must still see the siblings.
  const out = await call('workspace', { cwd: path.join(workspace, 'app') })
  assert.equal(out.ok, true, JSON.stringify(out).slice(0, 300))
  // The workspace root is the cwd here, so only what is under it is listed.
  assert.equal(out.data.repos.some((entry) => entry.relative === '.'), true)
})

test('workspace lists the root itself when the workspace is a repository', async () => {
  const solo = path.join(sandbox, 'solo')
  makeRepo(solo, 'feat: solo')
  const out = await call('workspace', { cwd: solo })
  assert.equal(out.ok, true)
  assert.equal(out.data.workspaceIsRepo, true)
  assert.equal(out.data.repos[0].relative, '.')
  assert.equal(out.data.repos[0].branch, 'main')
})

test('workspace returns one level of subdirectories for drilling in', async () => {
  const out = await call('workspace', { cwd: workspace })
  const names = out.data.dirs.map((entry) => entry.name).sort()
  assert.deepEqual(names, ['app', 'deep', 'libs', 'plain'])
  const app = out.data.dirs.find((entry) => entry.name === 'app')
  assert.equal(app.isRepo, true)
  const plain = out.data.dirs.find((entry) => entry.name === 'plain')
  assert.equal(plain.isRepo, false)
})

test('browse walks down a level and marks repositories', async () => {
  const out = await call('browse', { cwd: workspace, dir: path.join(workspace, 'libs') })
  assert.equal(out.ok, true, JSON.stringify(out).slice(0, 300))
  assert.equal(out.data.isRepo, false)
  assert.equal(out.data.insideRepo, null)
  const names = out.data.dirs.map((entry) => entry.name).sort()
  assert.deepEqual(names, ['core', 'ui'])
  assert.ok(out.data.dirs.every((entry) => entry.isRepo === true))
  assert.equal(out.data.parent, workspace.split('\\').join('/'))
})

test('browse reports when the directory is itself a repository', async () => {
  const out = await call('browse', { cwd: workspace, dir: path.join(workspace, 'app') })
  assert.equal(out.data.isRepo, true)
  assert.equal(out.data.parent !== null, true)
})

test('browse can leave the workspace and list any directory on disk', async () => {
  /* The picker is a file dialog (SourceTree behaviour): a directory outside the
     session workspace is listed normally, and it is flagged as external. */
  const outside = path.join(sandbox, 'outside')
  mkdirSync(outside, { recursive: true })
  mkdirSync(path.join(outside, 'child'), { recursive: true })
  const out = await call('browse', { cwd: workspace, dir: outside })
  assert.equal(out.ok, true, JSON.stringify(out).slice(0, 300))
  assert.equal(out.data.dir.split('\\').join('/'), outside.split('\\').join('/'))
  assert.equal(out.data.inWorkspace, false)
  assert.equal(out.data.dirs.some((entry) => entry.name === 'child'), true)
  assert.equal(out.data.parent !== null, true, 'a parent is offered so the user can walk back')
})

test('browse skips noise directories too', async () => {
  const out = await call('browse', { cwd: workspace })
  assert.equal(out.data.dirs.some((entry) => entry.name === 'node_modules'), false)
})

test('a repository chosen from the picker drives a normal snapshot', async () => {
  const scanned = await call('workspace', { cwd: workspace })
  const target = scanned.data.repos.find((entry) => entry.relative === 'libs/core')
  assert.ok(target !== undefined)
  const snap = await call('snapshot', { cwd: workspace, repoRoot: target.path })
  assert.equal(snap.ok, true, JSON.stringify(snap).slice(0, 300))
  assert.equal(snap.data.branch, 'main')
  assert.equal(snap.data.root.split('\\').join('/'), target.path)
})

test('a repository OUTSIDE the workspace can be opened by path', async () => {
  /* This is the whole point of the change: any repository on any drive, not just
     one under the session workspace. */
  const outside = path.join(sandbox, 'outside-repo')
  makeRepo(outside, 'feat: outside')
  const out = await call('snapshot', { cwd: workspace, repoRoot: outside })
  assert.equal(out.ok, true, JSON.stringify(out).slice(0, 300))
  assert.equal(out.data.branch, 'main')
  assert.equal(out.data.root.split('\\').join('/'), outside.split('\\').join('/'))
})

test('a repoRoot that is not a repository is still refused', async () => {
  /* Opening the whole disk does not mean opening any directory: the path must
     still resolve to a Git repository. */
  const plain = path.join(sandbox, 'not-a-repo')
  mkdirSync(plain, { recursive: true })
  const out = await call('snapshot', { cwd: workspace, repoRoot: plain })
  assert.equal(out.ok, false)
  assert.equal(out.error.code, 'not-a-repo')
})

test('a repoRoot that is an ancestor of the session cwd is accepted', async () => {
  // session cwd inside a repository subdirectory: the repository root is above it
  const snap = await call('snapshot', { cwd: path.join(workspace, 'app'), repoRoot: path.join(workspace, 'app') })
  assert.equal(snap.ok, true, JSON.stringify(snap).slice(0, 300))
})

test('the scan is bounded: a deep tree stops instead of hanging', async () => {
  const out = await call('workspace', { cwd: workspace, maxDepth: 1 })
  assert.equal(out.ok, true)
  const relatives = out.data.repos.map((entry) => entry.relative)
  assert.equal(relatives.includes('deep/a/b/inner'), false, 'depth limit honoured')
  assert.equal(relatives.includes('app'), true, 'shallow repos still found')
})

test('browse still refuses a non-absolute or unreadable directory', async () => {
  /* Full-disk access keeps the STRUCTURAL guards: a relative path is rejected
     before anything touches the filesystem. */
  const relative = await call('browse', { cwd: workspace, dir: 'plain' })
  assert.equal(relative.ok, false)
  assert.equal(relative.error.code, 'bad-request')

  const missing = await call('browse', { cwd: workspace, dir: path.join(sandbox, 'does-not-exist') })
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'browse-failed')

  /* A file is not a directory. */
  const file = path.join(workspace, 'plain', 'nested', 'note.txt')
  const asDir = await call('browse', { cwd: workspace, dir: file })
  assert.equal(asDir.ok, false)
  assert.equal(asDir.error.code, 'browse-failed')
})

test('the scan honours the skip list at every depth, not only the first level', async () => {
  const deep = path.join(workspace, 'app', 'node_modules', 'inner-dep')
  makeRepo(deep, 'feat: nested dependency')
  const out = await call('workspace', { cwd: workspace })
  assert.equal(out.data.repos.some((entry) => entry.relative.includes('inner-dep')), false)
})