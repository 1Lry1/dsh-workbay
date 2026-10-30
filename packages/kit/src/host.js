/**
 * @dsh-workbench/kit — host-side helpers shared by the workbench bundles.
 *
 * Scope: the Node half only. DSH loads a plugin's browser half through
 * `window.__ModuleLoader__.load({ id, factory })` as one self-contained file
 * with a `require` seed table, so client code cannot import this package. The
 * (small) dock-page registration snippet therefore stays duplicated in the two
 * page plugins on purpose — see docs/architecture.md.
 *
 * Three things live here:
 *
 *   1. the trust fence every plugin route uses (loopback peer / loopback Host /
 *      same-origin Sec-Fetch-Site);
 *   2. bounded JSON body reading;
 *   3. the `POST <prefix>/<method>` RPC surface with the
 *      `{ ok: true, data } | { ok: false, error: { code, message } }` envelope,
 *      which is what dsh-workbench-dock and dsh-gitcraft both expose.
 *
 * dsh-downloader does not use (3): its host also streams SSE and binary frames,
 * which is a different shape from a JSON RPC map.
 */

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
