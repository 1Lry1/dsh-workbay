# dsh-workbay-files

> 工作台的**文件页**：工作区文件树、只读查看器（文本/代码/图片/PDF/Markdown/HTML）、
> 以及按需懒加载 CodeMirror 编辑器的编辑保存。本文件只讲 **host 半侧**；浏览器半侧见
> `src/client.js`，契约见 [`docs/files-api.md`](../../docs/files-api.md)。

## 路由

全部挂在 DSH 自己的 web server 上，和 GitCraft / Dock 一样走同源围栏
（loopback peer / loopback Host / `Sec-Fetch-Site: same-origin|same-site`）。

| 路由 | 形态 | 说明 |
|---|---|---|
| `POST /dsh-workbay-files/api/<method>` | JSON，`{ ok, data }` / `{ ok:false, error:{code,message} }` | 10 个方法，见下表 |
| `GET /dsh-workbay-files/media?root=<abs>&rel=<rel>` | 原始字节 | 图片/PDF/HTML/任意文件；`Range`、`no-cache`、`nosniff`、sandbox CSP |
| `GET /dsh-workbay-files/chunk/<name>.js` | JS | 懒加载 chunk（`lib/chunks/<name>.js`），`ETag` + 304 |

### API 方法

| method | 入参 | 出参 `data` |
|---|---|---|
| `roots` | `{}` | `{ root, drives:[{name,path}], recent:[string] }` |
| `browse` | `{ dir }` | `{ dir, parent, entries:[dirEntry] }`（只列目录，用于选工作区根） |
| `tree` | `{ root, dir='', showHidden=false }` | `{ root, dir, entries:[entry], truncated }` |
| `search` | `{ root, query, limit=200, includeNodeModules=false }` | `{ matches:[entry], truncated }` |
| `read` | `{ root, rel, maxBytes? }` | `{ content, size, mtimeMs, encoding, truncated }` |
| `write` | `{ root, rel, content, baseMtimeMs? }` | `{ size, mtimeMs }` |
| `stat` | `{ root, rel }` | `{ entry }` |
| `mkdir` | `{ root, rel }` | `{ entry }` |
| `rename` | `{ root, from, to }` | `{ entry }` |
| `delete` | `{ root, rel, recursive? }` | `{ ok: true }` |

`entry`：`{ name, rel, type: 'dir'|'file'|'symlink', size?, mtimeMs?, hasChildren? }`。
`rel` 一律是相对 `root` 的 **POSIX** 路径（`a/b/c`），`dir` 输出同理；`root`、`parent`、
`browse.entries[].path` 是绝对路径，输出时统一成 `/` 分隔。

## 安全模型（docs/files-api.md §1）

- **root 必须显式传**：绝对路径、已存在、是目录；否则 `400 bad-request`。
- **rel 是 POSIX 相对路径**：不接受绝对路径、盘符相对路径（`C:foo`）、反斜杠、NUL、
  以及任何 `..` 段（`400 bad-request`）。
- **realpath 围栏**：`root` 取 `realpathSync.native` 作为边界；逐段 `lstat`，
  符号链接只有在其 realpath 仍落在边界内（**前缀按分隔符比较**，`C:\ws2` 不算
  `C:\ws` 内）时才跟随。指向根外的链接、以及悬空链接，一律 `403 outside-root`。
  写操作因此不可能经由链接写到根外。
- **媒体路由同样围栏**：`/media` 走同一个 `resolveInside`，越界同样是 403。
- **写开关**：`allowWrite` 默认 `false`，`write / mkdir / rename / delete` 一律
  `403 write-disabled`。
- **大小上限**：读取默认 `maxFileBytes`（1 MiB），单次最多 8 MiB，超出返回
  `truncated: true`；写单次最多 2 MiB（`413 too-large`），且拒绝含 NUL 的二进制内容。
- **不执行 shell 命令**：终端能力在 `dsh-workbay-terminal`。

## 配置（cordis 行 config）

| 配置项 | 默认 | 说明 |
|---|---|---|
| `allowWrite` | `false` | 与 `cordis.patch.yml` 一致；profile 里显式改成 `true` 才可写 |
| `maxFileBytes` | `1048576`（1 MiB） | 单次 `read` 的默认上限，内部硬上限 8 MiB |

`chunk` 目录默认是包内的 `lib/chunks/`（由 `pnpm run build` 生成）。
`DSH_WORKBAY_FILES_CHUNKS` 环境变量可覆盖它，仅用于测试/开发，生产不要设置。

## 媒体路由细节

- `content-type` **只看扩展名**（未知 → `application/octet-stream`），永不嗅探内容。
- 固定响应头：`cache-control: no-cache`、`x-content-type-options: nosniff`、
  `content-disposition: inline`、`accept-ranges: bytes`。
- `content-security-policy: sandbox; object-src 'none'` 对**所有**文件都加（不只
  svg/html）：即使用户直接打开一个带脚本的 HTML/SVG，它也拿不到应用 origin。
- 单个字节区间（`Range: bytes=a-b` / `bytes=-n`）返回 206 + `content-range`；
  不可满足返回 416。多区间不支持（按完整文件返回）。
- 目录/不存在分别返回 `400` / `404`。

## Chunk 路由细节

- 只接受 `<name>.js`：`[A-Za-z0-9][A-Za-z0-9._-]*\.js`，名字里不允许 `/`、`\`、`..`，
  解码后同样检查；因此 `..%2F..%2Fpackage.json`、`%2e%2e%2f...` 都是 404。
- `ETag` 是内容 SHA-1 的强校验；`If-None-Match` 命中返回 304；`no-cache` 让每次加载
  都回来验证一次（发布新构建后客户端立刻拿到新代码）。
- `lib/chunks/` 不存在时 404（degradation：没有构建 chunk 只是编辑器不可用）。

## 实现说明 / 与契约的边界

- **`read` 的 `encoding`**：文本 → `utf8`；看起来是二进制（前 8 KiB 有 NUL 或控制字符
  占比高）→ `binary`，此时 `content` 是 **base64**。图片等二进制展示走 `/media`。
- 文本内容会去掉开头的 UTF-8 BOM（Windows 工具常见），保存时不会写回 BOM。
- **`search` 按文件名**做大小写不敏感子串匹配（不读文件内容），默认不进入
  `node_modules`（`includeNodeModules: true` 可开），始终跳过 `.git/.hg/.svn`；
  不跟随目录符号链接，BFS 有深度/访问量上限。
- **hidden** 只认「点开头」：Windows 的隐藏属性 `fs.stat` 不暴露，而 host 不允许
  执行 `attrib` 之类的 shell 命令。
- **`browse`** 是唯一不受 root 围栏约束的接口（它的用途就是让用户选 root），只要求
  `dir` 是绝对、已存在的目录；返回目录项（含指向目录的链接），文件不返回。
- **`delete`** 删除符号链接/目录 junction 时只删链接本身，不会碰它指向的目标；
  非空目录必须 `recursive: true`（否则 `409 not-empty`），不允许删 `root` 本身。
- **`write` 的并发**：`baseMtimeMs` 与磁盘 mtime 不一致（±1 ms 容差）→ `409 conflict`；
  文件在读之后消失也按冲突处理。
- **`roots.recent`** 是进程内 LRU（最多 10 个），只记录真正服务过的 root，不落盘。
- **`Config` schema**：本包不动态引入 `@deepseek-ai/schemastery`，只按契约读取两个
  配置键并用安全默认值兜底；host 缺失/配置写错不会影响路由加载。

## 测试

```powershell
node --check packages/files/src/index.js
node --test packages/files/tests/host.test.mjs
```

host 测试用假 cordis ctx 捕获三条路由，挂在真实 HTTP server 上跑：覆盖越界、
`..`、绝对路径、反斜杠、目录链接逃逸（Windows 用 junction，无需管理员权限）、
大小上限、409 写冲突、`write-disabled`、媒体响应头/Range/CSP、chunk ETag/304/
traversal、同源围栏，以及 10 个方法的主路径。
