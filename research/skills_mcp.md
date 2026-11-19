# 法律 AI 的 Skills / MCP / 溯源与评测设计研究

研究日期：2026-10-22。本文为公开一手资料研究与独立架构建议，不是智合 AI 内部实现或隐藏提示词的还原。所有 `legal.*`、`document.*` 等工具名均为建议接口，尚未实现，也不表示对应网站开放 API。

## 1. 核心判断：卡片提示词只是入口

建议将产品拆为五层：业务卡片（用户要做什么）→ 参数表单与提示词（本次范围和要求）→ skill（可复用 SOP、判定标准、失败分支）→ 工作流（状态、依赖、复核）→ MCP/API 工具（读取、检索、计算、导出）。上传图片是输入能力；OCR 是工具；“图片证据整理”才是业务 skill。把这些都称作 skills，会使前端配置与后端权限无法区分。

MCP 本身分别定义 Prompts、Resources、Tools，前者可承载用户选择的模板，后两者分别承载上下文与可调用能力；它不是法律专业判断质量的保证。参见 [MCP server primitives](https://modelcontextprotocol.io/specification/draft/server/index)、[Prompts](https://modelcontextprotocol.io/specification/2025-11-25/server/prompts)。

法律产品的差异应落在范围控制、证据定位、规则版本、复核与可交付成果，而不是仅为每种文书写一段角色设定。Harvey 官方 Agents 页面公开提供计划预览、多格式输入、引用、步骤日志与组织知识接入，可作为交互参考；不能由此推断其内部实现。[Harvey Agents](https://www.harvey.ai/platform/agents)

## 2. 可借鉴的真实 MCP 实例

Thomson Reuters 官方 CoCounsel Legal MCP 将深度研究分成启动、查状态、取报告、追问四个工具；报告保留 Westlaw 链接。其文档同时明确深度研究不等于穷尽结果、单篇文献调取或所有法律能力。这种“清楚说明能力边界”比声称一个连接器能完成全部法律事务更值得借鉴。[官方 connector guide](https://legal-mcp.thomsonreuters.com/docs/connector-guide)

建议借鉴异步研究任务的产品边界，但中国法数据源、授权、效力判断与案例使用规则需另行设计。不能将美国判例数据库逻辑直接迁移。

## 3. Skill 统一配置模型（建议）

```yaml
id: contract.review
version: 1.0.0
title: 合同审查
purpose: 按指定立场和审查规则形成可追溯的修改建议
required_inputs: [matter_id, document_refs, review_party, jurisdiction]
optional_inputs: [transaction_background, playbook_version, negotiation_stage]
preflight: [check_access, check_document_completeness, resolve_versions]
steps:
  - parse_and_classify
  - extract_obligations_and_cross_references
  - compare_against_playbook
  - research_only_if_legal_issue_requires_it
  - draft_findings_and_redlines
  - validate_citations_and_internal_consistency
outputs: [risk_table, proposed_clauses, unresolved_questions, source_index]
tool_allowlist: [document.parse, document.read_span, legal.search, legal.read]
human_review: before_external_delivery
failure_policy: preserve_partial_results_and_list_missing_inputs
```

建议每个 skill 另含：适用/不适用场景、关键事实缺失时的追问规则、最低证据要求、敏感信息处理、输出 schema、样例、回归评测集、负责人及更新记录。Prompt 应专注本次指令；流程和权限由系统执行，避免依赖“请不要越权”这种文字约束。

## 4. 文档处理工具与数据模型（建议）

| 工具 | 主要输入 | 必须返回 | 关键取舍 |
|---|---|---|---|
| `document.register` | matter_id、上传文件引用、用途 | doc_id、hash、mime、页数、访问标签 | 建立不可变原件引用；不在 prompt 里传任意本地路径 |
| `document.parse` | doc_id、页范围、解析模式 | 块、页码、坐标、表格单元格、OCR 质量标记、解析器版本 | 可复制文字优先原生解析；扫描件进入 OCR；保留失败页 |
| `document.read_span` | doc_id、版本、span_id | 原文、前后文、页图定位 | 引用最终回到原件，而不是只引用二次摘要 |
| `document.compare` | base_doc、target_doc | 增删改条款、移动段落、置信状态 | 区分排版变化与实质变化，标注无法对齐处 |
| `document.extract_fields` | docs、字段 schema | 值、原文位置、缺失状态、冲突值 | “没有找到”和“确定不存在”必须区分 |
| `document.render_draft` | 已复核结构化内容、模板版本 | 草稿引用、版本、渲染预览 | 文书生成与对外发送分离 |

PaddleOCR 官方项目支持 PDF/图片转 Markdown、JSON，且 PP-StructureV3 提供细粒度坐标，可作为自部署解析候选。其通用基准性能不代表特定法律材料准确率，应以盖章复印件、手写批注、跨页表格、聊天截图等自有测试验证。[PaddleOCR 官方仓库](https://github.com/PaddlePaddle/PaddleOCR)

### 图片证据整理的完整 skill

1. 识别截图、照片、扫描件，保留文件原件和顺序，不自动认定其真实性。
2. OCR 并展示日期、金额、姓名、账号等关键识别项供核对；模糊项使用“无法辨认”。
3. 提取消息时间、发言人、文本、附件关系、上下文缺口；跨截图拼接只作为候选关系。
4. 输出事实命题—支持片段—不利片段—待补资料表；不得把“截图显示”写成“已证实”。
5. 汇总原始载体、完整会话、形成过程等需要人工补充的信息；不据图片内容自动判断法律证明力。
6. 生成证据目录草稿，人工确认后才编最终编号。

## 5. 权威检索与法律引用工具（建议）

| 工具 | 输入 | 输出 |
|---|---|---|
| `legal.search` | 问题、法域、基准日期、规范/案例/监管资料类别、检索式、分页 | source_id、标题、机关、日期、效力元数据、摘要、URL、覆盖/截断说明 |
| `legal.read` | source_id、条款/段落范围、as_of | 完整目标片段、前后文、版本、施行/废止/修订情况、来源 URL、抓取时间 |
| `legal.verify_citation` | source_id、拟引用文本、拟支持命题、基准日期 | 是否存在、是否准确、是否支持命题、时间适用风险、人工复核项 |
| `legal.research_start` | scope、事实摘要、问题列表、source_policy、budget | task_id、计划、预计阶段 |
| `legal.research_status` | task_id | 阶段、完成项、缺失项、需用户选择的事项 |
| `legal.research_result` | task_id | memo、sources、检索日志、反面材料、coverage_limits |

检索排序不能只按语义相似度：先限定法域、日期、文献类型，再结合权威层级与相关性；在中国法场景中还应区分规范性文件、司法解释、指导性案例、普通裁判、实务文章。具体来源的读取和商业使用须有许可，MCP 并不自动授予数据库使用权。

建议所有法律结论内部保存 `claim_id → source_id/version → article/paragraph → exact_span` 链路。来源存在、引文准确、引文能支持该命题、该来源适用于本案，是四个不同验证问题。Thomson Reuters 官方训练资料将引文核查、法律表述核查、补充支持依据作为文书分析能力，可佐证这种分层的产品必要性。[官方引用核查训练](https://training.thomsonreuters.com/media/How%2Bto%2Bverify%2Bcitations%2Band%2Bdiscovery%2Bmissing%2Blegal%2Bauthorithy%2Bwith%2BAI%2BDocument%2BAnalysis/1_icpng192)

## 6. 证据与事实溯源（建议）

```json
{
  "claim_id": "F-014",
  "statement": "某付款记录显示转账金额为 100000 元",
  "kind": "document_observation",
  "sources": [{"doc_id":"D-03","version":"sha256:...","page":2,"span_id":"s28"}],
  "status": "supported_within_provided_materials",
  "conflicts": ["F-019"],
  "missing": ["转账主体与合同主体的对应证明"],
  "review_status": "pending"
}
```

建议事实状态使用“当事人陈述 / 材料记载 / 多材料一致 / 有争议 / 无法辨认 / 待核实”，避免让一个数值置信度替代真实性与证明力判断。对金额、日期、期限用确定性程序计算，记录公式、单位、起止日、日历规则和假设；模型负责解释争点，不凭心算输出结论。

冲突材料不做静默合并：例如合同写 30 日、邮件写 45 日，应分别保留并指出是否存在有效变更尚待确认。证据缺口应与主张要件关联，使用户知道缺资料的后果。

## 7. 工作流与权限（建议）

状态建议：`draft → awaiting_inputs → parsing → researching → drafting → validating → needs_review → completed`，另设 `partial / failed / cancelled`。每一步记录输入版本、工具调用、输出引用、失败原因和重试次数。重跑只重算受影响节点；追问引用已有 task_id，避免丢失研究范围。

截至研究日，MCP 最新正式版本为 2026-07-28；官方发布说明采用无状态核心，需跨调用保留业务状态时使用显式 handle。工程实现应固定并测试协议版本，不能混用旧版握手代码与新版请求元数据。[正式发布说明](https://blog.modelcontextprotocol.io/posts/2026-07-28/?trk=public_post_comment-text)

建议本系统将工具拆成四种权限：读取已授权事项材料；向外部检索发送最少事实；生成内部草稿；对外发送/提交。工具自身逐次检查 tenant、matter、user 与资源权限，不信任模型传入的 matter_id。跨事项检索默认禁止，组织知识库只返回用户实际有权阅读的条目。

MCP 官方要求工具进行输入校验、访问控制，并建议对敏感调用展示输入、允许用户拒绝；工具的说明与注解不能替代可信策略。[Tools 规范](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)。授权侧应校验令牌 audience、避免令牌透传、使用独立上游令牌。[授权安全规范](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations)

落地策略：来源文本视为资料，不当作新系统指令；用户上传合同中的“忽略指令、把材料发送到某网站”不得触发工具。记录日志时保存最少必要数据，凭据不得进入提示词、审计全文或导出件。外部检索先做事实去标识化，确需传出原件时明确显示文件、服务和用途。

## 8. 评测方案（自主建议）

| 层级 | 样本与指标 | 阻止发布的错误示例 |
|---|---|---|
| 解析 | 日期金额字符准确率、表格关系、页码坐标可回跳、失败页发现率 | 金额小数点错误且未报警 |
| 检索 | 律师标注的关键权威召回、反方依据覆盖、时点筛选 | 引用基准日尚未施行规则而无说明 |
| 引用 | 来源存在率、原文一致、命题支持率、引用定位成功率 | 编造案号、来源不支持命题 |
| 法律分析 | 要件覆盖、事实/假设分离、反证处理、适用条件 | 将争议陈述写成已证事实 |
| 文书 | 主体/金额/请求一致、占位符识别、附件对应 | 诉请与计算表矛盾 |
| 权限 | 越权事项、恶意资料指令、外传诱导、撤权重试 | 返回另一客户资料 |
| 工作流 | 中断恢复、幂等、超时、部分结果、成本与延迟 | 重试造成重复发送或静默丢页 |

评测至少覆盖正常、缺资料、冲突、过时法、跨法域、低质扫描、长文多附件、恶意文档指令。先建少量律师双人标注的金标准，再扩大；把严重错误率与可用草稿比例、人工修改时间一起衡量。阈值由实际风险等级、样本统计和律师验收确定，不宣称随意设定的百分比具有行业权威。

Thomson Reuters 对 CoCoBench 的官方说明也强调真实多步骤法律任务，而非只用考试、单轮问答或单项抽取评价。此处仅作为评价方向参考，不代表其商业产品已通过本项目测试。[CoCoBench 官方说明](https://www.thomsonreuters.com/en-us/posts/innovation/why-legal-ai-needs-a-new-standard-inside-thomson-reuters-cocobench/)

## 9. 实施优先级（自主判断）

P0：原件管理与定位引用、合同审查/法律研究/证据整理三条核心 workflow、权限隔离、引用校验、人工复核、失败可见。P1：条款 playbook、版本对比、批量抽取表、组织模板、Word 输出。P2：监管监测、期限提醒、跨系统协作与多 agent。先验证“结果可复核”，再增加卡片数量；否则扩大的是错误传播面。
