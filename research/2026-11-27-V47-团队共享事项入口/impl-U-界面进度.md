# impl-U 律师端界面进度（第 73 批，V47，W3）

- 日期：2026-11-27
- 范围：只改 `platform/apps/desktop/src/**`、`platform/apps/desktop/test/**`；未动 `packages/**`、`services/**`、`apps/desktop/electron/**`；未提交；未起停本机栈与已有律师端实例。
- 依据：`01-方案与决策.md` D-307～D-310、`02-接口契约.md` §2～3、`A5-团队共享事项界面落点审计.md`（§6.3 文案、§7.6 版式）。
- 状态：代码与用例完成；**真实栈截图未拍**（等 W2 内核完成、主会话给实例端口与号码段后补）。

## 对齐内核终版（8665838f 之后，未提交）

按 `03-契约变更记录.md` W2 行与 `impl-K-内核进度.md` 补齐：
- **`api.ts` 类型**：`TeamRoster.fetched_at`；`matters.create` 应答 `members_added[]`；`matters.members.add / remove` 应答 `name`、`can_receive`、`lawyer_note`（`MatterMemberAddResult`）；`matters.update` 应答 `lawyer_note`（字段一律在 `patch` 里）；`ShareRelayStatus` 加 `drafts_error`，开通 / 续期应答 `ShareRelayActionResult`（`published`、`draft_id`、`lawyer_note`），两个方法收可选 `ttl_days`；错误原因联合类型 `TeamFaultReason`。
- **错误分支**（`lib/team-matters.ts` `teamFaultOf / teamFaultText / memberErrorText / createErrorText`，按 `code` + `detail.reason`）：`team_scope_unavailable` 四种（personal_workspace / workspace_unknown / device_not_confirmed / client_no_cloud）各一句；`member_not_in_team` 四种（not_in_roster 不在团队同事名单里 / disabled 已停用 / removed 已被移出团队 / left 已离开团队；建事项失败时用 `detail.user_id` 写出是哪位）；`roster_unavailable` offline / not_supported；`scope_irreversible`；`team_scope_conflict`（内核在补）；`validation` 的 relay_not_configured / not_enabled。认不出的原因用内核原句（研发用语兜底替换）。
- **① 类型还不知道**：`kernel.status.workspace_kind` 为 null 时不再隐藏——`useTeamKind` 取一次同事名单推断（`effectiveKind`：取得到 / 离线缓存 → 团队；名单说个人空间 → 个人；不支持 → 仍不出现，开发形态与试用版不受影响），“谁能看到”与“⋯ → 和同事一起办…”照常给，由内核判断并如实显示原因；这台电脑证书类型不知道时也不置灰（只在确知 account_ca 时置灰）。
- **② 成员页能否操作只看 `can_manage`**（`canManageMembers`；缺省时才按负责人且进行中）。
- **③ 第二位管理员**：`pending` 非空且 `signed_by_me:false` → “确认开通… / 确认续期…”，调同一个 enable / renew；过期给“续期…”，确认框写“按过期前最后一份本所规则原样恢复”，并用 `carry_relaxations.renew` 写“续期会一并恢复这些放宽项：…”（生效中续期写“续期后仍允许：…”，开通写“这次确认的规则里同时仍允许：…”）。
- **④ 记为客户要求不上云**：开始前确认（`RunSheet.tsx`）的出口在团队共享事项上置灰，下一行说原因“团队共享事项不能记为客户要求不上云（同事之间同步要经中软转送加密内容）：可以先只用本机功能；客户确实不同意上云的，请另建一个“只有我”的事项。”；内核拒（team_scope_conflict）时同一说法。
- 用例：726 / 726（b73 新增 3 条、改 1 条）；tsc 干净。

## 验证

- `node --test apps/desktop/test/*.test.ts`：**724 / 724 通过**（基线 705；新增 `b73-team-matters-ui.test.ts` 19 条，改 3 个旧文件里锁死旧写法的 5 条断言）。
- `npx tsc -p apps/desktop/tsconfig.json --noEmit`：干净。
- 律师层用语门禁 `lawyer-copy.test.ts` 照常通过（新文件 `TeamMatter.tsx`、`ShareRelayRow.tsx`、`lib/team-matters.ts` 都在受查范围内）。

## 改动清单

| 文件 | 做了什么 |
|---|---|
| `src/lib/team-matters.ts`（新） | 纯函数：谁能看到的可用性 / 说明 / 提交、`relayReady` / `relaySyncOf`（not_allowed 如实算“没开通”）、选同事过滤与小字、成员行小字、排序、`syncNotice`、胶囊文字、记号判定、加人结果一句、移出问句、改为一起办三件事、负责人能否调整、错误换人话、开通行三态、开通 / 续期确认框、放宽项人话（从设置页移来）、到期提醒、上手清单底注 |
| `src/components/TeamMatter.tsx`（新） | `ScopeField`（两处表单共用）、`ColleaguePicker` / `ColleagueList`、`TeamMark`、`TeamPill`、`MatterMembersPanel`、`AddColleaguesDialog`（加同事 / 和同事一起办），`useRoster` / `useRelayState`（同窗口 60 秒共用） |
| `src/components/ShareRelayRow.tsx`（新） | 团队策略首行“同事之间同步”、团队页顶到期提醒 `ShareRelayExpiring` |
| `src/styles-team-matters.css`（新） | 本批全部样式；全部取令牌（用例断言无十六进制色值） |
| `src/api.ts` | 类型 `TeamRoster*`、`MatterRole`、`MatterSync`、`MatterMemberRow`、`MatterMembersView`、`ShareRelayStatus`；调用 `matterMembers.list/add/setRole/remove`、`teamMatters.roster/shareRelayStatus/Enable/Renew`；策略体补 `share_relay?` |
| `src/components/NewMatter.tsx` | `quickCreateMatter` 收第二参数（协作范围 + 同事）；`useMatterScope`（两处表单共用）；完整弹窗“怎么处理”之后、“更多设置”之前加“谁能看到”；底部按钮吊底 `modal-actions-sticky`，错误句进吊底条 |
| `src/components/MatterPlace.tsx` | 精简表单加“谁能看到”；“更多设置”带上范围与选的同事；近期事项团队共享记号与副标题前缀；浮层内容变高时（展开选同事）`ResizeObserver` 重新放 |
| `src/pages/Home.tsx`、`src/components/Composer.tsx` | “更多设置”初值类型补范围与同事；输入框事项芯片与芯片菜单的记号 / 前缀 |
| `src/components/MatterHeader.tsx`、`src/pages/Matter.tsx` | 事项头胶囊；“⋯”加“事项成员”（团队共享事项）/“和同事一起办…”（个人事项、负责人、团队空间、进行中）；“事项成员”标签页 |
| `src/components/Sidebar.tsx`、`src/lib/user-card.ts` | 事项行改 flex（`sidebar-link-row` + `sidebar-link-text` 省略）+ 尾部记号；管理员电脑在到期前 7 天用户卡状态行提醒 |
| `src/pages/Matters.tsx` | 名称后灰标签“团队共享”；悬停串删“协作：…” |
| `src/components/SearchPalette.tsx`、`src/lib/search.ts` | 事项副标题前缀“团队共享 · ”（界面按事项列表拼，不改内核） |
| `src/components/GuideChecklist.tsx` | 团队成员版底注按事项范围如实说 |
| `src/pages/Connections.tsx` | 团队策略首行 `ShareRelayRow`；页顶 `ShareRelayExpiring`；开通 / 续期后 `PolicyTab` 重挂；草稿区加锚点；**起草表单初值改为当前生效规则**（01 事实 4 的静默收紧陷阱）；放宽项人话改用 lib |
| `src/components/TeamShare.tsx`、`src/components/MembersAdmin.tsx` | `not_allowed → 不知道` 的映射改为 `relayReady`（如实算没开通；规则过期回退仍算不知道）；团队共享处管理员“去开通 →”；同一页不重复“所内没开通” |
| `src/lib/workspace.ts` | `shareReadyText` 加 `peer` 分支（同事电脑短句 / 长句）；升级确认第 2 条改写 |
| `src/lib/relay-text.ts` | `teamShareLine` 的 not_allowed 改说“所内还没开通同事之间同步：开通后团队共享事项才会在同事电脑之间同步” |
| `test/b73-team-matters-ui.test.ts`（新） | 19 条：纯函数、只在团队空间出现、接线、本批文案门禁 |
| `test/b72-team-ui.test.ts`、`test/b72-ui.test.ts`、`test/v94-b26.test.ts` | “不承诺事项入口”改为断言新句子与入口存在；`<PolicyTab key>`、`TeamShare canEnable`、`quickCreateMatter(…, sc.submit)` 三处源码断言跟着改 |

## 各落点文案（定稿）

**新建事项“谁能看到”**（完整弹窗与“放进哪个事项？”同一组件；个人空间、开发形态不出现）
- 分段：只有我 | 和同事一起办（缺省只有我；一起办带两人图标）。
- 只有我：只在你的电脑上；以后可以在事项里加同事。
- 一起办：加进来的同事在自己的电脑上也能看到、一起办；内容加密后在你们的电脑之间同步，中软打不开。
- 所内没开通（规则没允许）：所内还没开通同事之间同步：加进来的同事要等管理员开通后才收得到。
- 中软没部署：中软还没为本所开通同事之间同步：加进来的同事要等开通后才收得到。
- 置灰原因：客户要求不上云的事项只在这台电脑上，不能和同事一起办。／这台电脑还不能接收团队共享事项：申请并经管理员确认后，才能和同事一起办。［去申请 →］（设置 → 团队）／暂时不能和同事一起办：Kimi Work 服务还不支持同事名单，请联系 Kimi Work 客服。
- 选同事：chip + “选同事 / 再选同事 / 收起”；空时小字“可以先不选，建好后在事项里再加”；列表每行首字头像 + 姓名 + 灰字“律师 · 电脑还不能接收”；超过 8 人出搜索框，最多 6 行高内滚。
- 名单：正在取同事名单…／联不上 Kimi Work 服务：下面是上次取到的同事名单。／联不上 Kimi Work 服务，暂时取不到同事名单：可以先建好，联网后在事项里加同事。
- 建失败（带同事）：选的同事里有人已不在团队名单里，事项没有建：请重新选同事后再建。

**事项页**
- 胶囊：团队共享 · 3 人（读屏“团队共享事项，3 位事项成员，展开查看”）；展开最多 6 人（头像、姓名、“我”、角色；灰字“电脑还不能接收 / 已离开团队”），“还有 n 人”，底部“事项成员 →”。
- “⋯”：事项成员（团队共享事项第一项）／和同事一起办…（个人事项）。
- 事项成员页：标题“事项成员 n”＋“加同事”（能调整时）；锁形图标一句“加进来的同事在自己的电脑上也能看到这个事项的材料、任务和成果；内容加密后在你们的电脑之间同步，中软打不开。”；sync 非 ok 时上方一句（所内没开通 / 中软没开通 / 暂时连不上同步服务：改动先留在这台电脑上，连上后自动同步给同事。/ 这个事项还在等第一次同步：联网时会自动同步给同事。），所内没开通且是团队管理员时“去开通 →”；行：头像 + 姓名 +“我”/“已离开团队”标签 + 长句“他的电脑还不能接收团队共享事项：请他在“设置 → 团队”里申请，管理员确认后自动收到。”；角色下拉“一起办 / 只看”（负责人、自己、复核 / 签发只读文字）；“移出”原位两步：“移出陈律师？移出后，他的电脑拿不到这个事项此后的新内容；他电脑上已有的内容不会被收回。”［确定移出］［取消］。
- 结果：已移出陈律师：他的电脑拿不到这个事项此后的新内容。／已把陈律师改为“只看”。／已加入陈律师、李助理。陈律师的电脑下次同步时收到；李助理的电脑还不能接收，申请并经管理员确认后自动收到。／所内没开通时“…所内开通同事之间同步后才会收到。”／没有加上：某某（原因）。
- 非负责人表尾：要加人或移出，请找负责人王律师。我是负责人但不能改：这个事项的成员由最先同步它的负责人李律师调整：要加人、改角色或移出，请找他；也可以请他把这件事交给你。／这台电脑暂时不能调整这个事项的成员（负责人暂时无法确认，或还在等第一次同步）：联网同步一次后再试。／事项已结案（只读）：不能再加同事、改角色或移出。
- 加同事弹窗：标题“把同事加进「…」”；“选同事”列表；“加入后是［一起办 ⌄］”；［取消］［加入（n）］（n = 0 禁用）。
- 和同事一起办弹窗：标题“和同事一起办「…」”；三件事：①同上隐私句 ②改为和同事一起办后，正在等你确认的任务需要重新确认一次。③（加粗）之后不能改回“只有我”：要结束共享，把同事逐个移出，或结案。；“同时加哪些同事（可以先不选）”；［开始一起办（n）］。这台电脑不能共享 / 不上云时只显示原因 +“去申请 →”与［关闭］。

**设置 → 团队 → 团队策略首行“同事之间同步”**（说明：团队共享事项加密后在同事电脑之间同步，中软打不开。）
- 需中软开通：未开通 · 需要中软为本所开通同事之间同步的服务，请联系 Kimi Work 客服（不给按钮）。
- 未开通：未开通 · 团队共享事项暂时不会在同事电脑之间同步［开通… / 律所版：发起开通…］。
- 已开通：已开通 · 12 月 20 日 12:00 前有效（无按钮）；7 天内：橙色“已开通 · … 前有效（还有 4 天）”［续期…］主按钮；已过期：已过期 · 同事之间同步已暂停，事项内容不受影响［续期…］。
- 待确认：已发起开通 · 还需 1 位管理员在自己的电脑上确认；第二位管理员看到“另一位管理员已发起开通 · 还需你确认”［确认开通…］。
- 开通确认框：经中软转送中软打不开／本机删除不删中软副本、关闭后保留到停止使用（沿用起草表单原句）／没更新软件的电脑暂按最严运行／（律所版）还需另一位管理员确认／只改这一项，其他各项保持现在生效的样子，有效期 30 天、到期前 7 天提醒；灰底一行“这次确认的规则里同时仍允许：…”（所见即所签）。续期确认框同理（“按现在的本所规则原样再确认一次…规则内容不变”）。
- 团队页顶（管理员，7 天内 / 已过期）：同事之间同步 3 天后到期（… 前有效）：到期后团队共享事项暂停在同事电脑之间同步，事项内容不受影响。［去续期 →］
- 侧栏用户卡（团队管理员电脑）：同事之间同步 3 天后到期 · 到“设置 → 团队”续期。
- 团队共享处（成员页）：not_allowed 时“所内还没开通同事之间同步：开通后团队共享事项才会在同事电脑之间同步”，团队管理员另有“去开通 →”。

**标识**：侧栏事项行尾灰色两人图标 + 读屏“团队共享”；事项列表名称后灰标签“团队共享”；“放进哪个事项？”、芯片菜单、全局搜索副标题前缀“团队共享 · ”；输入框事项芯片同一图标。个人空间一律不出现。

**用语改写**：升级确认第 2 条“你原有的事项仍只属于你，同事看不到；要一起办，在那件事项里把同事加进来。”；上手清单团队版底注“‘只有我’的事项只在你的电脑上；‘和同事一起办’的也在加进来的同事电脑上。团队管理员都看不到内容。”（比 A5 建议句多覆盖“别人把你加进来的事项”）。

## “密钥”是否加入律师层禁词：本批不加

把 `/密钥/` 加进 `lawyer-copy.test.ts` 的 `BANNED` 会命中现有两处：`components/MatterLifecycle.tsx` 的“加密钥匙（已销毁）”（“加密”+“钥匙”，误判）、`pages/Activate.tsx` 从备份恢复失败那一句“…没能保存恢复出来的密钥…”。按任务要求“会误伤现有文案就不加”。替代：`b73-team-matters-ui.test.ts` 把本批三个新文件纳入一条更严的门禁（密钥、纪元、包裹、中继、证书、控制成员、律所根、签发钥、席位、私有、已共享、权限、编辑者、查看者、“协作：”）。若要全库加，建议先把 Activate 那句改成“恢复出来的内容”，禁词写成 `(?<!加)密钥`。

## 需要内核（W2）配合

已对照 W2 进行中的实现（只读）核过参数名与错误码：`matters.create` 收 `collab_scope` + `members[{user_id, matter_role}]`；错误码 `team_scope_unavailable / member_not_in_team / roster_unavailable / scope_irreversible` 在 `code` 上。以下三条已写进 `03-契约变更记录.md`：
1. 改角色沿用 `matters.members.add`（同一 user_id 新角色），加固 add 时请保留。
2. `sync`：`relay.status` 为 not_allowed 且 `policy_fallback` 时回 `unknown`（否则律师看到“所内还没开通”而实际是规则过期回退）。现 `syncStateOf` 直接回 not_allowed。
3. 律师端读取的可选字段：`can_manage`、`relay_controller`、`pending{…, signed_by_me}`、`carry_relaxations`；enable / renew 返回与 status 同形。
另：`requireRelayController` 等错误原句含“中继 / 控制成员”，律师端 `memberErrorText` 兜底替换；更好的做法是内核直接给律师层句子。

## 取舍与偏离

- 续期也弹确认框（原只设想一键）：续期是管理员签名，确认框写清规则不变并列出一并确认的放宽项（所见即所签）。主操作仍 2 步。
- 第二位管理员不必去草稿区：内核 `pending.signed_by_me = false` 时这一行直接“确认开通…”（内核找一致的待签草稿）；旧内核不给 `pending` 时退回“去确认 ↓”到“待确认的规则草稿”。
- “移出”对已离开团队的同事也走原位两步（D-308“移出须原位两步确认”优先于“一键”）。
- 已结案：事项成员只读（含移出）——内核 `can_manage` 对结案为 false，界面同口径。
- 起草表单初值改为当前生效规则：顺手修 01 事实 4 的静默收紧陷阱（只在规则来自中软签发时用作底稿，回退 / 开发形态仍用最严缺省）。
- 事项列表“全部 / 团队共享”筛选（A5 §3.2 可选项）本批不做。

## 待拍（W2 完成后，主会话给端口与号码段）

浅 / 深各一套，Mac 960 宽与 Windows 100% / 150%：完整新建弹窗（含“谁能看到”、展开更多设置，确认按钮吊底）、“放进哪个事项？”选一起办并展开选同事、选同事置灰三种原因、事项头胶囊展开、事项成员页（负责人 / 非负责人 / 我是负责人但不能改）、移出原位两步、加同事弹窗、和同事一起办弹窗、团队策略首行五种状态与开通 / 续期确认框、团队页顶到期提醒、侧栏事项行（长标题 + 记号）、事项列表标签、全局搜索前缀；150% 深色一张事项页。
