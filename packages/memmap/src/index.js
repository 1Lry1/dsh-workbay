/**
 * dsh-workbench-memmap — host half.
 *
 * Owns ONE capability the workbench pages cannot do themselves: run the SDK's
 * memory-map analysis script and serve its artefacts back to the panel.
 *
 *   detect  看工作区里有没有 tools/memmap_report/memmap_report.py 和构建产出的
 *           map.txt；顺便探测 Python 是否可用（结果缓存 60 秒）。
 *   run     用一个 argv 数组 spawn python，产物写进插件数据目录（不污染仓库），
 *           然后返回一份小的摘要 + 与上次运行的基线差异。
 *   runs    历史运行列表（每次运行都会落一份 summary.json）。
 *   report  把那次运行生成的整份 HTML 报告读回来，面板用它做 iframe。
 *
 * 安全边界：只运行工作区里 `tools/memmap_report/memmap_report.py` 这一条路径；
 * map.txt 必须 realpath 在工作区内；argv 数组、无 shell；超时 180 秒；stdout/stderr
 * 截断；产物目录只允许读取 `<dataDir>/roots/<hash>/runs/<runId>/` 下的 json/html。
 *
 * 数据目录默认 `~/.dsh/workbench/memmap/`（每次构建的产物很大，不应该出现在用户仓库里），
 * 每次运行写 `runs/<runId>/{memmap_data.json,memmap_report.html,summary.json}`，保留最近
 * `keepRuns` 次（默认 10 次，自动裁剪）。
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mountJsonApi, badRequest, ApiError, isRealPathInside } from '@dsh-workbay/kit'

export const name = 'dsh-workbench-memmap'
export const inject = ['webServer']

const ROUTE_PREFIX = '/dsh-workbench-memmap/api'
const MAX_BODY_BYTES = 256 * 1024
const MAX_HTML_BYTES = 16 * 1024 * 1024
const MAX_STREAM_CHARS = 64 * 1024
const TOOL_REL = path.join('tools', 'memmap_report', 'memmap_report.py')
/* The script is vendored with the plugin (see package.json "files"), which is what
   makes the page useful in ANY project instead of only in SDKs that carry it. */
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))
const BUNDLED_TOOL = path.resolve(MODULE_DIR, '..', 'tools', 'memmap_report.py')
const RUN_ID_PATTERN = /^\d{8}-\d{6}-[0-9a-z]{4,8}$/
/* Real SDKs nest deeper than app/projects/<p>/Output/bin: one workspace here is
   <root>/bluetrum/app/projects/standard/Output/bin, i.e. map.txt at depth 6. The
   scan used to stop at 5 and silently found nothing. */
const MAX_SCAN_DEPTH = 7
/* Last-resort search: only after the structured/loose/ancestor/sibling scans found
   nothing. Bounded by directory count so a huge tree cannot freeze the page. */
const DEEP_SCAN_DEPTH = 12
const DEEP_DIR_LIMIT = 20000

const DEFAULTS = {
  python: 'python',
  timeoutMs: 180_000,
  keepRuns: 10,
  dataDir: '',
}

let hostConfig = Object.assign({}, DEFAULTS)
let pythonProbeCache = { at: 0, value: null }
const PYTHON_PROBE_TTL_MS = 60_000

/* ============================== configuration ============================== */

function normalizeConfig(config) {
  const input = config === null || config === undefined ? {} : config
  const python = input.python === undefined || input.python === null ? DEFAULTS.python : input.python
  const timeoutMs = Number(input.timeoutMs)
  const keepRuns = Number(input.keepRuns)
  const dataDir = typeof input.dataDir === 'string' && input.dataDir.trim() !== ''
    ? path.resolve(input.dataDir)
    : DEFAULTS.dataDir
  return {
    python,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs >= 10_000 ? Math.floor(timeoutMs) : DEFAULTS.timeoutMs,
    keepRuns: Number.isFinite(keepRuns) && keepRuns >= 1 ? Math.min(50, Math.floor(keepRuns)) : DEFAULTS.keepRuns,
    dataDir,
  }
}

/**
 * `python: 'python'` / `['py', '-3']` / `'/venv/bin/python'` all work. An array
 * form is what makes the runner testable with a fake interpreter, and it is also
 * the honest answer for Windows' `py -3` launcher.
 */
function pythonSpecOf(value) {
  if (Array.isArray(value)) {
    const parts = value.filter((entry) => typeof entry === 'string' && entry !== '')
    if (parts.length === 0) throw badRequest('python command is empty')
    return { command: parts[0], prefixArgs: parts.slice(1) }
  }
  if (typeof value === 'string' && value.trim() !== '') {
    return { command: value.trim(), prefixArgs: [] }
  }
  throw badRequest('python command must be a string or an array of strings')
}

function dataRootOf(root) {
  const base = hostConfig.dataDir !== '' ? hostConfig.dataDir : path.join(os.homedir(), '.dsh', 'workbench', 'memmap')
  const hash = createHash('sha1').update(root.toLowerCase()).digest('hex').slice(0, 16)
  return path.join(base, 'roots', hash)
}

function runsDirOf(root) {
  return path.join(dataRootOf(root), 'runs')
}

/* ============================== workspace scanning ============================== */

const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', 'out', '__pycache__', 'build', '.cache'])

function isDir(value) {
  try {
    return statSync(value).isDirectory()
  } catch (error) {
    void error
    return false
  }
}

function isFile(value) {
  try {
    return statSync(value).isFile()
  } catch (error) {
    void error
    return false
  }
}

/** Breadth-first search for `<dir>/tools/memmap_report/memmap_report.py`. */
function findTool(root) {
  const queue = [{ dir: root, depth: 0 }]
  while (queue.length > 0) {
    const current = queue.shift()
    const direct = path.join(current.dir, TOOL_REL)
    if (isFile(direct)) return direct
    if (current.depth >= 4) continue
    let entries
    try {
      entries = readdirSync(current.dir, { withFileTypes: true })
    } catch (error) {
      void error
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory() !== true || SKIP_DIRS.has(entry.name.toLowerCase())) continue
      queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 })
    }
  }
  return null
}

/**
 * Build artefacts: `…/Output/bin/map.txt`. The project name is the directory that
 * owns `Output`, which is what the script prints as its report title.
 */
function findMaps(root) {
  const found = []
  const queue = [{ dir: root, depth: 0 }]
  while (queue.length > 0 && found.length < 24) {
    const current = queue.shift()
    const candidate = path.join(current.dir, 'map.txt')
    if (isFile(candidate)) {
      const binDir = current.dir
      const outputDir = path.dirname(binDir)
      const projectDir = path.dirname(outputDir)
      if (path.basename(outputDir).toLowerCase() === 'output' && path.basename(binDir).toLowerCase() === 'bin') {
        let stat = null
        try {
          stat = statSync(candidate)
        } catch (error) {
          void error
        }
        if (stat !== null) {
          found.push({
            path: candidate,
            project: path.basename(projectDir),
            projectDir,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
          })
        }
      }
    }
    if (current.depth >= MAX_SCAN_DEPTH) continue
    let entries
    try {
      entries = readdirSync(current.dir, { withFileTypes: true })
    } catch (error) {
      void error
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory() !== true || SKIP_DIRS.has(entry.name.toLowerCase())) continue
      queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 })
    }
  }
  found.sort((left, right) => right.mtimeMs - left.mtimeMs)
  return found
}

/**
 * Fallback when a project does not use the SDK's `Output/bin` layout: accept any
 * `map.txt` inside the workspace. The analysis itself rejects a map that is not
 * a GNU ld map, so a wrong file surfaces as a readable error rather than a
 * silently wrong report.
 */
function findLooseMaps(root) {
  /* Unlike the structured scan this one MUST enter uild/ and out/: those are
     exactly where a non-SDK project keeps its map.txt. */
  const looseSkip = new Set(['node_modules', '.git', '.svn', '.hg', '__pycache__', '.cache'])
  const found = []
  const queue = [{ dir: root, depth: 0 }]
  while (queue.length > 0 && found.length < 12) {
    const current = queue.shift()
    let entries
    try {
      entries = readdirSync(current.dir, { withFileTypes: true })
    } catch (error) {
      void error
      continue
    }
    for (const entry of entries) {
      const full = path.join(current.dir, entry.name)
      if (entry.isFile() === true && entry.name.toLowerCase() === 'map.txt') {
        let stat = null
        try {
          stat = statSync(full)
        } catch (error) {
          void error
        }
        if (stat !== null) {
          const binDir = path.dirname(full)
          const ownerDir = path.dirname(binDir)
          found.push({
            path: full,
            project: path.basename(ownerDir),
            projectDir: ownerDir,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            loose: true,
          })
        }
        continue
      }
      if (entry.isDirectory() !== true || current.depth + 1 > MAX_SCAN_DEPTH) continue
      if (looseSkip.has(entry.name.toLowerCase())) continue
      queue.push({ dir: full, depth: current.depth + 1 })
    }
  }
  found.sort((left, right) => right.mtimeMs - left.mtimeMs)
  return found
}

/**
 * Absolute last resort: a bounded walk for ANY file named map.txt deeper than the
 * normal scan (renamed directory trees, unusual build layouts). Results are
 * SUGGESTIONS only — never auto-selected — and the walk stops at a directory
 * budget so it stays responsive on a giant SDK.
 */
function findDeepMaps(root) {
  const found = []
  const queue = [{ dir: root, depth: 0 }]
  let visited = 0
  while (queue.length > 0 && found.length < 12 && visited < DEEP_DIR_LIMIT) {
    const current = queue.shift()
    visited += 1
    let entries
    try {
      entries = readdirSync(current.dir, { withFileTypes: true })
    } catch (error) {
      void error
      continue
    }
    for (const entry of entries) {
      const full = path.join(current.dir, entry.name)
      if (entry.isFile() === true && entry.name.toLowerCase() === 'map.txt') {
        try {
          const stat = statSync(full)
          const binDir = path.dirname(full)
          found.push({
            path: full,
            project: path.basename(path.dirname(binDir)) || path.basename(binDir),
            projectDir: path.dirname(binDir),
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            deep: true,
          })
        } catch (error) {
          void error
        }
        continue
      }
      if (entry.isDirectory() !== true) continue
      if (current.depth + 1 > DEEP_SCAN_DEPTH) continue
      const name = entry.name.toLowerCase()
      if (name === 'node_modules' || name === '.git' || name === '.svn' || name === '.hg' || name === '__pycache__' || name === '.cache') continue
      queue.push({ dir: full, depth: current.depth + 1 })
    }
  }
  found.sort((left, right) => right.mtimeMs - left.mtimeMs)
  return found
}

function mergeSuggestions(nearby, deep) {
  const seen = new Set()
  const merged = []
  for (const entry of nearby.concat(deep)) {
    if (seen.has(entry.path)) continue
    seen.add(entry.path)
    merged.push(entry)
    if (merged.length >= 12) break
  }
  return merged
}


/**
 * When a workspace has no map at all, look ONE level sideways: project folders
 * often live next to the SDK that builds them (`.../ido/project-a/demo` beside
 * `.../ido/demo_sdk`). Only the known SDK layouts are probed, the
 * candidates are returned for the user to PICK (never auto-selected), and the
 * scan is capped so it stays a few directory reads.
 */
function findNearbyMaps(root) {
  const found = []
  const seen = new Set()
  const add = (entries) => {
    for (const entry of entries) {
      if (found.length >= 8) return
      if (seen.has(entry.path)) continue
      seen.add(entry.path)
      found.push(Object.assign({ nearby: true }, entry))
    }
  }
  let cursor = root
  for (let level = 0; level < 3; level += 1) {
    const parent = path.dirname(cursor)
    if (parent === cursor) break
    let entries
    try {
      entries = readdirSync(parent, { withFileTypes: true })
    } catch (error) {
      void error
      break
    }
    for (const entry of entries) {
      if (found.length >= 8) break
      if (entry.isDirectory() !== true) continue
      if (SKIP_DIRS.has(entry.name.toLowerCase())) continue
      const sibling = path.join(parent, entry.name)
      if (sibling === root || sibling === cursor) continue
      add(findAncestorMaps(sibling))
    }
    cursor = parent
  }
  found.sort((left, right) => right.mtimeMs - left.mtimeMs)
  return found
}

/**
 * Ancestors are only checked for the SDK layouts a project can sit inside:
 * <ancestor>/Output/bin/map.txt and <ancestor>/app/projects/<p>/Output/bin/map.txt
 * (plus a projects/ variant). A full scan of an ancestor such as %TEMP% takes
 * tens of seconds and is never what the user meant.
 */
function findAncestorMaps(ancestor) {
  const found = []
  const push = (filePath) => {
    if (isFile(filePath) !== true) return
    let stat = null
    try {
      stat = statSync(filePath)
    } catch (error) {
      void error
    }
    if (stat === null) return
    const binDir = path.dirname(filePath)
    const projectDir = path.dirname(path.dirname(binDir))
    found.push({
      path: filePath,
      project: path.basename(projectDir),
      projectDir,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    })
  }
  push(path.join(ancestor, 'Output', 'bin', 'map.txt'))
  for (const relative of [path.join('app', 'projects'), 'projects']) {
    const projects = path.join(ancestor, relative)
    if (isDir(projects) !== true) continue
    let entries = []
    try {
      entries = readdirSync(projects, { withFileTypes: true })
    } catch (error) {
      void error
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory() !== true) continue
      push(path.join(projects, entry.name, 'Output', 'bin', 'map.txt'))
      if (found.length >= 12) break
    }
  }
  found.sort((left, right) => right.mtimeMs - left.mtimeMs)
  return found
}

/** Walk up from a detected root to the SDK that owns a 	ools/ copy. */
function toolOwnerAbove(start) {
  let cursor = start
  for (let level = 0; level < 4; level += 1) {
    const parent = path.dirname(cursor)
    if (parent === cursor) return ''
    if (isFile(path.join(parent, TOOL_REL))) return parent
    cursor = parent
  }
  return ''
}

/** The workspace's own copy wins; the bundled copy makes every project work. */
function resolveTool(root) {
  const workspaceTool = findTool(root)
  if (workspaceTool !== null) return { tool: workspaceTool, source: 'workspace' }
  if (isFile(BUNDLED_TOOL)) return { tool: BUNDLED_TOOL, source: 'bundled' }
  return { tool: null, source: 'none' }
}

/**
 * A DSH workspace root is often the REPOSITORY (or project) directory, while the
 * build output may live one or two levels up. Probe the root and its ancestors;
 * the first candidate that has a map wins, and the detected root is what every
 * later run uses.
 */
function detectAt(root) {
  const candidates = []
  let cursor = root
  for (let level = 0; level < 4; level += 1) {
    candidates.push(cursor)
    const parent = path.dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  for (const candidate of candidates) {
    const isWorkspaceRoot = candidate === root
    const directTool = path.join(candidate, TOOL_REL)
    const workspaceTool = isWorkspaceRoot ? findTool(candidate) : (isFile(directTool) ? directTool : null)
    const structured = isWorkspaceRoot ? findMaps(candidate) : findAncestorMaps(candidate)
    /* A loose map is only trusted at the workspace root: scanning an arbitrary
       ancestor (a temp dir, a user profile) for any file named map.txt would
       attach an unrelated project's report. Ancestors must use Output/bin. */
    const maps = isWorkspaceRoot && structured.length === 0 ? findLooseMaps(candidate) : structured
    if (maps.length === 0) continue
    /* A project can sit inside an SDK: use the SDK root (and its tools/ copy) as
       the detection result, which is also the directory the script runs in. */
    const owner = workspaceTool === null ? toolOwnerAbove(candidate) : ''
    const detectedRoot = owner === '' ? candidate : owner
    const resolved = workspaceTool !== null
      ? { tool: workspaceTool, source: 'workspace' }
      : resolveTool(detectedRoot)
    return { root: detectedRoot, tool: resolved.tool, toolSource: resolved.source, maps, searched: candidates }
  }
  /* Nothing complete: still report what was found so the page can explain. */
  const resolved = resolveTool(root)
  const structured = findMaps(root)
  return {
    root,
    tool: resolved.tool,
    toolSource: resolved.source,
    maps: structured.length > 0 ? structured : findLooseMaps(root),
    searched: candidates,
  }
}

/* ============================== python probe ============================== */

function execFileAsync(command, args, options) {
  return new Promise((resolve) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      resolve({
        error: error === null || error === undefined ? null : error,
        stdout: typeof stdout === 'string' ? stdout : '',
        stderr: typeof stderr === 'string' ? stderr : '',
      })
    })
  })
}

function clipStream(text) {
  if (typeof text !== 'string' || text.length <= MAX_STREAM_CHARS) return text
  return text.slice(0, MAX_STREAM_CHARS) + `\n… [truncated ${text.length - MAX_STREAM_CHARS} chars] …`
}

async function probePython(force) {
  const now = Date.now()
  if (force !== true && pythonProbeCache.value !== null && now - pythonProbeCache.at < PYTHON_PROBE_TTL_MS) {
    return pythonProbeCache.value
  }
  let spec
  try {
    spec = pythonSpecOf(hostConfig.python)
  } catch (error) {
    const value = { ok: false, version: '', command: String(hostConfig.python), error: error.message }
    pythonProbeCache = { at: now, value }
    return value
  }
  const result = await execFileAsync(spec.command, [...spec.prefixArgs, '-c', 'import sys; print(sys.version.split()[0])'], {
    timeout: 15_000,
    windowsHide: true,
    maxBuffer: 256 * 1024,
    env: process.env,
  })
  if (result.error !== null) {
    const missing = result.error.code === 'ENOENT'
    const value = {
      ok: false,
      version: '',
      command: spec.command,
      error: missing
        ? `${spec.command} 不在 PATH 里`
        : (clipStream(result.stderr.trim()) || result.error.message),
    }
    pythonProbeCache = { at: now, value }
    return value
  }
  const version = result.stdout.trim().split('\n')[0] || ''
  const value = { ok: true, version, command: spec.command, error: null }
  pythonProbeCache = { at: now, value }
  return value
}

/* ============================== run index ============================== */

function runDirsOf(root) {
  const runsDir = runsDirOf(root)
  if (isDir(runsDir) === false) return []
  let entries
  try {
    entries = readdirSync(runsDir, { withFileTypes: true })
  } catch (error) {
    void error
    return []
  }
  const runs = []
  for (const entry of entries) {
    if (entry.isDirectory() !== true || RUN_ID_PATTERN.test(entry.name) === false) continue
    const dir = path.join(runsDir, entry.name)
    let stat = null
    try {
      stat = statSync(dir)
    } catch (error) {
      void error
    }
    runs.push({ runId: entry.name, dir, mtimeMs: stat === null ? 0 : stat.mtimeMs })
  }
  runs.sort((left, right) => right.mtimeMs - left.mtimeMs)
  return runs
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch (error) {
    void error
    return null
  }
}

function readRunIndex(root) {
  const runs = []
  for (const run of runDirsOf(root)) {
    const summary = readJsonFile(path.join(run.dir, 'summary.json'))
    if (summary === null) continue
    runs.push(summary)
    if (runs.length >= hostConfig.keepRuns + 5) break
  }
  return runs
}

function pruneRuns(root) {
  const runs = runDirsOf(root)
  for (const stale of runs.slice(hostConfig.keepRuns)) {
    try {
      rmSync(stale.dir, { recursive: true, force: true })
    } catch (error) {
      void error
    }
  }
}

/* ============================== summary / delta ============================== */

function numberOf(value, fallback) {
  return Number.isFinite(value) ? value : fallback
}

function summarizeData(data, context) {
  const meta = data !== null && data !== undefined && typeof data.meta === 'object' && data.meta !== null ? data.meta : {}
  const totals = meta.totals !== null && typeof meta.totals === 'object' ? meta.totals : {}
  const regions = (Array.isArray(data.regions) ? data.regions : []).map((region) => ({
    name: String(region.n),
    origin: numberOf(region.o, 0),
    length: numberOf(region.len, 0),
    used: numberOf(region.used, 0),
    free: numberOf(region.free, 0),
    pct: numberOf(region.pct, 0),
    desc: typeof region.desc === 'string' ? region.desc : '',
    cats: region.cats !== null && typeof region.cats === 'object' ? region.cats : {},
    sections: Array.isArray(region.secs) ? region.secs.length : 0,
    overlays: Array.isArray(region.overlays) ? region.overlays.length : 0,
    alias: Array.isArray(region.alias) ? region.alias : [],
  }))
  const objects = (Array.isArray(data.objects) ? data.objects : [])
    .map((object) => ({
      name: String(object.n),
      path: typeof object.p === 'string' ? object.p : '',
      module: typeof object.m === 'string' ? object.m : '',
      size: numberOf(object.sz, 0),
    }))
    .sort((left, right) => right.size - left.size)
    .slice(0, 12)
  const symbols = (Array.isArray(data.symbols) ? data.symbols : [])
    .filter((symbol) => Array.isArray(symbol) && symbol[4] !== 'F')
    .map((symbol) => ({
      addr: numberOf(symbol[0], 0),
      size: numberOf(symbol[1], 0),
      section: numberOf(symbol[2], 0),
      object: numberOf(symbol[3], 0),
      kind: String(symbol[4]),
      name: String(symbol[5]),
      cat: String(symbol[6]),
    }))
    .sort((left, right) => right.size - left.size)
    .slice(0, 12)
  return {
    runId: context.runId,
    generatedAt: context.generatedAt,
    durationMs: numberOf(context.durationMs, 0),
    project: typeof meta.project === 'string' ? meta.project : '',
    mapPath: typeof meta.map === 'string' ? meta.map : context.mapPath,
    hasSymtab: meta.has_symtab === true,
    symbolCount: numberOf(meta.nsym, 0),
    python: context.python,
    totals: {
      internalRam: numberOf(totals.internal_ram, 0),
      ramCapacity: numberOf(totals.ram_capacity, 0),
      psram: numberOf(totals.psram, 0),
      psramCapacity: numberOf(totals.psram_capacity, 0),
      flash: numberOf(totals.flash, 0),
      flashCapacity: numberOf(totals.flash_capacity, 0),
    },
    appBin: meta.app_bin === null || meta.app_bin === undefined ? null : numberOf(meta.app_bin, 0),
    warnings: Array.isArray(meta.warnings) ? meta.warnings.map((warning) => String(warning)) : [],
    regions,
    objects,
    symbols,
  }
}

const VARIABLE_CATEGORIES = new Set(['data', 'bss', 'stack', 'heap', 'buffer', 'fill'])

function computeDelta(previousData, currentData) {
  if (previousData === null || previousData === undefined) return null
  const previousRegions = new Map((Array.isArray(previousData.regions) ? previousData.regions : []).map((region) => [String(region.n), numberOf(region.used, 0)]))
  const regionDeltas = []
  for (const region of Array.isArray(currentData.regions) ? currentData.regions : []) {
    const name = String(region.n)
    const before = previousRegions.get(name)
    if (before === undefined) continue
    const delta = numberOf(region.used, 0) - before
    if (delta !== 0) regionDeltas.push({ name, used: numberOf(region.used, 0), delta })
  }
  regionDeltas.sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta))

  const sizeMap = (data) => {
    const map = new Map()
    for (const symbol of Array.isArray(data.symbols) ? data.symbols : []) {
      if (Array.isArray(symbol) !== true || symbol[4] === 'F') continue
      const name = String(symbol[5])
      if (VARIABLE_CATEGORIES.has(String(symbol[6])) === false) continue
      map.set(name, { size: numberOf(symbol[1], 0), kind: String(symbol[4]), cat: String(symbol[6]), object: numberOf(symbol[3], 0) })
    }
    return map
  }
  const previousSymbols = sizeMap(previousData)
  const symbolDeltas = []
  for (const [name, current] of sizeMap(currentData)) {
    const before = previousSymbols.get(name)
    if (before === undefined) {
      symbolDeltas.push({ name, kind: current.kind, cat: current.cat, object: current.object, size: current.size, delta: current.size, added: true })
      continue
    }
    const delta = current.size - before.size
    if (delta !== 0) symbolDeltas.push({ name, kind: current.kind, cat: current.cat, object: current.object, size: current.size, delta, added: false })
  }
  symbolDeltas.sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta))

  const objectMap = (data) => {
    const map = new Map()
    for (const object of Array.isArray(data.objects) ? data.objects : []) {
      map.set(String(object.p === undefined ? object.n : object.p), { name: String(object.n), module: String(object.m), size: numberOf(object.sz, 0) })
    }
    return map
  }
  const previousObjects = objectMap(previousData)
  const objectDeltas = []
  for (const [key, current] of objectMap(currentData)) {
    const before = previousObjects.get(key)
    const delta = current.size - (before === undefined ? 0 : before.size)
    if (delta !== 0) objectDeltas.push({ name: current.name, module: current.module, size: current.size, delta, added: before === undefined })
  }
  objectDeltas.sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta))

  return {
    previousRunId: null,
    regions: regionDeltas.slice(0, 12),
    symbols: symbolDeltas.slice(0, 12),
    objects: objectDeltas.slice(0, 8),
  }
}

/* ============================== run ============================== */

function timestampRunId() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const random = Math.random().toString(36).slice(2, 6)
  return stamp + '-' + random
}

function requireRoot(payload) {
  const raw = payload !== null && payload !== undefined && typeof payload.root === 'string' ? payload.root.trim() : ''
  if (raw === '') throw badRequest('root is required')
  const resolved = path.resolve(raw)
  if (isDir(resolved) === false) throw badRequest('root is not a directory: ' + resolved)
  return resolved
}

function requireInside(root, candidate, label) {
  const resolved = path.resolve(candidate)
  if (isRealPathInside(root, resolved) !== true) throw badRequest(label + ' is outside the workspace')
  if (isFile(resolved) !== true) throw badRequest(label + ' does not exist: ' + resolved)
  return resolved
}

async function runAnalysis(root, mapPath, options) {
  const resolved = resolveTool(root)
  if (resolved.tool === null) throw new ApiError('no-tool', '没有找到 memmap_report.py，插件自带的副本也缺失', 400)
  const tool = resolved.tool
  /* An explicit absolute path may live OUTSIDE the workspace (a build produced
     elsewhere); the page only sends it after the user typed it. Relative paths
     still have to stay inside the workspace. */
  let map = null
  if (mapPath !== undefined && mapPath !== null && mapPath !== '') {
    const raw = String(mapPath).trim()
    if (raw === '' || raw.indexOf('\u0000') >= 0) throw badRequest('map path is invalid')
    const absolute = path.resolve(raw)
    if (path.isAbsolute(raw) === true && isFile(absolute) === true) map = absolute
    else map = requireInside(root, raw, 'map.txt')
  }
  const structured = map === null ? findMaps(root) : []
  const maps = map === null && structured.length === 0 ? findLooseMaps(root) : structured
  const chosenMap = map === null ? (maps.length > 0 ? maps[0].path : null) : map
  if (chosenMap === null) throw new ApiError('no-map', '工作区里没有找到 map.txt（可以用手动路径指定）', 400)
  const python = await probePython(options.forcePython === true)
  if (python.ok !== true) throw new ApiError('no-python', python.error || 'Python 不可用', 400)
  const spec = pythonSpecOf(hostConfig.python)

  const project = path.basename(path.dirname(path.dirname(path.dirname(chosenMap)))) || path.basename(root)
  const runId = timestampRunId()
  const runDir = path.join(runsDirOf(root), runId)
  mkdirSync(runDir, { recursive: true })
  const args = [...spec.prefixArgs, tool, '--map', chosenMap, '--out', runDir, '--name', project]
  const startedAt = Date.now()
  const result = await execFileAsync(spec.command, args, {
    cwd: root,
    timeout: hostConfig.timeoutMs,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }),
  })
  const durationMs = Date.now() - startedAt
  if (result.error !== null) {
    const timedOut = result.error.killed === true || result.error.code === 'ETIMEDOUT'
    const message = timedOut
      ? `分析超时（${Math.round(hostConfig.timeoutMs / 1000)} 秒）`
      : (clipStream(result.stderr.trim()) || result.error.message)
    throw new ApiError('run-failed', message, 500)
  }
  const dataPath = path.join(runDir, 'memmap_data.json')
  if (isFile(dataPath) !== true) throw new ApiError('no-output', '脚本没有生成 memmap_data.json', 500)
  const data = readJsonFile(dataPath)
  if (data === null) throw new ApiError('bad-output', 'memmap_data.json 不是合法 JSON', 500)

  const runsBefore = runDirsOf(root).filter((entry) => entry.runId !== runId)
  const previousData = runsBefore.length === 0 ? null : readJsonFile(path.join(runsBefore[0].dir, 'memmap_data.json'))
  const delta = computeDelta(previousData, data)
  if (delta !== null) delta.previousRunId = runsBefore[0].runId

  const summary = summarizeData(data, {
    runId,
    generatedAt: new Date().toISOString(),
    durationMs,
    python: python.version,
    mapPath: chosenMap,
  })
  const summaryPath = path.join(runDir, 'summary.json')
  try {
    writeJson(summaryPath, {
      summary,
      stdout: clipStream(result.stdout),
      project,
      mapPath: chosenMap,
      mapMtimeMs: mapMtimeOf(chosenMap),
    })
  } catch (error) {
    void error
  }
  pruneRuns(root)
  return {
    summary,
    delta,
    history: readRunIndex(root).map(historyEntryOf),
    stdout: clipStream(result.stdout),
  }
}

function mapMtimeOf(mapPath) {
  try {
    return statSync(mapPath).mtimeMs
  } catch (error) {
    void error
    return 0
  }
}

function historyEntryOf(record) {
  const summary = record !== null && record !== undefined && typeof record.summary === 'object' ? record.summary : {}
  return {
    runId: summary.runId === undefined ? '' : summary.runId,
    generatedAt: summary.generatedAt === undefined ? '' : summary.generatedAt,
    durationMs: numberOf(summary.durationMs, 0),
    project: summary.project === undefined ? '' : summary.project,
    mapPath: summary.mapPath === undefined ? '' : summary.mapPath,
    mapMtimeMs: numberOf(record.mapMtimeMs, 0),
    totals: summary.totals === undefined ? null : summary.totals,
    warnings: Array.isArray(summary.warnings) ? summary.warnings.length : 0,
  }
}

function writeJson(filePath, value) {
  writeFileSync(filePath, JSON.stringify(value), 'utf8')
}

/* ============================== methods ============================== */

const METHODS = {
  async ping() {
    return { ok: true, dataDir: hostConfig.dataDir }
  },

  async detect(payload) {
    const root = requireRoot(payload)
    const detected = detectAt(root)
    const python = await probePython(payload !== null && payload !== undefined && payload.forcePython === true)
    const records = detected.tool === null ? [] : readRunIndex(detected.root)
    const runs = records.map(historyEntryOf)
    const latest = runs.length > 0 ? runs[0] : null
    /* The page renders the last result immediately; only a newer map triggers a
       fresh (auto) run. */
    const latestSummary = records.length > 0 && records[0].summary !== undefined ? records[0].summary : null
    /* The page remembers the last map it analysed (it may live outside this
       workspace), so a project without its own Output/bin keeps working. */
    const requested = payload !== null && payload !== undefined && typeof payload.manualMap === 'string'
      ? payload.manualMap.trim()
      : ''
    let manualEntry = null
    if (requested !== '') {
      const absolute = path.resolve(requested)
      if (isFile(absolute) === true) {
        try {
          const stat = statSync(absolute)
          /* Output/bin/map.txt → the project is three levels up; a loose map is two. */
          const binDir = path.dirname(absolute)
          const projectDir = path.basename(path.dirname(binDir)) === 'Output' ? path.dirname(path.dirname(binDir)) : path.dirname(binDir)
          manualEntry = {
            path: absolute,
            project: path.basename(projectDir) || path.basename(binDir),
            projectDir,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            manual: true,
          }
        } catch (error) {
          void error
        }
      }
    }
    const maps = manualEntry === null
      ? detected.maps
      : [manualEntry].concat(detected.maps.filter((entry) => entry.path !== manualEntry.path))
    const nearbyMaps = maps.length === 0 ? mergeSuggestions(findNearbyMaps(root), findDeepMaps(root)) : []
    const newestMap = maps.length > 0
      ? maps.reduce((best, entry) => (best === null || entry.mtimeMs > best.mtimeMs ? entry : best), maps[0])
      : null
    return {
      root: detected.root,
      searched: detected.searched,
      toolFound: detected.tool !== null,
      toolPath: detected.tool === null ? '' : detected.tool,
      toolSource: detected.toolSource === undefined ? 'none' : detected.toolSource,
      maps,
      newestMap,
      manualMap: manualEntry,
      nearbyMaps,
      mapIsNewerThanRun: newestMap !== null && (latest === null || newestMap.mtimeMs > numberOf(latest.mapMtimeMs, 0)),
      python,
      runs,
      latestSummary,
      dataDir: dataRootOf(detected.root),
    }
  },

  async run(payload) {
    const root = requireRoot(payload)
    const detected = detectAt(root)
    const mapPath = payload !== null && payload !== undefined && typeof payload.map === 'string' ? payload.map : undefined
    return runAnalysis(detected.root, mapPath, { forcePython: payload !== null && payload !== undefined && payload.forcePython === true })
  },

  async runs(payload) {
    const root = requireRoot(payload)
    return { runs: readRunIndex(root).map(historyEntryOf) }
  },

  async report(payload) {
    const root = requireRoot(payload)
    const runId = payload !== null && payload !== undefined ? String(payload.runId === undefined ? '' : payload.runId) : ''
    if (RUN_ID_PATTERN.test(runId) !== true) throw badRequest('invalid runId')
    const file = path.join(runsDirOf(root), runId, 'memmap_report.html')
    if (isFile(file) !== true) throw new ApiError('no-report', '这次运行没有生成 HTML 报告', 404)
    const stat = statSync(file)
    if (stat.size > MAX_HTML_BYTES) throw new ApiError('report-too-large', 'HTML 报告过大', 413)
    return { runId, html: readFileSync(file, 'utf8') }
  },
}

export function apply(ctx, config) {
  hostConfig = normalizeConfig(config)
  mountJsonApi(ctx, {
    prefix: ROUTE_PREFIX,
    methods: METHODS,
    maxBodyBytes: MAX_BODY_BYTES,
    label: 'dsh-workbench-memmap',
  })
}

/* ============================== test surface ============================== */

export const __test = {
  findTool,
  findMaps,
  findLooseMaps,
  findNearbyMaps,
  findDeepMaps,
  mergeSuggestions,
  resolveTool,
  BUNDLED_TOOL,
  detectAt,
  summarizeData,
  computeDelta,
  pythonSpecOf,
  normalizeConfig,
  timestampRunId,
  RUN_ID_PATTERN,
  ROUTE_PREFIX,
}
