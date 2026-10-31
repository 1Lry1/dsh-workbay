import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  ApiError,
  badRequest,
  createJsonApiHandler,
  isRealPathInside,
  isTrustedRequest,
  mediaTypeFor,
  mountJsonApi,
  normalizeRel,
  readJsonBody,
  resolveInside,
  sendJson,
} from '../src/host.js'

function fakeReq(options = {}) {
  const req = new EventEmitter()
  req.method = options.method === undefined ? 'POST' : options.method
  req.url = options.url === undefined ? '/' : options.url
  req.headers = options.headers === undefined ? { host: '127.0.0.1:47821' } : options.headers
  req.socket = { remoteAddress: options.peer === undefined ? '127.0.0.1' : options.peer }
  req.destroy = () => {}
  /* The body reader awaits 'end', so every fake request must finish: an
     undefined body means an empty body, not "never emits". */
  process.nextTick(() => {
    if (options.body !== undefined) req.emit('data', Buffer.from(options.body, 'utf8'))
    req.emit('end')
  })
  return req
}

function fakeRes() {
  const res = {
    status: 0,
    headers: null,
    text: '',
    writeHead(status, headers) { res.status = status; res.headers = headers },
    end(text) { res.text = text },
    json() { return JSON.parse(res.text) },
  }
  return res
}

async function call(handler, reqOptions) {
  const res = fakeRes()
  await handler(fakeReq(reqOptions), res)
  return res
}

test('sendJson sets the json envelope headers', () => {
  const res = fakeRes()
  sendJson(res, 200, { ok: true, data: { n: 1 } })
  assert.equal(res.status, 200)
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(Number(res.headers['content-length']), Buffer.byteLength(res.text))
  assert.deepEqual(res.json(), { ok: true, data: { n: 1 } })
})

test('isTrustedRequest accepts a loopback peer even without a Host header', () => {
  assert.equal(isTrustedRequest(fakeReq({ headers: {}, peer: '::1' })), true)
  assert.equal(isTrustedRequest(fakeReq({ headers: {}, peer: '::ffff:127.0.0.1' })), true)
})

test('isTrustedRequest accepts loopback Host names and same-origin fetches', () => {
  assert.equal(isTrustedRequest(fakeReq({ peer: '10.0.0.9', headers: { host: 'localhost:47821' } })), true)
  assert.equal(isTrustedRequest(fakeReq({ peer: '10.0.0.9', headers: { host: '127.0.0.1' } })), true)
  assert.equal(isTrustedRequest(fakeReq({ peer: '10.0.0.9', headers: { host: '[::1]:47821' } })), true)
  assert.equal(isTrustedRequest(fakeReq({ peer: '10.0.0.9', headers: { host: 'evil.example', 'sec-fetch-site': 'same-origin' } })), true)
})

test('isTrustedRequest rejects a public peer with a public Host', () => {
  assert.equal(isTrustedRequest(fakeReq({ peer: '10.0.0.9', headers: { host: 'evil.example' } })), false)
  assert.equal(isTrustedRequest(fakeReq({ peer: '10.0.0.9', headers: { host: 'evil.example', 'sec-fetch-site': 'cross-site' } })), false)
  assert.equal(isTrustedRequest(fakeReq({ peer: '10.0.0.9', headers: {} })), false)
})

test('readJsonBody resolves {} for an empty body', async () => {
  assert.deepEqual(await readJsonBody(fakeReq({ body: '' })), {})
  assert.deepEqual(await readJsonBody(fakeReq({ body: '   ' })), {})
})

test('readJsonBody parses an object, keeps arrays, and null becomes {}', async () => {
  assert.deepEqual(await readJsonBody(fakeReq({ body: '{"a":1}' })), { a: 1 })
  /* Arrays are objects to JSON.parse; the previous per-plugin readers let them
     through too, and every method reads named fields anyway. */
  assert.deepEqual(await readJsonBody(fakeReq({ body: '[1,2]' })), [1, 2])
  assert.deepEqual(await readJsonBody(fakeReq({ body: 'null' })), {})
})

test('readJsonBody rejects invalid JSON as a 400 bad-request', async () => {
  await assert.rejects(
    readJsonBody(fakeReq({ body: '{oops' })),
    (error) => error instanceof ApiError && error.status === 400 && error.code === 'bad-request',
  )
})

test('readJsonBody rejects an oversized body as 413 too-large', async () => {
  await assert.rejects(
    readJsonBody(fakeReq({ body: 'x'.repeat(64) }), 16),
    (error) => error instanceof ApiError && error.status === 413 && error.code === 'too-large',
  )
})

const methods = {
  ping: async () => ({ ok: true }),
  boom: async () => { throw new ApiError('nope', 'nope', 409) },
  panel: async () => {
    const error = new Error('git failed')
    error.code = 'panel-error'
    error.status = 422
    throw error
  },
  crash: async () => { throw new Error('kaboom') },
}

const handle = createJsonApiHandler({ prefix: '/x/api', methods })

test('handler rejects an untrusted caller with 403', async () => {
  const res = await call(handle, { url: '/x/api/ping', headers: { host: 'evil.example' }, peer: '10.0.0.9' })
  assert.equal(res.status, 403)
  assert.equal(res.json().error.code, 'forbidden')
})

test('handler rejects non-POST with 405', async () => {
  const res = await call(handle, { method: 'GET', url: '/x/api/ping' })
  assert.equal(res.status, 405)
  assert.equal(res.json().error.code, 'method-error')
})

test('handler 404s unknown methods and nested paths', async () => {
  assert.equal((await call(handle, { url: '/x/api/nope' })).status, 404)
  assert.equal((await call(handle, { url: '/x/api/ping/extra' })).status, 404)
  assert.equal((await call(handle, { url: '/other/ping' })).status, 404)
})

test('handler returns the { ok, data } envelope on success', async () => {
  const res = await call(handle, { url: '/x/api/ping' })
  assert.equal(res.status, 200)
  assert.deepEqual(res.json(), { ok: true, data: { ok: true } })
})

test('handler maps ApiError, duck-typed errors and unknown throws', async () => {
  const apiError = await call(handle, { url: '/x/api/boom' })
  assert.equal(apiError.status, 409)
  assert.deepEqual(apiError.json(), { ok: false, error: { code: 'nope', message: 'nope' } })

  const duck = await call(handle, { url: '/x/api/panel' })
  assert.equal(duck.status, 422)
  assert.deepEqual(duck.json(), { ok: false, error: { code: 'panel-error', message: 'git failed' } })

  const crash = await call(handle, { url: '/x/api/crash' })
  assert.equal(crash.status, 500)
  assert.deepEqual(crash.json(), { ok: false, error: { code: 'internal', message: 'kaboom' } })
})

test('handler runs the method through the run hook', async () => {
  const seen = []
  const wrapped = createJsonApiHandler({
    prefix: '/x/api',
    methods: { ping: async () => 'pong' },
    run: async (method, payload, invoke) => {
      seen.push(method, payload)
      return invoke()
    },
  })
  const res = await call(wrapped, { url: '/x/api/ping', body: '{"k":2}' })
  assert.deepEqual(res.json(), { ok: true, data: 'pong' })
  assert.deepEqual(seen, ['ping', { k: 2 }])
})

test('mountJsonApi registers a prefix route and disposes with the ctx', () => {
  let registered = null
  let dispose = null
  const ctx = {
    webServer: { register: (route) => { registered = route; return () => {} } },
    effect: (fn, _label) => { dispose = fn() },
  }
  const handler = mountJsonApi(ctx, { prefix: '/x/api', methods, label: 'demo' })
  assert.equal(typeof handler, 'function')
  assert.equal(registered.kind, 'prefix')
  assert.equal(registered.path, '/x/api')
  assert.deepEqual(methods, methods)
  assert.equal(typeof dispose, 'function')
})

test('badRequest is a 400 ApiError', () => {
  const error = badRequest('missing cwd')
  assert.equal(error.status, 400)
  assert.equal(error.code, 'bad-request')
  assert.equal(error.message, 'missing cwd')
})

/* ============================== path helpers ============================== */

/** Run `fn` against a throwaway sandbox and always clean it up. */
function withSandbox(fn) {
  const sandbox = mkdtempSync(path.join(tmpdir(), 'kwbk-kit-'))
  /* Canonicalise the sandbox: GitHub's Windows runners hand out TMP as an 8.3
     short path (C:\Users\RUNNER~1\...), while `resolveInside` returns the real
     long form (`realpathSync.native`). Comparing the two as strings would fail
     on CI for a reason that has nothing to do with the helper. */
  const canonical = typeof realpathSync.native === 'function' ? realpathSync.native(sandbox) : realpathSync(sandbox)
  try {
    return fn(canonical)
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
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

test('normalizeRel collapses empty and dot segments and keeps POSIX segments', () => {
  assert.equal(normalizeRel(''), '')
  assert.equal(normalizeRel(undefined), '')
  assert.equal(normalizeRel('.'), '')
  assert.equal(normalizeRel('./'), '')
  assert.equal(normalizeRel('a/b/c.txt'), 'a/b/c.txt')
  assert.equal(normalizeRel('./a//b/./c.txt'), 'a/b/c.txt')
  assert.equal(normalizeRel('dir/'), 'dir')
  assert.equal(normalizeRel('a/...b/c'), 'a/...b/c')
})

test('normalizeRel rejects absolute, traversal, backslash, NUL and empty-when-required', () => {
  for (const bad of ['/etc/passwd', 'a/../../b', '../x', 'a/..', 'a\\b', 'C:evil', 'a\u0000b', 42, {}]) {
    assert.throws(() => normalizeRel(bad), (error) => error.code === 'bad-request', 'accepted: ' + String(bad))
  }
  assert.throws(() => normalizeRel('', { allowEmpty: false }), (error) => error.code === 'bad-request')
  assert.throws(() => normalizeRel('...'), (error) => error.code === 'bad-request', 'dot-only segments are rejected')
})

test('mediaTypeFor maps known extensions case-insensitively and falls back to octet-stream', () => {
  assert.equal(mediaTypeFor('a/b/photo.PNG'), 'image/png')
  assert.equal(mediaTypeFor('icon.svg'), 'image/svg+xml')
  assert.equal(mediaTypeFor('page.html'), 'text/html; charset=utf-8')
  assert.equal(mediaTypeFor('notes.md'), 'text/markdown; charset=utf-8')
  assert.equal(mediaTypeFor('doc.pdf'), 'application/pdf')
  assert.equal(mediaTypeFor('unknown.zzz'), 'application/octet-stream')
  assert.equal(mediaTypeFor('no-extension'), 'application/octet-stream')
  assert.equal(mediaTypeFor(''), 'application/octet-stream')
  assert.equal(mediaTypeFor(undefined), 'application/octet-stream')
})

test('isRealPathInside uses a separator boundary, not a bare prefix', () => {
  assert.equal(isRealPathInside(path.resolve('/a/ws'), path.resolve('/a/ws')), true)
  assert.equal(isRealPathInside(path.resolve('/a/ws'), path.resolve('/a/ws/sub/f.txt')), true)
  assert.equal(isRealPathInside(path.resolve('/a/ws'), path.resolve('/a/ws2/f.txt')), false)
  assert.equal(isRealPathInside(path.resolve('/a/ws'), path.resolve('/a/other/ws')), false)
})

test('resolveInside resolves existing children and appends a missing tail', () => withSandbox((sandbox) => {
  const root = path.join(sandbox, 'ws')
  mkdirSync(path.join(root, 'sub'), { recursive: true })
  writeFileSync(path.join(root, 'sub', 'a.txt'), 'hi')
  const realRoot = resolveInside(root, '')
  assert.equal(realRoot, path.resolve(root))
  assert.equal(resolveInside(root, 'sub/a.txt'), path.join(realRoot, 'sub', 'a.txt'))
  /* A destination that does not exist yet is safe to name: its parent is real
     and inside the root. */
  assert.equal(resolveInside(root, 'sub/new.txt'), path.join(realRoot, 'sub', 'new.txt'))
  assert.equal(resolveInside(root, 'new/dir/leaf.txt'), path.join(realRoot, 'new', 'dir', 'leaf.txt'))
}))

test('resolveInside validates the root itself', () => withSandbox((sandbox) => {
  const file = path.join(sandbox, 'file.txt')
  writeFileSync(file, 'x')
  assert.throws(() => resolveInside('relative/dir', ''), (error) => error.code === 'bad-request')
  assert.throws(() => resolveInside(path.join(sandbox, 'missing'), ''), (error) => error.code === 'bad-request')
  assert.throws(() => resolveInside(file, ''), (error) => error.code === 'bad-request')
  assert.throws(() => resolveInside('', ''), (error) => error.code === 'bad-request')
  assert.throws(() => resolveInside(42, ''), (error) => error.code === 'bad-request')
}))

test('resolveInside rejects a traversal or absolute rel', () => withSandbox((sandbox) => {
  const root = path.join(sandbox, 'ws')
  mkdirSync(root)
  for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'a\\..\\x']) {
    assert.throws(() => resolveInside(root, bad), (error) => error.code === 'bad-request', 'accepted: ' + bad)
  }
}))

test('resolveInside refuses a directory link that leaves the root', () => withSandbox((sandbox) => {
  const root = path.join(sandbox, 'ws')
  const outside = path.join(sandbox, 'outside')
  mkdirSync(root)
  mkdirSync(outside)
  writeFileSync(path.join(outside, 'secret.txt'), 'TOP SECRET')
  if (!makeDirLink(outside, path.join(root, 'escape'))) {
    /* No symlink/junction privilege (locked-down Windows profile): the cases
       below are exactly what the confinement code exists for, so report it. */
    return
  }
  assert.throws(
    () => resolveInside(root, 'escape/secret.txt'),
    (error) => error.code === 'outside-root' && error.status === 403,
  )
  assert.throws(() => resolveInside(root, 'escape'), (error) => error.code === 'outside-root')
  /* The boundary is a separator, so a SIBLING with the same prefix is outside. */
  const sibling = path.join(sandbox, 'ws2')
  mkdirSync(sibling)
  if (makeDirLink(sibling, path.join(root, 'sibling'))) {
    assert.throws(() => resolveInside(root, 'sibling'), (error) => error.code === 'outside-root')
  }
  /* `followFinal: false` may name the link itself (unlink/rename) but never a
     path THROUGH it. */
  assert.equal(resolveInside(root, 'escape', { followFinal: false }), path.join(resolveInside(root, ''), 'escape'))
  assert.throws(() => resolveInside(root, 'escape/secret.txt', { followFinal: false }), (error) => error.code === 'outside-root')
}))

test('resolveInside follows a link that stays inside the root', () => withSandbox((sandbox) => {
  const root = path.join(sandbox, 'ws')
  mkdirSync(path.join(root, 'actual'), { recursive: true })
  writeFileSync(path.join(root, 'actual', 'a.txt'), 'inside')
  if (!makeDirLink(path.join(root, 'actual'), path.join(root, 'alias'))) return
  assert.equal(
    resolveInside(root, 'alias/a.txt'),
    path.join(resolveInside(root, ''), 'actual', 'a.txt'),
  )
}))

test('resolveInside reports a dangling symlink as outside-root', () => withSandbox((sandbox) => {
  const root = path.join(sandbox, 'ws')
  mkdirSync(root)
  try {
    symlinkSync(path.join(sandbox, 'missing-target'), path.join(root, 'dangling'), 'file')
  } catch {
    return /* creating file symlinks needs developer mode on Windows */
  }
  assert.throws(() => resolveInside(root, 'dangling'), (error) => error.code === 'outside-root')
}))
