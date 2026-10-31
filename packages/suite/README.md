# dsh-workbay-suite

一键装载整个工作台的**聚合金**（aggregator）。它自己不含代码，只做两件事：

1. `dependencies` 里带上全部 bundle：

   ```json
   "dsh-workbay-dock": "file:../dock",
   "dsh-workbay-files": "file:../files",
   "dsh-workbay-terminal": "file:../terminal",
   "dsh-gitcraft": "file:../gitcraft",
   "dsh-downloader": "file:../downloader",
   "@dsh-workbay/kit": "file:../kit"
   ```

2. 用自己的 [cordis.patch.yml](cordis.patch.yml) 一次插入五行 loader
   （dock / files / terminal / gitcraft / downloader，含默认 config）。

## 为什么用它

DSH 的插件列表按 **bundle** 展示。分别安装时列表里会看到 5 个条目；用聚合金后
**列表里只有一个 `dsh-workbay-suite`**，工作台内部仍然是 5 个独立 bundle（故障域、
发布节奏、依赖范围都不同，见根 README 的架构说明）。

## 安装（二选一，不要都做）

```jsonc
// A. 聚合金（推荐，插件列表只显示一个）
{
  "dsh": { "profile": { "bundles": [
    "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app",
    "dsh-workbay-suite"
  ] } },
  "dependencies": {
    "dsh-workbay-suite": "file:<repo>/packages/suite",
    // 下面这些是 suite 的 file: 依赖，pnpm 会按它自己的 package.json 解析；
    // 显式写出来可以让 profile 的 node_modules 一定包含它们。
    "dsh-workbay-dock": "file:<repo>/packages/dock",
    "dsh-workbay-files": "file:<repo>/packages/files",
    "dsh-workbay-terminal": "file:<repo>/packages/terminal",
    "dsh-gitcraft": "file:<repo>/packages/gitcraft",
    "dsh-downloader": "file:<repo>/packages/downloader",
    "@dsh-workbay/kit": "file:<repo>/packages/kit"
  }
}
```

```jsonc
// B. 分别安装（插件列表显示 5 个）
//    bundles 里写 dsh-workbay-dock / dsh-workbay-files / dsh-workbay-terminal /
//    dsh-gitcraft / dsh-downloader
```

**不要同时列 suite 和其中任何一个**：两边都会插入同一条 loader 行，前缀路由注册两次，
DSH 会以 `duplicate prefix route` 拒绝启动整棵插件树。

## 状态

五行 insert 是 cordis patch 的正常用法（patch 本来就是数组）。安装完成后
**需要重启 DSH**；插件列表里应只剩一个 `dsh-workbay-suite`，工作台页面照常出现。
如果启动异常，把 profile 的 `package.json` 换成安装前的备份即可回退。
