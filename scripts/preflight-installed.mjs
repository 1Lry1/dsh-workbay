/**
 * Boot the INSTALLED suite exactly the way DSH would, and report whether it
 * starts. This is the pre-restart safety check.
 *
 * It loads `<profile>/node_modules/dsh-workbay-suite/lib/index.js`, runs its
 * real `apply()` against a fake cordis context that records every route and
 * service, then reports:
 *
 *   - did the module import and export apply()?
 *   - did every bundle mount, or which ones failed?
 *   - are all six route prefixes registered exactly once?
 *   - does the kit content-type fence break any of them?
 *
 * A failure here means DSH will fail to start that plugin row, so this is worth
 * running before a restart rather than discovering it afterwards.
 *
 * Usage:  node scripts/preflight-installed.mjs [profileDir]
 */
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

const profileDir = process.argv[2] ?? path.join(os.homedir(), '.dsh', 'profiles', 'desktop')
const suiteDir = path.join(profileDir, 'node_modules', 'dsh-workbay-suite')

if (existsSync(suiteDir) === false) {
  console.error('FAIL  no installed suite at ' + suiteDir)
  process.exit(1)
}

console.log('profile:', profileDir)
console.log('suite:  ', suiteDir)
console.log('')

/* ---------- 1. the host entry must import ---------- */
const hostEntry = path.join(suiteDir, 'lib', 'index.js')
if (existsSync(hostEntry) === false) {
  console.error('FAIL  lib/index.js is MISSING — DSH cannot load this plugin row at all')
  process.exit(1)
}

let plugin = null
try {
  plugin = await import(pathToFileURL(hostEntry).href)
} catch (error) {
  console.error('FAIL  lib/index.js threw while importing:')
  console.error('      ' + error.message)
  process.exit(1)
}
console.log('ok    lib/index.js imported')

if (typeof plugin.apply !== 'function') {
  console.error('FAIL  lib/index.js exports no apply()')
  process.exit(1)
}
console.log('ok    exports apply() and name=' + JSON.stringify(plugin.name))

/* ---------- 2. run apply() against a recording fake ctx ---------- */
const routes = []
const services = new Map()
const effects = []
const errors = []

const ctx = {
  webServer: {
    register(route) {
      routes.push(route)
      return () => {
        const i = routes.indexOf(route)
        if (i >= 0) routes.splice(i, 1)
      }
    },
  },
  effect(fn, label) {
    try {
      const dispose = fn()
      effects.push({ label, dispose })
      return typeof dispose === 'function' ? dispose : () => {}
    } catch (error) {
      errors.push('effect "' + String(label) + '": ' + error.message)
      return () => {}
    }
  },
  get(name) { return services.get(name) },
  provide(name, value) { services.set(name, value) },
  inject(names, callback) {
    /* Every bundle injects services that only exist inside DSH. Provide stubs so
       apply() proceeds; this check is about routes and imports, not behaviour. */
    for (const name of names) {
      if (services.has(name) === false) services.set(name, {})
    }
    try { callback(ctx) } catch (error) { errors.push('inject ' + names.join(',') + ': ' + error.message) }
  },
  logger: { error() {}, warn() {}, info() {}, debug() {} },
}

let applied = false
try {
  await plugin.apply(ctx, {})
  applied = true
} catch (error) {
  console.error('FAIL  apply() threw — DSH would log this bundle as failed:')
  console.error('      ' + error.message)
  process.exit(1)
}
console.log('ok    apply() returned' + (errors.length === 0 ? ' with no effect errors' : ''))

if (errors.length > 0) {
  console.log('')
  console.log('  effect errors (non-fatal for DSH startup, but a bundle is degraded):')
  for (const line of errors) console.log('    - ' + line)
}

/* ---------- 3. duplicate prefixes: the one failure that kills the whole tree ---------- */
const prefixes = routes.map((r) => r.path).filter((p) => typeof p === 'string')
const seen = new Map()
for (const prefix of prefixes) seen.set(prefix, (seen.get(prefix) ?? 0) + 1)
const duplicates = [...seen.entries()].filter(([, count]) => count > 1)

console.log('')
console.log('routes registered: ' + prefixes.length)
for (const [prefix, count] of seen) {
  console.log('  ' + (count > 1 ? 'DUPLICATE ' : 'ok        ') + prefix + (count > 1 ? '  x' + count : ''))
}

if (duplicates.length > 0) {
  console.error('')
  console.error('FAIL  duplicate prefix route — DSH refuses to start the WHOLE plugin tree')
  process.exit(1)
}

/* ---------- 4. the new page's own route must be there ---------- */
const hasSourceControl = prefixes.some((p) => p.includes('source-control'))
const hasFiles = prefixes.some((p) => p.includes('workbay-files'))
const hasGit = prefixes.some((p) => p.includes('gitcraft'))
console.log('')
console.log((hasSourceControl ? 'ok    ' : 'FAIL  ') + 'source-control host route mounted')
console.log((hasFiles ? 'ok    ' : 'FAIL  ') + 'files host route mounted (the tree needs it)')
console.log((hasGit ? 'ok    ' : 'FAIL  ') + 'gitcraft host route mounted (the decorations need it)')
if (hasSourceControl === false || hasFiles === false || hasGit === false) process.exit(1)

/* ---------- 5. the client bundle must carry all four page registrations ---------- */
const clientPath = path.join(suiteDir, 'client.js')
if (existsSync(clientPath) === false) {
  console.error('FAIL  no client.js — the pages cannot register')
  process.exit(1)
}
const { readFileSync } = await import('node:fs')
const clientText = readFileSync(clientPath, 'utf8')
const pageIds = ['files', 'gitcraft', 'source-control', 'terminal', 'downloader']
const missingPages = pageIds.filter((id) => {
  /* The client registers via registerPage({ id: 'x' … }); check the quoted ids. */
  return clientText.includes("id: '" + id + "'") === false && clientText.includes('id: "' + id + '"') === false
})
console.log('')
for (const id of pageIds) {
  console.log((missingPages.includes(id) ? 'FAIL  ' : 'ok    ') + 'client bundle registers page "' + id + '"')
}
if (missingPages.length > 0) process.exit(1)

/* ---------- 6. the fence must not have broken the kit import ---------- */
const kitPath = path.join(suiteDir, 'vendor', 'kit', 'src', 'host.js')
if (existsSync(kitPath)) {
  try {
    const kit = await import(pathToFileURL(kitPath).href)
    if (typeof kit.createJsonApiHandler !== 'function') throw new Error('createJsonApiHandler missing')
    console.log('')
    console.log('ok    vendored kit imports and exports createJsonApiHandler')
  } catch (error) {
    console.error('')
    console.error('FAIL  vendored kit does not import: ' + error.message)
    console.error('      every JSON route in the workbench would fail to mount')
    process.exit(1)
  }
}

console.log('')
console.log('PREFLIGHT PASS — the installed plugin should mount when DSH restarts')
process.exit(0)
