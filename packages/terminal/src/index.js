/**
 * dsh-workbay-terminal — host half (plain ESM JavaScript, no build step).
 *
 * There is no PTY in Node (no native ConPTY), so this bundle is a *persistent
 * command console*, not a full TTY. The session is persistent; the PROCESS is
 * not: each complete command line is executed as one short-lived child process
 * (`start` only records the session), stdout/stderr stream back over SSE, and
 * the working directory is maintained HOST-SIDE so it survives between
 * commands. See docs/files-api.md §4/§5/§6.
 *
 * Why per-command instead of one long-lived shell reading stdin? A persistent
 * `powershell -Command -` consumed piped stdin locally but not on every host
 * (the CI Windows runner never produced output for a line written to stdin),
 * and there is no PTY to fall back to. Spawning one process per line removes
 * that dependency: the command is an argv element, so it cannot be lost by a
 * host whose shell refuses to read a redirected stdin.
 *
 *   POST /dsh-workbay-terminal/api/start   { root }        -> { id, shell, cwd }
 *   POST /dsh-workbay-terminal/api/input   { id, data }    -> { ok: true }
 *   POST /dsh-workbay-terminal/api/stop    { id }          -> { ok: true }
 *   POST /dsh-workbay-terminal/api/list    {}              -> { sessions: [...] }
 *   GET  /dsh-workbay-terminal/events?id=  (SSE)           -> hello / out / exit / error
 *
 * Model:
 *   - `input` appends to a per-session line buffer, splits on `\r?\n`, and runs
 *     each complete line as ONE child process, one at a time per session. More
 *     lines queue behind the running one.
 *   - A line that is exactly `cd [target]` is handled by the HOST (resolve
 *     against the session cwd, require an existing directory, update the cwd,
 *     emit it as `out`) and never spawns anything, which is what makes `cd`
 *     persist.
 *   - A finished command emits an `out` marker `\r\n[exit N]\r\n` and keeps the
 *     session alive; `exit` stays a SESSION-level event, emitted only by `stop`
 *     (or dispose / idle timeout).
 *
 * Security and hygiene:
 *   - NO shell-string building. The command line is one argv element of a fixed
 *     argv vector; `cd` is host-side path arithmetic, never a shell builtin.
 *   - The JSON RPC surface (trust fence, bounded body, envelope, 404/405) is
 *     `@dsh-workbay/kit`'s `mountJsonApi`; only the SSE route is implemented
 *     here, because a stream is not a JSON method.
 *   - Nothing is persisted and nothing about a command is logged. Output lives
 *     only in the SSE subscriber sockets and in two `StringDecoder`s per running
 *     command (to keep UTF-8 sequences intact).
 *   - Limits: at most `maxSessions` (default 4), auto-stop after
 *     `idleTimeoutMs` without input (default 30 min), and `apply`'s dispose kills
 *     every running command and clears every session/queue.
 *
 * Trust posture: routes are mounted on DSH's own web server and guarded by the
 * kit's same-origin fence (loopback peer / loopback Host / Sec-Fetch-Site), so
 * a random web page cannot run commands on the machine.
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
/** A command line larger than this is dropped with an error, not buffered forever. */
const MAX_LINE_CHARS = 64 * 1024
const HEARTBEAT_MS = 20_000
/** Give a killed process this long before trying a harder kill. */
const KILL_FALLBACK_MS = 3_000
/** Last-resort synthetic exit if even the hard kill never reports `close`. */
const FORCE_EXIT_MS = 4_500

/**
 * Environment handed to each command process.
 *
 * A user shell is not the plugin host: it should not inherit every credential
 * or temporary variable DSH itself was started with. Only the variables a shell
 * (and the tools it runs) genuinely needs to function are copied through. They
 * are re-applied for EVERY command, so environment changes made by one command
 * do not survive to the next (documented in README).
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

function shellMissing(detail) {
  return new ApiError('shell-missing', detail, 500)
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

/* ============================== shell discovery ============================== */

const POSIX_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish'])

/** Base name -> argument family; the argv vectors are fixed per family. */
function shellFamilyOf(base) {
  if (base === 'powershell' || base === 'pwsh') return 'powershell'
  if (base === 'cmd') return 'cmd'
  if (POSIX_SHELLS.has(base)) return 'posix'
  /* An unrecognised shell is assumed to accept `-c`, which is the POSIX
     convention and the least surprising default for a bare command. */
  return 'posix'
}

/**
 * The ONE command-invocation vector used for a family. The user's line is
 * always exactly one argv element — never concatenated into a string.
 */
function commandArgv(family, line) {
  if (family === 'powershell') return ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', line]
  if (family === 'cmd') return ['/D', '/Q', '/C', line]
  return ['-c', line]
}

function canonicalPath(value) {
  const native = typeof realpathSync.native === 'function' ? realpathSync.native : realpathSync
  try {
    return native(value)
  } catch {
    return path.resolve(value)
  }
}

function pathExtensions() {
  if (process.platform !== 'win32') return ['']
  const raw = process.env.PATHEXT
  const extensions = typeof raw === 'string' && raw.trim() !== ''
    ? raw.split(';')
    : ['.COM', '.EXE', '.BAT', '.CMD']
  return ['', ...extensions.map((entry) => entry.trim()).filter((entry) => entry !== '')]
}

/** Resolve a bare executable name through PATH/PATHEXT, with no shell involved. */
function findOnPath(name) {
  const pathValue = process.env.PATH ?? process.env.Path ?? ''
  const directories = String(pathValue).split(path.delimiter).filter((entry) => entry !== '')
  const extensions = path.extname(name) === '' ? pathExtensions() : ['']
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, name + extension)
      try {
        if (statSync(candidate).isFile()) return canonicalPath(candidate)
      } catch {
        /* keep looking */
      }
    }
  }
  return null
}

/** A bare `powershell` means the platform's PowerShell executable. */
function binaryNameFor(bare, configured) {
  if (process.platform === 'win32') {
    if (bare === 'powershell') return 'powershell.exe'
    if (bare === 'pwsh') return 'pwsh.exe'
    if (bare === 'cmd') return 'cmd.exe'
    return configured
  }
  if (bare === 'powershell' || bare === 'pwsh') return 'pwsh'
  return configured
}

/**
 * Resolve the configured shell to an absolute executable path.
 *
 * An absolute config must exist; a bare name is resolved through the
 * allow-listed PATH/PATHEXT. There is deliberately NO spawn probe: `start` must
 * not launch anything (a broken shell is reported here as a 500, not later as
 * an empty output stream).
 */
function resolveShell(configured) {
  if (/[\u0000\r\n]/.test(configured)) {
    throw shellMissing('the shell config contains control characters')
  }
  if (path.isAbsolute(configured)) {
    let stats
    try {
      stats = statSync(configured)
    } catch {
      throw shellMissing('shell "' + configured + '" does not exist')
    }
    if (!stats.isFile()) throw shellMissing('shell "' + configured + '" is not a file')
    const base = path.basename(configured).toLowerCase().replace(/\.exe$/, '')
    return {
      binary: canonicalPath(configured),
      display: path.basename(configured),
      family: shellFamilyOf(base),
    }
  }
  const bare = path.basename(configured).toLowerCase().replace(/\.exe$/, '')
  const name = binaryNameFor(bare, configured)
  const found = findOnPath(name)
  if (found === null) throw shellMissing('cannot find shell "' + configured + '" on PATH')
  return {
    binary: found,
    display: path.basename(found),
    family: shellFamilyOf(bare),
  }
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

/**
 * Validate the workspace root: absolute, existing, a directory. Root
 * *confinement* is the caller's responsibility (the same absolute path is used
 * as the command cwd), but a non-directory is always refused.
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
  /** Live sessions only: an entry is deleted the moment `stop` finishes it. */
  const sessions = new Map()
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

  function clearTimers(session) {
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
  }

  /** Emit the SESSION-level exit, end subscribers, forget the session. */
  function finishSession(session, code) {
    if (session.exited) return
    session.exited = true
    clearTimers(session)
    session.lineBuffer = ''
    session.queue.length = 0
    writeEvent(session, { type: 'exit', code })
    for (const client of [...session.clients]) {
      dropClient(session, client)
      try { client.res.end() } catch { /* already gone */ }
    }
    sessions.delete(session.id)
    const waiters = session.exitWaiters.splice(0)
    for (const resolve of waiters) resolve()
  }

  function forceKillChild(child) {
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    } catch {
      /* the process is already gone */
    }
  }

  /** Kill a command's whole process tree (argv array, numeric pid, no shell). */
  function killChildTree(child) {
    const pid = child.pid
    if (process.platform === 'win32' && Number.isInteger(pid)) {
      try {
        const killer = spawn('taskkill', ['/T', '/F', '/PID', String(pid)], {
          windowsHide: true,
          stdio: 'ignore',
        })
        killer.on('error', () => { forceKillChild(child) })
      } catch {
        forceKillChild(child)
      }
    } else {
      try { child.kill('SIGTERM') } catch { /* gone */ }
    }
  }

  function stopSession(session) {
    if (session.exited) return Promise.resolve()
    if (session.stopRequested) {
      return new Promise((resolve) => { session.exitWaiters.push(resolve) })
    }
    session.stopRequested = true
    /* A half-typed command and every queued line are DROPPED: `stop` ends the
       session, so replaying them in a later session would be surprising. */
    session.lineBuffer = ''
    session.queue.length = 0
    const child = session.running
    if (child === null) {
      finishSession(session, 0)
      return Promise.resolve()
    }
    const finished = new Promise((resolve) => { session.exitWaiters.push(resolve) })
    killChildTree(child)
    session.killTimer = setTimeout(() => forceKillChild(child), KILL_FALLBACK_MS)
    session.forceTimer = setTimeout(() => finishSession(session, -1), FORCE_EXIT_MS)
    if (typeof session.killTimer.unref === 'function') session.killTimer.unref()
    if (typeof session.forceTimer.unref === 'function') session.forceTimer.unref()
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
      void stopSession(session)
    }, settings.idleTimeoutMs)
    if (typeof session.idleTimer.unref === 'function') session.idleTimer.unref()
  }

  function sessionOf(id) {
    if (typeof id !== 'string' || id === '') throw badRequest('id is required')
    const session = sessions.get(id)
    if (session === undefined) throw notFound('unknown session')
    return session
  }

  /* ------------------------------------------------------------ commands --- */

  const CD_PATTERN = /^\s*cd(?:\s+(.*))?\s*$/i

  function stripQuotes(value) {
    if (value.length >= 2) {
      const first = value[0]
      const last = value[value.length - 1]
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) return value.slice(1, -1)
    }
    return value
  }

  /**
   * Host-side `cd`: the ONLY builtin the console understands. Returns true when
   * the line was consumed (valid or not) and false when it is a normal command.
   */
  function handleCd(session, line) {
    const match = CD_PATTERN.exec(line)
    if (match === null) return false
    const raw = match[1] === undefined ? '' : match[1].trim()
    if (raw === '') {
      /* Bare `cd` prints the current cwd; there is no home-directory concept. */
      emitOutput(session, session.cwd + '\r\n')
      return true
    }
    const target = stripQuotes(raw)
    const resolved = path.resolve(session.cwd, target)
    let stats
    try {
      stats = statSync(resolved)
    } catch {
      emitOutput(session, '\r\ncd: ' + target + ': no such directory\r\n')
      return true
    }
    if (!stats.isDirectory()) {
      emitOutput(session, '\r\ncd: ' + target + ': not a directory\r\n')
      return true
    }
    session.cwd = canonicalPath(resolved)
    session.lastActivityAt = Date.now()
    emitOutput(session, session.cwd + '\r\n')
    return true
  }

  /**
   * Start the next queued line, if the session is idle. `cd` lines are consumed
   * synchronously (they never spawn) so a queue of only `cd`s drains at once.
   */
  function pump(session) {
    if (session.exited || session.stopRequested || session.running !== null) return
    while (session.queue.length > 0) {
      const line = session.queue.shift()
      if (line.trim() === '') continue
      if (handleCd(session, line)) continue
      execute(session, line)
      return
    }
  }

  function execute(session, line) {
    const argv = commandArgv(session.shellProfile.family, line)
    let child
    try {
      child = spawn(session.shellProfile.binary, argv, {
        cwd: session.cwd,
        windowsHide: true,
        /* stdin is ignored on purpose: this is a command console, not a TTY,
           and an interactive program must fail fast instead of blocking on a
           pipe nobody reads. */
        stdio: ['ignore', 'pipe', 'pipe'],
        env: shellEnv(),
      })
    } catch (error) {
      writeEvent(session, { type: 'error', message: messageOf(error) })
      emitOutput(session, '\r\n[exit -1]\r\n')
      pump(session)
      return
    }
    session.running = child
    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')

    child.stdout.on('data', (chunk) => { emitOutput(session, stdoutDecoder.write(chunk)) })
    child.stderr.on('data', (chunk) => { emitOutput(session, stderrDecoder.write(chunk)) })
    /* Streams can emit a late error while the process is being killed; without
       a listener that becomes an uncaught exception in the host process. */
    child.stdout.on('error', () => { /* the close handler cleans up */ })
    child.stderr.on('error', () => { /* the close handler cleans up */ })

    child.on('error', (error) => {
      writeEvent(session, { type: 'error', message: messageOf(error) })
    })

    child.on('close', (code, signal) => {
      const outTail = stdoutDecoder.end()
      if (outTail !== '') emitOutput(session, outTail)
      const errTail = stderrDecoder.end()
      if (errTail !== '') emitOutput(session, errTail)
      session.running = null
      if (session.killTimer !== null) { clearTimeout(session.killTimer); session.killTimer = null }
      if (session.forceTimer !== null) { clearTimeout(session.forceTimer); session.forceTimer = null }
      if (session.exited) return
      const exitCode = code === null ? -1 : code
      if (session.stopRequested) {
        finishSession(session, exitCode)
        return
      }
      /* A finished command keeps the session alive; the per-command result is
         an ordinary out marker, NOT the session-level exit event. */
      emitOutput(session, '\r\n[exit ' + String(exitCode) + ']\r\n')
      pump(session)
    })
  }

  /* ------------------------------------------------------------- methods --- */

  async function start(payload) {
    if (disposed) throw new ApiError('disposed', 'the plugin is shutting down', 503)
    const root = requireRoot(payload.root)
    if (sessions.size >= settings.maxSessions) {
      throw new ApiError(
        'session-limit',
        'at most ' + String(settings.maxSessions) + ' terminal session(s) may run at once',
        409,
      )
    }
    /* Resolve (and validate) the shell now, so a misconfigured profile fails on
       start instead of silently producing commands that never run. No process
       is launched here. */
    const profile = resolveShell(settings.shell)
    const session = {
      id: randomUUID(),
      cwd: root,
      shell: profile.display,
      shellProfile: profile,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      lineBuffer: '',
      queue: [],
      running: null,
      clients: new Set(),
      exitWaiters: [],
      exited: false,
      stopRequested: false,
      idleTimer: null,
      killTimer: null,
      forceTimer: null,
    }
    sessions.set(session.id, session)
    armIdle(session)
    return { id: session.id, shell: session.shell, cwd: session.cwd }
  }

  async function input(payload) {
    const session = sessionOf(payload.id)
    if (typeof payload.data !== 'string') throw badRequest('data must be a string')
    if (session.exited || session.stopRequested) throw notFound('unknown session')
    session.lastActivityAt = Date.now()
    armIdle(session)
    if (payload.data !== '') {
      session.lineBuffer += payload.data
      if (session.lineBuffer.length > MAX_LINE_CHARS) {
        session.lineBuffer = ''
        writeEvent(session, { type: 'error', message: 'input line is too long' })
      } else {
        const parts = session.lineBuffer.split(/\r?\n/)
        /* The last element is the incomplete tail (possibly empty). */
        session.lineBuffer = parts.pop() ?? ''
        for (const line of parts) session.queue.push(line)
        pump(session)
      }
    }
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

  /* Never leave a command behind when the plugin (or the host) goes away. The
     cleanup starts every kill synchronously, and awaiting it is harmless. */
  ctx.effect(() => () => service.dispose(), name + ': terminal sessions')
}
