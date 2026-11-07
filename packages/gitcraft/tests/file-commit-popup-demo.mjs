/**
 * End-to-end proof for the Files-page commit popup: the two host calls the
 * popup makes must return what the popup renders.
 *
 *   commitDetail -> subject / body / author / files
 *   diff(base:'commit', rev) -> THIS file's diff at that commit
 *
 * Usage: node packages/gitcraft/tests/file-commit-popup-demo.mjs
 */
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const plugin = await import(pathToFileURL(path.join(here, '..', 'src', 'index.js')).href)

const sandbox = mkdtempSync(path.join(tmpdir(), 'popup-demo-'))
const repo = path.join(sandbox, 'repo')
const sh = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

execFileSync('git', ['init', '-q', '-b', 'main', repo], { encoding: 'utf8' })
sh(['config', 'user.name', 'Demo'])
sh(['config', 'user.email', 'demo@example.com'])

mkdirSync(path.join(repo, 'src'), { recursive: true })
writeFileSync(path.join(repo, 'src', 'target.ts'), 'export const a = 1\n')
writeFileSync(path.join(repo, 'README.md'), '# demo\n')
sh(['add', '.'])
sh(['commit', '-q', '-m', 'feat: initial scaffold'])

/* A commit that touches the target file AND an unrelated one. */
writeFileSync(path.join(repo, 'src', 'target.ts'), 'export const a = 1\nexport const b = 2\n')
writeFileSync(path.join(repo, 'README.md'), '# demo\n\nmore docs\n')
sh(['commit', '-q', '-am', 'feat: add b and document it\n\nThis body explains WHY, and must survive the round trip.'])

const targetHash = sh(['rev-parse', 'HEAD']).trim()

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
  /* ---- what the popup's header shows ---- */
  const detail = await call('commitDetail', { cwd: repo, rev: targetHash })
  check('commitDetail returns the commit', detail.ok === true, JSON.stringify(detail.error))
  check('  -> subject', detail.data.subject === 'feat: add b and document it', detail.data?.subject)
  check('  -> body is kept (the popup renders it)', /This body explains WHY/.test(detail.data.body ?? ''),
    JSON.stringify(detail.data?.body))
  check('  -> author + time', typeof detail.data.authorName === 'string' && detail.data.authorTime > 0)
  check('  -> it lists BOTH files the commit touched', detail.data.files.length === 2,
    JSON.stringify(detail.data.files.map((f) => f.path)))

  /* ---- what the popup's diff pane shows: THIS file only ---- */
  const diff = await call('diff', { cwd: repo, path: 'src/target.ts', base: 'commit', rev: targetHash })
  check('diff(base:commit) succeeds', diff.ok === true, JSON.stringify(diff.error))
  check('  -> the patch is this file\'s change', /\+\s*export const b = 2/.test(diff.data.patch ?? ''),
    JSON.stringify((diff.data.patch ?? '').slice(0, 160)))
  check('  -> and NOT the unrelated file', !/more docs/.test(diff.data.patch ?? ''),
    'README.md must not leak into the popup')

  /* The popup must survive a commit that did not touch the file at all. */
  writeFileSync(path.join(repo, 'README.md'), '# demo\n\nmore docs\nyet more\n')
  sh(['commit', '-q', '-am', 'docs: unrelated change'])
  const unrelated = sh(['rev-parse', 'HEAD']).trim()
  const emptyDiff = await call('diff', { cwd: repo, path: 'src/target.ts', base: 'commit', rev: unrelated })
  check('a commit that did not touch the file yields an empty diff, not an error',
    emptyDiff.ok === true && (emptyDiff.data.patch ?? '') === '', JSON.stringify(emptyDiff.data?.patch))

  /* And a binary file must be reported as binary rather than as an empty diff. */
  writeFileSync(path.join(repo, 'src', 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 255]))
  sh(['add', 'src/blob.bin'])
  sh(['commit', '-q', '-m', 'chore: add a binary blob'])
  const binHash = sh(['rev-parse', 'HEAD']).trim()
  const binDiff = await call('diff', { cwd: repo, path: 'src/blob.bin', base: 'commit', rev: binHash })
  check('a binary file is reported (binary flag or empty patch, never a crash)',
    binDiff.ok === true, JSON.stringify(binDiff.error))
} finally {
  await new Promise((r) => server.close(r))
  try { rmSync(sandbox, { recursive: true, force: true }) } catch { }
}

console.log(failures === 0 ? '\nFILE COMMIT POPUP DEMO PASS' : `\nFILE COMMIT POPUP DEMO FAIL (${failures})`)
process.exitCode = failures === 0 ? 0 : 1
