/**
 * dsh-workbay-files — host half (plain ESM JavaScript, no build step).
 *
 * Three HTTP surfaces back the browser panel (docs/files-api.md §2/§3):
 *
 *   POST /dsh-workbay-files/api/<method>   -> { ok: true, data } | { ok: false, error }
 *   GET  /dsh-workbay-files/media?root&rel -> raw bytes, cached nowhere
 *   GET  /dsh-workbay-files/chunk/<n>.js   -> a built lazy chunk, ETag + 304
 *
 * Security model (docs/files-api.md §1): the client names a workspace root
 * explicitly and every path it sends is relative to it. The root must be an
 * absolute existing directory; `rel` is POSIX, may not be absolute and may not
 * contain `..`; the host resolves the target with `realpathSync.native` and
 * proves it is still inside the root (separator boundary, so a symlink — or a
 * sibling such as `C:\ws2` next to `C:\ws` — cannot smuggle a path out).
 * Writes are off unless the profile opts in with `allowWrite: true`.
 *
 * Same-origin fence: the routes live on DSH's own web server, and `mountJsonApi`
 * (plus the explicit checks in the two GET handlers) only serves loopback /
 * same-origin callers — the same posture as dsh-gitcraft.
 */
import { createHash } from 'node:crypto'
import {
  closeSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readFileSync,
  readdirSync,
  readSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ApiError,
  badRequest,
  isTrustedRequest,
  mediaTypeFor,
  messageOf,
  mountJsonApi,
  normalizeRel,
  resolveInside,
  sendJson,
} from '@dsh-workbay/kit'

export const name = 'dsh-workbay-files'
export const inject = ['webServer']

const ROUTE_PREFIX = '/dsh-workbay-files/api'
const MEDIA_PREFIX = '/dsh-workbay-files/media'
const CHUNK_PREFIX = '/dsh-workbay-files/chunk'

const DEFAULT_MAX_FILE_BYTES = 1024 * 1024
const HARD_READ_MAX_BYTES = 8 * 1024 * 1024
const WRITE_MAX_BYTES = 2 * 1024 * 1024
/* A 2 MiB write plus JSON escaping and the small envelope must fit. */
const MAX_BODY_BYTES = 8 * 1024 * 1024

const TREE_MAX_ENTRIES = 2000
/* search (docs/files-api.md §2.1) */
const SEARCH_DEFAULT_MAX_RESULTS = 200
const SEARCH_HARD_MAX_RESULTS = 2000
const SEARCH_MAX_CONTEXT_LINES = 3
const SEARCH_MAX_FILES = 20_000
const SEARCH_TIME_BUDGET_MS = 6000
/* One match row's `text` never exceeds this; long lines are windowed around the
   match so the highlighted span stays visible. */
const SEARCH_TEXT_MAX_CHARS = 400
const SEARCH_BINARY_SNIFF_BYTES = 8192
const SEARCH_DEFAULT_EXCLUDES = Object.freeze(['node_modules/**', '.git/**', '.hg/**', '.svn/**'])
const RECENT_LIMIT = 10

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const DEFAULTS = Object.freeze({ allowWrite: false, maxFileBytes: DEFAULT_MAX_FILE_BYTES })

let hostConfig = { ...DEFAULTS, chunksDir: defaultChunksDir() }

/** Workspace roots this process has actually served, newest first. */
const recentRoots = []

/* ============================== errors ============================== */

function forbiddenWrite() {
  return new ApiError(
    'write-disabled',
    'workspace writes are disabled; set allowWrite: true on the dsh-workbay-files row',
    403,
  )
}

function notFound(what) {
  return new ApiError('not-found', what + ' does not exist', 404)
}

function conflict(message) {
  return new ApiError('conflict', message, 409)
}

function tooLarge(message) {
  return new ApiError('too-large', message, 413)
}

function fsFailure(code, message) {
  return new ApiError(code, message, 409)
}

/** Wrap a filesystem error that has no better mapping, without leaking a stack. */
function asFailure(code, prefix, error) {
  if (error instanceof ApiError) throw error
  throw fsFailure(code, prefix + ': ' + messageOf(error))
}

/* ============================== config ============================== */

/**
 * Directory served by the chunk route. `DSH_WORKBAY_FILES_CHUNKS` is a test /
 * development seam so `lib/chunks` can be pointed elsewhere; production always
 * uses the package's own built output.
 */
function defaultChunksDir() {
  const override = process.env.DSH_WORKBAY_FILES_CHUNKS
  if (typeof override === 'string' && override.trim() !== '') return path.resolve(override.trim())
  return path.join(PACKAGE_ROOT, 'lib', 'chunks')
}

function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const requested = typeof source.maxFileBytes === 'number' && Number.isFinite(source.maxFileBytes)
    ? Math.floor(source.maxFileBytes)
    : DEFAULT_MAX_FILE_BYTES
  return {
    allowWrite: source.allowWrite === true,
    maxFileBytes: Math.min(HARD_READ_MAX_BYTES, Math.max(1, requested)),
    chunksDir: defaultChunksDir(),
  }
}

function requireWrite() {
  if (!hostConfig.allowWrite) throw forbiddenWrite()
}

function clampNumber(value, min, max, fallback) {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.min(max, Math.max(min, number))
}

/* ============================== paths and entries ============================== */

/** Absolute path -> the forward-slash form the client sees (works on any OS). */
function jsonPath(value) {
  return path.normalize(value).split(path.sep).join('/')
}

function relFromRoot(rootReal, targetPath) {
  const rel = path.relative(rootReal, targetPath)
  return rel === '' ? '' : rel.split(path.sep).join('/')
}

function noteRecent(rootReal) {
  const pretty = jsonPath(rootReal)
  const existing = recentRoots.indexOf(pretty)
  if (existing !== -1) recentRoots.splice(existing, 1)
  recentRoots.unshift(pretty)
  if (recentRoots.length > RECENT_LIMIT) recentRoots.length = RECENT_LIMIT
}

/** Validate `payload.root` and return its realpath (the confinement boundary). */
function rootPathOf(payload) {
  const rootReal = resolveInside(payload.root, '')
  noteRecent(rootReal)
  return rootReal
}

/** Validate a workspace-relative target and resolve it inside the root. */
function targetOf(payload, options = {}) {
  const root = rootPathOf(payload)
  const rel = normalizeRel(payload.rel === undefined || payload.rel === null ? '' : payload.rel)
  const abs = resolveInside(root, rel, {
    followFinal: options.followFinal === undefined ? true : options.followFinal === true,
  })
  return { root, rel, abs }
}

/**
 * Does the directory contain at least one entry? Uses `opendir` + one `read`
 * instead of listing the whole directory — `tree` calls this for every
 * subdirectory it reports, and a big folder must not turn into a full scan.
 */
function hasChildren(dir) {
  let handle
  try {
    handle = opendirSync(dir)
    return handle.readSync() !== null
  } catch {
    return false
  } finally {
    if (handle !== undefined) {
      try { handle.closeSync() } catch { /* already closed */ }
    }
  }
}

function entryFromStats(rootReal, absPath, stats) {
  const type = stats.isSymbolicLink() ? 'symlink' : stats.isDirectory() ? 'dir' : 'file'
  const entry = { name: path.basename(absPath), rel: relFromRoot(rootReal, absPath), type, mtimeMs: stats.mtimeMs }
  if (type === 'file') entry.size = stats.size
  if (type === 'dir') entry.hasChildren = hasChildren(absPath)
  return entry
}

function entryAt(rootReal, absPath) {
  return entryFromStats(rootReal, absPath, lstatSync(absPath))
}

function sortEntries(entries) {
  entries.sort((a, b) => {
    const rank = (entry) => (entry.type === 'dir' ? 0 : 1)
    const byType = rank(a) - rank(b)
    if (byType !== 0) return byType
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
  return entries
}

function isHiddenName(entryName) {
  /* Windows' hidden ATTRIBUTE is not exposed by `fs.stat`, and the host must not
     run `attrib` (no shell), so "hidden" is the dot-file convention. */
  return entryName.startsWith('.')
}

function listDrives() {
  if (process.platform !== 'win32') return [{ name: '/', path: '/' }]
  const drives = []
  for (let code = 65; code <= 90; code += 1) {
    const letter = String.fromCharCode(code)
    try {
      if (statSync(letter + ':\\').isDirectory()) {
        drives.push({ name: letter + ':', path: letter + ':/' })
      }
    } catch {
      /* not mounted */
    }
  }
  return drives.length > 0 ? drives : [{ name: 'C:', path: 'C:/' }]
}

function parentOf(dir) {
  const parent = path.dirname(dir)
  return jsonPath(parent) === jsonPath(dir) ? null : jsonPath(parent)
}

/* ============================== file bytes ============================== */

function looksBinary(buffer) {
  const sample = buffer.subarray(0, 8192)
  for (const byte of sample) {
    if (byte === 0) return true
  }
  let control = 0
  for (const byte of sample) {
    if (byte < 9 || (byte > 13 && byte < 32)) control += 1
  }
  return sample.length > 0 && control / sample.length > 0.3
}

/**
 * Search's binary rule is narrower than `read`'s: docs/files-api.md §2.1 only
 * says "a NUL in the first 8 KiB". Text full of tabs/control characters is
 * therefore still searched (and reported with those bytes), which is what a
 * content search should do.
 */
function hasNulByte(buffer) {
  const end = Math.min(buffer.length, SEARCH_BINARY_SNIFF_BYTES)
  for (let index = 0; index < end; index += 1) {
    if (buffer[index] === 0) return true
  }
  return false
}

/**
 * Let the host breathe.
 *
 * The content search reads the filesystem synchronously (readdirSync/readFileSync)
 * inside an async method. Without yields a large workspace would block the
 * Electron main process's event loop for up to the 6 s search budget, freezing
 * the DSH UI and every other plugin's RPC. Yielding to the macrotask queue every
 * few milliseconds keeps the host responsive while the scan continues.
 */
function yieldToHost() {
  return new Promise((resolve) => setImmediate(resolve))
}

/** Read at most `length` bytes from the start of a file. */
function readSlice(filePath, length) {
  if (length <= 0) return Buffer.alloc(0)
  const buffer = Buffer.alloc(length)
  const fd = openSync(filePath, 'r')
  try {
    let offset = 0
    while (offset < length) {
      const read = readSync(fd, buffer, offset, length - offset, offset)
      if (read === 0) break
      offset += read
    }
    return offset === length ? buffer : buffer.subarray(0, offset)
  } finally {
    closeSync(fd)
  }
}

function readLimitOf(payload) {
  const requested = typeof payload.maxBytes === 'number' && Number.isFinite(payload.maxBytes)
    ? Math.floor(payload.maxBytes)
    : hostConfig.maxFileBytes
  return Math.min(HARD_READ_MAX_BYTES, Math.max(1, requested))
}

function headerOf(req, headerName) {
  const headers = req.headers === undefined || req.headers === null ? undefined : req.headers
  const value = headers === undefined ? undefined : headers[headerName]
  if (Array.isArray(value)) return value[0]
  return typeof value === 'string' ? value : undefined
}

function sendRouteError(res, error) {
  const status = error !== null && typeof error === 'object' && typeof error.status === 'number'
    ? error.status
    : 500
  const code = error !== null && typeof error === 'object' && typeof error.code === 'string'
    ? error.code
    : 'internal'
  const message = status >= 500 ? 'internal error' : messageOf(error)
  if (res.headersSent === true) {
    if (typeof res.destroy === 'function') res.destroy()
    return
  }
  sendJson(res, status, { ok: false, error: { code, message } })
}

/* ============================== search helpers ============================== */

/**
 * Glob → anchored RegExp over POSIX workspace-relative paths.
 *
 * Documented semantics (docs/files-api.md §2.1): `*` matches anything but `/`,
 * `**` crosses directories, `?` matches one non-`/` character, a leading `!`
 * negates a pattern in a comma-separated list. A pattern without any `/` also
 * matches a basename at any depth (a user typing `*.md` in the VSCode include
 * box means "markdown anywhere", not "markdown at the root").
 */
function globSource(text) {
  let source = ''
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (char === '*') {
      if (text[index + 1] === '*') {
        if (text[index + 2] === '/') {
          /* A double star followed by a slash may also match ZERO directories,
             so a pattern that begins with one still matches a root-level path. */
          source += '(?:[^/]+/)*'
          index += 3
        } else {
          source += '.*'
          index += 2
        }
        continue
      }
      source += '[^/]*'
      index += 1
      continue
    }
    if (char === '?') {
      source += '[^/]'
      index += 1
      continue
    }
    source += /[.+^${}()|[\]\\]/.test(char) ? '\\' + char : char
    index += 1
  }
  return source
}

function compileGlob(text) {
  const normalized = text.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
  if (normalized === '') return null
  const flags = process.platform === 'win32' ? 'i' : ''
  const body = globSource(normalized)
  /* A bare `<name>/**` means "that folder, wherever it is": that is the shape of
     the documented default excludes (`node_modules/**`), and users mean it at any
     depth — a workspace normally has one node_modules per package. A pattern
     with any other shape stays anchored at the root, so `src/**` keeps meaning
     the root's src folder. Same rule as `*.md` matching a basename at any depth. */
  const folderAnywhere = /^[^/*?]+\/\*\*$/.test(normalized)
  let regex
  try {
    if (folderAnywhere || !normalized.includes('/')) regex = new RegExp('(?:^|/)' + body + '$', flags)
    else regex = new RegExp('^' + body + '$', flags)
  } catch {
    return null
  }
  let dirRegex = null
  if (normalized.endsWith('/**')) {
    const prefix = normalized.slice(0, -3)
    const prefixBody = globSource(prefix)
    try {
      dirRegex = new RegExp(folderAnywhere ? '(?:^|/)' + prefixBody + '$' : '^' + prefixBody + '$', flags)
    } catch {
      dirRegex = null
    }
  }
  return { regex, dirRegex }
}

/** Compile a comma-separated glob list into `{ positives, negatives }`. */
function compileGlobList(source) {
  const positives = []
  const negatives = []
  for (const raw of String(source).split(',')) {
    let text = raw.trim()
    if (text === '') continue
    let negated = false
    if (text.startsWith('!')) {
      negated = true
      text = text.slice(1).trim()
    }
    if (text === '') continue
    const compiled = compileGlob(text)
    if (compiled === null) continue
    const pattern = { regex: compiled.regex, dirRegex: compiled.dirRegex }
    if (negated) negatives.push(pattern)
    else positives.push(pattern)
  }
  return { positives, negatives, negated: negatives.length > 0 }
}

function anyGlobMatches(patterns, rel) {
  for (const pattern of patterns) {
    if (pattern.regex.test(rel)) return true
  }
  return false
}

/** `include`: positives are required (or absent = everything), a `!` wins. */
function includeAllows(include, rel) {
  if (anyGlobMatches(include.negatives, rel)) return false
  return include.positives.length === 0 || anyGlobMatches(include.positives, rel)
}

/** `exclude`: positives exclude, a `!` pattern re-includes. */
function excludeHits(exclude, rel) {
  if (exclude.positives.length === 0) return false
  if (anyGlobMatches(exclude.negatives, rel)) return false
  return anyGlobMatches(exclude.positives, rel)
}

/**
 * Can the walk skip this directory? Only patterns of the shape `dir/**` can
 * prove it, and only when the list has no `!` re-include (conservative: a
 * negated pattern may name a file deeper down). This is what keeps
 * `node_modules` from being walked at all.
 */
function excludesDirectory(exclude, rel) {
  if (rel === '' || exclude.negated) return false
  for (const pattern of exclude.positives) {
    if (pattern.dirRegex !== null && pattern.dirRegex.test(rel)) return true
  }
  return false
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Build the matching RegExp for content/name mode; bad user regex → 400. */
function buildSearchPattern(query, options) {
  let source = options.regex === true ? query : escapeRegExp(query)
  if (options.wholeWord === true) source = '\\b(?:' + source + ')\\b'
  try {
    return new RegExp(source, options.caseSensitive === true ? 'g' : 'gi')
  } catch (error) {
    if (options.regex === true) {
      throw new ApiError('bad-regex', 'invalid regular expression: ' + messageOf(error), 400)
    }
    throw badRequest('query could not be used as a pattern')
  }
}

/** Line text for a match row: the whole line, or a ≤400-char window on it. */
function matchLineText(line, column, length) {
  if (line.length <= SEARCH_TEXT_MAX_CHARS) return line
  const span = Math.min(length, SEARCH_TEXT_MAX_CHARS)
  const half = Math.floor((SEARCH_TEXT_MAX_CHARS - span) / 2)
  const start = Math.max(0, Math.min(column - half, line.length - SEARCH_TEXT_MAX_CHARS))
  return line.slice(start, start + SEARCH_TEXT_MAX_CHARS)
}

function contextAround(lines, index, direction, count) {
  const rows = []
  for (let step = 1; step <= count; step += 1) {
    const at = index + direction * step
    if (at < 0 || at >= lines.length) break
    rows.push(lines[at].slice(0, SEARCH_TEXT_MAX_CHARS))
  }
  return direction < 0 ? rows.reverse() : rows
}

/**
 * All matches of `regex` in one decoded file, ascending by line/column.
 * `budget` is how many more rows the caller may still accept: reaching it means
 * the outer response is truncated.
 */
function matchContent(text, regex, contextLines, budget) {
  const rows = []
  if (budget <= 0) return { rows, truncated: true }
  const lines = text.split(/\r\n|\n|\r/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line === '') continue
    regex.lastIndex = 0
    let match = regex.exec(line)
    while (match !== null) {
      const length = match[0].length
      if (length === 0) {
        /* A regex such as `^` or `a*` can match the empty string: advance by
           one character so the loop always makes progress. */
        regex.lastIndex = match.index + 1
        if (regex.lastIndex > line.length) break
        match = regex.exec(line)
        continue
      }
      const row = {
        line: index + 1,
        column: match.index,
        length,
        text: matchLineText(line, match.index, length),
      }
      if (contextLines > 0) {
        row.before = contextAround(lines, index, -1, contextLines)
        row.after = contextAround(lines, index, 1, contextLines)
      }
      rows.push(row)
      if (rows.length >= budget) return { rows, truncated: true }
      if (regex.lastIndex <= match.index) regex.lastIndex = match.index + length
      match = regex.exec(line)
    }
  }
  return { rows, truncated: false }
}

/** Natural order of result files: like the tree, but stable for mixed case. */
function compareRels(a, b) {
  const primary = a.localeCompare(b, 'en', { sensitivity: 'base', numeric: true })
  if (primary !== 0) return primary
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * The exclude string for this request: an explicit `exclude` (including `''`,
 * which disables the defaults), or the documented default set. The legacy
 * `includeNodeModules: true` flag only removes node_modules from those defaults.
 */
function searchExcludeSource(payload) {
  if (Object.prototype.hasOwnProperty.call(payload, 'exclude')
    && payload.exclude !== undefined && payload.exclude !== null) {
    return typeof payload.exclude === 'string' ? payload.exclude : ''
  }
  const defaults = SEARCH_DEFAULT_EXCLUDES.slice()
  if (payload.includeNodeModules === true) {
    return defaults.filter((pattern) => pattern !== 'node_modules/**').join(',')
  }
  return defaults.join(',')
}

/** The legacy `matches` projection, so the old panel keeps rendering meanwhile. */
function legacySearchRow(rel, name, stats) {
  return {
    name,
    rel,
    type: 'file',
    size: stats.size,
    mtimeMs: stats.mtimeMs,
  }
}

/* ============================== methods ============================== */

const METHODS = {
  /**
   * Available filesystem roots plus the roots recently used on this host.
   *
   * `root` is the LAST workspace this host actually served, or null when none
   * has been chosen yet. It must not default to `process.cwd()`: inside DSH that
   * is the profile directory (`~/.dsh/profiles/<name>`), and suggesting it made
   * the picker look like the profile was the workspace — the wrong thing to
   * invite edits into. The client shows its empty state until a root is chosen.
   */
  async roots() {
    return { root: recentRoots.length > 0 ? recentRoots[0] : null, drives: listDrives(), recent: [...recentRoots] }
  },

  /**
   * One level of directory browsing for the workspace-root picker. This is the
   * one route that is NOT confined to a root by design (the user is choosing
   * the root), so it only accepts an absolute existing directory.
   */
  async browse(payload) {
    const requested = payload.dir
    let dir
    if (requested === undefined || requested === null || requested === '') {
      dir = resolveInside(process.cwd(), '')
    } else {
      if (typeof requested !== 'string' || !path.isAbsolute(requested)) {
        throw badRequest('dir must be an absolute path')
      }
      dir = resolveInside(requested, '')
    }
    let dirents
    try {
      dirents = readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      throw asFailure('browse-failed', 'cannot list ' + jsonPath(dir), error)
    }
    const entries = []
    for (const dirent of dirents) {
      let isDirectory = dirent.isDirectory()
      if (!isDirectory && dirent.isSymbolicLink()) {
        /* The picker may walk through a directory link (a drive junction, for
           example); it never descends recursively, so there is no cycle risk. */
        try { isDirectory = statSync(path.join(dir, dirent.name)).isDirectory() } catch { isDirectory = false }
      }
      if (!isDirectory) continue
      const abs = path.join(dir, dirent.name)
      entries.push({
        name: dirent.name,
        rel: dirent.name,
        type: 'dir',
        path: jsonPath(abs),
        hasChildren: hasChildren(abs),
      })
    }
    sortEntries(entries)
    return { dir: jsonPath(dir), parent: parentOf(dir), entries }
  },

  /** One level of a workspace tree; hidden (dot) entries are opt-in. */
  async tree(payload) {
    const root = rootPathOf(payload)
    const dirRel = normalizeRel(payload.dir === undefined || payload.dir === null ? '' : payload.dir)
    const absDir = resolveInside(root, dirRel)
    let dirents
    try {
      dirents = readdirSync(absDir, { withFileTypes: true })
    } catch (error) {
      const code = error !== null && typeof error === 'object' ? error.code : undefined
      if (code === 'ENOENT') throw notFound('directory')
      if (code === 'ENOTDIR') throw badRequest('dir is not a directory')
      throw asFailure('tree-failed', 'cannot list ' + jsonPath(absDir), error)
    }
    const showHidden = payload.showHidden === true
    const entries = []
    for (const dirent of dirents) {
      if (!showHidden && isHiddenName(dirent.name)) continue
      const abs = path.join(absDir, dirent.name)
      let stats
      try {
        stats = lstatSync(abs)
      } catch {
        continue /* the entry vanished between readdir and lstat */
      }
      entries.push(entryFromStats(root, abs, stats))
    }
    sortEntries(entries)
    let truncated = false
    if (entries.length > TREE_MAX_ENTRIES) {
      entries.length = TREE_MAX_ENTRIES
      truncated = true
    }
    return { root: jsonPath(root), dir: relFromRoot(root, absDir), entries, truncated }
  },

  /**
   * VSCode-grade workspace search (docs/files-api.md §2.1).
   *
   * `mode:'content'` (default) walks the tree once and reports every line that
   * matches, grouped per file. `mode:'name'` is the Ctrl+P quick-open: the same
   * walk, but only entry names are matched and no file is read. Neither mode
   * follows a symlink, so a link out of the root can never turn a search into a
   * filesystem walk; the root itself is validated exactly like `tree`/`read`.
   *
   * Bounded on purpose: 20 000 files, `maxResults` matches, and a soft 6 s
   * budget. Hitting any of them returns what was found with `truncated: true`
   * instead of failing — a search must never turn into an error page.
   */
  async search(payload) {
    const startedAt = Date.now()
    const root = rootPathOf(payload)

    const mode = payload.mode === undefined || payload.mode === null || payload.mode === '' ? 'content' : payload.mode
    if (mode !== 'content' && mode !== 'name') throw badRequest('mode must be "content" or "name"')
    const query = typeof payload.query === 'string' ? payload.query : ''
    if (query.trim() === '') throw badRequest('query is required')

    const caseSensitive = payload.caseSensitive === true
    const wholeWord = payload.wholeWord === true
    const useRegex = payload.regex === true
    /* `limit` is the pre-§2.1 spelling of maxResults; the legacy panel still sends it. */
    const maxResults = clampNumber(
      payload.maxResults === undefined ? payload.limit : payload.maxResults,
      1,
      SEARCH_HARD_MAX_RESULTS,
      SEARCH_DEFAULT_MAX_RESULTS,
    )
    const maxFileSize = clampNumber(payload.maxFileSize, 1, HARD_READ_MAX_BYTES, DEFAULT_MAX_FILE_BYTES)
    const contextLines = clampNumber(payload.contextLines, 0, SEARCH_MAX_CONTEXT_LINES, 0)

    const include = compileGlobList(typeof payload.include === 'string' ? payload.include : '')
    const exclude = compileGlobList(searchExcludeSource(payload))
    const pattern = buildSearchPattern(query, { regex: useRegex, caseSensitive, wholeWord })

    const files = []
    const legacyRows = []
    let totalMatches = 0
    let scannedFiles = 0
    let truncated = false
    const deadline = startedAt + SEARCH_TIME_BUDGET_MS

    const queue = [{ dir: root, rel: '' }]
    /* Cooperatively yield to the host event loop during the scan (see yieldToHost). */
    let lastYieldAt = startedAt
    while (queue.length > 0 && !truncated) {
      if (Date.now() - lastYieldAt >= 12) {
        await yieldToHost()
        lastYieldAt = Date.now()
      }
      const current = queue.shift()
      let dirents
      try {
        dirents = readdirSync(current.dir, { withFileTypes: true })
      } catch {
        continue /* vanished or unreadable: a search skips, it does not fail */
      }
      /* Deterministic walk order, so a truncated response is reproducible. */
      dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      const subdirectories = []
      for (const dirent of dirents) {
        if (Date.now() - lastYieldAt >= 12) {
          await yieldToHost()
          lastYieldAt = Date.now()
        }
        if (Date.now() > deadline) {
          truncated = true
          break
        }
        if (dirent.isSymbolicLink()) continue /* never follow, per contract */
        const rel = current.rel === '' ? dirent.name : current.rel + '/' + dirent.name
        const abs = path.join(current.dir, dirent.name)

        if (dirent.isDirectory()) {
          if (excludesDirectory(exclude, rel)) continue
          subdirectories.push({ dir: abs, rel })
          continue
        }
        if (!dirent.isFile()) continue
        if (excludeHits(exclude, rel) || !includeAllows(include, rel)) continue
        if (scannedFiles >= SEARCH_MAX_FILES) {
          truncated = true
          break
        }
        let stats
        try {
          stats = lstatSync(abs)
        } catch {
          continue
        }
        if (stats.isSymbolicLink() || !stats.isFile()) continue
        scannedFiles += 1

        if (mode === 'name') {
          pattern.lastIndex = 0
          if (!pattern.test(dirent.name)) continue
          files.push({ rel, size: stats.size, mtimeMs: stats.mtimeMs, matches: [] })
          legacyRows.push(legacySearchRow(rel, dirent.name, stats))
          totalMatches += 1
          if (totalMatches >= maxResults) {
            truncated = true
            break
          }
          continue
        }

        if (stats.size > maxFileSize) continue /* oversize: skipped, not an error */
        let buffer
        try {
          buffer = readFileSync(abs)
        } catch {
          continue
        }
        if (hasNulByte(buffer)) continue /* binary */
        /* Invalid UTF-8 becomes U+FFFD; it must never abort the whole search.
           A leading BOM is dropped like `read` does, so columns are file-relative. */
        let text = buffer.toString('utf8')
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
        const found = matchContent(text, pattern, contextLines, maxResults - totalMatches)
        if (found.rows.length === 0) continue
        files.push({ rel, size: stats.size, mtimeMs: stats.mtimeMs, matches: found.rows })
        for (const row of found.rows) {
          legacyRows.push({ rel, line: row.line, column: row.column, length: row.length, text: row.text })
        }
        totalMatches += found.rows.length
        if (found.truncated || totalMatches >= maxResults) {
          truncated = true
          break
        }
      }
      if (!truncated && subdirectories.length > 0) queue.push(...subdirectories)
    }

    files.sort((a, b) => compareRels(a.rel, b.rel))
    return {
      root: jsonPath(root),
      mode,
      query,
      files,
      /* Legacy shape kept for the panel build that predates §2.1: file entries in
         name mode, flat match rows in content mode. */
      matches: legacyRows,
      totalMatches,
      scannedFiles,
      truncated,
      elapsedMs: Date.now() - startedAt,
    }
  },

  /** Read a file as UTF-8 text, or base64 when it looks binary. */
  async read(payload) {
    const { abs } = targetOf(payload)
    let stats
    try {
      stats = statSync(abs)
    } catch (error) {
      const code = error !== null && typeof error === 'object' ? error.code : undefined
      if (code === 'ENOENT' || code === 'ENOTDIR') throw notFound('file')
      throw asFailure('read-failed', 'cannot read file', error)
    }
    if (stats.isDirectory()) throw badRequest('rel is a directory')
    if (!stats.isFile()) throw badRequest('rel is not a regular file')
    const limit = readLimitOf(payload)
    const buffer = readSlice(abs, Math.min(stats.size, limit))
    const binary = looksBinary(buffer)
    let content = binary ? buffer.toString('base64') : buffer.toString('utf8')
    if (!binary && content.charCodeAt(0) === 0xfeff) content = content.slice(1)
    return {
      content,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      encoding: binary ? 'binary' : 'utf8',
      truncated: stats.size > limit,
    }
  },

  /**
   * Write a text file. `baseMtimeMs` is the optimistic-concurrency token the
   * panel received with the read: a mismatch means somebody else wrote the
   * file in between and the caller must resolve it (409 conflict).
   */
  async write(payload) {
    requireWrite()
    const { rel, abs } = targetOf(payload)
    if (rel === '') throw badRequest('rel is required')
    if (typeof payload.content !== 'string') throw badRequest('content must be a string')
    if (payload.content.includes('\u0000')) {
      throw badRequest('content must not contain NUL bytes; binary writes are not supported')
    }
    if (Buffer.byteLength(payload.content, 'utf8') > WRITE_MAX_BYTES) {
      throw tooLarge('content exceeds the 2 MiB write limit')
    }
    let existing = null
    try {
      existing = lstatSync(abs)
    } catch (error) {
      const code = error !== null && typeof error === 'object' ? error.code : undefined
      if (code !== 'ENOENT') throw asFailure('write-failed', 'cannot inspect target', error)
    }
    if (existing !== null && existing.isDirectory()) throw badRequest('rel is a directory')
    if (payload.baseMtimeMs !== undefined && payload.baseMtimeMs !== null) {
      const baseMtimeMs = Number(payload.baseMtimeMs)
      if (!Number.isFinite(baseMtimeMs)) throw badRequest('baseMtimeMs must be a number')
      if (existing === null) throw conflict('the file no longer exists on disk')
      if (Math.abs(existing.mtimeMs - baseMtimeMs) > 1e-3) {
        throw conflict('the file changed on disk since it was read')
      }
    }
    let parentStats
    try {
      parentStats = statSync(path.dirname(abs))
    } catch {
      throw notFound('parent directory')
    }
    if (!parentStats.isDirectory()) throw badRequest('parent is not a directory')
    try {
      writeFileSync(abs, payload.content, { encoding: 'utf8' })
    } catch (error) {
      throw asFailure('write-failed', 'cannot write file', error)
    }
    const stats = statSync(abs)
    return { size: stats.size, mtimeMs: stats.mtimeMs }
  },

  /** Stat one path inside the root (escaping symlinks are refused). */
  async stat(payload) {
    const root = rootPathOf(payload)
    const rel = normalizeRel(payload.rel === undefined || payload.rel === null ? '' : payload.rel)
    if (rel === '') return { entry: entryAt(root, root) }
    /* Security gate first: a link that leaves the root must fail even though
       the entry itself is only `lstat`ed. */
    resolveInside(root, rel)
    const lexical = resolveInside(root, rel, { followFinal: false })
    let stats
    try {
      stats = lstatSync(lexical)
    } catch (error) {
      const code = error !== null && typeof error === 'object' ? error.code : undefined
      if (code === 'ENOENT') throw notFound('path')
      throw asFailure('stat-failed', 'cannot stat path', error)
    }
    return { entry: entryFromStats(root, lexical, stats) }
  },

  async mkdir(payload) {
    requireWrite()
    const { root, rel, abs } = targetOf(payload)
    if (rel === '') throw badRequest('rel is required')
    try {
      mkdirSync(abs)
    } catch (error) {
      const code = error !== null && typeof error === 'object' ? error.code : undefined
      if (code === 'EEXIST') throw new ApiError('already-exists', 'a file or directory with that name already exists', 409)
      if (code === 'ENOENT') throw notFound('parent directory')
      throw asFailure('mkdir-failed', 'cannot create directory', error)
    }
    return { entry: entryAt(root, abs) }
  },

  /** Move/rename one entry. Both paths are confined to the same root. */
  async rename(payload) {
    requireWrite()
    const root = rootPathOf(payload)
    const fromRel = normalizeRel(payload.from, { allowEmpty: false })
    const toRel = normalizeRel(payload.to, { allowEmpty: false })
    const fromAbs = resolveInside(root, fromRel, { followFinal: false })
    const toAbs = resolveInside(root, toRel, { followFinal: false })
    let source
    try {
      source = lstatSync(fromAbs)
    } catch (error) {
      const code = error !== null && typeof error === 'object' ? error.code : undefined
      if (code === 'ENOENT') throw notFound('source path')
      throw asFailure('rename-failed', 'cannot inspect source path', error)
    }
    if (jsonPath(fromAbs) === jsonPath(toAbs)) return { entry: entryFromStats(root, fromAbs, source) }
    if (existsSync(toAbs)) {
      throw new ApiError('already-exists', 'the destination already exists', 409)
    }
    let parentStats
    try {
      parentStats = statSync(path.dirname(toAbs))
    } catch {
      throw notFound('destination parent directory')
    }
    if (!parentStats.isDirectory()) throw badRequest('destination parent is not a directory')
    try {
      renameSync(fromAbs, toAbs)
    } catch (error) {
      const code = error !== null && typeof error === 'object' ? error.code : undefined
      if (code === 'ENOENT') throw notFound('source path')
      if (code === 'EEXIST') throw new ApiError('already-exists', 'the destination already exists', 409)
      if (code === 'EXDEV') throw conflict('cannot move an entry across devices')
      if (code === 'EINVAL' || code === 'ENOTEMPTY' || code === 'EACCES' || code === 'EPERM') {
        throw conflict('cannot move this entry: ' + messageOf(error))
      }
      throw asFailure('rename-failed', 'cannot move entry', error)
    }
    return { entry: entryAt(root, toAbs) }
  },

  /** Delete one file or directory; a non-empty directory needs `recursive`. */
  async delete(payload) {
    requireWrite()
    const root = rootPathOf(payload)
    const rel = normalizeRel(payload.rel === undefined || payload.rel === null ? '' : payload.rel)
    if (rel === '') throw badRequest('refusing to delete the workspace root')
    const abs = resolveInside(root, rel, { followFinal: false })
    let stats
    try {
      stats = lstatSync(abs)
    } catch (error) {
      const code = error !== null && typeof error === 'object' ? error.code : undefined
      if (code === 'ENOENT') throw notFound('path')
      throw asFailure('delete-failed', 'cannot inspect path', error)
    }
    const recursive = payload.recursive === true
    try {
      if (stats.isSymbolicLink()) {
        /* Remove the LINK, never the target it points at. Windows may refuse
           `unlink` for a junction, so fall back to `rmdir` (still link-only). */
        try {
          unlinkSync(abs)
        } catch (error) {
          const code = error !== null && typeof error === 'object' ? error.code : undefined
          if (code === 'EPERM' || code === 'EISDIR') rmdirSync(abs)
          else throw error
        }
      } else if (stats.isDirectory()) {
        if (recursive) {
          rmSync(abs, { recursive: true, force: false })
        } else {
          try {
            rmdirSync(abs)
          } catch (error) {
            const code = error !== null && typeof error === 'object' ? error.code : undefined
            if (code === 'ENOTEMPTY' || code === 'EEXIST') {
              throw new ApiError('not-empty', 'directory is not empty; pass recursive: true to delete it', 409)
            }
            throw error
          }
        }
      } else {
        unlinkSync(abs)
      }
    } catch (error) {
      if (error instanceof ApiError) throw error
      const code = error !== null && typeof error === 'object' ? error.code : undefined
      if (code === 'ENOENT') throw notFound('path')
      throw asFailure('delete-failed', 'cannot delete path', error)
    }
    return { ok: true }
  },
}

/* ============================== media route ============================== */

/**
 * Serve one file's raw bytes. Content-Type comes from the extension only (never
 * from the bytes), `nosniff` stops the browser from second-guessing it, and the
 * sandbox CSP makes an SVG/HTML file inert even if it is opened directly — the
 * panel embeds HTML in a sandboxed iframe and images through `<img>`, so a
 * script inside a user file never runs with the app's origin.
 */
function serveFile(req, res, filePath, stats) {
  const size = stats.size
  const headers = {
    'content-type': mediaTypeFor(filePath),
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "sandbox; object-src 'none'",
    'content-disposition': 'inline',
    'accept-ranges': 'bytes',
  }
  let start = 0
  let end = size - 1
  let status = 200
  const range = headerOf(req, 'range')
  if (typeof range === 'string' && range.trim() !== '') {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    if (match !== null && (match[1] !== '' || match[2] !== '')) {
      let satisfiable = false
      if (match[1] === '') {
        const suffix = Number(match[2])
        if (suffix > 0 && size > 0) {
          start = Math.max(0, size - suffix)
          end = size - 1
          satisfiable = true
        }
      } else {
        start = Number(match[1])
        end = match[2] !== '' ? Math.min(Number(match[2]), size - 1) : size - 1
        satisfiable = start <= end && start < size
      }
      if (!satisfiable) {
        headers['content-range'] = 'bytes */' + size
        res.writeHead(416, headers)
        res.end()
        return
      }
      status = 206
      headers['content-range'] = 'bytes ' + start + '-' + end + '/' + size
      headers['content-length'] = String(end - start + 1)
    }
  }
  if (status === 200) headers['content-length'] = String(size)
  res.writeHead(status, headers)
  if (req.method === 'HEAD' || size === 0 || end < start) {
    res.end()
    return
  }
  const stream = createReadStream(filePath, { start, end })
  stream.on('error', (error) => {
    if (res.headersSent === true) {
      if (typeof res.destroy === 'function') res.destroy()
      return
    }
    sendRouteError(res, new ApiError('media-failed', 'cannot stream file: ' + messageOf(error), 500))
  })
  res.on('close', () => { stream.destroy() })
  stream.pipe(res)
}

async function handleMedia(req, res) {
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
  try {
    const root = url.searchParams.get('root')
    if (root === null || root === '') throw badRequest('root is required')
    const rel = url.searchParams.get('rel')
    const target = resolveInside(root, rel === null ? '' : rel)
    let stats
    try {
      stats = statSync(target)
    } catch (error) {
      const code = error !== null && typeof error === 'object' ? error.code : undefined
      if (code === 'ENOENT' || code === 'ENOTDIR') throw notFound('file')
      throw asFailure('media-failed', 'cannot read file', error)
    }
    if (!stats.isFile()) throw badRequest('media target is not a file')
    serveFile(req, res, target, stats)
  } catch (error) {
    sendRouteError(res, error)
  }
}

/* ============================== chunk route ============================== */

/** `<name>.js` only: no separators, no dot segments, no percent-decoded escapes. */
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
    const chunksDir = hostConfig.chunksDir
    if (!existsSync(chunksDir)) throw new ApiError('not-found', 'no chunks have been built', 404)
    const target = resolveInside(chunksDir, chunkName)
    let body
    try {
      body = readFileSync(target)
    } catch (error) {
      const code = error !== null && typeof error === 'object' ? error.code : undefined
      if (code === 'ENOENT') throw new ApiError('not-found', 'chunk "' + chunkName + '" is not built', 404)
      throw asFailure('chunk-failed', 'cannot read chunk', error)
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

/* ============================== apply ============================== */

/**
 * Apply the plugin. cordis hands the row config as the SECOND argument —
 * `ctx.config` throws on a context that did not inject `config`, and the two
 * documented keys (`allowWrite`, `maxFileBytes`) have safe defaults anyway.
 */
export function apply(ctx, config) {
  hostConfig = normalizeConfig(config)
  mountJsonApi(ctx, {
    prefix: ROUTE_PREFIX,
    methods: METHODS,
    maxBodyBytes: MAX_BODY_BYTES,
    label: name,
  })
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: MEDIA_PREFIX, handler: handleMedia }),
    name + ': media route',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: CHUNK_PREFIX, handler: handleChunk }),
    name + ': chunk route',
  )
}
