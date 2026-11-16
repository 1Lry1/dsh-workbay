/**
 * Host tests for dsh-workbench-memmap.
 *
 * The real Python tool is NOT required here: the plugin is booted with a fake
 * interpreter (`node tests/fixtures/fake_memmap_runner.mjs`) that writes the
 * same two artefacts. That keeps the whole run → summary → delta → report path
 * covered on every machine, and the tests can change the fake's output through
 * an environment variable to force a baseline difference or a failure.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import * as plugin from '../src/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fakeRunner = path.join(here, 'fixtures', 'fake_memmap_runner.mjs')

const sandbox = mkdtempSync(path.join(tmpdir(), 'mmp-host-'))
const sdk = path.join(sandbox, 'demo_sdk')
const projectDir = path.join(sdk, 'app', 'projects', 'standard')
const binDir = path.join(projectDir, 'Output', 'bin')
const mapPath = path.join(binDir, 'map.txt')
mkdirSync(path.join(sdk, 'tools', 'memmap_report'), { recursive: true })
writeFileSync(path.join(sdk, 'tools', 'memmap_report', 'memmap_report.py'), '#!/usr/bin/env python3\n', 'utf8')
mkdirSync(binDir, { recursive: true })
writeFileSync(mapPath, 'Memory Configuration\nfake map for tests\n', 'utf8')
const outsideMap = path.join(sandbox, 'elsewhere', 'map.txt')
mkdirSync(path.dirname(outsideMap), { recursive: true })
writeFileSync(outsideMap, 'nope\n', 'utf8')

const routes = []
const ctx = {
  webServer: { register(route) { routes.push(route); return () => {} } },
  effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
  get() { return undefined },
  provide() {},
  inject(deps, callback) { callback(ctx) },
  logger: { error() {}, warn() {}, info() {} },
}
plugin.apply(ctx, {
  python: [process.execPath, fakeRunner],
  dataDir: path.join(sandbox, 'data'),
  timeoutMs: 30_000,
  keepRuns: 5,
})

assert.equal(routes.length, 1, 'apply mounts one RPC route')
const server = createServer((req, res) => { void routes[0].handler(req, res) })
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:' + server.address().port
const PREFIX = plugin.__test.ROUTE_PREFIX

async function call(method, payload) {
  const response = await fetch(`${base}${PREFIX}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload === undefined ? {} : payload),
  })
  return response.json()
}

test.after(() => {
  server.close()
  rmSync(sandbox, { recursive: true, force: true })
})

test('detect finds the tool, the newest map and a working python', async () => {
  const out = await call('detect', { root: sdk })
  assert.equal(out.ok, true, JSON.stringify(out))
  const data = out.data
  assert.equal(data.root, sdk)
  assert.equal(data.toolFound, true)
  assert.equal(data.toolPath, path.join(sdk, 'tools', 'memmap_report', 'memmap_report.py'))
  assert.equal(data.toolSource, 'workspace', 'a workspace copy wins over the bundled one')
  assert.equal(data.maps.length, 1)
  assert.equal(data.maps[0].project, 'standard')
  assert.equal(data.newestMap.path, mapPath)
  assert.equal(data.python.ok, true, JSON.stringify(data.python))
  assert.equal(data.python.version, '3.9.10-fake')
  assert.deepEqual(data.runs, [])
})

test('a project inside an SDK uses the SDK tool and the project map', async () => {
  const out = await call('detect', { root: projectDir })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.data.root, sdk, 'the SDK owns tools/, so it becomes the detected root')
  assert.equal(out.data.toolSource, 'workspace')
  assert.equal(out.data.toolPath, path.join(sdk, 'tools', 'memmap_report', 'memmap_report.py'))
  assert.equal(out.data.maps.length, 1)
  assert.equal(out.data.maps[0].project, 'standard')
})

test('a standalone project outside any SDK is analysed with the BUNDLED script', async () => {
  const standalone = mkdtempSync(path.join(tmpdir(), 'mmp-standalone-'))
  try {
    mkdirSync(path.join(standalone, 'Output', 'bin'), { recursive: true })
    writeFileSync(path.join(standalone, 'Output', 'bin', 'map.txt'), 'Memory Configuration\\nstandalone\\n', 'utf8')
    const out = await call('detect', { root: standalone })
    assert.equal(out.ok, true, JSON.stringify(out))
    assert.equal(out.data.root, standalone)
    assert.equal(out.data.toolFound, true, 'the plugin ships the script, so no per-project copy is needed')
    assert.equal(out.data.toolSource, 'bundled')
    assert.equal(out.data.toolPath, plugin.__test.BUNDLED_TOOL)
    assert.equal(out.data.maps.length, 1)
  } finally {
    rmSync(standalone, { recursive: true, force: true })
  }
})

test('a workspace with neither tool nor map still reports the bundled tool', async () => {
  const plain = path.join(sandbox, 'plain_workspace')
  mkdirSync(plain, { recursive: true })
  const out = await call('detect', { root: plain })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.data.toolFound, true, 'the bundled copy is always available')
  assert.equal(out.data.toolSource, 'bundled')
  assert.deepEqual(out.data.maps, [])
  assert.deepEqual(out.data.runs, [])
})

test('a project directory inside an SDK still finds the SDK map through its ancestor', async () => {
  const repoDir = path.join(sdk, 'app', 'repo')
  mkdirSync(repoDir, { recursive: true })
  const out = await call('detect', { root: repoDir })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.data.root, sdk, 'the SDK root owns the Output/bin map')
  assert.equal(out.data.maps.length, 1)
  assert.equal(out.data.maps[0].project, 'standard')
  assert.equal(out.data.toolSource, 'workspace')
})

test('a map-less project is offered the neighbouring SDK maps as candidates', async () => {
  /* Mirrors the real layout: .../ido/project-a/demo next to .../ido/demo_sdk. */
  const nearbyWorkspace = path.join(sandbox, 'nearby_workspace')
  mkdirSync(nearbyWorkspace, { recursive: true })
  const out = await call('detect', { root: nearbyWorkspace })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.deepEqual(out.data.maps, [])
  assert.ok(Array.isArray(out.data.nearbyMaps), 'nearbyMaps is always an array')
  assert.ok(out.data.nearbyMaps.length >= 1, 'the SDK next door is offered')
  const standard = out.data.nearbyMaps.find((entry) => entry.project === 'standard')
  assert.notEqual(standard, undefined)
  assert.equal(standard.nearby, true)
  assert.equal(standard.path, mapPath)
})
test('a deeply nested SDK layout (bluetrum/app/projects/standard/Output/bin) is found', async () => {
  /* Real layout from the field: map.txt sits SIX directories below the workspace
     root. The scan depth used to be 5, so this map was silently invisible. */
  const deep = path.join(sandbox, 'deep_workspace', 'bluetrum', 'app', 'projects', 'standard', 'Output', 'bin')
  mkdirSync(deep, { recursive: true })
  const deepMap = path.join(deep, 'map.txt')
  writeFileSync(deepMap, 'Memory Configuration\ndeep\n', 'utf8')
  const out = await call('detect', { root: path.join(sandbox, 'deep_workspace') })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.data.maps.length, 1)
  assert.equal(out.data.maps[0].path, deepMap)
  assert.equal(out.data.maps[0].project, 'standard')
  assert.equal(out.data.newestMap.path, deepMap)
})
test('renamed directories are fine: only Output/bin and map.txt matter', async () => {
  /* No "app/projects" anywhere: the detector keys off Output/bin + map.txt only. */
  const deep = path.join(sandbox, 'renamed_ws', 'factoryX', 'projA', 'Output', 'bin')
  mkdirSync(deep, { recursive: true })
  const renamedMap = path.join(deep, 'map.txt')
  writeFileSync(renamedMap, 'Memory Configuration\nrenamed\n', 'utf8')
  const out = await call('detect', { root: path.join(sandbox, 'renamed_ws') })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.data.maps.length, 1)
  assert.equal(out.data.maps[0].path, renamedMap)
  assert.equal(out.data.maps[0].project, 'projA', 'the project name comes from the directory that owns Output')
})

test('a map DEEPER than the normal scan is offered through the deep fallback', async () => {
  const parts = ['d', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l']
  const deepDir = path.join(sandbox, 'deeper_ws', ...parts, 'Output', 'bin')
  mkdirSync(deepDir, { recursive: true })
  const deepMap = path.join(deepDir, 'map.txt')
  writeFileSync(deepMap, 'Memory Configuration\ndeep fallback\n', 'utf8')
  const out = await call('detect', { root: path.join(sandbox, 'deeper_ws') })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.deepEqual(out.data.maps, [], 'the normal scan stops before this depth')
  const suggestion = out.data.nearbyMaps.find((entry) => entry.path === deepMap)
  assert.notEqual(suggestion, undefined, 'the bounded deep walk still finds it as a SUGGESTION')
  assert.equal(suggestion.deep, true)
  assert.equal(out.data.newestMap, null, 'a suggestion is never auto-selected')
})

test('a remembered manual map is accepted even when it lives outside the workspace', async () => {
  const standalone = mkdtempSync(path.join(tmpdir(), 'mmp-manual-'))
  try {
    mkdirSync(path.join(standalone, 'Output', 'bin'), { recursive: true })
    writeFileSync(path.join(standalone, 'Output', 'bin', 'map.txt'), 'Memory Configuration\nmanual-ws\n', 'utf8')
    /* No map for this project: detection alone finds nothing... */
    const bare = mkdtempSync(path.join(tmpdir(), 'mmp-bare-'))
    try {
      const without = await call('detect', { root: bare })
      assert.deepEqual(without.data.maps, [])
      /* ...but the remembered absolute map makes it analyzable anyway. */
      const withManual = await call('detect', { root: bare, manualMap: mapPath })
      assert.equal(withManual.ok, true, JSON.stringify(withManual))
      assert.equal(withManual.data.manualMap.path, mapPath)
      assert.equal(withManual.data.maps[0].manual, true)
      assert.equal(withManual.data.maps[0].project, 'standard')
      assert.equal(withManual.data.newestMap.path, mapPath)
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  } finally {
    rmSync(standalone, { recursive: true, force: true })
  }
})
test('a project that does not use Output/bin still gets its map.txt found (loose map)', async () => {
  const loose = path.join(sandbox, 'loose_project')
  mkdirSync(path.join(loose, 'build', 'out'), { recursive: true })
  writeFileSync(path.join(loose, 'build', 'out', 'map.txt'), 'Memory Configuration\nloose\n', 'utf8')
  const out = await call('detect', { root: loose })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.data.root, loose)
  assert.equal(out.data.maps.length, 1)
  assert.equal(out.data.maps[0].loose, true, 'a non Output/bin map is marked loose')
  assert.equal(out.data.toolSource, 'bundled')
})

test('the bundled tool really exists next to the plugin', () => {
  assert.equal(plugin.__test.resolveTool(sdk).source, 'workspace', 'the SDK copy wins when present')
  assert.equal(plugin.__test.resolveTool(projectDir).source, 'bundled', 'a plain project falls back to the bundled copy')
  assert.equal(plugin.__test.resolveTool(projectDir).tool.endsWith('memmap_report.py'), true)
})

test('run writes the artefacts, returns a summary and shows no delta on the first run', async () => {
  const out = await call('run', { root: sdk })
  assert.equal(out.ok, true, JSON.stringify(out))
  const data = out.data
  assert.match(data.summary.runId, plugin.__test.RUN_ID_PATTERN)
  assert.equal(data.summary.project, 'standard')
  assert.equal(data.summary.python, '3.9.10-fake')
  assert.equal(data.summary.totals.internalRam, 473_000)
  assert.equal(data.summary.totals.ramCapacity, 651_520)
  assert.equal(data.summary.regions.length, 3)
  assert.equal(data.summary.regions[0].name, 'sram')
  assert.equal(data.summary.symbols[0].size, 1_170_000)
  assert.equal(data.summary.objects[0].size, 120_000)
  assert.equal(data.delta, null, 'the very first run has nothing to compare against')
  assert.equal(data.history.length, 1)
  assert.equal(data.history[0].runId, data.summary.runId)
  assert.match(data.stdout, /内部 RAM/)
})

test('a second run reports deltas against the previous one (region, symbol, object)', async () => {
  process.env.FAKE_MEMMAP_BUMP = '5000'
  try {
    const out = await call('run', { root: sdk })
    assert.equal(out.ok, true, JSON.stringify(out))
    const delta = out.data.delta
    assert.notEqual(delta, null)
    const sram = delta.regions.find((entry) => entry.name === 'sram')
    assert.equal(sram.delta, 5000)
    const symbol = delta.symbols.find((entry) => entry.name === 's_snap_cache')
    assert.equal(symbol.delta, 5000)
    const object = delta.objects.find((entry) => entry.name === 'lvgl.a(lv_obj.o)')
    assert.equal(object.delta, 5000)
    assert.equal(out.data.history.length, 2, 'history keeps both runs')
    assert.equal(out.data.summary.warnings.length, 1)
  } finally {
    delete process.env.FAKE_MEMMAP_BUMP
  }
})

test('map newer than the last run flips the auto-run flag', async () => {
  const before = await call('detect', { root: sdk })
  assert.equal(before.data.mapIsNewerThanRun, false)
  writeFileSync(mapPath, 'Memory Configuration\nrebuilt map\n', 'utf8')
  const after = await call('detect', { root: sdk })
  assert.equal(after.data.mapIsNewerThanRun, true)
})

test('report returns the HTML of one run and refuses unknown / invalid run ids', async () => {
  const runs = await call('runs', { root: sdk })
  assert.equal(runs.ok, true)
  const runId = runs.data.runs[0].runId
  const detected = await call('detect', { root: sdk })
  assert.equal(detected.data.latestSummary.runId, runId, 'detect returns the last result for an instant first paint')
  const report = await call('report', { root: sdk, runId })
  assert.equal(report.ok, true, JSON.stringify(report))
  assert.match(report.data.html, /__FAKE_REPORT__/)
  assert.match(report.data.html, /内存分布分析/)

  const unknown = await call('report', { root: sdk, runId: '20000101-000000-zzzz' })
  assert.equal(unknown.ok, false)
  const invalid = await call('report', { root: sdk, runId: '../../etc/passwd' })
  assert.equal(invalid.ok, false)
})

test('a failing script surfaces its stderr instead of a generic error', async () => {
  process.env.FAKE_MEMMAP_FAIL = '1'
  try {
    const out = await call('run', { root: sdk })
    assert.equal(out.ok, false)
    assert.match(JSON.stringify(out.error), /boom: unsupported map format/)
  } finally {
    delete process.env.FAKE_MEMMAP_FAIL
  }
})

test('an explicit ABSOLUTE map outside the workspace is allowed; a relative escape is not', async () => {
  /* The page shows a manual path box for builds produced elsewhere; that is a
     deliberate, user-typed path, so it may live outside the workspace. */
  writeFileSync(outsideMap, 'Memory Configuration\nexternal build\n', 'utf8')
  const out = await call('run', { root: sdk, map: outsideMap })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.data.summary.mapPath, outsideMap)

  const escape = await call('run', { root: sdk, map: '../elsewhere/map.txt' })
  assert.equal(escape.ok, false)
  assert.match(JSON.stringify(escape.error), /outside the workspace/)

  const missing = await call('detect', { root: path.join(sandbox, 'does-not-exist') })
  assert.equal(missing.ok, false)
  assert.match(JSON.stringify(missing.error), /not a directory/)
})

test('delta and config helpers behave on their own', () => {
  const previous = {
    regions: [{ n: 'sram', used: 100 }],
    symbols: [[0, 10, 0, 0, 'O', 'a', 'data', 0], [0, 999, 0, 0, 'F', 'main', 'code', 0]],
    objects: [{ n: 'x.o', p: 'x.o', m: 'm', sz: 10 }],
  }
  const current = {
    regions: [{ n: 'sram', used: 140 }],
    symbols: [[0, 30, 0, 0, 'O', 'a', 'data', 0], [0, 999, 0, 0, 'F', 'main', 'code', 0], [0, 7, 0, 0, 'O', 'new', 'bss', 0]],
    objects: [{ n: 'x.o', p: 'x.o', m: 'm', sz: 18 }],
  }
  const delta = plugin.__test.computeDelta(previous, current)
  assert.deepEqual(delta.regions, [{ name: 'sram', used: 140, delta: 40 }])
  assert.deepEqual(delta.symbols.map((entry) => [entry.name, entry.delta, entry.added]), [['a', 20, false], ['new', 7, true]])
  assert.deepEqual(delta.objects.map((entry) => [entry.name, entry.delta]), [['x.o', 8]])

  assert.deepEqual(plugin.__test.pythonSpecOf('python'), { command: 'python', prefixArgs: [] })
  assert.deepEqual(plugin.__test.pythonSpecOf(['py', '-3']), { command: 'py', prefixArgs: ['-3'] })
  assert.throws(() => plugin.__test.pythonSpecOf([]))

  const config = plugin.__test.normalizeConfig({ python: ['py', '-3'], timeoutMs: 1, keepRuns: 999 })
  assert.deepEqual(config.python, ['py', '-3'])
  assert.equal(config.timeoutMs, 180_000, 'too small a timeout falls back to the default')
  assert.equal(config.keepRuns, 50, 'keepRuns is clamped')
})
