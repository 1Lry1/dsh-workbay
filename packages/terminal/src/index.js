/**
 * dsh-workbay-terminal — host half (plain ESM JavaScript, no build step).
 *
 * There is no PTY in Node (no native ConPTY), so this bundle is a *persistent
 * command console*, not a full TTY: ONE long-lived shell process per session,
 * rooted at the workspace the client sent, with commands written to its stdin
 * as raw bytes and stdout/stderr streamed back over SSE. The contract lives in
 * docs/files-api.md §4/§5/§6.
 *
 *   POST /dsh-workbay-terminal/api/start   { root }        -> { id, shell, cwd }
 *   POST /dsh-workbay-terminal/api/input   { id, data }    -> { ok: true }
 *   POST /dsh-workbay-terminal/api/stop    { id }          -> { ok: true }
 *   POST /dsh-workbay-terminal/api/list    {}              -> { sessions: [...] }
 *   GET  /dsh-workbay-terminal/events?id=  (SSE)           -> hello / out / exit / error
 *
 * Design decisions worth knowing before editing this file:
 *
 *   - NO shell-string building, ever. `start` only ever spawns a fixed argv
 *     array (config `shell` + a fixed argument vector chosen by shell family);
 *     every byte the user types afterwards arrives via `input` and goes
 *     straight to the child's stdin. There is no place where user text can
 *     become part of a command line.
 *   - The JSON RPC surface (trust fence, bounded body, `{ ok, data }` envelope,
 *     404/405 mapping) is `@dsh-workbay/kit`'s `mountJsonApi`; only the SSE
 *     route is implemented here, because a stream is not a JSON method.
 *   - Output is streamed, never persisted. A session's only buffer is one
 *     `StringDecoder` per pipe (to keep UTF-8 sequences intact); once the
 *     process closes, nothing about its output survives.
 *   - Explicit limits: at most `maxSessions` (default 4), auto-stop after
 *     `idleTimeoutMs` without input (default 30 min), and `apply`'s dispose
 *     kills every session it ever started.
 *   - Command text is never written to a log. This module logs nothing at all.
 *
 * Trust posture: routes are mounted on DSH's own web server and guarded by the
 * kit's same-origin fence (loopback peer / loopback Host / Sec-Fetch-Site), so
 * a random web page cannot open a shell on the machine.
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'

import { ApiError, isTrustedRequest, mountJsonApi, sendJson } from '@dsh-workbay/kit'

export const name = 'dsh-workbay-terminal'
export const inject = ['webServer']

const ROUTE_PREFIX = '/dsh-workbay-terminal/api'
const EVENTS_ROUTE = '/dsh-workbay-terminal/events'

/** Contract defaults — docs/files-api.md §4 and §5. */
const DEFAULTS = {
  shell: 'powershell',
  maxSessions: 4,
  idleTimeoutMs: 30 * 60 * 1000,
}

const MAX_BODY_BYTES = 64 * 1024
const MAX_SESSIONS = 32
const MAX_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000
/** SSE `out` events carry at most this many characters (the contract's 4 KiB). */
const MAX_OUTPUT_CHUNK = 4096
const HEARTBEAT_MS = 20_000
/** Give a killed process this long before trying a harder kill. */
const KILL_FALLBACK_MS = 3_000
/** Last-resort synthetic exit if even the hard kill never reports `close`. */
const FORCE_EXIT_MS = 4_500
const SPAWN_TIMEOUT_MS = 15_000

/**
 * Environment handed to the shell.
 *
 * A user shell is not the plugin host: it should not inherit every credential
 * or temporary variable DSH itself was started with. Only the variables a
 * shell (and the tools it runs) genuinely needs to function are copied through.
 */
const SHELL_ENV_KEYS = [
  'PATH', 'Path', 'PATHEXT', 'SHELL',
  'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'windir', 'COMSPEC', 'ComSpec',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'ProgramData',
  'PROGRAMFILES', 'ProgramFiles', 'PROGRAMFILES(X86)', 'ProgramFiles(x86)',
  'PROGRAMW6432', 'ProgramW6432',
  'TEMP', 'TMP', 'TMPDIR',
  'USERNAME', 'USERDOMAIN', 'COMPUTERNAME',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
]

/* ============================== errors ============================== */

function badRequest(message) {
  return new ApiError('bad-request', message, 400)
}

function notFound(message) {
  return new ApiError('not-found', message, 404)
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/* ============================== config ============================== */

function clampInt(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}

function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const shell = typeof source.shell === 'string' && source.shell.trim() !== ''
    ? source.shell.trim()
    : DEFAULTS.shell
  return {
    shell,
    maxSessions: clampInt(source.maxSessions, DEFAULTS.maxSessions, 1, MAX_SESSIONS),
    /* 0 disables the idle stop, which is useful for a deliberately long-lived
       session; the contract default is 30 minutes. */
    idleTimeoutMs: clampInt(source.idleTimeoutMs, DEFAULTS.idleTimeoutMs, 0, MAX_IDLE_TIMEOUT_MS),
  }
}

/* ============================== shell profiles ============================== */

/**
 * The fixed argument vector for a shell family. Nothing here is derived from
 * request data.
 *
 * PowerShell gets an explicit read-eval loop, passed with `-EncodedCommand`
 * (base64 of the script) rather than `-Command <multiline>`: the latter depends
 * on how the host quotes a multi-line argv and on `[Console]::In` seeing
 * redirected stdin — a piped stdin on a CI runner did not execute at all there
 * while the same code worked on a developer box. Reading `OpenStandardInput()`
 * through a StreamReader is the documented way to consume a redirected pipe.
 * `-NonInteractive` keeps it from prompting, and `OutputEncoding` pins stdout to
 * UTF-8, which is what the SSE decoder expects (Windows PowerShell 5.1 otherwise
 * emits the OEM code page).
 */
const POWERSHELL_REPL = [
  '$ErrorActionPreference = "Continue"',
  '$ProgressPreference = "SilentlyContinue"',
  'try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}',
  '$reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)',
  'while ($true) {',
  '  $line = $reader.ReadLine()',
  '  if ($null -eq $line) { break }',
  '  try { Invoke-Expression $line } catch { Write-Error $_ }',
  '  [Console]::Out.Flush()',
  '}',
].join('\n')

const POWERSHELL_ENCODED = Buffer.from(POWERSHELL_REPL, 'utf16le').toString('base64')
const POWERSHELL_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', POWERSHELL_ENCODED]
const POSIX_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish'])

function resolveShell(configured) {
  if (/[\u0000\r\n]/.test(configured)) {
    throw new ApiError('config-invalid', 'the shell config contains control characters', 500)
  }
  const absolute = path.isAbsolute(configured)
  const base = path.basename(configured).toLowerCase().replace(/\.exe$/, '')
  const isPowershell = base === 'powershell' || base === 'pwsh'
  let binary = configured
  if (!absolute) {
    if (process.platform === 'win32') {
      if (base === 'powershell') binary = 'powershell.exe'
      else if (base === 'pwsh') binary = 'pwsh.exe'
      else if (base === 'cmd') binary = 'cmd.exe'
    } else if (isPowershell) {
      /* `powershell` on a POSIX host means the cross-platform PowerShell. */
      binary = 'pwsh'
    }
  }
  let args = []
  if (isPowershell) args = POWERSHELL_ARGS
  else if (POSIX_SHELLS.has(base)) args = []
  return { binary, args, display: path.basename(binary), family: isPowershell ? 'powershell' : 'generic' }
}

function shellEnv() {
  const env = {}
  for (const key of SHELL_ENV_KEYS) {
    const value = process.env[key]
    if (typeof value === 'string') env[key] = value
  }
  return env
}

/* ============================== root validation ============================== */

function canonicalPath(value) {
  const native = typeof realpathSync.native === 'function' ? realpathSync.native : realpathSync
  try {
    return native(value)
  } catch {
    return path.resolve(value)
  }
}

/**
 * Validate the workspace root: absolute, existing, a directory. Root
 * *confinement* is the caller's responsibility (the same absolute path is used
 * as cwd), but a non-directory is always refused — a file cannot be a shell
 * working directory.
 */
function requireRoot(value) {
  if (typeof value !== 'string' || value.trim() === '') throw badRequest('root is required')
  const requested = value.trim()
  if (!path.isAbsolute(requested)) throw badRequest('root must be an absolute path')
  let stats
  try {
    stats = statSync(requested)
  } catch {
    throw badRequest('root does not exist')
  }
  if (!stats.isDirectory()) throw badRequest('root must be a directory')
  return canonicalPath(requested)
}

/* ============================== service ============================== */

function createService(settings) {
  /** Live sessions only: an entry is deleted the moment its process closes. */
  const sessions = new Map()
  /** Starts in flight, so two concurrent requests cannot exceed maxSessions. */
  let pendingStarts = 0
  let disposed = false

  /* ---------------------------------------------------------------- SSE ---- */

  function writeEvent(session, payload) {
    const line = 'data: ' + JSON.stringify(payload) + '\n\n'
    for (const client of [...session.clients]) {
      try {
        client.res.write(line)
      } catch {
        dropClient(session, client)
      }
    }
  }

  function dropClient(session, client) {
    if (client.timer !== null) {
      clearInterval(client.timer)
      client.timer = null
    }
    session.clients.delete(client)
  }

  function emitOutput(session, text) {
    if (typeof text !== 'string' || text === '') return
    for (let at = 0; at < text.length; at += MAX_OUTPUT_CHUNK) {
      let end = Math.min(at + MAX_OUTPUT_CHUNK, text.length)
      /* Never split a surrogate pair across two events. */
      if (end < text.length) {
        const code = text.charCodeAt(end - 1)
        if (code >= 0xd800 && code <= 0xdbff) end += 1
      }
      writeEvent(session, { type: 'out', data: text.slice(at, end) })
    }
  }

  /* ------------------------------------------------------------- session ---- */

  function finishSession(session, code) {
    if (session.exited) return
    session.exited = true
    if (session.idleTimer !== null) {
      clearTimeout(session.idleTimer)
      session.idleTimer = null
    }
    if (session.killTimer !== null) {
      clearTimeout(session.killTimer)
      session.killTimer = null
    }
    if (session.forceTimer !== null) {
      clearTimeout(session.forceTimer)
      session.forceTimer = null
    }
    writeEvent(session, { type: 'exit', code })
    for (const client of [...session.clients]) {
      dropClient(session, client)
      try { client.res.end() } catch { /* already gone */ }
    }
    sessions.delete(session.id)
    const waiters = session.exitWaiters.splice(0)
    for (const resolve of waiters) resolve()
  }

  function forceKill(session) {
    if (session.exited) return
    try {
      if (session.child.exitCode === null && session.child.signalCode === null) {
        session.child.kill('SIGKILL')
      }
    } catch {
      /* the process is already gone */
    }
  }

  /** Kill the whole process tree, then make sure a synthetic exit is emitted. */
  function requestKill(session) {
    if (session.killRequested || session.exited) return
    session.killRequested = true
    session.stopping = true
    const pid = session.child.pid
    if (process.platform === 'win32' && Number.isInteger(pid)) {
      /* argv array, numeric pid — no shell, no string interpolation. `taskkill
         /T` is what reaches grandchildren a shell command may have spawned. */
      try {
        const killer = spawn('taskkill', ['/T', '/F', '/PID', String(pid)], {
          windowsHide: true,
          stdio: 'ignore',
        })
        killer.on('error', () => { forceKill(session) })
      } catch {
        forceKill(session)
      }
    } else {
      try { session.child.kill('SIGTERM') } catch { /* gone */ }
    }
    session.killTimer = setTimeout(() => forceKill(session), KILL_FALLBACK_MS)
    session.forceTimer = setTimeout(() => finishSession(session, -1), FORCE_EXIT_MS)
    if (typeof session.killTimer.unref === 'function') session.killTimer.unref()
    if (typeof session.forceTimer.unref === 'function') session.forceTimer.unref()
  }

  function stopSession(session) {
    if (session.exited) return Promise.resolve()
    const finished = new Promise((resolve) => { session.exitWaiters.push(resolve) })
    requestKill(session)
    return finished
  }

  function armIdle(session) {
    if (session.idleTimer !== null) {
      clearTimeout(session.idleTimer)
      session.idleTimer = null
    }
    if (settings.idleTimeoutMs <= 0) return
    session.idleTimer = setTimeout(() => {
      session.idleTimer = null
      requestKill(session)
    }, settings.idleTimeoutMs)
    if (typeof session.idleTimer.unref === 'function') session.idleTimer.unref()
  }

  function sessionOf(id) {
    if (typeof id !== 'string' || id === '') throw badRequest('id is required')
    const session = sessions.get(id)
    if (session === undefined) throw notFound('unknown session')
    return session
  }

  function spawnShell(profile, cwd) {
    return new Promise((resolve, reject) => {
      let child
      try {
        child = spawn(profile.binary, profile.args, {
          cwd,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: shellEnv(),
        })
      } catch (error) {
        reject(new ApiError('shell-missing', 'cannot start shell "' + profile.display + '": ' + messageOf(error), 500))
        return
      }
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try { child.kill('SIGKILL') } catch { /* gone */ }
        reject(new ApiError('shell-missing', 'shell "' + profile.display + '" did not start in time', 500))
      }, SPAWN_TIMEOUT_MS)
      if (typeof timer.unref === 'function') timer.unref()
      const settle = (fn, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.off('spawn', onSpawn)
        child.off('error', onError)
        fn(value)
      }
      const onSpawn = () => { settle(resolve, child) }
      const onError = (error) => {
        settle(reject, new ApiError(
          'shell-missing',
          'cannot start shell "' + profile.display + '": ' + messageOf(error),
          500,
        ))
      }
      /* Attached before any await: a shell that dies immediately must not turn
         an EPIPE on stdin into an uncaught exception. wireSession attaches the
         real handlers once the session object exists. */
      child.stdin.on('error', () => { /* handled by the close event */ })
      child.once('spawn', onSpawn)
      child.once('error', onError)
    })
  }

  function wireSession(session) {
    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')
    const child = session.child

    child.stdout.on('data', (chunk) => { emitOutput(session, stdoutDecoder.write(chunk)) })
    child.stderr.on('data', (chunk) => { emitOutput(session, stderrDecoder.write(chunk)) })
    /* Streams can emit a late error while the process is being killed; without
       a listener that becomes an uncaught exception in the host process. */
    child.stdout.on('error', () => { /* the close handler cleans up */ })
    child.stderr.on('error', () => { /* the close handler cleans up */ })
    child.stdin.on('error', () => { /* EPIPE when the shell exits mid-write */ })

    child.on('error', (error) => {
      writeEvent(session, { type: 'error', message: messageOf(error) })
      finishSession(session, -1)
    })

    child.on('close', (code, signal) => {
      const outTail = stdoutDecoder.end()
      if (outTail !== '') emitOutput(session, outTail)
      const errTail = stderrDecoder.end()
      if (errTail !== '') emitOutput(session, errTail)
      finishSession(session, code === null ? (signal === null ? -1 : -1) : code)
    })
  }

  /* ------------------------------------------------------------- methods --- */

  async function start(payload) {
    if (disposed) throw new ApiError('disposed', 'the plugin is shutting down', 503)
    const root = requireRoot(payload.root)
    if (sessions.size + pendingStarts >= settings.maxSessions) {
      throw new ApiError(
        'session-limit',
        'at most ' + String(settings.maxSessions) + ' terminal session(s) may run at once',
        409,
      )
    }
    const profile = resolveShell(settings.shell)
    pendingStarts += 1
    let child
    try {
      child = await spawnShell(profile, root)
    } finally {
      pendingStarts -= 1
    }
    const session = {
      id: randomUUID(),
      shell: profile.display,
      cwd: root,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      child,
      clients: new Set(),
      exitWaiters: [],
      exited: false,
      stopping: false,
      killRequested: false,
      idleTimer: null,
      killTimer: null,
      forceTimer: null,
    }
    sessions.set(session.id, session)
    wireSession(session)
    armIdle(session)
    return { id: session.id, shell: session.shell, cwd: session.cwd }
  }

  async function input(payload) {
    const session = sessionOf(payload.id)
    if (typeof payload.data !== 'string') throw badRequest('data must be a string')
    if (session.exited || session.stopping) throw notFound('unknown session')
    if (payload.data !== '') {
      if (!session.child.stdin.writable) throw new ApiError('session-closed', 'the shell stdin is closed', 409)
      try {
        session.child.stdin.write(payload.data, 'utf8')
      } catch (error) {
        throw new ApiError('session-closed', messageOf(error), 409)
      }
    }
    session.lastActivityAt = Date.now()
    armIdle(session)
    return { ok: true }
  }

  async function stop(payload) {
    const session = sessionOf(payload.id)
    await stopSession(session)
    return { ok: true }
  }

  async function list() {
    /* Exactly the contract's shape (docs/files-api.md §4) — the client needs
       nothing else, and a frozen contract is not a place for extra fields. */
    const entries = [...sessions.values()]
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((session) => ({ id: session.id, cwd: session.cwd, startedAt: session.startedAt }))
    return { sessions: entries }
  }

  /* ----------------------------------------------------------- SSE route --- */

  async function handleEvents(req, res) {
    if (!isTrustedRequest(req)) {
      sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
      return
    }
    if (req.method !== 'GET') {
      sendJson(res, 405, { ok: false, error: { code: 'method-error', message: 'GET required' } })
      return
    }
    let id = ''
    try {
      id = new URL(req.url === undefined ? '/' : req.url, 'http://dsh.internal').searchParams.get('id') ?? ''
    } catch {
      sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'malformed request url' } })
      return
    }
    if (id === '') {
      sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'id is required' } })
      return
    }
    const session = sessions.get(id)
    if (session === undefined) {
      sendJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown session' } })
      return
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write('data: ' + JSON.stringify({
      type: 'hello',
      id: session.id,
      shell: session.shell,
      cwd: session.cwd,
    }) + '\n\n')

    const client = {
      res,
      timer: setInterval(() => {
        try {
          res.write(': ping\n\n')
        } catch {
          dropClient(session, client)
        }
      }, HEARTBEAT_MS),
    }
    if (typeof client.timer.unref === 'function') client.timer.unref()
    session.clients.add(client)

    const cleanup = () => { dropClient(session, client) }
    req.on('close', cleanup)
    res.on('close', cleanup)
  }

  /* ------------------------------------------------------------- dispose --- */

  async function dispose() {
    if (disposed) return
    disposed = true
    const live = [...sessions.values()]
    await Promise.all(live.map((session) => stopSession(session).catch(() => undefined)))
  }

  return {
    methods: { start, input, stop, list },
    handleEvents,
    dispose,
  }
}

/* ============================== plugin ============================== */

/**
 * Apply the plugin. cordis passes the row config as the SECOND argument (the
 * same convention as dsh-gitcraft); the defaults are exactly the contract's.
 */
export function apply(ctx, config) {
  const settings = normalizeConfig(config === undefined || config === null ? {} : config)
  const service = createService(settings)

  mountJsonApi(ctx, {
    prefix: ROUTE_PREFIX,
    methods: service.methods,
    maxBodyBytes: MAX_BODY_BYTES,
    label: name,
  })

  /* The SSE stream is not a JSON RPC method: it is registered on its own
     prefix, behind the same kit trust fence (checked in `handleEvents`). */
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: EVENTS_ROUTE, handler: service.handleEvents }),
    name + ': events stream',
  )

  /* Never leave a shell behind when the plugin (or the host) goes away. The
     cleanup starts every kill synchronously, and awaiting it is harmless. */
  ctx.effect(() => () => service.dispose(), name + ': terminal sessions')
}
