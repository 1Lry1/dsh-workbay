import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import {
  ApiError,
  badRequest,
  createJsonApiHandler,
  isTrustedRequest,
  mountJsonApi,
  readJsonBody,
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
