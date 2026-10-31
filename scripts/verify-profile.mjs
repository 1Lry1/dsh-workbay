/**
 * Verify that the profile's copy of every dsh-workbay package is COMPLETE and
 * matches the checkout.
 *
 * Why this exists: `pnpm install` with `file:` dependencies does a copy, and if a
 * helper process (AbSerialHost / DownloaderIpcBridge / WorkbayPty) or DSH itself
 * holds a file open, Windows lets pnpm leave a PARTIAL package behind. That is
 * silent: the plugin then fails to load and its page simply disappears — the
 * downloader page vanished this way twice while the install still reported
 * success.
 *
 * Usage:
 *   node scripts/verify-profile.mjs [profile-dir]
 * Default profile dir: %USERPROFILE%\.dsh\profiles\desktop
 *
 * Exit 0 = every package is complete and hash-identical to the checkout.
 * Exit 1 = a package is missing files or is stale (prints exactly which).
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const profileDir = process.argv[2] ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'profiles', 'desktop')

/** Every shipped file that must exist in the installed copy (relative to the package). */
const REQUIRED = {
  'dsh-workbay-dock': ['package.json', 'cordis.patch.yml', 'src/index.js', 'src/client.js'],
  'dsh-workbay-files': ['package.json', 'cordis.patch.yml', 'src/index.js', 'src/client.js', 'lib/chunks/editor.js'],
  'dsh-workbay-terminal': ['package.json', 'cordis.patch.yml', 'src/index.js', 'src/client.js', 'lib/chunks/xterm.js', 'helper/WorkbayPty.exe'],
  'dsh-gitcraft': ['package.json', 'cordis.patch.yml', 'src/index.js', 'src/client.js'],
  'dsh-downloader': ['package.json', 'cordis.patch.yml', 'lib/index.js', 'lib/client.js', 'helper/AbSerialHost.exe', 'ipc-helper/DownloaderIpcBridge.exe'],
  '@dsh-workbay/kit': ['package.json', 'src/host.js'],
  'dsh-workbay-suite': ['package.json', 'cordis.patch.yml'],
}

/** Mapping from installed package name to the checkout directory. */
const SOURCE_DIRS = {
  'dsh-workbay-dock': 'dock',
  'dsh-workbay-files': 'files',
  'dsh-workbay-terminal': 'terminal',
  'dsh-gitcraft': 'gitcraft',
  'dsh-downloader': 'downloader',
  '@dsh-workbay/kit': 'kit',
  'dsh-workbay-suite': 'suite',
}

const installedRoot = path.join(profileDir, 'node_modules')

const failures = []
const warnings = []

function digest(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

for (const [name, files] of Object.entries(REQUIRED)) {
  const sourceDir = path.join(repoRoot, 'packages', SOURCE_DIRS[name])
  const installedDir = path.join(installedRoot, name)
  if (!existsSync(installedDir)) {
    failures.push(`${name}: not installed at ${installedDir}`)
    continue
  }
  for (const relative of files) {
    const installed = path.join(installedDir, relative)
    if (!existsSync(installed)) {
      failures.push(`${name}: missing ${relative}`)
      continue
    }
    if (statSync(installed).size === 0) {
      failures.push(`${name}: ${relative} is empty`)
      continue
    }
    const source = path.join(sourceDir, relative)
    if (!existsSync(source)) {
      warnings.push(`${name}: ${relative} is installed but absent from the checkout (generated?)`)
      continue
    }
    if (digest(installed) !== digest(source)) {
      failures.push(`${name}: ${relative} is STALE (installed copy differs from the checkout)`)
    }
  }
}

/* The profile must list the packages it actually loads. */
const profilePkgPath = path.join(profileDir, 'package.json')
if (!existsSync(profilePkgPath)) {
  failures.push(`profile package.json not found at ${profilePkgPath}`)
} else {
  const profile = JSON.parse(readFileSync(profilePkgPath, 'utf8'))
  const bundles = profile?.dsh?.profile?.bundles ?? []
  const deps = profile?.dependencies ?? {}
  const standalone = ['dsh-workbay-dock', 'dsh-workbay-files', 'dsh-workbay-terminal', 'dsh-gitcraft', 'dsh-downloader']
  const listed = standalone.filter((name) => bundles.includes(name))
  const usesSuite = bundles.includes('dsh-workbay-suite')
  if (usesSuite && listed.length > 0) {
    failures.push(`profile lists dsh-workbay-suite AND ${listed.join(', ')} — duplicate loader rows will fail to start`)
  }
  if (!usesSuite && listed.length === 0) {
    failures.push('profile lists neither dsh-workbay-suite nor a standalone workbay bundle')
  }
  for (const name of [...standalone, 'dsh-workbay-suite', '@dsh-workbay/kit']) {
    if (typeof deps[name] !== 'string') warnings.push(`profile dependencies has no "${name}" (resolvable from suite's own deps, but explicit is safer)`)
  }
}

if (warnings.length > 0) {
  console.log('warnings:')
  for (const warning of warnings) console.log('  - ' + warning)
}
if (failures.length > 0) {
  console.error('\nFAILED — the installed profile is not usable:')
  for (const failure of failures) console.error('  - ' + failure)
  console.error('\nFix: quit DSH and every helper (AbSerialHost / DownloaderIpcBridge / WorkbayPty),')
  console.error('delete the affected package directories under node_modules, then run the install again.')
  process.exit(1)
}

console.log(`OK — ${Object.keys(REQUIRED).length} packages verified in ${installedRoot}`)
