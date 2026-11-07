/**
 * Host-half tests for `dsh-workbay-source-control`.
 *
 * The host is deliberately thin — it owns NO data routes — so what is worth
 * pinning is exactly that: the mount shape, the trust fence, and that the
 * diagnostic endpoint tells the truth about a missing dependency instead of
 * inventing an answer.
 *
 * Run:  node --test tests/host.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(here, '..')

const plugin = await import(new URL('../src/index.js', import.meta.url).href)

function fakeCtx() {
  const routes = []
  const effects = []
  const ctx = {
    webServer: {
      register(route) {
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index >= 0) routes.splice(index, 1)
        }
      },
    },
    effect(fn) {
      const dispose = fn()
      effects.push(dispose)
      return () => { if (typeof dispose === 'function') dispose() }
    },
    get() { return undefined },
    inject(names, callback) { callback(ctx) },
    logger: { error() {}, warn() {}, info() {} },
  }
  return { ctx, routes, effects }
}

function dispatch(routes) {
  return (req, res) => {
    for (const route of routes) {
      if (req.url.startsWith(route.path)) return route.handler(req, res)
    }
    res.statusCode = 404
    res.end(JSON.stringify({ ok: false, error: { code: 'not-found', message: 'no route' } }))
  }
}

async function boot() {
  const { ctx, routes, effects } = fakeCtx()
  plugin.apply(ctx)
  const server = createServer(dispatch(routes))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const base = 'http://127.0.0.1:' + port
  async function post(method, payload, headers) {
    /* The caller's headers WIN over the defaults: the content-type fence test has
       to be able to send a non-JSON type, and an Object.assign in the other order
       would silently overwrite it and make that test vacuous. */
    const merged = Object.assign({}, headers === undefined ? {} : headers)
    if (merged['content-type'] === undefined) merged['content-type'] = 'application/json'
    if (merged['sec-fetch-site'] === undefined) merged['sec-fetch-site'] = 'same-origin'
    const response = await fetch(base + '/dsh-workbay-source-control/api/' + method, {
      method: 'POST',
      headers: merged,
      body: JSON.stringify(payload === undefined ? {} : payload),
    })
    let body = null
    try { body = await response.json() } catch (error) { void error }
    return { status: response.status, body }
  }
  /* `server.close()` alone waits for keep-alive sockets to drain, and a
     fetch()-driven test leaves them open. Track the sockets ourselves and destroy
     them: `closeAllConnections()` looks tidier but trips a libuv assertion on
     Windows when it races the close callback. */
  const sockets = new Set()
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  const close = () => new Promise((resolve) => {
    for (const socket of sockets) {
      try { socket.destroy() } catch (error) { void error }
    }
    sockets.clear()
    server.close(() => resolve())
  })
  return { base, post, routes, effects, close }
}

test('the bundle declares its name and mounts exactly one JSON-RPC prefix', async () => {
  assert.equal(plugin.name, 'dsh-workbay-source-control')
  const booted = await boot()
  assert.equal(booted.routes.length, 1, 'one prefix route')
  assert.equal(booted.routes[0].path, '/dsh-workbay-source-control/api')
  await booted.close()
})

test('status reports null (not a guess) when the web server cannot be asked', async () => {
  /* The page depends on two other plugins. Reporting "unknown" is honest;
     reporting "missing" would send the user chasing a plugin that is fine. */
  const booted = await boot()
  const out = await booted.post('status', {})
  assert.equal(out.status, 200)
  assert.equal(out.body.ok, true)
  assert.equal(out.body.data.service, 'dsh-workbay-source-control')
  assert.equal(out.body.data.dependencies, null, 'no way to probe means null, not a fabricated list')
  assert.equal(out.body.data.allMounted, null)
  await booted.close()
})

test('the route refuses a non-JSON content type (the CSRF gap a form could use)', async () => {
  /* A loopback-peer request is trusted by design — this machine IS the user. The
     gap that leaves is a page from ANOTHER origin posting here: a form can do
     that with no CORS preflight using a "simple" content type. Requiring
     application/json forces a preflight this server never answers.
     (The peer/Host branches of the fence are covered in kit's own tests; asserting
     them here through a real socket cannot work, because the test client IS
     loopback.) */
  const booted = await boot()
  for (const bad of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']) {
    const refused = await booted.post('status', { a: 1 }, { 'content-type': bad })
    assert.equal(refused.status, 415, 'content-type "' + bad + '" must be refused, got ' + refused.status)
    assert.equal(refused.body.ok, false)
    assert.equal(refused.body.error.code, 'unsupported-media-type')
  }
  await booted.close()
})

test('an unknown method is rejected, not silently accepted', async () => {
  const booted = await boot()
  const out = await booted.post('does-not-exist', {})
  assert.ok(out.status >= 400, 'unknown methods 4xx, got ' + out.status)
  assert.equal(out.body.ok, false)
  await booted.close()
})

test('the patch inserts exactly one row, named after the package', () => {
  const patch = readFileSync(path.join(pkgRoot, 'cordis.patch.yml'), 'utf8')
  assert.equal((patch.match(/- insert:/g) || []).length, 1, 'one insert block')
  assert.match(patch, /name: 'dsh-workbay-source-control'/)
  /* Two rows would register the prefix twice and DSH refuses to boot the whole
     plugin tree — the same failure that makes suite-with-standalones illegal. */
  assert.equal((patch.match(/name: '/g) || []).length, 1)
})

test('the package declares a client half and a bundle patch', () => {
  const manifest = JSON.parse(readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'))
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.exports['./client'], './src/client.js')
  assert.ok(Array.isArray(manifest.dsh.client.inject))
  assert.equal(manifest.dsh.client.platform, 'web')
})

test('the client half is a ModuleLoader bundle that registers one page', () => {
  const source = readFileSync(path.join(pkgRoot, 'src/client.js'), 'utf8')
  assert.ok(source.includes("window.__ModuleLoader__.load({"), 'must use the host loader')
  assert.match(source, /id: 'dsh-workbay-source-control'/)
  assert.match(source, /registerPage\(/)
  /* The page must land between the files page (10) and the git page (20), so the
     composed view sits where a person would look for it. */
  assert.match(source, /order: 15/)
})

