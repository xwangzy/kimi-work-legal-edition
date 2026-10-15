# 调研 Y3：Kimi Code 集成增量核查（2026-10-14，只读）

> 范围：上游增量（10-13 核查之后）、能力清单复核（前端交互—后端执行—工具调用—任务状态闭环）、K7 剩余 / K8 / K9 及新缺口的实施规格、Windows 稳定性与引擎漂移检测。
> 基线：10-13 核查 `platform/docs/audit-2026-10-13/kimi-code-集成核查.md`（对照上游 main `afd95f64a`，锁版 `f67e6398f` = 2.1.1）；实施记录 `platform/docs/audit-2026-10-13/00-审计结论与实施路径.md` K 节（第 50–58 行）。
> 方法：GitHub REST API（compare / commits / pulls）+ 本仓源码与测试阅读。未修改代码，未跑全量测试。

## 0. 结论先行

| # | 结论 | 级别 | 出处 |
|---|---|---|---|
| 1 | **上游增量很小且无需回移**：10-13 核查对照的 `afd95f64a` 之后 main 只多 4 个提交（`c69bd6c5a`/`b510fa9ae` 遥控设备管理，`e4c99a3ba` select_tools 失败说明，`3f0857eb7` 插件技能限定名），无安全修复、无我方已开放能力的缺陷修复；仍无新 release（2.2.0 release PR #4053 未合） | — | §1.1 |
| 2 | **`start.ts` 一天内第二次变化**（`c69bd6c5a` 改 `clientVersion`/新增遥控设备客户端），`embed.ts` 仍无任何漂移检测 → K9-2 漂移报警应从 P2 上调为 P1 | P1 | §1.1、§3.6 |
| 3 | **最需要盯的上游变化是未合并的 #4193**（步内多个大工具结果撑爆上下文、压缩请求自身超限 → 运行失败）：K3 把材料快照放到 200 万字后，我方 26 万窗口正好落在该缺陷路径上 | P1 | §1.3、§3.5 |
| 4 | **10-13 的 6 项“引擎有、产品没接”已闭环 4 项**：工作区产物入库（K1）、13 个签名方法模板（K2）、追问续接（K7）、流式回复（K7）均在代码中核实；其中流式回复**没有任何测试** | — | §2.1 |
| 5 | **仍未闭环 5 项**：TodoList、子 Agent/集群可见、上下文压缩、NotifyUser、后台任务——根因相同：宿主事件映射（`kap-host/src/runtime.ts:492-578`）只有固定 switch，`subagent.*`/`compaction.*`/`task.*`/TodoList 参数都不出宿主。建议用一个 `run.progress` 快照通道一次补齐（K7-P） | P1 | §2.2、§3.4 |
| 6 | **两处 10-13 已指出、至今未修的缺陷**：AgentSwarm 一次调用只计 1 个子 Agent 预算（`policy.ts:315,357-362`）；取消先取版本再取消、冲突被吞（`kap-agent-client.ts:462-472`）。都小于 50 行，应最先做 | P1 | §3.1、§3.2 |
| 7 | **K8 5 组回移均未实施**（fork 工作树只有 ZP 改动、`BUILD.json` 仍是 `f67e6398f`）；NotifyUser 只需在 `embed.ts` 声明一行 `uiCapabilities`（锁版已有 `notifyUserAvailability.ts` 闸门）。若 2.2.0 两周内发布，建议直接整体 rebase | P1/P2 | §1.2、§3.3 |
| 8 | **SDK 宿主仍在**：内核始终构造 `sdkAgentClient`（`kernel/src/index.ts:273`），落盘加密为必需时才禁用（`:291`）；Electron 仍传 `agentHostEntry`（`main.cjs:127,164`），`electron/**` 打包会带上残留制品；7 个内核测试仍跑 SDK 路径 | P2 | §3.6 |
| 9 | **Windows 新增两项 P1 风险**：命名管道名只含律所标识（`kernel/src/config.ts:62`），RDS/云桌面同机多律师会互相占用导致第二人 Agent 不可用；进程树终止只靠 IPC 断开级联，无父进程看门狗与残留进程清理 | P1 | §4.1 WR-1、WR-3 |

**建议实施顺序**：K7-4 集群预算 → N-1 取消竞态 → K9-2 漂移报警 → K8-1/K8-3（或 2.2.0 rebase）→ K7-P 过程事件通道（含 TodoList/子任务/NotifyUser/后台任务）→ K7-3 压缩验收（含 #4193 场景）→ WR-1/WR-3 → K9-1 SDK 宿主退役。合计约 1,500–1,800 行（不含上游回移与删除）。

---

## 1. 上游增量（`afd95f64a` → main `b510fa9ae`，2026-10-13 09:40Z – 11:58Z）

`GET /repos/MoonshotAI/kimi-code/compare/afd95f64a...main`：领先 **4** 个提交、落后 0，49 个文件。截至 2026-10-14 main 头仍是 `b510fa9aec85`（10-13 11:58Z）；最新 release 仍是 `@moonshot-ai/kimi-code@2.1.1`（2026-09-24），release PR #4053（`2.2.0`，含 NotifyUser #4159、续接读图 #4154、不发默认 max_tokens 等 changeset）仍为 open。

### 1.1 新提交逐个判定

| 提交 | 内容 | 触及文件（要点） | 分类 | 与我方关系 | 回移？ | 代价 | 对 ZP 冲突风险 |
|---|---|---|---|---|---|---|---|
| `c69bd6c5a` #4169 | 遥控设备管理（设备列表/停用；分享链接带平台来源 `urlSource`；停用本机时关隧道） | `kap-server/src/routes/remoteControl.ts`(+281)、`routes/oauth.ts`(+128)、`protocol/rest-remote-control.ts`(新)、`remote-control/src/device-client.ts`(新 317 行，调云 API)、**`kap-server/src/start.ts`**(+13/−2)、`registerApiV1Routes.ts` | 无关（遥控/OAuth 我方关闭，ZP-8/19/21） | `embed.ts` 只注册 9 组路由（`third_party/kimi-code/packages/kap-server/src/embed.ts:29-37,166-176`），不引用 `registerApiV1Routes`/`remote-control`；但 **`start.ts` 又一次变化**（`clientVersion` 改为 `hostIdentity.productName/version`、新增 `RemoteControlDeviceClient`），属于 embed.ts 漂移源（R2） | 否 | 0 | 无直接冲突；**整体 rebase 时 `static-surface.test.ts` 若扫描到 `device-client.ts` 的 fetch 入口会报警**（设计上的报警，需确认未进入 embed 制品） |
| `e4c99a3ba` #4190 | `select_tools` 区分“会话不可用”与“策略拒绝”、解释失败原因、空可加载集只播报一次；`IAgentToolPolicyService` 新增 `isToolDenied`/`getPolicyFingerprint` | `agent/toolSelect/*`、`agent/toolPolicy/toolPolicy.ts`、`toolPolicyService.ts`(+25) | 引擎行为 | 我方 TOOL_SELECT 实验开关锁关（`packages/kap-host/src/engine-config.ts:38-52`），宿主策略对 `select_tools` 一律拒绝；接口新增两个方法——**我方若有自实现 `IAgentToolPolicyService` 的种子会编译失败**（经查 kap-host 未替换该服务） | 否（随 rebase） | 0 | 低：`toolPolicyService.ts` 不是 ZP-4 的 `permissionPolicyService.ts` |
| `3f0857eb7` #4188 | 插件技能以 `插件:技能` 限定名注册；插件名校验放宽 | `features/skill/catalog/registry.ts`(+20/−8)、`skill/tools/skill.ts`（描述文案）、`app/plugin/types.ts`（`PLUGIN_NAME_REGEX`） | 引擎行为（技能目录） | 我方技能经 `skillDirs` 可信区加载、无插件（`plugin===undefined` 分支行为不变）；Skill 工具描述改为“从当前清单逐字复制名称”——对 13 个签名方法模板的中文/连字符名称是**利好**（降低模型拼错名） | 可选（P2，仅描述一行） | ≈1 行 | 低：ZP-18 补丁在 `skill/workspace/rootFileSkillSource.ts`、`skill/catalog/userFileSkillSource.ts`，与 `registry.ts` 同目录不同文件；回归“工作区技能不加载”用例 |
| `b510fa9ae` #4192 | 遥控设备删除（与本机隧道协调） | `remoteControl.ts`、`device-client.ts` | 无关 | 同 #4169 | 否 | 0 | 无 |

**结论**：本期增量 **无安全修复、无我方已开放能力的引擎缺陷修复**，不需要回移；唯一需要处理的是 **`start.ts` 第二次变化**（10-13 前的 `0a3a2fbaf` 已改种子），进一步证明 K9“embed.ts 漂移报警”应尽快落地（规格见 §3 K9-2）。

### 1.2 10-13 建议的 5 组回移：仍未实施（K8 = ⬜ 属实）

fork 工作树（`third_party/kimi-code`，HEAD `f67e6398f`）`git status` 只有 ZP 补丁文件被改动，`mediaToolsRegistrar.ts`、WaitFor、`max_tokens`、headers 超时、NotifyUser 相关文件均未改；`BUILD.json` `upstream_commit` 仍为 `f67e6398f`、`built_at` 2026-10-13T08:55Z（`packages/kap-host/vendor/kap-embed/BUILD.json`）。5 组的处置与规格见 §3 K8。

### 1.3 上游未合并、需跟踪的 PR（按与我方相关度）

| PR | 状态（10-14） | 内容 | 与我方关系 | 建议 |
|---|---|---|---|---|
| **#4193** | open（10-13 建） | 防止**同一步内多个大工具结果**撑爆上下文：步内工具结果预算、Read 结果去掉 `spillExempt` 豁免、token 估算按高熵 1.5 字符/token 校正、未声明窗口时压缩闸门不再全关；改 `fullCompactionService.ts`(+108)、`toolResultTruncationService.ts`(+118)、`readTool.ts` | **高**：K3 把材料快照上限提到 200 万字（`executor.ts` `snapshotText`），模型并发 Read 多份长卷宗时正是该 PR 的复现路径（压缩请求本身超限 → `compaction.failed` → 运行失败）；我方 `max_context_size: 262144`（`engine-config.ts:89-98`）窗口更小，更易触发；中文 token 密度也让 4 字符/token 估算失真 | **合并后第一时间回移（P1）**；合并前先在 §3 K7-3 的压缩验收测试里覆盖“并发 Read 3 份 30 万字材料”场景，确认失败形态 |
| #4185 | open | 转义的 `\*`、`\?` 在 glob 中按字面匹配（`_base/execEnv/globPattern.ts` 1 行） | 中：Glob 经宿主内检索（`kap-host/src/search/`，ZP-20/D-56），需确认我方实现对转义的处理与上游合并后一致（`search-diff.test.ts` 与 ripgrep 15 差分） | 合并后回移并在 `search-diff.test.ts` 加转义用例 |
| #2511 | open（08-01 建） | Edit 用空 `new_string` 删除 ≥3 行时拒绝，除非 `allow_large_delete=true` | 中：防止 Agent 误删律师工作区文件大段内容（文件历史可回滚，但 rollback 未开放，见 §2） | 合并后回移（P2） |
| #4019 | open | `/reload` 后以 system-reminder 告知 AGENTS.md / 技能 / 子 Agent profile 变化 | 低-中：签名方法包热更新时（K2）模型可感知；我方每事项引擎在新运行时重建，暂不依赖 | 跟踪 |
| #4115 / #4062 / #2337 | open | OS 沙箱 + 出网控制 / SSH·Docker 远程执行 / 遵从配置的权限规则 | #4115 与我方 W 执行域思路重合但实现不同；#2337 若合并会改权限链语义，**须回归 ZP-4 首位** | 跟踪；#2337 合并即复核 |
| #4070（后台子 Agent 审批旁路） | API 返回 Not Found（可能已删除/转为 issue） | — | ZP-4 在每个 Agent 作用域首位已兜底 | 从跟踪表移除，改为跟踪 #2337 |
| #3799 / #4200 / #2516 / #2510 / #4120 | open | TUI 折叠、会话标题、遥测路径脱敏、WSL 粘贴图、MCP 错误折叠 | 无关（TUI/遥测关） | 忽略 |

### 1.4 整体 rebase 冲突点（较 10-13 无新增）

仍为：ZP-17 `features/tower/protocol/git.ts`（上游 `09af3b483`/`c9f01f073`）、ZP-5/6 `node-sdk/src/sdk-rpc-client-v2.ts`、revert #4059、`static-surface.test.ts` 白名单（Tower 新工具、`bashGuard.ts`）、`embed.ts` ↔ `start.ts` 种子漂移。本期 4 个提交**不新增**冲突文件。建议在上游发布 2.2.0（#4053 合并）后做一次整体 rebase，而不是继续在 2.1.1 上叠 cherry-pick（见 §3 K8 的取舍）。

---

## 2. 能力清单复核（kap 引擎路径；以 10-14 工作树为准）

判定口径沿用 10-13：**E2E** = 律师在桌面可触发、结果在界面可见、且有端到端测试；**部分** = 引擎内可用或有测试，但链路某段未接/界面不可见/无测试；**未实现**；**关闭** = 有意关闭。能力账本自评见 `packages/kap-host/src/capabilities.ts`（`current` 字段）。

### 2.1 能力 × 现状

| 能力 | 10-13 | 10-14 现状 | 证据（文件:行 / 测试标题） | 剩余缺口 |
|---|---|---|---|---|
| 模型流式输出 | 部分 | **部分（界面已通、无测试）** | 宿主 `runtime.ts:498-511` 主 Agent 文字尾部 ≤4,000 字、≥300 ms 经 `onRunText` 交内核；内核 `kap-agent-client.ts:154` 存 `liveText`、`:499-502` 随 `runs.interactions` 返回；`RunView.tsx:297-301,596-599`“正在起草…”。**全仓测试无 `live_text`/`liveText` 断言**（`grep` 0 命中） | 补测试（§3 K7-0）；子 Agent 文字不转发（`runtime.ts:490-491` 只认 main） |
| 工具调用 Read/Write/Edit/Glob/Grep | 部分 | **E2E（policy_limited）** | `tool-table.ts`；Grep/Glob 宿主内检索 `kap-host/src/search/`；kap-a1“落盘加密第 2 步 S1：计划、Read/Grep/Glob/Write/Edit、提问、后台与前台 Bash 在密文工作区…正常工作”；`search-diff.test.ts` 与 ripgrep 差分 | Edit 大段删除无保护（上游 #2511 未合） |
| 材料快照 | 截断 2 万字 | **已修（K3）** | 快照按解析全文、上限 200 万字、超限末尾注明（`executor.ts` `snapshotText`/`fullText`） | 大材料并发 Read 的上下文溢出（上游 #4193，见 §1.3）未验收 |
| Bash / Python（W 执行域） | 部分 | **部分（本机 E2E，Windows 未实机）** | `exec-router.ts`；`p2-w-domain.test.ts` 10 个用例（“Bash 经 DI 进入 W-core”“前台超时转后台”“取消传播到执行域”“S3-16…”“S3-28…”“工厂失败 → Bash 对模型不可见”）；随包运行时（K6）`scripts/build-runtime.mjs`、`fetch-win-runtime.mjs`（本次工作树有改动） | Windows 真机矩阵（W4–W7 待授权） |
| 工作区产物入库 | 断开（P0） | **E2E（K1）** | `kernel/src/executor/workspace-artifacts.ts`（160 行）；kap-a1“A1 工作区产物入库…未改动的旧文件与不支持的格式不登记”；DOCX/XLSX 应用内预览 `artifacts.render_html`（U3） | 删除/重命名不登记（只登记新增与改动，设计取舍）；回滚未开放 |
| 计划模式 | E2E | **E2E** | `runtime.ts:440,472` 新任务默认先出计划、追问缺省不进；P1“先出计划（第 02 篇 §9.3…）” | 计划正文执行后不留存为成果（未变） |
| 待办 TodoList / SetTodoList | 部分 | **部分（未变）** | `tool-table.ts:54-55` 放行（UI 级）；宿主只转发 `tool.call.started` 的 `tool/description/agent_id`（`runtime.ts:514`），**不带 `args`**——待办条目不出宿主；`RunView.tsx:29` 只把工具名译为“任务清单”；账本 `capabilities.ts:99` pending | §3 K7-1 |
| 提问 AskUserQuestion | E2E | **E2E（进程内）** | `runtime.ts:529-538`；`RunView.tsx` `QuestionCardView`；P1“提问：答复带状态版本（乐观并发）…” | 宿主退出即作废、任务判失败（`kap-agent-client.ts:206-224`，复核 S5-B03 有意为之）；问题不持久化（账本 `capabilities.ts:105-108`） |
| 审批（确认卡） | E2E | **E2E** | `policy.ts`；`runtime.ts:581-620`；P1“审批：批准绑定对象 hash…”“批准人渠道（审查 S2-05）”；`s2-regressions.test.ts` S2-02/S2-03/S2-15/S2-17 | 手机设备签名（D-24） |
| 进度通知 NotifyUser | 未生效 | **未生效（未变）** | 开关锁开 `engine-config.ts:51`；`embed.ts` 无 `uiCapabilities`（`grep` 0 命中）；账本 `capabilities.ts:115-118` 自述 | §3 K8-5 |
| 子 Agent `Agent` | 部分 | **部分（未变）** | 宿主策略裁决 `policy.ts:315`；P1“裁决来源：遍历全部内置工具（含子 Agent 与集群作用域）”“S2-01 运行生命周期：派出后台子 Agent…”“P1 MCP（子 Agent 作用域）”；界面只在工具步骤上挂“子任务 {agent_id}”标签（`RunView.tsx:116,581`），**`subagent.spawned/completed/failed` 未转发**（`runtime.ts:492-578` 无对应 case） | §3 K7-2 |
| Agent 集群 AgentSwarm | 部分 | **部分（预算缺陷未修）** | `policy.ts:315,357-362`：`consumeBudget(state, true)` 每次调用只 `subagents += 1`；上游 `AgentSwarm` 输入 `items`（≤`MAX_AGENT_SWARM_SUBAGENTS`）+ `resume_agent_ids`（`agent-core-v2/src/features/swarm/tools/agent-swarm/agent-swarm.ts:32-49`）。一次集群 = N 个成员，只计 1 | §3 K7-4 |
| 目标 Goal / 定时 Cron | 关闭 | **关闭** | P1“S2-01 目标模式在 G0 失败关闭”；账本 `capabilities.ts:223-226,291` | 设计如此 |
| 后台任务 TaskList/Output/Stop/WaitFor | 部分 | **部分** | P2“前台超时转后台…运行等后台任务结束才收尾”；`RunView.tsx:30-32` 只有工具名中文；`task.started/terminated`、`background.task.*` 未转发 | 无后台任务面板；WaitFor 90 秒未回移（K8-2） |
| 会话续接—追问 | 未实现 | **E2E（K7）** | `runtime.ts:398-408`（`continue_session_id`，本事项引擎内查找，找不到先 `restore`）；kap-a1“追问（Kimi Code 集成核查 P1-1）…跨事项与未完成的任务不能追问”；`RunView.tsx:435-470,667-688` | 续接后首回合读图缺陷（上游 #4154，K8-1）未回移 |
| 会话续接—宿主重启后续跑 | 未实现 | **未实现（有意失败收尾）** | 宿主退出 → 在途任务 `failed/host_exited`（`kap-agent-client.ts:212-221`）；只有“追问”路径会 `restore` | 律师需“重新运行”（K5 已给出口）；未在途的已完成会话可追问 |
| 分叉 / 导出 | 未实现 | **未实现** | 路由不在白名单（`kap-client.ts`） | G1 |
| 上下文压缩 | 未验收 | **未验收、不可见（未变）** | `engine-config.ts:89-98` `max_context_size: 262144`；`compaction.*` 4 类事件上游已广播（`kap-server/src/transport/ws/v1/sessionEventBroadcaster.ts:1256-1259`；载荷含 `tokensBefore/After/summary/droppedCount`，`protocol/events-zod.ts:456-464,940-962`），宿主不转发；全仓无压缩测试；账本 `capabilities.ts:88` pending | §3 K7-3 |
| 撤销 / 文件历史回滚 | 部分 | **部分（未变）** | `runtime.ts:805`（`artifacts()` 可读）、`:818-819` `rollback()` 抛 `unavailable` | G1；律师侧以“成果版本”替代 |
| 技能 Skill | 名义开放实际为空 | **E2E（K2，13 个签名方法模板）** | `content/skills/`（13 个目录 + `AGENTS.md` + `build-skills.mjs`）；内核验签物化 `kernel/src/skills-bundle.ts`；宿主可信区 `kap-host/src/main.ts:49-50,131`、`matter-engine.ts:134,139,209`；`skills-bundle.test.ts`（“有效签名包物化为只读可信区：AGENTS.md 与五个方法模板”“改动任一文件、多出清单外文件、签名不符：整包拒载”“已物化目录被改动…重新物化”）；kap-a1“方法模板（Kimi Code Skills，核查 P0-5）…工作区里的技能不加载”；`runs.start` 接受 `skill` | 测试标题仍写“五个”，与 13 个不符（断言是否只核子集需核对）；`skill.activated` 事件未转发（界面看不到“已加载方法模板 X”）；资深律师审校与盲测未做 |
| Agent profiles（legal-agent.md） | kap 路径未用 | **未用（以可信区 AGENTS.md 替代）** | `matter-engine.ts:210` `agentFiles: []` | 可接受：产品准则走 ZP-18 可信指令通道 |
| 工作区指令 AGENTS.md（ZP-18） | E2E（安全面） | **E2E** | P1“ZP-18：写入工作区的 AGENTS.md 不被新会话加载；可信区（签名方法包）的指令照常加载” | — |
| MCP（法律 MCP） | E2E | **E2E** | P1“P1 MCP…”“P1 MCP（子 Agent 作用域，复核条件 2）”；`scripts/dev-mock-scenarios.mjs:25-59`（`mcp__legal__materials_list` → `materials_read_excerpt` → `riskcards_submit`） | 律所 MCP 通道（D-39） |
| 联网 WebSearch / FetchURL | 部分 | **部分（本机通过）** | kap-a1 第 1 用例断言工具面含 WebSearch/FetchURL；`kernel/test/kap-gate.test.ts` | 真实上游额度 |
| 图像/视频 ReadMediaFile | 形同未用 | **形同未用** | 账本 `capabilities.ts:144` pending；ZP-22 拒绝本机路径附件 | #4154 未回移 |
| Hooks | 未实现 | **未实现（不依赖）** | 账本 `capabilities.ts:260` G2 | — |
| 终端 / 遥控 / OAuth / 遥测 / 插件市场 | 关闭 | **关闭** | ZP-8/12/19/21；P1“P1 路由…”“P1 端口…”；`static-surface.test.ts` | 上游 #4169/#4192 新增遥控设备路由，不注册 |

### 2.2 闭环核查：前端交互 → 后端执行 → 工具调用 → 任务状态

| 段 | 10-14 状态 | 证据 / 问题 |
|---|---|---|
| ① 桌面发起（含方法模板、追问） | 接通 | `RunSheet.tsx`（发起前预估与去向，`PendingStart` 带方法模板）；`RunView.tsx:435-470` 追问先估价再发起，`followup_of` |
| ② 内核 API → 队列 → kap-host IPC | 接通 | `kap-agent-client.ts:418`（`continue_session_id` 透传）；K4 独立信号量；`w1-wait.test.ts` 断言“等待律师期间导入材料不应被阻塞”（第 56–60 行） |
| ③ 引擎 → 宿主策略 → 执行域/检索/闸门 | 接通 | P1/P2/kap-gate/kap-a1 |
| ④ 事件回流（宿主 → 内核） | **部分** | 转发：turn 起止、工具起止（无参数）、审批、提问、错误、流式尾部；**不转发**：`SetTodoList` 参数、`subagent.*`、`compaction.*`、`task.*`/`background.task.*`、`skill.activated`、`agent.status.updated`、NotifyUser（`runtime.ts:492-578`） |
| ⑤ 内核时间线 | 白名单 13 类 | `executor.ts:816-830` `AGENT_TIMELINE_EVENTS`；`agent.turn_started`/`agent.turn_ended`/`agent.approval_resolved` 不在白名单（宿主推送的 `run.approval_resolved` 在内核被丢弃，界面靠 `runs.interactions` 轮询消卡，功能上无碍） |
| ⑥ 成果入库 | 接通（K1） | 终态文本 + 工作区新增/改动文件 |
| ⑦ 界面状态与操作 | 接通（K5） | 对账“已完成/未完成”逐项确认（`RunView.tsx:604-620`）+“重新运行”（`:624-628`，`api.retryRun` 带 `status_version`）；内核 `v9-defects.test.ts`“R-07 人工对账出口…”“F6 恢复…→ reconciling” |
| ⑧ 取消 | **仍有竞态（10-13 R5 未修）** | `kap-agent-client.ts:462-472`：先取 `state_version`、再 `cancel`，冲突被 `.catch(() => {})` 吞掉；未见于 K 节实施记录 |
| ⑨ 桌面测试 | 薄 | `apps/desktop/test/desktop-lib.test.ts` 只有纯函数用例（预览清洗、执行位置徽标）；RunView 的流式、追问、对账、确认卡无组件级测试 |

**小结**：10-13 的 6 个“引擎有、产品没接”中，**工作区产物、Skills、追问、流式**已闭环；**TodoList、子 Agent/集群可见与预算、上下文压缩、NotifyUser、后台任务** 5 项仍停在“引擎有、宿主不转发、界面不可见”。共同根因是宿主事件映射（`runtime.ts:492-578`）只有一张固定 switch，没有“过程事件”通道——§3 用一个统一的 `run.progress` 通道一次补齐，而不是五处各接一遍。

---

## 3. 缺口实施规格（按优先级）

### 3.0 优先级总表

| 序 | 编号 | 事项 | 级别 | 规模 | 依赖 | 理由 |
|---|---|---|---|---|---|---|
| 1 | **K7-4** | AgentSwarm 预算按成员计 | P1（安全/计费） | ~40 行 + 1 用例 | 无 | 现状一次集群可派出远超“每运行 2 个子任务”的成员；业务预算与点数估价失真 |
| 2 | **N-1**（新） | 取消竞态修复（10-13 R5 遗留） | P1 | ~30 行 + 1 用例 | 无 | 取消失败被吞，执行域命令可能跑到时限 |
| 3 | **K8-1/2/3/4** | 回移续接读图、不发默认 max_tokens、首包头超时、WaitFor 90 秒（引擎部分） | P1 | 上游 ~210 行（不含 TUI） | 无 | 追问已上线，#4154 直接影响追问后的读图；max_tokens 影响 MaaS 严格栈 |
| 4 | **K7-P** | 统一“过程事件”通道 `run.progress`（承载 K7-1 工作清单、K7-2 子任务、K7-3 压缩提示、K8-5 进度通知、后台任务、方法模板已加载） | P1 | 宿主 ~180 + 内核 ~120 + 桌面 ~250 行 | K8-5 需 embed.ts 一行 | 一次补齐 5 项“引擎有、界面没有” |
| 5 | **K7-3** | 上下文压缩验收（含 #4193 场景） | P1 | 测试 ~200 行 + 配置注入 ~20 行 | K7-P（可见性部分） | 200 万字快照 + 26 万窗口，压缩必然发生且未验收 |
| 6 | **K9-2** | `embed.ts` 漂移报警 | P1（上调） | ~60 行测试 | 无 | 上游 10-13 两次改 `start.ts`（`0a3a2fbaf`、`c69bd6c5a`），已出现静默漂移 |
| 7 | **K8-5** | NotifyUser 生效（embed.ts 声明 `uiCapabilities` + 上游两处 nudge 修正） | P2 | 补丁 2 行 + 上游 ~60 行 | K7-P | 律师可读的阶段进展 |
| 8 | **K7-0** | 流式回复补测试 | P2 | ~40 行 | 无 | 已上线但无测试 |
| 9 | **K9-1** | SDK 宿主退役 | P2 | 删除为主 + 7 个测试迁移 | 红队用例迁 P12 | 安装包仍可能带旧引擎；安全口径双轨 |
| 10 | N-2…N-5（新） | 技能测试标题与数量、`tool-table` 过时条目、`main.cjs` 过时注释、桌面组件测试 | P2/P3 | 小 | 无 | 见 §3.8 |

---

### 3.1 K7-4 AgentSwarm 预算按成员计（先做）

**改动**

| 文件 | 改法 |
|---|---|
| `packages/kap-host/src/policy.ts:315` | 计算成员数：`const n = req.toolName === "AgentSwarm" ? swarmMembers(req.args) : req.toolName === "Agent" ? 1 : 0`；`swarmMembers = (a) => (Array.isArray(a?.items) ? a.items.length : 0) + (a?.resume_agent_ids && typeof a.resume_agent_ids === "object" ? Object.keys(a.resume_agent_ids).length : 0)`；成员数为 0 或无法解析 → 按 `maxSubagents + 1` 计（失败关闭）。上游字段出处 `agent-core-v2/src/features/swarm/tools/agent-swarm/agent-swarm.ts:32-49` |
| `policy.ts:357-362` `consumeBudget(state, subagent: boolean)` | 改签名为 `consumeBudget(state, subagents: number)`：`if (subagents > 0 && state.subagents + subagents > state.ctx.budget.maxSubagents) return false; state.subagents += subagents;`（其余 4 个调用点传 0） |
| `policy.ts` `overBudget(...)` | 询问卡文案带成员数：见下 |
| `capabilities.ts:217` | 集群行 `current` 改 `policy_limited`，`evidenceTests` 登记新用例名 |

**界面文案（确认卡，超预算时）**：标题“这一步要同时派出 {n} 个子任务”；正文“本任务的子任务额度还剩 {left} 个。继续会多消耗约 {points} 点。您可以：允许这一次 / 不允许（助手会改为逐项处理）”。不提供“本任务内都允许”（沿用 S2-02 口径：超预算询问永不按任务放行，`s2-regressions.test.ts:41`）。

**测试**
- `packages/kap-host/test/s2-regressions.test.ts` 新增纯策略用例“K7-4 集群按成员计预算”：`maxSubagents: 2`，`AgentSwarm {items:["一","二","三"]}` → `ask`（默认档）/`deny`（自动档）；`items` 两个 → 放行且 `state.subagents === 2`，随后一个 `Agent` → 超预算；`resume_agent_ids` 计入；`items` 缺失 → 拒绝。
- P1 已有 `AgentSwarm items:["一","二"]`（`p1-kap-host.test.ts:208`）恰好 = 2，需确认不因本改动转为询问（预算 2 时恰好放行）。

**风险**：上游后续若给 AgentSwarm 增加“按模板展开”的字段（如 `count`），成员数会被低估——用“无法解析即失败关闭”+ P1 遍历工具用例的参数快照兜底。

---

### 3.2 N-1 取消竞态（10-13 R5 遗留）

| 文件 | 改法 |
|---|---|
| `packages/kernel/src/executor/kap-agent-client.ts:462-472` `cancel()` | 循环最多 3 次：取 `state_version` → `cancel`；返回 `conflict` 时重取再试；仍失败 → 在 `task.events` 记 `agent.error {code:"cancel_unconfirmed"}`，并调用宿主新方法 `forceCancel(run_id)`（宿主侧不校验版本、只允许内核渠道） |
| `packages/kap-host/src/runtime.ts` 取消处（`:792` 起的 `cancel()`） | 新增 `forceCancel`：解绑会话 → `sessionAction(abort)` → 执行域按事项取消；只接受 `origin.channel === "kernel"` |
| `packages/kap-host/src/main.ts` | IPC 方法表加 `forceCancel` |

**测试**：`packages/kernel/test/w1.test.ts` 增“取消与确认卡同时到达”：脚本化模型第一步发出需确认的工具调用，测试在 `waiting_approval` 出现的同一刻调用 `runs.cancel` → 终态 `cancelled`，且之后 `cloud.model.seen` 不再增长、W 执行域无在途作业。

---

### 3.3 K8 上游选择性回移（在 2.1.1 上 cherry-pick；或等 2.2.0 整体 rebase）

| 组 | 提交 | 回移内容（只取引擎，不取 TUI） | 规模 | 触及 ZP？ | 回归 |
|---|---|---|---|---|---|
| K8-1 续接后读图 | `419aced0e` #4154 | `agent/media/mediaToolsRegistrar.ts` +8：订阅 `dispatcher.hooks.onDidRestore` 刷新媒体工具 | +8 | 否 | P1 新用例：`restore` 后工具面含 `ReadMediaFile`（策略仍为跨边界询问） |
| K8-2 WaitFor 90 秒 | `20a2cea72` #4061 | 只取 `agent/tools/task/task-wait/{taskWaitTool.ts,task-wait.ts,task-wait.md,task-wait-subagent.md}`（+83/−21）；TUI 的 `kimi-tui.ts` 等 ~250 行不取 | ~85 | 否 | `p2-w-domain.test.ts`“前台超时转后台…”“取消传播到执行域”；新用例：后台 Bash 120 秒，WaitFor 在 90 秒返回、运行不判终态 |
| K8-3 不发默认 max_tokens | `21406fb4c` #4091 | `llmRequesterService.ts`、`llm-adapter/model/completion-budget.ts`(−26)、`model.types.ts`、各 requester trait（12 文件 +68/−47） | ~115 | 否 | `kap-gate.test.ts`；断言网关收到的请求体无 `max_tokens`（`cloud.model.seen[*].max_tokens === undefined`），以及配置了上限时照发 |
| K8-4 首包头超时 | `c151d5a3d` #4092 | `human/llm/requester/timeout.ts`(新 123 行) + 三个 requester 各 +8 | ~150 | 否 | 宿主 `engine-config.ts` env 增 `KIMI_CODE_LLM_HEADERS_TIMEOUT_MS: "90000"`（经闸门→网关→上游三跳）；测试用假模型 `delayMs` 超时 → `run.error` 可重试、运行如实失败 |
| K8-5 NotifyUser | `0a3a2fbaf` #4159（取 `notify-user.ts/md`、`notifyUserTool.ts`、`profile-shared.ts`）、`7091138f5` #4153、`4fbe06544` #4054 | **ZP-19 补丁内**给 `embed.ts` 的 `bootstrap(...)` 加 `uiCapabilities: [NOTIFY_USER_UI_CAPABILITY]`（锁版已有 `features/notify/notifyUserAvailability.ts:6-10`，按 `bootstrap.args.uiCapabilities` 是否含 `update_panel` 判定；**只改这一行即可让工具注册**）；nudge 修正两提交 ~60 行 | 2 + ~60 | **是：ZP-19 `embed.ts`** | P1“遍历全部内置工具”须把 `NotifyUser` 纳入；`static-surface.test.ts` 不受影响 |
| （跟踪）K8-6 | #4193（未合并） | 步内工具结果预算、Read 去 `spillExempt`、token 估算校正 | ~250 | 否 | §3.5 压缩验收用例 |

**流程**：每组一个 cherry-pick → 重新导出 `third_party/patches/kimi-code-f67e6398f-zhongruan.patch`（台账 `PATCHES.md` 改为“基线 + 回移清单”两段，回移另列 `UP-1…UP-5` 编号，不与 ZP 混号）→ `node scripts/build-kap-embed.mjs` → `BUILD.json` 记 `backports: ["419aced0e", …]` → 跑 `static-surface`、P1、P2、`kap-gate`、`kap-a1`。
**取舍**：上游 2.2.0 release PR #4053 已包含上述全部 changeset；若 2.2.0 在 2 周内发布，**建议直接 rebase 到 2.2.0**（冲突点见 §1.4），省去 cherry-pick 的二次合并；否则先回移 K8-1/K8-3（最小、最直接影响追问与 MaaS）。

---

### 3.4 K7-P 统一“过程事件”通道（承载 K7-1/K7-2/K8-5/后台任务/方法模板）

**设计原则**：过程状态是“最新快照”，不是流水——像流式文字一样在内存里保留最新一份，经 `runs.interactions` 返回；只有里程碑（子任务派出/完成、压缩发生、方法模板加载）进账本时间线。内容先过令牌还原（界面侧，与 `liveText` 同一 `tokenMap`）。

**宿主（`packages/kap-host/src/runtime.ts:492-578` 增 case）**

| 引擎事件 | 条件 | 宿主动作 |
|---|---|---|
| `tool.call.started` 且 `name === "TodoList"`、`agentId === "main"`、`args.todos` 为数组 | 上游 schema：`todos?: {title, status: pending\|in_progress\|done}[]`（`features/todo/tools/todo-list/todo-list.ts:7-23`） | `run.progress.todo = todos.slice(0,30).map(t => ({ title: t.title.slice(0,120), status }))`；节流 300 ms 经 IPC `{t:"progress", run_id, progress}` 发内核；**不进时间线** |
| `subagent.spawned` | 载荷 `subagentId, subagentName, description, swarmIndex, runInBackground, model, parentToolCallId`（`kap-server/src/protocol/events-zod.ts:893-907`） | `progress.subagents[subagentId] = {name, description(≤200), status:"running", swarm_index, background, parent_tool_call_id}`；`push(run, "run.subagent", {subagent_id, event:"spawned", …})` |
| `subagent.completed/failed/cancelled/suspended` | `resultSummary`、`error`、`usage` | 更新状态；`resultSummary` 截 1,000 字放进 `progress`（界面展开时看），时间线只记 `{subagent_id, event, tokens}` |
| `compaction.started/completed/blocked/cancelled` | `trigger: manual\|auto`、`result.{tokensBefore,tokensAfter,compactedCount,droppedCount}`（`events-zod.ts:456-464,940-962`） | `push(run, "run.compaction", {event, trigger, tokens_before, tokens_after, dropped})`；**摘要正文不出宿主**（可能含材料原文，按密文落盘规则只留引擎内） |
| `task.started/terminated`、`background.task.*` | `info`（taskInfoSchema） | `progress.tasks[taskId] = {kind, description, status}` |
| `tool.call.started` 且 `name === "NotifyUser"` | `args.message`（+ 2.2.0 的标题字段） | `progress.notes.push({at, text≤300, agent_id})`，保留最近 5 条 |
| `skill.activated` | 技能名 | `push(run, "run.skill", {skill})`（只认已验签清单内名称） |

`RuntimeDeps` 增 `onRunProgress?(runId, progress)`；`main.ts:274` 旁增 `onRunProgress: (runId, p) => send({ t: "progress", run_id: runId, progress: p })`。

**内核**

| 文件 | 改法 |
|---|---|
| `kernel/src/executor/kap-agent-client.ts:151-156` | 新分支 `msg.t === "progress"`：`task.progress = sanitizeProgress(msg.progress)`（字段白名单、长度上限、只在 running/starting 时接受） |
| 同文件接口（`:81,111`） | `progress?: RunProgress`；`liveProgress(runId): RunProgress \| null` |
| `kernel/src/api/w1.ts:69` | `runs.interactions` 返回 `{ …, live_text, progress: d.kap?.liveProgress(run.run_id) ?? null }` |
| `executor/executor.ts:816-830` | 白名单加 `agent.subagent`、`agent.compaction`、`agent.skill`；`slimAgentPayload` 增对应 case（只留 ID、事件、计数） |

```ts
// kernel 与 desktop 共用的数据结构（放 packages/kernel/src/api/types.ts 或现有 W1 类型处）
interface RunProgress {
  todo: { title: string; status: "pending" | "in_progress" | "done" }[];
  subagents: { id: string; name: string; description: string; status: "running" | "done" | "failed" | "cancelled" | "paused"; swarm_index?: number; background: boolean; summary?: string }[];
  tasks: { id: string; kind: "bash" | "agent" | "other"; description: string; status: "running" | "done" | "failed" | "stopped" }[];
  notes: { at: string; text: string; agent_id: string }[];
  compaction: { count: number; last_at?: string; tokens_before?: number; tokens_after?: number; blocked?: boolean };
}
```

**桌面（`apps/desktop/src/pages/RunView.tsx`、`api.ts:353`）**

| 区块 | 位置 | 律师可见文案 |
|---|---|---|
| 工作清单 | 中栏“正在起草…”上方；有 `todo` 时显示 | 标题“助手的工作清单（{done}/{total}）”；条目前缀“✓ 已完成 / ● 进行中 / ○ 待做”；空态不显示 |
| 子任务 | 时间线里带 `子任务 {agent}` 标签的步骤（`RunView.tsx:581`）改为可展开分组 | 组头“子任务：{description}（{状态}）”；展开后“子任务的结论摘要”+ 其工具步骤；集群显示“同时进行 {n} 项核对”；失败显示“这个子任务没有完成：{error 的律师化说明}，主任务会继续” |
| 进展通知 | 工作清单下方，最近 3 条 | “助手进展：{text}” |
| 后台任务 | 右栏底部折叠 | “后台运行中（{n}）：{description}”；无“停止”按钮（TaskStop 仍走确认卡） |
| 压缩提示 | 时间线一行 | “对话较长，助手已把前面的内容整理成摘要继续工作（第 {count} 次）。材料原文仍在，结论请以引用的原文为准。”；`blocked` 时“对话过长，助手暂停整理，请把任务拆小或开新任务” |
| 方法模板 | 时间线一行 | “已按方法模板《{模板中文名}》执行” |

**测试**
- 宿主层（快）：`p1-kap-host.test.ts` 增“过程事件：TodoList、子 Agent 起止、NotifyUser 进入 progress；子 Agent 的文字不进流式”——用 `fake-model.ts` 的 `FakeStep { toolCalls }` 先发 `TodoList {todos:[…]}`，再 `Agent {…}`，断言 `onRunProgress` 收到的快照与 `run.subagent` 事件顺序。
- 端到端：`kernel/test/kap-a1.test.ts` 增用例（沿用 `cloud.model.script` 写法，第 100–110 行模式）：
  ```ts
  cloud.model.script = (body) => {
    const first = JSON.stringify(msgs(body).find((m) => m.role === "user")?.content ?? "");
    if (!first.includes("KAPPROG")) return null;
    const done = new Set(msgs(body).filter((m) => m.role === "tool").map((m) => m.tool_call_id));
    if (!done.has("todo1")) return { toolCalls: [{ id: "todo1", name: "TodoList", args: { todos: [{ title: "读合同", status: "in_progress" }, { title: "列风险", status: "pending" }] } }] };
    if (!done.has("sub1")) return { toolCalls: [{ id: "sub1", name: "Agent", args: { description: "核对第七条", prompt: "KAPPROG-SUB 核对保密条款" } }] };
    return { content: "完成" };
  };
  // 子 Agent 请求体同样经脚本：首条 user 含 "KAPPROG-SUB" → { content: "保密条款无异常" }
  ```
  运行中轮询 `runs.interactions`，断言 `progress.todo.length === 2`、`progress.subagents[0].status` 经历 `running → done`；终态后时间线含 `agent.subagent`（spawned/completed 各一）。注意 `plan_first: false, mode: "default"`（同追问用例第 188 行），否则先出计划。
- 桌面：`apps/desktop/test/` 新增 `run-progress.test.ts`（纯函数）：把 `RunProgress` 映射为展示行（文案、排序、空态不渲染、令牌还原）。

**风险**：① `TodoList` 标题可能含当事人信息——模型侧本就只见代号，界面用 `tokenMap` 还原，与 `liveText` 同口径；② 子 Agent `resultSummary` 可能很长，截断并标“已截断”；③ 上游事件名属 kap-server 协议（`events-zod.ts`），升级时由 §4.2 的漂移测试兜底。

---

### 3.5 K7-3 上下文压缩验收

**现状**：窗口 `max_context_size: 262144`（`engine-config.ts:89-98`）；触发由 `agent/fullCompaction/strategy.ts:19-21`（`triggerRatio 0.85`、`reservedContextSize 50,000`）与模型级 `compactionTriggerRatio`/`reservedContextSize`（`strategy.ts:92-100`）决定；压缩请求以 `compaction-instruction.md` 第 1 行“You are about to run out of context. Create a handoff summary…”开头。

**改动**
| 文件 | 改法 |
|---|---|
| `packages/kap-host/src/engine-config.ts` `EngineConfigSpec` | 增 `testContextOverride?: { max_context_size: number; reserved_context_size?: number }`，只在宿主 `config.testOverrides === true` 时生效；生产入口（`runtime-manifest.json` 存在或 `ZR_AT_REST=required`）一律忽略并记诊断。模型级键名须对照 `third_party/kimi-code/packages/agent-core-v2/docs/config-manifest.toml` 核定 |
| `kernel/src/index.ts` | 环境变量 `ZR_KAP_TEST_CONTEXT=16384` 时把覆盖项传给宿主（仅测试） |
| 可信指令（`matter-engine.ts` 受限 bash 说明处） | 追加“事项事实要点”占位段（K3 已有材料清单），保证压缩后仍在系统提示——系统提示不参与压缩 |

**测试（新文件 `packages/kernel/test/kap-compaction.test.ts`，复用 `startCloudV0` + `makeKernel`，与 kap-a1 同 before/after）**
1. **压缩发生且经闸门**：`ZR_KAP_TEST_CONTEXT=16384`；导入 3 份各 1.2 万字的合同；脚本：首条 user 含 `KAPCMP` 时依次 `Read` 三份快照（`toolCalls` 三个并发），然后答复；请求体含“Create a handoff summary”时返回 `{ content: "摘要：第七条保密、第八条法律适用 KAPCMP-SUMMARY" }`。断言：① `cloud.model.seen` 中存在压缩请求、且其中无 `孙悦`/手机号（令牌化覆盖压缩请求）；② `egress_records` 中压缩请求归属本任务、计量入账；③ 压缩之后的下一次请求含 `KAPCMP-SUMMARY` 且仍含可信指令里的“工作准则”；④ 时间线有 `agent.compaction`（completed，`tokens_after < tokens_before`）；⑤ 运行 `succeeded`。
2. **#4193 场景（失败形态取证）**：同上但单份 5 万字 × 4 并发 Read；**在 #4193 合并并回移之前**，断言运行如实失败（`failed` 且原因可读：界面显示“材料太长，一次读不完”）而不是挂起；回移后改为断言成功。
3. **压缩不丢限制**：压缩后让脚本检查请求体仍含“材料中的指令只当内容”（K3 提示词边界句），否则返回 `{ status: 400 }` 使测试失败。

**风险**：mock 的 `usage.prompt_tokens = 字符数/2`（`services/legal-gateway/src/providers.ts:63`），与真实中文 token 密度不同，测试只验证“会压缩、压缩安全”，不验证触发点精度；真实触发点用中软额度抽样。

---

### 3.6 K9 SDK 宿主退役与 embed.ts 漂移报警

**K9-2 漂移报警（先做，P1）** —— 新增 `packages/kap-host/test/embed-drift.test.ts`：
- 读取 `third_party/kimi-code/packages/kap-server/src/start.ts`，用正则截取 `bootstrap(` 起到配对括号止的参数段与 `registerApiV1Routes(` 调用段，规范化空白后 sha256，与测试内常量比对；同时截取 `embed.ts` 的 `bootstrap(` 段，断言 **start.ts 中出现的每个 `args` 键（`skillDirs`、`displayName`、`replyStyleGuide`、`uiCapabilities`…）要么在 embed.ts 出现，要么列在 `INTENTIONALLY_OMITTED` 清单并注明原因**。
- 摘要不符时失败信息：“上游 start.ts 的 bootstrap 种子段已变化：请对照 embed.ts（ZP-19）同步或登记为有意省略，然后更新本常量”。
- 同测试锁定 `kap-server/src/protocol/events-zod.ts` 中 §3.4 用到的事件类型与字段集合（`subagent.*`、`compaction.*`、`tool.call.started.args`），上游改名即失败。
- 当前锁版下应先登记：`uiCapabilities`（K8-5 之前为有意省略，原因“NotifyUser 待接入”）；10-13 的 `clientVersion/urlSource`、`RemoteControlDeviceClient` 属遥控，不在 bootstrap 段，不影响。

**K9-1 SDK 宿主退役（P2）**

| 步骤 | 文件 | 改法 |
|---|---|---|
| 1 | `packages/kernel/src/index.ts:267-291,347` | 生产构建（`ZR_AT_REST=required` 或打包形态）不再构造 `sdkAgentClient`；保留 `useSdkEngine` 仅在 `NODE_ENV=test` |
| 2 | `apps/desktop/electron/main.cjs:127,164` | 删除 `agentHostEntry` 传参；`electron-builder.yml` `files: electron/**` 会把残留的 `agent-host.bundle.mjs` 打进 asar——构建脚本 `scripts/package-desktop.mjs` 在暂存时显式排除并断言不存在 |
| 3 | 7 个仍用 `ZR_AGENT_ENGINE=sdk` 的内核测试（`secret-files`、`helpers`、`token-restore-audit`、`w1-restart`、`a1-lifecycle`、`cp-dispositions`、`t17-drill`） | 逐个判断：验证内核语义的改用 kap；只为对照 v5 的删除；`kernel/test/redteam.test.ts` 的 34 例迁到 P12 运行器（kap 路径） |
| 4 | `apps/agent-host/`、`kernel/src/executor/agent-host-manager.ts`（548 行）、ZP-5/6 补丁 | 最后删除；ZP-5/6 删除后整体 rebase 少一个冲突点（`node-sdk/src/sdk-rpc-client-v2.ts`） |

验证：全量回归；安装包内 `grep -c agent-core-v2` 只剩 kap-host 一份；体积约 −11 MB。风险：旧测试覆盖的内核路径（如 `w1-restart`）迁移时语义漂移——迁移前后各跑一次比对断言数。

---

### 3.7 K7-0 流式回复补测试

`kernel/test/kap-a1.test.ts` 增“流式：运行中 `runs.interactions.live_text` 出现主 Agent 文字尾部，终态后为 null；子 Agent 文字不出现”：脚本让主 Agent 先输出含 `KAPSTREAM-MAIN` 的文字并发起一个 `delayMs` 较长的工具调用（或用子 Agent 输出 `KAPSTREAM-SUB`），测试轮询 `runs.interactions`。注意 MockProvider 流式只分两块（`providers.ts:72-73`），足以触发一次 `assistant.delta`。

### 3.8 新发现的小缺口

| # | 问题 | 证据 | 处置 |
|---|---|---|---|
| N-2 | 技能测试标题与数量不符：“AGENTS.md 与五个方法模板”，实际 13 个 | `kernel/test/skills-bundle.test.ts:24`；`content/skills/` 13 个目录 | 改标题并断言清单数量 = 构建清单数量 |
| N-3 | 工具表有过时条目 `SetTodoList`；锁版工具名是 `TodoList` | `kap-host/src/tool-table.ts:55`；`agent-core-v2/src/features/todo/todoItem.ts:1` | 删除或注明“旧名兼容”；P1 遍历工具用例已能发现不存在的名字吗——建议断言工具表每个名字都在引擎注册表中 |
| N-4 | `main.cjs` 注释称“安装包随包制品尚未构建”，与 K6 已完成不符；生产仍按 `kap-host.bundle.mjs` 路径命名，而随包运行时是 `runtime/kap-host/main.mjs` | `apps/desktop/electron/main.cjs:130-131`；`electron/runtime-paths.cjs:8`；`scripts/build-runtime.mjs:125` | 核对打包形态实际使用哪条路径（runtime-paths 优先？），删掉过时分支 |
| N-5 | 桌面无组件级测试：流式、追问、对账、确认卡、工作清单 | `apps/desktop/test/` 5 个文件均为纯函数/配置 | 至少把 RunView 的“事件 → 步骤”映射（`RunView.tsx:100-160`）抽成纯函数并测 |
| N-6 | `skill.activated`、`agent.approval_resolved`、`agent.turn_*` 不进时间线 | `executor.ts:816-830` | 随 K7-P |
| N-7 | 子 Agent 模型来源审计：`secondary_model.force: true` 强制 K2.6，但无测试证明子 Agent 请求体 `model` 字段 | `engine-config.ts:101`；账本 `capabilities.ts:215` 自述未验证 | K7-P 端到端用例顺带断言子 Agent 请求的 `model` |

---

## 4. 稳定性风险

### 4.1 Windows 下 kap-host 已知风险

进程拓扑：Electron 主进程 →（`utilityProcess.fork`，`apps/desktop/electron/main.cjs:101`）内核 →（`child_process.fork`，`kernel/src/executor/kap-agent-client.ts:188-204`）kap-host →（`fork`，`packages/exec-wasm/src/host.ts:179-190`）W 监督进程 → `worker_threads`（`exec-wasm/src/supervisor.ts:76`）；宿主内检索为 kap-host 内 `Worker`（`kap-host/src/search/host-search.ts:142`）。内核 ↔ kap-host 为 Node IPC，kap-host → 内核法律工具与闸门走命名管道 / Unix 套接字（`kernel/src/config.ts:62` `\\.\pipe\kwl-<firmSlug>`；`kap-host/src/host-egress.ts:145-146`）。

| # | 风险 | 现状与证据 | 影响 | 建议 | 级别 |
|---|---|---|---|---|---|
| WR-1 | **命名管道名可预测、全局命名空间** | `\\.\pipe\kwl-${firmSlug}`（`kernel/src/config.ts:62`）；服务端有 bearer 鉴权（`local-server.ts:163`），但名字只含律所标识 | Windows 命名管道跨登录会话共享命名空间：**RDS/云桌面同一台机器两位律师（同律所）** 第二个内核绑定失败（libuv 以首实例方式创建 → `EADDRINUSE`）→ Agent 与法律工具全不可用；本机其他进程抢先建同名管道即拒绝服务 | 管道名加每用户随机段：`kwl-<firmSlug>-<sha256(userSID+installId).slice(0,16)>`，经 IPC 下发给 kap-host（已经是下发而非约定，改动只在 `config.ts`）；启动时管道被占用 → 显示“本机另一个账户正在使用 Kimi Work，请…”而非泛化错误。闸门管道同改（`egress-gate/src/main.ts:96,116`） | **P1** |
| WR-2 | 子进程控制台窗口 | 已处理：内核拉起 kap-host、W、OCR 均带 `windowsHide`（`kap-agent-client.ts:204` `...HIDE_WINDOW`、`exec-wasm/src/host.ts:190`、`parse-ocr/src/worker-client.ts:137`；说明见 `kernel/src/executor/child-env.ts:6`）；引擎内部 spawn 也默认 `windowsHide ?? true`（`vendor/kap-embed/kap-embed.mjs:181223`） | — | 静态测试：随包制品中所有 `fork(`/`spawn(` 调用点必须带 `windowsHide`（加到 `static-surface.test.ts`） | P3 |
| WR-3 | **进程树终止** | 依赖 IPC 断开级联：kap-host `process.on("disconnect")` 退出（`kap-host/src/main.ts:312`），W 监督进程同（`exec-wasm/src/supervisor.ts:203`）；W 卡死时 `SIGKILL`（`host.ts:205,250,392`）在 Windows 即 `TerminateProcess`，只杀直接子进程；v5 SDK 宿主才用 `taskkill /T /F`（`agent-host-manager.ts:120`） | 正常退出可靠；**风险在两种异常**：① 内核被强杀（任务管理器“结束任务”）时，若 kap-host 主线程正被同步计算阻塞（大文件解封、宿主内检索在主线程的部分），`disconnect` 迟到，W 进程与 Worker 继续占内存/CPU 直到回到事件循环；② Electron 主进程崩溃时 utilityProcess 子孙是否随 Chromium 作业对象回收，需真机确认 | ① kap-host 与 W 监督进程加“父进程看门狗”：每 2 s 检查 `process.ppid` 存活（Windows 上 `process.kill(ppid, 0)`），失联即 `process.exit`；② 内核启动时把 kap-host 的 pid 写入运行目录，下次启动发现残留 pid 且映像名为随包 node → 结束（防孤儿占用工作区句柄导致迁移/rename 失败）；③ Windows 真机用例：任务管理器结束 Electron → 5 s 内无残留 `node.exe` | **P1** |
| WR-4 | 杀软持有句柄 | `file-broker` 与 `sealed-storage` 的 rename 已用 `retryWin`（`broker.ts:169,537,597`；`sealed-storage.ts:95,468`）；**`sealed-storage.ts:134` 隔离改名 `rename(path, quarantine)` 未加重试** | 杀软扫描新写的 KWE1 文件（高熵，易被勒索防护盯上）时偶发 `EPERM/EBUSY` → 事项失败关闭 | 补 `:134` 重试；Defender + 360 + 火绒 + 腾讯电脑管家矩阵（W7）中专项：一次 Agent 运行写 20 个文件 + 会话转录追加 500 次无失败；随包 `node.exe` 与 `.mjs` 签名后再测（未签名的 node.exe 在国产杀软下易被拦截“可疑脚本宿主”） | P1 |
| WR-5 | 长路径（MAX_PATH 259） | broker 一律拒绝 > 259 字符（`file-broker/src/paths.ts:31,67`），失败关闭；数据根取 `realpathSync.native` 规范路径（`kap-host/src/main.ts:237-240`） | 引擎状态目录（`<APPDATA>\KimiWorkLegal\…\workspace\kap\<matter_id>\home\.kimi-code\sessions\<session_id>\…` + 文件历史）叠加长用户名与令牌化中文文件名（`〔自然人·XXXXXX〕…`）可能逼近上限 → 写入被拒，表现为“Agent 写不了文件” | ① 加“路径预算”测试：以 32 字符用户名 + 最长 matter/session ID 计算引擎目录、工作区、文件历史最深路径，断言 ≤ 200，余量留给律师文件名；② 拒绝时给模型可读的错误（“文件路径过长，请用更短的文件名”）并在时间线说明；③ 不建议开启 `LongPathsEnabled` 依赖（Office/资源管理器仍受限） | P2 |
| WR-6 | 短文件名（8.3）与目录联接 | 数据根用 `realpathSync.native`（会展开 8.3），但 `matter-engine.ts:114-116,132,134,139` 对子目录与可信区用 JS 版 `realpathSync`（不展开 8.3） | 可信区（内核物化的 skills 目录）若位于含 8.3 片段的路径，宿主算出的根与 broker 规范根不一致 → 技能目录被判区外、静默无技能（与 K1 联调中修过的同类缺陷一致） | `matter-engine.ts` 统一改 `realpathSync.native`；Windows 用例：`%TEMP%` 为 `C:\Users\LONGNA~1\…` 时技能清单非空 | P2 |
| WR-7 | 随包 Node 版本与 `--experimental-*` | 内核 fork kap-host 时 `execArgv: []`、`execPath: opts.runtime`（`kap-agent-client.ts:189-190`）；开发形态依赖 Node 26 原生剥离类型（`main.cjs:130`） | 开发与安装包两种形态的 Node 行为差异（类型剥离、`fetch`/undici 版本、`NODE_USE_ENV_PROXY`） | `a1-bundle` 冒烟在 Windows CI 上以随包 node.exe 跑一遍 kap 路径 | P2 |
| WR-8 | 时钟与睡眠 | 看门狗按墙钟 1 s 轮询（`runtime.ts:469`），工作时限冻结等待时间 | 笔记本合盖睡眠后醒来，墙钟跳变 → 运行被判 `run_wall_deadline_exceeded` | 用 `performance.now()`（单调钟）计算工作时限；墙钟只用于总时长上限与显示 | P3 |

### 4.2 引擎升级的漂移检测建议

| 层 | 检测什么 | 现有 | 建议新增 |
|---|---|---|---|
| 版本锁 | 制品对应的上游提交与补丁摘要 | `static-surface.test.ts:19`“制品锁定上游提交 f67e6398f（2.1.1）”；`vendor/kap-embed/BUILD.json`（`upstream_commit`、`patch_digest_sha256`、`bundle_sha256`） | `BUILD.json` 增 `backports: []`；测试断言 `PATCHES.md` 中的 ZP/UP 清单与补丁文件里出现的文件集合一致 |
| 启动种子 | `start.ts` 与 `embed.ts` 的 `bootstrap(...)` 参数段 | 无 | §3.6 K9-2 `embed-drift.test.ts`（摘要 + 键集合 + 有意省略清单） |
| 路由面 | 嵌入只注册 9 组路由 | P1“P1 路由…”；`embed.ts:166-176` | 上游 `kap-server/test/__snapshots__/apiSurface.snapshot.test.ts.snap` 在 rebase 时 diff 一次，新增路由逐条登记（本期 #4169 新增遥控设备路由即应登记为“不注册”） |
| 工具面 | 引擎注册的内置工具名集合 | P1“裁决来源：遍历全部内置工具…” | 断言 `tool-table.ts` 的名字集合 = 引擎注册表 ∪ 显式“已知不存在”清单（可抓出 N-3 `SetTodoList` 这类过时名，也能抓出上游新增工具未进工具表） |
| 事件面 | 宿主依赖的事件类型与字段 | 无 | K9-2 同测试锁定 `events-zod.ts` 的 `tool.call.started`、`subagent.*`、`compaction.*`、`turn.*`、`permission.approval.*`、`event.question.*` 字段集合 |
| 进程/网络入口 | `node:child_process`、网络模块、worker 导入者 | `static-surface.test.ts:24,32,46,74,81` | 加 `windowsHide` 检查（WR-2） |
| 行为面 | 关键行为回归 | P1/P2/kap-a1/kap-gate | 升级脚本 `scripts/upgrade-kimi-code.mjs`：拉上游 → 应用补丁（`git apply --3way`）→ 构建 → 依次跑 static-surface、embed-drift、P1、P2、kap-gate、kap-a1、kap-compaction；任何一步失败即停并输出冲突的 ZP 编号 |
| 上游观察 | 新提交、release、关键 PR | 人工 | 每周定时任务：`GET /compare/<locked>...main`，按路径前缀分级（`kap-server/src/start.ts`、`permissionPolicy/`、`features/skill/`、`fullCompaction/`、`toolExecutor/`、`node-sdk/` 为“必看”），并跟踪 #4193、#2337、#4053 状态 |

