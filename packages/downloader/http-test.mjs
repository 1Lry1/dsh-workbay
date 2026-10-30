// 端到端 HTTP 测试：不用 DSH，直接起一个最小 http server 把插件的 handler 挂上，
// 然后用真实请求打各个端点，验证返回值。
//
// 这样能在装进 DSH 之前确认接口全部可用，避免"装进去发现 500"。

import http from 'node:http'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN_ROOT = path.dirname(fileURLToPath(import.meta.url))
const mod = await import(pathToFileURL(path.join(PLUGIN_ROOT, 'lib', 'index.js')).href)

// 本机部署路径来自环境变量（见 lib/index.js 顶部与 README）
const WORKSPACE = (process.env.DSH_DOWNLOADER_WORKSPACE ?? '').trim()
const SAMPLE_REPO = (process.env.DSH_DOWNLOADER_SAMPLE_REPO ?? '').trim()

let handler = null
const ctx = {
  inject(services, cb) {
    const scoped = {
      effect(fn) { fn(); },
      webServer: { register(route) { if (route.path === '/downloader') handler = route.handler; return () => { } } },
      tools: { register() { return () => { } } },
    }
    cb(scoped)
  },
}
mod.apply(ctx)
if (!handler) { console.error('没有拿到 handler'); process.exit(1) }

const server = http.createServer((req, res) => handler(req, res))
await new Promise(r => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const BASE = `http://127.0.0.1:${port}/downloader`

let pass = 0, fail = 0
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? '  ' + detail : ''}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  ' + detail : ''}`) }
}

async function jget(p) {
  const r = await fetch(BASE + p)
  return { status: r.status, body: await r.json() }
}
async function jpost(p, body) {
  const r = await fetch(BASE + p, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
  })
  return { status: r.status, body: await r.json() }
}

console.log('\n=== 1. /state ===')
{
  const r = await jget('/state')
  check('200', r.status === 200)
  check('含 serial/flash/logs', 'serial' in r.body && 'flash' in r.body && Array.isArray(r.body.logs))
}

console.log('\n=== 2. /fs/list（盘符）===')
{
  const r = await jget('/fs/list')
  check('200', r.status === 200)
  check('返回盘符列表', Array.isArray(r.body.roots) && r.body.roots.length > 0,
    (r.body.roots || []).map(x => x.name).join(','))
  check('返回常用目录', Array.isArray(r.body.fav), (r.body.fav || []).join(' | '))
}

console.log('\n=== 3. /fs/list?dir=（单层扫描）===')
if (WORKSPACE === '') {
  console.log('  SKIP  未设置 DSH_DOWNLOADER_WORKSPACE')
} else {
  const t0 = Date.now()
  const r = await jget('/fs/list?dir=' + encodeURIComponent(WORKSPACE))
  const ms = Date.now() - t0
  check('200', r.status === 200, `${ms}ms`)
  check('返回目录列表', Array.isArray(r.body.dirs) && r.body.dirs.length > 0, `${r.body.dirs?.length} 个`)
  check('标出 git 仓库', r.body.gitCount > 0, `${r.body.gitCount} 个`)
  const withBranch = (r.body.dirs || []).find(d => d.git && d.git.branch)
  check('git 项含 branch', !!withBranch, withBranch ? withBranch.git.branch : '')
}

console.log('\n=== 4. /fs/git（按需算脏状态）===')
if (SAMPLE_REPO === '') {
  console.log('  SKIP  未设置 DSH_DOWNLOADER_SAMPLE_REPO')
} else {
  const t0 = Date.now()
  const r = await jget('/fs/git?repo=' + encodeURIComponent(SAMPLE_REPO))
  const ms = Date.now() - t0
  check('200', r.status === 200, `${ms}ms`)
  check('返回 branch', !!r.body.branch, r.body.branch || r.body.error)
  check('返回改动数', typeof r.body.changed === 'number', 'changed=' + r.body.changed)
}

console.log('\n=== 5. /fs/set-root + /fs/set-project ===')
if (WORKSPACE === '') {
  console.log('  SKIP  未设置 DSH_DOWNLOADER_WORKSPACE')
} else {
  const a = await jpost('/fs/set-root', { dir: WORKSPACE })
  check('set-root 成功', a.status === 200 && a.body.ok, a.body.root)
  if (SAMPLE_REPO === '') {
    console.log('  SKIP  set-project 需要 DSH_DOWNLOADER_SAMPLE_REPO')
  } else {
    const b = await jpost('/fs/set-project', { dir: SAMPLE_REPO })
    check('set-project 成功', b.status === 200 && b.body.ok)
    check('自动找到 app.dcf', !!b.body.dcf, b.body.dcf || '未找到（可能工程结构不同）')
  }
}

console.log('\n=== 6. /serial/list（串口枚举）===')
{
  const r = await jget('/serial/list')
  check('200', r.status === 200)
  check('返回 ports 数组', Array.isArray(r.body.ports), `${(r.body.ports || []).length} 个`)
  // 端口号会因为拔插/换 USB 口而变化（实测经历过 COM11 -> COM22），
  // 所以不能写死。取带真实描述的那个（CP210x/CH34x/FTDI 之一）。
  const real = (r.body.ports || []).find(p => /CP210|Silicon|CH34|FTDI/i.test(p.desc || ''))
  check('找到真实串口且带描述', !!real, real ? real.name + ' ' + real.desc : '无')
  global.__REAL_PORT = real ? real.name : null
}

console.log('\n=== 7. /serial/open + close ===')
{
  const rp = global.__REAL_PORT
  if (!rp) { check('真实串口打开', false, '没有可用真实串口'); }
  else {
    const open = await jpost('/serial/open', { port: rp, baud: 1500000 })
    check(rp + ' @1500000 打开', open.body.ok === true, JSON.stringify(open.body))
  }
  const st = await jget('/state')
  check('/state 反映串口已开', st.body.serial.open === true, JSON.stringify(st.body.serial))
  const close = await jpost('/serial/close', {})
  check('关闭成功', close.body.ok === true)
}

console.log('\n=== 8. /serial/write 错误处理 ===')
{
  const r = await jpost('/serial/write', { text: 'hello' })
  check('未开串口时写入被拒', r.body.ok === false, JSON.stringify(r.body))
}

console.log('\n=== 10. /flash/config ===')
{
  const r = await jget('/flash/config')
  check('200', r.status === 200)
  check('返回 Downloader 目录', !!r.body.dir, r.body.dir)
  check('读到 config 槽位', Array.isArray(r.body.slots), `${(r.body.slots || []).length} 个 DownFile 槽`)
}

console.log('\n=== 11. 404 ===')
{
  const r = await jget('/nope')
  check('未知路径返回 404', r.status === 404)
}

console.log('\n=== 12. SSE ===')
{
  const ctrl = new AbortController()
  const r = await fetch(BASE + '/events', { signal: ctrl.signal })
  check('SSE 200', r.status === 200)
  check('content-type 正确', /text\/event-stream/.test(r.headers.get('content-type') || ''),
    r.headers.get('content-type'))
  const reader = r.body.getReader()
  const { value } = await reader.read()
  const txt = new TextDecoder().decode(value || new Uint8Array())
  check('收到 hello 事件', txt.includes('"ev":"hello"'), txt.slice(0, 60).replace(/\n/g, ' '))
  ctrl.abort()
}

console.log('\n===== SUMMARY =====')
console.log(`  PASS ${pass}`)
console.log(`  FAIL ${fail}`)
server.close()
process.exit(fail === 0 ? 0 : 1)
