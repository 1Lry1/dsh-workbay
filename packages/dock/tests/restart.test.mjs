/** The workbench restart endpoint schedules HMR reconciliation, not a DSH kill. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { apply } from '../src/index.js'

test('POST /api/restart schedules HMR profile reconciliation after responding', async () => {
  let handler = null
  const hmr = {
    reconciled: 0,
    runExclusive: async (operation) => operation(),
    reconcileProfile: async () => { hmr.reconciled += 1; return { warnings: [], pending: [] } },
  }
  const ctx = {
    webServer: { register(route) { handler = route.handler; return () => {} } },
    tools: { register() { return () => {} } },
    get(name) { return name === 'hmr' ? hmr : undefined },
    provide() {},
    inject(names, callback) { callback(ctx) },
    effect(fn) { try { return fn() ?? (() => {}) } catch { return () => {} } },
    logger: { error() {}, warn() {}, info() {} },
  }
  apply(ctx)
  assert.equal(typeof handler, 'function')

  const server = createServer((req, res) => { void handler(req, res) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + server.address().port
  try {
    const response = await fetch(base + '/dsh-workbay-dock/api/restart', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.data.ok, true)
    assert.equal(body.data.scheduled, true)
    /* The reconcile is deliberately scheduled after the response. */
    await new Promise((resolve) => setTimeout(resolve, 700))
    assert.equal(hmr.reconciled, 1)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('restart endpoint reports no-hmr instead of pretending success', async () => {
  let handler = null
  const ctx = {
    webServer: { register(route) { handler = route.handler; return () => {} } },
    tools: { register() { return () => {} } },
    get() { return undefined },
    provide() {},
    inject(names, callback) { callback(ctx) },
    effect(fn) { try { return fn() ?? (() => {}) } catch { return () => {} } },
    logger: { error() {}, warn() {}, info() {} },
  }
  apply(ctx)
  const server = createServer((req, res) => { void handler(req, res) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + server.address().port
  try {
    const response = await fetch(base + '/dsh-workbay-dock/api/restart', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    const body = await response.json()
    assert.equal(body.data.ok, false)
    assert.equal(body.data.code, 'no-hmr')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('POST /api/load returns the sampled envelope', async () => {
  let handler = null
  /* Same fixture shape as the restart tests above: `apply` only needs a web
     server to register on. The load route must not require HMR, so `get`
     answers undefined for everything. */
  const ctx = {
    webServer: { register(route) { handler = route.handler; return () => {} } },
    tools: { register() { return () => {} } },
    get() { return undefined },
    provide() {},
    inject(names, callback) { callback(ctx) },
    effect(fn) { try { return fn() ?? (() => {}) } catch { return () => {} } },
    logger: { error() {}, warn() {}, info() {} },
  }
  apply(ctx)
  assert.equal(typeof handler, 'function')
  const server = createServer((req, res) => { void handler(req, res) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + server.address().port
  try {
    const response = await fetch(base + '/dsh-workbay-dock/api/load', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(body.ok, true)
    assert.equal(typeof body.data.at, 'number')
    /* Both keys must be present even when the value is null: the client keys its
       "—" placeholder off presence, and an absent key reads as a malformed reply. */
    assert.equal('cpu' in body.data, true)
    assert.equal('gpu' in body.data, true)
    assert.equal(typeof body.data.mem.usedPct, 'number')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('POST /api/load reports a real CPU reading once a baseline exists', async () => {
  let handler = null
  const ctx = {
    webServer: { register(route) { handler = route.handler; return () => {} } },
    tools: { register() { return () => {} } },
    get() { return undefined },
    provide() {},
    inject(names, callback) { callback(ctx) },
    effect(fn) { try { return fn() ?? (() => {}) } catch { return () => {} } },
    logger: { error() {}, warn() {}, info() {} },
  }
  apply(ctx)
  const server = createServer((req, res) => { void handler(req, res) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + server.address().port
  const post = async () => {
    const response = await fetch(base + '/dsh-workbay-dock/api/load', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    return (await response.json()).data
  }
  try {
    /* The readers are module-scoped on purpose (state must survive across
       requests), so an earlier test in this file may already have built the
       baseline. The "first call returns null" contract belongs to
       `createCpuReader` and is pinned in load.test.mjs; at the route level the
       contract worth pinning is steady state: two calls separated by real ticks
       yield a percentage in range. */
    await post()
    await new Promise((resolve) => setTimeout(resolve, 250))
    const sampled = await post()
    assert.equal(typeof sampled.cpu, 'number')
    assert.ok(sampled.cpu >= 0 && sampled.cpu <= 100)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
