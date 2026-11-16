/**
 * dsh-workbay-files - client half (plain JavaScript, no build step).
 *
 * ONE file, loaded through `window.__ModuleLoader__.load({ id, factory })`.
 * Registers ONE workbench page (`id: 'files'`, order 10) into the dock's
 * `window.__DSH_WORKBAY__` page registry (docs/files-api.md §6).
 *
 * The page owns:
 *   - workspace-root selection / switching (localStorage `dsh-workbay.root.v1`);
 *   - a lazy directory tree (POST /api/tree per directory, flat render list);
 *   - search (POST /api/search, debounced);
 *   - in-page file tabs (never dock pages) with dirty tracking;
 *   - viewers by extension (text/code, image, PDF, sandboxed HTML, JSON,
 *     markdown via a small safe renderer, binary);
 *   - an editable CodeMirror surface loaded as the lazy chunk
 *     `dsh-workbay-files:editor` (docs/files-api.md §3).
 *
 * Everything network goes through `POST /dsh-workbay-files/api/<method>` with
 * the `{ ok, data }` / `{ ok, error }` envelope; media is read straight from
 * `GET /dsh-workbay-files/media?root=&rel=`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-workbay-files',
  factory: (require) => {
    const React = require('react')
    const E = React.createElement
    const Fragment = React.Fragment
    const useState = React.useState
    const useEffect = React.useEffect
    const useMemo = React.useMemo
    const useRef = React.useRef
    const useCallback = React.useCallback

    const PAGE_ID = 'files'

    /* ============================== perf marks ==============================
     *
     * `docs/performance.md` has specified a `workbay:` mark vocabulary since M0,
     * but nothing ever implemented it — so every "p95 < N ms" budget in that
     * document was unmeasurable. These helpers are the minimum needed to fix
     * that, and they cost NOTHING when the flag is off: `mark()` returns before
     * touching `performance`, because `performance.mark` itself allocates an
     * entry and shows up in a profile.
     *
     * Enable with:  localStorage['dsh-workbay.perf'] = '1'  (then reload)
     *
     * Naming: `workbay:<area>:<event>`. Keep the vocabulary identical across
     * bundles so one CDP script can read them all.
     */
    const PERF_ON = (() => {
      try { return window.localStorage.getItem('dsh-workbay.perf') === '1' } catch (error) { void error; return false }
    })()

    /** Stamp a named instant. No-op unless the perf flag is on. */
    function perfMark(name) {
      if (PERF_ON !== true) return
      try { performance.mark('workbay:' + name) } catch (error) { void error }
    }

    /**
     * Stamp the end of a span and record the duration as a measure, so a gate
     * script can read `performance.getEntriesByType('measure')` without having to
     * pair marks itself. Returns the duration in ms (or null when disabled).
     */
    function perfMeasure(name, fromMark) {
      if (PERF_ON !== true) return null
      try {
        const from = 'workbay:' + fromMark
        const to = 'workbay:end:' + name
        performance.mark(to)
        performance.measure('workbay:' + name, from, to)
        const entries = performance.getEntriesByName('workbay:' + name, 'measure')
        return entries.length === 0 ? null : entries[entries.length - 1].duration
      } catch (error) { void error; return null }
    }
    const API_PREFIX = '/dsh-workbay-files/api/'
    const MEDIA_ROUTE = '/dsh-workbay-files/media'
    const CHUNK_ROUTE = '/dsh-workbay-files/chunk/editor.js'
    const CHUNK_NAME = 'dsh-workbay-files:editor'
    const ROOT_KEY = 'dsh-workbay.root.v1'
    const HIDDEN_KEY = 'dsh-workbay.files.hidden.v1'
    const LOCALE_NS = 'dsh-workbay-files'
    const TREE_ROW_LIMIT = 400
/* Sidebar width is dragged by the user; null = the CSS default clamp. */
const SIDEBAR_WIDTH_KEY = 'dsh-workbay.files.sidebar.v1'
const SIDEBAR_MIN_W = 170
const SIDEBAR_MAX_W = 900
function readSidebarWidth() {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_WIDTH_KEY)
    const value = raw === null ? Number.NaN : Number(raw)
    return Number.isFinite(value) && value >= SIDEBAR_MIN_W && value <= SIDEBAR_MAX_W ? Math.round(value) : null
  } catch (error) {
    void error
    return null
  }
}
function writeSidebarWidth(width) {
  try { window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width)) } catch (error) { void error }
}
    const SEARCH_LIMIT = 200
    const SEARCH_DEBOUNCE_MS = 200
    const SEARCH_PANEL_DEBOUNCE_MS = 300
    const SEARCH_PANEL_MAX_RESULTS = 200
    const SEARCH_MODES = ['content', 'name']
    const QUICK_OPEN_RECENT_LIMIT = 8
    const STAT_INTERVAL_MS = 4000
    /* Test seam: the modified-on-disk poll is the only timing-dependent timer in
       this page, and proving "no request while hidden / requests resume when
       visible" means waiting out two real intervals (9 s+). A harness may lower
       it; production never sets this. */
    const statIntervalMs = () => {
      const override = typeof globalThis === 'object' && globalThis !== null
        ? Number(globalThis.__DSH_WORKBAY_STAT_MS__) : Number.NaN
      return Number.isFinite(override) && override > 0 ? override : STAT_INTERVAL_MS
    }

    /* ============================== i18n ============================== */

    const ZH = {
      'page.files': '文件',
      'page.description': '工作区文件树、搜索、只读预览与代码编辑',

      'root.none': '还没有选择工作区',
      'root.noneHint': '选择一个文件夹作为工作区根，文件树、搜索与保存都以它为范围。',
      'root.choose': '选择工作区',
      'root.switch': '切换工作区',
      'root.current': '当前工作区',
      'root.useThis': '使用当前目录',
      'root.useFolder': '使用此文件夹',
      'root.recent': '最近使用',
      'root.drives': '磁盘',
      'root.path': '绝对路径',
      'root.pathPlaceholder': 'C:\\Users\\me\\projects',
      'root.go': '前往',
      'root.up': '上一级',
      'root.browse': '浏览文件夹',
      'root.loading': '正在读取工作区…',
      'root.noSubdirs': '这里没有子文件夹',
      'root.pickTitle': '选择工作区根',
      'root.hint': '工作区根决定文件树、搜索和保存的范围。',
      'root.loadFailed': '无法读取工作区',

      'tree.title': '文件',
      'tree.resizeWidth': '拖动调整文件列表宽度',
      'tree.loading': '正在加载…',
      'tree.empty': '这个目录是空的',
      'tree.retry': '重试',
      'tree.truncated': '条目过多，宿主只返回了一部分',
      'tree.showHidden': '显示隐藏文件',
      'tree.hideHidden': '隐藏点文件',
      'tree.refresh': '刷新',
      'tree.showMore': '再显示 {n} 行',
      'tree.capped': '已渲染 {shown} / {total} 行',
      'tree.dirLoading': '正在加载目录…',
      'tree.dirError': '目录加载失败',
      'tree.nodeModules': '依赖目录，默认折叠',
      'tree.searchPlaceholder': '快速打开文件（空格分词）',
      'tree.searching': '正在搜索…',
      'tree.searchEmpty': '没有匹配的文件',
      'tree.searchTruncated': '结果过多，已截断',
      'tree.clearSearch': '清除搜索',

      'search.title': '搜索',
      'search.placeholder': '搜索',
      'search.modeContent': '内容',
      'search.modeName': '文件名',
      'search.modeContentTitle': '搜索文件内容',
      'search.modeNameTitle': '按文件名快速打开',
      'search.caseSensitive': '区分大小写',
      'search.wholeWord': '全字匹配',
      'search.regex': '使用正则表达式',
      'search.include': '包含',
      'search.exclude': '排除',
      'search.includePlaceholder': '例如 src/**/*.ts（逗号分隔）',
      'search.excludePlaceholder': '例如 **/dist/**（逗号分隔）',
      'search.globHint': '支持 * ? ** 通配与 ! 取反',
      'search.globCount': '{n} 个 glob',
      'search.globInvalid': '无效 glob：{items}',
      'search.globDefault': '留空使用默认排除（node_modules、.git 等）',
      'search.searching': '搜索中…',
      'search.summary': '{matches} 个结果，{files} 个文件',
      'search.elapsed': '{ms} ms',
      'search.truncated': '已截断',
      'search.cancel': '取消',
      'search.noResults': '没有匹配结果',
      'search.noResultsHint': '试试切换模式、大小写或包含/排除规则。',
      'search.readyToSearch': '按 Enter 开始搜索',
      'search.recentBadge': '最近打开',
      'search.resultCount': '{n} 个匹配',

      'tabs.empty': '还没有打开文件',
      'tabs.emptyHint': '从左侧文件树或搜索结果中选择一个文件。',
      'tabs.close': '关闭',
      'tabs.unsaved': '有未保存的修改',

      'file.loading': '正在读取文件…',
      'file.readError': '无法读取这个文件',
      'file.retry': '重试',
      'file.reload': '重新加载',
      'file.save': '保存',
      'file.saving': '正在保存…',
      'file.edit': '编辑',
      'file.preview': '预览',
      'file.revert': '撤销修改',
      'file.dirty': '未保存',
      'file.readOnly': '只读',
      'file.truncated': '文件过大，内容已截断',
      'file.binary': '二进制文件，无法预览',
      'file.download': '下载',
      'file.openExternal': '在新标签页打开',
      'file.size': '大小 {size}',
      'file.modified': '磁盘上已修改',
      'file.modifiedHint': '文件在磁盘上发生了变化，重新加载可查看最新内容。',
      'file.editingHint': 'Ctrl/Cmd+S 保存',
      'file.editorUnavailable': '编辑器加载失败，已回退为纯文本预览：{message}',
      'file.loadingEditor': '正在加载编辑器…',
      'file.jsonInvalid': 'JSON 解析失败，已显示原始内容',
      'file.imageError': '图片加载失败',
      'file.pdfFallback': '无法内嵌显示 PDF，请下载后查看',
      'file.conflict': '保存冲突',
      'file.conflictHint': '文件在你打开之后被其他程序修改了。',
      'file.reloadDisk': '从磁盘重新加载',
      'file.overwrite': '覆盖磁盘文件',
      'file.noFile': '未选择文件',
      'file.unknownText': '纯文本',

      'picker.title': '选择工作区根',

      'dialog.cancel': '取消',
      'dialog.close': '关闭',
      'dialog.discard': '放弃修改',
      'dialog.saveClose': '保存并关闭',
      'dialog.switchTitle': '切换工作区？',
      'dialog.switchBody': '有 {n} 个文件存在未保存的修改，切换工作区会丢失这些修改。',
      'dialog.discardSwitch': '放弃并切换',
      'dialog.reloadTitle': '重新加载文件？',
      'dialog.reloadBody': '未保存的修改将丢失。',
      'dialog.reloadConfirm': '重新加载',
      'dialog.unsavedTitle': '关闭 {name}？',
      'dialog.unsavedBody': '这个文件有未保存的修改。',

      'toast.saved': '已保存 {name}',
      'toast.refreshed': '已刷新',
      'toast.conflict': '{name} 在磁盘上已变化，保存被拒绝',
      'toast.saveFailed': '保存 {name} 失败',

      'error.outsideRoot': '路径超出工作区范围',
      'error.badRequest': '请求无效',
      'error.badRegex': '正则表达式无效',
      'error.notFound': '文件或目录不存在',
      'error.conflict': '文件已在磁盘上被修改',
      'error.tooLarge': '文件超过大小上限',
      'error.readOnly': '宿主不允许写入（allowWrite=false）',
      'error.forbidden': '没有权限访问该路径',
      'error.network': '网络错误：{message}',
      'error.badResponse': '宿主返回了无法解析的响应',
      'error.unknown': '操作失败：{message}',
      'error.internal': '宿主内部错误：{message}',

      'viewer.language': '语言：{lang}',
      'viewer.image': '图片',
      'viewer.pdf': 'PDF',
      'viewer.html': 'HTML（沙箱）',
      'viewer.markdown': 'Markdown',
      'viewer.json': 'JSON',
      'viewer.binary': '二进制',
      'viewer.text': '文本',
      'viewer.unknown': '文件',
    }

    const EN = {
      'page.files': 'Files',
      'page.description': 'Workspace tree, search, read-only previews and a code editor',

      'root.none': 'No workspace selected yet',
      'root.noneHint': 'Choose a folder as the workspace root; the tree, search and saves are scoped to it.',
      'root.choose': 'Choose workspace',
      'root.switch': 'Switch workspace',
      'root.current': 'Current workspace',
      'root.useThis': 'Use current folder',
      'root.useFolder': 'Use this folder',
      'root.recent': 'Recent',
      'root.drives': 'Drives',
      'root.path': 'Absolute path',
      'root.pathPlaceholder': 'C:\\Users\\me\\projects',
      'root.go': 'Go',
      'root.up': 'Up one level',
      'root.browse': 'Browse folders',
      'root.loading': 'Reading workspace…',
      'root.noSubdirs': 'No subfolders here',
      'root.pickTitle': 'Choose workspace root',
      'root.hint': 'The workspace root scopes the tree, search and saves.',
      'root.loadFailed': 'Cannot read this workspace',

      'tree.title': 'Files',
      'tree.resizeWidth': 'Drag to resize the file list',
      'tree.loading': 'Loading…',
      'tree.empty': 'This folder is empty',
      'tree.retry': 'Retry',
      'tree.truncated': 'Too many entries — the host returned only a subset',
      'tree.showHidden': 'Show hidden files',
      'tree.hideHidden': 'Hide dotfiles',
      'tree.refresh': 'Refresh',
      'tree.showMore': 'Show {n} more rows',
      'tree.capped': 'Rendering {shown} / {total} rows',
      'tree.dirLoading': 'Loading folder…',
      'tree.dirError': 'Failed to load folder',
      'tree.nodeModules': 'Dependency folder, collapsed by default',
      'tree.searchPlaceholder': 'Quick open files (space-separated tokens)',
      'tree.searching': 'Searching…',
      'tree.searchEmpty': 'No matching files',
      'tree.searchTruncated': 'Too many results — truncated',
      'tree.clearSearch': 'Clear search',

      'search.title': 'Search',
      'search.placeholder': 'Search',
      'search.modeContent': 'Content',
      'search.modeName': 'Files',
      'search.modeContentTitle': 'Search file contents',
      'search.modeNameTitle': 'Quick-open by file name',
      'search.caseSensitive': 'Match case',
      'search.wholeWord': 'Match whole word',
      'search.regex': 'Use regular expression',
      'search.include': 'files to include',
      'search.exclude': 'files to exclude',
      'search.includePlaceholder': 'e.g. src/**/*.ts (comma separated)',
      'search.excludePlaceholder': 'e.g. **/dist/** (comma separated)',
      'search.globHint': 'Supports * ? ** globs and ! negation',
      'search.globCount': '{n} glob(s)',
      'search.globInvalid': 'Invalid globs: {items}',
      'search.globDefault': 'Leave empty for the default excludes (node_modules, .git, …)',
      'search.searching': 'Searching…',
      'search.summary': '{matches} results in {files} files',
      'search.elapsed': '{ms} ms',
      'search.truncated': 'Truncated',
      'search.cancel': 'Cancel',
      'search.noResults': 'No results',
      'search.noResultsHint': 'Try another mode, case sensitivity or include/exclude globs.',
      'search.readyToSearch': 'Press Enter to search',
      'search.recentBadge': 'Recently opened',
      'search.resultCount': '{n} matches',

      'tabs.empty': 'No file open',
      'tabs.emptyHint': 'Pick a file in the tree or in the search results.',
      'tabs.close': 'Close',
      'tabs.unsaved': 'Unsaved changes',

      'file.loading': 'Reading file…',
      'file.readError': 'Cannot read this file',
      'file.retry': 'Retry',
      'file.reload': 'Reload',
      'file.save': 'Save',
      'file.saving': 'Saving…',
      'file.edit': 'Edit',
      'file.preview': 'Preview',
      'file.revert': 'Revert changes',
      'file.dirty': 'Unsaved',
      'file.readOnly': 'Read-only',
      'file.truncated': 'File too large — content truncated',
      'file.binary': 'Binary file — no preview',
      'file.download': 'Download',
      'file.openExternal': 'Open in a new tab',
      'file.size': 'Size {size}',
      'file.modified': 'Changed on disk',
      'file.modifiedHint': 'The file changed on disk; reload to see the latest content.',
      'file.editingHint': 'Ctrl/Cmd+S to save',
      'file.editorUnavailable': 'The editor failed to load; showing plain text instead: {message}',
      'file.loadingEditor': 'Loading editor…',
      'file.jsonInvalid': 'Invalid JSON — showing the raw content',
      'file.imageError': 'Image failed to load',
      'file.pdfFallback': 'Cannot embed this PDF — download it instead',
      'file.conflict': 'Save conflict',
      'file.conflictHint': 'The file changed on disk after you opened it.',
      'file.reloadDisk': 'Reload from disk',
      'file.overwrite': 'Overwrite disk file',
      'file.noFile': 'No file selected',
      'file.unknownText': 'Plain text',

      'picker.title': 'Choose workspace root',

      'dialog.cancel': 'Cancel',
      'dialog.close': 'Close',
      'dialog.discard': 'Discard changes',
      'dialog.saveClose': 'Save and close',
      'dialog.switchTitle': 'Switch workspace?',
      'dialog.switchBody': '{n} file(s) have unsaved changes; switching workspaces discards them.',
      'dialog.discardSwitch': 'Discard and switch',
      'dialog.reloadTitle': 'Reload file?',
      'dialog.reloadBody': 'Unsaved changes will be lost.',
      'dialog.reloadConfirm': 'Reload',
      'dialog.unsavedTitle': 'Close {name}?',
      'dialog.unsavedBody': 'This file has unsaved changes.',

      'toast.saved': 'Saved {name}',
      'toast.refreshed': 'Refreshed',
      'toast.conflict': '{name} changed on disk — save rejected',
      'toast.saveFailed': 'Failed to save {name}',

      'error.outsideRoot': 'That path is outside the workspace',
      'error.badRequest': 'Invalid request',
      'error.badRegex': 'Invalid regular expression',
      'error.notFound': 'File or folder not found',
      'error.conflict': 'The file changed on disk',
      'error.tooLarge': 'File is over the size limit',
      'error.readOnly': 'The host disallows writes (allowWrite=false)',
      'error.forbidden': 'No permission for that path',
      'error.network': 'Network error: {message}',
      'error.badResponse': 'The host returned an unreadable response',
      'error.unknown': 'Operation failed: {message}',
      'error.internal': 'Host error: {message}',

      'viewer.language': 'Language: {lang}',
      'viewer.image': 'Image',
      'viewer.pdf': 'PDF',
      'viewer.html': 'HTML (sandboxed)',
      'viewer.markdown': 'Markdown',
      'viewer.json': 'JSON',
      'viewer.binary': 'Binary',
      'viewer.text': 'Text',
      'viewer.unknown': 'File',
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
      const tag = raw.toLowerCase().replace(/_/g, '-')
      const primary = tag.split('-')[0]
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

    /* ============================== pure helpers ============================== */

    function cx() {
      let output = ''
      for (let index = 0; index < arguments.length; index += 1) {
        const part = arguments[index]
        if (typeof part === 'string' && part !== '') output = output === '' ? part : output + ' ' + part
      }
      return output
    }

    function numberOr(value, fallback) {
      return typeof value === 'number' && Number.isFinite(value) ? value : fallback
    }

    function extensionOf(name) {
      const base = String(name === undefined || name === null ? '' : name)
      const dot = base.lastIndexOf('.')
      if (dot <= 0) return ''
      return base.slice(dot + 1).toLowerCase()
    }

    const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg']
    const HTML_EXTENSIONS = ['html', 'htm']
    const MARKDOWN_EXTENSIONS = ['md', 'markdown', 'mdown', 'mkd']
    const JSON_EXTENSIONS = ['json', 'jsonc', 'json5']
    const BINARY_EXTENSIONS = [
      'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'tar',
      'exe', 'dll', 'so', 'dylib', 'bin', 'wasm', 'class', 'jar', 'pyc',
      'woff', 'woff2', 'ttf', 'otf', 'eot',
      'mp3', 'wav', 'ogg', 'flac', 'm4a', 'mp4', 'mov', 'avi', 'mkv', 'webm',
      'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'db', 'sqlite', 'sqlite3',
    ]

    const TEXT_EXTENSIONS = [
      'txt', 'text', 'log', 'csv', 'tsv', 'ini', 'cfg', 'conf', 'toml', 'env', 'properties',
      'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx',
      'py', 'pyi', 'rb', 'php', 'pl', 'lua', 'r',
      'go', 'rs', 'java', 'kt', 'kts', 'scala', 'swift', 'cs', 'fs', 'vb',
      'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hxx', 'm', 'mm',
      'css', 'scss', 'sass', 'less', 'styl',
      'xml', 'svg', 'xsl', 'xsd', 'yaml', 'yml', 'sql', 'graphql', 'gql',
      'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'bat', 'cmd',
      'dockerfile', 'makefile', 'gradle', 'just', 'gitignore', 'gitattributes', 'editorconfig',
      'vue', 'svelte', 'astro', 'lock', 'map', 'diff', 'patch',
    ]

    const LANGUAGE_BY_EXTENSION = {
      js: 'js', mjs: 'js', cjs: 'js', jsx: 'jsx',
      ts: 'ts', mts: 'ts', cts: 'ts', tsx: 'tsx',
      json: 'json', jsonc: 'json', json5: 'json',
      md: 'md', markdown: 'md', mdown: 'md', mkd: 'md',
      py: 'py', pyi: 'py', go: 'go', rs: 'rust',
      java: 'java', kt: 'java', kts: 'java',
      c: 'c', h: 'h', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hxx: 'h',
      cs: 'cs', html: 'html', htm: 'html', css: 'css', scss: 'css', less: 'css',
      xml: 'xml', svg: 'xml', xsl: 'xml', xsd: 'xml',
      yaml: 'yaml', yml: 'yml', sql: 'sql',
      sh: 'sh', bash: 'sh', zsh: 'sh', ps1: 'ps1', psm1: 'ps1',
      rb: 'py', php: 'php', lua: 'lua', r: 'r',
    }

    function classifyFile(name) {
      const ext = extensionOf(name)
      if (IMAGE_EXTENSIONS.includes(ext)) return 'image'
      if (ext === 'pdf') return 'pdf'
      if (HTML_EXTENSIONS.includes(ext)) return 'html'
      if (MARKDOWN_EXTENSIONS.includes(ext)) return 'markdown'
      if (JSON_EXTENSIONS.includes(ext)) return 'json'
      if (BINARY_EXTENSIONS.includes(ext)) return 'binary'
      if (TEXT_EXTENSIONS.includes(ext)) return 'text'
      return 'unknown'
    }

    function languageOf(name) {
      const ext = extensionOf(name)
      if (hasOwnKey(LANGUAGE_BY_EXTENSION, ext)) return LANGUAGE_BY_EXTENSION[ext]
      return 'text'
    }

    function isReadableKind(kind) {
      return kind === 'text' || kind === 'unknown' || kind === 'markdown' || kind === 'json'
    }

    function isEditableKind(kind) {
      return kind === 'text' || kind === 'unknown' || kind === 'markdown' || kind === 'json'
    }

    /* ONE collator for the page's lifetime. Passing an options object to
       `localeCompare` rebuilds an ICU collator on every single comparison —
       measured ~11.3 us/call, so flattening 10k rows spent ~0.8 s just
       constructing collators. A shared Intl.Collator is ~10x faster and holds
       no per-call state. `numeric` stays on: natural order is what the tree
       wants ("file2" before "file10"). */
    const NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

    function compareNames(left, right) {
      return NAME_COLLATOR.compare(String(left), String(right))
    }

    /** Directories first, then natural, case-insensitive name order. */
    /* `flattenTree` re-sorted every expanded directory on every expand/collapse,
       because `sortEntries` copies and sorts unconditionally. The input array is
       the exact one the host handed back for that directory, so its IDENTITY is
       a perfect cache key: a fresh listing is a fresh array, and a stale one can
       never be re-sorted into the cache. WeakMap so dropped listings are
       collectable — no manual invalidation, no leak. */
    const sortedCache = new WeakMap()

    function sortEntries(entries) {
      if (!Array.isArray(entries)) return []
      const cached = sortedCache.get(entries)
      if (cached !== undefined) return cached
      const list = entries.slice()
      list.sort((left, right) => {
        const leftDir = left !== null && left !== undefined && left.type === 'dir'
        const rightDir = right !== null && right !== undefined && right.type === 'dir'
        if (leftDir !== rightDir) return leftDir ? -1 : 1
        const byName = compareNames(left === undefined || left === null ? '' : left.name, right === undefined || right === null ? '' : right.name)
        if (byName !== 0) return byName
        return compareNames(left === undefined || left === null ? '' : left.rel, right === undefined || right === null ? '' : right.rel)
      })
      sortedCache.set(entries, list)
      return list
    }

    /**
     * Flatten the lazily-loaded directory map into ONE render list.
     *
     * `tree` maps a directory rel ('' is the root) to
     * `{ status: 'idle'|'loading'|'ready'|'error', entries, truncated, error }`.
     * Only directories in `expanded` are descended into; a directory that is
     * expanded but not loaded (or failed) contributes a status row instead of
     * sparking its own subtree.
     */
    function flattenTree(tree, expanded, options) {
      const state = tree !== null && typeof tree === 'object' ? tree : {}
      const open = expanded instanceof Set ? expanded : new Set(Array.isArray(expanded) ? expanded : [])
      const opts = options !== null && typeof options === 'object' ? options : {}
      const showHidden = opts.showHidden === true
      const rows = []
      const walk = (dirRel, depth) => {
        const node = state[dirRel]
        if (node === undefined || node === null || node.status !== 'ready') return
        const entries = sortEntries(node.entries)
        for (let index = 0; index < entries.length; index += 1) {
          const entry = entries[index]
          if (entry === null || entry === undefined) continue
          const name = typeof entry.name === 'string' && entry.name !== '' ? entry.name : baseNameOfRel(entry.rel)
          if (showHidden !== true && name.charAt(0) === '.') continue
          const isDir = entry.type === 'dir'
          const isExpanded = isDir && open.has(entry.rel)
          rows.push({
            kind: 'entry',
            key: 'e:' + entry.rel,
            name,
            rel: entry.rel,
            type: entry.type,
            depth,
            expanded: isExpanded,
            dir: isDir,
            size: entry.size,
            mtimeMs: entry.mtimeMs,
          })
          if (!isExpanded) continue
          const child = state[entry.rel]
          if (child === undefined || child === null || child.status === 'loading' || child.status === 'idle') {
            rows.push({ kind: 'status', key: 's:' + entry.rel, rel: entry.rel, depth: depth + 1, status: 'loading' })
            continue
          }
          if (child.status === 'error') {
            rows.push({ kind: 'status', key: 's:' + entry.rel, rel: entry.rel, depth: depth + 1, status: 'error', message: child.error })
            continue
          }
          walk(entry.rel, depth + 1)
        }
        if (node.truncated === true) {
          rows.push({ kind: 'truncated', key: 't:' + dirRel, rel: dirRel, depth })
        }
      }
      walk('', 0)
      return rows
    }

    function normalizeRel(value) {
      return String(value === undefined || value === null ? '' : value)
        .replace(/\\/g, '/')
        .replace(/^\/+/, '')
        .replace(/\/+$/, '')
    }

    function joinRel(dir, name) {
      const base = normalizeRel(dir)
      const leaf = normalizeRel(name)
      if (base === '') return leaf
      if (leaf === '') return base
      return base + '/' + leaf
    }

    function baseNameOfRel(rel) {
      const parts = String(rel === undefined || rel === null ? '' : rel).replace(/\\/g, '/').split('/')
      return parts[parts.length - 1]
    }

    function dirNameOfRel(rel) {
      const parts = String(rel === undefined || rel === null ? '' : rel).replace(/\\/g, '/').split('/')
      parts.pop()
      return parts.join('/')
    }

    function ancestorDirsOf(rel) {
      const parts = normalizeRel(rel).split('/')
      parts.pop()
      const out = []
      let current = ''
      for (let index = 0; index < parts.length; index += 1) {
        if (parts[index] === '') continue
        current = current === '' ? parts[index] : current + '/' + parts[index]
        out.push(current)
      }
      return out
    }

    function formatBytes(value) {
      const bytes = typeof value === 'number' && Number.isFinite(value) ? value : 0
      if (bytes < 1024) return bytes + ' B'
      const units = ['KB', 'MB', 'GB', 'TB']
      let size = bytes / 1024
      let unit = 0
      while (size >= 1024 && unit < units.length - 1) {
        size /= 1024
        unit += 1
      }
      return (Math.round(size * 10) / 10) + ' ' + units[unit]
    }

    function escapeHtml(value) {
      return String(value === undefined || value === null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
    }

    /** Only http(s), mailto and relative URLs may become anchors. */
    function sanitizeUrl(raw) {
      const value = String(raw === undefined || raw === null ? '' : raw).trim()
      if (value === '') return null
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) {
        if (/^(https?|mailto):/i.test(value)) return value
        return null
      }
      if (value.slice(0, 2) === '//') return null
      return value
    }

    function renderEmphasis(text) {
      let output = String(text).replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      output = output.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      output = output.replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>')
      return output
    }

    /**
     * Inline markdown. Inline code and links are replaced with opaque tokens
     * before emphasis runs, so generated attributes (e.g. `target="_blank"`)
     * can never be mistaken for input markup.
     */
    function renderInline(escapedText) {
      const tokens = []
      const reserve = (html) => {
        tokens.push(html)
        return '\u0000' + (tokens.length - 1) + '\u0000'
      }
      let output = String(escapedText)
      output = output.replace(/`([^`\n]+)`/g, (match, code) => reserve('<code>' + code + '</code>'))
      output = output.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (match, label, url) => {
        const href = sanitizeUrl(url)
        if (href === null) return match
        return reserve('<a href="' + href + '" target="_blank" rel="noreferrer noopener">' + renderEmphasis(label) + '</a>')
      })
      output = renderEmphasis(output)
      return output.replace(/\u0000(\d+)\u0000/g, (match, index) => tokens[Number(index)])
    }

    /**
     * Tiny, safe markdown subset renderer.
     *
     * The WHOLE source is HTML-escaped before a single tag is emitted, so the
     * only markup in the result is the markup below. Supports ATX headings,
     * fenced code, unordered/ordered lists, blockquotes, hr, paragraphs,
     * inline code, bold, italic and links (http/https/mailto/relative only;
     * links open in a new tab with noreferrer).
     */
    function markdownToHtml(source) {
      const text = String(source === undefined || source === null ? '' : source).replace(/\r\n?/g, '\n')
      const lines = text.split('\n')
      const out = []
      let paragraph = []
      let listTag = ''
      let listItems = []

      const flushParagraph = () => {
        if (paragraph.length === 0) return
        const parts = []
        for (let index = 0; index < paragraph.length; index += 1) parts.push(renderInline(escapeHtml(paragraph[index])))
        out.push('<p>' + parts.join('<br>') + '</p>')
        paragraph = []
      }
      const flushList = () => {
        if (listTag === '' || listItems.length === 0) {
          listTag = ''
          listItems = []
          return
        }
        const items = []
        for (let index = 0; index < listItems.length; index += 1) items.push('<li>' + listItems[index] + '</li>')
        out.push('<' + listTag + '>' + items.join('') + '</' + listTag + '>')
        listTag = ''
        listItems = []
      }

      let index = 0
      while (index < lines.length) {
        const line = lines[index]
        const fence = /^\s*```(.*)$/.exec(line)
        if (fence !== null) {
          flushParagraph()
          flushList()
          const rawLanguage = fence[1].replace(/`/g, '').trim()
          const langClass = rawLanguage === '' ? '' : ' class="language-' + escapeHtml(rawLanguage) + '"'
          index += 1
          const code = []
          while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
            code.push(lines[index])
            index += 1
          }
          if (index < lines.length) index += 1
          out.push('<pre><code' + langClass + '>' + escapeHtml(code.join('\n')) + '</code></pre>')
          continue
        }
        const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
        if (heading !== null) {
          flushParagraph()
          flushList()
          const level = heading[1].length
          out.push('<h' + level + '>' + renderInline(escapeHtml(heading[2])) + '</h' + level + '>')
          index += 1
          continue
        }
        if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
          flushParagraph()
          flushList()
          out.push('<hr>')
          index += 1
          continue
        }
        if (/^\s*>/.test(line)) {
          flushParagraph()
          flushList()
          const quote = []
          while (index < lines.length && /^\s*>/.test(lines[index])) {
            quote.push(lines[index].replace(/^\s*>\s?/, ''))
            index += 1
          }
          out.push('<blockquote>' + markdownToHtml(quote.join('\n')) + '</blockquote>')
          continue
        }
        const unordered = /^\s*[-*+]\s+(.*)$/.exec(line)
        const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
        if (unordered !== null || ordered !== null) {
          flushParagraph()
          const tag = unordered !== null ? 'ul' : 'ol'
          if (listTag !== tag) {
            flushList()
            listTag = tag
          }
          const body = unordered !== null ? unordered[1] : ordered[1]
          listItems.push(renderInline(escapeHtml(body.trim())))
          index += 1
          continue
        }
        if (line.trim() === '') {
          flushParagraph()
          flushList()
          index += 1
          continue
        }
        flushList()
        paragraph.push(line)
        index += 1
      }
      flushParagraph()
      flushList()
      return out.join('')
    }

    function normalizeRootPath(value) {
      let path = String(value === undefined || value === null ? '' : value).trim()
      if (path === '') return ''
      if (path.length > 1 && /[\\/]$/.test(path) && !/^[A-Za-z]:[\\/]$/.test(path)) {
        path = path.replace(/[\\/]+$/, '')
      }
      return path
    }

    /**
     * Absolute host path of a workspace-relative entry.
     *
     * The page keeps tabs as workspace-relative paths ("app/src/main.c") and the
     * root as the absolute Windows/UNC directory, so the two are joined with a
     * backslash regardless of which separator the relative path uses.
     */
    function absolutePathOf(rootPath, rel) {
      if (typeof rootPath !== 'string' || rootPath.trim() === '') return ''
      const base = rootPath.replace(/[\\/]+$/, '')
      if (typeof rel !== 'string' || rel.trim() === '') return base
      return base + '\\' + rel.replace(/^[\\/]+/, '').replace(/[\\/]+/g, '\\')
    }

    function workspaceNameOf(root) {
      const path = normalizeRootPath(root)
      if (path === '') return ''
      const parts = path.replace(/\\/g, '/').split('/')
      for (let index = parts.length - 1; index >= 0; index -= 1) {
        if (parts[index] !== '') return parts[index]
      }
      return path
    }

    function parseStoredRoot(raw) {
      if (raw === undefined || raw === null) return null
      const text = String(raw).trim()
      if (text === '') return null
      if (text.charAt(0) === '{') {
        try {
          const parsed = JSON.parse(text)
          if (parsed !== null && typeof parsed === 'object' && typeof parsed.path === 'string' && parsed.path !== '') return normalizeRootPath(parsed.path)
        } catch (error) { void error }
        return null
      }
      return normalizeRootPath(text)
    }

    function readStoredRoot() {
      try {
        return parseStoredRoot(window.localStorage.getItem(ROOT_KEY))
      } catch (error) {
        return null
      }
    }

    function storeRoot(root) {
      try {
        const value = normalizeRootPath(root)
        if (value === '') window.localStorage.removeItem(ROOT_KEY)
        else window.localStorage.setItem(ROOT_KEY, value)
      } catch (error) { void error }
    }

    function readBool(key, fallback) {
      try {
        const raw = window.localStorage.getItem(key)
        if (raw === null || raw === '') return fallback
        return raw === '1' || raw === 'true'
      } catch (error) {
        return fallback
      }
    }

    function writeBool(key, value) {
      try {
        window.localStorage.setItem(key, value === true ? '1' : '0')
      } catch (error) { void error }
    }

    function browseEntryPath(dir, entry) {
      if (entry === null || entry === undefined) return ''
      const direct = entry.path !== undefined ? entry.path : (entry.dir !== undefined ? entry.dir : entry.absolutePath)
      if (typeof direct === 'string' && direct !== '') return direct
      const rel = typeof entry.rel === 'string' ? entry.rel : (typeof entry.name === 'string' ? entry.name : '')
      if (rel === '') return ''
      if (/^[A-Za-z]:[\\/]/.test(rel) || rel.charAt(0) === '/' || rel.slice(0, 2) === '\\\\') return rel
      const base = typeof dir === 'string' ? dir : ''
      if (base === '') return rel
      const separator = base.indexOf('\\') >= 0 ? '\\' : '/'
      return /[\\/]$/.test(base) ? base + rel : base + separator + rel
    }

    /**
     * Pure tab reducer: the single place dirty/conflict/loading transitions are
     * defined, so the component and the unit tests share one source of truth.
     */
    function reduceTab(tab, action) {
      if (tab === null || tab === undefined || typeof tab !== 'object') return tab
      if (action === null || typeof action !== 'object') return tab
      switch (action.type) {
        case 'content': {
          const content = typeof action.content === 'string' ? action.content : tab.content
          return Object.assign({}, tab, { content, dirty: content !== tab.savedContent })
        }
        case 'loaded': {
          const content = typeof action.content === 'string' ? action.content : tab.content
          return Object.assign({}, tab, {
            kind: typeof action.kind === 'string' ? action.kind : tab.kind,
            status: 'ready',
            error: null,
            content,
            savedContent: content,
            dirty: false,
            saving: false,
            conflict: false,
            externalMtimeMs: null,
            mtimeMs: numberOr(action.mtimeMs, tab.mtimeMs),
            size: numberOr(action.size, tab.size),
            truncated: action.truncated === true,
            encoding: typeof action.encoding === 'string' ? action.encoding : tab.encoding,
            editing: tab.editing === true && action.kind !== 'binary',
            mediaTick: numberOr(action.mediaTick, tab.mediaTick),
            jsonError: false,
          })
        }
        case 'saved': {
          /* `savedContent` is what reached the disk; `tab.content` may already be
             newer if the user kept typing while the write was in flight. */
          const savedContent = typeof action.savedContent === 'string'
            ? action.savedContent
            : (typeof action.content === 'string' ? action.content : tab.content)
          const content = tab.content
          return Object.assign({}, tab, {
            status: 'ready',
            content,
            savedContent,
            dirty: content !== savedContent,
            saving: false,
            conflict: false,
            externalMtimeMs: null,
            mtimeMs: numberOr(action.mtimeMs, tab.mtimeMs),
            size: numberOr(action.size, tab.size),
            truncated: false,
            jsonError: false,
          })
        }
        case 'conflict':
          return Object.assign({}, tab, { conflict: action.value !== false, saving: false })
        case 'external':
          return Object.assign({}, tab, {
            externalMtimeMs: typeof action.mtimeMs === 'number' && Number.isFinite(action.mtimeMs) ? action.mtimeMs : null,
          })
        case 'saving':
          return Object.assign({}, tab, { saving: action.value === true })
        case 'editing':
          return Object.assign({}, tab, { editing: action.value === true })
        case 'failed':
          return Object.assign({}, tab, {
            status: 'error',
            error: typeof action.message === 'string' ? action.message : String(action.message === undefined ? '' : action.message),
            saving: false,
          })
        case 'reloading':
          return Object.assign({}, tab, { status: 'loading', error: null, conflict: false, externalMtimeMs: null })
        case 'jump':
          return Object.assign({}, tab, {
            line: numberOr(action.line, tab.line || 0),
            lineToken: numberOr(action.lineToken, (tab.lineToken || 0) + 1),
            editing: action.editing === true ? true : tab.editing,
          })
        default:
          return tab
      }
    }

    /* ============================== search panel helpers ============================== */

    function createSearchState() {
      return {
        open: false,
        query: '',
        mode: 'content',
        caseSensitive: false,
        wholeWord: false,
        regex: false,
        include: '',
        exclude: '',
        includeOpen: false,
        excludeOpen: false,
        status: 'idle',
        seq: 0,
        data: null,
        error: '',
        collapsed: {},
        focusIndex: -1,
      }
    }

    /**
     * One reducer for the VSCode-like search panel. Every request carries a
     * monotonic `seq`; a response whose seq no longer matches the state is
     * dropped, which is what makes stale calls harmless.
     */
    function reduceSearchState(state, action) {
      const base = state !== null && state !== undefined && typeof state === 'object'
        ? state
        : createSearchState()
      if (action === null || action === undefined || typeof action !== 'object') return base
      switch (action.type) {
        case 'open':
          return Object.assign({}, base, { open: true })
        case 'close':
          return Object.assign({}, base, {
            open: false,
            status: 'idle',
            data: null,
            error: '',
            focusIndex: -1,
            collapsed: {},
            seq: numberOr(action.seq, base.seq + 1),
          })
        case 'reset':
          return createSearchState()
        case 'query': {
          const query = typeof action.query === 'string' ? action.query : ''
          return Object.assign({}, base, {
            query,
            focusIndex: -1,
            error: '',
            status: query.trim() === '' ? 'idle' : 'loading',
            data: query.trim() === '' ? null : base.data,
          })
        }
        case 'mode': {
          const mode = SEARCH_MODES.indexOf(action.mode) >= 0 ? action.mode : 'content'
          return Object.assign({}, base, {
            mode,
            status: 'idle',
            data: null,
            error: '',
            focusIndex: -1,
            collapsed: {},
            seq: base.seq + 1,
          })
        }
        case 'flag': {
          const flag = action.flag
          if (flag !== 'caseSensitive' && flag !== 'wholeWord' && flag !== 'regex') return base
          return Object.assign({}, base, { [flag]: base[flag] !== true })
        }
        case 'glob': {
          const field = action.field === 'exclude' ? 'exclude' : 'include'
          return Object.assign({}, base, { [field]: typeof action.value === 'string' ? action.value : '' })
        }
        case 'globOpen': {
          const field = action.field === 'excludeOpen' ? 'excludeOpen' : 'includeOpen'
          return Object.assign({}, base, { [field]: base[field] !== true })
        }
        case 'request':
          return Object.assign({}, base, {
            status: 'loading',
            seq: numberOr(action.seq, base.seq + 1),
            error: '',
            focusIndex: -1,
          })
        case 'pending':
          if (typeof base.query !== 'string' || base.query.trim() === '') return base
          return Object.assign({}, base, { status: 'loading', error: '', focusIndex: -1 })
        case 'response':
          if (numberOr(action.seq, -1) !== base.seq) return base
          return Object.assign({}, base, {
            status: 'ready',
            data: action.data !== null && action.data !== undefined ? action.data : null,
            error: '',
            focusIndex: -1,
            collapsed: {},
          })
        case 'error':
          if (numberOr(action.seq, -1) !== base.seq) return base
          return Object.assign({}, base, {
            status: 'error',
            data: null,
            error: typeof action.message === 'string' ? action.message : '',
            focusIndex: -1,
            collapsed: {},
          })
        case 'cancel':
          return Object.assign({}, base, {
            seq: numberOr(action.seq, base.seq + 1),
            status: base.data !== null && base.data !== undefined ? 'ready' : 'idle',
            error: '',
            focusIndex: -1,
          })
        case 'collapse': {
          const rel = typeof action.rel === 'string' ? action.rel : ''
          if (rel === '') return base
          return Object.assign({}, base, {
            collapsed: Object.assign({}, base.collapsed, { [rel]: base.collapsed[rel] !== true }),
            focusIndex: -1,
          })
        }
        case 'focus':
          return Object.assign({}, base, {
            focusIndex: Number.isInteger(action.index) ? action.index : -1,
          })
        default:
          return base
      }
    }

    function moveSearchFocus(index, length, delta) {
      if (!Number.isInteger(length) || length <= 0) return -1
      const current = Number.isInteger(index) && index >= 0 && index < length ? index : (delta > 0 ? -1 : length)
      const next = current + (Number.isFinite(delta) ? delta : 0)
      if (next < 0) return 0
      if (next >= length) return length - 1
      return next
    }

    function parseGlobInput(text) {
      const raw = String(text === undefined || text === null ? '' : text).trim()
      const tokens = raw === '' ? [] : raw.split(',').map((token) => token.trim()).filter((token) => token !== '')
      const invalid = tokens.filter((token) => token === '!' || /\s/.test(token) || token.length > 400)
      const valid = invalid.length === 0 && tokens.length <= 50 && raw.length <= 4000
      return { raw, tokens, invalid, valid, normalized: tokens.join(',') }
    }

    function buildSearchRequest(state, root) {      const source = state !== null && state !== undefined && typeof state === 'object' ? state : createSearchState()
      const query = typeof source.query === 'string' ? source.query : ''
      if (typeof root !== 'string' || root === '' || query.trim() === '') return null
      const request = {
        root,
        mode: source.mode === 'name' ? 'name' : 'content',
        query,
        maxResults: SEARCH_PANEL_MAX_RESULTS,
        contextLines: 0,
      }
      if (source.caseSensitive === true) request.caseSensitive = true
      if (source.wholeWord === true) request.wholeWord = true
      if (source.regex === true) request.regex = true
      const include = parseGlobInput(source.include).normalized
      if (include !== '') request.include = include
      const excludeRaw = typeof source.exclude === 'string' ? source.exclude : ''
      if (excludeRaw.trim() !== '') request.exclude = parseGlobInput(excludeRaw).normalized
      return request
    }

    function buildNameSearchRequest(root, query) {
      const text = typeof query === 'string' ? query : ''
      if (typeof root !== 'string' || root === '' || text.trim() === '') return null
      return { root, mode: 'name', query: text, maxResults: SEARCH_LIMIT }
    }

    function normalizeMatch(rawMatch) {
      if (rawMatch === null || rawMatch === undefined || typeof rawMatch !== 'object') return null
      const text = typeof rawMatch.text === 'string' ? rawMatch.text : ''
      const before = Array.isArray(rawMatch.before) ? rawMatch.before.filter((line) => typeof line === 'string') : undefined
      const after = Array.isArray(rawMatch.after) ? rawMatch.after.filter((line) => typeof line === 'string') : undefined
      return {
        line: Number.isFinite(rawMatch.line) && rawMatch.line > 0 ? Math.floor(rawMatch.line) : 1,
        column: Number.isFinite(rawMatch.column) && rawMatch.column >= 0 ? Math.floor(rawMatch.column) : 0,
        length: Number.isFinite(rawMatch.length) && rawMatch.length >= 0 ? Math.floor(rawMatch.length) : 0,
        text,
        before,
        after,
      }
    }

    /**
     * Defensive normaliser for §2.1 responses: drops malformed rows, sorts
     * files by rel and matches by line/column, and derives counts when the host
     * omits them. The client must not crash on a partially-written response.
     */
    function normalizeSearchResponse(data, requestMode, requestQuery) {
      const source = data !== null && data !== undefined && typeof data === 'object' ? data : {}
      const mode = source.mode === 'name' ? 'name' : (requestMode === 'name' ? 'name' : 'content')
      const files = []
      if (Array.isArray(source.files)) {
        for (const rawFile of source.files) {
          if (rawFile === null || rawFile === undefined || typeof rawFile.rel !== 'string' || rawFile.rel === '') continue
          const matches = []
          if (Array.isArray(rawFile.matches)) {
            for (const rawMatch of rawFile.matches) {
              const match = normalizeMatch(rawMatch)
              if (match !== null) matches.push(match)
            }
          }
          matches.sort((left, right) => (left.line - right.line) || (left.column - right.column))
          const rel = normalizeRel(rawFile.rel)
          files.push({
            rel,
            size: numberOr(rawFile.size, 0),
            mtimeMs: numberOr(rawFile.mtimeMs, 0),
            score: numberOr(rawFile.score, 0),
            indices: normalizeIndices(rawFile.indices, rel.length),
            recent: rawFile.recent === true,
            matches,
          })
        }
      }
      /* Name mode is host-score order (Quick Open); never re-sort it by rel.
         Content mode keeps §2.1's rel-natural grouping. */
      if (mode !== 'name') files.sort((left, right) => compareNames(left.rel, right.rel))
      let matchCount = 0
      for (const file of files) matchCount += file.matches.length
      return {
        root: typeof source.root === 'string' ? source.root : '',
        mode,
        query: typeof source.query === 'string' ? source.query : (typeof requestQuery === 'string' ? requestQuery : ''),
        files,
        totalMatches: Number.isFinite(source.totalMatches) ? source.totalMatches : (mode === 'name' ? files.length : matchCount),
        scannedFiles: numberOr(source.scannedFiles, 0),
        truncated: source.truncated === true,
        elapsedMs: numberOr(source.elapsedMs, 0),
      }
    }

    /** §2.1 name mode / legacy name search -> flat Quick Open entries. */
    function normalizeNameSearchEntries(data) {
      const source = data !== null && data !== undefined && typeof data === 'object' ? data : {}
      if (Array.isArray(source.files)) {
        const entries = []
        for (const file of source.files) {
          if (file === null || file === undefined || typeof file.rel !== 'string' || file.rel === '') continue
          const rel = normalizeRel(file.rel)
          entries.push({
            name: baseNameOfRel(rel),
            rel,
            type: 'file',
            size: numberOr(file.size, 0),
            mtimeMs: numberOr(file.mtimeMs, 0),
            score: numberOr(file.score, 0),
            indices: normalizeIndices(file.indices, rel.length),
            recent: file.recent === true,
          })
        }
        /* Keep the host's score order; recent-first is applied at render time. */
        return entries
      }
      if (Array.isArray(source.matches)) {
        return sortEntries(source.matches.filter((entry) => entry !== null && entry !== undefined && typeof entry.rel === 'string'))
      }
      return []
    }

    function flattenSearchResults(result, collapsed) {
      const files = result !== null && result !== undefined && Array.isArray(result.files) ? result.files : []
      const folded = collapsed !== null && collapsed !== undefined && typeof collapsed === 'object' ? collapsed : {}
      const rows = []
      for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
        const file = files[fileIndex]
        const rel = file.rel
        const matches = Array.isArray(file.matches) ? file.matches : []
        const isCollapsed = folded[rel] === true
        rows.push({
          kind: 'file',
          key: 'f:' + rel,
          rel,
          name: baseNameOfRel(rel),
          dir: dirNameOfRel(rel),
          fileIndex,
          matchCount: matches.length,
          collapsed: isCollapsed,
          size: file.size,
          mtimeMs: file.mtimeMs,
          score: numberOr(file.score, 0),
          indices: Array.isArray(file.indices) ? file.indices.slice() : [],
          recent: file.recent === true,
          /* A file row represents its first hit: clicking the file should land
             on that hit, not at line 1. Match rows still carry their own line. */
          line: matches.length > 0 && Number.isFinite(matches[0].line) && matches[0].line > 0
            ? Math.floor(matches[0].line)
            : 1,
        })
        if (isCollapsed) continue
        for (let matchIndex = 0; matchIndex < matches.length; matchIndex += 1) {
          const match = matches[matchIndex]
          rows.push({
            kind: 'match',
            key: 'm:' + rel + ':' + match.line + ':' + match.column + ':' + matchIndex,
            rel,
            name: baseNameOfRel(rel),
            dir: dirNameOfRel(rel),
            fileIndex,
            matchIndex,
            matchCount: matches.length,
            line: match.line,
            column: match.column,
            length: match.length,
            text: match.text,
          })
        }
      }
      return rows
    }

    /** Split a host-provided line into plain text segments + the highlighted hit. */
    function splitHighlight(text, column, length) {
      const source = String(text === undefined || text === null ? '' : text)
      const rawStart = Number.isFinite(column) ? Math.floor(column) : 0
      const start = Math.min(source.length, Math.max(0, rawStart))
      const rawLength = Number.isFinite(length) ? Math.floor(length) : 0
      const end = Math.min(source.length, start + Math.max(0, rawLength))
      if (end <= start) return [{ text: source, highlight: false }]
      const segments = []
      if (start > 0) segments.push({ text: source.slice(0, start), highlight: false })
      segments.push({ text: source.slice(start, end), highlight: true })
      if (end < source.length) segments.push({ text: source.slice(end), highlight: false })
      return segments
    }

    function isAbortError(error) {
      return error !== null && error !== undefined
        && (error.name === 'AbortError' || error.code === 'aborted')
    }

    /* ============================== Quick Open helpers ============================== */

    function normalizeIndices(indices, length) {
      const max = typeof length === 'number' && Number.isFinite(length) && length > 0 ? Math.floor(length) : 0
      if (!Array.isArray(indices) || max <= 0) return []
      const seen = new Set()
      for (const value of indices) {
        if (typeof value !== 'number' || !Number.isFinite(value)) continue
        const index = Math.floor(value)
        if (index >= 0 && index < max) seen.add(index)
      }
      return Array.from(seen).sort((left, right) => left - right)
    }

    /** Split text into plain segments, highlighting the characters in `indices`. */
    function splitByIndices(text, indices) {
      const source = String(text === undefined || text === null ? '' : text)
      const selected = new Set(normalizeIndices(indices, source.length))
      if (source === '' || selected.size === 0) return [{ text: source, highlight: false }]
      const segments = []
      let buffer = ''
      let highlighting = selected.has(0)
      for (let index = 0; index < source.length; index += 1) {
        const hit = selected.has(index)
        if (hit !== highlighting && buffer !== '') {
          segments.push({ text: buffer, highlight: highlighting })
          buffer = ''
        }
        highlighting = hit
        buffer += source.charAt(index)
      }
      if (buffer !== '') segments.push({ text: buffer, highlight: highlighting })
      return segments
    }

    /** Basename segments for Quick Open; `indices` are positions in `rel`. */
    function quickOpenDisplay(rel, indices) {
      const path = String(rel === undefined || rel === null ? '' : rel)
      const name = baseNameOfRel(path)
      const dir = dirNameOfRel(path)
      const offset = path.length - name.length
      const local = normalizeIndices(indices, path.length)
        .map((index) => index - offset)
        .filter((index) => index >= 0 && index < name.length)
      return { rel: path, name, dir, segments: splitByIndices(name, local) }
    }

    function normalizeRecentList(recent, limit) {
      const cap = typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : QUICK_OPEN_RECENT_LIMIT
      const list = []
      const seen = new Set()
      if (Array.isArray(recent)) {
        for (const entry of recent) {
          if (typeof entry !== 'string') continue
          const rel = normalizeRel(entry)
          if (rel === '' || seen.has(rel)) continue
          seen.add(rel)
          list.push(rel)
          if (list.length >= cap) break
        }
      }
      return list
    }

    /**
     * Recently opened files first (in recent order, deduped/capped), then the
     * host's score order. Does not add items that the host did not return.
     */
    function orderRecentFirst(items, recent, limit) {
      const source = Array.isArray(items) ? items : []
      const recentList = normalizeRecentList(recent, limit)
      const remaining = new Map()
      const ordered = []
      for (const item of source) {
        if (item === null || item === undefined || typeof item.rel !== 'string') continue
        if (remaining.has(item.rel)) continue
        remaining.set(item.rel, Object.assign({}, item, { recent: false }))
      }
      for (const rel of recentList) {
        const item = remaining.get(rel)
        if (item === undefined) continue
        ordered.push(Object.assign({}, item, { recent: true }))
        remaining.delete(rel)
      }
      for (const item of source) {
        if (item === null || item === undefined || typeof item.rel !== 'string') continue
        const found = remaining.get(item.rel)
        if (found === undefined) continue
        ordered.push(found)
        remaining.delete(item.rel)
      }
      return ordered
    }

    function createQuickOpenState() {
      return { query: '', status: 'idle', matches: [], truncated: false, error: '', focusIndex: -1, seq: 0 }
    }

    function reduceQuickOpen(state, action) {
      const base = state !== null && state !== undefined && typeof state === 'object' ? state : createQuickOpenState()
      if (action === null || action === undefined || typeof action !== 'object') return base
      switch (action.type) {
        case 'query': {
          const query = typeof action.query === 'string' ? action.query : ''
          const empty = query.trim() === ''
          return Object.assign({}, base, {
            query,
            status: empty ? 'idle' : 'loading',
            matches: empty ? [] : base.matches,
            truncated: empty ? false : base.truncated,
            error: '',
            focusIndex: -1,
          })
        }
        case 'request':
          return Object.assign({}, base, {
            status: 'loading',
            seq: numberOr(action.seq, base.seq),
            error: '',
            focusIndex: -1,
          })
        case 'response':
          if (action.seq !== undefined && action.seq !== base.seq) return base
          return Object.assign({}, base, {
            status: 'ready',
            matches: Array.isArray(action.matches) ? action.matches : [],
            truncated: action.truncated === true,
            error: '',
            focusIndex: -1,
          })
        case 'error':
          if (action.seq !== undefined && action.seq !== base.seq) return base
          return Object.assign({}, base, {
            status: 'error',
            matches: [],
            truncated: false,
            error: typeof action.message === 'string' ? action.message : '',
            focusIndex: -1,
          })
        case 'focus':
          return Object.assign({}, base, { focusIndex: Number.isInteger(action.index) ? action.index : -1 })
        case 'clear':
          return createQuickOpenState()
        default:
          return base
      }
    }

    /**
     * Keyboard command for the inline Quick Open input. `open` is handled by
     * the page (it needs the actual entry); the other commands feed the reducer.
     */
    function quickOpenKeyCommand(state, key) {
      const base = state !== null && state !== undefined && typeof state === 'object' ? state : createQuickOpenState()
      const matches = Array.isArray(base.matches) ? base.matches : []
      if (key === 'Escape') return { type: 'clear' }
      if (key === 'ArrowDown' || key === 'ArrowUp') {
        return { type: 'focus', index: moveSearchFocus(base.focusIndex, matches.length, key === 'ArrowDown' ? 1 : -1) }
      }
      if (key === 'Enter') {
        if (matches.length === 0) return null
        return { type: 'open', index: base.focusIndex >= 0 && base.focusIndex < matches.length ? base.focusIndex : 0 }
      }
      return null
    }

    /* ============================== unified search ============================== */

    /** The content-mode options survive mode switches and Esc. */
    function contentOptionsOf(content) {
      const source = content !== null && content !== undefined && typeof content === 'object' ? content : {}
      return {
        caseSensitive: source.caseSensitive === true,
        wholeWord: source.wholeWord === true,
        regex: source.regex === true,
        include: typeof source.include === 'string' ? source.include : '',
        exclude: typeof source.exclude === 'string' ? source.exclude : '',
        includeOpen: source.includeOpen === true,
        excludeOpen: source.excludeOpen === true,
      }
    }

    function createUnifiedSearchState() {
      return {
        mode: 'name',
        query: '',
        name: createQuickOpenState(),
        content: createSearchState(),
        revision: 0,
      }
    }

    /**
     * ONE search state for both modes. The shared query drives whichever mode
     * is active; each mode keeps its own cached result set and its own request
     * sequence token. Switching back to a mode reuses its cache when the query
     * is unchanged, otherwise the page schedules a fresh request.
     */
    function reduceUnifiedSearchState(state, action) {
      const base = state !== null && state !== undefined && typeof state === 'object' && state.name !== undefined && state.content !== undefined
        ? state
        : createUnifiedSearchState()
      if (action === null || action === undefined || typeof action !== 'object') return base
      switch (action.type) {
        case 'mode': {
          const mode = action.mode === 'content' ? 'content' : 'name'
          if (mode === base.mode) return base
          return Object.assign({}, base, { mode })
        }
        case 'query': {
          const query = typeof action.query === 'string' ? action.query : ''
          return Object.assign({}, base, {
            query,
            name: Object.assign({}, base.name, { focusIndex: -1, error: '' }),
            content: Object.assign({}, base.content, { focusIndex: -1, error: '' }),
          })
        }
        case 'name': {
          const previousQuery = base.name.query
          let next = reduceQuickOpen(base.name, action.action)
          const kind = action.action !== null && action.action !== undefined ? action.action.type : ''
          const stale = (kind === 'response' || kind === 'error') && next === base.name
          if (kind === 'request' && previousQuery !== action.query) {
            next = Object.assign({}, next, { matches: [], truncated: false })
          }
          const withQuery = action.query === undefined || stale
            ? next
            : Object.assign({}, next, { query: action.query })
          return Object.assign({}, base, { name: withQuery })
        }
        case 'content': {
          const previousQuery = base.content.query
          let next = reduceSearchState(base.content, action.action)
          const kind = action.action !== null && action.action !== undefined ? action.action.type : ''
          const stale = (kind === 'response' || kind === 'error') && next === base.content
          if (action.query !== undefined && stale !== true) next = Object.assign({}, next, { query: action.query })
          if (kind === 'request' && previousQuery !== action.query) {
            /* The old rows belong to another query; never show them as the new one. */
            next = Object.assign({}, next, { data: null, collapsed: {} })
          }
          if (kind === 'cancel' && previousQuery !== action.query) {
            next = Object.assign({}, next, { data: null, status: 'idle', error: '' })
          }
          if (kind === 'flag' || kind === 'glob') {
            /* Options changed: the cached set belongs to the old options. */
            next = Object.assign({}, next, { query: '', status: 'loading', focusIndex: -1 })
          }
          return Object.assign({}, base, { content: next })
        }
        case 'escape':
          return {
            mode: base.mode,
            query: '',
            name: createQuickOpenState(),
            content: Object.assign(createSearchState(), contentOptionsOf(base.content)),
            revision: base.revision,
          }
        case 'invalidate': {
          const content = Object.assign(createSearchState(), contentOptionsOf(base.content))
          return {
            mode: base.mode,
            query: base.query,
            name: createQuickOpenState(),
            content,
            revision: numberOr(base.revision, 0) + 1,
          }
        }
        default:
          return base
      }
    }

    /** Cache/view pair used by the UI: stale caches render as loading. */
    function activeSearchView(state) {
      const source = state !== null && state !== undefined && typeof state === 'object' ? state : createUnifiedSearchState()
      const cache = source.mode === 'content' ? source.content : source.name
      const fresh = typeof cache.query === 'string' && cache.query === source.query
      return {
        mode: source.mode,
        cache,
        fresh,
        status: fresh ? cache.status : 'loading',
      }
    }

    const ERROR_KEYS = {
      'outside-root': 'error.outsideRoot',
      'bad-request': 'error.badRequest',
      'bad-regex': 'error.badRegex',
      'not-found': 'error.notFound',
      'conflict': 'error.conflict',
      'too-large': 'error.tooLarge',
      'read-only': 'error.readOnly',
      'write-disabled': 'error.readOnly',
      'forbidden': 'error.forbidden',
      'network': 'error.network',
      'bad-response': 'error.badResponse',
      'internal': 'error.internal',
    }

    function describeError(t, error) {
      const message = error !== null && error !== undefined && typeof error.message === 'string' ? error.message : String(error === undefined ? '' : error)
      const code = error !== null && error !== undefined && typeof error.code === 'string' ? error.code : 'unknown'
      const key = hasOwnKey(ERROR_KEYS, code) ? ERROR_KEYS[code] : 'error.unknown'
      return t(key, { message })
    }

    /* ============================== api ============================== */

    class ApiError extends Error {
      constructor(code, message, status) {
        super(message)
        this.code = code
        this.status = status
      }
    }

    function routeUrl(path) {
      try {
        return new URL(path, document.baseURI).href
      } catch (error) {
        return path
      }
    }

    function apiUrl(method) {
      return routeUrl(API_PREFIX + method)
    }

    function mediaUrl(root, rel, tick) {
      const params = new URLSearchParams()
      params.set('root', String(root))
      params.set('rel', String(rel))
      if (typeof tick === 'number' && tick > 0) params.set('v', String(tick))
      return routeUrl(MEDIA_ROUTE) + '?' + params.toString()
    }

    /**
     * JSON-RPC against the host. `connection: close` mirrors the rest of the
     * workbench bundles: browsers may drop the forbidden header, and shells that
     * honour it avoid pooled keep-alive sockets going stale across plugin loads.
     */
    async function call(method, payload, signal) {
      let response
      try {
        response = await fetch(apiUrl(method), {
          method: 'POST',
          headers: { 'content-type': 'application/json', connection: 'close' },
          body: JSON.stringify(payload === undefined ? {} : payload),
          signal,
        })
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw new ApiError('network', error instanceof Error ? error.message : String(error))
      }
      let body = null
      try {
        body = await response.json()
      } catch (error) {
        throw new ApiError('bad-response', 'HTTP ' + response.status, response.status)
      }
      if (body !== null && body !== undefined && body.ok === true) return body.data
      const code = body !== null && body !== undefined && body.error !== undefined ? body.error.code : 'unknown'
      const message = body !== null && body !== undefined && body.error !== undefined ? body.error.message : 'HTTP ' + response.status
      throw new ApiError(code, message, response.status)
    }

    /* ---- lazy editor chunk (docs/files-api.md §3) ---- */

    let chunkPromise = null

    function chunkModuleFromGlobal() {
      const registry = typeof globalThis === 'object' && globalThis !== null ? globalThis.__dshChunks__ : undefined
      if (registry === undefined || registry === null) return undefined
      return registry[CHUNK_NAME]
    }

    function loadChunk() {
      if (chunkPromise !== null) return chunkPromise
      const start = new Promise((resolve, reject) => {
        const injected = chunkModuleFromGlobal()
        if (typeof injected === 'function') {
          try {
            resolve(injected({ modules: { react: React } }))
          } catch (error) {
            reject(error)
          }
          return
        }
        if (typeof document === 'undefined' || document === null) {
          reject(new Error('no document to inject the editor chunk into'))
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
          const factory = chunkModuleFromGlobal()
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
          /* Drop the cache so a later mount can retry the script load. */
          chunkPromise = null
          throw error instanceof Error ? error : new Error(String(error))
        },
      )
      return chunkPromise
    }

    /* ============================== icons ============================== */

    const ICONS = {
      files: ['M2 4.5A1 1 0 0 1 3 3.5h3l1.5 1.5H13a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z'],
      folder: ['M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z'],
      folderOpen: ['M2 6.5h11.5l-1.2 5.2a1 1 0 0 1-1 .8H3a1 1 0 0 1-1-1z', 'M2 6.5V4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1v.5'],
      file: ['M3.5 2.5h5l3 3v8h-8z', 'M8.5 2.5v3h3'],
      image: ['M2.5 3.5h11v9h-11z', 'M2.5 10l3-3 2.5 2.5 2-2 3 3', 'M10.5 6.5h.01'],
      code: ['M5.5 5.5L3 8l2.5 2.5', 'M10.5 5.5L13 8l-2.5 2.5'],
      markdown: ['M2.5 4.5h11v7h-11z', 'M4.5 9.5V6.5l1.5 2 1.5-2v3', 'M11 6.5v3', 'M9.8 8.3L11 9.5l1.2-1.2'],
      json: ['M6 2.5c-1.4 0-2 1-2 2v1.2c0 .8-.6 1.3-1.5 1.3.9 0 1.5.5 1.5 1.3V12c0 1 .6 2 2 2', 'M10 2.5c1.4 0 2 1 2 2v1.2c0 .8.6 1.3 1.5 1.3-.9 0-1.5.5-1.5 1.3V12c0 1-.6 2-2 2'],
      pdf: ['M3.5 2.5h5l3 3v8h-8z', 'M8.5 2.5v3h3', 'M5.5 11V8.5h.9a1 1 0 0 1 0 2h-.9', 'M8 11V8.5', 'M8 11h1.2'],
      html: ['M5.5 5L3 8l2.5 3', 'M10.5 5L13 8l-2.5 3', 'M8.8 4l-1.6 8'],
      binary: ['M3.5 2.5h5l3 3v8h-8z', 'M8.5 2.5v3h3', 'M5 11h1', 'M8 11h1', 'M11 11h1'],
      close: ['M4 4l8 8', 'M12 4l-8 8'],
      chevronRight: ['M6 3.5L10.5 8 6 12.5'],
      chevronDown: ['M3.5 6L8 10.5 12.5 6'],
      refresh: ['M13.5 8a5.5 5.5 0 1 1-1.6-3.9', 'M13.5 2.5V5.5H10.5'],
      search: ['M7.5 12.5a5 5 0 1 0 0-10 5 5 0 0 0 0 10z', 'M11 11l2.5 2.5'],
      eye: ['M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z', 'M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z'],
      eyeOff: ['M2 2l12 12', 'M6.3 6.4A2 2 0 0 0 8 10a2 2 0 0 0 1.7-.9', 'M4.2 4.6C2.6 5.7 1.5 8 1.5 8S4 12.5 8 12.5c1.1 0 2.1-.3 3-.8', 'M6.9 3.7A5.5 5.5 0 0 1 8 3.5c4 0 6.5 4.5 6.5 4.5a12 12 0 0 1-2.1 2.7'],
      edit: ['M3 13l1-3 7-7 2 2-7 7z', 'M10.5 3.5l2 2'],
      save: ['M3 3.5h8l2 2v7H3z', 'M5.5 3.5V7h5V3.5', 'M5.5 12.5V9h5v3.5'],
      trash: ['M3 4.5h10', 'M6 4.5V3h4v1.5', 'M4.5 4.5l.6 8.5h5.8l.6-8.5'],
      up: ['M8 12.5V3.5', 'M4.5 7L8 3.5l3.5 3.5'],
      drive: ['M2.5 3.5h11v9h-11z', 'M2.5 9.5h11', 'M10 11.5h.01'],
      clock: ['M8 4.5V8l2.5 1.5', 'M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12z'],
      warning: ['M8 2.5l6 11H2l6-11z', 'M8 6.5v3.5', 'M8 12h.01'],
      download: ['M8 2.5v7', 'M5 6.5L8 9.5l3-3', 'M2.5 13.5h11'],
      retry: ['M2.5 8a5.5 5.5 0 1 0 1.6-3.9', 'M2 2.5V5h2.5'],
      check: ['M3 8.5l3.5 3L13 5'],
      external: ['M9 2.5h4.5V7', 'M13.5 2.5L7 9', 'M11.5 9v4.5h-9v-9H7'],
      dot: ['M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z'],
    }

    function Icon(props) {
      const size = props.size === undefined ? 14 : props.size
      const name = props.name === undefined ? 'file' : props.name
      const shape = hasOwnKey(ICONS, name) ? ICONS[name] : ICONS.file
      return E('svg', {
        className: cx('wbf-icon', props.className),
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: props.strokeWidth === undefined ? 1.4 : props.strokeWidth,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      }, shape.map((d, index) => E('path', { key: index, d })))
    }

    function iconForEntry(entry) {
      if (entry !== null && entry !== undefined && entry.dir === true) return 'folder'
      const name = entry !== null && entry !== undefined ? entry.name : ''
      switch (classifyFile(name)) {
        case 'image': return 'image'
        case 'pdf': return 'pdf'
        case 'html': return 'html'
        case 'markdown': return 'markdown'
        case 'json': return 'json'
        case 'binary': return 'binary'
        default: return 'file'
      }
    }

    /* ============================== small UI ============================== */

    function IconButton(props) {
      return E('button', {
        type: 'button',
        className: cx('wbf-iconBtn', props.active === true ? 'is-active' : '', props.danger === true ? 'is-danger' : ''),
        title: props.label,
        'aria-label': props.label,
        disabled: props.disabled === true,
        onClick: props.onClick,
      }, E(Icon, { name: props.name, size: props.size === undefined ? 14 : props.size }))
    }

    function TextButton(props) {
      return E('button', {
        type: 'button',
        className: cx('wbf-btn', props.primary === true ? 'is-primary' : '', props.danger === true ? 'is-danger' : ''),
        title: props.title,
        disabled: props.disabled === true,
        onClick: props.onClick,
      }, props.children)
    }

    function Modal(props) {
      const { title, children, footer, onClose, closeLabel } = props
      useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') onClose()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])
      return E('div', {
        className: 'wbf-modalBackdrop',
        role: 'presentation',
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) onClose()
        },
      },
      E('div', { className: 'wbf-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        E('div', { className: 'wbf-modalHead' },
          E('span', { className: 'wbf-modalTitle' }, title),
          E(IconButton, { name: 'close', label: closeLabel === undefined ? 'Close' : closeLabel, onClick: onClose })),
        E('div', { className: 'wbf-modalBody' }, children),
        footer === undefined ? null : E('div', { className: 'wbf-modalFoot' }, footer)))
    }

    function ConfirmDialog(props) {
      const { t, title, body, confirmLabel, cancelLabel, danger, onConfirm, onCancel } = props
      return E(Modal, {
        title,
        closeLabel: t('dialog.close'),
        onClose: onCancel,
        footer: E(Fragment, null,
          E(TextButton, { onClick: onCancel }, cancelLabel),
          E(TextButton, { primary: true, danger: danger === true, onClick: onConfirm }, confirmLabel)),
      }, E('div', { className: 'wbf-dialogBody' }, body))
    }

    function UnsavedDialog(props) {
      const { t, tab, onCancel, onDiscard, onSaveAndClose } = props
      return E(Modal, {
        title: t('dialog.unsavedTitle', { name: tab.name }),
        closeLabel: t('dialog.close'),
        onClose: onCancel,
        footer: E(Fragment, null,
          E(TextButton, { onClick: onCancel }, t('dialog.cancel')),
          E(TextButton, { danger: true, onClick: onDiscard }, t('dialog.discard')),
          E(TextButton, { primary: true, onClick: onSaveAndClose }, t('dialog.saveClose'))),
      }, E('div', { className: 'wbf-dialogBody' }, t('dialog.unsavedBody')))
    }

    /* ============================== editor mount ============================== */

    /**
     * Mount the lazily-loaded editor for one file. The editor instance lives in
     * a ref (never in React state); `tab.content` is the source of truth for the
     * file text, and external replacements are pushed through `setContent`.
     */
    function EditorMount(props) {
      const { tab, t, readOnly, onChange, onSave, line, lineToken } = props
      const hostRef = useRef(null)
      const handleRef = useRef(null)
      const valueRef = useRef(typeof tab.content === 'string' ? tab.content : '')
      const callbacks = useRef({ onChange, onSave })
      callbacks.current = { onChange, onSave }
      const [state, setState] = useState('loading')
      const [failure, setFailure] = useState(null)
      const initialLine = typeof line === 'number' && Number.isFinite(line) && line > 0 ? Math.floor(line) : undefined

      useEffect(() => {
        let cancelled = false
        setState('loading')
        setFailure(null)
        const host = hostRef.current
        loadChunk().then((editor) => {
          if (cancelled) return
          if (editor === null || editor === undefined || typeof editor.createEditor !== 'function') {
            throw new Error('editor chunk has no createEditor export')
          }
          if (host === null) return
          const handle = editor.createEditor(host, {
            content: valueRef.current,
            language: tab.language,
            readOnly: readOnly === true,
            /* §3: `line` is 1-based and implementation-clamped to the document. */
            line: initialLine,
            onChange: (text) => {
              const next = typeof text === 'string' ? text : ''
              valueRef.current = next
              if (typeof callbacks.current.onChange === 'function') callbacks.current.onChange(next)
            },
            onSave: () => {
              if (typeof callbacks.current.onSave === 'function') callbacks.current.onSave()
            },
            onCursor: () => {},
          })
          handleRef.current = handle
          setState('ready')
        }).catch((error) => {
          if (cancelled) return
          setFailure(error instanceof Error ? error.message : String(error))
          setState('error')
        })
        return () => {
          cancelled = true
          const handle = handleRef.current
          handleRef.current = null
          if (handle !== null && handle !== undefined && typeof handle.destroy === 'function') {
            try {
              handle.destroy()
            } catch (error) { void error }
          }
        }
        /* `lineToken` remounts (and re-scrolls) when a search hit lands on a
           different line of an already-open file. */
      }, [tab.rel, tab.language, readOnly, lineToken, initialLine])

      /* Push content replaced from outside (reload / revert / conflict reload). */
      useEffect(() => {
        const text = typeof tab.content === 'string' ? tab.content : ''
        if (handleRef.current === null) {
          valueRef.current = text
          return
        }
        if (text === valueRef.current) return
        valueRef.current = text
        if (typeof handleRef.current.setContent === 'function') {
          try {
            handleRef.current.setContent(text)
          } catch (error) { void error }
        }
      }, [tab.content])

      return E('div', { className: 'wbf-editor' },
        failure === null ? null : E('div', { className: 'wbf-note is-error' }, t('file.editorUnavailable', { message: failure })),
        state === 'ready' ? null : E('div', { className: 'wbf-note' }, t('file.loadingEditor')),
        E('pre', { className: cx('wbf-pre', 'wbf-editorFallback', state === 'ready' ? 'is-hidden' : '') }, typeof tab.content === 'string' ? tab.content : ''),
        E('div', { ref: hostRef, className: cx('wbf-editorHost', state === 'ready' ? 'is-ready' : '') }))
    }

    /* ============================== viewers ============================== */

    function MarkdownView(props) {
      const { tab } = props
      const html = useMemo(() => markdownToHtml(tab.content), [tab.content])
      return E('div', { className: 'wbf-md', dangerouslySetInnerHTML: { __html: html } })
    }

    function JsonView(props) {
      const { tab, t } = props
      const parsed = useMemo(() => {
        try {
          return { ok: true, text: JSON.stringify(JSON.parse(tab.content), null, 2) }
        } catch (error) {
          return { ok: false, text: tab.content }
        }
      }, [tab.content])
      return E('div', { className: 'wbf-jsonWrap' },
        parsed.ok ? null : E('div', { className: 'wbf-note is-warn' }, t('file.jsonInvalid')),
        E('pre', { className: 'wbf-pre' }, parsed.text))
    }

    function ImageView(props) {
      const { tab, t, src } = props
      const [failed, setFailed] = useState(false)
      useEffect(() => { setFailed(false) }, [src])
      return E('div', { className: 'wbf-imageWrap' },
        failed
          ? E('div', { className: 'wbf-emptyView' },
            E(Icon, { name: 'image', size: 32 }),
            E('div', { className: 'wbf-emptyTitle' }, t('file.imageError')),
            E('a', { className: 'wbf-btn', href: src, download: tab.name }, t('file.download')))
          : E('img', {
            className: 'wbf-img',
            src,
            alt: tab.name,
            title: tab.rel,
            onError: () => setFailed(true),
          }))
    }

    function PdfView(props) {
      const { tab, t, src } = props
      return E('div', { className: 'wbf-mediaWrap' },
        E('embed', { className: 'wbf-embed', type: 'application/pdf', src, title: tab.name }),
        E('div', { className: 'wbf-mediaFoot' },
          E('span', null, t('file.pdfFallback')),
          E('a', { className: 'wbf-btn', href: src, download: tab.name }, t('file.download'))))
    }

    function HtmlView(props) {
      const { tab, src } = props
      return E('div', { className: 'wbf-mediaWrap' },
        E('iframe', {
          className: 'wbf-frame',
          sandbox: '',
          src,
          title: tab.name,
          referrerPolicy: 'no-referrer',
        }))
    }

    function BinaryView(props) {
      const { tab, t, src } = props
      return E('div', { className: 'wbf-emptyView wbf-binary' },
        E(Icon, { name: 'binary', size: 36 }),
        E('div', { className: 'wbf-emptyTitle' }, t('file.binary')),
        E('div', { className: 'wbf-emptyHint' }, t('file.size', { size: formatBytes(tab.size) })),
        E('div', { className: 'wbf-binaryActions' },
          E('a', { className: 'wbf-btn is-primary', href: src, download: tab.name }, t('file.download')),
          E('a', { className: 'wbf-btn', href: src, target: '_blank', rel: 'noreferrer noopener' }, t('file.openExternal'))))
    }

    function Viewer(props) {
      const { tab, t, editing, src, onChange, onSave } = props
      const line = tab.line
      const lineToken = tab.lineToken
      if (tab.kind === 'markdown') {
        return editing
          ? E(EditorMount, { tab, t, readOnly: false, onChange, onSave, line, lineToken })
          : E(MarkdownView, { tab })
      }
      if (tab.kind === 'json') {
        return editing
          ? E(EditorMount, { tab, t, readOnly: false, onChange, onSave, line, lineToken })
          : E(JsonView, { tab, t })
      }
      if (tab.kind === 'image') return E(ImageView, { tab, t, src })
      if (tab.kind === 'pdf') return E(PdfView, { tab, t, src })
      if (tab.kind === 'html') return E(HtmlView, { tab, src })
      if (tab.kind === 'binary') return E(BinaryView, { tab, t, src })
      return E(EditorMount, { tab, t, readOnly: editing !== true, onChange, onSave, line, lineToken })
    }

    /* ============================== workspace picker ============================== */

    function RootPicker(props) {
      const { t, open, current, rootsInfo, onClose, onPick } = props
      const info = rootsInfo !== null && rootsInfo !== undefined && rootsInfo.status === 'ready' ? rootsInfo.data : null
      const drives = info !== null && Array.isArray(info.drives) ? info.drives : []
      const recent = info !== null && Array.isArray(info.recent) ? info.recent : []
      const suggestedRoot = info !== null && typeof info.root === 'string' && info.root !== '' ? info.root : null
      const [typed, setTyped] = useState('')
      const [dir, setDir] = useState(null)
      const [listing, setListing] = useState({ loading: false, entries: [], parent: null, error: null })
      const seq = useRef(0)
      const seenOpen = useRef(false)

      const browseTo = useCallback((target) => {
        if (typeof target !== 'string' || target === '') return
        seq.current += 1
        const token = seq.current
        setListing((previous) => ({ ...previous, loading: true, error: null }))
        setTyped(target)
        call('browse', { dir: target }).then((data) => {
          if (seq.current !== token) return
          const nextDir = data !== null && data !== undefined && typeof data.dir === 'string' && data.dir !== '' ? data.dir : target
          setDir(nextDir)
          setTyped(nextDir)
          const rawEntries = data !== null && data !== undefined && Array.isArray(data.entries) ? data.entries : []
          const typedEntries = rawEntries.some((entry) => entry !== null && entry !== undefined && entry.type !== undefined)
          const entries = rawEntries.filter((entry) => {
            if (entry === null || entry === undefined) return false
            if (!typedEntries) return true
            return entry.type === 'dir' || entry.type === 'symlink'
          })
          setListing({
            loading: false,
            entries,
            parent: data !== null && data !== undefined && typeof data.parent === 'string' && data.parent !== '' ? data.parent : null,
            error: null,
          })
        }).catch((error) => {
          if (seq.current !== token) return
          setListing((previous) => ({ ...previous, loading: false, error: describeError(t, error) }))
        })
      }, [t])

      const startDir = current !== null && current !== undefined && current !== '' ? current : (suggestedRoot !== null ? suggestedRoot : (drives.length > 0 ? drives[0].path : null))

      useEffect(() => {
        if (open !== true) {
          seenOpen.current = false
          return
        }
        if (seenOpen.current) return
        seenOpen.current = true
        browseTo(dir === null ? startDir : dir)
      }, [open])

      const useDir = dir === null || dir === '' ? null : dir

      const row = (label, path, icon) => E('button', {
        key: path,
        type: 'button',
        className: cx('wbf-libRow', path === dir ? 'is-current' : ''),
        title: path,
        onClick: () => browseTo(path),
      },
      E(Icon, { name: icon, size: 12 }),
      E('span', { className: 'wbf-libRowName' }, label),
      E('span', { className: 'wbf-libRowPath' }, path))

      const driveNodes = drives.length === 0 ? null : E('div', { className: 'wbf-libDrives' },
        drives.map((drive) => E('button', {
          key: drive.path,
          type: 'button',
          className: 'wbf-libDrive',
          title: drive.path,
          onClick: () => browseTo(drive.path),
        }, drive.name === undefined || drive.name === '' ? drive.path : drive.name)))

      const currentSection = suggestedRoot === null ? null : E('div', { className: 'wbf-libSection' },
        E('div', { className: 'wbf-libLabel' }, t('root.current')),
        E('button', {
          type: 'button',
          className: 'wbf-libRow is-suggested',
          title: suggestedRoot,
          onClick: () => onPick(suggestedRoot),
        },
        E(Icon, { name: 'folder', size: 12 }),
        E('span', { className: 'wbf-libRowName' }, workspaceNameOf(suggestedRoot)),
        E('span', { className: 'wbf-libRowPath' }, suggestedRoot)))

      const recentSection = recent.length === 0 ? null : E('div', { className: 'wbf-libSection' },
        E('div', { className: 'wbf-libLabel' }, t('root.recent')),
        E('div', { className: 'wbf-libList' }, recent.map((entry) => row(String(entry).replace(/[\\/]+$/, ''), entry, 'clock'))))

      const rootsNote = rootsInfo === null || rootsInfo === undefined
        ? null
        : rootsInfo.status === 'loading'
          ? E('div', { className: 'wbf-libNote' }, t('root.loading'))
          : rootsInfo.status === 'error'
            ? E('div', { className: 'wbf-libNote is-error' }, rootsInfo.error)
            : null

      const folderRows = listing.loading === true
        ? E('div', { className: 'wbf-libNote' }, t('root.loading'))
        : listing.error !== null
          ? E('div', { className: 'wbf-libNote is-error' }, listing.error)
          : listing.entries.length === 0
            ? E('div', { className: 'wbf-libNote' }, t('root.noSubdirs'))
            : listing.entries.map((entry) => {
              const path = browseEntryPath(dir, entry)
              const name = typeof entry.name === 'string' && entry.name !== '' ? entry.name : baseNameOfRel(path)
              return row(name, path, 'folder')
            })

      const footer = E(Fragment, null,
        E(TextButton, { onClick: onClose }, t('dialog.cancel')),
        E(TextButton, {
          primary: true,
          disabled: useDir === null,
          onClick: () => { if (useDir !== null) onPick(useDir) },
        }, t('root.useFolder')))

      return E(Modal, {
        title: t('root.pickTitle'),
        closeLabel: t('dialog.close'),
        onClose,
        footer,
      },
      E('div', { className: 'wbf-picker' },
        rootsNote,
        currentSection,
        E('div', { className: 'wbf-libSection' },
          E('div', { className: 'wbf-libLabel' }, t('root.drives')),
          driveNodes),
        E('div', { className: 'wbf-libSection' },
          E('div', { className: 'wbf-libLabel' }, t('root.browse')),
          E('div', { className: 'wbf-libInputRow' },
            E('input', {
              className: 'wbf-libInput',
              type: 'text',
              value: typed,
              spellCheck: false,
              placeholder: t('root.pathPlaceholder'),
              onChange: (event) => setTyped(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') browseTo(typed.trim())
              },
            }),
            E(TextButton, { onClick: () => browseTo(typed.trim()), disabled: typed.trim() === '' }, t('root.go'))),
          E('div', { className: 'wbf-libPathBar' },
            E(IconButton, { name: 'up', label: t('root.up'), disabled: listing.parent === null, onClick: () => { if (listing.parent !== null) browseTo(listing.parent) } }),
            E('span', { className: 'wbf-libPath', title: dir === null ? '' : dir }, dir === null ? '' : dir),
            E(IconButton, { name: 'refresh', label: t('root.browse'), onClick: () => { if (dir !== null) browseTo(dir) } })),
          E('div', { className: 'wbf-libList' }, folderRows))),
        recentSection,
        E('div', { className: 'wbf-libHint' }, t('root.hint')))
    }

    /* ============================== tree sidebar ============================== */

    /* ============================== unified search UI ============================== */

    function SearchModeSegment(props) {
      const { t, mode, onModeChange } = props
      return E('div', { className: 'wbf-searchModes', role: 'group', 'aria-label': t('search.title') },
        E('button', {
          type: 'button',
          className: cx('wbf-searchMode', mode === 'name' ? 'is-active' : ''),
          title: t('search.modeNameTitle'),
          'aria-pressed': mode === 'name',
          onClick: () => onModeChange('name'),
        }, t('search.modeName')),
        E('button', {
          type: 'button',
          className: cx('wbf-searchMode', mode === 'content' ? 'is-active' : ''),
          title: t('search.modeContentTitle'),
          'aria-pressed': mode === 'content',
          onClick: () => onModeChange('content'),
        }, t('search.modeContent')))
    }

    /** Content-mode-only options: Aa / ab / .* plus the collapsible glob fields. */
    function SearchOptions(props) {
      const { t, content, onToggleFlag, onGlobChange, onToggleGlobOpen } = props
      const flagButton = (flag, label, glyph) => E('button', {
        type: 'button',
        className: cx('wbf-srFlag', content[flag] === true ? 'is-active' : ''),
        title: label,
        'aria-label': label,
        'aria-pressed': content[flag] === true,
        onClick: () => onToggleFlag(flag),
      }, glyph)
      const globField = (field, label, placeholder) => {
        const parsed = parseGlobInput(content[field])
        const open = content[field + 'Open'] === true
        return E('div', { className: 'wbf-srGlob' },
          E('button', {
            type: 'button',
            className: 'wbf-srGlobHead',
            'aria-expanded': open,
            onClick: () => onToggleGlobOpen(field + 'Open'),
          },
          E(Icon, { name: open ? 'chevronDown' : 'chevronRight', size: 10 }),
          E('span', null, label),
          parsed.tokens.length === 0 ? null : E('span', { className: 'wbf-badge' }, t('search.globCount', { n: parsed.tokens.length }))),
          open ? E(Fragment, null,
            E('input', {
              className: 'wbf-srGlobInput',
              type: 'text',
              value: content[field],
              placeholder,
              spellCheck: false,
              onChange: (event) => onGlobChange(field, event.target.value),
            }),
            parsed.invalid.length > 0
              ? E('div', { className: 'wbf-srGlobInvalid' }, t('search.globInvalid', { items: parsed.invalid.join(', ') }))
              : parsed.tokens.length > 0
                ? E('div', { className: 'wbf-srGlobChips' }, parsed.tokens.map((token, index) => E('span', {
                  key: String(index) + token,
                  className: 'wbf-srGlobChip',
                }, token)))
                : E('div', { className: 'wbf-srHint' }, field === 'exclude' ? t('search.globDefault') : t('search.globHint')),
            parsed.tokens.length > 0 ? E('div', { className: 'wbf-srHint' }, t('search.globHint')) : null)
            : null)
      }
      return E('div', { className: 'wbf-searchOptions' },
        E('div', { className: 'wbf-searchFlags' },
          flagButton('caseSensitive', t('search.caseSensitive'), 'Aa'),
          flagButton('wholeWord', t('search.wholeWord'), 'ab'),
          flagButton('regex', t('search.regex'), '.*')),
        globField('include', t('search.include'), t('search.includePlaceholder')),
        globField('exclude', t('search.exclude'), t('search.excludePlaceholder')))
    }

    function QuickOpenResults(props) {
      const { t, view, recentFiles, onOpenRow } = props
      const matches = useMemo(
        () => orderRecentFirst(view.cache.matches, recentFiles),
        [view.cache.matches, recentFiles],
      )
      if (view.fresh !== true || view.cache.status === 'loading') {
        return E('div', { className: 'wbf-treeStatus' }, t('tree.searching'))
      }
      if (view.cache.status === 'error') {
        return E('div', { className: 'wbf-treeError' }, E(Icon, { name: 'warning', size: 12 }), E('span', null, view.cache.error))
      }
      if (matches.length === 0) return E('div', { className: 'wbf-treeStatus' }, t('tree.searchEmpty'))
      return E(Fragment, null,
        E('div', { className: 'wbf-quickMeta' },
          E('span', { className: 'wbf-quickCount' }, t('search.resultCount', { n: matches.length })),
          view.cache.truncated === true ? E('span', { className: 'wbf-quickTruncated' }, t('tree.searchTruncated')) : null),
        E('div', { className: 'wbf-searchResults' }, matches.map((entry, index) => {
          const rel = typeof entry.rel === 'string' ? entry.rel : ''
          const display = quickOpenDisplay(rel, entry.indices)
          return E('button', {
            key: rel,
            type: 'button',
            className: cx(
              'wbf-searchResultRow',
              index === view.cache.focusIndex ? 'is-focused' : '',
              entry.recent === true ? 'is-recent' : '',
            ),
            title: rel,
            onClick: () => onOpenRow(entry),
          },
          E(Icon, { name: iconForEntry({ name: display.name, dir: false }), size: 13 }),
          E('span', { className: 'wbf-searchName' }, display.segments.map((segment, segmentIndex) => E(
            'span',
            { key: segmentIndex, className: segment.highlight ? 'wbf-searchHit' : undefined },
            segment.text,
          ))),
          E('span', { className: 'wbf-searchDir', title: display.dir }, display.dir === '' ? '/' : display.dir),
          entry.recent === true ? E('span', { className: 'wbf-recentBadge' }, t('search.recentBadge')) : null)
        })))
    }

    function ContentResults(props) {
      const { t, view, content, onCancel, onCollapse, onOpenRow } = props
      const data = view.fresh === true ? content.data : null
      const rows = useMemo(() => flattenSearchResults(data, content.collapsed), [data, content.collapsed])
      const ready = view.fresh === true && content.status === 'ready'
      const fileCount = ready && data !== null && Array.isArray(data.files) ? data.files.length : 0
      const matchCount = ready && data !== null && Number.isFinite(data.totalMatches) ? data.totalMatches : 0

      let statusNode = null
      if (view.fresh !== true || content.status === 'loading') {
        statusNode = E('div', { className: 'wbf-srStatus is-busy' },
          E('span', { className: 'wbf-srStatusText' }, t('search.searching')),
          E('button', { type: 'button', className: 'wbf-btn is-small', onClick: onCancel }, t('search.cancel')))
      } else if (content.status === 'error') {
        statusNode = E('div', { className: 'wbf-srStatus is-error', role: 'alert' },
          E(Icon, { name: 'warning', size: 12 }),
          E('span', { className: 'wbf-srStatusText' }, content.error === '' ? t('error.unknown', { message: '' }) : content.error))
      } else if (view.fresh === true && content.status === 'idle') {
        statusNode = E('div', { className: 'wbf-srStatus is-idle' },
          E('span', { className: 'wbf-srStatusText' }, t('search.readyToSearch')))
      } else if (ready) {
        statusNode = E('div', { className: 'wbf-srStatus is-ready' },
          E('span', { className: 'wbf-srStatusText' }, t('search.summary', { matches: matchCount, files: fileCount })),
          E('span', { className: 'wbf-srStatusMeta' }, t('search.elapsed', { ms: data.elapsedMs })),
          data.truncated === true ? E('span', { className: 'wbf-srTruncated' }, t('search.truncated')) : null)
      }

      let listBody = null
      if (ready && fileCount === 0) {
        listBody = E('div', { className: 'wbf-srEmpty' },
          E(Icon, { name: 'search', size: 22 }),
          E('div', null, t('search.noResults')),
          E('div', { className: 'wbf-srHint' }, t('search.noResultsHint')))
      } else if (ready) {
        listBody = rows.map((row, index) => {
          const focused = content.focusIndex === index
          if (row.kind === 'file') {
            return E('button', {
              key: row.key,
              type: 'button',
              'data-row-index': index,
              className: cx('wbf-srFile', focused ? 'is-focused' : ''),
              title: row.rel,
              onClick: () => onCollapse(row.rel),
            },
            E('span', { className: 'wbf-srChevron' }, E(Icon, { name: row.collapsed ? 'chevronRight' : 'chevronDown', size: 10 })),
            E(Icon, { name: 'file', size: 12 }),
            E('span', { className: 'wbf-srFileName' }, row.name),
            row.dir === '' ? null : E('span', { className: 'wbf-srFileDir', title: row.dir }, row.dir),
            row.matchCount <= 0 ? null : E('span', { className: 'wbf-srCount' }, String(row.matchCount)))
          }
          const segments = splitHighlight(row.text, row.column, row.length)
          return E('button', {
            key: row.key,
            type: 'button',
            'data-row-index': index,
            className: cx('wbf-srMatch', focused ? 'is-focused' : ''),
            title: row.rel + ':' + String(row.line),
            onClick: () => onOpenRow(row),
          },
          E('span', { className: 'wbf-srLine' }, String(row.line)),
          E('span', { className: 'wbf-srSnippet' }, segments.map((segment, segmentIndex) => E(
            'span',
            { key: segmentIndex, className: segment.highlight ? 'wbf-srHit' : undefined },
            segment.text,
          ))))
        })
      }

      return E(Fragment, null,
        statusNode,
        E('div', { className: 'wbf-searchContentList' }, listBody))
    }

    function TreeRow(props) {
      const { row, t, activeRel, onToggleDir, onOpenFile, onRetryDir } = props
      const padding = 6 + row.depth * 14
      if (row.kind === 'status') {
        if (row.status === 'loading') {
          return E('div', { className: 'wbf-treeStatus', style: { paddingLeft: padding } }, t('tree.dirLoading'))
        }
        return E('div', { className: 'wbf-treeError', style: { paddingLeft: padding } },
          E(Icon, { name: 'warning', size: 12 }),
          E('span', { className: 'wbf-treeErrorMessage' }, row.message === undefined || row.message === '' ? t('tree.dirError') : row.message),
          E('button', { type: 'button', className: 'wbf-linkBtn', onClick: () => onRetryDir(row.rel) }, t('tree.retry')))
      }
      if (row.kind === 'truncated') {
        return E('div', { className: 'wbf-treeStatus is-warn', style: { paddingLeft: padding } }, t('tree.truncated'))
      }
      const isActive = row.rel === activeRel
      return E('div', {
        className: cx('wbf-row', row.dir ? 'is-dir' : 'is-file', isActive ? 'is-active' : '', row.expanded ? 'is-expanded' : ''),
        style: { paddingLeft: padding },
        role: 'button',
        tabIndex: 0,
        title: row.rel + (row.dir === true && row.name === 'node_modules' ? '\n' + t('tree.nodeModules') : ''),
        onClick: () => {
          if (row.dir) onToggleDir(row.rel)
          else onOpenFile(row)
        },
        onKeyDown: (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          if (row.dir) onToggleDir(row.rel)
          else onOpenFile(row)
        },
      },
      E('span', { className: 'wbf-rowChevron' }, row.dir ? E(Icon, { name: row.expanded ? 'chevronDown' : 'chevronRight', size: 11 }) : null),
      E(Icon, { name: iconForEntry(row), size: 13, className: 'wbf-rowIcon' }),
      E('span', { className: 'wbf-rowName' }, row.name),
      row.dir === true && row.name === 'node_modules' ? E('span', { className: 'wbf-rowBadge' }, 'node_modules') : null)
    }

    function TreePanel(props) {
      const {
        t, root, tree, rows, rowLimit, showHidden,
        search, recentFiles, activeRel,
        onQueryChange, onModeChange, onSearchKeyDown, onToggleFlag,
        onGlobChange, onToggleGlobOpen, onCollapse, onCancel,
        onOpenQuickResult, onOpenContentRow, onClearSearch,
        onToggleHidden, onRefresh, onToggleDir, onOpenFile, onRetryDir, onShowMore,
      } = props
      const rootNode = tree['']
      const searching = search.query.trim() !== ''
      const view = activeSearchView(search)
      let body = null
      if (root === null || root === '') {
        body = E('div', { className: 'wbf-treeStatus' }, t('root.none'))
      } else if (searching) {
        body = view.mode === 'content'
          ? E(ContentResults, {
            t,
            view,
            content: search.content,
            onCancel,
            onCollapse,
            onOpenRow: onOpenContentRow,
          })
          : E(QuickOpenResults, {
            t,
            view,
            recentFiles,
            onOpenRow: onOpenQuickResult,
          })
      } else if (rootNode === undefined || rootNode === null || rootNode.status === 'loading' || rootNode.status === 'idle') {
        body = E('div', { className: 'wbf-treeStatus' }, t('tree.loading'))
      } else if (rootNode.status === 'error') {
        body = E('div', { className: 'wbf-treeError wbf-treeErrorRoot' },
          E(Icon, { name: 'warning', size: 12 }),
          E('span', null, rootNode.error === undefined || rootNode.error === '' ? t('root.loadFailed') : rootNode.error),
          E('button', { type: 'button', className: 'wbf-linkBtn', onClick: onRefresh }, t('tree.retry')))
      } else if (rows.length === 0) {
        body = E('div', { className: 'wbf-treeStatus' }, t('tree.empty'))
      } else {
        const shown = rows.slice(0, rowLimit)
        body = E(Fragment, null,
          shown.map((row) => E(TreeRow, {
            key: row.key,
            row,
            t,
            activeRel,
            onToggleDir,
            onOpenFile,
            onRetryDir,
          })),
          rows.length > shown.length
            ? E('div', { className: 'wbf-treeFoot' },
              E('span', null, t('tree.capped', { shown: shown.length, total: rows.length })),
              E('button', {
                type: 'button',
                className: 'wbf-linkBtn',
                onClick: onShowMore,
              }, t('tree.showMore', { n: Math.min(TREE_ROW_LIMIT, rows.length - shown.length) })))
            : null)
      }

      const searchBar = E('div', { className: 'wbf-searchRow wbf-searchBar' },
        E(Icon, { name: 'search', size: 12, className: 'wbf-searchIcon' }),
        E('input', {
          className: 'wbf-searchInput',
          type: 'search',
          value: search.query,
          placeholder: view.mode === 'content' ? t('search.placeholder') : t('tree.searchPlaceholder'),
          spellCheck: false,
          onChange: (event) => onQueryChange(event.target.value),
          onKeyDown: onSearchKeyDown,
        }),
        E(SearchModeSegment, { t, mode: search.mode, onModeChange }),
        search.query === '' ? null : E(IconButton, { name: 'close', size: 12, label: t('tree.clearSearch'), onClick: onClearSearch }))

      const options = search.mode === 'content'
        ? E(SearchOptions, {
          t,
          content: search.content,
          onToggleFlag,
          onGlobChange,
          onToggleGlobOpen,
        })
        : null

      return E('div', { className: 'wbf-treeWrap' },
        searchBar,
        options,
        searching ? null : E('div', { className: 'wbf-treeToolbar' },
          E('span', { className: 'wbf-treeTitle' }, t('tree.title')),
          E('span', { className: 'wbf-treeToolbarActions' },
            E(IconButton, { name: showHidden ? 'eye' : 'eyeOff', size: 13, active: showHidden === true, label: showHidden ? t('tree.hideHidden') : t('tree.showHidden'), onClick: onToggleHidden }),
            E(IconButton, { name: 'refresh', size: 13, label: t('tree.refresh'), onClick: onRefresh }))),
        E('div', { className: 'wbf-tree' }, body))
    }

    /* ============================== file header / tabs ============================== */

    function TabStrip(props) {
      const { t, tabs, activeRel, onActivate, onClose } = props
      if (tabs.length === 0) return null
      return E('div', { className: 'wbf-tabs', role: 'tablist' },
        tabs.map((tab) => E('div', {
          key: tab.rel,
          role: 'tab',
          'aria-selected': tab.rel === activeRel,
          className: cx('wbf-tab', tab.rel === activeRel ? 'is-active' : ''),
          title: tab.rel + (tab.dirty ? '\n' + t('tabs.unsaved') : ''),
          onClick: () => onActivate(tab.rel),
          onAuxClick: (event) => {
            if (event.button === 1) {
              event.preventDefault()
              onClose(tab.rel)
            }
          },
        },
        tab.dirty ? E('span', { className: 'wbf-tabDot', title: t('tabs.unsaved') }) : E(Icon, { name: iconForEntry({ name: tab.name, dir: false }), size: 11 }),
        E('span', { className: 'wbf-tabName' }, tab.name),
        E('span', {
          className: 'wbf-tabClose',
          role: 'button',
          tabIndex: -1,
          title: t('tabs.close'),
          onClick: (event) => {
            event.stopPropagation()
            onClose(tab.rel)
          },
        }, '\u00d7'))))
    }

    function FileHeader(props) {
      const { t, tab, editing, onToggleEdit, onSave, onReload, onClose, onRevert } = props
      const external = tab.externalMtimeMs !== null && tab.externalMtimeMs !== undefined && tab.externalMtimeMs !== tab.mtimeMs
      const editable = isEditableKind(tab.kind) && tab.status === 'ready' && tab.truncated !== true
      const kindLabel = hasOwnKey({ image: 1, pdf: 1, html: 1, markdown: 1, json: 1, binary: 1 }, tab.kind) ? tab.kind : 'text'
      return E('div', { className: 'wbf-fileHead' },
        E('div', { className: 'wbf-fileIdentity' },
          E('span', { className: 'wbf-filePath', title: tab.rel }, tab.rel),
          E('span', { className: 'wbf-badges' },
            E('span', { className: 'wbf-badge' }, t('viewer.' + kindLabel)),
            tab.kind !== 'image' && tab.kind !== 'pdf' && tab.kind !== 'html' && tab.kind !== 'binary'
              ? E('span', { className: 'wbf-badge' }, tab.language)
              : null,
            tab.size > 0 ? E('span', { className: 'wbf-badge' }, formatBytes(tab.size)) : null,
            tab.truncated ? E('span', { className: 'wbf-badge is-warn' }, t('file.truncated')) : null,
            tab.dirty ? E('span', { className: 'wbf-badge is-warn' }, t('file.dirty')) : null,
            external
              ? E('span', {
                className: 'wbf-badge is-warn',
                title: t('file.modifiedHint'),
              }, t('file.modified'))
              : null)),
        E('div', { className: 'wbf-headActions' },
          external
            ? E(TextButton, { onClick: onReload }, t('file.reloadDisk'))
            : null,
          editable
            ? E(TextButton, { onClick: onToggleEdit }, editing ? t('file.preview') : t('file.edit'))
            : null,
          editable && editing && tab.dirty
            ? E(TextButton, { onClick: () => onRevert() }, t('file.revert'))
            : null,
          editable && editing && tab.dirty
            ? E(TextButton, { primary: true, disabled: tab.saving === true, onClick: () => onSave() }, tab.saving === true ? t('file.saving') : t('file.save'))
            : null,
          E(IconButton, { name: 'close', size: 13, label: t('tabs.close'), onClick: onClose })))
    }

    function ConflictBar(props) {
      const { t, tab, onReload, onOverwrite } = props
      return E('div', { className: 'wbf-conflict' },
        E(Icon, { name: 'warning', size: 14 }),
        E('span', { className: 'wbf-conflictText' }, t('file.conflictHint')),
        E('span', { className: 'wbf-conflictActions' },
          E(TextButton, { onClick: onReload }, t('file.reloadDisk')),
          E(TextButton, { primary: true, onClick: onOverwrite }, t('file.overwrite'))))
    }

    /* ============================== empty states ============================== */

    function ViewerEmpty(props) {
      const { t, hasRoot, onChoose } = props
      if (!hasRoot) {
        return E('div', { className: 'wbf-emptyView' },
          E(Icon, { name: 'files', size: 40 }),
          E('div', { className: 'wbf-emptyTitle' }, t('root.none')),
          E('div', { className: 'wbf-emptyHint' }, t('root.noneHint')),
          E('div', null, E(TextButton, { primary: true, onClick: onChoose }, t('root.choose'))))
      }
      return E('div', { className: 'wbf-emptyView' },
        E(Icon, { name: 'files', size: 40 }),
        E('div', { className: 'wbf-emptyTitle' }, t('tabs.empty')),
        E('div', { className: 'wbf-emptyHint' }, t('tabs.emptyHint')))
    }

    /* ============================== search panel ============================== */

    /**
     * VSCode-like search surface. It replaces the explorer list while open
     * (the sidebar root chip stays visible); rows are plain buttons so the
     * keyboard handler can activate the flattened result at `focusIndex`.
     *
     * Keyboard: ↑/↓ moves the flattened focus, Enter opens a focused match (or
     * toggles a file group), Enter in the empty-focus input runs the search
     * immediately, Ctrl/Cmd+Enter opens the focused row and closes the panel,
     * Esc closes the panel.
     */
    /* ============================== page ============================== */

    /**
     * Insert plain text into the conversation composer.
     *
     * Cloned from the source-control page (already proven there): focusing the
     * contenteditable and running insertText makes the browser treat it as real
     * typing, so the controlled editor, @ autocomplete and undo stack all agree.
     */
    function insertIntoComposer(text) {
      if (typeof document === 'undefined' || document === null) return false
      const candidates = [
        '[data-testid="composer"] [contenteditable="true"]',
        '[contenteditable="true"][role="textbox"]',
        'textarea[placeholder]',
      ]
      let node = null
      for (const selector of candidates) {
        const found = document.querySelector(selector)
        if (found !== null && found !== undefined) { node = found; break }
      }
      if (node === null) {
        const all = document.querySelectorAll('[contenteditable="true"]')
        if (all.length > 0) node = all[all.length - 1]
      }
      if (node === null) return false
      try {
        node.focus()
        if (node.tagName === 'TEXTAREA' || node.tagName === 'INPUT') {
          const start = typeof node.selectionStart === 'number' ? node.selectionStart : node.value.length
          const before = node.value.slice(0, start)
          const after = node.value.slice(start)
          node.value = before + text + after
          node.setSelectionRange(before.length + text.length, before.length + text.length)
          node.dispatchEvent(new Event('input', { bubbles: true }))
          return true
        }
        const selection = window.getSelection()
        if (selection === null) return false
        if (selection.rangeCount === 0 || node.contains(selection.anchorNode) === false) {
          const range = document.createRange()
          range.selectNodeContents(node)
          range.collapse(false)
          selection.removeAllRanges()
          selection.addRange(range)
        }
        return document.execCommand('insertText', false, text) === true
      } catch (error) {
        void error
        return false
      }
    }

    function Page(props) {
      const { t } = props
      const rootRef = useRef(null)
      const showHiddenRef = useRef(false)
      const tabsRef = useRef([])
      const activeRelRef = useRef(null)
      const treeRef = useRef({})
      const dirReqRef = useRef(new Map())
      const treeKeyRef = useRef(null)
      const toastTimerRef = useRef(null)
      const searchRef = useRef(null)
      const searchAbortRef = useRef(null)
      const searchTimerRef = useRef(null)
      const performSearchRef = useRef(null)
      const nameSeqRef = useRef(0)
      const contentSeqRef = useRef(0)
      const recentFilesRef = useRef([])

      const [root, setRoot] = useState(() => readStoredRoot())
      const [showHidden, setShowHidden] = useState(() => readBool(HIDDEN_KEY, false))
      const [rootsInfo, setRootsInfo] = useState({ status: 'loading', data: null, error: null })
      const [pickerOpen, setPickerOpen] = useState(false)
      const [tree, setTree] = useState({})
      const [expanded, setExpanded] = useState(() => new Set())
      const [rowLimit, setRowLimit] = useState(TREE_ROW_LIMIT)
      const [search, setSearch] = useState(createUnifiedSearchState)
      const [recentFiles, setRecentFiles] = useState([])
      const [tabs, setTabs] = useState([])
      const [activeRel, setActiveRel] = useState(null)
      const [pendingClose, setPendingClose] = useState(null)
      const [pendingRoot, setPendingRoot] = useState(null)
      const [pendingReload, setPendingReload] = useState(null)
      const [toast, setToast] = useState(null)
      const [sidebarWidth, setSidebarWidth] = useState(() => readSidebarWidth())
      const sidebarDragRef = useRef(null)
      const onSidebarResizeStart = useCallback((event) => {
        event.preventDefault()
        const main = event.currentTarget === null ? null : event.currentTarget.parentElement
        const sidebar = main === null ? null : main.querySelector('.wbf-sidebar')
        if (sidebar === null) return
        const startX = event.clientX
        const startW = sidebar.getBoundingClientRect().width
        const maxW = Math.max(SIDEBAR_MIN_W, Math.min(SIDEBAR_MAX_W, Math.round(main.getBoundingClientRect().width * 0.62)))
        sidebarDragRef.current = { startX, startW, maxW }
        const onMove = (moveEvent) => {
          const drag = sidebarDragRef.current
          if (drag === null) return
          const next = Math.max(SIDEBAR_MIN_W, Math.min(drag.maxW, drag.startW + (moveEvent.clientX - drag.startX)))
          setSidebarWidth(Math.round(next))
        }
        const onUp = () => {
          sidebarDragRef.current = null
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          setSidebarWidth((value) => { if (value !== null) writeSidebarWidth(value); return value })
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
      }, [])

      rootRef.current = root
      showHiddenRef.current = showHidden
      tabsRef.current = tabs
      activeRelRef.current = activeRel
      treeRef.current = tree
      searchRef.current = search
      recentFilesRef.current = recentFiles

      const activeTab = useMemo(() => {
        for (let index = 0; index < tabs.length; index += 1) {
          if (tabs[index].rel === activeRel) return tabs[index]
        }
        return null
      }, [tabs, activeRel])

      const dirtyCount = useMemo(() => tabs.filter((tab) => tab.dirty === true).length, [tabs])

      const patchTab = useCallback((rel, action) => {
        setTabs((previous) => previous.map((tab) => (tab.rel === rel ? reduceTab(tab, action) : tab)))
      }, [])

      const showToast = useCallback((message, kind) => {
        setToast({ message, kind: kind === 'error' ? 'error' : 'ok' })
        if (toastTimerRef.current !== null) clearTimeout(toastTimerRef.current)
        toastTimerRef.current = setTimeout(() => setToast(null), 3500)
      }, [])


      useEffect(() => () => {
        if (toastTimerRef.current !== null) clearTimeout(toastTimerRef.current)
      }, [])

      /* ---- workspace roots -------------------------------------------------- */

      useEffect(() => {
        let cancelled = false
        setRootsInfo((previous) => ({ ...previous, status: 'loading' }))
        call('roots', {}).then((data) => {
          if (cancelled) return
          setRootsInfo({ status: 'ready', data, error: null })
        }).catch((error) => {
          if (cancelled) return
          setRootsInfo({ status: 'error', data: null, error: describeError(t, error) })
        })
        return () => { cancelled = true }
      }, [t])

      const applyRoot = useCallback((nextRoot) => {
        const value = normalizeRootPath(nextRoot)
        storeRoot(value)
        setRoot(value)
        setTabs([])
        setActiveRel(null)
        setSearch(createUnifiedSearchState())
        setRecentFiles([])
        if (searchAbortRef.current !== null) {
          try { searchAbortRef.current.abort() } catch (error) { void error }
          searchAbortRef.current = null
        }
        if (searchTimerRef.current !== null) {
          clearTimeout(searchTimerRef.current)
          searchTimerRef.current = null
        }
        nameSeqRef.current += 1
        contentSeqRef.current += 1
        setPendingRoot(null)
        setPendingClose(null)
        setPendingReload(null)
        setPickerOpen(false)
      }, [])

      const pickRoot = useCallback((nextRoot) => {
        const value = normalizeRootPath(nextRoot)
        if (value === '' || value === rootRef.current) {
          setPickerOpen(false)
          return
        }
        setPickerOpen(false)
        if (tabsRef.current.some((tab) => tab.dirty === true)) {
          setPendingRoot(value)
          return
        }
        applyRoot(value)
      }, [applyRoot])

      useEffect(() => {
        const onStorage = (event) => {
          if (event.key !== ROOT_KEY) return
          const next = parseStoredRoot(event.newValue)
          if (next === null || next === rootRef.current) return
          if (tabsRef.current.some((tab) => tab.dirty === true)) return
          applyRoot(next)
        }
        window.addEventListener('storage', onStorage)
        return () => window.removeEventListener('storage', onStorage)
      }, [applyRoot])

      /* ---- directory tree --------------------------------------------------- */

      const loadDir = useCallback(async (dirRel, options) => {
        const currentRoot = rootRef.current
        if (currentRoot === null || currentRoot === '') return
        const currentShowHidden = showHiddenRef.current
        const force = options !== null && options !== undefined && options.force === true
        const existing = treeRef.current[dirRel]
        if (!force && existing !== undefined && existing !== null && (existing.status === 'loading' || existing.status === 'ready')) return
        const token = (dirReqRef.current.get(dirRel) === undefined ? 0 : dirReqRef.current.get(dirRel)) + 1
        dirReqRef.current.set(dirRel, token)
        setTree((previous) => Object.assign({}, previous, {
          [dirRel]: {
            status: 'loading',
            error: null,
            entries: previous[dirRel] !== undefined && Array.isArray(previous[dirRel].entries) ? previous[dirRel].entries : [],
            truncated: false,
          },
        }))
        try {
          /* Measure "click the chevron -> rows are in state". The mark lands
             right before the setState that makes the rows renderable, which is
             the boundary docs/performance.md budgets in. One mark pair per
             directory load; the dir rel is the label so a slow directory is
             identifiable from the trace alone. */
          const markName = 'tree:' + (dirRel === '' ? '<root>' : dirRel)
          perfMark('tree-start')
          const data = await call('tree', { root: currentRoot, dir: dirRel, showHidden: currentShowHidden })
          if (rootRef.current !== currentRoot || showHiddenRef.current !== currentShowHidden || dirReqRef.current.get(dirRel) !== token) return
          perfMeasure(markName, 'tree-start')
          const entries = data !== null && data !== undefined && Array.isArray(data.entries) ? data.entries : []
          setTree((previous) => Object.assign({}, previous, {
            [dirRel]: { status: 'ready', entries, truncated: data !== null && data !== undefined && data.truncated === true, error: null },
          }))
        } catch (error) {
          if (rootRef.current !== currentRoot || showHiddenRef.current !== currentShowHidden || dirReqRef.current.get(dirRel) !== token) return
          setTree((previous) => Object.assign({}, previous, {
            [dirRel]: Object.assign({}, previous[dirRel] === undefined ? {} : previous[dirRel], {
              status: 'error',
              error: describeError(t, error),
              truncated: false,
            }),
          }))
        }
      }, [t])

      useEffect(() => {
        if (root === null || root === '') return
        const key = root + '\u0000' + (showHidden === true ? '1' : '0')
        if (treeKeyRef.current === key) return
        treeKeyRef.current = key
        treeRef.current = {}
        dirReqRef.current = new Map()
        setTree({})
        setExpanded(new Set())
        setRowLimit(TREE_ROW_LIMIT)
        void loadDir('')
      }, [root, showHidden, loadDir])

      const rows = useMemo(() => flattenTree(tree, expanded, { showHidden }), [tree, expanded, showHidden])

      const toggleDir = useCallback((rel) => {
        const isExpanded = expanded.has(rel)
        if (isExpanded) {
          setExpanded((previous) => {
            const next = new Set(previous)
            next.delete(rel)
            return next
          })
          return
        }
        setExpanded((previous) => {
          const next = new Set(previous)
          next.add(rel)
          return next
        })
        const node = treeRef.current[rel]
        if (node === undefined || node === null || node.status === 'error') void loadDir(rel)
      }, [expanded, loadDir])

      const retryDir = useCallback((rel) => {
        void loadDir(rel, { force: true })
      }, [loadDir])

      const toggleHidden = useCallback(() => {
        setShowHidden((previous) => {
          const next = previous !== true
          writeBool(HIDDEN_KEY, next)
          return next
        })
      }, [])

      const refreshTree = useCallback(() => {
        if (rootRef.current === null || rootRef.current === '') return
        const loaded = Object.keys(treeRef.current)
        void loadDir('', { force: true })
        for (let index = 0; index < loaded.length; index += 1) {
          if (loaded[index] !== '') void loadDir(loaded[index], { force: true })
        }
        if (searchAbortRef.current !== null) {
          try { searchAbortRef.current.abort() } catch (error) { void error }
          searchAbortRef.current = null
        }
        nameSeqRef.current += 1
        contentSeqRef.current += 1
        setSearch((previous) => reduceUnifiedSearchState(previous, { type: 'invalidate' }))
        showToast(t('toast.refreshed'), 'ok')
      }, [loadDir, showToast, t])

      /* ---- unified search -------------------------------------------------- */

      const updateSearch = useCallback((action) => {
        setSearch((previous) => reduceUnifiedSearchState(previous, action))
      }, [])

      const recordRecentFile = useCallback((rel) => {
        const clean = normalizeRel(rel)
        if (clean === '') return
        setRecentFiles((previous) => {
          const next = normalizeRecentList([clean].concat(previous))
          if (next.length === previous.length && next.every((entry, index) => entry === previous[index])) return previous
          return next
        })
      }, [])

      const performSearch = useCallback(() => {
        const state = searchRef.current
        const currentRoot = rootRef.current
        const query = state.query.trim()
        if (currentRoot === null || currentRoot === '' || query === '') return
        if (state.mode === 'name') {
          nameSeqRef.current += 1
          const seq = nameSeqRef.current
          const request = buildNameSearchRequest(currentRoot, state.query)
          if (request === null) return
          updateSearch({ type: 'name', action: { type: 'request', seq }, query: state.query })
          call('search', request).then((data) => {
            if (seq !== nameSeqRef.current) return
            updateSearch({
              type: 'name',
              action: {
                type: 'response',
                seq,
                matches: normalizeNameSearchEntries(data),
                truncated: data !== null && data !== undefined && data.truncated === true,
              },
              query: state.query,
            })
          }).catch((error) => {
            if (seq !== nameSeqRef.current) return
            updateSearch({ type: 'name', action: { type: 'error', seq, message: describeError(t, error) }, query: state.query })
          })
          return
        }

        if (searchAbortRef.current !== null) {
          try { searchAbortRef.current.abort() } catch (error) { void error }
        }
        const controller = typeof AbortController === 'function' ? new AbortController() : null
        searchAbortRef.current = controller
        const request = buildSearchRequest(
          Object.assign({}, state.content, { query: state.query, mode: 'content' }),
          currentRoot,
        )
        if (request === null) return
        contentSeqRef.current += 1
        const seq = contentSeqRef.current
        updateSearch({ type: 'content', action: { type: 'request', seq }, query: state.query })
        /* Budget: content search, from request to results renderable. The
           "first page" concern in the perf spec is not measurable yet because
           the host still answers with one POST; when it becomes a stream, this
           mark should move to the first batch. */
        perfMark('search-content-start')
        call('search', request, controller === null ? undefined : controller.signal).then((data) => {
          if (seq !== contentSeqRef.current) return
          perfMeasure('search:content', 'search-content-start')
          updateSearch({
            type: 'content',
            action: { type: 'response', seq, data: normalizeSearchResponse(data, 'content', state.query) },
            query: state.query,
          })
        }).catch((error) => {
          if (seq !== contentSeqRef.current || isAbortError(error)) return
          updateSearch({
            type: 'content',
            action: { type: 'error', seq, message: describeError(t, error) },
            query: state.query,
          })
        }).then(() => {
          if (searchAbortRef.current === controller) searchAbortRef.current = null
        })
      }, [t, updateSearch])
      performSearchRef.current = performSearch

      const stopContentSearch = useCallback(() => {
        if (searchTimerRef.current !== null) {
          clearTimeout(searchTimerRef.current)
          searchTimerRef.current = null
        }
        if (searchAbortRef.current !== null) {
          try { searchAbortRef.current.abort() } catch (error) { void error }
          searchAbortRef.current = null
        }
        contentSeqRef.current += 1
        nameSeqRef.current += 1
      }, [])

      const runSearchNow = useCallback(() => {
        if (searchTimerRef.current !== null) {
          clearTimeout(searchTimerRef.current)
          searchTimerRef.current = null
        }
        if (performSearchRef.current !== null) performSearchRef.current()
      }, [])

      const handleSearchQuery = useCallback((value) => {
        if (value === searchRef.current.query) return
        stopContentSearch()
        updateSearch({ type: 'query', query: value })
      }, [stopContentSearch, updateSearch])

      const handleSearchMode = useCallback((mode) => {
        updateSearch({ type: 'mode', mode })
      }, [updateSearch])

      const clearSearch = useCallback(() => {
        stopContentSearch()
        updateSearch({ type: 'escape' })
      }, [stopContentSearch, updateSearch])

      const cancelContentSearch = useCallback(() => {
        stopContentSearch()
        updateSearch({
          type: 'content',
          action: { type: 'cancel', seq: contentSeqRef.current },
          query: searchRef.current.query,
        })
      }, [stopContentSearch, updateSearch])

      const toggleSearchFlag = useCallback((flag) => {
        stopContentSearch()
        updateSearch({ type: 'content', action: { type: 'flag', flag } })
      }, [stopContentSearch, updateSearch])

      const changeSearchGlob = useCallback((field, value) => {
        stopContentSearch()
        updateSearch({ type: 'content', action: { type: 'glob', field, value } })
      }, [stopContentSearch, updateSearch])

      const toggleSearchGlobField = useCallback((field) => {
        updateSearch({ type: 'content', action: { type: 'globOpen', field } })
      }, [updateSearch])

      const collapseContentFile = useCallback((rel) => {
        updateSearch({ type: 'content', action: { type: 'collapse', rel } })
      }, [updateSearch])

      const contentRowsOf = useCallback((state) => {
        if (state.mode !== 'content') return []
        const content = state.content
        const data = content.query === state.query ? content.data : null
        return flattenSearchResults(data, content.collapsed)
      }, [])

      /* Per-mode debounce (200 ms name, 300 ms content). A cached result set is
         reused when the query and options have not changed; per-mode sequence
         refs make any late response harmless. */
      useEffect(() => {
        const query = search.query.trim()
        if (root === null || root === '' || query === '') return undefined
        const cache = search.mode === 'content' ? search.content : search.name
        if (cache.query === search.query && (cache.status === 'ready' || cache.status === 'error' || cache.status === 'loading' || cache.status === 'idle')) {
          return undefined
        }
        if (searchTimerRef.current !== null) {
          clearTimeout(searchTimerRef.current)
          searchTimerRef.current = null
        }
        const delay = search.mode === 'content' ? SEARCH_PANEL_DEBOUNCE_MS : SEARCH_DEBOUNCE_MS
        searchTimerRef.current = setTimeout(() => {
          searchTimerRef.current = null
          if (performSearchRef.current !== null) performSearchRef.current()
        }, delay)
        return () => {
          if (searchTimerRef.current !== null) {
            clearTimeout(searchTimerRef.current)
            searchTimerRef.current = null
          }
        }
      }, [
        search.query, search.mode, search.revision,
        search.content.caseSensitive, search.content.wholeWord, search.content.regex,
        search.content.include, search.content.exclude, root,
      ])

      useEffect(() => () => {
        if (searchTimerRef.current !== null) clearTimeout(searchTimerRef.current)
        searchTimerRef.current = null
        if (searchAbortRef.current !== null) {
          try { searchAbortRef.current.abort() } catch (error) { void error }
          searchAbortRef.current = null
        }
      }, [])

      /* ---- tabs / files ----------------------------------------------------- */

      const hydrateTab = useCallback(async (tab, entry) => {
        const currentRoot = rootRef.current
        if (currentRoot === null || currentRoot === '') return
        /* Budget: "click a file -> editor is interactive" (p95 < 350 ms for
           100 KiB). Labelled by extension so the trace separates .ts from .png
           without needing the filename. */
        const extension = extensionOf(tab.rel) === '' ? 'none' : extensionOf(tab.rel)
        perfMark('file-open-start')
        try {
          if (isReadableKind(tab.kind)) {
            const data = await call('read', { root: currentRoot, rel: tab.rel })
            if (rootRef.current !== currentRoot) return
            perfMeasure('file-open:' + extension, 'file-open-start')
            if (data !== null && data !== undefined && data.encoding === 'binary') {
              patchTab(tab.rel, {
                type: 'loaded',
                kind: 'binary',
                content: '',
                mtimeMs: data.mtimeMs,
                size: data.size,
                encoding: 'binary',
              })
              return
            }
            patchTab(tab.rel, {
              type: 'loaded',
              kind: tab.kind === 'unknown' ? 'text' : tab.kind,
              content: data !== null && data !== undefined && typeof data.content === 'string' ? data.content : '',
              mtimeMs: data !== null && data !== undefined ? data.mtimeMs : tab.mtimeMs,
              size: data !== null && data !== undefined ? data.size : tab.size,
              truncated: data !== null && data !== undefined && data.truncated === true,
              encoding: data !== null && data !== undefined && typeof data.encoding === 'string' ? data.encoding : 'utf8',
            })
            return
          }
          let meta = { mtimeMs: tab.mtimeMs, size: tab.size }
          try {
            const statData = await call('stat', { root: currentRoot, rel: tab.rel })
            if (rootRef.current !== currentRoot) return
            if (statData !== null && statData !== undefined && statData.entry !== null && statData.entry !== undefined) meta = statData.entry
          } catch (error) { void error }
          patchTab(tab.rel, {
            type: 'loaded',
            content: '',
            mtimeMs: meta.mtimeMs,
            size: meta.size,
          })
        } catch (error) {
          if (rootRef.current !== currentRoot) return
          patchTab(tab.rel, { type: 'failed', message: describeError(t, error) })
        }
      }, [patchTab, t])

      const openEntry = useCallback((entry, options) => {
        if (entry === null || entry === undefined) return
        if (rootRef.current === null || rootRef.current === '') return
        const opts = options !== null && options !== undefined ? options : {}
        const line = typeof opts.line === 'number' && Number.isFinite(opts.line) && opts.line > 0 ? Math.floor(opts.line) : 0
        const fromSearch = opts.fromSearch === true
        const rel = normalizeRel(typeof entry.rel === 'string' && entry.rel !== '' ? entry.rel : entry.name)
        if (rel === '') return
        recordRecentFile(rel)
        const existing = tabsRef.current.find((tab) => tab.rel === rel)
        if (existing !== undefined) {
          setActiveRel(rel)
          if (line > 0) {
            /* Remount the editor at the requested line without losing the
               current buffer: content comes from tab.content / valueRef. */
            patchTab(rel, {
              type: 'jump',
              line,
              lineToken: (existing.lineToken || 0) + 1,
              editing: fromSearch && (existing.kind === 'markdown' || existing.kind === 'json') ? true : undefined,
            })
          }
          return
        }
        const name = typeof entry.name === 'string' && entry.name !== '' ? entry.name : baseNameOfRel(rel)
        const kind = classifyFile(name)
        const tab = {
          rel,
          name,
          kind,
          language: languageOf(name),
          status: 'loading',
          error: null,
          content: '',
          savedContent: '',
          dirty: false,
          saving: false,
          editing: fromSearch && (kind === 'markdown' || kind === 'json'),
          conflict: false,
          externalMtimeMs: null,
          mtimeMs: typeof entry.mtimeMs === 'number' ? entry.mtimeMs : 0,
          size: typeof entry.size === 'number' ? entry.size : 0,
          truncated: false,
          encoding: 'utf8',
          mediaTick: 0,
          line,
          lineToken: line > 0 ? 1 : 0,
        }
        setTabs((previous) => previous.concat([tab]))
        setActiveRel(rel)
        void hydrateTab(tab, entry)
      }, [hydrateTab, patchTab, recordRecentFile])

      const activateTab = useCallback((rel) => {
        recordRecentFile(rel)
        setActiveRel(rel)
      }, [recordRecentFile])

      const closeTab = useCallback((rel) => {
        const current = tabsRef.current
        const index = current.findIndex((tab) => tab.rel === rel)
        const next = current.filter((tab) => tab.rel !== rel)
        setTabs(next)
        if (activeRelRef.current === rel) {
          if (next.length === 0) setActiveRel(null)
          else setActiveRel(next[Math.min(index < 0 ? 0 : index, next.length - 1)].rel)
        }
        setPendingClose(null)
      }, [])

      const requestClose = useCallback((rel) => {
        const tab = tabsRef.current.find((entry) => entry.rel === rel)
        if (tab === undefined) return
        if (tab.dirty === true) {
          setPendingClose(rel)
          return
        }
        closeTab(rel)
      }, [closeTab])

      const saveInFlightRef = useRef(new Map())

      const saveTab = useCallback((rel, options) => {
        const opts = options !== null && options !== undefined ? options : {}
        const tab = tabsRef.current.find((entry) => entry.rel === rel)
        if (tab === undefined) return Promise.resolve(false)
        if (tab.status !== 'ready') return Promise.resolve(false)
        if (tab.truncated === true) return Promise.resolve(false)
        if (tab.dirty !== true && opts.force !== true) return Promise.resolve(true)
        if (saveInFlightRef.current.has(rel)) return saveInFlightRef.current.get(rel)
        const currentRoot = rootRef.current
        const content = tab.content
        patchTab(rel, { type: 'saving', value: true })
        /* Budget: "Ctrl+S -> saved toast" (p95 < 500 ms). */
        perfMark('save-start')
        const task = (async () => {
          try {
            const payload = { root: currentRoot, rel: tab.rel, content }
            if (opts.force !== true && tab.mtimeMs > 0) payload.baseMtimeMs = tab.mtimeMs
            const data = await call('write', payload)
            perfMeasure('save', 'save-start')
            patchTab(rel, {
              type: 'saved',
              savedContent: content,
              mtimeMs: data !== null && data !== undefined ? data.mtimeMs : tab.mtimeMs,
              size: data !== null && data !== undefined ? data.size : content.length,
            })
            showToast(t('toast.saved', { name: tab.name }), 'ok')
            return true
          } catch (error) {
            if (error !== null && error !== undefined && error.code === 'conflict') {
              patchTab(rel, { type: 'conflict', value: true })
              showToast(t('toast.conflict', { name: tab.name }), 'error')
            } else {
              patchTab(rel, { type: 'saving', value: false })
              showToast(describeError(t, error), 'error')
            }
            return false
          } finally {
            saveInFlightRef.current.delete(rel)
          }
        })()
        saveInFlightRef.current.set(rel, task)
        return task
      }, [patchTab, showToast, t])

      const reloadTab = useCallback(async (rel) => {
        const tab = tabsRef.current.find((entry) => entry.rel === rel)
        if (tab === undefined) return
        const currentRoot = rootRef.current
        patchTab(rel, { type: 'reloading' })
        try {
          if (isReadableKind(tab.kind)) {
            const data = await call('read', { root: currentRoot, rel: tab.rel })
            if (rootRef.current !== currentRoot) return
            if (data !== null && data !== undefined && data.encoding === 'binary') {
              patchTab(rel, { type: 'loaded', kind: 'binary', content: '', mtimeMs: data.mtimeMs, size: data.size, encoding: 'binary' })
              return
            }
            patchTab(rel, {
              type: 'loaded',
              kind: tab.kind === 'unknown' ? 'text' : tab.kind,
              content: data !== null && data !== undefined && typeof data.content === 'string' ? data.content : '',
              mtimeMs: data !== null && data !== undefined ? data.mtimeMs : tab.mtimeMs,
              size: data !== null && data !== undefined ? data.size : tab.size,
              truncated: data !== null && data !== undefined && data.truncated === true,
              encoding: data !== null && data !== undefined && typeof data.encoding === 'string' ? data.encoding : 'utf8',
            })
            return
          }
          let meta = { mtimeMs: tab.mtimeMs, size: tab.size }
          try {
            const statData = await call('stat', { root: currentRoot, rel: tab.rel })
            if (rootRef.current !== currentRoot) return
            if (statData !== null && statData !== undefined && statData.entry !== null && statData.entry !== undefined) meta = statData.entry
          } catch (error) { void error }
          patchTab(rel, {
            type: 'loaded',
            content: '',
            mtimeMs: meta.mtimeMs,
            size: meta.size,
            mediaTick: Date.now(),
          })
        } catch (error) {
          if (rootRef.current !== currentRoot) return
          patchTab(rel, { type: 'failed', message: describeError(t, error) })
        }
      }, [patchTab, t])

      const requestReload = useCallback((rel) => {
        const tab = tabsRef.current.find((entry) => entry.rel === rel)
        if (tab === undefined) return
        if (tab.dirty === true) {
          setPendingReload(rel)
          return
        }
        void reloadTab(rel)
      }, [reloadTab])

      const toggleEdit = useCallback((rel) => {
        const tab = tabsRef.current.find((entry) => entry.rel === rel)
        if (tab === undefined) return
        patchTab(rel, { type: 'editing', value: tab.editing !== true })
      }, [patchTab])

      const revertTab = useCallback((rel) => {
        const tab = tabsRef.current.find((entry) => entry.rel === rel)
        if (tab === undefined) return
        patchTab(rel, { type: 'content', content: tab.savedContent })
      }, [patchTab])

      /* Reopen a path found through search: reveal its ancestors in the tree. */
      const revealRel = useCallback((rel) => {
        const dirs = ancestorDirsOf(rel)
        for (let index = 0; index < dirs.length; index += 1) {
          const dir = dirs[index]
          if (treeRef.current[dir] === undefined) void loadDir(dir)
        }
        setExpanded((previous) => {
          const next = new Set(previous)
          for (let index = 0; index < dirs.length; index += 1) next.add(dirs[index])
          return next
        })
      }, [loadDir])

      const openSearchResult = useCallback((entry) => {
        if (entry === null || entry === undefined) return
        if (entry.type === 'dir') {
          revealRel(normalizeRel(entry.rel))
          return
        }
        openEntry(entry)
      }, [openEntry, revealRel])

      const openSearchRow = useCallback((row) => {
        if (row === null || row === undefined || typeof row.rel !== 'string' || row.rel === '') return
        const line = Number.isFinite(row.line) && row.line > 0 ? Math.floor(row.line) : 1
        openEntry(
          { rel: row.rel, name: row.name, size: row.size, mtimeMs: row.mtimeMs },
          { line, fromSearch: true },
        )
      }, [openEntry])

      const handleSearchKeyDown = useCallback((event) => {
        if (event === null || event === undefined) return
        const state = searchRef.current
        const key = event.key
        if (key === 'Escape') {
          event.preventDefault()
          clearSearch()
          return
        }
        if (key === 'ArrowDown' || key === 'ArrowUp') {
          const delta = key === 'ArrowDown' ? 1 : -1
          event.preventDefault()
          if (state.mode === 'name') {
            if (state.name.query !== state.query || state.name.status !== 'ready') return
            const next = moveSearchFocus(state.name.focusIndex, state.name.matches.length, delta)
            updateSearch({ type: 'name', action: { type: 'focus', index: next } })
          } else {
            const rows = contentRowsOf(state)
            const next = moveSearchFocus(state.content.focusIndex, rows.length, delta)
            updateSearch({ type: 'content', action: { type: 'focus', index: next } })
          }
          return
        }
        if (key !== 'Enter') return
        event.preventDefault()
        if (state.mode === 'name') {
          if (state.name.query !== state.query || state.name.status !== 'ready') {
            runSearchNow()
            return
          }
          const ordered = orderRecentFirst(state.name.matches, recentFilesRef.current)
          const index = state.name.focusIndex >= 0 && state.name.focusIndex < ordered.length ? state.name.focusIndex : 0
          const entry = ordered[index]
          if (entry !== undefined) openSearchResult(entry)
          return
        }
        const rows = contentRowsOf(state)
        const index = state.content.focusIndex
        if (index >= 0 && index < rows.length) {
          if (rows[index].kind === 'match') openSearchRow(rows[index])
          else collapseContentFile(rows[index].rel)
          return
        }
        runSearchNow()
      }, [clearSearch, collapseContentFile, contentRowsOf, openSearchResult, openSearchRow, runSearchNow, updateSearch])

      const handleContentChange = useCallback((rel, text) => {
        patchTab(rel, { type: 'content', content: text })
      }, [patchTab])

      const editAndSave = useCallback((rel) => {
        const tab = tabsRef.current.find((entry) => entry.rel === rel)
        if (tab === undefined) return
        if (tab.editing !== true) patchTab(rel, { type: 'editing', value: true })
      }, [patchTab])

      /* ---- live "modified on disk" badge: selected file only ---------------- */

      const activeMtime = activeTab === null ? 0 : activeTab.mtimeMs
      useEffect(() => {
        if (root === null || activeRel === null || activeMtime <= 0) return undefined
        let cancelled = false
        const check = () => {
          /* A hidden window (minimised, or the user switched app) cannot show a
             badge, so polling it is pure waste — and this poll survives for as
             long as a file is open. Skip the RPC while hidden; the interval keeps
             ticking (cheap) so the badge is fresh within one interval of the
             window coming back, instead of needing a visibility listener plus a
             restart dance. */
          if (typeof document !== 'undefined' && document !== null && document.visibilityState === 'hidden') return
          call('stat', { root, rel: activeRel }).then((data) => {
            if (cancelled) return
            const entry = data !== null && data !== undefined ? data.entry : null
            const mtimeMs = entry !== null && entry !== undefined ? entry.mtimeMs : undefined
            if (typeof mtimeMs === 'number' && mtimeMs !== activeMtime) patchTab(activeRel, { type: 'external', mtimeMs })
          }).catch(() => {})
        }
        const timer = setInterval(check, statIntervalMs())
        return () => {
          cancelled = true
          clearInterval(timer)
        }
      }, [root, activeRel, activeMtime, patchTab])

      /* ---- global save shortcut (editor's own binding is deduped by saveTab) -- */

      const latestRef = useRef({})
      latestRef.current = { activeRel, saveTab }
      useEffect(() => {
        const onKey = (event) => {
          if (!(event.ctrlKey === true || event.metaKey === true)) return
          const key = String(event.key).toLowerCase()
          if (key !== 's') return
          const rel = latestRef.current.activeRel
          if (rel === null) return
          /* Ctrl+S must only mean "save the file" when the FILE is what has
             focus. Stealing it unconditionally is wrong twice over:
               - this listener is on `window`, so it fires while the caret is in
                 any other field (a commit message, a search box, a rename
                 dialog) and would save/overwrite the open file instead of
                 letting the browser/field handle the key;
               - once this page shares a screen with a Git pane, the commit box
                 is a sibling, not a child, so "inside my own page" is not a
                 reliable test either.
             The rule: fire only when the active element is the editor surface
             or nothing focusable at all (the document body), which is the state
             the page is in right after clicking the file. */
          const active = typeof document !== 'undefined' && document !== null ? document.activeElement : null
          if (active !== null && active !== undefined && active !== document.body) {
            const tag = typeof active.tagName === 'string' ? active.tagName.toUpperCase() : ''
            const isTextEntry = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
              || active.isContentEditable === true
            const insideEditor = typeof active.closest === 'function' && active.closest('.cm-editor') !== null
            /* Inside CodeMirror, let the editor's own Ctrl+S binding do the work
               (it is deduped by saveTab). Inside any other text field, do not
               save at all — the user is typing something else. */
            if (insideEditor === true) return
            if (isTextEntry === true) return
          }
          event.preventDefault()
          void latestRef.current.saveTab(rel)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [])

      /* ---- render ----------------------------------------------------------- */

      const pageBody = (() => {
        if (activeTab === null) {
          return E(ViewerEmpty, { t, hasRoot: root !== null && root !== '', onChoose: () => setPickerOpen(true) })
        }
        if (activeTab.status === 'loading') {
          return E('div', { className: 'wbf-emptyView' },
            E('div', { className: 'wbf-spinner' }),
            E('div', { className: 'wbf-emptyHint' }, t('file.loading')))
        }
        if (activeTab.status === 'error') {
          return E('div', { className: 'wbf-emptyView' },
            E(Icon, { name: 'warning', size: 32 }),
            E('div', { className: 'wbf-emptyTitle' }, t('file.readError')),
            E('div', { className: 'wbf-emptyHint' }, activeTab.error),
            E('div', null, E(TextButton, { primary: true, onClick: () => { void reloadTab(activeTab.rel) } }, t('file.retry'))))
        }
        const src = mediaUrl(root, activeTab.rel, activeTab.mediaTick)
        return E(Viewer, {
          tab: activeTab,
          t,
          editing: activeTab.editing === true,
          src,
          onChange: (text) => handleContentChange(activeTab.rel, text),
          onSave: () => { void saveTab(activeTab.rel) },
        })
      })()

      const dirtyRootDialog = pendingRoot === null ? null : E(ConfirmDialog, {
        title: t('dialog.switchTitle'),
        body: t('dialog.switchBody', { n: dirtyCount }),
        confirmLabel: t('dialog.discardSwitch'),
        cancelLabel: t('dialog.cancel'),
        danger: true,
        onConfirm: () => applyRoot(pendingRoot),
        onCancel: () => setPendingRoot(null),
      })

      const pendingCloseTab = pendingClose === null ? null : tabs.find((tab) => tab.rel === pendingClose)
      const unsavedDialog = pendingCloseTab === undefined || pendingCloseTab === null ? null : E(UnsavedDialog, {
        t,
        tab: pendingCloseTab,
        onCancel: () => setPendingClose(null),
        onDiscard: () => closeTab(pendingCloseTab.rel),
        onSaveAndClose: () => {
          void saveTab(pendingCloseTab.rel).then((saved) => {
            if (saved !== true) return
            const current = tabsRef.current.find((tab) => tab.rel === pendingCloseTab.rel)
            if (current !== undefined && current.dirty === true) return
            closeTab(pendingCloseTab.rel)
          })
        },
      })

      const reloadDialog = pendingReload === null ? null : E(ConfirmDialog, {
        title: t('dialog.reloadTitle'),
        body: t('dialog.reloadBody'),
        confirmLabel: t('dialog.reloadConfirm'),
        cancelLabel: t('dialog.cancel'),
        danger: true,
        onConfirm: () => {
          const rel = pendingReload
          setPendingReload(null)
          void reloadTab(rel)
        },
        onCancel: () => setPendingReload(null),
      })

      return E('div', { className: 'wbf-root' },
        E('div', { className: 'wbf-main' },
          E('div', {
            className: 'wbf-sidebar',
            style: sidebarWidth === null ? undefined : { width: sidebarWidth + 'px', minWidth: SIDEBAR_MIN_W + 'px' },
          },
            E('div', { className: 'wbf-sidebarHead' },
              E('button', {
                type: 'button',
                className: 'wbf-rootChip',
                title: root === null ? t('root.choose') : root,
                onClick: () => setPickerOpen(true),
              },
              E(Icon, { name: 'folder', size: 14 }),
              E('span', { className: 'wbf-rootName' }, root === null || root === '' ? t('root.choose') : workspaceNameOf(root)),
              E(Icon, { name: 'chevronDown', size: 11 }))),
            E(TreePanel, {
              t,
              root,
              tree,
              rows,
              rowLimit,
              showHidden,
              search,
              recentFiles,
              activeRel,
              onQueryChange: handleSearchQuery,
              onModeChange: handleSearchMode,
              onSearchKeyDown: handleSearchKeyDown,
              onToggleFlag: toggleSearchFlag,
              onGlobChange: changeSearchGlob,
              onToggleGlobOpen: toggleSearchGlobField,
              onCollapse: collapseContentFile,
              onCancel: cancelContentSearch,
              onOpenQuickResult: openSearchResult,
              onOpenContentRow: openSearchRow,
              onClearSearch: clearSearch,
              onToggleHidden: toggleHidden,
              onRefresh: refreshTree,
              onToggleDir: toggleDir,
              onOpenFile: openEntry,
              onRetryDir: retryDir,
              onShowMore: () => setRowLimit((value) => value + TREE_ROW_LIMIT),
            })),
          E('div', {
            className: 'wbf-sidebarGrip',
            title: t('tree.resizeWidth'),
            'aria-label': t('tree.resizeWidth'),
            onPointerDown: onSidebarResizeStart,
          }),
          E('div', { className: 'wbf-content' },
            E(TabStrip, {
              t,
              tabs,
              activeRel,
              onActivate: activateTab,
              onClose: requestClose,
            }),
            activeTab === null ? null : E(FileHeader, {
              t,
              tab: activeTab,
              editing: activeTab.editing === true,
              onToggleEdit: () => toggleEdit(activeTab.rel),
              onSave: () => { void saveTab(activeTab.rel) },
              onReload: () => requestReload(activeTab.rel),
              onClose: () => requestClose(activeTab.rel),
              onRevert: () => revertTab(activeTab.rel),
            }),
            activeTab !== null && activeTab.conflict === true
              ? E(ConflictBar, {
                t,
                tab: activeTab,
                onReload: () => requestReload(activeTab.rel),
                onOverwrite: () => { void saveTab(activeTab.rel, { force: true }) },
              })
              : null,
            E('div', { className: 'wbf-viewer' }, pageBody))),
        pickerOpen
          ? E(RootPicker, {
            t,
            open: pickerOpen,
            current: root,
            rootsInfo,
            onClose: () => setPickerOpen(false),
            onPick: pickRoot,
          })
          : null,
        dirtyRootDialog,
        unsavedDialog,
        reloadDialog,
        toast === null ? null : E('div', { className: 'wbf-toast is-' + toast.kind }, toast.message))
    }

/**
 * SourcePane: a self-contained editor surface that a HOST page can mount.
 *
 * This is the piece the source-control page composes instead of duplicating the
 * file page's UI. It is deliberately not the file page: no tree, no search, no
 * root picker — just "show this file, let the user edit and save it". The tree
 * belongs to the host, because the host is the only thing that also knows git
 * status, and one tree with status beats two trees that disagree.
 *
 * It owns its own state, so it is a real failure domain: if this crashes, the
 * host's tree and commit box are still on screen.
 *
 * Contract (see docs/panes-contract.md):
 *   mountSourcePane(container, api, ctx, t) -> dispose
 *     api.activeRel   workspace-relative path the host wants shown (may be null)
 *     api.visible     false when the host has it hidden; pause work when false
 */

/**
 * Mount the editor surface into a container the CALLER owns.
 *
 * Returns a dispose function. The caller must not re-use the container after
 * disposing without mounting again.
 */
function mountSourcePane(container, api, ctx, t) {
  /* The contract returns `{ dispose, handle }`: the HOST needs to unmount it on
     teardown, and the page's own `commands` need the handle to steer it. Returning
     a bare dispose function would have forced the page to keep a module-level ref
     just to answer `hasDirty` — one pane, one owner. */
  const noop = { dispose: () => {}, handle: { openFile() {}, hasDirty() { return false }, reload() {} } }
  if (container === null || container === undefined) return noop
  /* Try BOTH module names, exactly like the dock does: the seed table has
     offered `react-dom/client` since React 18, and some builds only expose the
     legacy entry. Getting this wrong means a silently blank editor. */
  const client = (() => {
    for (const specifier of ['react-dom/client', 'react-dom']) {
      let mod = null
      try { mod = require(specifier) } catch (error) { void error; continue }
      if (mod !== null && mod !== undefined && typeof mod.createRoot === 'function') return mod
      if (mod !== null && mod !== undefined && mod.default !== undefined && typeof mod.default.createRoot === 'function') return mod.default
    }
    return null
  })()
  if (client === null || typeof client.createRoot !== 'function') {
    /* No react-dom: degrade to a message rather than throwing inside the host's
       effect, which would take out the whole page. */
    container.textContent = t('file.editorUnavailable', { message: 'react-dom' })
    return { dispose: () => { container.textContent = '' }, handle: noop.handle }
  }

  const root = client.createRoot(container)
  const runtime = { openFile: null, hasDirty: null, reload: null, jump: null, pendingOpen: null, pendingJump: null }
  /**
   * A call that arrives before this pane's React tree has installed the
   * imperative surface must NOT be dropped.
   *
   * The host's first click both selects a file and mounts this pane; the install
   * effect runs a frame later. Dropping the call left the editor on its "pick a
   * file" empty state with no error — the user saw it as "clicking does nothing".
   * Buffer the latest request (latest wins) and replay it on install.
   */
  const handle = {
    openFile: (rel) => {
      if (runtime.openFile !== null) { runtime.openFile(rel); return }
      runtime.pendingOpen = rel
    },
    hasDirty: (rel) => (runtime.hasDirty === null ? false : runtime.hasDirty(rel) === true),
    reload: (rel) => { if (runtime.reload !== null) runtime.reload(rel) },
    /* 打开并定位到某一行：搜索结果直接跳到对应位置，而不是从头看起。 */
    jump: (rel, line) => {
      if (runtime.jump !== null) { runtime.jump(rel, line); return }
      runtime.pendingJump = { rel, line }
    },
  }

  function PaneHost() {
    const [state, setState] = useState(() => ({
      rel: null,
      tab: null,
      editing: false,
      error: null,
      status: 'idle',
    }))
    const rootRef = useRef(null)
    const tabsRef = useRef([])

    /* ---- the imperative surface the host calls ---- */
    useEffect(() => {
      runtime.openFile = (rel) => {
        const target = normalizeRel(rel)
        if (target === '') return
        setState((previous) => (previous.rel === target ? previous : Object.assign({}, previous, { rel: target, status: 'loading', error: null })))
      }
      runtime.reload = (rel) => {
        setState((previous) => (previous.rel === normalizeRel(rel) ? Object.assign({}, previous, { status: 'loading', error: null }) : previous))
      }
      /* 定位到某一行：同一文件就地把行号推给编辑器（lineToken 变化触发重新滚动），
         不同文件则先打开，行号记在 pendingLine 里等加载完成后再应用。 */
      runtime.jump = (rel, line) => {
        const target = normalizeRel(rel)
        const n = Number(line) || 0
        setState((previous) => {
          if (previous.rel !== target) {
            return Object.assign({}, previous, { rel: target, status: 'loading', error: null, pendingLine: n })
          }
          if (previous.tab === null) return Object.assign({}, previous, { pendingLine: n })
          return Object.assign({}, previous, {
            tab: Object.assign({}, previous.tab, { line: n, lineToken: (previous.tab.lineToken || 0) + 1 }),
          })
        })
      }
      runtime.hasDirty = (rel) => {
        const target = normalizeRel(rel)
        const found = tabsRef.current.find((entry) => entry.rel === target)
        return found !== undefined && found.dirty === true
      }
      /* Replay whatever the host asked for before we were ready. A jump must
         win over openFile: it carries the search-hit line. Leaking pendingJump
         was why the first content-search click opened the file at line 1. */
      if (runtime.pendingJump !== null) {
        const buffered = runtime.pendingJump
        runtime.pendingJump = null
        runtime.pendingOpen = null
        runtime.jump(buffered.rel, buffered.line)
      } else if (runtime.pendingOpen !== null) {
        const buffered = runtime.pendingOpen
        runtime.pendingOpen = null
        runtime.openFile(buffered)
      }
      return () => {
        runtime.openFile = null
        runtime.reload = null
        runtime.hasDirty = null
        runtime.jump = null
        runtime.pendingJump = null
      }
    }, [])

    /* The host may push a file before this pane even mounts. */
    useEffect(() => {
      const suggested = api !== null && api !== undefined && typeof api.activeRel === 'string' ? normalizeRel(api.activeRel) : ''
      if (suggested !== '') runtime.openFile(suggested)
      /* eslint-disable-next-line react-hooks/exhaustive-deps */
    }, [])

    /* Host pushes a new file whenever the user picks one in the tree. */
    useEffect(() => {
      const rel = api !== null && api !== undefined && typeof api.activeRel === 'string' ? normalizeRel(api.activeRel) : ''
      if (rel !== '') runtime.openFile(rel)
    }, [api === null || api === undefined ? null : api.activeRel])

    /* ---- load the file ---- */
    /* Read the workspace root the same way the page does. `readStoredRoot` is
       this bundle's own helper (the shell has a different one); reaching for the
       shell's would be a ReferenceError at runtime, which is exactly what the
       first end-to-end run caught. */
    const workspaceRoot = useMemo(() => {
      const stored = readStoredRoot()
      return stored === null || stored === undefined ? '' : stored
    }, [])

    useEffect(() => {
      const rel = state.rel
      if (rel === null || workspaceRoot === '') return undefined
      if (state.status !== 'loading') return undefined
      let cancelled = false
      const kind = classifyFile(rel)
      const run = async () => {
        try {
          if (isReadableKind(kind)) {
            const data = await call('read', { root: workspaceRoot, rel })
            if (cancelled) return
            const content = typeof data.content === 'string' ? data.content : ''
            setState((previous) => Object.assign({}, previous, {
              status: 'ready',
              error: null,
              tab: {
                rel,
                name: baseNameOfRel(rel),
                kind: data.encoding === 'binary' ? 'binary' : kind,
                language: languageOf(rel),
                content,
                savedContent: content,
                dirty: false,
                saving: false,
                editing: false,
                conflict: false,
                status: 'ready',
                error: null,
                mtimeMs: data.mtimeMs,
                size: data.size,
                truncated: data.truncated === true,
                encoding: data.encoding,
                /* 从搜索结果跳进来时，加载完成后要落在那一行，而不是从头 */
                line: Number(previous.pendingLine) || 0,
                lineToken: previous.pendingLine ? 1 : 0,
                /* 用掉就清掉，免得下一个文件莫名跳到旧行号 */
                clearedLineJump: true, pendingLine: 0,
                externalMtimeMs: null,
              },
            }))
            return
          }
          /* Non-text: the media route renders it directly. */
          setState((previous) => Object.assign({}, previous, {
            status: 'ready',
            error: null,
            tab: Object.assign({}, previous.tab === null ? {} : previous.tab, {
              rel,
              name: baseNameOfRel(rel),
              kind,
              language: languageOf(rel),
              content: '',
              savedContent: '',
              dirty: false,
              status: 'ready',
              error: null,
              mediaTick: Date.now(),
              line: 0,
              lineToken: 0,
            }),
          }))
        } catch (error) {
          if (cancelled) return
          const message = error !== null && error !== undefined && typeof error.message === 'string'
            ? error.message
            : t('error.unknown')
          setState((previous) => Object.assign({}, previous, { status: 'error', error: message, tab: null }))
        }
      }
      void run()
      return () => { cancelled = true }
    }, [state.rel, state.status, workspaceRoot, t])

    /* ---- save ---- */
    const save = useCallback(async () => {
      const tab = state.tab
      if (tab === null || tab === undefined || tab.dirty !== true) return false
      setState((previous) => (previous.tab === null ? previous : Object.assign({}, previous, {
        tab: Object.assign({}, previous.tab, { saving: true }),
      })))
      try {
        const data = await call('write', {
          root: workspaceRoot,
          rel: tab.rel,
          content: tab.content,
          baseMtimeMs: tab.mtimeMs,
        })
        setState((previous) => (previous.tab === null ? previous : Object.assign({}, previous, {
          tab: Object.assign({}, previous.tab, {
            savedContent: previous.tab.content,
            dirty: false,
            saving: false,
            mtimeMs: data !== null && data !== undefined ? data.mtimeMs : previous.tab.mtimeMs,
            size: data !== null && data !== undefined ? data.size : previous.tab.size,
          }),
        })))
        return true
      } catch (error) {
        const conflict = error !== null && error !== undefined && error.code === 'conflict'
        setState((previous) => (previous.tab === null ? previous : Object.assign({}, previous, {
          tab: Object.assign({}, previous.tab, { saving: false, conflict }),
          error: conflict ? t('toast.conflict', { name: '' }) : (error !== null && error !== undefined ? error.message : t('error.unknown')),
        })))
        return false
      }
    }, [state.tab, workspaceRoot, t])

    /* Ctrl+S while the editor has focus. Scoped to this pane only: the host may
       have its own shortcut, and stealing it would be the old bug again. */
    useEffect(() => {
      const node = rootRef.current
      if (node === null || node === undefined) return undefined
      const onKey = (event) => {
        if (!(event.ctrlKey === true || event.metaKey === true)) return
        if (String(event.key).toLowerCase() !== 's') return
        if (state.tab === null || state.tab.dirty !== true) return
        event.preventDefault()
        event.stopPropagation()
        void save()
      }
      node.addEventListener('keydown', onKey)
      return () => node.removeEventListener('keydown', onKey)
    }, [state.tab, save])

    const tab = state.tab
    const mediaSrc = tab === null || workspaceRoot === '' ? '' : mediaUrl(workspaceRoot, tab.rel, tab.mediaTick)

    const body = (() => {
      if (state.rel === null) {
        return E('div', { className: 'wbf-emptyView' },
          E('div', { className: 'wbf-emptyHint' }, t('tabs.emptyHint')))
      }
      if (state.status === 'loading') {
        return E('div', { className: 'wbf-emptyView' }, E('div', { className: 'wbf-spinner' }), E('div', { className: 'wbf-emptyHint' }, t('file.loading')))
      }
      if (state.status === 'error') {
        return E('div', { className: 'wbf-emptyView' },
          E('div', { className: 'wbf-emptyTitle' }, t('file.readError')),
          E('div', { className: 'wbf-emptyHint' }, state.error))
      }
      if (tab === null) return null
      return E(Viewer, {
        tab,
        t,
        editing: state.editing === true,
        src: mediaSrc,
        onChange: (text) => setState((previous) => {
          if (previous.tab === null) return previous
          return Object.assign({}, previous, {
            tab: Object.assign({}, previous.tab, { content: text, dirty: text !== previous.tab.savedContent }),
          })
        }),
        onSave: () => { void save() },
      })
    })()

    /* The EMBEDDED pane deliberately has no tab strip, but it still needs the one
       action that matters: switching between preview and edit. Without it a page
       that mounts `panes.source` (the source-control page does) can only look.
       Read-only kinds and truncated files get no toggle — there is nothing to do. */
    const canEdit = tab !== null && tab !== undefined
      && isEditableKind(tab.kind) && tab.status === 'ready' && tab.truncated !== true
    const head = canEdit === true
      ? E('div', { className: 'wbf-fileHead', style: { flex: 'none' } },
        E('div', { className: 'wbf-fileIdentity' },
          E('span', { className: 'wbf-filePath', title: tab.rel }, tab.rel),
          tab.dirty === true ? E('span', { className: 'wbf-badge is-warn' }, t('file.dirty')) : null),
        E('div', { className: 'wbf-headActions' },
          E(TextButton, {
            onClick: () => setState((previous) => (previous.tab === null
              ? previous
              : Object.assign({}, previous, { editing: previous.editing !== true }))),
          }, state.editing === true ? t('file.preview') : t('file.edit')),
          state.editing === true && tab.dirty === true
            ? E(TextButton, { onClick: () => { void save() } }, t('file.save'))
            : null))
      : null

    return E('div', {
      className: 'wbf-pane',
      ref: rootRef,
      tabIndex: -1,
      style: { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: '0', height: '100%' },
    }, head, body)
  }

  root.render(React.createElement(PaneHost))

  return {
    handle,
    dispose: () => {
      runtime.openFile = null
      runtime.hasDirty = null
      runtime.reload = null
      try { root.unmount() } catch (error) { void error }
    },
  }
}


    /* ============================== registration ============================== */

    const CSS = `
.wbf-root{position:relative;display:flex;flex-direction:column;flex:1 1 auto;height:100%;min-height:0;color:var(--dsw-alias-label-primary,#e6e6e6);background:var(--dsw-alias-bg-base,#14161a);font:inherit;font-size:12px}
.wbf-main{display:flex;flex:1;min-height:0;min-width:0}
.wbf-sidebar{display:flex;flex-direction:column;width:clamp(190px,36%,320px);max-width:62%;min-width:170px;min-height:0;border-right:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));position:relative}
.wbf-sidebarGrip{flex:0 0 5px;cursor:col-resize;background:transparent;position:relative;z-index:2}
.wbf-sidebarGrip:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 22%,transparent)}
.wbf-sidebarGrip:active{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 38%,transparent)}.wbf-sidebarHead{display:flex;align-items:center;gap:4px;padding:7px 6px 5px}
.wbf-rootChip{display:flex;align-items:center;gap:5px;flex:1;min-width:0;height:26px;padding:0 7px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));border-radius:6px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.05));color:inherit;font:inherit;font-size:11px;cursor:pointer}
.wbf-rootChip:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}
.wbf-rootName{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.wbf-iconBtn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:none;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary,#b6bac1);cursor:pointer}
.wbf-iconBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));color:var(--dsw-alias-label-primary,#e6e6e6)}
.wbf-iconBtn.is-active{color:var(--dsw-alias-brand-primary,#4d6bfe)}
.wbf-iconBtn.is-danger:hover{color:var(--dsw-alias-state-error-primary,#ff6b6b)}
.wbf-iconBtn:disabled{opacity:.35;cursor:default}
.wbf-searchRow{display:flex;align-items:center;gap:4px;padding:2px 8px 6px}
.wbf-searchBar{flex:none}
.wbf-searchModes{display:flex;flex:none;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));border-radius:5px;overflow:hidden;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.04))}
.wbf-searchMode{border:none;background:transparent;color:var(--dsw-alias-label-secondary,#b6bac1);font:inherit;font-size:9px;padding:2px 6px;cursor:pointer;white-space:nowrap}
.wbf-searchMode.is-active{background:var(--dsw-alias-brand-primary,#4d6bfe);color:var(--dsw-alias-label-primary-inverted,#fff)}
.wbf-searchOptions{display:flex;flex-direction:column;gap:2px;padding:0 8px 4px;flex:none}
.wbf-searchFlags{display:flex;align-items:center;gap:2px}
.wbf-searchContentList{display:flex;flex-direction:column;min-height:0}
.wbf-searchIcon{flex:none;color:var(--dsw-alias-label-tertiary,#8a8f98)}
.wbf-searchInput{flex:1;min-width:0;height:24px;padding:0 7px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));border-radius:6px;background:var(--dsw-alias-bg-base,#14161a);color:inherit;font:inherit;font-size:11px}
.wbf-searchInput:focus{outline:none;box-shadow:0 0 0 1px var(--dsw-alias-brand-primary,#4d6bfe);border-color:var(--dsw-alias-brand-primary,#4d6bfe)}
.wbf-treeToolbar{display:flex;align-items:center;gap:4px;padding:0 8px 4px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08))}
.wbf-treeTitle{flex:1;font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary,#b6bac1)}
.wbf-treeToolbarActions{display:flex;gap:1px;flex:none}
.wbf-treeWrap{display:flex;flex-direction:column;flex:1;min-height:0}
.wbf-tree{flex:1;min-height:0;overflow:auto;padding:3px 2px 10px;overscroll-behavior:contain}
.wbf-row{display:flex;align-items:center;gap:4px;height:23px;padding-right:6px;border-radius:4px;cursor:pointer;white-space:nowrap;color:var(--dsw-alias-label-primary,#e6e6e6);outline:none}
.wbf-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.wbf-row:focus-visible{box-shadow:inset 0 0 0 1px var(--dsw-alias-brand-primary,#4d6bfe)}
.wbf-row.is-active{background:var(--dsw-alias-interactive-bg-active,rgba(77,107,254,.18))}
.wbf-row.is-dir{font-weight:500}
.wbf-rowChevron{display:inline-flex;width:11px;flex:none;color:var(--dsw-alias-label-tertiary,#8a8f98)}
.wbf-rowIcon{flex:none;color:var(--dsw-alias-label-secondary,#b6bac1)}
.wbf-row.is-dir .wbf-rowIcon{color:var(--dsw-alias-state-warn-primary,#e2a03f)}
.wbf-rowName{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
.wbf-rowBadge{flex:none;font-size:9px;padding:0 4px;border-radius:3px;color:var(--dsw-alias-label-tertiary,#8a8f98);background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.06))}
.wbf-treeStatus{padding:7px 10px;color:var(--dsw-alias-label-tertiary,#8a8f98);font-style:italic}
.wbf-treeStatus.is-warn{color:var(--dsw-alias-state-warn-primary,#e2a03f);font-style:normal}
.wbf-treeError{display:flex;align-items:flex-start;gap:5px;padding:6px 10px;color:var(--dsw-alias-state-error-primary,#ff6b6b);line-height:1.45}
.wbf-treeErrorRoot{flex-wrap:wrap}
.wbf-treeErrorMessage{flex:1;min-width:0;word-break:break-word}
.wbf-linkBtn{border:none;background:transparent;color:var(--dsw-alias-brand-primary,#4d6bfe);font:inherit;font-size:11px;cursor:pointer;padding:0 2px;text-decoration:underline}
.wbf-treeFoot{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:6px 10px;font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8f98);border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08))}
.wbf-searchResults{display:flex;flex-direction:column;padding:2px 2px 8px}
.wbf-searchResultRow{display:flex;align-items:center;gap:6px;width:100%;padding:4px 7px;border:none;border-radius:4px;background:transparent;color:var(--dsw-alias-label-primary,#e6e6e6);font:inherit;font-size:11px;text-align:left;cursor:pointer}
.wbf-searchResultRow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.wbf-searchName{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wbf-searchDir{flex:none;max-width:48%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:10px}
.wbf-searchResultRow.is-focused{background:var(--dsw-alias-interactive-bg-active,rgba(77,107,254,.18));box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary,#4d6bfe)}
.wbf-searchResultRow.is-recent .wbf-searchName{color:var(--dsw-alias-label-primary,#e6e6e6)}
.wbf-searchHit{border-radius:2px;background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 30%,transparent);color:var(--dsw-alias-label-primary,#fff)}
.wbf-recentBadge{flex:none;padding:0 4px;border-radius:3px;color:var(--dsw-alias-state-success-primary,#3fb950);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#3fb950) 14%,transparent);font-size:9px;line-height:14px;white-space:nowrap}
.wbf-quickMeta{display:flex;align-items:center;gap:6px;padding:0 8px 4px;color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:10px}
.wbf-quickCount{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wbf-quickTruncated{flex:none;color:var(--dsw-alias-state-warn-primary,#e2a03f)}
.wbf-srFlag{width:22px;height:20px;padding:0;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary,#b6bac1);font:inherit;font-family:var(--dsw-font-markdown-code-block,ui-monospace,monospace);font-size:10px;line-height:1;cursor:pointer}
.wbf-srFlag:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}
.wbf-srFlag.is-active{color:var(--dsw-alias-brand-primary,#4d6bfe);border-color:var(--dsw-alias-brand-primary,#4d6bfe);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 16%,transparent)}
.wbf-srGlob{display:flex;flex-direction:column;gap:3px;padding:0 8px 4px}
.wbf-srGlobHead{display:flex;align-items:center;gap:4px;padding:2px 0;border:none;background:transparent;color:var(--dsw-alias-label-secondary,#b6bac1);font:inherit;font-size:10px;text-align:left;cursor:pointer}
.wbf-srGlobHead:hover{color:var(--dsw-alias-label-primary,#e6e6e6)}
.wbf-srGlobInput{height:24px;padding:0 7px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));border-radius:5px;background:var(--dsw-alias-bg-base,#14161a);color:inherit;font:inherit;font-size:10px;font-family:var(--dsw-font-markdown-code-block,ui-monospace,monospace)}
.wbf-srGlobInput:focus{outline:none;box-shadow:0 0 0 1px var(--dsw-alias-brand-primary,#4d6bfe);border-color:var(--dsw-alias-brand-primary,#4d6bfe)}
.wbf-srGlobChips{display:flex;flex-wrap:wrap;gap:3px;max-height:54px;overflow:auto}
.wbf-srGlobChip{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 4px;border-radius:3px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.06));color:var(--dsw-alias-label-secondary,#b6bac1);font-family:var(--dsw-font-markdown-code-block,ui-monospace,monospace);font-size:9px;line-height:15px}
.wbf-srGlobInvalid{color:var(--dsw-alias-state-error-primary,#ff6b6b);font-size:10px;line-height:1.4;word-break:break-word}
.wbf-srHint{color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:10px;line-height:1.4;word-break:break-word}
.wbf-srStatus{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:4px 9px;border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8f98)}
.wbf-srStatusText{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
.wbf-srStatusMeta{flex:none;font-family:var(--dsw-font-markdown-code-block,ui-monospace,monospace)}
.wbf-srStatus.is-busy{color:var(--dsw-alias-state-warn-primary,#e2a03f)}
.wbf-srStatus.is-error{color:var(--dsw-alias-state-error-primary,#ff6b6b)}
.wbf-srTruncated{flex:none;padding:0 5px;border-radius:3px;color:var(--dsw-alias-state-warn-primary,#e2a03f);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#e2a03f) 16%,transparent);font-size:9px;line-height:15px}
.wbf-srEmpty{display:flex;flex-direction:column;align-items:center;gap:6px;padding:26px 14px;text-align:center;color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:11px;line-height:1.5}
.wbf-srFile,.wbf-srMatch{display:flex;align-items:center;gap:4px;width:100%;border:none;background:transparent;text-align:left;cursor:pointer;border-radius:4px}
.wbf-srFile{padding:3px 6px;color:var(--dsw-alias-label-primary,#e6e6e6);font:inherit;font-size:11px}
.wbf-srFile:hover,.wbf-srMatch:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.wbf-srFile.is-focused,.wbf-srMatch.is-focused{background:var(--dsw-alias-interactive-bg-active,rgba(77,107,254,.18))}
.wbf-srChevron{display:flex;width:10px;flex:none;color:var(--dsw-alias-label-tertiary,#8a8f98)}
.wbf-srFileName{flex:none;max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.wbf-srFileDir{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:9px}
.wbf-srCount{flex:none;min-width:16px;padding:0 4px;border-radius:8px;text-align:center;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.06));color:var(--dsw-alias-label-secondary,#b6bac1);font-size:9px;line-height:15px}
.wbf-srMatch{padding:2px 6px 2px 16px;color:var(--dsw-alias-label-secondary,#b6bac1);font:inherit;font-family:var(--dsw-font-markdown-code-block,ui-monospace,monospace);font-size:10px}
.wbf-srLine{flex:none;width:36px;text-align:right;color:var(--dsw-alias-label-tertiary,#8a8f98)}
.wbf-srSnippet{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:pre}
.wbf-srHit{border-radius:2px;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#e2a03f) 34%,transparent);color:var(--dsw-alias-label-primary,#e6e6e6)}
.wbf-content{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0;background:var(--dsw-alias-bg-base,#14161a)}
.wbf-tabs{display:flex;align-items:stretch;flex:none;min-height:29px;overflow-x:auto;overflow-y:hidden;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));scrollbar-width:thin}
.wbf-tab{display:flex;align-items:center;gap:5px;flex:none;max-width:180px;padding:0 7px;border:none;border-right:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));background:transparent;color:var(--dsw-alias-label-secondary,#b6bac1);font:inherit;font-size:11px;cursor:pointer}
.wbf-tab:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.05))}
.wbf-tab.is-active{background:var(--dsw-alias-bg-layer-2,#22262c);color:var(--dsw-alias-label-primary,#e6e6e6);box-shadow:inset 0 -2px 0 var(--dsw-alias-brand-primary,#4d6bfe)}
.wbf-tabName{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wbf-tabDot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-brand-primary,#4d6bfe)}
.wbf-tabClose{display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;border-radius:3px;flex:none;font-size:13px;line-height:1;color:var(--dsw-alias-label-tertiary,#8a8f98)}
.wbf-tabClose:hover{background:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.12));color:var(--dsw-alias-label-primary,#fff)}
.wbf-fileHead{display:flex;align-items:center;gap:8px;flex:none;padding:5px 9px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));flex-wrap:wrap}
.wbf-fileIdentity{display:flex;align-items:center;gap:6px;flex:1;min-width:0;flex-wrap:wrap}
.wbf-filePath{min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--dsw-font-markdown-code-block,ui-monospace,monospace);font-size:11px;color:var(--dsw-alias-label-secondary,#b6bac1)}
.wbf-badges{display:flex;align-items:center;gap:4px;flex-wrap:wrap}
.wbf-badge{padding:0 5px;border-radius:3px;font-size:9px;line-height:16px;color:var(--dsw-alias-label-tertiary,#8a8f98);background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.06))}
.wbf-badge.is-warn{color:var(--dsw-alias-state-warn-primary,#e2a03f);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#e2a03f) 16%,transparent)}
.wbf-headActions{display:flex;align-items:center;gap:3px;margin-left:auto;flex:none}
.wbf-btn{display:inline-flex;align-items:center;justify-content:center;height:23px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));border-radius:5px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.05));color:var(--dsw-alias-label-primary,#e6e6e6);font:inherit;font-size:11px;cursor:pointer;text-decoration:none;white-space:nowrap}
.wbf-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.1))}
.wbf-btn.is-primary{background:var(--dsw-alias-button-primary-fill,#4d6bfe);border-color:transparent;color:var(--dsw-alias-label-primary-inverted,#fff)}
.wbf-btn.is-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#5d7bff)}
.wbf-btn.is-danger{color:var(--dsw-alias-state-error-primary,#ff6b6b);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ff6b6b) 45%,transparent)}
.wbf-btn:disabled{opacity:.4;cursor:default}
.wbf-conflict{display:flex;align-items:center;gap:8px;flex:none;flex-wrap:wrap;padding:5px 9px;font-size:11px;color:var(--dsw-alias-state-error-primary,#ff6b6b);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ff6b6b) 13%,transparent)}
.wbf-conflictText{flex:1;min-width:120px}
.wbf-conflictActions{display:flex;gap:4px;flex:none}
.wbf-viewer{display:flex;flex-direction:column;flex:1;min-height:0;overflow:auto}
.wbf-pre{margin:0;padding:12px 16px;font-family:var(--dsw-font-markdown-code-block,ui-monospace,monospace);font-size:13px;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere;overflow:auto;tab-size:2}
.wbf-editor{display:flex;flex-direction:column;flex:1;min-height:0}
.wbf-editorHost{flex:1;min-height:0;overflow:hidden}
.wbf-editorFallback.is-hidden{display:none}
.wbf-md{padding:14px 18px;font-size:13px;line-height:1.75;overflow:auto;word-break:break-word}
.wbf-md h1,.wbf-md h2,.wbf-md h3,.wbf-md h4,.wbf-md h5,.wbf-md h6{margin:1em 0 .45em;line-height:1.3}
.wbf-md h1{font-size:1.5em}.wbf-md h2{font-size:1.3em}.wbf-md h3{font-size:1.15em}.wbf-md h4,.wbf-md h5,.wbf-md h6{font-size:1em}
.wbf-md p{margin:.7em 0}
.wbf-md ul,.wbf-md ol{margin:.7em 0;padding-left:1.7em}
.wbf-md li{margin:.28em 0}
.wbf-md code{padding:1px 4px;border-radius:3px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.07));font-family:var(--dsw-font-markdown-code-block,ui-monospace,monospace);font-size:.92em}
.wbf-md pre{margin:.7em 0;padding:9px 11px;border-radius:6px;background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.04));overflow:auto}
.wbf-md pre code{padding:0;background:transparent}
.wbf-md blockquote{margin:.7em 0;padding:.1em 0 .1em .8em;border-left:3px solid var(--dsw-alias-border-l3,rgba(255,255,255,.18));color:var(--dsw-alias-label-secondary,#b6bac1)}
.wbf-md a{color:var(--dsw-alias-brand-primary,#4d6bfe);text-decoration:none}
.wbf-md a:hover{text-decoration:underline}
.wbf-md hr{border:none;border-top:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));margin:1em 0}
.wbf-jsonWrap{display:flex;flex-direction:column;flex:1;min-height:0;overflow:auto}
.wbf-imageWrap{display:flex;align-items:center;justify-content:center;flex:1;min-height:0;overflow:auto;padding:14px}
.wbf-img{max-width:100%;max-height:100%;object-fit:contain;box-shadow:0 2px 14px rgba(0,0,0,.28)}
.wbf-mediaWrap{display:flex;flex-direction:column;flex:1;min-height:0}
.wbf-embed{flex:1;width:100%;min-height:240px;border:none}
.wbf-frame{flex:1;width:100%;min-height:240px;border:none;background:#fff}
.wbf-mediaFoot{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px 9px;border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8f98)}
.wbf-emptyView{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;flex:1;min-height:0;padding:26px 18px;text-align:center;color:var(--dsw-alias-label-tertiary,#8a8f98);overflow:auto}
.wbf-emptyTitle{font-size:14px;font-weight:600;color:var(--dsw-alias-label-secondary,#b6bac1)}
.wbf-emptyHint{max-width:440px;line-height:1.6;color:var(--dsw-alias-label-tertiary,#8a8f98)}
.wbf-binary{gap:7px}
.wbf-binaryActions{display:flex;gap:6px;margin-top:3px}
.wbf-spinner{width:20px;height:20px;border-radius:50%;border:2px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));border-top-color:var(--dsw-alias-brand-primary,#4d6bfe);animation:wbf-spin .8s linear infinite}
@keyframes wbf-spin{to{transform:rotate(360deg)}}
.wbf-note{padding:5px 9px;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#8a8f98);border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08))}
.wbf-note.is-error{color:var(--dsw-alias-state-error-primary,#ff6b6b)}
.wbf-note.is-warn{color:var(--dsw-alias-state-warn-primary,#e2a03f)}
.wbf-modalBackdrop{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:16px;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.5))}
.wbf-modal{display:flex;flex-direction:column;width:min(560px,100%);max-height:84vh;border-radius:var(--dsw-radius-lg,12px);border:1px solid var(--dsw-alias-border-l3,rgba(255,255,255,.16));background:var(--dsw-alias-bg-layer-2,#22262c);box-shadow:var(--dsw-elevation-prominent,0 12px 40px rgba(0,0,0,.5))}
.wbf-modalHead{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08))}
.wbf-modalTitle{font-weight:600;font-size:13px}
.wbf-modalBody{display:flex;flex-direction:column;gap:9px;padding:12px;overflow:auto;min-height:0}
.wbf-modalFoot{display:flex;justify-content:flex-end;gap:6px;padding:9px 12px;border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08))}
.wbf-dialogBody{font-size:12px;line-height:1.6;word-break:break-word;color:var(--dsw-alias-label-secondary,#b6bac1)}
.wbf-picker{display:flex;flex-direction:column;gap:10px;min-height:0}
.wbf-libSection{display:flex;flex-direction:column;gap:5px}
.wbf-libLabel{font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--dsw-alias-label-tertiary,#8a8f98)}
.wbf-libDrives{display:flex;flex-wrap:wrap;gap:4px}
.wbf-libDrive{padding:2px 9px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary,#b6bac1);font:inherit;font-size:11px;cursor:pointer}
.wbf-libDrive:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}
.wbf-libInputRow{display:flex;align-items:center;gap:5px}
.wbf-libInput{flex:1;min-width:0;height:27px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));border-radius:6px;background:var(--dsw-alias-bg-base,#14161a);color:inherit;font:inherit;font-size:12px;font-family:var(--dsw-font-markdown-code-block,ui-monospace,monospace)}
.wbf-libInput:focus{outline:none;box-shadow:0 0 0 1px var(--dsw-alias-brand-primary,#4d6bfe);border-color:var(--dsw-alias-brand-primary,#4d6bfe)}
.wbf-libPathBar{display:flex;align-items:center;gap:4px;padding:2px 0}
.wbf-libPath{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--dsw-font-markdown-code-block,ui-monospace,monospace);font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8f98)}
.wbf-libList{display:flex;flex-direction:column;gap:1px;max-height:260px;overflow:auto;padding:3px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));border-radius:7px}
.wbf-libRow{display:flex;align-items:center;gap:6px;width:100%;padding:4px 6px;border:none;border-radius:4px;background:transparent;color:var(--dsw-alias-label-primary,#e6e6e6);font:inherit;font-size:11px;text-align:left;cursor:pointer}
.wbf-libRow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.wbf-libRow.is-current{background:var(--dsw-alias-interactive-bg-active,rgba(77,107,254,.16))}
.wbf-libRow.is-suggested{border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));margin-top:2px}
.wbf-libRowName{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wbf-libRowPath{flex:none;max-width:48%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:10px}
.wbf-libNote{padding:5px 7px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8f98);font-style:italic}
.wbf-libNote.is-error{color:var(--dsw-alias-state-error-primary,#ff6b6b);font-style:normal}
.wbf-libHint{font-size:10px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#8a8f98)}
.wbf-toast{position:absolute;left:10px;right:10px;bottom:10px;z-index:20;padding:6px 10px;border-radius:8px;font-size:11px;box-shadow:var(--dsw-elevation-prominent,0 6px 22px rgba(0,0,0,.4));word-break:break-word}
.wbf-toast.is-ok{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#3fb950) 20%,var(--dsw-alias-bg-layer-2,#22262c));color:var(--dsw-alias-label-primary,#e6e6e6)}
.wbf-toast.is-error{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ff6b6b) 22%,var(--dsw-alias-bg-layer-2,#22262c));color:var(--dsw-alias-label-primary,#e6e6e6)}
@media (max-width:520px){.wbf-sidebar{width:42%;min-width:150px}.wbf-filePath{display:none}}
`

    /* The live editor pane, when some OTHER page has composed it. Kept at module
       scope because `commands` are called from outside React (the host page asks
       "is this file dirty?" on a click) and there is exactly one such pane per
       page instance. */
    const sourcePaneRef = { current: null }

    function apply(ctx) {
      const doc = typeof document !== 'undefined' && document !== null ? document : null
      if (doc !== null && doc.head !== undefined && doc.head !== null) {
        const style = doc.createElement('style')
        style.setAttribute('data-dsh-workbay-files', '')
        style.textContent = CSS
        doc.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-workbay-files: page styles')
      }

      const t = translatorOf(ctx)

      const localeService = ctx.get('locale')
      if (localeService !== undefined && localeService !== null && typeof localeService.register === 'function') {
        ctx.effect(
          () => localeService.register(LOCALE_NS, Object.assign({ zh: ZH, en: EN }, LOCALES)),
          'dsh-workbay-files: locale dictionaries',
        )
      }

      /* ONE page. The dock may load after this bundle, so poll briefly. */
      const registerWithDock = () => {
        const dock = typeof window === 'object' && window !== null ? window.__DSH_WORKBAY__ : undefined
        if (dock === undefined || dock === null || typeof dock.registerPage !== 'function') return false
        try {
          const off = dock.registerPage({
            id: PAGE_ID,
            title: t('page.files'),
            order: 10,
            hidden: true,
            icon: (size) => E(Icon, { name: 'files', size: size === undefined ? 16 : size }),
            component: () => E(LocaleLive, { ctx, t }),
            /* ── Embedding surface (optional; see docs/panes-contract.md) ──
             *
             * The source-control page composes this page's EDITOR into its own
             * layout instead of showing a duplicate file list. The pane mounts
             * into a container the shell owns, using its own React root, so the
             * two remain separate failure domains.
             *
             * `paneHost` is a tiny imperative bridge: the shell calls
             * `mount(container)` once, then steers it with the commands below.
             * Everything the pane needs to render (`openFile`, `hasDirty`) also
             * exists as a command, because the shell asks about files it has
             * not opened yet.
             */
            panes: {
              /* The pane returns { dispose, handle }; the host (dock or another
                 page) decides when to unmount, and this page keeps the handle so
                 its own `commands` can answer questions about the pane. */
              source: (container, api) => {
                const mounted = mountSourcePane(container, api, ctx, t)
                if (mounted !== null && mounted !== undefined && mounted.handle !== undefined) {
                  sourcePaneRef.current = mounted.handle
                }
                return () => {
                  sourcePaneRef.current = null
                  if (mounted !== null && mounted !== undefined && typeof mounted.dispose === 'function') mounted.dispose()
                }
              },
            },
            commands: {
              /** Open a workspace-relative file in the editor surface. */
              openFile: (rel) => { if (sourcePaneRef.current !== null) sourcePaneRef.current.openFile(rel) },
              /** True when that file has unsaved edits in the editor. */
              hasDirty: (rel) => (sourcePaneRef.current !== null ? sourcePaneRef.current.hasDirty(rel) === true : false),
              /** Re-read the file from disk (used after a git write touched it). */
              reload: (rel) => { if (sourcePaneRef.current !== null) sourcePaneRef.current.reload(rel) },
              /** 打开文件并定位到某一行（搜索结果点击）。 */
              jump: (rel, line) => { if (sourcePaneRef.current !== null && typeof sourcePaneRef.current.jump === 'function') sourcePaneRef.current.jump(rel, line) },
            },
          })
          ctx.effect(() => (typeof off === 'function' ? off : () => {}), 'dsh-workbay-files: workbench page')
          return true
        } catch (error) {
          try { console.error('[files] workbench page registration failed:', error) } catch { void error }
          return false
        }
      }

      if (!registerWithDock()) {
        let attempts = 0
        const timer = setInterval(() => {
          attempts += 1
          if (registerWithDock() || attempts >= 40) clearInterval(timer)
        }, 250)
        ctx.effect(() => () => clearInterval(timer), 'dsh-workbay-files: dock discovery')
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
      return E(Page, { t: props.t })
    }

    /*
     * Exposed purely so `tests/client.test.mjs` can pin the pure helpers without
     * a DOM. Not part of the plugin contract; the loader only reads `apply`.
     */
    const TEST_API = {
      PAGE_ID,
      TREE_ROW_LIMIT,
      SEARCH_PANEL_MAX_RESULTS,
      SEARCH_MODES,
      SEARCH_LIMIT,
      SEARCH_DEBOUNCE_MS,
      SEARCH_PANEL_DEBOUNCE_MS,
      QUICK_OPEN_RECENT_LIMIT,
      extensionOf,
      classifyFile,
      languageOf,
      isReadableKind,
      isEditableKind,
      sortEntries,
      flattenTree,
      normalizeRel,
      joinRel,
      baseNameOfRel,
      dirNameOfRel,
      ancestorDirsOf,
      formatBytes,
      escapeHtml,
      sanitizeUrl,
      markdownToHtml,
      normalizeRootPath,
      absolutePathOf,
      insertIntoComposer,
      workspaceNameOf,
      parseStoredRoot,
      browseEntryPath,
      reduceTab,
      createSearchState,
      reduceSearchState,
      moveSearchFocus,
      parseGlobInput,
      buildSearchRequest,
      buildNameSearchRequest,
      normalizeSearchResponse,
      normalizeNameSearchEntries,
      flattenSearchResults,
      splitHighlight,
      normalizeIndices,
      splitByIndices,
      quickOpenDisplay,
      normalizeRecentList,
      orderRecentFirst,
      createQuickOpenState,
      reduceQuickOpen,
      quickOpenKeyCommand,
      createUnifiedSearchState,
      reduceUnifiedSearchState,
      activeSearchView,
      contentOptionsOf,
      isAbortError,
      mediaUrl,
      loadChunk,
      dictionaries: { zh: ZH, en: EN },
      components: {
        Page,
        TabStrip,
        FileHeader,
        ConflictBar,
        RootPicker,
        TreePanel,
        SearchModeSegment,
        SearchOptions,
        QuickOpenResults,
        ContentResults,
        Viewer,
        ViewerEmpty,
        EditorMount,
        MarkdownView,
        JsonView,
        BinaryView,
      },
    }

    return { apply, name: 'dsh-workbay-files', __test: TEST_API }
  },
})





