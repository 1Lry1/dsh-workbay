/**
 * @dsh-workbay/kit — host-side helpers shared by the workbench bundles.
 *
 * Scope: the Node half only. DSH loads a plugin's browser half through
 * `window.__ModuleLoader__.load({ id, factory })` as one self-contained file
 * with a `require` seed table, so client code cannot import this package. The
 * (small) dock-page registration snippet therefore stays duplicated in the two
 * page plugins on purpose — see docs/architecture.md.
 *
 * Four things live here:
 *
 *   1. the trust fence every plugin route uses (loopback peer / loopback Host /
 *      same-origin Sec-Fetch-Site);
 *   2. bounded JSON body reading;
 *   3. the `POST <prefix>/<method>` RPC surface with the
 *      `{ ok: true, data } | { ok: false, error: { code, message } }` envelope,
 *      which is what dsh-workbay-dock and dsh-gitcraft both expose;
 *   4. filesystem path helpers for the bundles that serve a workspace root
 *      (`resolveInside` / `normalizeRel`) and for binary routes
 *      (`mediaTypeFor`). dsh-workbay-files and dsh-workbay-terminal both need
 *      the same "the client may only name a path inside this root" rule, and a
 *      home-grown realpath check is exactly the kind of code that drifts.
 *
 * dsh-downloader does not use (3): its host also streams SSE and binary frames,
 * which is a different shape from a JSON RPC map.
 */
import { lstatSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'

export const DEFAULT_MAX_BODY_BYTES = 64 * 1024

/** An error the handler may expose to the caller, with an HTTP status. */
export class ApiError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
    this.expose = true
  }
}

export function badRequest(message) {
  return new ApiError('bad-request', message, 400)
}

export function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function headerOf(req, name) {
  const value = req.headers === undefined ? undefined : req.headers[name]
  if (Array.isArray(value)) return value[0]
  return typeof value === 'string' ? value : undefined
}

function isLoopbackPeer(req) {
  const socket = req.socket === undefined || req.socket === null ? undefined : req.socket
  const peer = socket === undefined ? undefined : socket.remoteAddress
  return typeof peer === 'string'
    && (peer === '::1' || peer === '127.0.0.1' || /^127\./.test(peer) || /^::ffff:127\./.test(peer))
}

/** Host header -> hostname, tolerating the bracketed IPv6 form and an optional port. */
function hostnameOf(rawHost) {
  const host = String(rawHost).trim()
  if (host === '') return ''
  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    return end === -1 ? host : host.slice(1, end)
  }
  const colon = host.lastIndexOf(':')
  /* A bare IPv6 literal has several colons and keeps no port suffix. */
  return colon === -1 || host.indexOf(':') !== colon ? host : host.slice(0, colon)
}

/**
 * Same-origin fence for routes mounted on DSH's own web server.
 *
 * The desktop shell serves the renderer from the custom scheme `dsh-app://app/`,
 * so a request proxied to a plugin route carries no loopback Host header. The
 * TCP peer is what identifies the caller there: a loopback peer is the same
 * trust boundary as a loopback Host. Otherwise the Host header must name a
 * loopback authority, or the browser must mark the request same-origin/same-site
 * (`Sec-Fetch-Site`), which a cross-site page cannot forge.
 */
export function isTrustedRequest(req) {
  if (isLoopbackPeer(req)) return true
  const hostname = hostnameOf(headerOf(req, 'host') ?? '')
  if (hostname === '') return false
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '0.0.0.0') return true
  if (/^127\./.test(hostname)) return true
  const site = headerOf(req, 'sec-fetch-site')
  return site === 'same-origin' || site === 'same-site'
}

export function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/** Read a JSON object body, bounded; an empty body means `{}`. */
export function readJsonBody(req, limit = DEFAULT_MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        fail(new ApiError('too-large', 'request body is too large', 413))
        if (typeof req.destroy === 'function') req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.trim() === '') {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(raw)
        resolve(parsed !== null && typeof parsed === 'object' ? parsed : {})
      } catch {
        reject(badRequest('request body must be JSON'))
      }
    })
    req.on('error', (error) => { fail(new ApiError('transport', messageOf(error), 500)) })
  })
}

/** Map any thrown value onto the response envelope, exposing only safe detail. */
function errorBody(error) {
  if (error instanceof ApiError) {
    return { status: error.status, body: { code: error.code, message: error.message } }
  }
  /* Duck-typed: the page plugins keep their own error classes (PanelError,
     DockError) and must not have to import the kit to be understood here. */
  if (error !== null && typeof error === 'object'
    && typeof error.status === 'number' && typeof error.code === 'string') {
    return { status: error.status, body: { code: error.code, message: messageOf(error) } }
  }
  return { status: 500, body: { code: 'internal', message: messageOf(error) } }
}

/**
 * Build the `POST <prefix>/<method>` handler.
 *
 * @param {object} options
 * @param {string} options.prefix           route prefix, e.g. '/dsh-gitcraft/api'
 * @param {Record<string, (payload: object) => any>} options.methods
 * @param {number} [options.maxBodyBytes]
 * @param {(method: string, payload: object, invoke: () => Promise<any>) => Promise<any>} [options.run]
 *        optional wrapper around the method call — used for per-repository write
 *        locks and similar serialisation.
 * @returns {(req: any, res: any) => Promise<void>}
 */
export function createJsonApiHandler(options) {
  const { prefix, methods, maxBodyBytes = DEFAULT_MAX_BODY_BYTES, run } = options
  if (typeof prefix !== 'string' || prefix === '') throw new TypeError('prefix is required')
  if (methods === null || typeof methods !== 'object') throw new TypeError('methods map is required')

  return async function handle(req, res) {
    if (!isTrustedRequest(req)) {
      sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
      return
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: { code: 'method-error', message: 'POST required' } })
      return
    }
    const pathname = new URL(req.url === undefined ? '/' : req.url, 'http://dsh.internal').pathname
    const method = pathname.startsWith(prefix + '/') ? pathname.slice(prefix.length + 1) : ''
    const handler = Object.prototype.hasOwnProperty.call(methods, method) ? methods[method] : undefined
    if (handler === undefined || method.includes('/')) {
      sendJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown method "' + method + '"' } })
      return
    }
    try {
      const payload = await readJsonBody(req, maxBodyBytes)
      const invoke = () => handler(payload)
      const data = run === undefined ? await invoke() : await run(method, payload, invoke)
      sendJson(res, 200, { ok: true, data })
    } catch (error) {
      const { status, body } = errorBody(error)
      sendJson(res, status, { ok: false, error: body })
    }
  }
}

/** Register the handler on the plugin's web server and dispose it with the ctx. */
export function mountJsonApi(ctx, options) {
  const { label = options.prefix, ...rest } = options
  const handler = createJsonApiHandler(rest)
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: options.prefix, handler }),
    label + ': api routes',
  )
  return handler
}

/* ============================== filesystem paths ============================== */

/* Windows and macOS compare paths case-insensitively; Linux does not. Getting
   this wrong turns "inside the root" into a per-machine bug. */
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin'

function realpathOf(value) {
  /* `realpathSync.native` expands 8.3 short names (`RUNNER~1`) and subst/
     symlinked drives, which is what makes a TMP-style root comparable to the
     paths Node reports for its children. */
  return typeof realpathSync.native === 'function' ? realpathSync.native(value) : realpathSync(value)
}

function outsideRoot(message) {
  return new ApiError('outside-root', message, 403)
}

/**
 * Is `target` the root itself or a descendant of it?
 *
 * This is a PREFIX ON SEGMENT BOUNDARIES: `C:\ws2` must not count as inside
 * `C:\ws`, which a bare `startsWith` would allow.
 */
export function isRealPathInside(root, target) {
  const left = CASE_INSENSITIVE_FS ? root.toLowerCase() : root
  const right = CASE_INSENSITIVE_FS ? target.toLowerCase() : target
  if (right === left) return true
  const boundary = left.endsWith(path.sep) ? left : left + path.sep
  return right.startsWith(boundary)
}

/**
 * Validate and normalise a client-supplied workspace-relative path.
 *
 * The contract is POSIX-only: `a/b/c`, never absolute, never a `..` segment,
 * never a backslash (on Windows `path.resolve` would happily treat it as a
 * separator and `a\..\..\x` would leave the root). Empty means "the root
 * itself" unless `allowEmpty: false`.
 *
 * @param {unknown} rel
 * @param {{ allowEmpty?: boolean }} [options]
 * @returns {string} normalised relative path ('' for the root)
 */
export function normalizeRel(rel, options = {}) {
  const allowEmpty = options.allowEmpty === undefined ? true : options.allowEmpty === true
  const raw = rel === undefined || rel === null ? '' : rel
  if (typeof raw !== 'string') throw badRequest('rel must be a string')
  if (raw.length > 4096) throw badRequest('rel is too long')
  if (raw.includes('\u0000')) throw badRequest('rel must not contain NUL')
  if (raw.includes('\\')) throw badRequest('rel must use POSIX separators ("/")')
  if (raw.startsWith('/')) throw badRequest('rel must be a relative path')
  /* `C:foo` is drive-relative on Windows: it resolves against that drive's
     current directory, not against the root. */
  if (/^[A-Za-z]:/.test(raw)) throw badRequest('rel must be a relative path')
  const segments = []
  for (const segment of raw.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') throw badRequest('rel must not contain ".."')
    /* Names such as `...` are dot-only and collapse to `.`/`..` on Windows. */
    if (/^\.+$/.test(segment)) throw badRequest('rel contains an invalid segment')
    segments.push(segment)
  }
  if (segments.length === 0) {
    if (!allowEmpty) throw badRequest('rel is required')
    return ''
  }
  return segments.join('/')
}

/**
 * Resolve `rel` inside `root` and prove the RESULT is still inside `root`.
 *
 * Steps: the root must be an absolute, existing directory; its own realpath is
 * the confinement boundary. Every existing segment is `lstat`ed and symlinks
 * are followed only after their realpath has been checked against that
 * boundary. A missing tail (a write/mkdir/rename destination) is appended
 * lexically to the last real directory, which is safe because that directory
 * has itself been proven to be inside the root.
 *
 * `followFinal: false` stops before resolving the LAST segment. Use it for
 * directory-entry operations (stat/unlink/rename) that must act on a symlink
 * itself rather than its target. Never use it before opening a file.
 *
 * @param {string} root absolute path to an existing directory
 * @param {string} [rel] POSIX relative path
 * @param {{ followFinal?: boolean }} [options]
 * @returns {string} absolute path confined to the root's realpath
 * @throws {ApiError} 400 `bad-request` for a malformed root/rel,
 *                    403 `outside-root` for a symlink escape or dangling link
 */
export function resolveInside(root, rel, options = {}) {
  const followFinal = options.followFinal === undefined ? true : options.followFinal === true
  if (typeof root !== 'string' || root.trim() === '') throw badRequest('root is required')
  if (!path.isAbsolute(root)) throw badRequest('root must be an absolute path')
  let rootReal
  try {
    rootReal = realpathOf(path.resolve(root))
  } catch {
    throw badRequest('root does not exist')
  }
  let rootStats
  try {
    rootStats = statSync(rootReal)
  } catch {
    throw badRequest('root is not accessible')
  }
  if (!rootStats.isDirectory()) throw badRequest('root is not a directory')

  const normalized = normalizeRel(rel === undefined || rel === null ? '' : rel)
  if (normalized === '') return rootReal

  const segments = normalized.split('/')
  let current = rootReal
  for (let index = 0; index < segments.length; index += 1) {
    const next = path.join(current, segments[index])
    const isFinal = index === segments.length - 1
    let stats
    try {
      stats = lstatSync(next)
    } catch (error) {
      const code = error !== null && typeof error === 'object' ? error.code : undefined
      if (code === 'ENOENT') {
        /* Nothing here yet: the remainder does not exist, so appending it to a
           proven-inside directory cannot leave the root. */
        return path.join(current, ...segments.slice(index))
      }
      if (code === 'ENOTDIR') throw badRequest('a parent segment is not a directory')
      throw new ApiError('fs-error', 'cannot inspect path: ' + messageOf(error), 500)
    }
    if (!stats.isSymbolicLink()) {
      current = next
      continue
    }
    /* A final symlink that callers only unlink/rename may be returned as-is
       (the link lives inside the root even when its target does not). */
    if (isFinal && followFinal === false) return next
    let resolved
    try {
      resolved = realpathOf(next)
    } catch {
      /* A dangling link could point anywhere; we cannot prove containment. */
      throw outsideRoot('refusing to follow a dangling symlink')
    }
    if (!isRealPathInside(rootReal, resolved)) {
      throw outsideRoot('path escapes the workspace root')
    }
    current = resolved
  }
  return current
}

/* Text formats get a charset so a browser does not have to guess; binary ones
   keep the bare media type. An unknown extension is deliberately not sniffed
   (the media route also sends `nosniff`). */
const MEDIA_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.xhtml': 'application/xhtml+xml; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
})

/**
 * Content-Type for a file path. Unknown extensions fall back to
 * `application/octet-stream` — never to a type the browser would render.
 *
 * @param {unknown} filePath
 * @returns {string}
 */
export function mediaTypeFor(filePath) {
  if (typeof filePath !== 'string' || filePath === '') return 'application/octet-stream'
  const extension = path.extname(filePath).toLowerCase()
  if (extension === '') return 'application/octet-stream'
  return Object.prototype.hasOwnProperty.call(MEDIA_TYPES, extension)
    ? MEDIA_TYPES[extension]
    : 'application/octet-stream'
}
