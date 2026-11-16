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

/* ---------------------------------------------------------------- 日志地址清单
 * The log cache is an in-memory ring buffer — there is no log file to find. So
 * that an agent can locate it in one step (without guessing, and without being
 * told the DSH port), the host keeps a small, stable "address sheet" on disk:
 *
 *   %USERPROFILE%\.dsh\workbay\downloader-logs.location.json
 *
 * It is NOT the logs; it names the storage kind, the tool, the HTTP route, the
 * current entry count and the workspace root (when known). Refresh it here, on
 * `/log/location`, and (throttled) whenever new lines arrive.
 */
const LOCATION_DIR = path.join(os.homedir(), '.dsh', 'workbay')
const LOCATION_FILE = path.join(LOCATION_DIR, 'downloader-logs.location.json')
const LOG_CACHE_MAX = 50000

/* ---------------------------------------------------------------- 日志落盘
 * 运行日志全量写入 JSONL（不落盘就没法在 DSH 重启后回看）：
 *   %USERPROFILE%\.dsh\workbay\logs\downloader.jsonl
 * 写盘走 250ms 合并队列；超过 128MB 轮转为 .1；启动时只读文件末尾 32MB
 * （避免大文件把主进程卡住）。"清空日志"会截断文件并删掉轮转文件。
 * DSH_DOWNLOADER_LOG_DIR 可覆盖目录（测试用）。
 */
const LOG_DIR = process.env.DSH_DOWNLOADER_LOG_DIR
  ? path.resolve(process.env.DSH_DOWNLOADER_LOG_DIR)
  : path.join(os.homedir(), '.dsh', 'workbay', 'logs')
const LOG_FILE = path.join(LOG_DIR, 'downloader.jsonl')
const LOG_FILE_ROTATE_BYTES = 128 * 1024 * 1024
const LOG_FILE_LOAD_BYTES = 32 * 1024 * 1024

function locationPayload(state) {
  return {
    kind: 'downloader-log-cache',
    storage: 'host-memory + jsonl-file',
    persistent: true,
    note: '运行日志全量追加到 logFile（JSONL）；DSH 重启时从该文件恢复最近日志到工作台。清空日志会同时截断该文件。',
    logFile: LOG_FILE,
    logFileSize: logFileSize(),
    tool: 'downloader_logs',
    toolLocation: 'downloader_logs_location',
    route: '/downloader/log/recent',
    routeExamples: [
      '/downloader/log/recent?tail=300',
      '/downloader/log/recent?src=B,D',
      '/downloader/log/recent?q=Error',
      '/downloader/log/recent?offset=0&limit=200',
    ],
    maxEntries: LOG_CACHE_MAX,
    total: state.logs.length,
    root: state.root || null,
    pointer: LOCATION_FILE,
    updatedAt: Date.now(),
  }
}

function refreshLocation(state) {
  try {
    fs.mkdirSync(LOCATION_DIR, { recursive: true })
    fs.writeFileSync(LOCATION_FILE, JSON.stringify(locationPayload(state), null, 2), 'utf8')
  } catch { /* best effort: a read-only home must not break logging */ }
}

/* ---------------------------------------------------------------- 日志文件 */

/** dcf 文件字节数；读不到就当 0，UI 显示 —。 */
function fileSizeOf(target) {
  try {
    if (typeof target !== 'string' || target === '') return 0
    return fs.statSync(target).size
  } catch {
    return 0
  }
}

function logFileSize() {
  try { return fs.statSync(LOG_FILE).size } catch { return 0 }
}

/** 读文件末尾 maxBytes，丢弃可能被截断的第一行。 */
function readLogTail(file, maxBytes) {
  let fd
  try {
    const size = logFileSize()
    if (size <= 0) return { text: '', truncated: false }
    const start = Math.max(0, size - maxBytes)
    fd = fs.openSync(file, 'r')
    const buffer = Buffer.allocUnsafe(size - start)
    fs.readSync(fd, buffer, 0, buffer.length, start)
    let text = buffer.toString('utf8')
    if (start > 0) {
      const newline = text.indexOf('\n')
      text = newline >= 0 ? text.slice(newline + 1) : ''
    }
    return { text, truncated: start > 0 }
  } catch {
    return { text: '', truncated: false }
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd) } catch { /* ignore */ } }
  }
}

/** 解析 JSONL；坏行/写了一半的最后一行直接跳过。 */
function parseLogLines(text) {
  const out = []
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const item = JSON.parse(trimmed)
      if (item && typeof item.text === 'string') {
        out.push({ t: Number(item.t) || Date.now(), src: String(item.src || 'S'), text: item.text })
      }
    } catch { /* skip torn line */ }
  }
  return out
}

/** 给页面/清单用的文件占用信息。 */
function logFileInfo(state) {
  const size = logFileSize()
  return {
    path: LOG_FILE,
    size,
    lines: state.logFile.lines,
    exists: size > 0,
    rotated: fs.existsSync(LOG_FILE + '.1'),
    error: state.logFile.error || null,
  }
}

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
    /* A child that died while stdin is still considered writable makes
       stdin.write emit EPIPE as an ASYNCHRONOUS 'error'. There was no listener,
       so that exception killed the whole DSH host (crash 2026-11-14 15:02:06 via
       resetStaleFlashConnection -> LineHelper.line('quit')). Never let a helper
       pipe error escape: mark the helper dead instead. */
    const guardStream = (stream, label) => {
      if (stream === null || stream === undefined || typeof stream.on !== 'function') return
      stream.on('error', (e) => {
        this.alive = false
        try {
          this.onEvent({ ev: 'stderr', where: this.name, line: this.name + ' ' + label + ' error: ' + String(e && e.message ? e.message : e) })
        } catch (error) { void error }
      })
    }
    guardStream(this.proc.stdin, 'stdin')
    guardStream(this.proc.stdout, 'stdout')
    guardStream(this.proc.stderr, 'stderr')
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
    if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed || this.proc.stdin.writableEnded) {
      this.alive = false
      return { ok: false, error: 'helper stdin closed' }
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
    if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed || this.proc.stdin.writableEnded) {
      this.alive = false
      return false
    }
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

/* ---------------------------------------------------------------- 互斥 / 去重
 * 两个实测踩过的坑，抽成纯函数以便单测：
 *   1) /flash/start 双击或与自动烧录并发时，会向 helper 连发两次 `launch`，
 *      helper 就起两个 Downloader —— Windows 上直接报工具冲突。
 *   2) 串口 helper 的 open 失败以前走全局 err 事件（没有 id），宿主每重试一次
 *      就多打一条“串口错误”，而且 command('open') 等不到回包、每次卡 3 秒。
 */
/**
 * 把 dcf 写进 Downloader 工具自己的配置（DownFile 槽位）。
 *
 * 为什么必须写配置：Downloader 的 IPC 协议里**没有**"打开指定 dcf"的命令
 * （见 /flash/openfile 的注释），它只认自己 config 里的 DownFile。
 * 只改我们自己的 state.flash.dcfPath 只是"显示对了"，真正烧的还是工具记着的那个文件。
 *
 * 注意：Downloader 在**启动时**读配置，所以这个改动对已经在运行的实例不生效 ——
 * 但我们的启动流程是「先写配置再 launch」，正常路径下正好赶上。
 */
/* ---------------------------------------------------------------- 工具路径
 *
 * Downloader.exe 装在哪，决定了 `Downloader.config` 在哪 —— 而"配置下载路径"
 * 必须写到那个文件里。原来只认环境变量 DSH_DOWNLOADER_DIR，没设就退回
 * ~/Downloader，于是写配置静默失败（界面显示"已切换"，工具里还是旧文件）。
 *
 * 现在允许在页面上直接选 exe 并持久化，不再要求用户配环境变量。
 */
const TOOL_CONFIG_FILE = path.join(LOG_DIR, 'tool-path.json')

/* 这个文件保存「页面选了什么」：exe 位置 + 工作目录。
   工作目录也存，是因为宿主状态活不过 DSH 重启——每次重启都要用户重新选一遍目录，
   那是最没必要的一次重复劳动。 */
function readToolConfig() {
  try {
    if (!fs.existsSync(TOOL_CONFIG_FILE)) return { exe: '', scanRoot: '', autoStartPaused: false, noSleep: false, noSleepOriginal: null }
    const raw = JSON.parse(fs.readFileSync(TOOL_CONFIG_FILE, 'utf8'))
    return {
      exe: typeof raw.exe === 'string' ? raw.exe : '',
      scanRoot: typeof raw.scanRoot === 'string' ? raw.scanRoot : '',
      /* 工作台为了让「只有一次烧录」，会临时把 Downloader 的 AutoStart 关掉；
         这个标记用于退出/崩溃恢复时把它改回来。 */
      autoStartPaused: raw.autoStartPaused === true,
      /* AI loop convenience: keep sys_sleep_time=0 in the generated watch.setting. */
      noSleep: raw.noSleep === true,
      /* The value from before the checkbox wrote 0; uncheck restores it. */
      noSleepOriginal: typeof raw.noSleepOriginal === 'string' ? raw.noSleepOriginal : null,
    }
  } catch {
    return { exe: '', scanRoot: '', autoStartPaused: false, noSleep: false, noSleepOriginal: null }
  }
}

function writeToolConfig(patch) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    const merged = Object.assign({}, readToolConfig(), patch)
    fs.writeFileSync(TOOL_CONFIG_FILE, JSON.stringify(merged, null, 2), 'utf8')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) }
  }
}
/**
 * Downloader.config 所在目录。
 *
 * 优先级：页面上选的 exe 所在目录 > 环境变量 DSH_DOWNLOADER_DIR > ~/Downloader。
 * 页面设置优先，是因为它是"用户刚在这个界面上确认过的那个工具"。
 */
function resolveDlDir() {
  const configured = readToolConfig().exe
  if (configured !== '') {
    const dir = path.dirname(configured)
    if (fs.existsSync(path.join(dir, 'Downloader.config'))) return dir
    /* 选了 exe 但同目录没有配置：仍然用它（config 可能在第一次启动后生成），
       但要如实告诉调用方 —— 由调用方决定怎么报错。 */
    return dir
  }
  return DEFAULT_DL_DIR
}
/** The Downloader.exe the IPC bridge should launch (selected path wins). */
function downloaderExePath() {
  const configured = readToolConfig().exe
  return configured !== '' ? configured : path.join(DEFAULT_DL_DIR, 'Downloader.exe')
}
/** Replace the AutoStart value; null when the file has no such key or no change. */
export function withAutoStartValue(configText, value) {
  if (typeof configText !== 'string' || configText === '') return null
  const re = /<add key="AutoStart" value="(True|False)"\s*\/>/
  if (re.test(configText) === false) return null
  const next = configText.replace(re, '<add key="AutoStart" value="' + (value === true ? 'True' : 'False') + '" />')
  return next === configText ? null : next
}

/** Read/modify/write Downloader.config's AutoStart, with a backup. */
function setToolAutoStart(value) {
  try {
    const cfgPath = path.join(resolveDlDir(), 'Downloader.config')
    if (!fs.existsSync(cfgPath)) return { ok: false, error: 'config not found', path: cfgPath }
    const cfg = fs.readFileSync(cfgPath, 'utf8')
    const next = withAutoStartValue(cfg, value)
    if (next === null) return { ok: true, changed: false, path: cfgPath }
    const bak = cfgPath + '.bak-' + Date.now()
    fs.copyFileSync(cfgPath, bak)
    fs.writeFileSync(cfgPath, next, 'utf8')
    pruneBackups(cfgPath, 3)
    return { ok: true, changed: true, path: cfgPath }
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e), path: '' }
  }
}

/**
 * Workbench takes ownership: persist the marker FIRST, then flip AutoStart.
 *
 * Only when there is actually something to flip: with no Downloader.config (a
 * machine without the vendor tool, and every test) we must not leave a marker —
 * otherwise the "takeover" notice is logged and, more importantly, the next start
 * would try to "restore" a setting it never changed.
 */
function takeOverAutoStart() {
  let cfgPath
  try {
    cfgPath = path.join(resolveDlDir(), 'Downloader.config')
    if (!fs.existsSync(cfgPath)) return { ok: false, changed: false, error: 'config not found', path: cfgPath }
    const current = toolAutoStartOf(fs.readFileSync(cfgPath, 'utf8'))
    if (current.autoStart !== true) return { ok: true, changed: false, path: cfgPath }
  } catch (e) {
    return { ok: false, changed: false, error: String(e && e.message ? e.message : e), path: '' }
  }
  if (readToolConfig().autoStartPaused !== true) writeToolConfig({ autoStartPaused: true })
  return setToolAutoStart(false)
}

/** Give ownership back (watch stopped / workbench exiting). */
function restoreAutoStart() {
  const cfg = readToolConfig()
  if (cfg.autoStartPaused !== true) return { ok: true, changed: false }
  const result = setToolAutoStart(true)
  /* 用户如果在我们接管期间自己改过，也把标记清掉，避免无谓的重写循环。 */
  writeToolConfig({ autoStartPaused: false })
  return result
}

/** A previous DSH crashed while owning it: put AutoStart back before anything else. */
function recoverAutoStart() {
  const cfg = readToolConfig()
  if (cfg.autoStartPaused !== true) return { ok: true, changed: false }
  const result = setToolAutoStart(true)
  writeToolConfig({ autoStartPaused: false })
  return result
}

export function writeDownFile(dcfPath, overrideDir) {
  const dlDir = typeof overrideDir === 'string' && overrideDir !== '' ? overrideDir : resolveDlDir()
  const cfgPath = path.join(dlDir, 'Downloader.config')
  try {
    if (!fs.existsSync(cfgPath)) return { ok: false, error: 'config not found', path: cfgPath }
    if (!fs.existsSync(dcfPath)) return { ok: false, error: 'dcf not found', path: dcfPath }
    const cfg = fs.readFileSync(cfgPath, 'utf8')
    const re = /<add key="DownFile" value="[^"]*"\s*\/>/
    if (!re.test(cfg)) return { ok: false, error: 'no DownFile key', path: cfgPath }
    const next = cfg.replace(re, `<add key="DownFile" value="${dcfPath}" />`)
    if (next === cfg) return { ok: true, changed: false, path: dcfPath }
    const bak = cfgPath + '.bak-' + Date.now()
    fs.copyFileSync(cfgPath, bak)
    fs.writeFileSync(cfgPath, next, 'utf8')
    /* Every workspace switch makes a backup, and a backup nobody ever looks at is just
       clutter in the vendor's install directory (it also shows up in their file lists).
       Keep the last few so a bad write is still recoverable, drop the rest. */
    pruneBackups(cfgPath, 3)
    return { ok: true, changed: true, backup: bak, path: dcfPath }
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e), path: dcfPath }
  }
}

/**
 * 这个路径是否在当前工作目录之下？
 *
 * `scanRoot` 为空表示"还没有工作目录信息"，此时一律视为在范围内（保持旧行为：
 * 以 Downloader 报的为准）。
 */
export function isUnderScanRoot(filePath, scanRoot) {
  if (typeof scanRoot !== 'string' || scanRoot === '') return true
  if (typeof filePath !== 'string' || filePath === '') return false
  const root = path.resolve(scanRoot)
  const abs = path.resolve(filePath)
  return abs === root || abs.startsWith(root + path.sep)
}
/**
 * Keep only the newest `keep` backups of a config file.
 *
 * The suffix is `Date.now()`, so a plain name sort is chronological for every
 * timestamp this century — no need to stat ten files to find out which are old.
 * Failures are swallowed: a leftover backup is harmless, an exception during a
 * write is not.
 */
export function pruneBackups(cfgPath, keep) {
  const limit = Math.max(0, Number(keep) || 0)
  try {
    const dir = path.dirname(cfgPath)
    const prefix = path.basename(cfgPath) + '.bak-'
    const olds = fs.readdirSync(dir)
      .filter((name) => name.startsWith(prefix))
      .sort()
      .slice(0, Math.max(0, fs.readdirSync(dir).filter((n) => n.startsWith(prefix)).length - limit))
    for (const name of olds) {
      try { fs.unlinkSync(path.join(dir, name)) } catch (e) { void e }
    }
    return olds.length
  } catch (e) {
    return 0
  }
}

/**
 * What a flash attempt is allowed to do, as a pure decision table.
 *
 * manual: a person clicked 开始烧录 — wait for the device, fail loudly if absent.
 * auto:   a build finished — Downloader queues StartDownload during its COM scan,
 *         so queue it early and retry long. Giving up here was the bug the real
 *         logs showed ("设备未在线" then "✓ 烧录完成" 9 s later).
 */
export function flashPlanOf(state, opts) {
  const auto = opts !== undefined && opts !== null && opts.auto === true
  const online = state !== undefined && state !== null && state.flash !== undefined && state.flash !== null
    ? state.flash.online === true
    : false
  return auto
    ? { auto: true, queueWhileOffline: true, abortWhenScanning: false, retryLimit: 1, retryDelayMs: 20000, offlineWaitMs: 0, online }
    : { auto: false, queueWhileOffline: false, abortWhenScanning: true, retryLimit: 1, retryDelayMs: 10000, offlineWaitMs: 20000, online }
}

/** The main firmware file name the vendor build always produces. */
export const PRIMARY_FIRMWARE_NAME = 'app.dcf'

export function isPrimaryFirmwareDcf(filePath) {
  if (typeof filePath !== 'string' || filePath.trim() === '') return false
  return path.basename(filePath).toLowerCase() === PRIMARY_FIRMWARE_NAME
}

/**
 * Keep only app.dcf when the list has any; otherwise keep everything (a project
 * that really names its firmware differently still works).
 */
export function pickPrimaryFirmwareDcf(filePaths) {
  const list = (Array.isArray(filePaths) ? filePaths : []).filter((entry) => typeof entry === 'string' && entry !== '')
  const primary = list.filter(isPrimaryFirmwareDcf)
  return primary.length > 0 ? primary : list
}

/** Parse the two keys of Downloader.config we care about (pure; unit-tested). */
export function toolAutoStartOf(configText) {
  if (typeof configText !== 'string' || configText === '') return { autoStart: false, downFile: '' }
  const auto = /<add key="AutoStart" value="(True|False)"\s*\/>/.exec(configText)
  const down = /<add key="DownFile" value="([^"]*)"\s*\/>/.exec(configText)
  return {
    autoStart: auto !== null && auto[1] === 'True',
    downFile: down === null ? '' : down[1],
  }
}

/** Same file? Windows compares case-insensitively; everything is normalised first. */
export function sameFlashPath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  if (left.trim() === '' || right.trim() === '') return false
  const a = path.resolve(left)
  const b = path.resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** Should the tool's own AutoStart do the burn instead of us? (pure, testable) */
export function shouldDeferToAutoStart(autoInfo, watchPath) {
  if (autoInfo === null || autoInfo === undefined) return false
  if (autoInfo.autoStart !== true) return false
  return sameFlashPath(autoInfo.downFile, watchPath)
}

/** Read Downloader.config (where the selected exe lives) and parse it. */
function readToolAutoStart() {
  try {
    const cfg = path.join(resolveDlDir(), 'Downloader.config')
    if (!fs.existsSync(cfg)) return { autoStart: false, downFile: '', known: false }
    return Object.assign(toolAutoStartOf(fs.readFileSync(cfg, 'utf8')), { known: true })
  } catch (e) {
    return { autoStart: false, downFile: '', known: false, error: String(e && e.message ? e.message : e) }
  }
}

/**
 * Classify the Downloader.exe processes Windows reports against the PID our
 * bridge launched. Pure so the decision is unit-tested without spawning anything.
 */
/**
 * Clear the retry interval and the 120 s overall watchdog of one flash.
 * Pure bookkeeping around the timer handles, so a superseded flash cannot
 * touch a newer one; returns whether anything was actually cleared.
 */
export function clearFlashTimers(flash) {
  if (flash === null || flash === undefined) return false
  let cleared = false
  if (flash.retryTimer !== null && flash.retryTimer !== undefined) {
    clearInterval(flash.retryTimer)
    flash.retryTimer = null
    cleared = true
  }
  if (flash.overallTimer !== null && flash.overallTimer !== undefined) {
    clearTimeout(flash.overallTimer)
    flash.overallTimer = null
    cleared = true
  }
  return cleared
}

/**
 * JSON for SSE. A Node timer handle used to throw out of broadcast and kill the
 * whole DSH host; serialize defensively: cycles are dropped, bigints/functions
 * are made printable instead of crashing.
 */
/**
 * While Downloader.exe is running it may scan/burn at any click; the workbench
 * must yield COM instead of holding it (observed as an endless 「扫描中」).
 */
export function shouldReleaseSerialForDownloader(serialOpen, burning, pids) {
  return serialOpen === true && burning !== true && Array.isArray(pids) && pids.length > 0
}

export function wireJson(value) {
  const seen = new WeakSet()
  try {
    return JSON.stringify(value, (key, item) => {
      void key
      if (typeof item === 'bigint') return String(item)
      if (typeof item === 'function' || typeof item === 'symbol') return undefined
      if (item !== null && typeof item === 'object') {
        /* Node Timeout/Immediate handles: never wire them, and never walk their
           circular _idlePrev/_idleNext links. */
        if (typeof item.ref === 'function' && typeof item.unref === 'function') return undefined
        if (seen.has(item)) return undefined
        seen.add(item)
      }
      return item
    })
  } catch (error) {
    return JSON.stringify({ ev: 'error', message: 'serialize failed: ' + String(error && error.message ? error.message : error) })
  }
}

export function classifyDownloaderPids(pids, ourPid) {
  const list = Array.from(new Set((Array.isArray(pids) ? pids : []).filter(pid => Number.isInteger(pid) && pid > 0)))
  const mine = Number.isInteger(ourPid) && ourPid > 0 && list.includes(ourPid) ? ourPid : null
  return {
    total: list.length,
    mine,
    foreign: list.filter(pid => pid !== mine),
  }
}

export function shouldLaunchFlash(flash, helperAlive) {
  if (flash.connected) return false
  if (flash.launching) return false
  if (flash.pid && helperAlive) return false
  return true
}

/**
 * Acquire the connect lock synchronously, before any await in /flash/start.
 * Returns false for the second click/request while the first is still starting.
 */
export function beginFlashLaunch(flash, helperAlive) {
  if (!shouldLaunchFlash(flash, helperAlive)) return false
  flash.launching = true
  flash.launchAt = Date.now()
  return true
}
/**
 * `connected` is the IPC bridge's memory, not proof that the Downloader window
 * still exists. The tool can be closed/killed while the bridge stays alive; the
 * old code then sent StartDownload into nothing and the page kept "烧录中".
 */
export function isStaleFlashConnection(flash, downloaderPids) {
  if (flash === null || flash === undefined || flash.connected !== true) return false
  const pids = Array.isArray(downloaderPids) ? downloaderPids : []
  if (pids.length === 0) return true
  if (Number.isInteger(flash.pid) && flash.pid > 0 && pids.includes(flash.pid) === false) return true
  return false
}

/** 同类串口错误 3 秒内只保留一行；返回 null 表示这条被合并。 */
export function serialErrorLine(state, msg, now = Date.now()) {
  const text = String(msg || '').trim() || '未知错误'
  const last = state.serial.lastError
  if (last && last.msg === text && now - last.at < 3000) {
    state.serial.dupCount = (state.serial.dupCount || 0) + 1
    return null
  }
  const merged = state.serial.dupCount ? `（已合并 ${state.serial.dupCount} 条重复错误）` : ''
  state.serial.dupCount = 0
  state.serial.lastError = { msg: text, at: now }
  return `串口错误: ${text}${merged}`
}

/* Downloader.config keys that the vendor GUI exposes as persistent burn
   options. The other menu rows in the vendor tool are actions, not config. */
const BURN_OPTION_KEYS = {
  preTest: 'StartPreTestMode',
  erase: 'StartEraseMode',
  down: 'StartDownMode',
  extend: 'StartExtendMode',
}

export function withConfigValue(text, key, value) {
  const source = typeof text === 'string' ? text : ''
  const safeKey = String(key)
  const safeValue = String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  const re = new RegExp('(<add\\s+key=["\']' + safeKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '["\']\\s+value=["\'])([^"\']*)(["\'])', 'i')
  const match = re.exec(source)
  if (match !== null) {
    const next = source.slice(0, match.index + match[1].length) + safeValue + source.slice(match.index + match[1].length + match[2].length)
    return { text: next, changed: match[2] !== safeValue }
  }
  if (/<\/appSettings>/i.test(source)) {
    return {
      text: source.replace(/<\/appSettings>/i, '        <add key="' + safeKey + '" value="' + safeValue + '" />\n    </appSettings>'),
      changed: true,
    }
  }
  return { text: source, changed: false }
}

export function parseBurnOptions(text) {
  const source = typeof text === 'string' ? text : ''
  const read = (key) => {
    const re = new RegExp('<add\\s+key=["\']' + key + '["\']\\s+value=["\']([^"\']*)["\']', 'i')
    const match = re.exec(source)
    return match === null ? null : match[1]
  }
  return {
    preTest: read('StartPreTestMode') === 'True',
    erase: read('StartEraseMode') === 'True',
    down: read('StartDownMode') === 'True',
    extend: read('StartExtendMode') === 'True',
    speed: read('SpeedMode') || 'HighSpeed',
  }
}
/* watch.setting is an XML-ish generated settings file; only the one key matters
   here. Keep the rest of the file byte-for-byte so the vendor tool can still
   parse formatting/BOM exactly as before. */
const SLEEP_SETTING_RE = /(<add\s+key=["']sys_sleep_time["']\s+value=["'])([^"']*)(["'])/i

export function sleepSettingOf(text) {
  const source = typeof text === 'string' ? text : ''
  const match = SLEEP_SETTING_RE.exec(source)
  if (match === null) return { found: false, value: null, noSleep: false, text: source, changed: false }
  const value = match[2]
  return { found: true, value, noSleep: Number(value) === 0, text: source, changed: false }
}

export function withNoSleepSetting(text) {
  const source = typeof text === 'string' ? text : ''
  const match = SLEEP_SETTING_RE.exec(source)
  if (match !== null) {
    if (match[2] === '0') return { found: true, value: '0', noSleep: true, text: source, changed: false }
    const next = source.slice(0, match.index + match[1].length) + '0' + source.slice(match.index + match[1].length + match[2].length)
    return { found: true, value: '0', noSleep: true, text: next, changed: true }
  }
  /* The key is normally present; add it if an older generated file omitted it. */
  if (/<\/appSettings>/i.test(source)) {
    const next = source.replace(/<\/appSettings>/i, '        <add key="sys_sleep_time" value="0" />\n    </appSettings>')
    return { found: false, value: '0', noSleep: true, text: next, changed: true }
  }
  return { found: false, value: null, noSleep: false, text: source, changed: false }
}
export const __test = { shouldLaunchFlash, beginFlashLaunch, isStaleFlashConnection, isProcessAlive, shouldReleaseSerialForDownloader, classifyDownloaderPids, clearFlashTimers, wireJson, flashPlanOf, toolAutoStartOf, sameFlashPath, withAutoStartValue, isPrimaryFirmwareDcf, pickPrimaryFirmwareDcf, serialErrorLine, locationPayload, writeDownFile, isUnderScanRoot, resolveDlDir, readToolConfig, pruneBackups, sleepSettingOf, withNoSleepSetting, withConfigValue, parseBurnOptions }

export function apply(ctx) {
  /* AutoStart 是「第二遍烧录」的来源：插件活着的时候由它统一触发。
     先恢复上一次异常退出可能留下的 takeover，再重新接管。 */
  try { recoverAutoStart() } catch { /* non-fatal */ }
  try { takeOverAutoStart() } catch { /* non-fatal */ }

  /* Timer handles are private: state.flash is broadcast over SSE, and a Node
     Timeout contains circular _idlePrev/_idleNext links. */
  const flashTimers = { retryTimer: null, overallTimer: null }

  const state = {
    root: null,                 // 当前工作台根目录
    project: null,              // 当前选中的工程
    serial: { open: false, port: null, baud: 1500000, opening: false, lastError: null, dupCount: 0, suppressed: 0 },
    flash: {
      status: '离线', progress: 0, online: false, com: null, fwChecksum: null, devChecksum: null,
      connected: false, busy: false, burning: false, burnSeq: 0, doneSeq: 0, launching: false, launchAt: 0, staleChecks: 0,
      /* Flash generation + its timers; a newer flash invalidates the older one. */
      token: 0,
    },
    logs: [],                   // 环形日志（最近 N 条）
    logBatch: [],               // SSE 合并推送：每 60ms 一批，避免逐行 setState
    logBatchTimer: null,
    logFile: { size: 0, lines: 0, exists: false, truncated: false, rotated: false, error: null },
    dcfSize: 0,
    // 自动烧录：监听编译产物 dcf 的变化
    /* 自动烧录默认开启：用户的工作流是「改代码 -> 编译 -> 自动烧」，
       还要求每次手动点一下按钮才是反直觉的。 */
    watch: {
      on: true, path: null, lastMtime: 0, lastSize: 0, timer: null, armedAt: 0,
      /* Polls for the first app.dcf when boot had no build output yet. */
      bootTimer: null,
      /* Auto-flash serialization + real-process bookkeeping. */
      triggering: false, lastSkipLogAt: 0, lastProcCheckAt: 0, lastForeignLogAt: 0, blocked: null,
    },
    /* 由「源码管理」页告知的工作目录：扫描 dcf 时只认它，为空时才退回工具自己的目录。
       启动时从配置恢复，DSH 重启后不用再选一次。 */
    scanRoot: readToolConfig().scanRoot,
  }
  // 为 AI 阅读而设：保留很长的环形缓冲（不落盘、不导出）。
  // 50000 条大约是几百次烧录 / 数小时板卡输出；每条实体约 100B，总内存约 5MB。
  const MAX_LOGS = 50000
  const sseClients = new Set()
  /* 插件卸载时清掉未 flush 的日志批次定时器。 */
  ctx.effect(() => () => {
    if (state.logBatchTimer !== null) { clearTimeout(state.logBatchTimer); state.logBatchTimer = null }
    state.logBatch = []
    flushLogFile()
    if (logFileTimer !== null) { clearTimeout(logFileTimer); logFileTimer = null }
  }, 'downloader: log batch flush')
  /* Write the address sheet once at mount so it exists before any log line. */
  refreshLocation(state)

  /* 启动恢复：日志文件有数据就加载最近一段回工作台。 */
  ;(() => {
    const size = logFileSize()
    if (size <= 0) return
    const tail = readLogTail(LOG_FILE, LOG_FILE_LOAD_BYTES)
    const loaded = parseLogLines(tail.text)
    state.logs = loaded.slice(-MAX_LOGS)
    state.logFile.size = size
    state.logFile.lines = state.logs.length
    state.logFile.exists = true
    state.logFile.truncated = tail.truncated
  })()

  /* 写盘队列：250ms 合并一次（高波特率下每行一次 appendFile 同样会拖慢主进程）。 */
  const logFileQueue = []
  let logFileTimer = null
  let logFileBytes = state.logFile.size
  const flushLogFile = () => {
    logFileTimer = null
    if (logFileQueue.length === 0) return
    const items = logFileQueue.splice(0, logFileQueue.length)
    const text = items.map((item) => JSON.stringify(item)).join('\n') + '\n'
    const bytes = Buffer.byteLength(text)
    try {
      fs.mkdirSync(LOG_DIR, { recursive: true })
      // 轮转：超过 128MB 就把当前文件改名 .1（覆盖旧 .1），继续追加。
      if (logFileBytes + bytes > LOG_FILE_ROTATE_BYTES) {
        try { fs.renameSync(LOG_FILE, LOG_FILE + '.1') } catch { /* first run */ }
        logFileBytes = 0
        state.logFile.rotated = true
      }
      fs.appendFileSync(LOG_FILE, text, 'utf8')
      logFileBytes += bytes
      state.logFile.size = logFileBytes
      state.logFile.lines += items.length
      state.logFile.exists = true
      state.logFile.error = null
    } catch (e) {
      state.logFile.error = String(e.message || e)
    }
  }
  const enqueueLogFile = (item) => {
    logFileQueue.push(item)
    if (logFileTimer === null) logFileTimer = setTimeout(flushLogFile, 250)
  }
  const clearLogFile = () => {
    logFileQueue.length = 0
    if (logFileTimer !== null) { clearTimeout(logFileTimer); logFileTimer = null }
    logFileBytes = 0
    state.logFile.size = 0
    state.logFile.lines = 0
    state.logFile.exists = false
    state.logFile.error = null
    try { fs.mkdirSync(LOG_DIR, { recursive: true }) } catch { /* ignore */ }
    try { fs.writeFileSync(LOG_FILE, '', 'utf8') } catch (e) { state.logFile.error = String(e.message || e) }
    try { fs.rmSync(LOG_FILE + '.1', { force: true }) } catch { /* ignore */ }
  }

  const broadcast = (obj) => {
    const line = `data: ${wireJson(obj)}\n\n`
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
    /* ★ 批量推送：高波特率下每秒可能上千行，逐行 SSE + 逐行 setState 会把主进程
       和前端都拖慢。这里按 60ms 合并成 { ev:'logs', items }，单行仍是 1 条。 */
    enqueueLogFile(item)
    state.logBatch.push(item)
    if (state.logBatchTimer === null) {
      state.logBatchTimer = setTimeout(() => {
        state.logBatchTimer = null
        const items = state.logBatch
        state.logBatch = []
        if (items.length > 0) {
          broadcast({ ev: 'logs', items, file: { path: LOG_FILE, size: state.logFile.size, lines: state.logFile.lines } })
        }
      }, 60)
    }
    /* Keep the address sheet's counter warm without writing on every line. */
    const now = Date.now()
    if (!state._locationAt || now - state._locationAt > 5000) {
      state._locationAt = now
      refreshLocation(state)
    }
  }

  /* 让用户知道 AutoStart 被接管了（否则工具里关掉会让人以为我们改坏了）。
     位置必须在 pushLog 定义之后：写在 apply 开头会踩 const 的 TDZ。 */
  if (readToolConfig().autoStartPaused === true) {
    pushLog('S', '工作台已接管自动烧录：临时关闭 Downloader 的 AutoStart（停止自动烧录或退出 DSH 后恢复）')
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
        // open 失败现在由 helper 按 id 回包（见 AbSerialHost.cs）；这里只处理
        // 真正的异步错误，并且同类错误 3 秒内只打一行，避免刷屏。
        if (state.serial.opening) { state.serial.suppressed = (state.serial.suppressed || 0) + 1; return }
        const line = serialErrorLine(state, ev.msg)
        if (line) pushLog('S', line)
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
function freshestDcf(override) {
  /* override exists for tests: real callers always read the live state. */
  const st = override === undefined || override === null ? state : override
  const cands = new Set()
  if (st.flash !== undefined && st.flash !== null && st.flash.dcfPath) cands.add(st.flash.dcfPath)
  if (st.watch !== undefined && st.watch !== null && st.watch.path) cands.add(st.watch.path)
    //   这里直接深度有限地扫 Output\bin 目录。
    /* 用户在工作台里选的目录优先，而且**独占**：一旦设置了 scanRoot，就不再扫
     Downloader 工具自己的目录 —— 否则会在几个仓库的同名工程之间挑错 dcf。 */
  const scanRoots = st.scanRoot !== undefined && st.scanRoot !== ''
    ? [st.scanRoot]
    : [DEFAULT_WORKSPACE, st.root, st.project].filter(Boolean)
    for (const root of scanRoots) {
    try {
      const stack = [{ d: root, depth: 0 }]
      let guard = 0
      while (stack.length && guard++ < 40000) {
        const { d, depth } = stack.pop()
        if (depth > 8) continue
        let ents
        try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { continue }
        for (const e of ents) {
          const full = path.join(d, e.name)
          if (!e.isDirectory()) {
            /* Not just Output\bin any more: projects differ in where the build
               lands, and a *.dcf anywhere under the workspace is a candidate.
               "Freshest wins" then picks the one that was actually just built. */
            if (e.name.toLowerCase().endsWith('.dcf')) cands.add(full)
            continue
          }
          if (/^(\.git|node_modules|cmake|\.vscode|__pycache__)$/i.test(e.name)) continue
          stack.push({ d: full, depth: depth + 1 })
        }
      }
    } catch { }
  }
  /* 换过工作目录之后，旧工程里那个 dcf 往往更**新**（刚烧过），只按 mtime 排序
     会把旧文件又选回来。所以 scanRoot 存在时，先按目录过滤候选。 */
  let pool = cands
  if (st.scanRoot !== undefined && st.scanRoot !== '') {
    const rootResolved = path.resolve(st.scanRoot)
    pool = [...cands].filter((c) => {
      const abs = path.resolve(c)
      return abs === rootResolved || abs.startsWith(rootResolved + path.sep)
    })
  }
    /* ★ 只自动盯 app.dcf：同一工程里还有 app_gpu.dcf 之类的分体固件，
       「最新文件」会选错，烧错固件比慢一点更严重。 */
    const preferred = pickPrimaryFirmwareDcf([...pool])
    let best = null, bestT = 0
  for (const c of preferred) {
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
      const candidates = []
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
            candidates.push(full)
          }
        }
      }
      for (const c of pickPrimaryFirmwareDcf(candidates)) {
        try {
          const st = fs.statSync(c)
          if (st.mtimeMs > bestT) { bestT = st.mtimeMs; best = c }
        } catch { }
      }
      return best
    } catch { return null }
  }

  /* The generated watch.setting sits next to the current app.dcf under
     Settings/. Derive it from the watched DCF so a changed build output (and a
     different project) is followed automatically. */
  function watchSettingPath() {
    /* Use the DCF the watcher currently tracks. Do not scan scanRoot here: this
       function is called by a 2 s status poll, and a broad freshestDcf() scan on
       every poll would compete with git/build I/O. The UI re-polls as soon as
       watch.path appears. */
    const dcf = typeof state.watch.path === 'string' ? state.watch.path : ''
    if (dcf === '') return ''
    /* Derived from the CURRENT dcf, never a hard-coded project path. The vendor
       output puts it in Settings/; the two extra candidates cover older layouts
       and a file placed beside the dcf. */
    const dir = path.dirname(dcf)
    const candidates = [
      path.join(dir, 'Settings', 'watch.setting'),
      path.join(dir, 'settings', 'watch.setting'),
      path.join(dir, 'watch.setting'),
    ]
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate
    }
    return candidates[0]
  }

  /* Locate the config in the SELECTED Downloader.exe directory. Do not rely on
     the old environment/fallback directory: the page may point at a copied tool
     whose config sits beside that exact executable. */
  function downloaderConfigPath() {
    const exe = downloaderExePath()
    const dir = path.dirname(exe)
    const candidates = [path.join(dir, 'Downloader.config'), path.join(dir, 'downloader.config')]
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate
    }
    return candidates[0]
  }
  function burnOptionsStatus() {
    const file = downloaderConfigPath()
    if (!fs.existsSync(file)) return { path: file, exists: false }
    try {
      const parsed = parseBurnOptions(fs.readFileSync(file, 'utf8'))
      return { path: file, exists: true, ...parsed }
    } catch (error) {
      return { path: file, exists: true, error: String(error && error.message ? error.message : error) }
    }
  }

  /* Only the four persistent start flags and the speed mode are exposed by the
     vendor config. Other items in its Start dropdown are immediate actions; we
     do not invent keys for them. */
  function applyBurnOptions(updates) {
    const file = downloaderConfigPath()
    if (!fs.existsSync(file)) return { error: 'Downloader.config not found', path: file }
    let text = fs.readFileSync(file, 'utf8')
    const boolKeys = ['preTest', 'erase', 'down', 'extend']
    for (const name of boolKeys) {
      if (updates === null || updates === undefined || typeof updates[name] !== 'boolean') continue
      text = withConfigValue(text, BURN_OPTION_KEYS[name], updates[name] ? 'True' : 'False').text
    }
    if (typeof updates === 'object' && updates !== null && typeof updates.speed === 'string') {
      const speed = updates.speed
      if (!['HighSpeed', 'NormalSpeed', 'LowSpeed'].includes(speed)) {
        return { error: 'unsupported speed mode: ' + speed, path: file }
      }
      text = withConfigValue(text, 'SpeedMode', speed).text
    }
    /* Keep the last few vendor-config revisions; a bad toggle must be
       recoverable without hand-editing XML. */
    try {
      fs.copyFileSync(file, file + '.bak-' + Date.now())
      pruneBackups(file, 3)
    } catch (error) { void error }
    fs.writeFileSync(file, text, 'utf8')
    pushLog('S', '已更新 Downloader 烧录配置（下次启动 Downloader 生效）')
    return burnOptionsStatus()
  }
  function noSleepStatus() {
    const file = watchSettingPath()
    const auto = readToolConfig().noSleep === true
    if (file === '' || !fs.existsSync(file)) {
      return { auto, path: file, exists: false, value: null, noSleep: false }
    }
    try {
      const parsed = sleepSettingOf(fs.readFileSync(file, 'utf8'))
      return { auto, path: file, exists: true, value: parsed.value, noSleep: parsed.noSleep }
    } catch (error) {
      return { auto, path: file, exists: true, value: null, noSleep: false, error: String(error && error.message ? error.message : error) }
    }
  }

  /* Called immediately by the toggle and again before every launch/flash: a
     build can regenerate watch.setting with a sleep value, and an AI debug loop
     must still find the device awake on the next burn. */
  function applyNoSleep() {
    if (readToolConfig().noSleep !== true) return false
    const file = watchSettingPath()
    if (file === '' || !fs.existsSync(file)) return false
    try {
      const text = fs.readFileSync(file, 'utf8')
      const parsed = sleepSettingOf(text)
      const cfg = readToolConfig()
      /* If a build (or the user) put a new sleep value here, remember that as
         the value to restore on uncheck. A zero from our own write must not
         overwrite the original. */
      if (parsed.value !== null && (typeof cfg.noSleepOriginal !== 'string' || parsed.value !== '0')) {
        writeToolConfig({ noSleepOriginal: String(parsed.value) })
      }
      const next = withNoSleepSetting(text)
      if (next.changed === false) return true
      fs.writeFileSync(file, next.text, 'utf8')
      pushLog('S', '已把 Settings/watch.setting 的休眠时间改为不休眠（sys_sleep_time=0）')
      return true
    } catch (error) {
      pushLog('S', '修改 watch.setting 不休眠失败：' + String(error && error.message ? error.message : error))
      return false
    }
  }
  /* Enable/disable no-sleep and restore the exact value the file had before the
     checkbox first wrote 0. The original is persisted because DSH can restart
     between check and uncheck. */
  function setNoSleepMode(on) {
    const file = watchSettingPath()
    const before = readToolConfig()
    if (on === true) {
      if (file !== '' && fs.existsSync(file)) {
        try {
          const parsed = sleepSettingOf(fs.readFileSync(file, 'utf8'))
          const current = parsed.value === null ? '0' : String(parsed.value)
          if (typeof before.noSleepOriginal !== 'string' || (parsed.value !== null && parsed.value !== '0')) {
            writeToolConfig({ noSleepOriginal: current })
          }
        } catch (error) { void error }
      }
      writeToolConfig({ noSleep: true })
      applyNoSleep()
      return noSleepStatus()
    }

    const original = typeof before.noSleepOriginal === 'string' ? before.noSleepOriginal : ''
    let restored = false
    if (file !== '' && fs.existsSync(file) && /^\d+$/.test(original)) {
      try {
        const text = fs.readFileSync(file, 'utf8')
        const next = withConfigValue(text, 'sys_sleep_time', original)
        if (next.changed === true) {
          fs.writeFileSync(file, next.text, 'utf8')
          restored = true
        }
      } catch (error) {
        pushLog('S', '还原 watch.setting 休眠时间失败：' + String(error && error.message ? error.message : error))
      }
    }
    writeToolConfig({ noSleep: false, noSleepOriginal: null })
    pushLog('S', restored
      ? '已关闭自动不休眠，并还原 watch.setting 的 sys_sleep_time=' + original
      : '已关闭自动不休眠（没有可还原的原始值）')
    const status = noSleepStatus()
    status.restored = restored
    status.original = original
    return status
  }
  function watchTick() {
    const w = state.watch
    /* 每 5 秒核对一次真实进程，但只观察：手动打开的 Downloader 不会被结束。
       真正开始烧录（autoFlashRun / 显式连接）时才允许接管。 */
    const procNow = Date.now()
    if (!w.lastProcCheckAt || procNow - w.lastProcCheckAt > 5000) {
      w.lastProcCheckAt = procNow
      try {
        const reality = currentDownloaderReality()
        /* Merely OPENING Downloader is not permission to kill it. No automatic
           path (watch tick, auto flash, connect) may terminate a user-opened
           tool; only an explicit API call can, and the UI no longer does that. */
        if (reality.foreign.length > 0) {
          const now = Date.now()
          if (!w.lastForeignLogAt || now - w.lastForeignLogAt > 10000) {
            w.lastForeignLogAt = now
            pushLog('S', '检测到手动的 Downloader（PID ' + reality.foreign.join(',') +
              '）；自动烧录只观察、不结束它')
          }
        } else if (w.blocked !== null) {
          clearAutoBlock('多余实例已结束')
        }
      } catch (error) { void error }
    }
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

  /**
   * One auto-flash at a time. Watch ticks can fire several times for one build
   * (and a manual start can overlap); the old code ran them concurrently, which
   * produced two "自动开始烧录…" and two StartDownload commands.
   */
  async function autoFlashTrigger(st) {
    const w = state.watch
    if (!w.on) return
    if (w.triggering) {
      const now = Date.now()
      if (!w.lastSkipLogAt || now - w.lastSkipLogAt > 5000) {
        w.lastSkipLogAt = now
        pushLog('S', '自动烧录：上一次触发仍在处理，忽略重复的文件变化')
      }
      return
    }
    w.triggering = true
    try {
      await autoFlashRun(st)
    } finally {
      w.triggering = false
    }
  }

  async function autoFlashRun(st) {
    const w = state.watch
    if (!w.on) return
    pushLog('S', '检测到编译产物变化（' + Math.round(st.size / 1024) + 'KB），准备自动烧录')
    broadcast({ ev: 'watch', watch: { on: w.on, path: w.path } })
    applyNoSleep()
  // 若正在烧录就等一下
    for (let i = 0; i < 60 && state.flash.burning; i++) await new Promise(r => setTimeout(r, 500))
    if (state.flash.burning) { pushLog('S', '自动烧录跳过：已有烧录在进行'); return }
    // 串口让出由 doFlash 统一处理（它会记下 resumeAfterFlash）。
    // 不要在这里重复关，否则 resumeAfterFlash 被覆盖成 null、烧完抢不回串口。

    /* Bridge says connected but the tool window is gone: never queue a command
       into that dead connection. Reset, wait for the stale bridge to exit, then
       the process checks below launch a real Downloader. */
    if (resetStaleFlashConnection('自动烧录前')) {
      for (let i = 0; i < 12 && flashHelper.alive; i += 1) await new Promise(r => setTimeout(r, 100))
    }

    // ★★ 顺序：先让出串口，再拉起 Downloader。
    //   它扫不到设备就是因为 COM 被工作台占着（实测：重拉后 online 一直 false）。
    if (!state.flash.connected && state.serial.open) {
      stopSerialGuard()
      state.serial.resumeAfterFlash = state.serial.wantOpen
        || { port: state.serial.port, baud: state.serial.baud }
      try { await serialHelper.command('close', {}) } catch { }
      state.serial.open = false
      pushLog('S', '已让出串口（自动烧录需独占）')
      broadcast({ ev: 'serial-state', serial: state.serial })
      await new Promise(r => setTimeout(r, 250))
    }

    // ★ 按 Windows 实际进程决定「复用 / 启动 / 暂停」，绝不再拉起第二个。
    if (!state.flash.connected) {
      let reality = currentDownloaderReality()
      if (reality.foreign.length > 0) {
        /* NEVER kill a tool the user opened just because a build finished.
           Skip this auto attempt; the user can burn in the tool or close it. */
        pushLog('S', '自动烧录跳过：检测到你手动打开的 Downloader（PID ' + reality.foreign.join(', ') +
          '），不会结束它；关闭工具后可再自动烧录')
        restoreSerialAfterPause()
        return
      }
      if (reality.mine !== null) {
        if (flashHelper.alive) {
          pushLog('S', '自动烧录：Downloader 已在运行（PID ' + reality.mine + '），等待握手，不再启动第二个')
        } else {
          /* Bridge died but its child is still alive (job-object failure): it is
             ours, so clean it up before starting a fresh bridge. A user-started
             instance never has this recorded PID. */
          pushLog('S', '自动烧录：上一次的 IPC helper 已退出，清理它留下的 Downloader（PID ' + reality.mine + '）后重连')
          spawnSyncSafe('taskkill.exe', ['/PID', String(reality.mine), '/F'])
          state.flash.pid = null
          await new Promise(r => setTimeout(r, 300))
          reality = currentDownloaderReality()
        }
      }
      if (reality.foreign.length > 0) {
        pushLog('S', '自动烧录跳过：检测到手动 Downloader（PID ' + reality.foreign.join(', ') + '），不会结束它')
        restoreSerialAfterPause()
        return
      }
      if (!state.flash.connected && shouldLaunchFlash(state.flash, flashHelper.alive)) {
        pushLog('S', '自动烧录：启动 Downloader（当前没有其它实例）…')
        ensureComEnable()
        flashHelper.start()
        state.flash.launching = true
        state.flash.launchAt = Date.now()
        state.flash.tConnect = Date.now()
        state.flash.busy = true
        state.flash.stage = '启动 Downloader…'
        broadcast({ ev: 'flash', state: state.flash })
        flashHelper.line('launch')
      } else if (!state.flash.connected) {
        pushLog('S', '自动烧录：Downloader 正在启动，等待握手…')
      }
      let waited = 0
      while (waited < 20000 && !state.flash.connected) {
        await new Promise(r => setTimeout(r, 250))
        waited += 250
      }
      state.flash.busy = false
      if (!state.flash.connected) {
        pushLog('S', '自动烧录放弃：Downloader 启动失败（没有握手成功）')
        restoreSerialAfterPause()
        return
      }
    }

    /* Connected: re-check the real process list before sending the command. */
    let after = currentDownloaderReality()
    if (after.foreign.length > 0) {
      pushLog('S', '自动烧录跳过：连接后检测到手动 Downloader（PID ' + after.foreign.join(', ') + '），不会结束它')
      restoreSerialAfterPause()
      return
    }
    if (!flashHelper.alive) {
      pushLog('S', '自动烧录放弃：IPC helper 已退出，Downloader 收不到命令')
      restoreSerialAfterPause()
      return
    }

    /* 不再等 DevChange：Downloader 冷启动后要 30–60 秒才扫完 COM，而 StartDownload
       会被它排队、扫描完成后执行。实测日志里正是「我们放弃 9 秒后它自己烧完」。
       把命令交给它，进度帧会告诉我们真实结果。 */
    if (!state.flash.online) {
      pushLog('S', '设备状态还未上报，先把 StartDownload 交给 Downloader（扫描完成后自动执行）')
    }
    try {
      await doFlash({ confirm: true, auto: true })
    } catch (e) {
      pushLog('S', '自动烧录异常: ' + e.message)
    }
  }

  /** Real Downloader PIDs vs the one our bridge recorded. */
  function currentDownloaderReality() {
    const reality = classifyDownloaderPids(listDownloaderPids(), state.flash.pid)
    if (reality.mine === null) state.flash.pid = null
    return reality
  }

  /**
   * A second Downloader (user-opened, or an old leftover) owns COM/IPC too;
   * spawning another one is exactly the "打开两次工具会冲突" failure. Pause and
   * tell the user once per PID set instead of flooding the log every tick.
   */
  /**
   * Auto flashing aborted before Downloader accepts a command: hand the serial
   * port back so the log page is not left dead until the next manual action.
   */
  function restoreSerialAfterPause() {
    const resume = state.serial.resumeAfterFlash
    if (!resume) return
    state.serial.resumeAfterFlash = null
    try {
      void resumeSerial(resume.port, resume.baud)
    } catch (error) { void error }
  }

  /**
   * Take over from an extra Downloader (user-opened, or a leftover): kill the
   * PIDs our bridge did NOT launch, then let the caller continue with our own
   * instance. This is the requested behaviour: "自动直接接管".
   *
   * Deduped per PID set for 10 s so the 5 s monitor does not spam taskkill while
   * the process is terminating; a changed PID set retries immediately.
   */
  function takeOverForeign(reality, where) {
    const pids = reality.foreign.slice()
    if (pids.length === 0) return reality
    const key = pids.sort((a, b) => a - b).join(',')
    const w = state.watch
    const now = Date.now()
    if (w.blocked !== null && w.blocked.key === key && now - w.blocked.at < 10000) return reality
    w.blocked = { key, pids: pids.slice(), at: now }
    pushLog('S', '⚠ ' + where + '检测到额外的 Downloader 进程（PID ' + key + '），自动接管：结束它…')
    for (const pid of pids) {
      try { spawnSyncSafe('taskkill.exe', ['/PID', String(pid), '/F']) } catch (error) { void error }
    }
    state.flash.status = '自动接管 Downloader…'
    state.flash.stage = ''
    broadcast({ ev: 'flash', state: state.flash })
    return classifyDownloaderPids(listDownloaderPids(), state.flash.pid)
  }

  function clearAutoBlock(why) {
    const w = state.watch
    if (w.blocked === null) return
    w.blocked = null
    pushLog('S', '✓ 自动接管完成，' + why + '；继续自动烧录')
  }

  /**
   * The Downloader window can disappear while the IPC bridge stays alive. The
   * bridge then reports `connected:true` forever and StartDownload goes nowhere,
   * leaving the page stuck on 「烧录中」 until the 2-minute timeout (observed
   * 2026-11-14 11:53–12:07: no Downloader.exe, but page said 烧录中).
   * Reset the connection and stop the bridge so the next attempt starts a real
   * window instead of sending commands into a dead one.
   */
  function resetStaleFlashConnection(where) {
    /* A live recorded PID is authoritative; tasklist can briefly return an
       empty list during tool startup and must not be allowed to kill a healthy
       Downloader. */
    if (state.flash.connected && isProcessAlive(state.flash.pid)) return false
    const pids = listDownloaderPids()
    if (!isStaleFlashConnection(state.flash, pids)) return false
    clearFlashTimers(flashTimers)
    state.flash.connected = false
    state.flash.online = false
    state.flash.busy = false
    state.flash.burning = false
    state.flash.launching = false
    state.flash.pid = null
    state.flash.progress = 0
    state.flash.stage = ''
    state.flash.status = '离线'
    state.flash.lastDownStaAt = 0
    state.flash.scanSince = 0
    state.flash.staleChecks = 0
    pushLog('S', '[flash] Downloader 窗口已不存在（' + where + '），重置连接状态；下次会自动重新启动')
    broadcast({ ev: 'flash', state: state.flash })
    /* Capture the exact stale proc: a new bridge may be started after this
       reset, and the old code's delayed kill would then shoot down the NEW one. */
    const staleProc = flashHelper.proc
    try { flashHelper.line('quit') } catch { /* bridge may already be gone */ }
    const timer = setTimeout(() => {
      if (staleProc && flashHelper.proc === staleProc) {
        try { staleProc.kill() } catch { /* already gone */ }
      }
    }, 700)
    if (typeof timer.unref === 'function') timer.unref()
    return true
  }

  function clearBootWatch() {
    const w = state.watch
    if (w.bootTimer !== null && w.bootTimer !== undefined) {
      clearInterval(w.bootTimer)
      w.bootTimer = null
    }
  }

  function setWatch(on, p) {
    const w = state.watch
    clearBootWatch()
    if (w.timer) { clearInterval(w.timer); w.timer = null }
    if (w.pendingTimer) { clearTimeout(w.pendingTimer); w.pendingTimer = null }
    if (!on) {
      w.on = false
      pushLog('S', '已停止自动烧录')
      const restored = restoreAutoStart()
      if (restored.changed === true) pushLog('S', '已恢复 Downloader 的 AutoStart 开关')
      else pushLog('S', 'Downloader 的 AutoStart 已归还（若你后续要在工具里单用，它是开着的）')
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
    const preferred = (candidate) => {
      if (candidate === null || candidate === undefined) return candidate
      if (isPrimaryFirmwareDcf(candidate)) return candidate
      /* 同一目录里有 app.dcf 时就换成它（app_gpu.dcf 永远不是默认目标）。 */
      const primary = path.join(path.dirname(candidate), PRIMARY_FIRMWARE_NAME)
      return fs.existsSync(primary) ? primary : candidate
    }
    const target = preferred(p || w.path
      || (fromDl && fs.existsSync(fromDl) ? fromDl : null)
      || freshestDcf()
      || guessDcf(state.root) || guessDcf(state.project))
    if (!target || !fs.existsSync(target)) {
      pushLog('S', '开启自动烧录失败：找不到 dcf 文件' +
        (fromDl ? '（Downloader 报的路径不存在：' + fromDl + '）' : '——请先点「连接 Downloader」'))
      return { ok: false, error: 'no dcf', path: target || null, dcfPath: fromDl || null }
    }
    let st
    try { st = fs.statSync(target) } catch { return { ok: false, error: 'stat failed' } }
    /* 再次接管：用户可能在工具界面里把 AutoStart 又打开了。 */
    const took = takeOverAutoStart()
    if (took.changed === true) pushLog('S', '已临时关闭 Downloader 的 AutoStart：由工作台统一触发，避免两次「扫描中」')
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
   * DSH restart: state.watch.on is true by design, but a fresh process has no
   * watch timer. Arm it from the persisted scanRoot immediately; if the last
   * build left no app.dcf, poll cheaply until it appears (or until the page/
   * Downloader tells us a path) instead of showing "自动烧录 ◉" while nothing
   * is being monitored.
   */
  function armWatchOnBoot() {
    if (state.watch.on !== true || state.watch.timer !== null) return
    if (typeof state.scanRoot !== 'string' || state.scanRoot === '') return
    const target = freshestDcf()
    if (target !== null) {
      setWatch(true, target)
      return
    }
    pushLog('S', '自动烧录监控已开启：等待 app.dcf 出现在 ' + state.scanRoot)
    let tries = 0
    state.watch.bootTimer = setInterval(() => {
      if (state.watch.on !== true || state.watch.timer !== null) { clearBootWatch(); return }
      if (tries >= 40) { clearBootWatch(); return }
      tries += 1
      const pick = freshestDcf()
      if (pick !== null) {
        clearBootWatch()
        setWatch(true, pick)
      }
    }, 15000)
    if (typeof state.watch.bootTimer.unref === 'function') state.watch.bootTimer.unref()
  }

  /**
   * 实际发起一次烧录。
   * HTTP 的 /flash/download 和自动烧录都走这里，保证行为一致。
   * 返回 { ok, error?, message? }
   */
  async function doFlash(opts = {}) {
    const plan = flashPlanOf(state, opts)
    /* A build may have regenerated watch.setting; apply before command. */
  applyNoSleep()
  // ★ 先清掉上一轮残留状态（放最前面，避免任何 await 前被读到旧值）
    state.flash.lastBurn = null
    state.flash.progress = 0
    state.flash.status = '开始下载'
    state.flash.lastDownStaAt = 0
    state.flash.lastDlError = null
    state.flash.dlErrorAt = 0
    if (!state.flash.connected) return { ok: false, error: 'not-connected', message: '还未连接 Downloader' }
    /* Do not send StartDownload into a bridge whose Downloader window is gone. */
    if (resetStaleFlashConnection('烧录前')) {
      return { ok: false, error: 'disconnected', message: 'Downloader 窗口已不存在，已重置连接；请重新连接后再烧录' }
    }
    if (state.flash.burning && !opts.auto) return { ok: false, error: 'busy', message: '已有烧录在进行' }

    /* A new flash supersedes every timer of the previous one. Without this the
       old 120 s watchdog fired in the middle of a later flash and reported a
       timeout for a burn that was actually progressing. */
    const token = (state.flash.token || 0) + 1
    state.flash.token = token
    if (clearFlashTimers(flashTimers) === true) {
      pushLog('S', '[flash] 已清理上一轮烧录的超时/重试计时器')
    }

    // 1) 让出串口
    if (state.serial.open) {
      state.serial.resumeAfterFlash = state.serial.wantOpen
        || { port: state.serial.port, baud: state.serial.baud }
      stopSerialGuard()
      let closed = { ok: false }
      try { closed = await serialHelper.command('close', {}, 3000) } catch (error) { void error }
      if (!closed || closed.ok !== true) {
        startSerialGuard()
        state.flash.status = '串口被占用'
        state.flash.burning = false
        broadcast({ ev: 'flash', state: state.flash })
        pushLog('S', '✗ 无法让出串口 ' + state.serial.resumeAfterFlash.port + '（' +
          String((closed && (closed.msg || closed.error)) || 'helper 未确认') + '），烧录未开始')
        return { ok: false, error: 'serial-busy', message: '串口未能让出，Downloader 无法扫描' }
      }
      state.serial.open = false
      pushLog('S', '已让出串口 ' + state.serial.resumeAfterFlash.port + '（烧录需独占）')
      broadcast({ ev: 'serial-state', serial: state.serial })
      await new Promise(r => setTimeout(r, 200))
    }

    // 2) 等设备在线
    if (!state.flash.online) {
      if (plan.queueWhileOffline === true) {
        /* AUTO: give the command to Downloader NOW; it queues it during the COM
           scan and executes it when the device answers. */
        pushLog('S', '设备还未上报在线，先排队 StartDownload（Downloader 扫描完成后执行）')
      } else {
        let waited = 0
        while (waited < plan.offlineWaitMs && !state.flash.online) {
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
    }
    // ★ 若此时仍卡在「扫描中」，说明板子没响应（多半是休眠了）。
    //   手动路径直接说清楚；自动路径会把 StartDownload 排队，让 Downloader 自己判断。
    if (plan.abortWhenScanning === true && /扫描中/.test(state.flash.status || '')) {
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
    let lastSendAt = tCmd
    const retryLimit = plan.retryLimit
    const finishFail = (why) => {
      if (state.flash.token !== token) { clearInterval(retryTimer); return }
      clearFlashTimers(flashTimers)
      if (!state.flash.burning) return
      state.flash.burning = false
      state.flash.status = why
      pushLog('S', '✗ 烧录中止：' + why)
      broadcast({ ev: 'flash', state: state.flash })
    }
    const retryTimer = setInterval(() => {
      if (state.flash.token !== token) { clearInterval(retryTimer); return }
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
      if (retry >= retryLimit) {
        clearInterval(retryTimer)
        /* AUTO: keep waiting for Downloader's queued command instead of declaring a
           failure — a cold launch can take ~2 minutes. The overall 120 s timeout
           still bounds the wait. Manual keeps the immediate, actionable error. */
        if (plan.auto !== true) {
          finishFail('板子无响应（' + retryLimit + ' 次重试都没进展，可能已休眠，请重新上电/按复位）')
        }
        return
      }
      /* Space the resends out: a burst of StartDownload frames can make Downloader
         run the scan/burn several times. */
      if (Date.now() - lastSendAt < plan.retryDelayMs) return
      retry++
      lastSendAt = Date.now()
      pushLog('S', '未响应，重试发送 StartDownload（第 ' + retry + ' 次）')
      flashHelper.line('download')
    }, 3000)
    flashTimers.retryTimer = retryTimer

    // 5) 超时兜底（只防「一发命令就永远卡住」的极端情况）
    const overallTimer = setTimeout(() => {
      if (state.flash.token !== token) return
      const stale = isStaleFlashConnection(state.flash, listDownloaderPids())
      const wasActive = state.flash.burning === true
        || /烧录中|下载中|校验中|初始化/.test(String(state.flash.status || ''))
      clearFlashTimers(flashTimers)
      if (stale) {
        resetStaleFlashConnection('烧录超时')
      } else {
        state.flash.burning = false
        state.flash.online = false
        state.flash.stage = ''
        if (wasActive) state.flash.status = '烧录超时'
      }
      if (wasActive || stale) {
        pushLog('S', '[flash] 烧录超时（2 分钟无进展）')
        broadcast({ ev: 'flash', state: state.flash })
      }
    }, 120000)
    flashTimers.overallTimer = overallTimer
    return { ok: true }
  }

  let serialGuardTimer = null

  function stopSerialGuard() {
    if (serialGuardTimer !== null) {
      clearInterval(serialGuardTimer)
      serialGuardTimer = null
    }
  }

  /**
   * Downloader 打开后（无论谁启动的）随时可能扫描/烧录，它需要独占 COM。
   * 工作台若还开着串口，工具就会永远停在「扫描中」——这时主动让出，
   * 不要求用户拔插 USB。Downloader 退出后不会自动抢回，避免和工具反复抢。
   */
  async function releaseSerialForDownloader() {
    const pids = listDownloaderPids()
    if (!shouldReleaseSerialForDownloader(state.serial.open, state.flash.burning, pids)) return
    stopSerialGuard()
    const resume = state.serial.wantOpen || { port: state.serial.port, baud: state.serial.baud }
    state.serial.resumeAfterFlash = resume
    try {
      const r = await serialHelper.command('close', {})
      if (!r || r.ok !== true) {
        pushLog('S', '让出串口失败：' + String((r && (r.msg || r.error)) || 'helper 未确认'))
        startSerialGuard()
        return
      }
    } catch (e) {
      pushLog('S', '让出串口失败：' + String(e && e.message ? e.message : e))
      startSerialGuard()
      return
    }
    state.serial.open = false
    pushLog('S', '检测到 Downloader 正在运行（PID ' + pids.join(',') + '），已让出串口 ' + resume.port +
      '（否则它会一直「扫描中」；关闭工具后可再点「打开串口」）')
    broadcast({ ev: 'serial-state', serial: state.serial })
  }

  function startSerialGuard() {
    if (serialGuardTimer !== null) return
    serialGuardTimer = setInterval(() => { void releaseSerialForDownloader() }, 1500)
    if (typeof serialGuardTimer.unref === 'function') serialGuardTimer.unref()
  }

  async function resumeSerial(port, baud) {
    if (!port) return
    const startedAt = Date.now()
    // ★ Downloader 烧完会持续占着 COM 监控设备，必须先让它退出才能抢回。
    //   自动烧录不依赖它常驻——工作台自己监听 dcf，需要时会重新拉起它。
    try { flashHelper.line('quit') } catch { }
    stopSerialGuard()

    /* Give the bridge/Downloader a short graceful window, then force it. The old
       code waited up to 2 s for `connected` plus 200 ms, then still retried the
       port for up to 1.5 s: the user saw a 1549 ms dead window. */
    const orphanPid = state.flash.pid
    for (let i = 0; i < 6 && state.flash.connected; i += 1) {
      await new Promise(r => setTimeout(r, 100))
    }
    if (state.flash.connected || (orphanPid && isProcessAlive(orphanPid))) {
      try { if (flashHelper.proc) flashHelper.proc.kill() } catch (error) { void error }
      if (orphanPid && isProcessAlive(orphanPid)) {
        spawnSyncSafe('taskkill.exe', ['/PID', String(orphanPid), '/F'])
      }
      for (let i = 0; i < 20 && orphanPid && isProcessAlive(orphanPid); i += 1) {
        await new Promise(r => setTimeout(r, 50))
      }
    }
    for (let i = 0; i < 10 && state.flash.connected; i += 1) {
      await new Promise(r => setTimeout(r, 50))
    }
    if (state.flash.connected || listDownloaderPids().length > 0) {
      pushLog('S', 'Downloader 仍在运行，串口 ' + port + ' 先不抢回（避免它烧录时被工作台占用）')
      return
    }
    const readyAt = Date.now()
    const exitMs = readyAt - startedAt
    pushLog('S', '[恢复串口] Downloader 已退出（' + exitMs + 'ms），开始抢回 ' + port)

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

    // 快速轮询：每 30ms 试一次，最多 6 秒。单次 open 的 300ms 上限避免一次
    // 被占用把整个空窗拖长；失败时 helper 会快速应答。
    const deadline = Date.now() + 6000
    let tries = 0
    let lastError = ''
    while (Date.now() < deadline) {
      tries++
      const r = await serialHelper.command('open', { port, baud }, 300)
      if (r && r.ok) {
        state.serial.open = true
        state.serial.port = port
        state.serial.baud = baud
        state.serial.wantOpen = { port, baud }
        const totalMs = Date.now() - startedAt
        const openMs = Date.now() - readyAt
        pushLog('S', '已自动恢复串口 ' + port + ' @' + baud +
          '（工具退出 ' + exitMs + 'ms + 打开 ' + openMs + 'ms = 空窗 ' + totalMs + 'ms）')
        startSerialGuard()
        broadcast({ ev: 'serial-state', serial: state.serial })
        return
      }
      lastError = String((r && (r.msg || r.error)) || '')
      await new Promise(r => setTimeout(r, 30))
    }
    const totalMs = Date.now() - startedAt
    pushLog('S', '串口 ' + port + ' 自动恢复失败（' + tries + ' 次尝试，空窗 ' + totalMs +
      'ms' + (lastError === '' ? '' : '，最后错误：' + lastError) + '），请手动点「打开串口」')
  }

  // ---- 烧录 helper（IPC 驱动官方 Downloader）----
  // 用 BackShowMode 让 Downloader 窗口**可见**（用户要求：连接到 Downloader 时要能看见它），
  // 并传 --no-hide 阻止 helper 自己隐藏窗口。
  // 实测对照：BackMode => visible=False；BackShowMode => visible=True。
  const ipcExe = IPC_HELPER_CANDIDATES.find(p => fs.existsSync(p))
  const flashHelper = new LineHelper(
    ipcExe || IPC_HELPER_CANDIDATES[0],
    [
      '--exe', downloaderExePath(),
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
        state.flash.launching = false
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
          state.flash.launching = false
          state.flash.busy = false
          state.flash.staleChecks = 0
          state.flash.stage = '已连接，正在扫描设备…'
          state.flash.status = '已连接'
          if (state.flash.tConnect) {
            pushLog('S', `Downloader 已连接（握手 ${Date.now() - state.flash.tConnect}ms）`)
          } else {
            pushLog('S', 'Downloader 已连接')
          }
          state.flash.tConnect = 0
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
          /* 设备其实在线时 Downloader 不一定再发 DevChange（冷启动时序会漏）。
             状态机走到这些状态就说明它在——否则界面一直显示“离线”，手动烧录也会被拦。 */
          if (/扫描中|初始化|就绪|预校验|下载中|校验中|完成/.test(state.flash.status || '')) {
            state.flash.online = true
          }

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
            clearFlashTimers(flashTimers)
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
            clearFlashTimers(flashTimers)
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
          state.flash.fwSize = Number(f[4] || 0)
          state.flash.fwChecksum = f[5] || null
          /* ★ 取消「连上就被覆盖」：FileInfo 报的是 Downloader 自己 config 里记的
             dcf，切换过工作目录后那个值还是旧工程的。一连接就把它当成当前固件，
             用户看到的就是「切了目录，固件文件又变回去」。
             规则：只有落在当前工作目录内、并且是主固件 app.dcf 才采纳。 */
          const underScanRoot = isUnderScanRoot(newDcf, state.scanRoot)
          const primaryFirmware = isPrimaryFirmwareDcf(newDcf)
          const acceptDcf = underScanRoot && primaryFirmware
          if (acceptDcf) {
            state.flash.dcfPath = newDcf
      state.flash.dcfSize = fileSizeOf(newDcf)
        /* 默认开启：Downloader 一连上就报它准备烧的 dcf，这是最常见的
           「开始监听」时机（用户可能只是打开 DSH 就编译）。 */
        if (state.watch.on === true && state.watch.timer === null && fs.existsSync(newDcf)) {
          setWatch(true, newDcf)
        }
          } else if (underScanRoot !== true) {
            pushLog('S', '已忽略 Downloader 报的 dcf（不在当前工作目录下）：' + newDcf
              + (state.flash.dcfPath ? '；继续使用：' + state.flash.dcfPath : '；当前无可用 dcf'))
          } else if (state.watch.lastIgnoredDcf !== newDcf) {
            /* app_gpu.dcf 之类的分体固件：不跟，避免烧错。同一条只提示一次。 */
            state.watch.lastIgnoredDcf = newDcf
            pushLog('S', '已忽略非主固件 dcf（只自动烧录 app.dcf）：' + path.basename(newDcf))
          }
          // ★ 用户在 Downloader 里换了 dcf 时，正在监听的路径必须跟着换。
          //   否则自动烧录会一直盯着旧文件 —— 新 dcf 变了也不触发（实测踩过）。
          if (state.watch.on && acceptDcf && newDcf && state.watch.path !== newDcf) {
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
              const lastSwitch = state.watch.lastSwitchLog
              const duplicate = lastSwitch !== undefined && lastSwitch !== null
                && lastSwitch.to === newDcf && lastSwitch.from === (oldPath || '')
                && Date.now() - lastSwitch.at < 3000
              if (duplicate !== true) {
                state.watch.lastSwitchLog = { from: oldPath || '', to: newDcf, at: Date.now() }
                pushLog('S', '自动烧录已切换到新 dcf：' + path.basename(newDcf) +
                  (oldPath ? '（原来：' + path.basename(oldPath) + '）' : ''))
              }
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
          if (p2 && !p2.startsWith('__') && isUnderScanRoot(p2, state.scanRoot)) {
            state.flash.dcfPath = p2
      state.flash.dcfSize = fileSizeOf(p2)
            if (state.watch.on && isPrimaryFirmwareDcf(p2) !== true) {
              if (state.watch.lastIgnoredDcf !== p2) {
                state.watch.lastIgnoredDcf = p2
                pushLog('S', '已忽略非主固件 dcf（只自动烧录 app.dcf）：' + path.basename(p2))
              }
            } else if (state.watch.on && state.watch.path !== p2) {
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
      case 'exit': {
        // helper 退出了：不管成功失败，都要把"连接中"放开，
        // 否则界面上永远停在「连接中…」
        const orphanPid = state.flash.pid
        clearFlashTimers(flashTimers)
        state.flash.busy = false
        state.flash.launching = false
        state.flash.pid = null
        state.flash.connected = false
        state.flash.stage = ''
        state.flash.status = '离线'
        state.flash.online = false
        pushLog('S', `[flash] helper 已退出（code=${ev.code}）`)
        broadcast({ ev: 'flash', state: state.flash })
        /* Job Object normally kills the child; this is the safety net for the
           case where it failed (observed as an orphaned Downloader holding COM).
           Only the PID we recorded is killed — never a user-started instance. */
        if (Number.isInteger(orphanPid) && orphanPid > 0) {
          setTimeout(() => {
            try {
              if (listDownloaderPids().includes(orphanPid)) {
                spawnSyncSafe('taskkill.exe', ['/PID', String(orphanPid), '/F'])
                pushLog('S', '[flash] 已清理 helper 退出后残留的 Downloader（PID ' + orphanPid + '）')
              }
            } catch (error) { void error }
          }, 400)
        }
        break
      }
      case 'error':
      case 'fatal':
        state.flash.busy = false
        state.flash.launching = false
        state.flash.stage = ''
        pushLog('S', `[flash] ${ev.msg}`)
        broadcast({ ev: 'flash', state: state.flash })
        break
    }
  }

  // 注册 HTTP 路由。webServer 是可选服务，用 ctx.inject 包起来，
  // 缺了也只是少一层 UI，不会让整个插件停摆。
  /* 插件卸载 / DSH 正常退出：把 Downloader 的 AutoStart 还给用户。 */
  ctx.effect(() => () => {
    clearTimeout(bootArmTimer)
    clearInterval(flashLivenessTimer)
    clearBootWatch()
    stopSerialGuard()
    if (state.watch.timer !== null) { clearInterval(state.watch.timer); state.watch.timer = null }
    /* HMR/workbench reload does not restart the DSH process, so its child
       helpers would otherwise survive beside the replacement plugin (two
       bridges, COM conflicts). Close them explicitly on plugin disposal. */
    try { flashHelper.line('quit') } catch (error) { void error }
    try { serialHelper.line('quit') } catch (error) { void error }
    try { restoreAutoStart() } catch { /* non-fatal */ }
  }, 'downloader: restore AutoStart')

  /* Auto-flash is on by default: restore monitoring across a DSH restart.
     Deferred so the startup tree scan cannot delay DSH's first paint. */
  const bootArmTimer = setTimeout(() => {
    try { armWatchOnBoot() } catch (e) { pushLog('S', '自动烧录启动失败：' + String(e && e.message ? e.message : e)) }
  }, 1500)
  if (typeof bootArmTimer.unref === 'function') bootArmTimer.unref()

  /* The IPC bridge can outlive the Downloader window. Poll only while the page
     claims a connection, so a closed/killed tool cannot leave the UI stuck on
     「烧录中」or make auto-flash send StartDownload into nothing. */
  const flashLivenessTimer = setInterval(() => {
    if (state.flash.connected !== true) { state.flash.staleChecks = 0; return }
    try {
      const pid = state.flash.pid
      let alive = Number.isInteger(pid) && pid > 0 ? isProcessAlive(pid) : null
      if (alive === null) {
        /* No recorded PID (old bridge/recovered state): fall back to tasklist,
           but still require two consecutive misses before killing anything. */
        alive = listDownloaderPids().length > 0
      }
      if (alive === true) { state.flash.staleChecks = 0; return }
      state.flash.staleChecks = (state.flash.staleChecks || 0) + 1
      if (state.flash.staleChecks >= 2) resetStaleFlashConnection('运行状态轮询')
    } catch (error) { void error }
  }, 3000)
  if (typeof flashLivenessTimer.unref === 'function') flashLivenessTimer.unref()

  ctx.inject(['webServer'], (scoped) => {
    scoped.effect(() => scoped.webServer.register({
      kind: 'prefix',
      path: '/downloader',
      handler: (req, res) => handleHttp(req, res, state, {
        scanLevel, gitStatus, serialHelper, flashHelper, broadcast, pushLog,
        sseClients, DEFAULT_DL_DIR, guardDcf: guessDcf, setWatch, doFlash, freshestDcf,
        clearLogFile, startSerialGuard, stopSerialGuard, resetStaleFlashConnection,
        noSleepStatus, applyNoSleep, burnOptionsStatus, applyBurnOptions, setNoSleep: (on) => setNoSleepMode(on),
        clearFlashTimersNow: () => clearFlashTimers(flashTimers),
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

    // ★ 地址清单：模型一步定位日志缓存（内存、不落盘），再决定用 downloader_logs 取哪些。
    scoped.tools.register({
      name: 'downloader_logs_location',
      description:
        '返回 Downloader 日志缓存的地址清单：存储位置（宿主内存环形缓冲、不落盘、重启清空）、' +
        '读取工具 downloader_logs 与 HTTP 路由 /downloader/log/recent 及参数、当前总条数、' +
        '工作区根、地址清单文件路径，以及全量日志文件 logFile（JSONL，可直接读）。' +
        '排查日志前先调用它定位。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async execute() {
        refreshLocation(state)
        return JSON.stringify(locationPayload(state), null, 2)
      },
    })

    // ★ 给 AI 的日志检索工具：让模型自己取需要的那几行，
    //   而不是把数万条日志全塞进上下文。
    scoped.tools.register({
      name: 'downloader_logs',
      description:
        '读取 Downloader 工作台的串口/烧录日志。' +
        '缓存位置：宿主内存环形缓冲（最多 50000 条，不落盘）；先用 downloader_logs_location 看地址清单。' +
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
  const cfgPath = path.join(resolveDlDir(), 'Downloader.config')
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
  const { scanLevel, gitStatus, serialHelper, flashHelper, broadcast, pushLog, sseClients, DEFAULT_DL_DIR, guardDcf, setWatch, doFlash, freshestDcf, clearLogFile, startSerialGuard, stopSerialGuard, resetStaleFlashConnection, noSleepStatus, applyNoSleep, burnOptionsStatus, applyBurnOptions, setNoSleep, clearFlashTimersNow } = api

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
      // 连点/重复请求：只允许一个 in-flight open，避免并发 open 互相把端口关掉。
      if (state.serial.opening) return json(res, 409, { error: 'opening', message: '正在打开串口，请稍候' })
      if (!serialHelper.alive) serialHelper.start()
      // ★ 刚烧完时 Downloader 可能还没完全退出、COM 句柄还没释放。
      //   只在「占用/拒绝访问」这类可恢复错误上重试，其它错误立刻返回；
      //   每次失败都是带 id 的回包（不再等 3 秒超时），所以重试很快。
      state.serial.opening = true
      state.serial.suppressed = 0
      let r = { ok: false, error: 'not-tried' }
      let attempts = 0
      try {
        for (let i = 0; i < 4; i++) {
          attempts = i + 1
          r = await serialHelper.command('open', { port: body.port, baud: body.baud || 1500000 }, 3000)
          if (r && r.ok) break
          const why = String(r.msg || r.error || '')
          if (!/denied|拒绝|占用|busy|access|正在使用/i.test(why)) break
          await new Promise(x => setTimeout(x, 250))
        }
        if (r.ok) {
          state.serial.open = true
          state.serial.port = body.port
          state.serial.baud = body.baud || 1500000
          // 记住用户意图：他想看串口。烧录会临时抢走，烧完要按这个意图还回去
          state.serial.wantOpen = { port: body.port, baud: body.baud || 1500000 }
          pushLog('S', `串口 ${body.port} @${state.serial.baud} 已打开`)
          startSerialGuard()
          broadcast({ ev: 'serial-state', serial: state.serial })
        } else {
          const merged = state.serial.suppressed ? `（已合并 ${state.serial.suppressed} 条重复错误）` : ''
          const why = r.msg || r.error || '未知原因（可能被占用）'
          pushLog('S', `串口 ${body.port} 打开失败（尝试 ${attempts} 次）：${why}${merged}`)
        }
      } finally {
        state.serial.opening = false
      }
      return json(res, 200, r)
    }

    if (p === '/serial/close' && req.method === 'POST') {
      stopSerialGuard()
      /* Closing is an explicit "I do not want the log port": forget the pending
         wantOpen intent, otherwise the next flash silently reopens it. */
      state.serial.wantOpen = null
      state.serial.resumeAfterFlash = null
      let r = { ok: true }
      try {
        if (!serialHelper.alive) serialHelper.start()
        r = await serialHelper.command('close', {}, 3000)
      } catch (e) {
        r = { ok: false, error: String(e && e.message ? e.message : e) }
      }
      state.serial.open = false
      state.serial.port = null
      pushLog('S', r.ok === true ? '串口已关闭' : '串口已关闭（helper 未确认：' + String(r.error || r.msg || '未知') + '）')
      broadcast({ ev: 'serial-state', serial: state.serial })
      return json(res, r.ok === true ? 200 : 500, r)
    }

    if (p === '/serial/write' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req))
      serialHelper.start()
      const payload = body.hex ? { hex: body.hex } : { text: body.text }
      pushLog('U', body.text || body.hex || '')
      const r = await serialHelper.command('write', payload, 5000)
      return json(res, 200, r)
    }

    // 清空日志：内存缓冲 + 本地 JSONL 文件（含轮转文件）一起清。
    if (p === '/log/clear' && req.method === 'POST') {
      state.logs.length = 0
      // 还没 flush 的批次也要丢掉，否则清空后旧行会被补推回来。
      state.logBatch = []
      if (state.logBatchTimer !== null) { clearTimeout(state.logBatchTimer); state.logBatchTimer = null }
      clearLogFile()
      broadcast({ ev: 'log-clear' })
      return json(res, 200, { ok: true })
    }

    // 日志文件占用（页面显示 / AI 定位）
    if (p === '/log/file' && req.method === 'GET') {
      return json(res, 200, logFileInfo(state))
    }

    // 全量日志搜索（Notepad++ 风格）：直接扫本地 JSONL，不受内存工作集限制。
    if (p === '/log/search' && req.method === 'GET') {
      const qp = url.searchParams
      const q = (qp.get('q') || '').trim()
      if (q === '') return json(res, 400, { error: 'bad-request', message: 'q is required' })
      const caseSensitive = qp.get('case') === '1'
      const wholeWord = qp.get('word') === '1'
      const useRegex = qp.get('regex') === '1'
      const src = (qp.get('src') || '').trim()
      const limit = Math.max(1, Math.min(5000, Number(qp.get('limit') || 2000)))
      let pattern
      try {
        let source = useRegex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        if (wholeWord) source = '\\b(?:' + source + ')\\b'
        pattern = new RegExp(source, caseSensitive ? '' : 'i')
      } catch (error) {
        return json(res, 400, { error: 'bad-regex', message: String((error && error.message) || error) })
      }
      const size = logFileSize()
      const tail = readLogTail(LOG_FILE, LOG_FILE_LOAD_BYTES)
      const all = parseLogLines(tail.text)
      const matches = []
      let total = 0
      for (const item of all) {
        if (src !== '' && item.src !== src) continue
        pattern.lastIndex = 0
        if (pattern.test(item.text) === false) continue
        total += 1
        if (matches.length < limit) matches.push(item)
      }
      return json(res, 200, {
        matches,
        total,
        scanned: all.length,
        hasMore: total > matches.length,
        fileSize: size,
        truncated: tail.truncated,
        limit,
      })
    }

    // 定位：按时间戳（+文本）找到某条日志，返回它前后各 N 条上下文。
    if (p === '/log/context' && req.method === 'GET') {
      const qp = url.searchParams
      const at = Number(qp.get('t') || 0)
      const text = qp.get('text') || ''
      const before = Math.max(0, Math.min(1000, Number(qp.get('before') || 200)))
      const after = Math.max(0, Math.min(1000, Number(qp.get('after') || 200)))
      const tail = readLogTail(LOG_FILE, LOG_FILE_LOAD_BYTES)
      const all = parseLogLines(tail.text)
      let index = -1
      for (let i = all.length - 1; i >= 0; i -= 1) {
        if (all[i].t !== at) continue
        if (text !== '' && all[i].text !== text) continue
        index = i
        break
      }
      if (index < 0) return json(res, 200, { found: false, logs: [], index: -1, total: all.length })
      const start = Math.max(0, index - before)
      const end = Math.min(all.length, index + after + 1)
      return json(res, 200, {
        found: true,
        logs: all.slice(start, end),
        index: index - start,
        total: all.length,
        hasOlder: start > 0,
        hasNewer: end < all.length,
      })
    }

    // 更早的历史：页面向上滚动时从本地 JSONL 继续加载（内存只留工作集，文件是全量）
    if (p === '/log/history' && req.method === 'GET') {
      const before = Number(url.searchParams.get('before') || 0) || (Date.now() + 1)
      const limit = Math.max(1, Math.min(5000, Number(url.searchParams.get('limit') || 2000)))
      const size = logFileSize()
      let logs = []
      let hasMore = false
      if (size > 0) {
        const tail = readLogTail(LOG_FILE, LOG_FILE_LOAD_BYTES)
        const all = parseLogLines(tail.text).filter((item) => item.t < before)
        const slice = all.slice(-limit)
        logs = slice
        hasMore = all.length > slice.length || (tail.truncated && slice.length > 0)
      }
      return json(res, 200, { logs, hasMore, total: state.logs.length, fileSize: size })
    }

    // ★ 日志地址清单：AI 第一步先读这里定位，再按需取内容。
    if (p === '/log/location' && req.method === 'GET') {
      refreshLocation(state)
      return json(res, 200, locationPayload(state))
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
      /* connected is bridge memory; if the window is gone, returning already:true
         here was how a click ended up waiting forever for a tool that was not
         there. Reset and launch a real one. */
      if (resetStaleFlashConnection('连接检查')) {
        await new Promise(r => setTimeout(r, 800))
      }
      if (state.flash.connected && flashHelper.alive) {
        return json(res, 200, { ok: true, already: true })
      }

      // ★ 启动互斥：正在启动（或已 launched 但还没握手）时绝不再发一次 launch，
      //   否则 helper 会拉起第二个 Downloader（Windows 上就是“工具冲突”）。
      //   readBody/serial close 都有 await：锁必须在第一个 await 之前同步拿到，
      //   否则两个点击都会通过 guard，各发一次 launch（已实测）。
      if (!beginFlashLaunch(state.flash, flashHelper.alive)) {
        return json(res, 200, { ok: true, pending: true, message: 'Downloader 正在启动，请稍候' })
      }
      const releaseConnect = () => {
        state.flash.launching = false
        state.flash.launchAt = 0
        state.flash.busy = false
      }
      let started = false
      try {
        const body = await readBody(req).catch(() => '{}')
        let force = false
        try { force = !!JSON.parse(body || '{}').force } catch { }

        // ★ 最常见的失败原因：用户自己开着 Downloader。
        //   它占着串口、也不响应我们的 IPC，helper 新起的实例永远等不到 StartOK。
        //   必须在启动前就拦住并说清原因，而不是让用户干等 12 秒看到"超时"。
        const foreign = findForeignDownloader([state.flash.pid])
        if (foreign.length && !force) {
          const pids = foreign.map(f => f.pid).join(', ')
          pushLog('S', `检测到已有 Downloader 在运行（PID ${pids}），它会占用串口并阻止握手`)
          releaseConnect()
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
            stopSerialGuard()
            const closed = await serialHelper.command('close', {}, 3000)
            if (!closed || closed.ok !== true) {
              startSerialGuard()
              releaseConnect()
              pushLog('S', '串口 ' + state.serial.resumeAfterFlash.port + ' 未能让出（' +
                String((closed && (closed.msg || closed.error)) || 'helper 未确认') + '），已取消启动 Downloader')
              return json(res, 409, {
                error: 'serial-busy',
                message: '串口还被占用，Downloader 会一直扫描。请先关闭串口或拔插后再连接。',
              })
            }
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
        applyNoSleep()
    if (!flashHelper.start()) {
          releaseConnect()
          return json(res, 500, { error: 'helper-start-failed', message: 'IPC helper 启动失败' })
        }
        state.flash.busy = true
        state.flash.tConnect = Date.now()
        state.flash.stage = '启动 Downloader…'
        pushLog('S', '正在启动 Downloader（窗口可见）…')
        broadcast({ ev: 'flash', state: state.flash })
        flashHelper.line('launch')
        started = true
        // 看门狗：12 秒还没握手就认输并放开 busy。
        // Downloader 冷启动实测 1.3-1.5s，握手总耗时约 2s；12s 是安全上限。
        setTimeout(() => {
          if (state.flash.busy && !state.flash.connected) {
            state.flash.busy = false
            state.flash.launching = false
            state.flash.stage = ''
            state.flash.status = '连接超时'
            pushLog('S', '[flash] 连接超时：12 秒内没有收到 StartOK。' +
              '可能 Downloader 已被占用，或 BackShowMode 参数在该版本上不生效。')
            broadcast({ ev: 'flash', state: state.flash })
          }
        }, 12000)
        return json(res, 200, { ok: true })
      } finally {
        if (!started) releaseConnect()
      }
    }

    // 查有没有别处启动的 Downloader（前端在打开烧录页时先探一次）
    if (p === '/flash/foreign' && req.method === 'GET') {
      return json(res, 200, { running: findForeignDownloader([state.flash.pid]) })
    }

    // ★ 环境自检：把「能连上但看不到设备」的几个已知原因一次查清。
    //   最坑的一条：Downloader.config 里 COMEnable 被写成 False，
    //   此时 Downloader 不扫 COM 口，DevChange 永远不来，界面一直"离线"，
    //   但握手/FileInfo 都正常——表现得像是插件坏了。
    if (p === '/flash/diagnose' && req.method === 'GET') {
      const out = { ok: true, checks: [] }
      const dlDir = resolveDlDir()
      const cfgPath = path.join(dlDir, 'Downloader.config')
      const add = (name, ok, detail, fix) => out.checks.push({ name, ok, detail, fix })

      add('Downloader 目录', fs.existsSync(dlDir), dlDir)
      add('Downloader.exe', fs.existsSync(downloaderExePath()), downloaderExePath())
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
      const cfgPath = path.join(resolveDlDir(), 'Downloader.config')
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
      const list = findForeignDownloader([state.flash.pid])
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
      state.flash.dcfSize = fileSizeOf(body.path)
      pushLog('S', `已记录目标固件：${body.path}（可在 Downloader 窗口里用「浏览」切换）`)
      broadcast({ ev: 'flash', state: state.flash })
      return json(res, 200, { ok: true, dcfPath: body.path })
    }

    // Downloader 的窗口是否已经出现（用户在任务栏应该能看到）
    if (p === '/setting/no-sleep' && req.method === 'GET') {
      return json(res, 200, noSleepStatus())
    }

    if (p === '/setting/no-sleep' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req))
      const result = setNoSleep(body !== null && body !== undefined && body.on === true)
      if (result !== null && result !== undefined && result.error) {
        return json(res, 500, { error: result.error })
      }
      pushLog('S', '自动不休眠：' + (result.auto === true ? '已开启' : '已关闭'))
      return json(res, 200, result)
    }
    if (p === '/setting/burn' && req.method === 'GET') {
      return json(res, 200, burnOptionsStatus())
    }

    if (p === '/setting/burn' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req))
      const result = applyBurnOptions(body === null || body === undefined ? {} : body)
      if (result !== null && result !== undefined && result.error) {
        return json(res, 500, { error: result.error })
      }
      return json(res, 200, result)
    }
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

    if (p === '/flash/erase' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req))
      if (!body.confirm) return json(res, 400, { error: '需要确认' })
      if (!state.flash.connected) return json(res, 409, { ok: false, error: 'not-connected' })
      if (state.flash.burning) return json(res, 409, { ok: false, error: 'busy' })
      const sent = flashHelper.line('erase')
      if (!sent) return json(res, 409, { ok: false, error: 'helper-not-running' })
      pushLog('S', '发送 StartErase（全片擦除）')
      return json(res, 200, { ok: true })
    }

    if (p === '/flash/stop' && req.method === 'POST') {
      /* line() normally returns false on a dead bridge; keep the state reset in
         all cases so the page can never stay "烧录中" after a disconnect. */
      try { flashHelper.line('quit') } catch (error) { void error }
      clearFlashTimersNow()
      state.flash.busy = false
      state.flash.launching = false
      state.flash.pid = null
      state.flash.burning = false
      state.flash.connected = false
      state.flash.online = false
      state.flash.progress = 0
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

    // ---- 工具路径（Downloader.exe）----
  if (p === '/tool') {
    if (req.method === 'GET') {
      const configured = readToolConfig().exe
      const dir = resolveDlDir()
      const exeGuess = configured !== ''
        ? configured
        : path.join(DEFAULT_DL_DIR, 'Downloader.exe')
      return json(res, 200, {
        exe: configured,
        exeGuess,
        dir,
        configFile: path.join(dir, 'Downloader.config'),
        configExists: fs.existsSync(path.join(dir, 'Downloader.config')),
      })
    }
    if (req.method === 'POST') {
      const body = JSON.parse(await readBody(req))
      const next = typeof body.exe === 'string' ? body.exe.trim() : ''
      if (next !== '' && !fs.existsSync(next)) {
        return json(res, 400, { error: '找不到这个文件', exe: next })
      }
      const saved = writeToolConfig({ exe: next })
      if (saved.ok !== true) return json(res, 500, { error: saved.error })
      /* The IPC helper was created with the old --exe argument; update it so the
         next connect launches the file the user just selected. */
      try {
        flashHelper.args = ['--exe', downloaderExePath(), '--args', 'BackShowMode {hwnd}', '--no-hide']
      } catch (error) { void error }
      const dir = resolveDlDir()
      pushLog('S', next === ''
        ? '已恢复默认的 Downloader 路径'
        : 'Downloader 路径已设为：' + next)
      return json(res, 200, {
        ok: true,
        exe: next,
        dir,
        configExists: fs.existsSync(path.join(dir, 'Downloader.config')),
      })
    }
  }
  // ★ 工作台「源码管理」页告知当前工作目录。
  //   为什么需要：dcf 扫描原来只认 Downloader 工具自己的目录，
  //   用户在大仓里换成另一个工程后，扫描结果仍然是旧工程 —— 烧错文件。
  //   现在工作台把选中的目录告诉宿主，扫描和自动烧录都跟着它走。
  if (p === '/workspace') {
    if (req.method === 'GET') {
      return json(res, 200, {
        root: state.scanRoot,
        effective: state.scanRoot !== '' ? state.scanRoot : null,
        watch: state.watch.on === true ? state.watch.path : null,
      })
    }
    if (req.method === 'POST') {
      const body = JSON.parse(await readBody(req))
      const next = typeof body.root === 'string' && body.root.trim() !== ''
        ? path.resolve(body.root.trim())
        : ''
      if (next !== '' && !fs.existsSync(next)) {
        return json(res, 400, { error: 'root not found', root: next })
      }
      const changed = next !== state.scanRoot
      /* 同一个目录被重复告知是正常的（面板重挂、轮询、StrictMode 双调用）。
         重复上报不该刷日志，也不该重算 dcf —— 否则日志里全是同一行。 */
      if (!changed) {
        return json(res, 200, { ok: true, unchanged: true, root: state.scanRoot, watch: state.watch.path })
      }
      state.scanRoot = next
      /* 记下来，DSH 重启后不用再选一次。 */
      writeToolConfig({ scanRoot: next })
      /* 扫描目录变了之后只打一行摘要，把「找到哪个 dcf / 写没写进配置」并进去。 */
      let summary = '扫描目录已切换：' + (next === '' ? '(工具默认)' : next)
      const pick = freshestDcf()
      if (pick === null) {
        state.flash.dcfPath = null
      state.flash.dcfSize = 0
        summary += '（新目录下还没有 dcf，等编译产物）'
      } else {
        state.flash.dcfPath = pick
      state.flash.dcfSize = fileSizeOf(pick)
        const wrote = writeDownFile(pick)
        summary += ' → 固件 ' + path.basename(pick)
        summary += wrote.ok === true
          ? '（已写入 Downloader 配置，下次启动生效）'
          : '（写入 Downloader 配置失败：' + String(wrote.error) + '）'
      }
      broadcast({ ev: 'flash', state: state.flash })
      pushLog('S', summary)
      /* 自动烧录正在监听时，监听目标也必须跟着换，否则还盯着旧工程的 dcf。 */
      let watchPath = state.watch.path
      if (state.watch.on === true && pick !== null && state.watch.timer === null) {
        const armed = setWatch(true, pick)
        if (armed.ok === true) watchPath = state.watch.path
      } else if (state.watch.on === true && pick !== null && pick !== state.watch.path) {
        const st = fs.statSync(pick)
        state.watch.path = pick
        state.watch.lastMtime = st.mtimeMs
        state.watch.lastSize = st.size
        state.watch.armedAt = Date.now()
        if (state.watch.pendingTimer) { clearTimeout(state.watch.pendingTimer); state.watch.pendingTimer = null }
        watchPath = pick
        broadcast({ ev: 'watch', watch: { on: true, path: pick } })
        pushLog('S', '自动烧录监听改为：' + path.basename(pick))
      }
      /* 默认开启时 on 一开始就是 true，但还没有监听目标，定时器从未启动。
         选定 dcf 的这一刻才是真正开始监听的时机。 */
      if (state.watch.on === true && state.watch.timer === null && pick !== null) {
        setWatch(true, pick)
      }
      return json(res, 200, { ok: true, root: state.scanRoot, watch: watchPath })
  }
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
      state.flash.dcfSize = fileSizeOf(newPath)
      return json(res, 200, { ok: true, applied: wasOn, path: newPath })
    }

    if (p === '/flash/config' && req.method === 'GET') {
      // 只读展示 Downloader.config 里的槽位信息（帮用户确认用哪个 dcf）
      const cfgPath = path.join(resolveDlDir(), 'Downloader.config')
      let slots = []
      try {
        const cfg = await fsp.readFile(cfgPath, 'utf8')
        const re = /<add key="(DownFile\d*)" value="([^"]*)"/g
        let m
        while ((m = re.exec(cfg))) slots.push({ key: m[1], file: m[2] })
      } catch { }
      const dir = resolveDlDir()
      return json(res, 200, { dir, exists: fs.existsSync(dir), slots })
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
    logs: state.logs.slice(-20000),
    logFile: logFileInfo(state),
  }
}

function spawnSyncSafe(cmd, args) {
  // 只在注册表查询这种一次性、极快的场景用（2s 超时），避免长时间阻塞事件循环
  try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 2000 }) } catch { return '' }
}

/** Cheap exact PID probe: no `tasklist` spawn, no transient empty output. */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return Boolean(error && error.code === 'EPERM')
  }
}
/**
 * All Downloader.exe PIDs Windows currently reports (cheap: tasklist ~50 ms).
 * This is the "actual running state" the auto-flash decision now uses.
 */
function listDownloaderPids() {
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
    return pids
  } catch {
    return []
  }
}

/**
 * Downloader.exe processes that our bridge did NOT launch.
 *
 * Passing the bridge's own child PID matters: a helper that launched a
 * Downloader but has not received StartOK yet must not treat that child as a
 * foreign instance (that made the old code kill/relaunch its own process).
 */
function findForeignDownloader(exceptPids) {
  const except = new Set((Array.isArray(exceptPids) ? exceptPids : [exceptPids])
    .filter(pid => Number.isInteger(pid) && pid > 0))
  return listDownloaderPids().filter(pid => !except.has(pid)).map(pid => ({ pid, parent: null }))
}

























