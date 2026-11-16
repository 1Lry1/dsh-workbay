/**
 * Golden-screenshot regression gate for the workbench.
 *
 * Renders the three pages at all four width tiers (13 images: source-control ×4 +
 * drawer, downloader ×4, terminal ×4) with the real page CSS, then compares each
 * image against `tests/golden/*.png`.
 *
 *   node tests/visual-golden.mjs            # check (exit 1 over threshold)
 *   node tests/visual-golden.mjs --update   # accept current renders as baseline
 *   node tests/visual-golden.mjs --self-test
 *
 * Diff metric: a pixel counts as changed when any channel differs by more than
 * TOLERANCE (8, absorbs anti-aliasing jitter). Gate: changed / total <= 0.5%.
 *
 * Why a hand-rolled PNG reader: the repo has no image dependency, and the whole
 * point of this gate is to run inside CI without a browser-side diff service.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'

const here = path.dirname(fileURLToPath(import.meta.url))
const GOLDEN_DIR = path.join(here, 'golden')
const VISUAL_DIR = path.join(here, 'visual')
const TOLERANCE = 8
const MAX_DIFF_RATIO = 0.005
const EXPECTED = [
  'composed-t1-520.png', 'composed-t2-680.png', 'composed-t3-1000.png', 'composed-t4-1400.png', 'composed-t2-drawer.png',
  'dl-t1-520.png', 'dl-t2-680.png', 'dl-t3-1000.png', 'dl-t4-1400.png',
  'term-t1-520.png', 'term-t2-680.png', 'term-t3-1000.png', 'term-t4-1400.png',
]

/* ---------------- minimal PNG decoder (8-bit, non-interlaced) ---------------- */

function decodePng(buffer) {
  if (buffer.length < 8 || buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')
  let pos = 8
  let width = 0
  let height = 0
  let colorType = 0
  let bitDepth = 0
  const idat = []
  while (pos + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(pos)
    const type = buffer.toString('ascii', pos + 4, pos + 8)
    const data = buffer.subarray(pos + 8, pos + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      if (data[12] !== 0) throw new Error('interlaced PNG is not supported')
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    pos += 12 + length
  }
  if (bitDepth !== 8) throw new Error('only 8-bit PNG is supported (got ' + bitDepth + ')')
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(height * stride)
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const cur = Buffer.from(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride))
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? cur[x - channels] : 0
      const b = prev[x]
      const c = x >= channels ? prev[x - channels] : 0
      let value = cur[x]
      if (filter === 1) value = (value + a) & 255
      else if (filter === 2) value = (value + b) & 255
      else if (filter === 3) value = (value + ((a + b) >> 1)) & 255
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        value = (value + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255
      } else if (filter !== 0) throw new Error('unknown PNG filter ' + filter)
      cur[x] = value
    }
    cur.copy(out, y * stride)
    prev = cur
  }
  return { width, height, channels, data: out }
}

export function diffPng(bufferA, bufferB) {
  const a = decodePng(bufferA)
  const b = decodePng(bufferB)
  if (a.width !== b.width || a.height !== b.height) {
    return { width: a.width, height: a.height, changed: a.width * a.height, total: a.width * a.height, ratio: 1, reason: 'dimension-mismatch' }
  }
  let changed = 0
  const pixels = a.width * a.height
  for (let index = 0; index < pixels; index += 1) {
    const base = index * a.channels
    const other = index * b.channels
    const dr = Math.abs(a.data[base] - b.data[other])
    const dg = Math.abs(a.data[base + 1] - b.data[other + 1])
    const db = Math.abs(a.data[base + 2] - b.data[other + 2])
    if (dr > TOLERANCE || dg > TOLERANCE || db > TOLERANCE) changed += 1
  }
  return { width: a.width, height: a.height, changed, total: pixels, ratio: changed / pixels }
}

/* ------------------------------- render step ------------------------------- */

function renderAll(outDir) {
  mkdirSync(outDir, { recursive: true })
  const browser = process.env.WORKBAY_BROWSER ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  for (const script of ['sc-4tier.mjs', 'dl-4tier.mjs', 'tp-4tier.mjs']) {
    execFileSync(process.execPath, [path.join(VISUAL_DIR, script), browser, outDir], { stdio: ['ignore', 'inherit', 'inherit'] })
  }
}

/* ----------------------------------- main ---------------------------------- */

const args = new Set(process.argv.slice(2))

if (args.has('--self-test')) {
  const files = existsSync(GOLDEN_DIR) ? readdirSync(GOLDEN_DIR).filter((name) => name.endsWith('.png')) : []
  if (files.length === 0) {
    console.error('self-test: no golden images yet — run --update first')
    process.exit(1)
  }
  const first = readFileSync(path.join(GOLDEN_DIR, files[0]))
  const same = diffPng(first, first)
  const other = readFileSync(path.join(GOLDEN_DIR, files[files.length - 1]))
  const apart = diffPng(first, other)
  const ok = same.ratio === 0 && (apart.ratio > MAX_DIFF_RATIO || files.length === 1)
  console.log(JSON.stringify({ ok, files: files.length, sameRatio: same.ratio, differentRatio: Number(apart.ratio.toFixed(4)) }))
  process.exit(ok ? 0 : 1)
}

const tmp = path.join(tmpdir(), 'wbm-golden-' + process.pid)
renderAll(tmp)

const actual = new Map(readdirSync(tmp).filter((name) => name.endsWith('.png')).map((name) => [name, path.join(tmp, name)]))

if (args.has('--update')) {
  mkdirSync(GOLDEN_DIR, { recursive: true })
  for (const name of EXPECTED) {
    if (!actual.has(name)) throw new Error('render missing: ' + name)
    copyFileSync(actual.get(name), path.join(GOLDEN_DIR, name))
  }
  console.log('golden baseline updated: ' + EXPECTED.length + ' images')
  process.exit(0)
}

const failures = []
for (const name of EXPECTED) {
  const goldenPath = path.join(GOLDEN_DIR, name)
  if (!existsSync(goldenPath)) { failures.push({ name, reason: 'missing-golden' }); continue }
  if (!actual.has(name)) { failures.push({ name, reason: 'missing-render' }); continue }
  const result = diffPng(readFileSync(goldenPath), readFileSync(actual.get(name)))
  if (result.ratio > MAX_DIFF_RATIO) {
    failures.push({ name, ratio: Number(result.ratio.toFixed(4)), changed: result.changed, total: result.total, reason: result.reason ?? 'pixel-diff' })
    const dir = path.join(tmp, 'failing')
    mkdirSync(dir, { recursive: true })
    copyFileSync(actual.get(name), path.join(dir, name))
  }
}

const summary = { images: EXPECTED.length, failed: failures.length, threshold: MAX_DIFF_RATIO, tolerance: TOLERANCE, failures }
console.log(JSON.stringify(summary, null, 2))
if (failures.length > 0) console.error('actual renders kept at: ' + tmp)
else try { statSync(tmp) } catch { /* ignore */ }
process.exit(failures.length === 0 ? 0 : 1)
