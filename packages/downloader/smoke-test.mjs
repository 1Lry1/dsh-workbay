// 冒烟测试：不依赖 DSH，直接用 Node 跑 host 半侧的核心逻辑
// 覆盖：目录扫描、git 双轨识别、串口 helper、烧录 IPC helper、自动烧录
// 用法：node smoke-test.mjs

import path from 'node:path'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)))
const SERIAL_HELPER = path.join(ROOT, 'helper', 'AbSerialHost.exe')
const IPC_HELPER = path.join(ROOT, 'ipc-helper', 'DownloaderIpcBridge.exe')
// 本机部署路径全部来自环境变量（见 lib/index.js 顶部与 README）：
//   DSH_DOWNLOADER_DIR         厂商 Downloader 安装目录
//   DSH_DOWNLOADER_WORKSPACE   存放 SDK 工程的根目录
//   DSH_DOWNLOADER_SAMPLE_REPO 一个真实 git 仓库，用于元数据 / status 断言
const DL_DIR = (process.env.DSH_DOWNLOADER_DIR ?? '').trim()
const DL_EXE = DL_DIR === '' ? '' : path.join(DL_DIR, 'Downloader.exe')
const WORKSPACE = (process.env.DSH_DOWNLOADER_WORKSPACE ?? '').trim()
const SAMPLE_REPO = (process.env.DSH_DOWNLOADER_SAMPLE_REPO ?? '').trim()

let pass = 0
let fail = 0
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? '  ' + detail : ''}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  ' + detail : ''}`) }
}

// ---------- 1. 目录扫描 + git 双轨 ----------

const SKIP_DIR = new Set(['node_modules', '__pycache__', '.git', '.svn', '.hg', '.vs', '.repo',
  'System Volume Information', '$RECYCLE.BIN', 'cmake', 'obj'])
const SKIP_OPT = new Set(['Output', 'build', 'dist', 'target'])

async function readGitMeta(repoDir) {
  const dotGit = path.join(repoDir, '.git')
  let gitDir = dotGit
  let st
  try { st = await fs.promises.stat(dotGit) } catch { return null }
  if (st.isFile()) {
    try {
      const txt = await fs.promises.readFile(dotGit, 'utf8')
      const m = /^gitdir:\s*(.+)$/m.exec(txt)
      if (!m) return { kind: 'broken', reason: 'no gitdir' }
      const raw = m[1].trim()
      gitDir = path.isAbsolute(raw) ? raw : path.resolve(repoDir, raw)
    } catch { return null }
  }
  let head
  try { head = (await fs.promises.readFile(path.join(gitDir, 'HEAD'), 'utf8')).trim() }
  catch { return { kind: 'broken', reason: 'HEAD unreadable' } }
  let branch = null, detached = false
  if (head.startsWith('ref:')) branch = head.slice(4).trim().replace(/^refs\/heads\//, '')
  else if (/^[0-9a-f]{40}$/i.test(head)) { detached = true; branch = head.slice(0, 8) }
  let remote = null
  try {
    const cfg = await fs.promises.readFile(path.join(gitDir, 'config'), 'utf8')
    const m = /\[remote\s+"[^"]+"\][^\[]*?url\s*=\s*(\S+)/i.exec(cfg)
    if (m) {
      const host = /^(?:https?|ssh|git):\/\/([^/:]+)/.exec(m[1]) || /^[\w.-]+@([\w.-]+):/.exec(m[1])
      remote = host ? host[1] : m[1]
    }
  } catch { }
  return { kind: st.isFile() ? 'submodule' : 'normal', branch, detached, remote, dirty: null }
}

async function scanLevel(dir) {
  let ents
  try { ents = await fs.promises.readdir(dir, { withFileTypes: true }) } catch (e) { return { error: e.message, dirs: [] } }
  const dirs = []
  for (const e of ents) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue
    if (SKIP_DIR.has(e.name) || SKIP_OPT.has(e.name)) continue
    dirs.push({ name: e.name, path: path.join(dir, e.name) })
  }
  const infos = await Promise.all(dirs.map(d => readGitMeta(d.path)))
  dirs.forEach((d, i) => { if (infos[i]) d.git = infos[i] })
  dirs.sort((a, b) => (!!a.git !== !!b.git) ? (a.git ? -1 : 1) : a.name.localeCompare(b.name, 'zh-CN'))
  return { dir, dirs, gitCount: dirs.filter(d => d.git).length }
}

function gitStatus(repoDir, timeoutMs = 8000) {
  return new Promise(resolve => {
    let out = '', err = '', done = false
    const child = spawn(process.env.GIT_EXE || 'git',
      ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=no'],
      { cwd: repoDir, windowsHide: true })
    const finish = v => { if (!done) { done = true; resolve(v) } }
    const timer = setTimeout(() => { try { child.kill() } catch { } finish({ error: 'timeout' }) }, timeoutMs)
    child.stdout.on('data', d => out += d.toString('utf8'))
    child.stderr.on('data', d => err += d.toString('utf8'))
    child.on('error', e => { clearTimeout(timer); finish({ error: e.message }) })
    child.on('close', code => {
      clearTimeout(timer)
      if (code !== 0) return finish({ error: err.trim() || 'exit ' + code })
      let branch = null, ahead = 0, behind = 0, changed = 0
      for (const rec of out.split('\0')) {
        if (!rec) continue
        if (rec.startsWith('# branch.head ')) branch = rec.slice(14).trim()
        else if (rec.startsWith('# branch.ab ')) {
          const m = /\+(\d+)\s+-(\d+)/.exec(rec); if (m) { ahead = +m[1]; behind = +m[2] }
        } else if (/^[12u?] /.test(rec)) changed++
      }
      finish({ branch, ahead, behind, changed, dirty: changed > 0 })
    })
  })
}

console.log('\n=== 1. 目录扫描 ===')
if (WORKSPACE === '') {
  console.log('  SKIP  未设置 DSH_DOWNLOADER_WORKSPACE')
} else {
  const t0 = Date.now()
  const r = await scanLevel(WORKSPACE)
  const ms = Date.now() - t0
  check('扫描工作区成功', !r.error, `${r.dirs?.length} 目录 / ${r.gitCount} git / ${ms}ms`)
  check('首层扫描 < 500ms', ms < 500, `${ms}ms`)
  check('返回目录列表', (r.dirs?.length ?? 0) > 0)
  check('识别到 git 仓库', r.gitCount > 0, `${r.gitCount} 个`)
}

console.log('\n=== 2. git 元数据（form 三态）===')
if (SAMPLE_REPO === '') {
  console.log('  SKIP  未设置 DSH_DOWNLOADER_SAMPLE_REPO')
} else {
  const m = await readGitMeta(SAMPLE_REPO)
  check('git 元数据可解析', !!m, m ? `kind=${m.kind} branch=${m.branch} remote=${m.remote}` : 'null')
  check('kind 合法', !!m && ['normal', 'submodule', 'broken'].includes(m.kind), m ? m.kind : 'null')
  if (m && m.kind === 'broken') check('broken 形态带原因', !!m.reason, m.reason || '')
}

console.log('\n=== 3. git status（按需 spawn）===')
if (SAMPLE_REPO === '') {
  console.log('  SKIP  未设置 DSH_DOWNLOADER_SAMPLE_REPO')
} else {
  const t0 = Date.now()
  const st = await gitStatus(SAMPLE_REPO)
  const ms = Date.now() - t0
  check('git status 成功', !st.error, `${ms}ms branch=${st.branch} 改动=${st.changed}`)
  // 阈值放宽到 3s：热缓存 200-250ms，机器忙/冷缓存会到 1.5s。
  // 这里只防"跑成了分钟级"的异常，不做性能断言。
  check('耗时在合理范围(<3000ms)', ms < 3000, `${ms}ms`)
  check('拿到分支名', !!st.branch, st.branch)
}

console.log('\n=== 4. 串口 helper（64 位 .NET，1.5M）===')
{
  check('AbSerialHost.exe 存在', fs.existsSync(SERIAL_HELPER), SERIAL_HELPER)
  const r = await new Promise(resolve => {
    const p = spawn(SERIAL_HELPER, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const rl = createInterface({ input: p.stdout })
    const out = []
    rl.on('line', l => { try { out.push(JSON.parse(l)) } catch { } })
    p.stdin.write(JSON.stringify({ id: 1, op: 'list' }) + '\n')
    setTimeout(() => {
      p.stdin.write(JSON.stringify({ id: 2, op: 'open', port: global.__PORT || 'COM22', baud: 1500000 }) + '\n')
      setTimeout(() => {
        p.stdin.write(JSON.stringify({ id: 3, op: 'close' }) + '\n')
        p.stdin.write(JSON.stringify({ id: 9, op: 'quit' }) + '\n')
        setTimeout(() => { try { p.kill() } catch { } resolve(out) }, 800)
      }, 1200)
    }, 600)
  })
  const list = r.find(x => x.id === 1)
  const open = r.find(x => x.id === 2)
  check('串口枚举成功', list && list.ok && Array.isArray(list.ports), list ? `${list.ports.length} 个` : 'null')
  if (list && list.ports) {
    // 端口号会变（COM11 -> COM22），不能写死
    const real = list.ports.find(p => /CP210|Silicon|CH34|FTDI/i.test(p.desc || ''))
    check('找到真实串口', !!real, real ? real.name : '无')
    check('列表带设备描述', !!(real && real.desc), real ? real.desc : '')
    global.__PORT = real ? real.name : null
  }
  check((global.__PORT || 'COM22') + ' @1500000 打开成功', open && open.ok, open ? JSON.stringify(open) : 'null')
}

console.log('\n=== 5. 烧录 IPC helper（只读，不烧板）===')
if (DL_EXE === '') {
  console.log('  SKIP  未设置 DSH_DOWNLOADER_DIR')
} else {
  const hasDl = fs.existsSync(DL_EXE)
  const hasIpc = fs.existsSync(IPC_HELPER)
  check('Downloader.exe 存在', hasDl, DL_EXE)
  check('IPC helper 存在', hasIpc, IPC_HELPER)
  if (hasDl && hasIpc) {
    const events = await new Promise(resolve => {
      const p = spawn(IPC_HELPER, ['--exe', DL_EXE, '--args', 'BackMode {hwnd}'],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      const rl = createInterface({ input: p.stdout })
      const evs = []
      let sent = false
      rl.on('line', l => {
        let e
        try { e = JSON.parse(l) } catch { return }
        evs.push(e)
        if (e.ev === 'dl_msg' && (e.fields?.[0] === 'StartOK') && !sent) {
          sent = true
          // 不再发 readinfo（『读取信息』按钮已移除）；只要 DevChange
          setTimeout(() => p.stdin.write('quit\n'), 12000)
        }
      })
      setTimeout(() => { try { p.kill() } catch { } resolve(evs) }, 16000)
      p.stdin.write('launch\n')
    })
    const startok = events.some(e => e.ev === 'dl_msg' && e.fields?.[0] === 'StartOK')
    const fileinfo = events.find(e => e.ev === 'dl_msg' && e.fields?.[0] === 'FileInfo')
    const devchange = events.some(e => e.ev === 'dl_msg' && e.fields?.[0] === 'DevChange')
    const hidden = events.find(e => e.ev === 'hidden')
    // 重要：烧录日志走的是 dl_console（Downloader 的控制台输出），
    // 不是 WM_COPYDATA 的 Log 消息。实测 10 条 [DL] 全在 dl_console 里。
    const consoles = events.filter(e => e.ev === 'dl_console')
    const ipcLogs = events.filter(e => e.ev === 'dl_msg' && e.fields?.[0] === 'Log')
    check('收到 StartOK 握手', startok)
    check('收到 FileInfo（固件校验）', !!fileinfo, fileinfo ? fileinfo.firmwareChecksum : '')
    check('收到 DevChange（设备状态）', devchange)
    check('窗口已隐藏', !!hidden, hidden ? `visibleAfter=${hidden.visibleAfter}` : '')
    check('收到烧录日志（dl_console）', consoles.length > 0,
      `${consoles.length} 条 (Log 消息 ${ipcLogs.length} 条)`)
    // helper 已剥掉前端的 [DL] 标签，line 里是纯内容
    check('日志内容非空且可读', consoles.some(e => (e.line || '').trim().length > 0),
      consoles[0] ? (consoles[0].line || '').slice(0, 40) : '')
    if (fileinfo) {
      check('FileInfo 解析出 dcf 路径', !!fileinfo.dcfPath, fileinfo.dcfPath || '')
    }
  }
}

console.log('\n===== SUMMARY =====')
console.log(`  PASS ${pass}`)
console.log(`  FAIL ${fail}`)
process.exit(fail === 0 ? 0 : 1)
