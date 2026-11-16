/**
 * Static screenshot harness for the Terminal page (real CSS from src/client.js).
 * Usage: node _design-mockups/terminal-shot.mjs [browser] [out-dir]
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

function cssOf(file, marker) {
  const source = readFileSync(file, 'utf8')
  const from = source.indexOf(marker) + marker.length
  const stop = source.indexOf('\n`', from)
  return source.slice(from, stop)
}

const dockCss = cssOf(path.join(repo, 'packages/dock/src/client.js'), 'const CSS = `')
const termCss = cssOf(path.join(repo, 'packages/terminal/src/client.js'), 'const CSS = `')

const shell = (tier, width, body) => `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#0f1115;font-family:'Segoe UI Variable Text','Segoe UI',system-ui,'Microsoft YaHei',sans-serif;font-size:12px;color:#e6e6e6}
:root{--dsw-alias-bg-base:#14161a;--dsw-alias-bg-layer-1:#1b1e24;--dsw-alias-bg-layer-2:#22262c;--dsw-alias-border-l1:rgba(255,255,255,.08);--dsw-alias-border-l2:rgba(255,255,255,.14);--dsw-alias-label-primary:#e6e6e6;--dsw-alias-label-secondary:#b6bac1;--dsw-alias-label-tertiary:#8a8f98;--dsw-alias-brand-primary:#4d6bfe;--dsw-alias-state-success-primary:#3fb950;--dsw-alias-state-warn-primary:#e2a03f;--dsw-alias-state-error-primary:#ff6b6b}
${dockCss}
${termCss}
.dswt-body{flex:1 1 auto;min-height:0;display:flex;flex-direction:column}
.dswt-term{padding:8px 12px;font-family:ui-monospace,Consolas,monospace;font-size:11.5px;line-height:19px;color:#c6cad1;white-space:pre-wrap;overflow:auto;flex:1 1 auto}
</style>
<div class="wbd-docked" data-w="${tier}" data-layout="${tier === 't1' || tier === 't2' ? 'single' : 'split'}" style="position:relative;width:${width}px;height:100vh;border-left:none;box-shadow:none">
  <div class="wbd-titlebar"><span class="wbd-titleIcon">▤</span><span class="wbd-title">工作台</span><span class="wbd-titleHint">已停靠右侧 · 与会话并排</span>
    <div class="wbd-layoutSwitch"><button class="wbd-lsBtn is-on">自动</button><button class="wbd-lsBtn">单栏</button><button class="wbd-lsBtn">双栏</button><button class="wbd-lsBtn">三栏</button></div>
    <span class="wbd-titleActions"><button class="wbd-titleBtn">✕</button></span></div>
  <div class="wbd-ctx"><span class="wbd-ctxGlyph">▣</span>
    <div class="wbd-ctxMain"><div class="wbd-ctxLine1"><span class="wbd-ctxName">demo_sdk</span></div><div class="wbd-ctxPath">D:\\work\\demo</div></div>
    <div class="wbd-ctxMeta"><span class="wbd-branchPill">main<span class="wbd-sync"><span class="wbd-ahead">↑2</span></span></span><span class="wbd-chip is-warn">变更 5</span></div></div>
  <div class="wbd-tabs"><button class="wbd-tab"><span class="wbd-tabLabel">源码管理</span></button><button class="wbd-tab"><span class="wbd-tabLabel">Downloader</span></button><button class="wbd-tab is-active"><span class="wbd-tabLabel">终端</span></button></div>
  <div class="wbd-main"><nav class="wbd-rail">
    <button class="wbd-railItem"><span class="wbd-railGlyph">▤</span><span class="wbd-railLabel">源码</span></button>
    <button class="wbd-railItem"><span class="wbd-railGlyph">⇩</span><span class="wbd-railLabel">烧录</span></button>
    <button class="wbd-railItem is-active"><span class="wbd-railGlyph">▧</span><span class="wbd-railLabel">终端</span></button></nav>
    <div class="wbd-body"><div class="wbd-stack"><div class="wbd-page is-active">${body}</div></div></div></div>
  <footer class="wbd-status"><span class="wbd-statusItem">终端</span><span class="wbd-statusItem is-dim">· 终端 2 会话 · 运行中</span><span class="wbd-statusTasks"><button class="wbd-task"><span class="wbd-taskDot"></span><span>烧录 · 离线</span></button></span><span class="wbd-statusRight">${tier.toUpperCase()}</span></footer>
</div>`

const tab = (title, phase, active) => `<div class="dswt-tab${active ? ' is-active' : ''}"><span class="dswt-tabDot is-${phase}"></span><span class="dswt-tabLabel">${title}</span><span class="dswt-tabClose">×</span></div>`

const sideRow = (title, phase, active) => `<div class="dswt-sideRow${active ? ' is-active' : ''}"><span class="dswt-sideDot is-${phase}"></span><span class="dswt-sideName">${title}</span><span class="dswt-sideMeta">PTY</span></div>`

const body = (wide) => `
<div class="dswt-root">
  <div class="dswt-tabbar">
    ${tab('bash', 'running', true)}
    ${tab('烧录日志', 'exited', false)}
    ${tab('python', 'error', false)}
    <button class="dswt-newTab">+</button>
  </div>
  <div class="dswt-toolbar">
    <button class="dswt-toolBtn is-primary">新建</button>
    <button class="dswt-toolBtn">清屏</button>
    <button class="dswt-toolBtn">重启</button>
    <button class="dswt-toolBtn">搜索</button>
    <button class="dswt-toolBtn">分屏</button>
    <button class="dswt-toolBtn">关闭</button>
    <span class="dswt-toolSpacer"></span>
    <span class="dswt-modeBadge is-pty">PTY</span>
  </div>
  <div class="dswt-main${wide ? ' is-wide' : ''}">
    <div class="dswt-mainCol">
      <div class="dswt-body">
        <div class="dswt-term">dev@build MINGW64 /d/work/demo
$ make -j8
  CC    app/lvgl_port.c
  CC    app/bt_stack.c
  LD    Output/bin/app.elf
  OBJCOPY Output/bin/app.dcf
编译完成: 1396.0 KB  (00:03.42)
$ ls -lh Output/bin
-rw-r--r-- 1 li 197609 1.4M Nov 10 15:52 app.dcf
$ █</div>
      </div>
    </div>
    ${wide ? `<aside class="dswt-side">
      <div class="dswt-sideHead">会话</div>
      ${sideRow('bash', 'running', true)}
      ${sideRow('烧录日志', 'exited', false)}
      ${sideRow('python', 'error', false)}
      <div class="dswt-sideHead">连接</div>
      <div class="dswt-sideKv"><span>目录</span><b>demo_sdk</b></div>
      <div class="dswt-sideKv"><span>Shell</span><b>bash</b></div>
      <div class="dswt-sideKv"><span>模式</span><b>PTY</b></div>
      <div class="dswt-sideKv"><span>会话 ID</span><b>s-7f3a91c2</b></div>
    </aside>` : ''}
  </div>
  <div class="dswt-statusbar">
    <span class="dswt-statusItem"><span class="dswt-statusKey">Shell</span><span class="dswt-statusValue">bash</span></span>
    <span class="dswt-statusItem is-grow"><span class="dswt-statusKey">目录</span><span class="dswt-statusValue">D:/work/demo</span></span>
    <span class="dswt-statusItem"><span class="dswt-modeBadge is-pty">PTY</span></span>
    <span class="dswt-statusItem"><span class="dswt-statusKey">会话</span><span class="dswt-statusValue">2</span></span>
  </div>
</div>`

const dir = mkdtempSync(path.join(tmpdir(), 'wbterm-'))
mkdirSync(outDir, { recursive: true })
for (const shot of [{ tier: 't1', width: 520 }, { tier: 't2', width: 680 }, { tier: 't3', width: 1000 }, { tier: 't4', width: 1400 }]) {
  const wide = shot.tier === 't3' || shot.tier === 't4'
  const file = path.join(dir, shot.tier + '.html')
  writeFileSync(file, shell(shot.tier, shot.width, body(wide)))
  const png = path.join(dir, shot.tier + '.png')
  await new Promise((resolve) => {
    const child = spawn(browser, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
      '--no-default-browser-check', '--force-device-scale-factor=1', `--window-size=${shot.width},820`,
      '--virtual-time-budget=1200', `--screenshot=${png}`, 'file:///' + file.split(path.sep).join('/'),
    ], { stdio: 'ignore' })
    child.on('close', resolve)
  })
  const out = path.join(outDir, 'term-' + shot.tier + '-' + shot.width + '.png')
  copyFileSync(png, out)
  console.log('wrote ' + out)
}
try { rmSync(dir, { recursive: true, force: true }) } catch { /* temp */ }
