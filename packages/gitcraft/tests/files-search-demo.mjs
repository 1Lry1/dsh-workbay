/**
 * End-to-end demo of the two new capabilities against a THROWAWAY repository:
 *
 *   1. search a repository's files by name and by content;
 *   2. open one file's commit history — including the commits BEFORE a rename,
 *      with per-commit +/- counts.
 *
 * Usage: node packages/gitcraft/tests/files-search-demo.mjs
 */
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const plugin = await import(pathToFileURL(path.join(here, '..', 'src', 'index.js')).href)

const sandbox = mkdtempSync(path.join(tmpdir(), 'files-demo-'))
const repo = path.join(sandbox, 'repo')
const sh = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

execFileSync('git', ['init', '-q', '-b', 'main', repo], { encoding: 'utf8' })
sh(['config', 'user.name', 'Demo'])
sh(['config', 'user.email', 'demo@example.com'])

/* A small but realistic tree. */
mkdirSync(path.join(repo, 'src', 'core'), { recursive: true })
mkdirSync(path.join(repo, 'src', 'ui'), { recursive: true })
writeFileSync(path.join(repo, 'src', 'core', 'index.ts'), 'export const a = 1\n')
writeFileSync(path.join(repo, 'src', 'core', 'store.ts'), 'export const store = null\n')
writeFileSync(path.join(repo, 'src', 'ui', 'index.css'), 'body { margin: 0 }\n')
writeFileSync(path.join(repo, 'README.md'), 'hello world\n')
sh(['add', '.'])
sh(['commit', '-q', '-m', 'feat: initial scaffold'])

writeFileSync(path.join(repo, 'src', 'core', 'store.ts'), 'export const store = null\nexport const apply = () => {}\n')
sh(['commit', '-q', '-am', 'feat(core): add an apply channel'])

/* Rename store.ts so the history must be followed across the rename. */
sh(['mv', 'src/core/store.ts', 'src/core/state.ts'])
sh(['commit', '-q', '-m', 'refactor: rename store to state'])

writeFileSync(path.join(repo, 'src', 'core', 'state.ts'), 'export const store = null\nexport const apply = () => {}\nexport const reset = () => {}\n')
sh(['commit', '-q', '-am', 'feat(core): add a reset channel'])

let captured = null
const ctx = {
  webServer: { register(route) { captured = route; return () => {} } },
  effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d() } },
  inject(deps, cb) { cb(ctx); return () => {} },
  get() { return undefined },
  tools: { register() { return () => {} } },
}
await plugin.apply(ctx, {})
const server = createServer(async (req, res) => { await captured.handler(req, res) })
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`
const call = async (m, p) => (await (await fetch(`${base}/dsh-gitcraft/api/${m}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(p),
})).json())

let failures = 0
const check = (name, ok, detail) => {
  if (!ok) failures += 1
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (detail === undefined ? '' : '  ' + detail))
}

try {
  /* ---- 1. search by name ---- */
  let out = await call('search', { cwd: repo, query: 'index', mode: 'name' })
  check('name search finds both index files', out.ok === true && out.data.files.length >= 2,
    JSON.stringify(out.data?.files?.map((f) => f.path)))
  check('  -> basename hits rank first', out.data.files[0].path.includes('index'))

  out = await call('search', { cwd: repo, query: 'src/core', mode: 'name' })
  check('a directory fragment finds the files inside it', out.data.files.length >= 2,
    JSON.stringify(out.data.files.map((f) => f.path)))

  /* ---- 2. search by content ---- */
  out = await call('search', { cwd: repo, query: 'apply channel', mode: 'name' })
  check('name mode does NOT match content', out.data.files.length === 0)

  out = await call('search', { cwd: repo, query: 'export const apply', mode: 'content' })
  check('content search finds the matching line', out.ok === true && out.data.matches.length >= 1,
    JSON.stringify(out.data?.matches?.map((m) => m.path + ':' + m.line)))
  const hit = out.data.matches[0]
  check('  -> reports path, line number and text',
    typeof hit.path === 'string' && typeof hit.line === 'number' && typeof hit.text === 'string',
    JSON.stringify(hit))

  out = await call('search', { cwd: repo, query: 'no-such-token-anywhere', mode: 'content' })
  check('a content search with no match is not an error', out.ok === true && out.data.matches.length === 0)

  /* ---- 3. file history across a rename ---- */
  out = await call('fileHistory', { cwd: repo, path: 'src/core/state.ts' })
  check('fileHistory returns commits', out.ok === true && out.data.commits.length >= 4,
    (out.data?.commits?.length ?? 0) + ' commits')
  const subjects = out.data.commits.map((c) => c.subject)
  check('  -> includes the post-rename commit', subjects.some((s) => s.includes('reset channel')), JSON.stringify(subjects))
  check('  -> includes the RENAME commit', subjects.some((s) => s.includes('rename store to state')))
  check('  -> reaches back BEFORE the rename (--follow)', subjects.some((s) => s.includes('apply channel')),
    JSON.stringify(subjects))
  check('  -> reaches the original creation commit', subjects.some((s) => s.includes('initial scaffold')))

  const reset = out.data.commits.find((c) => c.subject.includes('reset channel'))
  check('  -> per-commit counts are this file\'s own (+1)', reset.added === 1 && reset.deleted === 0,
    JSON.stringify({ added: reset.added, deleted: reset.deleted }))

  console.log('\n  history of src/core/state.ts:')
  for (const c of out.data.commits) {
    console.log('    ' + c.short + '  +' + c.added + ' −' + c.deleted + '  ' + c.subject)
  }

  /* ---- 4. a file with no history ---- */
  out = await call('fileHistory', { cwd: repo, path: 'nope.txt' })
  check('an unknown path is empty data, not an error', out.ok === true && out.data.commits.length === 0)
} finally {
  await new Promise((r) => server.close(r))
  try { rmSync(sandbox, { recursive: true, force: true }) } catch { }
}

console.log(failures === 0 ? '\nFILES SEARCH DEMO PASS' : `\nFILES SEARCH DEMO FAIL (${failures})`)
process.exitCode = failures === 0 ? 0 : 1
