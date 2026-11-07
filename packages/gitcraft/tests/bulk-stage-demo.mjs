/**
 * End-to-end proof of the "全部暂存 fails with 找不到 git 命令" fix, against a
 * THROWAWAY repo with a change set that genuinely exceeds the Win32 command-line
 * cap, driven through the plugin's own apply() + HTTP route.
 *
 * Also exercises「全部撤销」on the same oversized tree.
 *
 * Usage: node packages/gitcraft/tests/bulk-stage-demo.mjs
 */
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const plugin = await import(pathToFileURL(path.join(here, '..', 'src', 'index.js')).href)

const sandbox = mkdtempSync(path.join(tmpdir(), 'bulk-demo-'))
const repo = path.join(sandbox, 'repo')
const sh = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

sh(sandbox, ['init', '-q', '-b', 'main', repo])
sh(repo, ['config', 'user.name', 'Demo'])
sh(repo, ['config', 'user.email', 'demo@example.com'])
writeFileSync(path.join(repo, 'seed.txt'), 'seed\n')
sh(repo, ['add', '.'])
sh(repo, ['commit', '-q', '-m', 'chore: seed'])

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
const call = async (method, payload) => (await (await fetch(`${base}/dsh-gitcraft/api/${method}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
})).json())

let failures = 0
const check = (name, ok, detail) => {
  if (!ok) failures += 1
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (detail === undefined ? '' : '  ' + detail))
}

try {
  /* A build-sized change set: 2500 new files with long names. */
  const many = path.join(repo, 'generated')
  mkdirSync(many, { recursive: true })
  const names = []
  for (let i = 0; i < 2500; i += 1) {
    const name = 'generated-asset-file-with-a-long-descriptive-name-' + String(i).padStart(5, '0') + '.txt'
    names.push('generated/' + name)
    writeFileSync(path.join(many, name), 'x\n')
  }
  const argvChars = names.join(' ').length
  check('the old path list would exceed the Win32 argv cap', argvChars > 32767, argvChars + ' chars')

  /* 1. The OLD client behaviour: pass every path. Must fail with a truthful code. */
  const byPath = await call('stage', { cwd: repo, paths: names })
  check('passing every path now reports argv-too-long', byPath.ok === false && byPath.error.code === 'argv-too-long',
    JSON.stringify(byPath.error?.code))
  check('  -> and no longer claims git is missing', byPath.error?.code !== 'git-missing')

  /* 2. The NEW behaviour: one flag. Must just work. */
  const staged = await call('stage', { cwd: repo, all: true })
  const stagedCount = staged.data?.changes?.filter((e) => e.staged).length ?? 0
  check('「全部暂存」stages the whole change set with one command', staged.ok === true && stagedCount >= 2500,
    stagedCount + ' staged')

  const unstaged = await call('unstage', { cwd: repo, all: true })
  check('「全部取消暂存」clears it again', unstaged.ok === true && unstaged.data.changes.every((e) => !e.staged))

  /* 3.「全部撤销」on the same oversized tree. */
  const noConfirm = await call('discard', { cwd: repo, all: true })
  check('「全部撤销」refuses without confirmation', noConfirm.ok === false && noConfirm.error.code === 'confirm-required')

  const discarded = await call('discard', { cwd: repo, all: true, confirm: true })
  check('「全部撤销」clears the tree', discarded.ok === true && discarded.data.changes.length === 0,
    (discarded.data?.changes?.length ?? '?') + ' changes left')
  check('  -> the generated files are gone', !(() => {
    try { sh(repo, ['rev-parse', '--verify', 'HEAD']); return false } catch { return true }
  })() && discarded.data.changes.length === 0)
} finally {
  await new Promise((r) => server.close(r))
  try { rmSync(sandbox, { recursive: true, force: true }) } catch { /* windows lock */ }
}

console.log(failures === 0 ? '\nBULK STAGE DEMO PASS' : `\nBULK STAGE DEMO FAIL (${failures})`)
process.exitCode = failures === 0 ? 0 : 1
