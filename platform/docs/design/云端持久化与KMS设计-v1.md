# 云端持久化与 KMS 设计 v1（S1 控制面 + 签名服务 + S14 审计流水）

> 状态：**草案，待评审**（v9.2 §7.1“第 3–5 周：云端持久化与 KMS 设计评审”）· 编写 2026-10-15 · 角色：云端架构
> 依据：`research/2026-10-14-生产化方案v9.2/00-生产化完整方案v9.2.md` §3.1、§5.1–§5.5、§7；同目录 `调研-Y2-云端生产开发方案.md` §3.1、§3.4、§4.2–§4.4、§5、§6.1、附录 A；
> 现有代码（以代码为准，行号按 2026-10-15 工作区 `main@5ce453e`）；`docs/v9-开发计划与进度.md` 阶段 6 与第 4 批。
> 联网核实的访问日期均为 **2026-10-15**，出处见附录 A；查不到的标“待核实”。
> 约定：本文“v0”指 `services/control-plane` 现有实现（内存 + 两代交替状态文件）；“生产”指 M1（2026-12-18）预发起的形态。

---

## 0. 一页结论

**一句话**：控制面从“单进程内存 + 两代交替文件”改为 **PostgreSQL（按 `tid` 行级安全）+ Redis（nonce 与限流）+ 独立签名服务 `cp-signer` + 控制面事件日志（journal → OBS WORM）**；14 条客户端路由、5 个请求头、所有签名字节与错误码不变；新增的工作全部在服务端，**客户端只需补一处缺口**（`release.json` 尚无控制面与席位公钥表，见 §4.7）。

### 0.1 关键决定（评审对象）

| # | 决定 | 一句理由 | 节 |
|---|---|---|---|
| D-P1 | 签名过的文档（证书、策略、连接器登记、管理员签名）在库里存**原始 JSON 文本**，不存 `jsonb`；目录、连接器目录、吊销表按**首次插入序号**排序输出 | 客户端对“同号异文”拒收（`governance.ts:590`、`:841-843`），任何字段规范化或数组重排都会让同一版本号得到不同摘要 | §2.7 |
| D-P2 | 写事务 `READ COMMITTED` + 租户行 `SELECT … FOR UPDATE`，全局计数行（`cp.meta`）最后加锁；读文档用 `REPEATABLE READ READ ONLY` 单快照；**不用 SERIALIZABLE** | 写入频率低、版本号必须无空洞且与提交顺序一致；SSI 的 40001 重试与签名/nonce 副作用纠缠，且全局计数会让几乎所有写都冲突 | §2.4 |
| D-P3 | 每个请求只取**一个时刻**（数据库主库 `clock_timestamp()`），签发时刻、到期、席位令牌 `iat`、`server_time` 都由它推出；许可签发时刻另按租户**单调**（`cp.tenant_clock`） | 多副本、主备切换后时钟不一致会让客户端把较早签发的许可判为“回放”（`governance.ts:454`） | §2.5 |
| D-P4 | 网关订阅版本改为 `max(上次 + 1, 当前毫秒)`；策略/目录/连接器版本从备份恢复后按 journal 高水位 + **小于告警阈值的余量**抬升，恢复期间开“恢复围栏”（文档类路由 503） | 订阅器只拒“更小”（`feed-subscriber.ts:87`）可以用时钟；客户端对目录与策略有跳跃告警/上限（`governance.ts:133-141`、`policy.ts:89`），只能用余量 | §6.3 |
| D-P5 | nonce 主存 Redis（`SET NX PX 600000`），Redis 故障降级到 PostgreSQL 表；两者都不可用时**席位令牌、租户盐与全部读文档路由失败关闭**，吊销/撤下/摘要上报失败开放（幂等收紧） | 席位令牌是持有者凭据（网关无逐请求设备签名，D-33），租户盐是秘密；吊销重放只是重复收紧 | §3 |
| D-P6 | `cp-signer` 独立节点池与子网、无公网、只收 `cp-api` 的 mTLS；**只接受结构化签名请求**（7 种信封 + 席位令牌，逐种校验字段与有效期），不接受任意字节；每次签名写独立审计 | 控制面签名虽“只够收紧”，但许可、席位令牌与订阅都由它出；把私钥移出 API 进程并给出可追溯的签名账 | §4 |
| D-P7 | **M1 两把签名私钥都走“KMS 信封加密 + 签名服务内存解封”（路径 A）**；席位密钥在 PoC 通过后可在首次计划轮换时改为 KMS 内 Ed25519 | 新核实：华为云 KMS 自定义密钥已列 ED25519，签名接口有 `ED25519_SHA_512`，但**消息须小于 4096 字节**——目录、订阅、策略信封都超过；席位令牌约 300 字节可用 | §4.1 |
| D-P8 | 密钥层级：每环境 5 把 CMK（签名包裹、字段加密、RDS 磁盘、OBS 审计、跨云备份走离线公钥）；应用层加密字段 = 租户盐（S1）+ 账号手机号/邮箱、IM 凭据（S2/S10）；国密算法“能用即用”（SM4 包裹与字段），Ed25519 是否过密评**需合规确认** | 等保 8.2“客户自管密钥”；密评适用性未定（Y2-U11） | §5 |
| D-P9 | RDS 主备改**同步复制**（缺省异步）+ 跨区域实时灾备（DRS 或跨区域只读，待核实）+ 跨区域备份 + 每日跨云逻辑导出；网关订阅器把最后一份验过的订阅落盘 | 同城 RPO≈0、异地 RPO ≤15 分钟；网关在控制面停机时重启不能丢吊销集 | §6 |
| D-P10 | 控制面事件日志（journal）= 运营审计流水 + 恢复用逻辑日志：同一事务写入、无空洞序号、外送 OBS WORM（合规模式）并哈希链 + 定时签名检查点 | 等保“审计防删改 ≥6 个月”；恢复时补齐备份之后的吊销与发布 | §7 |

### 0.2 对已有材料的更正与新发现

| # | 内容 | 影响 |
|---|---|---|
| F-1 | **华为云 KMS 已支持 ED25519**（自定义密钥；“密钥算法类型”页 2026-06-09 更新），签名接口 `signing_algorithm` 含 `ED25519_SHA_512`、`ED25519_PH_SHA_512`，`message` 须 **< 4096 字节**、`message_type` 缺省 `DIGEST`；**专属密钥库不支持 ED25519**。Y2 §2.5 与 v9.2 §5.2“国内云 KMS 无 Ed25519”需更正为“共享 KMS 有、专属密钥库没有，且消息长度受限” | D-P7；Y2-U1 的结论从“只能路径 A”变为“信封密钥只能路径 A，席位密钥可 KMS 内签名” |
| F-2 | **安装包形态拿不到控制面公钥**：内核从环境变量 `ZR_CONTROL_PLANE_KEYS`、`ZR_SEAT_KEYS` 读公钥表（`packages/kernel/src/index.ts:127-128`），但安装包形态的内核环境只取系统变量白名单 + `release.json` 生成的变量（`apps/desktop/electron/release-config.cjs:98-102`），而 `release.json` 只解析地址与钉住集（`release-config.cjs:76-78`）——公钥表为空时每份控制面文档都以 `envelope_unknown_key` 拒收，许可缺失即退出模式 | 必须在 M1 前给 `release.json` 增加 `control_plane_keys`、`seat_keys`（客户端改动，不改协议）；也是 kid 轮换的信任列表载体（§4.7） |
| F-3 | v0 签发席位令牌时取了两次时钟（`server.ts:592` 签发用 `now()`、`:593` 回复里的 `expires_at` 再取一次）；回复里的 `expires_at` 不在签名内，不影响安全，但生产统一为一个请求时刻 | D-P3 |
| F-4 | v0 网关订阅版本 `feedVersion` 是全局计数（`server.ts:179`），v0 状态从备份或旧文件恢复会让版本回退，订阅器从此拒收所有新订阅（`feed-subscriber.ts:87`）直到计数追上——这正是阶段 6 如实残余“重启后各版本计数从头开始”（进度文档第 363 行）在生产形态的对应风险 | D-P4 |
| F-5 | 吊销通知、席位令牌之外，v0 还暴露 `ops.seal` 可签任意种类任意内容（`server.ts:140-141`，用于 T17 演练） | 生产构建不得存在该入口；签名服务只收结构化请求（§4.3） |

> 处置（2026-10-15 第 6 批）：F-2 已修——`release.json` 增 `control_plane_keys` / `seat_keys`，配置了控制面而缺表或不合格即整组不生效并报告（`apps/desktop/electron/release-config.cjs`、`test/release-config.test.ts`）；F-3 已修（v0 席位令牌一处取时）。F-5 留给生产构建（M1）。

---

## 1. 范围与不变量

### 1.1 范围

| 在范围 | 不在范围（另有设计） |
|---|---|
| S1 控制面的持久化、事务、版本与时钟；nonce 与控制面限流；签名服务 `cp-signer`；KMS 密钥层级（S1/S14 用到的部分，并给出 S2/S3/S10 的字段加密口径）；控制面与签名服务的容灾；控制面审计流水（S14 的 G1 部分） | S2 身份（账号表只给加密口径）；S3 计费账本与网关额度租约（只列计量表的保留期）；S4 网关分布式限流（只给 Redis 键空间约定）；增量订阅的服务间协议细节（给出存储侧 outbox）；S12 控制台 API；G3 云端事项 |

### 1.2 不变量（设计必须保持；评审逐条核对）

| # | 不变量 | 代码依据 | 本设计如何保持 |
|---|---|---|---|
| I-1 | **云端不持久化客户案卷**：只有账号与设备元数据、公钥、席位、律所策略与连接器登记、匿名事项编号与属性、计量与审计元数据 | `server.ts:10`；Y2 §3.1“不持有” | 表结构逐列登记（§1.4）；journal 只写白名单字段（§7.2）；不存席位令牌本体、不存任何请求体 |
| I-2 | **14 条客户端路由**（方法 + 路径）与 5 个请求头不变；请求体 ≤256 KiB、响应 ≤8 MiB | `egress-gate/src/cp-relay.ts:20-40` | 路由处理换存储层，不改路径与报文；契约测试对拍（§2.10） |
| I-3 | **签名格式不变**：信封字节 `"kwl-control-plane-envelope-v1\n" + canonicalJson({kind,kid,body})`；席位令牌 `zst1.<载荷>.<Ed25519>`；设备请求 `"kwl-device-request-v1\n" + canonicalJson({m,p,b,t,d,ts,n})`；开通证明 `kwl-enroll-v1`；策略与连接器的管理员签名字节 | `firm-trust/src/envelope.ts:25-33`；`seat-token/src/index.ts:24-32`；`firm-trust/src/request-auth.ts:9,26-40,88-91`；`firm-trust/src/policy.ts:123-128` | 签名服务复用同一个包的同一函数生成字节（§4.3），黄金向量测试 |
| I-4 | **控制面签名只够收紧**；放宽类策略与连接器须律所管理员设备签名门限（团队版 1、律所版 2），客户端独立核验 | `firm-trust/src/index.ts:3`；`admin.ts:54-101`；`policy.ts:212-222` | 控制面仍做“诚实时”检查（`server.ts:670-672`、`:679`），签名服务不判断宽严 |
| I-5 | 席位令牌签发 **96 小时**、最短 72 小时；客户端剩余 <73 小时续期、同步间隔 ≤1 小时 | `server.ts:168-169,248`；`seat-token/src/index.ts:26`；`governance.ts:131`；`client.ts:48` | 签名服务把席位令牌有效期钳在 [72h, 96h]（§4.3） |
| I-6 | 许可、目录、策略文档有效期 ≤30 天，**签发与到期由同一时刻推出** | `server.ts:272-281`、`:477-489`、`:627-629`；`docs.ts:19,62`；`policy.ts:38` | D-P3（§2.5） |
| I-7 | 版本单调：策略版本 = 已发布 + 1、草稿不占版本号；目录与连接器目录随变更 +1；客户端高水位只增不减，单次跳跃上限（策略 1000、目录/连接器目录 100,000），超过告警阈值（策略 10、目录 1000）告警；首次接受上限 | `server.ts:628-629,638-641,673,682`；`policy.ts:88-94`；`governance.ts:133-141,584-593` | §2.4 事务；§6.3 防回退的余量 < 告警阈值 |
| I-8 | 吊销粘滞（含预先吊销，每租户 ≤1000）；已吊销设备的签名请求得到签名的吊销通知 | `server.ts:165-166,328-350,431-444`；`governance.ts:431-440` | 吊销与预先吊销只增不删（表无 DELETE 权限）；journal 可重放 |
| I-9 | 设备请求：时钟偏差 ≤5 分钟（超出回 `server_time`），nonce 10 分钟去重，**先验签再记 nonce** | `request-auth.ts:10,72-84`；`server.ts:251-258,452` | §3（Redis 键 TTL 10 分钟，验签通过后才写） |
| I-10 | 订阅版本只进不退，吊销集按租户区分、只增不减 | `feed-subscriber.ts:87,91-93`；`docs.ts:120-128` | D-P4 |
| I-11 | “没写成就等于没发生”：回复前持久化，失败回滚并回 500，进程不退出 | `server.ts:180-186,217-236,419-425` | 数据库事务提交后才回复；任何异常回滚事务 |
| I-12 | 公钥（控制面信封、席位）随客户端与网关**构建固定**；控制面地址与 TLS 钉住随 `release.json` 固定 | `envelope.ts:7`；`governance.ts:120-123`；`release-config.cjs:1-12` | kid 轮换走“预发布下一把”（§4.7） |
| I-13 | 设备身份 ≠ 人身份；控制面不持有律所根私钥与设备私钥 | Y2 §3.2；`admin.ts:5-6` | 无相关列；KMS 中也没有 |

### 1.3 路由清单（不变的 14 条 + 1 条服务间路由）

| # | 方法 路径 | 鉴权 | v0 位置 | 生产的事务形态（§2.6） |
|---|---|---|---|---|
| 1 | POST `/v1/enroll` | 律所根私钥签开通证明 | `server.ts:515-532` | 写，租户行锁 |
| 2 | POST `/v1/devices/register` | 证书持有证明（设备签名） | `:535-566` | 写，租户行锁 |
| 3 | GET `/v1/directory` | 设备签名 | `:581` | 读快照 |
| 4 | GET `/v1/license` | 设备签名 | `:582` | 小写事务（许可时钟） |
| 5 | GET `/v1/tenant-salt` | 设备签名 | `:583-586` | 读 |
| 6 | POST `/v1/seat-token` | 设备签名 | `:587-594` | 读 + journal 元数据 |
| 7 | GET `/v1/policy` | 设备签名 | `:595` | 读快照 |
| 8 | GET `/v1/connectors` | 设备签名 | `:596-598` | 读快照 |
| 9 | DELETE `/v1/connectors/{id}` | 管理员设备 | `:695-700` | 写，租户行锁 |
| 10 | GET/POST `/v1/drafts` | 管理员设备 | `:615-650` | 读 / 写 |
| 11 | GET `/v1/drafts/{id}`、POST `…/signatures`、POST `…/publish` | 管理员设备 | `:651-693` | 读 / 写（草稿行锁 / 租户行锁） |
| 12 | PUT `/v1/anon-matters/{anon}` | 设备签名 | `:599-612` | 写，摘要行锁 |
| 13 | POST `/v1/devices/{id}/revoke` | 管理员或合伙人设备 | `:702-708` | 写，租户行锁 |
| 14 | POST `/v1/seats/{uid}/revoke` | 管理员或合伙人设备 | `:709-715` | 写，租户行锁 |
| S | GET `/v1/feed/gateway` | v0：Bearer 共享密钥（`:569-576`）→ 生产：mTLS | `:569-576` | 读快照（`cp_feed` 角色），按版本缓存签名结果 |

> 第 10、11 行按客户端白名单的正则计数（`cp-relay.ts:30-31`），合计 14 条。服务间路由 S 不在客户端白名单内，鉴权从共享密钥改为 mTLS 不影响客户端；新增的增量订阅 `?since=` 只服务间使用（Y2 §3.1）。

### 1.4 持久化数据清单（逐表；敏感度 C1 最高 → C4 最低）

| 类 | 表 / 存储 | 内容 | 个人信息？ | 敏感度 | 保留期 | 备注 |
|---|---|---|---|---|---|---|
| 租户 | `cp.tenants` | 租户编号、版本、席位数、订阅截止、律所根**公钥**、各类版本计数、**租户盐（密文）** | 否（机构） | C2（盐 C1，字段加密） | 合同期 + 终止后 30 日删除；备份 ≤35 天自然过期 | 盐 = 匿名事项编号的 HMAC 密钥（`docs.ts:81`），泄露后可对已知事项编号做比对 |
| 租户时钟 | `cp.tenant_clock` | 最近一次许可签发时刻 | 否 | C4 | 同租户 | §2.5 |
| 设备 | `cp.devices`、`cp.device_cert_history` | 设备证书原文（成员 ID、角色、签名与加密**公钥**、签发与到期）、登记与吊销时刻、吊销人设备 | **是**（成员 ID 可识别到人；设备编号 v0 为 `dev_<律所>_<成员>`） | C2 | 同租户；被替换的证书留档同租户期 | 建议成员 ID 不含姓名（§9 P-10） |
| 证书 | 同上（证书即设备行） | 律所根签发的设备证书 | 是 | C2 | 同上 | 控制面只转交，不能改（`docs.ts:56`） |
| 吊销 | `cp.devices.revoked_at`、`cp.pre_revoked`、`cp.seats.revoked_at` | 吊销时刻、发起设备；预先吊销附证书 | 是 | C2 | **同租户期，不得早于租户删除**（吊销粘滞） | 只增不删 |
| 席位 | `cp.seats` | 成员 ID、席位编号、分配与吊销时刻 | 是 | C3 | 同租户 | 席位令牌**不落库**（持有者凭据），只记签发元数据 |
| 策略版本 | `cp.policies` | 每个已发布版本的策略文档原文 + 管理员签名（含签名人证书） | 签名人证书含成员 ID | C3 | 同租户 | 律所配置，可留（Y2 §6.1） |
| 连接器 | `cp.connector_versions`、`cp.connectors_current` | 连接器登记原文（名称、服务器、URL、可接收级别、工具 schema hash）+ 管理员签名 | 同上 | C3 | 同租户 | URL 可能是律所内网地址：C3 |
| 草稿 | `cp.drafts` | 未发布/已发布草稿、已收集的签名 | 同上 | C3 | 未发布 90 天后删除；已发布的随租户 | v0 作废即删（`server.ts:676`），生产软删 |
| 目录 | 不单独存表 | 由 `devices`/`pre_revoked`/`seats` 在读时生成 | — | — | — | 版本号存 `tenants.directory_version` |
| 许可 | 不单独存表 | 由 `tenants` 在读时生成（滚动签发） | — | — | — | v0 把最后一份许可放在租户记录（`server.ts:99`），生产不需要 |
| 匿名摘要 | `cp.anon_summaries` | 匿名事项编号、级别、端点、依据齐备、事项策略版本、更新时刻（客户端原文） | 否（假名化，无盐不可还原） | C3 | 同租户（G2 评估“事项关闭后 TTL”，Y2-U12） | |
| 订阅变更 | `cp.feed_changes` | 订阅版本 → 租户、变更类别、对象编号 | 同吊销 | C3 | 30 天（增量订阅窗口），之后只保留全量快照能力 | outbox |
| nonce | Redis `kwl:cp:n:*`；降级表 `cp.nonce_fallback` | 摘要后的 (租户, 设备, nonce) | 否 | C4 | **10 分钟** TTL | §3 |
| 限流 | Redis `kwl:cp:rl:*` | 计数 | 否 | C4 | ≤2 分钟 | |
| 审计 | `cp.journal` → OBS WORM `kwl-<env>-audit` | 谁、何时、对哪个租户、做了什么、结果、请求编号；策略/连接器/证书原文（恢复用） | 是（成员 ID、设备编号、来源网段 /24） | C2 | 库内 30 天（已外送且过检查点后清理）；**WORM 400 天**（≥6 个月法定下限，见 P-8）；受托处理记录 3 年 | §7 |
| 签名账 | OBS WORM `kwl-<env>-signer-log`（签名服务直写） | kid、种类、租户、被签字节摘要、调用方、请求编号 | 否（只摘要与租户） | C3 | 400 天（同 P-8） | 不经 `cp-api` 数据库 |
| 计量 | `metering.meter_records`（S3 所有，按月分区） | `MeterRecord` 白名单 16 个字段（`legal-gateway/src/meter-file.ts:8`） | 席位编号 | C3 | ≥6 个月；与账单相关的按会计档案期限（**需财务/法务确认**） | 本文只登记，不设计 |
| 数据密钥 | `cp.data_keys` | 被 KMS 包裹的数据密钥 | 否 | C2 | 最后一个引用它的数据删除后 30 天 | §5 |
| 签名私钥 | CSMS 凭据（KMS 包裹）+ 离线分片 | Ed25519 私钥密文 | 否 | **C1** | 轮换后保留 1 年（验旧签名不需要私钥，只为事件调查期内的可追溯） | §4、§5 |

---

## 2. 数据模型（PostgreSQL）

### 2.1 总体决定

1. **一个 schema `cp`，一个库**（RDS for PostgreSQL 实例上与 S2 身份库分库），所有租户数据带 `tid` 列，行级安全（RLS）按会话变量 `kwl.tid` 过滤。
2. **签名过的文档存原始 JSON 文本**（D-P1）：`cert_json`、`doc_json`、`admin_signatures_json` 为 `text`，按设备提交或控制面生成时的 `JSON.stringify` 原样保存；需要查询的字段（成员、角色、版本、连接器编号）另存普通列。理由：`canonicalJson` 只对键排序、数组保序（`keys/src/encoding.ts:21-45`），而 `jsonb` 会去重键、规范化数字与空白——证书签名按 canonicalJson 校验不受影响，但目录摘要（`governance.ts:581`）对“同一版本号”要求逐字一致，任何差异都会触发 `version_conflict` 拒收。
3. **数组顺序是协议的一部分**：v0 的目录 `devices`、`revoked_devices`、`revoked_seats`、连接器目录 `entries` 都是 JS `Map` 的插入顺序（`server.ts:483-488`、`:597`）。`Map.set` 更新已有键**保留原位置**、删除后再加入**排到末尾**。生产每张对应表带 `ordinal`（租户内首次插入序号，更新不变、删除后重插取新号），输出一律 `ORDER BY ordinal`。
4. **时间列**：控制面自己生成的时刻存 `timestamptz`，输出一律用 JS `new Date(x).toISOString()`（毫秒、`Z` 结尾，与 v0 `iso()` 一致，`server.ts:176`）；**客户端上报的时刻**（匿名摘要 `updated_at`）存原文 `text`——v0 按字符串比较（`docs.ts:101`）和 canonicalJson 比较（`server.ts:607`）。
5. 计数器（目录版本、连接器目录版本、已发布策略版本、席位计数、序号）放在 `cp.tenants` 行内，与租户行锁同生共死；全局计数（订阅版本、journal 序号）放在单行表 `cp.meta`。

### 2.2 DDL 草案

```sql
-- ═══ 0. 角色（平台工程在 IaC 中创建；RDS 管理员账号封存，只用于破窗） ═══
CREATE ROLE cp_migrator NOLOGIN;              -- 表属主；只由迁移流水线 SET ROLE 使用
CREATE ROLE cp_app      LOGIN NOBYPASSRLS;    -- cp-api 业务连接池
CREATE ROLE cp_feed     LOGIN NOBYPASSRLS;    -- 网关订阅构建（cp-api 内独立连接池）
CREATE ROLE cp_shipper  LOGIN NOBYPASSRLS;    -- journal 外送进程
CREATE ROLE cp_ops      LOGIN NOBYPASSRLS;    -- 运营控制台后端：只读汇总视图
CREATE ROLE cp_viewer   LOGIN NOBYPASSRLS;    -- 堡垒机后人工只读：只授脱敏视图

CREATE SCHEMA cp AUTHORIZATION cp_migrator;
SET ROLE cp_migrator;

-- ═══ 1. 全局元数据（单行） ═══
CREATE TABLE cp.meta (
  id              smallint    PRIMARY KEY CHECK (id = 1),
  schema_version  int         NOT NULL,
  feed_version    bigint      NOT NULL,          -- 网关订阅版本 = max(上次+1, 当前毫秒)（§2.4、§6.3）
  journal_seq     bigint      NOT NULL,          -- journal 无空洞序号（与提交顺序一致）
  restore_epoch   int         NOT NULL DEFAULT 0,-- 每次从备份恢复 +1
  fence_until     timestamptz,                   -- 恢复围栏：此前文档类路由 503（§6.3）
  updated_at      timestamptz NOT NULL
);

-- ═══ 2. 数据密钥（信封加密，§5） ═══
CREATE TABLE cp.data_keys (
  dek_id       uuid        PRIMARY KEY,
  purpose      text        NOT NULL CHECK (purpose IN ('tenant_salt')),
  cmk_alias    text        NOT NULL,             -- 例 kwl-prod-cp-field
  alg          text        NOT NULL CHECK (alg IN ('SM4-GCM','AES-256-GCM')),
  wrapped_dek  bytea       NOT NULL,             -- KMS 加密后的数据密钥
  created_at   timestamptz NOT NULL,
  retired_at   timestamptz
);

-- ═══ 3. 租户 ═══
CREATE TABLE cp.tenants (
  tid                 text        PRIMARY KEY CHECK (tid ~ '^[A-Za-z0-9_-]{1,64}$'),
  edition             text        NOT NULL CHECK (edition IN ('team','firm')),
  seats               int         NOT NULL CHECK (seats >= 1),
  subscription_until  timestamptz NOT NULL,
  root_public_key_pem text,                       -- 入组后不可替换（server.ts:529）
  root_enrolled_at    timestamptz,
  salt_ct             bytea       NOT NULL,       -- 租户盐密文（32 字节明文）
  salt_iv             bytea       NOT NULL,
  salt_dek_id         uuid        NOT NULL REFERENCES cp.data_keys(dek_id),
  directory_version   bigint      NOT NULL DEFAULT 1,
  connectors_version  bigint      NOT NULL DEFAULT 1,
  policy_version      bigint      NOT NULL DEFAULT 0,   -- 已发布的最高策略版本（含恢复余量，§6.3）
  seat_counter        bigint      NOT NULL DEFAULT 0,   -- 席位编号 seat_<tid>_<n>（server.ts:561-562）
  device_ordinal      bigint      NOT NULL DEFAULT 0,
  pre_revoked_ordinal bigint      NOT NULL DEFAULT 0,
  seat_ordinal        bigint      NOT NULL DEFAULT 0,
  connector_ordinal   bigint      NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL,           -- 租户盐文档的 issued_at（server.ts:584）
  terminated_at       timestamptz,
  integrity_mac       bytea       NOT NULL            -- HMAC(字段密钥, tid‖edition‖seats‖subscription_until‖root_public_key_pem)（§5.3）
);

CREATE TABLE cp.tenant_clock (
  tid               text        PRIMARY KEY REFERENCES cp.tenants(tid),
  last_license_iat  timestamptz NOT NULL              -- 许可签发时刻按租户单调（§2.5）
);

-- ═══ 4. 设备与证书 ═══
CREATE TABLE cp.devices (
  tid            text        NOT NULL REFERENCES cp.tenants(tid),
  device_id      text        NOT NULL CHECK (device_id ~ '^[A-Za-z0-9_-]{1,200}$'),
  ordinal        bigint      NOT NULL,              -- 首次登记顺序；换证不变（Map.set 语义）
  member_id      text        NOT NULL,
  role           text        NOT NULL,              -- admin / partner / member / node …
  cert_json      text        NOT NULL,              -- 律所根签发的设备证书原文
  cert_sig       text        NOT NULL,              -- 证书签名（判断“同一证书”，server.ts:553）
  sign_pub_fpr   text        NOT NULL,              -- certFingerprint（server.ts:752-754）
  registered_at  timestamptz NOT NULL,
  revoked_at     timestamptz,
  revoked_by     text,                              -- 发起吊销的设备编号或 'ops:<工单号>'
  PRIMARY KEY (tid, device_id),
  UNIQUE (tid, ordinal)
);
CREATE INDEX devices_revoked ON cp.devices (tid) WHERE revoked_at IS NOT NULL;
CREATE INDEX devices_member  ON cp.devices (tid, member_id);

CREATE TABLE cp.device_cert_history (            -- 被替换的证书留档（历史签名可追溯）
  tid          text        NOT NULL,
  device_id    text        NOT NULL,
  cert_sig     text        NOT NULL,
  cert_json    text        NOT NULL,
  replaced_at  timestamptz NOT NULL,
  PRIMARY KEY (tid, device_id, cert_sig),
  FOREIGN KEY (tid, device_id) REFERENCES cp.devices(tid, device_id)
);

CREATE TABLE cp.pre_revoked (                    -- 尚未登记即被吊销（server.ts:336-347）
  tid          text        NOT NULL REFERENCES cp.tenants(tid),
  device_id    text        NOT NULL CHECK (device_id ~ '^[A-Za-z0-9_-]{1,200}$'),
  ordinal      bigint      NOT NULL,
  cert_json    text        NOT NULL,              -- 凭以预先吊销的律所根签发证书
  revoked_at   timestamptz NOT NULL,
  revoked_by   text,
  PRIMARY KEY (tid, device_id),
  UNIQUE (tid, ordinal)
);
-- 每租户上限 1000 在事务内（租户行锁下）COUNT 检查，返回 409 pre_revocation_limit（server.ts:345）

-- ═══ 5. 席位 ═══
CREATE TABLE cp.seats (
  tid          text        NOT NULL REFERENCES cp.tenants(tid),
  uid          text        NOT NULL,
  sid          text        NOT NULL UNIQUE,        -- 全局唯一：网关吊销集按 sid 不分租户（seat-token/src/index.ts:68）
  ordinal      bigint      NOT NULL,
  assigned_at  timestamptz NOT NULL,
  assigned_by  text        NOT NULL,              -- 'auto'（D-35，G0）或控制台账号
  revoked_at   timestamptz,
  revoked_by   text,
  PRIMARY KEY (tid, uid),
  UNIQUE (tid, ordinal)
);
CREATE INDEX seats_revoked ON cp.seats (tid) WHERE revoked_at IS NOT NULL;

-- ═══ 6. 律所策略（每个已发布版本一行） ═══
CREATE TABLE cp.policies (
  tid                    text        NOT NULL REFERENCES cp.tenants(tid),
  version                bigint      NOT NULL CHECK (version >= 1),
  doc_json               text        NOT NULL,   -- FirmPolicyDoc 原文
  admin_signatures_json  text        NOT NULL,   -- AdminSignature[] 原文（最严模板为 '[]'）
  signing_digest         text        NOT NULL,   -- bytesDigest(policySigningBytes(doc))（admin.ts:111-113）
  relaxations            text[]      NOT NULL,
  expires_at             timestamptz NOT NULL,
  published_at           timestamptz NOT NULL,
  published_by           text        NOT NULL,   -- 'control_plane'（最严模板）或草稿编号
  PRIMARY KEY (tid, version)
);
-- 当前策略 = 该租户 version 最大的一行（不是 tenants.policy_version，后者含恢复余量）

-- ═══ 7. 连接器登记 ═══
CREATE TABLE cp.connector_versions (
  tid                    text        NOT NULL REFERENCES cp.tenants(tid),
  connector_id           text        NOT NULL CHECK (connector_id ~ '^[a-z][a-z0-9_-]{1,40}$'),
  version                bigint      NOT NULL CHECK (version >= 1),
  doc_json               text        NOT NULL,
  admin_signatures_json  text        NOT NULL,
  published_at           timestamptz NOT NULL,
  published_by           text        NOT NULL,
  PRIMARY KEY (tid, connector_id, version)
);
CREATE TABLE cp.connector_floor (               -- 每个连接器已发布过的最高版本（撤下后不回退，server.ts:637-641）
  tid           text   NOT NULL REFERENCES cp.tenants(tid),
  connector_id  text   NOT NULL,
  max_version   bigint NOT NULL,                  -- 含恢复余量
  PRIMARY KEY (tid, connector_id)
);
CREATE TABLE cp.connectors_current (
  tid           text   NOT NULL,
  connector_id  text   NOT NULL,
  version       bigint NOT NULL,
  ordinal       bigint NOT NULL,                  -- 首次进入当前目录的顺序；更新不变、撤下后重登取新号
  PRIMARY KEY (tid, connector_id),
  UNIQUE (tid, ordinal),
  FOREIGN KEY (tid, connector_id, version) REFERENCES cp.connector_versions(tid, connector_id, version)
);

-- ═══ 8. 草稿 ═══
CREATE TABLE cp.drafts (
  draft_id               text        PRIMARY KEY CHECK (draft_id ~ '^drf_[0-9a-f]{16}$'),
  tid                    text        NOT NULL REFERENCES cp.tenants(tid),
  kind                   text        NOT NULL CHECK (kind IN ('policy','connector')),
  connector_id           text,                    -- kind = connector 时
  doc_version            bigint      NOT NULL,
  doc_json               text        NOT NULL,
  admin_signatures_json  text        NOT NULL DEFAULT '[]',
  created_by             text        NOT NULL,
  created_at             timestamptz NOT NULL,
  published_at           timestamptz,
  voided_at              timestamptz,             -- 发布同号/更新版本时作废（server.ts:676、:684-686）
  CHECK ((kind = 'connector') = (connector_id IS NOT NULL))
);
CREATE INDEX drafts_open ON cp.drafts (tid, created_at) WHERE published_at IS NULL AND voided_at IS NULL;

-- ═══ 9. 事项匿名摘要 ═══
CREATE TABLE cp.anon_summaries (
  tid             text        NOT NULL REFERENCES cp.tenants(tid),
  anon            text        NOT NULL CHECK (anon ~ '^[A-Za-z0-9_-]{16,64}$'),
  level           text        NOT NULL CHECK (level IN ('L0','L1','L2','L3a','L3b','L4')),
  endpoint        text        NOT NULL CHECK (endpoint IN ('standard','byok','private','mock','none')),
  basis_complete  boolean     NOT NULL,
  version         bigint      NOT NULL CHECK (version >= 0),
  updated_at_raw  text        NOT NULL,           -- 客户端原文（字符串比较语义）
  reported_by     text        NOT NULL,
  feed_version    bigint      NOT NULL,           -- 最近一次改变它的订阅版本
  PRIMARY KEY (tid, anon)
);
CREATE INDEX anon_by_feed ON cp.anon_summaries (feed_version);

-- ═══ 10. 订阅变更（增量订阅 outbox） ═══
CREATE TABLE cp.feed_changes (
  feed_version  bigint      PRIMARY KEY,
  tid           text        NOT NULL,
  change        text        NOT NULL CHECK (change IN ('device_revoked','seat_revoked','matter','policy','tenant')),
  ref           text        NOT NULL,             -- device_id / sid / anon / policy 版本
  at            timestamptz NOT NULL
);

-- ═══ 11. 控制面事件日志（审计 + 恢复用逻辑日志，§7） ═══
CREATE TABLE cp.journal (
  seq            bigint      PRIMARY KEY,         -- 取自 cp.meta.journal_seq，无空洞
  event_id       uuid        NOT NULL UNIQUE,
  at             timestamptz NOT NULL,
  restore_epoch  int         NOT NULL,
  tid            text,                            -- 全局运维事件为 NULL
  actor          text        NOT NULL,            -- 'dev:<设备编号>' / 'ops:<账号>' / 'svc:<客户端证书名>'
  action         text        NOT NULL,            -- 白名单枚举，见 §7.2
  object_id      text,
  result         text        NOT NULL CHECK (result IN ('ok','rejected')),
  request_id     text,
  counters       jsonb       NOT NULL DEFAULT '{}', -- 变更后的计数：{"directory_version":12,...}
  payload_json   text,                            -- 恢复所需原文（证书/策略/连接器/摘要；租户盐只存密文与 dek_id）
  shipped_at     timestamptz                      -- 已写入 WORM 的时刻
);
CREATE INDEX journal_unshipped ON cp.journal (seq) WHERE shipped_at IS NULL;

-- ═══ 12. nonce 降级表（Redis 不可用时，§3.3） ═══
CREATE TABLE cp.nonce_fallback (
  k    bytea       PRIMARY KEY,                   -- sha256(tid‖0‖device‖0‖nonce)
  exp  timestamptz NOT NULL
);
CREATE INDEX nonce_fallback_exp ON cp.nonce_fallback (exp);
```

### 2.3 行级安全与连接角色

```sql
-- 业务表：ENABLE + FORCE（表属主同样受约束），按会话变量过滤；未设置时 current_setting(...,true) 为 NULL → 0 行（失败关闭）
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['tenants','tenant_clock','devices','device_cert_history','pre_revoked','seats',
                           'policies','connector_versions','connector_floor','connectors_current','drafts','anon_summaries'] LOOP
    EXECUTE format('ALTER TABLE cp.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE cp.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY p_app ON cp.%I TO cp_app
                     USING (tid = current_setting('kwl.tid', true))
                     WITH CHECK (tid = current_setting('kwl.tid', true))$p$, t);
    EXECUTE format($p$CREATE POLICY p_migrator ON cp.%I TO cp_migrator USING (true) WITH CHECK (true)$p$, t);
  END LOOP;
END $$;

-- 订阅构建：跨租户只读，且只看订阅需要的行与列
GRANT SELECT (tid) ON cp.tenants TO cp_feed;
GRANT SELECT (tid, device_id, revoked_at) ON cp.devices TO cp_feed;          -- 不授 cert_json
GRANT SELECT (tid, device_id) ON cp.pre_revoked TO cp_feed;
GRANT SELECT (tid, sid, revoked_at) ON cp.seats TO cp_feed;
GRANT SELECT (tid, version, doc_json, expires_at) ON cp.policies TO cp_feed; -- 只取 l3a_standard_model
GRANT SELECT ON cp.anon_summaries, cp.feed_changes TO cp_feed;
GRANT SELECT (feed_version, fence_until) ON cp.meta TO cp_feed;
CREATE POLICY p_feed ON cp.tenants        FOR SELECT TO cp_feed USING (true);
CREATE POLICY p_feed ON cp.devices        FOR SELECT TO cp_feed USING (revoked_at IS NOT NULL);
CREATE POLICY p_feed ON cp.pre_revoked    FOR SELECT TO cp_feed USING (true);
CREATE POLICY p_feed ON cp.seats          FOR SELECT TO cp_feed USING (revoked_at IS NOT NULL);
CREATE POLICY p_feed ON cp.policies       FOR SELECT TO cp_feed USING (true);
CREATE POLICY p_feed ON cp.anon_summaries FOR SELECT TO cp_feed USING (true);

-- 业务角色权限：吊销与证书留档只增不删
GRANT SELECT, INSERT, UPDATE ON cp.tenants, cp.tenant_clock, cp.devices, cp.seats, cp.anon_summaries,
                                 cp.drafts, cp.connector_floor TO cp_app;
GRANT SELECT, INSERT ON cp.device_cert_history, cp.pre_revoked, cp.policies, cp.connector_versions TO cp_app;
GRANT INSERT ON cp.feed_changes, cp.journal TO cp_app;   -- 两表跨租户、无 RLS：业务角色只写不读（订阅由 cp_feed 读，外送由 cp_shipper 读）
GRANT SELECT, INSERT, UPDATE, DELETE ON cp.connectors_current TO cp_app;     -- 撤下连接器（server.ts:698）
GRANT SELECT, INSERT, DELETE ON cp.nonce_fallback TO cp_app;
GRANT SELECT, UPDATE (feed_version, journal_seq, updated_at) ON cp.meta TO cp_app;
GRANT SELECT ON cp.data_keys TO cp_app;  GRANT INSERT ON cp.data_keys TO cp_app;
-- 列级防改：已吊销不能改回（触发器兜底）
CREATE FUNCTION cp.revocation_sticky() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION 'revocation is sticky';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER devices_sticky BEFORE UPDATE ON cp.devices FOR EACH ROW EXECUTE FUNCTION cp.revocation_sticky();
CREATE TRIGGER seats_sticky   BEFORE UPDATE ON cp.seats   FOR EACH ROW EXECUTE FUNCTION cp.revocation_sticky();
-- 律所根公钥一旦写入不可替换（server.ts:529）
CREATE FUNCTION cp.root_key_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.root_public_key_pem IS NOT NULL AND NEW.root_public_key_pem IS DISTINCT FROM OLD.root_public_key_pem THEN
    RAISE EXCEPTION 'root key is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tenants_root_immutable BEFORE UPDATE ON cp.tenants FOR EACH ROW EXECUTE FUNCTION cp.root_key_immutable();

-- 外送进程：只读 journal、只改 shipped_at
GRANT SELECT, UPDATE (shipped_at) ON cp.journal TO cp_shipper;   -- journal 无 tid 过滤（跨租户外送）
-- 运营与人工：只授视图（security_barrier），不含 salt_ct / cert_json / doc_json
CREATE VIEW cp.v_tenant_overview WITH (security_barrier) AS
  SELECT t.tid, t.edition, t.seats, t.subscription_until, t.terminated_at,
         (SELECT count(*) FROM cp.devices d WHERE d.tid = t.tid AND d.revoked_at IS NULL) AS active_devices,
         (SELECT count(*) FROM cp.seats s WHERE s.tid = t.tid AND s.revoked_at IS NULL)   AS active_seats
  FROM cp.tenants t;
GRANT SELECT ON cp.v_tenant_overview TO cp_ops, cp_viewer;  -- 视图以属主 cp_migrator 执行，p_migrator 放行
```

**连接用法**：每个请求一个事务，第一条语句 `SELECT set_config('kwl.tid', $1, true), clock_timestamp()`（事务级变量，兼容 PgBouncer 事务池；同时取得本请求唯一时刻，§2.5）。`kwl.tid` 取请求头 `x-kwl-tenant` 或请求体 `tid`（开通与登记）——验签之前设定没有越权问题：RLS 只把查询限制在**声明的**租户内，验签不过即回滚。运维操作（开通、续订、终止）由 `cp-api` 内部管理接口以同样方式按目标租户设定。

**为什么不用“每租户一个库/schema”**：试点 3–5 家、G2 数百家，单库 RLS 足够；订阅需要跨租户汇总，分库会把订阅构建变成扇出查询。G3 若出现专属实例需求再按租户迁出。

### 2.4 事务模型与单调版本号

**选择**：写路由 `READ COMMITTED` + 显式行锁，锁顺序固定为 **租户行 → 草稿/摘要行 → `cp.meta` 行（最后、紧挨提交）**；读文档路由 `REPEATABLE READ READ ONLY`。

| 方案 | 结论 | 理由 |
|---|---|---|
| SERIALIZABLE（SSI） | 不用 | ①要求整个处理函数可重试，但处理中已消耗 nonce、可能已调用签名服务，重试语义复杂；②每个改变订阅的写都要更新 `cp.meta.feed_version`，在 SSI 下几乎所有写互相冲突，等于串行化加中止；③RLS 过滤下的谓词锁粒度粗，假冲突多 |
| `SELECT … FOR UPDATE` 租户行 | **采用** | 同一租户的写天然串行（v0 单线程事件循环即此语义），计数器在租户行内“读—改—写”无竞态；不同租户并行；不会死锁（固定锁序）；不需要重试 |
| 全局计数用序列（`nextval`） | 不用 | 序列按分配顺序而非提交顺序：事务 A 取 10、B 取 11、B 先提交，增量订阅 `since=11` 会永久漏掉 A 的吊销 |
| 全局计数用 `cp.meta` 单行 `UPDATE … RETURNING` | **采用** | 行锁持有到提交，版本顺序 = 提交顺序；回滚的事务连同计数一起回滚，journal 序号无空洞；写入量低（吊销、发布、摘要上报，试点期估计 <10 次/秒），锁持有时间只是提交前的一条语句 |

**订阅版本（全局）**：

```sql
UPDATE cp.meta
   SET feed_version = GREATEST(feed_version + 1, (extract(epoch FROM clock_timestamp()) * 1000)::bigint),
       journal_seq  = journal_seq + 1,
       updated_at   = clock_timestamp()
 WHERE id = 1
RETURNING feed_version, journal_seq;
```

- 订阅器只拒“比已接受的小”（`feed-subscriber.ts:87`），没有跳跃上限，因此可以用毫秒时钟做下限：**从备份恢复后第一次变更就自动越过网关手里的版本**（§6.3），且“订阅滞后”指标直接等于毫秒差（Y2 §6.2）。
- 不改变订阅的写只取 `journal_seq`（同一行同一锁）。

**租户内版本**（客户端有跳跃上限，不能用时钟）：在租户行锁内 `UPDATE cp.tenants SET directory_version = directory_version + 1 … RETURNING directory_version`。策略版本沿用“已发布 + 1、草稿不占版本号”（`server.ts:628-629`），草稿起草时读 `GREATEST(tenants.policy_version, max(policies.version)) + 1`，发布时在租户行锁下复核“没有同号或更高已发布”（`server.ts:673`）并作废同号及更早的未发布草稿（`:676`）。连接器同理用 `cp.connector_floor`。

**读文档的一致性**：目录 = `tenants.directory_version` + 三张表的内容，必须来自同一快照，否则可能出现“版本 V、内容是 V+1”的目录，诚实控制面也会触发客户端 `version_conflict`。`REPEATABLE READ READ ONLY` 在 PostgreSQL 中不会因序列化失败中止，代价只是一个快照。

### 2.5 “同一时刻”与许可签发时刻单调

- **唯一时刻**：每个请求在事务第一条语句取 `clock_timestamp()`（主库时钟，记 `reqNow`），之后所有计算只用它：设备请求时钟偏差判断（`request-auth.ts:72-74` 的 `now`）、`server_time`（`server.ts:452,546`）、许可 `issued_at/expires_at`（`:272-281`）、目录（`:478-482`）、策略草稿（`:627-629`）、席位令牌 `iat` 与回复 `expires_at`（`:592-593`，更正 F-3）、吊销时刻、订阅 `issued_at`（`:504`）。签名服务校验 `reqNow` 与自身时钟相差 ≤5 秒（§4.3），超出拒签并告警。
- **为什么用库时钟**：`cp-api` 至少 3 副本跨可用区，各节点 NTP 误差毫秒级；主库只有一个，取它的时间让“同一租户的连续两次签发”至少在同一时钟上比较。
- **许可单调**：客户端拒收签发时刻**早于**已接受许可的许可（`governance.ts:454`，写明“回放”）。主备切换、跨区域恢复后主库换了一台机器，时钟可能慢几毫秒，会让刚同步过的设备收到一条吓人的“回放”告警。生产：

```sql
INSERT INTO cp.tenant_clock AS c (tid, last_license_iat) VALUES ($tid, $reqNow)
ON CONFLICT (tid) DO UPDATE
  SET last_license_iat = GREATEST(c.last_license_iat + interval '1 millisecond', EXCLUDED.last_license_iat)
RETURNING last_license_iat;   -- 即本次许可的 issued_at
```

  订阅已终止时沿用 v0 的“签发时刻 − 1 毫秒、到期即签发时刻”（`server.ts:275-279`）：取得的 `iat'` ≥ 上次 + 1ms，于是 `iat' − 1ms ≥ 上次`，客户端不判回放（它只拒严格小于）。写入量 = 设备同步频率（缺省 10 分钟一次），1 万台设备约 17 次/秒，单行小写，且不与租户行锁争用（独立表）。
- **验收**：`clock.test.ts`——①模拟两个副本时钟相差 ±200 ms 交替签发许可，客户端（真实 `FirmGovernance.applyLicense`）0 次 `replayed`；②模拟主库时钟回拨 2 秒（切换），同上；③终止订阅后许可立即到期且客户端进入退出模式。

### 2.6 逐路由事务表

| 路由 | 隔离 | 锁 | 改动的计数 | 订阅变更 | journal 动作 |
|---|---|---|---|---|---|
| POST `/v1/enroll` | RC | 租户行 | — | — | `tenant.root_enrolled`（含根公钥 PEM） |
| POST `/v1/devices/register` | RC | 租户行 | 新设备或换证：`directory_version+1`、`device_ordinal+1`；自动分配席位：`seat_counter+1`、`seat_ordinal+1` | — | `device.registered` / `device.cert_replaced`（含证书原文）/ `seat.assigned` |
| GET `/v1/directory`、`/v1/policy`、`/v1/connectors` | RR 只读 | — | — | — | —（读不记 journal；访问日志另记） |
| GET `/v1/license` | RC | `tenant_clock` 行 | — | — | — |
| GET `/v1/tenant-salt` | RR 只读 | — | — | — | —（解密走字段数据密钥缓存，§5.3） |
| POST `/v1/seat-token` | RC | — | — | — | `seat.token_issued`（tid、uid、sid、dev、kid、iat、exp；**无令牌**） |
| PUT `/v1/anon-matters/{anon}` | RC | 摘要行（先 `INSERT … ON CONFLICT DO NOTHING` 再 `FOR UPDATE`） | 有变化：`feed_version` | `matter` | `matter.summary_updated`（摘要全文） |
| GET `/v1/drafts`、`/v1/drafts/{id}` | RR 只读 | — | — | — | — |
| POST `/v1/drafts` | RC | 租户行 | —（草稿不占版本号） | — | `draft.created`（文档原文） |
| POST `…/signatures` | RC | 草稿行 | — | — | `draft.signed`（签名条目） |
| POST `…/publish` | RC | 租户行 → 草稿行 | 策略：`policy_version = doc.version`；连接器：`connectors_version+1`、`connector_floor`、必要时 `connector_ordinal+1` | `policy`（v0 两类都 `feedVersion+1`，`server.ts:690`，保留） | `policy.published` / `connector.published`（签名文档全文） |
| DELETE `/v1/connectors/{id}` | RC | 租户行 | 有删除：`connectors_version+1` | — | `connector.withdrawn` |
| POST `/v1/devices/{id}/revoke` | RC | 租户行 | `directory_version+1`；预先吊销 `pre_revoked_ordinal+1` | `device_revoked` | `device.revoked` / `device.pre_revoked`（含证书） |
| POST `/v1/seats/{uid}/revoke` | RC | 租户行 | `directory_version+1` | `seat_revoked` | `seat.revoked` |
| GET `/v1/feed/gateway` | RR 只读（`cp_feed`） | — | — | — | — |
| 运维：开通 / 续订 / 终止 | RC | 租户行（开通为 INSERT） | 开通：发布最严模板 v1（`server.ts:283-288`）`feed_version` | `tenant` / `policy` | `tenant.created`（盐**只存密文与 dek_id**）/ `tenant.renewed` / `tenant.terminated` |

**签名调用放在事务外**：读路由在快照内组好 `body` 后提交（或回滚只读事务），再调签名服务；写路由提交后再签需要回复的文档（吊销通知）。签名服务故障只影响回复，不影响已提交的状态（与 v0“先持久化再回复”一致：客户端拿不到回复会重试，写操作均幂等——登记“同一证书”不改（`server.ts:553`）、吊销已吊销直接返回（`:333,338`）、发布已发布回 409 `draft_published`（`:657`））。

**订阅快照签名缓存**：全量订阅按 `feed_version` 缓存签名结果（Redis `kwl:cp:feed:{版本}`，TTL 120 秒），网关多副本每 30 秒拉一次（`feed-subscriber.ts:120`）不会让签名服务按副本数放大。

### 2.7 摘要一致性（同号必须同文）

| 文档 | 客户端摘要 | 生产输出规则 |
|---|---|---|
| 目录 | `sha256(canonicalJson({version, devices, revoked_devices, revoked_seats}))`（`governance.ts:581`） | `devices`：`cert_json` 逐条 `JSON.parse`，`ORDER BY ordinal`；`revoked_devices`：先 `devices` 中已吊销者（按 `ordinal`），再 `pre_revoked`（按 `ordinal`）——与 `server.ts:484-487` 相同；`revoked_seats`：`seats` 中已吊销者按 `ordinal`（`:488`）；`revoked_at` 用 `toISOString()` |
| 连接器目录 | `sha256(canonicalJson({version, entries}))`（`governance.ts:838`） | `entries` = `connectors_current ORDER BY ordinal` 关联 `connector_versions` 原文 |
| 策略 | `bytesDigest(policySigningBytes(doc))`（`policy.ts:190-191`） | `doc_json` 原文 |

**约束**：一个版本号一旦签发过，其内容只能由“该版本时刻的状态”决定。由于每次影响目录内容的写都会 `directory_version+1`，且读在单快照内，这条自动成立；唯一例外是**换证**（同一设备换证书时 v0 `directory_version+1`，`server.ts:553-556`）和**证书过期**（不改内容，客户端自行判断）——均已覆盖。

**验收**：`digest-stability.test.ts`——同一场景脚本分别跑在内存实现（v0）与 PostgreSQL 实现上，逐版本比较三类文档的客户端摘要完全相等；含“换证后保持位置”“连接器撤下再登记排到末尾”“预先吊销排在登记吊销之后”。

### 2.8 从 v0 两代交替文件迁移

v0 试点形态把整份状态写进 `<路径>.1/.2`（`state-store.ts:5-11,49-143`），快照格式为 `{v:1, feedVersion, tenants:[…], nonces:[…]}`（`server.ts:187-207`）。迁移步骤（一次性工具 `services/control-plane/tools/migrate-v0.ts`）：

1. **停写**：v0 进程正常关闭（`server.on("close")` 会把未落盘的 nonce 写下，`server.ts:733-741`）；记下停写时刻 `T0`。
2. **读取**：用 `fileStateStore(path, {key, requireKey: true}).load()` 取序号最大且校验通过的一代（两代都坏即拒绝，`state-store.ts:94-97`）；`st.v !== 1` 拒绝。
3. **写入**（一个事务，`cp_migrator`）：
   - 租户：`salt_b64` 用新数据密钥加密写 `salt_ct`；`created_at`、`subscription_until` 原样；`root_public_key_pem` 原样；计数器 `directoryVersion/connectorsVersion/seatCounter` 原样；`policy_version = policy?.doc.version ?? 0`。
   - 设备、预先吊销、席位、连接器、草稿、摘要：**按 v0 数组顺序**（快照里 `[...Map]` 即插入顺序，`server.ts:191`）赋 `ordinal = 1..n`；证书与文档 `JSON.stringify` 原样存文本。
   - 已发布策略只有当前一份（v0 不留历史），写入 `cp.policies` 一行；已发布的连接器各写一行版本；`connector_floor.max_version` = `max(当前版本, 已发布草稿中该连接器的最高版本)`（与 `server.ts:638-641` 同口径）。
   - 订阅版本：`feed_version = max(v0.feedVersion, T0 毫秒)`；`journal_seq = 0`；为每个租户写一条 `migration.imported` journal（计数与各表行数）。
   - nonce：快照里未过期的 `[key, exp]` 写入 Redis（`PX = exp − now`）；或简单地在迁移后 10 分钟内开恢复围栏（§6.3），二选一，**建议后者**（少一条代码路径）。
4. **对拍**：迁移后对每个租户、每类文档，用 v0（读同一快照的内存实例）与新实现分别生成 body，比较客户端摘要（§2.7）和版本号；任一不等即回滚迁移。
5. **切换**：DNS/ELB 指向新 `cp-api`；保留 v0 状态文件（只读）30 天。

**验收**：`migrate-v0.test.ts`——用现有 `state-store.test.ts` 与 `control-plane.test.ts` 的场景生成 v0 快照（含封装形态），迁移后跑客户端同步（真实 `ControlPlaneClient` + `FirmGovernance`），断言 0 条 `replayed`/`version_conflict`/`version_jump` 告警、高水位不变、吊销集一致。

### 2.9 代码改动点

| 文件 | 改动 |
|---|---|
| `services/control-plane/src/server.ts` | 抽出存储接口 `ControlPlaneRepo`（异步）：`withTenantTx(tid, fn)`、`readSnapshot(tid, fn)`、`bumpGlobal()`；路由处理改为调用它；内存实现保留（开发与测试），`StateStore` 只服务内存实现；`seal()` 改为注入的 `Signer`（§4.8）；`ops.seal` 与 `ops.touch`（`:140-143`）从生产入口移除，只在测试构建导出；`authDevice` 改为异步验签 + nonce（§3.4） |
| `services/control-plane/src/pg-repo.ts`（新） | PostgreSQL 实现：连接池（`cp_app`、`cp_feed` 两个池）、事务封装、`set_config('kwl.tid')`、§2.6 的语句 |
| `services/control-plane/src/state-store.ts` | 不改；文档注释标注“仅试点单实例与迁移源” |
| `services/control-plane/migrations/0001_init.sql`（新） | §2.2–§2.3 的 DDL；版本化迁移工具（建议 `node-pg-migrate` 或自写 SQL 顺序执行器，**选型待定**，不在本设计内安装） |
| `services/control-plane/tools/migrate-v0.ts`（新） | §2.8 |
| `services/control-plane/src/feed-subscriber.ts` | 鉴权改 mTLS（`:79` 去掉 Bearer，保留开发形态）；**落盘最后一份验过的订阅信封，启动先读**（§6.2，属 S4 但 DR 依赖它） |

### 2.10 测试与验收

| 用例 | 断言 |
|---|---|
| 现有 `services/control-plane/test/{control-plane,state-store}.test.ts`（共 17 个用例块）、`legal-gateway/test/gateway-feed.test.ts`、`kernel/test/t17-drill.test.ts` | **参数化跑两种后端**（内存 / PostgreSQL），全部通过 |
| `contract.test.ts`（新） | 录制 v0 对一组脚本请求的应答（去掉 `sig`、时刻字段），PostgreSQL 实现逐条比较状态码、错误码、JSON 结构；覆盖全部 14 条路由与 `server_time`、`notice` 附加字段 |
| `rls.test.ts`（新） | 以 `cp_app` 连接、`kwl.tid=A` 时对 B 的每张表 SELECT/UPDATE/INSERT 均 0 行或报错；未设 `kwl.tid` 时 0 行；`cp_feed` 读不到 `cert_json`；`cp_ops` 读不到 `salt_ct` |
| `concurrency.test.ts`（新） | 同一租户并发 50 个登记 + 10 个吊销 + 5 次发布：版本号连续无重复、客户端无 `version_conflict`；两租户并发互不阻塞；`feed_changes` 的版本与提交顺序一致（增量订阅不漏） |
| `sticky.test.ts`（新） | 直接 SQL 试图把 `revoked_at` 改回 NULL、替换根公钥 → 触发器拒绝 |
| 性能基线 | 预发：1 万台设备、每 10 分钟同步，p99 读路由 <150 ms、写路由 <300 ms；`cp.meta` 行锁等待 p99 <20 ms |

---

## 3. nonce、重放与限流迁 Redis

### 3.1 键设计

| 用途 | 键 | 值 / 命令 | TTL | 实例 |
|---|---|---|---|---|
| 设备请求 nonce | `kwl:{env}:cp:n:{tid}:<h>`，`h = base64url(sha256(device‖0x00‖nonce))[0:22]` | `SET <键> 1 NX PX 600000`；返回 nil 即重放 | 10 分钟（= 2 × 5 分钟时钟窗，与 `server.ts:255` 相同） | `redis-cp-nonce`（`maxmemory-policy noeviction`） |
| 控制面限流（设备） | `kwl:{env}:cp:rl:d:{tid}:{device}:{类}:{分钟}` | `INCR` + 首次 `PEXPIRE 120000` | 2 分钟 | `redis-cp-rl`（`volatile-ttl`） |
| 控制面限流（租户） | `kwl:{env}:cp:rl:t:{tid}:{类}:{分钟}` | 同上 | 2 分钟 | 同上 |
| 未鉴权入口限流 | `kwl:{env}:cp:rl:ip:{来源 /24}:{分钟}` | 同上（只用于 `/v1/enroll` 与登记前的证书校验失败） | 2 分钟 | 同上 |
| 订阅签名缓存 | `kwl:{env}:cp:feed:{feed_version}` | 签名后的信封 JSON | 120 秒 | 同上 |
| 网关（S4，仅约定键空间） | `kwl:{env}:gw:*` | 全局令牌桶、租户并发、额度租约 | — | 网关独立实例，不与控制面共用 |

- `{tid}` 写成哈希标签，集群模式下同一租户的键落在同一分片。nonce 键不含 nonce 原文与设备编号明文（只是减少日志与监控中的标识暴露，不是安全边界）。
- **限流类与额度（建议值，预发校准）**：读文档类（directory/license/salt/policy/connectors/drafts GET）每设备 60 次/分钟；`seat-token` 每设备 10 次/小时；写类（register、anon-matters、drafts 写、revoke）每设备 120 次/分钟、每租户 600 次/分钟；`enroll` 每 /24 网段 10 次/分钟。超限 429 `rate_limited`（新错误码；客户端按非永久错误处理：`client.ts:53-60` 的永久错误表不含它，下次同步重试）。

### 3.2 顺序：先验签、后记 nonce

保持 `request-auth.ts:75-84` 的顺序：时钟偏差 → 公钥 → 验签 → nonce。未通过签名的请求**不写 Redis**（否则任何人都能用随机 nonce 撑满 nonce 实例）。

### 3.3 故障处理（逐路由）

**两级**：Redis（超时 50 ms、熔断）→ 降级到 `cp.nonce_fallback`（`INSERT … ON CONFLICT DO NOTHING RETURNING k`；有返回即首次，无返回即重放；每分钟 `DELETE … WHERE exp < now()`）。降级表是普通表（有 WAL、随主备同步），所以 **Redis 单独故障时所有路由仍有完整的重放保护，不需要失败开放**。下表只在“Redis 与降级表都不可用”（实际上等于主库不可用或被运维显式关闭降级）时生效：

| 路由 | nonce 不可用时 | 理由 |
|---|---|---|
| POST `/v1/seat-token` | **失败关闭**（503 `control_plane_unavailable`） | 席位令牌是 96 小时持有者凭据（网关不做逐请求设备签名，D-33），重放即可在响应里拿到别人的令牌 |
| GET `/v1/tenant-salt` | **失败关闭** | 盐是秘密（§1.4） |
| GET `/v1/directory`、`/v1/license`、`/v1/policy`、`/v1/connectors`、`/v1/drafts`、`/v1/drafts/{id}` | **失败关闭** | 响应含成员与设备清单（个人信息）；客户端已接受的文档继续有效（许可 30 天、席位 ≥72 小时），关闭的代价只是推迟同步 |
| POST `/v1/devices/register` | **失败关闭** | 写入路径；登记可等 |
| POST `/v1/drafts`、`…/signatures`、`…/publish` | **失败关闭** | 改变律所治理状态，可等 |
| POST `/v1/devices/{id}/revoke`、`/v1/seats/{uid}/revoke` | **失败开放**（每副本进程内 10 分钟 LRU 兜底） | 收紧且幂等（已吊销直接返回，`server.ts:333,338,355`）；重放最坏是重复吊销；撤权不能因缓存故障延迟 |
| DELETE `/v1/connectors/{id}` | **失败开放**（同上） | 收紧且幂等（`server.ts:698`） |
| PUT `/v1/anon-matters/{anon}` | **失败开放**（同上） | 只接受更高版本或同版本更严合并（`server.ts:604-606`），重放旧摘要不能放宽 |
| POST `/v1/enroll` | 不涉及 | 无 nonce；开通证明自带 5 分钟时刻窗（`server.ts:521`）且入组幂等、根公钥不可替换 |
| GET `/v1/feed/gateway` | 不涉及 | mTLS 服务间 |

**限流**故障一律**失败开放**到每副本进程内令牌桶（限流是可用性保护，不是安全边界），`enroll` 与登记前证书校验失败的网段限流在进程内同样执行。

**残余**：DCS 主备切换时主从异步复制，切换前最后一刻写入的 nonce 可能丢失 → 在切换后的 5 分钟时钟窗内存在一次重放机会（攻击者须已截获 TLS 内的已签名请求）。降级表随数据库同步复制，无此问题。DCS 的复制方式、AOF 每秒刷盘与切换时延**待核实**（未取得华为云官方文档，附录 A）。

### 3.4 代码改动点

| 文件 | 改动 |
|---|---|
| `packages/firm-trust/src/request-auth.ts` | 拆出 `parseDeviceRequestHeaders()`（`:62-71`）、`verifyDeviceRequestSignature(headers, req, {publicKeyPem, now})`（`:72-83`，**字节构造不变**），由服务端异步取公钥与写 nonce；保留现有同步 `verifyDeviceRequest`（内核与测试在用），内部改为调用拆出的函数 |
| `services/control-plane/src/nonce-store.ts`（新） | `NonceStore.claim(key): Promise<"fresh"\|"replayed"\|"unavailable">`，Redis → 降级表 → 进程内 LRU；按 §3.3 的路由表决定 `unavailable` 的去向 |
| `services/control-plane/src/rate-limit.ts`（新） | §3.1 |
| `services/control-plane/src/server.ts` | `seenNonce`（`:251-258`）、`nonces` Map（`:178`）与 30 秒定时写（`:237-246`）只留在内存实现 |

### 3.5 测试与验收

`nonce-redis.test.ts`：①同一签名请求两次 → 第二次 401 `device_auth_replayed`（错误码与 v0 相同）；②签名无效的请求不写 Redis；③Redis 停机（测试中关闭容器或注入故障）→ 降级表接管，重放仍被拒；④Redis 与降级都不可用 → 席位令牌/盐/读路由 503、吊销 200；⑤TTL 到期后同 nonce 因时钟窗已过以 `device_auth_stale` 拒绝（不是被当作新请求）；⑥多副本：请求在副本 A、重放到副本 B 仍被拒。

---

## 4. 签名服务隔离（`cp-signer`）

### 4.1 算法与 KMS/HSM 可行性（以现有代码为准）

**现有算法**：控制面两把私钥都是 **Ed25519**（`server.ts:63-67` 用 `generateKeyPairSync("ed25519")`；信封 `sign(null, …)`，`envelope.ts:32`；席位令牌 `sign(null, …)`，`seat-token/src/index.ts:31`）。客户端与网关用 `crypto.verify(null, …)` 验 **纯 Ed25519（RFC 8032 PureEdDSA）**（`envelope.ts:47`、`seat-token/src/index.ts:64`）。信封、席位令牌、设备请求都**签整段消息，不是摘要**。

| 选项 | 华为云现状（2026-10-15 核实） | 与现有格式兼容 | 结论 |
|---|---|---|---|
| 共享 KMS 自定义密钥 `ED25519` + `ED25519_SHA_512` + `message_type=RAW` | “密钥算法类型”页列出 ED25519（自定义密钥、外部密钥支持）；签名接口 `signing_algorithm` 含 `ED25519_SHA_512`；**`message` 须 <4096 字节**（Base64 编码传输），`message_type` 缺省 `DIGEST` | **待 PoC**：需确认 `ED25519_SHA_512 + RAW` 输出即 RFC 8032 纯 Ed25519（Node `verify(null)` 能验）；文档未写 Ed25519 是否强制 RAW | **席位令牌可用**（签名消息 `zst1.<载荷>` 约 250–350 字节）；**信封不可用**：目录约 0.6 KB/台（`cp-relay.ts:39` 注释），7 台以上即超 4 KB；订阅跨全部租户；策略信封含管理员签名与证书原文，2 个签名即可能超 4 KB |
| 共享 KMS `ED25519_PH_SHA_512` | 有 | **不兼容**（Ed25519ph 与纯 Ed25519 签名不同，客户端验不过） | 不用（改即改格式） |
| 专属密钥库 / 专属加密（DHSM） | 专属密钥库**不支持 ED25519**（支持 AES、SM4、RSA、EC_P256/P384、SM2） | 不兼容 | 只能在 G2 算法敏捷后使用 |
| KMS/HSM 内 `EC_P256`（ECDSA）或 `SM2`（SM2DSA_SM3） | 有（SM2 对消息签名需按 GB/T 32918 先算 Z(A)‖M 的摘要） | **不兼容**（需 `kid → alg` 与 DER/SM2 签名格式，客户端与网关改验签） | Y2-U1 的路径 B，G2 前做 |
| **路径 A**：签名服务进程内 Ed25519，私钥静态由 KMS CMK（SM4 或 AES-256）信封加密 | KMS 对称加解密可用 | **完全兼容** | **M1 采用（两把都用）** |

**决定 D-P7**：M1 两把密钥都走路径 A（与 Y2 一致，少一个外部依赖进入 M1 关键路径）；同时做 **PoC-1**（KMS 内 Ed25519 席位签名与 Node 验签互通、单次时延、接口限频、跨区域副本是否支持 ED25519）。PoC 通过后，**席位密钥**在第一次计划轮换（§4.7）时换成 KMS 内密钥（私钥永不出 KMS）；信封密钥维持路径 A 直到 G2 算法敏捷。密评对路径 A 的判定**需合规确认**（§5.4）。

### 4.2 部署与网络

| 项 | 决定 |
|---|---|
| 部署单元 | CCE 独立节点池 `np-signer`（2 节点跨可用区，污点只允许 `cp-signer`），`cp-signer` 2 副本；节点关闭 swap、内核 `core_pattern` 置空、容器 `ulimit -c 0`、只读根文件系统、无 shell 镜像、不开调试端口 |
| 子网 | 签名区子网（Y2 §4.2 拓扑），**无 EIP、无 NAT 路由**；安全组入站只允许 `cp-api` 子网到 8443；出站只允许 KMS 与 CSMS 的 VPC 终端节点、OBS 审计桶终端节点（VPC 终端节点对 KMS/CSMS 的支持**待核实**；不支持则走云内网服务地址并以安全组 + 网络 ACL 限定） |
| mTLS | 内部私有 CA（华为云私有证书服务或自建离线根，**待选型**）；服务证书 30 天、自动轮换；`cp-signer` 只接受 SAN = `spiffe://kwl/<env>/cp-api` 的客户端证书；`cp-api` 只信任 SAN = `spiffe://kwl/<env>/cp-signer` 的服务端证书；同一套 CA 用于网关/检索 → 控制面订阅（替代 `server.ts:569-575` 的共享密钥） |
| 身份与权限 | `cp-signer` 所在节点的 IAM 委托只有：对 `kwl-<env>-cp-signer-wrap` 的 `Decrypt`、对签名私钥凭据的 `GetSecretValue`、对 `kwl-<env>-signer-log` 桶的 `PutObject`；`cp-api` 的委托**没有**这些权限 |
| 启动 | 从 CSMS 取私钥密文 → KMS `Decrypt` → `createPrivateKey` 得 `KeyObject` → 立即 `fill(0)` 清掉明文 Buffer；启动时用公钥自检一次签名；任一步失败拒绝就绪 |
| 不做的事 | 不连数据库、不连 Redis、不出公网；不提供“导出公钥以外”的任何密钥操作接口 |

### 4.3 结构化签名接口（只接受结构，不接受字节）

| 接口 | 请求 | 签名服务的校验（任一不过即拒签、记审计 `result=rejected`） | 产出 |
|---|---|---|---|
| `POST /v1/sign/envelope` | `{request_id, req_now, kind, body}` | ①`kind` ∈ {`kwl-license`, `kwl-device-directory`, `kwl-tenant-salt`, `kwl-firm-policy-current`, `kwl-firm-connectors`, `kwl-gateway-feed`, `kwl-device-revoked`}（`envelope.ts` 头注释与 Y2 附录 A.1 列出的 7 种）；②`|req_now − 签名服务时钟| ≤ 5 s`；③按种类校验 body（见下）；④请求体 ≤ 8 MiB | `{kind, kid, body, sig}`——字节由 `firm-trust` 的 `envelopeBytes` 生成（同一包同一函数） |
| `POST /v1/sign/seat-token` | `{request_id, req_now, tid, uid, sid, dev, ttl_s}` | `ttl_s ∈ [72h, 96h]`（I-5）；字段字符集与长度（与 `DEVICE_ID_PATTERN` 一致）；`iat` 由 `req_now` 取整秒 | `zst1.…`——由 `seat-token` 包的 `issueSeatToken` 生成 |
| `GET /v1/public-keys` | — | — | `{envelope: {kid: pem}, seat: {kid: pem}}`（只公钥） |

按种类的 body 校验（签名服务内复用 `firm-trust` 的校验函数，不判断宽严）：

| kind | 校验 |
|---|---|
| `kwl-license` | `validateLicense`（`docs.ts:25-36`）：有效期 ≤30 天、`issued_at` 与 `req_now` 相差 ≤5 s（终止许可允许 `issued_at = req_now − 1ms`） |
| `kwl-device-directory` | `tid`、`version` 为安全整数、`expires_at − issued_at ≤ 30 天`、`issued_at = req_now`；`devices` 每项是对象（**不**验证书签名——控制面只转交，客户端验） |
| `kwl-tenant-salt` | `purpose = "anon_matter"`、盐解码后 ≥16 字节（与客户端 `governance.ts:480-481` 同口径） |
| `kwl-firm-policy-current` | body 为 `null` 或 `{doc, admin_signatures}` 且 `validatePolicyDoc(doc)` 通过（`policy.ts:130-145`）；`admin_signatures` 为数组且 ≤16 条 |
| `kwl-firm-connectors` | `tid`、`version` 安全整数、`entries` 每项 `validateConnectorDoc` 通过 |
| `kwl-gateway-feed` | `version` 安全整数、四个数组字段齐全（与 `feed-subscriber.ts:87` 同口径） |
| `kwl-device-revoked` | `tid`、`device_id` 符合字符集、`revoked_at` 可解析 |

**能防什么、不能防什么（如实）**：能防——私钥被从 API 进程窃取（私钥不在 `cp-api`）；任意字节签名（例如把席位令牌当信封、或签名其他协议的消息——信封域分隔前缀由签名服务加，调用方给不了字节）；超长有效期许可与席位令牌；无审计的签名。不能防——已攻陷的 `cp-api` 仍可请求签署“格式合法”的任意租户许可或吊销通知；这一层仍靠 I-4（只够收紧）+ 签名速率异常告警（§4.4）+ 签名账与控制面 journal 对账（§7.3）兜底。G2 可选：签名服务对席位令牌请求只读核对 `seats`/`devices`（只读副本），拒签吊销设备的令牌。

### 4.4 签名审计

每次签名（含拒签）写一条：`{at, request_id, caller_san, kid, kind, tid, body_sha256, signed_sha256, result, reason}`——**不写 body**（订阅与目录含成员与设备清单）。本地内存批量（≤1 秒或 ≤500 条）写入 OBS WORM 桶 `kwl-<env>-signer-log`（与 journal 不同桶、不同委托），每批带上一批的哈希（哈希链）。写入失败时内存缓冲上限 10 万条，超过即**拒绝签名**（失败关闭：没有审计就不签）。

告警（接 Y2 §6.2）：签名错误任意一次 P1；某 `kind` 的签名速率超 7 日基线 5 倍 P1；`kwl-license` 对同一租户 1 分钟内 >100 次 P2；拒签任意一次 P2。

### 4.5 kid 命名与分环境

`kid = <用途>-<环境>-<yymm><序号>`：`cp-prod-2612a`、`seat-prod-2612a`、`cp-stg-2611a`、`seat-stg-2611a`、`cp-dev-*`。规则：

1. 每个环境独立密钥与独立 CMK；**生产客户端构建的 `release.json` 只含 `-prod-` 的 kid**，预发构建只含 `-stg-`（Y2 §4.1）。静态测试：`release-config.test.ts` 增加“生产 release.json 的公钥表只含 `-prod-` 前缀”的断言。
2. 网关与检索服务的公钥表来自各自部署配置（只公钥，ConfigMap），同样按环境。
3. kid 不复用；退役的 kid 留在签名账与文档里，不再出现在新构建的公钥表中。

### 4.6 签名私钥的静态形态

私钥 PKCS#8 DER → KMS `Encrypt`（CMK `kwl-<env>-cp-signer-wrap`，SM4，**加密上下文**写 `{"purpose":"cp-signer","kid":"cp-prod-2612a"}`，KMS 支持的上下文参数名**待核实**）→ 密文存 CSMS 凭据 `kwl-<env>-signer-<kid>`，并创建灾备区域副本（CSMS 副本凭据接口已存在，附录 A）。离线备份：同一私钥用离线备份公钥（§5.1 的 K5）加密后写两份介质，分别由两名境内保管人保存；恢复须两人到场（2-of-2 解密 + 第三人见证），流程写进运维手册。

### 4.7 密钥轮换与客户端信任列表过渡

**前提缺口（F-2，必须先修）**：`release.json` 增加两个字段，内核环境由 `release-config.cjs` 写入 `ZR_CONTROL_PLANE_KEYS`、`ZR_SEAT_KEYS`（`packagedKernelEnv` 已把 `release.env` 叠加进内核环境，`release-config.cjs:98-102`；内核已按 JSON `{kid: PEM}` 解析，`kernel/src/index.ts:127-128`、`envelope.ts:67-79`）：

```json
{
  "control_plane_keys": { "cp-prod-2612a": "-----BEGIN PUBLIC KEY-----…", "cp-prod-2706a": "-----BEGIN PUBLIC KEY-----…" },
  "seat_keys":          { "seat-prod-2612a": "…", "seat-prod-2706a": "…" }
}
```

校验规则与钉住集一致：**至少两把（当前 + 预发布的下一把）**、最多 8 把、每把能 `createPublicKey`、全部同一环境前缀；不合格即该项不进入环境（失败关闭 → 控制面文档全部拒收，安装包冒烟会失败，`--kwl-smoke` 增加一项“公钥表非空”）。

**过渡方案（客户端同时信任新旧 kid）**：信封只能带一个 `kid` 和一个签名（I-3），所以不能双签；客户端看不到“服务端何时切换”，服务端也看不到客户端版本（白名单请求头里没有版本，`cp-relay.ts:37`）。因此采用**预发布下一把**：

| 时点 | 动作 | 判据 |
|---|---|---|
| T−90 天 | 密钥仪式生成下一把 kid-B（两人在场，签名区内生成，按 §4.6 包裹与离线备份）；公钥入库 | 仪式记录入 journal |
| T−60 天 | 发布客户端版本 N：`release.json` 公钥表 = {kid-A, kid-B}；网关/检索配置 = {kid-A, kid-B} | 版本 N 通过灰度 |
| T−60 → T | 等待活跃设备升级 | 无内容遥测（S13）中“版本 < N 的活跃设备”<1% 且持续 7 天；律所版延迟通道另行通知 |
| T | 签名服务把**活跃 kid** 切到 kid-B（信封与席位可分别切） | 切换后 24 小时客户端遥测的 `envelope_unknown_key`/`seat_invalid` 计数无上升 |
| T + 30 天 + 96 小时 | 网关/检索配置去掉 kid-A（此时用 kid-A 签的许可、目录、策略都已过 30 天、席位令牌都已过 96 小时） | — |
| 下一个客户端版本 | 公钥表 = {kid-B, kid-C}（kid-C 为再下一把） | — |

- 版本 < N 的设备在 T 之后：新文档以 `envelope_unknown_key` 拒收，已接受的文档按各自有效期继续（许可 ≤30 天、席位 ≥72 小时）；自动更新通道的发布签名密钥与控制面密钥无关（`release-config.cjs:79-93`），升级即恢复。界面文案：控制面拒收告警已有，需补一句“请更新客户端”（客户端小改）。
- **应急轮换（kid-A 泄露）**：立即把活跃 kid 切到已预发布的 kid-B；网关去掉 kid-A 的席位公钥（所有 kid-A 席位令牌立即失效，客户端下次同步用 kid-B 重新取，客户端已信任 kid-B）。**残余**：仍信任 kid-A 的客户端在升级前，攻击者可用 kid-A 伪造信封——按 I-4 只能“收紧或延长许可”：可让已终止的律所继续用（≤ 伪造许可的 30 天，可反复）、可对设备发吊销通知（拒绝服务）、目录中的证书仍须律所根签发（不能加人）、订阅由网关配置去掉 kid-A 即失效。须同时发版移除 kid-A。
- **灾备 kid**：预发布的下一把同时充当灾备——若主区域 KMS 与 CSMS 副本都不可用，可用离线备份恢复 kid-A，或用离线保管的 kid-B 直接切换（§6.4）。

### 4.8 代码改动点、测试与验收

| 文件 | 改动 |
|---|---|
| `packages/firm-trust/src/envelope.ts` | 不改字节；新增 `Signer` 接口 `{ sealEnvelope(kind, body, reqNow): Promise<CpEnvelope>; issueSeatToken(claims, ttl, reqNow): Promise<string>; publicKeys() }`，`localSigner(keys)` 包装现有 `sealEnvelope`（开发与测试） |
| `services/cp-signer/`（新服务） | §4.2–§4.4；复用 `firm-trust`、`seat-token`、`keys` 包 |
| `services/control-plane/src/server.ts` | `o.keys`（`:116`）换成 `o.signer`；`publicKeys` 从 `signer.publicKeys()` 取（`:743-748`） |
| `apps/desktop/electron/release-config.cjs` + `release.example.json` + `release-config.test.ts` | F-2：`control_plane_keys`、`seat_keys` |
| `scripts/dev-cloud-v0.mjs` | 开发形态继续输出环境变量（`:77-78`），并生成 `release.json` 片段供本机打包冒烟 |

| 用例 | 断言 |
|---|---|
| `signer-golden.test.ts` | 固定私钥、固定 body：本地签名器与远程签名服务输出逐字节相同；客户端 `openEnvelope`、`verifySeatToken` 验过 |
| `signer-reject.test.ts` | 未知 kind、TTL 超限、`req_now` 偏差 >5 s、非 `cp-api` 客户端证书、超长 body、伪造的“原始字节”字段 → 全部拒签且有审计记录 |
| `signer-audit.test.ts` | 审计写入失败超过缓冲上限 → 拒签；哈希链连续 |
| `kid-rotation.test.ts` | 客户端信任 {kid-A,kid-B}：切换前后同步均成功、高水位不变；只信任 {kid-A} 的客户端切换后拒收并告警、已接受文档继续有效；网关去掉 kid-A 后旧席位令牌 401、客户端重取后恢复 |
| 安装包冒烟 | `release.json` 缺公钥表时冒烟失败 |

---

## 5. KMS 密钥层级

### 5.1 层级

```text
华为云 DEW / KMS（每环境一套，北京主；上海灾备为副本密钥，§6.4）
├─ K1 kwl-<env>-cp-signer-wrap   SM4（对称）     包裹签名私钥（信封 Ed25519、席位 Ed25519）→ 密文存 CSMS；只有 cp-signer 可 Decrypt
├─ K2 kwl-<env>-cp-field         SM4（对称）     生成数据密钥（DEK）→ 应用层字段加密（SM4-GCM / AES-256-GCM）；cp-api 可 GenerateDataKey/Decrypt
│     ├─ DEK tenant_salt（S1）   租户盐
│     ├─ DEK contact（S2）       账号手机号、邮箱、姓名；另有 HMAC 盲索引密钥（用于按手机号查找）
│     ├─ DEK im_credential（S10）IM 平台应用凭据（G2）
│     └─ HMAC 子密钥             cp.tenants.integrity_mac 的完整性校验（HKDF 从同一 DEK 派生，标签 "kwl-tenant-mac"）
├─ K3 kwl-<env>-rds              SM4 或 AES-256  RDS 磁盘加密（服务端）；RDS for PostgreSQL 对 SM4 的支持**待核实**
├─ K4 kwl-<env>-obs-audit        SM4 或 AES-256  OBS 服务端加密（SSE-KMS）：journal、签名账、计量冷存
├─ K5 离线备份公钥（不在 KMS）    SM2 或 X25519   跨云每日逻辑导出与签名私钥离线备份用公钥加密；私钥离线两人保管——恢复不依赖华为云 KMS
└─ K6 kwl-<env>-audit-checkpoint  SM2（非对称，KMS 内）  审计检查点签名（§7.3）：不面向客户端，可直接用国密且私钥不出 KMS
```

| 用途 | 加密方式 | 理由 |
|---|---|---|
| 签名私钥 | K1 直接 `Encrypt`（私钥 32 字节种子 / PKCS#8 远小于 KMS 单次加密上限，上限值**待核实**） | 只有一份密文，不需要数据密钥 |
| 数据库字段 | 信封加密：K2 生成 DEK，DEK 密文存 `cp.data_keys`，进程内缓存明文 DEK ≤1 小时 | 每次解密不打 KMS；KMS 不可用时缓存期内仍可服务 |
| 数据库整体 | RDS 磁盘加密（K3） | 等保 8.2“客户自管密钥”；防介质泄露 |
| 审计 / 计量冷存 | OBS SSE-KMS（K4）+ WORM | 同上 |
| 备份 | RDS 自动备份随 K3；跨云逻辑导出用 K5 公钥加密 | 8.2 要求“在本地保存业务数据备份”，且灾难时不能依赖原云 KMS |

### 5.2 哪些字段做应用层加密

| 字段 | 是否应用层加密 | 理由 |
|---|---|---|
| `cp.tenants.salt_ct`（租户盐） | **是**（K2/DEK，AAD = `tid`） | 秘密；盐 + 事项编号即可算出匿名编号；只在 `GET /v1/tenant-salt` 时解密 |
| S2 账号手机号、邮箱、姓名 | **是** + 盲索引（HMAC） | 个人信息；Y2 §3.2 |
| S10 IM 凭据（G2） | **是** | 凭据 |
| S3 开票信息（律所主体） | 否（机构信息），磁盘加密即可 | — |
| 设备证书、成员 ID、角色 | **否** | 证书须原样下发给本所设备并用于验签；对其应用层加密不改变下发面；靠 RLS + 磁盘加密 + 访问审计。**残余**：成员 ID 若含姓名即为个人信息——建议成员 ID 用不含姓名的随机编号（P-10） |
| 策略、连接器登记、管理员签名 | 否 | 律所配置，须签名与下发；连接器 URL 可能是内网地址，按 C3 管理 |
| 匿名摘要 | 否 | 已是假名化数据，网关需逐条比对 |
| journal `payload_json` | 否（整体 SSE-KMS + WORM）；**租户盐在 journal 里只有密文与 `dek_id`** | 恢复需要原文 |

### 5.3 完整性

`cp.tenants.integrity_mac = HMAC(派生密钥, tid‖edition‖seats‖subscription_until‖root_public_key_pem)`，读租户时校验，不符即 500 并 P1 告警（数据库被绕过应用直接改写）。设备证书不需要（客户端按律所根公钥验，控制面改不了）；策略与连接器不需要（管理员签名覆盖正文，`policy.ts:125-128`）。等保“数据完整性（重要业务数据、配置数据）”由此 + journal 哈希链覆盖（Y2 §5.1）。

### 5.4 国密要求（需合规确认）

| 事项 | 公开依据与现状 | 本设计的做法 |
|---|---|---|
| 等保三级是否要求密码技术 | 三级“身份鉴别须两种以上鉴别技术组合，其中至少一种使用密码技术”，数据完整性与保密性须“采用校验技术或密码技术”（GB/T 22239-2019 第 8 章，Y2 §2.3 概括；**标准原文未在本次重新核对**） | 已满足“使用密码技术”；未规定必须国密 |
| 密评（GB/T 39786-2021）是否适用、三级哪些条款是“应”哪些是“宜” | 公开解读称第三级在第二级基础上增加真实性、机密性技术要求，网络用户身份真实性 4 条为“应”（附录 A，安全内参文章，二手）；**重要数据存储机密性是“应”还是“宜”本次未取得标准原文——待核实** | 默认按“适用且须用经认证的密码产品与国密算法”准备：对称一律 SM4（K1–K4）、完整性 HMAC 可用 HMAC_SM3、审计检查点 SM2；**唯一不满足的是面向客户端的 Ed25519 签名**（信封与席位令牌）——若测评判定不符，须走 G2 算法敏捷（SM2 kid，Y2-U1 路径 B） |
| 传输层国密（TLCP） | 客户端 Node TLS 钉住 SPKI、标准 TLS 1.2+（`egress-gate/src/tls-policy.ts`）；随包 Node 是否支持 TLCP **待核实** | 首发不做；若密评要求，评估网关与控制面双栈 |
| 应用层 SM4-GCM | 随包/服务端 Node 26 所带 OpenSSL 的 SM4-GCM 可用性**待核实**（PoC-3） | 不可用则字段加密先用 AES-256-GCM（DEK 仍由 SM4 CMK 包裹），`cp.data_keys.alg` 记录算法以便迁移 |

**结论写法**：国密“能用即用”，Ed25519 的去留由合规负责人与测评机构在 M1 前给出书面意见（P-2）。

### 5.5 测试与验收

`field-crypto.test.ts`：盐加解密往返、AAD 换租户即失败、DEK 缓存过期后重新解密、KMS 不可用时缓存期内可读超期 503；`integrity-mac.test.ts`：直接 SQL 改 `seats` 或根公钥 → 读租户 500 并告警；预发验收：KMS 审计日志（CTS 云审计，对 KMS 调用的记录方式**待核实**）中 `Decrypt` 调用只来自 `cp-signer` 与 `cp-api` 的委托。

---

## 6. 容灾

### 6.1 目标与机制

| 对象 | RPO | RTO | 机制 |
|---|---|---|---|
| 控制面数据库 | 同城 AZ 故障 ≈0；区域故障 ≤15 分钟 | ≤4 小时 | RDS for PostgreSQL 主备跨可用区，**改为同步复制**（华为云该产品缺省异步、可选同步，附录 A）；跨区域：首选 DRS PostgreSQL→PostgreSQL 实时同步到上海（灾备场景对 PG 的支持与时延**待核实**，PoC-2），次选跨区域只读副本；跨区域备份（`SetOffSiteBackupPolicy`，PG 的全量与增量保留天数须一致、卷快照备份方式不支持跨区域，附录 A）作第二层；每日 K5 加密逻辑导出到中软自有存储作第三层 |
| journal | ≤ 外送间隔（目标 5 秒） | 随数据库 | 同库同事务写入；外送到北京 WORM 桶，桶开跨区域复制到上海（OBS WORM 与跨区域复制的组合约束**待核实**） |
| Redis（nonce、限流） | 不要求 | 分钟级 | DCS 主备跨可用区；区域故障时灾备区新建，nonce 由恢复围栏覆盖（§6.3） |
| `cp-api` | 无状态 | 同城 ≤5 分钟；区域 ≤1 小时（IaC 冷备） | 3 副本跨 AZ |
| `cp-signer` | 无状态（密钥在 CSMS） | 同城 ≤5 分钟；区域 ≤2 小时 | 见 §6.4 |
| 网关订阅快照 | — | 网关重启即恢复 | 网关落盘最后一份验过的订阅（§6.2） |
| 演练 | — | — | M2 前预发一次“从备份恢复 + 恢复围栏 + 对账”全流程；G2 前生产一次全量灾备演练；此后每半年 |

### 6.2 控制面停机期间的客户端与网关行为

| 组件 | 停机期间 | 覆盖时长 | 依据 |
|---|---|---|---|
| 席位令牌 | 继续用；剩余 <73 小时时续期失败，界面显示同步失败 | **≥72 小时**（签发 96 小时、同步间隔 ≤1 小时、<73 小时即续期） | `server.ts:247-248`；`governance.ts:127-131`；`client.ts:45-48` |
| 许可 | 继续有效 | ≤30 天（滚动签发） | `server.ts:268-281` |
| 设备目录 | 已接受的继续用；过期后界面提示吊销信息可能不完整 | ≤30 天 | `docs.ts:54,62` |
| 律所策略 | 按已接受版本；过期回退“产品基线 + 最严模板”且不比原策略宽 | 策略自身有效期（≤30 天） | `governance.ts:240-242`；进度文档阶段 6 |
| 本机吊销 | 本机立即生效（墓碑）；待同步动作排队，恢复后补发 | — | `client.ts:223-247` |
| 网关 | 按最后一份订阅继续二次检查与吊销；新吊销送不到 | 席位令牌有效期内 | `feed-subscriber.ts:5`（取不到保留上一份） |
| **网关在停机期间重启** | v0：订阅只在内存，重启后 `ready()` 为假、吊销集为空，**此前吊销的设备手里未过期的席位令牌（≤96 小时）重新可用** | — | `feed-subscriber.ts:26-42` |

**改动（D-P9 的一部分，S4 实施、S1 验收）**：`GatewayFeedSubscriber` 每次接受新订阅后把**签名信封原文**原子写入本地快照文件（网关 Pod 的持久卷或节点本地盘），启动时先读快照、按同一规则验签与版本，再联网刷新；快照只含订阅本身（匿名编号与吊销集，无内容）。验收：`gateway-feed.test.ts` 增加“控制面不可达时重启网关，已吊销设备的席位令牌仍被拒”。

RTO 4 小时 ≪ 72 小时：控制面在 RTO 内恢复时，律师侧无感（除了“同步失败”提示）。

### 6.3 恢复后的版本与高水位一致性：防回退方案

**风险（必须解决）**：从备份恢复（逻辑损坏、误操作、区域切换到有延迟的副本）会让以下计数回到过去，而客户端与网关的高水位不会：

| 计数 | 回退的后果（以客户端代码为准） |
|---|---|
| `directory_version` | 下发版本 < 客户端高水位 → `replayed` 拒收（`governance.ts:584-589`），**此后新的吊销到不了这台设备**直到计数追上；若恰好追到同一版本号而内容不同 → `version_conflict` 拒收（`:590`） |
| 策略版本 | 新发布的版本号可能等于客户端已接受的“丢失版本” → `version_conflict`（`policy.ts:195-198`） |
| 连接器目录 / 单个连接器版本 | 同上（`governance.ts:840-843`；`connectors.ts:116-120`） |
| `feed_version` | 订阅器拒收所有更小版本（`feed-subscriber.ts:87`），网关吊销集冻结 |
| `seat_counter` | 新分配的席位编号可能与“丢失期间分配并已被吊销”的编号相同 → 网关按 sid 拒绝新成员；或丢失的分配被重新分给他人 |
| 吊销记录 | 恢复点之后的吊销丢失 → 控制面与网关重新放行该设备（客户端墓碑仍在，`governance.ts:431-440`） |
| nonce | Redis 丢失 → 5 分钟时钟窗内可重放 |

**方案（五步，写进运维手册与 `tools/restore-reconcile.ts`）**：

1. **恢复围栏**：恢复后的实例启动即读 `cp.meta`，运维把 `fence_until` 设为 `max(now + 10 分钟, 事故时刻 + 10 分钟)` 并 `restore_epoch + 1`。围栏期内：全部 14 条路由与订阅路由返回 503 `control_plane_unavailable`（客户端按非永久错误重试，已接受文档继续有效）；开通、续订等运维操作同样拒绝。10 分钟 = 2 × 时钟窗，覆盖 nonce 丢失。
2. **journal 重放**：从 WORM 桶（北京或上海副本，取序号更大者）读取 `seq > 数据库中 journal 最大 seq` 的事件，按序幂等重放：吊销、预先吊销、席位分配与吊销、证书登记与替换、策略与连接器发布（签名文档原文）、连接器撤下、匿名摘要（按“更高版本才替换、同版本更严合并”）、租户开通（盐密文 + `dek_id`）、根公钥入组。每条重放写一条 `restore.replayed` journal。
3. **抬升下限（余量 < 客户端告警阈值）**：对每个租户在 journal 中出现过的最大值与库中值取大，再加余量：

   | 计数 | 余量 | 依据 |
   |---|---|---|
   | `directory_version` | +64 | 客户端 >1000 才告警（`governance.ts:141`）、>100,000 拒收（`:133`） |
   | `connectors_version` | +64 | 同上 |
   | `policy_version` | +3 | 策略 >10 告警（`governance.ts:140`）、>1000 拒收（`policy.ts:89`）；下次起草 = 余量后 + 1 |
   | `connector_floor.max_version` | +3 | 同策略（`connectors.ts:121`） |
   | `seat_counter` | +100 | 不受客户端约束；只需避开丢失期间可能分配的编号 |
   | `feed_version` | `GREATEST(当前, now 毫秒)` | 订阅器无跳跃上限 |

   余量覆盖的是“journal 外送尾部”（≤5 秒）内可能丢失、又已被部分客户端接受的版本。抬升后**立即**让目录与连接器目录版本生效（下一次 GET 即以新版本号下发同样内容）：已接受丢失版本的客户端看到“版本更高”而接受，不触发同号异文。
4. **对账**：`restore-reconcile` 输出每租户报告——重放事件数、抬升前后计数、journal 尾部时间缺口；签名账（签名服务自己的 WORM 日志，§4.4）中 `restore_epoch` 之前最后 N 分钟签过、但 journal 中没有对应事件的 `kwl-device-directory`/`kwl-firm-policy-current` 版本 → 列为“可能丢失的变更”，由运营逐租户通知律所管理员核对（控制台导出吊销清单）。
5. **解除围栏**：对账报告经两人复核后解除；网关订阅随即以毫秒版本越过旧值；客户端下一次同步恢复。

**余下的不可完全消除的残余（如实写进 Trust 页与运维手册）**：journal 尾部（≤5 秒）内的席位吊销若同时丢失于数据库与 journal，恢复后该席位重新有效，直到律所管理员核对后重新吊销（设备吊销有客户端“已提交待目录确认”的告警兜底，`client.ts:275-287`；席位吊销没有）。**客户端小改建议**（不改协议）：“已提交但 1 小时内目录仍未确认”的吊销动作自动重发一次（幂等），并把席位吊销也纳入待同步动作（`client.ts:231` 目前只处理 `revoke_device`）。

**验收**：`restore-fence.test.ts`——①在 PostgreSQL 实现上跑登记、吊销、发布若干次，记下客户端高水位；②把库回滚到中间时刻（`pg_dump` 快照）并丢掉 Redis；③执行 `restore-reconcile`；④断言：客户端同步 0 条 `replayed`/`version_conflict`/`version_jump`、大跳跃告警 0 条；网关订阅被接受；journal 中的吊销全部恢复；围栏期内全部路由 503；尾部丢失的吊销出现在对账报告中。反向对照：去掉第 3 步余量 → 用例失败（`version_conflict` 或 `replayed`）。

### 6.4 签名服务与 KMS 的灾备

| 场景 | 处置 | RTO |
|---|---|---|
| 单 AZ 故障 | `cp-signer` 第二副本在另一 AZ | 分钟 |
| 北京 KMS 不可用、上海可用 | 上海部署冷备 `cp-signer`（IaC），读 CSMS 上海副本凭据，用 K1 的上海副本密钥解密（KMS 跨区域副本密钥与主密钥共享密钥材料，附录 A；**支持哪些区域与密钥规格待核实**，PoC-4） | ≤2 小时 |
| 两区域 KMS 都不可用或副本密钥不可用 | 离线备份（K5）两人到场恢复私钥；或直接切到已预发布的下一把 kid（离线保管的那一份）| ≤4 小时 |
| 席位密钥若已改为 KMS 内 Ed25519（PoC 通过后） | 须在上海有同一密钥的副本（**副本是否支持 ED25519 待核实**）；不支持则该方案不进入生产 | — |

**验收**：预发演练“北京 KMS 拒绝 Decrypt”时上海 `cp-signer` 在 2 小时内签出客户端可验的目录与席位令牌。

---

## 7. 审计

### 7.1 结构

```text
cp-api 事务内 ──INSERT──▶ cp.journal（seq 无空洞、同事务）
                               │  cp_shipper（单主：pg_try_advisory_lock）
                               ▼ 每 ≤5 秒 / ≤1000 条一批
              OBS 桶 kwl-<env>-audit（创建时开 WORM 合规模式，默认保留 400 天；SSE-KMS K4；跨区域复制到上海）
                 对象：journal/<yyyy>/<mm>/<dd>/<seq起>-<seq止>.jsonl
                 每行：{seq, event_id, at, restore_epoch, tid, actor, action, object_id, result, request_id, counters, payload_json, prev_hash, hash}
                 hash = SM3 或 SHA-256(prev_hash ‖ canonicalJson(行去掉 hash))
                 每小时检查点：{seq, hash, at} 由 K6（KMS 内 SM2）签名 → checkpoints/<yyyy>/<mm>/<dd>/<hh>.json
cp-signer ──直写──▶ OBS 桶 kwl-<env>-signer-log（同样 WORM；独立委托）
```

- OBS WORM（合规模式）：保护期内任何人（含账号根用户）不能覆盖或删除对象版本；保留期 1–36500 天；只能延长不能缩短；开 WORM 须先开版本控制且不能暂停；生命周期规则不能删除受保护对象（附录 A，华为云 OBS 用户指南）。“须在创建桶时开启、之后不能再开”的说法来自镜像文档，**以华为云中国站原文为准（待核实）**——IaC 一律在建桶时开启。
- 保留期：journal 与签名账 **400 天**（≥1 年审计建议 + 缓冲；法定下限 6 个月）；受托处理记录（按租户导出的元数据报表）3 年，另设桶 `kwl-<env>-processing-records`。
- 库内 `cp.journal` 只保留已外送且早于最近检查点 30 天的行（恢复时从 WORM 读）。

### 7.2 事件白名单（不可写自由文本）

`action` 枚举：`tenant.created/renewed/terminated/root_enrolled`、`device.registered/cert_replaced/revoked/pre_revoked`、`seat.assigned/revoked/token_issued`、`draft.created/signed`、`policy.published`、`connector.published/withdrawn`、`matter.summary_updated`、`auth.rejected`（只记原因码，不记请求内容）、`restore.fenced/replayed/unfenced`、`migration.imported`、`key.ceremony/rotated`。`payload_json` 只允许：设备证书、签名的策略/连接器文档与管理员签名、匿名摘要、租户盐密文与 `dek_id`、计数。CI 规则（与 Y2 §6.1 日志规范同一扫描器）：写 journal 的代码只能经 `journal.append(action, fields)`，字段按动作白名单重建对象（沿用 `meter-file.ts:8-20` 的做法）。

### 7.3 防删改与可验证

1. 库内：`cp_app` 对 `cp.journal` 只有 INSERT/SELECT（§2.3）；`seq` 由 `cp.meta` 行锁分配，外送进程发现空洞即 P1。
2. WORM：合规模式，删除与覆盖在保护期内不可能。
3. 哈希链 + KMS 内 SM2 检查点签名：即使有人在外送前改了库内行，下游哈希链也会断；检查点公钥对律所公开（Trust 页），律所管理员可导出本所事件并自行验链（S14 律所导出，G1）。
4. 对账：每日作业比对签名账与 journal——每个 `kwl-device-directory`/`kwl-firm-policy-current` 签名都应能对应到一个 journal 中已存在的版本；签名账中多出的版本 = 有人绕过业务路径请求签名，P1。

### 7.4 运维访问

| 项 | 决定 |
|---|---|
| 入口 | 只经云堡垒机（华为云 CBH）+ 双因素（TOTP 或国密 USBKey）+ 会话录像；生产数据库无直连路由 |
| 人员 | **只限境内人员**（港方或境外人员访问即构成数据出境，Y2-U5）：堡垒机账号与中软境内员工身份绑定，来源地址限中软境内办公网出口；账号季度复核 |
| 数据库 | 人工只用 `cp_viewer`（只授 `v_tenant_overview` 等脱敏视图，无证书原文、无盐密文）；任何写操作走工单 + 双人复核 + 一次性临时账号（4 小时过期），执行记录进 journal（`actor = ops:<工单号>`） |
| 三权分立 | 系统管理员（IaC、发布）/ 安全管理员（KMS 策略、堡垒机策略）/ 审计管理员（只读审计桶与 SIEM）三类账号互斥 |
| 密钥 | 无人能导出签名私钥明文；密钥仪式与离线恢复须两人到场，记录入 journal |
| 云厂商访问 | 华为云运维对客户资源的访问须经客户授权（等保 8.2），授权记录归档 |

### 7.5 测试与验收

`journal.test.ts`：并发写入后 `seq` 连续、回滚事务不留空洞；`shipper.test.ts`：哈希链正确、检查点可验、库内行被改后验链失败；预发：用 OBS API 试图删除/覆盖受保护对象失败（等保测评证据）；律所导出与验链工具对一租户一个月事件验过。

---

## 8. 迁移与实施计划

### 8.1 时间线（与 v9.2 §5.5、§7 对齐）

| 时间 | 事项 |
|---|---|
| 10-15 | 本文 v1 草案 |
| 10-16 → 11-07 | PoC-1 KMS 内 Ed25519 与 Node 互通；PoC-2 RDS 同步复制写时延 + DRS 跨区域 PG 实时灾备时延；PoC-3 SM4-GCM 可用性；PoC-4 KMS 副本密钥（区域对、规格）、CSMS 副本凭据；PoC-5 OBS WORM + 跨区域复制组合。均可在华为云测试账号做，**依赖 M0 前取得云资源**；云未定前用本机 PostgreSQL/Redis 开发存储层 |
| 11-04 | **设计评审会**（v9.2 §7.1 第 3–5 周窗口内）；P-1～P-11 拍板 |
| 11-11 | v1 定稿（评审意见处置） |
| 11-20 | M0：云选型拍板 |
| 11-11 → 12-11 | S1 实现（下表）；S14 与平台工程并行 |
| **12-18** | **M1 预发上线**：控制面 PostgreSQL + Redis + `cp-signer`（路径 A）+ journal → WORM；客户端预发构建 `release.json` 含 `-stg-` 公钥；首次预发“恢复围栏 + 对账”演练 |
| 2027-01-22 | M2 试点生产：v0 状态迁移（§2.8）、生产密钥仪式、生产 kid 随客户端发布 |

### 8.2 人周拆分

**S1 控制面 + 签名服务：18 人周**（与 v9.2 §5.5 / Y2 §7.1 的 14 + 4 一致）

| # | 工作 | 人周 | 产出与验收 | 里程碑 |
|---|---|---:|---|---|
| S1-1 | 存储接口抽象与路由异步化（内存实现保持通过全部现有用例） | 2.0 | §2.9；现有 17 个控制面用例块 + T17 通过 | 11-20 |
| S1-2 | DDL、迁移脚本、RLS、角色、触发器 | 2.5 | §2.2–§2.3；`rls.test.ts`、`sticky.test.ts` | 11-27 |
| S1-3 | 14 + 1 条路由事务化、请求时刻、许可时钟、摘要一致性 | 3.0 | §2.4–§2.7；`contract.test.ts`、`digest-stability.test.ts`、`clock.test.ts`、`concurrency.test.ts` | 12-04 |
| S1-4 | nonce 与限流迁 Redis、验签拆分、降级表 | 1.5 | §3；`nonce-redis.test.ts` | 12-04 |
| S1-5 | 订阅：全局版本、`feed_changes` outbox、签名缓存、mTLS | 1.5 | §2.4、§2.6；增量订阅不漏的并发用例 | 12-11 |
| S1-6 | `cp-signer`：结构化接口、KMS 解封、mTLS、签名账、告警 | 3.5 | §4；`signer-*.test.ts`、`kid-rotation.test.ts` | 12-11 |
| S1-7 | 防回退：journal 写入、恢复围栏、`restore-reconcile` 工具 | 2.0 | §6.3；`restore-fence.test.ts` + 反向对照 | 12-18 |
| S1-8 | v0 状态迁移工具与对拍 | 1.0 | §2.8；`migrate-v0.test.ts` | M2 前 |
| S1-9 | 测试改造（双后端参数化）、预发演练脚本 | 1.0 | 全量用例双后端通过；演练记录 | 12-18 |
| | **合计** | **18.0** | | |

**S14 审计与安全运营（G1 部分）：6 人周**——WORM 桶与外送进程 2.0；哈希链、检查点签名与验链工具 1.5；堡垒机、数据库审计、KMS/CTS 日志接入 1.5；律所导出（本所审计事件与受托处理记录）1.0。M1 交付前三项，导出在 M2。

**平台工程/SRE（18 人周中与本文相关约 6.5）**：网络分区与安全组（签名区、数据区）、RDS（同步复制、跨区域）、DCS、OBS（WORM、跨区域复制）、KMS/CSMS（CMK、副本）的 IaC 3.0；内部 PKI 与 mTLS 证书自动轮换 1.5；跨区域灾备（DRS/备份/跨云导出）与演练脚本 2.0。

**不在上述包内、但本设计依赖的小改动**（各自归属包，合计约 1.5 人周）：客户端 `release.json` 公钥表（F-2，W1/W23，0.5）；网关订阅快照落盘（S4，0.5）；客户端吊销动作“未确认自动重发”与席位吊销入待同步（内核，0.5）。

---

## 9. 风险与待拍板

### 9.1 风险

| # | 风险 | 影响 | 可能性 | 处置 |
|---|---|---|---|---|
| R-1 | **安装包无控制面公钥表**（F-2） | 安装包形态全部控制面文档拒收 → 退出模式，试点不可用 | 已确定存在 | M1 前修；冒烟加断言 |
| R-2 | 从备份恢复导致版本回退 / 吊销丢失 | 客户端拒收新目录、网关冻结、被吊销设备复活 | 中（任何一次恢复） | §6.3 五步；journal 尾部残余如实告知 |
| R-3 | 路径 A 的软件签名被密评判不符 | 密评不过、G2 前返工算法敏捷（客户端与网关同改） | 中（取决于 P-2） | M1 前取得书面意见；PoC-1 先把席位密钥迁入 KMS |
| R-4 | 多副本/主备时钟差导致“回放”告警 | 律师看到吓人的告警 | 高（不处理时） | D-P3 + `tenant_clock` |
| R-5 | RLS 配置错误导致跨租户读写 | 等保与 DPA 级事件 | 低（有测试） | FORCE RLS、未设变量 0 行、`rls.test.ts` 每张表；代码评审只允许经 `withTenantTx` 访问 |
| R-6 | `cp.meta` 单行锁成为写入瓶颈 | 写延迟上升 | 低（试点期） | 监控锁等待；G2 若成为瓶颈，把 journal 序号与订阅版本拆成两行或改为按租户分片的订阅 |
| R-7 | 存储层改造打破“同号同文” | 客户端 `version_conflict` 大面积拒收 | 中 | D-P1；`digest-stability.test.ts`；迁移对拍 |
| R-8 | 华为云若干能力未核实（DRS 灾备时延、KMS 副本规格、OBS WORM + 跨区域复制、DCS 持久化、VPC 终端节点） | RPO/RTO 或隔离方案需调整 | 中 | PoC-2/4/5；不满足时退到跨区域备份（RPO 以实测为准） |
| R-9 | 云选型 M0（11-20）晚于本设计实现起点 | IaC 与 PoC 推迟、M1 压缩 | 中 | 存储层先在本机 PG/Redis 开发；与云相关的部分集中在 S1-6、平台工程 |
| R-10 | 已攻陷 `cp-api` 仍可请求签署格式合法的许可、吊销通知 | 已终止律所继续使用、拒绝服务 | 低 | I-4 + 签名速率告警 + 签名账与 journal 每日对账；G2 签名服务只读核对 |
| R-11 | 成员 ID / 设备编号含姓名 | 控制面持有可识别个人信息、journal 与 WORM 保留 400 天不能删 | 中 | P-10；DPA 写明审计元数据保留期 |
| R-12 | WORM 保留期内无法履行删除请求 | 与个保法删除权口径冲突 | 低（只元数据） | DPA 写明“审计元数据依法保留 ≥6 个月、到期自动删除”；journal 不含案卷内容 |
| R-13 | 网关订阅全量快照跨全部租户（`server.ts:491-505`） | 规模化后带宽与签名体积（目录、订阅信封都可能 >1 MiB） | G2 | 增量订阅 + 按租户分片（Y2-U12）；本设计已建 `feed_changes` |
| R-14 | 律所策略 30 天到期后须重新签名发布（`policy.ts:38`） | 律所忘记续签即回退最严模板 | 中（运营） | 不在本设计范围；建议控制台到期前 7 天提醒管理员（S12） |

### 9.2 待拍板项

| # | 事项 | 选项 | 建议 | 截止 |
|---|---|---|---|---|
| P-1 | M1 签名密钥形态 | ①两把都路径 A；②席位密钥直接上 KMS 内 Ed25519 | **①**，PoC-1 通过后在首次计划轮换时把席位密钥迁入 KMS | 11-04 |
| P-2 | 密评是否适用、Ed25519 是否可接受 | 合规负责人 + 测评机构书面意见 | 默认“适用”准备；若不接受 Ed25519，G2 算法敏捷（SM2 kid）提前进入 W10 | M1 |
| P-3 | RDS 主备同步复制 | 同步 / 异步（缺省） | **同步**（控制面写量低、吊销不能丢） | 11-04 |
| P-4 | 跨区域机制 | DRS 实时灾备 / 跨区域只读 / 只用跨区域备份 | DRS（PoC-2 时延达标时），否则跨区域只读 | PoC-2 后 |
| P-5 | 恢复余量取值 | 目录 +64、策略 +3、席位 +100 | 同意（均低于客户端告警阈值） | 11-04 |
| P-6 | Redis 故障降级到 PostgreSQL 表 | 降级 / 直接按路由失败开放或关闭 | **降级**（全路由保持重放保护） | 11-04 |
| P-7 | 字段加密算法 | SM4-GCM / AES-256-GCM（CMK 均 SM4） | SM4-GCM（PoC-3 通过时），否则 AES-256-GCM 并记录算法 | PoC-3 后 |
| P-8 | 审计保留期 | 6 个月 / 1 年 / 400 天 | **400 天**（WORM 不可缩短，宁短勿长；受托处理记录另 3 年） | 11-04 |
| P-9 | kid 轮换周期与预发布策略 | 每年 / 每两年；始终预发布下一把 | **每年 + 始终预发布下一把** | 11-04 |
| P-10 | 成员 ID 不含姓名 | 强制 / 建议 | **强制**（证书签发工具校验；与 D-42 设备编号按安装生成一并做） | G1 |
| P-11 | 恢复围栏时长与解除权限 | 10 分钟下限 + 两人复核 | 同意 | 11-04 |

---

## 10. 设计评审检查清单（评审人逐条打勾）

**不变量与兼容**
- [ ] 14 条客户端路由（`cp-relay.ts:20-35`）的方法、路径、请求头、大小上限、状态码与错误码无变化；新增错误码只有 `rate_limited`、`control_plane_unavailable`，且客户端按非永久错误处理
- [ ] 信封、席位令牌、设备请求、开通证明、策略/连接器签名字节全部由现有包的现有函数生成（黄金向量测试）
- [ ] 席位令牌 TTL 钳在 [72h, 96h]；许可/目录/策略有效期 ≤30 天且签发与到期取同一时刻
- [ ] 控制面不判断宽严、不能代签；放宽仍须管理员设备门限（“诚实时”检查保留）
- [ ] 表结构中没有任何案卷内容、席位令牌本体、请求体字段

**数据模型**
- [ ] 每张租户表 ENABLE + FORCE RLS；未设 `kwl.tid` 时 0 行；`cp_feed` 读不到证书原文；运营与人工读不到盐密文
- [ ] 签名文档存原文 `text`；目录、连接器目录、吊销数组按 `ordinal` 输出且满足 `Map` 语义
- [ ] 写事务锁序固定（租户 → 草稿/摘要 → `cp.meta`），无需重试；读文档单快照
- [ ] 订阅版本与 journal 序号来自 `cp.meta` 行锁，顺序 = 提交顺序，回滚不留空洞
- [ ] 许可签发时刻按租户单调；主备切换演练无“回放”告警
- [ ] 吊销只增不删（触发器 + 权限）；根公钥不可替换
- [ ] v0 迁移对拍：每租户每类文档摘要与版本一致

**nonce 与限流**
- [ ] 先验签后记 nonce；nonce TTL 10 分钟
- [ ] Redis 故障降级到 PostgreSQL 表；双故障时的逐路由失败开放/关闭与 §3.3 一致（席位令牌、盐、读文档关闭；吊销、撤下、摘要开放）
- [ ] 限流故障开放到进程内；未鉴权入口按网段限流

**签名服务与密钥**
- [ ] `cp-signer` 无公网、独立节点池与子网、只收 `cp-api` mTLS；`cp-api` 的 IAM 委托没有 K1 解密权限
- [ ] 只接受 7 种信封 + 席位令牌的结构化请求，逐种校验；`ops.seal` 不在生产构建
- [ ] 每次签名（含拒签）写独立 WORM 签名账；审计写不进去即拒签
- [ ] kid 分环境；生产 `release.json` 只含 `-prod-` kid；公钥表至少两把（当前 + 下一把）
- [ ] 轮换时间表与应急轮换步骤可执行；网关可单方面撤销席位 kid
- [ ] F-2（`release.json` 公钥表）已排期并在 M1 前完成

**KMS**
- [ ] 每环境独立 CMK；签名包裹、字段、RDS、OBS 分开；跨云备份不依赖原云 KMS
- [ ] 租户盐应用层加密且 AAD 绑定租户；DEK 缓存时长与 KMS 故障行为明确
- [ ] 国密与密评的合规意见已取得或已列为 M1 前门禁

**容灾**
- [ ] RDS 同步复制；跨区域机制与实测 RPO 记录在案（≤15 分钟）
- [ ] 网关订阅快照落盘，控制面停机时网关重启不丢吊销集
- [ ] 恢复围栏、journal 重放、余量抬升、对账、两人解除——五步均有工具与用例；反向对照（去掉余量即失败）已执行
- [ ] 签名服务在上海可在 2 小时内恢复；离线恢复流程演练过

**审计与运维**
- [ ] journal 动作与字段白名单；CI 扫描禁止自由文本
- [ ] WORM 合规模式在建桶时开启；保留期 400 天；跨区域复制
- [ ] 哈希链 + KMS 内 SM2 检查点；律所可导出并验链
- [ ] 签名账与 journal 每日对账
- [ ] 运维只经堡垒机 + 双因素 + 录像、只限境内人员；数据库写操作走工单与临时账号

**计划**
- [ ] S1 18 人周拆分与 M1（12-18）里程碑可达；依赖 M0 云选型的部分已识别
- [ ] PoC-1～5 的负责人与截止日已指定

---

## 附录 A · 外部事实与出处（访问日期均为 2026-10-15）

| # | 事实 | 出处 | 证据等级 |
|---|---|---|---|
| A-1 | 华为云 KMS 自定义密钥支持 AES_256、SM4、HMAC_256/384/512、HMAC_SM3、RSA_2048/3072/4096、EC_P256/P384、SM2、**ED25519**、SECP256K1、ML-DSA（工单开通）；外部密钥支持含 ED25519；**专属密钥库不支持 ED25519**（支持 AES_256、SM4、RSA、EC_P256/P384、SM2）；默认密钥仅 AES_256 | 华为云 DEW 用户指南“密钥算法类型”，https://support.huaweicloud.com/usermanual-dew/dew_01_7775.html （页面标注更新 2026-06-09） | 一手（官方文档，经抓取摘要） |
| A-2 | KMS 签名接口 `Sign`：`signing_algorithm` 取值含 `ECDSA_SHA_256/384/512`、`SM2DSA_SM3`、`ED25519_SHA_512`、`ED25519_PH_SHA_512` 及 RSA 系列；`message` Base64 编码、**长度小于 4096 字节**；`message_type` 为 `DIGEST`（缺省）或 `RAW`；SM2 只能对按 GB/T 32918 计算的摘要签名；页面**未说明** Ed25519 是否须 RAW | 华为云 DEW API 参考“签名数据 Sign”，https://support.huaweicloud.com/api-dew/Sign.html （页面标注更新 2026-09-24） | 一手（经抓取摘要）；Ed25519 互通性**待 PoC** |
| A-3 | KMS 跨区域：`ReplicateKey` 接口把本区域密钥复制到指定区域，支持区域经“查询跨区域密钥所支持的区域”接口获取；最佳实践称主密钥与副本共享密钥材料、可跨区域解密；副本轮换随主密钥 | https://support.huaweicloud.com/api-dew/ReplicateKey.html （更新 2026-09-24）；https://support.huaweicloud.com/bestpractice-dew/dew_06_0030.html （检索摘要） | 一手 + 检索摘要；支持的规格与区域对**待核实** |
| A-4 | CSMS 凭据可创建指定区域的副本凭据（`CreateSecretReplica`） | https://support.huaweicloud.com/intl/en-us/api-dew/CreateSecretReplica.html （检索摘要） | 检索摘要 |
| A-5 | RDS for PostgreSQL 主备数据同步方式支持异步（缺省）与同步；只读实例为异步且不可改 | 《云数据库 RDS for PostgreSQL 常见问题》PDF（2026-10-08），https://support.huaweicloud.com/intl/zh-cn/rds-pg_faq/rds-pg-faq-pdf.pdf （检索摘要） | 检索摘要，**以控制台为准** |
| A-6 | RDS 跨区域备份策略接口 `SetOffSiteBackupPolicy`：PostgreSQL 自动全量与自动增量备份保留天数须一致、增量须在全量开启后开启、卷快照备份方式不支持跨区域备份；跨区域备份后的 PITR 粒度与 RPO **未取得** | https://support.huaweicloud.com/api-rds/rds_09_0014.html （检索摘要） | 检索摘要；RPO **待核实** |
| A-7 | 数据复制服务 DRS 有 PostgreSQL→PostgreSQL 实时同步 | https://support.huaweicloud.com/realtimesyn-drs/drs_04_0508.html （检索摘要） | 检索摘要；用于跨区域灾备的时延**待核实** |
| A-8 | OBS WORM：只支持合规模式，保护期内任何人（含根用户）不能覆盖或删除受保护对象版本；保留期 1–36500 天或 1–100 年；只能延长不能缩短；须开版本控制且之后不能暂停；生命周期规则不能删除受保护对象 | 华为云 OBS 用户指南“配置 WORM 保留策略”，https://support.huaweicloud.com/eu/usermanual-obs/obs_03_0718.html （检索摘要）；“未在建桶时开启则之后不能开启”见 cloud.ru 镜像 https://cloud.ru/docs/en/usermanual/obs/obs_03_0718 | 检索摘要；建桶限制**以中国站原文为准（待核实）**；与跨区域复制的组合**待核实** |
| A-9 | DCS Redis 的主备复制方式、AOF 刷盘策略、切换时延 | 未取得华为云官方文档（检索只得到天翼云与通用 Redis 资料） | **待核实** |
| A-10 | GB/T 39786-2021 第三级在第二级基础上增加真实性、机密性技术要求；网络用户身份真实性相关 4 条为“应” | 安全内参 https://www.secrss.com/articles/36928 （检索摘要，二手）；“重要数据存储机密性”条款强度**未取得原文** | 二手；**需合规确认** |
| A-11 | 华为云 KMS 无 Ed25519（Y2 §2.5 原结论） | 已被 A-1 更正 | — |

## 附录 B · 本文引用的代码常量（以代码为准）

| 常量 | 值 | 位置 |
|---|---|---|
| 席位令牌缺省签发 | 96 小时 | `services/control-plane/src/server.ts:168-169` |
| 席位令牌最短 | 72 小时 | `packages/seat-token/src/index.ts:26` |
| 客户端续期阈值 | 73 小时 | `packages/kernel/src/control-plane/governance.ts:131` |
| 同步间隔上限 | 1 小时 | `packages/kernel/src/control-plane/client.ts:48` |
| 设备请求时钟偏差 | 5 分钟 | `packages/firm-trust/src/request-auth.ts:10` |
| nonce 保留 | 10 分钟 | `services/control-plane/src/server.ts:255` |
| 预先吊销上限 | 1000 / 租户 | `services/control-plane/src/server.ts:165-166` |
| 许可 / 目录 / 策略最长有效期 | 30 天 | `firm-trust/src/docs.ts:19,62`；`policy.ts:38` |
| 策略单次跳跃上限 / 首次上限 | 1000 / 1,000,000 | `firm-trust/src/policy.ts:89,94` |
| 目录与连接器目录跳跃上限 / 首次上限 | 100,000 / 100,000,000 | `governance.ts:133,135` |
| 跳跃告警阈值（策略 / 目录） | 10 / 1000 | `governance.ts:140-141` |
| 不认识的新版本回退标记最大领先 | 10 | `governance.ts:150` |
| 控制面通道请求 / 响应上限 | 256 KiB / 8 MiB | `packages/egress-gate/src/cp-relay.ts:38-40` |
| 管理员签名最多条数 | 16 | `firm-trust/src/admin.ts:48` |
| 管理员门限（团队 / 律所） | 1 / 2 | `firm-trust/src/docs.ts:21-23` |
| v0 nonce 定时写盘 | 30 秒 | `services/control-plane/src/server.ts:237-246` |
| 网关订阅缺省拉取间隔 | 30 秒 | `services/control-plane/src/feed-subscriber.ts:120` |
