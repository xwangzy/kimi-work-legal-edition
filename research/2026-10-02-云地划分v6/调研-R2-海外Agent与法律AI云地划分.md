# 调研 R2：海外 AI Agent 办公产品与法律 AI 产品的「云端执行 vs 本地执行」划分

- 调研日期：2026-10-02
- 调研目的：为「Kimi Work 法律行业发行版」（本机 exe + 云端模型 token）的云地划分提供一手依据
- 纪律：只写有出处的事实；每条标注来源 URL 与访问日期（均为 2026-10-02 访问，除非另注）；【一手】= 厂商官方文档/官网/官方博客；【二手】= 媒体/第三方；查不到写「未查到」。

## 要点速览（10 条，详见各节出处）
1. Anthropic Cowork 已从「本机执行」转向「默认云端执行」：Pro/Max 自 2026-10-06 起新任务一律上云、移除「Only on your computer」；Enterprise 云会话默认关。（A1）
2. Cowork 本机形态 = Agent 循环在本机 + 代码在 Hyper-V/Apple VF 的 Linux VM；但本机会话历史「admins cannot centrally manage or delete it」，VM 对 EDR 不可见。（A1）
3. 定时任务、手机派活等常在线能力都放在云端：Cowork 定时任务「run remotely」且不能绑定本机文件夹；靠本机常开的 Dispatch 已对新用户停用。（A1）
4. Claude Code「自托管环境」= 云端控制面排队 + 客户网内 runner 执行 + 仅出站连接（「Anthropic never connects into your network」），是「控制面/执行面分离」的标准样板。（A1.5）
5. OpenAI 把任务拆为「协调（云）+ 执行（本机/云容器/云电脑）」，并明说「Local execution does not mean offline or device-only model inference」「Neither experience provides strict zero data retention」。（A2）
6. 微软走 OS 原生路线：独立 agent 账户 + agent workspace + ACL + 签名吊销；控制面在 Agent 365/Entra Agent ID/Purview。（A3）
7. 海外 7 家法律 AI 头部全部是云 SaaS（Harvey/Legora 在 Azure），无本机执行或私有化选项（本轮未查到）；Word/Outlook 加载项只是 UI，文本仍上云。（B5–B7）
8. 律所接受云端的「信任包」：不训练合同 + 模型侧 ZDR（TR 还关闭滥用监控、以 TR 身份匿名调用）+ BYOK + 区域驻留 + 伦理墙同步（Harvey「never creates, modifies, or deletes walls」）+ SOC 2/ISO 27001（Legora 加 ISO 42001）。（B5–B7）
9. ABA 512 的判据是「谁能访问输入信息」和「是否自学习跨客户复用」，并要求非模板化知情同意；Law Society 看「direct control and oversight」——看重控制权，不看物理位置。（B8）
10. 可迁移：仅出站的律所侧 runner/协调器、沙箱×审批两层权限与严格默认值、端点下发策略、模型侧 ZDR + 匿名调用、伦理墙同步；不宜照搬：云端常驻/云定时、靠个人电脑常开的遥控、借本机浏览器登录态的扩展。（C3–C4）

---

## A1. Anthropic：Claude Cowork / Claude 桌面 / Claude Code

> 最重要的新变化（一手）：**Anthropic 正在把 Cowork 从「本机执行」整体转向「云端执行」**。Help Center 原文：「Cowork sessions run in the cloud by default: the agent loop and code execution run on Anthropic's servers… Local execution remains available for existing desktop deployments」。Pro/Max 计划自 **2026-10-06** 起新任务一律在云端跑，「Only on your computer」选项被移除；需要「留在一台机器上」的工作被引导去用桌面版 Claude Code。Team 计划云端会话默认开，**Enterprise 默认关**（需 Owner 开启并按自定义角色授予）。

### A1.1 Cowork：Agent 循环在哪跑（两种形态并存）

| 维度 | 云端会话（2026-09 起默认） | 本机会话（存量桌面部署） |
|---|---|---|
| Agent 循环 | Anthropic 托管的隔离临时沙箱，每会话一个，结束即销毁 | 「runs natively on the device」，含对话处理、已连接文件夹读写、web fetch、本地插件 MCP |
| 代码/Shell 执行 | 同一云沙箱 | 本机专用 Linux VM，经系统虚拟化隔离（macOS 用 Apple Virtualization.framework，Windows 用 Hyper-V），VM 自带出口过滤、syscall 限制、按会话用户隔离 |
| 本机文件 | 经 Claude Desktop 通过「Anthropic-brokered connection」回取，**只限用户已连接的文件夹**，每次本地工具调用前按用户权限检查；桌面 App 离线则云会话够不到设备；任务需要本地文件时只拉取该文件副本到云端，删除会话即删副本 | 只能访问已连接文件夹；应用层权限系统强制「connected-folder rules」与组织出口设置 |
| 网络出口 | 默认不能访问客户内网、私网/链路本地/云元数据地址；所有流量走沙箱外强制代理，「only allow-listed destinations are reachable」；Enterprise 默认「无网络访问」 | 遵循组织 Code execution 网络出口设置；注意：出口设置**不覆盖** web fetch/web search（服务端执行）和 MCP（含 Claude in Chrome） |
| 凭据 | 沙箱只持有数小时内过期的会话级 token；**连接器授权 token 不进沙箱，连接器调用在服务端发起** | — |
| 数据存放 | 会话与文件存于用户的 Claude 账户（云端）；租户在数据层隔离 | 对话历史存本机，「not subject to Anthropic's standard data retention policies, and admins cannot centrally manage or delete it」；Enterprise 可经 Compliance API 取回，本地会话删除接口「aren't available yet」 |
| EDR 可见性 | 云会话完全在端点之外，EDR 看不到 | VM「isolated from host-based security tools by design」，EDR 也看不到 VM 内活动 |

- 来源【一手】：Claude Cowork architecture overview，https://support.claude.com/en/articles/14479288-claude-cowork-architecture-overview （页面显示「Updated over 2 weeks ago」，访问 2026-10-02）
- 来源【一手】：Use Claude Cowork on Team and Enterprise plans，https://support.claude.com/en/articles/13455879-use-claude-cowork-on-team-and-enterprise-plans （Updated this week）
- 来源【一手】：Use Claude Cowork on web, desktop, and mobile，https://support.claude.com/en/articles/15520349-use-claude-cowork-on-web-desktop-and-mobile （Updated yesterday）
- 官方安全口径原话：「This infrastructure is kept separate from Anthropic's corporate, research, and model-training environments.」「Anthropic never connects into your network」（后者见 Claude Code 自托管环境文档）。

### A1.2 常在线能力在哪执行
- **定时任务（Scheduled tasks）**：「Scheduled tasks run remotely, so they run on their cadence even when your computer is asleep or the Claude Desktop app is closed」；「They can't be tied to a folder on your computer」。10-06 后 Pro/Max 的定时任务也迁云端，用到本机文件的任务需桌面 App 在线。→ **定时 = 云端**。来源【一手】https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-claude-cowork （Updated this week）
- **Dispatch（手机遥控桌面）**：「Dispatch runs your tasks on your desktop, so your computer needs to be awake and the Claude Desktop app open」；**「Dispatch isn't available to new users」**——已被云端会话替代。来源【一手】https://support.claude.com/en/articles/13947068-assign-tasks-from-anywhere-in-claude-cowork
- **浏览器**：内置浏览器或用户自己的 Chrome 扩展，「Browser traffic comes from the user's machine… even when the session is steered from web or mobile」（即云端大脑 + 本机浏览器出网）。来源同 13455879。

### A1.3 权限与审批（Cowork）
- 组织级开关：Cowork 总开关；「Run Cowork in the cloud」独立开关（Team 默认开 / Enterprise 默认关）；「Allow Automatically approve mode」（默认开）；「Allow "Always allow" for connector tools」（**默认关**，关时写类连接器工具必须逐任务审批；只读豁免仅限连接器显式标注 read-only 的工具）；Enterprise 自定义角色与上述设置叠加时「the most restrictive layer wins」。
- 云会话额外：可关闭持久化 always allow、可要求可信设备登记 + 近期登录。
- MDM 设备级键：`isLocalDevMcpEnabled=false` 禁本地 MCP；`isDesktopExtensionEnabled=false` 禁 MCPB/DXT 扩展。
- 来源【一手】同 14479288、13455879。

### A1.4 企业治理（Cowork/Claude 平台）
- 审计：Cowork（Claude/Desktop/Mobile）进入 **Compliance API**；**OpenTelemetry** 可把工具调用、文件访问、人工审批决定流向 SIEM，但「It doesn't replace audit logging for compliance purposes」。来源 13455879。
- Help Center 目录中可见的企业能力条目（一手，目录标题）：SSO/JIT/SCIM、Audit logs、Compliance API、自定义数据保留、US-only inference、IP allowlisting、Tenant Restrictions、**CMEK（客户管理密钥）**、Inference hooks、HIPAA-ready Enterprise。来源：https://support.claude.com 侧栏目录（访问 2026-10-02），如 https://support.claude.com/en/articles/15505325-what-are-customer-managed-encryption-keys-cmek 、https://support.claude.com/en/articles/10440198-configure-custom-data-retention-controls-for-enterprise-plans 。（各条细节未逐一展开，未查到更多。）
- 提示注入口径：「the risk of prompt injection attacks is non-zero」，建议用户「Avoid granting access to files with sensitive information」。来源 13455879。

### A1.5 Claude Code：本机 vs 云端（Claude Code on the web）vs 自托管 Runner
- **本机**：终端/IDE/桌面 App 选 Local 时「runs on your own machine」；可用 Remote Control 从手机/浏览器遥控本机会话。
- **云端会话**：「runs on cloud infrastructure instead of on your machine. By default it runs on infrastructure Anthropic manages, or on your organization's self-hosted environment」；每会话独立 VM；GitHub 凭据加密存 Anthropic 服务端、「never enter a session's VM」，经 GitHub proxy 在服务端附加凭据；**ZDR 组织不能用云会话功能**。定时/触发型「Routines」每次都以云会话执行。来源【一手】https://code.claude.com/docs/en/claude-code-on-the-web （.md 版，访问 2026-10-02）
- **自托管环境（Self-hosted environments，Team/Enterprise 公测，默认关）**：控制面在 Anthropic，执行面在客户网络。原文：「Anthropic's control plane places the session on your environment's queue, where a runner claims it… starts a Claude Code process on your host」；所有连接均为客户侧**出站** HTTPS 到 api.anthropic.com（队列轮询、事件流、推理），「Anthropic never connects into your network」；一个 runner 同一时间只服务一个 owner，「checked-out code never mixes between owners」；**同样不支持 ZDR 组织**。来源【一手】https://code.claude.com/docs/en/self-hosted-environments
- **权限模式**（一手原表）：`default`（Manual，仅读免确认，适合敏感工作）/ `acceptEdits`（读+文件编辑+常见文件命令）/ `plan`（只读+分类器批准的命令）/ `auto`（全部，后台安全检查）/ `dontAsk`（仅预批准工具，其余一律拒绝，适合锁定的 CI）/ `bypassPermissions`（全部，「Isolated containers and VMs only」）。来源 https://code.claude.com/docs/en/permission-modes
- **本机 sandbox**：macOS 用 Seatbelt，Linux/WSL2 用 bubblewrap + socat；网络「No direct route out」，经本机代理按 allowedDomains（默认空）放行。来源 https://code.claude.com/docs/en/sandboxing
- **策略下发**：Server-managed settings（Anthropic 服务端下发，启动时拉取、会话中每小时刷新，适合无 MDM）vs Endpoint-managed settings（MDM/注册表/文件，可在 OS 层防篡改，「stronger security guarantees」）；端点下发的设置**到不了** Anthropic 托管的云会话。来源 https://code.claude.com/docs/en/server-managed-settings

**小结（A1）**：Anthropic 的划分是「控制面（身份、策略、审计、调度队列、连接器凭据）永远在云端；执行面三选一：本机 VM / Anthropic 云沙箱 / 客户自托管 runner」。2026 年下半年的方向是**消费级与 Team 往云端执行收敛**（为了常在线、定时、跨设备），**Enterprise 默认仍关云会话**，并提供自托管 runner 作为「云端控制面 + 客户侧执行」的折中。

---

## A2. OpenAI：ChatGPT Work（Work Local / Work Cloud）、dots、Codex

> 2026 年的 OpenAI 产品已把「ChatGPT agent（2025 年的云端虚拟电脑）」演进为 **ChatGPT Work**（官方帮助文章 20001275，二手资料称 2026-07-09 发布，见 https://rywalker.com/research/chatgpt-work 【二手】；help.openai.com 对 curl/WebFetch 返回 403，未能直接读取）与常在线代理 **dots**（GPT-6 Astra 驱动）。企业侧文档集中在 developers.openai.com/codex/enterprise/*（一手，访问 2026-10-02）。

### A2.1 核心架构概念：「协调（coordination）」与「执行（execution）」拆开
- 官方原文：「A task has two parts: coordination and execution. Coordination decides which steps to take and keeps the conversation moving. Execution is the work performed by a tool, such as running a shell command. This feature moves coordination into OpenAI's cloud. It does not move every tool or file off the computer.」来源【一手】https://developers.openai.com/codex/enterprise/cloud-local-access
- 三种形态：
  1. **Work Local**：「When members select Local, both coordination and execution continue to happen locally」——经 ChatGPT 桌面 App 使用本机文件、本机应用（Computer Use）、本机浏览器。
  2. **Work Cloud**：「Cloud execution runs supported steps on OpenAI-managed infrastructure」；云容器 + 云浏览器（与用户本地浏览器隔离，不继承登录态；**Enterprise/Edu 不允许云浏览器登录网站**；企业须管理员开启云浏览器）。「Local Work can use the computer's tools and files. Cloud Work cannot use the computer.」
  3. **Local computer access with Work Cloud**（混合）：云端协调 + 已连接电脑执行需要本机的步骤；电脑离线时新一轮可回落到云容器，但「cannot access files or tools on the unavailable computer. It also does not enforce enterprise requirements from local execution」；「A task cannot switch from local execution to the cloud during a turn」。**企业默认：「the in-app Local/Cloud toggle and its default remain unchanged at launch」**；该能力嵌套在 Work Cloud 之下，须 Owner 单独开启。
- 来源【一手】https://developers.openai.com/codex/enterprise/chatgpt-work-overview ；https://developers.openai.com/codex/enterprise/cloud-local-access

### A2.2 「本地执行 ≠ 数据不出机」——官方明确口径
- 「Local files can remain on the device, but relevant file excerpts, prompts, screenshots, browser content, or tool results may be sent to OpenAI services to complete a task. **Local execution does not mean offline or device-only model inference.**」来源【一手】https://developers.openai.com/codex/enterprise/chatgpt-work-local-security
- 「Local execution does not mean that the conversation or task context stays only on the device.」来源 chatgpt-work-overview。
- 「Neither experience provides strict zero data retention… If a workflow requires no retained data, do not enable it for these experiences.」「deleting a conversation does not remove every related copy.」来源 cloud-local-access。

### A2.3 权限与审批
- **双层模型**：Sandbox mode（技术上能写哪、能否联网）+ Approval policy（何时必须停下问人）。本机 CLI/IDE/桌面 App 由 OS 级机制强制，默认「no network access and write permissions limited to the active workspace」；Auto 预设 = `--sandbox workspace-write --ask-for-approval on-request`；`untrusted` 审批策略已退役。破坏性 App/MCP 工具（带 destructive 注解）「always require approval」。来源【一手】https://developers.openai.com/codex/sandbox
- **Codex Cloud（Legacy）**：OpenAI 托管隔离容器；两阶段运行——setup 阶段可联网装依赖，agent 阶段默认离线；云环境 secrets「available only during setup and are removed before the agent phase starts」。来源同上。
- **异步安全监控**：GPT-6 Astra 在 Codex 与 ChatGPT Work 中异步监控，可暂停任务；在 **ZDR / Modified Abuse Monitoring / 非美国数据驻留**的工作区，「Full findings and resume aren't available. The task ends.」来源同上。
- **本机 Computer Use**：访问受该应用自身权限约束；管理员可限制 Computer Use 可操作的本机应用、是否允许保存应用审批；「A user approval cannot override an administrator's denial」；macOS「Locked Use」可临时解锁 Mac 执行可信 Computer Use 回合，检测到本地输入即重新上锁。来源 chatgpt-work-local-security。

### A2.4 策略下发与优先级（控制面）
- 管理台「**Agent Security**」（取代 Policies & Configuration）：Global 基线 + Local 覆盖；「Requirements set limits users cannot override. Defaults provide starting values」。
- 协调层（云）执行 Global 中的审批要求、Web 搜索模式；本机执行层执行 Agent Security 本地要求 + 设备策略（含文件系统与网络限制）；云容器/dots 云电脑用**另一套**执行控制，「Local filesystem and network restrictions do not automatically apply to these cloud environments」。
- 本机优先级：macOS MDM → legacy managed_config.toml → Agent Security 云下发要求 → 系统 requirements.toml。
- **企业 Hooks**：管理员定义的 **remote MCP hooks 运行在云端协调器上**，在任务/工具事件时回调客户的 MCP 服务；但「MCP hooks do not provide a complete Compliance API audit trail」。
- 数据驻留/EKM：Work 的驻留仅覆盖「eligible content and supported workloads」；EKM 覆盖受支持的存储内容；**若任何云策略开启 enforce_residency，则「Allow local computer access」对 Work 和 dots 都不可用**；dots 企业 beta 不支持数据驻留/推理驻留，**开了 EKM 的工作区不可用 dots**。
- 来源【一手】cloud-local-access、chatgpt-work-overview；企业文档目录另有 roles-and-workspace-permissions、groups-and-provisioning、compliance-api、managed-configuration 等页面（https://developers.openai.com/codex/enterprise/admin-setup 侧栏，细节未展开）。

### A2.5 常在线能力在哪执行
- **dots**：「your dot lives in the cloud and has its own computer and browser. You can reach it and it can keep working even when your computer is off」；可在 ChatGPT、**Slack、Teams**、电话里触达同一个 dot；可自主决定何时暂停/唤醒，可起后台子代理并行。来源【一手】https://developers.openai.com/codex/dots
- **定时任务（Automations/Scheduled）**：Web 端定时任务在云端；**桌面 App 的定时任务可在本机项目目录或隔离 worktree 中运行，需保持电脑开机**；Team Tasks「run in the cloud through the team's service account」。来源【一手】https://developers.openai.com/codex/automations
- **Codex Cloud**：「Each task has its own workspace and can keep working while your computer is asleep」。来源【一手】https://developers.openai.com/codex/cloud

**小结（A2）**：OpenAI 与 Anthropic 殊途同归——**云端「协调器/编排器」+ 可插拔执行器（本机电脑 / 云容器 / 云电脑）**；控制面（Agent Security 策略、审批、Web 搜索模式、hooks、审计）挂在云端协调器上；本机执行器另受 MDM/本地 requirements 约束。对监管型客户的显式让步：企业默认不改 Local/Cloud 开关；开启数据驻留则禁用「本机 + 云协调」混合；明确告知「本地执行不等于数据不出机」「不提供严格零保留」。

---

## A3. Microsoft：Windows 本机 Agent（agent workspace / agent account）、Copilot Studio computer use、Agent 365

### A3.1 Windows 本机 Agent 的隔离模型（OS 级）
- **Agent account**：「A separate standard account on your device that agents use when acting on your behalf, enabling agent-level authorization and access control」；Copilot Actions 驱动的应用与动作「run under the agent account instead of the account of the signed-in PC user」，与人类用户的操作在系统层可区分；仅在用户开启 agent workspace 时才创建。
- **Agent workspace**：「A contained environment where agents can work in parallel with a human user, enabling runtime isolation and granular permissions」，给 Agent 自己的桌面，同时限制它对用户桌面活动的可见性；「built on recognized security boundaries that Microsoft defends in accordance with our longstanding security servicing criteria」。
- **最小权限**：预览期 Agent 只能访问有限的「known folders」（Documents、Downloads、Desktop、Pictures）及所有账户都能访问的资源，超出需用户授权；依赖 Windows ACL；「no ability to make changes to your device without your intervention. You can revoke this access at any time」。
- **运营信任**：集成 Windows 的 Agent「must be signed by a trusted source」，可经证书校验、杀软吊销/拦截。
- **用户透明**：用户可授权、监视、随时接管；敏感操作可能要求额外审批。默认关闭，需在「设置 > 系统 > AI 组件 > Agent tools > Experimental agentic features」打开。
- 已知风险口径：官方点名「cross-prompt injection (XPIA)」。
- 来源【一手】Windows Security Book「Operating system agentic security」，https://learn.microsoft.com/en-us/windows/security/book/operating-system-agentic-security （ms.date 2025-11-13，访问 2026-10-02）；Windows 博客 Securing AI agents on Windows，https://blogs.windows.com/windowsexperience/2025/10/16/securing-ai-agents-on-windows/ （2025-10-16，标题级引用）；支持页 https://support.microsoft.com/en-us/windows/ai/ai-features/experimental-agentic-features

### A3.2 Copilot Studio computer use：执行机器三选一
- 「computer use runs on a Windows machine」，可选：
  1. **Hosted browser**：「runs in a Microsoft-managed environment. It isn't Microsoft Entra joined to your tenant or managed by your Intune policies」，不支持企业资源访问，「not recommended for production use」。
  2. **Cloud PC pools（Windows 365 for Agents）**：微软托管云 PC，「Entra joined and Intune enrolled enables full governance of the Cloud PC pool」，可自动扩缩。
  3. **自带机器**（含 Power Automate Hosted Process 托管机器或客户自己的 Windows 机器，需安装 Power Automate for desktop 并注册到环境）；「dedicate a machine to computer use to avoid interruptions」。
- 来源【一手】https://learn.microsoft.com/en-us/microsoft-copilot-studio/configure-where-computer-use-runs （ms.date 2026-05-07）
- 审计：computer use 活动审计日志进 **Microsoft Purview**、Dataverse 日志可配详细度、保留期 7 天至无限。来源【一手·官方博客】https://www.microsoft.com/en-us/microsoft-copilot/blog/copilot-studio/computer-using-agents-now-deliver-more-secure-ui-automation-at-scale/ （据检索摘要，未逐字核对）

### A3.3 Agent 365（控制面）
- 官方定位「the control plane for agents」；以 **Entra Agent ID** 给 Agent 独立身份（条件访问、身份治理、身份保护、网络控制）；Agent 注册表横跨 M365 管理中心 / Entra / Purview / Defender；**Purview 对 Agent 提供信息保护、DLP 与风险防护**；可纳管 Copilot Studio、Foundry 以及 AWS Bedrock、Google Vertex AI 上的 Agent。来源【一手】https://learn.microsoft.com/en-us/microsoft-agent-365/overview ；https://www.microsoft.com/en-us/security/business/identity-access/microsoft-entra-agent-id （据检索摘要）
- Researcher / Analyst：本轮未抓取一手原文说明其执行位置，**未查到**（不推测）。

**小结（A3）**：微软的划分最「操作系统化」——**本机执行面用 OS 原生边界（独立 agent 账户 + 独立 agent 桌面 + ACL + 签名吊销）**；**云执行面用 Windows 365 for Agents（Entra 加入、Intune 纳管的云 PC）**；**控制面统一在 Agent 365 / Entra Agent ID / Purview**。思路是把 Agent 当成「一个受管员工/设备」来治理，复用企业已有的身份、终端、DLP 体系。

---

## A4. Manus / Perplexity Comet / Genspark：云端沙箱与本机浏览器的边界

### Manus（官网标注「Manus is now part of Meta」）
- 默认形态：「Manus has always operated through a cloud browser—a sandboxed environment that provides a clean, controlled workspace」——Agent 循环与执行都在云端虚拟机/云浏览器。
- **Browser Operator（2025-11-18 发布的本机浏览器扩展）**：让 Manus 在用户本机 Chrome/Edge 中执行，「using your existing logins and sessions」，出网表现为用户本机 IP 与会话（规避陌生登录、验证码）。安全口径：每个会话须用户授权、关闭标签页即可停止、所有动作留日志。
- 第三方风险评估【二手】：扩展权限包含对 cookies 与 local storage 的读写、全域可见（Mindgard 安全博客 https://mindgard.ai/blog/manus-rubra-full-browser-remote-control ）。
- 来源【一手】https://manus.im/en/blog/manus-browser-operator ；https://manus.im/docs/features/browser-operator （据检索摘要，访问 2026-10-02）
- 企业治理（SSO/审计/驻留）：**未查到**。

### Perplexity Comet（AI 浏览器）
- 资料多为第三方转述【二手】：浏览历史、查询、AI 交互默认本地优先存储，「personal search」时才把个人上下文发往 Perplexity；连接器权限可撤销；Assistant 可被禁止与网站交互或读取历史；50+ 席位企业有管理台与审计日志、可配置保留期。来源：https://www.gend.co/blog/perplexity-comet-security-day-one 【二手】；https://www.createwith.com/tool/perplexity/updates/perplexity-adds-privacy-snapshot-and-assistant-controls-to-comet 【二手】
- 安全事件【二手】：研究者演示通过提示注入诱导 Comet 读取本机文件并外发。来源 https://www.esecurityplanet.com/artificial-intelligence/perplexity-comet-browser-bug-leaks-local-files-via-ai-prompt-injection/
- Perplexity「Computer」：**未查到**一手资料。

### Genspark
- **未查到**（本轮未检索到其云/本机划分的一手说明）。

**小结（A4）**：通用 Agent 创业公司普遍是「云端 VM 做大脑与执行 + 本机浏览器扩展借用户登录态」，本机侧权限极宽（cookies、全域），治理能力薄；这是**法律场景应避免照搬**的模式（本机浏览器登录态 = 律所内网/法院系统/客户邮箱，被提示注入利用的代价极高）。

---

## B5. Harvey（重点）

### B5.1 部署形态与数据存放
- **全云 SaaS，托管于 Microsoft Azure**：「Harvey hosts its cloud environment in Microsoft Azure. For customers with requirements or preferences for data localization we offer processing in the EU and Switzerland or Australia. This applies to Harvey subprocessors as well.」安全页另称可「keep everything in-region—EU or Switzerland, US, or Australia」。来源【一手】https://www.harvey.ai/security （访问 2026-10-02；页面顶部横幅为「We Raised $550M at a $15.5B Valuation」）
- **文件存储（Vault 等）**：上传文件经 TLS 1.2+ 进入「blob storage within the customer's regional environment」，每个文件 AES-256 加密；取用时「decrypted only in memory」；保留期可按「上传时起算」或「最后使用时起算」，到期安全删除。来源【一手】Harvey 博客 How Harvey Manages Customer Data，https://www.harvey.ai/en-US/blog/how-harvey-manages-customer-data
- **桌面/本地组件**：未查到 Harvey 有本机执行的桌面 Agent 或私有化部署选项。其「贴近工作流」的入口全部是**云端服务的前端外壳**：Harvey for Word 加载项、Harvey for Outlook（2026-08 升级为「full agentic power into the inbox」）、Microsoft 365 Copilot 内的 @Harvey（2026 Q2 首发）。2026-09-23 起 Agent Builder 建的自定义 Agent 可在 Word 加载项中运行，以当前打开文档为上下文、可从 Vault 拉取其他文件，修改以**修订（tracked changes）**呈现由律师接受/拒绝。来源【一手】https://www.harvey.ai/blog/run-custom-harvey-agents-in-microsoft-word （2026-09-23）；https://www.harvey.ai/blog/the-new-harvey-for-outlook ；https://www.harvey.ai/blog/harvey-accelerates-enterprise-ai-with-agentpowered-platform-and-microsoft-365-copilot （后两条据检索摘要）

### B5.2 数据隔离与「零保留」
- 逻辑隔离：「Customer data for each customer is logically separated」；「strict role-based access controls and logical workspace separation」；客户可决定上传什么、保留多久、是否在公司内共享。来源 /security。
- **模型侧 ZDR**：「Harvey requires Zero Data Retention (ZDR) by model providers」；「Harvey contractually prohibits model providers from training on customer data」；请求上下文「exists just long enough for the model to generate a response… our model partners immediately delete that data」；「customer information does not persist between sessions, and no context is shared across users or workspaces」。来源 /security 与 how-harvey-manages-customer-data。
- 定义口径：「customer data」= 客户上传的文档；「customer content」= 用户提问与 Harvey 回答。来源 /security。
- 训练：默认不训练；仅在客户明确要求时「a bespoke model is created exclusively for you」。来源 /security。

### B5.3 密钥、伦理墙、权限与审计
- **BYOK**：「customers manage the encryption key used to secure their stored data. They can rotate or revoke that key at any time, immediately rendering the data inaccessible to any system, including Harvey… the ability to define their own trust boundary.」来源 how-harvey-manages-customer-data。
- **伦理墙（Ethical walls）**：「Harvey syncs and enforces your firm's existing ethical wall policies, blocking restricted users from accessing or sharing walled content across Harvey. **Harvey never creates, modifies, or deletes walls, ensuring that your walls provider remains the system of record.**」来源 /security。
- **内部人员访问**：「Our engineers and operations staff do not have access to customer data except where required or requested by our customers」，靠 RBAC、网络分段、身份联邦强制；所有访问「logged and correlated across multiple systems」。来源 how-harvey-manages-customer-data。
- **企业控制**：「SAML SSO, audit logs, IP allow-listing, and data lifecycle management」，24/7 监控。来源 /security。
- **认证与合同**：年度 SOC 2 Type II、ISO 27001；Platform Agreement 合同保证「your data stays yours」；Security Addendum 含数据保护、数据访问、事件响应 SLA 等「binding terms」，「auditable, enforceable, and built to exceed standard vendor terms」；第三方审计/渗透：Schellman、NCC Group、Bishop Fox。来源 /security。
- **DMS 集成**：iManage 集成 2025-09-12 对全部工作区开放，「direct OAuth authentication with no middleware」，可把 iManage 文档导入 Assistant/Workflows/Vault，并把 Harvey 起草的文档带完整版本回写 iManage matter——**云到云**集成。来源【一手】https://www.harvey.ai/blog/harveys-imanage-integration ；https://help.harvey.ai/release-notes/imanage-integration-release （据检索摘要）。NetDocuments 集成：本轮**未查到**一手说明。

### B5.4 Agent 在哪执行
- Harvey 的 Agents / Workflows / Agent Builder 均为其 Azure 云平台上的能力，Word/Outlook/Copilot 只是触达入口；**未查到任何本机执行或客户自有云执行（BYOC）的选项**。官方安全口径核心句：「Harvey is built on a non-negotiable principle: protecting the security and confidentiality of our customers' data.」

**小结（B5）**：Harvey 让顶级律所接受「客户文件放云上」靠的是一整套「**合同 + 认证 + 区域驻留 + BYOK + 模型侧 ZDR + 伦理墙同步（不做 system of record）+ 内部零访问 + 全量访问日志**」，而不是本地化执行。

---

## B6. Legora

- **部署形态**：云 SaaS，构建于 Azure（Microsoft 客户案例与 Azure Marketplace 上架：https://microsoft.com/en/customers/story/23171-legora-azure-openai 、https://marketplace.microsoft.com/en-us/product/leyaab.legora ，据检索摘要）；「Using Azure's scalable infrastructure, Legora can deploy AI models regionally」，并对每个子处理方要求可执行的数据驻留、按司法辖区部署区域端点（据检索摘要，来源为上述微软案例/第三方页，**未逐字核对**）。
- **安全页原话【一手】**（https://legora.com/security ，访问 2026-10-02）：
  - 认证：ISO 42001（AI 管理体系）、ISO 27001、SOC 2；技术团队在瑞典、受 GDPR 约束；有欧盟与美国两地技术团队。
  - 「Legora will not use your data to train or fine tune any AI models.」
  - 「We follow Zero Trust architecture… access is always verified, limited, and logged.」
  - 「Via our enterprise security packages you are in control of where your data is stored, for how long it is stored, how the encryption key is managed」——支持全部常见 SSO、自定义保留期、**BYOK**；传输 TLS 1.2+、静态 AES-256。
  - 合同终止后「all of your data — along with any dedicated storage resources associated with your account — is permanently deleted」，删除前可全量导出（暗示企业包有**专属存储资源**）。
- **伦理墙 + iManage**：官方支持文档《iManage Integration & Ethical Walls Quickstart Guide》（https://support.legora.com/en/articles/640367-imanage-integration-ethical-walls-quickstart-guide ，需登录，以下据检索摘要）：连接需「metadata-only service account」、customer ID、library ID；**若 iManage 为本地部署且外网不可达，须通过安全端点或 Azure App Proxy 暴露**——即「云端 SaaS 反向接入律所本地 DMS」的模式，而非把 Agent 搬到本地。
- **Word 加载项**：有（据检索摘要，https://aitoolsatlas.ai/tools/legora-ai 【二手】）。
- **本地/私有部署、本地模型**：**未查到**。

**小结（B6）**：Legora 与 Harvey 同构——Azure 全云 + 区域驻留 + BYOK + 零训练 + ISO 42001/27001/SOC 2；对本地 DMS 采取「云端连回本地（App Proxy/安全端点）」而非「本地执行」。

---

## B7. Thomson Reuters CoCounsel / Lexis+ AI（Protégé）/ Spellbook / LegalOn / Luminance

### Thomson Reuters CoCounsel（CoCounsel Legal / Essentials）
- 形态：云 SaaS；入口包括 Web 与 **Microsoft Word、Outlook、Teams** 内嵌；DMS 集成 **iManage、NetDocuments、SharePoint**（「Analyze and draft with your iManage content in CoCounsel Legal without leaving your workflow」「Turn NetDocuments files into AI-ready matter context」）。来源【一手】https://legal.thomsonreuters.com/en/products/cocounsel-core （访问 2026-10-02）
- 数据口径【一手】（https://legal.thomsonreuters.com/en/products/cocounsel-essentials FAQ）：
  - 不用用户内容/提示训练，「neither OpenAI GPT nor Google Gemini stores them」；第三方 LLM 合作方合同禁止训练；「where applicable, we have established systemic controls to **turn off third parties' abuse monitoring solutions** to ensure there is no human access」。
  - 「All interactions with GenAI LLM providers use **zero-retention API calls**.」
  - 「All GenAI LLM requests originating from Thomson Reuters are processed under the identity "Thomson Reuters," **never identifying the Thomson Reuters customer** who made the request.」（对模型方做客户身份匿名化）
  - 保留期按组织账户定制（由 TR 客户经理协助设置），用户可随时删除；TLS 1.2 + AES-256。
  - 「Region-based hosting is available in the UK, Australia, and Canada.」
  - 检索摘要另见「GenAI solutions access partner LLMs through private, dedicated servers」（未逐字核对）。
- 本地/私有部署：**未查到**。伦理墙：**未查到**一手说明。

### LexisNexis Lexis+ AI / Lexis+ with Protégé
- 形态：云 SaaS；**Vault** 为个人文档库，Protégé 以 Vault 内文档为任务来源；Vault「retained until you decide to delete them」；未存入 Vault 的单次上传（最多 10 份）「automatically purged at the end of each session」；Protégé Vault 结果在「My Conversations」保留 90 天；客户数据不用于训练公共模型、不用于提升对其他客户的效果。来源【一手，据检索摘要】https://www.lexisnexis.com/en-int/products/lexis-plus-protege ；https://lexisnexis.co.uk/products/lexis-plus-ai
- 本地/私有部署、DMS 集成位置、BYOK：本轮**未查到**。

### Spellbook（Word 加载项）
- 形态：**Microsoft Word 加载项**，用 Microsoft 账户 SSO；从文档抓取文本经 HTTPS 发往后端，后端调用 LLM，再回传。
- 托管：前端静态文件在 AWS S3（全球复制），**后端在 AWS ECS ca-central-1（加拿大）**。
- 模型侧：与 OpenAI、Anthropic 签有 **ZDR** 协议，数据「exists only in memory in order to process a request」；SOC 2 Type II；传输与静态加密。
- 来源【一手，据检索摘要】https://spellbook.legal/security ；https://spellbook.com/security
- 启示：**「Word 加载项」≠ 本地执行**——文本仍上云处理；加载项只是 UI 驻留在本机。

### LegalOn
- 托管：「hosted in the US on Amazon Web Services (AWS) and Google Cloud Platform (GCP)」；模型用 **Azure OpenAI**，「no customer data is stored for any period of time, even for abuse monitoring and debugging purposes」（即申请了滥用监控豁免）；每个客户账户「segregated environments」；SOC 2 Type II、ISO/IEC 27001:2022、ISO/IEC 27017:2015。另有「LegalOn Agents」产品页。来源【一手，据检索摘要】https://www.legalontech.com/security ；https://us-direct.legalontech.com/agents

### Luminance
- 「Luminance uses AES-256 encryption with **AWS Key Management Service** for data hosted in AWS with TLS 1.2 or higher」；可配置 RBAC、MFA、SSO、**审计日志**；「Customer-specific learning remains private to each organization and is not shared across customers」；有独立认证的 ISMS、定期 SOC 2 Type II；第三方渗透测试。来源【一手】https://www.luminance.com/security （访问 2026-10-02）
- 私有化/本地部署：本轮**未查到**一手说明（不推测）。

**小结（B5–B7）**：被调研的 7 家海外法律 AI 头部产品**全部是云 SaaS**（Azure：Harvey、Legora；AWS：Spellbook、Luminance；AWS+GCP：LegalOn；TR/Lexis 自有云）。没有一家把 Agent 搬到律师本机执行；「贴近律师」靠的是 Word/Outlook/Teams 加载项与 DMS 云到云集成。差异化的信任组件高度趋同：**模型侧 ZDR / 关闭滥用监控、不训练、区域托管、BYOK/KMS、SSO+审计、SOC 2/ISO 27001（Legora 加 ISO 42001）、伦理墙同步（Harvey/Legora）**。

---

## B8. 律所侧行业规范与云接受度

### ABA Formal Opinion 512（2024-07-29）
- 发布：ABA Standing Committee on Ethics & Professional Responsibility，2024-07-29，覆盖胜任、保密、沟通、监督、坦诚、合理收费六类义务。来源【二手·权威转述】NCBE《The Bar Examiner》2024 秋季刊，https://thebarexaminer.ncbex.org/article/fall-2024/generative-artificial-intelligence-tools/ （ABA 官网 PDF 对 curl/WebFetch 返回 403，未能直读原文）
- **保密（Rule 1.6）**：重点风险是「self-learning GAI tools」——其性质「raise[s] the risk that information relating to one client's representation may be disclosed improperly, **even if the tool is used exclusively by lawyers at the same firm**」；把与代理相关的信息输入此类工具前须取得客户**知情同意**；「Boilerplate waivers will not suffice as informed consent」——须向客户说明为何使用、风险范围、将披露哪类信息、可能被如何不利使用、对代理的收益。若只用于不输入客户信息的头脑风暴则无需同意。
- **对供应商的尽调**：律师应「read and understand the Terms of Use, privacy policy, and related contractual terms and policies of any GAI tool they use to learn **who has access to the information**」，或请同事/外部专家、IT/网安专家评估。
- **监督（Rules 5.1/5.3）**：管理层律师须制定 GAI 使用政策；援引外包类旧意见（08-451、477R）——确保第三方「will do the work capably and protect the confidentiality」，重视供应商资质、**供应商的利益冲突筛查机制**等。
- **收费**：按小时计费只能收实际时间；GAI 工具费作为费用转嫁须合理、一般不得加价。
- 启示（事实层面）：ABA 并未禁止云端 GenAI，核心判据是「**谁能访问输入的信息**」与「**是否自学习/跨客户复用**」——这正是 Harvey 等以 ZDR、不训练、逻辑隔离、伦理墙回应的点。

### 英格兰及威尔士：Law Society / SRA
- Law Society《Generative AI: the essentials》（2024-08-07）第 3.3 节：「generally advisable that you do not feed confidential information into generative AI tools, especially if you lack direct control and oversight over the tool's development and deployment」。来源【二手】https://www.lawcareers.net/Explore/CommercialQuestion/Michelmores-LLP-Generative-AI-use-and-client-confidentiality （据检索摘要；Law Society 原页未直读）
- SRA：已发现律师把保密信息输入缺乏适当保障的 AI 工具的情形；2026 年 6 月在「有效监督」指引中新增 AI 相关部分，强调「appropriate human oversight, informed professional judgement and a proportionate, risk-based approach」；英国上诉审裁处 [2026] UKUT 81 (IAC) 评论了公共 AI 工具可能破坏保密与法律职业特权。来源【二手】https://www.localgovernmentlawyer.co.uk/litigation-and-enforcement/400-litigation-news/101453-solicitors-regulation-authority-highlights-concern-over-ai-generated-inaccuracies-and-breaches-of-confidentiality2 ；https://www.legalfutures.co.uk/latest-news/sra-warns-profession-over-ai-misuse-amidst-investigations
- 关键措辞「lack direct control and oversight」——英国口径看重的是**控制权**而非物理位置。

### 律所对「云端 SaaS 存放客户文件」的接受度
- ILTA 2025 Technology Survey（580 家律所、12+ 国家、约 15.2 万律师）：「law firms are continuing to move data to the cloud」，更多律所使用 Azure、Teams、Intune、Office 365。来源【一手·行业协会】https://iltanet.org/blogs/ilta-news1/2025/09/16/press-release-ilta-releases-2025-legal-technology ；【二手】https://aceds.org/ella-sherman-6-things-we-found-interesting-from-the-2025-ilta-tech-survey/
- iManage Cloud / NetDocuments 的具体渗透率数字：**未查到**（ILTA 全文仅会员可读）。
- 侧证：Harvey 对 iManage 做 OAuth 云到云集成（B5）、Legora 对本地 iManage 用 Azure App Proxy 反向接入（B6）、NetDocuments 本身提供 CMEK（https://netdocuments.com/products/customer-managed-encryption-keys ）——说明海外大所的 DMS 已大量在云上或可被云端安全接入。
- 中国律所对云端 SaaS 的接受度：本次调研范围外，**未查到**。

---

## C. 共性模式与对中国律所法律 Agent 的启示

> 本节前半为「事实归纳」（均可回溯到上文出处），后半为「迁移判断」（为推断，需在 v6 方案中与用户拍板的约束核对）。

### C1. 事实归纳：海外头部法律 AI 为何全云端、靠什么让律所接受
1. **全部云 SaaS，无本机执行**：Harvey、Legora（Azure），Spellbook、Luminance（AWS），LegalOn（AWS+GCP），CoCounsel、Lexis（自有云）。「贴近律师」靠 Word/Outlook/Teams/Copilot 加载项与 DMS 云到云集成，加载项只是 UI，文本仍上云（Spellbook 明示）。
2. **让律所接受的「信任包」高度一致**：
   - 合同：不训练（Harvey Platform Agreement、Legora、TR 合同禁止模型方训练）；Security Addendum 含事件响应 SLA（Harvey）。
   - 模型侧零保留：Harvey「requires ZDR by model providers」；TR「zero-retention API calls」+「turn off third parties' abuse monitoring」；LegalOn 用 Azure OpenAI 且滥用监控也不存；Spellbook 与 OpenAI/Anthropic 签 ZDR。
   - **对模型方匿名**：TR 以「Thomson Reuters」身份调用，「never identifying the … customer」。
   - 加密与密钥：TLS 1.2+ / AES-256 普遍；**BYOK**（Harvey、Legora），AWS KMS（Luminance）；Harvey 原话「the ability to define their own trust boundary」。
   - 区域驻留：Harvey（EU/瑞士/美/澳）、TR（英/澳/加）、Legora（按辖区区域端点）。
   - 隔离：逻辑隔离 + RBAC + 工作区隔离；Legora 企业包「dedicated storage resources」；LegalOn「segregated environments for each customer account」。
   - **伦理墙**：Harvey「syncs and enforces your firm's existing ethical wall policies… never creates, modifies, or deletes walls… your walls provider remains the system of record」；Legora 同样与 iManage 伦理墙打通。
   - 内部人员零访问 + 全量访问日志（Harvey）；SSO、审计日志、IP 白名单（Harvey/Luminance）。
   - 认证：SOC 2 Type II、ISO 27001 是门槛；Legora 加 ISO 42001，LegalOn 加 ISO 27017。
3. **规范侧的判据是「控制与可访问性」而非物理位置**：ABA 512 看「谁能访问输入」「是否自学习跨客户复用」，并要求非模板化的知情同意；Law Society 看「direct control and oversight」。

### C2. 事实归纳：通用 Agent 厂商如何拆「控制面 / 数据面 / 执行面」
| 厂商 | 控制面（永远在厂商云） | 执行面选项 | 数据落点 |
|---|---|---|---|
| Anthropic | 组织设置、server-managed settings、连接器凭据（不进沙箱）、Compliance API、调度队列 | 本机（Agent 循环本机 + 代码进 Hyper-V/Apple VF Linux VM）/ Anthropic 云沙箱 / **客户自托管 runner（仅出站连接）** | 本机会话：历史存本机且管理员无法集中管理/删除；云会话：存 Claude 账户 |
| OpenAI | 云端「协调器」+ Agent Security（Global 基线、审批策略、Web 搜索模式）+ 协调器上的 remote MCP hooks | 本机电脑（受 MDM/本地 requirements）/ Work 云容器 / dots 云电脑 | 「Local execution does not mean offline or device-only model inference」 |
| Microsoft | Agent 365 + Entra Agent ID + Purview/DLP/审计 | Windows 本机 agent workspace（独立 agent 账户 + 独立桌面 + ACL）/ Windows 365 for Agents 云 PC / 自带机器 | 视执行面而定 |

关键动向（事实）：
- **常在线能力（定时、手机派活、IM 接入、关机后继续）都被放到云端或「一直在线的执行主机」上**：Anthropic 定时任务「run remotely」且「can't be tied to a folder on your computer」；本机遥控 Dispatch「isn't available to new users」；Pro/Max 10-06 起默认云端。OpenAI dots「lives in the cloud」，可在 Slack/Teams 触达；桌面版定时任务可跑本机但「Keep the computer on」。
- **企业版默认保守**：Cowork 云会话 Enterprise 默认关；OpenAI「the in-app Local/Cloud toggle and its default remain unchanged」；开启数据驻留即禁用「本机 + 云协调」混合；ZDR 组织不能用 Claude Code 云会话与自托管环境。
- **权限模型趋同为两层**：沙箱（能做什么）× 审批（何时问人）；写类连接器默认逐次审批、「most restrictive layer wins」、「A user approval cannot override an administrator's denial」、带 destructive 注解的工具必审批、敏感工作推荐 Manual 模式。
- **本机执行的治理短板被厂商自己承认**：本机会话历史「admins cannot centrally manage or delete it」；VM 对 EDR 不可见；OTel「doesn't replace audit logging for compliance purposes」；MCP hooks「do not provide a complete Compliance API audit trail」。

### C3. 迁移判断：适合迁移到「中国律所 + 本机 exe + 国内模型 token」的模式
（推断，供 v6 方案取舍）
1. **「协调与执行分离」+「仅出站连接」的自托管 runner 模式** → 最贴合。Claude Code self-hosted environments 的形态（控制面排队、runner 在客户网内认领任务、所有连接出站、「never connects into your network」、runner 按 owner 锁定不串数据）可以直接映射为：律所侧内核（或某台常开工作站）当 runner/协调器，云端只出 token。区别在于我们的控制面也必须落在律所侧（因为云端只供 token），即「控制面 + 执行面都在律所，模型面在云」。
2. **两层权限模型**（沙箱 × 审批）与默认值：默认 Manual/逐次审批、写类连接器禁止「always allow」、管理员拒绝不可被用户覆盖、破坏性操作强制审批、「最严格层生效」——可原样迁移，且符合 ABA 512「监督义务」与 Law Society「控制与监督」口径。
3. **本机执行隔离**：文件夹显式授权（Cowork connected folders / Windows known folders + ACL）、代码执行进 VM 或 OS 沙箱（Seatbelt/bubblewrap/Hyper-V）、网络出口经本地代理白名单默认空——可迁移；可参考微软「独立 agent 账户」做 Windows 下的操作归因（该能力在微软处仍为 experimental）。
4. **策略下发走「端点管理」而非厂商云**：Anthropic 自己认为 endpoint-managed（MDM/注册表/文件）「stronger security guarantees」；在「云端只供 token」约束下，策略、审计应从律所侧内核/域控下发与汇聚。
5. **模型侧信任包（与 token 通道强相关，可迁移）**：与模型方的 ZDR/不训练合同、关闭可人工查看的滥用监控留存（需核实国内备案与日志留存要求是否允许）、**以中软身份调用、不向模型方暴露律所身份**（TR 做法）、最小上下文（只发片段，Harvey「only the data needed」）。
6. **伦理墙「同步并执行、不做 system of record」**（Harvey）→ 可迁移为：从律所现有利冲/案件管理系统同步 matter 权限，Agent 只执行不改写；无此类系统的律所由产品提供 matter 级隔离。
7. **对外口径要诚实**：OpenAI 明说「本地执行 ≠ 数据不出机」。在「本机 exe + 云端 token」形态下，准确说法应是「文件静态存放在律所侧，任务所需的片段经加密通道发往模型并零保留」，而非「数据不出律所」。

### C4. 迁移判断：不适合或需改造的模式及原因
1. **云端常驻 Agent / 云端定时（dots、Cowork 云定时、Codex Cloud）**：依赖厂商云执行与存储，与「云端只供 token」的约束冲突；替代是律所侧常开主机执行定时任务，或桌面 exe 在线时执行（OpenAI 桌面定时任务即要求「Keep the computer on」）。
2. **手机遥控本机（Dispatch 类）**：Anthropic 已对新用户停用，说明「靠个人电脑常开」体验差；若做移动端触达，应接律所侧常开主机而非律师个人笔记本，且连接应为律所侧出站（避免入站暴露）。
3. **本机浏览器扩展借登录态（Manus Browser Operator、Comet）**：权限过宽（cookies/全域），且有提示注入读本地文件外发的公开案例；法律场景（法院系统、客户邮箱、律所内网）风险过高，至少应默认关闭、站点白名单、不得读取 cookies。
4. **全云 SaaS 存放客户文件 + BYOK + 区域驻留（Harvey/Legora 信任包的「存储侧」部分）**：在本方案不在云端存文件的前提下大部分无需照搬；但其**合同与认证部分**（不训练、ZDR、事件响应 SLA、SOC 2/ISO 27001/ISO 42001 或国内等保/ISO 对应物）仍是律所采购尽调的必答题（ABA 512 的「读懂条款、谁能访问」逻辑在国内同样适用——此为推断）。
5. **云端 hooks/审计（OpenAI 协调器上的 remote MCP hooks、Anthropic Compliance API）**：其前提是协调器在厂商云；本方案应把审计做在律所侧内核，并吸取厂商教训——本机会话历史必须可被律所管理员集中采集、检索和删除（Anthropic 承认本地会话做不到），并考虑 EDR 可见性（VM 对 EDR 不可见是 Anthropic 明示的部署前提）。

