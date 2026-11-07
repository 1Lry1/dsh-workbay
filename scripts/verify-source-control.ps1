# Verify that the source-control page is actually installed in the DSH profile.
#
# Read-only. Answers ONE question: is the new page present in the copy DSH will
# load, and is that copy consistent? Run it after `pnpm run install:profile`.
#
# Usage:  pwsh -NoProfile -File scripts/verify-source-control.ps1

$ErrorActionPreference = 'Stop'

$profileRoot = if ($env:DSH_PROFILE_DIR) { $env:DSH_PROFILE_DIR } else { Join-Path $env:USERPROFILE '.dsh\profiles\desktop' }
$installed = Join-Path $profileRoot 'node_modules\dsh-workbay-suite'
$repoRoot = Split-Path -Parent $PSScriptRoot
$built = Join-Path $repoRoot 'packages\suite'

$problems = @()
$ok = @()

function Note($list, $text) { $list += $text }

if (-not (Test-Path $installed)) {
  Write-Host "FAIL  no installed suite at $installed" -ForegroundColor Red
  Write-Host '      the profile does not use dsh-workbay-suite (five-package mode?), or it is not installed '
  exit 1
}

# 1. the vendored host half
$vendorHost = Join-Path $installed 'vendor\source-control\src\index.js'
if (Test-Path $vendorHost) { $ok += 'vendor/source-control/src/index.js exists' }
else { $problems += 'vendor/source-control/src/index.js is MISSING (the page has no host half installed)' }

# 2. the vendored client half
$vendorClient = Join-Path $installed 'vendor\source-control\src\client.js'
if (Test-Path $vendorClient) { $ok += 'vendor/source-control/src/client.js exists' }
else { $problems += 'vendor/source-control/src/client.js is MISSING' }

# 3. the merged client bundle must CONTAIN the page code, not merely sit next to it
$mergedClient = Join-Path $installed 'client.js'
if (Test-Path $mergedClient) {
  $text = Get-Content $mergedClient -Raw
  if ($text -match 'dsh-workbay-source-control') { $ok += 'merged client.js contains the source-control bundle' }
  else { $problems += 'merged client.js does NOT contain the source-control bundle (stale copy)' }

  # The registry's get() is what lets the shell reach the other pages' panes.
  if ($text -match 'get\(id\)\s*\{\s*return\s+entries\.get') { $ok += 'merged client.js has the registry get(id) method' }
  else { $problems += 'merged client.js lacks registry get(id) — the shell cannot reach the panes' }

  # The panes the shell composes must also be present.
  if ($text -match 'mountSourcePane') { $ok += 'files pane (mountSourcePane) is in the build' }
  else { $problems += 'files pane (mountSourcePane) is missing — the editor pane would be blank' }
  if ($text -match 'mountDiffPane') { $ok += 'gitcraft pane (mountDiffPane) is in the build' }
  else { $problems += 'gitcraft pane (mountDiffPane) is missing — the diff pane would be blank' }
} else {
  $problems += 'no merged client.js in the installed suite'
}

# 4. the merged host must mount the new bundle's host half
$mergedHost = Join-Path $installed 'lib\index.js'
if (Test-Path $mergedHost) {
  $hostText = Get-Content $mergedHost -Raw
  if ($hostText -match 'source-control') { $ok += 'merged host mounts the source-control row' }
  else { $problems += 'merged host does NOT mount source-control (its diagnostic route is absent)' }
} else {
  $problems += 'no lib/index.js in the installed suite'
}

# 5. the installed copy should match what we just built (a stale copy is the #1
#    cause of "I changed it and nothing happened")
if (Test-Path (Join-Path $built 'client.js')) {
  $builtHash = (Get-FileHash (Join-Path $built 'client.js') -Algorithm SHA256).Hash
  $installedHash = (Get-FileHash $mergedClient -Algorithm SHA256).Hash
  if ($builtHash -eq $installedHash) { $ok += 'installed client.js is byte-identical to the build' }
  else { $problems += 'installed client.js DIFFERS from the build — the profile was not reinstalled after building' }
}

# 6. no stray standalone copies (they would double-register routes)
$deps = Join-Path $profileRoot 'package.json'
if (Test-Path $deps) {
  $manifest = Get-Content $deps -Raw | ConvertFrom-Json
  $extra = @('dsh-workbay-files', 'dsh-gitcraft', 'dsh-workbay-source-control') |
    Where-Object { $manifest.dependencies.PSObject.Properties.Name -contains $_ }
  if ($extra.Count -gt 0) { $problems += ('profile also depends on ' + ($extra -join ', ') + ' — remove them, they double-register') }
  else { $ok += 'profile carries no standalone copies of the composed pages' }
}

Write-Host ''
foreach ($line in $ok) { Write-Host ('  ok    ' + $line) -ForegroundColor Green }
foreach ($line in $problems) { Write-Host ('  FAIL  ' + $line) -ForegroundColor Red }

Write-Host ''
if ($problems.Count -eq 0) {
  Write-Host 'installed copy is consistent — restart DSH and look for the 源码管理 tab' -ForegroundColor Cyan
  exit 0
}
Write-Host ($problems.Count.ToString() + ' problem(s). If the copy is stale, quit DSH completely and run pnpm run install:profile.') -ForegroundColor Yellow
exit 1
