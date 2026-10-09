# 子报告：Kimi 底座与运行时核验（2026-09-28）

> 范围：只核验 09-23 基线之后的变化，并补上当时缺的信息。只读调研，源码审阅基于浅克隆 `MoonshotAI/kimi-code` 的 main 分支 HEAD `e15c4fcbdff9c991388481d0060dd246a91ac74a`（2026-09-28 03:27Z）。
> 证据等级：**一手**＝官方原文、源码、价格页或 API 返回；**交叉**＝多个来源一致；**单一**＝只有一个非官方来源；**推测**＝由事实推出的判断；**查不到**＝检索后没有找到。

---

## ① 相对 09-23 基线的变化表

| # | 事项 | 09-23 基线 | 09-28 核验结果 | 证据 |
|---|---|---|---|---|
| 1 | Kimi Code 版本 | 2.0.2（09-19，`9d07f634`） | 新增 **2.1.0**（09-23，`52437299`）和 **2.1.1**（09-24，`f67e6398`）；npm latest 为 2.1.1 | 一手 [Releases](https://github.com/MoonshotAI/kimi-code/releases)、[npm](https://registry.npmjs.org/@moonshot-ai/kimi-code) |
| 2 | 工作区安全加固 | 未涉及 | 2.1.0 加入「符号链接逃逸拦截、禁止仓库 git 配置执行命令、项目 local.toml 需信任后才生效」；**2.1.1 次日整体回滚**（`929403b`）。kap-server 拒绝 `Origin: null` 的修复在合入前就被撤回 | 一手 [commit 929403b](https://github.com/MoonshotAI/kimi-code/commit/929403b6db219eae6099dd23eae2f0efa2bb2823)、[commit 6451f1e](https://github.com/MoonshotAI/kimi-code/commit/6451f1e056e90037bbf832f3578955cf8e55db64) |
| 3 | ACP 服务端 | stdio JSON-RPC | `packages/acp-server` 自 2.0.2 以来**零改动**，没有破坏性变更 | 一手（`git log 9d07f634..HEAD -- packages/acp-server` 为空） |
| 4 | node-sdk / klient | private | 仍为 `private:true`；npm 上 `@moonshot-ai/kimi-code-sdk`、`klient` 均 404。仓库文档却把 SDK 列为「可发布」，前后矛盾 | 一手 |
| 5 | 遥测 | 未核 | **默认开启**。即使用自定义 provider，默认区域也是 mainland-cn，事件发往 `telemetry-logs.kimi.com`。2.1.0 起还会上报已启用插件 | 一手（`packages/oauth/src/region.ts`、`docs/zh/configuration/config-files.md`） |
| 6 | Kimi Work | 3.2.12（09-22） | 最新 **3.2.14（09-24）**：远程控制、Side Chat、Office 版本历史。仍没有 SSO、审计、团队协作、白标 | 一手 [Release Notes](https://www.kimi.com/help/kimi-work/release-notes) |
| 7 | Kimi 企业版价格 | ¥4,200 未在官方页查到 | **官方帮助页已明示 ¥4,200/座/年**（约 ¥350/月），2 座起售、单次最多 150 座，含 Kimi Work 和 Kimi Code | 一手 [Kimi Business 介绍](https://www.kimi.com/help/kimi-business/kimi-business) |
| 8 | 托管运行时 | 无 | 发现 **Kimi 托管智能体（Kimi Hosted Agents，Beta）**：云沙箱 ¥0.072/小时（1 核 1G），只对国内企业认证用户开放；合作伙伴计划把它定位为伙伴的「Agent 运行底座」 | 一手 [快速开始](https://platform.kimi.com/docs/hosted-agents/quickstart)、[定价](https://platform.kimi.com/docs/pricing/hosted-agents) |
| 9 | 数据留存 | 协议默认可用于优化，关闭需申请 | 官方新增 **ZDR（零数据保留）页**，企业客户可向销售申请；但服务协议 §6.3「输入输出可用于模型服务优化」原文没变 | 一手 [ZDR](https://platform.kimi.com/docs/guide/zero-data-retention)、[协议](https://platform.kimi.com/docs/agreement/modeluse) |
| 10 | 模型与价格 | K3 ¥20/¥2/¥100 等 | K3、K2.6、K2.7-code 价格不变；价格页列出 `kimi-k2.7-code-highspeed`（¥2.6/¥13/¥54，基线没写）；**K2.8 在开放平台仍无 API**；Batch 仍不支持 K3 | 一手 [价格](https://platform.kimi.com/docs/pricing/chat)、[模型列表](https://platform.kimi.com/docs/models)、[Batch](https://platform.kimi.com/docs/pricing/batch) |
| 11 | 新产品与行业方案 | — | 09-17 **金融行业解决方案**（含「风险评估网关」和托管智能体）；09-21 **Kimi Code Desktop 1.0**（macOS/Windows，闭源） | 一手 [金融方案](https://www.kimi.com/news/kimi-financial-industry-ai-solution)、[Code Desktop](https://www.kimi.com/news/kimi-code-desktop) |
| 12 | K3 许可 | Kimi K3 License | HF 上 LICENSE 自 07-27 首次提交后**没有改动**（最新提交 09-02 只加了评测结果） | 一手 [HF commits](https://huggingface.co/api/models/moonshotai/Kimi-K3/commits/main) |

---

## ② 逐题结论

### Q1 Kimi Code 最新状态

**1.1 发布列表（09-19 之后）**：一手
- **2.1.0**（09-23）：TUI 全屏模式；安全加固 #3964（见下）；「在全局登录下跳过云遥测，直到采集端上线」；MCP OAuth 申请 `offline_access`；新增 `KIMI_CODE_REPEAT_BREAKER` 开关；文件监听默认关闭；Tower 多 Agent 模式收紧。
- **2.1.1**（09-24）：「回滚 2.1.0 中过度防御的改动」；文件监听恢复默认开启。
- main 在 2.1.1 之后只有一个 CI 流程提交（`e15c4fc`，09-28）。
- 核验用到的 SHA：HEAD `e15c4fcbdff9c991388481d0060dd246a91ac74a`；2.1.1 `f67e6398fb3210ad8ace970e2dfd5bcc984ed61f`；2.1.0 `52437299ff78de3d0aff7f38f054e5eb20c512e5`；2.0.2 `9d07f634be94ebeb1deba2f55d247807cf729315`。

**1.2 安全加固被回滚（新发现，会改变方案）**：一手
- #3964（`6451f1e`）原本加了以下防护：后台 git 调用屏蔽仓库自带的 fsmonitor、hooksPath、filter、driver、gpg、editor；文件工具按 realpath 拦截符号链接逃逸；项目 `local.toml` 只在工作区被信任后才生效，并拒绝把 home 或根目录作为 additional_dir。
- 2.1.1 的 `929403b` 把上面这些**全部回滚**，只保留「信任提示 fail-closed」和「页脚 git 延迟检测」。回滚说明里写明，这些防护针对的是「已信任仓库里的恶意内容」。
- 同一 PR 里的 kap-server 修复「拒绝 null 或畸形 Origin」在合入前就被撤回。HEAD 版 `origin.ts` 仍把无法解析的 Origin 当作「没有 Origin」放行。WebSocket 仍要求 bearer token，所以这个缺口有兜底（一手，`packages/kap-server/src/start.ts`）。
- 对法律场景的含义（推测）：律师的案卷目录里常有对方或第三方提供的压缩包、仓库，属于典型的「不可信内容」。上游现在的默认行为不防符号链接逃逸，也不防 git 配置执行命令。

**1.3 ACP**：一手
- 0 改动，依赖官方 `@agentclientprotocol/sdk@1.3.0`。
- 补充一个基线没写的细节：客户端声明 `fsCapabilities` 或 `terminal` 后，读写和 shell 会通过反向 RPC 交给客户端执行。但 `acpFsService.ts` 注释写明，**只有文本文件读写走客户端**；二进制 IO、stat、readdir、mkdir、remove 仍直接操作本地磁盘，技能加载和持久化也直接读写本地磁盘。docx、pdf 都是二进制，**所以 ACP 这一层当不了审计或 DLP 的边界**。
- 已知 ACP 缺陷（均 open）：
  - [#4027](https://github.com/MoonshotAI/kimi-code/issues/4027)：定时任务、后台任务触发的轮次不会推送到 ACP 客户端，影响「定时任务」功能；
  - [#3973](https://github.com/MoonshotAI/kimi-code/issues/3973)：JetBrains 下的 Bash 审批卡不显示要执行的命令；
  - [#3959](https://github.com/MoonshotAI/kimi-code/issues/3959)：恢复会话后仍对已失效的终端推送更新。

**1.4 SDK 与嵌入接口**：一手
- node-sdk 仍未发布，KAP REST/WS 文档仍标「实验性，不保证稳定」。
- 仓库 `AGENTS.md` 写明：Web UI **源码已迁到私有 code-app 仓库**，本仓库只保存预构建 bundle；桌面端和 Web 端都消费 kap-server、node-sdk、acp-server、externalHooks 等接口，改动这些接口的 PR 必须说明兼容方案。据此推断，官方自家的 Kimi Code Desktop 用的是 kap-server 和 node-sdk 这条路（推测）。
- **没有**官方的「嵌入式 / headless 集成」专门文档。现成的无界面入口有三种：`kimi -p --output-format stream-json`、`kimi acp`、`kimi web` 的 REST 接口。

**1.5 Windows**：一手
- 发布流水线产出 win32-x64 和 win32-arm64 原生二进制，并用 Azure Artifact Signing 签名；CI 有 Windows 测试。仍依赖 Git for Windows（Git Bash）。
- 仍 open 的 Windows 问题：
  - [#3236](https://github.com/MoonshotAI/kimi-code/issues/3236) 和 [#3216](https://github.com/MoonshotAI/kimi-code/issues/3216)：stdio MCP 用 `npx` 这类裸命令会报 `spawn ENOENT`（v2 引擎回归）；
  - [#3297](https://github.com/MoonshotAI/kimi-code/issues/3297)：每次运行 Hook 都弹出控制台窗口；
  - [#3186](https://github.com/MoonshotAI/kimi-code/issues/3186)：并发刷新 OAuth 有竞态；
  - [#3270](https://github.com/MoonshotAI/kimi-code/issues/3270)：文件监听会扫描 `C:\` 根目录；
  - [#3301](https://github.com/MoonshotAI/kimi-code/issues/3301)：Windows Terminal 下 CJK 歧义宽度字符重叠；
  - [#3949](https://github.com/MoonshotAI/kimi-code/issues/3949)：桌面端 Windows 上，项目 MCP 的信任提示不显示。

**1.6 遥测**：一手
- 默认值：`config.toml` 顶层 `telemetry = true`；关闭方式为设 `false`，或设环境变量 `KIMI_DISABLE_TELEMETRY=1`（只能额外禁用，优先级高于配置）。
- 上报端点：mainland-cn 区域为 `https://telemetry-logs.kimi.com/v1/event`，global 区域暂无采集端。**未登录时默认按 mainland-cn 处理**。
- 事件内容是交互类事件（快捷键、命令、模型切换等），并经过正则脱敏（邮箱、URL、Token、路径）。
- 另有两个外连开关：自动更新用 `KIMI_CODE_NO_AUTO_UPDATE=1` 关闭，满意度问卷用 `disable_feedback_survey` 关闭。
- Remote Control（`kimi rc`，经 `code-rc.kimi.com` 中继）没有配置项可以禁用。

**1.7 安全公告**：一手
- GitHub Security Advisories 页显示「There aren't any published security advisories」；OSV 查询 `@moonshot-ai/kimi-code` 为空。
- `SECURITY.md` 没变：上游只支持最新版。
- 需要注意：安全修复只写在 changelog 里，而且可能次日就被回滚（见 1.2）。

**1.8 Hook fail-open**：一手，未改。文档仍写「其他非零退出码、超时或崩溃默认放行」，并明确说 Hook「不应作为唯一的安全防线」。

**1.9 Skills 自动发现**：一手
- 没有新增关闭开关。项目级 `.kimi-code/skills`、`.agents/skills` 总会扫描（源码 `skillRoots.ts`）。
- `merge_all_available_skills` 只决定是否合并多个目录，关不掉扫描。
- 工作区信任只管项目 MCP 配置，不管 skills。
- 附带一个可用于白标的钩子：`[identity] name/slug`（也可用 `KIMI_CODE_IDENTITY_NAME` 环境变量）可以替换系统提示词里的自称和 User-Agent 产品名。
- 另外，Kimi Code **没有**操作系统级沙箱。

### Q2 Kimi Work 与企业版

- **发布日志**（一手）：3.2.12 之后只有 **3.2.14（09-24）**（3.2.13 没出现在日志里），没有任何企业版、管理后台、SSO、审计、团队、白标、法律插件、私有化相关的条目。
- **Kimi 企业版（Kimi Business）**（一手）：
  - 价格 ¥4,200/座/年，只能年付、没有折扣，可开专票，可对公转账。
  - 权益：「默认不使用你的业务数据进行训练」；Kimi Work、集群、定制看板、精选插件全开；可调用 Kimi Code。
  - 管理能力：管理员可邀请、移除成员，个人空间与企业空间隔离；只支持 Web 和桌面端。
  - **没有 SSO、审计日志、策略下发**（企业版着陆页、介绍页、FAQ 全文均未出现）。
  - 来源：[介绍](https://www.kimi.com/help/kimi-business/kimi-business)、[FAQ](https://www.kimi.com/help/kimi-business/kimi-business-faq)、[着陆页](https://www.kimi.com/business)。
- **法律渠道冲突**（一手）：官方 08-28 文章称「国内多家『红圈律所』已为员工配备了 Kimi 企业版」（[原文](https://www.kimi.com/news/kimi-k3-legal)）。9 月官方新闻里**没有**新的法律动作（查不到）。

### Q3 Kimi 开放平台

- **价格**（一手）：
  - K3：输入 ¥20，缓存命中 ¥2，输出 ¥100；缓存写入 5 分钟档 ¥20、1 小时档 ¥40。
  - K2.6：¥6.5/¥1.1/¥27；K2.7-code：¥6.5/¥1.3/¥27。
  - 新列出的 `kimi-k2.7-code-highspeed`：¥13/¥2.6/¥54。
  - 以上均不变（新列出的除外）。K2.5 已于 08-31 下线，K2 系列已于 05-25 下线，说明模型生命周期不到 1 年。
- **K2.8**：模型列表和价格页都没有（一手），所以没有 API 和计价。
- **Batch**：只支持 K2.6 和 K2.7-code，按标准价 60% 计费，**不支持 K3**（一手）。
- **并发与配额**（一手）：Tier 表不变（Tier5：并发 100、RPM 300、TPM 500 万）。超过部分只能走「联系销售」表单（[FAQ](https://platform.kimi.com/docs/guide/account-and-payments)）。补充几条组织层能力（[组织指南](https://platform.kimi.com/docs/guide/org-best-practice)）：
  - **IP 白名单**：最多 20 条，只支持公网 IPv4；
  - 按项目设置月度、日度预算和 TPM 上限；
  - 企业认证组织最多 **50 个项目、100 个 API Key**；
  - 所有项目共享组织的限速和余额。
- **数据条款**（一手，但存在矛盾）：
  - 服务协议（08-31 生效）§6.3 原文仍是「授予我们一项免费的使用权，以……将您输入输出之内容及反馈用于模型服务优化」。
  - 帮助中心却写「通过 API 提交的用户数据……不会被用于训练或改进 Kimi 的模型」（[数据安全 FAQ](https://www.kimi.com/help/kimi-api/api-data-security)）。
  - ZDR 页写「默认不使用企业客户数据训练模型」，ZDR 开通后响应返回即清除。但 ZDR **不覆盖**直接上传的图片和视频、托管智能体、安全日志和账单，也不覆盖第三方插件和连接器；按需向企业开放，需联系销售。
- **专属部署、私有化、认证推理伙伴**：
  - 平台上没有这类官方页面（查不到）。
  - K3 许可提到「certified inference partners」，但没有公开名单（查不到）。
  - 黄震昕 07-21 称「Kimi 现阶段暂不提供私有化部署服务」（单一，[新浪](https://finance.sina.com.cn/jjxw/2026-07-21/doc-iniiqquy8142888.shtml)）。
  - 合作伙伴计划原文把「数据不出域、系统私有化、算力国产化」列为伙伴（含中软）的能力（一手）。
- **托管智能体**（一手）：
  - 定位：「在模型推理 API 之上封装 Kimi Durable Harness」，概念有 Agent、Environment、Session、Vault、Memory、Trigger。
  - 云沙箱：Debian 12，预装 LibreOffice、pandoc、OCR；网络默认 `unrestricted`，推荐生产用 `limited` 白名单。
  - 权限：只有 `always_allow` 一种，**没有人工审批**。
  - 数据：会话历史和沙箱状态存在服务端，**不适用 ZDR**。
  - 工具集叫 `default_toolset_20260901`（read_file、shell、ipython……），和 Kimi Code 的工具体系不同，推测是另一套 harness。
  - 官方插件目录只有金融、天眼查、搜索，**没有法律插件**。

### Q4 月之暗面 9 月在法律行业的动作

- **官方**（一手）：9 月没有法律专项发布。最近一次是 08-28 的《法律行业为什么都在用 Kimi K3？》：提到 Harvey Tenet、红圈律所用企业版，数据源为元典和天眼查。
- **可复制的行业模板**（一手）：09-17 金融方案，套路是「10+ 数据源 + 9 个 Skills + 与中信建投共建的 5 项合规措施（数据分级、个人信息脱敏、工具授权、人工复核、审计追溯）+ 托管智能体」。推测法律方案可能照此复制，但查不到任何计划。
- **法律数据**：
  - 元典 6 月已接入 Kimi 全系，而且是**非排他**合作（元典称后续会接入更多平台，[搜狐](https://www.sohu.com/a/1035268808_122726242)，交叉）。
  - Kimi Code 的官方插件 **Kimi Datasource** 含「元典智库等」法规和案例数据，但文档写明「使用前需先通过 `/login` 完成 Kimi Code 账号 OAuth 登录，数据查询会消耗 Kimi Code 套餐额度」（一手，`docs/zh/customization/plugins.md`）。这意味着用 API Key 接入的 SaaS 用不了这个插件（推测）。
- **北大法宝、法意与 Kimi 的合作、与律所的合作公告**：查不到。
- **登月计划伙伴**：华胜天成、金山云、亚康、亚信在法律行业的动作都查不到；09-23 的 21 世纪经济报道也未提及法律。

### Q5 运行时备选复核

| 候选 | 当前状态 | 结论 |
|---|---|---|
| **Kimi Code** | 2.1.1，MIT，Windows 原生签名二进制，提供 ACP、KAP、print 三种入口，与官方 Desktop 和 Kimi Work 同源 | 仍是首选，但需要 fork 打补丁（见 ③） |
| **opencode** | npm latest **1.18.33**（09-28），MIT；`opencode acp` 通过 stdio 工作，`/undo` 和 `/redo` 不支持；`opencode serve` 默认绑定 127.0.0.1:4096，**默认无鉴权**，设 `OPENCODE_SERVER_PASSWORD` 才启用 Basic Auth；OSV 上有 CVE-2026-22812 和 CVE-2026-22813（均为 1 月，已修）；GitHub 另有 v2.0.x 标签，未发到 npm，用途未核实 | 备份内核首选 |
| **OpenAI Agents SDK** | JS 0.18.0（09-10）、Python 0.22.3（09-17），MIT；可以用 OpenAI 兼容端点接 Kimi | 只是库，没有编码 Agent 的完整工具和会话体系 |
| **ACP 官方库** | `@agentclientprotocol/sdk` 1.5.0（09-21，Apache-2.0）；Rust crate 2.2.0（09-18）；Python 0.12.1（08-16） | 桌面壳直接用 TS SDK 1.x，与 Kimi Code 依赖的 1.3.0 同一代 |
| **AionUi** | v2.2.2（09-09），Apache-2.0，约 3.3 万星；通过 ACP 聚合 20 多个 CLI Agent，自带 WebUI 和 IM 通道；页面有「AionUi × Kimi Partnership」字样 | 只作为桌面壳交互的参考 |

- **Agents SDK 接 K3 的坑**（一手源码）：K3 多轮工具调用要求原样回传 `reasoning_content`。
  - Python 版默认只对 DeepSeek 回放推理内容，接 Kimi 要自己传 `should_replay_reasoning_content` 钩子；
  - JS 版回传的字段名是 `reasoning`，不是 `reasoning_content`，需要自定义 Model（字段兼容性待实测）。
  - 来源：[Python 回放策略](https://github.com/openai/openai-agents-python/blob/main/src/agents/models/reasoning_content_replay.py)、[JS 转换器](https://github.com/openai/openai-agents-js/blob/main/packages/agents-openai/src/openaiChatCompletionsConverter.ts)。
- **结论**：对「Windows 桌面和云端沙箱跑同一内核」这个要求，**Kimi Code 仍是最优**（推测，依据是一手事实）。理由有四条：
  1. 唯一同时满足 MIT 许可、Windows 原生签名、ACP 与 REST 双接口、与 Kimi 官方产品同源的候选；
  2. 托管智能体的工具体系和 Kimi Code 不同，数据留在月之暗面，只有 `always_allow` 权限，不满足「同一内核、数据留在中软云」；
  3. **备份选 opencode**（同为 MIT 加 ACP，内置 Moonshot 提供方），需自行加鉴权并重做法律工具层；
  4. Agents SDK 只适合云端做定制编排。

### Q6 K3 开放权重许可与私有化硬件

- **许可**（一手）：LICENSE 未改动，要点如下。
  - MaaS 条款：营收超过 2000 万美元的 MaaS 经营者需另签协议。MaaS 定义**排除**「模型能力仅嵌入特定功能或 harness 的终端产品」，也排除单纯转发请求到他人托管的模型。
  - 月活超 1 亿或月营收超 2000 万美元时，需显著展示「Kimi K3」。
  - 内部使用，以及通过官方产品或认证推理伙伴的使用，都豁免上述两条。
- **NVIDIA / AMD 硬件**（一手）：vLLM 官方 recipe 写明「At least 8x GB300. Multi-node for real production traffic」，或至少 8 张 MI355X/MI350X；需要 CUDA 13 和 r580 以上驱动；权重约 **1.56 TB**（原生 MXFP4）。[recipe](https://recipes.vllm.ai/moonshotai/Kimi-K3)
- **昇腾**（一手，vLLM Ascend 文档）：
  - 使用第三方 **Eco-Tech/Kimi-K3-w4a8**（ModelScope）权重；
  - Atlas 800 A3（16 卡 × 64G）：4 节点混部支持 128K 上下文，8 节点支持 1M；
  - 16 节点可做 PD 分离；
  - Atlas 800 A2：8 节点、**只支持文本**、256K；不支持视频输入。
  - [教程](https://docs.vllm.ai/projects/ascend/en/v0.23.0/tutorials/models/Kimi-K3.html)
- **造价**（单一，网易 07-28）：8 张 MI355X 起步约 170–240 万元；64 卡以上的商用集群约 1400–1900 万元。

---

## ③ 对方案的影响与建议

### 内核选型
1. **桌面端**：维持 Kimi Code 经 ACP 由 exe 壳驱动。但要把审计和 DLP 的边界从 ACP 挪到**操作系统层**：Windows 用独立低权限用户或 AppContainer 加 Job Object，文件访问走白名单。原因是 ACP 只拦文本文件读写，docx、pdf 会绕过。
2. **云端**：维持在中软托管云里自建 Kimi Code 沙箱（容器加出网白名单）。托管智能体只作为**不含客户数据**的负载的可选项（如公开法规检索、营销材料生成），并在合同里写明它不适用 ZDR。
3. **备份**：opencode（保留 ACP 适配层，内核可替换）。技能统一用 `SKILL.md` 格式，Kimi Code、opencode、托管智能体三边都能用。

### 版本锁定
- 锁定 **2.1.1（`f67e6398`）加中软补丁集**，不要停在 2.1.0：2.1.0 的加固是 2.1.1 才撤掉的，2.1.0 另有已被修正的问题。每两周跟一次上游，由自动化回归（ACP 契约、Windows、MCP）把关。
- 模型侧按 K3 设计，并预留 K2.7-code 作降本档。模型生命周期不到 1 年，SDK 层必须做模型别名映射。

### 需要的补丁 / fork（按优先级）
1. **重新打上 #3964 的加固**：realpath 访问、git hardening、`local.toml` 信任门控；同时补上 Origin null 修复。这些代码在 `6451f1e` 里现成，可以直接 cherry-pick。
2. **外连全部关闭**：构建时写死 `telemetry=false` 和 `KIMI_DISABLE_TELEMETRY=1`，设 `KIMI_CODE_NO_AUTO_UPDATE=1`；移除 Remote Control 中继、插件市场 CDN、WebBridge 和 Computer Use 的二进制下载；关闭问卷。
3. **Hook 可配置为 fail-closed**：至少让 PreToolUse、UserPromptSubmit 在出错时拒绝执行。
4. **项目级 skills 自动发现可关闭**（改 `skillRoots.ts`），只加载中软签发的 skills 目录。
5. 修 Windows 问题：stdio MCP 裸命令（改为绝对路径解析）、Hook 弹控制台窗口（加 `windowsHide`）、监听根目录。修 ACP 问题：#4027 定时任务轮次不下发、#3973 审批卡不显示命令。
6. 通过 `[identity]` 完成白标。

### 谈判项（对月之暗面）
1. **数据**：签书面 DPA，并开通 ZDR。明确排除协议 §6.3 的「模型服务优化」使用权，与帮助中心的表述对齐。确认 ZDR 覆盖文件抽取接口。
2. **渠道**：企业版 ¥4,200/座/年 直销，且已进入红圈律所。需要约定法律行业的伙伴价格、报备与撞单规则，或者联合销售。
3. **法律数据**：Kimi Datasource（元典）绑定 Kimi 账号和会员额度，需争取 API 或伙伴渠道可用；否则直接和元典、北大法宝签约。
4. **容量**：争取超过 Tier5 的专属并发，以及超过 50 个项目、100 个 Key 的上限（多租户计量）；争取 K3 Batch 和 K2.8 API 的时间表。
5. **安全支持**：作为伙伴，争取被锁定版本的漏洞预通知和补丁回移（上游只支持最新版）。
6. **K3 许可**：书面确认中软法律 SaaS 属于「嵌入 harness 的终端产品」、不构成 MaaS；私有化交付时争取「认证推理伙伴」资格。
7. **托管智能体（若采用）**：数据驻留与保留期限、删除 SLA；争取加入 `ask` 权限模式和 ZDR 选项。

---

## ④ 未核实清单

| 项目 | 状态 |
|---|---|
| 托管智能体的 harness 是否就是 Kimi Code 引擎 | 查不到（工具命名不同，推测不是同一套） |
| ZDR 的开通门槛、价格，是否覆盖 `/v1/files` 抽取 | 查不到，需问销售 |
| Kimi 企业版官方页面的上线日期；国际版价格 | 未核 |
| K2.8 Preview 在 kimi-for-coding 中的现状 | 本次未复核（开放平台确认没有） |
| 认证推理伙伴名单；国内云（金山云、华为云等）上 K3 的托管情况 | 查不到 |
| 月之暗面是否计划推出法律行业解决方案 | 查不到 |
| 登月伙伴在法律行业的项目 | 查不到 |
| opencode v2.0.x 标签的性质（桌面端还是新主线） | 未核实（Release 页加载失败） |
| Agents SDK 的 JS `reasoning` 字段能否被 K3 接受 | 需实测 |
| SGLang 或 TokenSpeed 的 K3 最低硬件口径 | 未核（只核了 vLLM 和 vLLM Ascend） |
| Eco-Tech W4A8 昇腾权重是否获月之暗面认可、精度损失多少 | 查不到 |
| GitHub GHSA 的 API 查询 | 触发匿名限流，改为读 HTML 页面和 OSV，结论为「没有公开公告」 |
