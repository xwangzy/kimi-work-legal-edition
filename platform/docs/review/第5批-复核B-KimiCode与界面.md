# 第 5 批 · 复核 B：Kimi Code 集成与产品界面（方案符合性与正确性）

- 复核日期：2026-10-14；对象：工作区未提交改动中“专项 · 第 5 批”的 Kimi Code 集成（K8-5 NotifyUser、K7-3 压缩验收）与产品界面（Y4 #2 时间线实际发出内容、Y4 #15 / Y5 P1-10、P1-11③ “将发送什么”、Y5 P1-4 文件对话框产品侧）。
- 依据：v9.2 §1.5 R6/R20、§3.3–3.4、§4.2、§4.4；Y3 §3.3（K8-5）、§3.4、§3.5、§3.6；Y4 §3.1、§3.3、§3.4、§4.6、§7.1 #2/#11/#15；进度文档“专项 · 第 5 批”与 D-62～D-67；`third_party/PATCHES.md`。
- 方法：只读审查代码、文档与锁版上游（`third_party/kimi-code`）。运行的已有用例（全部通过）：`apps/desktop/test/{timeline-sent,file-dialogs,release-config,desktop-lib,run-progress-view}.test.ts`、`kap-host/test/{embed-drift,progress}.test.ts`、`kernel/test/kap-compaction.test.ts`（1/1）、`kernel/test/kap-a1.test.ts` 中“过程事件与流式回复”（1/1）、`kernel/test/send-preview.test.ts`（2/2）、`kernel/test/kap-gate.test.ts`（1/1）。另在内存中（不写盘）复算了补丁摘要并比对补丁导出与 fork 工作树；运行了 fork 自带的 `scripts/check-no-comments.mjs`（只读）。
- 未修改任何项目文件；缺口只给修复与补测建议。

## 结论：有条件通过

本批五项改动的主体链路成立：NotifyUser 已注册且只展示、不授权，补丁导出与制品摘要一致；压缩验收用例真实触发压缩并证明压缩请求同样令牌化、经网关；`ZR_KAP_TEST_CONTEXT` 在安装包形态有三层隔离；联网步骤按工具调用编号显示改写后实际发出的查询；“将发送什么”与疑似姓名核对在估价、发起两处由内核把关；文件对话框只交句柄。

需要在关闭本批前处理的是 4 条“重要”：
1. 打开 NotifyUser 后，时间线律师层会出现英文工程步骤“NotifyUser / Notifying the user”；
2. NotifyUser 的上游契约（约 1000 字 Markdown、面板保留全部更新）与宿主展示（300 字截断、纯文本、只显示 3 条、终态即消失）不一致；
3. 能力账本把“上下文压缩”标为 native，证据栏写的是“压缩后不丢限制、引用与不确定性”，用例只证明了其中一小部分；
4. 发送视图只做了 Y4 §3.3 / #15 的一部分（缺“选中文字加入当事人名单”等），且未写进“未做”或偏离登记。

| 级别 | 数量 | 编号 |
|---|---|---|
| 阻断 | 0 | — |
| 重要 | 4 | S5B-01、S5B-02、S5B-03、S5B-04 |
| 一般 | 10 | S5B-05～S5B-13、S5B-17 |
| 建议 | 4 | S5B-14、S5B-15、S5B-16、S5B-18 |

逐项结论速览：

| 项 | 结论 | 要点 |
|---|---|---|
| 1 NotifyUser | 部分成立 | 一行补丁、补丁导出、BUILD.json 摘要与 fork 一致；宿主策略 UI 级只放行该工具本身（`ToolAccesses.none()`），不授权；通知文字只进内存快照、不落账本，界面经代号还原显示。缺口：时间线出现英文步骤（S5B-01）；展示契约不一致（S5B-02）；P1 遍历未纳入 NotifyUser、证据用例自动批准所有卡片、漂移报警不锁生效条件（S5B-14） |
| 2 压缩验收 | 部分成立 | 配置链路六跳完整、安装包形态三层不传或忽略；用例证明“会压缩、压缩请求令牌化、经网关、时间线不含摘要正文”。“压缩后不丢限制”只证明了系统提示（本就不参与压缩）仍在；账本标 native 过度（S5B-03）；安装包忽略路径无回归用例（S5B-15） |
| 3 时间线实际发出内容 | 基本成立 | 宿主出口只在工具调用与参数摘要对上宿主放行的那次调用后才带 `x-kwl-tool-call`，闸门只作关联；`sentByToolCall` 对拦截、预写/补全处理正确；取记录时机合理。缺口：被律师拒绝的检索仍提示“见数据去向”、“按原文发出”措辞过度（S5B-11）；其余工具的英文自述仍在律师层（S5B-12） |
| 4 “将发送什么” | 部分成立 | 三处接入、L3a 拦截、核对后重新估价成立；DOM 中无代号真值（真值只在悬停后按单个代号取回）。缺口：规格未完成且未登记（S5B-04）；胶囊显示与可达性（S5B-05）；预览面板在 aria-live 区内（S5B-06）；可能显示不会发送的材料（S5B-07）；核对被拒的条目无反馈（S5B-08）；对比度与窄屏（S5B-13）；追问时的摘要少计（S5B-17） |
| 5 文件对话框产品侧 | 部分成立 | 取消返回空即不动作、web 开发形态回退到文件输入框与浏览器下载均成立。缺口：`window.confirm` 默认按钮是有风险的一侧且与产品其他确认方式不一致（S5B-09）；选择失败、截断、回执保存结果、下载成功都没有反馈（S5B-10） |

---

## 问题清单

### S5B-01 NotifyUser 生效后，时间线律师层出现英文工程步骤（重要）

- 位置：`apps/desktop/src/lib/timeline.ts:8-26`（`TOOL_LABELS` 无 `NotifyUser`）、`:143-160`（`agent.tool_started` 分支只跳过 AskUserQuestion/ExitPlanMode/EnterPlanMode，`desc` 只去掉“Xxx: ”形式的前缀）；上游 `agent-core-v2/src/features/notify/tools/notify-user/notifyUserTool.ts`（`description: 'Notifying the user'`）；`kap-host/src/runtime.ts:546`（`run.tool_started` 带 `description`）。
- 事实：每次 NotifyUser 调用，宿主都发出 `run.tool_started{tool:"NotifyUser", description:"Notifying the user"}`，内核原样镜像为 `agent.tool_started`（`executor/run-progress.ts` 的 `slimAgentPayload` 保留 description）。`buildSteps` 生成 `level:"lawyer"` 的步骤：标题 `toolLabel("NotifyUser")` 返回英文原名“NotifyUser”，详情是“Notifying the user”（不含冒号，正则不剥）。锁版上游的催促机制（`notifyUserNudge.ts`：连续 8 次工具调用没有通知即注入提醒）会让这类步骤频繁出现。
- 为什么有问题：违反 v9.2 §4.4“界面去掉 G0/G1/Agent 等工程用语”、Y4 #10“技术术语清零”；R20 的设计是“过程信息里程碑进时间线、文字不进时间线”，进展通知本身应只在进展面板出现，时间线上的同名空步骤与面板重复。
- 建议修复：`buildSteps` 把 `NotifyUser` 与 AskUserQuestion 同样跳过（或至少降为 `detail` 级并给中文名“向你汇报进展”）。
- 应补测试：`apps/desktop/test/timeline-sent.test.ts`（或 desktop-lib）增例：`agent.tool_started{tool:"NotifyUser"}` 不产生律师层步骤；再加一条表驱动断言：`kap-host/src/tool-table.ts` 的 `BUILTIN_TOOLS` 每个名字要么在 `TOOL_LABELS` 里、要么在跳过名单里（防止下一个新工具再以英文名出现）。

### S5B-02 NotifyUser 的上游契约与宿主展示不一致：截断、Markdown 失效、终态即消失（重要）

- 位置：上游 `features/notify/tools/notify-user/notify-user.md`、`notify-user.ts:12-19`、`notifyUserNudge.ts:83-89`；宿主 `kap-host/src/progress.ts:30,85-90`（`note: 300`、`notes: 5`）；内核 `executor/run-progress.ts:58`（再截 300）；界面 `apps/desktop/src/lib/progress.ts:51`（只取最后 3 条）、`pages/RunView.tsx:464`（`!terminal` 才显示面板）、`:769-775`（`renderTokens` 纯文本）、`styles.css:512`（`.progress-note` 无 `white-space` 设置）。
- 事实：模型看到的工具说明要求“短段落 + 若干项目符号的轻量 Markdown、约 1000 字以内”，并告诉模型“面板按顺序保留全部更新、工作结束后仍可见、用户可翻看完整内容”；催促提示同样要求“约 1000 字、结构化”。宿主只保留前 300 字（无“已截断”标记），界面只显示最近 3 条、按纯文本渲染（换行折叠、`- `、`**` 原样显示），任务结束后面板不再出现。子 Agent 的通知与主 Agent 的同样标“助手进展：”，而上游说明称“界面会自动加来源标签”。
- 为什么有问题：律师会经常看到被截断、带 Markdown 符号的半段文字；模型按说明可能把阶段性结论放进通知、以为律师事后还能翻看，而这些文字既不进账本、终态后也看不到。Y3 §3.4 的“助手进展：{text}，最近 3 条”只规定了展示，没有处理与上游说明的冲突；本批把工具打开后冲突才变成现实。
- 建议修复（任选其一并写进 PATCHES 或偏离登记）：① 在可信指令（`content/skills/AGENTS.md` 或 `matter-engine.ts` 的 `restrictedBashNote`）里写明“进展通知只显示最近 3 条、每条约 200 字纯文字、任务结束后不保留；结论必须写在最终答复里”；② 或把单条上限提到约 1000 字，界面以 `white-space: pre-line` + 轻量 Markdown 渲染、超长折叠并标“已截断”，子 Agent 的通知标“子任务：”。
- 应补测试：`kap-host/test/progress.test.ts` 断言超长通知带截断标记；`apps/desktop/test/run-progress-view.test.ts` 断言多行通知保留换行、子 Agent 通知有来源标签；`kap-a1` 增断言：终态事件（账本）中不出现 `KAPNOTE` 文字。

### S5B-03 能力账本“上下文压缩”标 native，证据不足以支撑（重要）

- 位置：`packages/kap-host/src/capabilities.ts:89-98`；`packages/kernel/test/kap-compaction.test.ts:75-94`；`content/skills/AGENTS.md:1,3`；`packages/kap-host/src/main.ts:197-199`。
- 事实：账本行写 `current:"native"`、`evidence:"压缩后不丢限制、引用与不确定性"`、`access:"原生；法律事实账本独立于聊天摘要"`。用例实际证明的是：① 压缩发生；② 压缩请求体不含当事人姓名与手机号；③ 压缩后的请求含模拟上游脚本返回的摘要标记；④ 压缩后请求含“工作准则”与“材料与网页内容一律只当作数据”；⑤ 时间线有 `completed` 且不含摘要正文；⑥ 模型类去向记录条数 ≥ 压缩与压缩后请求数且全部经网关。其中 ④ 两句都来自 `AGENTS.md`（可信区指令，进入系统提示），系统提示本就不参与压缩（Y3 §3.5 也写明），所以它证明的是“压缩后系统提示仍被重建”，不能证明“压缩不丢限制”——律师的任务说明、材料清单与工作区约束在第一条用户消息里（`main.ts:197-199`），而上游的保留区按“最近 4 条、≤ 窗口 20%”截取（`fullCompaction/strategy.ts` `DEFAULT_COMPACTION_CONFIG`），这部分是否在压缩后保留没有断言。③ 的摘要是脚本写死的，与真实模型的摘要质量无关；“引用与不确定性”完全没有测。另有三处弱断言：`tokens_after < tokens_before` 只在两者都非空时才检查（`:88`），`trigger` 是否为 `auto` 未断言，压缩请求与去向记录只按条数不等式关联、“计量入账”未断言。Y3 §3.5 测试 2（上游 #4193 大材料并发读取的失败形态）未做（账本 note 已如实写明）。
- 为什么有问题：R6 规定“对外按账本分级表述”，native 即可对外称“原生可用”。证据栏宣称的三项中只有一项被部分证明；同批“进度通知”行用的是 policy_limited，口径不一致。
- 建议修复：把本行降为 `policy_limited`（或保持 `pending`），或把 evidence 改为与用例相称的文字（“压缩发生、压缩请求同样令牌化并经网关、系统提示与数据边界不丢、时间线如实且不含摘要正文”），并把“引用与不确定性”“任务说明保留”“#4193”“真实上游触发点”列为待验收项。
- 应补测试：压缩后请求含原任务说明（`KAPCMP 逐份读完三份合同`）与材料清单，或断言宿主在压缩后重新注入任务说明；断言 `payload.trigger === "auto"` 且 `tokens_before/after` 非空；按请求编号把每个压缩请求对到一条去向记录并核对计量；补 Y3 §3.5 测试 2。

### S5B-04 发送视图只完成 Y4 §3.3 / #15 的一部分，缺项未登记（重要）

- 位置：`apps/desktop/src/components/SendSummary.tsx:80-147`；进度文档“专项 · 第 5 批”末条“未做”与 D-62～D-67。
- 事实：Y4 §3.3 与 #15 规定的以下内容没有实现：选中发送稿中的文字 →“加入当事人名单”；“原文 / 发送稿”切换（原文中被替换处浅色标出）；公司名称“改为也替换”开关；右侧 560px 抽屉（现为对话框内的内嵌面板）；悬停 300 ms 气泡“本机还原：张晓明（承租人）· 出现 4 次”；在审查工作台（W-4）与数据去向卡中复用；验收项“摘要计数与闸门去向记录比对一致”。现有“核对”只覆盖规则候选器找出的疑似姓名，候选器和当事人名单都没认出的名字，律师在发送视图里看得到却无法一步加入。这些缺项不在“未做”清单里（该清单只列了 Y4 #12、#16–#29），也没有偏离登记。
- 为什么有问题：Y4 §3.1 的原则“识别漏了，律师一步就能补（应对 S8 召回不足）”正是靠“选中文字加入名单”兑现；进度文档的偏离登记要求“避免静默改口径”。
- 建议修复：补齐“选中文字加入当事人名单”（复用 `matters.parties.upsert`，提示“已加入，下次发送前替换”并记审计），其余项或实现、或在“未做”与偏离登记中逐条写明与回归计划。
- 应补测试：Y4 #15 验收用例——合成合同的估价计数与真实运行后闸门去向记录的 `tokenized` 计数一致；加入名单后再次 `materials.send_preview`，该名字变为代号。

### S5B-05 代号胶囊：显示与实际令牌不同、还原后常显、失败无提示、读屏不可用（一般）

- 位置：`apps/desktop/src/components/SendSummary.tsx:64-78`；`lib/labels.ts:6-16`；`styles.css:554-556`。
- 事实：① 胶囊只显示类别（“自然人”“电话”），不显示代号本身；模型实际看到的是 `〔自然人·XXXXXX〕`，两位不同当事人在发送稿里看起来一样，必须逐个悬停才能区分；摘要行用“姓名”，胶囊用“自然人”，同一面板两种说法。② 悬停或聚焦一次后真值以 `：张三` 形式常驻在胶囊内，不随移开而隐藏（Y4 规格是悬停气泡）。③ 无 300 ms 延迟，鼠标扫过即逐个调用还原接口（限流 600 次/分钟，正常不会触发，但审计只记窗口起止）。④ 还原失败时 `setValue(null)`，此后不再重试，`title` 仍是“悬停查看本机还原”，律师不知道失败。⑤ `span tabIndex=0` 没有 `role` 与可读名称，`title` 在键盘聚焦时不显示，真值出现后不播报。
- 为什么有问题：发送视图标题是“AI 会看到的内容”，显示却不是模型看到的样子；还原后常显让屏幕上的明文多于“按需逐个还原”的设计；Y4 §4.6 要求可读屏与键盘可用。
- 建议修复：胶囊文字显示 `自然人·3F7K`（或本视图内按出现顺序编为“自然人甲/乙”并注明）；类别统一用一套中文名；真值放在 `role="tooltip"` 气泡里，经 `aria-describedby` 关联，移开或失焦即隐藏；300 ms 延迟；失败显示“暂时无法还原，请稍后再试”并允许重试。
- 应补测试：把分段与胶囊文案抽成纯函数后单测（不同代号文字可区分、失败态文案）。

### S5B-06 预览与核对面板放在 `aria-live` 区域内（一般）

- 位置：`apps/desktop/src/components/ScenarioStart.tsx:204-227`（`.ss-est aria-live="polite"` 包住 `SendSummary`，后者又包含发送视图与核对表）；`SendSummary.tsx:25`（`div` 上的 `aria-label` 没有 role，读屏忽略）。
- 事实：发送视图展开后整段（最多 4,000 字）发送稿和核对表都在播报区内；律师每改一次补充要求，400 ms 去抖后重新估价，播报区内容整体替换。
- 为什么有问题：读屏用户会被反复朗读整段材料；Y4 §4.6 只要求阶段行与提示条使用 `aria-live`。
- 建议修复：播报区只保留“预计花费 + 一行摘要”，`SendSummary` 移到播报区外；容器用 `role="group"` 或 `section` 承载 `aria-label`。
- 应补测试：组件层暂无测试框架时，在验收清单里加 axe 扫描与读屏手测项。

### S5B-07 发送视图可能显示不会被发送的材料；多份材料只标“材料 N”（一般）

- 位置：`apps/desktop/src/components/SendSummary.tsx:21,41,46,110-117`；`ScenarioStart.tsx:217-218`。
- 事实：`preview` 记的是点击时的 `documentIds[0]`。在开始面板里，律师取消勾选该材料后会重新估价，`SendSummary` 实例保留，发送视图按计数换 `key` 重新挂载但 `initial` 仍是已取消的材料；页签按新的 `documentIds` 渲染，当前材料不在其中、没有选中态。页签文字是“材料 1 / 材料 2”，不是文件名。
- 为什么有问题：标题“AI 会看到的内容”下显示一份不会发出的材料；律师无法分辨页签对应哪份文件。
- 建议修复：`documentIds` 不再包含当前材料时重置或切到第一份；页签显示文件名（`sendPreview` 已返回 `filename`，估价结果也可带上）。
- 应补测试：抽出“当前预览材料”的选择逻辑为纯函数并单测。

### S5B-08 疑似姓名核对：被内核拒收的条目没有反馈（一般）

- 位置：`apps/desktop/src/components/SendSummary.tsx:162-176`；`api.ts:464-465`；内核 `api/index.ts:2216-2233`。
- 事实：`matters.suspects.review` 对加入当事人名单失败的条目返回 `rejected`（含原因），界面忽略返回值直接 `onDone()` 并重新估价；L3a 事项该名字仍未核对，开始按钮仍被禁用，律师看不到原因，可能反复核对。
- 建议修复：`rejected` 非空时保留面板，逐条显示原因；全部成功时给一句“已加入当事人名单 N 个、不再提示 M 个”。
- 应补测试：内核用例构造一条会被 `upsertParty` 拒绝的值，断言 `rejected` 返回；界面侧把结果文案抽成纯函数单测。

### S5B-09 保存位置的云同步风险用 `window.confirm`：默认按钮是有风险的一侧，与产品其他确认方式不一致（一般）

- 位置：`apps/desktop/src/api.ts:31-46`（`SAVE_RISK_TEXT`、`chooseSaveTarget`），调用处 `api.ts:415,425,490,500`；另 `pages/RunView.tsx:416`（取消任务同样用 `window.confirm`）。
- 事实：
  - Electron 的 `window.confirm` 是原生对话框，确认按钮是默认按钮，回车即“仍保存在 OneDrive”。按钮文字与标题由 Electron 默认实现决定（据其实现为英文 OK/Cancel，须在 Windows 安装包上截图核实）。
  - 产品其他确认用的是应用内样式：诊断导出是行内“确认导出 / 取消”（`Connections.tsx:104-133`），删除事项是输入标题的弹窗，Agent 确认卡是卡片。
  - 律师选“取消”后与在系统对话框里取消一样返回 `null`，调用方都不提示，需要从头再点一次。
  - 同一句“以原文（含当事人真实名称）同步到云端”也用于诊断包和删除回执，而这两类文件按设计不含案件内容，提示与事实不符。
- 为什么有问题：Y4 §3.1“主按钮永远是最安全、又能让任务继续的选项”；律师免培训要求确认方式一致、中文。
- 建议修复：改为应用内弹窗，主按钮“换个位置”（重新打开保存对话框），次按钮“仍保存在这里”；文案按文件类别区分（成果与归档：含真实名称；诊断包与回执：不含案件内容，可只提示“会同步到云端”或不提示）；停止任务的确认同样改为应用内二次确认（Y4 #8 已要求“可撤回”）。
- 应补测试：`chooseSaveTarget` 抽为可注入确认函数的纯逻辑，单测“有风险 + 拒绝 → 重新选择”“诊断包不出现‘含当事人真实名称’”。

### S5B-10 文件对话框的失败与成功反馈不完整（一般）

- 位置：`apps/desktop/src/api.ts:55-62`；调用处 `components/ScenarioStart.tsx:137`、`components/Composer.tsx:108`、`pages/Matter.tsx:223`；`electron/main.cjs:388`；`components/MatterLifecycle.tsx:209`；`pages/RunView.tsx:671-676`、`pages/Review.tsx:197-201`；`Composer.tsx:113`、`ScenarioStart.tsx:142`。
- 事实：
  - ① `pickMaterials` 中 `pickFiles` 抛错时，三个调用处都是 `void pickMaterials(...)`，异常成为未处理的 Promise 拒绝，界面无提示。
  - ② 主进程一次最多取 50 个文件（`slice(0, 50)`），多选超过时静默丢弃。
  - ③ 删除回执“下载”调用 `void api.saveSmallText(...)`，忽略返回值：主进程写盘失败（`ok:false`）与保存成功都没有任何提示。回执是给客户的删除凭证。
  - ④ 成果“下载（留痕）”在桌面形态改为系统保存对话框后，成功时没有“已保存到 ×××”。此前浏览器下载栏会给出反馈。
  - ⑤ web 开发形态的文件输入框 `accept` 不含 xlsx、csv，与 `MATERIAL_EXTENSIONS` 不一致。
- 取消与 web 回退：取消返回空数组或 `null` 即不动作，web 回退到文件输入框或浏览器下载，均成立。
- 建议修复：`pickMaterials` 内部捕获异常并交回调用方显示“没有打开文件选择窗口，请重试”；超过 50 个时提示“一次最多 50 个，已添加前 50 个”；回执保存显示“已保存 / 没有保存成功，请换个位置重试”；成果保存成功提示文件名；统一扩展名常量。
- 应补测试：`file-dialogs.test.ts` 增“超过 50 个的截断信息”；`saveSmallText` 返回三态（取消 / 失败 / 成功）并单测。

### S5B-11 时间线：被拒绝的联网步骤仍提示“见数据去向”；“按原文发出”措辞过度（一般）

- 位置：`apps/desktop/src/lib/timeline.ts:111-116,150-160`；`packages/egress-gate/src/search-guard.ts:88-99`；`kernel/test/kap-gate.test.ts:106-110`。
- 事实：律师拒绝的检索、以及宿主层拒绝的调用（未绑定、参数摘要不符）根本不到闸门（kap-gate 用例第 108-110 行注释明确），没有去向记录；步骤 meta 仍写“实际发出的内容见右侧‘数据去向’”，而那里没有这一条。`confirmed_original` 的后缀写“（经你确认按原文发出）”，但闸门在原文放行时仍把自然人改为“某人”、去除标识符与代号，实际发出的并不是原文。
- 为什么有问题：律师可能误以为有内容发出，或误以为当事人姓名按原文发出。Y4 §3.4 规则 8 要求时间线显示实际发出的内容。
- 建议修复：没有去向记录且该步 `tool_result.is_error` 或对应确认被拒时，写“没有发出”；后缀改为“（经你确认，保留公司名称发出）”。
- 应补测试：`timeline-sent.test.ts` 增两例（被拒且无记录 → “没有发出”；`confirmed_original` 的措辞）。

### S5B-12 Y4 #2 后半未落实：其他工具的英文自述仍在律师层（一般）

- 位置：`apps/desktop/src/lib/timeline.ts:149,159`；上游工具描述如 `Reading ${path}`、`Editing ${path}`、`Writing ${path}`、`Searching for '${pattern}' in …`、`Loading …`。
- 事实：Y4 #2 的改法与验收是“其余工具的 `p.description` 只进‘处理细节’，并去掉英文前缀”。现实现中，非联网工具的 `description` 作为律师层步骤的 `detail` 显示，只剥“Xxx: ”形式的前缀，“Reading /…/001.txt”“Editing …”等英文原样出现。批次说明把 Y4 #2 列为已做，只提了联网步骤。
- 建议修复：非联网工具的 `description` 改放到 `detail` 级步骤，律师层只显示中文工具名（必要时显示中性文件名）。若这部分另排期，应在“未做”中写明。
- 应补测试：`buildSteps` 对 Read/Edit 的律师层步骤不含 ASCII 英文句子。

### S5B-13 对比度与窄屏（一般）

- 位置：`apps/desktop/src/styles.css:548`（`.send-suspects { color: var(--risk-mid) }`，`#dc6803` 在白底上约 3.49:1）、`:552`（`.send-preview-docs` 为 `display:flex` 且不换行）、`:192`（`dl.sheet` 为 `90px 1fr`，没有用 `minmax(0,1fr)`）。
- 事实：疑似姓名提示是 13px 正文，达不到 WCAG AA 4.5:1。Y4 #11 的验收是“对比度违规为 0”。多份材料（最多 50 份）的页签在 560px 的开始前确认对话框中横向溢出；`1fr` 的最小宽度会随内容撑开，与 Y4 P0-E（开始面板裁切）是同一类问题。
- 建议修复：提示文字改用对比度达标的深橙色（仅图标或边框用 `--risk-mid`）；页签加 `flex-wrap`，或改为下拉选择；`dl.sheet` 改为 `90px minmax(0,1fr)`。
- 应补测试：Y4 #11 的 axe 扫描加入“开始前确认 + 发送视图展开”状态；1100 px 窄屏截图验收。

### S5B-14 NotifyUser 的回归与证据覆盖不足（建议）

- 位置：`packages/kap-host/test/p1-kap-host.test.ts:183-205`；`packages/kernel/test/kap-a1.test.ts:242`；`packages/kap-host/test/embed-drift.test.ts:36,396-397`；上游 `notifyUserAvailability.ts:6`、`flag.ts:4`；`kap-host/src/engine-config.ts:56`。
- 事实：
  - Y3 K8-5 的回归要求是“P1‘遍历全部内置工具’须把 NotifyUser 纳入”，`mainCalls` 中没有 NotifyUser。
  - 账本证据“只展示、不授权”引用的 kap-a1 用例会自动批准出现的一切确认卡（第 242 行），所以即使 NotifyUser 弹出确认卡，用例也会通过。
  - 漂移报警只检查 `uiCapabilities` 这个键在 embed.ts 中存在，不锁值：上游若把能力名 `update_panel` 或开关环境变量 `KIMI_CODE_EXPERIMENTAL_NOTIFY_USER` 改名，NotifyUser 会静默不注册，只能靠较慢的 kap-a1 发现。
- 建议修复与补测：
  - P1 遍历加 `["NotifyUser", { message: "进展" }]`，并断言裁决为 `interaction`。
  - kap-a1 断言全程没有 `tool === "NotifyUser"` 的 `agent.approval_requested`，且账本事件中不含通知文字。
  - embed-drift 锁定 `NOTIFY_USER_UI_CAPABILITY` 的字面值与 `NOTIFY_USER_FLAG_ENV`，并与 embed.ts、engine-config.ts 中的取值比对。

### S5B-15 `ZR_KAP_TEST_CONTEXT` 的安装包隔离缺回归用例与诊断（建议）

- 位置：`apps/desktop/electron/release-config.cjs:25-31,98-101,116-118`；`packages/kernel/src/index.ts:325-326`；`packages/kap-host/src/main.ts:282`；`packages/kap-host/src/engine-config.ts:75`。
- 事实：隔离本身成立，共三层：
  - 安装包内核环境只取白名单系统变量，任何 `ZR_*` 都不进入内核；同时写定 `ZR_AT_REST=required`、`ZR_REQUIRE_CONTROL_PLANE=1`。
  - 内核在 required 或控制面必需时不传。
  - 宿主在 `atRest === "required"` 时忽略。

  引擎侧还把取值夹在 4096～262143 之间。缺口：`release-config.test.ts` 的剔除清单没有点名该变量（白名单结构本身能挡住）；内核与宿主两层“忽略”没有任何用例；Y3 §3.5 要求“生产入口一律忽略并记诊断”，现在忽略时不记任何事件。
- 建议：
  - 补用例：`ZR_AT_REST=required` 加 `ZR_KAP_TEST_CONTEXT=16384` 时，引擎配置的 `max_context_size` 仍为 262144（可经 `buildEngineConfig` 或宿主 `capabilities`/配置摘要取证）。
  - 宿主忽略时记一条登记事件（如 `KAP_TEST_OVERRIDE_IGNORED`，字段只含布尔）。

### S5B-16 fork 无注释区已有 20 处违规（建议）

- 位置：`third_party/kimi-code/CLAUDE.md:51`；`scripts/check-no-comments.mjs` 输出 20 处，含 `kap-server/src/embed.ts:65`（ZP-9a 的 JSDoc）、`sessionEventJournal.ts:44`、`sessionEventBroadcaster.ts:163`、`promptMedia.ts:56-57`，以及 agent-core-v2 的 ZP-4b/11/20/21 注释。
- 事实：本批新增的 `uiCapabilities: ['update_panel']` 一行没有加注释，符合约定；但 fork 的 `pnpm lint` 已因既有补丁注释失败，rebase 到 2.2.0 时会与上游的 lint 门禁冲突。
- 建议：补丁说明一律移到 `PATCHES.md`，删去 fork 内注释；或在 PATCHES 中登记“中软补丁注释例外”，并在构建脚本中以排除清单运行该检查。

### S5B-17 追问确认中的“将发送什么”少计上一轮对话（一般）

- 位置：`apps/desktop/src/pages/RunView.tsx:291-305,575-583`；`packages/kernel/src/services/send-preview.ts:80-111`。
- 事实：追问在同一 Agent 会话上继续，上游会把此前的对话，包括工具结果中读到的材料片段（令牌形态），连同新问题一起发给模型。估价调用没有传 `followup_of`，摘要只统计所选材料与新的追问文字。界面写“任务说明约 N 字 / N 份材料约 X 字”，没有提到上一轮内容也会再次发出。
- 为什么有问题：“将发送什么”的目标是如实告知会离开电脑的内容（v9.2 §3.4、R3）。
- 建议修复：追问时摘要加一句“以及上一轮的对话内容（同样已替换代号）”，或由内核按会话估算上一轮的字数。
- 应补测试：`send-preview.test.ts` 增“追问估价带 `followup_of` 时摘要标明含上一轮内容”。

### S5B-18 核对面板在追问场景随父组件每次渲染重新拉取（建议）

- 位置：`apps/desktop/src/components/SendSummary.tsx:154-159`（依赖数组含 `documentIds`）；`pages/RunView.tsx:582`（`documentIds={inputDocs.map(...)}`，每次渲染都是新数组）。
- 事实：核对面板打开期间，RunView 每次重渲染（内核事件、还原结果回来等）都会重新调用 `matters.suspects.list`。该接口要对所选材料各自最多 40 万字做令牌化预跑。律师已做的判定按值保存，不会丢失。
- 建议：父组件用 `useMemo` 固定 `documentIds`，或在子组件中以 `documentIds.join()` 作为依赖。

---

## 核对过且成立的要点

1. **NotifyUser 一行补丁与制品**：
   - fork `kap-server/src/embed.ts` 的 `bootstrap` 参数含 `uiCapabilities: ['update_panel']`，与锁版 `notifyUserAvailability.ts` 的判定条件一致。宿主同时把 `KIMI_CODE_EXPERIMENTAL_NOTIFY_USER=1`、`notify_user: true` 写进引擎环境与配置（`engine-config.ts:43-57`），开关与能力两个条件都满足。
   - 补丁导出 `kimi-code-f67e6398f-zhongruan.patch` 等于 `git diff HEAD` 加两份新文件，新文件内容与 fork 逐字一致（内存比对）。
   - 按构建脚本算法在内存中复算的补丁摘要为 `d9ac5764…8882b`，与 `BUILD.json` 一致；`kap-embed.mjs` 的 sha256 为 `e04c2d5f…56e4`，也与 `BUILD.json` 一致，制品中含 `uiCapabilities: ["update_panel"]`。
2. **只展示、不授权**：
   - 工具本身声明 `ToolAccesses.none()`，执行只返回“Update shown to the user.”。
   - 宿主策略 `tool-table.ts:56` 把它定为 UI 级，`policy.ts:299` 对 UI 级直接放行（`interaction`），不消耗预算，也不改变任何后续裁决。
   - 宿主快照只在 `tool.call.started` 时记录文字（≤ 300 字、最近 5 条）；内核 `sanitizeProgress` 按白名单重建，只在内存中保存；账本只记 `tool_started` 的英文描述，不记通知正文。
   - 界面经 `progressTexts` → `restoreTokens` 还原代号后显示。
3. **漂移报警**：`embed-drift.test.ts` 已在本机通过（fork 在、未跳过）。`start.ts` 中的 `uiCapabilities` 键现由 embed.ts 传入，`INTENTIONALLY_OMITTED` 为空，与现状相符；NotifyUser 入参键集合 `["message"]` 已锁定，2.2.0 增加标题字段时会报警。
4. **压缩验收的配置链路**：内核 `index.ts:326` → `kap-agent-client.ts:57,286` → 宿主 `main.ts:61,282` → `runtime.ts:120,322` → `matter-engine.ts:47-48,184` → `engine-config.ts:75`（主、子模型窗口同改）六跳完整。用例实际触发了自动压缩（本机运行 1/1 通过），压缩请求不含“孙悦”与手机号，时间线压缩事件不含摘要正文，模型类去向记录全部经网关。
5. **时间线实际发出内容**：
   - 宿主出口先用 `toolEgressBinding` 按“工具调用编号 + 参数摘要”对到宿主策略刚放行的那一次调用，才附 `x-kwl-tool-call`（`host-egress.ts:189-211`）。
   - 闸门对编号做格式校验，只写入去向记录的 note（`server.ts:727-731`，`gate-host.ts:230`），不参与授权。
   - 被闸门拦下的检索记录虽带 `query.sent`，界面按 `outcome === "blocked"` 写“没有发出”。
   - 预写与补全两条记录以补全为准；没有记录时不显示 Agent 自述的检索式。
   - 执行页在联网工具起止数变化时重新取去向记录，时机合理。
6. **“将发送什么”的内核把关**：
   - L3a 在估价与发起两处都判定“有未核对疑似姓名即拦截”（`send-preview.test.ts` 2/2 通过）。
   - 发送视图接口不返回代号真值，真值只在悬停后按单个代号经受限流与审计的 `matters.tokens.restore` 取回。
   - 三处接入（开始前确认、场景开始面板、追问确认）都会在核对后重新估价。
   - 界面已改为“当事人名单里的公司名称也换成代号”的准确说法。
7. **文件对话框**：
   - 系统对话框带 `dontAddToRecent`，保存对话框另带覆盖确认。
   - 句柄为一次性、分读写类型、10 分钟有效；导出类方法剥掉渲染进程自带的 `save_path`（`file-dialogs.test.ts` 4/4 通过）。
   - 取消即不动作；web 开发形态回退到文件输入框与浏览器下载；事项页“挂载”在 web 形态给出“挂载需要桌面客户端”的报错。
   - 设备页“详细运行记录”开关有失败提示，内核侧 24 小时后自动回到 info（`safe-log/src/index.ts:160`）。
   - 诊断导出的取消、失败、成功三种结果都有对应的界面状态。

## 未能核对的部分

- **上游 #4153（`7091138f5`）**：Y3 列为 NotifyUser 催促机制的修正之一，本地仓库没有该提交，无法判断不回移的影响。`4fbe06544`（#4054）不在锁版基线内，但它只针对没有更新面板的宿主，本批已声明面板，影响不大。
- **Electron `window.confirm` 在 Windows 安装包上的实际按钮文字、标题与默认焦点**：未实机截图，S5B-09 的相关描述据 Electron 实现推断。
- **压缩后第一条用户消息（任务说明、材料清单）是否仍在请求中**：本次不得编写新脚本，未取证；S5B-03 只指出用例没有断言这一点。
- **组件层的实际渲染**：未在浏览器或安装包中打开开始前确认、发送视图、核对面板与进展面板，窄屏与读屏结论来自代码和样式阅读。
- **D-65（发送视图把预跑产生的新代号写回令牌表）的隐私影响、`matter_suspect_reviews` 的驻留登记**：属复核 A 范围，本报告未展开。

---

## 处置（2026-10-14，主审）

| 编号 | 处置 | 证据 |
|---|---|---|
| S5B-01 重要 | **已修**：NotifyUser 不进时间线（只在“进展”面板） | `timeline.ts` |
| S5B-02 重要 | **已修**：通知每条 1000 字（与上游说明一致），超出注明“（已截断）”；面板显示最近 5 条、按 Markdown 渲染并标“助手/子任务”；任务结束后在执行页可展开回看（只在本页内存）；任务说明告诉模型界面实际怎么显示 | `progress.test.ts`、`run-progress-view.test.ts` |
| S5B-03 重要 | **已修并发现一处真实缺陷**：补断言（压缩后任务说明与其中的边界句仍在、自动触发、压缩前后用量都有且下降）；取证发现引擎事件顺序为 started → **blocked** → completed，宿主把 blocked（本步等整理完成）当作失败——时间线会提示律师“对话过长，请把任务拆小”且丢失触发方式。已改为 blocked 只表示“整理中、完成后自动继续”，不出里程碑；整理失败是回合错误码而非事件。能力账本证据文字改为与用例相称（“引用与不确定性”未单独验收） | `kap-compaction.test.ts`（trigger=auto）、`progress.test.ts` 新用例 |
| S5B-04 重要 | **部分修 + 登记**：发送视图可选中没被换掉的名字一键加入当事人名单（之后发送前替换）；“原文 / 发送稿”切换、公司名称“也替换”开关、抽屉形态、在审查工作台与数据去向卡中的复用登记为偏离 D-68 | — |
| S5B-05 | **已修**：代号胶囊显示类别 + 代号尾 3 位以区分不同当事人；悬停/聚焦时还原、离开即收起；还原失败写“无法还原”；可键盘（回车切换）、读屏标签 | — |
| S5B-06 | **已修**：开始面板里发送摘要移出 aria-live 区域 | — |
| S5B-07 | **已修**：取消勾选的材料不再预览（自动切到仍勾选的材料）；页签可换行。页签只写“材料 N”维持（文件名需另取，列入后续） | — |
| S5B-08 | **已修**：内核拒收的判定（如常用词）在核对面板如实列出、不当作已处理 | — |
| S5B-09 | **已修**：风险提示按文件是否含案件内容分别措辞；选“取消”重新选择位置而不是放弃；仍用系统确认框（与 Electron 对话框一致），默认焦点须实机核对，列入残余 | — |
| S5B-10 | **已修**：选择/添加文件失败给出提示；一次可选 200 个；删除回执保存成功或失败都提示；复核页保存成功提示；开发形态文件框扩展名与对话框统一 | — |
| S5B-11 | **已修**：联网步骤结束而没有去向记录时写“这一步没有联网发出”，不再指向数据去向；“按原文”改为“保留机构名称发出，个人信息仍已替换” | `timeline-sent.test.ts` |
| S5B-12 | **已修**：引擎的英文自述不进律师层（只保留含中文的说明） | `timeline-sent.test.ts` |
| S5B-13 | **已修**：疑似姓名提示文字改为 #93370d（与橙色提示条同色，≥ 4.5:1）；材料页签换行 | — |
| S5B-14 | **已修**：漂移报警锁定 `update_panel`、开关编号与环境变量名、嵌入声明与宿主开关；“只展示、不授权”由宿主策略分级 UI 保证，P1 遍历未纳入列入后续 | `embed-drift.test.ts` 新用例 |
| S5B-15 | **已修**：引擎配置的窗口取值范围有单测；宿主在安装包形态收到该项时记 `KAP_TEST_CONTEXT_IGNORED` | `embed-drift.test.ts` |
| S5B-16 | 登记：fork 无注释区的既有违规（历次 ZP 补丁）记入 PATCHES.md，rebase 时统一清理 | `third_party/PATCHES.md` |
| S5B-17 | **已修**：追问确认的发送摘要写明上一轮对话也会再次发出 | — |
| S5B-18 | **已修**：核对面板按材料集合取键，不随页面刷新重复拉取 | — |
