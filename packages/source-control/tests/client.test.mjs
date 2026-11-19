/**
 * Client-half tests for `dsh-workbay-source-control`.
 *
 * The shell's load-bearing logic is pure: the path JOIN between two hosts that
 * disagree about what a path is relative to, the status letter per row, the
 * flatten/filter of the tree, and the breakpoint decision. Those are what these
 * tests pin — the parts that are wrong silently rather than loudly.
 *
 * Run:  node --test tests/client.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = readFileSync(path.join(here, '..', 'src', 'client.js'), 'utf8')

/* ============================== harness ============================== */

function makeReact() {
  const Fragment = Symbol('Fragment')
  return {
    Fragment,
    createElement(type, props, ...children) {
      const normalized = props === null || props === undefined ? {} : props
      normalized.children = children.length === 0 ? undefined : (children.length === 1 ? children[0] : children)
      return { type, props: normalized, children: children.flat() }
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
  const listeners = new Map()
  const document = {
    baseURI: 'http://127.0.0.1:3080/',
    visibilityState: opts.visibilityState === undefined ? 'visible' : opts.visibilityState,
    head: { appendChild() {} },
    documentElement: { appendChild() {} },
    createElement() {
      return { attributes: {}, textContent: '', setAttribute(name, value) { this.attributes[name] = value }, remove() {} }
    },
    addEventListener(name, fn) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(fn)
    },
    removeEventListener(name, fn) {
      const list = listeners.get(name)
      if (list === undefined) return
      const index = list.indexOf(fn)
      if (index >= 0) list.splice(index, 1)
    },
  }
  const window = {
    __DSH_WORKBAY__: opts.dock,
    __ModuleLoader__: {
      load(spec) {
        assert.equal(spec.id, 'dsh-workbay-source-control')
        const React = makeReact()
        const mod = spec.factory((name) => {
          if (name === 'react') return React
          throw new Error('unexpected require: ' + name)
        })
        registered.push({ id: spec.id, mod, React })
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
  const run = new Function('window', 'document', 'navigator', 'fetch', 'performance', source)
  run(window, document, { language: opts.language === undefined ? 'en-US' : opts.language },
    opts.fetch === undefined ? async () => { throw new Error('no network') } : opts.fetch,
    { mark() {}, measure() {}, getEntriesByName() { return [] } })
  assert.equal(registered.length, 1, 'the bundle must call __ModuleLoader__.load exactly once')
  return { entry: registered[0], api: registered[0].mod.__test, window, document, storage, listeners }
}

const booted = boot()
const api = booted.api

/* ============================== module contract ============================== */

test('the bundle exports apply and the frozen page contract helpers', () => {
  assert.equal(typeof booted.entry.mod.apply, 'function')
  assert.equal(booted.entry.mod.name, 'dsh-workbay-source-control')
  assert.equal(api.PAGE_ID, 'source-control')
})

test('registers exactly one workbench page: source-control, order 15', () => {
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
  assert.equal(pages[0].id, 'source-control')
  /* Between the files page (10) and the git page (20): the composed view belongs
     where a person looks first, not after the terminal. */
  assert.equal(pages[0].order, 15)
  assert.equal(typeof pages[0].component, 'function')
  assert.equal(typeof pages[0].icon, 'function')
})

/* ============================== path join ============================== */

test('repoRootRelative: identity when the repo IS the workspace', () => {
  assert.equal(api.repoRootRelative('D:/ws', 'D:/ws'), '')
  assert.equal(api.repoRootRelative('D:\\ws', 'D:\\ws'), '')
  /* Separators are normalised on the way in, so a Windows path and a POSIX one match. */
  assert.equal(api.repoRootRelative('D:/ws', 'D:\\ws'), '')
})

test('repoRootRelative: a nested repository yields its prefix', () => {
  assert.equal(api.repoRootRelative('D:/ws', 'D:/ws/repo-a'), 'repo-a')
  assert.equal(api.repoRootRelative('D:/ws', 'D:/ws/a/b'), 'a/b')
  assert.equal(api.repoRootRelative('D:/ws', 'D:/ws/src/u-boot'), 'src/u-boot')
})

test('repoRootRelative: a repository OUTSIDE the workspace is not representable', () => {
  /* The git page can open any repository on any drive. Its paths cannot be joined
     to a workspace tree, so the answer must be null — not a wrong string. */
  assert.equal(api.repoRootRelative('D:/ws', 'E:/other'), null)
  assert.equal(api.repoRootRelative('D:/ws', 'D:/ws2'), null, 'a bare prefix is not containment')
  assert.equal(api.repoRootRelative('', 'D:/ws'), null)
  assert.equal(api.repoRootRelative('D:/ws', ''), null)
})

test('absoluteFromRoot turns a tree row into the host path the @ button inserts', () => {
  assert.equal(api.absoluteFromRoot('D:\\work\\workspace\\demo', 'build.bat'), 'D:\\work\\workspace\\demo\\build.bat')
  assert.equal(api.absoluteFromRoot('D:\\work\\workspace\\demo\\', 'app/src/main.c'), 'D:\\work\\workspace\\demo\\app\\src\\main.c')
  assert.equal(api.absoluteFromRoot('D:\\work\\workspace\\demo', '/tools/build.bat'), 'D:\\work\\workspace\\demo\\tools\\build.bat')
  assert.equal(api.absoluteFromRoot('D:\\work\\workspace\\demo', 'docs/'), 'D:\\work\\workspace\\demo\\docs\\')
  assert.equal(api.absoluteFromRoot('D:\\work\\workspace\\demo', ''), 'D:\\work\\workspace\\demo')
  assert.equal(api.absoluteFromRoot('', 'build.bat'), '')
  assert.equal(api.absoluteFromRoot('\\\\srv\\share\\', 'app/x.c'), '\\\\srv\\share\\app\\x.c')
})

test('parseRemotes + webUrlOfRemote + branchWebUrl build the browser address', () => {
  const remotes = api.parseRemotes([
    'origin\thttps://gitea.idoocn.com:30443/linf/demo.git (fetch)',
    'origin\thttps://gitea.idoocn.com:30443/linf/demo.git (push)',
    'mirror\tgit@example.com:team/repo.git (fetch)',
    'mirror\tgit@example.com:team/repo.git (push)',
  ])
  assert.equal(remotes.origin.fetch, 'https://gitea.idoocn.com:30443/linf/demo.git')
  assert.equal(remotes.origin.push, 'https://gitea.idoocn.com:30443/linf/demo.git')
  assert.equal(remotes.mirror.fetch, 'git@example.com:team/repo.git')

  assert.equal(api.webUrlOfRemote('https://gitea.idoocn.com:30443/linf/demo.git'), 'https://gitea.idoocn.com:30443/linf/demo')
  assert.equal(api.webUrlOfRemote('http://host/a/b.git'), 'http://host/a/b')
  assert.equal(api.webUrlOfRemote('git@example.com:team/repo.git'), 'https://example.com/team/repo')
  assert.equal(api.webUrlOfRemote('ssh://git@example.com:2222/team/repo.git'), 'https://example.com:2222/team/repo')
  assert.equal(api.webUrlOfRemote(''), '')
  assert.equal(api.webUrlOfRemote('D:\\local\\repo'), '')

  const base = 'https://gitea.idoocn.com:30443/linf/demo'
  assert.equal(api.branchWebUrl(base, 'branch', 'project-a-Pre'), base + '/src/branch/project-a-Pre')
  assert.equal(api.branchWebUrl(base, 'branch', 'feature/login'), base + '/src/branch/feature/login')
  assert.equal(api.branchWebUrl(base, 'tag', 'v1.0'), base + '/src/tag/v1.0')
  assert.equal(api.branchWebUrl('', 'branch', 'main'), '')
  assert.equal(api.branchWebUrl(base, 'branch', ''), '')
})

test('toRepoPath / toWorkspaceRel are inverses, and refuse to guess', () => {
  /* Same root: identity both ways. */
  assert.equal(api.toRepoPath('src/x.ts', ''), 'src/x.ts')
  assert.equal(api.toWorkspaceRel('src/x.ts', ''), 'src/x.ts')

  /* Nested repo: the prefix is added and stripped. */
  assert.equal(api.toRepoPath('repo-a/src/x.ts', 'repo-a'), 'src/x.ts')
  assert.equal(api.toWorkspaceRel('src/x.ts', 'repo-a'), 'repo-a/src/x.ts')

  /* Outside the repo: null, because there is no valid answer. */
  assert.equal(api.toRepoPath('repo-b/src/x.ts', 'repo-a'), null)
  assert.equal(api.toRepoPath('src/x.ts', 'repo-a'), null, 'a repo-relative path cannot be made workspace-relative without the prefix')

  /* Unknown root: every conversion is refused rather than passed through. */
  assert.equal(api.toRepoPath('src/x.ts', null), null)
  assert.equal(api.toWorkspaceRel('src/x.ts', null), null)

  /* Round trip over a realistic set. */
  for (const repoRel of ['a.ts', 'src/b.ts', 'src/deep/c.ts', '.gitignore', 'x y/z.ts']) {
    const ws = api.toWorkspaceRel(repoRel, 'repo-a')
    assert.equal(api.toRepoPath(ws, 'repo-a'), repoRel, 'round trip for ' + repoRel)
  }
})

/* ============================== status letters ============================== */

test('statusLetterOf picks one letter, with conflict winning over everything', () => {
  assert.equal(api.statusLetterOf({ kind: 'modified' }), 'M')
  assert.equal(api.statusLetterOf({ kind: 'added' }), 'A')
  assert.equal(api.statusLetterOf({ kind: 'deleted' }), 'D')
  assert.equal(api.statusLetterOf({ kind: 'renamed' }), 'R')
  assert.equal(api.statusLetterOf({ kind: 'typechange' }), 'T')
  assert.equal(api.statusLetterOf({ untracked: true }), 'U')
  /* Precedence: a conflicted file is not merely "modified". */
  assert.equal(api.statusLetterOf({ kind: 'modified', conflicted: true }), 'C')
  assert.equal(api.statusLetterOf({ untracked: true, conflicted: true }), 'C')
  assert.equal(api.statusLetterOf(null), '')
  assert.equal(api.statusLetterOf(undefined), '')
})

test('statusColorClass maps every letter to a token-backed class', () => {
  assert.equal(api.statusColorClass('M'), 'is-modified')
  assert.equal(api.statusColorClass('A'), 'is-added')
  assert.equal(api.statusColorClass('D'), 'is-deleted')
  assert.equal(api.statusColorClass('R'), 'is-renamed')
  assert.equal(api.statusColorClass('C'), 'is-conflict')
  assert.equal(api.statusColorClass('U'), 'is-untracked')
  /* An unknown letter must not produce an empty class (which would render with no
     colour at all); it falls back to "modified", the most common case. */
  assert.equal(api.statusColorClass('Z'), 'is-modified')
})

/* ============================== status index ============================== */

test('buildStatusIndex keys changes by WORKSPACE-relative path', () => {
  const snapshot = {
    changes: [
      { path: 'src/x.ts', kind: 'modified' },
      { path: 'a.ts', kind: 'added' },
    ],
  }
  const same = api.buildStatusIndex(snapshot, '')
  assert.equal(same.size, 2)
  assert.equal(same.get('src/x.ts').kind, 'modified')

  /* Nested repo: the tree's path has the prefix, the snapshot's does not. */
  const nested = api.buildStatusIndex(snapshot, 'repo-a')
  assert.equal(nested.size, 2)
  assert.equal(nested.get('repo-a/src/x.ts').kind, 'modified')
  assert.equal(nested.has('src/x.ts'), false, 'the raw repo path must not leak into the tree index')
})

test('buildStatusIndex tolerates a garbage snapshot instead of throwing', () => {
  assert.equal(api.buildStatusIndex(null, '').size, 0)
  assert.equal(api.buildStatusIndex({}, '').size, 0)
  assert.equal(api.buildStatusIndex({ changes: 'nope' }, '').size, 0)
  /* Entries without a usable path are dropped, not turned into junk keys. */
  const index = api.buildStatusIndex({ changes: [{ kind: 'modified' }, null, { path: '' }] }, '')
  assert.equal(index.size, 0)
})

test('buildDirtyDirs marks every ancestor of a change, and nothing else', () => {
  const index = new Map([['src/deep/x.ts', {}], ['other/y.ts', {}]])
  const dirs = api.buildDirtyDirs(index)
  assert.ok(dirs.has('src'))
  assert.ok(dirs.has('src/deep'))
  assert.ok(dirs.has('other'))
  assert.equal(dirs.has(''), false, 'the root is not a "dirty directory"')
  assert.equal(dirs.has('unrelated'), false)
})

/* ============================== flatten ============================== */

function makeDirs() {
  return {
    '': {
      status: 'ready',
      truncated: false,
      entries: [
        { name: 'src', rel: 'src', type: 'dir' },
        { name: 'a.ts', rel: 'a.ts', type: 'file', size: 3, mtimeMs: 1 },
        { name: 'b.ts', rel: 'b.ts', type: 'file', size: 4, mtimeMs: 2 },
      ],
    },
    src: {
      status: 'ready',
      truncated: false,
      entries: [
        { name: 'deep', rel: 'src/deep', type: 'dir' },
        { name: 'c.ts', rel: 'src/c.ts', type: 'file', size: 5, mtimeMs: 3 },
      ],
    },
    'src/deep': {
      status: 'ready',
      truncated: false,
      entries: [
        { name: 'd.ts', rel: 'src/deep/d.ts', type: 'file', size: 6, mtimeMs: 4 },
      ],
    },
  }
}

test('flatten descends only into expanded directories', () => {
  const dirs = makeDirs()
  const collapsed = api.flattenTree(dirs, new Set(['']), {})
  assert.deepEqual(collapsed.filter((row) => row.kind === 'entry').map((row) => row.rel), ['src', 'a.ts', 'b.ts'])

  const expanded = api.flattenTree(dirs, new Set(['', 'src']), {})
  assert.deepEqual(expanded.filter((row) => row.kind === 'entry').map((row) => row.rel), ['src', 'src/deep', 'src/c.ts', 'a.ts', 'b.ts'])
})

test('a manually collapsed directory overrides "changes only" auto-expansion', () => {
  const dirs = {
    '': { status: 'ready', entries: [{ name: 'src', rel: 'src', type: 'dir' }, { name: 'a.ts', rel: 'a.ts', type: 'file' }] },
    src: { status: 'ready', entries: [{ name: 'c.ts', rel: 'src/c.ts', type: 'file' }] },
  }
  const statusIndex = new Map([['src/c.ts', { kind: 'modified', added: 1, deleted: 0, staged: false }]])
  const dirtyDirs = api.buildDirtyDirs(statusIndex)
  /* 只看变更：有改动的目录自动展开（这里没有显式展开 src）。 */
  const auto = api.flattenTree(dirs, new Set(['']), { statusIndex, dirtyDirs, onlyChanges: true })
  assert.ok(auto.filter((row) => row.kind === 'entry').map((row) => row.rel).includes('src/c.ts'))
  /* 用户手动收起 src 后，自动展开必须让位。 */
  const collapsed = api.flattenTree(dirs, new Set(['']), { statusIndex, dirtyDirs, onlyChanges: true, collapsed: new Set(['src']) })
  assert.equal(collapsed.filter((row) => row.kind === 'entry').map((row) => row.rel).includes('src/c.ts'), false)
  assert.equal(collapsed.find((row) => row.rel === 'src').expanded, false)
})
test('changes-only shows deleted files that no longer exist on disk', () => {
  const dirs = {
    '': { status: 'ready', entries: [{ name: 'src', rel: 'src', type: 'dir' }, { name: 'kept.ts', rel: 'kept.ts', type: 'file' }] },
    src: { status: 'ready', entries: [{ name: 'c.ts', rel: 'src/c.ts', type: 'file' }] },
  }
  const statusIndex = new Map([
    ['gone.ts', { kind: 'deleted', added: 0, deleted: 3, staged: false }],
    ['src/old.ts', { kind: 'deleted', added: 0, deleted: 1, staged: false }],
    ['olddir/sub/dead.bin', { kind: 'deleted', added: 0, deleted: 9, staged: false }],
  ])
  const dirtyDirs = api.buildDirtyDirs(statusIndex)
  const rows = api.flattenTree(dirs, new Set(['']), { statusIndex, dirtyDirs, onlyChanges: true })
  const entries = rows.filter((row) => row.kind === 'entry')
  const gone = entries.find((row) => row.rel === 'gone.ts')
  const nested = entries.find((row) => row.rel === 'src/old.ts')
  assert.ok(gone !== undefined && nested !== undefined, JSON.stringify(entries.map((row) => row.rel)))
  assert.equal(gone.missing, true)
  assert.equal(nested.missing, true)
  assert.equal(gone.letter, 'D')
  /* A whole deleted directory (olddir/sub) is absent from the disk tree; it and
     its child must still be synthesised so the D record is reachable. */
  assert.ok(entries.some((row) => row.rel === 'olddir' && row.dir === true && row.missing === true))
  assert.ok(entries.some((row) => row.rel === 'olddir/sub' && row.dir === true && row.missing === true))
  assert.equal(entries.find((row) => row.rel === 'olddir/sub/dead.bin').letter, 'D')
  /* The clean file must stay hidden in changes-only mode. */
  assert.equal(entries.some((row) => row.rel === 'kept.ts'), false)
  /* With the filter off, no ghost rows are invented. */
  const all = api.flattenTree(dirs, new Set(['', 'src']), { statusIndex, dirtyDirs })
  assert.equal(all.some((row) => row.rel === 'gone.ts' && row.missing === true), false)
})

test('flatten puts directories first, then names in natural order', () => {
  const dirs = {
    '': {
      status: 'ready',
      entries: [
        { name: 'file10.ts', rel: 'file10.ts', type: 'file' },
        { name: 'file2.ts', rel: 'file2.ts', type: 'file' },
        { name: 'zeta', rel: 'zeta', type: 'dir' },
        { name: 'alpha', rel: 'alpha', type: 'dir' },
      ],
    },
  }
  const rows = api.flattenTree(dirs, new Set(['']), {})
  assert.deepEqual(rows.map((row) => row.rel), ['alpha', 'zeta', 'file2.ts', 'file10.ts'])
})

test('flatten attaches the status letter and diff stats per row', () => {
  const dirs = makeDirs()
  /* A file can carry edits on BOTH sides; the row shows the side its group
     represents (staged → index counts, unstaged → worktree counts). */
  const statusIndex = new Map([
    ['a.ts', { kind: 'modified', added: 5, deleted: 2, staged: true }],
    ['b.ts', { kind: 'modified', added: 1, deleted: 1, staged: false, unstagedAdded: 7, unstagedDeleted: 3 }],
  ])
  const rows = api.flattenTree(dirs, new Set(['']), { statusIndex })
  const a = rows.find((row) => row.rel === 'a.ts')
  assert.equal(a.letter, 'M')
  assert.equal(a.colorClass, 'is-modified')
  assert.equal(a.added, 5)
  assert.equal(a.deleted, 2)
  const b = rows.find((row) => row.rel === 'b.ts')
  assert.equal(b.added, 7, 'an unstaged row reports the WORKTREE edits')
  assert.equal(b.deleted, 3)
  const clean = rows.find((row) => row.rel === 'src')
  void clean
})

test('flatten marks a directory with a dot only when something under it changed', () => {
  const dirs = makeDirs()
  const statusIndex = new Map([['src/deep/d.ts', { kind: 'modified' }]])
  const dirtyDirs = api.buildDirtyDirs(statusIndex)
  const rows = api.flattenTree(dirs, new Set(['']), { statusIndex, dirtyDirs })
  const src = rows.find((row) => row.rel === 'src')
  assert.equal(src.hasDirtyChild, true)
  assert.equal(src.letter, '', 'a directory carries a dot, never a letter')
})

test('"changes only" filters the SAME tree instead of building a second one', () => {
  const dirs = makeDirs()
  const statusIndex = new Map([['src/deep/d.ts', { kind: 'modified' }]])
  const dirtyDirs = api.buildDirtyDirs(statusIndex)
  const rows = api.flattenTree(dirs, new Set(['']), { statusIndex, dirtyDirs, onlyChanges: true })

  const files = rows.filter((row) => row.kind === 'entry' && row.dir === false)
  assert.deepEqual(files.map((row) => row.rel), ['src/deep/d.ts'], 'only the changed file survives')
  /* The ancestors stay so the changed file keeps its place in the hierarchy. */
  assert.ok(rows.some((row) => row.rel === 'src' && row.dir === true))
  assert.ok(rows.some((row) => row.rel === 'src/deep' && row.dir === true))
  assert.equal(rows.some((row) => row.rel === 'a.ts'), false, 'an untouched file is hidden')
})

test('flatten emits a status row for an expanded-but-loading directory', () => {
  const dirs = makeDirs()
  dirs.src = { status: 'loading', entries: [], truncated: false }
  const rows = api.flattenTree(dirs, new Set(['', 'src']), {})
  const status = rows.find((row) => row.kind === 'status')
  assert.ok(status !== undefined)
  assert.equal(status.rel, 'src')
  assert.equal(status.status, 'loading')
})

test('flatten emits an error row that carries the message through', () => {
  const dirs = makeDirs()
  dirs.src = { status: 'error', entries: [], truncated: false, error: 'permission denied' }
  const rows = api.flattenTree(dirs, new Set(['', 'src']), {})
  const status = rows.find((row) => row.kind === 'status')
  assert.equal(status.status, 'error')
  assert.equal(status.message, 'permission denied')
})

test('an unloaded or broken ROOT emits a status row instead of nothing', () => {
  /* A blank pane is indistinguishable from "this folder is empty", which is the
     worst thing a file explorer can say. The root always exists on screen, so it
     must always say something — a spinner or the error. */
  const idle = api.flattenTree({}, new Set(['']), {})
  assert.equal(idle.length, 1)
  assert.equal(idle[0].kind, 'status')
  assert.equal(idle[0].status, 'loading')

  const idle2 = api.flattenTree({ '': { status: 'idle', entries: [] } }, new Set(['']), {})
  assert.equal(idle2[0].status, 'loading', 'the pre-load state reads as loading, not as empty')

  const broken = api.flattenTree({ '': { status: 'error', entries: [], error: 'permission denied' } }, new Set(['']), {})
  assert.equal(broken[0].kind, 'status')
  assert.equal(broken[0].status, 'error')
  assert.equal(broken[0].message, 'permission denied')

  /* An EXPANDED but not-yet-loaded child shows its own loading row in place —
     the indicator belongs where the content will appear. */
  const child = api.flattenTree({ '': { status: 'ready', entries: [{ name: 'src', rel: 'src', type: 'dir' }] } }, new Set(['', 'src']), {})
  const childStatus = child.filter((row) => row.kind === 'status')
  assert.equal(childStatus.length, 1)
  assert.equal(childStatus[0].rel, 'src')
  assert.equal(childStatus[0].status, 'loading')

  /* A COLLAPSED unloaded child contributes nothing beyond its own row. */
  const collapsed = api.flattenTree({ '': { status: 'ready', entries: [{ name: 'src', rel: 'src', type: 'dir' }] } }, new Set(['']), {})
  assert.equal(collapsed.filter((row) => row.kind === 'status').length, 0)

  /* Garbage in must not throw. */
  assert.deepEqual(api.flattenTree(null, new Set(), {}).length, 1)
})

/* ============================== breakpoints ============================== */

test('modeOfWidth maps the panel range onto the four layouts', () => {
  /* The real range matters: the dock clamps to 360 and the float to 520, so the
     XS branch is reachable in production, not a theoretical one. */
  assert.equal(api.modeOfWidth(360), 'XS')
  assert.equal(api.modeOfWidth(479), 'XS')
  assert.equal(api.modeOfWidth(480), 'S')
  assert.equal(api.modeOfWidth(719), 'S')
  assert.equal(api.modeOfWidth(720), 'M')
  assert.equal(api.modeOfWidth(1023), 'M')
  assert.equal(api.modeOfWidth(1024), 'L')
  assert.equal(api.modeOfWidth(1400), 'L')
  /* An unmeasured element must not crash the layout decision. */
  assert.equal(api.modeOfWidth(0), 'S')
  assert.equal(api.modeOfWidth(Number.NaN), 'S')
})

/* ============================== small helpers ============================== */

test('path helpers normalise Windows input and keep POSIX output', () => {
  assert.equal(api.normalizeRel('a\\b\\c'), 'a/b/c')
  assert.equal(api.normalizeRel('/a/b/'), 'a/b')
  assert.equal(api.normalizeRel(''), '')
  assert.equal(api.joinRel('a', 'b.ts'), 'a/b.ts')
  assert.equal(api.joinRel('', 'b.ts'), 'b.ts')
  assert.equal(api.joinRel('a', ''), 'a')
  assert.equal(api.baseNameOf('src/deep/x.ts'), 'x.ts')
  assert.equal(api.baseNameOf('x.ts'), 'x.ts')
  assert.equal(api.dirNameOf('src/deep/x.ts'), 'src/deep')
  assert.equal(api.dirNameOf('x.ts'), '')
  assert.equal(api.extensionOf('a.tar.gz'), 'gz')
  assert.equal(api.extensionOf('Makefile'), '')
  assert.equal(api.extensionOf('.gitignore'), '', 'a dotfile has no extension')
})

/* ============================== the rules the design rests on ============================== */

test('the shell declares no routes of its own (it reuses the two existing hosts)', () => {
  /* Owning a filesystem or git route here would mean duplicating the security
     fences. Assert the client only ever talks to the two prefixes that already
     exist, so a "convenience" endpoint cannot appear unnoticed. */
  const prefixes = [...source.matchAll(/(?:const\s+\w+_PREFIX\s*=\s*')([^']+)'/g)].map((m) => m[1])
  assert.ok(prefixes.length >= 2)
  for (const prefix of prefixes) {
    assert.ok(
      prefix.startsWith('/dsh-workbay-files/') || prefix.startsWith('/dsh-gitcraft/'),
      'unexpected RPC prefix in the shell: ' + prefix,
    )
  }
})

test('the shell never imports another bundle (it composes through the registry)', () => {
  /* The whole failure-domain argument depends on this. A require of the files or
     gitcraft module would couple the three pages and break independent installs. */
  assert.equal(/require\('(?!react)/.test(source), false, 'only react may be required')
  assert.ok(source.includes('dock.get('), 'panes are looked up through the registry')
})

test('the tree is virtualised (DOM rows are bounded, not proportional to the list)', () => {
  /* A monorepo directory can put thousands of rows in one listing; the pane has
     to stay responsive, so the render window must be computed from the viewport.
     Assert the mechanism exists rather than trusting a future edit. */
  assert.ok(source.includes('TREE_ROW_HEIGHT'))
  assert.ok(/scrollTop\s*\/\s*TREE_ROW_HEIGHT/.test(source), 'the window is derived from scroll position')
  assert.ok(source.includes('TREE_OVERSCAN'))
  assert.ok(/rows\.slice\(start,\s*start\s*\+/.test(source), 'only a slice of rows is rendered')
})

test('a hidden document is never polled or watched', () => {
  /* A minimised window cannot show a snapshot, and a snapshot costs three git
     subprocesses. The guard must exist in the client, not in the caller. */
  assert.ok(source.includes('visibilityState'), 'the page reads the visibility state')
  assert.ok(/visible !== true/.test(source), 'and gates the snapshot load on it')
})

/* ============================== change groups ============================== */

test('commitMessageFromDetail restores subject and optional body for undo-commit', () => {
  assert.equal(api.commitMessageFromDetail({ subject: 'fix: one', body: '' }), 'fix: one')
  assert.equal(api.commitMessageFromDetail({ subject: 'fix: one', body: 'details\n\nmore' }), 'fix: one\n\ndetails\n\nmore')
  assert.equal(api.commitMessageFromDetail({ subject: '', body: 'body only' }), 'body only')
  assert.equal(api.commitMessageFromDetail(null), '')
})
test('history search filters hash, message and author without crossing fields', () => {
  const commits = [
    { hash: 'abc123def456', short: 'abc123', subject: 'fix: uart timeout', authorName: 'Alice', authorEmail: 'alice@example.com' },
    { hash: 'def456abc123', short: 'def456', subject: 'feat: add parser', authorName: 'Bob', authorEmail: 'bob@example.com' },
  ]
  assert.equal(api.filterHistoryCommits(commits, 'abc123', 'hash').length, 2)
  assert.equal(api.filterHistoryCommits(commits, 'uart', 'message').length, 1)
  assert.equal(api.filterHistoryCommits(commits, 'bob@', 'author').length, 1)
  assert.equal(api.filterHistoryCommits(commits, 'parser', 'hash').length, 0, 'message text must not match in hash mode')
  assert.equal(api.filterHistoryCommits(commits, 'alice', 'all').length, 1)
  assert.equal(api.filterHistoryCommits(commits, '', 'all').length, 2)
})

test('stash offers staged-only without silently dropping untracked files', () => {
  assert.match(source, /if \(stagedOnly\) payload\.staged = true/)
  assert.match(source, /else payload\.includeUntracked = true/)
  assert.match(source, /stash\.stagedOnly/)
  assert.match(source, /stash\.allChanges/)
})

test('buildChangeGroups splits by change type (modified / deleted / added / renamed)', () => {
  const index = new Map([
    ['a.ts', { kind: 'modified', staged: true }],
    ['b.ts', { kind: 'modified', staged: false }],
    ['c.ts', { untracked: true }],
    ['d.ts', { kind: 'modified', conflicted: true }],
    ['e.ts', { kind: 'deleted', staged: false }],
    ['f.ts', { kind: 'renamed', staged: false }],
    ['g.ts', { kind: 'added', staged: false }],
  ])
  const groups = api.buildChangeGroups(index)
  assert.deepEqual(groups.map((g) => g.key), ['conflicted', 'modified', 'deleted', 'added', 'renamed'])
  assert.deepEqual(groups[0].rows.map((r) => r.rel), ['d.ts'])
  assert.deepEqual(groups[1].rows.map((r) => r.rel), ['a.ts', 'b.ts'])
  assert.deepEqual(groups[2].rows.map((r) => r.rel), ['e.ts'])
  assert.deepEqual(groups[3].rows.map((r) => r.rel), ['c.ts', 'g.ts'])
  assert.deepEqual(groups[4].rows.map((r) => r.rel), ['f.ts'])
  assert.equal(groups[3].untrackedOnly, false, 'mixed added group does not use delete wording')
})

test('buildChangeGroups puts a conflicted untracked file in conflicts only', () => {
  /* A conflict outranks every other classification: a file that will not merge
     cannot usefully be shown as "untracked" or "staged", because the only action
     that helps is resolving it. */
  const index = new Map([['x.ts', { untracked: true, conflicted: true, staged: true }]])
  const groups = api.buildChangeGroups(index)
  assert.deepEqual(groups[0].rows.map((r) => r.rel), ['x.ts'])
  assert.equal(groups[1].rows.length + groups[2].rows.length + groups[3].rows.length + groups[4].rows.length, 0)
})

test('buildChangeGroups sorts by path inside each group', () => {
  const index = new Map([
    ['z.ts', { kind: 'modified', staged: false }],
    ['a.ts', { kind: 'modified', staged: false }],
    ['m.ts', { kind: 'modified', staged: false }],
  ])
  assert.deepEqual(api.buildChangeGroups(index)[1].rows.map((r) => r.rel), ['a.ts', 'm.ts', 'z.ts'])
})

test('buildChangeGroups tolerates an empty or junk map', () => {
  const empty = api.buildChangeGroups(new Map())
  assert.equal(empty.length, 5)
  assert.equal(empty.every((g) => g.rows.length === 0), true)
  const junk = api.buildChangeGroups(new Map([['a.ts', null], ['b.ts', undefined]]))
  assert.equal(junk.every((g) => g.rows.length === 0), true, 'null entries are skipped, not crashed on')
})

/* ============================== relative time ============================== */

test('relativeTime renders a human age and never "1970"', () => {
  const t = (key) => ({ 'time.justNow': 'now', 'time.minutesAgo': 'm', 'time.hoursAgo': 'h', 'time.daysAgo': 'd' }[key] ?? key)
  const now = Date.now()
  assert.equal(api.relativeTime(now - 5_000, t), 'now')
  assert.equal(api.relativeTime(now - 5 * 60_000, t), '5m')
  assert.equal(api.relativeTime(now - 5 * 3_600_000, t), '5h')
  assert.equal(api.relativeTime(now - 5 * 86_400_000, t), '5d')
  /* Implausible values must not print an epoch date. */
  assert.equal(api.relativeTime(0, t), '')
  assert.equal(api.relativeTime(Number.NaN, t), '')
  assert.equal(api.relativeTime(null, t), '')
  /* Anything older than a month falls back to a real date string. */
  assert.equal(typeof api.relativeTime(now - 90 * 86_400_000, t), 'string')
  assert.notEqual(api.relativeTime(now - 90 * 86_400_000, t), '')
})

/* ============================== search highlight ============================== */

test('highlightName marks exactly the characters the host scored', () => {
  /* The host returns indices into the WHOLE rel, so a basename-only render has to
     shift them by the directory prefix; getting this wrong highlights the wrong
     letters, which looks like a broken search. */
  /* "alphabet.ts" inside "src/alphabet.ts": the prefix is 4 chars, so indices
     6 and 7 in the full path are "p" and "h" in the basename. */
  const parts = api.highlightName('alphabet.ts', [6, 7], 'src/alphabet.ts')
  const asText = (part) => {
    if (typeof part === 'string') return part
    const children = Array.isArray(part.children) ? part.children : [part.children]
    return children.map(asText).join('')
  }
  const text = parts.map(asText).join('')
  assert.equal(text, 'alphabet.ts', 'the visible text must be unchanged')
  const marks = parts.filter((p) => typeof p === 'object' && p.type === 'mark')
  assert.equal(marks.length, 1)
  assert.equal(asText(marks[0]), 'ph')
})

test('highlightName degrades to plain text without indices', () => {
  assert.equal(api.highlightName('a.ts', undefined, 'a.ts'), 'a.ts')
  assert.equal(api.highlightName('a.ts', [], 'a.ts'), 'a.ts')
  /* Indices that all fall inside the directory prefix must not produce an empty
     render or a negative slice. */
  assert.equal(api.highlightName('a.ts', [0, 1], 'src/a.ts'), 'a.ts')
})




