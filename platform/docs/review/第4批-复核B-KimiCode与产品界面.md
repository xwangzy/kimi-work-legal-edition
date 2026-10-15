# 第 4 批 · 复核 B：Kimi Code 集成与产品界面（方案符合性与正确性）

- 复核日期：2026-10-14；对象：工作区未提交改动（`git -C platform diff`），范围限于 Kimi Code 集成（K7-P、K7-4、N-1、K9-2）与产品界面（Y4 P0-A～F、#8～#11）。
- 方法：只读审查代码、文档与锁版上游（`third_party/kimi-code`）；运行已有用例 `kap-host/test/{progress,embed-drift}.test.ts`、`kernel/test/run-progress.test.ts`、`apps/desktop/test/run-progress-view.test.ts`（6/6 通过，embed-drift 本机未跳过）、`kap-host/test/s2-regressions.test.ts`（7/7 通过）。kap-a1 未运行（慢），只读其新增两例。
- 未修改任何项目文件；以下缺口只给修复与补测建议。

## 结论先行

| 级别 | 数量 | 编号 |
|---|---|---|
| 阻断 | 0 | — |
| 重要 | 4 | B4-B05 超预算获批后不计数；B4-B07 取消未确认的记录到不了账本且文案相反；B4-B09 漂移报警覆盖面不足（含 skip 语义）；B4-B20 静默看门狗在有过程快照时失效 |
| 一般 | 12 | B4-B01、B02、B03、B06、B08、B11、B12、B14、B17、B19、B21、B22 |
| 建议 | 7 | B4-B04、B10、B13、B15、B16、B18、B23 |

逐题结论速览：

| 题 | 结论 | 要点 |
|---|---|---|
| 1 过程快照 | 部分成立 | 字段取用与锁版协议一致，节流与终态后不发正确，内核重建完整，不落账本成立，界面无 HTML 注入；但压缩事件不分主/子 Agent、`trigger` 取错字段、里程碑载荷内核未白名单、后台任务描述未还原代号 |
| 2 集群预算 | 部分成立 | `items + resume_agent_ids` 与上游语义一致、分叉拒绝正确；超预算询问获批后不计数（重要），无法解析时“询问”而非“拒绝”，询问卡不含成员数 |
| 3 取消竞态 | 部分成立 | `forceCancel` 只经内核 IPC 可达的论证成立；失败记录在轮询结束后才写入、永远进不了账本，界面文案与事实相反；无端到端用例 |
| 4 漂移报警 | 部分成立 | start.ts 种子段摘要能在段内变化时失败；但三个文件任一移动即静默跳过、宿主依赖的事件与工具入参只锁了一部分 |
| 5 同事项第二任务 | 部分成立 | 幂等重放不被误拒、估价与发起之间无竞态；状态集合漏 `recovering`，`runs.retry` 无预检，取消后宿主释放前仍可能“受理后失败” |
| 6 主进程转发 | 部分成立 | 当前内核广播只有 `run.updated`/`run.settled`/`kernel.event`，转出内容无敏感项；但“有 type 即转发”无白名单，信封被覆盖的根因未修；通知文字非敏感，`focus.run` 处理正确 |
| 7 确认卡与提问卡 | 基本成立 | 现有变体组合下检索卡首屏不出现改写前名称；无变体检索卡仍渲染 `card.title`（低风险）；charDiff 正确、边界合理；提问卡“其他”会静默覆盖已选项 |
| 8 侧栏/标题/横幅 | 部分成立 | 查询走索引、正确；横幅“有任务”计数只在版本变化时取一次，主进程安装不复核 |
| 9 能力账本 | 部分成立 | 证据测试已登记且存在；TodoList 标 native 与本行“映射任务步骤 / 与任务状态一致”的定义不符 |
| 10 其他 | — | `agent.error` 的 `retryable` 被内核裁掉；Y4 P0-A（实际发出内容）、P0-F（只展开一张）、K7-4 卡片文案、N-1 用例未落实 |

---

## 一、过程快照（K7-P）

### B4-B01 宿主对上游事件的取用：压缩不分主/子 Agent，`trigger` 取错字段（一般）

- 结论：部分成立。
- 证据：
  - 一致的部分：`subagent.spawned` 的 `subagentId/subagentName/description/swarmIndex/runInBackground`、`subagent.completed.resultSummary/usage`（`tokenUsageSchema` 四字段）、`subagent.failed.error`、`task.*`/`background.task.*` 的 `info.taskId/kind/description/status`（`taskLifecycleStatusSchema` 的 `completed/killed` 映射正确，`question` 类排除）、`turn.step.retrying.nextAttempt/maxAttempts/statusCode`、`TodoList.todos[].title/status`（`todo-list.ts:7-10`）、`NotifyUser.message`（`notify-user.ts:12-19`）、`Skill.skill`，与 `events-zod.ts:417-463、785-797、842-851、896-1000` 一致。主 Agent 编号 `"main"` 与上游 `agentPluginService.ts:47` 一致。
  - 压缩：`progress.ts:113-132` 对 `compaction.*` 不看 `agentId`，而上游四个压缩事件都带 `agentId`（`events-zod.ts:939-961`），子 Agent 自己的压缩会被算进主任务的“第 N 次”，`compaction.blocked` 还会让律师看到“对话过长……请把任务拆小”（`lib/progress.ts:52`），以及时间线 lawyer 级红条（`RunView.tsx` `agent.compaction` 分支）。
  - `trigger`：`progress.ts:126` 读 `payload.trigger`，但上游 `compaction.completed` 没有该字段（`events-zod.ts:957-961`；`trigger` 只在 `compaction.started`，`:939-944`），里程碑里恒为 `null`；若上游将来加入，任意类型与长度的值会原样进账本（见 B4-B02）。
  - 上限：`progress.ts:87` 子任务满 32 个后 `subagent.spawned` 直接 `changed:false`，里程碑也一起丢掉；随后这些成员的完成/失败因 `find` 不到而同样不记（`:103-104`）。集群上限 128（`agent-swarm.ts:7`），超预算获批后可超过 32（见 B4-B05）。
  - 时机：`TodoList`/`NotifyUser`/`Skill` 在 `tool.call.started` 即生效（`:61-84`），工具若因参数校验或审批被拒，快照已更新；对 TodoList 影响小，对 Skill（进时间线“已按方法模板执行”）会多记一次未真正加载的模板。
- 影响：子 Agent 压缩时误报“对话过长”；长集群的时间线不完整。
- 建议修复：压缩事件只认 `agentId === "main"`（或分开计数）；`trigger` 在 `compaction.started` 记下、`completed` 时带出并限定为 `manual|auto`；超过 32 个子任务时快照不再加项但里程碑照发（或改为计数）；Skill 里程碑改在 `tool.result` 且 `isError !== true` 时发。
- 建议补测：`progress.test.ts` 增“子 Agent 的压缩不计入主任务”“第 33 个子任务仍有 spawned 里程碑”“Skill 调用失败不记里程碑”。

### B4-B02 里程碑事件进账本前内核未按白名单重建（一般）

- 结论：成立（缺口）。“只在内存不落账本”对过程快照成立：快照只存 `TaskState.progress`（`kap-agent-client.ts:163-167`），`runs.interactions` 取（`w1.ts:69`），无其他读取方；kap-a1 新例断言时间线里程碑不含模型文字。但里程碑本身的载荷没有内核侧校验。
- 证据：`executor.ts:816-831` 把 `agent.subagent/compaction/skill` 加进 `AGENT_TIMELINE_EVENTS`，`executor.ts:978-981` 经 `slimAgentPayload` 写账本；`slimAgentPayload`（`executor.ts:837-851`）对这三类走 `default: return p`，宿主给什么就落什么。内核对过程快照“不信任宿主给的结构”（`run-progress.ts:1-4`），对进账本的里程碑反而信任，口径不一致。
- 影响：宿主（承载上游引擎）若被上游变化或缺陷带偏，任意字段与长度会进签名账本；与 D-49“账本只存令牌形态、只含编号与计数”的承诺依赖宿主自律。
- 建议修复：`slimAgentPayload` 增三个分支：`agent.subagent` → `{subagent_id: ≤80, event: 枚举, swarm_index: 有限数|null, background: bool, tokens: 有限数|null}`；`agent.compaction` → `{event: 枚举, trigger: manual|auto|null, tokens_before/after/dropped/count: 有限数|null}`；`agent.skill` → `{skill: /^[\p{L}\p{N}_.-]{1,80}$/u}`。
- 建议补测：`run-progress.test.ts` 增“里程碑载荷白名单：未知字段丢弃、超长截断、非法枚举改缺省”（导出 `slimAgentPayload` 或抽到 `run-progress.ts`）。

### B4-B03 后台任务描述未经令牌还原（一般）

- 结论：成立。界面渲染整体安全：新增代码无 `dangerouslySetInnerHTML`（全仓只有 `lib/safe-preview.ts` 自有用途），`renderTokens` 产出 React 文本节点（`Markdown.tsx:133-144`）；清单、子任务描述与摘要、进展通知都经 `renderTokens`。
- 证据：`RunView.tsx:926` `{vm.tasks.title}：{vm.tasks.items.join("；")}` 直接输出字符串；`progressTexts` 已把 `tasks[].description` 纳入还原表，但渲染没用。
- 影响：后台任务描述（模型生成、令牌形态）在界面显示为未还原的代号。无注入风险。
- 建议修复：逐项 `renderTokens(item, tokenMap)` 后再拼接。
- 建议补测：`run-progress-view.test.ts` 若只测纯函数，可把“需要还原的字段清单”抽成纯函数并断言与 `ProgressPanel` 渲染字段一致。

### B4-B04 内核内存中的流式文字与过程快照在终态后不清（建议）

- 结论：成立。
- 证据：`kap-agent-client.ts:160、166` 只在运行中写入，`liveProgress/liveText` 在终态返回 null（`:529-538`），但 `task.progress`、`task.liveText` 从不置空，`tasks`/`taskByRun` 也不删除。
- 影响：子任务结论摘要（可能含材料要点，令牌形态）在内核进程生命周期内常驻内存；与“运行结束即不再返回”一致，但与“只在内存、运行期间”的精神有出入。
- 建议修复：收到终态事件（`onRunEvent` 终态分支）时 `task.progress = null; task.liveText = undefined`。
- 建议补测：kap-a1“过程事件与流式回复”末尾断言内部状态已清（或经 `liveProgress` 以外的调试接口）。

（第 1 题其余子项核对通过：宿主节流为首次变化后 300 ms 合并发送、发送时取最新快照，`runtime.ts:499-509`；终态后事件整体不进入（`runtime.ts:494-497`），定时器触发时再判终态；子 Agent 的 TodoList 与重试不进主快照；内核 `sanitizeProgress` 对数组、枚举、长度、时间格式、技能名均重建，对 null/原始类型元素安全，`run-progress.test.ts` 覆盖。）

---

## 二、AgentSwarm 预算按成员计与分叉拒绝（K7-4）

### B4-B05 超预算询问获批后不计数，后续调用在“名义余额”内自动放行（重要）

- 结论：成立。
- 证据：`policy.ts:365-371` `consumeBudget` 超额时直接返回 false、不增加计数；`overBudget`（`:373-382`）在默认/手动档返回 `ask("over_budget")`；批准后没有任何地方补记 `toolCalls`/`subagents`（全文件只有 `:368-369` 两处累加）。例：`maxSubagents=3`，已用 2；一次 5 成员的集群询问获批 → `state.subagents` 仍为 2；随后一个 `Agent` 按 2+1≤3 自动放行。实际派出 8 个，律师只被问过一次，而且第二次越额时没有再问。
- 影响：能力账本“并发与总预算不超；超额暂停并说明”（`capabilities.ts` 集群行）与第 02 篇 §9.5⑥“超预算逐次确认”在获批之后失效；点数估价失真（Y3 K7-4 的初衷）。`toolCalls` 有同样问题（获批的那一次不计）。
- 建议修复：询问获批时按本次请求的成员数与 1 次工具调用补记（需要在审批决定回到宿主时能取回该次调用的 `members`，可在 ask 结果里带上并在批准路径累加）；`members` 为无穷大时不得累加（见 B4-B06，应直接拒绝）。
- 建议补测：`s2-regressions.test.ts` 增“超预算获批后计数：批准一次 5 成员集群后，下一次单个 Agent 仍须询问”；`p1-kap-host` 端到端版本：批准超预算卡后再派子任务仍出卡。

### B4-B06 无法解析时“询问”而非“拒绝”；询问卡不含成员数；`model` 未由宿主独立拒绝（一般）

- 结论：部分成立。
- 证据：
  - 成员语义与上游一致：`items` 每项一个新成员（`agent-swarm.ts:32-37`，≤128）、`resume_agent_ids` 每键续跑一个（`:45-49`），`fork` 为布尔（`:39-44`）；`swarmMembers`（`policy.ts:425-431`）一致；`fork === true` 的拒绝在计数之前（`policy.ts:315-319`），不消耗预算，Agent 与 AgentSwarm 都覆盖（`agent.ts:50-55` 也有 `fork`）。上游 schema 为 `.strict()` 且 `fork` 为 `z.boolean()`，`"true"` 等非布尔值会被引擎拒绝，不构成绕过。
  - 无法解析：`swarmMembers` 返回无穷大 → `ask:over_budget`（用例 `s2-regressions` k5 断言 ask），Y3 §3.1 方案写的是“`items` 缺失 → 拒绝”。律师批准一张“超预算”卡后引擎仍会因参数无效拒绝，这张卡没有意义且误导。
  - 询问卡：Y3 §3.1 要求标题“这一步要同时派出 {n} 个子任务”、正文写剩余额度；实际 `overBudget` 未改，卡片由 `interaction-cards.ts` 通用 `budget` 分支生成，不含成员数与余额。
  - `model`：上游 `[secondary_model].force` 时对 `model` 覆盖报错（`configSection.ts:249-264`），所以当前不会绕过低价模型；但这是引擎单点强制，与 fork 的“每处独立强制”口径不一致。`run_in_background`：只影响生命周期，预算口径无关；宿主对后台子 Agent 在终态后由 `turn.started` 中止兜底（`runtime.ts:494-497`），无需补强。`resume`（Agent）计 1，合理。
- 影响：失败关闭方向正确，但交互与方案不符。
- 建议修复：成员数无法解析 → `deny("swarm_members_unparseable")`；`overBudget` 带 `members` 与 `left`，卡片按 Y3 文案；`Agent`/`AgentSwarm` 的 `model` 只允许缺省（或等于低价模型别名），其余宿主拒绝。
- 建议补测：k5 改断言 deny；新增“`model:"primary"` 宿主拒绝”；卡片文案用例（kernel interaction-cards）断言含“{n} 个子任务”。

---

## 三、取消竞态（N-1）

### B4-B07 `cancel_unconfirmed` 记录写在轮询结束之后，永远进不了账本；界面文案与事实相反；无端到端用例（重要）

- 结论：成立。
- 证据：
  - 调用时机：律师取消时内核先把运行置为 `cancelled`，轮询循环在下一轮发现后抛 `RunCancelled`（`executor.ts:956-957`），在 `finally` 里才调用 `agentClient.cancel`（`executor.ts:994`）。`cancel` 内的失败记录 `t.events.push({type:"agent.error", code:"cancel_unconfirmed"})`（`kap-agent-client.ts:498-500`）发生在轮询已退出之后，再没有人 `poll` 这批事件，镜像到账本的路径（`executor.ts:976-985`）已结束。全仓检索 `cancel_unconfirmed` 只有这一处写入与 `RunView.tsx:200` 一处读取。
  - 文案：该记录只在 `forceCancel` 也失败时产生，而 `RunView.tsx:200` 写“停止请求未得到确认，已强制停止”，恰好相反。
  - 与方案出入：Y3 §3.2 要求“仍失败 → 记 `cancel_unconfirmed` 并调用 `forceCancel`”，进度文档写“仍失败由宿主 forceCancel 并记 `cancel_unconfirmed`”；实现只在强制取消失败时记。
  - 用例：Y3 §3.2 规定的 `w1.test.ts`“取消与确认卡同时到达”未加；全仓测试无 `forceCancel` 引用。
- 影响：宿主未停住时（取消与强制取消都失败），账本只有“已取消”，律师与审计都看不到“本机任务可能仍在运行”；N-1 的“不再吞掉失败”实际上仍被吞掉。
- 建议修复：`cancel()` 返回 `{confirmed: boolean, forced: boolean, error?: string}`，由 `executor.ts` 的 `finally` 直接 `appendEvent(... "agent.cancel_unconfirmed" ...)`（或在取消前先停止轮询、取消后再拉一次事件）；文案改为“停止请求没有得到本机助手的确认，它可能仍在运行；请重启应用”；版本冲突后经强制取消成功也记一条 detail 级事件。宿主仍无响应时考虑结束 kap-host 进程（它是内核子进程）作为最终兜底。
- 建议补测：按 Y3 §3.2 补“取消与确认卡同时到达”；再加一例以桩宿主让 `cancel` 持续冲突、`forceCancel` 抛错，断言账本出现取消未确认事件且 `runs.events` 可见。

### B4-B08 重试与强制取消的触发面、时长与方法表（一般）

- 结论：`forceCancel` 只经内核 IPC 可达——成立；“仍失败才强制”——部分成立。
- 证据：
  - 可达性：宿主方法表只由 `process.on("message")` 的 `t:"call"` 分派（`kap-host/src/main.ts:237、298-306`）；kap-host 源码无 `createServer/listen`，嵌入的 kap-server 无端口（ZP-19）；内核侧只有 `kap-agent-client.ts:498` 一处调用，内核 API 没有透传任意宿主方法名的入口。宿主方法表中能结束运行的入口：`cancel`（校验属主、渠道、版本，`runtime.ts:812-823`）、`forceCancel`（不校验，`runtime.ts:830-837`）、撤权擦除（关引擎）与 `shutdown` 消息。
  - 触发面：循环对“非 conflict”错误立即 `break` 并强制取消（`kap-agent-client.ts:493-495`），包括 `forbidden`（`requireOwner`/`CAN_CANCEL`）、`not_found`、调用超时；不只是“版本重试仍失败”。运行已终态时宿主 `cancel` 也抛 `conflict`（`runtime.ts:817`），会白白重试 3 次再走强制取消（无害）。
  - 时长：`call` 缺省 60 秒超时（`kap-agent-client.ts:281-292`）；宿主卡死时 `events`、`cancel`、`forceCancel` 依次各等 60 秒，`finally` 最长阻塞约 3 分钟。
  - 方法表用普通对象按键取（`main.ts:300`），`constructor`/`toString` 等原型键会被当成方法调用（目前只有内核会发，风险低）。
  - 与内核 `runs.cancel` 的关系：律师所见版本在内核 API 层按 `runs.status_version` 校验；宿主的 `state_version` 是另一套计数，只防“宿主侧新卡片到达”。两层分离、强制取消不再比对宿主版本，论证成立。
- 建议修复：只对 `conflict` 重试、只在重试耗尽或超时时强制；`forbidden` 视为内核与宿主身份不一致，记录后再决定；取消相关调用用短超时（如 5 秒）；方法表用 `Object.hasOwn(methods, msg.method)`。
- 建议补测：`p1-kap-host` 增“`forceCancel` 只在 IPC 方法表”静态断言（类似 desktop-surface），以及“终态运行 `forceCancel` 原样返回”。

---

## 四、漂移报警（K9-2）

### B4-B09 覆盖面不足：任一文件移动即静默跳过；宿主依赖的事件与工具入参只锁了一部分（重要）

- 结论：部分成立。`start.ts` 的 `bootstrap(` 段（`start.ts:198` 起，种子 `logSeed`/`opts.seeds` 在段内 `:211`）规范化空白后取摘要，段内任何非空白改动都会失败——这一点成立；本机已跑通。
- 证据：
  - skip 语义：`embed-drift.test.ts:17` 要求三个文件同时存在，否则 `:74` 跳过。上游 rebase 若移动或改名 `protocol/events-zod.ts`、`start.ts` 或 `embed.ts`，升级机器上测试只显示“跳过”，正是本报警要防的场景。`third_party/kimi-code/` 被 `.gitignore` 排除（`platform/.gitignore:8`），CI 上恒跳过。
  - 事件字段：`CONSUMED`（`:62-72`）缺 `subagent.cancelled`、`subagent.suspended`、`compaction.started`、`compaction.cancelled`、`task.started`、`task.terminated`、`turn.step.completed`（`progress.ts` 与 `runtime.ts` 都在用）；事件类型改名（例如 `subagent.canceled`）时宿主静默失去状态更新而测试不报。只锁顶层字段名，不锁 `info` 的 `taskId/kind/status/description`、`taskLifecycleStatusSchema` 的枚举值、`compactionResultSchema.tokensBefore/tokensAfter/droppedCount`、`tokenUsageSchema` 四字段。
  - 工具入参：K7-4 的计数依赖 `AgentSwarm.items/resume_agent_ids/fork`、`Agent.fork/model`，过程快照依赖 `TodoList.todos[].title/status`、`NotifyUser.message`、`Skill.skill`——都在 `agent-core-v2` 的工具 schema 里，未锁。Y3 §3.1 自己写明“上游若给 AgentSwarm 增加按模板展开的字段（如 `count`），成员数会被低估”，靠漂移报警兜底，但报警没覆盖到。
- 影响：引擎升级时预算计数与过程信息可能静默失效（低估成员数属于不安全方向）。
- 建议修复：只在 `third_party/kimi-code` 目录本身不存在时跳过，目录在而文件缺失即失败；`CONSUMED` 补齐上述事件；新增工具入参锁：解析 `agent-swarm.ts`、`agent.ts`、`todo-list.ts`、`notify-user.ts`、`skillTool.ts` 的 `z.object({...})` 顶层键集合并与登记表比对（新增键即失败，提示复核预算/快照映射）；对 `taskLifecycleStatusSchema` 取枚举并锁定。
- 建议补测：即上述扩充；另加一例对一段内嵌样例文本运行 `callSection/eventFields`，证明截取函数本身正确（不依赖 fork 存在，CI 可跑）。

### B4-B10 截取逻辑的健壮性（建议）

- 结论：部分成立。
- 证据：`callSection`（`:25-42`）跳过字符串字面量但不跳过注释，段内注释里的撇号（如 `don't`）会被当作字符串起点、不配对的括号会提前结束截取；`argsKeys`（`:45-49`）用非贪婪匹配到第一个 `\n\s*},`，遇到嵌套对象会提前截断、嵌套键会被当作顶层键，且识别不了简写属性（`{ config, port: 0 }` 里的 `config`）；`eventFields`（`:52-59`）取 `type` 之后第一个 `})`，事件对象内嵌 `z.object` 时会提前截断（这种情况测试会失败，属安全方向）。当前上游代码下摘要能覆盖完整段落，问题是将来格式变化时的误判。
- 建议修复：截取时跳过 `//` 与 `/* */` 注释；`argsKeys` 改为按括号深度只取深度 1 的键并识别简写；或直接用 TypeScript 编译器 API（仓库已有 `typescript` 依赖时）解析。
- 建议补测：同 B4-B09 的样例文本用例，覆盖注释撇号、嵌套对象、简写属性。

---

## 五、同一事项第二个任务的预检

### B4-B11 `liveAgentRunOf` 漏 `recovering`；取消后宿主尚未释放的窗口仍会“受理后失败”（一般）

- 结论：部分成立。
- 证据：
  - 状态集合 `('queued','running','waiting_input','waiting_approval','budget_paused')`（`api/index.ts:276`）。内核“仍在执行”的集合 `LIVE_RUN_STATUSES` 还含 `waiting_device`（`identity.ts:55`）；崩溃恢复的运行进入 `recovering` 并重新入队执行（`queue.ts:80-101`），会再次拉起宿主——重启后、队列取到它之前发起的新任务能通过预检，随后两者之一在宿主 `startRun` 冲突失败。`reconciling` 不计入有道理（宿主已不在运行）；重启时等待中的 a1 任务另有处理（`executor.ts:1151`）。`waiting_device` 是否会出现在 a1 任务上需负责人确认。
  - 宿主“进行中”判定是 `activeByMatter`（`main.ts`，终态事件、`cancel`、`forceCancel` 时释放）与 `hasLiveRun || starting`（`runtime.ts`）。内核在律师取消时立即置 `cancelled`，宿主要等轮询（800 ms）+ 取消调用后才释放；这段时间内发起的新任务通过内核预检，入队后在宿主冲突失败——Y4 P0-C 描述的“先受理后失败”在“取消后马上重开”这一常见操作上仍会出现。
  - 幂等重放：重放判断在 `api/index.ts:1095-1099`，忙碌检查在 `:1165-1168`，之后——不会误拒。估价与发起：`runs.start` 在 `:1167` 重查并在其后同步插入（中间无 `await`），无竞态。
- 建议修复：集合加入 `recovering`（`waiting_device` 视确认结果）；执行器在宿主返回“同一事项已有运行中的任务”时短暂等待重试（例如 10 秒内每秒一次）而不是直接失败，或 `runs.cancel` 返回前等待宿主释放（有上限）。
- 建议补测：kap-a1 增“取消后立即在同一事项发起新任务：新任务成功开始”；kernel 单测“`recovering` 的 a1 任务使估价 `block_kind=busy`”。

### B4-B12 `runs.retry` 没有忙碌预检（一般）

- 结论：成立。
- 证据：`runs.retry`（`api/index.ts:1393-1411`）只校验未决副作用与状态版本即改回 `queued` 入队；同一事项另有进行中的 Agent 任务时，重试仍是“先受理、后在宿主失败”。Y4 §7 #4 明确把 `RunView` 的 `retry-card` 列为入口。
- 建议修复：a1 任务重试前调用 `liveAgentRunOf`，忙则 409 并带 `run_id`；界面重试卡显示同样的说明与“查看进行中的任务”。
- 建议补测：kap-a1“同一事项的第二个任务”末尾补一步：先让一个任务失败，另一个在等待时重试前者 → 409。

### B4-B13 各入口对 `block_kind` 的处理细节（建议）

- 结论：基本成立。
- 证据：
  - `RunSheet`：`block_kind` 缺省按 `consent` 处理（向后兼容，`RunSheet.tsx:69`），`busy` 显示原因与“查看进行中的任务”并禁用确认，`exit_mode` 只说明——正确。`ScenarioStart` 遇 `start_blocked` 或 `warning` 转 `RunSheet`（`ScenarioStart.tsx:89`），正确；`Home`/`Matter` 都经 `RunSheet`。`RunView` 追问：显示 `warning` 并禁用“确认追问”（`RunView.tsx:489-490、752、761`），没有跳转入口。
  - `RunSheet` 记录同意后重新估价，若此时变成 `busy`，仍提示“已记录，但仍有待确认项，请展开‘逐项调整’检查”（`RunSheet.tsx:83-85`），与原因不符。
  - 估价不忙、发起时 409（并发发起）只显示错误文字，`DomainError` 的 `{run_id}` 未用于给出入口。
- 建议修复：重新估价后按 `block_kind` 分别提示；409 带 `run_id` 时复用“查看进行中的任务”；追问确认行在 `busy` 时同样给入口。
- 建议补测：如有组件测试设施，加 `RunSheet` 三种 `block_kind` 的渲染快照；否则把“按 block_kind 选提示与入口”抽为纯函数单测。

---

## 六、主进程事件转发与系统通知

### B4-B14 “有 type 即转发”没有白名单，信封被覆盖的根因未修，无静态测试（一般）

- 结论：部分成立。当前不会转出不该给渲染进程的消息；但正确性依赖“内核今后发出的带 type 消息都可以给界面”这一隐含约定。
- 证据：
  - 内核经 `parentPort.postMessage` 发往主进程的全部消息（`kernel/src/electron-entry.ts`）：RPC 应答 `{id, ok, result|error}`（`:101-110`，无 `type`，主进程按数字 `id` 处理，非数字 `id` 的应答也因无 `type` 不会被转发）；`kernel.ready`（含 `localPort` 与工作区路径，`:112`，主进程拦下不转）；`kernel.fatal`（`:122`，拦下不转）；`{type:"kernel.event", event:"kernel.db_key_missing", message}`（`:77-81`，转发，内容无敏感项）；广播 `{type:"kernel.event", ...msg}`（`:94`），而内核的广播只有 `run.settled {run_id}`（`kernel/src/index.ts:533`）与 `run.updated {run_id, waiting}`（`:342`）。故目前转给渲染进程的只有编号与状态。
  - 根因：`electron-entry.ts:94` 先写 `type:"kernel.event"` 再展开 `msg`，广播自带的 `type` 覆盖信封——主进程改为“非 RPC 应答且有字符串 type 即转发”（`main.cjs:202-207`）是绕过而不是修正。以后内核若新增带 `type` 的诊断或内部消息（例如含路径、密钥状态），会被自动转给渲染进程；内核广播的 `type` 也与主进程自己合成的 `update.status`、`focus.run` 处在同一命名空间，界面无法区分来源。
  - `desktop-surface.test.ts` 本批只改了 preload 暴露面断言，没有对转发规则与通知文字的静态断言。
- 通知与 `focus.run`：成立。`notifyWaiting`（`main.cjs:235-254`）只在 `run.updated` 且 `waiting` 为 `approval|input` 时、窗口都不在前台时触发；正文只有“有一个任务在等你确认 / 有一个任务想先问你一个问题”，标题为产品名，不含事项、当事人或任务目标（`waiting` 的取值来自 `kap-agent-client.ts:188-193`，只有 `approval/input/null`）。点击后主进程发 `{type:"focus.run", run_id}`，界面经 `runs.get` 取事项编号后跳转（`App.tsx` 新增 effect），失败静默——正确。小问题：通知标题“Kimi Work 法律版”与窗口标题“Kimi Work 法律行业发行版”（`Sidebar.tsx:45`）不一致。
- 建议修复：主进程按白名单转发（`run.updated`、`run.settled`、`kernel.event`），或在 `electron-entry.ts` 改为 `{type:"kernel.event", event: msg}` 并在主进程解包；主进程合成事件用独立前缀（如 `shell.focus.run`）。
- 建议补测：`desktop-surface.test.ts` 增静态断言：`main.cjs` 的转发分支只放行白名单类型；`new Notification({...})` 的 `body` 只能是字面量常量（不含模板插值）。

---

## 七、确认卡与提问卡

### B4-B15 检索卡首屏：现有组合下成立；无变体检索卡仍渲染 `card.title`；`charDiff` 无用例（建议）

- 结论：基本成立。
- 证据（逐分支）：
  - 变体只有三种组合：`[]`、`["generalized"]`（L3a）、`["original","generalized"]`（`interaction-cards.ts:129-131`）。“只有 original 变体”在当前实现中不会出现（`Cards.tsx` 对它的处理是显示原文与“按原文检索”，那时原文就是将发出的内容，合理，但缺一句“会发出当事人名称”的提示）。
  - `generalizedOk` 为真（含 L3a）：“会做什么”换成中性文字（`Cards.tsx:106`），“发给谁、发什么”只显示改写稿与差异（`QuerySend`，只渲染 `same/added`，`removed` 只计数，`:231-241`）；`why`、`destination` 为固定文案；原文只在“更多选项 → 二次确认”中出现（`:148-160`）；时间线确认步骤只写工具名（`RunView.tsx:141-143`），检索工具步骤不显示 Agent 自述（`:118-119`）。成立。
  - `variants` 为空（手动档、检索式不含当事人时）：`isSearchCred` 为假，仍渲染 `card.title`=`联网检索：“{query}”`（`interaction-cards.ts:145`），发送行显示 `screen.sent`。此时检索式未触发当事人识别，风险低；但若闸门对这类查询做了自动去标识（`sent` 与 `query` 不同），首屏会出现改写前文字。Y4 §7 #3 的改法是“检索卡不渲染 `card.title`”，未完全照做。
  - 抓取卡：标题与网址就是将发出的内容（`interaction-cards.ts:160-172`，网址已经闸门检查），不属于 P0-B 范围。
  - `charDiff`（`lib/query-diff.ts`）：标准 LCS + 回溯，按码点切分（中文与代理对安全），`n·m > 400 000` 时退化为“整段删除 + 整段新增”，首屏仍只显示改写稿；内存与时间在上限内可接受。但 `ApprovalCardView` 每秒因倒计时重渲染，`QuerySend` 每秒重算一次 LCS（未 `useMemo`）；“已去掉 N 处”按被删除的连续片段计数，字符级对齐可能把一个名称拆成多段而多计。全仓没有 `charDiff/sendView` 的用例。
- 建议修复：`card.kind === "search"` 一律用中性标题，发送行显示 `sendText`；`QuerySend` 内 `useMemo`；计数改为“按改写处”（相邻的删除与新增合为一处）。
- 建议补测：`apps/desktop/test` 增 `query-diff` 纯函数用例：完全相同、整段替换、名称替换为“某公司”、超上限退化、含代理对字符；断言 `shown` 不含原文里被删除的名称。

### B4-B16 提问卡：“其他”静默覆盖已选项；读屏语义不完整（建议）

- 结论：基本成立。“未选不可提交”成立：`answered` 要求每个问题有选项或“其他”文字（`Cards.tsx:183`），“确定”禁用并给出 `title` 说明；“跳过”始终可用且对全部问题作答 `skipped`。
- 证据：`answers()`（`:173-182`）在“其他”有文字时直接返回 `other`，忽略已勾选项，界面上两者同时呈选中状态；多问题时无法“只答一部分、其余跳过”，只能全部跳过。选项按钮加了 `role="radio|checkbox"` 与 `aria-checked`（`:198-201`），但没有 `role="radiogroup"`/`group` 容器和组名，单选也不支持方向键切换；“确定”的禁用原因只在 `title` 中（读屏与触屏不可见）。
- 建议修复：输入“其他”时清空该题已选项（或选项点击时清空“其他”）；`.q-options` 加 `role="radiogroup"`（多选为 `group`）并以问题文字作 `aria-labelledby`；禁用原因以可见的提示文字呈现；可选：允许未答的题按“跳过”提交。
- 建议补测：把 `answers()` 与 `answered` 抽为纯函数，覆盖“选项 + 其他”“多选空选”“多题部分作答”。

---

## 八、侧栏状态点、窗口标题、更新横幅

### B4-B17 更新横幅的“有任务”计数只取一次，主进程安装不复核（一般）

- 结论：部分成立。“按版本记住‘稍后’”成立（`App.tsx:128-135`，读写异常时当作未记住）；执行页与审查页不显示（`route.page !== "run" && !== "review"`）；样式中性。
- 证据：`UpdateBanner` 的 `active` 只在 `status.version` 变化时经 `matters.list` 计算一次（`App.tsx:137-145`）；横幅显示后才开始的任务不会让“现在重启并更新”消失，任务结束后按钮也不会出现（除非切页重挂载）。主进程 `kwl:update-install`（`main.cjs:320-325`）只校验主框架与“已就绪”，不检查是否有进行中的任务，`quitAndInstall(true, true)` 会直接结束内核与宿主（任务被中断，重启后走恢复）。“有任务时不强制重启”在界面层成立，在主进程层没有保障。`rejected` 横幅无关闭按钮，会在除执行页、审查页外的所有页面常驻。
- 建议修复：横幅订阅 `run.updated/run.settled`（或复用侧栏的 `activity`）实时计算；主进程安装前经内核查询进行中任务，有则拒绝并返回原因；`rejected` 横幅可关闭（按版本记住）。
- 建议补测：`desktop-surface.test.ts` 静态断言安装处理器在调用 `install()` 前查询内核任务状态；横幅显示逻辑抽纯函数（版本、稍后记录、进行中数量 → 显示/按钮）单测。

### B4-B18 `activity` 的状态集合与读屏（建议）

- 结论：基本成立。
- 证据：`matters.list` 的活动查询（`api/index.ts:579-590`）按 `tenant_id + status IN (...)` 取，走 `runs_status_idx (status)`（`migrations/0009_v9_run_states.sql:42`），只扫进行中的运行，性能无虞；按 `created_at DESC` 使 `waiting_run_id` 指向最新的等待任务，正确。但集合不含 `budget_paused`（`queue.ts:81` 明确它是“人的决策点”）、`recovering`、`waiting_device`：预算暂停的任务不亮橙点、不计入标题与横幅的“有任务”。侧栏圆点是带 `aria-label` 的无角色 `span`（`Sidebar.tsx:99`），多数读屏不会朗读；按钮的 `title` 也不可靠。标题计数（`Sidebar.tsx:41-47`）只算等待数，与 Y4“(1)”规格一致。
- 建议修复：`budget_paused` 计入 `waiting`；圆点改为按钮内的视觉隐藏文字（`sr-only`）。
- 建议补测：kernel `matters.list` 用例断言 `activity` 对 `waiting_approval`、`budget_paused`、`running` 的计数。

---

## 九、能力账本

### B4-B19 TodoList 标 native 与本行定义不符（一般）

- 结论：部分成立。证据测试登记有效：`p1-kap-host.test.ts:548-553` 校验每个 `evidenceTests` 都是某个测试标题的子串，“过程事件与流式回复”“K7-P 过程快照：TodoList”“K7-4 子 Agent 预算按成员计”均存在。
- 证据：TodoList 行（`capabilities.ts:99-109`）的 `access` 是“原生，映射任务步骤”、`evidence` 是“与任务状态一致”；实现只是运行中在执行态显示主 Agent 的清单，终态后快照不再返回（清单随之消失），没有映射到业务任务步骤，也没有任何断言检查清单与运行状态一致（kap-a1 只断言运行中看得到两项）。原 `note` 写明“与业务任务步骤的映射未实现”，现在改 native 属于口径放宽。子 Agent 行（仍 `pending`）与集群行（仍 `pending`，注明并发上限未验证）口径如实；但集群行的“超额暂停并说明”受 B4-B05、B4-B06 影响尚未成立。
- 建议修复：TodoList 改为 `policy_limited`/`partial`（或修改 `access/evidence` 为“执行态实时显示，不映射业务步骤”后再标 native）；集群行 `note` 补“超预算获批后不计数（待修）”。
- 建议补测：若保留 native，补“清单与运行状态一致”的断言（例如终态时成果页保留最后一份清单，或明确不保留并在账本说明）。

---

## 十、其他问题（含 Y4 P0 未落实部分）

### B4-B20 静默看门狗在有过程快照时失效（重要）

- 结论：成立。
- 证据：`RunView.tsx:419` `useEffect(() => setLastActivity(Date.now()), [events.length, liveText, progress, approvals.length, questions.length])`；`progress` 每秒随 `runs.interactions` 轮询重新反序列化为新对象（`RunView.tsx:365` 每秒 `refresh`，`setProgress(i.progress ?? null)`），引用每次都变，`lastActivity` 每秒被重置。只要助手用过一次 TodoList（或有任何子任务、压缩记录），“90 秒无进展”提示就永远不会出现。Y4 P0-D 的验收点因此只在“从未产生过程快照”的任务上成立。
- 影响：模型或宿主卡住时律师仍只看到“正在处理…”，正是 P0-D 要解决的问题。
- 建议修复：依赖改为内容键（例如 `JSON.stringify(progress)` 或内核为快照附带单调 `version`/`updated_at`），或在 `setProgress` 前比较内容、相同则不更新。
- 建议补测：把“活动键”计算抽为纯函数并断言“内容相同的两份快照得到相同的键”；或在 `run-progress-view.test.ts` 中覆盖。

### B4-B21 `agent.error` 的 `retryable` 被内核裁掉，“正在自动重试”分支不可达（一般）

- 结论：成立。
- 证据：宿主推送 `run.error {code, message, retryable}`（`kap-host/src/runtime.ts:567`）；内核 `slimAgentPayload` 对 `agent.error` 只保留 `{code, message}`（`executor.ts:846-847`）；`RunView.tsx:200` 用 `p.retryable` 选择“AI 服务出了点问题，正在自动重试”，永远为假，所有错误都显示“这一步没有完成，任务会尽量继续”，包括引擎正在重试的可恢复错误。
- 建议修复：`slimAgentPayload` 保留 `retryable: p.retryable === true`。
- 建议补测：kap-a1 用脚本模型返回一次 5xx，断言时间线 `agent.error` 载荷含 `retryable: true`；`buildSteps` 抽测（若可）断言文案。

### B4-B22 Y4 P0 与 Y3 方案中尚未落实的部分（一般）

- 结论：部分落实。
- 证据与差距：
  - P0-A（Y4 §7 #2）：要求检索/抓取步骤显示实际发出的 `sent_text` 并注明“已去掉当事人名称”、确认后回写原步骤；实现只是隐藏 Agent 自述并写“实际发出的内容见右侧‘数据去向’”（`RunView.tsx:118-119`），内核未在事件中带 `sent_text/variant`。
  - P0-C（#4）：`runs.retry` 未覆盖（B4-B12）；宿主冲突码未改 `matter_busy`（Y4 写法；当前用 `block_kind` 达到同等效果，可接受）。
  - P0-D（#5）：无 `heartbeat_at`；30 秒阶段提示未做；看门狗失效（B4-B20）；`retryable` 文案不可达（B4-B21）。
  - P0-F（#6）：卡片固定中栏底部已做（`.interactions { position: sticky; bottom: 0 }`，`styles.css:526`），但“同一时间只展开一张，其余折叠为‘还有 N 项待确认’”未做（`RunView.tsx:706-712` 全部平铺）。
  - #7：过程信息放在中栏时间线下方而非右栏“进度”标签，属于有意简化，可接受；后台任务未还原代号（B4-B03）。
  - K7-4（Y3 §3.1）：超预算卡文案未带成员数（B4-B06）；N-1（Y3 §3.2）：端到端用例未加（B4-B07）。
- 建议：在进度文档“待”列中逐条登记上述差距，避免“P0 已完成”的表述。

### B4-B23 残留工程用语（建议）

- 结论：成立（少量）。
- 证据：`lib/labels.ts:82、88` “Agent 草稿”“Agent 草稿（部分完成）”，`pages/RunView.tsx:55` “Agent 指令文件，不作为交付件”；时间线 detail 级“助手结束：…（{reason}）”直接显示英文原因码（`RunView.tsx` `agent.outcome` 分支，detail 级，影响小）。
- 建议修复：改为“助手草稿”等；原因码经映射表转中文。
- 建议补测：加一条静态扫描用例，界面字符串中不得出现 `Agent `、`G0`、`G1`（注释除外）。

---

## 附：本次运行的用例

| 用例文件 | 结果 |
|---|---|
| `packages/kap-host/test/progress.test.ts` | 2/2 通过 |
| `packages/kap-host/test/embed-drift.test.ts` | 1/1 通过（本机 fork 在，未跳过） |
| `packages/kernel/test/run-progress.test.ts` | 2/2 通过 |
| `apps/desktop/test/run-progress-view.test.ts` | 1/1 通过 |
| `packages/kap-host/test/s2-regressions.test.ts` | 7/7 通过 |
| `packages/kernel/test/kap-a1.test.ts` | 未运行（只读新增两例） |

---

## 处置（2026-10-14，同日）

由修复子代理逐条处置。除 B4-B22 外，其余发现都已有代码修复；B4-B22 按建议只登记了 Y4 P0 未落实的部分。逐条处置、改动文件与补测见进度文档“专项 · 第 4 批”中的“复核 B 处置”一条。本报告第一节所列的三处旧表述已在进度文档更正。

| 编号 | 处置 |
|---|---|
| B05、B07、B09、B20（重要） | 已修复（超预算获批后按成员数补记；取消结果由执行器直接入账、文案改正、新增“取消与确认卡同时到达”端到端用例；漂移报警目录在而文件缺失即失败，并锁定事件与工具入参；静默看门狗按内容取键） |
| B01–B04、B06、B08、B11、B12、B14、B17、B19、B21 | 已修复（B14 只改转发分支；B17 只改界面层，主进程安装前核对列入待办） |
| B10、B13、B15、B16、B18、B23（建议） | 已修复，其中 B16、B18 为部分修复（原因见进度文档） |
| B22 | 已登记：P0-A `sent_text` 回写、P0-D `heartbeat_at` 与 30 秒阶段提示仍未落实；另完成 P0-F（确认卡同一时间只展开一张） |

验证：子代理两轮运行 kap-host、kernel（含 kap-a1、kap-cancel 等）、desktop 相关套件，第一轮 125/125 通过；第二轮 72 例中 71 通过，失败的 1 例在改正报错文字后单独重跑 9/9 通过。全量结果见进度文档。
