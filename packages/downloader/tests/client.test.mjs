/**
 * The downloader client bundle contract + log-buffer performance guards.
 *
 * The client half is one `window.__ModuleLoader__.load({ id, factory })` file.
 * These tests materialize it against a stub loader/React and assert the plugin
 * surface, the batched/windowed log path (which is what keeps the page fast
 * once the cache fills), and that the removed "加入对话" path stays removed.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientPath = path.join(here, '..', 'lib', 'client.js')
const source = readFileSync(clientPath, 'utf8')

function loadClient() {
  const registrations = []
  const React = {
    createElement: () => null,
    Fragment: Symbol('Fragment'),
    useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
    useRef: (value) => ({ current: value }),
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  }
  const previousWindow = globalThis.window
  globalThis.window = { __ModuleLoader__: { load: (registration) => registrations.push(registration) } }
  try {
    new Function('window', source)(globalThis.window)
  } finally {
    globalThis.window = previousWindow
  }
  const module = registrations[0].factory((specifier) => {
    if (specifier === 'react') return React
    throw new Error('unexpected require: ' + specifier)
  })
  return { registrations, module }
}

test('the client registers exactly one module and exports apply(ctx)', () => {
  const { registrations, module } = loadClient()
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].id, 'dsh-downloader')
  assert.equal(typeof module.apply, 'function')
  assert.deepEqual(module.inject, [])
})

test('single and batched log events feed one buffer rendered through a virtual window', () => {
  assert.match(source, /e\.ev === 'log'/)
  assert.match(source, /e\.ev === 'logs'/)
  assert.match(source, /CLIENT_MAX_LOGS = 300000/)
  // the log view is virtualized by fixed row height; the 800-row cap is gone
  assert.match(source, /ROW_HEIGHT = 18/)
  assert.match(source, /const range = virtualRange\(/)
  assert.doesNotMatch(source, /RENDER_LIMIT/)
})

test('appendLogs appends without mutating and trims to the cap', () => {
  const { module } = loadClient()
  const { appendLogs } = module.__test
  const base = [{ t: 1 }, { t: 2 }, { t: 3 }]
  const next = appendLogs(base, [{ t: 4 }], 3)
  assert.deepEqual(next.map((x) => x.t), [2, 3, 4])
  assert.deepEqual(base.map((x) => x.t), [1, 2, 3], 'input array must not be mutated')
  const empty = []
  assert.equal(appendLogs(empty, [], 10), empty)
})

test('appendLogs handles a batch larger than the cap', () => {
  const { module } = loadClient()
  const { appendLogs } = module.__test
  const items = Array.from({ length: 10 }, (_, i) => ({ t: i }))
  const next = appendLogs([], items, 4)
  assert.deepEqual(next.map((x) => x.t), [6, 7, 8, 9])
})

test('virtualRange renders a bounded slice with spacer heights', () => {
  const { module } = loadClient()
  const { virtualRange } = module.__test
  const first = virtualRange(0, 360, 10000, 18, 20)
  assert.equal(first.start, 0)
  assert.ok(first.end >= 40 && first.end < 100, 'viewport + overscan, not the whole list')
  assert.equal(first.topPad, 0)
  assert.equal(first.bottomPad, (10000 - first.end) * 18)
  const middle = virtualRange(9000, 360, 10000, 18, 20)
  assert.ok(middle.start > 400 && middle.start <= 480)
  assert.equal(middle.topPad, middle.start * 18)
  const end = virtualRange(1e9, 360, 100, 18, 20)
  assert.equal(end.start, 100)
  assert.equal(end.end, 100)
  assert.equal(end.bottomPad, 0)
  const empty = virtualRange(0, 0, 0, 18, 20)
  assert.deepEqual([empty.start, empty.end, empty.topPad, empty.bottomPad], [0, 0, 0, 0])
})

test('searchParts splits a line into hit/plain segments for highlighting', () => {
  const { module } = loadClient()
  const { searchParts } = module.__test
  assert.deepEqual(searchParts('flash 100%', 'flash', false, false, false),
    [{ text: 'flash', hit: true }, { text: ' 100%', hit: false }])
  assert.deepEqual(searchParts('ABC abc', 'abc', true, false, false).filter((p) => p.hit).map((p) => p.text), ['abc'])
  // a literal dot must not act as a regex wildcard
  assert.equal(searchParts('a.b', '.', false, false, false).filter((p) => p.hit).length, 1)
  // regex mode
  assert.equal(searchParts('a1 b2', '\\d', false, false, true).filter((p) => p.hit).length, 2)
  // whole word: "sw" inside "sworn" must not match
  assert.equal(searchParts('word sworn', 'sw', false, true, false).filter((p) => p.hit).length, 0)
  // invalid regex degrades to plain text instead of throwing
  assert.deepEqual(searchParts('x', '(', false, false, true), [{ text: 'x', hit: false }])
})

test('searching splits the pane: live stream on top, results below, click locates', () => {
  assert.match(source, /\/log\/context\?/)
  assert.match(source, /const locate = React\.useCallback/)
  assert.match(source, /mergeLogs\(logsRef\.current, data\.logs/)
  assert.match(source, /const resultRows = search\.matches/)
  assert.match(source, /className: 'abw-log abw-resultList'/)
  assert.match(source, /abw-split/)
  assert.match(source, /setSelectedKey\(logKey\(l\)\); void locate\(l\)/)
  assert.match(source, /is-target/)
  assert.match(source, /已定位到实时日志/)
})

test('mergeLogs dedupes, sorts and caps the live buffer', () => {
  const { module } = loadClient()
  const { mergeLogs } = module.__test
  const live = [{ t: 3, src: 'S', text: 'c' }, { t: 4, src: 'S', text: 'd' }]
  const merged = mergeLogs(live, [{ t: 1, src: 'S', text: 'a' }, { t: 4, src: 'S', text: 'd' }, { t: 2, src: 'S', text: 'b' }], 100)
  assert.deepEqual(merged.map((x) => x.text), ['a', 'b', 'c', 'd'])
  assert.equal(live.length, 2, 'input array must not be mutated')
  const capped = mergeLogs([{ t: 1, src: 'S', text: 'a' }], [{ t: 2, src: 'S', text: 'b' }, { t: 3, src: 'S', text: 'c' }], 2)
  assert.deepEqual(capped.map((x) => x.text), ['b', 'c'])
  assert.equal(mergeLogs(live, [], 10), live, 'no incoming leaves the array identity')
})
test('the page has a Notepad++-style search bar over the full log file', () => {
  assert.match(source, /placeholder: '搜索日志/)
  assert.match(source, /\/log\/search\?/)
  assert.match(source, /abw-hit/)
  assert.match(source, /searchParts\(/)
})
test('20k lines in 60ms-style batches stay fast (no per-line O(n) copy)', () => {
  const { module } = loadClient()
  const { appendLogs } = module.__test
  const cap = 20000
  const batch = Array.from({ length: 50 }, (_, i) => ({ t: i, src: 'B', text: 'line' }))
  let logs = []
  const started = Date.now()
  for (let i = 0; i < 400; i += 1) logs = appendLogs(logs, batch, cap)
  const elapsed = Date.now() - started
  assert.equal(logs.length, cap)
  assert.ok(elapsed < 1500, `400 batches took ${elapsed}ms`)
})

test('formatBytes renders the local log-file occupancy shown in the page', () => {
  const { module } = loadClient()
  const { formatBytes } = module.__test
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(2048), '2.0 KB')
  assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB')
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(undefined), '0 B')
})

test('the page pages older logs in from the host JSONL on scroll', () => {
  assert.match(source, /\/log\/history\?before=/)
  assert.match(source, /上滚加载更早/)
  assert.match(source, /node\.scrollTop = beforeTop \+ \(node\.scrollHeight - beforeHeight\)/)
})
test('the page shows the local log file size and resets it on clear', () => {
  assert.match(source, /本地 ' \+ formatBytes\(st\.logFile\.size\)/)
  assert.match(source, /const logFile = e\.file \? \{ \.\.\.\(x\.logFile \|\| \{\}\), \.\.\.e\.file \}/)
  assert.match(source, /size: 0, lines: 0, exists: false/)
})
test('the bundle no longer carries the chat-insertion button', () => {
  assert.doesNotMatch(source, /加入对话/)
  assert.doesNotMatch(source, /insertTextIntoChat|formatLogsForChat|findChatComposer/)
})

test('the page still streams logs from the host SSE route', () => {
  assert.match(source, /new EventSource\(API \+ '\/events'\)/)
})
