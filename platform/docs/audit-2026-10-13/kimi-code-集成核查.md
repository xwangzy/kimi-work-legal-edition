# Kimi Code 集成核查（2026-10-13，只读审计）

> 范围：上游差异、能力清单对照、端到端闭环、重复实现与稳定性、补齐方案。基线：v9.1 第 04 篇 §2/§3、第 03 篇 §7；锁版 `f67e6398f`（2.1.1）。
> 方法：GitHub REST API（compare / commits）+ 本仓源码与测试阅读 + 单个测试文件运行。结论先行，证据带路径与行号。
> 本次实跑：`node --test packages/kap-host/test/p1-kap-host.test.ts`（15/15 通过）、`node --test packages/kernel/test/kap-a1.test.ts`（1/1 通过），Node v26.8.1。

## 0. 结论先行

| # | 结论 | 级别 |
|---|---|---|
| 1 | **安全面扎实**：kap-server 无端口嵌入、23 条路由白名单、宿主策略在每个 Agent 作用域首位、ZP 补丁与静态面检查都有测试并通过。能力问题集中在“引擎有、产品没接” | — |
| 2 | **成果闭环断开**：kap 路径只把 Agent 最终文本入库（`kap-agent-client.ts:276-280`）；Agent 在工作区写的 DOCX/XLSX/MD 从不入库、界面不可见，宿主已有的 `artifacts()` 无人调用 | P0 |
| 3 | **Skills 不可用**：生产入口 `kap-host/src/main.ts:105-109` 不给 `trustedDir` → `skillDirs=[]`；仓内没有任何技能内容（`content/` 无 skills）。桌面“方法库”是确定性工作流，不是 Kimi Code Skills | P0 |
| 4 | **提示词与材料把开放能力“自我封印”**：A1 目标写死“只能使用法律工具”；每份材料截断 20,000 字且不告知模型 | P0 |
| 5 | **全局 ioMutex 被 Agent 运行全程占用**（含等待律师），材料导入/OCR 与其他事项任务被阻塞 | P0 |
| 6 | **对账/重试无界面出口**：内核有 `runs.reconcile`/`runs.retry`，桌面未封装，`reconciling` 被当作终态 | P0 |
| 7 | **会话续接未实现**（每运行新建会话、无追问、无重启恢复）；**上下文压缩**为引擎原生自动触发但未验收、不可见；**子 Agent** 引擎内可用、受策略裁决，但界面不可展开，Swarm 预算按调用计 1 | P1 |
| 8 | **两套引擎并存**（SDK 宿主 + kap 引擎，安装包双份 agent-core-v2，环境变量可退回不经 HostPolicy/执行域的旧路径）；`embed.ts` 复制 `start.ts` 已出现漂移；打包 bundle 陈旧 | P1/P2 |
| 9 | **上游 31 个新提交无紧急安全修复**；建议选择性回移 5 组（续接后读图、WaitFor 90 秒、不发默认 max_tokens、首包头超时、NotifyUser + `embed.ts` uiCapabilities）；整体 rebase 冲突点为 ZP-17 `tower/protocol/git.ts` 与 ZP-5/6 `node-sdk/src/sdk-rpc-client-v2.ts` | P1/P2 |

---

## 1. 上游 f67e6398f 之后的变化（截至 2026-10-13 main `afd95f64a`）

上游领先 31 个提交、0 个落后（compare API；文件清单被 API 截断在 300 个，tower/kap-server 关键提交另逐个拉取）。2.1.1 之后仍无新 release。

### 1.1 变化分类与处置建议

| 提交 | 内容 | 与我方关系 | 建议 |
|---|---|---|---|
| `1f6f0b1fa` #4059 | `KIMI_CODE_TRUST_WORKSPACE` 环境变量直接把工作区标为可信（改 `workspaceTrustService.ts`、`mcpRegistryService.ts`、`kap-server/src/routes/workspaces.ts`） | PATCHES.md 已列“升级闸门：先 revert #4059”。宿主不透传环境且 ZP-1/2/18 已不读项目配置，风险低，但仍应 revert 保持“工作区永不可信”语义 | **吸收时 revert**（保持现有闸门） |
| `395d53723` #4056 + `trustDisclosureService.ts`（新增 312 行） | 工作区信任面板列出配置来源（MCP 激活摘要） | 我方不使用工作区信任（路由不注册） | 无需吸收；随 rebase 自然带入，无冲突 |
| `419aced0e` #4154 | **会话恢复后媒体工具（ReadMediaFile）不注册**的修复：`mediaToolsRegistrar.ts` 订阅 `onDidRestore` | 我方依赖续接（kap-host 每事项一个引擎、resume）；锁版存在该缺陷 → 续接后的首回合读图失败 | **应吸收（P1）**：小补丁（+8 行），可单独 cherry-pick |
| `f0bc988bb` #4152、`fed19d24f` #4179 | fork 子 Agent 请求前缀与父 Agent 一致（前缀缓存命中）；缓存探针报告前缀一致性 | 我方 SUBAGENT_FORK 计划关闭（ZP-13）；但前缀一致与令牌化缓存命中目标（P6）相关 | 可吸收；优先级 P2 |
| `f409caa21` #4083 | fork 会话不再继承源会话的 Cron | 我方 Cron 由宿主策略关闭（D-01） | 随 rebase 带入 |
| `20a2cea72` #4061 | **WaitFor 上限 90 秒**，新输入结束等待 | 我方 WaitFor 开启（ZP-13 口径）；D-27 冻结时限与此相关；90 秒上限可减少引擎在后台任务上空转 | **应吸收（P1）**，行为变化须回归 `p2-w-domain` 后台任务用例 |
| `a940f2ff0` #4057 | 权限模式变化发布到 `agent.status.updated` | 运行模式由宿主决定，影响小 | 随 rebase |
| `06ebfc821` #4081、hook 相关 | UserPromptSubmit hook 输出折叠修复 | 我方不依赖上游 hooks | 随 rebase |
| `e3bf50c08` #4076 | undo 时移除被中断回合的提醒 | 我方 undo 未接业务 API（见 §2） | 随 rebase |
| `21406fb4c` #4091 | 未配置输出上限的模型不再发 `max_tokens` | 网关 v0 / MaaS 严格栈曾遇 400 的同类风险 | **应吸收（P1）**，验证网关转发 |
| `c151d5a3d` #4092 | `KIMI_CODE_LLM_HEADERS_TIMEOUT_MS` 首包头超时 | 经闸门 → 网关 → 上游三跳，首包慢；可显式配置 | **应吸收（P2）** |
| `7091138f5`/`4fbe06544`/`0a3a2fbaf` #4153/#4054/#4159 | NotifyUser：无更新面板的宿主不再催促；桌面/Web 显示进度；`kap-server/src/start.ts` 种子加 `uiCapabilities: [NOTIFY_USER_UI_CAPABILITY]` | ZP-13 计划“NOTIFY_USER 开”。**我方 `embed.ts`（ZP-19）复制了 start.ts 的 bootstrap，不会自动获得此种子**——吸收后若不同步，NotifyUser 仍会被视为“无面板宿主” | **应吸收（P1）**，且须同步改 `embed.ts` |
| `c15638b0a` #4183 | 媒体读取中断时取消视频上传 | 视频直送为跨边界动作（政策限制） | 随 rebase |
| `5b9366976` #4058 | `fs:list` 增加 `allow_ignored_globs`；`fsService.ts`/`fsSearch.ts` 改用 picomatch | kap-server fs 路由我方不注册；但 `fsService.ts` 与 Grep/Glob 同模块，**须回归 D-02/D-06 可信 rg 用例** | 随 rebase，回归 |
| `09af3b483`、`c9f01f073` #3998/#4074 | Tower 大重构：新增 `bashGuard.ts`(523 行)、`missionGate.ts`、`TowerRebase/TowerComplete` 工具；**改 `features/tower/protocol/git.ts`（+87/−10）**；改 `node-sdk/src/sdk-rpc-client-v2.ts`、`rpc.ts`、`session.ts` | **与 ZP-17（git.ts 封闭 execFile）和 ZP-5/6（sdk-rpc-client-v2.ts extraSeeds）直接冲突**；新增 Tower 工具名进入工具面，`static-surface.test.ts` 白名单与 P1“遍历全部内置工具”会失败（这是设计上的报警） | 吸收但需手工 rebase 两处补丁；宿主策略对 `Tower*` 一律拒绝已覆盖新工具 |
| `cbd754049` #4184 | 删除 kaos 包与 MCP `executor="kaos"`；node-sdk 删 `createSessionWithKaos` 等，改 `kimi-harness.ts`、`rpc.ts` | 触及 ZP-5/6 所在的 node-sdk；SDK 宿主（`apps/agent-host`）若引用这些 API 会编译失败 | 吸收时同步检查 `apps/agent-host` |
| `0f052fee1` #2919 | TUI 前台 Bash 输出去除终端转义 | 我方无 TUI；但 Bash 输出里的转义序列同样会进入桌面 RunView | 不吸收上游（TUI 专属）；**在内核/前端渲染侧剥离 ANSI（P2）** |
| `afd95f64a` #4165、`skillService.ts`(+29/−20)、`skill.ts` | 统一技能提示（TUI 的 skill 卡片 → 高亮提示）；`skillService` 调整 | 触及 ZP-18 相邻文件（`features/skill/*`，我方补丁在 `workspace/rootFileSkillSource.ts`、`catalog/userFileSkillSource.ts`，不是同一文件） | 随 rebase，回归“技能目录不加载”用例 |
| `subagentService.ts`(−7)、`agentTool.ts`(−25)、`forked.ts` 新增 | fork 子 Agent 继承父 Agent 可用 agent 类型（含自定义 agent） | **语义注意**：子 Agent 可用类型扩大；我方 ZP-1 只禁项目级 profile，签名 profile 仍会被继承——符合预期 | 随 rebase，回归“子 Agent 裁决来源为宿主策略” |
| `242ac2300`、`7f0ff53c8`、`eec9bbd94` 等 | `kimi app`、遥控关闭 web server、问卷 | 不相关（遥控/CLI 我方不用） | 忽略 |

### 1.2 未在 main 出现、仍需跟踪

#4115（沙箱）、#4062（远程环境）、#2337（权限规则）、**#4070（后台子 Agent 审批旁路）**：截至 10-13 compare 中均未出现合并提交。#4070 若合入是安全修复，应第一时间吸收；我方 ZP-4 在每个 Agent 作用域首位已兜底。

### 1.3 升级结论

- **无需紧急升级**：31 个提交中没有针对我方已开放能力的安全修复；上游无新 release。
- **建议做一次“选择性回移”而不是整体 rebase**：cherry-pick `419aced0e`（续接后读图）、`20a2cea72`（WaitFor 90 秒）、`21406fb4c`（不发默认 max_tokens）、`c151d5a3d`（首包头超时）、NotifyUser 三提交（并同步 `embed.ts`）。合计 < 300 行，不触碰 ZP 补丁文件。
- **整体 rebase 的冲突点**（双周评估时处理）：ZP-17 `tower/protocol/git.ts`、ZP-5/6 `node-sdk/src/sdk-rpc-client-v2.ts`；#4059 revert；`static-surface.test.ts` 白名单（Tower 新工具 + `bashGuard.ts`）；`embed.ts` 与 `start.ts` 的种子漂移。
- **结构性风险**：`embed.ts` 复制 `start.ts` 的启动逻辑（ZP-19），上游每次改 `startServer` 的种子/路由都不会自动传导。建议在 `static-surface.test.ts` 或新测试中对 `start.ts` 的 `bootstrap(...)` 种子段做摘要比对，上游变化即报警。


---

## 2. Kimi Code 能力清单 × 当前产品（kap 引擎路径为准）

判定口径：**E2E** = 律师在桌面可触发、结果在界面可见且有测试；**部分** = 引擎内可用/有测试，但链路某段未接或界面不可见；**未实现**；**关闭** = 有意关闭（引偏离或条款）。宿主自评见 `packages/kap-host/src/capabilities.ts`（能力账本，`current` 字段）。

| 能力 | 上游实体 | 当前状态 | 证据（文件:行 / 测试） | 缺口 |
|---|---|---|---|---|
| 模型流式输出、工具调用 | provider → `gate.kwl/m/<mid>/v1` | **部分** | `kap-host/src/engine-config.ts:80-99`；`kernel/test/kap-a1.test.ts`（通过，本次实跑 2.5s）；`kap-host/test/p1-kap-host.test.ts` “端到端”用例 | `assistant.delta` 只在宿主内累加（`runtime.ts:457-461`），**不转发**；内核 `previewText` 只在终态写入（`kap-agent-client.ts:278`）→ 律师在运行中看不到流式回复 |
| 读写文件 Read/Write/Edit/Glob/Grep | 内置工具 + 可信 rg | **部分** | `tool-table.ts:33-46`；`policy.ts:280`（只写工作区）；P1/P2 测试 | 材料快照每份截断到 **20,000 字**（`executor.ts` `runAgentScenario` 内 `m.text.slice(0, 20_000)`），长合同/卷宗被静默截断；工作区产物不入库（见 §3） |
| Bash / Python（W 执行域） | `IHostProcessService` → W-core | **部分（本机通过）** | `exec-router.ts`、`exec-wasm/`；`p2-w-domain.test.ts`；D-07/D-08/D-10～D-15 | 纯 Python 包未随包（D-08）；Electron 安装包内无 `kap-host.bundle.mjs` 与 W 运行时（`electron/main.cjs:66`，D-23） |
| 计划模式 | EnterPlanMode/ExitPlanMode | **E2E** | `kap-client.ts:175` `enterPlanMode`；`policy.ts:288-292`；P1“先出计划”用例；D-03 已收敛 | 计划正文在确认卡里，执行后不留存为成果 |
| 待办 TodoList | SetTodoList/TodoList | **部分** | `tool-table.ts:52-53` 放行（UI 级）；`RunView.tsx:28` 只显示“任务清单”字样 | 待办内容不转发、不与任务步骤映射（账本 `capabilities.ts` 待办=pending） |
| 提问 AskUserQuestion | kap questions 队列 | **E2E** | `runtime.ts:479-488`；`kap-agent-client.ts:258-265`；`RunView.tsx:334-338,415`；P1“提问”用例；D-04 已收敛 | 宿主重启后问题丢失（账本注：进程级内存） |
| 审批（确认卡） | kap approvals + 宿主策略 ZP-4 | **E2E** | `policy.ts`；`RunView.tsx:322`；`kernel/test/w1*.test.ts`；P1“审批”“批准人渠道”用例 | 手机端设备签名未接（D-24） |
| 进度通知 NotifyUser | 实验开关 | **未生效** | `engine-config.ts:43,51` 开关锁开；但上游需 `uiCapabilities` 才注册，`embed.ts` 未声明（`capabilities.ts` 进度通知 note 自述） | 与上游 #4159 一并接入（§1） |
| 子 Agent `Agent` | coder profile，secondary_model K2.6 | **部分** | `engine-config.ts:101`（`force:true`）；`policy.ts:303-322` 默认档自动放行、预算 `maxSubagents: 2`（`kernel/src/index.ts:559`）；P1“裁决来源（含子 Agent）”“后台子 Agent 生命周期”通过 | 子 Agent 事件只以 `agent_id` 附在工具事件上，界面“子任务平铺不可展开”（D-28）；取消传播与模型来源审计未验证（账本注） |
| Agent 集群 AgentSwarm | ≤128 成员 | **部分** | `engine-config.ts:136` 并发 3；`policy.ts:315,359` | **一次 AgentSwarm 只计 1 个子 Agent 预算**（`consumeBudget` 不看成员数），与“预算预占”方案不符 |
| 目标 Goal | CreateGoal 等 | **关闭** | D-01；`kap-host` P1“S2-01 目标模式失败关闭” | G1 |
| 定时 Cron | CronCreate/Delete | **关闭** | D-01；`capabilities.ts` 定时=disabled | G1 |
| 后台任务 TaskList/Output/Stop/WaitFor | 内置 + kap tasks 路由 | **部分** | `tool-table.ts:38-40,47`；`kap-client.ts:208-216` | 内核与界面无“后台任务面板”；上游 WaitFor 90 秒修正未吸收 |
| 会话续接（追问/跨重启） | kap sessions `:restore`、resume | **未实现** | `runtime.ts:376` 每次 `startRun` 都 `createSession`；`SESSION_ACTIONS` 含 `restore` 但全仓无调用；宿主退出 → 任务 `host_exited` 失败（`kap-agent-client.ts` exit 处理）；RunView 无追问输入框 | 律师不能在同一任务上继续追问；宿主崩溃不能续跑（账本“会话、续接”=pending） |
| 分叉 / 导出 | fork / export | **未实现** | 路由未在 `KAP_ROUTE_ALLOWLIST`（`kap-client.ts:28-52`） | G1 |
| 上下文压缩 | `agent/fullCompaction`（触发比 0.85，`strategy.ts:19`） | **引擎原生在跑、未验收、不可见** | `engine-config.ts:89-98` `max_context_size: 262144` → 约 22 万 token 自动压缩；手动 `:compact` 被白名单排除（`kap-client.ts:55`，P1 路由用例断言 `s1:compact` 不可达）；全仓无压缩测试 | 压缩事件不转发；“法律事实账本独立于聊天摘要”（第 04 篇 §2）未实现；压缩请求经闸门的令牌化/计量未测 |
| 撤销 undo / 文件历史回滚 | undoService、fileHistory | **部分** | `runtime.ts:755-770`：`artifacts()` 能读变更清单，`rollback()` 抛 `unavailable`；**内核适配器从不调用 `artifacts`**（`kap-agent-client.ts` 无此调用） | 见 §3 成果入库 |
| 技能 Skill | `skillDirs`、Skill 工具 | **名义开放、实际为空** | `tool-table.ts:36` Skill=T0 放行；`matter-engine.ts:188` `skillDirs = trustedRoot ? [trusted/skills] : []`；**生产入口 `kap-host/src/main.ts:105-109` 的 `layout()` 不返回 `trustedDir`** → `skillDirs=[]`；`builtin_product_skills=false`（`engine-config.ts:76`）；仓内 `content/` 只有 `agent-profile/ keys/ lawdb/ ocr-models/ redteam/ tool-manifest/`，**没有任何 SKILL.md** | 律师不能使用任何 Kimi Code 技能；桌面“方法库”（`pages/Methods.tsx`）展示的是内核确定性工作流 s1/s2/s6，不是 Skills |
| Agent profiles | agentFiles | **kap 路径未用** | `matter-engine.ts:189` `agentFiles: []`；签名 profile `content/agent-profile/legal-agent.md` 只被 SDK 宿主使用（`agent-host-manager.ts:271-320`） | kap 路径缺法律角色设定，仅有“受限 bash”说明（`matter-engine.ts` `restrictedBashNote`） |
| 工作区指令 AGENTS.md（ZP-18） | trustedInstructionsDir | **E2E（安全面）** | P1“ZP-18”用例 | 生产无可信区，只有宿主生成的环境说明 |
| MCP（法律 MCP） | mcp.json http | **E2E** | `engine-config.ts:117-133`；P1“MCP”“MCP（子 Agent 作用域）” | 律所 MCP 无运行通道（D-39） |
| 联网搜索 WebSearch | `[services.moonshot_search]` → 闸门 | **部分（本机通过）** | `engine-config.ts:104-111`；`kernel/test/kap-gate.test.ts`；D-16/D-25/D-30 | 真实上游与召回抽样待中软额度 |
| 网页抓取 FetchURL | ZP-11 | **部分（本机通过）** | 同上；`egress-gate/test/` | 同上 |
| 图像/视频 ReadMediaFile | T0' | **形同未用** | `policy.ts:296-300` 跨边界询问；材料快照只有 `.txt`（`kap-host/src/main.ts:127-131`），工作区无图片来源 | 续接后读图缺陷（上游 #4154）未吸收 |
| 用户直接 shell / 终端 / 遥控 / OAuth / 遥测 / 插件市场 | — | **关闭** | ZP-8/12/19/21；`capabilities.ts` 对应行 disabled；P1“路由”用例 | 设计如此 |
| Hooks | 上游 hooks | **未实现（不依赖）** | 能力账本 Hooks=pending（G2） | — |
| 数据源插件 | kimi-datasource | **未实现** | 账本 pending（G1） | — |
| WebBridge/Computer Use、闭源云技能 | — | **不在权益** | 账本 not_entitled | — |

**小结**：安全面（宿主策略、路由白名单、无端口、ZP 补丁、闸门）做得扎实且有测试；**能力面**真正端到端的只有“单回合开放任务 + 计划/确认/提问 + 法律 MCP”。Skills、会话续接、压缩可见性、工作区产物、子 Agent 可视化、流式回复六项是“引擎有、产品没接”。

---

## 3. 闭环核查（桌面 → 内核 → kap-host → 引擎 → 工具 → 事件 → 入库 → 界面）

| 段 | 实现位置 | 是否接通 | 证据 / 问题 |
|---|---|---|---|
| ① 桌面发起 | `apps/desktop/src/pages/Home.tsx:50,90`、`api.ts:274` `runs.start` | 接通 | 场景 `a1.agent_task` 走 Agent；s1/s2/s6 走确定性工作流 |
| ② 内核业务 API → 队列 | `kernel/src/api/index.ts`、`queue.register("legalRun")`（`kernel/src/index.ts`） | 接通 | — |
| ③ 内核 → kap-host | `kernel/src/executor/kap-agent-client.ts:285-340` IPC `startRun` | 接通（默认引擎） | `kernel/src/index.ts:279` `ZR_AGENT_ENGINE !== "sdk"` 即 kap |
| ③' 目标与材料 | `executor.ts` `runAgentScenario` | **有缺陷** | (a) 提示词写死“【边界】**只能使用法律工具**”（v5 遗留），与 kap 路径开放 Read/Write/Bash 矛盾，会压制模型使用文件/代码工具；(b) 每份材料截断 20,000 字；(c) 材料作为 `.txt` 快照、每次运行**清空重写**（`kap-host/src/main.ts:125-126`） |
| ④ kap-host → 引擎 | `runtime.ts:348-447`、`kap-client.ts`（白名单 23 条路由） | 接通 | P1 全部 15 个用例本次实跑通过 |
| ⑤ 引擎 → 工具 → 宿主策略/执行域/闸门 | `policy.ts`、`exec-router.ts`、`host-egress.ts` | 接通 | P1/P2/kap-gate 测试 |
| ⑥ 事件回流 kap-host → 内核 | `runtime.ts:448-520` 只映射 turn/tool/approval/question/step/error/turn.ended；`kap-agent-client.ts:243` 前缀改 `agent.*` | **部分** | 不转发：assistant 流式文本、TodoList 内容、子 Agent 回合、压缩事件、后台任务输出、NotifyUser |
| ⑦ 内核入账本时间线 | `executor.ts:815-828` `AGENT_TIMELINE_EVENTS` 白名单 | 接通（白名单内） | 白名单外事件丢弃（如 `agent.turn_started`、`agent.tool_result` 之外的） |
| ⑧ 成果入库 | `kap-agent-client.ts:276-280` 只把**终态文本**封装为 `final_message.md` → 内核 `a1_agent_draft` | **断开（P0）** | Agent 在工作区写的 DOCX/XLSX/MD（含 `kwl-docx create` 产物）**从不入库**：kap-host 有 `artifacts()`（`runtime.ts:755`，读 file-history），`main.ts` 也暴露了 `artifacts` 方法，但内核适配器没有调用；`kap-a1.test.ts:52` 只断言 `a1_agent_draft` |
| ⑨ 界面呈现 | `RunView.tsx:186-298` 1 秒轮询 `runs.events` + `runs.interactions` | 接通 | 只能看到最终文本与内核工作流成果 |

### 3.1 任务状态在界面上的可见性与可操作性

| 状态 | 可见 | 可操作 | 证据 / 问题 |
|---|---|---|---|
| 排队 queued | 是（`labels.ts:42`） | 取消 | — |
| 运行 running | 是 | 取消（`RunView.tsx:381-388`，带 `status_version` 乐观并发） | 无流式文本 |
| 等待确认 waiting_approval | 是（橙色） | 允许/拒绝/本任务放行/泛化（`RunView.tsx:322`） | — |
| 等待作答 waiting_input | 是 | 作答（`QuestionCardView`） | — |
| 取消 cancelled | 是 | — | 取消先解绑再 abort（`runtime.ts:742-753`） |
| 失败 failed / 超时 timed_out / 过期 expired | 是 | **无“重试”按钮** | 内核有 `runs.retry`（`api/index.ts:1028`），桌面 `api.ts` 未封装 |
| 部分完成 partial | 是（`RunView.tsx:145-156`） | 无后续动作 | — |
| 对账 reconciling | 显示为“对账中”，但被列为**终态**（`labels.ts:57`） | **不可操作** | 内核 `runs.reconcile`（`api/index.ts:986`）桌面未封装；律师卡在“对账中”无出口（出站记录对账 `egress.reconcile` 在 `Connections.tsx:155`，是另一件事） |
| 预算暂停 / 等待电脑上线 / 恢复中 | 有标签 | — | kap 路径不产生这些状态 |

### 3.2 四项专项结论

- **Skills**：不可用。生产路径 `skillDirs=[]`（`kap-host/src/main.ts:105-109` 未给 `trustedDir`），仓内无法律技能内容（`content/` 无 skills 目录、无 SKILL.md）。Skill 工具在工具表里放行但目录为空。
- **子 Agent**：引擎内可用且受宿主策略裁决（P1 已证），默认档自动放行、每运行最多 2 个；界面只能看到带 `agent_id` 的工具步骤，不能展开（D-28）；Swarm 预算按调用计 1 个。
- **上下文压缩**：引擎原生自动压缩在 0.85 × 262,144 处触发，宿主未关闭也未暴露；无测试、无事件、无“压缩后不丢限制与引用”的验收（能力账本“上下文压缩”= pending 如实）。
- **会话续接**：未实现。每次运行新建会话，无追问入口，无宿主重启后的 `restore`；会话文件明文落盘于 `<dataRoot>/<mid>/home`（ZP-9 待实现）。

---

## 4. 重复实现、接口适配问题与稳定性风险

| # | 类别 | 问题 | 证据 | 影响 |
|---|---|---|---|---|
| R1 | 重复实现 | **两套 Agent 引擎并存**：v5 SDK 宿主（`apps/agent-host/` + `kernel/src/executor/agent-host-manager.ts` 548 行 + `electron/agent-host.bundle.mjs` 11 MB）与 v9 kap 引擎（`packages/kap-host/` + `kap-agent-client.ts` + `vendor/kap-embed/kap-embed.mjs` 11.8 MB）。内核总是构造 `sdkAgentClient`（`kernel/src/index.ts:261`），用 `ZR_AGENT_ENGINE=sdk` 切回；Electron 两个入口都传（`electron/main.cjs:77,89,91`） | 同上 | 安装包里有两份 agent-core-v2，安全口径不同（SDK 路径靠 `[tools] enabled` 白名单 + 内核回调审批，不经 `kap-host/src/policy.ts` 的 HostPolicy 与 W 执行域路由）；生产环境变量可一键退回旧引擎；旧红队 34 例（`kernel/test/redteam.test.ts`）仍跑在 SDK 宿主上 |
| R2 | 重复实现 | `embed.ts`（ZP-19）复制 `start.ts` 的 `bootstrap` | `third_party/kimi-code/packages/kap-server/src/embed.ts:104-112`；上游 `0a3a2fbaf` 已改 `start.ts` 种子 | 上游种子/能力变化不会传导，已出现第一例（NotifyUser `uiCapabilities`） |
| R3 | 状态三份 | 待决审批与提问同时存在于 kap-server 队列、`runtime.ts` 的 `run.approvals/questions`、`kap-agent-client.ts` 的 `task.approvals/questions` | `runtime.ts:469-488`；`kap-agent-client.ts:247-265` | 任何一层漏事件即界面与引擎不一致；三层都是进程内存，宿主或内核重启全丢 |
| R4 | 稳定性 | **Agent 运行全程持有全局 `ioMutex`**（含等待律师的数小时），而材料导入的解析/OCR 也要这把锁 | `kap-agent-client.ts:292`（start 时 acquire，终态才 release）；`api/index.ts:272` `ioMutex.runExclusive(parseWithPipeline…)`；`kernel/src/index.ts:233` | 律师在“等待你回答”时去导入一份补充材料 → 导入挂起直到任务结束/超时；其他事项的 Agent 任务也被串行阻塞（界面仍显示“执行中”） |
| R5 | 适配问题 | 取消路径静默失败：先取 `state_version` 再 `cancel`，两步之间状态变化（例如刚好来了确认卡）→ 宿主返回 conflict，被 `.catch(() => {})` 吞掉 | `kap-agent-client.ts` `cancel()` | 内核已吊销令牌，引擎后续模型调用会失败，但宿主运行不会被及时 abort，执行域命令可能继续到时限；建议冲突时重取版本重试 |
| R6 | 适配问题 | A1 提示词“只能使用法律工具”是 v5 SDK 路径的边界，kap 路径照搬 | `executor.ts` `runAgentScenario` 的 `fullGoal` | 模型被要求不用 Read/Write/Bash，开放能力被提示词自我封印；与“受限 bash”说明互相矛盾 |
| R7 | 适配问题 | 材料每份截断 20,000 字、以 `.txt` 快照、每次运行清空重写 | `executor.ts`（`m.text.slice(0, 20_000)`）；`kap-host/src/main.ts:125-131` | 长合同静默丢后半段，且模型不知道被截断（法律场景高风险：漏看条款） |
| R8 | 适配问题 | 成果只取最终文本 | `kap-agent-client.ts:276-280` | 见 §3 ⑧ |
| R9 | 稳定性 | 每运行新建会话、运行结束会话不再使用，但会话目录、事件日志、工作区在 `<dataRoot>/<mid>/home` 持续累积、明文、无清理 | `runtime.ts:376`；ZP-9 待实现 | 磁盘增长；明文落盘与 v9 加密要求不符（已登记） |
| R10 | 构建 | `electron/kernel.bundle.cjs`、`agent-host.bundle.mjs` 为 10-10 产物（gitignore），晚于此的内核源码改动（阶段 5 切换 kap 默认等）未进入；安装包形态缺 `kap-host.bundle.mjs` | `stat`：bundle 10-10 22:20，`kernel/src/index.ts` 10-13；`electron/main.cjs:66` | 打包形态与开发形态行为不一致（D-23 已登记 kap-host 部分，kernel bundle 陈旧未登记） |
| R11 | 预算 | AgentSwarm 一次调用只计 1 个子 Agent | `policy.ts:315,357-362` | 集群成员数可达上游上限，超出“每运行 2 个子任务”的业务预算口径 |
| R12 | 同事项串行 | 同一事项同时只允许一个运行（S3-16），且宿主层、内核层各判一次 | `runtime.ts:355`；`kap-host/src/main.ts:121` | 设计取舍，但界面需明确提示“本事项有任务进行中” |

---

## 5. 补齐方案（优先复用上游能力）

### P0（交付前必须补）

| # | 事项 | 改动文件 | 规模 | 验证 |
|---|---|---|---|---|
| P0-1 | **工作区产物入库**：终态前由宿主列出本运行的文件变更（已有 `runtime.artifacts()` + 已白名单的 `file-history/changes`、`file-history/content` 路由），经 broker 读取（大小上限、hash），内核入库为 `a1_workspace_file` 草稿成果；RunView 成果区列出 | `kap-host/src/runtime.ts`（终态收尾时收集，覆盖跨回合变更而非只 `run.turnId`）、`kap-host/src/main.ts`（IPC 返回文件字节）、`kernel/src/executor/kap-agent-client.ts`（终态处理改为异步拉取）、`kernel/src/executor/executor.ts`（成果类型与检查点）、`apps/desktop/src/lib/labels.ts`、`pages/RunView.tsx` | ~350 行 | 扩展 `kernel/test/kap-a1.test.ts`：假模型 Write `work/备忘.md` + Bash `kwl-docx create` → 两个成果入库、hash 一致、令牌在导出时还原；检查点重放不重复入库 |
| P0-2 | **修正 A1 提示词与材料截断**：边界语改为“文件工具与受限 bash 可用；法律依据须经法律工具核验”；材料全文令牌化写入快照（单份上限按 W 的 64 MiB 口径或 2 MB 并在文件头写明“已截断于第 N 字”） | `kernel/src/executor/executor.ts`（`runAgentScenario`）、`kap-host/src/main.ts`（快照写入） | ~60 行 | 新增用例：10 万字合同 → 快照完整、`Grep` 命中末尾条款；提示词快照测试 |
| P0-3 | **Agent 运行不持有全局 ioMutex**（W 已有并发与内存上限 D-14），或在 `waiting_*` 时释放、恢复运行时重取 | `kernel/src/executor/kap-agent-client.ts:292`、`kernel/src/index.ts:299` | ~40 行 | 新增 `kernel/test/w1-wait.test.ts` 用例：运行处于 waiting_input 时导入材料 ≤ 5 秒完成；两个事项的运行可并行 |
| P0-4 | **对账与重试可操作**：桌面封装 `runs.reconcile`、`runs.retry`；`reconciling` 从 `TERMINAL_STATUSES` 移出并显示“逐项确认”面板；失败/超时显示“重试” | `apps/desktop/src/api.ts`、`lib/labels.ts:57`、`pages/RunView.tsx` | ~200 行 | `apps/desktop/test/desktop-lib.test.ts` 增状态映射用例；`kernel/test/recovery.test.ts` 已覆盖内核侧 |
| P0-5 | **Skills 最小可用（复用上游 Skill 工具与 skillDirs，不自研）**：新增 `content/skills/<name>/SKILL.md` 签名包（构建与签名复用 `content/agent-profile/build-profile.mjs` 的 manifest + `lawdbSignerPub` 验签）；`kap-host/src/main.ts` 的 `layout()` 返回每事项只读 `trustedDir`（解密/验签后放入 `trusted/skills`）；首批 3–5 个律师技能（合同审查清单、证据目录、法律检索备忘、金额与期限计算说明）；同时决定 kap 路径是否经 `agentFiles` 加载已签名的 `legal-agent.md` | `content/skills/**`、`content/skills/build-skills.mjs`（新）、`kap-host/src/main.ts`、`kap-host/src/matter-engine.ts`（`agentFiles`）、`kernel/src/index.ts`（下发技能包路径）、`apps/desktop/src/pages/Methods.tsx`（区分“确定性方法”与“技能”） | ~500 行 + 内容 | `p1-kap-host.test.ts` 增：可信区技能出现在 Skill 工具列表并可调用、工作区 `.kimi-code/skills` 不出现、篡改签名即不加载；P12 技能层红队用例 |
| P0-6 | **安装包形态补齐**：构建 `kap-host.bundle.mjs` 与 W 运行时目录，刷新 kernel/agent-host bundle；构建脚本对 bundle 与源码做摘要比对，陈旧即失败 | `scripts/`（构建）、`apps/desktop/electron/main.cjs:62-91`、`runtime-paths.cjs` | ~150 行 | Windows 真机冒烟（D-23）；CI 检查 bundle 摘要 |

### P1

| # | 事项 | 改动文件 | 规模 | 验证 |
|---|---|---|---|---|
| P1-1 | **会话续接**：业务 API `runs.followup {run_id, text}` → 宿主在同一会话 `prompt`（不新建会话），运行进入新尝试；宿主重启后用已白名单的 `:restore` 恢复会话（只恢复转录，权限与输入版本重新检查，第 04 篇 §8） | `kap-host/src/runtime.ts`（`continueRun`）、`kap-host/src/main.ts`、`kap-agent-client.ts`、`kernel/src/api/index.ts`、`executor.ts`（Attempt）、`RunView.tsx`（追问输入框） | ~450 行 | 新测试：两轮追问共享上下文；宿主进程被杀后续接；跨事项会话 ID 被拒 |
| P1-2 | **上游选择性回移**：`419aced0e`（续接后读图）、`20a2cea72`（WaitFor 90 秒）、`21406fb4c`（不发默认 max_tokens）、`c151d5a3d`（首包头超时）、NotifyUser 三提交 + `embed.ts` 声明 `uiCapabilities` | `third_party/kimi-code/**`、`third_party/patches/*.patch`、`PATCHES.md`、`scripts/build-kap-embed.mjs` 重建、`kap-host/vendor/kap-embed/BUILD.json` | < 300 行上游 + 台账 | `static-surface.test.ts`、P1/P2 全部、`kap-gate.test.ts` |
| P1-3 | **流式回复与过程可见**：宿主节流转发 `assistant.delta`（≥ 300 ms 合批）、TodoList 内容、NotifyUser、子 Agent 回合起止；内核时间线白名单补齐；RunView 子任务可展开（收敛 D-28 一部分） | `runtime.ts:448-520`、`executor.ts:815`、`RunView.tsx` | ~300 行 | P1 增事件序列断言；界面快照测试 |
| P1-4 | **上下文压缩验收**：测试用小 `max_context_size` 触发引擎自动压缩，断言压缩请求经闸门令牌化与计量、压缩后限制/引用不丢；转发 `compaction.*` 事件；把“事项事实账本摘要”放入可信指令（ZP-18 通道），压缩后仍在系统提示中 | `kap-host/test/`（新 `compaction.test.ts`）、`engine-config.ts`（测试注入）、`matter-engine.ts`、`runtime.ts` | ~250 行 | 新测试本身 |
| P1-5 | **AgentSwarm 预算按成员计**；子 Agent 取消传播测试 | `kap-host/src/policy.ts:315,357` | ~40 行 | P1 增用例 |
| P1-6 | **取消路径健壮化**（冲突时重取版本重试，失败显式上报） | `kap-agent-client.ts` `cancel()` | ~30 行 | `kernel/test/w1.test.ts` 增竞态用例 |

### P2

| # | 事项 | 改动文件 | 规模 | 验证 |
|---|---|---|---|---|
| P2-1 | **SDK 宿主退役**：生产构建移除 `ZR_AGENT_ENGINE=sdk` 与 `agent-host.bundle.mjs`；确定性工作流已不依赖 Agent，旧红队迁到 P12 运行器 | `kernel/src/index.ts:255-319`、`electron/main.cjs`、`apps/agent-host/`、`kernel/test/redteam.test.ts` | 删除为主 | 全量回归；安装包体积 −11 MB |
| P2-2 | `embed.ts` 漂移报警：测试比对上游 `start.ts` 中 `bootstrap(...)` 种子段摘要 | `kap-host/test/static-surface.test.ts` | ~40 行 | 上游改动即失败 |
| P2-3 | 后台任务面板（TaskList/Output/Stop 业务映射） | `runtime.ts`、`RunView.tsx` | ~250 行 | P2 后台任务用例 |
| P2-4 | Bash 输出 ANSI 转义剥离（上游只修了 TUI，#2919） | `RunView.tsx` 渲染层或 `runtime.ts` | ~20 行 | 单测 |
| P2-5 | 整体 rebase 到上游 main（处理 ZP-17 `tower/protocol/git.ts`、ZP-5/6 `node-sdk/src/sdk-rpc-client-v2.ts` 冲突，revert #4059，白名单登记 Tower 新工具） | `third_party/**` | 1–2 人日 | 升级闸门全部用例 |
| P2-6 | ZP-9 会话/文件历史加密落盘与会话目录清理；ZP-7 回移 | `kap-host/src/seeds.ts` 等 | 已在台账 | 已在台账 |

