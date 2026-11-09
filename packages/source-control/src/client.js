/**
 * dsh-workbay-source-control - client half (plain JavaScript, no build step).
 *
 * ONE file, loaded through `window.__ModuleLoader__.load({ id, factory })`.
 * Registers ONE workbench page (`id: 'source-control'`, order 15) into the
 * dock's `window.__DSH_WORKBAY__` page registry.
 *
 * ── What this page is ─────────────────────────────────────────────────────
 *
 * The Explorer and the Source Control view, in one pane: a SINGLE tree that
 * carries git status, and a content area beside it that shows either the file
 * or its diff. The user's job is "see what changed -> see the diff -> change
 * the code -> commit", and before this page that meant switching tabs twice.
 *
 * ── Why it owns its own tree ──────────────────────────────────────────────
 *
 * The obvious design is "let the files page render the tree, pass the changes
 * down". That is wrong here: the files page's tree knows only its own `entry`
 * shape, so making it paint git badges + stage buttons would push git semantics
 * into a component that has no business knowing them.
 *
 * So the shell renders the tree ITSELF, from two sources it reads directly:
 *
 *   POST /dsh-workbay-files/api/tree    -> directories and files
 *   POST /dsh-gitcraft/api/snapshot     -> branch, counts, per-path status
 *
 * One renderer, one scroll surface, one selection model, one place where a
 * path is joined. The two panes (editor / diff) are still the ORIGINAL
 * components, mounted into containers this page owns via `createRoot` - that is
 * what keeps the failure domains separate and keeps this page from having to
 * understand how to edit a file or parse a patch.
 *
 * ── What it does not do ───────────────────────────────────────────────────
 *
 * No routes, no git subprocesses, no filesystem access. Every byte comes from
 * the two hosts that already own those capabilities, behind their existing
 * security fences. This page is presentation + orchestration.
 *
 * ── Sizing ────────────────────────────────────────────────────────────────
 *
 * The pane width decides the layout, measured on THIS element (not the
 * viewport): the workbench can be a 360px docked column or a 1400px float.
 *
 *   XS  < 480   one column, drill-in (tree replaces the content area)
 *   S   480-719 tree 200-260, content rest, diff unified
 *   M   720-1023 tree 240-300, content rest, diff split
 *   L   >= 1024 tree 280 fixed (draggable 240-360), content rest, diff split
 *
 * No width ever gets a third column. Extra width goes to a split diff, not to a
 * second copy of the file list.
 */
window.__ModuleLoader__.load({
  id: 'dsh-workbay-source-control',
  factory: (require) => {
    const React = require('react')
    const E = React.createElement
    const Fragment = React.Fragment
    const useState = React.useState
    const useEffect = React.useEffect
    const useMemo = React.useMemo
    const useRef = React.useRef
    const useCallback = React.useCallback

    const PAGE_ID = 'source-control'
    const FILES_PREFIX = '/dsh-workbay-files/api/'
    const GIT_PREFIX = '/dsh-gitcraft/api/'
    const LOCALE_NS = 'dsh-workbay-source-control'

    /* localStorage keys. Deliberately NEW ones: `dsh-workbay.root.v1` belongs to
       the files page and `dsh-gitcraft.ref.v1` to the git page. While all three
       pages coexist (they do, until the old two are retired) this page must not
       fight them for the same slot, and the two existing values are NOT the same
       thing: the workspace root can be an ancestor of the repository root. */
    const idle = (key) => ({ status: 'idle', [key]: [], error: null })

/* Cross-mount cache.
 *
 * The dock mounts only the ACTIVE page (`E(current.component)`), so switching to
 * Downloader and back remounts this page from scratch: every read — status, log,
 * branches, stash — runs again, and the user stares at skeletons for a second.
 * Keeping the last result at module scope makes the return instant: the state is
 * seeded from it, then refreshed in the background.
 *
 * Keyed by workspace root so a different repository never shows another one's data.
 */
const PAGE_CACHE = {
  root: '',
  at: 0,
  snapshot: null,
  history: idle('commits'),
  branches: idle('branches'),
  stash: idle('stash'),
}
const PAGE_CACHE_MAX_AGE_MS = 10 * 60 * 1000

function readPageCache() {
  const stored = (() => {
    try { return window.localStorage.getItem(ROOT_KEY) || '' } catch (error) { return '' }
  })()
  const fresh = Date.now() - PAGE_CACHE.at < PAGE_CACHE_MAX_AGE_MS
  if (PAGE_CACHE.root !== '' && PAGE_CACHE.root === stored && fresh === true) return PAGE_CACHE
  return { snapshot: null, history: idle('commits'), branches: idle('branches'), stash: idle('stash') }
}

function writePageCache(patch) {
  PAGE_CACHE.at = Date.now()
  for (const key of Object.keys(patch)) PAGE_CACHE[key] = patch[key]
}
const RECENT_ROOTS_KEY = 'dsh-workbay.sc.recent-roots.v1'
const RECENT_ROOTS_MAX = 8

/** 最近打开过的工作目录（新的在前）。宿主只记得当前一个，历史由这里负责。 */
function readRecentRoots() {
  try {
    const raw = window.localStorage.getItem(RECENT_ROOTS_KEY)
    if (raw === null || raw === undefined) return []
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed) === false) return []
    return parsed.filter((entry) => typeof entry === 'string' && entry !== '').slice(0, RECENT_ROOTS_MAX)
  } catch (error) {
    return []
  }
}

function rememberRoot(path) {
  const value = typeof path === 'string' ? path.trim() : ''
  if (value === '') return
  try {
    const next = [value].concat(readRecentRoots().filter((entry) => entry !== value)).slice(0, RECENT_ROOTS_MAX)
    window.localStorage.setItem(RECENT_ROOTS_KEY, JSON.stringify(next))
  } catch (error) { void error }
}
const ROOT_KEY = 'dsh-workbay.sc.root.v1'
    const REPO_KEY = 'dsh-workbay.sc.repo.v1'
    const LAYOUT_KEY = 'dsh-workbay.sc.layout.v1'
    const HIDDEN_KEY = 'dsh-workbay.sc.hidden.v1'

    /* Breakpoints, on THIS element's width. 480/720/1024 come from the panel's
       real range: the dock clamps to 360..(viewport-320) and the float to
       520..(viewport-80), so 480 is reachable and must be a real layout. */
    const BP_S = 480
    const BP_M = 720
    const BP_L = 1024
    const TREE_MIN_W = 200
/* Below this the pane's own labels start cutting themselves off. */
const NARROW_PANE_W = 225
    const TREE_MAX_W = 360
    const TREE_DEFAULT_W = 280

    const TREE_ROW_HEIGHT = 22
    const TREE_OVERSCAN = 8

    /* ============================== i18n ============================== */

    const ZH = {
      'page.title': '源码管理',
      'page.description': '一棵带 Git 状态的树，右边是文件或 diff',
      'head.refresh': '刷新',
      'head.aheadHint': '个提交待推送',
      'head.behindHint': '个提交待拉取',
      'head.more': '更多',
      'head.onlyChanges': '只看变更',
      'head.onlyChangesOff': '显示全部文件',
      'group.changes': '变更',
      'group.files': '文件',
      'group.staged': '已暂存',
      'group.unstaged': '更改',
      'group.untracked': '未跟踪',
      'group.conflicted': '冲突',
      'tab.source': '源码',
      'tab.diff': '变更',
      'commit.placeholder': '提交信息（Ctrl+Enter 提交）',
      'commit.button': '提交',
      'commit.amend': '修补上次提交',
      'commit.nothing': '没有可提交的更改',
      'empty.noRoot': '还没有选择工作区',
      'empty.chooseRoot': '选择工作区',
      'empty.noRepo': '这个目录不是 Git 仓库',
      'empty.noRepoHint': '在仓库根目录下打开这个页面，或先初始化一个仓库。',
      'empty.noFile': '从左侧选择一个文件',
      'empty.noFileHint': '改动会在这里显示源码或 diff。',
      'empty.clean': '工作区是干净的',
      'state.loading': '正在加载…',
      'state.failed': '加载失败',
      'state.retry': '重试',
      'state.truncated': '目录过大，已截断',
      'action.stage': '暂存',
      'action.unstage': '取消暂存',
      'action.addToChat': '加入对话',
      'chat.unavailable': '当前没有可写入的对话输入框（请在会话里再试）',
      'action.discard': '丢弃更改',
      'action.open': '打开',
      'conflict.dirtyTitle': '该文件有未保存的修改',
      'conflict.dirtyBody': '丢弃磁盘上的改动不会影响编辑器里未保存的内容，但保存时会把它们写回去。建议先保存或撤销编辑。',
      'conflict.dirtyContinue': '仍然丢弃',
      'action.ok': '确定',
      'action.cancel': '取消',
      'action.back': '返回',
      'conflict.dirtyCancel': '取消',
      'error.unknown': '未知错误',
      'error.dockMissing': '工作台未加载，无法与其他页面通信',
      'search.placeholderName': '按文件名搜索（Esc 清空）',
      'search.placeholderContent': '按内容搜索',
      'search.modeName': '文件名',
      'search.modeContent': '内容',
      'search.modeNameTitle': '模糊匹配路径，命中字符高亮',
      'search.modeContentTitle': '在文件内容里搜索（较慢）',
      'search.clear': '清空搜索',
      'search.noResults': '没有匹配',
      'search.truncated': '结果过多，已截断',
      'mode.changes': '变更',
      'mode.countHint': '个变更',
      'mode.files': '文件',
      'mode.history': '历史',
      'mode.branches': '分支',
      'mode.stash': '贮藏',
      'group.conflicted': '冲突',
      'group.staged': '已暂存',
      'group.unstaged': '更改',
      'group.untracked': '未跟踪',
      'changes.clean': '工作区是干净的',
      'history.empty': '还没有提交',
      'branches.local': '本地分支',
      'branches.remote': '远程分支',
      'branches.tags': '标签',
      'branches.legend': '● 当前分支 · ↑↓ 领先/落后上游 · 点本地分支切换',
      'branches.localHint': '本地分支：可以切换、合并、变基、删除',
      'branches.remoteHint': '远程分支：服务器上的镜像，只读；要切换请先建本地分支',
      'branches.tagHint': '标签：指向某个提交的固定标记，通常用来标记版本',
      'branches.noLocal': '没有本地分支',
      'branches.noRemote': '没有远程分支',
      'branches.noTags': '没有标签',
      'branches.currentHint': '当前分支（点击不会重复切换）',
      'branches.noUpstream': '未设置上游分支',
      'branches.tracks': '跟踪',
      'branches.aheadHint': '领先上游的提交数',
      'branches.behindHint': '落后上游的提交数',      'branches.empty': '没有分支',
      'stash.empty': '贮藏区是空的',
      'action.stageAll': '全部暂存',
      'action.stashPop': '取出',
      'action.stashDrop': '删除',
      'time.justNow': '刚刚',
      'time.minutesAgo': ' 分钟前',
      'time.hoursAgo': ' 小时前',
      'time.daysAgo': ' 天前',
      'commit.files': '文件',
      'commit.showPatch': '查看这次提交对该文件的改动',
      'commit.back': '返回提交',
      'commit.whole': '整个提交',
      'commit.wholeBtn': '完整改动',
      'commit.wholeHint': '把这次提交涉及的所有文件合成一个 patch 查看',
      'diff.modeUnified': '合并查看',
      'search.caseSensitive': '区分大小写',
      'search.wholeWord': '全词匹配',
      'search.regex': '正则表达式',
      'modal.open': '弹窗',
      'modal.close': '退出弹窗',
      'diff.modeSplit': '分栏查看',
      'dir.empty': '空目录',
      'dir.entries': '个条目',
      'dir.pickFile': '从这里选一个文件查看内容或 diff',
      'action.continue': '继续',
      'conflict.ours': '用我的',
      'conflict.oursHint': '用当前分支（ours）这一版解决冲突',
      'conflict.theirs': '用他们的',
      'conflict.theirsHint': '用被合并分支（theirs）那一版解决冲突',
      'conflict.mark': '标记已解决',
      'conflict.markHint': '内容已手工改好，标记为已解决并暂存',
      'action.close': '关闭',
      'action.delete': '删除',
      'action.stageAll': '全部暂存',
      'action.unstageAll': '全部取消暂存',
      'action.discardAll': '全部撤销',
      'action.deleteAll': '全部删除',
      'action.stageGroupTitle': '把这一组全部暂存',
      'action.unstageGroupTitle': '把这一组全部移出暂存',
      'action.discardGroupTitle': '丢弃这一组的未提交修改',
      'action.deleteGroupTitle': '删除这一组的未跟踪文件（不可恢复）',
      'conflict.discardManyTitle': '撤销这些更改？',
      'conflict.discardManyBody': '将丢弃 {n} 个文件里未提交的修改，无法从磁盘恢复。',
      'conflict.deleteManyTitle': '删除这些未跟踪的文件？',
      'conflict.deleteManyBody': '{n} 个文件还没被 git 跟踪，只在磁盘上；删除后无法恢复。',
      'conflict.deleteUntrackedTitle': '删除未跟踪的文件？',
      'conflict.deleteUntrackedBody': ' —— 这个文件还没被 git 跟踪，只在磁盘上；删除后无法从版本库恢复。',
      'action.init': '初始化仓库',
      'action.tagPush': '推送标签…',
      'tag.pushTitle': '推送哪个标签？',
      'tag.pushBody': '本地有、{remote} 上没有的标签。推送标签不可撤销（除非强推）。',
      'tag.allPushed': '所有标签都已推送。',
      'tag.noRemote': '没有配置远端，无法推送标签。',
      'action.tagCreate': '打标签',
      'action.branchCreate': '新建分支',
      'action.newFolder': '新建文件夹',
      'action.new': '新建',
      'root.currentRoot': '当前工作区',
      'root.drives': '磁盘',
      'root.browseFolders': '浏览文件夹',
      'root.go': '前往',
      'root.up': '上一级',
      'root.recent': '最近使用',
      'root.title': '切换工作区目录',
      'root.none': '还没有最近打开过的目录',
      'root.type': '手动输入路径…',
      'root.browse': '浏览文件夹…',
      'root.browseHint': '点文件夹进入，确定后把当前目录作为工作区',
      'root.choose': '用这个目录',
      'root.typeTitle': '输入工作区路径',
      'root.typeBody': '绝对路径，例如 D:\\projects\\app',
      'root.pathLabel': '路径',
      'root.pathPlaceholder': 'D:\\projects\\app',
      'action.stashApply': '应用',
      'action.stashPush': '贮藏',
      'bar.done': '完成：',
      'op.fetch': '获取',
      'op.pull': '拉取',
      'op.push': '推送',
            'op.checkout': '签出',
      'op.checkoutTitle': '建一个同名本地分支并切过去',
      'tag.pushOne': '推送标签',
      'tag.deleteTitle': '删除标签？',
      'tag.deleteBody': '将删除本地标签 {tag}；如果它在远端也存在，也会一并删除。',      'op.merge': '合并',
      'op.mergeTitle': '合并到当前分支',
      'op.mergeBody': '把该分支合并进当前分支。有冲突时会停下来等解决。',
      'op.rebase': '变基',
      'op.rebaseTitle': '把当前分支变基到',
      'op.rebaseBody': '会重写当前分支的提交。已经推送过的分支慎用。',
      'op.cherryPick': '拣选',
      'op.cherryPickHint': '把这个提交的改动应用到当前分支',
      'op.revert': '还原',
      'op.revertTitle': '还原提交',
      'op.revertBody': '生成一个新提交来抵消它的改动：',
      'op.revertHint': '生成一个反向提交来抵消这次改动',
      'op.reset': '复位',
      'op.resetTitle': '复位到',
      'op.resetBody': '当前分支会移动到该提交。软/混合保留改动，硬会丢弃。',
      'op.resetHint': '把当前分支移动到这个提交',
      'op.resetSoft': '软复位（保留暂存与改动）',
      'op.resetSoftHint': '分支移动，暂存区和工作区都不动',
      'op.resetMixed': '混合复位（保留改动）',
      'op.resetMixedHint': '分支移动，暂存区清空，工作区不动',
      'op.resetHard': '硬复位（丢弃改动）',
      'op.resetHardHint': '分支移动，暂存区和工作区都被丢弃',
      'op.resetHardTitle': '确认硬复位？',
      'op.resetHardBody': '未提交的改动会永久丢失，无法撤销。',
      'op.continue': '继续',
      'op.abort': '中止',
      'op.abortTitle': '确认中止？',
      'op.abortBody': '会回到操作开始前的状态，已做的解决会被丢弃。',
      'op.inMerge': '正在合并',
      'op.inRebase': '正在变基',
      'op.inCherryPick': '正在拣选',
      'op.inRevert': '正在还原',
      'repo.initTitle': '初始化仓库',
      'repo.initBody': '在当前工作区执行 git init。已有仓库不受影响。',
      'branch.createTitle': '新建分支',
      'branch.createBody': '从当前 HEAD 创建并切换。',
      'branch.nameLabel': '分支名',
      'branch.namePlaceholder': 'feature/my-change',
      'branch.deleteTitle': '删除分支',
      'branch.deleteBody': '只删除本地分支，已合并的才能删。',
      'tag.createTitle': '新建标签',
      'tag.createBody': '给提交打标签：',
      'tag.createBodyHead': '给当前 HEAD 打标签。',
      'tag.nameLabel': '标签名',
      'tag.namePlaceholder': 'v1.0.0',
      'stash.pushTitle': '贮藏更改',
      'stash.pushBody': '把未提交的改动收进贮藏区，工作区会变干净。',
      'stash.messageLabel': '说明（可留空）',
      'stash.messagePlaceholder': '做到一半的功能',
      'file.newFile': '新建文件',
      'file.newFolderTitle': '新建文件夹',
      'file.newFileTitle': '新建文件',
      'file.newAtRoot': '在工作区根目录创建',
      'file.newIn': '在',
      'file.nameLabel': '名称',
      'file.namePlaceholder': 'name.ts',
      'file.rename': '重命名',
      'file.renameTitle': '重命名',
      'file.delete': '删除',
      'file.deleteTitle': '确认删除？',
      'tab.history': '历史',
      'tab.blame': '逐行作者',
      'tab.blameHint': '逐行显示最后是谁改的（git blame）',
      'history.fileEmpty': '这个文件还没有提交历史',
      'blame.empty': '没有追责信息',
    }

    const EN = {
      'page.title': 'Source Control',
      'page.description': 'One tree with git status, and the file or its diff beside it',
      'head.refresh': 'Refresh',
      'head.aheadHint': 'commits to push',
      'head.behindHint': 'commits to pull',
      'head.more': 'More',
      'head.onlyChanges': 'Changes only',
      'head.onlyChangesOff': 'Show all files',
      'group.changes': 'Changes',
      'group.files': 'Files',
      'group.staged': 'Staged',
      'group.unstaged': 'Changes',
      'group.untracked': 'Untracked',
      'group.conflicted': 'Conflicts',
      'tab.source': 'Source',
      'tab.diff': 'Changes',
      'commit.placeholder': 'Commit message (Ctrl+Enter to commit)',
      'commit.button': 'Commit',
      'commit.amend': 'Amend last commit',
      'commit.nothing': 'Nothing to commit',
      'empty.noRoot': 'No workspace selected yet',
      'empty.chooseRoot': 'Choose a workspace',
      'empty.noRepo': 'This directory is not a git repository',
      'empty.noRepoHint': 'Open this page inside a repository, or initialise one first.',
      'empty.noFile': 'Pick a file on the left',
      'empty.noFileHint': 'Its source or diff appears here.',
      'empty.clean': 'The working tree is clean',
      'state.loading': 'Loading…',
      'state.failed': 'Could not load',
      'state.retry': 'Retry',
      'state.truncated': 'Directory too large, truncated',
      'action.stage': 'Stage',
      'action.unstage': 'Unstage',
      'action.addToChat': 'Add to chat',
      'chat.unavailable': 'No conversation input to write into',
      'action.discard': 'Discard changes',
      'action.open': 'Open',
      'conflict.dirtyTitle': 'This file has unsaved edits',
      'conflict.dirtyBody': 'Discarding the on-disk change will not touch the unsaved buffer, but saving will write it back. Save or revert the edit first.',
      'conflict.dirtyContinue': 'Discard anyway',
      'action.ok': 'OK',
      'action.cancel': 'Cancel',
      'action.back': 'Back',
      'conflict.dirtyCancel': 'Cancel',
      'error.unknown': 'Unknown error',
      'error.dockMissing': 'The workbench is not loaded; pages cannot be composed',
      'search.placeholderName': 'Search file names (Esc to clear)',
      'search.placeholderContent': 'Search file contents',
      'search.modeName': 'Files',
      'search.modeContent': 'Content',
      'search.modeNameTitle': 'Fuzzy path match, matched characters highlighted',
      'search.modeContentTitle': 'Search inside files (slower)',
      'search.clear': 'Clear search',
      'search.noResults': 'No matches',
      'search.truncated': 'Too many results, truncated',
      'mode.changes': 'Changes',
      'mode.countHint': 'changes',
      'mode.files': 'Files',
      'mode.history': 'History',
      'mode.branches': 'Branches',
      'mode.stash': 'Stash',
      'group.conflicted': 'Conflicts',
      'group.staged': 'Staged',
      'group.unstaged': 'Changes',
      'group.untracked': 'Untracked',
      'changes.clean': 'The working tree is clean',
      'history.empty': 'No commits yet',
      'history.tagRef': 'tag',
      'history.loadMore': 'Load more commits',
      'branches.local': 'Local branches',
      'branches.remote': 'Remote branches',
      'branches.tags': 'Tags',
      'branches.legend': '● current · ↑↓ ahead/behind upstream · click a local branch to switch',
      'branches.localHint': 'Local branches: switch, merge, rebase or delete',
      'branches.remoteHint': 'Remote branches: read-only mirrors of the server; create a local branch to switch',
      'branches.tagHint': 'Tags: fixed labels on a commit, usually marking a release',
      'branches.noLocal': 'No local branches',
      'branches.noRemote': 'No remote branches',
      'branches.noTags': 'No tags',
      'branches.currentHint': 'Current branch (clicking will not switch again)',
      'branches.noUpstream': 'No upstream configured',
      'branches.tracks': 'tracks',
      'branches.aheadHint': 'Commits ahead of upstream',
      'branches.behindHint': 'Commits behind upstream',      'branches.empty': 'No branches',
      'stash.empty': 'Nothing stashed',
      'action.stageAll': 'Stage all',
      'action.stashPop': 'Pop',
      'action.stashDrop': 'Drop',
      'time.justNow': 'just now',
      'time.minutesAgo': 'm ago',
      'time.hoursAgo': 'h ago',
      'time.daysAgo': 'd ago',
      'commit.files': 'Files',
      'commit.showPatch': 'Show what this commit did to the file',
      'commit.back': 'Back to commit',
      'commit.whole': 'Whole commit',
      'commit.wholeBtn': 'All changes',
      'commit.wholeHint': 'Show every touched file as one merged patch',
      'diff.modeUnified': 'Unified',
      'search.caseSensitive': 'Match case',
      'search.wholeWord': 'Whole word',
      'search.regex': 'Regex',
      'modal.open': 'Open in a window',
      'modal.close': 'Close window',
      'diff.modeSplit': 'Split',
      'dir.empty': 'Empty directory',
      'dir.entries': 'entries',
      'dir.pickFile': 'Pick a file to see its content or diff',
      'action.continue': 'Continue',
      'conflict.ours': 'Use ours',
      'conflict.oursHint': 'Resolve with the current branch version',
      'conflict.theirs': 'Use theirs',
      'conflict.theirsHint': 'Resolve with the incoming branch version',
      'conflict.mark': 'Mark resolved',
      'conflict.markHint': 'Content is already fixed by hand; mark resolved and stage',
      'action.close': 'Close',
      'action.delete': 'Delete',
      'action.stageAll': 'Stage all',
      'action.unstageAll': 'Unstage all',
      'action.discardAll': 'Discard all',
      'action.deleteAll': 'Delete all',
      'action.stageGroupTitle': 'Stage every file in this group',
      'action.unstageGroupTitle': 'Move every file in this group out of the index',
      'action.discardGroupTitle': 'Discard uncommitted changes in this group',
      'action.deleteGroupTitle': 'Delete the untracked files in this group (cannot be undone)',
      'conflict.discardManyTitle': 'Discard these changes?',
      'conflict.discardManyBody': 'Uncommitted changes in {n} files will be thrown away and cannot be recovered from disk.',
      'conflict.deleteManyTitle': 'Delete these untracked files?',
      'conflict.deleteManyBody': '{n} files are untracked — they exist only on disk, and deleting them cannot be undone.',
      'conflict.deleteUntrackedTitle': 'Delete this untracked file?',
      'conflict.deleteUntrackedBody': ' — git does not track this file, so deleting it cannot be undone from history.',
      'action.init': 'Initialize',
      'action.tagPush': 'Push tags…',
      'tag.pushTitle': 'Push which tag?',
      'tag.pushBody': 'Tags that exist locally but not on {remote}. A pushed tag cannot be undone without a force-push.',
      'tag.allPushed': 'Every tag is already on the remote.',
      'tag.noRemote': 'No remote configured, so tags cannot be pushed.',
      'action.tagCreate': 'Tag',
      'action.branchCreate': 'New branch',
      'action.newFolder': 'New folder',
      'action.new': 'New',
      'root.currentRoot': 'Current workspace',
      'root.drives': 'Drives',
      'root.browseFolders': 'Browse folders',
      'root.go': 'Go',
      'root.up': 'Up one level',
      'root.recent': 'Recent',
      'root.title': 'Switch workspace folder',
      'root.none': 'No recent folders yet',
      'root.type': 'Type a path…',
      'root.browse': 'Browse folders…',
      'root.browseHint': 'Click a folder to enter; OK uses the current folder',
      'root.choose': 'Use this folder',
      'root.typeTitle': 'Workspace path',
      'root.typeBody': 'An absolute path, e.g. D:\\projects\\app',
      'root.pathLabel': 'Path',
      'root.pathPlaceholder': 'D:\\projects\\app',
      'action.stashApply': 'Apply',
      'action.stashPush': 'Stash',
      'bar.done': 'Done:',
      'op.fetch': 'Fetch',
      'op.pull': 'Pull',
      'op.push': 'Push',
            'op.checkout': 'Check out',
      'op.checkoutTitle': 'Create a local branch from this remote branch and switch to it',
      'tag.pushOne': 'Push',
      'tag.deleteTitle': 'Delete this tag?',
      'tag.deleteBody': 'Deletes the local tag {tag}, and the copy on the remote when it exists there too.',      'op.merge': 'Merge',
      'op.mergeTitle': 'Merge into the current branch',
      'op.mergeBody': 'Merges that branch into the current one. Conflicts stop and wait for you.',
      'op.rebase': 'Rebase',
      'op.rebaseTitle': 'Rebase the current branch onto',
      'op.rebaseBody': 'Rewrites the current branch commits. Avoid on a branch you already pushed.',
      'op.cherryPick': 'Cherry-pick',
      'op.cherryPickHint': 'Apply this commit onto the current branch',
      'op.revert': 'Revert',
      'op.revertTitle': 'Revert commit',
      'op.revertBody': 'Creates a new commit undoing it:',
      'op.revertHint': 'Create an inverse commit undoing this change',
      'op.reset': 'Reset',
      'op.resetTitle': 'Reset to',
      'op.resetBody': 'Moves the current branch to that commit. Soft/mixed keep your work, hard discards it.',
      'op.resetHint': 'Move the current branch to this commit',
      'op.resetSoft': 'Soft (keep index and worktree)',
      'op.resetSoftHint': 'Only the branch moves',
      'op.resetMixed': 'Mixed (keep worktree)',
      'op.resetMixedHint': 'Branch moves, index clears, worktree untouched',
      'op.resetHard': 'Hard (discard changes)',
      'op.resetHardHint': 'Branch moves and both index and worktree are discarded',
      'op.resetHardTitle': 'Hard reset?',
      'op.resetHardBody': 'Uncommitted changes are lost permanently.',
      'op.continue': 'Continue',
      'op.abort': 'Abort',
      'op.abortTitle': 'Abort?',
      'op.abortBody': 'Returns to the state before the operation; resolutions you made are discarded.',
      'op.inMerge': 'Merging',
      'op.inRebase': 'Rebasing',
      'op.inCherryPick': 'Cherry-picking',
      'op.inRevert': 'Reverting',
      'repo.initTitle': 'Initialize repository',
      'repo.initBody': 'Runs git init in the current workspace. An existing repository is untouched.',
      'branch.createTitle': 'New branch',
      'branch.createBody': 'Create from the current HEAD and switch to it.',
      'branch.nameLabel': 'Branch name',
      'branch.namePlaceholder': 'feature/my-change',
      'branch.deleteTitle': 'Delete branch',
      'branch.deleteBody': 'Deletes the local branch only; merged branches only.',
      'tag.createTitle': 'Create tag',
      'tag.createBody': 'Tag this commit:',
      'tag.createBodyHead': 'Tag the current HEAD.',
      'tag.nameLabel': 'Tag name',
      'tag.namePlaceholder': 'v1.0.0',
      'stash.pushTitle': 'Stash changes',
      'stash.pushBody': 'Parks uncommitted changes in the stash; the worktree becomes clean.',
      'stash.messageLabel': 'Message (optional)',
      'stash.messagePlaceholder': 'work in progress',
      'file.newFile': 'New file',
      'file.newFolderTitle': 'New folder',
      'file.newFileTitle': 'New file',
      'file.newAtRoot': 'Create in the workspace root',
      'file.newIn': 'In',
      'file.nameLabel': 'Name',
      'file.namePlaceholder': 'name.ts',
      'file.rename': 'Rename',
      'file.renameTitle': 'Rename',
      'file.delete': 'Delete',
      'file.deleteTitle': 'Delete?',
      'tab.history': 'History',
      'tab.blame': 'Blame',
      'tab.blameHint': 'Who last touched each line (git blame)',
      'history.fileEmpty': 'No commit history for this file yet',
      'blame.empty': 'No blame information',
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

    /* ============================== paths ============================== */

    /**
     * Normalise to the POSIX, workspace-relative form the file host speaks.
     * The two hosts disagree about what a path is relative to (see joinKey), but
     * they agree on the separator, so every path in this page is POSIX.
     */
    function normalizeRel(value) {
      return String(value === undefined || value === null ? '' : value)
        .replace(/\\/g, '/')
        .replace(/^\/+/, '')
        .replace(/\/+$/, '')
    }

    function joinRel(directory, name) {
      const dir = normalizeRel(directory)
      const leaf = normalizeRel(name)
      if (dir === '') return leaf
      if (leaf === '') return dir
      return dir + '/' + leaf
    }

    function baseNameOf(rel) {
      const clean = normalizeRel(rel)
      const index = clean.lastIndexOf('/')
      return index < 0 ? clean : clean.slice(index + 1)
    }

    function dirNameOf(rel) {
      const clean = normalizeRel(rel)
      const index = clean.lastIndexOf('/')
      return index < 0 ? '' : clean.slice(0, index)
    }

    function extensionOf(rel) {
      const base = baseNameOf(rel)
      const dot = base.lastIndexOf('.')
      if (dot <= 0 || dot === base.length - 1) return ''
      return base.slice(dot + 1).toLowerCase()
    }

    /**
     * The JOIN between the two data sources.
     *
     * The files host reports paths relative to the WORKSPACE root; the git host
     * reports paths relative to the REPOSITORY root. They are equal only when
     * the repository root IS the workspace root.
     *
     * In a workspace that contains several repositories (which the git page
     * explicitly supports) they are NOT equal: the tree says `repo-a/src/x.ts`
     * and the snapshot says `src/x.ts`. Joining them without translating would
     * silently show every file as clean — no error, just wrong.
     *
     * `repoRootRel` is the repository root expressed as a workspace-relative
     * path; `''` means "the repository root is the workspace root", which makes
     * every conversion the identity.
     */
    function repoRootRelative(rootAbs, repoAbs) {
      const root = normalizeRel(String(rootAbs === undefined || rootAbs === null ? '' : rootAbs))
      const repo = normalizeRel(String(repoAbs === undefined || repoAbs === null ? '' : repoAbs))
      if (root === '' || repo === '') return null
      if (root === repo) return ''
      /* Case-insensitive on Windows; the hosts already normalise separators. */
      const rootLower = root.toLowerCase() + '/'
      const repoLower = repo.toLowerCase()
      if (repoLower === rootLower.slice(0, -1)) return ''
      if (repoLower.startsWith(rootLower) === false) return null /* repo outside the workspace */
      return repo.slice(rootLower.length)
    }

    /** workspace-relative -> repository-relative (or null when not in the repo). */
    function toRepoPath(rel, repoRootRel) {
      const clean = normalizeRel(rel)
      if (repoRootRel === null) return null
      if (repoRootRel === '') return clean
      const prefix = repoRootRel + '/'
      if (clean === repoRootRel) return ''
      if (clean.startsWith(prefix) === false) return null
      return clean.slice(prefix.length)
    }

    /** repository-relative -> workspace-relative (or null when unrepresentable). */
    function toWorkspaceRel(path, repoRootRel) {
      const clean = normalizeRel(path)
      if (repoRootRel === null) return null
      if (repoRootRel === '') return clean
      return clean === '' ? repoRootRel : repoRootRel + '/' + clean
    }

    /* ============================== git status ============================== */

    /**
     * One letter per path. This is the ONLY place the badge vocabulary lives,
     * and it is a single letter on purpose: a second badge on the same row is
     * what turns a tree into a Christmas tree.
     *
     * Precedence mirrors what a person needs to know first: a conflict blocks
     * everything, then "new", then "gone", then "renamed", then "modified".
     */
    function statusLetterOf(change) {
      if (change === null || change === undefined) return ''
      if (change.conflicted === true) return 'C'
      if (change.untracked === true) return 'U'
      const kind = typeof change.kind === 'string' ? change.kind : ''
      if (kind === 'added' || kind === 'copied') return 'A'
      if (kind === 'deleted') return 'D'
      if (kind === 'renamed') return 'R'
      if (kind === 'typechange') return 'T'
      return 'M'
    }

    function statusColorClass(letter) {
      if (letter === 'C') return 'is-conflict'
      if (letter === 'U') return 'is-untracked'
      if (letter === 'A') return 'is-added'
      if (letter === 'D') return 'is-deleted'
      if (letter === 'R') return 'is-renamed'
      return 'is-modified'
    }

    /**
     * Build the lookup the tree paints from, keyed by WORKSPACE-relative path so
     * the tree never has to think about which host a row came from.
     */
    function buildStatusIndex(snapshot, repoRootRel) {
      const index = new Map()
      if (snapshot === null || snapshot === undefined || Array.isArray(snapshot.changes) === false) return index
      for (const change of snapshot.changes) {
        if (change === null || change === undefined || typeof change.path !== 'string') continue
        const rel = toWorkspaceRel(change.path, repoRootRel)
        if (rel === null || rel === '') continue
        index.set(rel, change)
      }
      return index
    }

    /**
     * Group changes the way every git UI does, for a reason: the four groups mean
     * four DIFFERENT next actions.
     *
     *   conflicted → resolve it, nothing else works
     *   staged     → it is going into the next commit; you may want to unstage
     *   unstaged   → it is NOT going in until you stage it
     *   untracked  → it is not in git at all; staging is the whole job
     *
     * A flat list sorted by path hides that difference, and "why didn't my commit
     * include that file" is the single most common git confusion.
     *
     * Order is deliberate: what blocks you, then what is ready, then what is not.
     */
    function buildChangeGroups(statusIndex) {
      const conflicted = []
      const staged = []
      const unstaged = []
      const untracked = []
      for (const [rel, change] of statusIndex) {
        if (change === null || change === undefined) continue
        if (change.conflicted === true) { conflicted.push({ rel, change }); continue }
        if (change.untracked === true) { untracked.push({ rel, change }); continue }
        if (change.staged === true) staged.push({ rel, change })
        else unstaged.push({ rel, change })
      }
      const byName = (left, right) => (left.rel < right.rel ? -1 : left.rel > right.rel ? 1 : 0)
      conflicted.sort(byName)
      staged.sort(byName)
      unstaged.sort(byName)
      untracked.sort(byName)
      return [
        { key: 'conflicted', rows: conflicted },
        { key: 'staged', rows: staged },
        { key: 'unstaged', rows: unstaged },
        { key: 'untracked', rows: untracked },
      ]
    }

    /**
     * "3 minutes ago" instead of a timestamp.
     *
     * A commit list is read to answer "how old is this?", and an absolute
     * timestamp makes the reader do date arithmetic. Falls back to the date when
     * the value is implausible (a clock skew or a bad parse) rather than printing
     * "in 1970".
     */
    /**
     * Lay out a commit graph.
     *
     * A flat list of rows loses the one thing history is for: which commit came from
     * which. `git log --pretty=%P` already returns parents, so the lanes are
     * computable without another git call.
     *
     * Model: `lanes[j]` is the commit lane j is still waiting for. Walking newest
     * first, a commit lands in the lane whose expectation matches its hash (or the
     * first free lane); that lane is re-pointed at its first parent, and each extra
     * parent opens — or joins — a lane below it. Colours key off the lane index so a
     * line keeps its colour from top to bottom.
     */
    function buildCommitGraph(commits) {
      const rows = []
      let lanes = []
      for (const commit of commits) {
        const parents = Array.isArray(commit.parents) ? commit.parents.filter((entry) => entry !== '') : []
        const before = lanes.slice()
        let node = before.indexOf(commit.hash)
        if (node < 0) node = before.length
        lanes = before.slice()
        while (lanes.length <= node) lanes.push(null)
        /* 第一个父节点如果已经出现在别的泳道上，说明这个分支在这里汇合 —— 本泳道
       到此结束（置 null），而不是把父节点再写一遍。重复会让同一条线被画两次，
       然后一路延伸下去：屏幕上就是一条永远没有节点的幽灵竖线。 */
    const firstParent = parents.length > 0 ? parents[0] : null
    lanes[node] = firstParent
    /* 父节点若已存在于别的泳道，说明两条线在这一行汇合：保留本泳道的延续，
       把「另一条」置 null —— 反过来做（结束本泳道）会把这条线整根掐断，
       屏幕上就是「上面的线还在、下面突然没了」。 */
    if (firstParent !== null) {
      for (let index = 0; index < lanes.length; index += 1) {
        if (index !== node && lanes[index] === firstParent) lanes[index] = null
      }
    }
        for (let index = 1; index < parents.length; index += 1) {
          if (lanes.indexOf(parents[index]) < 0) lanes.push(parents[index])
        }
        /* Trim empty lanes at the TAIL only: a hole in the middle must keep its index,
           or the lines would jump sideways between adjacent rows. */
        while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop()
        rows.push({ commit, node, before, after: lanes.slice() })
      }
      return rows
    }

    function relativeTime(ms, t) {
      const value = Number(ms)
      if (Number.isFinite(value) === false || value <= 0) return ''
      const delta = Date.now() - value
      if (delta < 0) return new Date(value).toLocaleDateString()
      const minute = 60_000
      const hour = 60 * minute
      const day = 24 * hour
      if (delta < minute) return t('time.justNow')
      if (delta < hour) return Math.floor(delta / minute) + t('time.minutesAgo')
      if (delta < day) return Math.floor(delta / hour) + t('time.hoursAgo')
      if (delta < 30 * day) return Math.floor(delta / day) + t('time.daysAgo')
      return new Date(value).toLocaleDateString()
    }

    /** A menu entry. Pure, so it can be built anywhere including before render. */
    function menuItem(label, onSelect, options) {
      const opts = options === undefined || options === null ? {} : options
      return { label, danger: opts.danger === true, disabled: opts.disabled === true, onSelect }
    }

    /** Directories that contain at least one change, so they can show a dot. */
    function buildDirtyDirs(statusIndex) {
      const dirty = new Set()
      for (const rel of statusIndex.keys()) {
        let dir = dirNameOf(rel)
        while (dir !== '') {
          if (dirty.has(dir) === true) break
          dirty.add(dir)
          dir = dirNameOf(dir)
        }
      }
      return dirty
    }

    /**
     * Paint the fuzzy-match characters the host already scored.
     *
     * The host returns `indices` into the FULL `rel`, so a basename-only highlight
     * has to shift them by the directory prefix length. Doing it here (rather than
     * re-matching in the client) keeps one opinion about what matched.
     */
    function highlightName(name, indices, rel) {
      if (Array.isArray(indices) === false || indices.length === 0) return name
      const clean = normalizeRel(rel)
      const prefixLength = clean.length - name.length
      const marks = new Set()
      for (const raw of indices) {
        const index = typeof raw === 'number' ? raw - prefixLength : -1
        if (index >= 0 && index < name.length) marks.add(index)
      }
      if (marks.size === 0) return name
      const parts = []
      let run = ''
      let runMatched = false
      for (let index = 0; index < name.length; index += 1) {
        const matched = marks.has(index)
        if (matched !== runMatched && run !== '') {
          parts.push(runMatched ? E('mark', { key: parts.length, className: 'scw-hit' }, run) : run)
          run = ''
        }
        runMatched = matched
        run += name.charAt(index)
      }
      if (run !== '') parts.push(runMatched ? E('mark', { key: parts.length, className: 'scw-hit' }, run) : run)
      return parts
    }

    /* ============================== tree rows ============================== */

    /**
     * Flatten the lazily-loaded directory map into one render list.
     *
     * `dirs` maps a workspace-relative directory ('' is the root) to
     * `{ status, entries, truncated, error }`. Only expanded directories are
     * descended into. Directories first, then files, case-insensitive.
     *
     * Rows carry everything the renderer and the virtualiser need, and nothing
     * else: a row is cheap because a row is small.
     */
    function flattenTree(dirs, expanded, options) {
      const state = dirs !== null && typeof dirs === 'object' ? dirs : {}
      const open = expanded instanceof Set ? expanded : new Set(Array.isArray(expanded) ? expanded : [])
      const opts = options !== null && typeof options === 'object' ? options : {}
      const statusIndex = opts.statusIndex instanceof Map ? opts.statusIndex : new Map()
      const dirtyDirs = opts.dirtyDirs instanceof Set ? opts.dirtyDirs : new Set()
      const onlyChanges = opts.onlyChanges === true
      const collator = opts.collator
      /* Natural order ("file2" before "file10") is what a file tree wants, and it
         must hold even when no collator is injected — the default path used to
         fall back to a plain localeCompare, so `file10` sorted before `file2` and
         the tree disagreed with the files page about the same directory. */
      const compare = collator !== undefined && collator !== null && typeof collator.compare === 'function'
        ? (left, right) => collator.compare(left, right)
        : (() => {
          const fallback = (() => {
            try { return new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }) } catch (error) { void error; return null }
          })()
          if (fallback !== null) return (left, right) => fallback.compare(String(left), String(right))
          return (left, right) => String(left).localeCompare(String(right))
        })()
      const rows = []

      const sortEntries = (entries) => {
        const list = Array.isArray(entries) ? entries.slice() : []
        list.sort((left, right) => {
          const leftDir = left !== null && left !== undefined && left.type === 'dir'
          const rightDir = right !== null && right !== undefined && right.type === 'dir'
          if (leftDir !== rightDir) return leftDir ? -1 : 1
          const byName = compare(left === undefined || left === null ? '' : left.name, right === undefined || right === null ? '' : right.name)
          if (byName !== 0) return byName
          return compare(left === undefined || left === null ? '' : left.rel, right === undefined || right === null ? '' : right.rel)
        })
        return list
      }

      const walk = (dirRel, depth, group) => {
        const node = state[dirRel]
        /**
         * A directory that is not ready emits NOTHING — correct for a collapsed
         * child, wrong for the ROOT: the root always exists on screen, and
         * returning silently left the whole pane blank with no spinner and no
         * explanation. A blank pane is indistinguishable from "there is nothing
         * here", which is the worst thing an explorer can say.
         */
        if (node === undefined || node === null || node.status !== 'ready') {
          if (dirRel === '') {
            const status = node === undefined || node === null ? 'loading' : node.status
            rows.push({
              kind: 'status',
              key: 'root:' + status,
              rel: '',
              depth: 0,
              group,
              status: status === 'idle' ? 'loading' : status,
              message: node !== null && node !== undefined && typeof node.error === 'string' ? node.error : '',
            })
          }
          return
        }
        const entries = sortEntries(node.entries)
        for (let index = 0; index < entries.length; index += 1) {
          const entry = entries[index]
          if (entry === null || entry === undefined) continue
          const rel = normalizeRel(entry.rel)
          if (rel === '') continue
          const isDir = entry.type === 'dir'
          const change = statusIndex.get(rel)
          const letter = statusLetterOf(change)
          const hasDirtyChild = isDir && dirtyDirs.has(rel)
          /* In "changes only" mode a directory is kept when something under it
             changed, and a file only when it has a change. The tree stays the
             same tree — this is a filter, not a second view. */
          if (onlyChanges === true && isDir === false && change === undefined) continue
          if (onlyChanges === true && isDir === true && hasDirtyChild === false && change === undefined) continue
          const isExpanded = isDir && (open.has(rel) || (onlyChanges === true && hasDirtyChild === true))
          rows.push({
            kind: 'entry',
            key: 'e:' + rel,
            name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : baseNameOf(rel),
            rel,
            type: entry.type,
            depth,
            group,
            dir: isDir,
            expanded: isExpanded,
            size: entry.size,
            mtimeMs: entry.mtimeMs,
            letter,
            colorClass: statusColorClass(letter),
            hasDirtyChild,
            change: change === undefined ? null : change,
            /* `statusIndex.get` returns undefined for a clean file, so every read
               has to guard BOTH null and undefined. Mixing the two is how a clean
               file used to crash the tree. */
            added: change !== null && change !== undefined && typeof change.added === 'number' ? change.added : 0,
            deleted: change !== null && change !== undefined && typeof change.deleted === 'number' ? change.deleted : 0,
          })
          if (!isExpanded) continue
          const child = state[rel]
          if (child === undefined || child === null || child.status === 'loading' || child.status === 'idle') {
            rows.push({ kind: 'status', key: 's:' + rel, rel, depth: depth + 1, status: 'loading' })
            continue
          }
          if (child.status === 'error') {
            rows.push({ kind: 'status', key: 's:' + rel, rel, depth: depth + 1, status: 'error', message: child.error })
            continue
          }
          walk(rel, depth + 1, group)
        }
        if (node.truncated === true) {
          rows.push({ kind: 'truncated', key: 't:' + dirRel, rel: dirRel, depth })
        }
      }

      walk('', 0, 'files')
      return rows
    }

    /* ============================== live "is this page visible" ============================== */

    /**
     * Whether the document is on screen. Everything expensive in this page
     * (the git watch loop, the stat poll) consults this: a hidden window cannot
     * show a snapshot, so fetching one is pure waste — and the git snapshot is
     * three subprocesses, not a cheap call.
     *
     * Returns a live boolean, subscribing to the event once per page.
     */
    function useDocumentVisible() {
      const [visible, setVisible] = useState(() => {
        if (typeof document === 'undefined' || document === null) return true
        return document.visibilityState !== 'hidden'
      })
      useEffect(() => {
        if (typeof document === 'undefined' || document === null) return undefined
        if (typeof document.addEventListener !== 'function') return undefined
        const onChange = () => setVisible(document.visibilityState !== 'hidden')
        document.addEventListener('visibilitychange', onChange)
        return () => {
          if (typeof document.removeEventListener === 'function') document.removeEventListener('visibilitychange', onChange)
        }
      }, [])
      return visible
    }

    /* ============================== sizing ============================== */

    function modeOfWidth(width) {
      if (!Number.isFinite(width) || width <= 0) return 'S'
      if (width < BP_S) return 'XS'
      if (width < BP_M) return 'S'
      if (width < BP_L) return 'M'
      return 'L'
    }

    /**
     * Measure THIS element. The workbench is a resizable pane, so the viewport
     * says nothing useful; every breakpoint decision must come from here.
     */
    function useElementWidth(ref) {
      const [width, setWidth] = useState(0)
      useEffect(() => {
        const node = ref.current
        if (node === null || node === undefined) return undefined
        const measure = () => {
          const next = node.getBoundingClientRect === undefined ? 0 : Math.round(node.getBoundingClientRect().width)
          setWidth((previous) => (previous === next ? previous : next))
        }
        measure()
        if (typeof ResizeObserver !== 'function') {
          window.addEventListener('resize', measure)
          return () => window.removeEventListener('resize', measure)
        }
        const observer = new ResizeObserver(() => measure())
        observer.observe(node)
        return () => { try { observer.disconnect() } catch (error) { void error } }
      }, [ref])
      return width
    }

    /* ============================== RPC ============================== */

    /**
     * POST to one of the two hosts. Same-origin, so the hosts' trust fences are
     * satisfied by the browser itself.
     *
     * The envelope is the kit's: `{ ok:true, data }` / `{ ok:false, error }`.
     * An error is normalised to an Error carrying `code` so callers can branch
     * on `not-a-repo` without string matching.
     */
    function makeCaller() {
      return async function call(prefix, method, payload, signal) {
        const options = {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
          body: JSON.stringify(payload === undefined ? {} : payload),
        }
        if (signal !== undefined && signal !== null) options.signal = signal
        const response = await fetch(prefix + method, options)
        let body = null
        try { body = await response.json() } catch (error) { void error }
        if (body === null || typeof body !== 'object') {
          const error = new Error('malformed response from ' + method)
          error.code = 'bad-response'
          throw error
        }
        if (body.ok !== true) {
          const details = body.error !== null && typeof body.error === 'object' ? body.error : {}
          const error = new Error(typeof details.message === 'string' ? details.message : 'request failed')
          error.code = typeof details.code === 'string' ? details.code : 'failed'
          throw error
        }
        return body.data
      }
    }

    /* ============================== storage ============================== */

    function readJson(key, fallback) {
      try {
        const raw = window.localStorage.getItem(key)
        if (raw === null || raw === '') return fallback
        const parsed = JSON.parse(raw)
        return parsed === null || parsed === undefined ? fallback : parsed
      } catch (error) { void error; return fallback }
    }

    function writeJson(key, value) {
      try { window.localStorage.setItem(key, JSON.stringify(value)) } catch (error) { void error }
    }

    function readString(key, fallback) {
      try {
        const raw = window.localStorage.getItem(key)
        return typeof raw === 'string' && raw !== '' ? raw : fallback
      } catch (error) { void error; return fallback }
    }

    function writeString(key, value) {
      try {
        if (value === null || value === undefined || value === '') window.localStorage.removeItem(key)
        else window.localStorage.setItem(key, String(value))
      } catch (error) { void error }
    }

    /* ============================== icons ============================== */

    /* One 16-grid, one stroke width, round caps — the same construction the
       files page uses, so the two pages cannot drift apart visually. */
    const ICONS = {
      chevronRight: ['M6 3.5 L10.5 8 L6 12.5'],
      chevronDown: ['M3.5 6 L8 10.5 L12.5 6'],
      folder: ['M2 4.5 h4 l1.5 2 h6.5 v6.5 h-12 z'],
      file: ['M4 2 h5 l3 3 v9 h-8 z', 'M9 2 v3 h3'],
      refresh: ['M13.5 8a5.5 5.5 0 1 1-1.6-3.9', 'M13.5 2.5V5.5H10.5'],
      commit: ['M8 2 v4', 'M8 10 v4', 'M8 5.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6'],
      warning: ['M8 2.5 L14 13 H2 Z', 'M8 6.5 v3', 'M8 11 v.5'],
      close: ['M4 4 L12 12', 'M12 4 L4 12'],
      more: ['M3.5 8 h.01', 'M8 8 h.01', 'M12.5 8 h.01'],
      changes: ['M2 8 h3', 'M11 8 h3', 'M8 4.5 a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7'],
      source: ['M5.5 4 L2 8 l3.5 4', 'M10.5 4 L14 8 l-3.5 4'],
      search: ['M7 2.5 a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9', 'M10.4 10.4 L13.5 13.5'],
      download: ['M8 2.5 v7.5', 'M4.5 6.5 L8 10 L11.5 6.5', 'M2.5 13 h11'],
      arrowUp: ['M8 13 V3', 'M4.5 6.5 L8 3 L11.5 6.5'],
      arrowDown: ['M8 3 V13', 'M4.5 9.5 L8 13 L11.5 9.5'],
      history: ['M2.5 8 a5.5 5.5 0 1 0 1.6-3.9', 'M2.5 2.5 V5.5 H5.5', 'M8 5 v3.2 l2.2 1.4'],
      tag: ['M2.5 2.5 h5 l6 6 -5 5 -6-6 z', 'M5.2 5.2 h.01'],
      plus: ['M8 3 v10', 'M3 8 h10'],
      edit: ['M11 2.5 l2.5 2.5 -8 8 -3 .5 .5-3 z'],
      trash: ['M2.5 4 h11', 'M6 4 V2.5 h4 V4', 'M4 4 l.7 9.5 h6.6 L12 4'],
      filter: ['M2.5 3.5 h11 l-4.2 4.7 v4.3 l-2.6 1.5 V8.2 z'],
      branch: ['M5 4.5 a1.6 1.6 0 1 0 0 -.01', 'M5 6.2 V10', 'M5 10 a1.6 1.6 0 1 0 0 -.01', 'M11 4.5 a1.6 1.6 0 1 0 0 -.01', 'M11 6.2 V8 a2.4 2.4 0 0 1 -2.4 2.4 H6.4'],
  stash: ['M2.5 4.5 h11', 'M4 4.5 V12 h8 V4.5', 'M6.5 8 h3'],
  stage: ['M8 10.5 V2.5', 'M4.5 6 L8 2.5 L11.5 6', 'M2.5 13 h11'],
    }

    function Icon(props) {
      const size = typeof props.size === 'number' ? props.size : 14
      const paths = hasOwnKey(ICONS, props.name) ? ICONS[props.name] : []
      return E('svg', {
        className: 'scw-icon' + (props.className === undefined ? '' : ' ' + props.className),
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      }, paths.map((d, index) => E('path', { key: index, d })))
    }

    function IconButton(props) {
      return E('button', {
        type: 'button',
        className: 'scw-iconBtn' + (props.active === true ? ' is-active' : '') + (props.className === undefined ? '' : ' ' + props.className),
        title: props.label,
        'aria-label': props.label,
        disabled: props.disabled === true,
        onClick: props.onClick,
      }, E(Icon, { name: props.name, size: props.size === undefined ? 14 : props.size }),
      /* A count that belongs to the BUTTON, not to the row: a corner badge keeps the
         header at four icons instead of "arrow, arrow, arrow, number". */
      props.badge === undefined || props.badge === null || props.badge === 0
        ? null
        : E('span', {
          className: 'scw-badge' + (props.badgeKind === undefined ? '' : ' is-' + props.badgeKind),
          'aria-hidden': 'true',
        }, String(props.badge)))
    }

    /* ============================== styles ============================== */

    const CSS = `
.scw-root{display:flex;flex-direction:column;flex:1 1 auto;height:100%;min-height:0;color:var(--dsw-alias-label-primary,#e6e6e6);background:var(--dsw-alias-bg-base,#14161a);font:inherit;font-size:13px}
.scw-icon{flex:none;display:block}
/* position:relative is the anchor for the badge; the badge sits OUTSIDE the button box
   so it never pushes the icon off centre or widens the header. */
.scw-iconBtn{position:relative;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:none;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary,#b6bac1);cursor:pointer}
.scw-badge{position:absolute;top:-2px;right:-2px;z-index:5;min-width:14px;height:14px;padding:0 4px;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;border-radius:8px;font-size:9px;font-weight:700;line-height:1;font-variant-numeric:tabular-nums;color:#fff;background:#4d6bfe;box-shadow:0 0 0 2px var(--dsw-alias-bg-base,#14161a);pointer-events:none}
/* 待拉取 = 你落后于远端；待推送 = 你有远端没有的提交。两种不同的动作意图，两种颜色。 */
.scw-badge.is-behind{background:#e0a458;color:#14161a}
.scw-badge.is-ahead{background:#4d6bfe;color:#fff}
.scw-iconBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));color:var(--dsw-alias-label-primary,#e6e6e6)}
.scw-iconBtn.is-active{color:var(--dsw-alias-brand-primary,#4d6bfe)}
.scw-iconBtn:disabled{opacity:.35;cursor:default}

/* ---- header: repo chip / branch / counts / actions ---- */
.scw-head{display:flex;align-items:center;gap:6px;height:40px;padding:0 8px;flex:none;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08))}
.scw-repoChip{display:inline-flex;align-items:center;gap:5px;min-width:0;max-width:40%;height:24px;padding:0 7px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));border-radius:6px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.05));color:inherit;font:inherit;font-size:11px;cursor:pointer}
.scw-repoChip:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}
.scw-repoName{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.scw-branch{display:inline-flex;align-items:center;gap:4px;min-width:0;color:var(--dsw-alias-label-secondary,#b6bac1);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.scw-sync{color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:10px;white-space:nowrap}
.scw-spacer{flex:1;min-width:0}

/* ---- 弹窗查看：同一份 DOM，只是换了个位置 ----
   不重新挂载面板，所以编辑器里的滚动位置、光标、未保存内容都不会丢。尺寸照 GitCraft
   的 is-wide：min(1100px, 92vw) / 86vh —— 不铺满整屏，留出背景让人知道这是临时窗口。 */
/* diff 的高亮对比度：默认那两档在深色背景上几乎看不出来 */
.scw-root.is-modal .scw-content{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:900;width:min(1100px,92vw);height:86vh;max-height:86vh;background:var(--dsw-alias-bg-base,#14161a);border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));border-radius:10px;overflow:hidden;box-shadow:0 18px 48px rgba(0,0,0,.55)}
.scw-root.is-modal .scw-content::before{content:'';position:fixed;left:-50vw;top:-50vh;width:200vw;height:200vh;background:rgba(0,0,0,.55);z-index:-1}
.gwc-row.is-del{background:rgba(255,107,107,.28)!important}
.gwc-row.is-add{background:rgba(63,185,80,.30)!important}
.gwc-row.is-add .gwc-line{color:#7ee787;font-weight:500}
/* ---- 源码可读性 ----
   编辑器（CodeMirror）的具体配色由 files 包的 chunk 决定，但字号、行高、行号对比度
   这些「看的清不清」的量可以在这一层覆盖，而且对降级成 <pre> 的情况同样有效。 */
.scw-root .cm-editor{font-size:13px}
.scw-root .cm-content{line-height:1.7;letter-spacing:.1px}
.scw-root .cm-gutters{background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.03));color:var(--dsw-alias-label-secondary,#a8b0ba);border-right:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.09))}
.scw-root .cm-lineNumbers .cm-gutterElement{min-width:2.6em;padding:0 8px 0 4px;font-variant-numeric:tabular-nums}
.scw-root .cm-activeLineGutter{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 18%,transparent);color:var(--dsw-alias-label-primary,#e6e8eb)}
.scw-root .cm-activeLine{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 9%,transparent)}
.scw-root .cm-selectionBackground,.scw-root .cm-editor .cm-selectionBackground{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 32%,transparent)!important}
.scw-root .wbf-pre{font-size:13px;line-height:1.7}
/* ---- body: tree | content ---- */
.gwc-row.is-del .gwc-line{color:#ff9b9b;font-weight:500}
.scw-body{display:flex;flex:1 1 auto;min-height:0;min-width:0}
/* 窄的时候上下分栏：左右各占一半在 700px 以下两边都只剩几十列，读不了。
   M 档（720-1024）仍是左右分栏，放得下。 */
.scw-body.is-stacked{flex-direction:column}
.scw-body.is-stacked>.scw-treePane{flex:0 0 auto!important;width:auto!important;max-width:none!important;height:44%;border-right:none;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08))}
.scw-body.is-stacked>.scw-content{flex:1 1 auto;min-height:0}
/* flex: 0 0 auto is load-bearing: without it the pane is a shrinking flex item,
   so a long line in the content pane squeezes the tree to a sliver and dragging
   the grip looks like it does nothing (the flex layout shrinks it straight back).
   The width comes from the inline style, driven by the drag. */
.scw-treePane{display:flex;flex-direction:column;flex:0 0 auto;min-height:0;border-right:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08))}
/* A 5px hit target is a hair too thin for a mouse; the visual stays thin but the
/* The grip must occupy its OWN column. It used to be margin-left:-4px with z-index:2,
   so it sat ON TOP of the tree pane's scrollbar and every hover painted a tint over
   the content it was supposed to separate — the splitter "covered the UI". In flow,
   with no negative margin and no stacking, it can only ever be the divider. */
.scw-grip{position:relative;flex:0 0 7px;margin:0;cursor:col-resize;background:transparent;z-index:0;touch-action:none}
.scw-grip::after{content:'';position:absolute;top:0;bottom:0;left:3px;width:1px;background:var(--dsw-alias-border-l1,rgba(255,255,255,.08))}
.scw-grip:hover::after{background:var(--dsw-alias-brand-primary,#4d6bfe)}
.scw-grip:hover::after,.scw-grip.is-dragging::after{background:var(--dsw-alias-brand-primary,#4d6bfe)}
/* While dragging, the cursor and the no-selection rule have to apply to the WHOLE
   window: the pointer leaves the 7px grip immediately, and without this the drag
   selected text across whatever it passed over. */
.scw-grip.is-dragging{background:transparent}
.scw-root.is-resizing,.scw-root.is-resizing *{cursor:col-resize!important;user-select:none!important}
.scw-content{display:flex;flex-direction:column;flex:1 1 auto;min-width:0;min-height:0}

/* ---- tree ---- */
.scw-tree{flex:1 1 auto;min-height:0;overflow:auto;padding:2px 0 8px;overscroll-behavior:contain}
.scw-treeViewport{position:relative}
.scw-row{display:flex;align-items:center;gap:4px;height:${TREE_ROW_HEIGHT}px;padding-right:6px;border-radius:4px;cursor:pointer;white-space:nowrap;outline:none;color:var(--dsw-alias-label-primary,#e6e6e6)}
.scw-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.scw-row.is-active{background:var(--dsw-alias-interactive-bg-active,rgba(77,107,254,.18));box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary,#4d6bfe)}
.scw-row:focus-visible{box-shadow:inset 0 0 0 1px var(--dsw-alias-brand-primary,#4d6bfe)}
.scw-rowChevron{display:inline-flex;align-items:center;justify-content:center;width:12px;flex:none;color:var(--dsw-alias-label-tertiary,#8a8f98)}
.scw-rowIcon{flex:none;color:var(--dsw-alias-label-secondary,#b6bac1)}
.scw-row.is-dir .scw-rowIcon{color:var(--dsw-alias-state-warn-primary,#e2a03f)}
.scw-rowName{flex:0 1 auto;min-width:3em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* GitCraft puts the path AFTER the name and lets it shrink first: the name is what
   you pick a file by, the path is context. */
.scw-rowDir.is-after{flex:1 1 auto;min-width:0;max-width:none;margin-left:6px;text-align:left}

.scw-rowName.is-dir{font-weight:500}

/* one badge, one letter, immediately after the name */
.scw-letter{flex:none;font-size:10px;font-weight:600;line-height:1;padding:0 1px}
.scw-letter.is-modified{color:var(--dsw-alias-state-warn-primary,#e2a03f)}
.scw-letter.is-added{color:var(--dsw-alias-state-success-primary,#3fb950)}
.scw-letter.is-deleted{color:var(--dsw-alias-state-error-primary,#ff6b6b)}
.scw-letter.is-renamed{color:var(--dsw-alias-state-warn-primary,#e2a03f)}
.scw-letter.is-conflict{color:var(--dsw-alias-state-error-primary,#ff6b6b)}
.scw-letter.is-untracked{color:var(--dsw-alias-label-tertiary,#8a8f98)}

/* a directory only carries a dot, never a letter */
.scw-dirDot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-brand-primary,#4d6bfe);opacity:.85}

/* +N -M only inside the changes group */
.scw-stat{flex:none;display:inline-flex;gap:4px;font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8f98)}
.scw-statAdd{color:var(--dsw-alias-state-success-primary,#3fb950)}
.scw-statDel{color:var(--dsw-alias-state-error-primary,#ff6b6b)}

/* actions appear on hover/selection only */
.scw-rowActions{flex:none;display:none;gap:1px}
.scw-row:hover .scw-rowActions,.scw-row.is-active .scw-rowActions{display:flex}
.scw-rowBtn{display:inline-flex;align-items:center;justify-content:center;height:18px;padding:0 5px;border:none;border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary,#b6bac1);font:inherit;font-size:10px;cursor:pointer;white-space:nowrap}
.scw-rowBtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.1));color:var(--dsw-alias-label-primary,#fff)}
.scw-rowBtn.is-danger:hover{color:var(--dsw-alias-state-error-primary,#ff6b6b)}

.scw-treeState{padding:6px 12px;color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:11px}
/* A status row INSIDE the (absolutely positioned) tree must not add its own
   vertical padding: the row height is fixed at TREE_ROW_HEIGHT, and 6+6 extra
   pixels made it overlap the row below. */
.scw-treeState.is-in-tree{padding-top:0;padding-bottom:0;box-sizing:border-box;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.scw-treeState.is-error{color:var(--dsw-alias-state-error-primary,#ff6b6b)}

/* ---- mode strip: five modes, one column ---- */
.scw-modes{display:flex;flex:none;gap:1px;padding:3px 4px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));overflow-x:auto;scrollbar-width:none}
.scw-modes::-webkit-scrollbar{display:none}
/* Narrow panel: labels only cut themselves off. Icons alone still say which tab it is,
   and the tooltip keeps the full name — a truncated label is worse than no label. */
.scw-root.is-xs .scw-modeLabel,.scw-treePane.is-narrow .scw-modeLabel{display:none}
.scw-root.is-xs .scw-mode,.scw-treePane.is-narrow .scw-mode{gap:0;padding:3px 7px}
/* Same reasoning for the ref chips: squeezed to a sliver they read as broken glyphs.
   The row tooltip still carries the refs, so nothing is lost. */
.scw-root.is-xs .scw-commitRefs,.scw-treePane.is-narrow .scw-commitRefs{display:none}
.scw-mode{flex:none;display:inline-flex;align-items:center;gap:3px;border:none;border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary,#b6bac1);font:inherit;font-size:10px;padding:3px 6px;cursor:pointer;white-space:nowrap}
.scw-mode:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07))}
.scw-mode.is-active{background:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.1));color:var(--dsw-alias-label-primary,#fff);font-weight:600}
/* PLAIN TEXT, not a filled badge.
   The badge was a filled pill: brand colour for the background, a hardcoded #fff for
   the digit. On a theme whose brand colour is LIGHT that is white on white — the
   number vanished and the pill read as a blank white square. That is exactly what got
   asked about, twice. Text inheriting the label colour cannot fail that way, and
   "(4)" is unambiguous without hovering. */
.scw-modeCount{flex:none;font-size:9.5px;line-height:1;font-variant-numeric:tabular-nums;font-weight:600;color:inherit;opacity:.7}
/* No giant focus ring on a mouse click: the active tab already shows its state. */
.scw-mode:focus{outline:none}
.scw-mode:focus-visible{outline:1px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:1px}

/* ---- grouped change list ---- */
.scw-changeList,.scw-list{overflow:auto}
.scw-bulkBtn{flex:none;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary,#b6bac1);font:inherit;font-size:10px;padding:1px 6px;cursor:pointer;white-space:nowrap}
.scw-bulkBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.09));color:var(--dsw-alias-label-primary,#fff)}
.scw-bulkBtn.is-danger{color:var(--dsw-alias-state-error-primary,#ff6b6b);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ff6b6b) 45%,transparent)}
.scw-bulkBtn:disabled{opacity:.45;cursor:default}
.scw-group{display:flex;align-items:center;gap:5px;padding:5px 8px 3px;font-size:10px;font-weight:600;color:var(--dsw-alias-label-tertiary,#8a8f98);text-transform:uppercase;letter-spacing:.03em;position:sticky;top:0;background:var(--dsw-alias-bg-base,#14161a);z-index:1}
.scw-groupCount{font-weight:400;opacity:.7}
.scw-groupFoot{padding:6px 8px}

/* ---- history ---- */
/* ---- history rows: graph | hash | refs | subject .......... author time ---- */
/* flex-direction is REQUIRED: the base .scw-commitRow is a column (hash above subject). Without this the graph row stacked vertically — every cell on its own line. */
.scw-commitRow.is-graph{display:flex;flex-direction:row;align-items:center;gap:7px;min-height:30px;padding:0 8px 0 4px}
.scw-commitRow.is-graph .scw-graph{flex:none;overflow:visible}
.scw-commitRow.is-graph .scw-commitShort{flex:none;font-family:var(--dsw-font-markdown-code-block,ui-monospace,monospace);font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8f98)}
/* Must be able to SHRINK. flex:none plus a percentage max-width let the chips run
   past their box and paint over the subject — the row looked "overlapped". min-width:0
   is what actually allows a flex item to go below its content size. */
.scw-commitRefs{flex:0 1 auto;min-width:0;display:flex;align-items:center;gap:3px;max-width:42%;overflow:hidden}
.scw-refChip{flex:0 1 auto;min-width:0;max-width:9em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 5px;border-radius:9px;font-size:9.5px;line-height:15px;background:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.09));color:var(--dsw-alias-label-secondary,#b6bac1);border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.1))}
/* Kind is carried by COLOUR, and the three kinds are distinguishable at a glance:
   本地分支 蓝 / 远程分支 青绿 / 标签 橙。Boundary + text both take the colour so a
   chip stays readable on any panel background. */
.scw-refChip.is-local,.scw-refChip.is-head{border-color:var(--dsw-alias-brand-primary,#4d6bfe);color:var(--dsw-alias-brand-primary,#4d6bfe)}
.scw-refChip.is-head{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 16%,transparent);font-weight:600}
.scw-refChip.is-remote{border-color:var(--dsw-alias-state-success-primary,#4ec9a0);color:var(--dsw-alias-state-success-primary,#4ec9a0)}
.scw-refChip.is-tag{border-color:var(--dsw-alias-state-warning-primary,#e0a458);color:var(--dsw-alias-state-warning-primary,#e0a458);border-style:dashed}
.scw-commitRow.is-graph .scw-commitSubject{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.scw-commitRow.is-graph .scw-commitAuthor{flex:none;max-width:9em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8f98)}
.scw-commitRow.is-graph .scw-commitTime{flex:none;font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8f98);opacity:.85}
.scw-loadMore{display:flex;justify-content:center;padding:8px}
.scw-loadMoreBtn{border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));border-radius:5px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.05));color:var(--dsw-alias-label-secondary,#b6bac1);font:inherit;font-size:11px;padding:4px 14px;cursor:pointer}
.scw-loadMoreBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.1));color:var(--dsw-alias-label-primary,#fff)}
.scw-loadMoreBtn:disabled{opacity:.55;cursor:default}
.scw-commitRow{display:flex;flex-direction:column;gap:1px;padding:4px 8px;cursor:pointer;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.05))}
.scw-commitRow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.scw-commitRow.is-active{background:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.1))}
.scw-commitTop{display:flex;align-items:baseline;gap:6px;min-width:0}
.scw-commitShort{flex:none;font-family:var(--dsw-font-markdown-code-block,ui-monospace,monospace);font-size:10px;color:var(--dsw-alias-brand-primary,#4d6bfe)}
.scw-commitSubject{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}
.scw-commitMeta{display:flex;gap:6px;padding-left:2px;font-size:9px;color:var(--dsw-alias-label-tertiary,#8a8f98)}
.scw-commitAuthor{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:50%}

/* ---- branches: grouped, with a row rhythm that matches the file tree ---- */
.scw-branchGroup + .scw-branchGroup{margin-top:2px;border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.07))}
/* Section headers are LABELS, not content: smaller, dimmer, spaced out, so the eye
   can jump between 本地/远程/标签 without reading every row. */
.scw-branchGroup .scw-groupName{display:flex;align-items:center;gap:5px;padding:7px 8px 3px;font-size:9.5px;font-weight:600;letter-spacing:.06em;color:var(--dsw-alias-label-tertiary,#8a8f98);text-transform:none}
.scw-branchGroup .scw-groupCount{flex:none;min-width:14px;text-align:center;padding:0 4px;border-radius:3px;background:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.08));font-weight:500;font-size:9px;color:var(--dsw-alias-label-secondary,#b6bac1)}
.scw-groupEmpty{padding:2px 8px 6px 26px;font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8f98);opacity:.8}
.scw-branchLegend{flex:none;padding:5px 8px;font-size:9.5px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#8a8f98);border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.06))}
.scw-branchRow{display:flex;align-items:center;gap:6px;min-height:24px;padding:0 8px 0 5px;cursor:pointer;font-size:11px;border-left:2px solid transparent}
.scw-branchRow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07))}
/* The current branch is a STATE, not just bold text: accent bar + tinted row. */
.scw-branchRow.is-head{cursor:default;font-weight:600;border-left-color:var(--dsw-alias-brand-primary,#4d6bfe);background:var(--dsw-alias-brand-primary,#4d6bfe);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 12%,transparent)}
.scw-branchRow.is-ref{cursor:default;color:var(--dsw-alias-label-secondary,#b6bac1)}
.scw-branchRow.is-ref:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.05))}
.scw-headChip{flex:none;padding:0 5px;border-radius:3px;font-size:9px;font-weight:600;line-height:15px;color:var(--dsw-alias-state-success-primary,#4ec9a0);border:1px solid var(--dsw-alias-state-success-primary,#4ec9a0)}\n.scw-remoteGroup{display:flex;align-items:center;gap:6px;min-height:22px;padding:2px 8px 2px 5px;margin-top:2px;font-size:10px;font-weight:600;color:var(--dsw-alias-label-tertiary,#8a8f98)}\n.scw-branchIcon{flex:none;display:inline-flex;align-items:center;justify-content:center;width:13px;color:var(--dsw-alias-label-tertiary,#8a8f98)}
.scw-branchRow.is-head .scw-branchIcon{color:var(--dsw-alias-brand-primary,#4d6bfe)}
.scw-branchName{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* "origin/" is the remote, the rest is the branch — two different things, so two
   different weights instead of one flat string. */
.scw-branchRemote{flex:none;color:var(--dsw-alias-label-tertiary,#8a8f98);font-weight:400}
.scw-branchAhead{flex:none;padding:0 3px;border-radius:3px;font-size:9px;font-weight:600;background:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.08));color:var(--dsw-alias-state-success-primary,#4ec9a0)}
.scw-branchBehind{flex:none;padding:0 3px;border-radius:3px;font-size:9px;font-weight:600;background:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.08));color:var(--dsw-alias-state-warning-primary,#e0a458)}
.scw-branchHash{flex:none;font-family:var(--dsw-font-markdown-code-block,ui-monospace,monospace);font-size:9.5px;color:var(--dsw-alias-label-tertiary,#8a8f98);opacity:.75}

/* ---- stash ---- */
.scw-stashRow{display:flex;align-items:center;gap:6px;padding:4px 8px;font-size:11px}
.scw-stashRow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.scw-stashRef{flex:none;font-family:var(--dsw-font-markdown-code-block,ui-monospace,monospace);font-size:10px;color:var(--dsw-alias-brand-primary,#4d6bfe)}
.scw-stashSubject{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,#b6bac1)}
.scw-stashRow .scw-rowActions{opacity:0}
.scw-stashRow:hover .scw-rowActions{opacity:1}

/* ---- commit detail ---- */
/* The detail is a flex COLUMN whose siblings include a list that can be thousands of
   rows long. Without flex:none the message body was the only shrinkable item, so it
   collapsed to a sliver of clipped glyphs — the "提交信息显示异常" report. Every block
   keeps its natural height; only the file list scrolls. */
.scw-commitDetail{display:flex;flex-direction:column;gap:6px;padding:10px 12px;overflow:hidden;height:100%;min-height:0}
.scw-commitDetail > *{flex:none}
.scw-commitHead{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.scw-commitHash{flex:none;font-family:var(--dsw-font-markdown-code-block,ui-monospace,monospace);font-size:11px;color:var(--dsw-alias-brand-primary,#4d6bfe)}
.scw-commitSubject.is-large{font-size:13px;font-weight:600}
.scw-commitInfo{display:flex;gap:10px;flex-wrap:wrap;font-size:10px;color:var(--dsw-alias-label-secondary,#b6bac1)}
.scw-dim{color:var(--dsw-alias-label-tertiary,#8a8f98)}
.scw-commitBody{flex:none;margin:2px 0;padding:8px;border-radius:6px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.04));font-family:var(--dsw-font-markdown-code-block,ui-monospace,monospace);font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-word;max-height:180px;overflow:auto}
.scw-commitFilesLabel{font-size:10px;font-weight:600;color:var(--dsw-alias-label-tertiary,#8a8f98);text-transform:uppercase;letter-spacing:.03em;margin-top:4px}
/* The ONLY scrolling region: the list can be thousands of rows, and giving it the
   remaining height keeps the message and the header pinned above it. */
.scw-commitFiles{flex:1 1 auto;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:1px}
.scw-commitFile{display:flex;align-items:center;gap:6px;padding:2px 4px;border-radius:4px;font-size:11px}
.scw-commitFile[role="button"]{cursor:pointer}
.scw-commitFile[role="button"]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.scw-commitFileName{flex:none}
.scw-commitFile.is-active{background:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.1))}
/* width:100% is not decorative: without it the container shrank to its content and
   the whole header row (back + path + toggle) floated in the middle of the pane. */
.scw-commitPatch{display:flex;flex-direction:column;width:100%;height:100%;min-height:0}

/* ---- mode toolbar ---- */
.scw-toolbar{display:flex;flex:none;gap:3px;padding:3px 5px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));overflow-x:auto;scrollbar-width:none}
.scw-toolbar::-webkit-scrollbar{display:none}
.scw-toolIcon{display:inline-flex;align-items:center;justify-content:center;flex:none;width:24px;height:22px;border:1px solid transparent;border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary,#b6bac1);cursor:pointer}
.scw-toolIcon:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.09));color:var(--dsw-alias-label-primary,#fff)}
.scw-toolIcon.is-primary{color:var(--dsw-alias-brand-primary,#4d6bfe)}
.scw-toolIcon.is-danger:hover:not(:disabled){color:var(--dsw-alias-state-error-primary,#ff6b6b)}
.scw-toolIcon:disabled{opacity:.35;cursor:default}
.scw-toolBtn{flex:none;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary,#b6bac1);font:inherit;font-size:10px;padding:2px 6px;cursor:pointer;white-space:nowrap}
.scw-toolBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));color:var(--dsw-alias-label-primary,#fff)}
.scw-toolBtn.is-primary{border-color:var(--dsw-alias-brand-primary,#4d6bfe);color:var(--dsw-alias-brand-primary,#4d6bfe)}
.scw-toolBtn.is-danger:hover:not(:disabled){border-color:var(--dsw-alias-state-error-primary,#ff6b6b);color:var(--dsw-alias-state-error-primary,#ff6b6b)}
.scw-toolBtn:disabled{opacity:.4;cursor:default}

/* ---- conflict banner ---- */
.scw-conflictBar{display:flex;align-items:center;gap:6px;flex:none;padding:4px 8px;font-size:10px;background:var(--dsw-alias-state-warning-bg,rgba(224,164,88,.16));color:var(--dsw-alias-state-warning-primary,#e0a458);border-bottom:1px solid var(--dsw-alias-state-warning-primary,rgba(224,164,88,.4))}
.scw-conflictText{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* ---- generated dialogs ---- */
.scw-menu{display:flex;flex-direction:column;gap:2px;margin-top:8px}
.scw-menuItem{display:block;width:100%;text-align:left;border:1px solid transparent;border-radius:5px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.04));color:inherit;font:inherit;font-size:12px;padding:6px 9px;cursor:pointer}
.scw-menuItem:hover{border-color:var(--dsw-alias-brand-primary,#4d6bfe)}
.scw-menuItem.is-danger{color:var(--dsw-alias-state-error-primary,#ff6b6b)}
.scw-menuItem.is-disabled{opacity:.4;cursor:default}
.scw-dialogField{display:flex;flex-direction:column;gap:4px;margin-top:10px}
.scw-dialogLabel{font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8f98)}
.scw-dialogInput{height:26px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));border-radius:5px;background:var(--dsw-alias-bg-base,#14161a);color:inherit;font:inherit;font-size:12px}
.scw-browse{display:flex;flex-direction:column;gap:5px;margin-top:8px;max-height:420px;overflow:auto}
.scw-browseSection{margin-top:4px;font-size:9.5px;font-weight:600;letter-spacing:.06em;color:var(--dsw-alias-label-tertiary,#8a8f98)}
.scw-browseCurrent{display:flex;align-items:center;gap:6px;padding:5px 7px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.1));border-radius:5px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.04))}
.scw-browseCurrentName{flex:none;font-size:11px;font-weight:600}
.scw-browseCurrentPath{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right;font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8f98)}
.scw-browseBar{display:flex;align-items:center;gap:4px}
.scw-browseInput{flex:1 1 auto;min-width:0;height:26px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));border-radius:5px;background:var(--dsw-alias-bg-base,#14161a);color:inherit;font:inherit;font-size:11px;font-family:var(--dsw-font-markdown-code-block,ui-monospace,monospace)}
.scw-browseInput:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#4d6bfe)}
.scw-browseGo,.scw-browseUp{flex:none;height:26px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));border-radius:5px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.05));color:var(--dsw-alias-label-secondary,#b6bac1);font:inherit;font-size:11px;cursor:pointer}
.scw-browseGo:hover:not(:disabled),.scw-browseUp:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.1));color:var(--dsw-alias-label-primary,#fff)}
.scw-browseGo:disabled,.scw-browseUp:disabled{opacity:.4;cursor:default}
.scw-browseUp{width:28px;padding:0;display:inline-flex;align-items:center;justify-content:center}
.scw-browseName{flex:none;font-size:11px}
.scw-browseItemPath{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right;font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8f98);opacity:.85}
.scw-browseRecent{display:flex;flex-direction:column;gap:1px}
.scw-drives{display:flex;flex-wrap:wrap;gap:4px}
.scw-driveChip{flex:none;min-width:38px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary,#b6bac1);font:inherit;font-size:11px;padding:3px 8px;cursor:pointer}
.scw-driveChip:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.09));color:var(--dsw-alias-label-primary,#fff)}
.scw-driveChip.is-active{border-color:var(--dsw-alias-brand-primary,#4d6bfe);color:var(--dsw-alias-brand-primary,#4d6bfe)}
.scw-browsePath{font-family:var(--dsw-font-markdown-code-block,ui-monospace,monospace);font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8f98);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.scw-browseError{font-size:11px;color:var(--dsw-alias-state-error-primary,#ff6b6b)}
.scw-browseList{display:flex;flex-direction:column;gap:1px;overflow:auto;min-height:120px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));border-radius:5px;padding:3px}
.scw-browseItem{display:flex;align-items:center;gap:6px;width:100%;text-align:left;border:none;border-radius:4px;background:transparent;color:inherit;font:inherit;font-size:12px;padding:4px 7px;cursor:pointer}
.scw-browseItem:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.09))}
.scw-browseItem.is-up{color:var(--dsw-alias-label-tertiary,#8a8f98)}
.scw-dialogInput:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#4d6bfe)}

/* ---- per-file history / blame ---- */
.scw-paneState{display:flex;align-items:center;justify-content:center;height:100%;padding:16px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8f98);text-align:center}
.scw-paneState.is-error{color:var(--dsw-alias-state-error-primary,#ff6b6b)}
.scw-historyList{overflow:auto;height:100%}
.scw-blameList{overflow:auto;height:100%;font-family:var(--dsw-font-markdown-code-block,ui-monospace,monospace);font-size:11px}
.scw-blameRow{display:flex;gap:8px;padding:0 8px;white-space:pre;line-height:1.6}
.scw-blameRow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.05))}
.scw-blameHash{flex:none;color:var(--dsw-alias-brand-primary,#4d6bfe);opacity:.8}
.scw-blameMeta{min-width:16ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:none;color:var(--dsw-alias-label-tertiary,#8a8f98);opacity:.85}
.scw-blameLine{flex:none;min-width:38px;text-align:right;color:var(--dsw-alias-label-tertiary,#8a8f98)}
.scw-blameText{flex:1 1 auto;white-space:pre}
.scw-commitOps{display:flex;gap:4px;flex-wrap:wrap;margin-top:4px}

.scw-search{display:flex;align-items:center;gap:4px;flex:none;padding:5px 6px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08))}
.scw-searchIcon{display:inline-flex;flex:none;color:var(--dsw-alias-label-tertiary,#8a8f98)}
/* Belt and braces against a second clear button: some engines draw a native cancel
   affordance even for type=text with a clear-ish look. The page owns the ONE clear
   button, so hide any engine-provided one. */
.scw-searchInput::-webkit-search-cancel-button,.scw-searchInput::-webkit-search-decoration{-webkit-appearance:none;display:none}
.scw-searchInput{flex:1 1 auto;min-width:0;height:24px;padding:0 6px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));border-radius:5px;background:var(--dsw-alias-bg-base,#14161a);color:inherit;font:inherit;font-size:11px}
.scw-searchInput:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#4d6bfe)}
.scw-searchClear{display:inline-flex;align-items:center;justify-content:center;flex:none;width:16px;height:16px;margin-left:-20px;border:none;border-radius:3px;background:transparent;color:var(--dsw-alias-label-tertiary,#8a8f98);cursor:pointer}
.scw-searchClear:hover{color:var(--dsw-alias-label-primary,#fff)}
.scw-searchOpts{display:inline-flex;align-items:center;gap:2px;flex:none;margin-left:4px}
.scw-searchOpt{height:20px;padding:0 4px;border:1px solid transparent;border-radius:4px;background:transparent;color:var(--dsw-alias-label-tertiary,#8a919c);font:inherit;font-size:11px;line-height:1;cursor:pointer}
.scw-searchOpt.is-on{border-color:var(--dsw-alias-brand-primary,#4d6bfe);color:var(--dsw-alias-brand-primary,#4d6bfe);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 14%,transparent)}
.scw-searchModes{display:flex;flex:none;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));border-radius:5px;overflow:hidden;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.04))}
.scw-searchMode{border:none;background:transparent;color:var(--dsw-alias-label-secondary,#b6bac1);font:inherit;font-size:9px;padding:3px 5px;cursor:pointer;white-space:nowrap}
.scw-searchMode.is-active{background:var(--dsw-alias-brand-primary,#4d6bfe);color:var(--dsw-alias-label-primary-inverted,#fff)}
.scw-searchResults{overflow:auto}
.scw-rowDir{flex:none;max-width:45%;overflow:hidden;text-overflow:ellipsis;font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8f98)}
.scw-hit{background:transparent;color:var(--dsw-alias-brand-primary,#4d6bfe);font-weight:600}
.scw-matchRow{display:flex;align-items:center;gap:6px;height:20px;padding:0 6px 0 28px;cursor:pointer;font-size:11px;color:var(--dsw-alias-label-secondary,#b6bac1);white-space:nowrap;overflow:hidden}
.scw-matchRow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.scw-matchLine{flex:none;min-width:26px;text-align:right;font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8f98);font-variant-numeric:tabular-nums}
.scw-matchText{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;font-family:var(--dsw-font-markdown-code-block,ui-monospace,monospace);font-size:11px}

/* ---- content tabs ---- */
.scw-tabs{position:relative;display:flex;align-items:stretch;flex:none;width:100%;min-height:30px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08))}
.scw-tab{display:inline-flex;align-items:center;gap:5px;padding:0 10px;border:none;border-right:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));background:transparent;color:var(--dsw-alias-label-secondary,#b6bac1);font:inherit;font-size:11px;cursor:pointer}
.scw-tab:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.05))}
.scw-tab.is-active{background:var(--dsw-alias-bg-layer-2,#22262c);color:var(--dsw-alias-label-primary,#e6e6e6);box-shadow:inset 0 -2px 0 var(--dsw-alias-brand-primary,#4d6bfe)}
.scw-modeToggle{display:inline-flex;align-items:center;gap:3px;flex:none;align-self:center;margin:0 6px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary,#b6bac1);font:inherit;font-size:10px;padding:1px 5px;cursor:pointer}
.scw-modeToggle,.scw-modalBtn{display:inline-flex;align-items:center;gap:3px;flex:none;align-self:center;margin:0 6px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary,#b6bac1);font:inherit;font-size:10px;padding:1px 5px;cursor:pointer}
.scw-tabFile{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:center;align-self:center;line-height:1;color:var(--dsw-alias-label-primary,#e6e8eb)}
/* Absolutely centred so the path stays put while its LENGTH changes; a path that
   shifts left and right as you click through files is hard to read. It is clamped so
   long paths never collide with the back button or the layout toggle. */
.scw-fileGroup{position:absolute;left:50%;top:0;height:100%;transform:translateX(-50%);display:flex;align-items:center;gap:7px;max-width:calc(100% - 210px);pointer-events:none}
.scw-fileGroup > *{pointer-events:auto}
.scw-tabFile.is-whole{font-weight:600}
/* The revision is metadata, not part of the name: a muted chip keeps the path
   readable and stops "name @ hash" from wrapping into a single unparseable run. */
.scw-revChip{flex:none;align-self:center;padding:1px 5px;border-radius:4px;background:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.08));font-family:var(--dsw-font-markdown-code-block,ui-monospace,monospace);font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8f98)}
.scw-paneHost{flex:1 1 auto;min-height:0;position:relative;display:flex;flex-direction:column}
.scw-paneSlot{flex:1 1 auto;min-height:0;display:flex;flex-direction:column}
.scw-paneSlot[hidden]{display:none}

/* ---- commit box ---- */
.scw-commit{flex:none;display:flex;gap:6px;align-items:flex-end;padding:6px 8px;border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));background:var(--dsw-alias-bg-layer-1,#1b1e24)}
.scw-commitInput{flex:1 1 auto;min-width:0;min-height:38px;max-height:140px;resize:vertical;padding:5px 7px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));border-radius:6px;background:var(--dsw-alias-bg-base,#14161a);color:inherit;font:inherit;font-size:12px;box-sizing:border-box}
.scw-commitInput:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#4d6bfe)}
.scw-commitSide{display:flex;flex-direction:column;gap:3px;flex:none}
.scw-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:24px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));border-radius:6px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.05));color:var(--dsw-alias-label-primary,#e6e6e6);font:inherit;font-size:11px;cursor:pointer;white-space:nowrap}
.scw-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.1))}
.scw-btn.is-primary{border-color:transparent;background:var(--dsw-alias-brand-primary,#4d6bfe);color:var(--dsw-alias-label-primary-inverted,#fff)}
/* 主按钮:hover 必须把背景再写一遍：.scw-btn:hover:not(:disabled) 的选择器优先级
   （多一个 :not 伪类）比 .is-primary 高，会把背景换成浅色通用 hover 底，
   而文字仍是反白色 —— 于是悬停时白字白底，看起来像文字消失了。 */
.scw-btn.is-primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary,#4d6bfe);filter:brightness(1.08)}
.scw-btn:disabled{opacity:.4;cursor:default}
.scw-amend{display:flex;align-items:center;gap:3px;color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:10px;cursor:pointer;user-select:none}

/* ---- empty / error ---- */
.scw-empty{flex:1 1 auto;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:18px;text-align:center;color:var(--dsw-alias-label-tertiary,#8a8f98)}
.scw-emptyTitle{font-size:12px;color:var(--dsw-alias-label-secondary,#b6bac1)}
.scw-emptyHint{font-size:11px;max-width:34em;line-height:1.5}

/* ---- inline bar (never a floating toast: it must not cover the commit button) ---- */
/* Long failures (a git auth error is several lines) must be READABLE, not clipped:
   align-items:flex-start keeps the icon at the top, overflow-wrap lets the message
   wrap instead of running off the edge, and the cap keeps one failure from eating
   the whole pane. */
.scw-bar{flex:none;display:flex;align-items:flex-start;gap:6px;margin:4px 8px 0;padding:5px 8px;border-radius:6px;font-size:11px;line-height:1.45;max-height:96px;overflow:auto;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.05));color:var(--dsw-alias-label-secondary,#b6bac1);overflow-wrap:anywhere;word-break:break-word;white-space:pre-wrap}
.scw-bar.is-error{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ff6b6b) 40%,transparent);color:var(--dsw-alias-state-error-primary,#ff6b6b)}

/* ---- dialog ---- */
.scw-backdrop{position:absolute;inset:0;z-index:20;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.42);padding:16px}
.scw-dialog{display:flex;flex-direction:column;width:min(460px,100%);max-height:80%;border-radius:var(--dsw-radius-lg,12px);border:1px solid var(--dsw-alias-border-l3,rgba(255,255,255,.16));background:var(--dsw-alias-bg-layer-2,#22262c);box-shadow:var(--dsw-elevation-prominent,0 12px 40px rgba(0,0,0,.5))}
.scw-dialogHead{display:flex;align-items:center;gap:6px;padding:9px 11px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));font-size:12px;font-weight:600}
.scw-dialog.is-wide{width:min(600px,100%)}
.scw-dialogBody{padding:11px;font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary,#b6bac1);overflow:auto}
.scw-dialogFoot{display:flex;justify-content:flex-end;gap:6px;padding:9px 11px;border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08))}

/* XS: one column, the content area overlays the tree (drill-in) */
.scw-root.is-xs .scw-treePane{width:100%!important;border-right:none}
.scw-root.is-xs .scw-content{position:absolute;inset:40px 0 0 0;z-index:5;background:var(--dsw-alias-bg-base,#14161a)}
.scw-root.is-xs .scw-body{position:relative}
/* ALWAYS visible. It used to be display:none with a rule that only turned it on in
   in the compact (XS) layout, so at normal widths the patch view had no way back at
   all — you were stuck on a diff with no route to the list you came from. */
.scw-back{display:inline-flex;align-items:center;gap:4px;flex:none;height:26px;padding:0 8px 0 4px;border:none;border-right:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));background:transparent;color:var(--dsw-alias-label-secondary,#b6bac1);font:inherit;font-size:11px;cursor:pointer}
.scw-back:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));color:var(--dsw-alias-label-primary,#fff)}
.scw-root.is-xs .scw-back{display:inline-flex}

@media (prefers-reduced-motion:reduce){.scw-root *{animation:none!important;transition:none!important}}
`

    /* ============================== page ============================== */

    /**
 * 把一段文本插进对话输入框（服务不可用时的退路）。
 *
 * 找到 composer 的可编辑元素，聚焦后走 `insertText`：这样浏览器当成一次真实的
 * 输入，React 受控组件、@引用解析、撤销栈都能正常工作。直接改 value 不行——
 * 受控组件会立刻把值覆盖回去。
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
    /* 最后退一步：任何可见的 contenteditable，取文档里最后一个（composer 通常在底部）。 */
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
    return false
  }
}
function Page(props) {
      const { t, ctx, dock, chatRef } = props
      const call = useMemo(() => makeCaller(), [])
      const visible = useDocumentVisible()
      const rootRef = useRef(null)
      const width = useElementWidth(rootRef)
      const mode = modeOfWidth(width)
      const compact = mode === 'XS'
      /* 窄窗口用上下分栏（< 1024）。宽屏仍是左右分栏。
         声明在这里，因为下面的树/内容渲染表达式要用它 —— 放到后面会落进 TDZ。 */
      const stacked = mode === 'S' || mode === 'M'

      /* ---- workspace / repo ---- */
  /* 页面级缓存：dock 只挂载当前页，切走就卸载。没有缓存时，每切回来一次就要
     重新跑一遍 status + log + branches，慢得像是卡住了。这里把上一次的结果留在
     模块作用域里，重新挂载时先用它渲染，再在后台刷新（stale-while-revalidate）。 */
  const pageCache = readPageCache()
  const [snapshot, setSnapshot] = useState(() => pageCache.snapshot)
  const [historyState, setHistoryState] = useState(() => pageCache.history)
  const [branchState, setBranchState] = useState(() => pageCache.branches)
  const [stashState, setStashState] = useState(() => pageCache.stash)
      const [workspaceRoot, setWorkspaceRoot] = useState(() => readString(ROOT_KEY, ''))
      const [repoRoot, setRepoRoot] = useState(() => readString(REPO_KEY, ''))
      const [snapshotError, setSnapshotError] = useState(null)
      const [snapshotLoading, setSnapshotLoading] = useState(false)

      /* ---- tree ---- */
      /* History paging: the limit grows by one page per '加载更多'. */
      const [historyLimit, setHistoryLimit] = useState(80)
      const [historyHasMore, setHistoryHasMore] = useState(false)
      /* Bumped by 刷新 so the panes re-read the current file/diff. */
      const [reloadTick, setReloadTick] = useState(0)
      /* Which tick the panes have already been told about. */
      const forcedTickRef = useRef(0)
      const [dirs, setDirs] = useState({})
      const [expanded, setExpanded] = useState(() => new Set())
      const [selectedRel, setSelectedRel] = useState(null)
      const [onlyChanges, setOnlyChanges] = useState(false)
      const [treeWidth, setTreeWidth] = useState(() => {
        const stored = readJson(LAYOUT_KEY, null)
        return stored !== null && typeof stored === 'object' && Number.isFinite(stored.treeWidth) ? stored.treeWidth : TREE_DEFAULT_W
      })

      /* ---- content ---- */
      const [activeTab, setActiveTab] = useState('source')
      /**
       * Unified or split. The reader decides — a narrow column wants one column of
       * text, a wide window wants side by side, and only the person looking knows
       * which. Persisted so the choice survives a remount.
       */
      const [diffMode, setDiffMode] = useState(() => {
        try { return window.localStorage.getItem(LAYOUT_KEY + '.diffMode') === 'split' ? 'split' : 'unified' } catch (error) { return 'unified' }
      })
      const diffModeRef = useRef('unified')
      const [commitMessage, setCommitMessage] = useState('')
      const [amend, setAmend] = useState(false)
      const [busy, setBusy] = useState(null)
      const [bar, setBar] = useState(null)
      const [dialog, setDialog] = useState(null)

      /* Dialog helpers live here, BEFORE every action that opens one: a
         dependency array is evaluated during render, so referencing these from
         an earlier `const` throws "Cannot access before initialization". */
      const [promptValue, setPromptValue] = useState('')
      /* Folder browser state, for the root picker. */
      const [browse, setBrowseState] = useState({ dir: '', parent: null, entries: [], drives: [], recent: [], loading: false, error: null })
      const [browsePathInput, setBrowsePathInput] = useState('')
      /* Mirrors `browse.dir` so the dialog's confirm can read the CURRENT folder
         instead of the one that was open when the handler was created. */
      const browseDirRef = useRef('')
      const changeRootRef = useRef(null)

      /**
       * One level of the real filesystem, for choosing a workspace root.
       *
       * Typing an absolute path by hand is a guessing game — one wrong separator
       * and the page points at nothing. `browse` is the host route built for
       * exactly this (it is the one route deliberately not confined to a root,
       * because the user is choosing the root).
       */
      const loadBrowse = useCallback((dir) => {
        setBrowseState((previous) => ({ dir: previous.dir, parent: previous.parent, entries: previous.entries, drives: previous.drives, recent: previous.recent, loading: true, error: null }))
        call(FILES_PREFIX, 'browse', dir === '' ? {} : { dir }).then((data) => {
          const nextDir = data !== null && data !== undefined && typeof data.dir === 'string' ? data.dir : ''
          browseDirRef.current = nextDir
          setBrowsePathInput(nextDir)
          setBrowseState((previous) => ({
            dir: nextDir,
            parent: data !== null && data !== undefined && typeof data.parent === 'string' ? data.parent : null,
            entries: data !== null && data !== undefined && Array.isArray(data.entries) ? data.entries : [],
            drives: previous.drives,
            recent: previous.recent,
            loading: false,
            error: null,
          }))
        }).catch((error) => {
          setBrowseState((previous) => ({
            dir: previous.dir,
            parent: previous.parent,
            entries: previous.entries,
            drives: previous.drives,
            recent: previous.recent,
            loading: false,
            error: error !== null && error !== undefined && typeof error.message === 'string' ? error.message : 'unknown',
          }))
        })
      }, [call])

      /**
       * The folder picker.
       *
       * It MUST offer the drives: browsing alone can only walk within the drive you
       * happen to start on, so a workspace on another volume was unreachable and the
       * only way out was typing an absolute path — the exact thing a picker exists to
       * avoid. `roots` reports the mounted drives; they become the first row.
       */
      const openBrowse = useCallback(() => {
        browseDirRef.current = workspaceRoot
        setDialog({
          kind: 'browse',
          title: t('root.title'),
          body: t('root.browseHint'),
          confirmLabel: t('root.choose'),
          /* Reads the ref, not the captured state: the user has navigated since
             this handler was created. */
          onConfirm: () => {
            if (changeRootRef.current !== null && browseDirRef.current !== '') changeRootRef.current(browseDirRef.current)
          },
        })
        loadBrowse(workspaceRoot)
        /* Drives are separate from the listing, and failing to fetch them must not
           block the picker — it just means no drive row. */
        call(FILES_PREFIX, 'roots', {}).then((data) => {
          const drives = data !== null && data !== undefined && Array.isArray(data.drives) ? data.drives : []
          const recent = data !== null && data !== undefined && Array.isArray(data.recent) ? data.recent : []
          setBrowseState((previous) => Object.assign({}, previous, { drives, recent }))
        }).catch(() => {})
      }, [loadBrowse, workspaceRoot, call, t])
      const openConfirm = useCallback((title, body, onConfirm, confirmLabel) => {
        setPromptValue('')
        setDialog({ kind: 'confirm', title, body, confirmLabel: confirmLabel ?? t('action.continue'), onConfirm })
      }, [t])

      const openPrompt = useCallback((title, body, label, initial, placeholder, onConfirm) => {
        setPromptValue(initial ?? '')
        setDialog({ kind: 'prompt', title, body, label, placeholder, onConfirm })
      }, [])

      const openMenu = useCallback((title, body, items) => {
        setPromptValue('')
        setDialog({ kind: 'menu', title, body, items })
      }, [])

      /* ---- search ---- */
      const [searchQuery, setSearchQuery] = useState('')
      const [searchMode, setSearchMode] = useState('name')
  /* 搜索修饰符，和 VSCode 一致：区分大小写 / 全词匹配 / 正则。
     宿主本来就支持这三个参数（files 的 search RPC），之前一直没接出来。 */
  const [searchCase, setSearchCase] = useState(false)
  const [searchWord, setSearchWord] = useState(false)
  const [searchRegex, setSearchRegex] = useState(false)
      const [searchState, setSearchState] = useState({ status: 'idle', files: [], error: null, truncated: false })
      const searchSeqRef = useRef(0)

      /**
       * The left pane has FIVE modes rather than a second list, because this page
       * replaces both the files page and the git page. They are the same five
       * things a person needs from a source-control sidebar:
       *
       *   变更  what I changed          (gitcraft's changes tab)
       *   文件  where things live        (files page + its search)
       *   历史  what happened            (gitcraft's log)
       *   分支  where I could go         (gitcraft's branches)
       *   贮藏  what I parked            (gitcraft's stash)
       *
       * One column, one scroll, one selection — never two lists side by side.
       */
      /* 默认落在变更页：这页最常见的工作是「看改了什么」（用户明确要求）。 */
      const [treeMode, setTreeMode] = useState('changes')
  /* 内容区弹窗放大：只切一个类，不重新挂载面板（滚动位置、光标、未保存内容都不丢）。 */
  const [contentModal, setContentModal] = useState(false)
      const [busyAction, setBusyAction] = useState(null)
      const [selectedCommit, setSelectedCommit] = useState(null)
      const [commitDetail, setCommitDetail] = useState({ status: 'idle', detail: null, error: null })
      /* Which file of the selected commit is being diffed, if any. */
      const [commitFile, setCommitFile] = useState(null)
      /**
       * Selecting a file always ends the "commit patch" view.
       *
       * An effect keyed on `selectedRel` cannot do this: clicking the SAME file
       * again does not change the value, so the effect never re-runs and the
       * commit patch stays on screen while the user asks for a working-tree diff.
       * Selection is therefore a single call that does both.
       */
      const selectRel = useCallback((rel) => {
        setCommitFile(null)
        setSelectedRel(rel)
      }, [])
      /**
       * Selecting a commit opens its WHOLE patch immediately.
       *
       * Showing only the list of touched files first made the reader click twice
       * for the thing they came for. The list is still one Back away, and clicking
       * a file there narrows the patch to that file.
       * `rel: null` means "no pathspec" — the whole commit.
       */
      const selectCommit = useCallback((hash) => {
        setSelectedCommit(hash)
        /* A commit opens its DETAIL: message, author, and the list of files it
           touched. The all-files-merged patch is one explicit button away — dumping
           one enormous patch by default buries the answer the reader came for
           ("what did this change?"), which is the file list. */
        setCommitFile(null)
      }, [])
      const [fileHistory, setFileHistory] = useState({ status: 'idle', rel: null, commits: [], error: null })
      const [blameState, setBlameState] = useState({ status: 'idle', rel: null, lines: [], error: null })

      /* ---- pane mounts ----
         No host refs: the containers attach through CALLBACK refs (see
         attachPane), because the pane slots only exist after a file is selected. */
      const sourceRootRef = useRef(null)
      const diffRootRef = useRef(null)
      /* A separate root for a COMMIT's patch: the working-tree diff pane may be
         showing something else at the same time, and one pane cannot display two
         patches. */
      const commitRootRef = useRef(null)
      const hunkActionRef = useRef(null)

      /* ============================== derived ============================== */

      /**
       * The root the LEFT PANE actually browses, and the repo<->workspace offset.
       *
       * Normally the workspace contains the repository, so the offset is the
       * nested prefix and the tree browses the workspace.
       *
       * But the git host can resolve a repository that is NOT inside the workspace
       * (a parent drive root, a symlinked realpath, a differently-cased path).
       * Then `repoRootRelative` is null and every path conversion fails — with no
       * error at all: the tree shows files, the badges never appear, and clicking
       * a change opens an empty diff. Falling back to browsing the REPOSITORY
       * keeps the page usable, which is the right call for a source-control page.
       */
      const repoOffset = useMemo(() => repoRootRelative(workspaceRoot, repoRoot), [workspaceRoot, repoRoot])
      const repoNotInWorkspace = workspaceRoot !== '' && repoRoot !== '' && repoOffset === null
      const browseRoot = repoNotInWorkspace ? repoRoot : workspaceRoot

      /**
       * Keep the shared root key in step with what this page is BROWSING.
       *
       * The editor and diff panes read their root once, from localStorage, when they
       * install — they ignore the root we hand them. So if this page browses the repo
       * root while that key still holds the workspace, the tree and the panes look at
       * two different directories and every file click answers "does not exist".
       * Written during render (before the panes can mount in the same pass), guarded by
       * a ref so it happens once per root.
       */
      const rootKeyRef = useRef('')
      if (browseRoot !== '' && rootKeyRef.current !== browseRoot) {
        rootKeyRef.current = browseRoot
        try { window.localStorage.setItem(ROOT_KEY, browseRoot) } catch (error) { void error }
      /* The files pane (which the 源码 slot mounts) reads its own root key — not ours.
         Writing only `dsh-workbay.sc.root.v1` left the editor pointed at whatever root
         it saw last, so opening a file answered "file does not exist" even though the
         path was right. Both keys must agree before the pane mounts. */
      try { window.localStorage.setItem('dsh-workbay.root.v1', browseRoot) } catch (error) { void error }
      }
      /* When we browse the repository, tree paths ARE repo paths, so the offset is
         empty rather than null (null means "cannot convert", not "no prefix"). */
      const repoRootRel = repoNotInWorkspace ? '' : repoOffset
      const statusIndex = useMemo(() => buildStatusIndex(snapshot, repoRootRel), [snapshot, repoRootRel])
      const dirtyDirs = useMemo(() => buildDirtyDirs(statusIndex), [statusIndex])

      /**
       * Is the selection a DIRECTORY?
       *
       * DERIVED, not tracked in state: three different places set `selectedRel`
       * (tree rows, search results, the changes list) and a mirrored boolean went
       * stale whenever one of them forgot to update it. The listing that drew the
       * row already knows the answer, so ask it.
       *
       * Why it matters: the panes are file viewers. Handing one a directory made
       * the editor answer "rel is a directory" — an error shown for a perfectly
       * normal click on a folder.
       */
      const selectedIsDir = useMemo(() => {
        if (selectedRel === null) return false
        const listing = dirs[dirNameOf(selectedRel)]
        if (listing === undefined || listing === null || Array.isArray(listing.entries) === false) return false
        const name = baseNameOf(selectedRel)
        return listing.entries.some((entry) => entry !== null && entry !== undefined && entry.name === name && entry.type === 'dir')
      }, [selectedRel, dirs])

      /* One collator for the page: passing an options object to localeCompare
         rebuilds an ICU collator per comparison (~11 us), which is the single
         biggest cost in a large listing. */
      const collator = useMemo(() => {
        try { return new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }) } catch (error) { void error; return null }
      }, [])

      const rows = useMemo(
        () => flattenTree(dirs, expanded, { statusIndex, dirtyDirs, onlyChanges, collator }),
        [dirs, expanded, statusIndex, dirtyDirs, onlyChanges, collator],
      )

      const changeCount = statusIndex.size
      const stagedCount = snapshot !== null && snapshot !== undefined && Array.isArray(snapshot.changes)
        ? snapshot.changes.filter((change) => change !== null && change !== undefined && change.staged === true).length
        : 0

      /* Esc 关闭弹窗，并且**不让它继续冒泡**。
         之前只写了 setContentModal(false)，事件照常传给工作台，于是弹窗关掉的同时
         整个工作台也跟着退了——用户按一次 Esc 丢了两个东西。
         用捕获阶段 + stopImmediatePropagation，抢在宿主之前处理。 */
      useEffect(() => {
        if (contentModal !== true) return undefined
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          event.stopImmediatePropagation()
          setContentModal(false)
        }
        /* 点弹窗以外的地方也关闭：弹窗是「同一份 DOM 换位置」做的，遮罩是伪元素，
           接不到点击，所以在这一层判断点击目标是否落在内容区里。 */
        const onDown = (event) => {
          const box = document.querySelector('.scw-root.is-modal .scw-content')
          if (box === null) return
          if (box.contains(event.target) === true) return
          setContentModal(false)
        }
        window.addEventListener('keydown', onKey, true)
        window.addEventListener('pointerdown', onDown, true)
        return () => {
          window.removeEventListener('keydown', onKey, true)
          window.removeEventListener('pointerdown', onDown, true)
        }
      }, [contentModal])

      /* Pick the workspace root if nobody has yet: the files page may already
         have chosen one, and honouring it is what makes the two pages feel like
         one product rather than two. */
      useEffect(() => {
        if (workspaceRoot !== '') return
        let cancelled = false
        call(FILES_PREFIX, 'roots', {}).then((data) => {
          if (cancelled || data === null || data === undefined) return
          const suggested = typeof data.root === 'string' ? data.root : ''
          if (suggested !== '' && readString(ROOT_KEY, '') === '') setWorkspaceRoot(suggested)
        }).catch(() => { /* the picker is still available */ })
        return () => { cancelled = true }
      }, [workspaceRoot, call])

      useEffect(() => { if (workspaceRoot !== '') writeString(ROOT_KEY, workspaceRoot) }, [workspaceRoot])
      useEffect(() => { writeString(REPO_KEY, repoRoot) }, [repoRoot])
      useEffect(() => { writeJson(LAYOUT_KEY, { treeWidth }) }, [treeWidth])

      /* ============================== effects: snapshot ============================== */

      /**
       * Read the git snapshot. Deliberately NOT a poll: the git page's `/watch`
       * long-poll is the right mechanism for "tell me when the repo changed",
       * but this page owns no such channel of its own — so it refreshes on
       * demand (mount, focus, explicit refresh) and after every write it
       * performs. Polling here would add a second 3-spawn loop per visible page.
       */
      const loadSnapshot = useCallback(async () => {
        if (workspaceRoot === '') return
        setSnapshotLoading(true)
        try {
          const payload = repoRoot !== '' ? { repoRoot } : { repoRoot: workspaceRoot }
          const data = await call(GIT_PREFIX, 'snapshot', payload)
          setSnapshot(data)
          setSnapshotError(null)
          /* Adopt the repository root the host resolved, so the path join has a
             real value even when the user never picked a repo explicitly. */
          if (data !== null && data !== undefined && typeof data.root === 'string' && data.root !== '' && data.root !== repoRoot) {
            setRepoRoot(data.root)
          }
        } catch (error) {
          setSnapshot(null)
          setSnapshotError(error)
        } finally {
          setSnapshotLoading(false)
        }
      }, [workspaceRoot, repoRoot, call])

      useEffect(() => {
        if (visible !== true) return undefined /* a hidden window cannot show it */
        if (workspaceRoot === '') return undefined
        void loadSnapshot()
        return undefined
      }, [visible, workspaceRoot, loadSnapshot])

      /* ============================== effects: history / branches / stash ============================== */

      /**
       * These three load LAZILY, only when their mode is actually open.
       *
       * A log costs a `git log` subprocess, branches cost a `for-each-ref`, stash
       * costs a `stash list`. Loading all three on mount would triple the startup
       * cost of a page most people open to look at their diff — so each loads on
       * first activation and caches until a write or a refresh invalidates it.
       */
      const historyLoadedRef = useRef(false)
      const branchesLoadedRef = useRef(false)
      const stashLoadedRef = useRef(false)

      const loadHistory = useCallback(async (overrideLimit) => {
        if (workspaceRoot === '') return
        setHistoryState((previous) => ({ status: 'loading', commits: previous.commits, error: null }))
        try {
                    /* An explicit limit lets the pager fetch the NEXT page in one call, instead of
             mutating state and hoping some effect notices. */
          const limit = typeof overrideLimit === 'number' && Number.isFinite(overrideLimit) ? overrideLimit : historyLimit
          const payload = repoRoot !== '' ? { repoRoot, limit } : { repoRoot: workspaceRoot, limit }
          const data = await call(GIT_PREFIX, 'log', payload)
          const commits = data !== null && data !== undefined && Array.isArray(data.commits) ? data.commits : []
          /* A full page back almost certainly means there is another one; asking git for
             an exact count costs a second round trip to save a click nobody minds. */
          setHistoryHasMore(commits.length >= limit)
          setHistoryState({ status: 'ready', commits, error: null })
          historyLoadedRef.current = true
        } catch (error) {
          setHistoryState({
            status: 'error',
            commits: [],
            error: error !== null && error !== undefined && typeof error.message === 'string' ? error.message : t('error.unknown'),
          })
        }
      }, [workspaceRoot, repoRoot, call, t, historyLimit])

      /** Grow the window by one page. The list is re-fetched rather than appended: the
         host returns it in log order, and appending would duplicate anything that moved
         because someone committed in between. */
      const loadMoreHistory = useCallback(() => {
        const next = historyLimit + 80
        setHistoryLimit(next)
        /* Fetch with the new limit RIGHT HERE. Only bumping state did nothing: no effect
           depends on `historyLimit`, so the button looked dead. */
        void loadHistory(next)
      }, [historyLimit, loadHistory])

      const loadBranches = useCallback(async () => {
        if (workspaceRoot === '') return
        setBranchState((previous) => ({ status: 'loading', branches: previous.branches, error: null }))
        try {
          const payload = repoRoot !== '' ? { repoRoot } : { repoRoot: workspaceRoot }
          const data = await call(GIT_PREFIX, 'branches', payload)
          /* The host returns the array directly; tolerate an envelope too so a
             future shape change does not blank the panel. */
          const branches = Array.isArray(data) ? data
            : (data !== null && data !== undefined && Array.isArray(data.branches) ? data.branches : [])
          setBranchState({ status: 'ready', branches, error: null })
          branchesLoadedRef.current = true
        } catch (error) {
          setBranchState({
            status: 'error',
            branches: [],
            error: error !== null && error !== undefined && typeof error.message === 'string' ? error.message : t('error.unknown'),
          })
        }
      }, [workspaceRoot, repoRoot, call, t])

      const loadStash = useCallback(async () => {
        if (workspaceRoot === '') return
        setStashState((previous) => ({ status: 'loading', stash: previous.stash, error: null }))
        try {
          const payload = repoRoot !== '' ? { repoRoot } : { repoRoot: workspaceRoot }
          const data = await call(GIT_PREFIX, 'stashList', payload)
          const stash = data !== null && data !== undefined && Array.isArray(data.stash) ? data.stash : []
          setStashState({ status: 'ready', stash, error: null })
          stashLoadedRef.current = true
        } catch (error) {
          setStashState({
            status: 'error',
            stash: [],
            error: error !== null && error !== undefined && typeof error.message === 'string' ? error.message : t('error.unknown'),
          })
        }
      }, [workspaceRoot, repoRoot, call, t])

      useEffect(() => {
        if (treeMode !== 'history' || visible !== true || workspaceRoot === '') return undefined
        if (historyLoadedRef.current === true) return undefined
        void loadHistory()
        return undefined
      }, [treeMode, visible, workspaceRoot, loadHistory])

      useEffect(() => {
        if (treeMode !== 'branches' || visible !== true || workspaceRoot === '') return undefined
        if (branchesLoadedRef.current === true) return undefined
        void loadBranches()
        return undefined
      }, [treeMode, visible, workspaceRoot, loadBranches])

      useEffect(() => {
        if (treeMode !== 'stash' || visible !== true || workspaceRoot === '') return undefined
        if (stashLoadedRef.current === true) return undefined
        void loadStash()
        return undefined
      }, [treeMode, visible, workspaceRoot, loadStash])

      /* Loading a commit's detail is keyed on the selection, and cancelled by
         identity: clicking two commits quickly must not let the first one's
         response overwrite the second one's panel.

         NOTE: nothing here clears `commitFile`. It used to, and that made the
         patch view impossible to open — `selectCommit` sets BOTH `selectedCommit`
         and `commitFile` in one click, so a clearing effect fired on the very next
         render and wiped the patch it had just asked for. `selectRel` clears it
         when a FILE is selected; that is the only place it needs clearing. */
      useEffect(() => {
        if (selectedCommit === null || workspaceRoot === '') {
          setCommitDetail({ status: 'idle', detail: null, error: null })
          return undefined
        }
        let cancelled = false
        setCommitDetail({ status: 'loading', detail: null, error: null })
        call(GIT_PREFIX, 'commitDetail', { repoRoot, rev: selectedCommit }).then((data) => {
          if (cancelled) return
          setCommitDetail({ status: 'ready', detail: data, error: null })
        }).catch((error) => {
          if (cancelled) return
          setCommitDetail({
            status: 'error',
            detail: null,
            error: error !== null && error !== undefined && typeof error.message === 'string' ? error.message : t('error.unknown'),
          })
        })
        return () => { cancelled = true }
      }, [selectedCommit, workspaceRoot, repoRoot, call, t])

      /* ============================== effects: tree loading ============================== */

      const dirReqsRef = useRef(new Map())

      const loadDir = useCallback(async (dirRel, options) => {
        if (browseRoot === '') return
        const opts = options !== null && options !== undefined ? options : {}
        const force = opts.force === true
        const existing = dirs[dirRel]
        if (!force && existing !== undefined && existing !== null && (existing.status === 'loading' || existing.status === 'ready')) return
        const token = (dirReqsRef.current.get(dirRel) || 0) + 1
        dirReqsRef.current.set(dirRel, token)
        setDirs((previous) => Object.assign({}, previous, {
          [dirRel]: { status: 'loading', error: null, entries: previous[dirRel] !== undefined && Array.isArray(previous[dirRel].entries) ? previous[dirRel].entries : [], truncated: false },
        }))
        try {
          const data = await call(FILES_PREFIX, 'tree', { root: browseRoot, dir: dirRel })
          if (dirReqsRef.current.get(dirRel) !== token) return
          setDirs((previous) => Object.assign({}, previous, {
            [dirRel]: {
              status: 'ready',
              entries: data !== null && data !== undefined && Array.isArray(data.entries) ? data.entries : [],
              truncated: data !== null && data !== undefined && data.truncated === true,
              error: null,
            },
          }))
        } catch (error) {
          if (dirReqsRef.current.get(dirRel) !== token) return
          setDirs((previous) => Object.assign({}, previous, {
            [dirRel]: Object.assign({}, previous[dirRel] === undefined ? {} : previous[dirRel], {
              status: 'error',
              error: error !== null && error !== undefined ? error.message : t('error.unknown'),
              truncated: false,
            }),
          }))
        }
      }, [browseRoot, dirs, call, t])

      /* First paint, and re-paint when the browsed root changes.
         The repo fallback can flip only AFTER the first snapshot arrives, and the
         cached listings belong to the OLD root — reusing them would show the
         workspace tree under a repository header. So a root change drops them. */
      const paintedRootRef = useRef(browseRoot)
      useEffect(() => {
        if (browseRoot === '') return
        if (paintedRootRef.current !== browseRoot) {
          paintedRootRef.current = browseRoot
          setDirs({})
          setExpanded(new Set(['']))
          setSelectedRel(null)
          void loadDir('', { force: true })
          return
        }
        void loadDir('')
        /* eslint-disable-next-line react-hooks/exhaustive-deps */
      }, [browseRoot])

      /* ============================== search ============================== */

      /**
       * Run the search through the FILES host.
       *
       * Why not the git host's own `search`: the file host's is a superset (regex,
       * include/exclude globs, context lines, fuzzy name scoring), and this page
       * already depends on it for the tree. Using one search backend for both the
       * tree and the quick-open box means the two can never disagree about what
       * matches.
       *
       * Debounced: typing must not fire a repo-wide content scan per keystroke.
       * Cancelled by sequence number, so a slow earlier query cannot overwrite a
       * fast later one (the classic search race).
       */
      useEffect(() => {
        const query = searchQuery.trim()
        if (query === '' || workspaceRoot === '') {
          setSearchState({ status: 'idle', files: [], error: null, truncated: false })
          return undefined
        }
        const seq = searchSeqRef.current + 1
        searchSeqRef.current = seq
        setSearchState((previous) => ({ status: 'loading', files: previous.files, error: null, truncated: false }))
        const timer = setTimeout(() => {
          const payload = {
            root: browseRoot,
            mode: searchMode,
            query,
            maxResults: 200,
            /* 名字模式是模糊匹配，这三个开关对它无效——只在内容模式下发。
               宿主本来就认这三个参数，只是面板以前没把它们接出来。 */
            caseSensitive: searchMode === 'content' && searchCase === true,
            wholeWord: searchMode === 'content' && searchWord === true,
            regex: searchMode === 'content' && searchRegex === true,
          }
          call(FILES_PREFIX, 'search', payload).then((data) => {
            if (searchSeqRef.current !== seq) return
            setSearchState({
              status: 'ready',
              /* 记住这批结果是哪个模式产出的：渲染前比对，跨模式的结果一行都不显示。 */
              mode: searchMode,
              files: data !== null && data !== undefined && Array.isArray(data.files) ? data.files : [],
              error: null,
              truncated: data !== null && data !== undefined && data.truncated === true,
            })
          }).catch((error) => {
            if (searchSeqRef.current !== seq) return
            if (error !== null && error !== undefined && error.code === 'aborted') return
            setSearchState({
              status: 'error',
              files: [],
              error: error !== null && error !== undefined && typeof error.message === 'string' ? error.message : t('error.unknown'),
              truncated: false,
            })
          })
        }, 220)
        return () => { clearTimeout(timer) }
      }, [searchQuery, searchMode, workspaceRoot, call, t, searchCase, searchWord, searchRegex, browseRoot])

      /** Flatten the host's grouped result into clickable rows. */

      const searchRows = useMemo(() => {
        if (searchState.status !== 'ready') return []
        /* 结果属于「上一次的哪个模式」必须对上，否则切模式时会拿内容模式的行去当文件行渲染。 */
        if (searchState.mode !== searchMode) return []
        const out = []
        for (const file of searchState.files) {
          if (file === null || file === undefined || typeof file.rel !== 'string') continue
          const rel = normalizeRel(file.rel)
          if (rel === '') continue
          const change = statusIndex.get(rel)
          const letter = statusLetterOf(change)
          if (searchMode === 'name') {
            out.push(E('div', {
              key: 'q:' + rel,
              className: 'scw-row' + (rel === selectedRel ? ' is-active' : ''),
              role: 'button',
              tabIndex: 0,
              title: rel,
              onClick: () => { selectRel(rel); setActiveTab(change !== null && change !== undefined ? 'diff' : 'source') },
              onKeyDown: (event) => {
                if (event.key !== 'Enter') return
                event.preventDefault()
                selectRel(rel)
                setActiveTab(change !== null && change !== undefined ? 'diff' : 'source')
              },
            },
            E('span', { className: 'scw-rowChevron' }),
            E(Icon, { name: 'file', size: 13, className: 'scw-rowIcon' }),
            /* Match highlighting is a nice-to-have; the host already returns
               `indices`, so paint them rather than re-deriving what it knows. */
            E('span', { className: 'scw-rowName' }, highlightName(baseNameOf(rel), file.indices, rel)),
            E('span', { className: 'scw-rowDir' }, dirNameOf(rel)),
            letter === '' ? null : E('span', { className: 'scw-letter ' + statusColorClass(letter) }, letter)))
            continue
          }
          /* Content mode: one row per file, then one row per match. Collapsed by
             default would hide the thing the user searched for; show the first
             few matches and let the count speak for the rest. */
          out.push(E('div', {
            key: 'c:' + rel,
            className: 'scw-row is-dir' + (rel === selectedRel ? ' is-active' : ''),
            role: 'button',
            tabIndex: 0,
            title: rel,
            onClick: () => { selectRel(rel); setActiveTab('source') },
          },
          E('span', { className: 'scw-rowChevron' }),
          E(Icon, { name: 'file', size: 13, className: 'scw-rowIcon' }),
          E('span', { className: 'scw-rowName' }, baseNameOf(rel)),
          E('span', { className: 'scw-rowDir' }, dirNameOf(rel)),
          letter === '' ? null : E('span', { className: 'scw-letter ' + statusColorClass(letter) }, letter)))
          const matches = Array.isArray(file.matches) ? file.matches.slice(0, 6) : []
          for (const match of matches) {
            out.push(E('div', {
              key: 'c:' + rel + ':' + match.line,
              className: 'scw-matchRow',
              role: 'button',
              tabIndex: 0,
              title: rel + ':' + match.line,
            onClick: () => {
              selectRel(rel)
              setActiveTab('source')
              /* 点匹配行直接滚到那一行，而不是只把文件打开让你自己找。 */
              const page = sourcePage
              if (page !== null && page !== undefined && page.commands !== undefined
                && typeof page.commands.jump === 'function') {
                try { page.commands.jump(rel, match.line) } catch (error) { void error }
              }
            },
            },
            E('span', { className: 'scw-matchLine' }, String(match.line)),
            E('span', { className: 'scw-matchText' }, typeof match.text === 'string' ? match.text.trim() : '')))
          }
        }
        return out
      }, [searchState, searchMode, selectedRel, statusIndex])

      const toggleDir = useCallback((rel) => {
        setExpanded((previous) => {
          const next = new Set(previous)
          if (next.has(rel)) next.delete(rel)
          else {
            next.add(rel)
            void loadDir(rel)
          }
          return next
        })
      }, [loadDir])

      const refresh = useCallback(() => {
        if (workspaceRoot === '') return
        const loaded = Object.keys(dirs)
        /* Re-deliver the current selection to the panes. A pane that failed to read a
           file (deleted, just being written, wrong root at mount) keeps its error
           until something tells it to try again — refreshing the tree alone left it
           stuck on does not exist forever. */
        setReloadTick((value) => value + 1)
        for (const dirRel of loaded) void loadDir(dirRel, { force: true })
        void loadDir('', { force: true })
        void loadSnapshot()
        /* Only refresh the panels that have actually been opened once; forcing a
           `git log` on a page the user is using for diffs buys nothing. */
        if (historyLoadedRef.current === true) void loadHistory()
        if (branchesLoadedRef.current === true) void loadBranches()
        if (stashLoadedRef.current === true) void loadStash()
      }, [workspaceRoot, dirs, loadDir, loadSnapshot, loadHistory, loadBranches, loadStash])

      /* ============================== pane mounting ============================== */

      /**
       * Mount the two panes from the OTHER TWO pages.
       *
       * This is the whole trick of the design, and it is the same one the dock
       * itself uses for its overlay: a React root this page owns, mounted into a
       * container this page owns. Consequences worth stating:
       *
       *  - the two panes keep their own state, their own styles and their own
       *    error boundary, so a crash in one cannot blank the other;
       *  - this page never imports their components, so it cannot break them by
       *    accident, and they stay independently installable;
       *  - `commands` is the ONLY channel back: this page asks, it never reaches
       *    into their internals.
       */
      const sourcePage = useMemo(() => {
        if (dock === undefined || dock === null || typeof dock.get !== 'function') return null
        return dock.get('files') || null
      }, [dock])
      const diffPage = useMemo(() => {
        if (dock === undefined || dock === null || typeof dock.get !== 'function') return null
        return dock.get('gitcraft') || null
      }, [dock])

      /**
       * Live values for the pane's mount CONTEXT.
       *
       * `repoRoot` starts empty and is filled in when the git snapshot arrives;
       * the panes mount on the first file click, which can be before OR after
       * that. A `useCallback`-captured value would freeze whichever was true at
       * mount time, and the git host answers an empty root with
       * "cwd, repoRoot, dir or sessionId is required" — so the diff pane sat on
       * "正在读取差异…" forever with no error shown.
       *
       * A ref always reads the value at MOUNT time, which is the latest one.
       */
      /**
       * The current selection in every shape a pane needs, refreshed each render.
       *
       * Reading it at MOUNT time is what lets a rebuilt pane resume where the user
       * was, without the push effect having to know about remounts.
       */
      const selectionRef = useRef(null)
      const contextRef = useRef({ repoRoot: '', workspaceRoot: '' })
      contextRef.current = { repoRoot, workspaceRoot: browseRoot }
      diffModeRef.current = diffMode
      contextRef.current = { repoRoot, workspaceRoot: browseRoot }
      /* Kept in sync every render so a pane that mounts later can resume. */
      selectionRef.current = (() => {
        if (selectedRel !== null && selectedIsDir !== true) {
          const change = statusIndex.get(selectedRel)
          return {
            rel: selectedRel,
            repoRel: repoRootRel === null ? null : toRepoPath(selectedRel, repoRootRel),
            base: change !== null && change !== undefined && change.staged === true && change.untracked !== true ? 'staged' : 'worktree',
            commitRel: null,
            commitRev: null,
          }
        }
        if (commitFile !== null && commitFile !== undefined) {
          return { rel: null, repoRel: null, base: 'worktree', commitRel: commitFile.rel === undefined ? null : commitFile.rel, commitRev: commitFile.rev }
        }
        return null
      })()

      const mountPaneRef = useRef(null)
      const mountPane = useCallback((which, host, page) => {
        if (host === null || host === undefined) return
        const roots = which === 'source' ? sourceRootRef : which === 'commit' ? commitRootRef : diffRootRef
        const paneFn = page !== null && page !== undefined && page.panes !== undefined && page.panes !== null
          ? page.panes[which === 'source' ? 'source' : 'diff']
          : undefined
        if (typeof paneFn !== 'function') {
          /* No pane published: leave the host empty and let the shell explain why
             (an actionable empty state beats a crash or a blank box). */
          return
        }
        if (roots.current !== null) return
        const live = contextRef.current
        let mounted = null
        try {
          mounted = paneFn(host, {
            /* Stable for the pane's lifetime, read at mount time (see above). */
            repoRoot: live.repoRoot,
            workspaceRoot: live.workspaceRoot,
            t,
            visible: true,
            /* The workbench may mount this pane twice (working diff + a commit's
               patch). Only the primary one becomes the other page's `commands`
               target, or the commit pane would hijack the working-tree diff. */
            primary: which === 'diff',
            /* Hunk-level staging, offered only by the working-tree diff pane. The
               pane renders the chips and reports which hunk was clicked; the RPC
               and the path join stay here. Going through a ref keeps the callback
               stable, so the pane never remounts because a closure changed. */
            onHunkAction: which === 'diff' ? (ref) => { hunkActionRef.current(ref) } : undefined,
          })
        } catch (error) {
          void error
          return
        }
        /* Panes return { dispose, handle }; accept a bare function too so a
           third-party page implementing the older shape still works. */
        if (typeof mounted === 'function') roots.current = { dispose: mounted, handle: null }
        else if (mounted !== null && mounted !== undefined) roots.current = { dispose: mounted.dispose, handle: mounted.handle }

        /**
         * Replay the CURRENT selection into the pane that just mounted.
         *
         * A pane can be torn down and rebuilt (the host re-renders the slot and
         * React re-attaches the callback ref). The push effect only runs when the
         * SELECTION changes, so a fresh pane would sit empty until the user
         * clicked again — which reads as "the diff is broken".
         */
        const replay = selectionRef.current
        const handle = roots.current === null ? null : roots.current.handle
        if (handle === null || handle === undefined) return
        try {
          if (which === 'commit') {
            if (typeof handle.showDiff === 'function') {
              const options = { base: 'commit', rev: replay === null ? null : replay.commitRev }
              const whole = replay === null || replay.commitRel === null
              if (whole === true) options.whole = true
              handle.showDiff(whole === true ? '' : replay.commitRel, options)
            }
          } else if (which === 'diff') {
            if (typeof handle.showDiff === 'function' && replay !== null && replay.repoRel !== null) {
              handle.showDiff(replay.repoRel, { base: replay.base })
            }
          } else if (typeof handle.openFile === 'function' && replay !== null && replay.rel !== null) {
            handle.openFile(replay.rel)
          }
          if (typeof handle.setMode === 'function') handle.setMode(diffModeRef.current)
        } catch (error) { void error }
      }, [t])

      /* mountPane closes over 	; keep the LATEST version in a ref so attachPane can
         call it without taking an identity dependency (which would remount on every
         locale change). */
      mountPaneRef.current = mountPane
      const mountedRootRef = useRef('')
      /**
       * Tear a pane down, for real.
       *
       * The callback ref used to ignore `null`, so a slot that unmounted left its
       * React root mounted into a detached node and `roots.current` stayed non-null —
       * which then BLOCKED the remount through the `roots.current !== null` guard.
       * That is why a pane could go permanently dead after a re-layout.
       */
      const disposePane = (which) => {
        const ref = which === 'source' ? sourceRootRef : which === 'commit' ? commitRootRef : diffRootRef
        const live = ref.current
        ref.current = null
        if (live === null || live === undefined) return
        try { if (typeof live.dispose === 'function') live.dispose() } catch (error) { void error }
      }

      const attachPane = useCallback((which, page) => (node) => {
        if (node === null) {
          disposePane(which)
          return
        }
        /* A pane reads its root ONCE, from localStorage, when it installs. When this
           page browses a different root than the workspace (the repo root case), the
           tree and the editor would read different directories: every file click says
           "does not exist" and refreshing cannot help, because the editor never
           re-reads its root. Remounting is the only way to hand it the new one. */
        if (mountedRootRef.current !== '' && mountedRootRef.current !== browseRoot) disposePane(which)
        mountedRootRef.current = browseRoot
        mountPaneRef.current(which, node, page)
      }, [browseRoot])

      const sourceRefCb = useCallback(attachPane('source', sourcePage), [attachPane, sourcePage])
      const diffRefCb = useCallback(attachPane('diff', diffPage), [attachPane, diffPage])
      const commitRefCb = useCallback(attachPane('commit', diffPage), [attachPane, diffPage])

      useEffect(() => () => {
        for (const ref of [sourceRootRef, diffRootRef, commitRootRef]) {
          if (ref.current !== null && ref.current !== undefined && typeof ref.current.dispose === 'function') {
            try { ref.current.dispose() } catch (error) { void error }
          }
          ref.current = null
        }
        
      }, [])

      /**
       * Push the selection into BOTH panes.
       *
       * This runs on selection change AND on a retry timer, because of a race
       * that only shows up in a real browser: the click that selects a file also
       * renders the pane containers for the first time (they do not exist while
       * the content area shows its empty state). The callback ref mounts the
       * panes during that render, but the pane's own `useEffect` — the one that
       * installs its imperative handle — has not run yet when this effect fires.
       * So the first push goes into a command whose handle is still null and is
       * silently dropped, and the pane sits on its initial empty state forever.
       *
       * Rather than guess a delay, retry: a few short attempts until the pane
       * reports it accepted something. Cheap (three timer ticks) and it removes
       * an ordering assumption that has no guaranteed answer.
       */
      useEffect(() => {
        /* A directory has no content and no diff. Pushing one made the file
           panes answer "rel is a directory" — an error shown for a normal click. */
        if (selectedRel === null || selectedIsDir === true) return undefined
        let cancelled = false
        let attempts = 0

        const repoRelative = repoRootRel === null ? null : toRepoPath(selectedRel, repoRootRel)

        const push = () => {
          if (cancelled) return true
          let delivered = false
          try {
            if (sourcePage !== null && sourcePage !== undefined && sourcePage.commands !== undefined && sourcePage.commands !== null
              && typeof sourcePage.commands.openFile === 'function') {
              sourcePage.commands.openFile(selectedRel)
              delivered = true
            }
          } catch (error) { void error }
          try {
            if (repoRelative !== null
              && diffPage !== null && diffPage !== undefined && diffPage.commands !== undefined && diffPage.commands !== null
              && typeof diffPage.commands.showDiff === 'function') {
              /**
               * Tell the pane WHICH diff to show.
               *
               * An unstaged file is diffed against the worktree; a staged one has
               * nothing left in the worktree, so `git diff` would return an empty
               * patch and the user would think their staged change vanished. And a
               * selected commit shows that commit's patch. Getting this wrong is
               * silent — the pane just shows the wrong side of the change.
               */
              const change = statusIndex.get(selectedRel)
              /* An untracked file has no diff at all: it is in neither HEAD nor the index,
                 so a worktree diff prints nothing and the reader sees an empty patch for
                 a file they just created. The pane has an all-added form for exactly this. */
              /* A forced tick (refresh, or a hunk write) means "same target, new
                 content": the pane has to re-read instead of reusing its patch. */
              const force = reloadTick !== forcedTickRef.current
              if (force) forcedTickRef.current = reloadTick
              const options = change !== null && change !== undefined && change.untracked === true
                ? { base: 'untracked', force }
                : change !== null && change !== undefined && change.staged === true
                  ? { base: 'staged', force }
                  : { base: 'worktree', force }
              diffPage.commands.showDiff(repoRelative, options)
              delivered = true
            }
          } catch (error) { void error }
          return delivered
        }

        push()
        const timer = setInterval(() => {
          attempts += 1
          /* The pane handle appears one or two frames after the container mounts.
             Stop as soon as a push has somewhere to go, or after ~400ms. */
          const delivered = push()
          if (delivered === true || attempts >= 8) clearInterval(timer)
        }, 50)

        return () => {
          cancelled = true
          clearInterval(timer)
        }
      /* NOTE: `activeTab` is deliberately NOT a dependency here.
         Re-running this effect re-pushes BOTH panes, and re-pushing the diff aborts
         the fetch that is already in flight — switching 源码 -> 变更 then showed
         "读取超时" instead of the patch. The source pane is re-pushed by its own
         effect below; the diff only follows the selection. */
      }, [selectedRel, selectedIsDir, sourcePage, diffPage, repoRootRel, reloadTick])
      /**
       * Re-read the open file when the reader asks for a refresh.
       *
       * Re-pushing the selection is not enough: the editor pane treats `openFile` on an
       * already-open tab as "activate it", so the buffer keeps whatever it read first.
       * Its `reload` command is the only thing that goes back to disk.
       */
      useEffect(() => {
        if (reloadTick === 0) return
        const page = sourcePage
        if (page === null || page === undefined || page.commands === undefined || page.commands === null) return
        if (typeof page.commands.reload !== 'function' || selectedRel === null) return
        try { page.commands.reload(selectedRel) } catch (error) { void error }
      }, [reloadTick])
      /* Switching to the 源码 tab after reading a diff must hand the file to the editor
         again: the pane was hidden while the diff was showing, and `openFile` on an
         already-open tab only activates it. Scoped to the SOURCE pane on purpose —
         re-pushing the diff here is what aborted its in-flight fetch and produced
         "读取超时" when the user toggled between the two tabs. */
      useEffect(() => {
        if (activeTab !== 'source') return
        if (selectedRel === null || selectedIsDir === true) return
        const page = sourcePage
        if (page === null || page === undefined || page.commands === undefined || page.commands === null) return
        if (typeof page.commands.openFile !== 'function') return
        try { page.commands.openFile(selectedRel) } catch (error) { void error }
      }, [activeTab, selectedRel, selectedIsDir, sourcePage])
      /**
       * Show the selected commit's patch for one file.
       *
       * Retried like the main push for the same reason: the pane mounts during the
       * render that first shows this view, so its handle exists a frame later.
       * `base: 'commit'` + `rev` is what tells the pane this is history, not a
       * working-tree change — and that is also why it gets no hunk buttons.
       */
      useEffect(() => {
        if (commitFile === null || commitFile === undefined) return undefined
        let attempts = 0
        const push = () => {
          const roots = commitRootRef.current
          if (roots === null || roots === undefined || roots.handle === null || roots.handle === undefined) return false
          if (typeof roots.handle.showDiff !== 'function') return false
          try {
            /* `rel: null` = the whole commit: no pathspec at all. */
            const whole = commitFile.rel === null || commitFile.rel === undefined
            const options = { base: 'commit', rev: commitFile.rev }
            if (whole === true) options.whole = true
            roots.handle.showDiff(whole === true ? '' : commitFile.rel, options)
            return true
          } catch (error) { void error; return false }
        }
        push()
        const timer = setInterval(() => {
          attempts += 1
          if (push() === true || attempts >= 10) clearInterval(timer)
        }, 50)
        return () => { clearInterval(timer) }
      }, [commitFile, reloadTick])

      /** Push the mode into whichever diff pane is on screen (or both). */
      useEffect(() => {
        try { window.localStorage.setItem(LAYOUT_KEY + '.diffMode', diffMode) } catch (error) { void error }
        for (const ref of [diffRootRef, commitRootRef]) {
          const roots = ref.current
          if (roots === null || roots === undefined || roots.handle === null || roots.handle === undefined) continue
          if (typeof roots.handle.setMode === 'function') {
            try { roots.handle.setMode(diffMode) } catch (error) { void error }
          }
        }
      }, [diffMode])

      /* ============================== actions ============================== */

      const hasDirty = useCallback((rel) => {
        if (sourcePage === null || sourcePage === undefined || sourcePage.commands === undefined) return false
        if (typeof sourcePage.commands.hasDirty !== 'function') return false
        try { return sourcePage.commands.hasDirty(rel) === true } catch (error) { void error; return false }
      }, [sourcePage])

      const afterWrite = useCallback(() => {
        void loadSnapshot()
        const page = sourcePage
        if (page !== null && page !== undefined && page.commands !== undefined && page.commands !== null
          && typeof page.commands.reload === 'function' && selectedRel !== null) {
          try { page.commands.reload(selectedRel) } catch (error) { void error }
        }
      }, [loadSnapshot, sourcePage, selectedRel])

      const runWrite = useCallback(async (method, payload, label) => {
        setBusy(label)
        setBar(null)
        try {
          await call(GIT_PREFIX, method, payload)
          afterWrite()
        } catch (error) {
          setBar({ kind: 'error', message: error !== null && error !== undefined ? error.message : t('error.unknown') })
        } finally {
          setBusy(null)
        }
      }, [call, afterWrite, t])

      /**
       * A repo-level write: runs the method, then invalidates EVERYTHING that
       * could have changed.
       *
       * `runWrite` is enough for file-level staging, but a checkout, a merge or a
       * push can change the commit graph, the branch list, the stash and the
       * working tree at once. Refreshing only the snapshot leaves the other panels
       * showing the previous world, which reads as "the action did nothing".
       */
      const runGitOp = useCallback(async (method, payload, label) => {
        setBusyAction(label)
        setBar(null)
        try {
          const data = await call(GIT_PREFIX, method, payload)
          historyLoadedRef.current = false
          branchesLoadedRef.current = false
          stashLoadedRef.current = false
          void loadSnapshot()
          void loadDir('', { force: true })
          if (treeMode === 'history') void loadHistory()
          if (treeMode === 'branches') void loadBranches()
          if (treeMode === 'stash') void loadStash()
          setBar({ kind: 'info', message: t('bar.done') + ' ' + label })
          return data
        } catch (error) {
          setBar({ kind: 'error', message: error !== null && error !== undefined ? error.message : t('error.unknown') })
          return null
        } finally {
          setBusyAction(null)
        }
      }, [call, loadSnapshot, loadDir, loadHistory, loadBranches, loadStash, treeMode, t])

      /* ---------- sync ---------- */

      const doFetch = useCallback(() => { void runGitOp('fetch', { repoRoot }, 'fetch') }, [runGitOp, repoRoot])
      const doPull = useCallback(() => {
        void runGitOp('pull', { repoRoot }, 'pull')
      }, [runGitOp, repoRoot])
      const doPush = useCallback(() => {
        /* Force-push is never offered. It rewrites other people's history and a
           two-click path to it is how teams lose commits; it stays a
           command-line decision. */
        void runGitOp('push', { repoRoot }, 'push')
      }, [runGitOp, repoRoot])

      /* ---------- branch ---------- */

      const doBranchCreate = useCallback(() => {
        openPrompt(t('branch.createTitle'), t('branch.createBody'), t('branch.nameLabel'), '', t('branch.namePlaceholder'), (value) => {
          const name = value.trim()
          if (name === '') return
          void runGitOp('branchCreate', { repoRoot, name }, 'branchCreate').then(() => {
            branchesLoadedRef.current = false
            void loadBranches()
          })
        })
      }, [openPrompt, runGitOp, repoRoot, loadBranches, t])

      const doBranchDelete = useCallback((branch) => {
        const name = branch.name
        openConfirm(
          t('branch.deleteTitle') + ' — ' + name,
          t('branch.deleteBody'),
          () => {
            void runGitOp('branchDelete', { repoRoot, name }, 'branchDelete').then(() => {
              branchesLoadedRef.current = false
              void loadBranches()
            })
          },
          t('action.delete'),
        )
      }, [openConfirm, runGitOp, repoRoot, loadBranches, t])

      /* ---------- merge / rebase / pick / revert / reset ---------- */

      const doMerge = useCallback((ref) => {
        openConfirm(
          t('op.mergeTitle') + ' — ' + ref,
          t('op.mergeBody'),
          () => { void runGitOp('merge', { repoRoot, rev: ref }, 'merge') },
          t('op.merge'),
        )
      }, [openConfirm, runGitOp, repoRoot, t])

      const doRebase = useCallback((ref) => {
        openConfirm(
          t('op.rebaseTitle') + ' — ' + ref,
          t('op.rebaseBody'),
          () => { void runGitOp('rebase', { repoRoot, onto: ref }, 'rebase') },
          t('op.rebase'),
        )
      }, [openConfirm, runGitOp, repoRoot, t])

      const doCherryPick = useCallback((hash) => {
        void runGitOp('cherryPick', { repoRoot, rev: hash }, 'cherryPick')
      }, [runGitOp, repoRoot])

      const doRevert = useCallback((hash) => {
        openConfirm(
          t('op.revertTitle'),
          t('op.revertBody') + ' ' + hash.slice(0, 8),
          () => { void runGitOp('revert', { repoRoot, rev: hash }, 'revert') },
          t('op.revert'),
        )
      }, [openConfirm, runGitOp, repoRoot, t])

      const doReset = useCallback((hash) => {
        openMenu(
          t('op.resetTitle') + ' — ' + hash.slice(0, 8),
          t('op.resetBody'),
          [
            {
              label: t('op.resetSoft'),
              title: t('op.resetSoftHint'),
              onSelect: () => { void runGitOp('reset', { repoRoot, rev: hash, mode: 'soft' }, 'reset') },
            },
            {
              label: t('op.resetMixed'),
              title: t('op.resetMixedHint'),
              onSelect: () => { void runGitOp('reset', { repoRoot, rev: hash, mode: 'mixed' }, 'reset') },
            },
            {
              label: t('op.resetHard'),
              title: t('op.resetHardHint'),
              danger: true,
              /* `hard` needs an explicit confirm flag in the host, and it is the
                 only mode that throws away uncommitted work. */
              onSelect: () => {
                openConfirm(t('op.resetHardTitle'), t('op.resetHardBody'), () => {
                  void runGitOp('reset', { repoRoot, rev: hash, mode: 'hard', confirm: true }, 'reset')
                }, t('op.resetHard'))
              },
            },
          ],
        )
      }, [openMenu, openConfirm, runGitOp, repoRoot, t])

      /* ---------- conflict ---------- */

      const doConflictResolve = useCallback((paths, side) => {
        void runGitOp('conflictResolve', { repoRoot, paths, side }, 'conflictResolve')
      }, [runGitOp, repoRoot])

      const doConflictContinue = useCallback(() => {
        /* Which continue to call depends on what git is in the middle of; the
           snapshot reports it, so ask it rather than guessing. */
        const operation = snapshot !== null && snapshot !== undefined ? snapshot.operation : null
        const method = operation === 'rebase' ? 'rebaseContinue' : 'mergeContinue'
        void runGitOp(method, { repoRoot }, method)
      }, [runGitOp, repoRoot, snapshot])

      const doConflictAbort = useCallback(() => {
        const operation = snapshot !== null && snapshot !== undefined ? snapshot.operation : null
        const method = operation === 'rebase' ? 'rebaseAbort' : 'mergeAbort'
        openConfirm(t('op.abortTitle'), t('op.abortBody'), () => {
          void runGitOp(method, { repoRoot }, method)
        }, t('op.abort'))
      }, [openConfirm, runGitOp, repoRoot, snapshot, t])

      /* ---------- tag ---------- */

      const doTagCreate = useCallback((rev) => {
        openPrompt(t('tag.createTitle'), rev === undefined ? t('tag.createBodyHead') : (t('tag.createBody') + ' ' + String(rev).slice(0, 8)),
          t('tag.nameLabel'), '', t('tag.namePlaceholder'), (value) => {
            const name = value.trim()
            if (name === '') return
            const payload = { repoRoot, name }
            if (rev !== undefined && rev !== null) payload.rev = String(rev)
            void runGitOp('tagCreate', payload, 'tagCreate')
          })
      }, [openPrompt, runGitOp, repoRoot, t])


      /**
       * Push tags that exist locally but not on the remote.
       *
       * The page could create tags but never publish them, so a release flow of
       * "tag it and push" needed a terminal step. `tagRemoteState` tells us exactly
       * which local tags the remote does not have; pushing one at a time (rather than
       * `push --tags`) keeps it deliberate — a tag push is not undoable on the server
       * without a force.
       */
      /** 推送单个标签（分支/标签行上的按钮）。 */
      const doTagPushOne = useCallback((name) => {
        if (typeof name !== 'string' || name.trim() === '') return
        void runGitOp('tagPush', { repoRoot, name: name.trim(), remote: 'origin' }, 'tagPush')
      }, [repoRoot, runGitOp])

      /**
       * 删除标签。
       *
       * 先问一句：标签可能已经在远端发布过，删本地之后远端还留着，下次 fetch 又回来。
       * 所以确认文案要说清楚删哪几个地方。
       */
      const doTagDelete = useCallback((name) => {
        if (typeof name !== 'string' || name.trim() === '') return
        const tag = name.trim()
        openConfirm(t('tag.deleteTitle'), t('tag.deleteBody').replace('{tag}', tag),
          () => { void runGitOp('tagDelete', { repoRoot, name: tag, remoteToo: true }, 'tagDelete') },
          t('action.delete'))
      }, [repoRoot, runGitOp, openConfirm, t])
      const doTagPush = useCallback(() => {
        setBusy('tagPush')
        setBar(null)
        call(GIT_PREFIX, 'tagRemoteState', { repoRoot }).then((data) => {
          setBusy(null)
          const remotes = data !== null && data !== undefined && Array.isArray(data.remotes) ? data.remotes : []
          if (remotes.length === 0) {
            setBar({ kind: 'error', message: t('tag.noRemote') })
            return
          }
          const remote = remotes[0]
          const localTags = Array.isArray(data.localTags) ? data.localTags : []
          const published = data.published !== null && data.published !== undefined && Array.isArray(data.published[remote])
            ? data.published[remote]
            : []
          const pending = localTags.filter((tag) => published.indexOf(tag) < 0)
          if (pending.length === 0) {
            setBar({ kind: 'info', message: t('tag.allPushed') })
            return
          }
          openMenu(t('tag.pushTitle'), t('tag.pushBody').replace('{remote}', remote), pending.map((tag) => menuItem(
            tag,
            () => { void runGitOp('tagPush', { repoRoot, name: tag, remote }, 'tagPush') },
          )))
        }).catch((error) => {
          setBusy(null)
          setBar({ kind: 'error', message: error !== null && error !== undefined && typeof error.message === 'string' ? error.message : t('error.unknown') })
        })
      }, [repoRoot, call, openMenu, runGitOp, t])
      /* ---------- stash ---------- */

      const doStashPush = useCallback(() => {
        openPrompt(t('stash.pushTitle'), t('stash.pushBody'), t('stash.messageLabel'), '', t('stash.messagePlaceholder'), (value) => {
          const payload = { repoRoot }
          const message = value.trim()
          if (message !== '') payload.message = message
          /* Include untracked by default: a stash that silently leaves new files
             behind is the classic "I stashed but my tree is still dirty" surprise. */
          payload.includeUntracked = true
          void runGitOp('stashPush', payload, 'stashPush').then(() => {
            stashLoadedRef.current = false
            if (treeMode === 'stash') void loadStash()
          })
        })
      }, [openPrompt, runGitOp, repoRoot, treeMode, loadStash, t])

      /* ---------- repo ---------- */

      /**
       * Switch the browsed root.
       *
       * The page is scoped by a workspace root, and the chip at the top is the
       * only place that names it — when it did nothing, the page was stuck on
       * whatever root was stored the first time. `roots` reports the recent roots
       * and the drives, which is exactly the picker a person expects when they
       * click the folder name.
       */
      const changeRoot = useCallback((next) => {
        const value = typeof next === 'string' ? next.trim() : ''
        if (value === '') return
        /* 记进「最近打开」：宿主的 recent 只回当前这一个，切过的目录全丢了，
           用户每次都得重新找——记忆这件事本来就该由我们这边负责。 */
        rememberRoot(value)
        /* Drop the resolved repo: it belongs to the OLD root and would be used to
           map paths in the new one. It is re-resolved from the next snapshot. */
        setRepoRoot('')
        setWorkspaceRoot(value)
        setDirs({})
        setSelectedRel(null)
        setCommitFile(null)
        setSelectedCommit(null)
        /* Everything belonging to the OLD repository has to go, not just the tree. The
           panels were behind "already loaded" flags, so switching repos kept showing the
           previous repository's commits, branches and stashes until a manual refresh
           cleared them. Reset the flags AND the data; each panel then reloads against
           the new root on its next visit. */
        historyLoadedRef.current = false
        branchesLoadedRef.current = false
        stashLoadedRef.current = false
        setHistoryLimit(80)
        setHistoryHasMore(false)
        setHistoryState((previous) => Object.assign({}, previous, { status: 'idle', commits: [], error: null }))
        setBranchState((previous) => Object.assign({}, previous, { status: 'idle', branches: [], error: null }))
        setStashState((previous) => Object.assign({}, previous, { status: 'idle', stash: [], error: null }))
        setFileHistory((previous) => Object.assign({}, previous, { status: 'idle', commits: [], error: null }))
        setBlameState((previous) => Object.assign({}, previous, { status: 'idle', lines: [], error: null }))
      }, [])

      changeRootRef.current = changeRoot

      const doInit = useCallback(() => {
        if (workspaceRoot === '') return
        openConfirm(t('repo.initTitle'), t('repo.initBody'), () => {
          void runGitOp('init', { cwd: workspaceRoot }, 'init')
        }, t('action.init'))
      }, [openConfirm, runGitOp, workspaceRoot, t])

      /* ---------- history extras ---------- */

      const doFileHistory = useCallback((rel) => {
        const path = toRepoPath(rel, repoRootRel)
        if (path === null || path === '') return
        setFileHistory({ status: 'loading', rel, commits: [], error: null })
        call(GIT_PREFIX, 'fileHistory', { repoRoot, path, limit: 60 }).then((data) => {
          setFileHistory({
            status: 'ready',
            rel,
            commits: data !== null && data !== undefined && Array.isArray(data.commits) ? data.commits : [],
            error: null,
          })
        }).catch((error) => {
          setFileHistory({
            status: 'error',
            rel,
            commits: [],
            error: error !== null && error !== undefined && typeof error.message === 'string' ? error.message : t('error.unknown'),
          })
        })
      }, [call, repoRoot, repoRootRel, t])

      const doBlame = useCallback((rel) => {
        const path = toRepoPath(rel, repoRootRel)
        if (path === null || path === '') return
        setBlameState({ status: 'loading', rel, lines: [], error: null })
        call(GIT_PREFIX, 'blame', { repoRoot, path }).then((data) => {
          setBlameState({
            status: 'ready',
            rel,
            lines: data !== null && data !== undefined && Array.isArray(data.lines) ? data.lines : [],
            error: null,
          })
        }).catch((error) => {
          setBlameState({
            status: 'error',
            rel,
            lines: [],
            error: error !== null && error !== undefined && typeof error.message === 'string' ? error.message : t('error.unknown'),
          })
        })
      }, [call, repoRoot, repoRootRel, t])

      /**
       * File operations, through the FILES host.
       *
       * All paths are workspace-relative here and converted in one place, because
       * the two hosts disagree about what a path is relative to (this file's
       * most-repeated trap).
       */
      const runFileOp = useCallback(async (method, payload, label) => {
        setBusyAction(label)
        setBar(null)
        try {
          await call(FILES_PREFIX, method, payload)
          void loadDir('', { force: true })
          for (const dirRel of Object.keys(dirs)) void loadDir(dirRel, { force: true })
          void loadSnapshot()
          return true
        } catch (error) {
          setBar({ kind: 'error', message: error !== null && error !== undefined ? error.message : t('error.unknown') })
          return false
        } finally {
          setBusyAction(null)
        }
      }, [call, loadDir, dirs, loadSnapshot, t])

      const fileOp = useCallback((kind) => {
        if (workspaceRoot === '') return
        /* New entries land in the directory of the current selection — that is
           where the user is looking. With nothing selected, the workspace root. */
        const baseDir = selectedRel === null ? '' : dirNameOf(selectedRel)
        if (kind === 'newFile') {
          openPrompt(t('file.newFileTitle'), baseDir === '' ? t('file.newAtRoot') : (t('file.newIn') + ' ' + baseDir),
            t('file.nameLabel'), '', t('file.namePlaceholder'), (value) => {
              const rel = normalizeRel(value)
              if (rel === '') return
              const full = joinRel(baseDir, rel)
              void runFileOp('write', { root: browseRoot, rel: full, content: '' }, 'write').then((ok) => {
                if (ok === true) { setSelectedRel(full); setActiveTab('source') }
              })
            })
          return
        }
        if (kind === 'mkdir') {
          openPrompt(t('file.newFolderTitle'), baseDir === '' ? t('file.newAtRoot') : (t('file.newIn') + ' ' + baseDir),
            t('file.nameLabel'), '', t('file.namePlaceholder'), (value) => {
              const rel = normalizeRel(value)
              if (rel === '') return
              void runFileOp('mkdir', { root: browseRoot, rel: joinRel(baseDir, rel) }, 'mkdir')
            })
          return
        }
        if (selectedRel === null) return
        if (kind === 'rename') {
          openPrompt(t('file.renameTitle'), selectedRel, t('file.nameLabel'), baseNameOf(selectedRel), '', (value) => {
            const name = normalizeRel(value)
            if (name === '') return
            const to = joinRel(dirNameOf(selectedRel), name)
            if (to === selectedRel) return
            void runFileOp('rename', { root: browseRoot, from: selectedRel, to }, 'rename').then((ok) => {
              if (ok === true) setSelectedRel(to)
            })
          })
          return
        }
        if (kind === 'delete') {
          openConfirm(t('file.deleteTitle'), selectedRel, () => {
            void runFileOp('delete', { root: browseRoot, rel: selectedRel }, 'delete').then((ok) => {
              if (ok === true) setSelectedRel(null)
            })
          }, t('action.delete'))
        }
      }, [browseRoot, selectedRel, openPrompt, openConfirm, runFileOp, t])

      /**
       * Load the per-file views on demand.
       *
       * These effects sit AFTER `doFileHistory` / `doBlame` on purpose: a
       * dependency array is evaluated during render, so referencing a `const`
       * declared further down throws "Cannot access before initialization" on the
       * very first render — which is exactly what it did.
       *
       * `git log -- <path>` and `git blame` each walk the file's whole history, so
       * they run when the tab is opened, not when the file is selected.
       */
      useEffect(() => {
        if (activeTab !== 'history' || selectedRel === null) return
        if (fileHistory.rel === selectedRel && fileHistory.status !== 'idle') return
        doFileHistory(selectedRel)
      }, [activeTab, selectedRel, fileHistory.rel, fileHistory.status, doFileHistory])

      useEffect(() => {
        if (activeTab !== 'blame' || selectedRel === null) return
        if (blameState.rel === selectedRel && blameState.status !== 'idle') return
        doBlame(selectedRel)
      }, [activeTab, selectedRel, blameState.rel, blameState.status, doBlame])

      /**
       * Stage / unstage / discard a single hunk.
       *
       * `ref.path` is already repository-relative — the diff pane works in repo
       * coordinates because that is what the git host speaks. Converting it again
       * here is the mistake that would silently target the wrong file.
       */
      const doHunkAction = useCallback((ref) => {
        if (ref === null || ref === undefined) return
        const { path: repoPath, hunkIndex, action } = ref
        if (typeof repoPath !== 'string' || repoPath === '') return
        if (action !== 'stageHunk' && action !== 'unstageHunk' && action !== 'discardHunk') return
        const index = Number.isFinite(hunkIndex) ? Math.max(0, hunkIndex) : 0
        void runGitOp(action, { repoRoot, path: repoPath, hunkIndex: index }, action).then(() => {
          /* Same file, DIFFERENT content. Without this the pane keeps the old patch:
             showDiff treats an unchanged (path, base, rev) as 'nothing to do', so the
             diff stayed stale until the reader re-selected the file. */
          setReloadTick((value) => value + 1)
        })
      }, [runGitOp, repoRoot])

      /* The pane holds this callback for its whole life, so it goes through a ref:
         a changing closure would be indistinguishable from a new mount. */
      hunkActionRef.current = doHunkAction

      /**
       * 把一个文件引用写进对话输入框。
       *
       * 不复制路径、也不新开窗口：DSH 自己的引用面板认 `@相对路径`，写进去之后
       * agent 按需读取/修改，用户还能继续补话。这是社区插件（better-sidebar /
       * workspace-explorer）用的同一条路——它们也是「把 @文件 插进输入框」。
       */
      const addToChat = useCallback((rel) => {
        const path = typeof rel === 'string' ? rel.trim() : ''
        if (path === '') return
        /* 服务可能挂在插件根 ctx 上，也可能要先 inject 才拿得到会话作用域的那一个，
           所以两条路都试：先用 apply 里注入好的引用，其次现场 ctx.get。 */
        const conversation = (chatRef !== null && chatRef !== undefined ? chatRef.current : null)
          || (ctx !== null && ctx !== undefined && typeof ctx.get === 'function' ? ctx.get('conversation') : null)
        const input = conversation !== null && conversation !== undefined ? conversation.input : null
        const hasService = input !== null && input !== undefined && typeof input.requestDraftInitialization === 'function'
        if (hasService === true) {
          try {
            /* append：输入框里已经有字时接在后面，而不是把用户写了一半的话冲掉。 */
            input.requestDraftInitialization({ prompt: '@' + path + ' ', whenDraftExists: 'append' })
            return
          } catch (error) { void error }
        }
        /* 服务拿不到时退回 DOM：找到对话输入框，把 @路径 插进去。
           这比弹一句「没有可写入的输入框」有用——用户要的是把文件带进对话。 */
        if (insertIntoComposer('@' + path + ' ') === true) return
        setBar({ kind: 'error', message: t('chat.unavailable') })
      }, [ctx, t, chatRef])
      const stageRow = useCallback((row) => {
        if (row === null || row === undefined) return
        const path = toRepoPath(row.rel, repoRootRel)
        if (path === null || path === '') return
        const staged = row.change !== null && row.change !== undefined && row.change.staged === true
        void runWrite(staged ? 'unstage' : 'stage', { repoRoot, paths: [path] }, staged ? 'unstage' : 'stage')
      }, [repoRoot, repoRootRel, runWrite])

      /**
       * Discard is the one action that can destroy work, and it has a trap the
       * commit path does not: if the file is open in the editor with UNSAVED
       * edits, discarding the disk change leaves the buffer intact — and the
       * next save writes the "discarded" content back. Ask first, and reload the
       * buffer afterwards so the editor shows what is actually on disk.
       */
      /**
       * Discard — or, for an untracked file, DELETE it.
       *
       * The host's `discard` already handles untracked paths (it unlinks them, with
       * guards against directories and nested repositories); the page simply never
       * offered the button, so "I added a new file by mistake" had no way out.
       *
       * Two different confirmations, because they are two different risks:
       *  - a tracked change can be re-applied from git; the only trap is an unsaved
       *    editor buffer that would write the discarded content back on the next save
       *  - an untracked file exists ONLY on disk: deleting it is final
       */
      const requestDiscard = useCallback((row) => {
        if (row === null || row === undefined) return
        const path = toRepoPath(row.rel, repoRootRel)
        if (path === null || path === '') return
        const untracked = row.change !== null && row.change !== undefined && row.change.untracked === true
        const run = () => { void runWrite('discard', { repoRoot, paths: [path] }, 'discard') }

        if (hasDirty(row.rel) === true) {
          setDialog({
            kind: 'confirm',
            rel: row.rel,
            title: t('conflict.dirtyTitle'),
            body: t('conflict.dirtyBody'),
            confirmLabel: t('action.discard'),
            onConfirm: () => { setDialog(null); run() },
          })
          return
        }
        if (untracked === true) {
          openConfirm(t('conflict.deleteUntrackedTitle'), row.rel + t('conflict.deleteUntrackedBody'), run, t('action.delete'))
          return
        }
        run()
      }, [repoRoot, repoRootRel, runWrite, hasDirty, openConfirm, t])

      /**
       * Bulk action for ONE change group.
       *
       * Group-level rather than only whole-tree: "stage everything I just edited" and
       * "drop the build output I did not mean to add" are different intentions, and the
       * groups already separate them. Staging is reversible; discarding is not, and for
       * the untracked group it DELETES files git has no copy of — that one always asks
       * first, and says how many files it is about to remove.
       */
      const bulkGroup = useCallback((group, kind) => {
        if (group === null || group === undefined) return
        const paths = []
        for (const entry of group.rows) {
          const change = entry.change
          if (kind === 'stage' && change !== null && change !== undefined && change.staged === true) continue
          if (kind === 'unstage' && (change === null || change === undefined || change.staged !== true)) continue
          const path = toRepoPath(entry.rel, repoRootRel)
          if (path !== null && path !== '') paths.push(path)
        }
        if (paths.length === 0) return
        if (kind === 'stage') { void runWrite('stage', { repoRoot, paths }, 'stage'); return }
        if (kind === 'unstage') { void runWrite('unstage', { repoRoot, paths }, 'unstage'); return }
        const untracked = group.key === 'untracked'
        openConfirm(
          untracked ? t('conflict.deleteManyTitle') : t('conflict.discardManyTitle'),
          (untracked ? t('conflict.deleteManyBody') : t('conflict.discardManyBody')).replace('{n}', String(paths.length)),
          () => { void runWrite('discard', { repoRoot, paths }, 'discard') },
          untracked ? t('action.delete') : t('action.discard'))
      }, [repoRoot, repoRootRel, runWrite, openConfirm, t])

      /**
       * Check out a branch.
       *
       * `options.create` turns a REMOTE branch into a local one (`git checkout -b X`
       * `origin/X`). Checking a remote name out directly lands on a detached HEAD,
       * which is never what a click should silently do.
       */
      const checkoutBranch = useCallback((name, options) => {
        if (typeof name !== "string" || name.trim() === "") return
        const opts = options === undefined || options === null ? {} : options
        const payload = { repoRoot, name: name.trim() }
        if (opts.create === true) payload.create = true
        if (typeof opts.startPoint === "string" && opts.startPoint !== "") payload.startPoint = opts.startPoint
        /* A checkout can fail on a dirty tree, and it changes what every other
           panel is showing — same write path as commit. */
        void runWrite("checkout", payload, "checkout").then(() => {
          branchesLoadedRef.current = false
          historyLoadedRef.current = false
          void loadBranches()
          void loadHistory()
        })
      }, [repoRoot, runWrite, loadBranches, loadHistory])

      /**
       * Stash actions take an INDEX, not a ref.
       *
       * The host's `stashApply` / `stashPop` / `stashDrop` all read
       * `payload.index` and default it to 0 — so passing `ref: 'stash@{2}'` would
       * silently act on stash@{0} instead. That is a data-loss bug, not a cosmetic
       * one, so the index is parsed from the ref the list shows.
       */
      const stashAction = useCallback((method, item) => {
        const ref = item !== null && item !== undefined && typeof item.ref === 'string' ? item.ref : ''
        const match = /\{(\d+)\}/.exec(ref)
        if (match === null) {
          setBar({ kind: 'error', message: t('error.unknown') + ': ' + ref })
          return
        }
        const index = Number(match[1])
        void runGitOp(method, { repoRoot, index }, method).then(() => {
          stashLoadedRef.current = false
          if (treeMode === 'stash') void loadStash()
        })
      }, [runGitOp, repoRoot, treeMode, loadStash, t])

      const doCommit = useCallback(() => {
        const message = commitMessage.trim()
        if (message === '') return
        void runWrite('commit', { repoRoot, message, amend }, 'commit').then(() => {
          setCommitMessage('')
          setAmend(false)
        })
      }, [commitMessage, amend, repoRoot, runWrite])

      /* ============================== keyboard ============================== */

      useEffect(() => {
        const onKey = (event) => {
          /* Ctrl+Enter commits. Checked before anything else so a focused
             textarea cannot swallow it — but only while this page is the one in
             front, which the dialog check keeps honest. */
          if (event.key === 'Enter' && (event.ctrlKey === true || event.metaKey === true)) {
            const insideThisPage = rootRef.current !== null && rootRef.current !== undefined
              && event.target !== null && event.target !== undefined
              && typeof rootRef.current.contains === 'function' && rootRef.current.contains(event.target)
            if (insideThisPage) {
              event.preventDefault()
              doCommit()
              return
            }
          }
          if (event.key === 'Escape') {
            if (dialog !== null) {
              /* Capture-free Esc: the dialog owns it, nothing else reacts. */
              event.preventDefault()
              setDialog(null)
              return
            }
            if (compact && activeTab !== null && selectedRel !== null) {
              setSelectedRel(null)
            }
          }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [dialog, compact, activeTab, selectedRel, doCommit])

      /* ============================== tree resize ============================== */

      const resizeRef = useRef(null)
      /* Drives the window-wide col-resize cursor + no-selection rule. */
      const [resizing, setResizing] = useState(false)
      const onGripDown = useCallback((event) => {
        event.preventDefault()
        event.stopPropagation()
        const startX = event.clientX
        const startW = treeWidth
        resizeRef.current = { startX, startW }
        setResizing(true)
        const onMove = (moveEvent) => {
          const drag = resizeRef.current
          if (drag === null) return
          const next = Math.max(TREE_MIN_W, Math.min(TREE_MAX_W, drag.startW + (moveEvent.clientX - drag.startX)))
          setTreeWidth(Math.round(next))
        }
        const onUp = () => {
          resizeRef.current = null
          setResizing(false)
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
      }, [treeWidth])

      /* ============================== render: tree rows ============================== */

      /* Virtualised: the DOM never holds more than the visible window plus a
         small overscan. Without this, one expanded monorepo directory can put
         thousands of rows in the layout tree and the pane stops responding. */
      const [scrollTop, setScrollTop] = useState(0)
      const [viewportH, setViewportH] = useState(320)
      const treeScrollRef = useRef(null)

      const onTreeScroll = useCallback((event) => {
        const node = event.currentTarget
        setScrollTop(node.scrollTop)
        setViewportH((previous) => (previous === node.clientHeight ? previous : node.clientHeight))
      }, [])

      useEffect(() => {
        const node = treeScrollRef.current
        if (node === null || node === undefined) return
        setViewportH((previous) => (previous === node.clientHeight ? previous : node.clientHeight))
      })

      const visibleRows = useMemo(() => {
        const start = Math.max(0, Math.floor(scrollTop / TREE_ROW_HEIGHT) - TREE_OVERSCAN)
        const count = Math.ceil(viewportH / TREE_ROW_HEIGHT) + TREE_OVERSCAN * 2
        return rows.slice(start, start + Math.max(count, 1)).map((row, index) => ({ row, offset: (start + index) * TREE_ROW_HEIGHT }))
      }, [rows, scrollTop, viewportH])

      const renderRow = (row, offset) => {
        /**
         * EVERY row is absolutely positioned at `offset`.
         *
         * The status and truncated rows used to lay themselves out in NORMAL FLOW
         * (they were missing `position:absolute; top:offset`), while real rows were
         * absolute. The result was two independent layouts in one container: the
         * flow rows stacked from the top and the absolute rows sat at their offsets,
         * so every expanded directory printed "正在加载…" ON TOP of itself.
         * One row model, one positioning rule.
         */
        const padding = 6 + row.depth * 12
        const box = { paddingLeft: padding + 'px', position: 'absolute', top: offset + 'px', left: 0, right: 0, height: TREE_ROW_HEIGHT + 'px' }
        if (row.kind === 'status') {
          return E('div', {
            key: row.key,
            className: 'scw-treeState is-in-tree' + (row.status === 'error' ? ' is-error' : ''),
            style: Object.assign({}, box, { display: 'flex', alignItems: 'center' }),
          }, row.status === 'error' ? (row.message === undefined || row.message === '' ? t('state.failed') : row.message) : t('state.loading'))
        }
        if (row.kind === 'truncated') {
          return E('div', {
            key: row.key,
            className: 'scw-treeState is-in-tree',
            style: Object.assign({}, box, { display: 'flex', alignItems: 'center' }),
          }, t('state.truncated'))
        }
        const isActive = row.rel === selectedRel
        return E('div', {
          key: row.key,
          className: 'scw-row' + (row.dir ? ' is-dir' : '') + (isActive ? ' is-active' : ''),
          role: 'button',
          tabIndex: 0,
          title: row.rel,
          style: box,
          onClick: () => {
            selectRel(row.rel)
            if (row.dir) toggleDir(row.rel)
            else setActiveTab('source')
          },
          onKeyDown: (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            selectRel(row.rel)
            if (row.dir) toggleDir(row.rel)
            else setActiveTab('source')
          },
        },
        E('span', { className: 'scw-rowChevron' }, row.dir ? E(Icon, { name: row.expanded ? 'chevronDown' : 'chevronRight', size: 11 }) : null),
        E(Icon, { name: row.dir ? 'folder' : 'file', size: 13, className: 'scw-rowIcon' }),
        E('span', { className: 'scw-rowName' + (row.dir ? ' is-dir' : '') }, row.name),
        row.dir === true
          ? (row.hasDirtyChild === true ? E('span', { className: 'scw-dirDot', 'aria-hidden': 'true' }) : null)
          : (row.letter !== '' ? E('span', { className: 'scw-letter ' + row.colorClass }, row.letter) : null),
        row.dir === false && row.change !== null && row.change !== undefined && (row.added > 0 || row.deleted > 0)
          ? E('span', { className: 'scw-stat' },
            row.added > 0 ? E('span', { className: 'scw-statAdd' }, '+' + row.added) : null,
            row.deleted > 0 ? E('span', { className: 'scw-statDel' }, '−' + row.deleted) : null)
          : null,
        /* 文件行上的「加入对话」按钮。放在这里而不是只放在 changeActions 里：
           那个函数只对「有变更的文件」渲染，而文件模式下大多数行没有 change，
           于是按钮在最常用的地方反而看不见。 */
        /* 目录也支持：引用一个目录让 agent 自己去翻，比逐个文件点更快。
           目录引用带尾斜杠，DSH 的引用面板据此走文件夹那条分支。 */
        E('span', { className: 'scw-rowActions' },
          E('button', {
            type: 'button',
            className: 'scw-rowBtn',
            title: t('action.addToChat') + ' — ' + row.rel,
            onClick: (event) => {
              event.stopPropagation()
              addToChat(row.dir === true ? row.rel + '/' : row.rel)
            },
          }, '@')),
        row.dir === false && row.change !== null && row.change !== undefined
          ? E('span', { className: 'scw-rowActions' },
            E('button', {
              type: 'button',
              className: 'scw-rowBtn',
              title: (row.change.staged === true ? t('action.unstage') : t('action.stage')) + ' — ' + row.rel,
              onClick: (event) => { event.stopPropagation(); stageRow(row) },
            }, row.change.staged === true ? t('action.unstage') : t('action.stage')),
            row.change.staged !== true
              ? E('button', {
                type: 'button',
                className: 'scw-rowBtn is-danger',
                title: t('action.discard') + ' — ' + row.rel,
                onClick: (event) => { event.stopPropagation(); requestDiscard(row) },
              }, t('action.discard'))
              : null)
          : null)
      }

      /* ============================== render: chrome ============================== */

      const treeStyle = compact
        ? undefined
        : { width: treeWidth + 'px', minWidth: TREE_MIN_W + 'px', maxWidth: TREE_MAX_W + 'px' }

      const repoLabel = useMemo(() => {
        if (repoRoot === '') return workspaceRoot === '' ? '' : baseNameOf(workspaceRoot)
        return baseNameOf(repoRoot)
      }, [repoRoot, workspaceRoot])

      const branchLabel = snapshot !== null && snapshot !== undefined && typeof snapshot.branch === 'string' ? snapshot.branch : ''
      const ahead = snapshot !== null && snapshot !== undefined && Number.isFinite(snapshot.ahead) ? snapshot.ahead : 0
      const behind = snapshot !== null && snapshot !== undefined && Number.isFinite(snapshot.behind) ? snapshot.behind : 0

      const header = E('div', { className: 'scw-head' },
        E('button', {
          type: 'button',
          className: 'scw-repoChip',
          title: t('root.title') + ' — ' + (repoRoot === '' ? workspaceRoot : repoRoot),
          /* 合并成一个入口：对话框里既有「最近打开」，也能浏览其它目录。 */
  onClick: () => openBrowse(),
        },
        E(Icon, { name: 'folder', size: 13 }),
        E('span', { className: 'scw-repoName' }, repoLabel === '' ? t('empty.noRoot') : repoLabel),
        E(Icon, { name: 'chevronDown', size: 10 })),
        branchLabel === '' ? null : E('span', { className: 'scw-branch' }, branchLabel),
        E('span', { className: 'scw-spacer' }),
        /* Sync lives in the header because it acts on the repository, not on
           whatever the left pane happens to be showing. */
        snapshotError !== null && snapshotError !== undefined && snapshotError.code === 'not-a-repo'
          ? E('button', {
            type: 'button',
            className: 'scw-btn is-primary',
            disabled: busyAction !== null,
            title: t('repo.initTitle'),
            onClick: () => doInit(),
          }, t('action.init'))
          : null,
        snapshotError === null
          ? E(Fragment, null,
            E(IconButton, { name: 'download', label: t('op.fetch'), onClick: doFetch, disabled: busyAction !== null || snapshotLoading }),
            E(IconButton, { name: 'arrowDown', label: t('op.pull') + (behind > 0 ? ' · ' + behind + ' ' + t('head.behindHint') : ''), badge: behind, badgeKind: 'behind', onClick: doPull, disabled: busyAction !== null || snapshotLoading }),
            E(IconButton, { name: 'arrowUp', label: t('op.push') + (ahead > 0 ? ' · ' + ahead + ' ' + t('head.aheadHint') : ''), badge: ahead, badgeKind: 'ahead', onClick: doPush, disabled: busyAction !== null || snapshotLoading }))
          : null,
        E(IconButton, { name: 'refresh', label: t('head.refresh'), onClick: refresh, disabled: snapshotLoading }))

      const treePane = (() => {
        /* The search row is ABOVE the tree, inside the same pane, because the
           results REPLACE the tree rather than appearing beside it: "find a file"
           and "browse to a file" are the same job, and two scrolling lists in a
           280px column is the second-copy-of-the-list problem this page exists to
           avoid. */
        const searchRow = E('div', { className: 'scw-search' },
          E('span', { className: 'scw-searchIcon' }, E(Icon, { name: 'search', size: 12 })),
          E('input', {
            className: 'scw-searchInput',
            type: 'text',
            value: searchQuery,
            placeholder: searchMode === 'name' ? t('search.placeholderName') : t('search.placeholderContent'),
            'aria-label': t('search.placeholderName'),
            onChange: (event) => setSearchQuery(event.target.value),
            onKeyDown: (event) => {
              if (event.key !== 'Escape') return
              /* Esc clears BEFORE anything else reacts: this is the innermost
                 scope in the page, so it gets the key first. */
              event.stopPropagation()
              if (searchQuery !== '') { event.preventDefault(); setSearchQuery('') }
            },
          }),
          searchQuery === '' ? null : E('button', {
            type: 'button',
            className: 'scw-searchClear',
            title: t('search.clear'),
            'aria-label': t('search.clear'),
            onClick: () => setSearchQuery(''),
          }, E(Icon, { name: 'close', size: 10 })),
          E('div', { className: 'scw-searchModes', role: 'tablist' },
            ['name', 'content'].map((mode) => E('button', {
              key: mode,
              type: 'button',
              role: 'tab',
              'aria-selected': searchMode === mode,
              className: 'scw-searchMode' + (searchMode === mode ? ' is-active' : ''),
              title: mode === 'name' ? t('search.modeNameTitle') : t('search.modeContentTitle'),
              onClick: () => setSearchMode(mode),
            }, mode === 'name' ? t('search.modeName') : t('search.modeContent'))),
        /* VSCode 的三个开关。名字模式是模糊匹配，这三个对它没有意义，所以只在内容模式出现。 */
        searchMode !== 'content' ? null : E('span', { className: 'scw-searchOpts' },
          E('button', {
            type: 'button',
            className: 'scw-searchOpt' + (searchCase === true ? ' is-on' : ''),
            title: t('search.caseSensitive'),
            'aria-pressed': searchCase === true,
            onClick: () => setSearchCase((v) => v !== true),
          }, 'Aa'),
          E('button', {
            type: 'button',
            className: 'scw-searchOpt' + (searchWord === true ? ' is-on' : ''),
            title: t('search.wholeWord'),
            'aria-pressed': searchWord === true,
            onClick: () => setSearchWord((v) => v !== true),
          }, 'ab'),
          E('button', {
            type: 'button',
            className: 'scw-searchOpt' + (searchRegex === true ? ' is-on' : ''),
            title: t('search.regex'),
            'aria-pressed': searchRegex === true,
            onClick: () => setSearchRegex((v) => v !== true),
          }, '.*'))))

        /* ---- mode strip: five things, one column ---- */
        const changeTotal = statusIndex.size
        const modeStrip = E('div', { className: 'scw-modes', role: 'tablist', 'aria-label': t('page.title') },
          [
        ['changes', t('mode.changes'), changeTotal, 'changes'],
        ['files', t('mode.files'), 0, 'folder'],
        ['history', t('mode.history'), 0, 'history'],
        ['branches', t('mode.branches'), 0, 'branch'],
        ['stash', t('mode.stash'), 0, 'stash'],
      ].map(([key, label, count, icon]) => E('button', {
            type: 'button',
            role: 'tab',
            'aria-selected': treeMode === key,
            className: 'scw-mode' + (treeMode === key ? ' is-active' : ''),
            title: count > 0 ? label + ' · ' + count + ' ' + t('mode.countHint') : label,
            onClick: () => setTreeMode(key),
          }, E(Icon, { name: icon, size: 12 }), E('span', { className: 'scw-modeLabel' }, label), count > 0 ? E('span', { className: 'scw-modeCount' }, '(' + count + ')') : null)))

        /**
         * One toolbar per mode, because the actions belong to what you are
         * looking at. A single global toolbar that changes meaning by mode is how
         * a user clicks "delete" thinking it means "delete the branch I selected"
         * while a file is selected.
         */
        const busy = busyAction !== null
        /**
         * One primary action plus a `⋯` menu per mode.
         *
         * The first version put every action on the row as a text button — up to
         * five of them in a 280px column, which reads as a wall of words and
         * makes the tree the third thing you look at instead of the first. The
         * column exists to show files; actions are secondary, so: at most one
         * visible action, everything else one click away with a label that
         * explains what it does.
         */
        const toolbarIcon = (name, label, onClick, options) => {
          const opts = options === undefined ? {} : options
          return E('button', {
            type: 'button',
            className: 'scw-toolIcon' + (opts.danger === true ? ' is-danger' : '') + (opts.primary === true ? ' is-primary' : ''),
            title: label,
            'aria-label': label,
            disabled: opts.disabled === true || busy,
            onClick,
          }, E(Icon, { name, size: 13 }))
        }

        const item = (label, onSelect, options) => {
          const opts = options === undefined ? {} : options
          return { label, danger: opts.danger === true, disabled: opts.disabled === true, onSelect }
        }

        const modeToolbar = (() => {
          if (treeMode === 'changes') {
            const groups = buildChangeGroups(statusIndex)
            const unstagedCount = groups[2].rows.length + groups[3].rows.length
            const hasChanges = changeTotal > 0
            return E('div', { className: 'scw-toolbar' },
              /* Stage-all lives on the group header, next to the discard that pairs with it.
           A second one here duplicated the same action an inch away. */
              toolbarIcon('more', t('head.more'), () => openMenu(t('mode.changes'), '', [
                menuItem(t('stash.pushTitle'), () => doStashPush(), { disabled: hasChanges === false }),
                menuItem(t('head.refresh'), () => refresh()),
              ])))
          }
          if (treeMode === 'files') {
            return E('div', { className: 'scw-toolbar' },
              toolbarIcon('plus', t('action.new'), () => openMenu(t('action.new'), '', [
                menuItem(t('file.newFile'), () => { void fileOp('newFile') }),
                menuItem(t('file.newFolderTitle'), () => { void fileOp('mkdir') }),
              ]), { primary: true }),
              toolbarIcon('edit', t('file.rename'), () => { void fileOp('rename') }, { disabled: selectedRel === null || selectedIsDir === true }),
              toolbarIcon('trash', t('file.delete'), () => { void fileOp('delete') }, { danger: true, disabled: selectedRel === null }),
              toolbarIcon('filter', t('head.onlyChanges'), () => setOnlyChanges((value) => !value), { primary: onlyChanges }))
          }
          if (treeMode === 'history') {
            return E('div', { className: 'scw-toolbar' },
              toolbarIcon('refresh', t('head.refresh'), () => { historyLoadedRef.current = false; void loadHistory() }),
              toolbarIcon('more', t('head.more'), () => openMenu(t('mode.history'), '', [
                menuItem(t('action.tagCreate'), () => doTagCreate(selectedCommit === null ? undefined : selectedCommit)),
                /* Tags could be created but never published; that left one terminal
                   step in every release. */
                menuItem(t('action.tagPush'), () => doTagPush()),
              ])))
          }
          if (treeMode === 'branches') {
            return E('div', { className: 'scw-toolbar' },
              toolbarIcon('plus', t('action.branchCreate'), () => doBranchCreate(), { primary: true }),
              toolbarIcon('refresh', t('head.refresh'), () => { branchesLoadedRef.current = false; void loadBranches() }))
          }
          return E('div', { className: 'scw-toolbar' },
            toolbarIcon('plus', t('stash.pushTitle'), () => doStashPush(), { primary: true, disabled: changeTotal === 0 }),
            toolbarIcon('refresh', t('head.refresh'), () => { stashLoadedRef.current = false; void loadStash() }))
        })()

        /**
         * In-progress operation banner.
         *
         * A conflict is not a notification — it is a state the repository is
         * STUCK in, and every other action will fail until it is resolved or
         * aborted. So it is a banner with the two exits, not a toast.
         */
        const conflictBanner = snapshot !== null && snapshot !== undefined
          && typeof snapshot.operation === 'string' && snapshot.operation !== ''
          ? (() => {
            const groups = buildChangeGroups(statusIndex)
            const conflictedCount = groups[0].rows.length
            const label = snapshot.operation === 'rebase' ? t('op.inRebase')
              : snapshot.operation === 'merge' ? t('op.inMerge')
                : snapshot.operation === 'cherry-pick' ? t('op.inCherryPick')
                  : snapshot.operation === 'revert' ? t('op.inRevert') : snapshot.operation
            return E('div', { className: 'scw-conflictBar', role: 'status' },
              E(Icon, { name: 'warning', size: 12 }),
              E('span', { className: 'scw-conflictText' },
                label,
                conflictedCount > 0 ? ' · ' + conflictedCount + ' ' + t('group.conflicted') : ''),
              E('span', { className: 'scw-spacer' }),
              E('button', { type: 'button', className: 'scw-toolBtn', disabled: busy, onClick: () => doConflictContinue() }, t('op.continue')),
              E('button', { type: 'button', className: 'scw-toolBtn is-danger', disabled: busy, onClick: () => doConflictAbort() }, t('op.abort')))
          })()
          : null

        const browsing = searchQuery.trim() === ''

        /**
         * Search results REPLACE the pane body — but NOT by taking a different
         * return branch.
         *
         * The old code returned a different child list while searching
         * (`[searchRow, results]` instead of `[banner, searchRow, modeStrip,
         * toolbar, body]`). React reconciles by index and type, so index 0 changed
         * from a banner (often null) to the search row: it unmounted everything from
         * there on, including the input. You could type ONE character — then the
         * input was destroyed and recreated, and the next keystroke went nowhere.
         * One stable tree, one body slot that swaps content.
         */
        const searchBody = E('div', { className: 'scw-tree scw-searchResults', role: 'list' },
          searchState.status === 'loading'
            ? E('div', { className: 'scw-treeState is-in-tree' }, t('state.loading'))
            : searchState.status === 'error'
              ? E('div', { className: 'scw-treeState is-in-tree is-error' }, searchState.error)
              : searchRows.length === 0
                ? E('div', { className: 'scw-treeState is-in-tree' }, t('search.noResults'))
                : searchRows)

        /* ---- 变更: grouped, because the groups mean different actions ---- */
        /**
         * The action buttons for one changed row.
         *
         * A CONFLICTED file gets the three resolutions instead of stage/discard:
         * staging a conflict marker is never what anyone wants, and choosing a
         * side is exactly what git offers for one.
         */
        const changeActions = (rel, change) => {
          const actions = []
          /* 每个文件都能「加入对话」：把 @路径 写进输入框最前面。
             DSH 的引用面板认得 @path，agent 会按需读它——和 better-sidebar 的
             「悬浮 @文件 一键引用进输入框」是同一个路子。 */
          actions.push(E('button', {
            key: 'addToChat',
            type: 'button',
            className: 'scw-rowBtn',
            title: t('action.addToChat') + ' — ' + rel,
            onClick: (event) => {
              event.stopPropagation()
              addToChat(rel)
            },
          }, '@'))
          if (change.conflicted === true) {
            const resolve = (side, label, hint) => E('button', {
              key: side,
              type: 'button',
              className: 'scw-rowBtn',
              disabled: busyAction !== null,
              title: hint,
              onClick: (event) => {
                event.stopPropagation()
                const p = toRepoPath(rel, repoRootRel)
                if (p !== null) doConflictResolve([p], side)
              },
            }, label)
            actions.push(resolve('ours', t('conflict.ours'), t('conflict.oursHint')))
            actions.push(resolve('theirs', t('conflict.theirs'), t('conflict.theirsHint')))
            actions.push(resolve('mark-resolved', t('conflict.mark'), t('conflict.markHint')))
            return E('span', { className: 'scw-rowActions' }, actions)
          }
          actions.push(E('button', {
            key: 'stage',
            type: 'button',
            className: 'scw-rowBtn',
            title: (change.staged === true ? t('action.unstage') : t('action.stage')) + ' — ' + rel,
            disabled: busyAction !== null,
            onClick: (event) => { event.stopPropagation(); stageRow({ rel, change }) },
          }, change.staged === true ? t('action.unstage') : t('action.stage')))
          /* Untracked files get this too, differently labelled: for them the action
             DELETES a file git has no copy of. Hiding the button left "I created this
             by mistake" with no way out — the host's discard already unlinks untracked
             paths, only the page refused to offer it. */
          const untracked = change.untracked === true
          actions.push(E('button', {
            key: 'discard',
            type: 'button',
            className: 'scw-rowBtn is-danger',
            title: (untracked ? t('action.delete') : t('action.discard')) + ' — ' + rel,
            disabled: busyAction !== null,
            onClick: (event) => { event.stopPropagation(); requestDiscard({ rel, change }) },
          }, untracked ? t('action.delete') : t('action.discard')))
          return E('span', { className: 'scw-rowActions' }, actions)
        }

        const changesPanel = (() => {
          if (changeTotal === 0) {
            return E('div', { className: 'scw-treeState' }, t('changes.clean'))
          }
          const groups = buildChangeGroups(statusIndex)
          const out = []
          for (const group of groups) {
            if (group.rows.length === 0) continue
            /* Bulk actions live on the group header: "stage everything I just edited"
               and "drop the build output I did not mean to add" are different
               intentions, and the groups already separate them. */
            const canStage = group.key === 'unstaged' || group.key === 'untracked'
            const canUnstage = group.key === 'staged'
            const canDiscard = group.key === 'unstaged' || group.key === 'untracked'
            out.push(E('div', { key: 'g:' + group.key, className: 'scw-group' },
              E('span', { className: 'scw-groupName' }, t('group.' + group.key)),
              E('span', { className: 'scw-groupCount' }, String(group.rows.length)),
              E('span', { className: 'scw-spacer' }),
              canStage
                ? E('button', {
                  type: 'button',
                  className: 'scw-bulkBtn',
                  disabled: busyAction !== null,
                  title: t('action.stageGroupTitle'),
                  onClick: () => bulkGroup(group, 'stage'),
                }, t('action.stageAll'))
                : null,
              canUnstage
                ? E('button', {
                  type: 'button',
                  className: 'scw-bulkBtn',
                  disabled: busyAction !== null,
                  title: t('action.unstageGroupTitle'),
                  onClick: () => bulkGroup(group, 'unstage'),
                }, t('action.unstageAll'))
                : null,
              canDiscard
                ? E('button', {
                  type: 'button',
                  className: 'scw-bulkBtn is-danger',
                  disabled: busyAction !== null,
                  title: group.key === 'untracked' ? t('action.deleteGroupTitle') : t('action.discardGroupTitle'),
                  onClick: () => bulkGroup(group, 'discard'),
                }, group.key === 'untracked' ? t('action.deleteAll') : t('action.discardAll'))
                : null))
            for (const { rel, change } of group.rows) {
              const letter = statusLetterOf(change)
              const isActive = rel === selectedRel
              out.push(E('div', {
                key: 'cr:' + rel,
                className: 'scw-row' + (isActive ? ' is-active' : ''),
                role: 'button',
                tabIndex: 0,
                title: rel,
                onClick: () => {
                  selectRel(rel)
                  setActiveTab(change !== null && change !== undefined && change.untracked !== true ? 'diff' : 'source')
                },
                onKeyDown: (event) => {
                  if (event.key !== 'Enter') return
                  event.preventDefault()
                  selectRel(rel)
                  setActiveTab(change !== null && change !== undefined && change.untracked !== true ? 'diff' : 'source')
                },
              },
              E('span', { className: 'scw-rowChevron' }),
              E(Icon, { name: 'file', size: 13, className: 'scw-rowIcon' }),
              E('span', { className: 'scw-rowName' }, baseNameOf(rel)),
                /* GitCraft's arrangement: the NAME stays intact and the directory
                   follows in a dimmer, shrinkable column. The name never gets squeezed —
                   that was the original complaint — but the location is still readable
                   at a glance instead of hiding in a tooltip. */
                E('span', { className: 'scw-rowDir is-after' }, dirNameOf(rel)),
              letter === '' ? null : E('span', { className: 'scw-letter ' + statusColorClass(letter) }, letter),
              changeActions(rel, change)))
            }
          }
          return E('div', { className: 'scw-tree scw-changeList' }, out)
        })()

        /* ---- 历史 ---- */
        const LANE_W = 12
        const GRAPH_ROW_H = 30
        const LANE_COLORS = ['#4d6bfe', '#4ec9a0', '#e0a458', '#c678dd', '#5aa9e6', '#e06c75']

        /**
         * One row of the graph: vertical connectors for lanes passing through, a node
         * dot for this commit, and a diagonal for each extra parent so a merge LOOKS
         * like a merge instead of a sudden extra vertical line.
         *
         * Per-row SVG rather than one big canvas: it scales with the lane count, stays
         * crisp, and gives every element a real DOM node the tests can measure.
         */
        const graphCell = (graphRow) => {
          const before = graphRow.before
          const after = graphRow.after
          const node = graphRow.node
          const lanes = Math.max(before.length, after.length, 1)
          const width = lanes * LANE_W
          const mid = GRAPH_ROW_H / 2
          const xOf = (lane) => lane * LANE_W + LANE_W / 2
          const parts = []
          for (let lane = 0; lane < before.length; lane += 1) {
            if (before[lane] === null || before[lane] === undefined) continue
            if (lane === node) continue
            parts.push(E('line', {
              key: 'v' + lane,
              x1: xOf(lane), y1: 0, x2: xOf(lane), y2: GRAPH_ROW_H,
              stroke: LANE_COLORS[lane % LANE_COLORS.length], strokeWidth: 1.5, strokeOpacity: 0.55,
            }))
          }
          if (before[node] !== null && before[node] !== undefined) {
            parts.push(E('line', {
              key: 'in',
              x1: xOf(node), y1: 0, x2: xOf(node), y2: mid,
              stroke: LANE_COLORS[node % LANE_COLORS.length], strokeWidth: 1.5,
            }))
          }
          if (after[node] !== null && after[node] !== undefined) {
            parts.push(E('line', {
              key: 'out',
              x1: xOf(node), y1: mid, x2: xOf(node), y2: GRAPH_ROW_H,
              stroke: LANE_COLORS[node % LANE_COLORS.length], strokeWidth: 1.5,
            }))
          }
          for (let lane = 0; lane < after.length; lane += 1) {
            if (after[lane] === null || after[lane] === undefined) continue
            if (lane === node) continue
            if (lane < before.length && before[lane] === after[lane]) continue
            parts.push(E('line', {
              key: 'd' + lane,
              x1: xOf(node), y1: mid, x2: xOf(lane), y2: GRAPH_ROW_H,
              stroke: LANE_COLORS[lane % LANE_COLORS.length], strokeWidth: 1.5, strokeOpacity: 0.7,
            }))
          }
          parts.push(E('circle', {
            key: 'n',
            cx: xOf(node), cy: mid, r: 3.4,
            fill: LANE_COLORS[node % LANE_COLORS.length],
            stroke: 'var(--dsw-alias-bg-base,#14161a)', strokeWidth: 1.5,
          }))
          return E('svg', {
            className: 'scw-graph',
            width, height: GRAPH_ROW_H, viewBox: '0 0 ' + width + ' ' + GRAPH_ROW_H,
            'aria-hidden': 'true',
          }, parts)
        }

        /* Branch and tag labels point AT a commit; showing them on the row answers
           "where am I" without switching to the 分支 tab. */
        const refChipsOf = (commit) => {
          const raw = commit.refs
          const list = Array.isArray(raw) ? raw : (typeof raw === 'string' && raw !== '' ? raw.split(', ') : [])
          return list
            .map((entry) => String(entry).trim())
            .filter((entry) => entry !== '' && entry !== 'HEAD')
            .slice(0, 3)
            .map((entry) => {
              const isTag = entry.startsWith('tag: ')
              const name = isTag ? entry.slice(5) : entry.replace(/^HEAD -> /, '')
              const isHead = entry.indexOf('HEAD') >= 0
              /* Three different things, three colours: a local branch (you can switch to
                 it), a remote branch (a mirror of the server) and a tag (a fixed label).
                 One grey for all three read as "the same kind of thing", which is the
                 confusion the 分支 tab was already fixed for. */
              const kind = isTag ? ' is-tag' : (isHead ? ' is-head' : (name.indexOf('/') > 0 ? ' is-remote' : ' is-local'))
              return E('span', {
                key: entry,
                className: 'scw-refChip' + kind,
                title: (isTag ? t('history.tagRef') + ' ' : '') + name,
              }, name)
            })
        }

        /* Lane allocation walks every commit and its parents, and it used to run INSIDE
           the render — so hovering a row, typing in the search box or scrolling the list
           recomputed the whole graph. Keyed on the commits array (which the host replaces
           only when the repository changes), this now runs once per fetch. */
        const historyGraph = useMemo(
          () => (historyState.commits.length === 0 ? [] : buildCommitGraph(historyState.commits)),
          [historyState.commits],
        )

        const historyPanel = historyState.status === 'loading' && historyState.commits.length === 0
          ? E('div', { className: 'scw-treeState' }, t('state.loading'))
          : historyState.status === 'error'
            ? E('div', { className: 'scw-treeState is-error' }, historyState.error)
            : historyState.commits.length === 0
              ? E('div', { className: 'scw-treeState' }, t('history.empty'))
              : E('div', { className: 'scw-tree scw-list' },
                historyGraph.map((graphRow) => {
                  const commit = graphRow.commit
                  /* Kept in the tooltip so hiding the chips on a narrow pane loses nothing. */
                  const refSummary = Array.isArray(commit.refs) ? commit.refs.join('  ') : (typeof commit.refs === 'string' ? commit.refs : '')
                  return E('div', {
                    key: commit.hash,
                    className: 'scw-commitRow is-graph' + (commit.hash === selectedCommit ? ' is-active' : ''),
                    role: 'button',
                    tabIndex: 0,
                    title: commit.hash + '\n' + commit.subject + (refSummary === '' ? '' : '\n' + refSummary),
                    onClick: () => selectCommit(commit.hash),
                    onKeyDown: (event) => {
                      if (event.key !== 'Enter') return
                      event.preventDefault()
                      selectCommit(commit.hash)
                    },
                  },
                  graphCell(graphRow),
                E('span', { className: 'scw-commitRefs' }, refChipsOf(commit)),
                  E('span', { className: 'scw-commitSubject' }, commit.subject),
                  E('span', { className: 'scw-commitTime' }, relativeTime(commit.authorTime, t)))
                }),
                /* 80 used to be the whole history you could ever see: a repo with 3000
                   commits ended at the 80th with no sign anything was missing. */
                historyHasMore === true
                  ? E('div', { className: 'scw-loadMore' },
                    E('button', {
                      type: 'button',
                      className: 'scw-loadMoreBtn',
                      disabled: historyState.status === 'loading',
                      onClick: loadMoreHistory,
                    }, historyState.status === 'loading' ? t('state.loading') : t('history.loadMore')))
                  : null)

        /* ---- 分支 ---- */
      /* ---- 分支 ----
         One flat list of everything `for-each-ref` returns hides three very different
         things: local branches (you can switch to them), remote branches (read-only
         mirrors of the server) and tags (immutable labels on a commit). It also showed
         the symbolic `origin/HEAD` ref, which is not a branch at all and appeared as a
         bare "origin" row. Grouped, filtered, with a legend. */
      const branchesPanel = (() => {
        if (branchState.status === 'loading' && branchState.branches.length === 0) return E('div', { className: 'scw-treeState' }, t('state.loading'))
        if (branchState.status === 'error') return E('div', { className: 'scw-treeState is-error' }, branchState.error)

        const kindOf = (branch) => {
          if (branch.kind === 'local' || branch.kind === 'remote' || branch.kind === 'tag') return branch.kind
          const refName = String(branch.refName === undefined || branch.refName === null ? '' : branch.refName)
          if (refName.startsWith('refs/remotes/')) return 'remote'
          if (refName.startsWith('refs/tags/')) return 'tag'
          return 'local'
        }
        const all = branchState.branches.filter((branch) => {
          const refName = String(branch.refName === undefined || branch.refName === null ? '' : branch.refName)
          /* refs/remotes/<remote>/HEAD is a symref pointing at the default branch: it
             is not a branch, it just mirrors one. Listing it produced a bare "origin". */
          return refName.endsWith('/HEAD') === false
        })
        const local = all.filter((branch) => kindOf(branch) === 'local')
        const remote = all.filter((branch) => kindOf(branch) === 'remote')
        const tags = all.filter((branch) => kindOf(branch) === 'tag')
        if (local.length + remote.length + tags.length === 0) return E('div', { className: 'scw-treeState' }, t('branches.empty'))

        const section = (key, title, hint, list, emptyText, render) => E('div', { className: 'scw-branchGroup', key },
          E('div', { className: 'scw-groupName', title: hint }, title, list.length > 0 ? E('span', { className: 'scw-groupCount' }, String(list.length)) : null),
          list.length === 0
            ? E('div', { className: 'scw-groupEmpty' }, emptyText)
            : list.map(render))

        const localRow = (branch) => E('div', {
          key: branch.refName === undefined ? branch.name : branch.refName,
          className: 'scw-branchRow' + (branch.head === true ? ' is-head' : ''),
          role: 'button',
          tabIndex: 0,
          title: (branch.head === true ? t('branches.currentHint') + '\n' : '')
            + (branch.upstream === null || branch.upstream === undefined ? t('branches.noUpstream') : t('branches.tracks') + ' ' + branch.upstream + '\n')
            + (branch.subject || ''),
          /* Clicking a NON-current local branch checks it out; clicking the current one
             does nothing (a checkout of HEAD is a no-op that still costs a subprocess
             and can fail on a dirty tree). */
          onClick: () => { if (branch.head !== true) void checkoutBranch(branch.name) },
          onKeyDown: (event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            if (branch.head !== true) void checkoutBranch(branch.name)
          },
        },
        E('span', { className: 'scw-branchIcon' }, E(Icon, { name: 'branch', size: 12 })),
        E('span', { className: 'scw-branchName' }, branch.name),
        /* "●" was a dot you had to interpret. A HEAD chip says it outright — and it is
           the same word git itself uses. */
        branch.head === true ? E('span', { className: 'scw-headChip' }, 'HEAD') : null,
        branch.ahead > 0 ? E('span', { className: 'scw-branchAhead', title: t('branches.aheadHint') }, '↑' + branch.ahead) : null,
        branch.behind > 0 ? E('span', { className: 'scw-branchBehind', title: t('branches.behindHint') }, '↓' + branch.behind) : null,
        /* Per-branch actions live on the row and only appear on hover, so the list
           stays readable. They act on THIS branch, which is why they are here and not
           in the toolbar (where "which branch?" would be a guess). */
        E('span', { className: 'scw-rowActions' },
          branch.head === true ? null : E('button', {
            type: 'button',
            className: 'scw-rowBtn',
            disabled: busy,
            title: t('op.mergeTitle') + ' — ' + branch.name,
            onClick: (event) => { event.stopPropagation(); doMerge(branch.name) },
          }, t('op.merge')),
          branch.head === true ? null : E('button', {
            type: 'button',
            className: 'scw-rowBtn',
            disabled: busy,
            title: t('op.rebaseTitle') + ' — ' + branch.name,
            onClick: (event) => { event.stopPropagation(); doRebase(branch.name) },
          }, t('op.rebase')),
          branch.head === true ? null : E('button', {
            type: 'button',
            className: 'scw-rowBtn is-danger',
            disabled: busy,
            title: t('branch.deleteTitle') + ' — ' + branch.name,
            onClick: (event) => { event.stopPropagation(); doBranchDelete(branch) },
          }, t('action.delete'))))

        /* Remote branches and tags are REFERENCES, not working states: checking one out
           directly gives a detached HEAD, which is not what a click should ever do by
           surprise. They are informational rows. */
        /* A remote name is "remote/branch" — two different things. Splitting them
           keeps the branch name at full contrast instead of one flat grey string. */
        const refRow = (branch) => {
          const full = String(branch.name === undefined || branch.name === null ? '' : branch.name)
          const isRemote = kindOf(branch) === 'remote'
          const cut = isRemote === true ? full.indexOf('/') : -1
          const prefix = cut > 0 ? full.slice(0, cut + 1) : ''
          const rest = cut > 0 ? full.slice(cut + 1) : full
          /* 远程分支：签出 = 建一个同名本地分支并切过去（git checkout -b X origin/X）。
             直接 checkout 远端名会落到 detached HEAD，那不是一次点击该有的后果。 */
          const actions = isRemote === true
            ? E('span', { className: 'scw-rowActions' },
              E('button', {
                type: 'button',
                className: 'scw-rowBtn',
                disabled: busy,
                title: t('op.checkoutTitle') + ' — ' + rest + ' ← ' + full,
                onClick: (event) => {
                  event.stopPropagation()
                  checkoutBranch(rest, { create: true, startPoint: full })
                },
              }, t('op.checkout')),
              E('button', {
                type: 'button',
                className: 'scw-rowBtn',
                disabled: busy,
                title: t('op.mergeTitle') + ' — ' + full,
                onClick: (event) => { event.stopPropagation(); doMerge(full) },
              }, t('op.merge')),
              E('button', {
                type: 'button',
                className: 'scw-rowBtn',
                disabled: busy,
                title: t('op.rebaseTitle') + ' — ' + full,
                onClick: (event) => { event.stopPropagation(); doRebase(full) },
              }, t('op.rebase')))
            : E('span', { className: 'scw-rowActions' },
              E('button', {
                type: 'button',
                className: 'scw-rowBtn',
                disabled: busy,
                title: t('action.tagPush') + ' — ' + full,
                onClick: (event) => { event.stopPropagation(); doTagPushOne(full) },
              }, t('tag.pushOne')),
              E('button', {
                type: 'button',
                className: 'scw-rowBtn is-danger',
                disabled: busy,
                title: t('tag.deleteTitle') + ' — ' + full,
                onClick: (event) => { event.stopPropagation(); doTagDelete(full) },
              }, t('action.delete')))
          return E('div', {
            key: branch.refName === undefined ? branch.name : branch.refName,
            className: 'scw-branchRow is-ref',
            title: full + '\n' + (branch.subject || '') + '\n' + String(branch.short === undefined ? '' : branch.short),
          },
          E('span', { className: 'scw-branchIcon' }, E(Icon, { name: isRemote === true ? 'download' : 'tag', size: 12 })),
          E('span', { className: 'scw-branchName' },
            prefix === '' ? null : E('span', { className: 'scw-branchRemote' }, prefix),
            rest),
          E('span', { className: 'scw-branchHash' }, String(branch.short === undefined ? '' : branch.short)),
          actions)
        }

        /* Remote branches grouped under the REMOTE they live on — `origin` is a heading,
           not a branch. GitCraft does the same, and it is what makes "where does this
           branch live" answerable at a glance. */
        const remoteGroups = (() => {
          const byRemote = new Map()
          for (const branch of remote) {
            const full = String(branch.name === undefined || branch.name === null ? '' : branch.name)
            const cut = full.indexOf('/')
            const remoteName = cut > 0 ? full.slice(0, cut) : ''
            if (!byRemote.has(remoteName)) byRemote.set(remoteName, [])
            byRemote.get(remoteName).push(branch)
          }
          return byRemote
        })()
        const remoteNodes = []
        for (const [remoteName, list] of remoteGroups) {
          remoteNodes.push(E('div', { key: 'rm:' + remoteName, className: 'scw-remoteGroup' },
            E('span', { className: 'scw-branchIcon' }, E(Icon, { name: 'download', size: 12 })),
            E('span', { className: 'scw-branchName' }, remoteName),
            E('span', { className: 'scw-groupCount' }, String(list.length))))
          for (const branch of list) remoteNodes.push(refRow(branch))
        }

        return E('div', { className: 'scw-tree scw-list' },
          E('div', { className: 'scw-branchLegend' }, t('branches.legend')),
          section('local', t('branches.local'), t('branches.localHint'), local, t('branches.noLocal'), localRow),
          section('remote', t('branches.remote'), t('branches.remoteHint'), remoteNodes, t('branches.noRemote'), (node) => node),
          section('tag', t('branches.tags'), t('branches.tagHint'), tags, t('branches.noTags'), refRow))
      })()

        /* ---- 贮藏 ---- */
        const stashPanel = stashState.status === 'loading' && stashState.stash.length === 0
          ? E('div', { className: 'scw-treeState' }, t('state.loading'))
          : stashState.status === 'error'
            ? E('div', { className: 'scw-treeState is-error' }, stashState.error)
            : stashState.stash.length === 0
              ? E('div', { className: 'scw-treeState' }, t('stash.empty'))
              : E('div', { className: 'scw-tree scw-list' },
                stashState.stash.map((item) => E('div', {
                  key: item.ref,
                  className: 'scw-stashRow',
                  title: item.ref + '\n' + item.subject,
                },
                E('span', { className: 'scw-stashRef' }, item.ref),
                E('span', { className: 'scw-stashSubject' }, item.subject),
                E('span', { className: 'scw-rowActions' },
                  E('button', {
                    type: 'button',
                    className: 'scw-rowBtn',
                    disabled: busyAction !== null,
                    title: t('action.stashApply'),
                    onClick: (event) => { event.stopPropagation(); stashAction('stashApply', item) },
                  }, t('action.stashApply')),
                  E('button', {
                    type: 'button',
                    className: 'scw-rowBtn',
                    disabled: busyAction !== null,
                    title: t('action.stashPop'),
                    onClick: (event) => { event.stopPropagation(); stashAction('stashPop', item) },
                  }, t('action.stashPop')),
                  E('button', {
                    type: 'button',
                    className: 'scw-rowBtn is-danger',
                    disabled: busyAction !== null,
                    title: t('action.stashDrop'),
                    onClick: (event) => { event.stopPropagation(); stashAction('stashDrop', item) },
                  }, t('action.stashDrop'))))))

        const filesPanel = E('div', {
          className: 'scw-tree',
          ref: treeScrollRef,
          onScroll: onTreeScroll,
          role: 'tree',
          'aria-label': t('page.title'),
        },
        E('div', { className: 'scw-treeViewport', style: { height: rows.length * TREE_ROW_HEIGHT + 'px' } },
          visibleRows.map(({ row, offset }) => renderRow(row, offset))))

        const browsingBody = treeMode === 'changes' ? changesPanel
          : treeMode === 'history' ? historyPanel
            : treeMode === 'branches' ? branchesPanel
              : treeMode === 'stash' ? stashPanel
                : filesPanel
        const body = browsing === true ? browsingBody : searchBody

        /**
         * The child list is IDENTICAL in both states — that is the fix for
         * "type one letter and the box stops working". The mode strip and toolbar are
         * hidden rather than omitted, so the input keeps its position among its
         * siblings and React never tears it down.
         */
        /* `is-narrow` keys off the PANE width, not the page width: resizing grabs this
           very pane, and the page can be wide while the pane is 160px. */
        return E('div', { className: 'scw-treePane' + (stacked !== true && treeWidth <= NARROW_PANE_W ? ' is-narrow' : ''), style: treeStyle },
          conflictBanner,
          searchRow,
          E('div', { className: 'scw-modeBlock', hidden: browsing === false }, modeStrip),
          E('div', { className: 'scw-modeBlock', hidden: browsing === false }, modeToolbar),
          body)
      })()

      /**
       * The read-only view of one commit.
       *
       * Deliberately NOT a diff: showing a commit's patch requires the diff pane
       * to accept a revision, and that is a different contract from "show me this
       * file's working-tree change". What a reader needs first from a commit is
       * "which files did it touch" — the patch is a second question, and one the
       * git page still answers.
       */
      const commitDetailView = () => {
        if (commitDetail.status === 'loading') {
          return E('div', { className: 'scw-empty' }, E('div', { className: 'scw-emptyTitle' }, t('state.loading')))
        }
        if (commitDetail.status === 'error') {
          return E('div', { className: 'scw-empty' },
            E('div', { className: 'scw-emptyTitle' }, t('state.failed')),
            E('div', { className: 'scw-emptyHint' }, commitDetail.error))
        }
        const detail = commitDetail.detail
        if (detail === null || detail === undefined) {
          return E('div', { className: 'scw-empty' }, E('div', { className: 'scw-emptyTitle' }, t('state.loading')))
        }
        const files = Array.isArray(detail.files) ? detail.files : []
        return E('div', { className: 'scw-commitDetail' },
          E('div', { className: 'scw-commitHead' },
            E('span', { className: 'scw-commitHash' }, detail.short),
            E('span', { className: 'scw-commitSubject is-large' }, detail.subject)),
          E('div', { className: 'scw-commitInfo' },
            E('span', null, detail.authorName),
            E('span', { className: 'scw-dim' }, relativeTime(detail.authorTime, t)),
            E('span', { className: 'scw-dim' }, detail.hash)),
          /* Actions on THIS commit. Placed with the commit rather than in the
             toolbar for the same reason as branch actions: "which commit?" would
             otherwise be a guess. */
          E('div', { className: 'scw-commitOps' },
            E('button', {
              type: 'button',
              className: 'scw-toolBtn',
              disabled: busyAction !== null,
              title: t('op.cherryPickHint'),
              onClick: () => doCherryPick(detail.hash),
            }, t('op.cherryPick')),
            E('button', {
              type: 'button',
              className: 'scw-toolBtn',
              disabled: busyAction !== null,
              title: t('op.revertHint'),
              onClick: () => doRevert(detail.hash),
            }, t('op.revert')),
            E('button', {
              type: 'button',
              className: 'scw-toolBtn',
              disabled: busyAction !== null,
              title: t('op.resetHint'),
              onClick: () => doReset(detail.hash),
            }, t('op.reset')),
            E('button', {
              type: 'button',
              className: 'scw-toolBtn',
              disabled: busyAction !== null,
              title: t('tag.createTitle'),
              onClick: () => doTagCreate(detail.hash),
            }, t('action.tagCreate')),
            E('button', {
              type: 'button',
              className: 'scw-toolBtn',
              title: t('commit.wholeHint'),
              onClick: () => setCommitFile({ rel: null, rev: detail.hash }),
            }, t('commit.wholeBtn'))),
          detail.body === '' || detail.body === null || detail.body === undefined
            ? null
            : E('pre', { className: 'scw-commitBody' }, detail.body),
          E('div', { className: 'scw-commitFilesLabel' }, t('commit.files') + ' (' + files.length + ')'),
          E('div', { className: 'scw-commitFiles' },
            files.map((file, index) => E('div', {
              key: file.path + ':' + index,
              className: 'scw-commitFile' + (commitFile !== null && commitFile !== undefined && commitFile.rel === normalizeRel(file.path) ? ' is-active' : ''),
              title: t('commit.showPatch') + ' — ' + file.path,
              /* Clicking a file shows WHAT THIS COMMIT DID to it. Opening the
                 working-tree file instead was the old behaviour and it answered a
                 different question than the one the user was asking. */
              role: 'button',
              tabIndex: 0,
              onClick: () => setCommitFile({ rel: normalizeRel(file.path), rev: detail.hash }),
              onKeyDown: (event) => {
                if (event.key !== 'Enter') return
                event.preventDefault()
                setCommitFile({ rel: normalizeRel(file.path), rev: detail.hash })
              },
            },
            E('span', { className: 'scw-letter ' + statusColorClass(file.status) }, file.status),
            E('span', { className: 'scw-commitFileName' }, baseNameOf(normalizeRel(file.path))),
            E('span', { className: 'scw-rowDir' }, dirNameOf(normalizeRel(file.path)))))))
      }

      /**
       * One commit's patch for one file.
       *
       * Reuses the diff pane with `base: 'commit'`. The back button matters: this
       * view replaced the commit summary, and without a way back the user is stuck
       * looking at a patch with no route to the rest of the commit.
       */
      /**
       * A patch that belongs to ONE version: either a file inside a commit, or a
       * version inside a file's history. Same view for both — the only difference
       * is what "back" returns to.
       *
       * The back button is load-bearing: this view REPLACES the list, so without it
       * the reader is stuck on a diff with no route back. It used to be hidden at
       * normal widths by a CSS rule meant only for the compact layout.
       */
      /**
       * A patch that belongs to ONE version: either a file inside a commit, or a
       * version inside a file's history. Same view for both — the only difference
       * is what "back" returns to.
       *
       * Layout: [← 返回] [path] [@rev] ......... [分栏/合并]
       * Explicit spacer instead of `margin-left:auto`: the auto margin only pushes
       * the toggle right when the strip is already full width, and the strip was
       * NOT full width (it shrank to its content), so the whole header floated in
       * the middle of the pane.
       */
      const commitPatchView = () => E('div', { className: 'scw-commitPatch' },
        E('div', { className: 'scw-tabs', role: 'tablist' },
          E('button', {
            type: 'button',
            className: 'scw-back',
            title: t('action.back'),
            onClick: () => setCommitFile(null),
          }, E(Icon, { name: 'chevronRight', size: 11 }), t('action.back')),
          /* Centred between the back button and the layout toggle, and visually split:
             the PATH is the subject (primary colour), the REVISION is metadata (muted
             chip). Jammed together in one colour they read as one unparseable string. */
          E('div', { className: 'scw-fileGroup' },
            E('span', { className: 'scw-tabFile' + (commitFile.rel === null ? ' is-whole' : ''), title: commitFile.rel === null ? t('commit.whole') : commitFile.rel },
              commitFile.rel === null ? t('commit.whole') : commitFile.rel),
            E('span', { className: 'scw-revChip', title: commitFile.rev }, '@' + String(commitFile.rev).slice(0, 8))),
          E('span', { className: 'scw-spacer' }),
          /* History patches get the same layout switch as working-tree diffs: a
             wide window is wasted on one column of unified diff. */
          E('button', {
            type: 'button',
            className: 'scw-modeToggle',
            title: diffMode === 'unified' ? t('diff.modeSplit') : t('diff.modeUnified'),
            'aria-label': diffMode === 'unified' ? t('diff.modeSplit') : t('diff.modeUnified'),
            onClick: () => setDiffMode((value) => (value === 'unified' ? 'split' : 'unified')),
          }, E(Icon, { name: 'source', size: 11 }), diffMode === 'unified' ? t('diff.modeSplit') : t('diff.modeUnified'))),
          /* 弹窗查看：内容区铺满窗口，Esc 退出。审查大文件时比挤在下半屏舒服。 */
          E('button', {
            className: 'scw-modeToggle',
            title: contentModal === true ? t('modal.close') : t('modal.open'),
            'aria-label': contentModal === true ? t('modal.close') : t('modal.open'),
            onClick: () => setContentModal((value) => value !== true),
          }, E(Icon, { name: 'source', size: 11 }), contentModal === true ? t('modal.close') : t('modal.open')),
        E('div', { className: 'scw-paneHost' },
          E('div', { className: 'scw-paneSlot', ref: commitRefCb })))

      /**
       * Per-file history and blame, rendered here rather than in a pane.
       *
       * They are lists of text — no editor, no diff engine — so borrowing a pane
       * from another bundle would add a third cross-bundle dependency to buy
       * nothing. This page owns them.
       */
      const fileHistoryView = () => {
        if (fileHistory.status === 'loading') return E('div', { className: 'scw-paneState' }, t('state.loading'))
        if (fileHistory.status === 'error') return E('div', { className: 'scw-paneState is-error' }, fileHistory.error)
        if (fileHistory.commits.length === 0) return E('div', { className: 'scw-paneState' }, t('history.fileEmpty'))
        return E('div', { className: 'scw-historyList' },
          fileHistory.commits.map((commit) => {
            const repoPath = fileHistory.rel === null ? null : toRepoPath(fileHistory.rel, repoRootRel)
            const openPatch = () => {
              if (repoPath === null || repoPath === '') return
              setCommitFile({ rel: repoPath, rev: commit.hash })
            }
            return E('div', {
              key: commit.hash + ':' + (commit.filePath ?? ''),
              className: 'scw-commitRow',
              role: 'button',
              tabIndex: 0,
              title: commit.hash + ' — ' + t('commit.showPatch'),
              /* Clicking a version in the FILE's history shows what that commit did
                 to THIS file. The rows used to be inert, so the tab asked a question
                 it could not follow up on. */
              onClick: openPatch,
              onKeyDown: (event) => {
                if (event.key !== 'Enter') return
                event.preventDefault()
                openPatch()
              },
            },
            E('div', { className: 'scw-commitTop' },
              E('span', { className: 'scw-commitSubject' }, commit.subject)),
            E('div', { className: 'scw-commitMeta' },
              E('span', { className: 'scw-commitAuthor' }, commit.authorName),
              E('span', { className: 'scw-commitTime' }, relativeTime(commit.authorTime, t))))
          }))
      }

      /**
       * `git blame`, one row per line.
       *
       * The host returns `{ hash, origLine, finalLine, author, authorTime, summary,
       * content }` — NOT `short` / `authorName` / `line` / `text`. Reading the wrong
       * field names produced a column of line numbers with blank authors and blank
       * code: every lookup was undefined and every fallback rendered the empty
       * string, so it looked plausible and was useless.
       */
      const blameView = () => {
        if (blameState.status === 'loading') return E('div', { className: 'scw-paneState' }, t('state.loading'))
        if (blameState.status === 'error') return E('div', { className: 'scw-paneState is-error' }, blameState.error)
        if (blameState.lines.length === 0) return E('div', { className: 'scw-paneState' }, t('blame.empty'))
        return E('div', { className: 'scw-blameList' },
          blameState.lines.map((line, index) => {
            const hash = typeof line.hash === 'string' ? line.hash : ''
            const author = typeof line.author === 'string' ? line.author : ''
            const summary = typeof line.summary === 'string' ? line.summary : ''
            const number = Number.isFinite(line.finalLine) ? line.finalLine : index + 1
            return E('div', {
              key: index,
              className: 'scw-blameRow',
              title: author + (summary === '' ? '' : ' — ' + summary) + (hash === '' ? '' : '\n' + hash),
            },
            E('span', { className: 'scw-blameHash' }, hash.slice(0, 7)),
            E('span', { className: 'scw-blameMeta' }, author.slice(0, 16)),
            E('span', { className: 'scw-blameLine' }, String(number)),
            E('span', { className: 'scw-blameText' }, typeof line.content === 'string' ? line.content : ''))
          }))
      }
      /* 右栏值得打开吗？ */
      const hasDoc = (commitFile !== null && commitFile !== undefined)
        || (selectedCommit !== null && treeMode === 'history')
        /* 选中目录也算「有内容」：右栏显示该目录的条目数，比留白有用。 */
        || selectedRel !== null
      const contentInner = (() => {
        if (workspaceRoot === '') {
          return E('div', { className: 'scw-empty' },
            E('div', { className: 'scw-emptyTitle' }, t('empty.noRoot')),
            E('div', { className: 'scw-emptyHint' }, t('empty.chooseRoot')))
        }
        if (snapshotError !== null) {
          const notRepo = snapshotError !== null && snapshotError !== undefined && snapshotError.code === 'not-a-repo'
          return E('div', { className: 'scw-empty' },
            E('div', { className: 'scw-emptyTitle' }, notRepo ? t('empty.noRepo') : t('state.failed')),
            E('div', { className: 'scw-emptyHint' }, notRepo ? t('empty.noRepoHint') : (snapshotError.message || t('error.unknown'))),
            E('button', { type: 'button', className: 'scw-btn', onClick: refresh }, t('state.retry')))
        }
        /* A selected commit owns the right pane: it is a different subject from a
           working-tree file, and showing it beside a diff would be two answers to
           two different questions in one box. */
        if (commitFile !== null && commitFile !== undefined) {
          return commitPatchView()
        }
        if (selectedCommit !== null && treeMode === 'history') {
          return commitDetailView()
        }
        if (selectedRel === null) {
          return E('div', { className: 'scw-empty' },
            E('div', { className: 'scw-emptyTitle' }, changeCount === 0 ? t('empty.clean') : t('empty.noFile')),
            E('div', { className: 'scw-emptyHint' }, t('empty.noFileHint')))
        }
        /* A directory is a selection but not a document: say so, instead of
           handing the path to a file viewer and showing its complaint. */
        if (selectedIsDir === true) {
          const listing = dirs[selectedRel]
          const count = listing !== undefined && listing !== null && Array.isArray(listing.entries) ? listing.entries.length : 0
          return E('div', { className: 'scw-empty' },
            E('div', { className: 'scw-emptyTitle' }, baseNameOf(selectedRel) || selectedRel),
            E('div', { className: 'scw-emptyHint' }, count === 0 ? t('dir.empty') : (count + ' ' + t('dir.entries'))),
            E('div', { className: 'scw-emptyHint' }, t('dir.pickFile')))
        }
        return E(Fragment, null,
          E('div', { className: 'scw-tabs', role: 'tablist' },
            compact ? E('button', {
              type: 'button',
              className: 'scw-back',
              onClick: () => setSelectedRel(null),
            }, E(Icon, { name: 'chevronRight', size: 11 }), t('group.files')) : null,
            E('button', {
              type: 'button',
              role: 'tab',
              'aria-selected': activeTab === 'source',
              className: 'scw-tab' + (activeTab === 'source' ? ' is-active' : ''),
              onClick: () => setActiveTab('source'),
            }, E(Icon, { name: 'source', size: 12 }), t('tab.source')),
            E('button', {
              type: 'button',
              role: 'tab',
              'aria-selected': activeTab === 'diff',
              className: 'scw-tab' + (activeTab === 'diff' ? ' is-active' : ''),
              disabled: statusIndex.has(selectedRel) === false,
              onClick: () => setActiveTab('diff'),
            }, E(Icon, { name: 'changes', size: 12 }), t('tab.diff')),
            E('button', {
              type: 'button',
              role: 'tab',
              'aria-selected': activeTab === 'history',
              className: 'scw-tab' + (activeTab === 'history' ? ' is-active' : ''),
              onClick: () => setActiveTab('history'),
            }, E(Icon, { name: 'history', size: 12 }), t('tab.history')),
            E('button', {
              type: 'button',
              role: 'tab',
              'aria-selected': activeTab === 'blame',
              className: 'scw-tab' + (activeTab === 'blame' ? ' is-active' : ''),
              title: t('tab.blameHint'),
              onClick: () => setActiveTab('blame'),
            }, E(Icon, { name: 'tag', size: 12 }), t('tab.blame')),
            E('span', {
              className: 'scw-tabFile',
              title: selectedRel + '（双击弹窗查看）',
              /* 双击标题就弹窗：看大文件时不用去右边找按钮，手上自然动作。 */
              onDoubleClick: () => setContentModal(true),
            }, selectedRel),
            /* 弹窗查看：任何标签下都有用（源码/变更/历史/逐行作者），所以不像下面那个
               分栏开关一样只在 diff 里出现。 */
            E('button', {
              type: 'button',
              className: 'scw-modalBtn',
              title: contentModal === true ? t('modal.close') : t('modal.open'),
              'aria-label': contentModal === true ? t('modal.close') : t('modal.open'),
              onClick: () => setContentModal((value) => value !== true),
            }, E(Icon, { name: 'source', size: 11 }), contentModal === true ? t('modal.close') : t('modal.open')),
            /* Diff layout, owned by the reader. Only meaningful where a patch is
               shown, so it appears with the diff tab. */
            activeTab === 'diff'
              ? E('button', {
                type: 'button',
                className: 'scw-modeToggle',
                title: diffMode === 'unified' ? t('diff.modeSplit') : t('diff.modeUnified'),
                'aria-label': diffMode === 'unified' ? t('diff.modeSplit') : t('diff.modeUnified'),
                onClick: () => setDiffMode((value) => (value === 'unified' ? 'split' : 'unified')),
              }, E(Icon, { name: 'source', size: 11 }), diffMode === 'unified' ? t('diff.modeSplit') : t('diff.modeUnified'))
              : null),
          E('div', { className: 'scw-paneHost' },
            /* TWO slots, both always mounted, one hidden. Hiding rather than
               unmounting is what makes switching tabs instant AND keeps the
               editor's buffer alive while the user looks at the diff. The two
               shell-owned views mount on demand: they hold no state worth
               preserving. */
            E('div', { className: 'scw-paneSlot', ref: sourceRefCb, hidden: activeTab !== 'source' }),
            E('div', { className: 'scw-paneSlot', ref: diffRefCb, hidden: activeTab !== 'diff' }),
            activeTab === 'history' ? E('div', { className: 'scw-paneSlot' }, fileHistoryView()) : null,
            activeTab === 'blame' ? E('div', { className: 'scw-paneSlot' }, blameView()) : null))
      })()

      const commitBox = E('div', { className: 'scw-commit' },
        E('textarea', {
          className: 'scw-commitInput',
          value: commitMessage,
          placeholder: t('commit.placeholder'),
          'aria-label': t('commit.placeholder'),
          onChange: (event) => setCommitMessage(event.target.value),
        }),
        E('div', { className: 'scw-commitSide' },
          E('button', {
            type: 'button',
            className: 'scw-btn is-primary',
            disabled: commitMessage.trim() === '' || busy !== null,
            onClick: doCommit,
          }, t('commit.button')),
          E('label', { className: 'scw-amend' },
            E('input', {
              type: 'checkbox',
              checked: amend,
              onChange: (event) => setAmend(event.target.checked),
            }),
            t('commit.amend'))))

      const barNode = bar === null ? null : E('div', { className: 'scw-bar' + (bar.kind === 'error' ? ' is-error' : '') },
        E(Icon, { name: bar.kind === 'error' ? 'warning' : 'commit', size: 12 }),
        E('span', null, bar.message),
        E('span', { className: 'scw-spacer' }),
        E('button', { type: 'button', className: 'scw-rowBtn', onClick: () => setBar(null) }, E(Icon, { name: 'close', size: 11 })))

      /**
       * One dialog mechanism for every operation.
       *
       * `window.prompt` and `window.confirm` are not available inside DSH's
       * renderer, and a bespoke modal per command would be dozens of nearly
       * identical components. So `dialog` holds a small descriptor:
       *
       *   { kind: 'confirm', title, body, confirmLabel, onConfirm }
       *   { kind: 'prompt',  title, body, label, value, placeholder, onConfirm(value) }
       *   { kind: 'menu',    title, body, items: [{ label, danger, onSelect }] }
       *
       * `promptValue` is separate state so typing re-renders only the input's
       * value without rebuilding the descriptor.
       */

      const dialogNode = dialog === null ? null : E('div', {
        className: 'scw-backdrop',
        role: 'presentation',
        /* Clicking the backdrop cancels. A modal that traps the pointer with no
           escape is worse than no modal. */
        onClick: (event) => { if (event.target === event.currentTarget) setDialog(null) },
      },
      E('div', {
        className: 'scw-dialog' + (dialog.kind === 'browse' ? ' is-wide' : ''),
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': dialog.title,
        onKeyDown: (event) => {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          setDialog(null)
        },
      },
      E('div', { className: 'scw-dialogHead' }, E(Icon, { name: dialog.kind === 'menu' ? 'chevronRight' : 'warning', size: 13 }), dialog.title),
      dialog.body === undefined || dialog.body === null || dialog.body === '' ? null : E('div', { className: 'scw-dialogBody' }, dialog.body),

      dialog.kind === 'menu'
        ? E('div', { className: 'scw-menu' },
          dialog.items.map((item, index) => E('button', {
            key: index,
            type: 'button',
            className: 'scw-menuItem' + (item.danger === true ? ' is-danger' : '') + (item.disabled === true ? ' is-disabled' : ''),
            disabled: item.disabled === true,
            title: item.title ?? item.label,
            onClick: () => { setDialog(null); item.onSelect() },
          }, item.label)))
        : null,

      dialog.kind === 'browse'
        ? E('div', { className: 'scw-browse' },
          /* File-manager layout: where you are, the volumes, a path bar you can JUMP
             with, then the listing — every row showing its full path so two same-named
             folders are tellable apart. */
          E('div', { className: 'scw-browseSection' }, t('root.currentRoot')),
          E('div', { className: 'scw-browseCurrent', title: repoRoot === '' ? workspaceRoot : repoRoot },
            E(Icon, { name: 'folder', size: 12 }),
            E('span', { className: 'scw-browseCurrentName' }, repoLabel === '' ? t('empty.noRoot') : repoLabel),
            E('span', { className: 'scw-browseCurrentPath' }, repoRoot === '' ? workspaceRoot : repoRoot)),
          /* 最近打开：和「浏览」合到同一个对话框里。分成菜单 + 对话框两个入口时，
             想切回上周用的目录要点开菜单，想挑个新目录又要再点进对话框。 */
          (() => {
            const merged = []
            const source = readRecentRoots().concat(Array.isArray(browse.recent) ? browse.recent : [])
            for (const entry of source) {
              if (typeof entry !== 'string' || entry === '') continue
              if (merged.indexOf(entry) >= 0) continue
              merged.push(entry)
            }
            if (merged.length === 0) return null
            return E('div', null,
              E('div', { className: 'scw-browseSection' }, t('root.recent')),
              merged.slice(0, 6).map((entry) => E('button', {
                key: 'recent:' + entry,
                type: 'button',
                className: 'scw-browseItem' + (entry === workspaceRoot ? ' is-current' : ''),
                title: entry,
                onClick: () => { setDialog(null); changeRoot(entry) },
              },
              E(Icon, { name: 'folder', size: 12 }),
              E('span', { className: 'scw-browseItemName' }, entry.split(/[\\/]/).filter(Boolean).pop() || entry),
              E('span', { className: 'scw-browseItemPath' }, entry))))
          })(),
          browse.drives.length === 0
            ? null
            : E('div', null,
              E('div', { className: 'scw-browseSection' }, t('root.drives')),
              E('div', { className: 'scw-drives' },
                browse.drives.map((drive) => E('button', {
                  key: drive.path,
                  type: 'button',
                  className: 'scw-driveChip' + (String(browse.dir).toLowerCase().startsWith(String(drive.path).toLowerCase()) ? ' is-active' : ''),
                  title: drive.path,
                  onClick: () => { setBrowsePathInput(drive.path); loadBrowse(drive.path) },
                }, drive.name)))),
          E('div', { className: 'scw-browseSection' }, t('root.browseFolders')),
          /* A path BAR, not a blind prompt: it shows where you are and lets you jump.
             The old "手动输入路径" menu item asked people to type into nothing. */
          E('div', { className: 'scw-browseBar' },
            E('input', {
              className: 'scw-browseInput',
              type: 'text',
              value: browsePathInput,
              spellCheck: false,
              'aria-label': t('root.pathLabel'),
              onChange: (event) => setBrowsePathInput(event.target.value),
              onKeyDown: (event) => {
                if (event.key !== 'Enter') return
                event.preventDefault()
                if (browsePathInput.trim() !== '') loadBrowse(browsePathInput.trim())
              },
            }),
            E('button', {
              type: 'button',
              className: 'scw-browseGo',
              disabled: browsePathInput.trim() === '',
              onClick: () => { if (browsePathInput.trim() !== '') loadBrowse(browsePathInput.trim()) },
            }, t('root.go'))),
          E('div', { className: 'scw-browseBar' },
            E('button', {
              type: 'button',
              className: 'scw-browseUp',
              disabled: browse.parent === null,
              title: t('root.up'),
              onClick: () => { if (browse.parent !== null) loadBrowse(browse.parent) },
            }, E(Icon, { name: 'arrowUp', size: 12 })),
            E('span', { className: 'scw-browsePath', title: browse.dir }, browse.dir === '' ? t('state.loading') : browse.dir)),
          browse.error === null ? null : E('div', { className: 'scw-browseError' }, browse.error),
          E('div', { className: 'scw-browseList' },
            browse.entries.map((entry) => E('button', {
              key: entry.path,
              type: 'button',
              className: 'scw-browseItem',
              title: entry.path,
              onClick: () => { setBrowsePathInput(entry.path); loadBrowse(entry.path) },
            },
            E(Icon, { name: 'folder', size: 12 }),
            E('span', { className: 'scw-browseName' }, entry.name === undefined ? entry.path : entry.name),
            /* The full path on the right: "docs" exists in three places. */
            E('span', { className: 'scw-browseItemPath' }, String(entry.path))))),
        )
        : null,

      dialog.kind === 'prompt'
        ? E('div', { className: 'scw-dialogField' },
          dialog.label === undefined || dialog.label === null ? null : E('label', { className: 'scw-dialogLabel' }, dialog.label),
          E('input', {
            className: 'scw-dialogInput',
            type: 'text',
            value: promptValue,
            placeholder: dialog.placeholder ?? '',
            autoFocus: true,
            onChange: (event) => setPromptValue(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                const value = promptValue
                setDialog(null)
                dialog.onConfirm(value)
                return
              }
              if (event.key === 'Escape') {
                event.stopPropagation()
                setDialog(null)
              }
            },
          }))
        : null,

      E('div', { className: 'scw-dialogFoot' },
        E('button', {
          type: 'button',
          className: 'scw-btn',
          onClick: () => setDialog(null),
        }, dialog.kind === 'menu' ? t('action.close') : t('action.cancel')),
        dialog.kind === 'menu'
          ? null
          : E('button', {
            type: 'button',
            className: 'scw-btn is-primary',
            onClick: () => {
              if (dialog.kind === 'prompt') {
                const value = promptValue
                setDialog(null)
                dialog.onConfirm(value)
                return
              }
              setDialog(null)
              dialog.onConfirm()
            },
          }, dialog.confirmLabel ?? t('action.ok')))))

      return E('div', {
        className: 'scw-root' + (compact ? ' is-xs' : '') + (resizing ? ' is-resizing' : '')
          + (contentModal === true ? ' is-modal' : ''),
        ref: rootRef,
        'data-mode': mode,
      },
      header,
      barNode,
      E('div', { className: 'scw-body' + (stacked === true ? ' is-stacked' : '') },
        treePane,
        compact || stacked === true ? null : E('div', {
          /* 上下分栏时没有垂直拖拽条：这个把手只会水平拖动，留着只会误导。 */
          className: 'scw-grip' + (resizing ? ' is-dragging' : ''),
          title: t('head.more'),
          onPointerDown: onGripDown,
        }),
        E('div', { className: 'scw-content' }, contentInner)),
      commitBox,
      dialogNode)
    }

    /* ============================== locale live wrapper ============================== */

    function LocaleLive(props) {
      const { ctx } = props
      const [tick, setTick] = useState(0)
      useEffect(() => {
        const locale = ctx === undefined ? undefined : ctx.get('locale')
        if (locale === undefined || typeof locale.subscribe !== 'function') return undefined
        const off = locale.subscribe(() => setTick((value) => value + 1))
        return () => { if (typeof off === 'function') off() }
      }, [ctx])
      void tick
      /* MEMOISED. `translatorOf` returns a fresh closure each call, so deriving it
         inline made `t` a new function on EVERY render. Everything keyed on it then
         changed identity every render — including the pane callback refs, which
         React detaches and re-attaches when their identity changes, DISPOSING and
         REMOUNTING the editor and diff panes several times a second. That is what
         made a click appear to do nothing: the pane was torn down right after the
         host pushed a file into it.
         The locale is still picked up live: `translatorOf` reads the active locale
         on every call, and `LocaleLive` re-renders on the locale event. */
      const t = useMemo(() => translatorOf(ctx), [ctx])
      return E(Page, { t, ctx, dock: props.dock, chatRef: props.chatRef })
    }

    /* ============================== apply ============================== */

    function apply(ctx) {
      /* 会话输入框由 DSH 的 conversation 服务提供。它可能只对「声明了依赖」的作用域
       可见，所以在这里 inject 一次并存下引用——点击时才拿不到就太晚了。 */
    const chatRef = { current: null }
    try {
      /* inject 不一定存在（测试里的假 ctx 就没有），拿不到也不该让整页注册失败。 */
      if (typeof ctx.inject === 'function') {
        ctx.inject(['conversation'], (scoped) => {
          chatRef.current = scoped.conversation !== undefined ? scoped.conversation : scoped.get('conversation')
        })
      }
    } catch (error) { void error }
    const locale = ctx.get('locale')
      if (locale !== undefined && typeof locale.register === 'function') {
        ctx.effect(() => locale.register(LOCALE_NS, { zh: ZH, en: EN }), 'dsh-workbay-source-control: locale')
      }

      /* Styles for MY OWN chrome only. The two panes bring their own. */
      ctx.effect(() => {
        if (typeof document === 'undefined' || document === null) return undefined
        const style = document.createElement('style')
        style.setAttribute('data-dsh-workbay-source-control', '')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => { try { style.remove() } catch (error) { void error } }
      }, 'dsh-workbay-source-control: styles')

      /* NOT memoised here: this runs inside `apply()`, not a component. A hook
         call outside a React render throws "Invalid hook call" and the page never
         mounts at all — which is exactly what happened when the memoisation was
         applied to both sites by mistake. */
      const t = translatorOf(ctx)

      /* Register with the workbench dock. Two independent bundles with no load
         ordering guarantee, so poll briefly for the global to appear. */
      const register = () => {
        const dock = typeof window === 'object' && window !== null ? window.__DSH_WORKBAY__ : undefined
        if (dock === undefined || dock === null || typeof dock.registerPage !== 'function') return false
        try {
          const off = dock.registerPage({
            id: PAGE_ID,
            title: t('page.title'),
            order: 15,
            icon: (size) => E(Icon, { name: 'changes', size: size === undefined ? 16 : size }),
            component: (pageProps) => E(LocaleLive, {
              ctx,
              t,
              dock: pageProps === undefined ? undefined : pageProps.dock,
          chatRef,
            }),
          })
          ctx.effect(() => off, 'dsh-workbay-source-control: page')
          return true
        } catch (error) {
          try { console.error('[source-control] page registration failed:', error) } catch { void error }
          return false
        }
      }

      if (!register()) {
        let attempts = 0
        const timer = setInterval(() => {
          attempts += 1
          if (register() || attempts >= 40) clearInterval(timer)
        }, 250)
        ctx.effect(() => () => clearInterval(timer), 'dsh-workbay-source-control: dock discovery')
      }
    }

    /* Pure helpers exposed for the unit tests; not part of any contract. */
    const TEST_API = {
      PAGE_ID,
      normalizeRel,
      joinRel,
      baseNameOf,
      dirNameOf,
      extensionOf,
      repoRootRelative,
      toRepoPath,
      toWorkspaceRel,
      statusLetterOf,
      statusColorClass,
      buildStatusIndex,
      buildDirtyDirs,
      buildChangeGroups,
      relativeTime,
      highlightName,
      flattenTree,
      modeOfWidth,
      components: { Page, LocaleLive, Icon, IconButton },
      TREE_ROW_HEIGHT,
      BP_S,
      BP_M,
      BP_L,
    }

    return { apply, name: 'dsh-workbay-source-control', __test: TEST_API }
  },
})





















































































































































