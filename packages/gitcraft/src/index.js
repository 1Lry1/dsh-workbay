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

import { mountJsonApi } from '@dsh-workbench/kit'

export const name = 'dsh-gitcraft'
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
 * Run git with an argv array (no shell). Resolves for ANY exit code so callers
 * can decide whether a non-zero status is data or an error.
 */
function runGit(cwd, args, options = {}) {
  const timeoutMs = options.timeoutMs === undefined ? hostConfig.timeoutMs : options.timeoutMs
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(gitBinary(), args, {
        cwd,
        windowsHide: true,
        // stdin is ignored on purpose: a network command must fail fast instead
        // of blocking on an interactive credential prompt.
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          GIT_OPTIONAL_LOCKS: '0',
          GIT_TERMINAL_PROMPT: '0',
          GIT_NO_LAZY_FETCH: '1',
          LC_ALL: 'C',
        },
      })
    } catch (error) {
      reject(new PanelError('git-missing', 'cannot start git: ' + messageOf(error), 500))
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
      child = spawn(gitBinary(), args, {
        cwd,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          GIT_OPTIONAL_LOCKS: '0',
          GIT_TERMINAL_PROMPT: '0',
          GIT_NO_LAZY_FETCH: '1',
          LC_ALL: 'C',
        },
      })
    } catch (error) {
      reject(new PanelError('git-missing', 'cannot start git: ' + messageOf(error), 500))
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

/* ============================== repository ============================== */

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
  const top = await runGit(probeDir, ['rev-parse', '--show-toplevel'], { timeoutMs: 15_000 })
  if (top.code !== 0) {
    const detail = top.stderr.trim()
    throw new PanelError(
      top.code === 128 && /not a git repository/i.test(detail) ? 'not-a-repo' : 'repo-unavailable',
      detail === '' ? 'not a git repository' : detail,
      400,
    )
  }
  const raw = top.stdout.trim()
  return normalizeSeparators(raw === '' ? probeDir : raw)
}

function normalizeSeparators(value) {
  return value.split('\\').join('/')
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
  return root === normalizeSeparators(dir)
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
  'branchUpstream', 'merge', 'mergeAbort', 'mergeContinue', 'rebase', 'rebaseAbort', 'rebaseContinue',
  'cherryPick', 'revert', 'reset', 'fetch', 'pull', 'push', 'pushTags',
  'stashPush', 'stashApply', 'stashPop', 'stashDrop', 'stashClear',
  'tagCreate', 'tagDelete', 'tagDeleteRemote', 'remoteAdd', 'remoteRemove',
  'conflictResolve', 'cleanUntracked', 'init',
])

function lockKeyOf(payload) {
  if (typeof payload.repoRoot === 'string' && payload.repoRoot !== '') return payload.repoRoot
  if (typeof payload.cwd === 'string' && payload.cwd !== '') return payload.cwd
  return 'global'
}

/* ============================== status parsing ============================== */

/**
 * Parse `git status --porcelain=v1 -z`. Returns one entry per path with both
 * index and worktree column decoded, so the panel can render the two groups
 * without a second call.
 */
function parseStatus(raw) {
  const entries = []
  const parts = raw.split('\u0000')
  for (let i = 0; i < parts.length; i += 1) {
    const record = parts[i]
    if (record === undefined || record.length < 4) continue
    const x = record[0]
    const y = record[1]
    const filePath = record.slice(3)
    let origin
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      i += 1
      origin = parts[i]
    }
    entries.push({
      path: normalizeSeparators(filePath),
      origin: origin === undefined ? undefined : normalizeSeparators(origin),
      index: x,
      worktree: y,
      staged: x !== ' ' && x !== '?',
      untracked: x === '?' && y === '?',
      conflicted: x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D'),
    })
  }
  return entries
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

async function readUpstream(cwd) {
  const res = await runGit(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { timeoutMs: 15_000 })
  if (res.code !== 0 || res.stdout.trim() === '') return { upstream: null, ahead: 0, behind: 0 }
  const upstream = res.stdout.trim()
  const counts = await runGit(cwd, ['rev-list', '--left-right', '--count', `HEAD...${upstream}`], { timeoutMs: 20_000 })
  if (counts.code !== 0) return { upstream, ahead: 0, behind: 0 }
  const [aheadText, behindText] = counts.stdout.trim().split(/\s+/)
  return { upstream, ahead: Number(aheadText) || 0, behind: Number(behindText) || 0 }
}

async function readOperation(cwd) {
  const dir = path.join(cwd, '.git')
  const exists = (name) => existsSync(path.join(dir, name))
  if (exists('MERGE_HEAD')) return 'merge'
  if (exists('rebase-merge') || exists('rebase-apply')) return 'rebase'
  if (exists('CHERRY_PICK_HEAD')) return 'cherry-pick'
  if (exists('REVERT_HEAD')) return 'revert'
  return null
}

async function readConflictedFiles(cwd) {
  const res = await runGit(cwd, ['diff', '--name-only', '--diff-filter=U', '-z'], { timeoutMs: 20_000 })
  if (res.code !== 0 || res.stdout === '') return []
  return res.stdout.split('\u0000').filter((entry) => entry !== '').map(normalizeSeparators)
}

async function snapshotOf(root) {
  const [head, branch, upstream, statusRaw, stagedNumstat, worktreeNumstat, merged, conflicted] = await Promise.all([
    readHead(root),
    readBranch(root),
    readUpstream(root),
    runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=dirty'], { timeoutMs: 30_000 }),
    runGit(root, ['diff', '--cached', '--numstat', '-z'], { timeoutMs: 30_000 }),
    runGit(root, ['diff', '--numstat', '-z'], { timeoutMs: 30_000 }),
    runGit(root, ['rev-parse', '--git-dir'], { timeoutMs: 15_000 }),
    readConflictedFiles(root),
  ])
  if (statusRaw.code !== 0) {
    throw new PanelError('status-failed', statusRaw.stderr.trim() || 'git status failed', 409)
  }
  const rawEntries = parseStatus(statusRaw.stdout)
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
  const operation = await readOperation(root)
  return {
    root,
    head: head.hash,
    headShort: head.short,
    unborn: head.unborn,
    branch: branch.name,
    detached: branch.detached,
    upstream: upstream.upstream,
    ahead: upstream.ahead,
    behind: upstream.behind,
    changes,
    operation,
    conflictedFiles: conflicted,
    gitDir: merged.code === 0 ? merged.stdout.trim() : null,
    refreshIntervalMs: hostConfig.refreshIntervalMs,
    defaultDiffView: hostConfig.defaultDiffView,
    truncated: statusRaw.truncated,
  }
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
  args.push(ref !== null ? ref : '--all')
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
  const state = { revision: 0, listeners: new Set(), watcher: null, idleTimer: null, lastPollAt: Date.now() }
  try {
    state.watcher = watch(root, { recursive: true, persistent: false }, (eventType, filename) => {
      if (isNoisyPath(filename)) return
      state.revision += 1
      for (const listener of [...state.listeners]) {
        try { listener() } catch { /* a listener must not break the watcher */ }
      }
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
    return {
      workspace,
      drives: listDriveRoots(),
      dir: normalizeSeparators(realRequested),
      /* `parent` is offered whenever a parent exists on disk — the whole tree is
         walkable, not just the part under the workspace. */
      parent: parentOf(realRequested),
      inWorkspace: realWorkspace === null ? false : isInside(realWorkspace, normalizeSeparators(realRequested)),
      isRepo: repoRoot !== null && repoRoot === normalizeSeparators(realRequested),
      insideRepo: repoRoot !== null && repoRoot !== normalizeSeparators(realRequested) ? repoRoot : null,
      dirs,
    }
  },

  async snapshot(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    return snapshotOf(root)
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
      isTop: root === normalizeSeparators(target),
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
    const cwd = await cwdOfPayload(payload)
    const top = await runGit(cwd, ['rev-parse', '--show-toplevel'], { timeoutMs: 10_000 })
    if (top.code !== 0) {
      throw new PanelError('not-a-repo', messageOf(new Error(top.stderr)), 409)
    }
    const root = normalizeSeparators(top.stdout.trim())
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
    return snapshotOf(root)
  },

  async log(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    return logOf(root, payload)
  },

  async branches(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
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
  },

  async commitDetail(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    const rev = requireRef(payload.rev, 'rev')
    const format = ['%H', '%h', '%an', '%ae', '%at', '%cn', '%ce', '%ct', '%P', '%s', '%B'].join('%x1f')
    const res = await runGit(root, ['show', '-s', `--pretty=format:${format}%x1e`, '--end-of-options', rev], { timeoutMs: 30_000 })
    if (res.code !== 0) throw new PanelError('commit-failed', res.stderr.trim() || 'git show failed', 409)
    const fields = res.stdout.split('\u001f')
    const names = await runGit(root, ['show', '--name-status', '--format=', '-z', '--end-of-options', rev], { timeoutMs: 30_000 })
    const files = []
    if (names.code === 0) {
      const parts = names.stdout.split('\u0000').filter((entry) => entry !== '')
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
    }
    return {
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
      body: fields[10] === undefined ? '' : fields[10],
      files,
    }
  },

  async diff(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    const base = payload.base === 'staged' ? 'staged' : payload.base === 'commit' ? 'commit' : 'worktree'
    const filePath = payload.path === undefined ? null : String(payload.path)
    const context = Math.min(200, Math.max(0, Number(payload.context) || 3))
    let args
    if (base === 'staged') args = ['diff', '--cached', `--unified=${context}`]
    else if (base === 'commit') args = ['show', '--format=', '--first-parent', `--unified=${context}`, '--end-of-options', requireRef(payload.rev, 'rev')]
    else args = ['diff', `--unified=${context}`]
    if (filePath !== null && filePath !== '') args.push('--', filePath)
    const res = await runGit(root, args, { timeoutMs: 60_000 })
    if (res.code !== 0) throw new PanelError('diff-failed', res.stderr.trim() || 'git diff failed', 409)
    const text = clipDiff(res.stdout)
    return { patch: text, hunks: splitDiff(text).map(({ patch, ...rest }) => rest) }
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
    const paths = requirePaths(payload.paths)
    if (boolOf(payload.all)) await git(root, ['add', '-A'])
    else await git(root, ['add', '--', ...paths])
    return snapshotOf(root)
  },

  async unstage(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    const paths = requirePaths(payload.paths)
    const head = await readHead(root)
    if (head.unborn) await git(root, ['rm', '--cached', '-r', '--quiet', '--', ...paths])
    else await git(root, ['restore', '--staged', '--', ...paths])
    return snapshotOf(root)
  },

  async discard(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    const paths = requirePaths(payload.paths)
    const snapshot = await snapshotOf(root)
    const byPath = new Map(snapshot.changes.map((entry) => [entry.path, entry]))
    const tracked = []
    const untracked = []
    for (const filePath of paths) {
      const entry = byPath.get(filePath)
      if (entry === undefined) continue
      if (entry.untracked) untracked.push(filePath)
      else tracked.push(filePath)
    }
    if (tracked.length > 0) {
      const head = await readHead(root)
      if (head.unborn) await git(root, ['rm', '--cached', '--quiet', '--', ...tracked])
      else await git(root, ['restore', '--worktree', '--', ...tracked])
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

  async fetch(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    const remote = typeof payload.remote === 'string' && payload.remote.trim() !== ''
      ? requireRef(payload.remote, 'remote')
      : null
    const args = ['fetch', '--prune']
    if (boolOf(payload.tags)) args.push('--tags')
    if (boolOf(payload.all) || remote === null) args.push('--all')
    else args.push('--end-of-options', remote)
    const result = await runGit(root, args, { timeoutMs: hostConfig.networkTimeoutMs })
    if (result.code !== 0) {
      throw new PanelError('fetch-failed', (result.stderr + result.stdout).trim() || 'git fetch failed', 409)
    }
    return { output: (result.stderr + result.stdout).trim(), snapshot: await snapshotOf(root) }
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

  async stashList(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    const res = await runGit(root, ['stash', 'list', '--format=%gd%x1f%ci%x1f%gs%x1e'], { timeoutMs: 20_000 })
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
    let current = null
    for (const line of lines2) {
      if (/^[0-9a-f]{40} /.test(line)) {
        const [hash, origLine, finalLine] = line.split(' ')
        current = { hash, origLine: Number(origLine), finalLine: Number(finalLine), author: '', authorTime: 0, summary: '', content: '' }
        continue
      }
      if (current === null) continue
      if (line.startsWith('author ')) current.author = line.slice(7)
      else if (line.startsWith('author-time ')) current.authorTime = Number(line.slice(12)) * 1000
      else if (line.startsWith('summary ')) current.summary = line.slice(8)
      else if (line.startsWith('\t')) {
        current.content = line.slice(1)
        lines.push(current)
        current = null
      }
    }
    return { lines }
  },

  async fileHistory(payload) {
    const root = await repoRootOf(await cwdOfPayload(payload), payload)
    const filePath = String(payload.path ?? '')
    if (filePath === '' || path.isAbsolute(filePath)) throw badRequest('path must be repository-relative')
    return logOf(root, { limit: payload.limit, skip: payload.skip, path: filePath })
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
   envelope) lives in @dsh-workbench/kit. This half keeps only what is genuinely
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
    /* Write methods run serialised per repository; reads never take the lock. */
    run: (method, payload, invoke) => (WRITE_METHODS.has(method)
      ? withRepoLock(lockKeyOf(payload), invoke)
      : invoke()),
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
