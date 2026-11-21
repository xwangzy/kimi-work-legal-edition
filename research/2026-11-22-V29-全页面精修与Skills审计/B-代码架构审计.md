# B. 代码架构审计（只读）

- 日期：2026-11-22
- 对象：worktree `kimi-legal-b55-ux-skills`（基于 main 6044d04，已并入第 51 批 23907f4，HEAD 8e81698）
- 方法：只读代码与 git 历史；没有跑全量用例、没有启动进程、没有改产品代码。凡没在代码里核实的写“未核实”。
- 行号均以本 worktree 为准。

---

## 方向 1：任务执行链路

链路实况（核实于代码）：界面 `RunSheet.tsx:53 api.startRun` → 内核 RPC `runs.estimate`（`api/index.ts:1514`）→ `runs.start`（`api/index.ts:1663`）→ `queue.enqueue` → `executor.ts:1129 runAgentScenario`：读材料 → 令牌化快照 → `agentClient.start` → 每 800ms 轮询宿主 → 结束后入库成果 → 主交付物核对 → （可选）修订稿第二段 Agent → 独立复核（模型调用）→ （复核要改时）修改轮第三段 Agent → 结算。

### 1.1 一单任务最多串行三段 Agent + 一次复核调用，时限上限叠加约 105 分钟

（主任务 `executor.ts:2466 AGENT_WORK_LIMIT_MS = 40 分钟` + 修订稿 25 + 复核 15 + 修改轮 25；实际耗时远低于上限，11-12 记录的工作时间中位 7.9 分钟、最长 17.3 分钟，见 `research/2026-11-12-V18产品再审视/01-首轮实施与验证记录.md:147`。）

- 证据：
  - `executor.ts:1424-1427` 主任务成功后才 `runRedlineStage`；`executor.ts:1455-1458` 再 `runReviewStage`。
  - 时限常量：`executor.ts:984 REDLINE_LIMIT_MS = 25 * 60_000`、`:1593 REVIEW_LIMIT_MS = 15 * 60_000`、`:1601 REVIEW_FIX_LIMIT_MS = 25 * 60_000`，主任务另有 `AGENT_WORK_LIMIT_MS`。
  - 复核是 `broker.chatStream`（`executor.ts:1921`），修改轮是又一个 `agentClient.start(... task_suffix: "review")`（`executor.ts:2023`）。
- 根因：每次真实走查发现一类问题就追加一段“事后补救”（修订稿 D-178、独立复核 D-161、追问复核 D-184），都挂在主任务尾部串行执行，没有回头合并。
- 影响：律师看到的“完成”要等主任务 + 复核 + 修改轮全部结束；11-12 的硬数字是耗时 98% 在模型（`research/2026-11-12-重新审视与第一档四项`），这三段正是模型时间的主要放大器。
- 建议：小改。①复核结论出来、且只有“建议改”没有“必须改”时，先结算为可交付，修改轮改成律师点按钮才跑（默认不自动跑第三段 Agent）；②修订稿段与复核可并行（复核对象是审查意见书，修订稿在原件上写，二者不读对方产物——需核对 `reviewTargets` 是否把 revision_draft 列入对象，未核实）。
- 改动范围：`executor.ts` 一个文件 + RunView 一个按钮；不动迁移、不动可信边界。
- 收益：典型审合同单少等一段 Agent（按上限 25 分钟、实际未核实）。
- 验证：对 57 单流水线（`platform/eval`）统计 `review.fixStarted` 事件比例与该段耗时，前后对照。
- 风险：律师可能不点“按复核意见修改”，交付质量依赖律师判断；可在成果卡上把复核“必须改”数字做醒目提示。

### 1.2 律师端每秒 5 次串行 IPC，内核广播还会再触发一轮

- 证据 `apps/desktop/src/pages/RunView.tsx:202-283`：

```ts
const r = await api.runEvents(runId, cursor.current);   // 1
const g = await api.getRun(runId);                       // 2
const rc = await api.riskCards(matterId, { run_id: runId }) // 3
const i = await api.interactions(runId)                  // 4（未结束时）
const ol = await api.outlines(matterId, runId)           // 5（未结束时）
...
const t = setInterval(() => void refresh(), 1000);        // :281
const off = onKernelEvent((m) => { if (m?.run_id === runId) void refresh(); }); // :274
```

- 根因：每加一个面板（风险卡、提纲、交互）就往同一个 refresh 里加一次请求；有单飞锁（`inflight`）防并发，但不防“没变化也全量取”。`getRun` 每秒把全部成果列表重新取一遍。
- 影响：长任务（30 分钟）约 9,000 次 IPC，每次 `getRun`/`riskCards` 都查库并做 JSON 反序列化；`texts` 的 useMemo（`:289-292`）随每次新对象重算整页代号还原。低配 Windows（8GB，`index.ts:516` 已把 kap 并发降到 1）上会抢主进程。
- 建议：小改。内核加一个 `runs.snapshot`（一次返回 events 增量 + run + interactions + outlines + 风险卡摘要 + `state_version`），界面在 `state_version` 不变时跳过 set；定时器改 3 秒兜底、主要靠 `onKernelEvent`。
- 改动范围：`api/index.ts` 加一个只读方法，`api.ts`、`RunView.tsx` 各改一处；不动迁移。
- 收益：IPC 降到约 1/10；界面不再每秒重算代号还原。
- 验证：在 RunView 计数 `invoke` 次数（开发模式打点），一单 10 分钟任务前后对比；现有 RunView 用例照跑。
- 风险：漏字段导致某个面板不刷新——用“旧 refresh 与新 snapshot 结果逐字段对比”的临时断言跑一轮。

### 1.3 律师对提问的回答只存在内存里，重启后复核人看不到

- 证据 `packages/kernel/src/executor/kap-agent-client.ts:195`：`const answeredByRun = new Map<string, string[]>();`，`:694-712` 写入与读取；`executor.ts:1910-1911` 复核用 `agentClient.answered?.(rid)`，注释原文就写了“答复只记在内存里，重启后此前各轮的取不到”。
- 根因：W1 时期把回答当作宿主会话状态，没落库；复核是后加的消费方。
- 影响：律师在任务中答过“违约金按 20%”，内核重启（崩溃恢复、更新重启）后的复核会把这条当“无出处”判为必须改（V13 W6 就是这个症状，只修了不重启的情形），触发多余的修改轮。
- 建议：小改。回答已经进事项账本（`agent.question_answered` 在 `executor.ts:929-946 AGENT_TIMELINE_EVENTS` 集合内，会镜像到 `run_events`；但经 `slimAgentPayload` 裁剪后是否还保留回答原文未核实，若不保留需在镜像时保留令牌形态的回答）；复核时从 `run_events` 取，去掉内存 Map。
- 改动范围：`executor.ts`、`kap-agent-client.ts` 两处；不动迁移。
- 收益：重启后复核不误判；删掉一个有上限（200 条）还会被挤掉的内存结构（`:695`）。
- 验证：用例：回答后模拟重启（新建 client），复核消息里仍含回答。
- 风险：低。

### 1.4 “重新运行”有两条互不相同的路

- 证据：
  - `api/index.ts:2059-2087 runs.retry`：只接受 `status = 'failed'`（`:2078`），同一个 run_id 重排队；超时（timed_out）、过期的任务不能 retry。
  - 超时文案却说“可以在本页重新发起”（`executor.ts:1282`），界面对这类任务走 `api.startRun` 开新任务（`RunView.tsx:540` 一带）。
  - 同一条 retry 里还在写旧点数字段：`points_reserved = budget_points`（`api/index.ts:2079`）；内核 `points_reserved|budget_points` 共 14 处引用。
- 根因：retry 设计于对账场景（F6），后来超时/额度失败也要“再来一次”，就另走了新建任务；第 40 批取消点数改额度%后，没清理点数预留字段。
- 影响：律师看到同样的“重新运行”，一种在原任务页继续（旧文件标 superseded），一种跳到新任务页（旧文件仍挂在旧任务）；第 44 批的“上一次运行的文件”只覆盖前一种。
- 建议：小改。让 `runs.retry` 接受 `failed | timed_out | expired`（这三种都没有成果检查点或检查点已校验），界面一律用 retry；超时文案改成“重新运行”。点数字段见方向 3。
- 改动范围：`api/index.ts` 一处 SQL + 状态机：`packages/domain/src/states.ts:101-103` 现为 `failed: ["queued"]`、`expired: []`、`timed_out: []`，需加 `timed_out/expired → queued`；`RunView.tsx` 一处。另：状态表里还有 `budget_paused`（`states.ts:91`），是点数时代的暂停态，取消点数后是否还有写入点未核实。
- 收益：一条恢复路径，superseded 逻辑全覆盖。
- 验证：已有 `v9-defects R-07` 用例扩到 timed_out。
- 风险：timed_out 但宿主仍在跑的极端情形——retry 前先确认宿主任务已取消（`finally` 里已有 cancel，`executor.ts:1303-1318`）。

### 1.5 事件序号靠手工分段，宿主序号超过 2 万会和修改轮镜像撞号被静默丢掉

- 证据 `executor.ts:1289` 主任务镜像 `10_000 + ev.seq`；`:1592 REVIEW_SEQ.fixMirror: 30_000`；`:986 REDLINE_SEQ.mirror: 50_000`；`:147/157` 用 `INSERT OR IGNORE`。宿主 `ev.seq` 是该任务全部事件的计数（`kap-agent-client.ts:379 seq: task.events.length + 1`）。另：关键事件只镜像前 27 条（`executor.ts:1293 mirrorSeq < 68`）。
- 根因：用固定序号当幂等键，再按段错开。
- 影响：一般任务远不到 2 万事件，低概率；但一旦撞号就是时间线和审计签名链里少事件，且无告警。`task.events` 数组本身随任务无上限增长（`kap-agent-client.ts:379`）。
- 建议：小改。镜像事件改用 `(run_id, attempt_id, source, source_seq)` 做唯一键，或把段宽拉到 1e6；宿主 events 数组在内核游标确认后裁掉。
- 改动范围：需改 `run_events` 唯一约束则要新迁移（不建议）；只改段宽不动迁移。
- 收益：消除静默丢事件。
- 验证：构造 25,000 个宿主事件的单测。
- 风险：低（改段宽）。

### 1.6 “先让模型读空事项再回头问律师”——前置检查仍在模型里做

- 证据：
  - 每个方法的第一步都是 `materials.list`（例：`content/skills/intake-notes/SKILL.md` 第 2 节第 1 条；系统提示 `executor.ts:1053` “先用法律工具 materials.list 查看材料目录”）。
  - 方法 frontmatter 有 `arguments`、`tools_required`、`outputs`，但没有“必需材料”字段；内核与界面搜不到任何“方法需要材料而事项为空”的检查（`grep materialsRequired|requiresMaterial|needs_materials` 在 desktop/src、kernel/src 中 0 处）。
  - 发起时内核已经知道勾选的材料（`api/index.ts:1519 docIds`）和事项口径（立场、法域），却仍由方法第 3 步让模型“不明时用提问工具询问律师”。
- 根因：方法正文写给模型，前置条件没有结构化。
- 影响：审合同、尽调、质证这类方法在事项无材料或材料全是 unreadable 时，要等模型启动、列目录、再发提问，才告诉律师“没有材料”——一次往返约 30～90 秒（按 11-12 记录“耗时 98% 在模型”推断，具体值未核实）且计费。
- 建议：小改。frontmatter 加 `kwl.requires: { materials: min 1, kinds?: [...] , args: [side, ...] }`；`runs.estimate` 把缺项放进现有的 `start_blocked/block_kind`（`api/index.ts:1648-1650` 已有这套机制，加一个 `kind: "inputs"`），开始面板直接让律师补材料或补立场。
- 改动范围：`content/skills/*/SKILL.md`（只加字段）、`build-skills.mjs`、`api/index.ts` 一处、`start-block.ts` 一处；不动可信边界（方法签名包重签即可）。
- 收益：最常见的空跑直接在本机 0 成本拦下；律师少一次“等 AI 问我”。
- 验证：各方法在空事项发起，预期在估价阶段被拦。
- 风险：方法签名与内容分发需要重签（`content-dist`）。

---

## 方向 2：渲染层结构

体量（实测）：`RunView.tsx` 1531 行、50 个 useState、18 个 useEffect、调 15 个 api 方法；`Connections.tsx` 1571 行、56 个 useState、22 个 api 方法、16 个子组件（`GeneralTab`、`VisibilityTab`、`AuthorizationSettings`、`SourcesTab`、`AccountTab`、`BackupTab`、`AdminTab`、`DiagnosticsTab`、`PolicyTab`……，`Connections.tsx:49-1557`）；`api.ts` 1622 行，34 处 `any`。

### 2.1 RunView 是“一个组件管全部”：取数、状态合并、代号还原、九个面板混在一个函数里

- 证据：`RunView.tsx:86` 起的 `RunView` 一直到 `:1310` 才结束（约 1,220 行单函数）；取数见 1.2；代号还原 `texts` 把 preview、事件、成果、风险卡、提纲全拼成一个大字符串（`:289-292`），任何一项变化都整串重算。
- 根因：每批在同一组件里加面板，没有抽“任务快照 hook”。
- 影响：维护上改一处就要读 1,200 行；性能上见 1.2。律师侧不直接可见，但本页的“卡住/不刷新”类缺陷历次都出在这里（`:243` 注释“复核 B4-B20：每秒轮询都会反序列化出新对象，引用变化让静默看门狗永远被重置”）。
- 建议：小改（与 1.2 同一次做）。抽 `useRunSnapshot(runId)`（取数 + 去重 + 版本号短路）与 `useTokenRestore(texts)`；面板组件不动。不建议整页重写。
- 改动范围：`RunView.tsx` 一个文件拆出 2 个 hook 文件；不动内核。
- 收益：RunView 主函数可降到 700 行左右（估算）；取数逻辑可单测。
- 验证：现有 desktop 用例 + 手动跑一单任务看九个面板。
- 风险：低到中（hook 依赖数组写错会漏刷新）。

### 2.2 Connections.tsx 是 10 个设置页装在一个文件

- 证据：见上方子组件清单；`MODE_TEXT`（`Connections.tsx:1453`）与 `lib/labels.ts:20 MODE_LABELS` 是同一组文案的两份（一个写“标准”，一个写“标准（推荐）”）。
- 根因：设置页按 tab 增长。
- 影响：只影响维护；文案两份会漂移。
- 建议：小改（机械拆分），每个 tab 一个文件放 `pages/settings/`；`MODE_TEXT` 改用 `MODE_LABELS`。收益低，可放在后面。
- 改动范围：1 拆 10；无逻辑变化。
- 验证：tsc + 现有用例。
- 风险：低。

### 2.3 状态常量在界面和内核各写一份，而且不一致

- 证据：
  - `apps/desktop/src/lib/labels.ts:76 TERMINAL_STATUSES = [..., "reconciling"]`（含对账中）
  - `apps/desktop/src/lib/badges.ts:30 TERMINAL = [...]`（不含 reconciling）
  - 内核 `queue.ts:37`、`api/w1.ts:46`、`kap-agent-client.ts:593` 又各写一份；权威表在 `packages/domain/src/states.ts`。
- 根因：domain 包没被 desktop 引用（desktop 只 import 自己的 lib）。
- 影响：对账中的任务，RunView 当作“已结束”停止轮询（`RunView.tsx:233/280`），侧栏徽标却当作“进行中”；律师在两处看到的状态说法不同。
- 建议：小改。domain 导出 `TERMINAL_RUN_STATUSES` 与 `isSettled()`，桌面与内核都从这里取；明确 reconciling 是“需要你处理”而不是“结束”。
- 改动范围：5～6 个文件，每处一行。
- 验证：grep 确认只剩一处定义。
- 风险：低。

### 2.4 lib/ 下 66 个文件，只有 1 个是死代码；“小文件多”本身不是问题

- 证据：逐个统计 `src/` 内对 `lib/<name>.ts` 的 import（排除自身与 test）：只有 `lib/next-step.ts` 产品代码 0 引用（只有 `test/i2-ui-p1.test.ts` 引它，另有注释提到）；其余 65 个都至少有 1 处引用。`Boards.tsx`（`Matter.tsx:26` 引 `MatterBoard`）与 `RecallEval.tsx`（`Connections.tsx:20/954`，诊断页 `sub === "recall"`）都还在用。
- 判断：lib 拆得细是早期为了纯函数可测，属于合理结构，不建议合并。`next-step.ts` 可删（连同它的用例），收益很小。
- 风险：无。

### 2.5 轮询总体有界，没有发现泄漏；问答流每次推全文

- 证据：全部 13 处 `setInterval` 都在 useEffect 里返回 clear（逐个看过 `App.tsx:243/494`、`Sidebar.tsx:122/131`、`TeamShare.tsx:21`、`MembersAdmin.tsx:40`、`RecoveryBackup.tsx:54`、`Activate.tsx:694`、`RunView.tsx:281/391`、`Chat.tsx:74`、`Cards.tsx:53`、`Loading.tsx:56`）；`onKernelEvent` 订阅均返回退订（`api.ts:151-157`）。
- 小问题：`Chat.tsx:114` 收到 `chat.delta` 时用 `draft: m.text` 整段替换，说明内核每次广播的是累计全文（内核端未核实），长回答是 O(n²) 的 IPC 字节量；`RunView` 列表用下标作 key 的地方在 pages/components 里共 45 处（`key={i}` 等），多数是静态列表，未逐个核实是否有会重排的列表。
- 建议：保留；chat.delta 可改推增量（小改，非本轮重点）。

### 2.6 场景目录（scenarios.ts）是界面里的硬编码数据，与方法包有两份口径

- 证据：`lib/scenarios.ts:142-1094` 是 45 张卡的数据（约 950 行），字段、参数映射（`skillArgsOf :1169`、`primaryOutputOf :1192`）与 `content/skills/*/SKILL.md` frontmatter 的 `arguments`、`outputs` 是两套；内核在 `runs.start` 校验主交付物必须属于方法列出的交付物（`api/index.ts:1731-1735`），说明两份可能不一致已经发生过。
- 影响：改一张卡的字段要发新版桌面端；方法包可以签名热更新（`content-updates.ts`），卡片不行。
- 建议：中期重做（不放本轮）：卡片数据迁到 `content/skills/<id>/cards.json` 随方法包签名分发，界面只留渲染。本轮先不动。
- 改动范围：45 张卡 + 打包脚本 + 签名，较大。
- 风险：中（签名、内容分发链路）。

---

## 方向 3：内核与包的过度设计

### 3.0 包引用计数（产品代码，排除自身、用例与打包产物）

统计方法：`grep -rlE 'from "<包名>(/…)?"'`，按“引用文件数 [引用方]”列出。

| 包 | 引用文件数 | 引用方 | 判断 |
|---|---|---|---|
| domain | 69 | 9 个包/应用 | 核心，保留 |
| keys | 38 | 11 处，含云端服务 | 可信边界，保留 |
| docx-engine | 22 | kernel、exec-wasm | 文书交付核心，保留 |
| safe-log | 22 | 6 个包 | 保留 |
| tokenizer | 21 | kernel、egress-gate | 可信边界，保留 |
| firm-trust | 17 | kernel + 8 个云端服务 | 可信边界，保留 |
| egress-gate | 15 | kernel | 可信边界，保留 |
| at-rest | 14 | 4 个包 | 可信边界，保留 |
| lawdb | 13 | kernel | 保留 |
| file-broker | 10 | exec-wasm、kap-host | 保留 |
| seat-token | 10 | kernel + 云端 | 可信边界，保留 |
| host-policy | 8 | kap-host、kernel | 可信边界，保留 |
| egress | 6 | kernel、model-broker | 可信边界，保留 |
| model-broker | 5 | kernel | 可信边界，保留 |
| pseudonym / service-auth / ops-auth | 4 / 4 / 4 | — | 保留 |
| parse-ocr | 3 | kernel | 保留 |
| sync | 2 | kernel | 见 3.3 |
| blob-store | 2 | 只被云端服务用 | 保留（云端） |
| content-dist | 1 | kernel | 方法包签名分发，保留 |
| exec-wasm | 1 | kap-host | 执行域，保留 |
| im-connectors | 1 | **只被 apps/firm-node 用** | 见 3.3 |
| kap-host | 0（import） | 内核按入口路径起子进程（`kap-agent-client.ts:37`） | 保留 |
| design-tokens | 0（import） | 以 CSS 文件被 desktop、console 引入（`styles.css`、`console.css`） | 保留 |

结论：**没有“完全没人用”的包**。`packages/` 不是过度设计的主战场。

### 3.1 内核 API 是 5,546 行、192 个方法的单文件

- 证据：`packages/kernel/src/api/index.ts` 5,546 行，`grep -cE '^    "[a-z_.]+": '` = 192 个 RPC 方法（`runs.*`、`matters.*`、`members.*`、`reminders.*`、`im.*`……同一个对象字面量）。
- 根因：每批加方法直接加在这个对象里；权限检查（`requireRunAccess`、`requireMatterWriter`、`assertNotExitMode`）在每个方法里手写。
- 影响：律师侧不可见；工程上任何人改 runs 都要在 5,000 行里找；手写权限检查漏一处就是越权（本次未发现漏写，未逐个核实 192 个）。
- 建议：小改（机械拆分），按域拆成 `api/runs.ts`、`api/matters.ts`……，`index.ts` 只合并；**不改方法名、不改权限语义**。可与 2.2 同属“搬家不改逻辑”，排在后面做。
- 改动范围：1 拆约 12；不动迁移；碰到可信边界的方法（account、egress、members）只搬不改。
- 验证：tsc + 全量用例；另加一个用例断言 192 个方法名集合不变。
- 风险：低到中（闭包里共享的局部变量多，拆时要显式传参）。

### 3.2 点数计费已取消，字段与暂停态仍在执行链路里

- 证据：`executor.ts:99-100 budget_points / points_reserved`、`:663 UPDATE runs SET points_charged = points_reserved`、`api/index.ts:1690-1693`（注释“本机流程不计点”“单任务预留只作安全阀”）、`:2079` retry 时 `points_reserved = budget_points`；状态 `budget_paused` 仍在 `identity.ts:55 LIVE_RUN_STATUSES` 与 `domain/src/states.ts:91`；界面字段仍叫 `points_display`（`api.ts:957`，实际内容已改为额度百分比，`api/index.ts:1660 estimateDisplay`）。内核 `points` 相关 49 处。
- 判断：这属于“用量配额/计费”可信边界，**不建议本轮动**。只建议：①在 `budget_paused` 确认无写入点后从 `LIVE_RUN_STATUSES` 去掉（未核实是否还有写入）；②`points_display` 改名为 `usage_display`（纯命名，界面 7 处）。
- 风险：动计费字段会影响账本对账（第 44 批“账本↔网关 61/61”），所以只改命名不改语义。

### 3.3 共享文件夹同步、firm-node、IM 连接器：默认关闭但体量大

- 证据：`sync-engine.ts` 1,376 行、`member-log.ts` 1,374 行、`services/share-relay.ts` 1,217 行；同步只在配置 `ZR_SYNC_SHARE_DIR` 时启用（`config.ts:55/414`、`index.ts:878-883`）；`apps/firm-node` 510 行；`im-connectors`（钉钉）只被 firm-node 用；内核仍暴露 `im.bind/im.list/im.unbind`。
- 判断：当前产品形态是“自建托管 SaaS + 本地客户端”（记忆：product-form-self-built-saas），共享文件夹同步与 firm-node 属于更早的“所内节点”形态。记忆里记录过“删 firm-node 判断不成立”，本次没有新证据推翻，**不建议删**；建议冻结（不再加功能），并在下一次有人要改 `member-log` / `share-relay` 时先确认是否仍有客户在用。
- 改动范围：本轮 0。

### 3.4 内核 services 没有死代码；单处引用是正常的服务层结构

- 证据：逐个统计 `src/services/*.ts` 的 import：最少的是 `egress-summary`、`recovery-package`、`recall-eval`、`send-preview`（各 1 处产品引用、0 个直接用例），其余都 ≥1。`recall-eval`（令牌化召回评测，界面在诊断页 `Connections.tsx:954`）属于令牌化可信边界的自检，保留。
- 判断：不需要清理。

### 3.5 可信边界：本次只看到一处明显缺陷（见 1.3），其余未发现

- 出站闸门、令牌化、模型调用、加密存储本次没有逐行审计，只核对了执行链路上的调用点：复核调用带 `knownOnly: true`（`executor.ts:1932`）、宿主出口唯一（`third_party/PATCHES.md` ZP-11/ZP-23 与 `static-surface.test.ts` 精确白名单）。未发现绕过。

---

## 方向 4：与 Kimi Code 上游的重复与嵌入脆弱点

上游现状（`api.github.com/repos/MoonshotAI/kimi-code/releases`，2026-11-22 读取）：最新 `@moonshot-ai/kimi-code@2.7.2`（11-20）。我们锁在 **2.2.0（10-14，`472192c34`）**，落后 2.3～2.7 共 5 个小版本、约 15 个发布。补丁 `third_party/patches/kimi-code-2.2.0-zhongruan.patch` 改 55 个文件（`PATCHES.md` 第 7 行）。

### 4.1 我们依赖的嵌入接口已在上游 2.5.0 被删除——升级就断

- 证据：
  - 我们的宿主客户端用的路由（`packages/kap-host/src/kap-client.ts:40-50`）：`GET /sessions/:id/tasks`、`GET /sessions/:id/tasks/:task_id`、`POST /sessions/:id/tasks/:tail`（`:215` 用 `:cancel`）、`GET /sessions/:id/snapshot`（`:234`），以及 `subscribe`（`:237`）。
  - 上游 2.5.0 发布说明（原意）：删除 REST 任务接口（含 `:cancel`/`:detach`），改用 WebSocket `task.stop`；删除 WebSocket `subscribe/unsubscribe` 帧与游标重放、`GET /sessions/{id}/snapshot`、`last_seq`，改用 `subscribe_v2`。
  - 上游 2.6.0：会话的 profile、模型、思考档在创建时给定，prompt 不再接受 profile；`kap-client.ts:170-174 enterPlanMode` 走 `POST /profile {agent_config:{plan_mode:true}}`，该接口在 2.6 是否保持同样语义未核实。
- 根因：ZP-19 的嵌入方式是“进程内 Fastify `inject()` 调上游的 HTTP 路由”，等于把上游的**内部 API**当成稳定接口。
- 影响：①上游 2.4～2.7 修了大量我们会遇到的问题（见 4.2），我们拿不到；②每次升级都要重写宿主客户端 + 重放 55 文件补丁，`PATCHES.md` 记录 2.1.1→2.2.0 一次 rebase 就是一整批工作。
- 建议：重做（中期，不在本轮前 8）。下次升级时把宿主侧只依赖一层“引擎适配器”（`matter-engine.ts` 已是雏形，276 行），适配器内部对接上游 v2 WebSocket 帧；补丁按“可上游化”分类，向上游提 ZP-4（宿主策略链首位）、ZP-19（无端口嵌入）这两个通用诉求。
- 改动范围：`kap-host/src/kap-client.ts`、`runtime.ts`、`matter-engine.ts` + 补丁重做；不动内核与可信边界语义。
- 验证：`embed-drift.test.ts`、`static-surface.test.ts`、`p1-kap-host.test.ts`；真实模型一单。
- 风险：高（安全补丁要逐条重新验证）。所以本轮只建议**冻结在 2.2.0 + 挑选修复**，并立项评估。

### 4.2 上游已提供、我们在内核里另做了一套的能力

| 能力 | 我们的自建 | 上游版本与说法 | 判断 |
|---|---|---|---|
| 追问 / 补充指令 | 追问 = 新建一个 run，`continue_session_id` 续会话，再走一遍复核（`api/index.ts:1770-1790`、`executor.ts:1168-1177`、`:1430-1454`） | 2.5.3 加 `POST /sessions/{id}/steer`，“打断进行中的模型请求并在同一轮继续”；2.7.0 有 Steer 跟进模式 | 任务**进行中**律师补一句话，现在只能等它结束再追问。升级后可用 steer 做“进行中补充”，追问（结束后）仍保留现设计 |
| 计划先行 | `plan_first` 提示词行 + `enterPlanMode` + 宿主确认卡（`executor.ts:1147`、`kap-client.ts:170`） | 2.4.0：计划模式只能由用户打开，每个计划都等用户审，Agent 不能自己进 | 语义已与我们一致，不必在提示词里再写“先出计划” 的约束（`PLAN_FIRST_LINE`）——但我们锁在 2.2.0，2.2.0 的行为未核实 |
| 子 Agent 超时 | 我们没自建，但 2.2.0 有“子 Agent 立即超时”问题的可能 | 2.7.0 修复 `[subagent] timeout_ms = 0` 时子 Agent 立即超时 | 未核实我们是否受影响 |
| 长会话卡住 | 内核兜底超时 + 到时限已交付按部分完成（`executor.ts:1248-1257`、`:1282`） | 2.6.1：工具结果含 notes/错误/计时头时长会话“空回复卡住而不压缩”的修复；2.6.0：压缩被系统提醒打断的修复 | 我们的“超时但已交出”补救一部分就是在给上游的这类卡顿兜底。**挑选这两个修复是本轮最划算的上游动作** |
| 技能加载 | 签名方法包 + `trustedInstructionsDir`（ZP-18） | 2.6.0：指示模型通过 Skill 工具调用技能而不是直接读文件；超大技能内容截断并存文件；技能目录变更热加载 | 自建部分是安全需要（不加载工作区 AGENTS.md），保留；上游“走 Skill 工具”的修复值得挑选 |
| 权限规则 | 宿主策略链首位（ZP-4/4b/14） | 2.6.0：`[[permission.rules]]` 在会话启动时生效 | 上游规则是“用户可配”，我们要的是“宿主强制、失败关闭”，不能替代。保留 |
| 回答记录 | 内存 Map（1.3） | 2.4.0 修复“取消的提问在历史里显示成已回答” | 与 1.3 一并处理 |

### 4.3 结论

- 能删的自建：本次没有找到“上游已有、可以直接删”的大块；自建的主要是安全补丁与法律业务流程，上游没有。
- 真正的问题是**落后 5 个版本 + 嵌入依赖已删接口**：拿不到上游的长会话、压缩、子 Agent 修复，而这些正是“任务超时 / 部分完成”的来源之一。
- 本轮建议：从 2.6.0/2.6.1 挑选“长会话不压缩卡住”“压缩被打断”两个修复进补丁（只改 agent-core 内部，不碰嵌入路由），并跑 57 单流水线看超时率。

---

## 方向 5：已知未解决问题（逐条回到代码核实）

| # | 问题 | 来源 | 代码核实 | 对律师交付的影响 |
|---|---|---|---|---|
| 5.1 | 复核用的律师回答只在内存，重启后丢 | `executor.ts:1909-1911` 注释 | **仍成立**（`kap-agent-client.ts:195`） | 重启后误判“必须改”→多跑修改轮→“部分完成” |
| 5.2 | 两单合同审查都报“部分完成”（回看有 1 条必须改没落到文件） | `research/2026-11-21-V28…/01-真实验收记录.md` 第 7 节第 3 条 | 设计如此（D-182），不是缺陷；但根因在修改轮 Agent 没改到位 | 律师看到“部分完成”比例高，不信任产品。与 1.1 合并处理：复核只出意见、修改由律师触发 |
| 5.3 | 席位用完时提示“席位令牌未取得或已失效”，没说“席位已用完” | 同上第 7 条 | **仍成立**：`api/index.ts:527-528` 只看 `seatToken()` 有无，不区分 `no_seat`；`account-session.ts:208` 已有 `no_seat` 分支、`lib/firm-usage.ts:262` 已有“没有席位”文案，没接上 | 新电脑律师不知道找管理员 |
| 5.4 | 问答没有“停止” | `research/2026-11-20-V25…/00-设计判断与实施.md` 第 5 节第 4 条 | **仍成立**：`api/index.ts` 中 `"chat.cancel"` 0 处 | 长回答只能等完 |
| 5.5 | 关联案卷文件夹：选文件夹与同步合成一步，选择框还开着就出现等待块 | 同上第 5 条 | `api.ts:939 linkFolder` 仍是一个函数（选择 + 同步），未拆，**仍成立**（界面表现未实测） | 体验瑕疵 |
| 5.6 | 离所交接只清写作偏好，不清 `user_ai_authorization` / `user_ai_notice` | 同上第 7 条 | 待拍板项，未核实当前实现 | 合规（可能含合同编号） |
| 5.7 | 修复分支 `fix/retry-superseded-artifacts`（1fdeb7d）未合并 | 记忆 | **已被取代**：同一修复以 `7df94c7` 进了 HEAD（`git merge-base --is-ancestor 7df94c7 HEAD` 成立，两者内核源码 diff 为空）。分支可删 | 无 |
| 5.8 | “dir-mode.ts 已修未提交” | 记忆 | **已提交**：`bf5493a`（`packages/exec-wasm/src/dir-mode.ts`，`worker.ts:16/156` 已用） | 无 |
| 5.9 | D-181 工具锁变更未双人评审 | `research/2026-11-12-V18产品再审视/01-首轮实施与验证记录.md:223` | 流程项，代码里无法核实是否已评审；`content/tool-manifest/tool-manifest.lock.json` 无评审人字段 | 安全流程缺口，不影响交付 |
| 5.10 | Windows 客户机上执行域自检未通过（GitHub 运行器） | V28 第 7 节第 8 条 | 未核实（需真机） | 任务里“本机计算/整理数据”一步不做 |
| 5.11 | 安装包未签名、未公证 | V28 第 7 节第 4 条 | 非代码问题 | Win11 智能应用控制下不能运行 |

---

## 方向 6：测试与构建

规模（实测文件数）：kernel 229、desktop 81、egress-gate 26、docx-engine 20、tokenizer 15、kap-host 10、keys 9、exec-wasm 9 等；用例文件合计约 67,000 行。上次记录的全量是 2,310 例 0 失败（1fdeb7d 提交说明）。本次**没有跑**全量，耗时未实测。

### 6.1 本机 `npm test` 串行且没有单用例时限：缺产物时挂住不报错

- 证据：`platform/package.json` 的 `test`：`node --test --test-concurrency=1 --test-reporter=spec …`，没有 `--test-timeout`；CI 用另一套 `scripts/run-tests-watchdog.mjs --file-timeout-min=10 --test-timeout-ms=300000`（`.github/workflows/windows-desktop.yml:53/67/74`），该脚本开头注释写明是因为 Windows 上整步跑满 240 分钟被杀才加的。记忆里另有“缺法规库、模板、密钥、OCR 模型时内核用例挂起不报错”。
- 影响：开发者本机（尤其新 worktree）跑全量会无提示挂住；CI 和本机两套跑法，结果不可比。
- 建议：小改。`npm test` 直接改为调用 watchdog（同一套参数），或至少加 `--test-timeout=300000`；`pretest` 已经构建产物，再加一个“产物齐全”自检文件放在最前（缺什么直接失败并说明）。
- 改动范围：`package.json` 一行 + 一个自检脚本。
- 收益：消除最常见的“用例挂起”时间浪费。
- 验证：在缺 OCR 模型的新 worktree 跑 `npm test`，预期 1 分钟内失败并说明缺什么。
- 风险：无。

### 6.2 约 455 条用正则匹配源码/CSS 文本的界面断言，重构一碰就红

- 证据：`apps/desktop/test` 下 23 个文件用 `readFileSync(.../src/...)` 读源码，`assert.match(<源码变量>, /…/)` 形态的断言共约 455 条（统计 `assert.(match|doesNotMatch)(x, /`）。例：`b51-ui.test.ts:103 assert.match(page, /Promise\.allSettled\(r\.matters\.slice\(0, 50\)\.map\(matterRows\)\)/)`、`b48-ui.test.ts:59 assert.match(css, /\.logo-mark-dot \{ fill: var\(--brand-mark-dot\); \}/)`。
- 根因：桌面端没有组件渲染测试设施，各批用“源码里有这句话”代替行为断言。
- 影响：断言的是写法不是行为——改一个变量名、换一种等价写法就失败；本轮如果做 1.2/2.1（RunView 拆 hook），会成片红，修用例的成本可能大于改代码。
- 建议：小改。不删已有纯函数用例（`lib/*` 的用例价值高）；对源码正则断言：①本轮重构涉及的文件，改写为对 `lib/` 纯函数或 hook 的行为断言；②其余保留但不再新增，新的界面行为用纯函数 + 少量真实界面走查覆盖。
- 改动范围：随重构逐个处理，不单独立项。
- 风险：删断言可能丢掉曾经修过的回归点——改写前逐条看它防的是哪个缺陷（提交说明里有）。

### 6.3 用例按“批次”而不是按功能组织；默认关闭的功能用例最多

- 证据：kernel 用例前缀：`share-*` 21 个、`b41-*` 16 个、`b39-*` 10 个、`v94-*` 7 个、`b35-*` 7 个……（`ls packages/kernel/test | sed 's/-.*//' | uniq -c`）。共享文件夹同步默认关闭（3.3），却是用例最多的一组。
- 影响：找“哪些用例覆盖了复核/修改轮”要翻批次号；改执行链路时不知道该跑哪些。
- 建议：保留现状，不搬文件；在 `platform/docs` 加一张“功能 → 用例文件”对照表即可（低成本）。share-* 用例若计划冻结该功能，可移到单独的慢速组，日常不跑。
- 风险：无。

### 6.4 对真实模型的依赖：用例里没有，真实验收在 eval 流水线

- 证据：用例中检索 `REAL_MODEL|ZR_LIVE|MAAS_KEY|skip: !process.env` 为 0；真实模型验证走 `platform/eval`（记忆：第 42 批验收流水线）与 `scripts/demo-e2e.mjs`。用例里有 90 处固定 sleep，合计约 22 秒（`setTimeout(r, N)`），21 个用例文件起子进程/Worker。
- 判断：分层是对的（单元用例不打真实模型）。固定 sleep 合计不大，不是耗时主因。保留。

### 6.5 Windows 差异仍主要靠 CI 发现

- 证据：Windows 专属修复集中在路径分隔、目录权限位（`exec-wasm/src/dir-mode.ts`）、`.sock` 拼接（记忆：第 43 批“闸门 8 个与 p1/p2 超时改判为用例拼 .sock”）；执行域自检在 GitHub 运行器上未通过（5.10）。
- 建议：保留 CI；在真实 Win10/Win11 客户机上做一次执行域自检（不是代码改动）。

---

## 总表：按“收益 ÷ 复杂度”排序

收益与复杂度都按 1～5 打分（5 最高）。“可信边界”列为“是”的只报告、不建议本轮改语义。

| 排序 | 编号 | 事项 | 收益 | 复杂度 | 比值 | 动迁移/可信边界 | 本轮 |
|---|---|---|---|---|---|---|---|
| 1 | 6.1 | `npm test` 加时限/改用 watchdog，加产物自检 | 3 | 1 | 3.0 | 否 | **做** |
| 2 | 5.3 | 席位用完提示接上已有的 `no_seat` 文案 | 3 | 1 | 3.0 | 否 | **做** |
| 3 | 1.3 / 5.1 | 复核用的律师回答改从账本取，去掉内存 Map | 4 | 2 | 2.0 | 否 | **做** |
| 4 | 2.3 | 运行状态常量统一到 domain，明确 reconciling | 2 | 1 | 2.0 | 否 | **做** |
| 5 | 1.2 + 2.1 | RunView 取数合并为一个快照接口 + 抽 hook，定时器 3 秒兜底 | 4 | 2 | 2.0 | 否 | **做** |
| 6 | 1.6 | 方法前置条件结构化，估价阶段本机拦截“无材料/缺立场” | 4 | 2 | 2.0 | 否（方法包重签） | **做** |
| 7 | 1.4 | “重新运行”统一走 `runs.retry`（放开 timed_out/expired） | 3 | 2 | 1.5 | 否（状态表一行） | **做** |
| 8 | 1.1 / 5.2 | 修改轮改为律师触发，复核只出意见；修订稿与复核评估并行 | 5 | 3 | 1.7 | 否 | **做** |
| 9 | 4.3 | 从上游 2.6.0/2.6.1 挑选长会话压缩卡住两项修复进补丁 | 4 | 3 | 1.3 | 补丁（安全回归要跑） | 本轮可选 |
| 10 | 5.4 | 问答加 `chat.cancel` | 2 | 2 | 1.0 | 否 | 下轮 |
| 11 | 1.5 | 镜像事件序号段宽拉大、宿主 events 数组裁剪 | 2 | 1 | 2.0 | 否 | 下轮（概率低） |
| 12 | 2.2 / 3.1 | Connections.tsx、api/index.ts 机械拆分 | 2 | 2 | 1.0 | 否（只搬不改） | 下轮 |
| 13 | 6.2 | 源码正则断言随重构改写成行为断言 | 2 | 2 | 1.0 | 否 | 随 5、8 项一起 |
| 14 | 2.6 | 场景卡数据迁入签名方法包 | 3 | 4 | 0.75 | 内容签名 | 不做 |
| 15 | 4.1 | 升级上游 ≥2.5 并重写嵌入适配层 | 5 | 5 | 1.0 | 补丁全重验 | 立项评估，不在本轮 |
| 16 | 3.2 | 点数字段改名 / 去掉 budget_paused | 1 | 2 | 0.5 | **是（计费）** | 不做语义改动 |
| 17 | 2.4 | 删 `lib/next-step.ts` 与其用例 | 1 | 1 | 1.0 | 否 | 顺手 |

（注：第 8 项比值低于 9～11 项，但对律师“等多久、是否部分完成”影响最大，按产品目标提前。）

### 本轮就该做的前 8 项

1. **6.1** 本机用例加时限与产物自检 —— `platform/package.json`、`scripts/run-tests-watchdog.mjs`
2. **5.3** 席位用完说清楚 —— `packages/kernel/src/api/index.ts:527-528`、`account-session.ts:208`、`apps/desktop/src/lib/firm-usage.ts:262`
3. **1.3** 律师回答落账本、复核从账本取 —— `executor/executor.ts:1909-1911`、`executor/kap-agent-client.ts:195/694-712`
4. **2.3** 状态常量统一 —— `packages/domain/src/states.ts`、`apps/desktop/src/lib/labels.ts:76`、`lib/badges.ts:30`、`kernel/src/queue.ts:37`、`api/w1.ts:46`
5. **1.2 + 2.1** 任务页一次取快照 + 抽 hook —— `apps/desktop/src/pages/RunView.tsx:202-283`、`api.ts`、`kernel/src/api/index.ts`（新增只读 `runs.snapshot`）
6. **1.6** 方法前置条件本机拦截 —— `content/skills/*/SKILL.md`（frontmatter）、`content/skills/build-skills.mjs`、`api/index.ts:1519/1648-1650`、`apps/desktop/src/lib/start-block.ts`
7. **1.4** 重新运行一条路 —— `api/index.ts:2059-2087`、`packages/domain/src/states.ts:101-103`、`RunView.tsx:496-560`、`executor.ts:1282`
8. **1.1** 修改轮改为律师触发 —— `executor/executor.ts:1424-1462`、`:1848-2218`（runReviewStage 内的修改轮分支）、RunView 成果区一个按钮

### 明确不该动的 5 项成熟实现

1. **成果入库检查点与对账（R-04/F6）**：`executor.ts:1182-1213`、`:1356-1413`。成果块先写、成果行与检查点同事务登记，结果不明的副作用调用一律转人工对账，重试按检查点结算不重跑 Agent。逻辑闭合、有专门用例（v9-defects R-07），历次崩溃恢复缺陷都已在这里收口。
2. **重新运行时旧成果标“已被取代”**：`services/attempt-supersede.ts` + `executor.ts:1215-1225`（7df94c7）。真实验收复现过、反向对照用例在案，复核/修改轮/交付包都带 `LIVE_ARTIFACT` 条件。
3. **上游安全补丁台账与静态出口门禁**：`third_party/PATCHES.md`（ZP-1～23）、`packages/kap-host/test/static-surface.test.ts`、`embed-drift.test.ts`。每条补丁有原因、有反向对照，制品可逐字节复现；这是嵌入第三方 Agent 还能守住“只有一个出口”的根据。
4. **令牌化与出站闸门链路**：`egress-gate`、`tokenizer`、`pseudonym` 及 `executor.ts:1155-1180` 的快照令牌化。可信边界，用例 26 + 15 个文件，召回评测（`services/recall-eval.ts`）在诊断页可复跑。
5. **确定性法律工具**：`packages/kernel/src/tools/tools/`（`deadline.ts`、`cn-holidays.ts`、`court-fee.ts`、`labor.ts`、`calc.ts`、`law.ts`）。期限、节假日顺延、经济补偿、诉讼费都在本机算、逐年核对过官方通知（26b6214、546f906 提交说明），这正是“把确定性判断从模型手里拿出来”的正确做法，应该扩大而不是改。

---

## 未核实清单（本报告中明确未核实的点）

- 修订稿段与复核能否并行（`reviewTargets` 是否把 revision_draft 列入复核对象）。
- `slimAgentPayload` 是否保留 `agent.question_answered` 的回答原文。
- `budget_paused` 是否还有写入点。
- 上游 2.6 的 `POST /profile {plan_mode}` 语义是否不变；2.2.0 是否受“子 Agent 立即超时”影响。
- 内核 `chat.delta` 广播是累计全文还是增量。
- 全量用例耗时（本次未跑）。
- 192 个 RPC 方法逐个的权限检查是否完整。
