/**
 * Verify that the profile's installed workbench is COMPLETE and matches the checkout.
 *
 * Two supported layouts:
 *
 *   merged (default) — the profile depends on `dsh-workbay-suite` only. That one
 *   package vendors the five bundles, so the plugin list shows exactly one entry.
 *
 *   standalone — the profile depends on dock/files/terminal/gitcraft/downloader
 *   (+ kit) and lists them in `dsh.profile.bundles`. Kept for development.
 *
 * Why the harshness: `file:` dependencies are copies. If a helper
 * (AbSerialHost / DownloaderIpcBridge / WorkbayPty) or DSH holds a file open,
 * Windows lets pnpm leave a PARTIAL package and still exit 0 — the page then
 * silently disappears (this happened to the downloader twice).
 *
 * Usage: node scripts/verify-profile.mjs [profile-dir]
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const profileDir = process.argv[2] ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'profiles', 'desktop')
const installedRoot = path.join(profileDir, 'node_modules')

/** Merged layout: every file that must exist in the installed suite. */
const SUITE_FILES = [
  'package.json',
  'cordis.patch.yml',
  'lib/index.js',
  'client.js',
  'vendor/dock/package.json',
  'vendor/dock/src/index.js',
  'vendor/dock/src/client.js',
  'vendor/files/package.json',
  'vendor/files/src/index.js',
  'vendor/files/src/client.js',
  'vendor/files/lib/chunks/editor.js',
  'vendor/terminal/package.json',
  'vendor/terminal/src/index.js',
  'vendor/terminal/src/client.js',
  'vendor/terminal/lib/chunks/xterm.js',
  'vendor/terminal/helper/WorkbayPty.exe',
  'vendor/gitcraft/package.json',
  'vendor/gitcraft/src/index.js',
  'vendor/gitcraft/src/client.js',
  'vendor/downloader/package.json',
  'vendor/downloader/lib/index.js',
  'vendor/downloader/lib/client.js',
  'vendor/downloader/helper/AbSerialHost.exe',
  'vendor/downloader/ipc-helper/DownloaderIpcBridge.exe',
  'vendor/kit/package.json',
  'vendor/kit/src/host.js',
]

/** Standalone layout (development): installed package name -> files. */
const STANDALONE = {
  'dsh-workbay-dock': ['package.json', 'cordis.patch.yml', 'src/index.js', 'src/client.js'],
  'dsh-workbay-files': ['package.json', 'cordis.patch.yml', 'src/index.js', 'src/client.js', 'lib/chunks/editor.js'],
  'dsh-workbay-terminal': ['package.json', 'cordis.patch.yml', 'src/index.js', 'src/client.js', 'lib/chunks/xterm.js', 'helper/WorkbayPty.exe'],
  'dsh-gitcraft': ['package.json', 'cordis.patch.yml', 'src/index.js', 'src/client.js'],
  'dsh-downloader': ['package.json', 'cordis.patch.yml', 'lib/index.js', 'lib/client.js', 'helper/AbSerialHost.exe', 'ipc-helper/DownloaderIpcBridge.exe'],
  '@dsh-workbay/kit': ['package.json', 'src/host.js'],
}
const STANDALONE_SOURCE = {
  'dsh-workbay-dock': 'dock',
  'dsh-workbay-files': 'files',
  'dsh-workbay-terminal': 'terminal',
  'dsh-gitcraft': 'gitcraft',
  'dsh-downloader': 'downloader',
  '@dsh-workbay/kit': 'kit',
}

const failures = []
const warnings = []

function digest(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** Compare one installed file against its generated/checkout counterpart. */
function checkFile(label, installed, source) {
  if (!existsSync(installed)) {
    failures.push(`${label}: missing ${path.relative(installedRoot, installed)}`)
    return
  }
  if (statSync(installed).size === 0) {
    failures.push(`${label}: ${path.relative(installedRoot, installed)} is empty`)
    return
  }
  if (!existsSync(source)) {
    failures.push(`${label}: no build artifact to compare against (${path.relative(repoRoot, source)}) — run \`pnpm run build\``)
    return
  }
  if (digest(installed) !== digest(source)) {
    failures.push(`${label}: ${path.relative(installedRoot, installed)} is STALE (differs from the checkout)`)
  }
}

function report() {
  if (warnings.length > 0) {
    console.log('warnings:')
    for (const warning of warnings) console.log('  - ' + warning)
  }
  if (failures.length > 0) {
    console.error('\nFAILED — the installed profile is not usable:')
    for (const failure of failures) console.error('  - ' + failure)
    console.error('\nFix: quit DSH and every helper (AbSerialHost / DownloaderIpcBridge / WorkbayPty),')
    console.error('delete the affected package directories under node_modules, then install again.')
    process.exit(1)
  }
  console.log(`OK — installed workbench verified in ${installedRoot}`)
  process.exit(0)
}

const profilePkgPath = path.join(profileDir, 'package.json')
if (!existsSync(profilePkgPath)) {
  failures.push(`profile package.json not found at ${profilePkgPath}`)
  report()
}

const profile = JSON.parse(readFileSync(profilePkgPath, 'utf8'))
const bundles = Array.isArray(profile?.dsh?.profile?.bundles) ? profile.dsh.profile.bundles : []
const deps = profile?.dependencies ?? {}
const usesSuite = bundles.includes('dsh-workbay-suite')
const listedStandalone = Object.keys(STANDALONE).filter((name) => bundles.includes(name))

if (usesSuite && listedStandalone.length > 0) {
  failures.push(`profile lists dsh-workbay-suite AND ${listedStandalone.join(', ')} — duplicate routes (duplicate prefix route)`)
}
if (!usesSuite && listedStandalone.length === 0) {
  failures.push('profile lists neither dsh-workbay-suite nor a standalone workbay bundle')
}

if (usesSuite) {
  const suiteDir = path.join(installedRoot, 'dsh-workbay-suite')
  const sourceSuite = path.join(repoRoot, 'packages', 'suite')
  if (!existsSync(suiteDir)) {
    failures.push('dsh-workbay-suite: not installed')
  } else {
    for (const relative of SUITE_FILES) {
      checkFile('dsh-workbay-suite', path.join(suiteDir, relative), path.join(sourceSuite, relative))
    }
  }
  /* Extra workbay packages in the profile show up as disabled plugins in the UI,
     which is exactly what the merged layout exists to avoid. */
  const extra = ['dsh-workbay-dock', 'dsh-workbay-files', 'dsh-workbay-terminal', 'dsh-gitcraft', 'dsh-downloader', '@dsh-workbay/kit']
    .filter((name) => Object.hasOwn(deps, name) || existsSync(path.join(installedRoot, name)))
  if (extra.length > 0) {
    failures.push(`merged layout must not carry ${extra.join(', ')} — remove them from profile dependencies and node_modules`)
  }
  if (typeof deps['dsh-workbay-suite'] !== 'string') {
    failures.push('profile dependencies has no "dsh-workbay-suite" entry')
  }
} else {
  for (const [name, files] of Object.entries(STANDALONE)) {
    const installedDir = path.join(installedRoot, name)
    const sourceDir = path.join(repoRoot, 'packages', STANDALONE_SOURCE[name])
    if (!existsSync(installedDir)) {
      failures.push(`${name}: not installed at ${installedDir}`)
      continue
    }
    for (const relative of files) checkFile(name, path.join(installedDir, relative), path.join(sourceDir, relative))
  }
}

report()
