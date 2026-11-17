/**
 * dsh-workbay-dock — client half (v0.2, GLOBAL dock).
 *
 * ONE entry in the LEFT sidebar — the `sidebar.panellist` seat that "插件 / 自动化
 * 任务 / 更多" sit in — with `sidebar.footer.action` as the fallback for host
 * compositions that do not render that row. Clicking it opens a GLOBAL overlay
 * window that belongs to this plugin alone.
 *
 * Why an overlay and not the right sidebar:
 *   DSH's right sidebar is SESSION-SCOPED — its layout lives in
 *   `state.bySession[sessionId]`, so a pane opened there exists once per
 *   conversation. The dock is meant to be ONE shared surface (the same Git
 *   repositories, the same Downloader session) across every conversation, so it
 *   owns its own overlay instead: one DOM node, one open/closed flag, no
 *   sessionId anywhere in its own state.
 *
 * Pages are contributed by other plugins through one browser global:
 *
 *   window.__DSH_WORKBAY__.registerPage({
 *     id: 'gitcraft', title: 'GitCraft', order: 20,
 *     component: ({ t }) => <MyPanel />,
 *   })
 *
 * Nothing here depends on dsh-better-sidebar.
 */
window.__ModuleLoader__.load({
  id: 'dsh-workbay-dock',
  factory: (require) => {
    const React = require('react')
    const E = React.createElement
    const useState = React.useState
    const useEffect = React.useEffect
    const useMemo = React.useMemo
    const useCallback = React.useCallback
    const useRef = React.useRef

    const GLOBAL_KEY = '__DSH_WORKBAY__'
    const STORAGE_OPEN = 'dsh-workbay-dock.open.v1'
    const STORAGE_PAGE = 'dsh-workbay-dock.page.v1'
    const STORAGE_GEOM = 'dsh-workbay-dock.geom.v1'
    /* Default UI scale for the workbench panel (no settings UI; 110% is the
       comfortable default for the 12-13px page text). */
    const WORKBENCH_ZOOM = (() => {
      try {
        const raw = window.localStorage.getItem('dsh-workbay.zoom.v1')
        const value = raw === null ? Number.NaN : Number(raw)
        return Number.isFinite(value) && value >= 0.8 && value <= 1.5 ? value : 1.1
      } catch (error) {
        void error
        return 1.1
      }
    })()
    const STORAGE_MODE = 'dsh-workbay-dock.mode.v1'
    const STORAGE_DOCK_W = 'dsh-workbay-dock.dockw.v1'
    const LOCALE_NS = 'dsh-workbay-dock'

    /* Load-meter thresholds.
       The authoritative copy lives in the host half (`src/load.js` exports
       WARN_PCT / HOT_PCT). This bundle is loaded as a self-contained string
       through `window.__ModuleLoader__` and cannot import a Node module, so the
       values are mirrored here; client.test.mjs reads both sources and fails if
       they ever drift apart. Do not introduce a THIRD copy. */
    const METER_WARN_PCT = 90
    const METER_HOT_PCT = 95
    const METER_POLL_MS = 5000
    const METER_RETRY_MS = 1500

    /* ============================== i18n ============================== */

    const ZH = {
      'button.label': '工作台',
      'button.tooltip': '打开工作台（全局共用，与当前会话无关）',
      'pane.title': '工作台',
      'pane.empty': '还没有注册任何页面',
      'pane.emptyHint': '插件通过 window.__DSH_WORKBAY__.registerPage 注册页面后，会出现在这里。',
      'pane.global': '全局面板 · 与当前会话无关',
      'pane.close': '关闭',
      'pane.restart': '重启工作台',
      'pane.restarting': '重启中…',
      'pane.restartConfirm': '重启工作台会重新加载工作台插件并刷新整个 DSH 页面；会话不会丢失，但工作台的页签和临时界面状态会重置。继续？',
      'pane.restartUnavailable': '当前 DSH 没有启用 HMR，无法在不重启 DSH 的情况下重载宿主代码；请完整重启 DSH。',
      'pane.restartFailed': '重启请求失败：',
      'pane.minimize': '收起',
      'pane.resize': '拖动调整大小',
      'pane.docked': '已停靠右侧 · 与会话并排',
      'pane.dock': '停靠到右侧',
      'pane.float': '改为浮动窗口',
      'ctx.none': '未选择工作区',
      'ctx.noPath': '工作区路径未提供 — 在源码管理里选择一个目录',
      'ctx.branch': '当前分支（由页面提供）',
      'ctx.changes': '变更',
      'status.noPage': '无页面',
      'layoutGroup': '布局',
      'layoutTooNarrow': '当前窗口不够宽',
      'layout.auto': '自动（跟随面板宽度）',
      'layout.single': '单栏',
      'layout.split': '主从双栏',
      'layout.tri': '三栏',
      'load.title': '本机负载',
      /* The three metric words stay in ASCII in every locale, on request: they
         are the conventional labels for these numbers, and 处理器 / 显卡 / 内存
         made the row wider without being any clearer. */
      'load.cpu': 'CPU',
      'load.gpu': 'GPU',
      'load.mem': 'MEM',
      'load.noGpu': '未检测到 NVIDIA 显卡（只显示 CPU / 内存）',
      'load.offline': '读不到宿主负载接口',
    }

    const EN = {
      'button.label': 'Workbench',
      'button.tooltip': 'Open the workbench (global, independent of the session)',
      'pane.title': 'Workbench',
      'pane.empty': 'No pages registered yet',
      'pane.emptyHint': 'A plugin appears here after calling window.__DSH_WORKBAY__.registerPage.',
      'pane.global': 'Global panel · independent of the current session',
      'pane.close': 'Close',
      'pane.restart': 'Restart workbench',
      'pane.restarting': 'Restarting…',
      'pane.restartConfirm': 'Restarting the workbench reloads its plugins and the whole DSH page. The session is kept, but workbench tabs and temporary UI state are reset. Continue?',
      'pane.restartUnavailable': 'HMR is not enabled in this DSH, so host code cannot be reloaded without a full DSH restart.',
      'pane.restartFailed': 'Restart request failed: ',
      'pane.minimize': 'Collapse',
      'pane.resize': 'Drag to resize',
      'pane.docked': 'Docked beside the conversation',
      'pane.dock': 'Dock to the right',
      'pane.float': 'Float as a window',
      'ctx.none': 'No workspace',
      'ctx.noPath': 'No workspace path yet — pick a folder in Source control',
      'ctx.branch': 'Current branch (reported by the page)',
      'ctx.changes': 'changes',
      'status.noPage': 'No page',
      'layoutGroup': 'Layout',
      'layoutTooNarrow': 'window is too narrow',
      'layout.auto': 'Auto (follow the panel width)',
      'layout.single': 'Single column',
      'layout.split': 'Master-detail',
      'layout.tri': 'Three columns',
      'load.title': 'Machine load',
      /* CPU / GPU / MEM in every locale — see the ZH note above. */
      'load.cpu': 'CPU',
      'load.gpu': 'GPU',
      'load.mem': 'MEM',
      'load.noGpu': 'No NVIDIA GPU detected (CPU / RAM only)',
      'load.offline': 'Host load endpoint unreachable',
    }

    const LOCALES = { en: EN }

    function hasOwnKey(object, key) {
      return object !== null && object !== undefined && Object.prototype.hasOwnProperty.call(object, key)
    }

    function activeLocaleOf(ctx) {
      let active = ''
      try {
        const locale = ctx === undefined ? undefined : ctx.get('locale')
        if (locale !== undefined && typeof locale.getSnapshot === 'function') {
          const snapshot = locale.getSnapshot()
          if (snapshot !== null && typeof snapshot === 'object' && typeof snapshot.active === 'string') active = snapshot.active
        }
      } catch (error) { void error }
      if (active === '' && typeof navigator === 'object' && navigator !== null && typeof navigator.language === 'string') {
        active = navigator.language
      }
      return active
    }

    function dictionaryFor(active) {
      const raw = active === undefined || active === null || active === '' ? 'en' : String(active)
      const tag = raw.toLowerCase().replace(/_/g, '-')
      if (tag.split('-')[0] === 'zh') return ZH
      if (hasOwnKey(LOCALES, tag.split('-')[0])) return LOCALES[tag.split('-')[0]]
      return EN
    }

    function translatorOf(ctx) {
      let cachedTag = null
      let cachedDict = null
      return (key) => {
        const tag = activeLocaleOf(ctx)
        if (tag !== cachedTag) {
          cachedTag = tag
          cachedDict = dictionaryFor(tag)
        }
        if (hasOwnKey(cachedDict, key)) return cachedDict[key]
        return hasOwnKey(EN, key) ? EN[key] : key
      }
    }

    /* ============================== storage ============================== */

    function readJson(key) {
      try {
        const raw = window.localStorage.getItem(key)
        if (raw === null || raw === '') return null
        const parsed = JSON.parse(raw)
        return parsed !== null && typeof parsed === 'object' ? parsed : null
      } catch {
        return null
      }
    }

    function writeJson(key, value) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value))
      } catch {
        void 0
      }
    }

    function readFlag(key, fallback) {
      try {
        const raw = window.localStorage.getItem(key)
        if (raw === null || raw === '') return fallback
        return raw === '1' || raw === 'true'
      } catch {
        return fallback
      }
    }

    function writeFlag(key, value) {
      try {
        window.localStorage.setItem(key, value ? '1' : '0')
      } catch {
        void 0
      }
    }

    /* ============================== row hit-testing ============================== */

    /**
     * The row element that owns an entry: the closest BUTTON at or above the
     * entry's PARENT — starting at the parent is what skips the entry itself,
     * which carries role="button" and would otherwise match its own 28px span.
     */
    function rowOfEntry(own) {
      if (own === null || own === undefined) return null
      const parent = own.parentElement
      if (parent === null) return null
      const found = parent.closest('button, [class*="panelRow"], li')
      if (found === null) return null
      /* Never treat the whole app shell as the row. */
      if (found === document.body || found === document.documentElement) return null
      return found
    }

    /** True when a click on `target` should act as a click on the entry's row. */
    function isEntryRowHit(target, own, row) {
      if (!(target instanceof Node) || own === null || own === undefined) return false
      if (own.contains(target)) return true
      return row !== null && row !== undefined && row.contains(target)
    }

    /* ============================== dock preferences ============================== */

    function readMode() {
      try {
        const raw = window.localStorage.getItem(STORAGE_MODE)
        return raw === 'float' ? 'float' : 'docked'
      } catch {
        return 'docked'
      }
    }

    function writeMode(mode) {
      try { window.localStorage.setItem(STORAGE_MODE, mode) } catch (error) { void error }
    }

    function readDockWidth() {
      try {
        const raw = window.localStorage.getItem(STORAGE_DOCK_W)
        const value = raw === null ? Number.NaN : Number(raw)
        return Number.isFinite(value) && value >= 360 ? value : 620
      } catch {
        return 620
      }
    }

    function writeDockWidth(width) {
      try { window.localStorage.setItem(STORAGE_DOCK_W, String(width)) } catch (error) { void error }
    }

    /* ============================== shell: tiers & layout ============================== */

    /* These four helpers mirror @dsh-workbay/kit/src/ui.js (the canonical copy,
       pinned by unit tests). They are duplicated rather than imported because a
       client half is ONE self-contained file: `window.__ModuleLoader__.load`
       gives it no module system, so `import` is simply not available here.

       The PANEL's own width decides the tier — never `window.innerWidth`. The
       panel can be docked at 620px inside a 1920px viewport, floated at 1100px,
       or scaled by WORKBENCH_ZOOM, so a media query would answer the wrong
       question. */
    const STORAGE_LAYOUT = 'dsh-workbay-dock.layout.v1'
    const TIER_MIN_WIDTH = { t2: 680, t3: 980, t4: 1280 }
    const LAYOUT_MODES = ['auto', 'single', 'split', 'tri']
    const LAYOUT_LABEL = { auto: '自动', single: '单栏', split: '双栏', tri: '三栏' }

    /**
     * Ctrl+E (Cmd+E on macOS) toggles the workbench panel.
     *
     * Pure predicate so the binding is unit-tested instead of only exercised by a
     * real key press: no repeat, no modifiers beyond the command key, and the
     * layout of the event is exactly what a keyboard leaves behind.
     */
    function isWorkbenchShortcut(event) {
      if (event === null || event === undefined || typeof event !== 'object') return false
      if (event.repeat === true) return false
      if (event.altKey === true || event.shiftKey === true) return false
      if (event.ctrlKey !== true && event.metaKey !== true) return false
      const key = typeof event.key === 'string' ? event.key.toLowerCase() : ''
      return key === 'e'
    }
    /* 点「单栏/双栏/三栏」不只是换排版：面板宽度也要跟到位，否则在窄面板上点
       「三栏」只会得到三栏档位却渲染成单列的怪状态。取各档位的最小可用宽度。 */
    const LAYOUT_TARGET_WIDTH = { single: 660, split: 1000, tri: 1320 }
    const TIER_LABEL = { t1: '紧凑', t2: '标准', t3: '宽', t4: '超宽' }
    /** Empty context: pages fill this in through `dock.setContext`. */
    const EMPTY_CONTEXT = { path: '', name: '', branch: '', ahead: 0, behind: 0, changes: 0, status: '', statuses: {} }

    function tierForWidth(width) {
      const value = Number(width)
      if (Number.isFinite(value) === false || value <= 0) return 't1'
      if (value >= TIER_MIN_WIDTH.t4) return 't4'
      if (value >= TIER_MIN_WIDTH.t3) return 't3'
      if (value >= TIER_MIN_WIDTH.t2) return 't2'
      return 't1'
    }

    function normalizeLayoutMode(mode) {
      return LAYOUT_MODES.includes(mode) ? mode : 'auto'
    }

    /** `auto` follows the tier; a manual choice wins at every tier. */
    function resolveLayoutKind(tier, mode) {
      const chosen = normalizeLayoutMode(mode)
      if (chosen !== 'auto') return chosen
      if (tier === 't4') return 'tri'
      if (tier === 't3') return 'split'
      return 'single'
    }

    function readLayoutMode() {
      try {
        const raw = window.localStorage.getItem(STORAGE_LAYOUT)
        return normalizeLayoutMode(raw === null ? undefined : raw)
      } catch {
        return 'auto'
      }
    }

    function writeLayoutMode(mode) {
      const value = normalizeLayoutMode(mode)
      try { window.localStorage.setItem(STORAGE_LAYOUT, value) } catch (error) { void error }
      return value
    }


    /** Non-null, non-array object. Guards the optional `panes`/`commands` fields. */
    function isPlainObject(value) {
      return value !== null && value !== undefined && typeof value === 'object' && Array.isArray(value) === false
    }

    /* ============================== page registry ============================== */

    function createRegistry() {
      const entries = new Map()
      const listeners = new Set()
      const notify = () => { for (const listener of [...listeners]) { try { listener() } catch (error) { void error } } }
      /* The workbench CONTEXT: one workspace shared by every page. Pages push it
         (they are the ones that know the repo/branch/device); the shell renders it
         as the always-visible context bar. Kept here rather than in React state so
         a page that registers before the overlay mounts still lands its context. */
      const contextListeners = new Set()
      /* Esc「返回上一级」的页面栈：每个页面注册一个「退一层」回调，返回 true
         表示这一层吃掉了 Esc；外壳只在没人处理时才关闭面板。 */
      const backHandlers = new Map()
      let contextState = { ...EMPTY_CONTEXT }
      const notifyContext = () => {
        for (const listener of [...contextListeners]) { try { listener({ ...contextState }) } catch (error) { void error } }
      }
      return {
        registerPage(page) {
          if (page === null || typeof page !== 'object') throw new Error('registerPage needs a page object')
          const id = typeof page.id === 'string' ? page.id.trim() : ''
          if (id === '') throw new Error('registerPage needs a non-empty id')
          if (typeof page.component !== 'function') throw new Error('registerPage needs a component')
          entries.set(id, {
            id,
            title: typeof page.title === 'string' && page.title !== '' ? page.title : id,
            /* 窄栏（rail 60px）放不下长标题：「Downloader」会被截成「Downloa…」。
               短名只用于 rail，pill 与状态栏仍显示完整标题。 */
            short: typeof page.short === 'string' && page.short !== '' ? page.short : undefined,
            order: Number.isFinite(page.order) ? page.order : 100,
            component: page.component,
            icon: typeof page.icon === 'function' ? page.icon : undefined,
            /* OPTIONAL embedding surface. A page that wants to be composed into
               ANOTHER page (rather than shown as its own tab) publishes mounted
               panes plus the commands a host may call. Purely additive: a page
               that omits both fields behaves exactly as before.
               See `panes` below and docs/panes-contract.md. */
            panes: isPlainObject(page.panes) ? page.panes : undefined,
            commands: isPlainObject(page.commands) ? page.commands : undefined,
            /* Retirement switches, both optional:
               `hidden: true` keeps a page out of the tab strip immediately;
               `supersededBy: '<pageId>'` keeps it visible until that page
               registers, then hides it. The second form is what makes "ship the
               new page, retire the old one, keep rollback free" a one-line
               change — the old page stays registered and callable by id. */
            hidden: page.hidden === true,
            supersededBy: typeof page.supersededBy === 'string' && page.supersededBy !== '' ? page.supersededBy : undefined,
          })
          notify()
          return () => { entries.delete(id); notify() }
        },
        list() {
          return [...entries.values()]
            /* A page may declare itself superseded by another page. We keep it
               registered (so a rollback needs no rebuild) but hide it once the
               replacement is actually present — that is what makes retiring a
               page a one-line change instead of an uninstall. */
            .filter((page) => page.supersededBy === undefined || entries.has(page.supersededBy) === false)
            .filter((page) => page.hidden !== true)
            .sort((a, b) => (a.order === b.order ? a.id.localeCompare(b.id) : a.order - b.order))
        },
        /** Direct lookup that IGNORES the tab-visibility filters: a page that is
            hidden from the tab strip can still be composed by another page. */
        get(id) { return entries.get(id) },
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        /**
         * Publish the current workspace context (path / name / branch / counters).
         * MERGED, not replaced: a page that only knows the branch does not have to
         * re-send the path, and a page that says nothing cannot blank the bar.
         *
         * `status` is the page's own one-liner for the status bar (e.g. "烧录中 62%").
         */
        setContext(patch) {
          if (patch === null || typeof patch !== 'object') return { ...contextState, statuses: { ...contextState.statuses } }
          const next = { ...contextState }
          for (const key of Object.keys(EMPTY_CONTEXT)) {
            if (patch[key] === undefined) continue
            /* The per-page map is merged, never replaced: a patch that mentions
               one page must not wipe the other pages' status lines. */
            if (key === 'statuses') {
              next.statuses = { ...contextState.statuses, ...(patch.statuses !== null && typeof patch.statuses === 'object' ? patch.statuses : {}) }
            } else {
              next[key] = patch[key]
            }
          }
          contextState = next
          notifyContext()
          return { ...contextState, statuses: { ...contextState.statuses } }
        },
        getContext() { return { ...contextState, statuses: { ...contextState.statuses } } },
        /**
         * Per-page status line. The status bar shows the ACTIVE page's line in
         * place, and every other page's line as a clickable badge — that is how a
         * running burn stays visible while the user is reading code.
         *
         * `setContext({ status })` still works for the active page; this one is
         * attributed by page id, so a page cannot overwrite another page's line.
         */
        setStatus(pageId, text) {
          const id = typeof pageId === 'string' ? pageId.trim() : ''
          if (id === '') return { ...contextState, statuses: { ...contextState.statuses } }
          const statuses = { ...contextState.statuses }
          const value = typeof text === 'string' ? text.trim() : ''
          if (value === '') delete statuses[id]
          else statuses[id] = value
          contextState = { ...contextState, statuses }
          notifyContext()
          return { ...contextState, statuses: { ...statuses } }
        },
        subscribeContext(listener) {
          if (typeof listener !== 'function') return () => {}
          contextListeners.add(listener)
          return () => { contextListeners.delete(listener) }
        },
        /**
         * Register the active page's "go back one level" handler.
         *
         * Esc unwinds ONE level at a time: the page's dialog, then its modal, then
         * its detail pane, then its selection — only when nothing is left does the
         * workbench itself close. `null` clears the handler on unmount.
         */
        setBackHandler(pageId, handler) {
          const id = typeof pageId === 'string' ? pageId.trim() : ''
          if (id === '') return
          if (typeof handler === 'function') backHandlers.set(id, handler)
          else backHandlers.delete(id)
        },
        runBack(pageId) {
          const id = typeof pageId === 'string' ? pageId.trim() : ''
          const handler = backHandlers.get(id)
          if (handler === undefined) return false
          try { return handler() === true } catch (error) { return false }
        },
        /** Open/close the dock from anywhere (a page can call this itself). */
        open() { setOpen(true) },
        close() { setOpen(false) },
        toggle() { setOpen(!openState) },
        isOpen() { return openState === true },
      }
    }

    /* The open flag is module-level, NOT React state: it must survive a page
       remount and be readable from outside React (a page calling dock.close()). */
    let openState = false
    const openListeners = new Set()
    function setOpen(next) {
      const value = next === true
      if (value === openState) return
      openState = value
      writeFlag(STORAGE_OPEN, value)
      for (const listener of [...openListeners]) { try { listener(value) } catch (error) { void error } }
    }

    function useOpenFlag() {
      const [value, setValue] = useState(openState)
      useEffect(() => {
        const listener = (next) => setValue(next)
        openListeners.add(listener)
        /* adopt the persisted flag on first mount */
        if (openState === false && readFlag(STORAGE_OPEN, false) === true) setOpen(true)
        return () => { openListeners.delete(listener) }
      }, [])
      return value
    }

    /**
     * Install this bundle's registry at the shared global — WITHOUT replacing an
     * object a page plugin already created.
     *
     * The load order is not guaranteed in either direction, and a page plugin
     * creates a stub when the dock is not up yet. Replacing that object loses
     * every page already registered in it (they live in the stub's closure and
     * cannot be enumerated), and the page plugin will not register twice because
     * it saw a dock on its first try. So the dock ADOPTS the existing object and
     * grafts its own full surface onto it — one object, one `entries` map, both
     * bundles talking to the same thing.
     */
    function sharedRegistry() {
      const existing = typeof window === 'object' && window !== null ? window[GLOBAL_KEY] : undefined
      const own = createRegistry()
      if (existing !== undefined && existing !== null && typeof existing === 'object') {
        /* Keep the page plugin's entries map: it is the one furthest along. */
        const target = existing
        /* The dock's overlay must render from the SAME list the pages write to,
           so its reader is the existing object's list when that exists. */
        registrySource = typeof target.list === 'function' ? target : own
        /* Control surface is ours regardless of who created the object. */
        try {
          target.open = () => setOpen(true)
          target.close = () => setOpen(false)
          target.toggle = () => setOpen(!openState)
          target.isOpen = () => openState === true
          if (typeof target.registerPage !== 'function') target.registerPage = own.registerPage
          if (typeof target.list !== 'function') target.list = () => own.list()
          if (typeof target.subscribe !== 'function') target.subscribe = own.subscribe
          /* The context bus must be reachable from the SAME object a page sees,
             whichever bundle created it first. A stub created by a page has no
             context API, so the dock grafts its own here — same rule as above. */
          if (typeof target.setContext !== 'function') target.setContext = own.setContext
          if (typeof target.getContext !== 'function') target.getContext = own.getContext
          if (typeof target.setStatus !== 'function') target.setStatus = own.setStatus
          if (typeof target.subscribeContext !== 'function') target.subscribeContext = own.subscribeContext
          if (typeof target.setBackHandler !== 'function') target.setBackHandler = own.setBackHandler
          if (typeof target.runBack !== 'function') target.runBack = own.runBack
        } catch (error) { void error }
        /* Bridge: a page registered through the dock's own API lands in the
           object the overlay reads. */
        const pageSubscribe = typeof target.subscribe === 'function' ? target.subscribe.bind(target) : own.subscribe
        registryBridge = pageSubscribe
        return target
      }
      registrySource = own
      registryBridge = own.subscribe
      if (typeof window === 'object' && window !== null) {
        try {
          Object.defineProperty(window, GLOBAL_KEY, { value: own, configurable: true, writable: true })
        } catch (error) {
          window[GLOBAL_KEY] = own
        }
      }
      return own
    }

    /* Which object the overlay reads its page list from, and which one it
       subscribes to. Both point at the SAME object as the global — that identity
       is the whole point; a mismatch is what made the overlay say "no pages"
       while `list()` reported one. */
    const fallbackTimers = []
    const fallbackDisposers = []

    /** Set by the entry's first mount; drives the fallback decision. */
    let entryMountedFlag = false

    let registrySource = null
    let registryBridge = null

    /**
     * `react-dom/client` from the plugin's own module scope.
     *
     * The loader's `require` seed table exposes the shell's React; ReactDOM's
     * client entry may live under either specifier depending on the host build,
     * so both are tried and a miss returns null instead of throwing at load
     * (the footer button still works; only the overlay needs this).
     */
    function requireReactDom() {
      for (const name of ['react-dom/client', 'react-dom']) {
        try {
          const mod = require(name)
          if (mod !== null && mod !== undefined && typeof mod.createRoot === 'function') return mod
          if (mod !== null && mod !== undefined && mod.default !== undefined && typeof mod.default.createRoot === 'function') return mod.default
        } catch (error) { void error }
      }
      return null
    }
    const registry = sharedRegistry()

    /**
     * Read the page roster and stay in sync with it.
     *
     * Subscription alone is not enough: a page plugin may register into the
     * global BEFORE this bundle's registry object exists (or before its own
     * pply re-binds), and a subscriber misses that earlier write forever —
     * which is why the overlay sat at "no pages" while the global reported one.
     * A low-frequency re-read (250 ms) makes the overlay converge regardless of
     * load order, and the subscription keeps the common case instant.
     */
    function usePages() {
      const [pages, setPages] = useState(() => listPages())
      useEffect(() => {
        let cancelled = false
        const sync = () => {
          if (cancelled) return
          const next = listPages()
          setPages((previous) => {
            if (previous.length === next.length && previous.every((page, index) => page.id === next[index].id)) return previous
            return next
          })
        }
        sync()
        const source = registrySource === null ? registry : registrySource
        let off = null
        if (source !== null && typeof source.subscribe === 'function') {
          try { off = source.subscribe(sync) } catch (error) { void error }
        }
        const timer = setInterval(sync, 250)
        return () => {
          cancelled = true
          clearInterval(timer)
          if (typeof off === 'function') { try { off() } catch (error) { void error } }
        }
      }, [])
      return pages
    }

    /** One read of the roster, from whichever object currently owes it. */
    function listPages() {
      const source = registrySource === null ? registry : registrySource
      if (source === null || source === undefined || typeof source.list !== 'function') return []
      try {
        const list = source.list()
        return Array.isArray(list) ? list : []
      } catch (error) {
        return []
      }
    }

    /* --- the workbench context: published by pages, rendered by the shell --- */

    function readContext() {
      const source = registrySource === null ? registry : registrySource
      try {
        if (source !== null && typeof source.getContext === 'function') {
          const value = source.getContext()
          if (value !== null && typeof value === 'object') {
            return { ...EMPTY_CONTEXT, ...value, statuses: { ...(value.statuses !== null && typeof value.statuses === 'object' ? value.statuses : {}) } }
          }
        }
      } catch (error) { void error }
      return { ...EMPTY_CONTEXT, statuses: {} }
    }

    function useWorkbenchContext() {
      const [value, setValue] = useState(() => readContext())
      useEffect(() => {
        const source = registrySource === null ? registry : registrySource
        if (source === null || source === undefined || typeof source.subscribeContext !== 'function') return undefined
        let off = null
        try { off = source.subscribeContext((next) => setValue({ ...EMPTY_CONTEXT, ...next, statuses: { ...(next !== null && next !== undefined && typeof next.statuses === 'object' ? next.statuses : {}) } })) } catch (error) { void error }
        /* Adopt whatever was published before this mount: the subscription only
           sees writes that happen AFTER it, and pages register before the overlay
           renders. */
        setValue(readContext())
        return () => { if (typeof off === 'function') { try { off() } catch (error) { void error } } }
      }, [])
      return value
    }

    /* ============================== titlebar load meter ============================== */

    /**
     * Poll the host sampler and hold the latest reading.
     *
     * Sampling discipline (this is the whole point of the component):
     *   - only while the panel is MOUNTED — mounting happens after the shell's
     *     `if (!isOpen) return null`, so closing the workbench unmounts us and
     *     the interval dies with the component;
     *   - only while the window is VISIBLE and FOCUSED — the guard sits before
     *     the request, so a backgrounded DSH spawns nothing;
     *   - one retry 1.5s later if the host answers `cpu: null`, because the very
     *     first sample has no tick baseline to difference against. `retried`
     *     makes that retry once-only instead of a tight loop.
     */
    function useLoadMeter() {
      const [reading, setReading] = useState({ cpu: null, gpu: null, mem: null, err: '' })
      const retried = useRef(false)

      useEffect(() => {
        let alive = true
        let retryTimer = null
        let inFlight = false

        const tick = async () => {
          if (typeof document !== 'undefined' && document.hidden) return
          if (typeof document !== 'undefined' && typeof document.hasFocus === 'function' && !document.hasFocus()) return
          /* One request at a time. Two overlapping ticks would be differenced over
             a ~0ms window by the host's CPU reader, which yields a bogus 0/100 or
             a spurious "—"; the GPU side has its own gate, CPU does not. */
          if (inFlight === true) return
          inFlight = true
          try {
            const url = new URL('dsh-workbay-dock/api/load', document.baseURI).href
            const response = await fetch(url, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: '{}',
            })
            const envelope = await response.json()
            /* The kit answers non-fatal failures as a JSON envelope with ok:false
               (404 unknown method, 403 forbidden, 415 bad content type). Those are
               NOT absent data — they are the case the user will hit first, before
               the host half is loaded. Route them into the error path so the meter
               greys out and explains itself instead of showing three dashes. */
            if (response.ok !== true || envelope === null || envelope === undefined || envelope.ok !== true) {
              const reason = envelope && envelope.error && envelope.error.message
                ? envelope.error.message
                : 'HTTP ' + response.status
              throw new Error(reason)
            }
            const data = envelope.data ? envelope.data : null
            if (alive === false) return
            if (data === null) throw new Error('empty payload')
            setReading({ cpu: data.cpu, gpu: data.gpu, mem: data.mem, err: '' })
            const latch = meterNextRetryState(retried.current, data.cpu)
            retried.current = latch.retried
            if (latch.schedule === true) {
              retryTimer = setTimeout(() => { void tick() }, METER_RETRY_MS)
            }
          } catch (error) {
            /* Keep the last good numbers on screen and only flip the tooltip:
               a transient failure must not blank the meter. */
            if (alive === false) return
            setReading((previous) => ({ ...previous, err: String((error && error.message) || error) }))
          } finally {
            inFlight = false
          }
        }

        void tick()
        const interval = setInterval(() => { void tick() }, METER_POLL_MS)
        window.addEventListener('focus', tick)
        return () => {
          alive = false
          clearInterval(interval)
          if (retryTimer !== null) clearTimeout(retryTimer)
          window.removeEventListener('focus', tick)
        }
      }, [])

      return reading
    }

    /** At or above WARN the number goes red; at or above HOT the dot breathes too. */
    function meterLevel(value) {
      if (typeof value !== 'number') return 'ok'
      if (value >= METER_HOT_PCT) return 'hot'
      if (value >= METER_WARN_PCT) return 'warn'
      return 'ok'
    }

    /**
     * Has at least one sample landed?
     *
     * Before the first reply every field is null, and reporting "no NVIDIA GPU"
     * from that state tells the user something false about their hardware. The
     * verdict is only trustworthy once `mem` exists (every successful sample
     * carries it, and it is the field that cannot be null in a real reply).
     */
    function meterHasSample(reading) {
      const state = reading === null || reading === undefined ? {} : reading
      return state.mem !== null && state.mem !== undefined
    }

    /** True only when a sample landed AND that sample had no GPU. */
    function meterGpuMissing(reading) {
      if (meterHasSample(reading) === false) return false
      const state = reading === null || reading === undefined ? {} : reading
      return state.gpu === null || state.gpu === undefined
    }

    /** A failed poll keeps the numbers but flags them as out of date. */
    function meterIsStale(reading) {
      const state = reading === null || reading === undefined ? {} : reading
      return typeof state.err === 'string' && state.err !== ''
    }

    /**
     * Decide the retry latch for one poll result.
     *
     * `cpu === null` means "no baseline yet": on mount the reader has never run,
     * and after `BASELINE_TTL_MS` of the window being unfocused the datum is
     * discarded on purpose. Either way a fast retry turns the dash into a number
     * immediately instead of waiting for the next 5s tick — but exactly once per
     * episode, so a persistently null CPU cannot spin.
     *
     * A real number ENDS the episode, which re-arms the latch; without that, the
     * TTL case (Review Focus 2) would never get its fast retry.
     */
    function meterNextRetryState(retried, cpu) {
      if (cpu === null || cpu === undefined) {
        /* Latch at SCHEDULE time, not when the timer fires: a focus event landing
           before the timer would otherwise schedule a second one. */
        return retried === true ? { retried: true, schedule: false } : { retried: true, schedule: true }
      }
      return { retried: false, schedule: false }
    }

    /**
     * The titlebar meter: one colour-coded dot per metric, the word and the
     * number beside it.
     *
     * The labels are never hidden, at any tier: measured in a real browser the
     * whole row is 179px and fits the titlebar even at the 520px minimum dock
     * width, so there is nothing to trade away. A bare dot would also make the
     * user memorise a hue, which defeats the point of colour-coding.
     */
    function LoadMeter(props) {
      const { t } = props
      const reading = useLoadMeter()
      const gpu = reading.gpu === null || reading.gpu === undefined ? null : reading.gpu
      const mem = reading.mem === null || reading.mem === undefined ? null : reading.mem
      /* Temperature is `[N/A]` on some drivers, which parses to NaN and would
         render as "null°C"; drop it rather than print nonsense. */
      const gpuBits = gpu === null
        ? []
        : [
          gpu.name,
          Number.isFinite(gpu.temp) ? gpu.temp + '°C' : '',
          gpu.memUsed + '/' + gpu.memTotal + ' MB',
        ].filter((part) => typeof part === 'string' && part !== '')
      const cells = [
        { tone: 'cpu', label: t('load.cpu'), value: reading.cpu, extra: '' },
        { tone: 'gpu', label: t('load.gpu'), value: gpu === null ? null : gpu.util, extra: gpuBits.join(' · ') },
        { tone: 'mem', label: t('load.mem'), value: mem === null ? null : mem.usedPct,
          extra: mem === null ? '' : (mem.usedGB + ' / ' + mem.totalGB + ' GB') },
      ]
      const gpuMissing = meterGpuMissing(reading)
      const stale = meterIsStale(reading)
      const title = stale
        ? t('load.offline') + ' — ' + reading.err
        : cells.map((cell) => cell.label + ' ' + (typeof cell.value === 'number' ? cell.value + '%' : '—')
          + (cell.extra === '' ? '' : ' (' + cell.extra + ')')).join(' · ')
          + (gpuMissing ? '　·　' + t('load.noGpu') : '')
      return E('span', {
        className: 'wbd-load',
        title,
        'aria-label': t('load.title'),
        'data-state': stale ? 'stale' : undefined,
      },
        cells.map((cell) => E('span', {
          key: cell.tone,
          className: 'wbd-loadCell',
          'data-tone': cell.tone,
          'data-level': meterLevel(cell.value),
        },
        E('span', { className: 'wbd-loadDot' }),
        E('span', { className: 'wbd-loadLabel' }, cell.label),
        E('span', { className: 'wbd-loadNum' }, typeof cell.value === 'number' ? String(cell.value) : '—'),
        typeof cell.value === 'number' ? E('span', { className: 'wbd-loadPct' }, '%') : null)))
    }

    /**
     * The always-visible workspace bar.
     *
     * It never disappears — that was the whole point of the 2.0 layout. Narrow
     * tiers DEGRADE it instead (path hidden below 680px, status chips below
     * 980px), so "which workspace am I in" is answerable at every width.
     */
    function WorkbenchContextBar(props) {
      const { t, ctx } = props
      const state = ctx === null || ctx === undefined ? EMPTY_CONTEXT : ctx
      const name = typeof state.name === 'string' && state.name !== '' ? state.name : ''
      const path = typeof state.path === 'string' && state.path !== '' ? state.path : ''
      const branch = typeof state.branch === 'string' && state.branch !== '' ? state.branch : ''
      const ahead = Number.isFinite(state.ahead) && state.ahead > 0 ? state.ahead : 0
      const behind = Number.isFinite(state.behind) && state.behind > 0 ? state.behind : 0
      const changes = Number.isFinite(state.changes) && state.changes > 0 ? state.changes : 0
      return E('div', { className: 'wbd-ctx' + (name === '' ? ' is-empty' : '') },
        E('span', { className: 'wbd-ctxGlyph' }, E(Icon, { name: 'workbench', size: 14 })),
        E('div', { className: 'wbd-ctxMain' },
          E('div', { className: 'wbd-ctxLine1' },
            E('span', { className: 'wbd-ctxName', title: path === '' ? t('ctx.none') : path },
              name === '' ? t('ctx.none') : name)),
          path === ''
            ? E('div', { className: 'wbd-ctxPath is-hint' }, t('ctx.noPath'))
            : E('div', { className: 'wbd-ctxPath', title: path }, path)),
        E('div', { className: 'wbd-ctxMeta' },
          branch === '' ? null : E('span', { className: 'wbd-branchPill', title: t('ctx.branch') },
            E(Icon, { name: 'branch', size: 11 }),
            E('span', { className: 'wbd-branchName' }, branch),
            ahead === 0 && behind === 0 ? null : E('span', { className: 'wbd-sync' },
              ahead > 0 ? E('span', { className: 'wbd-ahead' }, '↑' + ahead) : null,
              behind > 0 ? E('span', { className: 'wbd-behind' }, '↓' + behind) : null)),
          changes === 0 ? null : E('span', { className: 'wbd-chip is-warn' }, t('ctx.changes') + ' ' + changes)))
    }

    /** The status bar belongs to the shell: it says which page is open, what that
        page is doing, and which tier/layout is active. Pages that are NOT open but
        ARE doing something (a burn, a running shell) show up as badges — that is
        the "background task" surface. */
    function WorkbenchStatusBar(props) {
      const { t, page, tier, layout, ctx, pages, onSelect, layoutMode, onLayout, layoutFits } = props
      const state = ctx === null || ctx === undefined ? EMPTY_CONTEXT : ctx
      const statuses = state.statuses !== null && typeof state.statuses === 'object' ? state.statuses : {}
      const activeId = page === null || page === undefined ? '' : page.id
      const activeStatus = activeId !== '' && typeof statuses[activeId] === 'string' ? statuses[activeId] : ''
      const fallback = typeof state.status === 'string' ? state.status : ''
      const shown = activeStatus === '' ? fallback : activeStatus
      const badges = (Array.isArray(pages) ? pages : []).filter((entry) => {
        return entry.id !== activeId && typeof statuses[entry.id] === 'string' && statuses[entry.id] !== ''
      })
      return E('footer', { className: 'wbd-status' },
        E('span', { className: 'wbd-statusItem' }, page === null || page === undefined ? t('status.noPage') : page.title),
        shown === '' ? null : E('span', { className: 'wbd-statusItem is-dim' }, '· ' + shown),
        badges.length === 0 ? null : E('span', { className: 'wbd-statusTasks' }, badges.map((entry) => E('button', {
          key: entry.id,
          type: 'button',
          className: 'wbd-task',
          title: entry.title + ' — ' + statuses[entry.id],
          onClick: () => { if (typeof onSelect === 'function') onSelect(entry.id) },
        }, E('span', { className: 'wbd-taskDot' }), E('span', null, statuses[entry.id])))),
        E('span', { className: 'wbd-statusLayout', role: 'group', 'aria-label': t('layoutGroup') },
          LAYOUT_MODES.map((entry) => E('button', {
            key: entry,
            type: 'button',
            className: 'wbd-lsBtn' + (layoutMode === entry ? ' is-on' : ''),
            title: t('layout.' + entry) + (typeof layoutFits === 'function' && layoutFits(entry) === false ? ' · ' + t('layoutTooNarrow') : ''),
            'aria-label': t('layout.' + entry),
            disabled: typeof layoutFits === 'function' && layoutFits(entry) === false,
            'aria-pressed': layoutMode === entry,
            onClick: () => { if (typeof onLayout === 'function') onLayout(entry) },
          }, E(Icon, { name: 'layout-' + entry, size: 12 })))),
        E('span', { className: 'wbd-statusRight' },
          TIER_LABEL[tier] + ' · ' + LAYOUT_LABEL[layout] + ' · ' + tier.toUpperCase()))
    }

    /* ============================== icons ============================== */

    /* The glyph's INK must measure like the host's own sidebar icons, which
       fill roughly 12.5–13 of their 16px box (插件 / 自动化任务 / 更多). The
       previous drawing was 12.4×8.2 — a wide flat bar sitting low in the box —
       so the entry read as "not aligned" even with a correctly centred box. */
    const ICONS = {
      workbench: ['M1.8 1.8h12.4v12.4H1.8z', 'M1.8 6.2h12.4', 'M6.2 6.2v8'],
      close: ['M4 4l8 8', 'M12 4l-8 8'],
      restart: ['M13.2 8a5.2 5.2 0 1 1-1.5-3.7', 'M13.2 2.8v3.4h-3.4'],
      minimize: ['M3.5 8h9'],
      resize: ['M13.5 2.5v11h-11', 'M13.5 6.5v7h-7'],
      dock: ['M1.8 2.5h12.4v11H1.8z', 'M9.5 2.5v11'],
      float: ['M2.5 3.5h8v8h-8z', 'M5.5 2h8v8'],
      /* Layout switch icons: one glyph per resolveLayout outcome, replacing the
         text labels so the switch fits (and stays visible) in the narrowest tier. */
      'layout-auto': ['M2.5 2.5h4v4h-4z', 'M9.5 2.5h4v4h-4z', 'M2.5 9.5h4v4h-4z', 'M9.5 9.5h4v4h-4z'],
      'layout-single': ['M2.5 2.5h11v11h-11z'],
      'layout-split': ['M2.5 2.5h11v11h-11z', 'M8 2.5v11'],
      'layout-tri': ['M2.5 2.5h11v11h-11z', 'M6.2 2.5v11', 'M9.8 2.5v11'],
      branch: [
        'M4.6 5.6v5.4',
        'M11.4 5.6v2a2 2 0 0 1-2 2H4.6',
        'M4.6 2.9a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3',
        'M11.4 2.9a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3',
      ],
    }

    function Icon(props) {
      const size = props.size === undefined ? 14 : props.size
      const shape = ICONS[props.name] === undefined ? ICONS.workbench : ICONS[props.name]
      return E('svg', {
        className: 'wbd-icon', width: size, height: size, viewBox: '0 0 16 16',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.4,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
      }, shape.map((d, index) => E('path', { key: index, d })))
    }

    /* ============================== the overlay ============================== */

    /**
     * One page body, with its own error boundary: a broken page must not blank
     * the whole dock.
     */
    class PageBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error: error instanceof Error ? error : new Error(String(error)) }
      }

      render() {
        if (this.state.error !== null) {
          return E('div', { className: 'wbd-error' },
            E('div', { className: 'wbd-errorTitle' }, 'Page crashed'),
            E('div', { className: 'wbd-errorBody' }, String(this.state.error.message ?? this.state.error)))
        }
        return this.props.children
      }
    }

    /**
     * The global overlay. Rendering is portal-free on purpose: it is a
     * `position: fixed` layer appended at the end of the plugin's own root, so it
     * floats above the whole application without needing a portal target that
     * differs between the web shell and the desktop shell.
     */
    function WorkbenchOverlay(props) {
      const { t } = props
      const pages = usePages()
      const openFlag = useOpenFlag()
      const isOpen = openFlag

      /* Float vs docked. Docked is the default because "一边是会话，一边是工作台"
         is the common case; the flag is remembered. */
      /* 停靠固定：面板紧贴会话右侧，另外提供一个「工作台」会话页签显示完整界面。
         浮动窗口用的「移到浮动」按钮已删除——浮动会盖住输入框。 */
      const [restarting, setRestarting] = useState(false)
      const [mode, setModeState] = useState('docked')
      const setMode = useCallback((next) => {
        setModeState(next)
        writeMode(next)
      }, [])

      /* Docked width, persisted; the app's main column is padded by this much. */
      const [dockWidth, setDockWidth] = useState(() => readDockWidth())
      const dockDragRef = useRef(null)

      /* Expose the dock footprint to CSS so the shell can give up that space. */
      useEffect(() => {
        if (!isOpen || mode !== 'docked') {
          document.documentElement.style.removeProperty('--wbd-dock-width')
          document.documentElement.style.removeProperty('--wbd-dock-css')
          document.body.classList.remove('wbd-docked-open')
          return undefined
        }
        /* --wbd-dock-width is the PHYSICAL reservation; the element's CSS width is
           that divided by zoom so its rendered box matches the reservation exactly. */
        document.documentElement.style.setProperty('--wbd-dock-width', dockWidth + 'px')
        document.documentElement.style.setProperty('--wbd-dock-css', (dockWidth / WORKBENCH_ZOOM).toFixed(2) + 'px')
        document.body.classList.add('wbd-docked-open')
        return () => {
          document.documentElement.style.removeProperty('--wbd-dock-width')
          document.documentElement.style.removeProperty('--wbd-dock-css')
          document.body.classList.remove('wbd-docked-open')
        }
      }, [isOpen, mode, dockWidth])

      const onDockResizeStart = useCallback((event) => {
        event.preventDefault()
        event.stopPropagation()
        const startX = event.clientX
        const startW = dockWidth
        dockDragRef.current = { startX, startW }
        const onMove = (moveEvent) => {
          const drag = dockDragRef.current
          if (drag === null) return
          /* Dragging LEFT widens the dock: the grip is on its left edge. */
          const nextW = Math.max(520, Math.min(window.innerWidth - 320, drag.startW - (moveEvent.clientX - drag.startX)))
          setDockWidth(Math.round(nextW))
        }
        const onUp = () => {
          dockDragRef.current = null
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          setDockWidth((value) => {
            writeDockWidth(value)
            return value
          })
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
      }, [dockWidth])
      const [active, setActive] = useState(() => {
        try { return window.localStorage.getItem(STORAGE_PAGE) } catch { return null }
      })
      const [geometry, setGeometry] = useState(() => {
        const stored = readJson(STORAGE_GEOM)
        if (stored !== null && Number.isFinite(stored.w) && Number.isFinite(stored.h)) return stored
        return { w: 1100, h: 720 }
      })
      const dragRef = useRef(null)

      const current = useMemo(() => {
        if (pages.length === 0) return null
        const found = pages.find((page) => page.id === active)
        return found === undefined ? pages[0] : found
      }, [pages, active])

      useEffect(() => {
        if (current === null) return
        if (active !== current.id) {
          setActive(current.id)
          try { window.localStorage.setItem(STORAGE_PAGE, current.id) } catch (error) { void error }
        }
      }, [current, active])

      /* --- shell state: context, tier, layout, keep-alive ---------------------- */

      const ctxState = useWorkbenchContext()

      /* The PANEL width, not the viewport: `docked` is sized by the drag grip and
         `float` by the resize handle, and both are exactly known here — so the
         tier is derived synchronously instead of from a ResizeObserver that would
         paint one wrong frame first. */
      /* Measured width of the panel itself. The stored dock width and the geometry
         are the INTENT; `zoom` and DPI make the rendered box differ from both, and
         a wrong tier silently hides the path row and the status chips. Measure what
         is actually on screen and fall back to the intent before the first frame. */
      const shellRef = useRef(null)
      const [measuredWidth, setMeasuredWidth] = useState(0)
      useEffect(() => {
        if (typeof ResizeObserver !== 'function') return undefined
        const el = shellRef.current
        if (el === null || el === undefined) return undefined
        /* measure PHYSICAL px (getBoundingClientRect), not contentRect: the panel has
           zoom, and the tier/layout thresholds are expressed in physical px like every
           other width here (innerWidth, layout targets, drag deltas). */
        const measure = () => {
          const next = Math.round(el.getBoundingClientRect().width)
          if (next > 0) setMeasuredWidth(next)
        }
        const observer = new ResizeObserver(() => { measure() })
        observer.observe(el)
        measure()
        return () => { try { observer.disconnect() } catch (error) { void error } }
      }, [isOpen, mode])

      const panelWidth = measuredWidth > 0
        ? measuredWidth
        : (mode === 'docked' ? dockWidth : geometry.w)
      const tier = tierForWidth(panelWidth)

      const [layoutMode, setLayoutModeState] = useState(() => readLayoutMode())
      /* 可用最大宽度：停靠要让出会话栏，浮动只留边距。窗口放不下的布局直接禁用，
         而不是先把面板拉宽、再渲染出一个挤坏的三栏。 */
      const maxPanelWidth = () => (typeof window === 'object' && window !== null ? window.innerWidth : 1600) - (mode === 'docked' ? 320 : 40)
      const layoutFits = useCallback((entry) => {
        const max = maxPanelWidth()
        if (entry === 'auto') return true
        if (entry === 'single') return max >= 520
        if (entry === 'split') return max >= 980
        if (entry === 'tri') return max >= 1280
        return false
      }, [mode])
      const setLayoutMode = useCallback((next) => {
        const value = writeLayoutMode(next)
        if (value !== 'auto' && layoutFits(value) === false) return
        setLayoutModeState(value)
        if (value === 'auto') return
        const target = LAYOUT_TARGET_WIDTH[value]
        if (typeof target !== 'number') return
        if (mode === 'docked') {
          const max = Math.max(520, (typeof window === 'object' && window !== null ? window.innerWidth : 1600) - 320)
          const width = Math.max(520, Math.min(max, target))
          setDockWidth(width)
          writeDockWidth(width)
        } else {
          const max = Math.max(560, (typeof window === 'object' && window !== null ? window.innerWidth : 1600) - 40)
          const width = Math.max(560, Math.min(max, target))
          setGeometry((current) => {
            const nextGeometry = { w: width, h: current.h }
            writeJson(STORAGE_GEOM, nextGeometry)
            return nextGeometry
          })
        }
      }, [mode, layoutFits])
      const layout = resolveLayoutKind(tier, layoutMode)

      /* One page switch, used by the pill strip, the rail and the status-bar task
         badges: they must all persist the same choice. */
      const selectPage = useCallback((id) => {
        setActive(id)
        try { window.localStorage.setItem(STORAGE_PAGE, id) } catch (error) { void error }
      }, [])

      /* Keep-alive: a page mounts the first time it is opened and is never
         unmounted afterwards. Switching away must not kill a terminal session, a
         running burn, or the row selection a page is showing. */
      const [visited, setVisited] = useState(() => new Set())
      useEffect(() => {
        if (current === null) return
        setVisited((previous) => (previous.has(current.id) ? previous : new Set(previous).add(current.id)))
      }, [current, active])


      /* Esc closes the dock; that is the only keyboard binding, so it can never
         shadow a page's own shortcuts. */
      useEffect(() => {
        if (!isOpen) return undefined
        const onKey = (event) => {
          if (event.key !== 'Escape' || event.defaultPrevented) return
          /* A page's own modal owns Esc while it is open (e.g. the Git diff);
             otherwise one press would close the diff AND the workbench. */
          if (document.querySelector('[aria-modal="true"]') !== null) return
          const target = event.target
          if (target !== null && target !== undefined && typeof target.tagName === 'string'
            && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
          /* 逐级返回：先让当前页退一层（对话框 → 弹窗 → 详情 → 选中），
             所有层级都退完了才关闭工作台。 */
          const registry = typeof window === 'object' && window !== null ? window[GLOBAL_KEY] : undefined
          const activeId = current === null || current === undefined ? '' : current.id
          const handled = registry !== undefined && registry !== null && typeof registry.runBack === 'function'
            ? registry.runBack(activeId)
            : false
          if (handled === true) { event.preventDefault(); return }
          setOpen(false)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [isOpen, current])

      /* Resizing: pointer-driven, persisted, clamped to the viewport. */
      const onResizeStart = useCallback((event) => {
        event.preventDefault()
        event.stopPropagation()
        const startX = event.clientX
        const startY = event.clientY
        const startW = geometry.w
        const startH = geometry.h
        dragRef.current = { startX, startY, startW, startH }
        const onMove = (moveEvent) => {
          const drag = dragRef.current
          if (drag === null) return
          const nextW = Math.max(520, Math.min(window.innerWidth - 80, drag.startW + (moveEvent.clientX - drag.startX)))
          const nextH = Math.max(360, Math.min(window.innerHeight - 80, drag.startH + (moveEvent.clientY - drag.startY)))
          setGeometry({ w: Math.round(nextW), h: Math.round(nextH) })
        }
        const onUp = () => {
          dragRef.current = null
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          setGeometry((value) => {
            writeJson(STORAGE_GEOM, value)
            return value
          })
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
      }, [geometry.w, geometry.h])

      if (isOpen) {
      }

      if (!isOpen) return null

      /* Pages mount on first visit and STAY mounted (see `visited`): the stack
         renders every visited page and hides the inactive ones with CSS, so a
         terminal session or a running burn survives a tab switch. Only the active
         page is exposed to assistive tech. */
      const stack = pages.length === 0
        ? E('div', { className: 'wbd-empty' },
          E('div', { className: 'wbd-emptyTitle' }, t('pane.empty')),
          E('div', { className: 'wbd-emptyHint' }, t('pane.emptyHint')))
        : E('div', { className: 'wbd-stack' },
          pages.filter((page) => visited.has(page.id)).map((page) => {
            const pageActive = current !== null && current.id === page.id
            return E('div', {
              key: page.id,
              className: 'wbd-page' + (pageActive ? ' is-active' : ''),
              'aria-hidden': pageActive ? undefined : true,
            }, E(PageBoundary, null, E(page.component, {
              t,
              dock: registry,
              active: pageActive,
              /* The shell's resolved tier + layout, so a page can shape its own
                 columns instead of guessing from a media query. A page that
                 ignores them keeps working: they are additive. */
              tier,
              layout,
              /* `hosted` tells a page the shell already shows the workspace name,
                 branch and change count. Pages use it to drop THEIR copy of that
                 text while keeping their own actions (fetch/pull/push/search). */
              hosted: true,
            })))
          }))

      const body = E('div', { className: 'wbd-body' }, stack)

      const restartWorkbench = async () => {
        if (restarting) return
        const confirmFn = typeof window.confirm === 'function' ? window.confirm : null
        if (confirmFn !== null && confirmFn(t('pane.restartConfirm')) !== true) return
        setRestarting(true)
        try {
          const restartUrl = new URL('dsh-workbay-dock/api/restart', document.baseURI).href
          const response = await fetch(restartUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
          const envelope = await response.json().catch(() => null)
          const payload = envelope && envelope.data ? envelope.data : envelope
          if (response.ok !== true || payload === null || payload.ok !== true) {
            const message = payload && payload.message ? payload.message : ''
            if (typeof window.alert === 'function') window.alert(t('pane.restartUnavailable') + (message === '' ? '' : '\n' + message))
            setRestarting(false)
            return
          }
          /* The host schedules HMR reconciliation after responding. Give it a
             moment to replace the changed bundles, then reload the whole DSH
             page so the new client bundle is fetched too. */
          await new Promise((resolve) => setTimeout(resolve, 1800))
          window.location.reload()
        } catch (error) {
          if (typeof window.alert === 'function') window.alert(t('pane.restartFailed') + String(error && error.message ? error.message : error))
          setRestarting(false)
        }
      }

      const titlebar = E('div', { className: 'wbd-titlebar' },
        E('span', { className: 'wbd-titleIcon' }, E(Icon, { name: 'workbench', size: 14 })),
        E('span', { className: 'wbd-title' }, t('pane.title')),
        E('span', { className: 'wbd-titleHint' }, mode === 'docked' ? t('pane.docked') : t('pane.global')),
        E('span', { className: 'wbd-titleActions' },
          E(LoadMeter, { t }),
          E('button', {
            type: 'button', className: 'wbd-titleBtn', title: restarting ? t('pane.restarting') : t('pane.restart'),
            'aria-label': t('pane.restart'), disabled: restarting,
            onClick: () => { void restartWorkbench() },
          }, E(Icon, { name: 'restart', size: 13 })),
          E('button', {
            type: 'button', className: 'wbd-titleBtn', title: t('pane.close'), 'aria-label': t('pane.close'),
            onClick: () => setOpen(false),
          }, E(Icon, { name: 'close', size: 13 }))))

      const contextBar = E(WorkbenchContextBar, { t, ctx: ctxState })

      const tabStrip = pages.length <= 1
        ? null
        : E('div', { className: 'wbd-tabs', role: 'tablist' },
          pages.map((page) => E('button', {
            key: page.id,
            type: 'button',
            role: 'tab',
            'aria-selected': current !== null && current.id === page.id,
            className: 'wbd-tab' + (current !== null && current.id === page.id ? ' is-active' : ''),
            title: page.title,
            onClick: () => {
              setActive(page.id)
              try { window.localStorage.setItem(STORAGE_PAGE, page.id) } catch (error) { void error }
            },
          },
          page.icon === undefined ? null : E('span', { className: 'wbd-tabIcon' }, page.icon(13)),
          E('span', { className: 'wbd-tabLabel' }, page.title))))

      const statusBar = E(WorkbenchStatusBar, {
        t,
        page: current,
        tier,
        layout,
        ctx: ctxState,
        pages,
        onSelect: selectPage,
        layoutMode,
        onLayout: setLayoutMode,
        layoutFits,
      })

      /* The same roster rendered twice: a horizontal pill strip at t1/t2 and a
         vertical rail at t3/t4. CSS shows exactly one of them, so the JSX stays
         branch-free and a stale `data-w` can never leave the user with no nav. */
      const rail = pages.length <= 1
        ? null
        : E('nav', { className: 'wbd-rail', 'aria-label': t('pane.title') },
          pages.map((page) => {
            const pageActive = current !== null && current.id === page.id
            return E('button', {
              key: page.id,
              type: 'button',
              className: 'wbd-railItem' + (pageActive ? ' is-active' : ''),
              title: page.title,
              'aria-current': pageActive ? 'page' : undefined,
              onClick: () => selectPage(page.id),
            },
            E('span', { className: 'wbd-railGlyph' }, page.icon === undefined ? E(Icon, { name: 'workbench', size: 16 }) : page.icon(16)),
            E('span', { className: 'wbd-railLabel' }, page.short === undefined ? page.title : page.short))
          }))

      const main = E('div', { className: 'wbd-main' }, rail, body)

      /* Docked is the only placement now: a floating window covered the
         conversation's input, and the separate「工作台」conversation tab was removed
         on request — the side panel IS the workbench. */
      return E('div', {
        className: 'wbd-docked',
        ref: shellRef,
        role: 'complementary',
        'aria-label': t('pane.title'),
        'data-w': tier,
        'data-layout': layout,
        style: { zoom: WORKBENCH_ZOOM },
      },
        titlebar,
        contextBar,
        tabStrip,
        main,
        statusBar,
        E('div', {
          className: 'wbd-dockGrip',
          title: t('pane.resize'),
          onPointerDown: onDockResizeStart,
        }))
    }

    /* ============================== the entry button ============================== */

    /**
     * The entry. It renders in \`sidebar.panellist\` — the LEFT sidebar's top row,
     * the seat 插件 / 自动化任务 / 更多 occupy — as an icon of the same size, with
     * the dock's name as its tooltip.
     */
    function WorkbenchEntryButton(props) {
      const { t } = props
      const isOpen = useOpenFlag()
      const size = typeof props.size === 'number' ? props.size : 16
      const hostRef = useRef(null)

      useEffect(() => {
        const own = hostRef.current
        if (own !== null && own !== undefined) entryMountedFlag = true
        if (own === null || own === undefined) return undefined

        /* The host wraps this slot in its own <button class="…panelRow">. A click
           on our inner control can be consumed by that outer button, which is
           exactly why the dock did not open for the user. Listening in the
           CAPTURE phase runs before any handler on the row, so the toggle is
           guaranteed; stopping propagation keeps the row from also acting. */
        const row = rowOfEntry(own)

        const onCapture = (event) => {
          const target = event.target
          if (!(target instanceof Node)) return
          /* One toggle per gesture even if more than one entry is mounted. */
          if (event.__wbdHandled === true) return
          if (event.type === 'keydown') {
            const key = event.key
            if (key !== 'Enter' && key !== ' ') return
            if (!own.contains(target)) return
          } else if (!isEntryRowHit(target, own, row)) {
            return
          }
          event.preventDefault()
          event.stopPropagation()
          event.__wbdHandled = true
          setOpen(!openState)
        }
        const swallowCapture = (event) => {
          if (!isEntryRowHit(event.target, own, row)) return
          event.preventDefault()
          event.stopPropagation()
        }
        /* pointerdown is the FIRST event of an interaction: acting here beats the
           host row's own handlers, which may navigate or unmount this row before
           a `click` would ever arrive. */
        document.addEventListener('pointerdown', onCapture, true)
        document.addEventListener('keydown', onCapture, true)
        document.addEventListener('click', swallowCapture, true)
        return () => {
          document.removeEventListener('pointerdown', onCapture, true)
          document.removeEventListener('keydown', onCapture, true)
          document.removeEventListener('click', swallowCapture, true)
        }
      }, [])

      /* The glyph must occupy exactly the box the host's own icons do (16px at
         `size`, inside the row's 22px line box). The host sizes the seat with
         `padding:7px 8px; gap:8px; line-height:22px`, so a taller/wider entry
         inflates the whole row (42px instead of 36px) and pushes the label —
         and every row below it — out of line with 插件 / 自动化任务 / 更多.
         Size comes from the svg itself; the wrapper adds no box. */
      const glyph = Math.max(12, Math.min(size, 22))

      return E('span', {
        ref: hostRef,
        className: 'wbd-entryBtn' + (isOpen ? ' is-open' : ''),
        role: 'button',
        tabIndex: 0,
        title: t('button.tooltip') + ' (Ctrl+E)',
        'aria-label': t('button.tooltip') + ' (Ctrl+E)',
        'aria-pressed': isOpen,
      }, E(Icon, { name: 'workbench', size: glyph }))
    }

    /* ============================== styles ============================== */

    const CSS = `
.wbd-icon{flex:none;display:block}
/* ---- left-sidebar footer button ---- */
.wbd-footerBtn{display:flex;align-items:center;gap:8px;width:100%;padding:6px 9px;border:none;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#b6bac1);font:inherit;font-size:12px;cursor:pointer;text-align:left}
.wbd-footerBtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));color:var(--dsw-alias-label-primary,#fff)}
.wbd-footerBtn.is-open{background:var(--dsw-alias-interactive-bg-active,rgba(77,107,254,.18));color:var(--dsw-alias-label-primary,#fff)}
.wbd-footerLabel{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* ---- left-sidebar entry ----
   The wrapper contributes NO box of its own: the svg it holds is the glyph's
   own 16/18px box, exactly like the host's peer icons (插件 / 自动化任务 / 更多),
   and the host's button.panelRow already supplies the 36px row, its padding,
   the 8px gap and the hover fill. An earlier min-width:28px/height:28px rule
   beat that and inflated the host row to 42px, pushing the glyph +6px and the
   label +12px out of line with those peers. */
.wbd-entryBtn{display:inline-flex;align-items:center;justify-content:center;flex:none;padding:0;border:none;border-radius:4px;background:transparent;color:inherit;cursor:pointer}
.wbd-entryBtn:hover{color:var(--dsw-alias-label-primary,#fff)}
.wbd-entryBtn.is-open{color:var(--dsw-alias-brand-primary,#7c93ff)}
/* Open state gets the host's own row fill, applied to the host's button rather
   than to this span: padding/height stay the host's, so nothing below moves.
   The seat nests BUTTON > span.panelGlyph > div(display:contents) > this span,
   and this class exists nowhere else, so no other button can match. :has() is
   Chromium-only in practice, and the desktop shell is Chromium. */
button:has(.wbd-entryBtn.is-open){background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}
/* Docked: a real column on the right edge; the shell is padded so the
   conversation keeps its own space and both stay interactive. */
/* 宽度单位统一为“物理像素”：--wbd-dock-width 是面板占用的真实宽度（body 用同一个值
   预留会话空间），--wbd-dock-css 是除以 zoom 之后写进 CSS 的宽度。两者分离是因为
   面板带 zoom:1.1：CSS 宽度 1400 实际渲染 1541，预留 1400 就会盖住会话 141px。 */
.wbd-docked{position:fixed;top:0;right:0;bottom:0;width:var(--wbd-dock-css,564px);z-index:700;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1,#1b1e24);border-left:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));box-shadow:-8px 0 24px rgba(0,0,0,.28);overflow:hidden}
body.wbd-docked-open{padding-right:var(--wbd-dock-width,620px);box-sizing:border-box;transition:padding-right .12s ease}
.wbd-dockGrip{position:absolute;left:0;top:0;bottom:0;width:6px;cursor:ew-resize}
.wbd-dockGrip:hover{background:var(--dsw-alias-brand-primary,#4d6bfe);opacity:.35}
.wbd-overlay{position:fixed;left:0;top:0;right:0;bottom:0;z-index:900;display:flex;align-items:center;justify-content:center;pointer-events:none}
.wbd-window{pointer-events:auto;display:flex;flex-direction:column;max-width:calc(100vw - 40px);max-height:calc(100vh - 60px);border-radius:var(--dsw-radius-lg,12px);border:1px solid var(--dsw-alias-border-l3,rgba(255,255,255,.16));background:var(--dsw-alias-bg-layer-2,#22262c);box-shadow:var(--dsw-elevation-prominent,0 18px 60px rgba(0,0,0,.55));overflow:hidden;position:relative}
.wbd-titlebar{display:flex;align-items:center;gap:8px;min-height:40px;padding:0 8px 0 12px;border-bottom:none;background:var(--dsw-alias-bg-layer-1,#1b1e24);flex:none}
/* 停靠面板贴在窗口右上角，而 DSH 的窗口按钮（− □ ✕）画在同一个角上、层级更高：
   不预留这段宽度，布局切换和我们的收/关按钮会被窗口按钮盖住。 */
.wbd-docked .wbd-titlebar{padding-right:140px}
.wbd-titleIcon{display:flex;color:var(--dsw-alias-brand-primary,#4d6bfe)}
.wbd-title{font-weight:600;font-size:13px}
.wbd-titleHint{flex:1;min-width:0;font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8f98);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wbd-titleActions{display:flex;gap:2px;flex:none}
.wbd-titleBtn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#b6bac1);cursor:pointer}
.wbd-titleBtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.1));color:var(--dsw-alias-label-primary,#fff)}
.wbd-titleBtn:disabled{opacity:.45;cursor:default;background:transparent}
/* ===== titlebar load meter =====
   Per-metric hue so the three numbers are distinguishable at a glance, plus a
   red override once a metric crosses its threshold — colour identifies, red
   warns. The breathing uses opacity ONLY: animating box-shadow / filter keeps
   the compositor busy forever, which is a silly price for a load indicator. */
.wbd-load{display:inline-flex;align-items:center;gap:10px;flex:none;margin-right:2px;font-size:11px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#b6bac1);white-space:nowrap}
/* A failed poll keeps the last numbers but visibly dims them: the reading is no
   longer current, and silently showing stale data is worse than showing none. */
.wbd-load[data-state="stale"]{opacity:.55}
.wbd-loadCell{display:inline-flex;align-items:center;gap:3px}
.wbd-loadDot{width:6px;height:6px;border-radius:50%;flex:none}
/* The word is the point: let it carry the weight, keep the number quiet. */
.wbd-loadLabel{font-weight:600;letter-spacing:.02em}
.wbd-loadNum{font-weight:600}
.wbd-loadPct{opacity:.7;margin-left:-1px}
.wbd-loadCell[data-tone="cpu"] .wbd-loadDot{background:#38bdf8}
.wbd-loadCell[data-tone="gpu"] .wbd-loadDot{background:#a78bfa}
.wbd-loadCell[data-tone="mem"] .wbd-loadDot{background:#fbbf24}
.wbd-loadCell[data-level="warn"] .wbd-loadNum,
.wbd-loadCell[data-level="hot"] .wbd-loadNum{color:#e5534b;font-weight:700}
.wbd-loadCell[data-level="hot"] .wbd-loadDot{animation:wbdLoadBreath 1.6s ease-in-out infinite}
@keyframes wbdLoadBreath{0%,100%{opacity:.45}50%{opacity:1}}
@media (prefers-reduced-motion:reduce){.wbd-loadDot{animation:none!important;opacity:1}}
html[data-theme="light"] .wbd-loadCell[data-tone="cpu"] .wbd-loadDot{background:#0284c7}
html[data-theme="light"] .wbd-loadCell[data-tone="gpu"] .wbd-loadDot{background:#7c3aed}
html[data-theme="light"] .wbd-loadCell[data-tone="mem"] .wbd-loadDot{background:#b45309}
/* One red, in both themes — the spec pins #e5534b and says the light theme uses
   the same colour. The dots change because a 6px chip on white needs more
   contrast; the alarm colour does not, because "this is a warning" must not
   mean two different hues depending on the theme. */
html[data-theme="light"] .wbd-loadCell[data-level="warn"] .wbd-loadNum,
html[data-theme="light"] .wbd-loadCell[data-level="hot"] .wbd-loadNum{color:#e5534b}
/* Labels are ALWAYS shown. Measured in a real browser at every dock width
   (520 / 564 / 620 / 680 / 760 / 980 px): the full "CPU 35% · GPU — · MEM 80%"
   row is 179px and never overflows the titlebar, so there is no width at which
   hiding the word buys anything. The word is also the honest label — a bare
   coloured dot asks the user to memorise a hue, which is exactly the thing the
   colour-coding was supposed to save them from. */
.wbd-tabs{display:flex;align-items:center;gap:2px;height:38px;flex:none;padding:0 10px;border-bottom:none;background:var(--dsw-alias-bg-layer-1,#1b1e24);overflow-x:auto;scrollbar-width:thin}
.wbd-tab{display:inline-flex;align-items:center;gap:5px;flex:none;height:26px;padding:0 10px;border:none;border-radius:7px;background:transparent;color:#9aa0a8;font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.wbd-tab:hover{background:rgba(255,255,255,.05);color:#cfd3d9}
.wbd-tab.is-active{background:rgba(255,255,255,.085);color:#f2f3f5;font-weight:500}
.wbd-tabIcon{display:flex}
/* ---- shell 2.0: context bar, layout switch, page stack, status bar ----
   Sizes keyed off the data-w attribute on the panel root, because the tier is the
   PANEL's width (docked 620 / floated 1100 / scaled) and not the viewport's. */
.wbd-ctx{display:flex;align-items:center;gap:9px;flex:none;padding:0 10px 0 12px;min-height:56px;background:var(--dsw-alias-bg-layer-1,#1b1e24)}
.wbd-ctxGlyph{display:flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:7px;flex:none;background:linear-gradient(160deg,rgba(77,107,254,.30),rgba(77,107,254,.12));color:var(--dsw-alias-brand-primary,#7c93ff);box-shadow:inset 0 0 0 1px rgba(120,145,255,.20)}
.wbd-ctx.is-empty .wbd-ctxGlyph{background:rgba(255,255,255,.05);color:var(--dsw-alias-label-tertiary,#8a8f98);box-shadow:none}
.wbd-ctxMain{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1 1 auto}
.wbd-ctxLine1{display:flex;align-items:center;gap:6px;min-width:0}
.wbd-ctxName{font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary,#e6e6e6);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.wbd-ctx.is-empty .wbd-ctxName{font-weight:500;color:var(--dsw-alias-label-tertiary,#8a8f98)}
.wbd-ctxPath.is-hint{color:var(--dsw-alias-label-tertiary,#5f656d)}
.wbd-ctxPath{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#6f757e);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--dsw-font-markdown-code-block,ui-monospace,monospace)}
.wbd-ctxMeta{display:flex;align-items:center;gap:6px;flex:none}
.wbd-branchPill{display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 8px;border-radius:6px;background:rgba(255,255,255,.05);color:var(--dsw-alias-label-secondary,#b6bac1);font-size:11px;white-space:nowrap}
.wbd-branchName{max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wbd-sync{display:inline-flex;gap:3px;font-size:10px}
.wbd-ahead{color:var(--dsw-alias-state-success-primary,#3fb950)}
.wbd-behind{color:var(--dsw-alias-state-warn-primary,#e2a03f)}
.wbd-chip{display:inline-flex;align-items:center;height:20px;padding:0 6px;border-radius:5px;font-size:10px;background:rgba(255,255,255,.05);color:var(--dsw-alias-label-secondary,#b6bac1);white-space:nowrap}
.wbd-chip.is-warn{color:var(--dsw-alias-state-warn-primary,#e2a03f);background:rgba(226,160,63,.12)}
.wbd-layoutSwitch{display:flex;gap:1px;flex:none;padding:2px;border-radius:7px;background:rgba(255,255,255,.04)}
.wbd-lsBtn{height:22px;padding:0 7px;border:none;border-radius:5px;background:transparent;color:var(--dsw-alias-label-tertiary,#8a8f98);font:inherit;font-size:10.5px;cursor:pointer;white-space:nowrap}
.wbd-lsBtn:hover{background:rgba(255,255,255,.07);color:var(--dsw-alias-label-primary,#e6e6e6)}
.wbd-lsBtn.is-on{background:rgba(255,255,255,.10);color:var(--dsw-alias-label-primary,#fff)}
/* T1/T2 keep the bar to one line: the workspace NAME is the part that must never
   leave the screen, so only the path and the counters fold away. */
[data-w="t1"] .wbd-ctx{min-height:48px}
[data-w="t1"] .wbd-ctxPath,[data-w="t1"] .wbd-ctxMeta{display:none}
[data-w="t1"] .wbd-titleHint,[data-w="t2"] .wbd-titleHint{display:none}
/* The layout switch stays visible at every width so the control is discoverable;
   below three columns it simply has less room to work with. */
.wbd-stack{flex:1;min-height:0;display:flex;overflow:hidden;position:relative}
.wbd-page{display:none;flex:1;min-height:0;min-width:0;flex-direction:column;overflow:hidden}
.wbd-page.is-active{display:flex}
/* One roster, two renderings: pills at t1/t2, a rail at t3/t4. Exactly one is
   ever displayed, so the user can never end up with no navigation at all. */
.wbd-main{display:flex;flex:1;min-height:0;overflow:hidden}
.wbd-rail{display:none;flex-direction:column;align-items:center;gap:3px;width:60px;flex:none;padding:8px 0;background:var(--dsw-alias-bg-layer-1,#1b1e24);border-right:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.07))}
.wbd-railItem{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;width:52px;height:44px;border:none;border-radius:9px;background:transparent;color:var(--dsw-alias-label-tertiary,#8a8f98);font:inherit;font-size:9.5px;cursor:pointer}
.wbd-railItem:hover{background:rgba(255,255,255,.06);color:var(--dsw-alias-label-secondary,#b6bac1)}
.wbd-railItem.is-active{background:rgba(77,107,254,.14);color:var(--dsw-alias-brand-primary,#8fa4ff)}
.wbd-railGlyph{display:flex;align-items:center;justify-content:center}
.wbd-railLabel{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
[data-w="t3"] .wbd-rail,[data-w="t4"] .wbd-rail{display:flex}
[data-w="t3"] .wbd-tabs,[data-w="t4"] .wbd-tabs{display:none}
.wbd-status{display:flex;align-items:center;gap:8px;height:22px;flex:none;padding:0 12px;border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.07));background:#101216;font-family:var(--dsw-font-markdown-code-block,ui-monospace,monospace);font-size:9.5px;color:var(--dsw-alias-label-tertiary,#6f757e)}
.wbd-statusRight{margin-left:auto;white-space:nowrap}
/* 布局切换搬到状态栏：标题栏右上角是窗口按钮的地盘，长期抢不过它。 */
.wbd-statusLayout{display:flex;align-items:center;gap:1px;margin-left:8px;flex:none}
.wbd-status .wbd-lsBtn{height:18px;width:20px;padding:0;display:inline-flex;align-items:center;justify-content:center}
/* Background-task badges: a page that is not open but is DOING something (a burn,
   a live shell) stays visible and one click away. */
.wbd-statusTasks{display:flex;align-items:center;gap:4px;min-width:0;overflow:hidden}
.wbd-task{display:inline-flex;align-items:center;gap:5px;height:16px;padding:0 6px;border:none;border-radius:8px;background:rgba(255,255,255,.06);color:var(--dsw-alias-label-secondary,#b6bac1);font:inherit;font-size:9.5px;font-family:var(--dsw-font-markdown-code-block,ui-monospace,monospace);cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px}
.wbd-task:hover{background:rgba(255,255,255,.12);color:var(--dsw-alias-label-primary,#e6e6e6)}
.wbd-taskDot{width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-state-warn-primary,#e2a03f);flex:none}
.wbd-statusItem.is-dim{opacity:.85}
.wbd-body{flex:1;min-height:0;overflow:hidden;display:flex;flex-direction:column}
.wbd-empty{padding:30px 20px;text-align:center;color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:12px}
.wbd-emptyTitle{font-size:13px;color:var(--dsw-alias-label-primary,#e6e6e6);margin-bottom:6px}
.wbd-emptyHint{line-height:1.6}
.wbd-error{padding:16px;color:var(--dsw-alias-state-error-primary,#ff6b6b);font-size:12px;word-break:break-word}
.wbd-errorTitle{font-weight:600;margin-bottom:6px}
.wbd-errorBody{font-family:var(--dsw-font-markdown-code-block,monospace);white-space:pre-wrap}
.wbd-resizeHandle{position:absolute;right:2px;bottom:2px;display:flex;align-items:center;justify-content:center;width:18px;height:18px;color:var(--dsw-alias-label-tertiary,#6f757e);cursor:nwse-resize}
.wbd-resizeHandle:hover{color:var(--dsw-alias-label-primary,#e6e6e6)}

/* ===== readability baseline: 13px body / 12px secondary / 11px labels ===== */
.wbd-titlebar{min-height:44px}
.wbd-title{font-size:13px}
.wbd-titleHint{font-size:11px}
.wbd-lsBtn{height:24px;width:24px;padding:0;display:inline-flex;align-items:center;justify-content:center}
.wbd-ctx{min-height:60px}
.wbd-ctxName{font-size:13px}
.wbd-ctxPath{font-size:11.5px}
.wbd-branchPill{font-size:12px;height:24px}
.wbd-chip{font-size:11px;height:22px}
.wbd-tabs{height:42px}
.wbd-tab{font-size:13px;height:28px;padding:0 12px}
.wbd-status{font-size:11px;height:26px;gap:10px}
.wbd-task{font-size:10.5px;height:18px}
.wbd-rail{width:64px}
.wbd-railItem{width:56px;height:50px;gap:4px}
.wbd-railLabel{font-size:10.5px}
[data-w="t1"] .wbd-ctx{min-height:52px}

`

    /* ============================== apply ============================== */

    function apply(ctx) {
      const style = document.createElement('style')
      style.setAttribute('data-dsh-workbay-dock', '')
      style.textContent = CSS
      document.head.appendChild(style)
      ctx.effect(() => () => { style.remove() }, 'dsh-workbay-dock: styles')

      const t = translatorOf(ctx)
      /* Global shortcut: Ctrl+E opens/closes the panel from anywhere, including
         while the conversation input has focus (that is the point of a global key). */
      ctx.effect(() => {
        const onKeyDown = (event) => {
          if (isWorkbenchShortcut(event) !== true) return
          event.preventDefault()
          event.stopPropagation()
          setOpen(openState !== true)
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => {
          try { window.removeEventListener('keydown', onKeyDown, true) } catch (error) { void error }
        }
      }, 'dsh-workbay-dock: shortcut')

      ctx.effect(() => () => {
        for (const timer of fallbackTimers) clearTimeout(timer)
        for (const off of fallbackDisposers) { try { off() } catch (error) { void error } }
      }, 'dsh-workbay-dock: fallback cleanup')

      /* Gate 1: the entry button, in the LEFT sidebar's TOP ROW.
         `sidebar.panellist` is the seat that "插件 / 自动化任务 / 更多" sit in,
         so the dock reads as a peer of those — which is what was asked for. */
      ctx.inject(['slots'], (slotCtx) => {
        const slots = slotCtx.get('slots')
        if (slots === undefined || slots === null || typeof slots.inject !== 'function') return
        slotCtx.effect(() => slots.inject('sidebar.panellist', () => slots.register({
          name: 'sidebar.panellist',
          id: 'workbay-dock',
          order: 30,
          label: () => t('button.label'),
          locale: LOCALE_NS,
        }, (slotProps) => E(WorkbenchEntryButton, Object.assign({}, slotProps, { t })))),
        'dsh-workbay-dock: panellist entry')
        /* Fallback: if the top seat never rendered this entry, put it in the
           footer seat instead, which every host composition renders. */
        const timer = setTimeout(() => {
          if (entryMountedFlag) return
          try {
            const off = slots.inject('sidebar.footer.action', () => slots.register({
              name: 'sidebar.footer.action',
              id: 'workbay-dock-fallback',
              order: 40,
              locale: LOCALE_NS,
            }, (slotProps) => E(WorkbenchEntryButton, Object.assign({}, slotProps, { t }))))
            if (typeof off === 'function') fallbackDisposers.push(off)
          } catch (error) {
          }
        }, 4000)
        fallbackTimers.push(timer)
      })

      /* Gate 2: the global overlay.
         It mounts through ReactDOM's own root into a node this plugin owns at the
         end of <body>. That is deliberate: slots.render(name, props) renders a
         REGISTERED factory by name (it cannot mount an arbitrary component), and
         every slot seat is owned by a session or a pane — neither can host one
         surface shared by all conversations. A private root has no such scope. */
      const ReactDOM = requireReactDom()
      if (ReactDOM !== null) {
        ctx.effect(() => {
          const container = document.createElement('div')
          container.setAttribute('data-dsh-workbay-dock-root', '')
          document.body.appendChild(container)
          const root = ReactDOM.createRoot(container)
          root.render(E(WorkbenchOverlay, { t }))
          return () => {
            try { root.unmount() } catch (error) { void error }
            try { if (container.parentNode !== null) container.parentNode.removeChild(container) } catch (error) { void error }
          }
        }, 'dsh-workbay-dock: global overlay')
      } else {
        console.error('[workbay-dock] react-dom is not resolvable; the overlay cannot mount')
      }
    }

    return {
      apply,
      name: 'dsh-workbay-dock',
      registerPage: registry.registerPage,
      /* Pages reach these through the `dock` prop as well; exposing them on the
         bundle's own surface keeps a page that only has the global object working. */
      setContext: (patch) => registry.setContext(patch),
      getContext: () => registry.getContext(),
      setStatus: (pageId, text) => registry.setStatus(pageId, text),
      subscribeContext: (listener) => registry.subscribeContext(listener),
      /* The tier/layout rules are exported so the duplicated copy here can be
         pinned by tests against the canonical ones in @dsh-workbay/kit/src/ui.js. */
      shell: { tierForWidth, resolveLayoutKind, normalizeLayoutMode, isWorkbenchShortcut },
      /* The meter's decisions live here as pure functions so they can be tested
         by BEHAVIOR. The earlier string-matching tests stayed green even with the
         component deleted; these cannot. */
      meter: {
        level: meterLevel,
        hasSample: meterHasSample,
        gpuMissing: meterGpuMissing,
        isStale: meterIsStale,
        nextRetryState: meterNextRetryState,
      },
      open: () => setOpen(true),
      close: () => setOpen(false),
    }
  },
})
