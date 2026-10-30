// dsh-downloader —— client 半侧（浏览器）
//
// v2 形态（按用户反馈调整）：
//   - 一个 better-sidebar tab：Downloader（烧录 + 串口日志）
//     （挂在 better-sidebar 的 tab 工具条 rightActions 上，并注册一个独立 tab 当兜底）
//   - 烧录页【合并日志】：上方烧录状态，下方日志，方便「烧 → 看 → 再烧」
//   - 连接 Downloader 时窗口【可见】（BackShowMode），能直接看到原界面
//
// 这是预构建产物：DSH 的 client 模块系统要求 window.__ModuleLoader__.load 的 CJS 闭包，
// 不能直接加载 ESM/JSX 源码。用 React.createElement 手写，零依赖、单文件。

window.__ModuleLoader__.load({
  id: 'dsh-downloader',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const API = '/downloader'

    const api = {
      get: async (p) => {
        try {
          const r = await fetch(API + p, { headers: { accept: 'application/json' } })
          return await r.json()
        } catch (e) { return { error: String(e) } }
      },
      post: async (p, body) => {
        try {
          const r = await fetch(API + p, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body || {}),
          })
          return await r.json()
        } catch (e) { return { error: String(e) } }
      },
    }

    // ---------------------------------------------------------------- 样式
    // 全部走 DSH 主题变量（--dsw-*），换肤自动跟随。
    const CSS = `
      .abw{display:flex;flex-direction:column;height:100%;min-height:0;
        color:var(--dsw-fg-1,#e6e6e6);font-size:13px;background:var(--dsw-bg-1,#1a1a1c)}

      .abw-top{flex:0 0 auto;padding:10px 12px 0;border-bottom:1px solid var(--dsw-border,#2c2c2f)}
      .abw-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px}
      .abw-sp{flex:1 1 auto}
      .abw-dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto;background:var(--dsw-fg-3,#666)}
      .abw-dot[data-s="ok"]{background:#3fb950}
      .abw-dot[data-s="warn"]{background:#d29922}
      .abw-dot[data-s="err"]{background:#f85149}
      .abw-dot[data-s="busy"]{background:#4c9aff;animation:abwp 1s infinite}
      @keyframes abwp{50%{opacity:.3}}

      .abw-btn{display:inline-flex;align-items:center;gap:5px;padding:5px 10px;border-radius:6px;
        border:1px solid var(--dsw-border,#3a3a3d);background:var(--dsw-bg-2,#252528);
        color:var(--dsw-fg-1,#e6e6e6);cursor:pointer;font-size:12px;white-space:nowrap}
      .abw-btn:hover:not(:disabled){background:var(--dsw-bg-3,#2f2f33);border-color:var(--dsw-fg-3,#666)}
      .abw-btn:disabled{opacity:.42;cursor:not-allowed}
      .abw-btn[data-v="pri"]{background:#2b6cd4;border-color:#2b6cd4;color:#fff}
      .abw-btn[data-v="pri"]:hover:not(:disabled){background:#3a7df0}
      .abw-btn[data-v="danger"]{color:#f85149;border-color:#5a2a2a}
      .abw-btn[data-v="ghost"]{background:transparent;border-color:transparent;padding:3px 7px}

      .abw-sel,.abw-inp{padding:4px 8px;border-radius:5px;font-size:12px;
        border:1px solid var(--dsw-border,#3a3a3d);background:var(--dsw-bg-2,#252528);
        color:var(--dsw-fg-1,#e6e6e6);outline:none;min-width:0}
      .abw-sel:focus,.abw-inp:focus{border-color:var(--dsw-accent,#4c9aff)}
      .abw-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
      .abw-dim{color:var(--dsw-fg-3,#888)}
      .abw-badge{font-size:11px;padding:1px 6px;border-radius:9px;background:var(--dsw-bg-3,#2f2f33);
        color:var(--dsw-fg-2,#aaa);flex:0 0 auto}

      .abw-kv{display:grid;grid-template-columns:76px 1fr 76px 1fr;gap:4px 10px;font-size:12px;margin-bottom:8px}
      .abw-kv>div:nth-child(odd){color:var(--dsw-fg-3,#888)}
      .abw-kv>div:nth-child(even){overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

      .abw-prog{height:5px;border-radius:3px;background:var(--dsw-bg-3,#2f2f33);overflow:hidden;margin:2px 0 8px}
      .abw-prog>i{display:block;height:100%;background:var(--dsw-accent,#4c9aff);transition:width .18s ease}

      .abw-logwrap{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;padding:8px 12px 10px}
      .abw-lbar{flex:0 0 auto;display:flex;align-items:center;gap:8px;margin-bottom:6px}
      .abw-log{flex:1 1 auto;min-height:0;overflow:auto;
        font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;line-height:1.5;
        white-space:pre;word-break:normal;border:1px solid var(--dsw-border,#2c2c2f);
        border-radius:8px;padding:8px 10px;background:var(--dsw-bg-2,#18181a)}
      .abw-ll{display:flex;gap:6px}
      .abw-lt-time{flex:0 0 auto;color:var(--dsw-fg-3,#666);font-variant-numeric:tabular-nums;user-select:none}
      .abw-ls{flex:0 0 auto;width:12px;text-align:center;color:var(--dsw-fg-3,#666);user-select:none}
      .abw-ls[data-s="B"]{color:#3fb950}
      .abw-ls[data-s="D"]{color:#4c9aff}
      .abw-ls[data-s="U"]{color:#d29922}
      .abw-ls[data-s="M"]{color:#c792ea}
      .abw-lt{flex:1 1 auto;min-width:0}
      .abw-empty{padding:24px 10px;text-align:center;color:var(--dsw-fg-3,#777);font-size:12px;line-height:1.9}
      .abw-send{flex:0 0 auto;display:flex;gap:8px;margin-top:8px}
    `

    let injected = false
    function injectCss() {
      if (injected || typeof document === 'undefined') return
      injected = true
      const s = document.createElement('style')
      s.setAttribute('data-dsh-downloader', '1')
      s.textContent = CSS
      document.head.appendChild(s)
    }

    // ---------------------------------------------------------------- 状态

    function useAbw() {
      const [st, setSt] = React.useState({
        serial: { open: false, port: null, baud: 1500000 },
        flash: { status: '离线', progress: 0, online: false, busy: false },
        logs: [],
        watch: { on: false, path: null },
      })

      React.useEffect(() => {
        let alive = true
        api.get('/state').then(s => {
          if (alive && s && !s.error) setSt(x => ({ ...x, ...s }))
        })
        const es = new EventSource(API + '/events')
        es.onmessage = (m) => {
          let e
          try { e = JSON.parse(m.data) } catch { return }
          setSt(x => {
            if (e.ev === 'hello') return { ...x, ...e.state }
            if (e.ev === 'log') return { ...x, logs: [...x.logs.slice(-20000), e.item] }
            if (e.ev === 'flash') return { ...x, flash: { ...x.flash, ...e.state } }
            if (e.ev === 'serial-state') return { ...x, serial: e.serial }
            // ★ 清空时后端会广播 log-clear，前端必须一起清，
            //   否则只清了底层、界面上旧日志还在。
            if (e.ev === 'log-clear') return { ...x, logs: [] }
            if (e.ev === 'watch') return { ...x, watch: e.watch }
            return x
          })
        }
        return () => { alive = false; es.close() }
      }, [])

      return [st, setSt]
    }

    // ---------------------------------------------------------------- 烧录 + 日志（合并页）

    const SRC = { B: 'B', D: 'D', U: 'U', M: 'M', S: 'S' }

    function FlashPanel() {
      injectCss()
      const [st] = useAbw()
      const [ports, setPorts] = React.useState([])
      const [selPort, setSelPort] = React.useState('')
      const [baud, setBaud] = React.useState(1500000)
      const [filter, setFilter] = React.useState('all')
      const [follow, setFollow] = React.useState(true)
      const [input, setInput] = React.useState('')
      const logRef = React.useRef(null)
      // 内联提示（替代 alert）：不弹窗，在界面上就地显示几秒
      const [notice, setNotice] = React.useState('')
      // 提示自动消失（3 秒），不留残在界面上
      React.useEffect(() => {
        if (!notice) return
        const t = setTimeout(() => setNotice(''), 3000)
        return () => clearTimeout(t)
      }, [notice])

      const f = st.flash || {}
      const s = st.serial || {}
      const pct = Math.min(100, Math.round((f.progress || 0) / 100))
      const busy = !!f.busy

      const loadPorts = async () => {
        const r = await api.get('/serial/list')
        const ps = (r && r.ports) || []
        setPorts(ps)
        if (!selPort && ps.length) {
          const pref = ps.find(p => /CP210|Silicon|CH34|FTDI|USB/i.test(p.desc || ''))
          setSelPort((pref || ps[0]).name)
        }
      }
      React.useEffect(() => { loadPorts() }, [])

      const shown = filter === 'all' ? st.logs : st.logs.filter(l => l.src === filter)
      React.useEffect(() => {
        if (follow && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
      }, [shown.length, follow])

      // 三个状态要分清：
      //   busy    = 正在连接（启动 Downloader / 等握手）
      //   burning = 正在烧录
      //   connected = 已连上，可以发命令
      const burning = !!f.burning
      const canCmd = !!f.connected && !burning

      const dot = /完成/.test(f.status) ? 'ok'
        : /错误|失败|超时/.test(f.status) ? 'err'
          : (busy || burning) ? 'busy' : f.online ? 'ok' : ''

      // 状态文案：连接过程中显示当前阶段（启动 Downloader… / 等待握手…），
      // 烧录时显示进度状态，连上后显示真实状态。
      const statusText = busy
        ? (f.stage || '连接中…')
        : burning && pct > 0 ? `${f.status || '烧录中'} ${pct}%`
          : (f.status || '离线')

      // 上次烧录结果（关闭面板后仍能从 /flash/status 读到）
      const lb = f.lastBurn
      const lastBurnText = lb
        ? (lb.ok
          ? `上次烧录：✓ 成功 ${new Date(lb.at).toLocaleTimeString('zh-CN', { hour12: false })}` + (lb.mac ? `（${lb.mac}）` : '')
          : `上次烧录：✗ 失败 ${new Date(lb.at).toLocaleTimeString('zh-CN', { hour12: false })}（${lb.reason || '未知'}）`)
        : ''

      const send = async () => {
        if (!input.trim()) return
        await api.post('/serial/write', { text: input + '\r\n' })
        setInput('')
      }

      // ---- 上半：设备状态 + 串口选择 ----
      const rowStatus = h('div', { className: 'abw-line', key: 'status' },
        h('span', { className: 'abw-dot', 'data-s': dot }),
        h('span', null, statusText),
        f.com ? h('span', { className: 'abw-badge abw-mono' }, f.com) : null,
        f.mac ? h('span', { className: 'abw-badge abw-mono' }, f.mac) : null,
        h('span', { className: 'abw-sp' }),
        h('span', { className: 'abw-dim' }, '串口'),
        h('select', {
          className: 'abw-sel', value: selPort, disabled: busy,
          onChange: e => setSelPort(e.target.value),
        },
          ports.length === 0 ? h('option', { value: '' }, '（无可用串口）') : null,
          ports.map(p => h('option', { key: p.name, value: p.name },
            p.name + (p.desc ? ' — ' + p.desc : '')))
        ),
        h('button', { className: 'abw-btn', 'data-v': 'ghost', onClick: loadPorts, disabled: busy }, '↻'),
        h('select', {
          className: 'abw-sel', value: baud, disabled: busy,
          onChange: e => setBaud(Number(e.target.value)),
        },
          [9600, 115200, 460800, 921600, 1500000, 2000000, 3000000].map(b =>
            h('option', { key: b, value: b }, b))
        )
      )

      // ---- 第二行：固件信息 ----
      const rowInfo = h('div', { className: 'abw-kv', key: 'info' },
        h('div', null, '固件文件'),
        h('div', { className: 'abw-mono', title: f.dcfPath || '' }, f.dcfPath || '—'),
        h('div', null, '固件校验'),
        h('div', { className: 'abw-mono' }, f.fwChecksum || '—'),
        h('div', null, '设备校验'),
        h('div', { className: 'abw-mono' }, f.devChecksum || '—'),
        h('div', null, '串口状态'),
        h('div', null, s.open
          ? h('span', null, h('span', { className: 'abw-dot', 'data-s': 'ok' }), ' ' + s.port + ' @' + s.baud)
          : h('span', { className: 'abw-dim' }, '未打开'))
      )

      const rowProg = h('div', { className: 'abw-prog', key: 'prog' },
        h('i', { style: { width: pct + '%' } })
      )

      // ---- 第三行：动作 ----
      // 按钮文案直接反映阶段：busy 时显示「启动 Downloader…」「等待握手…」
      const btnConnect = h('button', {
        key: 'connect', className: 'abw-btn', 'data-v': 'pri', disabled: busy,
        onClick: async () => {
          // 无弹窗：发现旧实例就自动清掉再连，过程写日志
          let r = await api.post('/flash/start', {})
          if (r.ok) return
          if (r.error === 'already-running') {
            const k = await api.post('/flash/kill-foreign', {})
            if (k.ok) {
              r = await api.post('/flash/start', { force: true })
              if (r.ok) return
            }
          }
        },
      }, busy
        ? (f.stage || '连接中…')
        : (f.connected ? '重新连接' : '连接 Downloader'))

      // ⚠️ 这里曾经写成 disabled: !busy，结果握手成功后 busy 复位成 false，
      //    按钮反而被禁用（用户看到"开始烧录"是灰的）。
      //    正确的判断是 connected（能发命令），烧录中再禁用一次。
      const btnBurn = h('button', {
        key: 'burn', className: 'abw-btn', 'data-v': 'danger', disabled: !canCmd,
        title: canCmd ? '把当前 dcf 写入芯片' : (burning ? '烧录中…' : '请先连接 Downloader'),
        onClick: async () => {
          // 无弹窗直接烧（危险动作靠“两步”防误触：
          // 需要先拿到 connected 才能点，而连接本身需要主动点）
          const r = await api.post('/flash/download', { confirm: true })
          if (!r.ok && r.error !== 'not-ready' && r.error !== 'no-device') {
            setNotice('烧录请求失败：' + (r.message || r.error || ''))
          }
        },
      }, burning ? '烧录中…' : '开始烧录')

      const btnSerial = s.open
        ? h('button', {
          key: 'ser', className: 'abw-btn',
          onClick: () => api.post('/serial/close', {}),
        }, '关闭串口')
        : h('button', {
          key: 'ser', className: 'abw-btn',
          onClick: async () => {
            const r = await api.post('/serial/open', { port: selPort, baud })
            if (!r.ok) setNotice('打开 ' + selPort + ' 失败：' + (r.msg || r.error || '可能被占用'))
          },
        }, '打开串口')

      const btnStop = (canCmd || burning)
        ? h('button', {
          key: 'stop', className: 'abw-btn', 'data-v': 'ghost',
          onClick: () => api.post('/flash/stop', {}),
        }, '断开')
        : null

      // 自动烧录开关：监听编译产物 dcf，变化就自动烧。
      // 你在 Downloader 界面里切换 dcf 时，插件会自动跟随（读它的下拉框）。
      const w = st.watch || {}

      const btnWatch = h('button', {
        key: 'watch', className: 'abw-btn',
        'data-v': w.on ? 'pri' : 'ghost',
        title: w.on
          ? '正在监听：' + (w.path || '') + '\n点一下停止'
          : '开启后，每次编译完自动烧录',
        onClick: async () => {
          const r = await api.post('/watch', { on: !w.on })
          if (!r.ok) setNotice('自动烧录：' + (r.error || '开启失败'))
        },
      }, w.on ? '◉ 自动烧录' : '○ 自动烧录')

      const rowActions = h('div', { className: 'abw-line', key: 'actions', style: { marginBottom: 10 } },
        btnConnect, btnBurn, btnSerial, btnStop, btnWatch,
        h('span', { className: 'abw-sp' }),
        lastBurnText
          ? h('span', { className: 'abw-dim',
              style: { fontSize: 11, color: lb && lb.ok ? '#3fb950' : '#f85149' },
            }, lastBurnText)
          : h('span', { className: 'abw-dim', style: { fontSize: 11 } },
              'Downloader 窗口已显示，可直接在其界面里选文件')
      )

      // 内联提示条（替代弹窗）：有事就在下面这行显示，3 秒后自动消失
      const noticeBar = notice
        ? h('div', {
          className: 'abw-line',
          style: { padding: '4px 8px', marginBottom: 6, borderRadius: 5,
            background: 'rgba(248,81,73,.12)', color: '#f85149', fontSize: 12 },
        }, notice)
        : null

      const top = h('div', { className: 'abw-top' },
        noticeBar, rowStatus, rowInfo, rowProg, rowActions)

      // ---- 下半：日志 ----
      const logBar = h('div', { className: 'abw-lbar' },
        h('span', { className: 'abw-dim', style: { fontSize: 12 } }, '日志 ' + shown.length),
        h('span', { className: 'abw-sp' }),
        h('select', {
          className: 'abw-sel', value: filter, onChange: e => setFilter(e.target.value),
        },
          h('option', { value: 'all' }, '全部'),
          h('option', { value: 'B' }, '板卡'),
          h('option', { value: 'D' }, '烧录'),
          h('option', { value: 'S' }, '系统')
        ),
        h('label', {
          className: 'abw-dim',
          style: { fontSize: 12, cursor: 'pointer', display: 'flex', gap: 4, alignItems: 'center' },
        },
          h('input', { type: 'checkbox', checked: follow, onChange: e => setFollow(e.target.checked) }),
          '跟随'
        ),
        h('button', {
          className: 'abw-btn', 'data-v': 'ghost',
          onClick: () => api.post('/log/clear', {}),
        }, '清空')
      )

      // ★ 时间戳：之前只渲染了 [src] text，没有时间，所以看不到。
      const fmtT = (ms) => {
        const d = new Date(ms || Date.now())
        const p2 = (n) => String(n).padStart(2, '0')
        return p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds())
      }
      const logBody = shown.length === 0
        ? h('div', { className: 'abw-empty' },
          s.open ? '等待板卡输出…' : '打开串口或连接 Downloader 后，日志会显示在这里')
        : shown.map((l, i) => h('div', { className: 'abw-ll', key: (l.t || 0) + '-' + i },
          h('span', { className: 'abw-lt-time' }, fmtT(l.t)),
          h('span', { className: 'abw-ls', 'data-s': l.src || 'S' }, SRC[l.src] || '·'),
          h('span', { className: 'abw-lt' }, l.text)
        ))

      const logBox = h('div', {
        className: 'abw-log', ref: logRef,
        onScroll: (e) => {
          const el = e.currentTarget
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
          if (atBottom !== follow) setFollow(atBottom)
        },
      }, logBody)

      const sendBar = h('div', { className: 'abw-send' },
        h('input', {
          className: 'abw-inp abw-mono', style: { flex: '1 1 auto' },
          placeholder: s.open ? '发送文本（回车发送，自动加 CRLF）' : '串口未打开',
          value: input, disabled: !s.open,
          onChange: e => setInput(e.target.value),
          onKeyDown: e => { if (e.key === 'Enter') send() },
        }),
        h('button', { className: 'abw-btn', disabled: !s.open, onClick: send }, '发送')
      )

      const bottom = h('div', { className: 'abw-logwrap' }, logBar, logBox, sendBar)

      return h('div', { className: 'abw' }, top, bottom)
    }

    function VsIcon({ size = 14 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.4, strokeLinejoin: 'round', strokeLinecap: 'round',
      },
        h('path', { d: 'M11.5 1.8 6.2 6.6 3.4 4.4 1.8 5.2v5.6l1.6.8 2.8-2.2 5.3 4.8 2.7-1.2V3z' }),
        h('path', { d: 'M11.5 4.6v6.8L7.6 8z', strokeWidth: 0 }),
      )
    }

    // ---------------------------------------------------------------- 注册
    //
    // 只向「工作台」插件（dsh-workbay-dock）注册一个页面，不再占用
    // dsh-better-sidebar 的 Tab 栏：按钮和独立右侧栏都由 dock 提供，
    // 这里只负责面板组件本身。
    //
    // dock 与本体是两个独立 bundle，加载顺序无保证，所以注册表放在一个
    // 浏览器全局上；谁先到谁创建，另一个复用同一个对象。

    function registerWithDock(ctx) {
      var dock = typeof window === 'object' && window !== null ? window.__DSH_WORKBAY__ : undefined
      if (dock === undefined || dock === null || typeof dock.registerPage !== 'function') return false
      try {
        var off = dock.registerPage({
          id: 'downloader',
          title: 'Downloader',
          order: 30,
          icon: function (size) { return h(VsIcon, { size: size === undefined ? 16 : size }) },
          component: function () { return h(FlashPanel, null) },
        })
        ctx.effect(function () { return off }, 'downloader: workbench page')
        return true
      } catch (e) {
        try { console.error('[downloader] 注册工作台页面失败:', e) } catch { }
        return false
      }
    }

    return {
      // 不 inject betterSidebar：本插件与它无关
      inject: [],
      apply(ctx) {
        if (registerWithDock(ctx)) return
        // dock 可能还没加载：短轮询等待，超时后安静放弃（没有 dock 就没有可渲染的位置）
        var attempts = 0
        var timer = setInterval(function () {
          attempts += 1
          if (registerWithDock(ctx) || attempts >= 40) clearInterval(timer)
        }, 250)
        ctx.effect(function () { return function () { clearInterval(timer) } }, 'downloader: dock discovery')
      },
    }
  },
})
