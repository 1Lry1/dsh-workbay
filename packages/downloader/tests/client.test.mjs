/**
 * The downloader client bundle contract.
 *
 * The client half is one `window.__ModuleLoader__.load({ id, factory })` file.
 * These tests materialize it against a stub loader/React and assert the plugin
 * surface. The old "加入对话" chat-insertion path was removed at the user's
 * request (the AI reads the log route/tool directly), so a regression guard
 * keeps it out.
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
  return { registrations, React }
}

test('the client registers exactly one module and exports apply(ctx)', () => {
  const { registrations, React } = loadClient()
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].id, 'dsh-downloader')
  const module = registrations[0].factory((specifier) => {
    if (specifier === 'react') return React
    throw new Error('unexpected require: ' + specifier)
  })
  assert.equal(typeof module.apply, 'function')
  assert.deepEqual(module.inject, [])
})

test('the bundle no longer carries the chat-insertion button', () => {
  assert.doesNotMatch(source, /加入对话/)
  assert.doesNotMatch(source, /insertTextIntoChat|formatLogsForChat|findChatComposer/)
})

test('the page still streams logs from the host SSE route', () => {
  assert.match(source, /new EventSource\(API \+ '\/events'\)/)
})
