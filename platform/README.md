# Kimi Work 法律行业发行版 · 平台工程（v5.0 本机内核）

依据：`research/2026-10-01-本地执行方案v5/`（方案 v5.0，2026-10-01 定稿）第 4 篇「技术架构与研发计划」。

> **本地执行，云端推理（大所可选律所内私有模型）。** 事项、材料、规则、执行、核验、审批与审计都在律所侧（律师电脑与可选的所内节点）；中软云端不持有业务数据，模型推理只经中软 MaaS 的法律专用 token 通道，且只发送经化名校验的必要片段；每一次外发都记入数据去向卡。
>
> 诚实边界（§16.1）：本工程是 G0 开发骨架，在合成/示例材料上跑通核心链路，用于设计合作律所签约与联合立项。密钥体系与页级加密已接入（见下「已完成」），但为 **G0 开发形态**：根私钥以 0600 文件存放、恢复份额同机落盘（生产为离线恢复码 + 合伙人分持离线保管）、材料块静态加密未做（G1）、`im_witnessed` 尚不可产生（需所内节点 IM 见证）、一人一台设备。**不宣称**已完成兼容矩阵、全部合规手续或全版本 Office。默认离线 mock 模型提供方（无网络外发）；真实链路配置端点后启用，链路不变、出站一律经出站闸门。

## 架构（§1/§15.1）

```text
桌面客户端（Electron 44，renderer 沙箱）──IPC──▶ 本机法律内核（utilityProcess / 独立 Node 24 同一份制品）
  内核内：事项账本（SQLite，页级加密已接线）· 本地持久任务队列 · 确定性工作流（S1/S1b/S2/S6/A1）
        · 密钥体系（律所根密钥/设备证书/事项密钥/恢复托管分持）· 签名事件 hash 链（每日链头检查点）
        · 法律工具（内核内模块，MCP 端点供 Agent）· 本机模型代理（路由/档位/计量/幂等 ID/nonce）
        · 出站闸门（白名单/事项策略/化名校验/数据去向记录）
  Agent 宿主（每任务一进程；阶段 1 为 agent-runtime 过渡形态）──127.0.0.1──▶ 内核本机端点（/mcp、/v1）
```

| 模块 | 内容 | v4.0 → v5.0 迁移（§15） |
|------|------|--------------------------|
| `packages/domain` | 领域对象与状态机 | 投影视图结构；`processing_mode` 由 **模型端点 × 协作范围 × 当事人同意** 取代（§4.2） |
| `packages/docx-engine` | 文书引擎（修订/比对/净化/遮盖/生成） | 不改（§15：G1 与 Docxodus 同台评测） |
| `packages/design-tokens` | 设计令牌 | 不变 |
| `packages/pseudonym` | 化名引擎 v0（第一遍规则） | 新增（§8.2；出站闸门与 redact 工具共用） |
| `packages/egress` | 出站闸门 v0 | 新增（§8.3：白名单/事项策略/化名校验/数据去向记录） |
| `packages/model-broker` | 本机模型代理 | 由 `services/model-gateway` 迁移：上游改 MaaS/自带密钥/私有端点；nonce + 客户端幂等 ID；化名校验移入出站闸门 |
| `packages/keys` | 密钥体系密码学核心 | 新增（§5.3：纯函数 + Node 内置 crypto，零依赖；恢复码派生根密钥/设备证书/ECIES 事项密钥包裹/Shamir 分持） |
| `packages/kernel` | 本机法律内核 | 由 `services/bff`（PostgreSQL→SQLite、DBOS→本地任务队列、HTTP→IPC）与 `services/tool-gateway`（内核内模块，保留 MCP）合并迁移 |
| `services/agent-runtime` | Agent 宿主（过渡形态） | 阶段 2 迁移为 `apps/agent-host`（命名管道 + ZP-5/6） |
| `apps/desktop` | Electron 44 + React 19 | API 层 HTTP→IPC；新增数据去向卡、模型端点/协作范围/当事人同意口径 |
| `db/`（已删除） | — | PostgreSQL 迁移脚本 → `packages/kernel/src/migrations`（SQLite） |

## 已完成（G0 第 1–2 周口径，§16.2）

- `platform/` 迁移为本机内核：SQLite 事项账本（含数据去向记录表）、本地持久任务队列（步骤检查点 + 崩溃恢复 + 协作式取消）、内核 API（§15.2 方法表）、Electron utilityProcess IPC；
- 本机模型代理：路由/档位/计量/客户端幂等 ID/`X-Msh-Request-Nonce`；三种模型端点（标准 MaaS / 自带密钥 / 私有模型）按事项选定；mock 提供方离线可跑且如实记录；
- 出站闸门 v0：目的地白名单、事项策略（当事人同意「待取得/已拒绝」、端点「不使用模型」、strict 保密）、化名校验（block/replace）、逐段数据去向记录；
- S1/S1b/S2/S6 确定性工作流 + A1（隔离 worker 真实引擎）在新内核上跑通；36 项内核测试 + 2 项 A1 真实引擎链路测试全绿；
- 桌面：事项口径（端点/范围/同意）常显与变更留痕、材料导入/挂载、数据去向卡（任务与事项两级）。

阶段 1a/1b（密钥体系接入，§5.2/§5.3/§6.3/§6.4）：

- `packages/keys`：律所根密钥（恢复码 HKDF 确定性派生）、scrypt 口令包裹、设备证书签发/验签（Ed25519+X25519）、事项密钥 ECIES 包裹、Shamir M-of-N 分持、破窗记录——21 项测试；
- 签名事件 hash 链：run_events / audit_events / egress_records / approvals 四类业务行在同事务追加签名见证（Lamport、密钥纪元、吊销检查点 hash、prev/event hash、设备签名）；`audit.verifyChain` 全量重放（业务行重算 payload hash、断链与验签、设备证书链与归属核对）；每日链头检查点（手动 `audit.checkpoint` 同接口）——采用哈希校验技术，时间戳锚定后续阶段，不宣称司法存证效力。egress_records 签名信封排除插入后可变的生命周期列（request_id 回填、outcome/note 失败标记），数据去向关键事实（目的地、归属、字符数、化名统计）在信封内；
- 设备签名签发（§6.3）：`review.approve`（approved）重算最终字节 hash → 设备私钥签 `signed_payload`（含完整性单 hash、密钥纪元）；`approvals.verify` 出证明包（signed_payload/签名/设备证书/律所根公钥），第三方可不依赖数据库离线验签；外发只认 `device_signature`；`im_witnessed` 本机不可自证（422）；
- 密钥纪元与撤权：`devices.revoke`（管理员/合伙人）推进 tenant 纪元；`assertIncomingEventAcceptable` 实现「撤权校验不依赖时钟」（供同步入口）；`matters.members.add/remove` 补包裹/轮换事项密钥（旧纪元行保留）；`matters.exportLedger` 开放导出（事件 JSON Lines + 设备证书 + 签发证明包；**不含链检查点与私钥材料**，检查点可经 `audit.checkpoint` 另行落库核对）；
- 页级加密接线（§5.1）：主密钥经 Electron safeStorage 异步 API 解封一次性交付内核（主进程随即清除；`kernel.init` 握手，10 秒超时降级明文开发库并如实广播）；开发可用 `ZR_DB_KEY`（**仅开发用**）；既有明文开发库与设 key 冲突时如实中文报错（G0 库可弃）。

阶段 2（离线法规版本库 v0，§9、第 5 篇 §2）：

- `packages/lawdb` + `content/lawdb/`：签名只读 SQLite 法规库包（法规/条文/公布施行修改失效日期/效力状态/条号迁移表/官方链接；每条记录带公报期号、页码、采集日期字段——结构即人工采集契约）；content_sha256 覆盖内容表（易变的 built_at 不进签名，同源重复构建同 hash）+ Ed25519 签名 sidecar manifest；验签或哈希不符即拒绝加载（`lawdb_invalid`，不静默降级到任何种子）；增量包格式 + 签名验证 + apply（复制→apply→校验→原子替换；合并后全量哈希不符即回滚）；
- 法条核验全部离线并迁移到签名包：名称归一（书名号/空白/全半角）、条号存在性、按适用时点取版本、效力状态、条号迁移（机制由测试夹具验证，随包无虚构版本）；案号粗粒度提取 →「未核实（离线）」（覆盖边界如实注释）→ 该引用不得进入签发版（`review.completeness` blockers + `review.approve` 409 `unverified_citations`）；`lawdb.status`（法规库最后更新日）；加载留痕上链。**覆盖边界**：引用核验步骤 G0 只挂在 S1 默认路径；S1b/S2/S6/A1 成果的案号引用暂不受该门禁约束（W10 补齐，见缺口清单）；
- Source Registry 运行时强制（§2.2）：`citations.verify`/`law.get_version` 展示动作、`deliveries.create` 导出动作逐来源校验 `source_license_id + allowed_action + valid_until`，不足即 403 `source_action_denied`，不让模型补全未获授权内容；
- **演示种子如实标注**：随包覆盖 3 部法律（律师法 2017 修正本、民法典 509/585/587、劳动合同法 23/24/47）+ 仲裁法增量演示；公报期号/页码为示例值（非真实采集）。条号迁移（38→41）只在测试夹具 `content/lawdb/test-fixtures/` 里（虚构的《律师法》2026 修正本，v9.4 第 19 批起不随包分发）；首批 100 部官方公报人工采集是法律工程任务（G0 30 天行动），非本工程交付；商业源未签约零入库；每日增量为格式 + apply 演示，非真实每日构建。

阶段 3（本机解析与 OCR，§8.1/§13/§4.5）：

- `packages/parse-ocr`：PDF 文本层（pdfjs-dist legacy，页数/尺寸防护 `parse_unsafe`）+ 扫描页 PDFium 渲染（自适应 scale，长边 ≤2000px）+ @napi-rs/canvas 图片解码 + **PP-OCRv5 mobile**（det/rec + ppocrv5_dict，RapidAI 转换 ONNX，全链 Apache-2.0，ModelScope 拉取并 SHA256 校验）；Node 封装选型 **ppu-paddle-ocr**（实证可用：显式本地模型路径、离线不联网、行级置信度即质量信号；v5 模型必须配 ppocrv5_dict——ppocr_keys_v1 错配实证乱码）；
- 隔离解析进程（每批次一个，NDJSON 协议，串行页级流水，每页报 rss）：页超时杀进程、崩毁自动重建、**OCR 页预算续跑**（默认 10 页/进程——实证 WASM/位图每页 ~50–80MB 递增，预算触发换进程归还 OS；budget=2 时 6 页批峰值 827MB）；低质量页可见/可重扫/可人工纠正（`materials.reparse` 生成新解析版本，原件 hash 校验不变）；模型缺失如实标 unreadable + 「本机 OCR 未就绪」，不伪造文本；
- 内核集成：PDF/JPG/PNG 解禁；`parse_pages` 页质量落库（0003 迁移）；parse_texts 以 `\f` 换页分隔 → 证据锚点带 `file_page`；S2 质量报告/补证清单列出低质量与不可读页；**Agent 与 OCR 内核级互斥**（§4.5 一把 AsyncMutex，宿主存活期间持锁）；`kernel.status` 显示 OCR 就绪态；
- 数据红线：OCR 全程本机零外发（引擎只读本机模型；测试断言含扫描件任务 egress 仅 mock_local）；扫描件/图片默认不发模型厂商的现状不变；印章/手写/复杂表格只做质量标记的现状不变；
- 实测（`scripts/bench-ocr.mjs` → `output/bench-ocr-2026-10-02.json`）：20 页合成扫描件真实模型——页均 325ms（目标 ≤2s/页 ✅）、识别均值 0.90、峰值 1612MB（§13 目标 ≤1GB ❌——macOS arm64 开发机基线 ~1.2GB（Node+pdfium+onnxruntime 双会话），页预算机制封顶长文档增长；**探针 8 正式验收在 Windows i5 参考机，未达标时按方案建议转所内节点执行**）。

阶段 4（A1 本机 Kimi Code 链路收尾，§4.2/§4.3/§16.3 探针 1–3）：

- **签名法律 Agent profile（失败关闭）**：`content/agent-profile/legal-agent.md`（tools = `mcp__legal__*` + 四个交互工具、`subagents: []`；行为准则：计划先行/依据可回链/产物只能是草稿/不越权不外发），复用内容签名密钥签名（`build:agent-profile`）；A1 每任务组装时验签 → 副本注入任务 homeDir（任务结束清除）→ 宿主 `createSession({ agentFiles })`；验签失败/文件缺失 → 任务直接失败 `agent_profile_invalid`，spec 缺 agentFile → 宿主拒绝启动退出（双层失败关闭，不静默用引擎默认 agent）；
- **探针 1**：纯管道生命周期（已有）+ 取消（runs.cancel → 宿主退出、attempts 收尾、`run.cancelled` 落账、已取消 rid 的任务令牌经管道请求一律 401）+ 崩溃恢复（现场重构 → recover → interrupted + 新尝试整任务重跑到 succeeded、事件 seq 无重复）；A1 恢复粒度修正为任务级（agent_start/agent_wait 不落检查点，见 executor 注释）；另修一处既有缺口：API 先置取消时 markTerminal 早退导致 attempts 残留 running 且无终态事件；
- **探针 2**：local-server 非白名单路径（除 /healthz、/v1/models、GET|POST /mcp、/v1/chat/completions 外）请求计数器，A1 全程后 === 0（零外连行为证据，kernel.status.local_server 可见并留前 10 条路径取证）；取证实录：引擎 MCP 客户端对 /mcp 有一次 GET 握手探测（Streamable HTTP，回退 POST 正常），内核按协议回 405 并列入白名单——非遥测/更新外呼；**MCP 面按声明子集收窄**：tools/list 只返回 A1 工具面（`LEGAL_MCP_TOOLS`，@zr-legal/domain 单一出处，agent-host 同源再导出），白名单外 tools/call 一律 -32601 拒绝并计入取证计数器（不依赖引擎侧单层 enabledTools；覆盖点 a1-agent.test.ts「MCP 面按声明子集收窄」用例）；`[tools] enabled` 精确白名单断言（内置 Read/Write/Bash/Agent 等双不可见）；
- **探针 3**：隐藏 skills（.kimi-code/skills 与 .agents/skills 投放）不加载无痕迹；快照内容断言（只含派生文本、无 PK/%PDF 原件字节）；材料导入遇符号链接如实拒绝（不跟随，import/mount 均拦截）；路径穿越压缩包解析前拦截（zip.ts，docx 伪装包用例）；既有注入用例（伪系统指令/.kimi-code/agents/.kimi-code/mcp.json）保持全绿；
- ~~**agent-host 制品**~~：v5 SDK 宿主（`apps/agent-host`、`agent-host.bundle.mjs`）已于 2026-10-15 退役（Kimi Code 增量核查 K9-1）；开放任务只由 `packages/kap-host` 承载，旧红队 34 例迁到 P12 运行器（`content/redteam/cases/dev-v0/`）。

阶段 5a（材料块加密收尾 + 同步协议核心 + 节点授权 + 恢复演练，§5.1/§5.3/§7/§16.3 探针 11）：

- **材料块按事项密钥加密（§5.1 收尾）**：hash 仍按明文内容寻址、落盘字节为自描述封装（`KWB1` magic + epoch + matter_id + nonce + ct + tag）；**按事项命名空间隔离**（`blob://<matter>/<sha256>`——跨事项不复用密文块，读块只需本事项密钥，伦理墙完整）；读写对调用方全透明（deliverables/签发重算/下载/导出/OCR 照常）；密钥轮换后旧块按块头旧纪元解密、新块用新纪元（不重加密旧块——旧成员曾持有旧密钥）；无事项归属的内部块走 `_shared` 明文例外并注释；既有明文开发库可弃（README 早已声明），不做过渡迁移；
- **共享文件夹同步 v0（§7.1/§7.2，`packages/sync` + 内核 sync-engine）**：段 = 一台设备一批事项事件（header 明文含设备证书、key_rows 密钥分发通道、body 按事项密钥 AES-256-GCM、footer 双 hash + 设备签名——只认已封口段）；目录纪律「临时名→原子改名」，`.tmp-*` 半成品忽略、`.sync-conflict-*`/`conflicted copy`/`*冲突副本*` 命名分类告警，共享目录绝不放 SQLite/锁文件；合并：append-only 表 INSERT OR IGNORE，状态类按**行级 origin 归属权威**（本机无行则入并记 origin；同一 origin 设备较新才更新；origin 不同保留本机行——内容一致的 A→B→A 回波免告警，内容不同记 origin_conflict 且 sync.status 透出计数），**并发同版本成果保留双版本 + sync_conflicts 旗标 + conflict.detected 审计**；**成员墓碑 + 作者权威**（member_rows 摄取三道检查：author_device 须等于段签名设备（防借名）、既有事项作者须为未墓碑 owner 成员设备（非 owner 不得变更成员集）、首同步仅由创建设备的段携带成员行（多跳转发不扩成员）；满足后按 (row_lamport, author_device) 较新者胜——恶意内部人以合法证书伪造大 lamport 成员行翻墓碑的路径已按「实验 C」复刻用例闭合；**残余如实声明**：恶意 owner 重新 add 被移出成员是合法管理动作，伦理墙防的是非 owner 成员与「管理员单人」，防不了在任 owner 的合法权限）；撤权回填拒收（不依赖时钟）；**只同步团队事项**，个人事项与无权限事项零字节出/入本机；本机 SQLite 即权威（全量重放建库 G1）；API：`sync.export/import/status`；`ZR_SYNC_SHARE_DIR` 配置后内核起同步定时器（默认 30s，audit 只记异常）且 `runs.node_enqueue` 内联导出一次（收敛窗口收窄）；
- **节点逐事项授权（§5.3 服务成员）**：`matters.node_authorize/revoke`（owner 角色；strict 保密等级强制拒绝）；v0 节点设备与桌面同机引导（同一律所根下独立 node-device.json）——authorize 即把当前纪元事项密钥包裹给节点设备、revoke 删除当前纪元包裹（旧纪元已持密钥如实说明）；**跨机器节点加入流程 G1**；
- **恢复演练（探针 11 两项）**：`recovery.restore_matter`（份额文件 → combineRecoveryPrivateKey 校验 → 解 recovery 包裹 → 包裹给当前设备 + createBreakGlassRecord 破窗审计；`rotate=true` + `revoke_device_ids` 支持恢复即轮换（新纪元只包裹给有效成员减去吊销候选——设备丢失场景的推荐路径，测试实证 bob 解不开新块）；默认不轮换时 note 含吊销/轮换提示）；`recovery.export_device/import_device`（scrypt 口令包裹设备私钥，错口令 bad_password）；`recovery.status` 演练计数（开通强制演练的产品要求在 G1 激活流落实）。

阶段 5b（所内节点 headless 形态，§2/§5.1/§7.4/第 2 篇 §5）：

- **`apps/firm-node`（同一内核的无界面形态）**：`startFirmNode`（独立 workspace + env/JSON 配置）= 同一 createKernel + 服务环（unref 定时：sync.export → sync.import → 节点执行队列 → 到期定时任务；异常只告警不退出）+ **局域网管理控制台 v0**（默认 bind 127.0.0.1 + bearer token；GET /status、/matters（仅授权事项、字段脱敏不含标题——LAN 化前复核脱敏清单）、/audit/tail（元数据无正文）、/jobs；**无写端点**——POST 一律 405；LAN 部署与双向证书认证属 G1）；ESM 制品 `firm-node.bundle.mjs`（build:kernel 产出，ZR_NODE_CONFIG 指定配置）；
- **节点执行（§5.1 转交任务）**：`runs.node_enqueue`（入队即验 node_allowed=1 且非 strict；幂等 task_id 由 (tenant, idempotency_key) 派生，同键返回原任务）+ `node_tasks.list`（执行状态经 runs 行收敛——节点侧 start 的 idempotency_key 前缀关联，任务级状态双向收敛在 G1）；节点侧拾取走**租约**（UPDATE 条件原子生效：并发 10 抢恰好 1 胜、过期可接管，§7.4 语义 v0）→ 执行前 `assertNodeTaskAllowed` 再验（**入队/同步/执行三处独立门禁**：未授权/strict/伦理墙事项零字节到节点）；authorize 同时把节点身份登记为事项 viewer（§5.3「节点是显式的服务成员」）；**viewer 最小权限**（`requireMatterWriter`：事项级写方法要求有效成员且非 viewer——viewer 一律 403；节点身份豁免：role=node 的设备对 node_allowed 事项可写，权限来自授权而非成员角色）；结果经同步回桌面（run/成果行到达，测试实证桌面可见）；
- **定时与批量 v0**：`jobs.create/list`（deadline_reminder 到期提醒按标记去重不重复生成、matter_weekly_report 简文本草稿（S13 正式路径 W12）、lawdb_watch 版本变化提示（法律之星变更追踪属签约后工作））；cron_expr 以间隔秒替代（cron 解析 G1）；产物草稿，IM 通知投递属阶段 6；**job 审计事件统一经签名漏斗上链**（与同步冲突事件同路径，signed_events 见证有测试断言）；
- **v0 边界如实声明**：MaaS 席位令牌在 G1 许可流落实（v0 节点用与桌面同配的本机模型代理/mock）；跨机器节点加入流程 G1；主备仅租约语义（IM 双活、飞书钉钉主备、故障 15 分钟接管属 G1）；桌面 Matter 页「转到所内节点」入口（已授权事项可用）。

阶段 6a（IM 入口原型，第 2 篇 §9、第 4 篇 §11.2、探针 14 v0）：

- **`packages/im-connectors`**：`ImConnector` 契约（单聊收文件、卡片回调 `respondWithinMs` 内同步应答「已收到」、sendCard/sendFile/updateCard、离线事件回调——契约注释固化方案约束）；**钉钉 Stream 骨架**（按公开文档形态：WS 长连接、注册/心跳/指数退避重连、「下载码换取文件」分片协议占位——真实凭据与联调属部署工作）；**平台模拟器（模拟器非平台）**：本机 WS 服务器模拟单聊文件/文本/卡片动作/分片下载/卡片更新与三平台离线语义（钉钉丢消息计数、飞书重推队列、企业微信单连接踢线）；
- **节点侧 IM 运行时（firm-node/im-runtime）**：`im_connector_lease` 租约选主（双连接器实例拒绝启动、过期接管；飞书/钉钉双活属 G1 声明）；`im.bind/list/unbind` 绑定发送人↔成员（验证成员存在、留痕）；收文件对话流：单聊校验 → 绑定校验 → **卡片列最近 3 个已授权节点的事项（strict/未授权不入列；文案硬脱敏——事项以序号+短 ID 呈现，测试断言卡片不含客户名与事项标题）** → 选择（**非本人点卡片拒绝——群转发不扩权**）→ 入库 → `runs.node_enqueue` → 回执（只报进度事实）；高敏事项引导桌面处理；
- **IM 确认（§6.3）**：`approvals.request_im`（受众门禁 internal/client，court/counterparty 一律 422；事项门禁仅 node_allowed）→ 节点把**确切待交付文件单独发给签发人** + 审批卡 → 签发人确认（**2 秒硬限内同步应答**，异步落库）→ 节点服务密钥签 `assurance_level='im_witnessed'`（witness 含确认人/时间/文件 hash/节点见证；复核资产 hash 防调包）→ 更新卡片 + 结果经同步回桌面；`approvals.verify` 对 im_witnessed 返回 valid + `assurance_note`（低于设备签名、适用边界）；**外发门禁不变**（deliveries 只认 device_signature，im_witnessed 一律 409，有测试）；
- **数据去向（§8.3）**：egress_records 扩展 `im_inbound/im_outbound`（0008 迁移重建 CHECK；文件名、hash、发送对象 im_user_id 哈希化、平台）——数据去向卡自然带出 IM 流转（0008 另含 im_bindings/im_intents/im_connector_lease，im_intents/bindings 已入同步表）；
- **v0 边界如实声明**：一家平台骨架（钉钉 Stream）+ 模拟器验证，真实平台联调与凭据属部署工作；卡片选择窗口内文件字节存内存（重启失效请重发，持久化在 G1）；真 100MB 与真机卡片属联调；飞书/钉钉双活 G1；小程序个人微信 G3。

阶段 6b（A1 注入红队 v0 + G0 演示脚本与自动化演示路径，§16.2/§16.3 探针 3）：

- **红队 v0（原 `packages/kernel/test/redteam.test.ts`；2026-10-15 K9-1 起为 P12 研发 v0 用例 `content/redteam/cases/dev-v0/`，kap 整链运行）**：(a) 间接提示注入分类用例集 **34 例**（合成文本，六类：诱导外发/诱导越权读/伪签发伪审批/伪工具指令/载体变体/编码语言变体）——每例作为案卷材料经 A1 任务（真实引擎 + mock 提供方）跑通，硬断言：任务不失败崩溃、审批与工具事件只在白名单、该事项去向记录只有 `mock_local`、零非白名单出站请求（local_server 计数器）；(b) 被注入模型系统级红队——mock provider 新增**脚本化响应注入点**（双重门禁：进程须设 `ZR_MOCK_SCRIPT=1` 且测试显式调用 `__setMockScriptForTests`；生产路径两者都不做，缺省行为逐字节不变），模拟「已听话的模型」请求内置 `Bash`（引擎执行层 tool not found、零审批事件）、跨事项 `materials.read_excerpt`（控制面按前缀放行，**内核工具层按令牌 claims.mid 再校验** → not_found 不泄露存在性，受害秘密零泄漏）、不存在的 `mcp__legal__exfiltrate`（引擎层拒 + 内核面 -32601 计数直接复核）；(c) 红队报告对象输出（counts by category + 零越权/零非白名单出站/零外联硬断言）。**口径：v0 用例集 34 例；≥300 例注入与越权红队专项属 G1（第 3 篇 §7.1），本阶段不宣称达标**；
- **红队顺带修复**：mock provider 对数组形态消息内容（工具结果回喂）曾 500「text is not iterable」——`estimateTokens`/`prefixKey` 统一经 messageText 归一；agent-host 事件转发补 `errorName/errorMessage/statusCode`（重试/失败原因可见，红队取证用）；
- **演示脚本与自动化演示路径**：`docs/演示脚本-G0.md`（八镜分镜，每镜注明测试/脚本证据锚点；录像为人工工作声明）；`scripts/demo-e2e.mjs` + `npm run demo:e2e` 一键跑标准演示用例并打印证据（核验拦截 JSON、2026-08-31 时点对照、去向卡摘要、签发证明包与改一字节失效、audit.verifyChain），退出码非零即失败；
- **总验收自查**：`docs/探针映射-G0.md` 把 §16.3 十四项探针逐条映射为「已自动化（锚点）/需 Windows/需真平台/需真 MaaS」四类（如实声明：已自动化 ≠ 探针已验收）。

## 运行

```bash
# 准备（本机需 Node ≥ 26 开发运行时；制品目标 Node 24）
export PATH="$HOME/.nvm/versions/node/v26.8.1/bin:$PATH"
export ZR_INTERNAL_SECRET=<任意 ≥16 位开发密钥>
npm install
npm run build:lawdb   # 构建签名法规库包（content/lawdb/dist；npm test 的 pretest 自动执行）
npm run fetch:ocr-models   # 拉取本机 OCR 模型（content/ocr-models；SHA256 校验；缺失时 OCR 路径如实标 unreadable）
# node scripts/bench-ocr.mjs  # OCR 基准（真实模型，20 页扫描件 → output/bench-ocr-<date>.json）

# 纯浏览器调试（vite + 开发桥：内核进程内）
cd apps/desktop && npm run dev:web   # http://127.0.0.1:5173（桥 127.0.0.1:7720）

# Electron 桌面（内核以 utilityProcess 内嵌；打包时法规库产物随包分发——build:kernel 依赖 build:lawdb 产物）
npm run build:kernel                 # esbuild 单文件制品（Node 24）
cd apps/desktop && npm run dev
```

真实模型：标准端点配置 `ZR_MAAS_BASE/ZR_MAAS_TOKEN`；自带密钥配置 `ZR_BYOK_API_KEY`（开发兼容 `ZR_MOONSHOT_API_KEY`），并设 `ZR_MODEL_PROVIDER=upstream`。**未配置时真实链路显式报 503，绝不静默切 mock/他厂模型**；事项模型端点与同意状态由出站闸门强制执行。

数据库密钥：生产形态由 Electron 主进程 safeStorage 解封后经 `kernel.init` 一次性交付（无需配置）；开发可设 `ZR_DB_KEY=<口令>` 启用页级加密（**仅开发用**，明文出现于环境变量）。注意：对既有明文开发库设 key 会打不开——G0 开发库删除重建即可（或取消该变量）；`keys/` 目录（根私钥/设备私钥/恢复份额，0600）与加密库同属工作区，删除工作区即全部重置。

## 测试

```bash
npm test        # 全仓 141 项（内核/钥匙包/法规库包/解析 OCR/A1 探针/A1 注入红队 v0；含真实 OCR 模型与真实引擎；npm test 先经 pretest 构建法规库与签名 profile）：工具/端到端/交付件/签发流/密钥体系/签名链/纪元撤权/页级加密（离线可跑）
npm run test:a1 # A1 真实 Kimi Code 引擎隔离 worker + 注入探针（全量约 7.5 分钟，含生命周期与制品冒烟）
npm run demo:e2e # G0 标准演示用例自动化演示路径（先构建法规库与 profile；打印核验拦截/去向卡/签发证明/审计链证据；退出码非零即失败）
npm run typecheck
```

## 关键设计落点（与方案逐条对应）

- **三条不可退让约束（§1.1）**：中软云端无业务状态（云端只有 MaaS token 通道与支撑服务）；离开律所侧之前检查并记录（一切模型请求经出站闸门）；一个内核一套语义（桌面/加载项/节点共用 §15.2 方法表）。
- **事件先落账本再推界面**；**进度只说事实**；**拦截可见、不静默删除**；**执行位置常显**（事件带 `where`）。
- **生成/核验/签发三态**：Agent 与模型产物只能是 `draft`；签发绑定最终字节 hash，批准不跨版本；内部稿外发门禁。
- **点数**：入队预留、成功结算、失败/取消释放；**平台失败不扣点**。
- **注入防护**：案卷内容一律作为数据；worker 快照内 `.kimi-code/agents`、`.kimi-code/mcp.json` 被补丁写死（A1 探针覆盖）；ZIP 路径穿越/压缩炸弹解析前拦截。
- **断网可用**（§5.4）：阅读、检索、法条核验、比对、计算、脱敏、文书生成离线照常（S1b/S2/S6 全程无网络）；模型任务在端点不可达时显式排队/报错。

## 明确的缺口（G0 第 3–6 周与 G1 工作包）

- **LAN 双向证书直连通道**（§7.2 节点介质）、**本机库由共享目录全量重放生成**（§7.2 后半句）、**跨机器节点加入流程**（节点证书导入与密钥包裹下发）、**策略冲突冻结与管理员处理界面**（当前落 sync_conflicts 与 conflict.detected 事件）、**成员机对归属行的本地编辑在本机生效但不传播**（归属机 origin_conflict 拒收；编辑机无 NACK 感知——G1 在界面对非归属行做只读化与冲突提示）、node_tasks 任务级状态双向收敛（当前经 runs 行关联）、定时与批量在节点执行（阶段 5b 已完成 v0，剩余 cron 解析与 IM 通知）——G1；
- **时间戳锚定**（§6.4 检查点 RFC 3161 提交）、`im_witnessed`（需所内节点 IM 见证）、事件体按事项密钥加密的账本侧改造、**所内节点与 LAN 直连同步**（§7 剩余部分）——G1/节点阶段；
- **首批法规采集**（官方公报人工自建 100 部，法律工程任务；流水线与签名包已就绪）、案例在线核验（数据商企业合同，未签前案号一律「未核实（离线）」且不得签发）、法规库每日真实增量构建（格式与 apply 已演示）——G1；
- **引用核验步骤的场景覆盖**：案号「未核实（离线）」门禁 G0 只挂在 S1 默认路径；S1b/S2/S6/A1 的引用核验步骤在 W10（法源与核验工作包）补齐；
- **Source Registry 四元组中的 firm_entitlement**（律所级授权份额）未实现：registry 的 firm_limit/concurrency_limit 字段暂为登记语义，随许可/席位激活流（G1）接入；
- **法条正文送入模型的路径**：任何此类路径须先 `assertAction(source,'model')`——当前无该调用面（核验结果不含正文），新增时强制（lawdb getArticle 注释已锚定）；
- **OCR 内存与档位**：§13 峰值 ≤1GB 在 macOS arm64 未达（基线 ~1.2GB，详见阶段 3 实测）——Windows i5 参考机校准（探针 8）；PP-OCRv6 small 精度档、cls 方向分类接入、ARM Windows 运行时裁剪、印章/手写专项在 G1；
- **本机检索**（FTS5/向量，§9）——第 3–6 周；
- **所内节点与同步**（§7 剩余部分）、**IM 长连接原型**（§11.2）、**WPS 加载项原型**、十四项探针全量——第 5–6 周；
- **apps/agent-host**（命名管道 + ZP-5/6 拒绝式进程服务/受限文件系统）取代 agent-runtime 过渡形态——阶段 2；
- **需要 Windows 环境**：Word COM 加载项、WPS publish 注册、宿主保真专项（探针 5/6）、launcher-win 降权启动器；
- 规则包驱动的条款级修订（W12）、NER 化名（W7）、Anthropic 兼容端点、许可/席位激活流。

## 许可证与供应链

- 自研代码：内部资产。第三方依赖版本全部锁定（root 与各 workspace package.json）。
- `third_party/kimi-code`：MIT（Moonshot AI），fork 锁版 `f67e6398f` + ZP 补丁（`third_party/PATCHES.md`）；`packages/kap-host/vendor/kap-embed/` 为源码自建产物（MIT，保留 LICENSE）；原 SDK 自建产物随 SDK 宿主退役删除（K9-1）。
- better-sqlite3-multiple-ciphers（MIT，N-API）；Electron/React/Vite/esbuild 均为宽松许可。
- 解析与 OCR 链：pdfjs-dist 6.3.289（Apache-2.0，PDF 文本层）、@hyzyla/pdfium 2.1.13（MIT，PDFium WASM 渲染，内核 BSD-3）、@napi-rs/canvas 1.0.10（MIT，图像解码）、onnxruntime-node 1.30.0（MIT，推理运行时）、ppu-paddle-ocr 6.6.0（MIT，PaddleOCR Node 封装）、ppu-ocv 4.0.0（MIT，OpenCV WASM，ppu-paddle-ocr 传递依赖）；OCR 模型 PP-OCRv5 mobile det/rec/cls 与字典（Apache-2.0，RapidAI/PaddleOCR，ModelScope + GitHub 拉取，SHA256 校验，`npm run fetch:ocr-models`，gitignore 不入仓、随安装包分发——安装包预算 ≤400MB 含 OCR 模型约 21MB）。
- IM 连接器链：ws 8.18.3（MIT，WebSocket 客户端/服务端——钉钉 Stream 骨架与平台模拟器共用；连接器只连配置的平台端点或本机模拟器，无中软域名路径）。
- 中软 MaaS `new-api`（AGPLv3+附加条款）不进入客户端与内核，仅作 API 调用方。
