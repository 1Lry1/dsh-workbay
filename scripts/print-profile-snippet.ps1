<#
.SYNOPSIS
  Print the profile package.json snippet needed to install these bundles.

.DESCRIPTION
  The plugins are not on npm yet: they install from a clone through `file:`
  dependencies. Paths, bundle names and JSON shape are easy to get wrong by
  hand, so this prints exactly what to paste, with the paths already resolved to
  this checkout.

  It does NOT edit the profile: rewriting someone's package.json (providers,
  model catalogs, promo config) is not something a helper script should do.

.EXAMPLE
  pwsh -File scripts/print-profile-snippet.ps1
  pwsh -File scripts/print-profile-snippet.ps1 -Json   # machine-readable
#>
param(
  [string] $RepoRoot = (Split-Path -Parent $PSScriptRoot),
  [switch] $Json
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
if (-not (Test-Path (Join-Path $repoRoot 'packages\dock\package.json'))) {
  throw "not a dsh-workbay checkout: $repoRoot"
}

$posix = $repoRoot.Replace('\', '/')
$bundles = @('dsh-workbay-dock', 'dsh-gitcraft', 'dsh-downloader')
$deps = [ordered]@{
  'dsh-workbay-dock'  = "file:$posix/packages/dock"
  'dsh-gitcraft'      = "file:$posix/packages/gitcraft"
  'dsh-downloader'    = "file:$posix/packages/downloader"
  '@dsh-workbay/kit'  = "file:$posix/packages/kit"
}

if ($Json) {
  [ordered]@{ bundles = $bundles; dependencies = $deps } | ConvertTo-Json -Depth 5
  return
}

Write-Host "checkout: $repoRoot" -ForegroundColor Cyan
Write-Host ''
Write-Host 'Add these to dsh.profile.bundles (keep the entries already there):' -ForegroundColor Yellow
foreach ($name in $bundles) { Write-Host ('  "{0}",' -f $name) }
Write-Host ''
Write-Host 'Add these to dependencies (keep the entries already there):' -ForegroundColor Yellow
foreach ($key in $deps.Keys) { Write-Host ('  "{0}": "{1}",' -f $key, $deps[$key]) }
Write-Host ''
Write-Host 'Then, with DSH closed:' -ForegroundColor Yellow
Write-Host '  cd $env:USERPROFILE\.dsh\profiles\<profile>'
Write-Host '  pnpm install'
