# 04 Kimi Code集成与工程实施

## 1. 已知工程状态与证据边界

本轮核验了官方仓库与本地锁版，并对合成临时目录做路径探针；没有真实调用客户模型、没有运行Windows沙箱、没有修改产品代码。详细路径、行号、源码链接与验证范围在调研A。以下是整改设计，不是已完成清单。

本地锁版为 `f67e6398fb3210ad8ace970e2dfd5bcc984ed61f`，CLI 2.1.1，SDK源码0.20.0；vendored标识2.1.1-zr.2。研究时官方main为 `5b936697670ed15444bcb4720bd91e6ee776a941`，不能用main今日行为解释旧锁版。官方仓库：[MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code)。MIT根许可证不自动授权远程服务、外部下载的闭源二进制、数据源或Kimi Work客户端素材。

现有 `platform/` 的事项、文书、出站、密钥与模型适配包可复用，但需分别审计；“代码存在”不等于实现全部规划能力。当前关键问题：

| 证据位置 | 可确认问题 | 整改优先级 |
|---|---|---|
| `packages/kernel/src/executor/agent-host-manager.ts` 183–194 | 普通Node spawn无OS隔离 | P0：未验收前禁止开放任意代码 |
| `apps/agent-host/src/sandbox.ts` 38–65 | 字符串路径前缀不能防符号链接逃逸，Windows路径分隔也不完备 | P0：原生文件broker+句柄级检查+Windows专项 |
| `apps/agent-host/src/host.ts` 154–163 与 manager 105–107 | timeout结束事件被映射为succeeded | P0：统一终态枚举，缺失/未知状态失败关闭 |
| manager的工具配置及host配置 | 内置文件、Shell、浏览器、子Agent关闭；`skillDirs:[]`，提问能力前端未接 | P1：逐族接通，不能把disabled算完成 |
| 网络拦截与上游`local-fetch-url.ts` | 全局undici dispatcher不能覆盖显式dispatcher、子进程、raw socket等 | P0：OS拒绝直连+出站broker；当前禁用Fetch不等于开放后安全 |
| `mcp__legal__`前缀自动批准 | 未来同前缀写工具会继承批准 | P0：工具ID+动作+资源+用途授权 |
| 事件/取消/恢复链路 | 事件截断、拼接不等于完整成果；单进程取消不能保证子树停止 | P0/P1：持久事件、artifact校验、进程树及租约回收 |

行号针对本次读取版本，后续整改应把文件hash纳入工单；不得把本报告行号当永久定位。

## 2. 集成路径裁决：适配能力，收窄管理面

建议先扩展现有SDK适配，完成下表能力契约；同时用两周技术探针对kap-server进行并列验证。选择依据是锁版真实API覆盖、故障恢复、补丁规模和攻击面，不能仅因“全量”二字决定把完整管理服务器搬进产品。

如果SDK缺少必要会话/历史/目标能力，而kap-server已有稳定可嵌入接口，则让kap-server在私有进程运行，由受限业务adapter访问；浏览器渲染、移动端、云控制面都不能直接访问其配置、OAuth、终端、插件安装、任意文件打开和关机接口。必要路由清单生成式测试，新增上游路由默认不可达。

无论选哪一条，共享业务协议与领域规则，不要求Windows Office COM、Linux云沙箱和macOS文件broker使用同一二进制。工具引擎处理推理与调用，业务内核拥有权限、审批、成果、预算和正式状态。

## 3. 完整接入能力账本

状态字段统一为 `原生接通 / 适配替代 / 政策限制 / 待实现 / 不在已购权益`；“政策限制”仍要测试允许路径与拒绝路径。完整度不能简单按勾选数量平均。

| 能力族 | 目标接入方式 | 验收证据 |
|---|---|---|
| 模型流式输出、tool call、usage | 模型网关协议适配 | 多轮、流中断、错误码、length截断、usage缺失有明确终态 |
| 计划/待办/澄清 | 统一事件协议与前端状态 | 用户答复/超时/关闭/恢复后不丢问题，不伪造答复 |
| Read/Write/Edit/Glob/Grep/媒体 | object broker、受限文件系统；子进程也入沙箱 | 所有真实I/O路径覆盖，非授权材料与其他事项不可读 |
| Bash/Python/Node | 受限执行器，预置依赖 | 环境无密钥；网络拒绝；资源/进程树/文件边界通过 |
| Skills/Agent profiles | 签名方法包与组织批准目录 | 任务可写目录不能新增有效指令或插件；版本可追 |
| MCP | 工具注册表+凭据broker | tenant/user/matter三重范围；失效/超时拒绝；不直传长期密钥 |
| 子Agent/Swarm | 受限子任务，父预算分配 | 权限不扩大、不能自批、取消传播、循环/并发有限 |
| Goal/长任务 | 业务预算、deadline、持久checkpoint | 超额前停止新调用，可解释恢复，不无限续跑 |
| 搜索 | 自建服务适配已采购搜索 | 只有API token、无个人OAuth时可用；费用与查询去向可审计 |
| Fetch | 统一URL/出口broker；禁止隐式本机回退 | DNS重绑定/重定向/私网/元数据地址/大文件拒绝 |
| 浏览器 | 首期独立隔离公开浏览器 | 不读用户Cookie；站点及提交动作受限；下载也经检查 |
| 会话、上下文压缩与记忆 | 受控会话持久化+业务事实层 | 压缩后不丢限制/引用；不串案；可按政策删除 |
| 文件历史/快照 | 引擎历史映射ArtifactVersion | 回滚不回滚权限、法源有效性或已经外发的事实 |
| Cron/定时 | 产品调度器拥有触发语义 | 错过/重试/重复触发/夏令时与时区策略明确 |
| 远程控制 | 业务命令白名单 | 不能访问运行时管理员接口或扩大原授权 |
| 用量/预算/取消 | 统一计量账本与租约 | 父子总额不超预占；取消后在途费用可解释 |
| 更新/插件/辅助二进制 | SBOM、签名、锁版下载源 | 禁止运行时自动下载未知最新版本 |
| Work闭源专业能力 | 有合同交付则另接，否则我方替代 | 能力、版权、数据条款、费用各自验收，不伪装原厂后端 |

默认上游搜索可能依赖coding OAuth，数据源/浏览器桥也有独立依赖；详见调研A。token可用于已开放且已开通的服务，不能推导个人Work会员插件权益。Hosted Agents如另行采购，可作为一种受控执行后端评估；其存储与生命周期不同于无持久化推理，不默认启用。

## 4. 服务边界与部署

首期采用模块化控制服务+独立安全组件，避免为了架构图拆20个微服务。建议：

| 单元 | 内容 | 独立原因 |
|---|---|---|
| control-api | 组织、用户、事项ACL、政策、任务、审批、账单与控制台 | 事务一致；可先同一服务分模块 |
| model/tool-gateway | 模型、搜索、数据源、凭据代理、预算检查 | 长期上游密钥及出口边界独立 |
| execution-controller | 队列、租约、调度、结果接收、资源额度 | 高权限编排与不可信代码分离 |
| cloud-worker | 单任务隔离，C授权对象挂载 | 不持有平台管理凭据；跨租户隔离 |
| content-service | C对象与索引；L仅密文中继协议 | 明确产品模式；不能误将L导入全文索引 |
| desktop | UI、业务内核、文件/Office broker、设备密钥、可选本机执行器 | 本机授权与本机可见范围 |
| firm-runner（后续可选） | L授权常在线执行器、出站连接 | 不因“律所内网”就信任所有事项 |

云建议关系数据库作事务权威、对象存储作不可变材料版本、持久队列与outbox作异步边界。缓存不能作授权权威。C每租户/事项隔离命名空间和加密上下文；仅对象路径含tenant_id不算隔离。L内容层本地数据库加密、密文块同步；成员ACL仍在控制面最小化保存，正文不可见不等于元数据不可见。

本地服务优先命名管道/受控IPC；必须回环HTTP时检查绑定、Host、Origin、一次性短令牌和请求大小，防跨站请求。Electron渲染沙箱、contextIsolation开启，nodeIntegration关闭；CSP与HTML消毒，禁止Agent产物外部资源自动请求。所有IPC操作使用结构化schema，不透传任意路径/命令。

## 5. 数据模型与接口契约

| 实体 | 必需字段/约束 |
|---|---|
| Tenant/User/Device | 所属组织、状态、角色、设备独立公钥、撤销纪元；个人/多所空间明确 |
| Matter | 负责人、成员ACL、伦理墙、C/L、法域、时点、保留/保全策略、policy_version |
| MaterialVersion | 来源、版本hash、媒体类型、原件位置、授权地点、页段锚点、权利记录、解析覆盖 |
| Run / Attempt | 请求意图、快照、执行位置、状态、预算、父任务、租约epoch、deadline |
| ToolCall | 工具/版本、规范参数摘要、输入对象版本、policy_decision、实际出站记录、结果位置 |
| Approval | 对象及版本、动作、受众/目的地、金额/预算、批准人/设备、nonce、有效期、消费状态 |
| ArtifactVersion | 源材料/规则/模型版本、产物hash、类型、质量门禁、复核和签发状态 |
| Citation | 来源版本、精确锚点、命题、真实性/支持/适用三态、许可、核验时间 |
| UsageLedger | request_id、预占/实际/释放/补记、供应商费用、用户点数、计费版本、幂等键 |
| AuditEvent | actor、tenant、matter伪名ID、动作、对象版本、policy与decision ID、序号/前hash |

本轮API示例是我方目标协议，不声称是Kimi原生API：

```text
POST /v1/matters/{id}/runs          {method, material_versions, execution_target, budget}
GET  /v1/runs/{id}/events?after=seq  断线续读；短期能力认证
POST /v1/runs/{id}/answers          {question_id, answer, expected_state_version}
POST /v1/approvals/{id}/decisions   {decision, object_hash, challenge_signature}
POST /v1/runs/{id}/cancel           {expected_state_version, reason}
POST /v1/artifacts/{id}/submit      {version, audience, channel}
POST /v1/devices/{id}/revoke        {reason, admin_authorization}
POST /v1/matters/{id}/migration     {from,to,manifest,retention,approval}
```

服务端从认证上下文与对象查询得出tenant/role，不信任请求体。资源不存在与无权限响应避免泄露案名；列表、搜索、预签URL与批量导出同样校验，下载令牌绑定版本、受众、范围和短期TTL。

RuntimeAdapter至少暴露 `start/resume/respond/approve/cancel/events/capabilities`；工具请求必须经过 `authorize → reserve budget → prepare → approve if needed → recheck → execute → validate → commit → settle`。批准人来自可信UI认证，不来自模型参数。

## 6. 状态、恢复与幂等

任务状态：`CREATED → VALIDATING → QUEUED → RUNNING`，期间可进 `WAITING_INPUT / WAITING_APPROVAL / WAITING_DEVICE / PAUSED_BUDGET / RECOVERING`；终态为 `SUCCEEDED / PARTIAL / FAILED / CANCELLED / EXPIRED`。终态转换用数据库CAS；未知状态、缺成果或截断不能成功。Artifact的法律复核状态独立。

Run是用户意图，Attempt是执行尝试。每Attempt获得短租约与递增fencing epoch；失去租约后不得读取新材料、调用上游、写产物或结算新费用。网关、对象服务与最终提交都检查epoch，不能只在调度器检查。队列是至少一次交付，外部效果以idempotency key和接收方回执保证；不能承诺任意外部系统exactly-once。

checkpoint保存：已完成工具结果指针、输入快照、政策与模板版本、预算账本、待答问题/批准、压缩历史、失败覆盖清单。恢复必须重新检查权限和输入版本。引擎会话续接只是实现手段，不能重跑整个任务后算“恢复”。副作用结果未知时进入人工对账，不直接重发。

同步采用不可变事件与文件块、乐观并发提交；独立草稿可并存，签发与外发单一权威提交。C服务器权威，L指定本机/runner事项协调者；更换协调者须租约交接。MVP不做Word正文CRDT实时合写，以独占编辑租约+冲突副本保障清晰责任。

## 7. 沙箱与出站的真实覆盖

本机优先选择一条可维护且实际通过目标Windows版本/EDR的强隔离方案；其他方案是候选，不能用A/B/C字母掩盖实质差异。不满足读隔离或网络限制的环境只提供可信解析/比对等标准工具，不允许运行模型生成代码。用户确认不能补上隔离。

云worker用任务级隔离环境，容器以外叠加用户命名空间/最小权限/seccomp/网络策略等适合部署的控制；高风险通用代码评估microVM。容器不是天然租户安全证明。禁止宿主socket、云元数据、挂载宿主根、privileged和共享可写依赖；CPU/RAM/进程数/磁盘/输出量/执行时间全部限制。

文件安全包括symlink/junction/reparse、UNC/网络盘、大小写、保留设备名、长路径、压缩包路径穿越、检查后替换竞态。不能只用 `realpath` 检查一次后再按字符串重新open；broker须在实际操作时绑定安全句柄/目录，或将不可信操作限制到已隔离快照。

出口覆盖模型、搜索、Fetch、浏览器、MCP、OCR、遥测、更新、依赖下载、媒体、WebSocket、DNS和子进程。允许域名不等于允许任意路径/请求体；必须校验动作和数据。公开网页内容不可信，不能改权限或触发安装。关闭网络的脚本仍可把秘密写入产物，后续导出同样受审查。

**化名策略替换v7双向代码替换**：进入模型的敏感文本按获准目的最小化/化名；任务文件名使用稳定安全ID；引擎编辑去标识的工作表示，输出结构化patch与实体ID。可信文书引擎在最终文档字段内还原，校验引用、转义和版本。绝不替换Bash/JavaScript/Python源码字符串。无法兼容语义或OCR图片时停用该模式或单独授权真实输入，不承诺NER可以实现匿名化。

## 8. 模型、预算与方法资产

从单个经过法律评测的Kimi主模型开始，低成本模型仅用于通过专项评测的分类/抽取，不自动替代复杂法律判断。策略锁定供应商、模型族与处理区，容量不足不静默跨供应商路由。reasoning/signature等协议约束字段遵循锁版官方接口；UI不展示思考原文作为审计依据，存储与回传纳入内容政策。

长文采用覆盖驱动切分、结构/附件联动、多段检索和全局一致性检查；不因模型支持长上下文就一次塞全库。上下文压缩不能丢关键限制、资料版本和不确定性，法律事实账本独立于聊天摘要。

预算先预占、每次调用检查、父子共用总上限，给最终汇总/失败说明留余额；自动重试只适合已知未产生副作用的失败，次数与费用受限。达到预算暂停并给出已完成/未完成/追加预计，禁止后台继续扣费。usage不完整先标待核对，不把输出字符数冒充供应商token。

方法资产以版本、合同、持续质量和组织覆盖层形成护城河。首发不建设复杂占位符扩展/思考密封协议；必要云端prompt组装必须有展开后成本、版本和可评测输入证据。内容进入模型后不能保证绝不经输出泄露，50字重合检测仅辅助。

## 9. 现有平台和MaaS复用

本轮未修改相邻 `MaaS 生产/new-api` 工作区。正式接入前对共享MaaS做独立数据流核验：正文/错误体日志、重试、模型fallback、缓存、管理员访问、导出、计费精度、断流及reasoning字段兼容。单独“法律分组”不是隔离证明。

优先独立法律网关与计量域，复用已证实合格的IAM/支付/监控基础设施。核心Kimi企业密钥只在服务端密钥管理中，客户端使用我方短令牌，运行时和脚本不可读取长期上游密钥。禁止扫描或打印生产环境密钥以验证架构。

数据迁移分阶段：保留现有schema并加版本 → 建立只读导出/备份 → 双写或校验迁移（不双重外发）→ 对账 → 按事项切换权威执行器 → 保留回滚窗口。旧示例法规、演示来源和虚构当事人必须打 `sample=true` 并物理隔离生产索引，生产构建拒绝载入。

## 10. 供应链与可维护性

锁定上游commit、SDK、Node/Electron、原生模块、工具与镜像digest；补丁逐项对应威胁、测试和上游issue。干净检出+补丁重放可复现构建；dirty目录与改过的bundle不作交付来源。SBOM覆盖外部下载二进制、字体、OCR模型和便携运行时，遵守各自许可。

更新分测试/设计合作/稳定渠道，签名验证、反回滚、紧急停用、数据schema兼容和客户可控延迟；延迟更新也有安全支持截止日。上游每两周评估是流程建议，不意味每两周强制升级。每次升级重跑受影响能力、权限继承、出站与恢复探针。

OpenTelemetry等观测默认只留元数据；敏感body、文件名、prompt、trace附件和第三方报错可能含案情，按C/L分别处理。支持人员通过有期限、客户可见的break-glass流程获得最小访问，记录审批与读取；不能因“排查故障”默认读全库。
