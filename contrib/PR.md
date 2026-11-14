# 提交给 awesome-dsh-plugin（dshmarket.com / dsh-market 的目录源）

## PR 标题

```
Add SpokAtom/dsh-status-lamp
```

## PR 正文（贴到 GitHub PR）

```markdown
<!-- Thanks for contributing! Quick checklist / 提交前快速自查 -->

- [x] I added **one file** at `data/plugins/SpokAtom__dsh-status-lamp.yml` — that single file is the whole submission.
- [x] My repo's `package.json` declares **`dsh.bundle`** (`"bundle": { "patch": "./cordis.patch.yml" }`) and ships the patch file.
- [ ] My repo is at least **1 day old** — created 2026-11-14; the gate should pass on its own once it crosses the bar.
- [x] `category` is `ui` (session-row indicator, not a theme).
- [x] The description states what the plugin does, no superlatives.
- [x] My repo has the `dsh-plugin` topic.

**What it does / 功能**

A session-row status lamp for the sidebar. DSH's own lamp has four states and renders nothing for idle
and archived, so those two look alike; this plugin draws the missing three:

| lamp | meaning | where |
| --- | --- | --- |
| blue filled dot | idle | leading 16px seat (`sidebar.session.row.leading`) |
| hollow grey ring | parked — explicit mark, or automatic after 5 days without conversation | same seat |
| solid grey dot | archived | trailing seat (DSH keeps the leading cell blank on archived rows) |

Native pending / running / running-subagent / unread lamps are untouched: the row's higher-priority dot
replaces the leading seat, so the plugin never renders beside it. Park marks live in `localStorage`
(`dsh.status-lamp.parked.v2`); archived membership and timestamps come from the Host's session list
snapshot; no network, no session-log writes.

**Verified / 已验证**

- DSH 0.2.2-rc.1, `desktop` profile, Windows.
- Idle blue dots and the 5-day automatic hollow ring observed in the running UI.
- Manual park / unpark from the session-row context menu tested by the author.
- Slot registration confirmed live (`sidebar.session.row.leading` → `status-lamp`,
  `sidebar.session.row.trailing` → `status-lamp-archive`).
- The bundled `site/index.json` (format 1) validates against `@deepseek-ai/dsh-plugin-market-index`.
```

## 落地步骤（仓库创建后）

```sh
# 1. 在 awesome-dsh-plugin 的 fork 里加文件
#    路径: data/plugins/SpokAtom__dsh-status-lamp.yml
#    内容: 本目录的 contrib/awesome-entry.yml

# 2. 提交并推送
git add data/plugins/SpokAtom__dsh-status-lamp.yml
git commit -m "Add SpokAtom/dsh-status-lamp"
git push -u origin add-status-lamp

# 3. 开 PR（只动这一个文件，1 条，≤3 上限）
gh pr create --repo awesome-dsh-plugin/awesome-dsh-plugin \
  --head SpokAtom:add-status-lamp \
  --title "Add SpokAtom/dsh-status-lamp" \
  --body-file contrib/PR.md
```

## 合并后

网站 nightly 自动重建；`dshmarket.com/p/SpokAtom/dsh-status-lamp/` 与 dsh-market 插件的 Discover/详情页
同时出现（`dsh-plugin-catalog` 的 format 1 索引也会带上）。不需要再改任何文件。
