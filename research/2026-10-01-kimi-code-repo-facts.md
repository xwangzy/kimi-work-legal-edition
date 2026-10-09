# kimi-code 开源仓库一手调研报告（中软法律发行版）

- 调研日期：2026-10-01
- 仓库：https://github.com/MoonshotAI/kimi-code
- 本地克隆：`platform/third_party/kimi-code`（已 checkout 锁版 commit，detached HEAD）
- **锁版 commit：`f67e6398fb3210ad8ace970e2dfd5bcc984ed61f`**
  - 对应 tag `@moonshot-ai/kimi-code@2.1.1`，commit 日期 2026-09-24 15:21:10 +0800（"ci: release packages (#4016)"）
  - npm registry 上 `@moonshot-ai/kimi-code` CLI latest 同为 2.1.1，交叉一致
- 调研时点 `main` 超前 release 共 **13 个 commit**，其中包括对安全模型有实质影响的 #4059（KIMI_CODE_TRUST_WORKSPACE），详见 §12

本报告所有"文件:行号"引用均基于上述锁版 commit 的工作树。构建与冒烟验证在本机 node v26.8.1 / pnpm 10.33.0 下实际执行通过（§11）。

---

## 1. 先前调研结论逐项核对总表

| # | 此前结论 | 核对结果 | 关键证据 |
|---|---------|---------|---------|
| 1 | 最新 release 为 2.1.1（2026-09-24） | **证实** | tag `@moonshot-ai/kimi-code@2.1.1` → f67e6398f，2026-09-24 |
| 2 | node-sdk 未发布 npm，须源码自建 | **证实** | `packages/node-sdk/package.json:4` `"private": true`；npm registry 查询 `@moonshot-ai/kimi-code-sdk` 返回 Not found |
| 3 | 引擎以 homeDir 为作用域 | **证实** | `packages/agent-core-v2/src/app/bootstrap/bootstrap.ts:168-173`（`resolveKimiHome`：`homeDir ?? KIMI_CODE_HOME ?? ~/.kimi-code`）；存储服务以 homeDir 为根（bootstrap.ts:151-157） |
| 4 | 配置权限规则不执行（PR #2337 未合入） | **证实** | PR #2337 "fix(agent-core-v2): honor configured permission rules" GitHub API 状态 **open / merged: null**；代码侧 `addRules()` 在全仓库无任何生产调用方（见 §8） |
| 5 | 子代理审批不触发 PermissionRequest hook（#4070） | **证实** | issue #4070 GitHub API 状态 **open**，明确标注 kimi-code 2.1.1 复现；代码机制见 §8。注意：SDK 层 `setApprovalHandler` **不受此缺陷影响**（§8.4） |
| 6 | 项目级 skills 自动发现无开关 | **证实**（但有免 patch 缓解路径） | `skillRoots.ts` 的 `projectRoots()` 无任何启用开关；缓解：`skillDirs` bootstrap 参数非空时整体替代自动发现（§4） |
| 7 | Hook 失败放行 | **证实** | `externalHooksRunnerService.ts:52-58, 67-76`：任何 hook 执行异常 catch 后返回空结果，等效放行（§9） |
| 8 | 遥测默认开启 | **证实（需分路径细化）** | CLI 路径默认开启（`telemetry` 配置默认 true）；**node-sdk 进程内嵌入路径默认无云端遥测**（§7） |
| 9 | 待发布的 KIMI_CODE_TRUST_WORKSPACE 会让项目级 MCP 直接生效 | **证实** | 锁版 2.1.1 代码中该变量**不存在**（全仓 grep 无匹配）；main 分支 #4059（2026-09-28，release 之后）引入（§12） |

## 2. (a) packages/node-sdk：导出 API 与进程内嵌入方式

**包名** `@moonshot-ai/kimi-code-sdk`，版本 0.20.0，`"private": true`（`packages/node-sdk/package.json:2-4`）——**不上 npm，必须源码自建**。README 仅 11 行无实质内容，真实 API 以源码为准。

**进程内嵌入引擎的确切路径**（这是本项目的核心接入事实）：

`packages/node-sdk/src/sdk-rpc-client-v2.ts` 的 `SDKRpcClientV2` 构造函数（:431-469）：
- :450-467 调用 `bootstrap({ homeDir, configPath, clientIdentity, args: { requestHeaders, skillDirs, uiCapabilities } }, [...logSeed(...)])` —— 引擎**在调用方进程内** bootstrap；
- :469 `this.klient = createKlient({ scope: app })`，`createKlient` 来自 `@moonshot-ai/klient/memory`（:239 import）—— 内存 transport，无守护进程、无 socket。

组装入口 `createKimiHarness(options: KimiHarnessOptions): KimiHarness`（`sdk-rpc-client-v2.ts:2810-2828`）：内部 `new SDKRpcClientV2(options)` + `new KimiHarness(rpc, {...})`。

`SDKRpcClientV2Options`（:348-364）：`homeDir?`、`configPath?`、`identity?`（**实际必填**，缺省抛 "Kimi host identity is required"，冒烟实测）、`skillDirs?`（:352-358 文档注明：非空时跳过默认 user/project skill 发现）、`telemetry?`、`onOAuthRefresh?`、`uiMode?`、`uiCapabilities?`。

**真实函数签名**（源码 + 冒烟实测）：

```ts
// packages/node-sdk/src/kimi-harness.ts:142
harness.createSession(options: CreateSessionOptions): Promise<Session>
// packages/node-sdk/src/types.ts:219-249 CreateSessionOptions:
//   { id?, workDir (必填), model?, thinking?, permission?: 'yolo'|'manual'|'auto',
//     planMode?, metadata?, kaos?, persistenceKaos?, additionalDirs?,
//     agentProfile?, agentFiles?, sessionStartedProperties?, drainAgentTasksOnStop? }

// packages/node-sdk/src/session.ts:138
session.prompt(input: string | PromptInput, options?: { promptId?: string }): Promise<void>
// session.ts:128 —— 审批回调（不是 "approvals.onRequest" 这个名字）
session.setApprovalHandler(handler: ApprovalHandler | undefined): void
// packages/node-sdk/src/events.ts:100
type ApprovalHandler = (request: ApprovalRequest) => MaybePromise<ApprovalResponse>
// ApprovalRequest { turnId?, toolCallId, toolName, action, display }（interaction.ts:20-26）
// ApprovalResponse { decision: 'approved'|'rejected'|'cancelled', scope?: 'session', feedback?, selectedLabel? }
//   （agent-core-v2/src/agent/interaction/approval.ts:3-21）
```

`identity` 的类型 `KimiHostIdentity`（`packages/oauth/src/identity.ts:19-29`）：`{ productName, version, platform, userAgentSuffix? }` —— 白标场景此处传中软发行版标识。

宿主身份白标的另一条通道：配置 `[identity]` `name`/`slug`（§3）。

`index.ts` 导出面（`packages/node-sdk/src/index.ts:1-135`）：`KimiHarness`、`createKimiHarness`、`SDKRpcClientV2`、`Session`、`KimiAuthFacade`、`SDKRpcClientBase`、catalog/config-rpc/errors/logging/image/proxy 等工具，以及全部事件类型（`export * from '#/events'`）。注意 engineAccessor 是公开的"逃生舱"（`sdk-rpc-client-v2.ts:608-610`），可直达 App 作用域服务，本 fork 可用它接线权限规则（§8.2）。

## 3. (c) 配置文件 config.toml 字段核实

config.toml 由 29 个"配置段"分散注册，权威索引是生成物 **`packages/agent-core-v2/docs/config-manifest.toml`**（:1-42 列出全部段及属主文件）。逐项核对此前结论中的字段名：

| 字段 | 存在性 | 证据 |
|------|-------|------|
| `default_model` | **证实** | `app/kosongConfig/configSection.ts:149`（`DEFAULT_MODEL_SECTION`）；文档 `docs/zh/configuration/config-files.md:98` |
| `default_provider` | 证实（额外发现） | `app/kosongConfig/configSection.ts:26` |
| `default_permission_mode` | **证实**，取值 **`"manual" \| "auto" \| "yolo"`** | `agent/permissionMode/configSection.ts:7`（zod enum）；manifest :121-126；文档默认 `manual` |
| `telemetry` | **证实**（boolean，默认 true） | 文档 config-files.md:105；消费点 `run-v2-print.ts:195`、`sdk-rpc-client-v2.ts:561`、`apps/kimi-code/src/cli/telemetry.ts` |
| `merge_all_available_skills` | **证实**，默认 **true** | `features/skill/catalog/configSection.ts:20-26` |
| `extra_skill_dirs` | **证实**，默认 `[]` | 同上文件 :12-18 |
| `builtin_product_skills` | **证实**，默认 **true**，env `KIMI_CODE_BUILTIN_PRODUCT_SKILLS` 可覆盖 | 同上文件 :28-57 |
| `extra_agent_dirs` | 证实（额外发现），默认 `[]` | `workspace/workspaceAgentProfileLoader/configSection.ts`；manifest :147-152 |
| `[providers.*]` `type`/`base_url`/`api_key`/`api_key_env` | **全部证实** | `app/kosongConfig/configSection.ts:42-55`（`ProviderConfigSchema`：`apiKeyEnv` 即 toml `api_key_env`）；文档确认 CLI 不从 shell 环境自动取密钥，须 `api_key_env` 显式指定 |
| `[models.*]` `provider`/`model`/`max_context_size`/`capabilities`/`support_efforts`/`default_effort` | **全部证实** | `app/kosongConfig/configSection.ts:151-175`（`ModelBaseSchema`，含 `max_input_size`/`max_output_size`/`aliases` 等更多字段） |
| `[identity]` `name`/`slug`（白标） | **证实** | `app/agentIdentity/configSection.ts:12-15`；env `KIMI_CODE_IDENTITY_NAME`/`_SLUG` |
| `[tools]` `enabled`/`disabled` | **证实**（全局白/黑名单） | `agent/toolPolicy/configSection.ts:7-10`；语义见 §5 |
| `[services.moonshot_search]` / `[services.moonshot_fetch]` | **证实**（`base_url`/`api_key`/`oauth`/`custom_headers`） | `app/auth/configSection.ts:179-180`；manifest :382-411；env `KIMI_WEB_SEARCH_*`/`KIMI_WEB_FETCH_*` |
| `[permission]` `rules[]`（decision/scope/pattern/reason）+ `dangerous_command_guard` | **证实存在解析，但不执行**（§8.2） | `agent/permissionRules/configSection.ts:29-41` |
| `[[hooks]]`（event/matcher/command/timeout） | **证实**，事件枚举含 `PermissionRequest`、`PermissionResult`、`PreToolUse` 等 20 种 | manifest :163-174；`features/externalHooks/configSection.ts` |
| `[secondary_model]`（子代理模型池，含 `force` 钉死） | 证实（额外发现，对白标/成本管控有用） | `session/subagent/configSection.ts:105-146` |
| `auto_session_title` | 证实（额外发现） | 文档 config-files.md:106 |

配置解析优先级：default → config.toml → env overlay → memory（manifest :9）。

## 4. (d) Skills 加载机制与关闭项目级自动发现

**发现目录**（`features/skill/catalog/skillRoots.ts:8-11`）：
- 用户级：`$KIMI_CODE_HOME/skills`、`~/.agents/skills`
- 项目级：**`<git 项目根>/.kimi-code/skills`、`<git 项目根>/.agents/skills`**（`projectRoots()` :29-39；项目根 = 向上找 `.git`，:72-74）

`merge_all_available_skills`（默认 true）只控制"品牌目录组合并 vs 取第一个存在者"（:87-101），**不是项目级发现的总开关**。"项目级 skills 自动发现无开关"**证实**。

**加载管线**：`WorkspaceRootSkillSource.load()`（`features/skill/workspace/rootFileSkillSource.ts:61-78`）→ `projectRoots()` → `FileSkillDiscovery`（bootstrap.ts:159-166 注册）。**该链路不检查 workspace trust**（类中无 IWorkspaceTrust 依赖）——案卷目录里的 `.kimi-code/skills` 会无条件进入模型上下文。

**关闭项目级发现的两条路**：

1. **免 patch（推荐，已实测可行）**：`createKimiHarness({ skillDirs: ['<签发目录>'] })`。`SDKRpcClientV2Options.skillDirs` 非空时：
   - `rootFileSkillSource.ts:63-65`：workspace（项目级）源直接返回空；
   - `userFileSkillSource.ts:53-60`：用户级默认目录同样跳过；
   - `explicitFileSkillSource.ts:32-38`：改为只从 `skillDirs` 加载。
   即一个 SDK 选项即可实现"只保留签发目录"。
2. **patch（备选）**：`features/skill/catalog/skillRoots.ts` 的 `projectRoots()` 改返回 `[]`；或在 `rootFileSkillSource.ts:61` 的 `load()` 开头短路。

另：`builtin_product_skills = false` 可关掉介绍 Kimi Code 自身的内置 skills（§3），白标必须设置。

## 5. (e) 内置工具清单与禁用方式

**注册机制**：每个工具经 `registerAgentToolService()`（`agent/toolRegistry/toolContribution.ts:35-48`）或 Feature 的 `contributeTool()`（`features/feature.ts:88-97`）注册到 Agent 作用域。

**核心工具**（`agent/tools/`，registerAgentToolService 调用点）：

| 工具名 | 文件 |
|-------|------|
| `Bash` | `agent/tools/os/bash/bashTool.ts:439-440` |
| `Read` | `agent/tools/os/read/readTool.ts:623-624` |
| `Write` | `agent/tools/os/write/writeTool.ts:136-137` |
| `Glob` | `agent/tools/os/glob/globTool.ts:329-330` |
| `Grep` | `agent/tools/os/grep/grepTool.ts:348-349` |
| `Edit` | `agent/tools/edit/editTool.ts:116` |
| `FetchURL` | `agent/tools/fetch-url/fetchUrlTool.ts:79` |
| `WebSearch` | `agent/tools/web-search/webSearchTool.ts:114-115` |
| `Agent`（子代理派发） | `agent/tools/agent/agentTool.ts:683` |
| `AskUserQuestion` | `agent/tools/ask-user-question/askUserQuestionTool.ts:256` |
| `TaskList`/`TaskOutput`/`TaskStop`/`WaitFor` | `agent/tools/task/*` |
| `SelectTools` | `agent/tools/select-tools/selectToolsTool.ts` |
| `ReadMediaFile` | `agent/tools/read-media-file/` |

**Feature 贡献工具**：`Skill`（skillFeature.ts:17）、`AgentSwarm`（swarmFeature.ts:24）、`NotifyUser`（notifyFeature.ts:14）、`EnterPlanMode`/`ExitPlanMode`（planFeature.ts:18-22）、`TodoList`（todoFeature.ts:13）、`CreateGoal`/`GetGoal`/`SetGoalBudget`/`UpdateGoal`（goalFeature.ts:27-39）、`CronCreate`/`CronList`/`CronDelete`（cronFeature.ts:17-19）、`TowerInit` 等 9 个 Tower 工具（towerFeature.ts:73）。

**浏览器工具**：**没有内置浏览器工具**。浏览器能力来自官方插件 `plugins/official/kimi-webbridge`（"Control your real browser…"，`app/capability/entries/kimiWebbridge.ts:281-283`）和 Kimi Computer Use 插件 zip（`app/capability/entries/kimiCu.ts:52-59`）——均为**需显式安装的插件**，不装即不存在。"内置浏览器工具禁用"在引擎层无需任何处理，只需确保插件体系不自动安装（§7.4）。

**禁用方式（免 patch，配置层即可）**：`[tools]` 段（`agent/toolPolicy/configSection.ts:7-10`）：
- `enabled`：非空时全局白名单；非 MCP 工具须精确名匹配，MCP 工具按 `mcp__*` picomatch 通配（`agent/toolPolicy/evaluate.ts:10-29`）；
- `disabled`：黑名单，在 enabled 之后应用；
- 组合语义：`isToolActiveComposed`（evaluate.ts:43-61）在工作区禁用 → profile 策略 → 全局 [tools] → 会话禁用四层上取交集。

**结论**：中软"内置 Shell/文件工具全部禁用、只放 MCP 网关"可用一行配置实现：`[tools] enabled = ["mcp__*"]`。无需 patch。注意这会同时禁用 `Agent`/`AgentSwarm`（子代理机制随之整体关闭，正好满足"不派发内置 subagent"）。

## 6. (f) 子代理机制

**内置 agent 定义**（`registerAgentProfile`，`app/agentProfileCatalog/contribution.ts:9`）：

| profile | 定义位置 | 工具面 |
|---------|---------|-------|
| `agent`（默认主代理） | `session/agentLifecycle/profile/profiles.ts:90-97` | AGENT_TOOLS（:11-44，含 `Bash`/`Write`/`Agent`/`AgentSwarm`/`mcp__*` 等 30+）；**`subagents: ['coder', 'explore', 'plan']`（:94）** |
| `coder` | 同文件 :99-108 | CODER_TOOLS（:46-69，唯一带文件编辑工具的子代理） |
| `explore` | 同文件 :110-125 | EXPLORE_TOOLS（:71-80，只读） |
| `plan` | `features/plan/profile/plan.ts:32-40` | PLAN_TOOLS（:8-16，只读） |

**自定义 agent 文件格式**：Markdown + YAML frontmatter（`name`/`description`（必填）/`whenToUse`/`override`/`tools`/`disallowedTools`/`subagents`）+ prompt 正文。解析器：`workspace/workspaceAgentProfileLoader/internal/agentFile.ts:27-101`。发现目录（`internal/agentRoots.ts:14-17`）：用户级 `agents`、`~/.agents/agents`；**项目级 `.kimi-code/agents`、`.agents/agents`**（同样无开关、无 trust 检查——见 patch 清单 P0-1）。

**委派继承（此前结论核实）**：
- `subagentAllowlistFor`（`app/agentProfileCatalog/profile-shared.ts:24-38`）：`caller.subagents ?? catalog.getDefault().subagents`——**自定义 agent 不显式声明 `subagents` 时，继承默认 profile 的 `['coder','explore','plan']`，证实"默认继承内置委派列表"**；声明 `['*']` = 不限制；声明 `[]` = 空白名单（"Allowed subagent types: none"）。
- `rootDelegationExtras`（:48-73）：根 agent 还会自动获得所有"磁盘发现型"自定义 profile 的委派权。

**"显式声明不派发内置 subagent"的做法**：
1. 免 patch：会话创建时传 `agentProfile`/`agentFiles`（CreateSessionOptions，types.ts:234-239）指定签发的默认 profile，其中 `subagents: []`；或直接 `[tools]` 禁用 `Agent`/`AgentSwarm` 工具（§5，最彻底）。
2. patch（备选）：`session/agentLifecycle/profile/profiles.ts:94` 改为 `subagents: []`。

子代理权限模式：继承调用方（2026-07-08 修复 bc043792e"inherit caller permission mode for subagents"，已在 2.1.1 内）。

## 7. (g) 遥测 / 自动更新 / 问卷 / 远程控制

### 7.1 遥测（"默认开启"需分路径）

- **CLI 路径**：`packages/telemetry/src/bootstrap.ts:43-47` `shouldEnableTelemetry` = 配置 `enabled !== false` 且未设 `KIMI_DISABLE_TELEMETRY`（:6）——**默认开启，证实**；关闭方式：`config.toml` `telemetry = false` 或 env。
- **node-sdk 进程内嵌入路径（本项目路径）**：**默认无云端遥测**。`SDKRpcClientV2` 构造时 `this.telemetry = options.telemetry ?? noopTelemetryClient`（`sdk-rpc-client-v2.ts:441`）；`installEngineTelemetry` 在宿主未传 client 时直接 return（:551-552）。引擎 App 作用域的 `ITelemetryService`（`app/telemetry/telemetryService.ts:300-306`）只是空总线，云端 appender `createCloudAppender` 全仓只有 kap-server（`packages/kap-server/src/services/telemetry.ts:41`）和 CLI print 模式（`run-v2-print.ts:256`）接线——SDK 嵌入路径不接。
- 引擎侧开关：`telemetry.setEnabled(config.get('telemetry') !== false)`（sdk-rpc-client-v2.ts:561）。

### 7.2 自动更新

CLI 专属：`apps/kimi-code/src/main.ts:78` 启动时 `runUpdatePreflight`（`cli/update/preflight.ts`，含 rollout 灰度、native swap）。关闭 env：`KIMI_CODE_NO_AUTO_UPDATE` / `KIMI_CLI_NO_AUTO_UPDATE`（preflight.ts:503）。**SDK 嵌入路径不经过 main.ts，天然无自动更新**；发行 CLI 时需设该 env 或 patch main.ts。

### 7.3 问卷（survey）

纯 TUI 层：`apps/kimi-code/src/tui/utils/survey-policy.ts`、`tui/components/panes/survey-panel.ts`。gate 列表含 `'telemetry-disabled'`——随遥测关闭而关闭。SDK 嵌入无 TUI，不涉及。

### 7.4 远程控制 / 插件市场

- 远程控制：`packages/remote-control/src/remote-control.ts:19` 默认 relay `https://code-rc.kimi.com`（env `KIMI_CODE_REMOTE_CONTROL_RELAY_URL` 可改）；消费方是 kap-server 的 `/api/v1/remote-control` 开关路由（`packages/kap-server/src/routes/remoteControl.ts`）与 `kimi web --remote-control`。**默认关闭，需显式开启**。
- 插件市场：`packages/agent-core-v2/src/app/plugin/marketplace.ts:8-10` 默认 marketplace URL + env `KIMI_CODE_PLUGIN_MARKETPLACE_URL` 覆盖。官方插件含 kimi-webbridge（浏览器）——fork 应将 marketplace URL 指向空/内网，或 patch 禁用插件安装，防止浏览器能力进入。

**构建期写死关闭的 patch 点**（仅当发行 CLI 时需要）：`apps/kimi-code/src/main.ts`（更新 preflight）、`packages/telemetry/src/bootstrap.ts:46`（默认 false）、`apps/kimi-code/src/tui/utils/survey-policy.ts`、marketplace.ts 默认 URL。SDK 嵌入路径均不需要。

## 8. (j) 权限系统与两个待修缺陷

### 8.1 正常审批流

工具执行前的权限评估链：`AgentPermissionPolicyService.policies`（`agent/permissionPolicy/permissionPolicyService.ts:39-55`，13 个策略按序短路：deny → dangerous-command → auto-approve → 会话历史 → ask → allow → 敏感文件 → yolo → 默认放行/兜底 ask）。`ask` 进入 `AgentToolApprovalService.requestToolApproval`（`agent/toolApproval/toolApprovalService.ts:108-155`）：先发 `PermissionApprovalRequested` 事件（observable，非 durable），再 `interactions.request({kind:'approval', ...})` 挂起等待裁决。

### 8.2 PR #2337：配置权限规则不执行 —— **证实存在**

- `[permission].rules` 解析器存在且完整（`agent/permissionRules/configSection.ts:29-41, 80-94`，支持 `rules`/`allow`/`deny`/`ask` 简写）。
- 运行时评估存在：`user-configured-rule.ts:20-35` 从 `IAgentPermissionRulesService.rules` 取规则匹配。
- **断点**：运行时规则存于 agent 状态（`permissionRulesService.ts:30-32`），唯一写入入口 `addRules()`（:38-43）→ `PermissionRulesAdd` op。**全仓库（packages+apps，排除测试）没有任何生产代码调用 `addRules` 或把 config 的 rules 喂给运行时**（grep 证实；PR #2337 讨论串中 "addRules() has zero production callers" 与代码一致）。
- GitHub API：PR #2337 "fix(agent-core-v2): honor configured permission rules" **state: open, merged_at: null**。main 分支超前的 13 个 commit 也不含该修复。
- 影响：`config.toml` 里写的 `[[permission.rules]]` 在 2.1.1 **完全无效**。中软的兜底 deny 规则不能依赖配置段，须由控制面在 `setApprovalHandler` 中裁决，或在 fork 中自行接线（patch 点：agent 创建后 `engineAccessor` → `IConfigService.get('permission')` → `IAgentPermissionRulesService.addRules()`；node-sdk 的 `engineAccessor` 逃生舱足以在 SDK 层完成，不必改引擎）。

### 8.3 issue #4070：子代理审批不触发 PermissionRequest hook —— **证实存在**

- GitHub API：issue #4070 **state: open**，报告环境即 kimi-code 2.1.1：后台子代理的审批提示出现在主 TUI，但 PermissionRequest hook 不触发、主/子 wire.jsonl 在等待期间均无记录。
- 代码机制：agent 作用域的 `IEventBus` 是 `AgentEventBusView`（`app/event/eventBusService.ts:289-294`），其 `subscribe` 对 agentDomain 事件**按 agentId 过滤**（:261-270）——主 agent 的 `AgentExternalHooksService`（`features/externalHooks/agent/agentExternalHooksService.ts:177-190` 注册 PermissionRequest/PermissionResult 转发）收不到子代理事件；且 PermissionRequest 转发本身是 fire-and-forget（:118-132），hook 结果不参与裁决。
- **对中软的实质影响与缓解**：不能依赖 PermissionRequest hook 做审批观测。**但 SDK 审批回调不受影响**——node-sdk 的 `SessionEventWiring` 按 **sessionId**（而非 agentId）桥接待决审批（`packages/node-sdk/src/v2/session-wiring.ts:178-199`），`interactions.onDidChangePending` 实时触发（:119-121），子代理审批会带 `agentId` 送达 `setApprovalHandler`（:208-219）。即"审批由我方控制面掌握"在 SDK 路径上可以完整实现，包括子代理；控制面同时可用 `agentId` 做归属计量。

### 8.4 权限模式

`PermissionMode = 'yolo' | 'manual' | 'auto'`（`packages/node-sdk/src/permission.ts:4`）；`default_permission_mode` 配置取值相同（`agent/permissionMode/configSection.ts:7`）。中软应下发 `manual`，全部审批走控制面。

## 9. Hook 失败放行 —— 证实

`features/externalHooks/app/externalHooksRunnerService.ts`：`trigger()`（:52-58）与 `fireAndForgetTrigger()`（:67-76）对所有异常 `catch → 返回 []`；`blockDecision(event, [])` 无阻断。即 hook 进程崩溃/超时/非 2 退出码均不阻断动作（Claude 约定 exit code 2 才 block，:106-108 的统计口径旁证）。**审计/留痕不得依赖 hooks**，应走控制面事件流（SDK `session.onEvent` / klient events）。

## 10. (h) MCP 客户端

**mcp.json 格式 —— 全部证实**（`mcpCore/config-schema.ts`）：
- 顶层 `mcpServers` 表（`app/mcpConfig/configLoader.ts:132-144`）；
- HTTP transport：`{ transport: 'http', url, headers?, auth?: 'oauth', bearerTokenEnvVar?, enabled?, deferred?, startupTimeoutMs?, toolTimeoutMs?, enabledTools?, disabledTools? }`（:30-37 + 公共字段 :8-15）；`url` 无 transport 字段时自动推断为 http（:59-66）；stdio/sse 同构；
- **HTTP transport 实现**：`mcpCore/client-http.ts`（另有 client-sse/client-stdio/client-remote/connection-manager）。

**加载路径与项目级自动加载**（configLoader.ts:23-32）：
- 用户级：`$KIMI_CODE_HOME/mcp.json`
- 项目根级：`<git 根>/.mcp.json`
- 项目级：`<cwd>/.kimi-code/mcp.json`

**trust 门控（2.1.1 现状，安全）**：`WorkspaceMcpConfigService.initialize()`（`workspace/workspaceMcpConfig/workspaceMcpConfigService.ts:100-115`）`includeProject: this.trust.isTrusted()`——**工作区未信任时只加载用户级**（configLoader.ts:56-59）；trust 状态存于工作区状态（`workspaceTrustService.ts`），默认 false。只要中软控制面永不调用 trust 接口，案卷目录的项目级 MCP 不会加载。建议仍打防御性 patch（见清单 P0-3）。
中软法律工具网关的接入：写用户级 `$KIMI_CODE_HOME/mcp.json`（每 worker 独立 homeDir，天然隔离），`bearerTokenEnvVar` 指向网关注入的 token 环境变量，`enabledTools` 收敛工具面。另 klient 的 `global.sessions.create` 还支持按会话传 `mcpServers`（`packages/klient/src/core/facade/global.ts:411-421`），可做更细粒度注入。

## 11. (k) 构建体系与实测

- 包管理：**pnpm 10.33.0**（根 package.json `packageManager`）；workspace：`pnpm-workspace.yaml`（`packages/*`、`apps/*` 等）。
- node 要求：**`>=24.15.0`**（根 `engines`；`.nvmrc` 24.15.0；`.npmrc` `engine-strict=true`，版本不足 install 直接失败）。本机 node v26.8.1 安装/构建/运行全部通过。
- node-sdk 构建：`tsdown`（产 ESM bundle）+ `node scripts/build-dts.mjs`（api-extractor 产 `dist/index.d.mts`）（package.json scripts）。
- **实测**：`pnpm install --frozen-lockfile` 16.8s 成功；`pnpm --filter @moonshot-ai/kimi-code-sdk run build` 成功（tsdown 446ms + api-extractor，仅 TSDoc 警告）；产物 `dist/index.mjs` 8.3MB **全量内联**（dist 中 0 处外部 `@moonshot-ai/*` import，可选依赖如 canvas 为 try/catch 软引用）。
- **端到端冒烟（用打包产物，非源码）**：`createKimiHarness({ homeDir: '/tmp/...', identity: { productName: 'ZhongsoftLegal', version: '0.0.1', platform: 'zhongsoft_legal_worker' } })` → `listSessions`（空页）→ `createSession({ workDir })` 返回真实 session id → `setApprovalHandler` 注册 → `closeSession`/`close` 干净退出。**全部通过**。
- 注意：未传 `identity` 会抛 "Kimi host identity is required"——identity 实为必填。

## 12. (i) KIMI_CODE_TRUST_WORKSPACE 与 main 分支增量

- 锁版 2.1.1 工作树中 `KIMI_CODE_TRUST_WORKSPACE` **零匹配**（全仓 grep）——此前"待发布"的判断**证实**。
- main 分支 commit `1f6f0b1fa`（#4059，2026-09-28）：`packages/agent-core-v2/src/workspace/workspaceTrust/workspaceTrustService.ts` 新增 `TRUST_WORKSPACE_ENV`，env 为真时工作区直接视为已信任 → 项目级 `.mcp.json`/`.kimi-code/mcp.json` 免确认加载（同时改了 `mcpRegistryService.ts`、kap-server workspaces 路由、CLI print 警告文案）。**中软 fork 若未来 rebase 到 2.1.1 之后的基线，这是必须 revert/patch 掉的第一优先级变更**；锁版 2.1.1 无此风险，但也应确保 worker 环境中不出现该变量（纵深防御）。
- main 超前 2.1.1 的 13 个 commit 其余多为 agent-core-v2 修复与 TUI 特性（#4091/#4083/#4081/#4061/#4057/#4056/#4054/#4031/#3998/#4023/#4018 等），无其他安全模型变更。

## 13. (l) 许可证

- 根 `LICENSE`：**MIT**（"Copyright (c) 2026 Moonshot AI"）——**证实**。
- VS Code 扩展 `apps/vscode/package.json:8`：**Apache-2.0**——**证实**。
- 各包 package.json（node-sdk/klient 等）均标 MIT。

## 14. (m) ACP 备选接入路径

- `packages/acp-server`（`@moonshot-ai/acp-server`）：Agent Client Protocol server，由 agent-core-v2 直接驱动。
- CLI 入口：`apps/kimi-code/src/cli/sub/acp.ts`——`kimi acp` 子命令，**over stdio**（文件头注释 :1-7 明确 "over stdio"），`--login` 走设备码登录；`runAcpServer` 懒加载（:60 附近 dynamic import）。
- 可行性：ACP 是面向编辑器/IDE 的通用 JSON-RPC 协议（session/prompt/审批标准件），作为"开放任务执行器"的备选接入**可行但次于 SDK 嵌入**：审批与事件粒度受 ACP 协议约束，自定义计量/权威状态字段需要 `_meta` 扩展，且子代理审批可观测性继承 §8.3 的缺陷；SDK 进程内嵌入则能拿到完整事件流、`engineAccessor` 逃生舱和 skillDirs 等宿主选项。**建议主路径 SDK 嵌入，ACP 仅作降级备选**。

---

## 15. 接入最小路径（结论）

1. fork 锁版 `f67e6398fb3210ad8ace970e2dfd5bcc984ed61f`，源码构建 `@moonshot-ai/kimi-code-sdk`（`pnpm install && pnpm --filter @moonshot-ai/kimi-code-sdk build`），产物 `dist/index.mjs` 单文件全内联，直接打进 worker 镜像。
2. 每事项隔离 worker：`createKimiHarness({ homeDir: <每事项独立目录>, identity: { productName, version, platform }, skillDirs: [<签发 skills 目录>], uiCapabilities: [] })`。homeDir 即隔离边界（配置/会话/存储全在其下）。
3. 该 homeDir 下预置 `config.toml`：`default_model`/`[providers.*]`（网关模型端点，`api_key_env`）、`default_permission_mode = "manual"`、`telemetry = false`、`builtin_product_skills = false`、`merge_all_available_skills = false`、`[tools] enabled = ["mcp__*"]`（或精确列出放行项）、`[identity] name/slug` 白标。
4. 同 homeDir 预置 `mcp.json`：仅中软法律工具网关（`transport: "http"`, `url`, `bearerTokenEnvVar`）。不调用任何 trust 接口，项目级 MCP 天然不加载。
5. 每个 `Session`：`setApprovalHandler` → 转发中软控制面裁决（子代理审批同口径到达，payload 带 `agentId`）；`onEvent` → 计量/留痕；`createSession({ permission: 'manual', agentProfile/agentFiles: <签发 profile> })`。
6. 兜底权限规则：在 SDK 层用 `engineAccessor` 把签发规则 `addRules` 进每个 agent（绕开 #2337），或干脆全部由控制面 handler 裁决。

## 16. 必打补丁清单

### P0（不打则安全模型不成立）

| # | 事项 | 要改的确切文件 | 说明 |
|---|------|--------------|------|
| P0-1 | 项目级 agent profiles 无 trust 门控、无开关 | `packages/agent-core-v2/src/workspace/workspaceAgentProfileLoader/internal/agentRoots.ts`（`projectAgentRoots` 改返回 `[]`）；或在 `workspaceAgentProfileLoaderService.ts:50` `load()` 开头短路 | 案卷目录 `.kimi-code/agents` 当前会被无条件加载并注入工具/委派声明；skills 可用 `skillDirs` 选项免 patch，agent profiles **没有**等效宿主选项，必须 patch |
| P0-2 | 项目级 skills 无 trust 门控 | 首选免 patch：SDK `skillDirs` 选项（§4）；若不用该选项则 patch `packages/agent-core-v2/src/features/skill/catalog/skillRoots.ts` `projectRoots()` | 推荐免 patch 路径 |
| P0-3 | 项目级 MCP 防御性写死 | `packages/agent-core-v2/src/workspace/workspaceMcpConfig/workspaceMcpConfigService.ts:108 与 :167`：`includeProject: this.trust.isTrusted()` → `includeProject: false` | 2.1.1 默认已安全（trust=false 不加载），此 patch 防止控制面误调 trust API 后失守 |
| P0-4 | 升级闸门：`KIMI_CODE_TRUST_WORKSPACE` | （仅 rebase 到 >2.1.1 时）revert #4059 对 `workspaceTrustService.ts` 的改动；并在 worker 镜像中断言该 env 不存在 | 锁版 2.1.1 无此变量，当前无需动作 |
| P0-5 | 配置权限规则不执行（#2337） | 免改引擎：SDK 层经 `engineAccessor` 接线 `IAgentPermissionRulesService.addRules()`；或 backport PR #2337（其改动在 `agent/permissionRules/` 与 agent bootstrap 绑定处） | 若审批 100% 经控制面 `setApprovalHandler` 裁决可降为 P1，但建议保留配置层 deny 兜底 |

### P1（强化与白标）

| # | 事项 | 要改的确切文件 | 说明 |
|---|------|--------------|------|
| P1-1 | 内置工具收敛 | 免 patch：`config.toml [tools] enabled = ["mcp__*"]`（语义见 `agent/toolPolicy/evaluate.ts:10-29`） | 同时关闭 `Agent`/`AgentSwarm`，连带关闭全部内置子代理派发 |
| P1-2 | 默认 profile 委派列表 | 免 patch：签发 `agentFiles` 自定义默认 profile（`subagents: []`）；或 patch `session/agentLifecycle/profile/profiles.ts:94` | 与 P1-1 二选一即可，建议双保险 |
| P1-3 | 插件市场/浏览器插件 | `packages/agent-core-v2/src/app/plugin/marketplace.ts:8-10` 默认 URL 指向空响应或内网镜像 | 防止 kimi-webbridge/computer-use 插件把浏览器能力带进执行器 |
| P1-4 | 遥测/更新/问卷/远程控制 | SDK 嵌入路径**全部免 patch**（§7）；仅当发行 CLI 时：`apps/kimi-code/src/main.ts:78`、`packages/telemetry/src/bootstrap.ts:46`、`cli/update/preflight.ts:503` | 配置 `telemetry=false` 已够，写死只是纵深防御 |
| P1-5 | 白标 | 免 patch：`[identity]` 配置 + `KimiHostIdentity`；`builtin_product_skills = false`；`DEFAULT_PRODUCT_NAME` 在 `app/agentProfileCatalog/profile-shared.ts:107`（如需彻底改名可 patch） | 系统提示中的 "Kimi Code CLI" 字样来自该常量 |

### P2（认知即可，视验收标准决定是否处理）

| # | 事项 | 位置 | 说明 |
|---|------|------|------|
| P2-1 | Hook 失败放行 | `features/externalHooks/app/externalHooksRunnerService.ts:52-76` | 审计不走 hooks 即可；若要 hooks 可阻断需重构 trigger 错误语义 |
| P2-2 | 子代理 PermissionRequest hook 缺陷（#4070） | `app/event/eventBusService.ts:261-294`；`features/externalHooks/agent/agentExternalHooksService.ts:177-190` | SDK `setApprovalHandler` 不受影响（§8.3），控制面审批不依赖 hooks；仅当第三方 hook 生态接入时需修 |
| P2-3 | `merge_all_available_skills` 默认 true 且发现根向上找 `.git` | `features/skill/catalog/skillRoots.ts:72-74` | worker 工作目录若意外处于某 git 仓库内，发现根会爬到仓库根；用 `skillDirs` 后此链路整体跳过 |
| P2-4 | `engineAccessor` 公开逃生舱 | `packages/node-sdk/src/sdk-rpc-client-v2.ts:608-610` | fork 自用是特性；注意不要在暴露给事项代码的层泄漏该对象 |

---

## 附：关键文件速查

- 嵌入入口：`packages/node-sdk/src/sdk-rpc-client-v2.ts`（:348 选项、:431 构造、:2810 createKimiHarness）
- 审批：`packages/node-sdk/src/session.ts:128`；`packages/node-sdk/src/v2/session-wiring.ts:178-225`
- 引擎 bootstrap：`packages/agent-core-v2/src/app/bootstrap/bootstrap.ts:143-173`
- 配置全景：`packages/agent-core-v2/docs/config-manifest.toml`
- 内置 profile：`packages/agent-core-v2/src/session/agentLifecycle/profile/profiles.ts`
- 信任模型：`packages/agent-core-v2/src/workspace/workspaceTrust/workspaceTrustService.ts`、`workspace/workspaceMcpConfig/workspaceMcpConfigService.ts`
