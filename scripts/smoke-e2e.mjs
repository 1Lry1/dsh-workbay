/**
 * Non-UI end-to-end smoke test for the two new bundles, against a REAL workspace.
 *
 * Boots `dsh-workbay-files` and `dsh-workbay-terminal` on a local HTTP server
 * with a minimal cordis-like context (the same fake the package tests use) and
 * exercises the paths the browser will take:
 *
 *   files:    roots -> tree(repo root) -> read(package.json) -> write(round-trip,
 *             conflict) -> search -> media(png) -> chunk(editor.js) with ETag/304
 *   terminal: start -> input(echo) -> SSE output -> stop -> exit
 *
 * Run from the repo root:  node scripts/smoke-e2e.mjs
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const filesPlugin = await import(pathToFileURL(path.join(repoRoot, 'packages/files/src/index.js')).href)
const terminalPlugin = await import(pathToFileURL(path.join(repoRoot, 'packages/terminal/src/index.js')).href)

function fakeCtx() {
  const routes = []
  return {
    routes,
    effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d() } },
    webServer: {
      register(route) { routes.push(route); return () => { const i = routes.indexOf(route); if (i >= 0) routes.splice(i, 1) } },
    },
    inject() { return { dispose() {} } },
    config: undefined,
  }
}

function dispatch(routes) {
  return async (req, res) => {
    const url = new URL(req.url, 'http://dsh.internal')
    const route = routes.find((r) => url.pathname === r.path || url.pathname.startsWith(r.path + '/'))
    if (route === undefined) { res.writeHead(404); res.end('no route'); return }
    await route.handler(req, res)
  }
}

const filesCtx = fakeCtx()
filesPlugin.apply(filesCtx, { allowWrite: true, maxFileBytes: 1048576 })
const terminalCtx = fakeCtx()
terminalPlugin.apply(terminalCtx, { shell: 'powershell', maxSessions: 2, idleTimeoutMs: 60000 })

const server = createServer(dispatch([...filesCtx.routes, ...terminalCtx.routes]))
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`

let failures = 0
function check(name, cond, detail = '') {
  if (cond) console.log(`  PASS  ${name}${detail ? '  ' + detail : ''}`)
  else { failures += 1; console.log(`  FAIL  ${name}${detail ? '  ' + detail : ''}`) }
}

const post = async (prefix, method, body) => {
  const res = await fetch(`${origin}${prefix}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', connection: 'close' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

console.log('== files: roots / tree')
const roots = await post('/dsh-workbay-files', 'roots', {})
check('roots 200', roots.status === 200 && roots.body.ok === true)
check('roots 至少有一个盘符', Array.isArray(roots.body.data?.drives) && roots.body.data.drives.length > 0)

const tree = await post('/dsh-workbay-files', 'tree', { root: repoRoot, dir: '' })
check('tree 200', tree.status === 200 && tree.body.ok === true)
check('tree 含 packages/', tree.body.data.entries.some((e) => e.name === 'packages' && e.type === 'dir'))
check('tree 含 README.md', tree.body.data.entries.some((e) => e.name === 'README.md'))

console.log('== files: read / write / conflict')
const read = await post('/dsh-workbay-files', 'read', { root: repoRoot, rel: 'package.json' })
check('read 200', read.status === 200 && read.body.ok === true)
check('read 返回 JSON 文本', typeof read.body.data.content === 'string' && read.body.data.content.includes('"name"'))
const originalMtime = read.body.data.mtimeMs

const tmp = mkdtempSync(path.join(tmpdir(), 'workbay-smoke-'))
try {
  const target = path.join(tmp, 'note.txt')
  writeFileSync(target, 'hello\n')
  const stat = await post('/dsh-workbay-files', 'stat', { root: tmp, rel: 'note.txt' })
  check('stat 200', stat.status === 200 && stat.body.ok === true)

  const write1 = await post('/dsh-workbay-files', 'write', { root: tmp, rel: 'note.txt', content: 'hello world\n', baseMtimeMs: stat.body.data.entry.mtimeMs })
  check('write 200', write1.status === 200 && write1.body.ok === true)
  check('write 落盘', readFileSync(target, 'utf8') === 'hello world\n')

  const conflict = await post('/dsh-workbay-files', 'write', { root: tmp, rel: 'note.txt', content: 'x', baseMtimeMs: 1 })
  check('stale write 409', conflict.status === 409 || conflict.body.error?.code === 'conflict', JSON.stringify(conflict.body.error))

  const escape = await post('/dsh-workbay-files', 'read', { root: tmp, rel: '../README.md' })
  check('越界 read 被拒', escape.status === 403 || escape.status === 400)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

console.log('== files: search / media / chunk')
const search = await post('/dsh-workbay-files', 'search', { root: repoRoot, query: 'package', limit: 20 })
check('search 200', search.status === 200 && search.body.ok === true)
check('search 有结果', Array.isArray(search.body.data.matches) && search.body.data.matches.length > 0, `${search.body.data?.matches?.length} 条`)

/* VSCode-level content search (docs/files-api.md §2.1). */
const startedSearch = Date.now()
const content = await post('/dsh-workbay-files', 'search', {
  root: repoRoot,
  mode: 'content',
  query: 'workbench',
  caseSensitive: false,
  wholeWord: true,
  include: 'packages/**/*.md,docs/**/*.md',
  exclude: '',
  maxResults: 50,
  contextLines: 1,
})
const contentMs = Date.now() - startedSearch
check('content search 200', content.status === 200 && content.body.ok === true, JSON.stringify(content.body.error))
check('content search returns grouped files', Array.isArray(content.body.data?.files) && content.body.data.files.length > 0, `${content.body.data?.files?.length} 个文件`)
const firstMatch = content.body.data?.files?.[0]?.matches?.[0]
check('content match has line/column/text', typeof firstMatch?.line === 'number' && typeof firstMatch?.column === 'number' && typeof firstMatch?.text === 'string')
check('content search context lines', Array.isArray(firstMatch?.before) && Array.isArray(firstMatch?.after))
check('content search is fast enough', contentMs < 6000, `${contentMs} ms`)

const nameSearch = await post('/dsh-workbay-files', 'search', { root: repoRoot, mode: 'name', query: 'workbay', maxResults: 10 })
check('name search 200', nameSearch.status === 200 && nameSearch.body.ok === true && Array.isArray(nameSearch.body.data?.files))

const badRegex = await post('/dsh-workbay-files', 'search', { root: repoRoot, mode: 'content', query: '([', regex: true })
check('bad regex 400', badRegex.status === 400 && badRegex.body.error?.code === 'bad-regex', JSON.stringify(badRegex.body.error))

const media = await fetch(`${origin}/dsh-workbay-files/media?root=${encodeURIComponent(repoRoot)}&rel=${encodeURIComponent('packages/gitcraft/docs/panel.png')}`)
check('media png 200', media.status === 200)
check('media content-type', (media.headers.get('content-type') || '').startsWith('image/png'), media.headers.get('content-type'))
check('media nosniff', media.headers.get('x-content-type-options') === 'nosniff')
check('media 有 CSP sandbox', (media.headers.get('content-security-policy') || '').includes('sandbox'))
await media.arrayBuffer()

const chunk = await fetch(`${origin}/dsh-workbay-files/chunk/editor.js`)
const chunkText = await chunk.text()
check('chunk 200', chunk.status === 200)
check('chunk 是 editor 注册脚本', chunkText.includes("__dshChunks__['dsh-workbay-files:editor']") || chunkText.includes('__dshChunks__["dsh-workbay-files:editor"]'))
check('chunk 体积 > 500KB', chunkText.length > 500 * 1024, `${Math.round(chunkText.length / 1024)} KB`)
const etag = chunk.headers.get('etag')
if (etag) {
  const revalidated = await fetch(`${origin}/dsh-workbay-files/chunk/editor.js`, { headers: { 'if-none-match': etag } })
  check('chunk ETag 304', revalidated.status === 304, String(revalidated.status))
} else {
  check('chunk 有 ETag', false)
}

console.log('== terminal: warm the shell (cold start is slow on CI runners)')
await new Promise((resolve) => {
  const deadline = Date.now() + 120000
  let settled = false
  const finish = () => { if (!settled) { settled = true; resolve() } }
  try {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'echo warmup'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    child.on('close', finish)
    child.on('error', finish)
  } catch { finish() }
  const timer = setInterval(() => { if (Date.now() > deadline) { clearInterval(timer); finish() } }, 500)
  if (typeof timer.unref === 'function') timer.unref()
})

console.log('== terminal: start / echo / stop')
const started = await post('/dsh-workbay-terminal', 'start', { root: repoRoot })
check('start 200', started.status === 200 && started.body.ok === true)
const session = started.body.data
check('start 返回 id/cwd', typeof session?.id === 'string' && session?.cwd?.toLowerCase().includes('dsh-workbay'))

const events = []
const sseAbort = new AbortController()
const ssePromise = (async () => {
  const res = await fetch(`${origin}/dsh-workbay-terminal/events?id=${encodeURIComponent(session.id)}`, { signal: sseAbort.signal })
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        const line = frame.split('\n').find((l) => l.startsWith('data: '))
        if (line !== undefined) events.push(JSON.parse(line.slice(6)))
      }
    }
  } catch { /* aborted */ }
})()
await new Promise((r) => setTimeout(r, 300))

await post('/dsh-workbay-terminal', 'input', { id: session.id, data: 'echo workbay-smoke-ok\r\n' })
const echoed = await new Promise((resolve) => {
  const deadline = Date.now() + 45000
  const tick = () => {
    if (events.some((e) => e.type === 'out' && String(e.data).includes('workbay-smoke-ok'))) return resolve(true)
    if (Date.now() > deadline) return resolve(false)
    setTimeout(tick, 100)
  }
  tick()
})
check('终端回显 echo 输出', echoed === true)

const stopped = await post('/dsh-workbay-terminal', 'stop', { id: session.id })
check('stop 200', stopped.status === 200 && stopped.body.ok === true)
const exited = await new Promise((resolve) => {
  const deadline = Date.now() + 20000
  const tick = () => {
    if (events.some((e) => e.type === 'exit')) return resolve(true)
    if (Date.now() > deadline) return resolve(false)
    setTimeout(tick, 100)
  }
  tick()
})
check('收到 exit 事件', exited === true)
const listed = await post('/dsh-workbay-terminal', 'list', {})
check('list 为空', Array.isArray(listed.body.data?.sessions) && listed.body.data.sessions.length === 0)
sseAbort.abort()
await ssePromise

console.log(failures === 0 ? '\nSMOKE PASS' : `\nSMOKE FAIL (${failures})`)
await new Promise((r) => server.close(r))
process.exitCode = failures === 0 ? 0 : 1
