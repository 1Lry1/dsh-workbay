/**
 * Host-side sampler unit tests.
 *
 * Every dependency is injected (clock, `os.cpus`, `nvidia-smi`), so nothing here
 * touches the real machine: the tests pin the ARITHMETIC and the STATE MACHINE
 * (baseline TTL, GPU cache, busy gate), which is where a plausible-looking
 * implementation actually goes wrong.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  WARN_PCT, HOT_PCT, BASELINE_TTL_MS,
  createCpuReader, readMemory, createGpuReader, sampleLoad,
} from '../src/load.js'

const GB = 1073741824
/* user = total - idle, so a delta of (idle +i, total +t) is (t-i)/t busy. */
const cpusAt = (idle, total) => () => [{ times: { user: total - idle, nice: 0, sys: 0, idle, irq: 0 } }]

test('cpu: first sample has no baseline and returns null', () => {
  let clock = 1000
  const read = createCpuReader({ nowMs: () => clock, readCpus: cpusAt(100, 200) })
  assert.equal(read(), null)
})

test('cpu: second sample is the tick delta percentage', () => {
  let clock = 1000
  const deps = { nowMs: () => clock, readCpus: cpusAt(100, 200) }
  const read = createCpuReader(deps)
  read()
  clock += 1000
  /* dt = 300-200 = 100 ticks, di = 150-100 = 50 idle → 1 - 50/100 = 50% */
  deps.readCpus = cpusAt(150, 300)
  assert.equal(read(), 50)
})

test('cpu: a baseline older than TTL is discarded and returns null', () => {
  let clock = 1000
  const deps = { nowMs: () => clock, readCpus: cpusAt(100, 200) }
  const read = createCpuReader(deps)
  read()
  clock += BASELINE_TTL_MS + 1
  deps.readCpus = cpusAt(150, 300)
  assert.equal(read(), null)
  /* …and the stale read becomes the NEW baseline, so the next call works. */
  clock += 1000
  deps.readCpus = cpusAt(200, 400)
  assert.equal(typeof read(), 'number')
})

test('cpu: two readers do not share a baseline', () => {
  const a = createCpuReader({ nowMs: () => 1000, readCpus: cpusAt(100, 200) })
  const b = createCpuReader({ nowMs: () => 1000, readCpus: cpusAt(100, 200) })
  assert.equal(a(), null)
  assert.equal(b(), null)      // b is not polluted by a's baseline
})

test('memory: usedPct derives from total minus free', () => {
  const mem = readMemory({ readMem: () => ({ total: 16 * GB, free: 4 * GB }) })
  assert.equal(mem.usedPct, 75)
  assert.equal(mem.totalGB, 16)
  assert.equal(mem.usedGB, 12)
})

test('gpu: no nvidia-smi yields null, not a throw', async () => {
  const read = createGpuReader({ nowMs: () => 1000, spawnOnce: async () => null })
  assert.equal(await read(), null)
})

test('gpu: parses the csv row into a structured reading', async () => {
  const read = createGpuReader({
    nowMs: () => 1000,
    spawnOnce: async () => 'NVIDIA GeForce MX350, 12, 68, 68, 2048\n',
  })
  assert.deepEqual(await read(), {
    name: 'NVIDIA GeForce MX350', util: 12, temp: 68, memUsed: 68, memTotal: 2048,
  })
})

test('gpu: a second call inside the cache window does not respawn', async () => {
  let clock = 1000
  let calls = 0
  const read = createGpuReader({
    nowMs: () => clock,
    spawnOnce: async () => { calls += 1; return 'GPU, 5, 60, 100, 2048' },
  })
  await read()
  clock += 1000
  await read()
  assert.equal(calls, 1)
})

test('gpu: overlapping calls share one spawn (busy gate)', async () => {
  let release
  let calls = 0
  const read = createGpuReader({
    nowMs: () => 1000,
    spawnOnce: () => { calls += 1; return new Promise((resolve) => { release = resolve }) },
  })
  const first = read()
  const second = read()
  release('GPU, 5, 60, 100, 2048')
  await Promise.all([first, second])
  assert.equal(calls, 1)
})

test('sampleLoad composes the three readings and stamps the time', async () => {
  const out = await sampleLoad({
    nowMs: () => 4242,
    cpu: createCpuReader({ nowMs: () => 4242, readCpus: cpusAt(100, 200) }),
    readMem: () => ({ total: 16 * GB, free: 4 * GB }),
    gpu: async () => null,
  })
  assert.equal(out.at, 4242)
  assert.equal(out.cpu, null)      // first sample, no baseline yet
  assert.equal(out.gpu, null)
  assert.equal(out.mem.totalGB, 16)
  assert.equal(out.mem.usedGB, 12)
  assert.equal(out.mem.usedPct, 75)
})

test('thresholds are single-sourced at 90 and 95', () => {
  assert.equal(WARN_PCT, 90)
  assert.equal(HOT_PCT, 95)
})
