/**
 * Client-bundle smoke test: the browser half must be loadable, register exactly
 * one tab through the module loader contract, and render its panel with stubbed
 * React/DOM + a fake better-sidebar service.
 *
 * Run:  node --test tests/client.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientPath = path.join(here, '..', 'src', 'client.js')
const source = readFileSync(clientPath, 'utf8')

/** A minimal React stand-in: createElement builds a tree we can inspect. */
function makeReact() {
  const React = {
    Fragment: 'FRAGMENT',
    createElement(type, props, ...children) {
      return { type, props: props === null || props === undefined ? {} : props, children: children.flat() }
    },
    useState(initial) {
      const value = typeof initial === 'function' ? initial() : initial
      return [value, () => {}]
    },
    useEffect() {},
    useMemo(fn) { return fn() },
    useRef(value) { return { current: value } },
    useCallback(fn) { return fn },
    memo(fn) { return fn },
  }
  return React
}

/** Collect every element in a tree, depth-first, executing function components. */
function walk(node, visit) {
  if (node === null || node === undefined || typeof node === 'boolean') return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (typeof node !== 'object' || node.type === undefined) return
  visit(node)
  for (const child of node.children) walk(child, visit)
}

/** Render a tree by executing every function component (hooks are stubs). */
function render(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return []
  if (Array.isArray(node)) return node.flatMap((child) => render(child))
  if (typeof node === 'string' || typeof node === 'number') return [node]
  if (typeof node !== 'object' || node.type === undefined) return []
  if (typeof node.type === 'function') {
    if (node.type === 'FRAGMENT') return node.children.flatMap((child) => render(child))
    return render(node.type(node.props, node.children))
  }
  return node.children.flatMap((child) => render(child))
}

function textOf(node) {
  return render(node).filter((entry) => typeof entry === 'string' || typeof entry === 'number').join(' ')
}

/** Boot the bundle the way the DSH client module loader does. */
function boot({ betterSidebar, native, locale, dock, react, fetch }) {
  const activeLocale = locale === undefined ? 'en' : locale
  const registered = []
  const styleTags = []
  const document = {
    head: { appendChild(node) { styleTags.push(node) } },
    createElement(tag) {
      return { tag, attributes: {}, textContent: '', setAttribute(name, value) { this.attributes[name] = value }, remove() {} }
    },
    baseURI: 'http://127.0.0.1:3080/',
    /* The `/watch` loop parks itself while the window is hidden (each `changed`
       result costs a full snapshot). Exposed so a test can drive the state. */
    visibilityState: 'visible',
  }
  const window = {
    /* The workbench dock publishes its page registry on this global, and the
       plugin registers into it during apply. */
    __DSH_WORKBAY__: dock,
    __ModuleLoader__: {
      load({ id, factory }) {
        assert.equal(id, 'dsh-gitcraft')
        const React = react === undefined ? makeReact() : react()
        const require = (name) => {
          if (name === 'react') return React
          throw new Error('unexpected require: ' + name)
        }
        const mod = factory(require)
        registered.push({ id, mod, React })
      },
    },
    localStorage: { getItem() { return null }, setItem() {}, removeItem() {} },
    addEventListener() {},
    removeEventListener() {},
  }
  const effects = []
  const injections = []
  const ctx = {
    effect(fn, label) {
      const dispose = fn()
      effects.push({ label, dispose })
      return () => { if (typeof dispose === 'function') dispose() }
    },
    get(name) {
      if (name === 'betterSidebar') return betterSidebar
      if (name === 'locale') return { register() {}, getSnapshot() { return { active: activeLocale } }, subscribe() { return () => {} } }
      if (name === 'sidebarRightTabs') return native === undefined ? undefined : native.tabs
      if (name === 'slots') return native === undefined ? undefined : native.slots
      return undefined
    },
    inject(names, callback) {
      injections.push(names)
      const available = names.every((name) => ctx.get(name) !== undefined)
      if (!available) {
        return { dispose() {} }
      }
      const fiber = { disposed: false, dispose() { this.disposed = true } }
      callback({
        ...ctx,
        effect: ctx.effect,
        get: ctx.get,
      })
      return fiber
    },
  }
  // eslint-disable-next-line no-new-func
  const factoryFn = new Function('window', 'document', 'navigator', 'fetch', source)
  const noNetwork = async () => { throw new Error('no network in tests') }
  factoryFn(window, document, { language: 'en-US' }, fetch === undefined ? noNetwork : fetch)
  const entry = registered[0]
  entry.mod.apply(ctx)
  return { registered, effects, injections, styleTags, ctx, React: entry.React }
}

test('the bundle registers itself through the module loader contract', () => {
  const booted = boot({ betterSidebar: undefined, native: undefined })
  assert.equal(booted.registered.length, 1)
  assert.equal(booted.registered[0].id, 'dsh-gitcraft')
  assert.equal(typeof booted.registered[0].mod.apply, 'function')
})

test('it injects the stylesheet and removes it on dispose', () => {
  const booted = boot({ betterSidebar: undefined, native: undefined })
  assert.ok(booted.styleTags.length >= 1, 'a style tag was appended')
  const style = booted.styleTags[0]
  assert.match(style.textContent, /\.gwc-root/)
  assert.match(style.textContent, /--dsw-alias-bg-base/)
  const styleEffect = booted.effects.find((entry) => String(entry.label).includes('panel styles'))
  assert.ok(styleEffect !== undefined)
})

test('it registers a PAGE with the workbench dock and no better-sidebar tab', () => {
  const dock = { pages: [], registerPage(page) { this.pages.push(page); return () => {} }, list() { return this.pages }, subscribe() { return () => {} } }
  const registered = []
  const betterSidebar = {
    registerTab(descriptor) { registered.push(descriptor); return () => {} },
  }
  const booted = boot({ betterSidebar, native: undefined, dock })
  void booted
  /* The plugin must announce itself to the dock … */
  assert.equal(dock.pages.length, 1, 'one page registered with the dock')
  /* … and must NOT touch better-sidebar's tab strip. */
  assert.equal(registered.length, 0, 'no better-sidebar tab registered')
  const page = dock.pages[0]
  assert.equal(page.id, 'gitcraft')
  assert.equal(typeof page.component, 'function')
  assert.equal(typeof page.title, 'string')
})

test('it registers nothing with the native right-sidebar registry either', () => {
  const dock = { pages: [], registerPage(page) { this.pages.push(page); return () => {} }, list() { return this.pages }, subscribe() { return () => {} } }
  const tabsRegistered = []
  const native = {
    tabs: { register(d) { tabsRegistered.push(d); return () => {} } },
    slots: { inject(_n, cb) { return cb() }, register() { return () => {} } },
  }
  boot({ betterSidebar: undefined, native, dock })
  assert.equal(tabsRegistered.length, 0, 'the dock owns the sidebar seat, not this plugin')
})

test('the workbench page renders the panel chrome in English', () => {
  const dock = { pages: [], registerPage(page) { this.pages.push(page); return () => {} }, list() { return this.pages }, subscribe() { return () => {} } }
  const booted = boot({ betterSidebar: undefined, native: undefined, dock })
  const page = dock.pages[0]
  const tree = page.component({
    ctx: booted.ctx,
    sessionId: 's1',
    cwd: 'D:\\repo',
    t: (key) => key,
  })
  assert.ok(tree !== null && tree !== undefined, 'the panel rendered')
  const text = textOf(tree)
  assert.match(text, /Changes|变更/)
  assert.match(text, /History|历史/)
  assert.match(text, /Branches|分支/)
  assert.match(text, /Stash|贮藏/)
})

test('the workbench page renders in Chinese when the locale says so', () => {
  const dock = { pages: [], registerPage(page) { this.pages.push(page); return () => {} }, list() { return this.pages }, subscribe() { return () => {} } }
  const booted = boot({ betterSidebar: undefined, native: undefined, dock, locale: 'zh-CN' })
  const page = dock.pages[0]
  const tree = page.component({
    ctx: booted.ctx,
    sessionId: 's1',
    cwd: 'D:\\repo',
    t: (key) => key,
  })
  const text = textOf(tree)
  assert.match(text, /变更/)
  assert.match(text, /历史/)
  assert.match(text, /分支/)
})
test('the API base is mount-relative so a reverse proxy prefix still resolves', () => {
  assert.match(source, /const API_BASE = 'dsh-gitcraft\/api'/)
  assert.doesNotMatch(source, /const API_BASE = '\/dsh-gitcraft/)
  assert.match(source, /new URL\(API_BASE \+ '\/', document\.baseURI\)/)
})

test('every mutating call goes through the shared run() guard', () => {
  for (const method of ['stage', 'unstage', 'discard', 'commit', 'merge', 'rebase', 'cherryPick', 'revert', 'reset', 'stashPush', 'tagCreate', 'tagReset', 'branchDelete']) {
    assert.match(source, new RegExp("call\\('" + method + "'"), 'client references ' + method)
  }
})

test('the CSS template contains no backtick (it would end the literal early)', () => {
  /*
   * This has now bitten twice, both times from a comment like "the `.gwc-root`
   * rule": ONE backtick inside the template literal terminates it, and the
   * resulting bundle is a syntax error — the whole panel fails to load, but the
   * diff looks like a harmless comment edit.
   */
  const open = 'const CSS = `'
  const start = source.indexOf(open)
  assert.ok(start >= 0, 'the CSS template exists')
  const end = source.indexOf('\n`', start + open.length)
  assert.ok(end > start, 'the CSS template is terminated by a backtick on its own line')
  const css = source.slice(start + open.length, end)
  assert.ok(css.length > 1000, 'the extracted stylesheet is not truncated: ' + css.length + ' chars')
  assert.equal((css.match(/`/g) ?? []).length, 0, 'no backtick may appear inside the CSS template')
  assert.ok(css.trimEnd().endsWith('}'), 'the stylesheet ends on a complete rule')
})

/* --------------------------------------------------- toolbar notification dots */

test('Pull and Push carry an independent red dot, driven by behind/ahead', () => {
  /* Pull lights up when the remote has commits we do not (`behind > 0`). */
  assert.match(source, /const pullPending = snapshot !== null && snapshot\.upstream !== null && snapshot\.behind > 0/,
    'the Pull dot must be driven by `behind`')
  /* Push lights up when we have commits the remote does not (`ahead > 0`). */
  assert.match(source, /const pushPending = snapshot !== null && snapshot\.detached !== true && snapshot\.ahead > 0/,
    'the Push dot must be driven by `ahead`')
  /* The two must not share a source: a single "something differs" flag would
     light both buttons and tell the user nothing about which way to sync. */
  assert.doesNotMatch(source, /pullPending[^\n]*ahead/, 'the Pull dot must not be driven by `ahead`')
  assert.doesNotMatch(source, /pushPending[^\n]*behind/, 'the Push dot must not be driven by `behind`')
  /* ...and both dots feed the buttons they belong to. */
  assert.match(source, /name: 'pull'[\s\S]{0,200}?dot: pullPending/)
  assert.match(source, /name: 'push'[\s\S]{0,200}?dot: pushPending/)
})

test('the dot is absolutely positioned so it cannot grow the 24px button', () => {
  /* A wider entry once shifted an entire sidebar (packages/dock README §4); the
     same class of bug here would push the header buttons out of line. */
  const dotRule = /\.gwc-dot\{[^}]*\}/.exec(source)
  assert.ok(dotRule !== null, 'a .gwc-dot rule exists')
  assert.match(dotRule[0], /position:absolute/)
  assert.match(dotRule[0], /width:6px/)
  assert.match(dotRule[0], /height:6px/)
  assert.match(dotRule[0], /pointer-events:none/)
  /* The button must be the containing block, and keep its own fixed size. */
  const btnRule = /\.gwc-iconBtn\{[^}]*\}/.exec(source)
  assert.ok(btnRule !== null)
  assert.match(btnRule[0], /position:relative/)
  assert.match(btnRule[0], /width:24px/)
  assert.match(btnRule[0], /height:24px/)
})

test('the dot does not leak into aria-hidden or swallow clicks', () => {
  assert.match(source, /'aria-hidden': 'true' \}\) : null\)/, 'the dot is aria-hidden')
  /* No onClick may be attached to the dot itself: the whole 24px button is the
     target, and a nested handler would double-fire. */
  assert.doesNotMatch(source, /gwc-dot[^)]*onClick/)
})

/* ------------------------------------------------------------ tag revoke UI */

test('a tag row offers revoke instead of a bare local delete', () => {
  assert.match(source, /kind: 'tagRevoke'/, 'the tag action opens the revoke dialog')
  assert.match(source, /function TagRevokeDialog/)
  /* The old path deleted ONLY the local ref, which a fetch silently undid. */
  assert.doesNotMatch(source, /call\('tagDelete'/, 'the local-only delete path is gone from the UI')
})

test('revoke defaults to also removing the remote tag', () => {
  const dialog = source.slice(source.indexOf('function TagRevokeDialog'))
  const body = dialog.slice(0, dialog.indexOf('\n    function '))
  assert.match(body, /useState\(true\)/, 'remoteToo defaults to true — a pushed tag needs both halves')
  assert.match(body, /onSubmit\(\{ name, remoteToo \}\)/)
})

test('revoke goes through the shared run() guard and refreshes the ref lists', () => {
  assert.match(source, /call\('tagReset'/)
  assert.match(source, /store\.apply\(await call\('tagReset'[\s\S]{0,160}?invalidateRefs\(\)/,
    'a tag ref change is not visible in the snapshot, so the lists must be invalidated')
})

/* ------------------------------------------------- bulk stage / discard all */

test('bulk stage and unstage send a flag, never one path per file', () => {
  /*
   * THE REPORTED BUG: "点击全部暂存时提示找不到 git 命令". Expanding the change set
   * into argv blew the Win32 command-line cap, and the spawn failure was
   * mis-reported as a missing git. The client must therefore ASK for the bulk
   * operation instead of enumerating.
   */
  assert.match(source, /call\('stage', withScope\(\{ all: true \}\)\)/, 'stage-all uses the flag')
  assert.match(source, /call\('unstage', withScope\(\{ all: true \}\)\)/, 'unstage-all uses the flag')
  /* The old enumeration must be gone from both bulk buttons. */
  assert.doesNotMatch(source, /doStage\(changeGroups\.unstaged\.concat\(changeGroups\.untracked\)\.map/,
    'stage-all must not build a path list')
  assert.doesNotMatch(source, /doUnstage\(changeGroups\.staged\.map/,
    'unstage-all must not build a path list')
  assert.match(source, /const doStageAll = useCallback/)
  assert.match(source, /const doUnstageAll = useCallback/)
})

test('「全部撤销」exists and is destructive-gated', () => {
  assert.match(source, /const doDiscardAll = useCallback/)
  assert.match(source, /kind: 'confirm'[\s\S]{0,240}?changes\.confirmDiscardAll/, 'discard-all asks before acting')
  assert.match(source, /call\('discard', withScope\(\{ all: true, confirm: true \}\)\)/,
    'the host requires an explicit confirm flag')
  assert.match(source, /danger: true, onClick: doDiscardAll/, 'it is styled as a destructive action')
})

test('「全部撤销」is offered on BOTH change groups', () => {
  /* Discarding is about the worktree, not about which column a file is in: a
     fully-staged tree still needs a way to throw it away. */
  const groupHead = source.slice(source.indexOf('const renderGroup ='), source.indexOf('const diffHunkActions'))
  assert.match(groupHead, /id === 'staged'[\s\S]*?doUnstageAll/, 'the staged group keeps its unstage-all')
  assert.match(groupHead, /id === 'unstaged'[\s\S]*?doStageAll/, 'the unstaged group keeps its stage-all')
  assert.match(groupHead, /gwc-groupActions[\s\S]*?doDiscardAll[\s\S]*?renderChangeRow/,
    'discard-all sits outside the per-group branch so both groups get it')
})

test('the bulk-action row is a flex container so the two buttons never wrap', () => {
  const rule = /\.gwc-groupActions\{[^}]*\}/.exec(source)
  assert.ok(rule !== null, 'a .gwc-groupActions rule exists')
  assert.match(rule[0], /display:flex/)
  assert.match(rule[0], /flex:none/)
})

test('every new error code has both dictionaries', () => {
  for (const key of ['error.argv-too-long', 'error.git-spawn-failed']) {
    assert.equal((source.match(new RegExp("'" + key + "'", 'g')) ?? []).length, 2,
      key + ' must exist in ZH and EN')
  }
})

/* ------------------------------------------------- files page: search + history */

test('a Files page exists with a search box and name/content modes', () => {
  /* The panel previously had NO way to reach a file's history: `fileHistory` and
     `blame` were implemented host-side but the client never called them, so on a
     clean tree there was simply no path to "when was this file changed". */
  assert.match(source, /'nav\.files'/)
  assert.match(source, /const filesView = E\('div'/)
  assert.match(source, /call\('search'/)
  assert.match(source, /call\('fileHistory'/)
  assert.match(source, /files\.mode\.name/, 'name mode has a label')
  assert.match(source, /files\.mode\.content/, 'content mode has a label')
})

test('the Files tab is wired into the nav and the body router', () => {
  const nav = source.slice(source.indexOf('const navBar ='), source.indexOf('/* ---- render: changes'))
  assert.match(nav, /\['files', 'search', 0\]/, 'the tab is in the nav list')
  assert.match(source, /if \(nav === 'files'\) return filesView/, 'the router serves it')
})

test('file search is debounced instead of firing per keystroke', () => {
  /* Each search costs a git spawn (~100 ms). One per keystroke would queue up
     and the panel would show results for a prefix the user has moved past. */
  const effect = source.slice(source.indexOf('File search, debounced'), source.indexOf('Leaving the Files page'))
  assert.match(effect, /setTimeout\(\(\) => \{ void runSearch/)
  assert.match(effect, /clearTimeout\(timer\)/, 'the pending search is cancelled')
  assert.match(effect, /\}, 220\)/, 'a real debounce interval is used')
})

test('a stale search response cannot overwrite a newer one', () => {
  /* Two requests can be in flight; the older one must not win. */
  assert.match(source, /previous\.query !== text/, 'responses are matched against the typed query')
})

test('clicking a file row opens its history, and rows are keyboard reachable', () => {
  assert.match(source, /void loadFileHistory\(file\.path\)/)
  assert.match(source, /void loadFileHistory\(match\.path\)/)
  /* role=button + tabIndex + Enter is what makes the rows usable without a mouse. */
  const rows = source.slice(source.indexOf('const searchRows ='), source.indexOf('const filesView ='))
  assert.match(rows, /role: 'button'/)
  assert.match(rows, /tabIndex: 0/)
  assert.match(rows, /event\.key === 'Enter'/)
})

test('per-commit line counts and rename-following are surfaced', () => {
  assert.match(source, /formatDate\(commit\.authorTime\)/, 'each row shows when it changed')
  assert.match(source, /commit\.added/, 'the +count is rendered')
  assert.match(source, /commit\.deleted/, 'the −count is rendered')
  assert.match(source, /files\.binary/, 'a binary change is labelled instead of showing 0/0')
  assert.match(source, /files\.commitCount/, 'the number of commits is shown')
})

test('switching repository clears the file search and the open history', () => {
  /* Otherwise the panel keeps showing the previous repository's history, which
     looks like the new repository is wrong. */
  const at = source.indexOf('Leaving the Files page')
  assert.ok(at > 0, 'the reset effect is present')
  const body = source.slice(at, at + 700)
  assert.match(body, /setHistoryFor\(null\)/)
  assert.match(body, /setFileQuery\(''\)/)
  assert.match(body, /setSearchResult\(/, 'the stale results are dropped too')
})

test('every files.* string exists in both dictionaries', () => {
  /* Keys may be referenced from several render sites; what matters is that each
     one has a ZH and an EN DEFINITION. Dynamically built keys
     (`t('files.mode.' + mode)`) are skipped — their concrete keys are checked
     separately below. */
  const used = [...source.matchAll(/t\('(files\.[A-Za-z.]+)'/g)].map((m) => m[1])
  assert.ok(used.length >= 8, 'the page uses a real set of strings: ' + used.length)
  const definitions = [...source.matchAll(/'(files\.[A-Za-z.]+)':/g)].map((m) => m[1])
  for (const key of new Set(used)) {
    /* A trailing dot means the key is completed at runtime. */
    if (key.endsWith('.')) continue
    const count = definitions.filter((entry) => entry === key).length
    assert.equal(count, 2, key + ' must be DEFINED in ZH and EN (found ' + count + ')')
  }
  /* The two dynamically composed mode keys must still be defined. */
  for (const mode of ['files.mode.name', 'files.mode.content']) {
    assert.equal(definitions.filter((entry) => entry === mode).length, 2, mode + ' must exist in ZH and EN')
  }
})

test('a file-history row opens a POPUP instead of jumping to the History tab', () => {
  /*
   * Reported: "查看提交记录的修改会跳转到历史页中，能在文件页中弹窗显示吗".
   * Clicking a commit in the Files page used to call setNav('history'), which
   * dropped the file the user was reading. Reading one commit's effect on one
   * file is a DETAIL, not a navigation.
   */
  const row = source.slice(source.indexOf('const renderFileHistoryRow ='), source.indexOf('const searchRows ='))
  assert.doesNotMatch(row, /setNav\('history'\)/, 'the row must not navigate away')
  assert.match(row, /onClick: \(\) => openFileCommit\(commit\)/, 'it opens the popup')
  assert.match(row, /openFileCommit\(commit\)/, 'keyboard activation does the same')
})

test('the commit popup loads the commit detail AND this file\'s own diff', () => {
  const open = source.slice(source.indexOf('const openFileCommit ='), source.indexOf('const loadStash ='))
  assert.match(open, /call\('commitDetail'/, 'metadata comes from commitDetail')
  assert.match(open, /call\('diff'/, 'the file diff comes from diff')
  assert.match(open, /base: 'commit'/, 'the diff is read AT that commit')
  assert.match(open, /rev: commit\.hash/, 'and pinned to the commit hash')
  /* A binary file cannot be diffed; the popup must not even try. */
  assert.match(open, /if \(commit\.binary === true\) return/)
})

test('the popup shows metadata, the other files, and the diff', () => {
  assert.match(source, /const fileCommitModal = fileCommit === null \? null : E\(Modal/)
  assert.match(source, /gwc-commitPopupMeta/, 'author/time/hash are shown')
  assert.match(source, /fileCommit\.detail\.body/, 'the commit body is shown when it adds something')
  assert.match(source, /files\.alsoChanged/, 'other files touched by the same commit are listed')
  assert.match(source, /E\(DiffView, \{[\s\S]{0,500}?hunkActions: undefined/, 'no staging controls on a committed diff')
  /* It is mounted at the root, or it would never render. */
  assert.match(source, /diffModal,\s*\n\s*fileCommitModal,/, 'the popup is in the root node list')
})

test('closing the popup clears both its detail and its diff', () => {
  const modal = source.slice(source.indexOf('const fileCommitModal ='), source.indexOf('/* ---- render: conflict banner'))
  assert.match(modal, /setFileCommit\(null\)/)
  assert.match(modal, /setFileCommitDiff\(/, 'a stale diff must not survive into the next commit')
})

test('the Files tab still exists and still owns its own search state', () => {
  /* The popup must not have replaced the page itself. */
  assert.match(source, /const filesView = E\('div'/)
  assert.match(source, /if \(nav === 'files'\) return filesView/)
})

test('the repo picker wires the workspace scan and browse endpoints', () => {  assert.match(source, /call\('workspace'/)
  assert.match(source, /call\('browse'/)
  assert.match(source, /function RepoPicker/)
  // the picker must be reachable from the header, not only from an empty state
  assert.match(source, /gwc-repoChip/)
  assert.match(source, /setPickerOpen\(true\)/)
})

test('a picked repository overrides the session scope', () => {
  assert.match(source, /chosenRepo/)
  assert.ok(source.includes('typeof chosenRepo ===') && source.includes('? chosenRepo : scopeRepo'), 'chosen repo overrides the scope root')
  assert.match(source, /storeRepo\(/)
})
test('no render value is read before its own initialization (TDZ guard)', () => {
  /*
   * Two real crashes came from this: `historyLayout` was read above its
   * definition, and `diffInnerRef` was used inside JSX above its definition —
   * the latter only threw once a file was selected, so the panel looked fine
   * until you clicked one.
   *
   * Only hook-created values and the view/pane consts built from them take part
   * in render order; scanning every identifier flags ordinary words like
   * `style` or `header` that appear in JSX long before their own declaration.
   * String literals and comments are blanked out for the same reason.
   */
  const body = source.slice(source.indexOf('function Panel(props)'))

  /* Blank strings and comments so words inside them cannot match. */
  /* Comments FIRST: an apostrophe inside a comment would otherwise open a bogus
     string that swallows real code up to the next apostrophe. */
  const scrub = (text) => text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
    .replace(/'(?:\\.|[^'\\])*'/g, (m) => ' '.repeat(m.length))
    .replace(/"(?:\\.|[^"\\])*"/g, (m) => ' '.repeat(m.length))
    .replace(/`(?:\\.|[^`\\])*`/g, (m) => ' '.repeat(m.length))

  const scrubbed = scrub(body)

  /* Declarations that matter: hooks, plus names that read as views/panes/refs. */
  const declarations = new Map()
  for (const match of scrubbed.matchAll(/^ {6}const (\w+) = /gm)) {
    const name = match[1]
    const rest = scrubbed.slice(match.index, match.index + 80)
    const isHook = / = use(State|Ref|Memo|Callback)\b/.test(rest)
    const isView = /(View|Pane|Layout|Ref|Rect|Anchor)$/.test(name)
    if (!isHook && !isView) continue
    if (!declarations.has(name)) declarations.set(name, match.index)
  }
  assert.ok(declarations.size > 5, 'found order-sensitive panel consts: ' + declarations.size)

  const offenders = []
  for (const [name, declaredAt] of declarations) {
    /* The declaration's own name sits right after "const ". */
    const ownIndex = declaredAt + 'const '.length
    const pattern = new RegExp('\\b' + name + '\\b', 'g')
    let firstUse = -1
    for (const match of scrubbed.matchAll(pattern)) {
      if (match.index === ownIndex) continue
      firstUse = match.index
      break
    }
    if (firstUse !== -1 && firstUse < declaredAt) {
      offenders.push(name + ' (used@' + firstUse + ' decl@' + declaredAt + ')')
    }
  }
  assert.deepEqual(offenders, [], 'values read before initialization: ' + offenders.join(', '))
})

test('the history view computes its graph layout before rendering rows', () => {
  const layoutAt = source.indexOf('const historyLayout = useMemo')
  const viewAt = source.indexOf('const historyView =')
  assert.ok(layoutAt !== -1 && viewAt !== -1)
  assert.ok(layoutAt < viewAt, 'historyLayout must be declared before historyView')
})
test('a commit-scoped diff always carries its rev (rev is required regression)', () => {
  /*
   * Browsing a commit's file list used to call loadDiff(path, 'commit')
   * WITHOUT a rev, and the host answered "rev is required" — a toast the user
   * saw as "gitcraft 出错了". Both call sites must pass one.
   */
  const calls = [...source.matchAll(/loadDiff\(([^)]*)\)/g)].map((m) => m[1])
  const commitCalls = calls.filter((args) => args.includes("'commit'"))
  assert.ok(commitCalls.length >= 1, 'found commit-scoped diff calls: ' + JSON.stringify(calls))
  for (const args of commitCalls) {
    const parts = args.split(',').map((part) => part.trim())
    assert.ok(parts.length >= 3, 'commit diff must pass a rev: loadDiff(' + args + ')')
    assert.ok(parts[2] !== undefined && parts[2] !== '', 'rev must not be empty: loadDiff(' + args + ')')
  }
  // The guard inside loadDiff must also refuse a rev-less commit diff.
  assert.match(source, /baseKind === 'commit' && \(typeof rev !== 'string' \|\| rev === ''\)/)
})
test('clicking a file in a commit opens its diff in the history page', () => {
  /* It used to call setNav('changes') and jump away, losing the commit being read.
     Now it sets the in-page target and loads the commit-scoped diff. */
  assert.match(source, /setHistoryFile\(filePath\)/)
  assert.match(source, /loadDiff\(filePath, 'commit', selectedCommit\)/)
  assert.equal(/onFileClick: \(filePath\) => \{\s*setNav\('changes'\)/.test(source), false,
    'history file clicks must not navigate to the changes tab')
  /* The diff now opens in the shared centered modal, not a split pane. */
  assert.match(source, /const diffTitle = selected !== null \? selected\.path : historyFile/)
  assert.match(source, /const diffIsHistory = selected === null && historyFile !== null/)
  assert.equal(source.includes("className: 'gwc-historyDiff'"), false)
})
test('closing a diff resets line selection to an empty Set, not null', () => {
  assert.match(source, /setLineSelection\(new Set\(\)\)/)
  assert.doesNotMatch(source, /setLineSelection\(null\)/)
  assert.match(source, /lineSelection !== null && lineSelection !== undefined/)
})
test('the diff modal owns Escape so the workbench does not close with it', () => {
  /* source is the bundle text read at the top of this file. */
  assert.match(source, /window\.addEventListener\('keydown', onKey, true\)/)
  assert.match(source, /event\.stopPropagation\(\)/)
  assert.match(source, /if \(event\.key !== 'Escape'\) return/)
})
test('a global surface can snapshot from repoRoot alone (no cwd, no sessionId)', () => {
  /*
   * The docked workbench has neither a cwd nor a sessionId — only the repository
   * the user picked. Requiring cwd/session left it stuck on "正在读取仓库…".
   */
  assert.ok(source.includes('const hasRepo = typeof repoRoot'), 'a repoRoot-only request is allowed')
  assert.match(source, /if \(!hasCwd && !hasSession && !hasRepo\)/)
  assert.ok(source.includes("hasCwd ? { cwd } : hasSession ? { sessionId } : {}"), 'payload may be repoRoot-only')
})

test('the picker validates a typed path and gates Add on it', () => {
  assert.match(source, /call\('verifyPath'/)
  assert.match(source, /canAdd = check\.info !== null && check\.info !== undefined && check\.info\.isRepo === true/)
  for (const key of ['picker.pathLabel', 'picker.typeLabel', 'picker.thisIsRepo', 'picker.invalidPath', 'picker.add']) {
    assert.ok(source.includes("'" + key + "'"), 'missing i18n key ' + key)
  }
})

test('the picker takes drive roots from the host, not from a hard-coded list', () => {
  assert.ok(source.includes('listing.drives'), 'drives come from the browse response')
  assert.ok(source.indexOf('String.fromCharCode(code)') === -1, 'no hard-coded C..Z drive loop in the client')
})

/* ========================================================================
 * Refresh behaviour (the reported "History does not refresh after pull" bug).
 *
 * The React stand-in above never runs effects, so it cannot observe a revision
 * bump. These tests mount the real Panel with a small hook runtime instead:
 * state updates re-render, effects run when their deps change, and a scripted
 * fetch answers `snapshot` / `log` / `branches` while holding `watch` open —
 * exactly the `/watch` long-poll the host exposes. A "pull" is then simulated
 * by resolving that long-poll with `changed: true` after moving HEAD.
 * ===================================================================== */

/** A tiny hook-capable React stand-in: enough for the GitCraft panel. */
function makeHookReact() {
  const runtime = {
    instances: new Map(),
    current: null,
    dirty: false,
    root: null,
    elements: [],
    textParts: [],
  }
  const sameDeps = (previous, next) => {
    if (!Array.isArray(previous) || !Array.isArray(next)) return false
    if (previous.length !== next.length) return false
    for (let index = 0; index < previous.length; index += 1) {
      if (!Object.is(previous[index], next[index])) return false
    }
    return true
  }
  const React = {
    Fragment: 'FRAGMENT',
    createElement(type, props, ...children) {
      return { type, props: props === null || props === undefined ? {} : props, children: children.flat() }
    },
    useState(initial) {
      const instance = runtime.current
      const index = instance.index++
      if (!(index in instance.hooks)) instance.hooks[index] = typeof initial === 'function' ? initial() : initial
      const setValue = (next) => {
        const previous = instance.hooks[index]
        const value = typeof next === 'function' ? next(previous) : next
        if (Object.is(value, previous)) return
        instance.hooks[index] = value
        runtime.dirty = true
      }
      return [instance.hooks[index], setValue]
    },
    useRef(initial) {
      const instance = runtime.current
      const index = instance.index++
      if (!(index in instance.hooks)) instance.hooks[index] = { current: initial }
      return instance.hooks[index]
    },
    useMemo(factory, deps) {
      const instance = runtime.current
      const index = instance.index++
      const previous = instance.hooks[index]
      if (previous !== undefined && sameDeps(previous.deps, deps)) return previous.value
      const value = factory()
      instance.hooks[index] = { value, deps }
      return value
    },
    useCallback(fn, deps) {
      const instance = runtime.current
      const index = instance.index++
      const previous = instance.hooks[index]
      if (previous !== undefined && sameDeps(previous.deps, deps)) return previous.fn
      instance.hooks[index] = { fn, deps }
      return fn
    },
    useEffect(fn, deps) {
      const instance = runtime.current
      const index = instance.index++
      const previous = instance.hooks[index]
      if (previous !== undefined && sameDeps(previous.deps, deps)) return
      instance.hooks[index] = { deps, cleanup: previous === undefined ? undefined : previous.cleanup }
      instance.pending.push({ index, fn })
    },
    memo(fn) { return fn },
  }
  runtime.React = React

  const renderNode = (node, path) => {
    if (node === null || node === undefined || typeof node === 'boolean') return
    if (typeof node === 'string' || typeof node === 'number') {
      runtime.textParts.push(String(node))
      return
    }
    if (Array.isArray(node)) {
      node.forEach((child, index) => renderNode(child, path + '.' + index))
      return
    }
    if (typeof node !== 'object' || node.type === undefined) return
    if (node.type === React.Fragment) {
      renderNode(node.children, path + '.f')
      return
    }
    if (typeof node.type === 'function') {
      const name = node.type.name === '' ? 'anonymous' : node.type.name
      const key = path + ':' + name
      let instance = runtime.instances.get(key)
      if (instance === undefined) {
        instance = { key, index: 0, hooks: [], pending: [] }
        runtime.instances.set(key, instance)
      }
      instance.index = 0
      instance.pending = []
      const previous = runtime.current
      runtime.current = instance
      let output
      try {
        output = node.type({ ...node.props, children: node.children.length === 1 ? node.children[0] : node.children })
      } finally {
        runtime.current = previous
      }
      renderNode(output, path + '>' + name)
      return
    }
    runtime.elements.push(node)
    renderNode(node.children, path)
  }

  runtime.render = () => {
    let passes = 0
    do {
      passes += 1
      if (passes > 50) throw new Error('hook runtime did not settle')
      runtime.dirty = false
      runtime.elements = []
      runtime.textParts = []
      renderNode(runtime.root, 'root')
      for (const instance of runtime.instances.values()) {
        const pending = instance.pending
        instance.pending = []
        for (const effect of pending) {
          const slot = instance.hooks[effect.index]
          if (slot !== undefined && typeof slot.cleanup === 'function') slot.cleanup()
          const cleanup = effect.fn()
          if (slot !== undefined) slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined
        }
      }
    } while (runtime.dirty)
  }

  /** Let scripted fetches / the watch loop settle, re-rendering on state changes. */
  runtime.flush = async () => {
    for (let tick = 0; tick < 30; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (runtime.dirty) runtime.render()
    }
  }
  runtime.text = () => runtime.textParts.join(' ')

  return runtime
}

/** Raw text of an element tree WITHOUT executing function components. */
function rawText(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (Array.isArray(node)) return node.map(rawText).join(' ')
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (typeof node !== 'object') return ''
  return rawText(node.children)
}

function clickNav(runtime, label) {
  const button = runtime.elements.find((element) => {
    const className = element.props.className
    return typeof element.props.onClick === 'function'
      && typeof className === 'string'
      && className.startsWith('gwc-navBtn')
      && rawText(element).includes(label)
  })
  assert.ok(button !== undefined, 'nav button for ' + label)
  button.props.onClick()
}

/**
 * Scripted host: snapshot head/subject are mutable, `log` returns the current
 * head as one commit, `watch` parks until the test resolves it ("the repository
 * changed"). No timers are used, so a pending watch promise cannot leak.
 */
function makeFixture() {
  const state = {
    head: 'a'.repeat(40),
    subject: 'before pull',
    logCalls: 0,
    branchCalls: 0,
    failLog: false,
    watchResolvers: [],
    /* Sync state the toolbar dots read. Mutated per test via setSync(). */
    ahead: 0,
    behind: 0,
    upstream: 'origin/main',
    detached: false,
  }
  const reply = (body) => ({ status: 200, json: async () => body })
  const snapshot = () => ({
    root: 'D:\\repo',
    head: state.head,
    headShort: state.head.slice(0, 7),
    unborn: false,
    branch: 'main',
    detached: state.detached,
    upstream: state.upstream,
    ahead: state.ahead,
    behind: state.behind,
    changes: [],
    operation: null,
    conflictedFiles: [],
    gitDir: null,
    refreshIntervalMs: 5000,
    defaultDiffView: 'unified',
    truncated: false,
  })
  const fetchStub = (url) => {
    const method = String(url).split('/').pop()
    if (method === 'snapshot') return Promise.resolve(reply({ ok: true, data: snapshot() }))
    if (method === 'watch') {
      return new Promise((resolve) => {
        state.watchResolvers.push((result) => resolve(reply({ ok: true, data: result })))
      })
    }
    if (method === 'log') {
      state.logCalls += 1
      if (state.failLog) {
        return Promise.resolve(reply({ ok: false, error: { code: 'network', message: 'transient git failure' } }))
      }
      return Promise.resolve(reply({
        ok: true,
        data: {
          commits: [{
            hash: state.head,
            short: state.head.slice(0, 7),
            subject: state.subject,
            parents: [],
            refs: [],
            authorName: 'tester',
            authorTime: 0,
          }],
          hasMore: false,
        },
      }))
    }
    if (method === 'branches') {
      state.branchCalls += 1
      return Promise.resolve(reply({ ok: true, data: { branches: [] } }))
    }
    return Promise.resolve(reply({ ok: true, data: {} }))
  }
  state.resolveWatch = (result) => {
    const resolvers = state.watchResolvers
    state.watchResolvers = []
    for (const resolve of resolvers) resolve(result)
  }
  /**
   * Resolve the pending watch AFTER making sure one is actually parked.
   *
   * The watch loop starts from an effect and then awaits a fetch; a test that
   * resolved "the repository changed" too early found zero listeners, the event
   * was dropped, and the assertion failed — but only when the surrounding tests
   * happened to make the loop slower. Waiting for the parked request removes the
   * race instead of making the assertion looser.
   */
  state.waitForWatch = async (flush, result) => {
    for (let attempt = 0; attempt < 40 && state.watchResolvers.length === 0; attempt += 1) {
      await flush()
    }
    assert.ok(state.watchResolvers.length > 0, 'the watch long-poll is parked and waiting')
    state.resolveWatch(result)
  }
  return { state, fetch: fetchStub }
}

/** Turn a snapshot fixture into a handable state for the dot tests. */
function setSync(state, { ahead, behind, upstream, detached }) {
  state.ahead = ahead === undefined ? 0 : ahead
  state.behind = behind === undefined ? 0 : behind
  if (upstream !== undefined) state.upstream = upstream
  if (detached !== undefined) state.detached = detached
}

/** The dot badges that actually RENDERED, in header order. */
function renderedDots(runtime) {
  const dots = []
  for (const element of runtime.elements) {
    if (element.props.className !== 'gwc-dot') continue
    /* Which button owns it: walk up through the collected elements by identity. */
    const owner = runtime.elements.find((candidate) =>
      typeof candidate.props.className === 'string'
      && candidate.props.className.startsWith('gwc-iconBtn')
      && (candidate.children ?? []).some((child) => child === element))
    dots.push(owner === undefined ? '?' : (owner.props['aria-label'] || ''))
  }
  return dots
}

/** Mount the registered page with the hook runtime. */
async function mountPanel() {
  const fixture = makeFixture()
  const runtime = makeHookReact()
  const dock = { pages: [], registerPage(page) { this.pages.push(page); return () => {} }, list() { return this.pages }, subscribe() { return () => {} } }
  const booted = boot({ betterSidebar: undefined, native: undefined, dock, react: () => runtime.React, fetch: fixture.fetch })
  runtime.root = dock.pages[0].component({ ctx: booted.ctx, sessionId: 's1', cwd: 'D:\\repo' })
  runtime.render()
  await runtime.flush()
  return { fixture, runtime }
}

test('History reloads when the watched revision moves while it is active', async () => {
  const { fixture, runtime } = await mountPanel()
  /* Nothing is fetched eagerly: History is not the active view. */
  assert.equal(fixture.state.logCalls, 0, 'History must not load while inactive')

  clickNav(runtime, 'History')
  await runtime.flush()
  assert.equal(fixture.state.logCalls, 1, 'activation loads the commit list once')
  assert.match(runtime.text(), /before pull/)

  /* A pull / external commit moves HEAD; the long-poll reports it. */
  fixture.state.head = 'b'.repeat(40)
  fixture.state.subject = 'after pull'
  await fixture.state.waitForWatch(runtime.flush, { supported: true, revision: 1, changed: true, root: 'D:\\repo' })
  await runtime.flush()
  assert.equal(fixture.state.logCalls, 2, 'exactly one reload for the new revision')
  assert.match(runtime.text(), /after pull/, 'the commit list shows the new HEAD')
  assert.doesNotMatch(runtime.text(), /before pull/)

  /* The same revision reported again must NOT reload (burst coalescing). */
  await fixture.state.waitForWatch(runtime.flush, { supported: true, revision: 2, changed: true, root: 'D:\\repo' })
  await runtime.flush()
  assert.equal(fixture.state.logCalls, 2, 'a repeated revision does not reload')
})

test('an inactive History view reloads lazily on activation, and so do branches', async () => {
  const { fixture, runtime } = await mountPanel()

  fixture.state.head = 'c'.repeat(40)
  fixture.state.subject = 'pulled while on Changes'
  await fixture.state.waitForWatch(runtime.flush, { supported: true, revision: 1, changed: true, root: 'D:\\repo' })
  await runtime.flush()
  assert.equal(fixture.state.logCalls, 0, 'no eager fetch while History is inactive')
  assert.equal(fixture.state.branchCalls, 0, 'no eager fetch while Branches is inactive')

  clickNav(runtime, 'History')
  await runtime.flush()
  assert.equal(fixture.state.logCalls, 1, 'activation picks up the missed revision')
  assert.match(runtime.text(), /pulled while on Changes/)

  clickNav(runtime, 'Branches')
  await runtime.flush()
  assert.equal(fixture.state.branchCalls, 1, 'the branch/tag list refreshes on activation')
})

test('a failed History reload keeps the previous commits and shows the error', async () => {
  const { fixture, runtime } = await mountPanel()
  clickNav(runtime, 'History')
  await runtime.flush()
  assert.equal(fixture.state.logCalls, 1)
  assert.match(runtime.text(), /before pull/)

  fixture.state.failLog = true
  fixture.state.head = 'd'.repeat(40)
  fixture.state.subject = 'never rendered'
  await fixture.state.waitForWatch(runtime.flush, { supported: true, revision: 1, changed: true, root: 'D:\\repo' })
  await runtime.flush()
  assert.equal(fixture.state.logCalls, 2, 'the revision triggered a reload attempt')
  assert.match(runtime.text(), /before pull/, 'the previous list is kept on failure')
  assert.doesNotMatch(runtime.text(), /never rendered/)
  assert.match(runtime.text(), /transient git failure/, 'the existing error toast is shown')

  /* A failed revision is not retried in a loop. */
  await runtime.flush()
  assert.equal(fixture.state.logCalls, 2, 'no retry storm after a failed reload')
})

/* ------------------------------- rendered toolbar dots (real React tree) */

test('nothing is in sync yet -> neither Pull nor Push shows a dot', async () => {
  const { runtime } = await mountPanel()
  assert.deepEqual(renderedDots(runtime), [], 'a fully synced branch shows no dots')
})

test('an unpushed commit lights ONLY Push', async () => {
  const { fixture, runtime } = await mountPanel()
  setSync(fixture.state, { ahead: 2, behind: 0 })
  await fixture.state.waitForWatch(runtime.flush, { supported: true, revision: 1, changed: true, root: 'D:\\repo' })
  await runtime.flush()

  const dots = renderedDots(runtime)
  assert.equal(dots.length, 1, 'exactly one dot: ' + JSON.stringify(dots))
  assert.match(dots[0], /Push|推送/, 'the dot belongs to Push, got ' + JSON.stringify(dots))
})

test('a remote-only update lights ONLY Pull', async () => {
  const { fixture, runtime } = await mountPanel()
  setSync(fixture.state, { ahead: 0, behind: 3 })
  await fixture.state.waitForWatch(runtime.flush, { supported: true, revision: 1, changed: true, root: 'D:\\repo' })
  await runtime.flush()

  const dots = renderedDots(runtime)
  assert.equal(dots.length, 1, 'exactly one dot: ' + JSON.stringify(dots))
  assert.match(dots[0], /Pull|拉取/, 'the dot belongs to Pull, got ' + JSON.stringify(dots))
})

test('a diverged branch lights BOTH dots', async () => {
  const { fixture, runtime } = await mountPanel()
  setSync(fixture.state, { ahead: 1, behind: 1 })
  await fixture.state.waitForWatch(runtime.flush, { supported: true, revision: 1, changed: true, root: 'D:\\repo' })
  await runtime.flush()

  const dots = renderedDots(runtime)
  assert.equal(dots.length, 2, 'both directions are pending: ' + JSON.stringify(dots))
  assert.ok(dots.some((label) => /Push|推送/.test(label)), JSON.stringify(dots))
  assert.ok(dots.some((label) => /Pull|拉取/.test(label)), JSON.stringify(dots))
})

test('the dot disappears again once the push lands (no stale badge)', async () => {
  const { fixture, runtime } = await mountPanel()
  setSync(fixture.state, { ahead: 1 })
  await fixture.state.waitForWatch(runtime.flush, { supported: true, revision: 1, changed: true, root: 'D:\\repo' })
  await runtime.flush()
  assert.equal(renderedDots(runtime).length, 1)

  setSync(fixture.state, { ahead: 0 })
  await fixture.state.waitForWatch(runtime.flush, { supported: true, revision: 2, changed: true, root: 'D:\\repo' })
  await runtime.flush()
  assert.deepEqual(renderedDots(runtime), [], 'a synced branch has no dots')
})

test('a detached HEAD never lights Push (nothing to compare against)', async () => {
  const { fixture, runtime } = await mountPanel()
  setSync(fixture.state, { ahead: 4, detached: true, upstream: null })
  await fixture.state.waitForWatch(runtime.flush, { supported: true, revision: 1, changed: true, root: 'D:\\repo' })
  await runtime.flush()

  const dots = renderedDots(runtime)
  assert.equal(dots.some((label) => /Push|推送/.test(label)), false,
    'a detached HEAD cannot push a branch, so it must not advertise one: ' + JSON.stringify(dots))
})

