# 发布纪律（Release discipline）

本文件约束本插件的发版流程。默认状态是**不发布**：所有改动先在本地完成并验证，只有明确要发时才动版本号和注册表。

## 1. 默认：本地迭代，不发版

- 本地 `desktop` profile 以 link 方式安装本目录，改完用 `plugin_manager` 的
  `remove_bundle` + `install_bundle` 重装即可看效果。
- 迭代期间**不改** `package.json` 的 `version`，**不** publish，**不**打 tag。
- 一个功能批次内部可能反复改十几次，这些都只发生在本地。

## 2. 什么时候才发

同时满足以下三条才发：

1. 用户明确说「发 / 提交 / 发布」；
2. 本机已安装并**目视验证**过本次改动（不是只看代码）；
3. `npm pack --dry-run` 的文件清单与体积符合预期。

发布一次要做的动作（一次做完，不要拆成多轮）：

```sh
# 1) 改版本号与 CHANGELOG（一个批次只加一条）
# 2) 打包自检
npm pack --dry-run
# 3) 提交并推送
git add -A && git commit -m "..." && git push origin main
# 4) 发 npm（唯一一次）
npm publish --registry=https://registry.npmjs.org --access public
# 5) tag + release
git tag -a vX.Y.Z -m "..." && git push origin vX.Y.Z
gh release create vX.Y.Z --title "vX.Y.Z" --notes "..."
# 6) 更新自托管索引 site/index.json 的版本与时间戳
```

## 3. 版本号策略

| 场景 | 版本动作 |
|---|---|
| 修一个已发布版本里的 bug（位置错、逻辑错） | 先本地修，**等用户说发**再 `PATCH +1` 发一次 |
| 新增功能（如过滤项） | `MINOR +1` 发一次，功能与文档一起发 |
| 仅文档/文案 | **不发 npm**，只推 GitHub（npm 已发版本不改 README，避免为文档再占版本号） |
| 需要提前给人试用 | 用 `X.Y.Z-beta.N` 预发布，不占 `latest` |

原则：**同一个功能批次只占用一个版本号**。连续几个 PATCH 只允许出现在"已发布的版本确实坏了"这种情形。

## 4. 已知的版本号成本

npm 的版本号发布后不可复用，也不能随意覆盖。当前实际状态：

| 版本 | 状态 | 备注 |
|---|---|---|
| 1.0.0 | **已发布（线上唯一版本）** | 三态灯首版 |
| 1.1.0 | 本地准备中，**未发布** | 过滤项 + 位置修正 + 文档/文案 |
| 1.1.1 / 1.1.2 / 0.0.0-stage | 曾发布，已尝试删除 | 删除请求返回成功但注册表仍列出，需用有治理权限的凭据（网页版或交互 2FA）真正删除；`latest` 已指回 1.0.0 |

## 5. 失败与清理

- 坏版本优先 `npm deprecate dsh-status-lamp@<ver> "message"` 标记，不轻易 `unpublish`。
- 仅在发布 72 小时内、且确认无外部依赖时，才考虑 `npm unpublish dsh-status-lamp@<ver>`。
- 任何清理动作都要先征得用户同意。

## 6. 目录 PR（awesome-dsh-plugin）

- 每个插件的条目只提交一次；后续描述更新直接推到**同一个 PR 分支**，不新建 PR、不重新发 npm（目录版本取自 npm，与描述更新无关）。
- 合并前不要反复催；被打 `held: author` 时在同分支修一次并留一条评论。
