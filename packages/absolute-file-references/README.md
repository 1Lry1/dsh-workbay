# dsh-absolute-file-references

> 让 DSH 的 `@` 文件选择器插入**绝对路径**，同时芯片（chip）仍显示短文件名。

DSH 内置的 `@` 引用源（`@deepseek-ai/dsh-client-ui-reference`）按**会话工作区相对路径**列出候选，
选中后插入 `@app/projects/.../build.bat`。本包包住该源的 `onPick`，用会话的 `cwd` 把
file/folder 提及改写成绝对路径；`label` 不动，模型通过该源自己的 `serialize` 拿到绝对路径
（发出去的 `@` 解析器按最后一个 `/` 或 `\` 段推算标签，所以绝对路径同样可解析）。

| 输入（选择器插入） | 改写后 | 芯片标签 |
|---|---|---|
| `@build.bat` | `@D:\...\build.bat` | `build.bat` |
| `@"my build.bat"` | `@"D:\...\my build.bat"` | `my build.bat` |
| 目录选择 `@"app/projects/standard/` | `@"D:\...\app\projects\standard\`（保留未闭合引号） | `standard/` |
| `@app/x/app.dcf` | `@D:\...\app\x\app.dcf`（正斜杠统一成 `\`） | `app.dcf` |
| 已写绝对的路径 | 原样 | — |
| `@` 会话引用、技能引用、drill 动作 | 原样 | — |

## 为什么不是单独一个 profile bundle

单独装会在插件列表里多出一行，还可能在 suite 里重复包一层。**发布形态是 `dsh-workbay-suite`**：
`scripts/build-suite.mjs` 把它 vendor 进 suite，client 半侧和其他六个半侧一起拼进同一个
`dsh-workbay-suite` 模块。`cordis.patch.yml` 只在单独调试 `@` 选择器时用。

## 两个为合并而做的形状决定

1. **插件级 `inject` 为空。** suite 会把各 vendor 半侧的 `inject` 取并集挂到自己那一行上；
   一行一旦 inject 了 `inputTriggers` / `sessions`，在服务就绪前整行都是 `pending`，
   工作台（dock / files / terminal …）会被连带拖住。所以这里**自己用 `ctx.inject` 等**这两个服务，
   suite 行仍然立刻激活，选择器一出现就开始包。
2. **失败软降级。** 任何异常都只是 `console.warn` 并保留原来的相对路径；一个装饰性改写不能弄坏选择器。

包住内置源的方式是就地改写 `inputTriggers` 服务私有 `live.sources` 里
`trigger === '@' && name === 'reference'` 那个对象的 `onPick`（DSH 没有公开的引用源枚举 API），
并用 `__workbayAbsoluteRefs` 标记做幂等：重复 apply（HMR，或 suite 那一行重挂）不会二次转换。
`@` 源晚于本插件注册时，会包装 `registerSource` 补上；更早出现的情况由 250ms × 40 次的轮询兜住。

## 运行时开关（不用重启）

```js
localStorage['dsh-workbay.absolute-refs.v1'] = '0'   // 恢复官方相对路径
localStorage['dsh-workbay.absolute-refs.v1'] = '1'   // 或删掉这个键：绝对路径（默认）
```

每次选中都会读一次，所以翻转立刻生效。

## 测试

```powershell
pnpm --filter dsh-absolute-file-references test
```

9 个用例：注册形状（空 inject）、相对→绝对、引号语法、会话/技能/drill/已绝对路径放行、
运行时开关、重复 apply 幂等、晚注册的源、服务缺失时 no-op、无 `ctx.inject` 的兼容路径。

真实选择器的端到端行为由 workbench 的浏览器测试覆盖。

## 已知限制

- 依赖 DSH 内部形状（`@source` 名为 `reference`、`onPick` 返回 `ReferenceInsert`、服务私有 `live.sources`）。
  DSH 升级改了这个形状需要复查；失败是软降级（保留相对路径），不会让选择器报错。
- 绝对路径更长、更占上下文；`read` / `bash` 两种形式都接受。
