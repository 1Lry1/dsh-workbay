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
