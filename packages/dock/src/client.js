/**
 * dsh-workbench-dock — client half (v0.2, GLOBAL dock).
 *
 * ONE button at the BOTTOM OF THE LEFT SIDEBAR (`sidebar.footer.action`, the
 * same seat the Cordis panel uses). Clicking it opens a GLOBAL overlay window
 * that belongs to this plugin alone.
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
 *   window.__DSH_WORKBENCH_DOCK__.registerPage({
 *     id: 'gitcraft', title: 'GitCraft', order: 20,
 *     component: ({ t }) => <MyPanel />,
 *   })
 *
 * Nothing here depends on dsh-better-sidebar.
 */
window.__ModuleLoader__.load({
  id: 'dsh-workbench-dock',
  factory: (require) => {
    const React = require('react')
    const E = React.createElement
    const useState = React.useState
    const useEffect = React.useEffect
    const useMemo = React.useMemo
    const useCallback = React.useCallback
    const useRef = React.useRef

    const GLOBAL_KEY = '__DSH_WORKBENCH_DOCK__'
    const STORAGE_OPEN = 'dsh-workbench-dock.open.v1'
    const STORAGE_PAGE = 'dsh-workbench-dock.page.v1'
    const STORAGE_GEOM = 'dsh-workbench-dock.geom.v1'
    const STORAGE_MODE = 'dsh-workbench-dock.mode.v1'
    const STORAGE_DOCK_W = 'dsh-workbench-dock.dockw.v1'
    const LOCALE_NS = 'dsh-workbench-dock'

    /* ============================== i18n ============================== */

    const ZH = {
      'button.label': '工作台',
      'button.tooltip': '打开工作台（全局共用，与当前会话无关）',
      'pane.title': '工作台',
      'pane.empty': '还没有注册任何页面',
      'pane.emptyHint': '插件通过 window.__DSH_WORKBENCH_DOCK__.registerPage 注册页面后，会出现在这里。',
      'pane.global': '全局面板 · 与当前会话无关',
      'pane.close': '关闭',
      'pane.minimize': '收起',
      'pane.resize': '拖动调整大小',
      'pane.docked': '已停靠右侧 · 与会话并排',
      'pane.dock': '停靠到右侧',
      'pane.float': '改为浮动窗口',
    }

    const EN = {
      'button.label': 'Workbench',
      'button.tooltip': 'Open the workbench (global, independent of the session)',
      'pane.title': 'Workbench',
      'pane.empty': 'No pages registered yet',
      'pane.emptyHint': 'A plugin appears here after calling window.__DSH_WORKBENCH_DOCK__.registerPage.',
      'pane.global': 'Global panel · independent of the current session',
      'pane.close': 'Close',
      'pane.minimize': 'Collapse',
      'pane.resize': 'Drag to resize',
      'pane.docked': 'Docked beside the conversation',
      'pane.dock': 'Dock to the right',
      'pane.float': 'Float as a window',
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

    /* ============================== page registry ============================== */

    function createRegistry() {
      const entries = new Map()
      const listeners = new Set()
      const notify = () => { for (const listener of [...listeners]) { try { listener() } catch (error) { void error } } }
      return {
        registerPage(page) {
          if (page === null || typeof page !== 'object') throw new Error('registerPage needs a page object')
          const id = typeof page.id === 'string' ? page.id.trim() : ''
          if (id === '') throw new Error('registerPage needs a non-empty id')
          if (typeof page.component !== 'function') throw new Error('registerPage needs a component')
          entries.set(id, {
            id,
            title: typeof page.title === 'string' && page.title !== '' ? page.title : id,
            order: Number.isFinite(page.order) ? page.order : 100,
            component: page.component,
            icon: typeof page.icon === 'function' ? page.icon : undefined,
          })
          notify()
          return () => { entries.delete(id); notify() }
        },
        list() {
          return [...entries.values()].sort((a, b) => (a.order === b.order ? a.id.localeCompare(b.id) : a.order - b.order))
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
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

    /* ============================== icons ============================== */

    const ICONS = {
      workbench: ['M1.8 4.2h12.4v8.2H1.8z', 'M1.8 7.4h12.4', 'M6.2 7.4v5'],
      close: ['M4 4l8 8', 'M12 4l-8 8'],
      minimize: ['M3.5 8h9'],
      resize: ['M13.5 2.5v11h-11', 'M13.5 6.5v7h-7'],
      dock: ['M1.8 2.5h12.4v11H1.8z', 'M9.5 2.5v11'],
      float: ['M2.5 3.5h8v8h-8z', 'M5.5 2h8v8'],
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
      const isOpen = useOpenFlag()

      /* Float vs docked. Docked is the default because "一边是会话，一边是工作台"
         is the common case; the flag is remembered. */
      const [mode, setModeState] = useState(() => readMode())
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
          document.body.classList.remove('wbd-docked-open')
          return undefined
        }
        document.documentElement.style.setProperty('--wbd-dock-width', dockWidth + 'px')
        document.body.classList.add('wbd-docked-open')
        return () => {
          document.documentElement.style.removeProperty('--wbd-dock-width')
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
          const nextW = Math.max(360, Math.min(window.innerWidth - 320, drag.startW - (moveEvent.clientX - drag.startX)))
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

      /* Esc closes the dock; that is the only keyboard binding, so it can never
         shadow a page's own shortcuts. */
      useEffect(() => {
        if (!isOpen) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') {
            const target = event.target
            if (target !== null && target !== undefined && typeof target.tagName === 'string'
              && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
            setOpen(false)
          }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [isOpen])

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

      const body = current === null
        ? E('div', { className: 'wbd-empty' },
          E('div', { className: 'wbd-emptyTitle' }, t('pane.empty')),
          E('div', { className: 'wbd-emptyHint' }, t('pane.emptyHint')))
        : E(PageBoundary, { key: current.id }, E(current.component, { t, dock: registry }))

      const titlebar = E('div', { className: 'wbd-titlebar' },
        E('span', { className: 'wbd-titleIcon' }, E(Icon, { name: 'workbench', size: 14 })),
        E('span', { className: 'wbd-title' }, t('pane.title')),
        E('span', { className: 'wbd-titleHint' }, mode === 'docked' ? t('pane.docked') : t('pane.global')),
        E('span', { className: 'wbd-titleActions' },
          E('button', {
            type: 'button',
            className: 'wbd-titleBtn',
            title: mode === 'docked' ? t('pane.float') : t('pane.dock'),
            'aria-label': mode === 'docked' ? t('pane.float') : t('pane.dock'),
            onClick: () => setMode(mode === 'docked' ? 'float' : 'docked'),
          }, E(Icon, { name: mode === 'docked' ? 'float' : 'dock', size: 13 })),
          E('button', {
            type: 'button', className: 'wbd-titleBtn', title: t('pane.close'), 'aria-label': t('pane.close'),
            onClick: () => setOpen(false),
          }, E(Icon, { name: 'close', size: 13 }))))

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

      if (mode === 'docked') {
        return E('div', { className: 'wbd-docked', role: 'complementary', 'aria-label': t('pane.title') },
          titlebar,
          tabStrip,
          E('div', { className: 'wbd-body' }, body),
          E('div', {
            className: 'wbd-dockGrip',
            title: t('pane.resize'),
            onPointerDown: onDockResizeStart,
          }))
      }

      return E('div', { className: 'wbd-overlay', role: 'dialog', 'aria-modal': 'false', 'aria-label': t('pane.title') },
        E('div', { className: 'wbd-window', style: { width: geometry.w + 'px', height: geometry.h + 'px' } },
          titlebar,
          tabStrip,
          E('div', { className: 'wbd-body' }, body),
          E('div', {
            className: 'wbd-resizeHandle',
            title: t('pane.resize'),
            onPointerDown: onResizeStart,
          }, E(Icon, { name: 'resize', size: 11 }))))
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

      return E('span', {
        ref: hostRef,
        className: 'wbd-entryBtn' + (isOpen ? ' is-open' : ''),
        role: 'button',
        tabIndex: 0,
        title: t('button.tooltip'),
        'aria-label': t('button.tooltip'),
        'aria-pressed': isOpen,
      }, E(Icon, { name: 'workbench', size }))
    }

    /* ============================== styles ============================== */

    const CSS = `
.wbd-icon{flex:none;display:block}
/* ---- left-sidebar footer button ---- */
.wbd-footerBtn{display:flex;align-items:center;gap:8px;width:100%;padding:6px 9px;border:none;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#b6bac1);font:inherit;font-size:12px;cursor:pointer;text-align:left}
.wbd-footerBtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));color:var(--dsw-alias-label-primary,#fff)}
.wbd-footerBtn.is-open{background:var(--dsw-alias-interactive-bg-active,rgba(77,107,254,.18));color:var(--dsw-alias-label-primary,#fff)}
.wbd-footerLabel{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* ---- global overlay ---- */
.wbd-entryBtn{display:inline-flex;align-items:center;justify-content:center;min-width:28px;height:28px;cursor:pointer;border:none;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#b6bac1);cursor:pointer}
.wbd-entryBtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));color:var(--dsw-alias-label-primary,#fff)}
.wbd-entryBtn.is-open{background:var(--dsw-alias-interactive-bg-active,rgba(77,107,254,.2));color:var(--dsw-alias-brand-primary,#7c93ff)}
/* Docked: a real column on the right edge; the shell is padded so the
   conversation keeps its own space and both stay interactive. */
.wbd-docked{position:fixed;top:0;right:0;bottom:0;width:var(--wbd-dock-width,620px);z-index:700;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1,#1b1e24);border-left:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));box-shadow:-8px 0 24px rgba(0,0,0,.28);overflow:hidden}
body.wbd-docked-open{padding-right:var(--wbd-dock-width,620px);box-sizing:border-box;transition:padding-right .12s ease}
.wbd-dockGrip{position:absolute;left:0;top:0;bottom:0;width:6px;cursor:ew-resize}
.wbd-dockGrip:hover{background:var(--dsw-alias-brand-primary,#4d6bfe);opacity:.35}
.wbd-overlay{position:fixed;left:0;top:0;right:0;bottom:0;z-index:900;display:flex;align-items:center;justify-content:center;pointer-events:none}
.wbd-window{pointer-events:auto;display:flex;flex-direction:column;max-width:calc(100vw - 40px);max-height:calc(100vh - 60px);border-radius:var(--dsw-radius-lg,12px);border:1px solid var(--dsw-alias-border-l3,rgba(255,255,255,.16));background:var(--dsw-alias-bg-layer-2,#22262c);box-shadow:var(--dsw-elevation-prominent,0 18px 60px rgba(0,0,0,.55));overflow:hidden;position:relative}
.wbd-titlebar{display:flex;align-items:center;gap:8px;padding:7px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));background:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.04));flex:none}
.wbd-titleIcon{display:flex;color:var(--dsw-alias-brand-primary,#4d6bfe)}
.wbd-title{font-weight:600;font-size:13px}
.wbd-titleHint{flex:1;min-width:0;font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8f98);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wbd-titleActions{display:flex;gap:2px;flex:none}
.wbd-titleBtn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#b6bac1);cursor:pointer}
.wbd-titleBtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.1));color:var(--dsw-alias-label-primary,#fff)}
.wbd-tabs{display:flex;gap:2px;padding:5px 8px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));flex:none}
.wbd-tab{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#b6bac1);font:inherit;font-size:12px;cursor:pointer}
.wbd-tab:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.wbd-tab.is-active{background:var(--dsw-alias-interactive-bg-active,rgba(77,107,254,.16));color:var(--dsw-alias-label-primary,#fff)}
.wbd-tabIcon{display:flex}
.wbd-body{flex:1;min-height:0;overflow:hidden;display:flex;flex-direction:column}
.wbd-empty{padding:30px 20px;text-align:center;color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:12px}
.wbd-emptyTitle{font-size:13px;color:var(--dsw-alias-label-primary,#e6e6e6);margin-bottom:6px}
.wbd-emptyHint{line-height:1.6}
.wbd-error{padding:16px;color:var(--dsw-alias-state-error-primary,#ff6b6b);font-size:12px;word-break:break-word}
.wbd-errorTitle{font-weight:600;margin-bottom:6px}
.wbd-errorBody{font-family:var(--dsw-font-markdown-code-block,monospace);white-space:pre-wrap}
.wbd-resizeHandle{position:absolute;right:2px;bottom:2px;display:flex;align-items:center;justify-content:center;width:18px;height:18px;color:var(--dsw-alias-label-tertiary,#6f757e);cursor:nwse-resize}
.wbd-resizeHandle:hover{color:var(--dsw-alias-label-primary,#e6e6e6)}
`

    /* ============================== apply ============================== */

    function apply(ctx) {
      const style = document.createElement('style')
      style.setAttribute('data-dsh-workbench-dock', '')
      style.textContent = CSS
      document.head.appendChild(style)
      ctx.effect(() => () => { style.remove() }, 'dsh-workbench-dock: styles')

      const t = translatorOf(ctx)
      ctx.effect(() => () => {
        for (const timer of fallbackTimers) clearTimeout(timer)
        for (const off of fallbackDisposers) { try { off() } catch (error) { void error } }
      }, 'dsh-workbench-dock: fallback cleanup')

      /* Gate 1: the entry button, in the LEFT sidebar's TOP ROW.
         `sidebar.panellist` is the seat that "插件 / 自动化任务 / 更多" sit in,
         so the dock reads as a peer of those — which is what was asked for. */
      ctx.inject(['slots'], (slotCtx) => {
        const slots = slotCtx.get('slots')
        if (slots === undefined || slots === null || typeof slots.inject !== 'function') return
        slotCtx.effect(() => slots.inject('sidebar.panellist', () => slots.register({
          name: 'sidebar.panellist',
          id: 'workbench-dock',
          order: 30,
          label: () => t('button.label'),
          locale: LOCALE_NS,
        }, (slotProps) => E(WorkbenchEntryButton, Object.assign({}, slotProps, { t })))),
        'dsh-workbench-dock: panellist entry')

        /* Fallback: if the top seat never rendered this entry, put it in the
           footer seat instead, which every host composition renders. */
        const timer = setTimeout(() => {
          if (entryMountedFlag) return
          try {
            const off = slots.inject('sidebar.footer.action', () => slots.register({
              name: 'sidebar.footer.action',
              id: 'workbench-dock-fallback',
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
          container.setAttribute('data-dsh-workbench-dock-root', '')
          document.body.appendChild(container)
          const root = ReactDOM.createRoot(container)
          root.render(E(WorkbenchOverlay, { t }))
          return () => {
            try { root.unmount() } catch (error) { void error }
            try { if (container.parentNode !== null) container.parentNode.removeChild(container) } catch (error) { void error }
          }
        }, 'dsh-workbench-dock: global overlay')
      } else {
        console.error('[workbench-dock] react-dom is not resolvable; the overlay cannot mount')
      }
    }

    return {
      apply,
      name: 'dsh-workbench-dock',
      registerPage: registry.registerPage,
      open: () => setOpen(true),
      close: () => setOpen(false),
    }
  },
})
