# 调研 A：Kimi Code 集成、云依赖与工程独立核验

审计日：2026-10-09（Asia/Shanghai）。范围：v5/v6 技术方案、当前 `platform/` 实现、锁版与官方上游。只读检查产品代码；未使用真实案件或 API 密钥，未请求付费模型。下述“已确认”表示源码、官方文档或本次探针有直接证据；“推断”表示工程判断；“待验证”表示不能从材料推知。

## 1. 独立结论

Kimi Code 是可真实嵌入的 Agent 引擎，现有 fork 并非虚构 SDK；使用开放平台模型 API 建设自有订阅 SaaS 在技术上成立。但“买了 API token → 获得 Kimi Work 全后端 → 现有 demo 已完整集成 → 可直接服务律师”这一推导不成立。当前集成保留循环、部分会话与法律 MCP，主动关闭大量通用 Agent 能力；项目尚无证据证明操作系统沙箱、持续任务、交互提问、技能装载、浏览器及完整云服务已经交付。

v5 的优点是明确将模型视作不可信决策者，将事项权限与成果签发置于业务内核；v6 的优点是补上 SaaS 控制面、中继、公开任务和服务商 IM 的产品现实。主要问题不是选错 Kimi Code，而是把“能力关闭”当成长期安全架构，把“进程级封装”与“OS 强制隔离”混用，以及新增通用工具后未重新检查绕过路径。用户要求完整能力时，必须通过独立执行域、能力令牌和统一工具网关恢复能力，不能只扩大一个 `enabled` 数组。

本报告不能为“完美无风险”或“可直接上线”背书；可以给出清晰的生产退出条件，逐项过关后转为可交付产品。

## 2. 上游真实性与锁版

**已确认**：2026-10-09 在线打开 [MoonshotAI/kimi-code 官方仓库](https://github.com/MoonshotAI/kimi-code)，为 TypeScript monorepo，包含 `packages/node-sdk`、`agent-core-v2`、`kaos`、`kosong`、`kap-server`、OAuth、remote-control 等。官方 README 声明兼容开放平台 API key 与 Kimi Code OAuth，具有本地工具、MCP、插件、子代理与 hooks。[官方 README](https://github.com/MoonshotAI/kimi-code/blob/5b936697670ed15444bcb4720bd91e6ee776a941/README.md)

| 项目 | 本次事实 |
|---|---|
| 本地上游地址 | `https://github.com/MoonshotAI/kimi-code` |
| 本地 HEAD | `f67e6398fb3210ad8ace970e2dfd5bcc984ed61f` |
| 官方 commit 时间 | 2026-09-24 15:21:10 +08:00，`ci: release packages (#4016)` |
| 本次线上 main | `5b936697670ed15444bcb4720bd91e6ee776a941`，2026-10-08 18:21:54 +08:00 |
| 上游增量 | 官方 compare API 返回 ahead 16 commits |
| 本地补丁 | 6 个文件未提交改动，31 行新增、10 行删除；与补丁台账主要条目相符 |
| SDK 源包版本 | `packages/node-sdk/package.json` 是 `0.20.0`，不是 CLI 版本号 |
| vendored 包版本 | 自定义 `2.1.1-zr.2`，不能与官方 SDK semver 混用 |
| vendor `index.mjs` SHA-256 | `ae2f4087e5cab4bcd414f298e701ad803272177927e2ff6c533bb999784db226` |

本次从官方 raw 下载锁版 `sdk-rpc-client-v2.ts`、`webSearchService.ts`、`kimiWebbridge.ts`、`LICENSE`，逐字节与本地 `git show HEAD:<path>` 比对，四项全部相同。由此可以确认抽样源码来自真实官方提交；**不能据此证明所有 vendor bundle 字节完全由该提交加补丁构建**。bundle 内能查到 `extraSeeds`、`includeProject:false`、`projectAgentRoots` 等补丁标记，但缺少可复现构建证明、制品清单签名与完整 SBOM。

建议版本记录同时保存 CLI version、SDK version、upstream SHA、fork SHA、patch-set hash、lockfile hash、toolchain、bundle hash、签名身份。应把当前补丁转为明确 fork commit，而非依赖一个 dirty checkout。使用固定制品；升级先经过策略与交互契约回归，不应直接跟随 main。

台账要求升级时 revert #4059，本次在线 compare 确认它确实存在：`1f6f0b1fa2`，`KIMI_CODE_TRUST_WORKSPACE`。但固定“永远 revert 某 PR”不如建立不变量：案卷目录不能通过环境变量、配置、MCP、profile、skill 或插件变成授权来源；每次升级按行为验证，再决定保留/回移哪些修复。不能永远以关闭内置工具为理由放弃信任边界修复。

来源：[锁版 commit](https://github.com/MoonshotAI/kimi-code/commit/f67e6398fb3210ad8ace970e2dfd5bcc984ed61f)、[本次 main commit](https://github.com/MoonshotAI/kimi-code/commit/5b936697670ed15444bcb4720bd91e6ee776a941)、[官方差异](https://github.com/MoonshotAI/kimi-code/compare/f67e6398fb3210ad8ace970e2dfd5bcc984ed61f...5b936697670ed15444bcb4720bd91e6ee776a941)。

## 3. API token 的能力与权利边界

**已确认**：开放平台 API、Kimi Code、Kimi 会员的 key、计费和权益相互独立。境内开放平台使用 `https://api.moonshot.cn/v1`；Kimi Code 使用独立 coding endpoint。采购模型 API 不会自动形成 Kimi Work SaaS 席位、Kimi Code OAuth、官方 connector 访问权或云沙箱服务。[官方 API FAQ](https://www.kimi.com/help/kimi-api/api-troubleshooting)、[官方 Kimi Code FAQ](https://www.kimi.com/code/docs/kimi-code/faq.html)

用户已明确品牌使用获授权，本次不否认该授权。工程采购仍应分开列清单：模型推理、开源运行时、设计/商标、WebBridge/CU 二进制、官方搜索/数据源、Kimi Work 专有后端、支持/SLA。前三者中任一项获准，不应推定其余全部包含。

**已确认**：根目录 [MIT LICENSE](https://github.com/MoonshotAI/kimi-code/blob/f67e6398fb3210ad8ace970e2dfd5bcc984ed61f/LICENSE) 覆盖所许可代码，要求保留相应版权及许可声明。依赖和外部下载组件需分别核验，根 MIT 不等于第三方服务合同或商标授权。

**待验证**：中软与 Kimi 的实际采购条款是否覆盖多租户代调用、转售形态、并发/容量保障、数据区域、保留期、训练使用、滥用排查日志、分包商、故障通知与商用支持。本报告未见合同，不能声称这些已获保证。

SaaS 实现建议：平台掌握供应商长期 key，客户端只持自身产品的短期 token；按 tenant/matter/run/agent/tool 计量；设置并发和 token 总预算。账单必须包括主 Agent、所有子代理、压缩、重试、OCR、搜索和失败任务，不把上游会员包额度转售当成本基线。断开客户端或取消本地任务不当然消灭供应商已开始的计费，取消与账务结算需单独设计。

## 4. 云依赖逐项核验

| 能力 | 官方锁版源码事实 | API-only SaaS 的落地结论 |
|---|---|---|
| 模型调用 | 支持开放平台与兼容 provider | 可接现有 MaaS，但需验证 reasoning、流式 tool call、长上下文、usage、错误码、取消，不只验证“返回文本” |
| WebSearch | `webSearchService.ts:31–86`：显式 services 配置，或 Kimi Code OAuth；默认走 coding base + `/search` | 普通模型 API key 不自动配置此服务；建设自有搜索适配器/采购独立搜索，或获得独立正式服务授权 |
| FetchURL | `webService.ts:36–79`：显式 fetch 服务 → OAuth `/fetch` → 本地 fetch；支持 local fallback | 关闭云服务不会自动消灭联网；必须统一经过工具网关，不允许未声明本地回退改变数据去向 |
| WebBridge | `kimiWebbridge.ts:21–24,248–283`：从 CDN 下载外部 daemon，并控制带登录态的真实浏览器 | 不是现有法律 SDK 自动包含；需许可核验、固定版本/签名、独立浏览器权限面与凭据隔离 |
| Computer Use | `kimiCu.ts:49–59` 外部 plugin zip，后续安装 KimiCU.app/Windows helper、系统辅助权限 | 编排源码开源不证明辅助程序源码、再分发或服务权利齐全；批准哪个应用/窗口/动作要单独设计 |
| Kimi 数据源 | `kimi-datasource.mjs:22–23,292–395` 读取 Kimi Code OAuth access token、调用 coding 服务 | 法律/财新等数据源不得因 UI 存在就视为可用；逐个采购内容权利和 API 产品 |
| Remote Control | 官方包提供本机服务经 relay 的隧道 | 不是多租户 IAM/审计/租户隔离层；默认不随 SaaS 产品启用 |
| Kimi web UI | 上游 `AGENTS.md` 指明 web UI 源码在其他仓库，本仓库为预构建 bundle | 不能从 Kimi Code repo 推定已获得 Kimi Work 完整 UI/后端代码；设计授权按用户已获授权的范围执行 |

可追溯源码：[搜索服务](https://github.com/MoonshotAI/kimi-code/blob/f67e6398fb3210ad8ace970e2dfd5bcc984ed61f/packages/agent-core-v2/src/app/auth/webSearch/webSearchService.ts#L31)、[抓取服务](https://github.com/MoonshotAI/kimi-code/blob/f67e6398fb3210ad8ace970e2dfd5bcc984ed61f/packages/agent-core-v2/src/app/web/webService.ts#L36)、[WebBridge 下载与用途](https://github.com/MoonshotAI/kimi-code/blob/f67e6398fb3210ad8ace970e2dfd5bcc984ed61f/packages/agent-core-v2/src/app/capability/entries/kimiWebbridge.ts#L248)、[CU 外部插件](https://github.com/MoonshotAI/kimi-code/blob/f67e6398fb3210ad8ace970e2dfd5bcc984ed61f/packages/agent-core-v2/src/app/capability/entries/kimiCu.ts#L49)、[官方数据源代码](https://github.com/MoonshotAI/kimi-code/blob/f67e6398fb3210ad8ace970e2dfd5bcc984ed61f/plugins/official/kimi-datasource/bin/kimi-datasource.mjs#L292)、[仓库项目说明](https://github.com/MoonshotAI/kimi-code/blob/f67e6398fb3210ad8ace970e2dfd5bcc984ed61f/AGENTS.md)。

## 5. 现有实现的独立缺陷与生产阻断项

以下路径相对仓库根 `platform/`。报告列出源码行号，避免把设计愿景与已完成实现混为一谈。

### A-P0-01：没有 OS 沙箱，不应把应用层改写称为“无对外网络能力”

`apps/agent-host/src/host.ts:5–7,49–57` 声称全局 undici dispatcher 让宿主事实上无外网能力；`packages/kernel/src/executor/agent-host-manager.ts:183–194` 实际使用普通 `spawn(runtime,[entryPath])`，未见受限令牌、AppContainer、Job Object、网络命名空间或外部沙箱启动器。

**已确认的技术边界**：全局 dispatcher 仅影响采用该默认 dispatcher 的请求。官方 `app/web/providers/local-fetch-url.ts:129–134` 显式传入自己的 dispatcher；它可以绕过全局 dispatcher。`node:http/https/net`、自建 dispatcher、child process 和本机原生组件也不因这句设置而失去网络权限。vendor bundle 中存在 direct fs/child_process/net imports。

当前白名单关闭 FetchURL，故本次不是声称现已发生外联入侵；这是当前隔离结论不成立、及扩功能时必现的架构缺口。**修复**：云执行放进强隔离沙箱并默认断网，仅允许受控代理；端侧独立受限执行器、进程树/资源限制与受支持系统的 OS 网络强制。所有形态运行实测矩阵，无法建立强边界的个人自装模式必须明确为较低保证等级，不能显示相同安全标识。

### A-P0-02：文件系统边界可被符号链接穿透，Windows 合法子路径也会失败

`apps/agent-host/src/sandbox.ts:38–65` 只对 `resolve()` 后字符串前缀判断；读写在检查后直接执行，未验证最终目标、链接/重解析点及打开时竞态。`under()` 固定使用 `/`，Windows `path.resolve()` 返回 `\\` 路径，合法子目录将被错误拒绝。

**本次已实测**：Node 26.8.1，临时目录创建纯合成 `synthetic-outside.txt`；快照内 `link.txt` 指向白名单外该文件，再直接调用实际 `createRestrictedFileSystem.readText(link)`。结果 `synthetic_symlink_escape=true`。另使用 `path.win32` 计算合法子路径并代入当前判定，结果 `windows_legal_child_allowed_by_current_under=false`。临时文件已清理，无真实文件内容被读取。

这证明 wrapper 本身不是强边界，不证明通过当前封闭工具集可以直接构造完整攻击链。**修复**：root-relative path 与 OS 文件句柄能力校验；拒绝/安全解析 symlink、junction、reparse point、UNC、大小写、长路径；对读写、rename、link、删除均在真实边界内执行；仅 realpath 后再读不足以处理 TOCTOU。终极边界仍是 OS 沙箱与只挂载允许目录。

### A-P0-03：“manual + setApprovalHandler”不等于每次工具执行都强制经过业务审批

官方 `permissionPolicy/policies/default-tool-approve.ts` 默认批准 Read、Grep、WebSearch、FetchURL、Agent、AgentSwarm、Skill 等；`permissionGateService.ts:53–59` 只有 `ask` 才请求审批，`approve` 直接放行。因此以后开放工具时，不能靠回调自动接管全部行为。

当前 manager 的 `agent-host-manager.ts:90–102` 对 `mcp__legal__` 前缀自动批准，既没有按参数描述副作用，也没有让律师在此处确认。这对现有六个受限法律工具可作为原型策略，但不是成熟三级权限机制。应以执行前策略强制点为准，重新校验主体、事项、对象版本、动作、数据去向、预算、有效期与吊销状态；审批 UI 仅签发窄化 capability，工具端必须消费并核验。

不要把 `mcp__legal__*` 通配符当永久安全分类。新增同前缀写工具会自动继承批准，必须使清单包含 tool schema hash、作用范围和副作用类别。

### A-P0-04：任务 timeout 会被记为 succeeded

`host.ts:154–163` 超时发送 `{t:'done',status:'timeout'}` 后以 1 退出；manager `:105–107` 把除 cancelled 外的 done 全设为 succeeded；退出处理 `:237–247` 仅更正 running/starting 状态，因此 timeout 的 succeeded 可能保留。**这是直接源码逻辑缺陷**，不应把不完整草稿作为完成成果推进后续流程。

修复为有限状态机：succeeded、failed、cancelled、timed_out、waiting_user、budget_exhausted、interrupted 分离；终态转换须绑定结果完整性；非零退出、模型截断、工具失败、依赖缺失不得被默认成功吞掉。

### A-P1-05：提问、Skills、事件持久化尚未完整接入

- `host.ts:71` 声明 `uiCapabilities:[]`，仅设置 approval handler，无 `setQuestionHandler`；白名单含 AskUserQuestion 不能证明“中途向律师提问”可用。官方工具 `askUserQuestionTool.ts:194–198` 交互不支持会返回明确错误。必须端到端测试问题出现、答复、取消、恢复与身份校验。
- manager `:174–181` 固定 `skillDirs:[]`，因此现有 manager 路径未装载签发法律 Skills。方案里的签发技能目录是目标，不是本轮可确认实现。
- `host.ts:169–187` 把事件正文截断到 2,000/4,000 字符；manager `:85–88` 又将任意 delta/text/content 拼成 outputText。需要明确最终输出与中间推理/工具事件的区分，避免重复、错序、截断污染成果；成果应采用结构化 artifact 事件、文件 hash 和事务完成记录。
- manager `:74–75` 的事件首先写内存数组。host 注释“先落账本再推界面”本身不是 durable persistence 证明；整体 executor 可能稍后轮询入账，需崩溃故障注入确认缺口。

### A-P1-06：取消、恢复与凭据范围要重做能力化验证

`agent-host-manager.ts:276–279` 仅杀一个进程，理由是 ZP-5 下无孙进程；但 sandbox.ts 已承认 direct child_process 不受 DI 管理。开放 Shell/MCP stdio/CU 后，这一假设必失效。需 Job Object/cgroup/可验证进程树终止，且先吊销 run capability，再取消模型/远程工具；远端已提交副作用需要补偿或对账，不能说杀进程等于撤销操作。

`executor.ts:731–732` 明确 agent_start/agent_wait 不落检查点，崩溃后整任务重跑。对六个只读工具可接受；对邮件发送、云盘写入、提交签章不成立。持久任务需要 checkpoint、工具幂等键、outbox、执行租约/fencing、恢复时权限重验和副作用回执。不可把上游后台 Agent 或 cron 直接当作多租户可靠调度器。

### A-P1-07：应用层配置由高权限目录保护不足

签名 agent profile 被复制进可写 home（manager:139），文件 mode 0444 并不等于拥有同用户权限的进程无法替换文件。agent 的可写状态与可信 config/profile/skill 分区必须分开；可信文件按制品 hash 只读挂载；执行前策略不能由模型可写文件决定。

## 6. “完整能力接入”的可实施定义与对照

完整是每项能力都有可用路径、权限与验收；不意味着律师任务默认拥有全部电脑权限。采用一个 Agent Runtime adapter，按能力 profile 加载同一引擎；保留原生语义，对副作用路径通过受控工具替换或适配。

| Kimi Code 能力 | 当前 demo | 生产要求 | 推荐边界 |
|---|---|---|---|
| 推理/工具循环/压缩 | 已嵌入，模型真实接口本次未调用 | 协议/压缩质量/取消/计费完整回归 | 云与本地共用 adapter |
| 计划/待办 | 白名单开放 | 与任务状态对应，不把自然语言 plan 当授权 | 任务级 |
| 用户提问/审批 | 审批前缀策略；提问未完整桥接 | 交互对象持久化，答复绑定 task/主体 | 控制面+客户端 |
| Skills | API 支持，manager 当前空列表 | 签名 registry、版本、依赖、来源和批准；内容不能自扩权 | 可信只读挂载 |
| MCP HTTP | 仅内核法律 MCP | 租户管理员批准 connector；对象级权限；OAuth refresh 存 vault | 独立 connector broker |
| MCP stdio | 被进程服务拒绝 | 独立沙箱 sidecar，固定镜像/命令/env，不继承用户完整 HOME | 本地/云工具执行器 |
| Read/Write/Edit/Glob/Grep | 关闭 | 临时工作区、输出目录、版本化编辑、symlink 与越界测试 | 文件 broker |
| Shell/脚本/Python | 关闭；v6 T2 设计中 | 受限代码执行可生成文书/表格；依赖预置；超时、内存、磁盘、网络预算 | 单任务沙箱 |
| WebSearch/Fetch | 关闭，由法律检索替代 | 公开检索与案情查询独立权限；查询会泄露语境，不能自动称匿名 | 搜索/抓取 broker |
| Agent/Subagent/Swarm | 关闭 | 真实子代理上下文、分工、结果汇总；子预算与子权限不大于父级 | 同事项隔离；禁止跨事项默认继承 |
| Background/Task/Wait | 关闭 | 持久任务 DAG、checkpoint；浏览器关闭可续跑，电脑关闭仅云/在线节点可续跑 | durable orchestrator |
| Cron/持续监测 | 原生关闭 | 仅已批准任务；到期、撤销、变更审批，低噪声通知 | 产品 scheduler |
| Hooks | 未接；上游异常可为空结果 | 观察型 hook 可开放；强制合规规则不可依赖 fail-open hook | 策略服务与异步事件总线分开 |
| 浏览器 | 未接 | 独立 profile；公开浏览器默认；登录态会话显式授予指定站点/事项/期限 | 云 browser 或本地 browser broker |
| Computer Use | 未接 | 指定应用/窗口；截屏数据去向展示；发送/提交/付款终审 | 单独高权限本地 broker |
| 文件/图片/视频/多模态 | Agent 当前只挂派生文本 | 分辨率、token、OCR、原图可用性与隐私测试 | 文档 pipeline+模型 broker |
| 会话持久化/导入导出 | 临时 HOME 任务后删 | 业务审计与运行检查点分开，保留期限可配置，加密恢复 | 事项账本+加密运行状态 |
| ACP/kap-server | 当前 SDK 路径不依赖 | 可作为适配选项，不能直接暴露未经租户鉴权的管理接口 | 内网/IPC |
| marketplace/自动更新/telemetry | 关闭/SDK不走 CLI | 管理员签名发布、分阶段更新、脱敏运维；不必向律师暴露原生市场 | 供应链控制面 |
| Remote Control | 关闭 | 如产品需要远程本机操作，用设备证书与自有审计桥；不上游 relay 默认开放 | 自有设备通道 |

对子代理的关键约束：父任务 permission 是上限；每次派发生成 attenuated token；限制模型、总 token、并发、深度、可见对象、目的地；子代理写入独立工作区，结果汇入前审查；最后签发只能由授权人完成。不能以“另开 N 个 Agent 进程”充当等价替代后就宣布完整 subagent 体验。

## 7. v5/v6 方案评审：保留什么、改什么

| 方案设计 | 优点 | 限制/修订 |
|---|---|---|
| 每任务宿主+短期令牌 | 状态与权限容易回收 | 需 OS 隔离与 job lease，重任务频繁启动性能需实测 |
| 客户原件在律所侧 | 适合强保密客户，原件版本可控 | 云模型仍接收内容；本地运行不等于内容不出本地；不得按 UI 运行位置替代数据流说明 |
| 无内置文件/Shell/子代理 | G0 最小风险原型合理 | 长期损失通用办公生产力；和用户完整能力要求冲突 |
| 法律 MCP 独立于模型 | 证据、引文、计算可确定性校验 | 当前只有六个工具，离完整办公/文书/尽调/协作工具体系有差距 |
| SDK DI 注入替代 kaos 参数 | 正确识别 v2 API 陷阱 | DI 注入不是安全沙箱；直连系统 API 需 OS 控制 |
| 临时 HOME | 避免加载律师个人配置 | 不能全删而丢失恢复上下文、预算和审计；持久层应受控保留 |
| v6 公开云沙箱 | 改善零服务器与离线工作体验 | 不应只按“公开/非公开”粗划分，上传获准案件也可在专属逻辑隔离云空间执行；高敏事项仍可策略禁云 |
| T2 Pyodide/wasm | 计算输入输出易收敛 | JS bridge、宿主 fetch、wheel 获取、文件桥都须关闭或代理；WASM 本身不自动无网；复杂 DOCX/PDF/Office 能力需原生受限镜像 |
| T5 无 Cookie 白名单浏览器 | 公开检索基线安全 | 法律数据库/内部系统需登录态，应另加站点受限模式；逐点击确认无法产品化，按会话授权、动作分类与提交确认 |
| 一个制品贯穿云/本地 | 语义容易一致 | 共享 domain/adapter/policy 契约，不必强求 Windows Office COM 与 Linux 沙箱完全相同二进制 |
| 6 周 G0 | 有必须/争取范围划分较务实 | 可完成受控演示，不是全量正式商用；Windows隔离、同步、Office保真、供应商合同与法律质量均为独立关键路径 |

### 推荐结构

控制面负责身份、授权、任务编排、预算、审计索引、产品计费。执行面可在“云租户隔离沙箱／本地设备／律所节点”选择，选择依据包括事项策略、对象位置、用户明确授权、所需能力与在线状态。模型推理位置单独标注；本地执行+云模型是独立模式。

模型只提出结构化工具请求。工具网关计算有效权限交集：平台安全基线 ∩ 租户策略 ∩ 事项授权 ∩ 用户角色 ∩ 任务授权 ∩ 工具作用域 ∩ 当前撤销/时限/预算状态。云执行器不能获得任意本地文件；本地桥也不能成为云端泛化 shell。通过“限定对象+限定动作+限定目的地+到期+nonce”的 capability bridge 调用。

跨执行域迁移必须生成新的授权决策：列明上传对象和派生内容、目的地、保留期、模型供应商与续跑条件。不能因为本机不可用就静默上传；同样不应每个低风险步骤都弹窗。

## 8. 生产验收与研发顺序

### P0：真实客户资料开放前

1. 确认供应商能力账本与合同覆盖；对未采购服务显示缺失，不能自动切到个人 OAuth。
2. 修复任务终态 bug、sandbox 路径问题；启动器达到声明的 OS 隔离等级。由独立安全测试检查 raw socket、DNS、显式 dispatcher、child process、持久化 fs、symlink/reparse/TOCTOU。
3. 端到端的事项与租户隔离：每个工具 endpoint 用对象 ID 查权限，不能相信模型传来的 tenant_id；工具调用时动态重验撤权。
4. 可信 agent/config/skill 与任务可写目录分离；禁止案件文档触发项目指令、MCP、插件或 Hook 自动安装。
5. 将全部外发、覆盖、提交、删除、共享、签章动作设计为预览对象+版本 hash+目的地/受众+显式批准；审批过期或内容改变必须重新批准。
6. 云/本地/模型/connector 的日志、缓存、临时文件与备份真实数据流图及故障路径验证；关闭遥测不等于所有内容日志已关闭。
7. 建立预算原子预占、父子预算、取消后结算、供应商 usage 对账；禁止无限自动重试与超额继续。

### P1：完整能力商用前

1. 完成提问、技能、子代理、sandbox files/shell、搜索、浏览器的真实受控路径；不以 disabled 充当 completed。
2. durable orchestrator：断网、关页面、重启、关机、设备撤销、限额与待批准恢复；副作用幂等；终态不可歧义。
3. Windows/macOS/Linux 分别实测；Node/Electron/原生模块与 Office 版本锁定；只声称已过矩阵的平台。
4. vendor 可复现构建+SBOM+签名+升级回归；原生辅助二进制独立审计。
5. 文档质量：修订保真、引用可定位、计算可复算、长文不漏检、提取置信度和成果完整性。Agent 能完成运行不等于法律成果合格。

### 最小探针集

- 任意本地文件/目录、越界符号链接、Windows junction、大小写/UNC/长路径、检查后替换；必须拒绝且不返回片段。
- HTTP/HTTPS/WS/DNS/raw socket/自建 undici dispatcher/子进程代理；未授权出站必须 OS 层失败。
- malicious PDF/网页/AGENTS.md/skill/MCP 声明：不能改变租户、模型 provider、工具清单与目的地。
- 子代理跨事项、无限递归、预算耗尽、父任务取消与租户撤权；必须立即停止新增调用并保留可解释状态。
- 待批准时换文件/受众/策略，审批结果重放；必须拒绝。
- timeout、模型 length 截断、非零 exit、工具失败、最终 artifact 不存在：不得标 succeeded。
- 断电前后外发重试、任务租约争抢：不能重复发送/提交。
- 无已付费 API 调用也可完成隔离与失败路径验收；协议与真实效果再以获准样本、独立预算执行。

## 9. 本次验证记录与局限

完成：官方网页与 raw 源码核验；官方 commits/compare API；本地源码和 vendor 特征检查；两项纯合成路径探针。未执行真实模型、未测 Windows OS 沙箱、未重编 vendor、未实测所有 Kimi 官方外部服务、未对 SaaS 上线做渗透或法律验收。本次没有修改产品代码。

最重要的后续决策是：保留 v5 的事项权限与证据内核，采用 v6 的 SaaS 服务形态，但以“完整受控能力”重建执行层；发布承诺以能力账本、验收证据和明确的第三方服务合同为准。
