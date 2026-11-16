/**
 * Host-side CPU / GPU / MEM sampler for the workbench titlebar meter.
 *
 * Why this lives in the host half: a browser page cannot call `os.cpus()` and
 * cannot spawn `nvidia-smi`. The route in `index.js` exposes this as
 * `POST /dsh-workbay-dock/api/load`; the client only polls and renders.
 *
 * Two deliberate properties:
 *
 *   1. NO TIMERS. Nothing is sampled until the client asks, so a closed
 *      workbench costs zero `nvidia-smi` spawns. The client is responsible for
 *      only asking while its window is visible and focused.
 *
 *   2. EVERY DEPENDENCY IS INJECTED (`nowMs`, `readCpus`, `readMem`,
 *      `spawnOnce`). That keeps the arithmetic and the state machine — baseline
 *      TTL, GPU cache, busy gate — testable without a real machine.
 *
 * Readers are FACTORIES rather than module-level state on purpose: module-level
 * state leaks between tests (a baseline built by one case makes the next one
 * read `dt = 0`). The host builds each reader exactly once at module scope, so
 * the state still survives across requests.
 */

import { spawn } from 'node:child_process'

/** At or above this percentage a metric turns red. */
export const WARN_PCT = 90
/** At or above this percentage it also breathes. */
export const HOT_PCT = 95
/**
 * A CPU baseline older than this is useless: differencing a fresh reading
 * against it yields the average over the whole gap, not "what is happening now".
 * After a long idle period that number is meaningless, so we drop it and return
 * null (the client retries shortly).
 */
export const BASELINE_TTL_MS = 30000
/** `nvidia-smi` costs ~40ms and a process; 5s polling does not need a fresh one. */
export const GPU_CACHE_MS = 4000
export const GPU_TIMEOUT_MS = 3000

const BYTES_PER_GB = 1073741824

const round1 = (value) => Math.round(value * 10) / 10

/**
 * Sum every CPU's tick counters.
 * @param {() => Array<{ times?: Record<string, number> }>} readCpus
 * @returns {{ idle: number, total: number }}
 */
function tickTotals(readCpus) {
  const cpus = readCpus() || []
  let idle = 0
  let total = 0
  for (const cpu of cpus) {
    const times = (cpu && cpu.times) || {}
    idle += times.idle || 0
    total += (times.user || 0) + (times.nice || 0) + (times.sys || 0) + (times.idle || 0) + (times.irq || 0)
  }
  return { idle, total }
}

/**
 * A stateful CPU percentage reader (delta between consecutive calls).
 *
 * The first call after construction always returns null: there is nothing to
 * difference against yet.
 *
 * @param {{ nowMs: () => number, readCpus: () => any[] }} deps
 * @returns {() => number | null}
 */
export function createCpuReader(deps) {
  let baseline = null

  return function readCpuPercent() {
    /* `deps` is consulted per call, not destructured up front: a caller may
       legitimately swap the source (tests do exactly that to simulate counters
       advancing), and reading through `deps` each time costs nothing. */
    const now = deps.nowMs()
    const current = tickTotals(deps.readCpus)
    const stale = baseline === null || now - baseline.at > BASELINE_TTL_MS
    if (stale) {
      baseline = { idle: current.idle, total: current.total, at: now }
      return null
    }
    const deltaIdle = current.idle - baseline.idle
    const deltaTotal = current.total - baseline.total
    baseline = { idle: current.idle, total: current.total, at: now }
    if (!(deltaTotal > 0)) return null
    const pct = Math.round((1 - deltaIdle / deltaTotal) * 100)
    return Math.max(0, Math.min(100, pct))
  }
}

/**
 * Physical memory usage.
 * @param {{ readMem: () => { total: number, free: number } }} deps
 * @returns {{ usedPct: number, usedGB: number, totalGB: number }}
 */
export function readMemory(deps) {
  const { total, free } = deps.readMem()
  const used = total - free
  return {
    usedPct: total > 0 ? Math.round((used / total) * 100) : 0,
    usedGB: round1(used / BYTES_PER_GB),
    totalGB: round1(total / BYTES_PER_GB),
  }
}

/**
 * Parse one `nvidia-smi --format=csv,noheader,nounits` row.
 * @param {string | null} raw
 * @returns {{ name: string, util: number, temp: number, memUsed: number, memTotal: number } | null}
 */
function parseGpuRow(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const parts = raw.trim().split(/\r?\n/)[0].split(',').map((part) => part.trim())
  if (parts.length < 5) return null
  const util = Number(parts[1])
  if (!Number.isFinite(util)) return null
  return {
    name: parts[0],
    util,
    temp: Number(parts[2]),
    memUsed: Number(parts[3]),
    memTotal: Number(parts[4]),
  }
}

/**
 * Default `spawnOnce`: run `nvidia-smi` once and return its stdout, or null.
 *
 * Never rejects. A machine without an NVIDIA card writes to stderr and exits
 * non-zero; a machine without `nvidia-smi` fails to spawn at all. Both are the
 * ordinary "no GPU to report" case, not an error the caller must handle.
 *
 * @returns {Promise<string | null>}
 */
function spawnNvidiaSmi() {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    let child = null
    try {
      child = spawn('nvidia-smi', [
        '--query-gpu=name,utilization.gpu,temperature.gpu,memory.used,memory.total',
        '--format=csv,noheader,nounits',
      ], { windowsHide: true })
    } catch (error) {
      void error
      finish(null)
      return
    }
    let out = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch (error) { void error }
      finish(null)
    }, GPU_TIMEOUT_MS)
    if (typeof timer.unref === 'function') timer.unref()
    child.stdout.on('data', (chunk) => { out += String(chunk) })
    child.stderr.on('data', () => { /* a missing card writes here; ignore */ })
    child.on('error', () => { clearTimeout(timer); finish(null) })
    child.on('close', () => { clearTimeout(timer); finish(out) })
  })
}

/**
 * A cached, single-flight GPU reader.
 *
 * `busy` is a gate, not a queue: a request arriving while a spawn is in flight
 * gets the previous value immediately instead of piling on a second process.
 *
 * @param {{ nowMs: () => number, spawnOnce?: () => Promise<string | null> }} deps
 * @returns {() => Promise<{ name: string, util: number, temp: number, memUsed: number, memTotal: number } | null>}
 */
export function createGpuReader(deps) {
  const { nowMs } = deps
  const spawnOnce = typeof deps.spawnOnce === 'function' ? deps.spawnOnce : spawnNvidiaSmi
  let value = null
  let at = 0
  let busy = false

  return async function readGpu() {
    if (busy) return value
    if (at !== 0 && nowMs() - at < GPU_CACHE_MS) return value
    busy = true
    try {
      value = parseGpuRow(await spawnOnce())
    } catch (error) {
      void error
      value = null
    } finally {
      at = nowMs()
      busy = false
    }
    return value
  }
}

/**
 * One sample of everything the meter shows.
 *
 * @param {{
 *   nowMs: () => number,
 *   cpu: () => number | null,
 *   readMem: () => { total: number, free: number },
 *   gpu: () => Promise<any>,
 * }} deps
 * @returns {Promise<{ at: number, cpu: number | null, gpu: any, mem: any }>}
 */
export async function sampleLoad(deps) {
  const { nowMs, cpu, readMem, gpu } = deps
  const at = nowMs()
  const cpuPct = cpu()
  const mem = readMemory({ readMem })
  const gpuReading = await gpu()
  return { at, cpu: cpuPct, gpu: gpuReading, mem }
}
