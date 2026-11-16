/**
 * Client-half tests for `dsh-absolute-file-references`.
 *
 * The bundle is loaded the way DSH loads it (`window.__ModuleLoader__.load`),
 * then driven through the SAME pick shapes the built-in `@` source produces.
 * The load-bearing contracts pinned here:
 *
 *   1. a settled file/folder pick becomes an ABSOLUTE mention, label untouched;
 *   2. session/skill references, drill actions and already-absolute paths pass
 *      through untouched (the picker must never gain opinions about them);
 *   3. the plugin declares an EMPTY inject and waits for inputTriggers/sessions
 *      itself — dsh-workbay-suite unions inject into its single row, so a
 *      non-empty inject here would hold the whole workbench in `pending`;
 *   4. the wrapper is idempotent (the suite mounts this half once, HMR may
 *      re-apply it) and fails soft when the services are absent.
 *
 * The browser harness path (a real composer) is covered by the workbench e2e;
 * this file is the cheap regression net.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = readFileSync(path.join(here, '..', 'client.js'), 'utf8')

const CWD = 'D:\\work\\demo'

/** Load client.js in a VM and return the module its factory produced. */
function loadModule(options = {}) {
  const storage = new Map(Object.entries(options.storage ?? {}))
  let registration = null
  const window = {
    __ModuleLoader__: { load(reg) { registration = reg } },
    localStorage: {
      getItem(key) { return storage.has(key) ? storage.get(key) : null },
      setItem(key, value) { storage.set(key, String(value)) },
      removeItem(key) { storage.delete(key) },
    },
  }
  vm.runInNewContext(source, { window, console, setInterval, clearInterval, setTimeout, clearTimeout })
  assert.ok(registration, 'the bundle registers a module')
  assert.equal(registration.id, 'dsh-absolute-file-references')
  const plugin = registration.factory(() => { throw new Error('no requires expected') })
  return { plugin, registration, storage, window }
}

/** A fake @ source shaped like @deepseek-ai/dsh-client-ui-reference. */
function makeSource() {
  return {
    trigger: '@',
    name: 'reference',
    onPick(pick) {
      if (pick.action === 'drill') return { text: pick.candidate.ref, continue: true }
      return {
        insert: {
          source: pick.candidate.source ?? 'reference',
          ref: pick.candidate.ref,
          label: pick.candidate.label,
          appearance: pick.candidate.appearance ?? 'file',
          clipboardText: pick.candidate.ref,
        },
      }
    },
  }
}

function makeServices(cwd = CWD) {
  const source = makeSource()
  const sessions = { list: { getSnapshot: () => ({ byId: { s1: { cwd } } }) } }
  const inputTriggers = {
    live: { sources: [source] },
    registerSource(src) { this.live.sources.push(src); return () => {} },
  }
  return { sessionId: 's1', sessions, inputTriggers, source }
}

/** ctx whose inject() invokes the callback immediately (both services present). */
function mount(plugin, services, options = {}) {
  const cleanups = []
  const ctx = {
    get: (name) => services[name],
    effect(fn, label) {
      void label
      const dispose = fn()
      if (typeof dispose === 'function') cleanups.push(dispose)
      return () => {}
    },
    inject(deps, callback) {
      if (options.deferInject === true) return () => {}
      const available = deps.every((dep) => services[dep] !== undefined && services[dep] !== null)
      if (!available) return () => {}
      const result = callback(ctx)
      return typeof result === 'function' ? result : () => {}
    },
  }
  plugin.apply(ctx)
  return { cleanups, ctx }
}

function pick(source, candidate, sessionId = 's1', action = 'pick') {
  return source.onPick({ candidate, session: { sessionId }, action, via: 'menu', position: 'inline', span: {} })
}

test('the plugin registers with an empty inject so the suite row never waits', () => {
  const { plugin } = loadModule()
  assert.equal(plugin.name, 'dsh-absolute-file-references')
  assert.deepEqual([...plugin.inject], [])
  assert.equal(typeof plugin.apply, 'function')
})

test('a relative file pick becomes an absolute mention, chip label untouched', () => {
  const { plugin } = loadModule()
  const services = makeServices()
  const { cleanups } = mount(plugin, services)
  const out = pick(services.source, { ref: '@build.bat', label: 'build.bat' })
  assert.equal(out.insert.ref, '@' + CWD + '\\build.bat')
  assert.equal(out.insert.clipboardText, '@' + CWD + '\\build.bat')
  assert.equal(out.insert.label, 'build.bat', 'the visible chip stays short')
  assert.equal(out.insert.appearance, 'file')
  for (const cleanup of cleanups.reverse()) cleanup()
})

test('the quoting grammar survives: spaces, folder pick, forward slashes', () => {
  const { plugin } = loadModule()
  const services = makeServices()
  const { cleanups } = mount(plugin, services)

  const spaced = pick(services.source, { ref: '@"my build.bat"', label: 'my build.bat' })
  assert.equal(spaced.insert.ref, '@"' + CWD + '\\my build.bat"')

  const dir = pick(services.source, { ref: '@"app/projects/standard/', label: 'standard/', appearance: 'folder' })
  assert.equal(dir.insert.ref, '@"' + CWD + '\\app\\projects\\standard\\')

  const nested = pick(services.source, { ref: '@app/projects/standard/Output/bin/app.dcf', label: 'app.dcf' })
  assert.equal(nested.insert.ref, '@' + CWD + '\\app\\projects\\standard\\Output\\bin\\app.dcf')

  for (const cleanup of cleanups.reverse()) cleanup()
})

test('session, skill and drill references are left alone', () => {
  const { plugin } = loadModule()
  const services = makeServices()
  const { cleanups } = mount(plugin, services)

  const sessionOut = pick(services.source, { ref: '@fix-login', label: 'fix-login', appearance: 'session' })
  assert.equal(sessionOut.insert.ref, '@fix-login')

  const absolute = pick(services.source, { ref: '@D:\\tools\\build.bat', label: 'build.bat' })
  assert.equal(absolute.insert.ref, '@D:\\tools\\build.bat')

  const otherSource = pick(services.source, { ref: '@some-skill', label: 'some-skill', source: 'skill' })
  assert.equal(otherSource.insert.ref, '@some-skill')

  const drill = pick(services.source, { ref: '@app' }, 's1', 'drill')
  assert.equal(drill.continue, true)
  assert.equal(drill.text, '@app')

  for (const cleanup of cleanups.reverse()) cleanup()
})

test('the runtime switch turns the rewrite off without a restart', () => {
  const { plugin, window } = loadModule({ storage: { 'dsh-workbay.absolute-refs.v1': '0' } })
  const services = makeServices()
  const { cleanups } = mount(plugin, services)

  const off = pick(services.source, { ref: '@build.bat', label: 'build.bat' })
  assert.equal(off.insert.ref, '@build.bat', 'switched off keeps the stock relative path')

  /* Flipping the key takes effect on the very next pick. */
  window.localStorage.setItem('dsh-workbay.absolute-refs.v1', '1')
  const on = pick(services.source, { ref: '@build.bat', label: 'build.bat' })
  assert.equal(on.insert.ref, '@' + CWD + '\\build.bat')

  for (const cleanup of cleanups.reverse()) cleanup()
})

test('applying twice (suite mount + HMR) does not convert twice', () => {
  const { plugin } = loadModule()
  const services = makeServices()
  const first = mount(plugin, services)
  const second = mount(plugin, services)
  const out = pick(services.source, { ref: '@build.bat', label: 'build.bat' })
  assert.equal(out.insert.ref, '@' + CWD + '\\build.bat')
  for (const cleanup of [...first.cleanups, ...second.cleanups].reverse()) cleanup()
})

test('a source registered after the plugin is wrapped at registration time', () => {
  const { plugin } = loadModule()
  const services = makeServices()
  services.inputTriggers.live.sources.length = 0
  const { cleanups } = mount(plugin, services)

  const late = makeSource()
  services.inputTriggers.registerSource(late)
  const out = pick(late, { ref: '@late.txt', label: 'late.txt' })
  assert.equal(out.insert.ref, '@' + CWD + '\\late.txt')
  for (const cleanup of cleanups.reverse()) cleanup()
})

test('missing services make it a no-op instead of an error', () => {
  const { plugin } = loadModule()
  const services = makeServices()
  /* Both services absent: inject() must not call back, and apply must not throw. */
  const bare = { get: () => undefined, effect: () => () => {}, inject: () => () => {} }
  assert.doesNotThrow(() => plugin.apply(bare))
  /* Deferred forever: the source keeps the stock behaviour. */
  const { cleanups } = mount(plugin, services, { deferInject: true })
  const out = pick(services.source, { ref: '@build.bat', label: 'build.bat' })
  assert.equal(out.insert.ref, '@build.bat')
  for (const cleanup of cleanups.reverse()) cleanup()
})

test('a context without inject() still patches when both services are present', () => {
  const { plugin } = loadModule()
  const services = makeServices()
  plugin.apply({
    get: (name) => services[name],
    effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
  })
  const out = pick(services.source, { ref: '@build.bat', label: 'build.bat' })
  assert.equal(out.insert.ref, '@' + CWD + '\\build.bat')
})
