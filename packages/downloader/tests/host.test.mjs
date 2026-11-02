/**
 * Host-side regression tests for the downloader plugin (no DSH boot, no hardware).
 *
 * The two bugs these lock down were observed on a real board:
 *   1) two `launch` commands reached the IPC helper (two Downloader windows /
 *      "tool conflict") when /flash/start was clicked twice or raced the
 *      auto-flash path;
 *   2) a failed serial open printed one "串口错误" line per retry (10x) and each
 *      attempt waited the 3 s command timeout because the helper's failure was
 *      an id-less `err` event instead of an id-matched reply.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { __test } from '../lib/index.js'

const { shouldLaunchFlash, serialErrorLine } = __test

function flashState(overrides = {}) {
  return { connected: false, launching: false, pid: null, ...overrides }
}

function serialState() {
  return { serial: { opening: false, lastError: null, dupCount: 0, suppressed: 0 } }
}

test('shouldLaunchFlash allows exactly one launch while idle', () => {
  assert.equal(shouldLaunchFlash(flashState(), false), true)
  assert.equal(shouldLaunchFlash(flashState(), true), true)
})

test('shouldLaunchFlash blocks a second launch during startup', () => {
  assert.equal(shouldLaunchFlash(flashState({ launching: true }), true), false)
  // launched but handshake not done yet: pid is set and the helper is alive
  assert.equal(shouldLaunchFlash(flashState({ pid: 4242 }), true), false)
})

test('shouldLaunchFlash blocks once connected, allows after helper exit', () => {
  assert.equal(shouldLaunchFlash(flashState({ connected: true }), true), false)
  // helper exited (alive=false): pid is stale, a fresh launch is allowed
  assert.equal(shouldLaunchFlash(flashState({ pid: 4242 }), false), true)
})

test('serialErrorLine collapses identical errors inside the 3 s window', () => {
  const state = serialState()
  const first = serialErrorLine(state, '拒绝访问 COM22', 1000)
  assert.match(first, /串口错误: 拒绝访问 COM22/)
  assert.equal(state.serial.dupCount, 0)

  assert.equal(serialErrorLine(state, '拒绝访问 COM22', 1500), null)
  assert.equal(serialErrorLine(state, '拒绝访问 COM22', 2000), null)
  assert.equal(state.serial.dupCount, 2)

  // A new distinct message flushes the merged count in its own line.
  const next = serialErrorLine(state, '另一个错误', 2500)
  assert.match(next, /已合并 2 条重复错误/)
  assert.equal(state.serial.dupCount, 0)
})

test('serialErrorLine logs again after the dedupe window', () => {
  const state = serialState()
  assert.notEqual(serialErrorLine(state, 'timeout', 1000), null)
  assert.equal(serialErrorLine(state, 'timeout', 3999), null)
  assert.notEqual(serialErrorLine(state, 'timeout', 5000), null)
})

test('serialErrorLine never returns an empty line', () => {
  const state = serialState()
  assert.match(serialErrorLine(state, '   ', 1000), /未知错误/)
})
