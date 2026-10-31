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
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/refresh-profile.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/refresh-profile.ps1 -Profile desktop
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

# The files page lazy-loads CodeMirror from lib/chunks/, which is generated and
# gitignored. Bake it before copying, or the editor/viewers fail at first open.
Push-Location $repoRoot
try {
  Write-Host 'building lazy chunks...' -ForegroundColor Cyan
  pnpm run build
  if ($LASTEXITCODE -ne 0) { throw 'chunk build failed' }
} finally {
  Pop-Location
}

Push-Location $profileDir
try {
  # pnpm does NOT notice content changes inside a `file:` directory dependency
  # when the package version is unchanged: it reports "Already up to date" and
  # the profile keeps the OLD copy. Drop the copied packages first so the install
  # has to import them again.
  $profilePkgPath = Join-Path $profileDir 'package.json'
  if (Test-Path $profilePkgPath) {
    $profilePkg = Get-Content $profilePkgPath -Raw | ConvertFrom-Json
    if ($null -ne $profilePkg.dependencies) {
      $modulesDir = Join-Path $profileDir 'node_modules'
      foreach ($dep in $profilePkg.dependencies.PSObject.Properties) {
        if ($dep.Value -isnot [string] -or $dep.Value -notmatch '^(file:|link:)') { continue }
        $depPath = Join-Path $modulesDir $dep.Name
        if (Test-Path $depPath) {
          Remove-Item $depPath -Recurse -Force
          Write-Host "dropped stale copy of $($dep.Name)"
        }
      }
    }
  }

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
