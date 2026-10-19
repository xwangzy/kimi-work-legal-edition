# 中软 fork 补丁台账（kimi-code）

- 基线：`472192c34c1efad89a369870eff0da0b708ce9bb`（tag `@moonshot-ai/kimi-code@2.2.0`，2026-10-14）。2.2.0 由上游“隔离发布分支”出版，
  **不在上游 main 上**（与 main 的分叉点 `c69bd6c5a`）：以 tag 为基线，main 上的提交只按需挑选（见“上游挑选”）。
  上一基线 `f67e6398f`（2.1.1）于 2026-10-19 退役（实施记录：`research/2026-10-19-商用交付评审v9.3/实施-I1-KimiCode-2.2.0-rebase.md`；增量核查：同目录评审 Z2）。
- 方案依据：终版方案 v9.1 第 04 篇 §3.4 补丁台账（ZP-1～18），本表另增 ZP-4b、ZP-19～23（实施中发现，口径见各行）
- 补丁文件：`third_party/patches/kimi-code-2.2.0-zhongruan.patch`，sha256 `468f1518f0ff78c3e6c89c4376264708e58b822fad09ee486afa34b97fe30f65`
  （相对 tag 的 55 个文件：52 改、3 新增；含 #4059 revert、ZP 全部条目、ZP-23 与挑选的 #4066）。`BUILD.json.patch_digest_sha256` 与该文件 sha256 相同
  （构建脚本按 `git diff HEAD` + 未跟踪 .ts 求摘要；fork 的 HEAD 停在 tag、全部改动已暂存且工作区与暂存区一致时二者恰好相等——今后导出须保持这一状态）。
- 导出法（`third_party/kimi-code/` 不入仓，嵌套仓库）：fork 的 HEAD 保持为 tag，改动只暂存不提交，
  `git -C third_party/kimi-code add -A && git -C third_party/kimi-code diff --cached --binary 472192c34 > third_party/patches/kimi-code-2.2.0-zhongruan.patch`（新增文件因已暂存而包含在内）。
- 复现（2026-10-19 实测）：
  ```
  git -C <kimi-code 克隆> worktree add --detach <干净目录> 472192c34
  cd <干净目录> && git apply --check <补丁> && git apply <补丁> && git add -A && git write-tree
  diff -r -q --exclude=.git --exclude=node_modules <干净目录> third_party/kimi-code
  ```
  结果：`git apply --check` 通过；树 `0c4808861774d83ab70b51cb140b143140b6edb8` 与 fork 的 `git write-tree` 相同；`diff -r` 无输出（除 .git、node_modules 外逐字节一致）。
  制品由 `node scripts/build-kap-embed.mjs` 生成，`packages/kap-host/vendor/kap-embed/BUILD.json` 记录上游提交、补丁摘要与制品 hash；
  制品与 inputs.json 不含构建机绝对路径（`?raw` 文本模块记为 `raw:third_party/kimi-code/…`），换目录构建逐字节一致。
- 依赖：2.2.0 相对 2.1.1 的锁文件只删不增（`packages/kaos`、`ssh2` 等），沿用 2.1.1 已安装的 node_modules 即可构建，未联网安装。
- 升级闸门：rebase 到新版本前，**必须核对 #4059（`KIMI_CODE_TRUST_WORKSPACE`）仍被 revert**（2.2.0 与 main 都还带着它；本补丁含 revert，14 个文件）、逐条回归本表；
  `packages/kap-host/test/static-surface.test.ts` 的进程、网络入口与 HTTP 客户端库导入者白名单是精确集合，上游新增入口即失败；
  `embed-drift.test.ts` 锁定 `start.ts` 启动种子段与宿主读取的事件字段、工具入参。
- 质量闸（fork 内，2026-10-19）：`tsc --noEmit`（agent-core-v2、kap-server）0 错误；`scripts/check-no-comments.mjs` OK（1757 个文件，补丁不再带注释）；
  `oxlint`（补丁改动的 49 个 .ts 文件）0 error。上游 vitest 不作为门禁：ZP 条目（宿主策略缺省全部拒绝、默认放行清空、FetchURL 不注册等）有意改变了上游行为，
  抽查 5 个文件 325 条用例中 24 条失败（其中 18 条在只应用 Z2 补丁时就失败，6 条是 #4066 新用例与 ZP-11 不注册 FetchURL 的交互；纯 2.2.0 + #4066 不带 ZP 时同 3 个文件 3 条失败，均在前述 18 条内）。

## 已应用

| # | 级别 | 文件 | 内容 | 原因 |
|---|------|------|------|------|
| ZP-1 | P0 | `agent-core-v2/src/workspace/workspaceAgentProfileLoader/internal/agentRoots.ts` | `projectAgentRoots()` 恒返回 `[]` | 案卷目录 `.kimi-code/agents` 会被无条件加载并注入工具/委派声明 |
| ZP-2 | P0 | `agent-core-v2/src/workspace/workspaceMcpConfig/workspaceMcpConfigService.ts`（2 处） | `includeProject` 写死为 `false` | 项目级 MCP 不加载 |
| ZP-3 | P1 | `agent-core-v2/src/app/plugin/marketplace.ts` | 默认插件市场地址指向黑洞 | 插件安装另由路由白名单关闭；G1 指向中软/律所目录 |
| ZP-4 | P0 | 新增 `agent-core-v2/src/agent/permissionPolicy/hostPolicy.ts`；`permissionPolicyService.ts` | 宿主策略插在策略链首位（每个 Agent 作用域，含子 Agent）；应用级 `IHostPolicyProvider` 默认实现为**全部拒绝**（失败关闭），由宿主种子替换；提供者抛错、返回空或非法结果 → 拒绝 | 上游在构造函数里写死 13 条策略、注册在 Agent 作用域，seeds 覆盖不到；宿主策略永不弃权，其后的 auto/yolo/默认放行永远不被触达 |
| ZP-4b | P0 | `agent-core-v2/src/agent/toolExecutor/beforeToolExecuteEvent.ts` | 执行前钩子的 `allow()` 不再短路其余监听者：只表示“本监听者不反对”，权限闸门（宿主策略所在的策略链）总会裁决；任一监听者否决仍立即生效 | 实施中发现（P1 遍历工具时取证）：上游计划模式对“只写计划文件”的 Write/Edit 调用 `allow()`，计划服务的监听者注册在权限闸门之前——该调用不经宿主策略直接执行 |
| ZP-11 | P0 | `agent-core-v2/src/app/web/webService.ts`、`web.ts`、`agent/tools/fetch-url/fetchUrlTool.ts`、`index.ts`；测试 `test/app/web/tools/fetch-url.test.ts`；（补充，阶段 4）`app/web/providers/moonshot-fetch-url.ts` | 删除托管抓取失败后的本机直连回落与 Kimi OAuth 托管抓取；未配置 `[services.moonshot_fetch]` 时不注册 FetchURL；`index.ts` 不再导出本机直连抓取实现（制品中不再包含该模块及其依赖）。补充：托管抓取（出站闸门）失败时不再调用回落（原先回落到“已禁用”的占位实现，闸门给出的拒绝原因被换成“Direct local fetch is disabled”），错误原样交给模型 | 闸门是唯一出口；模型须看到闸门的拒绝原因（例如 URL 含当事人信息、域名不在白名单）才能改写 |
| ZP-14 | P0 | `policies/default-tool-approve.ts`、`policies/git-cwd-write-approve.ts` | 默认放行清单清空；git 工作区写入自动放行改为弃权（原实现保留为 `evaluateUpstream` 供对照） | 纵深：即使宿主策略被绕过，上游也不自动放行 |
| ZP-16 | P1 | `_base/execEnv/environmentProbe.ts`、`shellPathBridge.ts` | 不再直接执行 `cygpath`/探测命令；环境由宿主种子返回固定值（执行域占位 shell） | Windows 免 Git Bash；探测类调用不绕过进程服务 |
| ZP-17 | P0 | `kap-server/src/lib/fileLaunch.ts`、`features/tower/protocol/git.ts`、`environmentProbe.ts`、`shellPathBridge.ts`、`features/externalHooks/internal/runHook.ts`（改为 `import type`） | 删除或封闭绕过进程服务的 `node:child_process` 直接调用。2.2.0 rebase：`tower/protocol/git.ts` 唯一冲突（上游 #4074 给 `GitError` 加退出码），按“保留封闭实现”解决——`git()` 整段仍为 `throw new GitError(args, 'direct process execution is disabled')`，`node:child_process` 导入删除；`GitError` 的 `exitCode?` 为可选参，不需改 | 静态检查：制品中 `node:child_process` 只剩默认进程服务（由种子替换为执行域路由），见 `static-surface.test.ts` |
| ZP-18 | P0 | `workspace/workspaceInstructions/workspaceInstructionsService.ts`、`app/bootstrap/bootstrap.ts`、`features/skill/workspace/rootFileSkillSource.ts`、`features/skill/catalog/userFileSkillSource.ts` | 工作区指令只从宿主给出的 `trustedInstructionsDir`（签名方法包与只读可信配置区）加载；工作区、案卷目录与 OS home 的 `AGENTS.md`、项目级技能目录不加载、不监听 | 被注入的 Agent 写入 `/work/AGENTS.md` 不能形成持久化注入 |
| ZP-19 | P0 | 新增 `kap-server/src/embed.ts`；`kap-server/package.json` 增加 `./embed` 导出 | 无端口私有嵌入：进程内 `bootstrap` + Fastify `inject()`；内存令牌服务（不落盘）；只注册 sessions、prompts、approvals、questions、tasks、messages、fileHistory、snapshot、transcript 九组路由（终端、配置、工作区信任、插件、OAuth、关机、遥控、文件打开均不注册）。2026-10-14 第 5 批：`bootstrap` 增 `uiCapabilities: ['update_panel']`（宿主有“进展”面板），NotifyUser 随之注册（锁版 `features/notify/notifyUserAvailability.ts`），通知只进过程快照 | 第 04 篇 §1.2 第 4 条“kap-server 不对外、不监听端口”；§3.2 嵌入方式 |
| ZP-20 | P0 | `agent-core-v2/src/os/backends/node-local/tools/rgLocator.ts`、`index.ts` | Grep/Glob 只使用宿主登记的可信 ripgrep（`configureTrustedRipgrep`）；不在 PATH 查找，不从 CDN 下载（下载代码删除）。2026-10-13 起宿主登记的是**宿主内检索入口**（数据根下不可执行的占位文件，执行域路由按字面匹配后在宿主进程内检索；不再随包原生 rg，审计 S3 第 2 步、偏离 D-56），本补丁不变 | 实施中发现：上游找不到 rg 时会从 Kimi CDN 下载并写入用户目录——绕过闸门的直连出网，且 PATH 上的 rg 可能被替换 |
| ZP-22 | P0 | `kap-server/src/lib/promptMedia.ts` | 提示词中按本机路径附加文件（image/video/file 的 `path` 来源）一律拒绝。2.2.0 rebase 改写：原写法在函数中插入无条件 `throw`、其后代码不可达（2.2.0 的 kap-server `tsc` 报 2 个 TS2345），改为遇到任何按路径的部件即抛同一错误，删除不可达代码与随之不用的 `isAbsolute`、`isSensitiveFile` 导入；错误文本不变 | 调研发现：kap-server 用 `node:fs` 直接读取任意绝对路径（只过滤敏感文件名），绕过宿主文件系统种子（事项 broker）；宿主侧 KapClient 只发文本部件，此为“每处独立强制” |
| ZP-9a | P0 | `kap-server/src/transport/ws/v1/sessionEventJournal.ts`、`sessionEventBroadcaster.ts`、`embed.ts`（`eventJournalIo` 选项） | WS 事件日志 `server/events/*.jsonl` 的读写改经可注入的 `JournalIo`（缺省 node fs，上游行为不变）；宿主注入按事项工作区密钥加密的追加日志（`kap-host/src/sealed-storage.ts` `sealedJournalIo`） | 落盘加密第 1 步（2026-10-13 审计 S3）：事件日志是引擎里唯一绕过可注入持久化服务、直接 `appendFile` 的含内容文件；其余（会话转录、状态、文件历史、任务输出、查询库）经种子替换，零补丁 |
| ZP-21 | P0 | `agent-core-v2/src/mcpCore/oauth/callback-server.ts` | MCP OAuth 授权回调监听关闭（`startCallbackServer` 一律失败，不再导入 `node:http`/`node:net`） | 实施中发现：交互式 MCP OAuth 会在本机起 HTTP 监听；宿主不监听任何 TCP 端口，MCP 只用宿主下发的令牌 |
| ZP-23 | P0 | `agent-core-v2/src/human/llm/requester/timeout.ts`；上游测试 `src/human/test/llm/headers-timeout.test.ts` 改为断言封闭行为 | `resolveLlmHeadersTimeoutMs()` 恒返回 `undefined`、`getLlmHeadersTimeoutDispatcher()` 恒返回 `undefined`，不再值导入 undici（只留 `import type`）；三个请求器（anthropic、openai、openai-responses）因而永不传 `fetchOptions.dispatcher`，模型请求一律走宿主全局调度器。首包头超时改由宿主出口设：`kap-host/src/host-egress.ts` 的模型 Agent `headersTimeout: MODEL_HEADERS_TIMEOUT_MS`（300 秒，与 undici 缺省相同，唯一设置点） | Z2 评审 N-1：2.2.0 新增（#4092），设了 `KIMI_CODE_LLM_HEADERS_TIMEOUT_MS` 时为模型请求自建 undici `Agent`/`EnvHttpProxyAgent`，**不经宿主 `HostEgressDispatcher`**（不按会话换任务令牌、不受事项校验）。门禁：`static-surface.test.ts` 的 ZP-23 用例——构建脚本按导入说明符记录每个输入对 HTTP 客户端库（undici、ws、socks 等）的值导入，第一方导入者精确为 `_base/utils/proxy.ts`（其建调度器函数不进制品）；制品中不得出现该环境变量名与按超时建调度器的代码。反向对照：去掉本补丁重建制品，该用例失败（第一方导入者多出 `timeout.ts`） |

## just-bash 3.6.0 自维护补丁（W 执行域，第 04 篇 §4.1“流式回调：对上游提需求，或自维护补丁”）

- 不修改 `node_modules`：`packages/exec-wasm/src/jb-loader.ts` 在 W worker 内读取 `dist/bundle/index.js`，**先核对锁定摘要**
  （`index.js` sha256 `d769656d…cf137`；输出累加器块 `chunk-J2OBOJ64.js` sha256 `b62747dc…7d6c`），每个锚点必须恰好出现一次，
  在内存中替换后以 `data:` URL 装载（块文件以绝对 file: URL 引用，与原包同一模块实例）。摘要或锚点不符 → 执行域失败关闭。
- 升级闸门：升级 just-bash 前逐条核对锚点与语义，更新五处摘要（index.js、累加器块、python3 块、python3 worker、解释器错误类块），并核对 worker 包装的文件系统上限（`OverlayFs` 的读入、复制与内存层检查，`InMemoryFs.assertCanAllocate`/`setEntry`）的错误文本与方法名不变；
  `packages/exec-wasm/test/w-core.test.ts` 的流式输出用例与 `w-s3-regressions.test.ts` 的大文件用例锁定行为；执行域启动自检含一次真实
  worker 往返（echo + python3），任何补丁装载失败即“执行域不可用”。

| # | 位置（打包产物） | 内容 | 原因 |
|---|---|---|---|
| KJ-1 | 解释器构造函数（`var Nr=class{…constructor(t,n){this.ctx={…}}`） | 上下文显式拷贝的字段里加 `onOutput` | 解释器只拷贝列明的字段 |
| KJ-2 | `Bash.execInScope` 构建解释器上下文处 | 只有顶层执行（深度 0）拿到 `exec` 选项里的 `onOutput`；`bash -c`、xargs 等嵌套执行拿不到 | 嵌套执行的输出属于外层语句，不能重复流出 |
| KJ-3 | `executeScript` 入口 | 最外层脚本把自己的输出累加器标记为根并挂上回调；同一解释器内的嵌套脚本（命令替换、子 shell、source、eval）不标记 | 命令替换捕获的输出不得流出 |
| KJ-（运行时） | 输出累加器类原型的 `append` | 成功入账后对根累加器回调（输出超限抛错时不回调） | 顶层语句及其错误输出都经同一入口入账 |
| KJ-4 | python3 命令块 `chunks/python3-SDFCGIU4.js`（sha256 `aaaff389…5fb32`）与其 CPython worker `chunks/worker.js`（sha256 `275994d6…50247`） | 两侧的共享缓冲常量 `DATA_BUFFER` 由 8 MiB 放大到 64 MiB（`TOTAL` 同步）；python3 块的 worker 路径改为修补后 worker 的 `data:` URL，块内相对导入改为绝对 file: URL；worker 内 `import.meta.url` 换成原文件 URL（CPython 入口与标准库的相对解析、路径审批不变） | 审查 S3-14：python3 与宿主虚拟文件系统之间经一块固定 8 MiB 的共享缓冲交换数据（打开时整读、关闭时整写），超过 8 MiB 的文件读入报“文件不存在”、写出报 I/O 错误（`print` 之后析构时失败、退出码仍为 0）或挂起到超时 |
| KJ-4（续，复核 S3-18/S3-20） | 同一 worker | 错误码表 `EFBIG: 27` 改为 `22`（Emscripten 的 27 是 EINTR，CPython 把“文件过大”当作被中断的写入无限重试——超过缓冲的写出挂起的根因）；超过缓冲的读入报 EFBIG（原为“文件不存在”）；EFBIG 的各抛出点先 stat 保留路径 `/.kwl-limit/<类别>`，由 worker 拦截记录为执行域上限 | 上限须有结构化信号；挂起须改为明确报错 |
| KJ-（运行时，复核 S3-18） | 解释器错误类块 `chunks/chunk-EFORKKSH.js`（sha256 `cb672598…c0be2`）导出的 `ExecutionLimitError`、`ExecutionAbortedError` | 装载后在两者的原型链上插入记录器类（`super()` 按原型动态解析，不改打包产物）：构造上限错误即记录；非宿主发起的中止错误记为 deadline，**只作诊断**——时限由 worker 自身计时判定（第二轮复核 S3-27：命令自身返回 124、`timeout N cmd` 不算执行域时限） | 各命令自己捕获上限错误并返回 126，stderr 文本不可靠（漏判与误判都已复现） |
| KJ-（运行时，第二轮复核 S3-26、抽查 S3-30） | `OverlayFs`（工作区与只读挂载）与 `InMemoryFs`（内存文件系统）实例 | 在 worker 内的实例上包装其类的全部方法，抛出 `ENOSPC: … byte limit exceeded`（内存层、内存文件系统字节上限）或 `EFBIG: file too large…`（单文件读入、复制、写时复制上限）前记录为执行域上限（撞限即整体不写回、退出码 126）；`readFileBuffer`、`assertMemoryCapacity`、`assertCanAllocate`、`setEntry` 缺失即拒绝运行 | 这些上限抛普通 `Error`，不经上限错误类；命令捕获后只报“文件不存在”或 I/O 错误，python3 还会在析构时吞掉（退出码 0），已有文件被 0 字节版本覆盖（均已复现） |

粒度如实：顶层语句结束即流出；单个命令（例如一次 `python3`）内部的输出在该命令结束时一次给出。

KJ-4 之后的数据规模口径：单个文件经 `python3` 或 `awk` 读入的上限约 64 MiB（同时由 `maxStringLength` 约束）；hardened 档的其他规模上限
（输入总量、行数、数组元素、CSV 行与单元格、数据库）在 `worker.ts` 中按同一量级放宽，时长、内存与提交上限不变。

## 免补丁（种子、配置与宿主实现）

| 方案编号 | 机制 | 位置 |
|---|---|---|
| ZP-8 远程控制关闭 | 嵌入入口不注册遥控路由；业务 API 不提供远程入口（以中软设备中继 + 业务网关替代，G2） | `embed.ts`；`packages/kap-host` |
| ZP-12 终端关闭 | `IHostTerminalService` 种子为拒绝实现；终端路由不注册 | `packages/kap-host/src/seeds.ts` |
| ZP-15 环境变量白名单 | 执行域路由不透传引擎给出的环境变量（执行域只收空环境 + 执行域自身白名单：HOME、PATH、LANG、TERM、NO_COLOR、TMPDIR 等固定值）；W 进程本身不继承宿主环境；可信 rg 以最小环境启动、stdin 关闭 | `packages/kap-host/src/exec-router.ts`、`packages/exec-wasm/src/{host,domain}.ts` |
| 模型可见的执行环境说明（§4.1） | 经可信指令通道（ZP-18 的 `trustedInstructionsDir`）以内存文件提供“受限 bash”说明；有签名可信区时与其 AGENTS.md 合并；上游系统提示原句（“the Bash tool executes commands using bash …”）保留 | `packages/kap-host/src/matter-engine.ts` |
| 进程与文件系统 | `IHostProcessService` → 执行域路由；`IHostFileSystem` → 事项文件 broker（材料只读、工作区可写、可信区只读）；`IProjectLocalConfigService` → 只读空实现 | `packages/kap-host/src/seeds.ts` |
| 出网 | 宿主全局调度器只认 `gate.kwl`/`tools.kwl`，模型请求按会话换任务令牌；`NODE_USE_ENV_PROXY=1` + 黑洞代理 | `packages/kap-host/src/host-egress.ts` |
| 遥测 | `telemetry = false` | 宿主生成的 config.toml |

## 待实现

| 方案编号 | 状态 | 说明 |
|---|---|---|
| ZP-7 回移 2.1.0 工作区加固 | 评估中 | 锁版为 2.1.1，需逐项核对 2.1.0 加固是否覆盖 agent-core-v2 路径；kap-host 的文件访问全部经 broker（按分量与对象身份校验），git 配置执行由 ZP-17 封闭，配置信任由 ZP-1/2/18 覆盖 |
| ZP-9 加密落盘扩面 | 第 1、2 步已实现（2026-10-13） | 第 1 步：会话转录、会话与计划状态、文件历史快照、后台任务输出（`IFileSystemStorageService` 种子替换为 `SealedFileStorageService`）、查询库（`IQueryStore` 换内存实现，宿主重启后全量重建）、事件日志（ZP-9a）、引擎状态区（broker engine 区 codec）均为 KWE1 密文；引擎文件日志关闭；材料快照与执行域临时目录运行结束即删除；存量明文在引擎打开前迁移。第 2 步：工作区与材料快照透明加密——**零 Kimi Code 补丁**：Grep/Glob 的 rg 调用在本方执行域路由（`IHostProcessService` 种子）里交宿主内检索（`kap-host/src/search/`，与 ripgrep 15 差分一致）；W 读层在本方 worker 内对 just-bash OverlayFs 实例包装（不改 just-bash 打包产物，无新的 KJ 补丁；路径规范化块按摘要装载）；见 `docs/audit-2026-10-13/设计-工作区与会话落盘加密.md` §5.2 与文末实施记录 |
| ZP-13 实验开关锁定 | 待实现 | Tower、SUBAGENT_FORK、TOOL_SELECT 关；NOTIFY_USER、WAIT_FOR 开；以宿主进程环境与生成配置锁定，宿主策略对 Tower*/select_tools 一律拒绝（纵深已生效） |

## 历史（v5 形态，保留溯源）

- v5 的 SDK 宿主以 `[tools] enabled = ["mcp__legal__*", …]` 关闭全部内置工具，“2.1.0 工作区加固”当时评估为“风险经工具面归零缓解，不回移”。
  v9 起开放任务改由 kap-host 承载并开放 Read/Write/Edit/Glob/Grep/Bash，**该例外失效**，改列为待实现的 ZP-7。
- v5 待办“ZP-4（备选）：SDK 层经 engineAccessor 接线 addRules() 兜底 deny”已由 v9 的 ZP-4（策略链首位）取代。

## 上游挑选（2.2.0 tag 之后，main 上的提交）

| 提交 | 内容 | 处置 |
|---|---|---|
| `85077a419` #4066 | 子 Agent 工具描述与实际可用性对齐（`toolActivation/toolAvailability.ts`、`agentTool.ts` 等） | **已挑入**（`git cherry-pick -n`）。产品代码干净；两份上游测试（`test/agent/loop/loop.test.ts`、`test/tool/tool.test.ts`）的快照冲突按 #4066 一侧解决；`.changeset` 文件不收。宿主拒绝表外工具，描述与可用性一致可减少子 Agent 调用被拒的空转 |
| `da5918c0c` #4239 | 提醒 Agent 维护待办清单 | **不挑**：改系统提示 `system.md` 与待办提醒频率、新增遥测事件；宿主“进展”面板读 TodoList 现已可用，收益不足以抵消未经 kap 用例验证的提示词变化。另行评审后单独挑 |
| 其余（#4190、#4242、#4250、#4210、#4188、#4171、#4209、#4224、#4019） | 见评审 Z2 §1.8 | 不跟进 |

## 已移除

| # | 移除时间 | 说明 |
|---|---|---|
| ZP-5/6 | 2026-10-19（2.2.0 rebase） | 原内容：`node-sdk/src/types.ts`、`sdk-rpc-client-v2.ts`、`index.ts` 让 SDK 路径 `extraSeeds` 透传到 `bootstrap` 种子末尾并再导出 DI 标识。SDK 宿主已退役（仓库内只有 kap-server 嵌入路径 `createEmbeddedServer({seeds})`；旧制品 inputs.json 中 node-sdk 输入为 0），三处文件恢复上游原样 |

## 已知事项

- 历次 ZP 补丁中的约 20 处注释（复核 S5B-16）已在 2.2.0 rebase 时全部从源码删除，意图以本台账为准；fork 的无注释 lint 通过。
- 上游仍 open、未合并的相关缺陷：#4193（同一步多个大工具结果使压缩请求超窗）、#2337（配置权限规则不生效）、#4070（后台子 Agent 审批不触发 PermissionRequest 钩子）。见评审 Z2 §1.3。
- 2.2.0 新增 Tower 工具 `TowerComplete`、`TowerRebase` 已列入宿主 `LOCKED_OFF_TOOLS`（`kap-host/src/tool-table.ts`）；NotifyUser 新增可选 `title`，宿主过程快照把标题与正文合成一条（`progress.ts`）。
