# 调研 X1：主流 AI Agent 办公产品的云端/本地执行划分与权限设定（独立核验）

- 核验时间：2026-10-09 23:10–23:26（北京时间）。核验人：独立调研员（单代理，未再派子代理）。
- 起点：`research/2026-10-09-云地权限v7/调研-S2-主流Agent权限设定与本机沙箱.md`（下称 S2）、`research/2026-10-09-独立终审v8/调研-B-办公Agent云地边界.md`（下称 B）。本文只把它们当“待核实线索”，凡与本轮抓取结果不一致处在文中标「纠正」，新发现标「新增」。
- 方法：本轮 WebSearch 工具在本环境不可用（两次调用均返回模型路由错误），故**全部以 `curl -sL --compressed` 直接抓取官方页面 / .md / JSON**，脚本抽取正文后逐条摘录；未登录任何产品、未运行任何客户端。因无法做开放式搜索，**媒体报道层面的“10-09 前后新动态”覆盖面有限**，凡未查到者如实写“未查到”。
- 标注约定：【一手】= 官方文档/官方帮助中心/官方发布日志/官方仓库；【二手】= 媒体或第三方。“发布日期”= 版本/公告自带日期；“页面更新”= 页面自带的最后更新时间戳（文档站全站统一时间戳不等于产品发布日期）。“→”开头是本报告的解读，不是来源原文。
- 字段口径（每个产品尽量填写）：Agent 循环位置｜工具/代码执行位置与隔离｜文件与会话存储｜推理位置与数据使用承诺｜本机权限档位与确认｜远程/手机/IM｜定时任务｜云端托管 Agent｜企业治理｜商业模式。


## 0. 要点摘要（先读）
1. **控制面全部在云**（账号/计费/策略/审计/远程中转），差别只在有没有企业 IT 治理：Kimi 企业版只有席位与成员管理，WorkBuddy/千问/Claude/OpenAI 都有 SSO + 策略 + 审计。
2. **国内三家截至 10-09 仍以本地桌面 Agent 为主**：Kimi Work 3.2.15（09-30，无新版）、WorkBuddy 5.7.7（10-08）、千问办公 1.2.5（**10-09 当天发布**）；它们的云端能力是另一个入口（Kimi Agent/Claw、千问 Web、WMA 内测），与桌面会话不通。
3. **海外转向云端默认**：Claude Cowork 自 2026-10-06 对 Pro/Max 默认云端执行（Team/Enterprise 由组织开关），经桌面 App 中转按需访问本机已连接文件夹，且这些文件会在 Anthropic 服务器上处理；OpenAI 推出常驻云端的 dots（灰度中），Work Cloud 在电脑离线时可降级到云容器，但云容器够不着本机文件。
4. **关机时没有一家把本机材料自动搬上云**：本地任务要么不跑、要么跳过，靠防休眠；无人值守走另一条云路径（处理已在云上的材料或公开信息）。
5. **远程降权四类手段**：缩小范围（专属文件夹/已连接文件夹）、绑定身份与设备（配对、可信设备+近期登录）、审批照常（手机审批）、管理员开关（关 IM 频道/关云会话）。Kimi Work 远控在官方文档里查不到这些说明。
6. **商业模式通行做法**：席位订阅 + 按 token 价折算的额度/积分池 + 成员上限 + 超额包；Kimi 加油包“近似开放平台 API 价格”且不支持企业版；WorkBuddy 企业用自定义模型不消耗积分。
7. **对法律版**：只买 API token 时，Kimi 会员云承担的身份、额度计量、云定时、云沙箱、项目云存储、远程中继、插件与付费数据源、不训练承诺都不随 token 附带，需要中软自建或另签；案卷云端执行不必默认开，但“关机怎么办”和“企业锁定权限”必须有明确设计。


---

## 1. Kimi Work（月之暗面桌面客户端）与 Kimi 网页端云端 Agent

> 抓取：`www.kimi.com/zh-hans/help/...` 共 21 页（Kimi Work 5 页、会员 4 页、Agent 3 页、Kimi Claw 5 页、Kimi Business 2 页、功能 2 页），抓取时间 2026-10-09 23:10–23:13 CST。所有帮助中心页面 JSON 内 `updatedAt` 均为同一值 **2026-10-09T11:15:51Z（北京时间 10-09 19:15）**——这是文档站统一刷新时间戳，**不能当作任何功能的发布日期**。

### 1.0 版本与 10-09 前后变化
- 发布日志最新条目仍为 **3.2.15（2026-09-30）**；10-01 至 10-09 **未出现新版本条目**。【一手】发布日志 https://www.kimi.com/zh-hans/help/kimi-work/release-notes （页面更新 2026-10-09T11:15Z）
- 产品状态：「Kimi Work 于 2026 年 6 月 3 日上线，目前处于 **Beta 测试阶段**……自 3.1.0 版本起，Kimi Work 搭载 Kimi K3 模型」。【一手】产品介绍 https://www.kimi.com/zh-hans/help/kimi-work/overview
- **纠正/补充**：任务书所列 `kimi.com/help/kimi-work/kimi-work-remote-control` 在 zh-hans、无 locale、en 三种路径下均返回 200 但只是“加载中…”空壳页，帮助中心导航（产品介绍/目标模式/插件中心/小组件/看板/典型应用场景/常见问题/发布日志）**没有远程控制专页**。远程控制的一手信息目前只有发布日志条目。

### 1.1 执行位置
- Agent 循环与工具执行：「Kimi Work 是面向知识工作者的通用型**本地 Agent**，可在 Kimi 电脑客户端（Mac / Windows）的『Work』模式中使用」；「以 **Kimi Code 为内核**、搭载 Kimi K3 模型，提供本地 Agent 基础能力，包括安装和使用技能（Skill）、运行定时任务等」；「在你的电脑上拆解任务、并行执行、调用工具、使用浏览器、创建和整理文件夹」。【一手】overview
- FAQ：「Kimi Work 是为深度工作流设计的本地 Agent。它能读取并处理你的本地文件夹、通过 WebBridge 自主浏览网页、在后台运行 Python 代码、执行定时任务」。【一手】https://www.kimi.com/zh-hans/help/kimi-work/kimi-work-faq
- 本机代码隔离（VM/沙箱）：**未查到**任何官方说明（FAQ、产品介绍、发布日志均无“沙箱/虚拟机/隔离”字样）。
- 模型推理：在 Kimi 云端（K3/K2.6 按会员额度计费，见 1.6）；推理处理地区、日志留存：**未查到**。
- 浏览器：3.2.0（2026-08-19）内置浏览器（Agent 可点击输入；mac 可导入 Chrome Cookie，默认关）；WebBridge 真实浏览器控制改插件、默认关；3.2.2（2026-08-26）内置浏览器 Agent 控制改默认开（与 S2 一致，已复核）。【一手】release-notes
- 「新增网站部署插件，安装后本地网站项目可一步**云部署**」（3.2.7，2026-09-11）——本地产物经插件推到 Kimi 云托管。【一手】release-notes

### 1.2 本机权限三档（复核无变化）
- 「**默认**：常规操作自动执行，Kimi 在修改、覆盖本地文件或运行代码等敏感操作前会请求你的明确授权；**手动允许**：操作前先请求授权；**全部**：无需授权直接执行」；「开启『全部』……AI 将直接读写文件、执行代码、修改系统配置……结果将由你自行承担」。【一手】FAQ（与 S2 原文一致）
- 「默认」档 3.2.2（2026-08-26）新增。【一手】release-notes
- 其他确认点：「退出应用前将确认仍在运行的定时任务」（3.2.6，2026-09-07）；「账号退出登录时，如有运行中的任务将二次确认」（3.2.15，2026-09-30）。【一手】release-notes
- 企业能否锁定档位：**未查到**（Kimi Business 管理员权限见 1.7，不含任何客户端策略）。

### 1.3 文件、会话与项目的存储
- **新增（重要）**：「Kimi Work 桌面端也有『项目』，与这里介绍的 Kimi 对话（Chat）项目**相互独立、数据不互通**」。【一手】项目 https://www.kimi.com/zh-hans/help/features/project
- Kimi Chat（网页）项目是云端持久工作空间：文件 PDF/DOCX/XLSX 等，单文件 ≤100MB、≤50 个；项目存储 Free 500MB / 20GB / 50GB（随套餐）；「删除项目会**永久删除**该项目内的会话、文件与项目指令」。【一手】同上
- Kimi Work 本机数据：「支持 Windows 端存储盘迁移：**Work 数据可迁移到其他磁盘**」（3.1.6，2026-07-29）→ Work 数据（至少一部分）落在本机磁盘。【一手】release-notes
- Kimi Work 会话是否云同步、跨设备漫游：**未查到**明文。→ 远程控制可在手机上看到“子 Agent 卡与产物卡”（3.2.7），说明会话内容至少以某种通道到达手机，但是否经 Kimi 云存储/中继**未查到**。

### 1.4 远程控制（手机遥控）
- 3.2.5（2026-09-04）「新增远程控制功能：可通过手机远程控制桌面端 Kimi Work」；3.2.7（09-11）「远程控制消息分段展示，子 Agent 卡与产物卡对齐桌面形态」；3.2.8（09-12）「防休眠设置改为三档可选：熄屏保持运行、屏幕常亮、关闭」；3.2.9（09-14）「电源模式增加『熄屏后保持唤醒』：屏幕可熄灭，系统保持运行，**远控与后台任务不中断**」；3.2.14（09-24）「支持在手机端直接预览 Office、html 等文件类型」「支持在手机端向 Kimi Work 上传附件」，同版「保持唤醒功能改为按需持有」。【一手】release-notes
- → 电脑是否必须在线：官方无一句明文，但“防休眠三档 + 熄屏保持唤醒使远控不中断”只有在**执行端是桌面**时才有意义，可推断远控 = 手机遥控本机（与 WorkBuddy 助理同型），**不是云端执行**。中转方、是否端到端加密、手机端能否批准权限弹窗：**未查到**。

### 1.5 定时任务：Kimi Work 本地 vs Kimi 网页云端（复核并补充）
- 「在 Kimi Work 桌面端，定时任务在**本地运行**，需要应用处于开启状态才会执行；电脑休眠、关机或应用关闭期间错过的触发**不会在下次开启时补跑**……（相比之下，在 Kimi 中创建的定时任务在**云端执行**，不需要保持客户端开启。）」【一手】FAQ
- 新增细节：定时任务是 Kimi 与 Kimi Work 通用功能；云端任务有默认过期（每天 +7 天、每周 +1 月、每月 +3 月），「在 Kimi Work 桌面端本地运行的定时任务**不受上述过期规则限制**」；执行结果生成通知，「已读状态在 Web 端与移动端之间跨端同步」；可结合 Skills。【一手】定时任务 https://www.kimi.com/zh-hans/help/features/scheduled-tasks
- **新增（口径不一致）**：定时任务页配额表用 **Free 2 / Go 6 / Pro 15 / Max 20 / Ultra 25** 五档命名，而会员页用 **Andante 6 / Moderato 10 / Allegretto 15 / Allegro 20** 四档命名。两页同日刷新但档位名与数字不一致——可能是套餐改名进行中或页面未同步，**不能据此判断已改名**，引用价格时以会员页为准。【一手】scheduled-tasks、membership-overview

### 1.6 Kimi 网页端云端 Agent（OK Computer / Agent / 集群 / Claw）与“云电脑”
- **Kimi Agent（含 OK Computer）= 云端异步执行**：发展历程「2025.09……推出首个 Agent 产品『OK Computer』」；「Kimi Agent 在**后台异步执行**……可离开页面，任务将在后台继续运行，完成后系统会发送通知」；单次 5–20 分钟；上下文 128K；内置「20 多种工具，涵盖代码编写、终端操作、网页浏览……网站部署」；交付物「可下载的 Zip 包（位于 `/mnt/okcomputer/output/` 目录）」；「任务执行失败不扣除额度」。【一手】https://www.kimi.com/zh-hans/help/agent/agent-overview 、/agent/agent-features-and-limits 、/agent/agent-quota-and-billing → 路径表明执行环境是 Kimi 云端容器/沙箱，用户文件需上传。
- **Kimi Claw = 云端托管 OpenClaw + 可选本机部署**：「2026.02 Kimi Claw 公测：零部署云端 AI 代理……浏览器一键运行持续在线的自动化任务」【一手】agent-overview；会员页原文「Kimi Claw 是部署在云端的 OpenClaw：每次调用 Claw，系统都会在云端启动一个**隔离沙箱**来执行代码、操作浏览器或调用工具……即使你没有主动发起任务，已部署的**云主机仍会保留运行环境和数据**，因此每天会产生约会员额度 **0.6%** 的费用，于每天下午 4 点结算」，并建议停用前「将 memory、soul、workspace 等重要文件保存到本地，再删除云主机」。【一手】会员收费 https://www.kimi.com/zh-hans/help/membership/membership-pricing
- Kimi Claw 形态三种：「Kimi Claw（云端、安卓本地和桌面端）」仅 Allegretto（¥199）及以上【一手】membership-overview；**Kimi Claw Desktop**：「在 Kimi PC 客户端里可以一键部署**运行在本地**的 OpenClaw」，自动配置 K2.6「并自动关联 Kimi 会员权益额度，无需额外配置 API」、自动配 Kimi Web Search，「每个账号仅支持最多 1 个 Kimi Claw Desktop」。【一手】https://www.kimi.com/zh-hans/help/kimi-claw/desktop-deployment-guide
- Claw 的 IM 触发：网页版、iOS/Android，以及「通过聊天频道部署到第三方平台」微信、飞书、企业微信、钉钉、微博。【一手】https://www.kimi.com/zh-hans/help/kimi-claw/platform-support ；Claw 内置 `/cron` 定时任务、终端、记忆导出。【一手】/kimi-claw/concepts
- 网站发布：「通过 Agent 发布网站后……持续占用云端资源……约会员额度 0.08% 的扣费」。【一手】membership-pricing
- **“云电脑”**：Kimi 官方帮助中心**未查到**名为“云电脑/云主机桌面”的产品；最接近的是 Kimi Claw 的“云主机”（OpenClaw 云沙箱）与 Agent 的云端执行环境。

### 1.7 会员订阅与额度（token 成本如何转嫁）
- 个人四档：**Andante ¥49/月、Moderato ¥99/月、Allegretto ¥199/月、Allegro ¥699/月**，连续包年最高省 ¥1,680。【一手】https://www.kimi.com/zh-hans/help/membership/membership-overview 、membership-pricing
- **统一额度池、按 token 计**：「所有会员功能（网站部署、深度研究、PPT、Kimi Code、**Kimi Work**、Kimi Claw、K3 和 K3 集群等）共享一个额度池，**按实际 token 消耗扣除**。任一功能用尽额度都会影响其他功能」；Kimi Code 另有 5 小时/周限额；按订阅周期每月刷新、不结转。【一手】同上、membership-update-rules
- 各档参考值：Agent 用量约 30/60/150/360 个；Agent 并行 1/2/2/4；定时任务 6/10/15/20；项目 20/20/20/100、存储 20/20/20/50GB；专业数据库 1000/2000/5000/12000 次；目标模式与专属 Kimi Claw 仅 Allegretto 起；百万 token 上下文仅 Allegro。【一手】membership-pricing
- **加油包（Extra Usage）**：订阅额度用尽后按量计费，「加油包价格近似于 **Kimi 开放平台的官方 API 价格**」；余额在网页、插件、桌面、移动、Kimi Code 共享；可设每月消费上限；「**加油包支持企业版吗？暂不支持**」。【一手】https://www.kimi.com/zh-hans/help/membership/membership-extra-usage
- → 月之暗面自己的定价逻辑：席位订阅 = 一笔“按 token 计量的月度额度池” + 云沙箱常驻按日扣额度 + 超额按近 API 价兜底。中软“只买 API token”时，额度池、加油包、频控这些会员计量能力都不随 token 附带。

### 1.8 企业版（Kimi Business）治理
- 「¥4,200/座/年（约合 ¥350/座/月）」，「2 座起售……单次购买上限 150 座」，年付；「**默认不使用你的业务数据进行训练**」；「高级功能全部解锁：Kimi Work / 集群功能 / 定制化看板 / 精选插件」。【一手】https://www.kimi.com/zh-hans/help/kimi-business/kimi-business
- 管理员权限仅「购买坐席、生成邀请链接、管理成员、查看订单」；工作空间「实现个人与企业数据的完全隔离」；「Web 端和桌面端支持 Kimi Business；移动端目前仅支持个人会员」。【一手】同上、kimi-business-faq
- SSO、审计日志、会话回放、客户端策略下发、Hooks：**均未查到**。企业合同/合规材料「请联系销售或客服进一步确认」。【一手】kimi-business-faq
- → 结论：截至 10-09，Kimi 企业版是“席位 + 额度 + 不训练承诺 + 个人/企业空间隔离”，**没有公开的 IT 治理面**；法律发行版所需 SSO/审计/策略锁定须由中软自建。

### 1.9 Kimi 小结（字段表）

| 字段 | Kimi Work 桌面 | Kimi 网页 Agent / Claw 云 |
|---|---|---|
| Agent 循环 | 本机（Kimi Code 内核） | Kimi 云端 |
| 工具/代码执行与隔离 | 本机；隔离技术**未查到** | 云端沙箱（Claw 明写“隔离沙箱”；Agent 有 `/mnt/okcomputer/output/`） |
| 文件与会话 | 本机工作目录；Work 数据在本机盘（可迁移）；Work 项目与 Chat 项目不互通；会话云同步**未查到** | 云端（项目 20–50GB；Claw 云主机保留 workspace/memory） |
| 推理 | Kimi 云；个人版训练/留存条款**未查到**；企业版“默认不用于训练” | 同左 |
| 权限档 | 默认/手动允许/全部；企业锁定**未查到** | 不适用（云沙箱） |
| 远程 | 手机遥控本机（3.2.5 起）；需防休眠保持运行；中转/加密**未查到** | Claw：网页/App/微信/飞书/企微/钉钉/微博 |
| 定时 | 本地，关机/休眠不跑、不补跑 | 云端，客户端关闭也执行 |
| 企业治理 | 无公开 SSO/审计/策略 | 同左 |
| 计费 | 会员统一 token 额度池 ¥49–699/月；企业 ¥4,200/座/年；Claw 云主机每日约 0.6% 额度 | 同左 |

---

## 2. 腾讯 WorkBuddy（含 WMA 云端托管 Agent）

> 抓取：腾讯云文档中心 `cloud.tencent.com/document/product/1831/*` 16 页（本轮未触发人机验证），以及**国内新文档站 `www.codebuddy.cn/docs/workbuddy/*`**（与 `www.workbuddy.cn/docs/workbuddy/*` 内容相同）5 页、国际站 `www.workbuddy.ai` 3 页，抓取时间 2026-10-09 23:13–23:18 CST。
>
> **纠正（重要）**：S2 以腾讯云文档中心为准，称“10-02 之后腾讯文档未见新时间戳”。本轮发现腾讯云文档中心的《WorkBuddy 更新记录》停在 **5.5.2（2026-09-03）**（页面更新 2026-09-07），而**新文档站的更新日志已到 5.7.7（2026-10-08）**，10 月内有 5.7.5（10-03）、5.7.6（10-04）、5.7.7（10-08）三个版本。【一手】https://www.codebuddy.cn/docs/workbuddy/Changelog （页面无可读更新日期；条目自带日期）。新文档站的权限页也比腾讯云版多出“安全中心”整节（见 2.2）。→ 以后核验 WorkBuddy 应以 codebuddy.cn/workbuddy.cn 文档站为主、腾讯云文档中心为辅。

### 2.1 执行位置与存储
- 定位：「全场景职场 AI 智能体**桌面工作台**」；国际站 llms.txt：「operates on authorized local folders」「a desktop application for Windows and macOS, with an accompanying web experience」。【一手】WMA 产品介绍 https://cloud.tencent.com/document/product/1831/134407 （页面更新 2026-09-30）；https://www.workbuddy.ai/llms.txt
- 本地 Agent 的自我定性（腾讯自己写的对比）：「本地智能体『**人在电脑前才运行、单人单机、关机即停**』，只能解决个人提效」——这是 WMA 页给出的云端托管理由。【一手】134407
- 推理：FAQ「数据本地执行不上传……**服务端仅处理数据片段：用后即弃，不保存，不用于模型训练**」。【一手】FAQ https://cloud.tencent.com/document/product/1831/134405 （页面更新 2026-09-07）→ 与企业 AI 安全审计“持续监测会话日志 + 会话回放”并存（见 2.6），“不上传”口径显然不覆盖审计日志（与 S2 判断一致）。
- 会话：助理页「已执行任务的历史记录**保留在本地**，不会因解绑而清除」；5.5.2「提升**本地历史**恢复能力」；5.6.0（09-19）「优化**跨设备**会话标题、模型、置顶顺序同步」；5.7.0（09-28）「新增全局搜索，可查找资料库内容和聊天记录」。【一手】https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Assistant 、Changelog → 会话正文以本机为主，元数据跨设备同步；正文是否上云**未查到**。
- 云端资料：个人版「资料库容量 5/10/20/50GB」、「可托管应用数」；企业旗舰版内置「腾讯网盘……每席 50G」。【一手】https://www.codebuddy.cn/docs/workbuddy/Pricing 、版本说明 https://cloud.tencent.com/document/product/1831/134332 （页面更新 2026-09-16）
- **新增：团队“项目”**（页面更新 2026-09-24）：项目把指令、连接器、专家、技能、资料统一组织，成员共享上下文；连接器分「**公共授权**：由管理员统一完成授权，项目成员共享同一账号或授权凭据……调用日志仅管理员可见」与「**个人授权**：……授权凭据不作为项目共享凭据，**仅保存在成员本地，不上传云端**……协作任务中不可用」。【一手】项目 https://cloud.tencent.com/document/product/1831/138797
- 「是否支持云端部署或服务器安装：服务器端能力仍在完善中」。【一手】134405

### 2.2 本机权限：两档 + “安全中心”细粒度规则（新增）
- 两档：默认权限 / 允许完全访问。新文档站给出比腾讯云版更细的口径：默认档「开启删除保护后，普通文件写入通常可以直接继续」，需确认的是「写入受保护或敏感路径」「删除受保护文件、重要目录或批量删除」「执行脚本、命令或外部程序」「网络访问或敏感能力」；「命令会优先在**沙箱约束**下执行；如果被拦截，再按风险决定是否需要你确认」。【一手】https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Permission-Modes
- **完全访问的作用域（新增）**：「生效范围：**当前客户端内所有任务**……该设置**不跨设备生效**，每台客户端独立管理」；对比表：完全访问下文件访问范围「计算机上任意位置」，终端「可直接运行命令、安装软件、改系统设置」，互联网「可访问网站、发送数据、使用已启用连接器」。【一手】同上
- **安全中心（新增，S2/B 均未记录）**：沙箱安全总开关「AI 运行于隔离沙箱，并配置文件、命令、网络访问策略」；文件安全「按文件路径配置三态规则，读取 / 写入 / 删除可分别设为允许、询问或拒绝」；命令安全「按命令前缀配置允许、询问或禁止规则」；网络安全「按域名 / URL 配置……**远程 HTTP 请求默认询问，本地 HTTP 请求默认放行**」；工具管控（按工具/MCP 粒度禁用）；「安全网关：工作空间出入流量统一经过安全网关安全处理（默认开启）」；「传输加密：**本地与云端通信使用端到端加密通道**（默认开启）」；敏感保护（凭证检测，可“允许加密访问”，上下文以密文流转、输出时还原）；删除保护（回收站）；批量删除审批（默认 50 个）；**审计中心**「记录拦截 / 放行日志，支持导出」。【一手】同上
- → “端到端加密”是官方措辞，但语境是“本地与云端通信”，等同于传输加密，**不能理解为腾讯不可见**。沙箱在 Windows/macOS 上的具体 OS 机制仍**未查到**（同门 CodeBuddy Code 文档仍写 Windows 沙箱“planned”，见 S2）。
- **企业能否锁定**：5.6.0（09-19）修复「**企业下发**含 %USERPROFILE% 环境变量的**安全路径规则**不生效的问题」——一手证据表明企业管理端可向客户端下发安全路径规则；但管理端是否能禁用“允许完全访问”开关：**未查到**。【一手】Changelog
- 5.7.0（09-28）「首次打开包含开发配置的工作区时增加**信任确认**，保护本地文件与运行环境」。【一手】Changelog

### 2.3 远程/IM：助理（遥控本机）与“云助理”
- 助理 = 「通过手机上的即时通讯软件（微信、企业微信、QQ、钉钉、飞书）远程控制**电脑上的 WorkBuddy** 执行任务」；「使用助理时，**电脑需要保持开机并运行 WorkBuddy**」；固定「助理专属文件夹」、单会话、历史不可清空（复核与 S2 一致）。【一手】134392（页面更新 2026-09-16）、新文档站 Assistant 页
- **新增“远程控制安全边界”**：「绑定身份」「来源校验：WorkBuddy 助理对每一条远程指令执行多层来源校验」「**高风险任务确认：涉及文件删除、系统配置修改、批准命令执行等操作需确认后方可执行**」（确认在手机端还是电脑端：**未写明**）。【一手】新文档站 Assistant 页
- 链路：FAQ「IM 内置 WebSocket 通道通信：通过主流 IM……内置的 WebSocket 通道通信。非企业内网入侵方式，不需要在企业防火墙上开放额外端口」；「内置安全通信网关，支持 Gateway Token 认证」「不依赖 frp/ngrok/Tailscale」。【一手】134405 → 指令经 IM 平台 + 腾讯网关中转；是否内容端到端加密（IM 平台/腾讯不可见）：**未查到**。
- 锁屏运行：5.5.4（09-08）「『允许锁屏运行』新增关闭、熄屏后继续运行、保持屏幕常亮三种模式」。【一手】Changelog（与 Kimi Work 3.2.8 的“防休眠三档”同构）
- **新增（待核实）“云助理”**：更新日志多次出现「个人及项目**云助理**」（5.5.1，09-02）、「本地和云助理历史消息加载缓慢」（5.7.6，10-04）、「创建助理时的**仓库/分支**选择」「云助理实例异常」，以及「优化**云端任务**产物栏」（5.6.0）。【一手】Changelog → 说明 WorkBuddy 已存在某种云端运行的助理/任务形态，但**未查到任何说明页**（助理文档仍只写“遥控本机”）。不得据此断言个人版已有云端托管执行；待腾讯文档补齐。
- 5.7.2（09-29）「修复**企业下发的助理**在『企业智能体』列表中消失的问题」→ 企业→客户端下发智能体的通道已在客户端出现。【一手】Changelog

### 2.4 定时任务（本地）
- 「自动化在**本地客户端**保存定时任务配置（任务名称、prompt、调度规则、工作目录、执行状态等），在指定时间以您当前的登录身份自动发起 Agent 任务」；可选「推送到小程序/企业微信：开启后，推送会通过安全链路**把文件同步到云端**」。【一手】https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Automation-Guide
- 关机是否补跑：文档未写；更新日志 5.5.2 有「正常执行被误判为**补跑**」、5.6.0「修复……**休眠期间调度不准**」→ 存在某种补跑逻辑，但规则**未查到**。5.5.4 起“自动化”更名“定时任务”；5.7.5（10-03）新增定时任务汇总页与产物系统通知。【一手】Changelog

### 2.5 WMA（WorkBuddy Managed Agents）：云端托管 Agent
- 口径**截至 10-09 未变**：「WorkBuddy Managed Agents 已在腾讯云侧上线，当前在**白名单内测**阶段，**预计10月份**将同步完成 WMA 在 WorkBuddy Enterprise 管理端的升级」（产品介绍与使用说明两页，页面更新均 2026-09-30）；《管理端更新记录》最新条目仍是 2026-04（页面更新 2026-08-03），**未查到 10 月上线公告**。【一手】134407、138968、https://cloud.tencent.com/document/product/1831/134327
- 底座：「独享沙箱隔离（1 Session : 1 沙箱）、存算分离」「**数据不出域**（配置与运行均在云端，敏感产出物云端驻留，支持 VPC 私有网络）」；网络「出访」与「被访」分别配置；凭证「独立于 Agent 集中存储，运行时由连接器 / 网关换发**短期令牌**，Agent 不持有长期密钥」；自动化任务「每次执行都会创建独立 Session……完整留痕」；对话记录可「下钻查看 Session 下的完整 Trace 详情，包含每轮用户输入、模型推理过程、工具调用参数与返回、最终输出」；可选模型「DeepSeek / Claude / GPT / 混元 / Gemini 等」，付费模型消耗企业 Credits。【一手】134407、138968
- 下发到客户端：管理端接收时「确认**客户端会话记录是否要云端可见**」；可见范围全员不可见/全员可见（仅超管）/指定范围；「推送不携带渠道与接入配置是企业侧的安全边界」。【一手】138968
- **新增：可观测中心（Agent-Trace）**：企业管理后台内置，「对企业的智能体使用情况做全链路数据采集、存储与分析」，Session/Trace 双粒度、「每个节点的输入 / 输出详情」，需「申请内测」。【一手】https://cloud.tencent.com/document/product/1831/138969 （页面更新 2026-09-30）

### 2.6 企业治理
- SSO：管理端文档目录含认证源 OIDC、CAS、OAuth2.0、SAML2.0、JWT，及飞书/钉钉/企业微信/Entra ID/AD/OpenLDAP；数据源同步同列（文档 ID 138245–138293）。【一手】文档目录 https://cloud.tencent.com/document/product/1831 ；版本说明列「授权管理、单点登录、研效看板、成员统计、智能体配置、企业模型配置」。【一手】134332
- AI 安全审计：「平台持续监测企业成员的 AI 会话日志」「提供……**完整会话回放**」「与 iOA DLP 双向同步」。【一手】https://cloud.tencent.com/document/product/1831/138279 （页面更新 2026-09-16）
- 数据处理协议（DPA）单列页面（页面更新 2026-09-08，正文为外链）。【一手】https://cloud.tencent.com/document/product/1831/137717
- Hooks：桌面端 Hooks 的企业下发与失败语义：**未查到**（CodeBuddy Code 有 Hooks 文档，不等于 WorkBuddy 桌面）。

### 2.7 商业模式
- 个人版（2026-07-01 起）：体验版免费 / **标准版 ¥99/月 / 高级版 ¥199/月 / 旗舰版 ¥999/月**；连续包月 7 折（70/140/700）、连续包年（672/1,344/6,720 元/年）；每月实得积分（限时）500/4,000/9,000/50,000；自动任务 3/15/30/99；个人助理数 3/5/8/10；资料库 5/10/20/50GB；加量包 1,000 积分 ¥50（1 个月有效）；「WorkBuddy 和 CodeBuddy 同一账号积分共享」。【一手】https://www.codebuddy.cn/docs/workbuddy/Pricing
- 企业版：**旗舰版 ¥198/人/月（¥2,376/人/年），1 座起，腾讯云共享 VPC**；**专享版 ¥316/人/月（¥3,792/人/年），100 座起，腾讯云专享 VPC**；私有化企业版询价；均「赠送 2000 Credits/人，每月刷新，Credits 团队内共享使用，对话问答不限频」；加量包 2,000 Credits ¥100 起（6 个月有效）。【一手】计费概述 https://cloud.tencent.com/document/product/1831/134333 （页面更新 2026-09-29）
- Token 成本转嫁机制：「积分（Credits）的消耗量与**模型 Token 定价**和任务复杂度两个因素有关」；「当企业使用**自定义模型**时，**不消耗 Credits** 用量」；管理员可给每个成员设周期用量上限；到期或无 Credits 时「企业将自动失效」。【一手】积分说明 https://cloud.tencent.com/document/product/1831/134339 （页面更新 2026-09-16）、计费说明 https://cloud.tencent.com/document/product/1831/134334 （页面更新 2026-09-28）
- 文档瑕疵：计费说明的示例仍按「78 元/个/月」计算，与同页 198 元/人/月 不一致（旧价示例未更新）。

### 2.8 WorkBuddy 小结（字段表）

| 字段 | 桌面端 | 助理（IM 遥控） | WMA（云） |
|---|---|---|---|
| Agent 循环 | 本机 | 本机（IM 只是入口） | 腾讯云 |
| 执行隔离 | “沙箱约束”+安全中心规则；OS 机制**未查到** | 同桌面，固定助理文件夹 | 1 Session : 1 沙箱 |
| 文件/会话 | 本机工作空间；历史在本地；元数据跨设备同步；资料库/网盘在云 | 历史在本地 | 云端驻留，可 VPC |
| 推理与承诺 | 腾讯侧模型；“片段用后即弃、不训练”（FAQ） | 同左 | 企业 Credits；DeepSeek/Claude/GPT/混元/Gemini |
| 权限 | 默认/完全访问（全客户端生效、不跨设备）；文件/命令/网络三态规则；企业可下发安全路径规则 | 高危需确认（端未写明） | 出访/被访、凭证短期令牌 |
| 远程 | — | 电脑须开机运行；经 IM WebSocket + 腾讯网关 | OpenAPI/A2A/IM Bot |
| 定时 | 本地客户端调度 | — | 云端无人值守，每次独立 Session |
| 企业治理 | SSO（SAML/OIDC 等）、AI 安全审计含会话回放、DLP 联动、审计中心日志 | 同左 | Trace 全链路、会话云端可见开关 |
| 计费 | 个人 ¥99–999/月；企业 ¥198/316 人/月 + Credits 池；自定义模型不耗 Credits | 同左 | 企业 Credits |

---

## 3. 阿里 千问办公 QwenWork

> 抓取：`docs.qwenwork.cn/llms.txt`（208 个 .md 页面）及 18 个 .md 页面，抓取时间 2026-10-09 23:19 CST。文档站各页**无“最后更新”字段**，只有客户端更新日志自带日期。
>
> **新增（10-09 当天变化）**：客户端更新日志新增 **「2026年10月09日 千问办公 1.2.5」**（S2/B 记录的最新是 1.2.1 / 09-23）。1.2.5 内容：技能发布到公开市场可选分类；「大体量历史任务导入的内存占用明显下降」；「**定时任务在系统唤醒恢复、账号切换以及需要二次确认等场景下的触发更稳定**」；「企业连接器状态同步更及时」；修复「跨会话复用内容时**敏感信息替换规则**偶发不生效」等。【一手】https://docs.qwenwork.cn/release-notes/desktop.md （条目日期 2026-10-09）。另：`release-notes/web.md` 不存在（404），网页端无公开更新日志。

### 3.1 三个端的执行位置
- FAQ：「浏览器自动化和本地文件操作**仅客户端支持**」「网页全栈制作已支持 Web 端和钉钉端，客户端后续开放」「企业版能力目前支持 PC 端和 Web 端，QwenWork 桌面客户端后续支持」；「目前 Web 端与桌面客户端的定时任务和会话**相互独立，暂不支持同步**」。【一手】https://docs.qwenwork.cn/faq.md （复核与 S2 一致）
- 桌面端：读写本地文件、MCP、浏览器连接器（「在你已登录的浏览器中运行」）、macOS 原生应用连接器、电脑操控（每次询问默认 / 自动执行）。【一手】desktop/scheduled-tasks.md、desktop/computer-use.md
- Web/钉钉端：云端执行；个人版「云盘空间（网页版支持）1G/10G/20G」；产出存「Agent 工作区」。【一手】benefits/personal.md、web/personal-drive.md
- 「产品权益」页：「目前**桌面端暂不支持企业版链路的订阅**」。【一手】https://docs.qwenwork.cn/benefits.md

### 3.2 安全工作环境（本机 VM）与数据承诺
- 设置页原文（复核无变化）：「在你的电脑上单独开辟一块独立空间来跑任务……**所有文件和数据都不会离开你的设备**」「开启后，任务会在隔离的工作环境中运行，不影响你电脑上的其他文件，也不会触及真实系统」。【一手】https://docs.qwenwork.cn/desktop/settings.md → “数据不离开设备”指执行环境，不涵盖发给云端模型的上下文（推理在云端），这一点 B 已指出，本轮维持。
- 底层实现（Hyper-V/WSL2/其他）、是否需管理员：**仍未查到**；仅更新日志有「Windows VM 服务」字样（1.2.1）。
- **数据使用承诺（复核 B 的补正）**：桌面设置「**数据共享**——你的数据不会被用于产品改进，仅用于提供基本服务。可在此选择隐私模式。**企业账号该设置仅限管理员在企业管理后台修改**」。【一手】desktop/settings.md；而 Web/钉内隐私页的数据用途列有「排查服务问题、**改进产品体验**以及履行法律义务」「了解用户需求，优化产品体验」，存储「中国大陆境内」，删除仅「从用户可见空间中移除」，「部分数据可能在必要期限内继续保留」。【一手】https://docs.qwenwork.cn/getting-started/privacy-security.md → 两端口径不同：桌面明确“不用于产品改进”，Web/钉内未承诺；两页均**未出现“训练”二字**。

### 3.3 权限与审批
- 桌面无“默认/完全访问”式全局档；1.2.0（09-21）「自动审批模式」+「安全中心」（S2 已记）；电脑操控单独两档。企业 Hooks 失败语义：非 2xx / 连接失败 / 超时「记录调用错误，继续原流程」（fail-open，复核无变化）。【一手】https://docs.qwenwork.cn/desktop/hooks.md
- 企业旗舰版安全管控：可信网络（IP 白名单）、**可信设备**（按用户登记允许登录的终端）、敏感词（全员生效，命中拦截）、**IM 频道开关**（钉钉/飞书/微信/企业微信/Lark 逐个开关）、Hooks 规则；模型策略组（按用户/部门/用户组的模型白名单/黑名单，黑名单优先）；AI 资产（技能/连接器/专家套件）开放范围。【一手】llms.txt 目录及 enterprise-ultimate/security/im-channels.md、trusted-devices.md
- SSO：钉钉/飞书/企业微信/Entra ID（SAML）/OAuth2/OIDC/SAML2；用户同步含 AD、OpenLDAP、SCIM。【一手】llms.txt 目录

### 3.4 IM 遥控
- 桌面端「IM 频道」：钉钉、飞书/Lark、企业微信、微信；「开放模式」（所有人/群可直接对话）与「配对模式」（需经你允许，以会话为单位）。【一手】https://docs.qwenwork.cn/desktop/im-channels.md
- 是否要求电脑在线、指令经谁中转、是否加密：该页**未写明**。→ IM 频道属桌面端功能，结合“浏览器自动化和本地文件仅客户端支持”，可推断执行在本机，但无原文。

### 3.5 定时任务：本地与云端两套（复核并补充）
- 桌面：「定时任务由**本地桌面客户端调度**……如果你的电脑处于睡眠或关机状态，任务将无法触发」；「不会自动补执行……该次执行将被跳过。你可以在执行记录中看到『未执行』状态，并通过『立即运行』手动补一次」；可开「保持系统唤醒」；触发时「拥有与你手动发起对话时完全一样的能力——它可以调用 MCP 工具、使用连接器（浏览器自动化、macOS 原生应用）、运行技能、读写本地文件」。【一手】https://docs.qwenwork.cn/desktop/scheduled-tasks.md
- Web：「即使关闭浏览器或退出登录，任务也会继续在**云端**按计划运行」；「每次运行都会生成一个独立会话」。【一手】https://docs.qwenwork.cn/web/scheduled-tasks.md

### 3.6 审计
- AI 日志：「按对话轮次查看处理结果及调用的技能、连接器和专家套件」「最迟在使用后 1 小时内可查，**最多查询最近 90 天**」，可导出 CSV（复核；90 天是查询窗口，不是保留期——同意 B）。【一手】https://docs.qwenwork.cn/enterprise-ultimate/audit-logs/ai-logs.md
- 会话回放/提示词全文审计：**未查到**。

### 3.7 商业模式
- 个人版：免费版 0 元 / **个人标准版 98 元/月**（连续包月 78 元、年付 823 元）/ **个人高级版 198 元/月**（连续包月 158 元、年付 1,663 元）；每月套餐内积分 0/2,000/4,000，另有限时每日登录奖励；并行任务数 10/不限/不限；云盘 1G/10G/20G；个人积分包仅付费用户可买。【一手】https://docs.qwenwork.cn/benefits/personal.md
- 企业版：经阿里云官网购买「席位和积分包，**积分包单独购买无效**，需要有效期内的席位才能使用」，积分包有效期一年；组织积分由获坐席成员共用，可设组织/团队/成员限额（最低 2,000 积分）。具体价格文档**未列**。【一手】getting-started/source-intro.md、enterprise/credits.md

### 3.8 QwenWork 小结

| 字段 | 桌面客户端 | Web / 钉钉端 |
|---|---|---|
| Agent 循环与执行 | 本机；可选“安全工作环境”（本机隔离 VM，实现未公开） | 阿里云端 |
| 文件/会话 | 本地；与 Web 会话不同步 | 云盘 + Agent 工作区（中国大陆） |
| 数据承诺 | “不会被用于产品改进”（企业由管理员控制） | 用途含“改进产品体验”；删除≠物理删除 |
| 权限 | 自动审批模式/安全中心；电脑操控逐次询问（默认）；企业 Hooks（fail-open） | 连接器授权 |
| 远程 | IM 频道开放/配对模式；在线要求未写明 | 网页本身即远程 |
| 定时 | 本地；睡眠/关机跳过，不补跑 | 云端，关浏览器也跑 |
| 企业治理 | 企业版能力“桌面客户端后续支持”；Hooks、可信设备、IM 频道开关、模型白/黑名单 | SSO/SCIM、AI 日志 90 天查询 |
| 计费 | 个人 98/198 元/月 + 积分；企业席位 + 积分包（价格未公开） | 同左 |

---

## 4. Anthropic Claude Cowork / Claude Code 与 OpenAI ChatGPT Work / Codex

### 4.1 Claude Cowork（核验“10-06 起默认云端”）
> 抓取：`support.claude.com/en/articles/14479288-claude-cowork-architecture-overview`（curl 直取，页面 JSON `updated_at` = **2026-10-06T19:11:08Z**）；`claude.com/pricing`；Claude Code CHANGELOG（GitHub raw）与 Releases API。时间 2026-10-09 23:21 CST。

- **默认云端（确认）**：「Cowork sessions run in the cloud by default: the agent loop and code execution run on Anthropic's servers, and sessions and files are saved to the member's Claude account」；「Local execution remains available for existing desktop deployments」；本地会话仅适用于既有桌面部署，「on Pro and Max plans, only tasks and scheduled tasks started on the device **before October 6, 2026**」。【一手】架构页（页面更新 2026-10-06）→ S2/B 的说法成立；“10-06”是页面写明的分界日，同时也是页面更新日，**不能倒推到更早**。
- 适用计划：「Claude Cowork runs in the cloud on Pro and Max plans. It's in beta on web and mobile for Team plans, and Enterprise plans when enabled by an owner」。**新增**：「Claude Cowork and chat are now one Claude, rolling out gradually to Pro and Max plans……Team and Enterprise organizations keep chat and Claude Cowork as they are today」；定价页同样写「Claude Cowork is now just Claude. Rolling out to Pro and Max」。【一手】架构页、https://claude.com/pricing
- 云会话隔离：每会话独立临时沙箱，会话结束即销毁，与 Anthropic 企业/研究/训练环境分离；默认不可达私网/内网/link-local/云元数据地址；「Egress is enforced outside the sandbox……mandatory proxy」；沙箱只持有数小时内过期的会话级令牌，「Connector authorization tokens never enter the sandbox; connector calls are made on the server side」；数据层按组织/账号隔离。【一手】架构页
- **云会话如何碰本机（关键）**：「When a session in the cloud needs something on the user's device, like a local file or the browser, the request goes through the Claude Desktop app on that device over an **Anthropic-brokered connection**. Local file access is limited to folders the member has connected……each local tool call is checked against the member's permissions before it runs. **If the desktop app is offline, a session in the cloud can't reach the device.**」；且「the agent's work, including any local files it opens through the desktop app, is **processed on Anthropic's servers** rather than staying on the device」。数据承诺：「handled under the same commercial commitments as other Team and Enterprise data and isn't used to train Claude」。【一手】架构页
- 本地会话（既有部署）：Agent 循环在本机原生运行（连接文件夹读写、web fetch、本地 MCP，受应用层权限系统约束）；代码执行在专用 Linux VM（macOS Virtualization.framework / Windows Hyper-V）；VM 起不来时「file and web tools」照常、shell 报「workspace unavailable」。【一手】架构页（与 S2 一致）
- **组织级云会话控制（新增细节）**：可单独关闭云会话而保留本地 Cowork；设云会话网络策略（Enterprise 默认无网络）；「Require fresh approval for every permission-gated tool call by turning off persistent 'always allow', and control whether members can run sessions **without per-call approval prompts**」；「Require **trusted-device enrollment and a recent sign-in** for sessions in the cloud」；MDM 键 `isLocalDevMcpEnabled`、`isDesktopExtensionEnabled`（关闭本地 MCP 后云会话只剩“限文件夹的桌面文件工具”）。【一手】架构页
- 审计：「Cowork via Claude, Claude Desktop, and Claude Mobile is captured in **Compliance API**」；Team/Enterprise 可用 OpenTelemetry 监控。EDR：「The VM is isolated from host-based security tools by design, and sessions in the cloud run entirely outside your endpoints, so **EDR tools can't observe them**」。【一手】架构页
- 定价（claude.com/pricing，抓取 10-09）：Free $0；Pro $17/月（年付）/$20（月付）；Max 5x 与 Max 20x（页面数字 $100 起、$200）；Team 席位 $20/月（年付）或 $25（月付），另一档 $100（年付）/$125（月付）；Enterprise 自助版「US$20/seat/month, billed annually. **Usage cost scales with model and task**」（席位费 + 用量费分离）。【一手】→ 数字为页面抽取文本，档名对应关系以页面为准。

### 4.2 Claude Code（只补 10-02 之后的增量；权限模式、沙箱、managed settings 详见 S2 §4.1–4.2）
- 最新版本 **v2.1.295（2026-10-08T19:48Z）**；10-09 当天无新版本。【一手】GitHub Releases API
- v2.1.295：「Added `onFailure: "block"` for command and HTTP hooks: a hook that can't start, times out, or exits with an unexpected code **blocks the action instead of letting it through**」（与 S2 一致，已复核）；同版有多条 [Cloud sessions] 修复，包括「some older **routines** starting their runs without ever giving Claude their saved prompt」→ Claude Code 有云端会话与云端定时“routines”。v2.1.294（10-08）：「Fixed `prompt` and `agent` hooks written as instructions……allowing what they should block」。【一手】https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md

### 4.3 OpenAI ChatGPT Work / Codex / dots
> 抓取：`developers.openai.com/codex/{cloud,sandbox,windows,remote,pricing}.md`（页面头注明文档索引已迁至 `learn.chatgpt.com/llms.txt`）、`learn.chatgpt.com/docs/{remote-connections,automations,dots,dots/computers-and-apps}.md`、Codex GitHub Releases。`help.openai.com` 的 ChatGPT agent 文章 **curl 返回 403（Cloudflare）**，本轮未能核验“ChatGPT agent”原页面。所有 learn.chatgpt.com 页面无可读更新日期。

- **云任务（Codex Cloud）**：「Each task has its own workspace and **can keep working while your computer is asleep**」；环境需选 GitHub 仓库、配置网络访问与密钥。【一手】https://developers.openai.com/codex/cloud.md ；旧版「Codex Cloud (Legacy): Runs in isolated OpenAI-managed containers……two-phase runtime model」。【一手】sandbox.md
- **云协调 + 本机执行（“Local computer access with Work Cloud”）**：「OpenAI's cloud coordinates the task, and an online, connected computer can execute steps that need its local resources」；**离线降级**：「If the computer is unavailable when a new turn starts, an existing eligible task……can continue in a cloud container. **The cloud container cannot access files or tools on the unavailable computer. It also does not enforce enterprise requirements from local execution.** A task cannot switch from local execution to the cloud during a turn」；仅对开启同步后新建的任务生效。【一手】https://learn.chatgpt.com/docs/remote-connections.md
- 远程（手机）：「Codex runs tasks in the cloud or on a connected computer」；连接本机需桌面 App「Settings > Connections > Control this Mac or PC」+ 扫码；「**Keep your computer awake and online**」；手机可「Review requested commands and actions before Codex continues working on your connected computer」。链路：「A **secure relay layer** keeps trusted machines reachable……without exposing them directly to the public internet」；远程会话沿用主机的「sandboxing settings, security controls, and action approvals」。是否端到端加密：**未查到**。【一手】https://developers.openai.com/codex/remote.md 、remote-connections.md
- 策略分层：「Cloud execution: Work cloud containers use existing Work Cloud policies. Local execution: ……MDM and legacy managed-device requirements take precedence over Agent Security, which takes precedence over the device's system requirements file」；「Work cloud containers and **dots cloud computers** use their own execution configuration」；「Moving between desktop, web, and mobile does not grant access to another computer」；`approval_policy = "untrusted"` 已退役。【一手】sandbox.md（复核 S2 一致）
- **dots（新增，S2 仅提到名称）**：「Powered by GPT-6 Astra, your dot lives in the cloud and has its own computer and browser. You can reach it and it can keep working **even when your computer is off**」；「Dots are **rolling out gradually** to eligible accounts」（**灰度中，不是全量上线**）；可连接「only one personal computer at a time」，「Your computer must be online」；云浏览器「doesn't inherit logins from your personal browser」；可经 Slack 等渠道联系。【一手】https://learn.chatgpt.com/docs/dots.md 、/dots/computers-and-apps.md
- 定时任务：桌面 App 定时任务可用本地项目，「Keep the computer on and the app running when a scheduled task needs local files」；网页定时任务「don't keep a local folder or worktree available between runs」；团队「Team Tasks run in the cloud」。【一手】https://learn.chatgpt.com/docs/automations.md
- Windows 本机沙箱：mxc / elevated / unelevated 三种（详见 S2 §4.4，本轮复核页面仍在）；Codex CLI 最新正式版 rust-v0.162.0（2026-10-08），10-09 有 0.163.0-alpha.2/.4 预发布。【一手】windows.md、GitHub Releases
- 定价：「**ChatGPT Work and Codex share usage**……uses the same pricing, credits, and usage limits as Codex」；Free $0、Go $8、Plus $20、Pro $100/$200/$500、Business $20/人/月（2 人起年付；月付 $25）、Enterprise & Edu 询价；可用 ChatGPT credits 扩展用量。【一手】https://developers.openai.com/codex/pricing.md

### 4.4 小结（海外两家）

| 字段 | Claude Cowork | ChatGPT Work / Codex / dots |
|---|---|---|
| Agent 循环 | **默认云端**（10-06 起 Pro/Max 新任务）；既有桌面部署可本地 | 云协调；可本机执行（连接电脑）或云容器 |
| 工具/代码执行 | 云：每会话临时沙箱；本地：Linux VM（Hyper-V/VZ） | 云容器；本机 OS 沙箱（mxc/elevated/unelevated、Seatbelt） |
| 本机文件 | 经 Desktop App 的 Anthropic 中转连接，仅已连接文件夹、逐工具权限检查；内容在 Anthropic 服务器处理 | 经 secure relay 连接主机，沿用主机沙箱与审批 |
| 电脑离线 | 云会话够不着本机，其余照常 | 新一轮可降级到云容器，但够不着本机文件且**不执行本地企业策略** |
| 定时 | 云端（本地仅 10-06 前存量） | 桌面定时需开机；网页/Team Tasks 云端 |
| 企业控制 | 云会话开关、网络策略、禁持久“总是允许”、可信设备+近期登录、MDM 键、Compliance API、OTel | MDM > Agent Security > requirements；云/本地策略分别测试 |
| 计费 | 席位 + 用量（Enterprise 自助 $20/席/月 + 用量） | 订阅档 + credits，Work 与 Codex 共用额度 |

---

## 5. 其他产品（时间有限，只记录云地划分要点）

### 5.1 Manus（云端默认 + Desktop “My Computer” 本地桥）
> 抓取：`manus.im/docs/llms.txt` 及 `features/desktop.md`、`integrations/manus-browser-operator.md`、`introduction/plans.md`（2026-10-09 23:24 CST；页面无更新日期）。
- 默认在云：「Manus Desktop app brings the power of Manus **out of the cloud** and directly onto your local computer. Its core capability, **My Computer**, allows Manus to securely interact with your local files, applications, and development tools」。【一手】https://manus.im/docs/features/desktop.md
- 本机权限：「**Folder-Scoped Access**: Manus can only access the specific folders you have explicitly authorized」；「**Every command** that Manus attempts to execute on your local machine **requires your explicit approval**……Allow Once……or Always Allow」；可用本机 CLI 工具与 GPU；可与 Scheduled Tasks 组合跑本地定时任务；「Create a 24/7 Assistant: Turn an **always-on computer** into a dedicated AI assistant」。【一手】同上 → 本机必须在线；本机隔离（VM/沙箱）**未写**，靠“文件夹授权 + 逐命令批准”。
- 浏览器：「Cloud Browser (Default): Sandboxed, isolated environment」vs「Local Browser (Browser Operator): Uses your actual browser with existing sessions」，每个任务需点「Authorize」一次性授权；「As long as your primary computer is online……ready to work from anywhere」；状态「**Beta rollout to Pro, Plus, and Team users**」。【一手】https://manus.im/docs/integrations/manus-browser-operator.md
- 计费：「credit-based system」，Free / Pro / Team（Team 为「Shared team credit pool……admin controls」），文档页未列价格。【一手】https://manus.im/docs/introduction/plans.md

### 5.2 字节（豆包工作 / 扣子）、飞书 aily、钉钉悟空
- 本轮**未复核**（工具调用预算用于前 4 类产品）。现有证据见 S2 §6：豆包工作仅有飞书官网文章（2026-08-24）一手口径（“任务在云端持续运行”“企业私有数据不用于模型训练”“PC 客户端在授权范围内调用浏览器和电脑界面”），其余为媒体二手；扣子、悟空无一手帮助页；aily 为纯云端平台。引用时须保留 S2 的一手/二手标注。

---

## A. 跨产品共性与分歧

**A1. 控制面一律在云——成立，且无一例外。** 账号与席位、额度/积分计量、策略下发、审计采集、远程通道中转这五件事，所有产品都放在厂商云上：Kimi（统一额度池、加油包、远控）、WorkBuddy（Credits、SSO、企业下发安全路径规则、AI 安全审计会话回放、IM 网关）、千问办公（企业 Hooks 配置、模型白/黑名单、IM 频道开关、AI 日志）、Claude（组织设置、云会话开关、Compliance API）、OpenAI（Agent Security、managed policy、云端 orchestrator）。差别只在“控制面有没有企业 IT 治理”：Kimi 企业版只有席位/成员/订单（§1.8），WorkBuddy、千问办公、Claude、OpenAI 都有 SSO + 策略 + 审计。

**A2. 执行面本地/云并存，但国内是“两个产品”，海外是“一个会话两种落点”。**
- 国内：Kimi Work（本地） vs Kimi Agent/Claw（云），项目数据不互通；千问办公桌面 vs Web，会话与定时任务不同步；WorkBuddy 桌面 vs WMA（云，白名单内测），更新日志另有未成文的“云助理/云端任务”。
- 海外：Claude 云会话通过桌面 App 的中转连接按需触达本机已连接文件夹；ChatGPT Work 由 OpenAI 云协调、在线电脑执行需本机资源的步骤；同一会话可在云与本机之间切换落点（OpenAI 明确“一轮内不能从本地切到云”）。
- 趋势信号：Anthropic 在 10-06 把 Pro/Max 的 Cowork 改为默认云端，并开始把 Cowork 与 chat 合并为“一个 Claude”；OpenAI 推出常驻云端的 dots（灰度）。国内三家截至 10-09 仍以“本地桌面 Agent”为主形态。

**A3. “电脑关机/离线时内容任务怎么办”——各家做法一致的底线是：不把本机文件偷偷搬上云。**
| 产品 | 离线时本地任务 | 无人值守的替代路径 |
|---|---|---|
| Kimi Work | 不执行、不补跑；提供“熄屏保持运行/屏幕常亮”防休眠 | Kimi 网页定时任务（云）、Kimi Claw 云主机（每日扣额度） |
| WorkBuddy | 助理要求电脑开机运行；“允许锁屏运行”三档 | WMA 云端 7×24（白名单内测） |
| 千问办公 | 跳过并标“未执行”，可手动补；“保持系统唤醒” | Web 定时任务（云） |
| Claude Cowork | 云会话照常跑，但“desktop app offline → can't reach the device” | 云会话本身 |
| ChatGPT Work | 新一轮可降级到云容器，但够不着本机文件、且不执行本地企业策略 | Codex Cloud、Team Tasks、dots 云电脑 |
| Manus | 需 always-on 电脑 | 默认云端 |

→ 没有一家在设备离线时自动上传本机材料到云端继续处理；“云端继续”只针对已在云上的材料或公开信息。

**A4. 远程/手机触发的降权手段（四类）。** ① 收窄范围：WorkBuddy 助理固定“助理专属文件夹”+单会话；Claude 云会话仅可触达已连接文件夹；dots 同时只能连 1 台个人电脑。② 绑定身份/设备：WorkBuddy“绑定身份+多层来源校验”；千问 IM“配对模式”；Claude 组织可要求云会话“trusted-device enrollment and a recent sign-in”；OpenAI 扫码配对、“只连接你拥有并信任的设备”。③ 审批不随远程消失：WorkBuddy 远程高危仍需确认；OpenAI 手机端可审批主机上的命令，主机沙箱与审批照常；Claude 可关掉持久“总是允许”、强制逐次批准。④ 管理员开关：千问企业版逐个关 IM 频道；Claude 组织级关云会话；Claude Code 组织关 Remote Control 后会话即断（S2）。Kimi Work 远控的降权机制：**未查到**。

**A5. 云端托管用户文件：所有产品都提供，但在桌面形态里都是“显式动作”。** Kimi 项目 20–50GB、Claw 云主机保留 workspace；WorkBuddy 资料库 5–50GB、企业网盘 50G/席、WMA 产出物云端驻留；千问 Web 云盘 1–20G（中国大陆）；Claude 云会话的文件存入成员账号，经桌面打开的本机文件也在 Anthropic 服务器处理；OpenAI 云环境/容器、dots 云电脑保留状态；Manus 默认云端。桌面端把文件送上云的路径都是用户可见的动作（上传、推送到小程序“把文件同步到云端”、开启 Work Cloud 同步、连接文件夹）。

**A6. 本机权限档的共同骨架：工作区内自动、越界与高危要确认、另有一个“全放开”。** Kimi（默认/手动允许/全部）、WorkBuddy（默认/完全访问，且后者对整台客户端生效、不跨设备）、千问（自动审批模式；电脑操控逐次询问）、Claude Code（default…bypassPermissions）、Codex（sandbox × approval）、Manus（逐命令 Allow Once/Always Allow）。分歧在“企业能否锁死”：Claude/OpenAI 能（managed settings、MDM、requirements.toml）；WorkBuddy 能下发安全路径规则，但能否禁用完全访问未查到；千问 Hooks 失败即放行，数据共享开关由管理员控制；Kimi 无公开机制。Hook 失败语义上，Claude Code 10-08 新增 `onFailure: "block"`，千问仍为 fail-open。

**A7. 商业模式：席位订阅 + 按模型 token 价折算的积分/额度池 + 超额包，是国内外通行做法。** Kimi 个人 ¥49–699/月、企业 ¥4,200/座/年，统一 token 额度池，加油包“近似开放平台 API 价格”（企业版不支持）；WorkBuddy 企业 ¥198/316 人/月含 2,000 Credits/人（团队共享），积分消耗与“模型 Token 定价”挂钩，**企业自定义模型不消耗 Credits**；千问个人 ¥98/198 元/月 + 积分，企业席位 + 积分包（包需有席位才可用）；Claude Enterprise 自助 $20/席/月 + 按模型与任务计用量；OpenAI Work 与 Codex 共用 credits。云沙箱常驻单独计费是新动向（Kimi Claw 云主机每日约 0.6% 额度、网站托管 0.08%）。

---

## B. 对“只买 API token + 席位订阅 + 桌面本地 Agent”的法律产品的启示

**B1. 中软云端必须接手的“Kimi 会员云”职能（API token 不附带）。** 依据 §1：
1. 身份、席位与组织（Kimi Business 的“个人/企业空间隔离”、邀请、席位释放），并补上 Kimi 企业版没有的 SSO、可信设备、离职回收。
2. 计量与成本闸门：统一额度池、按月刷新、5 小时/周类频控、成员上限、超额包与月消费上限、失败任务不扣费规则——这些都是会员系统能力，开放平台只给按 token 的账单。
3. 策略下发与锁定：权限档锁定（禁用“全部/完全访问”）、安全路径规则、工具/插件白名单、模型白名单——Kimi 现无公开实现，WorkBuddy/千问/Claude/OpenAI 都有。
4. 审计汇集：至少“动作元数据”级别的集中审计（千问 AI 日志按轮次、WorkBuddy 审计中心与会话回放、Claude Compliance API）；正文是否上收应是律所可选项（参照 WMA“客户端会话记录是否要云端可见”开关）。
5. 远程通道：手机/IM 遥控的中继与设备配对（Kimi Work 远控的链路未公开，不能假定可复用）。
6. 云端调度：Kimi 网页定时任务在云端执行而 Kimi Work 本地任务关机不跑；法律版若要“法规更新/裁判文书订阅”类无人值守任务，需中软自有云调度（只处理公开信息）。
7. 插件分发与付费数据源：Kimi 会员含“同花顺、天眼查等付费数据库”调用次数与插件市场；只买 token 不含这些，法律数据库（法规、案例）需中软自建或另采。
8. 数据承诺：Kimi Business 的“默认不使用业务数据训练”是会员合同口径；开放平台 FAQ 与 llms.txt 本轮**未检索到**训练/留存条款（仅 grep，未读协议原文），API 路径的处理与留存须单独写入合同。

**B2. 主流产品的本地/云分工（可直接作为法律版默认）。**
- 放本地：授权文件夹内的读写；代码/脚本执行（OS 沙箱或本机 VM）；带用户登录态的浏览器（WebBridge、Browser Operator、Chrome 扩展）；电脑操控；本地定时任务（需唤醒）；会话正文（WorkBuddy、千问桌面均在本地）；个人连接器凭据（WorkBuddy 项目“个人授权……仅保存在成员本地，不上传云端”）。
- 放云端：模型推理；身份/计费/策略/审计；IM 与手机中继；云定时任务；共享连接器凭据保管（WMA“凭证独立于 Agent 集中存储……换发短期令牌”；Claude“connector tokens never enter the sandbox”）；可选的云沙箱 Agent 与云盘。
- 注意：本地执行不等于内容不出设备——Claude 明说经桌面打开的本机文件“processed on Anthropic's servers”，千问“数据不离开设备”只指执行环境；法律版对外表述应按“原件/片段/提示词/产物/日志”分项说明去向。

**B3. 云端执行用户材料：海外渐成默认，国内仍是可选/另一产品，且没有“离线自动迁云”。**
- 默认：Claude Cowork 对 Pro/Max 自 2026-10-06 默认云端（Team/Enterprise 由组织开关）；dots 常驻云端（灰度）。
- 可选：ChatGPT Work 的 Work Cloud 需工作区启用且只对之后新建的任务生效；WorkBuddy WMA 白名单内测；千问/Kimi 的云端能力是另一入口（Web/Agent/Claw），与桌面会话不通。
- 不提供：任何一家都不在设备离线时把本机材料自动搬上云。
- → 对法律版：不必为“对标”而默认云端处理案卷；但要给“关机怎么办”一个明确答案——本地防休眠 + 云端只跑公开信息任务 + （可选）律所显式开启的云托管案件空间，三者在 UI 上标清执行节点；并参照 Claude 提供“组织关闭云执行”“禁持久总是允许”“可信设备 + 近期登录”三项开关，参照 Claude Code `onFailure: "block"` 让高风险 Hook 失败即拒绝（千问的 fail-open 是反例）。
- 另需告知律所：本机 VM 与云会话对终端 EDR 不可见（Claude 原文），若律所合规依赖终端可见性，选择 VM 型隔离前要评估。

**B4. 定价参照。** 国内同类桌面 Agent 席位价区间：WorkBuddy 企业 ¥198–316/人/月（含 2,000 Credits）、Kimi Business 约 ¥350/座/月、千问个人 ¥98–198/月；这些价格都内含一个“按 token 折算的额度池”，并靠成员上限与超额包控制成本。中软以 API token 为成本、席位为收入时，至少要复制“额度池 + 成员上限 + 超额包 + 消费上限”四件套；WorkBuddy“自定义模型不消耗 Credits”说明“企业自带模型/私有化”是另一条定价线。

---

## C. 对 S2 / B 的纠正与补充汇总
1. **WorkBuddy 版本源**：腾讯云文档中心更新记录停在 5.5.2（09-03）；codebuddy.cn/workbuddy.cn 文档站更新日志已到 **5.7.7（2026-10-08）**，10 月内三版。S2“10-02 后无新时间戳”只对腾讯云文档中心成立。
2. **WorkBuddy 权限**：新文档站有“安全中心”（文件读/写/删三态规则、命令前缀规则、网络域名规则、审计中心、批量删除审批等），“完全访问”对整台客户端生效、不跨设备；5.6.0 出现“企业下发安全路径规则”。S2“allow/ask/deny 语法未公开、管理员锁定未查到”需改为“细粒度规则已有用户侧配置，企业可下发安全路径规则，能否锁死完全访问未查到”。
3. **WorkBuddy 远程**：新增“远程控制安全边界”（绑定身份、多层来源校验、高危确认）；更新日志出现未成文的“云助理/云端任务”。
4. **WMA**：截至 10-09 仍“预计10月份”，管理端更新记录无 10 月条目——与 S2/B 一致。
5. **千问办公**：10-09 发布 **1.2.5**（S2/B 记录止于 1.2.1）。桌面“不会被用于产品改进”（B 已纠正 S2），本轮复核成立。
6. **Kimi**：版本仍为 3.2.15（09-30）；帮助中心**无**远程控制专页；Kimi Work 项目与 Kimi Chat 项目“相互独立、数据不互通”；定时任务页与会员页档位名称/配额不一致；Kimi Claw 云主机每日扣约 0.6% 额度；加油包不支持企业版；Kimi Business 管理员无客户端策略能力。
7. **Claude Cowork**：架构页 `updated_at` 2026-10-06；新增“Cowork 与 chat 合并为一个 Claude（Pro/Max 灰度）”、组织可要求云会话“可信设备 + 近期登录”、可禁持久“总是允许”、EDR 不可见、Compliance API 覆盖。
8. **OpenAI**：Codex 文档索引迁至 learn.chatgpt.com；Work Cloud 离线降级语义（云容器够不着本机、不执行本地企业策略）；dots 为 GPT-6 Astra 驱动、灰度中；help.openai.com 对 curl 返回 403，“ChatGPT agent”原页面本轮未核验。

## D. 本轮未查到清单
1. Kimi Work：本机 OS 级沙箱；远控链路/中转方/端到端加密/手机能否审批；会话是否云同步；企业锁定权限档；个人版训练/留存条款；开放平台 API 的数据使用条款（FAQ/llms.txt 未检索到）。
2. WorkBuddy：Windows/macOS 沙箱具体机制；“云助理/云端任务”说明页；WMA 10 月上线公告；能否禁用完全访问；桌面 Hooks；审计采集字段与保留期；定时任务补跑规则。
3. 千问办公：安全工作环境的 hypervisor 与管理员要求；IM 频道是否要求电脑在线；企业版价格；会话回放。
4. Claude：Windows 家庭版对本地 Cowork 的官方定论（本地模式已转为存量）；各档 Cowork 用量与价格的对应关系。
5. OpenAI：ChatGPT agent 原页面；secure relay 是否端到端加密；dots 的计划/地区可用性细则（页面有 availability 段，本轮未读）。
6. 豆包工作/扣子/飞书 aily/钉钉悟空：本轮未复核（见 S2 §6）。
