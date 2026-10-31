/**
 * WorkbayPty.exe smoke tests — drive the ConPTY helper the way the host does.
 *
 * These are FRAME-LEVEL tests: no host code involved. They spawn the helper with
 * a real PowerShell inside a real pseudoconsole and speak the binary protocol
 * documented in docs/terminal-pty.md §1 and helper/README.md.
 *
 * Run:  node --test tests/pty-helper.test.mjs   (Windows only)
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE = path.join(HERE, '..')
const EXE = path.join(PACKAGE, 'helper', 'WorkbayPty.exe')
const IS_WINDOWS = process.platform === 'win32'
const SYSTEM_ROOT = process.env.SystemRoot === undefined || process.env.SystemRoot === '' ? 'C:\\Windows' : process.env.SystemRoot
const SHELL = path.join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const SHELL_ARGS = ['-NoLogo', '-NoProfile', '-NoExit']

const SKIP = IS_WINDOWS === false
  ? 'WorkbayPty.exe is a Windows ConPTY helper'
  : existsSync(EXE) === false ? 'helper/WorkbayPty.exe is not present (run the csc build in helper/README.md)' : false

const sessions = []
let cwd = ''

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const base64Args = (array) => Buffer.from(JSON.stringify(array), 'utf8').toString('base64')

/**
 * One helper process plus an incremental frame parser for its stdout.
 * Every frame is 1 byte type + uint32 LE length + payload; stdout carries frames
 * only, stderr carries diagnostics.
 */
function startSession() {
  const child = spawn(EXE, [
    '--shell', SHELL,
    '--shell-args', base64Args(SHELL_ARGS),
    '--cwd', cwd,
    '--cols', '120',
    '--rows', '30',
  ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })

  const state = {
    child,
    frames: [],
    chunks: [],
    stderr: '',
    pending: Buffer.alloc(0),
    exitFrame: undefined,
    exitCode: undefined,
    spawnError: undefined,
  }
  sessions.push(state)

  child.stdout.on('data', (chunk) => {
    state.pending = Buffer.concat([state.pending, chunk])
    while (state.pending.length >= 5) {
      const type = String.fromCharCode(state.pending[0])
      const length = state.pending.readUInt32LE(1)
      if (state.pending.length < 5 + length) break
      const payload = state.pending.subarray(5, 5 + length)
      state.pending = state.pending.subarray(5 + length)
      state.frames.push({ type, length, at: Date.now() })
      if (type === 'D') state.chunks.push(Buffer.from(payload))
      if (type === 'X') {
        assert.equal(state.exitFrame, undefined, 'a session must send exactly one X frame')
        assert.equal(length, 4, 'the X frame payload is an int32 exit code')
        state.exitFrame = payload.readInt32LE(0)
      }
    }
  })
  child.stderr.on('data', (chunk) => { state.stderr += chunk.toString('utf8') })
  child.on('error', (error) => { state.spawnError = error })
  child.on('exit', (code, signal) => { state.exitCode = code === null ? undefined : code; state.signal = signal })

  state.send = (type, payload = Buffer.alloc(0)) => {
    const header = Buffer.alloc(5)
    header.write(type, 0, 1, 'ascii')
    header.writeUInt32LE(payload.length, 1)
    child.stdin.write(Buffer.concat([header, payload]))
  }
  state.sendText = (text) => state.send('D', Buffer.from(text, 'utf8'))
  state.resize = (cols, rows) => {
    const payload = Buffer.alloc(4)
    payload.writeUInt16LE(cols, 0)
    payload.writeUInt16LE(rows, 2)
    state.send('R', payload)
  }
  state.terminate = (pid = 0) => {
    const payload = Buffer.alloc(4)
    payload.writeUInt32LE(pid >>> 0, 0)
    state.send('X', payload)
  }
  state.bytes = () => Buffer.concat(state.chunks)
  state.text = () => state.bytes().toString('utf8')

  state.waitFor = async (predicate, timeoutMs, label) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate()) return true
      await sleep(40)
    }
    return false
  }
  state.waitForText = (needle, timeoutMs = 20_000) =>
    state.waitFor(() => state.text().includes(needle), timeoutMs, needle)
  state.waitForX = (timeoutMs = 8_000) =>
    state.waitFor(() => state.exitFrame !== undefined, timeoutMs, 'X frame')

  state.stop = async () => {
    if (state.exitCode !== undefined) return
    try { child.stdin.end() } catch { /* already closed */ }
    const exited = await state.waitFor(() => state.exitCode !== undefined, 4_000, 'helper exit')
    if (exited === false) {
      try { child.kill() } catch { /* already gone */ }
      await state.waitFor(() => state.exitCode !== undefined, 4_000, 'helper kill')
    }
  }
  return state
}

before(async () => {
  if (SKIP !== false) return
  cwd = mkdtempSync(path.join(tmpdir(), 'workbay-pty-test-'))
})

after(async () => {
  for (const session of sessions) {
    if (session.exitCode === undefined) {
      try { session.child.stdin.end() } catch { /* ignore */ }
      try { session.child.kill() } catch { /* ignore */ }
    }
  }
  /* Give the job objects a moment to reap the shells, then drop the temp cwd. */
  await sleep(500)
  if (cwd !== '') rmSync(cwd, { recursive: true, force: true })
})

/* ============================== protocol ============================== */

test('the helper echoes typed input through the real PTY', { skip: SKIP }, async () => {
  const session = startSession()
  assert.equal(await session.waitFor(() => session.bytes().length > 0, 20_000, 'banner'), true, 'no PTY output at all: ' + session.stderr)

  session.sendText('echo workbay-pty-ok\r\n')
  assert.equal(await session.waitForText('workbay-pty-ok'), true, 'echo output never arrived')
  const text = session.text()
  /* The console echoes the typed line AND the shell prints the result. PowerShell
     interleaves SGR codes inside the echoed line, so compare with them stripped. */
  const plain = text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
  assert.ok(plain.includes('echo workbay-pty-ok'), 'the typed command was not echoed by the console')
  assert.equal(session.stderr, '', 'the helper must keep stderr for diagnostics only')
})

test('UTF-8 arrives as raw bytes (no transcoding)', { skip: SKIP }, async () => {
  const session = startSession()
  await session.waitFor(() => session.bytes().length > 0, 20_000, 'banner')

  const marker = '中文测试'
  session.sendText('echo ' + marker + '\r\n')
  const raw = Buffer.from(marker, 'utf8')
  assert.equal(await session.waitFor(() => session.bytes().includes(raw), 20_000, 'utf8 bytes'), true,
    'the UTF-8 byte sequence did not come back unchanged')

  const text = session.text()
  assert.ok(text.includes(marker), 'decoded output lost the CJK text')
  assert.equal(text.includes('\uFFFD'), false, 'output contains U+FFFD: bytes were transcoded somewhere')
})

test('ANSI escape sequences pass through untouched', { skip: SKIP }, async () => {
  const session = startSession()
  await session.waitFor(() => session.bytes().length > 0, 20_000, 'banner')

  /* NB: the unquoted form `Write-Host $([char]27)[32m...` is a PowerShell parse
     error, so the sequence is built inside a double-quoted string. */
  session.sendText('Write-Host "$([char]27)[32mgreen$([char]27)[0m"\r\n')
  assert.equal(await session.waitForText('\u001b[32m', 20_000), true, 'ESC[32m never reached the host')
  /* ConPTY normalises the reset to either ESC[0m or ESC[m. */
  assert.match(session.text(), /\u001b\[(0)?m/, 'the SGR reset never reached the host')
})

test('an R frame resizes the console without breaking the stream', { skip: SKIP }, async () => {
  const session = startSession()
  await session.waitFor(() => session.bytes().length > 0, 20_000, 'banner')

  session.resize(100, 40)
  await sleep(250)
  session.sendText('echo after-resize\r\n')
  assert.equal(await session.waitForText('after-resize', 20_000), true, 'output stopped after a resize frame')
  assert.equal(session.exitCode, undefined, 'the helper died on a resize frame')
})

/* ============================== termination ============================== */

test('an X frame terminates the shell and reports its exit code last', { skip: SKIP }, async () => {
  const session = startSession()
  await session.waitFor(() => session.bytes().length > 0, 20_000, 'banner')

  session.sendText('Write-Host tail-marker; exit 3\r\n')
  assert.equal(await session.waitForText('tail-marker', 20_000), true, 'the shell never ran the command')
  assert.equal(await session.waitForX(5_000), true, 'no X frame within 5 s')

  assert.equal(session.exitFrame, 3, 'X must carry the shell exit code')
  /* X has to be the LAST frame: everything the shell printed is already out. */
  const xIndex = session.frames.findIndex((frame) => frame.type === 'X')
  assert.equal(xIndex, session.frames.length - 1, 'frames arrived after X')
  assert.equal(session.text().includes('tail-marker'), true, 'the last output was lost before X')

  assert.equal(await session.waitFor(() => session.exitCode !== undefined, 5_000, 'helper exit'), true)
  assert.equal(session.exitCode, 0, 'the helper exits 0 after reporting the shell code in X')
})

test('closing stdin reaps the shell process tree', { skip: SKIP }, async () => {
  const session = startSession()
  await session.waitFor(() => session.bytes().length > 0, 20_000, 'banner')

  session.sendText('echo shellpid=$PID\r\n')
  assert.equal(await session.waitFor(() => /shellpid=(\d+)/.test(session.text()), 20_000, 'shell pid'), true)
  const shellPid = Number(/shellpid=(\d+)/.exec(session.text())[1])
  assert.ok(shellPid > 0)

  session.child.stdin.end()
  assert.equal(await session.waitFor(() => session.exitCode !== undefined, 6_000, 'helper exit on EOF'), true,
    'the helper did not exit after stdin EOF')

  /* tasklist CSV prints a quoted row only for a live process; otherwise it prints
     a localised "no tasks" message. */
  let alive = true
  for (let attempt = 0; attempt < 25 && alive; attempt += 1) {
    const out = execFileSync('tasklist', ['/FI', 'PID eq ' + shellPid, '/FO', 'CSV', '/NH'], { encoding: 'utf8' }).trim()
    alive = out.startsWith('"')
    if (alive) await sleep(200)
  }
  assert.equal(alive, false, 'the shell process ' + shellPid + ' survived stdin EOF (orphaned -NoExit shell)')
})

/* ============================== argv guard ============================== */

function runHelper(argv) {
  try {
    const stdout = execFileSync(EXE, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    return { status: error.status, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') }
  }
}

test('invalid argv exits 2 with one diagnostic line', { skip: SKIP }, () => {
  const cases = [
    { label: 'missing value', argv: ['--shell'] },
    { label: 'missing args', argv: [] },
    { label: 'unknown argument', argv: ['--shell', SHELL, '--shell-args', base64Args(SHELL_ARGS), '--cwd', cwd, '--cols', '80', '--rows', '24', '--extra', 'x'] },
    { label: 'not base64', argv: ['--shell', SHELL, '--shell-args', 'not base64!!', '--cwd', cwd, '--cols', '80', '--rows', '24'] },
    { label: 'not a string array', argv: ['--shell', SHELL, '--shell-args', Buffer.from('{"a":1}', 'utf8').toString('base64'), '--cwd', cwd, '--cols', '80', '--rows', '24'] },
    { label: 'relative shell', argv: ['--shell', 'powershell.exe', '--shell-args', base64Args(SHELL_ARGS), '--cwd', cwd, '--cols', '80', '--rows', '24'] },
    { label: 'bad cols', argv: ['--shell', SHELL, '--shell-args', base64Args(SHELL_ARGS), '--cwd', cwd, '--cols', '0', '--rows', '24'] },
    { label: 'missing cwd', argv: ['--shell', SHELL, '--shell-args', base64Args(SHELL_ARGS), '--cwd', path.join(cwd, 'nope'), '--cols', '80', '--rows', '24'] },
  ]
  for (const testCase of cases) {
    const result = runHelper(testCase.argv)
    assert.equal(result.status, 2, testCase.label + ': expected exit 2, got ' + result.status)
    assert.equal(result.stdout, '', testCase.label + ': stdout must stay frame-only')
    const lines = result.stderr.trim().split(/\r?\n/).filter((line) => line !== '')
    assert.equal(lines.length, 1, testCase.label + ': expected exactly one stderr line, got ' + JSON.stringify(result.stderr))
    assert.match(lines[0], /WorkbayPty: invalid arguments:/, testCase.label + ': stderr line lacks the diagnostic prefix')
  }
})
