# WorkbayPty.exe — Windows ConPTY helper

> 终端插件的 PTY 提供者：Node 侧不能加载原生模块（Electron ABI、终端用户没有编译工具链），
> 所以真 PTY 由一个独立的 .NET Framework 小程序提供。host 半侧只做管道桥接。
>
> The terminal bundle's PTY provider. Node cannot load native modules inside DSH's
> Electron host, so a small standalone .NET Framework process owns the pseudoconsole
> and speaks a fixed binary frame protocol over stdin/stdout.

契约见 [`docs/terminal-pty.md`](../../../docs/terminal-pty.md) §1（冻结）。本目录只有两个文件：
`WorkbayPty.cs`（源码，与二进制一起入库）和 `WorkbayPty.exe`（编译产物，19.5 KiB）。

## 重新编译（in-box csc，无需 SDK）

```powershell
& 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe' /nologo /optimize+ /target:exe `
  /out:packages\terminal\helper\WorkbayPty.exe packages\terminal\helper\WorkbayPty.cs
```

源码限制在 **C# 5**（in-box 编译器不支持更新的语法）：不能用字符串插值、模式匹配、
元组、局部函数、`?.`。目标框架是 .NET Framework 4.8，零第三方依赖，只用 `kernel32.dll`。
编译前先确认没有 helper 正在运行，否则 csc 会报 `CS0016: 无法写入输出文件`（文件被占用）。

## 启动参数

```
WorkbayPty.exe --shell <exe 绝对路径> --shell-args <base64(UTF-8(JSON 字符串数组))> \
               --cwd <已存在的目录> --cols <n> --rows <n>
```

- 五个参数全部必填，全部来自 host 的固定模板，不接受用户拼接的命令行。
- `--cols/--rows` 取值 1–600，直接作为 `CreatePseudoConsole` 的初始尺寸（PTY 创建时就有尺寸，
  不需要"先建 0×0 再 resize"）。
- 参数不合法 → 退出码 **2** + 一行 stderr 诊断（stdout 保持只出帧）。

退出码：`0` 正常；`2` 参数/帧流非法；`3` PTY 创建失败；`4` 子进程创建失败。
stderr 只写诊断文本（host 只在启动失败时读），stdout 只写帧。

## 帧协议

```
+------+----------------+------------------+
| type | uint32 LE 长度 | payload          |
| 1B   | 4B             | N                |
+------+----------------+------------------+
```

| 方向 | type | payload | 含义 |
|---|---|---|---|
| host → helper | `D` | 原始字节 | 写进 PTY 输入（回车是 `\r`，Ctrl+C 是 `\x03`） |
| host → helper | `R` | uint16 cols + uint16 rows | `ResizePseudoConsole`（老系统没有该入口则忽略） |
| host → helper | `X` | uint32 pid（0=整棵树） | 终止 shell 进程树 |
| helper → host | `D` | 原始字节 | PTY 输出（UTF-8，可能从字符中间切开） |
| helper → host | `X` | int32 exit code | shell 已退出，helper 随后以 0 退出 |

- 帧头和 payload 都必须读满（管道允许半读）；未知帧类型跳过 payload，保持前向兼容。
- **`X` 一定是最后一帧**：shell 退出后 helper 先把管道里剩余的 PTY 输出读完（把最后一段
  `D` 发完）才写 `X`，host 不会出现"先收到退出码、后收到尾巴"的乱序。
- 两个线程会同时写 stdout（输出线程 + 主线程），整帧在同一把锁里写完，绝不交错。
- `X` 之后不再接受/写出 `D`。

## 内部行为（host 实现者关心的事实）

- **stdin EOF = 收尸**：host 关闭 helper.stdin → helper 用 `TerminateJobObject` 杀掉整棵树并退出
  （也会照常发一个 `X`，host 可以忽略）。子进程放在 Job Object 里，`KILL_ON_JOB_CLOSE` 保证
  即使 helper 被强杀，`-NoExit` shell 也不会留在 `tasklist` 里。
- **不要继承 host 的 stdin/stdout**：helper 把 owner 侧的三个标准句柄和自己的 PTY 管道端都
  改成不可继承，否则 shell 会拿到帧管道。
- 输出由阻塞 `ReadFile` 拉取，输入由阻塞 `ReadFile` 推入，**没有 sleep 轮询**；管道满时自然
  背压到 ConPTY。PTY 的两个 conpty 端保持打开直到 `ClosePseudoConsole`（提前关闭会让
  伪控制台看到半关的管道）。
- 不做任何转码，也不注入 `chcp 65001`、`[Console]::OutputEncoding` 之类的 shell 字符串：
  ConPTY 本身就是 UTF-8 字节流。

## 两个实测踩到的坑（改动这段代码前请先读）

1. **`STARTF_USESTDHANDLES` + 三个 NULL 句柄是必须的。**
   不设置时 `CreateProcess` 会让 shell 继承 helper 的标准句柄——helper 的 stdout 是帧管道，
   结果是 shell 输出漏进协议流；若句柄不可继承则变成无效句柄，shell 立刻退出、PTY 里只剩
   conhost 的初始化序列（表现为"能启动、输入没反应、输出是空的"）。显式声明
   `STARTF_USESTDHANDLES` 且 `hStdInput/hStdOutput/hStdError = NULL` 后，控制台子系统才会
   把子进程接到伪控制台上。诊断方法：在 shell 里 `echo x > CONOUT$`，字节应该出现在 `D` 帧里。
2. **收尾不要在主线程 `CloseHandle` 输出读端。**
   读线程可能正阻塞在这根管道的 `ReadFile` 上，`CloseHandle` 会一直等到那次读完成——实测表现
   是 `X` 帧已经发出、helper 却不退出。正确顺序：先给 ConPTY ~150ms 把最后一段输出落进管道，
   `ClosePseudoConsole` + 关掉 helper 自己那份输出**写**端（否则读端永远等不到 EOF），等读线程
   读到 EOF（最多 2s），发 `X`，然后 `Environment.Exit(0)` 让内核回收其余句柄。

## 冒烟测试

```powershell
cd packages/terminal
node --test tests/pty-helper.test.mjs
```

7 个用例：echo 回显、UTF-8 原字节往返、ANSI 透传、`R` 帧不中断流、`X` 帧退出码且排在最后、
stdin EOF 后 shell 进程消失（按 PID 断言）、非法参数退出码 2。约 7–8 秒。
测试只用 `helper/WorkbayPty.exe`，不经过 host 代码；非 Windows 平台自动 skip。
