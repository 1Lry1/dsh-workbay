/**
 * dsh-workbench-memmap — client half (plain JavaScript, no build step).
 *
 * ONE file, loaded through `window.__ModuleLoader__.load({ id, factory })`.
 * Registers ONE workbench page (`id: 'memmap'`, order 25).
 *
 * ── What this page is ─────────────────────────────────────────────────────
 *
 * A one-click memory report for firmware SDKs that ship
 * `tools/memmap_report/memmap_report.py`:
 *
 *   detect   workspace → tool + newest `Output/bin/map.txt` + python status
 *   run      → storage totals, per-region usage, delta vs the previous run
 *   report   → the generated single-file HTML report, embedded in a blob iframe
 *
 * Nothing is written into the user's repository: the host stores each run under
 * `~/.dsh/workbench/memmap/roots/<hash>/runs/<runId>/`.
 *
 * ── Sizing ────────────────────────────────────────────────────────────────
 *
 * T1/T2 (panel < 980 px): one column, cards stacked, tables full width.
 * T3/T4 (>= 980 px): summary column + side column (delta / history / variables).
 * The shell's `tier`/`layout` props are used when present; otherwise the page
 * measures itself, which is what the standalone panel does.
 */
window.__ModuleLoader__.load({
  id: 'dsh-workbench-memmap',
  factory: (require) => {
    const React = require('react')
    const E = React.createElement
    const { useState, useEffect, useMemo, useCallback, useRef } = React

    const PAGE_ID = 'memmap'
    const PREFIX = '/dsh-workbench-memmap/api/'
    const LOCALE_NS = 'dsh-workbench-memmap'
    const ROOT_KEY = 'dsh-workbench-memmap.root.v1'
    /* Last map that produced a report: a project without its own Output/bin keeps
       working after one manual pick. */
    const MAP_KEY = 'dsh-workbench-memmap.map.v1'
    const FILES_ROOT_KEY = 'dsh-workbay.root.v1'
    const SC_ROOT_KEY = 'dsh-workbay.sc.root.v1'
    const WIDE_MIN_WIDTH = 980

    /* ============================== locale ============================== */

    const ZH = {
      'page.title': '内存分析',
      'page.short': '内存',
      'head.detecting': '正在检测工作区…',
      'head.run': '重新分析',
      'head.report': '完整报告',
      'head.project': '工程',
      'head.python': 'Python {version}',
      'head.pythonMissing': 'Python 不可用',
      'head.map': 'map.txt',
      'head.manual': 'manual',
      'head.manual': '手动',
      'head.ranAt': '上次 {time} · {duration}',
      'head.openReport': '打开完整报告',
      'head.pickMap': '选择 map',
      'head.pickerHint': '选择要分析的 map',
      'head.pickMapHint': '点击选择其他 map.txt（工作区 / 附近 / 最近 / 手动路径）',
      'picker.title': '选择要分析的 map',
      'picker.close': '关闭',
      'picker.run': '分析这个 map',
      'picker.empty': '没有可选的 map，请粘贴一个绝对路径',
      'picker.current': '当前',
      'picker.manual': '手动',
      'picker.nearby': '附近',
      'picker.deep': '深搜',
      'picker.recent': '最近',
      'head.bundledTool': '内置工具',
      'head.bundledToolHint': '工作区没有自己的 memmap_report.py，正在使用工作台自带的脚本',
      'head.workspaceTool': 'SDK 工具',
      'head.workspaceToolHint': '使用工作区里的 tools/memmap_report/memmap_report.py',
      'empty.mapManual': '或者直接指定 map.txt 的绝对路径（例如别的目录里的构建产物）',
      'empty.mapPath': 'D:\\\\路径\\\\Output\\\\bin\\\\map.txt',
      'empty.mapRun': '分析这个 map',
      'empty.nearby': '附近发现的 map（点击分析）',
      'empty.root.title': '没有工作区',
      'empty.root.hint': '先在工作台里打开一个会话或选择工作区，再回到这里。',
      'empty.tool.title': '这个工作区没有内存分析工具',
      'empty.tool.hint': '没有找到 tools/memmap_report/memmap_report.py。把 memmap_report 工具放进 SDK 的 tools 目录后点「重新分析」。',
      'empty.map.title': '没有构建产物',
      'empty.map.hint': '没有找到 Output/bin/map.txt。先构建一次固件，再点「重新分析」。',
      'empty.paths': '已查找的路径',
      'empty.retry': '重新检测',
      'run.running': '正在分析…',
      'run.failed': '分析失败',
      'run.retry': '重试',
      'run.noPython': '找不到可用的 Python，无法运行分析。安装 Python 3 并确保它在 PATH 里。',
      'run.hostMissing': '内存分析服务还没加载：请完全退出 DSH 再重新打开（刷新窗口不够），然后回到这里。',
      'card.internal': '内部 RAM',
      'card.psram': 'PSRAM',
      'card.flash': 'Flash',
      'card.usedOf': '已用 {used} / {total}',
      'card.free': '空闲 {free}',
      'card.appBin': 'app.bin {size}',
      'card.copy': '含 RAM 段初值副本',
      'section.regions': '内存区域',
      'section.delta': '与上次运行相比',
      'section.history': '最近运行',
      'section.variables': '最大的变量/缓冲',
      'section.objects': 'RAM 消耗 Top 目标文件',
      'section.warnings': '解析提示',
      'table.region': '区域',
      'table.total': '容量',
      'table.used': '已用',
      'table.free': '空闲',
      'table.pct': '占用',
      'table.symbol': '变量',
      'table.size': '大小',
      'table.object': '所属 .o',
      'table.module': '模块',
      'table.value': '大小',
      'badge.overlay': '复用 {count}',
      'badge.alias': '地址别名',
      'delta.none': '没有可对比的上一次运行',
      'delta.same': '与上次运行一致',
      'delta.grew': '增加',
      'delta.shrank': '减少',
      'delta.added': '新增',
      'delta.regions': '区域',
      'delta.symbols': '变量',
      'delta.objects': '目标文件',
      'history.empty': '还没有运行记录',
      'history.current': '当前',
      'history.view': '查看',
      'history.restore': '回到这次',
      'report.title': '内存分布分析报告',
      'report.close': '关闭报告',
      'report.loading': '正在载入报告…',
      'report.failed': '报告载入失败: {message}',
      'status.idle': '等待检测',
      'status.ready': '内部 RAM {ram} · PSRAM {psram} · Flash {flash}',
      'status.running': '正在分析…',
      'status.failed': '失败',
      'unit.byte': 'B',
      'unit.kb': 'KB',
      'unit.mb': 'MB',
      'unit.gb': 'GB',
    }

    const EN = {
      'page.title': 'Memory map',
      'page.short': 'Memory',
      'head.detecting': 'Checking the workspace…',
      'head.run': 'Analyze again',
      'head.report': 'Full report',
      'head.project': 'Project',
      'head.python': 'Python {version}',
      'head.pythonMissing': 'Python unavailable',
      'head.map': 'map.txt',
      'head.manual': 'manual',
      'head.manual': '手动',
      'head.ranAt': 'Last {time} · {duration}',
      'head.openReport': 'Open full report',
      'head.pickMap': 'Pick a map',
      'head.pickerHint': 'Choose the map to analyze',
      'head.pickMapHint': 'Click to choose another map.txt (workspace / nearby / recent / manual path)',
      'picker.title': 'Choose a map to analyze',
      'picker.close': 'Close',
      'picker.run': 'Analyze this map',
      'picker.empty': 'No map candidates — paste an absolute path',
      'picker.current': 'current',
      'picker.manual': 'manual',
      'picker.nearby': 'nearby',
      'picker.deep': 'deep scan',
      'picker.recent': 'recent',
      'head.bundledTool': 'Built-in tool',
      'head.bundledToolHint': 'This workspace has no memmap_report.py; the workbench ships its own copy',
      'head.workspaceTool': 'SDK tool',
      'head.workspaceToolHint': 'Using tools/memmap_report/memmap_report.py from the workspace',
      'empty.mapManual': 'Or point at any map.txt by absolute path (for a build produced elsewhere)',
      'empty.mapPath': 'D:\\\\path\\\\Output\\\\bin\\\\map.txt',
      'empty.mapRun': 'Analyze this map',
      'empty.nearby': 'Maps found nearby (click to analyze)',
      'empty.root.title': 'No workspace',
      'empty.root.hint': 'Open a session or pick a workspace, then come back here.',
      'empty.tool.title': 'This workspace has no memory tool',
      'empty.tool.hint': 'tools/memmap_report/memmap_report.py was not found. Add the memmap_report tool to the SDK tools directory, then press Analyze again.',
      'empty.map.title': 'No build output',
      'empty.map.hint': 'Output/bin/map.txt was not found. Build the firmware once, then press Analyze again.',
      'empty.paths': 'Paths searched',
      'empty.retry': 'Detect again',
      'run.running': 'Analyzing…',
      'run.failed': 'Analysis failed',
      'run.retry': 'Retry',
      'run.noPython': 'No usable Python was found, so the analysis cannot run. Install Python 3 and make sure it is on PATH.',
      'run.hostMissing': 'The memory-analysis service is not loaded. Quit DSH completely and start it again (reloading the window is not enough), then come back here.',
      'card.internal': 'Internal RAM',
      'card.psram': 'PSRAM',
      'card.flash': 'Flash',
      'card.usedOf': 'Used {used} / {total}',
      'card.free': 'Free {free}',
      'card.appBin': 'app.bin {size}',
      'card.copy': 'includes RAM initial-value copies',
      'section.regions': 'Memory regions',
      'section.delta': 'Compared with the previous run',
      'section.history': 'Recent runs',
      'section.variables': 'Largest variables / buffers',
      'section.objects': 'Top object files by RAM',
      'section.warnings': 'Parser notes',
      'table.region': 'Region',
      'table.total': 'Size',
      'table.used': 'Used',
      'table.free': 'Free',
      'table.pct': 'Fill',
      'table.symbol': 'Symbol',
      'table.size': 'Size',
      'table.object': 'Object',
      'table.module': 'Module',
      'table.value': 'Size',
      'badge.overlay': 'overlay {count}',
      'badge.alias': 'alias',
      'delta.none': 'No earlier run to compare against',
      'delta.same': 'No change since the previous run',
      'delta.grew': 'grew',
      'delta.shrank': 'shrank',
      'delta.added': 'new',
      'delta.regions': 'Regions',
      'delta.symbols': 'Variables',
      'delta.objects': 'Objects',
      'history.empty': 'No runs yet',
      'history.current': 'current',
      'history.view': 'view',
      'history.restore': 'Back to this one',
      'report.title': 'Memory distribution report',
      'report.close': 'Close report',
      'report.loading': 'Loading report…',
      'report.failed': 'Could not load the report: {message}',
      'status.idle': 'waiting for a check',
      'status.ready': 'internal RAM {ram} · PSRAM {psram} · Flash {flash}',
      'status.running': 'analyzing…',
      'status.failed': 'failed',
      'unit.byte': 'B',
      'unit.kb': 'KB',
      'unit.mb': 'MB',
      'unit.gb': 'GB',
    }

    const LOCALES = { zh: ZH }

    function hasOwnKey(target, key) {
      return Object.prototype.hasOwnProperty.call(target, key)
    }

    function activeLocaleOf(ctx) {
      let active = ''
      try {
        const locale = ctx === undefined || ctx === null ? undefined : ctx.get('locale')
        if (locale !== undefined && locale !== null && typeof locale.getSnapshot === 'function') {
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
      const primary = tag.split('-')[0]
      if (primary === 'zh') return ZH
      if (hasOwnKey(LOCALES, primary)) return LOCALES[primary]
      return EN
    }

    function fill(template, values) {
      if (values === undefined || values === null || typeof template !== 'string') return template
      return template.replace(/\{(\w+)\}/g, (match, key) => (hasOwnKey(values, key) ? String(values[key]) : match))
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

    /* ============================== formatting ============================== */

    const UNITS = ['unit.byte', 'unit.kb', 'unit.mb', 'unit.gb']

    function formatBytes(t, value) {
      const number = Number(value)
      if (Number.isFinite(number) !== true || number < 0) return '—'
      if (number < 1024) return Math.round(number) + ' ' + t(UNITS[0])
      let size = number
      let unit = 0
      while (size >= 1024 && unit < UNITS.length - 1) {
        size /= 1024
        unit += 1
      }
      const digits = size >= 100 ? 0 : (size >= 10 ? 1 : (unit === 1 ? 1 : 2))
      return size.toFixed(digits) + ' ' + t(UNITS[unit])
    }

    function formatPct(value) {
      const number = Number(value)
      if (Number.isFinite(number) !== true) return '—'
      return (number >= 10 ? number.toFixed(0) : number.toFixed(1)) + '%'
    }

    function formatDuration(ms) {
      const number = Number(ms)
      if (Number.isFinite(number) !== true || number < 0) return '—'
      if (number < 1000) return Math.round(number) + ' ms'
      return (number / 1000).toFixed(1) + ' s'
    }

    function formatTime(value) {
      if (typeof value !== 'string' || value === '') return '—'
      const date = new Date(value)
      if (Number.isNaN(date.getTime()) === true) return value
      const pad = (part) => String(part).padStart(2, '0')
      return (date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
    }

    function toneOf(pct) {
      const number = Number(pct)
      if (Number.isFinite(number) !== true) return 'is-ok'
      if (number >= 90) return 'is-danger'
      if (number >= 75) return 'is-warn'
      return 'is-ok'
    }

    /* Which of the three "storage" cards a totals object produces. */
    function storageCardsOf(totals) {
      const source = totals === null || totals === undefined ? {} : totals
      const card = (key, nameKey, used, capacity) => {
        const total = Number(capacity) || 0
        const value = Number(used) || 0
        return {
          key,
          nameKey,
          used: value,
          total,
          free: Math.max(0, total - value),
          pct: total > 0 ? (value / total) * 100 : 0,
        }
      }
      return [
        card('internal', 'card.internal', source.internalRam, source.ramCapacity),
        card('psram', 'card.psram', source.psram, source.psramCapacity),
        card('flash', 'card.flash', source.flash, source.flashCapacity),
      ]
    }

    /* Category segments for a region's composition bar, biggest first. */
    function categorySegmentsOf(region) {
      if (region === null || region === undefined || typeof region !== 'object') return []
      const cats = region.cats !== null && typeof region.cats === 'object' ? region.cats : {}
      const used = Number(region.used) || 0
      const total = used > 0 ? used : 0
      const segments = []
      for (const key of Object.keys(cats)) {
        const size = Number(cats[key])
        if (Number.isFinite(size) !== true || size <= 0) continue
        segments.push({ key, size, pct: total > 0 ? (size / total) * 100 : 0 })
      }
      segments.sort((left, right) => right.size - left.size)
      return segments
    }

    /* The page only shows a delta group when it has rows. */
    function deltaGroupsOf(delta) {
      if (delta === null || delta === undefined) return []
      return [
        { key: 'regions', rows: Array.isArray(delta.regions) ? delta.regions : [] },
        { key: 'symbols', rows: Array.isArray(delta.symbols) ? delta.symbols : [] },
        { key: 'objects', rows: Array.isArray(delta.objects) ? delta.objects : [] },
      ].filter((group) => group.rows.length > 0)
    }

    function deltaToneOf(value) {
      const number = Number(value)
      if (Number.isFinite(number) !== true || number === 0) return 'is-flat'
      return number > 0 ? 'is-up' : 'is-down'
    }

    /**
     * Everything the picker can offer, deduped by path:
     *   workspace maps → suggestions (nearby/deep) → recent runs → manual.
     * Single source of truth so the list and its flags are unit-testable.
     */
    function mapChoicesOf(detect, history, currentPath) {
      const out = []
      const seen = new Set()
      const add = (entry, flags) => {
        if (entry === null || entry === undefined) return
        const mapFilePath = typeof entry.path === 'string'
          ? entry.path
          : (typeof entry.mapPath === 'string' ? entry.mapPath : '')
        if (mapFilePath === '' || seen.has(mapFilePath)) return
        seen.add(mapFilePath)
        out.push(Object.assign({
          path: mapFilePath,
          project: typeof entry.project === 'string' ? entry.project : '',
          size: typeof entry.size === 'number' ? entry.size : 0,
          mtimeMs: typeof entry.mtimeMs === 'number' ? entry.mtimeMs : 0,
          manual: entry.manual === true,
          nearby: entry.nearby === true,
          deep: entry.deep === true,
          recent: false,
          current: false,
        }, flags))
      }
      const maps = detect !== null && detect !== undefined && Array.isArray(detect.maps) ? detect.maps : []
      for (const entry of maps) add(entry, {})
      const suggestions = detect !== null && detect !== undefined && Array.isArray(detect.nearbyMaps) ? detect.nearbyMaps : []
      for (const entry of suggestions) add(entry, {})
      const runs = Array.isArray(history) ? history : []
      for (const run of runs) {
        if (run === null || typeof run !== 'object') continue
        add({ path: run.mapPath, project: run.project, mtimeMs: run.mapMtimeMs }, { recent: true })
      }
      if (detect !== null && detect !== undefined && detect.manualMap !== null && detect.manualMap !== undefined) {
        add(detect.manualMap, { manual: true })
      }
      for (const entry of out) entry.current = currentPath !== '' && entry.path === currentPath
      return out
    }

    function shouldAutoRun(detect) {
      if (detect === null || detect === undefined || typeof detect !== 'object') return false
      if (detect.toolFound !== true) return false
      if (detect.newestMap === null || detect.newestMap === undefined) return false
      if (detect.python === null || detect.python === undefined || detect.python.ok !== true) return false
      return detect.mapIsNewerThanRun === true || (Array.isArray(detect.runs) && detect.runs.length === 0)
    }

    function rootOf(dock) {
      const context = dock !== undefined && dock !== null && typeof dock.getContext === 'function' ? dock.getContext() : null
      const fromContext = context !== null && typeof context === 'object' && typeof context.root === 'string' ? context.root : ''
      const candidates = [readStoredRoot(ROOT_KEY), fromContext, readStoredRoot(FILES_ROOT_KEY), readStoredRoot(SC_ROOT_KEY)]
      for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
      }
      return ''
    }

    /* The panel may be mounted where `localStorage` is not a bare global (tests,
       sandboxed documents), so always go through the window object we were given. */
    function storageOf() {
      try {
        if (typeof window === 'object' && window !== null && window.localStorage !== undefined && window.localStorage !== null) return window.localStorage
      } catch (error) { void error }
      try {
        if (typeof localStorage === 'object' && localStorage !== null) return localStorage
      } catch (error) { void error }
      return null
    }

    function readStoredRoot(key) {
      const storage = storageOf()
      if (storage === null || typeof storage.getItem !== 'function') return ''
      try {
        const value = storage.getItem(key)
        return typeof value === 'string' ? value : ''
      } catch (error) {
        void error
        return ''
      }
    }

    function storeRoot(value) {
      const storage = storageOf()
      if (storage === null || typeof storage.setItem !== 'function') return
      if (typeof value !== 'string' || value.trim() === '') return
      try {
        storage.setItem(ROOT_KEY, value.trim())
      } catch (error) { void error }
    }

    function codedError(code, message) {
      const thrown = new Error(message)
      thrown.code = code
      return thrown
    }

    /**
     * POST <prefix>/<method>.
     *
     * A host that has not loaded this bundle yet answers 404 with an EMPTY body,
     * and the browser then throws `Unexpected end of JSON input` from
     * `response.json()` — a message that tells the user nothing. Read the text
     * first and turn that case into an actionable error instead.
     */
    async function call(method, payload) {
      let response
      try {
        response = await fetch(PREFIX + method, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload === undefined ? {} : payload),
        })
      } catch (error) {
        throw codedError('network', error === null || error === undefined ? 'network error' : String(error.message))
      }
      let text = ''
      try {
        text = await response.text()
      } catch (error) {
        throw codedError('transport', error === null || error === undefined ? 'cannot read response' : String(error.message))
      }
      if (text === '') {
        throw codedError('host-unavailable', 'HTTP ' + response.status + ' ' + (response.statusText === undefined ? '' : response.statusText))
      }
      let body = null
      try {
        body = JSON.parse(text)
      } catch (error) {
        throw codedError('transport', 'unexpected response (HTTP ' + response.status + ')')
      }
      if (body === null || body.ok !== true) {
        const error = body !== null && body.error !== null && body.error !== undefined ? body.error : { code: 'unknown', message: 'request failed' }
        throw codedError(typeof error.code === 'string' ? error.code : 'unknown', typeof error.message === 'string' ? error.message : 'request failed')
      }
      return body.data
    }

    /* ============================== icons ============================== */

    function Icon(props) {
      const size = props === undefined || props.size === undefined ? 14 : props.size
      const className = 'mm-icon' + (props !== undefined && props.className !== undefined ? ' ' + props.className : '')
      const name = props === undefined ? '' : props.name
      const paths = {
        chip: 'M6 6h12v12H6zM9 1v4M15 1v4M9 19v4M15 19v4M1 9h4M1 15h4M19 9h4M19 15h4',
        refresh: 'M20 12a8 8 0 1 1-2.6-5.9M20 4v5h-5',
        report: 'M6 2h9l5 5v15H6zM15 2v5h5M9 13h8M9 17h5',
        warning: 'M12 3l9 16H3zM12 10v4M12 17h.01',
        check: 'M20 6L9 17l-5-5',
        close: 'M6 6l12 12M18 6L6 18',
        chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
      }
      return E('svg', { className, width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        (paths[name] === undefined ? paths.chart : paths[name]).split('M').filter((part) => part !== '').map((part, index) => E('path', { key: index, d: 'M' + part })))
    }

    /* ============================== page ============================== */

    function LocaleLive(props) {
      const { ctx } = props
      const [tick, setTick] = useState(0)
      useEffect(() => {
        const locale = ctx === undefined || ctx === null ? undefined : ctx.get('locale')
        if (locale === undefined || locale === null || typeof locale.subscribe !== 'function') return undefined
        const off = locale.subscribe(() => setTick((value) => value + 1))
        return () => { if (typeof off === 'function') off() }
      }, [ctx])
      void tick
      const t = useMemo(() => translatorOf(ctx), [ctx, tick])
      return E(Page, {
        t,
        dock: props.dock,
        tier: props.tier,
        layout: props.layout,
      })
    }

    function Page(props) {
      const { t, dock } = props
      const [rootPath, setRootPath] = useState(() => rootOf(dock))
      const [phase, setPhase] = useState('detecting')
      const [detect, setDetect] = useState(null)
      const [summary, setSummary] = useState(null)
      const [delta, setDelta] = useState(null)
      const [history, setHistory] = useState([])
      const [error, setError] = useState(null)
      const [running, setRunning] = useState(false)
      const [mapPath, setMapPath] = useState('')
      const [manualMap, setManualMap] = useState(() => readStoredRoot(MAP_KEY))
      const [pickerOpen, setPickerOpen] = useState(false)
      const [wide, setWide] = useState(false)
      const [report, setReport] = useState({ open: false, loading: false, url: '', runId: '', error: null })
      const rootRef = useRef(null)
      const manualMapRef = useRef(readStoredRoot(MAP_KEY))
      const autoRanRef = useRef('')

      /* Which layout: the shell's tier when hosted, a measurement otherwise. */
      useEffect(() => {
        if (props.tier === 't3' || props.tier === 't4') { setWide(true); return undefined }
        if (props.tier === 't1' || props.tier === 't2') { setWide(false); return undefined }
        const node = rootRef.current
        if (node === null || node === undefined || typeof node.getBoundingClientRect !== 'function') return undefined
        const measure = () => setWide(node.getBoundingClientRect().width >= WIDE_MIN_WIDTH)
        measure()
        if (typeof ResizeObserver !== 'function') return undefined
        const observer = new ResizeObserver(measure)
        observer.observe(node)
        return () => observer.disconnect()
      }, [props.tier])

      /* Workspace root changes (user switched session/workspace). */
      useEffect(() => {
        if (dock === undefined || dock === null || typeof dock.subscribeContext !== 'function') return undefined
        let previous = rootOf(dock)
        const off = dock.subscribeContext(() => {
          const next = rootOf(dock)
          if (next === previous) return
          previous = next
          autoRanRef.current = ''
          setRootPath(next)
          setSummary(null)
          setDelta(null)
          setHistory([])
          setError(null)
          setDetect(null)
          setPhase('detecting')
        })
        return () => { if (typeof off === 'function') off() }
      }, [dock])

      const detectWorkspace = useCallback(async () => {
        if (rootPath === '') { setPhase('no-root'); return }
        setPhase((current) => (current === 'ready' ? current : 'detecting'))
        try {
          const data = await call('detect', {
            root: rootPath,
            manualMap: manualMapRef.current.trim() === '' ? undefined : manualMapRef.current.trim(),
          })
          setDetect(data)
          if (data.toolFound === true) storeRoot(data.root)
          if (manualMapRef.current === '' && data.manualMap !== null && data.manualMap !== undefined) {
            manualMapRef.current = data.manualMap.path
            setManualMap(data.manualMap.path)
          }
          if (data.runs !== undefined && Array.isArray(data.runs)) setHistory(data.runs)
          if (data.latestSummary !== undefined && data.latestSummary !== null) setSummary(data.latestSummary)
          setError(null)
          setPhase('ready')
        } catch (thrown) {
          setDetect(null)
          setError({ message: thrown.message, code: thrown.code })
          setPhase('error')
        }
      }, [rootPath])

      const runAnalysis = useCallback(async (mode, mapOverride) => {
        if (detect === null || detect.toolFound !== true) return
        setRunning(true)
        setError(null)
        if (mode !== 'auto') setPhase('running')
        try {
          const selectedMap = mapOverride !== undefined && mapOverride !== null && String(mapOverride).trim() !== ''
            ? String(mapOverride).trim()
            : (mapPath !== '' ? mapPath : undefined)
          const data = await call('run', { root: detect.root, map: selectedMap })
          setSummary(data.summary)
          setDelta(data.delta)
          /* Remember WHICH map produced this report, whatever the caller picked. */
          if (data.summary !== null && data.summary !== undefined && typeof data.summary.mapPath === 'string' && data.summary.mapPath !== '') {
            manualMapRef.current = data.summary.mapPath
            setManualMap(data.summary.mapPath)
            try {
              const storage = storageOf()
              if (storage !== null && typeof storage.setItem === 'function') storage.setItem(MAP_KEY, data.summary.mapPath)
            } catch (error) { void error }
          }
          if (Array.isArray(data.history)) setHistory(data.history)
          setDetect((previous) => (previous === null ? previous : Object.assign({}, previous, {
            mapIsNewerThanRun: false,
            newestMap: previous.newestMap,
            runs: Array.isArray(data.history) ? data.history : previous.runs,
          })))
          setPhase('ready')
        } catch (thrown) {
          setError({ message: thrown.message, code: thrown.code })
          if (summary === null) setPhase('error')
        } finally {
          setRunning(false)
        }
      }, [detect, mapPath, summary])

      useEffect(() => { void detectWorkspace() }, [detectWorkspace])

      /* Auto-run once per (workspace, map): "有对应文件就分析" without a click. */
      useEffect(() => {
        if (phase !== 'ready' || detect === null) return
        if (shouldAutoRun(detect) !== true) return
        const token = detect.root + '|' + (detect.newestMap === null ? '' : detect.newestMap.mtimeMs)
        if (autoRanRef.current === token) return
        autoRanRef.current = token
        void runAnalysis('auto')
      }, [phase, detect, runAnalysis])

      /* Status line in the workbench status bar. */
      useEffect(() => {
        if (dock === undefined || dock === null || typeof dock.setStatus !== 'function') return
        if (summary !== null && summary.totals !== undefined) {
          const projectPrefix = typeof summary.project === 'string' && summary.project !== '' ? summary.project + ' · ' : ''
          dock.setStatus(PAGE_ID, projectPrefix + t('status.ready', {
            ram: formatPct(summary.totals.ramCapacity > 0 ? (summary.totals.internalRam / summary.totals.ramCapacity) * 100 : 0),
            psram: formatPct(summary.totals.psramCapacity > 0 ? (summary.totals.psram / summary.totals.psramCapacity) * 100 : 0),
            flash: formatPct(summary.totals.flashCapacity > 0 ? (summary.totals.flash / summary.totals.flashCapacity) * 100 : 0),
          }))
        } else if (running === true) dock.setStatus(PAGE_ID, t('status.running'))
        else if (phase === 'error') dock.setStatus(PAGE_ID, t('status.failed'))
        else dock.setStatus(PAGE_ID, t('status.idle'))
        return () => { if (typeof dock.setStatus === 'function') dock.setStatus(PAGE_ID, '') }
      }, [dock, summary, running, phase, t])

      /* Esc closes the embedded report first. */
      useEffect(() => {
        if (dock === undefined || dock === null || typeof dock.setBackHandler !== 'function') return undefined
        dock.setBackHandler(PAGE_ID, () => {
          if (report.open === true) { closeReport(); return true }
          if (pickerOpen === true) { setPickerOpen(false); return true }
          return false
        })
        return undefined
      }, [dock, report.open, pickerOpen])

      const closeReport = useCallback(() => {
        setReport((current) => {
          if (current.url !== '' && typeof URL === 'object' && typeof URL.revokeObjectURL === 'function') {
            try { URL.revokeObjectURL(current.url) } catch (error) { void error }
          }
          return { open: false, loading: false, url: '', runId: '', error: null }
        })
      }, [])

      const openReport = useCallback(async (runId) => {
        const target = runId === undefined || runId === null || runId === '' ? (summary === null ? '' : summary.runId) : runId
        if (target === '' || detect === null) return
        setReport({ open: true, loading: true, url: '', runId: target, error: null })
        try {
          const data = await call('report', { root: detect.root, runId: target })
          const blob = new Blob([data.html], { type: 'text/html;charset=utf-8' })
          const url = URL.createObjectURL(blob)
          setReport({ open: true, loading: false, url, runId: target, error: null })
        } catch (thrown) {
          setReport({ open: true, loading: false, url: '', runId: target, error: thrown.message })
        }
      }, [detect, summary])

      /* ============================== pieces ============================== */

      const projectName = summary !== null && typeof summary.project === 'string' && summary.project !== ''
        ? summary.project
        : (detect !== null && detect !== undefined && detect.newestMap !== null && detect.newestMap !== undefined && typeof detect.newestMap.project === 'string'
 ? detect.newestMap.project
 : '')
      const currentMapPath = summary !== null && typeof summary.mapPath === 'string' && summary.mapPath !== ''
        ? summary.mapPath
        : (detect !== null && detect !== undefined && detect.newestMap !== null && detect.newestMap !== undefined && typeof detect.newestMap.path === 'string'
 ? detect.newestMap.path
 : manualMap)
      const mapChoices = mapChoicesOf(detect, history, currentMapPath)

      const header = E('div', { className: 'mm-head' },
        E('div', { className: 'mm-headMain' },
          E(Icon, { name: 'chip', size: 14 }),
          E('span', { className: 'mm-title' }, t('page.title')),
          detect !== null && detect.toolFound === true
            ? E('span', { className: 'mm-chip is-ok' }, E(Icon, { name: 'check', size: 10 }), t('head.python', { version: detect.python.ok === true ? detect.python.version : '?' }))
            : null,
          detect !== null && detect.toolFound === true
            ? E('span', {
              className: 'mm-chip' + (detect.toolSource === 'bundled' ? ' is-brand' : ''),
              title: detect.toolSource === 'bundled' ? t('head.bundledToolHint') : t('head.workspaceToolHint'),
            }, t(detect.toolSource === 'bundled' ? 'head.bundledTool' : 'head.workspaceTool'))
            : null,
          projectName === ''
            ? null
            : E('span', { className: 'mm-chip is-proj', title: t('head.project') + ' · ' + projectName }, t('head.project') + ' ' + projectName),
          E('button', {
            type: 'button',
            className: 'mm-mapBtn' + (pickerOpen === true ? ' is-open' : ''),
            title: (currentMapPath === '' ? t('head.pickMapHint') : currentMapPath + '\n' + t('head.pickMapHint')),
            'aria-haspopup': 'listbox',
            'aria-expanded': pickerOpen === true,
            onClick: () => setPickerOpen((value) => value !== true),
          },
          E(Icon, { name: 'report', size: 11 }),
          E('span', { className: 'mm-mapName' }, currentMapPath === '' ? t('head.pickMap') : currentMapPath.replace(/^.*[\\/]/, '')),
          E('span', { className: 'mm-caret' }, '▾'))),
        E('div', { className: 'mm-headActions' },
          summary !== null
            ? E('span', { className: 'mm-ranAt' }, t('head.ranAt', { time: formatTime(summary.generatedAt), duration: formatDuration(summary.durationMs) }))
            : null,
          E('button', {
            type: 'button',
            className: 'mm-btn',
            disabled: running === true || detect === null || detect.toolFound !== true,
            title: t('head.run'),
            onClick: () => { void runAnalysis('manual') },
          }, E(Icon, { name: 'refresh', size: 12 }), running === true ? t('run.running') : t('head.run')),
          summary !== null
            ? E('button', { type: 'button', className: 'mm-btn is-primary', title: t('head.openReport'), onClick: () => { void openReport() } },
              E(Icon, { name: 'report', size: 12 }), t('head.report'))
            : null))

      let body
      if (phase === 'no-root' || rootPath === '') {
        body = E('div', { className: 'mm-empty' },
          E('div', { className: 'mm-emptyTitle' }, t('empty.root.title')),
          E('div', { className: 'mm-emptyHint' }, t('empty.root.hint')))
      } else if (phase === 'detecting' && summary === null) {
        body = E('div', { className: 'mm-empty' }, E('div', { className: 'mm-emptyHint' }, t('head.detecting')))
      } else if (detect !== null && detect.toolFound !== true) {
        body = E('div', { className: 'mm-empty' },
          E('div', { className: 'mm-emptyTitle' }, t('empty.tool.title')),
          E('div', { className: 'mm-emptyHint' }, t('empty.tool.hint')),
          E('div', { className: 'mm-emptyPaths' }, t('empty.paths'), ' ', detect && detect.searched ? detect.searched.join('  ·  ') : ''),
          E('button', { type: 'button', className: 'mm-btn', onClick: () => { void detectWorkspace() } }, t('empty.retry')))
      } else if (detect !== null && detect.toolFound === true && detect.maps.length === 0 && summary === null && running !== true) {
        body = E('div', { className: 'mm-empty' },
          E('div', { className: 'mm-emptyTitle' }, t('empty.map.title')),
          E('div', { className: 'mm-emptyHint' }, t('empty.map.hint')),
          E('div', { className: 'mm-emptyHint' }, t('empty.mapManual')),
          E('div', { className: 'mm-inlineRow' },
            E('input', {
              className: 'mm-input',
              type: 'text',
              spellCheck: false,
              placeholder: t('empty.mapPath'),
              value: manualMap,
              onChange: (event) => setManualMap(event.target.value),
              onKeyDown: (event) => {
                if (event.key !== 'Enter' || manualMap.trim() === '') return
                event.preventDefault()
                void runAnalysis('manual', manualMap)
              },
            }),
            E('button', {
              type: 'button',
              className: 'mm-btn is-primary',
              disabled: running === true || manualMap.trim() === '',
              onClick: () => { void runAnalysis('manual', manualMap) },
            }, t('empty.mapRun'))),
          detect.nearbyMaps !== undefined && Array.isArray(detect.nearbyMaps) && detect.nearbyMaps.length > 0
            ? E('div', { className: 'mm-suggest' },
              E('div', { className: 'mm-suggestHead' }, t('empty.nearby')),
              detect.nearbyMaps.map((entry) => E('button', {
                key: entry.path,
                type: 'button',
                className: 'mm-suggestRow',
                title: entry.path,
                onClick: () => { void runAnalysis('manual', entry.path) },
              },
              E('span', { className: 'mm-suggestProject' }, entry.project),
              E('span', { className: 'mm-suggestPath' }, entry.path),
              E('span', { className: 'mm-suggestSize' }, formatBytes(t, entry.size)))))
            : null,
          E('div', { className: 'mm-emptyActions' },
            E('button', { type: 'button', className: 'mm-btn', onClick: () => { void detectWorkspace() } }, t('empty.retry'))))
      } else if (phase === 'error' && summary === null) {
        body = E('div', { className: 'mm-empty' },
          E('div', { className: 'mm-emptyTitle' }, t('run.failed')),
          E('div', { className: 'mm-emptyHint' }, error === null ? '' : error.message),
          error !== null && error.code === 'host-unavailable' ? E('div', { className: 'mm-emptyHint' }, t('run.hostMissing')) : null,
          E('div', { className: 'mm-emptyActions' },
            E('button', { type: 'button', className: 'mm-btn', onClick: () => { void detectWorkspace() } }, t('empty.retry')),
            E('button', { type: 'button', className: 'mm-btn is-primary', onClick: () => { void runAnalysis('manual') } }, t('run.retry'))))
      } else if (summary === null) {
        body = E('div', { className: 'mm-empty' }, E('div', { className: 'mm-emptyHint' }, running === true ? t('run.running') : t('head.detecting')))
      } else {
        body = renderBody()
      }

      function renderBody() {
        const cards = storageCardsOf(summary.totals)
        const groups = deltaGroupsOf(delta)

        const cardNodes = cards.map((card) => E('div', { key: card.key, className: 'mm-card ' + toneOf(card.pct) },
          E('div', { className: 'mm-cardHead' },
            E('span', { className: 'mm-cardName' }, t(card.nameKey)),
            E('span', { className: 'mm-cardPct' }, formatPct(card.pct))),
          E('div', { className: 'mm-bar' }, E('span', { className: 'mm-barFill', style: { width: Math.max(1, Math.min(100, card.pct)).toFixed(1) + '%' } })),
          E('div', { className: 'mm-cardUsed' }, t('card.usedOf', { used: formatBytes(t, card.used), total: formatBytes(t, card.total) })),
          E('div', { className: 'mm-cardFree' }, t('card.free', { free: formatBytes(t, card.free) })),
          card.key === 'flash' && summary.appBin !== null
            ? E('div', { className: 'mm-cardFree' }, t('card.appBin', { size: formatBytes(t, summary.appBin) }))
            : null))

        const regionRows = summary.regions.map((region) => {
          const segments = categorySegmentsOf(region)
          const empty = segments.length === 0
          return E('div', { key: region.name, className: 'mm-tr' + (empty ? ' is-empty' : '') },
            E('span', { className: 'mm-td is-name', title: region.desc },
              E('span', { className: 'mm-regionName' }, region.name),
              region.overlays > 0 ? E('span', { className: 'mm-tag' }, t('badge.overlay', { count: region.overlays })) : null,
              Array.isArray(region.alias) && region.alias.length > 0 ? E('span', { className: 'mm-tag is-alias' }, t('badge.alias')) : null),
            E('span', { className: 'mm-td is-num' }, formatBytes(t, region.length)),
            E('span', { className: 'mm-td is-num' }, empty ? '—' : formatBytes(t, region.used)),
            E('span', { className: 'mm-td is-num' }, empty ? '—' : formatBytes(t, region.free)),
            E('span', { className: 'mm-td is-pct' },
              E('span', { className: 'mm-miniBar ' + toneOf(region.pct) },
                segments.map((segment) => E('span', {
                  key: segment.key,
                  className: 'mm-miniSeg is-' + segment.key,
                  style: { width: segment.pct.toFixed(1) + '%' },
                  title: segment.key + ' · ' + formatBytes(t, segment.size),
                })),
                E('span', { className: 'mm-miniTrack', style: { width: Math.max(0, 100 - segments.reduce((sum, segment) => sum + segment.pct, 0)).toFixed(1) + '%' } })),
              E('span', { className: 'mm-pctText' }, empty ? '' : formatPct(region.pct))))
        })

        const deltaBody = delta === null
          ? E('div', { className: 'mm-muted' }, t('delta.none'))
          : (groups.length === 0
            ? E('div', { className: 'mm-muted' }, t('delta.same'))
            : E('div', { className: 'mm-delta' },
              groups.map((group) => E('div', { key: group.key, className: 'mm-deltaGroup' },
                E('div', { className: 'mm-deltaTitle' }, t('delta.' + group.key)),
                group.rows.slice(0, 8).map((row) => E('div', { key: group.key + ':' + row.name, className: 'mm-deltaRow' },
                  E('span', { className: 'mm-deltaName', title: row.name }, row.name),
                  E('span', { className: 'mm-deltaValue ' + deltaToneOf(row.delta) },
                    (row.delta > 0 ? '+' : '') + formatBytes(t, Math.abs(row.delta)) + (row.added === true ? ' · ' + t('delta.added') : ''))))))))

        const historyBody = history.length === 0
          ? E('div', { className: 'mm-muted' }, t('history.empty'))
          : E('div', { className: 'mm-history' },
            history.slice(0, 8).map((entry) => E('button', {
              key: entry.runId,
              type: 'button',
              className: 'mm-historyRow' + (summary !== null && summary.runId === entry.runId ? ' is-current' : ''),
              title: entry.mapPath,
              onClick: () => { void openReport(entry.runId) },
            },
            E('span', { className: 'mm-historyTime' }, formatTime(entry.generatedAt)),
            E('span', { className: 'mm-historyProject' }, entry.project === '' ? '—' : entry.project),
            E('span', { className: 'mm-historyRam' }, entry.totals === null || entry.totals === undefined ? '—' : formatBytes(t, entry.totals.internalRam)),
            summary !== null && summary.runId === entry.runId ? E('span', { className: 'mm-tag is-current' }, t('history.current')) : null)))

        const symbolRows = summary.symbols.map((symbol) => E('div', { key: symbol.name + ':' + symbol.addr, className: 'mm-tr' },
          E('span', { className: 'mm-td is-name', title: symbol.name }, symbol.name),
          E('span', { className: 'mm-td is-num' }, formatBytes(t, symbol.size)),
          E('span', { className: 'mm-td is-tag' }, symbol.cat)))
        const objectRows = summary.objects.map((object) => E('div', { key: object.path === '' ? object.name : object.path, className: 'mm-tr' },
          E('span', { className: 'mm-td is-name', title: object.path }, object.name),
          E('span', { className: 'mm-td is-num' }, formatBytes(t, object.size)),
          E('span', { className: 'mm-td is-tag' }, object.module)))

        return E('div', { className: 'mm-body' + (wide === true ? ' is-wide' : '') },
          E('div', { className: 'mm-colMain' },
            error !== null
              ? E('div', { className: 'mm-error' }, E(Icon, { name: 'warning', size: 12 }), error.message)
              : null,
            running === true
              ? E('div', { className: 'mm-running' }, E('span', { className: 'mm-spinner' }), t('run.running'))
              : null,
            E('div', { className: 'mm-cards' }, cardNodes),
            summary.warnings !== undefined && summary.warnings.length > 0
              ? E('div', { className: 'mm-warnings' }, summary.warnings.map((warning, index) => E('div', { key: index, className: 'mm-warning' }, E(Icon, { name: 'warning', size: 11 }), warning)))
              : null,
            E('div', { className: 'mm-section' },
              E('div', { className: 'mm-sectionHead' }, E(Icon, { name: 'chart', size: 12 }), t('section.regions')),
              E('div', { className: 'mm-table' },
                E('div', { className: 'mm-tr is-head' },
                  E('span', { className: 'mm-td is-name' }, t('table.region')),
                  E('span', { className: 'mm-td is-num' }, t('table.total')),
                  E('span', { className: 'mm-td is-num' }, t('table.used')),
                  E('span', { className: 'mm-td is-num' }, t('table.free')),
                  E('span', { className: 'mm-td is-pct' }, t('table.pct'))),
                regionRows))),
          E('div', { className: 'mm-colSide' },
            E('div', { className: 'mm-section' },
              E('div', { className: 'mm-sectionHead' }, E(Icon, { name: 'chart', size: 12 }), t('section.delta')),
              deltaBody),
            E('div', { className: 'mm-section' },
              E('div', { className: 'mm-sectionHead' }, E(Icon, { name: 'report', size: 12 }), t('section.history')),
              historyBody),
            E('div', { className: 'mm-section' },
              E('div', { className: 'mm-sectionHead' }, E(Icon, { name: 'chip', size: 12 }), t('section.variables')),
              E('div', { className: 'mm-table is-compact' }, symbolRows)),
            E('div', { className: 'mm-section' },
              E('div', { className: 'mm-sectionHead' }, E(Icon, { name: 'chip', size: 12 }), t('section.objects')),
              E('div', { className: 'mm-table is-compact' }, objectRows))))
      }

      const pickerChoices = mapChoices.length === 0
        ? E('div', { className: 'mm-muted' }, t('picker.empty'))
        : mapChoices.map((entry) => E('button', {
          key: entry.path,
          type: 'button',
          className: 'mm-choice' + (entry.current === true ? ' is-current' : ''),
          title: entry.path,
          onClick: () => {
            setPickerOpen(false)
            void runAnalysis('manual', entry.path)
          },
        },
        E('span', { className: 'mm-choiceMain' },
          E('span', { className: 'mm-choiceProject' }, entry.project === '' ? '—' : entry.project),
          E('span', { className: 'mm-choicePath' }, entry.path),
          E('span', { className: 'mm-choiceTags' },
            entry.current === true ? E('span', { className: 'mm-tag is-current' }, t('picker.current')) : null,
            entry.manual === true ? E('span', { className: 'mm-tag' }, t('picker.manual')) : null,
            entry.nearby === true ? E('span', { className: 'mm-tag is-alias' }, t('picker.nearby')) : null,
            entry.deep === true ? E('span', { className: 'mm-tag is-alias' }, t('picker.deep')) : null,
            entry.recent === true ? E('span', { className: 'mm-tag' }, t('picker.recent')) : null)),
        E('span', { className: 'mm-choiceMeta' },
          (entry.size > 0 ? formatBytes(t, entry.size) : '') +
          (entry.mtimeMs > 0 ? ' · ' + formatTime(new Date(entry.mtimeMs).toISOString()) : ''))))

      const pickerRun = () => {
        if (manualMap.trim() === '') return
        setPickerOpen(false)
        void runAnalysis('manual', manualMap)
      }

      const picker = pickerOpen === true
        ? E('div', { className: 'mm-pickerWrap', onClick: () => setPickerOpen(false) },
          E('div', {
            className: 'mm-picker',
            role: 'dialog',
            'aria-label': t('picker.title'),
            onClick: (event) => { event.stopPropagation() },
          },
          E('div', { className: 'mm-pickerHead' },
            E('span', { className: 'mm-pickerTitle' }, t('picker.title')),
            E('button', { type: 'button', className: 'mm-iconBtn', title: t('picker.close'), onClick: () => setPickerOpen(false) },
              E(Icon, { name: 'close', size: 12 }))),
          E('div', { className: 'mm-pickerList' }, pickerChoices),
          E('div', { className: 'mm-pickerManual' },
            E('span', { className: 'mm-pickerManualHint' }, t('empty.mapManual')),
            E('div', { className: 'mm-inlineRow' },
              E('input', {
                className: 'mm-input',
                type: 'text',
                spellCheck: false,
                placeholder: t('empty.mapPath'),
                value: manualMap,
                onChange: (event) => setManualMap(event.target.value),
                onKeyDown: (event) => {
                  if (event.key !== 'Enter') return
                  event.preventDefault()
                  pickerRun()
                },
              }),
              E('button', {
                type: 'button',
                className: 'mm-btn is-primary',
                disabled: running === true || manualMap.trim() === '',
                onClick: pickerRun,
              }, t('picker.run'))))))
        : null

      return E('div', {
        className: 'mm-root' + (wide === true ? ' is-wide' : '') + (running === true ? ' is-running' : ''),
        ref: rootRef,
      },
      header,
      body,
      picker,
      report.open === true
        ? E('div', { className: 'mm-report' },
          E('div', { className: 'mm-reportHead' },
            E('span', { className: 'mm-reportTitle' }, t('report.title') + (report.runId === '' ? '' : ' · ' + report.runId)),
            E('button', { type: 'button', className: 'mm-btn', title: t('report.close'), onClick: closeReport }, E(Icon, { name: 'close', size: 12 }), t('report.close'))),
          report.loading === true
            ? E('div', { className: 'mm-empty' }, E('div', { className: 'mm-emptyHint' }, t('report.loading')))
            : (report.error !== null
              ? E('div', { className: 'mm-empty' }, E('div', { className: 'mm-emptyHint' }, t('report.failed', { message: report.error })))
              : E('iframe', { className: 'mm-reportFrame', src: report.url, title: t('report.title'), sandbox: 'allow-scripts allow-downloads' })))
        : null)
    }

    /* ============================== styles ============================== */

    const CSS = `
.mm-root{display:flex;flex-direction:column;flex:1 1 auto;height:100%;min-height:0;color:var(--dsw-alias-label-primary,#e6e6e6);background:var(--dsw-alias-bg-base,#14161a);font:inherit;font-size:13px}
.mm-icon{flex:none;display:block}
.mm-head{display:flex;align-items:center;gap:8px;flex:none;min-height:40px;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));flex-wrap:wrap}
.mm-headMain{display:flex;align-items:center;gap:6px;min-width:0;flex:1 1 auto}
.mm-title{font-size:12.5px;font-weight:600;white-space:nowrap}
.mm-chip{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 7px;border-radius:10px;font-size:11px;white-space:nowrap;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));color:var(--dsw-alias-label-secondary,#b6bac1)}
.mm-chip.is-ok{color:#3fb950;border-color:rgba(63,185,80,.35);background:rgba(63,185,80,.08)}
.mm-mapBtn{display:inline-flex;align-items:center;gap:4px;height:22px;max-width:260px;padding:0 7px;border-radius:5px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));background:transparent;color:var(--dsw-alias-label-secondary,#b6bac1);font:inherit;font-size:11px;cursor:pointer;white-space:nowrap}
.mm-mapBtn:hover,.mm-mapBtn.is-open{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));color:var(--dsw-alias-label-primary,#e6e6e6)}
.mm-mapName{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px}
.mm-caret{flex:none;font-size:9px;opacity:.7}
.mm-chip.is-proj{border-color:rgba(210,168,255,.35);color:#d2a8ff;background:rgba(210,168,255,.08)}
.mm-iconBtn{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:none;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary,#b6bac1);cursor:pointer}
.mm-iconBtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));color:var(--dsw-alias-label-primary,#e6e6e6)}
.mm-pickerWrap{position:absolute;inset:0;z-index:30;display:flex;align-items:flex-start;justify-content:center;padding:46px 12px 12px;background:rgba(0,0,0,.45)}
.mm-picker{display:flex;flex-direction:column;width:min(640px,100%);max-height:100%;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));background:var(--dsw-alias-bg-layer-1,#1b1e24);box-shadow:0 12px 40px rgba(0,0,0,.5);overflow:hidden}
.mm-pickerHead{display:flex;align-items:center;gap:8px;flex:none;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08))}
.mm-pickerTitle{flex:1 1 auto;font-size:12px;font-weight:600}
.mm-pickerList{flex:1 1 auto;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:2px;padding:6px}
.mm-choice{display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid transparent;border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:11.5px;cursor:pointer;text-align:left;width:100%}
.mm-choice:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.mm-choice.is-current{border-color:rgba(77,107,254,.45);background:rgba(77,107,254,.1)}
.mm-choiceMain{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px}
.mm-choiceProject{font-weight:600;color:#9db6ff;font-size:11.5px}
.mm-choicePath{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:10.5px}
.mm-choiceTags{display:flex;gap:4px;margin-top:1px}
.mm-choiceMeta{flex:none;color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:10.5px;white-space:nowrap}
.mm-pickerManual{flex:none;display:flex;flex-direction:column;gap:4px;padding:8px 10px;border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08))}
.mm-pickerManualHint{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8a8f98)}
.mm-pickerManual .mm-inlineRow{width:100%;margin-top:0}
.mm-map{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:11px;max-width:220px}
.mm-headActions{display:flex;align-items:center;gap:6px;flex:none}
.mm-ranAt{color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:11px;white-space:nowrap}
.mm-btn{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 9px;border-radius:5px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));background:transparent;color:var(--dsw-alias-label-secondary,#b6bac1);font:inherit;font-size:11.5px;cursor:pointer;white-space:nowrap}
.mm-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));color:var(--dsw-alias-label-primary,#e6e6e6)}
.mm-btn:disabled{opacity:.5;cursor:default}
.mm-btn.is-primary{border-color:rgba(77,107,254,.55);background:rgba(77,107,254,.16);color:#bcd0ff}
.mm-btn:focus-visible{outline:none;box-shadow:0 0 0 1px #4d6bfe}
.mm-body{flex:1 1 auto;min-height:0;overflow:auto;padding:10px 10px 16px;display:flex;flex-direction:column;gap:10px}
.mm-body.is-wide{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(280px,.7fr);align-items:start;gap:12px}
.mm-colMain,.mm-colSide{display:flex;flex-direction:column;gap:10px;min-width:0}
.mm-empty{flex:1 1 auto;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:28px 22px;text-align:center}
.mm-emptyTitle{font-size:14px;font-weight:600}
.mm-emptyHint{color:var(--dsw-alias-label-secondary,#b6bac1);font-size:12px;line-height:1.6;max-width:520px}
.mm-emptyPaths{color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:11px;word-break:break-all;max-width:560px}
.mm-emptyActions{display:flex;gap:8px;margin-top:4px}
.mm-inlineRow{display:flex;align-items:center;gap:6px;width:min(560px,100%);margin-top:2px}
.mm-suggest{display:flex;flex-direction:column;gap:2px;width:min(600px,100%);margin-top:8px;text-align:left}
.mm-suggestHead{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8f98);margin-bottom:3px}
.mm-suggestRow{display:flex;align-items:center;gap:8px;padding:5px 8px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));border-radius:6px;background:rgba(255,255,255,.02);color:inherit;font:inherit;font-size:11.5px;cursor:pointer;width:100%}
.mm-suggestRow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06));border-color:var(--dsw-alias-border-l2,rgba(255,255,255,.16))}
.mm-suggestProject{flex:none;font-weight:600;color:#9db6ff;min-width:72px;text-align:left}
.mm-suggestPath{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary,#8a8f98);text-align:left}
.mm-suggestSize{flex:none;color:var(--dsw-alias-label-secondary,#b6bac1);font-variant-numeric:tabular-nums}
.mm-input{flex:1 1 auto;min-width:0;height:26px;padding:0 8px;border-radius:5px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.04));color:inherit;font:inherit;font-size:12px}
.mm-input:focus{outline:none;border-color:#4d6bfe;box-shadow:0 0 0 1px rgba(77,107,254,.6)}
.mm-chip.is-brand{color:#9db6ff;border-color:rgba(77,107,254,.4);background:rgba(77,107,254,.1)}
.mm-error{display:flex;align-items:flex-start;gap:6px;padding:7px 9px;border-radius:6px;font-size:12px;color:#ffb4ab;background:rgba(224,100,92,.12);border:1px solid rgba(224,100,92,.35)}
.mm-running{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--dsw-alias-label-secondary,#b6bac1)}
.mm-spinner{width:12px;height:12px;border-radius:50%;border:2px solid rgba(255,255,255,.25);border-top-color:#4d6bfe;animation:mm-spin .8s linear infinite}
@keyframes mm-spin{to{transform:rotate(360deg)}}
.mm-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px}
.mm-card{padding:9px 10px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.025))}
.mm-cardHead{display:flex;align-items:baseline;justify-content:space-between;gap:6px}
.mm-cardName{font-size:12px;font-weight:600}
.mm-cardPct{font-size:13px;font-weight:700;font-variant-numeric:tabular-nums}
.mm-card.is-ok .mm-cardPct{color:#3fb950}
.mm-card.is-warn .mm-cardPct{color:#e3b341}
.mm-card.is-danger .mm-cardPct{color:#ff7b72}
.mm-bar{height:5px;margin:6px 0 5px;border-radius:3px;background:rgba(255,255,255,.08);overflow:hidden}
.mm-barFill{display:block;height:100%;border-radius:3px;background:linear-gradient(90deg,#4d9fff,#3fb950)}
.mm-card.is-warn .mm-barFill{background:linear-gradient(90deg,#e3b341,#f0883e)}
.mm-card.is-danger .mm-barFill{background:linear-gradient(90deg,#ff7b72,#e0645c)}
.mm-cardUsed,.mm-cardFree{font-size:11px;color:var(--dsw-alias-label-secondary,#b6bac1);line-height:1.5}
.mm-cardFree{color:var(--dsw-alias-label-tertiary,#8a8f98)}
.mm-warnings{display:flex;flex-direction:column;gap:4px}
.mm-warning{display:flex;align-items:flex-start;gap:6px;padding:6px 9px;border-radius:6px;font-size:11.5px;line-height:1.5;color:#e3b341;background:rgba(227,179,65,.1);border:1px solid rgba(227,179,65,.28)}
.mm-section{padding:8px 10px 10px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.02));min-width:0}
.mm-sectionHead{display:flex;align-items:center;gap:6px;font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-secondary,#b6bac1);margin-bottom:6px}
.mm-table{display:flex;flex-direction:column;font-size:11.5px}
.mm-tr{display:grid;grid-template-columns:minmax(84px,1.5fr) minmax(56px,.8fr) minmax(56px,.8fr) minmax(56px,.8fr) minmax(74px,1fr);gap:6px;align-items:center;padding:3px 0;border-top:1px solid rgba(255,255,255,.04)}
.mm-table.is-compact .mm-tr{grid-template-columns:minmax(84px,1.6fr) minmax(52px,.7fr) minmax(64px,1fr)}
.mm-tr.is-head{border-top:none;color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:10.5px;padding-bottom:4px}
.mm-td{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mm-td.is-num{text-align:right;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#b6bac1)}
.mm-td.is-pct{display:flex;align-items:center;gap:6px;justify-content:flex-end}
.mm-td.is-tag{color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:10.5px}
.mm-regionName{font-weight:600}
.mm-tag{display:inline-flex;align-items:center;height:15px;margin-left:5px;padding:0 5px;border-radius:4px;font-size:9.5px;color:#e3b341;background:rgba(227,179,65,.14);vertical-align:1px}
.mm-tag.is-alias{color:#d2a8ff;background:rgba(210,168,255,.14)}
.mm-tag.is-current{color:#3fb950;background:rgba(63,185,80,.14);margin-left:auto}
.mm-miniBar{flex:1 1 auto;display:flex;height:6px;border-radius:3px;overflow:hidden;background:rgba(255,255,255,.07);min-width:44px}
.mm-miniSeg{flex:none;height:100%}
.mm-miniSeg.is-code{background:#4f8cff}
.mm-miniSeg.is-rodata{background:#2bb673}
.mm-miniSeg.is-data{background:#f2b134}
.mm-miniSeg.is-bss{background:#9b6cf0}
.mm-miniSeg.is-stack{background:#e0645c}
.mm-miniSeg.is-heap{background:#de5fa4}
.mm-miniSeg.is-buffer{background:#35b8c9}
.mm-miniSeg.is-copy{background:#8a93a5}
.mm-miniSeg.is-fill{background:#48525f}
.mm-miniTrack{flex:none;height:100%}
.mm-pctText{flex:none;min-width:34px;text-align:right;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#b6bac1)}
.mm-tr.is-empty .mm-regionName{color:var(--dsw-alias-label-tertiary,#8a8f98)}
.mm-muted{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8a8f98);padding:2px 0}
.mm-delta{display:flex;flex-direction:column;gap:7px}
.mm-deltaTitle{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8a8f98);margin-bottom:2px}
.mm-deltaRow{display:flex;align-items:center;gap:8px;padding:2px 0;font-size:11.5px}
.mm-deltaName{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,#b6bac1)}
.mm-deltaValue{flex:none;font-variant-numeric:tabular-nums;font-weight:600}
.mm-deltaValue.is-up{color:#ff7b72}
.mm-deltaValue.is-down{color:#3fb950}
.mm-deltaValue.is-flat{color:var(--dsw-alias-label-tertiary,#8a8f98)}
.mm-history{display:flex;flex-direction:column;gap:2px}
.mm-historyRow{display:flex;align-items:center;gap:8px;padding:4px 6px;border:none;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary,#b6bac1);font:inherit;font-size:11.5px;cursor:pointer;text-align:left;width:100%}
.mm-historyRow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.mm-historyRow.is-current{background:rgba(77,107,254,.12);color:var(--dsw-alias-label-primary,#e6e6e6)}
.mm-historyTime{flex:none;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary,#8a8f98)}
.mm-historyProject{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mm-historyRam{flex:none;font-variant-numeric:tabular-nums}
.mm-report{position:absolute;inset:0;z-index:20;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base,#14161a)}
.mm-reportHead{display:flex;align-items:center;gap:8px;min-height:36px;padding:4px 8px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));flex:none}
.mm-reportTitle{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:600}
.mm-reportFrame{flex:1 1 auto;width:100%;border:none;background:#fff;min-height:0}
.mm-root{position:relative}
@media (max-width:560px){
  .mm-ranAt{display:none}
  .mm-map{display:none}
  .mm-tr{grid-template-columns:minmax(72px,1.4fr) minmax(48px,.7fr) minmax(48px,.7fr) minmax(64px,.9fr)}
  .mm-tr .mm-td.is-num:nth-child(4){display:none}
  .mm-body.is-wide{display:flex}
}
`

    /* ============================== apply ============================== */

    function apply(ctx) {
      const style = document.createElement('style')
      style.setAttribute('data-dsh-workbench-memmap', '')
      style.textContent = CSS
      document.head.appendChild(style)
      ctx.effect(() => () => { try { style.remove() } catch (error) { void error } }, 'dsh-workbench-memmap: styles')

      const t = translatorOf(ctx)
      const register = () => {
        const dock = typeof window === 'object' && window !== null ? window.__DSH_WORKBAY__ : undefined
        if (dock === undefined || dock === null || typeof dock.registerPage !== 'function') return false
        try {
          const off = dock.registerPage({
            id: PAGE_ID,
            title: t('page.title'),
            short: t('page.short'),
            order: 25,
            icon: (size) => E(Icon, { name: 'chip', size: size === undefined ? 16 : size }),
            component: (pageProps) => E(LocaleLive, {
              ctx,
              t,
              dock: pageProps === undefined || pageProps === null ? undefined : pageProps.dock,
              tier: pageProps === undefined || pageProps === null ? undefined : pageProps.tier,
              layout: pageProps === undefined || pageProps === null ? undefined : pageProps.layout,
            }),
          })
          ctx.effect(() => off, 'dsh-workbench-memmap: page')
          return true
        } catch (error) {
          try { console.error('[memmap] page registration failed:', error) } catch { void error }
          return false
        }
      }
      if (!register()) {
        let attempts = 0
        const timer = setInterval(() => {
          attempts += 1
          if (register() || attempts >= 40) clearInterval(timer)
        }, 250)
        ctx.effect(() => () => clearInterval(timer), 'dsh-workbench-memmap: dock discovery')
      }
    }

    const TEST_API = {
      PAGE_ID,
      PREFIX,
      ROOT_KEY,
      MAP_KEY,
      formatBytes,
      formatPct,
      formatDuration,
      formatTime,
      toneOf,
      storageCardsOf,
      categorySegmentsOf,
      deltaGroupsOf,
      deltaToneOf,
      shouldAutoRun,
      mapChoicesOf,
      rootOf,
      readStoredRoot,
      dictionaryFor,
      fill,
      call,
      dictionaries: { ZH, EN },
      components: { Page, LocaleLive, Icon },
    }

    return { apply, name: LOCALE_NS, __test: TEST_API }
  },
})
