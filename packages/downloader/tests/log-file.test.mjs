/**
 * Log-file persistence tests (host half), with the file directed at a temp dir.
 *
 * The host reads `DSH_DOWNLOADER_LOG_DIR` at import time, so this file sets it
 * before the dynamic import (with a cache-busting query string) and boots the
 * plugin against a stub ctx + a local HTTP server — no DSH, no hardware.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const modulePath = path.join(here, '..', 'lib', 'index.js')
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-dl-log-'))
const logFile = path.join(tmpDir, 'downloader.jsonl')

let server
let base

function line(t, src, text) {
  return JSON.stringify({ t, src, text })
}

before(async () => {
  process.env.DSH_DOWNLOADER_LOG_DIR = tmpDir
  const seeded = [
    line(1_700_000_000_000, 'S', '已连接 Downloader'),
    line(1_700_000_001_000, 'B', 'board boot ok'),
    line(1_700_000_002_000, 'D', 'flash 100%'),
    '{"t": broken json line', // torn tail line must be skipped
  ]
  fs.writeFileSync(logFile, seeded.join('\n') + '\n', 'utf8')

  const mod = await import(pathToFileURL(modulePath).href + '?persist=' + Date.now())
  const routes = []
  const ctx = {
    inject(deps, cb) { const scoped = { ...ctx, tools: { register() {} } }; cb(scoped); return () => {} },
    effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    get() { return undefined },
    webServer: { register(route) { routes.push(route); return () => {} } },
    tools: { register() {} },
  }
  mod.apply(ctx)

  server = createServer(async (req, res) => {
    const route = routes.find((r) => req.url.startsWith(r.path))
    if (route === undefined) { res.writeHead(404); res.end(); return }
    await route.handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  if (server) { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)) }
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('a non-empty log file is restored into the workbench state on boot', async () => {
  const state = await (await fetch(base + '/downloader/state')).json()
  assert.equal(state.logs.length, 3, 'three valid JSONL lines (torn tail skipped)')
  assert.equal(state.logs[0].text, '已连接 Downloader')
  assert.equal(state.logs[2].src, 'D')
  assert.equal(state.logFile.exists, true)
  assert.ok(state.logFile.size > 0)
  assert.equal(state.logFile.path, logFile)
})

test('/log/file reports the path and occupancy shown in the page', async () => {
  const info = await (await fetch(base + '/downloader/log/file')).json()
  assert.equal(info.path, logFile)
  assert.equal(info.exists, true)
  assert.ok(info.size > 0)
  assert.ok(fs.statSync(logFile).size > 0)
})

test('/log/history pages older lines out of the file', async () => {
  const all = await (await fetch(base + '/downloader/log/history?limit=10')).json()
  assert.equal(all.logs.length, 3)
  assert.equal(all.hasMore, false)
  const beforeSecond = await (await fetch(base + '/downloader/log/history?before=1700000001500&limit=10')).json()
  assert.equal(beforeSecond.logs.length, 2)
  assert.equal(beforeSecond.logs[0].text, '已连接 Downloader')
  assert.equal(beforeSecond.logs[1].text, 'board boot ok')
  assert.equal(beforeSecond.hasMore, false)
  const none = await (await fetch(base + '/downloader/log/history?before=1&limit=10')).json()
  assert.equal(none.logs.length, 0)
})
test('clearing the logs truncates the local file too', async () => {
  const cleared = await (await fetch(base + '/downloader/log/clear', { method: 'POST' })).json()
  assert.equal(cleared.ok, true)
  assert.equal(fs.statSync(logFile).size, 0, 'file is truncated, not just the UI')
  const state = await (await fetch(base + '/downloader/state')).json()
  assert.equal(state.logs.length, 0)
  assert.equal(state.logFile.exists, false)
})

test('an empty log file means nothing is loaded', async () => {
  // Re-boot a fresh module instance against the now-empty file.
  const mod = await import(pathToFileURL(modulePath).href + '?persist2=' + Date.now())
  const routes = []
  const ctx = {
    inject(deps, cb) { const scoped = { ...ctx, tools: { register() {} } }; cb(scoped); return () => {} },
    effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    get() { return undefined },
    webServer: { register(route) { routes.push(route); return () => {} } },
    tools: { register() {} },
  }
  mod.apply(ctx)
  const local = createServer(async (req, res) => {
    const route = routes.find((r) => req.url.startsWith(r.path))
    if (route === undefined) { res.writeHead(404); res.end(); return }
    await route.handler(req, res)
  })
  await new Promise((resolve) => local.listen(0, '127.0.0.1', resolve))
  const localBase = `http://127.0.0.1:${local.address().port}`
  const state = await (await fetch(localBase + '/downloader/state')).json()
  assert.equal(state.logs.length, 0)
  assert.equal(state.logFile.exists, false)
  local.closeAllConnections?.()
  await new Promise((resolve) => local.close(resolve))
})
