using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

// WorkbayPty —— Windows ConPTY helper（64 位 .NET Framework 4.8，零第三方依赖）
//
// 为什么需要它：DSH 的插件 host 半侧跑在 Electron 主进程里，不能加载 Node 原生模块
// （ABI 不匹配、终端用户机器没有编译工具链），所以真 PTY 只能由独立进程提供。
// 本程序只做三件事：建一个真的伪控制台（ConPTY）、把 host 的二进制帧写成 PTY 的
// 原始字节、把 shell 的原始字节转回帧。它不解析 shell 语法，也不做任何转码。
//
// 启动参数（固定形状，全部由 host 传入，绝不拼接用户输入）：
//   WorkbayPty.exe --shell <exe 绝对路径> --shell-args <base64(JSON 数组)> ^
//                  --cwd <目录> --cols <n> --rows <n>
//   例：--shell C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe
//       --shell-args WyItTm9Mb2dvIiwiLU5vUHJvZmlsZSIsIi1Ob0V4aXQiXQ==
//       （解码后是 ["-NoLogo","-NoProfile","-NoExit"]）
//
// 退出码：0 正常；2 参数/帧流非法；3 PTY 创建失败；4 子进程创建失败。
//
// 帧协议（stdin / stdout，二进制；stderr 只写诊断文本）：
//   +------+----------------+------------------+
//   | type | uint32 LE 长度 | payload          |
//   | 1B   | 4B             | N                |
//   +------+----------------+------------------+
//   host -> helper: 'D' 原始字节（写进 PTY 输入，含 \x03 等控制字符）
//                   'R' 4B：uint16 cols + uint16 rows（ResizePseudoConsole）
//                   'X' 4B：uint32 pid（0 = 整棵进程树）
//   helper -> host: 'D' 原始字节（PTY 输出，UTF-8，可能从字符中间切开）
//                   'X' 4B：int32 exit code（shell 已退出，helper 随后退出）
//
// 线程模型：stdin 帧循环一个线程、PTY 输出一个线程、主线程只等子进程。两个线程都会
// 往 stdout 写帧，所以写 stdout 必须持锁；stdout 上只有帧，诊断一律走 stderr。
//
// 生命周期（两个容易踩的坑）：
//   * ConPTY 的两端（交给 CreatePseudoConsole 的读端/写端）必须活到
//     ClosePseudoConsole 为止，提前 CloseHandle 会让伪控制台看到半关的管道；
//   * 子进程退出后不能立刻发 'X'：要先等输出线程把管道里剩下的字节发完（读到 EOF），
//     否则 host 会先收到退出码、丢掉最后几行输出。见 FinishOutput()。

internal static class Program
{
    /* ---------------- 进程退出码（docs/terminal-pty.md §1 冻结） ---------------- */

    private const int ExitOk = 0;
    private const int ExitUsage = 2;
    private const int ExitPty = 3;
    private const int ExitProcess = 4;

    /* ---------------- 常量 ---------------- */

    private const int StdInputHandle = -10;
    private const int StdOutputHandle = -11;
    private const int StdErrorHandle = -12;

    private const uint HandleFlagInherit = 0x00000001;
    private const uint Infinite = 0xFFFFFFFF;

    private const uint ExtendedStartupInfoPresent = 0x00080000;
    private const uint CreateUnicodeEnvironment = 0x00000400;
    private const int StartupInfoUseStdHandles = 0x00000100;

    // ProcThreadAttributeValue(22, FALSE, TRUE, FALSE) —— 伪控制台属性的固定编号
    private const int ProcThreadAttributePseudoConsole = 0x00020016;

    private const int JobObjectInfoClassExtendedLimit = 9;
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;

    private const uint ProcessTerminate = 0x0001;

    private const int MaxFrameBytes = 8 * 1024 * 1024;
    private const int PtyWriteChunk = 64 * 1024;
    private const int OutputChunk = 16 * 1024;

    /* 子进程退出后先给 ConPTY 一点时间把尾巴写进管道；因为输出写端还有我们一份，
       读线程不会先 EOF，所以这个等待是固定开销（不是超时兜底）。 */
    private const int NaturalDrainMs = 150;
    private const int DrainAfterCloseMs = 2000;

    /* ---------------- 进程内状态（一个 helper = 一个终端会话） ---------------- */

    private static IntPtr _stdin = IntPtr.Zero;
    private static IntPtr _stdout = IntPtr.Zero;
    private static IntPtr _stderr = IntPtr.Zero;

    private static IntPtr _ptyInputRead = IntPtr.Zero;   // 交给 ConPTY（它读键盘输入）
    private static IntPtr _ptyInputWrite = IntPtr.Zero;  // helper 持有（写键盘输入）
    private static IntPtr _ptyOutputRead = IntPtr.Zero;  // helper 持有（读屏幕输出）
    private static IntPtr _ptyOutputWrite = IntPtr.Zero; // 交给 ConPTY（它写屏幕输出）
    private static IntPtr _pseudoConsole = IntPtr.Zero;
    private static IntPtr _child = IntPtr.Zero;
    private static IntPtr _job = IntPtr.Zero;
    private static int _childPid;

    private static readonly object StdoutLock = new object();
    private static readonly ManualResetEvent OutputDone = new ManualResetEvent(false);
    private static volatile bool _closing;

    private static ResizePseudoConsoleFn _resize;
    private static bool _resizeResolved;

    /* ================================ 入口 ================================ */

    private static int Main(string[] argv)
    {
        _stdin = GetStdHandle(StdInputHandle);
        _stdout = GetStdHandle(StdOutputHandle);
        _stderr = GetStdHandle(StdErrorHandle);

        Options options;
        string error;
        if (!Options.TryParse(argv, out options, out error))
        {
            Diag("invalid arguments: " + error);
            return ExitUsage;
        }
        return Run(options);
    }

    private static int Run(Options options)
    {
        /* helper 自己的三个标准句柄绝不能被子进程继承：否则 host 关闭 stdin 之后，
           子进程仍握着那根管道的写端，helper 的 EOF 语义就没了。 */
        ClearInherit(_stdin);
        ClearInherit(_stdout);
        ClearInherit(_stderr);

        SecurityAttributes sa = new SecurityAttributes();
        sa.nLength = Marshal.SizeOf(typeof(SecurityAttributes));
        sa.lpSecurityDescriptor = IntPtr.Zero;
        sa.bInheritHandle = 1;

        /* ConPTY 的两根管道：输入（helper 写 / conpty 读）、输出（conpty 写 / helper 读）。
           四端先按可继承创建（CreatePseudoConsole 需要），再把 helper 自己保留的两端改回
           不可继承，避免 shell 手里也多出一份。 */
        if (!CreatePipe(out _ptyInputRead, out _ptyInputWrite, ref sa, 0)
            || !CreatePipe(out _ptyOutputRead, out _ptyOutputWrite, ref sa, 0))
        {
            Diag("cannot create pipes: " + LastErrorText());
            return ExitPty;
        }
        ClearInherit(_ptyInputWrite);
        ClearInherit(_ptyOutputRead);

        Coord size = new Coord();
        size.X = options.Cols;
        size.Y = options.Rows;

        int hr;
        try
        {
            hr = CreatePseudoConsole(size, _ptyInputRead, _ptyOutputWrite, 0, out _pseudoConsole);
        }
        catch (EntryPointNotFoundException)
        {
            Diag("CreatePseudoConsole is not available on this Windows build");
            return ExitPty;
        }
        catch (DllNotFoundException)
        {
            Diag("kernel32.dll does not expose CreatePseudoConsole");
            return ExitPty;
        }
        if (hr != 0 || _pseudoConsole == IntPtr.Zero)
        {
            Diag("CreatePseudoConsole failed: 0x" + hr.ToString("X8", CultureInfo.InvariantCulture));
            return ExitPty;
        }

        ProcessInformation pi;
        if (!CreateChild(options, out pi))
        {
            Diag("CreateProcess failed: " + LastErrorText());
            return ExitProcess;
        }

        _child = pi.hProcess;
        _childPid = pi.dwProcessId;
        CloseHandle(pi.hThread);

        /* 子进程放进 Job：helper 被杀时 KILL_ON_JOB_CLOSE 顺手带走整棵树，终端不会留下
           孤儿 powershell。嵌套 job 在 Win8+ 支持；失败不致命（KillTree 会退化成
           TerminateProcess）。 */
        AttachJob(_child);

        Thread reader = new Thread(OutputLoop);
        reader.IsBackground = true;
        reader.Name = "workbay-pty-out";
        reader.Start();

        Thread feeder = new Thread(InputLoop);
        feeder.IsBackground = true;
        feeder.Name = "workbay-pty-in";
        feeder.Start();

        /* 主线程只等子进程。'X' 帧 / stdin EOF 由 feeder 线程负责杀树，所以这里必然返回。 */
        uint waited = WaitForSingleObject(_child, Infinite);
        if (waited != 0)
        {
            /* WAIT_FAILED：句柄无效（几乎不可能）。写清楚 Win32 错误，别让 host 只看到 0。 */
            Diag("WaitForSingleObject returned " + waited.ToString(CultureInfo.InvariantCulture)
                + ", " + LastErrorText());
        }

        uint exitCode = 0;
        if (!GetExitCodeProcess(_child, out exitCode))
        {
            /* 同上：拿不到退出码时报告真实错误，X 里仍然只能给 0（契约是 int32）。 */
            Diag("GetExitCodeProcess failed: " + LastErrorText());
            exitCode = 0;
        }

        FinishOutput();
        WriteExitFrame(unchecked((int)exitCode));

        /* 收尾只用 Environment.Exit：进程退出时内核关闭全部句柄，job 的
           KILL_ON_JOB_CLOSE 同时把 shell 树带走。
           不能在主线程 CloseHandle(_ptyOutputRead)：读线程可能正阻塞在它的 ReadFile
           上，CloseHandle 会一直等到那次读完成（实测表现：X 帧发出去了，helper 却不退出）。 */
        ClosePseudoConsoleHandle();
        Environment.Exit(ExitOk);
        return ExitOk;
    }

    /* ============================ PTY 输出收尾 ============================ */

    /* 伪控制台的输出写端还有我们手里的这一份，所以读线程不可能先读到自然 EOF：
       先给 ConPTY 一小段时间把子进程最后一段输出写进管道，然后关伪控制台并关掉我们
       这份写端，读线程随即读完管道里剩下的字节并读到 EOF。这样 'X' 帧必然排在最后
       一段输出之后。 */
    private static void FinishOutput()
    {
        if (OutputDone.WaitOne(NaturalDrainMs)) return;
        ClosePseudoConsoleHandle();
        CloseWriteEnd(ref _ptyOutputWrite);
        OutputDone.WaitOne(DrainAfterCloseMs);
    }

    private static void CloseWriteEnd(ref IntPtr handle)
    {
        if (handle == IntPtr.Zero) return;
        try
        {
            CloseHandle(handle);
        }
        catch (Exception)
        {
            /* 已经关掉也无所谓 */
        }
        handle = IntPtr.Zero;
    }

    /* ============================ 子进程创建 ============================ */

    private static bool CreateChild(Options options, out ProcessInformation pi)
    {
        pi = new ProcessInformation();

        StartupInfoEx siEx = new StartupInfoEx();
        siEx.StartupInfo.cb = Marshal.SizeOf(typeof(StartupInfoEx));
        IntPtr attributeList = IntPtr.Zero;
        IntPtr attributeSize = IntPtr.Zero;
        bool listReady = false;

        try
        {
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeSize);
            attributeList = Marshal.AllocHGlobal(attributeSize);
            if (!InitializeProcThreadAttributeList(attributeList, 1, 0, ref attributeSize))
            {
                Diag("InitializeProcThreadAttributeList failed: " + LastErrorText());
                return false;
            }
            listReady = true;
            /* 属性值就是 HPCON 本身（按值传，长度 sizeof(HPCON)）。 */
            if (!UpdateProcThreadAttribute(attributeList, 0,
                    (IntPtr)ProcThreadAttributePseudoConsole, _pseudoConsole,
                    (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero))
            {
                Diag("UpdateProcThreadAttribute failed: " + LastErrorText());
                return false;
            }
            siEx.lpAttributeList = attributeList;

            /* 关键（实测踩到的坑）：必须声明 STARTF_USESTDHANDLES 且三个句柄全部给 NULL。
               否则 CreateProcess 让子进程继承“本 helper 的标准句柄”——而 helper 的 stdout
               是帧管道、stdin 是帧管道；结果 shell 的输出直接漏进协议流（或者因为不可继承
               而变成无效句柄，shell 立刻退出、PTY 只剩 conhost 的初始化序列）。显式给 NULL
               之后，控制台子系统才会把子进程接到伪控制台上。 */
            siEx.StartupInfo.dwFlags = StartupInfoUseStdHandles;
            siEx.StartupInfo.hStdInput = IntPtr.Zero;
            siEx.StartupInfo.hStdOutput = IntPtr.Zero;
            siEx.StartupInfo.hStdError = IntPtr.Zero;

            StringBuilder commandLine = new StringBuilder(BuildCommandLine(options));
            return CreateProcessW(
                options.Shell,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                true /* 必须 true：ConPTY 的管道端要能被 conhost/子进程继承 */,
                ExtendedStartupInfoPresent | CreateUnicodeEnvironment,
                IntPtr.Zero,
                options.Cwd,
                ref siEx,
                out pi);
        }
        finally
        {
            if (attributeList != IntPtr.Zero)
            {
                if (listReady) DeleteProcThreadAttributeList(attributeList);
                Marshal.FreeHGlobal(attributeList);
            }
        }
    }

    private static void AttachJob(IntPtr process)
    {
        try
        {
            _job = CreateJobObjectW(IntPtr.Zero, null);
            if (_job == IntPtr.Zero) return;

            JobObjectExtendedLimitInformation info = new JobObjectExtendedLimitInformation();
            info.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
            int length = Marshal.SizeOf(typeof(JobObjectExtendedLimitInformation));
            IntPtr buffer = Marshal.AllocHGlobal(length);
            try
            {
                Marshal.StructureToPtr(info, buffer, false);
                SetInformationJobObject(_job, JobObjectInfoClassExtendedLimit, buffer, (uint)length);
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
            /* 已经在一个不允许 breakaway 的 job 里时这里会失败：不影响功能。 */
            AssignProcessToJobObject(_job, process);
        }
        catch (Exception ex)
        {
            Diag("job object unavailable: " + ex.Message);
            if (_job != IntPtr.Zero)
            {
                CloseHandle(_job);
                _job = IntPtr.Zero;
            }
        }
    }

    /* ============================ 命令行拼装 ============================ */

    /* shell 和它的参数永远来自 argv / JSON 数组，这里只做 Windows 命令行引用
       （MSVCRT 规则），绝不做“拼接字符串再执行”。 */
    private static string BuildCommandLine(Options options)
    {
        StringBuilder sb = new StringBuilder();
        sb.Append(QuoteArgument(options.Shell));
        for (int i = 0; i < options.ShellArgs.Length; i++)
        {
            sb.Append(' ').Append(QuoteArgument(options.ShellArgs[i]));
        }
        return sb.ToString();
    }

    private static string QuoteArgument(string value)
    {
        if (value == null) return "\"\"";
        bool needsQuotes = value.Length == 0;
        for (int i = 0; i < value.Length && !needsQuotes; i++)
        {
            char c = value[i];
            if (c == ' ' || c == '\t' || c == '\n' || c == '\v' || c == '"') needsQuotes = true;
        }
        if (!needsQuotes) return value;

        StringBuilder sb = new StringBuilder();
        sb.Append('"');
        int backslashes = 0;
        for (int i = 0; i < value.Length; i++)
        {
            char c = value[i];
            if (c == '\\')
            {
                backslashes++;
                continue;
            }
            if (c == '"')
            {
                sb.Append('\\', backslashes * 2 + 1);
                sb.Append('"');
                backslashes = 0;
                continue;
            }
            if (backslashes > 0)
            {
                sb.Append('\\', backslashes);
                backslashes = 0;
            }
            sb.Append(c);
        }
        if (backslashes > 0) sb.Append('\\', backslashes * 2);
        sb.Append('"');
        return sb.ToString();
    }

    /* ============================ PTY -> host ============================ */

    /* 阻塞 ReadFile 循环：不轮询、不 sleep；管道满了自然背压到 ConPTY。 */
    private static void OutputLoop()
    {
        byte[] buffer = new byte[OutputChunk];
        try
        {
            while (true)
            {
                int read;
                if (!ReadAt(_ptyOutputRead, buffer, 0, buffer.Length, out read) || read <= 0)
                {
                    break; /* 管道关闭 / 伪控制台已销毁 */
                }
                WriteFrame((byte)'D', buffer, 0, read);
            }
        }
        catch (Exception ex)
        {
            Diag("output loop failed: " + ex.Message);
        }
        finally
        {
            OutputDone.Set();
        }
    }

    /* ============================ host -> PTY ============================ */

    private static void InputLoop()
    {
        byte[] header = new byte[5];
        try
        {
            while (true)
            {
                if (!ReadExact(_stdin, header, 0, 1)) break;   /* host 关闭 stdin */
                if (!ReadExact(_stdin, header, 1, 4)) break;
                uint length = BitConverter.ToUInt32(header, 1);
                if (length > MaxFrameBytes)
                {
                    Diag("frame too large: " + length.ToString(CultureInfo.InvariantCulture) + " bytes");
                    ExitWithProtocolError();
                    return;
                }
                byte[] payload = length == 0 ? new byte[0] : new byte[length];
                if (length > 0 && !ReadExact(_stdin, payload, 0, (int)length)) break;

                switch ((char)header[0])
                {
                    case 'D':
                        WriteToPty(payload);
                        break;
                    case 'R':
                        if (payload.Length >= 4)
                        {
                            ResizePty(BitConverter.ToUInt16(payload, 0), BitConverter.ToUInt16(payload, 2));
                        }
                        break;
                    case 'X':
                        TerminateFromHost(payload.Length >= 4 ? BitConverter.ToUInt32(payload, 0) : 0);
                        return;
                    default:
                        /* 未知帧类型：跳过 payload，保持前向兼容。 */
                        Diag("ignoring unknown frame type 0x" + ((int)header[0]).ToString("X2", CultureInfo.InvariantCulture));
                        break;
                }
            }
        }
        catch (Exception ex)
        {
            Diag("input loop failed: " + ex.Message);
        }
        /* EOF / 协议错误 / 'X'：不管哪条路，shell 进程树都必须消失。 */
        KillTree();
    }

    private static void WriteToPty(byte[] payload)
    {
        if (_ptyInputWrite == IntPtr.Zero) return;
        int offset = 0;
        while (offset < payload.Length)
        {
            int chunk = payload.Length - offset;
            if (chunk > PtyWriteChunk) chunk = PtyWriteChunk;
            int written;
            if (!WriteAt(_ptyInputWrite, payload, offset, chunk, out written) || written <= 0)
            {
                return; /* shell 已退出 / 管道关闭：键盘输入丢掉即可 */
            }
            offset += written;
        }
    }

    private static void ResizePty(ushort cols, ushort rows)
    {
        if (_pseudoConsole == IntPtr.Zero || cols == 0 || rows == 0) return;
        /* ResizePseudoConsole 是 Win10 1903+ 的入口；老系统上没有就安静忽略。 */
        ResizePseudoConsoleFn resize = ResizeEntry();
        if (resize == null) return;
        try
        {
            Coord size = new Coord();
            size.X = (short)cols;
            size.Y = (short)rows;
            resize(_pseudoConsole, size);
        }
        catch (Exception ex)
        {
            Diag("ResizePseudoConsole failed: " + ex.Message);
        }
    }

    private static ResizePseudoConsoleFn ResizeEntry()
    {
        if (_resizeResolved) return _resize;
        _resizeResolved = true;
        try
        {
            IntPtr kernel32 = GetModuleHandleW("kernel32.dll");
            if (kernel32 == IntPtr.Zero) return null;
            IntPtr address = GetProcAddress(kernel32, "ResizePseudoConsole");
            if (address == IntPtr.Zero) return null;
            _resize = (ResizePseudoConsoleFn)Marshal.GetDelegateForFunctionPointer(address, typeof(ResizePseudoConsoleFn));
        }
        catch (Exception)
        {
            _resize = null;
        }
        return _resize;
    }

    private static void TerminateFromHost(uint pid)
    {
        if (pid == 0 || (int)pid == _childPid)
        {
            KillTree();
            return;
        }
        IntPtr target = IntPtr.Zero;
        try
        {
            target = OpenProcess(ProcessTerminate, false, (int)pid);
            if (target != IntPtr.Zero) TerminateProcess(target, 1);
        }
        catch (Exception ex)
        {
            Diag("cannot terminate pid " + pid.ToString(CultureInfo.InvariantCulture) + ": " + ex.Message);
        }
        finally
        {
            if (target != IntPtr.Zero) CloseHandle(target);
        }
    }

    private static void KillTree()
    {
        try
        {
            if (_job != IntPtr.Zero)
            {
                TerminateJobObject(_job, 1);
                return;
            }
            if (_child != IntPtr.Zero) TerminateProcess(_child, 1);
        }
        catch (Exception ex)
        {
            Diag("cannot terminate the shell: " + ex.Message);
        }
    }

    /* ============================ stdout 帧写出 ============================ */

    /* 两个线程都会写 stdout：整个帧（5B 头 + payload）在同一把锁里写完，绝不交错。 */
    private static void WriteFrame(byte type, byte[] payload, int offset, int length)
    {
        lock (StdoutLock)
        {
            if (_closing) return;   /* 'X' 之后不再有 'D' */
            byte[] header = new byte[5];
            header[0] = type;
            header[1] = (byte)(length & 0xFF);
            header[2] = (byte)((length >> 8) & 0xFF);
            header[3] = (byte)((length >> 16) & 0xFF);
            header[4] = (byte)((length >> 24) & 0xFF);
            WriteAll(_stdout, header, 0, header.Length);
            if (length > 0) WriteAll(_stdout, payload, offset, length);
        }
    }

    private static void WriteExitFrame(int exitCode)
    {
        lock (StdoutLock)
        {
            if (_closing) return;
            _closing = true;   /* 之后 WriteFrame 一律丢弃：'X' 一定是最后一帧 */
            byte[] payload = BitConverter.GetBytes(exitCode);
            byte[] header = new byte[5];
            header[0] = (byte)'X';
            header[1] = (byte)payload.Length;
            header[2] = 0;
            header[3] = 0;
            header[4] = 0;
            WriteAll(_stdout, header, 0, header.Length);
            WriteAll(_stdout, payload, 0, payload.Length);
        }
    }

    private static void WriteAll(IntPtr handle, byte[] buffer, int offset, int length)
    {
        if (handle == IntPtr.Zero) return;
        int writtenTotal = 0;
        while (writtenTotal < length)
        {
            int written;
            if (!WriteAt(handle, buffer, offset + writtenTotal, length - writtenTotal, out written) || written <= 0)
            {
                return; /* host 关了 stdout：没有接收方，丢弃即可 */
            }
            writtenTotal += written;
        }
    }

    /* ============================ 句柄读写（数组 + 偏移） ============================ */

    /* P/Invoke 的 byte[] 形参只能从下标 0 开始，这里统一用“固定 + 指针偏移”，
       避免为每次读写复制一份临时数组。 */
    private static bool ReadAt(IntPtr handle, byte[] buffer, int offset, int length, out int read)
    {
        read = 0;
        if (handle == IntPtr.Zero || length <= 0) return false;
        GCHandle pin = GCHandle.Alloc(buffer, GCHandleType.Pinned);
        try
        {
            IntPtr address = new IntPtr(pin.AddrOfPinnedObject().ToInt64() + offset);
            return ReadFile(handle, address, length, out read, IntPtr.Zero);
        }
        finally
        {
            pin.Free();
        }
    }

    /* 帧头和 payload 都必须读满：管道上的 ReadFile 允许半读。 */
    private static bool ReadExact(IntPtr handle, byte[] buffer, int offset, int length)
    {
        int total = 0;
        while (total < length)
        {
            int read;
            if (!ReadAt(handle, buffer, offset + total, length - total, out read)) return false;
            if (read <= 0) return false;   /* EOF */
            total += read;
        }
        return true;
    }

    private static bool WriteAt(IntPtr handle, byte[] buffer, int offset, int length, out int written)
    {
        written = 0;
        if (handle == IntPtr.Zero || length <= 0) return false;
        GCHandle pin = GCHandle.Alloc(buffer, GCHandleType.Pinned);
        try
        {
            IntPtr address = new IntPtr(pin.AddrOfPinnedObject().ToInt64() + offset);
            return WriteFile(handle, address, length, out written, IntPtr.Zero);
        }
        finally
        {
            pin.Free();
        }
    }

    /* ============================ 诊断 / 句柄 ============================ */

    private static void Diag(string message)
    {
        try
        {
            byte[] bytes = Encoding.UTF8.GetBytes("WorkbayPty: " + message + "\r\n");
            WriteAll(_stderr, bytes, 0, bytes.Length);
        }
        catch
        {
            /* 诊断写不出去绝不能影响主流程 */
        }
    }

    private static void ExitWithProtocolError()
    {
        KillTree();
        Environment.Exit(ExitUsage);
    }

    private static void ClearInherit(IntPtr handle)
    {
        if (handle == IntPtr.Zero || handle == new IntPtr(-1)) return;
        SetHandleInformation(handle, HandleFlagInherit, 0);
    }

    private static void ClosePseudoConsoleHandle()
    {
        if (_pseudoConsole == IntPtr.Zero) return;
        try
        {
            ClosePseudoConsole(_pseudoConsole);
        }
        catch (Exception)
        {
            /* 没有这个入口时忽略 */
        }
        _pseudoConsole = IntPtr.Zero;
    }

    private static string LastErrorText()
    {
        return "Win32 error " + Marshal.GetLastWin32Error().ToString(CultureInfo.InvariantCulture);
    }

    /* ============================ Win32 结构 / 导入 ============================ */

    [StructLayout(LayoutKind.Sequential)]
    internal struct Coord
    {
        public short X;
        public short Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct SecurityAttributes
    {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        public int bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct StartupInfo
    {
        public int cb;
        public IntPtr lpReserved;
        public IntPtr lpDesktop;
        public IntPtr lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct StartupInfoEx
    {
        public StartupInfo StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct ProcessInformation
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct JobObjectBasicLimitInformation
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
    internal struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct JobObjectExtendedLimitInformation
    {
        public JobObjectBasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    private delegate int ResizePseudoConsoleFn(IntPtr pseudoConsole, Coord size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int which);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CreatePipe(out IntPtr readPipe, out IntPtr writePipe,
        ref SecurityAttributes attributes, int size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ReadFile(IntPtr handle, IntPtr buffer, int toRead, out int read, IntPtr overlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool WriteFile(IntPtr handle, IntPtr buffer, int toWrite, out int written, IntPtr overlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern int CreatePseudoConsole(Coord size, IntPtr input, IntPtr output, uint flags, out IntPtr pseudoConsole);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern void ClosePseudoConsole(IntPtr pseudoConsole);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(IntPtr list, int attributeCount, int flags, ref IntPtr size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute,
        IntPtr value, IntPtr size, IntPtr previousValue, IntPtr returnSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern void DeleteProcThreadAttributeList(IntPtr list);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessW(string applicationName, StringBuilder commandLine,
        IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint creationFlags,
        IntPtr environment, string currentDirectory, ref StartupInfoEx startupInfo,
        out ProcessInformation processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr GetModuleHandleW(string moduleName);

    [DllImport("kernel32.dll", CharSet = CharSet.Ansi, SetLastError = true)]
    private static extern IntPtr GetProcAddress(IntPtr module, string name);

    /* ============================ 参数解析 ============================ */

    private sealed class Options
    {
        public string Shell = "";
        public string[] ShellArgs = new string[0];
        public string Cwd = "";
        public short Cols = 80;
        public short Rows = 24;

        public static bool TryParse(string[] argv, out Options options, out string error)
        {
            options = new Options();
            error = null;
            if (argv == null || argv.Length == 0)
            {
                error = "no arguments";
                return false;
            }

            HashSet<string> seen = new HashSet<string>(StringComparer.Ordinal);
            string shellArgsBase64 = null;
            string colsText = null;
            string rowsText = null;

            int i = 0;
            while (i < argv.Length)
            {
                string key = argv[i];
                if (key != "--shell" && key != "--shell-args" && key != "--cwd" && key != "--cols" && key != "--rows")
                {
                    error = "unknown argument '" + key + "'";
                    return false;
                }
                if (i + 1 >= argv.Length)
                {
                    error = "missing value for " + key;
                    return false;
                }
                if (!seen.Add(key))
                {
                    error = "duplicate argument " + key;
                    return false;
                }
                string value = argv[i + 1];
                i += 2;

                if (key == "--shell") options.Shell = value;
                else if (key == "--shell-args") shellArgsBase64 = value;
                else if (key == "--cwd") options.Cwd = value;
                else if (key == "--cols") colsText = value;
                else rowsText = value;
            }

            if (options.Shell.Length == 0)
            {
                error = "--shell is required";
                return false;
            }
            if (!IsAbsolutePath(options.Shell))
            {
                error = "--shell must be an absolute path";
                return false;
            }
            if (options.Cwd.Length == 0)
            {
                error = "--cwd is required";
                return false;
            }
            if (!IsAbsolutePath(options.Cwd))
            {
                error = "--cwd must be an absolute path";
                return false;
            }
            try
            {
                if (!System.IO.Directory.Exists(options.Cwd))
                {
                    error = "--cwd is not an existing directory";
                    return false;
                }
            }
            catch (Exception ex)
            {
                error = "--cwd is not readable: " + ex.Message;
                return false;
            }

            short cols;
            short rows;
            if (!TryParseSize(colsText, 1, 600, out cols))
            {
                error = "--cols must be an integer between 1 and 600";
                return false;
            }
            if (!TryParseSize(rowsText, 1, 600, out rows))
            {
                error = "--rows must be an integer between 1 and 600";
                return false;
            }
            options.Cols = cols;
            options.Rows = rows;

            if (shellArgsBase64 == null)
            {
                error = "--shell-args is required";
                return false;
            }
            string[] shellArgs;
            string jsonError;
            if (!TryDecodeShellArgs(shellArgsBase64, out shellArgs, out jsonError))
            {
                error = "--shell-args " + jsonError;
                return false;
            }
            options.ShellArgs = shellArgs;
            return true;
        }

        private static bool TryParseSize(string text, int min, int max, out short value)
        {
            value = 0;
            if (text == null) return false;
            int parsed;
            if (!int.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out parsed)) return false;
            if (parsed < min || parsed > max) return false;
            value = (short)parsed;
            return true;
        }

        private static bool IsAbsolutePath(string value)
        {
            try
            {
                return System.IO.Path.IsPathRooted(value);
            }
            catch
            {
                return false;
            }
        }
    }

    /* --shell-args = base64(UTF-8(JSON 字符串数组))。只接受字符串数组，别的形状
       （对象、数字、嵌套数组）一律拒绝，避免把任意命令行偷渡进来。 */
    private static bool TryDecodeShellArgs(string base64, out string[] values, out string error)
    {
        values = new string[0];
        error = null;
        byte[] bytes;
        try
        {
            bytes = Convert.FromBase64String(base64);
        }
        catch (FormatException)
        {
            error = "is not valid base64";
            return false;
        }

        string json;
        try
        {
            json = new UTF8Encoding(false, true).GetString(bytes);
        }
        catch (Exception)
        {
            error = "is not valid UTF-8";
            return false;
        }
        return TryParseJsonStringArray(json, out values, out error);
    }

    private static bool TryParseJsonStringArray(string json, out string[] values, out string error)
    {
        values = new string[0];
        error = null;
        List<string> items = new List<string>();
        int i = SkipWhitespace(json, 0);
        if (i >= json.Length || json[i] != '[')
        {
            error = "is not a JSON array";
            return false;
        }
        i = SkipWhitespace(json, i + 1);
        if (i < json.Length && json[i] == ']')
        {
            values = new string[0];
            if (SkipWhitespace(json, i + 1) != json.Length)
            {
                error = "has trailing characters after the JSON array";
                return false;
            }
            return true;
        }
        while (true)
        {
            i = SkipWhitespace(json, i);
            if (i >= json.Length || json[i] != '"')
            {
                error = "is not a JSON array of strings";
                return false;
            }
            int next;
            string item;
            if (!TryParseJsonString(json, i, out item, out next))
            {
                error = "has an unterminated or invalid string";
                return false;
            }
            items.Add(item);
            i = SkipWhitespace(json, next);
            if (i >= json.Length)
            {
                error = "is an unterminated JSON array";
                return false;
            }
            if (json[i] == ',')
            {
                i += 1;
                continue;
            }
            if (json[i] == ']')
            {
                i = SkipWhitespace(json, i + 1);
                if (i != json.Length)
                {
                    error = "has trailing characters after the JSON array";
                    return false;
                }
                values = items.ToArray();
                return true;
            }
            error = "is not a JSON array of strings";
            return false;
        }
    }

    private static int SkipWhitespace(string text, int index)
    {
        while (index < text.Length)
        {
            char c = text[index];
            if (c == ' ' || c == '\t' || c == '\r' || c == '\n') index += 1;
            else break;
        }
        return index;
    }

    private static bool TryParseJsonString(string text, int start, out string value, out int next)
    {
        value = null;
        next = start;
        if (start >= text.Length || text[start] != '"') return false;
        StringBuilder sb = new StringBuilder();
        int i = start + 1;
        while (i < text.Length)
        {
            char c = text[i];
            if (c == '"')
            {
                value = sb.ToString();
                next = i + 1;
                return true;
            }
            if (c != '\\')
            {
                sb.Append(c);
                i += 1;
                continue;
            }
            i += 1;
            if (i >= text.Length) return false;
            char escape = text[i];
            i += 1;
            switch (escape)
            {
                case '"': sb.Append('"'); break;
                case '\\': sb.Append('\\'); break;
                case '/': sb.Append('/'); break;
                case 'b': sb.Append('\b'); break;
                case 'f': sb.Append('\f'); break;
                case 'n': sb.Append('\n'); break;
                case 'r': sb.Append('\r'); break;
                case 't': sb.Append('\t'); break;
                case 'u':
                    if (i + 4 > text.Length) return false;
                    int code;
                    if (!int.TryParse(text.Substring(i, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out code)) return false;
                    sb.Append((char)code);
                    i += 4;
                    break;
                default:
                    return false;
            }
        }
        return false;
    }
}
