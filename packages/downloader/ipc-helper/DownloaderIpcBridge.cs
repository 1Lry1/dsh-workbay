// DownloaderIpcBridge.cs -- WM_COPYDATA IPC helper for BlueTrum Downloader.exe
//
// 角色：给上层（DSH 插件 host / 任意进程）提供一个 stdio JSON 行协议的中间人。
//   - 创建一个隐藏的消息窗口（WM_COPYDATA 接收端）
//   - 拉起 Downloader.exe（可选隐藏 / 嵌入指定父窗口）
//   - 向 Downloader 发送 StartDownload / StartErase / StartReadCodeInfo
//   - 把 Downloader 主动推来的 msg 转成 JSON 行打到 stdout
//
// 编译（.NET Framework 4.0 自带的 csc）：
//   C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe /nologo /target:exe ^
//     /r:System.Windows.Forms.dll /r:System.Drawing.dll ^
//     /out:DownloaderIpcBridge.exe DownloaderIpcBridge.cs
//
// 用法：
//   DownloaderIpcBridge.exe --exe <Downloader.exe 路径> [--args "<参数模板, {hwnd} 会被替换>"]
//                           [--no-launch] [--encoding gbk|utf-8] [--timeout 8000]
//
// 协议参考：中科蓝讯 DownloaderUI 升级软件接口说明 v1.0.0 + FormDownloaderUI.cs

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace DshDlBridge
{
    internal static class Native
    {
        public const int WM_COPYDATA = 0x004A;
        public const int WM_CLOSE = 0x0010;
        public const int GWL_STYLE = -16;

        public const long WS_VISIBLE = 0x10000000L;
        public const long WS_CHILD = 0x40000000L;

        public const int SMTO_BLOCK = 0x0001;
        public const int SMTO_ABORTIFHUNG = 0x0002;
        public const int SMTO_ERRORONEXIT = 0x0020;

        public const int SW_HIDE = 0;
        public const int SW_SHOW = 5;
        public const int SW_SHOWNOACTIVATE = 4;

        [StructLayout(LayoutKind.Sequential)]
        public struct COPYDATASTRUCT
        {
            public IntPtr dwData;
            public int cbData;
            public IntPtr lpData;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT { public int Left, Top, Right, Bottom; }

        public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern IntPtr SendMessageTimeout(
            IntPtr hWnd, int Msg, IntPtr wParam, ref COPYDATASTRUCT lParam,
            int fuFlags, uint uTimeout, out IntPtr lpdwResult);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool IsWindow(IntPtr hWnd);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr SetParent(IntPtr hWndChild, IntPtr hWndNewParent);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr GetParent(IntPtr hWnd);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern int GetClassNameW(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern IntPtr SendMessage(IntPtr hWnd, int Msg, IntPtr wParam, IntPtr lParam);

        // CB_GETLBTEXT 写回缓冲区用：用 IntPtr 版本 + 手动传指针
        [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "SendMessageW")]
        public static extern IntPtr SendMessageStr(IntPtr hWnd, int Msg, IntPtr wParam, StringBuilder lParam);

        [DllImport("user32.dll")]
        public static extern bool EnumChildWindows(IntPtr hWndParent, EnumWindowsProc lpEnumFunc, IntPtr lParam);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

        internal const int CB_GETCURSEL = 0x0147;
        internal const int CB_GETLBTEXTLEN = 0x0149;
        internal const int CB_GETLBTEXT = 0x0148;

        // ⚠️ 32 位 user32.dll 里没有 GetWindowLongPtrW 这个导出（头文件里它是宏，
        //    在 x86 上映射到 GetWindowLongW）。helper 用 /platform:x86 编译，
        //    所以这里必须写 GetWindowLongW，否则会抛 EntryPointNotFoundException。
        [DllImport("user32.dll", EntryPoint = "GetWindowLongW", SetLastError = true)]
        public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter,
            int X, int Y, int cx, int cy, uint uFlags);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool PostMessage(IntPtr hWnd, int Msg, IntPtr wParam, IntPtr lParam);

        public static readonly IntPtr HWND_TOP = IntPtr.Zero;
        public const uint SWP_NOSIZE = 0x0001;
        public const uint SWP_NOMOVE = 0x0002;
        public const uint SWP_NOZORDER = 0x0004;
        public const uint SWP_NOACTIVATE = 0x0010;
        public const uint SWP_SHOWWINDOW = 0x0040;

        // ---- Job Object：helper 一死，自己拉起的 Downloader 跟着死，避免留孤儿 ----
        public const int JobObjectExtendedLimitInformation = 9;
        public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

        [StructLayout(LayoutKind.Sequential)]
        public struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct IO_COUNTERS
        {
            public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
            public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool SetInformationJobObject(IntPtr hJob, int JobObjectInformationClass,
            IntPtr lpJobObjectInformation, uint cbJobObjectInformationLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);
    }

    /// <summary>只有消息泵、没有可见界面的接收窗口。</summary>
    internal sealed class HiddenReceiver : NativeWindow
    {
        private readonly Bridge _owner;

        public HiddenReceiver(Bridge owner)
        {
            _owner = owner;
            CreateParams cp = new CreateParams();
            cp.Caption = "DshDlBridgeReceiver_" + Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture);
            cp.X = 0; cp.Y = 0;
            cp.Width = 0; cp.Height = 0;
            cp.Style = 0;              // 关键：不给 WS_VISIBLE
            cp.ExStyle = 0;
            cp.Parent = IntPtr.Zero;
            this.CreateHandle(cp);
        }

        public int Handle32 { get { return this.Handle.ToInt32(); } }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == Native.WM_COPYDATA)
            {
                string payload = null;
                try
                {
                    Native.COPYDATASTRUCT cds =
                        (Native.COPYDATASTRUCT)Marshal.PtrToStructure(m.LParam, typeof(Native.COPYDATASTRUCT));
                    if (cds.cbData > 0 && cds.lpData != IntPtr.Zero)
                    {
                        byte[] buf = new byte[cds.cbData];
                        Marshal.Copy(cds.lpData, buf, 0, cds.cbData);
                        payload = _owner.DecodeIncoming(buf);
                    }
                    else
                    {
                        payload = "";
                    }
                }
                catch (Exception ex)
                {
                    _owner.EmitError("decode", ex.Message);
                }
                if (payload != null)
                    _owner.OnDownloaderMessage(payload, m.WParam.ToInt64());
                m.Result = (IntPtr)1;   // TRUE，表示已处理
                return;
            }
            base.WndProc(ref m);
        }

        public void DestroyHandlePublic()
        {
            if (this.Handle != IntPtr.Zero) this.DestroyHandle();
        }
    }

    internal sealed class BridgeOptions
    {
        public string ExePath;
        public string ArgsTemplate = "BackShowMode {hwnd} -b";
        public bool ArgsExplicit;     // --args 显式给过（哪怕是空串），就用给的值
        public bool NoLaunch;
        public Encoding Wire = Encoding.GetEncoding(936);   // GBK，官方参考实现用 Encoding.Default
        public int TimeoutMs = 8000;
        public bool HideAfterLaunch = true;
        public string EmbedInto = null;      // 父窗口 hwnd 十进制或 0x 十六进制
        public bool Verbose;
        public int LaunchWaitMs = 6000;
        public int SendWaitMs = 30000;   // 发命令前最多等 StartOK 多久
    }

    internal sealed class Bridge
    {
        private readonly BridgeOptions _opt;
        private readonly ConcurrentQueue<string> _cmds = new ConcurrentQueue<string>();
        private readonly ManualResetEventSlim _wake = new ManualResetEventSlim(false);
        private readonly ManualResetEventSlim _startOk = new ManualResetEventSlim(false);
        private HiddenReceiver _wnd;
        private Process _proc;
        private IntPtr _job = IntPtr.Zero;
        private volatile bool _running = true;
        private long _dlHwndFromStartOk;
        private long _dlHwndByPid;
        // ⚠️ 必须持有 EnumWindows 回调委托的强引用，否则 GC 会在 EnumWindows 执行期间回收它，
        // 表现是 "由于 Exception.ToString() 失败，因此无法打印异常字符串" 然后进程直接死掉。
        private readonly List<Native.EnumWindowsProc> _enumKeepAlive = new List<Native.EnumWindowsProc>();
        private int _rxCount;
        private readonly object _outLock = new object();
        private readonly DateTime _t0 = DateTime.Now;

        public Bridge(BridgeOptions opt) { _opt = opt; }

        // ---------------- 输出 ----------------

        private static string J(string s)
        {
            if (s == null) return "null";
            StringBuilder sb = new StringBuilder(s.Length + 8);
            sb.Append('"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20 || c > 0x7E) sb.AppendFormat("\\u{0:x4}", (int)c);
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
            return sb.ToString();
        }

        private void WriteJson(string json)
        {
            lock (_outLock)
            {
                Console.Out.WriteLine(json);
                Console.Out.Flush();
            }
        }

        public void EmitError(string where, string msg)
        {
            WriteJson("{\"ts\":" + Ms() + ",\"ev\":\"error\",\"where\":" + J(where) + ",\"msg\":" + J(msg) + "}");
        }

        private double Ms()
        {
            return Math.Round((DateTime.Now - _t0).TotalMilliseconds, 1);
        }

        private void Ev(string ev, string jsonExtra)
        {
            WriteJson("{\"ts\":" + Ms() + ",\"ev\":" + J(ev) + (jsonExtra == null ? "" : "," + jsonExtra) + "}");
        }

        // ---------------- 编解码 ----------------

        public string DecodeIncoming(byte[] buf)
        {
            int n = buf.Length;
            while (n > 0 && buf[n - 1] == 0) n--;       // 去掉 NUL 结尾
            if (n == 0) return "";
            // 先试严格 UTF-8；不合法就按 GBK（936）解
            try
            {
                UTF8Encoding strict = new UTF8Encoding(false, true);
                return strict.GetString(buf, 0, n);
            }
            catch (Exception)
            {
                return Encoding.GetEncoding(936).GetString(buf, 0, n);
            }
        }

        public static string NonNull(string s) { return s == null ? "" : s; }

        // ---------------- 收消息 ----------------

        public void OnDownloaderMessage(string raw, long wParam)
        {
            _rxCount++;
            string[] a = raw.Split('|');
            string head = a.Length > 0 ? a[0] : "";

            // ⚠️ 实测：设备在线后，Downloader 会给消息头加一个 COM 前缀，
            //    例如 '[COM11]DevInfo|False|1429504|0BCF9C38|...'，而 PDF 只写了 'DevInfo'。
            //    不剥掉这个前缀，DevInfo 分支永远不会命中（这个坑真踩过）。
            string comPrefix = null;
            string headNorm = head;
            if (head.StartsWith("[", StringComparison.Ordinal))
            {
                int close = head.IndexOf(']');
                if (close > 0)
                {
                    comPrefix = head.Substring(1, close - 1);
                    headNorm = head.Substring(close + 1);
                }
            }
            // 归一化后把首段也替换掉，方便按 PDF 的列号取值
            if (headNorm != head) a[0] = headNorm;
            head = headNorm;

            StringBuilder arr = new StringBuilder("[");
            for (int i = 0; i < a.Length; i++)
            {
                if (i > 0) arr.Append(',');
                arr.Append(J(a[i]));
            }
            arr.Append(']');

            StringBuilder extra = new StringBuilder();
            extra.Append("\"raw\":").Append(J(raw));
            extra.Append(",\"wParam\":").Append(wParam);
            extra.Append(",\"fields\":").Append(arr.ToString());
            extra.Append(",\"rxCount\":").Append(_rxCount);
            if (comPrefix != null) extra.Append(",\"comPrefix\":").Append(J(comPrefix));

            // 解析已知消息体（字段含义严格照官方 PDF）
            try
            {
                if (head == "StartOK")
                {
                    if (a.Length >= 2)
                    {
                        long h;
                        if (long.TryParse(a[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out h))
                        {
                            _dlHwndFromStartOk = h;
                            extra.Append(",\"downloaderHwnd\":").Append(h);
                            _startOk.Set();
                        }
                    }
                }
                else if (head == "DownSta")
                {
                    // 官方 PDF: DownSta | COM号 | 进度(0..10000) | 状态 | MAC地址
                    // 实测补充：第 4 段在"错误"状态下承载错误描述（如"串口通信异常"），
                    //           正常情况下为空串，PDF 把这一段标成 "MAC 地址" 并不总是成立。
                    if (a.Length >= 3) extra.Append(",\"com\":").Append(J(a[1]))
                                          .Append(",\"progress\":").Append(IntOf(a[2]))
                                          .Append(",\"progressPct\":").Append(Math.Round(IntOf(a[2]) / 100.0, 1))
                                          .Append(",\"status\":").Append(J(a.Length > 3 ? a[3] : ""))
                                          .Append(",\"field4\":").Append(J(a.Length > 4 ? a[4] : ""));
                    bool isErr = (a.Length > 3) && a[3].IndexOf("错误", StringComparison.Ordinal) >= 0;
                    if (isErr)
                        extra.Append(",\"errorText\":").Append(J(a.Length > 4 ? a[4] : ""));
                    else
                        extra.Append(",\"mac\":").Append(J(a.Length > 4 ? a[4] : ""));
                }
                else if (head == "DevChange")
                {
                    if (a.Length >= 3) extra.Append(",\"online\":").Append(IntOf(a[1]) > 0 ? "true" : "false")
                                          .Append(",\"com\":").Append(J(a[2]));
                }
                else if (head == "FileInfo")
                {
                    extra.Append(",\"dcfPath\":").Append(J(a.Length > 1 ? a[1] : ""))
                         .Append(",\"firmwareChecksum\":").Append(J(a.Length > 5 ? a[5] : ""));
                    // 原样带上全部字段，避免我们猜错列位置
                    extra.Append(",\"fieldCount\":").Append(a.Length);
                }
                else if (head == "DevInfo")
                {
                    extra.Append(",\"deviceChecksum\":").Append(J(a.Length > 3 ? a[3] : ""))
                         .Append(",\"fieldCount\":").Append(a.Length);
                }
                else if (head == "Log")
                {
                    // 官方 PDF 未记载的消息类型（实测存在）。形态：Log|<文本>\r\n
                    // 用户要"看日志"，这是关键数据源。
                    string body = raw.Length > 4 ? raw.Substring(4) : "";
                    extra.Append(",\"text\":").Append(J(body.TrimEnd('\r', '\n')))
                         .Append(",\"multiline\":").Append(body.IndexOf('\n') >= 0 ? "true" : "false");
                }
                else if (head == "Error")
                {
                    extra.Append(",\"text\":").Append(J(a.Length > 1 ? a[1] : ""));
                }
            }
            catch (Exception ex)
            {
                EmitError("parse", ex.Message);
            }

            Ev("dl_msg", extra.ToString());
        }

        private static long IntOf(string s)
        {
            long v;
            if (long.TryParse((s ?? "").Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out v)) return v;
            return -1;
        }

        // ---------------- 发消息 ----------------

        public bool SendToDownloader(string text)
        {
            IntPtr target = ResolveDownloaderHwnd();
            if (target == IntPtr.Zero)
            {
                // Downloader 启动要 3~8 秒才发 StartOK。上层/自动化脚本很可能提前就发命令了，
                // 所以这里不能直接失败，要边泵消息边等。这个坑实测踩到过：
                // 提前 send 会得到 "downloader hwnd unknown (no StartOK yet)"，命令被丢掉。
                DateTime deadline = DateTime.Now.AddMilliseconds(_opt.SendWaitMs);
                while (DateTime.Now < deadline && _running)
                {
                    Application.DoEvents();
                    Thread.Sleep(50);
                    target = ResolveDownloaderHwnd();
                    if (target != IntPtr.Zero) break;
                }
                if (target == IntPtr.Zero)
                {
                    EmitError("send", "downloader hwnd unknown after waiting " + _opt.SendWaitMs +
                                      "ms (StartOK never arrived)");
                    return false;
                }
                Ev("send_waited", "\"target\":" + J(Hex(target)));
            }
            byte[] body = _opt.Wire.GetBytes(text);
            IntPtr mem = Marshal.AllocHGlobal(body.Length + 1);
            try
            {
                Marshal.Copy(body, 0, mem, body.Length);
                Marshal.WriteByte(mem, body.Length, 0);

                Native.COPYDATASTRUCT cds = new Native.COPYDATASTRUCT();
                cds.dwData = IntPtr.Zero;
                cds.cbData = body.Length + 1;
                cds.lpData = mem;

                IntPtr result;
                IntPtr ok = Native.SendMessageTimeout(target, Native.WM_COPYDATA, IntPtr.Zero,
                    ref cds, Native.SMTO_BLOCK | Native.SMTO_ABORTIFHUNG, (uint)_opt.TimeoutMs, out result);
                bool sent = ok != IntPtr.Zero;
                Ev("tx", "\"text\":" + J(text) + ",\"target\":" + J(Hex(target)) +
                        ",\"ok\":" + (sent ? "true" : "false") +
                        ",\"win32err\":" + Marshal.GetLastWin32Error());
                return sent;
            }
            finally
            {
                Marshal.FreeHGlobal(mem);
            }
        }

        private static string Hex(IntPtr p)
        {
            return "0x" + p.ToInt64().ToString("X", CultureInfo.InvariantCulture);
        }

        private IntPtr ResolveDownloaderHwnd()
        {
            // 1) Downloader 自己在 StartOK 里报的句柄 —— 最可信
            if (_dlHwndFromStartOk != 0)
            {
                IntPtr h = new IntPtr(_dlHwndFromStartOk);
                if (Native.IsWindow(h)) return h;
            }
            // 2) 之前按 PID 找到并缓存的主窗体
            if (_dlHwndByPid != 0)
            {
                IntPtr h = new IntPtr(_dlHwndByPid);
                if (Native.IsWindow(h)) return h;
            }
            // 3) 现找一次（StartOK 尚未到时的兜底）
            IntPtr byPid = FindMainWindowByPid();
            if (byPid != IntPtr.Zero) { _dlHwndByPid = byPid.ToInt64(); return byPid; }
            return IntPtr.Zero;
        }

        /// <summary>
        /// EnumWindows 的托管回调是委托；如果不持有强引用，GC 可能在原生枚举期间回收它，
        /// 导致进程静默崩溃。这里统一走这个包装器。
        /// </summary>
        private void EnumWindowsSafe(Native.EnumWindowsProc cb)
        {
            lock (_enumKeepAlive) { _enumKeepAlive.Add(cb); }
            Native.EnumWindows(cb, IntPtr.Zero);
        }

        private IntPtr FindMainWindowByPid()
        {
            if (_proc == null || _proc.HasExited) return IntPtr.Zero;
            int pid = _proc.Id;
            IntPtr found = IntPtr.Zero;
            IntPtr best = IntPtr.Zero;
            int bestScore = 0;

            Native.EnumWindowsProc cb = delegate(IntPtr h, IntPtr l)
            {
                uint wp;
                Native.GetWindowThreadProcessId(h, out wp);
                if ((int)wp != pid) return true;

                StringBuilder cls = new StringBuilder(256);
                Native.GetClassNameW(h, cls, cls.Capacity);
                StringBuilder ttl = new StringBuilder(256);
                Native.GetWindowTextW(h, ttl, ttl.Capacity);
                long style = Native.GetWindowLongPtr(h, Native.GWL_STYLE).ToInt64();
                bool visible = (style & Native.WS_VISIBLE) != 0;
                Native.RECT r;
                Native.GetWindowRect(h, out r);

                int w = r.Right - r.Left;
                int hh = r.Bottom - r.Top;
                bool isForm = cls.ToString().StartsWith("WindowsForms10", StringComparison.Ordinal);
                bool hasCaption = (style & 0x00C00000L) != 0;   // WS_CAPTION：有标题栏的才是顶层窗体
                bool titled = ttl.Length > 0;

                // 打分：只要"有标题栏 + 有标题 + 面积够大"的顶层窗体，
                // 绝不能挑到 20808/0 这类辅助小窗（实测会挑错，hidden 一个 101x92 的隐形窗毫无意义）。
                int score = 0;
                if (isForm) score += 1;
                if (hasCaption) score += 4;
                if (titled) score += 4;
                if (w >= 400 && hh >= 300) score += 4;
                if (visible) score += 2;
                if (!isForm) score -= 3;

                if (score > bestScore) { bestScore = score; best = h; }
                return true;
            };
            EnumWindowsSafe(cb);
            // 门槛：必须像"主窗体"。否则启动早期会挑到 GDI+ Hook Window / IME 这类无名小窗，
            // 后续 hide/embed 打在错误句柄上（实测踩过）。
            if (bestScore < MinFormScore) return IntPtr.Zero;
            found = best;
            return found;
        }

        private const int MinFormScore = 10;

        /// <summary>
        /// 读 Downloader 主窗里 COMBOBOX 当前选中项（就是当前 dcf 路径）。
        /// 实测确认：能读到，且与界面上显示的一致。
        /// </summary>
        private string ReadCurrentDcf()
        {
            try
            {
                IntPtr main = ResolveDownloaderHwnd();
                if (main == IntPtr.Zero) return "__no_main__";

                IntPtr combo = IntPtr.Zero;
                Native.EnumChildWindows(main, delegate (IntPtr h, IntPtr l)
                {
                    var sb = new StringBuilder(256);
                    Native.GetClassName(h, sb, sb.Capacity);
                    if (sb.ToString().IndexOf("COMBOBOX", StringComparison.OrdinalIgnoreCase) >= 0)
                    {
                        combo = h;
                        return false;
                    }
                    return true;
                }, IntPtr.Zero);

                if (combo == IntPtr.Zero) return "__no_combo__:" + main.ToInt64();
                int cur = (int)Native.SendMessage(combo, Native.CB_GETCURSEL, IntPtr.Zero, IntPtr.Zero);
                if (cur < 0) return "__no_sel__:" + combo.ToInt64();
                int len = (int)Native.SendMessage(combo, Native.CB_GETLBTEXTLEN, (IntPtr)cur, IntPtr.Zero);
                if (len <= 0 || len > 4096) return "";
                var buf = new StringBuilder(len + 2);
                Native.SendMessageStr(combo, Native.CB_GETLBTEXT, (IntPtr)cur, buf);
                return buf.ToString();
            }
            catch (Exception ex) { return "__err__:" + ex.GetType().Name + ":" + ex.Message; }
        }

        private string DescribeWindows()
        {
            if (_proc == null || _proc.HasExited) return "[]";
            int pid = _proc.Id;
            StringBuilder sb = new StringBuilder("[");
            bool first = true;
            Native.EnumWindowsProc cb = delegate(IntPtr h, IntPtr l)
            {
                uint wp;
                Native.GetWindowThreadProcessId(h, out wp);
                if ((int)wp != pid) return true;
                long style = Native.GetWindowLongPtr(h, Native.GWL_STYLE).ToInt64();
                StringBuilder t = new StringBuilder(256);
                Native.GetWindowTextW(h, t, t.Capacity);
                StringBuilder c = new StringBuilder(256);
                Native.GetClassNameW(h, c, c.Capacity);
                Native.RECT r;
                Native.GetWindowRect(h, out r);
                if (!first) sb.Append(',');
                first = false;
                sb.Append("{\"hwnd\":\"").Append(Hex(h)).Append('"')
                  .Append(",\"class\":").Append(J(c.ToString()))
                  .Append(",\"title\":").Append(J(t.ToString()))
                  .Append(",\"visible\":").Append((style & Native.WS_VISIBLE) != 0 ? "true" : "false")
                  .Append(",\"rect\":[").Append(r.Left).Append(',').Append(r.Top).Append(',')
                  .Append(r.Right).Append(',').Append(r.Bottom).Append("]}");
                return true;
            };
            EnumWindowsSafe(cb);
            sb.Append(']');
            return sb.ToString();
        }

        // ---------------- 启停 ----------------

        public void Launch(string argsOverride)
        {
            if (_proc != null && !_proc.HasExited)
            {
                Ev("launch_skip", "\"reason\":" + J("already running") + ",\"pid\":" + _proc.Id);
                return;
            }
            string args = argsOverride ?? _opt.ArgsTemplate;
            args = args.Replace("{hwnd}", _wnd.Handle32.ToString(CultureInfo.InvariantCulture));
            args = args.Replace("{hwndhex}", _wnd.Handle32.ToString("X", CultureInfo.InvariantCulture));

            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = _opt.ExePath;
            psi.Arguments = args;
            psi.WorkingDirectory = Path.GetDirectoryName(Path.GetFullPath(_opt.ExePath));
            psi.UseShellExecute = false;          // 参考实现用 true；我们要拿到真实进程句柄以便可靠回收
            psi.CreateNoWindow = false;
            // Downloader 是 WinForms 但会往控制台打日志（下载过程日志）。重定向出来，
            // 否则它会直接写进我们的 stdout，破坏 JSON 行协议。
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            try { psi.StandardOutputEncoding = Encoding.GetEncoding(936); } catch { }
            try { psi.StandardErrorEncoding = Encoding.GetEncoding(936); } catch { }

            try
            {
                _proc = Process.Start(psi);
            }
            catch (Exception ex)
            {
                EmitError("launch", ex.Message);
                return;
            }
            try
            {
                _proc.OutputDataReceived += delegate(object s, DataReceivedEventArgs e)
                {
                    if (e.Data != null)
                        Ev("dl_console", "\"line\":" + J(e.Data));
                };
                _proc.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e)
                {
                    if (e.Data != null)
                        Ev("dl_stderr", "\"line\":" + J(e.Data));
                };
                _proc.BeginOutputReadLine();
                _proc.BeginErrorReadLine();
            }
            catch (Exception ex)
            {
                EmitError("redirect", ex.Message);
            }
            // 把子进程塞进 Job Object：helper 一旦死掉（包括被强杀），Downloader 跟着死。
            // 没有这层保护的话，helper 崩溃会留下一个隐藏的 Downloader 进程一直攥着 COM 口。
            try
            {
                IntPtr job = Native.CreateJobObject(IntPtr.Zero, null);
                if (job != IntPtr.Zero)
                {
                    Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION info =
                        new Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                    info.BasicLimitInformation.LimitFlags = Native.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                    int len = Marshal.SizeOf(typeof(Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
                    IntPtr p = Marshal.AllocHGlobal(len);
                    try
                    {
                        Marshal.StructureToPtr(info, p, false);
                        Native.SetInformationJobObject(job, Native.JobObjectExtendedLimitInformation, p, (uint)len);
                    }
                    finally { Marshal.FreeHGlobal(p); }
                    bool assigned = Native.AssignProcessToJobObject(job, _proc.Handle);
                    Ev("job", "\"assigned\":" + (assigned ? "true" : "false"));
                    _job = job;   // 故意不 CloseHandle：句柄一关就会连带杀掉子进程
                }
            }
            catch (Exception ex) { EmitError("job", ex.Message); }

            Ev("launched", "\"pid\":" + _proc.Id + ",\"exe\":" + J(psi.FileName) +
                    ",\"args\":" + J(args) + ",\"cwd\":" + J(psi.WorkingDirectory));

            // 等 StartOK（这是 Downloader 告知"我起来了、这是我的窗口句柄"的唯一信号）
            // 同时并行等窗口出现，两路都推进
            DateTime deadline = DateTime.Now.AddMilliseconds(_opt.LaunchWaitMs);
            IntPtr hwnd = IntPtr.Zero;
            while (DateTime.Now < deadline)
            {
                Thread.Sleep(100);
                PumpOnce();
                if (hwnd == IntPtr.Zero) hwnd = FindMainWindowByPid();
                if (hwnd != IntPtr.Zero && _startOk.IsSet) break;
            }
            Ev("startok_wait", "\"got\":" + (_startOk.IsSet ? "true" : "false") +
                    ",\"waitedMs\":" + Math.Round((DateTime.Now - (deadline.AddMilliseconds(-_opt.LaunchWaitMs))).TotalMilliseconds));

            if (hwnd != IntPtr.Zero)
            {
                _dlHwndByPid = hwnd.ToInt64();
                long style = Native.GetWindowLongPtr(hwnd, Native.GWL_STYLE).ToInt64();
                bool visBefore = (style & Native.WS_VISIBLE) != 0;
                Ev("window_found", "\"hwnd\":" + J(Hex(hwnd)) + ",\"visibleBefore\":" +
                        (visBefore ? "true" : "false"));

                if (_opt.EmbedInto != null)
                {
                    IntPtr parent = ParseHwnd(_opt.EmbedInto);
                    if (parent != IntPtr.Zero)
                    {
                        IntPtr prev = Native.SetParent(hwnd, parent);
                        long st = Native.GetWindowLongPtr(hwnd, Native.GWL_STYLE).ToInt64();
                        // 变成子窗口风格
                        Native.RECT r;
                        Native.GetWindowRect(hwnd, out r);
                        Ev("embedded", "\"child\":" + J(Hex(hwnd)) + ",\"parent\":" + J(Hex(parent)) +
                                ",\"prevParent\":" + J(Hex(prev)) +
                                ",\"childStyle\":\"" + "0x" + st.ToString("X") + "\"");
                    }
                }
                else if (_opt.HideAfterLaunch)
                {
                    Native.ShowWindow(hwnd, Native.SW_HIDE);
                    Thread.Sleep(150);
                    PumpOnce();
                    bool visAfter = Native.IsWindowVisible(hwnd);
                    Ev("hidden", "\"hwnd\":" + J(Hex(hwnd)) + ",\"visibleAfter\":" +
                            (visAfter ? "true" : "false"));
                }
            }
            else
            {
                Ev("window_found", "\"hwnd\":null,\"note\":" + J("no top-level window within wait time"));
            }

            Ev("windows", "\"list\":" + DescribeWindows());
        }

        private static IntPtr ParseHwnd(string s)
        {
            if (string.IsNullOrEmpty(s)) return IntPtr.Zero;
            s = s.Trim();
            long v;
            if (s.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
            {
                if (long.TryParse(s.Substring(2), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out v))
                    return new IntPtr(v);
            }
            else if (long.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out v))
            {
                return new IntPtr(v);
            }
            return IntPtr.Zero;
        }

        public void KillSelfLaunched()
        {
            if (_proc == null) { Ev("kill", "\"result\":" + J("no process")); return; }
            try
            {
                if (!_proc.HasExited)
                {
                    _proc.Kill();
                    _proc.WaitForExit(4000);
                }
                Ev("kill", "\"pid\":" + _proc.Id + ",\"exited\":true");
            }
            catch (Exception ex)
            {
                EmitError("kill", ex.Message);
            }
        }

        // ---------------- 主循环 ----------------

        private void PumpOnce()
        {
            Application.DoEvents();
        }

        private void StdinLoop()
        {
            string line;
            while ((line = Console.In.ReadLine()) != null)
            {
                _cmds.Enqueue(line);
                _wake.Set();
            }
            _cmds.Enqueue("quit");
            _wake.Set();
        }

        private void HandleCommand(string line)
        {
            line = (line ?? "").Trim();
            if (line.Length == 0) return;
            string[] parts = line.Split(new char[] { ' ' }, 2);
            string cmd = parts[0].ToLowerInvariant();
            string rest = parts.Length > 1 ? parts[1] : null;

            switch (cmd)
            {
                case "ping":
                    Ev("pong", "\"hwnd\":" + _wnd.Handle32 + ",\"pid\":" + Process.GetCurrentProcess().Id);
                    break;
                case "launch":
                    Launch(rest);
                    break;
                case "send":
                    SendToDownloader(rest ?? "");
                    break;
                case "download":
                    SendToDownloader("StartDownload");
                    break;
                case "erase":
                    SendToDownloader("StartErase");
                    break;
                case "readinfo":
                case "read-code-info":
                    SendToDownloader("StartReadCodeInfo");
                    break;
                case "hide":
                {
                    IntPtr h = ResolveDownloaderHwnd();
                    if (h != IntPtr.Zero) Native.ShowWindow(h, Native.SW_HIDE);
                    Ev("hidden", "\"hwnd\":" + J(Hex(h)) + ",\"visibleAfter\":" +
                            (h != IntPtr.Zero && Native.IsWindowVisible(h) ? "true" : "false"));
                    break;
                }
                case "show":
                {
                    IntPtr h = ResolveDownloaderHwnd();
                    if (h != IntPtr.Zero) Native.ShowWindow(h, Native.SW_SHOWNOACTIVATE);
                    Ev("shown", "\"hwnd\":" + J(Hex(h)) + ",\"visible\":" +
                            (h != IntPtr.Zero && Native.IsWindowVisible(h) ? "true" : "false"));
                    break;
                }
                case "embed":
                {
                    IntPtr h = ResolveDownloaderHwnd();
                    IntPtr parent = ParseHwnd(rest);
                    if (h == IntPtr.Zero || parent == IntPtr.Zero)
                    {
                        EmitError("embed", "need valid downloader hwnd and parent hwnd");
                        break;
                    }
                    Native.SetParent(h, parent);
                    Ev("embedded", "\"child\":" + J(Hex(h)) + ",\"parent\":" + J(Hex(parent)));
                    break;
                }
                case "detach":
                {
                    IntPtr h = ResolveDownloaderHwnd();
                    if (h != IntPtr.Zero) Native.SetParent(h, IntPtr.Zero);
                    Ev("detached", "\"hwnd\":" + J(Hex(h)));
                    break;
                }
                case "windows":
                    Ev("windows", "\"list\":" + DescribeWindows());
                    break;
                case "curdcf":
                    {
                        // 读 Downloader 窗口里 dcf 下拉框当前选中的路径。
                        // 为什么：用户在 GUI 里切 dcf 时，Downloader 既不推 FileInfo
                        // 也不写 config，只有直接读控件才能知道它选了哪个。
                        Ev("curdcf", "\"path\":" + J(ReadCurrentDcf()));
                    }
                    break;
                case "hwnd":
                    Ev("hwnd", "\"downloader\":" + J(Hex(ResolveDownloaderHwnd())) +
                            ",\"receiver\":" + _wnd.Handle32);
                    break;
                case "kill":
                    KillSelfLaunched();
                    break;
                case "quit":
                case "exit":
                    _running = false;
                    break;
                default:
                    EmitError("cmd", "unknown command: " + cmd);
                    break;
            }
        }

        public int Run()
        {
            // 任何托管/原生回调里漏出的异常都不能让 helper 静默死掉，否则上层只能看到 stdin 写失败
            AppDomain.CurrentDomain.UnhandledException += delegate(object s, UnhandledExceptionEventArgs e)
            {
                Exception ex = e.ExceptionObject as Exception;
                WriteJson("{\"ts\":" + Ms() + ",\"ev\":\"fatal\",\"msg\":" +
                          J(ex != null ? ex.GetType().Name + ": " + ex.Message : "unknown") + "}");
            };
            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
            Application.ThreadException += delegate(object s, ThreadExceptionEventArgs e)
            {
                WriteJson("{\"ts\":" + Ms() + ",\"ev\":\"fatal_thread\",\"msg\":" +
                          J(e.Exception != null ? e.Exception.GetType().Name + ": " + e.Exception.Message : "unknown") + "}");
            };

            _wnd = new HiddenReceiver(this);
            Ev("ready", "\"receiverHwnd\":" + _wnd.Handle32 +
                    ",\"receiverHwndHex\":" + J(Hex(_wnd.Handle)) +
                    ",\"helperPid\":" + Process.GetCurrentProcess().Id +
                    ",\"encoding\":" + J(_opt.Wire.WebName) +
                    ",\"exe\":" + J(_opt.ExePath));

            Thread t = new Thread(StdinLoop);
            t.IsBackground = true;
            t.Start();

            System.Threading.Timer wd = null;
            if (!_opt.NoLaunch)
            {
                wd = new System.Threading.Timer(delegate { Launch(null); }, null, 400, System.Threading.Timeout.Infinite);
            }

            while (_running)
            {
                string c;
                bool any = false;
                while (_cmds.TryDequeue(out c)) { any = true; HandleCommand(c); }
                if (!_running) break;
                // 让 Windows 消息泵跑起来（这是收 WM_COPYDATA 的必要条件）
                PumpOnce();

                if (!any)
                {
                    _wake.Wait(15);
                    _wake.Reset();
                }
            }

            Ev("bye", "\"rxCount\":" + _rxCount);
            // 先把消息泵再空转一会儿，让 DownSta 等尾包落地，再退出
            for (int i = 0; i < 20; i++) { Application.DoEvents(); Thread.Sleep(10); }
            KillSelfLaunched();
            try { _wnd.DestroyHandlePublic(); } catch { }
            return 0;
        }
    }

    internal static class Program
    {
        [STAThread]
        private static int Main(string[] argv)
        {
            BridgeOptions o = new BridgeOptions();
            for (int i = 0; i < argv.Length; i++)
            {
                string a = argv[i];
                switch (a)
                {
                    case "--exe": o.ExePath = argv[++i]; break;
                    case "--args": o.ArgsTemplate = argv[++i]; o.ArgsExplicit = true; break;
                    case "--no-launch": o.NoLaunch = true; break;
                    case "--no-hide": o.HideAfterLaunch = false; break;
                    case "--embed": o.EmbedInto = argv[++i]; break;
                    case "--encoding":
                        {
                            string v = argv[++i];
                            o.Wire = v.Equals("utf-8", StringComparison.OrdinalIgnoreCase) ||
                                     v.Equals("utf8", StringComparison.OrdinalIgnoreCase)
                                        ? new UTF8Encoding(false) : Encoding.GetEncoding(936);
                            break;
                        }
                    case "--timeout": o.TimeoutMs = int.Parse(argv[++i], CultureInfo.InvariantCulture); break;
                    case "--launch-wait": o.LaunchWaitMs = int.Parse(argv[++i], CultureInfo.InvariantCulture); break;
                    case "--verbose": o.Verbose = true; break;
                    case "--help":
                    case "-h":
                        Console.Error.WriteLine("DownloaderIpcBridge --exe <path> [--args \"BackShowMode {hwnd} -b\"] [--no-launch] [--no-hide] [--embed <hwnd>] [--encoding gbk|utf-8]");
                        return 0;
                    default:
                        Console.Error.WriteLine("unknown option: " + a);
                        return 2;
                }
            }
            if (string.IsNullOrEmpty(o.ExePath))
            {
                Console.Error.WriteLine("missing --exe");
                return 2;
            }
            if (!File.Exists(o.ExePath))
            {
                Console.Error.WriteLine("not found: " + o.ExePath);
                return 2;
            }
            // 中文路径/控制台编码
            try { Console.OutputEncoding = new UTF8Encoding(false); } catch { }
            try { Console.InputEncoding = new UTF8Encoding(false); } catch { }

            return new Bridge(o).Run();
        }
    }
}
