/**
 * dsh-workbay-terminal — client half (ONE ModuleLoader file, plain JavaScript).
 *
 * Registers exactly ONE workbench page (`{ id: 'terminal', order: 40 }`) into
 * the cross-bundle registry `window.__DSH_WORKBAY__`; the dock owns the chrome
 * and this file only supplies the page component. Contract: docs/files-api.md
 * §4/§5/§6.
 *
 * There is no PTY on the host, so this is a *console*, not a terminal emulator:
 * output is a monospace log (basic SGR colours, everything else stripped) and
 * input is a single line submitted to the host's line-oriented API. The SESSION
 * persists (it keeps the cwd); the host runs one process per submitted line, so
 * a finished command appears as an inline `[exit N]` marker and Start/Stop
 * control the session's lifecycle.
 *
 * Workspace root is READ-ONLY here: the Files page owns the picker and writes
 * `localStorage['dsh-workbay.root.v1']`; this page reads it and shows a clear
 * empty state until a workspace has been chosen.
 *
 * Hard client-side constraints (docs/architecture.md): no `import`, no JSX, no
 * npm packages — only React from the ModuleLoader seed table.
 */
window.__ModuleLoader__.load({
  id: 'dsh-workbay-terminal',
  factory: (require) => {
    const React = require('react')
    const E = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const API_BASE = 'dsh-workbay-terminal/api'
    const EVENTS_PATH = 'dsh-workbay-terminal/events'
    const ROOT_KEY = 'dsh-workbay.root.v1'
    const LOCALE_NS = 'dsh-workbay-terminal'

    /** Output ring: the newest 5000 lines; older lines are dropped. */
    const MAX_LINES = 5000
    const RECONNECT_DELAY_MS = 1000
    const FLUSH_DELAY_MS = 16

    /* ============================== i18n ============================== */

    const ZH = {
      'page.terminal': '终端',
      'title': '终端',
      'toolbar.start': '启动',
      'toolbar.stop': '停止',
      'toolbar.clear': '清屏',
      'root.label': '工作区',
      'root.recheck': '重新读取',
      'root.missing': '还没有选择工作区',
      'root.missingHint': '先到「文件」页面选择一个工作区，终端会以它为工作目录。',
      'status.shell': 'Shell',
      'status.cwd': '目录',
      'status.session': '会话',
      'status.idle': '未启动',
      'status.starting': '正在启动…',
      'status.connecting': '正在连接…',
      'status.running': '运行中',
      'status.stopping': '正在停止…',
      'status.exited': '已退出（代码 {code}）',
      'status.exitedNoCode': '已退出',
      'status.error': '连接失败',
      'status.none': '—',
      'console.empty': '启动控制台后，在这里输入命令。',
      'console.placeholder': '输入命令后按 Enter',
      'console.disabled': '先启动控制台',
      'console.hint': 'Enter 执行 · ↑↓ 历史 · Ctrl+L 清屏',
      'console.aria': '命令输入',
      'error.stream': '输出流已断开，自动重连没有成功。',
      'error.bad-request': '工作区路径无效，请到「文件」页面重新选择。',
      'error.session-limit': '同时运行的终端会话已达上限，先停止一个再试。',
      'error.shell-missing': '找不到 shell 程序，请检查插件的 shell 配置。',
      'error.session-closed': '该会话的输入已关闭，请重新启动。',
      'error.not-found': '会话已不存在，请重新启动。',
      'error.network': '无法连接宿主服务。',
      'error.unknown': '操作失败：{message}',
    }

    const EN = {
      'page.terminal': 'Terminal',
      'title': 'Terminal',
      'toolbar.start': 'Start',
      'toolbar.stop': 'Stop',
      'toolbar.clear': 'Clear',
      'root.label': 'Workspace',
      'root.recheck': 'Recheck',
      'root.missing': 'No workspace selected yet',
      'root.missingHint': 'Choose a workspace on the Files page first — the console runs in that directory.',
      'status.shell': 'Shell',
      'status.cwd': 'CWD',
      'status.session': 'Session',
      'status.idle': 'Not started',
      'status.starting': 'Starting…',
      'status.connecting': 'Connecting…',
      'status.running': 'Running',
      'status.stopping': 'Stopping…',
      'status.exited': 'Exited (code {code})',
      'status.exitedNoCode': 'Exited',
      'status.error': 'Connection failed',
      'status.none': '—',
      'console.empty': 'Start the console, then type commands here.',
      'console.placeholder': 'Type a command and press Enter',
      'console.disabled': 'Start the console first',
      'console.hint': 'Enter runs · ↑↓ history · Ctrl+L clears',
      'console.aria': 'Command input',
      'error.stream': 'The output stream dropped and the single reconnect failed.',
      'error.bad-request': 'That workspace path is invalid — pick one on the Files page.',
      'error.session-limit': 'Too many terminal sessions are open — stop one first.',
      'error.shell-missing': 'The shell executable was not found; check the plugin’s shell config.',
      'error.session-closed': 'This session’s input is closed — start a new one.',
      'error.not-found': 'That session is gone — start a new one.',
      'error.network': 'Cannot reach the host service.',
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

    function apiBase() {
      try {
        return new URL(API_BASE + '/', document.baseURI).href
      } catch {
        return API_BASE + '/'
      }
    }

    function eventsUrl(id) {
      const relative = EVENTS_PATH + '?id=' + encodeURIComponent(id)
      try {
        return new URL(relative, document.baseURI).href
      } catch {
        return relative
      }
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
      } catch {
        throw new ApiError('bad-response', 'HTTP ' + response.status)
      }
      if (body !== null && body.ok === true) return body.data
      const code = body !== null && body.error !== undefined ? body.error.code : 'unknown'
      const message = body !== null && body.error !== undefined ? body.error.message : 'HTTP ' + response.status
      throw new ApiError(code, message)
    }

    /* ============================== workspace root ============================== */

    /**
     * The Files page owns the picker. Accept both the plain-string form and a
     * JSON `{ path }` / `{ root }` object so a format tweak on that side cannot
     * strand this page on the empty state.
     */
    function readRoot() {
      try {
        const raw = window.localStorage.getItem(ROOT_KEY)
        if (raw === null) return ''
        const text = raw.trim()
        if (text === '') return ''
        if (text.startsWith('{')) {
          try {
            const parsed = JSON.parse(text)
            if (parsed !== null && typeof parsed === 'object') {
              if (typeof parsed.path === 'string' && parsed.path.trim() !== '') return parsed.path.trim()
              if (typeof parsed.root === 'string' && parsed.root.trim() !== '') return parsed.root.trim()
            }
          } catch { /* fall through to the raw string */ }
        }
        if (text.startsWith('"') && text.endsWith('"')) {
          try {
            const parsed = JSON.parse(text)
            if (typeof parsed === 'string' && parsed.trim() !== '') return parsed.trim()
          } catch { /* fall through */ }
        }
        return text
      } catch {
        return ''
      }
    }

    /* ============================== ansi ============================== */

    /**
     * xterm-ish 16-colour palette, readable on a dark console surface. Index -1
     * means "default foreground/background" and is stored as such so a later
     * reset (SGR 39/49) does not need a separate flag.
     */
    const ANSI_COLORS = [
      '#3b3b3b', '#cd3131', '#0dbc79', '#e5e510',
      '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
      '#666666', '#f14c4c', '#23d18b', '#f5f543',
      '#3b8eea', '#d670d6', '#29b8db', '#ffffff',
    ]

    /**
     * One escape sequence: SGR is captured and applied; OSC (window title etc.)
     * and every other CSI/2-char escape is stripped so raw control bytes never
     * reach the DOM.
     */
    const ANSI_RE = /\u001b\[([0-9;]*)m|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b\[[0-?]*[ -/]*[@-~]|\u001b[@-_]/g

    function createAnsiState() {
      return { fg: -1, bg: -1, bold: false }
    }

    function applySgr(state, params) {
      const codes = params === '' ? [0] : params.split(';').map((value) => (value === '' ? 0 : Number(value)))
      for (let index = 0; index < codes.length; index += 1) {
        const code = codes[index]
        if (!Number.isFinite(code)) continue
        if (code === 0) {
          state.fg = -1
          state.bg = -1
          state.bold = false
        } else if (code === 1) {
          state.bold = true
        } else if (code === 22) {
          state.bold = false
        } else if (code >= 30 && code <= 37) {
          state.fg = code - 30
        } else if (code === 39) {
          state.fg = -1
        } else if (code >= 40 && code <= 47) {
          state.bg = code - 40
        } else if (code === 49) {
          state.bg = -1
        } else if (code >= 90 && code <= 97) {
          state.fg = code - 90 + 8
        } else if (code >= 100 && code <= 107) {
          state.bg = code - 100 + 8
        } else if (code === 38 || code === 48) {
          /* Extended colours (256 / truecolour) are out of scope: skip their
             operands instead of rendering garbage. */
          if (codes[index + 1] === 5) index += 2
          else if (codes[index + 1] === 2) index += 4
        }
      }
    }

    function segmentStyle(segment) {
      const style = {}
      if (segment.fg >= 0) style.color = ANSI_COLORS[segment.fg]
      if (segment.bg >= 0) style.backgroundColor = ANSI_COLORS[segment.bg]
      if (segment.bold) style.fontWeight = 700
      return style
    }

    /* ============================== icons ============================== */

    const ICON_PATHS = {
      terminal: ['M3 4.5L7 8l-4 3.5', 'M8.5 11.5h4.5'],
      play: ['M5 3.5l7 4.5-7 4.5z'],
      stop: ['M4.5 4.5h7v7h-7z'],
      clear: ['M3 5h10', 'M6 5V3.5h4V5', 'M4.5 5l.7 8h5.6l.7-8'],
    }

    function Icon(props) {
      const size = props.size === undefined ? 14 : props.size
      const shape = ICON_PATHS[props.name] === undefined ? ICON_PATHS.terminal : ICON_PATHS[props.name]
      return E('svg', {
        className: 'dswt-icon',
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

    /* ============================== lines ============================== */

    const Line = React.memo(function Line(props) {
      const segments = props.line.segs
      if (segments.length === 0) return E('div', { className: 'dswt-line is-empty' }, '\u00a0')
      return E('div', { className: 'dswt-line' }, segments.map((segment, index) => E(
        'span',
        { key: index, style: segmentStyle(segment) },
        segment.text,
      )))
    })

    /* ============================== page ============================== */

    function phaseLabel(t, phase, exitCode) {
      if (phase === 'exited') {
        return exitCode === null ? t('status.exitedNoCode') : t('status.exited', { code: exitCode })
      }
      const key = 'status.' + phase
      const label = t(key)
      return label === key ? t('status.idle') : label
    }

    function TerminalPage(props) {
      const t = props.t

      const [root, setRoot] = useState(readRoot)
      const [session, setSession] = useState(null)
      const [phase, setPhase] = useState('idle')
      const [exitCode, setExitCode] = useState(null)
      const [errorMessage, setErrorMessage] = useState('')
      const [value, setValue] = useState('')
      const [lines, setLines] = useState([])

      const outputRef = useRef(null)
      const linesRef = useRef([])
      const pendingRef = useRef([])
      const ansiRef = useRef(createAnsiState())
      const nextLineIdRef = useRef(0)
      const dirtyRef = useRef(false)
      const flushTimerRef = useRef(0)
      const stickToBottomRef = useRef(true)

      const esRef = useRef(null)
      const reconnectTimerRef = useRef(null)
      const reconnectUsedRef = useRef(false)
      const stopTimerRef = useRef(null)

      const phaseRef = useRef('idle')
      useEffect(() => { phaseRef.current = phase }, [phase])

      const historyRef = useRef([])
      const historyIndexRef = useRef(0)
      const draftRef = useRef('')

      /* ---- workspace root (read-only; the Files page writes it) ---- */
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

      /* The Files page writes the key in THIS document, so no `storage` event
         fires. A cheap 2 s read (a string compare, no re-render when unchanged)
         keeps the terminal on the same workspace as the Files page. */
      useEffect(() => {
        const timer = setInterval(() => {
          const next = readRoot()
          setRoot((current) => (next === current ? current : next))
        }, 2000)
        return () => clearInterval(timer)
      }, [])

      /* ---- output commit / scroll ---- */
      const commit = useCallback(() => {
        flushTimerRef.current = 0
        if (!dirtyRef.current) return
        dirtyRef.current = false
        const snapshot = linesRef.current.slice()
        /* A command that is still printing a partial line (progress output,
           prompts without a newline) must be visible before its newline. */
        if (pendingRef.current.length > 0) {
          snapshot.push({ id: -1, segs: pendingRef.current.slice() })
        }
        setLines(snapshot)
      }, [])

      const ingest = useCallback((text) => {
        if (typeof text !== 'string' || text === '') return
        const state = ansiRef.current
        const pending = pendingRef.current
        const lines = linesRef.current
        const pushText = (piece) => {
          if (piece === '') return
          const last = pending[pending.length - 1]
          if (last !== undefined && last.fg === state.fg && last.bg === state.bg && last.bold === state.bold) {
            last.text += piece
          } else {
            pending.push({ text: piece, fg: state.fg, bg: state.bg, bold: state.bold })
          }
        }
        const flushLine = () => {
          lines.push({ id: nextLineIdRef.current, segs: pending.splice(0) })
          nextLineIdRef.current += 1
          if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES)
        }
        let at = 0
        while (at < text.length) {
          ANSI_RE.lastIndex = at
          const match = ANSI_RE.exec(text)
          if (match === null) {
            pushText(text.slice(at))
            break
          }
          if (match.index > at) pushText(text.slice(at, match.index))
          if (typeof match[1] === 'string') applySgr(state, match[1])
          at = match.index + match[0].length
        }
        dirtyRef.current = true
        if (flushTimerRef.current === 0) {
          flushTimerRef.current = setTimeout(commit, FLUSH_DELAY_MS)
        }
      }, [commit])

      const clearOutput = useCallback(() => {
        if (flushTimerRef.current !== 0) {
          clearTimeout(flushTimerRef.current)
          flushTimerRef.current = 0
        }
        linesRef.current = []
        pendingRef.current = []
        ansiRef.current = createAnsiState()
        dirtyRef.current = false
        nextLineIdRef.current = 0
        setLines([])
        stickToBottomRef.current = true
      }, [])

      useEffect(() => {
        const element = outputRef.current
        if (element === null || !stickToBottomRef.current) return
        element.scrollTop = element.scrollHeight
      }, [lines])

      const onOutputScroll = useCallback(() => {
        const element = outputRef.current
        if (element === null) return
        stickToBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24
      }, [])

      /* ---- SSE ---- */
      const closeStream = useCallback(() => {
        if (reconnectTimerRef.current !== null) {
          clearTimeout(reconnectTimerRef.current)
          reconnectTimerRef.current = null
        }
        const source = esRef.current
        esRef.current = null
        if (source !== null) {
          try { source.close() } catch { /* already closed */ }
        }
      }, [])

      const connectStream = useCallback((id) => {
        closeStream()
        const source = new EventSource(eventsUrl(id))
        esRef.current = source
        source.onmessage = (event) => {
          let payload = null
          try { payload = JSON.parse(event.data) } catch { return }
          if (payload === null || typeof payload !== 'object') return
          if (payload.type === 'hello') {
            setPhase((current) => (current === 'running' ? current : 'running'))
            return
          }
          if (payload.type === 'out') {
            ingest(payload.data)
            return
          }
          if (payload.type === 'exit') {
            if (pendingRef.current.length > 0) ingest('\n')
            if (stopTimerRef.current !== null) {
              clearTimeout(stopTimerRef.current)
              stopTimerRef.current = null
            }
            setExitCode(typeof payload.code === 'number' ? payload.code : null)
            setPhase('exited')
            setSession((current) => (current === null ? current : { ...current, active: false }))
            closeStream()
            return
          }
          if (payload.type === 'error') setErrorMessage(String(payload.message === undefined ? '' : payload.message))
        }
        source.onerror = () => {
          if (esRef.current !== source) return
          esRef.current = null
          try { source.close() } catch { /* already closed */ }
          if (phaseRef.current === 'exited') return
          /* Exactly ONE explicit reconnect: EventSource's own retry loop would
             hammer a host that is shutting down, and a second failure is shown
             to the user instead of being hidden. */
          if (reconnectUsedRef.current) {
            setPhase('error')
            setErrorMessage(t('error.stream'))
            return
          }
          reconnectUsedRef.current = true
          setPhase('connecting')
          reconnectTimerRef.current = setTimeout(() => {
            reconnectTimerRef.current = null
            connectStream(id)
          }, RECONNECT_DELAY_MS)
        }
      }, [closeStream, ingest, t])

      /* ---- actions ---- */
      const startSession = useCallback(async () => {
        if (root === '') return
        clearOutput()
        closeStream()
        reconnectUsedRef.current = false
        if (stopTimerRef.current !== null) {
          clearTimeout(stopTimerRef.current)
          stopTimerRef.current = null
        }
        setErrorMessage('')
        setExitCode(null)
        setSession(null)
        setPhase('starting')
        try {
          const data = await call('start', { root })
          if (data === null || typeof data.id !== 'string') throw new ApiError('bad-response', 'no session id')
          setSession({
            id: data.id,
            shell: typeof data.shell === 'string' ? data.shell : '',
            cwd: typeof data.cwd === 'string' && data.cwd !== '' ? data.cwd : root,
            active: true,
          })
          setPhase('connecting')
          connectStream(data.id)
        } catch (error) {
          setPhase('error')
          setErrorMessage(errorText(t, error))
        }
      }, [root, clearOutput, closeStream, connectStream, t])

      const stopSession = useCallback(async () => {
        const current = session
        if (current === null) return
        setPhase('stopping')
        try {
          await call('stop', { id: current.id })
        } catch (error) {
          /* A session that already exited answers 404: that is the desired end
             state, not an error worth surfacing. */
          if (!(error instanceof ApiError) || error.code !== 'not-found') setErrorMessage(errorText(t, error))
        }
        if (stopTimerRef.current !== null) clearTimeout(stopTimerRef.current)
        stopTimerRef.current = setTimeout(() => {
          stopTimerRef.current = null
          setPhase((currentPhase) => (currentPhase === 'stopping' ? 'exited' : currentPhase))
          closeStream()
        }, 2500)
      }, [session, closeStream, t])

      const submit = useCallback(() => {
        if (session === null) return
        const currentPhase = phaseRef.current
        if (currentPhase !== 'running' && currentPhase !== 'connecting') return
        const text = value
        void call('input', { id: session.id, data: text + '\n' }).catch((error) => {
          setErrorMessage(errorText(t, error))
        })
        if (text.trim() !== '') {
          historyRef.current = historyRef.current.concat([text]).slice(-100)
        }
        historyIndexRef.current = historyRef.current.length
        draftRef.current = ''
        setValue('')
      }, [session, value, t])

      const navigateHistory = useCallback((delta) => {
        const history = historyRef.current
        if (history.length === 0) return
        if (historyIndexRef.current >= history.length) draftRef.current = value
        let next = historyIndexRef.current + delta
        if (next < 0) next = 0
        if (next >= history.length) {
          historyIndexRef.current = history.length
          setValue(draftRef.current)
          return
        }
        historyIndexRef.current = next
        setValue(history[next])
      }, [value])

      const onKeyDown = useCallback((event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          submit()
          return
        }
        if (event.key === 'l' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault()
          clearOutput()
          return
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          navigateHistory(-1)
          return
        }
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          navigateHistory(1)
        }
      }, [submit, clearOutput, navigateHistory])

      /* Clean teardown: no socket, no timer, no pending state write after the
         dock unmounts the page. The remote shell is NOT stopped here on purpose:
         dock tab switches remount pages, and the host's idle timeout (30 min) is
         the safety net for an abandoned session. */
      useEffect(() => () => {
        closeStream()
        if (stopTimerRef.current !== null) clearTimeout(stopTimerRef.current)
        if (flushTimerRef.current !== 0) clearTimeout(flushTimerRef.current)
        esRef.current = null
      }, [closeStream])

      /* ---- render ---- */
      const canStart = root !== '' && phase !== 'starting' && phase !== 'connecting'
        && phase !== 'running' && phase !== 'stopping'
      const canStop = session !== null && (phase === 'running' || phase === 'connecting')
      const canInput = session !== null && (phase === 'running' || phase === 'connecting')
      const cwd = session === null ? root : session.cwd
      const shell = session === null ? '' : session.shell
      const statusTone = phase === 'running' ? 'is-ok'
        : phase === 'exited' ? 'is-idle'
          : phase === 'error' ? 'is-bad' : 'is-busy'

      const statusChips = [
        E('span', { className: 'dswt-statusItem', key: 'shell', title: t('status.shell') },
          E('span', { className: 'dswt-statusKey' }, t('status.shell')),
          E('span', { className: 'dswt-statusValue' }, shell === '' ? t('status.none') : shell)),
        E('span', { className: 'dswt-statusItem', key: 'cwd', title: cwd },
          E('span', { className: 'dswt-statusKey' }, t('status.cwd')),
          E('span', { className: 'dswt-statusValue' }, cwd === '' ? t('status.none') : cwd)),
        E('span', { className: 'dswt-statusItem', key: 'session', title: session === null ? '' : session.id },
          E('span', { className: 'dswt-statusKey' }, t('status.session')),
          E('span', { className: 'dswt-statusValue' }, session === null ? t('status.none') : session.id.slice(0, 8))),
      ]

      const emptyState = E('div', { className: 'dswt-emptyState' },
        E('div', { className: 'dswt-emptyIcon' }, E(Icon, { name: 'terminal', size: 28 })),
        E('div', { className: 'dswt-emptyTitle' }, t('root.missing')),
        E('div', { className: 'dswt-emptyHint' }, t('root.missingHint')),
        E('button', {
          type: 'button',
          className: 'dswt-btn',
          onClick: () => setRoot(readRoot()),
        }, t('root.recheck')))

      const consoleBody = E('div', { className: 'dswt-console' },
        E('div', {
          ref: outputRef,
          className: 'dswt-output',
          role: 'log',
          'aria-live': 'polite',
          'aria-label': t('title'),
          onScroll: onOutputScroll,
        },
        lines.length === 0
          ? E('div', { className: 'dswt-outputEmpty' }, t('console.empty'))
          : lines.map((line) => E(Line, { key: line.id, line }))))

      const promptBar = E('div', { className: 'dswt-prompt' },
        E('span', { className: 'dswt-promptMark', 'aria-hidden': 'true' }, '>'),
        E('input', {
          className: 'dswt-input',
          type: 'text',
          value,
          spellCheck: false,
          autoComplete: 'off',
          autoCapitalize: 'off',
          disabled: !canInput,
          placeholder: canInput ? t('console.placeholder') : t('console.disabled'),
          'aria-label': t('console.aria'),
          onChange: (event) => setValue(event.target.value),
          onKeyDown,
        }),
        E('span', { className: 'dswt-hint' }, t('console.hint')))

      return E('div', { className: 'dswt-root' },
        E('div', { className: 'dswt-toolbar' },
          E('button', {
            type: 'button',
            className: 'dswt-btn is-primary',
            disabled: !canStart,
            onClick: () => { void startSession() },
          }, E(Icon, { name: 'play', size: 12 }), E('span', null, t('toolbar.start'))),
          E('button', {
            type: 'button',
            className: 'dswt-btn',
            disabled: !canStop,
            onClick: () => { void stopSession() },
          }, E(Icon, { name: 'stop', size: 12 }), E('span', null, t('toolbar.stop'))),
          E('button', {
            type: 'button',
            className: 'dswt-btn',
            onClick: clearOutput,
          }, E(Icon, { name: 'clear', size: 12 }), E('span', null, t('toolbar.clear'))),
          E('span', { className: 'dswt-status' },
            E('span', { className: 'dswt-phase ' + statusTone },
              E('span', { className: 'dswt-dot' }),
              E('span', null, phaseLabel(t, phase, exitCode))),
            statusChips)),
        root === ''
          ? E('div', { className: 'dswt-body' }, emptyState)
          : E('div', { className: 'dswt-body' },
            errorMessage === '' ? null : E('div', { className: 'dswt-error', role: 'alert' }, errorMessage),
            consoleBody,
            promptBar))
    }

    /* ============================== styles ============================== */

    const CSS = `
.dswt-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base,#14161a);color:var(--dsw-alias-label-primary,#e6e6e6);font-size:12px}
.dswt-toolbar{display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));flex-wrap:wrap;flex:none}
.dswt-btn{display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#b6bac1);font:inherit;font-size:11px;cursor:pointer}
.dswt-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));color:var(--dsw-alias-label-primary,#fff)}
.dswt-btn:disabled{opacity:.4;cursor:default}
.dswt-btn.is-primary{background:var(--dsw-alias-interactive-bg-active,rgba(77,107,254,.18));border-color:transparent;color:var(--dsw-alias-label-primary,#fff)}
.dswt-icon{flex:none;display:block}
.dswt-status{display:flex;align-items:center;gap:8px;margin-left:auto;min-width:0;color:var(--dsw-alias-label-tertiary,#8a8f98);font-family:var(--dsw-font-markdown-code-block,ui-monospace,Consolas,monospace);font-size:10px}
.dswt-phase{display:inline-flex;align-items:center;gap:4px;flex:none;white-space:nowrap}
.dswt-dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}
.dswt-phase.is-ok{color:var(--dsw-alias-state-success-primary,#3fb950)}
.dswt-phase.is-bad{color:var(--dsw-alias-state-error-primary,#ff6b6b)}
.dswt-phase.is-busy{color:var(--dsw-alias-state-warn-primary,#e2a03f)}
.dswt-phase.is-idle{color:var(--dsw-alias-label-tertiary,#8a8f98)}
.dswt-statusItem{display:inline-flex;align-items:center;gap:3px;min-width:0;max-width:34%;white-space:nowrap;overflow:hidden}
.dswt-statusKey{color:var(--dsw-alias-label-tertiary,#8a8f98)}
.dswt-statusValue{overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary,#b6bac1)}
.dswt-body{flex:1;min-height:0;display:flex;flex-direction:column}
.dswt-error{flex:none;margin:6px 8px 0;padding:6px 8px;border-radius:6px;background:rgba(255,107,107,.12);color:var(--dsw-alias-state-error-primary,#ff6b6b);font-size:11px;line-height:1.5;word-break:break-word}
.dswt-console{flex:1;min-height:0;display:flex;flex-direction:column}
.dswt-output{flex:1;min-height:0;overflow:auto;padding:6px 8px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.25));font-family:var(--dsw-font-markdown-code-block,ui-monospace,SFMono-Regular,Consolas,monospace);font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-all;tab-size:4}
.dswt-outputEmpty{padding:8px 2px;color:var(--dsw-alias-label-tertiary,#8a8f98);font-style:italic;white-space:normal}
.dswt-line{content-visibility:auto;contain-intrinsic-size:auto 18px;min-height:1.5em}
.dswt-line.is-empty{height:1.5em}
.dswt-prompt{flex:none;display:flex;align-items:center;gap:6px;padding:6px 8px;border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.03))}
.dswt-promptMark{flex:none;color:var(--dsw-alias-brand-primary,#4d6bfe);font-family:var(--dsw-font-markdown-code-block,ui-monospace,Consolas,monospace);font-weight:700}
.dswt-input{flex:1;min-width:0;padding:5px 7px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));background:var(--dsw-alias-bg-base,#14161a);color:inherit;font-family:var(--dsw-font-markdown-code-block,ui-monospace,Consolas,monospace);font-size:12px}
.dswt-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#4d6bfe)}
.dswt-input:disabled{opacity:.5}
.dswt-hint{flex:none;color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:10px;white-space:nowrap}
.dswt-emptyState{flex:1;min-height:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:24px;text-align:center}
.dswt-emptyIcon{color:var(--dsw-alias-label-tertiary,#8a8f98)}
.dswt-emptyTitle{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#e6e6e6)}
.dswt-emptyHint{max-width:340px;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary,#8a8f98)}
@media (max-width:520px){.dswt-hint{display:none}}
`

    /* ============================== registration ============================== */

    function apply(ctx) {
      const style = document.createElement('style')
      style.setAttribute('data-dsh-workbay-terminal', '')
      style.textContent = CSS
      document.head.appendChild(style)
      ctx.effect(() => () => { style.remove() }, 'dsh-workbay-terminal: console styles')

      const t = translatorOf(ctx)

      const localeService = ctx.get('locale')
      if (localeService !== undefined && typeof localeService.register === 'function') {
        ctx.effect(
          () => localeService.register(LOCALE_NS, Object.assign({ zh: ZH, en: EN }, LOCALES)),
          'dsh-workbay-terminal: locale dictionaries',
        )
      }

      /* Exactly ONE page, registered into the shared cross-bundle registry. The
         dock may load after this bundle, so discovery polls briefly (the same
         pattern dsh-gitcraft and dsh-downloader use). */
      let registered = false
      const registerWithDock = () => {
        if (registered) return true
        const dock = typeof window === 'object' && window !== null ? window.__DSH_WORKBAY__ : undefined
        if (dock === undefined || dock === null || typeof dock.registerPage !== 'function') return false
        try {
          const off = dock.registerPage({
            id: 'terminal',
            title: t('page.terminal'),
            order: 40,
            icon: (size) => E(Icon, { name: 'terminal', size: size === undefined ? 16 : size }),
            component: (pageProps) => E(LocaleLive, { ctx, t }),
          })
          registered = true
          ctx.effect(() => off, 'dsh-workbay-terminal: workbench page')
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

    /** Re-render the page when the active locale changes. */
    function LocaleLive(props) {
      const [tick, setTick] = useState(0)
      useEffect(() => {
        const locale = props.ctx === undefined ? undefined : props.ctx.get('locale')
        if (locale === undefined || typeof locale.subscribe !== 'function') return undefined
        const unsubscribe = locale.subscribe(() => { setTick((value) => value + 1) })
        return typeof unsubscribe === 'function' ? unsubscribe : undefined
      }, [props.ctx])
      void tick
      return E(TerminalPage, { t: props.t })
    }

    return { apply, name: 'dsh-workbay-terminal' }
  },
})
