<#
.SYNOPSIS
  Fast-forward this checkout from GitHub and reinstall the DSH profile from it.

.DESCRIPTION
  The profile installs the bundles from this checkout through `file:`
  dependencies, and pnpm COPIES those into the profile — so "use the GitHub
  version" means: pull the clone, then reinstall the profile.

  DSH must be closed (not minimized): the downloader keeps AbSerialHost.exe and,
  after a flashing session, DownloaderIpcBridge.exe alive, and both hold files
  open inside the plugin directories. pnpm then fails with ERR_PNPM_EPERM.

  Local commits and a dirty working tree are refused, not merged: this script
  only ever fast-forwards.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/update-from-github.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/update-from-github.ps1 -Profile headless -SkipTests
#>
param(
  [string] $Profile = 'desktop',
  [string] $Remote = 'origin',
  [string] $Branch = 'main',
  [switch] $SkipTests
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $repoRoot '.git'))) { throw "not a git checkout: $repoRoot" }

Push-Location $repoRoot
try {
  Write-Host "fetching $Remote..." -ForegroundColor Cyan
  git fetch --prune $Remote
  if ($LASTEXITCODE -ne 0) { throw 'git fetch failed' }

  $before = (git rev-parse --short HEAD).Trim()
  git merge --ff-only "$Remote/$Branch"
  if ($LASTEXITCODE -ne 0) {
    throw "cannot fast-forward onto $Remote/$Branch — commit, stash or reset local changes first"
  }
  $after = (git rev-parse --short HEAD).Trim()
  if ($before -eq $after) { Write-Host "already at $after" } else { Write-Host "updated $before -> $after" -ForegroundColor Green }

  if (-not $SkipTests) {
    Write-Host 'running tests before touching the profile...' -ForegroundColor Cyan
    pnpm -r --if-present run test
    if ($LASTEXITCODE -ne 0) { throw 'tests failed — the profile was left untouched' }
  }
} finally {
  Pop-Location
}

& (Join-Path $PSScriptRoot 'refresh-profile.ps1') -Profile $Profile
