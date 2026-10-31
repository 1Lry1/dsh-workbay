/**
 * Tests for the generated one-package workbench (`packages/suite`).
 *
 * The generated files are gitignored, so this test builds them first (the repo
 * CI build step does the same) and then checks the two contracts that matter:
 *
 *   1. host: the generated apply() mounts EVERY bundle — each one's route
 *      prefixes are registered on the fake ctx exactly once;
 *   2. client: the bundle registers ONE module under the package name
 *      `dsh-workbay-suite` (the client module system resolves a boot row by
 *      package name) and materializes all five vendored client halves.
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

test('the generated client registers one module under the package name', () => {
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
     evaluation time (the vendored factories run at materialization). */
  new Function('window', source)(window)

  /* DSH's client module system builds one boot row per package name and asks
     the bundle to register exactly that id. Registering the five vendored ids
     instead leaves the `dsh-workbay-suite` row unregistered, so web boot fails
     with "entry did not activate" (and the fallback reload re-executes the
     bundle, which used to raise a duplicate-registration error). */
  assert.equal(registrations.length, 1, 'a package bundle must register one factory under its own name')
  const [registration] = registrations
  assert.equal(registration.id, 'dsh-workbay-suite')
  assert.equal(typeof registration.factory, 'function')

  /* Materializing the suite factory runs every vendored client factory; a
     missing or broken one throws here instead of at boot. */
  class Component {}
  const React = {
    Component,
    Fragment: Symbol('Fragment'),
    createElement() { return null },
    useState() { return [] },
    useEffect() {},
    useMemo() {},
    useRef() {},
    useCallback() {},
  }
  const plugin = registration.factory((specifier) => {
    if (specifier === 'react') return React
    throw new Error('unexpected require: ' + specifier)
  })
  assert.equal(plugin.name, 'dsh-workbay-suite')
  assert.equal(typeof plugin.apply, 'function')
  assert.deepEqual([...plugin.inject], [])
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
  await plugin.apply(ctx, {})
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
