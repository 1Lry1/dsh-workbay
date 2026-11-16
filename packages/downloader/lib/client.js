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
    const ROW_HEIGHT = 20
    const OVERSCAN = 20

    /** 批量追加 + 环形裁剪；返回新数组，不修改入参。 */
/* The last workspace root this PAGE told the host. Module scope on purpose: the
   sync effect re-runs on every remount and a per-run variable starts at null —
   that sent the same root three times in one second. */
let lastSentRoot = null

/* ---- split layout (settings | log) ------------------------------------- */
const LEFT_WIDTH_KEY = 'dsh-workbay.downloader.leftw.v1'
function defaultLeftWidth(tier) { return tier === 't4' ? 420 : 360 }
function clampLeftWidth(value, mainWidth) {
  const n = Number(value)
  const fallback = defaultLeftWidth('t3')
  /* CSS caps the settings column at 45% so the log never drops below 55%; the JS
     clamp must use the SAME ceiling or dragging would stop changing anything. */
  const max = Number.isFinite(mainWidth) && mainWidth > 0
    ? Math.max(280, Math.min(560, Math.floor(mainWidth * 0.45)))
    : 560
  if (!Number.isFinite(n)) return Math.min(fallback, max)
  return Math.round(Math.max(280, Math.min(max, n)))
}
function readLeftWidthStored() {
  try {
    const raw = window.localStorage.getItem(LEFT_WIDTH_KEY)
    const n = Number(raw)
    return Number.isFinite(n) && n >= 280 ? Math.round(n) : 0
  } catch (error) { void error; return 0 }
}
function storeLeftWidth(value) {
  try { window.localStorage.setItem(LEFT_WIDTH_KEY, String(Math.round(value))) } catch (error) { void error }
}

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
/* 工具卡：Downloader.exe 的位置决定「配置写到哪里」，所以它不是一条可选的设置，
   而是烧录的前置条件。未设置时整条变黄并直接给出设置入口。 */
.abw-tool{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px;padding:6px 9px;border:1px solid rgba(255,255,255,.10);border-radius:8px;background:rgba(255,255,255,.02)}
.abw-tool.is-missing{border-color:rgba(226,160,63,.35);background:rgba(226,160,63,.08)}
.abw-toolName{font-size:12px;font-weight:600}
.abw-toolPath{font-family:ui-monospace,Consolas,monospace;font-size:11px;opacity:.75;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:52ch}
.abw-toolTag{font-size:10px;padding:1px 6px;border-radius:8px;background:rgba(255,255,255,.07);opacity:.85}
      .abw-sp{flex:1 1 auto}
      .abw-dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto;background:var(--dsw-fg-3,#666)}
      .abw-dot[data-s="ok"]{background:#3fb950}
      .abw-dot[data-s="warn"]{background:#d29922}
      .abw-dot[data-s="err"]{background:#f85149}
      .abw-dot[data-s="busy"]{background:#4c9aff;animation:abwp 1s infinite}
      @keyframes abwp{50%{opacity:.3}}

      .abw-burnSplit{position:relative;display:inline-flex;align-items:stretch;gap:0}
    .abw-burnSplit>.abw-btn:first-child{border-top-right-radius:0;border-bottom-right-radius:0}
    .abw-caret{border-top-left-radius:0!important;border-bottom-left-radius:0!important;padding-left:5px!important;padding-right:5px!important;margin-left:-1px}
    .abw-menu{position:absolute;top:calc(100% + 6px);left:0;z-index:80;min-width:190px;padding:6px;border:1px solid var(--dsw-border,#3a3a40);border-radius:7px;background:var(--dsw-bg-2,#232327);box-shadow:0 8px 24px rgba(0,0,0,.45)}
    .abw-menuTitle{font-size:10px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-fg-3,#8a8f98);padding:3px 6px}
    .abw-menuItem{display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:4px;font-size:12px;color:var(--dsw-fg-1,#e6e8eb);cursor:pointer;white-space:nowrap}
    .abw-menuItem:hover{background:rgba(255,255,255,.07)}
    .abw-menuItem input{accent-color:var(--dsw-brand,#4d6bfe)}
    .abw-menuSep{height:1px;background:rgba(255,255,255,.09);margin:5px 2px}
    .abw-menuHint{padding:4px 6px 2px;font-size:10px;line-height:1.35;color:var(--dsw-fg-3,#8a8f98);max-width:210px;white-space:normal}\n    .abw-btn{display:inline-flex;align-items:center;gap:5px;padding:5px 10px;border-radius:6px;
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
/* 宽档：左「设置与操作」/ 右「日志」，与参考图一致 */
.abw-main{display:flex;flex-direction:column;flex:1 1 auto;min-height:0}
.abw.is-wide .abw-main{flex-direction:row}
.abw.is-wide .abw-left{flex:none;min-width:280px;max-width:45%;min-height:0;overflow:auto;border-right:1px solid var(--dsw-border,#2c2c2f)}
.abw-splitter{flex:none;width:5px;align-self:stretch;cursor:col-resize;background:transparent;touch-action:none;position:relative}
.abw-splitter:hover,.abw-splitter:active{background:var(--dsw-accent,#4c9aff);opacity:.35}
.abw-splitter::after{content:'';position:absolute;inset:0 -3px}
.abw.is-wide .abw-top{border-bottom:none}
.abw.is-wide .abw-right{flex:1 1 auto;min-width:0;min-height:0;display:flex;flex-direction:column}
/* 进度：参考图有「写入数据 / 百分比 / 字节数」三层，光一条 bar 读不出状态 */
.abw-progWrap{display:flex;flex-direction:column;gap:5px;margin:2px 0 10px}
.abw-progTop{display:flex;align-items:baseline;gap:8px;font-size:11.5px;color:var(--dsw-fg,#e6edf3)}
.abw-progLabel{opacity:.75}
.abw-progNum{margin-left:auto;font-variant-numeric:tabular-nums;font-weight:600}
.abw-progMeta{display:flex;gap:10px;font-size:10px;opacity:.55;font-family:ui-monospace,Consolas,monospace}/* 卡片化：固件信息与设备状态不再是一条条裸行 */
.abw-kv{border:1px solid rgba(255,255,255,.10);border-radius:8px;padding:9px 11px;background:rgba(255,255,255,.02)}
.abw-line.is-card{border:1px solid rgba(255,255,255,.10);border-radius:8px;padding:8px 11px;background:rgba(255,255,255,.02)}
      .abw-lbar{flex:0 0 auto;display:flex;align-items:center;gap:8px;margin-bottom:6px}
      .abw-deviceWarn{margin:2px 8px 6px;padding:5px 8px;border-radius:5px;background:rgba(210,153,34,.12);color:var(--dsw-alias-state-warning-primary,#d29922);font-size:11.5px;line-height:1.45}\n.abw-log{flex:1 1 auto;min-height:0;overflow:auto;
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

/* ===== readability baseline ===== */
.abw{font-size:13px}
.abw-btn{font-size:12px;padding:6px 11px}
.abw-sel,.abw-inp{font-size:12px;padding:5px 8px}
.abw-kv{font-size:12.5px}
.abw-toolName{font-size:12.5px}
.abw-toolPath{font-size:11.5px}
.abw-toolTag{font-size:10.5px}
.abw-progTop{font-size:12px}
.abw-progMeta{font-size:11px}
.abw-lbar{font-size:12px}
.abw-log,.abw-ll{font-size:12px}
.abw-empty{font-size:12.5px}
/* ===== 单栏：上方设置区收紧，日志区拿到剩余高度并且自己可滚 =====
   单栏时 .abw-left / .abw-right 原来没有任何 flex 规则，日志容器的高度由内容
   决定，滚轮作用在“整个页面”上而不是日志列表上——看起来就是滚动无效。 */
.abw-main>.abw-left{flex:0 0 auto;min-height:0}
.abw-main>.abw-right{flex:1 1 auto;min-height:0;display:flex;flex-direction:column}
.abw-top{padding:8px 10px 0}
.abw-line{margin-bottom:6px}
.abw-kv{padding:6px 9px;margin-bottom:6px;gap:3px 10px}
.abw-progWrap{gap:4px;margin:0 0 6px}
.abw-prog{margin:1px 0 6px}
.abw-lbar{margin-bottom:4px}
.abw-logwrap{padding:6px 10px 8px}
.abw-btn{padding:4px 10px}
/* 窄档：把上方让给日志 */
.abw.is-compact .abw-top{padding:6px 9px 0}
.abw.is-compact .abw-line{margin-bottom:5px}
.abw.is-compact .abw-kv{padding:5px 8px;margin-bottom:5px}
.abw.is-compact .abw-logwrap{padding:5px 9px 6px}
.abw.is-compact .abw-progMeta{display:none}
.abw-pathChip{flex:1 1 90px;min-width:60px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--dsw-fg-3,#888)}
.abw-sep{flex:none;width:1px;height:16px;background:var(--dsw-border,#2c2c2f);margin:0 2px}
.abw-line.is-collapsible{cursor:pointer;user-select:none}
.abw-cfgSummary{display:flex;align-items:center;gap:8px;min-width:0;overflow:hidden;white-space:nowrap}
.abw-cfgWrap{display:flex;align-items:center;gap:8px;flex:1 1 100%;flex-wrap:wrap;min-width:0}
.abw-cfgChevron{flex:none;color:var(--dsw-fg-3,#888);font-size:10px;transition:transform .12s ease}
.abw-cfgChevron.is-open{transform:rotate(180deg)}

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
      /* Must be a top-level hook: calling useRef inside useEffect is an invalid
         hook call and crashed the whole page (React error #321). */
      const liveRef = React.useRef(false)

      React.useEffect(() => {
        let alive = true
        /* The initial GET and the SSE hello race. A late GET response must not
           overwrite a newer serial-state (that made a just-opened port look
           closed). Once any SSE frame arrived, the stream is authoritative. */
        api.get('/state').then(s => {
          if (alive && liveRef.current !== true && s && !s.error) setSt(x => ({ ...x, ...s }))
        })
        const es = new EventSource(API + '/events')
        es.onmessage = (m) => {
          liveRef.current = true
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

    function FlashPanel(props) {
      /* The workbench shell resolves the layout from the panel width; at t3/t4 the
      /* burn page splits into 设置列 + 日志列 like the reference. */
      var shellWide = props !== null && props !== undefined && (props.tier === 't3' || props.tier === 't4')
  /* 窄档（T1/T2）竖向空间紧张：日志优先，次要信息收起来。 */
  var shellCompact = props !== null && props !== undefined && (props.tier === 't1' || props.tier === 't2')
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
      /* 擦除是全片动作，鼠标滑一下就烧进去太危险：第一次点只「上膛」，3 秒内再点
         才真正发送 StartErase。 */
      const [eraseArmed, setEraseArmed] = React.useState(false)
  /* 单栏时这条卡默认收成一行（状态 + 串口 + 波特率），点一下才展开具体配置：
     日志区才有高度。宽档（T3/T4）始终展开。 */
  const [configOpen, setConfigOpen] = React.useState(false)
      /* Esc 逐级返回：擦除的「上膛」状态先取消（这是最该被 Esc 撤掉的一步），
         没有可退的层级时才把 Esc 交还给外壳。 */
      React.useEffect(() => {
        const dock = typeof window === 'object' && window !== null ? window.__DSH_WORKBAY__ : undefined
        if (!dock || typeof dock.setBackHandler !== 'function') return undefined
        dock.setBackHandler('downloader', () => {
          if (eraseArmed === true) { setEraseArmed(false); return true }
          return false
        })
        return () => {
          if (typeof dock.setBackHandler === 'function') dock.setBackHandler('downloader', null)
        }
      }, [eraseArmed])
      /* AI debug loop: keep sys_sleep_time=0 in the generated watch.setting.
         The checkbox shows the file's CURRENT value; polling catches a manual
         edit. Checking writes 0 (and enables pre-flash enforcement); unchecking
         only stops enforcement and never rewrites the file. */
      const [noSleep, setNoSleep] = React.useState({
        loading: true, auto: false, exists: false, value: null, noSleep: false, path: '',
      })
      const [noSleepChecked, setNoSleepChecked] = React.useState(false)
      const noSleepLastValue = React.useRef(null)
      const noSleepBusy = React.useRef(false)
      const watchPath = st.watch && typeof st.watch.path === 'string' ? st.watch.path : ''
      React.useEffect(() => {
        let alive = true
        const applyStatus = (data, syncChoice) => {
          if (!alive || !data || data.error) return
          setNoSleep({ ...data, loading: false })
          if (data.exists !== true) {
            if (syncChoice) {
              noSleepLastValue.current = null
              setNoSleepChecked(false)
            }
            return
          }
          const value = data.value === null || data.value === undefined ? '' : String(data.value)
          const changed = value !== noSleepLastValue.current
          noSleepLastValue.current = value
          /* A manual edit is a change in the file; re-sync the checkbox. If the
             value merely stayed the same after an uncheck, keep it unchecked. */
          if (syncChoice || changed) setNoSleepChecked(data.noSleep === true)
        }
        const load = (initial) => {
          if (noSleepBusy.current) return
          api.get('/setting/no-sleep').then((data) => { applyStatus(data, initial) })
        }
        load(true)
        const timer = setInterval(() => load(false), 2000)
        return () => { alive = false; clearInterval(timer) }
      }, [watchPath])
      const toggleNoSleep = async (event) => {
        const want = event.target.checked === true
        noSleepBusy.current = true
        setNoSleep((previous) => ({ ...previous, loading: true }))
        const r = await api.post('/setting/no-sleep', { on: want })
        noSleepBusy.current = false
        if (r && !r.error) {
          setNoSleep({ ...r, loading: false })
          setNoSleepChecked(want)
          noSleepLastValue.current = r.exists === true
            ? (r.value === null || r.value === undefined ? '' : String(r.value))
            : null
          setNotice(want
            ? (r.exists === true
              ? '已设为不休眠（sys_sleep_time=0），烧录前会自动保持'
              : '已开启不休眠；等编译生成 Settings/watch.setting 后自动写入')
            : (r.restored === true
              ? '已取消勾选，并还原 watch.setting 的 sys_sleep_time=' + (r.original || '')
              : '已取消勾选；没有记录的原始休眠值，保持当前 setting'))
        } else {
          setNoSleep((previous) => ({ ...previous, loading: false }))
          setNotice('修改不休眠设置失败：' + ((r && (r.message || r.error)) || '未知错误'))
        }
      }
      /* Burn options live in Downloader.config (the vendor tool reads them at
         launch). The workbench Start button gets a split caret that exposes the
         four persistent flags + speed, instead of a wall of buttons. */
      const [burnCfg, setBurnCfg] = React.useState({ loading: true, exists: false })
      const [burnMenuOpen, setBurnMenuOpen] = React.useState(false)
      const burnMenuRef = React.useRef(null)
      const loadBurnCfg = async () => {
        const r = await api.get('/setting/burn')
        if (r && !r.error) setBurnCfg({ ...r, loading: false })
        else setBurnCfg((previous) => ({ ...previous, loading: false, error: true }))
      }
      React.useEffect(() => { void loadBurnCfg() }, [])
      React.useEffect(() => {
        if (burnMenuOpen !== true) return undefined
        const onDown = (event) => {
          if (burnMenuRef.current !== null && burnMenuRef.current.contains(event.target)) return
          setBurnMenuOpen(false)
        }
        document.addEventListener('mousedown', onDown)
        return () => document.removeEventListener('mousedown', onDown)
      }, [burnMenuOpen])
      const saveBurnOption = async (patch) => {
        setBurnCfg((previous) => ({ ...previous, loading: true }))
        const r = await api.post('/setting/burn', patch)
        if (r && !r.error) {
          setBurnCfg({ ...r, loading: false })
          setNotice('烧录配置已保存到 Downloader.config'
            + ((st.flash && st.flash.connected) === true ? '；断开重连 Downloader 后生效' : '；下次启动 Downloader 生效'))
        } else {
          setBurnCfg((previous) => ({ ...previous, loading: false }))
          setNotice('保存烧录配置失败：' + ((r && (r.message || r.error)) || '未知错误'))
        }
      }
      // 提示自动消失（3 秒），不留残在界面上
      React.useEffect(() => {
        if (!notice) return
        /* "正在…" is progress, not a transient toast: keep it visible until the
           request finishes (the manual offline wait can take 20 s). */
        if (notice.indexOf('正在') === 0) return undefined
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

      /* 把这一页的一句话状态交给工作台外壳的状态栏。外壳不在（独立面板）或版本
         太旧时直接跳过，行为与以前完全一致。 */
      React.useEffect(() => {
        var dock = typeof window === 'object' && window !== null ? window.__DSH_WORKBAY__ : undefined
        if (!dock) return
        var line = '烧录 · ' + (statusText || '离线')
        /* Per-page so a running burn stays visible while the user reads code. */
        if (typeof dock.setStatus === 'function') dock.setStatus('downloader', line)
        else if (typeof dock.setContext === 'function') dock.setContext({ status: line })
      }, [statusText])

      /* 工作台上下文：把「当前工作区」同步给宿主，扫 dcf / 自动烧录都跟着它走。
         独立面板没有外壳，这条永远不触发。 */
      const lastRootRef = React.useRef('')
      React.useEffect(() => {
        var dock = typeof window === 'object' && window !== null ? window.__DSH_WORKBAY__ : undefined
        if (!dock || typeof dock.subscribeContext !== 'function') return undefined
        var applyRoot = function (ctx) {
          var dir = ctx && typeof ctx.path === 'string' ? ctx.path : ''
          if (dir === '' || dir === lastRootRef.current) return
          lastRootRef.current = dir
          /* 宿主会校验目录是否存在；失败就保持上次的根，不打断烧录流程。 */
          try { void api.post('/fs/set-root', { dir: dir }) } catch (e) { void e }
        }
        applyRoot(typeof dock.getContext === 'function' ? dock.getContext() : null)
        var off = dock.subscribeContext(applyRoot)
        return typeof off === 'function' ? off : undefined
      }, [])

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
      /* 双栏：左设置 / 右日志。宽度可拖，默认给日志留够空间（T3 以前日志只有 ~500px）。 */
      const [leftWidth, setLeftWidth] = React.useState(() => {
        const stored = readLeftWidthStored()
        return stored > 0 ? stored : defaultLeftWidth(props !== null && props !== undefined ? props.tier : undefined)
      })
      const onSplitterDown = (event) => {
        event.preventDefault()
        const startX = event.clientX
        const startW = leftWidth
        const main = event.currentTarget !== null && event.currentTarget !== undefined ? event.currentTarget.parentElement : null
        const mainW = main !== null && main !== undefined ? main.clientWidth : 0
        const onMove = (moveEvent) => {
          setLeftWidth(clampLeftWidth(startW + (moveEvent.clientX - startX), mainW))
        }
        const onUp = () => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          setLeftWidth((value) => { storeLeftWidth(value); return value })
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
      }
  const toolDialog = toolDlg[0]
  const setToolDialog = toolDlg[1]
  // ---- 上半：设备状态 + 串口选择 ----
      /* 工具卡：Downloader.exe 的位置决定配置文件写到哪个目录（Downloader.config
         就在 exe 旁边），所以它是烧录的前置条件，不是可选的设置项。 */
      const toolReady = toolPath.exe !== ''
      /* 工具 + 设备合成一行：这两件事都是「连接前的准备」，各占一张卡只会把日志
         区挤小。路径缩成省略号，完整路径在 title 与设置对话框里。 */
      /* Unknown tier (standalone mount / a host that does not pass tier) must show the
         configuration: collapsing it there left the card with no expand affordance,
         so the 设置工具… button simply did not exist. */
      const configExpanded = shellWide === true || shellCompact !== true || configOpen === true
      const rowToolDevice = h('div', {
        className: 'abw-line is-card' + (toolReady ? '' : ' is-missing') + (shellCompact ? ' is-collapsible' : ''),
        key: 'tool',
        title: shellCompact ? (configExpanded ? '点击收起具体配置' : '点击展开具体配置') : undefined,
        onClick: shellCompact ? () => setConfigOpen((value) => value !== true) : undefined,
      },
        h('span', { className: 'abw-dot', 'data-s': toolReady ? (toolPath.configExists ? 'ok' : 'warn') : 'err' }),
        h('span', { className: 'abw-toolName' }, toolReady ? 'Downloader.exe' : '工具未设置'),
        toolReady ? null : h('span', { className: 'abw-dim' }, '烧录前需要指定 Downloader.exe 的位置'),
        /* 收起态：一眼能读的连接摘要；展开态：完整配置 */
        configExpanded
          ? null
          : h('span', { className: 'abw-cfgSummary' },
            h('span', { className: 'abw-dot', 'data-s': dot }),
            h('span', null, statusText),
            f.com ? h('span', { className: 'abw-badge abw-mono' }, f.com) : null,
            h('span', { className: 'abw-dim abw-mono' }, baud + ' baud')),
        h('span', { className: 'abw-sp' }),
        configExpanded
          ? h('span', { className: 'abw-cfgWrap', onClick: (event) => { event.stopPropagation() } },
            toolReady ? h('span', { className: 'abw-pathChip', title: toolPath.exe }, toolPath.exe) : null,
            h('button', {
              className: 'abw-btn', 'data-v': toolReady ? 'ghost' : 'pri',
              title: toolReady ? '重新选择 Downloader.exe' : '选择 Downloader.exe 的位置',
              onClick: () => setToolDialog({ open: true, value: toolPath.exe || '' }),
            }, toolReady ? '更换' : '设置工具…'),
            h('span', { className: 'abw-sep' }),
            h('span', { className: 'abw-dot', 'data-s': dot }),
            h('span', null, statusText),
            f.com ? h('span', { className: 'abw-badge abw-mono' }, f.com) : null,
            f.mac ? h('span', { className: 'abw-badge abw-mono' }, f.mac) : null,
            h('select', {
              className: 'abw-sel', value: selPort, disabled: busy, title: '串口',
              onChange: e => setSelPort(e.target.value),
            },
              ports.length === 0 ? h('option', { value: '' }, '（无可用串口）') : null,
              ports.map(p => h('option', { key: p.name, value: p.name },
                p.name + (p.desc ? ' — ' + p.desc : '')))
            ),
            h('button', { className: 'abw-btn', 'data-v': 'ghost', onClick: loadPorts, disabled: busy, title: '刷新串口' }, '↻'),
            h('select', {
              className: 'abw-sel', value: baud, disabled: busy, title: '波特率',
              onChange: e => setBaud(Number(e.target.value)),
            },
              [9600, 115200, 460800, 921600, 1500000, 2000000, 3000000].map(b =>
                h('option', { key: b, value: b }, b))
            ))
          : null,
        shellCompact
          ? h('span', { className: 'abw-cfgChevron' + (configExpanded ? ' is-open' : ''), 'aria-hidden': 'true' }, '▾')
          : null
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

      const rowProg = h('div', { className: 'abw-progWrap', key: 'prog' },
        h('div', { className: 'abw-progTop' },
          h('span', { className: 'abw-progLabel' }, burning ? '写入数据' : '就绪'),
          h('span', { className: 'abw-progNum' }, pct + '%')),
        h('div', { className: 'abw-prog' }, h('i', { style: { width: pct + '%' } })),
        h('div', { className: 'abw-progMeta' },
          h('span', null, pct > 0 ? Math.round(pct * 32) + ' / 3200 KB' : '—'),
          h('span', null, f.status || '离线'))
      )

      // ---- 第三行：动作 ----
      // 按钮文案直接反映阶段：busy 时显示「启动 Downloader…」「等待握手…」
      const btnConnect = h('button', {
        key: 'connect', className: 'abw-btn', 'data-v': 'pri', disabled: busy,
        onClick: async () => {
          /* Do NOT auto-kill a manually opened Downloader here. Merely clicking
             "连接" is not permission to terminate the user's tool. The host
             returns already-running; tell the user to close it or burn there. */
          const r = await api.post('/flash/start', {})
          if (r.ok) return
          if (r.error === 'already-running') {
            setNotice('检测到你手动打开的 Downloader；工作台不会结束它。请先关闭工具，或直接在工具里烧录。')
            return
          }
          setNotice('连接 Downloader 失败：' + (r.message || r.error || '未知错误'))
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
        key: 'burn', className: 'abw-btn', 'data-v': 'danger', disabled: !canCmd || !toolReady,
        title: !toolReady
          ? '先设置 Downloader.exe 的位置'
          : canCmd ? '把当前 dcf 写入芯片' : (burning ? '烧录中…' : '请先连接 Downloader'),
        onClick: async () => {
          // 无弹窗直接烧（危险动作靠“两步”防误触：
          // 需要先拿到 connected 才能点，而连接本身需要主动点）
          setNotice(f.online === true ? '正在开始烧录…' : '正在等待设备上线（最多 20 秒）…')
          const r = await api.post('/flash/download', { confirm: true })
          if (r.ok) { setNotice(''); return }
          if (r.error === 'no-device') {
            setNotice('没有检测到设备：请确认板子上电 / USB 插好，按一下复位，等 Downloader 扫描到设备后再点「开始烧录」')
            return
          }
          if (r.error === 'not-ready') {
            setNotice('设备还没准备好：等 Downloader 扫描完成再点「开始烧录」')
            return
          }
          setNotice('烧录请求失败：' + (r.message || r.error || ''))
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

      const toggleWatch = async () => {
        const r = await api.post('/watch', { on: !w.on })
        if (!r.ok) setNotice('自动烧录：' + (r.error || '开启失败'))
      }

      /* 只读操作：读信息是安全的，可以常驻可见。
         擦除走「上膛 + 3 秒确认」，避免误触把整片 flash 抹掉。 */
      const btnReadInfo = h('button', {
        key: 'readinfo', className: 'abw-btn', 'data-v': 'ghost', disabled: !canCmd,
        title: canCmd ? '读取芯片信息与校验码（只读，安全）' : '请先连接 Downloader',
        onClick: async () => {
          const r = await api.post('/flash/readinfo', {})
          if (!r.ok) setNotice('读信息失败：' + (r.error || '未知错误'))
        },
      }, '读信息')

      const btnErase = h('button', {
        key: 'erase', className: 'abw-btn', 'data-v': 'danger', disabled: !canCmd,
        title: !canCmd ? '请先连接 Downloader'
          : eraseArmed ? '再点一次确认全片擦除' : '全片擦除（危险：需要点两次）',
        onClick: async () => {
          if (eraseArmed !== true) {
            setEraseArmed(true)
            setTimeout(() => setEraseArmed(false), 3000)
            setNotice('再点一次「确认擦除」才会真正擦除全片')
            return
          }
          setEraseArmed(false)
          const r = await api.post('/flash/erase', { confirm: true })
          if (!r.ok) setNotice('擦除失败：' + (r.error || '未知错误'))
        },
      }, eraseArmed === true ? '确认擦除' : '擦除')

      const noSleepNow = noSleep.exists === true && noSleep.noSleep === true
      const noSleepValue = noSleep.value === null || noSleep.value === undefined ? '' : String(noSleep.value)
      const noSleepText = noSleep.exists !== true
        ? '不休眠（未生成）'
        : noSleepNow
          ? (noSleepChecked === true ? '不休眠' : '当前不休眠（未自动保持）')
          : (noSleepChecked === true ? '不休眠（烧录前修正）' : '当前会休眠（' + (noSleepValue === '' ? '?' : noSleepValue) + '）')
      const noSleepTitle = (noSleep.exists === true
        ? '当前 sys_sleep_time=' + (noSleepValue === '' ? '?' : noSleepValue) + (noSleepNow ? '（不休眠）' : '（会休眠）')
        : '还没有找到 watch.setting；编译生成后自动应用')
        + '\n' + (noSleep.path || '路径：由当前 app.dcf 同级 Settings/watch.setting 自动推导')
        + '\n勾选 = 写入 0 并在每次烧录前保持；取消勾选只停止保持，不改写文件。'
      const btnNoSleep = h('label', {
        className: 'abw-dim',
        style: { display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, cursor: noSleep.loading === true ? 'default' : 'pointer' },
        title: noSleepTitle,
      },
        h('input', {
          type: 'checkbox',
          checked: noSleepChecked === true,
          disabled: noSleep.loading === true,
          onChange: toggleNoSleep,
        }),
        noSleepText)

      const burnBusy = burnCfg.loading === true
      const burnOption = (key, label) => h('label', { className: 'abw-menuItem' },
        h('input', {
          type: 'checkbox',
          checked: burnCfg[key] === true,
          disabled: burnBusy || burnCfg.exists === false,
          onChange: (event) => { void saveBurnOption({ [key]: event.target.checked }) },
        }),
        label)
      const speedOption = (value, label) => h('label', { className: 'abw-menuItem' },
        h('input', {
          type: 'radio',
          name: 'abw-speed',
          checked: burnCfg.speed === value,
          disabled: burnBusy || burnCfg.exists === false,
          onChange: () => { void saveBurnOption({ speed: value }) },
        }),
        label)
      const burnMenu = burnMenuOpen === true
        ? h('div', { className: 'abw-menu', role: 'menu' },
          h('div', { className: 'abw-menuTitle' }, '烧录配置'),
          burnOption('preTest', '前测'),
          burnOption('erase', '擦除'),
          burnOption('down', '下载'),
          burnOption('extend', '扩展'),
          h('div', { className: 'abw-menuSep' }),
          h('label', { className: 'abw-menuItem' },
            h('input', {
              type: 'checkbox',
              checked: w.on === true,
              onChange: () => { void toggleWatch() },
            }),
            '自动烧录（编译完自动烧）'),
          h('div', { className: 'abw-menuSep' }),
          h('div', { className: 'abw-menuTitle' }, '速度'),
          speedOption('HighSpeed', '高速模式'),
          speedOption('NormalSpeed', '标速模式'),
          speedOption('LowSpeed', '低速模式'),
          h('div', { className: 'abw-menuHint' },
            burnBusy ? '读取中…'
              : burnCfg.exists === false ? '未找到 Downloader.config'
                : '保存后下次启动 Downloader 生效'))
        : null
      const burnGroup = h('span', { className: 'abw-burnSplit', ref: burnMenuRef },
        btnBurn,
        h('button', {
          type: 'button',
          className: 'abw-btn abw-caret',
          'data-v': 'ghost',
          title: '烧录配置（前测 / 擦除 / 下载 / 扩展 / 速度）' + (burnCfg.path ? '\n' + burnCfg.path : ''),
          onClick: () => {
            setBurnMenuOpen((open) => !open)
            if (burnMenuOpen !== true) void loadBurnCfg()
          },
        }, '▾'),
        burnMenu)
      const rowActions = h('div', { className: 'abw-line', key: 'actions', style: { marginBottom: 6 } },
      btnConnect, burnGroup, btnReadInfo, btnSerial, btnStop, btnNoSleep,
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

      const offlineHint = canCmd && f.online !== true
        ? h('div', { className: 'abw-deviceWarn' },
          '未检测到设备：请确认板子已上电/按复位；Downloader 扫描到设备后才能真正开始烧录。')
        : null

      const top = h('div', { className: 'abw-top' },
        noticeBar, rowToolDevice, rowInfo, rowProg, offlineHint, rowActions)

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
      placeholder: 'D:\\Tools\\Downloader\\Downloader.exe',
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

      return h('div', { className: 'abw' + (shellWide ? ' is-wide' : '') + (shellCompact ? ' is-compact' : '') },
        h('div', { className: 'abw-main' },
          h('div', { className: 'abw-left', style: shellWide ? { width: leftWidth + 'px' } : undefined }, top),
          shellWide
            ? h('div', {
              className: 'abw-splitter',
              role: 'separator',
              'aria-orientation': 'vertical',
              'aria-label': '拖动调整设置/日志宽度',
              title: '拖动调整设置与日志的宽度（双击恢复默认）',
              onPointerDown: onSplitterDown,
              onDoubleClick: () => {
                const next = defaultLeftWidth(props !== null && props !== undefined ? props.tier : undefined)
                setLeftWidth(next)
                storeLeftWidth(next)
              },
            })
            : null,
          h('div', { className: 'abw-right' }, bottom)),
        toolModal)
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
          /* rail 只有 60px，长标题会截成「Downloa…」；短名只用于 rail。 */
          short: '烧录',
          order: 30,
          icon: function (size) { return h(VsIcon, { size: size === undefined ? 16 : size }) },
          component: function (pageProps) {
            return h(FlashPanel, {
              tier: pageProps === undefined || pageProps === null ? undefined : pageProps.tier,
              layout: pageProps === undefined || pageProps === null ? undefined : pageProps.layout,
            })
          },
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
      __test: { appendLogs, virtualRange, searchParts, mergeLogs, formatBytes, defaultLeftWidth, clampLeftWidth, LEFT_WIDTH_KEY },
    }
  },
})






