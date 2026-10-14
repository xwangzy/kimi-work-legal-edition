# 实施记录：方法模板（Skills）第二批

日期：2026-10-13 ｜ 依据：`历史Demo评估与融合方案.md` §3（四条原则、首发表、§3.4 规格、§3.6 处置表）与附录 A–C；工具面以 `packages/kernel/src/tools/registry.ts`、`packages/domain/src/legal-tool-names.ts`（10-13 新开放 8 个工具）为准。

## 一、新增 8 个

| id | 中文名 | 用到的工具（必需 / 可选） | 交付件 | 档位 | 已知限制 |
|---|---|---|---|---|---|
| contract-review | 合同审查（风险卡） | 必需：materials.list、materials.read_excerpt、riskcards.submit、citations.verify；可选：riskcards.list、law.search、law.get_version、docx.render_report、xlsx.render_table | 风险卡（审查工作台）、《审查意见书（内部稿）》.docx、《问题清单》.xlsx | beta，正文标“试用（通用辅助）” | 四类合同 × 双方立场要点（`references/contract-types.md`）与通用必查点（`references/rubric.md`）未经本所资深律师验收；本所规则库（playbook.get）未建，只读可信区 `firm-overlay.md`（如有）；PDF 合同可出卡但修订稿只能对 DOCX 生成；每次最多 60 张、每任务 300 张 |
| contract-redline | 修订说明与谈判要点 | 必需：riskcards.list、docx.render_report；可选：materials.list、materials.read_excerpt、citations.verify、xlsx.render_table | 《修订说明（致客户）》《修订说明（致对方）》《谈判要点（内部）》.docx，可选《谈判要点表》.xlsx | beta | 修订稿由律师在工作台生成，Agent 不改原件、不新增修订；（已更正，复核 B3-B15）`riskcards.list` 返回 fallback、basis（含核验结论）与 needs_client_decision，模板优先使用；卡里没有备选时标“新拟 · 待律师确认” |
| redraft-review | 回稿比对与重审 | 必需：materials.list、docx.compare、riskcards.submit、xlsx.render_table；可选：materials.read_excerpt、riskcards.list、citations.verify、law.get_version、docx.render_report | 《变更清单》.xlsx（变更清单 / 我方修改跟踪 / 比对说明）、重审风险卡、可选《回稿审查意见（内部稿）》 | beta | docx.compare 为段落级，表格单元格、页眉页脚、脚注、自动编号的改动可能漏检（已要求在清单与回报中声明）；两份都须 DOCX |
| casefile-organize | 案卷整理（目录与时间线） | 必需：materials.list、materials.read_excerpt、facts.submit、xlsx.render_table；可选：facts.list、docx.render_report | 事实行（事实时间线）、《案卷总目录》《事实时间线》（四类分列）《缺口清单》.xlsx | beta | 事实锚点为逐字引文，无页码；每次 120 条、每任务 600 条；“律师确认”列依赖律师在界面确认过的事实 |
| issue-evidence-matrix | 争点—证据矩阵与补证 | 必需：facts.list、materials.list、xlsx.render_table；可选：materials.read_excerpt、law.search、law.get_version、citations.verify、docx.render_report | 《争点—证据矩阵》.xlsx（要件矩阵 / 抗辩与反驳 / 补证清单 / 未纳入事实 / 依据与核验） | beta | 只用律师确认的事实，确认为零时只出要件框架；举证责任只写一般分配；案例库未开通 |
| pleading-draft | 民事起诉状（受限文书） | 必需：facts.list、materials.list、docx.render_report、xlsx.render_table；可选：materials.read_excerpt、law.search、law.get_version、citations.verify | 《民事起诉状（草稿）》.docx、《证据目录》.xlsx（含随附材料）、《提交前核对清单》.xlsx | beta（仅民商事起诉状） | 仲裁申请书、答辩状、上诉状、劳动仲裁文书不支持；“金额表已确认”没有结构化状态，靠律师在对话中确认或已确认事实的 amount_yuan；诉讼费、期限无计算工具（calc.deadline 未建），由律师核算 |
| demand-letter | 律师函 / 催告函 | 必需：facts.list、citations.verify、docx.render_report；可选：materials.list、materials.read_excerpt、law.search、law.get_version、xlsx.render_table | 《律师函（草稿）》或《催告函（草稿）》.docx、《依据与发送前核对》.xlsx | beta | 不外发、不用印；解除通知须律师与客户确认后才起草；时效、保证期间、解除权期限不自行推算（calc.deadline 未建） |
| case-report | 案件进展汇报 | 必需：materials.list、facts.list、docx.render_report、xlsx.render_table；可选：materials.read_excerpt、riskcards.list | 《案件进展汇报》.docx（一页）、《进展与风险附表》.xlsx | beta | 开庭、和解接触等程序进展没有结构化数据源，只能来自材料或律师告知；风险只做定性描述 |

## 二、修订已上线的 5 个（1.0.0 → 1.1.0）

| id | 主要改动 | tools_required / tools_optional |
|---|---|---|
| legal-research-memo | 备忘录改用 docx.render_report；来源超过 10 条另出《来源目录》.xlsx；事实假设取 facts.list 中已确认的；引用事项材料前先 materials.list | 必需不变；可选：docx.render_report、xlsx.render_table、materials.list、materials.read_excerpt、facts.list |
| citation-check | 核验表改用 xlsx.render_table（核验 / 汇总两表）；先 materials.list 确认识别质量并声明未读范围 | 必需不变；可选：materials.list、materials.read_excerpt、law.search、xlsx.render_table |
| amount-calc | 计算明细改用 xlsx.render_table 一次生成四到五个工作表，不再命令行拼表；参数优先取已确认事实；明确不支持“LPR 倍数”计息 | 必需不变；可选：xlsx.render_table、facts.list、materials.list、law.get_version、citations.verify |
| intake-notes | 纪要用 docx.render_report、清单用 xlsx.render_table；先 materials.list 判断“已提供”；可选把客户陈述以 claimed 提交 facts.submit；新增 `references/collection-lists.md`（8 类案件收集清单） | 必需：materials.list、materials.read_excerpt；可选：docx.render_report、xlsx.render_table、facts.submit、law.get_version |
| client-advice | 答复改用 docx.render_report；事实假设取已确认事实并注明来源；读材料前先 materials.list | 必需不变；可选：docx.render_report、materials.list、materials.read_excerpt、facts.list |

各 Skill 的降级路径保留 `kwl-docx` / `kwl-xlsx`（工具不可用时使用，并在文件中注明“未经文书 / 表格工具生成”）。

## 三、其他改动
- `content/skills/AGENTS.md` 第 5 条：原文要求“Word 用 kwl-docx、Excel 用 kwl-xlsx”，与本批 Skill 冲突（准则规定冲突时以准则为准，会让 Skill 的改动失效）。已改为“优先 docx.render_report / xlsx.render_table，风险卡与事实行必须经 riskcards.submit / facts.submit 提交；工具不可用时再用 kwl-docx / kwl-xlsx”。
- 未新增 audience-pack：受众净化依赖的 docx.sanitize 不对 Agent 开放，按方案走确定性工作流。
- 未改任何代码文件。**待跟进（代码）**：`packages/kap-host/src/matter-engine.ts:231` 的系统提示仍写“DOCX 用可信命令 kwl-docx……”，建议同步为“优先 docx.render_report / xlsx.render_table”。

## 四、构建与校验
- `npm run -s build:skills`：通过（13 个方法模板、21 个文件，签名者 SQ0dHEco60K91ro1）。
- description 长度 153–188 字（上限 250）；全部 frontmatter 另用 Kimi Code 解析器所用的 js-yaml 4.1.1 解析通过（name、description、when_to_use、arguments、kwl 数组类型正确）。
- `node --test packages/kernel/test/skills-bundle.test.ts`：3/3 通过（新包验签、物化、篡改拒载）。
- 尚未做：资深律师审校、evals 盲测（§3.4.3 的 `evals/` 目录未建）、端到端在真实事项中跑一遍风险卡与事实行的提交。
