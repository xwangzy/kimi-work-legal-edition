/**
 * 能力账本（v9 第 04 篇 §2：“完整接入 Kimi Code”的可验收定义；`GET /runtime/capabilities` 的数据源）。
 *
 * 每行给出方案的目标状态与**本设备当前状态**（按运行事实计算，不按勾选数平均）；当前状态不得高于事实：
 * 执行域不可用时代码执行是“关闭”，闸门未接入时联网检索是“待实现”，唯一出口的强度写“应用层约束”而不是“系统强制”。
 */

export type CapabilityStatus =
  /** 原生接通：上游能力原样可用。 */
  | "native"
  /** 适配替代：经我方服务补位。 */
  | "adapted"
  /** 政策限制：可用但受策略约束（允许与拒绝两条路径都测）。 */
  | "policy_limited"
  /** 待实现。 */
  | "pending"
  /** 不在已购权益。 */
  | "not_entitled"
  /** 本设备关闭（方案要求关闭，或前置条件不满足时失败关闭）。 */
  | "disabled";

export interface CapabilityRow {
  family: string;
  entity: string;
  access: string;
  target: CapabilityStatus;
  current: CapabilityStatus;
  stage: "G0" | "G1" | "G2" | "—";
  /** 验收证据（方案原文要点）。 */
  evidence: string;
  /** 当前状态的如实说明（尤其是低于目标时）。 */
  note?: string | undefined;
  /**
   * 证据测试（审查 S2-07）：当前状态为 native / policy_limited / adapted 时，必须列出至少一个已存在的验收测试名（关键字）；
   * 没有证据的行只能是 pending（或 disabled / not_entitled）。
   */
  evidenceTests?: readonly string[] | undefined;
}

export interface DeviceFacts {
  /** 当前执行域（W-core / W-data / N / none）。 */
  execDomain: "W-core" | "W-data" | "N" | "none";
  execDomainLabel: string;
  /** 执行域不可用或部分事项不可用的原因（设备页如实显示：审查 S3-08）。 */
  execDomainError?: string | null;
  /** Grep/Glob 的检索入口是否已登记（宿主内检索；审计 S3 第 2 步起不再使用原生 ripgrep）。 */
  hostSearch: boolean;
  /** 出站闸门：未接入 / 应用层约束 / 系统强制。 */
  egress: "unavailable" | "app_level" | "os_enforced";
  /** 闸门 /search 是否已配置（开放平台检索补位）。 */
  searchConfigured: boolean;
  /** 闸门 /fetch 是否已配置（托管抓取；ZP-11 删除了本机直连回落）。 */
  fetchConfigured: boolean;
  /** 法律 MCP 是否已接通。 */
  legalMcp: boolean;
  /** 会话、文件历史、工作区与材料快照是否加密落盘（ZP-9 第 1、2 步）。 */
  encryptedStorage: boolean;
}

export function capabilityLedger(f: DeviceFacts): CapabilityRow[] {
  const exec = f.execDomain !== "none";
  const egressNote =
    f.egress === "os_enforced" ? "唯一出口：系统强制" : f.egress === "app_level" ? "唯一出口：应用层约束（非系统强制）" : "出站闸门未接入：模型请求只到本机模型代理";
  const E2E = "端到端：嵌入引擎经种子与宿主出口跑通一个回合";
  const TOOLS = "P1 裁决来源";
  return [
    {
      family: "模型流式输出、工具调用、用量",
      entity: "provider（OpenAI 兼容）",
      access: "base_url → 出站闸门 /v1（令牌化、去向记录）→ 法律模型网关 → 月之暗面企业账户（MaaS 只收用量）；宿主按会话换上任务令牌",
      target: "native",
      current: f.egress === "unavailable" ? "pending" : "native",
      stage: "G0",
      evidence: "多轮、流中断、错误码、length 截断、usage 缺失均有明确终态；reasoning_content 原样回传",
      note: `${egressNote}；流中断、截断与缺失结束原因的终态裁定见内核测试（N-01、F1/R-03）`,
      evidenceTests: [E2E, TOOLS],
    },
    {
      family: "会话、续接、分叉、导出",
      entity: "kap-server sessions",
      access: "业务 API 映射",
      target: "native",
      current: "pending",
      stage: "G0",
      evidence: "断电后续接；跨事项不串",
      note: `会话创建与子会话可用；追问（同一会话继续）已经业务 API 开放；重启后续接、分叉与导出尚未开放；${f.encryptedStorage ? "会话、事件日志、引擎状态区、工作区草稿与材料快照加密落盘（ZP-9 第 1、2 步，按事项工作区密钥；材料快照运行结束即删除）；文件名、目录结构、文件数量、精确明文长度（分块格式可由盘上长度算出；追加日志可见每条记录的长度与条数）与时间不加密" : "会话与工作区未加密（开发形态未下发事项工作区密钥）"}`,
    },
    { family: "上下文压缩", entity: "引擎 compaction", access: "原生；法律事实账本独立于聊天摘要", target: "native", current: "pending", stage: "G1", evidence: "压缩后不丢限制、引用与不确定性", note: "引擎自动压缩未经验收" },
    {
      family: "计划模式",
      entity: "EnterPlanMode/ExitPlanMode",
      access: "原生 + 先出计划开关；计划确认走业务审批卡（自动档未开先出计划时宿主代批）",
      target: "native",
      current: "native",
      stage: "G0",
      evidence: "计划审批走业务审批卡",
      evidenceTests: [TOOLS, "先出计划"],
    },
    { family: "待办", entity: "TodoList", access: "原生，映射任务步骤", target: "native", current: "pending", stage: "G0", evidence: "与任务状态一致", note: "工具可用；与业务任务步骤的映射未实现" },
    {
      family: "提问",
      entity: "AskUserQuestion（kap-server 持久问题队列）",
      access: "业务 API；App 可跨端作答",
      target: "native",
      current: "pending",
      stage: "G0",
      evidence: "答复、超时、关闭、恢复后不丢问题；不伪造答复",
      note: "答复与乐观并发可用（P1 提问）；引擎问题队列是进程级内存，重启后不丢问题须由内核任务记录承担，未接入",
    },
    {
      family: "进度通知",
      entity: "NotifyUser（实验特性）",
      access: "锁定开启",
      target: "policy_limited",
      current: "pending",
      stage: "G1",
      evidence: "只展示、不授权",
      note: "实验开关已锁定开启；上游另需宿主声明界面能力（uiCapabilities）才注册该工具，随 G1 业务界面接入",
    },
    {
      family: "文件读取与搜索",
      entity: "Read、Glob、Grep",
      access: "事项三区文件系统（broker）；Glob/Grep 由宿主内检索完成（经 broker 遍历与解封，输出与 ripgrep 一致；参数受限，cwd 与路径逐级校验在工具可寻址区内；不拉起原生进程）",
      target: "policy_limited",
      current: f.hostSearch ? "policy_limited" : "disabled",
      stage: "G0",
      evidence: "非授权材料与其他事项不可读；符号链接/重解析点/UNC/长路径/TOCTOU 全拒；Glob 与 Grep 全部参数组合回归",
      note: f.hostSearch
        ? "macOS 已验证（与原生 ripgrep 15 差分一致，含加密工作区；正则差异：字符类内的 \\W \\S 与 \\b 为 ASCII 语义）；Windows 重解析点、UNC、长路径随 Windows 探针复测"
        : "检索入口未登记：Glob/Grep 不可用（Read 可用）",
      evidenceTests: ["检索参数检查", "加密语料：经文件 broker 解封的宿主检索输出与明文语料完全一致", "差分：Grep 的上游参数组合", "差分：Glob 的上游参数形状", "S2-06", TOOLS],
    },
    {
      family: "文件写入",
      entity: "Write、Edit",
      access: "只写工作区；原件区只读；交付区只由人发布",
      target: "policy_limited",
      current: "policy_limited",
      stage: "G0",
      evidence: "改原件与写交付区被拒；文件历史可回滚",
      note: "写入限工作区已验证；文件历史回滚随 G1 开放",
      evidenceTests: [TOOLS, "S2-04"],
    },
    { family: "图像/视频", entity: "ReadMediaFile", access: "默认改走本机 OCR；直送为跨边界动作", target: "policy_limited", current: "pending", stage: "G1", evidence: "L2 确认、L3 拦截；闸门识别图像载荷" },
    {
      family: "Shell 与代码执行",
      entity: "Bash（IHostProcessService.spawn(shellPath,['-c',cmd])）",
      access: "执行域路由：默认 W-core；W-data 默认只在 N 内",
      target: "adapted",
      current: exec ? "pending" : "disabled",
      stage: "G0",
      evidence: "20 类律师典型数据任务通过；路径命名空间一致；逃逸、联网、资源红队零越界",
      note: exec
        ? `执行域：${f.execDomainLabel}${f.execDomainError ? `；${f.execDomainError}` : ""}。设备自检含一次真实 worker 往返（含一个加密挂载）。` +
          (f.encryptedStorage
            ? "工作区与材料快照加密时，执行域读层在 W 进程内存中持有本事项工作区与材料两把区密钥（不含引擎状态与事件日志的密钥）；解释器逃逸者本就可经读权限与读层读到这两区明文，W 无网络。"
            : "") +
          "P2 自动化用例在本机通过" +
          "（Bash 经 DI 进入 W-core、单一路径命名空间、23 类数据任务、112 例红队（明文与加密挂载各一遍）；阶段 3 审查与两轮复核的回归：提交的写入临界区、写入与删除的比较—替换" +
          "（删除一律要求基线为文件）、别名、类型变化先于删除且不覆盖地回滚、执行域上限（含内存层与文件系统容量）的结构化识别与不写回、" +
          "时限按自身计时判定、退出码 75、取消纪元与一事项一运行、硬时限、执行域不可用后退避自愈），P2 本机通过；" +
          "Windows 10/11 × 杀软兼容、随包纯 Python 包（openpyxl 等，待下载授权）、W-data 在 N 域内拦截待验收——P2 正式验收前标待实现"
        : `未隔离：不运行代码（只运行可信工具）。原因：${f.execDomainError ?? "执行域未就绪"}。不在执行域之外运行模型生成的代码`,
      evidenceTests: [
        "Bash：执行域未就绪时拒绝",
        "端到端：Bash 在 W 内跑标准库数据任务",
        "工厂失败 → Bash 对模型不可见",
        "自检：权限模型生效",
        "工作区快照提交：运行期间文件被改",
        "用例总数 ≥ 100",
        "S3-03 两条命令同时结束并修改同一已有文件",
        "S3-04 命令运行期间律师把别的文件改名到 W 新建的路径",
        "S3-24 W 删除的目录在写回时被换成同名文件",
        "S3-25/E5 文件换目录 + 移入新目录",
        "N3 python3 写出超过内存层上限",
        "S3-27 命令自身返回 124",
        "S3-28 执行域运行中不可用 → 宿主策略拒绝 Bash",
        "S3-31 目录换文件：落位与冲突副本都失败时",
      ],
    },
    {
      family: "后台任务",
      entity: "TaskList、TaskOutput、TaskStop、WaitFor",
      access: "原生；TaskStop 须确认",
      target: "native",
      current: "pending",
      stage: "G1",
      evidence: "取消传播到执行域；在途费用可解释",
      note:
        "工具可用、TaskStop 须确认（P1）；前台超时转后台与取消传播到执行域已有用例（P2）。停止语义：取消运行时，排队中与执行中的命令强杀、" +
        "本次改动不写回；已执行完、正在写回的命令照常写回（与“进程已退出、文件已在盘上”一致）。TaskStop 先 SIGTERM（协作停止于语句边界，" +
        "已执行部分照常写回，退出码 143），5 秒内未停则强杀、改动不写回（偏离登记 D-10）。任务输出文件对模型只读放行与费用解释随 G1",
      evidenceTests: ["前台超时转后台", "取消传播到执行域", "S3-07 取消落在基线采集窗口", "S3-10 强制终止（SIGKILL）"],
    },
    { family: "用户直接执行 shell", entity: "agent/shellCommand", access: "进入执行域（同 Bash）或关闭", target: "policy_limited", current: "disabled", stage: "G1", evidence: "不在执行域外运行", note: "业务 API 不提供直接 shell 入口" },
    { family: "撤销（undo）", entity: "引擎 undo", access: "映射为业务版本回滚", target: "native", current: "pending", stage: "G1", evidence: "不回滚权限、法源有效性与已外发事实" },
    {
      family: "工作区指令",
      entity: "workspaceInstructionsService",
      access: "只从签名方法包与只读可信配置区加载（ZP-18）",
      target: "policy_limited",
      current: "policy_limited",
      stage: "G0",
      evidence: "写入 /work/AGENTS.md 后新会话不加载",
      evidenceTests: ["P1 ZP-18"],
    },
    {
      family: "子 Agent",
      entity: "Agent（coder profile）",
      access: "原生；secondary_model.force；权限继承且只能更窄",
      target: "policy_limited",
      current: "pending",
      stage: "G0",
      evidence: "不能自批、不能跨事项；取消传播；子 Agent 模型来源可审计",
      note: "子 Agent 的每次调用由宿主策略裁决（P1）；取消传播与模型来源审计未验证",
    },
    { family: "Agent 集群", entity: "AgentSwarm", access: "并发上限 3；预算预占", target: "policy_limited", current: "pending", stage: "G1", evidence: "并发与总预算不超；超额暂停并说明" },
    {
      family: "目标模式",
      entity: "Goal 系列",
      access: "必须设预算与时限",
      target: "policy_limited",
      current: "disabled",
      stage: "G1",
      evidence: "超额前停止新调用；可解释恢复",
      note: "G0 宿主策略拒绝创建与修改目标（CreateGoal/SetGoalBudget/UpdateGoal）；GetGoal 可查",
      evidenceTests: [TOOLS],
    },
    {
      family: "文件历史与快照",
      entity: "kap-server fileHistory、snapshot",
      access: "业务 API 映射为 ArtifactVersion",
      target: "native",
      current: "pending",
      stage: "G1",
      evidence: "回滚不回滚权限、法源有效性与已外发事实",
      note: "变更清单与快照可读（P1）；回滚与 ArtifactVersion 映射随 G1",
    },
    {
      family: "技能",
      entity: "Skill、skillDirs",
      access: "签名方法包 + 律所批准技能 + 个人纯提示词技能",
      target: "policy_limited",
      current: "policy_limited",
      stage: "G0",
      evidence: "任务可写目录不能新增有效指令或插件",
      evidenceTests: ["P1 ZP-18"],
    },
    {
      family: "Agent profiles",
      entity: "agentFiles",
      access: "只加载签名 profile；项目级不加载（ZP-1）",
      target: "policy_limited",
      current: "policy_limited",
      stage: "G0",
      evidence: "投毒用例全拒",
      evidenceTests: ["P1 ZP-18"],
    },
    { family: "MCP", entity: "mcp.json", access: "只含法律 MCP、法源 MCP（经闸门）、律所批准 MCP；项目级不加载（ZP-2）", target: "policy_limited", current: f.legalMcp ? "policy_limited" : "pending", stage: "G1", evidence: "tenant/user/matter 三重范围；不直传长期密钥", note: "宿主侧按清单裁决已验证（P1 MCP）；工具令牌按运行授权未接入", evidenceTests: ["P1 MCP", "子 Agent 作用域"] },
    { family: "Hooks", entity: "上游 hooks（失败放行）", access: "不依赖；律所 Hooks 由宿主策略实现（失败即拒绝）", target: "adapted", current: "pending", stage: "G2", evidence: "高风险时点 Hook 不可达即拒绝" },
    { family: "插件市场", entity: "KIMI_CODE_PLUGIN_MARKETPLACE_URL", access: "指向中软/律所目录", target: "adapted", current: "disabled", stage: "G1", evidence: "只装签名包；版本锁定", note: "插件安装路由不可达（宿主路由白名单外）", evidenceTests: ["P1 路由"] },
    {
      family: "联网搜索",
      entity: "WebSearch（无配置不注册）",
      access: "闸门 /search → 中软检索服务 → /v1/tools/search(_pro)",
      target: "adapted",
      current: "pending",
      stage: "G0",
      evidence: "只有开放平台 token 时可用；查询去向可审计",
      note: f.searchConfigured
        ? "经出站闸门接入：宿主出口按工具调用 ID 与参数摘要对到宿主策略放行的那次调用；闸门去除标识符、含当事人实体的查询泛化或拒绝（G0 不受理确认，偏离 D-16）、" +
          "转发检索服务不带事项编号、查询原文只在本机事项账本——本机以检索服务 v0 + mock 上游验证；真实 /v1/tools/search(_pro) 与法律站点召回待中软组织测试额度（P4 验收前标待实现）"
        : "闸门检索补位未接入：WebSearch 未注册",
      evidenceTests: ["WebSearch 与 FetchURL 经出站闸门", "/search：一般性查询放行且不带事项编号"],
    },
    {
      family: "网页抓取",
      entity: "FetchURL（ZP-11：无本机直连回落）",
      access: "闸门 /fetch",
      target: "adapted",
      current: "pending",
      stage: "G0",
      evidence: "DNS 重绑定、重定向、私网、元数据地址、超大文件全拒",
      note: f.fetchConfigured
        ? "经出站闸门接入（本机直连抓取）：公开官方站点基线 + 律所白名单逐跳校验（新域名在 G0 一律拒绝，偏离 D-16）、URL 不得携带事项信息、SSRF 与 DNS 重绑定全拒、" +
          "结果标“不可信外部内容”、拒绝原因原样交给模型（ZP-11 补充）；真实站点抓取与渲染/Office 零外部请求待 P5 验收"
        : "闸门抓取未接入：FetchURL 未注册",
      evidenceTests: ["WebSearch 与 FetchURL 经出站闸门", "抓取（测试用：地址准入放行回环", "出网面：律师电脑各进程源码"],
    },
    { family: "数据源插件", entity: "kimi-datasource", access: "中软法源服务（MCP）", target: "adapted", current: "pending", stage: "G1", evidence: "不借用个人会员凭据" },
    { family: "定时", entity: "CronCreate/List/Delete", access: "本机内容任务；期限提醒走云端", target: "policy_limited", current: "disabled", stage: "G1", evidence: "错过提示补跑；创建须确认", note: "G0 宿主策略拒绝创建与删除定时任务（定时触发的回合落在运行之外）；CronList 可查", evidenceTests: [TOOLS] },
    { family: "终端", entity: "kap-server terminals", access: "关闭（IHostTerminalService 拒绝实现 + 路由不可达）", target: "disabled", current: "disabled", stage: "G0", evidence: "远程与界面均不可达", evidenceTests: ["P1 路由"] },
    { family: "远程控制", entity: "remote-control", access: "关闭；以中软设备中继 + 业务网关替代", target: "adapted", current: "disabled", stage: "G2", evidence: "中继抓包只见密文；只开白名单接口", evidenceTests: ["P1 路由"] },
    { family: "遥测", entity: "telemetry", access: "关闭", target: "disabled", current: "disabled", stage: "G0", evidence: "出网面扫描无上游遥测", evidenceTests: ["出网面"] },
    { family: "账号 OAuth", entity: "auth.kimi.com", access: "不使用；中软 IAM + 网关令牌", target: "adapted", current: "disabled", stage: "G0", evidence: "无 Kimi 账号可用全部承诺能力", evidenceTests: ["P1 路由", "ZP-21"] },
    { family: "WebBridge / Computer Use", entity: "外部二进制插件", access: "不提供", target: "not_entitled", current: "not_entitled", stage: "—", evidence: "二进制不随包分发" },
    { family: "Kimi 闭源云技能", entity: "PPT/建站/深度研究", access: "我方替代或不提供", target: "not_entitled", current: "not_entitled", stage: "—", evidence: "销售口径如实" },
  ];
}
