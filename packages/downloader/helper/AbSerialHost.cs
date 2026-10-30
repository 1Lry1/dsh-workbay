using System;
using System.Collections.Generic;
using System.IO.Ports;
using System.Text;
using System.Threading;

// AbSerialHost —— 串口 helper（64 位 .NET，零第三方依赖）
//
// 为什么不用 Downloader 的 DeviceUart.dll：
//   那套 DLL 是 x86 原生的，64 位 Node 加载不了（WinError 193），
//   必须再套一层 32 位桥。而 .NET Framework 自带的 System.IO.Ports.SerialPort
//   就是 Win32 串口 API 的封装，64 位可用，还能直接读 DCB、支持任意波特率。
//   实测对比见 deep-analysis/serial-host-verify.md。
//
// stdio 协议（每行一个 JSON）：
//   收：{"id":1,"op":"list"}
//   收：{"id":2,"op":"open","port":"COM11","baud":1500000}
//   收：{"id":3,"op":"close"}
//   收：{"id":4,"op":"write","hex":"55AA0D0A"}   或 {"op":"write","text":"..."}
//   收：{"id":5,"op":"flush"}
//   收：{"id":6,"op":"quit"}
//   发：{"id":1,"ok":true,"ports":[{"name":"COM11","desc":"CP210x","vid":"10C4","pid":"EA60","hwid":"..."}]}
//   发：{"ev":"data","hex":"...","text":"..."}     ← 串口来数据（异步推）
//   发：{"ev":"err","msg":"..."}

internal static class Program
{
    private static SerialPort _port;
    private static readonly object _lock = new object();
    private static volatile bool _running = true;

    private static int Main(string[] argv)
    {
        try { Console.OutputEncoding = new UTF8Encoding(false); } catch { }

        var reader = new Thread(ReadLoop) { IsBackground = true };
        var portRx = new Thread(PortReadLoop) { IsBackground = true };

        string line;
        while (_running && (line = Console.In.ReadLine()) != null)
        {
            line = line.Trim();
            if (line.Length == 0) continue;
            try
            {
                Handle(line);
            }
            catch (Exception ex)
            {
                Emit("{\"ev\":\"err\",\"msg\":" + J(ex.Message) + "}");
            }
        }
        return 0;
    }

    private static void ReadLoop() { /* 占位：主线程自己读 stdin */ }

    private static void Handle(string line)
    {
        var id = ExtractId(line);
        var op = ExtractStr(line, "op");
        switch (op)
        {
            case "list":
                var sb = new StringBuilder();
                sb.Append("{\"ok\":true");
                if (id != null) sb.Append(",\"id\":").Append(id);
                sb.Append(",\"ports\":[");
                var first = true;
                foreach (var p in SerialPort.GetPortNames())
                {
                    // 取描述：用注册表会慢，这里给 name + 尝试从 WMI 拿（失败不影响）
                    if (!first) sb.Append(',');
                    first = false;
                    sb.Append("{\"name\":").Append(J(p)).Append(",\"desc\":").Append(J(Describe(p))).Append('}');
                }
                sb.Append("]}");
                Console.WriteLine(sb.ToString());
                break;

            case "open":
                lock (_lock)
                {
                    ClosePort();
                    var name = ExtractStr(line, "port");
                    var baud = ExtractInt(line, "baud", 1500000);
                    var p = new SerialPort(name, baud, Parity.None, 8, StopBits.One);
                    p.ReadTimeout = 200;
                    p.WriteTimeout = 1500;
                    // 高波特率关键：缓冲区调大，避免默认可笑的 4096 溢出
                    p.ReadBufferSize = 1 << 20;
                    p.WriteBufferSize = 1 << 16;
                    p.Open();
                    _port = p;
                    var th = new Thread(PortReadLoop) { IsBackground = true };
                    th.Start();
                }
                Reply(id, true, "\"baud\":" + ExtractInt(line, "baud", 1500000));
                break;

            case "close":
                lock (_lock) { ClosePort(); }
                Reply(id, true, null);
                break;

            case "write":
                {
                    byte[] data = null;
                    var hex = ExtractStr(line, "hex");
                    var text = ExtractStr(line, "text");
                    if (hex != null) data = ParseHex(hex);
                    else if (text != null) data = Encoding.GetEncoding("GB18030").GetBytes(Unescape(text));
                    if (data == null) { Reply(id, false, "\"msg\":\"need hex or text\""); break; }
                    lock (_lock)
                    {
                        if (_port == null || !_port.IsOpen) { Reply(id, false, "\"msg\":\"not open\""); break; }
                        _port.Write(data, 0, data.Length);
                    }
                    Reply(id, true, "\"bytes\":" + data.Length);
                }
                break;

            case "flush":
                lock (_lock)
                {
                    if (_port != null && _port.IsOpen) { _port.DiscardInBuffer(); _port.DiscardOutBuffer(); }
                }
                Reply(id, true, null);
                break;

            case "quit":
                lock (_lock) { ClosePort(); }
                Reply(id, true, null);
                _running = false;
                break;

            default:
                Reply(id, false, "\"msg\":" + J("unknown op " + op));
                break;
        }
    }

    private static void PortReadLoop()
    {
        var buf = new byte[65536];
        while (true)
        {
            SerialPort p;
            lock (_lock) { p = _port; }
            if (p == null || !p.IsOpen) return;
            try
            {
                int n = p.Read(buf, 0, buf.Length);
                if (n > 0)
                {
                    var hex = new StringBuilder(n * 2);
                    for (int i = 0; i < n; i++) hex.Append(buf[i].ToString("X2"));
                    string txt;
                    try { txt = Encoding.GetEncoding("GB18030").GetString(buf, 0, n); }
                    catch { txt = Encoding.ASCII.GetString(buf, 0, n); }
                    Console.WriteLine("{\"ev\":\"data\",\"n\":" + n + ",\"hex\":\"" + hex + "\",\"text\":" + J(txt) + "}");
                }
            }
            catch (TimeoutException) { /* 正常 */ }
            catch (Exception)
            {
                lock (_lock) { p = _port; }
                if (p != null && p.IsOpen) continue;
                return;
            }
        }
    }

    private static void ClosePort()
    {
        try
        {
            if (_port != null)
            {
                if (_port.IsOpen) _port.Close();
                _port.Dispose();
            }
        }
        catch { }
        finally { _port = null; }
    }

    private static void Reply(string id, bool ok, string extra)
    {
        var sb = new StringBuilder("{\"ok\":").Append(ok ? "true" : "false");
        if (id != null) sb.Append(",\"id\":").Append(id);
        if (extra != null) sb.Append(',').Append(extra);
        sb.Append('}');
        Console.WriteLine(sb.ToString());
    }

    private static void Emit(string json) { Console.WriteLine(json); }

    private static readonly System.Collections.Generic.Dictionary<string, string> _descCache
        = new System.Collections.Generic.Dictionary<string, string>();

    // ★ 不用 WMI：实测 Win32_PnPEntity 查一次要 ~1.4 秒，
    //   会把整个串口列表请求拖到几秒，连带 open/close 也变慢。
    //   改读注册表 HARDWARE\DEVICEMAP\SERIALCOMM，毫秒级，并缓存。
    private static string Describe(string port)
    {
        lock (_descCache)
        {
            string cached;
            if (_descCache.TryGetValue(port, out cached)) return cached;
        }
        string result = "";
        try
        {
            using (var key = Microsoft.Win32.Registry.LocalMachine.OpenSubKey(
                @"HARDWARE\DEVICEMAP\SERIALCOMM"))
            {
                if (key != null)
                {
                    foreach (var vn in key.GetValueNames())
                    {
                        var val = key.GetValue(vn) as string;
                        if (string.Equals(val, port, StringComparison.OrdinalIgnoreCase))
                        {
                            // vn 就是设备描述（如 "\Device\Silabser0"）
                            result = FriendlyName(vn);
                            break;
                        }
                    }
                }
            }
        }
        catch { }
        lock (_descCache) { _descCache[port] = result; }
        return result;
    }

    // 从 \Device\Silabser0 这类路径推一个可读名字；
    // 拿不到就用路径末段，不再访问慢接口。
    private static string FriendlyName(string devicePath)
    {
        if (string.IsNullOrEmpty(devicePath)) return "";
        var name = devicePath.Replace(@"\Device\", "").Trim();
        if (name.StartsWith("Silabser", StringComparison.OrdinalIgnoreCase)) return "Silicon Labs CP210x USB to UART Bridge";
        if (name.StartsWith("CH34", StringComparison.OrdinalIgnoreCase)) return "WCH CH34x USB to UART";
        if (name.StartsWith("FTSER", StringComparison.OrdinalIgnoreCase) || name.StartsWith("VCP", StringComparison.OrdinalIgnoreCase))
            return "FTDI USB to UART";
        if (name.StartsWith("BthModem", StringComparison.OrdinalIgnoreCase)) return "\u84dd\u7259\u4e32\u53e3 (BthModem)";
        return name;
    }

    // ---- 极简 JSON 取值（不引依赖，够用）----
    private static string ExtractId(string s)
    {
        var v = ExtractRaw(s, "id");
        return v;
    }
    private static string ExtractStr(string s, string key)
    {
        var v = ExtractRaw(s, key);
        if (v == null) return null;
        if (v.StartsWith("\"") && v.EndsWith("\"") && v.Length >= 2) return Unescape(v.Substring(1, v.Length - 2));
        return v;
    }
    private static int ExtractInt(string s, string key, int dflt)
    {
        var v = ExtractRaw(s, key);
        int n; return int.TryParse(v, out n) ? n : dflt;
    }
    private static string ExtractRaw(string s, string key)
    {
        var pat = "\"" + key + "\"";
        var i = s.IndexOf(pat, StringComparison.Ordinal);
        if (i < 0) return null;
        i += pat.Length;
        while (i < s.Length && (s[i] == ' ' || s[i] == ':')) i++;
        if (i >= s.Length) return null;
        if (s[i] == '"')
        {
            var j = i + 1;
            var sb = new StringBuilder("\"");
            while (j < s.Length)
            {
                if (s[j] == '\\' && j + 1 < s.Length) { sb.Append(s[j]).Append(s[j + 1]); j += 2; continue; }
                if (s[j] == '"') { sb.Append('"'); break; }
                sb.Append(s[j]); j++;
            }
            return sb.ToString();
        }
        else
        {
            var j = i;
            while (j < s.Length && s[j] != ',' && s[j] != '}') j++;
            return s.Substring(i, j - i).Trim();
        }
    }

    private static byte[] ParseHex(string h)
    {
        h = h.Replace(" ", "").Replace("-", "");
        if (h.Length % 2 != 0) throw new ArgumentException("hex length must be even");
        var r = new byte[h.Length / 2];
        for (int i = 0; i < r.Length; i++) r[i] = Convert.ToByte(h.Substring(i * 2, 2), 16);
        return r;
    }

    private static string Unescape(string s)
    {
        var sb = new StringBuilder();
        for (int i = 0; i < s.Length; i++)
        {
            if (s[i] == '\\' && i + 1 < s.Length)
            {
                var c = s[++i];
                if (c == 'n') sb.Append('\n');
                else if (c == 'r') sb.Append('\r');
                else if (c == 't') sb.Append('\t');
                else if (c == '\\') sb.Append('\\');
                else if (c == '"') sb.Append('"');
                else sb.Append(c);
            }
            else sb.Append(s[i]);
        }
        return sb.ToString();
    }

    private static string J(string s)
    {
        if (s == null) return "null";
        var sb = new StringBuilder("\"");
        foreach (var c in s)
        {
            if (c == '"' || c == '\\') { sb.Append('\\').Append(c); }
            else if (c == '\r') sb.Append("\\r");
            else if (c == '\n') sb.Append("\\n");
            else if (c == '\t') sb.Append("\\t");
            else if (c < 0x20) sb.Append('?');
            else sb.Append(c);
        }
        return sb.Append('"').ToString();
    }
}
