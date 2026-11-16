/**
 * dsh-gitcraft — client half (plain JavaScript, no build step).
 *
 * Registers ONE dsh-better-sidebar tab (and, when that base is absent, a native
 * right-sidebar seat): a SourceTree-grade GitCraft.
 *
 * Layout: the panel measures its own container and picks a chrome, so the same
 * registration works in the narrow tall native sidebar and in a wide bottom
 * workbench:
 *
 *   columns  wide + tall : branch/tag tree | commit graph | changes + commit box
 *   stack    narrow tall : changes over history, collapsible branch tree
 *   compact  short/narrow: one header row + a Changes/History switch
 *
 * Theming: every surface is a --dsw-alias-* token so transparent themes show
 * through, like better-sidebar's own panels do.
 */
window.__ModuleLoader__.load({
  id: 'dsh-gitcraft',
  factory: (require) => {
    const React = require('react')
    const E = React.createElement
    const Fragment = React.Fragment
    const useState = React.useState
    const useEffect = React.useEffect
    const useMemo = React.useMemo
    const useRef = React.useRef
    const useCallback = React.useCallback

    const API_BASE = 'dsh-gitcraft/api'
    /* Diffs are the expensive state of this pane and mounting it again (switch
       to another workbench tab and back) used to throw the patch away and spawn
       git a second time. Commit patches are immutable; working-tree patches get
       a short TTL so re-entry is instant without hiding an edit for long. */
    const PANE_DIFF_CACHE_LIMIT = 48
    const PANE_DIFF_CACHE_MAX_CHARS = 8 * 1024 * 1024
    const PANE_DIFF_COMMIT_TTL_MS = 10 * 60 * 1000
    const PANE_DIFF_WORKTREE_TTL_MS = 5000
    const paneDiffCache = new Map()
    let paneDiffCacheChars = 0

    function paneDiffKey(root, base, rev, path, whole) {
      return String(root || '') + '\u0000' + String(base || '') + '\u0000'
        + String(rev || '') + '\u0000' + String(path || '') + '\u0000' + (whole === true ? '1' : '0')
    }

    function readPaneDiff(key, ttlMs) {
      const hit = paneDiffCache.get(key)
      if (hit === undefined) return null
      if (Date.now() - hit.at > ttlMs) {
        paneDiffCache.delete(key)
        paneDiffCacheChars -= hit.chars
        return null
      }
      paneDiffCache.delete(key)
      paneDiffCache.set(key, hit)
      return hit.value
    }

    function rememberPaneDiff(key, value) {
      const chars = (typeof value.patch === 'string' ? value.patch.length : 0)
        + (Array.isArray(value.hunks) ? value.hunks.length * 80 : 0)
      if (chars > PANE_DIFF_CACHE_MAX_CHARS) return
      if (paneDiffCache.has(key)) {
        paneDiffCacheChars -= paneDiffCache.get(key).chars
        paneDiffCache.delete(key)
      }
      paneDiffCache.set(key, { at: Date.now(), value, chars })
      paneDiffCacheChars += chars
      while (paneDiffCache.size > 1
        && (paneDiffCache.size > PANE_DIFF_CACHE_LIMIT || paneDiffCacheChars > PANE_DIFF_CACHE_MAX_CHARS)) {
        const oldest = paneDiffCache.keys().next()
        if (oldest.done === true) break
        const stale = paneDiffCache.get(oldest.value)
        if (stale !== undefined) paneDiffCacheChars -= stale.chars
        paneDiffCache.delete(oldest.value)
      }
    }
    const TAB_ID = 'dsh-gitcraft:panel'
    const NATIVE_ID = 'gitcraft'
    const NATIVE_KIND = 'gitcraft'
    const SETTINGS_BUNDLE = 'dsh-gitcraft'
    const LOCALE_NS = 'dsh-gitcraft'
    const LANE_WIDTH = 13
    const GRAPH_MAX_LANES = 6
    const COMPACT_MAX_WIDTH = 420
    const LANE_COLORS = ['#4d6bfe', '#e2a03f', '#3fb950', '#d2679b', '#59b0d6', '#b083f0', '#d2694a', '#8a9aa8']
    const REF_KEY = 'dsh-gitcraft.ref.v1'

    /* ============================== i18n ============================== */

    const ZH = {
      'title': 'GitCraft',
      'description': 'SourceTree 级 GitCraft：分支树 / 提交图 / hunk 级暂存 / 合并与冲突',
      'nav.changes': '变更',
      'nav.files': '文件',
      'nav.history': '历史',
      'nav.branches': '分支',
      'nav.stash': '贮藏',
      'nav.blame': '追溯',
      'repo.none': '当前工作区不是 Git 仓库',
      'repo.noneHint': '打开一个 Git 仓库所在的工作区，或在本目录初始化一个仓库。',
      'repo.init': '初始化仓库',
      'repo.switch': '切换仓库',
      'repo.label': '仓库',
      'repo.pick': '选择要查看的仓库',
      'repo.scanning': '正在扫描工作区中的仓库…',
      'repo.viewScan': '扫描结果',
      'repo.viewBrowse': '浏览目录',
      'repo.workspaceRoot': '工作区根',
      'repo.useThis': '使用当前目录',
      'repo.useParent': '使用仓库根：{name}',
      'repo.isRepo': 'Git 仓库',
      'repo.noSubdirs': '这个目录下没有子目录',
      'repo.truncated': '目录过多，扫描已截断；可切到「浏览目录」逐层查看。',
      'repo.driveRoot': '磁盘…',
      'repo.typePath': '输入仓库路径（绝对路径）',
      'repo.typePathShort': '输入路径…',
      'repo.globalHint': '可以选择任意位置的仓库（不限于工作区）',
      'picker.tabPath': '路径',
      'picker.tabBrowse': '浏览',
      'picker.tabScan': '扫描结果',
      'picker.pathLabel': '工作副本路径',
      'picker.pathPlaceholder': 'C:\\Users\\me\\projects\\repo',
      'picker.typeLabel': '仓库类型',
      'picker.typeIdle': '输入或粘贴一个仓库路径',
      'picker.checking': '正在检查…',
      'picker.thisIsRepo': '这是一个 Git 仓库（{branch}）',
      'picker.thisIsRepoBare': '这是一个 Git 仓库',
      'picker.invalidPath': '路径不存在',
      'picker.notAbsolute': '请使用绝对路径',
      'picker.notDirectory': '这不是一个目录',
      'picker.notARepo': '这个目录不是 Git 仓库',
      'picker.useRoot': '使用仓库根：{root}',
      'picker.add': '添加',
      'picker.select': '选择此目录',
      'picker.needRepo': '先选择一个 Git 仓库',
      'picker.browse': '浏览文件夹',
      'picker.useThisDir': '使用当前目录',
      'picker.recent': '最近使用',
      'toolbar.refresh': '刷新',
      'toolbar.fetch': '抓取',
      'toolbar.fetchPartial': '已从其它远程抓取，但这些远程不可用：{names}',
      'toolbar.pull': '拉取',
      'toolbar.push': '推送',
      'toolbar.settings': '设置',
      'toolbar.more': '更多操作',
      'status.ahead': '领先 {n}',
      'status.behind': '落后 {n}',
      'status.synced': '已同步',
      'status.noUpstream': '无上游',
      'status.detached': '分离 HEAD',
      'status.clean': '工作区干净',
      'status.loading': '正在读取仓库…',
      'status.loadingSlow': '仍在读取：构建进行中或仓库较大时会更慢，可稍后重试',
      'changes.staged': '已暂存 ({n})',
      'changes.unstaged': '更改 ({n})',
      'changes.untracked': '未跟踪 ({n})',
      'changes.conflicted': '冲突 ({n})',
      'changes.empty': '没有未提交的变更',
      'changes.emptyHint': '工作区是干净的。改完文件后这里会自动刷新。',
      'error.timeout': '读取超时：这次改动可能太大，或请求被中断。重新点一次文件即可重试。',
      'hunk.label': '按块暂存',
      'hunk.stagedLabel': '已暂存的块',
      'hunk.stage': '暂存此块',
      'hunk.unstage': '取消暂存',
      'hunk.discard': '丢弃此块',
      'changes.emptyHintSync': '工作区是干净的，但这个分支和远程还没同步。',
      'toast.dismiss': '点击关闭',
      'changes.stage': '暂存',
      'changes.unstage': '取消暂存',
      'changes.discard': '放弃更改',
      'changes.stageAll': '全部暂存',
      'changes.unstageAll': '全部取消暂存',
      'changes.discardAll': '全部撤销',
      'changes.confirmDiscardAll': '撤销全部未提交的更改？已暂存和未暂存的修改都会被丢弃，未跟踪的文件会被删除（.gitignore 里忽略的构建产物会保留）。此操作无法撤销。',
      'changes.discardedAll': '已撤销全部更改',
      'changes.stageHunk': '暂存此块',
      'changes.unstageHunk': '取消暂存此块',
      'changes.discardHunk': '放弃此块',
      'changes.stageLines': '暂存选中行',
      'changes.selected': '已选 {n} 行',
      'changes.clearSelection': '清除选择',
      'changes.confirmDiscard': '放弃这些改动？此操作不可撤销。',
      'changes.confirmDiscardHunk': '放弃这一块的改动？此操作不可撤销。',
      'commit.placeholder': '提交信息（第一行是标题）',
      'commit.button': '提交',
      'commit.amend': '修正上次提交',
      'commit.amendHint': '勾选后提交将改写上一条提交',
      'commit.nothing': '没有可提交的内容',
      'commit.signoff': '添加 Sign-off',
      'diff.title': '差异',
      'diff.unified': '统一',
      'diff.resize': '拖动调整上方文件列表与下方 diff 的高度',
      'diff.close': '关闭 diff',
      'history.resize': '拖动调整提交列表与提交详情的高度',
      'diff.split': '并排',
      'diff.empty': '没有差异',
      'diff.binary': '二进制文件，无法显示差异',
      'diff.tooLarge': '差异过大，已截断',
      'diff.context': '上下文',
      'diff.loading': '正在读取差异…',
      'history.branch': '分支/标签',
      'history.all': '全部分支',
      'history.search': '搜索提交信息 / 哈希 / 作者',
      'history.empty': '没有匹配的提交',
      'history.loadMore': '加载更多',
      'history.noMore': '没有更多了',
      'history.details': '提交详情',
      'history.parents': '父提交',
      'history.author': '作者',
      'history.date': '日期',
      'history.files': '变更文件 ({n})',
      'history.copyHash': '复制哈希',
      'history.cherryPick': '优选到当前分支',
      'history.revert': '还原此提交',
      'history.resetTo': '重置到此提交…',
      'history.createBranch': '在此新建分支…',
      'history.createTag': '在此新建标签…',
      'history.checkout': '签出此提交',
      'history.compare': '与当前比较',
      'branches.head': 'HEAD（当前）',
      'branches.local': '本地分支',
      'branches.remote': '远程分支',
      'branches.tags': '标签',
      'branches.worktree': '已在另一工作区签出',
      'branches.new': '新建分支',
      'branches.rename': '重命名',
      'branches.delete': '删除',
      'branches.checkout': '签出',
      'branches.merge': '合并到当前分支',
      'branches.rebase': '将当前变基到此',
      'branches.setUpstream': '设为当前分支上游',
      'branches.publish': '发布到远程',
      'branches.deleteRemote': '删除远程分支',
      'branches.filter': '筛选分支或标签',
      'stash.title': '贮藏',
      'stash.empty': '没有贮藏记录',
      'stash.create': '贮藏当前更改',
      'stash.includeUntracked': '包含未跟踪文件',
      'stash.keepIndex': '保留暂存区',
      'stash.message': '贮藏说明（可选）',
      'stash.apply': '应用',
      'stash.pop': '弹出',
      'stash.drop': '删除',
      'stash.clear': '清空全部',
      'blame.title': '逐行追溯',
      'blame.pick': '在上方「变更」列表中选中一个文件后查看逐行追溯',
      'blame.loading': '正在计算…',
      'blame.empty': '没有可追溯的内容',
      'files.search': '搜索文件',
      'files.placeholderName': '按文件名搜索，例如 index 或 src/ui',
      'files.placeholderContent': '按文件内容搜索',
      'files.clear': '清空',
      'files.mode.name': '文件名',
      'files.mode.content': '内容',
      'files.searching': '正在搜索…',
      'files.noResults': '没有匹配的文件',
      'files.truncated': '结果过多，只显示前一批。请把关键字写得更具体。',
      'files.hintTitle': '搜索这个仓库里的文件',
      'files.hint': '输入关键字后，点某个文件即可查看它的修改历史；被重命名过的文件也会顺着旧名字一起追溯。',
      'files.pickFile': '从左边选一个文件，这里会列出它的每一次提交。',
      'files.openHistory': '查看文件历史',
      'files.noHistory': '这个文件还没有提交记录',
      'files.commitCount': '共 {n} 次提交',
      'files.diffInCommit': '这次提交对该文件的修改',
      'files.alsoChanged': '同一提交还改了 {n} 个文件',
      'files.binary': '二进制',
      'conflict.title': '存在未完成的 {op}',
      'conflict.files': '冲突文件 ({n})',
      'conflict.ours': '采用本地',
      'conflict.theirs': '采用远端',
      'conflict.markResolved': '标记为已解决',
      'conflict.continue': '继续',
      'conflict.abort': '中止',
      'dialog.cancel': '取消',
      'dialog.confirm': '确定',
      'dialog.branchName': '分支名',
      'dialog.tagName': '标签名',
      'dialog.tagMessage': '标签说明（留空为轻量标签）',
      'dialog.startPoint': '起点（留空为当前 HEAD）',
      'dialog.resetSoft': 'Soft：保留更改，移出暂存区',
      'dialog.resetMixed': 'Mixed：保留工作区更改',
      'dialog.resetHard': 'Hard：丢弃所有未提交更改',
      'dialog.resetHardWarn': 'Hard 重置将永久丢弃未提交的更改。',

      'dialog.deleteTitle': '删除分支 {name}',
      'dialog.forceDelete': '强制删除（未合并也删除）',
      'dialog.protectedWarn': '{name} 是受保护分支，删除需要额外确认。',
      'tag.revoke': '撤销标签',
      'tag.publish': '发布到远程',
      'tag.unpublished': '未发布',
      'tag.missingN': '缺 {n} 个远程',
      'tag.missingOn': '尚未推送到：{names}',
      'tag.published': '已推送标签 {name}',
      'tag.revokeTitle': '撤销标签 {name}',
      'tag.revokeRemote': '同时删除远程标签（已推送过的必须勾选）',
      'tag.revokeWarnBoth': '本地与远程的该标签都会被删除。提交本身不受影响，需要时可以重新打标签。',
      'tag.revokeWarnLocal': '只删除本地标签；远程已发布的保持不动，下次抓取可能又被拉回来。',
      'tag.revoked': '已撤销标签 {name}',
      'error.not-a-repo': '不是 Git 仓库',
      'error.git-missing': '找不到 git 命令',
      'error.argv-too-long': '文件太多，一条命令行放不下（Windows 上限约 32767 字符）。请改用「全部暂存 / 全部撤销」这类批量操作，或分批处理。',
      'error.git-spawn-failed': '无法启动 git：{message}',
      'error.git-timeout': 'git 命令超时',
      'error.local-changes-block': '有未提交的更改，请先提交或贮藏',
      'error.not-merged': '分支尚未合并，请使用强制删除',
      'error.protected-branch': '受保护分支需要额外确认',
      'error.confirm-required': '该操作需要确认',
      'error.push-rejected': '推送被拒绝：远程有新提交，请先抓取',
      'error.no-upstream': '当前分支没有上游，请先发布',
      'error.auth-failed': '认证失败',
      'error.not-fast-forward': '无法快进合并：本地与远程已分叉',
      'error.tag-not-found': '没有名为 {message} 的标签',
      'error.tag-ls-remote-failed': '无法读取远程标签：{message}',
      'error.tag-remote-delete-failed': '{message}',
      'error.patch-failed': '补丁应用失败，文件可能已变化，请刷新',
      'error.nested-repo': '该条目本身是一个 Git 仓库，请从终端处理',
      'error.outside-workspace': '该目录不在工作区内',
      'error.browse-failed': '无法列出该目录',
      'error.unknown': '操作失败：{message}',
    }

    const EN = {
      'title': 'Git Workbench',
      'description': 'SourceTree-grade GitCraft: branch tree / commit graph / hunk staging / merge & conflicts',
      'nav.changes': 'Changes',
      'nav.files': 'Files',
      'nav.history': 'History',
      'nav.branches': 'Branches',
      'nav.stash': 'Stash',
      'nav.blame': 'Blame',
      'repo.none': 'This workspace is not a Git repository',
      'repo.noneHint': 'Open a workspace that contains a repository, or create one here.',
      'repo.init': 'Initialize repository',
      'repo.switch': 'Switch repository',
      'repo.label': 'Repository',
      'repo.pick': 'Pick a repository to inspect',
      'repo.scanning': 'Scanning the workspace for repositories…',
      'repo.viewScan': 'Scan results',
      'repo.viewBrowse': 'Browse folders',
      'repo.workspaceRoot': 'workspace root',
      'repo.useThis': 'Use this folder',
      'repo.useParent': 'Use the repository root: {name}',
      'repo.isRepo': 'Git repo',
      'repo.noSubdirs': 'No subfolders here',
      'repo.truncated': 'Too many folders — the scan was truncated. Use “Browse folders” to drill in.',
      'repo.driveRoot': 'Drive…',
      'repo.typePath': 'Type a repository path (absolute)',
      'repo.typePathShort': 'Type path…',
      'repo.globalHint': 'Any repository on any drive — not limited to the workspace',
      'picker.tabPath': 'Path',
      'picker.tabBrowse': 'Browse',
      'picker.tabScan': 'Scan results',
      'picker.pathLabel': 'Working copy path',
      'picker.pathPlaceholder': 'C:\\Users\\me\\projects\\repo',
      'picker.typeLabel': 'Repository type',
      'picker.typeIdle': 'Type or paste a repository path',
      'picker.checking': 'Checking…',
      'picker.thisIsRepo': 'This is a Git repository ({branch})',
      'picker.thisIsRepoBare': 'This is a Git repository',
      'picker.invalidPath': 'That path does not exist',
      'picker.notAbsolute': 'Use an absolute path',
      'picker.notDirectory': 'That is not a directory',
      'picker.notARepo': 'That folder is not a Git repository',
      'picker.useRoot': 'Use the repository root: {root}',
      'picker.add': 'Add',
      'picker.select': 'Select this folder',
      'picker.needRepo': 'Pick a Git repository first',
      'picker.browse': 'Browse for a folder',
      'picker.useThisDir': 'Use this folder',
      'picker.recent': 'Recent',
      'toolbar.refresh': 'Refresh',
      'toolbar.fetch': 'Fetch',
      'toolbar.fetchPartial': 'Fetched, but these remotes were unreachable: {names}',
      'toolbar.pull': 'Pull',
      'toolbar.push': 'Push',
      'toolbar.settings': 'Settings',
      'toolbar.more': 'More actions',
      'status.ahead': '{n} ahead',
      'status.behind': '{n} behind',
      'status.synced': 'Up to date',
      'status.noUpstream': 'No upstream',
      'status.detached': 'Detached HEAD',
      'status.clean': 'Working tree clean',
      'status.loading': 'Reading repository…',
      'status.loadingSlow': 'Still reading - a running build or a large repository slows this down; try again later',
      'changes.staged': 'Staged ({n})',
      'changes.unstaged': 'Changes ({n})',
      'changes.untracked': 'Untracked ({n})',
      'changes.conflicted': 'Conflicts ({n})',
      'changes.empty': 'No uncommitted changes',
      'changes.emptyHint': 'The working tree is clean. This list refreshes by itself when files change.',
      'error.timeout': 'Timed out reading the diff. The change may be very large, or the request was interrupted. Click the file again to retry.',
      'hunk.label': 'Stage by hunk',
      'hunk.stagedLabel': 'Staged hunks',
      'hunk.stage': 'Stage hunk',
      'hunk.unstage': 'Unstage',
      'hunk.discard': 'Discard hunk',
      'changes.emptyHintSync': 'The tree is clean, but this branch is not in sync with its remote.',
      'toast.dismiss': 'Click to dismiss',
      'changes.stage': 'Stage',
      'changes.unstage': 'Unstage',
      'changes.discard': 'Discard',
      'changes.stageAll': 'Stage all',
      'changes.unstageAll': 'Unstage all',
      'changes.discardAll': 'Discard all',
      'changes.confirmDiscardAll': 'Discard every uncommitted change? Staged and unstaged edits are both thrown away and untracked files are deleted (build output matched by .gitignore is kept). This cannot be undone.',
      'changes.discardedAll': 'Discarded all changes',
      'changes.stageHunk': 'Stage hunk',
      'changes.unstageHunk': 'Unstage hunk',
      'changes.discardHunk': 'Discard hunk',
      'changes.stageLines': 'Stage selected lines',
      'changes.selected': '{n} lines selected',
      'changes.clearSelection': 'Clear selection',
      'changes.confirmDiscard': 'Discard these changes? This cannot be undone.',
      'changes.confirmDiscardHunk': 'Discard this hunk? This cannot be undone.',
      'commit.placeholder': 'Commit message (first line is the subject)',
      'commit.button': 'Commit',
      'commit.amend': 'Amend last commit',
      'commit.amendHint': 'Rewrites the previous commit',
      'commit.nothing': 'Nothing to commit',
      'commit.signoff': 'Add Sign-off',
      'diff.title': 'Diff',
      'diff.unified': 'Unified',
      'diff.resize': 'Drag to resize the file list and the diff',
      'diff.close': 'Close diff',
      'history.resize': 'Drag to resize the commit list and the detail',
      'diff.split': 'Split',
      'diff.empty': 'No diff',
      'diff.binary': 'Binary file — no diff to show',
      'diff.tooLarge': 'Diff truncated',
      'diff.context': 'Context',
      'diff.loading': 'Loading diff…',
      'history.branch': 'Branch/tag',
      'history.all': 'All branches',
      'history.search': 'Search message / hash / author',
      'history.empty': 'No matching commits',
      'history.loadMore': 'Load more',
      'history.noMore': 'No more commits',
      'history.details': 'Commit details',
      'history.parents': 'Parents',
      'history.author': 'Author',
      'history.date': 'Date',
      'history.files': 'Changed files ({n})',
      'history.copyHash': 'Copy hash',
      'history.cherryPick': 'Cherry-pick onto current branch',
      'history.revert': 'Revert this commit',
      'history.resetTo': 'Reset to this commit…',
      'history.createBranch': 'New branch here…',
      'history.createTag': 'New tag here…',
      'history.checkout': 'Check out this commit',
      'history.compare': 'Compare with working tree',
      'branches.head': 'HEAD (current)',
      'branches.local': 'Local',
      'branches.remote': 'Remote',
      'branches.tags': 'Tags',
      'branches.worktree': 'Checked out in another worktree',
      'branches.new': 'New branch',
      'branches.rename': 'Rename',
      'branches.delete': 'Delete',
      'branches.checkout': 'Check out',
      'branches.merge': 'Merge into current',
      'branches.rebase': 'Rebase current onto this',
      'branches.setUpstream': 'Set as upstream of current',
      'branches.publish': 'Publish to remote',
      'branches.deleteRemote': 'Delete remote branch',
      'branches.filter': 'Filter branches or tags',
      'stash.title': 'Stash',
      'stash.empty': 'No stash entries',
      'stash.create': 'Stash current changes',
      'stash.includeUntracked': 'Include untracked files',
      'stash.keepIndex': 'Keep the index',
      'stash.message': 'Stash message (optional)',
      'stash.apply': 'Apply',
      'stash.pop': 'Pop',
      'stash.drop': 'Drop',
      'stash.clear': 'Clear all',
      'blame.title': 'Blame',
      'blame.pick': 'Select a file in Changes to see its line-by-line history',
      'blame.loading': 'Computing…',
      'blame.empty': 'Nothing to blame',
      'files.search': 'Search files',
      'files.placeholderName': 'Search by file name, e.g. index or src/ui',
      'files.placeholderContent': 'Search inside file contents',
      'files.clear': 'Clear',
      'files.mode.name': 'Name',
      'files.mode.content': 'Content',
      'files.searching': 'Searching…',
      'files.noResults': 'No matching files',
      'files.truncated': 'Too many results — only the first batch is shown. Narrow the query.',
      'files.hintTitle': 'Find a file in this repository',
      'files.hint': 'Type to search, then pick a file to see every commit that touched it. Renames are followed back to the old name.',
      'files.pickFile': 'Pick a file on the left to list its commits here.',
      'files.openHistory': 'File history',
      'files.noHistory': 'This file has no commits yet',
      'files.commitCount': '{n} commits',
      'files.diffInCommit': 'What this commit changed in this file',
      'files.alsoChanged': '{n} other file(s) changed in the same commit',
      'files.binary': 'binary',
      'conflict.title': 'Unfinished {op} in progress',
      'conflict.files': 'Conflicted files ({n})',
      'conflict.ours': 'Take ours',
      'conflict.theirs': 'Take theirs',
      'conflict.markResolved': 'Mark resolved',
      'conflict.continue': 'Continue',
      'conflict.abort': 'Abort',
      'dialog.cancel': 'Cancel',
      'dialog.confirm': 'OK',
      'dialog.branchName': 'Branch name',
      'dialog.tagName': 'Tag name',
      'dialog.tagMessage': 'Tag message (empty = lightweight tag)',
      'dialog.startPoint': 'Start point (empty = HEAD)',
      'dialog.resetSoft': 'Soft: keep changes, move out of the index',
      'dialog.resetMixed': 'Mixed: keep working-tree changes',
      'dialog.resetHard': 'Hard: discard every uncommitted change',
      'dialog.resetHardWarn': 'A hard reset permanently discards uncommitted changes.',
      'dialog.deleteTitle': 'Delete branch {name}',
      'dialog.forceDelete': 'Force delete (even when unmerged)',
      'dialog.protectedWarn': '{name} is a protected branch; deleting it needs an extra confirmation.',
      'tag.revoke': 'Revoke tag',
      'tag.publish': 'Publish to remote',
      'tag.unpublished': 'not published',
      'tag.missingN': 'missing on {n} remote(s)',
      'tag.missingOn': 'Not pushed to: {names}',
      'tag.published': 'Published tag {name}',
      'tag.revokeTitle': 'Revoke tag {name}',
      'tag.revokeRemote': 'Also delete it on the remote (required if it was pushed)',
      'tag.revokeWarnBoth': 'The tag is removed locally and on the remote. Commits are untouched — you can tag again any time.',
      'tag.revokeWarnLocal': 'Only the local tag is removed; a published one stays, so the next fetch can bring it back.',
      'tag.revoked': 'Revoked tag {name}',
      'error.not-a-repo': 'Not a Git repository',
      'error.git-missing': 'git executable not found',
      'error.argv-too-long': 'Too many files for one command line (Windows caps it at ~32767 characters). Use a bulk action such as "Stage all" / "Discard all", or work in smaller batches.',
      'error.git-spawn-failed': 'Cannot start git: {message}',
      'error.git-timeout': 'git command timed out',
      'error.local-changes-block': 'Uncommitted changes — commit or stash first',
      'error.not-merged': 'Branch is not merged; use force delete',
      'error.protected-branch': 'Protected branch needs an extra confirmation',
      'error.confirm-required': 'This action requires confirmation',
      'error.push-rejected': 'Push rejected: the remote has new commits — fetch first',
      'error.no-upstream': 'No upstream for this branch — publish it first',
      'error.auth-failed': 'Authentication failed',
      'error.not-fast-forward': 'Cannot fast-forward: local and remote diverged',
      'error.tag-not-found': 'There is no tag named {message}',
      'error.tag-ls-remote-failed': 'Cannot read the remote tags: {message}',
      'error.tag-remote-delete-failed': '{message}',
      'error.patch-failed': 'Patch did not apply — refresh and retry',
      'error.nested-repo': 'That entry is itself a Git repository — handle it in a terminal',
      'error.outside-workspace': 'That folder is outside the workspace',
      'error.browse-failed': 'Cannot list that folder',
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

    /* ============================== api ============================== */

    class ApiError extends Error {
      constructor(code, message) {
        super(message)
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

    async function call(method, payload, signal) {
      let response
      try {
        response = await fetch(apiBase() + method, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
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
      } catch {
        throw new ApiError('bad-response', 'HTTP ' + response.status)
      }
      if (body !== null && body.ok === true) return body.data
      const code = body !== null && body.error !== undefined ? body.error.code : 'unknown'
      const message = body !== null && body.error !== undefined ? body.error.message : 'HTTP ' + response.status
      throw new ApiError(code, message)
    }

    /* ============================== icons ============================== */

    const ICONS = {
      changes: ['M13 2H4.5A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h7A1.5 1.5 0 0 0 13 12.5V2z', 'M5 5h6M5 8h6M5 11h3'],
      history: ['M8 4.5V8l2.5 1.5', 'M2.5 8a5.5 5.5 0 1 0 1.6-3.9', 'M2 2.5V5h2.5'],
      branches: ['M5 3.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z', 'M11 9.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z', 'M5 6.5v2a2 2 0 0 0 2 2h2.5', 'M5 3.5v1'],
      stash: ['M2.5 5.5h11l-1 7a1 1 0 0 1-1 .9H4.5a1 1 0 0 1-1-.9l-1-7z', 'M6 3.5V2h4v1.5'],
      blame: ['M2.5 3.5h11', 'M2.5 6.5h11', 'M2.5 9.5h7', 'M2.5 12.5h4'],
      refresh: ['M13.5 8a5.5 5.5 0 1 1-1.6-3.9', 'M13.5 2.5V5.5H10.5'],
      fetch: ['M8 2.5v7', 'M5 6.5L8 9.5l3-3', 'M2.5 12.5h11'],
      pull: ['M8 2.5v7', 'M5 6.5L8 9.5l3-3', 'M2.5 12.5h11'],
      push: ['M8 13.5v-7', 'M5 9.5L8 6.5l3 3', 'M2.5 2.5h11'],
      commit: ['M8 2.5v3', 'M8 10.5v3', 'M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z'],
      plus: ['M8 3v10', 'M3 8h10'],
      minus: ['M3 8h10'],
      undo: ['M3 8a5 5 0 1 0 5-5', 'M3 3v3h3'],
      trash: ['M3 4.5h10', 'M6 4.5V3h4v1.5', 'M4.5 4.5l.6 8.5h5.8l.6-8.5'],
      copy: ['M5.5 5.5h7v7h-7z', 'M10.5 5.5V3h-7v7h2'],
      more: ['M3.5 8h.01', 'M8 8h.01', 'M12.5 8h.01'],
      check: ['M3 8.5l3.5 3L13 5'],
      close: ['M4 4l8 8', 'M12 4l-8 8'],
      chevronRight: ['M6 3.5L10.5 8 6 12.5'],
      chevronDown: ['M3.5 6L8 10.5 12.5 6'],
      warning: ['M8 2.5l6 11H2l6-11z', 'M8 6.5v3.5', 'M8 11.5h.01'],
      merge: ['M5 3.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z', 'M5 9.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z', 'M5 6.5v3', 'M11 4.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z', 'M11 7.5v1a2 2 0 0 1-2 2H7'],
      filter: ['M2.5 4h11', 'M4.5 8h7', 'M6.5 12h3'],
      search: ['M7.2 12.4a5.2 5.2 0 1 0 0-10.4 5.2 5.2 0 0 0 0 10.4z', 'M11 11l3 3'],
      repo: ['M2 5.5A1.5 1.5 0 0 0 3.5 4h1.5l1 1.5H14V12H2z', 'M2 5.5h12'],
      folder: ['M2 4.5a1 1 0 0 0 1-1h3l1.5 1.5H14a1 1 0 0 0-1 1v5.5a1 1 0 0 0 1 1h-11a1 1 0 0 0-1-1z'],
      up: ['M8 12.5V3.5', 'M4.5 7L8 3.5l3.5 3.5'],
    }

    function Icon(props) {
      const size = props.size === undefined ? 14 : props.size
      const shape = ICONS[props.name] === undefined ? ICONS.commit : ICONS[props.name]
      return E('svg', {
        className: 'gwc-icon', width: size, height: size, viewBox: '0 0 16 16',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.4,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
      }, shape.map((d, index) => E('path', { key: index, d })))
    }

    /* ============================== helpers ============================== */

    function cx(...parts) {
      return parts.filter((entry) => typeof entry === 'string' && entry !== '').join(' ')
    }

    /* ---- repository selection memory ---- */

    function readStoredRepo() {
      try {
        const raw = window.localStorage.getItem(REF_KEY)
        if (raw === null || raw === '') return null
        const parsed = JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object') return null
        const repoPath = typeof parsed.path === 'string' ? parsed.path : null
        return repoPath === null || repoPath === '' ? null : repoPath
      } catch {
        return null
      }
    }

    function storeRepo(repoPath) {
      try {
        if (repoPath === null || repoPath === '') window.localStorage.removeItem(REF_KEY)
        else window.localStorage.setItem(REF_KEY, JSON.stringify({ path: repoPath, at: Date.now() }))
      } catch {
        void 0
      }
    }

    function relativeTime(ms, t) {
      if (ms === 0) return ''
      const delta = Date.now() - ms
      const minute = 60000
      const hour = 60 * minute
      const day = 24 * hour
      if (delta < minute) return 'now'
      if (delta < hour) return Math.floor(delta / minute) + 'm'
      if (delta < day) return Math.floor(delta / hour) + 'h'
      if (delta < 30 * day) return Math.floor(delta / day) + 'd'
      return new Date(ms).toLocaleDateString()
    }

    function formatDate(ms) {
      if (ms === 0) return ''
      try {
        return new Date(ms).toLocaleString()
      } catch {
        return ''
      }
    }

    function baseName(filePath) {
      const parts = String(filePath).split('/')
      return parts[parts.length - 1]
    }

    function dirName(filePath) {
      const parts = String(filePath).split('/')
      if (parts.length <= 1) return ''
      return parts.slice(0, -1).join('/')
    }

    /**
     * Parse a unified diff into renderable rows.
     *
     * File headers used to be dropped outright, on the assumption that "the caller
     * already knows the path". That holds for a one-file diff and breaks for a
     * whole-commit diff spanning many files: the reader saw a column of hunks with no
     * way to tell which file each belonged to. The name is now carried on every hunk
     * (and rendered as a section header when the diff spans more than one file).
     */
    function parsePatch(patchText) {
      const hunks = []
      let current = null
      let currentFile = ''
      let oldNo = 0
      let newNo = 0
      const lines = String(patchText).split('\n')
      for (const line of lines) {
        if (line.startsWith('diff --git ')) {
          const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
          currentFile = match === null ? '' : match[2]
          current = null
          continue
        }
        if (line.startsWith('+++ ')) {
          const plus = line.slice(4).trim()
          if (plus !== '' && plus !== '/dev/null') currentFile = plus.replace(/^b\//, '')
          continue
        }
        if (line.startsWith('--- ')) continue
        if (line.startsWith('@@')) {
          const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
          current = {
            header: line,
            rows: [],
            oldStart: match === null ? 0 : Number(match[1]),
            newStart: match === null ? 0 : Number(match[2]),
            index: hunks.length,
            file: currentFile,
          }
          hunks.push(current)
          oldNo = current.oldStart
          newNo = current.newStart
          continue
        }
        if (current === null) continue
        if (line === '') continue
        const marker = line[0]
        const text = line.slice(1)
        if (marker === '+') {
          current.rows.push({ kind: 'add', text, oldNo: null, newNo, bodyIndex: current.rows.length })
          newNo += 1
        } else if (marker === '-') {
          current.rows.push({ kind: 'del', text, oldNo, newNo: null, bodyIndex: current.rows.length })
          oldNo += 1
        } else if (marker === ' ') {
          current.rows.push({ kind: 'ctx', text, oldNo, newNo, bodyIndex: current.rows.length })
          oldNo += 1
          newNo += 1
        } else if (marker === '\\') {
          current.rows.push({ kind: 'meta', text: line, oldNo: null, newNo: null, bodyIndex: current.rows.length })
        }
      }
      return hunks
    }

    /* ============================== diff view ============================== */

    function diffRow(row, side, selection, hunkIndex, onToggle) {
      const key = hunkIndex + ':' + row.bodyIndex
      const selected = selection !== undefined && selection !== null && selection.has(key)
      const selectable = (row.kind === 'add' || row.kind === 'del') && typeof onToggle === 'function'
      const cls = cx(
        'gwc-row',
        row.kind === 'add' ? 'is-add' : row.kind === 'del' ? 'is-del' : row.kind === 'meta' ? 'is-meta' : '',
        selected ? 'is-selected' : '',
        selectable ? 'is-selectable' : '',
      )
      const gutters = side === 'both'
        ? [row.oldNo === null ? '' : row.oldNo, row.newNo === null ? '' : row.newNo]
        : [side === 'left' ? (row.oldNo === null ? '' : row.oldNo) : (row.newNo === null ? '' : row.newNo)]
      const sign = row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' '
      const children = []
      for (let i = 0; i < gutters.length; i += 1) {
        children.push(E('span', { key: 'g' + i, className: 'gwc-gutter' }, gutters[i]))
      }
      children.push(E('span', { key: 'sign', className: 'gwc-sign' }, sign))
      children.push(E('span', { key: 'text', className: 'gwc-text' }, row.text))
      return E('div', {
        key: side + row.bodyIndex,
        className: cls,
        title: selectable ? 'Space/click to select this line' : undefined,
        onClick: selectable
          ? (event) => {
            event.preventDefault()
            onToggle(key)
          }
          : undefined,
      }, children)
    }

    function DiffHunk(props) {
      const { hunk, mode, actions, selection, onToggle } = props
      const rows = hunk.rows
      const actionNode = actions === undefined || actions === null ? null : E('span', { className: 'gwc-hunkActions' }, actions(hunk))
      const head = E('div', { className: 'gwc-hunkHead' },
        E('span', { className: 'gwc-hunkTitle', title: hunk.header }, hunk.header),
        actionNode)
      if (mode === 'split') {
        const left = rows.filter((row) => row.kind !== 'add').map((row) => diffRow(row, 'left', selection, hunk.index, onToggle))
        const right = rows.filter((row) => row.kind !== 'del').map((row) => diffRow(row, 'right', selection, hunk.index, onToggle))
        return E('div', { className: 'gwc-hunk' },
          head,
          E('div', { className: 'gwc-split' },
            E('div', { className: 'gwc-splitCol' }, left),
            E('div', { className: 'gwc-splitCol' }, right)))
      }
      return E('div', { className: 'gwc-hunk' },
        head,
        E('div', { className: 'gwc-lines' }, rows.map((row) => diffRow(row, 'both', selection, hunk.index, onToggle))))
    }

    function DiffView(props) {
      const { patch, mode, t, loading, error, binary, hunkActions, selection, onToggle } = props
      const hunks = useMemo(() => parsePatch(patch === undefined || patch === null ? '' : patch), [patch])
      if (loading === true && (typeof patch !== 'string' || patch === '')) {
        return E('div', { className: 'gwc-empty' }, t('diff.loading'))
      }
      if (error !== undefined && error !== null) return E('div', { className: 'gwc-empty is-error' }, error)
      if (binary === true) return E('div', { className: 'gwc-empty' }, t('diff.binary'))
      if (hunks.length === 0) return E('div', { className: 'gwc-empty' }, t('diff.empty'))
  /* Section headers only when the diff really spans several files: a one-file diff
     already names the file in the pane header, and repeating it there is noise. */
  const filesInDiff = {}
  for (const hunk of hunks) filesInDiff[String(hunk.file === undefined || hunk.file === null ? '' : hunk.file)] = true
  const spansFiles = Object.keys(filesInDiff).length > 1
  return E('div', { className: 'gwc-diff' }, hunks.map((hunk, position) => {
    const previous = position === 0 ? null : hunks[position - 1]
    const showFile = spansFiles && (previous === null || previous.file !== hunk.file)
    return [
      showFile
        ? E('div', { key: 'file-' + hunk.index, className: 'gwc-fileHead', title: hunk.file }, hunk.file)
        : null,
      E(DiffHunk, {
        key: hunk.index,
        hunk,
        mode: mode === 'split' ? 'split' : 'unified',
        t,
        actions: hunkActions,
        selection,
        onToggle,
      }),
    ]
  }))
    }

    /* ============================== embeddable diff pane ============================== */

    /**
     * A diff surface another page can mount.
     *
     * Same contract as the files page's `panes.source`: the caller owns the
     * container, this page owns the React root inside it, and the caller steers
     * it through `commands.showDiff`. Nothing is imported across bundles — that
     * is what keeps this page installable on its own and keeps a crash here from
     * blanking the host.
     *
     * It reuses `DiffView` (the same renderer the in-page modal uses), so a diff
     * looks identical whether it is shown here or in the GitCraft tab. The only
     * thing this pane does not do is hunk-level staging: the host's tree already
     * offers stage/discard per file, and two different staging surfaces in one
     * screen is exactly the "second copy of the list" problem this design avoids.
     */
    function mountDiffPane(container, api, ctx, t, scope) {
      const noop = { dispose: () => {}, handle: { showDiff() {} } }
      if (container === null || container === undefined) return noop
      /* Both entry points, like the dock: `react-dom/client` is the React 18
         name, the legacy one is still offered on some builds. */
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
        container.textContent = t('status.loading')
        return { dispose: () => { container.textContent = '' }, handle: noop.handle }
      }

      const root = client.createRoot(container)
      const initialMode = api !== null && api !== undefined && api.diffMode === 'split' ? 'split' : 'unified'
      const runtime = { showDiff: null, pending: null, setMode: null, pendingMode: null }
      /**
       * A call that arrives before this pane's React tree has installed
       * `runtime.showDiff` must NOT be dropped.
       *
       * That is exactly what happens on the first click in a host page: the click
       * both selects the file and mounts this pane, and the install effect runs a
       * frame later. Dropping the call left the pane showing its empty state with
       * no error anywhere — reported by the user as "clicking a change does
       * nothing". Buffer the latest request (latest wins, not a queue: only the
       * most recent selection is worth showing) and replay it on install.
       */
      const handle = {
        /**
         * `showDiff(path, options)`.
         *
         * `options.base` picks what the patch is against — `'worktree'` (the
         * default), `'staged'`, or `'commit'` with `options.rev`.
         *
         * `options.whole === true` means "everything this commit touched": the
         * request carries no path filter at all. A host that shows a commit's
         * patch needs that — narrowing to one file first makes the reader click
         * before seeing anything.
         *
         * `setMode('unified' | 'split')` switches the layout; the reader decides,
         * not the pane.
         */
        showDiff: (path, options) => {
          if (runtime.showDiff !== null) { runtime.showDiff(path, options); return }
          runtime.pending = { path, options }
        },
        setMode: (mode) => {
          if (runtime.setMode !== null) { runtime.setMode(mode); return }
          runtime.pendingMode = mode
        },
      }

      function PaneHost() {
        /* Bumped by showDiff(force) so the fetch effect re-runs for the SAME target. */
        const [reloadNonce, setReloadNonce] = useState(0)
        /* Set when showDiff hydrated from the pane cache; the fetch effect must
         skip exactly that state update or the point of the cache is lost. */
        const cacheHitKeyRef = useRef('')
        const [state, setState] = useState({ path: null, base: 'worktree', rev: null, whole: false, mode: initialMode, patch: '', hunks: [], loading: false, error: null, binary: false })

        useEffect(() => {
          runtime.setMode = (mode) => {
            const next = mode === 'split' ? 'split' : 'unified'
            setState((previous) => (previous.mode === next ? previous : Object.assign({}, previous, { mode: next })))
          }
          if (runtime.pendingMode !== null) {
            const buffered = runtime.pendingMode
            runtime.pendingMode = null
            runtime.setMode(buffered)
          }
          return () => { runtime.setMode = null }
        }, [])

        useEffect(() => {
          runtime.showDiff = (path, options) => {
            const target = typeof path === 'string' ? path.replace(/\\/g, '/').replace(/^\/+/, '') : ''
            const base = options !== null && options !== undefined
              && (options.base === 'staged' || options.base === 'commit' || options.base === 'untracked') ? options.base : 'worktree'
            const rev = options !== null && options !== undefined && typeof options.rev === 'string' && options.rev !== ''
              ? options.rev
              : null
            /* Only a commit can be shown whole: `git show <rev>` with no pathspec
               is a meaningful request, while "the whole worktree" is not. */
            const whole = base === 'commit' && options !== null && options !== undefined && options.whole === true
            if (target === '' && whole !== true) {
              setState((previous) => ({ path: null, base: 'worktree', rev: null, whole: false, mode: previous.mode, patch: '', hunks: [], loading: false, error: null, binary: false }))
              return
            }
            /* IDEMPOTENT: showing the same target again must not reset the state.
               The host legitimately calls this more than once (buffered on mount,
               then re-pushed), and a blind reset threw away an already-fetched
               patch and put the pane back on "正在读取差异…". `base`, `rev` and
               `whole` are part of the identity: the same file against the index
               instead of the worktree IS a different patch. */
            /* A WRITE invalidates the patch even though the target did not change:
               after staging or discarding a hunk the same file/base still answers, but
               the content is different; force is how the host says so. */
            const force = options !== null && options !== undefined && options.force === true
            if (force === true) cacheHitKeyRef.current = ''
            const cacheRoot = scope !== null && scope !== undefined && typeof scope.repoRoot === 'string' ? scope.repoRoot : ''
            const cacheKey = paneDiffKey(cacheRoot, base, rev, target, whole)
            const cacheTtl = base === 'commit' ? PANE_DIFF_COMMIT_TTL_MS : PANE_DIFF_WORKTREE_TTL_MS
            const cached = force === true ? null : readPaneDiff(cacheKey, cacheTtl)
            if (cached !== null) cacheHitKeyRef.current = cacheKey
            setState((previous) => {
              if (force !== true
                && previous.path === target && previous.base === base && previous.rev === rev && previous.whole === whole
                && previous.loading !== true && previous.error === null) return previous
              if (cached !== null) {
                return {
                  path: target, base, rev, whole, mode: previous.mode,
                  patch: cached.patch, hunks: cached.hunks,
                  loading: false, error: null, binary: cached.binary === true,
                }
              }
              return {
                path: target, base, rev, whole, mode: previous.mode,
                patch: force === true ? previous.patch : '',
                hunks: force === true ? previous.hunks : [],
                loading: force === true ? previous.loading : true,
                error: null,
                binary: false,
              }
            })
            if (force === true) setReloadNonce((value) => value + 1)
          }
          /* Replay whatever the host asked for before we were ready. */
          if (runtime.pending !== null) {
            const buffered = runtime.pending
            runtime.pending = null
            runtime.showDiff(buffered.path, buffered.options)
          }
          return () => { runtime.showDiff = null }
        }, [])

        /* No `activeRel` seeding: the pane contract is "mount with context, steer
           with commands". A path captured at mount time is whatever the user had
           selected THEN, which is usually nothing. The shell calls showDiff as
           soon as a file is picked. */

        /* Fetch the patch for the current path. `base` matters: a staged change
           must be diffed against the index, an unstaged one against the
           worktree, or the user sees the wrong side of their own edit. */
        const repoRoot = scope !== null && scope !== undefined && typeof scope.repoRoot === 'string'
          ? scope.repoRoot
          : ''
        /* The request effect reads the path from STATE, not from a captured const:
           `showDiff` may be replayed (buffered on mount, retried by the host), and
           a captured path would be the stale one, causing every response to be
           thrown away by the "still the same path?" guard below — the pane then
           sits on "正在读取差异…" forever even though the patch arrived. */
        const pathForRequest = state.path
        const baseForRequest = state.base
        const revForRequest = state.rev
        const wholeForRequest = state.whole === true
        const requestCacheKey = paneDiffKey(repoRoot, baseForRequest, revForRequest, pathForRequest, wholeForRequest)
        useEffect(() => {
          if (pathForRequest === null) return undefined
          if (cacheHitKeyRef.current === requestCacheKey) {
            cacheHitKeyRef.current = ''
            return undefined
          }
          let cancelled = false
          /* whole sends no pathspec at all: that is what makes it the whole commit. */
          const payload = { base: baseForRequest }
          if (pathForRequest !== '') payload.path = pathForRequest
          if (baseForRequest === 'commit' && revForRequest !== null) payload.rev = revForRequest
          /* The git host refuses a request with no root at all ("cwd, repoRoot,
             dir or sessionId is required"), and that refusal is what an empty
             pane shows instead of a patch. Only add the key when it is real. */
          if (repoRoot !== '') payload.repoRoot = repoRoot
          /* An untracked file has no diff against HEAD - git diff prints nothing.
             The host has a dedicated method that renders it as an all-added patch. */
          call(baseForRequest === 'untracked' ? 'untrackedDiff' : 'diff', payload).then((data) => {
            const patch = data !== null && data !== undefined && typeof data.patch === 'string' ? data.patch : ''
            const hunks = data !== null && data !== undefined && Array.isArray(data.hunks) ? data.hunks : []
            const binary = data !== null && data !== undefined && data.binary === true
            /* Cache even when this pane was unmounted mid-request: switching away
               and back must not throw away a patch that already arrived. */
            rememberPaneDiff(requestCacheKey, { patch, hunks, binary })
            if (cancelled) return
            setState((previous) => (previous.path !== pathForRequest
              || previous.base !== baseForRequest
              || previous.rev !== revForRequest ? previous : {
              path: pathForRequest,
              base: baseForRequest,
              rev: revForRequest,
              patch,
              hunks,
              loading: false,
              error: null,
              binary,
            }))
          }).catch((error) => {
            if (cancelled) return
            setState((previous) => (previous.path !== pathForRequest
              || previous.base !== baseForRequest
              || previous.rev !== revForRequest ? previous : {
              path: pathForRequest,
              base: baseForRequest,
              rev: revForRequest,
              patch: '',
              hunks: [],
              loading: false,
              error: error !== null && error !== undefined && typeof error.message === 'string' ? error.message : t('error.unknown'),
              binary: false,
            }))
          })
          return () => { cancelled = true }
        }, [pathForRequest, baseForRequest, revForRequest, wholeForRequest, requestCacheKey, t, repoRoot, reloadNonce])
        /**
         * A request that never settles must not spin forever.
         *
         * The host can be slow on a huge patch, and a request can be dropped when a
         * pane is rebuilt mid-flight. Either way the reader sees "正在读取差异…"
         * with no way out. After this budget the pane says so and stops pretending
         * to be busy; the retry is one click away (re-select the file).
         */
        useEffect(() => {
          if (state.loading !== true) return undefined
          const timer = setTimeout(() => {
            setState((previous) => (previous.loading === true
              ? Object.assign({}, previous, { loading: false, error: t('error.timeout') })
              : previous))
          }, 25000)
          return () => { clearTimeout(timer) }
        }, [state.loading, state.path, state.base, state.rev, t])

        /**
         * Per-hunk actions, rendered INLINE on each hunk header.
         *
         * They used to be a chip row pinned above the patch, which meant deciding
         * "stage this hunk?" while looking at a list of hunk HEADERS instead of the
         * hunk itself — you had to scroll down, read, scroll back up, and hope you
         * remembered which chip belonged to what. On the hunk header the buttons sit
         * exactly next to the lines they act on.
         *
         * The pane does not know whether writing is allowed (a read-only install must
         * not show a stage button) and must not decide which RPC to call — that is the
         * host's job. It reports `onHunkAction(ref)` and lets the host do the write.
         */
        const hunkBar = null

        /**
         * Per-hunk buttons for a HOST that drives this pane through
         * `api.onHunkAction` — the workbench page does exactly that.
         *
         * They render ON the hunk header, next to the lines they act on. The pane still
         * does not decide which RPC runs: it reports `onHunkAction(ref)` and the host
         * performs the write. A read-only install passes no callback and the buttons
         * never appear.
         */
        const apiHunkActions = (hunk) => {
          const onHunkAction = api === null || api === undefined ? undefined : api.onHunkAction
          if (typeof onHunkAction !== 'function') return null
          /* A commit's patch is history: it cannot be staged or discarded. */
          if (state.base === 'commit' || state.base === 'untracked') return null
          if (state.path === null) return null
          const staged = state.base === 'staged'
          return E(Fragment, null,
            E('button', {
              type: 'button',
              className: 'gwc-hunkBtn',
              onClick: () => onHunkAction({ path: state.path, hunkIndex: hunk.index, action: staged ? 'unstageHunk' : 'stageHunk' }),
            }, staged ? t('hunk.unstage') : t('hunk.stage')),
            /* Discarding a STAGED hunk is not offered: unstage then discard is the same
               result with one explicit step in between, and a one-click path to
               destroying work is what this design avoids. */
            staged
              ? null
              : E('button', {
                type: 'button',
                className: 'gwc-hunkBtn is-danger',
                onClick: () => onHunkAction({ path: state.path, hunkIndex: hunk.index, action: 'discardHunk' }),
              }, t('hunk.discard')))
        }

        return E('div', {
          className: 'gwc-diffPane',
          /* Observability: which side of the change this pane is showing, and how
             many hunks it parsed. Three bugs so far were "the pane shows the wrong
             patch / no hunk buttons" with nothing to distinguish the causes. */
          'data-base': state.base,
          'data-mode': state.mode,
          'data-hunks': String(Array.isArray(state.hunks) ? state.hunks.length : 0),
          'data-can-hunk': typeof (api === null || api === undefined ? undefined : api.onHunkAction) === 'function' ? '1' : '0',
          style: { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: '0', height: '100%', overflow: 'auto' },
        }, hunkBar, state.path === null
          ? E('div', { className: 'gwc-empty' }, t('changes.emptyHint'))
          : E(DiffView, {
            patch: state.patch,
            mode: state.mode,
            t,
            loading: state.loading,
            error: state.error,
            binary: state.binary,
            hunkActions: apiHunkActions,
          }))
      }

      root.render(React.createElement(PaneHost))

      return {
        handle,
        dispose: () => {
          runtime.showDiff = null
          try { root.unmount() } catch (error) { void error }
        },
      }
    }


    /* ============================== graph ============================== */

    /**
     * Assign lane columns to a linear-history-first pass: every commit takes the
     * lane of its first parent when that parent is already scheduled, otherwise
     * the first free lane. Good enough for the common shapes (linear + a few
     * merge bubbles) without laying out the whole DAG.
     */
    function layoutGraph(commits) {
      const laneOf = new Map()
      const lanes = []
      let maxLane = 0
      for (const commit of commits) {
        let lane = laneOf.has(commit.hash) ? laneOf.get(commit.hash) : -1
        if (lane < 0) {
          lane = 0
          while (lanes[lane] === true) lane += 1
        }
        laneOf.set(commit.hash, lane)
        lanes[lane] = true
        maxLane = Math.max(maxLane, lane)
        const parents = commit.parents
        for (let i = 0; i < parents.length; i += 1) {
          if (!laneOf.has(parents[i])) laneOf.set(parents[i], i === 0 ? lane : lane + i)
        }
        // Free the lanes of parents already emitted so unrelated branches reuse them.
        for (const parent of parents) {
          const parentLane = laneOf.get(parent)
          if (parentLane !== undefined && parentLane !== lane && commits.some((entry) => entry.hash === parent) === false) {
            lanes[parentLane] = false
          }
        }
      }
      return { laneOf, maxLane: Math.min(maxLane, GRAPH_MAX_LANES) }
    }

    function GraphCell(props) {
      const { commit, lane, maxLane, isMerge } = props
      const width = (maxLane + 1) * LANE_WIDTH
      const color = LANE_COLORS[lane % LANE_COLORS.length]
      const parts = []
      const x = lane * LANE_WIDTH + LANE_WIDTH / 2
      for (let i = 0; i < commit.parents.length; i += 1) {
        parts.push(E('line', {
          key: 'p' + i,
          x1: x, y1: 11, x2: x, y2: 22,
          stroke: LANE_COLORS[(lane + i) % LANE_COLORS.length],
          strokeWidth: 1.4, strokeOpacity: 0.7,
        }))
      }
      return E('svg', { className: 'gwc-graph', width, height: 22, 'aria-hidden': 'true' },
        parts,
        E('circle', {
          cx: x, cy: 11, r: isMerge ? 4.4 : 3.4,
          fill: isMerge ? 'var(--dsw-alias-bg-layer-1, #1b1d22)' : color,
          stroke: color, strokeWidth: 1.5,
        }))
    }

    /* ============================== small UI ============================== */

    function IconButton(props) {
      const { name, label, onClick, active, disabled, danger, size } = props
      /* `dot` is a passive notification: a red dot in the top-right corner, no
         number. It marks "there is something to do here" (remote has commits we
         do not / we have commits the remote does not). It must NOT change the
         button's 24px box — an inline badge would grow the header row the way a
         wider entry once shifted the whole sidebar (see packages/dock README §4),
         so it is absolutely positioned inside the existing box instead. */
      const dot = props.dot === true
      return E('button', {
        type: 'button',
        className: cx('gwc-iconBtn', active === true ? 'is-active' : '', danger === true ? 'is-danger' : '', dot ? 'has-dot' : ''),
        title: label,
        'aria-label': dot ? label + ' •' : label,
        disabled: disabled === true,
        onClick,
      }, E(Icon, { name, size: size === undefined ? 14 : size }),
      dot ? E('span', { className: 'gwc-dot', 'aria-hidden': 'true' }) : null)
    }

    function TextButton(props) {
      const { children, onClick, primary, disabled, danger, title } = props
      return E('button', {
        type: 'button',
        className: cx('gwc-btn', primary === true ? 'is-primary' : '', danger === true ? 'is-danger' : ''),
        disabled: disabled === true,
        title,
        onClick,
      }, children)
    }

    function Modal(props) {
      const { title, children, onClose, footer, t, wide } = props
      useEffect(() => {
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          /* Capture + stopPropagation: the dock also listens for Esc on window
             (registered earlier). Without this one Esc closed both the diff and
             the whole workbench. */
          event.stopPropagation()
          event.preventDefault()
          onClose()
        }
        window.addEventListener('keydown', onKey, true)
        return () => window.removeEventListener('keydown', onKey, true)
      }, [onClose])
      return E('div', { className: 'gwc-modalBackdrop', role: 'presentation', onMouseDown: (event) => {
        if (event.target === event.currentTarget) onClose()
      } },
      E('div', { className: 'gwc-modal' + (wide === true ? ' is-wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        E('div', { className: 'gwc-modalHead' },
          E('span', { className: 'gwc-modalTitle' }, title),
          E(IconButton, { name: 'close', label: t('dialog.cancel'), onClick: onClose })),
        E('div', { className: 'gwc-modalBody' }, children),
        footer === undefined ? null : E('div', { className: 'gwc-modalFoot' }, footer)))
    }

    function Field(props) {
      const { label, value, onChange, placeholder, multiline, autoFocus } = props
      const common = {
        className: 'gwc-input',
        value: value === undefined ? '' : value,
        placeholder,
        autoFocus: autoFocus === true,
        onChange: (event) => onChange(event.target.value),
      }
      return E('label', { className: 'gwc-field' },
        E('span', { className: 'gwc-fieldLabel' }, label),
        multiline === true
          ? E('textarea', Object.assign({ rows: 3 }, common))
          : E('input', Object.assign({ type: 'text' }, common)))
    }

    function Checkbox(props) {
      const { label, checked, onChange, hint } = props
      return E('label', { className: 'gwc-check' },
        E('input', { type: 'checkbox', checked: checked === true, onChange: (event) => onChange(event.target.checked) }),
        E('span', null, label),
        hint === undefined ? null : E('span', { className: 'gwc-checkHint' }, hint))
    }

    /* ============================== repo picker ============================== */

    /**
     * Workspace repository picker. Two panes over one state machine:
     *
     *  - SCAN: the host walked the workspace and found every repository in it
     *    (`workspace` method), listed by their workspace-relative path;
     *  - BROWSE: one level of directories at a time (`browse` method), so a
     *    workspace that is too big or too deep to scan is still navigable.
     *
     * Both panes are read-only; choosing an entry sets the panel's repository
     * and is remembered per browser.
     */
    /**
     * Repository picker, modelled on SourceTree's "Add Working Copy" dialog.
     *
     * SourceTree's shape (verified against Atlassian's own screenshot):
     *   Working Copy Path  [________________________] [...]
     *   Repository Type      ◆ This is a Git repository      ← live, as you type
     *   [x] Bookmark this repository
     *   Name  [__________]   Folder [Root v]
     *                             [ Add ]  [ Cancel ]
     *
     * The two things that make it usable — and that our earlier tree-only picker
     * lacked — are (a) a PATH FIELD you can paste or type into, and (b) LIVE
     * VALIDATION that names what the path is before you commit to it. The folder
     * list below the field is a convenience for people who would rather click.
     */
    function RepoPicker(props) {
      const { t, scope, current, onPick, onClose, onInit } = props
      const [view, setView] = useState('path')
      const [typed, setTyped] = useState(current === null || current === undefined ? '' : String(current))
      const [check, setCheck] = useState({ state: 'idle', info: null })
      const [scan, setScan] = useState({ loading: true, repos: [], workspace: null, truncated: false, error: null })
      const [dir, setDir] = useState(null)
      const [listing, setListing] = useState({ loading: false, dirs: [], parent: null, drives: [], isRepo: false, insideRepo: null, error: null })
      const [recent, setRecent] = useState(() => readRecentRepos())
      const browseSeq = useRef(0)
      const checkSeq = useRef(0)

      /* The payload base: a session seat sends cwd; the global dock sends nothing
         and the host falls back to the repository / the first drive root. */
      const basePayload = useCallback(() => {
        if (scope !== undefined && scope !== null && typeof scope.cwd === 'string' && scope.cwd !== '') return { cwd: scope.cwd }
        if (scope !== undefined && scope !== null && typeof scope.repoRoot === 'string' && scope.repoRoot !== '') return { repoRoot: scope.repoRoot }
        return {}
      }, [scope])

      /* Live validation, exactly like SourceTree's "Repository Type" row. */
      const verify = useCallback((value) => {
        const path = typeof value === 'string' ? value.trim() : ''
        if (path === '') {
          setCheck({ state: 'idle', info: null })
          return
        }
        checkSeq.current += 1
        const seq = checkSeq.current
        setCheck({ state: 'checking', info: null })
        call('verifyPath', { path })
          .then((info) => {
            if (seq !== checkSeq.current) return
            setCheck({ state: 'done', info })
          })
          .catch(() => {
            if (seq !== checkSeq.current) return
            setCheck({ state: 'done', info: { exists: false, isRepo: false, kind: 'error' } })
          })
      }, [])

      /* Debounced on typing: one check per pause, not per keystroke. */
      useEffect(() => {
        const timer = setTimeout(() => verify(typed), 320)
        return () => clearTimeout(timer)
      }, [typed, verify])

      useEffect(() => {
        let cancelled = false
        call('workspace', basePayload())
          .then((data) => {
            if (cancelled) return
            setScan({ loading: false, repos: data.repos, workspace: data.workspace, truncated: data.truncated, error: null })
          })
          .catch((error) => {
            if (cancelled) return
            setScan({ loading: false, repos: [], workspace: null, truncated: false, error: describeApiError(t, error) })
          })
        return () => { cancelled = true }
      }, [basePayload, t])

      const browseTo = useCallback((target) => {
        browseSeq.current += 1
        const seq = browseSeq.current
        setListing((previous) => ({ ...previous, loading: true, error: null }))
        call('browse', target === null || target === undefined ? basePayload() : { ...basePayload(), dir: target })
          .then((data) => {
            if (seq !== browseSeq.current) return
            setDir(data.dir)
            setListing({ loading: false, dirs: data.dirs, parent: data.parent, drives: data.drives === undefined ? [] : data.drives, isRepo: data.isRepo, insideRepo: data.insideRepo, error: null })
          })
          .catch((error) => {
            if (seq !== browseSeq.current) return
            setListing((previous) => ({ ...previous, loading: false, error: describeApiError(t, error) }))
          })
      }, [basePayload, t])

      useEffect(() => {
        if (view === 'browse' && dir === null) browseTo(null)
      }, [view, dir, browseTo])

      const choose = useCallback((repoPath) => {
        rememberRecentRepo(repoPath)
        onPick(repoPath)
        onClose()
      }, [onPick, onClose])

      /* --- the "Repository Type" verdict --------------------------------- */
      const verdict = useMemo(() => {
        if (check.state === 'idle') return { tone: 'idle', text: t('picker.typeIdle') }
        if (check.state === 'checking') return { tone: 'idle', text: t('picker.checking') }
        const info = check.info
        if (info === null) return { tone: 'idle', text: t('picker.typeIdle') }
        if (info.kind === 'not-absolute') return { tone: 'bad', text: t('picker.notAbsolute') }
        if (info.kind === 'missing') return { tone: 'bad', text: t('picker.invalidPath') }
        if (info.kind === 'not-directory') return { tone: 'bad', text: t('picker.notDirectory') }
        if (info.kind === 'not-a-repo') return { tone: 'bad', text: t('picker.notARepo') }
        if (info.kind === 'repo') {
          const suffix = info.isTop === true ? '' : ' · ' + t('picker.useRoot', { root: info.root })
          /* `branch` is no longer fetched by verifyPath (one git spawn, not three). */
          const label = typeof info.branch === 'string' && info.branch !== ''
            ? t('picker.thisIsRepo', { branch: info.detached === true ? 'detached' : info.branch })
            : t('picker.thisIsRepoBare')
          return { tone: 'good', text: label + suffix }
        }
        return { tone: 'idle', text: t('picker.typeIdle') }
      }, [check, t])

      /* Do not require `state === 'done'`: a fresh verify can be in flight while the
         previously resolved repository is still valid, and demanding 'done' made the
         Add button randomly disabled — the verdict said "this is a Git repository"
         while Add refused to be pressed. */
      const canAdd = check.info !== null && check.info !== undefined && check.info.isRepo === true
      const targetPath = useMemo(() => {
        if (check.info === null) return typed.trim()
        if (check.info.isRepo === true && typeof check.info.root === 'string') return check.info.root
        return typed.trim()
      }, [check.info, typed])

      /* --- rows ---------------------------------------------------------- */
      const rowBase = 'gwc-lib-row'

      /* ---- pane 1: a path field with live validation (SourceTree's shape) ---- */
      const pathPane = E('div', { className: 'gwc-lib-pane' },
        E('label', { className: 'gwc-lib-field' },
          E('span', { className: 'gwc-lib-label' }, t('picker.pathLabel')),
          E('div', { className: 'gwc-lib-inputRow' },
            E('input', {
              className: 'gwc-lib-input',
              type: 'text',
              value: typed,
              spellCheck: false,
              placeholder: t('picker.pathPlaceholder'),
              onChange: (event) => setTyped(event.target.value),
              onKeyDown: (event) => { if (event.key === 'Enter' && canAdd) choose(targetPath) },
              autoFocus: true,
            }),
            E('button', {
              type: 'button',
              className: 'gwc-lib-browseBtn',
              title: t('picker.browse'),
              onClick: () => setView('browse'),
            }, '\u2026')
          )
        ),
        E('div', { className: 'gwc-lib-field' },
          E('span', { className: 'gwc-lib-label' }, t('picker.typeLabel')),
          E('div', { className: 'gwc-lib-verdict is-' + verdict.tone },
            E('span', { className: 'gwc-lib-verdictDot' }),
            E('span', null, verdict.text)
          )
        ),
        recent.length === 0 ? null : E('div', { className: 'gwc-lib-field' },
          E('span', { className: 'gwc-lib-label' }, t('picker.recent')),
          E('div', { className: 'gwc-lib-recent' },
            recent.map((entry) => E('button', {
              key: entry,
              type: 'button',
              className: rowBase,
              title: entry,
              onClick: () => setTyped(entry),
            },
              E(Icon, { name: 'repo', size: 12 }),
              E('span', { className: 'gwc-lib-rowName' }, baseName(entry.split('\\\\').join('/'))),
              E('span', { className: 'gwc-lib-rowPath' }, entry)
            ))
          )
        )
      )

      /* ---- pane 2: a folder browser with real drive roots ---- */
      const driveStrip = listing.drives.length === 0 ? null : E('div', { className: 'gwc-lib-drives' },
        listing.drives.map((drive) => E('button', {
          key: drive,
          type: 'button',
          className: 'gwc-lib-drive' + (isSameDrive(dir, drive) ? ' is-active' : ''),
          onClick: () => browseTo(drive),
        }, driveLabel(drive)))
      )

      const folderRows = listing.loading === true
        ? E('div', { className: 'gwc-empty' }, t('status.loading'))
        : listing.error !== null
          ? E('div', { className: 'gwc-empty is-error' }, listing.error)
          : folderListRows(t, listing, rowBase, browseTo, choose, dir)

      const browsePane = E('div', { className: 'gwc-lib-pane' },
        E('div', { className: 'gwc-lib-inputRow' },
          E('input', {
            className: 'gwc-lib-input',
            type: 'text',
            value: dir === null ? '' : dir,
            spellCheck: false,
            readOnly: true,
            title: dir === null ? '' : dir,
          }),
          E('button', {
            type: 'button',
            className: 'gwc-lib-browseBtn is-text',
            title: t('picker.useThisDir'),
            disabled: listing.isRepo !== true,
            onClick: () => { if (listing.isRepo === true) choose(dir) },
          }, t('picker.select'))
        ),
        driveStrip,
        E('div', { className: 'gwc-lib-list' }, folderRows)
      )

      /* ---- pane 3: repositories found by scanning the workspace ---- */
      const scanRows = scan.loading === true
        ? E('div', { className: 'gwc-empty' }, t('repo.scanning'))
        : scan.error !== null
          ? E('div', { className: 'gwc-empty is-error' }, scan.error)
          : scan.repos.length === 0
            ? E('div', { className: 'gwc-empty' },
              E('div', null, t('repo.none')),
              E('div', { className: 'gwc-emptyHint' }, t('repo.noneHint'))
            )
            : scan.repos.map((entry) => E('button', {
              key: entry.path,
              type: 'button',
              className: rowBase + (current === entry.path ? ' is-current' : ''),
              title: entry.path,
              onClick: () => choose(entry.path),
            },
              E(Icon, { name: 'repo', size: 12 }),
              E('span', { className: 'gwc-lib-rowName' }, entry.relative === '.' ? entry.name : entry.relative),
              E('span', { className: 'gwc-lib-rowBadge' }, entry.detached === true ? t('status.detached') : entry.branch),
              entry.headShort === null ? null : E('span', { className: 'gwc-lib-rowHash' }, entry.headShort)
            ))

      const scanPane = E('div', { className: 'gwc-lib-pane' },
        E('div', { className: 'gwc-lib-hint' }, t('repo.globalHint')),
        E('div', { className: 'gwc-lib-list' }, scanRows),
        scan.truncated === true ? E('div', { className: 'gwc-pickerNote' }, t('repo.truncated')) : null
      )

      return E(Modal, {
        t,
        title: t('repo.pick'),
        onClose,
        footer: E(Fragment, null,
          E('span', { className: 'gwc-pickerFoot' },
            E(TextButton, { onClick: onInit }, t('repo.init'))),
          E('span', { className: 'gwc-lib-footerRight' },
            E(TextButton, { onClick: onClose }, t('dialog.cancel')),
            E(TextButton, {
              primary: true,
              disabled: canAdd !== true,
              title: canAdd === true ? targetPath : t('picker.needRepo'),
              onClick: () => { if (canAdd === true) choose(targetPath) },
            }, t('picker.add')))),
      },
      E('div', { className: 'gwc-picker' },
        E('div', { className: 'gwc-pickerTabs' },
          E('button', {
            type: 'button',
            className: cx('gwc-pickerTab', view === 'path' ? 'is-active' : ''),
            onClick: () => setView('path'),
          }, t('picker.tabPath')),
          E('button', {
            type: 'button',
            className: cx('gwc-pickerTab', view === 'browse' ? 'is-active' : ''),
            onClick: () => setView('browse'),
          }, t('picker.tabBrowse')),
          E('button', {
            type: 'button',
            className: cx('gwc-pickerTab', view === 'scan' ? 'is-active' : ''),
            onClick: () => setView('scan'),
          }, t('picker.tabScan'), scan.loading === false && scan.repos.length > 0 ? E('span', { className: 'gwc-badge' }, scan.repos.length) : null)),
        view === 'path' ? pathPane : view === 'browse' ? browsePane : scanPane))
    }

    /* ---- folder-browser helpers ------------------------------------------- */

    /** Compare a current directory against a drive root, separator-insensitively. */
    function isSameDrive(dir, drive) {
      if (typeof dir !== 'string' || typeof drive !== 'string') return false
      const norm = (value) => value.replace(/[\/\\]+$/, '').toLowerCase()
      return norm(dir) === norm(drive)
    }

    /** "C:\\" -> "C:" so the drive strip stays compact. */
    function driveLabel(drive) {
      return String(drive).replace(/[\/\\]+$/, '')
    }

    /**
     * The folder rows of the browse pane: a parent hop, the enclosing
     * repository root when the current folder is inside one, a "use this
     * folder" row when the folder IS a repository, and one row per subdirectory.
     */
    function folderListRows(t, listing, rowBase, browseTo, choose, dir) {
      const rows = []
      if (listing.parent !== null) {
        rows.push(E('button', {
          key: '__up',
          type: 'button',
          className: rowBase + ' is-up',
          onClick: () => browseTo(listing.parent),
        }, E(Icon, { name: 'up', size: 12 }), E('span', { className: 'gwc-lib-rowName' }, '..')))
      }
      if (listing.insideRepo !== null) {
        rows.push(E('button', {
          key: '__root',
          type: 'button',
          className: rowBase + ' is-hint',
          title: listing.insideRepo,
          onClick: () => choose(listing.insideRepo),
        },
          E(Icon, { name: 'repo', size: 12 }),
          E('span', { className: 'gwc-lib-rowName' }, t('picker.useRoot', { root: baseName(listing.insideRepo) }))
        ))
      }
      if (listing.isRepo === true && dir !== null) {
        rows.push(E('button', {
          key: '__here',
          type: 'button',
          className: rowBase + ' is-current',
          onClick: () => choose(dir),
        }, E(Icon, { name: 'repo', size: 12 }), E('span', { className: 'gwc-lib-rowName' }, t('picker.useThisDir'))))
      }
      if (listing.dirs.length === 0) {
        rows.push(E('div', { key: '__none', className: 'gwc-empty' }, t('repo.noSubdirs')))
      } else {
        for (const entry of listing.dirs) {
          rows.push(E('button', {
            key: entry.path,
            type: 'button',
            className: rowBase + (entry.isRepo ? ' is-repo' : ''),
            title: entry.path,
            onClick: () => browseTo(entry.path),
          },
            E(Icon, { name: entry.isRepo ? 'repo' : 'folder', size: 12 }),
            E('span', { className: 'gwc-lib-rowName' }, entry.name),
            entry.isRepo ? E('span', { className: 'gwc-lib-rowBadge' }, t('repo.isRepo')) : null
          ))
        }
      }
      return rows
    }

    /* ---- recent repositories (the "bookmark" half of SourceTree's dialog) ---- */

    function readRecentRepos() {
      try {
        const raw = window.localStorage.getItem('dsh-gitcraft.recent.v1')
        if (raw === null || raw === '') return []
        const parsed = JSON.parse(raw)
        return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === 'string').slice(0, 6) : []
      } catch {
        return []
      }
    }

    function rememberRecentRepo(repoPath) {
      if (typeof repoPath !== 'string' || repoPath === '') return
      try {
        const next = [repoPath, ...readRecentRepos().filter((entry) => entry !== repoPath)].slice(0, 6)
        window.localStorage.setItem('dsh-gitcraft.recent.v1', JSON.stringify(next))
      } catch {
        void 0
      }
    }


    function describeApiError(t, error) {
      if (error instanceof ApiError) {
        const key = 'error.' + error.code
        const translated = t(key, { message: error.message })
        return translated === key ? t('error.unknown', { message: error.message }) : translated
      }
      return String(error)
    }

    /* ============================== store hook ============================== */

    /**
     * Resolve the repository scope from whatever the host seat handed us.
     *
     * Two seats, two shapes: dsh-better-sidebar passes `{sessionId, cwd}` as
     * `scope`, while DSH's native `sidebar.right.pane.tab` seat passes its own
     * props (sessionId at minimum, cwd only on some builds). The panel must
     * never crash on a missing scope — it degrades to "no workspace yet".
     */
    function scopeOf(props) {
      const source = props !== undefined && props !== null ? props : {}
      const scoped = source.scope !== undefined && source.scope !== null ? source.scope : {}
      const pick = (key) => {
        const fromScope = scoped[key]
        if (typeof fromScope === 'string' && fromScope !== '') return fromScope
        const fromProps = source[key]
        if (typeof fromProps === 'string' && fromProps !== '') return fromProps
        return undefined
      }
      return {
        sessionId: pick('sessionId'),
        cwd: pick('cwd'),
        repoRoot: pick('repoRoot'),
      }
    }

    function useSnapshot(scope, t, chosenRepo) {
      const [state, setState] = useState({ loading: true, snapshot: null, error: null })
      const [revision, setRevision] = useState(0)
      const [slow, setSlow] = useState(false)
      /* Coalesce watcher-driven refreshes: a snapshot in flight is never
         cancelled by a new revision (a build changes files continuously); the
         refresh is deferred until it settles instead. */
      const inFlight = useRef(false)
      const pending = useRef(false)
      const refresh = useCallback(() => setRevision((value) => value + 1), [])
      const cwd = scope === undefined || scope === null ? undefined : scope.cwd
      /* scope.repoRoot is what a session seat passes; the global dock passes
         nothing, so the picked repository is the only source there. */
      const scopeRepo = scope === undefined || scope === null ? undefined : scope.repoRoot
      /* A repository picked from the workspace picker wins over the session's
         own scope: the panel must be able to inspect ANY repository in the
         workspace, not only the one the session cwd happens to sit in. */
      const repoRoot = typeof chosenRepo === 'string' && chosenRepo !== '' ? chosenRepo : scopeRepo
      const sessionId = scope === undefined || scope === null ? undefined : scope.sessionId
      useEffect(() => {
        /* No cwd but a sessionId is enough: the host resolves the session's
           workspace (the native right-sidebar seat passes no cwd at all). Only
           a request with NEITHER has nothing to ask about. */
        const hasCwd = typeof cwd === 'string' && cwd !== ''
        const hasSession = typeof sessionId === 'string' && sessionId !== ''
        const hasRepo = typeof repoRoot === 'string' && repoRoot !== ''
        /* A GLOBAL surface (the workbench dock) has neither cwd nor sessionId —
           it only knows which repository the user picked. That IS enough: the
           host accepts repoRoot on its own. Requiring cwd/session here is what
           left the docked panel stuck on "正在读取仓库…". */
        if (!hasCwd && !hasSession && !hasRepo) {
          setState((previous) => (previous.snapshot === null ? { loading: true, snapshot: null, error: null } : previous))
          return undefined
        }
        const controller = new AbortController()
        let cancelled = false
        let timedOut = false
        /* Never sit on the spinner forever: after 2 s explain why it may be slow
           (a build running in the terminal keeps the disk busy), and after 20 s
           abort with a retryable error instead of hanging. */
        const slowTimer = setTimeout(() => { if (!cancelled) setSlow(true) }, 2_000)
        const timeoutTimer = setTimeout(() => { timedOut = true; controller.abort() }, 20_000)
        inFlight.current = true
        const settle = () => {
          inFlight.current = false
          if (pending.current) {
            pending.current = false
            setRevision((value) => value + 1)
          }
        }
        const payload = hasCwd ? { cwd } : hasSession ? { sessionId } : {}
        if (hasRepo) payload.repoRoot = repoRoot
        call('snapshot', payload, controller.signal)
          .then((snapshot) => {
            clearTimeout(slowTimer)
            clearTimeout(timeoutTimer)
            if (cancelled) return
            setSlow(false)
            setState({ loading: false, snapshot, error: null })
            settle()
          })
          .catch((error) => {
            clearTimeout(slowTimer)
            clearTimeout(timeoutTimer)
            if (cancelled) return
            if (error instanceof DOMException && error.name === 'AbortError') {
              if (!timedOut) return
              setSlow(false)
              setState((previous) => ({
                loading: false,
                snapshot: previous.snapshot,
                error: new ApiError('timeout', t('error.git-timeout')),
              }))
              settle()
              return
            }
            setSlow(false)
            setState((previous) => ({
              loading: false,
              snapshot: previous.snapshot,
              error: error instanceof ApiError ? error : new ApiError('unknown', String(error)),
            }))
            settle()
          })
        return () => {
          cancelled = true
          clearTimeout(slowTimer)
          clearTimeout(timeoutTimer)
          inFlight.current = false
          controller.abort()
        }
      }, [cwd, repoRoot, sessionId, revision])
      const apply = useCallback((snapshot) => {
        if (snapshot === null || snapshot === undefined) return
        setState({ loading: false, snapshot, error: null })
      }, [])
      return { ...state, slow, inFlight, pending, refresh, apply, t }
    }

    /* ============================== panel ============================== */

    function Panel(props) {
      const { t, ctx, visible } = props
      /* Resolve the scope ONCE per render from either seat's prop shape. */
      const scope = scopeOf(props)
      const [chosenRepo, setChosenRepo] = useState(() => readStoredRepo())
      /* A session seat supplies cwd/sessionId; the global dock supplies neither, so
         a chosen repository is the only source there. */
      const hasRepoSource = (typeof scope.cwd === 'string' && scope.cwd !== '')
        || (typeof scope.sessionId === 'string' && scope.sessionId !== '')
        || (typeof chosenRepo === 'string' && chosenRepo !== '')
      const store = useSnapshot(scope, t, chosenRepo)
      const [nav, setNav] = useState('changes')
      const [width, setWidth] = useState(640)
      const [height, setHeight] = useState(720)
      const [busy, setBusy] = useState(null)
      const [toast, setToast] = useState(null)
      const [dialog, setDialog] = useState(null)
      const [commitMessage, setCommitMessage] = useState('')
      const [amend, setAmend] = useState(false)
      const [diffState, setDiffState] = useState({ path: null, patch: '', loading: false, binary: false })
      const [history, setHistory] = useState({ commits: [], loading: false, hasMore: false, search: '', ref: null, details: null })
      const [branches, setBranches] = useState([])
      /* Which tags are already published. `published: null` = unknown yet. */
      const [tagState, setTagState] = useState({ loading: false, published: null, remotes: [], error: null })
      const [stash, setStash] = useState([])
      /* ---- 文件页：搜索 + 单文件历史 ---- */
      const [fileQuery, setFileQuery] = useState('')
      const [fileSearchMode, setFileSearchMode] = useState('name')
      const [searchResult, setSearchResult] = useState({ loading: false, files: [], matches: [], truncated: false, searchMode: 'name', error: null, query: '' })
      /** The file whose history is open (null = no file chosen yet). */
      const [historyFor, setHistoryFor] = useState(null)
      const [fileLog, setFileLog] = useState({ loading: false, commits: [], hasMore: false, error: null })
      /**
       * The commit opened as a POPUP from the Files page.
       *
       * Clicking a row in the Files page used to call `setNav('history')`, which
       * threw the user into a different tab and lost the file they were looking
       * at. A popup keeps the file list, the search and the chosen file exactly
       * where they were — reading "what did this commit change about this file"
       * is a detail, not a navigation.
       */
      const [fileCommit, setFileCommit] = useState(null)
      /* The single file's diff for that commit, shown inside the popup. */
      const [fileCommitDiff, setFileCommitDiff] = useState({ path: null, loading: false, patch: '', error: null, binary: false })
      const [blame, setBlame] = useState({ path: null, lines: [], loading: false })
      const [selected, setSelected] = useState(null)
      const [diffMode, setDiffMode] = useState('unified')
      const [selectedCommit, setSelectedCommit] = useState(null)
      /** File whose commit diff is open INSIDE the history page. */
      const [historyFile, setHistoryFile] = useState(null)
      /* Fraction of the History column given to the list + commit details while a
         diff is open below it. */
      /* Share of the History column given to the COMMIT LIST while a commit's
         details are open below it (dragged, not fixed). */
      const [commitListRatio, setCommitListRatio] = useState(0.34)
      /* True while a History splitter is being dragged: a watcher-driven reload
         would change row heights under the pointer, so it waits for pointerup. */
      const [historyInteracting, setHistoryInteracting] = useState(false)
      /* Revision bookkeeping for the two surfaces the snapshot does NOT carry:
         the commit graph and the branch/tag list. `refsEpoch` is bumped by
         operations whose ref changes no snapshot field can prove (a fetch that
         only moved remote refs, branch/tag create+delete, ...). */
      const [refsEpoch, setRefsEpoch] = useState(0)
      const refsRevisionRef = useRef(null)
      const historySyncedRef = useRef(null)
      const historyFailedRef = useRef(null)
      const historyAppliedSearchRef = useRef('')
      const [branchesLoading, setBranchesLoading] = useState(false)
      const branchesSyncedRef = useRef(null)
      const branchesFailedRef = useRef(null)
      const onDetailSplitDrag = useCallback((event) => {
        event.preventDefault()
        const wrap = event.currentTarget === null ? null : event.currentTarget.parentElement
        if (wrap === null) return
        const rect = wrap.getBoundingClientRect()
        if (rect.height <= 0) return
        setHistoryInteracting(true)
        const move = (moveEvent) => {
          const ratio = (moveEvent.clientY - rect.top) / rect.height
          setCommitListRatio(Math.max(0.12, Math.min(0.82, ratio)))
        }
        const up = () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
          window.removeEventListener('pointercancel', up)
          setHistoryInteracting(false)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
        window.addEventListener('pointercancel', up)
      }, [])


      /* Line-level selection inside the open diff: keys are `hunk:bodyIndex`,
         exactly the shape the host's buildLineSelectionPatch expects. */
      const [lineSelection, setLineSelection] = useState(() => new Set())
      /* Which file the current line selection belongs to: opening another file
         must not inherit hunk keys from the previous one. */
      const diffPathRef = useRef(null)
      /* Repository selection: the picker can point the panel at ANY repository
         inside the workspace, so the panel is not limited to the one the
         session cwd happens to live in. Persisted per workspace root. */
      const [pickerOpen, setPickerOpen] = useState(false)
      const toggleLine = useCallback((key) => {
        setLineSelection((previous) => {
          const next = new Set(previous)
          if (next.has(key)) next.delete(key)
          else next.add(key)
          return next
        })
      }, [])
      const clearSelection = useCallback(() => setLineSelection(new Set()), [])
      const containerRef = useRef(null)
      const mode = useMemo(() => {
        if (width <= COMPACT_MAX_WIDTH) return 'compact'
        if (width < 760) return 'stack'
        return 'columns'
      }, [width])

      const snapshot = store.snapshot

      /* The revision token the two non-snapshot lists (History commits and the
         branch/tag list) are keyed on. It is DERIVED from the snapshot that the
         `/watch` loop above already refreshes, so it adds no polling of its own:
         a plain worktree edit changes `changes` but leaves this token alone,
         while commit/pull/merge/rebase/reset/checkout move `head` (or branch /
         upstream / ahead / behind), which bumps it. `refsEpoch` covers the ref
         rewrites that leave every snapshot field intact (a new tag, a fetch
         that only added remote refs, a branch created without checkout). */
      const refsRevision = snapshot === null ? null : [
        snapshot.root,
        snapshot.head,
        snapshot.branch,
        snapshot.detached === true ? 'detached' : 'attached',
        snapshot.upstream,
        snapshot.ahead,
        snapshot.behind,
        refsEpoch,
      ].join('\u0000')

      /* Mark "the refs may have moved" without waiting for a snapshot field to
         prove it. The reload itself stays lazy: History/Branches react to the
         token, and only while they are the active view. */
      const invalidateRefs = useCallback(() => {
        setRefsEpoch((value) => value + 1)
      }, [])

      /* measure the container: the panel never guesses which seat it is in */
      useEffect(() => {
        const element = containerRef.current
        if (element === null || typeof ResizeObserver !== 'function') return undefined
        const observer = new ResizeObserver((entries) => {
          const entry = entries[0]
          if (entry === undefined) return
          setWidth(entry.contentRect.width)
          setHeight(entry.contentRect.height)
        })
        observer.observe(element)
        return () => observer.disconnect()
      }, [])

      /* Refresh ONLY when the repository actually changes.
         The host watches the worktree and long-polls, so an idle repository costs
         nothing and a real edit shows up within a fraction of a second — instead
         of a blind refresh every 15s.

         Depends on the STABLE `store.refresh` rather than `store` (a new object
         every render): with `store` the loop restarted on every render, and each
         restart parked another long-poll until the browser's six-connection limit
         starved `snapshot` and `diff`. */
      useEffect(() => {
        if (visible === false) return undefined
        const watchPayload = {}
        if (typeof scope.cwd === 'string' && scope.cwd !== '') watchPayload.cwd = scope.cwd
        if (typeof chosenRepo === 'string' && chosenRepo !== '') watchPayload.repoRoot = chosenRepo
        if (watchPayload.cwd === undefined && watchPayload.repoRoot === undefined
          && typeof scope.sessionId === 'string' && scope.sessionId !== '') {
          watchPayload.sessionId = scope.sessionId
        }
        if (Object.keys(watchPayload).length === 0) return undefined

        const refreshStore = store.refresh
        let cancelled = false
        let revision = 0
        let controller = null
        const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
        const loop = async () => {
          while (cancelled === false) {
            /* A hidden window cannot show a snapshot, and each `changed` result
               costs a full snapshot (3 git spawns, ~400 ms on a cold profile).
               Park the loop while hidden instead of watching for changes nobody
               can see: the `pause` is cheap and re-arms the moment the window is
               visible again. Without this, minimising DSH left the reporter
               re-running git for a panel no one was looking at. */
            if (typeof document !== 'undefined' && document !== null && document.visibilityState === 'hidden') {
              await pause(1000)
              continue
            }
            controller = typeof AbortController === 'function' ? new AbortController() : null
            try {
              const result = await call(
                'watch',
                { ...watchPayload, since: revision },
                controller === null ? undefined : controller.signal,
              )
              if (cancelled) return
              if (typeof result.revision === 'number') revision = result.revision
              if (result.changed === true) {
                if (store.inFlight.current) store.pending.current = true
                else refreshStore()
                await pause(300)
              }
              if (result.supported === false) await pause(5000)
            } catch (error) {
              if (cancelled) return
              await pause(4000)
            }
          }
        }
        void loop()
        return () => {
          cancelled = true
          /* Release the parked connection immediately instead of leaving it open
             until the server times out. */
          if (controller !== null) { try { controller.abort() } catch (error) { void error } }
        }
      }, [visible, store.refresh, scope.cwd, scope.sessionId, chosenRepo])

      /* The token as of the latest committed render, readable from async code:
         a loader records the revision it STARTED from, so a revision that lands
         while it is in flight is not mistaken for loaded data. */
      useEffect(() => {
        refsRevisionRef.current = refsRevision
      }, [refsRevision])

      const notify = useCallback((kind, message) => {
        setToast({ kind, message })
        setTimeout(() => setToast((current) => (current !== null && current.message === message ? null : current)), 4000)
      }, [])

      const withScope = useCallback((extra) => {
        const payload = { ...extra }
        const baseCwd = snapshot === null || snapshot === undefined ? scope.cwd : snapshot.root
        if (typeof baseCwd === 'string' && baseCwd !== '') payload.cwd = baseCwd
        else if (typeof scope.sessionId === 'string' && scope.sessionId !== '') payload.sessionId = scope.sessionId
        const baseRepo = snapshot !== null && snapshot !== undefined ? snapshot.root : scope.repoRoot
        if (typeof baseRepo === 'string' && baseRepo !== '') payload.repoRoot = baseRepo
        return payload
      }, [scope.cwd, scope.sessionId, scope.repoRoot, snapshot])
      const describeError = useCallback((error) => {
        if (error instanceof ApiError) {
          const key = 'error.' + error.code
          const translated = t(key, { message: error.message })
          return translated === key ? t('error.unknown', { message: error.message }) : translated
        }
        return String(error)
      }, [t])

      const run = useCallback(async (label, work) => {
        setBusy(label)
        try {
          const result = await work()
          store.refresh()
          return result
        } catch (error) {
          notify('error', describeError(error))
          return null
        } finally {
          setBusy(null)
        }
      }, [notify, describeError, store])

      /* ---- data loaders ---- */

      /**
       * Load the commit list.
       *
       * `options.revision` is the refs revision this load is answering; without
       * it the current revision is captured at call time (that is what the
       * revision-driven effect relies on, so a token bump that lands while the
       * request is in flight is not marked as loaded). Only a first page
       * (skip === 0) counts as syncing the list with the repository, and a
       * FAILED load records the revision it failed on while keeping the
       * previous commits — a transient error must never blank the graph, nor
       * cause a retry loop.
       */
      const loadHistory = useCallback(async (options) => {
        const nextSearch = options !== undefined && options.search !== undefined ? options.search : history.search
        const nextRef = options !== undefined && options.ref !== undefined ? options.ref : history.ref
        const skip = options !== undefined && options.skip !== undefined ? options.skip : 0
        const startedRevision = options !== undefined && options.revision !== undefined
          ? options.revision
          : refsRevisionRef.current
        setHistory((previous) => ({ ...previous, loading: true }))
        try {
          const data = await call('log', withScope({
            limit: 60,
            skip,
            ...(nextRef === null || nextRef === undefined ? {} : { ref: nextRef }),
            ...(nextSearch === '' ? {} : { search: nextSearch }),
          }))
          historyAppliedSearchRef.current = nextSearch
          if (skip === 0) {
            historySyncedRef.current = startedRevision
            historyFailedRef.current = null
          }
          setHistory((previous) => ({
            ...previous,
            loading: false,
            commits: skip === 0 ? data.commits : previous.commits.concat(data.commits),
            hasMore: data.hasMore,
            search: nextSearch,
            ref: nextRef,
          }))
        } catch (error) {
          if (skip === 0) historyFailedRef.current = startedRevision
          setHistory((previous) => ({ ...previous, loading: false }))
          notify('error', describeError(error))
        }
      }, [withScope, history.search, history.ref, notify, describeError])

      /* Same revision contract as loadHistory: success syncs, failure records
         the revision and keeps the rows already on screen. */
      const loadBranches = useCallback(async () => {
        const startedRevision = refsRevisionRef.current
        setBranchesLoading(true)
        try {
          const data = await call('branches', withScope({}))
          branchesSyncedRef.current = startedRevision
          branchesFailedRef.current = null
          setBranches(data.branches)
        } catch (error) {
          branchesFailedRef.current = startedRevision
          notify('error', describeError(error))
        } finally {
          setBranchesLoading(false)
        }
      }, [withScope, notify, describeError])

      /**
       * Which tags are already on the remote.
       *
       * Tags have no remote-tracking ref (unlike branches), so `branches` cannot
       * answer this — only `ls-remote` can, which the host does in ONE call for
       * all tags. Loaded when the Branches tab opens, never on a poll.
       *
       * `published: null` means "not known yet" and must NOT be rendered as
       * "unpublished", or every tag would flash a publish button on first paint.
       */
      const loadTagState = useCallback(async () => {
        setTagState((previous) => ({ ...previous, loading: true, error: null }))
        try {
          const data = await call('tagRemoteState', withScope({}))
          if (data.error === 'no-remote') {
            setTagState({ loading: false, published: {}, remotes: [], error: 'no-remote' })
            return
          }
          const failed = Array.isArray(data.failures) && data.failures.length > 0
          setTagState({
            loading: false,
            published: data.published ?? {},
            remotes: data.remotes ?? [],
            error: failed ? 'partial' : null,
          })
        } catch (error) {
          /* Not fatal: the tag list still works, it just cannot say which tags
             are published. Say so rather than claiming they are all unpublished. */
          setTagState({ loading: false, published: null, remotes: [], error: describeError(error) })
        }
      }, [withScope, describeError])

      /**
       * Open one commit of the current file in a POPUP.
       *
       * Loads two things in parallel:
       *   - `commitDetail` for the message, author, time and the file list;
       *   - this file's own diff AT that commit, which is what makes the popup
       *     answer "what changed about MY file here" instead of dumping the
       *     whole commit.
       *
       * Both are optional: if the diff fails (a binary file, a rename), the
       * popup still shows the commit metadata and says why the diff is missing.
       */
      const openFileCommit = useCallback((commit) => {
        setFileCommit({ loading: true, detail: null, hash: commit.hash, error: null })
        setFileCommitDiff({ path: historyFor, loading: commit.binary !== true, patch: '', error: null, binary: commit.binary === true })
        call('commitDetail', withScope({ rev: commit.hash }))
          .then((detail) => setFileCommit((previous) => (previous === null || previous.hash !== commit.hash
            ? previous
            : { loading: false, detail, hash: commit.hash, error: null })))
          .catch((error) => setFileCommit((previous) => (previous === null || previous.hash !== commit.hash
            ? previous
            : { loading: false, detail: null, hash: commit.hash, error: describeError(error) })))
        if (commit.binary === true) return
        call('diff', withScope({ path: historyFor, base: 'commit', rev: commit.hash }))
          .then((data) => setFileCommitDiff((previous) => (previous.path !== historyFor
            ? previous
            : { path: historyFor, loading: false, patch: data.patch ?? '', error: null, binary: data.binary === true })))
          .catch((error) => setFileCommitDiff((previous) => (previous.path !== historyFor
            ? previous
            : { path: historyFor, loading: false, patch: '', error: describeError(error), binary: false })))
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [withScope, describeError, historyFor])

      const loadStash = useCallback(async () => {
        try {
          const data = await call('stashList', withScope({}))
          setStash(data.stash)
        } catch (error) {
          notify('error', describeError(error))
        }
      }, [withScope, notify, describeError])

      /**
       * Search files by name or content.
       *
       * Debounced by the caller; the request itself is not cancelled on every
       * keystroke because the host caps the work (limited rows) and a stale
       * response is dropped by comparing `query`.
       */
      const runSearch = useCallback(async (query, searchMode) => {
        const text = query.trim()
        if (text === '') {
          setSearchResult({ loading: false, files: [], matches: [], truncated: false, searchMode: searchMode, error: null, query: '' })
          return
        }
        setSearchResult((previous) => ({ ...previous, loading: true, error: null, searchMode: searchMode, query: text }))
        try {
          const data = await call('search', withScope({ query: text, mode: searchMode }))
          /* Drop a response that no longer matches what is typed. */
          setSearchResult((previous) => (previous.query !== text
            ? previous
            : { loading: false, files: data.files ?? [], matches: data.matches ?? [], truncated: data.truncated === true, searchMode: data.mode, error: null, query: text }))
        } catch (error) {
          setSearchResult((previous) => ({ ...previous, loading: false, error: error instanceof ApiError ? error : new ApiError('unknown', String(error)) }))
        }
      }, [withScope])

      /** Load the commit history of ONE file (with per-commit line counts). */
      const loadFileHistory = useCallback(async (filePath) => {
        if (filePath === null || filePath === undefined || filePath === '') return
        setHistoryFor(filePath)
        setFileLog({ loading: true, commits: [], hasMore: false, error: null })
        try {
          const data = await call('fileHistory', withScope({ path: filePath, limit: 80 }))
          setFileLog({ loading: false, commits: data.commits ?? [], hasMore: data.hasMore === true, error: null })
        } catch (error) {
          setFileLog({ loading: false, commits: [], hasMore: false, error: error instanceof ApiError ? error : new ApiError('unknown', String(error)) })
        }
      }, [withScope])

      const loadDiff = useCallback(async (filePath, base, rev) => {
        if (filePath === null || filePath === undefined) {
          setDiffState({ path: null, patch: '', loading: false, binary: false })
          return
        }
        if (diffPathRef.current !== filePath) {
          diffPathRef.current = filePath
          setLineSelection(new Set())
        }
        /* Keep what is on screen while the same file reloads: clearing it is what
           made every refresh flash "正在读取差异…". */
        setDiffState((previous) => ({
          path: filePath,
          patch: previous.path === filePath ? previous.patch : '',
          loading: true,
          binary: false,
        }))
        try {
          const entry = snapshot === null ? undefined : snapshot.changes.find((change) => change.path === filePath)
          if (entry !== undefined && entry.untracked && base === 'worktree') {
            const data = await call('untrackedDiff', withScope({ path: filePath }))
            setDiffState({ path: filePath, patch: data.patch, loading: false, binary: data.binary === true })
            return
          }
          const baseKind = base === undefined ? 'worktree' : base
          /* `base: 'commit'` diff is `git show <rev> -- <path>`: the host REQUIRES
             a rev for it and answers "rev is required" otherwise. Callers that
             browse a commit's file list pass the commit they are looking at. */
          if (baseKind === 'commit' && (typeof rev !== 'string' || rev === '')) {
            setDiffState({ path: filePath, patch: '', loading: false, binary: false })
            return
          }
          const data = await call('diff', withScope({
            path: filePath,
            base: baseKind,
            ...(baseKind === 'commit' ? { rev } : {}),
          }))
          setDiffState({ path: filePath, patch: data.patch, loading: false, binary: false })
        } catch (error) {
          setDiffState({ path: filePath, patch: '', loading: false, binary: false })
          notify('error', describeError(error))
        }
      }, [withScope, snapshot, notify, describeError])

      /* ---- revision-driven reloads --------------------------------------
         ONE rule for both cached lists: they never poll independently, they
         only answer the refs revision token above (which the existing `/watch`
         loop drives). Nothing is fetched while their view is inactive — the
         token simply stops matching, so the first activation reloads. At most
         one load per revision is in flight; a revision that lands mid-load is
         picked up when the load settles. Deferrals: a History splitter being
         dragged, and an unsubmitted search draft (Enter / the search button
         applies it, and that successful load syncs the revision). */

      /* History is the reported bug: it was loaded only by the nav/root effect,
         so a pull that left HEAD somewhere new never touched the commit list. */
      useEffect(() => {
        if (refsRevision === null || visible === false) return
        if (nav !== 'history') {
          /* Leaving the view clears the failure latch: coming back retries. */
          historyFailedRef.current = null
          return
        }
        if (historyInteracting) return
        if (history.loading) return
        /* Do not reload (nor silently apply) a search the user is still typing. */
        if (history.search !== historyAppliedSearchRef.current) return
        if (historySyncedRef.current === refsRevision) return
        if (historyFailedRef.current === refsRevision) return
        void loadHistory({ skip: 0, revision: refsRevision })
      }, [refsRevision, nav, visible, historyInteracting, history.loading, history.search, loadHistory])

      /* The branch/tag list has the same problem: it only loaded on activation
         and on the few explicit create/delete buttons, so pull/fetch/checkout
         left it stale. */
      useEffect(() => {
        if (refsRevision === null || visible === false) return
        if (nav !== 'branches') {
          branchesFailedRef.current = null
          return
        }
        if (branchesLoading) return
        if (branchesSyncedRef.current === refsRevision) return
        if (branchesFailedRef.current === refsRevision) return
        void loadBranches()
      }, [refsRevision, nav, visible, branchesLoading, loadBranches])

      /* Which tags are published can only be answered by the network, so it is
         loaded when the Branches tab opens — NOT on every snapshot poll, which
         would hammer `ls-remote` and stall the panel on a slow remote. */
      useEffect(() => {
        if (nav !== 'branches') return
        if (snapshot === null) return
        void loadTagState()
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [nav, snapshot === null ? null : snapshot.root])

      /* Stash is not keyed on refs: its own buttons reload it, and a repo switch
         must reload it for the new repository. */
      useEffect(() => {
        if (snapshot === null) return
        if (nav === 'stash') void loadStash()
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [nav, snapshot === null ? null : snapshot.root])

      /* File search, debounced: typing must not spawn a git grep per keystroke.
         220 ms is short enough to feel live and long enough to swallow a word. */
      useEffect(() => {
        if (nav !== 'files') return undefined
        const text = fileQuery.trim()
        if (text === '') {
          setSearchResult({ loading: false, files: [], matches: [], truncated: false, searchMode: fileSearchMode, error: null, query: '' })
          return undefined
        }
        const timer = setTimeout(() => { void runSearch(text, fileSearchMode) }, 220)
        return () => clearTimeout(timer)
      }, [fileQuery, fileSearchMode, nav, runSearch])

      /* Leaving the Files page keeps the chosen file, but a repository switch
         must not show the PREVIOUS repository's history. */
      useEffect(() => {
        setHistoryFor(null)
        setFileLog({ loading: false, commits: [], hasMore: false, error: null })
        setSearchResult({ loading: false, files: [], matches: [], truncated: false, searchMode: 'name', error: null, query: '' })
        setFileQuery('')
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [snapshot === null ? null : snapshot.root])

      useEffect(() => {
        if (selected === null) return
        /* A selection that names a commit is a history selection, so the diff
           must be read from that commit; every other selection reads the
           worktree or the index. */
        if (typeof selected.rev === 'string' && selected.rev !== '') {
          void loadDiff(selected.path, 'commit', selected.rev)
          return
        }
        void loadDiff(selected.path, selected.staged ? 'staged' : 'worktree')
      }, [selected, loadDiff])

      /* ---- operations ---- */


      /* Bulk stage / unstage send `all: true` instead of expanding the list into
         thousands of paths. The old expansion blew the Win32 command-line limit
         and surfaced as "找不到 git 命令" — see the host's spawnFailure(). */
      const doStage = useCallback((paths) => run('stage', async () => {
        store.apply(await call('stage', withScope({ paths })))
      }), [run, store, withScope])

      const doStageAll = useCallback(() => run('stage', async () => {
        store.apply(await call('stage', withScope({ all: true })))
      }), [run, store, withScope])

      const doUnstage = useCallback((paths) => run('unstage', async () => {
        store.apply(await call('unstage', withScope({ paths })))
      }), [run, store, withScope])

      const doUnstageAll = useCallback(() => run('unstage', async () => {
        store.apply(await call('unstage', withScope({ all: true })))
      }), [run, store, withScope])

      const doDiscard = useCallback((paths) => {
        setDialog({
          kind: 'confirm',
          title: t('changes.discard'),
          body: t('changes.confirmDiscard'),
          onConfirm: () => {
            void run('discard', async () => {
              store.apply(await call('discard', withScope({ paths })))
            })
          },
        })
      }, [run, store, withScope, t])

      /* 「全部撤销」: irreversible, so it goes through a confirmation that spells
         out exactly what is lost (every uncommitted change, tracked and
         untracked). Ignored build output is deliberately kept host-side. */
      const doDiscardAll = useCallback(() => {
        setDialog({
          kind: 'confirm',
          title: t('changes.discardAll'),
          body: t('changes.confirmDiscardAll'),
          onConfirm: () => {
            void run('discardAll', async () => {
              store.apply(await call('discard', withScope({ all: true, confirm: true })))
              notify('ok', t('changes.discardedAll'))
            })
          },
        })
      }, [run, store, withScope, t, notify])

      const doStageHunk = useCallback((filePath, hunkIndex, lines) => run('stageHunk', async () => {
        store.apply(await call('stageHunk', withScope({
          path: filePath,
          hunkIndex,
          ...(lines === undefined || lines === null ? {} : { lines }),
        })))
        if (selected !== null && selected.path === filePath) void loadDiff(filePath, selected.staged ? 'staged' : 'worktree')
      }), [run, store, withScope, selected, loadDiff])

      const doUnstageHunk = useCallback((filePath, hunkIndex, lines) => run('unstageHunk', async () => {
        store.apply(await call('unstageHunk', withScope({
          path: filePath,
          hunkIndex,
          ...(lines === undefined || lines === null ? {} : { lines }),
        })))
        if (selected !== null && selected.path === filePath) void loadDiff(filePath, 'staged')
      }), [run, store, withScope, selected, loadDiff])

      const doDiscardHunk = useCallback((filePath, hunkIndex) => {
        setDialog({
          kind: 'confirm',
          title: t('changes.discardHunk'),
          body: t('changes.confirmDiscardHunk'),
          onConfirm: () => {
            void run('discardHunk', async () => {
              store.apply(await call('discardHunk', withScope({ path: filePath, hunkIndex })))
              void loadDiff(filePath, 'worktree')
            })
          },
        })
      }, [run, store, withScope, t, loadDiff])

      const doCommit = useCallback(() => {
        const message = commitMessage.trim()
        if (message === '' && amend !== true) return
        void run('commit', async () => {
          const payload = withScope(amend === true ? { message, amend: true } : { message })
          const next = amend === true && message === ''
            ? await call('amend', withScope({ message }))
            : await call('commit', payload)
          store.apply(next)
          setCommitMessage('')
          setAmend(false)
          notify('ok', t('commit.button'))
        })
      }, [commitMessage, amend, run, withScope, store, notify, t])

      const doFetch = useCallback(() => run('fetch', async () => {
        const data = await call('fetch', withScope({}))
        store.apply(data.snapshot)
        /* fetch can move remote refs / tags without changing head or the
           ahead/behind counters, so the snapshot alone cannot prove it. */
        invalidateRefs()
        /* A repo often has a second remote that is offline or stale. The host
           fetches each one separately and reports the partial result here, so a
           successful fetch from origin is not shown as a hard failure just
           because an unrelated mirror could not be reached. */
        if (data.partial === true) {
          const names = (data.failedRemotes ?? []).map((entry) => entry.remote).join(', ')
          notify('warn', t('toolbar.fetchPartial', { names }))
        } else {
          notify('ok', t('toolbar.fetch'))
        }
      }), [run, withScope, store, invalidateRefs, notify, t])

      const doPull = useCallback(() => run('pull', async () => {
        const data = await call('pull', withScope({}))
        store.apply(data.snapshot)
        /* An already-up-to-date pull moves nothing in the snapshot, but the
           remote-tracking refs (and therefore the branch list) may have moved. */
        invalidateRefs()
        notify('ok', t('toolbar.pull'))
      }), [run, withScope, store, invalidateRefs, notify, t])

      const doPush = useCallback(() => run('push', async () => {
        const data = await call('push', withScope({}))
        store.apply(data.snapshot)
        invalidateRefs()
        notify('ok', t('toolbar.push'))
      }), [run, withScope, store, invalidateRefs, notify, t])

      const doMerge = useCallback((rev) => {
        setDialog({
          kind: 'confirm',
          title: t('branches.merge'),
          body: rev,
          onConfirm: () => {
            void run('merge', async () => {
              const data = await call('merge', withScope({ rev }))
              store.apply(data.snapshot)
              if (data.conflicted === true) notify('error', data.message)
              else notify('ok', t('branches.merge'))
            })
          },
        })
      }, [run, withScope, store, notify, t])

      const doAbortOperation = useCallback(() => run('abort', async () => {
        if (snapshot === null || snapshot.operation === null) return
        const method = snapshot.operation === 'merge' ? 'mergeAbort' : snapshot.operation === 'rebase' ? 'rebaseAbort' : null
        if (method === null) return
        store.apply(await call(method, withScope({})))
      }), [run, withScope, store, snapshot])

      const doContinueOperation = useCallback(() => run('continue', async () => {
        if (snapshot === null || snapshot.operation === null) return
        const method = snapshot.operation === 'merge'
          ? 'mergeContinue'
          : snapshot.operation === 'rebase' ? 'rebaseContinue' : null
        if (method === null) return
        store.apply(await call(method, withScope({})))
      }), [run, withScope, store, snapshot])

      const doResolve = useCallback((paths, side) => run('conflict', async () => {
        store.apply(await call('conflictResolve', withScope({ paths, side })))
      }), [run, store, withScope])

      const doInit = useCallback(() => run('init', async () => {
        store.apply(await call('init', withScope({})))
        invalidateRefs()
      }), [run, store, withScope, invalidateRefs])

      /* ---- render: header ---- */

      /* The dot means "there is work waiting in this direction", so it follows
         the SAME preconditions as the button's own `disabled` rule: a dot on a
         button that cannot act would be a lie.
           Pull: needs an upstream, and `behind > 0` (remote has commits we lack).
           Push: needs an attached HEAD, and `ahead > 0` (we have unpushed ones).
         A detached HEAD has nothing to compare, so it never advertises a push. */
      const pullPending = snapshot !== null && snapshot.upstream !== null && snapshot.behind > 0
      const pushPending = snapshot !== null && snapshot.detached !== true && snapshot.ahead > 0

      const headerRight = E('div', { className: 'gwc-headerActions' },
        E(IconButton, { name: 'repo', label: t('repo.switch'), onClick: () => setPickerOpen(true), disabled: busy !== null }),
        /* The manual refresh means "re-read everything": the snapshot alone
           would leave History/Branches untouched when HEAD did not move. */
        E(IconButton, {
          name: 'refresh',
          label: t('toolbar.refresh'),
          onClick: () => { store.refresh(); invalidateRefs() },
          disabled: busy !== null,
        }),
        E(IconButton, { name: 'fetch', label: t('toolbar.fetch'), onClick: doFetch, disabled: busy !== null || snapshot === null }),
        /* Red dot on Pull: the remote has commits this branch does not. */
        E(IconButton, {
          name: 'pull',
          label: pullPending
            ? t('toolbar.pull') + ' · ' + t('status.behind', { n: snapshot.behind })
            : t('toolbar.pull'),
          dot: pullPending,
          onClick: doPull,
          disabled: busy !== null || snapshot === null || snapshot.upstream === null,
        }),
        /* Red dot on Push: this branch has commits the remote does not. */
        E(IconButton, {
          name: 'push',
          label: pushPending
            ? t('toolbar.push') + ' · ' + t('status.ahead', { n: snapshot.ahead })
            : t('toolbar.push'),
          dot: pushPending,
          onClick: doPush,
          disabled: busy !== null || snapshot === null || snapshot.detached === true,
        }))

      const branchLabel = snapshot === null
        ? ''
        : snapshot.detached === true ? t('status.detached') : snapshot.branch

      const syncLabel = snapshot === null
        ? ''
        : snapshot.upstream === null
          ? t('status.noUpstream')
          : snapshot.ahead === 0 && snapshot.behind === 0
            ? t('status.synced')
            : [snapshot.ahead > 0 ? t('status.ahead', { n: snapshot.ahead }) : '', snapshot.behind > 0 ? t('status.behind', { n: snapshot.behind }) : '']
              .filter((entry) => entry !== '').join(' · ')

      /* The repository chip: shows which repository the panel is looking at and
         opens the picker. `repoName` is the basename of the resolved root so a
         multi-repo workspace stays legible without hovering. */
      const repoName = snapshot === null
        ? (chosenRepo === null ? '' : baseName(chosenRepo.split('\\').join('/')))
        : baseName(String(snapshot.root).split('\\').join('/'))

      const header = E('div', { className: 'gwc-header' },
        E('div', { className: 'gwc-headerMain' },
          E('button', {
            type: 'button',
            className: 'gwc-repoChip',
            title: t('repo.switch') + (snapshot === null ? '' : ': ' + snapshot.root),
            onClick: () => setPickerOpen(true),
          },
          E(Icon, { name: 'repo', size: 13 }),
          E('span', { className: 'gwc-repoChipName' }, repoName === '' ? t('repo.label') : repoName),
          E(Icon, { name: 'chevronDown', size: 11 })),
          E('span', { className: 'gwc-branchIcon' }, E(Icon, { name: 'branches', size: 13 })),
          E('span', { className: 'gwc-branchName', title: snapshot === null ? '' : snapshot.root }, branchLabel === '' ? '—' : branchLabel),
          snapshot === null ? null : E('span', { className: 'gwc-sync' }, syncLabel)),
        headerRight)

      /* The nav renders even before the first snapshot arrives: hiding it until
         then made the panel jump on every seat switch, and a not-a-repo error
         already replaces the whole body below. */
      const navBar = E('div', { className: 'gwc-nav', role: 'tablist' },
        [
          ['changes', 'changes', snapshot === null ? 0 : snapshot.changes.length],
          ['files', 'search', 0],
          ['history', 'history', 0],
          ['branches', 'branches', 0],
          ['stash', 'stash', 0],
        ].map(([id, icon, count]) => E('button', {
          key: id,
          type: 'button',
          role: 'tab',
          'aria-selected': nav === id,
          className: cx('gwc-navBtn', nav === id ? 'is-active' : ''),
          onClick: () => setNav(id),
        }, E(Icon, { name: icon, size: 13 }), E('span', { className: 'gwc-navLabel' }, t('nav.' + id)),
        count > 0 ? E('span', { className: 'gwc-badge' }, count) : null)))

      /* ---- render: changes ---- */

      const changeGroups = useMemo(() => {
        if (snapshot === null) return { conflicted: [], staged: [], unstaged: [], untracked: [] }
        const conflicted = snapshot.changes.filter((entry) => entry.conflicted)
        const staged = snapshot.changes.filter((entry) => entry.staged && !entry.conflicted)
        const untracked = snapshot.changes.filter((entry) => entry.untracked && !entry.conflicted)
        const unstaged = snapshot.changes.filter((entry) => !entry.staged && !entry.untracked && !entry.conflicted)
        return { conflicted, staged, unstaged, untracked }
      }, [snapshot])

      const renderChangeRow = (entry, group) => {
        const isSelected = selected !== null && selected.path === entry.path && selected.group === group
        const stat = entry.staged
          ? { added: entry.added, deleted: entry.deleted }
          : { added: entry.unstagedAdded, deleted: entry.unstagedDeleted }
        return E('div', {
          key: group + ':' + entry.path,
          className: cx('gwc-changeRow', isSelected ? 'is-selected' : ''),
          role: 'button',
          tabIndex: 0,
          title: entry.path,
          onClick: () => setSelected({ path: entry.path, group, staged: group === 'staged' }),
          onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') setSelected({ path: entry.path, group, staged: group === 'staged' }) },
        },
        E('span', { className: cx('gwc-statusBadge', 'kind-' + entry.kind) }, entry.kind === 'untracked' ? 'U' : entry.kind === 'deleted' ? 'D' : entry.kind === 'added' ? 'A' : entry.kind === 'renamed' ? 'R' : entry.kind === 'conflicted' ? '!' : 'M'),
        E('span', { className: 'gwc-changeName' }, baseName(entry.path)),
        E('span', { className: 'gwc-changeDir' }, dirName(entry.path)),
        E('span', { className: 'gwc-changeStat' },
          stat.added > 0 ? E('span', { className: 'gwc-add' }, '+' + stat.added) : null,
          stat.deleted > 0 ? E('span', { className: 'gwc-del' }, '−' + stat.deleted) : null),
        E('span', { className: 'gwc-changeActions' },
          group === 'staged'
            ? E(IconButton, { name: 'minus', label: t('changes.unstage'), onClick: (event) => { event.stopPropagation(); void doUnstage([entry.path]) } })
            : E(IconButton, { name: 'plus', label: t('changes.stage'), onClick: (event) => { event.stopPropagation(); void doStage([entry.path]) } }),
          E(IconButton, {
            name: 'undo',
            label: t('changes.discard'),
            danger: true,
            onClick: (event) => { event.stopPropagation(); doDiscard([entry.path]) },
          })))
      }

      const renderGroup = (id, title, entries) => entries.length === 0 ? null : E('div', { className: 'gwc-group' },
        E('div', { className: 'gwc-groupHead' },
          E('span', { className: 'gwc-groupTitle' }, title),
          /* Each group gets the bulk action that matches its own meaning, plus
             the destructive one. `全部撤销` appears on BOTH groups, because
             discarding is about the worktree, not about which column a file
             currently sits in — a user with everything staged still needs a way
             to throw it away. */
          E('span', { className: 'gwc-groupActions' },
            id === 'staged'
              ? E(TextButton, { onClick: doUnstageAll }, t('changes.unstageAll'))
              : id === 'unstaged'
                ? E(TextButton, { onClick: doStageAll }, t('changes.stageAll'))
                : null,
            E(TextButton, { danger: true, onClick: doDiscardAll, title: t('changes.confirmDiscardAll') }, t('changes.discardAll')))),
        entries.map((entry) => renderChangeRow(entry, id)))

      const diffHunkActions = useCallback((hunk) => {
        if (selected === null) return null
        const hasSelection = lineSelection !== null && lineSelection !== undefined
        const bodyIndexes = []
        for (const row of hunk.rows) {
          if (row.kind !== 'add' && row.kind !== 'del') continue
          if (hasSelection && lineSelection.has(hunk.index + ':' + row.bodyIndex)) bodyIndexes.push(row.bodyIndex)
        }
        const selectedLines = bodyIndexes.length > 0 ? bodyIndexes : null
        const selectionNote = selectedLines === null
          ? null
          : E('span', { className: 'gwc-hunkSel', title: t('changes.clearSelection'), onClick: clearSelection },
            t('changes.selected', { n: selectedLines.length }))
        return E(Fragment, null,
          selectionNote,
          selected.group === 'staged'
            ? E(TextButton, {
              onClick: () => { void doUnstageHunk(selected.path, hunk.index, selectedLines) },
            }, selectedLines === null ? t('changes.unstageHunk') : t('changes.stageLines'))
            : E(Fragment, null,
              E(TextButton, {
                onClick: () => { void doStageHunk(selected.path, hunk.index, selectedLines) },
              }, selectedLines === null ? t('changes.stageHunk') : t('changes.stageLines')),
              E(TextButton, {
                danger: true,
                onClick: () => doDiscardHunk(selected.path, hunk.index),
              }, t('changes.discardHunk'))))
      }, [selected, lineSelection, doStageHunk, doUnstageHunk, doDiscardHunk, clearSelection, t])

      const changesView = snapshot === null ? null : E('div', { className: 'gwc-changes' },
        snapshot.changes.length === 0
          /* A bare "no changes" line is a dead end. Say what state the tree is
             in and offer the one action that is useful from here (refresh), so
             the panel still responds when there is nothing to do. */
          ? E('div', { className: 'gwc-emptyState' },
            E('div', { className: 'gwc-emptyIcon' }, E(Icon, { name: 'check', size: 22 })),
            E('div', { className: 'gwc-emptyTitle' }, t('changes.empty')),
            E('div', { className: 'gwc-emptyHint' },
              snapshot.ahead > 0 || snapshot.behind > 0
                ? t('changes.emptyHintSync')
                : t('changes.emptyHint')),
            E('div', { className: 'gwc-emptyActions' },
              E(TextButton, { onClick: () => { store.refresh(); invalidateRefs() } }, t('toolbar.refresh')),
              snapshot.behind > 0
                ? E(TextButton, { primary: true, disabled: busy !== null, onClick: doPull }, t('toolbar.pull'))
                : null,
              snapshot.ahead > 0 && snapshot.detached !== true
                ? E(TextButton, { primary: true, disabled: busy !== null, onClick: doPush }, t('toolbar.push'))
                : null))
          : E(Fragment, null,
            renderGroup('conflicted', t('changes.conflicted', { n: changeGroups.conflicted.length }), changeGroups.conflicted),
            renderGroup('staged', t('changes.staged', { n: changeGroups.staged.length }), changeGroups.staged),
            renderGroup('unstaged', t('changes.unstaged', { n: changeGroups.unstaged.length }), changeGroups.unstaged),
            renderGroup('untracked', t('changes.untracked', { n: changeGroups.untracked.length }), changeGroups.untracked)))

      const closeDiff = useCallback(() => {
        setSelected(null)
        setHistoryFile(null)
        /* Must be an empty Set, not null: the next diff's hunk actions call
           lineSelection.has(...) while rendering, and null crashed the page
           ("Cannot read properties of null (reading 'has')"). */
        setLineSelection(new Set())
        setDiffState({ path: null, patch: '', loading: false, binary: false })
      }, [])

      /* 变更页和历史页的 diff 都用居中大弹窗。 */
      const diffTitle = selected !== null ? selected.path : historyFile
      const diffIsHistory = selected === null && historyFile !== null
      const diffModal = diffTitle === null ? null : E(Modal, {
        t,
        title: diffTitle,
        wide: true,
        onClose: closeDiff,
      },
        E('div', { className: 'gwc-diffModal' },
          E('div', { className: 'gwc-diffHead' },
            E('span', { className: 'gwc-diffTitle', title: diffTitle }, diffTitle),
            E('span', { className: 'gwc-historyDiffActions' },
              E(TextButton, { onClick: () => setDiffMode(diffMode === 'split' ? 'unified' : 'split') }, diffMode === 'split' ? t('diff.split') : t('diff.unified')),
              E(TextButton, { onClick: closeDiff }, t('diff.close')))),
          E('div', { className: 'gwc-diffScroll' },
            E('div', { className: 'gwc-diffPane' },
              E(DiffView, {
                patch: diffState.patch,
                mode: diffMode,
                t,
                loading: diffState.loading,
                hunkActions: diffIsHistory ? undefined : diffHunkActions,
                selection: diffIsHistory ? null : lineSelection,
                onToggle: diffIsHistory ? undefined : toggleLine,
              })))))


      const commitBox = snapshot === null ? null : E('div', { className: 'gwc-commitBox' },
        E('textarea', {
          className: 'gwc-commitInput',
          rows: 2,
          placeholder: t('commit.placeholder'),
          value: commitMessage,
          onChange: (event) => setCommitMessage(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              doCommit()
            }
          },
        }),
        E('div', { className: 'gwc-commitRow' },
          E('label', { className: 'gwc-check', title: t('commit.amendHint') },
            E('input', { type: 'checkbox', checked: amend, onChange: (event) => setAmend(event.target.checked) }),
            E('span', null, t('commit.amend'))),
          E(TextButton, {
            primary: true,
            disabled: busy !== null || (commitMessage.trim() === '' && amend !== true) || snapshot.changes.length === 0,
            onClick: doCommit,
          }, amend ? t('commit.amend') : t('commit.button'))))

      /* ---- render: history ---- */

      /* Lane assignment is computed BEFORE the view that reads it: the view is
         a plain `const` above this point in source order in earlier revisions,
         which threw "Cannot access 'historyLayout' before initialization" the
         first time the History tab rendered. Keep this above `historyView`. */
      const historyLayout = useMemo(() => layoutGraph(history.commits), [history.commits])

      const historyView = E('div', { className: 'gwc-history' },
        E('div', { className: 'gwc-historyBar' },
          E('input', {
            className: 'gwc-input gwc-search',
            type: 'text',
            placeholder: t('history.search'),
            value: history.search,
            onChange: (event) => {
              const value = event.target.value
              setHistory((previous) => ({ ...previous, search: value }))
            },
            onKeyDown: (event) => { if (event.key === 'Enter') void loadHistory({ skip: 0, search: event.currentTarget.value }) },
          }),
          E(IconButton, { name: 'history', label: t('history.search'), onClick: () => { void loadHistory({ skip: 0 }) } })),
        E('div', { className: 'gwc-historyMain' },
        E('div', {
          className: 'gwc-historyList',
          style: selectedCommit === null ? undefined : { flex: '0 0 ' + Math.round(commitListRatio * 100) + '%' },
        },
        E('div', { className: 'gwc-commitList' },
          history.commits.length === 0 && history.loading === false
            ? E('div', { className: 'gwc-empty' }, t('history.empty'))
            : history.commits.map((commit) => {
              const lane = historyLayout.laneOf.get(commit.hash)
              return E('div', {
                key: commit.hash,
                className: cx('gwc-commitRow', selectedCommit === commit.hash ? 'is-selected' : ''),
                role: 'button',
                tabIndex: 0,
                onClick: () => setSelectedCommit(commit.hash),
                onKeyDown: (event) => { if (event.key === 'Enter') setSelectedCommit(commit.hash) },
              },
              E(GraphCell, { commit, lane: lane === undefined ? 0 : lane, maxLane: historyLayout.maxLane, isMerge: commit.parents.length > 1 }),
              E('span', { className: 'gwc-commitSubject', title: commit.subject }, commit.subject),
              E('span', { className: 'gwc-commitRefs' }, commit.refs.filter((ref) => ref !== '').slice(0, 3).map((ref) => E('span', {
                key: ref,
                className: cx('gwc-refPill', ref.startsWith('tag:') ? 'is-tag' : ref.includes('/') ? 'is-remote' : 'is-local'),
              }, ref))))
            })),
        history.hasMore === true
          ? E('div', { className: 'gwc-loadMore' },
            E(TextButton, { disabled: history.loading, onClick: () => { void loadHistory({ skip: history.commits.length }) } }, t('history.loadMore')))
          : null),
        selectedCommit === null ? null : E('div', {
          className: 'gwc-splitBar is-detail',
          title: t('history.resize'),
          'aria-label': t('history.resize'),
          onPointerDown: onDetailSplitDrag,
        }, E('div', { className: 'gwc-splitGrip' })),
        selectedCommit === null ? null : E(CommitDetails, {
          commit: history.details,
          t,
          onCherryPick: () => { void run('cherryPick', async () => { const data = await call('cherryPick', withScope({ rev: selectedCommit })); store.apply(data.snapshot) }) },
          onRevert: () => { void run('revert', async () => { const data = await call('revert', withScope({ rev: selectedCommit })); store.apply(data.snapshot) }) },
          onReset: () => setDialog({
            kind: 'reset',
            title: t('history.resetTo'),
            rev: selectedCommit,
          }),
          onBranch: () => setDialog({ kind: 'branch', title: t('history.createBranch'), startPoint: selectedCommit }),
          onTag: () => setDialog({ kind: 'tag', title: t('history.createTag'), rev: selectedCommit }),
          onFileClick: (filePath) => {
            /* Stay on the History page: jumping to Changes lost the commit the user
               was reading and mixed two different views. */
            setHistoryFile(filePath)
            void loadDiff(filePath, 'commit', selectedCommit)
          },
        })));


      useEffect(() => {
        if (selectedCommit === null) return
        setHistoryFile(null)
        setHistory((previous) => ({ ...previous, details: null }))
        call('commitDetail', withScope({ rev: selectedCommit }))
          .then((data) => setHistory((previous) => ({ ...previous, details: data })))
          .catch((error) => notify('error', describeError(error)))
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [selectedCommit])

      /* ---- render: branches ---- */

      const branchGroups = useMemo(() => ({
        local: branches.filter((entry) => entry.kind === 'local'),
        remote: branches.filter((entry) => entry.kind === 'remote'),
        tags: branches.filter((entry) => entry.kind === 'tag'),
      }), [branches])

      /* Publish ONE tag. `git push --tags` is deliberately not offered as a bulk
         action: it sends every local tag, including the throwaway ones a build
         leaves behind. */
      const publishTag = useCallback((name) => {
        void run('tagPush', async () => {
          const data = await call('tagPush', withScope({ name }))
          store.apply(data)
          invalidateRefs()
          void loadTagState()
          notify('ok', t('tag.published', { name }))
        })
      }, [run, withScope, store, invalidateRefs, loadTagState, notify, t])

      const renderBranchRow = (entry) => {
        /* For a tag: is it on every configured remote, on some, or nowhere? */
        const publishedOn = entry.kind !== 'tag' || tagState.published === null
          ? null
          : (tagState.published[entry.name] ?? [])
        const missingFrom = publishedOn === null || tagState.remotes.length === 0
          ? []
          : tagState.remotes.filter((remote) => !publishedOn.includes(remote))
        return E('div', {
          key: entry.refName,
          className: cx('gwc-branchRow', entry.head ? 'is-head' : ''),
          title: entry.subject,
        },
        E('span', { className: 'gwc-branchRowName' }, entry.name),
        entry.head ? E('span', { className: 'gwc-refPill is-local' }, 'HEAD') : null,
        /* "未发布" / "缺 1 个远程": the whole point of the button next to it. */
        entry.kind === 'tag' && missingFrom.length > 0
          ? E('span', {
            className: 'gwc-syncMini is-unpublished',
            title: t('tag.missingOn', { names: missingFrom.join(', ') }),
          }, publishedOn.length === 0 ? t('tag.unpublished') : t('tag.missingN', { n: missingFrom.length }))
          : null,
        entry.ahead > 0 ? E('span', { className: 'gwc-syncMini' }, '↑' + entry.ahead) : null,
        entry.behind > 0 ? E('span', { className: 'gwc-syncMini' }, '↓' + entry.behind) : null,
        E('span', { className: 'gwc-branchRowActions' },
          entry.head ? null : E(TextButton, { onClick: () => { void run('checkout', async () => { store.apply(await call('checkout', withScope({ name: entry.name }))) }) } }, t('branches.checkout')),
          entry.head || entry.kind === 'local' ? null : E(TextButton, { onClick: () => doMerge(entry.name) }, t('branches.merge')),
          entry.head || entry.kind === 'local' ? null : E(TextButton, {
            onClick: () => setDialog({
              kind: 'confirm',
              title: t('branches.rebase'),
              body: entry.name,
              onConfirm: () => {
                void run('rebase', async () => {
                  const data = await call('rebase', withScope({ onto: entry.name }))
                  store.apply(data.snapshot)
                  if (data.conflicted === true) notify('error', data.message)
                  else notify('ok', t('branches.rebase'))
                })
              },
            }),
          }, t('branches.rebase')),
          /* Publish this ONE tag — the missing piece that made "标签怎么推送" a
             command-line-only answer. */
          entry.kind === 'tag' && missingFrom.length > 0
            ? E(TextButton, {
              primary: true,
              disabled: busy !== null || tagState.loading,
              onClick: () => publishTag(entry.name),
            }, t('tag.publish'))
            : null,
          entry.kind === 'local'
            ? E(IconButton, { name: 'trash', label: t('branches.delete'), danger: true, onClick: () => setDialog({ kind: 'deleteBranch', name: entry.name }) })
            : entry.kind === 'tag'
              ? E(IconButton, {
              name: 'undo',
              label: t('tag.revoke'),
              danger: true,
              /* One dialog decides BOTH halves (local only / local + remote);
                 the tag name is the whole payload, so nothing else can be hit. */
              onClick: () => setDialog({ kind: 'tagRevoke', name: entry.name }),
            })
            : null))
      }

      const branchesView = E('div', { className: 'gwc-branches' },
        E('div', { className: 'gwc-branchBar' },
          E(TextButton, { onClick: () => setDialog({ kind: 'branch', title: t('branches.new') }) }, t('branches.new')),
          E(IconButton, { name: 'refresh', label: t('toolbar.refresh'), onClick: loadBranches })),
        E('div', { className: 'gwc-group' },
          E('div', { className: 'gwc-groupHead' }, E('span', { className: 'gwc-groupTitle' }, t('branches.local'))),
          branchGroups.local.map(renderBranchRow)),
        branchGroups.remote.length === 0 ? null : E('div', { className: 'gwc-group' },
          E('div', { className: 'gwc-groupHead' }, E('span', { className: 'gwc-groupTitle' }, t('branches.remote'))),
          branchGroups.remote.map(renderBranchRow)),
        branchGroups.tags.length === 0 ? null : E('div', { className: 'gwc-group' },
          E('div', { className: 'gwc-groupHead' }, E('span', { className: 'gwc-groupTitle' }, t('branches.tags'))),
          branchGroups.tags.map(renderBranchRow)))

      /* ---- render: stash ---- */

      const stashView = E('div', { className: 'gwc-stash' },
        E('div', { className: 'gwc-branchBar' },
          E(TextButton, { onClick: () => setDialog({ kind: 'stash' }) }, t('stash.create')),
          E(IconButton, { name: 'refresh', label: t('toolbar.refresh'), onClick: loadStash })),
        stash.length === 0
          ? E('div', { className: 'gwc-empty' }, t('stash.empty'))
          : stash.map((entry, index) => E('div', { key: entry.ref, className: 'gwc-stashRow' },
            E('span', { className: 'gwc-stashRef' }, entry.ref),
            E('span', { className: 'gwc-stashSubject', title: entry.subject }, entry.subject),
            E('span', { className: 'gwc-stashActions' },
              E(TextButton, { onClick: () => { void run('stashPop', async () => { const data = await call('stashPop', withScope({ index })); store.apply(data.snapshot); void loadStash() }) } }, t('stash.pop')),
              E(TextButton, { onClick: () => { void run('stashApply', async () => { const data = await call('stashApply', withScope({ index })); store.apply(data.snapshot) }) } }, t('stash.apply')),
              E(IconButton, { name: 'trash', label: t('stash.drop'), danger: true, onClick: () => { void run('stashDrop', async () => { store.apply(await call('stashDrop', withScope({ index }))); void loadStash() }) } })))))

      /* ---- render: files (search + single-file history) ---- */

      /** One row of the file-history list: subject, author/time and ±counts. */
      const renderFileHistoryRow = (commit) => E('div', {
        key: commit.hash,
        className: 'gwc-fileLogRow',
        role: 'button',
        tabIndex: 0,
        title: commit.subject,
        onClick: () => openFileCommit(commit),
        onKeyDown: (event) => { if (event.key === 'Enter') openFileCommit(commit) },
      },
      E('span', { className: 'gwc-fileLogHash' }, commit.short),
      E('span', { className: 'gwc-fileLogSubject' }, commit.subject),
      E('span', { className: 'gwc-fileLogMeta' },
        E('span', { className: 'gwc-fileLogAuthor' }, commit.authorName),
        E('span', { className: 'gwc-fileLogTime' }, formatDate(commit.authorTime)),
        commit.binary
          ? E('span', { className: 'gwc-fileLogBin' }, t('files.binary'))
          : E('span', { className: 'gwc-fileLogStat' },
            commit.added > 0 ? E('span', { className: 'gwc-add' }, '+' + commit.added) : null,
            commit.deleted > 0 ? E('span', { className: 'gwc-del' }, '−' + commit.deleted) : null)))

      const searchRows = searchResult.searchMode === 'content' && searchResult.matches.length > 0
        ? searchResult.matches.map((match, index) => E('div', {
          key: match.path + ':' + match.line + ':' + index,
          className: cx('gwc-fileRow', historyFor === match.path ? 'is-selected' : ''),
          role: 'button',
          tabIndex: 0,
          title: match.path + ':' + match.line,
          onClick: () => { void loadFileHistory(match.path) },
          onKeyDown: (event) => { if (event.key === 'Enter') void loadFileHistory(match.path) },
        },
        E('span', { className: 'gwc-fileRowName' }, baseName(match.path)),
        E('span', { className: 'gwc-fileRowDir' }, dirName(match.path)),
        E('span', { className: 'gwc-fileRowLine' }, String(match.line)),
        E('span', { className: 'gwc-fileRowText' }, match.text.trim())))
        : searchResult.files.map((file) => E('div', {
          key: file.path,
          className: cx('gwc-fileRow', historyFor === file.path ? 'is-selected' : ''),
          role: 'button',
          tabIndex: 0,
          title: file.path,
          onClick: () => { void loadFileHistory(file.path) },
          onKeyDown: (event) => { if (event.key === 'Enter') void loadFileHistory(file.path) },
        },
        E('span', { className: 'gwc-fileRowName' }, baseName(file.path)),
        E('span', { className: 'gwc-fileRowDir' }, dirName(file.path)),
        E(IconButton, {
          name: 'history',
          label: t('files.openHistory'),
          size: 12,
          onClick: (event) => { event.stopPropagation(); void loadFileHistory(file.path) },
        })))

      const filesView = E('div', { className: 'gwc-files' },
        E('div', { className: 'gwc-fileBar' },
          E('div', { className: 'gwc-fileSearch' },
            E(Icon, { name: 'search', size: 13 }),
            E('input', {
              className: 'gwc-input gwc-fileInput',
              type: 'search',
              value: fileQuery,
              placeholder: fileSearchMode === 'content' ? t('files.placeholderContent') : t('files.placeholderName'),
              'aria-label': t('files.search'),
              onChange: (event) => setFileQuery(event.target.value),
              /* Esc clears instead of doing nothing: the field is the only way
                 back to the full list. */
              onKeyDown: (event) => { if (event.key === 'Escape') { setFileQuery('') } },
            }),
            fileQuery === '' ? null : E('button', {
              type: 'button',
              className: 'gwc-fileClear',
              title: t('files.clear'),
              'aria-label': t('files.clear'),
              onClick: () => setFileQuery(''),
            }, E(Icon, { name: 'close', size: 11 }))),
          E('div', { className: 'gwc-fileModes', role: 'tablist' },
            ['name', 'content'].map((searchMode) => E('button', {
              key: searchMode,
              type: 'button',
              role: 'tab',
              'aria-selected': fileSearchMode === searchMode,
              className: cx('gwc-fileMode', fileSearchMode === searchMode ? 'is-active' : ''),
              onClick: () => setFileSearchMode(searchMode),
            }, t('files.mode.' + searchMode))))),
        E('div', { className: 'gwc-filesMain' },
          E('div', { className: 'gwc-fileResults' },
            searchResult.loading
              ? E('div', { className: 'gwc-empty' }, t('files.searching'))
              : searchResult.error !== null
                ? E('div', { className: 'gwc-empty is-error' }, describeError(searchResult.error))
                : fileQuery.trim() === ''
                  ? E('div', { className: 'gwc-empty' }, E('div', { className: 'gwc-emptyTitle' }, t('files.hintTitle')),
                    E('div', { className: 'gwc-emptyHint' }, t('files.hint')))
                  : searchRows.length === 0
                    ? E('div', { className: 'gwc-empty' }, t('files.noResults'))
                    : E(Fragment, null,
                      searchRows,
                      searchResult.truncated ? E('div', { className: 'gwc-empty' }, t('files.truncated')) : null)),
          E('div', { className: 'gwc-fileHistory' },
            historyFor === null
              ? E('div', { className: 'gwc-empty' }, t('files.pickFile'))
              : E(Fragment, null,
                E('div', { className: 'gwc-fileHistoryHead' },
                  E('span', { className: 'gwc-fileHistoryPath', title: historyFor }, historyFor),
                  E(IconButton, {
                    name: 'refresh',
                    label: t('toolbar.refresh'),
                    size: 12,
                    onClick: () => { void loadFileHistory(historyFor) },
                  })),
                fileLog.loading
                  ? E('div', { className: 'gwc-empty' }, t('status.loading'))
                  : fileLog.error !== null
                    ? E('div', { className: 'gwc-empty is-error' }, describeError(fileLog.error))
                    : fileLog.commits.length === 0
                      ? E('div', { className: 'gwc-empty' }, t('files.noHistory'))
                      : E('div', { className: 'gwc-fileLog' },
                        /* `--follow` walks renames, so say so: a history that
                           starts earlier than the file's current name is
                           correct, not a bug. */
                        E('div', { className: 'gwc-fileLogCount' }, t('files.commitCount', { n: fileLog.commits.length })),
                        fileLog.commits.map(renderFileHistoryRow)))))) 

      /* ---- render: one commit of the current file, as a POPUP ---- */

      /**
       * A commit's effect on the file being inspected, without leaving the page.
       *
       * Two blocks: the commit metadata (subject / full body / author / time /
       * the files it touched) and this file's own diff AT that commit. The diff
       * is the point — "what did this commit do to MY file" — so it gets the
       * space, and the metadata stays compact above it.
       */
      const fileCommitModal = fileCommit === null ? null : E(Modal, {
        t,
        title: fileCommit.detail === null
          ? (fileCommit.hash === null ? '' : fileCommit.hash.slice(0, 7)) + ' · ' + (historyFor ?? '')
          : fileCommit.detail.short + ' · ' + fileCommit.detail.subject,
        wide: true,
        onClose: () => { setFileCommit(null); setFileCommitDiff({ path: null, loading: false, patch: '', error: null, binary: false }) },
      },
      E('div', { className: 'gwc-commitPopup' },
        fileCommit.loading
          ? E('div', { className: 'gwc-empty' }, t('status.loading'))
          : fileCommit.error !== null
            ? E('div', { className: 'gwc-empty is-error' }, fileCommit.error)
            : E(Fragment, null,
              E('div', { className: 'gwc-commitPopupMeta' },
                E('span', { className: 'gwc-commitPopupHash' }, fileCommit.detail.hash),
                E('span', null, fileCommit.detail.authorName),
                E('span', null, formatDate(fileCommit.detail.authorTime)),
                E('span', { className: 'gwc-commitPopupFile', title: historyFor }, historyFor)),
              /* The body repeats the subject; only show it when there is more. */
              (fileCommit.detail.body.trim() === '' || fileCommit.detail.body.trim() === fileCommit.detail.subject.trim())
                ? null
                : E('pre', { className: 'gwc-commitPopupBody' }, fileCommit.detail.body.trim()),
              /* Everything else this commit touched, so the popup is not blind
                 to a change whose real cause is elsewhere in the commit. */
              fileCommit.detail.files.length <= 1 ? null : E('div', { className: 'gwc-commitPopupOthers' },
                E('span', { className: 'gwc-commitPopupOthersTitle' }, t('files.alsoChanged', { n: fileCommit.detail.files.length - 1 })),
                fileCommit.detail.files
                  .filter((file) => file.path !== historyFor)
                  .slice(0, 12)
                  .map((file) => E('span', { key: file.path, className: 'gwc-commitPopupOther', title: file.path }, baseName(file.path))),
                fileCommit.detail.files.length - 1 > 12 ? E('span', { className: 'gwc-commitPopupOther' }, '…') : null)),
        E('div', { className: 'gwc-commitPopupDiffBar' },
          E('span', { className: 'gwc-commitPopupDiffTitle' }, t('files.diffInCommit'))),
        E('div', { className: 'gwc-commitPopupDiff' },
          E(DiffView, {
            patch: fileCommitDiff.patch,
            mode: 'unified',
            t,
            loading: fileCommitDiff.loading,
            error: fileCommitDiff.error,
            binary: fileCommitDiff.binary,
            /* No staging controls: this is a committed diff, not the index. */
            hunkActions: undefined,
            selection: null,
            onToggle: undefined,
          }))))

      /* ---- render: conflict banner ---- */

      const conflictBanner = snapshot === null || snapshot.operation === null
        ? null
        : E('div', { className: 'gwc-conflictBar' },
          E(Icon, { name: 'warning', size: 14 }),
          E('span', { className: 'gwc-conflictTitle' }, t('conflict.title', { op: snapshot.operation })),
          E('span', { className: 'gwc-conflictCount' }, t('conflict.files', { n: snapshot.conflictedFiles.length })),
          E('span', { className: 'gwc-conflictActions' },
            E(TextButton, { primary: true, disabled: busy !== null, onClick: doContinueOperation }, t('conflict.continue')),
            E(TextButton, { danger: true, disabled: busy !== null, onClick: doAbortOperation }, t('conflict.abort'))))

      /* ---- render: body ---- */

      const bodyFor = () => {
        if (store.error !== null && store.error.code === 'not-a-repo') {
          return E('div', { className: 'gwc-empty' },
            E('div', { className: 'gwc-emptyTitle' }, t('repo.none')),
            E('div', { className: 'gwc-emptyHint' }, t('repo.noneHint')),
            E(TextButton, { primary: true, onClick: doInit }, t('repo.init')))
        }
        if (store.error !== null && snapshot === null) return E('div', { className: 'gwc-empty is-error' }, describeError(store.error))
        if (snapshot === null && hasRepoSource !== true) {
          /* No session workspace and no picked repository: ask, do not spin. */
          return E('div', { className: 'gwc-empty' },
            E('div', { className: 'gwc-emptyTitle' }, t('repo.none')),
            E('div', { className: 'gwc-emptyHint' }, t('repo.globalHint')),
            E(TextButton, { primary: true, onClick: () => setPickerOpen(true) }, t('repo.pick')))
        }
        if (snapshot === null) {
          /* A skeleton, not a stranded line of text: the panel keeps its shape
             while the first snapshot is on its way, so the seat does not jump
             when the real content lands. */
          return E('div', { className: 'gwc-skeleton', 'aria-busy': 'true', 'aria-live': 'polite' },
            E('div', { className: 'gwc-skelTitle' }, t('status.loading')),
            [0, 1, 2, 3, 4, 5].map((index) => E('div', {
              key: index,
              className: 'gwc-skelRow',
              style: { width: [72, 54, 63, 48, 68, 57][index] + '%', animationDelay: index * 90 + 'ms' },
            })),
            store.slow ? E('div', { className: 'gwc-emptyHint', style: { marginTop: 12 } }, t('status.loadingSlow')) : null)
        }
        if (nav === 'changes') {
          /* List and diff scroll INDEPENDENTLY. The diff used to sit after the
             list inside one scroll container, so a 28-file change set pushed it
             below the fold and reading a file meant scrolling past all of them. */
          return E('div', { className: 'gwc-changesWrap' },
            conflictBanner,
            E('div', { className: 'gwc-changeListPane is-solo' }, changesView),
            commitBox)
        }
        if (nav === 'files') return filesView
        if (nav === 'history') return historyView
        if (nav === 'branches') return branchesView
        if (nav === 'stash') return stashView
        return null
      }

      /* ---- dialogs ---- */

      const dialogNode = dialog === null ? null : dialog.kind === 'confirm'
        ? E(Modal, {
          t,
          title: dialog.title,
          onClose: () => setDialog(null),
          footer: E(Fragment, null,
            E(TextButton, { onClick: () => setDialog(null) }, t('dialog.cancel')),
            E(TextButton, { primary: true, onClick: () => { const act = dialog.onConfirm; setDialog(null); if (act !== undefined) act() } }, t('dialog.confirm'))),
        }, E('div', { className: 'gwc-dialogBody' }, dialog.body))
        : dialog.kind === 'branch'
          ? E(BranchDialog, { t, defaultStart: dialog.startPoint, onCancel: () => setDialog(null), onSubmit: (payload) => {
            setDialog(null)
            void run('branchCreate', async () => {
              store.apply(await call('branchCreate', withScope(payload)))
              invalidateRefs()
            })
          } })
          : dialog.kind === 'tag'
            ? E(TagDialog, { t, rev: dialog.rev, onCancel: () => setDialog(null), onSubmit: (payload) => {
              setDialog(null)
              void run('tagCreate', async () => {
                store.apply(await call('tagCreate', withScope(payload)))
                invalidateRefs()
              })
            } })
            : dialog.kind === 'reset'
              ? E(ResetDialog, { t, onCancel: () => setDialog(null), onSubmit: (mode) => {
                setDialog(null)
                void run('reset', async () => {
                  /* reset always moves HEAD, which the snapshot token reports. */
                  store.apply(await call('reset', withScope({ rev: dialog.rev, mode, confirm: true })))
                })
              } })
              : dialog.kind === 'deleteBranch'
                ? E(DeleteBranchDialog, { t, name: dialog.name, onCancel: () => setDialog(null), onSubmit: (payload) => {
                  setDialog(null)
                  void run('branchDelete', async () => {
                    store.apply(await call('branchDelete', withScope(payload)))
                    invalidateRefs()
                  })
                } })
                : dialog.kind === 'tagRevoke'
                  ? E(TagRevokeDialog, {
                    t,
                    name: dialog.name,
                    onCancel: () => setDialog(null),
                    onSubmit: (payload) => {
                      setDialog(null)
                      void run('tagReset', async () => {
                        store.apply(await call('tagReset', withScope(payload)))
                        invalidateRefs()
                        notify('ok', t('tag.revoked', { name: dialog.name }))
                      })
                    },
                  })
                  : dialog.kind === 'stash'
                  ? E(StashDialog, { t, onCancel: () => setDialog(null), onSubmit: (payload) => {
                    setDialog(null)
                    void run('stashPush', async () => {
                      const data = await call('stashPush', withScope(payload))
                      store.apply(data.snapshot)
                      void loadStash()
                    })
                  } })
                  : null

      const pickerNode = pickerOpen === false ? null : E(RepoPicker, {
        t,
        scope,
        current: snapshot === null ? chosenRepo : snapshot.root,
        onClose: () => setPickerOpen(false),
        onPick: (repoPath) => {
          setChosenRepo(repoPath)
          storeRepo(repoPath)
          setSelected(null)
          setSelectedCommit(null)
          setLineSelection(new Set())
        },
        onInit: () => {
          setPickerOpen(false)
          doInit()
        },
      })

      return E('div', { className: 'gwc-root gwc-mode-' + mode, ref: containerRef },
        header,
        navBar,
        /* The banner is a LAYOUT row, not an overlay. As an absolutely
           positioned toast it covered either the toolbar (top) or the commit
           button (bottom) depending on where it was pinned — a message must not
           hide the control the user needs next. In flow it pushes content down
           for as long as it is visible and never covers anything. */
        toast === null ? null : E('div', {
          className: cx('gwc-toast', toast.kind === 'error' ? 'is-error' : toast.kind === 'warn' ? 'is-warn' : 'is-ok'),
          role: toast.kind === 'error' ? 'alert' : 'status',
          'aria-live': toast.kind === 'error' ? 'assertive' : 'polite',
          title: t('toast.dismiss'),
          onClick: () => setToast(null),
        },
        E('span', { className: 'gwc-toastText' }, toast.message),
        E('span', { className: 'gwc-toastClose', 'aria-hidden': 'true' }, E(Icon, { name: 'close', size: 11 }))),
        E('div', { className: 'gwc-body' }, bodyFor()),
        busy === null ? null : E('div', { className: 'gwc-busy', 'aria-live': 'polite' }, busy),
        diffModal,
        fileCommitModal,
        dialogNode,
        pickerNode)
    }

    /* ============================== dialogs ============================== */

    function CommitDetails(props) {
      const { commit, t, onCherryPick, onRevert, onReset, onBranch, onTag, onFileClick } = props
      if (commit === null || commit === undefined) return E('div', { className: 'gwc-commitDetail' }, E('div', { className: 'gwc-empty' }, t('status.loading')))
      return E('div', { className: 'gwc-commitDetail' },
        E('div', { className: 'gwc-detailSubject' }, commit.subject),
        E('div', { className: 'gwc-detailMeta' },
          E('span', null, commit.short),
          E('span', null, commit.authorName),
          E('span', null, formatDate(commit.authorTime))),
        /* \%B\ includes the subject, so a commit with no body printed its subject a
           second time in this box. Show it only when there is more to say. */
        (commit.body.trim() === '' || commit.body.trim() === commit.subject.trim())
          ? null
          : E('pre', { className: 'gwc-detailBody' }, commit.body.trim()),

        E('div', { className: 'gwc-detailActions' },
          E(TextButton, { onClick: onCherryPick }, t('history.cherryPick')),
          E(TextButton, { onClick: onRevert }, t('history.revert')),
          E(TextButton, { onClick: onReset }, t('history.resetTo')),
          E(TextButton, { onClick: onBranch }, t('history.createBranch')),
          E(TextButton, { onClick: onTag }, t('history.createTag'))),
        commit.files.length === 0 ? null : E('div', { className: 'gwc-detailFiles' },
        E('div', { className: 'gwc-group' },
          E('div', { className: 'gwc-groupHead' }, E('span', { className: 'gwc-groupTitle' }, t('history.files', { n: commit.files.length }))),
          commit.files.map((file) => E('div', {
            key: file.path,
            className: 'gwc-changeRow',
            role: 'button',
            tabIndex: 0,
            title: file.path,
            onClick: () => onFileClick(file.path),
          },
          E('span', { className: cx('gwc-statusBadge', 'kind-' + (file.status === 'D' ? 'deleted' : file.status === 'A' ? 'added' : 'modified')) }, file.status),
          E('span', { className: 'gwc-changeName' }, baseName(file.path)),
          E('span', { className: 'gwc-changeDir' }, dirName(file.path)))))))
    }

    function BranchDialog(props) {
      const { t, onCancel, onSubmit, defaultStart } = props
      const [name, setName] = useState('')
      const [start, setStart] = useState(defaultStart === undefined ? '' : defaultStart)
      const [checkout, setCheckout] = useState(true)
      return E(Modal, {
        t,
        title: t('branches.new'),
        onClose: onCancel,
        footer: E(Fragment, null,
          E(TextButton, { onClick: onCancel }, t('dialog.cancel')),
          E(TextButton, {
            primary: true,
            disabled: name.trim() === '',
            onClick: () => {
              if (checkout) onSubmit({ name: name.trim() })
              else onSubmit({ name: name.trim() })
            },
          }, t('dialog.confirm'))),
      },
      E(Field, { label: t('dialog.branchName'), value: name, onChange: setName, autoFocus: true }),
      E(Field, { label: t('dialog.startPoint'), value: start, onChange: setStart }),
      E('div', { className: 'gwc-hint' }, checkout ? t('branches.checkout') : ''))
    }

    function TagDialog(props) {
      const { t, onCancel, onSubmit, rev } = props
      const [name, setName] = useState('')
      const [message, setMessage] = useState('')
      return E(Modal, {
        t,
        title: t('history.createTag'),
        onClose: onCancel,
        footer: E(Fragment, null,
          E(TextButton, { onClick: onCancel }, t('dialog.cancel')),
          E(TextButton, {
            primary: true,
            disabled: name.trim() === '',
            onClick: () => onSubmit({ name: name.trim(), message: message.trim(), ...(rev === undefined ? {} : { rev }) }),
          }, t('dialog.confirm'))),
      },
      E(Field, { label: t('dialog.tagName'), value: name, onChange: setName, autoFocus: true }),
      E(Field, { label: t('dialog.tagMessage'), value: message, onChange: setMessage, multiline: true }))
    }

    /**
     * Undo a tag. A tag is only a ref, so "撤销" never rewrites commits — it
     * either drops the local ref (recreatable from the commit) or also removes
     * the published one, which is the case that actually matters: a tag left on
     * the remote comes back on the next `fetch --tags`.
     *
     * "Also the remote" is ticked by DEFAULT, because that is the undo the user
     * usually means when a tag was already pushed by mistake. Untick it to keep
     * the release tag published and only drop the local copy.
     */
    function TagRevokeDialog(props) {
      const { t, name, onCancel, onSubmit } = props
      const [remoteToo, setRemoteToo] = useState(true)
      return E(Modal, {
        t,
        title: t('tag.revokeTitle', { name }),
        onClose: onCancel,
        footer: E(Fragment, null,
          E(TextButton, { onClick: onCancel }, t('dialog.cancel')),
          E(TextButton, {
            primary: true,
            danger: true,
            onClick: () => onSubmit({ name, remoteToo }),
          }, t('tag.revoke'))),
      },
      E(Checkbox, { label: t('tag.revokeRemote'), checked: remoteToo, onChange: setRemoteToo }),
      E('div', { className: 'gwc-warn' }, remoteToo ? t('tag.revokeWarnBoth') : t('tag.revokeWarnLocal')))
    }

    function ResetDialog(props) {
      const { t, onCancel, onSubmit } = props
      const [mode, setMode] = useState('mixed')
      return E(Modal, {
        t,
        title: t('history.resetTo'),
        onClose: onCancel,
        footer: E(Fragment, null,
          E(TextButton, { onClick: onCancel }, t('dialog.cancel')),
          E(TextButton, { primary: true, danger: mode === 'hard', onClick: () => onSubmit(mode) }, t('dialog.confirm'))),
      },
      E('label', { className: 'gwc-radio' },
        E('input', { type: 'radio', checked: mode === 'soft', onChange: () => setMode('soft') }),
        E('span', null, t('dialog.resetSoft'))),
      E('label', { className: 'gwc-radio' },
        E('input', { type: 'radio', checked: mode === 'mixed', onChange: () => setMode('mixed') }),
        E('span', null, t('dialog.resetMixed'))),
      E('label', { className: 'gwc-radio' },
        E('input', { type: 'radio', checked: mode === 'hard', onChange: () => setMode('hard') }),
        E('span', null, t('dialog.resetHard'))),
      mode === 'hard' ? E('div', { className: 'gwc-warn' }, t('dialog.resetHardWarn')) : null)
    }

    function DeleteBranchDialog(props) {
      const { t, name, onCancel, onSubmit } = props
      const [force, setForce] = useState(false)
      const [confirmProtected, setConfirmProtected] = useState(false)
      const isProtected = ['main', 'master', 'trunk', 'develop', 'development'].includes(name)
      return E(Modal, {
        t,
        title: t('dialog.deleteTitle', { name }),
        onClose: onCancel,
        footer: E(Fragment, null,
          E(TextButton, { onClick: onCancel }, t('dialog.cancel')),
          E(TextButton, {
            primary: true,
            danger: true,
            disabled: isProtected && !confirmProtected,
            onClick: () => onSubmit({ name, force, confirmProtected }),
          }, t('branches.delete'))),
      },
      E(Checkbox, { label: t('dialog.forceDelete'), checked: force, onChange: setForce }),
      isProtected ? E(Fragment, null,
        E(Checkbox, { label: t('dialog.protectedWarn', { name }), checked: confirmProtected, onChange: setConfirmProtected }),
        E('div', { className: 'gwc-warn' }, t('dialog.protectedWarn', { name }))) : null)
    }

    function StashDialog(props) {
      const { t, onCancel, onSubmit } = props
      const [message, setMessage] = useState('')
      const [includeUntracked, setIncludeUntracked] = useState(true)
      const [keepIndex, setKeepIndex] = useState(false)
      return E(Modal, {
        t,
        title: t('stash.create'),
        onClose: onCancel,
        footer: E(Fragment, null,
          E(TextButton, { onClick: onCancel }, t('dialog.cancel')),
          E(TextButton, { primary: true, onClick: () => onSubmit({ message: message.trim(), includeUntracked, keepIndex }) }, t('dialog.confirm'))),
      },
      E(Field, { label: t('stash.message'), value: message, onChange: setMessage, autoFocus: true }),
      E(Checkbox, { label: t('stash.includeUntracked'), checked: includeUntracked, onChange: setIncludeUntracked }),
      E(Checkbox, { label: t('stash.keepIndex'), checked: keepIndex, onChange: setKeepIndex }))
    }

    /* ============================== styles ============================== */

    const CSS = `
.gwc-root{display:flex;flex-direction:column;height:100%;min-height:0;position:relative;font-family:var(--dsw-font-family,system-ui);font-size:13px;color:var(--dsw-alias-label-primary,#e6e6e6);background:var(--dsw-alias-bg-base,transparent)}
.gwc-icon{flex:none;display:block}
.gwc-header{display:flex;align-items:center;gap:8px;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));min-height:34px}
.gwc-headerMain{display:flex;align-items:center;gap:6px;min-width:0;flex:1}
.gwc-branchIcon{display:flex;color:var(--dsw-alias-brand-primary,#4d6bfe)}
.gwc-branchName{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:46%}
.gwc-sync{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8f98);white-space:nowrap}
.gwc-headerActions{display:flex;gap:2px;flex:none}
/* position:relative so the dot can anchor to the corner; the 24px box itself is
   unchanged, which is what keeps the header row from growing. */
.gwc-iconBtn{position:relative;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#b6bac1);cursor:pointer}
.gwc-iconBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));color:var(--dsw-alias-label-primary,#fff)}
.gwc-iconBtn:disabled{opacity:.35;cursor:default}
/* Notification dot: OUT of the layout flow, so it cannot widen the button or
   push its neighbours. 6px + a 1px ring in the header background colour, which
   keeps it legible over both the icon and a hover fill. */
.gwc-dot{position:absolute;top:3px;right:3px;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-error-primary,#ff6b6b);box-shadow:0 0 0 1.5px var(--dsw-alias-bg-layer-1,#1b1e24);pointer-events:none}
.gwc-iconBtn:disabled .gwc-dot{opacity:.45}
.gwc-iconBtn.is-active{background:var(--dsw-alias-interactive-bg-active,rgba(77,107,254,.18));color:var(--dsw-alias-brand-primary,#7c93ff)}
.gwc-iconBtn.is-danger:hover:not(:disabled){color:var(--dsw-alias-state-error-primary,#ff6b6b)}
.gwc-nav{display:flex;gap:2px;padding:4px 6px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08))}
.gwc-navBtn{display:inline-flex;align-items:center;gap:5px;padding:4px 9px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#b6bac1);cursor:pointer;font-size:12px}
.gwc-navBtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.gwc-navBtn.is-active{background:var(--dsw-alias-interactive-bg-active,rgba(77,107,254,.16));color:var(--dsw-alias-label-primary,#fff)}
.gwc-badge{min-width:16px;padding:0 4px;border-radius:8px;background:var(--dsw-alias-state-business-primary,#4d6bfe);color:#fff;font-size:10px;line-height:15px;text-align:center}
.gwc-mode-compact .gwc-navLabel{display:none}
.gwc-body{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.gwc-changesWrap{display:flex;flex-direction:column;min-height:0;flex:1}
.gwc-changesScroll{overflow:auto;flex:1;min-height:0}
/* Two panes that scroll on their own: the list on top, the diff below. */
.gwc-changeListPane{flex:1 1 auto;overflow:auto;min-height:56px}
.gwc-diffScroll{flex:1 1 0;overflow:auto;min-height:0;display:flex;flex-direction:column}
/* Before the user picks a split: the diff shrinks to its content instead of
   hogging the leftover height (that leftover used to render as blank space). */
.gwc-diffScroll.is-auto{flex:0 1 auto;max-height:70%;min-height:0}
.gwc-changeListPane.is-auto{flex:1 1 auto}
.gwc-splitBar{flex:0 0 7px;display:flex;align-items:center;justify-content:center;cursor:row-resize;background:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.05));border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08))}
.gwc-splitBar:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.1))}
.gwc-splitGrip{width:34px;height:2px;border-radius:1px;background:var(--dsw-alias-border-l3,rgba(255,255,255,.28))}
/* The diff header stays visible while the diff body scrolls under it. */
.gwc-diffScroll .gwc-diffHead{position:sticky;top:0;z-index:2;background:var(--dsw-alias-bg-layer-1,#1b1e24)}
.gwc-changes{display:flex;flex-direction:column;min-height:0}
.gwc-group{padding:2px 0}
.gwc-groupHead{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px 10px;position:sticky;top:0;background:var(--dsw-alias-bg-base,#1a1d23);z-index:1;border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.06))}
/* First group has no divider above it: the nav bar already separates it. */
.gwc-group:first-child > .gwc-groupHead{border-top:none}
/* The bulk actions of one group sit together on the right of its title, so
   "全部暂存" and "全部撤销" never wrap onto separate lines in a narrow dock. */
.gwc-groupActions{display:flex;align-items:center;gap:2px;flex:none;margin-left:auto}
.gwc-groupTitle{font-size:11px;letter-spacing:.03em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,#8a8f98);font-weight:600}
.gwc-changeRow{display:flex;align-items:center;gap:7px;padding:4px 10px;cursor:pointer;min-height:26px;border-left:2px solid transparent}
.gwc-changeRow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.05))}
/* Selected: a left accent bar reads as "this is the file in the diff" without
   repainting the whole row, which used to make a 3-line list look like a block. */
.gwc-changeRow.is-selected{background:var(--dsw-alias-interactive-bg-active,rgba(77,107,254,.14));border-left-color:var(--dsw-alias-brand-primary,#4d6bfe)}
.gwc-statusBadge{width:15px;flex:none;text-align:center;font-size:11px;font-weight:700;font-family:var(--dsw-font-markdown-code-block,ui-monospace,monospace);color:var(--dsw-alias-state-warn-primary,#e2a03f)}
.gwc-statusBadge.kind-added,.gwc-statusBadge.kind-untracked{color:var(--dsw-alias-state-success-primary,#3fb950)}
.gwc-statusBadge.kind-deleted{color:var(--dsw-alias-state-error-primary,#ff6b6b)}
.gwc-statusBadge.kind-conflicted{color:var(--dsw-alias-state-error-primary,#ff6b6b)}
.gwc-changeName{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:none;max-width:55%}
.gwc-changeDir{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left;font-size:11px;color:var(--dsw-alias-label-tertiary,#7d838c)}
.gwc-changeStat{display:flex;gap:4px;font-size:11px;font-family:var(--dsw-font-markdown-code-block,monospace)}
.gwc-add{color:var(--dsw-alias-state-success-primary,#3fb950)}
.gwc-del{color:var(--dsw-alias-state-error-primary,#ff6b6b)}
.gwc-changeActions{display:none;gap:1px}
.gwc-changeRow:hover .gwc-changeActions,.gwc-changeRow.is-selected .gwc-changeActions{display:flex}
/* per-hunk action chips (only rendered when the host passes onHunkAction) */
.gwc-hunkBar{display:flex;align-items:center;gap:4px;flex:none;flex-wrap:wrap;padding:4px 8px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.02))}
.gwc-hunkBarLabel{flex:none;font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8f98)}
.gwc-hunkChip{display:inline-flex;align-items:center;gap:4px;padding:1px 4px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));border-radius:4px;font-size:10px}
/* File name for each section of a multi-file diff. Sticky so it stays visible while
   scrolling through that file's hunks — the whole point is to know which file you
   are looking at. */
.gwc-fileHead{flex:none;position:sticky;top:0;z-index:2;padding:3px 10px;font-family:var(--dsw-font-markdown-code-block,ui-monospace,monospace);font-size:11px;color:var(--dsw-alias-label-secondary,#b6bac1);background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.05));border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.09));border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.06));white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gwc-hunkBtn{border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));border-radius:3px;background:transparent;color:var(--dsw-alias-brand-primary,#4d6bfe);font:inherit;font-size:10px;padding:0 5px;line-height:15px 4px;cursor:pointer}
.gwc-hunkBtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.1))}
.gwc-hunkBtn.is-danger{color:var(--dsw-alias-state-error-primary,#ff6b6b)}
.gwc-diffPane{border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));flex:0 0 auto;min-height:0;display:flex;flex-direction:column}
.gwc-diffHead{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px 10px;background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.03))}
.gwc-diffTitle{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gwc-diff{overflow:visible;flex:0 0 auto;min-height:0;font-family:var(--dsw-font-markdown-code-block,ui-monospace,monospace);font-size:12px;line-height:1.5}
.gwc-hunk{border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.06))}
/* File name for each section of a multi-file diff. Sticky so it stays visible while
   scrolling through that file's hunks — the whole point is to know which file you
   are looking at. */
.gwc-fileHead{flex:none;position:sticky;top:0;z-index:2;padding:3px 10px;font-family:var(--dsw-font-markdown-code-block,ui-monospace,monospace);font-size:11px;color:var(--dsw-alias-label-secondary,#b6bac1);background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.05));border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.09));border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.06));white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gwc-hunkHead{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:2px 8px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.04));color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:11px}
.gwc-hunkTitle{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gwc-hunkActions{display:flex;gap:4px;flex:none;font-family:var(--dsw-font-family,ui-sans-serif,system-ui);font-weight:400}
.gwc-lines{display:flex;flex-direction:column}
.gwc-split{display:grid;grid-template-columns:1fr 1fr}
.gwc-splitCol{min-width:0;overflow:hidden}
.gwc-row{display:flex;align-items:flex-start;white-space:pre-wrap;word-break:break-all;padding:0 6px}
.gwc-row.is-add{background:var(--dsw-alias-file-diff-added-bg,rgba(63,185,80,.12))}
.gwc-row.is-del{background:var(--dsw-alias-file-diff-deleted-bg,rgba(255,107,107,.12))}
.gwc-row.is-selected{outline:1px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:-1px;background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 22%,transparent)}
.gwc-row.is-selectable{cursor:pointer}
.gwc-hunkSel{font-size:10px;color:var(--dsw-alias-brand-primary,#7c93ff);cursor:pointer;text-decoration:underline;margin-right:4px}
.gwc-row.is-meta{color:var(--dsw-alias-label-tertiary,#8a8f98);font-style:italic}
.gwc-gutter{flex:none;width:34px;text-align:right;padding-right:6px;color:var(--dsw-alias-label-tertiary,#6f757e);user-select:none;font-size:11px}
.gwc-sign{flex:none;width:12px;color:var(--dsw-alias-label-tertiary,#8a8f98);user-select:none}
.gwc-text{flex:1;min-width:0}
.gwc-empty{padding:18px 14px;color:var(--dsw-alias-label-tertiary,#8a8f98);text-align:center;font-size:12px}
.gwc-empty.is-error{color:var(--dsw-alias-state-error-primary,#ff6b6b)}
/* A real empty state, not a stranded line of grey text: icon, title, hint and
   the actions that are actually useful from here. */
.gwc-emptyState{padding:34px 20px;display:flex;flex-direction:column;align-items:center;text-align:center;color:var(--dsw-alias-label-tertiary,#8a8f98)}
.gwc-emptyIcon{width:38px;height:38px;border-radius:50%;display:flex;align-items:center;justify-content:center;margin-bottom:10px;background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#3fb950) 16%,transparent);color:var(--dsw-alias-state-success-primary,#3fb950)}
.gwc-emptyState .gwc-emptyTitle{font-size:13px;color:var(--dsw-alias-label-primary,#e6e6e6);margin-bottom:5px}
.gwc-emptyState .gwc-emptyHint{font-size:11px;line-height:1.6;max-width:34em;margin-bottom:14px}
.gwc-emptyActions{display:flex;gap:6px;flex-wrap:wrap;justify-content:center}
.gwc-emptyTitle{font-size:13px;color:var(--dsw-alias-label-primary,#e6e6e6);margin-bottom:4px}
.gwc-emptyHint{font-size:11px;margin-bottom:10px;line-height:1.5}
/* ---- Files page: search on the left, that file's history on the right ---- */
.gwc-files{display:flex;flex-direction:column;min-height:0;flex:1}
.gwc-fileBar{display:flex;align-items:center;gap:6px;padding:6px 8px;flex:none;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.06))}
.gwc-fileSearch{position:relative;display:flex;align-items:center;gap:6px;flex:1;min-width:0;padding:0 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));background:var(--dsw-alias-bg-base,#14161a)}
.gwc-fileSearch:focus-within{border-color:var(--dsw-alias-brand-primary,#4d6bfe)}
.gwc-fileInput{flex:1;min-width:0;border:none;background:transparent;padding:5px 0;font-size:12px;color:inherit}
.gwc-fileInput:focus{outline:none;box-shadow:0 0 0 1px var(--dsw-alias-brand-primary,#4d6bfe)}
.gwc-fileInput::-webkit-search-cancel-button{display:none}
.gwc-fileClear{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border:none;border-radius:4px;background:transparent;color:var(--dsw-alias-label-tertiary,#8a8f98);cursor:pointer;flex:none}
.gwc-fileClear:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.1));color:var(--dsw-alias-label-primary,#fff)}
.gwc-fileModes{display:flex;gap:2px;flex:none}
.gwc-fileMode{border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-tertiary,#8a8f98);border-radius:6px;padding:3px 8px;font-size:11px;cursor:pointer;white-space:nowrap}
.gwc-fileMode:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.gwc-fileMode.is-active{background:var(--dsw-alias-interactive-bg-active,rgba(77,107,254,.16));color:var(--dsw-alias-label-primary,#fff)}
.gwc-filesMain{display:flex;min-height:0;flex:1}
/* Split panes: results left, file history right. Stack in a narrow dock. */
.gwc-fileResults{flex:0 0 42%;min-width:0;overflow:auto;min-height:0;border-right:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.06))}
.gwc-fileHistory{flex:1 1 0;min-width:0;display:flex;flex-direction:column;min-height:0}
.gwc-mode-compact .gwc-filesMain,.gwc-mode-stack .gwc-filesMain{flex-direction:column}
.gwc-mode-compact .gwc-fileResults,.gwc-mode-stack .gwc-fileResults{flex:0 0 auto;max-height:45%;border-right:none;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.06))}
.gwc-fileRow{display:flex;align-items:center;gap:7px;padding:4px 10px;min-height:26px;cursor:pointer;border-left:2px solid transparent}
.gwc-fileRow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.05))}
.gwc-fileRow.is-selected{background:var(--dsw-alias-interactive-bg-active,rgba(77,107,254,.14));border-left-color:var(--dsw-alias-brand-primary,#4d6bfe)}
.gwc-fileRowName{flex:none;max-width:46%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px}
.gwc-fileRowDir{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left;font-size:11px;color:var(--dsw-alias-label-tertiary,#7d838c)}
.gwc-fileRowLine{flex:none;font-size:11px;color:var(--dsw-alias-brand-primary,#7c93ff);font-family:var(--dsw-font-markdown-code-block,monospace)}
/* Content hits wrap: the matched text is the reason the row exists. */
.gwc-fileRowText{flex:1 1 100%;min-width:0;font-size:11px;color:var(--dsw-alias-label-secondary,#b6bac1);font-family:var(--dsw-font-markdown-code-block,monospace);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;order:9}
.gwc-fileHistoryHead{display:flex;align-items:center;gap:6px;padding:6px 8px;flex:none;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.06));background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.02))}
.gwc-fileHistoryPath{flex:1;min-width:0;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left}
.gwc-fileLog{overflow:auto;flex:1 1 auto;min-height:0}
.gwc-fileLogCount{padding:5px 10px;font-size:10px;letter-spacing:.03em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,#8a8f98);position:sticky;top:0;background:var(--dsw-alias-bg-base,#1a1d23);z-index:1}
.gwc-fileLogRow{display:flex;align-items:baseline;gap:7px;padding:4px 10px;min-height:26px;cursor:pointer;border-left:2px solid transparent}
.gwc-fileLogRow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.05));border-left-color:var(--dsw-alias-border-l3,rgba(255,255,255,.2))}
.gwc-fileLogHash{flex:none;font-size:11px;font-family:var(--dsw-font-markdown-code-block,monospace);color:var(--dsw-alias-label-tertiary,#8a8f98)}
.gwc-fileLogSubject{flex:1;min-width:0;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gwc-fileLogMeta{display:flex;align-items:baseline;gap:6px;flex:none;font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8f98);white-space:nowrap}
.gwc-fileLogStat{display:flex;gap:4px;font-family:var(--dsw-font-markdown-code-block,monospace)}
.gwc-fileLogBin{font-style:italic}
/* The commit popup: compact metadata on top, the file's diff taking the rest.
   The diff is the reason the popup exists, so it gets the flexible height. */
.gwc-commitPopup{display:flex;flex-direction:column;min-height:0;height:min(72vh,760px)}
.gwc-commitPopupMeta{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8f98);flex:none;padding-bottom:5px}
.gwc-commitPopupHash{font-family:var(--dsw-font-markdown-code-block,monospace);color:var(--dsw-alias-brand-primary,#7c93ff)}
.gwc-commitPopupFile{flex:1;min-width:0;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;direction:rtl}
.gwc-commitPopupBody{flex:none;max-height:120px;overflow:auto;margin:0 0 6px;padding:6px 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.03));font-size:12px;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-secondary,#b6bac1)}
.gwc-commitPopupOthers{display:flex;flex-wrap:wrap;align-items:baseline;gap:5px;flex:none;margin-bottom:8px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8f98)}
.gwc-commitPopupOthersTitle{font-style:italic}
.gwc-commitPopupOther{border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));border-radius:8px;padding:0 6px;line-height:16px;max-width:12em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gwc-commitPopupDiffBar{display:flex;align-items:center;gap:6px;flex:none;padding:4px 0;border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08))}
.gwc-commitPopupDiffTitle{font-size:11px;letter-spacing:.03em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,#8a8f98)}
.gwc-commitPopupDiff{flex:1 1 auto;min-height:0;overflow:auto;border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.06))}
.gwc-mode-compact .gwc-fileLogAuthor,.gwc-mode-compact .gwc-fileLogTime{display:none}
.gwc-commitBox{flex:none;border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));padding:6px 8px;display:flex;flex-direction:column;gap:5px;background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.02))}
.gwc-commitInput{width:100%;resize:vertical;min-height:38px;max-height:140px;padding:5px 7px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));background:var(--dsw-alias-bg-base,#14161a);color:inherit;font:inherit;box-sizing:border-box}
.gwc-commitInput:focus{outline:none;box-shadow:0 0 0 1px var(--dsw-alias-brand-primary,#4d6bfe);border-color:var(--dsw-alias-brand-primary,#4d6bfe)}
.gwc-commitRow{display:flex;align-items:center;justify-content:space-between;gap:8px}
.gwc-check{display:flex;align-items:center;gap:5px;font-size:11px;color:var(--dsw-alias-label-secondary,#b6bac1);cursor:pointer}
.gwc-checkHint{color:var(--dsw-alias-label-tertiary,#8a8f98)}
.gwc-btn{border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.05));color:var(--dsw-alias-label-primary,#e6e6e6);border-radius:6px;padding:3px 9px;font-size:11px;cursor:pointer;white-space:nowrap}
.gwc-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.1))}
.gwc-btn:disabled{opacity:.4;cursor:default}
.gwc-btn.is-primary{background:var(--dsw-alias-button-primary-fill,#4d6bfe);border-color:transparent;color:var(--dsw-alias-label-primary-inverted,#fff)}
.gwc-btn.is-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#5d7bff)}
.gwc-btn.is-danger{color:var(--dsw-alias-state-error-primary,#ff6b6b);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ff6b6b) 40%,transparent)}
.gwc-history{display:flex;flex-direction:column;min-height:0;flex:1}
.gwc-historyBar{display:flex;gap:6px;align-items:center;padding:6px 8px}
.gwc-input{flex:1;min-width:0;padding:4px 7px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));background:var(--dsw-alias-bg-base,#14161a);color:inherit;font:inherit;font-size:12px}
.gwc-input:focus{outline:none;box-shadow:0 0 0 1px var(--dsw-alias-brand-primary,#4d6bfe);border-color:var(--dsw-alias-brand-primary,#4d6bfe)}
/* No scroll of its own: the pieces inside scroll separately, so reading the last
   changed file never pushes the commit subject or the action row out of view. */
/* flex-basis 0 (not auto): with auto the column grew with its content, so
   dragging only added height to the list instead of taking it from the detail. */
.gwc-historyMain{overflow:hidden;flex:1 1 0;min-height:0;display:flex;flex-direction:column}
/* The list and its load-more button form one block whose size the user drags
   against the commit detail below. */
.gwc-historyList{display:flex;flex-direction:column;flex:0 1 auto;min-height:56px}
.gwc-commitList{overflow:auto;flex:1 1 auto;min-height:0}
/* 变更文件 list: takes the remaining height and scrolls by itself. Sizing it from
   the AVAILABLE space (flex) rather than a percentage of an auto-height parent is
   what gives it a usable height instead of a sliver. */
.gwc-detailFiles{overflow:auto;flex:1 1 auto;min-height:0}
.gwc-detailFiles > .gwc-group{overflow:visible}
.gwc-commitDetail{display:flex;flex-direction:column;min-height:0;flex:1 1 0;overflow:hidden}
.gwc-commitRow{display:flex;align-items:center;gap:6px;padding:2px 8px;cursor:pointer;min-height:24px}
.gwc-commitRow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.05))}
.gwc-commitRow.is-selected{background:var(--dsw-alias-interactive-bg-active,rgba(77,107,254,.16))}
.gwc-graph{flex:none;overflow:visible}
.gwc-commitSubject{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px}
.gwc-commitRefs{display:flex;gap:3px;flex:none;max-width:42%;overflow:hidden}
.gwc-refPill{font-size:10px;padding:0 5px;border-radius:8px;border:1px solid currentColor;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:120px}
.gwc-refPill.is-local{color:var(--dsw-alias-state-success-primary,#3fb950)}
.gwc-refPill.is-remote{color:var(--dsw-alias-state-business-primary,#4d6bfe)}
.gwc-refPill.is-tag{color:var(--dsw-alias-state-warn-primary,#e2a03f)}
.gwc-loadMore{display:flex;justify-content:center;padding:8px}
.gwc-commitDetail{border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));padding:8px 10px}
.gwc-historyDiff{display:flex;flex-direction:column;min-height:0;flex:1 1 0;border-top:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));margin-top:6px}
.gwc-historyDiff .gwc-diffHead{position:sticky;top:0;z-index:2;background:var(--dsw-alias-bg-layer-1,#1b1e24)}
.gwc-historyDiff .gwc-diffScroll{flex:1 1 auto;min-height:0}
.gwc-historyDiffActions{display:flex;align-items:center;gap:4px}
.gwc-detailSubject{font-weight:600;margin-bottom:4px;word-break:break-word;flex:none}
.gwc-detailMeta{flex:none;display:flex;gap:10px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8f98);margin-bottom:6px;flex-wrap:wrap}
.gwc-detailBody{flex:0 1 auto;max-height:44%;overflow:auto;overscroll-behavior:contain;margin:0 0 6px;padding:6px 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.04));font-family:var(--dsw-font-markdown-code-block,monospace);font-size:11px;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-secondary,#b6bac1)}
.gwc-detailActions{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:8px;flex:none}
.gwc-branches,.gwc-stash{display:flex;flex-direction:column;min-height:0;flex:1;overflow:auto}
.gwc-branchBar{display:flex;align-items:center;gap:6px;padding:6px 8px;justify-content:space-between}
.gwc-branchRow{display:flex;align-items:center;gap:6px;padding:3px 10px;min-height:24px}
.gwc-branchRow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.05))}
.gwc-branchRow.is-head{font-weight:600}
.gwc-branchRowName{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gwc-syncMini{font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8f98)}
/* A tag that is not on the remote yet: this is the state that needs an action,
   so it is the one thing in a ref row that gets a coloured badge. */
.gwc-syncMini.is-unpublished{color:var(--dsw-alias-state-warn-primary,#e2a03f);border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary,#e2a03f) 45%,transparent);border-radius:8px;padding:0 5px;line-height:14px}
.gwc-branchRowActions{display:none;gap:3px;flex:none}
.gwc-branchRow:hover .gwc-branchRowActions{display:flex}
/* A tag that still needs publishing keeps its button VISIBLE: hiding the only
   way to push a tag behind a hover is why the command line felt like the only
   option. Other rows still reveal their actions on hover to stay quiet. */
.gwc-branchRow:has(.is-unpublished) .gwc-branchRowActions{display:flex}
.gwc-stashRow{display:flex;align-items:center;gap:8px;padding:4px 10px;min-height:26px}
.gwc-stashRow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.05))}
.gwc-stashRef{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8f98);font-family:var(--dsw-font-markdown-code-block,monospace);flex:none}
.gwc-stashSubject{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px}
.gwc-stashActions{display:flex;gap:3px;flex:none}
.gwc-conflictBar{display:flex;align-items:center;gap:8px;padding:6px 10px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ff6b6b) 14%,transparent);color:var(--dsw-alias-state-error-primary,#ff6b6b);font-size:12px;flex:none}
.gwc-conflictTitle{font-weight:600}
.gwc-conflictCount{flex:1;min-width:0;color:var(--dsw-alias-label-secondary,#b6bac1)}
.gwc-conflictActions{display:flex;gap:4px;flex:none}
/* Message banner: a normal flex row between the nav and the body.
   It used to be an absolutely positioned toast, which covered the toolbar when
   pinned top and the commit button when pinned bottom — a status message must
   never hide the control the user needs next. */
.gwc-toast{flex:none;display:flex;align-items:flex-start;gap:8px;margin:6px 8px 0;padding:6px 9px;border-radius:8px;font-size:12px;cursor:pointer;border:1px solid transparent}
.gwc-toastText{flex:1;min-width:0;line-height:1.45;word-break:break-word}
.gwc-toastClose{flex:none;display:flex;opacity:.6;margin-top:1px}
.gwc-toast:hover .gwc-toastClose{opacity:1}
.gwc-toast.is-ok{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#3fb950) 18%,var(--dsw-alias-bg-layer-2,#22262c));color:var(--dsw-alias-label-primary,#e6e6e6);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#3fb950) 40%,transparent)}
/* "Some remotes failed but the fetch worked": a warning, not an error — calling
   it an error is what made a successful fetch look broken. */
.gwc-toast.is-warn{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#e2a03f) 18%,var(--dsw-alias-bg-layer-2,#22262c));color:var(--dsw-alias-label-primary,#e6e6e6);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#e2a03f) 42%,transparent)}
.gwc-toast.is-error{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ff6b6b) 18%,var(--dsw-alias-bg-layer-2,#22262c));color:var(--dsw-alias-label-primary,#e6e6e6);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ff6b6b) 42%,transparent)}
/* Skeleton for the first snapshot: the panel keeps its shape instead of showing
   one line of grey text and then jumping when content arrives. */
.gwc-skeleton{padding:14px 10px}
.gwc-skelTitle{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8f98);margin-bottom:12px}
.gwc-skelRow{height:13px;border-radius:4px;margin-bottom:11px;background:linear-gradient(90deg,var(--dsw-alias-bg-layer-3,rgba(255,255,255,.06)) 25%,var(--dsw-alias-bg-layer-2,rgba(255,255,255,.12)) 37%,var(--dsw-alias-bg-layer-3,rgba(255,255,255,.06)) 63%);background-size:400% 100%;animation:gwc-shimmer 1.4s ease-in-out infinite}
@keyframes gwc-shimmer{0%{background-position:100% 0}100%{background-position:-100% 0}}
@media (prefers-reduced-motion:reduce){.gwc-skelRow{animation:none}}
.gwc-busy{position:absolute;top:6px;right:10px;font-size:10px;padding:2px 7px;border-radius:8px;background:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.1));color:var(--dsw-alias-label-tertiary,#8a8f98);z-index:20}
.gwc-root{position:relative}
.gwc-modalBackdrop{position:fixed;inset:0;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.5));display:flex;align-items:center;justify-content:center;z-index:1000;padding:16px}
.gwc-modal.is-wide{width:min(1100px,92vw);max-height:86vh}
.gwc-modal.is-wide .gwc-modalBody{flex:1 1 auto;min-height:0;overflow:hidden;padding:0}
.gwc-diffModal{display:flex;flex-direction:column;min-height:0;height:min(70vh,720px)}
.gwc-diffModal .gwc-diffScroll{flex:1 1 auto;min-height:0}.gwc-modal{width:min(440px,100%);max-height:80vh;display:flex;flex-direction:column;border-radius:var(--dsw-radius-lg,12px);border:1px solid var(--dsw-alias-border-l3,rgba(255,255,255,.16));background:var(--dsw-alias-bg-layer-2,#22262c);box-shadow:var(--dsw-elevation-prominent,0 12px 40px rgba(0,0,0,.5))}
.gwc-modalHead{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08))}
.gwc-modalTitle{font-weight:600;font-size:13px}
.gwc-modalBody{padding:12px;display:flex;flex-direction:column;gap:9px;overflow:auto}
.gwc-modalFoot{display:flex;justify-content:flex-end;gap:6px;padding:9px 12px;border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08))}
.gwc-field{display:flex;flex-direction:column;gap:4px}
.gwc-fieldLabel{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8f98)}
.gwc-dialogBody{font-size:12px;line-height:1.6;word-break:break-word}
.gwc-radio{display:flex;align-items:flex-start;gap:6px;font-size:12px;cursor:pointer;line-height:1.5}
.gwc-hint{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8f98)}
.gwc-warn{font-size:11px;color:var(--dsw-alias-state-error-primary,#ff6b6b);line-height:1.5}
.gwc-repoChip{display:inline-flex;align-items:center;gap:4px;max-width:40%;padding:2px 6px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));border-radius:6px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.05));color:var(--dsw-alias-label-primary,#e6e6e6);font:inherit;font-size:11px;cursor:pointer}
.gwc-repoChip:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.1))}
.gwc-repoChipName{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gwc-picker{display:flex;flex-direction:column;gap:6px;min-height:0}
.gwc-pickerTabs{display:flex;gap:4px}
.gwc-pickerTab{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#b6bac1);font:inherit;font-size:11px;cursor:pointer}
.gwc-pickerTab.is-active{background:var(--dsw-alias-interactive-bg-active,rgba(77,107,254,.18));color:var(--dsw-alias-label-primary,#fff);border-color:transparent}
.gwc-lib-pane{display:flex;flex-direction:column;gap:10px;min-height:0}
.gwc-lib-field{display:flex;flex-direction:column;gap:5px}
.gwc-lib-label{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8f98)}
.gwc-lib-inputRow{display:flex;gap:6px;align-items:center}
.gwc-lib-input{flex:1;min-width:0;padding:6px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));background:var(--dsw-alias-bg-base,#14161a);color:inherit;font:inherit;font-size:12px;font-family:var(--dsw-font-markdown-code-block,ui-monospace,monospace)}
.gwc-lib-input:focus{outline:none;box-shadow:0 0 0 1px var(--dsw-alias-brand-primary,#4d6bfe);border-color:var(--dsw-alias-brand-primary,#4d6bfe)}
.gwc-lib-browseBtn{flex:none;min-width:34px;height:30px;padding:0 9px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.05));color:var(--dsw-alias-label-primary,#e6e6e6);font:inherit;font-size:12px;cursor:pointer}
.gwc-lib-browseBtn.is-text{min-width:auto}
.gwc-lib-browseBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.1))}
.gwc-lib-browseBtn:disabled{opacity:.4;cursor:default}
.gwc-lib-verdict{display:flex;align-items:center;gap:7px;padding:6px 9px;border-radius:6px;font-size:12px;background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.04));color:var(--dsw-alias-label-secondary,#b6bac1)}
.gwc-lib-verdictDot{width:7px;height:7px;border-radius:50%;background:currentColor;flex:none}
.gwc-lib-verdict.is-good{color:var(--dsw-alias-state-success-primary,#3fb950)}
.gwc-lib-verdict.is-bad{color:var(--dsw-alias-state-error-primary,#ff6b6b)}
.gwc-lib-verdict.is-idle{color:var(--dsw-alias-label-tertiary,#8a8f98)}
.gwc-lib-recent{display:flex;flex-direction:column;gap:1px;max-height:120px;overflow:auto}
.gwc-lib-drives{display:flex;flex-wrap:wrap;gap:4px}
.gwc-lib-drive{padding:2px 9px;border-radius:5px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));background:transparent;color:var(--dsw-alias-label-secondary,#b6bac1);font:inherit;font-size:11px;cursor:pointer}
.gwc-lib-drive:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}
.gwc-lib-drive.is-active{background:var(--dsw-alias-interactive-bg-active,rgba(77,107,254,.18));color:var(--dsw-alias-label-primary,#fff);border-color:transparent}
.gwc-lib-list{display:flex;flex-direction:column;gap:1px;max-height:300px;overflow:auto;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));border-radius:8px;padding:3px}
.gwc-lib-row{display:flex;align-items:center;gap:7px;width:100%;padding:5px 7px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,#e6e6e6);font:inherit;font-size:12px;text-align:left;cursor:pointer}
.gwc-lib-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07))}
.gwc-lib-row.is-repo{font-weight:600}
.gwc-lib-row.is-current{background:var(--dsw-alias-interactive-bg-active,rgba(77,107,254,.16))}
.gwc-lib-row.is-up,.gwc-lib-row.is-hint{color:var(--dsw-alias-label-tertiary,#8a8f98)}
.gwc-lib-rowName{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gwc-lib-rowPath{font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8f98);max-width:45%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left}
.gwc-lib-rowBadge{font-size:10px;color:var(--dsw-alias-state-success-primary,#3fb950);flex:none}
.gwc-lib-rowHash{font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8f98);font-family:var(--dsw-font-markdown-code-block,monospace);flex:none}
.gwc-lib-hint{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8f98);line-height:1.5}
.gwc-lib-footerRight{display:flex;gap:6px;margin-left:auto}
.gwc-pickerPathBar{display:flex;align-items:center;gap:6px}
.gwc-pickerPathActions{display:flex;align-items:center;gap:4px;flex:none}
.gwc-pickerDrive{max-width:96px;padding:2px 4px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.05));color:inherit;font:inherit;font-size:11px}
.gwc-pickerPathText{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gwc-pickerPath{display:flex;align-items:center;gap:5px;font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8f98);font-family:var(--dsw-font-markdown-code-block,monospace);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gwc-pickerList{max-height:340px;overflow:auto;display:flex;flex-direction:column;gap:1px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));border-radius:8px;padding:3px}
.gwc-repoRow{display:flex;align-items:center;gap:7px;width:100%;padding:5px 7px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,#e6e6e6);font:inherit;font-size:12px;text-align:left;cursor:pointer}
.gwc-repoRow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07))}
.gwc-repoRow.is-current{background:var(--dsw-alias-interactive-bg-active,rgba(77,107,254,.16))}
.gwc-repoRow.is-repo{font-weight:600}
.gwc-repoRow.is-up,.gwc-repoRow.is-hint{color:var(--dsw-alias-label-tertiary,#8a8f98)}
.gwc-repoRowName{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gwc-repoRowMeta{font-size:10px;color:var(--dsw-alias-state-success-primary,#3fb950);flex:none}
.gwc-repoRowHash{font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8f98);font-family:var(--dsw-font-markdown-code-block,monospace);flex:none}
.gwc-pickerNote{font-size:10px;color:var(--dsw-alias-state-warn-primary,#e2a03f);line-height:1.4}
.gwc-pickerFoot{flex:1;display:flex;justify-content:flex-start}.gwc-mode-stack .gwc-diffPane{max-height:52%}
.gwc-mode-compact .gwc-changeDir{display:none}
`

    /* ============================== registration ============================== */

    /* The live diff pane, when some OTHER page has composed it. Module scope
       because `commands.showDiff` is invoked from outside React (the host page
       reacts to a click in ITS tree), and there is one composed pane per page. */
    const diffPaneRef = { current: null }

    function apply(ctx) {
      const style = document.createElement('style')
      style.setAttribute('data-dsh-gitcraft', '')
      style.textContent = CSS
      document.head.appendChild(style)
      ctx.effect(() => () => { style.remove() }, 'dsh-gitcraft: panel styles')

      const t = translatorOf(ctx)

      const localeService = ctx.get('locale')
      if (localeService !== undefined && typeof localeService.register === 'function') {
        ctx.effect(
          () => localeService.register(LOCALE_NS, Object.assign({ zh: ZH, en: EN }, LOCALES)),
          'dsh-gitcraft: locale dictionaries',
        )
      }

      /* ONE registration path: this plugin contributes a PAGE to the workbench
         dock (`dsh-workbay-dock`) and never registers a dsh-better-sidebar
         tab. The dock owns the header button and the standalone right-side pane;
         this half only supplies the panel component.
         The registry is one browser global so either bundle may load first. */
      const registerWithDock = () => {
        const dock = typeof window === 'object' && window !== null ? window.__DSH_WORKBAY__ : undefined
        if (dock === undefined || dock === null || typeof dock.registerPage !== 'function') return false
        try {
          const off = dock.registerPage({
            id: 'gitcraft',
            title: t('title'),
            order: 20,
            hidden: true,
            /* Hidden from the tab strip, still registered: the source-control page
               composes this page's `panes.diff` and calls its RPC. Flip back to false
               to restore the standalone page. */
            icon: (size) => E(Icon, { name: 'commit', size: size === undefined ? 16 : size }),
            component: (pageProps) => E(LocaleLive, {
              ctx,
              /* the dock hands its own scope through; the panel resolves either
                 the {sessionId, cwd} shape or the flat one. */
              scope: pageProps !== undefined && pageProps.scope !== undefined
                ? pageProps.scope
                : { sessionId: pageProps === undefined ? undefined : pageProps.sessionId, cwd: pageProps === undefined ? undefined : pageProps.cwd },
              t,
              visible: true,
              docked: true,
            }),
            /* ── Embedding surface (optional; see docs/panes-contract.md) ──
             *
             * The source-control page composes this diff renderer into its own
             * content area, next to ITS tree, so the user sees a file and its
             * patch without leaving the page. It reuses the same `DiffView` the
             * in-page modal uses, so a diff never looks different depending on
             * where it was opened from.
             */
            panes: {
              diff: (container, paneApi) => {
                const repoRoot = paneApi !== null && paneApi !== undefined && typeof paneApi.repoRoot === 'string'
                  ? paneApi.repoRoot
                  : ''
                const mounted = mountDiffPane(container, paneApi, ctx, t, { repoRoot })
                /**
                 * Only the PRIMARY pane registers its handle for `commands`.
                 *
                 * A host may mount this pane more than once — the workbench page
                 * does, to show a commit's patch beside the working-tree diff. With
                 * a single module-level ref the second mount overwrote the first,
                 * so `commands.showDiff` (the working-tree path) started steering the
                 * COMMIT pane and the real diff stopped updating. That is the
                 * "clicking a change shows nothing" report.
                 *
                 * `primary` defaults to true so an existing caller is unaffected.
                 */
                const isPrimary = paneApi === null || paneApi === undefined || paneApi.primary !== false
                if (isPrimary && mounted !== null && mounted !== undefined && mounted.handle !== undefined) {
                  diffPaneRef.current = mounted.handle
                }
                /* Return the full contract: the host needs BOTH halves. Returning a
                   bare dispose function left the host without a handle, so anything
                   it pushed into this pane was silently dropped. */
                return {
                  handle: mounted !== null && mounted !== undefined ? mounted.handle : { showDiff() {} },
                  dispose: () => {
                    if (isPrimary) diffPaneRef.current = null
                    if (mounted !== null && mounted !== undefined && typeof mounted.dispose === 'function') mounted.dispose()
                  },
                }
              },
            },
            commands: {
              /** Show the working-tree diff for a REPOSITORY-relative path. */
              showDiff: (path, options) => {
                if (diffPaneRef.current !== null) diffPaneRef.current.showDiff(path, options)
              },
            },
          })
          ctx.effect(() => off, 'dsh-gitcraft: workbench page')
          return true
        } catch (error) {
          try { console.error('[gitcraft] workbench page registration failed:', error) } catch { void error }
          return false
        }
      }

      /* The dock may not have loaded yet (both are separate bundles with no
         ordering guarantee). Poll briefly, then give up quietly: without a dock
         there is nowhere to render, and a retry loop would outlive the seat. */
      if (!registerWithDock()) {
        let attempts = 0
        const timer = setInterval(() => {
          attempts += 1
          if (registerWithDock() || attempts >= 40) clearInterval(timer)
        }, 250)
        ctx.effect(() => () => clearInterval(timer), 'dsh-gitcraft: dock discovery')
      }
    }

    function LocaleLive(props) {
      const [tick, setTick] = useState(0)
      useEffect(() => {
        const locale = props.ctx === undefined ? undefined : props.ctx.get('locale')
        if (locale === undefined || typeof locale.subscribe !== 'function') return undefined
        const unsubscribe = locale.subscribe(() => { setTick((value) => value + 1) })
        return typeof unsubscribe === 'function' ? unsubscribe : undefined
      }, [props.ctx])
      void tick
      /* Pass the seat's own props through: Panel.scopeOf knows both shapes
         (better-sidebar's scope object and the native seat's flat props). */
      return E(Panel, {
        scope: props.scope,
        sessionId: props.sessionId,
        cwd: props.cwd,
        repoRoot: props.repoRoot,
        t: props.t,
        ctx: props.ctx,
        visible: props.visible,
      })
    }

    return { apply, name: 'dsh-gitcraft' }
  },
})

















