# 中软 fork 补丁台账（kimi-code）

- 基线：`f67e6398fb3210ad8ace970e2dfd5bcc984ed61f`（`@moonshot-ai/kimi-code@2.1.1`，2026-09-24）
- 方案依据：方案 v4.0 第 4 篇 §2.3 必打补丁；一手调研 `research/2026-10-01-kimi-code-repo-facts.md` §16
- 升级闸门：rebase 到 >2.1.1 之前，**必须先 revert #4059**（`KIMI_CODE_TRUST_WORKSPACE`），并逐条回归本表

## 已应用

| # | 级别 | 文件 | 内容 | 原因 |
|---|------|------|------|------|
| ZP-1 | P0 | `packages/agent-core-v2/src/workspace/workspaceAgentProfileLoader/internal/agentRoots.ts` | `projectAgentRoots()` 恒返回 `[]` | 项目级 agent profiles 无 trust 门控、无开关；案卷目录 `.kimi-code/agents` 会被无条件加载并注入工具/委派声明（上游无等效宿主选项，必须 patch） |
| ZP-2 | P0 | `packages/agent-core-v2/src/workspace/workspaceMcpConfig/workspaceMcpConfigService.ts`（2 处） | `includeProject: this.trust.isTrusted()` → `includeProject: false` | 项目级 MCP 防御性写死：防止控制面误调 trust API 后案卷内 `.kimi-code/mcp.json` 被加载 |
| ZP-3 | P1 | `packages/agent-core-v2/src/app/plugin/marketplace.ts` | 默认 marketplace URL 指向 `127.0.0.1:9`（黑洞） | 防止 kimi-webbridge / computer-use 插件把浏览器能力带进执行器。**注意：SDK bundle 中该模块被 tree-shake，本补丁仅对 CLI 构建生效** |
| ZP-5 | P0 | `packages/node-sdk/src/types.ts`、`sdk-rpc-client-v2.ts`（2 处） | `KimiHarnessOptions` / `SDKRpcClientV2Options` 增加 `extraSeeds?: ScopeSeed`，追加到 `bootstrap(input, seeds)` 种子末尾 | 宿主经 DI 注入「拒绝式」`IHostProcessService`（任何进程启动请求都失败）。`createSession` 的 `kaos` 参数在 v2 引擎被忽略，正确注入点是 bootstrap DI 种子（`bootstrap.ts:143`；种子数组后写覆盖先写，App 作用域默认注册被跳过）。宿主实现在 `apps/agent-host/src/sandbox.ts` |
| ZP-6 | P0 | 同 ZP-5（共用 `extraSeeds` 透传） | 注入「受限」`IHostFileSystem` | 快照目录与签发技能目录只读、每任务 homeDir/临时目录可读写、其余路径拒绝（读 ENOENT / 写 EPERM，避开引擎 `pathExists` 特判分支）。宿主实现在 `apps/agent-host/src/sandbox.ts` |
| — | — | `packages/node-sdk/src/index.ts` | re-export `IHostFileSystem` / `IHostProcessService` / `HostProcessError` / `ScopeSeed`（ZP-5/6 宿主侧引用） | 宿主构造种子需要 DI token |

ZP-5/6 验证（`npm run test:a1`，packages/kernel/test/a1-agent.test.ts）：引擎在注入后稳定启动（git 上下文按上游双层 try/catch 降级，探针 1）；纯管道模式（ZR_KERNEL_TCP=off）任务照常完成（探针 2「宿主不依赖回环网络」）；拒绝式 spawn 与受限 FS 有直接单测。已知边界（如实记录）：环境探测等只读路径直连 `node:child_process`（不经 DI，真正进程封锁边界是 OS 降权）；持久化层与技能发现直连 `node:fs`（签发目录只读由 OS 权限保证）；stdio MCP 会被拒绝式进程服务拦截（法律 MCP 为 http，无影响）。

台账注记（2026-10-02，阶段 4 验证，不改补丁）：`createSession({ agentFiles })` 与 ZP-1 叠加正常——显式 agentFiles 以最高优先级生效（签名法律 Agent profile，content/agent-profile/），项目级目录写死（ZP-1）不影响显式传入；A1 恢复粒度修正为任务级（agent_start/agent_wait 不落检查点，恢复即整任务重跑，宿主不改动）。

## 免 patch（宿主选项/配置层实现，见 services/agent-runtime）

| 事项 | 机制 |
|------|------|
| 项目级 skills 自动发现 | `createKimiHarness({ skillDirs: [签发目录] })` 整体替代自动发现 |
| 内置工具全禁 | worker `config.toml` `[tools] enabled = ["mcp__legal__*"]`（连带关闭 Agent/AgentSwarm 子代理派发） |
| 遥测 | SDK 嵌入路径默认 noop；配置 `telemetry = false` 双保险 |
| 自动更新/问卷/远程控制 | SDK 嵌入路径不经过 CLI，天然不涉及 |
| 白标 | `KimiHostIdentity` + `[identity]` 配置；`builtin_product_skills = false` |
| 配置权限规则不执行（#2337） | 审批 100% 经控制面 `setApprovalHandler` 裁决（工具网关为强制点），不依赖引擎权限规则 |
| 子代理审批（#4070） | SDK 审批回调按 sessionId 桥接，不受影响（调研 §8.3） |

## 已评估的例外

| 事项 | 结论 |
|------|------|
| §2.3 P0「评估并回移 2.1.0 工作区加固（符号链接逃逸、git 配置执行、配置信任）」 | **风险已通过工具面归零缓解，不回移**：2.1.0 加固针对的是内置文件/Shell 工具被利用的场景；本 fork 以 `[tools] enabled=["mcp__legal__*"]` 使内置 Read/Write/Edit/Glob/Grep/Bash 全部不可见（模型层与执行层双重），worker 内无文件工具体即无符号链接逃逸/git 配置执行的载体。配置信任面由 ZP-2（项目级 MCP 写死）与 ZP-1（项目级 agents 写死）覆盖。若未来开放任何内置文件工具，必须先回移 2.1.0 加固并跑注入回归。 |
| P1「Hook 可配置为失败即拒绝」 | 审计与审批不依赖 hooks（调研 §9 hook 失败放行）；强制点在工具网关 + 控制面 `setApprovalHandler`。不接线 hooks，故无需此补丁。 |

## 待办（G1）

- [ ] ZP-4（P1，备选）：SDK 层经 `engineAccessor` 接线 `IAgentPermissionRulesService.addRules()` 兜底 deny
- [ ] 每两周评估上游；ACP/SDK 契约、隔离与注入探针回归通过才合入（方案 §2.3 版本治理）
