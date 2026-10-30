<#
.SYNOPSIS
  Reinstall a DSH profile's plugin tree from this monorepo.

.DESCRIPTION
  DSH loads its plugins from <profile>/node_modules, and a `file:` dependency is
  COPIED there by pnpm — editing packages/* in this repo does nothing until the
  profile is reinstalled. Run this with DSH CLOSED: the downloader plugin keeps a
  serial helper (AbSerialHost.exe) and, after a flashing session, an IPC bridge
  (DownloaderIpcBridge.exe) alive, and both hold files open inside the plugin dir.
  pnpm then fails with ERR_PNPM_EPERM while renaming the package.

.EXAMPLE
  pwsh -File scripts/refresh-profile.ps1
  pwsh -File scripts/refresh-profile.ps1 -Profile desktop
#>
param(
  [string] $Profile = 'desktop'
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$profileDir = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile"

if (-not (Test-Path $profileDir)) { throw "profile not found: $profileDir" }
if (-not (Test-Path (Join-Path $repoRoot 'packages'))) { throw "not a dsh-workbay checkout: $repoRoot" }

$blockers = Get-Process -ErrorAction SilentlyContinue |
  Where-Object { $_.ProcessName -in @('AbSerialHost', 'DownloaderIpcBridge', 'DeepSeek Harness') }
if ($blockers.Count -gt 0) {
  $list = ($blockers | ForEach-Object { "$($_.ProcessName) (PID $($_.Id))" }) -join ', '
  Write-Warning "these processes hold the plugin tree open: $list"
  throw 'close DSH first, then run this script again'
}

Push-Location $profileDir
try {
  Write-Host "installing profile '$Profile' from $repoRoot" -ForegroundColor Cyan
  pnpm install --no-frozen-lockfile
  if ($LASTEXITCODE -ne 0) { throw "pnpm install failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}

# The host halves of dock and gitcraft import the shared kit; a profile that
# copied only the plugin folders would load them and crash on that import.
$kit = Join-Path $profileDir 'node_modules\@dsh-workbay\kit\package.json'
if (-not (Test-Path $kit)) { throw '@dsh-workbay/kit is missing from the profile — the dock and gitcraft hosts would fail to load' }

# Leftover plugin copies from a migration or a rename (e.g. dsh-downloader.old-*)
# are only deletable once DSH and its helpers have exited, which is exactly the
# precondition this script already enforces.
$pluginsDir = Join-Path $env:USERPROFILE '.dsh\plugins'
if (Test-Path $pluginsDir) {
  foreach ($stale in Get-ChildItem $pluginsDir -Directory -Filter '*.old-*' -ErrorAction SilentlyContinue) {
    try {
      Remove-Item $stale.FullName -Recurse -Force
      Write-Host "removed stale plugin copy $($stale.Name)"
    } catch {
      Write-Warning "could not remove $($stale.Name): $($_.Exception.Message)"
    }
  }
}

Write-Host 'ok — restart DSH to load the new code' -ForegroundColor Green
