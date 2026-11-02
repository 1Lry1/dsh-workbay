# dsh-downloader —— Downloader

在「**工作台**」（`dsh-workbay-dock`）里的一个页面，用于**蓝牙芯片烧录 + 串口日志**。打开任意会话 → 左侧栏的 **工作台** 入口 → 面板里的 **Downloader** 页签。不使用 `dsh-better-sidebar`。

驱动官方 `Downloader.exe` 的 IPC 接口完成烧录，不模拟鼠标键盘；同时自带 1.5 Mbps 串口日志。串口与烧录自动互斥切换，烧完自动恢复串口并保持板卡启动日志完整。

```
● 就绪  COM22  AA:BB:CC:DD:EE:FF    串口 [COM22 — CP210x] ↻ [1500000]
固件文件  ...\Output\bin\app.dcf    固件校验  00001D7C_0BCF9C38
设备校验  1DA83416                  串口状态  ● COM22 @1500000
[──────── 进度 ────────]
[连接 Downloader] [读取信息] [开始烧录] [打开串口] [断开]
──────────────── 日志 ────────────────
17:21:04  S  ✓ 烧录完成（MAC AA:BB:CC:DD:EE:FF）
17:21:04  S  已自动恢复串口 COM22 @1500000（空窗 8ms）
17:21:06  B  Hello Platform: 0
17:21:06  B  sram total = 0x3FC00, used = 0x218CC, remain = 0x1E4F0
```

## 怎么用

1. 选串口 + 波特率（默认 1500000）
2. 点 **连接 Downloader** —— 自动让出串口、拉起官方引擎、2~3 秒识别设备
3. 点 **开始烧录** —— 无弹窗确认，自动重试
4. 烧完自动退出 Downloader、抢回串口，继续看板卡日志

不需要手动操作 Downloader 界面。

## 关键行为

### 串口与烧录自动互斥

Windows 的 COM 口独占，所以：

| 时机 | 谁持有 COM22 |
|---|---|
| 你打开串口看日志 | 工作台 |
| 点「连接 Downloader」 | 自动让给 Downloader |
| 点「开始烧录」 | 确保已让出 |
| **烧录完成** | **自动抢回，约 8ms 空窗** |

烧完会主动让 Downloader 退出，这样你随时能直接开串口，不用先点「断开」。

### 自动修正 COMEnable

`Downloader.config` 里的 `COMEnable` 是「能不能扫串口」的总闸。它被设成 `False` 时，Downloader **根本不扫描串口**，表现为「一直连不上、必须手动点它的串口按钮」。

插件每次连接前检查并自动改成 `True`（改前备份，只动这一个键）。

### 自动重试

Downloader 在「扫描中」阶段会**静默丢弃** `StartDownload`。插件发命令后若 3 秒内无响应，自动重发，最多 5 次。

### 烧录启动互斥（避免工具冲突）

`/flash/start` 有 `launching` 标记：从发出 `launch` 到收到 `launched`/`StartOK` 之间，
再点「连接」（或自动烧录同时触发）只会返回 `{ ok:true, pending:true }`，**不会**再发第二条
`launch`。Windows 上两次 `launch` 会让 helper 起两个 Downloader 实例，直接报工具冲突。
互斥标记在 helper 退出、连接成功、点「断开」时复位。

### 打开串口失败只打一行

串口 helper（`helper/AbSerialHost.cs`）的 `open` 失败现在**按 id 回包**（`{ok:false,id,msg}`），
不再是 id 为空的 `err` 事件。宿主因此：

- 失败立即返回（实测 ~340 ms，不再等 3 秒超时）；
- 只在「占用/拒绝访问」类错误上重试，最多 4 次（250 ms 间隔）；
- 最终只写**一行** `串口 COMx 打开失败（尝试 N 次）：原因`；
- 其它异步串口错误 3 秒内同类合并，超时才再打一行。

## 自动烧录（编译完自动烧）

工作台自己监听编译产物 `app.dcf`，文件一变（= 编译完成）就自动烧录。

点工具栏的 **○ 自动烧录** 开启，变成 **◉ 自动烧录** 即生效。

### 为什么不用 Downloader 自带的 AutoStart

Downloader 的 `AutoStart=True` 需要在它 GUI 里**手动点一次按钮**才激活，而且一旦被关掉就断了。
工作台烧完会关闭 Downloader 来还你串口（日志优先），所以那个机制用不了。

### 你在 Downloader 里切 dcf，它会自动跟随

不需要任何额外操作。你在 Downloader 界面里选了哪个 dcf，
工作台就监听哪个（每 3 秒同步一次），日志会显示：

```
自动烧录已跟随到：app.dcf
```

> 技术细节：Downloader 在 GUI 里切 dcf 时，**既不推 FileInfo、也不写 config**，
> 那个选择只在它内存里。所以工作台通过读它窗口里的 dcf 下拉框
> （Win32 消息 `CB_GETCURSEL` + `CB_GETLBTEXT`）来获取当前选中项。
> 实测验证可靠：切换后监听路径会跟着变。

### 它怎么工作

```
编译完成 → dcf 变化 → 等 1.2 秒写稳
  → 若串口开着，先让出
  → 若 Downloader 已关，重新拉起它（含 COMEnable 校正）
  → 等设备在线 → 烧录 → 自动重试 → 烧完还串口
```

日志会看到：

```
检测到编译产物变化（3464KB），准备自动烧录
自动烧录：重新拉起 Downloader…
自动开始烧录…
✓ 烧录完成（MAC 00:00:XX:XX:XX:XX）
已自动恢复串口 COM22 @1500000（空窗 8ms）
```

### 板子休眠是唯一常见的失败原因

实测 3 轮连续自动烧录全成功（13s / 24s / 30s）。如果卡住，几乎都是**板子休眠了**：

```
⚠ 卡在「扫描中」已超 12 秒 —— 板子可能已休眠或没进下载模式，请重新上电/按复位
✗ 自动烧录中止：板子一直没响应（可能已休眠）
```

不会干等 5 分钟，25 秒内没响应就明确中止并告诉你怎么做。

## 日志

### 容量与落盘

| 项 | 值 |
|---|---|
| 本地文件 | `%USERPROFILE%\.dsh\workbay\logs\downloader.jsonl`（**全量**，JSONL） |
| 写盘方式 | 250ms 合并追加；超过 **128 MB** 轮转为 `downloader.jsonl.1`（覆盖旧 .1） |
| 启动恢复 | 读文件末尾 **32 MB**，加载最近 50,000 条回工作台；文件为空则不加载 |
| Host 内存 | 最近 **50,000 条**（工作台 / AI 检索的工作集） |
| 前端内存 | 最近 **300,000 条**（流式追加；从文件可继续加载） |
| 页面渲染 | **虚拟列表**：只渲染可视区（固定行高 + 上下占位），DOM 与总条数无关 |
| 历史浏览 | 向上滚动自动从 JSONL 加载更早（`/log/history?before=`），**没有 800 行上限** |
| 推送方式 | 宿主 **60ms 批量** SSE（`ev:'logs'`，一批多条） |
| 页面显示 | 日志条数旁显示 `本地 3.2 MB`（悬停看完整路径） |
| 单次查询上限 | 5,000 条，可翻页 |

**日志位置**：运行日志**全量追加**到上面的 JSONL 文件（每行 `{"t","src","text"}`）；
DSH 重启后自动恢复最近 50,000 条到工作台，文件为空就不加载。页面首屏带 20,000 条，
再往上滚就从文件继续加载——所以**能看到文件里的全部历史**，内存只保留工作集。

**清空**：页面「清空」会同时清内存缓冲、截断本地 JSONL 文件、并删除轮转的 `.1` 文件。
文件小于 1 KB 时页面不显示「本地 …」提示。
**为什么满了也不卡**：旧版前端每来一行都 `[...logs.slice(-20000), item]` 并重渲染全部
2 万行 DOM，缓存越满越慢。现在宿主把 60ms 内的日志合并成一条 SSE，前端按批追加，
页面用虚拟列表只渲染可视区；200 万行也只挂几十个 DOM 节点。实测 2 万行追加：旧实现
**1965ms**，新实现 **8ms**（≈245×）。

### 格式

每行三列：`时间` `来源` `内容`

| 标记 | 来源 |
|---|---|
| `B` | 板卡串口输出 |
| `D` | 烧录日志（Downloader 控制台） |
| `S` | 系统/状态 |
| `U` | 用户发送 |
| `M` | 模型发送 |

日志按 `\n` 聚合，跨包截断的行会正确拼接，不会出现无端换行。

### 给 AI 的检索接口

```
GET /downloader/log/recent?tail=500              最后 500 条
GET /downloader/log/recent?offset=0&limit=200    分页
GET /downloader/log/recent?src=B,D               只看板卡/烧录
GET /downloader/log/recent?q=Error               关键词搜索
GET /downloader/log/recent?since=<毫秒>          某时间之后
```

响应带 `total`。模型侧也注册了 **`downloader_logs`** 工具（`tail` / `offset` / `limit` /
`src` / `q` / `since`），可以直接调用，不必先知道缓存位置。

### 页面搜索（Notepad++ 风格）

日志区上方有一个搜索行：

- 输入即搜（300ms 防抖），**直接搜索本地全量 JSONL**，不受内存工作集限制；
- `Aa` 区分大小写、`ab` 全字匹配、`.*` 正则（JS 正则；非法会显示 `bad-regex`）；
- 结果按条列出并高亮命中（虚拟列表，DOM 只渲染可视区），条数显示 `搜索 N 条`；
- 搜索时日志区显示结果而不是实时流；`Enter` 重新搜索（构建过程中可刷新结果），
  `Esc` 或「清除」回到实时日志；
- 源过滤（全部/板卡/烧录/系统）同时作用于搜索；
- 宿主接口 `GET /log/search?q=&case=1&word=1&regex=1&src=B&limit=2000`，返回
  `{ matches, total, hasMore, scanned }`；`total` 是全部命中数，`matches` 最多 2000 条。

### 地址清单（让 AI 一步定位）

因为日志只在内存里，宿主额外维护一份**地址清单文件**（不是日志本身）：

```
%USERPROFILE%\.dsh\workbay\downloader-logs.location.json
```

内容包含：存储类型（`host-memory-ring-buffer`、`persistent:false`）、读取工具
`downloader_logs`、HTTP 路由 `/downloader/log/recent` 及常用参数、当前 `total`、
工作区根、以及这份清单自己的路径；另外带 logFile（全量 JSONL 日志文件）和它的当前大小。

三种定位方式（任选其一，结果相同）：

1. 模型工具 **`downloader_logs_location`**（推荐，一条调用返回 JSON）；
2. HTTP `GET /downloader/log/location`；
3. 直接读上面的 JSON 文件（AI 用文件工具即可，无需知道 DSH 端口）。

拿到路由后按需取内容，如 `GET /downloader/log/recent?tail=300`、`?src=B,D`、`?q=Error`。
清单在插件启动、每次 `/log/location` 调用以及有新日志（≥5 秒节流）时刷新。

## 排查

### 连不上 / 一直显示离线

**正常情况下不该出现**。若出现，按顺序检查：

1. 板子是否上电、USB 线是否插好
2. 串口号是否变了（`GET /downloader/flash/diagnose` 会列出实际可用串口）
3. 是否有别的 Downloader 实例在跑（插件会自动关掉）

抓现场最直接的办法：让我读 `/downloader/log/recent`。

### 烧录慢

`Downloader.exe` 冷启动本身要 1.3–1.5 秒（.NET Reactor 加壳解密），省不掉。之后扫描串口再 2~8 秒属正常。

### 端口找不到

串口号会因拔插/换 USB 口变化（实测 COM11 → COM22）。插件的串口下拉每次都会重新枚举，选对即可。

> **蓝牙虚拟串口不能烧录**：COM3/COM4 是 BthModem，`Tx` 返回 0 且不报错，看着正常但数据没出去。只有 CP210x / CH34x / FTDI 这类真串口能用。下拉里带设备名就是为了分辨。

### 残留进程

这台机器上出现过 `DownloaderIpcBridge` 变成 `Threads=0` 且杀不掉的情况（`Access denied`），**要重启机器才能清**。不影响功能，但如果串口莫名打不开可以先想到它。

## 装法

它是 `dsh-workbay` monorepo 里的一个包（`packages/downloader`），通过 profile 的 `file:` 依赖装进 DSH：

```jsonc
// ~/.dsh/profiles/<profile>/package.json
{
  "dsh": { "profile": { "bundles": ["...", "dsh-downloader"] } },
  "dependencies": { "dsh-downloader": "file:<repo>/packages/downloader" }
}
```

```powershell
cd $env:USERPROFILE\.dsh\profiles\desktop
pnpm install
```

**改完 `lib/index.js`（Host 侧）需重启 DSH；只改 `lib/client.js` 刷新页面即可。**

### 必须配置的路径

厂商烧录引擎和 SDK 工作区不属于本仓库，路径走环境变量（见 `lib/index.js` 顶部）：

| 变量 | 用途 |
|---|---|
| `DSH_DOWNLOADER_DIR` | 厂商 Downloader 安装目录（含 `Downloader.exe`） |
| `DSH_DOWNLOADER_WORKSPACE` | 存放 SDK 工程的根目录（扫描 `*.dcf`） |
| `DSH_DOWNLOADER_IPC_HELPER` | 可选：覆盖 IPC 桥 exe 的位置 |
| `DSH_DOWNLOADER_SAMPLE_REPO` | 可选：自检脚本用来断言 git 元数据的真实仓库 |

都不设置插件也能加载，但 `/diag` 会报 Downloader 目录缺失，烧录不可用。

## 验证

```powershell
cd packages/downloader
node smoke-test.mjs    # 后端：目录扫描 / git / 串口 / IPC
node http-test.mjs     # HTTP：接口返回值
```

没设 `DSH_DOWNLOADER_WORKSPACE` / `DSH_DOWNLOADER_SAMPLE_REPO` 时，相关用例自动 SKIP。

## 文件

```
dsh-downloader/
├─ package.json          dsh.bundle.patch + dsh.client（inject: 仅 dsh-client-locale）
├─ cordis.patch.yml      一行 insert
├─ lib/
│  ├─ index.js           Host：串口 / 烧录 IPC / HTTP / SSE / 日志缓冲
│  └─ client.js          Client：Downloader tab
├─ helper/
│  ├─ AbSerialHost.cs
│  └─ AbSerialHost.exe   串口 helper（64 位 .NET，零依赖）
├─ smoke-test.mjs
└─ http-test.mjs
```

重新编译 helper：

```powershell
C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /target:exe /platform:anycpu `
  /r:System.dll `
  /out:helper\AbSerialHost.exe helper\AbSerialHost.cs
```

## 依赖的外部程序

| 项目 | 位置 |
|---|---|
| 厂商 Downloader | `%DSH_DOWNLOADER_DIR%\Downloader.exe`（在 v3.6.0 上验证过） |
| IPC 桥 | `ipc-helper/DownloaderIpcBridge.exe`（随包分发，C# 源码同目录） |

IPC 桥是自编译的 C# 程序（`NativeWindow` + `WM_COPYDATA`），源码同目录。换成别的 Downloader 版本时，`BackShowMode` 启动参数需要重测。

## 已知限制

| 项 | 说明 |
|---|---|
| `BackShowMode` 是未公开参数 | 只在 v3.6.0 验证过隐藏/显示行为 |
| 串口与烧录互斥 | Windows COM 独占，连接时会让出串口 |
| `COMEnable` 会被 Downloader 改写 | 插件每次自动校正；若你想用 GUI 关掉它会冲突 |
| 烧录协议不自主 | 用的是官方引擎的 IPC，不是自己实现的协议（那需要逆向，成本 3~6 周且有变砖风险） |
