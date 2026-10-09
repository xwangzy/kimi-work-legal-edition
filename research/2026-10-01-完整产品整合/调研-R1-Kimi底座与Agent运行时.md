# 调研 R1：Kimi 底座与 Agent 运行时联网核验（2026-10-01）

> 范围：只核验 09-28 基线（《子报告-Kimi底座与运行时》《子报告-技术运行时复核》）之后的变化，以及基线没有回答的问题。只读联网，未登录、未提交表单、未安装软件、未调用付费 API。
> 证据等级：**一手**＝官方原文/源码/价格页/公告/API 返回；**交叉**＝多源一致；**单一**＝单一来源；**查不到**＝本轮未查到（不等于“不存在”）。
> 状态：完成（2026-10-01）。
> **方法说明**：本轮 WebSearch、WebFetch 两个工具均报错“There's an issue with the selected model (kimi-k3)”而无法使用，全部证据改用 curl 直接读取 GitHub REST API、raw.githubusercontent.com、npm/PyPI registry、Kimi 开放平台官方 `.md` 文档和 kimi.com 页面 HTML。DuckDuckGo 返回人机验证页，按规则没有绕过，所以**第三方媒体报道本轮没有检索**（相关项标“查不到”）。GitHub 匿名 API 共用约 40 次，未触发限流。

---

## 0. 相对 09-28 基线的变化总表

| # | 事项 | 09-28 基线 | 10-01 核验 | 等级 |
|---|---|---|---|---|
| 1 | Kimi Code 版本 | 2.1.1；main `e15c4fc`（09-28） | **release 仍为 2.1.1**；main 前进到 `21406fb`（09-30，+13 提交）；待发布 changeset 15 条，含 `KIMI_CODE_TRUST_WORKSPACE`、hook 修复、默认不发 `max_tokens` | 一手 |
| 2 | ACP 服务端 | 零改动 | **仍零改动**；新增 open 问题 #4082（skill 斜杠命令丢图片）、#4043（会话重命名） | 一手 |
| 3 | 2.1.0 安全加固 | 2.1.1 回滚 | **仍未重新合入**；仓库内审查清单写明“回滚后代码已不在 main” | 一手 |
| 4 | 权限与审批 | KAP `permission_rules` 不生效 | PR #2337「honor configured permission rules」**仍 open**；新增 #4070：**后台子代理的审批不触发 PermissionRequest hook** | 一手 |
| 5 | SDK 与嵌入 | node-sdk 未发布，判断“只能走 CLI/ACP/KAP” | **新发现：node-sdk 在进程内 bootstrap 引擎**（klient memory transport），官方 CLI 自己也经由该 SDK 消费引擎 → 技术上可以库内嵌；npm 仍未发布；已有第三方 `@botiverse/kimi-code-sdk` 重打包使用 | 一手（第三方为单一） |
| 6 | 远程执行 | — | **PR #4062（SSH/Docker 远程执行目标）open**，合入后可实现“引擎在控制面、工具在沙箱” | 一手 |
| 7 | 遥测 | 默认开启 | 仍默认 `true`；PR #2516（Unicode/UNC/`C:/` 路径脱敏）**仍 open** → Windows 与中文路径脱敏有缺口 | 一手 |
| 8 | MCP | Windows stdio 问题 | 新增 #4079（stdio 失败不重连）；#830 指出 Moonshot 平台对工具 schema 有严格校验 | 一手 / 单一 |
| 9 | Skills 自动发现、Hook fail-open、远程控制中继 | 无开关 / fail-open / 无禁用项 | **均未变** | 一手 |
| 10 | Kimi Work | 3.2.14（09-24） | **3.2.15（09-30）**：Notion/飞书文档人机双写、Agent 过程默认折叠、修复 Windows 闪现控制台；仍没有 SSO/审计/管理后台/SDK/OEM | 一手 |
| 11 | Hosted Agents | Beta、`always_allow`、不适用 ZDR | **无变化**（更新日志最新仍为 09-07）；补充基线遗漏：MCP 失败会发 `mcp_connection_failed`/`mcp_authentication_failed` 事件，但凭据刷新失败不发 | 一手 |
| 12 | 开放平台价格与模型 | K3 ¥20/¥2/¥100 等 | **价格全部不变**；K2.8 仍无 API；Batch 仍不含 K3 | 一手 |
| 13 | 开放平台接口 | 未涉及 | 补充：有 **Anthropic 兼容端点** `https://api.moonshot.cn/anthropic`；`json_schema` 结构化输出；`tool_choice=required` 仅 K3；K3 `reasoning_effort` **默认 `max`**；温度固定 1.0 | 一手 |
| 14 | 数据条款 | §6.3 仍在 | **仍在**（协议 08-31 版未改）；ZDR 页未变 | 一手 |
| 15 | 官方 Agent SDK | 未涉及 | 官方 `kimi-agent-sdk`（Go/Node/Python）**存在但停在已归档的旧 Kimi CLI 上**（npm 最后发布 04-13） | 一手 |
| 16 | 法律方案 / 中软公告 / 登月计划 | 查不到 | **仍查不到**（官网新闻最新为 09-21；中软官网最新相关公告仍为 07-20；合作伙伴计划页无更新） | 一手（官网） |
| 17 | 后端运行时备选 | 只比较了 Kimi Code、opencode、Agents SDK | 新比较了 8 个框架、5 个工作流引擎（见 Q6）：**Vercel AI SDK、Pydantic AI 对 K3 的 `reasoning_content` 回传已内建**；AgentScope 会丢弃 thinking；Inngest 为 SSPL、Restate 为 BSL | 一手（源码），兼容性未实测 |

## Q1 Kimi Code 最新状态、包结构与可嵌入性

核验日期：2026-10-01。取证快照：main HEAD `21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3`（2026-09-30T07:23:40Z）。方法：GitHub REST API（releases、commits、compare、git tree、issues、pulls）＋ raw.githubusercontent.com 读源码；未克隆、未运行。

### 1.1 版本与提交（一手）

| 项 | 结论 | 证据 |
|---|---|---|
| 最新 release | **仍是 `@moonshot-ai/kimi-code@2.1.1`（2026-09-24T07:24:08Z）**，09-24 之后没有新 release；npm `latest` 仍为 2.1.1 | [Releases](https://github.com/MoonshotAI/kimi-code/releases)、[API](https://api.github.com/repos/MoonshotAI/kimi-code/releases?per_page=8)、[npm](https://registry.npmjs.org/@moonshot-ai/kimi-code) |
| main 最新提交 | `21406fb`（09-30）「fix(agent-core-v2): omit completion token cap unless explicitly configured (#4091)」；2.1.1 之后 main 共前进 13 个提交、改动 177 个文件（agent-core-v2 87 个、apps/kimi-code 35 个、kap-server 9 个、node-sdk 3 个，**acp-server 0 个**） | [compare 2.1.1…HEAD](https://github.com/MoonshotAI/kimi-code/compare/f67e6398fb3210ad8ace970e2dfd5bcc984ed61f...21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3) |
| 待发布内容（`.changeset/` 下 15 条，下个版本预计为 minor） | ① 新环境变量 **`KIMI_CODE_TRUST_WORKSPACE=1`** 可在无头运行（`kimi -p`、CI）中信任工作区（#4059）；② 信任提示改为列出“信任后会激活什么”及配置来源（MCP、additional_dirs、AGENTS.md、skills、agent profiles，#4055/#4056）；③ 修复 v2 引擎上 goal 审批提示里切换权限模式不生效（#4057）；④ 修复 UserPromptSubmit hook 注入文本导致轮次错位、丢回复（#4081）；⑤ 不再默认发送 `max_tokens`，修复裸 vLLM 等严格服务栈 400（#4091）；⑥ fork 会话不再继承源会话 cron（#4083）；⑦ WaitFor 后台任务等待上限 90 秒（#4061）；⑧ Tower 模式运行中新消息会中断当前轮（#3998） | `.changeset/*.md`（HEAD）；[#4059](https://github.com/MoonshotAI/kimi-code/pull/4059)、[#4057](https://github.com/MoonshotAI/kimi-code/pull/4057)、[#4091](https://github.com/MoonshotAI/kimi-code/pull/4091) |

### 1.2 09-24 之后各关注点的变化（一手）

| 关注点 | 09-28 基线 | 10-01 核验 | 证据 |
|---|---|---|---|
| ACP 服务端 | 2.0.2 起零改动 | **仍零改动**（2.1.1→HEAD 没有触及 `packages/acp-server`）。新增 open 问题：[#4082](https://github.com/MoonshotAI/kimi-code/issues/4082) 斜杠命令调用 skill 时图片附件被丢弃、[#4043](https://github.com/MoonshotAI/kimi-code/issues/4043) 会话重命名未暴露给 ACP 客户端；open PR [#3407](https://github.com/MoonshotAI/kimi-code/pull/3407) 修 `session/set_mode` plan 幂等 | compare、issues API |
| 权限/审批（request_permission） | ACP 反向 RPC 审批；KAP 的 `permission_rules` 接受但不生效 | ACP 侧无变化。**open PR [#2337](https://github.com/MoonshotAI/kimi-code/pull/2337)「honor configured permission rules」仍未合入**，说明 v2 引擎“配置的权限规则不被执行”问题仍在；新 open 问题 [#4070](https://github.com/MoonshotAI/kimi-code/issues/4070)：**后台子代理发起的审批不会触发 PermissionRequest hook**（审批旁路风险）。已合入 #4057 只修“权限模式变更事件发布” | pulls/issues API |
| 2.1.0 工作区安全加固（2.1.1 回滚） | 已回滚 | **没有重新合入**。仓库新增的 PR 审查技能文件明确写着 #3964 “两天后 #4013 整体回滚……回滚后代码已不在 main”，并列出回滚原因（子模块+符号链接下 git 探针整体失败、filter `required=true` 仓库 fatal、print/ACP/SDK 无信任入口导致 `additional_dir` 静默为空、`~` 条目让 local.toml 整文件失效） | [`.agents/skills/review-pr/surfaces.md` L45、L129](https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/.agents/skills/review-pr/surfaces.md) |
| 工作区信任 | 只管项目 MCP | 新增 `KIMI_CODE_TRUST_WORKSPACE` 环境变量（`workspaceTrustService.ts` L14–59：`isTrusted()` = 环境变量 或 用户确认）；无头运行未信任时项目级 MCP 保持禁用（[docs/zh/customization/mcp.md](https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/docs/zh/customization/mcp.md)）。对后端的含义：服务端 worker **不要设置该变量**，否则案卷目录里的项目级 MCP 会被直接启用 | [workspaceTrustService.ts](https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/packages/agent-core-v2/src/workspace/workspaceTrust/workspaceTrustService.ts) |
| 遥测默认值 | 默认开启 | **仍默认 `telemetry = true`**（docs L105）。open PR [#2516](https://github.com/MoonshotAI/kimi-code/pull/2516)「redact Unicode, UNC, and C:/ paths in telemetry」未合入 → **Windows 路径与中文路径的脱敏仍有缺口**（推测：含当事人名称的中文目录名可能进入遥测事件）；另有 open PR [#4094](https://github.com/MoonshotAI/kimi-code/pull/4094) 调整遥测归因 | [config-files.md](https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/docs/zh/configuration/config-files.md) |
| 远程控制中继 | 无禁用开关 | `packages/remote-control` 无改动，仍无配置项禁用；新 issue [#4096](https://github.com/MoonshotAI/kimi-code/issues/4096) 显示 **Kimi Work 桌面版也在用同一 RemoteControlService** | compare、issues |
| 项目级 skills 自动发现开关 | 没有 | **仍没有**。`skillRoots.ts` L9–11 固定扫描 `.kimi-code/skills`、`.agents/skills`；`workspaceSkillCatalog.ts` 中没有任何信任判断；新的信任提示只“披露”项目 skills 来源，未见门控 | [skillRoots.ts](https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/packages/agent-core-v2/src/features/skill/catalog/skillRoots.ts) |
| Hook 失败放行 | fail-open | **未变**：文档仍写“其他非零值……默认放行（fail-open）”“不应作为唯一的安全防线”；open PR [#4003](https://github.com/MoonshotAI/kimi-code/pull/4003) 拟增 StepFinished hook、JS 文件 hook | [hooks.md L17–23、L88](https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/docs/zh/customization/hooks.md) |
| Windows | 多个 open 问题 | 09-28 之后无 Windows 修复合入；[#2967](https://github.com/MoonshotAI/kimi-code/pull/2967)（fs.watch 盘符根路径）仍 open；基线列出的 #3236/#3216/#3297/#3186/#3270/#3949 未出现在 09-28 后更新列表中（状态不变） | pulls/issues API |
| MCP | — | 新 open 问题 [#4079](https://github.com/MoonshotAI/kimi-code/issues/4079)：**stdio MCP 启动即失败后没有重连入口，`/reload` 也不重建，只能重启**；[#4095](https://github.com/MoonshotAI/kimi-code/issues/4095) 提议按工具分级暴露；长期 open 的 [#830](https://github.com/MoonshotAI/kimi-code/pull/830)「sanitize MCP JSON Schemas for Moonshot MFJS validator」说明 **Moonshot API 对工具 JSON Schema 有严格校验器，第三方 MCP 的 schema 可能被拒** | issues/pulls API |
| 远程执行环境 | — | **新 open PR [#4062](https://github.com/MoonshotAI/kimi-code/pull/4062)「remote environments for SSH and Docker execution targets（phase 1）」**（前身 #3856）：引擎在一处运行、工具在 SSH/Docker 目标里执行，正是多租户后端需要的“控制面/执行面分离”，但**尚未合入** | pulls API |

### 1.3 SDK 是否发布、能否库内嵌（一手源码）

- **npm 未发布**：`@moonshot-ai/kimi-code-sdk`、`@moonshot-ai/klient`、`@moonshot-ai/agent-core-v2`、`@moonshot-ai/kosong` 在 npm 均返回 `Not found`；npm 上 `@moonshot-ai` 名下只有 CLI 包。`packages/node-sdk/package.json` 版本 0.20.0，仍 `private: true`，但已写好 `publishConfig.access: public` 与 provenance（准备发布但没发）。
- **单包结构**（HEAD，全部 `private: true`，除注明外 MIT）：

| 包 | 版本 | 作用（取自 package.json description） |
|---|---|---|
| `packages/agent-core-v2` | 0.4.3 | “The unified agent engine for Kimi（DI × Scope）”：循环（`src/agent/loop/`）、上下文压缩（`src/agent/fullCompaction/`、`contextMemory/`）、工具与审批（`src/tool/`、`agent/toolApproval/`、`permissionGate/`、`permissionPolicy/`）、Skills（`src/features/skill/`）、MCP 客户端（`src/agent/mcp/`、`src/mcpCore/`）、子代理（`src/session/subagent/`）、计量（`src/agent/usage/`、`tokenCounting/`）、持久化（`src/persistence/`） |
| `packages/kosong` | 0.5.6 | LLM 抽象层；`providers/kimi.ts`、`providers/reasoning-key.ts` 处理 **`reasoning_content` 回放**：入站兼容 `reasoning_content`/`reasoning_details`/`reasoning` 三种字段，出站“按端点学习对方方言”原样回传，默认 `reasoning_content` |
| `packages/kaos` | 0.1.6 | 执行环境抽象（含 `./ssh` 导出），是 #4062 远程执行的基础 |
| `packages/klient` | 0.1.2 | “contract-driven facade over agent-core-v2, routable over **ipc or in-memory** transports” |
| `packages/node-sdk`（`@moonshot-ai/kimi-code-sdk`） | 0.20.0 | “public TypeScript SDK and harness”；agent-core-v2、kaos、klient、kosong 都在 devDependencies，由 tsdown **打包进 SDK 产物** |
| `packages/acp-server` / `kap-server` | 0.0.1 / 0.2.3 | ACP（依赖 `@agentclientprotocol/sdk`）/ REST+WS 服务端；kap-server 的 package.json **未写 license 字段**（受根 LICENSE 覆盖） |
| `packages/remote-control`、`telemetry`、`oauth`、`minidb`、`transcript`、`migration-legacy` | — | 中继客户端、遥测、Kimi OAuth、嵌入式 KV 库、对话渲染、旧版迁移 |
| `apps/kimi-code` | 2.1.1 | 唯一公开发布的包；运行时依赖只有 `qrcode`、`ws`，引擎全部打包进 `dist/main.mjs` |

- **结论：技术上可以在 Node.js 服务端进程内嵌入，不必只走 CLI/ACP 进程。** 证据：
  1. `packages/node-sdk/src/sdk-rpc-client-v2.ts` 文件头注释写明引擎 “bootstrapped in-process and reached through the klient facade”，L234 `import { createKlient } from '@moonshot-ai/klient/memory'`，L446–465 调 `bootstrap(...)` 后 `createKlient({ scope: app })`；
  2. `packages/klient/README.md` 给出进程内用法：`bootstrap({ homeDir })` → `createKlient({ scope: app })` → `sessions.create({ workDir })` → `agent.prompt(...)`，门面含 `approvals.*`、`questions.*`、`setPermission`、`getUsage`、`fork/createChild`、`archive/restore`；
  3. `AGENTS.md` L17：CLI “consumes core capabilities through `@moonshot-ai/kimi-code-sdk` and must not depend directly on engine packages”；L22：node-sdk 是 “the public TypeScript SDK and harness”；L112：`packages/node-sdk/src/index.ts` 被 “desktop and web in code-app……SDK users” 消费，改动须说明兼容方案。
- **但有四个硬限制**（一手事实＋推测）：
  1. 没有发布到 npm，也没有稳定性承诺，只能自己从 monorepo 构建私有包并锁定提交；
  2. 引擎以 `homeDir`（`~/.kimi-code` 式目录）为 App 作用域，配置、凭据、会话索引、MCP 配置、skills 都落本地文件系统；**一个 App scope 对应一个 homeDir**，多租户要每租户（或每事项）独立 bootstrap、独立 homeDir（推测：同进程多 App scope 未见官方用例，minidb 有独占写锁，remote-control 有机器级单实例锁）；
  3. 在 #4062 合入之前，shell、文件工具直接在宿主进程所在的操作系统执行，**不能和 Web 服务同进程跑客户材料**，至少要“每任务一个受限容器/进程”；
  4. 对外契约面向 coding agent（工作区、git、终端、TUI 交互），法律工具层要自己写。
- **另外三种无界面入口仍在**：`kimi -p --output-format stream-json`、`kimi acp`、`kimi web`（KAP，文档仍标实验性）。

### 1.4 许可证、NOTICE 与品牌（一手）

- 根 `LICENSE`：MIT，“Copyright (c) 2026 Moonshot AI”。MIT 义务只有一条：在副本或实质部分中**保留版权与许可声明**（内嵌进 exe 或服务端镜像时，在“第三方许可”清单里保留即可）。
- 仓库**没有 NOTICE 文件**，也没有 TRADEMARK/品牌政策文件；README 只写“Released under the MIT License”，**没有任何商标或品牌使用条款**（查到的是“没有限制条款”，不代表授予商标权；MIT 本身不授予商标）。
- 需要另外处理的第三方许可：`packages/pi-tui/LICENSE` 为 MIT（Copyright 2025 Mario Zechner）；`apps/vscode/LICENSE` 为 **Apache-2.0**（只有复用 VS Code 扩展代码才会带来 NOTICE/变更声明义务）；`packages/tree-sitter-bash` 及 npm 依赖需跑一次 SBOM/许可证扫描。
- 白标钩子 `[identity] name/slug` 仍在（基线已核）；“Kimi”字样在系统提示词、User-Agent 的替换已可做。品牌授权仍以与月之暗面的书面授权为准。

### 1.5 对方案的影响

1. **版本**：仍锁 2.1.1＋中软补丁集。下个版本会带来 `KIMI_CODE_TRUST_WORKSPACE`、hook 修复和 `max_tokens` 修复，可在其发布后评估跟进；#3964 加固仍需自行 cherry-pick。
2. **内嵌路线变为可选项**：后端可以不经 ACP，直接用自建的 `kimi-code-sdk`（klient memory transport）在 **Node worker 进程内**驱动引擎，拿到审批、提问、计量、fork 的结构化事件；但要“每租户/事项一个 worker 容器＋独立 homeDir”，并把它当作**无上游支持的内部 fork**来维护。
3. **审批不能只靠上游**：#2337（权限规则不执行）和 #4070（子代理审批不触发 hook）都没修，正式提交、外发、删除这类高风险动作必须由我方控制面在工具网关处拦截。
4. **关注 #4062**：一旦合入，“引擎在中软控制面、工具在每事项 Docker 沙箱”就能用上游原生能力实现，可显著减少自研隔离层。

## Q2 Kimi Work 桌面版

核验日期：2026-10-01。方法：curl 读取官方发布日志页面 HTML 后解析（本轮 WebFetch/WebSearch 工具不可用，见“方法说明”）。

- **最新版本 3.2.15（2026-09-30）**，是 3.2.14（09-24）之后唯一的新版本（一手，[Release Notes](https://www.kimi.com/help/kimi-work/release-notes)）。内容：
  - 新增：**Notion 与飞书文档“人机双写”**——首页侧边栏可快速打开 Notion、飞书文档；用插件创建的 Notion、飞书文档显示产物卡片；内置浏览器打开后可编辑 comments、做页面问答；
  - 变更：Agent 执行过程默认折叠、只展示最终回复；侧边栏项目可拖拽排序；退出登录时若有运行中任务会二次确认；
  - 修复：PPT 并发编辑可能损坏文件；**Windows 端运行任务时闪现控制台窗口**；打开不存在的文件时提示“找不到该文件”；启动提速。
- **团队/企业版、SSO、管理后台、审计、SDK、OEM、行业发行版**：发布日志正文中**均未出现**（一手；这几个词只出现在页面脚本与导航里，不在更新条目中）。kimi.com 导航的“企业服务”仍只有“Kimi 企业版、金融行业解决方案、企业版定价、联系销售”（一手，见合作伙伴计划页导航）。
- **法律相关功能或插件**：9 月发布日志里没有法律条目；已知的法律数据仍是 Beta 上线时内置的“华宇元典”等数据库插件（一手，[Kimi Work 更新文章](https://www.kimi.com/news/kimi-work-update)，6–7 月内容，不是新变化）。
- **侧证**：Kimi Code 仓库新 issue [#4096](https://github.com/MoonshotAI/kimi-code/issues/4096) 标题为“Kimi Work desktop (macOS): phone shows computer 'unavailable' after a single failed RemoteControlService…”，说明 **Kimi Work 桌面版与 Kimi Code 共用远程控制组件**（一手，推测其引擎同源）。
- **对方案的影响**：
  1. “Agent 过程默认折叠、只给最终回复”和“文档人机双写”是 Kimi Work 最新的交互方向，法律发行版的 exe 可以沿用（已获设计授权）；
  2. 飞书文档双写说明官方在做飞书生态，IM/文档入口首选飞书的理由更充分（推测）；
  3. 企业治理能力（SSO、审计、管理后台）在公开资料里仍然没有，**仍须由中软控制面自建**。

## Q3 Kimi Hosted Agents（托管智能体 Beta）

核验日期：2026-10-01。方法：直接读取官方 `.md` 文档（`https://platform.kimi.com/docs/<路径>.md`），索引见 [llms.txt](https://platform.kimi.com/docs/llms.txt)。

| 关注点 | 10-01 结论 | 等级 | 证据 |
|---|---|---|---|
| 09-28 之后是否有变化 | **没有**。API 更新日志最新一条仍是 **2026-09-07**；仍为 Beta，“当前仅针对国内企业认证用户开放”，需联系销售；API 版本头仍为 `kimi-api-version: 2026-09-01-beta` | 一手 | [更新日志](https://platform.kimi.com/docs/hosted-agents/changelog.md)、[快速开始](https://platform.kimi.com/docs/hosted-agents/quickstart.md) |
| 权限模式 | `permission_policy` “当前唯一公开取值为 `always_allow`：工具调用直接执行，不需要用户确认”；**`always_ask` 仍未开放**；每次工具调用的评估结果通过 `agent.tool_use` 事件的 `evaluated_permission` 下发 | 一手 | [权限策略](https://platform.kimi.com/docs/hosted-agents/permissions.md) |
| ZDR 覆盖 | 不变：ZDR 页仍写“使用 Kimi Hosted Agents 托管智能体的数据，零数据留存无法保证” | 一手 | [ZDR](https://platform.kimi.com/docs/guide/zero-data-retention.md) |
| 价格 | 不变：云沙箱 1 核 1 GB **¥0.072/小时**，按秒计费；模型推理另计 | 一手 | [托管智能体定价](https://platform.kimi.com/docs/pricing/hosted-agents.md) |
| 地域 | 只面向国内企业认证用户；海外、多地域部署说明**查不到** | 一手 / 查不到 | 快速开始 |
| GA 时间表 | **查不到**（更新日志、FAQ、平台发布记录均无 GA 计划） | 查不到 | [FAQ](https://platform.kimi.com/docs/hosted-agents/faq.md)、[平台发布记录](https://platform.kimi.com/docs/changelog/index.md) |
| MCP 失败语义 | 不变：单个 MCP 不可用“不会导致会话失败”，服务连不上、初始化超时、鉴权被拒时“跳过该服务的全部工具……会话与其他工具不受影响”；工具调用中断时作为工具错误返回模型；无匹配凭据时**匿名连接**且“不报错误”。**基线没写的细节**：09-07 起，初始连接或工具调用失败（不可达，或 401 经刷新和一次重试仍失败）时会话会发出 `mcp_connection_failed` / `mcp_authentication_failed` 错误事件，并带 `mcp_server_name`；但平台侧凭据刷新失败只记服务端日志、**不发事件** | 一手 | [MCP 接入 §连接失败与降级](https://platform.kimi.com/docs/hosted-agents/mcp.md)、[更新日志 09-07](https://platform.kimi.com/docs/hosted-agents/changelog.md) |

**对方案的影响**：基线“H1–H8 八道门”全部维持。可以补一条实现细节：交付闸门监听 `mcp_connection_failed` / `mcp_authentication_failed` 事件，命中强制法源服务名就把任务标为“受阻/待补核”。但凭据刷新失败不发事件，所以**仍须在交付前逐项核对法源调用记录**，不能只靠事件。

## Q4 Kimi 开放平台 API

核验日期：2026-10-01。全部来自官方 `.md` 文档原文（一手）。

### 4.1 价格（元 / 百万 tokens，与 09-28 相比**全部不变**）

| 模型 | 输入（未命中） | 缓存命中 | 缓存写入 5 分钟 | 缓存写入 1 小时 | 输出 | 上下文 |
|---|---|---|---|---|---|---|
| `kimi-k3` | 20.00 | 2.00 | 20.00 | 40.00 | 100.00 | 1,048,576 |
| `kimi-k2.7-code` | 6.50 | 1.30 | 不单列（K3 系列才单独计缓存写入） | 不单列 | 27.00 | 262,144 |
| `kimi-k2.7-code-highspeed` | 13.00 | 2.60 | 同上 | 同上 | 54.00 | 262,144 |
| `kimi-k2.6` | 6.50 | 1.10 | 同上 | 同上 | 27.00 | 262,144 |

- 来源：[模型推理价格](https://platform.kimi.com/docs/pricing/chat.md)。不指定 TTL 时缓存默认按 5 分钟档；命中后自动续期且不再收写入费。文件抽取与存储接口“限时免费”，抽取出的文本作为输入照常计费。
- **K2.8：仍未开放 API**（[模型列表](https://platform.kimi.com/docs/models.md)只有 K3、K2.7-code、K2.7-code-highspeed、K2.6）。**“K2.7”只有 Code 版**，没有通用版 K2.7。
- 新信息（9 月平台发布记录）：账户消耗按“现金、代金券各 50%”扣除，已签合同的用户按合同（[发布记录](https://platform.kimi.com/docs/changelog/index.md)）。

### 4.2 Batch 与限流

- **Batch**：标准价的 **60%**，**只支持 `kimi-k2.7-code`（¥3.90/¥0.78/¥16.20）和 `kimi-k2.6`（¥3.90/¥0.66/¥16.20）**，仍不支持 K3（[Batch 定价](https://platform.kimi.com/docs/pricing/batch.md)）。
- **限流档位**（不变，[充值与限速](https://platform.kimi.com/docs/pricing/limits.md)）：

| 档位 | 累计充值 | 并发 | RPM | TPM | TPD | 联网搜索 QPS |
|---|---|---|---|---|---|---|
| Tier0 | ¥0 | 1 | 3 | 50 万 | 150 万 | 1 |
| Tier1 | ¥50 | 15 | 100 | 200 万 | 不限 | 3 |
| Tier2 | ¥100 | 40 | 100 | 300 万 | 不限 | 5 |
| Tier3 | ¥500 | 50 | 200 | 300 万 | 不限 | 10 |
| Tier4 | ¥5,000 | 60 | 200 | 400 万 | 不限 | 20 |
| Tier5 | ¥20,000 | 100 | 300 | 500 万 | 不限 | 50 |

- 企业选项：仍只有“联系销售”（[账号与财务 FAQ](https://platform.kimi.com/docs/guide/account-and-payments.md)：“Kimi 销售团队可为企业调用 Kimi API 提供更多资源与支持”）；代金券不计入累计充值；“集群负载达到容量上限时，我们可能会采取临时的限流措施”；风控限速“一旦触发即无法解除”。**没有公开的专属并发或 SLA 档位**。

### 4.3 接口能力

| 能力 | 结论 | 证据 |
|---|---|---|
| Anthropic 兼容端点 | **有**。base URL `https://api.moonshot.cn/anthropic`（`POST /anthropic/v1/messages`），支持流式、工具调用、图片、thinking（thinking 块带 `signature`，多轮须原样放回，可用 `POST /v1/signatures/verify` 校验）和结构化输出；缓存只认**顶层** `cache_control`（`5m`/`1h`），消息体内的 `cache_control` 被忽略，**不传则只读缓存不写入** | [Messages API](https://platform.kimi.com/docs/api/messages.md) |
| OpenAI Responses API | 有（用于 Codex 直连 K3） | [Responses API](https://platform.kimi.com/docs/api/responses.md) |
| 工具调用 | 支持 `tool_calls`、流式工具调用、动态加载工具、官方工具（联网搜索/抓取）；`tool_choice`：**K3 支持 `auto`/`none`/`required`**，K2.6、K2.7-code 传 `required` 会报错 | [模型参数参考](https://platform.kimi.com/docs/api/models-overview.md) |
| 结构化输出 | `response_format` 支持 `json_object` 与 `json_schema`（`strict`）；官方称 K3 “稳定支持 Structured Output，嵌套对象、数组、`anyOf` 等均能正常处理”，K2.6 复杂 schema 偶有不稳 | [response_format](https://platform.kimi.com/docs/guide/response_format.md) |
| 工具 schema 校验 | Kimi Code 仓库有长期 open 的 PR [#830](https://github.com/MoonshotAI/kimi-code/pull/830)「sanitize MCP JSON Schemas for Moonshot MFJS validator」，说明平台对工具 JSON Schema 有严格校验，第三方 MCP 的 schema 可能需要清洗（单一，未在官方文档查到说明） | 单一 |
| K3 推理参数 | K3 总是思考，**保留式思考始终开启**；`reasoning_effort` 取 `low`/`high`/`max`，**默认 `max`**；`temperature` 固定 1.0，传其他值报错。多轮和工具调用“必须把 API 返回的完整 assistant message 原样回传（包括 `reasoning_content`）” | [思考模型](https://platform.kimi.com/docs/guide/use-thinking-models.md)、模型参数参考 |
| K3 最大上下文 | **1M tokens（1,048,576）**，不按上下文长度分段计价；最大输出长度在文档中**查不到**明确数值 | [K3 快速开始](https://platform.kimi.com/docs/guide/kimi-k3-quickstart.md) |

### 4.4 数据条款与 ZDR

- **《Kimi 开放平台服务协议》**：版本生效日期 2026-08-31（更新日期 08-24），**未改版**。第六章“知识产权”第 3 条原文仍为：“为了提升您使用本服务的体验，您授予我们一项免费的使用权，以在法律允许的范围内将您输入输出之内容及反馈用于模型服务优化。”第三章另有提醒：输入内容“会在本协议约定范围（包括提供、优化服务等）内被使用”（[协议](https://platform.kimi.com/docs/agreement/modeluse.md)）。**基线说的 §6.3 仍在。**
- **ZDR**：页面不变。“按需开放给企业客户”，涉及敏感数据或有监管留存要求的“可联系销售申请评估”；开通后接口、参数、计费不变，平台无法回溯排查单次请求；直接上传的图片和视频、托管智能体、安全日志与账单、第三方模型/连接器/插件**都不在零留存范围内**；滥用时平台可终止 ZDR。**没有公开的量级、价格或资质门槛**（[ZDR](https://platform.kimi.com/docs/guide/zero-data-retention.md)）。

### 4.5 对方案的影响

1. 成本模型不用改：K3 ¥20/¥2/¥100、缓存写入 ¥20/¥40 均未变。K3 默认 `reasoning_effort=max`，**生产务必显式设 `low`/`high` 分档**，否则推理 token 会推高单任务成本（推测）。
2. 批处理降本仍只能用 K2.7-code、K2.6（6 折），K3 不能走 Batch。
3. 有了 Anthropic 兼容端点，后端运行时选型就**不再局限于 OpenAI 兼容框架**：Anthropic 生态的 SDK 和框架也能直接接 K3。但要注意“顶层 cache_control”和“thinking 块带 signature 原样回传”这两个差异。
4. Tier5 只有并发 100、TPM 500 万。多租户高峰（例如 300 席同时跑长任务）必然需要销售签专属额度，应写进采购合同。
5. 协议第六章第 3 条与 ZDR 的矛盾仍在，书面 DPA 加 ZDR 仍是签约前提。

## Q5 月之暗面官方 Agent SDK、法律方案、中软公告、登月计划

核验日期：2026-10-01。

### 5.1 官方 Agent SDK / 框架（一手，GitHub 组织仓库列表与 npm/PyPI）

| 项目 | 状态 | 判断 |
|---|---|---|
| **[MoonshotAI/kimi-agent-sdk](https://github.com/MoonshotAI/kimi-agent-sdk)** | Apache-2.0，576 星，01-08 创建，**最后推送 05-29**；提供 Go、Node（npm `@moonshot-ai/kimi-agent-sdk` **0.1.8，04-13 之后未更新**）、Python（PyPI `kimi-agent-sdk` **0.0.5，02-12**）三种 SDK。README：“expose the Kimi Code (Kimi CLI) agent runtime”，是**包装 CLI 进程的薄客户端**，复用 CLI 的配置、工具、skills、MCP，能处理审批 | 它包装的旧 Python 版 Kimi CLI 已归档（[kimi-cli](https://github.com/MoonshotAI/kimi-cli) 描述为“[Archived] Legacy Python Kimi CLI, no longer maintained”）。**官方 Agent SDK 存在，但停在旧架构上**；当前 2.x 引擎的 SDK 是仓库内未发布的 `kimi-code-sdk`（见 Q1）。不建议采用 |
| [MoonshotAI/kimi-agent-rs](https://github.com/MoonshotAI/kimi-agent-rs) | Apache-2.0，73 星；“Kimi Code CLI Wire mode-compatible agent server”；**02-06 之后无推送** | 停滞 |
| [MoonshotAI/kosong](https://github.com/MoonshotAI/kosong)、[pykaos](https://github.com/MoonshotAI/pykaos) | 独立仓库，最后推送分别为 07-16、2025-12-26；**GitHub 未识别出许可证**（kimi-code 仓库内的同名包是 MIT） | 只用 kimi-code 仓库里的版本 |
| `@botiverse/kimi-code-sdk`（npm，第三方） | 0.26.0，06-13 创建、08-11 更新；描述为“Botiverse repackage of @moonshot-ai/kimi-code-sdk……built node-sdk bundle for Slock. Mirror of MoonshotAI/kimi-code” | 侧证：**已有第三方把 node-sdk 打包后嵌入自家产品**，说明库内嵌路线可行（单一）；但这是第三方重打包，存在供应链风险，不能直接使用 |
| “Moonshot agent framework” | 组织 42 个仓库中**没有**另外的通用 Agent 框架；托管侧只有 Hosted Agents（Kimi Durable Harness，闭源服务） | 查不到 |

另：组织下有 `Branding-Guide` 仓库（2025-12 创建，03-11 最后推送），但 README 读取 404，**内容未核**；仍在活跃维护的 `Kimi-Vendor-Verifier`（09-17 推送）与基线提到的“认证推理伙伴”可能相关（推测）。

### 5.2 法律行业方案、中软公告、登月计划

| 项 | 结论 | 等级 | 证据 |
|---|---|---|---|
| 月之暗面法律行业解决方案 | **查不到**。kimi.com 新闻列表最新 4 篇依次为 09-21 Kimi Code Desktop、09-17 金融行业解决方案、09-10 企业合作伙伴计划、09-09 人才招募；法律最近一篇仍是 08-28《法律行业为什么都在用 Kimi K3？》；导航“企业服务”只有金融方案 | 一手（否定性结论只到“官网未发布”） | [新闻列表](https://www.kimi.com/news) |
| 中软国际 × 月之暗面法律方向公告 | **查不到**。中软国际官网首页“热点资讯”中，与月之暗面相关的仍是 2026/7/20《中软国际与月之暗面签署Token分成及联合创新合作协议，共建 FDE 创新实验室，布局企业级 Agentic AI 业务》 | 一手（官网首页） | [中软国际官网](https://www.chinasofti.com/) |
| 企业合作伙伴计划（登月计划）进展 | **09-10 之后无更新**：文章日期仍为 09-10，签约伙伴仍是华胜天成、金山云、亚康股份、亚信科技、中软国际 5 家；定位是与 IT 服务商、集成商共建前线部署工程师（FDE）队伍，开放模型与 Agent 底座 | 一手 | [企业合作伙伴计划](https://www.kimi.com/news/kimi-enterprise-partner-program) |
| 第三方媒体报道 | 本轮搜索引擎不可用（DuckDuckGo 返回人机验证页，按规则未绕过），**未检索** | 查不到 | — |

**对方案的影响**：月之暗面目前没有公开的法律行业方案，也没有把法律方向交给某个伙伴的公告，**中软发行版仍有先发窗口**。但合作伙伴计划是非排他的（5 家同批签约），金融方案“数据源＋Skills＋合规措施＋托管智能体”的模板也可能被官方或其他伙伴复制到法律行业，应尽快用书面协议锁定法律行业的联合品牌和报备规则。

## Q6 多租户后端 Agent 运行时与持久化工作流引擎比较

核验日期：2026-10-01。星数、许可证、最新 release、“近 90 天 release 数”（只统计最近 40 个 release，所以 40 表示“≥40”）来自 GitHub REST API；MCP、审批、Kimi 兼容性来自 raw 源码或 README（一手），标“既有知识”的为本轮未逐条打开核验。**所有兼容性结论都停在源码层面，本轮没有调用付费 API 实测。**

### 6.1 Agent 框架（服务对象：K3 的 OpenAI 兼容 API 驱动法律 SaaS 的开放式任务）

| 候选 | 许可证 | 成熟度（10-01） | MCP | 持久化执行 | 人工审批 | 多租户友好度（推测） | Kimi K3 兼容性 |
|---|---|---|---|---|---|---|---|
| OpenAI Agents SDK（Python） | MIT | 29,791 星；v0.22.3（09-17）；近 90 天 17 个 | 有（`src/agents/mcp/`） | 无内建；Temporal 官方集成 `temporalio/contrib/openai_agents` | `needs_approval`（`src/agents/tool.py`） | 库形态，租户隔离自管，好 | 默认只对 DeepSeek 回放 `reasoning_content`，接 K3 要自写 `should_replay_reasoning_content` 钩子（基线一手） |
| OpenAI Agents SDK（JS） | MIT | 3,882 星；v0.18.0（09-10）；18 个 | 有（`agents-core/src/mcp.ts`） | 无内建 | `needsApproval`（`agents-core/src/tool.ts`） | 同上 | Chat Completions 转换器回传字段**仍是 `reasoning`**（`openaiChatCompletionsConverter.ts` L368），不是 `reasoning_content`，需自定义 Model |
| LangGraph（Python / JS） | MIT | Py 42,534 星、JS 3,328 星；近 90 天 Py 15 个、JS ≥40 个 | 经 `langchain-mcp-adapters` | **内建**：checkpointer，README 列明 durable execution | **内建** `interrupt` | thread 级隔离成熟；官方 Platform/Server 另行授权（未核） | `ChatOpenAI` 文档写明 `reasoning_content` 等非标准字段“**not** extracted”，须用 provider 子类；PyPI 有 `langchain-moonshot` 0.1.0（早期版本），回放需实测 |
| Mastra（TS） | Apache-2.0，但 **`ee/` 目录**（`@mastra/core/auth/ee`、`agent-builder/ee`、`editor/ee`）适用企业许可 | 28,461 星；@mastra/core 1.72.0（09-30）；24 个 | 有（`packages/mcp`，可做客户端，也可做服务端） | 工作流 suspend/resume＋存储快照 | 全局 `requireToolApproval`；工作流挂起等待审批 | 鉴权、RBAC 在 ee 目录，**多租户治理部分需要商业许可** | 经 AI SDK 的 Moonshot provider（推测与 AI SDK 行为一致） |
| Vercel AI SDK（TS） | Apache-2.0 | 27,061 星；ai 7.0.126（09-30）；≥40 个（发版极频繁） | 有（npm `@ai-sdk/mcp` 2.0.65） | 配套 **Workflow DevKit**：`@workflow/ai` 5.0.0（Apache-2.0，AI SDK 的 durable 辅助库）＋ `@workflow/world-postgres`（基于 PostgreSQL 的参考实现，可自托管） | `needsApproval`（provider-utils tool 类型） | 库形态，好 | **官方 `@ai-sdk/moonshotai` 3.0.62**；openai-compatible 转换器会把 reasoning 片段写回 `reasoning_content`（L274） |
| Pydantic AI（Python） | MIT | 20,300 星；v2.52.0（09-30）；≥40 个 | 有（`pydantic_ai/mcp.py`） | 官方文档覆盖 **Temporal、DBOS、Prefect、Restate** | `requires_approval`（deferred tools） | 库形态，好 | **自带 MoonshotAI provider**：`openai_chat_thinking_field='reasoning_content'`、`openai_chat_send_back_thinking_parts='field'`（`providers/moonshotai.py` L86–87），K3 被识别为推理模型；默认 base_url 为国际站 `api.moonshot.ai`，境内需改为 `api.moonshot.cn` |
| Google ADK（Python / JS） | Apache-2.0 | Py 21,688 星 v2.10.0（09-25）；JS 1,426 星 v2.2.0（09-30）；20 / 23 个 | 有（`tools/mcp_tool`） | Session 持久化＋`ResumabilityConfig`（`apps/app.py`） | `require_confirmation`（`function_tool.py`） | 偏 Gemini/Vertex 生态 | 经 LiteLlm 接入：入站把 `reasoning_content` 转成 thought parts（`lite_llm.py` L601–647）；**出站是否回传需实测** |
| AgentScope（阿里，Python） | Apache-2.0 | 32,631 星；v2.0.9（09-28）；8 个 | 有（Toolkit 支持 MCP 与 skills，另有 MCP & Skill Hub） | ReAct 支持实时中断与恢复；工作区沙箱支持本地、Docker、Bubblewrap、E2B、OpenSandbox 等 | 有确认、中断 | 有组、组织级资源共享；中文生态，境内友好 | **OpenAI formatter 会静默丢弃历史中的 ThinkingBlock**（`formatter/_openai_formatter.py` L391–393）→ K3 多轮工具调用需自写 formatter |

### 6.2 持久化工作流引擎

| 引擎 | 许可证（一手） | 成熟度（10-01） | 自托管形态 | 中国境内自托管适配度（推测） |
|---|---|---|---|---|
| Temporal | MIT | 23,396 星；v1.30.7（09-18） | Go 多服务集群＋Postgres/MySQL/Cassandra（既有知识） | **高**：许可无限制、无强制外连，生态最成熟（OpenAI Agents、Pydantic AI 均有官方集成），但运维最重；镜像需同步到境内仓库 |
| Restate | **BSL 1.1**。附加使用授权：可以使用，但不得用于“Public Restate Platform Service”（向员工和承包商以外的第三方开放 Restate API 的托管服务） | 4,495 星；v1.7.12（09-22） | Rust 单二进制、内置存储（既有知识） | **中高**：中软把它当作 SaaS 内部组件属于允许范围，但 BSL 需法务书面确认；Pydantic AI 已有集成 |
| DBOS | MIT（dbos-transact-ts） | 1,380 星；v5.2（09-29） | **库形态**，只依赖 Postgres，没有独立服务端（既有知识；管理面 Conductor 为商业产品，未核） | **高**：组件最少，最适合首发；兼容 Postgres 的国产库需实测 |
| Inngest | **SSPL v1＋“Apache 2.0 Future License”**（延迟开源） | 5,901 星；v1.45.1（09-17） | Go 单二进制＋Postgres/Redis（既有知识） | **中低**：SSPL 在 SaaS 场景法务风险高；SDK 为 Apache-2.0（既有知识） |
| Hatchet | MIT | 8,038 星；py/1.41.1（09-24）；近 90 天 37 个 | Go 引擎＋Postgres（既有知识） | **高**：许可宽松、组件少；成熟度不及 Temporal |

### 6.3 结论

1. **结构化法律工作流**（合同审查、案卷整理、检索报告）不需要通用编码 Agent。后端如果统一用 Node.js（便于同时内嵌 Kimi Code SDK），首选 **Vercel AI SDK**：Apache-2.0，有官方 Moonshot provider，`reasoning_content` 回传已内建，工具审批、MCP 齐全。Python 栈则首选 **Pydantic AI**：MIT，自带 Moonshot provider 并原生回传 `reasoning_content`，四种持久化引擎都有官方集成。
2. **持久化编排**：首发用 **DBOS**（MIT，只需 Postgres），量上来或需要跨语言时换 **Temporal**（MIT）。Hatchet 可作备选；Restate 需过 BSL 法务；**Inngest 因 SSPL 不建议**。
3. **不建议直接拿来接 K3 的**：OpenAI Agents SDK JS（字段名不对）、AgentScope（丢弃 thinking）、ADK（出站回放未证实）、LangGraph＋`ChatOpenAI`（不提取 reasoning）。用它们都得自己改模型适配层。Mastra 的多租户鉴权在 ee 许可内。
4. **开放式任务的执行器仍是 Kimi Code**：上面没有一个框架自带“编码 Agent 级”的工具集（读写文件、shell、搜索、压缩、子代理、Skills 全套），而且这些框架与 K3 的组合都要先实测。

## 7. 推荐表与一句话结论

| 能力 | 用 Kimi Code 的方式（CLI/ACP 进程 vs 库内嵌 vs 不用） | 更优替代（如有） | 理由与风险 |
|---|---|---|---|
| Agent 循环 | 开放式任务：**库内嵌**。用中软 fork 自建并锁版 `@moonshot-ai/kimi-code-sdk`（klient memory transport），跑在每事项一个的 worker 容器里；`kimi acp` 进程作备选。结构化任务：**不用** | 结构化任务用 Vercel AI SDK（Node）或 Pydantic AI（Python）直调 K3 | 官方 CLI 本身就经由该 SDK 消费引擎（AGENTS.md L17），是被用得最多的路径；ACP 层还有 #4027、#4082、#4043 等未修问题，且只代理文本 IO。风险：SDK 未发布到 npm、没有稳定性承诺，须当作自维护 fork |
| 上下文压缩 | 随引擎使用（内嵌或 ACP） | 结构化流程由我方分段＋摘要 | `fullCompaction` 及重试配置成熟；但压缩会丢证据锚点，关键证据要在压缩前写入我方证据账本 |
| Skills（SKILL.md） | 沿用格式，由引擎加载；**打补丁关闭项目级自动发现**，只挂中软签发的只读目录 | 结构化流程由控制面渲染后注入提示词 | SKILL.md 是跨引擎格式（Kimi Code、Hosted Agents、AgentScope 均支持）；上游 `skillRoots.ts` 固定扫描项目目录、没有开关，案卷里的 `.agents/skills` 会被自动加载 |
| MCP 客户端 | 用引擎自带客户端，**只连中软法律工具网关（HTTP）**；不启用 stdio 和项目级 `mcp.json`；不设置 `KIMI_CODE_TRUST_WORKSPACE` | 网关侧统一做鉴权、审计、schema 清洗 | #4079 stdio 启动失败后不重连；#830 平台对工具 schema 校验严格；信任环境变量会让案卷里的 MCP 直接生效 |
| 子任务/并行 | 事项内子代理用引擎原生能力 | 跨事项、跨租户并行由 DBOS/Temporal 调度 | #4070：子代理发起的审批不触发 PermissionRequest hook；租户公平队列、配额、并发上限（Tier5 仅 100 并发）必须在控制面 |
| 会话恢复 | 引擎本地持久化只当缓存，不当权威 | 持久化工作流＋我方事件账本，从检查点重开任务 | 引擎状态存在 worker 本地的 homeDir，容器重建就会丢失；权威状态必须在中软库 |
| 审批回调 | 内嵌用 klient `approvals.*`，ACP 用 `session/request_permission`，只作第一道提示 | **工具网关强制审批**＋业务门禁（审批绑定工件 hash 和对象版本） | #2337（配置的权限规则不执行）未合入、#4070、Hook fail-open；高风险动作（外发、签发、删除）的工具根本不暴露给引擎 |
| 计量 | 引擎 `getUsage`/usage 事件只作参考 | **中软模型网关**（所有模型调用经代理）按响应 usage 记账，与月之暗面账单对账 | 引擎看不到网关外的调用；K3 的缓存写入分 5 分钟/1 小时两档计价，只有网关侧能按请求准确归集；`reasoning_effort` 默认 `max`，网关要强制分档 |

**一句话结论**：后端把 Kimi Code 当作“开放式任务的可替换执行器”——用中软 fork 自建锁版的 `kimi-code-sdk`，在每事项隔离的 worker 容器内进程内驱动（ACP 作备选），只让它负责 Agent 循环、上下文压缩、Skills 加载和事项内子代理；权限审批、会话权威状态、跨任务并行、计量和 MCP 工具全部由中软控制面（持久化工作流＋模型网关＋工具网关）掌握；结构化法律工作流不经过 Kimi Code，直接用 Vercel AI SDK（或 Pydantic AI）调用 K3。

## 8. 本轮未核实清单

| 项目 | 状态 |
|---|---|
| 同一 Node 进程内多个 `bootstrap` App scope 能否安全并存（多租户同进程） | 未核，推测不安全，按“每事项 worker 进程”设计 |
| #4062 远程执行何时合入、接口形态 | open，未定 |
| Vercel AI SDK / Pydantic AI / LangGraph+`langchain-moonshot` / ADK 与 K3 多轮工具调用的实际兼容性 | 只核了源码，需用测试额度实测 |
| K3 API 最大输出 tokens | 官方文档查不到明确数值 |
| Moonshot 工具 schema 校验器（PR #830 所称“MFJS”）的具体规则 | 官方文档查不到 |
| ZDR 开通门槛、价格；Hosted Agents GA 时间表与地域 | 查不到，需问销售 |
| `MoonshotAI/Branding-Guide` 仓库内容（品牌使用限制） | README 读取 404，未核 |
| 第三方媒体对中软×月之暗面法律方向、登月计划进展的报道 | 搜索引擎不可用，未检索 |
| LangGraph Platform 自托管授权、DBOS Conductor 许可、各引擎的外连与依赖细节 | 依据既有知识，本轮未逐条核 |

## 来源台账

访问日期均为 2026-10-01。固定提交 `21406fb` = `21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3`。

| # | 标题 | URL | 等级 |
|---|---|---|---|
| 1 | Kimi Code Releases（2.1.1 为最新） | https://github.com/MoonshotAI/kimi-code/releases | 一手 |
| 2 | GitHub API：releases 列表 | https://api.github.com/repos/MoonshotAI/kimi-code/releases?per_page=8 | 一手 |
| 3 | GitHub API：09-24 以来 main 提交 | https://api.github.com/repos/MoonshotAI/kimi-code/commits?sha=main&since=2026-09-24T00:00:00Z | 一手 |
| 4 | compare 2.1.1…HEAD（177 个文件） | https://github.com/MoonshotAI/kimi-code/compare/f67e6398fb3210ad8ace970e2dfd5bcc984ed61f...21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3 | 一手 |
| 5 | npm：@moonshot-ai/kimi-code（latest 2.1.1） | https://registry.npmjs.org/@moonshot-ai/kimi-code | 一手 |
| 6 | npm：@moonshot-ai/kimi-code-sdk（Not found） | https://registry.npmjs.org/@moonshot-ai/kimi-code-sdk | 一手 |
| 7 | node-sdk package.json（private、publishConfig、devDependencies） | https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/packages/node-sdk/package.json | 一手 |
| 8 | node-sdk `sdk-rpc-client-v2.ts`（进程内 bootstrap，L4、L234、L446–465） | https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/packages/node-sdk/src/sdk-rpc-client-v2.ts | 一手 |
| 9 | klient README（memory/ipc 传输与门面） | https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/packages/klient/README.md | 一手 |
| 10 | AGENTS.md（包职责、对外契约面 L17/L21–30/L112） | https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/AGENTS.md | 一手 |
| 11 | kosong `reasoning-key.ts`（reasoning_content 方言回放） | https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/packages/kosong/src/providers/reasoning-key.ts | 一手 |
| 12 | review-pr `surfaces.md`（#3964 回滚说明 L45、L129） | https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/.agents/skills/review-pr/surfaces.md | 一手 |
| 13 | `workspaceTrustService.ts`（KIMI_CODE_TRUST_WORKSPACE） | https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/packages/agent-core-v2/src/workspace/workspaceTrust/workspaceTrustService.ts | 一手 |
| 14 | `skillRoots.ts`（项目级 skills 目录） | https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/packages/agent-core-v2/src/features/skill/catalog/skillRoots.ts | 一手 |
| 15 | 文档：Hooks（fail-open） | https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/docs/zh/customization/hooks.md | 一手 |
| 16 | 文档：配置文件（telemetry 默认 true） | https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/docs/zh/configuration/config-files.md | 一手 |
| 17 | 文档：MCP（无头运行与信任） | https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/docs/zh/customization/mcp.md | 一手 |
| 18 | LICENSE（MIT，Moonshot AI）；pi-tui LICENSE（MIT）；apps/vscode LICENSE（Apache-2.0） | https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/LICENSE | 一手 |
| 19 | PR #4062 远程执行环境（SSH/Docker） | https://github.com/MoonshotAI/kimi-code/pull/4062 | 一手 |
| 20 | PR #2337 honor configured permission rules | https://github.com/MoonshotAI/kimi-code/pull/2337 | 一手 |
| 21 | Issue #4070 子代理审批不触发 PermissionRequest hook | https://github.com/MoonshotAI/kimi-code/issues/4070 | 一手 |
| 22 | Issue #4079 stdio MCP 失败后无法重连 | https://github.com/MoonshotAI/kimi-code/issues/4079 | 一手 |
| 23 | PR #830 为 Moonshot MFJS 校验器清洗 MCP schema | https://github.com/MoonshotAI/kimi-code/pull/830 | 单一 |
| 24 | PR #2516 遥测路径脱敏（Unicode/UNC/C:/） | https://github.com/MoonshotAI/kimi-code/pull/2516 | 一手 |
| 25 | Issue #4082 / #4043（ACP）、#4096（Kimi Work 远程控制） | https://github.com/MoonshotAI/kimi-code/issues/4082 | 一手 |
| 26 | Kimi Work 发布日志（3.2.15） | https://www.kimi.com/help/kimi-work/release-notes | 一手 |
| 27 | Kimi Work 更新文章（插件中心、华宇元典） | https://www.kimi.com/news/kimi-work-update | 一手 |
| 28 | 托管智能体更新日志 | https://platform.kimi.com/docs/hosted-agents/changelog.md | 一手 |
| 29 | 托管智能体权限策略 | https://platform.kimi.com/docs/hosted-agents/permissions.md | 一手 |
| 30 | 托管智能体接入 MCP | https://platform.kimi.com/docs/hosted-agents/mcp.md | 一手 |
| 31 | 托管智能体定价 | https://platform.kimi.com/docs/pricing/hosted-agents.md | 一手 |
| 32 | 托管智能体快速开始 / FAQ | https://platform.kimi.com/docs/hosted-agents/quickstart.md | 一手 |
| 33 | 模型推理价格 | https://platform.kimi.com/docs/pricing/chat.md | 一手 |
| 34 | 批量推理定价 | https://platform.kimi.com/docs/pricing/batch.md | 一手 |
| 35 | 充值与限速 | https://platform.kimi.com/docs/pricing/limits.md | 一手 |
| 36 | 模型列表 | https://platform.kimi.com/docs/models.md | 一手 |
| 37 | Messages API（Anthropic 兼容） | https://platform.kimi.com/docs/api/messages.md | 一手 |
| 38 | 模型参数参考 | https://platform.kimi.com/docs/api/models-overview.md | 一手 |
| 39 | response_format（Structured Output） | https://platform.kimi.com/docs/guide/response_format.md | 一手 |
| 40 | 思考模型（reasoning_content 保留） | https://platform.kimi.com/docs/guide/use-thinking-models.md | 一手 |
| 41 | Kimi K3 快速开始（1M 上下文） | https://platform.kimi.com/docs/guide/kimi-k3-quickstart.md | 一手 |
| 42 | 零数据保留（ZDR） | https://platform.kimi.com/docs/guide/zero-data-retention.md | 一手 |
| 43 | Kimi 开放平台服务协议（08-31 版，第六章第 3 条） | https://platform.kimi.com/docs/agreement/modeluse.md | 一手 |
| 44 | 平台新功能发布记录（2026 年 9 月） | https://platform.kimi.com/docs/changelog/index.md | 一手 |
| 45 | 账号与财务 FAQ（企业资源联系销售） | https://platform.kimi.com/docs/guide/account-and-payments.md | 一手 |
| 46 | 开放平台文档索引 | https://platform.kimi.com/docs/llms.txt | 一手 |
| 47 | MoonshotAI/kimi-agent-sdk（README）；npm 0.1.8；PyPI 0.0.5 | https://github.com/MoonshotAI/kimi-agent-sdk | 一手 |
| 48 | MoonshotAI 组织仓库列表（kimi-cli 已归档、kimi-agent-rs、kosong、Branding-Guide 等） | https://api.github.com/orgs/MoonshotAI/repos?sort=pushed&per_page=100 | 一手 |
| 49 | npm：@botiverse/kimi-code-sdk（第三方重打包） | https://registry.npmjs.org/@botiverse/kimi-code-sdk | 单一 |
| 50 | Kimi 新闻列表 | https://www.kimi.com/news | 一手 |
| 51 | Kimi 企业合作伙伴计划 | https://www.kimi.com/news/kimi-enterprise-partner-program | 一手 |
| 52 | 中软国际官网首页（热点资讯） | https://www.chinasofti.com/ | 一手 |
| 53 | OpenAI Agents Python `tool.py`（needs_approval）、`mcp/`；Temporal 集成 | https://github.com/openai/openai-agents-python/blob/main/src/agents/tool.py ；https://github.com/temporalio/sdk-python/tree/main/temporalio/contrib/openai_agents | 一手 |
| 54 | OpenAI Agents JS 转换器（L368 `reasoning`）、`tool.ts`、`mcp.ts` | https://github.com/openai/openai-agents-js/blob/main/packages/agents-openai/src/openaiChatCompletionsConverter.ts | 一手 |
| 55 | LangGraph README；langchain-openai `base.py`；PyPI langchain-moonshot；langchain-mcp-adapters | https://github.com/langchain-ai/langgraph ；https://github.com/langchain-ai/langchain/blob/master/libs/partners/openai/langchain_openai/chat_models/base.py ；https://pypi.org/project/langchain-moonshot/ | 一手 |
| 56 | Mastra LICENSE.md（ee 目录）、README、`tools/types.ts`（requireToolApproval） | https://github.com/mastra-ai/mastra/blob/main/LICENSE.md | 一手 |
| 57 | Vercel AI SDK LICENSE；openai-compatible 转换器（L274）；npm @ai-sdk/moonshotai、@ai-sdk/mcp | https://github.com/vercel/ai/blob/main/packages/openai-compatible/src/chat/convert-to-openai-compatible-chat-messages.ts ；https://registry.npmjs.org/@ai-sdk/moonshotai | 一手 |
| 58 | Vercel Workflow DevKit LICENSE.md；@workflow/ai；@workflow/world-postgres | https://github.com/vercel/workflow | 一手 |
| 59 | Pydantic AI Moonshot provider（L86–87）与 profile；durable_execution 文档（Temporal/DBOS/Prefect/Restate） | https://github.com/pydantic/pydantic-ai/blob/main/pydantic_ai_slim/pydantic_ai/providers/moonshotai.py | 一手 |
| 60 | Google ADK `function_tool.py`（require_confirmation）、`lite_llm.py`、`apps/app.py`（ResumabilityConfig） | https://github.com/google/adk-python/blob/main/src/google/adk/models/lite_llm.py | 一手 |
| 61 | AgentScope README；`_openai_formatter.py`（L391–393 丢弃 ThinkingBlock） | https://github.com/agentscope-ai/agentscope/blob/main/src/agentscope/formatter/_openai_formatter.py | 一手 |
| 62 | Restate LICENSE（BSL 1.1＋附加使用授权） | https://github.com/restatedev/restate/blob/main/LICENSE | 一手 |
| 63 | Inngest LICENSE.md（SSPL＋Apache 2.0 Future License） | https://github.com/inngest/inngest/blob/main/LICENSE.md | 一手 |
| 64 | Temporal、DBOS（transact-ts）、Hatchet 仓库元数据（MIT、release） | https://api.github.com/repos/temporalio/temporal ；https://api.github.com/repos/dbos-inc/dbos-transact-ts ；https://api.github.com/repos/hatchet-dev/hatchet | 一手 |
| 65 | 各框架仓库元数据（星数、许可证、release） | https://api.github.com/repos/{owner}/{repo} 及 /releases?per_page=40 | 一手 |
