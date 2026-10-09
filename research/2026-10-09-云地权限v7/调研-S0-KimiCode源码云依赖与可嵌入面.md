# 调研 S0：Kimi Code 源码中的云端依赖面与可嵌入后端（源码一手核验）

- 核验日期：2026-10-09
- 代码：`platform/third_party/kimi-code`，锁版 commit `f67e6398fb3210ad8ace970e2dfd5bcc984ed61f`（`@moonshot-ai/kimi-code@2.1.1`，2026-09-24）。上游 2.1.1 之后的变化见 `调研-S1`。
- 目的：回答“我方从月之暗面只采购 API token 时，Kimi Code（= Kimi Work 内核）有哪些能力依赖月之暗面的其他云服务、哪些能力可以原样在本机运行、哪里是替换点”。这是 v7 云地划分的第一条证据链。
- 纪律：每条给出文件路径；只写代码里看得到的事实，推断处标“推断”。

---

## 1. 结论先行

1. **Kimi Code 并不只依赖“模型 API”。** 源码里写死了 9 类月之暗面云端端点：模型（开放平台）、Kimi Code 托管 API（`/coding/v1`，含托管检索）、OAuth 账号、托管抓取、远程控制中继、插件市场与更新 CDN、内容 CDN（WebBridge/Computer Use 二进制）、遥测、官方数据源插件后端。**只买开放平台 API token，只能拿到第 1 类。**
2. **联网搜索（WebSearch 工具）默认走 Kimi 会员体系的托管接口** `https://api.kimi.com/coding/v1/search`（OAuth 令牌）；未登录 Kimi 账号且未配置 `[services.moonshot_search]` 时，这个工具不可用。协议很简单（`POST {"text_query"}` → `{"search_results":[{title,url,snippet,content,date,site_name}]}`），**中软可以自建兼容服务，通过配置 `base_url` + `api_key` 接入，不改引擎。**
3. **网页抓取（FetchURL）未配置托管服务时自动回落为本机直接抓取**（出口 IP 是律师电脑）。
4. **官方数据源插件 `kimi-datasource`（天眼查、元典法律、Wind、恒生聚源、财新等 25 个源）凭 Kimi Code 的 OAuth 登录调用月之暗面后端**——只买 token 用不了；中软必须自签数据商合同、自建法源服务。
5. **远程控制（手机/浏览器遥控桌面）= 经 `code-rc.kimi.com` 中继，把手机端的原始 HTTP 请求与 WebSocket 转发到本机 kap-server**；客户端代码里没有端到端加密，中继在 TLS 终止后可见全部往来内容（推断：中继服务端未开源，仓库中只有客户端）。发行版不能用月之暗面中继，也不应照搬“明文中继”。
6. **Kimi Code 自带一个完整的本机后端 kap-server**（REST + WebSocket，OpenAPI/AsyncAPI 文档，默认只绑 127.0.0.1 + Bearer 令牌 + Host/Origin 校验），覆盖会话、子会话、目标、审批、提问、终端、工作区与信任、插件与市场、技能、文件历史、快照、转录、导出、远程控制等——这就是“Kimi Code 的后端功能”。它和 node-sdk 一样接受 DI 种子（`seeds`），可以在启动时替换进程与文件系统服务。
7. **Kimi Code 没有操作系统级沙箱**：Bash 工具经 `IHostProcessService` 直接起 shell，权限控制只有应用层策略（危险命令询问、敏感文件询问、yolo/auto/manual 三种模式）。要把 Bash/Python 交给律师电脑上的 Agent，沙箱必须由我们在 DI 注入点实现。
8. **执行环境抽象 KAOS 支持“本机 / SSH / 容器”**，Agent 循环与工具执行位置可以分离——这为“律所执行器”“本机沙箱”提供了上游原生的接缝。

## 2. 云端端点清单（源码出处）

| # | 端点 | 用途 | 出处 | 只买 API token 能否用 | 发行版处理 |
|---|---|---|---|---|---|
| 1 | `https://api.moonshot.cn/v1`（`platform.kimi.com` API Key） | 模型推理（开放平台） | `packages/oauth/src/open-platform.ts:22-37`；`agent-core-v2/src/human/llm-kimi/trait.ts:17`（国际默认 `api.moonshot.ai`） | **能**（这正是我们采购的） | 经中软 MaaS 与法律推理网关调用；provider `base_url` 指向网关 |
| 2 | `https://api.kimi.com/coding/v1` | Kimi Code 托管 API：用量、用户信息、模型目录、反馈；**`/search` 托管检索** | `packages/oauth/src/managed-usage.ts:8`；`agent-core-v2/src/app/auth/webSearch/webSearchService.ts:72-82`（`${baseUrl}/search`） | **否**（需 Kimi 账号 OAuth 与会员权益） | 不连；检索改由中软检索服务提供（见 §3） |
| 3 | `https://auth.kimi.com` | OAuth 设备码登录 | `packages/oauth/src/constants.ts:3`；`region.ts:60-75` | 否（个人/企业 Kimi 账号体系） | 不连；身份由中软 IAM 承担 |
| 4 | `[services.moonshot_fetch]` | 托管网页抓取 | `agent-core-v2/src/app/web/webService.ts:33-45`（未配置时用 `LocalFetchURLProvider`） | 否 | 默认本机抓取（经出站闸门）；可选中软抓取代理隐去律所出口 |
| 5 | `https://code-rc.kimi.com` | 远程控制中继 | `packages/remote-control/src/remote-control.ts:19-29`（env `KIMI_CODE_REMOTE_CONTROL_RELAY_URL` 可改）；`:452` register、`:591-624` 转发 HTTP、`:690` 转发 WebSocket | 否 | 不连；中软自建**端到端加密**的遥控通道，且远程指令按“远程权限”降级（v7 第 2 篇 §8） |
| 6 | `https://code.kimi.com/kimi-code` | 更新、安装、插件市场根 | `region.ts:63`（`cdnBase`）；`agent-core-v2/src/app/plugin/marketplace.ts:8-10` | 否（且内容为面向开发者的插件） | 指向中软签名分发与律所批准的插件目录 |
| 7 | `https://cdn.kimi.com/…` | 内容 CDN（提示横幅、WebBridge 与 Computer Use 二进制） | `region.ts:86-91` | 否 | 不用；浏览器能力用发行版自带的隔离浏览器 |
| 8 | `https://telemetry-logs.kimi.com/v1/event` | 遥测 | `region.ts:67`；CLI 默认开、SDK 嵌入默认 noop（见 `2026-10-01-kimi-code-repo-facts.md` §7） | — | 关闭上游遥测；中软只采运营元数据 |
| 9 | 官方数据源插件后端 | `kimi-datasource`：天眼查、元典法律、Wind、恒生聚源、S&P、财新、新华财经、国家统计局等 25 个源 | `plugins/official/kimi-datasource/SKILL.md`（“工具会读取当前 Kimi Code 环境对应的本地 OAuth 登录凭据……如果没有登录凭据，让用户先在 Kimi Code 里执行 /login”）；`CHANGELOG.md` 3.2.0 新增 `yuandian_law` | 否 | 中软法源服务（自签元典、天眼查/企查查、法律之星等合同），以 MCP 形式接入 |

## 3. 联网搜索的可替换协议（中软检索服务的接口规格来源）

- 选择逻辑：`getWebSearchProvider()` = 先读配置 `[services.moonshot_search]`（有 `base_url` 即用），否则用 Kimi Code 托管 OAuth；两者都没有则工具不可用（`webSearchService.ts:31-38`）。
- 请求：`POST <base_url>`，JSON `{"text_query": "<查询>"}`；鉴权 `Authorization: Bearer <api_key 或 OAuth 令牌>`，附带宿主身份请求头与 `custom_headers`（`providers/moonshot-web-search.ts:50-60`）。
- 响应：`{"search_results":[{"site_name","title","url","snippet","content","date","icon","mime"}]}`（同文件 :17-30）。
- 含义：中软只需在云端实现一个兼容端点（后接境内合规的搜索 API 与法律站点抓取，查询先经出站闸门检查直接标识符），在每台律师电脑的 Kimi Code 配置里写 `[services.moonshot_search] base_url/api_key` 即可，**引擎零改动**。查询文本会离开律所，须进入数据去向卡与事项策略。

## 4. kap-server：Kimi Code 自带的本机后端

- 包：`packages/kap-server`（“Kimi Code server backed by the DI × Scope agent engine”，v0.2.3），入口 `startServer(opts)`（`src/start.ts`），选项含 `host`（默认 `127.0.0.1`，:138）、`seeds?: ScopeSeed`（:120，透传给 `bootstrap(..., [...logSeed, ...seeds])`，:198-211）、`hostIdentity`（白标）。
- 安全默认：非回环地址且无 TLS 拒绝启动（:156-160）；Bearer 令牌（`services/auth/tokenStore`）；Host 校验与 Origin 校验（:292-298、:505-514）；“远程控制要求回环地址”（:466）。
- 路由（`src/routes/registerApiV1Routes.ts` 汇总）：sessions（含 children 子会话、goal、profile、status、title、warnings）、approvals、questions、prompts、messages、tasks、terminals、tools、skills、plugins（含 marketplace）、workspaces（含 add-dir、trust/untrust）、fs / workspaceFs / files、fileHistory、snapshot、transcript、sessionExport、sessionMedia、search、modelCatalog、config、capabilities、connections、guiStore、remote-control、oauth、runtime、shutdown，另有 v2 路由与 OpenAPI/AsyncAPI 文档。
- 含义：Kimi Work 桌面端的“任务化会话、执行态三栏、审批卡、子 Agent、目标模式、文件历史与回滚、终端、技能与插件管理、手机遥控”在开源侧都有现成后端。**发行版要“完整接入 Kimi Code 的后端功能”，最直接的做法是把 kap-server 作为桌面端的 Agent 后端（进程内嵌或 utilityProcess），再用 DI 种子替换进程、文件系统、检索与抓取服务**，而不是像 v5/v6 那样只用 SDK 跑一个“只能调法律 MCP 工具”的循环。

## 5. 权限与执行：可以接管的注入点

| 能力 | 上游实现 | 注入点 | 出处 |
|---|---|---|---|
| Shell（Bash 工具） | 经 `IHostProcessService.spawn(shellPath, ['-c', cmd])` | DI 替换为沙箱进程服务（Windows AppContainer/受限令牌 + 作业对象；macOS seatbelt；Linux bubblewrap/容器） | `agent/tools/os/bash/bashTool.ts:157-172`；`os/interface/hostProcess.ts:30-40` |
| 文件读写（Read/Write/Edit/Glob/Grep） | 经 `IHostFileSystem` 与工作区上下文 | DI 替换为“事项工作区”受限文件系统（原件只读、工作区可写、其余不可见） | v5 已实现 ZP-6（`apps/agent-host/src/sandbox.ts`） |
| 执行环境 | KAOS：`local.ts`、`ssh.ts`；接口注释“local, SSH, containers” | 执行器、容器沙箱的上游原生接缝 | `packages/kaos/src/kaos.ts:5-12` |
| 应用层权限 | 13 个策略按序短路：用户 deny → 危险命令询问 → auto 模式 → 会话历史 → 用户 ask → 用户 allow → 敏感文件询问 → yolo → 默认放行/兜底询问；模式 `manual`/`auto`/`yolo` | `setApprovalHandler`（SDK）/ approvals 路由（kap-server）由发行版策略引擎裁决 | `agent/permissionPolicy/policies/*`；`2026-10-01-kimi-code-repo-facts.md` §8 |
| 配置权限规则 | 解析但不执行（PR #2337 未合入） | SDK `engineAccessor` 接线或由策略引擎裁决 | 同上 §8.2 |
| 工具可见性 | `[tools] enabled/disabled` 四层交集 | 按“中软基线 ∩ 律所策略 ∩ 事项策略 ∩ 运行模式”生成 | 同上 §5 |
| 项目级 skills/agents/MCP 自动发现 | 无 trust 门控（skills/agents） | `skillDirs` 选项 + ZP-1/ZP-2（已打） | `platform/third_party/PATCHES.md` |

**注意**：v5/v6 因为“内置工具全禁”而判定“2.1.0 工作区加固不回移”（PATCHES.md“已评估的例外”）。v7 打开内置文件与 Shell 工具后，**必须先回移 2.1.0 工作区加固（符号链接逃逸、git 配置执行、配置信任）并跑注入回归**，这是 v7 的 P0 工程前提。

## 6. 本机即可原样运行的能力（不依赖任何月之暗面云服务，只要模型端点可用）

计划模式（EnterPlanMode/ExitPlanMode）、待办（TodoList）、提问（AskUserQuestion）、子 Agent（Agent：coder/explore/plan 与自定义 profile）、Agent 集群（AgentSwarm）、目标模式（CreateGoal 等，含预算）、技能（Skill，渐进披露）、MCP 客户端（http/sse/stdio）、本机定时（CronCreate/List/Delete，应用开着才触发）、文件历史与快照、终端、会话导出与转录、本机文件工具、Shell（需沙箱）、本机网页抓取（FetchURL 回落）。

## 7. 对 v7 的直接含义

- 云地划分多了一个此前各稿都没有显式使用的维度：**能力来源**。凡是“Kimi Work 靠 Kimi 云提供、而我们只买 token 拿不到”的能力（检索、数据源、远程控制中继、账号、分发），中软云端必须补位，否则“完整接入 Kimi Code 能力”无从谈起；反过来，**能在本机原样运行的 Kimi Code 能力不应被删除**，而应放进沙箱与策略之下。
- 远程控制在 Kimi Code 里是“把本机后端整个暴露给远端”的高权限通道，必须单独设计“云 → 本机”的远程权限，不能复用本机会话权限。

## 8. 会话与转录的落盘位置（静态加密的注入点）

- 引擎在 bootstrap 时注册 `IFileSystemStorageService`（`FileStorageService(homeDir, 0o700, 0o600)`），并把宿主传入的 `extraSeeds` 追加在其后（`agent-core-v2/src/app/bootstrap/bootstrap.ts:143-157`；后写覆盖先写）。
- 会话转录（每个 Agent 一个 `wire.jsonl`，子 Agent 各自一份）、会话索引、工作区别名、MCP 配置存储等 27 处经该服务读写（`wire/wireService.ts`、`app/sessionIndex/*`、`app/workspace/*` 等）。
- 含义：**发行版可以注入“按事项密钥加密”的存储服务**，让 Kimi Code 自己的会话转录在律师电脑上也以密文落盘，而不必像 v5 那样每任务临时 homeDir、任务结束即删（那样会失去 Kimi Work 的会话续接、文件历史与回滚）。
- 已知边界（待探针）：上下文压缩后的“上下文恢复”提示会引导 Agent 用 Read/Grep 读取自己的 `wire.jsonl`（`agent/fullCompaction/context-recovery-footer.md`）；加密存储下需由受限文件系统为 Agent 提供解密视图或关闭该提示。另有少量路径直连 `node:fs`（`platform/third_party/PATCHES.md` 已记录），须逐一核对是否落盘内容。

## 9. Windows 上的 Shell 前提

- `packages/kaos/src/environment.ts:9`：“On Windows the probe expects bash from Git for Windows or MSYS2”；`:141-159` 依次探测 `C:\Program Files\Git\bin\bash.exe` 等路径，找不到即报错“Git Bash was not found on this Windows host … or set KIMI_SHELL_PATH to a bash.exe”。
- 含义：发行版在 Windows 上要让 Bash 工具可用，须**随包分发便携 bash 运行时**（如 MinGit/MSYS2 子集，注意 GPL 分发义务）并以 `KIMI_SHELL_PATH` 指定；且该运行时须能在我们选择的沙箱（AppContainer、受限令牌或专用低权限用户）中正常工作——这是 Windows 沙箱探针的第一项（第 4 篇 §11）。
