/**
 * dsh-workbay-terminal — client half (ONE ModuleLoader file, plain JavaScript).
 *
 * Registers exactly ONE workbench page (`{ id: 'terminal', order: 40 }`) into
 * `window.__DSH_WORKBAY__`; the dock owns the chrome. Contract: docs/terminal-pty.md §3
 * (plus docs/files-api.md §4/§6 for the page registry).
 *
 * This is a REAL terminal now: xterm.js lives in the lazy chunk
 * `dsh-workbay-terminal:xterm`, every tab owns one xterm instance, one host
 * session id and one SSE stream, and key presses go to the PTY verbatim. When
 * the host answers `hello.mode === 'command'` (no ConPTY) the page emulates the
 * old line-oriented console locally: echo, backspace, Up/Down history, submit on
 * Enter.
 *
 * Hard client-side constraints (docs/architecture.md): no `import`, no JSX, no
 * npm packages in THIS file — only React from the ModuleLoader seed table.
 */
window.__ModuleLoader__.load({
  id: 'dsh-workbay-terminal',
  factory: (require) => {
    const React = require('react')
    const E = React.createElement
    const Fragment = React.Fragment
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const PAGE_ID = 'terminal'
    const API_BASE = 'dsh-workbay-terminal/api'
    const EVENTS_PATH = 'dsh-workbay-terminal/events'
    const ROOT_KEY = 'dsh-workbay.root.v1'
    const LOCALE_NS = 'dsh-workbay-terminal'
    const CHUNK_NAME = 'dsh-workbay-terminal:xterm'
    const CHUNK_ROUTE = '/dsh-workbay-terminal/chunk/xterm.js'

    const DEFAULT_COLS = 80
    const DEFAULT_ROWS = 24
    const MIN_COLS = 20
    const MAX_COLS = 400
    const MIN_ROWS = 5
    const MAX_ROWS = 200
    const RESIZE_DEBOUNCE_MS = 200
    const RECONNECT_DELAY_MS = 1000
    const PROMPT_DELAY_MS = 120
    const MAX_HISTORY = 100
    const COMMAND_PROMPT = '$ '
    const ROOT_POLL_MS = 2000

    /* ============================== i18n ============================== */

    const ZH = {
      'page.terminal': '终端',
      'title': '终端',

      'root.label': '工作区',
      'root.missing': '还没有选择工作区',
      'root.missingHint': '先到「文件」页面选择一个工作区，终端会以它为工作目录。',
      'root.recheck': '重新读取',

      'tab.new': '新建终端',
      'tab.close': '关闭终端',
      'tab.defaultTitle': '终端 {n}',
      'tab.empty': '还没有打开终端',
      'tab.emptyHint': '点击 + 新建一个终端会话；每个标签都是一个独立的 shell。',
      'tab.newShort': '新建终端',

      'status.shell': 'Shell',
      'status.cwd': '目录',
      'status.mode': '模式',
      'status.session': '会话',
      'status.tabs': '标签',
      'status.pty': 'PTY',
      'status.nonPty': '非 PTY',
      'status.idle': '未启动',
      'status.starting': '正在启动…',
      'status.connecting': '正在连接…',
      'status.running': '运行中',
      'status.exited': '已退出（代码 {code}）',
      'status.exitedNoCode': '已退出',
      'status.error': '连接失败',
      'status.none': '—',

      'terminal.loading': '正在加载终端组件…',
      'terminal.starting': '正在启动终端…',
      'terminal.exitedLine': '[已退出，代码 {code}]',
      'terminal.exitedLineNoCode': '[已退出]',
      'terminal.restart': '重新启动',
      'terminal.retry': '重试',
      'terminal.copy': '复制选中内容',
      'terminal.paste': '粘贴',
      'terminal.aria': '终端会话',

      'error.stream': '输出流已断开，自动重连没有成功。',
      'error.bad-request': '工作区路径无效，请到「文件」页面重新选择。',
      'error.session-limit': '同时运行的终端会话已达上限，先关闭一个标签再试。',
      'error.shell-missing': '找不到 shell 程序，请检查插件的 shell 配置。',
      'error.session-closed': '该会话的输入已关闭，请重新启动。',
      'error.not-found': '会话已不存在，请重新启动。',
      'error.network': '无法连接宿主服务。',
      'error.bad-response': '宿主返回了无法解析的响应。',
      'error.forbidden': '没有权限访问该操作。',
      'error.disposed': '插件正在关闭。',
      'error.chunk': '终端组件加载失败：{message}',
      'error.unknown': '操作失败：{message}',
    }

    const EN = {
      'page.terminal': 'Terminal',
      'title': 'Terminal',

      'root.label': 'Workspace',
      'root.missing': 'No workspace selected yet',
      'root.missingHint': 'Choose a workspace on the Files page first — the terminal runs in that directory.',
      'root.recheck': 'Recheck',

      'tab.new': 'New terminal',
      'tab.close': 'Close terminal',
      'tab.defaultTitle': 'Terminal {n}',
      'tab.empty': 'No terminal open',
      'tab.emptyHint': 'Click + to open a terminal session; every tab is its own shell.',
      'tab.newShort': 'New terminal',

      'status.shell': 'Shell',
      'status.cwd': 'CWD',
      'status.mode': 'Mode',
      'status.session': 'Session',
      'status.tabs': 'Tabs',
      'status.pty': 'PTY',
      'status.nonPty': 'non-PTY',
      'status.idle': 'Not started',
      'status.starting': 'Starting…',
      'status.connecting': 'Connecting…',
      'status.running': 'Running',
      'status.exited': 'Exited (code {code})',
      'status.exitedNoCode': 'Exited',
      'status.error': 'Connection failed',
      'status.none': '—',

      'terminal.loading': 'Loading the terminal chunk…',
      'terminal.starting': 'Starting terminal…',
      'terminal.exitedLine': '[exited with code {code}]',
      'terminal.exitedLineNoCode': '[exited]',
      'terminal.restart': 'Restart',
      'terminal.retry': 'Retry',
      'terminal.copy': 'Copy selection',
      'terminal.paste': 'Paste',
      'terminal.aria': 'Terminal session',

      'error.stream': 'The output stream dropped and the single reconnect failed.',
      'error.bad-request': 'That workspace path is invalid — pick one on the Files page.',
      'error.session-limit': 'Too many terminal sessions are open — close a tab first.',
      'error.shell-missing': 'The shell executable was not found; check the plugin’s shell config.',
      'error.session-closed': 'This session’s input is closed — start a new one.',
      'error.not-found': 'That session is gone — start a new one.',
      'error.network': 'Cannot reach the host service.',
      'error.bad-response': 'The host returned an unreadable response.',
      'error.forbidden': 'That operation is not permitted.',
      'error.disposed': 'The plugin is shutting down.',
      'error.chunk': 'The terminal chunk failed to load: {message}',
      'error.unknown': 'Operation failed: {message}',
    }

    const LOCALES = { en: EN }

    function hasOwnKey(object, key) {
      return object !== null && object !== undefined && Object.prototype.hasOwnProperty.call(object, key)
    }

    function fill(template, values) {
      if (values === undefined) return template
      return String(template).replace(/\{(\w+)\}/g, (match, key) => {
        const value = values[key]
        return value === undefined ? match : String(value)
      })
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
      const primary = raw.toLowerCase().replace(/_/g, '-').split('-')[0]
      if (primary === 'zh') return ZH
      if (hasOwnKey(LOCALES, primary)) return LOCALES[primary]
      return EN
    }

    function translatorOf(ctx) {
      let cachedTag = null
      let cachedDict = null
      return (key, values) => {
        const tag = activeLocaleOf(ctx)
        if (tag !== cachedTag) {
          cachedTag = tag
          cachedDict = dictionaryFor(tag)
        }
        const template = hasOwnKey(cachedDict, key) ? cachedDict[key] : (hasOwnKey(EN, key) ? EN[key] : key)
        return fill(template, values)
      }
    }

    function errorText(t, error) {
      const code = error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : 'unknown'
      const message = error instanceof Error ? error.message : String(error)
      const key = 'error.' + code
      const translated = t(key, { message })
      return translated === key ? t('error.unknown', { message }) : translated
    }

    /* ============================== api ============================== */

    class ApiError extends Error {
      constructor(code, message) {
        super(message)
        this.name = 'ApiError'
        this.code = code
      }
    }

    function routeUrl(path) {
      try {
        return new URL(path, document.baseURI).href
      } catch (error) {
        return path
      }
    }

    function apiBase() {
      return routeUrl('/' + API_BASE + '/')
    }

    function eventsUrl(id) {
      return routeUrl('/' + EVENTS_PATH + '?id=' + encodeURIComponent(id))
    }

    async function call(method, payload) {
      let response
      try {
        response = await fetch(apiBase() + method, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload === undefined ? {} : payload),
        })
      } catch (error) {
        throw new ApiError('network', error instanceof Error ? error.message : String(error))
      }
      let body = null
      try {
        body = await response.json()
      } catch (error) {
        throw new ApiError('bad-response', 'HTTP ' + response.status)
      }
      if (body !== null && body !== undefined && body.ok === true) return body.data
      const code = body !== null && body !== undefined && body.error !== undefined ? body.error.code : 'unknown'
      const message = body !== null && body !== undefined && body.error !== undefined ? body.error.message : 'HTTP ' + response.status
      throw new ApiError(code, message)
    }

    /* ============================== root ============================== */

    /**
     * The Files page owns the picker and writes a plain string; accept the
     * legacy JSON `{ path }` / `{ root }` / JSON-string shapes too so a format
     * tweak on that side cannot strand this page.
     */
    function parseRootValue(raw) {
      if (raw === undefined || raw === null) return ''
      const text = String(raw).trim()
      if (text === '') return ''
      if (text.charAt(0) === '{') {
        try {
          const parsed = JSON.parse(text)
          if (parsed !== null && typeof parsed === 'object') {
            if (typeof parsed.path === 'string' && parsed.path.trim() !== '') return parsed.path.trim()
            if (typeof parsed.root === 'string' && parsed.root.trim() !== '') return parsed.root.trim()
          }
        } catch (error) { void error }
        return ''
      }
      if (text.charAt(0) === '"' && text.charAt(text.length - 1) === '"') {
        try {
          const parsed = JSON.parse(text)
          if (typeof parsed === 'string' && parsed.trim() !== '') return parsed.trim()
        } catch (error) { void error }
      }
      return text
    }

    function readRoot() {
      try {
        return parseRootValue(window.localStorage.getItem(ROOT_KEY))
      } catch (error) {
        return ''
      }
    }

    /* ============================== pure helpers ============================== */

    function cx() {
      let output = ''
      for (let index = 0; index < arguments.length; index += 1) {
        const part = arguments[index]
        if (typeof part === 'string' && part !== '') output = output === '' ? part : output + ' ' + part
      }
      return output
    }

    function clampInteger(value, fallback, min, max) {
      const number = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
      return Math.min(max, Math.max(min, number))
    }

    function clampDimensions(cols, rows, fallback) {
      const base = fallback !== null && fallback !== undefined ? fallback : {}
      const fallbackCols = typeof base.cols === 'number' && Number.isFinite(base.cols) ? base.cols : DEFAULT_COLS
      const fallbackRows = typeof base.rows === 'number' && Number.isFinite(base.rows) ? base.rows : DEFAULT_ROWS
      return {
        cols: clampInteger(cols, clampInteger(fallbackCols, DEFAULT_COLS, MIN_COLS, MAX_COLS), MIN_COLS, MAX_COLS),
        rows: clampInteger(rows, clampInteger(fallbackRows, DEFAULT_ROWS, MIN_ROWS, MAX_ROWS), MIN_ROWS, MAX_ROWS),
      }
    }

    /* ---- tabs ---- */

    const TAB_PHASES = ['starting', 'connecting', 'running', 'exited', 'error', 'stopped']

    function createTab(key, title, root) {
      return {
        key,
        title: typeof title === 'string' && title !== '' ? title : String(key),
        root: typeof root === 'string' ? root : '',
        phase: 'starting',
        mode: 'command',
        shell: '',
        cwd: typeof root === 'string' ? root : '',
        exitCode: null,
        error: '',
        renamed: false,
      }
    }

    function reduceTabs(state, action) {
      const base = state !== null && state !== undefined && Array.isArray(state.tabs)
        ? state
        : { tabs: [], activeKey: '' }
      const tabs = base.tabs
      if (action === null || action === undefined || typeof action !== 'object') return base
      switch (action.type) {
        case 'add': {
          const tab = action.tab
          if (tab === null || tab === undefined || typeof tab.key !== 'string' || tab.key === '') return base
          if (tabs.some((entry) => entry.key === tab.key)) return base
          return { tabs: tabs.concat([tab]), activeKey: tab.key }
        }
        case 'close': {
          const index = tabs.findIndex((entry) => entry.key === action.key)
          if (index < 0) return base
          const next = tabs.filter((entry) => entry.key !== action.key)
          let activeKey = base.activeKey
          if (activeKey === action.key) {
            activeKey = next.length === 0 ? '' : next[Math.min(index, next.length - 1)].key
          }
          return { tabs: next, activeKey }
        }
        case 'activate': {
          if (!tabs.some((entry) => entry.key === action.key)) return base
          return { tabs, activeKey: action.key }
        }
        case 'rename': {
          const title = typeof action.title === 'string' ? action.title.trim() : ''
          if (title === '') return base
          return {
            tabs: tabs.map((entry) => (entry.key === action.key ? Object.assign({}, entry, { title, renamed: true }) : entry)),
            activeKey: base.activeKey,
          }
        }
        case 'patch': {
          const patch = action.patch !== null && typeof action.patch === 'object' ? action.patch : {}
          return {
            tabs: tabs.map((entry) => (entry.key === action.key ? Object.assign({}, entry, patch) : entry)),
            activeKey: base.activeKey,
          }
        }
        case 'exit': {
          const exitCode = typeof action.code === 'number' && Number.isFinite(action.code) ? action.code : null
          return {
            tabs: tabs.map((entry) => (entry.key === action.key
              ? Object.assign({}, entry, { phase: 'exited', exitCode, error: '' })
              : entry)),
            activeKey: base.activeKey,
          }
        }
        default:
          return base
      }
    }

    /* ---- SSE payloads ---- */

    function parseSsePayload(data) {
      if (typeof data !== 'string') return null
      const text = data.trim()
      if (text === '') return null
      let payload = null
      try {
        payload = JSON.parse(text)
      } catch (error) {
        return null
      }
      if (payload === null || typeof payload !== 'object') return null
      if (typeof payload.type !== 'string' || payload.type === '') return null
      return payload
    }

    /* ---- command-mode line editor (no ConPTY fallback) ---- */

    function createCommandEditorState() {
      return { line: '', history: [], index: 0, draft: '' }
    }

    function commandEditorReducer(state, action) {
      const base = state !== null && state !== undefined && typeof state === 'object'
        ? state
        : createCommandEditorState()
      const history = Array.isArray(base.history) ? base.history : []
      const line = typeof base.line === 'string' ? base.line : ''
      if (action === null || action === undefined || typeof action !== 'object') return base
      switch (action.type) {
        case 'insert': {
          const text = typeof action.text === 'string' ? action.text : ''
          if (text === '') return base
          return { line: line + text, history, index: history.length, draft: '' }
        }
        case 'backspace': {
          if (line === '') return base
          return { line: line.slice(0, -1), history, index: history.length, draft: '' }
        }
        case 'up': {
          if (history.length === 0) return base
          const index = typeof base.index === 'number' && base.index >= 0 ? Math.min(base.index, history.length) : history.length
          if (index <= 0) {
            return { line: history[0], history, index: 0, draft: index >= history.length ? line : base.draft }
          }
          const draft = index >= history.length ? line : base.draft
          return { line: history[index - 1], history, index: index - 1, draft }
        }
        case 'down': {
          if (history.length === 0) return base
          const index = typeof base.index === 'number' && base.index >= 0 ? Math.min(base.index, history.length) : history.length
          if (index >= history.length) return base
          const next = index + 1
          if (next >= history.length) {
            return { line: typeof base.draft === 'string' ? base.draft : '', history, index: history.length, draft: '' }
          }
          return { line: history[next], history, index: next, draft: base.draft }
        }
        case 'clear':
          return { line: '', history, index: history.length, draft: '' }
        case 'submit': {
          const entry = line.trim() === '' ? history : history.concat([line]).slice(-MAX_HISTORY)
          return { line: '', history: entry, index: entry.length, draft: '' }
        }
        default:
          return base
      }
    }

    function submitCommandLine(state) {
      const base = state !== null && state !== undefined && typeof state === 'object'
        ? state
        : createCommandEditorState()
      const command = typeof base.line === 'string' ? base.line : ''
      return { command, state: commandEditorReducer(base, { type: 'submit' }) }
    }

    function commandEcho(line) {
      return '\r\u001b[2K' + COMMAND_PROMPT + String(line === undefined || line === null ? '' : line)
    }

    function normalizeCommandInput(text) {
      return String(text === undefined || text === null ? '' : text)
        .replace(/[\r\n]/g, '')
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    }

    function normalizeTerminalPaste(text) {
      return String(text === undefined || text === null ? '' : text).replace(/\r\n|\r|\n/g, '\r')
    }

    /* ---- theme from DSH CSS variables ---- */

    const DARK_PALETTE = {
      black: '#1e1e1e',
      red: '#cd3131',
      green: '#0dbc79',
      yellow: '#e5e510',
      blue: '#2472c8',
      magenta: '#bc3fbc',
      cyan: '#11a8cd',
      white: '#e5e5e5',
      brightBlack: '#666666',
      brightRed: '#f14c4c',
      brightGreen: '#23d18b',
      brightYellow: '#f5f543',
      brightBlue: '#3b8eea',
      brightMagenta: '#d670d6',
      brightCyan: '#29b8db',
      brightWhite: '#ffffff',
    }

    const LIGHT_PALETTE = {
      black: '#000000',
      red: '#cd3131',
      green: '#00bc00',
      yellow: '#949800',
      blue: '#0451a5',
      magenta: '#bc05bc',
      cyan: '#0598bc',
      white: '#555555',
      brightBlack: '#666666',
      brightRed: '#cd3131',
      brightGreen: '#14ce14',
      brightYellow: '#b5ba00',
      brightBlue: '#0451a5',
      brightMagenta: '#bc05bc',
      brightCyan: '#0598bc',
      brightWhite: '#a5a5a5',
    }

    function colorLuminance(value) {
      const text = String(value === undefined || value === null ? '' : value).trim().toLowerCase()
      let red = 0
      let green = 0
      let blue = 0
      if (/^#[0-9a-f]{3}$/.test(text)) {
        red = parseInt(text.charAt(1) + text.charAt(1), 16)
        green = parseInt(text.charAt(2) + text.charAt(2), 16)
        blue = parseInt(text.charAt(3) + text.charAt(3), 16)
      } else if (/^#[0-9a-f]{6}$/.test(text)) {
        red = parseInt(text.slice(1, 3), 16)
        green = parseInt(text.slice(3, 5), 16)
        blue = parseInt(text.slice(5, 7), 16)
      } else {
        const match = /^rgba?\(\s*([0-9.]+)\s*[, ]\s*([0-9.]+)\s*[, ]\s*([0-9.]+)/.exec(text)
        if (match === null) return null
        red = Number(match[1])
        green = Number(match[2])
        blue = Number(match[3])
      }
      if (!Number.isFinite(red) || !Number.isFinite(green) || !Number.isFinite(blue)) return null
      return (0.299 * red + 0.587 * green + 0.114 * blue) / 255
    }

    function isDarkColor(value) {
      const luminance = colorLuminance(value)
      return luminance === null ? true : luminance < 0.5
    }

    function withAlpha(color, alpha) {
      const text = String(color === undefined || color === null ? '' : color).trim()
      const six = /^#([0-9a-f]{6})$/i.exec(text)
      if (six !== null) {
        const red = parseInt(six[1].slice(0, 2), 16)
        const green = parseInt(six[1].slice(2, 4), 16)
        const blue = parseInt(six[1].slice(4, 6), 16)
        return 'rgba(' + red + ',' + green + ',' + blue + ',' + alpha + ')'
      }
      return text === '' ? 'rgba(77,107,254,' + alpha + ')' : text
    }

    function themeFromVars(vars) {
      const source = vars !== null && vars !== undefined && typeof vars === 'object' ? vars : {}
      const pick = (key, fallback) => (typeof source[key] === 'string' && source[key].trim() !== '' ? source[key].trim() : fallback)
      const background = pick('background', '#14161a')
      const foreground = pick('foreground', '#e6e6e6')
      const brand = pick('brand', '#4d6bfe')
      const mono = pick('mono', 'ui-monospace, SFMono-Regular, Consolas, monospace')
      const palette = isDarkColor(background) ? DARK_PALETTE : LIGHT_PALETTE
      const theme = {
        background,
        foreground,
        cursor: brand,
        cursorAccent: background,
        selectionBackground: withAlpha(brand, 0.35),
        selectionForeground: foreground,
        fontFamily: mono,
        fontSize: 12,
      }
      for (const key of Object.keys(palette)) theme[key] = palette[key]
      return theme
    }

    function readThemeVars() {
      if (typeof document !== 'object' || document === null) return {}
      let computed = null
      try {
        if (typeof getComputedStyle === 'function') computed = getComputedStyle(document.documentElement)
      } catch (error) {
        computed = null
      }
      if (computed === null || computed === undefined) return {}
      const read = (names) => {
        for (let index = 0; index < names.length; index += 1) {
          try {
            const value = String(computed.getPropertyValue(names[index]) || '').trim()
            if (value !== '') return value
          } catch (error) { void error }
        }
        return ''
      }
      return {
        background: read(['--dsw-alias-bg-layer-1', '--dsw-alias-bg-base']),
        foreground: read(['--dsw-alias-label-primary']),
        brand: read(['--dsw-alias-brand-primary']),
        mono: read(['--dsw-font-family-mono', '--dsw-font-markdown-code-block']),
      }
    }

    /* ---- lazy chunk ---- */

    let chunkPromise = null

    function chunkFactoryFromGlobal() {
      const registry = typeof globalThis === 'object' && globalThis !== null ? globalThis.__dshChunks__ : undefined
      if (registry === undefined || registry === null) return undefined
      return registry[CHUNK_NAME]
    }

    function loadChunk() {
      if (chunkPromise !== null) return chunkPromise
      const start = new Promise((resolve, reject) => {
        const registered = chunkFactoryFromGlobal()
        if (typeof registered === 'function') {
          try {
            resolve(registered({ modules: { react: React } }))
          } catch (error) {
            reject(error)
          }
          return
        }
        if (typeof document === 'undefined' || document === null) {
          reject(new Error('no document to inject the terminal chunk into'))
          return
        }
        const script = document.createElement('script')
        script.src = routeUrl(CHUNK_ROUTE)
        script.async = true
        script.setAttribute('data-dsh-workbay-chunk', CHUNK_NAME)
        const cleanup = () => {
          script.onload = null
          script.onerror = null
        }
        script.onload = () => {
          cleanup()
          const factory = chunkFactoryFromGlobal()
          if (typeof factory !== 'function') {
            reject(new Error('chunk ' + CHUNK_NAME + ' did not register itself'))
            return
          }
          try {
            resolve(factory({ modules: { react: React } }))
          } catch (error) {
            reject(error)
          }
        }
        script.onerror = () => {
          cleanup()
          reject(new Error('failed to load chunk ' + CHUNK_NAME))
        }
        const parent = document.head !== undefined && document.head !== null ? document.head : document.documentElement
        parent.appendChild(script)
      })
      chunkPromise = start.then(
        (moduleExports) => moduleExports,
        (error) => {
          chunkPromise = null
          throw error instanceof Error ? error : new Error(String(error))
        },
      )
      return chunkPromise
    }

    let xtermCssInjected = false

    function injectXtermCss(css) {
      if (xtermCssInjected || typeof css !== 'string' || css === '') return
      if (typeof document === 'undefined' || document === null) return
      const style = document.createElement('style')
      style.setAttribute('data-dsh-workbay-terminal-xterm', '')
      style.textContent = css
      const parent = document.head !== undefined && document.head !== null ? document.head : document.documentElement
      if (parent === null || parent === undefined) return
      parent.appendChild(style)
      xtermCssInjected = true
    }

    /* ============================== icons ============================== */

    const ICON_PATHS = {
      terminal: ['M3 4.5L7 8l-4 3.5', 'M8.5 11.5h4.5'],
      plus: ['M8 3v10', 'M3 8h10'],
      close: ['M4 4l8 8', 'M12 4l-8 8'],
      restart: ['M13 8a5 5 0 1 1-1.5-3.6', 'M13.5 2.5v3h-3'],
      warning: ['M8 2.5l6 11H2l6-11z', 'M8 6.5v3.5', 'M8 12h.01'],
      play: ['M5 3.5l7 4.5-7 4.5z'],
      copy: ['M5.5 5.5h7v7h-7z', 'M10.5 5.5V3h-7v7h2'],
    }

    function Icon(props) {
      const size = props.size === undefined ? 14 : props.size
      const shape = hasOwnKey(ICON_PATHS, props.name) ? ICON_PATHS[props.name] : ICON_PATHS.terminal
      return E('svg', {
        className: cx('dswt-icon', props.className),
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      }, shape.map((d, index) => E('path', { key: index, d })))
    }

    function statusLabel(t, phase) {
      const key = 'status.' + phase
      const label = t(key)
      return label === key ? t('status.idle') : label
    }

    /* ============================== tab bar ============================== */

    function TabBar(props) {
      const {
        t, tabs, activeKey, renamingKey, renameDraft,
        onActivate, onClose, onNew, onBeginRename, onRenameDraft, onRenameCommit, onRenameCancel,
      } = props
      return E('div', { className: 'dswt-tabbar', role: 'tablist' },
        tabs.map((tab) => {
          const active = tab.key === activeKey
          if (renamingKey === tab.key) {
            return E('div', { key: tab.key, className: 'dswt-tab is-active is-renaming' },
              E('input', {
                className: 'dswt-renameInput',
                type: 'text',
                value: renameDraft,
                autoFocus: true,
                spellCheck: false,
                'aria-label': t('tab.defaultTitle', { n: '' }),
                onChange: (event) => onRenameDraft(event.target.value),
                onBlur: () => onRenameCommit(tab.key),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    onRenameCommit(tab.key)
                  } else if (event.key === 'Escape') {
                    event.preventDefault()
                    onRenameCancel()
                  }
                },
              }))
          }
          return E('div', {
            key: tab.key,
            role: 'tab',
            'aria-selected': active,
            className: cx('dswt-tab', active ? 'is-active' : ''),
            title: tab.title + (tab.error === '' ? '' : '\n' + tab.error),
            onClick: () => onActivate(tab.key),
            onAuxClick: (event) => {
              if (event.button === 1) {
                event.preventDefault()
                onClose(tab.key)
              }
            },
          },
          E('span', { className: cx('dswt-tabDot', 'is-' + tab.phase) }),
          E('span', {
            className: 'dswt-tabLabel',
            onDoubleClick: (event) => {
              event.preventDefault()
              event.stopPropagation()
              onBeginRename(tab.key)
            },
          }, tab.title),
          E('span', {
            className: 'dswt-tabClose',
            role: 'button',
            tabIndex: -1,
            title: t('tab.close'),
            'aria-label': t('tab.close'),
            onClick: (event) => {
              event.stopPropagation()
              onClose(tab.key)
            },
          }, '\u00d7'))
        }),
        E('button', {
          type: 'button',
          className: 'dswt-newTab',
          title: t('tab.new'),
          'aria-label': t('tab.new'),
          onClick: onNew,
        }, E(Icon, { name: 'plus', size: 13 })))
    }

    /* ============================== status bar ============================== */

    function StatusBar(props) {
      const { t, tab, tabCount } = props
      const mode = tab === null || tab === undefined ? 'command' : tab.mode
      const shell = tab === null || tab === undefined || tab.shell === '' ? '' : tab.shell
      const cwd = tab === null || tab === undefined ? '' : tab.cwd
      const phase = tab === null || tab === undefined ? 'idle' : tab.phase
      return E('div', { className: 'dswt-statusbar' },
        E('span', { className: 'dswt-statusItem', title: t('status.shell') },
          E('span', { className: 'dswt-statusKey' }, t('status.shell')),
          E('span', { className: 'dswt-statusValue' }, shell === '' ? t('status.none') : shell)),
        E('span', { className: 'dswt-statusItem is-grow', title: cwd },
          E('span', { className: 'dswt-statusKey' }, t('status.cwd')),
          E('span', { className: 'dswt-statusValue' }, cwd === '' ? t('status.none') : cwd)),
        E('span', { className: 'dswt-statusItem', title: t('status.mode') },
          E('span', { className: 'dswt-statusKey' }, t('status.mode')),
          E('span', { className: cx('dswt-modeBadge', mode === 'pty' ? 'is-pty' : 'is-command') },
            mode === 'pty' ? t('status.pty') : t('status.nonPty'))),
        E('span', { className: 'dswt-statusItem', title: t('status.session') },
          E('span', { className: 'dswt-statusKey' }, t('status.session')),
          E('span', { className: 'dswt-statusValue' }, String(tabCount))),
        E('span', { className: 'dswt-statusItem is-end', title: t('title') },
          E('span', { className: cx('dswt-phase', 'is-' + phase) }, E('span', { className: 'dswt-dot' }), E('span', null, statusLabel(t, phase)))))
    }

    /* ============================== empty state ============================== */

    function RootEmpty(props) {
      const { t, onRecheck } = props
      return E('div', { className: 'dswt-empty' },
        E('div', { className: 'dswt-emptyIcon' }, E(Icon, { name: 'terminal', size: 30 })),
        E('div', { className: 'dswt-emptyTitle' }, t('root.missing')),
        E('div', { className: 'dswt-emptyHint' }, t('root.missingHint')),
        E('button', { type: 'button', className: 'dswt-btn', onClick: onRecheck }, t('root.recheck')))
    }

    /* ============================== one terminal tab ============================== */

    function TerminalTab(props) {
      const { t, tabKey, root, active, theme, onStatus, onTitle } = props
      const initial = { phase: 'starting', mode: 'command', shell: '', cwd: root, exitCode: null, error: '' }
      const [view, setView] = useState(initial)
      const hostRef = useRef(null)
      const statusRef = useRef(initial)
      const handleRef = useRef(null)
      const tRef = useRef(t)
      const activeRef = useRef(active)
      const themeRef = useRef(theme)
      const rootRef = useRef(root)
      const onStatusRef = useRef(onStatus)
      const onTitleRef = useRef(onTitle)
      const actionsRef = useRef(null)

      tRef.current = t
      activeRef.current = active
      themeRef.current = theme
      rootRef.current = root
      onStatusRef.current = onStatus
      onTitleRef.current = onTitle

      /* Fit/focus when the tab becomes visible (hidden terminals have no size). */
      useEffect(() => {
        if (active !== true) return undefined
        let frame = null
        const fit = () => {
          const handle = handleRef.current
          if (handle === null || handle === undefined) return
          try { handle.fit() } catch (error) { void error }
          try { handle.focus() } catch (error) { void error }
        }
        if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(fit)
        else frame = setTimeout(fit, 0)
        return () => {
          if (frame === null) return
          if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
          else clearTimeout(frame)
        }
      }, [active])

      /* The whole session engine lives in one mount effect: xterm chunk, SSE,
         command-mode line editor, resize debounce and teardown. */
      useEffect(() => {
        const host = hostRef.current
        const core = {
          cancelled: false,
          session: null,
          mode: 'command',
          phase: 'starting',
          es: null,
          reconnectUsed: false,
          reconnectTimer: null,
          resizeTimer: null,
          promptTimer: null,
          editor: createCommandEditorState(),
          promptShown: false,
          awaiting: false,
          lineStart: true,
          exited: false,
        }

        function commit(patch) {
          if (core.cancelled) return
          if (patch !== null && patch !== undefined && typeof patch.phase === 'string') core.phase = patch.phase
          const next = Object.assign({}, statusRef.current, patch)
          statusRef.current = next
          setView(next)
          const callback = onStatusRef.current
          if (typeof callback === 'function') callback(tabKey, patch)
        }

        function writeTracked(text) {
          if (typeof text !== 'string' || text === '') return
          const handle = handleRef.current
          if (handle !== null && handle !== undefined) handle.write(text)
          core.lineStart = text.charAt(text.length - 1) === '\n'
        }

        function closeStream() {
          const source = core.es
          core.es = null
          if (source !== null && source !== undefined) {
            try { source.close() } catch (error) { void error }
          }
        }

        function closeReconnect() {
          if (core.reconnectTimer !== null) {
            clearTimeout(core.reconnectTimer)
            core.reconnectTimer = null
          }
        }

        function clearPromptTimer() {
          if (core.promptTimer !== null) {
            clearTimeout(core.promptTimer)
            core.promptTimer = null
          }
        }

        function sendInput(data) {
          const session = core.session
          if (session === null || session === undefined || typeof session.id !== 'string') return
          if (typeof data !== 'string' || data === '') return
          void call('input', { id: session.id, data }).catch((error) => {
            if (core.cancelled) return
            const code = error !== null && error !== undefined ? error.code : undefined
            if (code === 'not-found' || code === 'session-closed') {
              closeStream()
              commit({ phase: 'exited', error: '' })
              return
            }
            commit({ error: errorText(tRef.current, error) })
          })
        }

        /* ---- command mode (no PTY) ---- */

        function redrawCommandLine() {
          const handle = handleRef.current
          if (handle === null || handle === undefined) return
          handle.write(commandEcho(core.editor.line))
          core.lineStart = false
          core.promptShown = true
        }

        function showPrompt() {
          if (core.mode !== 'command') return
          if (!core.lineStart) writeTracked('\r\n')
          writeTracked(COMMAND_PROMPT)
          core.lineStart = false
          core.promptShown = true
          core.awaiting = false
        }

        function schedulePrompt() {
          if (core.mode !== 'command') return
          clearPromptTimer()
          core.promptTimer = setTimeout(() => {
            core.promptTimer = null
            if (core.cancelled || core.mode !== 'command' || core.phase !== 'running') return
            showPrompt()
          }, PROMPT_DELAY_MS)
        }

        function submitCommand() {
          if (core.mode !== 'command') return
          const result = submitCommandLine(core.editor)
          core.editor = result.state
          writeTracked('\r\n')
          core.lineStart = true
          core.awaiting = true
          if (result.command !== '') sendInput(result.command + '\n')
          schedulePrompt()
        }

        function clearCommandScreen() {
          const handle = handleRef.current
          if (handle !== null && handle !== undefined) {
            try { handle.reset() } catch (error) { void error }
          }
          core.lineStart = true
          core.promptShown = false
          core.editor = createCommandEditorState()
          showPrompt()
        }

        function handleCommandData(data) {
          if (data === '\r' || data === '\n') {
            submitCommand()
            return
          }
          if (data === '\u007f' || data === '\b') {
            core.editor = commandEditorReducer(core.editor, { type: 'backspace' })
            redrawCommandLine()
            return
          }
          if (data === '\u001b[A') {
            core.editor = commandEditorReducer(core.editor, { type: 'up' })
            redrawCommandLine()
            return
          }
          if (data === '\u001b[B') {
            core.editor = commandEditorReducer(core.editor, { type: 'down' })
            redrawCommandLine()
            return
          }
          if (data === '\u0003') {
            writeTracked('^C\r\n')
            core.lineStart = true
            core.editor = createCommandEditorState()
            showPrompt()
            return
          }
          if (data === '\u000c') {
            clearCommandScreen()
            return
          }
          const text = normalizeCommandInput(data)
          if (text === '') return
          core.editor = commandEditorReducer(core.editor, { type: 'insert', text })
          redrawCommandLine()
        }

        function handleData(data) {
          if (core.cancelled) return
          if (core.phase === 'starting') return
          if (core.mode === 'pty') {
            sendInput(data)
            return
          }
          handleCommandData(data)
        }

        /* ---- resize ---- */

        function scheduleResize(cols, rows) {
          if (core.mode !== 'pty') return
          if (core.resizeTimer !== null) clearTimeout(core.resizeTimer)
          core.resizeTimer = setTimeout(() => {
            core.resizeTimer = null
            if (core.cancelled) return
            const session = core.session
            if (session === null || session === undefined) return
            const dims = clampDimensions(cols, rows)
            void call('resize', { id: session.id, cols: dims.cols, rows: dims.rows }).catch(() => {})
          }, RESIZE_DEBOUNCE_MS)
        }

        /* ---- SSE ---- */

        function handleEvent(payload) {
          if (payload.type === 'hello') {
            const mode = payload.mode === 'pty' ? 'pty' : 'command'
            core.mode = mode
            if (typeof payload.id === 'string' && payload.id !== '') {
              core.session = { id: payload.id, mode }
            }
            commit({
              phase: 'running',
              mode,
              shell: typeof payload.shell === 'string' ? payload.shell : statusRef.current.shell,
              cwd: typeof payload.cwd === 'string' && payload.cwd !== '' ? payload.cwd : statusRef.current.cwd,
              error: '',
            })
            if (mode === 'command' && !core.promptShown) showPrompt()
            if (mode === 'pty') {
              const handle = handleRef.current
              if (handle !== null && handle !== undefined) {
                /* Sync the PTY with the size xterm actually got after layout. */
                scheduleResize(handle.cols, handle.rows)
                if (activeRef.current) handle.focus()
              }
            }
            return
          }
          if (payload.type === 'out') {
            const text = typeof payload.data === 'string' ? payload.data : ''
            if (text === '') return
            writeTracked(text)
            if (core.mode === 'command') {
              core.awaiting = false
              schedulePrompt()
            }
            return
          }
          if (payload.type === 'exit') {
            core.exited = true
            closeStream()
            closeReconnect()
            clearPromptTimer()
            if (core.mode === 'command' && !core.lineStart) writeTracked('\r\n')
            const code = typeof payload.code === 'number' && Number.isFinite(payload.code) ? payload.code : null
            const label = code === null
              ? tRef.current('terminal.exitedLineNoCode')
              : tRef.current('terminal.exitedLine', { code })
            writeTracked('\r\n' + label + '\r\n')
            commit({ phase: 'exited', exitCode: code, error: '' })
            return
          }
          if (payload.type === 'error') {
            const message = typeof payload.message === 'string' && payload.message !== ''
              ? payload.message
              : tRef.current('error.unknown', { message: '' })
            commit({ error: message })
          }
        }

        function connectStream(id) {
          closeStream()
          closeReconnect()
          let source = null
          try {
            source = new EventSource(eventsUrl(id))
          } catch (error) {
            commit({ phase: 'error', error: tRef.current('error.stream') })
            return
          }
          core.es = source
          source.onmessage = (event) => {
            const payload = parseSsePayload(event.data)
            if (payload !== null) handleEvent(payload)
          }
          source.onerror = () => {
            if (core.es !== source) return
            core.es = null
            try { source.close() } catch (error) { void error }
            if (core.cancelled || core.exited) return
            if (core.reconnectUsed) {
              commit({ phase: 'error', error: tRef.current('error.stream') })
              return
            }
            core.reconnectUsed = true
            commit({ phase: 'connecting' })
            core.reconnectTimer = setTimeout(() => {
              core.reconnectTimer = null
              if (!core.cancelled && !core.exited) connectStream(id)
            }, RECONNECT_DELAY_MS)
          }
        }

        /* ---- session lifecycle ---- */

        function adopt(data, previousMode) {
          core.session = {
            id: data.id,
            mode: data.mode === 'pty' ? 'pty' : (previousMode === 'pty' ? 'pty' : 'command'),
          }
          core.mode = core.session.mode
          commit({
            phase: 'connecting',
            mode: core.mode,
            shell: typeof data.shell === 'string' && data.shell !== '' ? data.shell : statusRef.current.shell,
            cwd: typeof data.cwd === 'string' && data.cwd !== '' ? data.cwd : rootRef.current,
            error: '',
            exitCode: null,
          })
          connectStream(data.id)
        }

        async function startSession() {
          if (core.cancelled) return
          closeStream()
          closeReconnect()
          clearPromptTimer()
          core.exited = false
          core.reconnectUsed = false
          core.promptShown = false
          core.awaiting = false
          core.lineStart = true
          core.editor = createCommandEditorState()
          const previous = core.session
          core.session = null
          commit({ phase: 'starting', error: '', exitCode: null })
          if (previous !== null && previous !== undefined && typeof previous.id === 'string') {
            /* Wait for the old session to be reaped: the host enforces a small
               concurrent-session limit and an un-awaited stop can race start. */
            await call('stop', { id: previous.id }).catch(() => {})
            if (core.cancelled) return
          }
          const handle = handleRef.current
          if (handle === null || handle === undefined) {
            commit({ phase: 'error', error: tRef.current('error.chunk', { message: 'terminal not ready' }) })
            return
          }
          const dims = clampDimensions(handle.cols, handle.rows)
          try {
            const data = await call('start', { root: rootRef.current, cols: dims.cols, rows: dims.rows })
            if (core.cancelled) {
              if (data !== null && data !== undefined && typeof data.id === 'string') {
                void call('stop', { id: data.id }).catch(() => {})
              }
              return
            }
            if (data === null || data === undefined || typeof data.id !== 'string' || data.id === '') {
              throw new ApiError('bad-response', 'the host did not return a session id')
            }
            adopt(data, null)
          } catch (error) {
            if (!core.cancelled) commit({ phase: 'error', error: errorText(tRef.current, error) })
          }
        }

        async function restartSession() {
          if (core.cancelled) return
          const previous = core.session
          if (previous === null || previous === undefined || typeof previous.id !== 'string') {
            await startSession()
            return
          }
          closeStream()
          closeReconnect()
          clearPromptTimer()
          core.exited = false
          core.reconnectUsed = false
          core.promptShown = false
          core.awaiting = false
          core.lineStart = true
          core.editor = createCommandEditorState()
          commit({ phase: 'starting', error: '', exitCode: null })
          try {
            const data = await call('restart', { id: previous.id })
            if (core.cancelled) {
              if (data !== null && data !== undefined && typeof data.id === 'string') {
                void call('stop', { id: data.id }).catch(() => {})
              }
              return
            }
            if (data === null || data === undefined || typeof data.id !== 'string' || data.id === '') {
              throw new ApiError('bad-response', 'the host did not return a session id')
            }
            adopt(data, previous.mode)
          } catch (error) {
            if (!core.cancelled) commit({ phase: 'error', error: errorText(tRef.current, error) })
          }
        }

        /* ---- terminal creation ---- */

        async function ensureTerminal() {
          const existing = handleRef.current
          if (existing !== null && existing !== undefined) return existing
          const chunk = await loadChunk()
          if (core.cancelled) return null
          if (chunk === null || chunk === undefined || typeof chunk.createTerminal !== 'function') {
            throw new Error('the terminal chunk has no createTerminal export')
          }
          injectXtermCss(chunk.css)
          const handle = chunk.createTerminal({
            container: host,
            cols: DEFAULT_COLS,
            rows: DEFAULT_ROWS,
            theme: themeRef.current,
            onData: (data) => handleData(data),
            onResize: (cols, rows) => scheduleResize(cols, rows),
            onTitle: (title) => {
              if (typeof title !== 'string') return
              const callback = onTitleRef.current
              if (typeof callback === 'function') callback(tabKey, title)
            },
          })
          handleRef.current = handle
          return handle
        }

        async function boot() {
          if (core.cancelled) return
          try {
            const handle = await ensureTerminal()
            if (core.cancelled || handle === null) return
            if (activeRef.current) {
              try { handle.focus() } catch (error) { void error }
            }
            await startSession()
          } catch (error) {
            if (!core.cancelled) {
              commit({ phase: 'error', error: tRef.current('error.chunk', { message: error instanceof Error ? error.message : String(error) }) })
            }
          }
        }

        /**
         * Retry from the error banner: finish the chunk load if needed, then
         * stop any session the failed stream left behind and start a clean one.
         */
        async function retrySession() {
          if (core.cancelled) return
          if (handleRef.current === null || handleRef.current === undefined) {
            await boot()
            return
          }
          const previous = core.session
          if (previous !== null && previous !== undefined && typeof previous.id === 'string') {
            await call('stop', { id: previous.id }).catch(() => {})
            if (core.cancelled) return
            core.session = null
          }
          await startSession()
        }

        actionsRef.current = {
          retry: () => { void retrySession() },
          restart: () => { void restartSession() },
          start: () => { void startSession() },
          paste: (text) => pasteText(text),
        }

        /* ---- clipboard / keyboard ---- */

        function pasteText(text) {
          const normalized = normalizeTerminalPaste(text)
          if (normalized === '') return
          if (core.mode === 'pty') {
            sendInput(normalized)
            return
          }
          const single = normalizeCommandInput(normalized)
          if (single === '') return
          core.editor = commandEditorReducer(core.editor, { type: 'insert', text: single })
          redrawCommandLine()
        }

        function readClipboard() {
          try {
            if (typeof navigator === 'object' && navigator !== null && navigator.clipboard !== undefined
              && typeof navigator.clipboard.readText === 'function') {
              navigator.clipboard.readText().then((text) => {
                if (!core.cancelled) pasteText(text)
              }).catch(() => {})
            }
          } catch (error) { void error }
        }

        function onKeyDown(event) {
          if (event === null || event === undefined) return
          if (event.ctrlKey !== true && event.metaKey !== true) return
          if (event.shiftKey !== true) return
          const key = String(event.key === undefined ? '' : event.key).toLowerCase()
          if (key === 'c') {
            const handle = handleRef.current
            const selection = handle !== null && handle !== undefined && typeof handle.getSelection === 'function'
              ? handle.getSelection()
              : ''
            if (selection === '') return
            event.preventDefault()
            event.stopPropagation()
            try {
              if (typeof navigator === 'object' && navigator !== null && navigator.clipboard !== undefined
                && typeof navigator.clipboard.writeText === 'function') {
                navigator.clipboard.writeText(selection).catch(() => {})
              }
            } catch (error) { void error }
            return
          }
          if (key === 'v') {
            const canRead = typeof navigator === 'object' && navigator !== null
              && navigator.clipboard !== undefined && navigator.clipboard !== null
              && typeof navigator.clipboard.readText === 'function'
            if (!canRead) return /* let the shell's native paste path handle it */
            event.preventDefault()
            event.stopPropagation()
            readClipboard()
          }
        }

        function onWindowResize() {
          if (!activeRef.current) return
          const handle = handleRef.current
          if (handle !== null && handle !== undefined) {
            try { handle.fit() } catch (error) { void error }
          }
        }

        if (host !== null && host !== undefined && typeof host.addEventListener === 'function') {
          host.addEventListener('keydown', onKeyDown, true)
        }
        if (typeof window === 'object' && window !== null) window.addEventListener('resize', onWindowResize)
        let observer = null
        if (typeof ResizeObserver === 'function' && host !== null && host !== undefined) {
          try {
            observer = new ResizeObserver(() => {
              if (!activeRef.current) return
              const handle = handleRef.current
              if (handle !== null && handle !== undefined) {
                try { handle.fit() } catch (error) { void error }
              }
            })
            observer.observe(host)
          } catch (error) {
            observer = null
          }
        }

        void boot()

        return () => {
          core.cancelled = true
          closeStream()
          closeReconnect()
          clearPromptTimer()
          if (core.resizeTimer !== null) {
            clearTimeout(core.resizeTimer)
            core.resizeTimer = null
          }
          if (host !== null && host !== undefined && typeof host.removeEventListener === 'function') {
            host.removeEventListener('keydown', onKeyDown, true)
          }
          if (typeof window === 'object' && window !== null) window.removeEventListener('resize', onWindowResize)
          if (observer !== null) {
            try { observer.disconnect() } catch (error) { void error }
          }
          const session = core.session
          core.session = null
          if (session !== null && session !== undefined && typeof session.id === 'string') {
            void call('stop', { id: session.id }).catch(() => {})
          }
          const handle = handleRef.current
          handleRef.current = null
          if (handle !== null && handle !== undefined && typeof handle.dispose === 'function') {
            try { handle.dispose() } catch (error) { void error }
          }
        }
      }, [])

      const exitLabel = view.exitCode === null
        ? t('status.exitedNoCode')
        : t('status.exited', { code: view.exitCode })

      return E('div', {
        className: cx('dswt-panel', active === true ? 'is-active' : ''),
        style: { display: active === true ? 'flex' : 'none' },
        'data-tab': tabKey,
        role: 'tabpanel',
        'aria-label': t('terminal.aria'),
      },
      view.error === '' ? null : E('div', { className: 'dswt-error', role: 'alert' },
        E(Icon, { name: 'warning', size: 13 }),
        E('span', { className: 'dswt-errorText' }, view.error),
        E('button', {
          type: 'button',
          className: 'dswt-btn is-small',
          onClick: () => { const actions = actionsRef.current; if (actions !== null) actions.retry() },
        }, t('terminal.retry'))),
      E('div', { className: 'dswt-termHost', ref: hostRef }),
      view.phase === 'exited'
        ? E('div', { className: 'dswt-exitBar' },
          E('span', { className: 'dswt-exitText' }, exitLabel),
          E('button', {
            type: 'button',
            className: 'dswt-btn is-small is-primary',
            onClick: () => { const actions = actionsRef.current; if (actions !== null) actions.restart() },
          }, E(Icon, { name: 'restart', size: 12 }), E('span', null, t('terminal.restart'))))
        : null,
      view.phase === 'starting' || view.phase === 'connecting'
        ? E('div', { className: 'dswt-loading' }, t('terminal.starting'))
        : null)
    }

    /* ============================== page ============================== */

    function TerminalPage(props) {
      const t = props.t
      const [root, setRoot] = useState(readRoot)
      const [tabState, setTabState] = useState({ tabs: [], activeKey: '' })
      const [renamingKey, setRenamingKey] = useState('')
      const [renameDraft, setRenameDraft] = useState('')
      const counterRef = useRef(0)
      const tabsRef = useRef(tabState.tabs)
      tabsRef.current = tabState.tabs
      const autoOpenedRef = useRef(false)
      const theme = useMemo(() => themeFromVars(readThemeVars()), [])

      /* The Files page owns the root; this page follows it. */
      useEffect(() => {
        const sync = () => setRoot((current) => {
          const next = readRoot()
          return next === current ? current : next
        })
        const onStorage = (event) => {
          if (event === null || event.key === null || event.key === ROOT_KEY) sync()
        }
        window.addEventListener('storage', onStorage)
        window.addEventListener('focus', sync)
        return () => {
          window.removeEventListener('storage', onStorage)
          window.removeEventListener('focus', sync)
        }
      }, [])

      /* Same-document writes emit no `storage` event; a 2 s string compare keeps
         the terminal on the same workspace as the Files page. */
      useEffect(() => {
        const timer = setInterval(() => {
          const next = readRoot()
          setRoot((current) => (next === current ? current : next))
        }, ROOT_POLL_MS)
        return () => clearInterval(timer)
      }, [])

      /* A cleared workspace cannot host sessions: close the tabs so their xterm
         instances and host sessions are torn down with the page's empty state. */
      useEffect(() => {
        if (root !== '') return
        setRenamingKey('')
        setRenameDraft('')
        if (tabsRef.current.length > 0) setTabState({ tabs: [], activeKey: '' })
      }, [root])

      const addTab = useCallback(() => {
        if (root === '') return
        counterRef.current += 1
        const key = 'tab-' + String(counterRef.current)
        const tab = createTab(key, t('tab.defaultTitle', { n: counterRef.current }), root)
        setTabState((current) => reduceTabs(current, { type: 'add', tab }))
        setRenamingKey('')
      }, [root, t])

      /* Open the first terminal automatically once a workspace exists. Closing
         the last tab stays on the empty-tab state (the + button is still there). */
      useEffect(() => {
        if (root === '') {
          autoOpenedRef.current = false
          return
        }
        if (autoOpenedRef.current) return
        autoOpenedRef.current = true
        addTab()
      }, [root, addTab])

      const closeTab = useCallback((key) => {
        setRenamingKey((current) => (current === key ? '' : current))
        setTabState((current) => reduceTabs(current, { type: 'close', key }))
      }, [])

      const activateTab = useCallback((key) => {
        setTabState((current) => reduceTabs(current, { type: 'activate', key }))
      }, [])

      const handleStatus = useCallback((key, patch) => {
        setTabState((current) => reduceTabs(current, { type: 'patch', key, patch }))
      }, [])

      const handleTitle = useCallback((key, title) => {
        if (typeof title !== 'string') return
        const clean = title.replace(/[\r\n\t]/g, ' ').trim().slice(0, 64)
        if (clean === '') return
        setTabState((current) => {
          const tab = current.tabs.find((entry) => entry.key === key)
          if (tab === undefined || tab.renamed === true) return current
          return reduceTabs(current, { type: 'patch', key, patch: { title: clean } })
        })
      }, [])

      const beginRename = useCallback((key) => {
        const tab = tabsRef.current.find((entry) => entry.key === key)
        if (tab === undefined) return
        setRenamingKey(key)
        setRenameDraft(tab.title)
      }, [])

      const commitRename = useCallback((key) => {
        setRenamingKey((current) => {
          if (current !== key) return current
          return ''
        })
        const title = renameDraft.trim()
        setRenameDraft('')
        if (title === '') return
        setTabState((current) => reduceTabs(current, { type: 'rename', key, title }))
      }, [renameDraft])

      const cancelRename = useCallback(() => {
        setRenamingKey('')
        setRenameDraft('')
      }, [])

      const activeKey = tabState.activeKey !== ''
        ? tabState.activeKey
        : (tabState.tabs.length > 0 ? tabState.tabs[0].key : '')

      const activeTab = useMemo(() => {
        for (let index = 0; index < tabState.tabs.length; index += 1) {
          if (tabState.tabs[index].key === activeKey) return tabState.tabs[index]
        }
        return tabState.tabs.length > 0 ? tabState.tabs[0] : null
      }, [tabState, activeKey])

      if (root === '') {
        return E('div', { className: 'dswt-root' }, E(RootEmpty, { t, onRecheck: () => setRoot(readRoot()) }))
      }

      return E('div', { className: 'dswt-root' },
        E(TabBar, {
          t,
          tabs: tabState.tabs,
          activeKey,
          renamingKey,
          renameDraft,
          onActivate: activateTab,
          onClose: closeTab,
          onNew: addTab,
          onBeginRename: beginRename,
          onRenameDraft: setRenameDraft,
          onRenameCommit: commitRename,
          onRenameCancel: cancelRename,
        }),
        E('div', { className: 'dswt-body' },
          tabState.tabs.length === 0
            ? E('div', { className: 'dswt-empty dswt-emptyTabs' },
              E('div', { className: 'dswt-emptyIcon' }, E(Icon, { name: 'terminal', size: 26 })),
              E('div', { className: 'dswt-emptyTitle' }, t('tab.empty')),
              E('div', { className: 'dswt-emptyHint' }, t('tab.emptyHint')),
              E('button', { type: 'button', className: 'dswt-btn is-primary', onClick: addTab }, t('tab.newShort')))
            : tabState.tabs.map((tab) => E(TerminalTab, {
              key: tab.key,
              t,
              tabKey: tab.key,
              root: tab.root,
              active: tab.key === activeKey,
              theme,
              onStatus: handleStatus,
              onTitle: handleTitle,
            }))),
        E(StatusBar, { t, tab: activeTab, tabCount: tabState.tabs.length }))
    }

    /* ============================== styles ============================== */

    const CSS = `
.dswt-root{display:flex;flex-direction:column;flex:1 1 auto;height:100%;min-height:0;background:var(--dsw-alias-bg-base,#14161a);color:var(--dsw-alias-label-primary,#e6e6e6);font-size:12px}
.dswt-tabbar{display:flex;align-items:stretch;flex:none;min-height:31px;max-height:31px;overflow-x:auto;overflow-y:hidden;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));background:var(--dsw-alias-bg-layer-1,#1b1e24);scrollbar-width:thin}
.dswt-tab{display:flex;align-items:center;gap:5px;flex:none;max-width:190px;padding:0 8px;border:none;border-right:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));background:transparent;color:var(--dsw-alias-label-secondary,#b6bac1);font:inherit;font-size:11px;cursor:pointer;user-select:none}
.dswt-tab:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.05))}
.dswt-tab.is-active{background:var(--dsw-alias-bg-layer-2,#22262c);color:var(--dsw-alias-label-primary,#e6e6e6);box-shadow:inset 0 -2px 0 var(--dsw-alias-brand-primary,#4d6bfe)}
.dswt-tab.is-renaming{min-width:120px}
.dswt-tabLabel{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:130px}
.dswt-tabDot{width:6px;height:6px;border-radius:50%;flex:none;background:var(--dsw-alias-label-tertiary,#8a8f98)}
.dswt-tabDot.is-running,.dswt-tabDot.is-connecting{background:var(--dsw-alias-state-success-primary,#3fb950)}
.dswt-tabDot.is-starting{background:var(--dsw-alias-state-warn-primary,#e2a03f)}
.dswt-tabDot.is-exited{background:var(--dsw-alias-label-tertiary,#8a8f98)}
.dswt-tabDot.is-error{background:var(--dsw-alias-state-error-primary,#ff6b6b)}
.dswt-tabClose{display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;border-radius:3px;flex:none;font-size:13px;line-height:1;color:var(--dsw-alias-label-tertiary,#8a8f98)}
.dswt-tabClose:hover{background:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.12));color:var(--dsw-alias-label-primary,#fff)}
.dswt-renameInput{width:110px;height:21px;padding:0 5px;border:1px solid var(--dsw-alias-brand-primary,#4d6bfe);border-radius:4px;background:var(--dsw-alias-bg-base,#14161a);color:inherit;font:inherit;font-size:11px}
.dswt-renameInput:focus{outline:none}
.dswt-newTab{display:inline-flex;align-items:center;justify-content:center;flex:none;width:30px;border:none;background:transparent;color:var(--dsw-alias-label-secondary,#b6bac1);cursor:pointer}
.dswt-newTab:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07));color:var(--dsw-alias-label-primary,#fff)}
.dswt-body{position:relative;flex:1;min-height:0;display:flex;flex-direction:column}
.dswt-panel{position:relative;flex:1 1 auto;min-height:0;flex-direction:column;background:var(--dsw-alias-bg-layer-1,#1b1e24)}
.dswt-termHost{flex:1;min-height:0;overflow:hidden;padding:2px 0 2px 2px}
.dswt-termHost .xterm{height:100%}
.dswt-termHost .xterm-viewport{background:transparent!important}
.dswt-error{display:flex;align-items:center;gap:6px;flex:none;padding:5px 9px;color:var(--dsw-alias-state-error-primary,#ff6b6b);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ff6b6b) 13%,transparent);font-size:11px;line-height:1.5}
.dswt-errorText{flex:1;min-width:0;word-break:break-word}
.dswt-exitBar{display:flex;align-items:center;gap:8px;flex:none;padding:4px 9px;border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.04));font-size:11px;color:var(--dsw-alias-label-secondary,#b6bac1)}
.dswt-exitText{flex:1;min-width:0}
.dswt-loading{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#1b1e24) 82%,transparent);color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:11px;pointer-events:none}
.dswt-statusbar{display:flex;align-items:center;gap:10px;flex:none;min-height:24px;padding:2px 8px;border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));background:var(--dsw-alias-bg-layer-1,#1b1e24);color:var(--dsw-alias-label-tertiary,#8a8f98);font-family:var(--dsw-font-markdown-code-block,ui-monospace,Consolas,monospace);font-size:10px;white-space:nowrap;overflow:hidden}
.dswt-statusItem{display:inline-flex;align-items:center;gap:4px;min-width:0;max-width:26%;flex:none}
.dswt-statusItem.is-grow{flex:1 1 auto;max-width:none}
.dswt-statusItem.is-end{margin-left:auto;flex:none}
.dswt-statusKey{color:var(--dsw-alias-label-tertiary,#8a8f98)}
.dswt-statusValue{overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary,#b6bac1)}
.dswt-modeBadge{padding:0 5px;border-radius:3px;font-size:9px;line-height:15px}
.dswt-modeBadge.is-pty{color:var(--dsw-alias-state-success-primary,#3fb950);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#3fb950) 16%,transparent)}
.dswt-modeBadge.is-command{color:var(--dsw-alias-state-warn-primary,#e2a03f);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#e2a03f) 18%,transparent)}
.dswt-phase{display:inline-flex;align-items:center;gap:4px}
.dswt-phase.is-running{color:var(--dsw-alias-state-success-primary,#3fb950)}
.dswt-phase.is-connecting,.dswt-phase.is-starting{color:var(--dsw-alias-state-warn-primary,#e2a03f)}
.dswt-phase.is-error{color:var(--dsw-alias-state-error-primary,#ff6b6b)}
.dswt-dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}
.dswt-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:23px;padding:0 9px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));border-radius:5px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.05));color:var(--dsw-alias-label-primary,#e6e6e6);font:inherit;font-size:11px;cursor:pointer;white-space:nowrap}
.dswt-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.1))}
.dswt-btn.is-small{height:20px;padding:0 7px;font-size:10px}
.dswt-btn.is-primary{background:var(--dsw-alias-brand-primary,#4d6bfe);border-color:transparent;color:#fff}
.dswt-icon{flex:none;display:block}
.dswt-empty{flex:1;min-height:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:24px;text-align:center}
.dswt-emptyIcon{color:var(--dsw-alias-label-tertiary,#8a8f98)}
.dswt-emptyTitle{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#e6e6e6)}
.dswt-emptyHint{max-width:360px;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary,#8a8f98)}
@media (max-width:520px){.dswt-statusItem{max-width:34%}.dswt-tabLabel{max-width:90px}}
`

    /* ============================== registration ============================== */

    function apply(ctx) {
      const doc = typeof document !== 'undefined' && document !== null ? document : null
      if (doc !== null && doc.head !== undefined && doc.head !== null) {
        const style = doc.createElement('style')
        style.setAttribute('data-dsh-workbay-terminal', '')
        style.textContent = CSS
        doc.head.appendChild(style)
        ctx.effect(() => () => { style.remove() }, 'dsh-workbay-terminal: page styles')
      }

      const t = translatorOf(ctx)

      const localeService = ctx.get('locale')
      if (localeService !== undefined && localeService !== null && typeof localeService.register === 'function') {
        ctx.effect(
          () => localeService.register(LOCALE_NS, Object.assign({ zh: ZH, en: EN }, LOCALES)),
          'dsh-workbay-terminal: locale dictionaries',
        )
      }

      /* Exactly ONE page. The dock may load after this bundle, so poll briefly. */
      const registerWithDock = () => {
        const dock = typeof window === 'object' && window !== null ? window.__DSH_WORKBAY__ : undefined
        if (dock === undefined || dock === null || typeof dock.registerPage !== 'function') return false
        try {
          const off = dock.registerPage({
            id: PAGE_ID,
            title: t('page.terminal'),
            order: 40,
            icon: (size) => E(Icon, { name: 'terminal', size: size === undefined ? 16 : size }),
            component: () => E(LocaleLive, { ctx, t }),
          })
          ctx.effect(() => (typeof off === 'function' ? off : () => {}), 'dsh-workbay-terminal: workbench page')
          return true
        } catch (error) {
          try { console.error('[terminal] workbench page registration failed:', error) } catch { void error }
          return false
        }
      }

      if (!registerWithDock()) {
        let attempts = 0
        const timer = setInterval(() => {
          attempts += 1
          if (registerWithDock() || attempts >= 40) clearInterval(timer)
        }, 250)
        ctx.effect(() => () => clearInterval(timer), 'dsh-workbay-terminal: dock discovery')
      }
    }

    function LocaleLive(props) {
      const [tick, setTick] = useState(0)
      useEffect(() => {
        const locale = props.ctx === undefined ? undefined : props.ctx.get('locale')
        if (locale === undefined || locale === null || typeof locale.subscribe !== 'function') return undefined
        const unsubscribe = locale.subscribe(() => { setTick((value) => value + 1) })
        return typeof unsubscribe === 'function' ? unsubscribe : undefined
      }, [props.ctx])
      void tick
      return E(TerminalPage, { t: props.t })
    }

    /*
     * Pure helpers/components exposed for tests/client.test.mjs. The loader only
     * reads `apply`; this surface is not part of the plugin contract.
     */
    const TEST_API = {
      PAGE_ID,
      CHUNK_NAME,
      CHUNK_ROUTE,
      COMMAND_PROMPT,
      DEFAULT_COLS,
      DEFAULT_ROWS,
      MIN_COLS,
      MAX_COLS,
      MIN_ROWS,
      MAX_ROWS,
      TAB_PHASES,
      apiBase,
      eventsUrl,
      call,
      loadChunk,
      injectXtermCss,
      readRoot,
      parseRootValue,
      clampDimensions,
      createTab,
      reduceTabs,
      parseSsePayload,
      createCommandEditorState,
      commandEditorReducer,
      submitCommandLine,
      commandEcho,
      normalizeCommandInput,
      normalizeTerminalPaste,
      colorLuminance,
      isDarkColor,
      withAlpha,
      themeFromVars,
      readThemeVars,
      dictionaries: { zh: ZH, en: EN },
      components: {
        Page: TerminalPage,
        TabBar,
        StatusBar,
        TerminalTab,
        RootEmpty,
      },
    }

    return { apply, name: 'dsh-workbay-terminal', __test: TEST_API }
  },
})
