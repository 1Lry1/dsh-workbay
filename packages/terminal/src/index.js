/**
 * dsh-workbay-terminal — host half (plain ESM JavaScript, no build step).
 *
 * Two execution modes behind the SAME routes:
 *
 *   pty     — Windows + `helper/WorkbayPty.exe` present (default `pty:'auto'`):
 *             ONE helper process per session. The helper owns a real ConPTY and
 *             spawns an interactive shell inside it; the host only bridges
 *             frames. Raw keystrokes go down (so Ctrl+C, arrows and full-screen
 *             TUI programs work), PTY output comes up and is forwarded as SSE
 *             `out` text.
 *   command — non-Windows, helper missing, or `pty:'off'`: the previous
 *             per-command fallback. Each complete line runs one short-lived
 *             shell process; the cwd is kept host-side; a finished command
 *             emits an `out` marker `\r\n[exit N]\r\n` and the session survives.
 *
 * The frozen contract is docs/terminal-pty.md (§1 helper protocol, §2 host,
 * §4 fallback). Routes:
 *
 *   POST /dsh-workbay-terminal/api/start   { root, cols?, rows?, shell? }
 *        -> { id, shell, cwd, mode }
 *   POST /dsh-workbay-terminal/api/input   { id, data }    -> { ok: true }
 *   POST /dsh-workbay-terminal/api/stop    { id }          -> { ok: true }
 *   POST /dsh-workbay-terminal/api/list    {}              -> { sessions: [...] }
 *   POST /dsh-workbay-terminal/api/resize  { id, cols, rows } -> { ok: true }
 *   POST /dsh-workbay-terminal/api/restart { id }          -> { id, cwd, mode }
 *   GET  /dsh-workbay-terminal/events?id=  (SSE)           -> hello / out / exit / error
 *
 * PTY frame protocol (helper stdin/stdout, binary; see docs/terminal-pty.md §1):
 *
 *   +------+----------------+----------------+
 *   | type | uint32 LE 长度 | payload (bytes)|
 *   | 1B   | 4B             | N              |
 *   +------+----------------+----------------+
 *   host -> helper: D raw input bytes, R {uint16 cols, uint16 rows}, X {uint32 pid, 0=all}
 *   helper -> host: D raw output bytes, X {int32 exit code} (helper then exits)
 *
 * Mode selection is decided per `start` (and per `restart`), not once at apply
 * time, so a helper that is built/removed while DSH runs is picked up without a
 * restart. In `auto`, an unavailable helper DEGRADES to command mode with one
 * clear log line; with `pty:'on'`, `start` fails with `500 pty-unavailable`.
 *
 * Security and hygiene:
 *   - NO shell-string building. `--shell-args` is a base64 JSON array built from
 *     a fixed argv vector per shell family; user text goes to the PTY's stdin
 *     (pty) or to one argv element (command). `cd` in command mode is host-side
 *     path arithmetic, never a shell builtin.
 *   - The JSON RPC surface (trust fence, bounded body, envelope, 404/405) is
 *     `@dsh-workbay/kit`'s `mountJsonApi`; only the SSE route is implemented
 *     here, because a stream is not a JSON method.
 *   - Nothing is persisted and no command text is logged. Output lives only in
 *     the SSE subscriber sockets and in one `StringDecoder` per stream.
 *   - Limits: at most `maxSessions` (default 8, cap 32), auto-stop after
 *     `idleTimeoutMs` without input (default 30 min), and `apply`'s dispose kills
 *     every helper/command process and clears every session/queue.
 *
 * Trust posture: routes are mounted on DSH's own web server and guarded by the
 * kit's same-origin fence (loopback peer / loopback Host / Sec-Fetch-Site), so
 * a random web page cannot spawn a shell on the machine.
 */

import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'

import { ApiError, isTrustedRequest, mountJsonApi, resolveInside, sendJson } from '@dsh-workbay/kit'

export const name = 'dsh-workbay-terminal'
export const inject = ['webServer']

const ROUTE_PREFIX = '/dsh-workbay-terminal/api'
const EVENTS_ROUTE = '/dsh-workbay-terminal/events'
const CHUNK_PREFIX = '/dsh-workbay-terminal/chunk'

/** packages/terminal — the chunk route serves this package's built output. */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Contract defaults — docs/terminal-pty.md §2 (PTY defaults) + §4 (fallback). */
const DEFAULTS = {
  shell: 'powershell',
  maxSessions: 8,
  idleTimeoutMs: 30 * 60 * 1000,
  pty: 'auto',
}

const MAX_BODY_BYTES = 64 * 1024
const MAX_SESSIONS = 32
const MAX_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000
/** SSE `out` events carry at most this many characters (the contract's 4 KiB). */
const MAX_OUTPUT_CHUNK = 4096
/** A command line larger than this is dropped with an error, not buffered forever. */
const MAX_LINE_CHARS = 64 * 1024
/** A single helper frame larger than this is treated as corruption. */
const MAX_HELPER_FRAME = 8 * 1024 * 1024
const HEARTBEAT_MS = 20_000
/** Give a killed/hung process this long before trying a harder kill. */
const KILL_FALLBACK_MS = 3_000
/** PTY helper: `X` plus stdin EOF should be enough; taskkill this much later. */
const PTY_KILL_FALLBACK_MS = 1_500
/** Last-resort synthetic exit if even the hard kill never reports `close`. */
const FORCE_EXIT_MS = 4_500
const SPAWN_TIMEOUT_MS = 15_000
const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24
const MIN_COLS = 20
const MAX_COLS = 500
const MIN_ROWS = 5
const MAX_ROWS = 200

/**
 * Environment handed to a shell/helper process.
 *
 * A user shell is not the plugin host: it should not inherit every credential
 * or temporary variable DSH itself was started with. Only the variables a shell
 * (and the tools it runs) genuinely needs to function are copied through.
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

function ptyUnavailable(detail) {
  return new ApiError('pty-unavailable', detail, 500)
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/* ============================== config ============================== */

function clampInt(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}

function clampCols(value, fallback) {
  return clampInt(value, fallback, MIN_COLS, MAX_COLS)
}

function clampRows(value, fallback) {
  return clampInt(value, fallback, MIN_ROWS, MAX_ROWS)
}

/**
 * Directory served by the lazy-chunk route. The page loads
 * `/dsh-workbay-terminal/chunk/xterm.js`, which is the build output in
 * `lib/chunks/` (scripts/build-chunks.mjs bundles `src/chunks/xterm.js`).
 * `DSH_WORKBAY_TERMINAL_CHUNKS` is a test/development seam so the route can be
 * exercised before/without the built chunk; production uses the package output.
 */
function defaultChunksDir() {
  const override = typeof process.env.DSH_WORKBAY_TERMINAL_CHUNKS === 'string'
    ? process.env.DSH_WORKBAY_TERMINAL_CHUNKS.trim()
    : ''
  if (override !== '') return path.resolve(override)
  return path.join(PACKAGE_ROOT, 'lib', 'chunks')
}

function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const shell = typeof source.shell === 'string' && source.shell.trim() !== ''
    ? source.shell.trim()
    : DEFAULTS.shell
  const pty = source.pty === 'off' || source.pty === 'on' ? source.pty : DEFAULTS.pty
  /* Internal test/development hook: point the host at a different helper (a
     Node fake speaks the same frames). Not part of the frozen config surface. */
  const ptyHelper = typeof source.ptyHelper === 'string' && source.ptyHelper.trim() !== ''
    ? source.ptyHelper.trim()
    : ''
  return {
    shell,
    maxSessions: clampInt(source.maxSessions, DEFAULTS.maxSessions, 1, MAX_SESSIONS),
    /* 0 disables the idle stop, which is useful for a deliberately long-lived
       session; the contract default is 30 minutes. */
    idleTimeoutMs: clampInt(source.idleTimeoutMs, DEFAULTS.idleTimeoutMs, 0, MAX_IDLE_TIMEOUT_MS),
    pty,
    ptyHelper,
    chunksDir: defaultChunksDir(),
  }
}

/* ============================== shell profiles ============================== */

const POSIX_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish'])

/** Base name -> argument family; the argv vectors are fixed per family. */
function shellFamilyOf(base) {
  if (base === 'powershell' || base === 'pwsh') return 'powershell'
  if (base === 'cmd') return 'cmd'
  if (POSIX_SHELLS.has(base)) return 'posix'
  /* An unrecognised shell is assumed to accept `-c` / read a TTY, which is the
     POSIX convention and the least surprising default. */
  return 'posix'
}

/** Startup argv for the PTY shell (the helper receives this as a JSON array). */
function ptyShellArgs(family) {
  if (family === 'powershell') return ['-NoLogo', '-NoProfile', '-NoExit']
  if (family === 'cmd') return []
  return []
}

/**
 * Command-mode line preparation. The UTF-8 prefix is what fixes the mojibake
 * seen in real screenshots: Windows PowerShell 5.1 encodes redirected stdout in
 * the ANSI/OEM code page unless `Console.OutputEncoding` is set first. cmd needs
 * the equivalent `chcp`; POSIX shells already use the locale's encoding.
 */
function commandLineFor(family, line) {
  if (family === 'powershell') return '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ' + line
  if (family === 'cmd') return 'chcp 65001>nul & ' + line
  return line
}

/**
 * The ONE command-invocation vector used for a family. The user's line is
 * always exactly one argv element — never concatenated into a string.
 */
function commandArgv(family, line) {
  const prepared = commandLineFor(family, line)
  if (family === 'powershell') return ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', prepared]
  if (family === 'cmd') return ['/D', '/Q', '/C', prepared]
  return ['-c', prepared]
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
 * Resolve a shell to an absolute executable path + family + PTY argv.
 *
 * An absolute config must exist; a bare name is resolved through the
 * allow-listed PATH/PATHEXT. There is deliberately NO spawn probe: `start` must
 * not launch a shell just to validate a path (a broken shell is reported as a
 * 500 here, not later as an empty output stream).
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
    const family = shellFamilyOf(base)
    return {
      binary: canonicalPath(configured),
      display: path.basename(configured),
      family,
      ptyArgs: ptyShellArgs(family),
    }
  }
  const bare = path.basename(configured).toLowerCase().replace(/\.exe$/, '')
  const name = binaryNameFor(bare, configured)
  const found = findOnPath(name)
  if (found === null) throw shellMissing('cannot find shell "' + configured + '" on PATH')
  const family = shellFamilyOf(bare)
  return {
    binary: found,
    display: path.basename(found),
    family,
    ptyArgs: ptyShellArgs(family),
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
 * Validate a working directory: absolute, existing, a directory. Root
 * *confinement* is the caller's responsibility (the same absolute path is used
 * as cwd), but a non-directory is always refused.
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

/* ============================== PTY helper ============================== */

/** Default helper location: packages/terminal/helper/WorkbayPty.exe. */
function defaultHelperPath() {
  return fileURLToPath(new URL('../helper/WorkbayPty.exe', import.meta.url))
}

/**
 * Where the PTY helper lives for THIS service.
 *
 * Precedence: config `ptyHelper` (a test/development override) > env
 * `DSH_WORKBAY_TERMINAL_PTY_HELPER` > the packaged exe next to the bundle. A
 * `.js`/`.mjs`/`.cjs` target is launched through this Node binary, which is how
 * the test suite exercises the bridge without the compiled helper.
 */
function helperSpec(settings) {
  const envOverride = typeof process.env.DSH_WORKBAY_TERMINAL_PTY_HELPER === 'string'
    ? process.env.DSH_WORKBAY_TERMINAL_PTY_HELPER.trim()
    : ''
  const configured = settings.ptyHelper !== '' ? settings.ptyHelper : envOverride
  const target = configured !== '' ? path.resolve(configured) : defaultHelperPath()
  let exists = false
  try {
    exists = statSync(target).isFile()
  } catch {
    exists = false
  }
  return {
    path: target,
    exists,
    /* A script helper is a test/dev fixture, not a packaged artifact. */
    nodeRunner: /\.(?:c|m)?js$/i.test(target),
  }
}

/* ============================== service ============================== */

function createService(settings) {
  /** Live sessions only: an entry is deleted the moment its session finishes. */
  const sessions = new Map()
  /** Starts in flight, so concurrent pty spawns cannot exceed maxSessions. */
  let pendingStarts = 0
  let disposed = false
  let warnedFallback = false

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
    if (session.helperExitTimer !== null) {
      clearTimeout(session.helperExitTimer)
      session.helperExitTimer = null
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

  /** Kill a process tree (argv array, numeric pid, no shell). */
  function killChildTree(child) {
    if (child === null || child === undefined) return
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
    const child = session.mode === 'pty' ? session.helper : session.running
    if (child === null) {
      finishSession(session, session.mode === 'pty' && session.helperExitCode !== null ? session.helperExitCode : 0)
      return Promise.resolve()
    }
    const finished = new Promise((resolve) => { session.exitWaiters.push(resolve) })
    if (session.mode === 'pty') {
      /* Contract §1: `X` terminates the shell's process tree. Closing stdin is
         the documented second signal (EOF also makes the helper clean up). */
      const helper = session.helper
      sendPtyFrame(session, 'X', uint32Payload(0))
      try { helper.stdin.end() } catch { /* already closed */ }
      session.killTimer = setTimeout(() => killChildTree(helper), PTY_KILL_FALLBACK_MS)
    } else {
      killChildTree(child)
      session.killTimer = setTimeout(() => forceKillChild(child), KILL_FALLBACK_MS)
    }
    session.forceTimer = setTimeout(() => {
      const target = session.mode === 'pty' ? session.helper : session.running
      killChildTree(target)
      finishSession(session, -1)
    }, FORCE_EXIT_MS)
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

  /* -------------------------------------------------------------- frames --- */

  /** 4-byte little-endian uint32 payload (PTY `X`). */
  function uint32Payload(value) {
    const payload = Buffer.allocUnsafe(4)
    payload.writeUInt32LE(value >>> 0, 0)
    return payload
  }

  /** 4-byte little-endian `uint16 cols + uint16 rows` payload (PTY `R`). */
  function sizePayload(cols, rows) {
    const payload = Buffer.allocUnsafe(4)
    payload.writeUInt16LE(cols, 0)
    payload.writeUInt16LE(rows, 2)
    return payload
  }

  /** Write one helper frame. Returns false when the helper pipe is gone. */
  function sendPtyFrame(session, type, payload) {
    const helper = session.helper
    if (helper === null || helper.stdin === null || !helper.stdin.writable) return false
    const frame = Buffer.allocUnsafe(5 + payload.length)
    frame.writeUInt8(type.charCodeAt(0), 0)
    frame.writeUInt32LE(payload.length, 1)
    payload.copy(frame, 5)
    try {
      helper.stdin.write(frame)
      return true
    } catch {
      return false
    }
  }

  /**
   * Incremental frame parser. Output bytes are decoded with a single
   * `StringDecoder('utf8')`, so a multi-byte character split across helper
   * frames is still forwarded correctly.
   */
  function createFrameReader(session) {
    let buffer = Buffer.alloc(0)
    return {
      push(chunk) {
        buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
        let offset = 0
        while (buffer.length - offset >= 5) {
          const type = String.fromCharCode(buffer[offset])
          const length = buffer.readUInt32LE(offset + 1)
          if (length > MAX_HELPER_FRAME) {
            writeEvent(session, { type: 'error', message: 'pty helper sent an oversized frame' })
            killChildTree(session.helper)
            buffer = Buffer.alloc(0)
            return
          }
          if (buffer.length - offset - 5 < length) break
          const payload = buffer.subarray(offset + 5, offset + 5 + length)
          offset += 5 + length
          if (type === 'D') {
            emitOutput(session, session.outputDecoder.write(payload))
          } else if (type === 'X') {
            session.helperExitCode = payload.length >= 4 ? payload.readInt32LE(0) : -1
            /* The helper exits right after `X`; if it lingers, do not keep the
               session (and its subscribers) waiting forever. */
            if (session.helperExitTimer === null) {
              session.helperExitTimer = setTimeout(() => {
                session.helperExitTimer = null
                /* The helper lingered after reporting the exit: make sure it (and
                   its shell tree) really goes away before forgetting the session. */
                killChildTree(session.helper)
                finishSession(session, session.helperExitCode)
              }, 1_500)
              if (typeof session.helperExitTimer.unref === 'function') session.helperExitTimer.unref()
            }
          }
          /* Unknown frame types are ignored: a newer helper may add some. */
        }
        buffer = offset === buffer.length ? Buffer.alloc(0) : buffer.subarray(offset)
      },
    }
  }

  /* ------------------------------------------------------------- sessions --- */

  function helperSpecForService() {
    return helperSpec(settings)
  }

  function warnFallbackOnce(detail) {
    if (warnedFallback) return
    warnedFallback = true
    /* A clear, single line — it names the helper path or platform, never any
       command text. */
    console.warn('[dsh-workbay-terminal] ' + detail + '; falling back to command mode')
  }

  /** Decide the session mode for a new session, honouring `pty` config. */
  function selectMode() {
    if (settings.pty === 'off') return 'command'
    const spec = helperSpecForService()
    const platformOk = process.platform === 'win32'
    if (platformOk && spec.exists) return 'pty'
    if (settings.pty === 'on') {
      throw ptyUnavailable(platformOk
        ? 'the PTY helper is missing: ' + spec.path
        : 'PTY mode is only available on Windows (platform is ' + process.platform + ')')
    }
    warnFallbackOnce(platformOk
      ? 'PTY helper not found at ' + spec.path
      : 'PTY mode is not supported on ' + process.platform)
    return 'command'
  }

  function baseSession(fields) {
    return {
      id: randomUUID(),
      cwd: fields.cwd,
      shell: fields.profile.display,
      shellProfile: fields.profile,
      mode: fields.mode,
      cols: fields.cols,
      rows: fields.rows,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      clients: new Set(),
      exitWaiters: [],
      exited: false,
      stopRequested: false,
      idleTimer: null,
      killTimer: null,
      forceTimer: null,
      helperExitTimer: null,
      /* command mode only */
      lineBuffer: '',
      queue: [],
      running: null,
      /* pty mode only */
      helper: null,
      helperExitCode: null,
      helperStderr: '',
      outputDecoder: null,
      frameReader: null,
    }
  }

  function createCommandSession(fields) {
    const session = baseSession({ ...fields, mode: 'command' })
    sessions.set(session.id, session)
    armIdle(session)
    return session
  }

  function spawnPtyHelper(spec, profile, cwd, cols, rows) {
    const helperArgs = [
      '--shell', profile.binary,
      '--shell-args', Buffer.from(JSON.stringify(profile.ptyArgs), 'utf8').toString('base64'),
      '--cwd', cwd,
      '--cols', String(cols),
      '--rows', String(rows),
    ]
    const binary = spec.nodeRunner ? process.execPath : spec.path
    const argv = spec.nodeRunner ? [spec.path, ...helperArgs] : helperArgs
    return new Promise((resolve, reject) => {
      let child
      try {
        child = spawn(binary, argv, {
          cwd,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: shellEnv(),
        })
      } catch (error) {
        reject(ptyUnavailable('cannot start the PTY helper: ' + messageOf(error)))
        return
      }
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try { child.kill('SIGKILL') } catch { /* gone */ }
        reject(ptyUnavailable('the PTY helper did not start in time'))
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
        settle(reject, ptyUnavailable('cannot start the PTY helper: ' + messageOf(error)))
      }
      /* Attached before any await so an early EPIPE cannot become an uncaught
         exception; the read/write handlers are attached by wirePtySession. */
      child.stdin.on('error', () => { /* handled by the close event */ })
      child.once('spawn', onSpawn)
      child.once('error', onError)
    })
  }

  function wirePtySession(session) {
    const helper = session.helper
    helper.stdout.on('data', (chunk) => { session.frameReader.push(chunk) })
    helper.stdout.on('error', () => { /* the close handler cleans up */ })
    helper.stderr.on('data', (chunk) => {
      /* Diagnostics only; bounded so a chatty helper cannot grow memory. */
      session.helperStderr = (session.helperStderr + chunk.toString('utf8')).slice(-4096)
    })
    helper.stderr.on('error', () => { /* the close handler cleans up */ })

    helper.on('error', (error) => {
      writeEvent(session, { type: 'error', message: messageOf(error) })
    })

    helper.on('close', (code, signal) => {
      const tail = session.outputDecoder.end()
      if (tail !== '') emitOutput(session, tail)
      session.helper = null
      if (session.killTimer !== null) { clearTimeout(session.killTimer); session.killTimer = null }
      if (session.forceTimer !== null) { clearTimeout(session.forceTimer); session.forceTimer = null }
      if (session.helperExitTimer !== null) { clearTimeout(session.helperExitTimer); session.helperExitTimer = null }
      if (session.exited) return
      const exitCode = session.helperExitCode !== null
        ? session.helperExitCode
        : (code === null ? -1 : code)
      if (!session.stopRequested && session.helperExitCode === null) {
        /* The helper vanished without reporting the shell's exit: that is a
           host-visible failure, not a normal shell exit. */
        const detail = session.helperStderr.trim()
        writeEvent(session, {
          type: 'error',
          message: 'pty helper exited unexpectedly'
            + (detail === '' ? ' (exit ' + String(exitCode) + ')' : ': ' + detail),
        })
      }
      finishSession(session, exitCode)
    })
  }

  async function createPtySession(fields) {
    const spec = helperSpecForService()
    const child = await spawnPtyHelper(spec, fields.profile, fields.cwd, fields.cols, fields.rows)
    const session = baseSession({ ...fields, mode: 'pty' })
    session.helper = child
    session.outputDecoder = new StringDecoder('utf8')
    session.frameReader = createFrameReader(session)
    sessions.set(session.id, session)
    wirePtySession(session)
    armIdle(session)
    return session
  }

  /**
   * Create a session in the best mode available right now. In `auto`, a helper
   * that exists but fails to spawn also degrades to command mode.
   */
  async function createSessionOfMode(fields) {
    const mode = selectMode()
    if (mode === 'pty') {
      try {
        return await createPtySession(fields)
      } catch (error) {
        if (settings.pty !== 'auto') throw error
        if (!(error instanceof ApiError) || error.code !== 'pty-unavailable') throw error
        warnFallbackOnce(messageOf(error))
        return createCommandSession(fields)
      }
    }
    return createCommandSession(fields)
  }

  function startResponse(session) {
    return {
      id: session.id,
      shell: session.shell,
      cwd: session.cwd,
      mode: session.mode,
    }
  }

  function ensureCapacity() {
    if (sessions.size + pendingStarts >= settings.maxSessions) {
      throw new ApiError(
        'session-limit',
        'at most ' + String(settings.maxSessions) + ' terminal session(s) may run at once',
        409,
      )
    }
  }

  function shellForStart(payload) {
    if (payload.shell === undefined || payload.shell === null) return settings.shell
    if (typeof payload.shell !== 'string' || payload.shell.trim() === '') {
      throw badRequest('shell must be a non-empty string')
    }
    return payload.shell.trim()
  }

  function sizeForStart(payload, fallbackCols, fallbackRows) {
    const cols = payload.cols === undefined || payload.cols === null
      ? fallbackCols
      : clampCols(Number(payload.cols), fallbackCols)
    const rows = payload.rows === undefined || payload.rows === null
      ? fallbackRows
      : clampRows(Number(payload.rows), fallbackRows)
    return { cols, rows }
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
   * Host-side `cd` (command mode only): the ONLY builtin the fallback console
   * understands. Returns true when the line was consumed (valid or not).
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
      executeCommand(session, line)
      return
    }
  }

  function executeCommand(session, line) {
    const argv = commandArgv(session.shellProfile.family, line)
    let child
    try {
      child = spawn(session.shellProfile.binary, argv, {
        cwd: session.cwd,
        windowsHide: true,
        /* stdin is ignored on purpose: command mode is a console, not a TTY,
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
      const exitCode = code === null ? (signal === null ? -1 : -1) : code
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
    ensureCapacity()
    const profile = resolveShell(shellForStart(payload))
    const size = sizeForStart(payload, DEFAULT_COLS, DEFAULT_ROWS)
    pendingStarts += 1
    try {
      const session = await createSessionOfMode({ cwd: root, profile, cols: size.cols, rows: size.rows })
      return startResponse(session)
    } finally {
      pendingStarts -= 1
    }
  }

  async function input(payload) {
    const session = sessionOf(payload.id)
    if (typeof payload.data !== 'string') throw badRequest('data must be a string')
    if (session.exited || session.stopRequested) throw notFound('unknown session')
    session.lastActivityAt = Date.now()
    armIdle(session)

    if (session.mode === 'pty') {
      /* Raw keystrokes, exactly as the terminal sent them: no line buffering,
         no host echo, no `cd` interception (the PTY's shell does all of it). */
      if (payload.data !== '') sendPtyFrame(session, 'D', Buffer.from(payload.data, 'utf8'))
      return { ok: true }
    }

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
    /* docs/files-api.md §4: id, cwd, startedAt and the mode (the client uses it
       for the non-PTY banner before it has opened a stream). */
    const entries = [...sessions.values()]
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((session) => ({
        id: session.id,
        cwd: session.cwd,
        startedAt: session.startedAt,
        mode: session.mode,
      }))
    return { sessions: entries }
  }

  async function resize(payload) {
    const session = sessionOf(payload.id)
    if (typeof payload.cols !== 'number' || !Number.isFinite(payload.cols)) {
      throw badRequest('cols must be a number')
    }
    if (typeof payload.rows !== 'number' || !Number.isFinite(payload.rows)) {
      throw badRequest('rows must be a number')
    }
    session.cols = clampCols(payload.cols, session.cols)
    session.rows = clampRows(payload.rows, session.rows)
    if (session.mode === 'pty') {
      sendPtyFrame(session, 'R', sizePayload(session.cols, session.rows))
    }
    session.lastActivityAt = Date.now()
    return { ok: true }
  }

  async function restart(payload) {
    const session = sessionOf(payload.id)
    const cwd = requireRoot(session.cwd)
    const profile = session.shellProfile
    const mode = session.mode
    const cols = session.cols
    const rows = session.rows
    /* Reclaim the old session first: the replacement must not need a second
       slot, and its subscribers get a clean `exit`. */
    await stopSession(session)
    ensureCapacity()
    pendingStarts += 1
    try {
      /* The client relies on the SAME mode coming back (its renderer for a PTY
         tab cannot switch to local echo mid-flight), so restart never silently
         degrades: a pty session that cannot get its helper fails the restart
         with `pty-unavailable` instead. */
      const next = mode === 'pty'
        ? await createPtySession({ cwd, profile, cols, rows })
        : createCommandSession({ cwd, profile, cols, rows })
      /* docs/files-api.md §4 returns shell too; docs/terminal-pty.md §2 asks for
         id/cwd/mode — the superset keeps both documents true. */
      return { id: next.id, shell: next.shell, cwd: next.cwd, mode: next.mode }
    } finally {
      pendingStarts -= 1
    }
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
      mode: session.mode,
      cols: session.cols,
      rows: session.rows,
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

  /* ----------------------------------------------------------- chunk route --- */

  /** `<name>.js` only: no separators, no dot segments, no decoded escapes. */
  function chunkNameOf(pathname) {
    const prefix = CHUNK_PREFIX + '/'
    if (!pathname.startsWith(prefix)) return null
    const raw = pathname.slice(prefix.length)
    if (raw === '') return null
    let name
    try {
      name = decodeURIComponent(raw)
    } catch {
      return null
    }
    if (name.includes('/') || name.includes('\\')) return null
    if (name.includes('..')) return null
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.js$/.test(name)) return null
    return name
  }

  function headerOf(req, name) {
    const value = req.headers === undefined ? undefined : req.headers[name]
    if (Array.isArray(value)) return value[0]
    return typeof value === 'string' ? value : undefined
  }

  function sendRouteError(res, error) {
    const status = error instanceof ApiError ? error.status : 500
    sendJson(res, status, {
      ok: false,
      error: {
        code: error instanceof ApiError ? error.code : 'internal',
        message: messageOf(error),
      },
    })
  }

  /**
   * Serve one built lazy chunk (docs/files-api.md §3 protocol, terminal prefix).
   * The page loads exactly `/dsh-workbay-terminal/chunk/xterm.js`; without this
   * route the terminal tab shows "terminal chunk failed to load".
   */
  async function handleChunk(req, res) {
    if (!isTrustedRequest(req)) {
      sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { ok: false, error: { code: 'method-error', message: 'GET required' } })
      return
    }
    let url
    try {
      url = new URL(req.url === undefined ? '/' : req.url, 'http://dsh.internal')
    } catch {
      sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'invalid request URL' } })
      return
    }
    const chunkName = chunkNameOf(url.pathname)
    if (chunkName === null) {
      sendRouteError(res, new ApiError('not-found', 'unknown chunk', 404))
      return
    }
    try {
      const chunksDir = settings.chunksDir
      if (!existsSync(chunksDir)) throw new ApiError('not-found', 'no chunks have been built', 404)
      const target = resolveInside(chunksDir, chunkName)
      let body
      try {
        body = readFileSync(target)
      } catch (error) {
        const code = error !== null && typeof error === 'object' ? error.code : undefined
        if (code === 'ENOENT') throw new ApiError('not-found', 'chunk "' + chunkName + '" is not built', 404)
        throw new ApiError('chunk-failed', 'cannot read chunk: ' + messageOf(error), 500)
      }
      const etag = '"' + createHash('sha1').update(body).digest('hex') + '"'
      const headers = {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
        etag,
      }
      const ifNoneMatch = headerOf(req, 'if-none-match')
      if (typeof ifNoneMatch === 'string' && ifNoneMatch.split(',').some((value) => value.trim() === etag)) {
        res.writeHead(304, headers)
        res.end()
        return
      }
      headers['content-length'] = String(body.length)
      res.writeHead(200, headers)
      if (req.method === 'HEAD') {
        res.end()
        return
      }
      res.end(body)
    } catch (error) {
      sendRouteError(res, error)
    }
  }

  /* ------------------------------------------------------------- dispose --- */

  async function dispose() {
    if (disposed) return
    disposed = true
    const live = [...sessions.values()]
    await Promise.all(live.map((session) => stopSession(session).catch(() => undefined)))
  }

  return {
    methods: { start, input, stop, list, resize, restart },
    handleEvents,
    handleChunk,
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

  /* The lazy client chunk (xterm.js) is served by this host half; the page
     loads `/dsh-workbay-terminal/chunk/xterm.js`. Same trust fence, ETag/304
     and traversal rules as the files chunk route (docs/files-api.md §3). */
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: CHUNK_PREFIX, handler: service.handleChunk }),
    name + ': chunk route',
  )

  /* Never leave a shell/helper behind when the plugin (or the host) goes away.
     The cleanup starts every kill synchronously, and awaiting it is harmless. */
  ctx.effect(() => () => service.dispose(), name + ': terminal sessions')
}
