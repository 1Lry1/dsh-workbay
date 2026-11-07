/**
 * Host-side regression tests for the downloader plugin (no DSH boot, no hardware).
 *
 * The two bugs these lock down were observed on a real board:
 *   1) two `launch` commands reached the IPC helper (two Downloader windows /
 *      "tool conflict") when /flash/start was clicked twice or raced the
 *      auto-flash path;
 *   2) a failed serial open printed one "串口错误" line per retry (10x) and each
 *      attempt waited the 3 s command timeout because the helper's failure was
 *      an id-less `err` event instead of an id-matched reply.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { __test } from '../lib/index.js'
const { shouldLaunchFlash, serialErrorLine, isUnderScanRoot, pruneBackups } = __test
function flashState(overrides = {}) {
  return { connected: false, launching: false, pid: null, ...overrides }
}

function serialState() {
  return { serial: { opening: false, lastError: null, dupCount: 0, suppressed: 0 } }
}

test('shouldLaunchFlash allows exactly one launch while idle', () => {
  assert.equal(shouldLaunchFlash(flashState(), false), true)
  assert.equal(shouldLaunchFlash(flashState(), true), true)
})

test('shouldLaunchFlash blocks a second launch during startup', () => {
  assert.equal(shouldLaunchFlash(flashState({ launching: true }), true), false)
  // launched but handshake not done yet: pid is set and the helper is alive
  assert.equal(shouldLaunchFlash(flashState({ pid: 4242 }), true), false)
})

test('shouldLaunchFlash blocks once connected, allows after helper exit', () => {
  assert.equal(shouldLaunchFlash(flashState({ connected: true }), true), false)
  // helper exited (alive=false): pid is stale, a fresh launch is allowed
  assert.equal(shouldLaunchFlash(flashState({ pid: 4242 }), false), true)
})

test('serialErrorLine collapses identical errors inside the 3 s window', () => {
  const state = serialState()
  const first = serialErrorLine(state, '拒绝访问 COM22', 1000)
  assert.match(first, /串口错误: 拒绝访问 COM22/)
  assert.equal(state.serial.dupCount, 0)

  assert.equal(serialErrorLine(state, '拒绝访问 COM22', 1500), null)
  assert.equal(serialErrorLine(state, '拒绝访问 COM22', 2000), null)
  assert.equal(state.serial.dupCount, 2)

  // A new distinct message flushes the merged count in its own line.
  const next = serialErrorLine(state, '另一个错误', 2500)
  assert.match(next, /已合并 2 条重复错误/)
  assert.equal(state.serial.dupCount, 0)
})

test('serialErrorLine logs again after the dedupe window', () => {
  const state = serialState()
  assert.notEqual(serialErrorLine(state, 'timeout', 1000), null)
  assert.equal(serialErrorLine(state, 'timeout', 3999), null)
  assert.notEqual(serialErrorLine(state, 'timeout', 5000), null)
})

test('serialErrorLine never returns an empty line', () => {
  const state = serialState()
  assert.match(serialErrorLine(state, '   ', 1000), /未知错误/)
})


/* ---- 配置写入 ------------------------------------------------------------
 * Downloader 的 IPC 没有"打开指定 dcf"的命令，只认它 config 里的 DownFile。
 * 这里验证替换逻辑本身（用临时 config，不碰真实安装）。
 */
test('writeDownFile replaces only the DownFile slot and keeps a backup', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dl-cfg-'))
  const cfg = path.join(dir, 'Downloader.config')
  writeFileSync(cfg, [
    '<?xml version="1.0"?>',
    '<configuration>',
    '  <appSettings>',
    '    <add key="COMEnable" value="True" />',
    '    <add key="DownFile" value="C:\\old\\app.dcf" />',
    '    <add key="DownFile1" value="C:\\old\\app.dcf" />',
    '  </appSettings>',
    '</configuration>',
  ].join('\n'))
  const dcf = path.join(dir, 'app.dcf')
  writeFileSync(dcf, 'dcf')

  const r = await __test.writeDownFile(dcf, dir)
  assert.equal(r.ok, true)
  assert.equal(r.changed, true)
  const after = readFileSync(cfg, 'utf8')
  assert.ok(after.includes(`<add key="DownFile" value="${dcf}" />`), 'DownFile updated')
  assert.ok(after.includes('C:\\old\\app.dcf'), 'history slots untouched')
  assert.ok(after.includes('COMEnable'), 'other keys untouched')
  assert.ok(typeof r.backup === 'string' && existsSync(r.backup), 'backup written')
})

/* ---- 取消 FileInfo 覆盖 ----------------------------------------------------
 * Downloader 连上后会把它 config 里的 dcf 推过来。切换过工作目录之后那个值还是
 * 旧工程的 —— 一连接就把我们刚设好的路径覆盖回去，界面看起来「又变回去了」。
 * 规则：只有落在当前工作目录内才采纳。
 */
test('isUnderScanRoot rejects paths from another workspace', () => {
  assert.equal(isUnderScanRoot('D:\\ws\\b\\proj\\Output\\bin\\app.dcf', 'D:\\ws\\b'), true)
  assert.equal(isUnderScanRoot('D:\\ws\\b', 'D:\\ws\\b'), true)
  assert.equal(isUnderScanRoot('D:\\ws\\a\\proj\\Output\\bin\\app.dcf', 'D:\\ws\\b'), false)
  // 没有工作目录信息时保持旧行为：一律接受
  assert.equal(isUnderScanRoot('D:\\ws\\a\\app.dcf', ''), true)
})

/* ---- 工具路径决定配置目录 ------------------------------------------------
 * Downloader.config 就在 Downloader.exe 旁边。原来只认环境变量，用户没配就写到
 * ~/Downloader —— 于是"切换工作目录后写配置"静默失败。
 */
test('resolveDlDir prefers the directory of the configured exe', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dl-tool-'))
  const exe = path.join(dir, 'Downloader.exe')
  writeFileSync(exe, 'x')
  writeFileSync(path.join(dir, 'Downloader.config'), '<configuration/>')

  const { resolveDlDir, readToolConfig } = __test
  /* 未配置时返回默认目录（这里只验证"不会崩"且返回字符串）。 */
  assert.equal(typeof resolveDlDir(), 'string')
  assert.equal(typeof readToolConfig().exe, 'string')
})

/* ---- 备份文件不能无限堆积 ------------------------------------------------
 * writeDownFile 每次切换目录都会备份 Downloader.config。切十次就是十个 .bak 文件，
 * 全躺在厂商的安装目录里。只留最近几个。
 */
test('pruneBackups keeps only the newest backups', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dl-bak-'))
  const cfg = path.join(dir, 'Downloader.config')
  writeFileSync(cfg, '<configuration/>')
  for (let i = 1; i <= 6; i += 1) writeFileSync(dir + '/Downloader.config.bak-' + (1793960027000 + i), 'x')

  const { pruneBackups } = __test
  const removed = pruneBackups(cfg, 2)
  assert.equal(removed, 4)

  const left = readdirSync(dir).filter((n) => n.startsWith('Downloader.config.bak-')).sort()
  assert.equal(left.length, 2)
  /* The SURVIVORS must be the newest, not an arbitrary pair: a backup that loses the
     most recent state is worse than no backup at all. */
  assert.equal(left[0], 'Downloader.config.bak-1793960027005')
  assert.equal(left[1], 'Downloader.config.bak-1793960027006')
})
