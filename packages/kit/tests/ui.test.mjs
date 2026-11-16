import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  LAYOUT_MODES,
  LAYOUT_STORAGE_KEY,
  RECENT_LIMIT,
  RECENT_STORAGE_KEY,
  TIERS,
  TIER_MIN_WIDTH,
  TOKENS,
  baseName,
  createUi,
  normalizeLayoutMode,
  normalizeRecentEntry,
  pathKey,
  pushRecent,
  readLayoutMode,
  readRecent,
  resolveLayout,
  tierFor,
  togglePinned,
  tokensCss,
  writeLayoutMode,
  writeRecent,
} from '../src/ui.js'

/* ------------------------------- tiers ------------------------------- */

test('tierFor: every boundary belongs to the wider tier', () => {
  assert.deepEqual(TIERS, ['t1', 't2', 't3', 't4'])
  assert.equal(tierFor(0), 't1')
  assert.equal(tierFor(519), 't1')
  assert.equal(tierFor(TIER_MIN_WIDTH.t2 - 1), 't1')
  assert.equal(tierFor(TIER_MIN_WIDTH.t2), 't2')
  assert.equal(tierFor(TIER_MIN_WIDTH.t3 - 1), 't2')
  assert.equal(tierFor(TIER_MIN_WIDTH.t3), 't3')
  assert.equal(tierFor(TIER_MIN_WIDTH.t4 - 1), 't3')
  assert.equal(tierFor(TIER_MIN_WIDTH.t4), 't4')
  assert.equal(tierFor(4000), 't4')
})

test('tierFor: nonsense widths fall back to the narrowest tier', () => {
  for (const value of [undefined, null, Number.NaN, Infinity, -10, 'wide', {}]) {
    assert.equal(tierFor(value), 't1', String(value))
  }
})

/* ------------------------------ layout ------------------------------- */

test('resolveLayout: auto follows the tier', () => {
  assert.equal(resolveLayout('t1', 'auto'), 'single')
  assert.equal(resolveLayout('t2', 'auto'), 'single')
  assert.equal(resolveLayout('t3', 'auto'), 'split')
  assert.equal(resolveLayout('t4', 'auto'), 'tri')
})

test('resolveLayout: a manual choice wins at every tier', () => {
  for (const mode of ['single', 'split', 'tri']) {
    for (const tier of TIERS) {
      assert.equal(resolveLayout(tier, mode), mode, `${tier}/${mode}`)
    }
  }
})

test('resolveLayout: unknown mode or tier degrades safely', () => {
  assert.equal(resolveLayout('t3', 'nonsense'), 'split')
  assert.equal(resolveLayout('nonsense', 'auto'), 'single')
  assert.equal(normalizeLayoutMode('TRI'), 'auto')
  assert.deepEqual(LAYOUT_MODES, ['auto', 'single', 'split', 'tri'])
})

function memoryStorage(initial) {
  const map = new Map(Object.entries(initial ?? {}))
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: (key) => { map.delete(key) },
    snapshot: () => Object.fromEntries(map),
  }
}

test('layout mode round-trips and rejects garbage', () => {
  const storage = memoryStorage()
  assert.equal(readLayoutMode(storage), 'auto')
  assert.equal(writeLayoutMode(storage, 'split'), 'split')
  assert.equal(storage.snapshot()[LAYOUT_STORAGE_KEY], 'split')
  assert.equal(readLayoutMode(storage), 'split')
  assert.equal(writeLayoutMode(storage, 'nope'), 'auto')
  assert.equal(readLayoutMode(storage), 'auto')
  assert.equal(readLayoutMode(memoryStorage({ [LAYOUT_STORAGE_KEY]: 'tri' })), 'tri')
})

test('layout storage failures never throw', () => {
  const hostile = {
    getItem() { throw new Error('blocked') },
    setItem() { throw new Error('quota') },
  }
  assert.equal(readLayoutMode(hostile), 'auto')
  assert.equal(writeLayoutMode(hostile, 'tri'), 'tri')
  assert.equal(readLayoutMode(undefined), 'auto')
  assert.equal(writeLayoutMode(undefined, 'single'), 'single')
})

/* --------------------------- recent workspaces ------------------------ */

test('pathKey: folds separators and the drive letter, keeps the rest', () => {
  assert.equal(pathKey('D:\\work\\proj\\'), 'd:/work/proj')
  assert.equal(pathKey('d:/work/proj'), 'd:/work/proj')
  assert.equal(pathKey('  D:\\work\\proj  '), 'd:/work/proj')
  assert.equal(pathKey(''), '')
  assert.equal(pathKey(null), '')
  /* Case still matters below the drive letter: a case-sensitive share is real. */
  assert.notEqual(pathKey('D:\\work\\Proj'), pathKey('D:\\work\\proj'))
})

test('baseName: last segment, both separators', () => {
  assert.equal(baseName('D:\\work\\customer\\demo_sdk'), 'demo_sdk')
  assert.equal(baseName('D:/work/customer/579x/'), '579x')
  assert.equal(baseName(''), '')
  assert.equal(baseName('C:\\'), 'C:')
})

test('normalizeRecentEntry: fills the name, drops unusable entries', () => {
  assert.deepEqual(
    normalizeRecentEntry({ path: 'D:\\work\\proj', at: 5, pinned: true }),
    { path: 'D:\\work\\proj', name: 'proj', pinned: true, at: 5 },
  )
  assert.equal(normalizeRecentEntry({ path: '   ' }), null)
  assert.equal(normalizeRecentEntry(null), null)
  assert.equal(normalizeRecentEntry('D:\\work\\proj'), null)
})

test('pushRecent: same path moves to the front instead of duplicating', () => {
  const first = pushRecent([], { path: 'D:\\work\\one' }, { at: 100 })
  const second = pushRecent(first, { path: 'D:\\work\\two' }, { at: 200 })
  const again = pushRecent(second, { path: 'd:/work/one' }, { at: 300 })
  assert.deepEqual(again.map((item) => item.name), ['one', 'two'])
  assert.equal(again[0].path, 'd:/work/one', 'the newest spelling is what gets stored')
  assert.equal(again.length, 2)
})

test('pushRecent: caps the list, newest first, oldest evicted', () => {
  let list = []
  for (let index = 0; index < RECENT_LIMIT + 3; index += 1) {
    list = pushRecent(list, { path: 'D:\\work\\p' + index }, { at: index })
  }
  assert.equal(list.length, RECENT_LIMIT)
  assert.equal(list[0].name, 'p' + (RECENT_LIMIT + 2))
  assert.equal(list[list.length - 1].name, 'p3')
})

test('pushRecent: pinned workspaces are never evicted', () => {
  let list = []
  list = pushRecent(list, { path: 'D:\\work\\pinned', pinned: true }, { at: 1, limit: 3 })
  for (let index = 0; index < 5; index += 1) {
    list = pushRecent(list, { path: 'D:\\work\\n' + index }, { at: 10 + index, limit: 3 })
  }
  assert.equal(list.length, 3)
  assert.equal(list[0].name, 'pinned')
  assert.equal(list[0].pinned, true)
  assert.deepEqual(list.map((item) => item.name), ['pinned', 'n4', 'n3'])
})

test('pushRecent: keeps the caller array untouched and ignores junk', () => {
  const original = [normalizeRecentEntry({ path: 'D:\\work\\one', at: 1 })]
  const frozen = JSON.stringify(original)
  const next = pushRecent(original, { path: 'D:\\work\\two' }, { at: 2 })
  assert.equal(JSON.stringify(original), frozen)
  assert.equal(next.length, 2)
  assert.deepEqual(pushRecent(original, { path: '' }, { at: 3 }), original)
  assert.deepEqual(pushRecent(undefined, { path: 'D:\\work\\x' }, { at: 4 }).length, 1)
})

test('togglePinned: flips one entry, leaves the others alone', () => {
  const list = [
    normalizeRecentEntry({ path: 'D:\\work\\one', at: 1 }),
    normalizeRecentEntry({ path: 'D:\\work\\two', at: 2 }),
  ]
  const next = togglePinned(list, 'd:/work/one')
  assert.deepEqual(next.map((item) => item.pinned), [true, false])
  const back = togglePinned(next, 'd:\\work\\one') /* drive letter is case-insensitive */
  assert.deepEqual(back.map((item) => item.pinned), [false, false])
  /* Anything past the drive letter stays case-sensitive, so this must NOT match. */
  assert.deepEqual(togglePinned(next, 'D:\\work\\ONE').map((item) => item.pinned), [true, false])
  assert.deepEqual(togglePinned(list, ''), list)
})

test('recent storage round-trips, survives corruption', () => {
  const storage = memoryStorage()
  assert.deepEqual(readRecent(storage), [])
  writeRecent(storage, [
    { path: 'D:\\work\\one', at: 1 },
    { path: 'D:\\work\\two', at: 2, pinned: true },
  ])
  const restored = readRecent(storage)
  assert.equal(restored.length, 2)
  assert.equal(restored[0].name, 'two', 'pinned sorts first')
  assert.equal(restored[0].pinned, true)
  assert.equal(storage.snapshot()[RECENT_STORAGE_KEY].includes('D:\\\\work\\\\one'), true)
  assert.deepEqual(readRecent(memoryStorage({ [RECENT_STORAGE_KEY]: '{not json' })), [])
  assert.deepEqual(readRecent(memoryStorage({ [RECENT_STORAGE_KEY]: '{"a":1}' })), [])
  assert.deepEqual(readRecent(memoryStorage({ [RECENT_STORAGE_KEY]: '[{"path":"  "},null]' })), [])
})

/* ------------------------------- tokens ------------------------------- */

test('tokensCss emits every token under :root by default', () => {
  const css = tokensCss()
  assert.equal(css.startsWith(':root{'), true)
  for (const name of Object.keys(TOKENS)) assert.equal(css.includes(name), true, name)
  assert.equal(css.includes('--wb-brand:var(--dsw-alias-brand-primary'), true)
  assert.equal(tokensCss('[data-w="t3"]').startsWith('[data-w="t3"]{'), true)
  assert.equal(tokensCss('').startsWith(':root{'), true)
})

/* ----------------------------- primitives ----------------------------- */

function recorder() {
  const calls = []
  const h = (type, props, ...children) => {
    calls.push({ type, props, children })
    return { type, props, children }
  }
  return { h, calls, last: () => calls[calls.length - 1] }
}

test('createUi requires a createElement function', () => {
  assert.throws(() => createUi(undefined), /createElement/)
})

test('button: default and variant classes, click passthrough', () => {
  const { h, last } = recorder()
  const ui = createUi(h)
  let clicked = 0
  const plain = ui.button({ onClick: () => { clicked += 1 } }, '提交')
  assert.equal(plain.type, 'button')
  assert.equal(plain.props.className, 'wb-btn')
  plain.props.onClick()
  assert.equal(clicked, 1)
  assert.equal(ui.button({ variant: 'primary' }, '提交').props.className, 'wb-btn is-primary')
  assert.equal(ui.button({ variant: 'danger', className: 'x' }, '擦除').props.className, 'wb-btn is-danger x')
  assert.equal(ui.button(undefined, 'ok').props.disabled, false)
  assert.equal(last().props.disabled, false)
})

test('iconButton: active/danger flags and aria label', () => {
  const { h } = recorder()
  const ui = createUi(h)
  const node = ui.iconButton({ title: '刷新', active: true }, 'icon')
  assert.equal(node.props.className, 'wb-iconBtn is-active')
  assert.equal(node.props['aria-label'], '刷新')
  assert.equal(ui.iconButton({ title: 'x', danger: true }, 'icon').props.className, 'wb-iconBtn is-danger')
})

test('chip and segmented pass their state through', () => {
  const { h } = recorder()
  const ui = createUi(h)
  assert.equal(ui.chip({ kind: 'warn' }, '3 变更').props.className, 'wb-chip is-warn')
  const picked = []
  const seg = ui.segmented({ value: 'a', onChange: (id) => picked.push(id) }, [
    { id: 'a', label: '行内' },
    { id: 'b', label: '并排' },
  ])
  assert.equal(seg.type, 'div')
  assert.equal(seg.props.className, 'wb-seg')
  assert.equal(seg.children[0].props['aria-pressed'], true)
  assert.equal(seg.children[1].props['aria-pressed'], false)
  seg.children[1].props.onClick()
  assert.deepEqual(picked, ['b'])
})
