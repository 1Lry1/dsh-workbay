/**
 * Host-half end-to-end test: boots the plugin through a fake cordis context,
 * mounts the three captured route handlers (JSON API / media / chunk) on a real
 * HTTP server, and drives the workspace filesystem API against a throwaway
 * tree in the OS temp dir.
 *
 * Run:  node --test tests/host.test.mjs
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const plugin = await import('../src/index.js')

const API_PREFIX = '/dsh-workbay-files/api'
const MEDIA_PREFIX = '/dsh-workbay-files/media'
const CHUNK_PREFIX = '/dsh-workbay-files/chunk'

const MIB = 1024 * 1024

let server
let baseUrl
let routes
let sandbox
let ws
let outside
let chunksDir
let escapeLinkCreated = false

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03])
const BINARY_BYTES = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0x80, 0x7f])

function asJson(absPath) {
  return path.resolve(absPath).split(path.sep).join('/')
}

/**
 * Create a directory link. Windows only grants file symlinks to elevated or
 * developer-mode accounts, but junctions need no privilege and Node reports
 * them as symlinks (`lstat().isSymbolicLink() === true`).
 */
function makeDirLink(target, linkPath) {
  try {
    symlinkSync(target, linkPath, 'junction')
    return true
  } catch {
    try {
      symlinkSync(target, linkPath, 'dir')
      return true
    } catch {
      return false
    }
  }
}

function removeLink(linkPath) {
  try {
    unlinkSync(linkPath)
  } catch {
    try { rmSync(linkPath, { recursive: true, force: true }) } catch { /* gone */ }
  }
}

/** Boot the plugin on a fake ctx and return the handlers it registered. */
function bootPlugin(config) {
  const registered = new Map()
  const ctx = {
    effect(fn) {
      const dispose = fn()
      return () => { if (typeof dispose === 'function') dispose() }
    },
    webServer: {
      register({ path: routePath, handler }) {
        registered.set(routePath, handler)
        return () => { registered.delete(routePath) }
      },
    },
  }
  plugin.apply(ctx, config)
  return registered
}

/** Re-apply only the config (the real server keeps using the same handlers). */
function applyConfig(config) {
  const ctx = {
    effect(fn) { fn() },
    webServer: { register() { return () => {} } },
  }
  plugin.apply(ctx, config)
}

function fakeReq(options = {}) {
  return {
    method: options.method === undefined ? 'GET' : options.method,
    url: options.url === undefined ? '/' : options.url,
    headers: options.headers === undefined ? { host: 'evil.example' } : options.headers,
    socket: { remoteAddress: options.peer === undefined ? '10.0.0.9' : options.peer },
  }
}

function fakeRes() {
  return {
    status: 0,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
      return this
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) this.body += String(chunk)
      this.ended = true
    },
    json() {
      return JSON.parse(this.body)
    },
  }
}

async function call(method, payload) {
  const res = await fetch(baseUrl + API_PREFIX + '/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const json = await res.json()
  return { status: res.status, ...json }
}

function mediaQuery(params) {
  return new URLSearchParams(params).toString()
}

function mediaRequest(params, init) {
  return fetch(baseUrl + MEDIA_PREFIX + '?' + mediaQuery(params), init)
}

function chunkRequest(chunkName, init) {
  return fetch(baseUrl + CHUNK_PREFIX + '/' + chunkName, init)
}

before(async () => {
  sandbox = mkdtempSync(path.join(tmpdir(), 'kwbk-files-'))
  /* Canonicalise the sandbox: GitHub's Windows runners expose TMP as an 8.3
     short path (C:\Users\RUNNER~1\...), while the host answers with the real
     long form (`realpathSync.native`) — comparing them as strings is a CI-only
     failure unrelated to the code under test. */
  sandbox = typeof realpathSync.native === 'function' ? realpathSync.native(sandbox) : realpathSync(sandbox)
  ws = path.join(sandbox, 'ws')
  outside = path.join(sandbox, 'outside')
  chunksDir = path.join(sandbox, 'chunks')
  mkdirSync(ws, { recursive: true })
  mkdirSync(outside, { recursive: true })
  mkdirSync(path.join(ws, 'src', 'deep'), { recursive: true })
  mkdirSync(path.join(ws, 'docs'), { recursive: true })
  mkdirSync(path.join(ws, '.hidden'), { recursive: true })
  mkdirSync(path.join(ws, 'node_modules', 'pkg'), { recursive: true })
  mkdirSync(chunksDir, { recursive: true })

  writeFileSync(path.join(ws, 'readme.md'), 'hello world\n')
  writeFileSync(path.join(ws, 'needle-a.txt'), 'a\n')
  writeFileSync(path.join(ws, 'src', 'needle-b.js'), 'b\n')
  writeFileSync(path.join(ws, 'src', 'deep', 'Needle-C.txt'), 'c\n')
  writeFileSync(path.join(ws, 'docs', 'hidden-note.txt'), 'note\n')
  writeFileSync(path.join(ws, '.dotfile'), 'dot\n')
  writeFileSync(path.join(ws, '.hidden', 'hidden-note.txt'), 'hidden\n')
  writeFileSync(path.join(ws, 'node_modules', 'pkg', 'needle-dep.js'), 'dep\n')
  writeFileSync(path.join(ws, 'big.txt'), Buffer.alloc(Math.floor(1.5 * MIB), 0x62))
  writeFileSync(path.join(ws, 'huge.txt'), Buffer.alloc(9 * MIB, 0x61))
  writeFileSync(path.join(ws, 'binary.dat'), BINARY_BYTES)
  writeFileSync(path.join(ws, 'image.png'), PNG_BYTES)
  writeFileSync(path.join(ws, 'page.html'), '<script>alert(1)</script>\n')
  writeFileSync(path.join(ws, 'icon.svg'), '<svg><script>alert(1)</script></svg>\n')
  writeFileSync(path.join(ws, 'data.unknown'), 'raw')
  writeFileSync(path.join(outside, 'secret.txt'), 'TOP SECRET\n')

  escapeLinkCreated = makeDirLink(outside, path.join(ws, 'escape'))

  writeFileSync(path.join(chunksDir, 'demo.js'), 'globalThis.__dshChunks__ = {}\n')
  process.env.DSH_WORKBAY_FILES_CHUNKS = chunksDir

  routes = bootPlugin({ allowWrite: true })
  assert.ok(routes.has(API_PREFIX), 'json api route was not registered')
  assert.ok(routes.has(MEDIA_PREFIX), 'media route was not registered')
  assert.ok(routes.has(CHUNK_PREFIX), 'chunk route was not registered')

  server = createServer((req, res) => {
    const pathname = new URL(req.url === undefined ? '/' : req.url, 'http://dsh.internal').pathname
    let handler = null
    let best = -1
    for (const [prefix, candidate] of routes) {
      if ((pathname === prefix || pathname.startsWith(prefix + '/')) && prefix.length > best) {
        handler = candidate
        best = prefix.length
      }
    }
    if (handler === null) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('no route')
      return
    }
    void Promise.resolve(handler(req, res)).catch(() => {
      try { res.destroy() } catch { /* already gone */ }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = 'http://127.0.0.1:' + server.address().port
})

after(async () => {
  if (server !== undefined) await new Promise((resolve) => server.close(resolve))
  delete process.env.DSH_WORKBAY_FILES_CHUNKS
  if (sandbox !== undefined) {
    rmSync(sandbox, { recursive: true, force: true })
  }
})

/* ============================== roots / browse ============================== */

test('roots reports drives and never suggests the DSH profile directory', async () => {
  const out = await call('roots', {})
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.ok(Array.isArray(out.data.drives) && out.data.drives.length >= 1)
  for (const drive of out.data.drives) {
    assert.equal(typeof drive.name, 'string')
    assert.equal(path.isAbsolute(drive.path), true, 'drive path must be absolute: ' + drive.path)
  }
  /* `root` is the last workspace actually served, or null before any is chosen.
     process.cwd() inside DSH is the profile directory and must never be offered
     as the workspace. */
  assert.equal(out.data.root === null || typeof out.data.root === 'string', true)
  if (typeof out.data.root === 'string') {
    assert.equal(out.data.root.toLowerCase().includes('.dsh'), false, 'profile dir leaked as root: ' + out.data.root)
  }
  assert.ok(Array.isArray(out.data.recent))
})

test('roots.recent remembers workspace roots that were actually served', async () => {
  await call('tree', { root: ws })
  const out = await call('roots', {})
  assert.ok(out.data.recent.includes(asJson(ws)), 'recent: ' + JSON.stringify(out.data.recent))
})

test('browse lists directories only and reports dir/parent canonically', async () => {
  const out = await call('browse', { dir: ws })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.data.dir, asJson(ws))
  assert.equal(out.data.parent, asJson(sandbox))
  const names = out.data.entries.map((entry) => entry.name)
  assert.ok(names.includes('src'))
  assert.ok(names.includes('docs'))
  assert.ok(names.includes('node_modules'))
  assert.equal(names.includes('readme.md'), false, 'files must not be browse entries')
  for (const entry of out.data.entries) {
    assert.equal(entry.type, 'dir')
    assert.equal(path.isAbsolute(entry.path), true)
    assert.equal(typeof entry.rel, 'string')
  }
})

test('browse rejects a relative or file named dir', async () => {
  const relative = await call('browse', { dir: 'ws' })
  assert.equal(relative.status, 400)
  assert.equal(relative.error.code, 'bad-request')
  const file = await call('browse', { dir: path.join(ws, 'readme.md') })
  assert.equal(file.status, 400)
})

/* ============================== tree ============================== */

test('tree lists one level with rel/type/size/hasChildren', async () => {
  const out = await call('tree', { root: ws })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.data.root, asJson(ws))
  assert.equal(out.data.dir, '')
  assert.equal(out.data.truncated, false)
  const readme = out.data.entries.find((entry) => entry.name === 'readme.md')
  assert.ok(readme !== undefined)
  assert.equal(readme.type, 'file')
  assert.equal(readme.rel, 'readme.md')
  assert.equal(readme.size, 12)
  assert.equal(typeof readme.mtimeMs, 'number')
  const src = out.data.entries.find((entry) => entry.name === 'src')
  assert.equal(src.type, 'dir')
  assert.equal(src.hasChildren, true)
  /* Directories first, then files. */
  assert.equal(out.data.entries[0].type, 'dir')
  assert.equal(out.data.entries[out.data.entries.length - 1].type, 'file')
})

test('tree hides dot entries unless showHidden is set', async () => {
  const hidden = await call('tree', { root: ws })
  assert.equal(hidden.data.entries.some((entry) => entry.name === '.dotfile'), false)
  const shown = await call('tree', { root: ws, showHidden: true })
  assert.ok(shown.data.entries.some((entry) => entry.name === '.dotfile' && entry.type === 'file'))
  assert.ok(shown.data.entries.some((entry) => entry.name === '.hidden' && entry.type === 'dir'))
})

test('tree resolves a subdirectory and rejects escapes and non-directories', async () => {
  const sub = await call('tree', { root: ws, dir: 'src' })
  assert.equal(sub.ok, true, JSON.stringify(sub))
  assert.equal(sub.data.dir, 'src')
  assert.ok(sub.data.entries.some((entry) => entry.rel === 'src/needle-b.js'))

  const traversal = await call('tree', { root: ws, dir: '../outside' })
  assert.equal(traversal.status, 400)
  assert.equal(traversal.error.code, 'bad-request')

  const absolute = await call('tree', { root: ws, dir: asJson(outside) })
  assert.equal(absolute.status, 400)

  const notDir = await call('tree', { root: ws, dir: 'readme.md' })
  assert.equal(notDir.status, 400)

  const relativeRoot = await call('tree', { root: 'ws' })
  assert.equal(relativeRoot.status, 400)
  assert.equal(relativeRoot.error.code, 'bad-request')

  const missingRoot = await call('tree', { root: path.join(sandbox, 'nope') })
  assert.equal(missingRoot.status, 400)
})

/* ============================== search ============================== */

test('search matches names case-insensitively and skips node_modules by default', async () => {
  const out = await call('search', { root: ws, query: 'needle' })
  assert.equal(out.ok, true, JSON.stringify(out))
  const rels = out.data.matches.map((entry) => entry.rel)
  assert.deepEqual(rels.sort(), ['needle-a.txt', 'src/deep/Needle-C.txt', 'src/needle-b.js'])
  assert.equal(rels.some((rel) => rel.includes('node_modules')), false)

  const withDeps = await call('search', { root: ws, query: 'needle', includeNodeModules: true })
  assert.ok(withDeps.data.matches.some((entry) => entry.rel === 'node_modules/pkg/needle-dep.js'))
})

test('search honours limit/truncated and requires a query', async () => {
  const limited = await call('search', { root: ws, query: 'needle', limit: 1 })
  assert.equal(limited.data.matches.length, 1)
  assert.equal(limited.data.truncated, true)
  const empty = await call('search', { root: ws, query: '   ' })
  assert.equal(empty.status, 400)
  assert.equal(empty.error.code, 'bad-request')
})

test('search does not walk through a symlink that leaves the root', async (t) => {
  if (!escapeLinkCreated) return t.skip('cannot create a directory link on this account')
  const out = await call('search', { root: ws, query: 'secret' })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.deepEqual(out.data.matches, [])
})

/* ============================== read ============================== */

test('read returns utf8 content, size and mtime', async () => {
  const out = await call('read', { root: ws, rel: 'readme.md' })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.data.content, 'hello world\n')
  assert.equal(out.data.size, 12)
  assert.equal(out.data.encoding, 'utf8')
  assert.equal(out.data.truncated, false)
  assert.equal(typeof out.data.mtimeMs, 'number')
})

test('read caps at maxFileBytes (1 MiB default) and flags truncation', async () => {
  const out = await call('read', { root: ws, rel: 'big.txt' })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.data.size, Math.floor(1.5 * MIB))
  assert.equal(out.data.truncated, true)
  assert.equal(out.data.content.length, 1 * MIB)
})

test('read clamps a requested maxBytes to the 8 MiB hard cap', async () => {
  const out = await call('read', { root: ws, rel: 'huge.txt', maxBytes: 64 * MIB })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.data.size, 9 * MIB)
  assert.equal(out.data.truncated, true)
  assert.equal(out.data.content.length, 8 * MIB)
})

test('read honours an explicit maxBytes below the default', async () => {
  const out = await call('read', { root: ws, rel: 'readme.md', maxBytes: 5 })
  assert.equal(out.data.content, 'hello')
  assert.equal(out.data.truncated, true)
})

test('read reports binary files as base64 with encoding binary', async () => {
  const out = await call('read', { root: ws, rel: 'binary.dat' })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.data.encoding, 'binary')
  assert.equal(out.data.truncated, false)
  assert.deepEqual(Buffer.from(out.data.content, 'base64'), BINARY_BYTES)
})

test('read rejects directories, missing files and malformed rel paths', async () => {
  const dir = await call('read', { root: ws, rel: 'src' })
  assert.equal(dir.status, 400)
  const missing = await call('read', { root: ws, rel: 'nope.txt' })
  assert.equal(missing.status, 404)
  assert.equal(missing.error.code, 'not-found')
  for (const rel of ['../outside/secret.txt', '/etc/passwd', 'src\\..\\..\\x']) {
    const bad = await call('read', { root: ws, rel })
    assert.equal(bad.status, 400, 'accepted rel: ' + rel)
  }
})

/* ============================== write gating ============================== */

test('writes are disabled by default (403 write-disabled)', async () => {
  applyConfig({ allowWrite: false })
  try {
    const cases = [
      ['write', { root: ws, rel: 'blocked.txt', content: 'x' }],
      ['mkdir', { root: ws, rel: 'blocked-dir' }],
      ['rename', { root: ws, from: 'readme.md', to: 'blocked.md' }],
      ['delete', { root: ws, rel: 'readme.md' }],
    ]
    for (const [method, payload] of cases) {
      const out = await call(method, payload)
      assert.equal(out.status, 403, method + ' should be gated')
      assert.equal(out.error.code, 'write-disabled', method + ' code')
    }
  } finally {
    applyConfig({ allowWrite: true })
  }
})

/* ============================== write ============================== */

test('write creates and overwrites a file and read returns the new bytes', async () => {
  let out = await call('write', { root: ws, rel: 'created.txt', content: 'first\n' })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.data.size, 6)
  assert.equal(typeof out.data.mtimeMs, 'number')
  out = await call('write', { root: ws, rel: 'created.txt', content: 'second\n' })
  assert.equal(out.ok, true)
  const read = await call('read', { root: ws, rel: 'created.txt' })
  assert.equal(read.data.content, 'second\n')
})

test('write rejects a stale baseMtimeMs with 409 conflict and accepts a fresh one', async () => {
  const target = path.join(ws, 'conflict.txt')
  writeFileSync(target, 'v1\n')
  const first = await call('read', { root: ws, rel: 'conflict.txt' })
  const staleBase = first.data.mtimeMs
  const future = new Date(Math.round(staleBase) + 5000)
  utimesSync(target, future, future)

  const stale = await call('write', { root: ws, rel: 'conflict.txt', content: 'v2\n', baseMtimeMs: staleBase })
  assert.equal(stale.status, 409, JSON.stringify(stale))
  assert.equal(stale.error.code, 'conflict')

  const fresh = await call('read', { root: ws, rel: 'conflict.txt' })
  const ok = await call('write', { root: ws, rel: 'conflict.txt', content: 'v3\n', baseMtimeMs: fresh.data.mtimeMs })
  assert.equal(ok.ok, true, JSON.stringify(ok))
  assert.equal(readFileSync(target, 'utf8'), 'v3\n')
})

test('write enforces the 2 MiB cap and refuses binary (NUL) content', async () => {
  const tooBig = await call('write', { root: ws, rel: 'too-big.txt', content: 'x'.repeat(2 * MIB + 1) })
  assert.equal(tooBig.status, 413, JSON.stringify(tooBig))
  assert.equal(tooBig.error.code, 'too-large')

  const binary = await call('write', { root: ws, rel: 'nul.txt', content: 'a\u0000b' })
  assert.equal(binary.status, 400)
  assert.equal(binary.error.code, 'bad-request')

  const notString = await call('write', { root: ws, rel: 'nul.txt', content: 42 })
  assert.equal(notString.status, 400)
})

test('write requires an existing parent directory', async () => {
  const out = await call('write', { root: ws, rel: 'missing/parent/file.txt', content: 'x' })
  assert.equal(out.status, 404)
  assert.equal(out.error.code, 'not-found')
})

/* ============================== mkdir / rename / delete ============================== */

test('mkdir creates one directory and reports collisions', async () => {
  const out = await call('mkdir', { root: ws, rel: 'created-dir' })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.data.entry.type, 'dir')
  assert.equal(out.data.entry.rel, 'created-dir')
  assert.equal(statSync(path.join(ws, 'created-dir')).isDirectory(), true)

  const again = await call('mkdir', { root: ws, rel: 'created-dir' })
  assert.equal(again.status, 409)
  assert.equal(again.error.code, 'already-exists')

  const noParent = await call('mkdir', { root: ws, rel: 'nope/child' })
  assert.equal(noParent.status, 404)

  const rootItself = await call('mkdir', { root: ws, rel: '' })
  assert.equal(rootItself.status, 400)
})

test('rename moves an entry and refuses unsafe destinations', async () => {
  writeFileSync(path.join(ws, 'rename-me.txt'), 'move me\n')
  const out = await call('rename', { root: ws, from: 'rename-me.txt', to: 'renamed.txt' })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.data.entry.rel, 'renamed.txt')
  assert.equal((await call('read', { root: ws, rel: 'rename-me.txt' })).status, 404)
  assert.equal((await call('read', { root: ws, rel: 'renamed.txt' })).data.content, 'move me\n')

  const missing = await call('rename', { root: ws, from: 'nope.txt', to: 'other.txt' })
  assert.equal(missing.status, 404)

  const collision = await call('rename', { root: ws, from: 'renamed.txt', to: 'readme.md' })
  assert.equal(collision.status, 409)
  assert.equal(collision.error.code, 'already-exists')

  const noParent = await call('rename', { root: ws, from: 'renamed.txt', to: 'nope/other.txt' })
  assert.equal(noParent.status, 404)

  const traversal = await call('rename', { root: ws, from: '../outside/secret.txt', to: 'stolen.txt' })
  assert.equal(traversal.status, 400)
})

test('delete removes files, needs recursive for non-empty directories and refuses the root', async () => {
  writeFileSync(path.join(ws, 'doomed.txt'), 'bye\n')
  const file = await call('delete', { root: ws, rel: 'doomed.txt' })
  assert.equal(file.ok, true, JSON.stringify(file))
  assert.equal(statSync(path.join(ws, 'doomed.txt'), { throwIfNoEntry: false }), undefined)

  mkdirSync(path.join(ws, 'doomed-dir'))
  writeFileSync(path.join(ws, 'doomed-dir', 'inner.txt'), 'inner\n')
  const nonEmpty = await call('delete', { root: ws, rel: 'doomed-dir' })
  assert.equal(nonEmpty.status, 409)
  assert.equal(nonEmpty.error.code, 'not-empty')
  const recursive = await call('delete', { root: ws, rel: 'doomed-dir', recursive: true })
  assert.equal(recursive.ok, true, JSON.stringify(recursive))
  assert.equal(statSync(path.join(ws, 'doomed-dir'), { throwIfNoEntry: false }), undefined)

  const missing = await call('delete', { root: ws, rel: 'nope.txt' })
  assert.equal(missing.status, 404)
  const rootItself = await call('delete', { root: ws, rel: '' })
  assert.equal(rootItself.status, 400)
})

/* ============================== symlink containment ============================== */

test('a symlink pointing outside the root is refused by read, stat, tree and write', async (t) => {
  if (!escapeLinkCreated) return t.skip('cannot create a directory link on this account')
  const read = await call('read', { root: ws, rel: 'escape/secret.txt' })
  assert.equal(read.status, 403, JSON.stringify(read))
  assert.equal(read.error.code, 'outside-root')

  const stat = await call('stat', { root: ws, rel: 'escape' })
  assert.equal(stat.status, 403)
  assert.equal(stat.error.code, 'outside-root')

  const tree = await call('tree', { root: ws, dir: 'escape' })
  assert.equal(tree.status, 403)

  const write = await call('write', { root: ws, rel: 'escape/evil.txt', content: 'nope' })
  assert.equal(write.status, 403)
  assert.equal(statSync(path.join(outside, 'evil.txt'), { throwIfNoEntry: false }), undefined)

  const mkdir = await call('mkdir', { root: ws, rel: 'escape/evil-dir' })
  assert.equal(mkdir.status, 403)
})

test('delete removes an escaping symlink itself without touching its target', async (t) => {
  if (!escapeLinkCreated) return t.skip('cannot create a directory link on this account')
  const link = path.join(ws, 'delete-me-link')
  if (!makeDirLink(outside, link)) return t.skip('cannot create a directory link on this account')
  const out = await call('delete', { root: ws, rel: 'delete-me-link' })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(statSync(link, { throwIfNoEntry: false }), undefined)
  assert.equal(statSync(path.join(outside, 'secret.txt')).isFile(), true, 'outside target survives')
})

test('stat reports an entry inside the root', async () => {
  const out = await call('stat', { root: ws, rel: 'src' })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.data.entry.type, 'dir')
  assert.equal(out.data.entry.rel, 'src')
  assert.equal(out.data.entry.hasChildren, true)

  const root = await call('stat', { root: ws, rel: '' })
  assert.equal(root.ok, true)
  assert.equal(root.data.entry.type, 'dir')

  const missing = await call('stat', { root: ws, rel: 'nope' })
  assert.equal(missing.status, 404)
})

/* ============================== media ============================== */

test('media serves raw bytes with a safe header set', async () => {
  const res = await mediaRequest({ root: ws, rel: 'image.png' })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'image/png')
  assert.equal(res.headers.get('cache-control'), 'no-cache')
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(res.headers.get('content-security-policy'), "sandbox; object-src 'none'")
  assert.equal(res.headers.get('content-disposition'), 'inline')
  assert.equal(res.headers.get('accept-ranges'), 'bytes')
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG_BYTES)
})

test('media gives svg/html a sandbox CSP and unknown extensions octet-stream', async () => {
  const svg = await mediaRequest({ root: ws, rel: 'icon.svg' })
  assert.equal(svg.headers.get('content-type'), 'image/svg+xml')
  assert.equal(svg.headers.get('content-security-policy'), "sandbox; object-src 'none'")
  assert.match(await svg.text(), /<script>/)

  const html = await mediaRequest({ root: ws, rel: 'page.html' })
  assert.match(html.headers.get('content-type'), /^text\/html/)
  assert.equal(html.headers.get('content-security-policy'), "sandbox; object-src 'none'")

  const unknown = await mediaRequest({ root: ws, rel: 'data.unknown' })
  assert.equal(unknown.headers.get('content-type'), 'application/octet-stream')
})

test('media supports a single byte range and 416 for an unsatisfiable one', async () => {
  const partial = await mediaRequest({ root: ws, rel: 'readme.md' }, { headers: { range: 'bytes=0-4' } })
  assert.equal(partial.status, 206)
  assert.equal(partial.headers.get('content-range'), 'bytes 0-4/12')
  assert.equal(partial.headers.get('content-length'), '5')
  assert.equal(await partial.text(), 'hello')

  const bad = await mediaRequest({ root: ws, rel: 'readme.md' }, { headers: { range: 'bytes=100-200' } })
  assert.equal(bad.status, 416)
  assert.equal(bad.headers.get('content-range'), 'bytes */12')
})

test('media obeys the same root confinement as the JSON API', async (t) => {
  const relative = await mediaRequest({ root: 'ws', rel: 'readme.md' })
  assert.equal(relative.status, 400)

  const traversal = await mediaRequest({ root: ws, rel: '../outside/secret.txt' })
  assert.equal(traversal.status, 400)

  const missing = await mediaRequest({ root: ws, rel: 'nope.png' })
  assert.equal(missing.status, 404)

  const dir = await mediaRequest({ root: ws, rel: 'src' })
  assert.equal(dir.status, 400)

  const post = await mediaRequest({ root: ws, rel: 'readme.md' }, { method: 'POST' })
  assert.equal(post.status, 405)

  if (escapeLinkCreated) {
    const escape = await mediaRequest({ root: ws, rel: 'escape/secret.txt' })
    assert.equal(escape.status, 403)
    assert.equal(escape.headers.get('content-type'), 'application/json; charset=utf-8')
    void t
  }
})

/* ============================== chunks ============================== */

test('chunk serves a built chunk with ETag and 304 on revalidation', async () => {
  const expected = readFileSync(path.join(chunksDir, 'demo.js'))
  let res = await chunkRequest('demo.js')
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'text/javascript; charset=utf-8')
  assert.equal(res.headers.get('cache-control'), 'no-cache')
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  const etag = res.headers.get('etag')
  assert.match(etag, /^"[0-9a-f]{40}"$/)
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), expected)

  res = await chunkRequest('demo.js', { headers: { 'if-none-match': etag } })
  assert.equal(res.status, 304)
  assert.equal(await res.text(), '')
  assert.equal(res.headers.get('etag'), etag)
})

test('chunk refuses traversal, unknown names and non-GET', async () => {
  for (const name of ['missing.js', '..%2F..%2Fpackage.json', '%2e%2e%2fsecret.js', 'sub%2Fdemo.js']) {
    const res = await chunkRequest(name)
    assert.equal(res.status, 404, 'accepted chunk name: ' + name)
  }
  const post = await chunkRequest('demo.js', { method: 'POST' })
  assert.equal(post.status, 405)
})

/* ============================== fence / dispatch ============================== */

test('media and chunk routes enforce the same-origin trust fence', async () => {
  const mediaRes = fakeRes()
  await routes.get(MEDIA_PREFIX)(fakeReq({ url: '/?root=C%3A%5C&rel=x.png' }), mediaRes)
  assert.equal(mediaRes.status, 403)
  assert.equal(mediaRes.json().error.code, 'forbidden')

  const chunkRes = fakeRes()
  await routes.get(CHUNK_PREFIX)(fakeReq({ url: '/demo.js' }), chunkRes)
  assert.equal(chunkRes.status, 403)
})

test('api rejects unknown methods and non-POST requests', async () => {
  const unknown = await call('nope', {})
  assert.equal(unknown.status, 404)
  const get = await fetch(baseUrl + API_PREFIX + '/roots')
  assert.equal(get.status, 405)
})
