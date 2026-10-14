# 04 技术架构、Kimi Code 集成与研发计划

版本 9.1 · 2026-10-10（含对抗式审阅处置） · 技术证据：Kimi Code 锁版 `f67e6398f`（2.1.1）源码与文档；上游 main `419aced0e9`（10-09）；`调研-X2`（MXC、Codex Windows 沙箱、kap-server 路由与注入点、开放平台能力、云沙箱单价）；主审核验的 Vercel `just-bash` 3.6.0（Apache-2.0）、Pyodide 0.29.5 包清单、Node.js 权限模型。v5 第 4 篇中未被改写的部分（解析与 OCR、事项账本事件模型、文书引擎、Office 加载项、性能预算）继续有效。

---

## 1. 架构总图

### 1.1 律师电脑（进程视图）

```text
┌───────────────────────────────────────────────────────────────────────────────────────────┐
│ Electron 主进程（可信）：窗口、托盘、更新校验、设备密钥（TPM/DPAPI）、业务网关（界面与远程的唯一入口）│
│   │ IPC（结构化 schema，不透传路径/命令）                                                       │
│ 渲染进程（沙箱、contextIsolation、严格 CSP）：Kimi Work 版式界面；Agent 产物在无网隔离框架中预览    │
│   │                                                                                          │
│ 业务内核 utilityProcess：事项账本（SQLite 页级加密）· 材料库 · 解析/OCR · 确定性工作流 · 文书引擎    │
│   · 审批与签发 · 审计链 · 离线法规库 · 同步客户端（端到端加密）· 收件区 · 法律 MCP（命名管道）       │
│   │                                                                                          │
│ Agent 宿主 utilityProcess：业务运行时 API（start/resume/respond/approve/cancel/events）           │
│   · 宿主策略（ZP-4，每次工具调用都给出裁决）· kap-server 私有组件（无端口嵌入：inject/内存传输）   │
│   │   seeds：进程服务→执行域路由 · 文件系统→事项三区（令牌化视图）· 存储→加密 · 终端/遥控/OAuth→拒绝│
│   ├──▶ 执行域 W（随包 Node 26 进程，--permission，无网、无子进程）：W-core 模拟 bash + 零 JS 桥 Python│
│   │        └ W-data（Pyodide，pandas 等）：默认只在 N 内运行                                        │
│   ├──▶ 执行域 N（可选）：MXC 进程容器（@microsoft/mxc-sdk）或 IT 预配沙箱                          │
│   └──▶ 可信原生 ripgrep（Grep/Glob，参数受限，cwd 固定为事项工作区）                               │
│                                                                                              │
│ 出站闸门（独立签名进程，唯一出口）：/v1 /search /fetch /mcp/sources /mcp/firm/* + 控制面/中继/更新 │
│   令牌化（证件/账户/联系方式/自然人姓名）· 目的地类别 · 图像载荷 · URL/SSRF 检查 · 数据去向记录     │
│ Word COM / WPS 加载项 ──命名管道──▶ 业务内核（只绑定当前文档）                                      │
└───────────────────────────────────────────────────────────────────────────────────────────┘
          │ 出站 TLS（设备凭据 + 短期令牌）
中软云端（境内）
  控制面：iam · org · seats/points · devices · policy · notify · im-isv · scheduler · audit-ops · metering · dist · console
  能力网关：legal-gateway → 月之暗面企业账户（MaaS 只做用量结算）· search-service → /v1/tools/search(_pro) · fetch-proxy · sources · qa-service
  中继：share-relay（事项共享密文）· device-relay（手机 ⇄ 电脑端到端加密帧）
  〔G3〕cloud-matters（云端事项库）· exec-controller · cloud-workers（每任务隔离沙箱，同一引擎与内核制品）
```

### 1.2 六条不可退让的工程约束

1. **执行域外不运行模型生成的代码**：Bash 与代码执行只进执行域；律师确认不能代替隔离。
2. **宿主策略裁决每一次工具调用**：插入引擎策略链首位，清空上游默认放行；运行模式由宿主决定，界面与远程送来的模式参数在业务网关丢弃。
3. **出站闸门是唯一出口**：模型、检索、抓取、MCP、控制面、更新、中继全部指向闸门；执行域无网；渲染与 Office 打开 Agent 产物零外部请求。
4. **kap-server 不对外、不监听端口**：以无端口方式嵌入（Fastify `inject()` 或 klient 内存传输），只由 Agent 宿主访问；界面与远程只见业务 API；上游新增路由默认不可达；Agent 宿主不监听任何 TCP 端口。
5. **云端零明文持久化（本地事项）**：控制面、网关、检索、法源、中继的库、对象存储、日志、缓存、错误报告中不得出现客户内容、事项名、文件名与检索查询原文；CI 扫描 + 每版红队。
6. **一个业务语义，多处强制**：桌面、律所执行器、云端执行面运行同一业务内核与 Agent 宿主制品；每处独立校验权限，不信任别处送来的“已批准”。

## 2. 能力账本：“完整接入 Kimi Code”的可验收定义

状态字段：**原生接通**（上游能力原样可用）/ **适配替代**（经我方服务补位）/ **政策限制**（可用但受策略约束，允许与拒绝两条路径都测）/ **待实现** / **不在已购权益**。完整度不按勾选数平均；每一行都有验收证据。

| 能力族 | Kimi Code 实体 | v9 接入方式 | 状态目标 | 验收证据 | 阶段 |
|---|---|---|---|---|---|
| 模型流式输出、工具调用、用量 | provider（OpenAI/Anthropic 兼容） | `base_url` → 闸门 `/v1` → 网关 → MaaS | 原生接通 | 多轮、流中断、错误码、length 截断、usage 缺失均有明确终态；`reasoning_content` 原样回传 | G0 |
| 会话、续接、分叉、导出 | kap-server sessions | 业务 API 映射；会话存储加密 | 原生接通 | 断电后续接；跨事项不串 | G0 |
| 上下文压缩 | 引擎 compaction | 原生；法律事实账本独立于聊天摘要 | 原生接通 | 压缩后不丢限制、引用与不确定性 | G1 |
| 计划模式 | EnterPlanMode/ExitPlanMode | 原生 + “先出计划”开关 | 原生接通 | 计划审批走业务审批卡 | G0 |
| 待办 | TodoList | 原生，映射任务步骤 | 原生接通 | 与任务状态一致 | G0 |
| 提问 | AskUserQuestion（kap-server 持久问题队列） | 业务 API；App 可跨端作答 | 原生接通 | 答复、超时、关闭、恢复后不丢问题；不伪造答复 | G0 |
| 进度通知 | NotifyUser（实验特性） | 锁定开启状态（实验开关） | 政策限制 | 只展示、不授权 | G1 |
| 文件读取与搜索 | Read、Glob、Grep | 事项三区文件系统（`IHostFileSystem` 种子，令牌化视图）；Glob/Grep 用随包签名的原生 ripgrep 作为可信工具（cwd 固定为事项工作区，拒绝绝对路径与 `..`、`-L/--follow/--pre/--search-zip`，路径参数经文件 broker 规范化）；just-bash 的 `rg` 不兼容 Kimi Code 实参（`--sortr`、`--field-context-separator`、`--max-columns`、`--version`），只服务模型在 Bash 里自写的命令 | 政策限制 | 非授权材料与其他事项不可读；符号链接/重解析点/UNC/长路径/TOCTOU 全拒；Glob 与 Grep 全部参数组合回归 | G0 |
| 文件写入 | Write、Edit | 只写工作区；原件区只读；交付区只由人发布 | 政策限制 | 改原件与写交付区被拒；文件历史可回滚 | G0 |
| 图像/视频 | ReadMediaFile | 默认改走本机 OCR；直送为跨边界动作 | 政策限制 | L2 确认、L3 拦截；闸门识别图像载荷 | G1 |
| Shell 与代码执行 | Bash（`IHostProcessService.spawn(shellPath,['-c',cmd])`，`bashTool.ts:157-172`） | **执行域路由**：默认 W-core（模拟 bash + 零 JS 桥 CPython + 纯 Python 包）；W-data（Pyodide）默认只在 N 内 | 适配替代 | 20 类律师典型数据任务通过；路径命名空间一致；逃逸、联网、资源红队零越界 | G0 |
| 后台任务 | TaskList、TaskOutput、TaskStop、WaitFor | 原生；TaskStop 须确认；任务输出日志（`task/persist.ts` 的 `output.log`）种子化到事项工作区隐藏子目录并加密，文件 broker 对本会话任务输出只读放行 | 原生接通 | 取消传播到执行域；在途费用可解释；模型按通知去 Read 输出文件时可读 | G1 |
| 用户直接执行 shell | `agent/shellCommand` | 进入执行域（同 Bash）或关闭 | 政策限制 | 不在执行域外运行 | G1 |
| 撤销（undo） | 引擎 undo | 映射为业务版本回滚 | 原生接通 | 不回滚权限、法源有效性与已外发事实 | G1 |
| 工作区指令 | `workspaceInstructionsService`（工作区与 homeDir 的 AGENTS.md，文件变化即重载） | 只从签名方法包与只读可信配置区加载；工作区与案卷目录中的 AGENTS.md、技能目录不加载（ZP-18） | 政策限制 | 写入 `/work/AGENTS.md` 后新会话不加载 | G0 |
| 子 Agent | Agent（默认 `coder` profile） | 原生；`[secondary_model].force = true`、`default_model` 为 K2.6 级，需要 K3 的子任务由宿主策略按预算审批；权限继承且只能更窄 | 政策限制 | 不能自批、不能跨事项；取消传播；子 Agent 模型来源可审计 | G0 |
| Agent 集群 | AgentSwarm（≤128，默认并发不设上限） | `KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY=3`；预算预占 | 政策限制 | 并发与总预算不超；超额暂停并说明 | G1 |
| 目标模式 | Goal 系列 | 必须设预算与时限 | 政策限制 | 超额前停止新调用；可解释恢复 | G1 |
| 文件历史与快照 | kap-server `fileHistory`、`snapshot` 路由 | 业务 API 映射为 ArtifactVersion | 原生接通 | 回滚不回滚权限、法源有效性与已外发事实 | G1 |
| 技能 | Skill、skillDirs | 中软签名方法包 + 律所批准技能 + 个人纯提示词技能；案卷目录内配置不加载 | 政策限制 | 任务可写目录不能新增有效指令或插件 | G0 |
| Agent profiles | agentFiles、项目级 agents | 只加载签名 profile；项目级不加载（ZP-1） | 政策限制 | 投毒用例全拒 | G0 |
| MCP | mcp.json | 只含法律 MCP、法源 MCP（经闸门）、律所批准 MCP；项目级不加载（ZP-2） | 政策限制 | tenant/user/matter 三重范围；不直传长期密钥 | G1 |
| Hooks | 上游 hooks（失败放行） | 不依赖；律所 Hooks 由宿主策略实现（失败即拒绝） | 适配替代 | 高风险时点 Hook 不可达即拒绝 | G2 |
| 插件市场 | `KIMI_CODE_PLUGIN_MARKETPLACE_URL` | 指向中软/律所目录 | 适配替代 | 只装签名包；版本锁定 | G1 |
| 联网搜索 | WebSearch（`[services.moonshot_search]`，无配置不注册） | 闸门 `/search` → 中软检索服务 → `/v1/tools/search(_pro)` | 适配替代 | 只有开放平台 token 时可用；查询去向可审计 | G0 |
| 网页抓取 | FetchURL（托管失败即本机直连回落） | 闸门 `/fetch`；删除回落（ZP-11） | 适配替代 | DNS 重绑定、重定向、私网、元数据地址、超大文件全拒 | G0 |
| 数据源插件 | kimi-datasource（读 Kimi OAuth） | 中软法源服务（MCP） | 适配替代 | 不借用个人会员凭据 | G1 |
| 定时 | CronCreate/List/Delete | 本机内容任务；期限提醒走云端 | 政策限制 | 错过提示补跑；创建须确认 | G1 |
| 终端 | kap-server terminals（node-pty 起 shell） | 关闭（`IHostTerminalService` 拒绝实现 + 路由不可达） | 政策限制（关闭） | 远程与界面均不可达 | G0 |
| 远程控制 | remote-control（code-rc.kimi.com，须 Kimi 登录，无端到端加密） | 关闭；以中软设备中继 + 业务网关替代 | 适配替代 | 中继抓包只见密文；只开白名单接口 | G2 |
| 遥测 | telemetry | 关闭；中软只收运营元数据 | 政策限制（关闭） | 出网面扫描无上游遥测 | G0 |
| 账号 OAuth | auth.kimi.com | 不使用；中软 IAM + 网关令牌 | 适配替代 | 无 Kimi 账号可用全部承诺能力 | G0 |
| WebBridge / Computer Use | 外部二进制插件 | 不提供 | 不在已购权益 | 二进制不随包分发 | — |
| ACP | kimi-acp | 不使用（只代理文本文件读写） | — | — | — |
| Kimi 闭源云技能（PPT/建站/深度研究） | — | 我方替代或不提供 | 不在已购权益 | 销售口径如实 | — |

## 3. Kimi Code 嵌入：kap-server 作为私有组件

### 3.1 为什么是 kap-server，为什么不让它对外

- **能力**：文件历史、快照、子会话列出与操作、可持久的审批与提问队列只在 kap-server（`routes/fileHistory.ts`、`snapshot.ts`、`sessions.ts:650,709`、`approvals.ts`、`questions.ts`）；SDK 只有回调式审批与子 Agent 事件（`调研-X2` §2.4）。要“完整接入 Kimi Code 后端能力”，kap-server 更省事。
- **攻击面**：kap-server 是 `kimi web` 的开发者后端，约 105 个 v1 + 14 个 v2 路由，含终端、配置、会话 Agent 配置、工作区信任、插件安装、打开本机程序、OAuth、关机、遥控。
- **折中**：把 kap-server 当作 Agent 宿主进程里的私有组件——**能力全用，界面不见**。

### 3.2 嵌入方式

| 项 | 设计 |
|---|---|
| 进程与令牌（**不监听端口**） | 首选：Agent 宿主在进程内 `bootstrap` 并以 Fastify `inject()` 调用 kap-server 路由（无 TCP 端口），或用仓库自带的 klient 内存传输；次选（仅当前两者不可行）：绑定命名管道/Unix 套接字，ACL 只允许当前用户与宿主进程。任何形态都**显式注入内存令牌服务**（`startServer({ authTokenService })`），禁止使用默认 `createTokenStore(homeDir)`（会把令牌持久化到文件）；`allowRemoteShutdown`、`debugEndpoints` 关闭 |
| 访问者 | **只有 Agent 宿主**。渲染进程、Office 加载项、手机、IM 都只调用业务网关的业务 API；业务 API 由宿主翻译为对 kap-server 的有限调用 |
| 路由白名单 | 宿主只调用能力账本需要的约 20–30 条路由（会话、提示、事件流、审批、提问、子会话、目标、文件历史、快照）；其余路由在宿主侧拒绝；上游新增路由默认不可达；P1 以端口扫描证明宿主不监听 TCP |
| `seeds`（`start.ts:120,198-211`，后写覆盖先写） | `IHostProcessService` → **执行域路由**（W-core 默认，W-data/N 按策略，rg → 可信原生工具）；`IHostFileSystem` → 事项三区文件系统（令牌化视图）；`IFileSystemStorageService`、`IBlobStore`、`IAtomicDocumentStore` → 事项密钥加密实现；`IHostTerminalService` → 拒绝；检索与抓取服务 → 闸门端点；**宿主策略提供者**（供 ZP-4 补丁在策略链首位调用）；环境服务返回固定 `shellName` 并屏蔽 cygpath 查找；文件打开/定位、插件安装、OAuth、遥控相关服务 → 拒绝 |
| 每次任务生成配置 | provider `base_url` → 闸门 `/v1`；`[services.moonshot_search]`、`[services.moonshot_fetch]` → 闸门；`telemetry = false`；`builtin_product_skills = false`；`[identity]` 白标；插件市场 → 律所目录；`skillDirs` → 签名方法包 + 律所技能 + 个人技能；`mcp.json` 只含批准项；`[tools] enabled` 按四层策略生成；**`[secondary_model].force = true`、`default_model` = K2.6 级**；`KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY = 3`；Bash 超时档位（前台 60 秒/最长 5 分钟、后台 10 分钟、`disable_timeout`）经 `bash_task_timeout_s`、`bash_auto_background_on_timeout` 收紧并写入能力账本；实验开关锁定；Windows 上 `KIMI_SHELL_PATH` 指向执行域的占位 shell，免除 Git Bash 依赖 |
| 工作区与路径 | kap-server workspace = 事项工作区；**单一路径命名空间**：执行域把工作区与材料快照挂在与宿主路径的 shell 形式相同的位置（如 `/c/Users/<u>/…/matters/<id>/work`），Read/Write/Grep 与 Bash 看到同一路径；执行域路由解析并校验 Bash 的 `cd '<…>' &&` 前缀 |
| 无界面形态 | 律所执行器与云端执行面运行同一宿主制品；`nonInteractive` 时上游会移除 `DangerousCommandAsk`，但宿主策略对每次调用都给出裁决，不受影响；云端执行域换成 Linux 沙箱 |

### 3.3 业务运行时 API（界面、App、IM 只见这一层）

```text
POST   /runtime/runs                {matter_id, method, material_versions, mode, plan_first, budget}
GET    /runtime/runs/{id}/events?after=seq        断线续读
POST   /runtime/runs/{id}/answers   {question_id, answer, expected_state_version}
POST   /runtime/approvals/{id}      {decision, object_hash, scope: once|task, device_signature}
POST   /runtime/runs/{id}/cancel    {reason, expected_state_version}
GET    /runtime/runs/{id}/artifacts            产物与文件历史（映射 ArtifactVersion）
POST   /runtime/runs/{id}/rollback  {artifact_version}
GET    /runtime/capabilities                     本设备执行域与已开放能力（能力账本视图）
```

工具调用在宿主内经过 `authorize → reserve budget → prepare → approve if needed → recheck → execute → validate → commit → settle`；批准人来自可信界面认证或已登记设备签名，不来自模型参数。

### 3.4 补丁台账（锁版 2.1.1；v9 共 ZP-1～18）

| # | 级别 | 内容 | 状态 |
|---|---|---|---|
| ZP-1 | P0 | 项目级 agent profiles 不加载 | 已打（v5） |
| ZP-2 | P0 | 项目级 MCP 不加载 | 已打（v5） |
| ZP-3 | P1 | 插件市场默认地址改为中软/律所目录 | 已打（改指向） |
| ZP-4 | P0 | **宿主策略**：`AgentPermissionPolicyService`（`agent/permissionPolicy/permissionPolicyService.ts`）在构造函数里写死 13 条策略的顺序，并以 `registerScopedService(LifecycleScope.Agent, …)` 注册在 Agent 作用域，`seeds` 覆盖不到——须补丁在数组首位插入宿主策略（经种子注入的应用级服务提供裁决）。宿主策略对每一次调用都返回明确结果（允许 / 拒绝 / 询问），使其后的 auto/yolo/默认放行/git 写入放行等上游策略永远不被执行；每个子 Agent 有自己的 Agent 作用域实例，同样以宿主策略开头 | 待实现（G0 探针 P1） |
| ZP-5/6 | P0 | 进程与文件系统服务注入（kap-server 路径用 `startServer({seeds})`，无需补丁；SDK 路径用 `extraSeeds`） | 沿用并扩展 |
| ZP-7 | P0 | 回移 2.1.0 工作区加固（符号链接逃逸、git 配置执行、配置信任） | 待实现 |
| ZP-8 | P0 | 关闭上游远程控制（隧道带本机令牌原样转发 kap-server 全部路由；须 Kimi 登录；无端到端加密）；以中软设备中继 + 业务网关替代 | 待实现 |
| ZP-9 | P1 | 加密落盘扩面：会话存储、文件历史与快照、导出包、插件存储、**后台任务输出日志**（`task/persist.ts`）；“上下文恢复”读取经解密视图 | 待实现 |
| ZP-11 | P0 | 删除 `MoonshotFetchURLProvider` 失败后的本机直连回落；未配置托管抓取时不注册 FetchURL | 待实现 |
| ZP-12 | P0 | 关闭 `IHostTerminalService` 与终端路由 | 待实现 |
| ZP-13 | P1 | 锁定实验开关（`KIMI_CODE_EXPERIMENTAL_TOWER`、NotifyUser 等）状态 | 待实现 |
| ZP-14 | P0 | 纵深：清空 `default-tool-approve` 默认放行清单与 `git-cwd-write-approve` 自动放行；宿主策略抛错或超时时按“拒绝”处理（失败关闭），不落到上游的默认放行 | 待实现 |
| ZP-15 | P0 | 环境变量白名单：上游 `buildEnv()` 透传整个 `process.env` → 执行域只收白名单变量 | 待实现 |
| ZP-16 | P1 | Windows shell 检测：允许以执行域占位 shell 满足 `KIMI_SHELL_PATH`，不要求 Git Bash；`environmentProbe` 与 `shellPathBridge` 不得在占位 shell 目录查找并直接执行 `cygpath.exe`（改由种子化环境服务返回固定值） | 待实现（或以配置绕过） |
| **ZP-17** | **P0** | **封闭绕过进程服务的直接子进程**：锁版中 `kap-server/src/lib/fileLaunch.ts`（spawn 打开本机程序）、`features/tower/protocol/git.ts`（execFile git，实验特性）、`_base/execEnv/environmentProbe.ts`（execFile）、`shellPathBridge.ts`（execFileSync cygpath）直接调用 `node:child_process`，`seeds` 拦不到——删除或封闭 `fileLaunch` 的 spawn，`tower` 以 ZP-13 锁死，探测类调用改由种子；CI 增加“`node:child_process` 只允许出现在白名单文件”的静态检查，上游升级时自动报警 | 待实现 |
| **ZP-18** | **P0** | **工作区指令只从可信来源加载**：`workspaceInstructionsService` 会加载工作区与 homeDir 的 `AGENTS.md` 并在文件变化时重载，被注入的 Agent 可写入 `/work/AGENTS.md` 形成持久化注入——改为只从签名方法包与只读可信配置区加载，工作区与案卷目录中的 `AGENTS.md`、`.kimi-code/skills`、`.kimi-code/agents`、`.mcp.json` 一律不加载 | 待实现 |
| 升级闸门 | — | rebase 到 > 2.1.1 前 revert #4059（`KIMI_CODE_TRUST_WORKSPACE`）；跟踪 #4115（沙箱，外部贡献未合）、#4062（远程环境，内部 draft）、#2337（权限规则）、#4070（后台子 Agent 审批旁路）；上游 2.1.1 之后无新 release（10-09），node-sdk 与 kap-server 均 `private: true` 未上 npm，只能源码 vendoring | 双周评估，行为回归后再升级 |

## 4. 执行域

### 4.1 W 执行域（默认，所有设备）：W-core 与 W-data

```text
kap-server Bash 工具 ──IHostProcessService.spawn(shell,['-c',cmd])──▶ 执行域路由（Agent 宿主内，可信）
   │ 解析并校验 `cd '<宿主路径的 shell 形式>' &&` 前缀；按事项策略选 W-core / W-data(N) / 拒绝
   ▼
W 监督进程（每事项一个）：随包分发的 Node 26 LTS（锁定小版本与 digest；Electron 内置 Node 不用于此）
   node --permission --allow-fs-read=<运行时目录>,<本任务材料快照>,<事项工作区> \
        --allow-fs-write=<任务临时目录> --allow-worker
   （不授予 --allow-net、--allow-child-process、--allow-addons、--allow-wasi、--allow-ffi；作业对象 + 看门狗限资源）
   └─ 每次 Bash 调用一个 worker：just-bash 实例（executionLimitProfile = hardened，replaceEnv）
        文件系统 MountableFs（挂载点 = 宿主路径的 shell 形式，单一路径命名空间）：
          材料快照 ← OverlayFs（只读）；工作区 ← OverlayFs（读盘、写入留在内存）→ 执行结束由文件 broker 校验后提交
          /tmp ← 内存；allowSymlinks = false；不允许创建硬链接与 junction
        命令：coreutils/grep/sed/awk/sort/jq/sqlite3/xan/yq/tar/gzip 等；无 curl（未配置网络）
        python3（W-core）→ just-bash 自带 CPython-Emscripten（零 JS 桥）+ 随包纯 Python 包，worker 内运行
        kwl-* → 可信命令：文书引擎（docx 读写与修订草稿）、xlsx 校验、法规条文查询、金额与期限计算器
   W-data（Pyodide：pandas/numpy/matplotlib…）→ 默认只在 N 执行域内运行；无 N 的设备由律所策略决定是否对 L0–L2 开放
```

**执行域路由规则**（`IHostProcessService` 种子的白名单；锁版源码中经进程服务的调用包括 `bashTool.ts`、Grep/Glob 的 `workspaceFs/fsService.ts:901`（`spawn(rgPath, args)`）、`gitContext.ts`、MCP 管理、外部 hooks、能力插件守护进程；不经进程服务的直接子进程由 ZP-17 封闭）：

| 调用方 | 请求 | 路由 |
|---|---|---|
| Bash 工具、用户直接 shell | `spawn(shellPath, ['-c', cmd])` | W-core（默认）；W-data 只在 N 或律所策略允许时 |
| Grep / Glob | `spawn(rg, args)` | **随包签名的原生 ripgrep 作为可信工具**：cwd 固定为事项工作区；拒绝绝对路径、`..`、`-L/--follow`、`--pre`、`--search-zip`；路径参数经文件 broker 规范化；输出中的路径按单一命名空间返回。just-bash 的 `rg` 不支持 Kimi Code 实参（Glob 每次传 `--sortr=modified`、Grep 用 `--field-context-separator`、`--max-columns`，定位探测用 `rg --version`），只服务模型在 Bash 里自写的命令 |
| 系统提示的 git 上下文 | `spawn('git', …)` | 拒绝（引擎按上游设计降级为“不可用”，v5 已验证） |
| MCP stdio 服务、外部 hooks、WebBridge/Computer Use 守护进程 | 任意可执行文件 | 拒绝（MCP 只允许 http 且经闸门；hooks 由宿主策略实现） |
| 其他 | — | 默认拒绝并记审计 |

**与 Kimi Code Bash 工具的衔接**（锁版 `bashTool.ts:157-260`、`task/process-task.ts`、`runRg.ts`）：

| 要求（上游语义） | W 的做法 |
|---|---|
| 路径：命令被拼成 `cd '<shellCwd>' && <command>`；Windows 上 `shellPathBridge` 把 `C:\…` 转为 `/c/…` | 单一路径命名空间：工作区与材料快照挂在与 `/c/…` 相同的位置；Read/Write/Grep 与 Bash 看到同一路径；种子化环境服务固定 `shellName = bash`，屏蔽 `cygpath` 查找（ZP-16/17） |
| `IHostProcess`：`pid/exitCode/stdin/stdout/stderr/wait()/kill(signal)/dispose()` | 每次调用一个 worker，返回合成进程对象（合成 pid）；stdout/stderr 为可读流 |
| 流式输出：`ProcessTask` 按 data 事件逐块写任务输出，前台超限时落盘 | just-bash `exec()` 只给聚合结果——须实现流式回调（对上游提需求，或自维护补丁）；未实现前后台任务的 TaskOutput 在完成前为空，列入 G0 P2 |
| 终止：取消发 `SIGTERM`，`forceStop` 发 `SIGKILL`；rg 为 SIGTERM → 5 秒 → SIGKILL | `SIGTERM` → just-bash `AbortSignal`（协作式，“在下一语句边界停止”）+ 宽限；`SIGKILL` → `worker.terminate()`；Python 死循环靠终止 worker；不殃及同事项其他命令 |
| 超时：前台默认 60 秒、最长 5 分钟，超时默认转后台；后台默认 10 分钟、最长 24 小时；可 `disable_timeout`；just-bash `hardened` 默认总时长 30 秒 | 对齐：W 的 `maxExecutionTimeMs` 由宿主按调用类型设置（前台 5 分钟上限、后台 60 分钟上限、禁止 `disable_timeout`）；经配置收紧 Kimi Code 档位并写入能力账本 |
| 并发：主 Agent、Swarm（并发 3）、后台任务可能同时跑 Bash | 同一事项最多 N 个并发 worker（N = 活动执行单元数，默认 2–3）；超出排队并在界面显示 |
| 工作区并发写：just-bash 明文警告不要经宿主 API 并发修改 `ReadWriteFs` 根目录 | 不用 `ReadWriteFs` 直挂：工作区以 OverlayFs 读盘、写入留在内存，执行结束由文件 broker 校验（路径、大小、无链接）后原子提交；若期间文件在盘上已变化（Write/Edit、Office 写回、同步客户端），生成冲突副本而不覆盖 |
| 模型可见的环境说明 | 系统提示中的 shell 说明改为“受限 bash（无网络；python3 只有标准库与列出的包；pandas 只在数据分析增强环境中可用；不能安装软件）”，减少 `pip install`、`curl` 等无效步骤 |

| 项 | 规格 |
|---|---|
| W-core 的 Python | just-bash 自带 CPython-Emscripten（Python 3.13 标准库；worker 源码自述“zero JS bridge code”，文件访问经 SyncBackend 桥回 just-bash 虚拟文件系统）+ 随包纯 Python 包：openpyxl、et_xmlfile、XlsxWriter、pypdf、python-dateutil、jieba 等（加入只读 site-packages，经同一桥接访问）；DOCX 读写走 `kwl-docx` 可信命令（python-docx 依赖 lxml，不在 W-core 内） |
| W-data 的 Python | Pyodide 0.29.5（自带 pandas 2.3、numpy 2.2、lxml 6.0、matplotlib 3.8、scipy、pyarrow 等；openpyxl、python-docx 等离线随包）。**Pyodide 内置 Python⇄JS 互操作（`import js`、`pyodide.code.run_js`、`pyodide.ffi`），guest 可执行宿主 JS**，故只在 N 执行域内运行，或在律所明确接受“进程级隔离”时对 L0–L2 开放；文件访问不用 NODEFS 直挂真实目录，同样经快照与提交 |
| 升级路径（G2 探针） | 用 pyodide-build 的配方为“零 JS 桥”CPython-Emscripten 构建 numpy、pandas、openpyxl 依赖的 C 扩展轮子；成功后 W-data 并入 W-core |
| 中文字体 | matplotlib 与文书渲染用的中文字体只读挂载（字体许可单独确认） |
| 资源 | 进程内存上限 2 GB（8 GB 设备 1 GB）；超限即终止 worker 并返回明确错误；输出总量与文件大小上限 |
| 网络 | W-core：guest 无 JS 桥、未配置网络命令；W 进程未授予 `--allow-net`（运行时强制，非 OS 强制）；P2 验证 DNS 解析同样失败。W-data：同一进程限制 + N 域的 OS 网络策略 |
| 隔离性质（如实） | W-core = 语言运行时隔离 + Node 运行时权限（官方定位为“安全带”，不防恶意代码，且符号链接会被跟随到授权路径之外——W 因此禁止链接并以快照提交写回）+ 进程资源限制；**不是操作系统强制的沙箱**。just-bash 为 Beta，自述“无 VM 隔离、依赖实现健壮性”。对外与设备页如实标注“运行时隔离” |
| 性能目标（G0 探针） | 300 行流水汇总 < 10 秒；1 万行 CSV 标准库分组聚合 < 30 秒；40 份 DOCX 要素抽取（不含模型）< 2 分钟；W-data 10 万行 pandas 分组 < 60 秒 |
| 不适用 | 需要原生二进制的任务（LibreOffice 转换、原生 OCR、浏览器自动化）→ 由我方可信工具承担，或 N 域 |

### 4.2 N · 原生执行域（可选增强）

| 路径 | 前提 | 管理员 | 读隔离 | 网络 | 用法 |
|---|---|---|---|---|---|
| **MXC 进程容器（PSEC）**，Node SDK `@microsoft/mxc-sdk` 1.0 | Win11 24H2 ≥ 26100.9278 / 25H2 ≥ 26200.9278（KB5120998，2026-08）等；PSEC 未被禁用；逐机能力探测，显式选择失败不回落 | 否 | 是（拒读路径需探测 `PSE_SUPPORT_FS_DENY`） | 每容器 WFP 出站过滤，默认全拒；须确认回环同样被拒（防止 guest 连本机服务） | 运行 W-data（Pyodide）、原生 Python 与便携工具；律所策略可要求 L3a 的代码只在 N 或 W-core 中运行 |
| IT 预配沙箱（参照 Codex `elevated`：专用低权限用户 + 防火墙/WFP + ACL） | 一次管理员授权 | 一次 | 是 | 是 | 律所版可选，G3 |
| MXC 回落层（AppContainer + DACL） | 给系统盘根加 ACE，且 `\Device\Null` 每次开机需提权重设 | 是（每次开机） | 是 | 不等价 | **不采用** |
| 受限令牌（Codex `unelevated` 同类） | — | 否 | 否 | 弱 | **不采用**（不能算隔离） |

X2 估计 2026Q4 约 30%–45% 的律所 Windows 机器满足 MXC 无管理员条件；W 覆盖其余全部，所以 N 只是增强，不是可售前提。360、火绒、电脑管家对 MXC 的兼容性无公开报告，G0 实测。

### 4.3 C · 云端执行域（G3）

每任务一个隔离沙箱（Firecracker 或 Kata 级 microVM，或 gVisor 级容器），只挂载本任务授权快照；默认无网，出网经云端闸门；不持有平台管理凭据与上游主密钥；CPU/内存/进程数/磁盘/输出/时长全部限制；禁止宿主 socket、云元数据、privileged 与共享可写依赖。成本锚点：月之暗面托管智能体沙箱 1 核 1 GB ¥0.072/小时（不符合 ZDR，不用于客户数据）；E2B 约 $0.05/vCPU·时（infra Apache-2.0 可自托管）——单任务沙箱算力约 ¥0.04–0.3，不是成本瓶颈（`调研-X2` §4.1）。境内云厂商 Agent 沙箱（腾讯云 Agent Runtime、阿里云、火山引擎）的单价、私网与等保说明须采购前逐家索取。

### 4.4 文件 broker（三区）

- 原件区：导入原件按内容寻址加密保存；执行域只见本任务所需原件的只读快照（解析文本或副本）；律师挂载的文件夹本身从不暴露给执行域。
- 工作区：草稿、表格、脚本、中间产物；文件历史与快照可回滚；事项闲置超过策略时限（默认 8 小时）封存为密文。
- 交付区：只能由人发布；Agent 写不进去。
- 路径安全：root-relative 路径 + 句柄级校验；拒绝或安全解析符号链接、junction、重解析点、UNC、网络盘、大小写变体、保留设备名、长路径、压缩包路径穿越；检查与使用之间不按字符串重新打开（修复现有 `sandbox.ts` 的字符串前缀判定）。

## 5. 出站闸门与云端能力服务

### 5.1 出站闸门（律师电脑上的独立签名进程）

| 端点（回环 + 每进程凭据） | 来源 | 闸门做什么 | 上游 |
|---|---|---|---|
| `/v1`（OpenAI/Anthropic 兼容） | Agent 宿主、确定性工作流 | 事项依据检查 → 令牌化（证件、账户、联系方式、自然人姓名；L3a 加机构名称；令牌按事项 HMAC 确定性分配）→ 图像载荷识别 → 去向记录 → 转发；**响应流不还原**，原样交给引擎（令牌只在界面渲染与文书引擎导出时还原） | 法律模型网关 |
| `/search` | WebSearch | 令牌化；当事人词典与实体识别；泛化或请求确认；查询原文写本机事项账本；**转发时不携带事项编号**（只带席位令牌） | 检索服务 |
| `/fetch` | FetchURL | 仅 http(s) GET；域名白名单与“公开官方站点基线”；搜索引擎与回显查询参数的站点不经抓取；URL 中实体与长编码串拦截；SSRF（私网、链路本地、元数据地址，每次重定向与 DNS 解析重新校验）；结果标“不可信外部内容” | 本机直连或抓取代理 |
| `/mcp/sources` | 法源 MCP | 去标识；Source Registry 规则 | 法源服务 |
| `/mcp/firm/*` | 律所批准连接器 | 数据级别上限；登记须管理员设备签名 | 律所服务 |
| 控制面、更新、中继 | 主进程、同步客户端 | 目的地固定；只出元数据或密文 | 中软云 |

**“唯一出口”的强度如实分级**：①执行域 W/N 无网（OS 或运行时强制）；②Agent 宿主与 kap-server 的网络调用全部配置到闸门，并以 `HTTP(S)_PROXY` 兜底、删除已知直连路径（ZP-11、ZP-12）、CI 扫描出网面；③渲染进程 CSP `default-src 'none'` 起步，Agent 产物 HTML 在无网隔离框架预览；④Agent 生成的 DOCX/XLSX/PPTX 交 Office 前剥离外部关系；⑤律所 IT 可选加装按程序的出站防火墙规则（需管理员），使“只有闸门进程能出网”由操作系统强制。设备页如实显示“唯一出口：应用层约束 / 系统强制”。

### 5.2 法律模型网关（云端）

- 鉴权：设备凭据 + 席位令牌（网关可离线验签 ≥ 72 小时）；事项匿名摘要用于二次检查（L3b 拒绝、端点许可、密级）。
- 额度与计量：点数权威扣减（按模板与实耗）、预写日志、与 MaaS 对账；任务预算预占、父子共享上限。
- 并发：开放平台最高 Tier5 仅 100 并发 / 300 RPM（`调研-X2` §3.4），必须企业协议提额；网关按租户排队与限流，避免一个律所的 Swarm 挤占全平台。
- 路由：主任务 K3（`reasoning_effort` 按任务设置）；子 Agent、分类、抽取默认 K2.6/K2.7 级（经专项评测）；不静默跨供应商路由。
- 缓存：按律所盐值布局前缀，保证缓存命中又不跨律所复用。
- 内容安全：内存检测，命中只记类别。
- 留存：正文与错误体不落盘；只记元数据（席位、匿名事项 ID、模板、模型、token、耗时、请求 ID）。
- 上游：**网关直连月之暗面企业账户**（独立组织与密钥，主密钥只在服务端 KMS），中软 MaaS（基于 new-api，AGPLv3 + 附加署名条款）只接收用量与计费记录、不在内容路径上——既减少接触内容的系统，也避开 AGPL 第 13 条“经网络远程交互的用户”的源码提供义务争议；若业务上必须经 MaaS 转发，须先完成 AGPL 合规评估，并核验 MaaS 的正文/错误体日志、重试、fallback、缓存、管理员访问均不落正文（单独“分组”不是隔离证明）。

### 5.3 检索服务、抓取代理、法源服务、无事项问答

| 服务 | 设计 |
|---|---|
| 检索服务 | 对 Kimi Code 实现其检索协议（`POST {"text_query"}` → `{"search_results":[…]}`），上游 `/v1/tools/search`（¥0.01/次）与 `search_pro`（¥0.015/次，`sites` ≤ 5、`time_window`、`authority` 字段）；法律官方站点集按每组 ≤ 5 个站点扇出合并去重；查询原文不落盘（hash 只用于去重，不作“不可见”的证据）；公开结果可按 URL 短期缓存；按次计点；备选供应商以 DPA 中查询留存口径决定 |
| 抓取代理 | 可选；上游 `/v1/tools/fetch`（¥0.01/次），隐去律所出口 IP |
| 法源服务 | 法规：官方公报文本自建版本库（签名增量包下发到端）；案例与工商：自签数据商合同（元典、法律之星、企查查/天眼查等，逐项许可：检索、全文、缓存、送模型、展示、导出、评测）；MCP 接入，凭据只在云端 |
| 无事项问答 | 网关 + 检索 + 法源组合；服务端不持久化问答内容；历史在本人设备（端到端加密同步到本人其他设备）；**用户输入同样经出站闸门**（桌面）或 App 内同规则的闸门模块：本人可见事项的当事人词典加密同步到本人设备，命中 L3b 当事人即拦截，命中其他当事人提示“请在事项内处理” |
| 公开监测 | 确定性服务：法规变更、公告、企业公示的全量或行业增量；关注名单只在律师电脑匹配 |

## 6. 方法包

- 形式：签名、版本化的技能包（规则 JSON、Playbook、模板 DOCX、提示词），许可绑定到律所；客户端用许可派生密钥解密；对持证律所可见（风险卡显示规则依据）。
- 发布：法律工程师起草 → 资深律师审校 → 独立盲测 → 签名 → 灰度 → 回滚；客户端拒绝低于已见版本的包（反回滚）。
- 例外：少量评分与排序类提示词在网关组装（不展示给终端），展开后的 token 与版本回传计量。
- 保护：许可、水印、持续更新、合同；不承诺“不可提取”。

## 7. 同步与密钥（本地事项的团队共享）

- **事项账本**：事件溯源；每台设备一批事件为一段，段头明文含设备证书，段体按事项密钥 AES-256-GCM 加密，段尾双 hash + 设备签名（v5 `packages/sync` 已实现共享文件夹版本，介质改为中继对象存储）。
- **中继**：只追加段 + 内容寻址块；设备签名写入；条件写；不保存成员名单以外的身份信息；不可解密。
- **冲突**：独立草稿可并存；同版本并发修改保留双版本由律师选；签发与外发单一权威提交；成员变更有纪元与墓碑。
- **密钥**（详见第 02 篇 §9.11）：每设备独立签名与加密密钥（P-256，TPM/钥匙串/Secure Enclave/StrongBox）；账户身份链；个人恢复码为“纸设备”；事项密钥包裹给成员设备与律所恢复公钥；律所恢复 2-of-3（律所版）；HPKE（RFC 9180）；国密套件可切换。`platform/packages/keys`（v5：Ed25519/X25519、Shamir、ECIES）迁移到 P-256 + HPKE，Shamir 只用于律所恢复。
- **会话移交（跨设备续接）**：任务暂停或结束时，宿主把会话快照（令牌化的转录、待办、计划、文件历史指针、待答问题）作为事项事件写入账本并同步；另一台成员设备导入后经 kap-server 会话导入续接；进行中的工具调用与执行域状态不迁移，恢复时重新检查权限与输入版本。
- **律所档案成员**：团队版与律所版默认开启；伦理墙事项不加档案成员，改为把事项密钥封存给律所恢复主体并留痕。
- **预览件**：申请签发或分享时，桌面生成与交付件 hash 绑定的 PDF/HTML 预览件（带修订标注），随密文同步，供 App 只读渲染（手机不渲染 DOCX 原生修订）。
- **IM 离线收件**：电脑离线超过平台临时文件有效期（如企业微信临时素材 3 天，逐平台核实）时，IM 后端在内存取得文件后立即用接收人设备公钥加密暂存（默认 7 天，律所可关闭），电脑上线后取回并删除。
- **期限提醒**：提醒内容（期限类型、事项代号、文案）用接收人设备公钥加密；云端调度只持有触发时间与推送目标。
- **撤权与删除**：见第 02 篇 §9.13 的如实语义。

## 8. 数据模型、状态与恢复

| 实体 | 必需字段与约束 |
|---|---|
| Tenant / User / Device | 组织、状态、角色、设备独立公钥、撤销纪元；个人空间与律所空间分开 |
| Matter | 负责人、成员 ACL、伦理墙、**数据模式（本地/云端）**、密级、四项依据状态、法域、时点、保留与保全、policy_version |
| MaterialVersion | 来源、内容 hash、媒体类型、原件位置、页段锚点、权利记录、解析覆盖 |
| Run / Attempt | 意图、快照、执行位置与执行域、状态、预算、父任务、租约纪元（fencing）、deadline |
| ToolCall | 工具与版本、规范化参数摘要、输入对象版本、策略裁决、实际出站记录、结果位置 |
| Approval | 对象及版本、动作、受众与目的地、金额与预算、批准人与设备签名、nonce、有效期、消费状态 |
| ArtifactVersion | 源材料、规则、模型版本、产物 hash、质量门禁、复核与签发状态 |
| Citation | 来源版本、精确锚点、命题、真实性/支持/适用三态、许可、核验时间 |
| UsageLedger | request_id、预占/实际/释放/补记、供应商费用、点数、计费版本、幂等键 |
| EgressRecord | 目的地类别、用途、来源对象、载荷类别与字数、遮蔽与化名计数、请求 ID、审批与策略版本 |
| AuditEvent | actor、tenant、匿名事项 ID、动作、对象版本、策略与裁决 ID、序号与前 hash |

- **任务状态**：`CREATED → VALIDATING → QUEUED → RUNNING`，期间可进入 `WAITING_INPUT / WAITING_APPROVAL / WAITING_DEVICE / PAUSED_BUDGET / RECOVERING`；终态 `SUCCEEDED / PARTIAL / FAILED / CANCELLED / EXPIRED / TIMED_OUT`。终态转换用 CAS；**未知状态、缺成果、截断、超时都不能成功**。
- **Attempt 与 fencing**：每次尝试获得短租约与递增纪元；失去租约后不得读新材料、调上游、写产物或结算费用；网关、文件 broker 与提交点都检查纪元。
- **检查点**：已完成工具结果指针、输入快照、策略与模板版本、预算账本、待答问题与审批、压缩历史、失败覆盖清单；恢复时重新检查权限与输入版本；副作用结果不明进入人工对账，不盲目重发。

## 9. 现有 `platform/` 的复用与必修缺陷

**复用**（v5 G0 骨架，约 1.9 万行 TypeScript）：`packages/kernel`（事项账本、任务队列、确定性工作流、审批与签发、审计链）、`docx-engine`、`parse-ocr`（PP-OCRv5 本机）、`pseudonym`、`egress`、`keys`、`sync`、`lawdb`（签名法规包）、`model-broker`、`im-connectors`、`apps/desktop`、`apps/firm-node`。

**开放任何新工具之前必须修复（主审已复读源码确认前两项）**：

| # | 位置 | 缺陷 | 修复 |
|---|---|---|---|
| F1 | `packages/kernel/src/executor/agent-host-manager.ts`（`case "done"`）与 `apps/agent-host/src/host.ts`（超时发送 `status:'timeout'`） | 非 cancelled 的 done 一律置为 `succeeded`，超时任务被记为成功 | 终态枚举化；`timeout/length/非零退出/缺产物/截断` 均不得成功 |
| F2 | `apps/agent-host/src/sandbox.ts`（`under()` 字符串前缀 + 固定 `/`） | 符号链接可逃逸；Windows 合法子路径被误拒 | 句柄级校验的文件 broker（§4.4）；执行域 OS/运行时强制 |
| F3 | `agent-host-manager.ts` 审批分支 | `mcp__legal__` 前缀一律自动批准，未来同前缀写工具会继承 | 工具 ID + 动作 + 资源 + 用途授权；清单含 schema hash 与副作用类别 |
| F4 | `apps/agent-host/src/host.ts` 全局 undici dispatcher | 不能覆盖显式 dispatcher、子进程、原生 socket | 闸门 + 执行域无网；不再以 dispatcher 作为隔离依据 |
| F5 | 事件截断与 `outputText` 拼接 | 截断与拼接污染成果 | 结构化产物事件 + 文件 hash + 事务完成记录 |
| F6 | 取消只杀单进程；`agent_start/agent_wait` 不落检查点 | 开放 Shell/子进程后孙进程残留；副作用工具重跑 | 进程树终止 + 先吊销能力令牌；副作用工具幂等键 + outbox + 检查点 |
| F7 | 签名 profile 复制进可写 homeDir | 同用户进程可替换 | 可信配置只读挂载，与可写状态分区 |

**迁移**：`apps/agent-host`（SDK 形态，只开法律 MCP）保留为确定性工作流与回归测试宿主；开放任务改由新 `packages/kap-host`（kap-server 私有嵌入 + seeds + 宿主策略）承载；新增 `packages/exec-wasm`、`packages/exec-mxc`、`packages/runtime-api`、`apps/mobile`、`services/*`（云端）。示例法规、演示来源与虚构当事人打 `sample=true` 并与生产索引物理隔离，生产构建拒绝载入。

## 10. 安全与供应链

| 威胁 | 控制 |
|---|---|
| 放开工具后的注入外泄与破坏 | 执行域无网；原件只读；工作区可回滚；闸门唯一出口；宿主策略；≥ 300 例分层注入红队（PDF、网页、文件名、技能、图像与 OCR、文档外链） |
| 执行域逃逸 | W：just-bash 与 Pyodide 桥接的逃逸与原型污染测试、资源耗尽测试；N：MXC 策略验证；独立进程最小权限；及时跟进上游安全更新 |
| 绕过闸门 | 删除抓取回落、关闭终端、代理兜底、CSP、Office 外链剥离、出网面扫描 |
| 绕过审批 | 宿主策略在策略链首位、清空默认放行、业务网关丢弃模式参数 |
| 远程越权 | 设备中继端到端加密 + 设备签名；业务网关白名单；kap-server 不对外 |
| 控制面被攻破 | 管理员公钥固定；放宽类策略与连接器登记须管理员设备签名；版本单调 |
| 恶意客户端更新 | 代码签名、版本哈希公开、可复现构建、第三方审计、律所版延迟更新；如实写入白皮书 |
| 供应链 | 锁定上游 commit、SDK、Node/Electron、原生模块、Pyodide 与轮子、字体、OCR 模型的 digest；SBOM；补丁逐项对应威胁与测试；干净检出 + 补丁重放可复现构建 |
| 观测与支持 | 日志只留元数据；正文、文件名、提示词不进 APM；支持访问走客户可见、有期限的临时授权 |

## 11. G0（2026-10-12 ～ 11-20，6 周）探针与退出条件

| # | 探针 | 通过标准 | 周 |
|---|---|---|---|
| P1 | kap-server 无端口私有嵌入 + seeds + 宿主策略（ZP-4/14/17/18） | 遍历全部内置工具与 MCP 工具（含子 Agent 作用域），断言裁决来源均为宿主策略；Agent 宿主不监听任何 TCP 端口（端口扫描）；终端、遥控、OAuth、文件打开、插件安装、配置写入不可达；`node:child_process` 静态检查通过；写入 `/work/AGENTS.md` 后新会话不加载；会话、子会话、目标、审批、提问、文件历史、快照在嵌入形态可用 | 1–2 |
| P2 | **W 执行域** | Kimi Code 的 Bash 经 DI 进入 W-core；20 类律师典型数据任务在标准库 + 纯 Python 包下通过（流水汇总、违约金三情景、要素抽取成表、XLSX 生成等）；单一路径命名空间（Bash 生成的文件可被 Read/Edit/Grep 以同一路径访问，反之亦然）；Grep/Glob 经可信 rg 全部参数组合可用；流式输出、SIGTERM/SIGKILL、超时转后台与并发 worker 语义正确；工作区快照提交与冲突副本正确；Windows 10/11 家庭版与专业版 × 360/火绒/电脑管家可用；100 例逃逸（原型污染、桥接滥用、虚拟文件系统穿越、链接投毒）、联网（含 DNS）、资源耗尽用例零越界；W-data 的 `import js`/`run_js`/`pyodide_js` 用例在 N 域内被 OS 拦截；性能达 §4.1 目标 | 1–4 |
| P3 | MXC 原生增强 | Win11 24H2/25H2 家庭版与专业版上 PSEC 可用性；原生 Python 在容器内运行；拒读与断网生效；三款杀软兼容 | 2–4 |
| P4 | 检索补位 | 只配开放平台 token、不登录 Kimi 账号时 WebSearch 可用；Kimi Code 检索协议与 `/v1/tools/search(_pro)` 适配；法律站点集召回抽样合格 | 1–2 |
| P5 | 闸门唯一出口 | Agent 宿主与 kap-server 出网面扫描无直连路径；FetchURL 无回落；含实体的检索与 URL 100% 触发确认或泛化；渲染与 Office 打开 Agent 产物零外部请求 | 2–4 |
| P6 | 结构化补丁与令牌化工作区 | 100 份合同修订任务：补丁应用成功率 ≥ 99%（失败全部转预览）；交付件还原零错名；Bash/Python 源码与模型响应流零替换；令牌跨轮、跨子 Agent 稳定，`reasoning_content` 原样回传，前缀缓存命中率不低于未令牌化基线的 90%；自然人姓名识别召回在合成测试集上报告（漏识别如实列出） | 3–5 |
| P7 | 网关直连与 MaaS 结算 | 流式工具调用、`reasoning_content` 原样回传、usage、取消、缓存头透传；网关正文零落盘；用量记录准确报送 MaaS；租户排队有效 | 1–3 |
| P8 | 端到端加密共享 | 3 台设备离线编辑、冲突、吊销、轮换、恢复码恢复、律所恢复演练全部通过 | 3–6 |
| P9 | Word COM 原生修订保真 | 50 份复杂文档往返无原件覆盖与关键内容丢失 | 3–6 |
| P10 | 单位成本实测 | 合成与获准任务集上各任务类型的实际 token、检索次数与每份被采用交付件成本 | 4–6 |
| P11 | 现有缺陷 F1–F7 修复 | 回归用例全绿 | 1–2 |
| P12 | 注入红队 | 第 4 周 100 例、第 6 周 ≥ 300 例：零越界读写、零未经闸门出网、零未确认的跨边界动作 | 4–6 |

**G0 退出**：P1、P2、P4、P5、P7、P11、P12 必须通过；P3 未过不影响（N 为增强，W-data 推迟）；P6、P8、P9 未过则对应能力推迟到 G1 中段并调整试点范围。**P2 不通过的退路**（写死，不临时发挥）：默认档的代码执行改为“逐次确认 + 只在 N 域或可信工具中运行”，设备页与销售口径同步降级为“代码运行：仅系统强制设备”，并重新评估席位影响（第 05 篇敏感性 −15%）。

## 12. 研发工作包（G0–G2，至首个商用版本；人周，规划假设）

| 包 | 内容 | 人周 |
|---|---|---:|
| W1 桌面客户端 | Kimi Work 版式、事项与任务、执行态三栏、确认卡、数据去向卡、设备页（执行域如实标注）、Chat、看板 | 66 |
| W2 业务内核 | 事项账本、材料、策略引擎、审批与签发、审计链、收件区、三区文件 broker（快照提交与冲突副本）、Run/Attempt 状态机、预算 | 72 |
| W3 Agent 宿主与 Kimi Code | kap-server 无端口私有嵌入、seeds、宿主策略、配置生成、路由白名单、业务运行时 API、ZP-1～18、`child_process` 静态检查、能力账本测试、上游跟踪 | 52 |
| W4 W 执行域 | W-core：just-bash 集成、零 JS 桥 CPython 与纯 Python 包、可信命令、单一路径命名空间、流式输出与终止语义、并发 worker、快照提交；W-data：Pyodide 与离线包；Node 26 权限进程与看门狗；可信原生 rg | 48 |
| W5 原生增强 | MXC 探测与集成、W-data 在 N 内运行 | 10 |
| W6 出站闸门 | 独立进程、目的地、令牌化（含自然人姓名识别与 HMAC 确定性令牌）、按密级全部化名、图像、URL/SSRF、去向记录 | 30 |
| W7 文档与解析 | 解析/OCR 加固、文书引擎（修订、比对、受众分版、标识、清洁稿、令牌还原）、XLSX、预览件 | 70 |
| W8 Office 加载项 | Word COM（G1）、WPS（G2 起） | 62 |
| W9 密钥与端到端加密共享 | 设备密钥、身份链、恢复、事项密钥、中继客户端、冲突、轮换、导出、移动设备、会话移交、档案成员 | 46 |
| W10 云端控制面 | IAM/SSO/SCIM、组织/席位/点数、设备、策略与签名、通知（加密提醒内容）、调度、运营审计、计量与账单、分发、控制台 | 56 |
| W11 模型网关 | 鉴权、额度、路由、缓存、内容安全、计量、租户排队；直连月之暗面企业账户，向 MaaS 报送用量 | 24 |
| W12 检索/抓取/法源/问答服务 | 协议适配、站点集、Source Registry、无事项问答（含当事人词典检查）、公开监测 | 30 |
| W13 中继 | 共享密文中继、设备中继 | 14 |
| W14 IM 与收件区 | 首家平台 + 收件区 + 离线加密暂存 | 25 |
| W15 移动 App（G2 范围） | 通知、确认作答、提问作答、预览件只读、无事项问答（含闸门模块）；争取：向本人在线电脑发起模板任务 | 38 |
| W16 法律内容工程 | 4→9 类合同 × 双立场规则包、模板、金标、法律站点集、首批 100 部官方法规文本 | 100 |
| W17 评测与模型 | 评测平台、回归、Agent 评测、路由评测、成本遥测 | 40 |
| W18 测试 | 功能、Windows 矩阵（版本 × 杀软 × 内存）、同步与断电、云端 | 60 |
| W19 安全 | 威胁模型、注入与逃逸红队（含执行域、链接投毒、AGENTS.md 持久化）、闸门绕过、远程越权、控制面被攻破演练、渗透、代码审计 | 44 |
| W20 产品、设计与试点研究 | 设计合作律所、交互与视觉、访谈与验收（含云端托管意愿与价格敏感度） | 40 |
| W21 SRE、发布与支持 | 云端部署、监控、灾备演练、客户端分发（含第二个 Node 运行时的签名与信誉）、支持手册 | 30 |
| W22 合规、采购与数据治理 | 登记（G1 递交）、App 备案、等保定级、DPA、次处理者、影响评估、AGPL 评估、法源与上游谈判支持 | 24 |
| **基线合计** | | **981** |
| 风险预留 15% | 只用于已登记风险，不填新需求 | 147 |
| **预算总量** | | **约 1,128** |

审阅后相对初稿 +55 人周：W4 +26（零 JS 桥 Python、路径命名空间、rg、流式与终止、快照提交）、W6 +6（自然人姓名令牌化）、W9 +6（会话移交、档案成员）、W15 +8（预览件、模板任务）、W3 +4（无端口嵌入、ZP-17/18）、W14 +3（离线加密暂存）、W22 +2（登记前移、AGPL）。

对比：v7 约 895 人周（不含产品设计、SRE、合规约 90 人周，同口径约 985）；v8 约 875（含 25% 预留，不含 L 同步与移动端约 70 人周）。v9 范围最完整；执行域工作量（W4+W5 = 58）高于 v7 的 W19（30），换来的是所有设备上一致可用、强度如实标注的执行域。

**节奏与到岗**：按到岗爬坡 G0 约 24 人（6 周）→ G1 约 40 人（14 周，含春节）→ G2 约 44 人（15 周），G0–G2 平均约 39 人；按 85% 有效投入，至 2027-06-11 可交付约 1,100 人周（G0 约 122、G1 约 425、G2 约 561）。**基线 981 人周可在 6 月中旬前完成，首个商用版本目标 2027-06 下旬**；若 G0 实际到岗不足 24 人或风险预留用尽，顺延至 2027-07 上旬——对外日期写“2027-06 至 07 上旬，以 G0 末实际到岗为准”。若必须提前到 2027-04，可售范围收缩为：合同链 4 类 + 研究链 + Word；材料链、WPS、App 推迟到 G3（约 −150 人周）。

**G3（2027-H2，另行立项预算；经济模型的 2027–2028 年编制已含）**：云端事项与云端执行面（约 90，含专属实例选项）、律所执行器（16）、macOS（40）、WPS 深化与第二家 IM（30）、App 自由文本遥控与移动签发（24）、私有化交付包（40）、零 JS 桥 CPython 的数据分析轮子（约 12），合计约 250 人周。

## 13. 云端运行目标（G2 起，试点期校准）

| 项 | 目标 |
|---|---|
| 控制面可用性 | 99.9%（月）；不可用时本机能力不受影响 |
| 网关与检索服务可用性 | 99.9%；与控制面独立部署 |
| 检索 P95 时延 | ≤ 3 秒（含上游） |
| 中继写入 → 他人可见 | P95 ≤ 5 秒 |
| 撤权传播（在线设备） | ≤ 60 秒停止新操作 |
| 期限提醒准时率 | ≥ 99.9% |
| 灾备 | RPO ≤ 15 分钟、RTO ≤ 4 小时（控制面与账单；本地事项不在云端持久化） |
| 值守 | G2 起 7×12，公开销售后 7×24 告警 |
