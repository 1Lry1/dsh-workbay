# dsh-workbay-suite

工作台的**单插件形态**：一个可安装包 = 一个插件条目。

DSH 的插件列表按**已安装包**展示，所以“5 个独立 bundle + 一个聚合金”仍然会出现 5 行
“未开启”。这个包把 5 个 bundle **物理收进来**：

```
packages/suite/
├─ cordis.patch.yml      生成的：只插入 1 行 loader
├─ lib/index.js          生成的：一个 apply() 依次挂载 5 个宿主半侧
├─ client.js             生成的：5 个 client 半侧拼接成 1 个 ModuleLoader bundle
├─ vendor/
│  ├─ dock/              原 packages/dock 的拷贝（src + package.json）
│  ├─ files/             … + lib/chunks/editor.js
│  ├─ terminal/          … + lib/chunks/xterm.js + helper/WorkbayPty.exe
│  ├─ gitcraft/
│  ├─ downloader/        … + helper/AbSerialHost.exe + ipc-helper/DownloaderIpcBridge.exe
│  └─ kit/               宿主辅助库（被其它 5 个 import）
└─ tests/build.test.mjs  验证生成物
```

生成物是 **gitignored** 的，由 `pnpm run build` 产出（`scripts/build-suite.mjs`）。

## 为什么可以合并

- 宿主：每个包的 `apply(ctx, config)` 是普通函数，聚合金在一个 ctx 上依次调用它们即可；
  每个包仍保留自己的路由前缀、自己的失败域。
- 客户端：`window.__ModuleLoader__.load({ id, factory })` 是**队列** API，一个脚本里可以
  注册多个模块；拼接时用 IIFE 隔离各自作用域。
- 路径：files/terminal 用 `import.meta.url` 找自己的 `lib/chunks` / `helper`，downloader 用
  同样方式找 `helper` —— vendor 保留了包内目录结构，所以这些相对路径继续成立；
  `@dsh-workbay/kit` 的 import 在拷贝时改写成相对路径。

## 安装（推荐）

```jsonc
{
  "dsh": { "profile": { "bundles": [
    "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app",
    "dsh-workbay-suite"
  ] } },
  "dependencies": {
    "dsh-workbay-suite": "file:<repo>/packages/suite"
  }
}
```

```powershell
pnpm run build              # 生成 vendor/ + client.js + lib/index.js + cordis.patch.yml
pnpm install                # 或 dsh plugin --profile desktop add file:.../packages/suite
pnpm run verify:profile     # 校验装进去的副本完整、且没有多余 workbay 包
```

装完重启 DSH：插件列表里只有 **一个** `dsh-workbay-suite`，工作台四个页面照常。

> 不要在同一个 profile 里同时列聚合金和任何单独 bundle：同一条 loader 行会插两次，
> 前缀路由重复注册，整棵插件树起不来。`verify:profile` 会拦住这种配置。

## 开发时仍可分开装

源码仍是 5 个独立包（`packages/dock|files|terminal|gitcraft|downloader`），跑各自测试、
单独调试时用“分别安装”即可；聚合金只是发布形态。改完源码后 `pnpm run build`
重新生成即可。

## 测试

```powershell
pnpm --filter dsh-workbay-suite test
```

4 个用例：生成物齐全（含 helper 与 chunk）、patch 只有一行、client 注册了 5 个模块且 id
唯一、宿主 apply 在假 ctx 上把每个包的路由前缀各注册一次。
