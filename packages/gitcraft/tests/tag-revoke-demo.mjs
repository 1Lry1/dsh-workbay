/**
 * Manual end-to-end demo of tag revoke against a THROWAWAY clone with a real
 * bare remote, driven through the SAME code path the panel uses (the plugin's
 * own `apply()` + an HTTP server), so the semantics are proven outside the test
 * harness as well.
 *
 * Usage: node packages/gitcraft/tests/tag-revoke-demo.mjs
 */
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const plugin = await import(pathToFileURL(path.join(here, '..', 'src', 'index.js')).href)

const sandbox = mkdtempSync(path.join(tmpdir(), 'tag-demo-'))
const repo = path.join(sandbox, 'repo')
const remote = path.join(sandbox, 'remote.git')
const sh = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

sh(sandbox, ['init', '--bare', remote])
sh(sandbox, ['init', '-q', '-b', 'main', repo])
sh(repo, ['config', 'user.name', 'Demo'])
sh(repo, ['config', 'user.email', 'demo@example.com'])
writeFileSync(path.join(repo, 'a.txt'), 'one\n')
sh(repo, ['add', '.'])
sh(repo, ['commit', '-q', '-m', 'chore: seed'])
sh(repo, ['remote', 'add', 'origin', remote])
sh(repo, ['push', '-q', '-u', 'origin', 'main'])

let captured = null
const ctx = {
  webServer: { register(route) { captured = route; return () => {} } },
  effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d() } },
  inject(deps, cb) { cb(ctx); return () => {} },
  get() { return undefined },
  tools: { register() { return () => {} } },
}
await plugin.apply(ctx, {})

const server = createServer(async (req, res) => {
  if (captured === null) { res.writeHead(500); res.end('no route'); return }
  await captured.handler(req, res)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`
const call = async (method, payload) => (await (await fetch(`${base}/dsh-gitcraft/api/${method}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
})).json())

const remoteTags = () => sh(remote, ['for-each-ref', '--format=%(refname:short)', 'refs/tags']).split('\n').filter((l) => l.trim())
const localTags = () => sh(repo, ['tag']).split('\n').filter((l) => l.trim())

let failures = 0
const check = (name, ok, detail) => {
  if (!ok) failures += 1
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (detail === undefined ? '' : '  ' + detail))
}

try {
  /* 1. create two tags, publish only one */
  await call('tagCreate', { cwd: repo, name: 'v1.0.0', message: 'release 1' })
  await call('tagCreate', { cwd: repo, name: 'v1.0.1', message: 'release 2' })
  await call('tagPush', { cwd: repo, name: 'v1.0.0' })
  check('tagPush publishes only the named tag', remoteTags().includes('v1.0.0') && !remoteTags().includes('v1.0.1'),
    JSON.stringify(remoteTags()))

  /* 2. revoke the published one -> gone on both sides */
  const undo = await call('tagReset', { cwd: repo, name: 'v1.0.0' })
  check('tagReset removes it locally and remotely', undo.ok === true && undo.data.removedRemote === true, JSON.stringify(undo.data?.removedRemote))
  check('  -> local gone', !localTags().includes('v1.0.0'), JSON.stringify(localTags()))
  check('  -> remote gone', !remoteTags().includes('v1.0.0'), JSON.stringify(remoteTags()))
  check('  -> the unrelated local tag survived', localTags().includes('v1.0.1'), JSON.stringify(localTags()))

  /* 3. remoteToo:false keeps the remote copy, and a tag fetch brings it back */
  await call('tagPush', { cwd: repo, name: 'v1.0.1' })
  const localOnly = await call('tagReset', { cwd: repo, name: 'v1.0.1', remoteToo: false })
  check('remoteToo:false keeps the remote tag', localOnly.data.removedRemote === false && remoteTags().includes('v1.0.1'),
    JSON.stringify(remoteTags()))
  check('  -> local is gone', !localTags().includes('v1.0.1'), JSON.stringify(localTags()))
  await call('fetch', { cwd: repo, tags: true })
  check('  -> a fetch --tags RESTORES it (why the checkbox defaults on)', localTags().includes('v1.0.1'), JSON.stringify(localTags()))

  /* 4. a typo must not report success */
  const missing = await call('tagReset', { cwd: repo, name: 'no-such-tag' })
  check('an unknown tag is rejected with a clear code', missing.ok === false && missing.error.code === 'tag-not-found', JSON.stringify(missing.error))
} finally {
  await new Promise((r) => server.close(r))
  try { rmSync(sandbox, { recursive: true, force: true }) } catch { /* windows lock */ }
}

console.log(failures === 0 ? '\nTAG REVOKE DEMO PASS' : `\nTAG REVOKE DEMO FAIL (${failures})`)
process.exitCode = failures === 0 ? 0 : 1
