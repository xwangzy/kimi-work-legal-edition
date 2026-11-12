# 评审 Z2：Kimi Code 2.2.0 增量核查与 rebase 方案

- 日期：2026-10-19；评审范围：`@moonshot-ai/kimi-code@2.1.1`（f67e6398f，锁版）→ `@2.2.0`（472192c34，2026-10-14）→ main（47002256a，2026-10-19）
- 实验位置（全部在草稿区，未改动仓库任何已有文件）：`/private/tmp/claude-501/-Users-wangzeyu-Documents-Coding-Kimi-Work-Legal/07bf89f8-fea1-4be3-a194-1cc7c60dce61/scratchpad/z2/`
  - `kc/`：`git clone --no-hardlinks platform/third_party/kimi-code` + `fetch https://github.com/MoonshotAI/kimi-code.git --tags`；分支 `zr-2.2.0`
- 证据写法：提交号用 9 位短号；`文件:行号` 指 2.2.0（或注明版本）；“未验证”表示本次没有实测。

## 一页结论

1. **可以 rebase 到 2.2.0，量不大。** 2.2.0（`472192c34`，发布分支 tag，**不在 main 上**）相对锁版 36 个提交。我方补丁所在区域（权限策略、执行前钩子、web、os、_base、引导、事件日志）在 2.2.0 **零改动**。v9.2 列的 4 个待回移项（续接后读图 #4154、不发默认 max_tokens #4091、首包头超时 #4092、WaitFor 90 秒 #4061）**全部已在 2.2.0 内**，不用再回移。
2. **补丁处置。** #4059 revert 干净。ZP 共 17 项：**14 项干净应用；1 项冲突已解决**（ZP-17 `tower/protocol/git.ts`，上游给 `GitError` 加了退出码，保留封闭实现）；**1 项需小改**（ZP-22 原写法留下不可达代码，2.2.0 的 `tsc` 报 2 个错误，已改写）；**1 项删除**（ZP-5/6，SDK 路径已退役）；上游已修可删 0 项；需重新设计 0 项。另外**建议新增 1 项 ZP-23**（见第 4 条）。补丁里 20 处注释已全部清掉，上游的无注释 lint、`tsc`、`oxlint` 都是 0 错误。
3. **新补丁文件**：`scratchpad/z2/kimi-code-2.2.0-zhongruan.patch`，**sha256 `d992ee242dc6b0e96580a32468d854260b721e93cf50c5f618f773a21df7d942`**（相对 2.2.0 tag，含 #4059 revert，共 44 个文件）。在干净的 2.2.0 上应用，结果和草稿分支的树逐字节一致（tree `24b42d30…`）。
4. **最大的新风险（N-1）。** 新增的 `human/llm/requester/timeout.ts` 会在设了 `KIMI_CODE_LLM_HEADERS_TIMEOUT_MS` 时，给模型请求单独建一个 undici 调度器，**绕过宿主全局出口**（不换任务令牌）。现在因为内核只给宿主白名单环境，这段代码不会触发；但静态面用例**查不出它**。处置：加补丁 ZP-23 把它封住；首包头超时改由宿主 `HostEgressDispatcher` 的模型 Agent 设置 `headersTimeout`。
5. **嵌入制品能构建。** 正式脚本把路径写死了，所以复制到草稿区、改成读环境变量后构建：2297 个输入，11,745,757 字节（比旧制品小 46.5 KB，`tar` 和 kaos 依赖没了）。**导出的 25 个符号完全一致**。进程和网络入口集合与旧制品相同。2.2.0 没有新增第三方依赖，许可证仍是 MIT。
6. **门禁试跑**（影子目录，换新制品）：static-surface 7 条过 6 条、embed-drift 6 条过 4 条，失败的 3 条都在预期内：锁定提交、`start.ts` 种子段摘要（上游加了 `uiCapabilities`，embed 里早已有）、NotifyUser 入参新增 `title`。P1 等 kap-host 用例 40/40 通过，P2 5/5 通过。内核 kap-* 用例第一次失败，原因是影子目录里没复制 `content/`、`output/`，before 钩子报 `lawdb_invalid`（法规库签名公钥缺失），新旧制品一样失败。补上这两个目录后，**kap-a1 的前 8 条用新制品全部通过**（开放任务端到端、工作区产物入库、方法模板、追问、过程事件、同事项第二任务、取消与确认卡同时到达、落盘加密第 1 步）。kap-a1 余下几条、kap-compaction、kap-gate 没跑完就被我终止了，**未验证**。
7. **关注议题。** #4193（压缩超窗）、#2337（配置权限规则不生效）都是 **open 状态的 PR，没合并**；#4070（子 Agent 审批不触发钩子）**仍 open**。#4053 其实是 Changesets 自动发版 PR，v9.2 里大概率引错了编号。#4059 **仍在 2.2.0 和 main 里**，台账要求先 revert 的闸门继续有效。
8. **工作量与建议。** 约 5～7 人日。基线选 **2.2.0 tag**，不选 main。main 上只建议挑 #4066（子 Agent 工具描述对齐），可选 #4239。三大风险：R1 首包头超时调度器绕过出口；R2 内核 kap 用例还没在真实环境跑过（还要确认不再发 `max_tokens` 对闸门和网关预算的影响）；R3 压缩缺陷 #4193 仍在。

---

## 1. 2.1.1 → 2.2.0 增量（及 2.2.0 → main 值得关注的提交）

### 1.1 版本关系（先说清楚，影响 rebase 基线选择）

- 2.2.0 tag `472192c34` **不是** main 的祖先：`git merge-base --is-ancestor 472192c34 up/main` 为否，二者分叉点 `c69bd6c5a`（10-13）。上游从 #4217 起改为“隔离发布分支”出版本（`d1c3b048f ci: publish core releases from isolated release branches`），main 上随后有 `a9e764db6 chore: sync release 2.2.0 back to main`。
- 因此 main 上有若干**早于 2.2.0 日期、却不在 2.2.0 里**的提交（如 `e4c99a3ba #4190`、`3f0857eb7 #4188`、`f28c51c01 #4210`、`0327e8e9a #4171`）。rebase 基线应选 **2.2.0 tag**（可复现、有 CHANGELOG），main 上需要的提交按需 cherry-pick。
- f67e6398f..472192c34 共 36 个提交；472192c34..main 另有 25 个（含同步回 main 的提交）。全仓 154 个文件、+7095/−1444（不含 dist-web 资源的话 agent-core-v2 + kap-server 是主体）。

### 1.2 v9.2 待回移项：全部已在 2.2.0 内

| 待回移项 | 上游提交 | 状态 | 对本产品的含义 |
|---|---|---|---|
| 续接后读图 | `419aced0e` #4154 restore media tools after session resume | 在 2.2.0 | 续接后首轮 ReadMediaFile 恢复；宿主 T0' 分级不变 |
| 不发默认 max_tokens | `21406fb4c` #4091 omit completion token cap unless explicitly configured | 在 2.2.0 | 宿主生成的模型配置不写输出上限（`kap-host/src/engine-config.ts:96-109` 只有 `max_context_size`），rebase 后引擎不再发默认 `max_tokens`。闸门若依赖请求体里的 `max_tokens` 做预算估计，需要改为闸门侧兜底（未验证闸门是否依赖） |
| 首包头超时 | `c151d5a3d` #4092 `KIMI_CODE_LLM_HEADERS_TIMEOUT_MS` | 在 2.2.0，**不能按上游方式启用** | 见 §1.4 风险 N-1：设了该变量，模型请求改用引擎自建的 undici `Agent`/`EnvHttpProxyAgent`，**绕过宿主全局调度器** |
| WaitFor 90 秒 | `20a2cea72` #4061 cap WaitFor at 90s and let new input end the wait | 在 2.2.0 | 宿主 `WAIT_FOR` 开（`engine-config.ts:49,57`），行为随之变化：超过 90 秒的 `timeout` 入参被拒（模型会改写），新消息立即结束等待 |

### 1.3 关注议题核对（GitHub API 2026-10-19 实查）

| 编号 | 实际是什么 | 状态 | 结论 |
|---|---|---|---|
| #4193 | PR：`fix(agent-core-v2): prevent context overflow from accumulated tool results`（同一 step 多个大工具结果把下一次请求推过窗口，压缩请求本身也超限，`[compaction.failed]`） | **open，未合并**；2.2.0 与 main 均不含 | 未修。宿主侧须继续靠 Read 输出上限、执行域输出上限与 kap-compaction 用例兜底 |
| #2337 | PR：`fix(agent-core-v2): honor configured permission rules`（修 #2100：配置文件里的权限规则不进入生效规则视图） | **open，未合并** | 未修。本产品不依赖上游配置规则（ZP-4 宿主策略在链首、ZP-14 清空默认放行），影响为零；但说明不要把“配置 deny 规则”当纵深 |
| #4053 | **不是缺陷议题**：Changesets 自动生成的 `ci: release packages` PR，2026-10-14 关闭（被 #4220 取代） | closed | v9.2 文中的 #4053 疑为误引，建议核对原意（可能想写 #4054 “NotifyUser nudges in hosts without the update panel”，该项已在 2.2.0：`4fbe06544`） |
| #4070 | issue：后台子 Agent 的审批提示不触发 `PermissionRequest` 钩子，审批挂起期间 wire.jsonl 无记录 | **open** | 未修。本产品审批走宿主策略 + kap-server approvals 路由，不依赖外部钩子；但“子 Agent 审批挂起不落事件”会影响过程快照与审计的完整性——需用 P1 子 Agent 审批用例确认宿主是否能看到挂起中的审批（未验证） |
| #4059 | `1f6f0b1fa` `KIMI_CODE_TRUST_WORKSPACE` 环境变量让工作区可信 | **仍在 2.2.0 与 main**：`agent-core-v2/src/workspace/workspaceTrust/workspaceTrustService.ts:14-19,46`、`app/mcpRegistry/mcpRegistryService.ts:13,51` | 台账闸门成立：rebase 时先 revert。实测 `git revert 1f6f0b1fa` 在 2.2.0 上**干净**（14 个文件，+8/−126）。宿主另有纵深：`kap-host/src/main.ts:117` `delete process.env.KIMI_CODE_TRUST_WORKSPACE`，内核拉起宿主时只给 PATH 与代理变量（`kernel/src/executor/kap-agent-client.ts:219-229`） |

### 1.4 安全相关增量（逐条判断）

- **N-1（高，新出网路径）**：`agent-core-v2/src/human/llm/requester/timeout.ts:1` 新增 `import { Agent, EnvHttpProxyAgent } from 'undici'`；`:74-123` 在设了 `KIMI_CODE_LLM_HEADERS_TIMEOUT_MS` 时为模型请求构造**独立调度器**（有代理变量则 `EnvHttpProxyAgent`，否则直连 `Agent`），三个请求器都用：`bases/anthropic/requester.ts:90-99`、`bases/openai/requester.ts`、`bases/openai-responses/requester.ts:56-58`（`fetchOptions: { dispatcher }`）。宿主的出网控制是 `setGlobalDispatcher(new HostEgressDispatcher…)`（`kap-host/src/main.ts:293`）+ 黑洞代理（`kap-agent-client.ts:222-225`）；独立调度器**不经全局调度器**，也就不经“按会话换任务令牌”。
  - 当前不触发：变量默认不设；内核给宿主的环境是白名单（不含该变量）。即使误设，`HTTP_PROXY=http://127.0.0.1:9` 让 `EnvHttpProxyAgent` 连黑洞，失败关闭。
  - 但这是**第一方源码新增的、可绕过宿主出口的调度器构造点**，静态面用例**抓不到**：`build-kap-embed.mjs:74` 的 `NETWORK_MODULES` 只认 `node:net/http/...`，`undici` 不在其中；undici 本身早已在第三方白名单里。
  - 处置：新增补丁 **ZP-23**（`getLlmHeadersTimeoutDispatcher` 恒返回 `undefined`，或 `resolveLlmHeadersTimeoutMs` 恒返回 `undefined`），宿主若要首包头超时，在 `HostEgressDispatcher` 的 `modelAgent`（`host-egress.ts:145`）上设 `headersTimeout`（零上游补丁）；static-surface 增一条“制品中 `KIMI_CODE_LLM_HEADERS_TIMEOUT_MS` 解析被封闭”的文本断言，并把“第一方源码 `new Agent(`/`new EnvHttpProxyAgent(`/`ProxyAgent(`”加入扫描。
- **N-2（中，权限面）**：`agent/permissionPolicy/**` 在 2.1.1→2.2.0 **零改动**（`git diff --stat` 为空），ZP-4/ZP-4b/ZP-14 的锚点不动。main 上 `6e7cc909d #4250` 改了 `git-control-path-access-ask.ts`、`sensitive-file-access-ask.ts`（`dangerous_command_guard=false` 关闭全部内置询问策略）——宿主策略在链首、永不弃权，不受影响；但若 rebase 到 main，宿主生成配置不要写 `dangerous_command_guard`（默认即可）。
- **N-3（中，新工具）**：新增 `TowerComplete`、`TowerRebase`（`features/tower/tools/complete/completeTool.ts`、`rebase/rebaseTool.ts`，#4074）。Tower 由宿主锁关（`engine-config.ts:45,53`），宿主工具表外一律拒绝（`kap-host/src/tool-table.ts:5`），所以默认不可用；建议把二者补进 `LOCKED_OFF_TOOLS`（`tool-table.ts:63-77`）以免日后被误加白。2.2.0→main 无新增内置工具。
- **N-4（低）**：Tower 新增 `features/tower/bashGuard.ts`（523 行）与 `protocol/missionGate.ts`；`protocol/git.ts` 的 `execFile` 增加了退出码字段（这是 ZP-17 唯一冲突点，见 §2）。Tower 锁关，制品内仍会打包这些代码。
- **N-5（低）**：新增 `workspace/workspaceTrust/trustDisclosureService.ts`（312 行，#4056），在 program 代际里构造（`program/program.ts:305`），读取经 `runtime.fs`（即宿主 `IHostFileSystem` 种子 → 事项 broker），不新增直接 fs 访问。
- **N-6（低）**：`mcpCore/config-schema.ts` 去掉 `executor: 'kaos'`（#4184），`packages/kaos` 整包删除（含 `ssh2` 依赖）——制品与依赖面**变小**。
- **N-7（信息）**：`kap-server/src/start.ts` 的 `bootstrap(...)` 段新增 `uiCapabilities: [NOTIFY_USER_UI_CAPABILITY]`，与 ZP-19 `embed.ts` 已有的 `uiCapabilities: ['update_panel']` 一致；但 `embed-drift.test.ts:34` 的 `START_BOOTSTRAP_SHA256` 必然变化（预期失败，核对后更新常量）。

### 1.5 进程 / 网络入口（static-surface 视角）

- 第一方源码直接导入 `child_process/net/tls/dns/http/https/http2/worker_threads/cluster` 的集合：fork（2.1.1+补丁）30 行 → 2.2.0+补丁 26 行，**差集只有删除**（`packages/kaos/*` 4 行）。没有新增第一方进程/网络模块导入（命令：对两棵树 `grep -rnE "(from|import\() *'(node:)?(child_process|net|…)'" packages --include='*.ts'` 后 diff）。
- 第一方 `fetch(` / `new WebSocket(` / `undici` 出现点：唯一新增是上面的 `timeout.ts`（N-1）。
- kap-server 新路由：`routes/remoteControl.ts`（+288，设备管理与删除 #4169/#4192）、`routes/oauth.ts`（+135，遥控设备 OAuth）、`protocol/rest-remote-control.ts`（+58）。**均不在嵌入白名单的九组路由内**（`embed.ts:29-37,164-177`），嵌入形态不注册；`remote-control` 包新增 `device-client.ts`（+317），只被 `start.ts` 引用，嵌入入口不导入（以制品 inputs.json 为准，见 §3）。
- 嵌入白名单九组路由在 2.2.0 的改动：只有 `routes/prompts.ts`（+8，技能激活与 UserPromptSubmit 钩子部件过滤，#4081/#4165）和 `services/transcript/*`（同一主题），不新增端点。
- `fs:list` 新增 `allow_ignored_globs`（`workspace/workspaceFs/fsService.ts`，#4058）：fs 路由不在嵌入白名单，宿主不暴露。

### 1.6 遥测、配置键、实验开关

- 遥测：`app/telemetry/events.ts` 新增 `NotifyUserNudgeShownEvent`、`NotifyUserSentEvent`，缓存探针增加 `tools_match/system_prompt_match/parent_input_tokens/parent_request_gap_ms`（#4179）。默认值与上报通道未变（未发现新的上报端点）；宿主用 `noopTelemetryService` 种子 + 配置关闭（`vendor-entry/kap-embed-entry.ts:23-24`），新事件同样进 noop。
- 环境变量（agent-core-v2 + kap-server 源码中 `KIMI_CODE_*` 全集）2.1.1→2.2.0 只多两个：`KIMI_CODE_LLM_HEADERS_TIMEOUT_MS`（N-1）、`KIMI_CODE_TRUST_WORKSPACE`（#4059，revert 后消失）；2.2.0→main 无变化。
- 实验开关：`features/notify/flag.ts` 只改了描述文字，开关编号与环境变量名不变（drift 用例 S5B-14 锁定项不受影响）；上游 NotifyUser 默认仍是关（CHANGELOG “off by default”），宿主锁开不变。
- 配置键：MCP stdio `executor` 只剩 `local`；main 上 #4210 新增“延迟披露 MCP 工具”的全局默认键、#4250 `dangerous_command_guard` 语义扩大（均不在 2.2.0）。

### 1.7 许可证与依赖

- 根 `LICENSE` 为 MIT（Copyright 2026 Moonshot AI），2.1.1→2.2.0→main **无改动**；根 `package.json` `"license": "MIT"`。
- `pnpm-lock.yaml` 2.1.1→2.2.0：**只有删除**（−65 行：`packages/kaos`、`ssh2@1.17.0`、`asn1`、`bcrypt-pbkdf`、`tweetnacl`、`@types/ssh2`、`@types/node@18`、`undici-types@5`），无新增第三方依赖；2.2.0→main 锁文件 +4/−1（未逐项核对许可证，见 §3）。
- 版本号：agent-core-v2 0.4.3→0.5.0、kap-server 0.2.3→0.2.4、remote-control 0.0.0→0.0.1。

### 1.8 2.2.0 → main 值得关注（不建议整体跟进，按需挑）

| 提交 | 内容 | 建议 |
|---|---|---|
| `85077a419` #4066 | 子 Agent 工具描述与实际可用性对齐 | 建议 cherry-pick（减少子 Agent 调用不可用工具被宿主拒绝的空转） |
| `e4c99a3ba` #4190 | 区分“会话不可用工具”，解释 select_tools 失败 | 可选（select_tools 被锁关） |
| `da5918c0c` #4239 | 提醒 Agent 维护待办清单 | 可选（宿主“进展”面板读 TodoList） |
| `c1459a618` #4242 | 钩子在会话工作目录运行 | 不需要（外部钩子不启用） |
| `6e7cc909d` #4250 | `dangerous_command_guard=false` 关闭全部内置询问策略 | 不跟进（宿主策略在链首；跟进会改 ZP-14 邻近文件） |
| `f28c51c01` #4210、`3f0857eb7` #4188、`0327e8e9a` #4171、`9f0693bec` #4209、`47002256a` #4224 | MCP 延迟披露默认、插件技能限定名、模型迁移元数据、托管模型 /models、无项目默认工作区 | 不跟进（与嵌入形态无关或触及 ZP-2 邻近的 `workspaceMcpConfigService.ts`） |
| `18c6d6427` #4019 | /reload 后通知外部变更 | 不需要（宿主不用 /reload） |

## 2. 逐条补丁处置（在草稿克隆 `zr-2.2.0` 上实测）

### 2.1 操作记录

```
git checkout -b zr-2.2.0 472192c34
git revert --no-edit 1f6f0b1fa                       # #4059：干净，14 个文件 +8/−126
git apply --3way kimi-code-f67e6398f-zhongruan.patch  # 33 个文件：32 个干净，1 个冲突（tower/protocol/git.ts）
# 解冲突、删 ZP-5/6、删补丁注释、修 lint 与类型错误（见 2.3）
git reset --soft 472192c34                            # HEAD 回到 tag，revert 也进入补丁
git diff --cached --binary 472192c34 > kimi-code-2.2.0-zhongruan.patch
```

- 复核：在干净的 2.2.0 工作树上 `git apply --check` 通过，应用后 `git write-tree` = `24b42d30d4f4843885c403f5827af5d7adb4ebff`，与 `zr-2.2.0` 工作树**完全一致**。
- 质量闸：`tsc --noEmit`（agent-core-v2、kap-server）**0 错误**；上游 `scripts/check-no-comments.mjs` **OK（1756 个文件）**（处理前 20 处违规）；`oxlint` 对 29 个改动的 .ts 文件 **0 error**（处理前 14 处 error：ZP-16/ZP-20 留下的未用导入与常量）。

### 2.2 新补丁文件

- 路径：`/private/tmp/claude-501/-Users-wangzeyu-Documents-Coding-Kimi-Work-Legal/07bf89f8-fea1-4be3-a194-1cc7c60dce61/scratchpad/z2/kimi-code-2.2.0-zhongruan.patch`
- **sha256 `d992ee242dc6b0e96580a32468d854260b721e93cf50c5f618f773a21df7d942`**，84,847 字节；相对 tag `472192c34` 的 44 个文件（42 改、2 新增：`hostPolicy.ts`、`embed.ts`），+490/−589（删除多是 #4059 revert 与 ZP-20 下载代码）。
- 同一构建算出的 `BUILD.json.patch_digest_sha256` 也是 `d992ee24…`（`build-kap-embed.mjs:88-96` 的算法在 HEAD=tag、全部改动已暂存时恰好等于补丁文件摘要）。
- 旧补丁 `kimi-code-f67e6398f-zhongruan.patch` 的文件 sha256 是 `e06a9a3d…7f0b`，旧 `BUILD.json` 的 patch_digest 是 `d9ac5764…`——两者算法不同（后者 = `git diff HEAD` + 未跟踪 .ts），台账里写的是哪一个需要说清楚（建议今后两者一致，做法同上）。

### 2.3 逐条判定

| 补丁 | 2.2.0 上的结果 | 处置与说明 |
|---|---|---|
| #4059 revert（台账闸门） | **干净 revert** | 补丁里含 revert；另保留宿主 `main.ts:117` 的 `delete process.env.KIMI_CODE_TRUST_WORKSPACE` 作纵深 |
| ZP-1 `agentRoots.ts` | 干净应用 | `workspaceAgentProfileLoader/**` 在 2.2.0 无改动。注意 #4152 让 fork 子 Agent 继承父级可用 Agent 类型（含自定义）——项目级根仍为空，自定义只来自宿主 `agentFiles`，不受影响 |
| ZP-2 `workspaceMcpConfigService.ts` ×2 | 干净应用 | 2.2.0 无改动；**main** 上 #4210 改了同一文件（+1 行），跟进 main 时会碰到 |
| ZP-3 `marketplace.ts` | 干净应用 | — |
| ZP-4 `hostPolicy.ts` + `permissionPolicyService.ts` | 干净应用 | `permissionPolicy/**` 2.2.0 零改动；策略链首位插入点不变 |
| ZP-4b `beforeToolExecuteEvent.ts` | 干净应用 | `toolExecutor/**` 2.2.0 零改动；制品断言 `if (event.finalAllowed)` 不存在仍成立 |
| ZP-5/6 `node-sdk/*` | **删除** | SDK 宿主已退役：仓库内仅 `apps/desktop/runtime/kap-host/main.mjs` 出现 `extraSeeds`，来源是 `bootstrap.ts:146` 的形参名而非 node-sdk；旧制品 `inputs.json` 中 node-sdk 输入数为 0。三处文件恢复为上游原样 |
| ZP-11 web 四处 + 测试 | 干净应用 | `app/web/**` 2.2.0 零改动；删去补丁里 2 处注释（JSDoc 与行注释） |
| ZP-14 默认放行清空、git 写入弃权 | 干净应用 | — |
| ZP-16 `environmentProbe.ts`、`shellPathBridge.ts` | 干净应用 | **顺带修 lint**：`shellPathBridge.ts:1` 未用的 `existsSync` 导入删除 |
| ZP-17 `fileLaunch.ts`、`runHook.ts`、`tower/protocol/git.ts` 等 | **冲突已解决（1 处）** | 上游 #4074 在 `git()` 的 `execFile` 回调里给 `GitError` 加了第三参（退出码）。按补丁意图取“ours=补丁侧”：整段 `execFile` 仍替换为 `throw new GitError(args, 'direct process execution is disabled')`；`GitError` 的 `exitCode?` 是可选参，不需改。`import { execFile } from 'node:child_process'` 已被补丁删除，文件内无其他 `execFile`/`spawn` |
| ZP-18 指令与技能源（4 文件） | 干净应用 | `skillService.ts` 在 2.2.0 有 +49/−… 改动（#4165 技能提示词统一），未触及 root/user 文件源；main 的 #4188（插件技能限定名）未进 2.2.0 |
| ZP-19 `embed.ts`、`kap-server/package.json` | 干净应用（新文件） | 与 2.2.0 `start.ts:202-217` 的 `bootstrap(...)` 对照：上游新增的 `uiCapabilities: [NOTIFY_USER_UI_CAPABILITY]` 已在 `embed.ts:119`（字面量 `'update_panel'`，drift 用例 S5B-14 要求字面量，保持）；`agentFiles`、`trustedInstructionsDir` 是嵌入专有键。上游 `start.ts` 新增的 `RemoteControlDeviceClient`（`start.ts:239-243`）与遥控 OAuth 路由不复刻（有意省略）。删去 1 处 JSDoc |
| ZP-20 `rgLocator.ts`、`index.ts` | 干净应用 | **顺带修 lint**：删除下载代码遗留的 10 个未用导入与 3 个常量（`RG_VERSION`、`DOWNLOAD_TIMEOUT_MS`、`RG_ARCHIVE_SHA256`），制品因此不再打包 `tar`（`npm:tar/dist/esm/index.min.js` 从 inputs 消失）；删去 6 处注释 |
| ZP-21 `callback-server.ts` | 干净应用 | 删去 4 行注释 |
| ZP-22 `promptMedia.ts` | 干净应用，**需小改** | 原补丁在函数中插入无条件 `throw`，其后代码不可达，2.2.0 的 kap-server `tsc` 报 2 个 TS2345（`promptMedia.ts:57,60`，`path` 在不可达代码中失去收窄；同一写法在锁版上大概率也报，未验证）。改写为：遇到任何按路径的部件即抛同一错误，删除不可达代码与随之不用的 `isAbsolute`、`isSensitiveFile` 导入。错误文本不变，static-surface 断言照常命中 |
| ZP-9a 事件日志 `JournalIo` | 干净应用 | `transport/ws/v1/**` 2.2.0 零改动；删去 3 处 JSDoc |
| 补丁注释（复核 S5B-16） | **已清理** | 20 处全部移除，原文意图以本表与台账为准；fork 的无注释 lint 通过 |
| **新增 ZP-23（建议）** | 未实施 | `human/llm/requester/timeout.ts`：封闭 `KIMI_CODE_LLM_HEADERS_TIMEOUT_MS` 的独立调度器（见 §1.4 N-1）。本补丁文件**未包含** ZP-23，需评审后加入 |

统计：**#4059 revert 1 条干净；ZP 共 17 项（按台账行计，ZP-5/6 算 1 项）：干净应用 14、冲突已解决 1（ZP-17）、干净但需小改 1（ZP-22）、删除 1（ZP-5/6）；上游已修可删 0；需要重新设计 0；建议新增 1（ZP-23）。**

## 3. 能否构建嵌入制品

### 3.1 构建脚本能力

- `platform/scripts/build-kap-embed.mjs:15-17` 把源目录与输出目录**写死**为 `root/third_party/kimi-code` 与 `root/packages/kap-host/vendor/kap-embed`（`root` 由脚本自身位置推出），没有参数或环境变量可改。`:76` 的 inputs 路径以 `root` 为基准、`:84,90` 以 `KC` 求上游提交与补丁摘要。
- 做法：把脚本复制到草稿区 `z2/tools/build-kap-embed-z2.mjs`，只改 4 处：esbuild 改为绝对路径导入（`platform/node_modules/esbuild`，0.28.2），`root/KC/outDir` 改读 `KWL_PLATFORM_ROOT/KWL_KC/KWL_OUT`，inputs 路径改为 `"third_party/kimi-code/" + relative(KC, …)`（保持 static-surface 的 `strip()` 口径）。入口文件 `packages/kap-host/vendor-entry/kap-embed-entry.ts` 与 `scripts/stubs/google-auth-library.mjs` 只读引用。**建议**正式脚本也接受这三个环境变量（缺省不变），便于 CI 做“候选上游”构建。
- 依赖：把锁版 fork 已安装的 `node_modules`（根与各包）`cp -cR` 克隆到草稿克隆；pnpm 的工作区链接是相对符号链接，指向草稿克隆自身的包。**2.2.0 无新增第三方依赖**（锁文件只删不增），无需联网安装。

### 3.2 结果

```
[build-kap-embed] 2297 inputs → z2/out/kap-embed.mjs (11.7 MB)
upstream_commit 472192c34c1efad89a369870eff0da0b708ce9bb
bundle_sha256  2041a186eb82370057d6e9a8f449c803b2e425fd1c56f6c4027db992227be573
```

| 对比项 | 旧制品（f67e6398f） | 新制品（2.2.0 + 新补丁） |
|---|---|---|
| 字节数 | 11,792,300 | 11,745,757（−46,543） |
| inputs | 2284 | 2297 |
| 导出符号 | 25 个 | **25 个，完全一致**（`createEmbeddedServer`、`IHostProcessService`…`noopTelemetryService`） |
| `embed.ts` 入口 | — | 与 fork 版相同（仅删 1 行 JSDoc），九组路由不变 |
| `node:child_process` 导入者 | 仅 `hostProcessService.ts`，文本出现 1 次 | 相同 |
| worker_threads/cluster 导入者 | 5 个 | 相同 |
| 第一方直接网络导入 | 0 | 0 |
| 第三方网络入口 | 17 个 | 相同 |
| rg 下载 / 本机直连抓取 / OAuth 回调 | 均不在 | 均不在 |
| ZP-4b、ZP-22 文本断言 | 成立 | 成立 |
| `KIMI_CODE_TRUST_WORKSPACE` 文本 | 不在 | 不在（revert 生效） |
| `KIMI_CODE_LLM_HEADERS_TIMEOUT_MS` 文本 | 不在 | **在**（N-1，ZP-23 前） |
| `tar` 包 | 在 | 不在 |
| remote-control、kaos 输入 | 0 | 0 |

- 新增的真实输入（排除 raw: 绝对路径前缀差异）：`trustDisclosureService.ts`、`contextMemory/hookParts.ts`、`requester/timeout.ts`、`session/agentLifecycle/forked.ts`、Tower 的 `bashGuard.ts`、`missionGate.ts`、`tools/delivery.ts`、`status/statusReader.ts`、`complete/*`、`rebase/*`。
- 未写入 `packages/kap-host/vendor`。

### 3.3 门禁用例试跑（影子目录，不动仓库）

影子目录 `z2/shadow/`：`cp -cR` 克隆 platform 的 `package.json/tsconfig*/node_modules/packages/scripts/services`，`third_party/kimi-code` 指向草稿克隆，`packages/kap-host/vendor/kap-embed` 换成新制品。只跑指定用例：

| 用例 | 结果 | 说明 |
|---|---|---|
| `static-surface.test.ts`（7 条） | 6 过 1 败 | 败的是“制品锁定上游提交 f67e6398f”——预期，改常量为 `472192c34` |
| `embed-drift.test.ts`（6 条） | 4 过 2 败 | ① `START_BOOTSTRAP_SHA256` 变为 `8da4992bdff5d1f89384c44c5a45572e25c7fe8ddf8ba3d4e80ea913647f32a2`（上游加了 `uiCapabilities`，embed 已有，核对后更新常量）；② NotifyUser 入参键由 `[message]` 变为 `[message, title]`（#4153/#4159 新增可选一行标题）——需 `progress.ts` 决定是否展示 `title` 后更新登记表 |
| `p1-kap-host`、`progress`、`s2-regressions`、`host-egress`、`sealed-storage` | **40/40 过** | 嵌入引擎端到端回合、P1 裁决来源（遍历全部内置工具含子 Agent/集群）、端口、路由、ZP-18 均通过 |
| 内核 `kap-a1`、`kap-gate`、`kap-compaction`、`kap-cancel`、`kap-parity`；`p2-w-domain` | P2 **5/5 过**；kap-a1 **前 8 条过**；其余**未验证** | 见 §3.4 |

### 3.4 内核 kap 用例排障记录

- 第一次：kap-a1 的 before 钩子失败，`failureType: 'hookFailed'`、`code: 'lawdb_invalid'`、“未找到内容签名公钥：请先运行 npm run build:lawdb…”。之后进程挂在 after 阶段，超过 13 分钟，手动终止。
- 对照：在 `shadow-old/`（旧制品 f67e6398f）跑同一条用例，报**同样的错误**（`a1-old.log`）。可见是影子环境缺前置文件，不是 2.2.0 造成的。
- 补上 `content/`、`output/`（APFS 克隆）后用新制品重跑（`k-new.log`）：kap-a1 的 `ok 1`～`ok 8` 全部通过，包括“A1 经 kap-host 完成开放任务”“追问”“过程事件与流式回复”“取消与确认卡同时到达”“落盘加密第 1 步”。随后我把进程终止了，所以 kap-a1 余下的落盘加密第 2 步、撤权擦除，以及 kap-compaction、kap-gate、kap-cancel、kap-parity 都**未验证**，要在步骤 7 补跑。
- 在“A1 经 kap-host 完成开放任务”通过的前提下，不发默认 `max_tokens`（#4091）至少没有让 mock 网关链路失败。真实闸门和网关是否拿 `max_tokens` 估算预算，**未验证**。

## 4. 能力矩阵（Kimi Code 能力 × 本产品集成状态）

口径：“完整”= 上游能力原样可用（台账 `native`）；“部分”= 可用但受宿主策略约束或经我方补位（`policy_limited` / `adapted`），或已接线但设备台账仍记 `pending`；“未集成”= 不在嵌入面；“有意关闭”= 方案要求关闭（`disabled`）；“有问题”= 存在已知缺陷或未闭环风险。主证据：`kap-host/src/capabilities.ts:60-332`（`capabilityLedger`，下称“台账”）、`tool-table.ts`、`policy.ts`、`engine-config.ts`、`embed.ts` 与 P1/P2 用例。最后一列是 2.2.0 带来的变化（“—”表示无变化）。

| 能力 | 本产品状态 | 证据 | 2.2.0 带来的变化 |
|---|---|---|---|
| Agent 循环（流式、工具调用、用量） | 完整 | 台账“模型流式输出”`native`；P1“端到端：嵌入引擎经种子与宿主出口跑通一个回合”（新制品下仍过） | #4091 不再默认发 `max_tokens`（宿主未配输出上限）；#4092 首包头超时**不能直接用**（N-1，需 ZP-23 + 宿主 `modelAgent.headersTimeout`） |
| 计划模式 | 部分（审批走业务审批卡） | `tool-table.ts` `EnterPlanMode: UI`、`ExitPlanMode: plan`；`engine-config.ts` `default_permission_mode: "manual"`；ZP-4b | 无改动（`toolExecutor/**`、`permissionPolicy/**` 零 diff） |
| 内置工具清单 | 部分（表内 28 个，表外一律拒绝） | `tool-table.ts:32-61`、`:5` | 新增 `TowerComplete`、`TowerRebase`（锁关、表外拒绝；建议补进 `LOCKED_OFF_TOOLS`） |
| 权限策略 | 部分（宿主策略链首、上游默认放行清空） | ZP-4、ZP-14；P1“裁决来源：遍历全部内置工具（含子 Agent 与集群作用域）”（新制品下仍过） | — ；#2337（配置规则不生效）仍未合并，不影响 |
| Skills | 部分（只加载可信区签名方法包） | 台账“技能”`policy_limited`；ZP-18；P1 ZP-18；`engine-config.ts` `builtin_product_skills: false` | #4165 技能激活部件在提示词快照/转录中改为标注后过滤（`routes/prompts.ts`、`transcriptService.ts`），宿主读 `Skill` 入参键不变（drift 通过） |
| 子 Agent | 部分（低价模型、按成员计预算、禁 fork） | 台账“子 Agent”`pending`；`policy.ts:328-334`；K7-4 | #4152 fork 子 Agent 继承父级 Agent 类型——宿主拒绝 fork，不受影响；main #4066 工具描述对齐（建议挑） |
| Agent 集群 | 部分 | 台账“Agent 集群”`pending`；`KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY=3` | — |
| MCP | 部分（只有宿主下发的法律 MCP；项目级不加载；OAuth 关闭） | ZP-2、ZP-21；`engine-config.ts` `mcpServers.legal` 经 `tools.kwl` | #4184 删 `executor: 'kaos'`（宿主未用）；main #4210 延迟披露默认值（不跟） |
| 文件系统与工作区 | 部分（三区 broker；Grep/Glob 宿主内检索） | 台账“文件读取与搜索”“文件写入”；`seeds.ts`；ZP-20 | `fs:list` 增 `allow_ignored_globs`（fs 路由不在嵌入面）；`trustDisclosureService` 经宿主 fs 种子读取 |
| 工作区信任 | 有意关闭（指令只从可信区） | ZP-18；`main.ts:117` | #4059 环境变量后门**进入 2.2.0**，补丁 revert；#4056 信任摘要（TUI 用） |
| 上下文压缩 | 完整（但有已知上游缺陷） | 台账“上下文压缩”`native`；kap-compaction | **有问题**：#4193（同一步多个大工具结果超窗、压缩请求自身超限）仍未合并 |
| 会话续接 / 分叉 / 导出 / 回滚 | 部分（续接已用；分叉禁；导出路由未注册；undo 待做） | 台账“会话、续接、分叉、导出”`pending`、“撤销”`pending`；`embed.ts` 九组路由（无 sessionExport） | #4154 续接后首轮读图修复；#4076 撤销时去掉中断提示；#4083 fork 记录清 cron |
| 后台任务 | 部分 | 台账“后台任务”`pending`；`task.bash_task_timeout_s=600` | #4061 WaitFor 上限 90 秒、新消息结束等待（宿主 WAIT_FOR 开，行为随之变） |
| Cron | 有意关闭 | 台账“定时”`disabled` | #4083（fork 不继承 cron） |
| 目标（Goal） | 有意关闭 | 台账“目标模式”`disabled` | #4057 goal 启动审批里的权限模式切换在 v2 生效（宿主固定 manual，无影响）；#4074 goal/tower 互斥 |
| Tower | 有意关闭 | ZP-13 `EXPERIMENTAL_LOCK.tower=false`；`LOCKED_OFF_TOOLS` | 大量重构（#4074、#3998），锁关；制品体积主要增量来自这里 |
| 通知（NotifyUser） | 部分（只进过程快照） | 台账“进度通知”`policy_limited`；`embed.ts:119`；`progress.ts:130-136` | **需跟进**：入参新增可选 `title`（drift 失败）；#4153/#4054 提醒频率调整——宿主声明了 `update_panel`，提醒仍会出现 |
| 提问（AskUserQuestion） | 部分 | 台账“提问”`pending`；questions 路由 | — |
| 待办（TodoList） | 部分 | 台账“待办”`pending`；`progress.ts:124` | — ；main #4239 提醒维护待办 |
| 联网检索与抓取 | 部分（经出站闸门，无本机回落） | ZP-11；台账“联网搜索”“网页抓取”`pending`；host-egress 用例 | — （`app/web/**` 零 diff） |
| 图像与媒体 | 部分（G1，跨边界须确认） | 台账“图像/视频”`pending`；`tool-table.ts` `ReadMediaFile: T0'`；ZP-22 | #4154 续接后读图；#4183 中断时取消视频上传 |
| 钩子 | 未集成（G2） | 台账“Hooks”`pending`；ZP-17 `runHook.ts` 改 `import type` | #4081 UserPromptSubmit 输出折叠进提示词消息；#4070（子 Agent 审批不触发 PermissionRequest 钩子）仍 open |
| 插件 | 有意关闭 | ZP-3；台账“插件市场”`disabled`；P1 路由 | — ；main #4188 插件技能限定名（不跟） |
| 终端 / 用户直接 shell | 有意关闭 | 台账“终端”“用户直接执行 shell”`disabled`；ZP-12 | — |
| 远程控制 | 有意关闭 | 台账“远程控制”`disabled`；ZP-8 | 新增设备管理/删除路由与 `RemoteControlDeviceClient`（不在嵌入面，制品 inputs 中 remote-control 为 0） |
| 账号 OAuth | 有意关闭 | 台账“账号 OAuth”`disabled`；ZP-21 | `routes/oauth.ts` +135（不注册） |
| 遥测 | 有意关闭 | 台账“遥测”`disabled`；`noopTelemetryService` 种子 | 新增 NotifyUser 与缓存探针事件，仍进 noop |
| 首包头超时（新） | 未集成 | — | 新能力；须按 N-1 改造后才能用 |

**格子变化汇总**：转好 4 格（续接后读图、WaitFor 上限、默认 max_tokens、依赖面变小）；需要跟进 3 格（NotifyUser `title`、首包头超时的出网旁路、Tower 新工具登记）；仍有问题 2 格（压缩 #4193、钩子/子 Agent 审批 #4070）。没有格子因 2.2.0 从“完整/部分”退为“未集成”。

## 5. rebase 实施方案

### 5.1 步骤与验收

| # | 步骤 | 验收 | 预计 |
|---|---|---|---|
| 0 | 评审本报告；决定 ZP-23 形态（建议：`resolveLlmHeadersTimeoutMs` 恒返回 `undefined`，首包头超时由宿主 `HostEgressDispatcher.modelAgent` 的 `headersTimeout` 承担）；决定 `progress.ts` 是否展示 NotifyUser `title` | 评审结论入台账 | 0.5 人日 |
| 1 | 在 fork 外做候选：`git fetch --tags` → 从 `@moonshot-ai/kimi-code@2.2.0` 建分支 → `git revert 1f6f0b1fa` → `git apply` 本报告补丁（d992ee24…）→ 加 ZP-23 | `git apply --check` 通过；`tsc --noEmit`（agent-core-v2、kap-server）、`check-no-comments.mjs`、`oxlint`（改动文件）均 0 错误 | 0.5 人日 |
| 2 | 替换 `platform/third_party/kimi-code`：先把旧工作树整体改名备份（或另存 `git stash` + 记录 HEAD），再 `checkout` 2.2.0 并应用补丁；`node_modules` 无需重装（锁文件只删不增），但建议 `pnpm install --offline --frozen-lockfile` 让 kaos 链接消失 | `git -C third_party/kimi-code rev-parse HEAD` = `472192c34…`；补丁文件与 BUILD 摘要一致 | 0.5 人日 |
| 3 | 构建制品：`node scripts/build-kap-embed.mjs` | 约 2297 inputs、约 11.7 MB；导出 25 个符号不变；`BUILD.json.upstream_commit` = `472192c34…` | 0.1 人日 |
| 4 | 更新门禁常量：`static-surface.test.ts:20-21` 锁定提交改为 `472192c34`；`embed-drift.test.ts:34` `START_BOOTSTRAP_SHA256` 改为 `8da4992b…f32a2`；`TOOL_INPUTS` 的 NotifyUser 键改为 `["message","title"]` 并同步 `progress.ts`；新增断言：制品中 `KIMI_CODE_LLM_HEADERS_TIMEOUT_MS` 不再生效（ZP-23 文本标记）、第一方源码不出现 `new Agent(`/`EnvHttpProxyAgent`（扫描 inputs 的 undici 导入者应只剩宿主自己） | static-surface 7/7、embed-drift 6/6 | 0.5 人日 |
| 5 | 宿主侧小改：`tool-table.ts` `LOCKED_OFF_TOOLS` 加 `TowerComplete`、`TowerRebase`；`progress.ts` 读 `title`（截断规则同 message）；（可选）`HostEgressDispatcher` 模型 Agent 设 `headersTimeout` | P1 裁决来源（遍历全部内置工具）通过；progress 用例通过 | 1 人日 |
| 6 | kap-host 用例：P1、P2、progress、s2-regressions、host-egress、sealed-storage、exec-router、search-diff | 全过（本次影子试跑：P1 等 40/40、P2 5/5） | 0.5 人日 |
| 7 | 内核 kap 用例：kap-gate、kap-a1、kap-compaction、kap-cancel、kap-parity、run-mode-gates | 全过；重点看 kap-compaction（压缩事件字段、触发方式）与 kap-a1（`max_tokens` 不再发送后闸门/网关的预算估计） | 1～2 人日（含排障） |
| 8 | 台账与文档：PATCHES.md 基线改 2.2.0、删 ZP-5/6 行、ZP-17/22 记改写、增 ZP-23、记录“补丁注释已清理”；旧补丁文件保留溯源；桌面运行时包（`apps/desktop/runtime/kap-host/main.mjs`）按既有流程重打 | 台账与 BUILD.json 一致；桌面冒烟（一次开放任务） | 0.5～1 人日 |

合计：**约 5～7 人日**（1 人约 1.5 周；不含 main 上挑提交）。若同时跟进 main 的 #4066、#4239，另加约 1 人日。

### 5.2 风险清单与回退

| # | 风险 | 级别 | 缓解 | 回退 |
|---|---|---|---|---|
| R1 | **首包头超时的独立调度器绕过宿主出口**（N-1）。现在因环境变量未设而休眠，但任何人为了“回移首包头超时”按上游文档设了 `KIMI_CODE_LLM_HEADERS_TIMEOUT_MS`，模型请求就不再经 `HostEgressDispatcher`（不换任务令牌、不受事项校验）；静态面用例查不出 | 高 | ZP-23 封闭；宿主侧实现超时；static-surface 增断言；内核拉起宿主的环境保持白名单 | 不启用该变量即恢复 2.1.1 行为 |
| R2 | **内核 kap 用例只验证了一部分**：kap-a1 前 8 条通过；kap-compaction、kap-gate、kap-cancel、kap-parity 和 kap-a1 余下几条没跑完。因此还不能排除 2.2.0 的行为变化（不发 `max_tokens`、WaitFor 90 秒、NotifyUser 提醒）会影响压缩、闸门和预算 | 高 | 步骤 7 在真实工作区跑；对照旧制品（§3.4）；必要时在闸门/网关侧补默认输出上限 | 制品与 `third_party` 回退到 f67e6398f（保留旧补丁与旧 BUILD.json，一次 checkout + 重建） |
| R3 | 上游压缩缺陷 #4193 仍在：大材料事项（多个大 Read）可能 `[compaction.failed]` | 中 | 宿主 Read 输出上限与执行域输出上限；kap-compaction 加“同一步多大结果”用例；关注 #4193 合并后单独 cherry-pick | 与 2.1.1 相同，无新增退化 |
| R4 | 版本分叉：2.2.0 不在 main 上，日后 rebase 到 2.3.x 时基线可能来自另一条发布分支 | 中 | 台账记录“发布分支 tag”而非 main 提交；每次 rebase 先 `merge-base` 核对 | — |
| R5 | NotifyUser `title` 未展示导致进展面板信息变少，或宿主未截断 `title` | 低 | 步骤 5 | 不读 `title`，只更新 drift 登记 |
| R6 | 2.2.0 的 Tower 大改代码打包进制品（锁关但存在），攻击面变大 | 低 | 宿主工具表外拒绝 + 实验开关锁定两层；可考虑以 esbuild `define` 剔除 Tower 特性（未验证） | — |
| R7 | 补丁注释已清理，意图只留在台账：后来者改补丁时缺少就地说明 | 低 | 台账每行写清锚点与原因（本报告 §2.3 可直接并入） | — |

回退总办法：rebase 在新分支与新补丁文件上进行；`third_party/kimi-code` 替换前整体备份；制品、`inputs.json`、`BUILD.json` 三件套成套回滚；门禁常量改动单独一个提交，便于 revert。

