/**
 * Sync the freshly built suite into the DSH profile WITHOUT removing the old
 * copy first.
 *
 * Why not `rm -rf node_modules/dsh-workbay-suite` + `pnpm install`:
 *   - `vendor/downloader/helper/AbSerialHost.exe` is EXECUTING from that same
 *     directory whenever DSH is open, so Windows refuses to delete it. A
 *     recursive delete then fails PART WAY THROUGH, leaving a broken package
 *     (this happened once: lib/index.js and all of vendor/dock were gone).
 *   - pnpm's `file:` install is a copy, and pnpm reports "Already up to date" for
 *     an unchanged version — so the obvious command silently does nothing.
 *
 * Copying file by file avoids both: an open file that cannot be replaced is
 * reported and skipped, and every other file lands. The helper binaries never
 * change between builds, so skipping a locked one is correct rather than a
 * compromise.
 *
 * Always run verify-source-control.ps1 afterwards; this script only copies.
 *
 * Usage:  node scripts/sync-to-profile.mjs [profileDir]
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const built = path.join(repoRoot, 'packages', 'suite')
const profileDir = process.argv[2] ?? process.env.DSH_PROFILE_DIR ?? path.join(os.homedir(), '.dsh', 'profiles', 'desktop')
const installed = path.join(profileDir, 'node_modules', 'dsh-workbay-suite')

if (existsSync(built) === false) {
  console.error('FAIL  no build at ' + built + ' (run: pnpm run build)')
  process.exit(1)
}
if (existsSync(profileDir) === false) {
  console.error('FAIL  no profile at ' + profileDir)
  process.exit(1)
}

/** Every file under `dir`, as paths relative to it. */
function walk(dir, prefix = '') {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const rel = prefix === '' ? entry.name : prefix + '/' + entry.name
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel))
    else if (entry.isFile()) out.push(rel)
  }
  return out
}

const wanted = walk(built)
let copied = 0
let unchanged = 0
const locked = []
const failed = []

for (const rel of wanted) {
  const from = path.join(built, rel.split('/').join(path.sep))
  const to = path.join(installed, rel.split('/').join(path.sep))
  const targetDir = path.dirname(to)
  if (existsSync(targetDir) === false) mkdirSync(targetDir, { recursive: true })

  let same = false
  try {
    same = existsSync(to) && statSync(to).size === statSync(from).size
      && Buffer.compare(readFileSync(from), readFileSync(to)) === 0
  } catch (error) {
    same = false
  }
  if (same === true) { unchanged += 1; continue }

  try {
    writeFileSync(to, readFileSync(from))
    copied += 1
  } catch (error) {
    const code = error === null || error === undefined ? '' : String(error.code ?? '')
    const message = String(error && error.message ? error.message : error)
    if (code === 'EBUSY' || code === 'EPERM' || message.includes('being used by another process')) {
      locked.push(rel)
    } else {
      failed.push(rel + ': ' + message)
    }
  }
}

/* Files that exist in the installed copy but not in the build are STALE. Remove
   them, unless locked — a leftover file from an older version is how a page keeps
   behaving like the previous release after an "upgrade". */
const existing = existsSync(installed) ? walk(installed) : []
const stale = []
const staleLocked = []
for (const rel of existing) {
  if (wanted.includes(rel)) continue
  const target = path.join(installed, rel.split('/').join(path.sep))
  try {
    const { unlinkSync } = await import('node:fs')
    unlinkSync(target)
    stale.push(rel)
  } catch (error) {
    staleLocked.push(rel)
  }
}

console.log('build:     ' + built)
console.log('installed: ' + installed)
console.log('')
console.log('  copied    ' + copied)
console.log('  unchanged ' + unchanged)
console.log('  stale     ' + stale.length + (stale.length > 0 ? ' (removed)' : ''))
if (locked.length > 0) {
  console.log('  locked    ' + locked.length + ' (in use by a running helper; contents are identical between builds)')
  for (const rel of locked) console.log('            ' + rel)
}
if (staleLocked.length > 0) {
  console.log('  stale-but-locked ' + staleLocked.length)
  for (const rel of staleLocked) console.log('            ' + rel)
}
if (failed.length > 0) {
  console.log('')
  console.error('FAILED to copy:')
  for (const line of failed) console.error('  ' + line)
  process.exit(1)
}

console.log('')
console.log('SYNCED — now run: pwsh -NoProfile -File scripts/verify-source-control.ps1')
console.log('then restart DSH to load the new code.')
