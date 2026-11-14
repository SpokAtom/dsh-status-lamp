# 自托管插件索引

DSH 没有中央市场：插件页「发现」标签读的是用户自己添加的索引 URL（`Plugin → Discover → 添加索引源`）。
这个目录就是本插件的索引源，格式为官方 **Plugin market index format 1**。

```
site/
├── index.json              # 索引文档
└── icons/status-lamp.svg   # 相对图标，随索引一起发布
```

## 发布到 GitHub Pages

1. 仓库 Settings → Pages → Source 选 `main` 分支的 `/site` 目录（或把 `site/` 内容推到 `gh-pages`）。
2. 生成的索引 URL 形如 `https://SpokAtom.github.io/dsh-status-lamp/index.json`。
3. 用户在 DSH：插件 → 实验性插件 → 打开「自定义插件索引」→ 发现 → 添加索引源 → 粘贴该 URL。
4. 之后插件页会显示「状态灯」，点安装即走 `dsh plugin add dsh-status-lamp@1.0.0`。

> 图标用相对路径 `icons/status-lamp.svg`，校验器会按索引 URL 解析成绝对地址；把 `index.json` 与
> `icons/` 并排发布即可，不需要改文件。官方建议索引一律走 https（http 索引可被网络中间人篡改安装来源）。

## 校验

索引格式由 DSH 自带的 `@deepseek-ai/dsh-plugin-market-index` 校验：

```js
import { parseMarketIndex, marketInstallTarget } from '@deepseek-ai/dsh-plugin-market-index'
const index = parseMarketIndex(JSON.parse(readFileSync('site/index.json', 'utf8')), indexUrl)
marketInstallTarget(index.plugins[0].name, index.plugins[0].versions[0]) // { spec: 'dsh-status-lamp@1.0.0' }
```

本仓库的 `site/index.json` 已在 0.2.2-rc.1 的校验器上跑通（format 1、图标解析、安装 spec 均正确）。

## 注意

- 索引里的 `versions` 必须在**安装物真实存在**之后列出：先 `npm publish`，再更新 `publishTimestamp` 并发布索引。
- DSH 只校验索引格式，不校验索引里的声明；作者、标题、来源都是索引自己的说法。
