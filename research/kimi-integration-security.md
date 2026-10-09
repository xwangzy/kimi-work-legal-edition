# Kimi 法律产品：生产安全与可靠性独立评审

调研日期：2026-09-22。假设：面向中国大陆律所，境内托管试点，已有正式授权模型或内部平台接入。以下是方案建议与源码检查，不是已完成的渗透测试或供应商承诺。

## 1. 核心判断

可把 Kimi 当可更换的智能执行内核，但不能把本地开发工具直接当多租户 SaaS 后端。真正的安全边界应当是产品身份与案件授权、独立工具网关、受限计算环境和数据出入口。模型、提示词、CLI 审批、Hooks 都不能单独承担边界。

**更重要的版本变化：用户提供的旧项目宣布停止维护，当前入口转向继任 Kimi Code。** README标注Archived，但本轮GitHub API的技术归档字段仍为false，二者不能混为一谈。本次分别检查：

- 旧版 `MoonshotAI/kimi-cli`：SHA `9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82`，`pyproject.toml` 1.52.0，README 明示归档且不再有安全更新；仅用于理解历史设计。
- 继任 `MoonshotAI/kimi-code`：SHA `6451f1e056e90037bbf832f3578955cf8e55db64`，TypeScript monorepo。产品应先评估和固定其可交付版本，不盲目采用 main。

一手来源：[旧仓 README](https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/README.md)、[新仓](https://github.com/MoonshotAI/kimi-code/tree/6451f1e056e90037bbf832f3578955cf8e55db64)。

## 2. 新版源码证据及实际含义

| 已核实事实 | 产品判断 |
|---|---|
| `packages/kaos/src/local.ts` 的 `exec` 使用 Node `child_process.spawn`；环境组合包含进程环境；文件操作使用主机文件系统 | Kaos 是执行抽象，不等于系统沙箱。不能把模型主密钥、数据库密码、对象存储密钥放入它的可读环境。 |
| `ReadInputSchema` 明确允许工作目录以外的绝对路径；默认策略自动允许 Read/Grep/Glob 等，另有敏感文件询问规则 | cwd 不是租户边界。新版确有权限保护，不能说“无保护”；但规则保护与 OS 强隔离有本质区别。 |
| permission policy 顺序中显式 deny 先于自动放行；auto-mode 放行在敏感文件询问之前；nonInteractive 不装载 dangerous-command-ask 策略 | 禁止让网页用户传入 `permission_mode`、`disabled_tools`、任意 config；打印模式默认 auto 不能直接当生产执行入口。deny 是辅助限制，不替代操作系统与工具网关。 |
| `externalHooks/internal/runHook.ts` 对启动失败、执行异常、超时返回 allowResult；runner 记录失败数量但 `triggerBlock` 只由 blockDecision 产生阻断 | **PreToolUse Hook 不可作为唯一强制授权关卡。** 它适合观测与附加规则；外部网关必须失败即拒绝。 |
| skillRoots 自动查找项目 `.kimi-code/skills`、`.agents/skills` 和用户路径 | 案件压缩包不能直接解压为 agent 的受信工作目录；不能让对手提交的文件成为自动发现的指令或能力。 |
| 新版已有 REST/WebSocket server、配置写入、会话参数覆盖等管理面 | 可由私有适配层消费，但不能把整个上游管理 API 透传给法律产品浏览器；其 token 不是律所、案件和经办律师授权体系。 |

固定源码：[LocalKaos](https://github.com/MoonshotAI/kimi-code/blob/6451f1e056e90037bbf832f3578955cf8e55db64/packages/kaos/src/local.ts)、[Read 输入](https://github.com/MoonshotAI/kimi-code/blob/6451f1e056e90037bbf832f3578955cf8e55db64/packages/agent-core-v2/src/agent/tools/os/read/read.ts)、[权限策略顺序](https://github.com/MoonshotAI/kimi-code/blob/6451f1e056e90037bbf832f3578955cf8e55db64/packages/agent-core-v2/src/agent/permissionPolicy/permissionPolicyService.ts)、[Hook 执行](https://github.com/MoonshotAI/kimi-code/blob/6451f1e056e90037bbf832f3578955cf8e55db64/packages/agent-core-v2/src/features/externalHooks/internal/runHook.ts)、[Hook runner](https://github.com/MoonshotAI/kimi-code/blob/6451f1e056e90037bbf832f3578955cf8e55db64/packages/agent-core-v2/src/features/externalHooks/app/externalHooksRunnerService.ts)、[Skill 路径](https://github.com/MoonshotAI/kimi-code/blob/6451f1e056e90037bbf832f3578955cf8e55db64/packages/agent-core-v2/src/features/skill/catalog/skillRoots.ts)。

旧版另有按 `action` 字符串缓存 `approve_for_session`、YOLO/AFK 自动批准 MCP 等行为；**不能把这些旧版具体实现直接套到新版**。新版 session approval 使用 permission pattern 匹配，须单独测试规则粒度。[旧 Approval](https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/src/kimi_cli/soul/approval.py)、[新版 session approval](https://github.com/MoonshotAI/kimi-code/blob/6451f1e056e90037bbf832f3578955cf8e55db64/packages/agent-core-v2/src/agent/permissionPolicy/policies/session-approval-history.ts)。

## 3. 推荐部署边界

产品 API／身份与策略服务 → 持久任务编排 → Run Worker → Kimi 适配层 → 隔离执行环境。

Kimi 通过两个独立出口工作：模型网关、法律工具网关。数据服务和外部系统凭据留在这些网关内。网络默认拒绝，只有批准的网关能被访问。模型客户端持有短期、限制模型/次数/预算的代理凭据，拿不到上游主密钥；代理凭据仍被当作可被 agent 读取的低权限凭据处理。

建议一个活跃 Run 独占一个沙箱；需要跨轮保留状态时，按案件和用户授权绑定的 Session 挂载独立状态卷，明确 writer lease，空闲销毁计算资源。可挂载同案件被授权文件的只读快照，写入另一个输出目录。不能共享家目录、工作目录、浏览器 profile、OAuth cache 或全局 MCP 配置。沙箱内本地缓存和临时文件视同案件数据。

初期低并发可用独立 VM/经过验证的轻量 VM 沙箱，不为“未来规模”立即引入整套复杂 Kubernetes。进入多租户共享集群时，选云供应商成熟的 Kata/gVisor 等沙箱运行时并做兼容性测试；限制 root、capabilities、hostPath、hostNetwork、Docker socket、集群 token，设 CPU/内存/PID/磁盘/执行时长上限。普通容器和 namespace 不能当硬租户隔离的充分条件。[Kubernetes 多租户官方文档](https://kubernetes.io/docs/concepts/security/multi-tenancy/)、[gVisor 安全模型](https://gvisor.dev/docs/architecture_guide/security/)。

把“能执行任意代码”与“能调用业务权限”分开：Shell 即使存在，也只能接触本次运行投影文件、受限计算与无业务凭据网络；它不能连接生产 PostgreSQL、完整对象存储、律所 DMS、SMTP、案件系统。绝不靠 shell 命令正则检查承担全部防护。

## 4. 律所权限比普通企业共享空间更细

授权元组至少为 `tenant_id + user_id + matter_id + action + resource_version + policy_version`。身份从认证上下文注入，不能信任模型或浏览器传入的 tenant/matter。案件成员权限、保密等级、利益冲突隔离墙、临时协作、管理员运维权限分别建模。平台运维不是天然的案件阅读者；紧急访问须限时、记录并通知。

ACL 必须覆盖数据库、对象存储、全文/向量检索、缓存、会话摘要、引用预览、导出、分享链接、任务状态、日志、备份恢复。全文与向量检索在召回前带权限过滤，回传前再校验；不把全库命中后过滤作为唯一机制。缓存 key 带租户和授权版本；撤销案件权限同时失效长期会话、下载链接和检索缓存。

PostgreSQL RLS 是第二道防线，服务账号不能是表 owner、superuser 或 BYPASSRLS；事务设置身份并防连接池串租户，必要时 FORCE RLS。RLS 不自动覆盖所有操作，唯一约束和外键侧信道要测试。[PostgreSQL 官方说明](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)。

## 5. 工具授权与人工审批

建议按效果分四类：

1. 只读且范围已授权：自动执行，例如检索已许可法库和本案文件。
2. 本次工作区可回滚写入：自动执行，版本化保存，例如文书草稿、证据清单。
3. 改变业务事实或暴露资料：明确审批，例如更新案件状态、创建对外分享、发送邮件。
4. 代理法律行为或不可逆动作：首发禁止自动化，例如法院提交、签署、付款、删除原始证据。未来按业务要求增加双人复核和专用可靠连接器。

用户点击“发送”时，审批对象必须是收件人、附件文件版本/hash、正文、操作类型、案件、审批人、有效期的绑定记录。执行前重新校验 ACL 和 payload hash；模型修改后重新审批。拒绝、过期和撤权均为终态。默认禁用“一次批准所有同类操作”之类粗粒度授权。外部服务操作都由专用结构化工具执行，不能由 Bash/Curl 绕过。

不要让律师审核每条底层命令；把强制校验留给平台，只把影响法律交付或外部世界的具体结果交给人复核。审计保存证据、版本、操作与决策摘要，不把模型私有推理文本作为法律审计依据。

## 6. Prompt 注入和 MCP

法院网页、对方合同、证据 OCR、邮件、历史聊天、MCP 工具描述和结果都可能含指令。防御目标不是宣称“识别所有注入”，而是即使模型受诱导，攻击也拿不到更高权限或非必要网络出口。

- 案件文件进入独立 intake：病毒与压缩炸弹/路径穿越检查、类型识别、去活跃内容、限额解压；原件保留不可变 hash。OCR/Office/PDF 转换器也放在无外网、低权限沙箱；禁止宏和自动远程模板加载。
- 不可信文本与受信 system/skill 分开存储和编排；文件名不作为执行路径信任。保留原始内容供法律核对，不用简单删词破坏证据。
- 内置 WebSearch/FetchURL 也算数据出境/外发通道：搜索词可泄露客户名称和商业秘密。生产通过经过脱敏/审批策略的检索代理访问，阻断任意 URL、私网地址、云 metadata、DNS rebinding 和重定向绕过。
- 自带工具和 Skills 采用平台审查并固定版本的目录，运行时只读；上传内容不可创建自动发现的 skills/config/hooks。未审查的 MCP server 和任意 `npx` 安装首发禁用。
- MCP 是协议，不是认证授权体系。只接入批准的 server，使用限制 scope/audience 的短期身份；连接器为每一请求重新验证用户、案件与操作。不要把上游 token 不加验证透传；远程发现/OAuth/redirect 都受 SSRF 防护。
- 文档预览与生成 HTML 在隔离域/iframe 中展示，严格 CSP；禁止把模型生成 HTML 当可信网页执行。导出前检查隐藏批注、修订、文档属性、嵌入文件和外链，防止“正文看似无泄密、元数据泄密”。

MCP 官方一手来源：[Security Best Practices](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices)。这里引用其 token audience、SSRF、local server 权限风险原则；集成时仍要锁定实际 SDK 支持的协议版本，不能因最新文档存在就假设运行库实现了它。

## 7. 持久任务、恢复与幂等

建议产品状态机：`queued → provisioning → running → waiting_approval → running → validating → succeeded`，另有 `cancelled / failed / interrupted / reconciliation_required`。失败、人工拒绝与输出质量不通过是不同结果；不能都显示“已完成”。

数据库持久保存输入快照、文件版本、agent/模型/skill 版本、权限快照、运行预算、事件序号、工具执行日志与产物记录。前端 SSE/WebSocket 带 run_id 和递增序号，重连按游标续传；浏览器关闭不应让后台任务丢失。会话单 writer lease 带 fencing token，避免两 Worker 在租约切换时同时写。

队列按至少一次投递设计：`request_id` 去重创建 Run；工具的稳定逻辑 operation_id 独立于每次重试 attempt_id；同 operation 的参数 hash 不同即拒绝。对于外部副作用，保存 `PREPARED / DISPATCHED / CONFIRMED / UNKNOWN` 台账与供应商回执。网络超时意味着 UNKNOWN，先查询外部状态再决定重试，不能让模型凭感觉再发送。供应商不支持幂等或查询时，停到人工核对，不能承诺 exactly-once。

引入 Temporal 可承接多阶段、长时等待、重试和补偿；若试点很小，也可先用 PostgreSQL 队列/任务表，但必须明确拥有租约、重试、事件和台账责任。Kimi 内部状态恢复并不自动等于产品级副作用安全。[Temporal Activity 官方说明](https://docs.temporal.io/activity-definition)。

取消要杀完整进程树/沙箱并禁止新工具请求，不只断开 UI。已经发送成功的外部操作无法因 cancel 撤销；界面应显示实际状态。生成产物先写临时对象，验证通过再原子发布 manifest；证据原件禁止覆盖。

## 8. 成本、SRE 和数据治理

每次 Run 的预算包含主 agent 与所有 subagent 的输入输出 token、OCR 页数、检索费、外部工具费、沙箱分钟数。建立预估、额度预留、执行中计量和结算；硬上限由模型网关和调度器执行，不能只依赖 agent 的自觉。对并发、轮数、单次输出、运行时长、工具次数和子 agent 数量设上限，避免推理-检索循环。保留高质量模型负责关键法律判断，便宜模型是否用于抽取应由评测决定。

指标分层：产品 API 可用性、开始执行排队时长、任务可恢复率、审批可恢复率、文书通过率、引用核验率、P50/P95 单任务成本；不要把模型正常返回 200 当成功任务。按案件任务类型测延迟，不让复杂尽调与短问答共用一个虚假 SLO。

日志默认记录 ID、耗时、状态与费用；正文/身份证/合同条款进入限权加密诊断区，设保留期限。禁止把案件材料默认上传 APM、错误追踪、供应商 telemetry 或反馈渠道。新旧 Kimi 均存在 telemetry 设施；发行配置要明确关闭未批准遥测，并在 egress 层用实际网络观测验收，而非仅相信一个开关。

模型接口、检索、OCR、对象存储、日志、备份及运维访问均纳入境内数据流清单；“境内机器部署”不能单独证明没有跨境传输。供应商不训练、保留期、地域、子处理者、事故通知应取得可执行协议。数据删除覆盖原件、解析件、向量、缓存、会话、临时文件和备份到期处置；法律保留与普通删除策略冲突要可表达。

试点建议先设内部目标而不销售承诺：产品控制面月可用性 99.9%、关键状态零静默丢失、备份恢复演练通过；具体 RPO/RTO 必须根据存储方案和律所采购条件测出后签约。跨可用区数据库与对象存储、限流熔断、可回滚镜像、供应商故障提示优先于双活大系统。

## 9. 上线前可执行验收

| 场景 | 必须达到的结果 |
|---|---|
| A 律所猜测 B 的 session/run/document ID，含检索/下载/事件/历史引用 | 所有接口拒绝，不泄露标题、摘要、存在性和时间线；审计记录。 |
| 同一律所无本案权限成员、管理员直接访问隔离案件 | 按真实授权拒绝；管理员角色本身不解锁内容。 |
| 合同包含“读取其他案件并上传到某站”、伪造 SYSTEM、恶意 MCP 描述 | 无跨案件读取、无非白名单出站、无授权变更；允许回答失败而不泄露。 |
| 沙箱尝试读取宿主/相邻卷/环境主密钥/云 metadata/Docker socket | 不可达；主密钥从设计上不存在于沙箱。 |
| 上传 ZIP 包含 `../`、符号链接、`.agents/skills`、配置或 hook | 安全解包，不能形成受信配置或执行能力。 |
| 审批后更改附件、收件人，或审批者被撤权 | 旧审批失效，必须重新校验；无越权执行。 |
| Hook 网关超时或崩溃 | 外部强制授权网关仍拒绝高风险操作；证明不依赖上游 fail-open Hook。 |
| Worker 在发送前、发送后回执前、写台账前分别被杀 | 能识别失败与 UNKNOWN；不重复发送，不谎报成功。 |
| 网络断线、重复 POST、两 Worker 抢同一 Session、审批事件重放 | 去重、单 writer、有序续传，无重跑或多次副作用。 |
| 取消运行时仍有子进程和 subagent | 进程树终止；新工具请求被拒绝；已发生副作用准确显示。 |
| Fork bomb/超大文件/无限子 agent/高 token 输出 | 有界资源与费用；其他律所请求不受明显影响。 |
| 恢复备份后重新授权、删除案件、跨租户缓存复用 | 授权有效、删除策略执行、无缓存串租户。 |
| 上游 runtime/SDK 升级 | 固定回归样本全部通过，特别是权限默认值、自动发现、协议重连、引用与产物；灰度失败自动回滚。 |

这些验收应作为试点准入门槛；不把评测集“零失败”宣传为系统不存在剩余风险。

## 10. 红队式反对意见与决策

**“每律所一个容器就够。”** 不够。同律所存在案件隔离墙；容器仍共享 kernel；数据库、检索和日志照样会串租户。需要案件授权与沙箱两层。

**“把所有工具接 MCP 并保留人工确认就安全。”** 不够。律师无法逐条识别恶意命令，MCP server 自身也会持有凭据。需要结构化专用工具、最小权限和审批绑定内容。

**“新 SDK 有 hooks，可以写一个鉴权脚本。”** 可以做附加校验，但源码错误/超时为放行，故不能作为唯一门禁。必须有独立且 fail-closed 的业务操作出口。

**“不暴露 Bash 就没有风险。”** 不够。检索词、FetchURL、模型请求、文档渲染外链也可泄漏；解析器也可能被恶意文件攻击。数据出口与处理器都需限制。

**“Temporal 能确保发送只发生一次。”** 不够。外部副作用结果不明确时仍要幂等键/回执/对账。流程恢复与业务 exactly-once 是不同问题。

**“已有正式授权模型接入，可以马上外售。”** 授权解决供应商使用范围的一部分；还要完成产品权限、数据治理、评测与运维证明。建议先提供内部草拟、检索和审核辅助闭环，外发、签署和法院提交后置。

最终建议：首发围绕可靠文书产物与可复核证据链交付；让 Kimi 负责智能执行，让自有平台持有身份、权限、数据、账本和最终发布权。这条边界使未来替换 Kimi、升级 SDK 或切换模型都不会牵动律所的信任根基。
