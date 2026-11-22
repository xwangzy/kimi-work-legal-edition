# S · 智合 legal-agent-skills 与 Kimi Code 的集成度核查（只读，2026-11-22）

范围：工作树 `claude/kimi-legal-architecture-review-c6783f`（头 c09eb55，含第 55 批）。只读代码与已有研究，没有改产品文件、没有启动服务、没有调用模型。
不重复已有调研：竞品功能、33 方法逐卡字段缺口见 `research/2026-11-22-V29-全页面精修与Skills审计/A-法律Skills审计.md`（下称“审计 A”）与 `00-评审判断与实施.md` §4（下称“V29 §4”）；本文只做“对照实际代码”的集成度核查。

路径缩写：`P/` = `platform/`；`SK/<id>` = `P/content/skills/<id>/SKILL.md`；`AG` = `P/content/skills/AGENTS.md`；`EX` = `P/packages/kernel/src/executor/executor.ts`；`KE` = `P/packages/kap-host/vendor/kap-embed/kap-embed.mjs`（kap-server 2.2.0 内嵌产物）；`ZH/` = `research/2026-10-21-智合AI调研/上游来源/legal-agent-skills/`（智合仓库快照，提交 83df6b13）。

智合仓库版本：本机快照提交 `83df6b13a60b2dfeaf30001c7894bcb45a59fcc4`；2026-11-22 `git ls-remote` 远端 HEAD 仍是同一提交，所以没有另行克隆。

---

## 〇、一页结论

**一句话**：方法正文走的是上游 Kimi Code 的原生 Skill 机制（可信区 `skillDirs` + 模型调 `Skill` 工具按需加载 + `references/` 由 `Read` 按需读），这条主路是通的；但**方法参数这一段只接了一半**——33 个方法正文里有 135 处 `$side`、`$court` 这类占位符，上游会在加载时用 `Skill` 工具的 `args` 位置参数替换，**没传 args 就替换成空串**，而内核只在提示词里用文字写“方法参数：court=…”，从不让模型把参数传给 `Skill`。智合 70 个 skill 里，我们改写采纳 10 个、自研同类 16 个、部分覆盖 10 个、完全没有对应 34 个。没接的里面，类案检索、结案交付、接案报价、行政与监管应对、再审、股东纠纷值得接；来华 8 项、进博、普法、营销类不值得接。

### P0（3 条）
| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| P0-1 | 方法占位符被上游替换成空串 | `KE:172562-172585` `expandSkillParameters`：按 `arguments` 顺序把 `$name` 换成 `tokens[i] ?? ""`；`EX:1027` 只写“先调用 Skill 工具加载方法模板 X”，参数写在文字里；V13 真实事件 `Skill` 调用描述只有“Invoke skill contract-draft”（`research/2026-11-07-V13核心业务修复/成果样本/*/events.json`） | 例如 `SK/pleading-draft:39` 的“受诉法院（`$court`）”到了模型那里变成“受诉法院（``）”；`SK/contract-draft:24` 的“立场（`$side`）……方法参数 `$side` 已写明的照用”变成空。现在靠模型从提示词里的“方法参数：”一行自己对上，等于方法参数这条通道没生效。第 55 批 20 个方法新补的参数声明也一样 |
| P0-2 | 提示词“先查材料目录”与【开工前已知】“不必先查材料目录”互相矛盾 | `EX:1104`【工作方式】固定写“先用法律工具 materials.list 查看材料目录”；`EX:1068` 空事项规则写“不必先查材料目录”；方法里也固定有一步 `materials.list`（`SK/pleading-draft:38`、`SK/defense-draft:34`） | 空事项和“只写案情”的任务，模型会照固定句先查一遍空目录。第 55 批修的正是这个问题，但最后一句话还没改 |
| P0-3 | 合同审查方法自相矛盾：意见书首页“必须写”质量说明 | `SK/contract-review:25` 写“意见书首页必须写‘通用辅助审查 · 未经本所质量验收’”；同一方法 `:126` 的自检要求意见书里没有这句；`AG:19` 第 10 条规定任何交付文件都不写 | V16 已知缺陷第 13 条（`P/eval/grading/已知缺陷清单-V16第一轮.md:17`）至今在审合同方法里没有清干净。它是最高频的方法，律师看到的是首页那行字 |

### P1（6 条）
1. **法条工具链冗余**：真实运行中每单调 `law.get_article` 13～28 次，`law.get_version` 0～8 次，`citations.verify` 0～2 次（V13 九单事件统计，见第四题）。`law.get_article` 已经按 `get_version` 的同一规则选版本（`P/packages/kernel/src/tools/registry.ts:116-120`），但 29 个方法仍写 `law.get_version`（如 `SK/contract-review:52`“先用 law.search、law.get_version 定位……再用 citations.verify”），只有 17 个方法提到 `law.get_article`，所以 `get_version` 这一步是多余的；`citations.verify` 支持批量（`registry.ts:136-160`），方法却没写“成文前一次批量核”。
2. **同一套交付规则写三遍**：`AG:13` 第 5 条、`EX:1015-1024` 的 `deliver` 段、`EX:1104`【工作方式】各写一遍“Word 主交付、Excel 只作附件、docx.edit_draft、导出 PDF”，每个方法第 1 节和第 7 节又写一遍。每单固定多出约 1,500 字，规则改一处就得同步改三处。
3. **法律问答（Chat）用不到方法和法律工具**：`P/packages/kernel/src/services/qa-chat.ts:237-243` 是一段纯系统提示 + 对话历史，不挂工具、不挂方法；引用是答完之后再核。Chat 页只有“要结合案卷材料，到事项里发起任务”这一句话（`P/apps/desktop/src/pages/Chat.tsx:219`），没有“按法规研究方法深入”的入口。
4. **工具失败降级写两遍**：每个方法第 4 节工具表的“失败时”一列和第 8 节“依赖缺失时的降级”内容重叠（8 个抽查方法里这两块合计 600～3,800 字，`SK/contract-review:61-94,138-144` 最多）。签名包已经校验 `tools_required`（`P/content/skills/build-skills.mjs:64`），这些工具在正式运行中不可能缺。
5. **第三方许可清单漏了一个方法**：`P/content/skills/THIRD_PARTY_LICENSES/README.md` 列了 6 个，`SK/labor-arbitration-draft:17` 的 `source_lineage` 也引用了上游 `lit-labor-dispute`、`lit-draft-defense`，没列进去。
6. **智合“四项前置门”只采纳了一半**：管辖、时效在 `procedure-check`，主体适格与前置程序（劳动争议先仲裁、行政复议前置）在起诉状、仲裁申请书方法里没有（全仓 `grep "主体适格|前置程序"` 在 `content/skills` 零命中；对照 `ZH/skills/litigation/lit-draft-complaint/SKILL.md` 第一步“核对前置事项”）。

### P2（5 条）
1. 33 个方法的技能清单（描述截到 250 字 + `when_to_use` + 路径，`KE:172621-172628`）每轮约 9,500 字常驻系统提示；可以缓存，但 `when_to_use` 合计 2,210 字，很多和描述重复（没有逐个比对）。
2. 方法正文里写进的历史注释（“第 34 批真实走查：……”）占正文 1%～10%（起诉状 620 字、修改文书 706 字、意见书 708 字），对模型是噪音，可以移到 `references/changelog` 或 `evals/`。
3. 子 Agent 能用（T3，强制 K2.6，`P/packages/kap-host/src/policy.ts:325-345`、`engine-config.ts:107`），但没有一个方法写到它；V13 九单真实事件里 `Agent` 调用为 0。多材料精读（尽调、整理案卷）本来可以并行。
4. `FREEFORM_METHOD_LINE`（`EX:1040`）只点名 8 个方法；上游技能清单本身全量可见，影响不大。
5. 首页推荐默认组合（`P/apps/desktop/src/lib/recommend.ts`）和第 55 批真实回归覆盖面不匹配：推荐的 6 张里，金额测算第 55 批改了字段，但还没用真实模型跑过。

---

## 一、集成事实：智合仓库是什么、我们用了哪些

### 1.1 智合仓库的组织（83df6b13）
- **70 个 skill**（`ZH/skills/<类>/<id>/SKILL.md`）：core 6、litigation 27、nonlitigation 24、utility 13；另有 **34 个专家工作流**（`ZH/experts/expert-*/EXPERT.md`），`dist/`、`dist-experts/` 是打包产物，不另计（`research/2026-10-21-智合AI调研/上游来源/来源与使用记录.md:8-9`）。
- 附件：39 个 skill 带 `scripts/`（Python：`zhihe_law_search.py`、`zhihe_case_search.py`、`verify_citations.py`、`timeline.py` 等），12 个带 `references/`（`sources.md`、`intake-and-handoff.md`、`delivery-template.md`、`plan-schema.md`），72 份 `evals.json`（本次 `find` 统计）。
- 外部依赖：检索走智合自家 HTTP 接口（`ZH/infra/zhiexa_proxy.py`，`ZH/skills/core/zhihe-law-search`、`zhihe-case-search`），7 个 skill 的正文直接点名这两个检索 skill；**公开仓库里没有 MCP 服务器实现**（与 10-21 调研结论一致：`来源与使用记录.md:16`）。
- 规范：`ZH/conventions/`（skill-template、expert-template、retrieval-contract、time-effect、output-formats）。

### 1.2 我们这边：33 个方法里 7 个声明了上游来源
按 `source_lineage` 统计（`grep source_lineage P/content/skills/*/SKILL.md`）：

| 我们的方法 | 声明的上游（83df6b13） | 位置 |
|---|---|---|
| citation-check | core-claim-evidence-audit、core-verify-statute-validity | `SK/citation-check:16` |
| contract-draft | nonlit-transaction-documents | `SK/contract-draft:16` |
| due-diligence | nonlit-due-diligence、nonlit-dd-opinion、expert-dd-transaction | `SK/due-diligence:16`；`references/dd-modules.md:4`、`finding-template.md:4` |
| intake-notes | lit-case-intake | `SK/intake-notes:16` |
| labor-dispute | lit-labor-dispute、expert-labor、expert-labor-employer、expert-labor-employee | `SK/labor-dispute:16`；`references/claim-checklist.md:4` |
| labor-arbitration-draft | lit-labor-dispute（只借结构）、lit-draft-defense（三层答辩顺序） | `SK/labor-arbitration-draft:17` |
| procedure-check | lit-analyze-jurisdiction、lit-analyze-limitation | `SK/procedure-check:16`；`references/procedure-rules.md:4` |

许可：`P/content/skills/THIRD_PARTY_LICENSES/README.md` 声明“方法骨架经改写后融入 6 个方法”，**漏了 labor-arbitration-draft**（P1-5）。上游脚本、数据和检索依赖一个都没引入。这符合项目口径：检索改成随包法规库 `law.*`，计算改成 `calc.*`。

### 1.3 智合 70 个 skill → 我们的方法（逐个对应）

关系分四种：**改写采纳**（声明了 lineage）、**自研同类**（没声明借鉴，但有同等功能）、**部分**（只覆盖一部分）、**无**。

| 智合 skill | 我们的方法或能力 | 关系 |
|---|---|---|
| core-audit-case-citation 案例援引审查 | citation-check 只核法条；案号离线一律“未核实”（`P/packages/kernel/src/services/artifact-citations.ts` 文件头注释） | 部分 |
| core-claim-evidence-audit 论证依据审查 | citation-check | 改写采纳 |
| core-verify-statute-validity 法条引用核验 | citation-check + `citations.verify` 工具 | 改写采纳 |
| util-legal-calculator 法律计算器 | amount-calc + `calc.interest/deadline/labor/court_fee` | 自研同类（确定性，更强） |
| zhihe-law-search 搜法 | `law.search/get_version/get_article` 随包法规库（37 部、4,017 条） | 自研同类（覆盖面窄） |
| zhihe-case-search 搜案 | 无案例库；只有联网检索 | 无 |
| lit-analyze-claim-basis 请求权基础 | issue-evidence-matrix、case-analysis | 自研同类 |
| lit-analyze-jurisdiction 管辖 | procedure-check | 改写采纳 |
| lit-analyze-limitation 时效 | procedure-check | 改写采纳 |
| lit-analyze-law-conflict 法律适用冲突 | legal-research-memo 能做，没有专门步骤 | 部分 |
| lit-analyze-judgment-divergence 裁判尺度 | 无（要案例库） | 无 |
| lit-assess-case-risk 争点与胜败评估 | case-analysis（`AG:15` 第 7 条不出胜诉率） | 自研同类 |
| lit-build-evidence-list 证据清单 | issue-evidence-matrix；各文书方法的证据目录 | 自研同类 |
| lit-build-timeline 事实时间轴 | casefile-organize + 事实时间线 | 自研同类 |
| lit-case-intake 接案研判 | intake-notes | 改写采纳 |
| lit-case-closing 结案交付与回访 | 无（只有事项生命周期界面 `MatterLifecycle.tsx`） | 无 |
| lit-cross-examination 质证意见 | cross-exam-opinion | 自研同类 |
| lit-draft-appeal 上诉与再审 | appeal-draft（再审“暂不支持”，`SK/pleading-draft:25`） | 部分 |
| lit-draft-argument 代理词与辩护词 | agency-statement（没有刑事辩护词） | 部分 |
| lit-draft-complaint 起诉状与仲裁申请 | pleading-draft + arbitration-application | 自研同类（缺四项前置门里的两项，P1-6） |
| lit-draft-defense 答辩状与反诉 | defense-draft（第 55 批加了反诉选项）；labor-arbitration-draft 借了结构 | 改写采纳（劳动）/ 自研同类 |
| lit-labor-dispute 劳动争议 | labor-dispute、labor-arbitration-draft | 改写采纳 |
| lit-plan-enforcement 执行方案与财产线索 | enforcement-application（申请书为主，没有执行方案） | 部分 |
| lit-prepare-hearing 庭审提纲 | hearing-outline | 自研同类 |
| lit-search-similar-cases 类案检索 | 无 | 无 |
| lit-counter-adverse-precedent 不利判例应对 | 无 | 无 |
| lit-extract-judicial-rules 裁判规则提炼 | 无 | 无 |
| lit-opponent-background 对手背景 | 无 | 无 |
| lit-shareholder-dispute 股东救济 | 无（corporate-resolutions 只做决议文件） | 无 |
| lit-administrative-remedy 行政救济 | 无 | 无 |
| lit-bankruptcy 破产 | 无 | 无 |
| lit-criminal-defense / lit-criminal-sentencing-calibration 刑事 | 无 | 无（2 个） |
| nonlit-review-contract 合同审查 | contract-review（审计 A 引用过它的输入要素清单） | 自研同类 |
| nonlit-transaction-documents 交易文件 | contract-draft | 改写采纳 |
| nonlit-due-diligence / nonlit-dd-opinion | due-diligence | 改写采纳（2 个） |
| nonlit-clause-benchmark 条款范本 | review-rules-draft + 本所覆盖层 | 部分 |
| nonlit-corporate-governance 公司治理 | corporate-resolutions | 部分 |
| nonlit-labor-compliance 劳动合规 | policy-review + labor-termination 卡 | 部分 |
| nonlit-litigation-response 应诉应急 | procedure-check（suit-received 卡） | 自研同类 |
| nonlit-new-business-review 新业务评估 | client-advice | 部分 |
| nonlit-compliance-obligation-matrix 合规义务矩阵 | 无 | 无 |
| nonlit-data-compliance 数据合规 | 无 | 无 |
| nonlit-regulatory-inspection 监管约谈应对 | 无 | 无 |
| nonlit-regulatory-penalty-scan / nonlit-admin-penalty-benchmark | 无 | 无（2 个） |
| nonlit-new-rule-tracking 新规追踪 | 无 | 无 |
| nonlit-ipo-review | 无 | 无 |
| 来华 7 项（assess-china-data、assess-china-investment-access、draft-china-contracts、orchestrate-china-business、plan-china-employment/entity/ip/tax-customs-fx 实为 8 个标识，其中 draft-china-contracts 也在此列） | 无 | 无（8 个） |
| util-anonymize 脱敏 | 客户版与对外脱敏（本机 s6）+ 全链路令牌化 | 自研同类（更强） |
| util-case-file-index 卷宗编目 | 整理案卷本机版 + casefile-organize | 自研同类 |
| util-contract-diff 版本比对 | redraft-review + 回稿比对（本机） | 自研同类 |
| util-docx-format 文书排版 | `docx.render_report` 引擎 + 交付前检查 | 自研同类 |
| util-research-memo 检索报告 | legal-research-memo | 自研同类 |
| util-plain-language 通俗化 | audience-pack（客户版）只做脱敏，不做通俗改写 | 部分 |
| util-engagement-proposal 工作方案与报价 | 无 | 无 |
| util-legal-translation 法律翻译 | 无 | 无 |
| util-bid-proposal、util-legal-training、util-diagram、util-enterprise-service-season、util-run-ciie-legal-demo | 无 | 无（5 个） |

合计（按上表逐行计，多标识行按个数计）：改写采纳 10 个、自研同类 16 个、部分 10 个、无 34 个，共 70 个。

反过来，我们有、智合没有的方法：tabular-review（多文档表格审阅）、doc-revise（原件修订稿）、contract-redline（修订说明与谈判要点）、demand-letter、preservation-application、case-report、closing-checklist、review-rules-draft（从范本整理要点）。

### 1.4 没接的里面，哪些对执业律师是高频刚需

判断依据：用户拍板的三条主线（诉讼、非诉、企业法务，不以央国企法务为主场景，见项目记忆“demo 主场景按律师业务线”）；10-21 调研 `02-产品全景与重构方案.md` §10（“受理、利益冲突核查、委托范围、费用与授权、客户沟通、结案交付、知识回收也需要进入主业务”）；审计 A 第五节。

| 智合 skill | 判断 | 理由 |
|---|---|---|
| lit-search-similar-cases + core-audit-case-citation + counter-adverse-precedent | **刚需，但卡在数据**：值得接 | 诉讼线每一份文书都要引案例。我们没有案例库，案号离线一律“未核实”，只能靠律师逐条勾选。不能只改方法正文解决。过渡办法：legal-research-memo 加“律师导入的裁判文书”分支，案号由文书全文回链 |
| lit-case-closing 结案交付 | **高频、成本低**：值得接 | 每个案子都要做；事项生命周期界面已经有“结案”状态（`MatterLifecycle.tsx`），缺一个方法和一张卡 |
| util-engagement-proposal 工作方案与报价 | **高频、成本低**：值得接 | 律所接案的第一份对外文件；接案访谈（intake-notes）之后的自然下一步 |
| lit-draft-appeal 的再审部分 | 中频：值得接 | 方法明说“暂不支持”（`SK/pleading-draft:25`、`SK/appeal-draft` 受限条款） |
| lit-shareholder-dispute | 中高频（商事所）：值得接 | 只有决议文件，没有股东知情权、回购、解散这些救济路径 |
| nonlit-regulatory-inspection + lit-administrative-remedy + penalty 两项 | 企业法务线中高频：值得接 | 合规问答能答，但没有“收到处罚告知书”这条应对流程（陈述申辩、听证期限按工作日算，10-21 调研 §9 第一行） |
| nonlit-data-compliance / compliance-obligation-matrix | 中频：以后再接 | 依赖法规库覆盖（现在 37 部） |
| util-legal-translation | 涉外所中频：以后再接 | 模型本身就能做，主要需要术语表 |
| util-plain-language | 中频：低成本吸收 | 做成 client-advice、case-report 的“客户版一页纸”附件即可，不必单独建方法 |
| 刑事 2 项 | 不接（本轮） | 不在三条主线内 |
| 来华 8 项、进博、服务季、普法培训、投标、结构图 | 不接 | 地域项目、活动或营销用途，或者是通用能力 |
| lit-bankruptcy、nonlit-ipo-review | 不接（本轮） | 低频专业，要专门的样本和评审 |
| lit-opponent-background、nonlit-new-rule-tracking | 不接 | 要工商数据或订阅源；新规追踪要联网订阅，属于结构性改动 |

---

## 二、方法正文怎么到达模型：用的是上游机制，参数这一段接了一半

### 2.1 实际链路（逐环节）
| 环节 | 实际做法 | 证据 |
|---|---|---|
| 分发 | `build-skills.mjs` 校验前言后，把每个方法目录（不含 `evals/`、`examples/`）复制到 `dist/trusted/skills/<id>/`，连同 `AGENTS.md`、许可目录一起逐文件摘要并签名 | `P/content/skills/build-skills.mjs:60-102` |
| 加载 | 内核验签后物化可信区；宿主把 `trusted/skills` 作为 **上游 `skillDirs`** 传进 kap-server，`AGENTS.md` 通过 `trustedInstructionsDir` 进系统提示（前面再拼一段受限命令行说明）；`agentFiles: []` | `P/packages/kap-host/src/matter-engine.ts:195-221` |
| 上游内置技能 | 关掉：`builtin_product_skills: false`、`merge_all_available_skills: false` | `P/packages/kap-host/src/engine-config.ts:82-83` |
| 发现 | 上游每轮把技能清单写进系统提示：`- name: 描述（截 250 字）`、`When to use: …`、`Path: …` | `KE:172478`、`KE:172621-172628` |
| 触发 | **不靠描述自动匹配**：场景卡发起时，内核在提示词里写死“先调用 Skill 工具加载方法模板‘X’”；自由描述时写“先用 Skill 工具在已安装的方法里选最贴近的”并点名 8 个 | `EX:1027`、`EX:1040-1041` |
| 正文进上下文 | 模型调 `Skill` 工具 → 上游 `renderSkillPrompt` 展开参数 → 以 `<skill-loaded name dir args>` 块注入（带 `dir` 属性，所以相对路径 `references/…` 能解析） | `KE:172508-172521`（`renderSkillPrompt`）与 `renderSkillLoadedBlock` |
| 附件 | `references/` **按需读**：方法正文写“见 `references/xxx.md`”，模型用 `Read` 读可信区（`Read` 为 T0 级，可信区属于工具可寻址区域） | `P/packages/kap-host/src/tool-table.ts:33,36,97`；`SK/contract-review:51` |
| 加载记录 | 宿主只在主 Agent 的 `Skill` 调用成功返回后，记一条“已按方法模板执行”里程碑（至多 8 个） | `P/packages/kap-host/src/progress.ts:141-160` |
| outputs 的用途 | 前言 `outputs` 第一项是主交付物：界面卡片的 `gets` 与它对照（契约用例），内核据此给提示词加“必须用 docx.render_report 生成《…》”，结束时核对有没有交出 Word | `EX:1015-1024`、`EX:2490`；`P/apps/desktop/test/b55-skill-contract.test.ts` |
| tools_required | 只在打包时校验工具存在、主交付物格式与工具相符，运行时不用 | `build-skills.mjs:64-71` |
| requires_outline | 契约用例按它挑出文书类方法，锁住 `outline.submit` 等步骤 | `P/packages/kernel/test/skills-contract.test.ts:28` |

结论：**没有把方法正文拼进系统提示或用户提示**，用的是上游原生 Skill 机制，`references/` 也是按需读。这部分接得对，开销也小。

### 2.2 “接了一半”的地方

**① 方法参数（P0-1）。** 上游的展开规则（`KE:172562-172585`）：
- 按前言 `arguments` 的顺序，把正文里的 `$name` 换成 `Skill` 工具 `args` 字符串按空白切开后的第 i 段；**没有第 i 段就换成空串**；
- `args` 的格式说明是“像命令行一样写，按空白切分”（`KE:236652-236660`）。

我们这边：
- 33 个方法前言都声明了 `arguments`，正文里共有 135 处 `$side`、`$mode`、`$focus`、`$received_on`、`$court` 等占位符（`grep -oh '\$[a-z_]\+' SK/*`）；
- 内核没有让模型传 `args`，只在提示词里写“方法参数：court=苏州市中级人民法院；preserve=…”（`EX:1015`、`EX:1027`）；
- V13 真实事件里，`Skill` 调用的描述都是“Invoke skill contract-draft”这种不带参数的写法（`research/2026-11-07-V13核心业务修复/成果样本/W1-V13/events.json` 等 9 份）。参数是否真的为空，事件里没有记录，**未直接核实**；
- 即使模型主动传了 `args`：值里有空格（中文长句、日期区间），或者模型按“k=v”顺序乱写，位置就会对错。

后果：`SK/pleading-draft:39` 的“受诉法院（`$court`）、管辖依据（`$forum_basis`）、财产保全（`$preserve`）……不再问”，到了模型那里是三对空括号。`SK/contract-draft:24` 的“方法参数 `$side` ……已写明的照用”变成“方法参数 ……已写明的照用”。第 55 批回归之所以没出问题，是因为同样的信息在任务说明里又写了一遍，模型靠那份对上了。卡片字段 ↔ 方法参数的契约用例（`b55-skill-contract`）只核对“键是否声明”，测不到“值有没有进正文”。

改法有两种，任选其一：
- (a) **内核预展开**：删掉正文里的 `$name`，改成“方法参数 court（受诉法院）”这种指名写法，值只走提示词里的“方法参数”一行。改 33 个 SKILL.md，不动上游。
- (b) **让 `args` 生效**：`methodPromptLine` 要求“调用 Skill 时 args 原样填：……”，并把值改成带引号的位置串。上游会用引号分组（`tokenizeArgs`），但模型照抄长中文值容易出错，**不建议**。

推荐 (a)。验证：契约用例加一条断言“任何 SKILL.md 正文不含 `$[a-z_]`”。再用上游 `expandSkillParameters` 的同一实现做快照（vendor 产物可以导入），模拟“不带 args 加载”，看展开后的正文不出现空括号。

**② 描述自动触发在“场景卡”里不起作用，只在自由描述时起作用。** 场景卡发起时由内核点名方法，这是故意设计（第 35 批 N3：靠模型自选会漏加载，`EX:1034-1037` 注释），合理。但自由描述靠清单里 250 字描述加 `when_to_use` 自选，`when_to_use` 合计 2,210 字，很多和描述重复（P2-1，没有逐个比对），**没有一个方法写反例**（例如“不用于……”只写在正文第 1 节）。上游清单里只显示描述和 `when_to_use`，正文第 1 节的“不适用”模型选方法时看不到。

**③ 法律问答（Chat）完全不经过方法。** `QaChatService` 只发 `QA_SYSTEM_PROMPT` 加历史（`P/packages/kernel/src/services/qa-chat.ts:237-243,550`），不起 kap-server 会话，所以既没有 `Skill`，也没有 `law.search`。法条是答完以后在本机核（界面显示“3 条引用在本机法规库核到”，`01-真实运行与回归记录.md` §5）。律师在问答里得不到“法规研究备忘录 / 合规问答”的方法质量，也没有一键转进事项的入口（`Chat.tsx:219` 只有一句话，`:288` 只在命中当事人时给链接）。这不算缺陷（问答是轻量形态），但律师体验上是断开的。

**④ 上游能力的启用状态（集成核查）。**
| 上游能力 | 状态 | 证据 |
|---|---|---|
| Skill（按需加载） | 启用，T0 | `tool-table.ts:36` |
| 计划模式 EnterPlanMode / ExitPlanMode | 启用；退出计划走业务审批卡；引擎权限固定 manual，禁止上游 auto 模式自动批准 | `tool-table.ts:52-53`；`engine-config.ts:79-80` |
| TodoList | 启用（UI 级）；`AG:20` 第 11 条要求和下一步工具调用同轮发出 | `tool-table.ts:54` |
| AskUserQuestion | 启用（UI 级），是论点确认与一次问清的载体 | `tool-table.ts:55` |
| NotifyUser | 启用；宿主截到 1,000 字、界面留 5 条 | `progress.ts:130-139` |
| Agent / AgentSwarm 子 Agent | 启用（T3），强制 K2.6，禁止 fork、禁止指定其他模型 | `policy.ts:325-350`；`engine-config.ts:107` |
| Tower* 多 Agent 协作、select_tools | 锁死 | `tool-table.ts:64-79` |
| Goal 系列 | T3，未见方法使用 | `tool-table.ts:47-50` |
| Bash | 执行域不可用时禁用 | `engine-config.ts:76` |
| WebSearch / FetchURL | T4/T5，走出站闸门 | `engine-config.ts:111-118` |
| 上游内置技能、项目 agentFiles | 关闭 / 为空 | `engine-config.ts:82-83`；`matter-engine.ts:217` |

“接了一半”的是**子 Agent**：放开了，但没有一个方法写它的用法。V13 九单真实事件里 `Agent` 调用为 0。

---

## 三、配置不合理：8 个方法抽查

估算口径：中文按 0.75 token/字，其他字符按 1/3.5 token，粗估，**未用 K3 分词器实测**。每单固定加载的部分有：工作准则 `AG` 约 8,366 字（约 5,100 token）、技能清单约 9,500 字、内核提示词【工作方式】【边界】约 1,100 字，再加上本次方法正文和按需读的参考文件。

| 方法（卡） | 正文字数 / 约 token | references 字数 | 第 3 节步骤数 | 第 4 节工具表 + 第 8 节降级（字） | 与 AG 或内核重复、矛盾、冗余之处 |
|---|---|---|---|---|---|
| pleading-draft 起诉状 | 10,533 / 6,037 | 2,337 | 7（第 2 节另有 6 项编号） | 1,012 + 554 | ①第 2 节第 4 项（`SK/pleading-draft:39`）一段 1,700 字，把“已填的不问”、取舍并进论点确认、专属管辖、专门管辖写在一起：前半段是 `AG:14` 第 6 条的复述，后半段（管辖判断）应当单列一小节；②`:38` 固定“调用 materials.list”，与【开工前已知】空事项规则冲突（P0-2）；③第 1 节“不能用 Excel 代替”（`:23`）与 `EX:1015-1024` 内核 `deliver` 句、`AG:13` 重复；④历史注释 620 字（“第 34 批真实走查……”等） |
| defense-draft 答辩状 | 9,036 / 5,204 | 0 | 6 | 797 + 533 | ①`:34` 第 1 步“调用 materials.list 找对方起诉状”，合理（必须找文书），保留；②第 1、7 节交付规则与 AG 重复 |
| contract-review 审合同 | 13,201 / 7,117 | 15,388（rubric、contract-types、firm-overlay 样例） | 8 | **3,139** + 411 | ①**矛盾**：`:25`“意见书首页必须写‘通用辅助审查 · 未经本所质量验收’”，对 `:126` 自检和 `AG:19` 第 10 条（P0-3）；②第 4 节工具表 3,139 字，是 8 个方法里最长的，多半是 `riskcards.submit` 字段说明，和工具自身的 schema 描述重复；③`:52` 的 `law.get_version` 一步可删（P1-1）；④参考文件 15k 字，按类型读一份就够，正文没写“只读与本合同类型对应的一节” |
| due-diligence 尽调 | 7,250 / 3,792 | 4,685 | **13** | 1,107 + 383 | 步骤数最多，但大部分是清单生成，没有冗余工具调用；`:41`、`:50` 两处按需读参考文件，写法对 |
| client-advice 法律意见书 / 合规问答 | 6,874 / 4,003 | 0 | 5 | 639 + 46 | ①历史注释 708 字，占 10%，是 8 个里比例最高的；②同一方法同时服务“意见书”和“合规问答”两张卡，问答卡的主交付物也是 Word。问答卡律师要的往往是一段答复：卡上写的是 Word，方法没有“简答档” |
| labor-arbitration-draft 劳动仲裁 | **14,681 / 8,459** | 0 | 9 | 1,323 + 647 | ①第 2 节输入与前置检查 **4,247 字**，最长，一半是申请书、答辩书两种文书各写一遍的“已知的不问”；②方法参数恰好 8 项（上限），第 55 批又加了 hired_on、left_on、leave_type、monthly_wage 四项，这些同样受 P0-1 影响，只靠任务说明对上 |
| legal-research-memo 法规检索 | 4,751 / 2,540 | 0 | 6 | 520 + 284 | `citations.verify` 提到 5 次（步骤里 2 次、工具表、自检、降级），步骤里写的是“逐条核验”，没写“汇总后一次批量核”（P1-1） |
| labor-dispute 劳动请求梳理 | 9,856 / 5,495 | 6,077 | 8 | 1,031 + 317 | 不写历史注释；第 3 节 29 行是 8 个里最长的步骤段，按请求项逐项算，合理 |

**可以删减或合并的具体段落**
1. **全部 33 个方法第 1 节的“主交付物必须出 / 不能用 Excel 代替”句**（如 `SK/pleading-draft:23`）：内核已按 `outputs` 第一项动态写进提示词（`EX:1015-1024`），删掉不丢信息。约省 100～250 字 × 20 个文书方法。
2. **第 4 节工具表的“失败时”列与第 8 节合并**：每个方法只保留一行“工具不可用时：按工作准则第 5 条末段降级”，个别有特殊处理的（如 `facts.list` 不可用照常起草）留一句。8 个方法合计可省约 4,000 字。
3. **历史注释**（括号里的“第 N 批真实走查：……”）移到各方法的 `evals/notes.md`（打包时 `evals/` 不进可信区，`build-skills.mjs:65`），正文只保留规则本身。起诉状、意见书、修改文书三个方法各省 600～700 字。
4. **`SK/pleading-draft:39` 拆成两项**：“已填的不问”只留一句并引用 `AG:14`；管辖判断单列为第 2 节第 4a 项。
5. **`SK/contract-review:25` 删掉“意见书首页必须写……”这一句**（P0-3）。
6. **`law.get_version` 从 29 个方法的步骤里删掉**，改成“`law.search` 找到条 → `law.get_article` 取原文（已按适用时点选版本）→ 成文前把全部引用一次交 `citations.verify`”。

**可由内核确定性完成、却让模型做的步骤**
- “先调 `materials.list` 看目录”：内核已经把材料快照写成 `materials/NNN-*.txt`，并且知道份数（`preflightOf`，`EX:1080-1097`）。目录本身（文件名、用途标签、识别质量）可以由内核直接写进【开工前已知】，省掉每单至少 1 次调用。空事项时更不该调。
- “逐条 `citations.verify`”：文书生成后，内核本来就离线核一遍引用（`artifact-citations.ts`），`docx.render_report` 的交付前检查也会报错误条号。方法里的核验只需要在成文前做一次批量核。
- “`facts.list` 读事实”：确认事实数内核已经算出来了；条数少时（例如 ≤ 30 条）可以直接把确认事实的陈述列进提示词，省掉 1 次调用。是否值得做，要看令牌化后的长度，**未核实**。

---

## 四、执行冗余：真实运行里的重复调用

数据源：`research/2026-11-07-V13核心业务修复/成果样本/*/events.json`（9 单真实 K3 任务的事件流，按 `agent.tool_started` 计数；本次用脚本统计）。第 55 批两单回归只有时长和步数（`01-真实运行与回归记录.md` §2、§6），没有逐工具的明细。

| 任务（方法） | law.get_article | law.search | law.get_version | citations.verify | TodoList | docx.edit_draft | 其他 |
|---|---|---|---|---|---|---|---|
| W1-V13 起草合同（contract-draft） | **17** | 8 | 0 | 2 | 7 | 12 | calc.deadline 5 |
| W1-基线 起草合同 | **25** | 5 | **8** | 0 | 5 | 8 | |
| W3-V13 审合同（contract-review） | **26** | 8 | 3 | 0 | 7 | — | riskcards.submit 4 |
| W4-V13 法律意见书（client-advice + amount-calc） | **28** | 9 | 5 | 2 | 8 | 11 | calc.deadline **16**、materials.read_excerpt 9 |
| W5-V13 整理案卷精读（casefile-organize） | 8 | 0 | 0 | 0 | 4 | — | **Read 44**、Bash 14、Edit 10 |
| W6-V13 自由描述起草合同 | 13 | 5 | 4 | 0 | 7 | **21** | |
| W2-V13 修改文书（doc-revise） | 4 | 2 | 2 | 0 | **10** | — | docx.revise 6 |

**规律与根因（对照方法正文）**
1. **`law.get_article` 每单 13～28 次，`citations.verify` 只有 0～2 次。** 根因：`AG:6` 第 2 条要求“判断某条是否支持论点时，用 `law.get_article` 取原文对照”，方法又按论点逐条写“定位—核验”（`SK/contract-review:52`）。所以模型是一条一条取原文，而不是攒齐了批量核。界面把它折叠成“查看条文原文 ×N”（`P/apps/desktop/src/lib/timeline.ts:121-126`），只是遮住了刷屏，调用并没有少。**改法**：①工具层加批量取条（`law.get_article` 接受 `articles[]`）；②方法写“同一部法的多条一次取”。①要改工具 schema（不是协议，但要改内核和签名工具清单），②只改方法正文。
2. **`law.get_version` 是多余的一步**：基线单里 8 次，V13 改了措辞以后还有 0～5 次。`law.get_article` 已经按同一规则选版本（`registry.ts:118`）。根因是 29 个方法的步骤里还写着 `law.get_version`。
3. **TodoList 4～10 次**：第 42 批（`AG:20` 第 11 条）之后，“只更新清单的往返”已经从 37 次降到 0～9 次（`research/2026-11-12-重新审视与第一档四项/00-实施与验证记录.md:16,121`），剩下的多数跟着别的调用一起发。不再是主要冗余。
4. **`docx.edit_draft` 11～21 次**：这是第 35 批要求“逐处改、不整份重出”的结果（`AG:13`），单次几秒，属于正常代价。W6 的 21 次里有一部分是交付前检查报一条改一条。工具本身支持一次多处（`docx.edit_draft` 的 `patches` 是数组，`registry.ts:512-536`），所以可以在 `AG:13` 写明“交付前检查或复核报的多处，合成一次 `docx.edit_draft`”。
5. **`calc.deadline` 16 次（W4）**：源自 `AG:11` 第 4 条“起算点或中断事由有几种可能的，每种各算一次”。这是有意为之，算口径不算冗余；可以加一个批量计算参数省往返。
6. **`Read` 44 次（W5 精读）**：模型逐个读 `materials/NNN-*.txt`，没有用子 Agent 分担，也没有用 Grep 先定位（`SK/casefile-organize` 第 3 节写的是“逐份读”）。是方法写法造成的。

---

## 五、交付质量不足：已有失败原因里与方法相关、至今未修的

数据源：V16 第一轮已知缺陷 15 条（`P/eval/grading/已知缺陷清单-V16第一轮.md`）、V18 回归 16 单评分（`research/2026-11-12-V18产品再审视/评分-V18回归/*.json`：14～23 分，满分 24，≥ 20 且各维 ≥ 2 为可交付）、V13 §1 根因表。逐条对照**当前**方法正文与内核。

| 失败原因（出处） | 与方法正文或 Skills 配置相关吗 | 现状（对照当前代码） |
|---|---|---|
| 成果首段带“通用辅助 · 未经本所质量验收”（V16 #13） | 是 | **未修干净**：`AG:19` 已禁止，29 个方法已改成“只写在最终答复末尾”，但 `SK/contract-review:25` 仍要求“意见书首页必须写”（P0-3） |
| 对外文书留【待确认】、律师提示（V16 #8） | 是 | 已修：`AG:13` 第 5 条 + 内核 `deliver` 句 + 各方法自检（如 `SK/pleading-draft:81`）+ 交付前检查 `deliverable-check.ts:410` |
| 方法要求写“事实编号”，只有 fct_（V16 #3） | 是 | 已修：`AG:19` 第 10 条“事实怎么引” |
| 能算的不算、期限只给一种口径（V16 #10） | 是 | 已修：`AG:9-11` 第 4 条三个子项 |
| 工具提示原样抄进交付件（V16 #9） | 是 | 已修：`AG:12` |
| 表格最多 5 张工作表、方法要 6 张（V16 #12） | 是 | 工具 schema 已经没有工作表数上限（`registry.ts:849-858` 的 `sheets` 数组不带 `maxItems`）；实现层是否还有上限**未核实** |
| 整理审核标准没有独立复核（V16 #15） | 部分（方法前言没有声明复核） | 未核实是否已修（属内核复核开关） |
| 方法参数没进正文 | 是（本文 P0-1） | **未修**，过去的评分没有单独归类过这一条：因为任务说明里另写了一遍，扣分没有暴露 |
| 合规问答 20 分，维度 4 被复核“必须改”带偏（V18 m47） | 部分（client-advice 一方法服务两卡） | 未修：方法里没有“复核意见与已答要点冲突时回材料核”的问答专项；`AG:13` 有一般规则 |
| 法规研究 20 分，复核“必须改”第 3 条未落实且说明失实（V18 m20：来源目录“事实对照”页残留“本事项的事实清单里没有这一序号”） | 部分（legal-research-memo 的来源目录要求写事实序号） | **未核实**是否已修：当前 `SK/legal-research-memo` 第 5 节仍要求出来源目录，没有找到“不在来源目录里写事实序号”的明文 |
| 强制执行 19 分（V18 m12） | 部分 | 第 55 批把履行期限届满日改成了必填，没有真实复跑 |
| 整理案卷精读 14 分（V18 m01：证据目录“证明目的”全空、页码“未知”、补证清单空） | **不是方法**：m01 是本机确定性流程 `s2.case_file` | 与 Skills 无关，不在本文范围 |

结论：与方法直接相关、明确至今没修的有 **2 条**（质量说明矛盾、参数占位符）；需要真实复跑才能下结论的有 3 条（m12、m20、m47 三卡）。

---

## 六、已有研究里“还没变成功能”的低成本条目（前 10 条）

筛选口径：只动方法正文、场景卡、界面文案，不改协议、不加迁移。已经落地的先剔除，逐条在代码里核对过：缺失条款告警（`ReviewWorkbench.tsx` 有 `"missing"`）、谈判梯度“用这一级”、条件列、表格“据此起草”、材料初判（`lib/material-triage.ts`）、跨文件审查、写作偏好、从范本整理要点、事项类型、论点确认、开工前收集（第 55 批）、顾问答复面向非法律人士（`SK/client-advice:41`）。

| # | 条目 | 出处 | 现状核实 | 落地位置 | 律师得到什么 |
|---|---|---|---|---|---|
| 1 | 起草前核对“主体适格、前置程序”（四项前置门的后两项） | 智合 `ZH/skills/litigation/lit-draft-complaint/SKILL.md` 工作流程第一步；审计 A §5 第 4 条 | `content/skills` 全量 grep“主体适格”“前置程序”零命中；起诉状只在成文后的核对清单里查管辖与时效（`SK/pleading-draft` 第 5 节） | `SK/pleading-draft`、`SK/arbitration-application` 第 3 节第 1 步前加第 0 步；论点提纲第一条写“程序前提” | 劳动争议直接起诉、主体错列这类“写得再好也白写”的情况，在论点确认时就暴露出来，而不是交付后才发现 |
| 2 | 根本前提缺失时给分支，不选一个往下写 | 智合 `dist-experts/诉讼文书专家.expert` EXPERT.md“信息缺失时的处置规则”；审计 A §5 第 3 条 | `AG` 只在时效抗辩一处写了“写明分支”（`AG:11`）；第 6 条（`AG:14`）只说“问” | `AG:14` 第 6 条末尾补一句：立场、程序阶段、文书种类这类根本前提缺失又没法问的（律师选了直接开始、不回答），按两个分支各写要点 | 律师不在电脑前时，任务不会选错方向白跑 15 分钟 |
| 3 | 问答答完后给“到事项里按方法深入”的入口 | Harvey Custom Agent Nudges（C1 #24，`research/2026-10-21-律师体验重构v9.4/评审-C1-竞品设计借鉴.md:72`）；本文 2.2③ | `Chat.tsx` 只有一句静态提示（`:219`），命中当事人时才给链接（`:288`）；没有方法推荐 | `P/apps/desktop/src/pages/Chat.tsx`：每条回答下给“用《法规研究备忘录》深入 / 起草《顾问答复》”两个按钮，打开事项选择后把问题预填进开始面板的 `question` 主栏（`scenarios.ts:1344` 的 `PRIMARY_FIELDS` 已经支持） | 问答到交付件一步衔接，不用重打一遍问题 |
| 4 | 执行方案：财产调查、限高与失信、追加被执行人 | 智合 `lit-plan-enforcement`“执行方案与财产线索” | `SK/enforcement-application` 只出申请书、计算表、核对清单（`:16`），“不联网查询财产”（`:25`），没有执行措施方案 | `SK/enforcement-application` 加可选附件《执行措施建议》（申请财产调查令、限制高消费、纳入失信、追加或变更被执行人的条件与所需材料），场景卡 `gets` 同步加上 | 申请书之外，律师拿到“立案后第一周做什么”的清单 |
| 5 | 结案交付与回访 | 智合 `lit-case-closing`；10-21 调研 `02-产品全景与重构方案.md` §10 | 没有对应方法和卡；事项生命周期界面有“结案”状态（`MatterLifecycle.tsx`） | 新方法 `SK/case-closing`（结案报告、文书归档清单、费用与期限尾项、回访要点）+ 诉讼线一张卡；可以复用 case-report 的结构 | 每个案子都要做，现在只能自由描述 |
| 6 | 接案后的工作方案与报价 | 智合 `util-engagement-proposal`；`02-…` §10（委托范围、费用与授权） | 没有对应方法；intake-notes 只出访谈纪要（`SK/intake-notes` outputs） | 新方法 `SK/engagement-proposal`（工作范围、阶段与节点、团队、收费方式选项、除外事项），作为 intake 两张卡的“下一步”（`NEXT_STEPS`） | 接案到报价不出产品；也是律所对外的第一份文件 |
| 7 | 收到行政处罚告知书的应对 | 智合 `nonlit-regulatory-inspection`、`lit-administrative-remedy`；10-21 调研 `02-…` §9 第一行（陈述申辩、听证按工作日算） | `scenarios.ts` grep“行政处罚”“听证”零命中 | 企业法务线新增一张卡，复用 `client-advice` + `procedure-check`：必填“送达日期”，字段“告知书类型”，goal 模板要求用 `calc.deadline`（rule = workday）算陈述申辩与听证期限 | 企业法务的高频突发事项；期限按工作日算错是硬伤 |
| 8 | 再审申请书 | 智合 `lit-draft-appeal`（上诉与再审） | `SK/appeal-draft:24` 写明再审申请不在范围内，`SK/pleading-draft:25` 让律师“暂不支持” | `SK/appeal-draft` 加 `mode: retrial` 分支（法定再审事由逐项对照、六个月期限用 `calc.deadline`），或新建 `SK/retrial-application`；加一张卡 | 二审败诉后的常见下一步，现在直接被拒 |
| 9 | 合规问答的简答档 | V18 m47 评分（`research/2026-11-12-V18产品再审视/评分-V18回归/m47-compliance-qa.md`：无落款、版式与问答不匹配）；本文第三题 client-advice 一行 | 合规问答卡和法律意见书共用一个方法，主交付物都是 Word 的《顾问答复》 | `scenarios.ts` 合规问答卡加单选“答复形式：一段话回复（可直接粘贴）/ 顾问答复（Word）”；`SK/client-advice` 加对应分支：一段话时主交付写在最终答复里，并出一份《依据核对表》 | 企业法务日常问答多数只要一段话，不要一份 Word |
| 10 | 先出首稿的快速档 | 智合 `ZH/conventions/expert-template.md:22-26`（超过十几分钟就拆快速版与深度版）；审计 A §5 第 5 条 | 全仓只有问答的等待提示（`lib/chat-wait.ts`）提到“快速”；文书方法都走完整链路（第 55 批起诉状 16 分钟） | 文书类卡在“更多选项”加“先出首稿（不出附件、不等独立复核）”；方法第 3 节加分支。**独立复核要跳过，得改内核复核开关**，那部分不算低成本 | 只有口头案情时，几分钟内先拿到可讨论的稿子 |

---

## 七、场景卡的真实模型覆盖

### 7.1 事实
- 48 张卡都在验收卡集里（`P/eval/cards/cards16.json`：60 条，49 个不同 id = 48 张卡 + `free`）。V16 第二轮按这套卡跑了 57 单（`research/2026-11-12-重新审视与第一档四项/00-实施与验证记录.md:56`），V14 跑了 47 张卡的预验收（项目记忆“14 过 33 未过”）。所以**按卡集推断，48 张卡在第 41～42 批时都至少用真实模型跑过一次**。逐卡运行记录没有一张张核对，这一点**未核实**。
- V18 回归跑了 15 张（m01、m04、m06、m08、m12、m17、m20、m24、m27、m28、m30、m36、m38、m40、m47，`评分-V18回归/`）。
- **第 55 批改了 26 张卡的字段（其中 4 个日期改成必填）、8 张卡加了案情入口，33 个方法正文都改了措辞并重新签名**（V29 §4.3、§4.5）。改完以后用真实模型跑过的只有 3 张：起诉状、律师函（诉讼线）、劳动仲裁申请书（`01-真实运行与回归记录.md` §2、§6）。
- 所以“当前代码下没有真实跑过”的卡是 **45 张**。

### 7.2 本轮必须真实验收的 12 张（按业务优先级）
排序依据：①第 55 批改了必填项或案情入口（行为变化最大）；②三条主线里的高频卡；③V18 时得分低或没跑过；④覆盖本文 P0（参数占位符、材料目录矛盾、质量说明矛盾）。

| 序 | 卡 id | 为什么必须跑 | 本轮重点看什么 |
|---|---|---|---|
| 1 | contract-review 审合同 | 最高频；P0-3 质量说明矛盾就在这个方法里；第 55 批加了交易背景、文本提供方两个字段 | 意见书首页有没有那句质量说明；交易背景有没有影响意见的力度；`law.get_article` 调了几次 |
| 2 | defense 起草答辩状 | 收到日期改成了必填，加了程序抗辩多选 | 答辩期、管辖异议期是否按收到日期算；选了的抗辩是否落实 |
| 3 | appeal 起草上诉状 | 送达日改必填，加了不服判项、上诉请求；V18 22 分 | 上诉期；“部分判项”能不能免掉中途那一问 |
| 4 | arbitration-app 仲裁申请书 | 加了案情入口和逐项请求，**从没有真实跑过案情入口** | 空事项 + 案情的路径；有没有先查空的材料目录（P0-2） |
| 5 | amount 金额测算 | 首页推荐默认组合里的卡；加了案情入口（本金、日期） | 只写本金和日期时能不能直接出《计算明细》 |
| 6 | legal-opinion 法律意见书 | 加了“用途”；V13 W4 撞了时限（`calc.deadline` 16 次、`law.get_article` 28 次） | 时长和法条工具次数 |
| 7 | enforcement 强制执行申请 | 履行期限届满日改必填；V18 19 分，是 V18 里最低的方法卡 | 申请执行时效的计算；扣分项有没有复现 |
| 8 | labor-response 劳动仲裁应对 | 收到日期改必填，加了劳动要素包 | `calc.labor` 是否按面板上的四项计算 |
| 9 | case-analysis 案情分析 | `minMaterials` 由 1 改 0，加了案情入口 | 没有材料时能不能交出策略，而不是只问问题 |
| 10 | compliance-qa 合规问答 | 背景改成长文字；V18 20 分（复核把答复带偏） | 复核意见与问题要点冲突时怎么处理 |
| 11 | agency 代理词 | 加了庭审要点（无笔录时）和提交期限 | 没有笔录时事实出处怎么写 |
| 12 | contract-draft 起草合同 | 加了争议解决；`$side` 占位符被吃掉的典型（P0-1） | 事项有立场时还会不会再问立场 |

备选（不进 12 张）：intake-lit / intake（加了案情入口）、dd-findings（加了行业和关注重点）、research-lit（V18 m20 复核未落实）。

跑法沿用项目规矩：全新发起，不用“重新运行”；先跑 3～4 张评过分再铺开，并发 ≤ 4。

---

## 建议本轮实施的改动清单

工作量按“熟悉代码的一个人”估，单位小时；改了 SKILL.md 或 AGENTS.md 的都要重新 `build:skills` 签名打包，并跑 `skills-*`、`b55-*` 用例（已计入）。

| # | 优先级 | 改什么文件 | 怎么改 | 验证方式 | 工时 |
|---|---|---|---|---|---|
| 1 | P0 | 33 个 `SK/*`；`P/apps/desktop/test/b55-skill-contract.test.ts` | 去掉正文里全部 `$name` 占位符（135 处），改成指名写法“方法参数 court（受诉法院）”；前言 `arguments` 保留，作为契约声明 | 新断言：任何 SKILL.md 正文不含 `/\$[a-z_]+/`；用 vendor 的 `expandSkillParameters` 模拟空 args 加载，做正文快照，不出现“（``）” | 5 |
| 2 | P0 | `EX:1104`（`agentGoalPrompt` 的【工作方式】） | “先用 materials.list 查看材料目录”改成有条件的：本次指定材料 > 0 或事项有材料时才写；空事项时不写这句 | `b55-preflight` 加两条断言：空事项提示词里没有“先用法律工具 materials.list”，有材料时仍然有 | 1 |
| 3 | P0 | `SK/contract-review:25` | 删掉“意见书首页必须写‘通用辅助审查 · 未经本所质量验收’”，改成与其他方法一致的写法（只写在最终答复末尾） | grep 全部 SKILL.md 与 references，没有“首页必须写”“必须写.*质量验收”；`deliverable-check` 用例照旧通过 | 0.5 |
| 4 | P1 | 29 个 `SK/*` 的步骤与工具表；`AG:6` 第 2 条 | 删掉 `law.get_version` 步骤；写成“`law.search` → 同一部法的多条一起 `law.get_article` → 成文前全部引用一次 `citations.verify`（数组）” | 契约用例继续要求 7 个文书方法有 `citations.verify` 步骤（不能删）；真实单统计 `law.get_version` 应为 0，`law.get_article` 应少于改前 | 3 |
| 5 | P1 | `AG:13` 第 5 条 | 补一句：交付前检查或复核报的多处，合成一次 `docx.edit_draft`（patches 数组）/ `xlsx.edit_cells` | 真实单统计 `docx.edit_draft` 次数 | 0.5 |
| 6 | P1 | 33 个 `SK/*` 第 4、8 节 | 工具表删掉“失败时”列，第 8 节只保留与工作准则不同的特殊降级（如 `facts.list` 不可用照常起草） | 契约用例照旧通过；正文平均约减 600 字 | 4 |
| 7 | P1 | 约 20 个文书方法第 1 节 | 删掉与内核 `deliver` 句重复的“不能用 Excel 代替文书”说明 | 同上 | 1 |
| 8 | P1 | `P/content/skills/THIRD_PARTY_LICENSES/README.md` | “6 个方法”改成 7 个，加上 labor-arbitration-draft | 用例：`source_lineage` 里出现 `upstream:legal-agent-skills` 的方法都在 README 里列出 | 0.5 |
| 9 | P1 | `SK/pleading-draft`、`SK/arbitration-application` 第 3 节 | 第 1 步前加“程序前提”：主体适格、前置程序（劳动争议须先仲裁、复议前置等），不满足的写进论点提纲第一条，在论点确认时一起问 | 契约用例加断言：两个方法正文含“主体适格”“前置程序”；真实跑一单“劳动争议误选起诉状” | 1.5 |
| 10 | P1 | `AG:14` 第 6 条 | 补“根本前提缺失又问不到时按分支写”（第六题第 2 条） | 文本断言 | 0.5 |
| 11 | P1 | `P/apps/desktop/src/pages/Chat.tsx` | 回答下加“用《法规研究备忘录》深入 / 起草《顾问答复》”，把问题预填进 `question` 主栏 | 前端单测：点按钮后开始面板的 `question` 已经填好；截图 | 3 |
| 12 | P1 | `scenarios.ts` 合规问答卡；`SK/client-advice` | 加“答复形式”单选与简答分支（第六题第 9 条） | `b55-ui` 字段 ≤ 6 的约束；真实跑 compliance-qa | 2.5 |
| 13 | P2 | 起诉状、意见书、修改文书等方法 | 历史注释移到 `evals/notes.md`（不进可信区） | 打包后可信区正文 grep“第 [0-9]+ 批真实走查”的命中数下降 | 3 |
| 14 | P2 | `SK/enforcement-application` + 卡 `gets` | 加附件《执行措施建议》 | 契约用例 `gets` ↔ `outputs` | 2 |
| 15 | P2 | `SK/casefile-organize`、`SK/due-diligence` | 材料超过 N 份时可以用子 Agent 分份精读（K2.6），主 Agent 汇总 | 真实单：`Read` 次数与时长；子 Agent 有没有越过材料范围 | 3（风险：子 Agent 质量要先评） |
| 16 | — | 第七题列的 12 张卡 | 第 1～5 项改完后，全新发起真实验收 | 评分 ≥ 20 且各维 ≥ 2；统计法条工具次数与第一次打断时间 | 12 张 × 约 0.5 小时人工 + 等待 |

第 1～8 项合计约 15.5 小时，只动方法正文、工作准则和一句内核提示词，不动协议和迁移，建议先做。新增方法（结案、报价、再审、行政处罚应对，第六题第 5～8 条）每个约 4～6 小时，含卡片和契约用例，放下一轮。

---

## 没核实到的

- **`Skill` 调用到底有没有带 `args`**：事件里只有“Invoke skill X”这样的描述，没有 args 原文。参数被替换成空串，是根据上游 `expandSkillParameters` 的代码推出来的，没有抓过真实注入的 `<skill-loaded>` 块。验证办法：在宿主的 `tool.call` 事件里记下 `args` 长度（不记内容），跑一单看。
- token 数是按字符粗估的，没有用 K3 分词器实测；上游提示词缓存命中率也没算。
- 48 张卡在 V14/V16 是否**每一张**都有真实运行：只按卡集和 57 单的总数推断，没有逐卡对账本。
- `xlsx.render_table` 实现层的工作表上限；V18 m20（来源目录残留事实序号）是否已修。
- 智合 34 个专家工作流只看了目录；结论都基于 70 个 skill 的目录、名称和 10-21 调研的核验清单，`expert-*` 的正文没有逐个读。
- 第 55 批两单回归只有时长和步数，没有逐工具明细，所以第四题的冗余统计用的是 V13（11-07）的 9 单。此后第 35～55 批方法措辞改过多轮，次数会有出入。
- 没有运行任何用例或应用。
