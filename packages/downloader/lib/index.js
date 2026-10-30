// dsh-downloader —— host 半侧
//
// 职责：
//   1. 目录扫描（git 双轨识别：分支读 .git 文件、脏状态按需跑 git status）
//   2. 串口（spawn AbSerialHost.exe，stdio JSON 行协议）
//   3. 烧录（spawn DownloaderIpcBridge.exe，驱动官方 Downloader 的 IPC）
//   4. 对外 HTTP：/downloader/*（前端拿数据）+ /downloader/events（SSE 推流）
//
// 设计要点（都踩过坑）：
//   - 绝不阻塞宿主事件循环：全部 fs.promises / 异步 spawn，不用 execSync
//   - 串口与烧录互斥：Windows 的 COM 口独占，烧录前必须先关串口
//   - helper 进程要有防孤儿：正常退出 + 残留检测
//
// 注意：本文件是纯 ESM，依赖 Node 内置模块，无第三方依赖。

import { spawn, execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-downloader'
export const inject = []

// ESM 里没有 __dirname / import.meta.dirname（后者是较新版本才有），
// 用 fileURLToPath 最稳，且能正确处理中文路径与 Windows 盘符。
const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const HELPER_DIR = path.join(PLUGIN_ROOT, 'helper')
const SERIAL_HELPER = path.join(HELPER_DIR, 'AbSerialHost.exe')

// ---------------------------------------------------------------- 部署路径
//
// 厂商烧录引擎与 SDK 工作区都不属于本仓库，它们的路径是「部署配置」而不是源码
// 内容，所以这里不写死任何机器路径。加载插件前设置这几个环境变量：
//
//   DSH_DOWNLOADER_DIR        厂商 Downloader 安装目录（含 Downloader.exe）
//   DSH_DOWNLOADER_WORKSPACE  存放 SDK 工程的根目录（扫描 *.dcf 用）
//   DSH_DOWNLOADER_IPC_HELPER 可选：覆盖 IPC 桥 exe 的位置
//
// 都没设置时退化为用户目录下的占位路径：插件照常加载，/diag 会明确报缺失。
const CONFIG = {
  dlDir: (process.env.DSH_DOWNLOADER_DIR ?? '').trim(),
  workspaceRoot: (process.env.DSH_DOWNLOADER_WORKSPACE ?? '').trim(),
  ipcHelper: (process.env.DSH_DOWNLOADER_IPC_HELPER ?? '').trim(),
}

const DEFAULT_DL_DIR = CONFIG.dlDir !== '' ? CONFIG.dlDir : path.join(os.homedir(), 'Downloader')
const DEFAULT_WORKSPACE = CONFIG.workspaceRoot

const IPC_HELPER_CANDIDATES = [
  // ★ 优先用插件目录内自带的（方便分发：整个目录拷贝即可运行）
  path.join(HELPER_DIR, 'DownloaderIpcBridge.exe'),
  path.join(PLUGIN_ROOT, 'ipc-helper', 'DownloaderIpcBridge.exe'),
  // 开发机器上的桥可能放在别处，用环境变量指过去
  CONFIG.ipcHelper,
].filter((candidate) => typeof candidate === 'string' && candidate !== '')

// ---------------------------------------------------------------- 工具

function json(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

async function readBody(req, limit = 8 << 20) {
  const chunks = []
  let n = 0
  for await (const c of req) {
    n += c.length
    if (n > limit) throw new Error('body too large')
    chunks.push(c)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function safeJoin(root, rel) {
  const p = path.resolve(root, rel ?? '')
  const r = path.resolve(root)
  if (p !== r && !p.startsWith(r + path.sep)) throw new Error('path escape')
  return p
}

// ---------------------------------------------------------------- 目录扫描

const SKIP_DIR = new Set([
  'node_modules', '__pycache__', '.git', '.svn', '.hg', '.vs', '.repo',
  'System Volume Information', '$RECYCLE.BIN', '.gradle', '.idea',
  'cmake', 'obj', 'bin2', '.obsidian', '.tox', '.venv', 'venv',
])
// Output 是构建产物，可能很大；默认跳过但可配置
const SKIP_DIR_OPTIONAL = new Set(['Output', 'build', 'dist', '.next', 'target'])

const SKIP_EXT = new Set([
  '.zip', '.7z', '.rar', '.tar', '.gz', '.xz', '.iso', '.vhd',
  '.obj', '.o', '.a', '.lib', '.exe', '.dll', '.pdb', '.bin',
])

/**
 * 扫一层目录（不递归），返回子目录 + git 信息。
 * 首屏只需要这一层，实测 11.7ms 量级。
 */
async function scanLevel(dir, opts = {}) {
  const skipOptional = opts.skipOutput !== false
  let ents
  try {
    ents = await fsp.readdir(dir, { withFileTypes: true })
  } catch (e) {
    return { error: String(e.message), dirs: [], files: [] }
  }
  const dirs = []
  for (const e of ents) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue
    if (SKIP_DIR.has(e.name)) continue
    if (skipOptional && SKIP_DIR_OPTIONAL.has(e.name)) continue
    const full = path.join(dir, e.name)
    dirs.push({ name: e.name, path: full })
  }
  const files = []
  for (const e of ents) {
    if (!e.isFile()) continue
    const ext = path.extname(e.name).toLowerCase()
    if (SKIP_EXT.has(ext)) continue
    files.push({ name: e.name, path: path.join(dir, e.name) })
  }
  // git 信息并行补（每个目录只读 .git/HEAD，极快）
  const gitInfos = await Promise.all(dirs.map(d => readGitMeta(d.path)))
  dirs.forEach((d, i) => { if (gitInfos[i]) d.git = gitInfos[i] })
  dirs.sort((a, b) => {
    if (!!a.git !== !!b.git) return a.git ? -1 : 1
    return a.name.localeCompare(b.name, 'zh-CN')
  })
  return { dir, dirs, files, gitCount: dirs.filter(d => d.git).length }
}

/**
 * 纯文件解析 git 元数据 —— 实测 49 个仓库只要 11ms，比 spawn git 快 1000 倍以上。
 * 处理三种形态：
 *   1. .git 是目录（普通仓库）
 *   2. .git 是文件（submodule，内容 "gitdir: ../.git/modules/x"）
 *   3. .git 里还套 .git（假仓库，必须验证 <gitdir>/HEAD 可读）
 */
async function readGitMeta(repoDir) {
  const dotGit = path.join(repoDir, '.git')
  let gitDir = dotGit
  let st
  try {
    st = await fsp.stat(dotGit)
  } catch {
    return null
  }
  if (st.isFile()) {
    // submodule: .git 是文本文件
    try {
      const txt = await fsp.readFile(dotGit, 'utf8')
      const m = /^gitdir:\s*(.+)$/m.exec(txt)
      if (!m) return { kind: 'broken', reason: '.git 文件无 gitdir:' }
      const raw = m[1].trim()
      gitDir = path.isAbsolute(raw) ? raw : path.resolve(repoDir, raw)
    } catch {
      return null
    }
  }
  // 关键校验：<gitdir>/HEAD 必须可读，否则是假仓库
  const headPath = path.join(gitDir, 'HEAD')
  let head
  try {
    head = (await fsp.readFile(headPath, 'utf8')).trim()
  } catch {
    return { kind: 'broken', reason: '.git 存在但 HEAD 不可读（假仓库？）' }
  }

  let branch = null
  let detached = false
  if (head.startsWith('ref:')) {
    branch = head.slice(4).trim().replace(/^refs\/heads\//, '')
  } else if (/^[0-9a-f]{40}$/i.test(head)) {
    detached = true
    branch = head.slice(0, 8)
  }

  // remote：读 .git/config
  let remote = null
  try {
    const cfg = await fsp.readFile(path.join(gitDir, 'config'), 'utf8')
    const m = /\[remote\s+"[^"]+"\][^\[]*?url\s*=\s*(\S+)/i.exec(cfg)
    if (m) {
      const url = m[1]
      const host = /^(?:https?|ssh|git):\/\/([^/:]+)/.exec(url) || /^[\w.-]+@([\w.-]+):/.exec(url)
      remote = host ? host[1] : url
    }
  } catch { /* 没 config 也正常 */ }

  return {
    kind: st.isFile() ? 'submodule' : 'normal',
    branch,
    detached,
    remote,
    dirty: null,      // 按需才算
  }
}

/**
 * 脏状态：必须 spawn git（单仓 180-230ms，其中 120ms 是进程启动固定开销）。
 * 绝不批量预跑 —— 只在用户看向某行或显式刷新时调用。
 */
function gitStatus(repoDir, timeoutMs = 8000) {
  return new Promise(resolve => {
    let out = ''
    let err = ''
    let done = false
    const child = spawn(
      process.env.GIT_EXE || 'git',
      ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=no'],
      { cwd: repoDir, windowsHide: true },
    )
    const finish = (val) => { if (!done) { done = true; resolve(val) } }
    const timer = setTimeout(() => { try { child.kill() } catch { } finish({ error: 'timeout' }) }, timeoutMs)
    child.stdout.on('data', d => { out += d.toString('utf8') })
    child.stderr.on('data', d => { err += d.toString('utf8') })
    child.on('error', e => { clearTimeout(timer); finish({ error: String(e.message) }) })
    child.on('close', code => {
      clearTimeout(timer)
      if (code !== 0) return finish({ error: err.trim() || `git exited ${code}` })
      let branch = null
      let ahead = 0
      let behind = 0
      let changed = 0
      for (const rec of out.split('\0')) {
        if (!rec) continue
        if (rec.startsWith('# branch.head ')) branch = rec.slice(14).trim()
        else if (rec.startsWith('# branch.ab ')) {
          const m = /\+(\d+)\s+-(\d+)/.exec(rec)
          if (m) { ahead = +m[1]; behind = +m[2] }
        } else if (/^[12u?] /.test(rec)) changed++
      }
      finish({ branch, ahead, behind, changed, dirty: changed > 0 })
    })
  })
}

// ---------------------------------------------------------------- helper 进程管理

/**
 * 通用 helper：spawn 一个 exe，stdin/stdout 走 JSON 行。
 * 处理了三个坑：
 *   - stdout 必须逐行解析，不能等全部输出
 *   - 进程异常退出要清理状态并广播
 *   - 残留检测（这台机器上出现过 ThreadCount=0 的僵死进程，杀不掉）
 */
class LineHelper {
  constructor(exe, args, onEvent, name = 'helper') {
    this.exe = exe
    // ← 必须存下来！之前漏了这行，导致 start() 拿到 undefined，
    //   IPC helper 收到空参数直接 exit code=2，表现为"连不上"。
    this.args = args || []
    this.name = name
    this.onEvent = onEvent
    this.proc = null
    this.rl = null
    this.alive = false
    this.seq = 0
    this.pending = new Map()
  }

  start() {
    if (this.alive) return true
    if (!fs.existsSync(this.exe)) {
      this.onEvent({ ev: 'fatal', msg: `${this.name}: 找不到 ${this.exe}`, where: this.name })
      return false
    }
    try {
      this.proc = spawn(this.exe, this.args || [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        cwd: path.dirname(this.exe),
      })
    } catch (e) {
      this.onEvent({ ev: 'fatal', msg: `${this.name} 启动失败: ${e.message}`, where: this.name })
      return false
    }
    this.alive = true
    this.startedAt = Date.now()
    this.rl = createInterface({ input: this.proc.stdout })
    this.rl.on('line', line => {
      let obj
      try { obj = JSON.parse(line) } catch { return }
      if (obj.id != null && this.pending.has(obj.id)) {
        const { resolve } = this.pending.get(obj.id)
        this.pending.delete(obj.id)
        resolve(obj)
        return
      }
      this.onEvent(obj)
    })
    // stderr 不能吞，但要标注来源
    createInterface({ input: this.proc.stderr }).on('line', l => {
      this.onEvent({ ev: 'stderr', where: this.name, line: l })
    })
    this.proc.on('exit', code => {
      this.alive = false
      this.onEvent({ ev: 'exit', where: this.name, code })
      for (const { resolve } of this.pending.values()) resolve({ ok: false, error: 'helper exited' })
      this.pending.clear()
    })
    this.proc.on('error', e => {
      this.alive = false
      this.onEvent({ ev: 'fatal', msg: `${this.name}: ${e.message}`, where: this.name })
    })
    return true
  }

  /** 发一条命令并等对应 id 的回包（有超时）。 */
  async command(op, extra = {}, timeoutMs = 10000) {
    if (!this.alive) return Promise.resolve({ ok: false, error: 'not running' })
    // ★ 防吐尸：进程句柄存在但已退出时，alive 可能还是 true，
    //   导致命令写进去没人应答，一直 timeout。这里先体检一下。
    if (this.proc && this.proc.exitCode !== null) {
      this.alive = false
      return { ok: false, error: 'helper exited (code ' + this.proc.exitCode + ')' }
    }
    // 刚启动的 .NET 进程还在初始化，立即写 stdin 会丢；
    // 实测需要至少 ~250ms 才能稳定接收。
    if (this.startedAt && Date.now() - this.startedAt < 250) {
      await new Promise(r => setTimeout(r, 250 - (Date.now() - this.startedAt)))
    }
    const id = String(++this.seq)
    const payload = JSON.stringify({ id, op, ...extra })
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({ ok: false, error: 'timeout' })
      }, timeoutMs)
      this.pending.set(id, {
        resolve: v => { clearTimeout(timer); resolve(v) },
      })
      try {
        this.proc.stdin.write(payload + '\n')
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(id)
        resolve({ ok: false, error: String(e.message) })
      }
    })
  }

  /** 纯文本行命令（给 IPC helper 用，它的协议是文本不是 JSON）。 */
  line(text) {
    if (!this.alive) return false
    try { this.proc.stdin.write(text + '\n'); return true } catch { return false }
  }

  /**
   * 停掉子进程。必须「真的等它退出」，
   * 否则它会一直占着串口，后面新实例打不开。
   * （实测踩过：烧录后旧 helper 没退出，COM22 一直拿不回来。）
   */
  async stopAndWait(timeoutMs = 2500) {
    const p = this.proc
    this.alive = false
    this.proc = null
    for (const { resolve } of this.pending.values()) resolve({ ok: false, error: 'stopped' })
    this.pending.clear()
    if (!p) return
    try { p.stdin.end() } catch { }
    await new Promise(res => {
      let done = false
      const finish = () => { if (!done) { done = true; res() } }
      p.once('exit', finish)
      const t1 = setTimeout(() => { try { p.kill() } catch { } }, 400)
      const t2 = setTimeout(() => { try { p.kill('SIGKILL') } catch { } ; finish() }, timeoutMs)
      p.once('close', () => { clearTimeout(t2); finish() })
      void t1
    })
  }

  stop() {
    const p = this.proc
    this.alive = false
    this.proc = null
    if (!p) return
    try { p.stdin.end() } catch { }
    setTimeout(() => { try { p.kill() } catch { } }, 400)
  }
}

// ---------------------------------------------------------------- 插件主体

export function apply(ctx) {
  const state = {
    root: null,                 // 当前工作台根目录
    project: null,              // 当前选中的工程
    serial: { open: false, port: null, baud: 1500000 },
    flash: { status: '离线', progress: 0, online: false, com: null, fwChecksum: null, devChecksum: null, busy: false, burnSeq: 0, doneSeq: 0 },
    logs: [],                   // 环形日志（最近 N 条）
    // 自动烧录：监听编译产物 dcf 的变化
    watch: { on: false, path: null, lastMtime: 0, lastSize: 0, timer: null, armedAt: 0 },
  }
  // 为 AI 阅读而设：保留很长的环形缓冲（不落盘、不导出）。
  // 50000 条大约是几百次烧录 / 数小时板卡输出；每条实体约 100B，总内存约 5MB。
  const MAX_LOGS = 50000
  const sseClients = new Set()

  const broadcast = (obj) => {
    const line = `data: ${JSON.stringify(obj)}\n\n`
    for (const res of sseClients) {
      try { res.write(line) } catch { /* 断开的会被下面的 close 清掉 */ }
    }
  }

  // ★ 日志推入。小优化：每条都 splice(0,n) 会反复搬整个数组
  //   （实测 6 万条 2.7 秒）。改成溢出一定量后才整批剪一次。
  const LOG_TRIM_SLACK = 2000
  const pushLog = (src, text) => {
    if (!text) return
    const item = { t: Date.now(), src, text }
    state.logs.push(item)
    if (state.logs.length > MAX_LOGS + LOG_TRIM_SLACK) {
      state.logs.splice(0, state.logs.length - MAX_LOGS)
    }
    broadcast({ ev: 'log', item })
  }


  // ---- 串口 helper（64 位 .NET，直接支持 1.5M）----
    // ⭐ 串口数据必须按「行」聚合再入日志。
    // helper 每次 p.Read() 读几十字节就发一包，一行文字很常被切成 2~3 段，
    // 每段又各自带 \r\n 尾 -> 前端每条独立渲染就变成“无缘无故换行”。
    // 做法：维护行缓冲，遇 \n 才落一条；半行超 250ms 也派发。
    let lineBuf = ''
    let lineFlushTimer = null
    const flushPartialLine = () => {
      if (!lineBuf) return
      const t = lineBuf.replace(/\r/g, '')
      lineBuf = ''
      if (t.trim()) pushLog('B', t)
    }
    const appendSerialText = (txt) => {
      if (!txt) return
      lineBuf += txt
      let idx
      while ((idx = lineBuf.indexOf('\n')) >= 0) {
        const line = lineBuf.slice(0, idx).replace(/\r$/, '')
        lineBuf = lineBuf.slice(idx + 1)
        if (line.trim()) pushLog('B', line)
      }
      if (lineFlushTimer) clearTimeout(lineFlushTimer)
      if (lineBuf) lineFlushTimer = setTimeout(flushPartialLine, 250)
    }

    let serialHelper = new LineHelper(SERIAL_HELPER, [], ev => {
      if (ev.ev === 'data') {
        appendSerialText(ev.text)
        broadcast({ ev: 'serial', ...ev })
      } else if (ev.ev === 'err' || ev.ev === 'fatal') {
        pushLog('S', `串口错误: ${ev.msg}`)
      }
    }, 'serial')

  // ★ 烧录完成后把串口抢回来。
  // Downloader 烧完会释放 COM，但释放有几百毫秒延迟，
  // 所以重试几次而不是硬睡。
  // ==================== 自动烧录（监听编译产物）====================
  // 背景：用户的工作流是「改代码 → 编译 → 烧录」，
  // 希望编译完就自动烧，不用再点。
  // Downloader 自带的 AutoStart 能监听，但需要在它 GUI 里点一次按钮激活，
  // 而且一旦被关就断。这里在工作台自己做，不依赖它。
  //
  // 实现：轮询 dcf 的 mtime+size（变化即编译完），
  //   然后等稳（防止连续写）→ 自动调用与「开始烧录」完全相同的流程。

  const DCF_CANDIDATE = [
    'app/projects/standard/Output/bin/app.dcf',
    'app/app_cpu/projects/standard/Output/bin/app.dcf',
    'projects/watch320/Output/bin/app.dcf',
    'output/bin/app.dcf',
  ]

  /**
   * 挑出「最近编译过」的 dcf。
   * 候选来源：Downloader 报的路径 + 我们知道的常见工程位置。
   * 实测依据：编译完的 dcf 一定是最新的（今天 17:15），
   * 而 Downloader config 里的默认槽位可能是几个月前的。
   */
  function freshestDcf() {
    const cands = new Set()
    if (state.flash.dcfPath) cands.add(state.flash.dcfPath)
    if (state.watch.path) cands.add(state.watch.path)
    // ★ 扫一遍工作区下的 dcf，取最近编译的那个。
    //   注意：DCF_CANDIDATE 是「相对工程根」的路径，
    //   而工程根往往比工作区深好几层，所以不能直接拼。
    //   这里直接深度有限地扫 Output\bin 目录。
    const scanRoots = [DEFAULT_WORKSPACE, state.root, state.project].filter(Boolean)
    for (const root of scanRoots) {
      try {
        const stack = [{ d: root, depth: 0 }]
        let guard = 0
        while (stack.length && guard++ < 20000) {
          const { d, depth } = stack.pop()
          if (depth > 6) continue
          let ents
          try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { continue }
          for (const e of ents) {
            if (!e.isDirectory()) continue
            if (/^(\.git|node_modules|cmake|\.vscode|__pycache__)$/i.test(e.name)) continue
            const full = path.join(d, e.name)
            if (/^Output$/i.test(e.name)) {
              // Output\bin\*.dcf
              const binDir = path.join(full, 'bin')
              try {
                for (const f of fs.readdirSync(binDir)) {
                  if (f.toLowerCase().endsWith('.dcf')) cands.add(path.join(binDir, f))
                }
              } catch { }
              continue
            }
            stack.push({ d: full, depth: depth + 1 })
          }
        }
      } catch { }
    }
    let best = null, bestT = 0
    for (const c of cands) {
      try {
        const st = fs.statSync(c)
        if (st.mtimeMs > bestT) { bestT = st.mtimeMs; best = c }
      } catch { }
    }
    return best
  }



  function guessDcf(root) {
    if (!root) return null
    for (const rel of DCF_CANDIDATE) {
      const p = path.join(root, rel)
      if (fs.existsSync(p)) return p
    }
    // 兜底：找最近改动的 dcf
    try {
      const stack = [root]
      let best = null, bestT = 0, guard = 0
      while (stack.length && guard++ < 4000) {
        const d = stack.pop()
        let ents
        try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { continue }
        for (const e of ents) {
          const full = path.join(d, e.name)
          if (e.isDirectory()) {
            if (/^(\.git|node_modules|cmake|\.vscode)$/i.test(e.name)) continue
            stack.push(full)
          } else if (e.name.toLowerCase().endsWith('.dcf')) {
            try {
              const st = fs.statSync(full)
              if (st.mtimeMs > bestT) { bestT = st.mtimeMs; best = full }
            } catch { }
          }
        }
      }
      return best
    } catch { return null }
  }

  function watchTick() {
    const w = state.watch
    // ★ 定期向 Downloader 问一下「你现在选的是哪个 dcf」。
    //   你在它界面里切文件时，它不会主动告诉我们，只能主动去读。
    if (state.flash.connected) {
      const now = Date.now()
      if (!state.watch.lastDcfQuery || now - state.watch.lastDcfQuery > 3000) {
        state.watch.lastDcfQuery = now
        try { flashHelper.line('curdcf') } catch { }
      }
    }
    if (!w.on || !w.path) return
    let st
    try { st = fs.statSync(w.path) } catch { return }
    const changed = st.mtimeMs !== w.lastMtime || st.size !== w.lastSize
    if (!changed) return
    const first = w.lastMtime === 0
    w.lastMtime = st.mtimeMs
    w.lastSize = st.size
    if (first) return                       // 首次取基准，不触发
    if (Date.now() - w.armedAt < 3000) return  // 刚开启时的自身写入不算
    // 等它写完（连续 1.2 秒无变化）再烧
    if (w.pendingTimer) clearTimeout(w.pendingTimer)
    w.pendingTimer = setTimeout(() => autoFlashTrigger(st), 1200)
  }

  async function autoFlashTrigger(st) {
    const w = state.watch
    if (!w.on) return
    pushLog('S', '检测到编译产物变化（' + Math.round(st.size / 1024) + 'KB），准备自动烧录')
    broadcast({ ev: 'watch', watch: { on: w.on, path: w.path } })
    // 若正在烧录就等一下
    for (let i = 0; i < 60 && state.flash.burning; i++) await new Promise(r => setTimeout(r, 500))
    if (state.flash.burning) { pushLog('S', '自动烧录跳过：已有烧录在进行'); return }
    // 串口让出由 doFlash 统一处理（它会记下 resumeAfterFlash）。
    // 不要在这里重复关，否则 resumeAfterFlash 被覆盖成 null、烧完抢不回串口。

    // ★★ 顺序：先让出串口，再拉起 Downloader。
    //   它扫不到设备就是因为 COM 被工作台占着（实测：重拉后 online 一直 false）。
    if (!state.flash.connected && state.serial.open) {
      state.serial.resumeAfterFlash = state.serial.wantOpen
        || { port: state.serial.port, baud: state.serial.baud }
      try { await serialHelper.command('close', {}) } catch { }
      state.serial.open = false
      pushLog('S', '已让出串口（自动烧录需独占）')
      broadcast({ ev: 'serial-state', serial: state.serial })
      await new Promise(r => setTimeout(r, 250))
    }

    // ★ 若 Downloader 已被关（烧完为了还串口会退出），这里自己拉起它。
    if (!state.flash.connected) {
      pushLog('S', '自动烧录：重新拉起 Downloader…')
      ensureComEnable()
      flashHelper.start()
      state.flash.busy = true
      state.flash.stage = '启动 Downloader…'
      broadcast({ ev: 'flash', state: state.flash })
      flashHelper.line('launch')
      let waited = 0
      while (waited < 20000 && !state.flash.connected) {
        await new Promise(r => setTimeout(r, 250))
        waited += 250
      }
      state.flash.busy = false
      if (!state.flash.connected) {
        pushLog('S', '自动烧录放弃：Downloader 启动失败')
        return
      }
      for (let i = 0; i < 80 && !state.flash.online; i++) await new Promise(r => setTimeout(r, 250))
    }

    // 设备在线吗？不在就等一下
    if (!state.flash.online) {
      for (let i = 0; i < 60 && !state.flash.online; i++) await new Promise(r => setTimeout(r, 250))
    }
    if (!state.flash.online) {
      pushLog('S', '自动烧录放弃：设备未在线（请检查板子/串口）')
      return
    }
    try {
      await doFlash({ confirm: true, auto: true })
    } catch (e) {
      pushLog('S', '自动烧录异常: ' + e.message)
    }
  }

  function setWatch(on, p) {
    const w = state.watch
    if (w.timer) { clearInterval(w.timer); w.timer = null }
    if (w.pendingTimer) { clearTimeout(w.pendingTimer); w.pendingTimer = null }
    if (!on) {
      w.on = false
      pushLog('S', '已停止自动烧录')
      return { ok: true, on: false }
    }
    // ★ 取路径的优先级（实测：root 为空时靠猜永远失败）：
    //   1) 用户手动传入的
    //   2) 上次开过的
    //   3) ★ Downloader 连接时推给我们的 FileInfo 里的 dcf 路径
    //      （这是最可靠的——就是它当前准备烧的那个文件）
    //   4) 从 root/project 猜
    // 只有（烧录器已连接且已收到 FileInfo）时的 dcfPath 才可信。
    // 否则那个值可能是 config 里的旧槽位（实测踩过：拿到几个月前的老路径）。
    // 取 dcf 路径的策略：★ 以 Downloader 为准。
    //   你的工作流是「在 Downloader 界面里手动切 dcf」，
    //   所以它报上来的 FileInfo 就是你选的那个——必须以它为准。
    //   （之前我改成“扫全盘取最新”是错的：会忽略你的手动选择。）
    //   仅当 Downloader 还没报过路径时，才退化到看串口配置 / 工程目录。
    const fromDl = state.flash.dcfPath
    const target = p || w.path
      || (fromDl && fs.existsSync(fromDl) ? fromDl : null)
      || freshestDcf()
      || guessDcf(state.root) || guessDcf(state.project)
    if (!target || !fs.existsSync(target)) {
      pushLog('S', '开启自动烧录失败：找不到 dcf 文件' +
        (fromDl ? '（Downloader 报的路径不存在：' + fromDl + '）' : '——请先点「连接 Downloader」'))
      return { ok: false, error: 'no dcf', path: target || null, dcfPath: fromDl || null }
    }
    let st
    try { st = fs.statSync(target) } catch { return { ok: false, error: 'stat failed' } }
    w.on = true
    w.path = target
    w.lastMtime = st.mtimeMs
    w.lastSize = st.size
    w.armedAt = Date.now()
    w.timer = setInterval(watchTick, 700)
    pushLog('S', '已开启自动烧录：监听 ' + target)
    return { ok: true, on: true, path: target }
  }

  /**
   * 实际发起一次烧录。
   * HTTP 的 /flash/download 和自动烧录都走这里，保证行为一致。
   * 返回 { ok, error?, message? }
   */
  async function doFlash(opts = {}) {
    // ★ 先清掉上一轮残留状态（放最前面，避免任何 await 前被读到旧值）
    state.flash.lastBurn = null
    state.flash.progress = 0
    state.flash.status = '开始下载'
    state.flash.lastDownStaAt = 0
    state.flash.lastDlError = null
    state.flash.dlErrorAt = 0
    if (!state.flash.connected) return { ok: false, error: 'not-connected', message: '还未连接 Downloader' }
    if (state.flash.burning && !opts.auto) return { ok: false, error: 'busy', message: '已有烧录在进行' }

    // 1) 让出串口
    if (state.serial.open) {
      state.serial.resumeAfterFlash = state.serial.wantOpen
        || { port: state.serial.port, baud: state.serial.baud }
      try { await serialHelper.command('close', {}) } catch { }
      state.serial.open = false
      pushLog('S', '已让出串口 ' + state.serial.resumeAfterFlash.port + '（烧录需独占）')
      broadcast({ ev: 'serial-state', serial: state.serial })
      await new Promise(r => setTimeout(r, 200))
    }

    // 2) 等设备在线
    if (!state.flash.online) {
      let waited = 0
      while (waited < 20000 && !state.flash.online) {
        await new Promise(r => setTimeout(r, 250))
        waited += 250
      }
      if (!state.flash.online) {
        pushLog('S', '烧录前检查：设备未在线（没收到 DevChange）')
        return {
          ok: false, error: 'no-device',
          message: '没检测到设备。请检查：板子是否上电 / USB 是否插好 / 串口是否被占用',
        }
      }
    }
    // ★ 若此时仍卡在「扫描中」，说明板子没响应（多半是休眠了）。
    //   不要干等 5 分钟超时，直接说清楚。
    if (/扫描中/.test(state.flash.status || '')) {
      let w2 = 0
      while (w2 < 25000 && /扫描中/.test(state.flash.status || '')) {
        await new Promise(r => setTimeout(r, 500))
        w2 += 500
      }
      if (/扫描中/.test(state.flash.status || '')) {
        pushLog('S', '✗ 自动烧录中止：板子一直没响应（可能已休眠）。请重新上电/按复位后重试')
        state.flash.burning = false
        state.flash.status = '板子无响应'
        broadcast({ ev: 'flash', state: state.flash })
        return { ok: false, error: 'no-response', message: '板子无响应，可能已休眠' }
      }
    }

    // 稳一下避开「扫描中」
    await new Promise(r => setTimeout(r, 1800))

    // 3) 发命令
    flashHelper.start()
    state.flash.burning = true
    state.flash.progress = 0
    state.flash.stage = ''
    state.flash.status = '烧录中'
    pushLog('S', (opts.auto ? '自动' : '') + '开始烧录…')
    broadcast({ ev: 'flash', state: state.flash })
    const sent = flashHelper.line('download')
    if (!sent) {
      state.flash.burning = false
      state.flash.status = '就绪'
      return { ok: false, error: 'send-failed', message: '命令发送失败，helper 可能已退出' }
    }

    // 4) 自动重试（Downloader 会在「扫描中」静默丢弃命令）
    //    ★ 但如果它明确报 Download Start Fail，说明板子根本不响应，
    //      重试再多次也没用 —— 立即停止并说清原因。
    const tCmd = Date.now()
    let retry = 0
    const finishFail = (why) => {
      clearInterval(retryTimer)
      if (!state.flash.burning) return
      state.flash.burning = false
      state.flash.status = why
      pushLog('S', '✗ 烧录中止：' + why)
      broadcast({ ev: 'flash', state: state.flash })
    }
    const retryTimer = setInterval(() => {
      if (!state.flash.burning) { clearInterval(retryTimer); return }
      // 已经收到进度帧 -> 在正常烧，停止重试
      const got = (state.flash.lastDownStaAt || 0) >= tCmd
        || /下载中|校验中|完成/.test(state.flash.status || '')
      if (got) { clearInterval(retryTimer); return }
      // Downloader 明确拒绝过 -> 板子没响应（多半休眠），别再试
      if (state.flash.lastDlError && (state.flash.dlErrorAt || 0) >= tCmd) {
        finishFail('板子无响应（Downloader 拒绝下载，可能已休眠，请重新上电/按复位）')
        return
      }
      if (retry >= 3) {
        finishFail('板子无响应（3 次重试都没进展，可能已休眠，请重新上电/按复位）')
        return
      }
      retry++
      pushLog('S', '未响应，重试发送 StartDownload（第 ' + retry + ' 次）')
      flashHelper.line('download')
    }, 3000)

    // 5) 超时兜底（只防「一发命令就永远卡住」的极端情况）
    setTimeout(() => {
      if (state.flash.burning) {
        state.flash.burning = false
        pushLog('S', '[flash] 烧录超时（2 分钟无进展）')
        broadcast({ ev: 'flash', state: state.flash })
      }
    }, 120000)
    return { ok: true }
  }

  async function resumeSerial(port, baud) {

    // ★ Downloader 烧完会持续占着 COM 监控设备，必须先让它退出才能抢回。
    //   自动烧录不依赖它常驻——工作台自己监听 dcf，需要时会重新拉起它。
    try { flashHelper.line('quit') } catch { }
    if (!port) return
    const t0 = Date.now()
    pushLog('S', '[恢复串口] 开始抢回 ' + port)

    // ★★ 不再把 Downloader 关掉！
    //   Downloader 常驻时会监听 dcf 文件变化（AutoStart），
    //   一旦编译完自动烧录——这是用户的工作流。
    //   我们一旦关它，这个功能就断了。
    //   实测确认：Downloader 空闲时并不持有 COM，所以串口仍可被工作台打开。
    //   只在它真要烧录的那一瞬才需要独占。

    // helper 尚活着就直接用；死了才重建
    if (!serialHelper.alive) {
      const okStart = serialHelper.start()
      if (!okStart) {
        pushLog('S', '串口 helper 启动失败，请手动重开')
        return
      }
      // 只有新建的 helper 才需要等它首次响应
      await serialHelper.command('list', {}, 6000)
    }

    // 快速轮询：每 60ms 试一次，最多 6 秒
    const deadline = Date.now() + 6000
    let tries = 0
    while (Date.now() < deadline) {
      tries++
      // 超时 600ms：失败时 helper 会快速返回，不能让一次试探堵住整个轮询
      const r = await serialHelper.command('open', { port, baud }, 600)
      if (r && r.ok) {
        state.serial.open = true
        state.serial.port = port
        state.serial.baud = baud
        state.serial.wantOpen = { port, baud }
        const ms = Date.now() - t0
        pushLog('S', '已自动恢复串口 ' + port + ' @' + baud + '（空窗 ' + ms + 'ms）')
        broadcast({ ev: 'serial-state', serial: state.serial })
        return
      }
      await new Promise(r => setTimeout(r, 50))
    }
    const ms = Date.now() - t0
    pushLog('S', '串口 ' + port + ' 自动恢复失败（' + tries + ' 次尝试，' + ms + 'ms），请手动点「打开串口」')
  }

  // ---- 烧录 helper（IPC 驱动官方 Downloader）----
  // 用 BackShowMode 让 Downloader 窗口**可见**（用户要求：连接到 Downloader 时要能看见它），
  // 并传 --no-hide 阻止 helper 自己隐藏窗口。
  // 实测对照：BackMode => visible=False；BackShowMode => visible=True。
  const ipcExe = IPC_HELPER_CANDIDATES.find(p => fs.existsSync(p))
  const flashHelper = new LineHelper(
    ipcExe || IPC_HELPER_CANDIDATES[0],
    [
      '--exe', path.join(DEFAULT_DL_DIR, 'Downloader.exe'),
      '--args', 'BackShowMode {hwnd}',
      '--no-hide',
    ],
    onFlashEvent,
    'flash',
  )

  function onFlashEvent(ev) {
    // IPC helper 的 stdout 是 JSON 对象（有 ev 字段）
    switch (ev.ev) {
      case 'ready':
        state.flash.receiverHwnd = ev.receiverHwnd
        // helper 本来就绪了，但 Downloader 还没起
        state.flash.stage = '启动 Downloader…'
        broadcast({ ev: 'flash', state: state.flash })
        break
      case 'launched':
        state.flash.pid = ev.pid
        state.flash.stage = '等待握手…'
        broadcast({ ev: 'flash', state: state.flash })
        break
      case 'dl_msg': {
        const f = ev.fields || []
        const head = (f[0] || '').replace(/^\[COM\d+\]/, '')
        if (head === 'StartOK') {
          // 握手成功 = helper 已接管 Downloader，此时就该解除"连接中"。
          // busy 的语义是「能不能给它发命令」，不是「设备准备好了」。
          state.flash.connected = true
          state.flash.busy = false
          state.flash.stage = '已连接，正在扫描设备…'
          state.flash.status = '已连接'
          pushLog('S', `Downloader 已连接（握手 ${Date.now() - (state.flash.tConnect || Date.now())}ms）`)
        } else if (head === 'DevChange') {
          state.flash.online = String(f[1]) === '1'
          state.flash.com = f[2] || null
          state.flash.status = state.flash.online ? '就绪' : '离线'
          state.flash.stage = state.flash.online ? '' : '等待设备…'
        } else if (head === 'DownSta') {
          // DownSta|COM|进度0..10000|状态|MAC
          // 实测一次成功烧录的完整状态序列：
          //   等待中 → 扫描中 → 初始化 → 就绪 → 预校验 → 下载中 → 校验中 → 等待中 → 完成
          state.flash.com = f[1] || state.flash.com
          state.flash.progress = Number(f[2] || 0)
          state.flash.status = f[3] || state.flash.status
          // 时间戳：烧录前需要知道“状态机已经跑起来了”才敢发 StartDownload
          state.flash.lastDownStaAt = Date.now()
          if (f[4]) state.flash.mac = f[4]

          const st = state.flash.status
          // 「扫描中」卡住是实测最常见的失败模式（卡住时日志永远只有一行「扫描中」）。
          // 记下开始时间，超 20 秒就明确提示用户，而不是让人干等。
          if (/扫描中/.test(st)) {
            if (!state.flash.scanSince) state.flash.scanSince = Date.now()
            else if (Date.now() - state.flash.scanSince > 12000 && !state.flash.scanWarned) {
              state.flash.scanWarned = true
              pushLog('S', '⚠ 卡在「扫描中」已超 20 秒 —— 板子可能已休眠或没进下载模式，请重新上电/按复位')
            }
          } else {
            state.flash.scanSince = 0
            state.flash.scanWarned = false
          }
          if (/完成/.test(st)) {
            // ★ 完成帧会重复推送（实测一次烧录收到 9 次），
            //   只在首次处理，否则 resume 会被反复触发、日志也刷屏。
            if (!state.flash.burning && state.flash.lastBurn && state.flash.lastBurn.ok) {
              state.flash.progress = 10000
              break
            }
            state.flash.burning = false
            state.flash.progress = 10000
            state.flash.lastBurn = { ok: true, at: Date.now(), mac: state.flash.mac }
            pushLog('S', '✓ 烧录完成' + (state.flash.mac ? '（' + state.flash.mac + '）' : ''))
            // ★ Downloader 保持常驻：它要继续监听 dcf 变化，
            //   这样编译完就能自动烧录。
            //   只把串口抢回来看日志（它空闲时不占 COM）。
            const resume = state.serial.resumeAfterFlash
            state.serial.resumeAfterFlash = null
            if (resume) {
              resumeSerial(resume.port, resume.baud)
            } else {
              pushLog('S', 'Downloader 保持开着（继续监听编译产物）')
            }
          } else if (/失败|错误|异常/.test(st)) {
            state.flash.burning = false
            state.flash.lastBurn = { ok: false, at: Date.now(), reason: st }
            pushLog('S', '✗ 烧录失败：' + st)
          } else if (/下载中|校验中|预校验|初始化|烧录中/.test(st)) {
            state.flash.burning = true
          }
          // 「等待中 / 扫描中 / 就绪」不改变 burning：
          // 它们是烧录开始前的那几帧，误判会导致"以为没在烧"而提前放开按钮。
        } else if (head === 'FileInfo') {
          const newDcf = f[1]
          state.flash.dcfPath = newDcf
          state.flash.fwSize = Number(f[4] || 0)
          state.flash.fwChecksum = f[5] || null
          // ★ 用户在 Downloader 里换了 dcf 时，正在监听的路径必须跟着换。
          //   否则自动烧录会一直盯着旧文件 —— 新 dcf 变了也不触发（实测踩过）。
          if (state.watch.on && newDcf && state.watch.path !== newDcf) {
            const oldPath = state.watch.path
            let st2 = null
            try { st2 = fs.statSync(newDcf) } catch { }
            if (st2) {
              state.watch.path = newDcf
              state.watch.lastMtime = st2.mtimeMs
              state.watch.lastSize = st2.size
              state.watch.armedAt = Date.now()
              if (state.watch.pendingTimer) {
                clearTimeout(state.watch.pendingTimer)
                state.watch.pendingTimer = null
              }
              pushLog('S', '自动烧录已切换到新 dcf：' + path.basename(newDcf) +
                (oldPath ? '（原来：' + path.basename(oldPath) + '）' : ''))
              broadcast({ ev: 'watch', watch: { on: true, path: newDcf } })
            } else {
              pushLog('S', '检测到新 dcf 但文件不存在，暂不切换：' + newDcf)
            }
          }
        } else if (head === 'DevInfo') {
          state.flash.devChecksum = f[3] || null
        } else if (head === 'Log') {
          // 少数版本会走 IPC 的 Log 消息
          pushLog('D', ev.text || '')
        } else if (head === 'Error') {
          const et = ev.text || ''
          if (/ReadCodeInfo Start Fail/.test(et)) {
            // 正常时序：连上后先试读一次，读不到就报这个，不算错
          } else if (/Download Start Fail/.test(et)) {
            // ★ 这是真失败：Downloader 拒绝了烧录命令。
            //   实测原因一般是板子已睡眠 / 没进下载模式。
            //   记下原因，让重试循环能看到并提前放弃。
            state.flash.lastDlError = et
            state.flash.dlErrorAt = Date.now()
            pushLog('S', '[Downloader 报错] ' + et)
          } else {
            pushLog('S', '[错误] ' + et)
          }
        }
        broadcast({ ev: 'flash', state: state.flash })
        break
      }
      case 'tx':
        if (ev.ok) pushLog('S', `→ ${ev.text}`)
        else pushLog('S', `→ ${ev.text} 发送失败`)
        break
      case 'dl_console':
        // 实测确认：烧录日志走的是这条（Downloader 的控制台输出），
        // 不是 WM_COPYDATA 的 Log 消息。实测一次 readinfo 有 10 条，Log 消息 0 条。
        // helper 已剥掉 [DL] 前缀，line 是纯内容。
        pushLog('D', ev.line)
        break
      case 'curdcf':
        // ★★ 自动跟随：读到 Downloader 界面里当前选的 dcf，
        //   如果与正在监听的不一样，就跟过去。
        //   这是唯一可行的办法：实测确认 Downloader 在 GUI 里切 dcf 时
        //   既不推 FileInfo、也不写 config，只能从外部读它的下拉框。
        {
          const p2 = ev.path
          if (p2 && !p2.startsWith('__')) {
            state.flash.dcfPath = p2
            if (state.watch.on && state.watch.path !== p2) {
              let st2 = null
              try { st2 = fs.statSync(p2) } catch { }
              if (st2) {
                state.watch.path = p2
                state.watch.lastMtime = st2.mtimeMs
                state.watch.lastSize = st2.size
                state.watch.armedAt = Date.now()
                if (state.watch.pendingTimer) { clearTimeout(state.watch.pendingTimer); state.watch.pendingTimer = null }
                pushLog('S', '自动烧录已跟随到：' + path.basename(p2))
                broadcast({ ev: 'watch', watch: { on: true, path: p2 } })
              }
            }
          }
        }
        break
      case 'bye':
        state.flash.busy = false
        break
      case 'exit':
        // helper 退出了：不管成功失败，都要把"连接中"放开，
        // 否则界面上永远停在「连接中…」
        state.flash.busy = false
        state.flash.connected = false
        state.flash.stage = ''
        state.flash.status = '离线'
        state.flash.online = false
        pushLog('S', `[flash] helper 已退出（code=${ev.code}）`)
        broadcast({ ev: 'flash', state: state.flash })
        break
      case 'error':
      case 'fatal':
        state.flash.busy = false
        state.flash.stage = ''
        pushLog('S', `[flash] ${ev.msg}`)
        broadcast({ ev: 'flash', state: state.flash })
        break
    }
  }

  // 注册 HTTP 路由。webServer 是可选服务，用 ctx.inject 包起来，
  // 缺了也只是少一层 UI，不会让整个插件停摆。
  ctx.inject(['webServer'], (scoped) => {
    scoped.effect(() => scoped.webServer.register({
      kind: 'prefix',
      path: '/downloader',
      handler: (req, res) => handleHttp(req, res, state, {
        scanLevel, gitStatus, serialHelper, flashHelper, broadcast, pushLog,
        sseClients, DEFAULT_DL_DIR, guardDcf: guessDcf, setWatch, doFlash, freshestDcf,
      }),
    }), 'downloader: routes')
  })

  // 给模型也能用的工具（可选，失败不影响 UI）
  ctx.inject(['tools'], (scoped) => {
    scoped.effect(() => scoped.tools.register({
      name: 'downloader_list_projects',
      description: '列出指定目录下的子目录并标出哪些是 git 仓库（分支/remote）。用于找 SDK 工程。',
      parameters: {
        type: 'object',
        properties: {
          dir: { type: 'string', description: '要列的目录，留空用当前工作台根' },
        },
        additionalProperties: false,
      },
      async execute(args) {
        const dir = args?.dir || state.root
        if (!dir) return '还没有设置工作台根目录'
        const r = await scanLevel(dir)
        const lines = r.dirs.map(d =>
          d.git ? `${d.name}/  [git ${d.git.branch || '?'}${d.git.remote ? ' @' + d.git.remote : ''}]` : `${d.name}/`)
        return `共 ${r.dirs.length} 个目录，其中 ${r.gitCount} 个 git 仓库：\n${lines.join('\n')}`
      },
    }), 'downloader: tool')

    // ★ 给 AI 的日志检索工具：让模型自己取需要的那几行，
    //   而不是把数万条日志全塞进上下文。
    scoped.tools.register({
      name: 'downloader_logs',
      description:
        '读取 Downloader 工作台的串口/烧录日志。' +
        '可按来源过滤（B=板卡输出 D=烧录 S=系统 U=用户）、按关键词搜索、' +
        '按尾部或分页取。用于排查烧录失败、串口异常、板归与卡死等问题。',
      parameters: {
        type: 'object',
        properties: {
          tail: { type: 'number', description: '取最后 N 条（默认 200，最多 5000）' },
          offset: { type: 'number', description: '分页起始位置（与 limit 配合）' },
          limit: { type: 'number', description: '每页条数，默认 200' },
          src: { type: 'string', description: '来源过滤，逗号分隔，如 "B,D"' },
          q: { type: 'string', description: '关键词（子串匹配），如 "Error" "WDT" "PASS"' },
          since: { type: 'number', description: '只要这个毫秒时间戳之后的' },
        },
        additionalProperties: false,
      },
      async execute(args) {
        let arr = state.logs
        const srcs = String(args?.src || '').split(',').map(x => x.trim()).filter(Boolean)
        if (srcs.length) arr = arr.filter(l => srcs.includes(l.src))
        if (args?.since) arr = arr.filter(l => l.t >= args.since)
        if (args?.q) arr = arr.filter(l => String(l.text || '').includes(args.q))
        const total = arr.length
        const tail = args?.tail ?? (args?.offset != null || args?.limit != null ? undefined : 200)
        let slice
        if (tail != null) slice = arr.slice(-Math.min(5000, tail))
        else slice = arr.slice(Number(args?.offset || 0), Number(args?.offset || 0) + Math.min(5000, Number(args?.limit || 200)))

        if (!slice.length) return `没有匹配的日志（总缓存 ${state.logs.length} 条，筛选后 0 条）`
        const head = `匹配 ${total} 条，返回 ${slice.length} 条` +
          (total > slice.length ? `（还有 ${total - slice.length} 条，可用 offset/limit 继续取）` : '')
        const body = slice.map(l => {
          const t = new Date(l.t).toTimeString().slice(0, 8)
          return `${t} [${l.src}] ${l.text}`
        }).join('\n')
        return head + '\n\n' + body
      },
    })
  })
}

// ---------------------------------------------------------------- HTTP

/**
 * 保证 Downloader.config 里 COMEnable=True。
 * 为什么：这个开关是“能不能扫串口”的总闸，False 时不管单个 COMxx 怎么写都不扫。
 * 它会被用户在 GUI 里点“串口”时开/关，也可能因为上次异常退出留下 False。
 * 写前先备份，且只改这一个键，不动其他配置。
 */
function ensureComEnable() {
  const cfgPath = path.join(DEFAULT_DL_DIR, 'Downloader.config')
  try {
    if (!fs.existsSync(cfgPath)) return false
    let cfg = fs.readFileSync(cfgPath, 'utf8')
    const m = /<add key="COMEnable" value="(True|False)"\s*\/>/.exec(cfg)
    if (!m) return false
    if (m[1] === 'True') return false
    fs.copyFileSync(cfgPath, cfgPath + '.bak-' + Date.now())
    cfg = cfg.replace(/<add key="COMEnable" value="False"\s*\/>/,
      '<add key="COMEnable" value="True" />')
    fs.writeFileSync(cfgPath, cfg, 'utf8')
    console.log('[downloader] COMEnable False -> True')
    return true
  } catch (e) {
    console.log('[downloader] COMEnable 检查失败: ' + e.message)
    return false
  }
}

async function handleHttp(req, res, state, api) {
  const url = new URL(req.url, 'http://localhost')
  const p = url.pathname.replace(/^\/downloader/, '') || '/'
  const { scanLevel, gitStatus, serialHelper, flashHelper, broadcast, pushLog, sseClients, DEFAULT_DL_DIR, guardDcf, setWatch, doFlash, freshestDcf } = api

  try {
    // ---- SSE：一条流推所有实时事件 ----
    if (p === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      res.write(`data: ${JSON.stringify({ ev: 'hello', state: publicState(state) })}\n\n`)
      sseClients.add(res)
      const ka = setInterval(() => { try { res.write(': ka\n\n') } catch { } }, 20000)
      req.on('close', () => { clearInterval(ka); sseClients.delete(res) })
      return
    }

    if (p === '/state' && req.method === 'GET') {
      return json(res, 200, publicState(state))
    }

    // ---- 目录 ----
    if (p === '/fs/list' && req.method === 'GET') {
      const dir = url.searchParams.get('dir')
      if (!dir) {
        // 没给目录 → 返回盘符 + 常用根
        const roots = []
        for (const d of 'CDEFG'.split('')) {
          if (fs.existsSync(d + ':\\')) roots.push({ name: d + ':', path: d + ':\\' })
        }
        const fav = [DEFAULT_WORKSPACE, DEFAULT_WORKSPACE === '' ? '' : path.dirname(DEFAULT_WORKSPACE), CONFIG.dlDir]
          .filter((x) => x !== '' && fs.existsSync(x))
        return json(res, 200, { roots, fav })
      }
      const r = await scanLevel(dir)
      return json(res, 200, r)
    }

    if (p === '/fs/git' && req.method === 'GET') {
      const repo = url.searchParams.get('repo')
      if (!repo) return json(res, 400, { error: 'repo required' })
      const st = await gitStatus(repo)
      return json(res, 200, st)
    }

    if (p === '/fs/set-root' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req))
      if (!body.dir || !fs.existsSync(body.dir)) return json(res, 400, { error: '目录不存在' })
      state.root = body.dir
      broadcast({ ev: 'root', root: state.root })
      return json(res, 200, { ok: true, root: state.root })
    }

    if (p === '/fs/set-project' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req))
      state.project = body.dir || null
      // 顺手找该工程下的 app.dcf
      let dcf = null
      if (state.project) {
        const guess = path.join(state.project, 'app', 'projects', 'standard', 'Output', 'bin', 'app.dcf')
        if (fs.existsSync(guess)) dcf = guess
      }
      broadcast({ ev: 'project', project: state.project, dcf })
      return json(res, 200, { ok: true, project: state.project, dcf })
    }


    // ---- 串口 ----
    if (p === '/serial/list' && req.method === 'GET') {
      serialHelper.start()
      const r = await serialHelper.command('list', {}, 8000)
      return json(res, 200, r)
    }

    if (p === '/serial/open' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req))
      // 烧录进行中不允许抢串口
      if (state.flash.busy) return json(res, 409, { error: '烧录进行中，不能打开串口' })
      if (!serialHelper.alive) serialHelper.start()
      // ★ 刚烧完时 Downloader 可能还没完全退出、COM 句柄还没释放。
      //   直接 open 会“拒绝访问”。这里自动重试 10 次（共 ≈ 1.5s），
      //   用户不用先点“断开”再点“打开串口”。
      let r = { ok: false, error: 'not-tried' }
      for (let i = 0; i < 10; i++) {
        r = await serialHelper.command('open', { port: body.port, baud: body.baud || 1500000 }, 3000)
        if (r && r.ok) break
        await new Promise(x => setTimeout(x, 150))
      }
      if (r.ok) {
        state.serial.open = true
        state.serial.port = body.port
        state.serial.baud = body.baud || 1500000
        // 记住用户意图：他想看串口。烧录会临时抢走，烧完要按这个意图还回去
        state.serial.wantOpen = { port: body.port, baud: body.baud || 1500000 }
        pushLog('S', `串口 ${body.port} @${state.serial.baud} 已打开`)
        broadcast({ ev: 'serial-state', serial: state.serial })
      } else {
        pushLog('S', `串口 ${body.port} 打开失败：${r.msg || r.error || '未知原因（可能被占用）'}`)
      }
      return json(res, 200, r)
    }

    if (p === '/serial/close' && req.method === 'POST') {
      serialHelper.start()
      await serialHelper.command('close', {})
      state.serial.open = false
      state.serial.port = null
      pushLog('S', '串口已关闭')
      broadcast({ ev: 'serial-state', serial: state.serial })
      return json(res, 200, { ok: true })
    }

    if (p === '/serial/write' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req))
      serialHelper.start()
      const payload = body.hex ? { hex: body.hex } : { text: body.text }
      pushLog('U', body.text || body.hex || '')
      const r = await serialHelper.command('write', payload, 5000)
      return json(res, 200, r)
    }

    // 清空前端日志（Host 侧环形缓冲一并清，避免刷新后又出现旧的）
    if (p === '/log/clear' && req.method === 'POST') {
      state.logs.length = 0
      broadcast({ ev: 'log-clear' })
      return json(res, 200, { ok: true })
    }

    // ★为 AI 阅读而设计：支持分页 + 过滤 + 关键词检索。
    //   不一次拉全量（那会浪掉上下文），
    //   而是让调用方按需取：
    //     ?tail=500         最后 500 条（默认，行为与旧版一致）
    //     ?offset=0&limit=200  从头分页
    //     ?src=B,D         只看板卡/烧录
    //     ?q=关键词        子串搜索（区分大小写）
    //     ?since=<ms>      只要这个时间之后的
    //   响应里总是带 total，方便 AI 知道有多少、还要不要继续取。
    if (p === '/log/recent' && req.method === 'GET') {
      const qp = url.searchParams
      let arr = state.logs
      const srcs = (qp.get('src') || '').split(',').map(x => x.trim()).filter(Boolean)
      if (srcs.length) arr = arr.filter(l => srcs.includes(l.src))
      const since = Number(qp.get('since') || 0)
      if (since > 0) arr = arr.filter(l => l.t >= since)
      const q = qp.get('q')
      if (q) arr = arr.filter(l => String(l.text || '').includes(q))

      const total = arr.length
      const tail = qp.get('tail')
      const offset = Number(qp.get('offset') || 0)
      const limit = Math.max(1, Math.min(5000, Number(qp.get('limit') || 500)))

      let slice
      if (tail != null) {
        const n = Math.max(1, Math.min(5000, Number(tail) || 500))
        slice = arr.slice(-n)
      } else if (qp.get('offset') != null || qp.get('limit') != null) {
        slice = arr.slice(offset, offset + limit)
      } else {
        slice = arr.slice(-500)   // 兼容旧行为
      }
      return json(res, 200, { total, returned: slice.length, offset, logs: slice })
    }

    // ---- 烧录（IPC）----
    if (p === '/flash/start' && req.method === 'POST') {
      // 幂等：已经握手成功就直接返回，绝不重复 launch
      // （重复 launch 会在已有 Downloader 之上再起一个，抢串口 + 两个窗口）
      // ★ 先把 COMEnable 修正成 True（场景：Downloader 已经连上了，
      //   但 config 里的开关是 False，它就不会扫串口、也不会发 DevChange）。
      //   不能放在 launch 之前的底部，否则 already:true 会提前 return。
      const fixed = ensureComEnable()
      if (fixed) pushLog('S', '已修正 Downloader 的 COMEnable=False → True（否则不扫串口）')
      if (state.flash.connected && flashHelper.alive) {
        return json(res, 200, { ok: true, already: true })
      }

      // ★ 最常见的失败原因：用户自己开着 Downloader。
      //   它占着串口、也不响应我们的 IPC，helper 新起的实例永远等不到 StartOK。
      //   必须在启动前就拦住并说清原因，而不是让用户干等 12 秒看到"超时"。
      const body = await readBody(req).catch(() => '{}')
      let force = false
      try { force = !!JSON.parse(body || '{}').force } catch { }
      const foreign = findForeignDownloader()
      if (foreign.length && !force) {
        const pids = foreign.map(f => f.pid).join(', ')
        pushLog('S', `检测到已有 Downloader 在运行（PID ${pids}），它会占用串口并阻止握手`)
        return json(res, 409, {
          error: 'already-running',
          message: `已有一个 Downloader 在运行（PID ${pids}）。\n\n` +
            '请先关闭它再点连接；或者直接用它（但那样工作台无法接管进度与日志）。',
          pids: foreign.map(f => f.pid),
        })
      }

      // ★ 连接前必须让出串口：实测确认工作台占着 COM 时，
      //   Downloader 的 DevChange 永远不会出现（它扫不到设备）。
      //   记住原本开着的端口，烧完自动抢回。
      // 只要用户曾经想看串口（wantOpen），就记住烧完要还回去。
      // 不能只看当前是不是开着 —— 烧录前一步可能已经让出了。
      if (state.serial.open || state.serial.wantOpen) {
        state.serial.resumeAfterFlash = state.serial.wantOpen
          || { port: state.serial.port, baud: state.serial.baud }
        if (state.serial.open) {
          await serialHelper.command('close', {})
          state.serial.open = false
        }
        pushLog('S', '串口 ' + state.serial.resumeAfterFlash.port + ' 已交给 Downloader（属于互斥资源）')
        broadcast({ ev: 'serial-state', serial: state.serial })
        await new Promise(r => setTimeout(r, 300))
      }
      // ★★ 实测根因：Downloader 启动后**不会主动扫描串口**，
      //   直到你在它 GUI 里点一下“串口”才开始扫。
      //   而“串口”开关的状态就是 config 里的 COMEnable：
      //     COMEnable=False -> 不扫描 -> DevChange 永远不会出现 -> 外观就是“连不上”
      //     COMEnable=True  -> 启动后 2~3 秒自动扫到设备（已实测）
      //   所以每次启动前都把它保证成 True。
      flashHelper.start()
      state.flash.busy = true
      state.flash.tConnect = Date.now()
      state.flash.stage = '启动 Downloader…'
      pushLog('S', '正在启动 Downloader（窗口可见）…')
      broadcast({ ev: 'flash', state: state.flash })
      flashHelper.line('launch')
      // 看门狗：12 秒还没握手就认输并放开 busy。
      // Downloader 冷启动实测 1.3-1.5s，握手总耗时约 2s；12s 是安全上限。
      setTimeout(() => {
        if (state.flash.busy && !state.flash.connected) {
          state.flash.busy = false
          state.flash.stage = ''
          state.flash.status = '连接超时'
          pushLog('S', '[flash] 连接超时：12 秒内没有收到 StartOK。' +
            '可能 Downloader 已被占用，或 BackShowMode 参数在该版本上不生效。')
          broadcast({ ev: 'flash', state: state.flash })
        }
      }, 12000)
      return json(res, 200, { ok: true })
    }

    // 查有没有别处启动的 Downloader（前端在打开烧录页时先探一次）
    if (p === '/flash/foreign' && req.method === 'GET') {
      return json(res, 200, { running: findForeignDownloader() })
    }

    // ★ 环境自检：把「能连上但看不到设备」的几个已知原因一次查清。
    //   最坑的一条：Downloader.config 里 COMEnable 被写成 False，
    //   此时 Downloader 不扫 COM 口，DevChange 永远不来，界面一直"离线"，
    //   但握手/FileInfo 都正常——表现得像是插件坏了。
    if (p === '/flash/diagnose' && req.method === 'GET') {
      const out = { ok: true, checks: [] }
      const cfgPath = path.join(DEFAULT_DL_DIR, 'Downloader.config')
      const add = (name, ok, detail, fix) => out.checks.push({ name, ok, detail, fix })

      add('Downloader 目录', fs.existsSync(DEFAULT_DL_DIR), DEFAULT_DL_DIR)
      add('Downloader.exe', fs.existsSync(path.join(DEFAULT_DL_DIR, 'Downloader.exe')),
        path.join(DEFAULT_DL_DIR, 'Downloader.exe'))
      // ipcExe 是 apply() 里的局部变量，handleHttp 是模块级函数，访问不到。
      // 这里直接重新解析一次（文件存在性检查，开销可忽略）。
      const ipcOk = IPC_HELPER_CANDIDATES.find(x => fs.existsSync(x))
      add('IPC helper', !!ipcOk, ipcOk || '未找到')

      // COMEnable
      let comEnable = null
      try {
        const cfg = await fsp.readFile(cfgPath, 'utf8')
        const m = /<add key="COMEnable" value="(True|False)"/.exec(cfg)
        comEnable = m ? m[1] : null
      } catch { }
      add('COMEnable（必须 True，否则扫不到设备）', comEnable === 'True',
        comEnable === null ? '读不到配置' : comEnable,
        comEnable === 'False' ? '点「修复」把它改回 True' : null)

      add('无旧 Downloader 实例', findForeignDownloader().length === 0,
        findForeignDownloader().map(f => 'PID ' + f.pid).join(', ') || '无',
        '点「连接」时会提示关闭')

      const ports = (() => {
        try {
          serialHelper.start()   // 自检要能自己把 helper 拉起来，否则第一次查永远是"无"
          return serialHelper.command('list', {}, 6000)
        } catch { return Promise.resolve(null) }
      })()
      const pRes = await ports
      add('串口可见', !!(pRes && pRes.ports && pRes.ports.length),
        (pRes && pRes.ports || []).map(x => x.name).join(', ') || '无')

      out.ok = out.checks.every(c => c.ok)
      if (!out.ok) {
        out.summary = out.checks.filter(c => !c.ok).map(c => c.name).join('；')
      }
      return json(res, 200, out)
    }

    // 一键修复已知的配置问题（目前只有 COMEnable）
    if (p === '/flash/fix-comenable' && req.method === 'POST') {
      const cfgPath = path.join(DEFAULT_DL_DIR, 'Downloader.config')
      try {
        // 先备份
        const bak = cfgPath + '.bak-' + Date.now()
        await fsp.copyFile(cfgPath, bak)
        let cfg = await fsp.readFile(cfgPath, 'utf8')
        if (!/COMEnable/.test(cfg)) return json(res, 500, { error: 'no COMEnable key' })
        cfg = cfg.replace(/<add key="COMEnable" value="(True|False)"\s*\/>/,
          '<add key="COMEnable" value="True" />')
        await fsp.writeFile(cfgPath, cfg, 'utf8')
        pushLog('S', `已修复 Downloader.config 的 COMEnable=True（备份：${path.basename(bak)}）`)
        return json(res, 200, { ok: true, backup: bak })
      } catch (e) {
        return json(res, 500, { error: String(e.message) })
      }
    }

    // 结束别处启动的 Downloader（用户确认后调用）
    if (p === '/flash/kill-foreign' && req.method === 'POST') {
      const list = findForeignDownloader()
      const killed = []
      for (const f of list) {
        try {
          spawnSyncSafe('taskkill.exe', ['/PID', String(f.pid), '/F'])
          killed.push(f.pid)
          pushLog('S', `已结束 Downloader PID ${f.pid}`)
        } catch { }
      }
      return json(res, 200, { ok: true, killed })
    }

    // 连接进度（前端轮询用，比等 SSE 首包更稳）
    if (p === '/flash/status' && req.method === 'GET') {
      return json(res, 200, {
        connected: !!state.flash.connected,
        busy: !!state.flash.busy,
        burning: !!state.flash.burning,
        // progress 是 0..10000（Downloader 的原始量纲），前端除以 100 得百分比
        progress: Number(state.flash.progress || 0),
        status: state.flash.status || '离线',
        com: state.flash.com || null,
        mac: state.flash.mac || null,
        stage: state.flash.stage || '',
        online: !!state.flash.online,
        lastBurn: state.flash.lastBurn || null,
        scanStuckSec: state.flash.scanSince ? Math.floor((Date.now() - state.flash.scanSince) / 1000) : 0,
        elapsedMs: state.flash.tConnect ? Date.now() - state.flash.tConnect : 0,
      })
    }

    // 手动拉起 dcf：Downloader 的 FileInfo 会回报它当前打开的 dcf 路径。
    // 有些场景需要让用户自己选文件（比如烧别人的包），所以留一个"打开文件"的入口。
    if (p === '/flash/openfile' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req))
      if (!body.path || !fs.existsSync(body.path)) return json(res, 400, { error: '文件不存在' })
      flashHelper.start()
      // Downloader 的 IPC 协议没有"打开指定 dcf"的命令，
      // 只能靠它自己记的 DownFile 槽位；这里把路径记下来给前端展示，
      // 并提示用户可用 Downloader 窗口里的"浏览"改。
      state.flash.dcfPath = body.path
      pushLog('S', `已记录目标固件：${body.path}（可在 Downloader 窗口里用「浏览」切换）`)
      broadcast({ ev: 'flash', state: state.flash })
      return json(res, 200, { ok: true, dcfPath: body.path })
    }

    // Downloader 的窗口是否已经出现（用户在任务栏应该能看到）
    if (p === '/flash/windows' && req.method === 'GET') {
      flashHelper.start()
      flashHelper.line('windows')
      return json(res, 200, { ok: true })
    }

    if (p === '/flash/readinfo' && req.method === 'POST') {
      flashHelper.start()
      const ok = flashHelper.line('readinfo')
      return json(res, 200, { ok })
    }

    if (p === '/flash/download' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req))
      if (!body.confirm) return json(res, 400, { error: '需要确认' })
      const r = await doFlash({ confirm: true })
      return json(res, r.ok ? 200 : 409, r)
    }

    if (p === '/flash/stop' && req.method === 'POST') {
      flashHelper.line('quit')
      state.flash.busy = false
      state.flash.burning = false
      state.flash.connected = false
      state.flash.stage = ''
      state.flash.status = '离线'
      pushLog('S', '已停止 Downloader')
      broadcast({ ev: 'flash', state: state.flash })
      return json(res, 200, { ok: true })
    }

    // ---- 自动烧录（监听编译产物）----
    if (p === '/watch' && req.method === 'GET') {
      return json(res, 200, {
        on: state.watch.on,
        path: state.watch.path,
        exists: !!(state.watch.path && fs.existsSync(state.watch.path)),
        // 与 setWatch 保持一致：以 Downloader 报的路径为准（你在界面里手动选的那个）。
        guess: (state.flash.dcfPath && fs.existsSync(state.flash.dcfPath) ? state.flash.dcfPath : null)
          || freshestDcf() || null,
      })
    }
    if (p === '/watch' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req))
      const r = setWatch(!!body.on, body.path || null)
      broadcast({ ev: 'watch', watch: { on: state.watch.on, path: state.watch.path } })
      return json(res, r.ok ? 200 : 400, r)
    }

    // ★ 让用户（或前端）主动告知「我现在选的是哪个 dcf」。
    //   为什么需要这个：实测确认 Downloader 在界面里切 dcf 时
    //   **不推 FileInfo、也不写 config**，运行中那个选择只在它内存里。
    //   所以无法偷听，只能由调用方告知。
    if (p === '/watch/path' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req))
      const newPath = body.path
      if (!newPath || !fs.existsSync(newPath)) {
        return json(res, 400, { error: 'path not found', path: newPath || null })
      }
      const wasOn = state.watch.on
      if (wasOn) {
        const st = fs.statSync(newPath)
        state.watch.path = newPath
        state.watch.lastMtime = st.mtimeMs
        state.watch.lastSize = st.size
        state.watch.armedAt = Date.now()
        if (state.watch.pendingTimer) { clearTimeout(state.watch.pendingTimer); state.watch.pendingTimer = null }
        pushLog('S', '自动烧录监听已改为：' + path.basename(newPath))
        broadcast({ ev: 'watch', watch: { on: true, path: newPath } })
      }
      state.flash.dcfPath = newPath
      return json(res, 200, { ok: true, applied: wasOn, path: newPath })
    }

    if (p === '/flash/config' && req.method === 'GET') {
      // 只读展示 Downloader.config 里的槽位信息（帮用户确认用哪个 dcf）
      const cfgPath = path.join(DEFAULT_DL_DIR, 'Downloader.config')
      let slots = []
      try {
        const cfg = await fsp.readFile(cfgPath, 'utf8')
        const re = /<add key="(DownFile\d*)" value="([^"]*)"/g
        let m
        while ((m = re.exec(cfg))) slots.push({ key: m[1], file: m[2] })
      } catch { }
      return json(res, 200, { dir: DEFAULT_DL_DIR, exists: fs.existsSync(DEFAULT_DL_DIR), slots })
    }

    return json(res, 404, { error: 'not found', path: p })
  } catch (e) {
    return json(res, 500, { error: String(e.message || e) })
  }
}

function publicState(state) {
  return {
    root: state.root,
    project: state.project,
    serial: { ...state.serial, resumeAfterFlash: state.serial.resumeAfterFlash || null },
    flash: state.flash,
    watch: { on: state.watch.on, path: state.watch.path },
    logs: state.logs.slice(-400),
  }
}

function spawnSyncSafe(cmd, args) {
  // 只在注册表查询这种一次性、极快的场景用（2s 超时），避免长时间阻塞事件循环
  try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 2000 }) } catch { return '' }
}

/**
 * 检测是否已有别处启动的 Downloader.exe。
 *
 * 这是"连不上"最常见的原因：用户自己双击打开了 Downloader（或上一次没关干净），
 * 它占着串口、也不会响应我们的 IPC 握手，于是 helper 新起的实例永远等不到 StartOK。
 *
 * 判据用 ParentProcessId 排除我们自己拉起的那个（父进程是 DownloaderIpcBridge.exe）。
 * ⚠️ 性能：一次 PowerShell 调用查完所有进程并直接判定，
 *    不要"每个进程再查一次父进程"——那样每次点连接要 2.4 秒。
 */
function findForeignDownloader() {
  // 用 tasklist 而不是 Get-CimInstance：后者单次 1.5 秒，前者约 50ms。
  // tasklist /FO CSV /NH 输出形如 "Downloader.exe","38512","Console","1","52,000 K"
  try {
    const out = spawnSyncSafe('tasklist.exe', ['/FI', 'IMAGENAME eq Downloader.exe', '/FO', 'CSV', '/NH'])
    if (!out || /No tasks|信息: 没有运行的任务/i.test(out)) return []
    const pids = []
    for (const line of out.split(/\r?\n/)) {
      if (!/Downloader\.exe/i.test(line)) continue
      const m = /"([^"]*)","(\d+)"/.exec(line)
      if (m) pids.push(Number(m[2]))
    }
    if (!pids.length) return []
    // 只有在 helper 没握手成功时才需要这些；此时我们的 helper 还没拉起 Downloader，
    // 所以此刻存在的 Downloader 一定是"别处启动的"。
    // 已经 connected 的情形在调用方被提前 return 掉了。
    return pids.map(pid => ({ pid, parent: null }))
  } catch {
    return []
  }
}
