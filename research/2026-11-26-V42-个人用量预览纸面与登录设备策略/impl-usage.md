# 第 68 批 · 「设置 → 套餐与用量」个人用量页重构（实施记录）

> 工作位置：worktree `kimi-legal-b68`（分支 `claude/kimi-legal-b68-auth-usage`），未提交，由主会话统一提交。
> 真实界面：本机全链路云端栈（控制面 18681、网关 18682）+ 律师端网页形态（vite 5691 / 开发桥 7791，工作区副本 ws-usage，账号“王律师”，试用套餐、单席位、本期加量 +100%）。

## 阶段一：现状核对（改前）

### 1. 数据来源链路（结论：方向正确，但有三处口径偏差）

链路：`PersonalUsage.tsx` → `api.quotaStatus()` / `api.quotaUsagePage()`（`apps/desktop/src/api.ts:1430、1432`）→ 内核 `quota.status` / `quota.usage_page`（`packages/kernel/src/api/index.ts:4020、4032`，只转发控制面签名信封 `kwl-quota-view` / `kwl-usage-page`，不做本机换算）→ 控制面 `GET /v1/quota`、`GET /v1/quota/usage`（`services/control-plane/src/server.ts:4433、4488`）→ 逐请求账本 `book.query / book.member / book.memberModels / book.window`。

- 没有积分 / 点数：比例全部是控制面 `ratio()`（`quota.ts:164`，四位小数）按账本真实用量除以分母得出。
- 没有调用 Kimi 官方账号或配额接口：用量只来自本产品网关落的账本。
- 金额：控制面仍把 `own_recent[].charge`（内部单位）、`value_cny`、`own.value_cny`、管理员可见的 `firm.used / total`（元）下发到律师电脑；客户端不显示，但属于多给（见“交主会话”）。
- 套餐说明 `plan.note` 带“84 元额度（按价目计）”，客户端靠正则去掉（见“交主会话”）。

实测（2026-11-26 01:40，真实租户 `ten_b66lawyer`）：`personal.used_ratio = 0.3089`、`own.used_ratio = 0.6178`、`firm.boost_pct = 100`、`seats = 1`；明细第一行 `charge_ratio = 0.0089`（= 0.747 / 84）。

**偏差 1（明细百分比与大数字不是同一分母，真实可见）**：`personal.used_ratio` 的分母是 `pDenom = 个人上限 ?? (单席位 ? 本所总额度（含加量）: 每席位额度)`（`server.ts:4463`），而 `own_recent[].charge_ratio` 与 `/v1/quota/usage` 的 `charge_ratio` 用的是 `ownDenom = 个人上限 ?? 每席位额度`（`server.ts:4443、4497`）。本租户加量 +100% 后：大数字写“已用 31%”，明细每行按 84 元算，20 行加起来约是大数字的两倍。
**偏差 2（进行中预留混入了本所口径）**：`personalView` 用 `firm.in_flight_ratio`（`quota.ts:394`：全所在途 ÷ 全所总额度，含同事的预留）画在个人条上。单席位时分母相同无碍；多人律所时既不是本人的，也不是同一分母。
**偏差 3（5 小时窗口与旧云端回退是全所数）**：`burst.used_ratio = windowUsed(ctx, null) ÷ 全所额度×pct`（`quota.ts:375`、`windowUsed` 第 202 行，uid 传 null = 全所）；旧云端回退的 `models`、`personalUsedRatio` 的 `firm.used_ratio` 也是全所数。多人律所里这些都是“团队用量”，与“只看本人”的要求冲突。首页额度提示条 `quotaNotice` 同样用的是 `firm.remaining_ratio / firm.paused`，且不认 `personal.paused === "seat"`（个人额度用完时页面与提示条都不说话）。

### 2. 团队用量与上限在云端控制台是否已有（结论：已全覆盖，客户端移除）

`platform/apps/console`：
- `pages/firm-overview.js`：本期额度水位、席位、历史周期、**月度上限**（`PUT /v1/firm/cap`，第 4、45 行注明与客户端 `PUT /v1/quota/cap` 写同一字段）。
- `pages/firm-usage.js`：按日、**按成员**、按模型汇总与逐请求明细，可导出 CSV（`/v1/firm/usage/summary|records`）。
- `pages/firm-members.js`：成员**个人额度上限**（第 85～97 行）。
- `pages/firm-billing.js`：本期加量（boost）与账单。
客户端“管理 → 用量与上限”（`Connections.tsx:942、955` 的 `<UsagePanel admin />`）里的本所额度、律所上限、按成员、按模型、本期加量、最近几期，控制台都有对应页面，且控制台是唯一能改个人上限的地方。故从客户端移除该子页，只在管理员看到的“套餐与用量”页底给一句“团队用量与上限请在云端控制台管理”。

### 3. 改前截图问题（evidence/usage/before/）
- 大数字 31% 只有 28px，与右侧“可用 69% / 重置 12 月 1 日 00:00”同处一行，视觉重心被摊薄；
- 一张卡里堆了 7 层：大数字、事实三项、条、图例、按模型、5 小时、权益小字；“可用”在事实区与图例里各写一次；
- 页头“需要更多额度：联系客户经理或客服”常驻，与用量无关时也占位；权益“本月额度按真实用量计算”与页脚说明重复；
- 明细 8 行后两个按钮（“展开全部 20 条”“载入更早的记录”）语义重叠；每行日期重复写“11 月 26 日”；
- 明细“计入额度”与大数字不同分母（偏差 1）。

## 阶段二：实施（代码已改，类型检查 0 错，相关用例全过）

改动见下文“改动文件清单”；版式与取舍见“阶段三”。用例：新增 `b68-personal-usage.test.ts`（7 条），更新 `b47-kimi-shell`、`b44-account-usage`、`b67-card-forms` 中与旧版式绑定的断言。
`b67-card-forms` 里“52 张卡都有形态”（实际 53）失败与本页无关：第 65 批新增“诉讼成本与回收测算卡”后基线即为 53，留给主会话。

## 阶段三：逐项信息取舍

| 信息 | 改前 | 改后 | 理由 |
|---|---|---|---|
| 本期已用 % | 28px，与右侧三项事实同一行 | **用量卡里唯一的大字**（--fs-2xl，数字 600 字重、“%”降一级灰色），独占一行 | 律师最先要回答的是“用了多少”；去掉同排竞争者后它就是重心（字号令牌 7 级封顶 28px，design-tokens 用例禁止加档，重心靠构图而非字号） |
| 剩余 % | 事实区与图例各写一次 | 条下左侧一次，“剩余 **69%**” | 只写一次；被管理员上限 / 个人额度 / 共用额度压低时同一行说明原因，条尾画斜纹 |
| 进行中预留 | 事实区 + 图例 + 条上浅色段 | 条上浅色段 + 剩余后面一个旁注（仅 >0.5% 且单席位） | 多人律所的在途是全所的，不再混进个人条 |
| 重置时间 | 事实区“重置 12 月 1 日 00:00” | 条下右侧“12 月 1 日 00:00 重置”+“还有 4 天”小胶囊 | 倒计时比日期更直接回答“还要撑多久” |
| 统计周期 | 页头“本期 11 月 1 日 – 11 月 30 日” | 卡头“本月用量 · 11 月 1 日 – 11 月 30 日” | 周期就是这张卡的标题语境 |
| “今天”刻度（新增） | 无 | 条上一根细刻度 + “今天”二字（本期时间已过去的比例，来自 period.start / resets_at） | 设计巧思：一眼对照“用量走到哪 vs 时间走到哪”，判断月底够不够，不做预测、不造数 |
| 套餐名 | 页头大字“试用” | 卡头右侧小胶囊；页底“套餐”设置行再写全 | 套餐名是语境，不是重心 |
| 套餐说明 | 页头灰字 | 页底“当前套餐”下灰字，经 `planNoteText` 去掉“84 元额度（按价目计）”“2,000 万 token” | 不显示金额；原始计数与全页百分比口径不一致，也去掉 |
| 可用模型 | 权益小字 | 页底“可用模型”设置行 | 是套餐属性，不是用量 |
| 需要更多额度 | 页头常驻 | 页底设置行；剩余 <10% 时状态句里再提一次 | 只在相关时打扰 |
| “本月额度按真实用量计算” | 权益小字 | 删除（并入明细脚注） | 与脚注重复 |
| “任意 5 小时至多用本月额度的 50%” | 权益小字 + 5 小时栏副标题（两次） | 只在 5 小时一行的副标题 | 去重 |
| 5 小时频率限制 | 一栏 | 卡内分隔线下一行：标签 · 细条 · 数值 + 恢复时刻 / “最近 5 小时未用” | 对照 Kimi Code 的短周期限额行；**只在单席位显示**（窗口是全所共用的，多人律所只在被放缓时出状态句） |
| 按模型 | 条按模型分段 + 图例 / 一行灰字 | 单模型：明细标题右侧一句“本月 77 次 AI 调用，全部用 K3 高速”；多模型：明细上方一根细构成条 + 图例（名称、占比、次数） | 主条只表达“状态”（正常 / 将用完 / 用完），不再兼任构成 |
| 使用明细 | 8 行 + “展开全部 N 条”“载入更早的记录”两个按钮；每行写全日期 | 按北京日期分组（今天 / 昨天 / 11 月 24 日，上期加“上期”标记），行内只写 HH:mm；一个“显示更多”（先放出已载入的，再向云端翻页）；没有更早时写“以上是近 180 天的全部记录” | 去重复、一个动作 |
| 计入额度 | 与大数字不同分母 | 用 `rowScale` 折到大数字的分母（真实租户系数 0.5）；未计入写原因（中途中断 / 待核对 / 未成功），灰色 | 修偏差 1；行加总与大数字同一把尺子 |
| 状态句 | 只认 allowance / cap / burst | 认 allowance / cap / **seat** / burst / 剩余 <10% / 多人律所用超个人份额；用浅底色一行 | 修个人额度用完时页面不说话 |
| 团队用量与上限 | 管理 → 用量与上限 | 移除；管理员在页底“团队用量与上限：请在云端控制台管理（按成员用量、律所上限、个人额度）。” | 见阶段一第 2 节 |

## 阶段四：新版式结构

```
套餐与用量（版心 920px，与其他设置页一致）
┌ 用量卡（唯一的卡片）────────────────────────────────┐
│ 本月用量  11 月 1 日 – 11 月 30 日                 [试用] │
│ [状态句：仅在停用 / 放缓 / 将用完 / 超份额时]             │
│ 31% 已用                                                 │
│                                       今天                │
│ ███████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░|░░░░░            │
│ 剩余 69% · [进行中预留] · [受…限制]   12 月 1 日 00:00 重置 [还有 4 天] │
│ ──────────────────────────────────────────────────────── │
│ 5 小时频率限制          ▁▁▁▁▁▁▁▁▁▁▁▁            0%      │
│ 任意 5 小时至多用本月额度的 50%            最近 5 小时未用 │
└──────────────────────────────────────────────────────┘
使用明细                        本月 77 次 AI 调用，全部用 K3 高速
[多模型时：构成细条 + 图例]
时间 | 用在 | 模型 | 计入额度
今天
03:51  任务  K3 高速  0.4%   …
[显示更多]
只记用量，不含提问与文书内容。…
套餐（设置行，同“通用”页）
当前套餐 / 可用模型 / 需要更多额度 / [管理员] 团队用量与上限
```
颜色：正常为品牌蓝；用到 80% 或剩余 <10% 转橙；用完 / 被停转红（数字与条同色）；5 小时一行独立着色。全部走令牌，深色模式条底用 `--bg-active`（`--bg-muted` 在深色卡面上几乎看不见，自查后改）。

## 阶段五：改动文件清单

- `platform/apps/desktop/src/pages/PersonalUsage.tsx`：整页重写（新增 `admin` 属性；无假数据，明细翻页走真实 `quota.usage_page`）。
- `platform/apps/desktop/src/styles-usage.css`：整份重写（只用令牌；无颜色函数、无新令牌、无降不透明度，过 style-tokens 用例）。
- `platform/apps/desktop/src/lib/personal-usage.ts`：`personalView` 增 `left / solo / capped`；新增 `usageTone`、`usageStatus`、`limitedNote`、`rowScale`、`rowCharge`、`planNoteText`、`bjClock`、`bjDayTime`、`resetCountdown`、`periodElapsed`、`dayGroups`、`ownModels`；`personalUsedRatio` 移入（多人律所回退本人分母）。
- `platform/apps/desktop/src/lib/quota-notice.ts`：首页提示条与菜单小字改用 `personalView`（认 `seat`；剩余按本人；软份额不报“不足 10%”）；`personalUsedRatio` 从这里转出保持兼容。
- `platform/apps/desktop/src/pages/Connections.tsx`：删“管理 → 用量与上限”子页与 `UsagePanel` 引用；`<PersonalUsage admin={isAdmin} />`；三处注释口径。
- `platform/apps/desktop/src/pages/FirmUsage.tsx`：删 `UsagePanel`、`UsageBar`、`CAP_PRESETS` 与不再用的引用，只剩 `CpAuditPanel`（操作记录）。
- 用例：新增 `test/b68-personal-usage.test.ts`（7 条）；改 `b44-account-usage`、`b47-kimi-shell`（断言改为无 UsagePanel、传 admin）、`b67-card-forms`（旧版式断言换成底线断言，详细守护移到 b68）。
- 未改：`Sidebar.tsx`（菜单小字经 `quotaMenuLine` 已是个人口径）、`styles.css`、design-tokens、控制面。

## 阶段六：验证

- 类型检查：`cd platform/apps/desktop && npx tsc --noEmit` → 0 错。
- 用例（`cd platform && node --test …`）：b68-personal-usage、b66-ux、b67-card-forms、b47-kimi-shell、b44-account-usage、lawyer-copy、style-tokens、b46-client-polish、v16-ui、review-extras、b56-ui-pages、batch9-lib 共 111 条，110 过；唯一失败“52 张卡都有形态”（实际 53）是第 65 批加卡后的基线问题，与本页无关。
- 截图（`evidence/usage/`）：
  - `before/usage-{1440x900,1024x768}-{light,dark}.png`、`before/text.txt`
  - `after/usage-{1440x900,1024x768}-{light,dark}.png`（首屏）、`after/usage-{1440x900-light,1440x900-dark,1024x768-light}-bottom.png`（“显示更多”两次后滚到底：真实翻页、套餐设置行、管理员提示句）、`after/text.txt`、`after/text-paged.txt`
  - `after/admin-1440x900-light.png` + `admin-tabs.txt`：管理子页为“成员 | 律所策略 | 操作记录 | 技术支持 | 代号准确度”
  - `after/states/*.png`：exhausted（用完，红）、burst-paused（5 小时放缓，橙句 + 在途浅段）、high-cap（管理员上限压低剩余，斜纹 + 原因）、no-usage、multi-seat-models（多人律所：无 5 小时行、无全所在途、模型构成条）、old-cloud（无 personal 块回退）、not-connected（空状态）。这些状态图只在验证脚本里改写开发桥返回的 `quota.status`（`page.route`），产品代码不含任何假数据；因只改了 personal 未改 own，状态图里明细百分比随折算系数变化，属验证数据所致。
- 界面上未发起任何任务、未点任何开始 / 提交按钮；“显示更多”只触发只读的 `quota.usage_page`。

## 交主会话（控制面，不在本次改动内）

1. **明细分母统一（偏差 1 根治）**：`server.ts:4443`（own_recent）与 `:4497`（/v1/quota/usage）的 `ownDenom` 改为与 personal 相同的 `pDenom`（`:4463`），并在信封里加 `ratio_basis: "personal"`；客户端 `rowScale` 见到该标记即不再折算（已写好、有用例）。不加标记直接改分母会被客户端二次折算。
2. **个人在途**：personal 块追加 `in_flight_ratio = outstanding(q, sid) / pDenom`，客户端即可在多人律所也画个人预留（现在多人律所不画）。
3. **个人 5 小时窗口**：多人律所的 5 小时窗口是全所数（`windowUsed(ctx, null)`），客户端已不显示；若要给本人看，需要控制面定义本人口径或下发“我被窗口卡住时的恢复时刻”。
4. **软份额语义**：多人律所、未设个人上限时 `personal.used_ratio` 以每席位额度为分母，可超过 100%（不是限制）。客户端用 `own.enforced` 区分（`capped`），建议控制面在 personal 里直接给 `enforced`。
5. **少发数据**：律师设备拿到的 `own_recent[].charge / value_cny`、`own.value_cny`、`plan.note` 里的“xx 元额度（按价目计）”都不需要；建议成员视图不下发金额，`plan` 增一个不含金额的说明字段。
6. 客户端 `quota.set_cap`（内核 `api/index.ts:4041`）已无界面入口，上限统一走控制台 `PUT /v1/firm/cap`；内核方法是否保留由主会话定。

## 遗留

- 大数字受 7 级字号上限约束只有 28px；若产品要更强的展示数字，需要在 design-tokens 里正式加一档“展示字号”（现有用例明确禁止加档，需拍板）。
- `styles-settings.css:109-117` 里给旧 `UsagePanel` 的 `.set-usage .usage-panel …` 规则已无对象（共享样式文件未动），`lib/firm-usage.ts` 里 `quotaLawyerLine` 等函数界面已不用、只剩用例引用，可在主会话清理时一并删。
- 多模型构成条与 Windows 安装包形态未在真实多模型 / 多席位租户上看过（只用改写返回的状态图核对）。
