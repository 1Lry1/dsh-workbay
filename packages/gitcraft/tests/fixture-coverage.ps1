# 生成 coverage.e2e 需要的仓库状态：
#   - 4+ 个提交（含可搜索关键字）
#   - 1 个标签、1 个额外分支（已合并，因此有分支行）
#   - 已暂存改动 + 未暂存改动 + 未跟踪文件
#   - 1 条 stash
#   - 进行中的 merge 冲突（用于冲突横幅）
param(
  [Parameter(Mandatory = $true)][string]$Repo
)

$ErrorActionPreference = 'Stop'
$WarningPreference = 'SilentlyContinue'

if (Test-Path $Repo) { Remove-Item $Repo -Recurse -Force }
New-Item -ItemType Directory -Path $Repo | Out-Null

git init -q -b main $Repo
git -C $Repo config user.name 'Coverage Tester'
git -C $Repo config user.email 'cov@example.com'
git -C $Repo config commit.gpgsign false
git -C $Repo config core.autocrlf false
git -C $Repo config advice.detachedHead false

function Write-Rel([string]$rel, [string]$content) {
  $full = Join-Path $Repo $rel
  $dir = Split-Path $full -Parent
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  Set-Content -LiteralPath $full -Value $content -Encoding utf8
}

# --- commits, with a searchable word in the subjects ---------------------
Write-Rel 'base.txt' "base`n"
git -C $Repo add . ; git -C $Repo commit -qm 'feat: seed the base file'

Write-Rel 'data.txt' ((1..40 | ForEach-Object { "row $_" }) -join "`n")
git -C $Repo add . ; git -C $Repo commit -qm 'feat: seed the data rows'

Write-Rel 'extra.txt' "extra`n"
git -C $Repo add . ; git -C $Repo commit -qm 'chore: seed an extra file'

git -C $Repo tag -a v1.0.0 -m 'coverage tag'

# --- a side branch, merged back so a second branch row exists -----------
git -C $Repo checkout -q -b side
Write-Rel 'side.txt' "side`n"
git -C $Repo add . ; git -C $Repo commit -qm 'feat: side branch work'
git -C $Repo checkout -q main
git -C $Repo merge -q --no-ff side -m 'chore: merge side'

# --- one stash entry -----------------------------------------------------
Write-Rel 'stashme.txt' "stash me`n"
git -C $Repo add stashme.txt
git -C $Repo stash push -u -m 'coverage stash' -q

# --- working state: unstaged edits + staged file + untracked file --------
$lines = Get-Content (Join-Path $Repo 'data.txt')
$lines[2] = 'row 3 EDITED'
$lines[30] = 'row 31 EDITED'
Set-Content -LiteralPath (Join-Path $Repo 'data.txt') -Value ($lines -join "`n") -Encoding utf8

Write-Rel 'staged.txt' "already staged`n"
git -C $Repo add staged.txt

Write-Rel 'untracked.txt' "brand new`n"

# --- an in-progress merge conflict --------------------------------------
git -C $Repo checkout -q -b conflict-side
Write-Rel 'conflict.txt' "side version`n"
git -C $Repo add conflict.txt
git -C $Repo commit -qm 'feat: conflict side'

git -C $Repo checkout -q main
Write-Rel 'conflict.txt' "main version`n"
git -C $Repo add conflict.txt
git -C $Repo commit -qm 'feat: conflict main'

# Start the merge; a conflicting merge exits 1, which is the state we want.
git -C $Repo merge conflict-side > $null 2>&1

Write-Host "repo ready: $Repo"
Write-Host ("  commits : " + (git -C $Repo rev-list --count HEAD))
Write-Host ("  branches: " + ((git -C $Repo branch --format='%(refname:short)') -join ', '))
Write-Host ("  stash   : " + ((git -C $Repo stash list) -join ' | '))
Write-Host ("  status  :")
git -C $Repo status --short | ForEach-Object { Write-Host ("    " + $_) }
