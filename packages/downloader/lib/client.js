// dsh-downloader —— client 半侧（浏览器）
//
// v2 形态（按用户反馈调整）：
//   - 一个 better-sidebar tab：Downloader（烧录 + 串口日志）
//     （挂在 better-sidebar 的 tab 工具条 rightActions 上，并注册一个独立 tab 当兜底）
//   - 烧录页【合并日志】：上方烧录状态，下方日志，方便「烧 → 看 → 再烧」
//   - 连接 Downloader 时窗口【可见】（BackShowMode），能直接看到原界面
//
// 这是预构建产物：DSH 的 client 模块系统要求 window.__ModuleLoader__.load 的 CJS 闭包，
// 不能直接加载 ESM/JSX 源码。用 React.createElement 手写，零依赖、单文件。

window.__ModuleLoader__.load({
  id: 'dsh-downloader',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const API = '/downloader'

    /* ★ 满了之后卡不卡，取决于这两条：
       1) 前端保留最多 30 万条（宿主 5 万供 AI 检索；本地 JSONL 才是全量）；
       2) 只渲染可视区的行（固定行高 + 上下占位），DOM 数量与总条数无关。
       再配合宿主的 60ms 批量推送，每批只做一次 setState。 */
    const CLIENT_MAX_LOGS = 300000
    const ROW_HEIGHT = 18
    const OVERSCAN = 20

    /** 批量追加 + 环形裁剪；返回新数组，不修改入参。 */
/* The last workspace root this PAGE told the host. Module scope on purpose: the
   sync effect re-runs on every remount and a per-run variable starts at null —
   that sent the same root three times in one second. */
let lastSentRoot = null

function appendLogs(current, items, max) {
      if (!Array.isArray(items) || items.length === 0) return current
      if (items.length >= max) return items.slice(items.length - max)
      const overflow = current.length + items.length - max
      const base = overflow > 0 ? current.slice(overflow) : current
      return base.concat(items)
    }

    /** 可视区计算：固定行高下返回要渲染的切片与上下占位高度。 */
    function virtualRange(scrollTop, viewportHeight, count, rowHeight, overscan) {
      const total = Math.max(0, Number(count) || 0)
      const top = Math.max(0, Number(scrollTop) || 0)
      const start = Math.max(0, Math.min(total, Math.floor(top / rowHeight) - overscan))
      const rows = Math.ceil((Number(viewportHeight) || 0) / rowHeight) + overscan * 2
      const end = Math.min(total, start + rows)
      return { start, end, topPad: start * rowHeight, bottomPad: (total - end) * rowHeight }
    }

    /** 编译搜索正则（与宿主一致：Aa / ab / .*）；非法返回 null。 */
    function searchRegExp(query, caseSensitive, wholeWord, regex) {
      const text = String(query === undefined || query === null ? '' : query).trim()
      if (text === '') return null
      try {
        let source = regex === true ? text : text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        if (wholeWord === true) source = '\\b(?:' + source + ')\\b'
        /* `g` is required for the highlight loop: without it exec() returns
           the first match forever and the parts array grows until OOM. */
        return new RegExp(source, (caseSensitive === true ? '' : 'i') + 'g')
      } catch { return null }
    }

    /** 把一行切成普通/命中片段，供高亮渲染。 */
    function searchParts(text, query, caseSensitive, wholeWord, regex) {
      const source = String(text === undefined || text === null ? '' : text)
      const pattern = searchRegExp(query, caseSensitive, wholeWord, regex)
      if (pattern === null) return [{ text: source, hit: false }]
      const parts = []
      let last = 0
      let match
      while ((match = pattern.exec(source)) !== null) {
        if (match[0] === '') { pattern.lastIndex += 1; continue }
        if (match.index > last) parts.push({ text: source.slice(last, match.index), hit: false })
        parts.push({ text: match[0], hit: true })
        last = match.index + match[0].length
      }
      if (parts.length === 0) return [{ text: source, hit: false }]
      if (last < source.length) parts.push({ text: source.slice(last), hit: false })
      return parts
    }

    /** 一条日志的稳定身份（时间戳+来源+文本），用于去重与高亮定位。 */
    function logKey(item) {
      return String(item && item.t) + '|' + String(item && item.src) + '|' + String(item && item.text)
    }

    /** 把上下文切片并回实时缓冲：去重、按时间排序、保留上限。 */
    function mergeLogs(current, incoming, max) {
      if (!Array.isArray(incoming) || incoming.length === 0) return current
      const seen = new Set()
      for (const item of current) seen.add(logKey(item))
      const add = []
      for (const item of incoming) {
        const key = logKey(item)
        if (seen.has(key)) continue
        seen.add(key)
        add.push(item)
      }
      if (add.length === 0) return current
      const merged = current.concat(add)
      merged.sort((a, b) => (Number(a.t) || 0) - (Number(b.t) || 0))
      return merged.length > max ? merged.slice(merged.length - max) : merged
    }

    /** 本地日志文件占用（页面显示用）。 */
    function formatBytes(n) {
      const size = Number(n) || 0
      if (size < 1024) return size + ' B'
      if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB'
      if (size < 1024 * 1024 * 1024) return (size / 1024 / 1024).toFixed(1) + ' MB'
      return (size / 1024 / 1024 / 1024).toFixed(2) + ' GB'
    }
    const api = {
      get: async (p) => {
        try {
          const r = await fetch(API + p, { headers: { accept: 'application/json' } })
          return await r.json()
        } catch (e) { return { error: String(e) } }
      },
      post: async (p, body) => {
        try {
          const r = await fetch(API + p, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body || {}),
          })
          return await r.json()
        } catch (e) { return { error: String(e) } }
      },
    }

    // ---------------------------------------------------------------- 样式
    // 全部走 DSH 主题变量（--dsw-*），换肤自动跟随。
    const CSS = `
      .abw{display:flex;flex-direction:column;height:100%;min-height:0;
        color:var(--dsw-fg-1,#e6e6e6);font-size:13px;background:var(--dsw-bg-1,#1a1a1c)}

      .abw-top{flex:0 0 auto;padding:10px 12px 0;border-bottom:1px solid var(--dsw-border,#2c2c2f)}
      .abw-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px}
      .abw-sp{flex:1 1 auto}
      .abw-dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto;background:var(--dsw-fg-3,#666)}
      .abw-dot[data-s="ok"]{background:#3fb950}
      .abw-dot[data-s="warn"]{background:#d29922}
      .abw-dot[data-s="err"]{background:#f85149}
      .abw-dot[data-s="busy"]{background:#4c9aff;animation:abwp 1s infinite}
      @keyframes abwp{50%{opacity:.3}}

      .abw-btn{display:inline-flex;align-items:center;gap:5px;padding:5px 10px;border-radius:6px;
        border:1px solid var(--dsw-border,#3a3a3d);background:var(--dsw-bg-2,#252528);
        color:var(--dsw-fg-1,#e6e6e6);cursor:pointer;font-size:12px;white-space:nowrap}
      .abw-btn:hover:not(:disabled){background:var(--dsw-bg-3,#2f2f33);border-color:var(--dsw-fg-3,#666)}
      .abw-btn:disabled{opacity:.42;cursor:not-allowed}
      .abw-btn[data-v="pri"]{background:#2b6cd4;border-color:#2b6cd4;color:#fff}
      .abw-btn[data-v="pri"]:hover:not(:disabled){background:#3a7df0}
      .abw-btn[data-v="danger"]{color:#f85149;border-color:#5a2a2a}
      .abw-btn[data-v="ghost"]{background:transparent;border-color:transparent;padding:3px 7px}

      .abw-sel,.abw-inp{padding:4px 8px;border-radius:5px;font-size:12px;
        border:1px solid var(--dsw-border,#3a3a3d);background:var(--dsw-bg-2,#252528);
        color:var(--dsw-fg-1,#e6e6e6);outline:none;min-width:0}
      .abw-sel:focus,.abw-inp:focus{border-color:var(--dsw-accent,#4c9aff)}
      .abw-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
      .abw-dim{color:var(--dsw-fg-3,#888)}
      .abw-badge{font-size:11px;padding:1px 6px;border-radius:9px;background:var(--dsw-bg-3,#2f2f33);
        color:var(--dsw-fg-2,#aaa);flex:0 0 auto}

      .abw-kv{display:grid;grid-template-columns:76px 1fr 76px 1fr;gap:4px 10px;font-size:12px;margin-bottom:8px}
      .abw-kv>div:nth-child(odd){color:var(--dsw-fg-3,#888)}
      .abw-kv>div:nth-child(even){overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

      .abw-prog{height:5px;border-radius:3px;background:var(--dsw-bg-3,#2f2f33);overflow:hidden;margin:2px 0 8px}
      .abw-prog>i{display:block;height:100%;background:var(--dsw-accent,#4c9aff);transition:width .18s ease}

      .abw-logwrap{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;padding:8px 12px 10px}
      .abw-lbar{flex:0 0 auto;display:flex;align-items:center;gap:8px;margin-bottom:6px}
      .abw-log{flex:1 1 auto;min-height:0;overflow:auto;
        font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;line-height:1.5;
        white-space:pre;word-break:normal;border:1px solid var(--dsw-border,#2c2c2f);
        border-radius:8px;padding:8px 10px;background:var(--dsw-bg-2,#18181a)}
      .abw-ll{display:flex;gap:6px}
      .abw-lt-time{flex:0 0 auto;color:var(--dsw-fg-3,#666);font-variant-numeric:tabular-nums;user-select:none}
      .abw-ls{flex:0 0 auto;width:12px;text-align:center;color:var(--dsw-fg-3,#666);user-select:none}
      .abw-ls[data-s="B"]{color:#3fb950}
      .abw-ls[data-s="D"]{color:#4c9aff}
      .abw-ls[data-s="U"]{color:#d29922}
      .abw-ls[data-s="M"]{color:#c792ea}
      .abw-lt{flex:1 1 auto;min-width:0}
      .abw-empty{padding:24px 10px;text-align:center;color:var(--dsw-fg-3,#777);font-size:12px;line-height:1.9}
      .abw-send{flex:0 0 auto;display:flex;gap:8px;margin-top:8px}
      .abw-search{flex:0 0 auto;display:flex;align-items:center;gap:6px;margin-bottom:6px}
      .abw-hit{background:#4d3b00;color:#ffd866;border-radius:2px}
      .abw-ll.is-target{background:#3a3000;box-shadow:inset 2px 0 0 #ffd866}
      .abw-ll.is-selected{background:#27364d}
      .abw-split{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:6px}
      .abw-result{flex:0 0 38%;min-height:120px;display:flex;flex-direction:column;min-height:0}
      .abw-resultsBar{flex:0 0 auto;display:flex;align-items:center;gap:6px}
      .abw-resultList{flex:1 1 auto;min-height:0}
    `

    let injected = false
    function injectCss() {
      if (injected || typeof document === 'undefined') return
      injected = true
      const s = document.createElement('style')
      s.setAttribute('data-dsh-downloader', '1')
      s.textContent = CSS
      document.head.appendChild(s)
    }

    // ---------------------------------------------------------------- 状态

    function useAbw() {
      const [st, setSt] = React.useState({
        serial: { open: false, port: null, baud: 1500000 },
        flash: { status: '离线', progress: 0, online: false, busy: false },
        logs: [],
        logFile: null,
        watch: { on: false, path: null },
      })

      React.useEffect(() => {
        let alive = true
        api.get('/state').then(s => {
          if (alive && s && !s.error) setSt(x => ({ ...x, ...s }))
        })
        const es = new EventSource(API + '/events')
        es.onmessage = (m) => {
          let e
          try { e = JSON.parse(m.data) } catch { return }
          setSt(x => {
            if (e.ev === 'hello') return { ...x, ...e.state }
            if (e.ev === 'log') return { ...x, logs: appendLogs(x.logs, [e.item], CLIENT_MAX_LOGS) }
            if (e.ev === 'logs') {
              const logs = Array.isArray(e.items) && e.items.length > 0
                ? appendLogs(x.logs, e.items, CLIENT_MAX_LOGS)
                : x.logs
              const logFile = e.file ? { ...(x.logFile || {}), ...e.file } : x.logFile
              return { ...x, logs, logFile }
            }
            if (e.ev === 'flash') return { ...x, flash: { ...x.flash, ...e.state } }
            if (e.ev === 'serial-state') return { ...x, serial: e.serial }
            // ★ 清空时后端会广播 log-clear，前端必须一起清，
            //   否则只清了底层、界面上旧日志还在。
            if (e.ev === 'log-clear') {
              return {
                ...x,
                logs: [],
                logFile: x.logFile ? { ...x.logFile, size: 0, lines: 0, exists: false } : x.logFile,
              }
            }
            if (e.ev === 'watch') return { ...x, watch: e.watch }
            return x
          })
        }
        return () => { alive = false; es.close() }
      }, [])

      return [st, setSt]
    }

    // ---------------------------------------------------------------- 烧录 + 日志（合并页）

    const SRC = { B: 'B', D: 'D', U: 'U', M: 'M', S: 'S' }

    function FlashPanel() {
      injectCss()
      const [st, setSt] = useAbw()
      const [ports, setPorts] = React.useState([])
      const [selPort, setSelPort] = React.useState('')
      const [baud, setBaud] = React.useState(1500000)
      const [filter, setFilter] = React.useState('all')
      const [follow, setFollow] = React.useState(true)
      const [input, setInput] = React.useState('')
      const logRef = React.useRef(null)
      const [scrollTop, setScrollTop] = React.useState(0)
      const [viewH, setViewH] = React.useState(300)
      const [older, setOlder] = React.useState({ loading: false, hasMore: true })
      const [search, setSearch] = React.useState({
        query: '', caseSensitive: false, wholeWord: false, regex: false,
        loading: false, error: '', matches: [], total: 0, hasMore: false, nonce: 0,
      })
      const searching = search.query.trim() !== ''
      /* 点击搜索结果后进入“定位视图”：显示该条前后各 200 条上下文。 */
      const [target, setTarget] = React.useState(null)
      const logsRef = React.useRef(st.logs)
      React.useEffect(() => { logsRef.current = st.logs }, [st.logs])
      /* 搜索时下方结果栏有独立的滚动位置与高度（上方实时流不受影响）。 */
      const [resultScrollTop, setResultScrollTop] = React.useState(0)
      const [resultViewH, setResultViewH] = React.useState(200)
      const resultRef = React.useRef(null)
      const [selectedKey, setSelectedKey] = React.useState(null)
      // 内联提示（替代 alert）：不弹窗，在界面上就地显示几秒
      const [notice, setNotice] = React.useState('')
      // 提示自动消失（3 秒），不留残在界面上
      React.useEffect(() => {
        if (!notice) return
        const t = setTimeout(() => setNotice(''), 3000)
        return () => clearTimeout(t)
      }, [notice])

      const f = st.flash || {}
      const s = st.serial || {}
      const pct = Math.min(100, Math.round((f.progress || 0) / 100))
      const busy = !!f.busy

      const loadPorts = async () => {
        const r = await api.get('/serial/list')
        const ps = (r && r.ports) || []
        setPorts(ps)
        if (!selPort && ps.length) {
          const pref = ps.find(p => /CP210|Silicon|CH34|FTDI|USB/i.test(p.desc || ''))
          setSelPort((pref || ps[0]).name)
        }
      }
      React.useEffect(() => { loadPorts() }, [])

  /* ---- 跟随「源码管理」页的工作目录 ----------------------------------------
   * dcf 扫描原来只认 Downloader 工具自己的目录。用户在大仓里换到另一个工程后，
   * 扫描结果还是旧工程 —— 会烧错文件，而且自动烧录盯的也是旧的 dcf。
   *
   * 工作台里两个页面共享同一个根键（源码管理页会写它）。这里轮询这个键并告知宿主，
   * 而不是用 storage 事件：同一文档内写 localStorage 不触发 storage 事件。
   */
  React.useEffect(() => {
    let stopped = false
    const read = () => {
      try { return window.localStorage.getItem('dsh-workbay.sc.root.v1') || '' } catch (e) { return '' }
    }
    const sync = async () => {
      if (stopped) return
      const root = read()
      /* Module-level memo, not a local one: this effect re-runs on every remount
         (StrictMode double-invoke, page re-open), and a local last starts at null
         each time — that sent the same root three times in one second and filled
         the host log with identical lines. */
      if (root === '' || root === lastSentRoot) return
      const posted = await api.post('/workspace', { root })
      /* Record it only AFTER the host accepted it. Recording first meant a request
         that failed (host still booting after a DSH restart) was remembered as done
         and never retried — that is the 'switch the folder twice before it takes' bug. */
      if (posted !== null && posted !== undefined && posted.ok === true) lastSentRoot = root
    }
    void sync()
    const timer = setInterval(() => { void sync() }, 2000)
    const onFocus = () => { void sync() }
    window.addEventListener('focus', onFocus)
    return () => {
      stopped = true
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

      React.useEffect(() => {
        const el = logRef.current
        if (!el) return undefined
        const measure = () => setViewH(el.clientHeight || 300)
        measure()
        if (typeof ResizeObserver === 'function') {
          const observer = new ResizeObserver(measure)
          observer.observe(el)
          return () => observer.disconnect()
        }
        window.addEventListener('resize', measure)
        return () => window.removeEventListener('resize', measure)
      }, [])

      /* 向上滚动时从本地 JSONL 继续加载更早的日志（内存只是工作集）。 */
      const loadOlder = React.useCallback(async () => {
        if (older.loading || !older.hasMore || st.logs.length === 0) return
        setOlder(current => ({ ...current, loading: true }))
        const first = st.logs[0]
        const before = first !== undefined && first !== null && typeof first.t === 'number' ? first.t : Date.now()
        try {
          const data = await api.get('/log/history?before=' + encodeURIComponent(before) + '&limit=3000')
          if (!data || data.error || !Array.isArray(data.logs)) {
            setOlder(current => ({ ...current, loading: false }))
            return
          }
          if (data.logs.length === 0) {
            setOlder({ loading: false, hasMore: false })
            return
          }
          const el = logRef.current
          const beforeHeight = el ? el.scrollHeight : 0
          const beforeTop = el ? el.scrollTop : 0
          setSt(current => ({ ...current, logs: data.logs.concat(current.logs) }))
          setOlder({ loading: false, hasMore: data.hasMore === true })
          if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => {
              const node = logRef.current
              if (!node) return
              node.scrollTop = beforeTop + (node.scrollHeight - beforeHeight)
            })
          }
        } catch {
          setOlder(current => ({ ...current, loading: false }))
        }
      }, [older.loading, older.hasMore, st.logs, setSt])

      /* 搜索：直接查本地 JSONL（全量历史），结果替换日志流显示。 */
      React.useEffect(() => {
        const query = search.query.trim()
  /* 清空搜索 = 回到实时日志。这里必须把两个列表的滚动位置归零：
     之前停在搜索结果的第 N 行，切回日志后虚拟窗口仍按那个偏移算，
     算出来是空的——用户看到「日志不见了」，滚一下才恢复。 */
  if (query === '') {
    setScrollTop(0)
    if (logRef.current) logRef.current.scrollTop = 0
    setResultScrollTop(0)
    if (resultRef.current) resultRef.current.scrollTop = 0
    return undefined
  }
        setTarget(null)
        let cancelled = false
        const timer = setTimeout(async () => {
          if (cancelled) return
          setSearch(current => ({ ...current, loading: true, error: '' }))
          const params = new URLSearchParams({ q: query, limit: '2000' })
          if (search.caseSensitive) params.set('case', '1')
          if (search.wholeWord) params.set('word', '1')
          if (search.regex) params.set('regex', '1')
          if (filter !== 'all') params.set('src', filter)
          const data = await api.get('/log/search?' + params.toString())
          if (cancelled) return
          if (!data || data.error) {
            setSearch(current => ({
              ...current, loading: false,
              error: (data && (data.message || data.error)) || '搜索失败',
              matches: [], total: 0, hasMore: false,
            }))
            return
          }
          setSearch(current => ({
            ...current, loading: false, error: '',
            matches: Array.isArray(data.matches) ? data.matches : [],
            total: Number(data.total) || 0,
            hasMore: data.hasMore === true,
          }))
          setScrollTop(0)
          if (logRef.current) logRef.current.scrollTop = 0
          setResultScrollTop(0)
          if (resultRef.current) resultRef.current.scrollTop = 0
        }, 300)
        return () => { cancelled = true; clearTimeout(timer) }
      }, [search.query, search.caseSensitive, search.wholeWord, search.regex, filter, search.nonce])

      /* 点击搜索结果：把目标及其上下文并回实时流，滚动过去并高亮。 */
      const locate = React.useCallback(async (entry) => {
        if (entry === null || entry === undefined || typeof entry.t !== 'number') return
        setNotice('定位中…')
        const params = new URLSearchParams({ t: String(entry.t), before: '200', after: '200' })
        if (typeof entry.text === 'string') params.set('text', entry.text)
        const data = await api.get('/log/context?' + params.toString())
        if (!data || data.error || data.found !== true || !Array.isArray(data.logs)) {
          setNotice('这条日志不在本地文件可读范围内（可能已被轮转）')
          return
        }
        const key = logKey(entry)
        const merged = mergeLogs(logsRef.current, data.logs, CLIENT_MAX_LOGS)
        logsRef.current = merged
        setSt(current => ({ ...current, logs: merged }))
        setTarget({ key, entry })
        setSelectedKey(key)
        setFollow(false)
        const index = merged.findIndex((item) => logKey(item) === key)
        const top = Math.max(0, (index < 0 ? 0 : index) - 8) * ROW_HEIGHT
        setScrollTop(top)
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(() => { if (logRef.current) logRef.current.scrollTop = top })
        }
      }, [setSt])

      const shown = filter === 'all' ? st.logs : st.logs.filter(l => l.src === filter)
      const rows = shown
      const range = virtualRange(scrollTop, viewH, rows.length, ROW_HEIGHT, OVERSCAN)
      const resultRows = search.matches
      const resultRange = virtualRange(resultScrollTop, resultViewH, resultRows.length, ROW_HEIGHT, OVERSCAN)

      React.useEffect(() => {
        const el = resultRef.current
        if (el === null || el === undefined) return undefined
        const measure = () => setResultViewH(el.clientHeight || 200)
        measure()
        if (typeof ResizeObserver === 'function') {
          const observer = new ResizeObserver(measure)
          observer.observe(el)
          return () => observer.disconnect()
        }
        return undefined
      }, [searching])
      React.useEffect(() => {
        if (follow && !searching && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
      }, [shown.length, follow, searching])

      // 三个状态要分清：
      //   busy    = 正在连接（启动 Downloader / 等握手）
      //   burning = 正在烧录
      //   connected = 已连上，可以发命令
      const burning = !!f.burning
      const canCmd = !!f.connected && !burning

      const dot = /完成/.test(f.status) ? 'ok'
        : /错误|失败|超时/.test(f.status) ? 'err'
          : (busy || burning) ? 'busy' : f.online ? 'ok' : ''

      // 状态文案：连接过程中显示当前阶段（启动 Downloader… / 等待握手…），
      // 烧录时显示进度状态，连上后显示真实状态。
      const statusText = busy
        ? (f.stage || '连接中…')
        : burning && pct > 0 ? `${f.status || '烧录中'} ${pct}%`
          : (f.status || '离线')

      // 上次烧录结果（关闭面板后仍能从 /flash/status 读到）
      const lb = f.lastBurn
      const lastBurnText = lb
        ? (lb.ok
          ? `上次烧录：✓ 成功 ${new Date(lb.at).toLocaleTimeString('zh-CN', { hour12: false })}` + (lb.mac ? `（${lb.mac}）` : '')
          : `上次烧录：✗ 失败 ${new Date(lb.at).toLocaleTimeString('zh-CN', { hour12: false })}（${lb.reason || '未知'}）`)
        : ''

      const send = async () => {
        if (!input.trim()) return
        await api.post('/serial/write', { text: input + '\r\n' })
        setInput('')
      }

      const yToolPath = React.useState(() => ({ exe: '', dir: '', configExists: false }))
  const toolPath = yToolPath[0]
  const setToolPath = yToolPath[1]
  const toolDlg = React.useState(() => ({ open: false, value: '', error: null }))
  const toolDialog = toolDlg[0]
  const setToolDialog = toolDlg[1]
  // ---- 上半：设备状态 + 串口选择 ----
      const rowStatus = h('div', { className: 'abw-line', key: 'status' },
    h('span', { className: 'abw-dot', 'data-s': dot }),
    h('span', null, statusText),
    f.com ? h('span', { className: 'abw-badge abw-mono' }, f.com) : null,
    f.mac ? h('span', { className: 'abw-badge abw-mono' }, f.mac) : null,
    /* 工具路径放状态栏：它是「当前连着哪个 Downloader」的一部分，
       和串口/波特率同级。点一下就能改，换工具版本不用去翻菜单。 */
    h('span', { className: 'abw-sp' }),
    h('button', {
      className: 'abw-btn', 'data-v': 'ghost',
      style: { maxWidth: '48ch', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      title: (toolPath.exe || '点击设置 Downloader.exe 的位置')
        + (toolPath.dir ? '\\n配置目录：' + toolPath.dir + (toolPath.configExists ? '' : '（未找到 Downloader.config）') : ''),
      onClick: () => setToolDialog({ open: true, value: toolPath.exe || '' }),
    }, toolPath.exe === ''
      ? '工具路径未设置'
      : ('工具：' + (toolPath.dir ? toolPath.dir.split(/[\\\\/]/).filter(Boolean).pop() : toolPath.exe))),
        h('span', { className: 'abw-dim' }, '串口'),
        h('select', {
          className: 'abw-sel', value: selPort, disabled: busy,
          onChange: e => setSelPort(e.target.value),
        },
          ports.length === 0 ? h('option', { value: '' }, '（无可用串口）') : null,
          ports.map(p => h('option', { key: p.name, value: p.name },
            p.name + (p.desc ? ' — ' + p.desc : '')))
        ),
        h('button', { className: 'abw-btn', 'data-v': 'ghost', onClick: loadPorts, disabled: busy }, '↻'),
        h('select', {
          className: 'abw-sel', value: baud, disabled: busy,
          onChange: e => setBaud(Number(e.target.value)),
        },
          [9600, 115200, 460800, 921600, 1500000, 2000000, 3000000].map(b =>
            h('option', { key: b, value: b }, b))
        )
      )

      // ---- 第二行：固件信息 ----
      const rowInfo = h('div', { className: 'abw-kv', key: 'info' },
        h('div', null, '固件文件'),
        h('div', { className: 'abw-mono', title: f.dcfPath || '' }, f.dcfPath || '—'),
        h('div', null, '固件校验'),
        h('div', { className: 'abw-mono' }, f.fwChecksum || '—'),
        h('div', null, '设备校验'),
        h('div', { className: 'abw-mono' }, f.devChecksum || '—'),
        h('div', null, '串口状态'),
        h('div', null, s.open
          ? h('span', null, h('span', { className: 'abw-dot', 'data-s': 'ok' }), ' ' + s.port + ' @' + s.baud)
          : h('span', { className: 'abw-dim' }, '未打开'))
      )

      const rowProg = h('div', { className: 'abw-prog', key: 'prog' },
        h('i', { style: { width: pct + '%' } })
      )

      // ---- 第三行：动作 ----
      // 按钮文案直接反映阶段：busy 时显示「启动 Downloader…」「等待握手…」
      const btnConnect = h('button', {
        key: 'connect', className: 'abw-btn', 'data-v': 'pri', disabled: busy,
        onClick: async () => {
          // 无弹窗：发现旧实例就自动清掉再连，过程写日志
          let r = await api.post('/flash/start', {})
          if (r.ok) return
          if (r.error === 'already-running') {
            const k = await api.post('/flash/kill-foreign', {})
            if (k.ok) {
              r = await api.post('/flash/start', { force: true })
              if (r.ok) return
            }
          }
        },
      }, busy
        ? (f.stage || '连接中…')
        : (f.connected ? '重新连接' : '连接 Downloader'))
  /* 选择 Downloader.exe 的位置。
   *
   * 为什么需要这个按钮：配置文件的目录是从工具位置推导出来的（Downloader.config
   * 就在 exe 旁边）。原来只认环境变量，用户没配就只能写到 ~/Downloader —— 于是
   * 「切换工作目录」写配置静默失败，工具里还是旧文件。 */
  React.useEffect(() => {
    let stop = false
    void (async () => {
      const r = await api.get('/tool')
      if (stop || r === null || r === undefined) return
      setToolPath({ exe: r.exe || '', dir: r.dir || '', configExists: r.configExists === true })
    })()
    return () => { stop = true }
  }, [])

  /* 页面内的输入框，不用 window.prompt：
   *
   * Electron 里 prompt() 是**不支持**的（调用会抛错/直接返回），点了按钮看起来
   * 毫无反应。alert/confirm 可用，但 prompt 不行。 */
  const saveToolPath = async () => {
    const value = toolDialog.value.trim()
    const r = await api.post('/tool', { exe: value })
    if (r && r.ok === true) {
      setToolPath({ exe: r.exe || '', dir: r.dir || '', configExists: r.configExists === true })
      setToolDialog({ open: false, value: '', error: null })
    } else {
      /* 404 的兜底文案是 'not found'：它意味着宿主半侧还没有 /tool 路由。
         文件已经同步到磁盘，但**宿主插件只在 DSH 启动时加载**。
         直接说清楚，比让用户对着 not found 猜要好。 */
      const raw = (r && r.error) ? String(r.error) : '保存失败'
      const hint = raw === 'not found'
        ? '宿主还没有 /tool 接口：请完全退出并重新打开 DSH（只刷新页面不够，宿主插件在启动时加载）'
        : raw
      setToolDialog((d) => ({ ...d, error: hint }))
    }
  }


      // ⚠️ 这里曾经写成 disabled: !busy，结果握手成功后 busy 复位成 false，
      //    按钮反而被禁用（用户看到"开始烧录"是灰的）。
      //    正确的判断是 connected（能发命令），烧录中再禁用一次。
      const btnBurn = h('button', {
        key: 'burn', className: 'abw-btn', 'data-v': 'danger', disabled: !canCmd,
        title: canCmd ? '把当前 dcf 写入芯片' : (burning ? '烧录中…' : '请先连接 Downloader'),
        onClick: async () => {
          // 无弹窗直接烧（危险动作靠“两步”防误触：
          // 需要先拿到 connected 才能点，而连接本身需要主动点）
          const r = await api.post('/flash/download', { confirm: true })
          if (!r.ok && r.error !== 'not-ready' && r.error !== 'no-device') {
            setNotice('烧录请求失败：' + (r.message || r.error || ''))
          }
        },
      }, burning ? '烧录中…' : '开始烧录')

      const btnSerial = s.open
        ? h('button', {
          key: 'ser', className: 'abw-btn',
          onClick: () => api.post('/serial/close', {}),
        }, '关闭串口')
        : h('button', {
          key: 'ser', className: 'abw-btn',
          onClick: async () => {
            const r = await api.post('/serial/open', { port: selPort, baud })
            if (!r.ok) setNotice('打开 ' + selPort + ' 失败：' + (r.msg || r.error || '可能被占用'))
          },
        }, '打开串口')

      const btnStop = (canCmd || burning)
        ? h('button', {
          key: 'stop', className: 'abw-btn', 'data-v': 'ghost',
          onClick: () => api.post('/flash/stop', {}),
        }, '断开')
        : null

      // 自动烧录开关：监听编译产物 dcf，变化就自动烧。
      // 你在 Downloader 界面里切换 dcf 时，插件会自动跟随（读它的下拉框）。
      const w = st.watch || {}

      const btnWatch = h('button', {
        key: 'watch', className: 'abw-btn',
        'data-v': w.on ? 'pri' : 'ghost',
        title: w.on
          ? '正在监听：' + (w.path || '') + '\n点一下停止'
          : '开启后，每次编译完自动烧录',
        onClick: async () => {
          const r = await api.post('/watch', { on: !w.on })
          if (!r.ok) setNotice('自动烧录：' + (r.error || '开启失败'))
        },
      }, w.on ? '◉ 自动烧录' : '○ 自动烧录')

      const rowActions = h('div', { className: 'abw-line', key: 'actions', style: { marginBottom: 10 } },
      btnConnect, btnBurn, btnSerial, btnStop, btnWatch,
        h('span', { className: 'abw-sp' }),
        lastBurnText
          ? h('span', { className: 'abw-dim',
              style: { fontSize: 11, color: lb && lb.ok ? '#3fb950' : '#f85149' },
            }, lastBurnText)
          : h('span', { className: 'abw-dim', style: { fontSize: 11 } },
              'Downloader 窗口已显示，可直接在其界面里选文件')
      )

      // 内联提示条（替代弹窗）：有事就在下面这行显示，3 秒后自动消失
      const noticeBar = notice
        ? h('div', {
          className: 'abw-line',
          style: { padding: '4px 8px', marginBottom: 6, borderRadius: 5,
            background: 'rgba(248,81,73,.12)', color: '#f85149', fontSize: 12 },
        }, notice)
        : null

      const top = h('div', { className: 'abw-top' },
        noticeBar, rowStatus, rowInfo, rowProg, rowActions)

      // ---- 下半：日志 ----
      const logBar = h('div', { className: 'abw-lbar' },
                h('span', { className: 'abw-dim', style: { fontSize: 12 } },
          '日志 ' + shown.length + (older.hasMore ? ' · 上滚加载更早' : '') + (older.loading ? ' · 加载中…' : '')),
        st.logFile && st.logFile.size > 0
          ? h('span', {
            className: 'abw-dim',
            style: { fontSize: 11, cursor: 'help' },
            title: (st.logFile.path || '') + '\n点「清空」会同时截断本地日志文件',
          }, '本地 ' + formatBytes(st.logFile.size) + (st.logFile.rotated ? '（含 .1）' : ''))
          : null,
        h('span', { className: 'abw-sp' }),
        h('select', {
          className: 'abw-sel', value: filter, onChange: e => setFilter(e.target.value),
        },
          h('option', { value: 'all' }, '全部'),
          h('option', { value: 'B' }, '板卡'),
          h('option', { value: 'D' }, '烧录'),
          h('option', { value: 'S' }, '系统')
        ),
        h('label', {
          className: 'abw-dim',
          style: { fontSize: 12, cursor: 'pointer', display: 'flex', gap: 4, alignItems: 'center' },
        },
          h('input', { type: 'checkbox', checked: follow, onChange: e => setFollow(e.target.checked) }),
          '跟随'
        ),

        h('button', {
          className: 'abw-btn', 'data-v': 'ghost',
          onClick: () => api.post('/log/clear', {}),
        }, '清空')
      )

      // ★ 时间戳：之前只渲染了 [src] text，没有时间，所以看不到。
      const fmtT = (ms) => {
        const d = new Date(ms || Date.now())
        const p2 = (n) => String(n).padStart(2, '0')
        return p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds())
      }
      const logBody = rows.length === 0
        ? h('div', { className: 'abw-empty' },
          s.open ? '等待板卡输出…' : '打开串口或连接 Downloader 后，日志会显示在这里')
        : [
          h('div', { key: 'pad-top', style: { height: range.topPad } }),
          ...rows.slice(range.start, range.end).map((l, i) => h('div', {
            className: 'abw-ll' + (target !== null && logKey(l) === target.key ? ' is-target' : ''),
            key: (l.t || 0) + '-' + (range.start + i),
            style: { height: ROW_HEIGHT, lineHeight: ROW_HEIGHT + 'px' },
          },
          h('span', { className: 'abw-lt-time' }, fmtT(l.t)),
          h('span', { className: 'abw-ls', 'data-s': l.src || 'S' }, SRC[l.src] || '·'),
          h('span', { className: 'abw-lt' }, ...searchParts(l.text, search.query, search.caseSensitive, search.wholeWord, search.regex)
            .map((part, j) => (part.hit
              ? h('span', { key: j, className: 'abw-hit' }, part.text)
              : part.text)))
          )),
          h('div', { key: 'pad-bottom', style: { height: range.bottomPad } }),
        ]

      const logBox = h('div', {
        className: 'abw-log', ref: logRef,
        onScroll: (e) => {
          const el = e.currentTarget
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
          if (atBottom !== follow) setFollow(atBottom)
          setScrollTop(el.scrollTop)
          if (!searching && el.scrollTop < ROW_HEIGHT * 10 && older.hasMore && !older.loading) void loadOlder()
        },
      }, logBody)

      const locateBar = target !== null
        ? h('div', { className: 'abw-search' },
          h('span', {
            className: 'abw-dim',
            style: { fontSize: 11, flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          }, '已定位到实时日志：' + fmtT(target.entry && target.entry.t) + ' [' + ((target.entry && target.entry.src) || 'S') + '] ' + ((target.entry && target.entry.text) || '')),
          h('button', {
            className: 'abw-btn', 'data-v': 'ghost',
            onClick: () => setTarget(null),
          }, '清除定位'))
        : null

      const resultBox = searching
        ? h('div', { className: 'abw-result' },
          h('div', { className: 'abw-resultsBar' },
            h('span', { className: 'abw-dim', style: { fontSize: 11 } },
              '搜索结果 ' + search.total + ' 条' +
              (search.hasMore ? '（显示前 ' + search.matches.length + ' 条）' : '') +
              (search.loading ? ' · 搜索中…' : '') +
              (search.error !== '' ? ' · ' + search.error : '')),
            h('span', { className: 'abw-sp' })),
          h('div', {
            className: 'abw-log abw-resultList', ref: resultRef,
            onScroll: (e) => setResultScrollTop(e.currentTarget.scrollTop),
          },
            resultRows.length === 0
              ? h('div', { className: 'abw-empty' },
                search.loading ? '搜索中…' : (search.error !== '' ? search.error : '没有匹配的日志'))
              : [
                h('div', { key: 'rpad-top', style: { height: resultRange.topPad } }),
                ...resultRows.slice(resultRange.start, resultRange.end).map((l, i) => h('div', {
                  className: 'abw-ll' +
                    (selectedKey !== null && logKey(l) === selectedKey ? ' is-selected' : '') +
                    (target !== null && logKey(l) === target.key ? ' is-target' : ''),
                  key: (l.t || 0) + '-r-' + (resultRange.start + i),
                  style: { height: ROW_HEIGHT, lineHeight: ROW_HEIGHT + 'px', cursor: 'pointer' },
                  onClick: () => { setSelectedKey(logKey(l)); void locate(l) },
                },
                h('span', { className: 'abw-lt-time' }, fmtT(l.t)),
                h('span', { className: 'abw-ls', 'data-s': l.src || 'S' }, SRC[l.src] || '·'),
                h('span', { className: 'abw-lt' }, ...searchParts(l.text, search.query, search.caseSensitive, search.wholeWord, search.regex)
                  .map((part, j) => (part.hit
                    ? h('span', { key: j, className: 'abw-hit' }, part.text)
                    : part.text))))),
                h('div', { key: 'rpad-bottom', style: { height: resultRange.bottomPad } }),
              ])
        )
        : null

      const logSplit = h('div', { className: 'abw-split' }, logBox, resultBox)

      const searchRow = h('div', { className: 'abw-search' },
        h('input', {
          className: 'abw-inp abw-mono', style: { flex: '1 1 auto' },
          placeholder: '搜索日志（支持正则 / 区分大小写 / 全字）',
          value: search.query,
          onChange: e => setSearch(current => ({ ...current, query: e.target.value })),
          onKeyDown: (e) => {
            if (e.key === 'Enter') {
              setSearch(current => ({ ...current, nonce: (current.nonce || 0) + 1 }))
              return
            }
            if (e.key === 'Escape') {
              setSearch({ query: '', caseSensitive: false, wholeWord: false, regex: false, loading: false, error: '', matches: [], total: 0, hasMore: false, nonce: 0 })
              setScrollTop(0)
            }
          },
        }),
        h('button', {
          className: 'abw-btn', 'data-v': search.caseSensitive ? 'pri' : 'ghost',
          title: '区分大小写 (Aa)',
          onClick: () => setSearch(current => ({ ...current, caseSensitive: !current.caseSensitive })),
        }, 'Aa'),
        h('button', {
          className: 'abw-btn', 'data-v': search.wholeWord ? 'pri' : 'ghost',
          title: '全字匹配 (ab)',
          onClick: () => setSearch(current => ({ ...current, wholeWord: !current.wholeWord })),
        }, 'ab'),
        h('button', {
          className: 'abw-btn', 'data-v': search.regex ? 'pri' : 'ghost',
          title: '正则表达式 (.*)',
          onClick: () => setSearch(current => ({ ...current, regex: !current.regex })),
        }, '.*'),
        searching
          ? h('button', {
            className: 'abw-btn', 'data-v': 'ghost',
            title: '清除搜索',
            onClick: () => {
              setSearch({ query: '', caseSensitive: false, wholeWord: false, regex: false, loading: false, error: '', matches: [], total: 0, hasMore: false, nonce: 0 })
              setScrollTop(0)
            },
          }, '清除')
          : null
      )

      const sendBar = h('div', { className: 'abw-send' },
        h('input', {
          className: 'abw-inp abw-mono', style: { flex: '1 1 auto' },
          placeholder: s.open ? '发送文本（回车发送，自动加 CRLF）' : '串口未打开',
          value: input, disabled: !s.open,
          onChange: e => setInput(e.target.value),
          onKeyDown: e => { if (e.key === 'Enter') send() },
        }),
        h('button', { className: 'abw-btn', disabled: !s.open, onClick: send }, '发送')
      )

      const bottom = h('div', { className: 'abw-logwrap' }, logBar, locateBar, searchRow, logSplit, sendBar)

  /* 工具路径对话框：内联渲染，不依赖任何弹窗 API。 */
  const toolModal = toolDialog.open === true
    ? h('div', {
      key: 'toolmodal',
      style: {
        position: 'fixed', inset: 0, zIndex: 9999, display: 'flex',
        alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,.45)', padding: 16,
      },
    },
    h('div', {
      style: {
        width: 'min(560px,100%)', background: '#161b22', color: '#e6edf3',
        border: '1px solid #30363d', borderRadius: 8, padding: 16,
        font: 'inherit', fontSize: 13, display: 'flex', flexDirection: 'column', gap: 10,
      },
    },
    h('div', { style: { fontWeight: 600 } }, 'Downloader.exe 的位置'),
    h('div', { style: { fontSize: 12, color: '#8b949e', lineHeight: 1.6 } },
      '配置文件（Downloader.config）就在这个 exe 旁边，切换工作目录时要写进它。'),
    h('input', {
      type: 'text', value: toolDialog.value, spellCheck: false,
      placeholder: 'D:\\AB\\软件工具\\Downloader_v3.6.0_内部版\\Downloader.exe',
      style: {
        height: 30, padding: '0 8px', borderRadius: 5,
        border: '1px solid #30363d', background: '#0d1117', color: 'inherit',
        font: 'inherit', fontSize: 12,
      },
      onChange: (e) => setToolDialog((d) => ({ ...d, value: e.target.value, error: null })),
      onKeyDown: (e) => { if (e.key === 'Enter') void saveToolPath() },
    }),
    toolDialog.error ? h('div', { style: { fontSize: 12, color: '#f85149' } }, String(toolDialog.error)) : null,
    h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } },
      h('button', { className: 'abw-btn', onClick: () => setToolDialog({ open: false, value: '' }) }, '取消'),
      h('button', { className: 'abw-btn', 'data-v': 'pri', onClick: () => { void saveToolPath() } }, '保存')))
    )
: null

      return h('div', { className: 'abw' }, top, bottom, toolModal)
    }

    function VsIcon({ size = 14 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.4, strokeLinejoin: 'round', strokeLinecap: 'round',
      },
        h('path', { d: 'M11.5 1.8 6.2 6.6 3.4 4.4 1.8 5.2v5.6l1.6.8 2.8-2.2 5.3 4.8 2.7-1.2V3z' }),
        h('path', { d: 'M11.5 4.6v6.8L7.6 8z', strokeWidth: 0 }),
      )
    }

    // ---------------------------------------------------------------- 注册
    //
    // 只向「工作台」插件（dsh-workbay-dock）注册一个页面，不再占用
    // dsh-better-sidebar 的 Tab 栏：按钮和独立右侧栏都由 dock 提供，
    // 这里只负责面板组件本身。
    //
    // dock 与本体是两个独立 bundle，加载顺序无保证，所以注册表放在一个
    // 浏览器全局上；谁先到谁创建，另一个复用同一个对象。

    function registerWithDock(ctx) {
      var dock = typeof window === 'object' && window !== null ? window.__DSH_WORKBAY__ : undefined
      if (dock === undefined || dock === null || typeof dock.registerPage !== 'function') return false
      try {
        var off = dock.registerPage({
          id: 'downloader',
          title: 'Downloader',
          order: 30,
          icon: function (size) { return h(VsIcon, { size: size === undefined ? 16 : size }) },
          component: function () { return h(FlashPanel, null) },
        })
        ctx.effect(function () { return off }, 'downloader: workbench page')
        return true
      } catch (e) {
        try { console.error('[downloader] 注册工作台页面失败:', e) } catch { }
        return false
      }
    }

    return {
      // 不 inject betterSidebar：本插件与它无关
      inject: [],
      apply(ctx) {

        if (registerWithDock(ctx)) return
        // dock 可能还没加载：短轮询等待，超时后安静放弃（没有 dock 就没有可渲染的位置）
        var attempts = 0
        var timer = setInterval(function () {
          attempts += 1
          if (registerWithDock(ctx) || attempts >= 40) clearInterval(timer)
        }, 250)
        ctx.effect(function () { return function () { clearInterval(timer) } }, 'downloader: dock discovery')
      },
      __test: { appendLogs, virtualRange, searchParts, mergeLogs, formatBytes },
    }
  },
})






