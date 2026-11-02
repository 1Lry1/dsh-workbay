/**
 * Tests for the downloader client's "logs → chat" helpers.
 *
 * The client half is a single `window.__ModuleLoader__.load({ id, factory })`
 * bundle (browser code, built file). We register it against a stub loader, then
 * call the factory with a React stub — the factory body only defines components
 * and helpers, so materializing it in Node is safe.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientPath = path.join(here, '..', 'lib', 'client.js')

let cached = null
function loadClient() {
  if (cached !== null) return cached
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
    new Function('window', readFileSync(clientPath, 'utf8'))(globalThis.window)
  } finally {
    globalThis.window = previousWindow
  }
  assert.equal(registrations.length, 1, 'the bundle must register exactly one client module')
  assert.equal(registrations[0].id, 'dsh-downloader')
  cached = registrations[0].factory((specifier) => {
    if (specifier === 'react') return React
    throw new Error('unexpected require: ' + specifier)
  })
  return cached
}

test('the client module exposes apply and the test helpers', () => {
  const module = loadClient()
  assert.equal(typeof module.apply, 'function')
  assert.equal(typeof module.__test?.formatLogsForChat, 'function')
  assert.equal(typeof module.__test?.insertTextIntoChat, 'function')
})

test('formatLogsForChat names the in-memory cache and the downloader_logs tool', () => {
  const text = loadClient().__test.formatLogsForChat({
    total: 4321,
    logs: [
      { t: new Date(2026, 10, 2, 9, 5, 7).getTime(), src: 'B', text: 'board boot ok' },
      { t: new Date(2026, 10, 2, 9, 5, 8).getTime(), src: 'D', text: 'flash 100%' },
    ],
  })
  assert.match(text, /Downloader 日志/)
  assert.match(text, /内存环形缓冲/)
  assert.match(text, /downloader_logs/)
  assert.match(text, /\/downloader\/log\/recent/)
  assert.match(text, /共 4321 条/)
  assert.match(text, /最近 2 条/)
  assert.match(text, /09:05:07 \[B\] board boot ok/)
  assert.match(text, /09:05:08 \[D\] flash 100%/)
})

test('formatLogsForChat truncates a huge snapshot and says how to continue', () => {
  const logs = Array.from({ length: 5000 }, (_, index) => ({
    t: 1700000000000 + index,
    src: 'B',
    text: 'line ' + index + ' ' + 'x'.repeat(40),
  }))
  const text = loadClient().__test.formatLogsForChat({ total: 50000, logs })
  assert.ok(text.length <= 60000, 'text length ' + text.length)
  assert.match(text, /已截断/)
  assert.match(text, /downloader_logs/)
})

test('formatLogsForChat tolerates an empty/partial payload', () => {
  const empty = loadClient().__test.formatLogsForChat({})
  assert.match(empty, /共 0 条/)
  const junk = loadClient().__test.formatLogsForChat({ total: 1, logs: [null, { text: 42 }] })
  assert.match(junk, /\[S\] 42/)
})

test('formatLogsForChat includes the on-disk location sheet when given', () => {
  const text = loadClient().__test.formatLogsForChat(
    { total: 3, logs: [{ t: 0, src: 'S', text: 'hi' }] },
    { pointer: 'C:\\Users\\x\\.dsh\\workbay\\downloader-logs.location.json', tool: 'downloader_logs' },
  )
  assert.match(text, /地址清单：C:\\Users\\x\\\.dsh\\workbay\\downloader-logs\.location\.json/)
})
test('insertTextIntoChat degrades to no-composer without a DOM', () => {
  const result = loadClient().__test.insertTextIntoChat('hello')
  assert.equal(result, 'no-composer')
})
