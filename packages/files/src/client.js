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
    const API_PREFIX = '/dsh-workbay-files/api/'
    const MEDIA_ROUTE = '/dsh-workbay-files/media'
    const CHUNK_ROUTE = '/dsh-workbay-files/chunk/editor.js'
    const CHUNK_NAME = 'dsh-workbay-files:editor'
    const ROOT_KEY = 'dsh-workbay.root.v1'
    const HIDDEN_KEY = 'dsh-workbay.files.hidden.v1'
    const LOCALE_NS = 'dsh-workbay-files'
    const TREE_ROW_LIMIT = 400
    const SEARCH_LIMIT = 200
    const SEARCH_DEBOUNCE_MS = 280
    const STAT_INTERVAL_MS = 4000

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
      'tree.searchPlaceholder': '搜索文件名或路径',
      'tree.searching': '正在搜索…',
      'tree.searchEmpty': '没有匹配的文件',
      'tree.searchTruncated': '结果过多，已截断',
      'tree.clearSearch': '清除搜索',

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
      'tree.searchPlaceholder': 'Search file names or paths',
      'tree.searching': 'Searching…',
      'tree.searchEmpty': 'No matching files',
      'tree.searchTruncated': 'Too many results — truncated',
      'tree.clearSearch': 'Clear search',

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

    function compareNames(left, right) {
      return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: 'base' })
    }

    /** Directories first, then natural, case-insensitive name order. */
    function sortEntries(entries) {
      const list = Array.isArray(entries) ? entries.slice() : []
      return list.sort((left, right) => {
        const leftDir = left !== null && left !== undefined && left.type === 'dir'
        const rightDir = right !== null && right !== undefined && right.type === 'dir'
        if (leftDir !== rightDir) return leftDir ? -1 : 1
        const byName = compareNames(left === undefined || left === null ? '' : left.name, right === undefined || right === null ? '' : right.name)
        if (byName !== 0) return byName
        return compareNames(left === undefined || left === null ? '' : left.rel, right === undefined || right === null ? '' : right.rel)
      })
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
        default:
          return tab
      }
    }

    const ERROR_KEYS = {
      'outside-root': 'error.outsideRoot',
      'bad-request': 'error.badRequest',
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
      const { tab, t, readOnly, onChange, onSave } = props
      const hostRef = useRef(null)
      const handleRef = useRef(null)
      const valueRef = useRef(typeof tab.content === 'string' ? tab.content : '')
      const callbacks = useRef({ onChange, onSave })
      callbacks.current = { onChange, onSave }
      const [state, setState] = useState('loading')
      const [failure, setFailure] = useState(null)

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
      }, [tab.rel, tab.language, readOnly])

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
      if (tab.kind === 'markdown') {
        return editing
          ? E(EditorMount, { tab, t, readOnly: false, onChange, onSave })
          : E(MarkdownView, { tab })
      }
      if (tab.kind === 'json') {
        return editing
          ? E(EditorMount, { tab, t, readOnly: false, onChange, onSave })
          : E(JsonView, { tab, t })
      }
      if (tab.kind === 'image') return E(ImageView, { tab, t, src })
      if (tab.kind === 'pdf') return E(PdfView, { tab, t, src })
      if (tab.kind === 'html') return E(HtmlView, { tab, src })
      if (tab.kind === 'binary') return E(BinaryView, { tab, t, src })
      return E(EditorMount, { tab, t, readOnly: editing !== true, onChange, onSave })
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
      const { t, root, tree, expanded, rows, rowLimit, showHidden, searchQuery, search, activeRel, onToggleHidden, onRefresh, onToggleDir, onOpenFile, onRetryDir, onShowMore, onOpenSearchResult, onClearSearch } = props
      const rootNode = tree['']
      const searching = searchQuery.trim() !== ''
      let body = null
      if (root === null || root === '') {
        body = E('div', { className: 'wbf-treeStatus' }, t('root.none'))
      } else if (searching) {
        if (search.status === 'loading') body = E('div', { className: 'wbf-treeStatus' }, t('tree.searching'))
        else if (search.status === 'error') body = E('div', { className: 'wbf-treeError' }, E(Icon, { name: 'warning', size: 12 }), E('span', null, search.error))
        else if (search.matches.length === 0) body = E('div', { className: 'wbf-treeStatus' }, t('tree.searchEmpty'))
        else {
          body = E('div', { className: 'wbf-searchResults' }, search.matches.map((entry) => {
            const rel = typeof entry.rel === 'string' ? entry.rel : ''
            const name = typeof entry.name === 'string' && entry.name !== '' ? entry.name : baseNameOfRel(rel)
            return E('button', {
              key: rel,
              type: 'button',
              className: 'wbf-searchRow',
              title: rel,
              onClick: () => onOpenSearchResult(entry),
            },
            E(Icon, { name: entry.type === 'dir' ? 'folder' : iconForEntry({ name, dir: false }), size: 13 }),
            E('span', { className: 'wbf-searchName' }, name),
            E('span', { className: 'wbf-searchDir' }, dirNameOfRel(rel) === '' ? '/' : dirNameOfRel(rel)))
          }))
        }
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

      return E('div', { className: 'wbf-treeWrap' },
        E('div', { className: 'wbf-searchRow' },
          E(Icon, { name: 'search', size: 12, className: 'wbf-searchIcon' }),
          E('input', {
            className: 'wbf-searchInput',
            type: 'search',
            value: searchQuery,
            placeholder: t('tree.searchPlaceholder'),
            spellCheck: false,
            onChange: (event) => props.onQueryChange(event.target.value),
          }),
          searchQuery === '' ? null : E(IconButton, { name: 'close', size: 12, label: t('tree.clearSearch'), onClick: onClearSearch })),
        E('div', { className: 'wbf-treeToolbar' },
          E('span', { className: 'wbf-treeTitle' }, t('tree.title')),
          E('span', { className: 'wbf-treeToolbarActions' },
            E(IconButton, { name: showHidden ? 'eye' : 'eyeOff', size: 13, active: showHidden === true, label: showHidden ? t('tree.hideHidden') : t('tree.showHidden'), onClick: onToggleHidden }),
            E(IconButton, { name: 'refresh', size: 13, label: t('tree.refresh'), onClick: onRefresh }))),
        E('div', { className: 'wbf-tree' }, body),
        search.truncated === true && searching ? E('div', { className: 'wbf-treeFoot' }, t('tree.searchTruncated')) : null)
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

    /* ============================== page ============================== */

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

      const [root, setRoot] = useState(() => readStoredRoot())
      const [showHidden, setShowHidden] = useState(() => readBool(HIDDEN_KEY, false))
      const [rootsInfo, setRootsInfo] = useState({ status: 'loading', data: null, error: null })
      const [pickerOpen, setPickerOpen] = useState(false)
      const [tree, setTree] = useState({})
      const [expanded, setExpanded] = useState(() => new Set())
      const [rowLimit, setRowLimit] = useState(TREE_ROW_LIMIT)
      const [query, setQuery] = useState('')
      const [searchNonce, setSearchNonce] = useState(0)
      const [search, setSearch] = useState({ status: 'idle', matches: [], truncated: false, error: null })
      const [tabs, setTabs] = useState([])
      const [activeRel, setActiveRel] = useState(null)
      const [pendingClose, setPendingClose] = useState(null)
      const [pendingRoot, setPendingRoot] = useState(null)
      const [pendingReload, setPendingReload] = useState(null)
      const [toast, setToast] = useState(null)

      rootRef.current = root
      showHiddenRef.current = showHidden
      tabsRef.current = tabs
      activeRelRef.current = activeRel
      treeRef.current = tree

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
        setQuery('')
        setSearch({ status: 'idle', matches: [], truncated: false, error: null })
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
          const data = await call('tree', { root: currentRoot, dir: dirRel, showHidden: currentShowHidden })
          if (rootRef.current !== currentRoot || showHiddenRef.current !== currentShowHidden || dirReqRef.current.get(dirRel) !== token) return
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
        setSearchNonce((value) => value + 1)
        showToast(t('toast.refreshed'), 'ok')
      }, [loadDir, showToast, t])

      /* ---- search ----------------------------------------------------------- */

      useEffect(() => {
        const text = query.trim()
        if (root === null || root === '' || text === '') {
          setSearch({ status: 'idle', matches: [], truncated: false, error: null })
          return undefined
        }
        let cancelled = false
        const timer = setTimeout(() => {
          setSearch({ status: 'loading', matches: [], truncated: false, error: null })
          call('search', { root, query: text, limit: SEARCH_LIMIT }).then((data) => {
            if (cancelled) return
            setSearch({
              status: 'ready',
              matches: data !== null && data !== undefined && Array.isArray(data.matches) ? data.matches : [],
              truncated: data !== null && data !== undefined && data.truncated === true,
              error: null,
            })
          }).catch((error) => {
            if (cancelled) return
            setSearch({ status: 'error', matches: [], truncated: false, error: describeError(t, error) })
          })
        }, SEARCH_DEBOUNCE_MS)
        return () => {
          cancelled = true
          clearTimeout(timer)
        }
      }, [query, root, searchNonce, t])

      /* ---- tabs / files ----------------------------------------------------- */

      const hydrateTab = useCallback(async (tab, entry) => {
        const currentRoot = rootRef.current
        if (currentRoot === null || currentRoot === '') return
        try {
          if (isReadableKind(tab.kind)) {
            const data = await call('read', { root: currentRoot, rel: tab.rel })
            if (rootRef.current !== currentRoot) return
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

      const openEntry = useCallback((entry) => {
        if (entry === null || entry === undefined) return
        if (rootRef.current === null || rootRef.current === '') return
        const rel = normalizeRel(typeof entry.rel === 'string' && entry.rel !== '' ? entry.rel : entry.name)
        if (rel === '') return
        if (tabsRef.current.some((tab) => tab.rel === rel)) {
          setActiveRel(rel)
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
          editing: false,
          conflict: false,
          externalMtimeMs: null,
          mtimeMs: typeof entry.mtimeMs === 'number' ? entry.mtimeMs : 0,
          size: typeof entry.size === 'number' ? entry.size : 0,
          truncated: false,
          encoding: 'utf8',
          mediaTick: 0,
        }
        setTabs((previous) => previous.concat([tab]))
        setActiveRel(rel)
        void hydrateTab(tab, entry)
      }, [hydrateTab])

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
        const task = (async () => {
          try {
            const payload = { root: currentRoot, rel: tab.rel, content }
            if (opts.force !== true && tab.mtimeMs > 0) payload.baseMtimeMs = tab.mtimeMs
            const data = await call('write', payload)
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
          call('stat', { root, rel: activeRel }).then((data) => {
            if (cancelled) return
            const entry = data !== null && data !== undefined ? data.entry : null
            const mtimeMs = entry !== null && entry !== undefined ? entry.mtimeMs : undefined
            if (typeof mtimeMs === 'number' && mtimeMs !== activeMtime) patchTab(activeRel, { type: 'external', mtimeMs })
          }).catch(() => {})
        }
        const timer = setInterval(check, STAT_INTERVAL_MS)
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
          E('div', { className: 'wbf-sidebar' },
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
              expanded,
              rows,
              rowLimit,
              showHidden,
              searchQuery: query,
              search,
              activeRel,
              onQueryChange: setQuery,
              onClearSearch: () => setQuery(''),
              onToggleHidden: toggleHidden,
              onRefresh: refreshTree,
              onToggleDir: toggleDir,
              onOpenFile: openEntry,
              onRetryDir: retryDir,
              onShowMore: () => setRowLimit((value) => value + TREE_ROW_LIMIT),
              onOpenSearchResult: openSearchResult,
            })),
          E('div', { className: 'wbf-content' },
            E(TabStrip, {
              t,
              tabs,
              activeRel,
              onActivate: setActiveRel,
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

    /* ============================== registration ============================== */

    const CSS = `
.wbf-root{position:relative;display:flex;flex-direction:column;flex:1 1 auto;height:100%;min-height:0;color:var(--dsw-alias-label-primary,#e6e6e6);background:var(--dsw-alias-bg-base,#14161a);font:inherit;font-size:12px}
.wbf-main{display:flex;flex:1;min-height:0;min-width:0}
.wbf-sidebar{display:flex;flex-direction:column;width:clamp(190px,36%,320px);min-width:170px;min-height:0;border-right:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));background:var(--dsw-alias-bg-layer-1,#1b1e24)}
.wbf-sidebarHead{display:flex;align-items:center;gap:4px;padding:7px 6px 5px}
.wbf-rootChip{display:flex;align-items:center;gap:5px;flex:1;min-width:0;height:26px;padding:0 7px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));border-radius:6px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.05));color:inherit;font:inherit;font-size:11px;cursor:pointer}
.wbf-rootChip:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}
.wbf-rootName{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.wbf-sideActions{display:flex;gap:2px;flex:none}
.wbf-iconBtn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:none;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary,#b6bac1);cursor:pointer}
.wbf-iconBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));color:var(--dsw-alias-label-primary,#e6e6e6)}
.wbf-iconBtn.is-active{color:var(--dsw-alias-brand-primary,#4d6bfe)}
.wbf-iconBtn.is-danger:hover{color:var(--dsw-alias-state-error-primary,#ff6b6b)}
.wbf-iconBtn:disabled{opacity:.35;cursor:default}
.wbf-searchRow{display:flex;align-items:center;gap:4px;padding:2px 8px 6px}
.wbf-searchIcon{flex:none;color:var(--dsw-alias-label-tertiary,#8a8f98)}
.wbf-searchInput{flex:1;min-width:0;height:24px;padding:0 7px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));border-radius:6px;background:var(--dsw-alias-bg-base,#14161a);color:inherit;font:inherit;font-size:11px}
.wbf-searchInput:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#4d6bfe)}
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
.wbf-searchRow{display:flex;align-items:center;gap:6px;width:100%;padding:4px 7px;border:none;border-radius:4px;background:transparent;color:var(--dsw-alias-label-primary,#e6e6e6);font:inherit;font-size:11px;text-align:left;cursor:pointer}
.wbf-searchRow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.wbf-searchName{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wbf-searchDir{flex:none;max-width:48%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:10px}
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
.wbf-pre{margin:0;padding:10px 12px;font-family:var(--dsw-font-markdown-code-block,ui-monospace,monospace);font-size:12px;line-height:1.55;white-space:pre;overflow:auto;tab-size:2}
.wbf-editor{display:flex;flex-direction:column;flex:1;min-height:0}
.wbf-editorHost{flex:1;min-height:0;overflow:hidden}
.wbf-editorFallback.is-hidden{display:none}
.wbf-md{padding:12px 16px;line-height:1.65;overflow:auto;word-break:break-word}
.wbf-md h1,.wbf-md h2,.wbf-md h3,.wbf-md h4,.wbf-md h5,.wbf-md h6{margin:1em 0 .45em;line-height:1.3}
.wbf-md h1{font-size:1.5em}.wbf-md h2{font-size:1.3em}.wbf-md h3{font-size:1.15em}.wbf-md h4,.wbf-md h5,.wbf-md h6{font-size:1em}
.wbf-md p{margin:.55em 0}
.wbf-md ul,.wbf-md ol{margin:.55em 0;padding-left:1.6em}
.wbf-md li{margin:.18em 0}
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
.wbf-emptyWorkspace{flex:1}
.wbf-emptyRecent{display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:5px;margin-top:3px}
.wbf-recentChip{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:2px 9px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary,#b6bac1);font:inherit;font-size:11px;cursor:pointer}
.wbf-recentChip:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}
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
.wbf-libInput:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#4d6bfe)}
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
            icon: (size) => E(Icon, { name: 'files', size: size === undefined ? 16 : size }),
            component: () => E(LocaleLive, { ctx, t }),
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
      workspaceNameOf,
      parseStoredRoot,
      browseEntryPath,
      reduceTab,
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
