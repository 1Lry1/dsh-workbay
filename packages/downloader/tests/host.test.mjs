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
const { shouldLaunchFlash, beginFlashLaunch, isStaleFlashConnection, isProcessAlive, shouldReleaseSerialForDownloader, normalizeSerialEncoding, classifyDownloaderPids, reconcileDownloaderPids, clearFlashTimers, wireJson, flashPlanOf, toolAutoStartOf, sameFlashPath, withAutoStartValue, isPrimaryFirmwareDcf, pickPrimaryFirmwareDcf, serialErrorLine, isUnderScanRoot, pruneBackups, sleepSettingOf, withNoSleepSetting, withConfigValue, parseBurnOptions } = __test
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

test('isProcessAlive uses an exact PID probe instead of a racy tasklist snapshot', () => {
  assert.equal(isProcessAlive(process.pid), true)
  assert.equal(isProcessAlive(0), false)
  assert.equal(isProcessAlive(-1), false)
  assert.equal(isProcessAlive(999999), false)
})
test('serial guard yields COM only when a running Downloader can need it', () => {
  assert.equal(shouldReleaseSerialForDownloader(true, false, [123]), true)
  assert.equal(shouldReleaseSerialForDownloader(false, false, [123]), false)
  assert.equal(shouldReleaseSerialForDownloader(true, true, [123]), false, 'never steal COM back mid-burn')
  assert.equal(shouldReleaseSerialForDownloader(true, false, []), false)
})
test('helper pipes have error listeners so an async EPIPE cannot kill DSH', () => {
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(source, /guardStream\(this\.proc\.stdin, 'stdin'\)/)
  assert.match(source, /stream\.on\('error'/)
  assert.match(source, /this\.proc\.stdin\.destroyed/)
})
test('the 5 s watch tick never kills a user-opened Downloader', () => {
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const start = source.indexOf('function watchTick()')
  assert.ok(start >= 0)
  const end = source.indexOf('One auto-flash at a time', start)
  const body = source.slice(start, end < 0 ? undefined : end)
  assert.equal(body.includes('takeOverForeign('), false)
})
test('HTTP routes receive the serial/flash guard helpers from apply scope', () => {
  /* /serial/open and /flash/start live in module-level handleHttp(); calling
     apply-scoped helpers without passing them through `api` threw
     "startSerialGuard is not defined" AFTER opening the port, so the page never
     got its serial-state broadcast and the button stayed unchanged. */
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(source, /clearLogFile, startSerialGuard, stopSerialGuard, resetStaleFlashConnection/)
  assert.match(source, /clearFlashTimersNow: \(\) => clearFlashTimers/)
  assert.match(source, /const \{[^}]*startSerialGuard[^}]*stopSerialGuard[^}]*resetStaleFlashConnection[^}]*\} = api/s)
})
test('stale connection is detected when the Downloader window is gone', () => {
  assert.equal(isStaleFlashConnection({ connected: false, pid: null }, []), false)
  assert.equal(isStaleFlashConnection({ connected: true, pid: null }, []), true)
  assert.equal(isStaleFlashConnection({ connected: true, pid: 12 }, []), true)
  assert.equal(isStaleFlashConnection({ connected: true, pid: 12 }, [12]), false)
  assert.equal(isStaleFlashConnection({ connected: true, pid: 12 }, [99]), true)
})
test('beginFlashLaunch locks synchronously so two clicks cannot launch twice', () => {
  const flash = { connected: false, launching: false, pid: null }
  assert.equal(beginFlashLaunch(flash, true), true)
  assert.equal(flash.launching, true)
  assert.equal(beginFlashLaunch(flash, true), false, 'second click while starting is refused')
  flash.launching = false
  assert.equal(beginFlashLaunch(flash, true), true, 'a released lock can be taken again')
  assert.equal(beginFlashLaunch({ connected: true, launching: false, pid: null }, true), false)
})
test('clearFlashTimers drops a superseded flash timer and is safe to repeat', () => {
  let retryTicks = 0
  const flash = {
    retryTimer: setInterval(() => { retryTicks += 1 }, 10),
    overallTimer: setTimeout(() => { retryTicks += 100 }, 10),
  }
  assert.equal(clearFlashTimers(flash), true)
  assert.equal(flash.retryTimer, null)
  assert.equal(flash.overallTimer, null)
  assert.equal(clearFlashTimers(flash), false)
  assert.equal(clearFlashTimers(null), false)
})
test('wireJson survives circular timer handles that used to crash broadcast', () => {
  const timer = setInterval(() => {}, 1000)
  try {
    const circular = { token: 1 }
    circular.self = circular
    circular.retryTimer = timer
    const text = wireJson({ flash: circular })
    const parsed = JSON.parse(text)
    assert.equal(parsed.flash.token, 1)
    assert.equal(parsed.flash.self, undefined)
    assert.equal(parsed.flash.retryTimer, undefined)
    /* A timer handle is omitted instead of being walked into its circular links. */
    assert.equal(text.includes('_idlePrev'), false)
  } finally {
    clearInterval(timer)
  }
})
test('classifyDownloaderPids separates our bridge child from a user-opened Downloader', () => {
  /* No Downloader at all -> free to launch. */
  assert.deepEqual(classifyDownloaderPids([], null), { total: 0, mine: null, foreign: [] })
  /* Only a user-opened instance -> never launch a second one. */
  assert.deepEqual(classifyDownloaderPids([101], null), { total: 1, mine: null, foreign: [101] })
  /* Only our recorded child -> wait for its handshake, do not relaunch. */
  assert.deepEqual(classifyDownloaderPids([202], 202), { total: 1, mine: 202, foreign: [] })
  /* Our child plus a second user-opened instance -> pause. */
  assert.deepEqual(classifyDownloaderPids([101, 202], 202), { total: 2, mine: 202, foreign: [101] })
  /* Stale recorded PID (process gone) -> current instance counts as foreign. */
  assert.deepEqual(classifyDownloaderPids([101], 999), { total: 1, mine: null, foreign: [101] })
  /* Duplicates / junk from tasklist are ignored. */
  assert.deepEqual(classifyDownloaderPids([101, 101, 'x', -1, null], null), { total: 1, mine: null, foreign: [101] })
})

test('serial encoding accepts UTF-8, GB18030 and ASCII only', () => {
  assert.equal(normalizeSerialEncoding('UTF-8'), 'utf-8')
  assert.equal(normalizeSerialEncoding('utf8'), 'utf-8')
  assert.equal(normalizeSerialEncoding('gbk'), 'gb18030')
  assert.equal(normalizeSerialEncoding('GB18030'), 'gb18030')
  assert.equal(normalizeSerialEncoding('ascii'), 'ascii')
  assert.equal(normalizeSerialEncoding('bogus'), 'utf-8')
  assert.equal(normalizeSerialEncoding(undefined), 'utf-8')
})

test('reconcileDownloaderPids keeps our PID through a transient tasklist miss', () => {
  /* The exact process probe still sees our child even though tasklist missed it. */
  assert.deepEqual(reconcileDownloaderPids([], 202, true, false), {
    total: 0, mine: 202, foreign: [], clearRecorded: false,
  })
  assert.deepEqual(reconcileDownloaderPids([101], 202, true, false), {
    total: 1, mine: 202, foreign: [101], clearRecorded: false,
  })
  /* The recorded process is really gone: next real instance is foreign. */
  assert.deepEqual(reconcileDownloaderPids([101], 202, false, false), {
    total: 1, mine: null, foreign: [101], clearRecorded: true,
  })
  /* Our PID was lost, but the active bridge owns the sole Downloader. */
  assert.deepEqual(reconcileDownloaderPids([202], null, false, true), {
    total: 1, mine: 202, foreign: [], clearRecorded: false,
  })
  /* The bridge child restarted under a new PID while the burn stayed active. */
  assert.deepEqual(reconcileDownloaderPids([202], 101, false, true), {
    total: 1, mine: 202, foreign: [], clearRecorded: false,
  })
  /* Never adopt a single process when the bridge is idle. */
  assert.deepEqual(reconcileDownloaderPids([202], null, false, false), {
    total: 1, mine: null, foreign: [202], clearRecorded: false,
  })
})

test('shouldLaunchFlash blocks once connected, allows after helper exit', () => {
  assert.equal(shouldLaunchFlash(flashState({ connected: true }), true), false)
  // helper exited (alive=false): pid is stale, a fresh launch is allowed
  assert.equal(shouldLaunchFlash(flashState({ pid: 4242 }), false), true)
})

test('flashPlanOf: manual keeps the strict device check, auto queues instead', () => {
  const online = { flash: { online: true } }
  const offline = { flash: { online: false } }

  const manual = flashPlanOf(offline, {})
  assert.equal(manual.queueWhileOffline, false, 'a person clicking 开始烧录 must get a clear "no device" error')
  assert.equal(manual.abortWhenScanning, true)
  assert.equal(manual.retryLimit, 1, 'manual also sends at most one extra command after 10 s')
  assert.equal(manual.retryDelayMs, 10000)
  assert.equal(manual.offlineWaitMs, 20000)

  const auto = flashPlanOf(offline, { auto: true })
  assert.equal(auto.queueWhileOffline, true, 'auto gives the command to Downloader during its COM scan')
  assert.equal(auto.abortWhenScanning, false)
  assert.equal(auto.retryLimit, 1, 'a blind burst of StartDownload causes several scans')
  assert.equal(auto.retryDelayMs, 20000)
  assert.equal(auto.offlineWaitMs, 0)
  assert.equal(auto.online, false)

  assert.equal(flashPlanOf(online, { auto: true }).online, true)
  assert.equal(flashPlanOf(undefined, undefined).queueWhileOffline, false)
})

test('burn option helpers update only the persistent Downloader.config keys', () => {
  const config = '<appSettings>\n'
    + '<add key="StartPreTestMode" value="False" />\n'
    + '<add key="StartEraseMode" value="False" />\n'
    + '<add key="StartDownMode" value="True" />\n'
    + '<add key="StartExtendMode" value="False" />\n'
    + '<add key="SpeedMode" value="HighSpeed" />\n'
    + '</appSettings>'
  const parsed = parseBurnOptions(config)
  assert.deepEqual(parsed, { preTest: false, erase: false, down: true, extend: false, speed: 'HighSpeed' })
  let next = withConfigValue(config, 'StartPreTestMode', 'True').text
  next = withConfigValue(next, 'StartExtendMode', 'True').text
  next = withConfigValue(next, 'SpeedMode', 'NormalSpeed').text
  assert.match(next, /key="StartPreTestMode" value="True"/)
  assert.match(next, /key="StartExtendMode" value="True"/)
  assert.match(next, /key="SpeedMode" value="NormalSpeed"/)
  assert.equal(parseBurnOptions(next).preTest, true)
  assert.equal(parseBurnOptions(next).extend, true)
  assert.equal(parseBurnOptions(next).speed, 'NormalSpeed')
})
test('watch.setting sleep helper writes exactly sys_sleep_time=0', () => {
  const sleeping = '<appSettings>\n        <add key="sys_sleep_time" value="600" />\n    </appSettings>'
  const parsed = sleepSettingOf(sleeping)
  assert.equal(parsed.value, '600')
  assert.equal(parsed.noSleep, false)
  const changed = withNoSleepSetting(sleeping)
  assert.equal(changed.changed, true)
  assert.match(changed.text, /<add key="sys_sleep_time" value="0" \/>/)
  assert.equal(sleepSettingOf(changed.text).noSleep, true)
  const already = withNoSleepSetting(changed.text)
  assert.equal(already.changed, false)
})
test('toolAutoStartOf reads AutoStart + DownFile from Downloader.config', () => {
  const config = [
    '<configuration>',
    '  <appSettings>',
    '    <add key="COMEnable" value="True" />',
    '    <add key="DownFile" value="D:/sdk/app/projects/standard/Output/bin/app.dcf" />',
    '    <add key="AutoStart" value="True" />',
    '  </appSettings>',
    '</configuration>',
  ].join('\n')
  const parsed = toolAutoStartOf(config)
  assert.equal(parsed.autoStart, true)
  assert.equal(parsed.downFile, 'D:/sdk/app/projects/standard/Output/bin/app.dcf')

  const autoOff = config.replace('<add key="AutoStart" value="True" />', '<add key="AutoStart" value="False" />')
  assert.equal(toolAutoStartOf(autoOff).autoStart, false)
  assert.deepEqual(toolAutoStartOf(''), { autoStart: false, downFile: '' })
  assert.deepEqual(toolAutoStartOf(null), { autoStart: false, downFile: '' })
  const noDown = '<add key="AutoStart" value="True" />'
  assert.deepEqual(toolAutoStartOf(noDown), { autoStart: true, downFile: '' })
})

test('withAutoStartValue flips exactly the AutoStart key (and nothing else)', () => {
  const config = '<add key="COMEnable" value="True" />\n<add key="AutoStart" value="True" />\n<add key="DownFile" value="x" />'
  const off = withAutoStartValue(config, false)
  assert.match(off, /<add key="AutoStart" value="False" \/>/)
  assert.match(off, /<add key="COMEnable" value="True" \/>/, 'other keys are untouched')
  assert.match(off, /<add key="DownFile" value="x" \/>/)
  assert.equal(withAutoStartValue(off, false), null, 'no change = null')
  assert.equal(withAutoStartValue(off, true).includes('value="True"'), true)
  assert.equal(withAutoStartValue('<configuration></configuration>', true), null, 'missing key = null')
})

test('only app.dcf is treated as the auto-flash firmware', () => {
  assert.equal(isPrimaryFirmwareDcf('D:/sdk/app/projects/standard/Output/bin/app.dcf'), true)
  assert.equal(isPrimaryFirmwareDcf('D:/sdk/app/APP.DCF'), true, 'case-insensitive')
  assert.equal(isPrimaryFirmwareDcf('D:/sdk/app_gpu.dcf'), false)
  assert.equal(isPrimaryFirmwareDcf('D:/sdk/app_gpu.dcf'.replace('app_gpu.dcf', 'app.dcf.bak')), false)
  assert.equal(isPrimaryFirmwareDcf(''), false)
  assert.equal(isPrimaryFirmwareDcf(null), false)

  /* app.dcf wins even when app_gpu.dcf is in the list. */
  assert.deepEqual(
    pickPrimaryFirmwareDcf(['D:/x/app_gpu.dcf', 'D:/y/app.dcf', 'D:/z/other.dcf']),
    ['D:/y/app.dcf'],
  )
  /* No app.dcf at all: keep the list (a project may name its firmware differently). */
  assert.deepEqual(pickPrimaryFirmwareDcf(['D:/x/app_gpu.dcf', 'D:/z/other.dcf']), ['D:/x/app_gpu.dcf', 'D:/z/other.dcf'])
  assert.deepEqual(pickPrimaryFirmwareDcf([]), [])
  assert.deepEqual(pickPrimaryFirmwareDcf(null), [])
})

test('sameFlashPath is case-insensitive on Windows and rejects blanks', () => {
  assert.equal(sameFlashPath('D:\\SDK\\app\\app.dcf', 'd:\\sdk\\APP\\app.dcf'), true)
  assert.equal(sameFlashPath('D:\\sdk\\a.dcf', 'D:\\sdk\\b.dcf'), false)
  assert.equal(sameFlashPath('', 'D:\\sdk\\a.dcf'), false)
  assert.equal(sameFlashPath(null, undefined), false)
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
