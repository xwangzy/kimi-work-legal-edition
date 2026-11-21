# A · 法律 Skills 审计（只读，2026-11-22）

审计范围：分支 `worktree-kimi-legal-b55-ux-skills`（头 8e81698）下 `platform/content/skills/` 全部 33 个方法、`platform/apps/desktop/src/lib/scenarios.ts` 全部 48 张场景卡、开始面板 `ScenarioStart.tsx`、内核发起与提示词拼装（`packages/kernel/src/api/index.ts`、`executor/executor.ts`、`services/matter-facts.ts`），对照智合 AI 开源仓库 `Decikingship/legal-agent-skills`（HEAD，2026-11-22 读取）。没有改产品代码，没有运行应用。

下文路径缩写：`S` = `platform/apps/desktop/src/lib/scenarios.ts`；`SS` = `platform/apps/desktop/src/components/ScenarioStart.tsx`；`EX` = `platform/packages/kernel/src/executor/executor.ts`；`API` = `platform/packages/kernel/src/api/index.ts`；`SK/<id>` = `platform/content/skills/<id>/SKILL.md`；`ZH/` = 智合仓库根目录。

---

## 一、一页结论

### 用户指出的缺陷：已复现，根因有三层

1. **界面层**：起草起诉状卡只定义了一个字段 `court`（`S:256`），`minMaterials: 0`（`S:257`），`gives` 只写“已整理的事实与金额（建议先做…）”（`S:248`）。开始面板按 `card.fields` 渲染（`SS:363-393`），所以只有“拟受理法院”和通用的“补充要求（可选）”（`SS:400-404`）。没有案情、当事人、诉讼请求、标的额入口。这不是遗漏，而是设计原则：文件头写明“只保留事项头之外、本方法必需的 ≤ 3 个字段；其余由 Agent 在计划阶段追问”（`S:5-6`）。
2. **内核层**：Agent 任务发起前没有任何“事项是不是空的”检查。只有本机确定性流程 S2/S6 会因为没有材料报错（`EX:773`、`EX:828`）；Agent 场景照常加载材料、启动宿主（`EX:1150`、`EX:1234`）。开始面板里“材料还不齐”那句提示只在 `card.minMaterials > docIds.length` 时才追加（`SS:89`），起诉状卡的 `minMaterials` 是 0，所以**没材料时任务说明里一个字都不提**。
3. **方法层**：`SK/pleading-draft:29-32` 规定先 `facts.list`、算金额、`materials.list`，之后才“用提问工具一次问清，不超过 3 问”（法院与管辖、请求项目、保全与第三人）；确认事实为零时“照常起草”。没有“材料和事实都为空、律师也没写案情”这一分支。所以模型照方法把空事项读一遍，再一次性问纠纷类型、事实、诉请、管辖。成文前还有第二次等待：论点提纲确认（`SK/pleading-draft:42`）。律师至少等两轮。

### P0（阻断律师完成任务）

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| P0-1 | 起草类、允许“无材料”的卡没有案情和请求入口：起诉状（`S:256`）、律师函（`S:632-635`）、金额测算（`gives` 写“或直接告诉我本金与日期”，`S:227`，但没有本金、日期字段，`S:234-239`）、仲裁申请书（只有机构与一句请求，`S:321-324`） | 见左 | 律师没上传材料时，只能把案情写进标着“可选”的两行补充要求框（`SS:401-403`），否则要到任务中途才被问 |
| P0-2 | 发起前没有预检：空事项、没有确认事实、没有“对方文书”时，没有拦截，也没有告诉模型 | `EX:1129-1234`（没有材料数、事实数的判断）；`SS:89` | 模型花几分钟读空事项再回头问，十几分钟后律师才补信息 |
| P0-3 | 当事人身份信息没有结构化存储：事项只有委托人、相对方两个名称（`platform/apps/desktop/src/components/NewMatter.tsx:34`），当事人面板是代号词典（名称、类型、别名、角色），没有住所、信用代码、法定代表人（`platform/apps/desktop/src/components/Parties.tsx:10-19`）；送进提示词的只有“委托人=…；相对方=…”（`platform/packages/kernel/src/services/matter-facts.ts:26-36`） | 见左 | 起诉状、答辩状、仲裁申请书、强制执行申请书的“当事人”一节只能全写【待填】；律师每份文书都要手补 |

### P1（高频摩擦）

| # | 问题 | 证据 |
|---|---|---|
| P1-1 | 方法里“一次问清 ≤ 3 问”的内容，大多是开工前就能收的：起诉状的法院与管辖、请求项目、保全（`SK/pleading-draft:32`）；答辩状的送达日、境内住所、总体态度（`SK/defense-draft:32`，这三项卡上其实已收，`S:276-279`，但只有律师填了才算“已知”，卡上三项都不是必填）；仲裁申请书的机构规则、请求项目（`SK/arbitration-application:32`）。界面不收，方法只能中途问 | 见左 |
| P1-2 | 文书类方法两段等待：先“一次问清”，再“论点提纲确认”（`SK/pleading-draft:42`；`AGENTS.md` 第 6 条要求取舍题并进论点确认，`platform/content/skills/AGENTS.md:14`），但方法第 2 节第 4 项的提问是在提纲之前单独发出的 | `SK/pleading-draft:32` 与 `:42` |
| P1-3 | 起诉状方法自带的参考文件与正文、内核提示词互相矛盾：参考表写“事实与理由：仅限律师确认的事实”“受诉法院缺失写【待确认】”（`SK/pleading-draft/references/civil-complaint-fields.md` 第一节表格），正文写未确认事实照写（`SK/pleading-draft:29`），内核要求对外文书正文不留【待确认】（`EX:1021`） | 见左 |
| P1-4 | 卡片字段键与方法 `arguments` 对不上，且没有测试：例如上诉状卡收 `ruling/scope/domicile`，方法只声明 `served_on`（`S:298-304`，`SK/appeal-draft:6`）；修改文书卡收 `opinion`，方法声明 `focus`（`S:611`，`SK/doc-revise:6`）；起草合同方法要 `$side` 且“先问”（`SK/contract-draft:6,24`），卡上没有立场字段（`S:754-758`）。现有用例只核对卡片固定参数 `args`，不核对律师填写的字段（`platform/apps/desktop/test/scenarios.test.ts:60-74`） | 见左 |
| P1-5 | “你得到什么”与方法 outputs 不一致：庭审提纲卡只写 Word（`S:337`），方法还出《举证质证顺序表.xlsx》（`SK/hearing-outline:15`）；交割清单卡只写 xlsx（`S:828`），方法还出《交割清单说明.docx》（`SK/closing-checklist:15`）；交易法规研究卡写“来源与引用核验表”（`S:843`），方法出的是《来源目录.xlsx》（`SK/legal-research-memo:16`） | 见左 |
| P1-6 | 起诉状卡“你给什么”建议先做整理案卷、金额测算（`S:248`），但面板不检查做没做、也不给入口；做过的成果（计算明细）也不会被预填成诉讼请求 | `S:248`、`SS:292-294` |

### P2（精致度）

- 字段同时进任务说明和“方法参数”，提示词里重复一遍（`S:1169-1179`、`S:1211-1229`、`EX:1014`）；长文本字段在方法参数里被截到 300 字（`S:1176`、`API:1750`），模型看到一份完整、一份截断的同一段话。以后加“案情”长字段必须只进任务说明、不进方法参数，否则还会撞上“方法参数至多 8 项”（`API:1744`）。
- 输入框里写的整段话，起诉状卡把它放进“补充要求（可选）”（`S:1203-1209`：只有 question/opinion/situation/issue 四种主栏会被预填），律师写的案情被标成“可选的补充”。
- 起草合同方法“不猜立场：先问”（`SK/contract-draft:24`），即使事项立场已有、卡上任务说明写了“我方立场以事项为准”（`S:753`）；靠 `EX:1027`“以律师的说明为准”化解，但模型可能仍会多问一次。

### 建议最先改的 5 件事

1. **起诉状、仲裁申请书、律师函、金额测算四张卡补“案情 / 请求 / 金额”字段**，没有材料或没有确认事实时必填。文件：`S:223-263`、`S:311-331`、`S:619-639`；`SS:85-98`（必填判断）、`SS:363-393`（渲染）。
2. **发起前预检 + 把预检结果写进提示词**：面板统计本事项材料份数、确认事实条数、各材料角色（`SS:100-108` 已经为争点卡查过确认事实数，可复用），快照里带上；`EX:1049-1053` 的 `agentGoalPrompt` 加一段【开工前已知】，写明“材料 0 份、确认事实 0 条、案情以任务说明为准、以下事项律师已答”。
3. **把方法“一次问清”里能前置的项目搬到开始面板**，方法改成“已知的不问”并把提问并进论点确认那一次：`SK/pleading-draft:32,42`、`SK/arbitration-application:32`、`SK/defense-draft:32`、`SK/appeal-draft:33`、`SK/enforcement-application:31`、`SK/preservation-application:33`。
4. **事项级“当事人信息”**（诉讼地位、自然人或机构、名称、住所、信用代码或身份证号、法定代表人），存进事项、按现有代号机制送出、导出时还原：`NewMatter.tsx:34`、`Parties.tsx`、`matter-facts.ts:26-36`。
5. **契约用例**：卡片字段 ↔ 方法 `arguments`（或新增的 `inputs`）、卡片 `gets` ↔ 方法 `outputs` 逐项核对；顺手修掉 `civil-complaint-fields.md` 与正文的矛盾。文件：`platform/apps/desktop/test/scenarios.test.ts:60-74`、`SK/pleading-draft/references/civil-complaint-fields.md`。

### 没读到、没验证的

- 没有运行应用，没有复现那次“十几分钟”的真实任务；时长判断来自代码顺序推断，没有任务日志佐证。
- 33 个 SKILL.md 只有 `pleading-draft` 全文逐行读过；其余读了前言（arguments、outputs、requires_outline）和“提问 / 停止 / 先请律师补充”相关行（逐条行号见第二节），没有逐行通读。
- `Home.tsx`、`OutlineConfirm.tsx`、`AskHost.tsx` 未细读；中途提问卡的渲染以 `lib/question-answers.ts` 为准，`lib/ask.ts` 只是应用内确认框，与任务中途提问无关。
- `research/legal_workflows.md`、`research/skills_mcp.md`、智合三次调研、Harvey/LegalOn 资料没有引用（仓库里名字含 Harvey 的只有 `research/2026-10-09-独立终审v8/evidence-B/harvey-terms.txt`，未读；没有找到 LegalOn 文件）。
- 智合仓库只读了 `conventions/expert-template.md`、`dist-experts/诉讼文书专家.expert` 的 EXPERT.md，以及 9 个 skill 的“输入要素清单”。

---

## 二、逐 Skill 表

### 读表前先看：字段怎么进提示词（所有卡通用）

开始面板字段 → `buildGoal` 按卡上 `goal` 模板拼成任务说明，空字段整句省略（`S:1211-1229`）；同时 `skillArgsOf` 把同一批字段作为“方法参数”（`S:1169-1179`，键须小写字母，值截 300 字）→ `SS:145` → `platform/apps/desktop/src/components/RunSheet.tsx:61` 以 `skill_args` 发出 → `API:1739-1753` 校验（≤ 8 项、≤ 300 字）→ 写进任务快照（`API:1839`）→ 执行时 `EX:1138-1140` 读出 → `methodPromptLine` 写成“方法参数：k=v；…”（`EX:1014`）→ `agentGoalPrompt` 拼上事项口径（立场、法域、截止日、委托人、相对方、阶段、事件时点、地域，`EX:1049-1053`、`matter-facts.ts:26-36`）→ 整段令牌化（`EX:1177`）→ 交宿主（`EX:1234`）。

结论：**卡上收的字段都进了提示词，没有“收了不用”的死字段**（逐卡核对 `goal` 模板里的 `{key}` 与 `fields`，全部对得上）。断点在另外两处：①方法要、界面不收（下表“缺口”列）；②界面收了、方法正文不认这个参数名，只能靠模型从“方法参数”和任务说明里自己对上（下表“参数名”备注）。确认过的事实不进提示词，由模型调用 `facts.list` 自取（`platform/packages/kernel/src/tools/registry.ts:830-838`）。

图例：必备＝没有就写不出可用稿；建议＝没有会写成【待填】或明显变弱；可选＝锦上添花。“收在哪”：面板＝开始面板；中途＝任务里提问；事项＝事项级数据，预填。

### 2.1 诉讼仲裁（18 个方法）

| 方法 / 卡（行号） | 律师真实需要先给的 | 面板现有字段 | 方法对缺材料怎么办 | 交付物一致性 | 缺口与建议字段（控件 · 必填 · 收在哪 · 理由） |
|---|---|---|---|---|---|
| **pleading-draft** 起草起诉状（`S:244-263`） | 必备：原被告身份要素（机构：名称、住所、信用代码、法定代表人；自然人：姓名、性别、出生日期、民族、住所、身份证号）；案由；诉讼请求逐项（本金、利息或违约金二选一、实现债权费用、担保责任、诉讼费），每项金额与计算口径（基数、起算日、利率、暂计至）；事实与理由要点；受诉法院与管辖依据（协议、被告住所地、合同履行地、专属）。建议：证据清单；时效起算与中断事实；是否同时申请保全；第三人。可选：法院要素式模板 | 仅 `court` 短文本（`S:256`），`minMaterials: 0`、`allowPartial`（`S:252,257`） | 先读事实与材料、算金额，再“一次问清 ≤ 3 问”（`SK/pleading-draft:29-32`）；事实为零照常起草，缺项写【待填】，当事人用代号（`:33`）；成文前论点确认（`:42`） | 一致（`S:249` 对 `SK:16`） | ①**案情经过** 长文本 · 无材料且无确认事实时必填 · 面板（P0-1）；②**诉讼请求** 结构化列表（项目单选：本金/利息/违约金/律师费/担保责任/其他 + 金额 + 计算口径短文本），有金额测算成果时预填 · 建议 · 面板；③**标的额** 金额 · 可空（由②合计）· 面板；④**管辖依据** 单选（协议管辖/被告住所地/合同履行地/不动产所在地/待核）· 可空 · 面板，与 `court` 同排；⑤**同时申请财产保全** 单选（是/否/先问我）· 面板；⑥**被告、第三人** 当事人选择（取事项当事人，P0-3）· 必备 · 事项；⑦案由 · 可空 · 中途（由模型初定，律师在论点卡确认） |
| **defense-draft** 起草答辩状（`S:265-286`） | 必备：对方起诉状及证据；收到起诉状副本日期（答辩期、管辖异议截止）；对各项请求的态度。建议：境内有无住所；是否提管辖异议、时效抗辩、反诉；我方证据。可选：已知对方证据弱点 | `received_on` 日期、`domicile` 单选、`stance` 单选（`S:275-280`），都不是必填 | 找不到起诉状先问，仍没有不凭转述起草（`SK/defense-draft:29`）；一次问清 ≤ 3 问（`:32`） | 一致 | ①`received_on` 改**必填**（答辩期与管辖异议期不可逆，智合同样列为必需：`ZH/dist/lit-draft-defense/SKILL.md` 输入要素清单）；②**对方起诉状** 材料角色（必须勾一份并标“对方起诉状”）· 必填 · 面板；③**拟提程序抗辩** 多选（管辖异议/时效抗辩/主体不适格/反诉/先问我）· 面板（这是 `AGENTS.md:14` 说的“只有律师能定的取舍”） |
| **appeal-draft** 起草上诉状（`S:288-310`） | 必备：一审判决或裁定书；送达日；不服的判项；上诉请求（改判/发回/撤销）。建议：一审庭审笔录与证据；新证据；境内住所 | `ruling` 必填、`served_on`、`domicile`、`scope`（`S:299-303`） | 没有判决书先请补充，仍没有只交清单（`SK/appeal-draft:30,101`） | 一致 | ①`served_on` 改必填（上诉期十五日/十日，智合列必需：`ZH/dist/lit-draft-appeal/SKILL.md`）；②`scope` 选“部分判项”时展开**不服的判项**长文本 · 面板（现为“先问我”，必然多一次中途提问）；③**上诉请求** 单选（改判/发回重审/撤销）· 面板；④判决书 材料角色 · 必填。参数名：方法只声明 `served_on`（`SK:6`），`ruling/scope/domicile` 靠模型对应 |
| **arbitration-application** 仲裁申请书（`S:311-331`） | 必备：含仲裁条款的合同；申请人、被申请人身份；仲裁请求逐项与金额；仲裁机构。建议：机构现行仲裁规则与收费；时效事实；是否经法院申请保全 | `institution`、`claims` 短文本，都可空（`S:322-323`） | 找不到仲裁条款先问是否仍按仲裁起草（`SK/arbitration-application:102`）；一次问清 ≤ 3 问（`:32`） | 一致 | 同起诉状①②③⑤⑥；`claims` 改结构化请求列表；**机构规则文件** 材料角色 · 建议 · 面板（方法明说“以我提供的机构文件为准”，`S:320`） |
| **labor-arbitration-draft** 劳动仲裁申请书 / 答辩书（`S:492-537`、`S:1008-1030`） | 申请书必备：入职日、离职日与离职方式、月工资（解除前十二个月平均）、请求项目；答辩书必备：收到申请书副本日期、对方请求。建议：书面合同订立日、加班与年休假、社保、当地上年度社平工资（三倍封顶） | 申请书：`side` 必填、`claims`（`S:505-506`）；答辩书：`received_on` 必填、`claims`（`S:530-531`、`S:1023-1024`） | 合并成一次提问，与论点确认并成同一次（`SK/labor-arbitration-draft:42`） | 一致（答辩卡写了 `primary`，`S:525,1019`） | 申请书补：**入职日、离职日** 日期 · 建议 · 面板；**离职方式** 单选（被辞退/协商/主动辞职/合同到期/仍在职）· 面板；**月工资** 金额 · 建议 · 面板（智合 `ZH/dist/lit-labor-dispute/SKILL.md` 列为必需与强烈建议）；`claims` 改多选（违法解除赔偿金/二倍工资/加班费/年休假/经济补偿/社保/其他） |
| **labor-dispute** 劳动者请求梳理 / 劳动仲裁应对 / 解除前评估（`S:469-491`、`S:982-1007`、`S:1031-1050`） | 同上；应对方案另需开庭日；解除前评估需解除理由、规章制度与公示材料 | 劳动者：`situation` 长文本必填（`S:485`）；应对：`claim` 必填、`received_on`、`hearing`（`S:999-1001`）；解除前：`reason` 必填（`S:1044`） | 出方案前合并一次提问（`SK/labor-dispute:34`）；`materials.list` 不可用即停（`:77`） | 一致（解除卡写 `primary`，`S:1041`） | 应对卡 `received_on` 改必填（答辩期、管辖异议、反申请都以它为限，`S:993-997` 注释自己也这么说）；三卡共享“劳动关系要素包”（入职日、离职日、月工资、离职方式）。参数名：`situation/claim/received_on/hearing/reason` 都不在方法 `arguments: [side, mode]` 里（`SK/labor-dispute:6`） |
| **preservation-application** 财产保全申请（`S:353-372`） | 必备：保全阶段；请求保全数额；被申请人财产线索（账户、不动产、车辆、股权）；担保方式。建议：受理法院、案号；情况紧急的理由 | `stage` 必填、`amount` 短文本（`S:364-365`） | 一次问清 ≤ 3 问（`SK/preservation-application:33`） | 一致 | ①`amount` 改金额控件，有起诉状请求时预填合计；②**财产线索** 长文本或材料角色 · 建议 · 面板；③**担保方式** 单选（现金/财产/保险公司保函/第三人保证/待定）· 面板 |
| **enforcement-application** 强制执行申请（`S:373-393`） | 必备：执行依据（生效文书）与生效证明；履行期限届满日；已履行情况；被执行人信息。建议：财产线索；是否已保全 | `effective_on`、`due_on`、`paid`（`S:384-387`） | 执行依据缺失先请补充，仍没有只交清单（`SK/enforcement-application:101`） | 一致 | `due_on` 改必填（申请执行期间从此起算；智合列必需：`ZH/dist/lit-plan-enforcement/SKILL.md`）；执行依据 材料角色 · 必填；**已保全** 单选 · 建议 |
| **cross-exam-opinion** 质证意见（`S:394-414`） | 必备：对方证据目录与证据；我方地位；争议焦点。建议：是否见过原件；我方反证；举证期限 | `side` 必填、`proof_deadline`、`hearing_on`、`extra`（`S:406-409`） | 对方证据不在事项中先请补充（`SK/cross-exam-opinion:79`） | 一致 | **争议焦点** 短文本 · 建议 · 面板（智合列必需：`ZH/dist/lit-cross-examination/SKILL.md`）；对方证据 材料角色 · 必填；**原件核对情况** 单选 · 可选 |
| **agency-statement** 代理词（`S:415-429`） | 必备：法庭归纳的焦点；庭审笔录或要点；我方最终请求或答辩意见。建议：庭后补充证据；提交期限 | `focus_points` 必填（`S:425`），`minMaterials: 0`（`S:426`） | 焦点没有时先问（`SK/agency-statement:28`）；再一次问清 ≤ 3 问（`:32`） | 一致 | `minMaterials` 为 0 却要求“庭审笔录或要点”：没有笔录时需要**庭审要点** 长文本 · 无材料时必填 · 面板；**我方地位** 预填事项立场；**提交期限** 日期 · 可选 |
| **hearing-outline** 庭审提纲（`S:332-352`） | 必备：诉辩文书；双方证据；开庭日期与程序（一审/二审/证据交换）；我方地位。建议：法庭已归纳焦点；证人、鉴定人出庭 | `hearing_on`、`side` 必填、`focus_points`（`S:343-345`） | 缺什么照常出并标明（`SK/hearing-outline:5`）；一次问清 ≤ 3 问（`:31`） | **不一致**：卡只写《庭审提纲.docx》（`S:337`），方法还出《举证质证顺序表.xlsx》（`SK/hearing-outline:15`） | **程序** 单选（一审/二审/证据交换）· 面板；`hearing_on` 改必填；`gets` 补上 xlsx |
| **procedure-check** 管辖与时效核查 / 收到起诉：第一步（`S:447-468`、`S:1070-1090`） | 必备：拟主张或对方主张的请求；争议解决条款；带日期的催告、对账、确认材料；被诉时的收到日期 | 诉讼线：`claims` 必填、`side`（`S:459-461`）；企业线：`doc_kind`、`received_on` 必填（`S:1084-1085`） | 一次问清 ≤ 3 问（`SK/procedure-check:30`） | 一致 | 诉讼线选“已被诉”时应出现 `received_on`（方法声明了 `received_on`，`SK/procedure-check:6`，诉讼线卡没收）；**标的额** 金额 · 建议（级别管辖要用） |
| **amount-calc** 金额测算（`S:223-243`） | 必备：本金与变动（付款、到期日）；计息起算日；利率口径；截止日。建议：合同计息条款；抵扣顺序 | `mode` 必填、`items` 多选必填、`as_of`、`rate`（`S:235-238`） | 计息约定不明时问口径（`SK/amount-calc:31`）；合并一次问 ≤ 3 问（`:34`）；计算工具不可用即停（`:59`） | 一致 | `gives` 说“或直接告诉我本金与日期”（`S:227`），却没有字段：补**本金** 金额、**起算日** 日期、**付款记录** 长文本（无材料时必填）· 面板 |
| **casefile-organize** 整理案卷（精读版）（`S:169-183`） | 必备：案卷材料；我方地位；案由或争议类型。可选：关注期间 | `perspective`（`S:179`） | 口径不明一次问清 ≤ 3 问（`SK/casefile-organize:31`） | 一致 | 我方地位预填事项立场（已在事项口径里）；**案由 / 争议类型** 单选 · 可空 · 面板（可与 intake 的 `case_type` 共用选项） |
| **issue-evidence-matrix** 争点与证据分析（`S:184-201`） | 必备：拟主张或应对的请求；我方地位；事实与证据。建议：已知对方抗辩；举证期限 | `claims` 必填、`side`（`S:195-196`），面板对确认事实为零有橙色提示（`SS:456-458`） | 缺口径一次问清 ≤ 3 问（`SK/issue-evidence-matrix:29`） | 一致 | **对方抗辩** 短文本 · 可选 · 面板；`claims` 与起诉状共用请求列表 |
| **case-analysis** 案情分析与诉讼策略（`S:203-222`） | 必备：案卷或案情；我方目标；地位。建议：客户预算与可接受结果；是否已进入程序 | `goal` 必填、`side`（`S:214-215`），`minMaterials: 1` | 缺失一次问清 ≤ 3 问（`SK/case-analysis:32`） | 基本一致（方法另有可选《争点与风险表.xlsx》，`SK/case-analysis:15`） | 允许**无材料时写案情**（现 `minMaterials: 1`，新案只有口头案情时进不来）· 面板 |
| **case-report** 案件进展汇报（`S:944-981`） | 必备：汇报对象；截至日；最新进展。建议：需要管理层决定的事项与截止时间 | `audience` 必填、`as_of`（`S:957-958`、`S:975-976`） | 一次问清 ≤ 3 问，含“材料里没有的进展”（`SK/case-report:32`） | 一致 | **材料外的最新进展** 长文本 · 建议 · 面板（方法第一问就是它）；**待决事项** 短文本 · 可选 |
| **intake-notes** 新案受理与访谈 / 访谈纪要（`S:430-446`、`S:853-868`） | 必备：访谈记录或口头案情；案件类型；我方立场。建议：客户名称与对方名称（冲突检索） | 诉讼线 `case_type`（`S:442`）；非诉线 `who`（`S:864`） | 类型与立场不明一次问清（`SK/intake-notes:30`） | 一致 | 两卡都 `minMaterials: 1`（`S:443,865`）：接案时常常只有电话里听到的情况，应允许**直接写访谈要点** 长文本代替材料 · 面板；方法声明 `side`（`SK/intake-notes:6`），卡上不收，预填事项立场即可 |

### 2.2 非诉（10 个方法）

| 方法 / 卡（行号） | 律师真实需要先给的 | 面板现有字段 | 方法对缺材料怎么办 | 交付物一致性 | 缺口与建议字段 |
|---|---|---|---|---|---|
| **contract-review** 审合同 / 合同审核（`S:641-662`、`S:870-888`） | 必备：合同全文；我方是哪一方（缺了不能做，智合同样写“缺了不执行”：`ZH/dist/nonlit-review-contract/SKILL.md` 输入要素清单）。建议：合同类型；交易背景（强弱、金额量级、长期合作）；是否对方格式文本；客户底线或标准 | `type` 必填（按文件名预选，`SS:202-213`）、`focus` 多选、`redline` 单选（`S:652-654`）；立场取事项（`S:650`） | 立场缺失或对不上一次问清 ≤ 3 问，“不猜立场”（`SK/contract-review:41`）；材料不是合同时问是否改用别的方法（`:46`） | 一致（修订稿由 `redline` 触发第二段，`EX:976-977`） | 事项立场是“其他”或与合同主体对不上时，面板就该让律师选**我方是合同哪一方**（单选，选项从合同首部主体名抽取）· 条件必填；**交易背景** 短文本 · 可选（决定意见激进程度）；**格式文本提供方** 单选 · 可选 |
| **contract-draft** 起草合同（`S:742-762`） | 必备：合同类型；我方立场；主体；标的；价款与支付；交付验收；期限。建议：本所范本；争议解决；谈判底线；签约与履行地 | `type` 必填、`points` 长文本（`S:755-757`） | 立场“不猜：先问”，未答按事项立场，没有就中立写（`SK/contract-draft:24`）；商业数字缺的写【待定】不填数（`:31-33`） | 一致 | **我方立场** 预填事项立场、可改 · 面板（方法声明 `$side`，`SK:6`，卡没收，导致多问一次）；`points` 在没有交易材料时改必填；**争议解决** 单选（我方所在地法院/对方所在地/仲裁/待定）· 可选 |
| **doc-revise** 按你的意见修改文书（`S:599-618`） | 必备：要改的 .docx；修改意见。建议：改到什么程度（只改点到的 / 连带调整）；以谁的立场 | `opinion` 长文本必填（`S:611`），非 Word 不能开始（`SS:96-98`） | 意见不清或矛盾时一次问清 ≤ 3 问（`SK/doc-revise:42`） | 一致 | **修改范围** 单选（只改点到的条款 / 连带调整定义与互引）· 可选 · 面板（方法第二问就是它）。参数名：卡用 `opinion`，方法声明 `focus`（`SK/doc-revise:6`） |
| **redraft-review** 对方回稿：比对与重审（`S:663-678`） | 必备：我方上一稿；对方回稿；哪份是基线。建议：对方是否声明“已接受全部修订”；本轮关注 | `focus` 多选（`S:674`），按勾选顺序传 `baseline/current`（`S:1185-1189`） | 不能确定基线时问（`SK/redraft-review:28`） | 一致 | 勾选两份时在每份旁标“上一稿 / 回稿”（本机比对卡已这样做，`SS:311`；重审卡没有），省掉一次确认 |
| **contract-redline** 修订说明与谈判要点（`S:693-710`） | 必备：已处理的审查意见；读者（客户/对方） | `audience` 必填（`S:704`） | 有未处理的卡时先问是否继续（`SK/contract-redline:31`） | 一致（方法另有《谈判要点表.xlsx》，`SK:15`，卡写“谈判要点（内部）”） | 面板直接显示“还有 N 张未处理”（数据已在工作台），把中途那一问前置 |
| **review-rules-draft** 从范本整理审查要点（`S:711-726`、`S:890-904`） | 必备：范本或标准文本。建议：多份不一致时以哪份为准 | `basis` 短文本（`S:722`） | 范本不一致时问（`SK/review-rules-draft:30`） | 一致 | 勾两份以上时加**以哪份为准** 单选（各份文件名 + “都列出给我选”）· 面板 |
| **due-diligence** 尽调清单 / 尽调发现（`S:763-799`） | 必备：交易类型。建议：目标公司行业（特殊资质模块）；交易规模与时间窗；买方核心关切（智合：`ZH/dist/nonlit-due-diligence/SKILL.md`） | 清单卡 `deal_type` 必填、`focus`（`S:776-777`）；发现卡只有 `deal_type`（`S:795`） | 口径缺失一次问清 ≤ 3 问（`SK/due-diligence:31`） | 一致（发现卡 `primary` 已写，`S:792`） | **目标公司行业** 单选或短文本 · 建议 · 面板；发现卡补 `focus`（方法声明了，`SK/due-diligence:6`） |
| **corporate-resolutions** 股东会与董事会文件（`S:801-822`） | 必备：公司章程；会议类型；公司类型；拟议事项。建议：股东及表决权（或董事名单）；会议日期与方式；关联方回避 | `meeting`、`company_type`、`matters` 均必填（`S:815-817`） | 一次问清 ≤ 3 问（`SK/corporate-resolutions:32`），没有章程逐项标待核（`S:811`） | 一致（`primaryBy` 已按会议类型切换，`S:813`） | **会议日期** 日期、**召开方式** 单选（现场/通讯）· 可选 · 面板（方法第二问） |
| **closing-checklist** 交割清单（`S:823-837`） | 必备：定稿或已签交易文件含附件；预计交割日；我方是哪一方 | `closing_date`（`S:833`） | 一次问清 ≤ 3 问（交割日、哪一方、哪份是最终版，`SK/closing-checklist:30`） | **不一致**：卡只写 xlsx（`S:828`），方法还出《交割清单说明.docx》（`SK/closing-checklist:15`） | 我方立场预填事项；`gets` 补上说明 docx |
| **tabular-review** 表格审阅（无场景卡；从事项材料页发起，`platform/apps/desktop/src/pages/Matter.tsx:190,210`） | 必备：表、列定义、要审的材料 | 由表格本身提供 `table_id`、`mode` | 没有 `table_id` 即停（`SK/tabular-review:30`） | 一致（成果在材料页） | 无需开始面板；方法库页不列它是对的 |

### 2.3 合规与咨询（5 个方法）

| 方法 / 卡（行号） | 律师真实需要先给的 | 面板现有字段 | 方法对缺材料怎么办 | 交付物一致性 | 缺口与建议字段 |
|---|---|---|---|---|---|
| **client-advice** 出具法律意见书 / 合规问答（`S:560-581`、`S:905-923`） | 必备：问题；事实前提。建议：致送对象；用途（内部决策/对外出示）；时间要求 | 意见书：`question` 必填、`addressee`（`S:575-576`）；问答：`question` 必填、`background`（`S:917-918`） | 必要时请律师确认问题改写（`SK/client-advice:26`），关键事实缺失列为假设（`:27`） | 一致 | **用途** 单选（内部决策/对外出示/监管报送）· 建议 · 面板（影响意见书限制条款写法）；`background` 改长文本 |
| **legal-research-memo** 法规研究备忘录 / 交易法规研究（`S:538-559`、`S:838-852`） | 必备：研究问题；事件时点。建议：地域；问题背景 | 诉讼线：`question` 必填、`when`（`S:551-552`）；交易线只有 `question`（`S:848`） | 问题过宽先拆、请律师确认（`SK/legal-research-memo:28`）；核心法源不在库要先说（`:32`） | 交易线**不一致**：卡写“来源与引用核验表”（`S:843`），方法出《来源目录.xlsx》（`SK:16`） | 交易线补 `when`；两卡补**地域** 短文本，预填事项地域 |
| **citation-check** 文稿体检：引用与论证（`S:582-598`） | 必备：一份文稿；事件时点 | `when`（`S:594`），文件名作 `document` 传入（`S:1187`） | 不明时一次问清 ≤ 3 问（`SK/citation-check:28`） | 一致 | `when` 预填事项事件时点（事项已有字段，`matter-facts.ts:33`） |
| **policy-review** 规章制度审查（`S:1051-1069`） | 必备：制度文本；所在地。建议：新制定/修改/体检；民主程序与公示材料；有无工会、职代会 | `policy_type` 必填、`place`（`S:1063-1064`） | 一次问清 ≤ 3 问（`SK/policy-review:31`） | 一致 | `place` 预填事项地域；**审查目的** 单选（新制定/修改/体检/拟据此解除员工）· 面板；**民主程序材料** 材料角色 · 建议 |
| **demand-letter** 律师函 / 履约问题与催告函（`S:619-639`、`S:924-943`） | 必备：函件类型；以谁的名义发；要求对方做什么；期限；事实要点（合同、违约事实、欠款数额）。建议：收件人与送达地址；是否抄送保证人 | 诉讼线：`letter_type` 必填、`deadline`（`S:633-634`），`minMaterials: 0`；企业线：`issue` 必填、`letter_type`（`S:936-938`） | 一次问清 ≤ 3 问：名义、要求与期限、是否发保证人（`SK/demand-letter:32`） | 一致 | 诉讼线没有事实入口（与起诉状同一个 P0-1）：补**事实要点** 长文本 · 无材料时必填；**发函名义** 单选（本所受托/当事人自行）· 面板；**主张金额** 金额 · 可选；**收件人** 当事人选择 · 事项 |

### 2.4 不经方法的三张卡（不在 33 个方法内，列出备查）

整理案卷本机版（`S:144-167`，`s2.case_file`，字段 `issues` 直接给争点矩阵，`SS:110`）、回稿比对不用 AI（`S:679-692`）、客户版与对外脱敏（`S:727-741`）：都是确定性流程，缺材料时内核直接拒绝（`EX:773`、`EX:828`），没有本次审计说的问题。

---

## 三、按任务类型动态收集的最小模型

### 3.1 原则（替换 `S:5-6` 的“≤ 3 个字段，其余由 Agent 追问”）

1. **开工前必须在面板收的只有四类**：①决定不可逆期限的日期（收到副本日、送达日、履行期限届满日、开庭日）；②立场与文书类型；③没有材料、也没有确认事实时的案情；④只有律师能定、又会写进对外文书的取舍（保全、程序抗辩、互斥请求、发函名义）——这一类给“先问我”选项，选了才在中途问。
2. **中途才问的只有读完材料才知道的**：材料之间矛盾、案由初定、合同里有几种计息口径要选。并且和论点确认放进同一次提问（`AGENTS.md:14` 已有这条规则，方法第 2 节的“一次问清”要改成同样口径）。
3. **能从事项预填的一律预填，标“按事项预填，可改”**（面板已有两处先例：合同类型按文件名预选 `SS:202-213`，我方地位按事项立场预选 `SS:228-238`）。
4. **默认只显示必填项和 2～3 个高频项**；条件字段（例如“没有材料时写案情”）只在条件成立时出现；其余折进“更多（可选）”。不给每张卡堆大表单。

### 3.2 共享字段包

| 字段包 | 字段 | 控件 | 必填规则 | 预填来源 | 用到的方法 |
|---|---|---|---|---|---|
| 案情 `case_text` | 案情经过（谁、何时、签了什么、我方做了什么、对方怎么违约、欠多少、催过没有） | 长文本 | 勾选材料 0 份**且**确认事实 0 条时必填；否则可选，标签改为“材料里没有的情况” | 无（律师写） | pleading、arbitration-application、demand-letter（诉讼线）、case-analysis、intake-notes、agency-statement（无笔录时写庭审要点）、amount-calc（付款记录）、labor-dispute（已有 `situation`，`S:485`）、contract-draft（已有 `points`，`S:757`） |
| 请求 `claims` | 逐项：项目、金额、计算口径 | 可增删的行（项目单选 + 金额 + 短文本） | 起诉状、仲裁申请书至少一行，金额可写“待测算” | 本事项最近一次金额测算的计算明细（主交付物 `计算明细.xlsx`，`SK/amount-calc:15`） | pleading、arbitration-application、labor-arbitration-draft（申请书）、issue-evidence-matrix、procedure-check、preservation（数额默认取合计）、demand-letter（主张金额） |
| 管辖 `forum` | 受诉法院或仲裁机构；管辖依据 | 短文本 + 单选（协议管辖/被告住所地/合同履行地/不动产所在地/仲裁条款/待核） | 可空 | 事项地域（`matter-facts.ts:34`） | pleading、arbitration-application、preservation、enforcement、procedure-check |
| 期限起算 `dates` | 收到副本日 / 送达日 / 生效日 / 履行期限届满日 / 开庭日 | 日期 | 对应文书必填（答辩、上诉、劳动答辩、强制执行） | 事项 `key_dates`（`EX:402` 已在读 `analysis_as_of`）；填了回写事项，下一张卡直接带出 | defense、appeal、labor-arbitration-draft、labor-dispute、enforcement、hearing-outline、cross-exam、procedure-check |
| 对方文书 `opponent_doc` | 必须勾选并标明的那份材料（对方起诉状、一审判决、仲裁申请书、对方证据、执行依据） | 材料勾选 + 用途标“对方” | 必填 | 文件名关键词预选（同 `guessContractType` 的做法，`S:134-140`） | defense、appeal、cross-exam、labor-arbitration-draft（答辩）、enforcement、procedure-check（被诉） |
| 取舍 `choices` | 是否申请保全；拟提程序抗辩；互斥请求取哪项；发函名义 | 单选或多选，均带“先问我” | 可空（缺省“先问我”） | 无 | pleading、arbitration-application、defense、labor-arbitration-draft、demand-letter |
| 当事人 `parties` | 诉讼地位、自然人或机构、名称、住所、信用代码或身份证号、法定代表人 | 事项级表格；面板只读显示完整度并给“补全”入口 | 起诉状、仲裁申请书、强制执行申请书建议补全 | 事项委托人、相对方（`NewMatter.tsx:34`）、当事人词典（`Parties.tsx`） | 所有对外文书 |

### 3.3 “没有材料时直接写案情”的落地方式

建议**把律师写的案情存成本事项的一份材料**（文件名如“律师案情说明（2026-11-22）.txt”，用途标“我方”），再照常勾选。理由：

- `facts.submit` 的 `quote` 与 `document_version_id` 要回链到材料（`platform/packages/kernel/src/tools/registry.ts:796-824`），起诉状方法第 6 步要求“quote 逐字摘自材料”（`SK/pleading-draft:42`）。案情只放在任务说明里，事实就没有出处可挂，事实时间线与论点卡的“所用事实”会断。
- 材料走现成的令牌化（`EX:1161-1166`）与发送摘要（`API:1820`），不用新开一条出站通道。
- 下一张卡（答辩、庭审提纲、代理词）直接能勾到它，不用律师再写一遍。
- 按 `AGENTS.md:7`（区分事实来源），这份材料里的内容应标“律师陈述（可能转述客户）”，不能当成已查明事实；方法里写成待确认事实，由律师在事实页确认。

### 3.4 `scenarios.ts` 的最小改动（类型草案）

```ts
// S:14-28 现有 ScenarioField 上加四个可选属性；kind 加两种
export interface ScenarioField {
  key: string;
  label: string;
  kind: "select" | "text" | "long" | "date" | "multi" | "money" | "claims";
  options?: string[];
  goalText?: Record<string, string>;
  placeholder?: string;
  required?: boolean;
  redirect?: Record<string, { card: string; text: string }>;
  /** 条件必填：no_basis = 勾选材料 0 份且本事项确认事实 0 条；no_materials = 勾选材料 0 份。与 required 二选一。 */
  requiredWhen?: "no_basis" | "no_materials";
  /** 只在条件成立时显示（同上两种）；缺省总显示。 */
  showWhen?: "no_basis" | "no_materials";
  /** 预填来源；面板显示“按事项预填，可改”。 */
  prefill?: "matter.stance" | "matter.region" | "matter.event_date" | "matter.stage" | `matter.key_dates.${string}` | "artifact.amount_calc";
  /** 只拼进任务说明，不作为方法参数（长文本、请求列表：方法参数每项 ≤ 300 字、至多 8 项，S:1176、API:1744-1750）。 */
  goalOnly?: true;
  /** 填完后回写事项（日期类：下一张卡直接带出）。 */
  saveTo?: `key_dates.${string}`;
  /** 显示在“更多（可选）”折叠区。 */
  more?: true;
}

// S:30-73 现有 ScenarioCard 上加一个可选属性
export interface ScenarioCard {
  // …现有字段不变
  /** 必须勾选的那份材料（对方起诉状、一审判决……）；面板据此提示“请勾选并标为对方”。 */
  needs?: { label: string; role: "ours" | "theirs" | "reference"; hint?: RegExp }[];
}

// 共享字段常量（与 CONTRACT_TYPES、LETTER_TYPES 同一写法，S:98、S:112）
const CASE_TEXT: ScenarioField = { key: "case_text", label: "案情经过", kind: "long", requiredWhen: "no_basis", goalOnly: true,
  placeholder: "谁和谁、何时签了什么、我方做了什么、对方怎么违约、欠多少、催过没有" };
const CLAIMS: ScenarioField = { key: "claims", label: "诉讼请求", kind: "claims", prefill: "artifact.amount_calc", goalOnly: true };
const FORUM_BASIS: ScenarioField = { key: "forum_basis", label: "管辖依据", kind: "select", options: ["协议管辖", "被告住所地", "合同履行地", "不动产所在地（专属）", "待核"], more: true };
const PRESERVE: ScenarioField = { key: "preserve", label: "同时申请财产保全", kind: "select", options: ["否", "是", "先问我"], more: true };

// 起诉状卡（S:244-263）改成：
// fields: [CASE_TEXT, CLAIMS, { key: "court", label: "拟受理法院", kind: "text", placeholder: "可空，待确认" }, FORUM_BASIS, PRESERVE]
// goal: "请起草民事起诉状。案情：{case_text}。诉讼请求：{claims}。拟受理法院：{court}（管辖依据：{forum_basis}）。是否同时申请财产保全：{preserve}。"
```

`kind: "claims"` 的值沿用 `string[]`（`values` 类型是 `Record<string, string | string[]>`，`SS:51`），每行“项目｜金额｜口径”，`buildGoal` 按行拼成“1. …；2. …”。这样 `values` 的类型、`skillArgsOf`、`buildGoal` 的签名都不用改；`SS:91` 的必填判断加一段 `requiredWhen` 计算即可（材料数 `docIds.length` 已有，确认事实数在 `SS:100-108` 已经为争点卡查过，去掉 `card.skill !== "issue-evidence-matrix"` 的限制就能复用）。

### 3.5 内核配套（同样最小）

- 快照加 `preflight`：`{ materials: 勾选份数, matter_materials: 事项总份数, confirmed_facts: n, answered: [律师已填的字段键] }`，在 `API:1839` 一并写入。
- `agentGoalPrompt`（`EX:1049-1053`）在【任务】后加一行【开工前已知】：“本次勾选材料 N 份；本事项确认事实 M 条；以下事项律师已在开始时填写：法院、请求、保全……，不再问。”材料为 0 时写“没有材料：案情以任务说明为准，不必先查材料目录”。这一行进令牌化，和任务说明同一路（`EX:1177`）。
- 方法前言加 `kwl.inputs`（键、必备或建议、开始面板收还是中途问），与 `arguments` 并存；用例用它核对卡片（见第五节守护项）。

---

## 四、调用链路问题清单（界面 → 输入 → 内核 → 模型 → 交付）

| # | 环节 | 证据 | 根因 | 对律师的影响 | 建议改法 | 改动范围 | 验证方式 |
|---|---|---|---|---|---|---|---|
| L1 | 界面 → 输入 | `S:256`（起诉状只有 `court`）；`S:5-6`（≤ 3 字段原则）；`SS:363-393` | 字段只按“事项头之外、本方法必需”挑，案情与请求被当成“Agent 会问” | 没材料时无处写案情；写进“补充要求（可选）”也被当成补充 | 按第三节加 `case_text`、`claims` 等共享字段，条件必填 | `S`、`SS` | 前端单测：无材料无确认事实时“开始起草”不可点、提示“先写案情”；有材料时案情可空 |
| L2 | 输入 → 内核 | `SS:89`：“材料还不齐”只在 `minMaterials > docIds.length` 时追加；起诉状、律师函、代理词、法律意见书 `minMaterials: 0`（`S:257,426,578,636`） | 0 份材料被当作“不缺” | 模型不知道这是空事项 | 用 `preflight` 代替这句临时追加的话，任何卡都写明材料与确认事实数 | `SS`、`API:1839` | 内核单测：快照有 `preflight`；提示词含【开工前已知】 |
| L3 | 内核 → 模型 | `EX:1129-1234` 无空事项判断；只有 S2/S6 检查（`EX:773,828`） | Agent 场景完全交给模型自己发现 | 模型先查材料目录、读事实，再回头问，白等几分钟 | `agentGoalPrompt` 加【开工前已知】；材料为 0 时明确“不必先查材料目录” | `EX:1049-1053` | 契约用例（`platform/packages/kernel/test/skills-contract.test.ts`）里断言提示词；真实模型全新发起一单空事项起诉状，看第一次提问出现的时间 |
| L4 | 模型（方法） | `SK/pleading-draft:32`（读完后一次问清 ≤ 3 问）与 `:42`（论点确认再问一次） | 方法把“开工前信息”和“论点确认”分成两次 | 两轮等待；第一轮问的多数界面本可收 | 方法改成“开始时已填的不问；没填又必须的，与论点确认并成一次”；同样改 arbitration、defense、appeal、enforcement、preservation | 6 个 SKILL.md（须重新签名打包，`platform/packages/kernel/src/skills-bundle.ts:85-102` 校验摘要） | 契约用例：开始时已填法院与请求的，脚本模型只出现一次提问（论点确认） |
| L5 | 事项数据 | `NewMatter.tsx:34`；`Parties.tsx:10-19`；`matter-facts.ts:26-36` | 当事人只为代号化服务，没有身份要素 | 起诉状首部全是【待填】，每份对外文书都要手补 | 事项级当事人信息；送出时代号化，导出时还原（`SK/pleading-draft:33` 已承诺“导出时系统自动还原”） | 迁移 + 事项页 + `matter-facts.ts` | 导出还原用例：起诉状首部代号还原为真实名称、住所、信用代码 |
| L6 | 方法内部 | `references/civil-complaint-fields.md` 表格“仅限律师确认的事实”“【待确认】”对 `SK/pleading-draft:29`、`EX:1021` | 参考文件没随第 41 批口径更新 | 模型按参考表做时，正文可能出现【待确认】或漏写材料载明的事实 | 参考表改成与正文一致（材料载明的照写、列核对清单；正文只留【待填】） | 1 个参考文件 | grep 全部 `references/*.md` 中“【待确认】”“仅限律师确认”；产物用 `deliverable-check` 的对外文书规则扫 |
| L7 | 输入 → 方法参数 | `S:1169-1179` 与 `S:1211-1229` 同时输出；长字段在参数里截 300 字（`S:1176`） | 方法参数原为防模型读不到（`API:1737` 注释），任务说明里也保留 | 提示词重复；同一段话一完整一截断 | 长文本与列表标 `goalOnly` 只进任务说明；短字段保留为参数 | `S` | 单测：`skillArgsOf` 不含 `goalOnly` 字段；参数项数 ≤ 8 |
| L8 | 卡片 ↔ 方法契约 | `platform/apps/desktop/test/scenarios.test.ts:60-74` 只核 `args`；字段名与 `arguments` 多处不一致（第二节“参数名”备注） | 没有契约测试 | 方法正文里的 `$focus`、`$side` 等可能永远是空，模型靠猜对应 | 用例核对：每个 `kwl.inputs` 必备项要么有卡片字段、要么写明“中途问”；`gets` 去扩展名后与 `outputs` 一一对上 | 测试 + 若干 `S` 行 | 新用例对当前代码应报出 hearing-outline、closing-checklist、research-deal 三处 `gets` 不一致 |
| L9 | 首页输入 → 面板 | `S:1203-1209`：只有 question/opinion/situation/issue 四种主栏接首页整段话 | 起诉状卡没有主栏 | 首页写的案情落进“补充要求（可选）” | 把 `case_text` 加进 `PRIMARY_FIELDS` | `S:1203` | 单测：从首页带案情打开起诉状卡，案情栏已填、补充要求为空 |
| L10 | 界面引导 | `S:248` 建议先做整理案卷、金额测算；`NEXT_STEPS` 反向有（`S:1104,1129`），起诉状面板上没有 | 只有文字建议 | 律师不知道做过没有、做过的结果用没用上 | 面板显示“本事项已有计算明细（某日）→ 已预填请求”；没有则给“先做金额测算”链接 | `SS` | 走查：有计算明细的事项打开起诉状卡，请求栏有预填 |
| L11 | 交付核对 | 主交付物取卡上 `primary` 或方法 outputs 第一项（`S:62-70`、`EX:1139`） | 正常 | — | 不用改；新增字段不要动 `primary` 逻辑 | — | 现有 `platform/packages/kernel/test/deliverables.test.ts`、`b39-deliverable-check.test.ts` 继续通过 |

---

## 五、与智合 legal-agent-skills 对照

### 值得学的

1. **“委派前先确认”写进方法描述，而不是让执行者中途问。** 智合的专家在独立环境运行、不能提问，所以把必须先确认的项写在 description 里交给前端主会话先问：诉讼文书专家要求“委派前请先与用户确认：文书类型与送达/签收日期、我方诉讼地位、受诉法院或仲裁机构”（`ZH/dist-experts/诉讼文书专家.expert` 内 `EXPERT.md` 前言 description）；编写规范把它列为交付前检查项（`ZH/conventions/expert-template.md:198-199`）。对我们：这三项正是开始面板应当收的，方法里的“一次问清”应当只是兜底。
2. **每个 skill 有“输入要素清单”，分必需 / 强烈建议。** 例：起诉状必需“双方当事人完整信息、请求权基础与诉讼请求、事实经过与对应证据、受诉法院”（`ZH/dist/lit-draft-complaint/SKILL.md:37-46`）；答辩状把“收到起诉状副本的日期”列为必需（`ZH/dist/lit-draft-defense/SKILL.md` 输入要素清单）；合同审查把立场列为“缺了不执行”（`ZH/dist/nonlit-review-contract/SKILL.md` 输入要素清单）。对我们：在方法前言加 `kwl.inputs`，界面字段与测试都从它来（第三节 3.5）。
3. **要素缺失时的四条处置**：标“待确认”不硬填、按最保守假设、输出开头列“本次未确认事项”、影响根本结论的给分支（`ZH/dist-experts/诉讼文书专家.expert` EXPERT.md “信息缺失时的处置规则”；`ZH/dist/nonlit-review-contract/SKILL.md` “要素缺失时”）。我们已有对应规则（`AGENTS.md:17` 第 9 条回报先写完成范围；核对清单列待确认事实），但“立场、阶段这类根本前提缺失时给分支而不是选一个往下走”值得在 `AGENTS.md` 第 6 条补一句。
4. **起草前先过“四项前置”门**：管辖、时效、主体适格、前置程序，“任一不过，写得再好也白写”（`ZH/dist/lit-draft-complaint/SKILL.md:57-64`）。我们把这些放在成文后的《提交前核对清单》（`SK/pleading-draft:70`）。建议把“主体适格、前置程序（劳动争议须先仲裁等）”提到论点确认之前，作为提纲的第一条。
5. **“执行时长可预期，超过十几分钟就拆快速版与深度版”**（`ZH/conventions/expert-template.md:22-26`）。我们的起诉状一单在工作时限 40 分钟内（`EX:2466`）跑完整套（金额、时效、优先受偿权、核对清单），没有“先出首稿”的快速档。可考虑：律师只给案情、不给材料时走快速档，先出首稿与待填清单。

### 我们已经更好、不必改的

- **确定性计算与期限**：金额、受理费、期限一律走计算工具，按工作日规则与多口径并列（`SK/pleading-draft:30,70`；`AGENTS.md` 第 4 条）。智合专家正文里自带一张期限表（`ZH/dist-experts/诉讼文书专家.expert` EXPERT.md “第一件事：算期限”），其中答辩状写“15 日”，没有区分境内无住所的三十日；我们的卡已按住所区分（`S:277-278`）。
- **论点确认门禁**：成文前论点与依据必须经律师确认，文书工具在确认前拒绝生成（`SK/pleading-draft:42,101`）。智合只有“出门前校验”，没有律师确认门。
- **事实来源分级与引文回链**：确认 / 材料载明 / 推论分开，事实带逐字引文（`AGENTS.md:7`；`facts.submit` 的 `quote`）。智合 skill 没有事实存储。
- **代号化与发送摘要**：当事人信息发给模型前换代号（`EX:1161-1177`），导出还原。智合用 `<待补>` 占位，没有隐私层。
- **Word 文书由工具生成并做交付检查**（`EX:1021`；`platform/packages/kernel/src/services/deliverable-check.ts:322`）。

---

## 六、文书质量守护：改的时候要守住什么

| 守护对象 | 现有代码 / 用例 | 新改动可能怎么伤到它 | 要守住的 |
|---|---|---|---|
| 事实一致性 | `facts.list` 只把确认事实写成确定陈述（`platform/packages/kernel/src/tools/registry.ts:830-838`）；成果里的事实标注 `platform/packages/kernel/src/services/artifact-facts.ts:32`；对外文书不出内部事实编号 `deliverable-check.ts:297-298`；用例 `platform/packages/kernel/test/artifact-facts.test.ts`、`b41-fact-refs.test.ts`、`b41-fact-quote-label.test.ts`、`b39-facts-timeline.test.ts` | 律师在面板写的案情只放在任务说明里，模型会把它当“律师确认”的事实直接写进正文，或提交没有出处的事实 | 案情存成材料（第三节 3.3），按“律师陈述”走待确认；`AGENTS.md:7` 的三分法不变 |
| 引用可核验 | 方法要求条文经 `citations.verify` 后才写条号（`SK/pleading-draft:38`）；`platform/packages/kernel/src/services/artifact-citations.ts`；用例 `artifact-citations.test.ts`、`citations-extract.test.ts`、`qa-citations.test.ts` | 新增“管辖依据”选项若写成条号（如“民诉法第 X 条”），模型可能照抄未核验的条号 | 选项只写事实类别（协议管辖、被告住所地……），不写条号；条号仍由方法检索核验 |
| 论点确认门禁 | `platform/packages/kernel/src/services/argument-outlines.ts`；用例 `argument-outlines.test.ts`；契约用例按 `requires_outline` 读文书类方法（`skills-contract.test.ts:28`） | 把“一次问清”并进论点确认时，若改成“开始时已答就跳过确认”，会绕过门禁 | 只合并提问次数，不取消论点确认；`docx.render_report` 在确认前拒绝生成的行为不变 |
| 对外文书正文干净 | `deliverable-check.ts:403`（当事人可见文书禁内部用语）、`:410`（对外文书禁“请律师”“经律师确认”等）、`:322` `checkDeliverable`；用例 `b35-deliverable-check.test.ts`、`b39-deliverable-check.test.ts` | 新的任务说明模板若写“律师确认的请求为……”，模型容易把“律师确认”写进起诉状 | 任务说明用中性写法（“诉讼请求：……”）；新增模板句过一遍 `OUTWARD_INTERNAL_RE` |
| DOCX 保真 | `docx.revise` 系列用例 `docx-revise.test.ts`、`b35-revise-header.test.ts`、`b41-revise-amend.test.ts`、`v10-revise-new-clause.test.ts`；标题编号检查 `deliverable-check.ts:251` | 本审计的改动不碰文书引擎；若顺手改 doc-revise 卡（加“修改范围”），只影响任务说明 | 不改 `docx.revise`、`docx.render_report` 的参数形状 |
| 主交付物核对 | `S:62-70` `primary` / `primaryBy`；`EX:1139`、`EX:1249`；用例 `deliverables.test.ts` | 加字段时误改 `primaryOutputOf`（`S:1192-1196`） | 新字段不参与主交付物推断 |
| 隐私与外发 | 任务说明、方法参数整段令牌化（`EX:1177`）；发送摘要把方法参数一并扫描（`API:1820`） | 当事人身份证号、住所若走新通道（例如单独的 JSON 字段）会绕过令牌化和发送摘要 | 新数据只走三条已有通道：任务说明、方法参数、材料快照 |
| 方法包签名 | `skills-bundle.ts:85-102` 校验每个文件摘要；`content/skills/build-skills.mjs` 打包 | 改 SKILL.md 或参考文件后没重新打包，内核拒绝加载 | 改方法必须重新打包签名，并跑 `skills-contract.test.ts` |
| 回归方法 | — | 用“重新运行”验证修复会带进上一轮成果 | 修复后全新发起，先评几张再铺开（项目既有做法） |

