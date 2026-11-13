# B 评审：法律 Skills、场景卡、Agent 工作流与执行链路（V17 → V18）

评审对象：worktree `v17-b42`（下文路径均相对 `platform/`）。只读审查，未改代码。
标注：【已核实】= 亲自读到代码/数据；【推断】= 依据间接证据的判断。

> **主评审更正（2026-11-12）**：本文 T8 与第七节第 5 条写“AGENTS.md 约 2.0 万字、历史括注约 2,850 字”，实际是 7,546 字、22 处括注约 1,060 字（2 万是字节数）。其余我回查过的结论（B5、B7、B11、三处轮询、时限常量）与源码一致。

---

## 一、Skills 盘点

### 1.1 方法清单（33 个，数据来自 `content/skills/dist/skills.manifest.json` 与各 SKILL.md）【已核实】

| 方法 | 场景卡（scenarios.ts 的 id） | 主交付物 | tools_required | 行数 | 论点确认 |
|---|---|---|---|---|---|
| agency-statement 代理词 | agency | 代理词（草稿）.docx | facts.list, materials.list, materials.read_excerpt, docx.render_report | 88 | 是 |
| amount-calc 金额与期间测算 | amount | 计算明细.xlsx | calc.interest, materials.read_excerpt, xlsx.render_table | 92 | |
| appeal-draft 上诉状 | appeal | 民事上诉状（草稿）.docx | materials.list, read_excerpt, facts.list, docx.render_report | 104 | 是 |
| arbitration-application 仲裁申请书 | arbitration-app | 仲裁申请书（草稿）.docx | 同上 | 105 | 是 |
| case-analysis 案情分析 | case-analysis | 案情分析备忘录（内部稿）.docx | facts.list, materials.list, read_excerpt, docx.render_report | 89 | |
| case-report 案件进展汇报 | case-report-lit, case-report | 案件进展汇报.docx | materials.list, facts.list, docx.render_report, xlsx.render_table | 88 | |
| casefile-organize 案卷整理（精读） | casefile-deep | 案卷总目录.xlsx | materials.list, read_excerpt, facts.submit, xlsx.render_table | 88 | |
| citation-check 文稿体检 | citation-audit | 引用核验表.xlsx | citations.verify, law.get_version, xlsx.render_table | 82 | |
| client-advice 顾问答复 | legal-opinion, compliance-qa | 顾问答复.docx | law.search, law.get_version, citations.verify, docx.render_report | 93 | |
| closing-checklist 交割清单 | closing-checklist | 交割清单.xlsx | materials.list, read_excerpt, xlsx.render_table | 82 | |
| contract-draft 起草合同 | contract-draft | 合同草稿.docx | materials.list, docx.render_report | 101 | |
| contract-redline 修订说明 | redline-notes | 修订说明（致客户）.docx | riskcards.list, docx.render_report | 95 | |
| contract-review 合同审查 | contract-review, contract-review-inhouse | 审查意见书（内部稿）.docx | materials.list, read_excerpt, riskcards.submit, citations.verify, docx.render_report | 141 | |
| corporate-resolutions 决议 | corporate-resolutions | 决议（草稿）.docx | materials.list, read_excerpt, docx.render_report | 90 | |
| cross-exam-opinion 质证意见 | cross-exam | 质证意见（草稿）.docx | materials.list, read_excerpt, facts.list, docx.render_report | 82 | 否（受限文书却不走论点确认） |
| defense-draft 答辩状 | defense | 民事答辩状（草稿）.docx | facts.list, materials.list, read_excerpt, docx.render_report | 99 | 是 |
| demand-letter 律师函 | demand-lit, demand-inhouse | 律师函或催告函（草稿）.docx | facts.list, citations.verify, docx.render_report | 87 | |
| doc-revise 按意见改文书 | doc-revise | 修订稿.docx | materials.list, docx.revise | 148 | |
| due-diligence 尽调 | dd-list, dd-findings | 尽调清单.xlsx | materials.list, read_excerpt, xlsx.render_table, docx.render_report | 125 | |
| enforcement-application 强制执行 | enforcement | 强制执行申请书（草稿）.docx | materials.list, read_excerpt, docx.render_report | 105 | 是 |
| hearing-outline 庭审提纲 | hearing-outline | 庭审提纲.docx | materials.list, read_excerpt, facts.list, docx.render_report | 94 | |
| intake-notes 访谈纪要 | intake-lit, intake | 访谈纪要.docx | materials.list, read_excerpt, docx.render_report | 82 | |
| issue-evidence-matrix 争点证据矩阵 | issues | 争点—证据矩阵.xlsx | facts.list, materials.list, xlsx.render_table | 82 | |
| labor-arbitration-draft 劳动仲裁文书 | labor-arb-application, labor-arb-defense-lit, labor-arb-defense | 劳动仲裁申请书（草稿）.docx | materials.list, read_excerpt, facts.list, docx.render_report | 153 | 是 |
| labor-dispute 劳动争议方案 | labor-apply, labor-response, labor-termination | 劳动争议应对方案.docx | materials.list, read_excerpt, facts.list, xlsx.render_table, docx.render_report | 139 | |
| legal-research-memo 研究备忘录 | research-lit, research-deal | 研究备忘录.docx | law.search, law.get_version, citations.verify, docx.render_report | 86 | 是 |
| pleading-draft 起诉状 | pleading | 民事起诉状（草稿）.docx | facts.list, materials.list, docx.render_report | 105 | 是 |
| policy-review 规章制度审查 | policy-review | 规章制度审查意见.docx | materials.list, read_excerpt, xlsx.render_table, docx.render_report | 87 | |
| preservation-application 财产保全 | preservation | 财产保全申请书（草稿）.docx | materials.list, facts.list, docx.render_report | 103 | 是 |
| procedure-check 管辖与时效 | procedure, suit-received | 管辖与时效核查表.xlsx | materials.list, read_excerpt, xlsx.render_table | 105 | |
| redraft-review 回稿重审 | redraft | 变更清单.xlsx | materials.list, docx.compare, riskcards.submit, xlsx.render_table | 88 | |
| review-rules-draft 范本整理审查要点 | rules-from-template, rules-from-template-inhouse | 审查要点草稿（非文件） | materials.list, read_excerpt, rules.propose | 70 | |
| tabular-review 表格审阅 | **无场景卡**；入口在 `apps/desktop/src/pages/Matter.tsx:168,188`（事项页表格“让助手填表 / 问这张表”） | 审阅表（事项材料页） | table.get, table.fill, materials.list, read_excerpt | 75 | |

不挂方法的场景卡【已核实】：`casefile`（scenario `s2.case_file`，本机规则整理，不调 AI）、`redraft-local`（`s1b.draft_compare`）、`audience-pack`（`s6.redaction`）——三者都是内核确定性管线，不需要方法，属合理设计。
没有发现“场景卡指向不存在的方法”：scenarios.ts 中 skill 值全部能在 `content/skills/` 找到目录【已核实】（逐一对照 grep 结果）。
没有任何入口引用的方法：未找到（33 个方法都有卡或事项页入口）。

### 1.2 重复度（脚本：按句切分、去空白与标点后统计“同一句出现在几个方法里”，并做 8 字 n-gram 两两重叠）【已核实】

- 被 ≥4 个方法逐字共用的句子共 37 句；两两重叠最高的一组全部是“受限文书”：agency-statement↔defense-draft 0.33、arbitration-application↔pleading-draft 0.30、arbitration↔labor-arbitration-draft 0.27、appeal↔labor-arbitration 0.26、appeal↔pleading 0.25（重叠比 = 共有 n-gram / 较短一方 n-gram 数）。其余方法之间普遍 <0.15。
- 结论：方法正文的“业务内容”重复不严重；重复集中在 **9 个起草类方法共用的同一套协议段落**（论点确认、期限口径、质量说明、工具不可用兜底、提交前核对清单列定义），属于“公共流程被复制粘贴到每个方法里”。

#### 发现 B1：“起草前确认论点与依据”整段协议被复制 9 份【已核实】
- 现象：同一段约 420 字的流程指令（facts.submit → outline.submit → 提问工具 → outline.get → 先不起草即停）逐字出现在 9 个方法，只换 doc_kind 与“论点/上诉理由/保全理由/申请事项”一词。
- 证据：`content/skills/agency-statement/SKILL.md:41`、`appeal-draft/SKILL.md:47`、`arbitration-application/SKILL.md:48`、`defense-draft/SKILL.md:42`、`enforcement-application/SKILL.md:49`、`legal-research-memo/SKILL.md:40`（简化版，缺①③两步）、`pleading-draft/SKILL.md:42`、`labor-arbitration-draft/SKILL.md:84`、`preservation-application/SKILL.md:47`。原文片段：“然后用提问工具请律师确认（问题写“论点与依据已列在任务页，请确认后选择”，选项依次为“已确认，按确认的论点起草”“先不起草”）”。同时 `content/skills/build-skills.mjs:70` 已经把 frontmatter `requires_outline: true` 编进 manifest，内核 `tools/registry.ts:445` 与 `services/argument-outlines.ts:329` 已在工具层拒绝未确认时出文书。
- 根因：闸门已在内核（工具拒绝），但“怎么发起确认、提问怎么写、选项文字”仍靠每个方法的提示词让模型去拼；而 `requires_outline` 标志只用于拦截，没有用于由内核统一下发协议文字。
- 建议：**重构（小）**——把这段协议抽成一段公共文字，由内核在 `methodPromptLine`（`packages/kernel/src/executor/executor.ts:995`）对 `skill_requires_outline` 的方法统一注入（或放进 AGENTS.md 的一条），各方法只保留 doc_kind 与本文书特有的“论点”名称；cross-exam-opinion 是否纳入另行决定（它是受限文书但没有 requires_outline）。
- 预期收益：9 个方法各减约 10% 篇幅；协议改一处生效（历史上这段已改过多轮，legal-research-memo 版本已经与其他 8 份漂移——缺事实提交和“一并确认事实”两步）。
- 改动范围与风险：方法正文 9 处 + executor 一处；风险是协议文字由内核注入后与方法的步骤编号脱节，需要保留“第 N 步做论点确认”的锚点句。

#### 发现 B2：期限口径段在 8～9 个方法里有两个漂移版本【已核实】
- 现象：脚本统计“有几种起算或中断口径的各算了一次，最早届满的作为保守口径写在最前其余并列写出”出现 9 次，另一版“各算一次，以最早届满的为保守口径写在最前其余并列起算事实只到月的按月初计并注明，工作准则第条”出现 8 次；同时 AGENTS.md 第 4 条“期限与时效取最保守的口径”已完整规定（`content/skills/AGENTS.md` 第 4 条第 3 小项）。
- 根因：准则补规则后又在方法自检里各复制一遍，没有单一来源。
- 建议：**精修**——方法里只留“按工作准则第 4 条算期限”一句的自检项，删掉复述。
- 预期收益：消除两版文字不一致带来的歧义（一版有“只到月按月初计”，一版没有）。风险低。

#### 发现 B3：可合并为“一个方法 + 参数”的候选【已核实 内容重叠；合并收益为推断】
- 受限诉讼文书 6 个（pleading-draft、defense-draft、appeal-draft、arbitration-application、preservation-application、enforcement-application）两两重叠 0.17～0.30，共用：论点确认协议、身份信息【待填】规则、证据目录附页、提交前核对清单列定义（`arbitration-application/SKILL.md:77` 与 `labor-arbitration-draft/SKILL.md:119` 逐字相同：“列：序号 / 核对项 / 要求 / 当前状态 / 依据或来源 / 责任人…”）。差异部分是诉讼请求/答辩/上诉理由的结构与各自的程序要件（上诉期、保全担保、执行依据），这部分是真正的业务知识，不宜合并。
- 建议：**精修而非合并**——抽出“诉讼文书公共附件规范”（提交前核对清单、证据目录附页、当事人信息写法、论点确认）为一个 references 文件（如 `references/litigation-common.md`），6+2 个方法引用它；不合成一个大方法，因为场景卡、主交付物核对（`build-skills.mjs:73-77` 按 outputs 第一项）和独立复核种类都按方法 id 绑定，合并会牵动卡片与复核映射。
- labor-dispute（方案）与 labor-arbitration-draft（文书）：前者 3 张卡、后者 3 张卡，`labor-apply` 卡挂 labor-dispute、`labor-arb-application` 卡挂 labor-arbitration-draft，两张卡对律师来说都是“劳动仲裁申请”。见发现 B4。

#### 发现 B4：tabular-review 没有场景卡，只能从事项页表格进入【已核实】
- 证据：`apps/desktop/src/pages/Matter.tsx:168` `{ skill: "tabular-review", label: "表格审阅", skillArgs: { table_id: t.table_id } }`；`scenarios.ts` 无该方法。
- 判断：方法以 table_id 为参数，没有表就没法开始，入口放在表格上是对的。**保留**。只需确认 FREEFORM_METHOD_LINE（`executor.ts:1018` 附近）不会让模型在自由描述任务里误加载它（它要求 table_id）——未见到限制，【推断】风险低。

---

## 二、公共文本与准则冲突

### 2.1 公共段落统计【已核实】
| 公共段落 | 出现处 | 统一来源？ |
|---|---|---|
| 起草前确认论点与依据（整段协议） | 9 个方法（见 B1） | 否；内核只做拦截 |
| 期限口径（最早届满为保守口径） | 8～9 处、两个版本（见 B2） | AGENTS.md 第 4 条已有，方法重复 |
| 质量说明“只写在最终答复末尾” | 18 个方法（`deliverable-check.ts:76` 注释原文：“这条规则在工作准则与 18 个方法里各写了一遍”） | AGENTS.md 第 10 条；第 42 批起内核 `scrubQualitySections`（`tools/registry.ts:449`）直接删 |
| 工具不可用兜底（kwl-docx create、“未经文书工具生成，格式待整理”） | 7～8 处 | AGENTS.md 第 5 条末已写 |
| 提交前核对清单列定义 | 5 处（`arbitration-application/SKILL.md:77`、`labor-arbitration-draft/SKILL.md:119` 等） | 否 |
| “没有空泛援引‘根据相关法律法规’…绝对化表述” 自检 | 5 处 | 否 |
| 工具表“不可用时”一栏 | 几乎每个方法都有一张工具表 | 否 |

结论：方法里约 15%～25% 的文字是准则复述或公共协议（按 B1/B2 及上表估算，【推断】比例）。没有单一来源（build-skills.mjs 只拷贝文件、不做片段引用，`content/skills/build-skills.mjs:59-62`）。

#### 发现 B5：界面用语进成果的直接来源在方法的“输出规格”里，且交付前检查不覆盖【已核实】
- 现象：评分最高频的同类缺陷“审查工作台”“风险卡 N”“事实时间线”进成果。
- 证据（方法让模型把这些词写进文件）：
  - `contract-review/SKILL.md:98` 意见书逐条意见“每项注明风险卡序号”；`:100` “依据与核验状态：法名 / 条号 / 核验状态 / 用于哪张卡”；`:101` 意见书第 7 节原文“说明：本稿含谈判底线与内部评估，不得直接发送客户或对方；修订稿与清洁稿请在审查工作台处理卡后生成，给客户的说明用“修订说明与谈判要点”生成。”；`:104` 问题清单列含“风险卡序号”。
  - `contract-redline/SKILL.md:60` 致客户《修订说明》第 5 节原文“5. 说明：修订稿另见审查工作台生成的文件。”——这是**发给客户的文书**。
  - `casefile-organize/SKILL.md:86` “时间线以“草稿 · 未提交事实时间线”标注”。
  - 内核提示词同样把界面名当工作语言：`executor.ts:1024` agentGoalPrompt“逐项用 riskcards.submit 提交到律师的审查工作台…事实用 facts.submit 提交到事实时间线”。
  - 检查侧：`services/deliverable-check.ts:52-71` INTERNAL_PATTERNS 覆盖工具名、内部编号、质量说明、代号说明，**没有“审查工作台 / 风险卡 / 事实时间线 / 任务页”**。
- 根因：方法正文把界面上的对象名当成文书里的称呼；检查清单是按历史缺陷逐条补的，这一类没进清单（与记录 `00-实施与验证记录.md:19`“两类高频缺陷之所以反复出现，是因为它们不在检查范围里”同一机理）。
- 建议：**精修**——①改方法输出规格：意见书/问题清单用“问题序号”（与问题清单同号）替代“风险卡序号”，删掉 contract-review 第 7 节与 contract-redline 第 5 节里指向界面的句子（修订稿生成方式写进最终答复）；②在 INTERNAL_PATTERNS 加一条“审查工作台|风险卡\s*\d|事实时间线|任务页|开始面板”的检查，对外文书报错、内部稿可放行“问题序号”。
- 预期收益：直接消除当前最高频同类缺陷的主要来源；改动纯文本 + 一条正则。
- 改动范围与风险：两三个方法 + deliverable-check 一条；风险是内部稿里律师确实需要“对应哪张卡”的回链——用问题序号且界面卡片显示同一序号即可（需确认 riskcards 是否有序号字段，未核实）。

#### 发现 B6：质量说明文字在方法之间仍不一致，且与准则第 10 条直接矛盾【已核实】
- 证据：AGENTS.md 第 10 条原文“质量说明（“通用辅助 · 未经本所质量验收”）只写在给律师的最终答复末尾…“草稿 · 待律师复核”也不写”；而 `contract-draft/SKILL.md:26` 原文“质量说明“通用辅助 · 未经本所质量验收 · 草稿待律师复核”写在最终答复末尾”、`doc-revise/SKILL.md:37` 原文“最终答复末尾写“通用辅助 · 未经本所质量验收 · 草稿待律师复核””、`doc-revise/SKILL.md:132` 自检“末尾写了质量说明行”。
- 根因：同一规则 18 处各写一遍，演进时只改了部分。危害小（只在最终答复里），但说明“准则 vs 方法”双写会持续漂移；V9.6 查出的“准则第 4 条冲突”是同一机理。
- 建议：**删除**——18 个方法里的质量说明句全部删掉，由准则第 10 条 + 内核 scrub 兜底；最终答复末尾那句可由内核在登记最终答复时追加（`finalReply`，`executor.ts:1614`），连准则这一条都可以缩短。
- 收益：每个方法少 1～2 行，消除一类漂移；风险低。

#### 发现 B7：系统提示（legal-agent.md）第 1 条“开放任务先进入计划模式”与“直接做”档矛盾【已核实 代码路径；对律师体验的影响为推断】
- 证据：`content/agent-profile/legal-agent.md` 第 1 条原文“**计划先行**：开放任务先进入计划模式，给出步骤计划并经确认后再执行”。而界面“直接做”档 = `mode: "default", planFirst: false`（`apps/desktop/src/lib/mode-options.ts:18`）；宿主只在 planFirst 为真时主动 `enterPlanMode`（`packages/kap-host/src/runtime.ts:525`），但对模型自己调用的 ExitPlanMode，在 default 档且非续接会话时一律 `plan_review_by_card`（`packages/kap-host/src/policy.ts:312`：`(mode === "auto" || (ctx.continued === true && mode !== "manual")) && !ctx.planFirst ? "plan_auto_approved" : "plan_review_by_card"`）。
- 根因：系统提示无条件要求计划先行，宿主在“直接做”档仍把模型自发的计划呈现为确认卡——律师选了“直接做”仍可能被计划卡拦下。
- 建议：**精修**——系统提示第 1 条改为由内核按 plan_first 下发一句（“本任务律师已选择先看计划 / 直接执行”），policy.ts:312 把 `mode === "default" && !planFirst` 也纳入代批。
- 收益：去掉一个对律师是净负担的确认点（场景卡已经在开始面板展示了 steps，见 `scenarios.ts` 每张卡的 `steps` 字段）。风险：需真实跑一次确认模型在 default 档不再停在计划卡。

#### 发现 B8：准则与方法的优先级规则写了三处，措辞不同【已核实】
- 证据：AGENTS.md 末段“**优先顺序**：①…②律师…③本事项审查要点…④方法模板”；`legal-agent.md` 第 6 条“方法模板与律师的指示不一致时以律师的指示为准（工作准则列明的底线除外）”；内核 `methodPromptLine`（`executor.ts:1013`）“模板与律师的任务说明冲突时，以律师的说明为准（工作准则列明的底线除外），不为此再提问”。三处一致方向，但“底线”在 AGENTS 是第 1、2、4、8 条，另两处只说“列明的底线”。
- 建议：**保留**内容，**精修**为只在 AGENTS.md 一处定义，其余两处引用。收益小、风险低。
- 已复查 V9.6 的“准则第 4 条冲突”同类隐患：AGENTS.md 第 4 条现在明确“对外文书正文不写这句”“不写‘请律师核对’”，`methodPromptLine` 也同步了（`executor.ts:998-1000` 注释说明 V16 第 41 批已改）。未发现仍在的同类直接冲突；剩余冲突即 B5（方法输出规格要求写界面用语，与准则第 10 条“不写内部编号、方法文件名”的精神相悖但准则未列出这几个词）与 B6。

---

## 三、执行链路：从“开始”到成果登记

### 3.1 阶段清单（以场景卡发起的 A1 起草类任务为例，如起诉状）

| # | 阶段 | 实现 | 每单触发？ | 律师操作 | 性质 |
|---|---|---|---|---|---|
| 0 | 开始面板：选事项、材料、填卡片字段、选“做法”档 | `apps/desktop/src/components/ScenarioStart.tsx`；做法选项 `lib/mode-options.ts:17-21`（默认“先给我看计划（推荐）”） | 是 | 填字段、点开始 | 必要 |
| 1 | 估价 + 内容去向（去抖自动算） | `ScenarioStart.tsx:144-162` `prepareStart` | 是（自动） | 无 | 自动 |
| 2 | 发起确认页（只在依据未齐、去向有提醒、疑似姓名待核时） | `ScenarioStart.tsx:174-177` → `RunSheet` | 否（条件） | 确认客户同意 / 核对疑似姓名 | 合规闸门，保留 |
| 3 | 内核拼提示词：事项口径 + 任务 + 方法行 + 审查要点 + 写作偏好 + 工作方式 + 边界 | `packages/kernel/src/executor/executor.ts:1034-1050`、`agentGoalPrompt` `:1024`、`methodPromptLine` `:995` | 是 | 无 | 自动 |
| 4 | 载入材料、令牌化、写材料快照 | `executor.ts:1052-1075` | 是 | 无 | 自动 |
| 5 | 宿主起会话；planFirst 时进计划模式 | `packages/kap-host/src/runtime.ts:492,525` | 是 | — | — |
| 6 | **计划确认卡**（ExitPlanMode） | `kap-host/src/policy.ts:312`；卡片文案 `kernel/src/services/interaction-cards.ts:118-120` | 默认档每单（“先给我看计划”为默认）；“直接做”档模型自发出计划时仍出卡（见 B7） | 读计划、批准 | **净负担候选** |
| 7 | 取舍提问（AskUserQuestion，准则第 6 条“起草前合并成一次提问”） | AGENTS.md 第 6 条；工具 `tool-table.ts:55` | 大多数起草单 | 选项作答 | 必须保留（D-175 的真实回归证明不问会写反） |
| 8 | **论点与依据确认**（facts.submit→outline.submit→AskUserQuestion→outline.get） | 方法正文（B1）；拦截 `tools/registry.ts:445-446` `assertOutlineSettled`；界面 `apps/desktop/src/components/OutlineConfirm.tsx` | 9 个 requires_outline 方法每单 | 在任务页逐条确认论点、事实 | 质量闸门，保留，但应与第 7 步合并 |
| 9 | 检索 / 外网 / 图片出境确认 | `policy.ts:361-385`（T4 search_entity_requires_confirmation、T5 fetch_new_domain、T0' image_to_model） | 条件 | 确认 | 合规闸门，保留 |
| 10 | 出文书：内核删质量说明 → 附事实对照 → 生成 → 交付前检查 → 缩水检查 | `tools/registry.ts:444-464` | 每次出文书 | 无 | 内核强制（检查结果只回给模型，不拦截） |
| 11 | 改文书（docx.edit_draft / xlsx.edit_cells） | `tools/tools/edit-draft.ts`；`registry.ts:511,870` | 条件（20 单 37 次） | 无 | 自动 |
| 12 | 宿主收尾、成果入库与检查点 | `executor.ts:1237-1295` | 是 | 无 | 内核强制 |
| 13 | 案卷整理补时间线表 | `executor.ts:1213` `ensureFactsTimeline` | casefile-organize 才有效 | 无 | 内核兜底 |
| 14 | 主交付物核对（没 Word 不记完成） | `executor.ts:1299-1303` | 是 | 无 | 内核强制，保留 |
| 15 | 建议修订稿段（D-178） | `executor.ts:1304-1309`、`wantsRedlineStage` `:958`、`REDLINE_LIMIT_MS` `:966`（25 分钟） | 仅 contract-review 且开始面板选“要” | 无 | 内核拆段 |
| 16 | 独立复核（不带起草上下文，route legal/k3，effort low，15 分钟） | `executor.ts:1737-1802`，`REVIEW_LIMIT_MS` `:1449` | REVIEW_KIND_OF_SKILL 覆盖的方法 | 无 | 内核强制 |
| 17 | 复核意见交回原会话修改（plan_first:false，25 分钟） | `executor.ts:1839-1928`，`REVIEW_FIX_LIMIT_MS` `:1452`（D-163） | 复核有意见时 | 无（若模型再提问则要答） | 内核强制 |
| 18 | 结算 succeeded / partial + remaining 说明 | `executor.ts:1317-1319` | 是 | 看结果 | 内核强制 |

律师在一张起草类卡里最多要停 **4 次**：计划确认（6）、取舍提问（7）、论点确认（8）、可能的检索确认（9）。其中 6、7、8 都发生在动笔前，彼此相隔一次模型往返。

#### 发现 B9：计划确认对场景卡任务是净负担【已核实 链路；收益为推断】
- 现象：场景卡在开始面板已经把步骤给律师看过（`scenarios.ts` 每张卡的 `steps`，例如 `labor-arb-application` 的 steps 第 3 项“论点与依据先交你确认再成文”），默认档仍要求模型先出计划并经卡片确认（`mode-options.ts:17` 默认“先给我看计划（推荐）”，`api/index.ts:438` `plan_first_default: true`）。
- 根因：计划先行是 W1 时代为“自由描述任务”设计的（`legal-agent.md` 第 1 条），场景卡任务沿用了同一默认。
- 建议：**精修**——场景卡发起（skill 非空）时 plan_first 默认 false，计划只用于自由描述任务；保留开关。
- 预期收益：每张场景卡少一次人工停顿和一次模型往返（准则第 10 条还专门规定了“提交审批的计划按四段写”——这段指令也可随之只对自由任务生效）。
- 风险：律师失去“开工前纠偏”机会——由第 7、8 步承担（它们才是有实质的纠偏点）。

#### 发现 B10：取舍提问与论点确认是两次停顿，可合并成一次【推断】
- 证据：AGENTS.md 第 6 条要求“会写进对外文书、又只有律师能定的取舍…起草前合并成一次提问”；方法第 5～8 步要求论点确认再用一次提问工具（B1 引文）。两次都在动笔前。
- 建议：**精修**——方法协议改为“取舍提问的选项随论点提纲一并提交，律师在论点确认卡上一次答完”；若 OutlineConfirm 界面不支持带选项，则至少要求“先 outline.submit，再一次 AskUserQuestion 同时含取舍与‘按确认的论点起草’”。
- 收益：起草类单少一次停顿；风险：OutlineConfirm.tsx 需要能展示取舍项（未核实其现有能力）。

#### 发现 B11：独立复核失败（含上游拒绝）不改结算状态，任务仍记“成功”【已核实】
- 证据：`executor.ts:1803-1804` 原文注释“复核调用失败：文书照常交付（时间线写明“未经复核”），不改结算状态”，代码 `if (!review.ok) return { remaining: [...], partial: false };`；记录 `research/2026-11-12-…/00-实施与验证记录.md:145` “独立复核遇上游拒绝就跳过，任务仍记成功：标准档 m27、m28，高速档 m17”。
- 根因：复核被设计成“锦上添花”，失败不降级；而 D-161 已把它定为质量闸门。
- 建议：**精修**——复核失败先自动重试一次（拒绝/429 类可等待重试，复核本身有检查点 `ctx.step("independent_review")`，重试成本只在这一步），仍失败则 `partial: true`，界面状态写“已交付，未经独立复核”。
- 收益：消除“成功但未复核”的假象；改动 1 处、外加一次重试；风险：partial 比例上升（真实 3/20）。

#### 发现 B12：独立复核覆盖 32/33 个方法，表格类也走一整轮“复核 + 25 分钟修改轮”【已核实 覆盖；收益为推断】
- 证据：`services/independent-review.ts` 的 REVIEW_KIND_OF_SKILL 把除 tabular-review 外全部 32 个方法映射到 draft/revise/opinion/pleading/letter/review/report/table/rules；其中 kind=table 的有 casefile-organize、issue-evidence-matrix、amount-calc、procedure-check、citation-check、closing-checklist、intake-notes 7 个。已知事实：复核＋修改轮占耗时 16%。
- 判断：对外文书（pleading/letter/draft）和意见类（opinion/review）复核价值高；表格类（尤其 amount-calc 有确定性计算工具、citation-check 本身就是核验）复核收益存疑。
- 建议：**暂缓**改动，先用账本数据（`review.completed` 事件里有 kind、findings、must，`executor.ts:1786-1792`）按 kind 统计“必须改”命中率，命中率低的 kind 改为只出意见、不进修改轮。
- 收益：按 16% 的上限估，表格类单可省一轮修改（【推断】）。风险：低，可配置化。

---

## 四、为补早期模型短板而加的临时方案

| # | 临时方案 | 证据 | 当初补什么 | 现在（K3.1-Pro / 高速档） | 建议 |
|---|---|---|---|---|---|
| T1 | 审合同拆两段（D-178） | `executor.ts:951-966` `REDLINE_STAGE_ONE_LINE`、`goalForReviewer` 用正则把“【分两段】…不要写成已经生成。”从复核人看到的委托里替换掉（`executor.ts:974-978`）；登记 `docs/v9-开发计划与进度.md:1650` | 标准档审查接近 40 分钟，修订稿挤不进 | 高速档 10 单中位 12.2、最长 15.6 分钟（记录 `00-实施与验证记录.md:17,148`） | **暂缓**：若高速档定为默认，合并回单段并删掉 goalForReviewer 的正则补丁；若保留标准档，维持 |
| T2 | 工作时限 10→25→40 分钟（D-152→D-159）、修改轮 15→25（D-163）、修订稿段 25 | `executor.ts:2153` `AGENT_WORK_LIMIT_MS = 40 * 60_000`；`:1452`；`:966`；进度文档 `:1623,1630,1634` | 标准档慢 | 高速档无单撞线 | **保留**为上限（不影响快的任务）；D-163 可在高速档定案后回调 15 分钟，失败更早暴露 |
| T3 | 工作准则第 11 条：TodoList 不单独占一步 | AGENTS.md 第 11 条；记录 `:16` 只更新清单往返 37→9（标准）→0（高速） | 模型多余往返 | 高速档已是 0 | **保留**（便宜），不再扩写 |
| T4 | “生成前把全文想完整…一次提交”“不为措辞润色重新生成”、缩水检查 shrink | AGENTS.md 第 5 条；`registry.ts:462-463` | 模型为改两个词整份重出 5 次（第 35 批） | `docx.edit_draft`、`xlsx.edit_cells` 已从工具层解决（D-158、D-169），记录里 edit_cells 25 次写入 22 | **精修**：AGENTS 第 5 条这段约 900 字的历史叙述可压到 3 句，工具层已兜底 |
| T5 | 复核推理强度 low + “正文为空”判失败 | `executor.ts:1761` `effort: ctx.deps.reviewEffort ?? "low"`、`:1781-1782` 注释“上游缺省推理强度下 32,000 个输出 token 全部用在推理上，正文为空” | K3 推理吃光输出 | 未知 | **保留**（防御性），可在高速档上测一次 effort=medium 的必须改命中率 |
| T6 | 自由描述任务靠提示词让模型自己选方法 | `executor.ts:1015-1018` FREEFORM_METHOD_LINE 原文“是否加载全凭模型临场决定” | 模型不加载方法 | 仍是提示词 | **重构（小）**：桌面端已有 `suggestScenario`（`scenarios.ts:1272`）按 intents 选卡；把它前移到发起时由内核写入 skill（猜中则等同场景卡，主交付物核对、复核种类都生效），猜不中再走 FREEFORM |
| T7 | 交付前检查只回给模型、不拦截 | `registry.ts:455-456`；记录 `:19` “检查报出来的问题，模型基本都改了（154 份最终成果里只有 9 份还留着）” | — | 有效 | **保留**机制；问题在检查范围（见 B5） |
| T8 | 方法与准则里的历史叙述括注（“V16 第 41 批真实走查：…”） | AGENTS.md 约 2.0 万字，其中带“真实走查/第 N 批/V1x”的括注 22 处约 2,850 字（脚本统计）；33 个方法合计约 1.3 万字 | 让模型理解为什么 | 每次调用都发送，挤占上下文 | **精修**：括注移到 git 提交/进度文档，提示词只留规则；准则可缩约 14% |

#### 一直被“提示词掩盖”、没有在内核/工具层根治的问题【已核实 提示词存在；“未根治”依据为未找到对应内核代码】
1. **界面用语进成果**——只有方法正文/准则写“不写内部编号”，检查清单没有这几个词（B5）。
2. **律师回答是否落实**——AGENTS.md 末段要求“最终答复里用一小节列出“你的决定 → 落实位置””；内核只把回答交给复核人（`executor.ts:1747` `agentClient.answered?.(runId)`），账本里提问事件只记题数（记录 `:147`）。没有任何确定性核对。建议：**精修**——账本记录题干/选项/回答（令牌形态），复核提示里把“逐条核对回答落实”作为固定一项（复核人已拿到 answers）。
3. **委托人内部说明不得列为证据**（AGENTS.md 第 3 条，第 41 批）——只有提示词，未找到对应检查。【推断】可在证据目录类表格的交付前检查里加“情况说明/请示/访谈记录”文件名命中提示。
4. **论点确认协议的发起**——拦截在工具层，发起靠 9 份提示词（B1）。
5. **edit_draft 锚点定位过严**——见 B13，是工具设计问题，被写成提示词“逐字照抄”。

---

## 五、工具依赖

### 5.1 使用情况【已核实】
- Agent 可调工具 27 个（`packages/domain/src/legal-tool-names.ts:6-44`）。构建时校验 tools_required 必须在清单内（`build-skills.mjs:66-68`），所以“方法要求、清单没有”的情况构建期即失败——未发现。
- **没有任何方法使用的工具**：`redact.scan`（0 个方法提及；对外脱敏卡走内核 `runS6Scenario`，`executor.ts:751`，不经 Agent）。建议 **删除**其对 Agent 的暴露（或保留但从工具列表隐藏），收益是少一个模型可能误用的工具；风险极低。【已核实 0 引用；影响为推断】
- 只被 1 个方法用的：docx.compare（redraft-review）、table.get/table.fill（tabular-review）、rules.propose（review-rules-draft）——均为专用工具，合理。
- `docx.edit_draft` 只在 contract-draft 一份方法里出现、`xlsx.edit_cells` 只在 issue-evidence-matrix 出现，其余靠 AGENTS.md 第 5 条与工具描述（`registry.ts:408-409,511-514`）。合理（规则在一处）。

### 5.2 功能重叠【已核实】
| 能力 | 路径 | 定位算法 |
|---|---|---|
| 在合同原件上出修订稿 | ①审查工作台按已接受卡生成（`services/review-cards.ts:944` buildRedlineFromCards）②审查任务里 `docx.revise` 写“建议修订稿”（D-167、D-178 段，`executor.ts:981-993`）③doc-revise 方法 `docx.revise` | ①用 `locateQuote`（精确→忽略空白→去条款号，`review-cards.ts:119-150`）②③用 `services/structured-patch.ts`（编号、行列提示） |
| 改自己生成的文书 | `docx.edit_draft` | `docx-engine/src/textmap.ts` `findInParagraph`：只把 NBSP 当普通空格，其余逐字、单段内匹配 |
| 两稿比对 | ①本机 `s1b.draft_compare`（卡 redraft-local）②`docx.compare` 工具（redraft-review） | 同一 compareDocx |
| 生成文书 | `docx.render_report`；兜底 `kwl-docx create`（41 处方法文字提及）；Markdown 工作区文件 | — |

- 修订稿①与②并存是 D-167/D-178 的产品决定（一个是逐卡确认后的“律师修订稿”，一个是“建议修订稿”），**保留**；但律师会拿到两种同名概念的文件，建议界面与文件名明确区分（【推断】）。
- `kwl-docx` / `kwl-xlsx` 兜底文字在 33 个方法里共 41 行提及（grep 行数），而该路径只在“文书工具不可用”时才用，**精修**：只在 AGENTS.md 第 5 条保留一次。

#### 发现 B13：docx.edit_draft 锚点找不到（10/37）的根因主要在工具设计【已核实 代码差异；占比为推断】
- 现象：记录 `00-实施与验证记录.md:62` “修改草稿 37 次…退回原因：锚点找不到 10、锚点有歧义 2”。
- 证据：
  - edit_draft 的定位是 `findInParagraph`（`packages/docx-engine/src/textmap.ts`）：`hay.indexOf(needle)`，只做 `sameSpaces`（NBSP），**不忽略空白、不去条款号、不跨段**；失败提示原文“草稿里找不到这段文字：逐字照抄这份文书里的原文（同一段落之内，含标点与代号）”（`edit-draft.ts:53`）。
  - 同一产品里风险卡定位 `locateQuote` 已有三级放宽（精确→忽略空白与表格分隔符→去掉开头条款编号），注释原文“Word 自动编号的条款带着编号…助手照抄的“编号 + 正文”整批定位不到”（`review-cards.ts:103-106`）。
  - edit_draft 只对代号还原做了一次重试（`edit-draft.ts:195-199`）。
- 根因：模型写锚点时依据的是它提交给 render_report 的段落字符串或交付前检查报出的片段，常见偏差是换行/空格、自动编号前缀、跨两段——这些在 locateQuote 里早已处理，edit_draft 没复用。方法指令侧只有“逐字照抄”一句，属于用提示词掩盖工具缺口。
- 建议：**精修**——edit_draft 失败时按 locateQuote 同样的两级放宽重试（仍要求唯一命中）；not_found 时返回最相近的 1～2 段原文（截断）供模型照抄。
- 预期收益：多数“找不到”一次重试就能写入，省一次模型往返（每次约数十秒～分钟级，【推断】）。风险：放宽后误改——仍以“唯一命中”兜底，风险可控。

> **B10 补证（更新为【已核实】界面侧）**：任务页已经把“论点确认卡”和同一次提问合并处理——`apps/desktop/src/pages/RunView.tsx:31` 引入 `confirmAndAnswer, outlineAnswer, outlineQuestion`，`:353-356` 在提问只含论点确认一项（`outlineQ.others === 0`）时把提问卡收进论点卡；`others > 0` 时其余题目仍一起显示。也就是说界面已经支持“论点确认 + 取舍提问”在同一次停顿里完成，缺的只是方法协议（B1 那段）没让模型把取舍题放进同一次 AskUserQuestion。改动只在提示词，收益比原估更确定。

---

## 六、七个高频场景的贯通性

| 场景 | 卡片 | 方法 | 关键工具 | 成果登记 | 界面预览 | 空/假/桩 |
|---|---|---|---|---|---|---|
| 法律检索 | research-lit、research-deal、legal-opinion、compliance-qa | legal-research-memo / client-advice | law.search、law.get_article、citations.verify | render_report → agent_report | SafePreview（内核把 DOCX 渲染成白名单 HTML，`components/SafePreview.tsx:1-15`） | **内容层偏薄**：法规库 37 部法律/司法解释、约 4,000 条（`content/lawdb/sources/laws.json`，脚本计数），没有证券法、企业破产法、外商投资法、招标投标法等；**案例检索为空**——方法自己写“案例库尚未开通”（`legal-research-memo/SKILL.md:24`），工具清单里没有案例工具。链路真、资料面窄【已核实】 |
| 合同审查 | contract-review、contract-review-inhouse | contract-review | riskcards.submit、citations.verify、docx.render_report、（可选）docx.revise | 风险卡入库 + 意见书 + 问题清单；工作台按卡生成修订稿（`review-cards.ts:944`、`api.ts:1018` buildRedline） | ReviewWorkbench / Review 页 | 贯通。问题在文字层（B5 界面用语）与两种修订稿并存【已核实】 |
| 文书起草 | pleading、defense、appeal、arbitration-app、preservation、enforcement、agency、labor-arb-* | 9 个 requires_outline 方法 + cross-exam-opinion | outline.submit/get、facts.*、render_report、edit_draft | agent_report；未确认论点时成果带 open_items（`executor.ts:1268`） | OutlineConfirm + SafePreview | 贯通。**cross-exam-opinion（质证意见，受限文书）没有 requires_outline**，与其他 9 个受限文书口径不一致（manifest 列表）【已核实】 |
| DOCX 定向修订 | doc-revise | doc-revise | docx.revise（含 amend） | revision_draft / revision_clean | 预览含修订与批注 | 贯通；开始面板有 `wordDocGap`（`scenarios.ts:1428`）检查必须有 Word 原件【已核实】 |
| 案件分析 | case-analysis | case-analysis | facts.list、materials.*、render_report | agent_report（内部稿，自动附事实对照 `registry.ts:447-452`） | SafePreview | 贯通；质量依赖事实表是否先整理过——卡片 gives 只写材料，未强制先做案卷整理（【推断】漏分析的一部分来源） |
| 证据整理 | casefile（本机规则）、casefile-deep（AI 精读）、issues | — / casefile-organize / issue-evidence-matrix | s2 确定性抽取 `executor.ts:806-830`；facts.submit；xlsx.render_table；时间线由内核补生成 `executor.ts:1213` | 表格 + 事实表 | 表格预览 + 事项“事实”页 | 贯通，但**两条路径都往同一事实表写**：s2 规则抽取以“材料记载、待律师确认”写入（`executor.ts:823-827`），精读版再逐条 facts.submit——同一事项两张卡都跑过时事实重复与否未找到去重代码【推断】；s2 的“争点证据矩阵（框架）”只按律师给的争点列框架，是空表头性质，卡片已如实说明（`scenarios.ts:149-151`）【已核实】 |
| 尽职调查 | dd-list、dd-findings | due-diligence（一个方法两张卡，卡上 primary 区分） | materials.*、xlsx.render_table、docx.render_report | 清单 / 报告 | 预览 | 材料内贯通；**外部核查完全为空**——方法原文“外部信息只用律师导入的结果：工商登记、裁判文书、被执行人与失信…由律师在外部系统查询后放入事项”（`due-diligence/SKILL.md:35`），没有任何外部数据工具。这是产品边界（检索不带当事人信息，准则第 8 条），不是假实现，但律师对“尽调”的期待与能力差距大【已核实】 |

验收卡覆盖：`eval/cards/cards16.json` 60 张，每张卡 id 都对应一张场景卡（另有 1 张 free），48 种卡各 1～2 张【已核实】——tabular-review 无验收卡。

---

## 七、与智合 AI 开源 Skills 对比（只列对 V17 具体问题有用的）

依据：`research/2026-10-22-技能目录复核.md`；上游源码 `research/2026-10-21-智合AI调研/上游来源/legal-agent-skills/`（本地已存，未重新联网）。

1. **公共规范“单一来源 + 构建期注入”**【已核实】——上游 `build_skills.py:5-11` 原文“conventions/ 是研发期的唯一事实来源…部署前必须把该 skill 实际需要的规范内容注入它自己的 references/。单一来源 + 构建期注入，避免了「多处维护、迟早不一致」”；`INJECT` 字典按方法列需要的规范文件（retrieval-contract、output-formats、time-effect、code-tables），且“只注入真正用得到的”。V17 的 `build-skills.mjs` 只整目录拷贝（`:59-62`），公共段落靠手抄（B1、B2、B6）。**直接可借**：在 `content/skills/` 下建 `_common/`（论点确认协议、诉讼文书公共附件、期限口径、工具不可用兜底），build-skills.mjs 按 frontmatter（例如 `kwl.inject: [outline-protocol, litigation-annex]`）拷进各方法 references/，方法正文一句“按 references/outline-protocol.md 执行”。改动约 40 行构建脚本，签名与 manifest 机制不变。
2. **共享脚本同样构建期分发**——上游 `SHARED_SCRIPTS`（`build_skills.py:37-44`）。V17 的对应物是内核工具（calc.*、deadline），已经更好（上游 `lit-analyze-limitation/scripts/limitation.py` 用“年数×365”算期间，复核文档已指出缺陷）。**V17 保留**，不借。
3. **粒度**——上游诉讼线 27 个、拆到“请求权基础分析”“时效分析”“管辖分析”等分析型小技能，再由 `experts/*/EXPERT.md` 组合（复核文档：专家“绑定 6 个技能”）。V17 是一卡一大方法、方法内含完整工作流。对 V17 的“漏分析”扣分有参考意义：上游把“请求权基础/要件”“时效”作为可复用分析步骤；V17 只在 issue-evidence-matrix、procedure-check 里有，起草类方法各自重写一遍分析要求。**不建议**照搬多技能组合（Kimi Code 一次任务多次加载方法会增加往返，且主交付物核对按单一方法绑定）；**可借**的是把“请求权基础—要件—证据”分析清单做成公共 reference 注入起草类方法（与第 1 条同一机制）。【推断】
4. **质量自查的写法**——复核文档第 3 节第 1 条指出上游 34 个专家“验收主要靠共同规则，难以让不同实施者得到一致判定”，并为每个专家补了“产物与业务一致 / 关键错误拦截”两条可判定标准。V17 方法末尾的“自检清单”多为“- [ ] 没有…”的禁止项（例如 `hearing-outline/SKILL.md:81`、`labor-dispute/SKILL.md:112` 都是质量说明行的否定检查），其中一部分已由内核检查/清理接管。**可借**：每个方法自检只留 2～3 条该业务独有、可判定的正向标准（如“答辩书逐项回应了对方每一项请求”），删掉内核已兜底的禁止项——同时也是对“漏分析”最对症的写法。【推断】
5. **规范按需注入，目录越小越聚焦**——上游注释原文“只注入真正用得到的——skill 目录越小，模型读起来越聚焦”。V17 每次任务都发约 2 万字的 AGENTS.md（含 2,850 字历史括注），加上方法正文；对应 T8 建议。

---

## 八、成熟、应当保留不动的设计

1. **主交付物核对在构建期与运行期双重落地**【已核实】：`build-skills.mjs:73-77` 主交付物是 docx/xlsx 时构建期强制 tools_required 含出文书/出表工具；运行期 `executor.ts:1299-1303` 没交出主交付物不记“完成”。
2. **论点确认的工具层闸门**【已核实】：`registry.ts:445-446` `assertOutlineSettled`，确认前 render_report 拒绝；绕道产出的成果带 open_items（`executor.ts:1268`）。闸门本身不应动，只把协议文字去重（B1）。
3. **成果入库检查点与对账**【已核实】：`executor.ts:1077-1108` 检查点缺失或 hash 不符转人工对账，不默认成功；结果不明的副作用调用不重跑。
4. **等待律师的时间不计工作时限**【已核实】：`executor.ts:1150-1151`（`pollDeadline += now - lastTick`）；到时限主交付物已交出按部分完成结算（`:1131-1140`）。
5. **交付前检查随工具结果回给模型 + 确定性清理**【已核实】：`registry.ts:449-456`；记录显示模型对报出的问题基本都改（154 份只剩 9 份）。只需扩范围（B5）。
6. **确定性计算工具**（calc.interest / deadline / labor / court_fee）【已核实 清单】：比上游脚本可靠（见第七节第 2 条）。
7. **独立复核“不带起草上下文” + 法条原文随附 + 律师回答随附**【已核实】：`executor.ts:1747-1750`。保留机制，只改失败语义（B11）与覆盖面（B12）。
8. **不靠 AI 的本机流程**（s2 案卷整理、s1b 回稿比对、s6 脱敏）【已核实】：`executor.ts:660,751,806`，确定、快、免费，不该被 Agent 化。
9. **场景卡 notFor / intents 防误路由**【已核实】：例如 `scenarios.ts` casefile 卡（约 :164-166）的 notFor 注释说明第 34 批的误引事故。
10. **方法签名分发与 tools_required 构建校验**【已核实】：`build-skills.mjs:66-68`。

---

## 九、按“收益 / 成本”排序的前 10 条建议

| 序 | 建议 | 类型 | 收益 | 成本 | 依据 |
|---|---|---|---|---|---|
| 1 | 删掉方法里把“风险卡序号 / 审查工作台 / 事实时间线”写进文件的输出规格，INTERNAL_PATTERNS 加这几个词 | 精修 | 消除最高频同类缺陷的直接来源 | 3 个方法 + 1 条正则 | B5 |
| 2 | 独立复核失败先重试一次，仍失败记 partial“未经独立复核” | 精修 | 去掉“成功但未复核”假象 | executor 一处 | B11 |
| 3 | 方法协议改为“取舍题与论点确认放进同一次提问” | 精修 | 起草类单少一次人工停顿 | 提示词（界面已支持） | B10 |
| 4 | 场景卡任务默认不出计划；“直接做”档代批模型自发计划；系统提示第 1 条改为按 plan_first 下发 | 精修 | 每张卡少一次停顿与一次往返 | policy.ts 一行 + 默认值 + 提示词 | B7、B9 |
| 5 | edit_draft 锚点复用 locateQuote 的放宽定位，失败返回相近原文 | 精修 | 10/37 的失败大部分可一次写入 | edit-draft.ts 局部 | B13 |
| 6 | 建 `_common/` 片段 + build-skills 构建期注入，收拢论点协议、期限口径、诉讼文书附件、工具兜底 | 重构（小） | 9～18 处重复改一处；消除漂移 | 构建脚本约 40 行 + 方法改引用 | B1、B2、第七节 1 |
| 7 | 删 18 处质量说明句与 41 行 kwl-docx/kwl-xlsx 兜底复述，由准则/内核兜底 | 删除 | 方法变短、少一类漂移 | 纯文本 | B6、5.2 |
| 8 | 准则与方法里的历史括注移出提示词 | 精修 | 每次调用少约 2,850 字准则 + 1.3 万字方法括注（按需加载部分） | 纯文本 | T8 |
| 9 | 自由描述任务由内核用 intents 先猜方法 | 重构（小） | 方法加载、主交付物核对、复核种类对自由任务也确定生效 | 内核一处 + 复用 scenarios 的 intents | T6 |
| 10 | 按复核 kind 统计“必须改”命中率，再决定表格类是否免修改轮；高速档定案后再决定 D-178 是否合并回单段 | 暂缓 | 最多省 16% 耗时中的一部分 | 先跑统计 | B12、T1 |

---

## 十、没查到 / 未核实
- edit_draft 10 次“找不到”的逐条样本（账本只有计数），所以“主要在工具设计”是按代码差异推断。
- riskcards 是否有可对外显示的稳定“问题序号”字段（B5 建议依赖它）。
- s2 规则抽取与精读版 facts.submit 是否去重（第六节证据整理行）。
- 高速档下复核推理强度、表格类复核命中率（B12、T5）——没有分 kind 的数据。
- `packages/kap-host` 只看了计划确认与策略相关的几处；Windows 侧行为未看。
