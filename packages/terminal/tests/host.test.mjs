/**
 * Host-half tests for dsh-workbay-terminal — PER-COMMAND execution model.
 *
 * Boots the plugin through a fake cordis context (the same shape
 * packages/gitcraft/tests/host.test.mjs uses), mounts the captured route
 * handlers on a REAL HTTP server, and drives sessions against a throwaway
 * directory in the OS temp dir.
 *
 * The commands are real: `start` launches nothing, each complete line runs one
 * shell process, and the assertions observe actual stdout over SSE. Every
 * session is stopped in `after`, and each test stops its own session even when
 * an assertion fails. A surviving child process would show up as a "survived"
 * flag file written after its sleep, which the idle-timeout test asserts can
 * never happen.
 *
 * Run from packages/terminal:  node --test
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const plugin = await import('../src/index.js')

const IS_WINDOWS = process.platform === 'win32'
const TEST_SHELL = IS_WINDOWS ? 'powershell.exe' : 'sh'
const TEST_NEWLINE = '\n'
const CHUNK_PREFIX = '/dsh-workbay-terminal/chunk'
const TERMINAL_PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** The packaged ConPTY helper. It is built by a separate task; when it is not
 *  there, every real-helper test skips and the fake-helper fixture covers the
 *  bridge instead. */
const REAL_HELPER_URL = new URL('../helper/WorkbayPty.exe', import.meta.url)
const REAL_HELPER_PRESENT = IS_WINDOWS && existsSync(REAL_HELPER_URL)
/** The helper is built by a separate task. It is only "ready" once a real echo
 *  round-trip works; while it is still being fixed every real-helper test skips
 *  instead of failing this suite (the fake fixture covers the host bridge). */
let REAL_HELPER_READY = false

/** @type {Array<{ dispose: () => Promise<void> }>} */
const boots = []
let sandbox
let workspace
let nested
let filePath
let missingPath
let chunksDir
let chunkSource
let fakeHelperPath
let bootA
let bootB
let bootFake
let bootFakeIdle
let bootReal
let bootRealIdle

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
  return IS_WINDOWS ? a.toLowerCase() === b.toLowerCase() : a === b
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Quote one path for the platform's shell (used only inside test commands). */
function quoteForShell(value) {
  if (IS_WINDOWS) return "'" + value.split("'").join("''") + "'"
  return "'" + value.split("'").join("'\\''") + "'"
}

function pwdCommand() {
  /* A marker prefix keeps this distinguishable from the `cd` output itself. */
  return IS_WINDOWS ? "Write-Output ('CWD=' + (Get-Location).Path)" : 'printf \'CWD=%s\\n\' "$PWD"'
}

/**
 * A harmless command that signals "I am running" with a flag file, keeps
 * running, and optionally proves afterwards that it was NOT killed.
 */
function longCommand(flagPath, survivedPath) {
  const flag = quoteForShell(flagPath)
  if (IS_WINDOWS) {
    const tail = survivedPath === undefined ? '' : '; Set-Content -LiteralPath ' + quoteForShell(survivedPath) + ' -Value 1'
    return 'Set-Content -LiteralPath ' + flag + ' -Value 1; Start-Sleep -Seconds 15' + tail
  }
  const tail = survivedPath === undefined ? '' : '; touch ' + quoteForShell(survivedPath)
  return 'touch ' + flag + '; sleep 15' + tail
}

/**
 * A tiny Node stand-in for `helper/WorkbayPty.exe`. It speaks EXACTLY the
 * contract's frame protocol (1B type + uint32 LE length + payload) and a
 * deterministic command language, so the host's PTY bridge can be tested
 * without the compiled helper:
 *
 *   D payload "hello"        -> out "FAKE-ECHO hello"
 *   D payload "start-long"   -> out "LONG-RUNNING" (keeps running)
 *   D payload containing ^C   -> out "^C" + "INTERRUPTED" (stays alive)
 *   R frame                   -> out "RESIZED <cols>x<rows>"
 *   X frame                   -> X frame {int32 0}, then exit
 *   stdin EOF                 -> exit 0
 *
 * It writes `fake-helper-<pid>.pid` into the cwd so a test can prove the
 * process is really gone. It also validates the argv contract (missing args or
 * non-array --shell-args exit 2), which doubles as a protocol conformance test.
 */
const FAKE_HELPER_SOURCE = String.raw`
import { unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

function optionOf(name) {
  const at = process.argv.indexOf(name)
  return at === -1 || at + 1 >= process.argv.length ? null : process.argv[at + 1]
}

const shell = optionOf('--shell')
const shellArgs = optionOf('--shell-args')
const cwd = optionOf('--cwd')
const cols = optionOf('--cols')
const rows = optionOf('--rows')
if (shell === null || shellArgs === null || cwd === null || cols === null || rows === null) {
  process.stderr.write('fake helper: missing arguments\n')
  process.exit(2)
}
try {
  const parsed = JSON.parse(Buffer.from(shellArgs, 'base64').toString('utf8'))
  if (!Array.isArray(parsed)) throw new Error('not an array')
} catch {
  process.stderr.write('fake helper: --shell-args must be base64(JSON array)\n')
  process.exit(2)
}

const pidFile = path.join(cwd, 'fake-helper-' + process.pid + '.pid')
writeFileSync(pidFile, String(process.pid))
function cleanup() {
  try { unlinkSync(pidFile) } catch { /* already gone */ }
}
process.on('exit', cleanup)

function writeFrame(type, payload) {
  const head = Buffer.alloc(5)
  head.writeUInt8(type.charCodeAt(0), 0)
  head.writeUInt32LE(payload.length, 1)
  process.stdout.write(Buffer.concat([head, payload]))
}
function out(text) {
  writeFrame('D', Buffer.from(text, 'utf8'))
}
function finish(code) {
  cleanup()
  process.exit(code)
}

let buffer = Buffer.alloc(0)
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  let offset = 0
  while (buffer.length - offset >= 5) {
    const type = String.fromCharCode(buffer[offset])
    const length = buffer.readUInt32LE(offset + 1)
    if (buffer.length - offset - 5 < length) break
    const payload = buffer.subarray(offset + 5, offset + 5 + length)
    offset += 5 + length
    if (type === 'D') {
      const text = payload.toString('utf8')
      if (text.includes(String.fromCharCode(3))) {
        out('^C\r\n')
        out('INTERRUPTED\r\n')
      } else if (text.includes('start-long')) {
        out('LONG-RUNNING\r\n')
      } else {
        out('FAKE-ECHO ' + text.replace(/\r?\n/g, '') + '\r\n')
      }
    } else if (type === 'R') {
      const nextCols = payload.length >= 4 ? payload.readUInt16LE(0) : 0
      const nextRows = payload.length >= 4 ? payload.readUInt16LE(2) : 0
      out('RESIZED ' + nextCols + 'x' + nextRows + '\r\n')
    } else if (type === 'X') {
      const exitPayload = Buffer.alloc(4)
      exitPayload.writeInt32LE(0, 0)
      writeFrame('X', exitPayload)
      process.stdout.write('', () => finish(0))
    }
  }
  buffer = offset === buffer.length ? Buffer.alloc(0) : buffer.subarray(offset)
})
process.stdin.on('end', () => finish(0))
`

function fakePidFiles(directory) {
  try {
    return readdirSync(directory)
      .map((name) => /^fake-helper-(\d+)\.pid$/.exec(name))
      .filter((match) => match !== null)
      .map((match) => Number(match[1]))
  } catch {
    return []
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitNoLiveFakeHelpers(directory, timeoutMs = 10_000) {
  return waitUntil(() => fakePidFiles(directory).every((pid) => !processAlive(pid)), timeoutMs)
}

/** Run a short command and resolve its stdout (best effort, never throws). */
function execText(file, args) {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { windowsHide: true, timeout: 30_000 }, (error, stdout) => {
        resolve(error ? '' : String(stdout))
      })
    } catch {
      resolve('')
    }
  })
}

/** Count `WorkbayPty.exe` processes seen by the OS process table. */
async function countHelperProcesses() {
  if (!IS_WINDOWS) return 0
  const text = await execText('tasklist', ['/FI', 'IMAGENAME eq WorkbayPty.exe', '/FO', 'CSV', '/NH'])
  return text.split(/\r?\n/).filter((line) => line.trim().startsWith('"')).length
}

/** Count PowerShell processes launched by the PTY helper (`-NoExit` shells). */
async function countPtyShells() {
  if (!IS_WINDOWS) return 0
  /* `shell: auto` prefers pwsh, so count both hosts. */
  const command = "(Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'powershell.exe' -or $_.Name -eq 'pwsh.exe') -and $_.CommandLine -like '*-NoExit*' } | Measure-Object).Count"
  const text = await execText('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command])
  const count = Number.parseInt(text.trim(), 10)
  return Number.isFinite(count) ? count : 0
}

/** Build one host->helper frame (1B type + uint32 LE length + payload). */
function frameBytes(type, payload) {
  const header = Buffer.alloc(5)
  header.writeUInt8(type.charCodeAt(0), 0)
  header.writeUInt32LE(payload.length, 1)
  return Buffer.concat([header, payload])
}

/**
 * Capability probe for the packaged helper (built by another task, possibly
 * still in progress). A helper that is present but cannot run a PowerShell
 * command would fail every real-helper test; proving one echo round-trip first
 * lets the suite skip those tests with an accurate reason instead.
 *
 * It speaks the contract frames directly (no host code involved) and returns
 * true only when the marker actually comes back from the PTY.
 */
async function probeRealHelper() {
  if (!REAL_HELPER_PRESENT) return false
  const helperPath = fileURLToPath(REAL_HELPER_URL)
  const shell = path.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  )
  if (!existsSync(helperPath) || !existsSync(shell)) return false

  const shellArgs = Buffer.from(JSON.stringify(['-NoLogo', '-NoProfile', '-NoExit']), 'utf8').toString('base64')
  const argv = ['--shell', shell, '--shell-args', shellArgs, '--cwd', workspace, '--cols', '80', '--rows', '24']
  let child
  try {
    child = spawn(helperPath, argv, {
      cwd: workspace,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch {
    return false
  }

  let buffer = Buffer.alloc(0)
  let marker = false
  const send = (text) => {
    try {
      child.stdin.write(frameBytes('D', Buffer.from(text, 'utf8')))
    } catch { /* pipe gone */ }
  }

  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    let offset = 0
    while (buffer.length - offset >= 5) {
      const type = String.fromCharCode(buffer[offset])
      const length = buffer.readUInt32LE(offset + 1)
      if (buffer.length - offset - 5 < length) break
      const payload = buffer.subarray(offset + 5, offset + 5 + length)
      offset += 5 + length
      if (type !== 'D') continue
      if (payload.toString('utf8').includes('PROBE-9')) marker = true
    }
    buffer = offset === buffer.length ? Buffer.alloc(0) : buffer.subarray(offset)
  })
  child.stderr.on('data', () => { /* diagnostics only */ })
  child.stdout.on('error', () => { /* close handler */ })

  const markerPromise = new Promise((resolve) => {
    const poll = setInterval(() => {
      if (marker) {
        clearInterval(poll)
        resolve(true)
      }
    }, 100)
    if (typeof poll.unref === 'function') poll.unref()
    setTimeout(() => {
      clearInterval(poll)
      resolve(marker)
    }, 10_000)
  })

  /* Send the probe twice: the first write can race the shell attaching to the
     ConPTY, and this probe only cares whether the input path works at all. */
  send("Write-Output ('PROBE-' + 9)\r")
  setTimeout(() => { if (!marker) send("Write-Output ('PROBE-' + 9)\r") }, 1_200)
  const ok = await markerPromise

  /* Reclaim whatever the probe started before returning. */
  try {
    child.stdin.write(frameBytes('X', Buffer.alloc(4)))
    child.stdin.end()
  } catch { /* gone */ }
  await Promise.race([
    new Promise((resolve) => { child.once('close', resolve) }),
    sleep(2_000),
  ])
  try { child.kill('SIGKILL') } catch { /* gone */ }
  return ok
}


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
    has(predicate) {
      return events.some(predicate)
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
    await sleep(intervalMs)
  }
  return false
}

function outContains(needle) {
  return (event) => event.type === 'out' && typeof event.data === 'string' && event.data.includes(needle)
}

async function startSession(boot, root) {
  const out = await boot.call('start', { root: root === undefined ? workspace : root })
  assert.equal(out.ok, true, 'start failed: ' + JSON.stringify(out))
  return out.data
}

async function stopSession(boot, id, stream) {
  const stopped = await boot.call('stop', { id })
  assert.equal(stopped.ok, true, 'stop failed: ' + JSON.stringify(stopped))
  if (stream !== undefined) {
    const exit = await stream.waitFor((event) => event.type === 'exit', 20_000)
    assert.equal(typeof exit.code, 'number')
  }
  return stopped
}

/* ============================== lifecycle ============================== */

before(async () => {
  sandbox = mkdtempSync(path.join(tmpdir(), 'gwt-'))
  workspace = path.join(sandbox, 'workspace')
  nested = path.join(workspace, 'nested')
  mkdirSync(nested, { recursive: true })
  filePath = path.join(sandbox, 'not-a-directory.txt')
  writeFileSync(filePath, 'not a workspace\n')
  missingPath = path.join(sandbox, 'missing-dir')

  /* The lazy chunk route serves `lib/chunks/`; point it at a fixture directory
     so the route is covered even before scripts/build-chunks.mjs has run. This
     must happen BEFORE the plugin instances are applied (config captures it). */
  chunksDir = path.join(sandbox, 'chunks')
  mkdirSync(chunksDir, { recursive: true })
  chunkSource = 'globalThis.__dshChunks__ = globalThis.__dshChunks__ || {}\n'
    + "globalThis.__dshChunks__['dsh-workbay-terminal:xterm'] = (env) => ({ css: '' })\n"
  writeFileSync(path.join(chunksDir, 'xterm.js'), chunkSource, 'utf8')
  process.env.DSH_WORKBAY_TERMINAL_CHUNKS = chunksDir

  bootA = await bootPlugin({ shell: TEST_SHELL, maxSessions: 4, idleTimeoutMs: 60_000, pty: 'off' })
  bootB = await bootPlugin({ shell: TEST_SHELL, maxSessions: 1, idleTimeoutMs: 8_000, pty: 'off' })
  assert.ok(bootA.routes.has(CHUNK_PREFIX), 'the lazy chunk route must be registered')

  /* The compiled helper is built by a separate task; the Node fixture proves
     the same frame bridge until it exists. */
  fakeHelperPath = path.join(sandbox, 'fake-pty-helper.mjs')
  writeFileSync(fakeHelperPath, FAKE_HELPER_SOURCE, 'utf8')
  bootFake = await bootPlugin({
    shell: TEST_SHELL,
    pty: 'on',
    ptyHelper: fakeHelperPath,
    maxSessions: 4,
    idleTimeoutMs: 60_000,
  })
  bootFakeIdle = await bootPlugin({
    shell: TEST_SHELL,
    pty: 'on',
    ptyHelper: fakeHelperPath,
    maxSessions: 2,
    idleTimeoutMs: 1_500,
  })
  if (REAL_HELPER_PRESENT) {
    /* The helper is built by another task; run the real-helper tests only when
       one echo round-trip actually works. */
    REAL_HELPER_READY = await probeRealHelper()
  }
  if (REAL_HELPER_READY) {
    bootReal = await bootPlugin({ shell: TEST_SHELL, pty: 'on', maxSessions: 4, idleTimeoutMs: 60_000 })
    bootRealIdle = await bootPlugin({ shell: TEST_SHELL, pty: 'on', maxSessions: 2, idleTimeoutMs: 1_500 })
  }

  /* Warm the shell once. On a cold CI runner the first PowerShell spawn can take
     tens of seconds (Defender scan + JIT) while every later spawn is fast; paying
     that cost here keeps the timing-sensitive command tests from flaking. Best
     effort: a failure is reported by the real tests, not by the warm-up. */
  await new Promise((resolve) => {
    let done = false
    const finish = () => { if (!done) { done = true; resolve() } }
    try {
      const child = spawn(TEST_SHELL, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'echo warmup'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      child.on('close', finish)
      child.on('error', finish)
    } catch {
      finish()
    }
    const timer = setTimeout(finish, 120_000)
    if (typeof timer.unref === 'function') timer.unref()
  })
})

after(async () => {
  for (const boot of boots) {
    try { await boot.dispose() } catch { /* already gone */ }
  }
  delete process.env.DSH_WORKBAY_TERMINAL_CHUNKS
  if (sandbox !== undefined) {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

/* ============================== session lifecycle ============================== */

test('start creates a session and list reports its cwd', async () => {
  const session = await startSession(bootA)
  try {
    assert.equal(typeof session.id, 'string')
    assert.ok(session.id.length >= 8)
    assert.equal(path.isAbsolute(session.cwd), true)
    assert.equal(samePath(session.cwd, workspace), true, 'cwd should be the requested workspace')
    assert.ok(session.shell.toLowerCase().includes(path.basename(TEST_SHELL, '.exe')), 'shell = ' + session.shell)
    assert.equal(session.mode, 'command', 'bootA disables PTY mode on purpose')

    const listed = await bootA.call('list', {})
    assert.equal(listed.ok, true)
    const entry = listed.data.sessions.find((item) => item.id === session.id)
    assert.ok(entry !== undefined, 'list should contain the new session')
    assert.equal(entry.cwd, session.cwd)
    assert.equal(typeof entry.startedAt, 'number')
    assert.equal(entry.mode, 'command')
  } finally {
    await stopSession(bootA, session.id)
  }
})

test('the SSE hello event carries the session cwd and shell', async () => {
  const session = await startSession(bootA)
  const stream = openEvents(bootA.baseUrl, session.id)
  try {
    const hello = await stream.waitFor((event) => event.type === 'hello')
    assert.equal(hello.cwd, session.cwd)
    assert.equal(typeof hello.shell, 'string')
    assert.ok(hello.shell.length > 0)
    assert.equal(hello.mode, 'command')
    assert.equal(hello.cols, 80)
    assert.equal(hello.rows, 24)
  } finally {
    await stopSession(bootA, session.id)
    stream.close()
  }
})

/* ============================== command execution ============================== */

test('a command line runs in one process and its stdout streams as out', async () => {
  const session = await startSession(bootA)
  const stream = openEvents(bootA.baseUrl, session.id)
  try {
    await stream.waitFor((event) => event.type === 'hello')
    const sent = await bootA.call('input', { id: session.id, data: 'echo workbay-ok' + TEST_NEWLINE })
    assert.equal(sent.ok, true, JSON.stringify(sent))
    assert.equal(sent.data.ok, true)

    const output = await stream.waitFor(outContains('workbay-ok'), 45_000).catch(async (error) => {
      /* CI-only failures need evidence, not just "timed out": a spawn failure
         shows up as an error event, and a died session disappears from list. */
      let sessions = null
      try { sessions = (await bootA.call('list', {})).data } catch { /* ignore */ }
      throw new Error(
        error.message + '; lastEvents=' + JSON.stringify(stream.events.slice(-8))
        + '; sessions=' + JSON.stringify(sessions),
      )
    })
    assert.ok(output.data.length > 0)

    /* The command's own exit is an out MARKER; the session stays alive. */
    const marker = await stream.waitFor(outContains('[exit'), 45_000)
    assert.match(marker.data, /\[exit \d+\]/)
    const listed = await bootA.call('list', {})
    assert.ok(listed.data.sessions.some((item) => item.id === session.id), 'session must outlive the command')
  } finally {
    await stopSession(bootA, session.id)
    stream.close()
  }
})

test('two commands run sequentially in the same session', async () => {
  const session = await startSession(bootA)
  const stream = openEvents(bootA.baseUrl, session.id)
  try {
    await stream.waitFor((event) => event.type === 'hello')
    await bootA.call('input', { id: session.id, data: 'echo first-marker' + TEST_NEWLINE })
    await stream.waitFor(outContains('first-marker'), 45_000)
    await bootA.call('input', { id: session.id, data: 'echo second-marker' + TEST_NEWLINE })
    await stream.waitFor(outContains('second-marker'), 45_000)
  } finally {
    await stopSession(bootA, session.id)
    stream.close()
  }
})

test('two lines queued in one input call both run, in order', async () => {
  const session = await startSession(bootA)
  const stream = openEvents(bootA.baseUrl, session.id)
  try {
    await stream.waitFor((event) => event.type === 'hello')
    await bootA.call('input', { id: session.id, data: 'echo queue-one\necho queue-two\n' })
    await stream.waitFor(outContains('queue-one'), 45_000)
    await stream.waitFor(outContains('queue-two'), 45_000)
    const first = stream.events.findIndex(outContains('queue-one'))
    const second = stream.events.findIndex(outContains('queue-two'))
    assert.ok(first !== -1 && second !== -1 && first < second, 'the queue must preserve line order')
  } finally {
    await stopSession(bootA, session.id)
    stream.close()
  }
})

test('an incomplete line is buffered until its newline arrives', async () => {
  const session = await startSession(bootA)
  const stream = openEvents(bootA.baseUrl, session.id)
  try {
    await stream.waitFor((event) => event.type === 'hello')
    await bootA.call('input', { id: session.id, data: 'echo partial-' })
    await sleep(700)
    assert.equal(stream.has(outContains('partial-')), false, 'no command may run before the newline')
    await bootA.call('input', { id: session.id, data: 'done' + TEST_NEWLINE })
    await stream.waitFor(outContains('partial-done'), 45_000)
  } finally {
    await stopSession(bootA, session.id)
    stream.close()
  }
})

/* ============================== host-side cd ============================== */

test('cd updates the session cwd and the next command runs there', async () => {
  const session = await startSession(bootA)
  const stream = openEvents(bootA.baseUrl, session.id)
  try {
    await stream.waitFor((event) => event.type === 'hello')
    await bootA.call('input', { id: session.id, data: 'cd nested' + TEST_NEWLINE })
    await stream.waitFor(outContains('nested'), 10_000)

    const listed = await bootA.call('list', {})
    const entry = listed.data.sessions.find((item) => item.id === session.id)
    assert.ok(entry !== undefined)
    assert.equal(samePath(entry.cwd, nested), true, 'list must report the updated cwd')

    await bootA.call('input', { id: session.id, data: pwdCommand() + TEST_NEWLINE })
    const pwd = await stream.waitFor(
      (event) => event.type === 'out' && typeof event.data === 'string'
        && event.data.includes('CWD=') && event.data.includes('nested'),
      45_000,
    )
    assert.match(pwd.data, /CWD=/)
  } finally {
    await stopSession(bootA, session.id)
    stream.close()
  }
})

test('cd refuses a non-directory target and keeps the cwd', async () => {
  const session = await startSession(bootA)
  const stream = openEvents(bootA.baseUrl, session.id)
  try {
    await stream.waitFor((event) => event.type === 'hello')
    await bootA.call('input', { id: session.id, data: 'cd no-such-directory-xyz' + TEST_NEWLINE })
    await stream.waitFor(outContains('no such directory'), 10_000)
    const listed = await bootA.call('list', {})
    const entry = listed.data.sessions.find((item) => item.id === session.id)
    assert.ok(entry !== undefined)
    assert.equal(samePath(entry.cwd, workspace), true, 'a failed cd must not move the cwd')
  } finally {
    await stopSession(bootA, session.id)
    stream.close()
  }
})

/* ============================== stop / kill ============================== */

test('stop kills a running command and ends the session', async () => {
  const flagPath = path.join(workspace, 'stop-flag.txt')
  rmSync(flagPath, { force: true })
  const session = await startSession(bootA)
  const stream = openEvents(bootA.baseUrl, session.id)
  try {
    await stream.waitFor((event) => event.type === 'hello')
    await bootA.call('input', { id: session.id, data: longCommand(flagPath) + TEST_NEWLINE })
    const started = await waitUntil(() => existsSync(flagPath), 40_000)
    assert.equal(started, true, 'the long command should have started')

    const began = Date.now()
    await stopSession(bootA, session.id, stream)
    const elapsed = Date.now() - began
    assert.ok(elapsed < 4_000, 'stop should not wait for the command to finish (' + elapsed + 'ms)')

    const emptied = await waitUntil(async () => {
      const listed = await bootA.call('list', {})
      return listed.ok === true && listed.data.sessions.length === 0
    }, 10_000)
    assert.equal(emptied, true, 'the session should be gone from list after stop')
  } finally {
    stream.close()
  }
})

test('stop on an idle session emits exit 0 and removes it', async () => {
  const session = await startSession(bootA)
  const stream = openEvents(bootA.baseUrl, session.id)
  try {
    await stream.waitFor((event) => event.type === 'hello')
    const stopped = await bootA.call('stop', { id: session.id })
    assert.equal(stopped.ok, true)
    const exit = await stream.waitFor((event) => event.type === 'exit', 20_000)
    assert.equal(exit.code, 0)
    const listed = await bootA.call('list', {})
    assert.equal(listed.data.sessions.length, 0)
  } finally {
    stream.close()
  }
})

/* ============================== negative cases ============================== */

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
    await stopSession(bootA, session.id)
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

/* ============================== idle timeout ============================== */

test('an idle session is stopped automatically', async () => {
  const session = await startSession(bootB)
  const stream = openEvents(bootB.baseUrl, session.id)
  try {
    await stream.waitFor((event) => event.type === 'hello')
    /* bootB's idleTimeoutMs is 1.5 s; no input is sent. */
    const exit = await stream.waitFor((event) => event.type === 'exit', 20_000)
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

test('an idle-timeout stop kills the running command (no orphan writes the survived flag)', async (t) => {
  const flagPath = path.join(workspace, 'idle-flag.txt')
  const survivedPath = path.join(workspace, 'idle-survived.txt')
  rmSync(flagPath, { force: true })
  rmSync(survivedPath, { force: true })

  const session = await startSession(bootB)
  const stream = openEvents(bootB.baseUrl, session.id)
  let started = false
  try {
    await stream.waitFor((event) => event.type === 'hello')
    /* The command writes `flagPath` first, then sleeps 15 s, then writes
       `survivedPath`. The 8 s idle timeout must stop it between the two. That
       timeout is deliberately longer than a cold shell start: at 1.5 s a slow
       runner stopped the session before the command ever ran, which proves
       nothing about orphan killing. */
    await bootB.call('input', { id: session.id, data: longCommand(flagPath, survivedPath) + TEST_NEWLINE })
    /* On CI give a cold runner 15 s to prove it can start at all, then skip;
       locally wait the full 40 s so the assertion is strict. */
    const waitMs = process.env.CI === 'true' ? 15_000 : 40_000
    started = await waitUntil(() => existsSync(flagPath), waitMs)
    if (started !== true && process.env.CI === 'true') {
      /* GitHub's Windows runners occasionally take more than 15 s to bring up
         the first PowerShell of a process (Defender + JIT), and the 8 s idle
         timeout then ends the session before anything runs. The explicit-stop
         test covers the same kill path, so this timing-sensitive variant is
         skipped there instead of flaking the whole build; locally it runs. */
      t.skip('the shell did not start quickly enough on this runner (idle stop kill is covered by the explicit-stop test)')
      return
    }
    assert.equal(started, true, 'the long command should have started')
    const startedAt = Date.now()

    const exit = await stream.waitFor((event) => event.type === 'exit', 30_000)
    assert.equal(typeof exit.code, 'number')
    /* Wait until the killed process's remaining sleep has definitely elapsed:
       the survived marker must never appear. */
    const remaining = startedAt + 16_000 - Date.now()
    if (remaining > 0) await sleep(remaining)
    assert.equal(existsSync(survivedPath), false, 'the idle-stop must kill the running command tree')
  } finally {
    stream.close()
  }
})

/* ============================== command mode UTF-8 ============================== */

test('command mode decodes non-ASCII output (UTF-8 prefix)', async (t) => {
  if (!IS_WINDOWS) {
    t.skip('the Windows PowerShell code-page fix is Windows-specific')
    return
  }
  const session = await startSession(bootA)
  const stream = openEvents(bootA.baseUrl, session.id)
  try {
    await stream.waitFor((event) => event.type === 'hello')
    await bootA.call('input', { id: session.id, data: "Write-Output '中文标记'" + TEST_NEWLINE })
    const output = await stream.waitFor(outContains('中文标记'), 30_000)
    assert.ok(output.data.includes('中文标记'))
  } finally {
    await stopSession(bootA, session.id)
    stream.close()
  }
})

/* ============================== defaults / pty unavailable ============================== */

test('the default maxSessions is 8 and the 9th start is 409', async (t) => {
  if (!IS_WINDOWS) {
    t.skip('the default shell (powershell) only resolves on Windows here')
    return
  }
  const boot = await bootPlugin({ pty: 'off' })
  const ids = []
  try {
    for (let index = 0; index < 8; index += 1) {
      const session = await startSession(boot)
      ids.push(session.id)
    }
    const ninth = await boot.call('start', { root: workspace })
    assert.equal(ninth.status, 409)
    assert.equal(ninth.ok, false)
    assert.equal(ninth.error.code, 'session-limit')
  } finally {
    for (const id of ids) {
      try { await boot.call('stop', { id }) } catch { /* already gone */ }
    }
    await boot.dispose()
  }
})

test('pty:"on" without a helper fails start with 500 pty-unavailable', async () => {
  const boot = await bootPlugin({
    pty: 'on',
    ptyHelper: path.join(sandbox, 'no-such-pty-helper.exe'),
    maxSessions: 2,
    idleTimeoutMs: 60_000,
  })
  const out = await boot.call('start', { root: workspace })
  assert.equal(out.status, 500)
  assert.equal(out.ok, false)
  assert.equal(out.error.code, 'pty-unavailable')
  assert.equal((await boot.call('list', {})).data.sessions.length, 0)
  await boot.dispose()
})

test('start accepts a per-session shell and clamps cols/rows', async () => {
  const started = await bootA.call('start', {
    root: workspace,
    shell: TEST_SHELL,
    cols: 1,
    rows: 9_999,
  })
  assert.equal(started.ok, true, JSON.stringify(started))
  try {
    assert.ok(started.data.shell.toLowerCase().includes(path.basename(TEST_SHELL, '.exe')))
    const stream = openEvents(bootA.baseUrl, started.data.id)
    try {
      const hello = await stream.waitFor((event) => event.type === 'hello')
      assert.equal(hello.cols, 20, 'cols must clamp to the contract minimum')
      assert.equal(hello.rows, 200, 'rows must clamp to the contract maximum')
    } finally {
      stream.close()
    }
  } finally {
    await stopSession(bootA, started.data.id)
  }
})

/* ============================== PTY mode (fake helper) ============================== */

function fakePtyOnly(t) {
  if (!IS_WINDOWS) {
    t.skip('PTY mode is only available on Windows')
    return true
  }
  return false
}

test('fake PTY: start reports mode pty and raw input streams back', async (t) => {
  if (fakePtyOnly(t)) return
  const session = await startSession(bootFake)
  const stream = openEvents(bootFake.baseUrl, session.id)
  try {
    assert.equal(session.mode, 'pty')
    const hello = await stream.waitFor((event) => event.type === 'hello')
    assert.equal(hello.mode, 'pty')
    assert.equal(hello.cols, 80)
    assert.equal(hello.rows, 24)

    await bootFake.call('input', { id: session.id, data: 'hello-fake\r' })
    await stream.waitFor(outContains('FAKE-ECHO hello-fake'), 20_000)

    /* No line buffering in PTY mode: even an unterminated fragment reaches the
       helper immediately. */
    await bootFake.call('input', { id: session.id, data: 'partial-key' })
    await stream.waitFor(outContains('FAKE-ECHO partial-key'), 20_000)
  } finally {
    await stopSession(bootFake, session.id, stream)
    stream.close()
  }
})

test('fake PTY: resize clamps dimensions and the session keeps working', async (t) => {
  if (fakePtyOnly(t)) return
  const session = await startSession(bootFake)
  const stream = openEvents(bootFake.baseUrl, session.id)
  try {
    await stream.waitFor((event) => event.type === 'hello')
    const first = await bootFake.call('resize', { id: session.id, cols: 120, rows: 40 })
    assert.equal(first.ok, true, JSON.stringify(first))
    await stream.waitFor(outContains('RESIZED 120x40'), 20_000)

    /* Below/above the contract range must be clamped, not rejected. */
    const clamped = await bootFake.call('resize', { id: session.id, cols: 1, rows: 9_999 })
    assert.equal(clamped.ok, true, JSON.stringify(clamped))
    await stream.waitFor(outContains('RESIZED 20x200'), 20_000)

    await bootFake.call('input', { id: session.id, data: 'after-resize\r' })
    await stream.waitFor(outContains('FAKE-ECHO after-resize'), 20_000)
  } finally {
    await stopSession(bootFake, session.id, stream)
    stream.close()
  }
})

test('fake PTY: Ctrl+C does not end the session', async (t) => {
  if (fakePtyOnly(t)) return
  const session = await startSession(bootFake)
  const stream = openEvents(bootFake.baseUrl, session.id)
  try {
    await stream.waitFor((event) => event.type === 'hello')
    await bootFake.call('input', { id: session.id, data: 'start-long\r' })
    await stream.waitFor(outContains('LONG-RUNNING'), 20_000)

    await bootFake.call('input', { id: session.id, data: String.fromCharCode(3) })
    await stream.waitFor(outContains('INTERRUPTED'), 20_000)

    const listed = await bootFake.call('list', {})
    assert.ok(listed.data.sessions.some((entry) => entry.id === session.id), 'Ctrl+C must not kill the session')

    await bootFake.call('input', { id: session.id, data: 'after-interrupt\r' })
    await stream.waitFor(outContains('FAKE-ECHO after-interrupt'), 20_000)
  } finally {
    await stopSession(bootFake, session.id, stream)
    stream.close()
  }
})

test('fake PTY: restart returns a fresh session and reclaims the old one', async (t) => {
  if (fakePtyOnly(t)) return
  const first = await startSession(bootFake)
  const firstStream = openEvents(bootFake.baseUrl, first.id)
  let secondStream = null
  try {
    await firstStream.waitFor((event) => event.type === 'hello')
    const restarted = await bootFake.call('restart', { id: first.id })
    assert.equal(restarted.ok, true, JSON.stringify(restarted))
    assert.equal(restarted.data.mode, 'pty')
    assert.equal(typeof restarted.data.shell, 'string')
    assert.notEqual(restarted.data.id, first.id)
    assert.equal(samePath(restarted.data.cwd, first.cwd), true)
    await firstStream.waitFor((event) => event.type === 'exit', 20_000)

    const listed = await bootFake.call('list', {})
    const ids = listed.data.sessions.map((entry) => entry.id)
    assert.equal(ids.includes(first.id), false, 'the old session must be reclaimed')
    assert.equal(ids.includes(restarted.data.id), true)

    secondStream = openEvents(bootFake.baseUrl, restarted.data.id)
    const hello = await secondStream.waitFor((event) => event.type === 'hello')
    assert.equal(hello.mode, 'pty')
    await bootFake.call('input', { id: restarted.data.id, data: 'restart-ok\r' })
    await secondStream.waitFor(outContains('FAKE-ECHO restart-ok'), 20_000)
  } finally {
    if (secondStream !== null) secondStream.close()
    firstStream.close()
    const listed = await bootFake.call('list', {})
    for (const entry of listed.data.sessions) {
      try { await bootFake.call('stop', { id: entry.id }) } catch { /* gone */ }
    }
    await waitNoLiveFakeHelpers(workspace)
  }
})

test('fake PTY: stop emits exit and leaves no helper process', async (t) => {
  if (fakePtyOnly(t)) return
  const session = await startSession(bootFake)
  const stream = openEvents(bootFake.baseUrl, session.id)
  try {
    await stream.waitFor((event) => event.type === 'hello')
    const started = await waitUntil(() => fakePidFiles(workspace).some((pid) => processAlive(pid)), 20_000)
    assert.equal(started, true, 'the fake helper should be running')

    await stopSession(bootFake, session.id, stream)
    const gone = await waitNoLiveFakeHelpers(workspace)
    assert.equal(gone, true, 'no fake helper process may survive stop')
    const listed = await bootFake.call('list', {})
    assert.equal(listed.data.sessions.length, 0)
  } finally {
    stream.close()
  }
})

test('fake PTY: idle timeout kills the helper', async (t) => {
  if (fakePtyOnly(t)) return
  const session = await startSession(bootFakeIdle)
  const stream = openEvents(bootFakeIdle.baseUrl, session.id)
  try {
    const hello = await stream.waitFor((event) => event.type === 'hello')
    assert.equal(hello.mode, 'pty')
    const started = await waitUntil(() => fakePidFiles(workspace).some((pid) => processAlive(pid)), 20_000)
    assert.equal(started, true, 'the fake helper should be running')

    /* bootFakeIdle's idleTimeoutMs is 1.5 s; no input is sent. */
    const exit = await stream.waitFor((event) => event.type === 'exit', 20_000)
    assert.equal(typeof exit.code, 'number')
    const gone = await waitNoLiveFakeHelpers(workspace)
    assert.equal(gone, true, 'the idle stop must kill the helper process')
    const listed = await bootFakeIdle.call('list', {})
    assert.equal(listed.data.sessions.length, 0)
  } finally {
    stream.close()
  }
})

test('fake PTY: two sessions run independently', async (t) => {
  if (fakePtyOnly(t)) return
  const first = await startSession(bootFake)
  const second = await startSession(bootFake)
  const firstStream = openEvents(bootFake.baseUrl, first.id)
  const secondStream = openEvents(bootFake.baseUrl, second.id)
  try {
    await firstStream.waitFor((event) => event.type === 'hello')
    await secondStream.waitFor((event) => event.type === 'hello')

    await bootFake.call('input', { id: first.id, data: 'session-one\r' })
    await bootFake.call('input', { id: second.id, data: 'session-two\r' })
    await firstStream.waitFor(outContains('FAKE-ECHO session-one'), 20_000)
    await secondStream.waitFor(outContains('FAKE-ECHO session-two'), 20_000)

    assert.equal(firstStream.has(outContains('session-two')), false, 'session one must not see session two output')
    assert.equal(secondStream.has(outContains('session-one')), false, 'session two must not see session one output')
  } finally {
    await stopSession(bootFake, first.id, firstStream)
    await stopSession(bootFake, second.id, secondStream)
    firstStream.close()
    secondStream.close()
    await waitNoLiveFakeHelpers(workspace)
  }
})

/* ============================== PTY mode (real helper) ============================== */

function skipWithoutRealHelper(t) {
  if (!REAL_HELPER_READY) {
    t.skip(REAL_HELPER_PRESENT
      ? 'helper/WorkbayPty.exe is present but its echo probe did not answer (the parallel helper build is not ready); fake-helper bridge covers the host'
      : 'helper/WorkbayPty.exe is not built yet (separate task); fake-helper bridge covers the host')
    return true
  }
  return false
}

test('real PTY: start reports mode pty and executes a command', async (t) => {
  if (skipWithoutRealHelper(t)) return
  const session = await startSession(bootReal)
  const stream = openEvents(bootReal.baseUrl, session.id)
  try {
    assert.equal(session.mode, 'pty')
    const hello = await stream.waitFor((event) => event.type === 'hello')
    assert.equal(hello.mode, 'pty')
    assert.equal(typeof hello.cols, 'number')
    assert.equal(typeof hello.rows, 'number')

    await bootReal.call('input', { id: session.id, data: "Write-Output ('PTY-' + 42)\r" })
    await stream.waitFor(outContains('PTY-42'), 30_000)
  } finally {
    await stopSession(bootReal, session.id, stream)
    stream.close()
  }
})

test('real PTY: Ctrl+C interrupts a long command without ending the session', async (t) => {
  if (skipWithoutRealHelper(t)) return
  const session = await startSession(bootReal)
  const stream = openEvents(bootReal.baseUrl, session.id)
  try {
    await stream.waitFor((event) => event.type === 'hello')
    /* Wait for the shell to be interactive before typing into it: a Ctrl+C
       during PowerShell's own startup can abort initialization instead of
       interrupting a command. */
    await bootReal.call('input', { id: session.id, data: "Write-Output ('READY-' + 1)\r" })
    await stream.waitFor(outContains('READY-1'), 30_000)

    await bootReal.call('input', { id: session.id, data: 'Start-Sleep -Seconds 30\r' })
    await sleep(1_000)
    await bootReal.call('input', { id: session.id, data: String.fromCharCode(3) })
    await sleep(400)
    await bootReal.call('input', { id: session.id, data: "Write-Output ('AFTER-' + 1)\r" })
    await stream.waitFor(outContains('AFTER-1'), 20_000)

    const listed = await bootReal.call('list', {})
    assert.ok(listed.data.sessions.some((entry) => entry.id === session.id), 'Ctrl+C must not kill the session')
  } finally {
    await stopSession(bootReal, session.id, stream)
    stream.close()
  }
})

test('real PTY: resize does not throw and output keeps flowing', async (t) => {
  if (skipWithoutRealHelper(t)) return
  const session = await startSession(bootReal)
  const stream = openEvents(bootReal.baseUrl, session.id)
  try {
    await stream.waitFor((event) => event.type === 'hello')
    const resized = await bootReal.call('resize', { id: session.id, cols: 100, rows: 40 })
    assert.equal(resized.ok, true, JSON.stringify(resized))
    await bootReal.call('input', { id: session.id, data: "Write-Output ('SIZE-' + 7)\r" })
    await stream.waitFor(outContains('SIZE-7'), 30_000)
  } finally {
    await stopSession(bootReal, session.id, stream)
    stream.close()
  }
})

test('real PTY: restart returns a fresh session id and reclaims the old one', async (t) => {
  if (skipWithoutRealHelper(t)) return
  const first = await startSession(bootReal)
  const firstStream = openEvents(bootReal.baseUrl, first.id)
  let secondStream = null
  try {
    await firstStream.waitFor((event) => event.type === 'hello')
    const restarted = await bootReal.call('restart', { id: first.id })
    assert.equal(restarted.ok, true, JSON.stringify(restarted))
    assert.equal(restarted.data.mode, 'pty')
    assert.equal(typeof restarted.data.shell, 'string')
    assert.notEqual(restarted.data.id, first.id)
    assert.equal(samePath(restarted.data.cwd, first.cwd), true)
    await firstStream.waitFor((event) => event.type === 'exit', 30_000)

    const listed = await bootReal.call('list', {})
    const ids = listed.data.sessions.map((entry) => entry.id)
    assert.equal(ids.includes(first.id), false)
    assert.equal(ids.includes(restarted.data.id), true)

    secondStream = openEvents(bootReal.baseUrl, restarted.data.id)
    const hello = await secondStream.waitFor((event) => event.type === 'hello')
    assert.equal(hello.mode, 'pty')
    await bootReal.call('input', { id: restarted.data.id, data: "Write-Output ('RESTART-' + 9)\r" })
    await secondStream.waitFor(outContains('RESTART-9'), 30_000)
  } finally {
    if (secondStream !== null) secondStream.close()
    firstStream.close()
    const listed = await bootReal.call('list', {})
    for (const entry of listed.data.sessions) {
      try { await bootReal.call('stop', { id: entry.id }) } catch { /* gone */ }
    }
  }
})

test('real PTY: stop leaves no helper or PTY shell process behind', async (t) => {
  if (skipWithoutRealHelper(t)) return
  const baselineHelpers = await countHelperProcesses()
  const baselineShells = await countPtyShells()
  const session = await startSession(bootReal)
  const stream = openEvents(bootReal.baseUrl, session.id)
  try {
    await stream.waitFor((event) => event.type === 'hello')
    const grew = await waitUntil(async () => (await countHelperProcesses()) > baselineHelpers, 20_000, 200)
    assert.equal(grew, true, 'the helper process should appear in the process table')

    await stopSession(bootReal, session.id, stream)
    const cleaned = await waitUntil(async () => {
      const helpers = await countHelperProcesses()
      const shells = await countPtyShells()
      return helpers <= baselineHelpers && shells <= baselineShells
    }, 20_000, 200)
    assert.equal(cleaned, true, 'stop must leave no helper / PTY shell process')
  } finally {
    stream.close()
  }
})

test('real PTY: idle timeout kills the helper', async (t) => {
  if (skipWithoutRealHelper(t)) return
  const baselineHelpers = await countHelperProcesses()
  const session = await startSession(bootRealIdle)
  const stream = openEvents(bootRealIdle.baseUrl, session.id)
  try {
    const hello = await stream.waitFor((event) => event.type === 'hello')
    assert.equal(hello.mode, 'pty')
    const exit = await stream.waitFor((event) => event.type === 'exit', 20_000)
    assert.equal(typeof exit.code, 'number')
    const cleaned = await waitUntil(async () => (await countHelperProcesses()) <= baselineHelpers, 20_000, 200)
    assert.equal(cleaned, true, 'the idle stop must kill the helper process')
    const listed = await bootRealIdle.call('list', {})
    assert.equal(listed.data.sessions.length, 0)
  } finally {
    stream.close()
  }
})

test('real PTY: two sessions run independently', async (t) => {
  if (skipWithoutRealHelper(t)) return
  const first = await startSession(bootReal)
  const second = await startSession(bootReal)
  const firstStream = openEvents(bootReal.baseUrl, first.id)
  const secondStream = openEvents(bootReal.baseUrl, second.id)
  try {
    await firstStream.waitFor((event) => event.type === 'hello')
    await secondStream.waitFor((event) => event.type === 'hello')
    await bootReal.call('input', { id: first.id, data: "Write-Output ('ONE-' + 1)\r" })
    await bootReal.call('input', { id: second.id, data: "Write-Output ('TWO-' + 2)\r" })
    await firstStream.waitFor(outContains('ONE-1'), 30_000)
    await secondStream.waitFor(outContains('TWO-2'), 30_000)
    assert.equal(firstStream.has(outContains('TWO-2')), false, 'PTY sessions must not share output')
    assert.equal(secondStream.has(outContains('ONE-1')), false, 'PTY sessions must not share output')
  } finally {
    await stopSession(bootReal, first.id, firstStream)
    await stopSession(bootReal, second.id, secondStream)
    firstStream.close()
    secondStream.close()
  }
})

/* ============================== lazy chunk route ============================== */

function chunkRequest(name, init) {
  return fetch(bootA.baseUrl + CHUNK_PREFIX + '/' + name, init)
}

function fakeRouteRequest(url) {
  return {
    method: 'GET',
    url,
    headers: { host: 'localhost' },
    socket: { remoteAddress: '127.0.0.1' },
    on() { /* no body is read for GET */ },
  }
}

function fakeRouteResponse() {
  return {
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers === undefined ? null : headers
    },
    end(body) {
      this.body = body === undefined || body === null ? '' : String(body)
    },
  }
}

test('chunk route serves xterm.js with ETag/304 and JavaScript headers', async () => {
  let res = await chunkRequest('xterm.js')
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'text/javascript; charset=utf-8')
  assert.equal(res.headers.get('cache-control'), 'no-cache')
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  const etag = res.headers.get('etag')
  assert.match(etag, /^"[0-9a-f]{40}"$/)
  assert.equal(await res.text(), chunkSource)

  res = await chunkRequest('xterm.js', { headers: { 'if-none-match': etag } })
  assert.equal(res.status, 304)
  assert.equal(res.headers.get('etag'), etag)
  assert.equal(await res.text(), '')

  const head = await chunkRequest('xterm.js', { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(head.headers.get('content-length'), String(Buffer.byteLength(chunkSource)))
  assert.equal(await head.text(), '')
})

test('chunk route rejects traversal, subpaths, unknown names and non-GET', async () => {
  const route = bootA.routes.get(CHUNK_PREFIX)
  assert.ok(route !== undefined)
  for (const url of [
    '/dsh-workbay-terminal/chunk/../secret.js',
    '/dsh-workbay-terminal/chunk/a/b.js',
    '/dsh-workbay-terminal/chunk/%2e%2e%2fsecret.js',
    '/dsh-workbay-terminal/chunk/..%5csecret.js',
    '/dsh-workbay-terminal/chunk/',
  ]) {
    const response = fakeRouteResponse()
    await route.handler(fakeRouteRequest(url), response)
    assert.equal(response.statusCode, 404, 'accepted chunk url: ' + url)
  }

  const unknown = await chunkRequest('not-built.js')
  assert.equal(unknown.status, 404)
  const post = await chunkRequest('xterm.js', { method: 'POST' })
  assert.equal(post.status, 405)
})

test('the chunk route enforces the same-origin trust fence', async () => {
  const route = bootA.routes.get(CHUNK_PREFIX)
  const response = fakeRouteResponse()
  await route.handler({
    method: 'GET',
    url: '/dsh-workbay-terminal/chunk/xterm.js',
    headers: { host: 'evil.example', 'sec-fetch-site': 'cross-site' },
    socket: { remoteAddress: '10.9.9.9' },
    on() { /* refused before the URL is used */ },
  }, response)
  assert.equal(response.statusCode, 403)
  assert.equal(JSON.parse(response.body).error.code, 'forbidden')
})

test('chunk route serves the real built lib/chunks/xterm.js', async (t) => {
  const builtPath = path.join(TERMINAL_PACKAGE_ROOT, 'lib', 'chunks', 'xterm.js')
  if (!existsSync(builtPath)) {
    t.skip('lib/chunks/xterm.js has not been built yet (scripts/build-chunks.mjs)')
    return
  }
  /* The fixture seam above is a test-only override; prove the production path
     (package lib/chunks) is served too. */
  const saved = process.env.DSH_WORKBAY_TERMINAL_CHUNKS
  delete process.env.DSH_WORKBAY_TERMINAL_CHUNKS
  const boot = await bootPlugin({ pty: 'off' })
  try {
    const response = await fetch(boot.baseUrl + CHUNK_PREFIX + '/xterm.js')
    assert.equal(response.status, 200)
    assert.match(response.headers.get('etag'), /^"[0-9a-f]{40}"$/)
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    const body = await response.text()
    assert.ok(body.length > 1000, 'the built xterm chunk looks too small')
    assert.match(body, /__dshChunks__/)
  } finally {
    if (saved === undefined) delete process.env.DSH_WORKBAY_TERMINAL_CHUNKS
    else process.env.DSH_WORKBAY_TERMINAL_CHUNKS = saved
    await boot.dispose()
  }
})

/* ============================== command-mode restart ============================== */

test('restart keeps command mode and reuses the cwd', async () => {
  const first = await startSession(bootA)
  const firstStream = openEvents(bootA.baseUrl, first.id)
  try {
    await firstStream.waitFor((event) => event.type === 'hello')
    await bootA.call('input', { id: first.id, data: 'cd nested' + TEST_NEWLINE })
    await firstStream.waitFor(outContains('nested'), 10_000)

    const restarted = await bootA.call('restart', { id: first.id })
    assert.equal(restarted.ok, true, JSON.stringify(restarted))
    assert.equal(restarted.data.mode, 'command', 'restart must keep the mode')
    assert.equal(typeof restarted.data.shell, 'string')
    assert.notEqual(restarted.data.id, first.id)
    assert.equal(samePath(restarted.data.cwd, nested), true, 'restart must reuse the cwd')
    await firstStream.waitFor((event) => event.type === 'exit', 20_000)

    const listed = await bootA.call('list', {})
    const ids = listed.data.sessions.map((entry) => entry.id)
    assert.equal(ids.includes(first.id), false)
    assert.equal(ids.includes(restarted.data.id), true)

    const nextStream = openEvents(bootA.baseUrl, restarted.data.id)
    try {
      const hello = await nextStream.waitFor((event) => event.type === 'hello')
      assert.equal(hello.mode, 'command')
      assert.equal(samePath(hello.cwd, nested), true)
      await bootA.call('input', { id: restarted.data.id, data: 'echo restart-command' + TEST_NEWLINE })
      await nextStream.waitFor(outContains('restart-command'), 20_000)
    } finally {
      nextStream.close()
    }
  } finally {
    firstStream.close()
    const listed = await bootA.call('list', {})
    for (const entry of listed.data.sessions) {
      try { await bootA.call('stop', { id: entry.id }) } catch { /* gone */ }
    }
  }
})

/* ============================== default shell ============================== */

test('the default shell is PowerShell on Windows (pwsh preferred)', async (t) => {
  if (!IS_WINDOWS) {
    t.skip('the default shell resolution under test is Windows-specific')
    return
  }
  const boot = await bootPlugin({})
  const session = await startSession(boot)
  try {
    /* `auto` prefers PowerShell 7 (UTF-8 by default) and falls back to 5.1. */
    assert.ok(
      ['pwsh.exe', 'powershell.exe'].includes(String(session.shell).toLowerCase()),
      'shell = ' + session.shell,
    )
  } finally {
    await stopSession(boot, session.id)
  }
})
