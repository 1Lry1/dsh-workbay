/**
 * Tests for the generated one-package workbench (`packages/suite`).
 *
 * The generated files are gitignored, so this test builds them first (the repo
 * CI build step does the same) and then checks the two contracts that matter:
 *
 *   1. host: the generated apply() mounts EVERY bundle — each one's route
 *      prefixes are registered on the fake ctx exactly once;
 *   2. client: the concatenated file registers all five client modules with the
 *      module loader (queue semantics), with unique ids.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const here = path.dirname(fileURLToPath(import.meta.url))
const suiteDir = path.resolve(here, '..')
const repoRoot = path.resolve(suiteDir, '..', '..')

/* Rebuild every time: the artifacts are generated and cheap to produce. */
execFileSync(process.execPath, [path.join(repoRoot, 'scripts', 'build-chunks.mjs')], { cwd: repoRoot, stdio: 'pipe' })
execFileSync(process.execPath, [path.join(repoRoot, 'scripts', 'build-suite.mjs')], { cwd: repoRoot, stdio: 'pipe' })

const hostPath = path.join(suiteDir, 'lib', 'index.js')
const clientPath = path.join(suiteDir, 'client.js')

test('build generates the host, client, patch and vendored packages', () => {
  for (const file of [hostPath, clientPath, path.join(suiteDir, 'cordis.patch.yml')]) {
    assert.equal(existsSync(file), true, 'missing generated file: ' + file)
  }
  for (const name of ['dock', 'files', 'terminal', 'gitcraft', 'downloader', 'kit']) {
    assert.equal(existsSync(path.join(suiteDir, 'vendor', name, 'package.json')), true, 'missing vendored ' + name)
  }
  /* The helpers travel with their packages. */
  assert.equal(existsSync(path.join(suiteDir, 'vendor', 'terminal', 'helper', 'WorkbayPty.exe')), true)
  assert.equal(existsSync(path.join(suiteDir, 'vendor', 'downloader', 'helper', 'AbSerialHost.exe')), true)
  assert.equal(existsSync(path.join(suiteDir, 'vendor', 'files', 'lib', 'chunks', 'editor.js')), true)
})

test('the generated patch inserts exactly one row', () => {
  const patch = readFileSync(path.join(suiteDir, 'cordis.patch.yml'), 'utf8')
  assert.equal((patch.match(/- insert:/g) ?? []).length, 1)
  assert.match(patch, /name: 'dsh-workbay-suite'/)
  assert.equal((patch.match(/name: '/g) ?? []).length, 1, 'a second row would double-register routes')
})

test('the generated client queues all five module registrations', () => {
  const source = readFileSync(clientPath, 'utf8')
  const registrations = []
  const window = {
    __ModuleLoader__: {
      load(registration) {
        registrations.push(registration)
        return { dispose() {} }
      },
    },
  }
  /* The file is plain browser code; only window.__ModuleLoader__ is touched at
     evaluation time (the factories run later). */
  new Function('window', source)(window)
  assert.equal(registrations.length, 5, 'expected dock + four pages')
  const ids = registrations.map((registration) => String(registration.id))
  assert.equal(new Set(ids).size, ids.length, 'module ids must be unique: ' + ids.join(', '))
  for (const expected of ['dsh-workbay-dock', 'dsh-workbay-files', 'dsh-workbay-terminal', 'dsh-gitcraft', 'dsh-downloader']) {
    assert.ok(ids.includes(expected), 'missing client bundle ' + expected + ' in ' + ids.join(', '))
  }
  for (const registration of registrations) assert.equal(typeof registration.factory, 'function')
})

test('the merged host mounts every bundle exactly once on a fake ctx', async () => {
  const plugin = await import(pathToFileURL(hostPath).href)
  assert.equal(plugin.name, 'dsh-workbay-suite')
  assert.deepEqual([...plugin.inject], ['webServer'])
  assert.equal(typeof plugin.apply, 'function')

  const routes = []
  const effects = []
  const ctx = {
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    effect(fn) {
      effects.push(fn)
      const disposer = fn()
      return disposer
    },
    /* Real cordis contexts expose inject(deps, cb) and only invoke it once every
       dependency is available. Provide the two services the bundles actually
       consume here (webServer, tools); sessions/sessionPersistence are not
       needed for route mounting and stay unavailable, so their callback is
       skipped exactly like in a host without those services. */
    inject(deps, callback) {
      const available = new Set(['webServer', 'tools'])
      if (!deps.every((dep) => available.has(dep))) return () => {}
      const result = callback(ctx)
      return typeof result === 'function' ? result : () => {}
    },
    tools: { register() { return () => {} } },
    get() { return undefined },
  }
  plugin.apply(ctx, {})
  const prefixes = routes.map((route) => String(route.path))

  for (const expected of [
    '/dsh-workbay-dock/api',
    '/dsh-workbay-files/api',
    '/dsh-workbay-files/media',
    '/dsh-workbay-files/chunk',
    '/dsh-workbay-terminal/api',
    '/dsh-workbay-terminal/events',
    '/dsh-workbay-terminal/chunk',
  ]) {
    assert.equal(prefixes.filter((prefix) => prefix === expected).length, 1, 'route ' + expected + ' in ' + JSON.stringify(prefixes))
  }
  /* gitcraft and downloader prefixes are asserted loosely: they own their names. */
  assert.ok(prefixes.some((prefix) => prefix.includes('gitcraft')), JSON.stringify(prefixes))
  assert.ok(prefixes.some((prefix) => prefix.includes('downloader')), JSON.stringify(prefixes))
  /* Every bundle registered at least one disposer. */
  assert.ok(effects.length >= 4, 'effect count = ' + effects.length)
})
