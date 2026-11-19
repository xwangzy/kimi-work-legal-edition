# 实施 I1：Kimi Code 2.1.1 → 2.2.0 实际 rebase

- 日期：2026-10-19；依据：同目录《评审-Z2-KimiCode-2.2.0增量与rebase方案.md》（下称 Z2）
- 分支：`v9.3-kimicode-220`（自 `v9.3-commercial` 4a3b8de 拉出），worktree `.claude/worktrees/v93-kc`（下称 WT）。主工作区与 `.claude/worktrees/v93` 未改动。
- 草稿区：`/private/tmp/claude-501/-Users-wangzeyu-Documents-Coding-Kimi-Work-Legal/07bf89f8-fea1-4be3-a194-1cc7c60dce61/scratchpad/i1/`（日志）

## 阶段 1：工作区与依赖

- `git worktree add -b v9.3-kimicode-220 .claude/worktrees/v93-kc v9.3-commercial`；`cp -cR` 克隆 `platform/node_modules`、`apps/desktop/node_modules`、`content/ocr-models`、`content/keys`；
  `npm run build:lawdb && build:agent-profile && build:tool-manifest && build:skills` 全部成功（13 个方法模板、21 个文件签名）。
- Kimi Code 源：`git clone --no-hardlinks z2/kc WT/platform/third_party/kimi-code`，从 tag `@moonshot-ai/kimi-code@2.2.0`（472192c34c1e…）建本地分支 `zr-2.2.0-i1`。
- `git apply --check` + `git apply` Z2 补丁（d992ee24…）后 `git add -A && git write-tree` = `24b42d30d4f4843885c403f5827af5d7adb4ebff`，与 Z2 记录一致。
- node_modules：从主工作区 `platform/third_party/kimi-code` 按目录 `cp -cR`（根 + 20 个包/应用）；`packages/kaos/node_modules` 因 2.2.0 已删该包而跳过。**未联网安装任何依赖。**

## 阶段 2：补丁（ZP-23、挑选 #4066、质量闸）

### ZP-23（Z2 N-1：首包头超时的独立调度器）

- 做法：**直接禁用独立调度器**。`agent-core-v2/src/human/llm/requester/timeout.ts` 改为两个恒返回 `undefined` 的函数（`resolveLlmHeadersTimeoutMs()`、`getLlmHeadersTimeoutDispatcher(_timeoutMs)`），只留 `import type { Dispatcher } from 'undici'`，不再值导入 undici、不再读环境变量。三个请求器（anthropic、openai、openai-responses）的调用点不改：拿到 `undefined` 就不传 `fetchOptions.dispatcher`，模型请求一律走宿主 `setGlobalDispatcher(HostEgressDispatcher)`。
- 上游测试 `src/human/test/llm/headers-timeout.test.ts` 改为断言封闭行为：四种环境（不设、设 45000、设 45000 + HTTP_PROXY、设非法值）× 三个协议，`fetch` 的第二个参数都没有 `dispatcher`，回合正常完成。vitest 通过。
- 首包头超时改由宿主出口设：`kap-host/src/host-egress.ts` 新增 `MODEL_HEADERS_TIMEOUT_MS = 300_000`（与 undici 缺省相同，行为不变，只是显式、唯一的设置点），模型 Agent 构造加 `headersTimeout: MODEL_HEADERS_TIMEOUT_MS`。
- 静态面能抓到“新建 Agent/Dispatcher”的入口：`scripts/build-kap-embed.mjs` 给 inputs.json 每个输入新增 `httpClientImports`（按导入说明符记录对 `undici|ws|socks|node-fetch|axios|got|*proxy-agent` 的**值导入**；`import type` 被 esbuild 擦除，不计）。`static-surface.test.ts` 新增 ZP-23 用例：第一方导入者精确为 `_base/utils/proxy.ts <- socks,undici`（它的 `createProxyDispatcher`、`installGlobalProxyDispatcher`、`resolveSocksProxy` 被摇树，不进制品——同一用例断言）；第三方导入者精确为 `@google/genai <- ws`；制品文本不得含 `KIMI_CODE_LLM_HEADERS_TIMEOUT_MS`、`headersTimeout: timeoutMs`，两个封闭函数体为 `return void 0`；宿主出口源码含 `headersTimeout: MODEL_HEADERS_TIMEOUT_MS`。

### 上游挑选

- `85077a419` #4066（子 Agent 工具描述与可用性对齐）：`git cherry-pick -n`。产品代码干净；`test/agent/loop/loop.test.ts`、`test/tool/tool.test.ts` 的快照冲突（4 处）按 #4066 一侧解决；`.changeset/*.md` 不收。新增输入 `toolActivation/toolAvailability.ts`（制品 inputs 2297 → 2298）。
- `da5918c0c` #4239：**不挑**。它改系统提示 `system.md` 与待办提醒频率、新增遥测事件；这些提示词变化没有 kap 用例兜底，收益（宿主“进展”面板读 TodoList 已可用）不足以抵消。台账已写明。

### 质量闸（fork 内）

| 检查 | 结果 |
|---|---|
| `tsc --noEmit -p packages/agent-core-v2` / `-p packages/kap-server` | 0 错误 / 0 错误 |
| `node scripts/check-no-comments.mjs` | OK（1757 个文件） |
| `oxlint`（补丁改动的 49 个 .ts） | 0 error（105 个 warning，均为上游既有风格提示） |
| 上游 vitest（#4066 与 ZP-23 触及的 5 个文件） | 325 条中 **24 条失败**。对照：只应用 Z2 补丁（不含 #4066、ZP-23）时同 5 个文件 314 条中 18 条失败；纯 2.2.0 + #4066（不带任何 ZP）跑其中 3 个文件 308 条中 3 条失败，3 条都在上述 18 条里。新增的 6 条失败是 #4066 新用例与 ZP-11（未配 `moonshot_fetch` 时不注册 FetchURL）的交互：期望子 Agent 工具列表含 FetchURL，以及随之变化的压缩 token 数。**结论**：上游 vitest 在 ZP 补丁下本就不全绿（宿主策略缺省全部拒绝、默认放行清空等有意改变了行为），不作为门禁；本次没有引入与 ZP 无关的新失败 |

日志：`scratchpad/i1/vitest-{new,base,pure}.log`。

### 导出与复现

- 导出：fork HEAD 保持 tag，全部改动暂存，`git diff --cached --binary 472192c34 > platform/third_party/patches/kimi-code-2.2.0-zhongruan.patch`。
- **sha256 `468f1518f0ff78c3e6c89c4376264708e58b822fad09ee486afa34b97fe30f65`**，592,326 字节，55 个文件（52 改、3 新增：`hostPolicy.ts`、`embed.ts`、`toolAvailability.ts`），+743/−835。体积主要来自 #4066 的两份上游测试（单行快照约 77 KB，与上游提交本身同大）。
- 旧补丁 `kimi-code-f67e6398f-zhongruan.patch` 已 `git rm`。
- 复现：在 fork 上 `git worktree add --detach <干净目录> 472192c34` → `git apply --check` 通过 → `git apply` → `git add -A && git write-tree` = **`0c4808861774d83ab70b51cb140b143140b6edb8`**，与 fork 的 `git write-tree` 相同；`diff -r -q --exclude=.git --exclude=node_modules` 无输出，**逐字节一致**。

## 阶段 3：制品

- `scripts/build-kap-embed.mjs`：新增可选 `KWL_KC`、`KWL_KAP_EMBED_OUT`（缺省不变）；新增 `httpClientImports`；`?raw` 文本模块的路径改记为 `raw:third_party/kimi-code/…`（旧制品与 inputs.json 里有 77 处构建机绝对路径 `/Users/…/platform/…`，在 worktree 构建会把 `.claude/worktrees/…` 写进入仓制品；改后两者都不含绝对路径，换目录构建逐字节一致）；metafile 路径按 `process.cwd()` 解析（与 esbuild 口径一致，从 platform 根运行时与原来相同）。
- 结果：2298 inputs，`kap-embed.mjs` 11,796,914 字节（旧 11,792,300），`bundle_sha256 5e4ae4a0661754c6953c8541696efc5a56787fdc86e6d35c77069b27c9164557`，`upstream_commit 472192c34c1efad89a369870eff0da0b708ce9bb`，`patch_digest_sha256` = 补丁文件 sha256（`468f1518…`）。导出的 25 个符号与旧制品**完全一致**，`kap-embed.d.mts` 不变。
- 制品文本：`KIMI_CODE_TRUST_WORKSPACE` 0 处（#4059 revert 生效）、`KIMI_CODE_LLM_HEADERS_TIMEOUT_MS` 0 处（Z2 草稿制品为 1 处）。

## 阶段 4：门禁

- `static-surface.test.ts`：锁定提交改为完整的 `472192c34c1efad89a369870eff0da0b708ce9bb`；新增 ZP-23 用例（见阶段 2）。8/8 通过。
- `embed-drift.test.ts`：`START_BOOTSTRAP_SHA256` 改为 `8da4992bdff5d1f89384c44c5a45572e25c7fe8ddf8ba3d4e80ea913647f32a2`（核对 `git diff f67e6398f 472192c34 -- start.ts`：`bootstrap(...)` 段内只多了 `uiCapabilities: [NOTIFY_USER_UI_CAPABILITY]`，embed.ts 第 5 批已有字面量 `'update_panel'`）；NotifyUser 入参键改为 `["message","title"]`。6/6 通过。
- 宿主随之小改：`progress.ts` 读 `title`（截到新增的 `PROGRESS_LIMITS.noteTitle = 120`，与正文合成“标题：正文”一条，合成后仍受 `note` 1000 字上限）——`progress.test.ts` 加 3 条断言；`tool-table.ts` 的 `LOCKED_OFF_TOOLS` 加 `TowerComplete`、`TowerRebase`。
- **反向对照（ZP-23 去掉即失败）**：把 fork 工作区的 `timeout.ts` 换回 2.2.0 原文（暂存区不动）→ 重建制品 → static-surface 7 过 1 败，失败的正是 ZP-23 用例：`actual` 多出 `packages/agent-core-v2/src/human/llm/requester/timeout.ts <- undici`。随后 `git checkout -- timeout.ts` 恢复 → 重建 → 8/8 通过；`kap-embed.mjs`、`inputs.json`、`kap-embed.d.mts`、`timeout.ts` 四个文件的 sha256 与对照前**完全一致**，`BUILD.json` 除 `built_at` 外一致（日志 `scratchpad/i1/reverse-zp23.log`、`hash-{before,after}.txt`）。

## 阶段 5：回归（WT/platform 下逐个文件 `node --test --test-reporter=spec <文件>`，`caffeinate -i`，单文件 20 分钟上限，全部在上限内完成）

| 组 | 文件 | 通过/总数 | 耗时（秒） |
|---|---|---|---|
| kap-host | embed-drift | 6/6 | <1 |
| | exec-router | 10/10 | 16 |
| | host-egress | 7/7 | 1 |
| | p1-kap-host | 15/15（回归批次里跑过一次；之后加了 max_tokens 两条断言，单独重跑 15/15） | 9 |
| | p2-w-domain | 10/10 | 13 |
| | progress（含 NotifyUser 标题断言） | 5/5 | <1 |
| | s2-regressions | 11/11 | 1 |
| | sealed-storage | 2/2 | 1 |
| | search-diff | 5/5 | 15 |
| | static-surface（含 ZP-23） | 8/8 | <1 |
| | **小计** | **79/79** | 约 57 |
| exec-wasm | w-core | 16/16 | 19 |
| | w-legal-tasks | 23/23 | 5 |
| | w-redteam-sealed | 112/112 | 53 |
| | w-redteam | 112/112 | 55 |
| | w-runtime-bundle | 6/6 | 15 |
| | w-s3-regressions-sealed | 43/43 | 26 |
| | w-s3-regressions | 43/43 | 24 |
| | w-sealed | 5/5 | 3 |
| | **小计** | **360/360** | 约 200 |
| 内核 | kap-gate | 1/1 | 2 |
| | kap-a1 | 12/12 | 27 |
| | kap-compaction | 1/1 | 3 |
| | kap-cancel | 5/5 | 5 |
| | onboarding | 1/1 | 2 |
| | p12-redteam | 4/4 | 65 |
| | kap-parity（附加） | 2/2 | 1 |
| | **小计** | **26/26** | 约 105 |

- 合计 465/465，无失败、无跳过、无取消。日志：`scratchpad/i1/reg/*.log`、`summary.txt`。
- 说明：Z2 在影子目录里 kap-a1 只跑到第 8 条；本次在完整 worktree（含 `content/` 产物与 `output/`）里 kap-a1 12 条全过，kap-gate、kap-compaction、kap-cancel、kap-parity 也都过了。没有跑全量 `npm test`。
- 没跑的：桌面运行时包（`scripts/build-runtime.mjs` → `apps/desktop/runtime/kap-host/main.mjs`，不入仓）没有重打，桌面安装包冒烟**未做**。

## 阶段 6：行为变化核对

### 1. 不再发默认 max_tokens（#4091）

- **事实**：2.1.1 在宿主配置下（只有 `max_context_size`，没有 `max_output_size` 与 `modelOverrides.maxCompletionTokens`）走 `resolveCompletionBudget` 的 fallback 分支，`computeCompletionBudgetCap` 取 `max_context_tokens`，再被 `resolveMaxCompletionCap` 截为“窗口剩余量”——即每次请求都发 `max_tokens ≈ 窗口 − 已用`（`f67e6398f:agent-core-v2/src/llm-adapter/model/completion-budget.ts`、`human/llm/protocol/format.ts`）。2.2.0 删掉 fallback，`openai` 类型 provider 未配置上限时不发（只有 `kimi` 类型会补“窗口剩余量”，宿主用的是 `type: "openai"`，`kap-host/src/engine-config.ts:85-90`）。
- **实测**：给 P1 端到端用例加断言“请求体无 `max_tokens`、无 `max_completion_tokens`”。新制品通过；把 vendor 临时换回 2.1.1 制品跑同一用例，**失败：`actual: 131072`**（即测试用窗口 131,072：首个请求时已用量尚未计入），随后恢复新制品并核对哈希一致（`scratchpad/i1/p1-old-artifact.log`）。
- **对闸门/网关预算的影响**：模型请求经宿主出口 → 内核本机服务（`kernel/src/local-server.ts:454,492` 把 `body.max_tokens` 交给 broker）→ `model-broker/src/broker.ts:113` `max_tokens: args.maxTokens ?? 32_000` → 网关。网关按 `输入估算 + max_tokens` 预占点数（`services/legal-gateway/src/gateway.ts:152-156`），按实际用量结算（`:407-408`，`quota.ts` settle 为“余额 += 预占 − 实际”）。
  - 2.1.1：broker 原样转发“窗口剩余量”（生产窗口 262,144 时约 25 万），网关每次请求按约 25 万输出 token 预占（`legal/k3` 4 点/千 token ≈ 1000 点/次），余额较低时会被 402 `quota_exhausted` 误拒——与 broker 注释“避免按模型上限预占配额”（§10.1）相悖。
  - 2.2.0：broker 补 32,000，预占降到约 128 点/次，且 32,000 同时是发往上游的真实输出上限，**预占仍是上界，结算不会超出预占**。闸门（出站闸门、任务令牌）不读 `max_tokens`，无影响。
  - 新的约束：单次回复输出超过 32,000 token 会被截断（`finish_reason=length`，宿主按 `length_truncated` 判部分完成/失败，`kernel/test/v9-defects.test.ts:58-60`）。2.1.1 下上限是窗口剩余量。法律文书单次 3.2 万 token 输出属罕见，接受；若需要更长输出，应在宿主配置写 `max_output_size` 或调 broker 缺省值，而不是让引擎回到“窗口剩余量”。
  - 只有当某条路径**绕过 broker** 直接到网关时，网关才会用 `defaultMaxTokens: 8192` 预占而不给上游上限，可能超出预占；现有嵌入路径都经 broker（宿主出口模型 Agent 只连内核本机套接字），未发现这种路径。
- **结论**：对预算是“由过度预占变为合理预占”，方向正确；已用 P1 断言锁住“引擎不发 max_tokens”，broker 的 32,000 由内核侧负责。

### 2. WaitFor 上限 90 秒、新消息结束等待（#4061）

- **事实**：`WAIT_FOR_MAX_TIMEOUT_S` 由 600（`DEFAULT_BACKGROUND_TIMEOUT_S`）改为 90；工具说明改为“别重复等，优先做别的”，并对重复等待追加警告；子 Agent 另有“结束回合前必须等完需要的后台任务”。宿主锁开 `KIMI_CODE_EXPERIMENTAL_WAIT_FOR=1`，后台 bash 上限 `bash_task_timeout_s: 600`（`engine-config.ts:57,121`）；宿主工具表 `WaitFor: T0`。P1“遍历全部内置工具”用 `timeout: 1`，不受影响（15/15）。
- **闸门**：等待期间不发模型请求；任务令牌的 TTL 按 `wall_ms/timeout_ms + 300 秒`（`kernel/src/executor/kap-agent-client.ts:447`），与 WaitFor 无关。**无影响。**
- **网关预算**：等一个 10 分钟的后台任务，2.1.1 最少 1 次 WaitFor，2.2.0 最多约 7 次（每次 ≤ 90 秒后返回、模型再决定），每次多一个模型步（输入为当前上下文，按上条每次预占 输入 + 32,000）。即“长后台任务期间模型调用变多”，费用上升幅度取决于上下文长度与缓存命中，**未实测**。上游新说明鼓励主 Agent 先结束回合、靠完成通知续上，反而可能减少轮询。
- **工作时限**：宿主 `overdue()` 的工作时限只在“等待确认”期间冻结（`kap-host/src/runtime.ts:373-377`），WaitFor 的时间在两版里都计入工作时限，**口径不变**。主 Agent 在后台任务未完时结束回合，宿主 `settleWhenIdle` 会因 `backgroundRunning` 继续保持运行（`runtime.ts:672-700`），完成通知开启的新回合照常归入同一运行——这一路径是代码核对，**没有专门用例**。
- **新消息结束等待**：追问（同一运行内的新输入）会立即结束 WaitFor，追问响应更快；kap-a1“追问”用例通过。

### 3. 续接后读图（#4154）

- **事实**：上游修复只有 `agent/media/mediaToolsRegistrar.ts` +8 行——在 `IEventDispatcher.hooks.onDidRestore` 上重新 `refresh()` 媒体工具注册。2.1.1 下会话从存储恢复后的首个回合里 `ReadMediaFile` 不在工具表（模型看不到这个工具），2.2.0 起恢复。
- **宿主侧**：同一事项的后续任务复用会话（`GET /api/v1/sessions/:id`，宿主重启后引擎从加密存储恢复会话），恢复后 `ReadMediaFile` 照常经宿主策略（链首、每个 Agent 作用域）裁决，分级 `T0'`、路径参数 `path/file_path` 经事项 broker（`tool-table.ts:41`），跨边界图片仍需确认。修复只让工具“重新可见”，**不新增绕过**。
- **验证**：代码核对；kap-a1“同事项第二任务”通过，但该用例不涉及宿主重启后读图，**“重启续接后读图”未用例验证**。

## 剩余风险

1. **桌面运行时包未重打、未做桌面冒烟**：`apps/desktop/runtime/kap-host/main.mjs` 由 `scripts/build-runtime.mjs` 从 kap-host 源与新制品生成（不入仓），合并后须按既有流程重打并跑一次开放任务。
2. **上游 vitest 在 ZP 下不全绿**（抽查 5 个文件 24/325 失败，全部可归因于 ZP 有意改变的行为）；今后挑上游提交时，只能用本仓 kap 用例做门禁，上游用例只能对照看差集。
3. **32,000 输出截断**：长文书单次输出被截断的概率比 2.1.1 高（上限从窗口剩余量变为 32,000），需在真实模型上观察 `length_truncated` 比例。
4. **WaitFor 轮询带来的额外模型步数与费用**：未实测；主 Agent 提前结束回合、靠完成通知续上的路径没有专门用例。
5. **上游未修缺陷仍在**：#4193（压缩超窗）、#4070（子 Agent 审批不触发钩子）、#2337。
6. **2.2.0 不在上游 main**：下次 rebase 先 `merge-base` 核对发布分支；#4059 的 revert 仍须保留。
7. `kap-host/vendor/kap-embed/inputs.json` 的 raw 路径口径变了（不再含绝对路径）；依赖旧口径的外部脚本（本仓未发现）需要同步。

## 提交

- 分支 `v9.3-kimicode-220`，提交 **`c8eb7f5`**（父提交 `4a3b8de` = v9.3-commercial），14 个文件。未推送、未合并；主工作区与 `.claude/worktrees/v93` 未改动。
- 入仓补丁 blob 的 sha256 与文件一致：`468f1518f0ff78c3e6c89c4376264708e58b822fad09ee486afa34b97fe30f65`。
- 本报告在主工作区 `research/`（该目录本就未跟踪），未随分支提交。
- fork（`WT/platform/third_party/kimi-code`，被 .gitignore 忽略）停在 tag，分支 `zr-2.2.0-i1`，改动全部暂存未提交（导出口径要求如此）；草稿区临时 worktree（kc-pure、kc-verify）已移除。
- 期间 `v9.3-commercial` 已前进到 `04e4fe0`（第13批二～五，4 个提交）；`git diff --stat 4a3b8de v9.3-commercial -- platform/packages/kap-host platform/scripts/build-kap-embed.mjs platform/third_party` 为空，与本分支改动无文件重叠，合入时预计无冲突（未实际合并验证）。
