# 调研 S1：Kimi Work 能力来源（本机 / Kimi 云）与 Kimi Code 云依赖

- 调研日期：2026-10-09
- 调研目的：弄清 Kimi Work 标准版各项能力哪些在本机执行、哪些依赖月之暗面云端；中软只采购开放平台 API token 时，哪些云端服务拿不到、需自建或替换；以及开源 Kimi Code（MIT）作为发行版本地内核的云依赖。
- 标注口径：【一手】= 官方文档 / 官方仓库 / 官方公告；【二手】= 媒体与第三方。每条附 URL 与发布/更新日期（页面未标日期的注明「页面未标日期，抓取于 2026-10-09」）。查不到写「未查到」，不推测补全。
- 方法：curl --compressed 直抓 kimi.com 帮助中心与开放平台文档（含 .md 版）；GitHub REST API 与 raw.githubusercontent.com 读 kimi-code 仓库；WebSearch 补充媒体报道。
- 承接：v6 调研（`research/2026-10-02-云地划分v6/调研-R1-国内办公Agent云地划分.md`）已确认截至 10-02 Kimi Work 最新为 3.2.15（09-30）；锁版 Kimi Code 为 2.1.1（`research/2026-10-01-kimi-code-repo-facts.md`）。本轮只核增量与此前未覆盖的问题。

---

## Q1 Kimi Work 版本更新（3.2.15 之后，截至 2026-10-09）

**结论：截至 2026-10-09 抓取，官方发布日志最新版本仍为 3.2.15（2026-09-30），3.2.15 之后未查到新版本。**【一手】https://www.kimi.com/zh-hans/help/kimi-work/release-notes （页面持续更新，未标“最后更新”日期；抓取于 2026-10-09，页面顶部第一条即 3.2.15）。说明：`.md` 后缀版本在该域名下不存在（返回的是同一 HTML 外壳），本轮以 curl --compressed 抓 HTML 后去标签读取正文。

因无新版本，下面仅把 3.2.x 系列中与本课题（权限、云/本地、远程控制、企业治理、插件、定时任务、浏览器）相关的条目逐条摘出，供 v7 方案引用（均出自上述发布日志页，版本日期即发布日期）【一手】：

| 版本（日期） | 类别 | 变更原文要点 | 云/本地含义 |
|---|---|---|---|
| 3.2.15（09-30） | 插件/浏览器 | Notion 与飞书文档“人机双写”；插件创建的 Notion/飞书文档展示产物卡片；内置浏览器打开 Notion/飞书文档支持 comments 编辑与页面问答 | 依赖第三方 SaaS（Notion/飞书）的 OAuth 插件 |
| 3.2.15（09-30） | 账号 | 账号退出登录时，如有运行中的任务将二次确认 | 任务运行与账号登录态绑定 |
| 3.2.14（09-24） | 远程控制 | 手机端可直接预览 Office、html 等文件；手机端可向 Kimi Work 上传附件 | 文件内容会从桌面到手机、从手机到桌面传输（链路未公开，见 Q2） |
| 3.2.14（09-24） | 文件 | Office 类文件支持管理历史版本，修改记录可溯源 | 本机文件版本管理（未说明存储位置） |
| 3.2.14（09-24） | 浏览器 | 浏览器网页批注，可引用到对话框 | 内置浏览器 |
| 3.2.12（09-22） | 文件 | 取消输入框文件大小限制，可添加任意大小附件 | — |
| 3.2.11（09-18） | Agent | 详情面板支持展示子 Agent 运行过程 | — |
| 3.2.9（09-14） | 远程控制/后台 | 电源模式增加“熄屏后保持唤醒”，远控与后台任务不中断 | 远控与后台任务依赖桌面端常驻 |
| 3.2.8（09-12） | 账号 | 修复登录刷新竞态，避免旧请求误清登录状态或覆盖新凭证 | 客户端依赖 Kimi 账号凭证 |
| 3.2.7（09-11） | 插件/云 | 新增网站部署插件，安装后本地网站项目可一步云部署 | 部署目标为云（插件中心列有 Cloudflare 插件；该部署插件的目标平台官方未写明） |
| 3.2.7（09-11） | 远程控制 | 远程控制消息分段展示，子 Agent 卡与产物卡对齐桌面形态 | — |
| 3.2.7（09-11） | 定时任务 | 修复额度耗尽时定时任务页卡死 | 定时任务消耗会员额度 |
| 3.2.6（09-07） | 插件 | 流内推荐/安装插件；支持通过 GitHub 链接安装插件；插件详情页新增 MCP 连接状态展示与连接管理 | 插件可来自 GitHub 第三方 |
| 3.2.6（09-07） | 定时任务 | 退出应用前将确认仍在运行的定时任务 | 本地定时任务随应用进程 |
| 3.2.5（09-04） | 远程控制 | 新增远程控制：可通过手机远程控制桌面端 Kimi Work | 首次引入 |
| 3.2.5（09-04） | 浏览器 | 新增应用（Apps）功能，提升 Agent 网页操作能力 | — |
| 3.2.5（09-04） | 插件 | 插件/技能市场更新，支持插件/技能搜索；设置中心改版，打通 Chat 与 Work 模式 | 帮助中心称“未登录时无法安装或使用插件”（plugins-and-skills/overview），市场与 Kimi 账号绑定；托管位置官方未写明 |
| 3.2.3（08-28） | 插件 | 插件市场上线「新建插件」入口 | — |
| 3.2.2（08-26） | 权限 | 运行权限新增「默认」，全局「默认 / 手动允许 / 全部」三档 | 权限在本机执行 |
| 3.2.2（08-26） | 浏览器 | 内置浏览器的 Agent 控制改为默认开启 | — |
| 3.2.2（08-26） | 工作目录 | 「对话区」聊天的根目录不再共享，每个对话单独新建工作目录 | 本机目录隔离 |
| 3.2.0（08-19） | 浏览器 | 新增 Agent 内置浏览器；mac 端可从本机 Chrome 导入 Cookie 复用登录态（默认关闭） | 本机浏览器 |
| 3.2.0（08-19） | 浏览器 | Kimi WebBridge 插件化：真实浏览器控制改为插件形态，默认关闭 | 本机 Chrome 扩展 |

企业治理：3.2.x 发布日志中**未查到**任何 SSO、审计日志、管理员策略下发相关条目。

---

## Q2 Kimi Work 各能力的执行位置与云端依赖

### 2.1 总体定位（官方原话）
- “Kimi Work 是面向知识工作者的通用型本地 Agent……本地 Agent 内核：以 Kimi Code 为内核、搭载 Kimi K3 模型，提供本地 Agent 基础能力，包括安装和使用技能（Skill）、运行定时任务等。”“专业 Skills：继承在线版 Kimi Agent 的建站、PPT 等专业 Skills”。【一手】https://www.kimi.com/zh-hans/help/kimi-work/overview （页面未标日期，抓取于 2026-10-09）
- 官方 Kimi Web 与 Kimi Work 对比表：本地文件与系统访问——Work“能够读写本地文件、运行命令”；编程能力——Web“在云端生成”，Work“在本地运行 Python 和 shell，并处理本地文件，数据保留在设备端”；网页操作——Web“搜索并阅读网页”，Work“通过 Kimi WebBridge 实现网页自动化操作”。【一手】https://www.kimi.com/resources/kimi-work-introduction （更新于 2026-10-08）
- FAQ：Kimi Work“能读取并处理你的本地文件夹、通过 WebBridge 自主浏览网页、在后台运行 Python 代码、执行定时任务”。【一手】https://www.kimi.com/zh-hans/help/kimi-work/kimi-work-faq （页面未标日期，抓取于 2026-10-09）
- 企业版落地页：“Kimi：通过网页浏览器随时使用 Kimi。数据云端同步……Kimi Work：桌面端直连本地文件，支持定时任务与全天候后台运行”。【一手】https://www.kimi.com/business （页面未标日期，抓取于 2026-10-09）
- 计费：Agent、深度研究、PPT、文档、表格、Kimi Code、Kimi Work、Kimi Claw 等“共享一个额度池，额度按实际 token 消耗扣除”。【一手】https://www.kimi.com/zh-hans/help/agent/agent-quota-and-billing （页面未标日期，抓取于 2026-10-09）——说明 Kimi Work 的模型推理走 Kimi 会员额度（即 Kimi 云端推理），不是用户自带 API Key。

### 2.2 手机远程控制
- 官方说明：“通过手机上的 Kimi App，你可以连接并操作电脑上的 Kimi Work。任务始终在你的电脑上本地执行。文件、凭证和环境配置都保留在本机，手机只是查看和操作任务的远程窗口。”执行过程实时同步到手机；审批请求“同时推送到电脑和手机”；任务结束后“更新后的文件和执行结果也会回到手机上”；一台手机可连多台电脑；电脑“只需保持开机、联网”。【一手】https://www.kimi.com/resources/kimi-work-remote-control （更新于 2026-09-22）
- 鉴权/配对：电脑端在侧边栏「远程控制」打开“允许手机远程控制此设备”；手机安装 Kimi App（Android/iOS ≥3.1.0）并“登录与电脑端相同的账号”；在 App 中选电脑点击连接，再回电脑端点击允许。【一手】同上
- **是否经 Kimi 云中转：Kimi Work 官方页面未写明**；但手机与电脑以同一 Kimi 账号配对、不要求同一局域网、电脑“保持联网”即可远程下发任务，且 3.2.14 起支持手机预览 Office/html 与向桌面上传附件（发布日志）——**这些是公开事实；“必经 Kimi 云端”属于推断，Kimi Work 官方未明说**。
- 作为同内核参照，Kimi Code CLI 的远程控制文档明确：“远程访问统一走 Kimi 中转服务”，访问链接形如 `https://code-rc.kimi.com/devices/<设备 ID>/`（global 区为 code-rc.kimi.ai），“远程设备必须登录与本机相同的 Kimi 账号”，需“付费会员”，“本机保持唤醒并联网：远程控制依赖本机与 Kimi 服务保持连接”；本地 `kimi web` 用“本地 token”鉴权，远程控制用“登录同一个 Kimi 账号”。【一手】https://www.kimi.com/code/docs/kimi-code-cli/guides/remote-control.html （页面未标日期，抓取于 2026-10-09）
- **端到端加密：Kimi Work 与 Kimi Code 远程控制官方文档均未提及端到端加密，未查到。**

### 2.3 会话 / 项目 / 看板的存储
- 远程控制文章：“工作文件与项目上下文都保存在电脑上的 Kimi Work 中”。【一手】https://www.kimi.com/resources/kimi-work-remote-control （2026-09-22）
- 看板：每用户最多 2 个看板、每看板 20 个小组件；“固定至桌面……退出客户端后窗口自动关闭”；小组件可“连接本地数据或外部插件”。【一手】https://www.kimi.com/zh-hans/help/kimi-work/dashboard 、https://www.kimi.com/zh-hans/help/kimi-work/widgets （页面未标日期，抓取于 2026-10-09）
- **Work 模式会话/项目/看板是否云同步、跨设备同步：官方未写明，未查到。**（“每用户最多 2 个看板”的配额表述与账号绑定，但不足以证明云存储。）

### 2.4 联网搜索、深度研究、网页抓取
- Kimi Work 帮助中心与介绍文只说“结合本地文档分析、开放网页搜索、专业数据集”。【一手】https://www.kimi.com/resources/kimi-work-introduction （2026-10-08）
- **Kimi Work 的联网搜索/网页抓取由哪个服务执行：Kimi Work 官方未写明，未查到。** 其内核 Kimi Code 的 WebSearch/FetchURL 调用 Moonshot 云端搜索/抓取服务（见 Q4），可作参照但不能直接等同。
- 深度研究在 Kimi 产品中是会员功能，按额度计费（见 2.1 计费页）；**Kimi Work 内是否调用云端深度研究：未查到。**
- WebBridge：官方描述为“内置浏览器操作方案，能像用户一样使用浏览器”，3.2.0 起“真实浏览器控制改为插件形态，默认关闭”。Plugin Builder 文档称“WebBridge 方式需要先在电脑上和 Chrome 中装好 WebBridge”。【一手】overview 页、发布日志、https://www.kimi.com/zh-hans/help/plugins-and-skills/create （页面未标日期，抓取于 2026-10-09）——属本机浏览器执行。

### 2.5 文件解析（PDF/Office）
- **Kimi Work 中 PDF/Office 文件解析在本机还是云端：官方未写明，未查到。** 已知事实仅有：预览器支持 PDF 目录与页码跳转（3.2.9）、可选中 PPT/Excel/Word/Markdown 内容交给 Kimi 修改（3.2.12）、Office 文件历史版本（3.2.14）、取消附件大小限制（3.2.12）。【一手】发布日志

### 2.6 插件/技能市场、Plugin Builder、MCP
- 插件构成：“Kimi Plugin 遵循 Kimi Code 的插件定义”，可包含 Skills、MCP、Agents、Hooks、Commands、System Prompt；“部分插件需要 OAuth 授权”；“仅企业版插件：非企业版用户……无法安装”；“未登录时无法安装或使用插件”；“部分插件会……按实际调用情况消耗会员额度”；第三方插件“数据处理规则由该公司独立制定”。【一手】https://www.kimi.com/zh-hans/help/plugins-and-skills/overview （页面未标日期，抓取于 2026-10-09）
- 插件中心内置专业数据库插件：金融（Wind、恒生聚源、标普、同花顺等）、工商/法律（天眼查、华宇元典等）；外部应用插件含钉钉、飞书、WPS、Notion、Canva、Cloudflare、GitHub、Neon、Supabase、Kimi Computer Use 等。【一手】https://www.kimi.com/zh-hans/help/kimi-work/plugin-center （页面未标日期，抓取于 2026-10-09）
- Plugin Builder：“会在本地生成插件文件，自动通过结构与规范校验，随后登记进你的个人插件市场”；“转换产物保留在本地工作区的 plugins/ 目录”；MCP 服务地址需用户提供。【一手】https://www.kimi.com/zh-hans/help/plugins-and-skills/create （页面未标日期，抓取于 2026-10-09）
- **插件市场与“个人插件市场”的服务端托管位置、官方 MCP（如华宇元典、天眼查）是否由 Kimi 云代理转发：官方未写明，未查到。** 已知“仅企业版插件”“按调用消耗会员额度”两点说明这些官方插件与 Kimi 账号/计费系统绑定。

### 2.7 内置浏览器
- 3.2.0 新增 Agent 内置浏览器，标签页绑定会话，mac 端可从本机 Chrome 导入 Cookie（默认关闭）；3.2.2 起内置浏览器的 Agent 控制默认开启。【一手】发布日志——本机执行。

### 2.8 定时任务
- “在 Kimi Work 桌面端，定时任务在本地运行，需要应用处于开启状态才会执行；电脑休眠、关机或应用关闭期间错过的触发不会在下次开启时补跑……（相比之下，在 Kimi 中创建的定时任务在云端执行，不需要保持客户端开启。）”【一手】https://www.kimi.com/zh-hans/help/kimi-work/kimi-work-faq （页面未标日期，抓取于 2026-10-09）
- 可同时开启的定时任务数按会员套餐：Free 2 / Go 6 / Pro 15 / Max 20 / Ultra 25；“在 Kimi Work 桌面端本地运行的定时任务不受上述过期规则限制”；已读状态在 Web 与移动端“跨端同步”。【一手】https://www.kimi.com/zh-hans/help/features/scheduled-tasks （页面未标日期，抓取于 2026-10-09）——触发在本机，但开启数量受账号套餐约束（配额校验位置未写明）。

### 2.9 Office / PPT 直出
- 官方：PPT 等“专业 Skills”继承自在线版 Kimi Agent；Work“在本地运行 Python 和 shell，并处理本地文件”。【一手】overview 页；kimi-work-introduction（2026-10-08）
- **PPT/Word/Excel 生成是否完全由本机代码执行、是否调用云端 PPT 渲染服务：官方未写明，未查到。**（3.2.15 修复“PPT 并发编辑可能导致文件损坏”，说明 PPT 文件在本机被编辑，但不足以排除云端参与。）

### 2.10 Kimi Business 企业版治理能力
- 企业版：“为整个团队配备……网页版 Kimi、Kimi Work 与 Kimi Code”；“支持管理员邀请、移除成员，查看坐席使用与订单发票”；“企业数据不用于模型训练，企业与个人空间隔离”；“专属技术支持”；按年付费。【一手】https://www.kimi.com/business （页面未标日期，抓取于 2026-10-09）
- FAQ：“管理员可在企业成员范围内分配和管理席位”；“暂不支持管理员自助转让”；“目前 Kimi App 暂不支持 Kimi Business 企业版功能……桌面端已支持企业版”；合规与安全资料“请联系销售或客服”。【一手】https://www.kimi.com/zh-hans/help/kimi-business/kimi-business-faq （页面未标日期，抓取于 2026-10-09）
- **SSO、审计日志、管理员策略（如统一禁用插件/权限档位）：截至 10-09 官方页面均未查到。**（与 v6 结论一致。）

---

## Q3 月之暗面开放平台：只买 API token 能买到什么

> 说明：platform.moonshot.cn 已 301 跳转到 platform.kimi.com；文档为 Mintlify 站点，每页可加 `.md` 后缀直接取原文，完整索引在 https://platform.kimi.com/docs/llms.txt （抓取于 2026-10-09）。以下文档页除特别注明外均“页面未标日期，抓取于 2026-10-09”，全部【一手】。

### 3.1 模型清单（API 可用）
- 当前可用：`kimi-k3`（2.8 万亿参数、原生视觉、1M 上下文）、`kimi-k2.7-code`（256k）、`kimi-k2.7-code-highspeed`（约 180 tokens/s）、`kimi-k2.6`（256k，视觉+文本、思考/非思考）。已下线：`kimi-k2.5` 与 `moonshot-v1` 全系（2026-08-31）、`kimi-k2` 系列（2026-05-25）、`kimi-latest`（2026-01-28）。https://platform.kimi.com/docs/models.md
- **K2.8：开放平台模型清单中未出现，未查到 K2.8 API。**
- 平台发布记录：K3 于 2026 年 7 月上线开放平台 API；K2.7 Code 于 2026 年 6 月上线；K2.6 于 2026 年 4 月。https://platform.kimi.com/docs/changelog/index.md

### 3.2 价格（元 / 1M tokens）
| 模型 | 缓存写入 5m | 缓存写入 1h | 输入（缓存命中） | 输入（未命中） | 输出 | 上下文 |
|---|---|---|---|---|---|---|
| kimi-k3 | 20.00 | 40.00 | 2.00 | 20.00 | 100.00 | 1,048,576 |
| kimi-k2.7-code | — | — | 1.30 | 6.50 | 27.00 | 262,144 |
| kimi-k2.7-code-highspeed | — | — | 2.60 | 13.00 | 54.00 | 262,144 |
| kimi-k2.6 | — | — | 1.10 | 6.50 | 27.00 | 262,144 |
来源：https://platform.kimi.com/docs/pricing/chat.md 。要点：开放平台“按量计费……不提供订阅制方案”；“文件相关接口（文件内容抽取/文件存储）**限时免费**”，抽取出的内容作为 input 时按 token 计费。

### 3.3 上下文缓存
- 自动对重复前缀启用；K3 缓存写入单独计费，TTL 两档 5m / 1h（默认 5m）；命中价为未命中价的 1/10；命中后有效期续期；“缓存不支持手动清除”。https://platform.kimi.com/docs/guide/context-caching.md
- Anthropic 兼容端点支持顶层 `cache_control`（ttl 5m/1h）。https://platform.kimi.com/docs/api/messages.md

### 3.4 Batch
- 价格为标准价 **60%**；**仅支持 `kimi-k2.7-code` 与 `kimi-k2.6`（不含 K3）**；不受实时并发限制。https://platform.kimi.com/docs/pricing/batch.md ；Batch API 2026 年 4 月面向全量用户开放（changelog）。

### 3.5 联网搜索 / 网页抓取 / 官方工具（Formula）
- **新 REST 工具接口（2026 年 9 月上线）**：`POST /v1/tools/search`（联网搜索 Basic，¥0.01/次）、`POST /v1/tools/search_pro`（Pro，¥0.015/次，额外支持 `sites` 站点约束、`time_window`、结构化 `chunks`）、`POST /v1/tools/fetch`（网页抓取，¥0.01/次）；仅在成功且结果非空时计费；三者独立计费。https://platform.kimi.com/docs/pricing/websearch.md ；https://platform.kimi.com/docs/api/tools-search.md ；https://platform.kimi.com/docs/api/tools-fetch.md
  - 返回字段含标题、摘要、站点、链接、`authority`（来源权威性等级）；响应头会话 ID 固定为 `toolgw-{X-Msh-Track-Id}`（即走平台“工具网关”）。
  - fetch 仅支持 http/https；触发安全风控返回 403 `security_risk`；无正文 404 `markdown_not_found`。
  - **数据口径（搜索引擎来源、是否留存查询词）：文档未写明，未查到。**
- **内建工具 `$web_search`（存量方式）**：¥0.03/次 + 搜索结果计入 token；“**预计于 2026 年 10 月 20 日下线**，新接入请使用 `/v1/tools/search` 接口或官方工具 `web-search`”。https://platform.kimi.com/docs/pricing/websearch.md
- **官方工具 / Formula 仍提供**：`convert`、`web-search`、`rethink`、`random-choice`、`mew`、`memory`、`excel`、`date`、`base64`、`fetch`；“除联网搜索 `web-search` 按次收费外，其余官方工具目前限时免费”；调用链为 `GET /v1/formulas/{uri}/tools` → chat → `POST /v1/formulas/{uri}/fibers`；`web-search` 为 protected，结果以 `----MOONSHOT ENCRYPTED BEGIN----` 加密串返回、只能回灌给模型；Formula 是平台托管的“轻量脚本引擎”，启动/隔离/回收由平台负责（即在 Moonshot 云端执行）。**注意：`code_runner` 不在当前官方工具清单中，未查到。** https://platform.kimi.com/docs/guide/use-official-tools.md
- 限速：联网搜索 QPS 独立于 RPM/TPM（Tier0 1 → Tier5 50）。https://platform.kimi.com/docs/pricing/limits.md

### 3.6 Files API（file-extract）
- `purpose="file-extract"` 用于文本内容抽取，结果为 Markdown；支持 pdf/doc/docx/xls/xlsx/ppt/pptx/txt/md/epub/html 等；单文件 100 MiB；按组织总存储量限制，默认 10 GiB；“文件解析服务限时免费”；**图片不再做 OCR 抽取**（改用 `purpose="image"`）。https://platform.kimi.com/docs/api/files-upload.md ；2026 年 8 月 Files API 更新：文件 ID 加 `file_` 前缀、优化表格/公式解析、不再对图片 OCR（changelog）。
- 含义：文件解析在 Moonshot 云端执行，文件需上传至平台存储（10 GiB 组织配额）。

### 3.7 Anthropic / Responses 兼容端点
- Messages API：“以 Anthropic Messages API 兼容的格式调用……只需把 base URL 指向 `https://api.moonshot.cn/anthropic`”，路径 `POST /anthropic/v1/messages`。https://platform.kimi.com/docs/api/messages.md
- 另有 Responses API（`api/responses.md`）与 Chat Completions。https://platform.kimi.com/docs/llms.txt

### 3.8 限速与并发分级（按累计充值）
| 等级 | 累计充值 | 并发 | RPM | TPM | TPD | 搜索 QPS |
|---|---|---|---|---|---|---|
| Tier0 | ¥0 | 1 | 3 | 500,000 | 1,500,000 | 1 |
| Tier1 | ¥50 | 15 | 100 | 2,000,000 | 不限 | 3 |
| Tier2 | ¥100 | 40 | 100 | 3,000,000 | 不限 | 5 |
| Tier3 | ¥500 | 50 | 200 | 3,000,000 | 不限 | 10 |
| Tier4 | ¥5,000 | 60 | 200 | 4,000,000 | 不限 | 20 |
| Tier5 | ¥20,000 | 100 | 300 | 5,000,000 | 不限 | 50 |
来源：https://platform.kimi.com/docs/pricing/limits.md 。另：“代金券不计入累计充值总额”；风控限速“一旦触发即无法解除”；集群满载时可能临时限流。更高额度走“企业方案（联系销售）”。https://platform.kimi.com/docs/guide/product-plans.md

### 3.9 企业数据条款与 ZDR
- **服务协议（版本更新 2026-08-24，生效 2026-08-31）**：“您输入的知识文档、数据、文本、文件……会在本协议约定范围（包括提供、优化服务等）内被使用”；“您授予我们一项免费的使用权，以在法律允许的范围内将您输入输出之内容及反馈用于模型服务优化”；“我们仅依据相关法律法规要求或基于本服务的需要存储客户数据”。https://platform.kimi.com/docs/agreement/modeluse.md
- **ZDR 页**：“Kimi 开放平台默认不使用企业客户数据训练模型，ZDR 在此基础上进一步取消内容留存”；开通后提示词与响应“响应返回后即行清除”；内容安全审核照常；“**ZDR 按需开放给企业客户……可联系销售申请评估**”；接口/参数/计费不变；**例外**：“通过直接文件上传方式提交的图像或视频、使用 Kimi Hosted Agents 托管智能体的数据，零数据留存无法保证。安全日志、账单记录等运营数据不属于零留存范围；第三方模型、连接器、插件等不受本协议约束。” https://platform.kimi.com/docs/guide/zero-data-retention.md
  - 注意两处口径张力：协议默认授予“模型服务优化”使用权，ZDR 页称“默认不使用企业客户数据训练模型”——“训练”与“服务优化”措辞不同，**需在中软合同中明确排除**（此为合规提示，非事实推断）。
  - ZDR 例外只点名“图像或视频”的直接文件上传；**`file-extract` 文本文件是否在 ZDR 覆盖内：文档未明说，未查到。**
- 组织级能力：2026 年 6 月起支持“组织级 API IP 白名单”；9 月起支持组织/项目级搜索 QPS 限额配置；落地页称“项目级预算管控、余额预警及弹性速率限制”。https://platform.kimi.com/docs/changelog/index.md ；https://www.kimi.com/business
- **重要区分**：“Kimi Code API 与本平台提供的 API 服务相互独立，不通用”（Kimi Code 为订阅制）。https://platform.kimi.com/docs/guide/product-plans.md

---

## Q4 Kimi Code 的云端依赖

> 依据：GitHub 仓库 https://github.com/MoonshotAI/kimi-code （MIT）本地锁版克隆 `platform/third_party/kimi-code`，commit `f67e6398`（tag `@moonshot-ai/kimi-code@2.1.1`，2026-09-24）的 docs 与源码；main 分支 2.1.1 之后的 15 个 commit 未触及 search/fetch/remote-control 配置（见 Q5 提交清单），故下列结论对 10-08 的 main 同样成立。全部【一手】。

### 4.1 WebSearch / FetchURL 走哪个服务
- 配置项：`services` 只识别两个固定 key：`moonshot_search`（网页搜索）、`moonshot_fetch`（网页抓取），字段 `base_url`、`api_key`、`oauth`、`custom_headers`；也可用环境变量 `KIMI_WEB_SEARCH_BASE_URL/_API_KEY`、`KIMI_WEB_FETCH_BASE_URL/_API_KEY`（优先于配置文件）。`docs/zh/configuration/config-files.md`（§services）、`docs/zh/configuration/env-vars.md:172-175`
- **默认 base_url**（配置示例）：`https://api.kimi.com/coding/v1/search`、`https://api.kimi.com/coding/v1/fetch`——即 **Kimi Code 订阅（OAuth 托管）后端**，不是开放平台。`docs/zh/configuration/config-files.md:69-75`；`KIMI_CODE_BASE_URL` 默认 `https://api.kimi.com/coding/v1`，含义为“OAuth 登录后的托管 API base URL”（`docs/zh/configuration/env-vars.md:98`）。
- **源码中的选择顺序**：
  - WebSearch：`fromServicesConfig() ?? fromManagedOAuth()`——显式配置了 `services.moonshot_search` 就用它；否则仅当当前模型 provider 是 Kimi OAuth 托管类型（Kimi Code 订阅登录）时，自动拼 `{KIMI_CODE_BASE_URL}/search`；**两者都没有时 WebSearch 工具不注册**（`webSearchTool.ts:117` `when: hasWebSearchProvider()`；文档 `docs/zh/reference/tools.md:62`“未注入时不会出现在工具列表中”）。`packages/agent-core-v2/src/app/auth/webSearch/webSearchService.ts:32-82`
  - FetchURL：`fromServicesConfig() ?? fromManagedOAuth() ?? localFetcher`——无配置、无 OAuth 时**回退本机直连抓取**（`LocalFetchURLProvider`）；托管抓取失败也会回退本地并上报遥测事件 `web_fetch_fallback`。`packages/agent-core-v2/src/app/web/webService.ts:33-78`、`providers/moonshot-fetch-url.ts:55-61`
- **能否用开放平台 API Key 调用**：
  - 配置层面**可以填任意 base_url + api_key**；Kimi Code 官方文档给出的 API Key 示例为 `base_url = "https://api.moonshot.cn/v1/search"` / `"https://api.moonshot.cn/v1/fetch"` + `api_key = "sk-xxx"`。`docs/zh/configuration/config-files.md`（§services 示例）
  - 但开放平台当前文档化的端点是 `POST https://api.moonshot.cn/v1/tools/search`、`/v1/tools/search_pro`、`/v1/tools/fetch`（见 Q3.5），**与 Kimi Code 文档示例路径（`/v1/search`、`/v1/fetch`）不一致**。请求体字段一致：Kimi Code 发送 `{"text_query": ...}` / `{"url": ...}`（`moonshot-web-search.ts:56`、`moonshot-fetch-url.ts:71`），开放平台 `/v1/tools/search` 必填字段也是 `text_query`、fetch 为 `url`；Kimi Code 解析响应中的 `search_results`，与开放平台返回字段同名。**是否可直接把 `base_url` 指向 `/v1/tools/search` 跑通：本轮未实测（无可用测试 Key），未查到官方说明。** Kimi Code fetch 请求带 `Accept: text/markdown`，开放平台 fetch 文档返回 JSON 的 `markdown` 字段——响应格式兼容性同样**未验证**。
  - 开放平台文档明确：“Kimi Code API 与本平台提供的 API 服务相互独立，不通用”。https://platform.kimi.com/docs/guide/product-plans.md ；开放平台另有“在 Kimi Code CLI 中使用 Kimi API Platform”指南，只讲 `/login` 选 `Kimi Platform (API key · platform.kimi.com)` 接入**模型**，未提 WebSearch/FetchURL 是否可用。https://platform.kimi.com/docs/guide/kimi-code-cli.md
- 权限口径：`WebSearch`、`FetchURL` 在内置工具表中为“**自动放行**”（不弹审批）。`docs/zh/reference/tools.md:59-60`——意味着搜索词/URL 会在无确认的情况下发往所配置的云端服务。

### 4.2 远程控制 relay
- 默认 relay：`REMOTE_CONTROL_RELAY_ORIGIN = 'https://code-rc.kimi.com'`（global 区 `https://code-rc.kimi.ai`），可用环境变量 `KIMI_CODE_REMOTE_CONTROL_RELAY_URL` 覆盖。`packages/remote-control/src/remote-control.ts:19-29`；`packages/oauth/src/region.ts:68,75`
- 仓库内只有**隧道客户端**：`@moonshot-ai/...remote-control` 包描述为“Kimi Remote Control tunnel client: registers this machine with the relay and forwards HTTP/WebSocket traffic to the local server”；客户端经 WebSocket 连 relay 的 `/v1/remote/create` 注册（上报 device_id、主机名、平台、版本、`local_base_url`），再把 relay 转来的 HTTP/WebSocket 请求转发给本机 `kimi web` 服务，并由客户端在本地注入本机 server token（`Authorization: Bearer <serverToken>`）。`packages/remote-control/package.json:5`；`remote-control.ts:131-140,197,446-470`
- 鉴权：启动需本机已 `kimi login`（读取 OAuth refresh token，否则报错“Remote Control requires a Kimi login”）；远端浏览器须“登录与本机相同的 Kimi 账号”；需付费会员。`remote-control.ts:285-296`；文档 `docs/zh/guides/remote-control.md`（官方站同文：https://www.kimi.com/code/docs/kimi-code-cli/guides/remote-control.html ）
- **relay 服务端是否开源：仓库 packages 列表（acp-server、agent-core-v2、kaos、kap-server、klient、kosong、minidb、node-sdk、oauth、pi-tui、remote-control、telemetry 等）中只有客户端，未见 relay 服务端代码；未查到其开源。**
- **是否端到端加密：客户端源码仅引入 `node:crypto` 的 `createHash` 与 `zlib.gzip`，未见任何密钥协商/加解密实现；官方文档也未提端到端加密。** 结论：通道为 TLS 到 relay，再由 relay 以应用层 HTTP 帧转发——**relay 侧能看到会话内容属合理推断，官方未确认也未否认**。

### 4.3 插件市场
- 默认 marketplace JSON：`https://code.kimi.com/kimi-code/plugins/marketplace.json`，可用 `KIMI_CODE_PLUGIN_MARKETPLACE_URL` 覆盖（支持 http/file URL 与本地路径）；`/plugins marketplace [source]` 可浏览自定义目录。`docs/zh/configuration/env-vars.md:151`；`docs/zh/customization/plugins.md:34,63`
- 官方插件 `kimi-datasource`（Wind、S&P Capital IQ、SEC EDGAR、财新、新华财经、世界银行、IMF……“corporate, academic, legal data”）默认调用 `https://api.kimi.com/coding/v1`，并读取本机 Kimi OAuth 凭据文件——**依赖 Kimi Code 订阅登录，开放平台 API Key 不能直接替代（代码只走 OAuth 托管路径）**。`plugins/official/kimi-datasource/kimi.plugin.json:4`；`bin/kimi-datasource.mjs:23,276-318`

### 4.4 `kimi web` / kap-server
- `@moonshot-ai/kap-server`：“Kimi Code server backed by the DI × Scope agent engine (agent-core-v2)”；`kimi web` 子命令即启动它（`apps/kimi-code/package.json` 中 `dev:kap-server` 脚本就是 `main.ts web`，`src/cli/sub/web/shared.ts` 引用 kap-server）。`packages/kap-server/package.json:5`
- 用途：本机/局域网图形界面，鉴权为“本地 token”，数据与执行在本机；`kimi rc` / `kimi web --remote-control` 把它经 Kimi 中转暴露到公网。https://www.kimi.com/code/docs/kimi-code-cli/guides/remote-control.html （对比表）
- 10-08 main 新增 `feat(kap-server): add allow_ignored_globs to fs:list`（#4058）。

### 4.5 源码中出现的其他 Kimi 云端端点（2.1.1，排除 docs/tests）
`https://auth.kimi.com`（OAuth）、`https://api.kimi.com/coding/v1`（订阅托管推理/搜索/抓取/数据源）、`https://api.kimi.ai/coding/v1`（global）、`https://api.moonshot.ai/v1`（开放平台 provider 预设）、`https://telemetry-logs.kimi.com/v1/event`（遥测上报）、`https://code-rc.kimi.com`（relay）、`https://platform.kimi.com`。——对中软而言，若内核只用开放平台 Key：推理可直连 `api.moonshot.cn/v1`；**遥测需显式关闭或改址**（v6 已确认 CLI 默认开启、node-sdk 嵌入路径默认无云端遥测，见 `research/2026-10-01-kimi-code-repo-facts.md` §7）。

---

## Q5 Kimi Code 仓库最新动态（截至 2026-10-09 抓取）

全部【一手】，来源 GitHub REST API：https://api.github.com/repos/MoonshotAI/kimi-code/releases?per_page=10 、/commits?per_page=60 、/pulls/2337 、/issues/4070 、/pulls?state=all ；npm：https://registry.npmjs.org/@moonshot-ai%2fkimi-code

- **Release**：最新仍为 `@moonshot-ai/kimi-code@2.1.1`（published 2026-09-24T07:24Z）；**2.1.1 之后无新 release**。npm `dist-tags.latest` 仍为 `2.1.1`（2026-09-24T07:27Z）。
- **SDK 发布 npm**：`@moonshot-ai/kimi-code-sdk` 在 npm registry 查询仍返回 **404（未发布）**。相关 PR #3855 `fix(node-sdk): forward --agent/--agent-file to the v2 engine`（open，最后更新 10-02）。
- **main 分支 2.1.1 之后的提交（共 15 个，最新 2026-10-08）**，与本课题相关者：
  - 2026-09-28 `1f6f0b1f` **feat: trust workspace via KIMI_CODE_TRUST_WORKSPACE env var (#4059)**——已合入 main，**尚未进入任何 release**。
  - 2026-09-29 `395d5372` feat(kimi-code): summarize workspace trust with configuration sources (#4056)
  - 2026-09-28 `a940f2ff` fix(agent-core-v2): publish permission mode changes on agent.status.updated (#4057)
  - 2026-09-29 `06ebfc82` fix(agent-core-v2): fold UserPromptSubmit hook output into the prompt message (#4081)
  - 2026-09-29 `f409caa2` fix(agent-core-v2): clear inherited cron tasks at the fork record (#4083)
  - 2026-09-29 `20a2cea7` feat: cap WaitFor at 90s and let new input end the wait (#4061)
  - 2026-09-30 `21406fb4` fix(agent-core-v2): omit completion token cap unless explicitly configured (#4091)
  - 2026-10-08 `0f052fee` fix(tui): sanitize foreground Bash tool output (#2919)
  - 2026-10-08 `5b936697` feat(kap-server): add allow_ignored_globs to fs:list (#4058)
  - 2026-10-08 `eec9bbd9` feat(kimi-code): support per-model survey popup overrides (#4033)
  - 其余：tower 唤醒中断（#3998）、NotifyUser（#4054）、undo 提醒（#4076）、sticky 消息（#4031）、PR 流程（#4023）。
- **#2337「honor configured permission rules」：仍 open、未合并**（created 2026-07-29，updated 2026-10-07，mergeable_state=dirty）；10-07 有第三方（NeuroSquad 桌面应用开发者）评论称其 `[[permission.rules]]` 的 allow 规则“parsed but never”执行，要求合入。https://github.com/MoonshotAI/kimi-code/pull/2337
- **#4070「PermissionRequest hook does not fire when the approval prompt originates from a (background) subagent」：仍 open**（最后更新 2026-09-28）。https://github.com/MoonshotAI/kimi-code/issues/4070
- **沙箱**：PR #4115 `feat(agent-core-v2): experimental OS sandbox, exec-policy engine, and network egress control`（open，2026-10-03 创建，外部贡献者 author_association=NONE，+4829/−135）：为 Bash 引入 macOS Seatbelt / Linux bwrap 沙箱、`.rules` 命令策略引擎、回环 HTTP CONNECT+SOCKS5 出网代理（域名白名单），全部实验开关默认关闭；**Windows 无后端（unsupported）**；关联 issue #4114。https://github.com/MoonshotAI/kimi-code/pull/4115
- **远程执行**：PR #4062 `feat: remote environments for SSH and Docker execution targets (phase 1)`（open，更新 09-30）。
- **其他 hook/遥测相关 open 项**：#4138（SessionStart hook stdout）、#4124（goal 续轮触发 UserPromptSubmit）、#4141（TurnStarted 可能晚于 Stop hook）、#3742（hook payload 暴露 agent 身份）、#2516（遥测路径脱敏，open）。
- **远程控制**：2.1.1 之后**无**与 remote-control 相关的提交或 PR（按标题检索最近 40 个 PR/issue）。
- **插件市场**：PR #4149 / issue #4148 申请把第三方插件 Aeon 加入 curated marketplace（open，10-08）——说明 curated 列表由官方仓库/官方 JSON 维护。

---

## Q6 Kimi Claw / Kimi 托管智能体（Beta）与私有化 / 专属部署

### 6.1 Kimi 托管智能体（Kimi Hosted Agents，开放平台，Beta）【一手】
- 上线：开放平台 2026 年 9 月发布记录：“在模型推理 API 之上，我们封装了 Kimi Durable Harness，为企业提供 7x24 小时全托管的智能体运行环境……会话历史、工具执行、沙箱、失败恢复、超时重试全部由平台托管”；支持控制台 + API + hakimi（终端）三种用法、多智能体编排、技能/插件/凭据库、记忆与“梦境”；“**Beta 版当前面向国内企业认证用户开放**”。https://platform.kimi.com/docs/changelog/index.md
- 准入：须注册开放平台账号并申请“企业认证”，联系销售获取测试支持。https://platform.kimi.com/docs/hosted-agents/quickstart.md
- **数据口径**：“托管智能体在设计上是有状态的……在服务器端存储对话历史、沙箱状态和输出。因此，托管智能体目前不符合「零数据保留」”；“会话历史、沙箱状态与产出文件持久化在服务端”，可经 API 删除已归档会话。https://platform.kimi.com/docs/hosted-agents/quickstart.md ；ZDR 页同样写明“使用 Kimi Hosted Agents 托管智能体的数据，零数据留存无法保证”。https://platform.kimi.com/docs/guide/zero-data-retention.md
- 资源模型：智能体（官方智能体只读、自定义智能体项目可见）、执行环境（沙箱镜像异步构建，支持代理 `route_all`/白名单出网）、会话、事件流（SSE，可断点续读）、文件（`file-extract/image/video/batch`，组织默认 10 GiB）、记忆库（项目级持久文件集合，带版本）、凭据库（含 OAuth 会话）、触发器（定时运行）、技能、插件（官方插件“暂时不支持自定义”）、MCP。https://platform.kimi.com/docs/llms.txt ；https://platform.kimi.com/docs/hosted-agents/faq.md ；https://platform.kimi.com/docs/hosted-agents/changelog.md
- 官方智能体样例：PPT 生成智能体、金融投研智能体（文档 `hosted-agents/official-ppt-agent.md`、`official-investment-research-agent.md`）。
- **定价**：云沙箱 1 核 / 1 GB **¥0.072/小时**（按秒计）；模型 token 按模型价；插件按千次调用计费，如“联网搜索”¥30/千次、“搜图”¥45/千次、“天眼查-ta”¥20/千次、各类金融数据插件 ¥1–¥450/千次（Wind 系“-wd”为 ¥450/千次）。**价目表中未见华宇元典或其他法律数据库插件。** https://platform.kimi.com/docs/pricing/hosted-agents.md
- 与合作伙伴的关系：澎湃新闻 2026-09-10 报道登月计划称合作伙伴可“基于Agent运行底座（Kimi Hosted Agents）完成定制开发”。【二手】https://m.thepaper.cn/detail/34044550 ；新浪财经同日报道首批签约伙伴“包括中软国际（0354.HK）”，采用 FDE 驻场模式，提供“模型能力与工程方法论”，未提私有化/专属部署。【二手】https://t.cj.sina.com.cn/articles/view/1644983660/620c756c02001vh5e

### 6.2 Kimi Claw（Kimi 会员产品）【一手】
- 云端版：“前往 kimi.com/bot 创建专属的 OpenClaw。Kimi 将为你把 OpenClaw 一键部署到云端”；仅 Allegretto 及以上会员；“自动配置 Kimi K2.6 模型，并关联 Kimi 会员权益额度……同时会自动配置 Kimi Web Search 服务”；可接飞书、企业微信、微博、微信等聊天频道。https://www.kimi.com/zh-hans/help/kimi-claw/overview （页面未标日期，抓取于 2026-10-09）
- 桌面版：Kimi Claw Desktop“在 Kimi PC 客户端里可以一键部署运行在本地的 OpenClaw”，每账号最多 1 个，可迁移本地 OpenClaw 的人设、记忆。https://www.kimi.com/zh-hans/help/kimi-claw/desktop-deployment-guide （页面未标日期，抓取于 2026-10-09）
- 版本约束：OpenClaw“目前不支持更新到 3.22 日期之后的版本”，勿手动升级。https://www.kimi.com/zh-hans/help/kimi-claw/upgrade-notice
- Kimi Claw 会话“暂不支持插件”。https://www.kimi.com/zh-hans/help/plugins-and-skills/overview
- **Kimi Claw 云端版的数据存储位置、留存期限、是否适用 ZDR：帮助中心未写明，未查到。**（Claw 属会员产品，适用 Kimi 用户协议/隐私政策，而非开放平台 ZDR；ZDR 页只覆盖开放平台企业客户。）

### 6.3 私有化 / 专属部署
- **月之暗面官方面向企业/合作伙伴的私有化部署或专属（dedicated）部署产品页、报价或交付标准：未查到。** 开放平台只有“企业方案（联系销售）”入口与 ZDR 申请。https://platform.kimi.com/docs/guide/product-plans.md
- 可替代路径（公开事实）：K3 权重已开源（2026-07-27），国内外云/芯片厂商首日适配；媒体称官方技术博客建议本地部署使用 64 张或以上加速卡的超节点；K3 许可对“商业托管且 12 个月收入超 2,000 万美元”另需签约。【二手】https://udn.com/news/story/7333/9655155 ；https://unwire.hk/2026/07/21/kimi-k3-64-gpu-barrier/ai/ （许可原文与项目既有结论见 memory「法律发行版四条硬约束」，本轮未重新核验）

---

## 汇总表：Kimi Work 能力来源与“只买 API token”时的缺口

| Kimi Work 能力 | 执行位置（本机 / Kimi 云） | 依赖的 Kimi 云服务 | 只买 API token 能否获得 | 中软需自建 / 替换什么 |
|---|---|---|---|---|
| 模型推理（K3 等） | Kimi 云 | Kimi 会员额度池（订阅侧推理） | **能**：开放平台 kimi-k3 / k2.7-code / k2.6（Q3.1–3.2）；K2.8 无 API | 推理网关、计量与席位换算；ZDR 需单独向销售申请 |
| Agent 内核（拆解、子 Agent、工具调用） | 本机（Kimi Code 内核） | 无（除推理） | **能**：Kimi Code MIT 开源，可配开放平台 Key | 内核嵌入、权限规则 #2337 仍未合入、子代理审批 #4070 仍 open，需自补 |
| 本地文件读写 / Python / shell | 本机 | 无 | 能（内核自带） | 沙箱：上游 #4115 仅实验 PR、Windows 无后端，需自建 |
| 权限三档（默认/手动/全部） | 本机 | 无 | 能（内核有权限模式） | 律所策略下发、审计留痕需自建 |
| 联网搜索 | Kimi 云 | Kimi Code 订阅托管 `api.kimi.com/coding/v1/search`（Kimi Work 侧未写明） | **部分**：开放平台 `/v1/tools/search(_pro)` ¥0.01/0.015 次；`$web_search` 10-20 下线；与 Kimi Code `moonshot_search` 的路径不一致、兼容性未实测 | 适配层（把 `moonshot_search` 指到开放平台工具网关或自建搜索）；中国法律检索源需另接 |
| 网页抓取 | Kimi 云，失败回退本机 | `api.kimi.com/coding/v1/fetch` | **能**：`/v1/tools/fetch` ¥0.01/次；或直接用 Kimi Code 本机直连抓取 | 适配层或用本机直连 |
| 深度研究 | Kimi 云（会员功能） | 会员深度研究服务 | **不能**直接获得该产品；可用托管智能体或自建 Agent 流程拼 | 自建研究流程（推理 + 搜索 + 抓取） |
| 文件解析（PDF/Office） | Kimi Work：未写明 | 未查到 | **部分**：开放平台 `file-extract` 限时免费（云端解析、10 GiB 配额、不 OCR 图片） | 律所敏感件建议本机解析（自建/开源解析器 + OCR） |
| PPT / Office 直出 | 本机写文件（是否调用云端渲染未写明） | “继承在线版 Kimi Agent 的 PPT 等专业 Skills” | **不能**拿到 Kimi 官方 Skills 本体；开放平台托管智能体有官方 PPT 智能体（云端、非 ZDR） | 自研 Office/PPT 生成 Skill（本机执行） |
| 插件/技能市场 | 目录在云，执行混合 | Kimi 账号绑定市场；Kimi Code 默认 `code.kimi.com/.../marketplace.json` | **不能**拿到 Kimi Work 市场；Kimi Code 市场 URL 可覆盖 | 自建插件目录（`KIMI_CODE_PLUGIN_MARKETPLACE_URL`） |
| 官方专业数据库插件（天眼查、华宇元典、Wind…） | 第三方/ Kimi 云代理 | 会员额度计费；Kimi Code 版 `kimi-datasource` 走 `api.kimi.com/coding/v1` + OAuth | **部分**：托管智能体价目表含天眼查-ta 等金融/工商插件（云端），**未见华宇元典** | 与华宇元典等法律数据商直签 MCP 接入 |
| Plugin Builder / 第三方 MCP | 本机生成插件文件；MCP 远程在第三方 | 个人插件市场登记（托管位置未写明） | 内核支持 MCP，能 | 自建插件登记/审核流程 |
| 内置浏览器 / WebBridge | 本机（Chrome 扩展/内置浏览器） | 无（WebBridge 插件默认关闭） | Kimi Code 源码含 Kimi 浏览器扩展与 `kimi.com/features/webbridge` 链接（集成方式本轮未核）；Kimi Work 内置浏览器为闭源客户端能力，拿不到 | 自建浏览器自动化或接 WebBridge |
| 定时任务 | 本机（应用需常开，不补跑） | 开启数受会员套餐配额（校验位置未写明）；Kimi Web 版定时任务在云端 | 内核有本机 cron 任务（main 提交 #4083 涉及 cron 任务继承），能 | 律所侧常驻执行器 / 云端触发（若要关机仍跑） |
| 看板 / 小组件 | 未写明（每用户 2 个看板配额与账号绑定） | 未查到 | 不能（闭源客户端功能） | 自研 |
| 手机远程控制 | 执行在本机；通道未写明（Kimi Code 同类功能经 `code-rc.kimi.com` 中转） | Kimi 账号配对 + 中转 relay | **不能**：relay 服务端未开源，需 Kimi 登录与付费会员；可用 `KIMI_CODE_REMOTE_CONTROL_RELAY_URL` 改址 | 自建 relay（协议需按开源客户端反推）+ 端到端加密 |
| 账号 / 席位 / 企业管理 | Kimi 云 | Kimi 账号、Kimi Business（仅邀请/移除/席位/发票，无 SSO/审计） | 不能（开放平台只有组织、项目、IP 白名单、限额） | SSO、律所组织管理、审计日志全部自建 |
| 遥测 | 本机→Kimi 云 | `telemetry-logs.kimi.com/v1/event`（CLI 默认开） | 不需要 | 关闭或改为中软自有遥测 |
| 托管智能体（云端长任务） | Kimi 云沙箱 | Kimi Hosted Agents（Beta，国内企业认证） | **能**（开放平台企业认证后），但**不符合 ZDR** | 法律敏感数据不宜上；仅作非敏感场景备选 |

## 本轮未查到清单
1. Kimi Work 3.2.15 之后的新版本（截至 10-09 无）。
2. Kimi Work 手机远程控制是否经 Kimi 云中转（官方未明说）、是否端到端加密；Kimi Code relay 也未提 E2E。
3. Kimi Code relay（code-rc.kimi.com）服务端是否开源——仓库内未见。
4. Kimi Work 模式会话/项目/看板是否云同步。
5. Kimi Work 联网搜索/网页抓取/深度研究由哪个后端执行（Kimi Work 侧官方说明）。
6. Kimi Work 中 PDF/Office 文件解析在本机还是云端；PPT/Office 直出是否调用云端渲染。
7. Kimi Work 插件市场、个人插件市场的托管位置；官方 MCP（华宇元典、天眼查等）是否经 Kimi 云代理。
8. Kimi Business 的 SSO、审计日志、管理员策略（截至 10-09 均无）。
9. K2.8 的 API（开放平台模型清单无）。
10. 开放平台联网搜索的数据源与查询词留存口径；`code_runner` 官方工具（当前清单无）。
11. `file-extract` 文本文件是否被 ZDR 覆盖（ZDR 例外只点名图像/视频直传与托管智能体）。
12. Kimi Code `moonshot_search`/`moonshot_fetch` 指向开放平台 `/v1/tools/search`、`/v1/tools/fetch` 能否直接跑通（请求字段一致，路径与 Accept 头不同，未实测）。
13. Kimi Claw 云端版的数据存储位置、留存期限与 ZDR 适用性。
14. 月之暗面官方私有化 / 专属部署产品与报价。
