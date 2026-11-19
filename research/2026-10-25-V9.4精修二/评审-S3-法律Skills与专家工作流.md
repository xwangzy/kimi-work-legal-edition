# 评审 S3 · 法律 Skills 与专家工作流（V9.4 精修二）

> 日期：2026-10-25 ｜ 对象：`.claude/worktrees/v95-polish/platform/`（分支 v9.4-b27，HEAD `1b81d63`）｜ 身份：独立评审兼实施（执业律师 + LegalTech 产品 + Agent/Skills 架构）
> 路径写法：代码路径相对 `platform/`；智合材料相对 `research/2026-10-23-智合AI再次核验/`。
> 边界：没有真实模型额度，方法从未被真实 K3 执行；本文评正文、工具契约与法律前提，不对法律产出质量下结论。不重复 S1、S2 已提出并已落实的事。

## 0. 范围与证据口径

**范围**：31 个既有方法与 `content/skills/AGENTS.md`、场景卡（`apps/desktop/src/lib/scenarios.ts`，只读）、工具契约（`packages/kernel/src/tools/registry.ts`、`packages/domain/src/legal-tool-names.ts`，只读）；开源仓库 Decikingship/legal-agent-skills；Kimi Code 本机副本的技能加载代码。新增方法 1 个（`labor-arbitration-draft`，方法总数 31 → 32）。

**核到官方原文的**（逐条摘录见 §5）：
- 《劳动争议调解仲裁法》：国家法律法规数据库 flk.npc.gov.cn 官方 docx（`/law-search/download/pc?bbbs=2c909fdd678bf17901678bf64f28039d&format=docx`）。
- 《最高人民法院关于审理劳动争议案件适用法律问题的解释（一）》（法释〔2020〕26 号）：flk 官方 docx（bbbs=ff80808177e75f88017800739d621b12）。
- 《劳动人事争议仲裁办案规则》（人力资源社会保障部令第 33 号，2017-07-01 施行）：中国政府网国家规章库 https://www.gov.cn/zhengce/2022-08/31/content_5711323.htm （页面注“来源：人力资源社会保障部网站”；flk 不收部门规章）。
- 《劳动争议解释（二）》（法释〔2025〕12 号）第十三至十五条、《公司法》（2023 修订）第一百八十四条：读的是 10-23 核验存档的官网页面文本（最高人民法院 https://www.court.gov.cn/zixun/xiangqing/472691.html 、市场监管总局 https://www.samr.gov.cn/xyjgs/flfg/art/2024/art_d4e84936a8a744f8928ac7aec7594345.html ，存档 sha256 见 `法律前提证据/证据访问索引.json`），本轮没有重新联网取。

**没核到、未写进正文的（待核）**：《劳动合同法》各条（第三十九、四十、四十四、四十六、四十七、八十二、八十七条等）与《劳动合同法实施条例》第二十五条——新方法凡涉及互斥与计算口径都转引 `labor-dispute` 现有写法或交 `calc.labor`，没有新写条号；劳动争议解释（一）关于法院管辖的条文；《劳动人事争议仲裁办案规则》2017 年后是否另有修订（国家规章库页面只有 33 号令文本，未见修订记录）；各地仲裁委办案指引。

**证据口径**：没有真实模型额度，所有改动只保证“正文规则与官方原文一致、工具名与参数与契约一致、整链黄金路径走得通”；法律产出质量未评。用例结果见 §3。另说明两点操作：①为定位令牌化误认的句子，曾在 `packages/kernel/test/` 下临时放过两个 `zz-tmp-*.ts` 脚本，跑完即删，未留下；②核对改动范围时执行过一次只读的 `git status --short`（任务要求不执行任何 git 命令，这里如实记录；没有执行 add、commit、stash、checkout）。工作区里 `apps/desktop/src/lib/reminders.ts`、`timeline.ts`、`packages/kernel/src/api/index.ts`、两个 `v94-b27.test.ts` 的改动不是本轮所改。

## 1. 开源 legal-agent-skills 对照与吸收清单

### 1.1 仓库现状与许可证

- 仓库：https://github.com/Decikingship/legal-agent-skills ，`main` 树 sha `83df6b13`（GitHub API `git/trees/main?recursive=1`，1,163 个条目），最后推送 2026-10-14；与本仓库方法 `source_lineage` 记的 `legal-agent-skills@83df6b13` 是同一版，S1 之后上游没有新提交。
- **许可证 MIT**（GitHub API `license.spdx_id = MIT`；研究目录 `license.txt` 同文，“Copyright (c) 2026 John He (Decikingship)”）。MIT 允许复制、修改、再分发文字，条件是随分发保留版权与许可声明。本仓库 `content/skills/THIRD_PARTY_LICENSES/legal-agent-skills-LICENSE` 已随签名包分发，满足条件。**本轮仍只吸收结构与做法、不搬原文**：上游正文绑定智合搜法搜案接口（`lawId` 链接、`zhiexa.com`）、用表情符号分级，且有与我们产品原则冲突的写法（见 1.3 末段“不吸收”），整段搬过来反而要改。
- 结构：`skills/`（按 core / litigation / nonlitigation / util 分组，60 个技能，每个 `SKILL.md` + `evals/evals.json`，部分带 `scripts/*.py` 确定性计算与 `references/`）；`experts/`（33 个专家工作流 `EXPERT.md`，frontmatter 列封闭的技能清单）；`conventions/`（技能模板、专家模板、输出格式、检索契约、时间效力、命名）；`dist/` 与 `dist-experts/` 是打包产物。

### 1.2 它的四个骨架

| 方面 | 上游做法（文件） | 我们的现状 |
|---|---|---|
| 任务拆解 | 技能模板强制十节：适用 / 不适用（表格指向兄弟技能）/ 输入要素（必需、可选、追问话术）/ 依赖 / 工作流程 4–7 步 / 检索策略 / 输出模板 / 强制校验项 / 边界与降级 / 示例（`conventions/skill-template.md`）；专家把多个技能编成阶段，“门禁”放最后（`conventions/expert-template.md`） | 八节（适用、输入与前置检查、步骤、工具约定、输出规格、质量自检、禁止、降级），比上游多“工具调用约定”与“禁止事项”，少“示例”与“不适用 → 改用”的统一表 |
| 工具调用 | 计算放 `scripts/*.py`（如 `lit-labor-dispute/scripts/labor_claims.py`），检索走智合 API 并有 26KB 的检索契约 | 计算与期限走内核确定性工具（`calc.*`），法规走本机库（`law.*`、`citations.verify`），文书走 `docx.render_report` 并受论点确认闸门约束——比上游硬 |
| 质量控制 | 每个技能“强制校验项”清单；专家层三道门禁（法条效力、案例真实性、结论—依据一致）；`evals.json` 每技能 2–4 条，分“典型 / 要素缺失 / 边界陷阱” | 每个方法有“质量自检”，复核页逐条给律师核对；契约用例只验工具链，没有法律质量样本（P4） |
| 输出规范 | 统一元信息块与结尾“核查说明”（检索痕迹、效力待复核数、未覆盖、需律师确认）；确定性三档【明确】【通说】【争议】；风险三级；时间效力“双轨 + 差异影响”，禁止新旧条号换算（`conventions/output-formats.md`、`conventions/time-effect.md`） | 有草稿标识、事实三分、核验四态；**没有**确定性分档、没有统一的结尾交接块、没有“禁止条号换算”与“差异对本案的影响” |

### 1.3 吸收清单（7 项，逐条映射）

| # | 上游做法 | 映射到我们 | 本轮处理 |
|---|---|---|---|
| A1 | 结尾“核查说明”是交接说明不是免责声明：写清检索与读取痕迹、哪些没覆盖、哪些需律师确认 | `content/skills/AGENTS.md` 新增第 9 条“回报先写完成范围”（与 S2-20 合并：收到 / 读了 / 读不出 / 排除，哪些结论被哪个缺口阻断，其余照常完成） | 已改 |
| A2 | 确定性三档【明确】【通说】【争议】，禁止把争议写成明确的语气 | `legal-research-memo` §3 第 4 步与 §5“结论”；`client-advice` 已有“存在不确定性”一档，暂不改 | 已改（研究备忘录） |
| A3 | 时间效力：禁止凭记忆做新旧条号换算；跨修订节点写“差异对本案的影响” | `legal-research-memo` §3 第 2 步与自检；`citation-check` §3 第 3 步 | 已改 |
| A4 | “不适用 → 应改用”表，防止兄弟技能抢活 | 新方法 `labor-arbitration-draft` §1（商事仲裁 → arbitration-application；只梳理请求不起草 → labor-dispute；诉讼阶段 → pleading-draft / defense-draft） | 已用于新方法；其余方法已有散写的“转 xxx”，不统一改 |
| A5 | 答辩“三层顺序”：程序抗辩 → 事实 → 法律 | 新方法答辩书结构（受理范围 / 主体 / 时效 / 管辖 → 逐项事实 → 法律）；`defense-draft` 现按请求逐项写，未统一三层，只报告（S3-12） | 已用于新方法 |
| A6 | 劳动者实务提示：签“协商解除 / 自愿离职”前先评估；证据趁在职固定；裁决后补提漏项受阻，一次提全 | 新方法 §3（申请书请求一次提全、加班证据申请仲裁庭责令单位提供）与 §7 禁止诱导签自愿离职 | 已用于新方法 |
| A7 | 每个技能 2–4 条评测样本，三类：典型 / 要素缺失 / 边界陷阱 | 真实模型评测（P4）的首批样本；新方法的样本写在本文 §4 末尾，不放进方法包（构建会剔除 `evals/`） | 仅报告 |

**不吸收**：专家层“信息缺失时按最保守的假设处理——期限按最短、立场按最不利、金额按最低”（`experts/expert-labor-employee/EXPERT.md`）与我们“关键事实缺失不按最不利假设补齐、分支写”的原则相反，S2 已明确保留我们的写法；“推销式 description、穷举口语触发词”受我们构建的 250 字上限约束，方法匹配又靠卡片，收益小；表情符号风险分级、搜法链接格式不适用。

### 1.4 Kimi Code 加载方式核对

本机副本 `platform/third_party/kimi-code`（472192c34，2026-10-14）`packages/agent-core-v2/src/features/skill/catalog/parser.ts`：目录型技能只认 `SKILL.md`，frontmatter 必须有 `name`、`description`；`when_to_use`（或 `when-to-use`）映射为 `whenToUse`；`arguments` 接受数组或空格分隔字符串；其余键（我们的 `kwl:`）原样留在 metadata、不影响加载。`registry.ts` 第 148–171 行把正文里的 `$参数名` 按声明顺序替换，`$ARGUMENTS` 替换为原始参数串，未声明的 `$xxx` 原样保留。**与 `content/skills` 的格式一致**；程序化检查 31 个方法正文里用到的 `$变量` 全部已在 `arguments` 声明（仅 `legal-research-memo` 声明了 `question` 但正文没用 `$question`，无害）。

## 2. 发现表

级：P0 法律前提错误会误导 / P1 高频场景缺分支、缺字段 / P2 精致度 / P3 需新增内核对象或工具 / P4 外部条件。“办案规则”指人社部令第 33 号；条文出处 URL 见 §0、§5。

| 编号 | 方法/卡 | 问题与对律师的影响 | 依据 | 改法 | 级 | 成本 | 验收 | 状态 |
|---|---|---|---|---|---|---|---|---|
| S3-01 | procedure-check（S2-03 新写的劳动仲裁一支）；labor-dispute `references/procedure-paths.md` | 劳动仲裁答辩期写“十日”，期间表给 `calc.deadline`（unit = day）。办案规则明定“十日”是**工作日**。实测同一收到日 2026-09-28：按自然日 2026-10-08，按工作日 2026-10-16，差 8 天。律师照自然日判断，会把仍在期内的**管辖异议、反申请**当成已过而放弃（两者都以答辩期满为限） | 办案规则第八十条“‘三日’、‘五日’、‘十日’指工作日，‘十五日’、‘四十五日’指自然日”；第三十三条；调解仲裁法第三十条第二款 | 两处改为十个工作日、`calc.deadline` 用 rule = workday；期间表补管辖异议、反申请、增加变更请求三行，开庭通知行注明工作日 | P0 | 小 | 三个用例通过；新用例用同一参数形状调期间工具，断言不早于 2026-10-12 | 已改 |
| S3-02 | labor-dispute `procedure-paths.md` | 漏写三条劳动仲裁程序节点：管辖异议须在答辩期满前书面提出（逾期不影响程序）；反申请在答辩期间提出、期满后的另行申请；申请人增加或变更请求须在举证期限届满前、届满后另行申请。用人单位律师不知道反申请截止，劳动者律师在庭前才补请求会被要求另案 | 办案规则第十条、第三十六条、第四十四条 | 期间表新增三行 | P1 | 小 | 同上 | 已改 |
| S3-03 | labor-dispute `procedure-paths.md` | 终局裁决“十二个月最低工资”按单项还是合计写的是“条号待核”。按单项判断直接影响请求怎么列：合并成总额会让终局与非终局分不清 | 办案规则第五十条（单项、经济补偿与赔偿金的范围、分别制作裁决书）；劳动争议解释（一）第十八至二十条 | 写明按单项及范围；新方法要求申请书逐项单列金额 | P1 | 小 | 同上 | 已改 |
| S3-04 | 体系（S2-19） | 没有方法起草劳动仲裁申请书 / 答辩书——劳动者律师与企业法务最高频的文书之一 | 产品原则“没有方法的业务不挂到相近方法上” | 新增 `labor-arbitration-draft`（结构见 §3、卡规格见 §4）；`labor-dispute`、`procedure-check` 回报末尾提示改用 | P1 | 中 | 契约整链 + 专项用例 + 方法数 32 | 已改 |
| S3-05 | AGENTS.md（S2-20、S2-21） | 可信区准则工具列表停留在 `law.search`、`calc.interest`，缺 `law.get_article`、`calc.deadline`、`calc.labor`、`calc.court_fee`；没有统一的“完成范围”回报行，缺口会被模型当成整件停工或被假设补齐 | 工具清单 `LEGAL_MCP_TOOLS`；智合 `子研究-业务与提示词质量.md` §6.1；上游 `conventions/output-formats.md` “核查说明” | 第 2 条补取原文规则；第 4 条补三个计算工具与“没有工具才用命令行并标未经复算”；新增第 9 条“回报先写完成范围” | P2 | 小 | 令牌化用例通过 | 已改 |
| S3-06 | due-diligence（S2-22） | 尽调量化一律用命令行 Python，利息、员工补偿、期限有确定性工具不先用 | AGENTS.md 第 4 条；`calc.*` 契约 | 改为先用 `calc.interest` / `calc.labor` / `calc.deadline`，无工具的才用命令行并标“未经金额工具复算”；工具表补两行 | P2 | 小 | 契约用例通过 | 已改 |
| S3-07 | amount-calc（S2-23、S2-16） | 只能算我方金额，答辩、执行、劳动应对常要复核对方计算；“诉讼费用预估”没写怎么问、劳动仲裁阶段会被误算费用 | 智合 W02“原数与复算并列，不倒算参数、不改诉请”；调解仲裁法第五十三条（劳动争议仲裁不收费） | 加参数 `mode`（我方测算 / 复核对方计算）与第 8 步、工作表“对方计算复核”；第 2 节第 6 项写诉讼费用要问的口径，明确劳动仲裁不收费；自检两条 | P2 | 中 | 契约用例通过 | 已改 |
| S3-08 | contract-review `references/contract-types.md`（S2-24） | 股权转让里出让方兼任员工或董监高时，交易竞业、劳动竞业限制、法定竞业禁止三套规则会被一笔补偿、一个期限混用 | 劳动争议解释（二）第十三、十四、十五条；公司法第一百八十四条 | 受让方立场第 6 条写三套分开核；第七节劳动竞业补在职期间竞业与违约返还 | P2 | 小 | 令牌化用例通过 | 已改 |
| S3-09 | legal-research-memo；citation-check | 只要求“有差异处写明”，没要求写差异对本问题的影响；没禁止凭记忆换算新旧条号；结论没有确定性分档，争议问题容易写成定论 | 上游 `conventions/time-effect.md`、`output-formats.md` | 研究备忘录第 2 步加“差异影响”与禁止换算，第 4 步加三档（明确 / 有不同理解 / 待律师判断，不写本机资料撑不起的“通说”）；引用核查第 3 步加禁止换算、不把旧法期间的旧法引用判为废止 | P2 | 小 | 用例通过 | 已改 |
| S3-10 | pleading-draft | 核对清单写“诉讼费由律师核算”，`calc.court_fee` 已上线却没用；立案时最先被问的就是预交多少 | `calc.court_fee` 契约 | `tools_optional` 加 `calc.court_fee`，核对清单写预估受理费与减半由律师确认，工具表加一行 | P2 | 小 | 契约用例通过 | 已改 |
| S3-11 | defense-draft | 答辩要点要求“标【建议用金额测算复核】”，但没有可接的复核模式 | S3-07 | 指向 amount-calc 的复核模式，补“不改写对方请求” | P2 | 小 | 用例通过 | 已改 |
| S3-12 | defense-draft | 答辩按请求逐项写，没有“程序 → 事实 → 法律”的统一顺序；程序抗辩（管辖、主体、时效）散在核对清单里，答辩状正文可能先写实体 | 上游 `lit-draft-defense` 三层顺序；民诉法第一百三十条第二款（应诉答辩视为接受管辖，S2 已核） | 建议下次改 §5 答辩状 sections 为三层，程序抗辩先写；本轮新方法已采用 | P2 | 小 | — | 仅报告 |
| S3-13 | cross-exam-opinion；demand-letter | 质证意见提交法院、律师函对外发出，都有论点与依据，却没有 `requires_outline`，可以不经律师确认论点直接成文；与起诉状、答辩状、代理词口径不一 | 第 19 批论点确认规则（文书类须先确认论点） | 产品决定：若确认属于文书类，两方法加 `requires_outline: true` 与第 3 节“起草前确认论点”一步（契约用例会自动按文书路径跑） | P2 | 小 | 契约用例 | 仅报告 |
| S3-14 | 卡 ↔ 方法参数（全体） | 有方法的卡中，27 张有字段键不在方法 `arguments` 里（如合同审查的 `type`、答辩状与上诉状的 `domicile`、上诉状的 `ruling`、强制执行的 `due_on`、劳动应对的 `received_on`），另有 9 张卡没给方法声明的参数（其中 `amount.mode` 是本轮新增）。`skillArgsOf` 会把所有小写键都当方法参数传给模型，所以信息能到；但违背 V9.4 §4.2“卡字段键必须是方法声明的参数名”，Kimi Code 的 `$参数` 替换也只认声明过的 | `scenarios.ts` `skillArgsOf`；Kimi Code `registry.ts` 第 148 行；对照清单见 §4.3 | 二选一由主会话定：①方法补声明影响判断的键（`type`、`domicile`、`ruling`、`due_on`、`received_on`、`side`、`proof_deadline`、`amount`）；②§4.2 规则收窄为“卡上固定的 `args` 与方法同名”，自由说明字段（`extra`、`situation`、`background`）另列 | P2 | 小～中 | 卡用例 | 仅报告 |
| S3-15 | 卡 `labor-apply` | 卡承诺交付“仲裁申请要点.docx”，方法实际产出《劳动争议应对方案》.docx；律师在交付件里找不到卡上说的文件 | `labor-dispute` `outputs` | 卡 `gets` 改为“劳动争议应对方案.docx”；`NEXT_STEPS` 接新卡“劳动仲裁申请书” | P2 | 小 | 卡用例 | 仅报告 |
| S3-16 | 卡 `amount` | 没有 `mode` 字段，复核对方计算的模式点不到；“诉讼费用预估”仍不在计算项目里（S2-16） | S3-07 | 见 §4.1 | P2 | 小 | 卡用例 | 仅报告 |
| S3-17 | 卡 `labor-response` | goal 只写收到日期，不提示答辩期是工作日；方法与期间表已改，卡上一句话即可让律师看到 | S3-01 | goal 改“收到仲裁申请书副本的日期：{received_on}（答辩期十个工作日）” | P2 | 小 | 卡用例 | 仅报告 |
| S3-18 | 多个方法 `tools_optional` | 声明了不用的工具：tabular-review 的 `facts.list`、review-rules-draft 的 `law.search`/`law.get_version`/`citations.verify`、amount-calc 的 `law.get_version`、enforcement 与 preservation 的 `law.get_article`；tabular-review 正文提到 `xlsx.render_table`（作为“不要改用”）未声明——无害，但会让工具清单与正文对不上 | 程序化比对（本轮脚本） | 下次改这些方法时清理 | P2 | 小 | — | 仅报告 |
| S3-19 | 卡 `case-report`（诉讼线，S2-18 余项） | 诉讼线仍无“案件进展报告（给客户）”卡；方法 `case-report` 的“预计费用”仍写“由律师提供”，可接 `calc.court_fee` | `case-report/SKILL.md` §3 第 4 步 | 卡见 §4.4；方法下次改时加 `calc.court_fee` | P2 | 小 | — | 仅报告 |
| S3-20 | labor-arbitration-draft 等全部方法 | 从未被真实模型执行，答辩期工作日、请求单列、原数与复算并列能否被照做未验证 | — | 首批样本见 §4.5 | P4 | — | 真实额度后评测 | 仅报告 |

## 3. 已改文件与用例结果

代码根 `.claude/worktrees/v95-polish/platform/`，未提交（遵照要求未执行 add、commit）。`content/skills/dist/` 由 `npm run build:skills` 重新生成。

| 文件 | 版本 | 一句话说明 |
|---|---|---|
| `content/skills/labor-arbitration-draft/SKILL.md` | 新增 1.0.0 | 劳动仲裁申请书 / 答辩书（含反申请书）；`arguments: [doc_kind, side, received_on, claims]`；`requires_outline: true`；程序规则逐条对照官方原文；答辩期十个工作日交 `calc.deadline`（workday）；请求一次提全、逐项单列；答辩三层；对方金额原数与复算并列；不写仲裁费 |
| `content/skills/labor-dispute/SKILL.md` | 1.2.0 → 1.3.0 | 要成文时转新方法；仲裁应对问收到副本日期并指向工作日口径 |
| `content/skills/labor-dispute/references/procedure-paths.md` | （随 labor-dispute） | 答辩期改工作日；补管辖异议、反申请、增加变更请求三行；开庭通知注工作日；终局裁决按单项写明条文 |
| `content/skills/procedure-check/SKILL.md` | 1.1.0 → 1.2.0 | 劳动仲裁一支十日改为工作日并用 workday；写答辩书转新方法 |
| `content/skills/AGENTS.md` | （无版本号） | 第 2 条补取原文规则；第 4 条补 `calc.deadline`/`calc.labor`/`calc.court_fee`；新增第 9 条“回报先写完成范围” |
| `content/skills/due-diligence/SKILL.md` | 1.0.0 → 1.1.0 | 量化先用 `calc.*`，`tools_optional` 加 `calc.labor`、`calc.deadline` |
| `content/skills/amount-calc/SKILL.md` | 1.4.0 → 1.5.0 | 新参数 `mode`；“复核对方计算”第 8 步与工作表；诉讼费用要问的口径、劳动仲裁不收费；description 补一句 |
| `content/skills/contract-review/SKILL.md` | 1.5.0 → 1.6.0 | 随 `references/contract-types.md` 竞业分型升版 |
| `content/skills/contract-review/references/contract-types.md` | （随 contract-review） | 股权转让竞业三套规则分开核；劳动竞业补在职期间与违约返还 |
| `content/skills/contract-draft/SKILL.md` | 1.1.0 → 1.2.0 | 共用 `contract-types.md`，随之升版（正文未改） |
| `content/skills/legal-research-memo/SKILL.md` | 1.3.0 → 1.4.0 | 差异影响、禁止换算条号、结论确定性三档；自检两条 |
| `content/skills/citation-check/SKILL.md` | 1.2.0 → 1.3.0 | 禁止凭记忆换算新旧条号，旧法期间的旧法引用不判为废止 |
| `content/skills/defense-draft/SKILL.md` | 1.2.0 → 1.3.0 | 复算指向金额测算的复核模式，不改写对方请求 |
| `content/skills/pleading-draft/SKILL.md` | 1.1.1 → 1.2.0 | 预交受理费用 `calc.court_fee` 预估，进核对清单 |
| `packages/kernel/test/skills-contract.test.ts` | — | 文书类清单加新方法；新增用例“劳动仲裁申请书与答辩书”：参数顺序、正文含 workday 与不收费、按方法写的形状直接调期间工具并断言届满日不早于 2026-10-12（新方法的整链黄金路径由用例按方法包自动生成） |
| `packages/kernel/test/skills-bundle.test.ts` | — | 方法数 31 → 32 |

**用例运行（代码根，最后一次全部改动之后）**

```
$ npm run build:skills
[build:skills] 32 个方法模板、52 个文件 → …/content/skills/dist（签名者 SQ0dHEco60K91ro1）

$ node --test packages/kernel/test/skills-contract.test.ts packages/kernel/test/skills-bundle.test.ts packages/kernel/test/prompt-text-names.test.ts
✔ 劳动仲裁申请书与答辩书（评审 S3）：参数先问文书类型；答辩期按工作日算的参数形状在期间工具上走得通
✔ 契约：labor-arbitration-draft（劳动仲裁申请书与答辩书（受限文书）· 试用）
✔ 契约：labor-dispute（劳动争议：仲裁应对、仲裁申请与解除前评估 · 试用）
✔ 契约：amount-calc（金额与期间测算）
✔ 契约：due-diligence（法律尽职调查（清单 / 发现）· 试用）
✔ 契约：pleading-draft（民事起诉状（受限文书））
✔ 方法正文与参考、Agent 档案：没有一处被认成自然人姓名
✔ 有效签名包物化为只读可信区：AGENTS.md 与清单中的全部方法模板（Y3 N-2：数量与构建清单一致）
ℹ tests 46
ℹ pass 46
ℹ fail 0
ℹ skipped 0
```

期间工具实测（同一参数形状）：`{start: "2026-09-28", period: {unit: "workday", n: 10}, rule: "workday"}` → `2026-10-16`；按自然日 `{unit: "day", n: 10, rule: "civil"}` → `2026-10-08`，warnings 均为空。

过程中令牌化用例第一次失败过两处（新方法“劳动者一方需要”里的“方需”、竞业分型里“担任董事”的“董事”被认成自然人姓名），已改写措辞后通过——这条用例对新写正文是有效闸门。

## 4. 需要主会话改的卡

字段键都等于方法 `arguments` 里的参数名（除注明的说明字段外）。

### 4.1 新方法 `labor-arbitration-draft` 的卡（完整规格）

**卡 A · 诉讼线 · 劳动仲裁申请书**
- `id: "labor-arb-application"`，`line: "litigation"`，`title: "劳动仲裁申请书"`，`scenario: "a1.agent_task"`，`skill: "labor-arbitration-draft"`，`verb: "开始起草"`
- `args: { doc_kind: "申请书" }`
- `gives: "劳动合同、工资与考勤记录、解除通知；做过请求梳理的一并放进来"`
- `gets: ["劳动仲裁申请书（草稿）.docx", "证据目录.xlsx", "提交前核对清单.xlsx"]`
- `fields`：
  - `{ key: "side", label: "我方是", kind: "select", options: ["劳动者", "用人单位"], required: true }`
  - `{ key: "claims", label: "拟主张的请求（可空，会逐项核对漏项）", kind: "text", placeholder: "例如：违法解除赔偿金；未签合同二倍工资；加班费" }`
- `goal: "请起草劳动仲裁申请书：我方为{side}；拟主张的请求：{claims}。"`
- `minMaterials: 1`；不设 `allowPartial`（关键事实未确认方法会停在核对清单）
- `steps: ["先确认文书、立场与关键日期", "请求一次提全，逐项单列金额与口径", "列出要你确认的论点与依据，确认后才成文", "生成申请书、证据目录与提交前核对清单"]`
- `intents: [["劳动仲裁", "申请书"], ["劳动", "仲裁申请书"], ["替员工", "申请书"]]`；`notFor: ["商事仲裁", "仲裁委员会规则"]`

**卡 B · 企业法务线 · 劳动仲裁答辩书**
- `id: "labor-arb-defense"`，`line: "inhouse"`，`title: "劳动仲裁答辩书"`，`skill: "labor-arbitration-draft"`，`verb: "开始起草"`
- `args: { doc_kind: "答辩书", side: "用人单位" }`
- `gives: "员工的仲裁申请书副本与送达记录、劳动合同、工资与考勤、解除文件、规章制度"`
- `gets: ["劳动仲裁答辩书（草稿）.docx", "证据目录.xlsx", "提交前核对清单.xlsx"]`
- `fields`：
  - `{ key: "received_on", label: "收到仲裁申请书副本的日期", kind: "date", required: true }`
  - `{ key: "claims", label: "员工请求（一句话即可）", kind: "text" }`
- `goal: "请起草劳动仲裁答辩书：收到仲裁申请书副本的日期：{received_on}（答辩期十个工作日，管辖异议与反申请须在期满前提出）；员工请求：{claims}。"`
- `minMaterials: 1`
- `steps: ["先算答辩期（十个工作日），提示管辖异议与反申请的截止", "按程序、事实、法律三层逐项回应员工请求", "复核员工的计算，原数与复算并列", "确认论点后生成答辩书、证据目录与核对清单"]`
- `intents: [["劳动仲裁", "答辩"], ["员工", "仲裁", "答辩书"]]`；`notFor: ["商事仲裁"]`

**可选卡 C · 诉讼线 · 劳动仲裁答辩书（代理用人单位）**：同卡 B，`line: "litigation"`，`args: { doc_kind: "答辩书" }`，另加 `side` 字段（选项 劳动者 / 用人单位，默认用人单位）。

**衔接**：`NEXT_STEPS["labor-apply"]` 加 `"labor-arb-application"`；`NEXT_STEPS["labor-response"]` 加 `"labor-arb-defense"`；`suit-received` 的 `doc_kind = 劳动仲裁申请书` 仍转 `labor-response`（先应对方案、再答辩书），或改转 `labor-arb-defense`，由主会话定。

### 4.2 既有卡

| 卡 id | 字段键 | 选项 / 改法 | 目标句 |
|---|---|---|---|
| `amount` | `mode`（新增，与方法新参数同名） | select：“我方测算”“复核对方计算”，默认“我方测算” | “请测算以下金额：{items}；模式：{mode}；计算截止日：{as_of}；利率口径：{rate}。” |
| `amount` | `items`（既有） | 选项加“诉讼费用预估”（S2-16） | 同上 |
| `labor-response` | `received_on`（既有） | 不变 | “…收到仲裁申请书副本的日期：{received_on}（答辩期十个工作日）…” |
| `labor-apply` | — | `gets` 第三项改“劳动争议应对方案.docx”（S3-15）；`NEXT_STEPS` 接卡 A | 不变 |
| `defense`、`appeal`、`enforcement`、`contract-review` 等 | 见 4.3 | S3-14 二选一 | — |

### 4.3 卡字段键与方法参数对不上的清单（S3-14，程序化比对）

卡字段不在方法 `arguments` 里：`issues.side`；`amount.items`、`amount.rate`；`pleading.extra`；`defense.domicile`、`defense.stance`；`appeal.ruling`、`appeal.domicile`、`appeal.scope`；`arbitration-app.claims`；`hearing-outline.focus_points`；`preservation.amount`；`enforcement.due_on`、`enforcement.paid`；`cross-exam.side`、`cross-exam.proof_deadline`、`cross-exam.extra`；`labor-apply.situation`；`research-lit.when`；`citation-audit.when`；`demand-lit.deadline`；`contract-review.type`、`contract-review-inhouse.type`；`redraft.focus`；`contract-draft.points`；`corporate-resolutions.matters`；`intake.who`；`compliance-qa.background`；`demand-inhouse.issue`；`case-report.audience`；`labor-response.claim`、`labor-response.received_on`、`labor-response.hearing`；`labor-termination.reason`；`policy-review.place`；`suit-received.doc_kind`。
方法声明了、卡上没给：`amount.mode`（本轮新增）、`intake-lit.side`、`procedure.received_on`、`citation-audit.document`、`redraft.baseline`/`current`、`contract-draft.side`、`dd-findings.focus`、`intake.case_type`/`side`、`suit-received.claims`。
其中影响方法判断、建议优先由方法补声明的：`contract-review.type`、`defense.domicile`、`appeal.ruling`/`domicile`、`enforcement.due_on`、`labor-response.received_on`、`cross-exam.side`/`proof_deadline`、`preservation.amount`。

### 4.4 缺卡的高价值场景

1. 劳动仲裁申请书、答辩书（4.1）——最高。
2. 诉讼线“案件进展报告（给客户）”（S2-18 余项）：`skill: "case-report"`，`line: "litigation"`，字段 `audience`（客户决策人 / 客户法务 / 所内合伙人）与 `as_of`（方法参数）。
3. “复核对方计算”可作为 `amount` 卡的模式（4.2），也可单列一张“复核对方金额”卡挂在答辩、劳动应对的 `NEXT_STEPS` 后。
4. 劳动者一方“先予执行申请”目前只在新方法核对清单里提示，暂不建卡（低频，且须律师判断条件）。

### 4.5 新方法的首批评测样本（真实模型额度到位后，P4）

1. 典型：劳动者被口头辞退、未签书面合同、有加班——申请书应逐项单列违法解除赔偿金、二倍工资、加班费，不合并成总额；证据目录有“申请对方提供”考勤与工资记录。
2. 要素缺失：没有入职日——不起草正文，只出核对清单（待确认事实），或金额写“【金额待测算确认】”。
3. 陷阱：2026-09-28 收到申请书副本——答辩期应为 2026-10-16（十个工作日），不应写 10-08；管辖异议与反申请截止同日。
4. 陷阱：员工同时主张经济补偿与违法解除赔偿金、且赔偿金基数算错——答辩书指出互斥，对方原数与复算数并列，不改写对方请求。
5. 边界：家政服务人员与雇主之间——不属于劳动争议，停止并说明。

## 5. 本轮核过的法条清单

| 法名 | 条号 | 要点（用于何处） | 官方原文来源 |
|---|---|---|---|
| 劳动争议调解仲裁法 | 第二条 | 劳动争议受理范围（新方法 §1） | flk 官方 docx：https://flk.npc.gov.cn/law-search/download/pc?bbbs=2c909fdd678bf17901678bf64f28039d&format=docx |
| 同上 | 第六条、第三十九条第二款 | 用人单位掌握的证据不提供承担不利后果；仲裁庭可要求用人单位在指定期限内提供 | 同上 |
| 同上 | 第二十一条 | 履行地或用人单位所在地管辖，分别申请由履行地管辖 | 同上 |
| 同上 | 第二十二条第二款 | 劳务派遣单位与用工单位为共同当事人 | 同上 |
| 同上 | 第二十七条 | 一年时效、中断、中止继续计算、劳动报酬特殊规则 | 同上 |
| 同上 | 第二十八条、第二十九条 | 申请书载明事项；五日内受理，不受理或逾期可起诉 | 同上 |
| 同上 | 第三十条第二款 | 收到副本后十日内答辩，未答辩不影响程序 | 同上 |
| 同上 | 第三十五条 | 开庭五日前通知，开庭三日前可请求延期 | 同上 |
| 同上 | 第四十三条、第四十四条 | 四十五日审结；先予执行条件，劳动者可不提供担保 | 同上 |
| 同上 | 第四十七至五十条 | 终局裁决范围；劳动者十五日起诉；用人单位三十日申请撤销；非终局十五日起诉 | 同上 |
| 同上 | 第五十三条 | 劳动争议仲裁不收费（新方法、金额测算） | 同上 |
| 劳动争议解释（一）（法释〔2020〕26 号） | 第二条 | 不属于劳动争议的六类纠纷 | flk 官方 docx：https://flk.npc.gov.cn/law-search/download/pc?bbbs=ff80808177e75f88017800739d621b12&format=docx |
| 同上 | 第十四条 | 法院受理后增加的独立劳动争议请求告知另行仲裁（一次提全的依据） | 同上 |
| 同上 | 第十八至二十条 | 裁决未载明终局与否的处理；数项每项不超过十二个月最低工资按终局；同时含两类按非终局 | 同上 |
| 同上 | 第四十二条、第四十四条 | 加班事实举证；用人单位决定类争议由用人单位举证 | 同上 |
| 同上 | 第一、五、十、十一、十二、十五、十六、十七、二十一、三十一、四十七条 | 本轮通读核对，现有方法引用（第四十七条）无误，未新增引用 | 同上 |
| 劳动人事争议仲裁办案规则（人社部令第 33 号） | 第二条 | 适用范围（含人事争议，新方法排除第二至五项人事争议） | 中国政府网国家规章库：https://www.gov.cn/zhengce/2022-08/31/content_5711323.htm |
| 同上 | 第六条、第七条 | 用人单位不能承担责任时与出资人等为共同当事人；个人承包经营者与发包组织为共同当事人 | 同上 |
| 同上 | 第八条 | 履行地、所在地的界定；多个履行地最先受理；履行地不明由所在地；受理后地点变化不改管辖 | 同上 |
| 同上 | 第十条 | 管辖异议答辩期满前书面提出，逾期不影响程序 | 同上 |
| 同上 | 第十三至十五条 | 举证责任；公平原则分配；指定期限内举证，逾期可能不采纳 | 同上 |
| 同上 | 第二十六至二十八条 | 时效；中断的具体方式；中止 | 同上 |
| 同上 | 第二十九至三十一条 | 申请书载明事项（含出生日期、身份证件号码、通讯地址、联系电话）；受理四条件；不予受理与管辖告知 | 同上 |
| 同上 | 第三十三条、第三十四条 | 十日答辩；同一事实理由与请求不予受理的情形 | 同上 |
| 同上 | 第三十六条 | 反申请答辩期间提出，期满后另行申请 | 同上 |
| 同上 | 第三十八条 | 开庭五日前通知、三日前请求延期 | 同上 |
| 同上 | 第四十四条 | 增加、变更请求须在举证期限届满前 | 同上 |
| 同上 | 第五十条 | 终局裁决按单项判断；经济补偿与赔偿金的范围；分别制作裁决书 | 同上 |
| 同上 | 第五十一条 | 先予执行 | 同上 |
| 同上 | 第五十六条、第五十八条 | 简易处理条件；经被申请人同意可缩短或取消答辩期 | 同上 |
| 同上 | 第八十条 | “三日”“五日”“十日”为工作日，“十五日”“四十五日”为自然日（S3-01 的依据） | 同上 |
| 劳动争议解释（二）（法释〔2025〕12 号） | 第十三条、第十四条、第十五条 | 未接触商业秘密的竞业限制不生效、超比例部分无效；在职期间竞业限制不因未付补偿无效；违约返还补偿并付违约金 | 最高人民法院官网 https://www.court.gov.cn/zixun/xiangqing/472691.html （10-23 存档文本） |
| 公司法（2023 修订） | 第一百八十四条 | 董监高未经报告并经决议不得自营或为他人经营同类业务 | 市场监管总局官网 https://www.samr.gov.cn/xyjgs/flfg/art/2024/art_d4e84936a8a744f8928ac7aec7594345.html （10-23 存档文本） |

**待核（未写进正文）**：劳动合同法第三十九、四十、四十四、四十六、四十七、八十二、八十七条与实施条例第二十五条（新方法转引 labor-dispute 现有写法或交 `calc.labor`）；劳动争议解释（一）法院管辖条文；办案规则 2017 年后有无修订；各地仲裁委办案指引。
