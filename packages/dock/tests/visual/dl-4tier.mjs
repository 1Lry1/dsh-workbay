/**
 * Static screenshot harness for the Downloader page.
 *
 * The Downloader is driven by a host RPC + a real Downloader.exe, so it cannot be
 * mounted in the source-control harness. This renders the page from its REAL
 * stylesheet (extracted from lib/client.js) plus markup that mirrors the real DOM
 * class names, inside the real workbench shell chrome (dock CSS).
 *
 * Usage: node _design-mockups/downloader-shot.mjs [browser] [out-dir]
 */
import { spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..', '..', '..')
const browser = process.argv[2] ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const outDir = path.resolve(process.argv[3] ?? path.join(here, 'out'))

function cssOf(file, marker = 'const CSS = `') {
  const source = readFileSync(file, 'utf8')
  const start = source.indexOf(marker)
  if (start < 0) throw new Error('no CSS in ' + file)
  const from = start + marker.length
  const end = source.indexOf('\n' + '`', source.indexOf('`', from))
  const tail = source.indexOf('\n    `', from)
  const stop = end > 0 ? end : tail
  return source.slice(from, stop)
}

const dockCss = cssOf(path.join(repo, 'packages/dock/src/client.js'))
const dlCss = cssOf(path.join(repo, 'packages/downloader/lib/client.js'))

const shell = (tier, width, body) => `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#0f1115;font-family:'Segoe UI Variable Text','Segoe UI',system-ui,'Microsoft YaHei',sans-serif;font-size:12px;color:#e6e6e6}
:root{--dsw-alias-bg-base:#14161a;--dsw-alias-bg-layer-1:#1b1e24;--dsw-alias-bg-layer-2:#22262c;--dsw-alias-bg-layer-3:rgba(255,255,255,.06);--dsw-alias-border-l1:rgba(255,255,255,.08);--dsw-alias-border-l2:rgba(255,255,255,.14);--dsw-alias-label-primary:#e6e6e6;--dsw-alias-label-secondary:#b6bac1;--dsw-alias-label-tertiary:#8a8f98;--dsw-alias-brand-primary:#4d6bfe;--dsw-alias-state-success-primary:#3fb950;--dsw-alias-state-warn-primary:#e2a03f;--dsw-alias-state-error-primary:#ff6b6b;--dsw-border:#2c2c2f;--dsw-fg:#e6edf3;--dsw-fg-3:#666}
${dockCss}
${dlCss}
</style>
<div class="wbd-docked" data-w="${tier}" data-layout="${tier === 't1' || tier === 't2' ? 'single' : 'split'}" style="position:relative;width:${width}px;height:100vh;border-left:none;box-shadow:none">
  <div class="wbd-titlebar">
    <span class="wbd-titleIcon">▤</span><span class="wbd-title">工作台</span>
    <span class="wbd-titleHint">已停靠右侧 · 与会话并排</span>
    <div class="wbd-layoutSwitch"><button class="wbd-lsBtn is-on">自动</button><button class="wbd-lsBtn">单栏</button><button class="wbd-lsBtn">双栏</button><button class="wbd-lsBtn">三栏</button></div>
    <span class="wbd-titleActions"><button class="wbd-titleBtn">✕</button></span>
  </div>
  <div class="wbd-ctx">
    <span class="wbd-ctxGlyph">▣</span>
    <div class="wbd-ctxMain"><div class="wbd-ctxLine1"><span class="wbd-ctxName">demo_sdk</span></div>
      <div class="wbd-ctxPath">D:\\work\\demo</div></div>
    <div class="wbd-ctxMeta"><span class="wbd-branchPill">main<span class="wbd-sync"><span class="wbd-ahead">↑2</span></span></span><span class="wbd-chip is-warn">变更 5</span></div>
  </div>
  <div class="wbd-tabs"><button class="wbd-tab"><span class="wbd-tabLabel">源码管理</span></button><button class="wbd-tab is-active"><span class="wbd-tabLabel">Downloader</span></button><button class="wbd-tab"><span class="wbd-tabLabel">终端</span></button></div>
  <div class="wbd-main">
    <nav class="wbd-rail">
      <button class="wbd-railItem"><span class="wbd-railGlyph">▤</span><span class="wbd-railLabel">源码</span></button>
      <button class="wbd-railItem is-active"><span class="wbd-railGlyph">⇩</span><span class="wbd-railLabel">烧录</span></button>
      <button class="wbd-railItem"><span class="wbd-railGlyph">▧</span><span class="wbd-railLabel">终端</span></button>
    </nav>
    <div class="wbd-body"><div class="wbd-stack"><div class="wbd-page is-active">${body}</div></div></div>
  </div>
  <footer class="wbd-status"><span class="wbd-statusItem">Downloader</span><span class="wbd-statusItem is-dim">· 烧录 · 就绪</span><span class="wbd-statusTasks"><button class="wbd-task"><span class="wbd-taskDot"></span><span>终端 1 会话 · 运行中</span></button></span><span class="wbd-statusRight">${tier.toUpperCase()} · ${tier === 't1' || tier === 't2' ? '单栏' : '双栏'}</span></footer>
</div>`

const body = (wide) => `
  <div class="abw${wide ? ' is-wide' : ' is-compact'}">
  <div class="abw-main">
    <div class="abw-left">
      <div class="abw-top">
        ${wide ? '<div class="abw-line is-card">' +
          '<span class="abw-dot" data-s="ok"></span>' +
          '<span class="abw-toolName">Downloader.exe</span>' +
          '<span class="abw-pathChip">D:\\Tools\\Downloader\\Downloader.exe</span>' +
          '<button class="abw-btn" data-v="ghost">更换</button>' +
          '<span class="abw-sep"></span>' +
          '<span class="abw-dot" data-s="ok"></span>' +
          '<span>已连接</span>' +
          '<span class="abw-badge abw-mono">COM11</span>' +
          '<select class="abw-sel"><option>COM11</option></select>' +
          '<button class="abw-btn" data-v="ghost">↻</button>' +
          '<select class="abw-sel"><option>921600</option></select>' +
          '</div>' : '<div class="abw-line is-card is-collapsible">' +
          '<span class="abw-dot" data-s="ok"></span>' +
          '<span class="abw-toolName">Downloader.exe</span>' +
          '<span class="abw-cfgSummary"><span class="abw-dot" data-s="ok"></span><span>已连接</span><span class="abw-badge abw-mono">COM11</span><span class="abw-dim abw-mono">921600 baud</span></span>' +
          '<span class="abw-sp"></span>' +
          '<span class="abw-cfgChevron">▾</span>' +
          '</div>'}

        <div class="abw-kv">
          <div>固件文件</div><div class="abw-mono">Output\\bin\\app.dcf</div>
          <div>文件大小</div><div class="abw-mono">1.4 MB</div>
          <div>固件校验</div><div class="abw-mono">00001D7C_0BCF9C38</div>
          <div>设备校验</div><div class="abw-mono">1DA83416</div>
          <div>上次烧录</div><div class="abw-dim">✓ 成功 18:01:12</div>
        </div>

        <div class="abw-progWrap"><div class="abw-progTop"><span class="abw-progLabel">写入数据</span><span class="abw-progNum">62%</span></div><div class="abw-prog"><i style="width:62%"></i></div><div class="abw-progMeta"><span>1989 / 3200 KB</span><span>剩余 00:42</span></div></div>

        <div class="abw-line" style="margin-top:8px">
          <button class="abw-btn" data-v="pri">连接 Downloader</button>
          <button class="abw-btn" data-v="danger">开始烧录</button><button class="abw-btn" data-v="ghost">读信息</button><button class="abw-btn" data-v="danger">擦除</button>
          <button class="abw-btn" data-v="ghost">打开串口</button>
          <button class="abw-btn" data-v="ghost">○ 自动烧录</button>
        </div>
        <div class="abw-dim" style="font-size:11px;padding:0 2px 8px">Downloader 窗口已显示，可直接在其界面里选文件</div>
      </div>
    </div>

    <div class="abw-right">
      <div class="abw-logwrap">
        <div class="abw-lbar">
          <span class="abw-dim" style="font-size:12px">日志 128</span>
          <span class="abw-sp"></span>
          <select class="abw-sel"><option>全部</option></select>
          <label class="abw-dim" style="font-size:12px"><input type="checkbox" checked> 跟随</label>
          <button class="abw-btn" data-v="ghost">清空</button>
        </div>
        <div class="abw-log">
          ${[
            ['10:00:45', 'D', '读DCF描述文件'],
            ['10:00:45', 'D', '蓝牙地址模式: 随机地址'],
            ['10:00:46', 'D', '程序大小: 1396.0 KByte'],
            ['10:00:46', 'D', '校验码: 00001D7C_0BCF9C38'],
            ['10:00:47', 'D', '开始烧录…'],
            ['10:00:47', 'B', '擦除 flash … OK'],
            ['10:00:52', 'D', '写入 512 / 3200 KB'],
            ['10:00:57', 'D', '写入 1024 / 3200 KB'],
            ['10:01:02', 'D', '写入 1536 / 3200 KB'],
            ['10:01:07', 'D', '写入 1989 / 3200 KB'],
            ['10:01:08', 'B', 'printf: bt_pair_retry(3) → retry 1'],
            ['10:01:12', 'S', '烧录完成 100%'],
          ].map(([time, src, text]) => `<div class="abw-ll"><span class="abw-lt-time">${time}</span><span class="abw-ls" data-s="${src}">${src}</span><span class="abw-lt">${text}</span></div>`).join('')}
        </div>
        <div class="abw-line" style="margin-top:6px">
          <input class="abw-sel" style="flex:1 1 auto;min-width:0" placeholder="串口输入，回车发送">
          <button class="abw-btn" data-v="ghost">发送</button>
        </div>
      </div>
    </div>
  </div>
</div>`

const dir = mkdtempSync(path.join(tmpdir(), 'wbdl-'))
mkdirSync(outDir, { recursive: true })
const shots = [
  { tier: 't1', width: 520, file: 'dl-t1-520.png' },
  { tier: 't2', width: 680, file: 'dl-t2-680.png' },
  { tier: 't3', width: 1000, file: 'dl-t3-1000.png' },
  { tier: 't4', width: 1400, file: 'dl-t4-1400.png' },
]
for (const shot of shots) {
  const wide = shot.tier === 't3' || shot.tier === 't4'
  const page = shell(shot.tier, shot.width, body(wide))
  const file = path.join(dir, shot.tier + '.html')
  writeFileSync(file, page)
  const png = path.join(dir, shot.tier + '.png')
  await new Promise((resolve) => {
    const child = spawn(browser, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
      '--no-default-browser-check', '--force-device-scale-factor=1', `--window-size=${shot.width},820`,
      '--virtual-time-budget=1200', `--screenshot=${png}`, 'file:///' + file.split(path.sep).join('/'),
    ], { stdio: 'ignore' })
    child.on('close', resolve)
  })
  copyFileSync(png, path.join(outDir, shot.file))
  console.log('wrote ' + path.join(outDir, shot.file))
}
try { rmSync(dir, { recursive: true, force: true }) } catch { /* temp */ }
