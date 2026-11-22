# D3 上游 Kimi Code 升级——证据（2026-11-22）

> 只读调研。上游证据来源：`api.github.com/repos/MoonshotAI/kimi-code/releases`（11-22 读取，发布说明原文存于 scratchpad `upstream/notes.md`）、对 `github.com/MoonshotAI/kimi-code` 的 treeless 克隆（tag 与提交号）。本方证据：worktree `platform/` 与 fork `/Users/wangzeyu/Documents/Coding/Kimi Work Legal/platform/third_party/kimi-code`（HEAD 472192c34，只读查看）。
> 在 V29 B 审计方向 4 之上补证据，不重复其结论。

## 一页摘要（事实要点）

1. 宿主生产路径实际用到的上游接口：11 条路由 + `subscribe` 事件流 + 21 种事件 + 10 个种子 DI 标识（第 1 题）；`/snapshot`、`tasks/:id:cancel`、`children` 只在测试或未被调用。
2. 到 2.7.2 已删或改：审批/问题答复与列表（2.4.0 #4428）、`subscribe`+`/snapshot`（2.5.0 #4470）、任务 REST（2.5.0 #4535）、`/status`（2.5.0 #4606）、WS 原始事件 schema（2.5.0，events-zod 1128→147 行）、file-history `turn_id`（2.6.0 #4826）、会话 `:abort`/`children`/`goal`（2.7.0 #4965/#4963，**发布说明未列**）。V29 审计漏了审批答复与 `:abort` 两项，这两项都在核心路径上。
3. 宿主消费的 21 种**核心事件在 agent-core-v2 2.7.2 里全部仍在**，定义文件只改了 +53/−33 行；被删的是 kap-server 的转发层。
4. 上游没有公开安全公告（`security-advisories` = `[]`）。发布说明里没有 K3 专项条目。升级收益在长会话压缩、后台通知、子 Agent 超时、工具声明重复这几类修复。
5. 抽查 13 个修复提交，**0 个能干净应用到 2.2.0**：2.2.0 出自隔离发布分支，loop/compaction 的目录结构已经不同。
6. ZP 补丁移到 2.7.2：预计干净 3 项、小冲突 4 项、需重写 9 项、可删 2 项（ZP-9a 的目标文件已删，#4066 已发布）。另有 5 个新的 child_process 导入者和 7 个新的 net/http 导入者待封闭。
7. 适配到 2.7.2 粗估 17～28 人日。上一次 rebase（2.1.1→2.2.0）估 5～7 人日，当时没有接口断裂。
8. 上游每周一个小版本。破坏性改动写在 Patch 节，没有弃用期，没有稳定承诺；所有包都是 `private: true`；进程内嵌入不是上游支持的用法。2.7.0 起上游有 KAP 1.0.0 文档（本机 HTTP）和 `stdioRpc`（在 Duplex 上用 inject 加假 WS）。
9. License：MIT，2.2.0→2.7.2 无变化。

---

## 1. 我们到底依赖上游哪些接口

### 1.1 嵌入入口（ZP-19 `kap-server/src/embed.ts`，fork 内 240 行）

`createEmbeddedServer(opts)` 返回 `{core, inject, subscribe, registeredRoutes, close}`（fork `packages/kap-server/src/embed.ts:75-82`）。内部：
- `bootstrap(...)`（agent-core-v2，`embed.ts:105-122`），args 含 `trustedInstructionsDir`（ZP-18 新增）与 `uiCapabilities: ['update_panel']`；
- 进程内 Fastify，注册 9 组路由函数：`registerSessionsRoutes / Prompts / Approvals / Questions / Tasks / Messages / FileHistory / Snapshot / Transcript`（`embed.ts:163-179`）；
- `subscribe` = 直接挂到 `transport/ws/v1/sessionEventBroadcaster.ts` 的 `SessionEventBroadcaster.subscribe(sessionId, target)`（`embed.ts:155-161, 203-215`）——即 **WS v1 事件广播器的进程内用法**，不经 WebSocket；
- `close` 依赖 agent-core-v2 导出的 `drainSessionMetadataWrites / drainSessionIndexMirror / drainQueryStoreDisposals / drainLogCloses / ISessionIndexMirror / IAppendLogStore / IMcpOAuthService`（`embed.ts:217-230`）。

### 1.2 宿主经 `inject()` 调用的路由（`packages/kap-host/src/kap-client.ts:28-52` 白名单；实际调用处见右列）

| 接口 | KapClient 方法（kap-client.ts 行） | 生产代码调用处 | 用途 |
|---|---|---|---|
| `POST /sessions` | createSession :130 | runtime.ts:456 | 建会话 |
| `GET /sessions/:id` | getSession :134 | runtime.ts:452 | 续会话后取会话 |
| `POST /sessions/:id:restore/:abort/:archive` | sessionAction :156 | runtime.ts:451、539、715、745、874、887 | 续会话、中止、终态后拦截新回合 |
| `GET /sessions/:id/status` | status :138 | runtime.ts:719 | 超时诊断取 busy/plan_mode |
| `POST /sessions/:id/profile` `{agent_config:{plan_mode:true}}` | enterPlanMode :173 | runtime.ts:525 | “先出计划” |
| `POST /sessions/:id/prompts` | prompt :143 | runtime.ts:526 | 发提示词（只文本 + 宿主指定模型） |
| `GET /sessions/:id/goal` | goal :177 | runtime.ts:721 | 超时诊断 |
| `GET /sessions/:id/tasks` | tasks :206 | runtime.ts:720 | 超时诊断 |
| `POST /sessions/:id/approvals/:aid` | resolveApproval :186 | runtime.ts:656、753、832、861 | 审批答复（不带 scope） |
| `POST /sessions/:id/questions/:qid` | answerQuestion :197 | runtime.ts:806 | 问题答复 |
| `GET /sessions/:id/file-history/changes` | fileChanges :222 | runtime.ts:900 | 本回合文件改动 |
| `GET /sessions/:id/snapshot` | snapshot :233 | **仅测试** p1-kap-host.test.ts:417 | — |
| `GET/POST …/children` | children/createChild | **仅测试** p1-kap-host.test.ts:504-505 | — |
| `GET …/tasks/:tid`、`POST …/tasks/:tid:cancel` | task/cancelTask | **无调用**（grep packages/ 全量） | — |
| `GET …/approvals`、`GET …/questions`、`…/questions/:id:dismiss`、`…/prompts/:id:abort`、`GET …/messages`、`GET …/file-history/content` | pending*/dismissQuestion/abortPrompt/messages/fileContent | **生产代码无调用**（grep 未见 engine.kap.* 用法） | 白名单内备用 |

> 更正 V29 方向 4.1 的口径：`/snapshot` 与 `tasks/:id:cancel` 在白名单里，但**生产路径不调用**；真正在用、且上游已删的是 `GET /tasks`（诊断）、`GET /status`（诊断）、`POST approvals/:id`、`POST questions/:id`（核心交互）和 `subscribe`（核心事件流）。见第 2 题。

### 1.3 事件流（`subscribe`）——宿主读取的事件类型与字段

调用：`matter-engine.ts:249` → `kap-client.ts:237` → `embed.ts:203`；消费：`runtime.ts:534-625`（`onEngineEvent`）与 `progress.ts`（过程快照）。字段锁定清单在 `test/embed-drift.test.ts:274-296`（`CONSUMED`）：

| 事件 | 字段 | 消费处 |
|---|---|---|
| `turn.started` / `turn.ended` / `turn.step.completed` / `turn.step.retrying` | agentId, turnId, reason, error, finishReason, providerFinishReason, maxAttempts, nextAttempt, statusCode | runtime.ts:557-625、progress.ts:98-104 |
| `assistant.delta`、`thinking.delta` | agentId, delta | runtime.ts:563、progress.ts:98-99 |
| `tool.call.started` / `tool.result` | agentId, args, description, name, toolCallId, turnId / isError, output | runtime.ts:578-583、progress.ts:120-152 |
| `permission.approval.requested` / `.resolved` | id/approvalId, decision 等 | runtime.ts:584-592 |
| `event.question.requested` / `.answered` | question_id, questions | runtime.ts:594-603 |
| `subagent.spawned/completed/failed/cancelled/suspended` | subagentId, subagentName, description, runInBackground, swarmIndex, resultSummary, usage, error | progress.ts:162-196 |
| `compaction.started/completed/blocked/cancelled` | agentId, trigger, result(tokensBefore/After/droppedCount) | progress.ts:200-229 |
| `task.started/terminated`、`background.task.started/terminated` | info(taskId, description, status, kind) | progress.ts:235 起 |
| `error` | code, message, retryable | runtime.ts:610 |
| `exec.queued`/`exec.finished` | （宿主自有执行域事件，非上游） | runtime.ts:368 |

另锁：`taskInfoSchema` 种类 `agent/process/question`、`taskLifecycleStatusSchema` 六值、`tokenUsageSchema` 四键、工具入参 schema 顶层键（AgentSwarm、Agent、TodoList、NotifyUser、Skill、WebSearch、FetchURL、Bash）（embed-drift.test.ts:411-431）。

### 1.4 种子注入点与其他制品导出（`vendor/kap-embed/kap-embed.mjs`，由 `scripts/build-kap-embed.mjs:38-51` 打包，入口映射 `@moonshot-ai/kap-server/embed`、`kap-server/journal`、`agent-core-v2`、`agent-core-v2/storage`、`agent-core-v2/query-store`、`minidb/query`）

| DI 标识 / 导出 | 宿主位置 | 用途 |
|---|---|---|
| `IHostProcessService` | seeds.ts:186 | 执行域路由（Bash/Grep/Glob） |
| `IHostFileSystem` | seeds.ts:187 | 事项文件 broker |
| `IHostTerminalService` | seeds.ts:188 | 拒绝（ZP-12） |
| `IHostEnvironment` | seeds.ts:189 | 固定环境（ZP-16） |
| `IHostPolicyProvider` | seeds.ts:190 | 宿主策略（**ZP-4 新增的接口**，上游无） |
| `IProjectLocalConfigService` | seeds.ts:191 | 只读空实现 |
| `ITelemetryService` / `noopTelemetryService` | seeds.ts:193 | 遥测关闭 |
| `IFileSystemStorageService`、`IQueryStore` | seeds.ts:184-185 | 加密落盘（ZP-9） |
| `IAtomicTomlDocumentStore`、`ScopeSeed` | seeds.ts:17-29 | 配置存储 |
| `JournalIo`、`toStorageIoError` | sealed-storage.ts:17 | 事件日志加密（**ZP-9a 新增接口**） |
| `configureTrustedRipgrep` | main.ts:20、273 | 可信 rg（**ZP-20 新增**） |
| `minidbGetPath`、`minidbMatch`、`QueryStoreRebuiltError` | memory-query-store.ts:8 | 内存查询库 |
| `createEmbeddedServer`、`EmbeddedServer`、`EventEnvelope` | matter-engine.ts:16、211 | ZP-19 |


---

## 2. 2.2.0 → 2.7.2 每个小版本改了什么

发布日期（GitHub releases `published_at`）与 tag 提交：2.2.0 10-14 `472192c34`；2.3.0 10-21 `b5e28fd6b`（2.3.1 10-23、2.3.2 10-25、2.3.3 10-26）；2.4.0 10-28 `f26e4d91e`（2.4.1 10-30）；2.5.0 11-04 `41c341434`（2.5.1 11-05、2.5.2 11-06、2.5.3 11-10）；2.6.0 11-12 `740d6c0bd`（2.6.1/2.6.2 11-13、2.6.3 11-17）；2.7.0 11-19 `a5e355e27`（2.7.1、2.7.2 11-20 `56145f849`）。下面引文均为发布说明原文。

### 2(a) 删除/改名、命中第 1 题清单的接口

| 版本 / PR | 原文（节选） | 命中我们的 | 上游给出的替代 |
|---|---|---|---|
| **2.4.0 #4428**（`461c6e9`） | "Replace the server's WebSocket `event.approval.*` and `event.question.*` events with a single flat `interaction` frame, and replace `POST /sessions/{id}/approvals/{id}`, `POST /sessions/{id}/questions/{id}` and `POST /sessions/{id}/questions/{id}:dismiss` with `POST /sessions/{id}/interactions/{id}`; the old events and endpoints, along with `GET /sessions/{id}/approvals` and `GET /sessions/{id}/questions`, are removed." | resolveApproval（runtime.ts 4 处）、answerQuestion（runtime.ts:806）、事件 `event.question.requested/answered`（runtime.ts:594-603） | `POST /sessions/{id}/interactions/{id}`（2.7.2 `kap-server/src/routes/interactions.ts:89-` body 带 `kind`）；WS `interaction` 帧；2.7.0 #4966 加 `GET /sessions/{id}/interactions` |
| **2.5.0 #4470**（`8535bd7`） | "Remove the server's WebSocket `subscribe` / `unsubscribe` frames with their cursor replay and `resync_required`, `GET /sessions/{id}/snapshot`, and the session `last_seq` field; subscribe to sessions with `subscribe_v2` …" | `subscribe`（核心事件流）、`/snapshot`（仅测试） | `subscribe_v2`；进程内仍是 `SessionEventBroadcaster.subscribe(sessionId, target, agentIds, accepted?)`（2.7.2 `sessionEventBroadcaster.ts:210-248`，签名多了 `agentIds`，返回 `void` 不再返回 ok） |
| **2.5.0 #4535**（`ebc2a9f`） | "Remove the REST task endpoints (`GET /sessions/{id}/tasks`, `GET /sessions/{id}/tasks/{task_id}`, and the `:cancel` / `:detach` actions); use the WebSocket task frames and the `task.stop` / `task.background` requests instead." 另："Send each agent's running tasks … as a `task.list` frame followed by a `task` frame on every change" | tasks（runtime.ts:720 诊断）；task/cancelTask（无调用） | WS `task.list`/`task` 帧、`task.stop`/`task.background`/`task.watch` |
| **2.5.0 #4606**（`011b1d4`） | "Remove `GET /sessions/{id}/status` … read the main agent's state from the WebSocket `agent` and `usage` frames instead." 另："transcripts and the REST transcript endpoints no longer include `meta` or `todos`" | status（runtime.ts:719 诊断） | WS `agent`/`usage`/`goal`/`todo` 帧 |
| **2.5.0（事件模式）** | 无单条说明；实测 `kap-server/src/protocol/events-zod.ts` 行数 2.4.1=1128 → 2.5.0=147 → 2.7.2=121，`tool.call.started`、`turn.*`、`assistant.delta`、`compaction.*`、`subagent.*`、`task.*` 等 **全部 21 种宿主消费的事件类型在 2.5.0 起不再出现在 WS 事件 schema**（2.7.2 只剩 config/session/workspace/capability/host/model_catalog 等全局帧） | `embed-drift.test.ts:274-296` 的 CONSUMED 全部 | 改为会话对话流（见下行）。**但**这些事件在 agent-core-v2 内核里仍然存在：2.7.2 的 `agent/loop/turnEvents.ts`（turn.started/turn.step.completed/turn.step.retrying/assistant.delta/thinking.delta）、`agent/toolExecutor/toolExecutorEvents.ts`（tool.call.started/tool.result）、`agent/fullCompaction/compactionOps.ts`（compaction.* 四种）、`agent/toolApproval/toolApprovalService.ts`（permission.approval.requested）都在；2.2.0→2.7.2 这三个事件文件只改 +53/−33 行（新增 `turn.step.stream_reset`、`origin`、`block` 字段；部分事件 `durable` 由 true 改 false）。广播器仍经 `IEventService.subscribe` 收它们（2.7.2 `sessionEventBroadcaster.ts:187-189`） |
| **2.6.0 #4663**（`1dd5578`） | "Stream each subscribed agent's conversation over the server WebSocket as `turns`, `turns.removed`, `turns.failed`, `turn.*`, `item.*` and `notice` frames … `subscribe_v2` takes `agent_ids` … the transcript frames and the `GET /sessions/{id}/transcript` endpoints … are no longer available." 另 "Report context compaction as a `compacting` flag on the WebSocket `agent` frame." | embed.ts 注册的 transcript 路由（宿主不调用） | 会话对话帧（`ConversationService`/`ConversationFeed`） |
| **2.6.0 #4826**（`13590cd`） | "The server API's file-history queries no longer accept `turn_id`; pass `turn_number` instead." | fileChanges（runtime.ts:900，传 `turn_id`） | `turn_number` |
| **2.6.0 #4839**（`afadca2`）、#4778、#4842 | "Server API sessions now get their agent profile, model, and thinking level when created; prompts no longer accept `profile`, so pass `agent_config.profile` when creating the session instead." | prompt 带 `model`（kap-client.ts:145-149）与 enterPlanMode 走 profile 路由——2.7.2 下 prompt 是否仍收 `model`、`/profile` 设 `plan_mode` 是否同语义：**未核实**（未读 2.7.2 `rest-prompt.ts`/`rest-session.ts` 全文） | 建会话时传 `agent_config` |
| **2.6.0 #4663** | "`POST /sessions/{id}:undo` now takes the `turn_id` …" | 不用 | — |
| **2.7.0 #4891**（`f538d53`） | 删 `/api/v2/sessions*`、`/api/v2/mcp/*` | 不用（我们只用 v1） | — |
| **2.4.0 #4247**（`0325b75`） | "Plan mode now starts only when you turn it on, and every plan waits for your review: the agent can no longer enter Plan mode by itself …" | 我们由宿主经 profile 打开（属“用户打开”），语义上兼容；未实测 | — |
| 2.5.0 #4516 | 全局全文检索索引默认关闭 | 不用 | — |

另：**2.7.0 有两条未写进发布说明的破坏性提交**——`b95745796` #4965（删 deprecated 路由、会话 `:abort` 改 `:cancel`）与 `2f33641b7` #4963（会话状态压缩、snake_case 契约），见 2(e)。

小结：命中清单的被删接口共 **7 组**（approvals/questions 答复与列表、subscribe 与事件 schema、snapshot、tasks、status、file-history 参数名），分布在 2.4.0（1 组）、2.5.0（4 组）、2.6.0（2 组）。**V29 方向 4.1 漏了 2.4.0 #4428（审批/问题答复路由删除）与 2.5.0 #4606（`/status` 删除）**——审批答复是宿主核心交互，不只是诊断。

### 2(b) 安全修复与数据丢失类修复

| 版本 / PR | 原文 | 与我们相关性 |
|---|---|---|
| 2.5.0 #4649（`75f35b0`） | "never run a git or gh executable located inside the opened folder when reading git status" | 低：ZP-17 已封闭 git 直接执行 |
| 2.6.0 #4777（`b9c1897`） | "Stop sending server stack traces in error responses" | 低：无端口，响应只给宿主 |
| 2.3.0 #4250（`6e7cc90`） | `dangerous_command_guard = false` 关全部内置确认守卫 | 我们不依赖上游守卫（宿主策略首位） |
| 2.6.0 #4848（`9ae2757`） | "Prevent multiple app instances from restoring the same session and running its pending task turns concurrently." | 中：数据一致性 |
| 2.7.0 #4866（`0ea324c`） | "Fix conversation history disappearing during live trimming, long-turn folding, and replay of damaged session journals." | 初判“高”，**经 3(b) 查提交内容更正为无关**：只改 TUI 与 node-sdk |
| 2.4.0 #4280（`67325c1`） | "interrupted turns are now marked instead of shown as completed" | 中：中断回合误标完成 |
| 2.6.0 #4846（`ac09c02`） | 同时两次 undo 误删前面回合 | 不用 undo |
| 2.6.3 #4989（`9c75e5a`）、2.6.0 #4836（`5ad9aa1`） | 恢复/分支时后台任务通知意外触发新回复；resume 后重复的后台任务通知 | **中高**：runtime.ts:537-540 正是为“终态后引擎又起回合”做的兜底 |
| 2.6.2 #4905 | 拒绝失败的 Kimi 媒体上传 | 不用 |
| 2.4.0 #4422（`2e539f2`） | 工作区资源泄漏 | 中：长驻宿主 |

发布说明里**没有**标注 CVE/GHSA 或 “security” 字样的条目（全文 grep “security/CVE/GHSA” 无命中，仅上述行为类改动）。GitHub Security Advisories：`GET /repos/MoonshotAI/kimi-code/security-advisories` 返回空数组 `[]`（11-22，未认证，只能看到已公开的）。即：上游 2.3～2.7 **没有公开的安全公告**，不升级损失的是行为/稳定性修复，不是已登记漏洞补丁。

### 2(c) 长会话、压缩、工具调用可靠性、模型适配（升级收益）

| 版本 / PR | 原文 |
|---|---|
| 2.6.1 #4907（`397248f`） | "Fix long sessions stalling with empty replies instead of compacting when tool results include notes, errors, or timing headers." |
| 2.6.0 #4822（`4ac656c`） | "Fix context compaction being cancelled when system reminders arrive during compaction …" |
| 2.4.0 #4410（`a9dc3a9`） | 压缩在动态 MCP 工具开启时未命中提示缓存 |
| 2.7.0 #5096（`cab0c0e`） | 压缩请求超 Opus 5 / Haiku 5 输出上限（非 K3） |
| 2.7.0 #4868（`68b849c`） | "Fix subagents timing out immediately in `kimi -p` and when `[subagent] timeout_ms = 0` is set." |
| 2.4.0 #4430（`93137ca`） | 子 Agent 被停/超时/失败时把已写文本作为不完整结果交回父 Agent |
| 2.4.1 #4553（`9140ea0`） | 单次读文件上限由 50 万字符降到 10 万字符/约 2.5 万 token（`[read] max_chars` 可调）——**行为变化，对长合同有影响** |
| 2.4.1 #4521 | 缩短内置工具与子 Agent 提示词；缩短 goal/plan 提醒 |
| 2.5.0 #4477（`02d2e8f`） | 模型错误原样显示、重试须显式 retryability |
| 2.5.1 #4687（`2af56d2`） | "Fix repeated HTTP 400 errors in sessions caused by empty system messages for dynamic tool schemas." |
| 2.5.2 #4728、2.6.0 #4719/#4720/#4862 | 重复工具声明错误、过期工具定义 |
| 2.6.0 #4708、2.5.0 #4609 | 不再禁止同文件多次 Edit、不再要求每次 Edit 前重读；不再禁止 Bash `sed` |
| 2.6.0 #4713、#4834、#4799 | 技能走 Skill 工具；超大技能内容截断存文件；Skill 工具关闭时技能目录不丢 |
| 2.6.0 #4855 | 流中失败的半截回复与自动重试回复并存 |
| 2.6.0 #4854、#4772 | 停止的工具调用输出保留；停回合后运行中工具误标失败 |
| 2.5.3 #4762（`e1912c8`） | steering 打断进行中的模型请求并在同一轮继续；`POST /sessions/{id}/steer` |
| 2.6.3 #4994 | 前台 Shell 命令输出重复 |
| 2.7.0 #4886 | 后台 Bash 截断输出乱码 |
| K3 专项 | 发布说明全文 grep “K3/kimi-k3/Kimi K” **无命中**；无 K3 专项适配条目 |

### 2(d) 新增进程/网络入口（会撞 `static-surface.test.ts` 白名单）

发布说明中可见的新入口：2.5.0 #4062 “creation-time SSH, Docker, and custom-command environments”；2.7.0 #4784 SSH 主机配置（“each host using its own Kimi login”）；2.7.0 #4895 Amazon Bedrock 提供方；2.7.0 #5053 Bash 子进程带 `KIMI_CODE_SESSION_ID`；2.7.0 #4754 下一句预测（实验）；2.4.0 #4342 导入 Claude Code/Codex 会话；2.4.0 #4283 MCP 自动重连；2.7.0 #4966 `GET /api/v1/kap.md`、`:wait`。
制品级（`node:child_process`/`node:net`/`undici`/`ws` 的导入者集合）是否变化：见第 3 题末尾的源码检查结果。

### 2(e) 2.7.2 源码直接核对（补发布说明没写的）

源码：`codeload.github.com/MoonshotAI/kimi-code/tar.gz/56145f849`（= tag 2.7.2）。

| 我们用的 | 2.7.2 现状 | 证据 |
|---|---|---|
| `POST /sessions/:id:abort`（runtime.ts 6 处） | **不存在**；会话动作只剩 `cancel / wait / restore / archive`。删除于 **2.7.0**：提交 `b95745796` #4965 “refactor(kap-server): remove deprecated routes and replace session abort with cancel”（11-17）——**发布说明未列此条** | 2.7.2 `kap-server/src/routes/sessions.ts:587-591`；`routes/sessions.ts` 中 `'abort'` 计数 2.6.3=2、2.7.0=0 |
| `POST /prompts/:id:abort` | 仍在 | `routes/prompts.ts:507` |
| `GET /sessions/:id/children`、`GET /sessions/:id/goal` | **不存在**；2.6.3 的 `routes/sessions.ts` 仍有、2.7.0 起无，同在 #4965（`b95745796`）或 #4963（`2f33641b7` “compact session state, global events, and snake_case contracts”）——具体哪一个未逐行确认 | 2.7.2 `kap-server/src/routes/` |
| `POST /profile {agent_config:{plan_mode:true}}` | 仍支持，语义为“开/关计划模式” | `routes/sessionAgentConfig.ts:114-118` |
| `POST /prompts` 带 `model` | 仍接受（`model: z.string().min(1).optional()`），`profile` 只在创建时 | `protocol/rest-prompt.ts:25-26` |
| `file-history` 参数 | 只认 `turn_number` | `routes/fileHistory.ts:63-64,102` |
| 路由文件 | 2.2.0 的 `approvals.ts / questions.ts / snapshot.ts / tasks.ts / transcript.ts / messages.ts / terminals.ts / runtime.ts / guiStore.ts / connections.ts / v2/` 全部删除；新增 `interactions.ts / conversation.ts / environment.ts / hosts.ts / mcp.ts / session*.ts` 等 | `git ls-tree` 两 tag 对比 |
| `transport/ws/v1/sessionEventJournal.ts`（ZP-9a 加密对象） | **删除**；kap-server 内直接写盘的文件只剩 `instanceRegistry.ts / promptMedia.ts / auth/privateFiles.ts`（2.2.0 还有 sessionEventJournal、guiStoreService） | grep `appendFile|createWriteStream|writeFile(` |
| 核心事件（宿主消费的 21 种） | **全部仍由 agent-core-v2 发出**：turn.* / assistant.delta / thinking.delta（`agent/loop/turnEvents.ts`）、tool.*（`agent/toolExecutor/toolExecutorEvents.ts`）、compaction.*（`agent/fullCompaction/compactionOps.ts`）、subagent.*（`session/subagent/mirrorAgentRun.ts`、`features/swarm/session/sessionSwarmService.ts`）、task.* / background.task.*（`agent/task/types.ts`）、permission.approval.requested/resolved（`agent/toolApproval/toolApprovalService.ts`） | 2.7.2 源码 grep |
| `IHostTerminalService` | **不存在**（终端路由也删了） | grep 无定义 |
| 其余种子 DI 标识 | `IHostProcessService`（`os/interface/hostProcess.ts`）、`IHostFileSystem`、`IHostEnvironment`、`IProjectLocalConfigService`、`ITelemetryService`、`IFileSystemStorageService`、`IQueryStore`、`IAtomicTomlDocumentStore`、`IAgentTaskService`、`ISessionIndexMirror`、`IAppendLogStore`、`drainLogCloses`、`drainSessionMetadataWrites`、`logSeed`、`resolveLoggingConfig` 都还在 | grep `export … <名>` |
| 新包 `@moonshot-ai/core` | “Loop, llm, and tool runtime without DI or adapters”（`packages/core/package.json`），agent-core-v2 依赖它（`agent-core-v2/package.json:72`），agent-core-v2 内 125 个文件从它导入；LLM 首包头超时与 undici 调度器搬到 `packages/core/src/llm/transport/headers-timeout.ts:1,11` | — |
| 上游“无 TCP 端口”模式 | 2.7.0 #4784（`13d363e18`，11-17）新增 `kap-server/src/transport/stdioRpc.ts`（302 行）：`attachRpcStream(stream: Duplex, {app, wssV1})` 在任意 Duplex 上用 `app.inject()` 转发 HTTP、用 `FakeWebSocket` 转发 WS 帧；`startServer({socketPath})` 时不 `listen` TCP、改起 Unix 套接字（`start.ts:681-684`）并关闭鉴权（`start.ts:165`）。用途是 SSH 远端主机，**不是**进程内嵌入，但证明上游自己在用“inject + 假 WS”这条路 | 2.7.2 源码 |

### 2(f) 进程/网络入口源码计数（第一方 `agent-core-v2/src` + `kap-server/src`，不含测试）

| 模块 | 2.2.0 fork（已打补丁） | 2.7.2（未打补丁） |
|---|---|---|
| `child_process` 导入者 | 2 | 11 |
| `net` | 4 | 7 |
| `http` | 3 | 8 |
| `undici` | 3 | 1（只剩 `_base/utils/proxy.ts`；首包头超时搬进 `packages/core`，未计入） |
| `ws` | 4 | 6 |

2.7.2 新增的 `child_process` 导入者（扣除 ZP-16/17 已封闭的 4 个同名文件后）：`app/auth/feedback/codebase/scanner.ts`、`persistence/backends/node-fs/sessionLockService.ts`、`remote/client/execBridge.ts`、`remote/client/remoteSession.ts`、`kap-server/services/hosts/sshKapBridge.ts`。新增 `net/http` 导入者：`remote/askpass.ts`、`remote/client/sshAskpass.ts`、`kap-server/routes/sessions.ts`、`routes/mcp.ts`、`services/hosts/hostProxy.ts`、`hostSession.ts`、`transport/stdioRpc.ts`。**这些是否会被打进嵌入制品取决于入口可达性，未构建验证**；`static-surface.test.ts` 是精确集合，只要进制品就会失败。

---

## 3. 补丁可移植性（ZP 逐条，以 2.7.2 为目标）

方法：对每个补丁目标文件看 2.7.2 是否存在、`git diff --numstat 2.2.0 2.7.2`（上游自身改动行数），并抽查上游是否已改变相应行为。未实际 `git apply` 整份补丁到 2.7.2（**未核实**冲突数）。

| ZP | 目标文件（2.7.2） | 上游改动 | 上游是否已以别的方式解决 | 判断 |
|---|---|---|---|---|
| #4059 revert | `KIMI_CODE_TRUST_WORKSPACE` 现集中在新文件 `workspace/workspaceTrust/trustEnv.ts:3`；`workspaceTrustService.ts` +60/−38 | 重构 | 否（变量仍在） | **需重写** |
| ZP-1 | `agentRoots.ts` 未改；`projectAgentRoots()` 仍真实查找（:31-37） | 0 | 否 | 仍需，预计干净 |
| ZP-2 | `workspaceMcpConfigService.ts` +259/−28；`includeProject` 现为 `trusted`/`this.trust.isTrusted()`，**3 处**（:145、:180、:280；2.2.0 为 2 处） | 大 | 否（改为跟随工作区信任） | **需重写** |
| ZP-3 | `marketplace.ts` +231/−40 | 大 | 否 | 需重写（小） |
| ZP-4 | `permissionPolicyService.ts` **未改**；`hostPolicy.ts` 为我方新增 | 0 | 否 | 仍需，预计干净 |
| ZP-4b | `beforeToolExecuteEvent.ts` +2/−2；`allow()` 仍在（:55） | 小 | 未核实是否仍短路 | 仍需，可能小冲突 |
| ZP-11 | `webService.ts`、`web.ts`、`fetchUrlTool.ts`、`moonshot-fetch-url.ts` **均未改**；本机直连回落仍在（`webService.ts:16,33,37,55,78`） | 0 | 否 | 仍需，预计干净 |
| ZP-14 | `default-tool-approve.ts` −1（放行清单仍含 Read/Grep/Glob，:7-10）；`git-cwd-write-approve.ts` +32/−27 | 小/中 | 否 | 仍需，后者可能冲突 |
| ZP-16 | `environmentProbe.ts` +2；`shellPathBridge.ts` +25/−12 | 小/中 | 否（两文件仍导入 child_process） | 仍需，可能冲突 |
| ZP-17 | `fileLaunch.ts` 未改；`tower/protocol/git.ts` +9/−4；`runHook.ts` +4/−2；**另有 5 个新 child_process 导入者**（见 2(f)） | 中 | 否 | **仍需 + 需扩面** |
| ZP-18 | `workspaceInstructionsService.ts` +74/−31（仍重载 AGENTS.md，:63、:176）；`rootFileSkillSource.ts` +59/−21；`userFileSkillSource.ts`、`bootstrap.ts` 未改；2.7.2 无 `trustedInstructionsDir` | 中 | 否 | **需重写**（前两文件） |
| ZP-19 embed.ts | 依赖的 9 组路由中 6 组已删；`SessionEventBroadcaster` 构造参数改为 `{core, logger, conversations}`、`subscribe` 多 `agentIds` 参数（2.7.2 `sessionEventBroadcaster.ts:148-155,210-215`）；`TranscriptService` 所在 `services/transcript/` 已删 | — | 部分：上游 `stdioRpc.ts` 提供“inject + 假 WS”的同类机制，但带全部路由 | **需重写** |
| ZP-20 | `rgLocator.ts` +255/−71；CDN 下载仍在（`downloadRgWithLock` :105、`downloadRgBinary` :186） | 大 | 否 | **需重写** |
| ZP-21 | `callback-server.ts` +9/−1；仍 `node:http` 监听 127.0.0.1（:1-2、:119） | 小 | 否 | 仍需，预计小冲突 |
| ZP-22 | `promptMedia.ts` +147/−44；仍按绝对路径读文件（:3-4、:62-64） | 大 | 否 | **需重写** |
| ZP-9a | `sessionEventJournal.ts` **已删除**；kap-server 不再有事件日志文件 | — | **目标已消失** | **可删**（但须查清新的持久化落在哪里、是否走 `IFileSystemStorageService`——未核实） |
| ZP-23 | `human/llm/requester/timeout.ts` **已删除**；同功能搬到 `packages/core/src/llm/transport/headers-timeout.ts`（仍 `import { Agent, EnvHttpProxyAgent } from 'undici'`、仍读环境变量） | — | 否（只是搬家） | **需重写**到新包 |
| ZP-12 种子 | `IHostTerminalService` 已不存在 | — | 终端服务已删 | 宿主 seeds.ts 删一行 |
| #4066 挑选 | 已在 2.3.0 正式发布 | — | 是 | 可删 |
| 其他补丁触及文件 | `mcpRegistryService.ts` +3/−7、`plan.ts` +10/−12、`program.ts` +137/−112、`routes/workspaces.ts` +174/−47、`agentTool.ts` +263/−123、`index.ts` +57/−45、`start.ts` +159/−77 | — | — | 需逐个重放 |

小计（17 个 ZP 行 + revert）：预计干净 3（ZP-1、ZP-4、ZP-11）；小冲突 4（ZP-4b、ZP-14、ZP-16、ZP-21）；需重写 9（#4059、ZP-2、ZP-3、ZP-17 扩面、ZP-18、ZP-19、ZP-20、ZP-22、ZP-23）；可删 2（ZP-9a、#4066）；对比 2.1.1→2.2.0 那次“14 干净、1 冲突”（`评审-Z2…:141`），这次重写量高一个量级。

### 3(b) 挑选到 2.2.0 的可行性（`git apply --check` 到当前 fork 工作树，只读，不改状态）

| 提交 | 内容 | 结果 |
|---|---|---|
| `397248f` #4907 | 长会话空回复不压缩 | **不能干净应用**：`fullCompactionService.ts:37` 冲突；`agent/loop/requestObservation.ts` 在 2.2.0 不存在 |
| `4ac656c` #4822 | 压缩被提醒打断（4 文件 +15/−3） | **不能**：`fullCompactionService.ts:787` 冲突（`-C1` 也不行；该文件 2.2.0 为 989 行、修复时 1028 行） |
| `68b849c` #4868 | 子 Agent `timeout_ms=0` 立即超时 | **不能**：`agentTool.ts:593`、`spawnTool.ts:322` 冲突 |
| `9c75e5a` #4989、`5ad9aa1` #4836 | 恢复时后台通知触发新回复/重复通知 | **不能**：`agent/loop/core/*`、`promptProjection.ts`、`completionRestore.ts` 在 2.2.0 不存在 |
| `9ae2757` #4848 | 会话锁先于循环恢复 | **不能**：`loopService.ts:380` 冲突，`sessionRunGate.ts` 不存在 |
| `2af56d2` #4687 | Kimi 提供方空 system 消息 400 | **不能**：`human/llm/builtin/provider/kimi/protocol.ts` 在 2.2.0 不存在（仅在动态工具加载时触发，我们 TOOL_SELECT 关） |
| `93137ca` #4430、`2e539f2` #4422、`67325c1` #4280、`4b4cf3a` #4800、`265783c` #4854 | — | **均不能干净应用** |
| `0ea324c` #4866 | 会话历史丢失 | 只改 `apps/kimi-code/src/tui/*` 与 `node-sdk/src/*`，**与嵌入路径无关**（更正 2(b) 表中“高”的评级：对我们为“无关”） |

结论性事实：抽查的 13 个候选修复**没有一个能干净应用到 2.2.0**；2.2.0 是“隔离发布分支”出版（`PATCHES.md:3-4`），与 main 分叉后 agent-core-v2 的 loop/compaction 目录结构已变（例如 `agent/loop/core/` 整目录是新增）。2.2.0 是否真有这些缺陷：**未核实**（未在 2.2.0 上复现）。

---

## 4. 适配升级（到 2.7.2）的工作量估算

### 4.1 要改的位置（按本方源码计数）

| 文件 | 处数 | 改什么 |
|---|---|---|
| `kap-host/src/kap-client.ts` | 白名单 22 条中约 12 条变化 | approvals/questions 4 条 → `interactions` 2 条；`:abort` → `:cancel`；删 `status`、`tasks`×3、`snapshot`、`children`×2、`goal`、`messages`?（未核实是否还在）；`fileChanges/fileContent` 改 `turn_number`；`resolveApproval/answerQuestion/dismissQuestion` 合并为 `respondInteraction(kind, …)` |
| `kap-host/src/runtime.ts` | `sessionAction("abort")` 6 处（451 为 restore 不变）；`resolveApproval` 4 处；`answerQuestion` 1 处；超时诊断 `status/tasks/goal` 3 处（719-721）；`fileChanges` 1 处（900）；`onEngineEvent` 13 个 case（534-625） | 事件源改造的主体 |
| `kap-host/src/progress.ts`（268 行） | 全部事件映射 | 取决于事件源（见 4.2） |
| `kap-host/src/matter-engine.ts` | `createEmbeddedServer` 选项 1 处（211-222）：`eventJournalIo` 失去对象 | 小 |
| `kap-host/src/seeds.ts` | 删 `IHostTerminalService`（188） | 小 |
| `kap-host/src/sealed-storage.ts` | `JournalIo` 导入（17） | 删或改挂新的持久化点（未核实新点在哪） |
| fork `kap-server/src/embed.ts`（ZP-19，240 行） | 重写 | 见 4.2 |
| `test/embed-drift.test.ts` | `CONSUMED`（事件来源文件从 `kap-server/protocol/events-zod.ts` 改到 agent-core-v2 三个事件文件）、`START_BOOTSTRAP_SHA256`、工具 schema 路径 | 重写门禁 |
| `test/static-surface.test.ts` | 进程/网络导入者集合 | 按新制品重定；新增 5 个 child_process、7 个 net/http 候选需逐个封闭或证明不进制品 |
| `test/p1-kap-host.test.ts` | snapshot（417）、children（504-505）用例 | 改写 |
| 补丁 | 第 3 题：需重写 9 项 | — |

### 4.2 embed.ts 在 2.7.2 上怎么重写（事实约束）

- 可保留：`bootstrap(...)` 调用形态（`bootstrap` 仍从 agent-core-v2 导出）、内存令牌、`app.inject()`、`onRoute` 收集已注册路由、种子末尾追加。
- 必改：路由注册改为 `sessions / prompts / interactions / fileHistory /（可选）conversation`；`SessionEventBroadcaster` 构造需要 `ConversationService`（`sessionEventBroadcaster.ts:148-155`），不再收 `eventsDir/journalIo/transcriptService`；`subscribe(sessionId, target, agentIds, accepted?)` 返回 `void`，未找到会话改为抛 `SESSION_NOT_FOUND`。
- 事件源两条路（都基于 2.7.2 源码事实）：
  - A. 继续用广播器 → 拿到的是 v2 帧（`interaction`、`task.list/task`、`agent/usage/goal/todo`、`turns/turn.*/item.*/notice`），宿主 `runtime.ts`/`progress.ts` 全部按新帧重写；字段对应关系**未核实**（未读 2.7.2 `protocol/conversation.ts`、`asyncapi.ts` 全文）。
  - B. 绕过广播器，直接 `core.accessor.get(IEventService).subscribe(...)`（广播器自己就是这么收的，`sessionEventBroadcaster.ts:187-189`），按会话过滤 → 事件类型名与 2.2.0 相同，三份事件定义文件 2.2.0→2.7.2 只改 +53/−33 行；`runtime.ts`/`progress.ts` 的 switch 基本可留，但 (1) 核心事件对象怎样携带 sessionId、payload 是否等同于 2.2.0 信封里的 `payload`——**未核实**；(2) 问题（question）在 2.7.2 不再有 `event.question.*` 核心事件，要改读 `interactions` 服务；(3) `IEventService` 在 agent-core-v2 `index.ts` 有导出（grep 计数 1）。

### 4.3 人日粗估

| 块 | 估计 | 依据 |
|---|---|---|
| 补丁重放：干净 3 + 小冲突 4 + 重写 9 + 新入口扩面 | 5～8 人日 | 2.1.1→2.2.0（14 干净 1 冲突、无接口断裂）评审估 5～7 人日（`评审-Z2…:250`），其中补丁重放本身约 1 人日；这次重写项 9 个、且 ZP-23/ZP-19 跨到新包与新广播器 |
| embed.ts 重写 + kap-client + runtime/progress 事件源 | 4～7 人日 | 宿主约 25 处调用点 + 13 个事件 case + progress 268 行；取 4.2-B 路线偏下限，A 路线偏上限 |
| 门禁重建（embed-drift、static-surface、p1 等）+ 制品构建 | 2～3 人日 | 2.2.0 那次门禁常量更新估 0.5 人日；这次是重写断言来源 |
| 安全复核（宿主策略链、出网唯一出口、无监听、落盘加密的新持久化点） | 3～5 人日 | ZP 为 P0 安全补丁，须逐条反向对照（`feedback-disposition-tests-verified` 的口径） |
| 内核 kap 用例 + 真实模型回归（57 单流水线抽样） | 3～5 人日 | 2.2.0 那次内核用例估 1～2 人日（含排障）；这次事件与交互全换 |
| **合计** | **约 17～28 人日** | 1 人约 4～6 周 |

最大不确定点：①2.7.2 核心事件对象与 2.2.0 信封的字段等价性（决定 4.2-B 是否成立，可在 1 天内用一次真实会话录事件核实）；②新持久化（会话对话流、interaction 存储）是否全经可注入的存储服务——不是则需新增加密补丁；③新增 child_process/net 入口是否进制品；④上游每周一个小版本（第 6 题），适配完成时上游大概率又前进 3～4 个版本。

---

## 5. 替代架构的事实依据

| 方案 | 有利事实 | 不利事实 |
|---|---|---|
| (i) 锁 2.2.0 + 挑选 | 当前补丁、门禁、制品可复现（`PATCHES.md:12-18`）；上游无公开安全公告（`security-advisories` 为 `[]`）；被删接口不影响锁版 | 抽查 13 个候选修复 **0 个可干净应用**（3(b)），每个都是手工移植；长会话压缩（#4907、#4822）、后台通知重复触发（#4836、#4989）、会话锁（#4848）这些修复所在目录在 2.2.0 结构不同；2.2.0 是否有这些缺陷未核实；上游 open 缺陷 #4193、#2337、#4070（`PATCHES.md:123`）状态未复查 |
| (ii) 适配到 2.7.x 新接口 | 核心 agent-core-v2 事件仍在；2.7.0 起上游发布 KAP 1.0.0 规范文档（`kap-server/docs/kap.md:3`，含 `interactions`、`:wait`、`/steer`、`/agents/{id}/turns`）；上游自己用“inject + 假 WS”跑 SSH 主机（`stdioRpc.ts`） | 17～28 人日（第 4 题）；KAP 1.0.0 面向本机 HTTP（`kap.md:15-20` 以 `http://127.0.0.1:<port>` + Bearer 令牌连接），**不是进程内嵌入**；kap.md 里没有兼容/弃用承诺（grep “stabil/compat/breaking/deprecat” 无命中）；上游包全部 `"private": true`（kap-server 0.3.2、agent-core-v2 0.6.0、kimi-code-sdk 0.23.2），不发 npm |
| (iii) 在 fork 里保留被删路由 | 2.2.0 被删路由代码量：tasks 345 + snapshot 188 + approvals 207 + questions 305 + transcript 609 + messages 138 = **1,792 行**；但我们的事件流依赖的是 v1 广播器（2.2.0 1,564 行）+ `services/transcript/`（coreEventMap 1,775 + transcriptService 965 + 其他 ≈ 3,250 行），2.7.2 广播器已重写为 1,079 行；`IAgentTaskService` 等内部服务还在，`services/legacyStatus/` 目录在 2.7.2 仍存在 | 要带走的是约 **5,000+ 行**已被上游删除、且与新广播器/会话对话流并存的旧代码；`sessionEventJournal`、`TranscriptService`、`inFlightTurnTracker`、`subagentRosterTracker` 全删，旧代码依赖的 `IAgentLoopService`、`ISessionIndex` 等是否保持原签名**未核实**；每次升级都要再 rebase 这 5,000 行 |
| (iv) 降耦：宿主只依赖 agent-core-v2 进程内 API | `IEventService`（agent-core-v2 导出）是广播器的上游源；宿主依赖的 21 种事件在 2.7.2 全部仍由 agent-core-v2 发出，定义文件改动 +53/−33；种子 DI 标识除 `IHostTerminalService` 外全部仍在；`bootstrap` 仍导出；审批由 `toolApprovalService.ts` 发核心事件 | agent-core-v2 同样 `private: true`、0.5.0→0.6.0、`index.ts` 2.2.0 517 个 `export *` → 2.7.2 524 个，导出面巨大且无稳定承诺；2.7 新增 `@moonshot-ai/core`（125 个 agent-core-v2 文件依赖），LLM 层在迁移中，ZP-23 已被迫搬家；会话创建/提示/中止/审批答复这些动作在 agent-core-v2 层的调用方式未核实（目前都经 kap-server 路由） |

---

## 6. 上游发布节奏与兼容承诺

- 节奏（`published_at`）：2.2.0（10-14）之后 37 天内发 17 个正式版：小版本 2.3.0 10-21、2.4.0 10-28、2.5.0 11-04、2.6.0 11-12、2.7.0 11-19——**每周一个小版本**，其间 0～3 个补丁版；另有 canary（2.6.0 前 6 个、2.7.0 前 4 个）。更早 0.31～0.43、2.0.0（9-17）同样约每周。
- 版本号语义：破坏性改动写在 changeset 的 “Patch Changes” 里（例：#4428 删审批/问题路由、#4470 删 subscribe/snapshot、#4535 删任务 REST、#4606 删 `/status`，均在 Patch 节）——**上游不按 semver 标示 kap-server API 破坏**。
- 稳定性/弃用政策：仓库内未找到。`kap.md` 只声明 “KAP `1.0.0`; Kimi Code CLI >= `v2.7.0`”，并让调用方以 `GET /openapi.json`、`/asyncapi.json` 为准；`KIMI_AGENT_PROTOCOL_VERSION = '1.0.0'`（2.7.2 `routes/meta.ts:29`），2.2.0 的 `meta.ts` 无此常量（grep 无命中）。删除前无弃用期（#4428 等直接 “are removed”）。
- 嵌入场景是否被支持：上游支持的集成面是 ①本机 HTTP/WS（KAP，`kap.md`）、②ACP（`acp-server` 包、`docs/en/reference/kimi-acp.md`）、③SSH 主机 RPC（`stdioRpc.ts`）。**进程内嵌入 kap-server 不是上游提供的用法**（kap-server `exports` 只有 `. / ./contract / ./search-worker-runtime / ./protocol/*`，2.2.0 与 2.7.2 相同；`./embed` 是 ZP-19 我方加的）。

## 7. License / 分发条款

- 根 `LICENSE`：MIT（“Copyright (c) 2026 Moonshot AI”），`git diff 2.2.0 2.7.2 -- LICENSE` 无变化。
- 包级：agent-core-v2、kimi-code-sdk、新包 `@moonshot-ai/core` 的 package.json 均 `"license": "MIT"`；kap-server package.json 无 license 字段（两版相同）；全部 `"private": true`（两版相同）。
- 未检查：第三方依赖新增项的许可证（例如 Bedrock、SSH 相关依赖）——**未核实**。

---

## 没核实到的

1. 2.2.0 是否真有 #4907/#4822/#4836/#4989/#4848 所修缺陷（未在 2.2.0 上复现）。
2. 整份 ZP 补丁对 2.7.2 的实际 `git apply` 冲突数（只按文件改动行数和行为抽查判断）。
3. 2.7.2 核心事件对象（`IEventService`）的 sessionId 携带方式、payload 与 2.2.0 信封 `payload` 的等价性。
4. 2.7.2 会话对话流、interaction 存储的持久化是否全部经 `IFileSystemStorageService` 等可注入服务（决定落盘加密是否需要新补丁）。
5. 2.7.2 新增 child_process/net/http 导入者是否会被打进嵌入制品。
6. `/children`、`/goal` 已定位到 2.7.0（#4965 或 #4963 之一）；`GET /messages` 的删除版本未定位；#4963 “snake_case contracts” 对 sessions/prompts 信封字段的影响未逐字段核对。
7. 2.6.0 #4839 后 `POST /profile` 设 `plan_mode` 与 2.4.0 #4247 “计划只能由用户打开”在宿主调用路径上的实际行为。
8. 上游 open 缺陷 #4193、#2337、#4070 的现状。
9. 第三方依赖许可证变化。
10. 非公开（私有上报）的安全公告——`security-advisories` 接口未认证只返回公开项。
