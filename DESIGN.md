# 状态灯（dsh-status-lamp）

把 DeskMate 九态灯的「空闲 / 挂起 / 归档」三分法落到 DSH 会话行上，其余状态沿用 DSH 原生灯。

## 一、DSH 原生灯现状（本插件未改动）

| 状态 | 判定 | 行首表现 | 颜色 |
|---|---|---|---|
| 待审批 / 计划待审 / 等待回答 | `pendingInteraction.kind` ∈ approval / plan-review / question | 琥珀实心点 6px | `--dsw-alias-state-warn-primary` |
| 进行中 | `running` 或有直接子会话在跑 | 14px 环形 spinner（1.5s） | `--dsw-alias-label-tertiary` |
| 有新结果 | `completionUnread` | 绿色实心点 6px | `--dsw-alias-state-success-primary` |
| 空闲 | 以上皆否 | **无灯** | — |
| 归档 | 归档集合成员 | **无灯**（且不挂 leading 槽） | — |

原生优先级：待审批 > 进行中 > 子代理进行中 > 有新结果 > 空闲。原生点由 `dsh-client-ui-workspace` 持有；行首 16×20 的 `sidebar.session.row.leading` 槽只在该行主状态为 idle 时挂载，归档行该格整体留空。

## 二、本插件补的三态

| 状态 | 判定 | 表现 | 渲染位置 |
|---|---|---|---|
| 空闲 | 行主状态 idle 且未挂起 | 蓝色实心点 6px `--dsw-static-blue-500` | `sidebar.session.row.leading` |
| 已挂起 | 显式标记，或自动规则命中 | 灰色空心环 6px（1.5px 描边）`--dsw-alias-state-idle-primary` | `sidebar.session.row.leading` |
| 已归档 | 会话在归档集合中 | 灰色实心点 6px `--dsw-alias-state-idle-primary` | `sidebar.session.row.trailing` |

优先级：原生四态优先于挂起；挂起优先于空闲；归档独立展示（归档行原生不渲染 leading 槽，只能落在 trailing 席位，位于时间右侧、置顶标记之前）。

## 三、挂起的两条来源

1. **自动挂起**：会话最近一次对话活动（`Session.updatedAt`）距今 ≥ **5 天**（`AUTO_PARK_MS`）。分钟级时钟驱动重算，跨过阈值会自动变灯，无需刷新。
2. **显式挂起**：会话行右键或「…」菜单 → 「挂起会话 / 取消挂起」。对应 DeskMate 的「显式挂起」。

两条来源共用同一个灰空心环。点击「取消挂起」会写入一个唤醒标记（`awake[sessionId] = 当时的 updatedAt`），使自动规则不会立刻把刚唤醒的会话重新挂起；一旦该会话产生新的对话活动（`updatedAt` 变大），唤醒标记失效，5 天规则重新生效。

挂起只是视觉态，不抑制运行：会话一旦运行，原生进行中灯接管；收尾回到挂起。自动挂起同样不会阻止你打开或继续该会话。

## 四、存储

`localStorage` key `dsh.status-lamp.parked.v2`：

```json
{ "explicit": ["<sessionId>"], "awake": { "<sessionId>": 1763000000000 } }
```

- 兼容旧版 `dsh.status-lamp.parked.v1`（纯 sessionId 数组）自动迁移。
- 切换时顺带剔除 Host 已不存在的会话 id。
- 归档状态来自 Host 的 workspace 快照，不另存；会话的时间事实来自 Host 列表快照，不在本地推算。

## 五、安装与自测

- 安装位置：`D:\dsh space\plugins\dsh-status-lamp`（link 安装进 `desktop` profile，bundle 名 `dsh-status-lamp`）。
- 自测：① 5 天以上无对话的会话应显示灰空心环；② 近几天有活动的会话显示蓝点；③ 右键任一会话 → 「挂起会话」→ 变灰空心环，再点「取消挂起」→ 恢复蓝点，且不会立刻被自动规则重新挂起；④ 视图选项切到「全部对话」，归档行时间右侧出现灰实心点。

## 六、已知限制

- 归档行的灯只能落在 trailing 席位（DSH 硬编码该格留空），与空闲/挂起的行首位置不对称；这是为守住「不替换原生行渲染」这条可升级边界而做的取舍。
- 「无对话」用 `Session.updatedAt` 近似（DSH 列表快照里唯一的最后活动时间），不区分消息、标题或元数据变更。
- 打开一个 5 天未活动的会话不会自动唤醒它；需要显式「取消挂起」或产生新对话。
- 归档态压过挂起态显示；行菜单中「挂起会话」与「归档」的先后由 order 550 决定，分隔线归原生所有。
- 挂起标记按浏览器实例存储，换浏览器/清站点数据会丢失；自动挂起规则不受影响（它是派生的）。
- 0.2.2-rc.1 上开发；DSH 升级若改动 slot 名或 `StateDot` 规则，本插件按上述席位注册仍可降级为「多一个点」而不是报错。
