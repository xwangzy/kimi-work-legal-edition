# 评审 S1 · 法律专业能力、Skills 体系与专家工作流

> 评审日期：2026-10-21 ｜ 对象：`.claude/worktrees/v93-b16/platform/`（分支 v9.4 = main 4a306e3）｜ 方式：只读代码与文档，未跑测试，未接真实模型，未改仓库文件
> 路径写法：代码路径相对 `platform/`；调研材料相对 `research/2026-10-21-智合AI调研/`；“待核”= 法条号或事实本次未逐条核对。
> 不重复 Z1（`research/2026-10-19-商用交付评审v9.3/评审-Z1-…md` §0）已写的结论：模型全是桩、法规库是演示种子、Word 无版式、身份与云端未开通。本文只在需要时引用。

## §0 一页结论

**一句话**：17 个 Skill 作为“方法文书”写得扎实、守法律分寸，是这个产品最像律所内控的部分；但律师拿到的结果取决于三样还没有的东西——**真实模型跑过这些方法、法规库里有条文正文、期限与金额有确定性工具**。入口层面，20 张场景卡有 3 张“名不副实”，3 个 Skill 没有入口，劳动争议和尽职调查两条高频业务实际不支持。

**最重要的发现**

1. **方法写得好，但从没被执行过。** 17 个 SKILL.md 都有：适用范围、前置检查（≤3 问）、步骤、工具约定、输出规格、质量自检、禁止事项、降级。事实三分（材料记载 / 律师确认 / 推论）、依据必经工具核验、金额必由工具算、不预测裁判，都写进了方法（`content/skills/AGENTS.md` 第 1–8 条）。但唯一调用 Skill 的测试只验证“模型能加载 citation-check 正文”，脚本模型随即回一句“已按方法模板完成”（`packages/kernel/test/kap-a1.test.ts:135-170`）；默认 Mock 模型只会调 citations 一个工具（`packages/model-broker/src/providers/mock.ts:102-119`）。**没有任何一个 Skill 的步骤、交付件或自检在任何模型下跑通过。** 判定：执行管线真实，Skill 内容“未执行”。
2. **法律工具几乎没有可用内容。** 法规库 = 律师法（含一个自注“演示演绎、非真实采集”的 2026 修正本）、民法典、劳动合同法 3 部 4 版 + 仲裁法增量，条文正文共 9 条（`content/lawdb/sources/laws.json` `_comment`）。`law.search` 只返回法名和版本，不返回条文（`packages/kernel/src/tools/tools/law.ts:71-81`）；工具面里**没有取条文正文的工具**（`packages/domain/src/legal-tool-names.ts:6-22`）。后果：Skill 要求的“支持度 / 论证支持”核验无从做起，真实运行时绝大多数法律判断会落到“依据待核实 / 法规库未收录”。方法会诚实降级，但律师得到的是满篇待核的结构稿。
3. **引用核验只做到“存在 + 版本”，“支持”一律待判。** `citations.verify` 自注“内容支持一律‘支持待判’，交后续模型与律师”（`tools/tools/citations.ts:1-9`）。签发门禁已接入 A1 成果（`services/artifact-citations.ts`、`api/index.ts:2051`），但法规库外的引用只能由律师勾选“已逐条人工核对”放行——在真实使用中门禁会退化为勾选框。
4. **没有期限工具。** 提醒服务明说“不做按工作日顺延与法定期间计算（期限日由律师填写）”（`services/reminders.ts:15`）。但 `defense-draft` 的自检要求把“答辩期届满日（次日起算、境内无住所三十日）”列入清单（`content/skills/defense-draft/SKILL.md` §6）——等于让模型心算法定期间；而 `demand-letter` 明确禁止自行推算期限。口径不一。
5. **入口与方法错位。** ①“回稿比对”卡走确定性 s1b（`executor.ts:604`：本机完成、不调用模型），卡上写“只对改动部分重新审查”，真正做重审的 `redraft-review` Skill 没有入口；②`contract-redline`（修订说明与谈判要点）、`citation-check`（引用核验）没有卡；③律师说“核对起诉状里的引用”，意图建议会引到“类案与法律研究”卡（`lib/scenarios.ts` research-lit 的 intents 含“核对+引用”），背后是研究备忘录方法，而该方法自己写明“不用于只核对已有文稿的引用”。
6. **三张卡名不副实。** “类案与法律研究”：方法写明“案例库尚未开通”（`legal-research-memo/SKILL.md` §1）；“劳动争议应诉准备”：背后是通用的 `casefile-organize`，没有任何劳动法方法，且 `amount-calc` 明确不算经济补偿、赔偿金、加班费，`defense-draft`、`pleading-draft` 都明确不接劳动仲裁；“履约风险与催告函”承诺“风险提示”，方法只出函件与发送前核对。
7. **事项参数缺关键维度。** 立场选项没有“用人单位 / 劳动者 / 出借人 / 借款人 / 保证人 / 委托方 / 服务方 / 发包人 / 承包人 / 上诉人”（`components/NewMatter.tsx:13`）；事项没有“程序阶段”和“事件时点”，只有“分析截止日”（`executor.ts:332-338`）。Skill 反复要求区分行为时法与现行法，系统却只把分析截止日传给模型和签发门禁。
8. **非诉线最薄。** 5 张卡里 2 张是通用卡（研究、访谈），1 张是确定性脱敏；没有尽职调查、合同起草、修订说明入口。企业法务线没有规章制度审查、劳动用工。
9. **上游 70/34 可借的主要是“方法骨架”，不是数据与脚本。** 值得融合的：论证支持七类失配（`core-claim-evidence-audit`）、劳动争议漏项与时效分类、尽调“先定交易风险再列清单”、管辖与时效分析的输出表。不该引入的：依赖智合库的检索与案例技能、联网查对手主体（与 AGENTS.md 第 8 条冲突）、上游脚本（年数×365 等错误）、违约金“合同总价 30% 上限”示例、听证统一 3 日等（02 文档 §9）。
10. **本轮建议**：先做“名实相符 + 入口接线”（不动内核，约 1 人周），再补 3 个新 Skill（劳动争议、尽职调查、合同起草）和 2 个融合升级（引用核验加论证支持、访谈加紧急期限与冲突待核），内核只加两件小工具：`law.get_article`（取条文）与 `calc.deadline`（期间计算）。详见 §6。

---

## §1 现状清单

### 1.1 执行链路（点一张卡到拿到交付件）

| 段 | 实际实现 | 证据 | 真实性 |
|---|---|---|---|
| 场景卡 | 20 张卡，按业务线分 10 / 5 / 5；17 张走 `a1.agent_task` + `skill`，3 张走确定性流程（s2 整理案卷、s1b 回稿比对、s6 脱敏） | `apps/desktop/src/lib/scenarios.ts` | 界面真实 |
| 任务说明 | 卡片字段按模板拼成一句话 `goal`；字段值不作为 Skill 参数传入（SKILL 里的 `$focus` 等靠模型从文字里读） | `scenarios.ts` `buildGoal()` | 真实 |
| 内核派发 | `runs.start` → `runAgentScenario`：拼【事项口径】立场 / 法域 / 分析截止日 +【方法】“先调用 Skill 工具加载方法模板 X” +【工作方式】+【边界】；材料快照令牌化后写入工作区 | `packages/kernel/src/executor/executor.ts:878-920` | 真实 |
| Skill 分发 | `build-skills.mjs` 校验 name、description ≤250 字、`tools_required` 必须在法律工具白名单内，Ed25519 签名；内核验签后物化为只读可信区，工作区里的技能不加载 | `content/skills/build-skills.mjs:58-62`；`packages/kernel/src/skills-bundle.ts:1-9` | 真实，有测试 |
| Agent 宿主 | kap-host 私有嵌入 Kimi Code 引擎，经 IPC 与内核通信；法律 MCP 工具 14 个 | `executor/kap-agent-client.ts:1-12`；`domain/src/legal-tool-names.ts:6-22` | 真实，有测试 |
| 模型 | 测试与演示全部走 `MockProvider`；默认只在提示含“核验 / 引用 / 法条”时调一次 citations 工具，其余回固定文本 | `model-broker/src/providers/mock.ts:52-119` | **桩** |
| 工具 | riskcards / facts / xlsx / docx 直调有测试（`review-tools.test.ts`、`run-mode-gates.test.ts`）；`calc.interest`（`kernel-probes.test.ts`）；`citations.verify`（`recovery.test.ts` 等）；`law.search`、`law.get_version`、`docx.compare` 在 `kernel/test` 里未见按工具名直调（可能在 lawdb、docx-engine 包内有单测，未查） | grep `packages/kernel/test` | 工具真实；内容见 §4 |
| 复核签发 | 复核页显示该 Skill 的“质量自检”勾选项（“你来核对”）；成果引用核验进签发门禁；签发绑定哈希 | `skills-bundle.ts:143-170`；`api/index.ts:1943`、`api/index.ts:2051` | 真实 |

结论：**“有真实执行管线但模型是桩”**适用于全部 17 张 A1 卡；3 张确定性卡是真实执行（不经模型）。Skill 方法正文本身**只被加载过一次（citation-check），从未被执行**。

### 1.2 Skill 清单（17 个，全部 `tier: beta`）

| # | Skill（版本） | 入口卡 | 输入 | 交付件 | 必需工具 | 方法与质量门槛要点 | 真实执行状态 |
|---|---|---|---|---|---|---|---|
| 1 | contract-review 合同审查（1.1.1） | 非诉“审合同”；企业法务“合同审核” | 合同 DOCX/PDF；立场（事项）；合同类型（5 选 1）；重点 | 风险卡（工作台）；审查意见书（内部稿）.docx；问题清单.xlsx；修订稿由工作台确定性生成 | materials.list / read_excerpt、riskcards.submit、citations.verify | 一致性交叉检查必做；违约金 / 管辖 / 解除三项必查；法定 / 商业 / 表述三分；must / should / negotiable；首选→可退让→底线同向递减；需客户决定；11 项自检；4 类合同有专项要点 | 管线真（卡→w:ins/w:del 修订稿有测试）；方法未执行 |
| 2 | contract-redline 修订说明与谈判要点（1.1.0） | **无卡** | 已处理的风险卡 | 修订说明（致客户 / 致对方）.docx；谈判要点（内部）.docx/.xlsx | riskcards.list、docx.render_report | 只纳入 accepted / modified；modified 用律师文本；致对方版删除底线与评估；不加卡外修改 | **无入口**，只能靠自由描述让模型自选 |
| 3 | redraft-review 回稿比对与重审（1.0.1） | **无卡**（“回稿比对”卡走 s1b，不调用本 Skill） | 基线稿 + 回稿两份 DOCX | 变更清单.xlsx（含静默改动、采纳跟踪）；重审风险卡；回稿意见 | docx.compare、riskcards.submit、xlsx.render_table | 静默改动必列；定义变化扩散；互引失效；我方修改采纳跟踪；段落级局限必须告知 | **未接入** |
| 4 | legal-research-memo 法律研究备忘录（1.1.0） | 诉讼“类案与法律研究”；非诉“交易法规研究” | 研究问题；事件时点 | 研究备忘录.docx；来源目录.xlsx（>10 条才出） | law.search、law.get_version、citations.verify | 子问题拆解；行为时法 / 现行法分列；命题逐条对照；相反依据必检；四态核验；“限定资料研究” | 方法可走通，但法规库 4 部法、无条文检索 → 实际产出几乎全是“未收录” |
| 5 | citation-check 引用核验（1.1.0） | **无卡**（意图词被研究卡截走） | 文稿；事件时点 | 引用核验表.xlsx | citations.verify、law.get_version | 全量抽取含“不具体引用”；真实性 / 支持度 / 适用性；改引建议待确认 | 唯一被测试加载过的 Skill；支持度无法执行（无条文工具） |
| 6 | client-advice 顾问答复（1.1.0） | 企业法务“合规问答 / 顾问答复” | 问题；业务背景 | 顾问答复.docx | law.search、law.get_version、citations.verify | 一句话结论在前；假设逐条；相反依据；可操作下一步 | 同 #4 |
| 7 | intake-notes 访谈纪要（1.1.0） | 非诉“访谈纪要与材料清单” | 访谈记录 | 访谈纪要.docx；材料收集清单.xlsx | materials.list、read_excerpt | 事实一律标“客户陈述”；按案件类型套清单（references 9 类，其中 7 类是争议类） | 方法未执行；放在非诉线但内容以争议为主 |
| 8 | casefile-organize 案卷整理（1.0.1） | 企业法务“劳动争议应诉准备”（唯一入口） | 一批材料 | 事实行（时间线）；案卷总目录 / 事实时间线 / 缺口清单.xlsx | materials.list / read_excerpt、facts.submit、xlsx.render_table | 一事一行、逐字引文；claimed / inferred / to_confirm；矛盾成对提交；增量不重复 | 方法未执行；诉讼“整理案卷”卡用的是正则版 s2 |
| 9 | issue-evidence-matrix 争点—证据矩阵（1.0.1） | 诉讼“争点与证据分析” | 律师已确认的事实；请求；地位 | 争点—证据矩阵.xlsx（5 个工作表） | facts.list、materials.list、xlsx.render_table | 只用 confirmed 事实；请求权基础→要件→证据；三级覆盖；常见抗辩；补证动作带责任人 | 方法未执行 |
| 10 | case-analysis 案情分析（1.1.0） | 诉讼“案情分析与诉讼策略” | 案卷或整理成果；目标；地位 | 案情分析备忘录（内部稿）.docx；争点与风险表.xlsx | facts.list、materials.*、docx.render_report | 争点分事实 / 法律；证据强弱与矩阵同一分级；风险定性不给概率；下一步带责任人与期限；律师确认事实为零时不评强弱 | 方法未执行 |
| 11 | amount-calc 金额测算（1.1.0） | 诉讼“金额测算” | 本金、付款、计息口径 | 计算明细.xlsx（4 个工作表） | calc.interest、materials.read_excerpt | 分段；每段取工具结果；抵扣顺序须律师确认；互斥项不入合计；明确不覆盖劳动补偿、复利、LPR 倍数、加倍迟延利息 | 工具真（固定利率、LPR 加点）；方法未执行 |
| 12 | pleading-draft 民事起诉状（1.0.1） | 诉讼“起草起诉状” | 确认事实；金额；法院 | 起诉状（草稿）.docx；证据目录.xlsx；提交前核对清单.xlsx | facts.list、materials.list、docx / xlsx | 请求结构；互斥只取律师选定项；律师费仅限约定；每句事实带证据编号；不接仲裁、上诉、劳动仲裁 | 方法未执行 |
| 13 | defense-draft 民事答辩状（1.0.1） | 诉讼“起草答辩状” | 起诉状；确认事实；收状日 | 答辩状（草稿）.docx；对照表；核对清单 | facts.list、materials.*、docx / xlsx | 逐项对应诉请；管辖异议先提示；时效抗辩须有事实；不接二审、仲裁、劳动 | 方法未执行；自检要求列答辩期届满日（无期限工具） |
| 14 | cross-exam-opinion 质证意见（1.0.1） | 诉讼“质证意见” | 对方证据目录与证据 | 质证意见（草稿）.docx；质证意见表.xlsx | materials.*、facts.list、docx / xlsx | 逐份三性 + 证明目的；不得无据否认；鉴定、原件核对、反证进“待办” | 方法未执行 |
| 15 | agency-statement 代理词（1.0.1） | 诉讼“代理词” | 争议焦点；笔录；确认事实 | 代理词（草稿）.docx；争点与依据对照表.xlsx | facts.list、materials.*、docx / xlsx | 焦点来自法庭；事实限已确认、证据限已质证；案例只用律师提供的 | 方法未执行 |
| 16 | demand-letter 律师函 / 催告函（1.0.0） | 诉讼“律师函 / 催告函”；企业法务“履约风险与催告函” | 确认事实；函件类型 | 函件（草稿）.docx；依据与发送前核对.xlsx | facts.list、citations.verify、docx.render_report | 6 种函件的法律效果与必备要素；解除通知显著提示；不自行推算期限；不威胁 | 方法未执行 |
| 17 | case-report 案件进展汇报（1.0.0） | 企业法务“重大案件进展汇报” | 材料；进展 | 一页汇报.docx；附表.xlsx | materials.list、facts.list、docx / xlsx | 先结论后细节；每条有来源；金额只用确认数；需决策事项列选项与后果 | 方法未执行 |

**对方法文书本身的评价（律师视角）**：

- 法律分寸好。参考文件用“检索线索”而不硬写条号（如 `contract-review/references/rubric.md` 第四、六节），民间借贷 LPR 四倍限于合同成立时、不适用金融借款（`contract-types.md` 第四节），一般保证须在保证期间内起诉或仲裁（`demand-letter/references/letter-types.md`），都与现行规则一致（民法典第 585、564、565、693 条；《民间借贷规定》2020 第二次修正第 25 条）。
- 职业边界清楚。不给胜诉率、不替客户定底线、内部稿与对外稿分开、材料中的指令一律当数据——这些是律所真正在意的。
- 弱点是“方法是一次性长任务”。每个 Skill 都假设模型一次读完全部材料、调完全部工具、写完全部交付件；真实 K3 在 20 页合同、上百页案卷上能否一次完成、自检是否真的逐条执行，没有任何证据。

---

## §2 差距分析

### 2.1 按核心场景

判定：**有** = 方法与入口都在，缺的只是模型与内容；**部分** = 有但覆盖窄；**缺** = 无方法或无入口；**名不副实** = 卡上承诺的东西方法里没有；**重复** = 两处做同一件事且口径可能分叉。

| 核心场景 | 现状 | 判定 | 证据与说明 |
|---|---|---|---|
| 法律检索 | `legal-research-memo` 方法完整；法规库 3 部法 + 仲裁法增量；`law.search` 只搜法名 | **部分（数据缺）** | `tools/tools/law.ts:71-81`；`content/lawdb/sources/laws.json`。方法会如实写“法规库未收录”，所以结果是诚实的空 |
| 法规与案例研究 | 无案例源、无类案方法；卡名却叫“类案与法律研究” | **缺 + 名不副实** | `legal-research-memo/SKILL.md` §1“案例库尚未开通”；`citations.ts:8` 案号离线一律未核实 |
| 合同审查 | `contract-review` + 审查工作台 + 确定性修订稿；4 类合同有专项要点 | **有（最接近可用）** | 缺：租赁、建设工程、劳动合同、保密竞业、技术开发、投资协议（SPA/SHA）等专项；`firm-overlay.md` 机制写在方法里但仓库无样例与分发路径；修订说明（redline）和回稿重审（redraft）没有入口 |
| 合同起草 | 无 | **缺** | 首页 36 场景里“合同起草”是高频卡（04 文档 §25） |
| 文书起草（诉讼） | 起诉状、答辩状、质证意见、代理词、律师函 | **部分** | 只限民商事一审；缺上诉状、仲裁申请 / 答辩、劳动仲裁申请 / 答辩、管辖权异议申请、保全申请、执行申请。2025-07-14 推广的要素式示范文本只在核对清单里提示（`pleading-draft/SKILL.md` §1） |
| 案件分析 | `case-analysis` + `issue-evidence-matrix` | **有，轻度重复** | 两者都做“证据强弱”，已用同一分级（好）；但 case-analysis 也会拆争点，律师可能先点哪张都行——需要在卡上写清“矩阵是底稿、分析是结论稿” |
| 证据整理 | 诉讼“整理案卷”走正则 s2；AI 版 `casefile-organize` 只挂在企业法务的劳动卡上 | **重复 + 错位** | `executor/casefile.ts`（日期金额正则）；`scenarios.ts` labor-response。正则版诚实写“不调用 AI”，但律师期望的“读懂材料、提事实”在诉讼线上没有入口 |
| 尽职调查 | 无方法；“尽调 清单”意图词引到访谈纪要卡 | **缺 + 名不副实** | `scenarios.ts` intake.intents 含 `["尽调","清单"]` |
| 劳动争议 | 卡 → 通用案卷整理；金额、答辩、仲裁申请都明确不支持；立场无用人单位 / 劳动者 | **名不副实（实际不支持）** | `amount-calc/SKILL.md` §1“不覆盖劳动经济补偿、赔偿金、加班费”；`defense-draft/SKILL.md` §1、`pleading-draft/SKILL.md` §1 不接劳动仲裁；`NewMatter.tsx:13` |
| 期限计算 | 无工具；提醒只存律师填的日期 | **缺** | `services/reminders.ts:15`；而 `defense-draft` 自检要模型写答辩期届满日 |
| 金额计算 | 固定利率、LPR 加点、分段、抵扣 | **部分** | `tools/tools/calc.ts`。不支持 LPR 倍数、复利、劳动补偿、诉讼费、迟延履行加倍利息；LPR 种子止于 2025-05-20（3.00%），之后报价待核 |

### 2.2 按业务线

| 业务线 | 卡数 | 有 | 缺 | 名不副实 / 重复 |
|---|---|---|---|---|
| 诉讼仲裁 | 10 | 整理案卷（正则）、争点证据、案情分析、金额、起诉状、答辩状、质证、代理词、研究、律师函——一审民商事链条基本齐 | 接案访谈（在非诉线）；管辖与时效核查；上诉；仲裁（2025 修订仲裁法 2026-03-01 施行，需按适用时点区分）；保全；执行；庭审提纲 | “类案与法律研究”无案例；“整理案卷”不用 AI 版 Skill |
| 非诉 | 5 | 审合同、回稿比对（仅比对）、脱敏 | 尽职调查；合同起草；修订说明与谈判要点；公司决议与治理文件；交易文件 | “回稿比对”承诺重审但不重审；“访谈纪要”内容以争议为主；“交易法规研究”与诉讼研究卡同一方法 |
| 企业法务 | 5 | 合同审核、顾问答复、催告函、案件汇报 | 规章制度审查；劳动用工（解除前评估、劳动仲裁应诉）；合同台账与履约提醒；应诉应急（收到起诉 / 仲裁后的第一步） | “劳动争议应诉准备”无劳动方法；“合同审核”写“结合公司常见管理要求”但没有公司规则来源；“履约风险”不出风险提示 |

### 2.3 重复与口径分叉

- **同一 Skill 多张卡**：contract-review ×2、legal-research-memo ×2、demand-letter ×2。这本身合理（同方法、不同业务语言），但卡片的 `goal` 模板各写各的，企业法务版额外承诺“公司常见管理要求”。建议由 Skill 声明可接受的参数（立场视角、覆盖层），卡只传参数，不在 goal 里加方法没有的承诺。
- **期限口径分叉**：`demand-letter` 禁止推算期限；`defense-draft` 要求列届满日；`case-analysis` 把“时效与期限”列为风险项但不计算。应统一为“模型只写起算事实与期间规则，日期由工具算或标待律师计算”。
- **证据整理两套**：s2 正则（诉讼）与 casefile-organize（AI）产出的事实行口径不同（正则只抽日期金额主体），后续 `issue-evidence-matrix` 只认律师确认的事实，问题不大；但律师看到两张都叫“整理”的卡会困惑。

### 2.4 律师视角的其他问题（题目未问到）

1. **演示法规库里有一部虚构的法律版本。** `laws.json` 自注《律师法》2026 修正本“按平移演绎——非真实采集”，且标为现行有效（`effective: 2026-09-01`，`effectiveness: valid`）。任何引用律师法的成果在演示环境会被“核验”为 2026 修正本第 41 条之类不存在的条文。对律师这是硬伤：**演示种子必须在律师可见的安装包里禁用或整库标“演示数据，不得引用”**（Z1 已提法规库是演示，但没点出这一条是虚构版本）。
2. **模型在算日期。** 见 §0 第 4 条。法定期间算错是律师执业事故的第一来源，答辩期、举证期、上诉期、仲裁时效都不能交给语言模型。依据：民法典第 200—204 条（期间计算、开始当日不计入、月末对应日、末日节假日顺延）；民事诉讼法期间条文（2021 修正本第 85 条，2023 修正本条号待核）；行政处罚法第 64、85 条（听证五个工作日）。
3. **签发门禁按“分析截止日”核，不按“行为时”核。** 内核只传 `analysis_as_of`（`executor.ts:332-338`），Skill 自己要求模型再按事件时点核一次，但系统层没有事件时点字段。公司法（2023 修订，2024-07-01 施行）、仲裁法（2025 修订，2026-03-01 施行）这类新旧交替的领域，按截止日核验会把行为时的旧法判成“已修改”或把新法判成“适用”。
4. **合同类型选择逼律师选“其他（通用辅助）”。** 企业法务最常见的采购、租赁、保密、劳动合同、技术开发都不在 4 类里（`scenarios.ts` `CONTRACT_TYPES`）。“其他”只按通用必查点审，结果会明显浅。
5. **劳动争议是企业法务第一高频事项，却是最弱的一块。** 立场、方法、计算、文书四层都缺。
6. **“修订说明 / 谈判要点”是合同审查的最后一公里**，律师审完合同要给客户发说明、给对方发修订说明。方法已经写好（`contract-redline`），只差一个入口。
7. **卡片字段不传给 Skill 参数。** SKILL 声明了 `arguments: [focus]`、`[audience]`、`[letter_type]` 等，并在步骤里用 `$focus`；内核只发一句“先调用 Skill 工具加载方法模板 X”（`executor.ts:885`），参数藏在 goal 文字里。真实模型下可能读不到，需要在 methodLine 里显式带参数。
8. **利益冲突无入口。** 律师法第 39 条要求的冲突审查是接案第一步；访谈方法里没有“列出全部主体供本所冲突系统检索”这一步（不要求系统下结论，只要求不漏列主体）。

---

## §3 上游映射与融合建议

**总原则**

1. 上游是 MIT（Copyright (c) 2026 John He (Decikingship)，锁定 commit 83df6b13）。融合的是**方法骨架**（任务拆解、步骤、自检清单、输出表结构），改写成我们的工具名与边界；在 SKILL.md frontmatter 的 `source_lineage` 写 `upstream:legal-agent-skills@83df6b13:<技术标识>`，并在 `content/skills/` 根放一份上游 LICENSE 副本。
2. **不引入上游脚本。** 原因：脚本有已知法律错误（年数×365、听证 3 日），且在我们的执行域里跑第三方 Python 要另做供应链审查。需要确定性的部分（期间、金额）做成内核工具。
3. **不引入依赖智合库或外部主体查询的技能。** 我们没有这些数据源；联网带当事人名检索与 AGENTS.md 第 8 条冲突。
4. **不照搬上游缺项默认值**（“期限取最短、立场取最不利、金额取最低”，06 文档 §2 第 2 条）。我们的方法已用“一次问清 ≤3 问 + 待核”处理，更好。
5. **02 文档 §9 的错误一律不带入**：听证统一 3 日；违约金“合同总价 30% 上限”（合同编通则解释第 65 条比较的是造成的损失）；年数×365；缺年份仍出精确期限；“同当事人改判即一审整体不可引”；“申请执行过两年即不能申请”（民诉法解释第 481 条区分受理与时效抗辩）；行政起诉期限沿旧规则（法释〔2026〕3 号 2026-05-01 施行）；仲裁沿旧模板。

### 3.1 70 项技能逐项去向（表内 47 项；其余 23 项见表尾）

| 上游技能 | 去向 | 动作 | 取什么 | 不取 / 纠正 |
|---|---|---|---|---|
| core-claim-evidence-audit 论证依据审查 | citation-check → v1.2 | **融合（本轮）** | 七类失配：裸断言、空泛援引、射程不足、条件遗漏、方向相反、以偏概全、绝对化；“依据支持到哪一步 / 结论走到哪一步 / 缺了什么”三段式；“先核存在、再核支持”的顺序 | 不取 `audit_claims.py`；射程比对需要条文正文 → 依赖新工具 `law.get_article` |
| core-verify-statute-validity 法条引用核验 | citation-check | 融合（已基本具备） | 修订 / 废止 / 改号的检查顺序 | 不取智合 lawId 来源规则 |
| core-audit-case-citation 案例援引审查 | 暂缓 | 暂缓 | 案号格式、案件链（原审—二审—再审）核对思路 | 不取“同当事人改判即整体不可引”；无案例源前不做 |
| util-legal-calculator 法律计算器 | amount-calc + 新内核工具 | 部分融合 | severance（经济补偿）等子类型清单，作为 `calc.labor` 的需求 | 不取脚本；期间算法错误 |
| zhihe-law-search / zhihe-case-search | 不引入 | 不引入 | 只借“检索记录”结构（检索式、时间、范围、命中数、未检出）放进研究备忘录 | 依赖智合 API；修法时间筛选与标题排除规则有错（05 文档 C 节） |
| lit-analyze-claim-basis 请求权基础 | issue-evidence-matrix | 融合 | 主位 / 备位请求、请求权竞合的选择记录 | 不预设“禁止并列” |
| lit-assess-case-risk 争议焦点与胜败评估 | case-analysis | 部分融合 | 争点归纳、不利事实清单 | **不取胜败评估**（AGENTS.md 第 7 条） |
| lit-analyze-jurisdiction 管辖权分析 | 新 procedure-check | **新增（本轮）** | 管辖连接点表（合同约定 / 被告住所 / 合同履行地 / 专属与级别）、协议管辖有效性检查 | 不取脚本 |
| lit-analyze-limitation 诉讼时效分析 | 新 procedure-check | **新增（本轮）** | “三个最易错”：起算、中断证据、二十年最长期间；“判为已过时效先别放弃”（检查中断、对方是否已援引） | 纠正年数×365：按民法典第 200—204 条公历对应日；日期由 `calc.deadline` 算 |
| lit-build-evidence-list 证据清单与举证责任 | pleading-draft、casefile-organize | 融合 | “证据—证明对象—原件状态—举证责任”列 | — |
| lit-build-timeline 案件事实时间轴 | casefile-organize | 融合 | 事件发生日与材料形成日分列 | — |
| lit-cross-examination 质证意见 | cross-exam-opinion | 融合 | 证明力大小与反证建议一列 | 不取“一概不认可”的写法 |
| lit-draft-complaint 起诉状与仲裁申请 | pleading-draft；仲裁另立 | 部分融合；仲裁暂缓 | 诉请—事实—证据闭合核对表 | 仲裁按 2025 修订仲裁法与机构规则重写，不沿旧模板 |
| lit-draft-defense 答辩状与反诉 | defense-draft | 融合 | 反诉条件提示 | — |
| lit-draft-appeal 上诉与再审申请 | 新 appeal-draft | 下一轮 | 一审裁判逐项错误定位（事实 / 法律 / 程序）表 | 上诉期由工具算（判决 15 日、裁定 10 日；民诉法 2021 修正本第 171 条，2023 修正本条号待核） |
| lit-draft-argument 代理词 | agency-statement | 已具备 | — | — |
| lit-prepare-hearing 庭审提纲 | 新 hearing-outline | 下一轮 | 发问提纲、法官可能追问、对方最强论证 | 不设计诱导证言 |
| lit-labor-dispute 劳动争议处理 | 新 labor-dispute | **新增（本轮）** | 十类请求漏项清单；时效分类（劳动争议调解仲裁法第 27 条，劳动报酬特殊规则）；举证责任（劳动争议解释（一）第 44 条；加班费第 42 条；调解仲裁法第 6 条）；仲裁前置；终局裁决不对称（第 47—49 条）；2N 与 N 不并列（劳动合同法实施条例第 25 条）；补偿基数三倍封顶、十二年（劳动合同法第 47 条）；社保补缴不属受案范围的提示 | 不取脚本；地方口径无数据 → 列“待核地方口径”清单 |
| lit-case-intake 接案研判 | intake-notes → v1.2 | **融合（本轮）** | 紧急期限识别、利益冲突待核主体清单（律师法第 39 条） | 不自动判“无冲突” |
| lit-plan-enforcement 执行方案 | 新 enforcement | 下一轮 | 财产线索表、执行措施路径 | 纠正“过两年即不能申请”：区分受理与时效抗辩（民诉法解释第 481 条） |
| lit-search-similar-cases / lit-extract-judicial-rules / lit-analyze-judgment-divergence / lit-counter-adverse-precedent | 案例研究包 | 暂缓（等案例源） | 类案“相似点 / 差异点 / 引用目的 / 案例身份（指导性 / 参考 / 普通）”结构 | 不取“统计支持率”；样本边界必须写明 |
| lit-shareholder-dispute / lit-bankruptcy / lit-administrative-remedy / lit-criminal-defense / lit-criminal-sentencing-calibration | 专业包 | 暂缓 | — | 行政需按法释〔2026〕3 号重写；刑事需专门权利与阶段模型 |
| lit-opponent-background 对手背景调查 | 不引入 | 不引入 | — | 依赖工商连接器、联网带主体名检索 |
| lit-case-closing 结案交付 | 下一轮 | 暂缓 | 结案清单与回访 | — |
| nonlit-review-contract / nonlit-clause-benchmark | contract-review | 融合 | 合同家族优先关系（主合同 / 补充协议 / 附件冲突）；“对我方有利但效力可疑的条款也报告” | 不取 `output-formats.md` 里违约金 30% 示例 |
| nonlit-due-diligence 尽职调查清单 | 新 due-diligence（阶段一） | **新增（本轮）** | 红旗问题前置；核查事项落到具体文件；资料清单可直接发对方；访谈提纲只问书面查不到的 | 外部检索改为“律师在外部系统查询后导入”，不由 Agent 带主体名联网 |
| nonlit-dd-opinion 尽调发现与法律意见 | 新 due-diligence（阶段二） | **新增（本轮）** | 每个问题四要素（事实 / 法律后果 / 量化影响 / 解决方案）；解决方案落到交易文件条款（先决条件、陈述保证、特别赔偿、价款调整）；“核查受限事项”单独披露 | 不出可签发的“法律意见书”，只出内部稿 |
| nonlit-transaction-documents 交易文件与条款 | 新 contract-draft | **新增（本轮）** | 条款要点—谈判弹性标注 | — |
| nonlit-corporate-governance 公司治理 | 新 corporate-docs | 下一轮 | 决议类型、表决比例核对 | 新公司法时间效力另核 |
| nonlit-labor-compliance 劳动人事合规 | 新 policy-review / labor-dispute | 下一轮（规章制度） | 劳动合同法第 4 条民主程序与公示检查 | — |
| nonlit-litigation-response 应诉应急 | 企业法务“收到诉状 / 仲裁”卡 | 融合进卡（不新建 Skill） | 第一小时清单：期限、管辖、保全风险、内部通报 | — |
| util-contract-diff / util-case-file-index / util-anonymize | 已有 docx.compare、casefile、s6 | 已具备 | — | — |
| util-docx-format 法律文书排版 | `services/doc-style.ts` | 融合（规则） | 文书版式规范（字号、页码、落款） | Z1 已指出 Word 无版式 |
| util-plain-language / util-research-memo | client-advice、case-report、legal-research-memo | 融合 | 通俗化检查表；检索报告结构 | — |
| nonlit-regulatory-inspection | 不引入 | 不引入 | — | 听证统一 3 日错误（行政处罚法第 64、85 条：五个工作日） |

**表外 23 项**（不引入或远期）：来华系列 8 项（orchestrate-china-business、plan-china-entity / employment / ip / tax-customs-fx、assess-china-data、assess-china-investment-access、draft-china-contracts）；专项包 6 项（ipo-review、regulatory-penalty-scan、admin-penalty-benchmark、new-rule-tracking、compliance-obligation-matrix、data-compliance，等法规库与数据源）；new-business-review（远期并入企业法务顾问答复）；lit-analyze-law-conflict（远期并入研究备忘录“新旧法、上下位法冲突”一步）；律所经营与通用类 7 项（engagement-proposal、bid-proposal、legal-training、enterprise-service-season、run-ciie-legal-demo、diagram、legal-translation）。

### 3.2 34 个专家工作流的映射

我们的“场景卡 + NEXT_STEPS 接着做”就是轻量的专家工作流。不建议引入“专家”人格层；建议把专家的**阶段顺序和交接物**写进卡片链与 Skill 的“前置 / 后续”里。

| 上游专家 | 对应我们的链 | 处理 |
|---|---|---|
| expert-contract-review | 审合同 → 工作台决定 → 修订稿 → 修订说明 → 回稿重审 | 补齐 redline、redraft 两个入口即闭环 |
| expert-contract-case 合同纠纷 | 整理案卷 → 争点证据 → 管辖与时效 → 金额 → 起诉状 | 新增管辖与时效一环 |
| expert-evidence / expert-litigation-drafting / expert-litigation-strategy | casefile → issues → case-analysis → pleading / defense / cross-exam / agency | 已有，按 §5 重排 |
| expert-pretrial 庭前备战 | 质证 → 庭审提纲（新）→ 代理词 | 下一轮 |
| expert-labor / labor-employee / labor-employer | 一个 labor-dispute + 立场参数 | 06 文档的建议（共同底座 + 立场参数）正确，采纳 |
| expert-dd-transaction | 尽调清单 → 访谈 → 尽调发现 → 交易文件条款 | 新增 |
| expert-citation-audit / expert-doc-engineering | 文稿体检（引用 + 论证） | 融合进 citation-check |
| expert-intake / expert-client-communication | 接案访谈；顾问答复；案件汇报 | 已有，补冲突与期限 |
| expert-inhouse 企业常法 | 企业法务线 | 补制度、劳动、应诉应急 |
| 其余（行政、破产、刑事、IPO、数据、监管、来华、执行、股东、类案、培训、方案、对手） | — | 暂缓或不引入，理由同 3.1 |

---

## §4 法律专业质量机制：做到哪一步

| 机制 | 现有实现（代码证据） | 做到哪一步 | 差什么 | 建议 |
|---|---|---|---|---|
| **引用存在性** | 引用抽取（书名号、简称、款项、“该法”回指）；法名归一、条号存在、条号迁移（`tools/tools/citations.ts:18-60`）；A1 成果签发前离线复核，定性错误不得签发（`services/artifact-citations.ts:1-13`；`api/index.ts:2051`） | 机制完整，测试扎实 | 法规库只有 3 部法；库外引用全部 `outside_registry` → 律师勾选人工核对 | 法规库首批按 Skill 依据反推收录（见 §6 第 15 项）；签发页显示“库外引用 N 条”而非仅勾选 |
| **规则适用性（时点）** | `law.get_version(as_of)` 取适用版本；Skill 要求事件时点与分析截止日各核一次 | 工具支持任意时点 | 事项只有 `analysis_as_of`（`executor.ts:332-338`）；签发门禁按事项时点核（`api/index.ts:346` 附近，asOf 来源未逐行核对）；无“行为时”字段；无过渡规则数据 | 事项加“事件时点”；成果内引用按 Skill 记录的时点核；过渡规则先做成“需人工判断”标记 |
| **论证支持** | 明确不做：“内容支持一律‘支持待判’”（`citations.ts:6`）；无取条文工具 | **未实现** | 模型拿不到条文原文，只能凭记忆（被禁止）或联网抓取（闸门配置未验证） | 新增 `law.get_article`；citation-check 加七类失配；签发页把“支持待判 N 条”列为律师必看项 |
| **事实与推论分层** | `facts.submit` 只收 claimed / inferred / to_confirm，确认只能由律师在界面做（`tools/registry.ts:386`）；起诉、答辩、代理、矩阵只用 confirmed | **做得好** | 成果正文里的事实句不机读回链事实编号；“律师告知”的事实没有专门入库路径 | Skill 输出规格要求每段事实后写“（事实 F-12，证据 3）”；签发页抽查无编号的事实句 |
| **日期精度** | 事实日期接受 `YYYY` / `YYYY-MM` / `YYYY-MM-DD`（`services/review-cards.ts:642`），月精度不被补成 1 日 | 部分 | 无“约 / 早于 / 区间”；不分事件日与材料形成日；无期间计算 | 加 `occurred_on_note`（约、早于、区间）；`calc.deadline` 遇到非日精度只给区间 |
| **金额可复算** | `calc.interest` 分段、算头不算尾、360/365、LPR 种子、四舍五入到分（`tools/tools/calc.ts:28-120`）；amount-calc 要求每段取工具值、写公式 | 计息部分做到 | 只支持固定利率与 LPR 加点；LPR 种子止于 2025-05-20；无劳动补偿、诉讼费、迟延履行加倍；起诉状金额与计算明细无机器比对 | 加 LPR 倍数与种子更新；`calc.labor`、`calc.court_fee` 下一轮；起诉状核对清单加“诉请金额 = 计算明细合计”自动比对 |
| **缺口与待核** | 各 Skill 要求列出【待填】【待确认】、覆盖说明、未读页；案卷缺口清单；成果有 `open_items` 字段（`tools/tools/review.ts:178`） | 部分（文本层） | 待核项散在正文；无统一“待核清单”对象可在签发前逐条清零 | 统一由 Skill 在回报中输出机读待核列表，写进 `open_items`；签发页逐条确认或保留 |
| **人工复核与签发** | 复核页显示 Skill 质量自检勾选项（`skills-bundle.ts:143-170`；`api/index.ts:1943`）；完整性检查；签发绑定哈希；引用门禁 | **做得好** | 自检是模型的自检清单转给律师看，律师是否逐条勾选、勾了什么，未见留痕（未验证）；没有“已复核 / 已签发 / 已发送”三态之外的“已提交法院 / 已送达”记录 | 律师勾选项写入签发记录；外部动作状态另开（02 文档 §7 的状态链） |

**小结**：存在性、事实分层、人工签发三项做得比多数同类产品扎实；**论证支持与期限计算是两块空白**，且恰好是律师最怕出错的地方。适用性做到“工具能查”，但事项层没有行为时字段。

---

## §5 建议的场景卡与 Skill 体系

### 5.1 设计规则

1. **卡 = 律师的一个业务目标**，用律师自己的话命名（动词 + 对象），不出现 Skill、Agent、工具名。卡面三行：你给什么 / 你得到什么 / 需要你定的（≤3 项）。
2. **事项级口径一次填、所有卡共用**：我方立场（扩展列表）、程序阶段、地域（省市，用于提示地方口径）、事件时点、分析截止日（默认今天）。卡上不再重复问。
3. **卡只传参数，不加承诺**。卡的 `goal` 模板只能写 Skill 声明支持的内容；Skill 没有的能力，卡上不能写。
4. **没有方法的业务不挂到相近的方法上**。宁可灰显“即将推出”，也不把劳动仲裁挂到通用案卷整理上。
5. **三线 + 一条通用条**：通用条放三线都要用、且不依赖立场的四件事（研究、文稿体检、函件、对外脱敏），避免同一方法在三条线各复制一张卡。

### 5.2 诉讼仲裁（10 张 + 即将推出 5 项）

| # | 卡名 | 背后 Skill | 你给什么 | 你得到什么 | 卡上参数 | 本轮动作 |
|---|---|---|---|---|---|---|
| 1 | 新案受理与访谈 | intake-notes v1.2 | 访谈记录、客户初步材料 | 访谈纪要；材料收集清单；**紧急期限与冲突待核清单** | 案件类型；我方拟定地位 | 新卡（Skill 已有，补两步） |
| 2 | 整理案卷 | s2（快速，本机）→ casefile-organize（精读，可选） | 起诉材料、证据、往来函件 | 证据目录；事实时间线（待你确认）；缺口清单 | 已知争点；整理深度（快速 / 精读） | 改接线 |
| 3 | 争点与证据分析 | issue-evidence-matrix | 你确认过的事实 | 争点—证据矩阵；补证清单 | 请求；我方地位 | 保留 |
| 4 | 案情分析与诉讼策略 | case-analysis | 案卷或整理成果 | 案情分析备忘录（内部稿） | 目标；我方地位 | 保留 |
| 5 | 管辖与时效核查 | **procedure-check（新）** | 争议解决条款、催告 / 对账 / 确认函等关键日期材料 | 管辖分析表；时效与期限表（起算不明时给分支） | 拟主张的请求；我方地位 | 新增 |
| 6 | 金额测算 | amount-calc | 合同、付款记录 | 计算明细（分段、公式、口径） | 项目；截止日；利率口径 | 保留，加 LPR 倍数 |
| 7 | 起草起诉状 | pleading-draft | 确认事实、计算明细 | 起诉状（草稿）；证据目录；提交前核对清单 | 受诉法院；文本形式（传统 / 对照要素式） | 保留 |
| 8 | 起草答辩状 | defense-draft | 起诉状副本、确认事实 | 答辩状（草稿）；答辩要点对照表；核对清单（答辩期由工具算） | 收状日期；境内有无住所；总体意见 | 保留，改期限口径 |
| 9 | 质证意见 | cross-exam-opinion | 对方证据目录与证据 | 质证意见（草稿）；质证意见表（含待办） | 我方地位；举证期限；开庭日 | 保留 |
| 10 | 代理词（庭后） | agency-statement | 笔录或庭审要点、法庭归纳的焦点 | 代理词（草稿）；争点与依据对照表 | 争议焦点 | 保留 |
| — | 即将推出 | appeal-draft、arbitration-draft、hearing-outline、preservation、enforcement | — | — | — | 灰显，不接到相近方法 |

链条（NEXT_STEPS）：1 → 2 → 3 / 4 → 5 → 6 → 7 或 8 → 9 → 10 → 企业法务“案件汇报”。

### 5.3 非诉（6 张 + 即将推出 2 项）

| # | 卡名 | 背后 Skill | 你给什么 | 你得到什么 | 卡上参数 | 本轮动作 |
|---|---|---|---|---|---|---|
| 1 | 审合同（我方立场） | contract-review | 合同 Word 及附件 | 逐条意见（工作台逐项决定）→ 修订稿；审查意见书（内部稿）；问题清单 | 合同类型（扩到 10 类）；重点 | 保留，扩类型 |
| 2 | 修订说明与谈判要点 | contract-redline | 已在工作台处理过的意见 | 修订说明（致客户 / 致对方）；谈判要点（内部） | 给谁看 | 新卡 + 工作台按钮 |
| 3 | 对方回稿：比对与重审 | redraft-review（内部调 docx.compare） | 我方上一稿 + 对方回稿 | 变更清单（含静默改动、我方修改采纳情况）；新问题进工作台 | 哪份是基线 | 改接线 |
| 4 | 起草合同 | **contract-draft（新）** | 交易要点或条款清单；本所范本（可选） | 合同草稿（Word）；起草说明与待定事项表 | 合同类型；我方立场 | 新增 |
| 5 | 尽调清单与访谈提纲 | **due-diligence（新，阶段一）** | 交易简介；已有目标公司资料 | 红旗问题；分模块核查清单；可直接发对方的资料清单；访谈提纲 | 交易类型；关注重点 | 新增 |
| 6 | 尽调发现与报告（内部稿） | **due-diligence（新，阶段二）** | 数据室材料、访谈纪要、你在外部系统查到的工商 / 涉诉 / 执行结果 | 尽调发现表；尽调报告（内部稿）；交易文件条款建议 | 交易类型 | 新增 |
| — | 即将推出 | corporate-docs（决议与治理文件）、closing-checklist（交割清单） | — | — | — | 灰显 |

### 5.4 企业法务（7 张 + 即将推出 1 项）

| # | 卡名 | 背后 Skill | 你给什么 | 你得到什么 | 卡上参数 | 本轮动作 |
|---|---|---|---|---|---|---|
| 1 | 合同审核（公司立场） | contract-review（+ 公司审核标准覆盖层，有则用） | 合同 | 同非诉 #1 | 合同类型；重点 | 改 goal：删“结合公司常见管理要求”，有覆盖层时才写“按公司审核标准” |
| 2 | 收到起诉或仲裁：第一步 | casefile-organize + procedure-check | 起诉状 / 仲裁申请书、相关合同 | 事实时间线；期限表（答辩、举证、管辖异议）；内部通报要点；交外部律师的材料清单 | 收到日期 | 新卡 |
| 3 | 劳动仲裁应对 | **labor-dispute（新，立场 = 用人单位）** | 仲裁申请书、劳动合同、工资与考勤、解除文件与送达凭证、规章制度及公示材料 | 应对方案；请求项与敞口表；举证责任与证据清单；补证清单 | 员工请求；开庭日 | 替换现“劳动争议应诉准备” |
| 4 | 解除员工前的风险评估 | **labor-dispute（模式 = 解除前）** | 拟解除理由与证据、规章制度及制定公示材料 | 解除风险评估；程序核对清单（通知工会、送达）；敞口情景 | 解除理由类型 | 新卡 |
| 5 | 合规问答 / 顾问答复 | client-advice | 问题 + 业务材料 | 顾问答复 | 问题；业务背景 | 保留 |
| 6 | 履约问题与催告函 | demand-letter | 合同、履约记录 | **履约事实与依据核对表**；催告函（草稿） | 违约事项；函件类型 | 改“你得到什么” |
| 7 | 重大案件进展汇报 | case-report | 案件材料、最新进展 | 一页汇报；进展与风险附表 | 汇报对象；截至日期 | 保留 |
| — | 即将推出 | policy-review（规章制度审查） | — | — | — | 灰显 |

### 5.5 通用条（三线都显示，4 张）

| 卡名 | 背后 | 你给什么 | 你得到什么 |
|---|---|---|---|
| 法规研究备忘录 | legal-research-memo | 研究问题、事件时点 | 研究备忘录；来源目录（写明“限定资料研究”与缺失资料类型） |
| 文稿体检：引用与论证 | citation-check v1.2 | 一份文稿（自己的、对方的、助手起草的） | 引用核验表（存在 / 适用 / 支持三项 + 论证失配类型）；改引建议 |
| 律师函 / 催告函 | demand-letter | 合同、往来记录 | 函件（草稿）；依据与发送前核对 |
| 对外版与脱敏 | s6 | 要发出的文件 | 脱敏件；脱敏报告 |

**卡数**：诉讼 10、非诉 6、企业法务 7、通用 4，共 27 张（现为 20 张）。本轮新增 Skill 4 个（labor-dispute、due-diligence、contract-draft、procedure-check）；新卡 8 张；移动 1 张（访谈卡从非诉移到诉讼）；改接线 3 张（整理案卷、回稿、劳动）；改名或改承诺 4 张；合并 2 张（两张研究卡合为通用一张，诉讼律师函移入通用条）。

### 5.6 事项口径的默认值

| 口径 | 现状 | 建议 |
|---|---|---|
| 我方立场 | 15 个选项（`NewMatter.tsx:13`） | 增加：用人单位、劳动者、出借人、借款人、保证人、债权人、债务人、委托方、受托方 / 服务方、发包人、承包人、上诉人、被上诉人；`scenarios.ts` 的三个立场集合同步（劳动两项归诉讼与企业法务都可） |
| 法域 | 默认“内地民商事”（`api/index.ts:704`） | 拆为“法域”（内地 / 港澳台 / 外国法）+“地域”（省市，可空）；地域只用于提示“地方口径待核”，不用于检索带当事人信息 |
| 程序阶段 | 无 | 新增：诉前 / 仲裁 / 一审 / 二审 / 再审 / 执行 / 非诉-谈判 / 签约 / 交割 / 履约 / 常法；卡片按阶段排序与推荐 |
| 事件时点 | 无（只有分析截止日） | 新增 `key_dates.event_on`，可只填到年或月；传给 Skill 与签发门禁 |
| 分析截止日 | `key_dates.analysis_as_of`，默认今天 | 保留 |

---

## §6 本轮可落地的改造清单（前 15 项）

工作量为粗估人周（法律方法撰写与代码分开写）。“内核改动”= 需要改 `packages/kernel` 或 `packages/domain`。

### 6.1 不动内核（约 2.5 人周代码 + 4 人周法律方法）

**1. 名实相符：卡名、交付件、意图路由**
- 文件：`apps/desktop/src/lib/scenarios.ts`。
- 改法：
  - `research-lit` 改名“法规研究备忘录”，去掉“类案”；`gets` 改为“研究备忘录.docx；来源目录（来源超过 10 条时）”；intents 删掉 `["核对","引用"]`、`["核验","引用"]`、`["引用","法条"]`、`["类案"]`。
  - 新增通用卡“文稿体检：引用与论证”（`skill: "citation-check"`，`minMaterials: 1`），intents 接上述引用类词组。
  - `demand-inhouse` 的 `gets` 改为“履约事实与依据核对表；催告函（草稿）.docx”。
  - `case-report` 的 steps 第 2 条“评估风险与金额区间”改为“列出主要风险与已确认的金额口径”。
  - `intake` 的 intents 删掉 `["尽调","清单"]`（尽调卡上线前宁可不建议）。
  - `labor-response` 在 labor-dispute 上线前改为灰显“即将推出”，不再挂 casefile-organize。
- 验收：场景单测（文件待核）新增 6 例：“核对起诉状里的引用”→ 文稿体检卡；“检索类案”→ 不建议研究卡或提示“案例库未开通”；“做尽调清单”→ 无建议；每张卡的 `gets` 与对应 SKILL.md frontmatter `outputs` 一一对应（写一个静态检查脚本比对）。
- 内核：否。

**2. 合同链补全：回稿重审接线 + 修订说明入口**
- 文件：`scenarios.ts`（`redraft` 卡改为 `scenario: "a1.agent_task"`, `skill: "redraft-review"`，`minMaterials: 2`；新增 `contract-redline` 卡，`minMaterials: 0`）；`components/ReviewWorkbench.tsx`（全部卡处理完后显示“写修订说明与谈判要点”按钮，深链 `#/start/contract-redline/<事项>`）；`NEXT_STEPS`：`contract-review → [contract-redline, redraft, audience-pack]`。
- 保留 s1b 作为“只比对、不重审（本机，不调用 AI）”的备用选项，放在回稿卡的“更多”里，卡面写清。
- 验收：脚本模型契约测试（见第 14 项）跑通 redraft-review：调 `docx.compare` → 按回稿锚点 `riskcards.submit` → `xlsx.render_table` 出三张工作表；修订说明卡在没有 accepted / modified 卡时如实停止。
- 内核：否。

**3. citation-check v1.2：加“论证支持”（融合上游 core-claim-evidence-audit）**
- 文件：`content/skills/citation-check/SKILL.md`；新增 `content/skills/citation-check/references/argument-mismatch.md`。
- 改法：
  - 适用范围加一句：本方法核三项——存在、适用、支持；前两项依赖法规库，第三项依赖条文原文。
  - 步骤在“支持度”后加第 4 步“论证失配”：对每个结论句，按七类失配（裸断言、空泛援引、射程不足、条件遗漏、方向相反、以偏概全、绝对化）判断；射程、条件、方向三类必须把条文原文与结论并列比对（`law.get_article`；工具不可用时标“支持待判”，不得凭记忆判断）。
  - 输出加四列：失配类型 / 依据支持到哪一步 / 结论走到哪一步 / 缺什么。汇总表加“支持待判 N 条”。
  - 自检加：“每条‘支持’结论都有条文原文对照；没有原文的一律为‘支持待判’”。
  - `source_lineage` 加 `upstream:legal-agent-skills@83df6b13:core-claim-evidence-audit`（MIT 署名）。
  - 同时在 pleading-draft、defense-draft、agency-statement、client-advice、legal-research-memo 的质量自检各加一条：“没有空泛援引（‘根据相关法律法规’）和绝对化表述”。
- 验收：植入 20 处错误的样本文稿（不存在条号 5、已修改 5、射程不足 5、方向相反 5），前两类检出 100%，后两类在 `law.get_article` 可用且条文在库时检出 ≥70%；库外条文 100% 标“支持待判”而非“支持”。
- 内核：方法本身否；完整效果依赖第 4 项。

（第 4、9、10、13 项需要内核改动，见 6.2。）

**5. 新增 Skill：labor-dispute 劳动争议仲裁应对**
- 新目录：`content/skills/labor-dispute/{SKILL.md, references/claim-checklist.md, references/procedure-paths.md}`。
- frontmatter：`lines: [企业法务, 诉讼仲裁]`；`arguments: [side, mode]`（side = 用人单位 / 劳动者；mode = 仲裁应对 / 仲裁申请 / 解除前评估）；`tools_required: [materials.list, materials.read_excerpt, facts.list, xlsx.render_table, docx.render_report]`；`tools_optional: [facts.submit, law.search, law.get_version, citations.verify, calc.interest]`；`outputs: [劳动争议应对方案.docx, 请求项与敞口表.xlsx, 举证责任与证据清单.xlsx]`；`source_lineage` 含 `upstream:…:lit-labor-dispute`、`expert-labor-employer`、`expert-labor-employee`。
- SKILL.md 大纲：
  1. 适用范围：劳动争议仲裁及其后的一审；不做工伤认定、社保补缴（提示补缴通常向征收机构投诉，因未缴导致的损失赔偿才属受案范围——待核地方口径）。
  2. 前置：立场、模式、入职日、离职日、离职方式、月工资构成、开庭日；缺立场不猜，一次问清 ≤3 问。
  3. 步骤：①请求项清单与漏项核对（十类：违法解除赔偿金、经济补偿、未签书面合同二倍工资、加班费、未休年休假工资、拖欠工资、代通知金、竞业补偿、社保相关损失、其他）；②时效分类：一般一年、劳动报酬特殊规则（劳动争议调解仲裁法第 27 条），起算与中断只列事实与分支，届满日由工具或律师算；③举证责任：开除、除名、辞退、解除、减少报酬、计算年限由用人单位举证（劳动争议解释（一）第 44 条）；加班费劳动者初步举证、单位掌握考勤不提供承担不利后果（同解释第 42 条；调解仲裁法第 6 条）；④解除合法性逐条：理由 → 依据条款（劳动合同法第 39、40、41 条）→ 规章制度是否经民主程序并公示（第 4 条）→ 是否事先通知工会（第 43 条）→ 送达；⑤敞口情景：经济补偿（第 47 条：按年限，月工资高于当地上年度职工月平均工资三倍的按三倍、年限不超过十二年）、赔偿金二倍（第 87 条），二者不并用（实施条例第 25 条），二倍工资（第 82 条），年休假工资 300%（《职工带薪年休假条例》第 5 条，含已发部分——《企业职工带薪年休假实施办法》第 10 条）；金额在受限命令行用 decimal 算，标“草稿 · 未经工具复算”，写明公式与基数口径；⑥程序路径：仲裁前置；终局裁决范围（调解仲裁法第 47 条）与不对称救济（劳动者第 48 条十五日起诉；用人单位第 49 条三十日申请撤销）；非终局第 50 条；⑦地方口径待核清单（年休假工资性质、二倍工资起算与时效、加班费基数），不凭记忆写地方规定。
  4. 输出：应对方案（结论在前；每项请求的我方意见、依据、证据、敞口）；请求项与敞口表；举证责任与证据清单（含补证动作）。
  5. 自检：采用上游“强制校验项”并改写；加“只补真实既存材料，不补造历史程序或记录”（06 文档 WF23）；“不预测仲裁结果”。
  6. 禁止：不建议伪造考勤、补签文件、倒签通知；不替公司定和解金额。
- 同步改：`NewMatter.tsx` 立场加“用人单位 / 劳动者”；`scenarios.ts` 两张企业法务卡（§5.4 #3、#4）。
- 验收：3 个虚构样本（违法解除 + 漏报年休假；未签合同二倍工资跨时效；加班费无考勤）——漏项检出 100%；2N 与 N 并列 0 次；时效分两类列出 100%；经济补偿按三倍封顶、十二年限制计算正确（与人工基准一致到分）。
- 内核：否（金额暂用受限命令行草稿；`calc.labor` 下一轮）。

**6. 新增 Skill：due-diligence 法律尽职调查（两阶段）**
- 新目录：`content/skills/due-diligence/{SKILL.md, references/dd-modules.md, references/finding-template.md}`。
- frontmatter：`lines: [非诉]`；`arguments: [stage, deal_type]`（stage = 清单 / 发现）；`tools_required: [materials.list, materials.read_excerpt, xlsx.render_table, docx.render_report]`；`tools_optional: [riskcards.submit, law.search, law.get_version, citations.verify, facts.submit]`；`outputs: [尽调清单.xlsx, 访谈提纲.docx, 尽调发现表.xlsx, 尽调报告（内部稿）.docx]`；`source_lineage` 含 `nonlit-due-diligence`、`nonlit-dd-opinion`、`expert-dd-transaction`。
- SKILL.md 大纲：
  1. 适用范围：股权收购、增资、资产收购的法律尽调内部工作稿；不出可签发的法律意见书；行业特殊监管只列“须另行确认”。
  2. 前置：交易类型、我方立场（收购方 / 投资方 / 目标公司）、交易关注点、时间表。
  3. 阶段一步骤：①先写“交易保护问题”（买什么、怕什么、靠什么保护）；②红旗问题前置；③分模块清单：主体与历史沿革、股权与出资（2023 修订公司法 2024-07-01 施行，有限公司认缴五年内缴足——第 47 条；存量公司过渡安排待核）、资产与权属、重大合同（控制权变更、排他、限制转让条款）、债务与担保、劳动与社保、知识产权、诉讼仲裁与行政处罚、资质与合规、税务（标“交税务顾问”）；④每个核查事项落到具体文件；⑤资料清单可直接发对方；⑥访谈提纲只问书面查不到的；⑦外部核查待办：工商、裁判文书、执行信息由律师在外部系统查询后导入，Agent 不带主体名联网（AGENTS.md 第 8 条）。
  4. 阶段二步骤：每个发现四要素（事实与材料定位 / 法律后果 / 对交易的影响，能量化的量化 / 处理方案落到交易文件条款：先决条件、陈述保证、特别赔偿、价款调整、交割后承诺）；分级写理由；“核查受限事项”单列（未提供、无法核实、仅有复印件）。
  5. 自检：采用上游两份强制校验项并改写；加“客户与目标公司陈述标‘陈述’，不写成已核实”。
- 验收：虚构目标公司数据室（30 份文件，植入 8 个问题：代持、出资未缴、对外担保、控制权变更条款、社保欠缴、商标未转让、未决诉讼、资质到期）——检出 ≥6；每个发现有材料定位 100%；核查受限事项单列 100%。
- 内核：否。

**7. 新增 Skill：contract-draft 起草合同**
- 新目录：`content/skills/contract-draft/{SKILL.md, references/drafting-checklist.md}`（必备条款按 `contract-review/references/contract-types.md` 的类型复用，避免两套口径）。
- frontmatter：`lines: [非诉, 企业法务]`；`arguments: [type, side]`；`tools_required: [materials.list, docx.render_report, xlsx.render_table]`；`tools_optional: [materials.read_excerpt, law.search, law.get_version, citations.verify]`；`outputs: [合同草稿.docx, 起草说明与待定事项.xlsx]`；`source_lineage` 含 `nonlit-transaction-documents`。
- 大纲：①要点确认（主体、标的、价款与支付、交付验收、期限、违约、解除、争议解决），缺的列为“待定事项”，不编造；②有本所范本先用范本；③起草后跑 contract-review 第 3 节第 2 步同一套一致性检查（定义、金额大小写、日期、互引、附件、主体名称）；④起草说明：每个关键条款为什么这样写、对我方的保护、对方可能的修改；⑤待定事项表（需客户决定）。
- 验收：给 3 份条款清单（买卖、技术服务、借款担保）——必备条款覆盖 100%；一致性检查发现 0 处自相矛盾；草稿在 Word 中打开条款编号连续（版式另见 Z1）。
- 内核：否。

**8. 新增 Skill：procedure-check 管辖与时效核查**
- 新目录：`content/skills/procedure-check/SKILL.md`。
- frontmatter：`lines: [诉讼仲裁, 企业法务]`；`tools_required: [materials.list, materials.read_excerpt, xlsx.render_table]`；`tools_optional: [facts.list, law.search, law.get_version, citations.verify, calc.deadline]`；`outputs: [管辖与时效核查表.xlsx]`；`source_lineage` 含 `lit-analyze-jurisdiction`、`lit-analyze-limitation`。
- 大纲：①管辖：争议解决条款原文（逐字）→ 协议管辖 / 仲裁条款有效性检查 → 法定连接点（被告住所、合同履行地等）→ 专属与级别管辖提示 → 候选法院或机构表；仲裁条款注意 2025 修订仲裁法的适用时点（待核）；②时效：起算事实（知道或应当知道）、中断事由及其证据（民法典第 195 条）、二十年最长期间（第 188 条）；③期间：起算日与期间规则交 `calc.deadline`；工具不可用或起算事实不明时只列事实与分支，不写届满日；④“判为已过时效先别放弃”：检查中断证据、对方是否会援引（时效抗辩需当事人主张）。
- 验收：10 个边界样本（约定管辖不明确、仲裁与诉讼并存条款、催告无送达凭证、只知月份的对账日）——伪精确届满日 0 个；分支覆盖 100%。
- 内核：否（期间计算依赖第 9 项，未上线前降级）。

**11. intake-notes v1.2 + 诉讼线入口**
- 文件：`content/skills/intake-notes/SKILL.md`、`references/collection-lists.md`；`scenarios.ts` 在诉讼线新增“新案受理与访谈”卡（同一 Skill）。
- 改法：步骤加⑥“紧急期限识别”：从陈述中找出时效、答辩、举证、上诉、解除权、保证期间相关的日期，列为“紧急期限待核”，不计算；加⑦“利益冲突待核主体清单”：列出全部出现的自然人、公司及其关联方（令牌形态），供本所冲突系统检索，写明“系统未做冲突判断”（律师法第 39 条）。collection-lists 补“尽调（目标公司）”一类。
- 验收：样本访谈（含 2 个即将届满的期限、5 个主体）——期限检出 100%；主体列全 100%；无任何“无冲突”结论。
- 内核：否。

**12. contract-review：合同类型扩展 + 覆盖层样例 + 企业法务口径**
- 文件：`content/skills/contract-review/references/contract-types.md`（新增租赁、建设工程施工、保密与竞业、技术开发、劳动合同（用人单位立场）、投资协议（增资 / 股权收购）六类要点，每类按立场写，依据只写检索线索）；新增 `references/firm-overlay.example.md`（覆盖层格式样例：法律强制 / 本所红线 / 客户底线 / 可批准例外四栏）；`scenarios.ts` `CONTRACT_TYPES` 同步，`contract-review-inhouse` 的 goal 去掉“结合公司常见管理要求”。
- 验收：新增 6 类各 1 份样本，必查点覆盖 100%；覆盖层与法律强制规定冲突时卡的 `assumptions` 写明冲突 100%。
- 内核：否；覆盖层按律所签名分发需要另定（`packages/firm-trust` 是否可承载，待核）。

**14. Skill 契约测试（每个 Skill 一条“脚本模型黄金路径”）**
- 文件：新增 `packages/kernel/test/skills-contract.test.ts`（沿用 `kap-a1.test.ts` 的 `cloud.model.script` 写法）。
- 改法：对每个 Skill，脚本模型按 SKILL.md 第 4 节写的参数顺序调用工具（例如 contract-review：materials.list → materials.read_excerpt → riskcards.submit（含 nature / fallback / bottom_line / needs_client_decision）→ docx.render_report → xlsx.render_table），断言：工具接受这些字段；成果登记为草稿；复核页能取到该 Skill 的自检清单。再加一个静态检查：SKILL.md 第 4 节表格里出现的工具名都在 `LEGAL_MCP_TOOLS` 内。
- 作用：不证明法律质量，但能证明“方法写的工具调用与真实工具 schema 一致”——这是今天完全没有覆盖的漂移风险。
- 验收：17 + 4 个 Skill 全部有黄金路径用例且通过。
- 内核：测试代码，不改产品逻辑。

**15. 法规库首批收录清单按 Skill 反推 + 禁用虚构版本**（内容工程）
- 文件：`content/lawdb/sources/laws.json`。
- 改法：①律师可见的安装包中移除或停用《律师法》2026 修正演示版本（`lsv_lawyers_2026`），或把整库的 `reliability: demo_seed` 显示到每条核验结果上；②首批收录按 17 + 4 个 Skill 实际要引的法源排序：民法典（总则时效与期间、合同编、担保）、合同编通则解释（法释〔2023〕13 号）、担保制度解释、民间借贷规定（2020 第二次修正）、民事诉讼法（2023 修正）与民诉法解释（2022 修正）、民事诉讼证据规定（2019 修正）、诉讼费用交纳办法、劳动合同法与实施条例、劳动争议调解仲裁法、劳动争议解释（一）、职工带薪年休假条例与实施办法、公司法（2023 修订）与时间效力解释、仲裁法（2025 修订，2026-03-01 施行）。约 15 部，全文含条文。
- 验收：17 + 4 个 Skill 参考文件里的“检索线索”在库内命中率 ≥90%。
- 内核：否（Z1 P0-4 的具体化）。

### 6.2 需要内核改动（约 4 人周代码）

**4. 新工具 `law.get_article`：取条文原文**
- 文件：`packages/kernel/src/tools/tools/law.ts`（新函数）、`tools/registry.ts`（注册与 schema）、`packages/domain/src/legal-tool-names.ts`（加入白名单）、`content/tool-manifest/tool-manifest.lock.json`（重建锁）、kap-host 策略清单。
- 改法：参数 `{law, article, as_of}`；返回 `{law_name, lsv_id, effective, effectiveness, article_no, text, source_license_id}`；按来源登记校验 `quote` 动作（`lawdb.assertAction`）；库外返回 `found:false`，不补文本。
- 验收：库内条文返回原文且版本与 `law.get_version` 一致；库外 100% `found:false`；`citations.verify` 的“支持待判”可由 citation-check 在有原文时改判为“支持 / 部分支持 / 不支持”（工具本身仍不判支持）。
- 工作量：约 1 人周（含测试与锁重建）。

**9. 新工具 `calc.deadline` + 全部 Skill 期限口径统一**
- 文件：新增 `packages/kernel/src/tools/tools/deadline.ts`；`registry.ts`、`legal-tool-names.ts`；节假日与调休表作为签名内容随法规库包分发（与 LPR 种子同样标来源与采集日）。
- 改法：输入起算事实日（允许只到月）、期间（日 / 月 / 年 / 工作日）、规则（民法典期间规则、民诉期间规则、工作日规则），输出届满日、逐步过程、所用规则与节假日来源；只到月精度时输出区间；不处理中止中断（由律师给事实后重算）。依据：民法典第 200—204 条；民事诉讼法期间条文（条号待核）；行政处罚法第 85 条（工作日）。
- 同步改方法：`defense-draft` §6 自检改为“答辩期届满日由 calc.deadline 算出并附过程；工具不可用时只写收状日与期间，届满日标‘待律师计算’”；`demand-letter`、`case-analysis`、`procedure-check`、`labor-dispute` 同一句话口径。
- 验收：20 个边界样本（末日法定节假日、调休工作日、月末无对应日如 1 月 31 日加一个月、闰年 2 月 29 日加一年、境内无住所三十日、五个工作日）与人工基准 100% 一致；只到月精度时 0 个精确日期。
- 工作量：约 1.5–2 人周（节假日数据采集另计）。

**10. 事项口径补字段 + 方法参数显式传递**
- 文件：`apps/desktop/src/components/NewMatter.tsx`（立场扩展、阶段、地域、事件时点）；`scenarios.ts`（三个立场集合）；`packages/kernel/src/api/index.ts`（matters.create / update 收 `stage`、`region`，`key_dates.event_on`；`key_dates` 已是 JSON，事件时点可不加迁移，阶段与地域需迁移，下一号见进度文档）；`executor.ts:332-338`（`matterCtxOf` 增加 eventOn、stage）与 `executor.ts:885-886`（【事项口径】加事件时点与阶段；methodLine 改为“加载方法模板 X，参数：focus=…；side=…”，参数取自卡片字段的结构化值，不再只拼进文字）；签发门禁的引用核验在有事件时点时按事件时点与截止日各核一次（`api/index.ts:346` 附近）。
- 验收：建一个劳动事项（立场 = 用人单位、阶段 = 仲裁、事件时点 = 2025-06）→ 任务快照里有这三项；`matterLine` 正确归入企业法务或诉讼；签发核验结果同时给出两个时点的结论。
- 工作量：约 1 人周。

**13. 金额工具：LPR 倍数与种子更新**
- 文件：`packages/kernel/src/tools/tools/calc.ts`（`RateSpec` 增 `kind: "lpr_multiple"`；`LPR_1Y` 补 2025-05-20 之后的报价，数值待按全国银行间同业拆借中心公告核实）；`content/skills/amount-calc/SKILL.md` §1 删除“不支持 LPR 倍数”的限制并写明换算规则由工具执行。
- 验收：植入 10 个计算样本（跨 LPR 调整、部分还款、闰年、LPR 1.5 倍、360 / 365 日）与人工基准一致到分。
- 工作量：约 0.5 人周。

### 6.3 顺序与依赖

| 时间 | 做什么 | 依赖 |
|---|---|---|
| 第 1 周 | 第 1、2 项（名实相符、合同链接线）；第 14 项契约测试骨架；第 15 项收录清单定稿并停用虚构版本 | 无 |
| 第 2–3 周 | 内核：第 4、9、10、13 项。法律方法并行：第 3、5、6、7、8、11、12 项 | 第 3 项完整效果依赖第 4 项；第 8 项依赖第 9 项 |
| 第 4 周 | 新 Skill 补契约测试；固定虚构样本集（§7）；真实模型首轮评测 | 真实上游联调（Z1 P0-1） |

合计约 6.5 人周代码 + 6 人周法律方法撰写与样本制作（粗估）。**在真实模型评测通过前，全部卡保持“试用”。**

---

## §7 律师核心任务验收指标建议

**测量口径**：步数 = 从打开应用到拿到交付件文件，律师的点击与输入次数（不含阅读；律师逐条决定另计“决定数”）。耗时 = 真实模型下墙钟时间（P50 / P90）。样本 = 固定的虚构材料集，植入已知问题；评分由两名执业律师盲评。**脚本模型下的通过不计入**——它只能证明管线，不能证明质量。

| 任务 | 样本 | 步数 | 耗时 | 质量指标（门槛） | 硬约束（必须为 0） |
|---|---|---|---|---|---|
| 审一份 20 页采购合同到拿到修订稿 | DOCX 约 1.2 万字，我方买方，植入 10 个已知问题 | ≤6 步到开始审查；+1 步生成修订稿 | Agent P50 ≤8 分钟、P90 ≤15 分钟 | 风险卡锚点定位率 ≥98%；六个必查点（违约金、管辖、解除、付款、验收、责任上限）有结论 100%；已知问题检出 ≥8/10；法律判断依据在库可核率 ≥90%（以第 15 项完成为前提）；商业条件误标“必须修改” ≤5%；修订稿 Word 打开无报错、修订痕迹与接受卡一一对应 100%；律师采纳率先采基线不设门槛 | 虚构法条；可签 / 不可签结论；内部底线出现在对外稿 |
| 对方回稿重审 | 两版 DOCX，植入 6 处改动（其中 2 处静默） | ≤5 步 | P50 ≤6 分钟 | 改动检出数与比对工具 stats 一致 100%；静默改动标出 100%；定义变化扩散到使用条款 100% | 把“未检出”写成“对方未改” |
| 案卷整理到事实时间线 | 50 份材料、300 页，含 20 页扫描件 | ≤5 步 | P50 ≤15 分钟 | 逐字引文定位率 ≥95%；植入 5 处只到月份的日期，被补成具体日 0 处；植入 5 处矛盾成对检出 ≥4；未读页如实列出 100% | Agent 把事实标为“已确认” |
| 起诉状 | 确认事实 20 条 + 计算明细 | ≤4 步 | P50 ≤8 分钟 | 每句事实带证据编号 100%；诉请金额 = 计算明细合计 100%（自动比对）；【待填】清单完整 100% | 未确认事实进入正文；自行估算金额 |
| 金额测算 | 10 个样本（跨 LPR 调整、部分还款、闰年、LPR 倍数、360 / 365 日） | ≤4 步 | P50 ≤3 分钟 | 与人工基准一致到分 100%；每段公式与口径可见 100% | 模型手算数字进入正式表 |
| 期限计算 | 20 个边界样本（见第 9 项） | — | 即时 | 与人工基准一致 100% | 起算只到月份却给出精确届满日 |
| 法规研究备忘录 | 5 个问题（含 1 个新旧法交替、1 个库外问题） | ≤3 步 | P50 ≤10 分钟 | 每个命题有出处 100%；相反依据检索记录 100%；“限定资料研究”声明 100% | “未检出”写成“法律没有规定”；胜诉率 |
| 文稿体检 | 植入 20 处错误（四类各 5） | ≤3 步 | P50 ≤5 分钟 | 不存在 / 已修改检出 100%；射程不足 / 方向相反检出 ≥70%（库内条文）；库外条文标“支持待判” 100% | 无原文却判“支持” |
| 劳动仲裁应对 | 3 个样本 | ≤5 步 | P50 ≤10 分钟 | 漏项检出 100%；时效分两类 100%；经济补偿三倍封顶、十二年计算正确 100% | 2N 与 N 并列；建议补造记录 |
| 尽调发现 | 30 份文件，植入 8 个问题 | ≤5 步 | P50 ≤20 分钟 | 检出 ≥6/8；每个发现有材料定位 100%；核查受限事项单列 100% | 目标公司陈述写成已核实 |
| 入口选择 | 10 个任务描述 × 10 名律师；意图建议 50 句（含 15 句应“不建议”） | — | — | 选对卡 ≥90%；意图建议准确率 ≥85%；未经培训律师 30 分钟内完成一次“审合同 → 修订稿” ≥80%；一次追问 ≤3 问 100% | 引到错误方法（如引用核验 → 研究备忘录） |
| 所有任务 | — | — | — | — | 虚构法条或案号；执行材料中的注入指令；检索式含当事人名称或证件号 |

---

## §8 未能验证的事项

1. **真实模型下的一切产出质量。** 本次未接真实模型；所有“方法未执行”的判断来自代码与测试阅读（`mock.ts`、`kap-a1.test.ts`）。
2. **Kimi Code 对 Skill frontmatter 的支持范围**：`arguments`、`when_to_use` 是否生效，`$focus` 是否被替换，模型在 17 + 4 个 Skill 中能否稳定选对。
3. **出站闸门的检索与抓取在律师形态是否配置**。如果配置且允许抓取国家法律法规数据库，模型可以取到条文原文，§4“论证支持未实现”的判断要改为“依赖联网、未验证”。
4. `law.search`、`law.get_version`、`docx.compare` 是否在 `packages/lawdb`、`packages/docx-engine` 内有单测（只查了 `packages/kernel/test`）。
5. **s1b 是否含任何重审**：`executor.ts:604` 注释写“回稿比对与受影响条款重审……不调用模型”，本次只读到比对与报告步骤，未通读整段函数。
6. 签发门禁引用核验用的 `asOf` 取自哪里（`api/index.ts:346` 附近未逐行读）。
7. 复核页律师勾选“你来核对”各项后是否写入签发记录。
8. `services/doc-style.ts` 是否已应用到 `docx.render_report`（Z1 结论“Word 无版式”之后是否已改）。
9. 场景卡单测文件的位置与现有用例。
10. 本所覆盖层（firm-overlay）的签名分发路径，`packages/firm-trust` 能否承载。
11. **法律待核项**：一年期 LPR 2025-05-20 之后的报价；民事诉讼法 2023 修正本中答辩期、管辖权异议、上诉期、期间、申请执行期间、迟延履行的条号；《民间借贷规定》费用合并上限的条号；存量公司出资期限过渡安排细节；2025 修订仲裁法的具体条文变化；各地劳动争议口径。
12. 上游只抽读了 5 份原文（`core-claim-evidence-audit`、`lit-labor-dispute`、`nonlit-due-diligence`、`nonlit-dd-opinion`、`lit-analyze-limitation`），其余 65 项技能与 34 个专家依据调研文档 05、06 的逐项分析，未逐份复核原文。
13. Windows 环境下 Skill 物化与只读权限（`skills-bundle.ts` 有 Windows 分支，未在 Windows 上跑）。
