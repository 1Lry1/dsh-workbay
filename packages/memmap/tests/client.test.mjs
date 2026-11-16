/**
 * Client-half tests for `dsh-workbench-memmap`.
 *
 * The page's load-bearing logic is pure and pinned here: byte/percent formatting,
 * the three storage cards, the composition-bar segments, the delta groups, the
 * auto-run decision, the root lookup, and the bilingual dictionary parity.
 * The live rendering path is covered by the browser harness (`memmap.e2e.mjs`).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = readFileSync(path.join(here, '..', 'src', 'client.js'), 'utf8')

function makeReact() {
  return {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      const normalized = props === null || props === undefined ? {} : props
      normalized.children = children.length === 0 ? undefined : (children.length === 1 ? children[0] : children)
      return { type, props: normalized }
    },
    useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}] },
    useEffect() {},
    useMemo(fn) { return fn() },
    useRef(value) { return { current: value } },
    useCallback(fn) { return fn },
    memo(fn) { return fn },
    Component: class { constructor(props) { this.props = props } render() { return null } },
  }
}

function boot(options) {
  const opts = options === undefined ? {} : options
  const registered = []
  const storage = new Map(Object.entries(opts.storage === undefined ? {} : opts.storage))
  const document = {
    head: { appendChild() {} },
    createElement() { return { setAttribute() {}, remove() {}, textContent: '' } },
    addEventListener() {},
    removeEventListener() {},
  }
  const window = {
    __DSH_WORKBAY__: opts.dock,
    __ModuleLoader__: {
      load(spec) {
        assert.equal(spec.id, 'dsh-workbench-memmap')
        const React = makeReact()
        const mod = spec.factory((name) => {
          if (name === 'react') return React
          throw new Error('unexpected require: ' + name)
        })
        registered.push({ id: spec.id, mod })
      },
    },
    localStorage: {
      getItem(key) { return storage.has(key) ? storage.get(key) : null },
      setItem(key, value) { storage.set(key, String(value)) },
      removeItem(key) { storage.delete(key) },
    },
    addEventListener() {},
    removeEventListener() {},
  }
  // eslint-disable-next-line no-new-func
  const run = new Function('window', 'document', 'navigator', 'fetch', 'Blob', 'URL', source)
  const urls = { createObjectURL: () => 'blob:fake', revokeObjectURL() {} }
  run(window, document, { language: opts.language === undefined ? 'en-US' : opts.language },
    opts.fetch === undefined ? async () => { throw new Error('no network') } : opts.fetch,
    class Blob { constructor(parts, init) { this.parts = parts; this.type = init === undefined ? '' : init.type } },
    urls)
  assert.equal(registered.length, 1, 'the bundle must call __ModuleLoader__.load exactly once')
  return { entry: registered[0], api: registered[0].mod.__test, window, document, storage }
}

const booted = boot()
const api = booted.api
const en = (key, values) => api.fill(api.dictionaries.EN[key] === undefined ? key : api.dictionaries.EN[key], values)
const zh = (key, values) => api.fill(api.dictionaries.ZH[key] === undefined ? key : api.dictionaries.ZH[key], values)

/* ============================== contract ============================== */

test('the bundle exports apply and the page contract helpers', () => {
  assert.equal(typeof booted.entry.mod.apply, 'function')
  assert.equal(booted.entry.mod.name, 'dsh-workbench-memmap')
  assert.equal(api.PAGE_ID, 'memmap')
  assert.equal(api.PREFIX, '/dsh-workbench-memmap/api/')
})

test('registers exactly one page: memmap, order 25 between source control and downloader', () => {
  const pages = []
  const dock = {
    registerPage(page) { pages.push(page); return () => {} },
    list() { return pages.slice() },
    get() { return undefined },
    subscribe() { return () => {} },
  }
  const local = boot({ dock })
  const ctx = { effect(fn) { fn(); return () => {} }, get() { return undefined } }
  local.entry.mod.apply(ctx)
  assert.equal(pages.length, 1)
  assert.equal(pages[0].id, 'memmap')
  assert.equal(pages[0].order, 25)
  assert.equal(pages[0].title, 'Memory map')
  assert.equal(pages[0].short, 'Memory')
  assert.equal(typeof pages[0].component, 'function')
  assert.equal(typeof pages[0].icon, 'function')
})

test('the page title follows the active locale', () => {
  const pages = []
  const dock = { registerPage(page) { pages.push(page); return () => {} } }
  const local = boot({ dock })
  const ctx = {
    effect(fn) { fn(); return () => {} },
    get(name) {
      if (name === 'locale') return { subscribe() { return () => {} }, getSnapshot() { return { active: 'zh-CN' } } }
      return undefined
    },
  }
  local.entry.mod.apply(ctx)
  assert.equal(pages[0].title, '内存分析')
  assert.equal(pages[0].short, '内存')
})

/* ============================== formatting ============================== */

test('formatBytes switches units and keeps one decimal where it reads better', () => {
  assert.equal(api.formatBytes(en, 0), '0 B')
  assert.equal(api.formatBytes(en, 512), '512 B')
  assert.equal(api.formatBytes(en, 1024), '1.0 KB')
  assert.equal(api.formatBytes(en, 1536), '1.5 KB')
  assert.equal(api.formatBytes(en, 473 * 1024), '473 KB')
  assert.equal(api.formatBytes(en, 3.62 * 1024 * 1024), '3.62 MB')
  assert.equal(api.formatBytes(en, -1), '—')
  assert.equal(api.formatBytes(en, 'nope'), '—')
  assert.equal(api.formatBytes(zh, 1024), '1.0 KB')
})

test('formatPct / formatDuration / formatTime are stable and never print NaN', () => {
  assert.equal(api.formatPct(0), '0.0%')
  assert.equal(api.formatPct(12.345), '12%')
  assert.equal(api.formatPct('x'), '—')
  assert.equal(api.formatDuration(950), '950 ms')
  assert.equal(api.formatDuration(1530), '1.5 s')
  assert.equal(api.formatDuration(-4), '—')
  assert.equal(api.formatTime(''), '—')
  assert.equal(api.formatTime('not-a-date'), 'not-a-date')
  assert.match(api.formatTime('2026-11-11T20:00:00'), /^11-11 \d\d:\d\d$/)
})

test('toneOf uses the 75% / 90% thresholds the cards colour by', () => {
  assert.equal(api.toneOf(0), 'is-ok')
  assert.equal(api.toneOf(74.9), 'is-ok')
  assert.equal(api.toneOf(75), 'is-warn')
  assert.equal(api.toneOf(89.9), 'is-warn')
  assert.equal(api.toneOf(90), 'is-danger')
  assert.equal(api.toneOf('x'), 'is-ok')
})

/* ============================== summary model ============================== */

test('storageCardsOf turns totals into the three cards, with free space and percentage', () => {
  const cards = api.storageCardsOf({
    internalRam: 473_000,
    ramCapacity: 651_520,
    psram: 3_620_000,
    psramCapacity: 4_194_304,
    flash: 1_540_000,
    flashCapacity: 3_138_048,
  })
  assert.deepEqual(cards.map((card) => card.key), ['internal', 'psram', 'flash'])
  assert.equal(cards[0].free, 651_520 - 473_000)
  assert.ok(Math.abs(cards[0].pct - 72.6) < 0.1)
  assert.equal(cards[2].pct > 49 && cards[2].pct < 50, true)
  const empty = api.storageCardsOf(null)
  assert.equal(empty[0].pct, 0)
  assert.equal(empty[0].free, 0)
})

test('categorySegmentsOf keeps positive categories, biggest first, as percentages', () => {
  const segments = api.categorySegmentsOf({ used: 1000, cats: { code: 600, bss: 300, fill: 0, data: 100, broken: 'x' } })
  assert.deepEqual(segments.map((segment) => segment.key), ['code', 'bss', 'data'])
  assert.deepEqual(segments.map((segment) => segment.pct), [60, 30, 10])
  assert.deepEqual(api.categorySegmentsOf(null), [])
  assert.deepEqual(api.categorySegmentsOf({ used: 0, cats: { code: 5 } }), [{ key: 'code', size: 5, pct: 0 }])
})

test('deltaGroupsOf drops empty groups; deltaToneOf maps growth to red and shrink to green', () => {
  const groups = api.deltaGroupsOf({ regions: [{ name: 'sram', delta: 5 }], symbols: [], objects: [{ name: 'x.o', delta: -3 }] })
  assert.deepEqual(groups.map((group) => group.key), ['regions', 'objects'])
  assert.deepEqual(api.deltaGroupsOf(null), [])
  assert.equal(api.deltaToneOf(1), 'is-up')
  assert.equal(api.deltaToneOf(-1), 'is-down')
  assert.equal(api.deltaToneOf(0), 'is-flat')
  assert.equal(api.deltaToneOf('x'), 'is-flat')
})

/* ============================== map choices ============================== */

test('mapChoicesOf lists every candidate once, with flags and the current one marked', () => {
  const detect = {
    maps: [
      { path: 'D:/sdk/app/projects/standard/Output/bin/map.txt', project: 'standard', size: 100, mtimeMs: 1000 },
      { path: 'D:/sdk/app/projects/watch466/Output/bin/map.txt', project: 'watch466', size: 200, mtimeMs: 2000 },
    ],
    nearbyMaps: [
      { path: 'D:/near/Output/bin/map.txt', project: 'near', size: 300, mtimeMs: 3000, nearby: true },
      { path: 'D:/deep/build/map.txt', project: 'deep', size: 400, mtimeMs: 4000, deep: true },
    ],
    manualMap: { path: 'D:/manual/map.txt', project: 'manual', size: 500, mtimeMs: 5000, manual: true },
  }
  const history = [
    { runId: 'a', project: 'standard', mapPath: 'D:/sdk/app/projects/standard/Output/bin/map.txt', mapMtimeMs: 1000 },
    { runId: 'b', project: 'old', mapPath: 'D:/old/map.txt', mapMtimeMs: 900 },
  ]
  const choices = api.mapChoicesOf(detect, history, 'D:/sdk/app/projects/watch466/Output/bin/map.txt')
  assert.deepEqual(choices.map((entry) => entry.path), [
    'D:/sdk/app/projects/standard/Output/bin/map.txt',
    'D:/sdk/app/projects/watch466/Output/bin/map.txt',
    'D:/near/Output/bin/map.txt',
    'D:/deep/build/map.txt',
    'D:/old/map.txt',
    'D:/manual/map.txt',
  ])
  assert.equal(choices.filter((entry) => entry.current === true).length, 1)
  assert.equal(choices.find((entry) => entry.current === true).project, 'watch466')
  assert.equal(choices.find((entry) => entry.path === 'D:/near/Output/bin/map.txt').nearby, true)
  assert.equal(choices.find((entry) => entry.path === 'D:/deep/build/map.txt').deep, true)
  assert.equal(choices.find((entry) => entry.path === 'D:/old/map.txt').recent, true)
  assert.equal(choices.find((entry) => entry.path === 'D:/manual/map.txt').manual, true)
  assert.deepEqual(api.mapChoicesOf(null, [], ''), [])
  /* A run entry duplicates a workspace map: it must not appear twice. */
  assert.equal(choices.filter((entry) => entry.path === 'D:/sdk/app/projects/standard/Output/bin/map.txt').length, 1)
})
/* ============================== auto-run ============================== */

test('shouldAutoRun only fires with a tool, a map, python and either a new map or no history', () => {
  const base = {
    toolFound: true,
    newestMap: { path: 'D:/sdk/Output/bin/map.txt', mtimeMs: 2 },
    python: { ok: true, version: '3.9.10' },
    mapIsNewerThanRun: true,
    runs: [],
  }
  assert.equal(api.shouldAutoRun(base), true)
  assert.equal(api.shouldAutoRun(Object.assign({}, base, { mapIsNewerThanRun: false, runs: [{ runId: 'x' }] })), false)
  assert.equal(api.shouldAutoRun(Object.assign({}, base, { mapIsNewerThanRun: false, runs: [] })), true)
  assert.equal(api.shouldAutoRun(Object.assign({}, base, { toolFound: false })), false)
  assert.equal(api.shouldAutoRun(Object.assign({}, base, { newestMap: null })), false)
  assert.equal(api.shouldAutoRun(Object.assign({}, base, { python: { ok: false, version: '', error: 'missing' } })), false)
  assert.equal(api.shouldAutoRun(null), false)
})

/* ============================== root lookup ============================== */

test('rootOf prefers the stored memmap root, then the context, then the other pages', () => {
  const local = boot({ storage: { 'dsh-workbench-memmap.root.v1': 'D:/sdk' } })
  const dock = { getContext() { return { root: 'D:/ws' } } }
  assert.equal(local.api.rootOf(dock), 'D:/sdk')

  const fallback = boot({ storage: { 'dsh-workbay.root.v1': 'D:/files-ws' } })
  assert.equal(fallback.api.rootOf(dock), 'D:/ws')

  const filesOnly = boot({ storage: { 'dsh-workbay.root.v1': 'D:/files-ws' } })
  assert.equal(filesOnly.api.rootOf({ getContext() { return {} } }), 'D:/files-ws')

  const nothing = boot()
  assert.equal(nothing.api.rootOf(undefined), '')
})

/* ============================== rpc ============================== */

function responseOf(status, text, statusText) {
  return {
    status,
    statusText: statusText === undefined ? '' : statusText,
    ok: status >= 200 && status < 300,
    async text() { return text },
  }
}

test('call() turns an empty 404 into an actionable "host not loaded" error', async () => {
  const local = boot({ fetch: async () => responseOf(404, '') })
  await assert.rejects(() => local.api.call('detect', {}), (error) => {
    assert.equal(error.code, 'host-unavailable')
    assert.match(error.message, /HTTP 404/)
    return true
  })
})

test('call() never surfaces "Unexpected end of JSON input"', async () => {
  const local = boot({ fetch: async () => responseOf(200, '<!doctype html><html></html>') })
  await assert.rejects(() => local.api.call('detect', {}), (error) => {
    assert.equal(error.code, 'transport')
    assert.doesNotMatch(error.message, /JSON input/)
    return true
  })
})

test('call() unwraps data and forwards a structured host error code', async () => {
  const ok = boot({ fetch: async () => responseOf(200, JSON.stringify({ ok: true, data: { root: 'D:/sdk' } })) })
  assert.deepEqual(await ok.api.call('detect', { root: 'D:/sdk' }), { root: 'D:/sdk' })

  const failed = boot({ fetch: async () => responseOf(200, JSON.stringify({ ok: false, error: { code: 'no-tool', message: '没有找到工具' } })) })
  await assert.rejects(() => failed.api.call('run', {}), (error) => {
    assert.equal(error.code, 'no-tool')
    assert.equal(error.message, '没有找到工具')
    return true
  })
})

test('call() reports a network failure as its own code', async () => {
  const local = boot({ fetch: async () => { throw new Error('connection refused') } })
  await assert.rejects(() => local.api.call('detect', {}), (error) => {
    assert.equal(error.code, 'network')
    assert.match(error.message, /connection refused/)
    return true
  })
})

/* ============================== remembered map ============================== */

test('the last analysed map is remembered and readable from storage', () => {
  const local = boot({ storage: { 'dsh-workbench-memmap.map.v1': 'D:/sdk/app/projects/standard/Output/bin/map.txt' } })
  assert.equal(local.api.MAP_KEY, 'dsh-workbench-memmap.map.v1')
  assert.equal(local.api.readStoredRoot(local.api.MAP_KEY), 'D:/sdk/app/projects/standard/Output/bin/map.txt')
  const empty = boot()
  assert.equal(empty.api.readStoredRoot(empty.api.MAP_KEY), '')
})
/* ============================== locale ============================== */

test('the two dictionaries have exactly the same keys', () => {
  const enKeys = Object.keys(api.dictionaries.EN).sort()
  const zhKeys = Object.keys(api.dictionaries.ZH).sort()
  assert.deepEqual(zhKeys, enKeys)
})

test('dictionaryFor resolves zh and falls back to en', () => {
  assert.equal(api.dictionaryFor('zh-CN'), api.dictionaries.ZH)
  assert.equal(api.dictionaryFor('zh_TW'), api.dictionaries.ZH)
  assert.equal(api.dictionaryFor('en-US'), api.dictionaries.EN)
  assert.equal(api.dictionaryFor('fr'), api.dictionaries.EN)
})
