/**
 * Host-half tests for dsh-workbay-terminal.
 *
 * Boots the plugin through a fake cordis context (the same shape
 * packages/gitcraft/tests/host.test.mjs uses), mounts the captured route
 * handlers on a REAL HTTP server, and drives sessions against a throwaway
 * directory in the OS temp dir.
 *
 * Real shells are spawned on purpose: the contract's whole point is that a
 * persistent process reads raw stdin and its output streams over SSE, which a
 * mocked child_process could not prove. Every session is stopped in `after`,
 * and each test stops its own session even when an assertion fails.
 *
 * Run:  node --test tests/host.test.mjs
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const plugin = await import('../src/index.js')

const TEST_SHELL = process.platform === 'win32' ? 'powershell.exe' : 'sh'
const TEST_NEWLINE = '\n'

/** @type {Array<{ dispose: () => Promise<void> }>} */
const boots = []
let sandbox
let workspace
let filePath
let missingPath
let bootA
let bootB

/* ============================== helpers ============================== */

function canonicalPath(value) {
  const native = typeof realpathSync.native === 'function' ? realpathSync.native : realpathSync
  try {
    return native(value)
  } catch {
    return path.resolve(value)
  }
}

function samePath(left, right) {
  const a = canonicalPath(left)
  const b = canonicalPath(right)
  return process.platform === 'win32'
    ? a.toLowerCase() === b.toLowerCase()
    : a === b
}

/**
 * Boot one plugin instance on its own HTTP server. Two instances with different
 * configs are needed: one normal instance for the streaming tests, one with
 * `maxSessions: 1` and a short idle timeout for the limit tests.
 */
function bootPlugin(config) {
  const routes = new Map()
  const effects = []
  const ctx = {
    effect(setup) {
      const cleanup = setup()
      if (typeof cleanup === 'function') effects.push(cleanup)
      return () => { if (typeof cleanup === 'function') cleanup() }
    },
    webServer: {
      register({ kind, path: routePath, handler }) {
        routes.set(routePath, { kind, path: routePath, handler })
        return () => { routes.delete(routePath) }
      },
    },
  }
  plugin.apply(ctx, config === undefined ? {} : config)

  const server = createServer((req, res) => {
    let pathname
    try {
      pathname = new URL(req.url === undefined ? '/' : req.url, 'http://dsh.internal').pathname
    } catch {
      res.writeHead(400)
      res.end()
      return
    }
    let match = null
    for (const route of routes.values()) {
      const hit = route.kind === 'prefix' ? pathname.startsWith(route.path) : pathname === route.path
      if (hit && (match === null || route.path.length > match.path.length)) match = route
    }
    if (match === null) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('no route')
      return
    }
    void Promise.resolve(match.handler(req, res)).catch((error) => {
      if (res.headersSent) {
        try { res.end() } catch { /* already gone */ }
        return
      }
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end(String(error))
    })
  })

  let baseUrl = ''
  let disposing = null
  const boot = {
    routes,
    get baseUrl() { return baseUrl },
    async call(method, payload) {
      const response = await fetch(baseUrl + '/dsh-workbay-terminal/api/' + method, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload === undefined ? {} : payload),
      })
      let body = null
      try { body = await response.json() } catch { body = null }
      return { status: response.status, ...(body === null ? {} : body) }
    },
    dispose() {
      if (disposing !== null) return disposing
      disposing = (async () => {
        for (const cleanup of effects.splice(0).reverse()) {
          try { await cleanup() } catch { /* best effort */ }
        }
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
        await new Promise((resolve) => server.close(resolve))
      })()
      return disposing
    },
  }
  boots.push(boot)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      baseUrl = 'http://127.0.0.1:' + server.address().port
      resolve(boot)
    })
  })
}

/**
 * Minimal SSE client: resolves `waitFor(predicate)` against parsed `data:`
 * JSON events, ignores heartbeat comments, aborts cleanly.
 */
function openEvents(baseUrl, id) {
  const controller = new AbortController()
  const events = []
  const waiters = new Set()
  let closed = false

  const notify = (event) => {
    for (const waiter of [...waiters]) {
      if (waiter.predicate(event)) {
        waiters.delete(waiter)
        clearTimeout(waiter.timer)
        waiter.resolve(event)
      }
    }
  }

  const ready = (async () => {
    const response = await fetch(
      baseUrl + '/dsh-workbay-terminal/events?id=' + encodeURIComponent(id),
      { headers: { accept: 'text/event-stream' }, signal: controller.signal },
    )
    if (!response.ok) throw new Error('SSE request failed with HTTP ' + response.status)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let boundary = buffer.indexOf('\n\n')
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const data = block
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim())
            .join('\n')
          if (data !== '') {
            try {
              const event = JSON.parse(data)
              events.push(event)
              notify(event)
            } catch { /* not our event */ }
          }
          boundary = buffer.indexOf('\n\n')
        }
      }
    } catch (error) {
      if (!closed && !(error instanceof DOMException && error.name === 'AbortError')) throw error
    }
  })()
  /* The wrapper's `ready` is what tests await before calling waitFor, and an
     early failure must not become an unhandled rejection. */
  ready.catch(() => undefined)

  return {
    ready,
    events,
    waitFor(predicate, timeoutMs = 10_000) {
      const existing = events.find(predicate)
      if (existing !== undefined) return Promise.resolve(existing)
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          timer: setTimeout(() => {
            waiters.delete(waiter)
            reject(new Error('timed out waiting for an SSE event'))
          }, timeoutMs),
        }
        waiters.add(waiter)
      })
    },
    close() {
      closed = true
      for (const waiter of [...waiters]) {
        clearTimeout(waiter.timer)
        waiters.delete(waiter)
      }
      controller.abort()
    },
  }
}

async function waitUntil(predicate, timeoutMs = 10_000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return false
}

async function startSession(boot, root) {
  const out = await boot.call('start', { root: root === undefined ? workspace : root })
  assert.equal(out.ok, true, 'start failed: ' + JSON.stringify(out))
  return out.data
}

/* ============================== lifecycle ============================== */

before(async () => {
  sandbox = mkdtempSync(path.join(tmpdir(), 'gwt-'))
  workspace = path.join(sandbox, 'workspace')
  mkdirSync(workspace, { recursive: true })
  filePath = path.join(sandbox, 'not-a-directory.txt')
  writeFileSync(filePath, 'not a workspace\n')
  missingPath = path.join(sandbox, 'missing-dir')

  bootA = await bootPlugin({ shell: TEST_SHELL, maxSessions: 4, idleTimeoutMs: 60_000 })
  bootB = await bootPlugin({ shell: TEST_SHELL, maxSessions: 1, idleTimeoutMs: 1_500 })
})

after(async () => {
  for (const boot of boots) {
    try { await boot.dispose() } catch { /* already gone */ }
  }
  if (sandbox !== undefined) {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

/* ============================== tests ============================== */

test('start returns a live session and list reports its cwd', async () => {
  const session = await startSession(bootA)
  try {
    assert.equal(typeof session.id, 'string')
    assert.ok(session.id.length >= 8)
    assert.equal(path.isAbsolute(session.cwd), true)
    assert.equal(samePath(session.cwd, workspace), true, 'cwd should be the requested workspace')
    assert.ok(session.shell.toLowerCase().includes(path.basename(TEST_SHELL, '.exe')), 'shell = ' + session.shell)

    const listed = await bootA.call('list', {})
    assert.equal(listed.ok, true)
    const entry = listed.data.sessions.find((item) => item.id === session.id)
    assert.ok(entry !== undefined, 'list should contain the new session')
    assert.equal(entry.cwd, session.cwd)
    assert.equal(typeof entry.startedAt, 'number')
  } finally {
    const stopped = await bootA.call('stop', { id: session.id })
    assert.equal(stopped.ok, true)
  }
})

test('the SSE stream carries the output of a command written to stdin', async () => {
  const session = await startSession(bootA)
  const stream = openEvents(bootA.baseUrl, session.id)
  try {
    const hello = await stream.waitFor((event) => event.type === 'hello')
    assert.equal(hello.cwd, session.cwd)
    assert.equal(typeof hello.shell, 'string')
    assert.ok(hello.shell.length > 0)

    const sent = await bootA.call('input', { id: session.id, data: 'echo workbay-ok' + TEST_NEWLINE })
    assert.equal(sent.ok, true, JSON.stringify(sent))
    assert.equal(sent.data.ok, true)

    const output = await stream.waitFor(
      (event) => event.type === 'out' && typeof event.data === 'string' && event.data.includes('workbay-ok'),
      20_000,
    ).catch(async (error) => {
      /* CI-only failures need evidence, not just "timed out": a shell that died
         on startup shows up as an exit/error event and an empty session list. */
      let sessions = null
      try { sessions = (await bootA.call('list', {})).data } catch { /* ignore */ }
      throw new Error(
        `${error.message}; lastEvents=${JSON.stringify(stream.events.slice(-8))}; sessions=${JSON.stringify(sessions)}`,
      )
    })
    assert.ok(output.data.length > 0)
  } finally {
    stream.close()
    await bootA.call('stop', { id: session.id })
  }
})

test('stop emits an exit event and leaves no session behind', async () => {
  const session = await startSession(bootA)
  const stream = openEvents(bootA.baseUrl, session.id)
  try {
    await stream.waitFor((event) => event.type === 'hello')
    const stopped = await bootA.call('stop', { id: session.id })
    assert.equal(stopped.ok, true)

    const exit = await stream.waitFor((event) => event.type === 'exit', 10_000)
    assert.equal(typeof exit.code, 'number', 'exit should carry a numeric code')

    const emptied = await waitUntil(async () => {
      const listed = await bootA.call('list', {})
      return listed.ok === true && listed.data.sessions.length === 0
    }, 10_000)
    assert.equal(emptied, true, 'the session should be gone from list after exit')
  } finally {
    stream.close()
  }
})

test('start refuses a relative root with 400', async () => {
  const out = await bootA.call('start', { root: 'relative\\workspace' })
  assert.equal(out.status, 400)
  assert.equal(out.ok, false)
  assert.equal(out.error.code, 'bad-request')
})

test('start refuses a missing root with 400', async () => {
  const out = await bootA.call('start', { root: missingPath })
  assert.equal(out.status, 400)
  assert.equal(out.ok, false)
  assert.equal(out.error.code, 'bad-request')
})

test('start refuses a root that is not a directory with 400', async () => {
  const out = await bootA.call('start', { root: filePath })
  assert.equal(out.status, 400)
  assert.equal(out.ok, false)
  assert.equal(out.error.code, 'bad-request')
})

test('unknown session ids are 404 for input, stop and events', async () => {
  const input = await bootA.call('input', { id: 'no-such-session', data: 'x\n' })
  assert.equal(input.status, 404)
  assert.equal(input.error.code, 'not-found')

  const stop = await bootA.call('stop', { id: 'no-such-session' })
  assert.equal(stop.status, 404)
  assert.equal(stop.error.code, 'not-found')

  const stream = await fetch(bootA.baseUrl + '/dsh-workbay-terminal/events?id=no-such-session')
  assert.equal(stream.status, 404)
  const body = await stream.json()
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'not-found')
})

test('a non-POST request on the JSON API is refused with 405', async () => {
  const response = await fetch(bootA.baseUrl + '/dsh-workbay-terminal/api/list', { method: 'GET' })
  assert.equal(response.status, 405)
  const body = await response.json()
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'method-error')
})

test('an untrusted host is refused by the trust fence with 403', async () => {
  const apiRoute = bootA.routes.get('/dsh-workbay-terminal/api')
  const eventsRoute = bootA.routes.get('/dsh-workbay-terminal/events')
  assert.ok(apiRoute !== undefined)
  assert.ok(eventsRoute !== undefined)

  const makeRequest = (url) => ({
    method: 'POST',
    url,
    headers: { host: 'evil.example', 'sec-fetch-site': 'cross-site' },
    socket: { remoteAddress: '10.9.9.9' },
    on() { /* the fence refuses before the body is read */ },
  })
  const makeResponse = () => ({
    statusCode: 0,
    body: '',
    writeHead(status) { this.statusCode = status },
    end(body) { this.body = typeof body === 'string' ? body : '' },
  })

  const apiResponse = makeResponse()
  await apiRoute.handler(makeRequest('/dsh-workbay-terminal/api/list'), apiResponse)
  assert.equal(apiResponse.statusCode, 403)
  assert.equal(JSON.parse(apiResponse.body).error.code, 'forbidden')

  const eventsResponse = makeResponse()
  await eventsRoute.handler(makeRequest('/dsh-workbay-terminal/events?id=x'), eventsResponse)
  assert.equal(eventsResponse.statusCode, 403)
  assert.equal(JSON.parse(eventsResponse.body).error.code, 'forbidden')
})

test('the events route requires a session id with 400', async () => {
  const response = await fetch(bootA.baseUrl + '/dsh-workbay-terminal/events')
  assert.equal(response.status, 400)
  const body = await response.json()
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'bad-request')
})

test('input requires a string data field with 400', async () => {
  const session = await startSession(bootA)
  try {
    const out = await bootA.call('input', { id: session.id })
    assert.equal(out.status, 400)
    assert.equal(out.error.code, 'bad-request')
  } finally {
    await bootA.call('stop', { id: session.id })
  }
})

test('maxSessions is enforced with a 409 session-limit', async () => {
  const first = await startSession(bootB)
  try {
    const second = await bootB.call('start', { root: workspace })
    assert.equal(second.status, 409)
    assert.equal(second.ok, false)
    assert.equal(second.error.code, 'session-limit')
  } finally {
    const stopped = await bootB.call('stop', { id: first.id })
    assert.equal(stopped.ok, true)
    await waitUntil(async () => {
      const listed = await bootB.call('list', {})
      return listed.ok === true && listed.data.sessions.length === 0
    }, 10_000)
  }
})

test('an idle session is stopped automatically', async () => {
  const session = await startSession(bootB)
  const stream = openEvents(bootB.baseUrl, session.id)
  try {
    await stream.waitFor((event) => event.type === 'hello')
    /* bootB's idleTimeoutMs is 1.5 s; no input is sent. */
    const exit = await stream.waitFor((event) => event.type === 'exit', 10_000)
    assert.equal(typeof exit.code, 'number')
    const emptied = await waitUntil(async () => {
      const listed = await bootB.call('list', {})
      return listed.ok === true && listed.data.sessions.length === 0
    }, 10_000)
    assert.equal(emptied, true, 'the idle session should be gone from list')
  } finally {
    stream.close()
  }
})

test('a missing shell binary is reported as 500 shell-missing', async () => {
  const boot = await bootPlugin({
    shell: 'dsh-workbay-shell-that-does-not-exist',
    maxSessions: 1,
    idleTimeoutMs: 60_000,
  })
  const out = await boot.call('start', { root: workspace })
  assert.equal(out.status, 500)
  assert.equal(out.ok, false)
  assert.equal(out.error.code, 'shell-missing')
  assert.equal((await boot.call('list', {})).data.sessions.length, 0)
})

test('the default shell is powershell on Windows', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('the contract default (powershell.exe) only exists on Windows')
    return
  }
  const boot = await bootPlugin({})
  const session = await startSession(boot)
  try {
    assert.equal(session.shell, 'powershell.exe')
  } finally {
    await boot.call('stop', { id: session.id })
  }
})
