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
    ' * One plugin row mounts the whole workbench. The bundles are loaded with',
    ' * dynamic import inside apply(): a bundle that cannot be imported (a bad',
    ' * build, a locked helper, a broken dependency of just one page) is reported',
    ' * and skipped instead of failing the whole application at startup. Routes are',
    ' * still owned by each vendored bundle, so the failure domains are unchanged.',
    ' */',
    '',
    "export const name = 'dsh-workbay-suite'",
    '',
    "/* Every bundle needs only the web server; the rest are optional services the",
    "   bundles inject on their own (downloader registers tools when present). */",
    "export const inject = ['webServer']",
    '',
    'const BUNDLES = [',
  ]
  for (const bundle of PLUGIN_BUNDLES) {
    const importBase = bundle.host.replace(/\\/g, '/').replace(/\.js$/, '')
    lines.push(`  { name: ${JSON.stringify(bundle.dir)}, config: ${JSON.stringify(bundle.config)}, load: () => import('../vendor/${bundle.dir}/${importBase}.js') },`)
  }
  lines.push(']')
  lines.push('')
  lines.push('/** Mount every vendored bundle; one failing bundle must not kill the app. */')
  lines.push('export async function apply(ctx, config) {')
  lines.push('  const row = config === undefined || config === null ? {} : config')
  lines.push('  const failures = []')
  lines.push('  for (const bundle of BUNDLES) {')
  lines.push('    try {')
  lines.push('      const module = await bundle.load()')
  lines.push('      if (typeof module.apply !== \'function\') throw new Error(\'module has no apply() export\')')
  lines.push('      await module.apply(ctx, { ...bundle.config, ...(row[bundle.name] ?? {}) })')
  lines.push('    } catch (error) {')
  lines.push('      const message = error && error.message ? error.message : String(error)')
  lines.push('      failures.push(bundle.name + \': \' + message)')
  lines.push('      try { ctx.logger?.error?.(`dsh-workbay-suite: ${bundle.name} failed to mount: ${message}`) } catch { /* logger optional */ }')
  lines.push('    }')
  lines.push('  }')
  lines.push('  if (failures.length === BUNDLES.length) {')
  lines.push('    throw new Error(\'the workbench could not mount any bundle: \' + failures.join(\'; \'))')
  lines.push('  }')
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
    ' * One package, one browser module: the client module system resolves a boot',
    ' * row by package name, so this file registers exactly one factory under',
    ' * "dsh-workbay-suite". Registering the vendored ids (dock, files, ...) instead',
    ' * would leave the suite row unregistered and fail web boot.',
    ' *',
    ' * The five client halves still ship unchanged: their __ModuleLoader__.load()',
    ' * calls are captured below, their factories run only when this module is',
    ' * first materialized, and their apply() functions are composed under the one',
    ' * suite fiber. The IIFE wrappers keep their top-level scopes separate. */',
    ';(function () {\n',
    '  var registrations = []\n',
    '  function capture(registration) { registrations.push(registration) }\n',
  ]
  for (const bundle of CLIENT_BUNDLES) {
    const source = readFileSync(path.join(packagesDir, bundle.dir, bundle.client), 'utf8').replace(/^\uFEFF/, '')
    if (!source.includes('__ModuleLoader__.load(')) fail(`${bundle.dir} client is not a ModuleLoader bundle`)
    /* Capture instead of registering: the five factories belong to this package's
       single browser module, not to five graph rows of their own. */
    const captured = source.split('window.__ModuleLoader__.load(').join('capture(')
    if (captured.includes('__ModuleLoader__.load(')) fail(`${bundle.dir} client calls __ModuleLoader__.load without the window qualifier`)
    parts.push(`\n/* ---- ${bundle.dir} ---- */\n;(function () {\n${captured}\n})();\n`)
  }
  parts.push(
    '\nwindow.__ModuleLoader__.load({\n'
    + "  id: 'dsh-workbay-suite',\n"
    + '  factory: (require) => {\n'
    + '    const plugins = registrations.map((registration) => registration.factory(require))\n'
    + '    const inject = []\n'
    + '    for (const plugin of plugins) {\n'
    + '      if (plugin === null || plugin === undefined) continue\n'
    + '      for (const service of Array.isArray(plugin.inject) ? plugin.inject : []) {\n'
    + '        if (!inject.includes(service)) inject.push(service)\n'
    + '      }\n'
    + '    }\n'
    + '    return {\n'
    + "      name: 'dsh-workbay-suite',\n"
    + '      inject,\n'
    + '      apply: async (ctx) => {\n'
    + '        const failures = []\n'
    + '        for (let index = 0; index < plugins.length; index += 1) {\n'
    + '          const plugin = plugins[index]\n'
    + '          try {\n'
    + "            if (plugin === null || plugin === undefined || typeof plugin.apply !== 'function') throw new Error('module exposes no apply()')\n"
    + '            await plugin.apply(ctx)\n'
    + '          } catch (error) {\n'
    + '            const message = error && error.message ? error.message : String(error)\n'
    + "            failures.push(registrations[index].id + ': ' + message)\n"
    + "            try { console.error('dsh-workbay-suite: ' + registrations[index].id + ' failed to apply: ' + message) } catch { /* console optional */ }\n"
    + '          }\n'
    + '        }\n'
    + '        if (failures.length === plugins.length) {\n'
    + "          throw new Error('the workbench client could not apply any bundle: ' + failures.join('; '))\n"
    + '        }\n'
    + '      },\n'
    + '    }\n'
    + '  },\n'
    + '})\n'
    + '})()\n',
  )
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
