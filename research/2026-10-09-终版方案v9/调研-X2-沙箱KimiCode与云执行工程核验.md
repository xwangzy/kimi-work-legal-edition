# 调研 X2：本机沙箱、Kimi Code 上游与云端执行的工程核验

- 核验日期：2026-10-09（北京时间）
- 调研员：独立工程调研（单代理，未派子代理）
- 对象：Kimi Work 法律行业发行版（中软自建桌面客户端 + 中软云；Agent 内核 = 开源 Kimi Code；中软只从月之暗面开放平台采购 API token）
- 前序材料（仅作待核实起点）：`research/2026-10-09-云地权限v7/调研-S0-*.md`、`调研-S1-*.md`、`research/2026-10-09-独立终审v8/调研-A-*.md`
- 本地锁版源码：`platform/third_party/kimi-code`（下文源码路径均相对该目录，除非另注）
- 标注：**【已核实】** = 本次直接读到一手文档/源码/API 返回；**【推断】** = 基于已核实事实的工程判断；**【未查到】** = 本次检索范围内未找到一手说法。

---

## Q1 Windows 本机沙箱现实

### 1.1 OpenAI Codex 的三种 Windows 沙箱实现【已核实】

一手来源：官方文档 <https://learn.chatgpt.com/docs/windows/windows-sandbox.md>（原 `developers.openai.com/codex/windows` 已 308 跳转至此，2026-10-09 抓取）；源码 `github.com/openai/codex` main `9a59289f`（2026-10-09 14:21 UTC，稀疏克隆，仅读未执行）。

| 实现 | 机制（官方原意） | 需要管理员？ | 网络隔离 | 读隔离（denied read） | 源码证据 |
|---|---|---|---|---|---|
| `mxc`（官方现推荐） | 调用微软 **Microsoft Execution Containers（MXC）** 的 ProcessContainer：命令以**用户本人身份**运行，但每条命令附带 OS 级策略；“不创建沙箱账户、不改主机文件 ACL、不跑 classic elevated setup、不需要本地防火墙规则” | **否**（“doesn't require administrator elevation for sandbox setup”） | 原生网络策略：只放行回环（含 Codex 代理监听），拒绝直接非回环出站与一般入站；直连 DNS 拒绝 | 支持（需主机探测到原生 `PSE_SUPPORT_FS_DENY`） | `codex-rs/mxc-sandbox/README.md`；`codex-rs/mxc-sandbox/src/lib.rs:91-94`（`BaseContainerRunner::is_base_container_api_present()`）；`src/native.rs:7,30,35`；依赖 `codex-rs/Cargo.toml:412` `mxc-sdk = { git = "https://github.com/microsoft/mxc", rev = "a846837d…" }` |
| `elevated`（首选旧式回落） | 专用低权限**沙箱本地用户**（离线/在线两类）+ 文件 ACL 边界 + **Windows 防火墙规则**（“Codex Sandbox Offline - Block Non-Loopback Outbound”）+ WFP 过滤 + 本地策略/登录权限；默认私有桌面 | **是**（一次性 UAC；IT 可代为 `codex sandbox setup --elevated --user ...` 预配） | 强（按沙箱用户 SID 的防火墙/WFP 阻断） | 支持 | `windows-sandbox-rs/src/setup_provisioning/firewall.rs:41,183`；`src/wfp.rs:45,84`；`src/elevated_impl.rs:98` |
| `unelevated`（旧式回落） | 由当前用户派生的**受限令牌**（`CreateRestrictedToken`，`DISABLE_MAX_PRIVILEGE｜LUA_TOKEN｜WRITE_RESTRICTED`）+ ACL 写边界；网络用“环境变量级离线控制” | 否 | **弱**（官方：“weaker network isolation than elevated”） | **不支持**（官方：“doesn't support denied read paths”） | `windows-sandbox-rs/src/token.rs:21,42-44,500-501` |

- 官方限制原文要点：MXC 需在 Windows 11 设备上**逐台验证能力**，“A Windows version number alone doesn't establish compatibility”；显式选 `mxc` 而能力缺失时**直接失败、不回落**；MXC 下前台命令退出即杀掉剩余子进程（后台 dev server 不保留）；受管网络要求 `allow_local_binding = true`（回环双向放开，代理的私网目的地检查被移除）。CLI 0.162.0 起 `features.prefer_mxc` 默认关，桌面 App 可经灰度开启；企业可用 `requirements.toml` 中 `windows.allow_mxc = false` 禁用。
- Windows 版本矩阵（官方）：Windows 11 推荐；“近期且完全更新的 Windows 10”尽力支持（需 ConPTY，≥1809）；`elevated` 依赖管理员批准的 setup；常见失败原因包括 UAC 被拒、不允许建本地用户/组、不允许改防火墙、登录权限被策略拒（错误 1385）。
- 许可证：openai/codex 根目录 `LICENSE` 为 **Apache-2.0**（另有 `NOTICE`）；`codex-windows-sandbox` crate `license.workspace = true`。
- 仓库中 MXC 相关路径：`codex-rs/mxc-sandbox/*`、`codex-rs/sandboxing/src/windows_mxc.rs`、`codex-rs/exec-server/src/sandbox_integrity/mxc.rs`、`patches/mxc-sdk_utf8_resources.patch`、测试 `codex-rs/core/tests/suite/scenarios_mxc.rs`。

### 1.2 MXC 是否有微软一手文档 / 公开 API【已核实——v7“未查到”的结论需更正】

1. **微软官方 KB 有明文**：Windows 11 24H2/25H2 的 2026 年 8 月累积更新 **KB5120998** 发布说明：“New! This update introduces Process Isolation for Microsoft Execution Containers (MXC), a fast, lightweight boundary for responsive workloads such as coding agents and model-generated code”，用 OS 原生遏制能力按策略限制文件、网络、UI 等资源。<https://support.microsoft.com/en-us/servicing/os/windows-11/2026/08/kb5120998-windows-11-24h2-25h2-update>
2. **微软官方开源仓库与 SDK**：<https://github.com/microsoft/mxc>（“Microsoft eXecution Container”，**MIT**，创建于 2026-02-06，约 2.2k star，**v1.0.0 于 2026-10-07 发布为首个稳定版**，此前 0.6–0.9 均为 prerelease）。SDK：Rust `mxc-sdk`、.NET `Microsoft.Mxc.Sdk`、**Node `@microsoft/mxc-sdk`（npm latest = 1.0.0，2026-10-06 发布，MIT）**；也可用 `wxc-exec.exe` + JSON 请求（稳定 schema）非 SDK 方式调用。
3. 后端：Windows 11 默认 `processcontainer`；另有 `windows_sandbox`*、`wslc`、`microvm`*、`hyperlight`*、`isolation_session`（* = experimental）；Linux 默认 bubblewrap，macOS 默认 seatbelt。
4. **OS 支持矩阵**（`docs/backends/process-container/os-version-support.md`）：Process Isolation 需 24H2 ≥ 26100.9278 / 25H2 ≥ 26200.9278（KB5120998，2026-08）/ 26H2 ≥ 26300.9550 / 26H1 ≥ 28000.2804；Session Isolation 需 2026-09 的 KB5124010。**只列 Windows 11，未列 Windows 10；文档未按 Home/Pro 版本区分（版本限制：未查到）。**
5. **分层与管理员前提**（`docs/backends/process-container/host-prep.md`、`networking.md`）：
   - 首选层 = 进程内 **BaseContainer / PSEC（Process Security Environment）API**：每容器按容器 SID 施加 **WFP 出站过滤 + 每容器 WinHTTP 代理**，“applied with no UAC prompt per launch”；默认 egress/ingress 皆 deny 时“Internet and private-network traffic are denied”。
   - 当 BaseContainer API 缺失或“symbol resolves yet the feature is disabled”时，回落到 **Tier 3 = AppContainer + DACL**：此时 `cmd.exe / powershell.exe / pwsh.exe / node.exe` 启动会因 `C:\` 根与 `\Device\Null` 未授权 AppContainer SID 而 `ERROR_ACCESS_DENIED`，须用 **`wxc-host-prep.exe`（manifest 强制 requireAdministrator）** 给系统盘根加 ACE，并且 **`\Device\Null` 的安全描述符每次开机被内核重置，需每次开机以提升权限重做**（计划任务/MDM 启动脚本）。AppContainer 回落层的网络行为“is not equivalent to these guarantees”。
   - 结论【已核实】：**“无需管理员 + 读隔离 + 网络隔离”只在 PSEC 可用（Win11 24H2/25H2 且装了 2026-08 之后累积更新、功能未被禁用）时成立**；否则要么一次性/每次开机的管理员准备，要么降级。
6. 第三方转述（非一手，仅佐证生态）：windowsforum 称 MXC v1.0 GA；al-ice.ai 称 GitHub Copilot CLI 已采用 MXC 进程隔离。Microsoft Q&A 有用户提问帖（learn.microsoft.com/answers/questions/5930562），属社区内容，不作依据。

### 1.3 微软其他一手资料【已核实】

- **Windows Sandbox**：前提为虚拟化在 BIOS 开启、≥4 GB 内存、≥2 核；“included in the supported Windows editions like **Pro, Enterprise, and Education**”（官方概述页列举不含 Home；Home 不支持为业界共识，本页未直接写“Home 不支持”）；启用需“open PowerShell **as Administrator**”运行 `Enable-WindowsOptionalFeature -FeatureName "Containers-DisposableClientVM"`。<https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-install>
- **wsb CLI**（Windows 11 24H2 起）：`wsb start --config "<Configuration><Networking>Disabled</Networking></Configuration>"`、`wsb exec` 等；但官方注明 “**Currently, there is no support for process I/O** meaning that there is no way to retrieve the output of a command run in Sandbox”，且以当前用户身份执行需要活动用户会话（需先建远程桌面连接）。→ 不适合作为 Agent 每命令执行后端。<https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-cli>
- **Win32 app isolation**：官方页仍标注 “**This feature is in preview**”，面向 MSIX 打包应用的整体隔离，不是“给任意子进程套沙箱”的 API。<https://learn.microsoft.com/en-us/windows/win32/secauthz/app-isolation-overview>
- **AppContainer / LPAC**：官方定义 LPAC 为“more isolated than a regular AppContainer. It requires explicit capability declarations to access resources…”。<https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer> ——能否承载通用 bash/Python：**原理上可创建（无需管理员即可 CreateAppContainerProfile）**，但微软自家 MXC 文档给出的实测是：通用解释器在 AppContainer 内因系统盘根/NUL 设备 ACL 启动失败，需管理员预备（见 1.2-5）。Git Bash/MSYS2 在 AppContainer 下的可用性：**未查到一手说法**，须探针。
- **Hyper-V / WSL2**：Windows Sandbox 与 WSL2 都依赖硬件虚拟化；启用可选功能需管理员（上文 Windows Sandbox 页）。WSL2 在 Home 版可用、Hyper-V 管理器仅 Pro+ 为业界共识，本轮未逐页复核微软原文【推断/未逐条核实】。

### 1.4 同类产品在 Windows 上如何隔离本机代码执行

| 产品 | 官方说法（一手） | 判定 |
|---|---|---|
| **Claude Code** | “The sandbox runs on macOS, Linux, and WSL2. **On native Windows, Claude Code runs commands unsandboxed.** To use the sandbox on a Windows machine, run Claude Code inside a WSL2 distribution.” 沙箱在 Linux/WSL2 依赖 bubblewrap + socat，macOS 用 Seatbelt。<https://code.claude.com/docs/en/sandboxing.md>（第 13、57-58 行） | 【已核实】原生 Windows 无 OS 沙箱 |
| **Claude Cowork** | “Cowork runs your tasks in the cloud (in beta on Team and Enterprise plans). Claude's work runs on Anthropic's servers, in an isolated environment… When a task needs something on your computer, like a local file or your browser, Claude reaches it through the Claude Desktop app”；“Session isolation… separate from your computer and your network. Shell commands and code Claude writes run inside that environment.” <https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork> | 【已核实】**代码执行放云端隔离环境，本机只做文件/浏览器/电脑操作的“手”**；Windows 本机 VM 机制本页未写 |
| **腾讯 WorkBuddy** | 文档《默认权限与安全沙箱》：两档权限（默认 / 允许完全访问）；安全中心“沙箱安全总开关：AI 运行于隔离沙箱，并配置文件、命令、网络访问策略”；文件按路径三态（允许/询问/拒绝）、命令按前缀、网络按域名/URL（“远程 HTTP 请求默认询问，本地 HTTP 请求默认放行”）；另有“安全网关”“传输加密（端到端加密通道）”“敏感保护”“自动备份”。官方建议完全访问只在“Docker、虚拟机、一次性工作目录”中使用。<https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Permission-Modes> | 【已核实】有“沙箱”产品概念与策略面；**Windows 上的 OS 级实现机制（AppContainer/受限令牌/驱动/虚拟化）未披露【未查到】** |
| **Kimi Work** | 帮助中心：“面向知识工作者的通用型本地 Agent……Windows 版：Windows 10 及以上系统”；产品介绍、FAQ、版本说明中**未出现“沙箱/隔离”字样**。<https://www.kimi.com/zh-hans/help/kimi-work/overview> | 【未查到】Windows 本机隔离机制的官方说明 |
| **千问办公 / 千问电脑端 Agent** | 本轮检索未找到官方关于 Windows 本机代码执行隔离的说明 | 【未查到】 |
| **OpenAI Codex** | 见 1.1：MXC（无管理员）/ elevated（管理员一次性）/ unelevated（弱） | 【已核实】目前业内披露最完整的原生 Windows 方案 |

### 1.5 国内杀软 / EDR 与此类沙箱的冲突报告

- **未查到**针对 360 安全卫士、腾讯电脑管家与“专用低权限用户 + 防火墙规则 + AppContainer”类沙箱冲突的一手公开报告（GitHub `openai/codex` issue 检索 “360”“Tencent PC Manager” 无相关命中；中文搜索引擎未检出）。
- 相关公开报告（均为用户报告，非厂商确认）：
  - openai/codex **#42060**（2026-09-01）：Windows 桌面端多任务时 CPU 争用，Defender 实时扫描与**火绒（Huorong）**对内置 `rg.exe` 等短命辅助进程的拦截扫描“可能放大”问题；在火绒中加白若干 Codex 辅助 exe 后改善。<https://github.com/openai/codex/issues/42060>
  - openai/codex **#46754**（2026-09-20）：装有**奇安信 QAX aES EDR** 的企业机，新版本的 `CodexSandboxService` 卡在 START_PENDING 导致应用无法启动，降级即恢复；报告者明确“没有直接证据证明是 EDR 所致”。<https://github.com/openai/codex/issues/46754>
  - openai/codex **#44447**：Win11 IoT Enterprise LTSC 上 elevated 安装在防火墙策略校验处失败（`helper_firewall_policy_ineffective`），只能回落 unelevated。<https://github.com/openai/codex/issues/44447>
  - 2026-09~10 月 openai/codex 仍有大量 open 的 Windows 沙箱安装/刷新失败 issue（如 #49025 elevated 与 unelevated 均失败、#51634/#52172 文件占用 os error 32、#51778 等），说明**即便是 OpenAI 的投入规模，classic Windows 沙箱的现场失败率也不低**。
- 【推断】“创建隐藏本地用户 + 改防火墙/WFP + 改系统盘 ACL”正是国内杀软“系统防护/账户保护/防火墙保护”类规则的典型拦截对象；MXC 的 PSEC 路线不建用户、不改 ACL、不加防火墙规则，被拦概率应显著低于 classic elevated，但**无公开实测**，需在 360/火绒/电脑管家三款上做兼容探针。

### 1.6 Q1 结论：小律所 Windows 笔记本能否“无需管理员”拿到“读隔离 + 网络隔离”

- 市场基数【已核实】：StatCounter 2026-09 中国桌面 Windows 版本份额 **Win11 53.81%、Win10 41.22%、Win7 4.46%**（全球 Win11 71.5%、Win10 27.77%）。<https://gs.statcounter.com/windows-version-market-share/desktop/china/>（CSV 接口抓取）
- 可行路径与覆盖：

| 路径 | 前提 | 无需管理员？ | 读隔离 | 网络隔离 | 对小律所的覆盖判断 |
|---|---|---|---|---|---|
| A. **MXC ProcessContainer（PSEC）**，Node SDK `@microsoft/mxc-sdk` 直接嵌入 Electron/Node 宿主 | Win11 24H2/25H2 ≥ 2026-08 累积更新（26H2/26H1 另有门槛），且 PSEC 未被禁用 | **是** | 是（原生 deny path 需能力探测） | 是（每容器 WFP，默认全拒，可只放回环代理） | 【推断】中国 Win11 份额约 54%，其中已到 24H2/25H2 且装了 8 月后更新者再打折；**2026Q4 约 30%–45% 的律所 Windows 机器可直接满足**，随 Win10 退场逐季上升。家庭版是否启用 PSEC：**未查到**，须探针 |
| B. classic elevated 类（专用低权限用户 + ACL + 防火墙/WFP） | 一次性 UAC；可建本地用户、可改防火墙 | 否（一次） | 是 | 是 | 个人笔记本的使用者通常就是本机管理员，**一次 UAC 同意在多数小律所可行**；风险在杀软拦截与安装失败率（见 1.5） |
| C. MXC Tier 3（AppContainer + DACL） | 一次性给 `C:\` 加 ACE + **每次开机**重设 `\Device\Null` 安全描述符（需提权计划任务） | 否 | 是 | 部分（与 PSEC 保证不等价） | 可作 Win10 的兜底，但需安装期装一个提权计划任务，运维复杂 |
| D. 受限令牌 + ACL（Codex unelevated 同类） | 无 | 是 | **否**（不支持 deny read） | **弱**（环境变量级） | 只能防误操作，**不能算强沙箱** |
| E. WSL2 / Windows Sandbox | 硬件虚拟化 + 管理员启用可选功能；Windows Sandbox 仅 Pro/Enterprise/Education，`wsb exec` 取不到输出 | 否 | 是 | 是 | 不适合作为默认路径 |

- **结论【推断，基于上表已核实事实】**：
  1. “无需管理员 + 读隔离 + 网络隔离”在 2026Q4 **只对一部分机器成立（估计 30%–45%，置信度中）**，即 Win11 24H2/25H2 已更新且 PSEC 可用者；Win10（约 41%）与旧 Win11 **不可能在零管理员前提下获得强网络隔离**。
  2. 若允许“安装时一次 UAC”，路径 B 或 C 可把强沙箱覆盖率拉到 **约 80%–90% 的 Win10/11 机器（置信度中低）**，代价是要自研 Windows 沙箱提供者（Codex 的 `windows-sandbox-rs` 为 Apache-2.0，可参考/移植，但其公开 issue 显示现场失败率不低）。
  3. 因此产品必须**按设备探测结果分级**：探到 PSEC → 本机强沙箱档；仅能 B/C → 需一次管理员授权；只剩 D → 只允许“只读/低风险”本机工具，**Shell/Python/联网类任务改到中软云端沙箱执行**（与 Claude Cowork 的做法同构）。
  4. MXC v1.0.0 刚于 2026-10-07 发布，Node SDK 可直接被 TypeScript 的 Kimi Code 宿主调用——这是 v7“Windows 沙箱只能自建”判断的**最大修正点**；但它是 10 天前的 1.0，必须做 360/火绒/电脑管家兼容探针、Git Bash/MSYS2 与 Python 在容器内可用性探针后才能写进承诺。

## Q2 Kimi Code 上游现状（GitHub REST API，2026-10-09 抓取）

### 2.1 Release / main / 关键 PR 与 issue【已核实】

- **Release**：最新仍是 `@moonshot-ai/kimi-code@2.1.1`（2026-09-24T07:24Z）；此前 2.1.0（09-23）、2.0.2（09-19）、2.0.1（09-18）、2.0.0（09-17）。**2.1.1 之后无新 release**；npm `@moonshot-ai/kimi-code` dist-tag latest = 2.1.1。<https://api.github.com/repos/MoonshotAI/kimi-code/releases?per_page=5>
- **main 最新 commit**：`419aced0e9`（2026-10-09T09:49:30Z）“fix(agent-core-v2): restore media tools after session resume (#4154)”。v8 记录的 `5b93669767`（10-08）之后又有 3 个提交：#4153（允许回合中进度说明）、**#4145 `feat(cli): launch desktop with kimi app`**（CLI 可拉起桌面端，说明上游正在把 CLI 与 Kimi 桌面应用打通）、#4154。<https://api.github.com/repos/MoonshotAI/kimi-code/commits?per_page=10>
- **PR #4115**（实验性 OS 沙箱 + exec-policy + 出网控制）：**open、未合并、非 draft**，最后更新 2026-10-03，+4829/−135，作者 `author_association = NONE`（外部贡献者）；关联 issue **#4114** 仍 open。（v7 记录其 Windows 无后端；本轮未重读 diff。）<https://github.com/MoonshotAI/kimi-code/pull/4115>
- **PR #4062**（SSH / Docker 远程执行环境，phase 1：创建时绑定）：**open 且为 draft**，+26552/−5938，作者为 **COLLABORATOR**（内部协作者），最后更新 09-30。→ 远程执行是上游自己在推进的方向，但规模大、尚未成型。<https://github.com/MoonshotAI/kimi-code/pull/4062>
- **#2337**（honor configured permission rules）：**仍 open、未合并**，最后更新 2026-10-07T21:09Z，+49/−7。<https://github.com/MoonshotAI/kimi-code/pull/2337>
- **#4070**（后台子 Agent 发起的审批不触发 PermissionRequest hook）：**仍 open**，最后更新 09-28。<https://github.com/MoonshotAI/kimi-code/issues/4070>

### 2.2 node-sdk / kap-server 是否发布 npm【已核实】

- `packages/node-sdk/package.json`：包名 **`@moonshot-ai/kimi-code-sdk`**，版本 0.20.0，**`"private": true`**（虽写了 `publishConfig.access = public` 与 provenance）。npm registry 查询 `@moonshot-ai/kimi-code-sdk` → **Not found**。
- `packages/kap-server/package.json`：包名 `@moonshot-ai/kap-server` 0.2.3，`"private": true`；npm → **Not found**。
- 含义：两者都只能**从源码 vendoring**（本项目已是此做法），不能靠 npm 语义化版本升级。

### 2.3 kap-server 的可注入点与路由规模【已核实，锁版 `f67e6398`】

- 入口 `packages/kap-server/src/start.ts:141` `startServer(opts: ServerStartOptions)`；选项定义 `start.ts:99-126`，可注入/可配置项：`host`、`port`、`homeDir`、`env`、`pluginMarketplaceUrl`、`configPath`、`instancesDir`、`logger`、`bindClass('lan'|'public')`、`allowedHosts`、`corsOrigins`、`disableHostCheck`、`insecureNoTls`、`authTokenService: IAuthTokenService`（可换鉴权）、`disableAuth`、`rpcToken`、**`seeds?: ScopeSeed`（`start.ts:120`，在 `:198-211` 以 `[...logSeed(logging), ...(opts.seeds ?? [])]` 透传进 `bootstrap`，后写覆盖先写——即可整体替换进程/文件系统/存储/检索等 DI 服务）**、`hostIdentity`（必填，白标）、`skillDirs`、`webAssetsDir`、`telemetry`。
- 远程控制硬约束：`start.ts:462-469`——非回环地址时报 “Remote Control requires a loopback host.”；与 `--dangerous-bypass-auth` 互斥。
- 路由规模：`src/routes/` 下 39 个文件/目录；v1 路由文件中声明的 HTTP 方法约 **105 个**，`routes/v2/` 另有约 **14 个**（按 `method: 'GET|POST|…'` 计数，近似值）；`registerApiV1Routes.ts` 共 237 行。

### 2.4 SDK 形态 vs kap-server 形态：能力差异（锁版源码）

| 能力 | node-sdk（`@moonshot-ai/kimi-code-sdk`） | kap-server | 判定 |
|---|---|---|---|
| 会话续接 | `kimi-harness.ts:168` `resumeSession()`；`:262` `forkSession()`；`:317` `exportSession()`；`:326` `listSessions()` | `routes/sessions.ts:182/273/403`（建/列/取会话） | 两者都有 |
| 子会话 / 子 Agent | 只有**事件**：`events.ts:75-81`（SubagentSpawned/Started/Completed/Failed/Cancelled/Suspended）；回放可 `includeSubagents`（`types.ts:276-277`）；**无列出/操作子会话的 API** | `routes/sessions.ts:650,709` `/sessions/{id}/children`（GET/POST） | kap-server 更完整 |
| 目标（Goal） | `session.ts:551-571` `createGoal/getGoal/pauseGoal/resumeGoal/cancelGoal` | `routes/sessions.ts:785` `/sessions/{id}/goal` | 两者都有 |
| 文件历史 | **无**（`node-sdk/src` 检索 file-history/rewind/checkpoint 无命中） | `routes/fileHistory.ts:38` `/file-history/changes`、`:79` `/file-history/content` | **仅 kap-server** |
| 快照 | **无**公开 API（仅内部 `IAgentLoopService.snapshot()` 状态读取，`sdk-rpc-client-v2.ts:1608`） | `routes/snapshot.ts:69` `/sessions/{id}/snapshot` | **仅 kap-server** |
| 提问（AskUserQuestion） | `session.ts:133` `setQuestionHandler()`（回调式） | `routes/questions.ts:68,102`（列出/作答，可持久、可跨端） | 两者都有；kap-server 适合“离开再回来作答” |
| 审批 | `session.ts:128` `setApprovalHandler()`（回调式） | `routes/approvals.ts:63,97`（列出/裁决） | 两者都有；同上 |
| 远程控制 | 无 | `routes/remoteControl.ts:51,69` | 仅 kap-server（且绑定 Kimi 登录，见 2.5） |

- 【推断】SDK 通过 DI/engineAccessor 理论上可触达文件历史等内部服务，但那是非公开接口，升级即碎；**要“完整接入 Kimi Code 后端能力”，kap-server 形态明显更省事**；SDK 形态适合“无界面的云端/批处理执行器”。

### 2.5 远程控制：是否端到端加密、是否必须 Kimi 会员登录【已核实】

- 中继固定 `https://code-rc.kimi.com`（`packages/remote-control/src/remote-control.ts:19`），可用环境变量 `KIMI_CODE_REMOTE_CONTROL_RELAY_URL` 改址（`:21,27`）。
- **必须 Kimi 登录**：`remote-control.ts:292-294` 读取 Kimi OAuth 令牌，缺失即抛错 “Remote Control requires a Kimi login. Run `kimi login` first.”；连接中继时以该令牌作 `Authorization: Bearer` / WebSocket 子协议 `kimi-code.bearer.<token>`（`:756,767`）。是否要求“会员”档位：源码只校验登录令牌，**会员资格由服务端决定，未查到**。
- **无端到端加密**：`packages/remote-control/src/`（仅 `index.ts lock.ts manager.ts remote-control.ts` 四个文件）检索 encrypt/decrypt/cipher/nacl/sodium/x25519/e2ee 等**零命中**；只依赖到中继的 TLS，中继可见明文流量（与 v7 判断一致）。
- 对发行版：不能用月之暗面中继（账号体系不同 + 明文中继）；自建中继需 E2E（如设备密钥对 + 会话密钥），且远程指令要单独授权。

## Q3 月之暗面开放平台当前可买的能力（platform.kimi.com/docs 的 `.md` 原文，2026-10-09 抓取）

### 3.1 联网搜索 / 网页抓取 REST 工具【已核实】

| 接口 | 价格 | 计费条件 | 关键限制 | 来源 |
|---|---|---|---|---|
| `POST /v1/tools/search`（Basic） | **¥0.01/次** | HTTP 200 且 `search_results` 非空 | `limit` 1–20；`timeout_seconds` 1–60；429 `project qps limit exceeded` | <https://platform.kimi.com/docs/pricing/websearch.md>、<https://platform.kimi.com/docs/api/tools-search.md> |
| `POST /v1/tools/search_pro`（Pro） | **¥0.015/次** | 同上 | 另支持 `sites`（≤5 个，OR）、`time_window`（YYYY/YYYY-MM/YYYY-MM-DD）、结构化 `chunks`、`authority` 来源权威性字段 | <https://platform.kimi.com/docs/api/tools-search-pro.md>、最佳实践页 |
| `POST /v1/tools/fetch` | **¥0.01/次** | HTTP 200 且 `markdown` 非空白 | 429 `project concurrency limit exceeded`；504 超时 | <https://platform.kimi.com/docs/api/tools-fetch.md> |

- 三者“相互独立、分别计费；失败或无结果不计费”。
- **限速**：联网搜索有独立的“联网搜索 QPS”额度，不占 RPM/TPM/TPD/并发；两个搜索接口分别计数（例如 Tier1 两者各 3 QPS）。<https://platform.kimi.com/docs/pricing/limits.md>
- **面向最终用户**：最佳实践页把 Basic 定位于“搜索结果展示……直接展示给用户时（搜索结果页、来源卡片）”，即官方预期可面向最终用户展示；服务协议“三、1”许可“仅供您内部使用或向最终用户提供服务”（见 3.4）。未见专门针对搜索结果再分发/缓存的额外限制条款【未查到】。
- **`$web_search` 内建工具**：¥0.03/次 + 搜索结果计入 token，“**预计于 2026 年 10 月 20 日下线**，新接入请使用 `/v1/tools/search` 接口或官方工具 `web-search`”。<https://platform.kimi.com/docs/pricing/websearch.md>
- 与 Kimi Code 的对接【推断，未实测】：Kimi Code `moonshot_search` 发送 `{"text_query"}`、解析 `search_results`，与 `/v1/tools/search` 字段同名；`limit/timeout_seconds` 为可选。路径与 Accept 头差异需一个适配层或配置 `base_url` 直指完整路径后实测（v7 已列为待验证，本轮仍无测试 Key）。

### 3.2 Files / 文件抽取【已核实】

- `purpose="file-extract"`：抽取为 Markdown；**单文件 ≤ 100 MiB；文件个数不限，改按组织总存储默认 10 GiB**；“文件解析服务限时免费，请求高峰期平台可能会有限流策略”；**图片不再支持 file-extract**（改用 `purpose="image"`）。<https://platform.kimi.com/docs/api/files-upload.md>
- 文件留存期 / 自动过期：页面未写明，文件需调用删除接口删除【未查到自动过期】。ZDR 是否覆盖 file-extract 文本文件：ZDR 页例外只点名“直接文件上传方式提交的图像或视频”与托管智能体，**未明说文本文件**【未查到】。

### 3.3 Kimi 托管智能体（Hosted Agents，Beta）【已核实】

- 定位：“在模型推理 API 之上封装 Kimi Durable Harness……7x24 小时全托管的环境”；**“Beta 版当前仅针对国内企业认证用户开放”**，需企业认证 + 联系销售。<https://platform.kimi.com/docs/hosted-agents/quickstart.md>
- 能力：内置工具“由平台在云沙箱中执行”，“平台提供隔离的云沙箱，可按需配置网络与依赖”（执行环境 = 预装依赖、网络访问策略、初始化脚本，镜像异步构建）；会话事件持久化可随时拉取；跨会话记忆库（项目级、带版本）；智能体版本冻结；取消/归档/删除语义清晰（只有已归档会话可删除）。<https://platform.kimi.com/docs/hosted-agents/faq.md>
- **数据留存**：“在服务器端存储对话历史、沙箱状态和输出。因此，托管智能体目前**不符合「零数据保留」**的覆盖条件”；ZDR 页同样把托管智能体列为例外。
- **价格**：云沙箱 **1 核 CPU / 1 GB 内存 ¥0.072/小时，按运行时长、最小按秒计费**；模型 token 按所选模型价；插件按千次计（如“联网搜索”¥30/千次，“天眼查-ta”等 ¥20/千次）。<https://platform.kimi.com/docs/pricing/hosted-agents.md>

### 3.4 ZDR 与服务协议原文要点【已核实】

- **ZDR**（<https://platform.kimi.com/docs/guide/zero-data-retention.md>）：开通后请求内容“响应返回后即行清除，不做留存（法律法规要求除外）”；“企业客户数据不用于模型训练”；“Kimi 开放平台默认不使用企业客户数据训练模型，ZDR 在此基础上进一步取消内容留存”；内容安全审核照常，滥用可终止 ZDR；**“按需开放给企业客户……联系销售申请评估”**；接口/参数/计费不变；平台不保留内容故无法回溯排查。**例外**：直接上传的图像或视频、托管智能体数据“零数据留存无法保证”；安全日志、账单等运营数据不在零留存范围；第三方模型、连接器、插件不受约束。
- **服务协议**（《Kimi 开放平台服务协议》，更新 2026-08-24，生效 2026-08-31；<https://platform.kimi.com/docs/agreement/modeluse.md>）：
  - **三、1（即“第 3.1 款”）**：“我们许可您以调用接口的形式使用本服务。该许可为**非排他的、不可转让、不可再许可**的普通许可，本服务**仅供您内部使用或向最终用户提供服务**。”且“您不得转让本条款下的任何权利或义务”。→ 中软以自有产品向律所提供服务属于“向最终用户提供服务”；**把 API Key/额度直接分给律所（再许可）不在许可内**。
  - **六、3（即“第 6.3 款”，位于“六、知识产权”）**：“为了提升您使用本服务的体验，您授予我们一项免费的使用权，以在法律允许的范围内将您输入输出之内容及反馈用于**模型服务优化**。”→ 与 ZDR“默认不用于训练”措辞不同，需在企业合同中明确排除（v7 已提示，本轮原文复核一致）。
  - 六、4：未经同意不得使用月之暗面商标或将其列为案例/合作对象公开披露。
- **企业版 / 并发等级**（<https://platform.kimi.com/docs/pricing/limits.md>，按累计充值）：

| 等级 | 累计充值 | 并发 | RPM | TPM | TPD | 联网搜索 QPS |
|---|---|---|---|---|---|---|
| Tier0 | ¥0 | 1 | 3 | 500,000 | 1,500,000 | 1 |
| Tier1 | ¥50 | 15 | 100 | 2,000,000 | Unlimited | 3 |
| Tier2 | ¥100 | 40 | 100 | 3,000,000 | Unlimited | 5 |
| Tier3 | ¥500 | 50 | 200 | 3,000,000 | Unlimited | 10 |
| Tier4 | ¥5,000 | 60 | 200 | 4,000,000 | Unlimited | 20 |
| Tier5 | ¥20,000 | 100 | 300 | 5,000,000 | Unlimited | 50 |

  【推断】Tier5 的 **100 并发 / 300 RPM** 对“多律所 × 多子 Agent”的 SaaS 明显不够（一个任务的子 Agent 集群即可占 5–20 并发），**必须走企业协议提额**，并在中软网关做并发排队与租户配额。

### 3.5 是否存在面向企业的“Kimi Code API / Agent API / 席位转售”官方渠道

- **Kimi Code API**：官方明说“**Kimi Code API 与本平台提供的 API 服务相互独立，不通用**”，Kimi Code 为“订阅制”（<https://platform.kimi.com/docs/guide/product-plans.md>）；Kimi Code FAQ 列明 Kimi Code 走 `api.kimi.com/coding/`、按“Kimi 会员订阅（含额度）”计费、在 Kimi Code 控制台建 Key（<https://www.kimi.com/code/docs/kimi-code/faq.html>）。**未查到面向企业/伙伴的 Kimi Code API 商用或转售条款。**
- **Agent API**：唯一的一手形态是**托管智能体 API（Beta，国内企业认证）**，见 3.3。
- **席位**：Kimi Business “按年度订阅付费，5 座起售”（product-plans 页）；**未查到席位转售/代理渠道的一手说法**；服务协议“三、1”的“不可再许可”与之相冲突，须走单独商务协议。

## Q4 境内云端 Agent 沙箱服务（为“律所授权后在中软云端执行”评估）

> 本轮检索条件说明：WebSearch/WebFetch 工具当日不可用（返回模型错误），改用 curl 直取一手页面；阿里云帮助中心、火山引擎文档、腾讯云文档详情页均为前端渲染，curl 取不到正文，搜索引擎接口又被限流。因此**阿里云 AgentRun / 无影 AgentBay、火山引擎 veFaaS 沙箱、腾讯云沙箱的计费单价本轮未取得一手数据**，下表只写取到的一手内容，其余标【未查到】，不以记忆补数。

| 服务 | 隔离技术 | 冷启动 | 计费 | 私网/无网 | 等保/数据不出境 | 来源与状态 |
|---|---|---|---|---|---|---|
| **月之暗面 托管智能体云沙箱**（境内） | “隔离的云沙箱”，具体虚拟化技术未披露 | 镜像创建后异步构建；会话冷启动未披露 | **1 核/1 GB ¥0.072/小时，按秒** | 执行环境可配“网络访问策略”（v7 记录有 `route_all`/白名单出网） | 不符合 ZDR；等保说明未查到 | 【已核实】见 Q3.3 |
| **腾讯云 Agent Runtime（含 Agent 沙箱）** | 产品页：“安全隔离：资源隔离、零信任、零凭证”；具体技术（microVM/安全容器）产品页未写 | 产品页宣称“**100 毫秒**毫秒级极速启动”“数十万实例/分钟”“serverless + 常驻” | 【未查到】（文档 1814 系列页面为前端渲染） | 【未查到】 | 【未查到】 | 【已核实·仅产品页】<https://cloud.tencent.com/product/ags>（页面标题“Agent Runtime_Agent沙箱_Agent网关”，文档目录 `cloud.tencent.com/document/product/1814`） |
| 阿里云 函数计算 AgentRun / 无影 AgentBay | 【未查到】 | 【未查到】 | 【未查到】 | 【未查到】 | 【未查到】 | 页面前端渲染，未取到正文 |
| 火山引擎 veFaaS 沙箱 / AI 沙箱 | 【未查到】 | 【未查到】 | 【未查到】 | 【未查到】 | 【未查到】 | 同上 |
| **E2B（境外 SaaS，可自托管）** | Firecracker microVM，支持从快照恢复（infra README） | 未在定价页给出 | **按运行秒计费：vCPU $0.000014/s（≈$0.050/vCPU·h），内存 $0.0000045/GiB·s（≈$0.016/GiB·h）**；Hobby 免费额度、会话≤1 小时、20 并发；Pro $150/月 + 用量、会话≤24 小时、100 并发可扩至 1,100；Enterprise 支持 **BYOC** | 自托管时由部署者决定 | 境外 SaaS 不适用于律所数据；自托管则落在中软云 | 【已核实】<https://e2b.dev/pricing>；<https://github.com/e2b-dev/infra>（**Apache-2.0**，“The same code serves the public cloud, dedicated enterprise…”） |
| 自建：Firecracker / gVisor / Kata | Firecracker = 开源 microVM 虚拟化（README）；Kata = “lightweight Virtual Machines”，Apache-2.0（README）；gVisor = 用户态应用内核（README 本轮未取到关键句，按公认事实） | Firecracker 毫秒级启动为公认指标，本轮未逐字复核 | 只付 IaaS（需裸金属或支持嵌套虚拟化的实例才能跑 Firecracker/Kata）【推断】 | 完全可控（无网/仅代理出网） | 取决于中软云资质 | 【部分已核实】raw README |

### 4.1 “每任务一个 microVM/容器”的大致单价区间【推断，基于上表一手单价】

- 一手锚点：月之暗面云沙箱 **¥0.072 / 核·时（含 1 GB）**；E2B **≈ $0.050 / vCPU·时 + $0.016 / GiB·时**（按 1 USD ≈ 7.1 CNY 折算约 **¥0.36 / vCPU·时 + ¥0.115 / GiB·时**）。
- 由此给出国内云上**托管型 Agent 沙箱的合理区间：约 ¥0.07–0.5 / vCPU·时（含 1–2 GiB 内存）**；自建 Firecracker/Kata 在中软自有或包年云主机上，摊薄后可落在该区间下沿（未取得国内云主机一手报价，仅推断）。
- 单任务估算：2 vCPU / 4 GiB、运行 15 分钟 → 按 E2B 价约 ¥0.30，按月之暗面沙箱价约 ¥0.04；**即单任务沙箱算力成本在“几分钱到三毛钱”量级，远低于同一任务的模型 token 成本**（v7 测算一次长任务 token 成本以元计）。**云端执行的瓶颈不是算力费，而是数据出所授权、冷启动/镜像体积、并发配额与合规资质。**

---

## 对云地划分的工程结论

1. **本机强沙箱覆盖率风险（高）。**
   - 已核实：Claude Code 在原生 Windows 不沙箱、只推 WSL2；Claude Cowork 把代码执行放到云端隔离环境；OpenAI Codex 的 classic elevated 沙箱需一次管理员授权且现场失败 issue 多；微软 2026-08 才在 Win11 24H2/25H2 推出 MXC 进程隔离，SDK 10-07 才 1.0。
   - 推断：2026Q4 小律所 Windows 机器中，**零管理员即可获得“读隔离 + 网络隔离”的约 30%–45%**（Win11 24H2/25H2 已更新且 PSEC 可用）；允许一次 UAC 后可到约 80%–90%，但要自研 Windows 沙箱提供者（可参考 Apache-2.0 的 Codex `windows-sandbox-rs`），并承担 360/火绒/电脑管家兼容风险（公开报告未查到，需自测）。
   - 设计含义：本机执行必须**按设备能力分级**（PSEC 强档 / 一次授权强档 / 弱档），弱档设备上 Shell、Python、联网类工具**默认改由云端沙箱执行**，本机只保留文件读写（经受限文件系统）与 Office/浏览器“手”的能力——与 Claude Cowork 的“云端执行 + 本机代理”同构。
   - 首选技术：**MXC Node SDK（`@microsoft/mxc-sdk`，MIT）直接接入 Kimi Code 的 `IHostProcessService` DI 注入点**（PSEC 可用时），否则回落自研 elevated 类实现；Windows 上的 bash 运行时（Git Bash/MSYS2）与 Python 在 MXC/AppContainer 内的可用性是第一号探针。

2. **kap-server 与 SDK 二选一：桌面端选 kap-server，云端执行器选 SDK（或同样跑 kap-server）。**
   - 已核实：文件历史（`routes/fileHistory.ts:38,79`）、快照（`routes/snapshot.ts:69`）、子会话列表/操作（`routes/sessions.ts:650,709`）、可持久的审批/提问队列（`routes/approvals.ts:63,97`、`routes/questions.ts:68,102`）**只有 kap-server 有**；SDK 只有回调式审批/提问与子 Agent 事件；两者都有续接、分叉、目标。两者都不在 npm（`private: true`），都需 vendoring；kap-server 的 `seeds`（`start.ts:120,198-211`）与 `authTokenService` 足以替换进程/文件/存储/检索服务与鉴权。
   - 建议：**桌面端以 kap-server 为 Agent 后端（回环绑定 + 自有令牌 + 关闭其远程控制路由）**，通过 `seeds` 注入“沙箱进程服务 + 事项受限文件系统 + 加密存储 + 中软检索/抓取”；云端执行器可用 SDK 形态（无界面、批处理），若要在云端也提供文件历史/快照，则同样跑 kap-server。不要再走“SDK + 只开法律 MCP”的窄路。
   - 上游风险：#4115（OS 沙箱）是外部贡献、未合并且无 Windows 后端；#4062（SSH/Docker 远程执行）是内部 draft；#2337、#4070 仍 open——这些都不能作为排期依赖，需自补。

3. **云端沙箱成本与可用性。**
   - 已核实一手单价：月之暗面托管智能体沙箱 ¥0.072/核·时（但**不符合 ZDR**、Beta、仅国内企业认证）；E2B 约 $0.05/vCPU·时（境外，不可用于律所数据，但其 infra Apache-2.0 可自托管）。腾讯云 Agent Runtime 产品页宣称 100 ms 启动与资源隔离，价格未取到；阿里云、火山引擎的同类产品本轮未取到一手数据。
   - 推断：单任务沙箱算力约 ¥0.04–0.3，**不构成成本瓶颈**；关键是 (a) 律所授权的数据出所路径与留存；(b) 用自托管 E2B/Firecracker/Kata 或境内云厂商 Agent 沙箱时的冷启动与镜像预热；(c) 等保/数据不出境资质——三家国内云的等保与数据驻留说明本轮均**未查到**，须在采购前逐家索取。
   - 不建议把律所案件数据放进月之暗面托管智能体（非 ZDR、服务端持久化会话与沙箱状态）。

4. **必须由中软云补位的能力（只买开放平台 token 时）。**
   - **检索与抓取**：开放平台已提供 `/v1/tools/search`（¥0.01）、`search_pro`（¥0.015）、`fetch`（¥0.01），可在中软网关封装成 Kimi Code `moonshot_search/moonshot_fetch` 兼容端点（字段一致、路径/Accept 需适配，待实测）；`$web_search` 10-20 下线，不得再用。
   - **账号/身份、远程控制中继（必须 E2E，上游中继需 Kimi 登录且无 E2E）、插件/技能分发与更新、遥测替代、法律数据源（元典等需自签）**：上游均绑定 Kimi 账号云，开放平台不提供。
   - **云端执行沙箱**：弱档 Windows 设备上的 Shell/Python/联网任务、关机后需续跑的长任务、子 Agent 集群的重计算——由中软云自建沙箱池（推荐自托管 E2B/Firecracker 或境内云 Agent 沙箱），不用月之暗面托管智能体处理案件数据。
   - **并发与配额网关**：开放平台 Tier5 仅 100 并发/300 RPM，SaaS 必须企业提额 + 中软网关做租户排队、预算与计量；服务协议“三、1”不可再许可，Key 只能留在中软云端，律所客户端只拿中软短期令牌。
   - **合同补强**：服务协议“六、3”授予月之暗面“模型服务优化”使用权，须在企业协议/ZDR 中明确排除；ZDR 对 file-extract 文本文件是否覆盖未写明，须书面确认。

## 本轮未查到 / 待探针清单

1. MXC PSEC 在 Windows 11 **家庭版**上是否启用；Git Bash/MSYS2、Python、Office 自动化在 MXC ProcessContainer 内的可用性。
2. 360 安全卫士、火绒、腾讯电脑管家对 MXC / 专用低权限用户 / 防火墙规则 / AppContainer 的拦截行为（无公开报告，需实测）。
3. Kimi Work、千问办公在 Windows 上的本机隔离机制（官方未披露）；WorkBuddy“沙箱安全”的 OS 级实现（官方未披露）。
4. 阿里云 AgentRun / AgentBay、火山引擎 veFaaS 沙箱、腾讯云 Agent Runtime 的单价、私网/无网配置、等保与数据驻留说明。
5. Kimi Code `moonshot_search/moonshot_fetch` 直连开放平台 `/v1/tools/*` 的兼容性（需测试 Key）。
6. 开放平台 file-extract 文件的留存期与 ZDR 覆盖范围；Kimi Code API、席位转售的商务渠道（只能通过商务确认）。
