# dsh-workbench-suite

一键装载整个工作台的**聚合金**（aggregator）。它自己不含代码，只做两件事：

1. `dependencies` 里带上三个 bundle：

   ```json
   "dsh-workbench-dock": "file:../dock",
   "dsh-gitcraft": "file:../gitcraft",
   "dsh-downloader": "file:../downloader"
   ```

2. 用自己的 [cordis.patch.yml](cordis.patch.yml) 一次插入三行 loader：

   ```yaml
   - insert:
       - id: workbench-dock
         name: 'dsh-workbench-dock'
       - id: gitcraft
         name: 'dsh-gitcraft'
         config: { ... }
       - id: downloader
         name: 'dsh-downloader'
   ```

## 安装（二选一，不要都做）

```powershell
# A. 只装聚合包
#    profile 的 dsh.profile.bundles 里只加 "dsh-workbench-suite"
#    profile 的 dependencies 里加 "dsh-workbench-suite": "file:<repo>/packages/suite"

# B. 分别装三个（跟现在一样）
#    bundles 里写 dsh-workbench-dock / dsh-gitcraft / dsh-downloader
```

**不要同时列 suite 和其中任何一个**：两边都会插入同一条 loader 行，前缀路由注册两次，DSH 会以 `duplicate prefix route` 拒绝启动整棵插件树。

## 状态：实验性

三行 insert 是 cordis patch 的正常用法（patch 本来就是数组），但 DSH 的插件管理器是否会为一个 bundle 应用「挂载别家包」的 patch，**尚未在本机实测**。在验证通过之前，继续用方案 B（三个独立 bundle）更稳妥。
