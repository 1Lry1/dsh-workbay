/**
 * Build the ONE-PACKAGE workbench: `dsh-workbay-suite`.
 *
 * DSH's plugin manager lists every installed package, so keeping dock / files /
 * terminal / gitcraft / downloader as separate packages meant five permanently
 * disabled rows next to the suite. This script vendors those packages INTO the
 * suite and generates a single host entry and a single client bundle, so a
 * profile only installs `dsh-workbay-suite` and the plugin list shows exactly
 * one workbench entry.
 *
 * Generated (gitignored):
 *   packages/suite/vendor/<pkg>/**   copies of the five packages + kit
 *   packages/suite/lib/index.js      one apply() that mounts every bundle
 *   packages/suite/client.js         the five client halves concatenated
 *   packages/suite/cordis.patch.yml  one loader row
 *
 * Requirements: `scripts/build-chunks.mjs` must have run first (the files and
 * terminal chunks are vendored with their packages).
 *
 * Usage: node scripts/build-suite.mjs   (or `pnpm run build`)
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packagesDir = path.join(repoRoot, 'packages')
const suiteDir = path.join(packagesDir, 'suite')
const vendorDir = path.join(suiteDir, 'vendor')

/** package dir -> { subpaths to copy, host entry, client entry, client inject, config defaults } */
const BUNDLES = [
  {
    dir: 'dock',
    host: 'src/index.js',
    client: 'src/client.js',
    include: ['src', 'package.json'],
    inject: ['@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-conversation', '@deepseek-ai/dsh-client-ui-sidebar-right'],
    config: {},
  },
  {
    dir: 'files',
    host: 'src/index.js',
    client: 'src/client.js',
    include: ['src', 'lib', 'package.json'],
    inject: ['@deepseek-ai/dsh-client-locale'],
    config: { allowWrite: true, maxFileBytes: 1048576 },
  },
  {
    dir: 'terminal',
    host: 'src/index.js',
    client: 'src/client.js',
    include: ['src', 'lib', 'helper', 'package.json'],
    inject: ['@deepseek-ai/dsh-client-locale'],
    config: { shell: 'auto', pty: 'auto', maxSessions: 8, idleTimeoutMs: 1800000 },
  },
  {
    dir: 'gitcraft',
    host: 'src/index.js',
    client: 'src/client.js',
    include: ['src', 'package.json'],
    inject: ['@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-modules', '@deepseek-ai/dsh-client-ui-conversation'],
    config: { refreshIntervalMs: 15000, timeoutMs: 30000, networkTimeoutMs: 180000, defaultDiffView: 'unified' },
  },
  {
    dir: 'downloader',
    host: 'lib/index.js',
    client: 'lib/client.js',
    include: ['lib', 'helper', 'ipc-helper', 'package.json'],
    inject: ['@deepseek-ai/dsh-client-locale'],
    config: {},
  },
  {
    dir: 'kit',
    host: 'src/host.js',
    include: ['src', 'package.json'],
    inject: [],
    config: {},
  },
]

/** Vendored helper only: kit exposes helpers, not a plugin `apply`. */
const PLUGIN_BUNDLES = BUNDLES.filter((bundle) => bundle.dir !== 'kit')
const CLIENT_BUNDLES = PLUGIN_BUNDLES.filter((bundle) => bundle.client !== undefined)

function fail(message) {
  console.error('build-suite: ' + message)
  process.exit(1)
}

function assertChunks() {
  const needed = [
    path.join(packagesDir, 'files', 'lib', 'chunks', 'editor.js'),
    path.join(packagesDir, 'terminal', 'lib', 'chunks', 'xterm.js'),
  ]
  for (const file of needed) {
    if (!existsSync(file)) fail(`missing chunk ${path.relative(repoRoot, file)} — run scripts/build-chunks.mjs first`)
  }
}

function copyBundle(bundle) {
  const source = path.join(packagesDir, bundle.dir)
  if (!existsSync(source)) fail(`missing package dir ${bundle.dir}`)
  const target = path.join(vendorDir, bundle.dir)
  mkdirSync(target, { recursive: true })
  for (const entry of bundle.include) {
    const from = path.join(source, entry)
    if (!existsSync(from)) fail(`${bundle.dir}/${entry} does not exist`)
    cpSync(from, path.join(target, entry), {
      recursive: true,
      filter: (file) => !file.includes(`${path.sep}node_modules${path.sep}`) && !file.includes(`${path.sep}.git${path.sep}`) && !file.endsWith(`${path.sep}tests`),
    })
  }
}

/**
 * Rewrite the workspace kit import to a relative path inside the vendor tree.
 * The vendored host entries all live at `vendor/<pkg>/<src|lib>/<file>`, so the
 * kit is always two levels up. Rewriting is safer than relying on a nested
 * package, which pnpm would not install (the suite declares no dependencies).
 */
function rewriteKitImports() {
  const kitTarget = path.join(vendorDir, 'kit', 'src', 'host.js')
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.js')) files.push(full)
    }
  }
  walk(vendorDir)
  let rewritten = 0
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    if (!text.includes("'@dsh-workbay/kit'")) continue
    const relative = path.relative(path.dirname(file), kitTarget).split(path.sep).join('/')
    const specifier = relative.startsWith('.') ? relative : './' + relative
    writeFileSync(file, text.split("'@dsh-workbay/kit'").join(`'${specifier}'`))
    rewritten += 1
  }
  return rewritten
}

function generateHost() {
  const lines = [
    '/**',
    ' * dsh-workbay-suite — host half (GENERATED by scripts/build-suite.mjs).',
    ' *',
    ' * One plugin row mounts the whole workbench. Each vendored host half keeps its',
    ' * own routes and its own `apply`, so failure domains inside the process are',
    ' * unchanged; only the plugin entry point is now a single package.',
    ' */',
  ]
  for (const bundle of PLUGIN_BUNDLES) {
    const importBase = bundle.host.replace(/\\/g, '/').replace(/\.js$/, '')
    lines.push(`import { apply as apply_${bundle.dir}, inject as inject_${bundle.dir} } from '../vendor/${bundle.dir}/${importBase}.js'`)
  }
  lines.push('')
  lines.push("export const name = 'dsh-workbay-suite'")
  lines.push('')
  lines.push('/* Union of every bundle\'s host inject list (all of them only need webServer). */')
  lines.push(`export const inject = [...new Set([${PLUGIN_BUNDLES.map((bundle) => `...inject_${bundle.dir}`).join(', ')}])]`)
  lines.push('')
  lines.push('/** Merge the row config: `{ files: {...}, terminal: {...} }` per bundle. */')
  lines.push('export function apply(ctx, config) {')
  lines.push('  const row = config === undefined || config === null ? {} : config')
  for (const bundle of PLUGIN_BUNDLES) {
    const defaults = JSON.stringify(bundle.config)
    lines.push(`  apply_${bundle.dir}(ctx, { ${Object.keys(bundle.config).length > 0 ? `...${defaults},` : ''} ...(row.${bundle.dir} ?? {}) })`)
  }
  lines.push('}')
  lines.push('')
  mkdirSync(path.join(suiteDir, 'lib'), { recursive: true })
  writeFileSync(path.join(suiteDir, 'lib', 'index.js'), lines.join('\n'))
}

function generatePatch() {
  const yaml = [
    '# GENERATED by scripts/build-suite.mjs — one row mounts the whole workbench.',
    '# The five bundles are vendored inside this package; do not add them to a',
    '# profile that uses this one (their routes would register twice).',
    '- insert:',
    '    - id: workbay-suite',
    "      name: 'dsh-workbay-suite'",
    '',
  ].join('\n')
  writeFileSync(path.join(suiteDir, 'cordis.patch.yml'), yaml)
}

function generateClient() {
  const parts = [
    '/* GENERATED by scripts/build-suite.mjs — do not edit.',
    ' * The five client halves are concatenated; each one calls',
    ' * window.__ModuleLoader__.load(...) once, which the module system queues, so a',
    ' * single client bundle can register the dock and all four pages. The IIFE',
    ' * wrapper keeps their top-level scopes separate. */',
  ]
  for (const bundle of CLIENT_BUNDLES) {
    const source = readFileSync(path.join(packagesDir, bundle.dir, bundle.client), 'utf8').replace(/^\uFEFF/, '')
    const id = `/dsh-workbay-${bundle.dir}`
    if (!source.includes('__ModuleLoader__.load(')) fail(`${bundle.dir} client is not a ModuleLoader bundle`)
    parts.push(`\n/* ---- ${bundle.dir} ---- */\n;(function () {\n${source}\n})();\n`)
  }
  writeFileSync(path.join(suiteDir, 'client.js'), parts.join(''))
}

/* --------------------------------------------------------------------- run */

assertChunks()
rmSync(vendorDir, { recursive: true, force: true })
mkdirSync(vendorDir, { recursive: true })
for (const bundle of BUNDLES) copyBundle(bundle)
const rewritten = rewriteKitImports()
generateHost()
generatePatch()
generateClient()

const size = (file) => `${Math.round(statSync(file).size / 1024)} KB`
console.log(`built dsh-workbay-suite -> vendor ${BUNDLES.length} packages, kit imports rewritten: ${rewritten}`)
console.log(`  lib/index.js ${size(path.join(suiteDir, 'lib', 'index.js'))}, client.js ${size(path.join(suiteDir, 'client.js'))}`)
