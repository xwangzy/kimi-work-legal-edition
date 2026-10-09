# 调研 S2：主流 Agent 的权限设定与本机沙箱（Windows 重点）

- 日期：2026-10-09（增量调研，基线为 2026-10-02 的 R1/R2：`research/2026-10-02-云地划分v6/调研-R1-国内办公Agent云地划分.md`、`调研-R2-海外Agent与法律AI云地划分.md`）
- 目的：为「Kimi Work 法律行业发行版」的云端/本机执行权限、功能划分（v7）提供事实底座；重点是权限设定细节与 Windows 本机沙箱工程实现。
- 方法：WebSearch / WebFetch / curl 直接抓取官方文档页、.md 与 llms.txt、GitHub REST API 与 raw 文件。只写有出处的事实。
- 标注：【一手】= 官方文档 / 官方仓库 / 官方公告；【二手】= 媒体与第三方。每条附 URL 与发布或更新日期（页面未标日期时写「抓取 2026-10-09」）。查不到写「未查到」，不推测补全。
- 「→」开头的句子是本报告的解读或对法律版的含义，不是来源原文。

---

## Q1 腾讯 WorkBuddy：10-02 之后的增量与权限细节

> 抓取方式：curl 抓 cloud.tencent.com/document/product/1831 各页（抓到第 7 页后触发腾讯云人机验证，其后改用 WebFetch）。**结论先行：10-02 之后腾讯文档中心未见新的更新时间戳**——本轮抓到的各页「最近更新时间」最晚为 2026-09-30（WMA 两页），权限、助理、FAQ 页仍为 09-07 / 09-16。

### 1.1 WMA 是否已进入 WorkBuddy Enterprise 管理端
- **截至 2026-10-09 官方文档口径未变**：仍写「已在腾讯云侧上线，当前在白名单内测阶段，**预计10月份**将同步完成 WMA 在 WorkBuddy Enterprise 管理端的升级」。【一手】WMA 简介 https://cloud.tencent.com/document/product/1831/134407 （最近更新 2026-09-30 11:58:30）；WMA 使用说明 https://cloud.tencent.com/document/product/1831/138968 （最近更新 2026-09-30 11:58:30）。是否已完成升级：**未查到**发布公告。
- WMA→企业端的推送链路（权限口径）：「推送 Agent 到企业：将云端创建 Agent 推送到关联企业管理端，在管理端支持微调后，统一下发到企业客户端」；推送时「跳转企业管理端登录并校验推送者身份权限……需补充 Agent 归属信息，**确认客户端会话记录是否要云端可见**」；下发可见范围「全员不可见 / 全员可见 / 指定范围可见（『全员可见』仅限超级管理员可操作，『指定范围可见』子管理员只能指定其负责范围）」。【一手】138968（2026-09-30）
- WMA 数据与网络口径：接入有「公网 API 访问、VPC 私有访问……A2A 访问开关」；「网络配置：配置 Agent 支持出访的网络出口（公网 or VPC）」，「网络配置与 VPC 私有访问的配置相互独立，分别控制『出访』与『被访』」；「Agent Key 管理：按密钥维度管控 API 调用权限与用量」；自动化任务「每次执行都会创建独立 Session，执行过程与结果完整留痕、可追溯」；「对话记录对全部会话集中观测」。【一手】138968（2026-09-30）
- WMA 底座：「独享沙箱隔离（1 Session : 1 沙箱）、存算分离……」「数据不出域（配置与运行均在云端，敏感产出物云端驻留，支持 VPC 私有网络）」。【一手】134407（2026-09-30）（与 R1 一致）
- API 侧线索：腾讯云 API 文档存在 `workbuddyenterprise.tencentcloudapi.com` 下把外部 Agent 绑定到 managed agent 的接口（Version 2026-07-09）。【一手，仅见搜索摘要，未展开】https://cloud.tencent.com/document/api/1831/138635

### 1.2 桌面端「默认权限 / 完全访问」与 allow/ask/deny
- 两档内容与 R1 相同（默认档对「写入或修改工作空间外的文件 / 删除文件或目录 / 执行脚本、命令或外部程序 / 调用敏感能力」弹确认；Full Access「会关闭上述二次确认」，切换时「勾选风险确认」）。新增可引用的细节：切换位置「在新建任务输入框下方，单击默认权限下拉菜单」；**「如果您取消确认，WorkBuddy 不会执行这一步」**；完全放开「只是把确认环节交给 AI 自动通过」，建议只在「Docker、虚拟机、一次性工作目录」使用；明确不建议在「正在处理生产资料、**客户资料**、财务资料或唯一副本」时开启。【一手】默认权限与安全沙箱 https://cloud.tencent.com/document/product/1831/134401 （最近更新 2026-09-07）
- 更新记录中的权限交互变化：「拒绝单步权限时仅跳过当前步骤，执行中切换能力不再中断当前回复」「无访问权限时提前引导授权，并减少同类权限重复弹窗」「优化自动化任务的默认权限」「修复子 Agent 编辑文件未走沙箱审批的问题」。【一手】更新记录 https://cloud.tencent.com/document/product/1831/134324 （最近更新 2026-09-07；条目日期 2026-08~09）
- **allow/ask/deny 的具体规则语法：WorkBuddy 桌面端文档未给出**；FAQ 只写「分层权限系统：支持 allow(允许)、ask(询问)、deny(拒绝)三种权限规则」「默认安全设计：启动时仅拥有只读权限，编辑文件、运行命令需显式用户批准」。【一手】https://cloud.tencent.com/document/product/1831/134405 （2026-09-07）
- 同门产品 CodeBuddy Code（workbuddy.ai 文档站）给出了完整语法，可作旁证（**不等于桌面端已实现**）：规则形如 `Tool` 或 `Tool(specifier)`，例 `Read(./.env)`、`Edit(/src/**/*.ts)`、`WebFetch(domain:example.com)`、`Bash(npm:*)`；评估顺序先 deny（立即拒绝）→ trusted allow → 命令安全检查 → ask →……；「`deny` always takes precedence」；模式有 default / acceptEdits / plan / bypassPermissions / delegate（另提 auto、dontAsk）；`disableBypassPermissionsMode` 可在 user / project / local / CLI 任一层设为 disable。【一手】https://www.workbuddy.ai/docs/cli/permissions （页面无日期，抓取 2026-10-09）
- **管理员能否锁定桌面端权限档**：桌面端文档**未查到**。企业 FAQ 仅称「精细化工具调用权限：严格控制 AI 对文件、命令、网络的访问能力」（134405）。CodeBuddy Code 沙箱页写「Enforce sandbox configuration through managed settings」，权限页有 `policySettings` 作用域。【一手】https://www.workbuddy.ai/docs/cli/bash-sandboxing （无日期）

### 1.3 Bash 沙箱与文件系统隔离：Windows / macOS 分别用什么
- **WorkBuddy 桌面端：未查到**任何关于具体隔离技术（AppContainer / 受限令牌 / WSL / 虚拟机 / seatbelt）的官方说明；只有 FAQ 的营销式表述「Bash 命令沙箱：AI 操作与真实系统严格隔离」「文件系统隔离：只能访问预先授权的工作空间目录」「防沙箱逃逸：阻止对配置文件的写入」（134405，2026-09-07）。
- 同门 CodeBuddy Code 的 Bash 沙箱写明：**Linux 用 bubblewrap，macOS 用 Seatbelt；「Currently supports Linux and macOS; Windows support planned」**；默认「Read-write access to current working directory」「Read access to the entire computer, except certain denied directories」；网络「controlled through a proxy server running outside the sandbox」，新域名触发授权；Bash 工具有 `dangerouslyDisableSandbox` 参数；`enableWeakerNestedSandbox`「significantly weakens security」。【一手】https://www.workbuddy.ai/docs/cli/bash-sandboxing （无日期，抓取 2026-10-09）
- → 结合 FAQ 中 Windows 排障需「以管理员身份打开 PowerShell」修复工作目录 ACL 的说明（134405），**没有证据表明 WorkBuddy 在 Windows 上有 OS 级沙箱**；Windows 上的「默认权限」更像应用层确认闸门。此为推断，待实测。

### 1.4 手机「连接电脑」/ 助理遥控
- 助理 =「通过手机上的即时通讯软件（微信、企业微信、QQ、钉钉、飞书）远程控制电脑上的 WorkBuddy 执行任务」；平台表列「微信助理（推荐）/ 微信客服号 / 企微助理 / QQ 机器人」。【一手】助理（远程任务）https://cloud.tencent.com/document/product/1831/134392 （最近更新 2026-09-16）
- **远程任务与普通任务的区别（官方表）**：工作目录「自由指定」vs「**固定使用助理专属文件夹**」；新建对话「支持多个并行任务」vs「仅一个会话，所有远程指令集中处理」；上下文「可清空历史重新开始」vs「保留完整对话历史，不可清空」；FAQ：「助理专门适用于远程任务，不支持修改（默认文件夹）」；注意事项「电脑需要保持开机并运行 WorkBuddy」；「助理页面可查看远程任务的完整执行记录，包括思考过程、操作步骤、生成文件及最终结果」。【一手】134392（2026-09-16）、134405（2026-09-07）
- 远程任务是否沿用「默认权限」确认、确认弹在手机还是电脑：**未查到**。
- 手机 App「连接电脑」链路是否经腾讯云中转：**未查到**官方说明。可见线索仅有更新记录「提升移动端连接电脑的稳定性，改善弱网、休眠唤醒和网络切换后的同步与重连」「修复『允许锁屏远程』重启后状态丢失」「修复端云同步断线后未自动重连」（134324）——「端云同步」字样提示存在云端同步通道，但未明说遥控指令是否经腾讯云中继。IM 助理走 IM 平台长连接（R1 已核，134405）。

### 1.5 会话历史存放与桌面—移动同步
- 本机：FAQ「找到 WorkBuddy 大文件夹。Windows：C:/Users/用户名/WorkBuddy，Mac: /Users/用户名/WorkBuddy……打开以日期或用户自定义名字命名的文件夹即可找回原有历史记录」。【一手】134405（2026-09-07）→ 工作空间文件夹按日期落在用户目录下；对话数据库的具体存放路径**未查到**。
- 同步：「提升桌面端与移动端同步完整性，会话标题、置顶状态和顺序可正确同步，断线后可自动恢复连接」「新增快捷键云同步能力，支持跨设备同步配置」「提升个人及项目**云助理**的建连和历史任务切换速度」。【一手】134324 → 至少会话元数据（标题/置顶/顺序）经云同步；会话正文是否上云**未查到**明确表述。
- 「是否支持云端部署或服务器安装：服务器端能力仍在完善中」。【一手】134405

### 1.6 企业版「AI 安全审计 / 会话回放」采集什么
- 官方页：平台「持续监测企业成员的 AI 会话日志」；「会话回放按会话和请求运行分别还原日志中可观察到的行为，不将独立会话拼接为一条调用链」；敏感等级「从 S1 至 S6 中选择」，有「单次输入 S5 及以上敏感内容」类规则；「敏感数据分级配置与 iOA DLP 保持严格的双向同步」；管理员按「组织架构树选择需查看的部门范围」并按员工姓名筛选。【一手】WorkBuddy Enterprise AI 安全审计 https://cloud.tencent.com/document/product/1831/138279 （最近更新 2026-09-16 21:22:01）
- **未查到**：具体采集字段（提示词全文 / 回复 / 文件 / 工具调用 / 截屏）、存放位置与保留期、适用版本、员工端是否需额外插件。
- FAQ 同时宣称「数据本地执行不上传……服务端仅处理数据片段：用后即弃，不保存，不用于模型训练」（134405）。→ 与「持续监测会话日志 + 会话回放」并存，说明「不上传」口径不含审计日志；法律版需把这一矛盾点明确设计掉。

## Q2 千问办公（QwenWork）

> 抓取：curl 抓 https://docs.qwenwork.cn/llms.txt 及各页 .md（2026-10-09 01:41 GMT）。文档站各页无「最后更新」字段；时间以客户端更新日志为准。**10-02 之后：未查到新变化**——客户端更新日志最新一条为「2026年09月23日 千问办公 1.2.1」。【一手】https://docs.qwenwork.cn/release-notes/desktop.md

### 2.1 桌面端运行权限是否分档
- 文档站**未查到**类似「默认 / 完全访问」的整体运行权限分档页面；llms.txt 目录中无「权限模式」类页面。
- 但 1.2.0（2026-09-21）新增两项与分档相关的能力：「输入框新增**『自动审批模式』**：在关键操作前自动识别风险并给出安全提示，累计防护记录可在安全中心查看」；「新增『安全中心』入口：在设置中可查看数据加密、关键操作记录、敏感信息识别、文件删除保护、批量删除确认等安全能力状态，并可回看历次审批与文件防护记录」；1.2.1 修复「『自动审批模式』下偶发『审批超时终止任务』」。【一手】release-notes/desktop.md（条目 2026-09-21、2026-09-23）→ 可推知存在「人工审批 / 自动审批」两种输入框模式，但哪些操作必审、自动审批的判定规则：**未查到**专页。
- 电脑操控（Computer Use）有独立执行策略：「**每次询问**（默认）：AI 每次需要操控桌面时都会先征求你的确认」/「**自动执行**：AI 直接执行桌面操作，无需逐次确认」；需授予辅助功能与屏幕录制权限；「对于网页任务，优先使用浏览器自动化」。【一手】https://docs.qwenwork.cn/desktop/computer-use.md
- macOS 系统权限清单含「完全磁盘访问权限：读写项目文件等操作」「录屏与系统录音」「辅助功能」「自动化」等。【一手】https://docs.qwenwork.cn/desktop/settings.md
- 管理员能否锁定上述模式：**未查到**（FAQ 称「企业版能力目前支持 PC 端和 Web 端，QwenWork 桌面客户端后续支持」——见 2.3）。

### 2.2 「安全工作环境」的实现方式与限制
- 设置页原文：「在你的电脑上单独开辟一块独立空间来跑任务——执行更快、更稳定，所有文件和数据都不会离开你的设备」「开启后，任务会在隔离的工作环境中运行，不影响你电脑上的其他文件，也不会触及真实系统」「清理工作环境文件，释放磁盘空间——会删除已下载的工作环境文件，但不会删除你的对话记录和工作产物」。【一手】desktop/settings.md
- **实现线索（一手，更新日志）**：「加强鸿蒙 PC 系统接口与 **Windows VM 服务**的权限边界」（1.2.1，2026-09-23）；「修复沙箱内无法启动 Chrome 的问题」（同上）；「修复 Windows 端开启『安全工作环境』时被安全软件拦截的问题，可选依赖安装失败不再阻断主程序安装」「Windows 安全工作环境启动不再弹出多余的依赖安装窗口」（更早版本）。【一手】release-notes/desktop.md → 「已下载的工作环境文件」+「Windows VM 服务」+「可选依赖安装」表明 Windows 上是**下载镜像、以本机虚拟机运行**的形态；具体是 Hyper-V / WSL2 / 其他 hypervisor、是否需要管理员或家庭版可用：**未查到**。macOS 实现：**未查到**。

### 2.3 网页端云端 Agent 能访问什么、与桌面端差异
- 网页端：「无需下载安装，通过浏览器即可使用」；「支持设置定时任务，即使关闭浏览器，任务仍可按计划在云端执行」；「通过连接器接入钉钉及其他外部平台和数据」。【一手】https://docs.qwenwork.cn/web.md
- 云端文件空间 =「个人网盘……是内置在平台里的云端文件空间」，对话中「消息附加个人网盘文件供千问办公读取；千问办公产出的文件自动存入『Agent 工作区』目录」。【一手】https://docs.qwenwork.cn/web/personal-drive.md
- **能力差异（FAQ 原文）**：「浏览器自动化和本地文件操作**仅客户端支持**」「网页全栈制作已支持 Web 端和钉钉端，客户端后续开放」「企业版能力目前支持 PC 端和 Web 端，QwenWork 桌面客户端后续支持」；「目前 Web 端与桌面客户端的定时任务和会话**相互独立，暂不支持同步**」。【一手】https://docs.qwenwork.cn/faq.md
- 浏览器连接器（客户端）：「控制你的浏览器」「**共享登录态**：在你已登录的浏览器中运行，无需重复输入账号密码」，仅 Chromium 内核，通过安装 Chrome 扩展连接。【一手】https://docs.qwenwork.cn/features/connectors.md → 网页端云 Agent 是否有云浏览器：**未查到**。
- 数据位置（隐私页，适用 Web 端与钉内）：「用户内容和相关数据存储在中国大陆境内的云服务环境中」；「为履行合规、审计或争议解决义务，部分数据可能在必要期限内继续保留」。【一手】https://docs.qwenwork.cn/getting-started/privacy-security.md

### 2.4 企业 Hooks 的失败语义（关键）
- 桌面端 HTTP 调用约定表（原文）：
  - `2xx` + 空 →「不改变原流程」；`2xx` + 纯文本 →「`PreToolUse` 将其解释为**允许**，不建议使用」；
  - `2xx` + JSON 语法错误或字段校验失败 →「`PreToolUse` **拒绝**本次工具调用；其他事件记录错误后继续」；
  - **非 `2xx` →「记录调用错误，继续原流程」；连接失败或超时 →「记录调用错误，继续原流程」**（即 fail-open 放行）；
  - 超时默认 `600` 秒，「建议显式配置，例如 `5`」；「超过 `timeout` 后结束该次调用，当前不自动重试」；同一事件多个 Hook「默认并行执行」；多个决定「按 `deny` > `ask` > `allow` 聚合；允许仍受工具权限规则约束」；「`deny` 只拒绝本次工具调用；需要停止当前执行时，使用 `continue: false`」；PostToolUse「拒绝或替换结果都不会撤销文件修改、命令执行或外部调用」。【一手】https://docs.qwenwork.cn/desktop/hooks.md
- 管理后台页：「业务拒绝也通过成功的 HTTP 响应表达……500 表示服务异常，不能代替明确的业务判断」；「已启用的策略组默认适用于所有用户，发布前应确认服务容量与可达性」；「处理超时、不可达或异常响应时的客户端行为，应在实际环境中专门测试」；请求体含 `transcript_path`、`cwd` 等字段。【一手】https://docs.qwenwork.cn/enterprise-ultimate/security/hooks-rules.md
- → 千问办公 Hooks 是 **fail-open**：律所 Hook 服务宕机或超时，工具调用照常执行。法律版若用同类机制做 DLP/审批，应改为对高风险事件 fail-closed。

### 2.5 是否承诺不用于训练
- 在隐私页、FAQ、llms.txt 全文中检索「训练」：**未查到**任何「不用于训练」承诺。【一手】getting-started/privacy-security.md、faq.md、llms.txt（抓取 2026-10-09）

### 2.6 审计与 IM
- AI 日志：「按对话轮次查看处理结果及调用的技能、连接器和专家套件。每行是一轮对话」；「AI 使用记录最迟在使用后 1 小时内可查，最多查询最近 90 天」；可导出 CSV。→ 记录的是轮次与资源调用元数据，是否含提示词/回复全文：**未查到**。【一手】https://docs.qwenwork.cn/enterprise-ultimate/audit-logs/ai-logs.md
- IM 频道「开放模式 / 配对模式」（配对以会话为单位，需本人在「配对管理」允许）。【一手】https://docs.qwenwork.cn/desktop/im-channels.md

## Q3 Kimi Work（与 Kimi 能力来源重复处从简）

> 抓取：curl 抓 kimi.com/zh-hans/help/kimi-work/{kimi-work-faq, release-notes, overview, plugin-center}（2026-10-09；页面 JSON 中 updatedAt = 2026-10-08）。**10-02 之后：发布日志最新仍为 3.2.15（2026-09-30），未查到新版本**。【一手】https://www.kimi.com/zh-hans/help/kimi-work/release-notes

### 3.1 运行权限三档：哪些操作会弹确认
- 三档原文：「**默认**：常规操作自动执行，Kimi 在修改、覆盖本地文件或运行代码等敏感操作前会请求你的明确授权；**手动允许**：操作前先请求授权；**全部**：无需授权直接执行。选择『手动允许』时，未经你同意不会发生任何操作」。开启「全部」后「AI 将直接读写文件、执行代码、修改系统配置，也会自动处理原本需要你决定的步骤」，风险列举「文件被覆盖、误删或损坏；系统配置被更改……磁盘加密、分区或固件变更，导致设备受限或无法启动」，且「开启『全部』……即视为你知悉并接受上述风险……结果将由你自行承担」。【一手】FAQ https://www.kimi.com/zh-hans/help/kimi-work/kimi-work-faq （页面 updatedAt 2026-10-08）；产品介绍 https://www.kimi.com/zh-hans/help/kimi-work/overview （同）
- 「默认」档是 3.2.2 新增：「运行权限新增『默认』选项，全局支持『默认』、『手动允许』、『全部』三档权限」（3.2.2，2026-08-26）。【一手】release-notes
- **「默认」档下确认清单只给了概括词「修改、覆盖本地文件或运行代码等敏感操作」**；删除、联网、工作区外读取、浏览器动作是否单独确认：**未查到**逐项清单。
- 其他二次确认：「账号退出登录时，如有运行中的任务将二次确认」（3.2.15，2026-09-30）。
- 本机隔离技术（是否有 OS 级沙箱）：**未查到**。官方只称「以 Kimi Code 为内核」。【一手】overview

### 3.2 管理员能否锁定档位（Kimi 企业版）
- **未查到**。Kimi Business 帮助页的管理员权限为「购买席位、生成邀请链接、管理成员、查看订单」；「手机 App 目前只支持个人会员」。企业版协议泛称管理员可「配置权限、管理访问权限」，未落到 Kimi Work 运行档位。【一手】https://www.kimi.com/zh-hans/help/kimi-business/kimi-business 、https://www.kimi.com/zh-sg/help/kimi-business/kimi-business-faq （经 WebSearch 摘要，抓取 2026-10-09）→ Kimi Work 权限档是**用户自选**，目前无官方的企业锁定机制。

### 3.3 内置浏览器与 WebBridge 的权限
- 3.2.0（2026-08-19）：「新增 Agent 内置浏览器：浏览器标签页绑定会话并归入预览区，Agent 可直接操控浏览器完成点击、输入等操作，mac 端还支持从本机 Chrome 导入 Cookie 复用已有登录态（**默认关闭**，可在设置中开启）」；「Kimi WebBridge 插件化：真实浏览器控制改为插件形态，**默认关闭**、可在设置中开启」。
- 3.2.2（2026-08-26）：「内置浏览器的 Agent 控制改为**默认开启**」。
- 3.2.14（2026-09-24）：「浏览器网页批注」；3.2.15（2026-09-30）：「内置浏览器打开 Notion 与飞书文档，支持 comments 编辑与页面问答」。【一手】release-notes
- → 现状：**内置浏览器（隔离的应用内浏览器）Agent 控制默认开；真实 Chrome 控制（WebBridge 插件）默认关；Cookie 导入（仅 mac）默认关**。浏览器动作是否走运行权限三档确认：**未查到**。

### 3.4 远程控制可以执行哪些操作
- 3.2.5（2026-09-04）：「新增远程控制功能：可通过手机远程控制桌面端 Kimi Work」；3.2.7：「远程控制消息分段展示，子 Agent 卡与产物卡对齐桌面形态」；3.2.9：「电源模式增加『熄屏后保持唤醒』……远控与后台任务不中断」；3.2.14（2026-09-24）：「支持在手机端直接预览 Office、html 等文件类型」「支持在手机端向 Kimi Work 上传附件」。【一手】release-notes
- 遥控链路（是否经 Kimi 云中转）、远程任务的工作目录限制、确认弹窗在哪一端处理：**未查到**。FAQ 页本轮未见远程控制条目（与任务给出的 FAQ 链接核对）。
- 定时任务：「在 Kimi Work 桌面端，定时任务在本地运行，需要应用处于开启状态……错过的触发不会在下次开启时补跑……（相比之下，在 Kimi 中创建的定时任务在云端执行）」。【一手】FAQ

## Q4 Anthropic（Claude Code / Cowork）与 OpenAI（Codex / ChatGPT Work）的本机沙箱与权限模型（重点）

### 4.1 Claude Code 本机沙箱
- 平台覆盖（原文）：「The sandbox runs on macOS, Linux, and WSL2. **On native Windows, Claude Code runs commands unsandboxed.** To use the sandbox on a Windows machine, run Claude Code inside a WSL2 distribution.」OS 原语：「macOS: uses Seatbelt」「Linux: uses bubblewrap」「WSL2: uses bubblewrap, same as Linux」；Linux/WSL2 依赖 `bubblewrap` 与 `socat`，可选 seccomp 过滤器（「adds Unix domain socket blocking」）。【一手】https://code.claude.com/docs/en/sandboxing （抓 .md，2026-10-09）
- 网络隔离：「A sandboxed command has no direct route to the network」——Linux/WSL2「runs in a separate network namespace that has no connection to your network」；macOS「Seatbelt……by default blocks connections other than the one to the sandbox proxy」；本机代理「outside the sandbox」，通过 `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY` 引导，按 allowed/denied domains 检查主机名；不读代理变量的工具（ssh、多数数据库驱动）即使目标被允许也连不上；UDP/QUIC/ICMP 无法出沙箱。【一手】同上
- 凭据保护：`sandbox.credentials` 可掩蔽 `~/.aws`、`~/.ssh` 等，「On Linux and WSL2 the output shows a sentinel in place of the token, and on macOS the read fails」；文档提示默认读策略「still allows them」。【一手】同上
- **管理员锁定**：「When managed settings set a Boolean key such as `enabled` or `failIfUnavailable`, Claude Code uses the managed value and ignores anything a developer sets locally」；数组键（如 `allowRead`）会合并，除非有锁；「**The sandbox doesn't run on native Windows, so with `failIfUnavailable` set, Claude Code exits at startup on those machines**」，建议把 Windows 用户迁入 WSL2 或容器。【一手】同上
- 开发者仍可在 `!` shell 模式下手动在沙箱外运行命令（「with the same access they already have in any terminal」），可用 strict sandbox mode 收紧。【一手】同上

### 4.2 Claude Code 权限模式（命名已变化）
- 现行六种模式（原文表）：`default`「Reads only」；`acceptEdits`「Reads, file edits, and common filesystem commands (mkdir, touch, mv, cp, etc.)」；`plan`「Reads, plus classifier-approved commands when auto mode is available」；`auto`「Everything, with background safety checks」；`dontAsk`「Reads and pre-approved tools; anything that would prompt is denied」；`bypassPermissions`「Everything」（Best for「Isolated containers and VMs only」）。【一手】https://code.claude.com/docs/en/permission-modes （抓 .md，2026-10-09）
- **默认起始模式已改为 `auto`**：「In a terminal or through the VS Code extension：`auto` with Claude Code v2.1.283 or later」；`claude -p` / Agent SDK 为 `default`；任一设置文件设 `disableAutoMode: "disable"` 则为 `default`；HIPAA 配置下为 `default`。【一手】同上；v2.1.283 发布于 **2026-09-25**（GitHub Releases API）。
- 锁定键：「To prevent `bypassPermissions` or `auto` mode from being used, set `permissions.disableBypassPermissionsMode` or `permissions.disableAutoMode` to `"disable"`……most useful in managed settings where they can't be overridden」；`allowManagedPermissionRulesOnly`「makes managed settings the only settings source of permission rules」。规则语法 `Tool` / `Tool(specifier)`。【一手】https://code.claude.com/docs/en/permissions
- 组织级默认模式：「Set `permissions.defaultMode` in managed settings. Terminal sessions start in that mode and people can still switch to auto mode」（若要禁止切换须配合 `disableAutoMode`）。【一手】permission-modes
- **10-02 之后与权限/管控相关的变更（CHANGELOG，一手）** https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md ：
  - v2.1.295（2026-10-08）：「Added **`onFailure: "block"`** for command and HTTP hooks: a hook that can't start, times out, or exits with an unexpected code **blocks the action instead of letting it through**」→ Hook 由 fail-open 可切换为 fail-closed（对比千问办公 Hooks 只有 fail-open）。
  - v2.1.292（2026-10-06）：「Security: Fixed PreToolUse hook approvals and auto mode bypassing the permission prompt for file reads from network (UNC) paths」；「Fixed `rm -rf` on the 8.3 short name or another alternate Windows spelling of the home folder……not being treated as removing it」。
  - v2.1.290（2026-10-05）：「Added a /status and doctor warning when managed settings ignore user-configured sandbox allowRead paths or allowed domains」。
  - v2.1.289（2026-10-03）：修复复合命令中嵌套 deny/ask 规则在受管机器上被用户 mod 的批准覆盖；修复沙箱 auto-allow 下带环境变量前缀的命令漏过 deny/ask 规则。
  - v2.1.286（2026-09-30）：「Fixed Remote Control sessions……staying connected after your organization's policy turns Remote Control off」。
  - v2.1.285（2026-09-29）：「Added `allowedProviders` managed setting to limit which API providers a machine may use」。
  - v2.1.281（2026-09-23）：Claude apps gateway 支持 Desktop 策略键「`blockReadsOutsideWorkingDirectories` and `disableBypassPermissionsMode`」。

### 4.3 Claude Cowork：本机 VM 与 10 月起的「默认云端」
- **10-02 之后最大变化**：架构页原文「**Cowork sessions run in the cloud by default**」；本机执行「remains for existing desktop deployments」，**Pro/Max 仅限「before October 6, 2026」在设备上发起的任务**；Team 版 Cowork 在 web 与移动端为 beta；Enterprise 需 owner 开启；组织设置里云会话有独立开关，可关闭云会话而保留本机桌面 Cowork。【一手】Claude Cowork architecture overview https://support.claude.com/en/articles/14479288-claude-cowork-architecture-overview （页面标「Updated this week」，经 WebFetch 2026-10-09）
- 本机 VM：「macOS uses Apple Virtualization.framework, and Windows uses Hyper-V」，VM「isolated from the host operating system by the platform's hypervisor」，「enforces its own network egress filtering」、syscall 限制、按会话用户隔离。云会话：每会话独立沙箱、默认不可达私网地址、Enterprise 默认无网络、「Connector authorization tokens never enter the sandbox」、云会话历史与文件「saved to the member's Claude account」、「isn't used to train Claude」。【一手】同上
- **Windows 前提**：Cowork 需要「the Virtual Machine Platform」（`Enable-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform -All`，重启生效）；「**For individual installations with full feature support including Claude Cowork, administrator privileges are required.** Users without admin access can still install Claude, but Cowork on desktop will not be available」；per-user MSIX 安装「can complete without registering the Cowork virtualization service」，建议 `Add-AppxProvisionedPackage` 整机预配；「Virtual machines and VDI environments without nested virtualization aren't supported」；报错示例「Missing HCS services: HNS, vmcompute, vfpext」。【一手】Deploy Claude Desktop for Windows https://support.claude.com/en/articles/12622703-deploy-claude-desktop-for-windows （更新 2026-07-13）
- **Windows 家庭版是否可用：官方页未明说**（上页未列版本）。二手：GitHub issue 多起报告 Home 版报「Virtualization is not available」，如 #31991、#27906（要求文档写明需 Pro/Enterprise），https://github.com/anthropics/claude-code/issues/31991 （2026 年上半年）；第三方博客认为官方要求的是 Virtual Machine Platform（Home 也有），结论相反。【二手】https://www.betterclaw.io/blog/claude-cowork-virtual-machine-platform-windows-home-fix （2026-07-28）→ 结论：**未查到官方定论**；可确定的是**需要管理员开启 VMP 与安装**。

### 4.4 OpenAI Codex：Windows 本机沙箱（三种实现）
- 原文：「Codex supports three Windows sandbox implementations」：
  - **`mxc`**（新，推荐）：「The recommended sandbox on compatible Windows devices where policy permits it. Uses process isolation **without administrator-approved setup, additional Windows accounts, changes to host file permissions, or local firewall rules**」。MXC = 「**Microsoft Execution Containers** (MXC) uses native Windows process isolation……Commands run under the user's Windows identity with a policy applied to each command……accepts readable, writable, and denied paths from the active permission profile. Its native network policy controls command network access」。限制：「validate……on the **Windows 11** device. A Windows version number alone doesn't establish compatibility」；显式选 mxc 失败时「doesn't fall back」；托管网络需 `allow_local_binding = true`（允许主机回环，代理的私网目的地检查被移除）；前台命令退出时残留子进程被终止。管理员可在 `requirements.toml` 用 `[windows] allow_mxc = false` 禁用。文中以「Codex CLI 0.162.0」为测试示例（rust-v0.162.0 发布于 **2026-10-08**）。
  - **`elevated`**（传统首选回退）：「Requires administrator-approved setup. Commands in the sandbox run without administrator privileges」；「uses dedicated lower-privilege sandbox users, filesystem permission boundaries, firewall rules, and local policy changes」；无本地管理员的员工可由 IT 预先执行 `codex sandbox setup --elevated --user 'DOMAIN\alice' ...` 预配。
  - **`unelevated`**（传统回退）：「runs commands with a **restricted Windows token** derived from your current user, applies **ACL-based filesystem boundaries**, and uses environment-level offline controls instead of the dedicated offline-user firewall rule. It provides **weaker network isolation** than `elevated` and doesn't support denied read paths」。
  - 企业可用 `allowed_sandbox_implementations = ["elevated"]` 禁止回退到 unelevated。【一手】https://developers.openai.com/codex/windows （抓 .md 2026-10-09，页面无日期）
- 仓库：`codex-rs/windows-sandbox-rs/`（含 `codex-windows-sandbox-setup.manifest`、`sandbox_smoketests.py`）。【一手】https://github.com/openai/codex/tree/main/codex-rs/windows-sandbox-rs
- 近期 Windows 沙箱修复：rust-v0.162.0（2026-10-08）「Restore ordinary drive-letter file access on Windows 10 and match Windows sandbox temp permissions to the child process environment」；rust-v0.161.0（2026-10-07）「sandboxed PowerShell preserves relative paths beneath protected user profiles」。【一手】https://github.com/openai/codex/releases
- AppContainer：Codex 文档**未提**使用 AppContainer/LPAC（MXC 与 AppContainer 的关系：**未查到**）。

### 4.5 Codex sandbox 模式与审批策略
- 「By default, the agent runs with network access turned off. Locally, Codex uses an OS-enforced sandbox……plus an approval policy」；「Codex and ChatGPT Work **no longer support `approval_policy = "untrusted"`**」，交互只读建议 `sandbox_mode = "read-only"` + `approval_policy = "on-request"`；Auto 预设 `--sandbox workspace-write --ask-for-approval on-request`：工作目录内读、改、执行自动，「asks for approval to edit files outside the workspace or to run commands that require network access」；默认 `workspace-write`「keeps network access turned off unless you enable it」（`sandbox_workspace_write.network_access`）。【一手】https://developers.openai.com/codex/sandbox （= agent-approvals-security，抓 .md 2026-10-09）
- 云/本机策略分层：「Local computer access with Work Cloud has separate local and cloud execution policies: Cloud execution: Work cloud containers use existing Work Cloud policies. Local execution: ……MDM and legacy managed-device requirements take precedence over Agent Security, which takes precedence over the device's system requirements file」；「Work cloud containers and **dots cloud computers** use their own execution configuration」；「Moving between desktop, web, and mobile does not grant access to another computer」。文档已把原 Codex Cloud 标为「**Codex Cloud (Legacy)**」，另有「Current Codex Cloud」。【一手】同上 → OpenAI 云端执行默认值的具体变化日期：**未查到**；仅能确认文档在 10-09 抓取时出现「Legacy / Current Codex Cloud」「dots cloud computers」新口径（10-02 R2 未记录此口径）。

## Q5 Windows 普通用户上为「Agent 执行 Python/Shell」做进程级隔离

### 5.1 AppContainer 与 LPAC
- 微软定义的 AppContainer 六类隔离：Credential / Device / **File**（「Read-write access can be granted to specific persistent files and registry keys. Read-only access is less restricted」）/ **Network**（「Isolating the application from network resources beyond those specifically allocated……Granular access can be granted for Internet access, Intranet access, and acting as a server」）/ Process / Window。【一手】AppContainer isolation https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation （更新 2025-07-10）→ 网络以 capability（internetClient、privateNetworkClientServer 等）整体放行/禁止，**不提供按域名白名单**；按域名放行需另做本机代理（与 Claude Code / Codex 的代理模式同）。此为推断。
- LPAC（Chromium 文档）：「available on later versions of Windows 10 (RS2 and greater)……runs at a lower privilege level than normal App Container, with access granted by default to only those kernel, filesystem and registry objects marked with the `ALL RESTRICTED APPLICATION PACKAGES` or a specific package SID」；可加命名 capability（`lpacCom`、`registryRead`、`lpacWebPlatform`、`lpacClipboard` 等）；「all locations in the filesystem and registry that the LPAC process will access during its lifetime need to have the right ACLs on them……This is typically done by the installer」。【一手】Chromium Sandbox design doc https://chromium.googlesource.com/chromium/src/+/main/docs/design/sandbox.md （最近提交 2025-05-05）→ 给 Python 解释器、工作区目录预置 ACL 是 LPAC 方案的主要工程量；**未查到**以 AppContainer/LPAC 包装通用 Python/Shell 的 Agent 开源实现。

### 5.2 受限令牌 + Job Object + 桌面对象 + 完整性级别（Chromium 模式）
- Chromium：「The Windows sandbox is a user-mode only sandbox. There are no special kernel mode drivers, and **the user does not need to be an administrator** in order for the sandbox to operate correctly」；核心依赖「A restricted token / The Windows job object / The Windows desktop object / Integrity levels」；broker（特权进程）+ target（受限进程）架构，被策略允许的调用经 IPC 由 broker 代执行。【一手】Chromium sandbox.md（同上）
- Job Object 可做的全局限制（Chromium 列举）：禁止 `SystemParametersInfo()` 系统级改动、禁止创建/切换桌面、禁止剪贴板读写、禁止全局钩子 `SetWindowsHookEx()`、禁止访问 Job 外的 USER 句柄等。【一手】同上
- 微软：「A job object allows groups of processes to be managed as a unit」；设 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 时关闭最后一个句柄会终止全部关联进程；Windows 8 起支持嵌套 Job。【一手】https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects （更新 2025-07-16）→ 适合做「Agent 子进程树一键回收 + CPU/内存上限」，本身不做文件/网络隔离。
- Codex `unelevated` 即「restricted token + ACL 文件边界 + 环境级离线控制」，官方承认「weaker network isolation」且不支持拒绝读路径（见 4.4）——这是**无管理员前提下的已知生产实现**。

### 5.3 需管理员的方案
- Codex `elevated`：需「administrator-approved setup」，创建专用低权限沙箱用户 + 防火墙规则 + 本地策略（见 4.4）。
- **Windows Sandbox**：「hypervisor-based virtualization」的一次性 VM，关闭即丢弃；「included in the supported Windows editions like Pro, Enterprise, and Education」；「**Windows Sandbox is currently not supported on Windows Home edition**」。【一手】https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/ （页面「Last updated on 2026-03-29」）
- **WSL2**：「You must be running Windows 10 version 2004 and higher (Build 19041 and higher) or Windows 11」；安装需「Open PowerShell in **administrator mode**……enter the `wsl --install` command, then restart」；手动需开启 `VirtualMachinePlatform` 可选组件。【一手】https://learn.microsoft.com/en-us/windows/wsl/install （更新 2026-06-02）→ 首次启用需管理员 + 重启；家庭版可用性官方页未单列（未查到限制表述）。
- **Hyper-V / VMP（Cowork 路线）**：需管理员开启 Virtual Machine Platform；无管理员「Cowork on desktop will not be available」；无嵌套虚拟化的 VDI 不支持（见 4.3）。
- **MXC（Microsoft Execution Containers）**：Codex 称**无需管理员**、无需额外账户与防火墙规则，但需在 Windows 11 上验证能力（见 4.4）。微软侧 MXC 的官方文档：**未查到**（本轮未检索到 learn.microsoft.com 页面）。

### 5.4 嵌入式（便携）Python 随应用分发
- 官方 embeddable package：「The embedded distribution is a ZIP file containing a minimal Python environment. It is intended for acting as part of another application, rather than being directly accessed by end-users」；「When extracted, the embedded distribution is (almost) fully isolated from the user's system, including environment variables, system registry settings, and installed packages」；含 `python.exe`、`pythonw.exe`、预编译标准库 ZIP；**不含** Tcl/tk、pip；带默认 `._pth` 文件限制搜索路径；「Third-party packages should be installed by the application installer alongside the embedded distribution……treated as part of the application ("vendoring")」；推荐用 `py install 3.14-embed --target=<directory>` 获取。【一手】https://docs.python.org/3/using/windows.html §4.2（抓取 2026-10-09）
- → 「便携 Python」解决的是**环境隔离**（不污染/不依赖用户系统 Python），**不是安全隔离**；仍需叠加 5.1/5.2 的进程沙箱。

## Q6 字节（豆包工作 / 扣子 / 飞书 aily）与钉钉悟空：一手文档补充

> 本轮只补到飞书官网（字节一手）若干页；豆包、扣子、钉钉的帮助中心原始页**未检索到**。

### 6.1 豆包工作
- 【一手，飞书官网文章】（2026-08-24）：「任务在云端持续运行，不因设备切换而中断」；PC 客户端「在用户授权范围内调用浏览器和电脑界面」；「涉及删除、发布、付款、发送消息或修改关键数据等操作时，用户应在执行前确认目标和范围」；手机「对于需要操作网页或电脑界面的任务，也可以在授权范围内通过手机继续查看和控制」，同时称「当前没有独立移动端」；「员工访问企业知识和工具时，严格继承原有权限，不能通过 AI 绕过组织授权边界」；「豆包工作团队/企业版与个人版数据隔离，**企业私有数据不用于模型训练**」；入口「由企业管理员控制可用范围」；「管理员可以统一开通成员、分配额度，并按个人、用户组或部门管理用量」；「通过水印、行为审计等能力，企业可以追踪使用情况」；定时任务「产物……自动存入云盘或飞书云文档」。https://www.feishu.cn/content/article/7677519271848610746 （2026-08-24）
- 【二手】「本地电脑 / 云电脑」两种运行方式；Windows 端「在独立虚拟桌面中操作电脑」；Windows 需下载最新「豆包电脑版」并「在工作任务模式中根据系统提示完成授权和初始化」；需授予「辅助功能、录屏与系统录音」；手机「同一账号授权后……由已连接的电脑端读取本地文件、操作软件完成执行」。来源：东方财富转载 https://finance.eastmoney.com/a/202608213849216149.html （2026-08-21）、新浪财经 https://finance.sina.cn/2026-08-21/detail-inipaens1380641.d.html （2026-08-21）
- 运行权限档位、本机沙箱技术、遥控链路是否经字节云中转：**未查到**一手说明。

### 6.2 扣子（Coze）
- 本轮**未补到**一手文档（R1 的「云电脑 / 云手机」「桌面端读写本地文件、执行 Python/Git」均为二手）。

### 6.3 飞书 aily（飞书官网帮助页，一手）
- 企业管理后台：「可以进行企业模型接入管理、查看/操作企业安全与合规相关功能、查看企业整体应用使用数据、额度用量等」；管理员自动包含「飞书超级管理员；飞书中有『全部应用管理权限』的管理员」。https://www.feishu.cn/content/ehksl0lb （页面日期未取到）
- 应用创建范围「支持『内部所有用户』和『内部部分用户』，默认选项为『内部所有用户』」。https://www.feishu.cn/content/zjw134op
- 终端用户「使用 Aily 的前提是用户在应用的可用范围内、且用户已分配了对应的角色权限」；记录级权限可「读取用户属性中的某一属性字段的值」做动态行级控制。https://www.feishu.cn/content/u6ojuobh
- （以上经 WebSearch 摘要转述，未逐页 WebFetch，原文措辞以页面为准。）aily 是否有本机执行：**未查到**；属云端 Agent 平台。

### 6.4 钉钉悟空 / 悟空云电脑
- 一手帮助文档：**未查到**。二手：「继承企业权限规则，具备专属安全沙箱」（IT之家 https://www.ithome.com/0/929/762.htm ，2026-03）；「管理员可精确控制谁能用悟空、能用哪些AI技能、能访问哪些数据」「在群聊场景中，悟空的权限取『用户权限』和『提问人权限』的交集」（每日经济新闻 https://www.nbd.com.cn/articles/2026-03-17/4296467.html ，2026-03-17）；「本地执行 + 远程可控」（爱范儿 https://www.ifanr.com/1658400 ，2026-03）。注意悟空已并入千问办公（R1）。

---

## 汇总表 ①：各产品权限设定与执行位置

| 产品 | 本机权限档位与确认清单 | 管理员能否锁定 | 本机沙箱技术（Win / mac） | 云端执行能访问什么 | 遥控 / IM 链路 | 会话存放 |
|---|---|---|---|---|---|---|
| 腾讯 WorkBuddy | 默认 / 完全访问；默认档确认：工作空间外写改、删除、执行脚本/命令/外部程序、敏感能力；取消即不执行；FAQ 称 allow/ask/deny（桌面端语法未公开） | 桌面端**未查到**；同门 CodeBuddy Code 有 managed settings / `disableBypassPermissionsMode` | Win：**未查到**；mac：**未查到**（CodeBuddy Code：mac Seatbelt、Linux bubblewrap、Windows「planned」） | WMA：1 Session:1 沙箱、出访公网/VPC 可配、敏感产出物云端驻留；10 月进企业管理端（截至 10-09 未见公告） | IM 助理（微信/企微/QQ/钉钉/飞书），固定「助理专属文件夹」、单会话不可清空、需电脑开机；手机「连接电脑」是否经腾讯云中转**未查到** | 本机 `C:/Users/<用户>/WorkBuddy` 按日期目录；会话标题/置顶/顺序端云同步；企业「AI 安全审计」持续监测会话日志并回放 |
| 千问办公 | 无整体分档页；1.2.0 新增「自动审批模式」+「安全中心」；电脑操控「每次询问（默认）/ 自动执行」 | 企业 Hooks（PreToolUse 可 deny/ask）；**fail-open**（非 2xx、超时、连不上均放行） | Win：「安全工作环境」= 下载镜像跑「Windows VM 服务」（hypervisor 类型**未查到**）；mac：**未查到** | Web 端：个人网盘、连接器、云端定时任务；浏览器自动化与本地文件**仅客户端** | 钉钉/飞书/微信频道，开放 / 配对模式 | Web 与桌面会话**相互独立不同步**；数据存中国大陆云；AI 日志 90 天（轮次 + 资源调用） |
| Kimi Work | 默认 / 手动允许 / 全部；默认档确认「修改、覆盖本地文件或运行代码等」；「全部」用户自担风险 | **未查到**（Kimi Business 管理员仅席位/成员/订单） | **未查到** | Kimi（网页）定时任务在云端；Kimi Work 定时任务本地、不补跑 | 手机远程控制（3.2.5 起）：可预览 Office/html、上传附件；链路**未查到** | **未查到** |
| Claude Code | default / acceptEdits / plan / auto / dontAsk / bypassPermissions；**终端默认起始模式 = auto（v2.1.283，2026-09-25）** | 能：managed settings 锁 `disableBypassPermissionsMode`、`disableAutoMode`、`allowManagedPermissionRulesOnly`、沙箱 `enabled`/`failIfUnavailable`；Hook `onFailure:"block"`（2026-10-08） | Win 原生：**不沙箱**（需 WSL2）；mac：Seatbelt；Linux/WSL2：bubblewrap + 网络命名空间 + 本机代理 | 云会话：独立容器；端点 managed settings 到不了云会话（R2） | Remote Control（组织策略可关，2.1.286 起关后即断） | 本机会话存放本轮**未核**；云会话存 Claude 账户 |
| Claude Cowork | 同 Claude 权限体系；Desktop 策略键 `blockReadsOutsideWorkingDirectories` 等 | 能（组织设置开关；云会话独立开关） | Win：Hyper-V（需管理员开 VMP；无管理员则桌面 Cowork 不可用；Home 版官方未明说）；mac：Apple Virtualization.framework | **默认云端执行**；Pro/Max 本机仅限 2026-10-06 前发起的任务；云沙箱默认不可达私网，Enterprise 默认无网络，连接器令牌不进沙箱 | 手机加入 Cowork 云会话 | 云会话存 Claude 账户；本机会话存放**未查到**（R2：管理员无法集中删除） |
| OpenAI Codex / ChatGPT Work | sandbox：read-only / workspace-write / danger-full-access；审批：on-request / never（`untrusted` 已退役）；Auto = workspace-write + on-request | 能：`requirements.toml`（`allow_mxc`、`allowed_sandbox_implementations`）；MDM > Agent Security > 系统 requirements | Win：**mxc**（无需管理员，Win11 需验证）/ **elevated**（需管理员预配，低权限沙箱用户 + 防火墙）/ **unelevated**（受限令牌 + ACL，网络弱）；mac：Seatbelt（R2） | Work Cloud 容器、「dots cloud computers」各有执行配置；「Codex Cloud (Legacy)」与「Current Codex Cloud」 | 桌面/web/移动切换「does not grant access to another computer」 | **未查到**（本轮） |
| 豆包工作 | 删除/发布/付款/发消息/改关键数据前「用户应在执行前确认」（一手）；Windows 独立虚拟桌面（二手） | 管理员控制入口可用范围、额度、水印、行为审计（一手） | **未查到** | 云电脑常驻、产物存云盘/飞书云文档 | 手机授权范围内查看与控制（一手）；链路**未查到** | **未查到** |
| 飞书 aily / 钉钉悟空 | aily：可用范围 + 角色权限 + 行级权限（一手）；悟空：二手 | aily：能（管理后台）；悟空：二手称能 | aily 无本机；悟空：二手称「专属安全沙箱」 | aily 云端；悟空云电脑 7×24（二手） | 群聊权限取交集（悟空，二手） | **未查到** |

## 汇总表 ②：Windows 本机隔离方案

| 方案 | 是否需管理员 | 文件隔离 | 网络隔离 | 已知实现 | 风险 / 限制 |
|---|---|---|---|---|---|
| 受限令牌 + ACL（+ 环境级离线） | 否 | 有（ACL 写边界；不支持拒绝读路径） | 弱（环境变量/代理级，无防火墙） | Codex `unelevated` | 官方定位「legacy fallback」「weaker network isolation」；读取不受限 → 卷宗可被读 |
| 专用低权限用户 + 防火墙 + 本地策略 | **是**（一次性预配，可由 IT 代做） | 有（文件权限边界） | 有（离线用户防火墙规则） | Codex `elevated` | 需 IT 介入；改变主机 ACL 与账户 |
| MXC（Microsoft Execution Containers） | 否（据 Codex 文档） | 有（读/写/拒绝路径） | 有（原生网络策略；托管网络需允许回环） | Codex `mxc`（0.162.0，2026-10-08） | 需 Windows 11 且逐机验证能力；不回退；微软一手文档**未查到** |
| AppContainer / LPAC | 否（创建容器配置文件无需管理员——**未查到**明文，Chromium 称其沙箱整体无需管理员） | 有（LPAC 默认几乎无访问，需为解释器与工作区预置 ACL） | 有（capability 级：Internet / 内网 / 服务端），无域名粒度 | Chromium 渲染/工具进程 | 通用 Python/Shell 在 LPAC 下兼容性差（大量路径需 ACL）；**未查到** Agent 场景开源实现 |
| Job Object | 否 | 无 | 无 | Chromium、Codex（终止子进程树） | 只做资源上限与进程树回收，须与其他方案叠加 |
| Windows Sandbox | 开启可选功能需管理员（官方页未明说，**待核**） | 强（一次性 VM） | 可配置 | 微软内置 | **家庭版不支持**；Pro/Enterprise/Education；需硬件虚拟化 |
| WSL2 + bubblewrap | **是**（`wsl --install` 需管理员 + 重启） | 强（Linux 命名空间） | 强（网络命名空间 + 代理） | Claude Code（Windows 唯一沙箱路径） | Win10 2004+/Win11；律师需在 Linux 环境处理 Windows 文件，体验与路径映射成本高 |
| Hyper-V / Virtual Machine Platform 专用 VM | **是**（开启 VMP、整机预配 MSIX） | 强 | 强（VM 内出口过滤） | Claude Cowork、千问办公「安全工作环境」（「Windows VM 服务」） | 无管理员不可用；VDI 需嵌套虚拟化；Home 版可用性官方未定论；镜像占盘（Cowork 二手称约 20 GB） |
| 嵌入式 Python（embeddable zip） | 否 | 否（只做环境隔离） | 否 | python.org 官方分发 | 不含 pip；需 vendoring 第三方包；**不是安全边界** |

## 本轮未查到清单
1. WorkBuddy：Windows / macOS 本机沙箱具体技术；手机「连接电脑」是否经腾讯云中转；远程任务的确认在哪端处理；管理员能否锁定「完全访问」；AI 安全审计采集字段、存放位置与保留期；WMA 进入企业管理端的正式公告（截至 10-09 文档仍写「预计10月份」）。
2. 千问办公：「安全工作环境」在 Windows 用哪种 hypervisor、是否需管理员、家庭版是否可用；macOS 实现；「自动审批模式」判定规则；任何「不用于训练」承诺；10-02 后新版本。
3. Kimi Work：「默认」档逐项确认清单；企业锁定档位；本机沙箱技术；远程控制链路与工作目录限制；10-02 后新版本。
4. Claude Cowork：Windows 家庭版的官方定论；本机会话历史存放位置（本轮）。
5. OpenAI：MXC 的微软一手文档；云端执行默认值变化的具体日期；Codex 会话存放（本轮未查）。
6. Windows：AppContainer/LPAC 包装通用 Python/Shell 的 Agent 开源实现；Windows Sandbox 开启是否需管理员的官方明文。
7. 豆包工作 / 扣子 / 钉钉悟空的帮助中心原始页；飞书 aily 页面的发布/更新日期。
