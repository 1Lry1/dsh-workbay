/**
 * Latency benchmark for the GitCraft host API.
 *
 * Boots the plugin on a throwaway repo (with a realistic working tree) and times
 * the calls the panel makes on the hot path, so optimisation is measured rather
 * than guessed.
 *
 * Usage: node packages/gitcraft/tests/bench.mjs [files]
 */
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const plugin = await import(pathToFileURL(path.join(here, '..', 'src', 'index.js')).href)

const fileCount = Number(process.argv[2] ?? 400)
const sandbox = mkdtempSync(path.join(tmpdir(), 'gwc-bench-'))
const repo = path.join(sandbox, 'repo')
const sh = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

sh(sandbox, ['init', '-q', '-b', 'main', repo])
sh(repo, ['config', 'user.name', 'Bench'])
sh(repo, ['config', 'user.email', 'bench@example.com'])

/* A realistic tree: nested dirs, a few hundred tracked files. */
for (let i = 0; i < fileCount; i += 1) {
  const dir = path.join(repo, 'src', 'mod' + (i % 20))
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'file' + i + '.ts'), `export const v${i} = ${i}\n`.repeat(20))
}
sh(repo, ['add', '.'])
sh(repo, ['commit', '-q', '-m', 'feat: seed tree'])

/* A dirty working tree: every 10th file modified, plus untracked scratch. */
for (let i = 0; i < fileCount; i += 10) {
  const dir = path.join(repo, 'src', 'mod' + (i % 20))
  writeFileSync(path.join(dir, 'file' + i + '.ts'), `export const v${i} = "changed"\n`.repeat(20))
}
for (let i = 0; i < 30; i += 1) writeFileSync(path.join(repo, 'scratch' + i + '.tmp'), 'x\n')

let captured = null
const ctx = {
  webServer: { register(route) { captured = route; return () => {} } },
  effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d() } },
  inject(deps, cb) { cb(ctx); return () => {} },
  get() { return undefined },
  tools: { register() { return () => {} } },
}
await plugin.apply(ctx, { refreshIntervalMs: 15000, timeoutMs: 30000, networkTimeoutMs: 60000, defaultDiffView: 'unified' })

const server = createServer(async (req, res) => { await captured.handler(req, res) })
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`
const call = async (method, payload) => (await (await fetch(`${base}/dsh-gitcraft/api/${method}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
})).json())

const time = async (label, method, payload, runs = 7) => {
  const samples = []
  for (let i = 0; i < runs; i += 1) {
    const t0 = performance.now()
    const out = await call(method, payload)
    samples.push(performance.now() - t0)
    if (out.ok !== true) { console.log('  FAIL ' + label + ' -> ' + JSON.stringify(out.error)); return }
  }
  samples.sort((a, b) => a - b)
  const p50 = samples[Math.floor(samples.length * 0.5)]
  const p95 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))]
  console.log(label.padEnd(34) + 'p50 ' + p50.toFixed(1).padStart(7) + ' ms   p95 ' + p95.toFixed(1).padStart(7) + ' ms')
  return { p50, p95 }
}

/* Raw git floor: what ONE git spawn costs on this machine. */
const rawSamples = []
for (let i = 0; i < 7; i += 1) {
  const t0 = performance.now()
  sh(repo, ['rev-parse', '--show-toplevel'])
  rawSamples.push(performance.now() - t0)
}
rawSamples.sort((a, b) => a - b)
console.log('one raw git spawn (floor)         p50 ' + rawSamples[3].toFixed(1).padStart(7) + ' ms\n')

/* What the client actually sends after the first snapshot. */
const first = await call('snapshot', { cwd: repo })
const root = first.data.root
const scope = { cwd: root, repoRoot: root }
console.log('repo: ' + fileCount + ' files, ' + first.data.changes.length + ' changes\n')

await time('snapshot (cwd+repoRoot)', 'snapshot', scope)
await time('snapshot (repoRoot only)', 'snapshot', { repoRoot: root })
await time('status', 'status', scope)
await time('log (first page)', 'log', { ...scope, limit: 50 })
await time('branches', 'branches', scope)

/* Diffs: the other half of the panel's hot path. A cold per-file diff costs a
   full spawn on Windows, so the cache must be visible in the numbers. */
const firstChange = first.data.changes.filter((entry) => entry.untracked !== true)[0]
const dirtyPath = firstChange !== undefined ? firstChange.path : 'src/mod0/file0.ts'
const head = first.data.head
await time('diff: one modified file', 'diff', { ...scope, base: 'worktree', path: dirtyPath })
await time('diff: same file (cache hit)', 'diff', { ...scope, base: 'worktree', path: dirtyPath })
await time('diff: commit (whole)', 'diff', { ...scope, base: 'commit', rev: head })
await time('diff: commit (cache hit)', 'diff', { ...scope, base: 'commit', rev: head })
await time('diff: staged', 'diff', { ...scope, base: 'staged', path: dirtyPath })

await new Promise((r) => server.close(r))
try { rmSync(sandbox, { recursive: true, force: true }) } catch { }
