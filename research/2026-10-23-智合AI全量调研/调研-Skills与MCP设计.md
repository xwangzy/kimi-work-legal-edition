# 智合 AI 调研补充：Skills、MCP、提示词与法律工作流的可实施设计

研究与复核日期：2026-10-23，Asia/Shanghai。本文为独立技术与产品研究，不是智合 AI 私有系统提示词、后台配置或线上服务实现的还原。

## 1. 证据范围与主要结论

本次完成两类工作：一是重新读取并静态审计本地 2026-10-21 智合公开技能快照；二是于 2026-10-23 联网读取 Agent Skills、MCP、PaddleOCR 与 CoCounsel Legal 的官方资料。未操作主代理浏览器，未登录智合账号，未运行上游脚本，未创建令牌、连接 MCP、上传案件材料或查询授权数据库。

需要保留以下事实边界：

| 证据类型 | 本次取得的内容 | 可以支持的结论 | 不能支持的结论 |
|---|---|---|---|
| 旧本地现场记录 | 2026-10-21 首页、Skill 工作台、MCP 管理及外接令牌记录 | 当日记录了这些可见界面 | 今天界面完全相同、当日已验证服务联通 |
| 旧公开仓库快照 | 固定提交 83df6b13a60b2dfeaf30001c7894bcb45a59fcc4 | 该快照的文件、文本、脚本与许可结构 | 仓库当前最新版本、智合生产后台正在执行同一代码 |
| 今日规范网页 | Agent Skills、MCP 正式文档与扩展文档 | 标准所规定的格式、协议与职责 | 任意宿主均已实现全部标准 |
| 今日厂商说明 | PaddleOCR 官方集成、CoCounsel Legal connector guide | 厂商公开说明的能力及边界 | 已在本项目安装、运行、验证性能或取得数据许可 |
| 本文 schema、提示词、流程 | 原创设计建议 | 可作为自建产品的实现输入 | 智合已提供对应工具或接口 |

主要判断：

1. 智合公开技能快照可以提供大量业务方法与模块线索，但不能直接等同于跨宿主可运行产品。
2. 提示词、Skill、工作流、工具与 MCP 应分开建模，再在任务卡片中统一呈现。图片上传是输入入口，OCR 是工具，图片证据整理才是业务 Skill。
3. 70 个源 Skill 的展示名称使用中文，与英文目录名不同；依照今日核验的 Agent Skills 命名规则，应在迁移时使用稳定 slug 作为 name，将中文名放入展示元数据。
4. 法律交付的核心约束应是事实出处、法律时点、引用支持、文件版本和可复核结果。只增加角色设定和卡片数量，不能解决这些问题。
5. MCP 可以承载 Skill 的发现与分发，因此二者职责不同但可以组合；不宜把它们描述为互斥技术。

## 2. 旧资料清点与可复用资产

### 2.1 固定来源

- 本地旧资料目录：../2026-10-21-智合AI调研/。
- 公开上游仓库：[Decikingship/legal-agent-skills](https://github.com/Decikingship/legal-agent-skills)。
- 固定快照：[83df6b13a60b2dfeaf30001c7894bcb45a59fcc4](https://github.com/Decikingship/legal-agent-skills/tree/83df6b13a60b2dfeaf30001c7894bcb45a59fcc4)。
- 旧资料获取日期：2026-10-21；本次本地静态复核日期：2026-10-23。
- 本次浏览工具打开该仓库及固定提交页面未成功，故不声明已联网重新取得或确认上游最新状态。
- 本地 LICENSE 标明 MIT，版权人为 Copyright (c) 2026 John He (Decikingship)。复用实质代码或文档应保留许可与版权通知。MIT 不授予智合账号、数据库或客户资料访问权。

### 2.2 计数口径

本次直接遍历源目录所得：

| 对象 | 数量 | 口径 |
|---|---:|---|
| core | 6 | skills/core 下 SKILL.md |
| litigation | 27 | skills/litigation 下 SKILL.md |
| nonlitigation | 24 | skills/nonlitigation 下 SKILL.md |
| utility | 13 | skills/utility 下 SKILL.md |
| 源技能合计 | 70 | 四类之和 |
| 专家配置 | 34 | experts 下 EXPERT.md |
| dist、dist-experts | 不另计 | 构建与打包产物，避免重复统计 |

首页场景数、工作台预设数、开源技能数、专家数、市场技能数属于不同对象；不能相加后宣称产品提供同样数量的独立法律功能。旧包中的 36 首页场景与 59 工作台场景应当作为旧记录，待主代理今日现场逐项核验。

### 2.3 主要资产及复用方式

| 资产 | 价值 | 建议处理 |
|---|---|---|
| 70 项源 SKILL.md | 触发场景、前置要素、步骤、输出与失败分支 | 保留来源，逐项改写为业务契约，修复命名与失效引用 |
| 34 项 EXPERT.md | 多技能组合、顺序、交付与门槛 | 作为工作流参考，转换为显式节点和状态 |
| scripts | 计算、关键词信号、编目、检索适配 | 逐项静态审阅后再做隔离测试，不把扫描规则当完整法律判断 |
| references / conventions | 检索约定、时间效力、输出格式、编码表 | 版本化管理，区分官方规则、项目自定义和供应商字段 |
| assets | 合同、尽调、业务工作簿与输出模板 | 结合目标用户、法域和交付格式重写，删除不适用的固定值 |
| evals | 正常、缺事实、规则变动等案例 | 复用场景类别，重新做律师标注和可复现验证 |
| build_skills.py | 检查、依赖注入、专家包构建 | 静态参考；此研究未执行 |
| infra/zhiexa_proxy.py | HTTP 上游代理示例 | 明确依赖授权 API，不当作 MCP 服务器现成实现 |

### 2.4 今日静态审计发现

以下均针对固定本地快照，不能据此断言线上产品故障。

| 发现 | 证据 | 影响 | 修改建议 |
|---|---|---|---|
| 70/70 name 非标准 slug，且与目录名不同 | 逐项提取源 SKILL.md 的 name，对照父目录与 slug 规则 | 标准加载器或校验器可能拒绝，不能宣称无适配跨宿主使用 | name 改为英文稳定目录标识；中文放 metadata.display_name |
| 两处指向未包含的技能 | nonlit-review-contract 与 nonlit-clause-benchmark 文本均提到 nonlit-draft-contract，70 项目录无该项 | 用户意图路由和依赖说明可能指向缺失目标 | 新建合同起草技能，或改为准确的现有目标；不得把“来华合同审查”当通用起草的自动替代 |
| 关键缺参处置存在多重口径 | 合同技能一处要求无立场不执行，另一处允许最保守默认或分支；专家描述也有类似混合 | 子任务可能自行选择立场，输出假设不一致 | 主控收集关键参数；子任务遇缺参返回 needs_input，不自动选定立场 |
| 默认最短期限、最低金额不普遍可靠 | 多个文件采用“最保守”统一话术 | 可能混淆权利主张、风险测算、期限推定和商业决策 | 给出明确情景区间和假设；期限规则缺失时阻断确定结论 |
| 合同审查要求每项风险均有法条或裁判依据过于一刀切 | nonlit-review-contract 的输出要求 | 商业风险、操作风险与文本不一致未必需法条才能成立，容易诱发牵强引用 | 先区分法律、事实、商业、起草风险，再匹配所需支持材料 |
| “现行有效”不足以覆盖法律适用 | 专家交付门槛偏重现行效力，底座另有行为时法说明 | 历史行为、程序事项、过渡规则容易脱节 | 分开保存研究日状态、事实发生时版本、时际规则与适用理由 |
| 脱敏默认保留金额、日期、关系可能残留识别线索 | util-anonymize 的原则 | 稀有事实组合仍可定位个人或客户 | 按外发目的选择金额区间化、日期粗化、地点泛化；仍保留内部映射 |
| “文件脱敏是唯一会产生法律责任的交付工具”不成立 | util-anonymize 的开头措辞 | 会误导其他任务的风险认识 | 删除排他表述；各技能按实际后果设置复核点 |
| 样本量阈值与支持率不等于胜诉预测 | 检索技能提供样本阈值及裁判支持率口径 | 公开裁判存在选择偏差，样本也未必可比 | 只描述样本分布、过滤口径与可比性，不外推个人案件胜诉概率 |
| 检索契约含“依据服务层源码”等自述 | conventions/retrieval-contract.md | 此文本并非本次独立取得的生产服务源码验证 | 将字段与限制标为上游契约声明；接入时以实际接口测试复核 |

本次检索两个公开 Python HTTP 客户端及代理的环境变量名称：ZHIHE_BASE_URL、ZHIHE_TOKEN、ZHIEXA_API_ROOT、ZHIEXA_TOKEN。只读取变量名称，未读取凭据值。静态查找未在 Python 文件中发现常见 MCP 实现标记；这只能支持“该快照的可见实现主要是 HTTP 客户端/代理”，不能否定线上另有 MCP 服务。

## 3. 已核验规范事实

### 3.1 Skill 是可移植的方法包，移植仍需适配

Agent Skills 规范要求一个目录至少包含 SKILL.md，文件具有 YAML 元信息与 Markdown 指令，可配脚本、参考资料、模板；name 要使用规范允许的 slug 并匹配目录，description 描述用途与触发条件。允许工具声明仍属实验字段，不能代替宿主权限控制。[Agent Skills 规范，2026-10-23 访问](https://agentskills.io/specification)

本项目据此建议：

- 用“稳定 ID—中文标题—版本—来源—兼容要求”五项区分身份、展示与运行条件。
- 先加载元信息，匹配任务后再加载程序性步骤与所需参考，避免把全部技能正文塞入每次系统提示词。
- 技能中可以告诉模型怎样使用工具，但实际工具授权、文件权限和网络目的地由可信执行层决定。
- 技能内容能触发脚本，因此导入前要检查来源、依赖、命令和网络访问，不能只检查 Markdown 语法。

### 3.2 MCP 的三种基础对象

官方 Prompts 定义可发现、可传参的提示模板，典型模式是用户显式选择；协议不限制必须采用斜杠命令，卡片、表单也可承载。[MCP Prompts 官方源文档，2026-10-23 访问](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/server/prompts.mdx)

Resources 是上下文资源，如文件或业务资料；Tool 是可执行操作。工具具有输入 schema，模型可据上下文调用；产品需明确展示可用工具及调用情况。[MCP Resources](https://modelcontextprotocol.io/specification/2026-07-28/server/resources)、[MCP Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)，2026-10-23 访问。

因此本项目定义：

| 层次 | 例子 | 责任 |
|---|---|---|
| 场景卡片 | “审查采购合同” | 发现任务，说明交付 |
| Prompt 模板 | 指定买方立场、法域、重点条款 | 表达本次目标与范围 |
| Skill | 合同审查 SOP、风险口径、输出要求 | 稳定专业方法 |
| Workflow | 收件、预检、解析、审查、复核、导出 | 顺序、状态、暂停和恢复 |
| Tool | 解析 DOCX、取法条原文、比较修订 | 单项可执行能力 |
| MCP | 暴露以上资源、模板、工具 | 连接及发现机制 |
| 数据源 | 法规库、案例库、机构模板 | 内容、覆盖、版本和许可 |

### 3.3 Skill 可以通过 MCP 分发

官方 io.modelcontextprotocol/skills 扩展已发布，SEP-2640 为 Final。它通过 skills/list、skills/get 与 Resources 分发 Skill 文件；读取 SKILL.md 不自动等于激活，宿主支持仍需逐一确认。[MCP Skills 扩展官方说明，2026-10-23 访问](https://modelcontextprotocol.io/extensions/skills/overview)

建议同时保留两种交付：本地受控技能包适合离线方法与模板；远程 MCP 分发适合随服务更新的方法及说明。二者均应锁定来源和内容摘要，更新时保留版本差异。不要因为技能来自已授权服务器，就默认其新增脚本或外发目的地也已获授权。

### 3.4 固定协议版本，业务状态显式保存

2026-07-28 MCP 版本移除协议层会话和旧握手，跨调用状态使用显式 handle；请求携带版本/能力元数据，工具列表等支持缓存字段。[MCP 2026-07-28 变更说明，2026-10-23 访问](https://modelcontextprotocol.io/specification/2026-07-28/changelog)

工程建议是将案件、任务、材料、研究运行和草稿状态存入自身系统，不依赖某个浏览器聊天或连接会话。对外客户端建立兼容矩阵：协议版本、Tools/Resources/Prompts、Skills 扩展、异步任务、富内容、错误处理分别测定；旧客户端走独立兼容适配层。

## 4. 面向法律业务的推荐分层

~~~text
案件/项目
  ├─已确认：主体、立场、目标、法域、关键日期、材料版本
  ├─事实与证据账本：陈述、材料记载、冲突、缺口、原件定位
  └─任务
      ├─业务卡片 + 可编辑 Prompt
      ├─Skill 方法版本 + 模板/规则版本
      ├─Workflow 状态 + 可恢复步骤 + 人工复核
      ├─受控工具 + MCP/API/本地连接器
      └─交付物 + 引用链 + 未解决事项
~~~

首页可以允许从“合同审查”“律师函”“图片证据”直接启动，但启动后应关联一个事项。已确认的立场、材料版本、名称映射和检索范围在事项内复用；未经确认的前案事实不自动流入新事项。

任务契约中不让模型任意指定租户、当前身份或授权范围；这些信息来自可信会话。matter_id 是定位资源的参数，不是权限证明。每次读取材料、检索知识和导出文件均重新检查当前权限。

## 5. Skill 配置与运行契约

### 5.1 可跨宿主适配的文件结构

~~~text
contract-review/
  SKILL.md
  references/
    review-method.md
    output-schema.md
    jurisdiction-guide.md
  assets/
    review-table.csv
    clause-template.md
  scripts/
    check-document-consistency.py
  evals/
    cases.jsonl
  LICENSE
~~~

示例 frontmatter（建议格式，非智合原文）：

~~~yaml
---
name: contract-review
description: 审查已有合同，按确认立场输出可定位的风险与替代条款。用于合同把关、条款审查和回稿复审。
license: Proprietary. See LICENSE.
compatibility: Requires authorized document and legal retrieval tools.
metadata:
  display_name: 合同审查
  version: "1.0.0"
  owner: 法律产品组
  jurisdiction: CN
---
~~~

示例许可只是自建内容的占位，不得用它覆盖复用的 MIT 上游内容。基于上游修改的实质内容继续保留其必要版权/许可。

### 5.2 每项 Skill 必须补齐的十二项内容

| 字段 | 要回答的问题 |
|---|---|
| 业务目标 | 最终给谁、为了什么决策提供什么成果 |
| 适用与排除 | 哪些材料、法域、阶段适用，何时转其他技能 |
| 必要输入 | 缺哪些条件无法给出可用结论 |
| 可选输入 | 哪些信息提升质量，但不阻塞有限分析 |
| 材料预检 | 是否缺页、缺附件、有多个版本、无法辨认 |
| 分析步骤 | 如何从材料形成事实、争点、规则和结论 |
| 工具依赖 | 哪些工具是真实可用，失败时如何降级 |
| 输出 schema | 表格、草稿、来源、假设、未决事项的字段 |
| 质量门槛 | 什么结果必须补查，什么错误阻断交付 |
| 权限 | 读哪些资料，是否向外发送，谁批准发送 |
| 评测 | 正常、缺参、矛盾、过时规则和恶意材料样本 |
| 版本治理 | 负责人、规则来源、更新条件、兼容性和撤回方式 |

### 5.3 运行级输入建议

~~~json
{
  "matter_id": "M-opaque",
  "skill_id": "contract-review",
  "skill_version": "1.0.0",
  "objective": "审查买方验收与违约责任风险",
  "client_role": "buyer",
  "jurisdiction": {"country": "CN", "region": null},
  "as_of_date": "2026-10-23",
  "event_dates": {"contract_signed_on": null},
  "assets": [
    {"asset_id": "A-opaque", "version_id": "immutable-version"}
  ],
  "focus": ["acceptance", "liability"],
  "output_profile": "risk_table_and_replacement_clauses",
  "external_research_policy": "minimal_deidentified_facts"
}
~~~

缺失合同立场时仍可做材料完整性、错别字与交叉引用预检，但不得默认为甲/乙方给谈判方案。缺少事发日期时可报告现行规则检索结果，但必须把历史适用结论留待核实。

### 5.4 运行级输出建议

~~~json
{
  "run_id": "R-opaque",
  "status": "needs_review",
  "scope_completed": ["document_preflight", "clause_review"],
  "scope_incomplete": ["historical_law_applicability"],
  "findings": [
    {
      "finding_id": "F-01",
      "category": "drafting_risk",
      "severity": "high",
      "source_spans": ["A-opaque:v1:p3:s12"],
      "issue": "正文与附件对验收期限约定不一致",
      "impact": "无法确定验收及付款触发条件",
      "proposed_action": "统一定义并明确文件优先顺序",
      "replacement_text": "待结合双方确认的期限填写",
      "legal_authorities": [],
      "review_status": "pending"
    }
  ],
  "assumptions": [],
  "missing_inputs": ["合同签订日期"],
  "source_index": [],
  "artifacts": [],
  "limits": ["未提供附件二，无法核对其验收标准"]
}
~~~

这里 legal_authorities 为空可以成立，因为文本矛盾可由原文直接证明；若进一步断言条款无效或法定权利受损，则需对应法律依据。各字段必须体现结论类型，避免为形式完整而编造法条。

## 6. 推荐工具接口

以下名称与 schema 全为建议接口，尚未实现，也不表示智合或任何数据源开放相同 API。

| 工具 | 输入 | 输出 | 验收与失败规则 |
|---|---|---|---|
| document.inspect | asset_id、version_id | MIME、页数、加密、损坏、解析计划 | 缺页/加密明确提示，不能静默忽略 |
| document.parse | 资料版本、页范围、模式 | page/block/span、坐标、表格、OCR 标记 | 返回 failed_pages 与解析器版本 |
| document.read_span | 资料版本、span_id | 原文、上下文、原页定位 | 无法定位则引用标为未核验 |
| document.compare | 基线版、目标版、修订策略 | 文本增删改、移动、条款映射 | 法律影响分析与机械差异分开 |
| evidence.extract | 材料集、字段 schema | 值、来源、冲突、无法辨认项 | 不自动确认真实性和证明力 |
| matter.build_timeline | 事实记录、日期口径 | 事件、时间、出处、冲突 | 区分形成日、发生日、推测日 |
| legal.search | 法域、问题、事发/研究日期、过滤、分页 | 命中、来源 ID、版本、截断与覆盖 | 找不到不等于不存在 |
| legal.read_authority | 来源 ID、版本、条款/段落 | 原文、前后文、版本、状态、URL | 不用搜索摘要冒充法条原文 |
| legal.verify_citation | 引文、拟支持命题、适用时点 | 存在、准确、支持、适用四项结果 | 无法核定时保留待核，不给总绿灯 |
| legal.research_start | 范围、问题、预算、来源策略 | research_id、计划、状态 | 显式范围与最大预算 |
| legal.research_status | research_id | 进度、待输入、局部成果、错误 | 不输出虚假百分比 |
| legal.research_result | research_id | 备忘录、来源、反方材料、覆盖边界 | 成果与检索日志绑定 |
| calculate.amount | 金额分段、利率规则、日期、舍入 | 公式、分段明细、合计、假设 | 确定性计算，输入不全返回情景 |
| calculate.deadline | 事项、起算事件、送达、日历规则 | 起止日、规则版本、分支 | 不明规则不默认最短即正确 |
| document.render | 已复核内容、模板版本、格式 | DOCX/PDF/XLSX、预览、校验 | 页码、编号、表格、脚注验收 |
| privacy.redact | 文件版本、外发目的、字段策略 | 脱敏版、映射、遗漏复查表 | 原件保留，映射仅内部授权可读 |

### 6.1 法律检索 inputSchema 示例

~~~json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "matter_id": {"type": "string", "minLength": 1},
    "query": {"type": "string", "minLength": 1},
    "jurisdiction": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "country": {"type": "string"},
        "region": {"type": ["string", "null"]}
      },
      "required": ["country", "region"]
    },
    "source_types": {
      "type": "array",
      "items": {
        "enum": ["statute", "judicial_interpretation", "case", "regulator_material"]
      },
      "minItems": 1
    },
    "as_of_date": {"type": "string", "format": "date"},
    "event_date": {"type": ["string", "null"], "format": "date"},
    "cursor": {"type": ["string", "null"]},
    "limit": {"type": "integer", "minimum": 1, "maximum": 50}
  },
  "required": ["matter_id", "query", "jurisdiction", "source_types", "as_of_date"]
}
~~~

运行时从登录上下文注入真实用户与组织，不接受模型用 tenant_id 或身份参数切换权限；将发送到外部源的事实做最少化和去标识处理。JSON Schema 合法不代表业务上有权查询，服务端还须校验事项与资源权限。

### 6.2 工具结果公共封装

~~~json
{
  "run_id": "R-opaque",
  "tool_version": "1.0.0",
  "input_fingerprint": "sha256:...",
  "status": "partial",
  "data": {},
  "coverage": {
    "requested": 18,
    "processed": 16,
    "failed": 2,
    "truncated": false
  },
  "warnings": [
    {"code": "OCR_UNREADABLE", "asset_ref": "A:v1:p7", "action": "manual_review"}
  ],
  "retrieved_at": "2026-10-23T10:00:00+08:00",
  "retryable": true
}
~~~

检索接口另有 database_coverage、query_log、source_version、licensing_limits；文档接口另有 original_hash、parser_version、failed_pages；写入接口另有 idempotency_key 与结果版本。接口失败绝不能被模型翻译成“没有相关规定”“未发现风险”或“全部完成”。

## 7. 图片、OCR 与证据 Skill

PaddleOCR 官方文档提供 OCR、PP-StructureV3 和文档视觉模型相关 MCP 工具，支持本地、官方 API、千帆及自建服务等推理方式；这是可研究的候选，并不意味着智合正在使用该方案。[PaddleOCR 官方 MCP 集成文档，2026-10-23 访问](https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/integrations/mcp_server.md)

其文档展示结构化 JSON、Markdown 与版面信息输出，可作为原件定位链的技术基础；通用能力及基准不等于法律文档实测准确率。[PP-StructureV3 官方文档，2026-10-23 访问](https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/pipeline_usage/PP-StructureV3.en.md)

### 7.1 “图片证据整理”的任务范围

输入表单应收集：图片类型、需要证明的事项、双方主体、截图/扫描来源、是否有原始载体、文件顺序、是否允许外部解析。用户无需先理解 OCR 名称。

执行顺序：

1. 保留原图与哈希，生成工作副本；识别重复、旋转、裁切、模糊和顺序疑点。
2. OCR 并存储原图坐标；金额、姓名、日期、账号、单位及否定词单列复核。
3. 提取材料记载；无法辨认保留占位，不根据上下文补字后当成原文。
4. 聊天截图保存说话人、显示时间、消息次序、引用和附件关系；拼接候选关系与确定关系分开。
5. 将材料片段映射到事实命题，列有利、不利和不完整上下文。
6. 生成证据目录草稿、待补原件/载体信息和核验清单，由使用者确认编号与证明目的。

### 7.2 建议可直接使用的 Prompt

> 请将所附图片整理为可核对的法律材料摘要。先列文件与页数，检查模糊、裁切、重复、顺序不明和上下文缺口；保留原图编号。逐张提取可辨认文字，对金额、姓名、日期、账号、否定词和计量单位单独列复核表，不能辨认的写“无法辨认”，不要猜写。再输出“材料记载—原图位置—拟支持的事实—不利或矛盾信息—待核事项”。如果是聊天截图，区分显示姓名与真实身份、显示时间与实际发生时间；连续性无法确认时明确标注。最后给证据目录草稿与原始载体、完整记录、形成过程等补充清单。仅依据所提供材料描述，不将截图内容直接认定为已证事实，不宣称已完成真实性鉴定。

该提示词必须由工具能力支撑。系统没有坐标或原图定位时应明确降级为文件/图片编号定位，不能生成假坐标。对于海量扫描件，运行进度应展示已处理页、失败页、需重扫页，而不是一条模糊的“正在分析”。

## 8. 法源与引用：分四次验证

| 验证 | 问题 | 可能结果 |
|---|---|---|
| 存在性 | 法规、案例或文献是否存在且可读取 | 找到、未找到、授权不足 |
| 准确性 | 名称、条号、案号、引文是否对应原文 | 一致、不一致、无法核对 |
| 支持性 | 原文是否支持该命题，是否遗漏例外 | 支持、部分支持、不支持 |
| 适用性 | 法域、日期、主体和事实是否适合本事项 | 适用、可区分、待补条件 |

建议内部链路为 claim_id → source_id/version → article/paragraph/span。每项结论既能回跳案件材料，也能回跳法源。不要用一个“引用已核验”的总标签覆盖四种不同问题。

案例资料应保存事实、诉称、查明、说理、裁判结果等来源段落类型。律师评析、新闻和裁判摘要要有独立标记，不能将其作者意见写成“法院认为”。案例级别、法院层级与检索排序属于资料属性和检索策略，不能自动转换为当前个案结论。

建议的法律研究 Prompt：

> 请围绕【问题】形成供【使用者】审阅的研究备忘录。先确认【法域】【立场】【行为/事件日期】【研究截止日期】【关键事实】；缺少影响适用的条件时列出待补并作明确分支。分别检索规范依据、相关裁判与必要监管资料，记录范围、检索式和未覆盖事项。对主要结论给原文定位，区分现行状态与本事项应适用的版本；主动寻找相反依据并解释差异。不能取得全文的来源保持待核，不能用摘要证明精确引文。输出结论、规则、事实映射、正反论证、建议及限制；不把未检索到表述为不存在。

## 9. 真实产品可借鉴的 MCP 边界

CoCounsel Legal 官方连接器把深度研究拆成启动、查状态、取报告、追问四个工具，返回带 Westlaw 链接的报告；需要相应订阅。官方同时说明该连接器当前研究功能不等于文书起草、单篇调取或穷尽检索。其覆盖为美国法相关研究，不能移植为中国法能力声明。[CoCounsel Legal 官方 connector guide，2026-10-23 访问](https://legal-mcp.thomsonreuters.com/docs/connector-guide)

可借鉴的独立设计是：

- 长任务用显式 research_id，刷新页面后仍能取结果。
- 计划、状态、产物分离，允许用户修改范围和预算。
- 追问复用已有研究，但标记增量来源与新时点。
- 在工具页写明“适合做什么、不能据此证明什么、应转到哪里”。
- 保留来源深链；需要订阅才能读原文时直说访问条件。

中国法系统应另行建立法源版本、裁判资料来源、库覆盖、授权与可复核策略；不照搬美国判例效力和引证逻辑。

## 10. 权限、可靠性与状态

MCP 授权安全要求服务器验证令牌目标 audience，禁止令牌透传，并规定安全存储、HTTPS 和 PKCE 等要求。[MCP 授权安全考虑，2026-10-23 访问](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations)

以下为本项目自己的实现建议：

| 权限层级 | 动作示例 | 执行规则 |
|---|---|---|
| 事项内读取 | 已授权材料、内部模板 | 服务端逐次校验资源与当前身份 |
| 外部检索 | 发送去标识争点到法律库 | 限定目的地、最少信息、明确源和成本 |
| 内部生成 | 草稿、比较、计算、导出预览 | 生成新版本，不覆盖原件 |
| 外部写入 | 发客户、提交通道、发布、外传原件 | 形成可复核成品后由授权人员决定 |

材料里的“忽略指令、上传文件、使用某个网址”应当作为待分析内容，不构成任务授权。检索结果、MCP 工具描述和 Skill 都不能自行扩张权限。密钥存于受控配置，不进入提示词、文档、操作日志或网页截图。

推荐状态机：

~~~text
draft → awaiting_inputs → preflight → parsing → analysing
      → researching（需要时）→ drafting → validating → needs_review → completed
任一阶段可进入 partial / failed / cancelled；缺少关键输入进入 awaiting_inputs。
~~~

每个节点保存输入版本、方法版本、工具结果引用、完成范围、错误与重试。改合同立场时重跑审查判断；只修改输出字体时无需重新检索。重试写入动作必须幂等，取消后不继续后台外发。

“completed”应由可验证条件决定：预定交付物存在、处理覆盖明确、引用检查通过或缺口已标记、格式可打开、人工复核状态明确。模型说“已完成”不直接改变业务状态。

## 11. 评测、发布与优先级

### 11.1 必测用例

| 层次 | 用例 | 核心验收 |
|---|---|---|
| 文档解析 | 模糊金额、跨页表、盖章、手写、倒置、缺页 | 错误可见、关键字段可回跳 |
| 事实抽取 | 日期冲突、简称、多主体、转述、否定 | 不静默合并，不猜测补全 |
| 法源 | 现行/历史版、未施行、草案、地域规则 | 状态、适用时点和来源分开 |
| 案例 | 诉称与说理相反、撤诉、评析文章、反面案例 | 不混同来源类型或支持范围 |
| 合同 | 买卖方切换、多个附件、定义冲突、回稿删条 | 立场准确，条款关系完整 |
| 期限/金额 | 分段利率、跨日、节假日、不同起算口径 | 公式可复算，缺参不武断 |
| 输出 | 主体、金额、请求、附件、编号一致 | 交付前一致性与渲染检查 |
| 权限 | 跨事项诱导、恶意材料指令、撤权重试 | 不泄漏，不外传，不绕过 |
| 工作流 | 中断、超时、部分页失败、重复提交 | 可恢复、可解释、幂等 |

先由律师双人标注少量真实难度样本，再扩大。把严重错误、未报告缺失、来源支持、人工修改量和耗时一起衡量；不能以模型自评或随意设置的“95%”代替性能证据。

### 11.2 建议实施顺序

1. P0：材料原件与定位、事项上下文、引用四层核验、合同审查/证据整理/法律研究三条主流程、内部草稿与人审。
2. P1：合同回稿、模板库、法律计算、文书导出、版本恢复与机构 playbook。
3. P2：复杂专家编排、批量矩阵、监管追踪、外部系统协作；依实际价值再加入多 Agent。

多 Agent 适合独立检索、相反论证和交叉核查；不能让多个 Agent 互相转述同一未核实结论就当作独立证据。共同主控负责锁定事实、版本与范围，各子任务输出自己的依据及不确定性。

## 12. 仍需主代理现场确认的智合边界

- 今日主页、工作台、专家、技能广场与 MCP 配置的可见模块、数量及进入方式。
- 点击卡片究竟只是插入提示词，还是加载文件、工具、专家或多步骤流程。
- 每张卡片可见的完整预设文本、参数、附件格式与限制。
- 场景是否支持图片、PDF、Word、表格、批量材料；上传控件不等于实际处理能力已经验证。
- MCP 是外接服务器、对外暴露能力，还是二者都有；哪些是仅界面字段，哪些已做真实连接验证。
- 技能/专家是否可导出、是否含官方公开版本、导入后怎样处理权限与依赖。
- 权限、计费、任务恢复、引用、错误页与导出文档的实际行为。
- 网页隐藏系统提示、私有检索配置、模型路由、数据库许可、数据驻留和后台代码均不可由页面外观推断。

本次的静态审计和官方规范核验，可用于优化现场取得的材料；不能替代逐项现场观察，也不能将未公开实现写成“已复制”。

