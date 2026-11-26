/**
 * dsh-gitcraft — host half (plain ESM JavaScript, no build step).
 *
 * One HTTP surface backs the browser panel:
 *
 *   POST /dsh-gitcraft/api/<method>   -> { ok: true, data } | { ok: false, error }
 *
 * Every method is a thin argv-array wrapper around the local `git` binary (never
 * a shell string), executed with the working directory the client sent (the
 * session scope cwd, already resolved to a repository root by the client's
 * first `snapshot` call). Write methods are explicit and run serialised per
 * repository; the destructive ones carry their own guard rails.
 *
 * Trust fence: the routes are mounted on DSH's own web server, so they are
 * same-origin by construction. A request is served only when the Host header
 * names a loopback authority or the browser marks the request as same-origin
 * (Sec-Fetch-Site) — a cross-site page cannot forge those, which is the same
 * posture dsh-better-sidebar's own /sidebar/api routes take.
 */
import { spawn } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmdirSync, statSync, unlinkSync, watch, writeFileSync } from 'node:fs'
import path from 'node:path'

import { mountJsonApi } from '@dsh-workbay/kit'

export const name = 'dsh-gitcraft'

/* Test-only surface: the caches are process memory with no files of their own,
   so the only way to assert their bounds is to read them from here. */
export const __test = { diffCacheStats, setDiffCacheBudget }
export const inject = ['webServer']

const ROUTE_PREFIX = '/dsh-gitcraft/api'
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const MAX_BODY_BYTES = 2 * 1024 * 1024
const MAX_DIFF_CHARS = 600 * 1024
const DEFAULT_TIMEOUT_MS = 30_000
const NETWORK_TIMEOUT_MS = 180_000

const DEFAULTS = {
  refreshIntervalMs: 15_000,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  networkTimeoutMs: NETWORK_TIMEOUT_MS,
  defaultDiffView: 'unified',
}

let hostConfig = { ...DEFAULTS }

/* ============================== errors ============================== */

class PanelError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
    this.expose = true
  }
}

function badRequest(message) {
  return new PanelError('bad-request', message, 400)
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Translate a spawn() failure into the RIGHT error code.
 *
 * History: every spawn failure used to be reported as `git-missing` ("找不到 git
 * 命令"), so passing an argv longer than the Win32 limit (~32767 chars) told the
 * user git was not installed — a completely wrong diagnosis for what is really
 * "the file list did not fit on a command line". The two cases must stay
 * distinguishable, because only one of them is fixed by installing git.
 *
 *   ENOENT        the executable itself is absent        -> git-missing
 *   ENAMETOOLONG  argv exceeded the OS command-line cap  -> argv-too-long
 *   anything else spawn refused for another reason       -> git-spawn-failed
 */
function spawnFailure(error) {
  const code = error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : ''
  if (code === 'ENOENT') return new PanelError('git-missing', 'cannot run git: ' + messageOf(error), 500)
  if (code === 'ENAMETOOLONG') {
    return new PanelError('argv-too-long',
      'the file list is too long for one command line (Win32 caps it at ~32767 characters); '
      + 'narrow the operation down instead of passing every path: ' + messageOf(error), 413)
  }
  return new PanelError('git-spawn-failed', 'cannot run git: ' + messageOf(error), 500)
}

/* ============================== config ============================== */

let Schema = null
try {
  Schema = (await import('@deepseek-ai/schemastery')).default
} catch (error) {
  console.warn('[dsh-gitcraft] @deepseek-ai/schemastery is not resolvable here; the row Config surface is absent: '
    + messageOf(error))
}

function live(schema) {
  return typeof schema.volatile === 'function' ? schema.volatile() : schema
}

export const Config = Schema === null
  ? undefined
  : Schema.object({
    refreshIntervalMs: Schema.number().default(DEFAULTS.refreshIntervalMs)
      .description('面板自动刷新间隔（毫秒，3000–120000）'),
    timeoutMs: Schema.number().default(DEFAULTS.timeoutMs)
      .description('单条本地 git 命令超时（毫秒）'),
    networkTimeoutMs: Schema.number().default(DEFAULTS.networkTimeoutMs)
      .description('fetch / pull / push 等联网命令超时（毫秒）'),
    defaultDiffView: Schema.union([
      Schema.const('unified').description('统一视图'),
      Schema.const('split').description('并排视图'),
    ]).default('unified').description('差异默认视图'),
  })

function normalizeHostConfig(raw) {
  const c = raw !== null && typeof raw === 'object' ? raw : {}
  const num = (value, fallback, min, max) => {
    const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
    return Math.min(max, Math.max(min, n))
  }
  return {
    refreshIntervalMs: num(c.refreshIntervalMs, DEFAULTS.refreshIntervalMs, 3000, 120_000),
    timeoutMs: num(c.timeoutMs, DEFAULTS.timeoutMs, 5_000, 120_000),
    networkTimeoutMs: num(c.networkTimeoutMs, DEFAULTS.networkTimeoutMs, 10_000, 600_000),
    defaultDiffView: c.defaultDiffView === 'split' ? 'split' : 'unified',
  }
}

/* ============================== argv git ============================== */

function gitBinary() {
  const override = process.env.DSH_GITCRAFT_BIN
  return typeof override === 'string' && override.trim() !== '' ? override.trim() : 'git'
}

/**
 * Global options prepended to EVERY spawn. A git process can cost well over a
 * second on a cold Windows profile, so a refresh must (a) spawn as few processes
 * as possible and (b) make each one as cheap as possible:
 *
 *   gc.auto / maintenance.auto   never run an opportunistic repack mid-request
 *   core.fsmonitor               never pay for a fsmonitor daemon handshake
 *   core.quotepath               print paths as UTF-8 instead of octal escapes
 *
 * They are prepended to argv (not passed as `git config` in an env var) so a
 * user's own `-c` in DSH_GITCRAFT_BIN cannot turn the noise back on, and they
 * land before the subcommand, which is where git expects global options.
 */
const GIT_GLOBAL_ARGS = [
  '-c', 'core.fsmonitor=false',
  '-c', 'gc.auto=0',
  '-c', 'maintenance.auto=false',
  '-c', 'core.quotepath=false',
  /* A user config of log.showSignature=true makes every log/show verify GPG
     signatures (a process per commit, often seconds). The panel never renders
     signature state, so switch it off for these plumbing reads. */
  '-c', 'log.showSignature=false',
  '-c', 'color.ui=false',
]

/** spawn() env: no optional index locks, no interactive prompt, stable locale. */
function gitEnv() {
  return {
    ...process.env,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_LAZY_FETCH: '1',
    LC_ALL: 'C',
  }
}

/**
 * Run git with an argv array (no shell). Resolves for ANY exit code so callers
 * can decide whether a non-zero status is data or an error.
 */
function runGit(cwd, args, options = {}) {
  const timeoutMs = options.timeoutMs === undefined ? hostConfig.timeoutMs : options.timeoutMs
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(gitBinary(), [...GIT_GLOBAL_ARGS, ...args], {
        cwd,
        windowsHide: true,
        // stdin is ignored on purpose: a network command must fail fast instead
        // of blocking on an interactive credential prompt.
        stdio: ['ignore', 'pipe', 'pipe'],
        env: gitEnv(),
      })
    } catch (error) {
      reject(spawnFailure(error))
      return
    }
    const out = []
    const err = []
    let outBytes = 0
    let errBytes = 0
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill('SIGKILL') } catch (error) { void error }
      reject(new PanelError('git-timeout', `git ${args[0]} timed out after ${timeoutMs}ms`, 504))
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      outBytes += chunk.length
      if (outBytes <= MAX_OUTPUT_BYTES) out.push(chunk)
    })
    child.stderr.on('data', (chunk) => {
      errBytes += chunk.length
      if (errBytes <= MAX_OUTPUT_BYTES) err.push(chunk)
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new PanelError('git-missing', 'cannot run git: ' + messageOf(error), 500))
    })
    child.on('close', (code, signal) => {
      finish({
        code: code === null ? -1 : code,
        signal: signal === null ? undefined : signal,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        truncated: outBytes > MAX_OUTPUT_BYTES || errBytes > MAX_OUTPUT_BYTES,
      })
    })
  })
}

/**
 * Run git and pipe `input` to its stdin (needed by `git apply --cached` and
 * `git hash-object --stdin`). Resolves for any exit code.
 */
function runGitWithInput(cwd, args, input, options = {}) {
  const timeoutMs = options.timeoutMs === undefined ? hostConfig.timeoutMs : options.timeoutMs
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(gitBinary(), [...GIT_GLOBAL_ARGS, ...args], {
        cwd,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: gitEnv(),
      })
    } catch (error) {
      reject(spawnFailure(error))
      return
    }
    const out = []
    const err = []
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill('SIGKILL') } catch (error) { void error }
      reject(new PanelError('git-timeout', `git ${args[0]} timed out after ${timeoutMs}ms`, 504))
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { out.push(chunk) })
    child.stderr.on('data', (chunk) => { err.push(chunk) })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new PanelError('git-missing', 'cannot run git: ' + messageOf(error), 500))
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        code: code === null ? -1 : code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      })
    })
    try {
      child.stdin.end(input, 'utf8')
    } catch (error) {
      void error
    }
  })
}

async function git(cwd, args, options = {}) {
  const result = await runGit(cwd, args, options)
  if (result.code !== 0) {
    const detail = result.stderr.trim() === '' ? result.stdout.trim() : result.stderr.trim()
    throw new PanelError('git-failed', `git ${args.join(' ')} failed: ${detail === '' ? 'exit ' + result.code : detail}`, 409)
  }
  return result.stdout
}

/* ============================== payload helpers ============================== */

function requireAbsolute(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw badRequest(label + ' is required')
  if (!path.isAbsolute(value)) throw badRequest(label + ' must be an absolute path')
  return path.resolve(value)
}

function requireRef(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw badRequest(label + ' is required')
  const name = value.trim()
  if (name.startsWith('-')) throw badRequest(label + ' must not start with "-"')
  if (/[\u0000-\u001f\u007f\s]/.test(name)) throw badRequest(label + ' contains invalid characters')
  if (name.includes('..')) throw badRequest(label + ' contains ".."')
  return name
}

function requireMessage(value, label = 'message') {
  if (typeof value !== 'string' || value.trim() === '') throw badRequest(label + ' is required')
  return value
}

function requirePaths(value) {
  if (!Array.isArray(value) || value.length === 0) throw badRequest('paths is required')
  return value.map((entry) => {
    if (typeof entry !== 'string' || entry.trim() === '') throw badRequest('paths entries must be non-empty strings')
    if (entry.includes('\u0000')) throw badRequest('paths entries must not contain NUL')
    if (path.isAbsolute(entry)) throw badRequest('paths entries must be repository-relative')
    // A `..` segment would let a pathspec escape the repository root (git
    // rejects most of those, but a magic pathspec can smuggle one through).
    const segments = entry.split(/[\\/]+/)
    if (segments.includes('..')) throw badRequest('paths entries must not contain ".."')
    return entry
  })
}



/* The native right-sidebar seat hands the panel a sessionId but no cwd, so the
   host resolves the session's workspace itself instead of failing the request.
   Services are resolved lazily and per request: a provider fiber that activates
   late (or restarts) is picked up without re-registering the route. */
let sessionServices = null

/**
 * Resolve the working directory a request should run against.
 *
 * Four sources, in order:
 *   1. an explicit `cwd` (what a session-scoped seat always sends);
 *   2. an explicit `repoRoot` — a GLOBAL surface (the workbench dock) has no
 *      session and therefore no cwd, but it does know which repository it is
 *      looking at, and that repository root IS its working directory;
 *   3. an explicit `dir` — the picker browsing the filesystem before any
 *      repository has been chosen;
 *   4. the session's own workspace, resolved from `sessionId`.
 *
 * Before (2) and (3) existed, every global picker request failed with
 * "cwd or sessionId is required" — the dock has neither.
 */
async function cwdOfPayload(payload) {
  if (typeof payload.cwd === 'string' && payload.cwd.trim() !== '') return requireAbsolute(payload.cwd, 'cwd')
  if (typeof payload.repoRoot === 'string' && payload.repoRoot.trim() !== '') {
    return requireAbsolute(payload.repoRoot, 'repoRoot')
  }
  if (typeof payload.dir === 'string' && payload.dir.trim() !== '') return requireAbsolute(payload.dir, 'dir')
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
  if (sessionId === '') throw badRequest('cwd, repoRoot, dir or sessionId is required')
  const resolved = await sessionCwdOfAsync(sessionId)
  if (resolved === undefined) {
    throw new PanelError('cwd-unavailable', 'the session has no working directory yet', 409)
  }
  return requireAbsolute(resolved, 'session cwd')
}

function sessionCwdOf(sessionId) {
  if (sessionServices === null) return undefined
  const { sessions, persistence } = sessionServices
  try {
    const live = sessions === undefined || sessions === null ? undefined : sessions.get(sessionId)
    const liveCwd = live === undefined || live === null ? undefined : live.header === undefined ? undefined : live.header.cwd
    if (typeof liveCwd === 'string' && liveCwd !== '') return liveCwd
  } catch (error) {
    void error
  }
  return undefined
}

/** Async variant used when the live session is gone but its file persists. */
async function sessionCwdOfAsync(sessionId) {
  const live = sessionCwdOf(sessionId)
  if (live !== undefined) return live
  if (sessionServices === null || sessionServices.persistence === undefined || sessionServices.persistence === null) {
    return undefined
  }
  try {
    const snapshot = await sessionServices.persistence.stat(sessionId)
    const cwd = snapshot === undefined || snapshot === null || snapshot.header === undefined ? undefined : snapshot.header.cwd
    if (typeof cwd === 'string' && cwd !== '') return cwd
  } catch (error) {
    void error
  }
  return undefined
}

function boolOf(value) {
  return value === true
}

function clipDiff(text) {
  if (typeof text !== 'string' || text.length <= MAX_DIFF_CHARS) return text
  return text.slice(0, MAX_DIFF_CHARS) + `\n… [diff truncated: ${text.length - MAX_DIFF_CHARS} more chars] …\n`
}

/**
 * Short-lived cache for the two lists the panel re-reads every time the user
 * switches tabs: the commit list and the branch/tag list.
 *
 * Both cost ONE full git spawn (~110 ms on a cold Windows profile, measured in
 * tests/bench.mjs), and switching Changes -> History -> Branches -> History used
 * to pay that every single time, which is what made the panel feel sluggish.
 *
 * They are keyed on the same revision token the watcher already maintains, so a
 * real repository change invalidates them immediately rather than after a timer:
 * the watcher bumps `revision`, and every cached list is stored together with
 * the revision it was read at. A key that includes `revision` is therefore
 * self-invalidating — no manual bookkeeping, no stale list after a commit.
 *
 * Bounded so a long session cannot grow it without limit.
 */
const LIST_CACHE_LIMIT = 24
const listCache = new Map()

function listCacheKey(kind, root, revision, extra) {
  return kind + '\u0000' + root + '\u0000' + revision + '\u0000' + extra
}

function cachedList(key) {
  const hit = listCache.get(key)
  if (hit === undefined) return undefined
  /* Refresh LRU position. */
  listCache.delete(key)
  listCache.set(key, hit)
  return hit
}

function rememberList(key, value) {
  if (listCache.size >= LIST_CACHE_LIMIT) {
    const oldest = listCache.keys().next()
    if (oldest.done !== true) listCache.delete(oldest.value)
  }
  listCache.set(key, value)
  return value
}

/** Drop every cached list (a write happened, so the revision is about to move). */
function invalidateLists() {
  listCache.clear()
}

/**
 * The change counter the watcher for `root` has observed so far, or 0 when no
 * watcher exists yet.
 *
 * Used as a cache generation: any filesystem event the watcher saw means the
 * commit list / branch list MAY have changed, and because the counter is part of
 * the cache key the old entries simply stop being reachable. No invalidation
 * call is needed, so nothing can forget to call it.
 */
function watcherRevisionOf(root) {
  /* `watchState` is declared further down, next to the watcher machinery; this
     function only runs during a request, long after module initialisation. */
  const state = watchState.get(root)
  return state === undefined ? 0 : state.revision
}

/* ============================== repository ============================== */

/**
 * Cache of `dir -> resolved repository root`.
 *
 * `git rev-parse --show-toplevel` costs a full process spawn (~100 ms on a cold
 * Windows profile, which is what this app runs on). The panel makes a dozen
 * calls per screen, so paying for it on EVERY request was the single largest
 * fixed cost in the whole API — measured at 97 ms per request in tests/bench.mjs,
 * i.e. it roughly DOUBLED the latency of `snapshot` and `status`.
 *
 * The mapping "this directory belongs to that repository" only changes when the
 * directory is created, moved, or turns into a worktree — all rare. A short TTL
 * plus explicit invalidation from the operations that can create a repository
 * (`init`) or move one (`clone`-style flows do not exist here) keeps it honest.
 *
 * A NEGATIVE result is cached too (as `null`): the picker probes many folders
 * that are not repositories, and re-spawning git for each of them made browsing
 * feel dead. Those entries expire faster so a fresh `git init` is picked up
 * quickly.
 */
const ROOT_CACHE_TTL_MS = 30_000
const ROOT_CACHE_NEGATIVE_TTL_MS = 3_000
const ROOT_CACHE_LIMIT = 64
const rootCache = new Map()

function rootCacheKey(dir) {
  return process.platform === 'win32' ? dir.toLowerCase() : dir
}

function cachedRootOf(dir) {
  const entry = rootCache.get(rootCacheKey(dir))
  if (entry === undefined) return undefined
  if (Date.now() >= entry.expiresAt) {
    rootCache.delete(rootCacheKey(dir))
    return undefined
  }
  return entry
}

function rememberRoot(dir, root) {
  const key = rootCacheKey(dir)
  if (rootCache.size >= ROOT_CACHE_LIMIT && rootCache.has(key) === false) {
    const oldest = rootCache.keys().next()
    if (oldest.done !== true) rootCache.delete(oldest.value)
  }
  rootCache.set(key, {
    root,
    expiresAt: Date.now() + (root === null ? ROOT_CACHE_NEGATIVE_TTL_MS : ROOT_CACHE_TTL_MS),
  })
}

/** Drop cached roots (a new repository may have appeared under one of them). */
export function invalidateRepoRoots() {
  rootCache.clear()
}

/**
 * Resolve the repository root for a payload. `repoRoot` wins when the client
 * already resolved one (multi-repo workspaces); a locked-in worktree of the
 * session (`cwd`) is used verbatim when it lives INSIDE that root.
 */
async function repoRootOf(cwd, payload) {
  /* A declared repoRoot is the user's explicit choice (a workspace container
     whose session cwd is the parent, say), so it wins outright; the session
     cwd need not live inside it. Both are absolute paths and the root is
     whatever `rev-parse --show-toplevel` answers, so neither can escape. */
  const declared = typeof payload.repoRoot === 'string' && payload.repoRoot.trim() !== ''
    ? requireAbsolute(payload.repoRoot, 'repoRoot')
    : null
  /* A declared root is honoured wherever it points. The picker is a file dialog
     (SourceTree-style): the user may open any repository on any drive. What is
     still enforced is that the path is absolute and that `rev-parse` confirms a
     repository there, so this can never become an arbitrary directory read. */
  const probeDir = declared !== null ? declared : cwd
  const cached = cachedRootOf(probeDir)
  if (cached !== undefined) {
    if (cached.root === null) throw notARepoError()
    return cached.root
  }
  const top = await runGit(probeDir, ['rev-parse', '--show-toplevel'], { timeoutMs: 15_000 })
  if (top.code !== 0) {
    const detail = top.stderr.trim()
    /* Only a genuine "not a repository" answer is worth remembering; a timeout
       or a locked index must be retried on the next call, not cached as truth. */
    if (top.code === 128 && /not a git repository/i.test(detail)) rememberRoot(probeDir, null)
    throw new PanelError(
      top.code === 128 && /not a git repository/i.test(detail) ? 'not-a-repo' : 'repo-unavailable',
      detail === '' ? 'not a git repository' : detail,
      400,
    )
  }
  const raw = top.stdout.trim()
  const resolved = normalizeSeparators(raw === '' ? probeDir : raw)
  rememberRoot(probeDir, resolved)
  /* Also key the RESOLVED root, so the next call from the panel (which sends
     repoRoot) hits the cache instead of spawning git again. */
  if (declared === null) rememberRoot(resolved, resolved)
  return resolved
}

function notARepoError() {
  return new PanelError('not-a-repo', 'not a git repository', 400)
}

function normalizeSeparators(value) {
  return value.split('\\').join('/')
}

/**
 * Canonical absolute path.
 *
 * `realpathSync.native` goes through a file handle and therefore expands 8.3
 * short names (`C:\Users\RUNNER~1\...`, which is what GitHub's Windows runners
 * hand out as TMP) and subst/symlinked drives. The portable `realpathSync` only
 * resolves links and leaves a short name alone — exactly the case that made the
 * workspace scan return an empty list on CI.
 */
function canonicalPathSync(value) {
  const native = typeof realpathSync.native === 'function' ? realpathSync.native : realpathSync
  try {
    return normalizeSeparators(native(value))
  } catch {
    return normalizeSeparators(path.resolve(value))
  }
}

/**
 * Compare two paths as the filesystem sees them.
 *
 * `git rev-parse --show-toplevel` always answers with the canonical long form,
 * while Node can be handed an 8.3 short path. Comparing the two as plain
 * strings reports "not a repository" for the very same directory, so every
 * git-output-vs-filesystem comparison goes through canonicalPathSync first.
 */
function samePath(a, b) {
  const left = canonicalPathSync(a)
  const right = canonicalPathSync(b)
  const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin'
  return caseInsensitive ? left.toLowerCase() === right.toLowerCase() : left === right
}

function isInside(root, target) {
  const a = root.toLowerCase().replace(/\/+$/, '')
  const b = target.toLowerCase().replace(/\/+$/, '')
  return b === a || b.startsWith(a + '/')
}

async function realOf(dir) {
  try {
    return normalizeSeparators(realpathSync(dir))
  } catch {
    return normalizeSeparators(path.resolve(dir))
  }
}

/* ============================== workspace browsing ============================== */

/* Directory names that never hold a repository worth listing: they are either
   VCS internals, dependency caches, or build output. Skipping them is what keeps
   a scan of a big workspace bounded. */
const SCAN_SKIP_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'bower_components', 'vendor',
  'dist', 'build', 'out', 'target', 'bin', 'obj', '.venv', 'venv',
  '__pycache__', '.next', '.nuxt', '.cache', '.gradle', '.idea', '.vs',
])

const SCAN_MAX_DEPTH = 6
const SCAN_MAX_ENTRIES = 4000
const SCAN_MAX_RESULTS = 200

/**
 * Is `dir` the top of a repository? A `.git` entry (file OR directory — a
 * worktree/submodule has a `.git` FILE) marks a checkout; `rev-parse` then
 * decides whether it is the TOP of the tree or a subdirectory of a parent repo,
 * so a scan never lists the same repository twice under a nested path.
 */
async function isRepoTop(dir) {
  try {
    const stat = lstatSync(path.join(dir, '.git'))
    if (!stat.isDirectory() && !stat.isFile()) return false
  } catch {
    return false
  }
  const top = await runGit(dir, ['rev-parse', '--show-toplevel'], { timeoutMs: 10_000 })
  if (top.code !== 0) return false
  const root = normalizeSeparators(top.stdout.trim())
  return samePath(root, dir)
}

/**
 * One level of directory listing for the repo picker. Only directories are
 * returned (files cannot be a repository root), sorted, with the `hasGit`
 * marker the picker uses to highlight repositories.
 */
async function browseDir(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    throw new PanelError('browse-failed', `cannot list ${dir}: ${messageOf(error)}`, 409)
  }
  const dirs = []
  for (const entry of entries) {
    if (entry.isDirectory() !== true) continue
    if (SCAN_SKIP_DIRS.has(entry.name)) continue
    const child = path.join(dir, entry.name)
    const hasGit = await isRepoTop(child)
    dirs.push({
      name: entry.name,
      path: normalizeSeparators(child),
      isRepo: hasGit,
    })
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name))
  return dirs
}

/**
 * Depth-first scan of one workspace root for repositories. Bounded on depth,
 * visited entries and result count so a pathological tree cannot hang the
 * request; the caller renders whatever came back plus a `truncated` flag.
 */
async function scanRepos(root, options) {
  const maxDepth = options.maxDepth === undefined ? SCAN_MAX_DEPTH : Math.min(12, Math.max(1, options.maxDepth))
  const repos = []
  let visited = 0
  let truncated = false
  const walk = async (dir, depth) => {
    if (truncated) return
    if (depth > maxDepth) return
    if (visited >= SCAN_MAX_ENTRIES) { truncated = true; return }
    visited += 1
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory() !== true) continue
      if (SCAN_SKIP_DIRS.has(entry.name)) continue
      if (truncated) return
      const child = path.join(dir, entry.name)
      if (visited >= SCAN_MAX_ENTRIES) { truncated = true; return }
      if (await isRepoTop(child)) {
        const branch = await readBranch(child)
        const head = await readHead(child)
        repos.push({
          path: normalizeSeparators(child),
          name: entry.name,
          branch: branch.name,
          detached: branch.detached,
          headShort: head.short,
          relative: relativeTo(root, child),
        })
        if (repos.length >= SCAN_MAX_RESULTS) { truncated = true; return }
        // A repository root ends the descent: nested repos inside a checkout
        // (submodules) are not separate entries in this list.
        continue
      }
      await walk(child, depth + 1)
    }
  }
  await walk(root, 0)
  // The workspace root itself may be a repository.
  if (await isRepoTop(root)) {
    const branch = await readBranch(root)
    const head = await readHead(root)
    repos.unshift({
      path: normalizeSeparators(root),
      name: path.basename(root),
      branch: branch.name,
      detached: branch.detached,
      headShort: head.short,
      relative: '.',
    })
  }
  repos.sort((a, b) => (a.relative === '.' ? -1 : b.relative === '.' ? 1 : a.relative.localeCompare(b.relative)))
  return { root: normalizeSeparators(root), repos, truncated, visited }
}

/**
 * Drive roots that actually exist on this machine.
 *
 * The picker used to offer a hard-coded C:..Z:, so most entries were dead. On
 * Windows the real letters come from the mount table; elsewhere there is exactly
 * `/`.
 */
function listDriveRoots() {
  if (process.platform !== 'win32') return ['/']
  const roots = []
  /* `wmic` is gone from recent Windows; the Win32 API through `fs` is enough:
     a drive letter is mounted iff `stat` succeeds on `<letter>:\\`. */
  for (let code = 65; code <= 90; code += 1) {
    const root = String.fromCharCode(code) + ':\\'
    try {
      if (statSync(root).isDirectory() === true) roots.push(root)
    } catch {
      /* not mounted */
    }
  }
  return roots.length > 0 ? roots : ['C:\\']
}

/** Where a session-less browse starts: the first real drive root. */
function defaultBrowseRoot() {
  const roots = listDriveRoots()
  return roots.length > 0 ? roots[0] : '/'
}
/** The directory above `dir`, or null at a filesystem root. */
function parentOf(dir) {
  const parent = path.dirname(dir)
  const normalizedParent = normalizeSeparators(parent)
  const normalizedDir = normalizeSeparators(dir).replace(/\/+$/, '')
  if (normalizedParent === normalizedDir) return null
  return normalizedParent
}
function relativeTo(root, target) {
  const rel = path.relative(root, target)
  return normalizeSeparators(rel === '' ? '.' : rel)
}

/* ============================== write serialisation ============================== */

const repoQueues = new Map()

function withRepoLock(key, work) {
  const previous = repoQueues.get(key) === undefined ? Promise.resolve() : repoQueues.get(key)
  const next = previous.then(work, work)
  const settled = next.then(() => undefined, () => undefined)
  repoQueues.set(key, settled)
  settled.then(() => { if (repoQueues.get(key) === settled) repoQueues.delete(key) })
  return next
}

const WRITE_METHODS = new Set([
  'stage', 'unstage', 'discard', 'stageHunk', 'unstageHunk', 'discardHunk',
  'commit', 'amend', 'checkout', 'branchCreate', 'branchRename', 'branchDelete',
  'branchUpstream', 'branchDeleteRemote', 'merge', 'mergeAbort', 'mergeContinue', 'rebase', 'rebaseAbort', 'rebaseContinue',
  'cherryPick', 'revert', 'reset', 'fetch', 'pull', 'push', 'pushTags',
  'stashPush', 'stashApply', 'stashPop', 'stashDrop', 'stashClear',
  'tagCreate', 'tagDelete', 'tagDeleteRemote', 'tagPush', 'tagReset', 'remoteAdd', 'remoteRemove',
  'conflictResolve', 'cleanUntracked', 'ignore', 'init',
])

function lockKeyOf(payload) {
  if (typeof payload.repoRoot === 'string' && payload.repoRoot !== '') return payload.repoRoot
  if (typeof payload.cwd === 'string' && payload.cwd !== '') return payload.cwd
  return 'global'
}

/* ============================== status parsing ============================== */

/**
 * Parse `git status --porcelain=v2 --branch -z`.
 *
 * This ONE call carries the whole panel header as well as the file list, which
 * is what removed six git spawns from every refresh:
 *
 *   # branch.oid <oid>|(initial)        HEAD commit, or "unborn"
 *   # branch.head <name>|(detached)     branch name, or a detached HEAD
 *   # branch.upstream <remote/branch>   only when an upstream is configured
 *   # branch.ab +<ahead> -<behind>      only when an upstream is configured
 *
 *   1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>               ordinary change
 *   2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>    rename/copy; the
 *                                                              ORIGINAL path is
 *                                                              the next -z field
 *   u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>     unmerged (conflict)
 *   ? <path>                                                   untracked
 *
 * v2 writes `.` for a clean column where v1 wrote a space; it is folded back to
 * a space so every consumer keeps seeing the same alphabet as before.
 */
function parseStatusV2(raw) {
  const entries = []
  const branch = { oid: null, unborn: false, name: '', detached: false, upstream: null, ahead: 0, behind: 0 }
  const parts = raw.split('\u0000')
  for (let i = 0; i < parts.length; i += 1) {
    const record = parts[i]
    if (record === undefined || record === '') continue
    if (record.startsWith('# ')) {
      parseBranchHeader(branch, record.slice(2))
      continue
    }
    const kind = record[0]
    if (kind === '1' || kind === '2') {
      const pathAt = fieldStart(record, kind === '1' ? 8 : 9)
      if (pathAt === -1) continue
      let origin
      if (kind === '2') {
        i += 1
        origin = parts[i]
      }
      entries.push(statusEntry(record.slice(2, 4), record.slice(pathAt), origin, false))
      continue
    }
    if (kind === 'u') {
      const pathAt = fieldStart(record, 10)
      if (pathAt === -1) continue
      entries.push(statusEntry(record.slice(2, 4), record.slice(pathAt), undefined, true))
      continue
    }
    if (kind === '?') entries.push(statusEntry('??', record.slice(2), undefined, false))
  }
  return { entries, branch }
}

/** Offset at which the field after `spaces` space-separated tokens starts. */
function fieldStart(record, spaces) {
  let at = 0
  for (let n = 0; n < spaces; n += 1) {
    const space = record.indexOf(' ', at)
    if (space === -1) return -1
    at = space + 1
  }
  return at
}

function parseBranchHeader(branch, header) {
  if (header.startsWith('branch.oid ')) {
    const oid = header.slice('branch.oid '.length).trim()
    if (oid === '(initial)') branch.unborn = true
    else branch.oid = oid
    return
  }
  if (header.startsWith('branch.head ')) {
    const head = header.slice('branch.head '.length).trim()
    if (head === '(detached)') branch.detached = true
    else branch.name = head
    return
  }
  if (header.startsWith('branch.upstream ')) {
    branch.upstream = header.slice('branch.upstream '.length).trim()
    return
  }
  if (header.startsWith('branch.ab ')) {
    const counts = /^\+(\d+)\s+-(\d+)$/.exec(header.slice('branch.ab '.length).trim())
    if (counts !== null) {
      branch.ahead = Number(counts[1])
      branch.behind = Number(counts[2])
    }
  }
}

/**
 * One path entry in the SAME shape the v1 parser produced: both status columns,
 * the staged/untracked/conflicted flags, and the original path of a rename.
 */
function statusEntry(xy, filePath, origin, unmerged) {
  const x = xy[0] === '.' ? ' ' : xy[0]
  const y = xy[1] === '.' ? ' ' : xy[1]
  return {
    path: normalizeSeparators(filePath),
    origin: origin === undefined ? undefined : normalizeSeparators(origin),
    index: x,
    worktree: y,
    staged: x !== ' ' && x !== '?',
    untracked: x === '?' && y === '?',
    conflicted: unmerged || (x === 'A' && y === 'A') || (x === 'D' && y === 'D'),
  }
}

function classifyEntry(entry) {
  if (entry.conflicted) return 'conflicted'
  if (entry.untracked) return 'untracked'
  const code = entry.staged && !entry.worktreeIsModified ? entry.index : (entry.worktree !== ' ' ? entry.worktree : entry.index)
  if (code === 'A') return 'added'
  if (code === 'D') return 'deleted'
  if (code === 'R') return 'renamed'
  if (code === 'C') return 'copied'
  if (code === 'T') return 'typechange'
  return 'modified'
}

/* ============================== reads ============================== */

/* These two survive for the callers that genuinely need one field at a time: the
   workspace scan (describing repos it does not snapshot) and the two index-reset
   paths (`unstage`, `discard` on an unborn HEAD). The snapshot itself gets
   head/branch/upstream from its single `status` call instead of spawning twice. */

async function readHead(cwd) {
  const head = await runGit(cwd, ['rev-parse', 'HEAD'], { timeoutMs: 15_000 })
  if (head.code !== 0) return { hash: null, short: null, unborn: true }
  const hash = head.stdout.trim()
  return { hash, short: hash.slice(0, 7), unborn: false }
}

async function readBranch(cwd) {
  const symbolic = await runGit(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { timeoutMs: 15_000 })
  if (symbolic.code === 0 && symbolic.stdout.trim() !== '') {
    return { name: symbolic.stdout.trim(), detached: false }
  }
  const short = await runGit(cwd, ['rev-parse', '--short', 'HEAD'], { timeoutMs: 15_000 })
  return { name: short.code === 0 ? short.stdout.trim() : '', detached: true }
}

/**
 * Resolve the real Git directory from the working tree, WITHOUT a spawn.
 *
 * A plain repository has a `.git` directory; a linked worktree, a submodule or a
 * `--separate-git-dir` checkout has a `.git` FILE holding `gitdir: <path>`
 * (a relative path is relative to the working tree root). `display` is what
 * `git rev-parse --git-dir` used to print — `.git` for a plain repository — so
 * the snapshot JSON is unchanged.
 */
function gitDirOf(root) {
  const dotGit = path.join(root, '.git')
  let stats
  try {
    stats = lstatSync(dotGit)
  } catch {
    return { dir: null, display: null }
  }
  if (stats.isDirectory()) return { dir: dotGit, display: '.git' }
  let text = ''
  try {
    text = readFileSync(dotGit, 'utf8')
  } catch {
    return { dir: null, display: null }
  }
  const match = /^\s*gitdir:\s*(.+?)\s*$/m.exec(text)
  if (match === null) return { dir: null, display: null }
  const raw = match[1]
  return {
    dir: path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(root, raw),
    display: raw,
  }
}

/** The in-progress operation, from the marker files in the git dir (no spawn). */
function operationOf(gitDir) {
  if (gitDir === null) return null
  const has = (name) => existsSync(path.join(gitDir, name))
  if (has('MERGE_HEAD')) return 'merge'
  if (has('rebase-merge') || has('rebase-apply')) return 'rebase'
  if (has('CHERRY_PICK_HEAD')) return 'cherry-pick'
  if (has('REVERT_HEAD')) return 'revert'
  return null
}

/**
 * The configured remote names, in git's own order.
 *
 * Parsed from one `git remote` spawn. An empty list means the repository is
 * purely local, which `fetch` must report as such rather than as a failure.
 */
async function remoteNamesOf(root) {
  const res = await runGit(root, ['remote'], { timeoutMs: 15_000 })
  if (res.code !== 0) return []
  return res.stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '')
}

/* ============================== tags on the remote ============================== */

/**
 * Does `remote` already carry `name`?
 *
 * Tags are NOT folded into `refs/remotes/<remote>/` the way branches are: a
 * `git fetch` writes them straight into `refs/tags/`, which makes a local-only
 * tag and a published one indistinguishable from local refs alone. The only
 * authoritative answer is `ls-remote`, so this always costs one network round
 * trip — callers must not put it on a poll.
 */
async function tagOnRemote(root, remote, name) {
  const res = await runGit(root, ['ls-remote', '--tags', '--refs', '--end-of-options', remote, `refs/tags/${name}`], {
    timeoutMs: hostConfig.networkTimeoutMs,
  })
  if (res.code !== 0) {
    throw new PanelError('tag-ls-remote-failed', (res.stderr + res.stdout).trim() || 'git ls-remote failed', 409)
  }
  return res.stdout.trim() !== ''
}

/**
 * One snapshot of a repository, with EXACTLY THREE git processes:
 *
 *   1. `status --porcelain=v2 --branch`  head/branch/upstream/ahead-behind,
 *      the per-path status columns and the conflicted (`u`) records;
 *   2. `diff --cached --numstat`         staged per-file added/deleted counts;
 *   3. `diff --numstat`                  unstaged per-file added/deleted counts.
 *
 * Everything else (git dir, in-progress operation) is read from disk. The two
 * numstat calls stay because a status record does not carry line counts.
 *
 * This is the UNCACHED read: mutations return it so the panel always sees its
 * own writes. The poll goes through `readSnapshotOf` below.
 */
async function snapshotOf(root) {
  const [statusRaw, stagedNumstat, worktreeNumstat] = await Promise.all([
        /* --untracked-files=all, NOT normal: `normal` collapses a brand-new directory
           into ONE row, so the files inside it never appeared in 变更 and could not
           be staged individually. The cost is real - a build that leaves thousands
           of untracked files makes this walk slower - but a changes list that hides
           new work is worse than one that takes a moment. --no-renames still skips
           similarity hashing. */
    runGit(root, [
      '--no-optional-locks', '-c', 'core.fsmonitor=false', 'status', '--porcelain=v2',
      '--branch', '-z', '--untracked-files=all', '--no-renames',
      '--ignore-submodules=dirty',
    ], { timeoutMs: 30_000 }),
    runGit(root, ['diff', '--cached', '--numstat', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-color'], { timeoutMs: 30_000 }),
    runGit(root, ['diff', '--numstat', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-color'], { timeoutMs: 30_000 }),
  ])
  if (statusRaw.code !== 0) {
    throw new PanelError('status-failed', statusRaw.stderr.trim() || 'git status failed', 409)
  }
  const { entries: rawEntries, branch } = parseStatusV2(statusRaw.stdout)
  const stagedCounts = parseNumstat(stagedNumstat.stdout)
  const worktreeCounts = parseNumstat(worktreeNumstat.stdout)
  const changes = rawEntries.map((entry) => {
    const kind = classifyEntry({ ...entry, worktreeIsModified: entry.worktree !== ' ' })
    const staged = stagedCounts.get(entry.path)
    const unstaged = worktreeCounts.get(entry.path)
    return {
      path: entry.path,
      origin: entry.origin,
      index: entry.index,
      worktree: entry.worktree,
      staged: entry.staged,
      untracked: entry.untracked,
      conflicted: entry.conflicted,
      kind,
      added: staged === undefined ? 0 : staged.added,
      deleted: staged === undefined ? 0 : staged.deleted,
      unstagedAdded: unstaged === undefined ? 0 : unstaged.added,
      unstagedDeleted: unstaged === undefined ? 0 : unstaged.deleted,
    }
  })
  const gitDir = gitDirOf(root)
  /* A detached HEAD has no branch name, so the panel shows the short oid — the
     same string `git rev-parse --short HEAD` used to supply. */
  const headShort = branch.oid === null ? null : branch.oid.slice(0, 7)
  return {
    root,
    head: branch.oid,
    headShort,
    unborn: branch.unborn,
    branch: branch.detached ? (headShort === null ? '' : headShort) : branch.name,
    detached: branch.detached,
    upstream: branch.upstream,
    ahead: branch.ahead,
    behind: branch.behind,
    changes,
    operation: operationOf(gitDir.dir),
    conflictedFiles: rawEntries.filter((entry) => entry.conflicted).map((entry) => entry.path),
    gitDir: gitDir.display,
    refreshIntervalMs: hostConfig.refreshIntervalMs,
    defaultDiffView: hostConfig.defaultDiffView,
    truncated: statusRaw.truncated,
  }
}

/* ============================== diff cache ============================== */

/*
 * A git diff / git show spawn costs ~400 ms on a cold Windows profile, and
 * the pane asks for patches constantly: re-selecting a file, switching tabs,
 * reopening the drawer, walking a commit's file list. Commit patches are
 * immutable; working-tree ones are keyed by the watcher revision, so a change
 * simply makes the old entry unreachable — no invalidation step to forget.
 */
const DIFF_CACHE_LIMIT = 32
/* Hard ceiling on the patch text this cache may hold, regardless of count. The
   pane never needs more than the handful of patches it just showed, and a
   session walking big commit patches must not grow the host process unbounded. */
const DIFF_CACHE_MAX_BYTES = 32 * 1024 * 1024
const COMMIT_DIFF_TTL_MS = 5 * 60 * 1000
const WORKTREE_DIFF_TTL_MS = 8000
const diffCache = new Map()
const diffInflight = new Map()
/* Commit metadata is immutable: the hash IS its content. Re-selecting a commit
   used to spawn two `git show` processes every time (the source-control page
   fetches detail on every click), so cache the small result and share an
   in-flight request between a hover prefetch and the click. */
const COMMIT_DETAIL_CACHE_LIMIT = 200
const commitDetailCache = new Map()
const commitDetailInflight = new Map()
/* Running total of the patch text held above; kept in step by rememberDiff /
   removeDiffEntry / invalidateDiffs. */
let diffCacheBytes = 0
let diffCacheMaxBytes = DIFF_CACHE_MAX_BYTES
let diffCacheMaxEntriesOverride = 0

function diffCacheKey(root, base, rev, filePath, context) {
  if (base === 'commit') return 'commit:' + rev + '\u0000' + root + '\u0000' + (filePath === null ? '' : filePath) + '\u0000' + context
  /* Working-tree patches depend on the INDEX and on the file itself. Both are
     cheap stat() calls, so "the user edited the file and re-selected it" never
     serves a stale patch even when no watcher is running. */
  let stamp = 'rev:' + watcherRevisionOf(root)
  try {
    const gitDir = gitDirOf(root)
    if (gitDir.dir !== '') stamp += '|idx:' + statSync(path.join(gitDir.dir, 'index')).mtimeMs
  } catch (error) { void error }
  if (filePath !== null && filePath !== '') {
    try {
      const stat = statSync(path.join(root, filePath))
      stamp += '|f:' + stat.mtimeMs + ':' + stat.size
    } catch (error) { void error }
  }
  return stamp + '\u0000' + root + '\u0000' + base + '\u0000' + (filePath === null ? '' : filePath) + '\u0000' + context
}

function readDiffCache(key, ttlMs) {
  const hit = diffCache.get(key)
  if (hit === undefined) return null
  if (Date.now() - hit.at > ttlMs) {
    diffCache.delete(key)
    return null
  }
  /* LRU touch. */
  diffCache.delete(key)
  diffCache.set(key, hit)
  return hit.value
}

function rememberDiff(key, value) {
  const weight = diffWeightOf(value)
  if (diffCache.has(key)) removeDiffEntry(key)
  diffCache.set(key, { at: Date.now(), value, weight })
  diffCacheBytes += weight
  /* Two ceilings: entry count (many tiny patches) and total size (a few huge
     ones). The size budget is a hard cap on what this cache can hold, so a
     session that walks enormous commit patches cannot grow without bound. */
  const maxEntries = diffCacheMaxEntriesOverride > 0 ? diffCacheMaxEntriesOverride : DIFF_CACHE_LIMIT
  while (diffCache.size > 1 && (diffCache.size > maxEntries || diffCacheBytes > diffCacheMaxBytes)) {
    const oldest = diffCache.keys().next()
    if (oldest.done === true) break
    removeDiffEntry(oldest.value)
  }
}

/* V8 stores JS strings as 1–2 bytes per char; counting 2 bytes per code unit is a
   safe upper bound for the budget without measuring every patch twice. */
function diffWeightOf(value) {
  const patch = value !== null && value !== undefined && typeof value.patch === 'string' ? value.patch : ''
  return patch.length * 2
}

function removeDiffEntry(key) {
  const entry = diffCache.get(key)
  if (entry === undefined) return
  diffCache.delete(key)
  diffCacheBytes -= entry.weight
  if (diffCacheBytes < 0) diffCacheBytes = 0
}

function invalidateDiffs() {
  diffCache.clear()
  diffCacheBytes = 0
}

/** Diagnostics for tests: what the cache currently holds. */
function diffCacheStats() {
  return { entries: diffCache.size, bytes: diffCacheBytes, maxBytes: diffCacheMaxBytes, maxEntries: DIFF_CACHE_LIMIT }
}

/** Test-only knob so the byte ceiling can be exercised without 32 MB of files. */
function setDiffCacheBudget(bytes, entries) {
  if (Number.isFinite(bytes) && bytes >= 0) diffCacheMaxBytes = bytes
  if (Number.isFinite(entries) && entries >= 1) diffCacheMaxEntriesOverride = Math.floor(entries)
}
/* ============================== snapshot cache ============================== */

/* The panel polls on a timer AND asks for a snapshot after its own actions, so a
   burst of read-only requests must cost one git round-trip, not one per caller.
   A read is reused for SNAPSHOT_TTL_MS, and concurrent reads share the in-flight
   call. Writes never go through here (they call `snapshotOf` directly) and they
   drop the cache when they finish, so a mutation is never reported stale. */
const SNAPSHOT_TTL_MS = 400
const SNAPSHOT_REVISION_TTL_MS = 5000
/* One retained snapshot per repository viewed: the panel only ever watches one
   at a time, and this keeps a long session from holding every repository's
   file list in memory. */
const SNAPSHOT_CACHE_LIMIT = 8
const snapshotCache = new Map()

function invalidateSnapshots() {
  snapshotCache.clear()
}

function rememberSnapshot(root, entry) {
  if (snapshotCache.size >= SNAPSHOT_CACHE_LIMIT && snapshotCache.has(root) === false) {
    const oldest = snapshotCache.keys().next()
    if (oldest.done !== true) snapshotCache.delete(oldest.value)
  }
  snapshotCache.set(root, entry)
}

function readSnapshotOf(root) {
  const cached = snapshotCache.get(root)
  if (cached !== undefined) {
    if (cached.pending !== undefined) return cached.pending
    if (Date.now() - cached.at < SNAPSHOT_TTL_MS) return Promise.resolve(cached.value)
    /* The watcher already told us whether anything changed: if its revision is
       the one this snapshot was taken at, the answer is still current and a
       second git round-trip (~400 ms per spawn on Windows) buys nothing. */
    if (cached.value !== null && cached.revision === watcherRevisionOf(root)
      && Date.now() - cached.at < SNAPSHOT_REVISION_TTL_MS) return Promise.resolve(cached.value)
  }
  const entry = { at: 0, value: null, pending: undefined, revision: 0 }
  rememberSnapshot(root, entry)
  /* Identity-checked when settling: a write may have replaced or dropped this
     entry meanwhile, and a stale result must not be cached. */
  entry.pending = snapshotOf(root).then((value) => {
    if (snapshotCache.get(root) === entry) {
      entry.at = Date.now()
      entry.value = value
      entry.revision = watcherRevisionOf(root)
      entry.pending = undefined
    }
    return value
  }, (error) => {
    if (snapshotCache.get(root) === entry) snapshotCache.delete(root)
    throw error
  })
  return entry.pending
}

function parseNumstat(raw) {
  const map = new Map()
  for (const record of raw.split('\u0000')) {
    if (record === '') continue
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(record)
    if (match === null) continue
    const added = match[1] === '-' ? 0 : Number(match[1])
    const deleted = match[2] === '-' ? 0 : Number(match[2])
    const filePath = normalizeSeparators(match[3])
    map.set(filePath, { added, deleted })
  }
  return map
}

/**
 * Read every ref (local branches, remote branches, tags) in ONE `for-each-ref`.
 *
 * Split out of the `branches` method so the result can be cached: switching to
 * the Branches tab used to pay a full git spawn every time even when nothing
 * had changed.
 */
async function branchesOf(root) {
  const format = ['%(refname)', '%(refname:short)', '%(objectname)', '%(committerdate:unix)', '%(HEAD)', '%(upstream:short)', '%(upstream:track,nobracket)', '%(subject)'].join('%1f')
  const res = await runGit(root, [
    'for-each-ref', '--format=' + format + '%1e',
    'refs/heads', 'refs/remotes', 'refs/tags',
  ], { timeoutMs: 30_000 })
  if (res.code !== 0) throw new PanelError('branch-failed', res.stderr.trim() || 'for-each-ref failed', 409)
  const list = []
  for (const record of res.stdout.split('\u001e')) {
    const trimmed = record.replace(/^\n/, '')
    if (trimmed.trim() === '') continue
    const fields = trimmed.split('\u001f')
    if (fields.length < 8) continue
    const fullName = fields[0]
    let kind = 'local'
    if (fullName.startsWith('refs/remotes/')) kind = 'remote'
    else if (fullName.startsWith('refs/tags/')) kind = 'tag'
    const tracking = fields[6]
    const aheadMatch = /ahead (\d+)/.exec(tracking)
    const behindMatch = /behind (\d+)/.exec(tracking)
    list.push({
      refName: fullName,
      name: fields[1],
      hash: fields[2],
      short: fields[2].slice(0, 7),
      time: Number(fields[3]) * 1000 || 0,
      head: fields[4] === '*',
      upstream: fields[5] === '' ? null : fields[5],
      ahead: aheadMatch === null ? 0 : Number(aheadMatch[1]),
      behind: behindMatch === null ? 0 : Number(behindMatch[1]),
      subject: fields[7],
      kind,
    })
  }
  list.sort((a, b) => {
    if (a.head !== b.head) return a.head ? -1 : 1
    if (a.kind !== b.kind) return a.kind === 'local' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return { branches: list }
}

async function logOf(root, options) {
  const limit = Math.min(400, Math.max(1, Number(options.limit) || 60))
  const skip = Math.max(0, Number(options.skip) || 0)
  const ref = typeof options.ref === 'string' && options.ref.trim() !== '' ? requireRef(options.ref, 'ref') : null
  const search = typeof options.search === 'string' ? options.search.trim() : ''
  const author = typeof options.author === 'string' ? options.author.trim() : ''
  const filePath = typeof options.path === 'string' && options.path.trim() !== '' ? options.path.trim() : ''
  const format = ['%H', '%h', '%an', '%ae', '%at', '%P', '%s', '%D'].join('%x1f')
  const args = ['log', '--topo-order', '--date-order', `--pretty=format:${format}%x1e`, `--max-count=${limit}`, `--skip=${skip}`]
  if (search !== '') args.push(`--grep=${search}`, '-i')
  if (author !== '') args.push(`--author=${author}`)
  if (search !== '' || author !== '') args.push('--regexp-ignore-case')
  // The revision range must precede `--`: everything after it is a pathspec,
  // and `--follow` refuses to run with more than one.
  /**
   * `--all` includes `refs/stash`, so the history list used to be polluted with
   * synthetic commits ("index on main: …", "WIP on main: …") that belong to no
   * branch. They are not history — every git UI lists stashes in their own panel,
   * and mine does too. Exclude the stash ref while keeping other branches.
   */
  if (ref !== null) args.push(ref)
  else { args.push('--exclude=refs/stash', '--all') }
  if (filePath !== '') args.push('--follow', '--', filePath)
  const res = await runGit(root, args, { timeoutMs: 60_000 })
  if (res.code !== 0) {
    // An unborn HEAD with --all can still fail on an empty repository: report
    // that as an empty history rather than an error.
    if (/your current branch .* does not have any commits yet|does not have any commits yet/i.test(res.stderr)) {
      return { commits: [], hasMore: false }
    }
    throw new PanelError('log-failed', res.stderr.trim() || 'git log failed', 409)
  }
  const commits = []
  for (const record of res.stdout.split('\u001e')) {
    const trimmed = record.replace(/^\n/, '')
    if (trimmed.trim() === '') continue
    const fields = trimmed.split('\u001f')
    if (fields.length < 7) continue
    commits.push({
      hash: fields[0],
      short: fields[1],
      authorName: fields[2],
      authorEmail: fields[3],
      authorTime: Number(fields[4]) * 1000 || 0,
      parents: fields[5] === '' ? [] : fields[5].split(' ').filter((entry) => entry !== ''),
      subject: fields[6],
      refs: (fields[7] === undefined ? '' : fields[7])
        .split(',')
        .map((entry) => entry.trim().replace(/^HEAD -> /, ''))
        .filter((entry) => entry !== '' && entry !== 'HEAD'),
    })
  }
  return { commits, hasMore: commits.length === limit }
}

/**
 * Parse the `%x1e`-separated pretty format used by the commit lists.
 *
 * One record is `<H>\x1f<h>\x1f<author>\x1f<email>\x1f<at>\x1f<parents>\x1f<subject>\x1f<refs>`.
 */
function parseLogCommits(stdout) {
  const commits = []
  for (const record of stdout.split('\u001e')) {
    const trimmed = record.replace(/^\n+/, '')
    if (trimmed.trim() === '') continue
    const fields = trimmed.split('\u001f')
    if (fields.length < 7) continue
    commits.push({
      hash: fields[0],
      short: fields[1],
      authorName: fields[2],
      authorEmail: fields[3],
      authorTime: Number(fields[4]) * 1000 || 0,
      parents: fields[5] === '' ? [] : fields[5].split(' ').filter((entry) => entry !== ''),
      subject: fields[6],
      refs: (fields[7] === undefined ? '' : fields[7])
        .split(',')
        .map((entry) => entry.trim().replace(/^HEAD -> /, ''))
        .filter((entry) => entry !== '' && entry !== 'HEAD'),
      added: 0,
      deleted: 0,
      binary: false,
    })
  }
  return commits
}

/**
 * Turn a `%B` commit message into just its BODY (everything after the subject).
 *
 * `%B` is the full raw message, so it carries three things this API does not
 * want to hand the UI as "body":
 *
 *   1. the `%x1e` record separator the caller appended to the format;
 *   2. the subject line itself (already returned separately);
 *   3. surrounding newlines.
 *
 * A commit with no body must yield '' — not its subject — or every subject-only
 * commit would render its title a second time.
 */
function cleanCommitBody(raw, subject) {
  if (typeof raw !== 'string' || raw === '') return ''
  let text = raw.replace(/\u001e+$/, '').replace(/\s+$/, '')
  if (typeof subject === 'string' && subject !== '') {
    if (text === subject) return ''
    if (text.startsWith(subject)) text = text.slice(subject.length).replace(/^[\r\n]+/, '')
  }
  return text.trim()
}

/**
 * Every name the file has had, derived from the numstat output itself.
 *
 * The blocks are newest-first (that is how `git log` walks), so following a
 * `new => old` rename BACKWARDS from the current path finds each earlier name.
 * Repeating over the whole page handles a file renamed several times.
 *
 *   block:  2\t1\tsrc/main.c
 *   block:  0\t0\tsrc/{old.c => main.c}      -> previous name was src/old.c
 *
 * `--follow` guarantees a rename appears exactly once per file, so a single
 * pass is enough; a final safety loop covers the (impossible in practice) case
 * of a chain that needs more than one sweep.
 */
function pathsOfFileInHistory(numstatStdout, currentPath) {
  const accepted = new Set([normalizeSeparators(currentPath)])
  /* Collect (newName, oldName) pairs in output order (newest first). */
  const renames = []
  for (const line of numstatStdout.split('\n')) {
    const match = /^(?:\d+|-)\t(?:\d+|-)\t(.+)$/.exec(line)
    if (match === null) continue
    const raw = match[1].trim()
    if (!raw.includes('=>')) continue
    renames.push(raw)
  }
  /* Walk backwards: whenever a pair's NEW side is already known, adopt its OLD
     side too. Repeat until nothing new is learned. */
  for (let pass = 0; pass < renames.length + 1; pass += 1) {
    let learned = false
    for (const raw of renames) {
      for (const pair of expandRename(raw)) {
        if (accepted.has(pair.next) && !accepted.has(pair.previous)) {
          accepted.add(pair.previous)
          learned = true
        }
        /* A reverse-ordered record (some git versions print old first). */
        if (accepted.has(pair.previous) && !accepted.has(pair.next)) {
          accepted.add(pair.next)
          learned = true
        }
      }
    }
    if (!learned) break
  }
  return accepted
}

/**
 * Expand one rename row into edge pairs, handling both forms git prints:
 *
 *   `old.txt => new.txt`              simple rename
 *   `dir/{a.txt => b.txt}/keep`       brace form: only the inner part moved
 *
 * The brace form is why a naive `split('=>')` produced paths that matched
 * nothing: it yields `dir/{a.txt` and `b.txt}/keep`, neither of which is a real
 * path. Rebuilding the two full paths is required.
 */
function expandRename(raw) {
  const clean = raw.trim()
  const brace = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(clean)
  if (brace !== null) {
    const [, prefix, left, right, suffix] = brace
    return [{
      previous: normalizeSeparators((prefix + left + suffix).replace(/\/{2,}/g, '/')),
      next: normalizeSeparators((prefix + right + suffix).replace(/\/{2,}/g, '/')),
    }]
  }
  const simple = clean.split('=>')
  if (simple.length !== 2) return []
  return [{
    previous: normalizeSeparators(simple[0].trim()),
    next: normalizeSeparators(simple[1].trim()),
  }]
}

/**
 * Fold `git log --numstat --format=%H` output into already-parsed commits,
 * counting ONLY the file the caller asked about.
 *
 * Blocks look like:
 *
 *   <hash>
 *   <added>\t<deleted>\t<path>
 *   <added>\t<deleted>\t<old> => <new>     (a rename, possibly `dir/{a => b}/f`)
 *
 * WHY THE PATH FILTER IS BACK (and why it is different this time):
 * A first version summed the WHOLE block, because `--follow` had already chosen
 * the commits and "the block is this commit's change to this file". That is
 * wrong whenever a commit touches more than one file: a commit that edited a
 * source file AND added a font/image reported `binary` for the SOURCE file,
 * since a binary sibling contributes `-\t-`. That is exactly the "为什么记录中
 * 显示二进制文件" report — the source file clearly had line changes.
 *
 * The earlier attempt at filtering failed for a different reason: it compared
 * against the caller's CURRENT path, so pre-rename commits (which name the OLD
 * path) were dropped. The fix is to match the file's path AS IT WAS in each
 * block — i.e. accept both sides of a `old => new` pair — which `applyNumstat`
 * gets from the `appliedPaths` set the caller accumulates while walking history.
 */
function applyNumstat(commits, stdout, acceptedPaths) {
  const byHash = new Map(commits.map((commit) => [commit.hash, commit]))
  const wanted = acceptedPaths instanceof Set ? acceptedPaths : null
  const matches = (rawPath) => {
    if (wanted === null) return true
    const raw = rawPath.trim()
    if (!raw.includes('=>')) return wanted.has(normalizeSeparators(raw))
    /* Both sides of a rename are valid names for this file at different points
       in its life; either one being accepted means this row is about our file. */
    return expandRename(raw).some((pair) => wanted.has(pair.previous) || wanted.has(pair.next))
  }
  let current = null
  for (const line of stdout.split('\n')) {
    if (line === '') continue
    /* A bare 40-hex line starts a commit block. */
    if (/^[0-9a-f]{40}$/.test(line.trim())) {
      current = byHash.get(line.trim()) ?? null
      continue
    }
    if (current === null) continue
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line)
    if (match === null) continue
    if (!matches(match[3])) continue
    if (match[1] === '-' || match[2] === '-') { current.binary = true; continue }
    current.added += Number(match[1])
    current.deleted += Number(match[2])
  }
}

/* ============================== hunks ============================== */

/**
 * Split a unified diff into hunks. Only the @@ header + body lines are kept;
 * file headers stay in the diff string for context but are never sent to
 * `git apply` alone (a partial hunk needs them, which is why the caller keeps
 * `header` and re-emits it per patch).
 */
function splitDiff(diffText) {
  const lines = diffText.split('\n')
  const headerLines = []
  let index = 0
  while (index < lines.length && !lines[index].startsWith('@@')) {
    headerLines.push(lines[index])
    index += 1
  }
  const header = headerLines.join('\n')
  const hunks = []
  let current = null
  for (; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.startsWith('@@')) {
      if (current !== null) hunks.push(current)
      current = { header: line, lines: [], index: hunks.length }
      continue
    }
    if (current === null) continue
    current.lines.push(line)
  }
  if (current !== null) hunks.push(current)
  // Drop the trailing empty line `split('\n')` produces, per hunk, and count
  // additions/deletions for the UI.
  return hunks.map((hunk) => {
    const body = hunk.lines.slice()
    while (body.length > 0 && body[body.length - 1] === '') body.pop()
    let added = 0
    let deleted = 0
    for (const line of body) {
      if (line.startsWith('+')) added += 1
      else if (line.startsWith('-')) deleted += 1
    }
    return {
      index: hunk.index,
      header: hunk.header,
      body: body.join('\n'),
      added,
      deleted,
      patch: [hunk.header, body.join('\n')].join('\n') + '\n',
    }
  })
}

function countHunkLines(headerLine) {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(headerLine)
  if (match === null) return null
  return {
    oldStart: Number(match[1]),
    oldCount: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newCount: match[4] === undefined ? 1 : Number(match[4]),
  }
}

/**
 * Build the patch that stages ONLY the selected line numbers of one hunk.
 *
 * `selectedLines` are 0-based indexes into the hunk BODY array (context lines
 * included), which is exactly what the client's diff view hands back.
 *
 * For every unselected `+` line the patch drops the addition (the line is
 * absent from both sides, so it stays in the worktree as unstaged). For every
 * unselected `-` line the patch keeps the removal OUT of the patch by turning
 * it into a context line — which requires the old and new line counters to
 * grow accordingly.
 */
function buildLineSelectionPatch(filePath, header, hunkBody, selectedLines) {
  const counts = countHunkLines(header)
  if (counts === null) return null
  const selected = new Set(selectedLines.map(Number).filter((n) => Number.isInteger(n) && n >= 0))
  const bodyLines = hunkBody.split('\n').filter((line) => line !== '')
  const out = []
  let oldCount = 0
  let newCount = 0
  for (let i = 0; i < bodyLines.length; i += 1) {
    const line = bodyLines[i]
    const marker = line[0]
    const isSelected = selected.has(i)
    if (marker === ' ') {
      out.push(line)
      oldCount += 1
      newCount += 1
      continue
    }
    if (marker === '+') {
      if (isSelected) {
        out.push(line)
        newCount += 1
      }
      continue
    }
    if (marker === '-') {
      if (isSelected) {
        out.push(line)
        oldCount += 1
      } else {
        // Turn the removal into context: the old line survives in the index,
        // so it must also be present on the new side.
        out.push(' ' + line.slice(1))
        oldCount += 1
        newCount += 1
      }
      continue
    }
    if (marker === '\\') out.push(line)
  }
  if (out.length === 0) return null
  if (selected.size === 0) return null
  const newHeader = `@@ -${counts.oldStart},${oldCount} +${counts.newStart},${newCount} @@`
  return [
    `diff --git a/${filePath} b/${filePath}`,
    '--- a/' + filePath,
    '+++ b/' + filePath,
    newHeader,
    out.join('\n'),
    '',
  ].join('\n')
}

async function applyPatchToIndex(root, patchText, options = {}) {
  const args = ['apply', '--cached', '--whitespace=nowarn']
  if (options.reverse === true) args.push('--reverse')
  const result = await runGitWithInput(root, args, patchText)
  if (result.code !== 0) {
    if (process.env.DSH_GITCRAFT_DEBUG === '1') {
      console.error('[dsh-gitcraft] patch rejected:\n' + JSON.stringify(patchText))
      console.error('[dsh-gitcraft] stderr: ' + result.stderr)
    }
    throw new PanelError('patch-failed', result.stderr.trim() || result.stdout.trim() || 'git apply failed', 409)
  }
}

/* ============================== methods ============================== */

/**
 * One watcher per repository root.
 *
 * `persistent: false` so a watcher can never keep the process alive; it is closed
 * again after WATCH_IDLE_MS with no poll, so browsing many repositories does not
 * accumulate handles.
 */
const WATCH_IDLE_MS = 60_000
const WATCH_POLL_LIMIT_MS = 12_000
const watchState = new Map()

/** Changes here do not alter what the panel renders. */
function isNoisyPath(filename) {
  if (typeof filename !== 'string' || filename === '') return false
  const normalized = filename.replace(/\\/g, '/')
  return normalized.startsWith('.git/objects/')
    || normalized.startsWith('.git/logs/')
    || normalized.startsWith('.git/lfs/')
    || normalized.includes('node_modules/')
    || normalized.endsWith('.lock')
}

function watcherFor(root) {
  const existing = watchState.get(root)
  if (existing !== undefined) {
    existing.lastPollAt = Date.now()
    if (existing.idleTimer !== null) { clearTimeout(existing.idleTimer); existing.idleTimer = null }
    return existing
  }
  const state = { revision: 0, listeners: new Set(), watcher: null, idleTimer: null, bumpTimer: null, lastPollAt: Date.now() }
  try {
    state.watcher = watch(root, { recursive: true, persistent: false }, (eventType, filename) => {
      if (isNoisyPath(filename)) return
      /* A build touches thousands of files. Bumping the revision (and waking the
         long-poll) per event made the client restart its snapshot continuously,
         so the first load never finished. One bump per 300 ms is plenty. */
      if (state.bumpTimer !== null) return
      state.bumpTimer = setTimeout(() => {
        state.bumpTimer = null
        state.revision += 1
        for (const listener of [...state.listeners]) {
          try { listener() } catch { /* a listener must not break the watcher */ }
        }
      }, 300)
      if (typeof state.bumpTimer.unref === 'function') state.bumpTimer.unref()
    })
    state.watcher.on('error', () => { /* the watcher degrades to "always changed" */ })
  } catch {
    state.watcher = null
  }
  watchState.set(root, state)
  return state
}

function scheduleWatcherIdle(root, state) {
  if (state.idleTimer !== null) clearTimeout(state.idleTimer)
  state.idleTimer = setTimeout(() => {
    if (state.listeners.size > 0) return
    if (Date.now() - state.lastPollAt < WATCH_IDLE_MS / 2) return
    if (state.bumpTimer !== null) { clearTimeout(state.bumpTimer); state.bumpTimer = null }
    if (state.watcher !== null) { try { state.watcher.close() } catch { /* gone */ } }
    watchState.delete(root)
  }, WATCH_IDLE_MS)
  if (typeof state.idleTimer.unref === 'function') state.idleTimer.unref()
}

const METHODS = {
  /**
   * The repo picker's data source: every repository inside the workspace,
   * scanned from the session's workspace root (NOT just the cwd). `root` is the
   * workspace the scan started from, so the picker can also offer one-level
   * directory browsing from there.
   */
  async workspace(payload) {
    const workspace = await cwdOfPayload(payload)
    const scanned = await scanRepos(workspace, {
      maxDepth: payload.maxDepth === undefined ? undefined : Number(payload.maxDepth),
    })
    const top = await runGit(workspace, ['rev-parse', '--show-toplevel'], { timeoutMs: 10_000 })
    return {
      ...scanned,
      workspace,
      workspaceIsRepo: top.code === 0,
      /** One level of subdirectories, so the picker can drill down without a scan. */
      dirs: await browseDir(workspace),
    }
  },

  /**
   * Find FILES in the repository by name or by content.
   *
   * The panel needs this to answer "which file do I even want to look at?" —
   * before this, the only way in was to already have the file in the Changes
   * list, which meant a clean tree had no path to file history at all.
   *
   * Two modes, both served by ONE `git grep` for content and one `git ls-files`
   * for names (a repository walk from Node would be far slower and would pay a
   * syscall per file):
   *
   *   mode: 'name'     -> paths whose basename or full path matches (substring,
   *                       case-insensitive by default) — fast even on big trees
   *   mode: 'content'  -> paths whose TEXT matches, with line/column and a short
   *                       excerpt, using `git grep -n -I` (binary files skipped)
   *
   * Results are capped: a bare query like "a" on a large repository would
   * otherwise return tens of thousands of rows and freeze the panel.
   */
  async search(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    const query = typeof payload.query === 'string' ? payload.query.trim() : ''
    if (query === '') return { files: [], matches: [], truncated: false }
    if (query.length > 200) throw badRequest('query is too long')
    const mode = payload.mode === 'content' ? 'content' : 'name'
    const limit = Math.min(500, Math.max(1, Number(payload.limit) || 200))
    const caseSensitive = boolOf(payload.caseSensitive)

    if (mode === 'name') {
      const res = await runGit(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { timeoutMs: 30_000 })
      if (res.code !== 0) throw new PanelError('search-failed', res.stderr.trim() || 'git ls-files failed', 409)
      const needle = caseSensitive ? query : query.toLowerCase()
      const matches = []
      let truncated = false
      for (const raw of res.stdout.split('\u0000')) {
        if (raw === '') continue
        const filePath = normalizeSeparators(raw)
        const haystack = caseSensitive ? filePath : filePath.toLowerCase()
        /* Rank a basename hit above a directory-only hit: typing "index" should
           surface index.ts before src/index-helpers/readme.txt. */
        if (!haystack.includes(needle)) continue
        if (matches.length >= limit) { truncated = true; break }
        const base = filePath.split('/').pop()
        const baseHit = (caseSensitive ? base : base.toLowerCase()).includes(needle)
        matches.push({ path: filePath, baseHit })
      }
      matches.sort((a, b) => (a.baseHit === b.baseHit ? a.path.length - b.path.length : a.baseHit ? -1 : 1))
      return { files: matches.map((entry) => ({ path: entry.path })), matches: [], truncated, mode }
    }

    /* Content search. `-I` skips binary files, `-n` gives the line number,
       `--null` keeps paths parseable when they contain a colon.
       NOTE: `-i` must come AFTER the `grep` subcommand — putting it first makes
       git read it as a global option and fail with "unknown option: -i". */
    const args = ['grep', '-n', '-I', '--null', '--no-color']
    if (!caseSensitive) args.push('-i')
    args.push('-e', query, '--', '.')
    const res = await runGit(root, args, { timeoutMs: 60_000 })
    /* git grep exits 1 when there is no match — that is data, not an error. */
    if (res.code !== 0 && res.code !== 1) {
      throw new PanelError('search-failed', res.stderr.trim() || 'git grep failed', 409)
    }
    const matches = []
    let truncated = false
    for (const line of res.stdout.split('\n')) {
      if (line === '') continue
      /* With `--null`, git terminates BOTH the path and the line number with NUL:
         `<path>\0<lineNo>\0<text>`. Splitting on ':' instead (the non-null
         format) silently produced nothing, which is why content search came back
         empty. */
      const first = line.indexOf('\u0000')
      if (first < 0) continue
      const second = line.indexOf('\u0000', first + 1)
      if (second < 0) continue
      const filePath = normalizeSeparators(line.slice(0, first))
      const lineNumber = Number(line.slice(first + 1, second))
      const text = line.slice(second + 1)
      if (matches.length >= limit) { truncated = true; break }
      matches.push({ path: filePath, line: Number.isFinite(lineNumber) ? lineNumber : 0, text: text.slice(0, 240) })
    }
    return { files: [], matches, truncated, mode }
  },

  /**
   * One level of directory listing for the picker.
   *
   * Unlike the earlier revision this is NOT restricted to the session workspace:
   * the picker behaves like a file dialog, so the user can reach any repository
   * on any drive. What is still enforced is structural safety — the requested
   * path must be absolute, already exist, and be a real directory; the listing is
   * lexical only and never follows a `..` out of the directory it names.
   */
  async browse(payload) {
    /* A filesystem dialog needs a starting point, not a session. When the caller
       supplies no directory AND has no session/repo to fall back on, start at the
       first drive root — that is what a native "Browse for Folder" dialog does. */
    let workspace = null
    try {
      workspace = await cwdOfPayload(payload)
    } catch (error) {
      if (!(error instanceof PanelError) || (error.code !== 'bad-request' && error.code !== 'cwd-unavailable')) throw error
      workspace = null
    }
    const requested = payload.dir === undefined || payload.dir === null || payload.dir === ''
      ? (workspace !== null ? workspace : defaultBrowseRoot())
      : requireAbsolute(payload.dir, 'dir')
    const realRequested = await realOf(requested)
    let stats = null
    try {
      stats = lstatSync(realRequested)
    } catch (error) {
      throw new PanelError('browse-failed', `cannot read ${realRequested}: ${messageOf(error)}`, 409)
    }
    if (stats.isDirectory() !== true) {
      throw new PanelError('browse-failed', `${realRequested} is not a directory`, 409)
    }
    const realWorkspace = workspace === null ? null : await realOf(workspace)
    const dirs = await browseDir(realRequested)
    const top = await runGit(realRequested, ['rev-parse', '--show-toplevel'], { timeoutMs: 10_000 })
    const repoRoot = top.code === 0 ? normalizeSeparators(top.stdout.trim()) : null
    const atRepoTop = repoRoot !== null && samePath(repoRoot, realRequested)
    return {
      workspace,
      drives: listDriveRoots(),
      dir: normalizeSeparators(realRequested),
      /* `parent` is offered whenever a parent exists on disk — the whole tree is
         walkable, not just the part under the workspace. */
      parent: parentOf(realRequested),
      inWorkspace: realWorkspace === null ? false : isInside(canonicalPathSync(realWorkspace), canonicalPathSync(realRequested)),
      isRepo: atRepoTop,
      insideRepo: repoRoot !== null && !atRepoTop ? repoRoot : null,
      dirs,
    }
  },

  /** The poll endpoint: read-only, so it shares the short-lived snapshot cache. */
  async snapshot(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    return readSnapshotOf(root)
  },

  /**
   * Validate one candidate path the way SourceTree's "Repository Type" row does:
   * report whether the path exists, whether it is a directory, and whether it is
   * a Git repository (plus the branch when it is). The picker calls this on every
   * keystroke/selection so the user sees "This is a Git repository" or
   * "invalid path" BEFORE committing to it.
   */
  async verifyPath(payload) {
    const raw = typeof payload.path === 'string' ? payload.path.trim() : ''
    if (raw === '') return { exists: false, isDirectory: false, isRepo: false, kind: 'empty' }
    if (!path.isAbsolute(raw)) return { exists: false, isDirectory: false, isRepo: false, kind: 'not-absolute' }
    const target = raw
    let stats = null
    try {
      stats = lstatSync(target)
    } catch {
      return { exists: false, isDirectory: false, isRepo: false, kind: 'missing' }
    }
    if (stats.isDirectory() !== true) {
      return { exists: true, isDirectory: false, isRepo: false, kind: 'not-directory' }
    }
    /* ONE git spawn: this runs on every keystroke pause, and each spawn costs
       hundreds of ms. Branch/head come from the snapshot after the user commits to
       the path, so there is no reason to pay for them here. */
    const top = await runGit(target, ['rev-parse', '--show-toplevel'], { timeoutMs: 10_000 })
    if (top.code !== 0) return { exists: true, isDirectory: true, isRepo: false, kind: 'not-a-repo' }
    const root = normalizeSeparators(top.stdout.trim())
    return {
      exists: true,
      isDirectory: true,
      isRepo: true,
      kind: 'repo',
      /** true when the chosen directory IS the repository top (not a subdir). */
      isTop: samePath(root, target),
      root,
    }
  },
  /**
   * Long-poll for a repository change.
   *
   * Answers as soon as the revision differs from the caller's `since`, otherwise
   * waits up to ~20s. `supported: false` tells the client to fall back to a slow
   * poll because this filesystem refused a recursive watch.
   */
  async watch(payload) {
    /* Reuses the cached root: this endpoint is polled continuously, and paying a
       spawn per poll just to re-learn the same answer kept the long-poll from
       ever being genuinely idle. */
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    const state = watcherFor(root)
    const since = Number.isFinite(payload.since) ? Number(payload.since) : 0
    if (state.watcher === null) {
      scheduleWatcherIdle(root, state)
      return { supported: false, revision: state.revision, changed: true, root }
    }
    if (state.revision !== since) {
      scheduleWatcherIdle(root, state)
      return { supported: true, revision: state.revision, changed: true, root }
    }
    const result = await new Promise((resolve) => {
      let settled = false
      const finish = (changed) => {
        if (settled) return
        settled = true
        state.listeners.delete(onChange)
        clearTimeout(timer)
        resolve({ supported: true, revision: state.revision, changed, root })
      }
      const onChange = () => finish(true)
      const timer = setTimeout(() => finish(state.revision !== since), WATCH_POLL_LIMIT_MS)
      state.listeners.add(onChange)
    })
    state.lastPollAt = Date.now()
    scheduleWatcherIdle(root, state)
    return result
  },

  async repoInfo(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    const remotes = await runGit(root, ['remote', '-v'], { timeoutMs: 15_000 })
    const config = await runGit(root, ['config', '--get-regexp', '^(user\\.|remote\\.|branch\\.)'], { timeoutMs: 15_000 })
    return {
      root,
      remotes: remotes.code === 0 ? remotes.stdout.trim().split('\n').filter((line) => line !== '') : [],
      config: config.code === 0 ? config.stdout.trim().split('\n').filter((line) => line !== '') : [],
    }
  },

  async status(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    /* Read-only, like `snapshot`: both coalesce with the poll. */
    return readSnapshotOf(root)
  },

  async log(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    /* Keyed on the watcher revision: the commit list only changes when the
       repository does, and the watcher already knows that. */
    const revision = watcherRevisionOf(root)
    const key = listCacheKey('log', root, revision, JSON.stringify([
      payload.limit ?? 60, payload.skip ?? 0, payload.ref ?? '',
      payload.search ?? '', payload.author ?? '', payload.path ?? '',
    ]))
    /* Source-control has no /watch long-poll, so an external commit would leave
       the watcher revision at 0 and the cache stale forever. An explicit refresh
       must bypass the list cache. */
    if (payload.refresh !== true) {
      const hit = cachedList(key)
      if (hit !== undefined) return hit
    }
    return rememberList(key, await logOf(root, payload))
  },

  async branches(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    const revision = watcherRevisionOf(root)
    const key = listCacheKey('branches', root, revision, '')
    if (payload.refresh !== true) {
      const hit = cachedList(key)
      if (hit !== undefined) return hit
    }
    return rememberList(key, await branchesOf(root))
  },

  async commitDetail(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    const rev = requireRef(payload.rev, 'rev')
    /* Only an object name is immutable. A symbolic rev (HEAD, a branch) can
       point at a different commit one call later; caching it under the literal
       string returned stale detail after an amend/commit. */
    const cacheable = /^[0-9a-f]{7,64}$/i.test(rev)
    const cacheKey = cacheable ? root + '\u0000' + rev : ''
    if (cacheable) {
      const cached = commitDetailCache.get(cacheKey)
      if (cached !== undefined) {
        /* LRU touch. */
        commitDetailCache.delete(cacheKey)
        commitDetailCache.set(cacheKey, cached)
        return cached
      }
      const pending = commitDetailInflight.get(cacheKey)
      if (pending !== undefined) return pending
    }
    const format = ['%H', '%h', '%an', '%ae', '%at', '%cn', '%ce', '%ct', '%P', '%s', '%B'].join('%x1f')
    const request = (async () => {
      /* ONE `git show` instead of two. The old code ran `git show -s` for the
         message and then another `git show --name-status`; on Windows each
         process costs ~120-250 ms. `--name-status -z` plus a pretty format emits
         both in one stream: header up to \x1e, then NUL-separated status/path. */
      const res = await runGit(root, [
        'show', '--name-status', '-z', '--first-parent',
        '--no-ext-diff', '--no-textconv', '--no-color',
        `--pretty=format:${format}%x1e`,
        '--end-of-options', rev,
      ], { timeoutMs: 30_000 })
      if (res.code !== 0) throw new PanelError('commit-failed', res.stderr.trim() || 'git show failed', 409)
      const split = res.stdout.indexOf('\u001e')
      const header = split < 0 ? res.stdout : res.stdout.slice(0, split)
      const statusText = split < 0 ? '' : res.stdout.slice(split + 1).replace(/^\r?\n/, '')
      const fields = header.split('\u001f')
      const files = []
      const parts = statusText.split('\u0000').filter((entry) => entry !== '')
      for (let i = 0; i < parts.length; i += 1) {
        const status = parts[i]
        if (/^[A-Z]\d*$/.test(status) === false) continue
        const filePath = parts[i + 1]
        if (filePath === undefined) break
        const isRename = status.startsWith('R') || status.startsWith('C')
        const target = isRename ? parts[i + 2] : filePath
        if (isRename) i += 2
        else i += 1
        files.push({ status: status[0], path: normalizeSeparators(target === undefined ? filePath : target) })
      }
      const value = {
        hash: fields[0],
        short: fields[1],
        authorName: fields[2],
        authorEmail: fields[3],
        authorTime: Number(fields[4]) * 1000 || 0,
        committerName: fields[5],
        committerEmail: fields[6],
        commitTime: Number(fields[7]) * 1000 || 0,
        parents: fields[8] === '' ? [] : fields[8].split(' '),
        subject: fields[9],
        /* `%B` is the raw commit message: it STARTS with the subject line and
           ends with the format's record separator. cleanCommitBody strips the
           separator and the subject prefix. */
        body: cleanCommitBody(fields[10], fields[9]),
        files,
      }
      if (commitDetailCache.size >= COMMIT_DETAIL_CACHE_LIMIT) {
        const oldest = commitDetailCache.keys().next()
        if (oldest.done !== true) commitDetailCache.delete(oldest.value)
      }
      const fullKey = root + '\u0000' + value.hash
      if (commitDetailCache.size >= COMMIT_DETAIL_CACHE_LIMIT) {
        const oldest = commitDetailCache.keys().next()
        if (oldest.done !== true) commitDetailCache.delete(oldest.value)
      }
      commitDetailCache.set(fullKey, value)
      if (cacheable && cacheKey !== fullKey) commitDetailCache.set(cacheKey, value)
      return value
    })()
    if (cacheable) commitDetailInflight.set(cacheKey, request)
    try {
      return await request
    } finally {
      if (cacheable) commitDetailInflight.delete(cacheKey)
    }
  },
  async diff(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    const base = payload.base === 'staged' ? 'staged' : payload.base === 'commit' ? 'commit' : 'worktree'
    const filePath = payload.path === undefined ? null : String(payload.path)
    const context = Math.min(200, Math.max(0, Number(payload.context) || 3))
    const rev = base === 'commit' ? requireRef(payload.rev, 'rev') : ''
    /* One diff spawn costs ~400 ms on Windows; the panel asks for the same patch
       again on re-select / tab switch / drawer reopen. Commit patches are
       immutable, worktree ones are keyed by the watcher revision, so a cached
       answer is never stale — it simply becomes unreachable after a change. */
    const cacheKey = diffCacheKey(root, base, rev, filePath, context)
    const ttl = base === 'commit' ? COMMIT_DIFF_TTL_MS : WORKTREE_DIFF_TTL_MS
    const cached = readDiffCache(cacheKey, ttl)
    if (cached !== null) return cached
    const pending = diffInflight.get(cacheKey)
    if (pending !== undefined) return pending
    let args
    /* --no-ext-diff / --no-textconv: a user-configured external diff or textconv
       driver (git-lfs, docx converters, …) would spawn MORE processes per file.
       --no-color: the pane parses plain text. */
    const guard = ['--no-ext-diff', '--no-textconv', '--no-color']
    if (base === 'staged') args = ['diff', '--cached', `--unified=${context}`, ...guard]
    else if (base === 'commit') args = ['show', '--format=', '--first-parent', `--unified=${context}`, ...guard, '--end-of-options', rev]
    else args = ['diff', `--unified=${context}`, ...guard]
    if (filePath !== null && filePath !== '') args.push('--', filePath)
    const request = (async () => {
      const res = await runGit(root, args, { timeoutMs: 60_000 })
      if (res.code !== 0) throw new PanelError('diff-failed', res.stderr.trim() || 'git diff failed', 409)
      let text = res.stdout
      /* An unmerged path has no ordinary unified diff: git emits a combined
         `diff --cc`/`@@@` patch, which the pane's unified parser cannot turn
         into hunks (it showed "没有差异"). Diff the worktree against the
         `--ours` stage instead; it still contains both conflict marker blocks,
         so the user can see and resolve the conflict, and it is parseable. */
      if (/^diff --cc /m.test(text) || /^\* Unmerged path /m.test(text)) {
        const oursArgs = ['diff', '--ours', `--unified=${context}`, ...guard]
        if (filePath !== null && filePath !== '') oursArgs.push('--', filePath)
        const ours = await runGit(root, oursArgs, { timeoutMs: 60_000 })
        if (ours.code === 0) text = ours.stdout
      }
      text = clipDiff(text)
      const value = { patch: text, hunks: splitDiff(text).map(({ patch, ...rest }) => rest) }
      rememberDiff(cacheKey, value)
      return value
    })()
    diffInflight.set(cacheKey, request)
    try {
      return await request
    } finally {
      diffInflight.delete(cacheKey)
    }
  },

  /** Untracked files have no diff; synthesize one so the UI can still render. */
  async untrackedDiff(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    const filePath = String(payload.path === undefined ? '' : payload.path)
    if (filePath === '' || path.isAbsolute(filePath)) throw badRequest('path must be repository-relative')
    const absolute = path.join(root, filePath)
    let text
    try {
      const stat = lstatSync(absolute)
      if (!stat.isFile()) return { patch: '', binary: false, empty: true }
      if (stat.size > 512 * 1024) return { patch: '', binary: true, empty: false }
      text = readFileSync(absolute, 'utf8')
    } catch {
      return { patch: '', binary: false, empty: true }
    }
    if (text.includes('\u0000')) return { patch: '', binary: true, empty: false }
    const lines = text.split('\n')
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    const body = lines.map((line) => '+' + line).join('\n')
    return {
      patch: `diff --git a/${filePath} b/${filePath}\n--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${lines.length} @@\n${body}\n`,
      binary: false,
      empty: lines.length === 0,
    }
  },

  async stage(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    /* `all` must NOT enumerate paths: the UI used to expand "stage all" into
       every change and pass them as argv, which dies with ENAMETOOLONG once a
       build produces a few thousand files (Win32 caps a command line at ~32767
       characters, ~800 paths). `git add -A` expresses the same intent with one
       process and no argument list at all. */
    if (boolOf(payload.all)) {
      await git(root, ['add', '-A'])
      return snapshotOf(root)
    }
    const paths = requirePaths(payload.paths)
    await git(root, ['add', '--', ...paths])
    return snapshotOf(root)
  },

  async unstage(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    const head = await readHead(root)
    /* Same reasoning as `stage`: the staged group can be thousands of rows, so
       the bulk form uses a pathspec-free command instead of the path list. */
    if (boolOf(payload.all)) {
      if (head.unborn) await git(root, ['rm', '--cached', '-r', '--quiet', '--', '.'])
      else await git(root, ['reset', '--quiet', 'HEAD', '--'])
      return snapshotOf(root)
    }
    const paths = requirePaths(payload.paths)
    if (head.unborn) await git(root, ['rm', '--cached', '-r', '--quiet', '--', ...paths])
    else await git(root, ['restore', '--staged', '--', ...paths])
    return snapshotOf(root)
  },

  /**
   * Throw away worktree changes.
   *
   * `all: true` is the bulk form behind「全部撤销」: it restores EVERY tracked
   * path to HEAD (both the index and the worktree, so a staged edit is dropped
   * too) and deletes untracked files. It is destructive and irreversible, so it
   * requires an explicit `confirm` — the same guard `cleanUntracked` uses.
   *
   * Like `stage`/`unstage`, the bulk form never enumerates paths: the whole
   * point is to work on a change set too large for one command line.
   */
  async discard(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    if (boolOf(payload.all)) {
      if (boolOf(payload.confirm) !== true) {
        throw new PanelError('confirm-required', 'discarding every change needs explicit confirmation', 400)
      }
      const head = await readHead(root)
      /* One `restore --source=HEAD --staged --worktree` over the whole tree: it
         resets the index AND the worktree, which is what "撤销全部" means, and it
         also collapses any unmerged (conflicted) entries back to HEAD. */
      if (head.unborn) await git(root, ['rm', '--cached', '-r', '--quiet', '--', '.'])
      else await git(root, ['restore', '--source=HEAD', '--staged', '--worktree', '--', '.'])
      /* Untracked files are invisible to `git restore`, so they need `clean`.
         `-d` covers untracked directories; `-x` is deliberately NOT passed so
         .gitignore'd build output survives — dropping it would be a much bigger
         data loss than the user asked for. */
      await git(root, ['clean', '-d', '--force', '--quiet'])
      return snapshotOf(root)
    }
    const paths = requirePaths(payload.paths)
    const snapshot = await snapshotOf(root)
    const byPath = new Map(snapshot.changes.map((entry) => [entry.path, entry]))
    const tracked = []
    const conflicted = []
    const untracked = []
    for (const filePath of paths) {
      const entry = byPath.get(filePath)
      if (entry === undefined) continue
      if (entry.untracked) untracked.push(filePath)
      else if (entry.conflicted) conflicted.push(filePath)
      else tracked.push(filePath)
    }
    if (tracked.length > 0 || conflicted.length > 0) {
      const head = await readHead(root)
      /* An unmerged path has no index/worktree version to restore from: plain
         `git restore --worktree` refuses it with `path '<p>' is unmerged`. The
         source form rewrites BOTH sides from HEAD, which is what "discard" means
         here and also drops the unmerged stage entries (the conflict markers). */
      if (conflicted.length > 0) {
        if (head.unborn) await git(root, ['rm', '--cached', '--quiet', '--', ...conflicted])
        else await git(root, ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...conflicted])
      }
      if (tracked.length > 0) {
        if (head.unborn) await git(root, ['rm', '--cached', '--quiet', '--', ...tracked])
        else await git(root, ['restore', '--worktree', '--', ...tracked])
      }
    }
    for (const filePath of untracked) {
      const absolute = path.join(root, filePath)
      if (path.isAbsolute(filePath)) continue
      if (!isInside(await realOf(root), await realOf(path.dirname(absolute)))) continue
      try {
        const stat = lstatSync(absolute)
        if (stat.isDirectory()) throw new PanelError('nested-dir', `${filePath} is a directory`, 409)
        // A nested repository is never deleted implicitly.
        if (existsSync(path.join(absolute, '.git'))) throw new PanelError('nested-repo', `${filePath} is a Git repository`, 409)
        unlinkSync(absolute)
      } catch (error) {
        if (error instanceof PanelError) throw error
      }
    }
    return snapshotOf(root)
  },

  /**
   * Stage ONE hunk (or a subset of its lines) of a tracked file.
   * `patch` from the client is regenerated host-side from the live diff, so a
   * stale panel cannot apply a patch that no longer matches the worktree.
   */
  async stageHunk(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    const filePath = String(payload.path ?? '')
    if (filePath === '' || path.isAbsolute(filePath)) throw badRequest('path must be repository-relative')
    const hunkIndex = Math.max(0, Number(payload.hunkIndex) || 0)
    const selectedLines = Array.isArray(payload.lines) && payload.lines.length > 0 ? payload.lines.map(Number) : null
    const diffRes = await runGit(root, ['diff', '--unified=3', '--', filePath], { timeoutMs: 40_000 })
    if (diffRes.code !== 0) throw new PanelError('diff-failed', diffRes.stderr.trim() || 'git diff failed', 409)
    if (diffRes.stdout.trim() === '') {
      // Untracked file: stage the whole file (there is no hunk diff to split).
      await git(root, ['add', '--', filePath])
      return snapshotOf(root)
    }
    const hunks = splitDiff(diffRes.stdout)
    const hunk = hunks[hunkIndex]
    if (hunk === undefined) throw new PanelError('hunk-not-found', `hunk ${hunkIndex} not found`, 409)
    let patchText
    if (selectedLines === null) {
      patchText = `diff --git a/${filePath} b/${filePath}\n--- a/${filePath}\n+++ b/${filePath}\n`
        + hunk.patch.replace(/^@@/, '@@')
    } else {
      const built = buildLineSelectionPatch(filePath, hunk.header, hunk.body, selectedLines)
      if (built === null) throw new PanelError('nothing-selected', 'no lines selected', 400)
      patchText = built
    }
    await applyPatchToIndex(root, patchText)
    return snapshotOf(root)
  },

  /** Unstage one hunk of the index (reverse-apply the staged hunk). */
  async unstageHunk(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    const filePath = String(payload.path ?? '')
    if (filePath === '' || path.isAbsolute(filePath)) throw badRequest('path must be repository-relative')
    const hunkIndex = Math.max(0, Number(payload.hunkIndex) || 0)
    const selectedLines = Array.isArray(payload.lines) && payload.lines.length > 0 ? payload.lines.map(Number) : null
    const diffRes = await runGit(root, ['diff', '--cached', '--unified=3', '--', filePath], { timeoutMs: 40_000 })
    if (diffRes.code !== 0) throw new PanelError('diff-failed', diffRes.stderr.trim() || 'git diff failed', 409)
    const hunks = splitDiff(diffRes.stdout)
    const hunk = hunks[hunkIndex]
    if (hunk === undefined) throw new PanelError('hunk-not-found', `hunk ${hunkIndex} not found`, 409)
    let patchText
    if (selectedLines === null) {
      patchText = `diff --git a/${filePath} b/${filePath}\n--- a/${filePath}\n+++ b/${filePath}\n` + hunk.patch
    } else {
      const built = buildLineSelectionPatch(filePath, hunk.header, hunk.body, selectedLines)
      if (built === null) throw new PanelError('nothing-selected', 'no lines selected', 400)
      patchText = built
    }
    await applyPatchToIndex(root, patchText, { reverse: true })
    return snapshotOf(root)
  },

  /** Revert one hunk's worktree changes back to the index content. */
  async discardHunk(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    const filePath = String(payload.path ?? '')
    if (filePath === '' || path.isAbsolute(filePath)) throw badRequest('path must be repository-relative')
    const hunkIndex = Math.max(0, Number(payload.hunkIndex) || 0)
    const diffRes = await runGit(root, ['diff', '--unified=3', '--', filePath], { timeoutMs: 40_000 })
    if (diffRes.code !== 0) throw new PanelError('diff-failed', diffRes.stderr.trim() || 'git diff failed', 409)
    const hunks = splitDiff(diffRes.stdout)
    const hunk = hunks[hunkIndex]
    if (hunk === undefined) throw new PanelError('hunk-not-found', `hunk ${hunkIndex} not found`, 409)
    const patchText = `diff --git a/${filePath} b/${filePath}\n--- a/${filePath}\n+++ b/${filePath}\n` + hunk.patch
    const result = await runGitWithInput(root, ['apply', '--reverse', '--unidiff-zero', '--whitespace=nowarn'], patchText)
    if (result.code !== 0) {
      throw new PanelError('patch-failed', result.stderr.trim() || result.stdout.trim() || 'git apply failed', 409)
    }
    return snapshotOf(root)
  },

  async commit(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    const message = requireMessage(payload.message)
    const args = ['commit', '-m', message]
    if (boolOf(payload.amend)) args.push('--amend')
    if (boolOf(payload.signoff)) args.push('--signoff')
    if (boolOf(payload.allowEmpty)) args.push('--allow-empty')
    await git(root, args, { timeoutMs: 60_000 })
    return snapshotOf(root)
  },

  async amend(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    const message = typeof payload.message === 'string' ? payload.message.trim() : ''
    const args = ['commit', '--amend']
    if (message === '') args.push('--no-edit')
    else args.push('-m', message)
    await git(root, args, { timeoutMs: 60_000 })
    return snapshotOf(root)
  },

  async checkout(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    const name = requireRef(payload.name, 'name')
    const create = boolOf(payload.create)
    const args = create
      ? ['checkout', '-b', name]
      : ['checkout', '--end-of-options', name]
    if (create && typeof payload.startPoint === 'string' && payload.startPoint.trim() !== '') {
      args.push('--end-of-options', requireRef(payload.startPoint, 'startPoint'))
    }
    const result = await runGit(root, args, { timeoutMs: 60_000 })
    if (result.code !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim()
      if (/would be overwritten|Your local changes|Please commit your changes or stash/i.test(detail)) {
        throw new PanelError('local-changes-block', detail, 409)
      }
      throw new PanelError('checkout-failed', detail || 'git checkout failed', 409)
    }
    return snapshotOf(root)
  },

  async branchCreate(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    const name = requireRef(payload.name, 'name')
    const args = ['branch', '--end-of-options', name]
    if (typeof payload.startPoint === 'string' && payload.startPoint.trim() !== '') {
      args.push('--end-of-options', requireRef(payload.startPoint, 'startPoint'))
    }
    await git(root, args, { timeoutMs: 30_000 })
    return snapshotOf(root)
  },

  async branchRename(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    const from = requireRef(payload.from, 'from')
    const to = requireRef(payload.to, 'to')
    await git(root, ['branch', '-m', '--end-of-options', from, to], { timeoutMs: 30_000 })
    return snapshotOf(root)
  },

  async branchDelete(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    const name = requireRef(payload.name, 'name')
    const force = boolOf(payload.force)
    const PROTECTED = new Set(['main', 'master', 'trunk', 'develop', 'development'])
    if (PROTECTED.has(name) && !boolOf(payload.confirmProtected)) {
      throw new PanelError('protected-branch', `${name} needs confirmProtected`, 409)
    }
    const args = ['branch', force ? '-D' : '-d', '--end-of-options', name]
    const result = await runGit(root, args, { timeoutMs: 30_000 })
    if (result.code !== 0) {
      const detail = result.stderr.trim()
      if (/not fully merged/i.test(detail)) throw new PanelError('not-merged', detail, 409)
      throw new PanelError('branch-delete-failed', detail || 'git branch -d failed', 409)
    }
    return snapshotOf(root)
  },


  async branchDeleteRemote(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    const remote = requireRef(payload.remote, 'remote')
    const branch = requireRef(payload.branch, 'branch')
    const result = await runGit(root, ['push', '--delete', '--end-of-options', remote, branch], { timeoutMs: hostConfig.networkTimeoutMs })
    if (result.code !== 0) {
      throw new PanelError('remote-delete-failed', (result.stderr + result.stdout).trim() || 'git push --delete failed', 409)
    }
    return snapshotOf(root)
  },

  async branchUpstream(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    const name = requireRef(payload.name, 'name')
    const upstream = payload.upstream === null || payload.upstream === undefined || payload.upstream === ''
      ? null
      : requireRef(payload.upstream, 'upstream')
    if (upstream === null) await git(root, ['branch', '--unset-upstream', '--end-of-options', name], { timeoutMs: 20_000 })
    else await git(root, ['branch', `--set-upstream-to=${upstream}`, '--end-of-options', name], { timeoutMs: 20_000 })
    return snapshotOf(root)
  },

  async merge(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    const rev = requireRef(payload.rev, 'rev')
    const noFf = boolOf(payload.noFf)
    const squash = boolOf(payload.squash)
    const args = ['merge', '--no-edit']
    if (noFf) args.push('--no-ff')
    if (squash) args.push('--squash')
    if (typeof payload.message === 'string' && payload.message.trim() !== '') args.push('-m', payload.message)
    args.push('--end-of-options', rev)
    const result = await runGit(root, args, { timeoutMs: 120_000 })
    if (result.code !== 0) {
      const detail = (result.stderr.trim() + '\n' + result.stdout.trim()).trim()
      const snapshot = await snapshotOf(root)
      if (snapshot.conflictedFiles.length > 0 || /CONFLICT/.test(detail)) {
        return { conflicted: true, message: detail, snapshot }
      }
      if (/would be overwritten|local changes/i.test(detail)) {
        throw new PanelError('local-changes-block', detail, 409)
      }
      throw new PanelError('merge-failed', detail || 'git merge failed', 409)
    }
    return { conflicted: false, message: result.stdout.trim(), snapshot: await snapshotOf(root) }
  },

  async mergeAbort(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    await git(root, ['merge', '--abort'], { timeoutMs: 30_000 })
    return snapshotOf(root)
  },

  async mergeContinue(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    const message = typeof payload.message === 'string' ? payload.message.trim() : ''
    if (message !== '') await git(root, ['commit', '-m', message], { timeoutMs: 60_000 })
    else await git(root, ['commit', '--no-edit'], { timeoutMs: 60_000 })
    return snapshotOf(root)
  },

  async rebase(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    const onto = requireRef(payload.onto, 'onto')
    const result = await runGit(root, ['rebase', '--end-of-options', onto], { timeoutMs: 150_000 })
    if (result.code !== 0) {
      const snapshot = await snapshotOf(root)
      if (snapshot.operation === 'rebase') {
        return { conflicted: true, message: (result.stderr + result.stdout).trim(), snapshot }
      }
      throw new PanelError('rebase-failed', (result.stderr + result.stdout).trim() || 'git rebase failed', 409)
    }
    return { conflicted: false, message: result.stdout.trim(), snapshot: await snapshotOf(root) }
  },

  async rebaseAbort(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    await git(root, ['rebase', '--abort'], { timeoutMs: 60_000 })
    return snapshotOf(root)
  },

  async rebaseContinue(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    const result = await runGit(root, ['-c', 'core.editor=true', 'rebase', '--continue'], {
      timeoutMs: 120_000,
    })
    if (result.code !== 0) {
      const snapshot = await snapshotOf(root)
      if (snapshot.operation === 'rebase') {
        throw new PanelError('rebase-still-conflicted', (result.stderr + result.stdout).trim(), 409)
      }
      throw new PanelError('rebase-failed', (result.stderr + result.stdout).trim() || 'git rebase --continue failed', 409)
    }
    return snapshotOf(root)
  },

  async cherryPick(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    const rev = requireRef(payload.rev, 'rev')
    const args = ['cherry-pick']
    if (boolOf(payload.recordOrigin)) args.push('-x')
    if (boolOf(payload.noCommit)) args.push('-n')
    args.push('--end-of-options', rev)
    const result = await runGit(root, args, { timeoutMs: 90_000 })
    if (result.code !== 0) {
      const snapshot = await snapshotOf(root)
      if (snapshot.operation === 'cherry-pick') {
        return { conflicted: true, message: (result.stderr + result.stdout).trim(), snapshot }
      }
      throw new PanelError('cherry-pick-failed', (result.stderr + result.stdout).trim() || 'git cherry-pick failed', 409)
    }
    return { conflicted: false, message: result.stdout.trim(), snapshot: await snapshotOf(root) }
  },

  async revert(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    const rev = requireRef(payload.rev, 'rev')
    const mainline = payload.mainline === undefined || payload.mainline === null ? null : Number(payload.mainline)
    const args = ['revert', '--no-edit']
    if (mainline !== null && Number.isInteger(mainline)) args.push('-m', String(mainline))
    args.push('--end-of-options', rev)
    const result = await runGit(root, args, { timeoutMs: 90_000 })
    if (result.code !== 0) {
      const detail = (result.stderr + result.stdout).trim()
      const snapshot = await snapshotOf(root)
      if (snapshot.operation === 'revert') return { conflicted: true, message: detail, snapshot }
      if (/is a merge but no -m/i.test(detail)) throw new PanelError('revert-merge', detail, 409)
      throw new PanelError('revert-failed', detail || 'git revert failed', 409)
    }
    return { conflicted: false, message: result.stdout.trim(), snapshot: await snapshotOf(root) }
  },

  async reset(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    const rev = requireRef(payload.rev, 'rev')
    const mode = payload.mode === 'soft' || payload.mode === 'hard' ? payload.mode : 'mixed'
    if (mode === 'hard' && !boolOf(payload.confirm)) {
      throw new PanelError('confirm-required', 'a hard reset needs confirm: true', 409)
    }
    await git(root, ['reset', `--${mode}`, '--end-of-options', rev], { timeoutMs: 60_000 })
    return snapshotOf(root)
  },

  /**
   * Fetch from a remote (or from every remote).
   *
   * WHY THIS IS NOT `git fetch --all` ANY MORE:
   * `--all` is all-or-nothing at the exit-code level — if ANY remote fails (a
   * stale/unreachable second remote, a repo with an empty URL, an offline
   * mirror), git exits non-zero even though every other remote fetched fine.
   * The panel reported that as "fetch failed" and threw away the successful
   * result, which is the "有时候获取时会报错" report: it looked random because it
   * depended on which unrelated remote happened to be unreachable.
   *
   * So each remote is fetched on its own and the failures are REPORTED, not
   * fatal. Only when nothing at all succeeded does it throw, because then the
   * user genuinely has no network access to any remote.
   */
  async fetch(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    const named = typeof payload.remote === 'string' && payload.remote.trim() !== ''
      ? requireRef(payload.remote, 'remote')
      : null
    const remotes = named !== null ? [named] : await remoteNamesOf(root)
    if (remotes.length === 0) {
      throw new PanelError('no-remote', 'this repository has no remote configured', 409)
    }
    const base = ['fetch', '--prune']
    if (boolOf(payload.tags)) base.push('--tags')
    const succeeded = []
    const failed = []
    for (const remote of remotes) {
      const result = await runGit(root, [...base, '--end-of-options', remote], { timeoutMs: hostConfig.networkTimeoutMs })
      const detail = (result.stderr + result.stdout).trim()
      if (result.code === 0) succeeded.push(remote)
      else failed.push({ remote, message: detail === '' ? 'git fetch failed' : detail })
    }
    if (succeeded.length === 0) {
      const detail = failed.map((entry) => entry.remote + ': ' + entry.message).join('\n')
      throw new PanelError('fetch-failed', detail, 409)
    }
    return {
      output: 'fetched ' + succeeded.join(', '),
      /* A PARTIAL success is returned as data, so the UI can show a warning
         toast instead of an error that makes a successful fetch look broken. */
      partial: failed.length > 0,
      failedRemotes: failed,
      succeededRemotes: succeeded,
      snapshot: await snapshotOf(root),
    }
  },

  async pull(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    const remote = typeof payload.remote === 'string' && payload.remote.trim() !== ''
      ? requireRef(payload.remote, 'remote')
      : null
    const branch = typeof payload.branch === 'string' && payload.branch.trim() !== ''
      ? requireRef(payload.branch, 'branch')
      : null
    const args = ['pull']
    if (boolOf(payload.rebase)) args.push('--rebase')
    else if (boolOf(payload.ffOnly) || payload.strategy === undefined) args.push('--ff-only')
    if (boolOf(payload.autostash)) args.push('--autostash')
    if (remote !== null) args.push('--end-of-options', remote)
    if (remote !== null && branch !== null) args.push(branch)
    const result = await runGit(root, args, { timeoutMs: hostConfig.networkTimeoutMs })
    if (result.code !== 0) {
      const detail = (result.stderr + result.stdout).trim()
      const snapshot = await snapshotOf(root)
      if (snapshot.conflictedFiles.length > 0 || snapshot.operation !== null) {
        return { conflicted: true, message: detail, snapshot }
      }
      if (/not possible to fast-forward|diverged|Need to specify how to reconcile/i.test(detail)) {
        throw new PanelError('not-fast-forward', detail, 409)
      }
      throw new PanelError('pull-failed', detail || 'git pull failed', 409)
    }
    return { conflicted: false, output: (result.stderr + result.stdout).trim(), snapshot: await snapshotOf(root) }
  },

  async push(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    const remote = typeof payload.remote === 'string' && payload.remote.trim() !== ''
      ? requireRef(payload.remote, 'remote')
      : null
    const branch = typeof payload.branch === 'string' && payload.branch.trim() !== ''
      ? requireRef(payload.branch, 'branch')
      : null
    const args = ['push']
    if (boolOf(payload.setUpstream) && remote !== null) args.push('-u')
    if (remote !== null) args.push('--end-of-options', remote)
    if (!(remote === null) && branch !== null) args.push(branch)
    if (remote === null && branch !== null) args.push(branch)
    const result = await runGit(root, args, { timeoutMs: hostConfig.networkTimeoutMs })
    if (result.code !== 0) {
      const detail = (result.stderr + result.stdout).trim()
      if (/has no upstream branch/i.test(detail)) throw new PanelError('no-upstream', detail, 409)
      if (/\[rejected\]|fetch first|non-fast-forward/i.test(detail)) throw new PanelError('push-rejected', detail, 409)
      if (/Authentication failed|could not read Username|Permission denied/i.test(detail)) {
        throw new PanelError('auth-failed', detail, 409)
      }
      throw new PanelError('push-failed', detail || 'git push failed', 409)
    }
    return { output: (result.stderr + result.stdout).trim(), snapshot: await snapshotOf(root) }
  },

  async pushTags(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    const remote = typeof payload.remote === 'string' && payload.remote.trim() !== ''
      ? requireRef(payload.remote, 'remote')
      : 'origin'
    await git(root, ['push', '--tags', '--end-of-options', remote], { timeoutMs: hostConfig.networkTimeoutMs })
    return snapshotOf(root)
  },

  /** Push ONE tag, so a single tag can be published without sweeping --tags. */
  async tagPush(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    const name = requireRef(payload.name, 'name')
    const remote = typeof payload.remote === 'string' && payload.remote.trim() !== ''
      ? requireRef(payload.remote, 'remote')
      : 'origin'
    await git(root, ['push', '--end-of-options', remote, `refs/tags/${name}`], { timeoutMs: hostConfig.networkTimeoutMs })
    return snapshotOf(root)
  },

  /**
   * Retract a tag: remove it locally AND on the remote when it was published.
   *
   * This is the "撤销" operation for a release tag — the counterpart of
   * `tagCreate`. It deliberately does not touch commits: a tag is only a ref, so
   * undoing it never rewrites history.
   *
   * `remoteToo` defaults to TRUE when the tag exists on the remote, because a
   * tag that is gone locally but still on origin comes back with the next
   * `git fetch --tags` and keeps the release page alive. Callers that only want
   * the local ref gone pass `remoteToo: false`.
   *
   * Order matters: delete locally FIRST (cheap, reversible through the reflog if
   * it was annotated) and then the remote. If the remote step fails, the error
   * says so explicitly instead of silently leaving a half-undone tag.
   */
  async tagReset(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    const name = requireRef(payload.name, 'name')
    const remote = typeof payload.remote === 'string' && payload.remote.trim() !== ''
      ? requireRef(payload.remote, 'remote')
      : 'origin'
    /* Fail EARLY and clearly: `git tag -d` on a missing tag exits non-zero with a
       message about a "malformed object name", which reads like repository
       corruption instead of "that tag is not here". */
    const local = await runGit(root, ['rev-parse', '--verify', '--quiet', `refs/tags/${name}`], { timeoutMs: 20_000 })
    if (local.code !== 0) throw new PanelError('tag-not-found', `there is no local tag named ${name}`, 404)
    const onRemote = await tagOnRemote(root, remote, name)
    const remoteToo = payload.remoteToo === undefined ? onRemote : boolOf(payload.remoteToo)
    await git(root, ['tag', '-d', '--end-of-options', name], { timeoutMs: 20_000 })
    if (remoteToo) {
      const result = await runGit(root, ['push', '--delete', '--end-of-options', remote, `refs/tags/${name}`], { timeoutMs: hostConfig.networkTimeoutMs })
      if (result.code !== 0) {
        const detail = (result.stderr + result.stdout).trim()
        /* The local ref is already gone; report that plainly so the user knows
           the tag is half-retracted and can re-run the remote half. */
        throw new PanelError('tag-remote-delete-failed',
          `local tag ${name} was removed, but deleting ${remote}/${name} failed: ${detail || 'git push --delete failed'}`, 409)
      }
    }
    return { ...(await snapshotOf(root)), removedRemote: remoteToo }
  },

  async stashList(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    const args = ['stash', 'list', '--format=%gd%x1f%ci%x1f%gs%x1e']
    let res
    try {
      res = await runGit(root, args, { timeoutMs: 20_000 })
    } catch (error) {
      /* `stash list` is a read and normally takes ~200 ms. A concurrent
         stash/drop or a transient Git lock can make the first spawn wait until
         the 20 s deadline; retry once after a short yield instead of turning a
         temporary contention into a permanent error in the page. */
      if (!error || error.code !== 'git-timeout') throw error
      await new Promise((resolve) => setTimeout(resolve, 300))
      res = await runGit(root, args, { timeoutMs: 20_000 })
    }
    const stash = []
    if (res.code === 0) {
      for (const record of res.stdout.split('\u001e')) {
        const trimmed = record.replace(/^\n/, '')
        if (trimmed.trim() === '') continue
        const [ref, date, subject] = trimmed.split('\u001f')
        stash.push({ ref, date, subject })
      }
    }
    return { stash }
  },

  async stashPush(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    const message = typeof payload.message === 'string' ? payload.message.trim() : ''
    const args = ['stash', 'push']
    if (boolOf(payload.staged)) args.push('--staged')
    if (boolOf(payload.includeUntracked)) args.push('--include-untracked')
    if (boolOf(payload.keepIndex)) args.push('--keep-index')
    if (message !== '') args.push('-m', message)
    if (Array.isArray(payload.paths) && payload.paths.length > 0) {
      args.push('--', ...requirePaths(payload.paths))
    }
    const result = await runGit(root, args, { timeoutMs: 60_000 })
    if (result.code !== 0) {
      throw new PanelError('stash-failed', (result.stderr + result.stdout).trim() || 'git stash failed', 409)
    }
    return { output: result.stdout.trim(), snapshot: await snapshotOf(root) }
  },

  async stashApply(payload) {
    return stashApplyOrPop(payload, 'apply')
  },

  async stashPop(payload) {
    return stashApplyOrPop(payload, 'pop')
  },

  async stashDrop(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    const index = Math.max(0, Number(payload.index) || 0)
    await git(root, ['stash', 'drop', '--end-of-options', `stash@{${index}}`], { timeoutMs: 20_000 })
    return snapshotOf(root)
  },

  async stashClear(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    await git(root, ['stash', 'clear'], { timeoutMs: 20_000 })
    return snapshotOf(root)
  },

  /**
   * Which TAGS exist locally, and which of them are already on the remote.
   *
   * The panel needs this to show "publish" only where it makes sense, and to
   * tell the user why a push is even necessary. It is ONE `ls-remote --tags`
   * per remote (git returns every tag in a single response), not one call per
   * tag: a repository with 40 release tags would otherwise cost 40 spawns.
   *
   * Tags are NOT folded into `refs/remotes/<remote>/` the way branches are, so
   * there is no local ref that answers this — the network is the only source of
   * truth. That is why this is a SEPARATE call instead of part of `branches`:
   * `branches` is polled and cached, while this must be explicit and fresh.
   */
  async tagRemoteState(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    const named = typeof payload.remote === 'string' && payload.remote.trim() !== ''
      ? requireRef(payload.remote, 'remote')
      : null
    const remotes = named !== null ? [named] : await remoteNamesOf(root)
    if (remotes.length === 0) {
      return { remotes: [], published: {}, localTags: [], error: 'no-remote' }
    }
    /* Local tags, so the caller can diff them against what the remote reports. */
    const localRes = await runGit(root, ['for-each-ref', '--format=%(refname:short)', 'refs/tags'], { timeoutMs: 20_000 })
    const localTags = localRes.code === 0
      ? localRes.stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '')
      : []
    const published = {}
    const failures = []
    for (const remote of remotes) {
      const res = await runGit(root, ['ls-remote', '--tags', '--refs', '--end-of-options', remote], {
        timeoutMs: hostConfig.networkTimeoutMs,
      })
      if (res.code !== 0) {
        failures.push({ remote, message: (res.stderr + res.stdout).trim() || 'git ls-remote failed' })
        continue
      }
      for (const line of res.stdout.split('\n')) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        /* `<sha>\trefs/tags/<name>` */
        const tab = trimmed.indexOf('\t')
        if (tab < 0) continue
        const ref = trimmed.slice(tab + 1)
        if (!ref.startsWith('refs/tags/')) continue
        const name = ref.slice('refs/tags/'.length)
        if (published[name] === undefined) published[name] = []
        published[name].push(remote)
      }
    }
    return {
      remotes,
      localTags,
      /** tag name -> array of remotes that already have it */
      published,
      /** local tags that exist nowhere on the remote */
      unpublished: localTags.filter((name) => published[name] === undefined),
      failures,
    }
  },

  async tagCreate(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    const name = requireRef(payload.name, 'name')
    const rev = typeof payload.rev === 'string' && payload.rev.trim() !== '' ? requireRef(payload.rev, 'rev') : null
    const message = typeof payload.message === 'string' ? payload.message.trim() : ''
    const args = ['tag']
    if (message !== '') args.push('-a', '-m', message)
    args.push('--end-of-options', name)
    if (rev !== null) args.push(rev)
    await git(root, args, { timeoutMs: 20_000 })
    return snapshotOf(root)
  },

  async tagDelete(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    const name = requireRef(payload.name, 'name')
    await git(root, ['tag', '-d', '--end-of-options', name], { timeoutMs: 20_000 })
    return snapshotOf(root)
  },

  async tagDeleteRemote(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    const name = requireRef(payload.name, 'name')
    const remote = typeof payload.remote === 'string' && payload.remote.trim() !== ''
      ? requireRef(payload.remote, 'remote')
      : 'origin'
    await git(root, ['push', '--delete', '--end-of-options', remote, name], { timeoutMs: hostConfig.networkTimeoutMs })
    return snapshotOf(root)
  },

  async remoteAdd(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    const remoteName = requireRef(payload.remoteName, 'remoteName')
    const url = requireMessage(payload.url, 'url')
    if (/[\u0000-\u001f]/.test(url)) throw badRequest('url contains control characters')
    await git(root, ['remote', 'add', '--end-of-options', remoteName, url], { timeoutMs: 20_000 })
    return snapshotOf(root)
  },

  async remoteRemove(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    const remoteName = requireRef(payload.remoteName, 'remoteName')
    await git(root, ['remote', 'remove', '--end-of-options', remoteName], { timeoutMs: 20_000 })
    return snapshotOf(root)
  },

  async diffStat(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    const staged = await runGit(root, ['diff', '--cached', '--shortstat'], { timeoutMs: 20_000 })
    const worktree = await runGit(root, ['diff', '--shortstat'], { timeoutMs: 20_000 })
    return {
      staged: staged.code === 0 ? staged.stdout.trim() : '',
      worktree: worktree.code === 0 ? worktree.stdout.trim() : '',
    }
  },

  async blame(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    const filePath = String(payload.path ?? '')
    if (filePath === '' || path.isAbsolute(filePath)) throw badRequest('path must be repository-relative')
    const rev = typeof payload.rev === 'string' && payload.rev.trim() !== '' ? requireRef(payload.rev, 'rev') : null
    const args = ['blame', '--porcelain']
    args.push(rev === null ? 'HEAD' : rev, '--', filePath)
    const result = await runGit(root, args, { timeoutMs: 60_000 })
    if (result.code !== 0) throw new PanelError('blame-failed', result.stderr.trim() || 'git blame failed', 409)
    const lines = []
    const lines2 = result.stdout.split('\n')
    /* `--porcelain` prints the author/summary block only the FIRST time a commit
       appears in the output. The same commit can reappear in a LATER block (a file
       whose lines were touched by an older commit between two newer ones), and
       reusing the previous line's author there pairs the wrong person with the
       hash. Remember metadata per hash and attach it to every line of that commit. */
    const metaByHash = new Map()
    let current = null
    for (const line of lines2) {
      if (/^[0-9a-f]{40} /.test(line)) {
        const [hash, origLine, finalLine] = line.split(' ')
        const known = metaByHash.get(hash)
        current = {
          hash,
          origLine: Number(origLine),
          finalLine: Number(finalLine),
          author: known === undefined ? '' : known.author,
          authorTime: known === undefined ? 0 : known.authorTime,
          summary: known === undefined ? '' : known.summary,
          content: '',
        }
        continue
      }
      if (current === null) continue
      if (line.startsWith('author ')) current.author = line.slice(7)
      else if (line.startsWith('author-time ')) current.authorTime = Number(line.slice(12)) * 1000
      else if (line.startsWith('summary ')) current.summary = line.slice(8)
      else if (line.startsWith('\t')) {
        current.content = line.slice(1)
        if (current.author !== '') {
          metaByHash.set(current.hash, { author: current.author, authorTime: current.authorTime, summary: current.summary })
        }
        lines.push(current)
        current = null
      }
    }
    /* Every line must name its author; a line whose hash was seen before inherits
       that commit's metadata, never the neighbouring line's. */
    for (const line of lines) {
      if (line.author !== '') continue
      const known = metaByHash.get(line.hash)
      if (known !== undefined) {
        line.author = known.author
        line.authorTime = known.authorTime
        line.summary = known.summary
      }
    }
    return { lines }
  },

  /**
   * The commit history of ONE file — "这个文件被改过几次、每次改了什么".
   *
   * TWO git calls, deliberately:
   *
   *   1. `git log --follow` for the COMMITS. `--follow` makes git keep
   *      reporting the file across RENAMES, which is the case that made a file's
   *      history look like it started yesterday.
   *   2. `git log --numstat` for the per-commit line counts.
   *
   * Why not one call: `--follow` is incompatible with `--numstat` here — git
   * silently drops the follow behaviour (this is a real, long-standing git
   * limitation: `--follow` only works with a limited option set). Combining them
   * gave back ONLY post-rename commits, which is exactly the bug this feature
   * exists to fix. Two spawns is the correct price; the panel caches the result.
   */
  async fileHistory(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    const filePath = String(payload.path ?? '')
    if (filePath === '' || path.isAbsolute(filePath)) throw badRequest('path must be repository-relative')
    if (filePath.includes('\u0000')) throw badRequest('path must not contain NUL')
    const limit = Math.min(400, Math.max(1, Number(payload.limit) || 60))
    const skip = Math.max(0, Number(payload.skip) || 0)
    const ref = typeof payload.ref === 'string' && payload.ref.trim() !== '' ? requireRef(payload.ref, 'ref') : null
    const format = ['%H', '%h', '%an', '%ae', '%at', '%P', '%s', '%D'].join('%x1f')

    /* 1. the commits, following renames back through history */
    const logRes = await runGit(root, [
      'log', '--follow', '--date-order',
      `--pretty=format:${format}%x1e`,
      `--max-count=${limit}`, `--skip=${skip}`,
      ref !== null ? ref : 'HEAD',
      '--', filePath,
    ], { timeoutMs: 60_000 })
    if (logRes.code !== 0) {
      if (/does not have any commits yet|does not have any files/i.test(logRes.stderr)) {
        return { commits: [], hasMore: false, path: filePath }
      }
      throw new PanelError('file-history-failed', logRes.stderr.trim() || 'git log failed', 409)
    }
    const commits = parseLogCommits(logRes.stdout)

    /* 2. this file's own +/- counts.
     *
     * Three traps to avoid at once:
     *   - `-- <newPath>` only matches commits AFTER a rename (git diffs against
     *     the given path), so every earlier commit silently counted 0;
     *   - a `<oldest>^..<head>` range is invalid when the oldest is a root commit
     *     (`git log <root>^` fails with "ambiguous argument"), which a young
     *     repository always hits;
     *   - summing the whole `--numstat` block picks up SIBLING files, so a commit
     *     that also added a font/image made a purely textual source file report
     *     `binary` — the reported bug.
     *
     * So: collect every name this file has had (walking the numstat output and
     * following each `old => new` pair), then count only rows naming one of them.
     */
    if (commits.length > 0) {
      const hashes = commits.map((commit) => commit.hash)
      const statRes = await runGit(root, [
        'log', '--numstat', '--format=%H', '--no-walk=unsorted', ...hashes,
      ], { timeoutMs: 60_000 })
      if (statRes.code === 0) {
        const accepted = pathsOfFileInHistory(statRes.stdout, filePath)
        applyNumstat(commits, statRes.stdout, accepted)
      }
    }
    return { commits, hasMore: commits.length === limit, path: filePath }
  },

  async reflog(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    const limit = Math.min(200, Math.max(1, Number(payload.limit) || 50))
    const format = ['%H', '%h', '%gd', '%gs', '%an', '%at'].join('%x1f')
    const res = await runGit(root, ['reflog', 'show', `--max-count=${limit}`, `--format=${format}%x1e`], { timeoutMs: 30_000 })
    if (res.code !== 0) throw new PanelError('reflog-failed', res.stderr.trim() || 'git reflog failed', 409)
    const entries = []
    for (const record of res.stdout.split('\u001e')) {
      const trimmed = record.replace(/^\n/, '')
      if (trimmed.trim() === '') continue
      const fields = trimmed.split('\u001f')
      if (fields.length < 6) continue
      entries.push({
        hash: fields[0],
        short: fields[1],
        selector: fields[2],
        action: fields[3],
        author: fields[4],
        time: Number(fields[5]) * 1000 || 0,
      })
    }
    return { entries }
  },

  async conflictResolve(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    const paths = requirePaths(payload.paths)
    const side = payload.side
    if (side !== 'ours' && side !== 'theirs' && side !== 'mark-resolved') {
      throw badRequest('side must be "ours", "theirs" or "mark-resolved"')
    }
    if (side === 'mark-resolved') {
      await git(root, ['add', '--', ...paths], { timeoutMs: 30_000 })
      return snapshotOf(root)
    }
    for (const filePath of paths) {
      await git(root, ['checkout', `--${side}`, '--', filePath], { timeoutMs: 30_000 })
      await git(root, ['add', '--', filePath], { timeoutMs: 30_000 })
    }
    return snapshotOf(root)
  },

  /**
   * Stop tracking a path: append an anchored pattern to the repository's root
   * .gitignore and, when the path is already in the index, remove it from the
   * index only (`git rm --cached`). The working-tree file is never deleted.
   *
   * For an already-tracked file this stages a deletion plus the .gitignore edit;
   * the caller must commit those for future changes to stay untracked. History is
   * not rewritten (and must not be).
   */
  async ignore(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    const raw = requirePaths([payload.path])[0]
    const rel = normalizeSeparators(raw).replace(/^\.\/+/, '').replace(/\/+$/, '')
    if (rel === '' || rel === '.') throw badRequest('path is required')
    const directory = boolOf(payload.directory)
    /* Escape glob characters so a literal filename is ignored, then anchor it to
       the repository root. A bare `build` pattern would also hide nested dirs. */
    const literal = rel.replace(/([*?\[\]\\])/g, '\\$1')
    const pattern = '/' + literal + (directory ? '/' : '')
    const ignorePath = path.join(root, '.gitignore')
    let text = ''
    try { text = readFileSync(ignorePath, 'utf8') } catch { text = '' }
    const lines = text === '' ? [] : text.split(/\r?\n/)
    if (lines.some((line) => line.trim() === pattern) === false) {
      const prefix = text === '' || text.endsWith('\n') ? text : text + '\n'
      writeFileSync(ignorePath, prefix + pattern + '\n', 'utf8')
    }
    /* `ls-files` is the authoritative answer for a directory too: asking for
       `<dir>/` lists every tracked descendant. */
    const probe = directory ? rel.replace(/\/+$/, '') + '/' : rel
    const listed = await runGit(root, ['ls-files', '--', probe], { timeoutMs: 30_000 })
    const tracked = listed.code === 0 && listed.stdout.trim() !== ''
    if (tracked) {
      const removed = await runGit(root, ['rm', '--cached', '-r', '--ignore-unmatch', '--', rel], { timeoutMs: 60_000 })
      if (removed.code !== 0) {
        throw new PanelError('ignore-failed', removed.stderr.trim() || 'git rm --cached failed', 409)
      }
    }
    return {
      path: rel,
      pattern,
      tracked,
      snapshot: await snapshotOf(root),
    }
  },
  async cleanUntracked(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    if (!boolOf(payload.confirm)) throw new PanelError('confirm-required', 'clean needs confirm: true', 409)
    const args = boolOf(payload.includeIgnored) ? ['clean', '-fdx'] : ['clean', '-fd']
    const result = await runGit(root, args, { timeoutMs: 60_000 })
    if (result.code !== 0) throw new PanelError('clean-failed', result.stderr.trim() || 'git clean failed', 409)
    return { output: result.stdout.trim(), snapshot: await snapshotOf(root) }
  },

  async init(payload) {
    const dir = requireAbsolute(payload.cwd, 'cwd')
    if (!existsSync(dir)) throw badRequest('cwd does not exist')
    const result = await runGit(dir, ['init'], { timeoutMs: 30_000 })
    if (result.code !== 0) throw new PanelError('init-failed', result.stderr.trim() || 'git init failed', 409)
    /* This directory was cached as "not a repository"; that answer is now wrong. */
    invalidateRepoRoots()
    return snapshotOf(dir)
  },

  /**
   * Read one staged hunk's patch for the UI's "unstage this hunk" preview and
   * for the conflict editor's three-way content.
   */
  async fileContent(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    const filePath = String(payload.path ?? '')
    if (filePath === '' || path.isAbsolute(filePath)) throw badRequest('path must be repository-relative')
    const rev = typeof payload.rev === 'string' && payload.rev.trim() !== '' ? requireRef(payload.rev, 'rev') : ':0'
    const args = rev.startsWith(':') ? ['show', rev + ':' + filePath] : ['show', rev + ':' + filePath]
    const result = await runGit(root, args, { timeoutMs: 30_000 })
    if (result.code !== 0) {
      if (/exists on disk, but not in|does not exist in|invalid object name|Path .* does not exist/i.test(result.stderr)) {
        return { content: null, missing: true }
      }
      throw new PanelError('show-failed', result.stderr.trim() || 'git show failed', 409)
    }
    return { content: result.stdout, missing: false }
  },

  async configGet(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    const keys = ['user.name', 'user.email', 'core.autocrlf', 'core.quotepath']
    const values = {}
    for (const key of keys) {
      const res = await runGit(root, ['config', '--get', key], { timeoutMs: 10_000 })
      values[key] = res.code === 0 ? res.stdout.trim() : null
    }
    return { values }
  },
}

async function stashApplyOrPop(payload, verb) {
  const root = await repoRootOf(await cwdOfPayload(payload), payload)
  const index = Math.max(0, Number(payload.index) || 0)
  const result = await runGit(root, ['stash', verb, '--end-of-options', `stash@{${index}}`], { timeoutMs: 60_000 })
  if (result.code !== 0) {
    const detail = (result.stderr + result.stdout).trim()
    const snapshot = await snapshotOf(root)
    if (/CONFLICT|needs merge/i.test(detail)) {
      return { conflicted: true, message: detail, snapshot }
    }
    throw new PanelError('stash-apply-failed', detail || `git stash ${verb} failed`, 409)
  }
  return { conflicted: false, output: result.stdout.trim(), snapshot: await snapshotOf(root) }
}

/* ============================== http ============================== */

/* The route plumbing (trust fence, bounded JSON body, method dispatch, error
   envelope) lives in @dsh-workbay/kit. This half keeps only what is genuinely
   GitCraft's: the method map and the per-repository write lock, handed to the
   kit as the `run` hook below. */

/**
 * Apply the plugin. cordis hands the row config as the SECOND argument —
 * `ctx.config` throws ("cannot get property ... without inject") on a context
 * that did not declare `config` in its inject list.
 */
export function apply(ctx, config) {
  hostConfig = normalizeHostConfig(config === undefined || config === null ? {} : config)
  mountJsonApi(ctx, {
    prefix: ROUTE_PREFIX,
    methods: METHODS,
    maxBodyBytes: MAX_BODY_BYTES,
    /* Write methods run serialised per repository; reads never take the lock.
       A write also drops the read snapshot cache when it finishes: the panel
       must not see the state from before its own action for up to a TTL. The
       snapshot a write RETURNS is built by `snapshotOf` directly, so it is
       always read from git after the write, never from the cache.
       Reads that are not the snapshot probe (`log`, `diff`, `branches`, ...)
       drop it too: a caller that moved on to another call is no longer the
       poll burst the cache exists for, and the state it asks about next may
       have moved (a git command run outside this plugin updates nothing the
       cache can see). Only `snapshot`/`status` may reuse a recent read. */
    run: (method, payload, invoke) => {
      if (WRITE_METHODS.has(method)) {
        return withRepoLock(lockKeyOf(payload), async () => {
          try {
            return await invoke()
          } finally {
            invalidateSnapshots()
            /* Patches cached before the write no longer describe the worktree. */
            invalidateDiffs()
            /* A write may move refs without the filesystem watcher having fired
               yet (a commit writes .git/ files, which the watcher may or may not
               report, and a fetch can land during the same tick). Drop the list
               cache explicitly so the very next read is a fresh one. */
            invalidateLists()
          }
        })
      }
      if (method !== 'snapshot' && method !== 'status') invalidateSnapshots()
      return invoke()
    },
    label: 'dsh-gitcraft',
  })
  /* The native right-sidebar seat has no cwd to send, so the host resolves the
     session's workspace. sessions / sessionPersistence are injected HERE
     rather than in export const inject: a host without them must still load
     the whole plugin, it just answers cwd-unavailable for a cwd-less request.
     ctx.inject rebinds when a provider fiber appears late or restarts. */
  if (typeof ctx.inject !== 'function') return
  ctx.inject(['sessions', 'sessionPersistence'], (injected) => {
    const sessions = injected.get('sessions')
    const persistence = injected.get('sessionPersistence')
    injected.effect(() => {
      sessionServices = { sessions, persistence }
      return () => { sessionServices = null }
    }, 'dsh-gitcraft: session workspace resolution')
  })
}


