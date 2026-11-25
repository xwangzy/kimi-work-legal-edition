# V40 审计 A：云端模型目录、跨设备登录、个人套餐与用量、本机全栈联调（只读）

- 审计对象：worktree `kimi-legal-b66-ux`（分支 `claude/kimi-legal-b66-ux`，基于 main `02e8f84a`），代码在 `platform/`。
- 只读：未改任何代码；行号以本 worktree 当前文件为准。
- 相关偏离：D-186（账号新电脑入组）、D-198（额度提示条）、D-199（套餐与用量页 + own_recent）、D-200（模型：问答 K3/K2.6、任务只读 K3），登记在 `platform/docs/v9-开发计划与进度.md:1758`（D-186）与 `research/2026-11-19-V21-Kimi对标与律师端重构/00-对标与设计决策.md:65-69`（D-197～D-201）。偏离表当前最大号 D-277（第 61 批）；第 65 批记忆里用到 D-290，**下一号以主文为准再核**。

---

## A. 模型：定义位置、链路、改法

### A.1 现在模型在哪里定义（四处，各管一段）

| 层 | 位置 | 内容 |
|---|---|---|
| 控制面路由登记（权威） | `services/control-plane/src/routing.ts:46-55`（`ModelRouteRecord`：alias、label、enabled、is_default、targets[provider,model,priority]、allow_cross_vendor、default_max_tokens） | 运营在控制台增改别名；`BUILTIN_ALIASES = ["legal/k3","legal/k2.6"]`（`:174`），内置别名不可删（`deleteModel` `:707-708`），至多 32 个别名（`:698`）。首次启动 `bootstrapRouting` 两个内置别名都指向 `kimi-k3.1-pro`（`:213-216`）。 |
| 控制面签名下发给网关 | `routingFeedBody` `routing.ts:758-768`；端点 `GET /v1/feed/routing`（`server.ts:4118`，服务密钥鉴权，信封 `kwl-routing-feed`） | 含 providers（含上游密钥**密文** `key_sealed`）、models、prices（basis=model 时按上游型号的生效价）。 |
| 网关路由快照 | `services/legal-gateway/src/routing.ts:254-500`（`RoutingFeedSubscriber`，15 秒拉一次、版本只进不退、整表原子替换） | 兜底：`DEFAULT_ROUTES` `:160-163`（`legal/k3`→`kimi-k3`，`legal/k2.6`→`kimi-k2.6`），`routesFromEnv` 读 `KWL_UPSTREAM_K3 / KWL_UPSTREAM_K26` 改兜底型号 `:171-184`（只在订阅取不到时、开发与试用形态用；试用网关 `apps/desktop/electron/trial-gateway.mjs:38`）。上游密钥在网关用路由私钥解封（`unsealUpstreamKey` `:77-96`），只在上游客户端私有字段里。 |
| 本机（内核）别名表 | `packages/model-broker/src/config.ts:72-100`（`buildRoutes`：只有 `legal/k3`、`legal/k2.6` 两个；`providerModel` 来自 `ZR_MODEL_K3/ZR_MODEL_K26`，**只在 mock 与 BYOK/私有端点时有意义**） | 思考控制按模型族写死：K3 `thinkingControl:"effort"`、K2.6 `"toggle"`（`:79-96`）。`broker.resolveRoute` 不认识的别名直接抛 422（`packages/model-broker/src/broker.ts:79-81`）。 |
| 问答可选目录（写死） | `packages/kernel/src/services/qa-chat.ts:52-55` `QA_MODEL_CATALOG`（K3「适合复杂问题」、K2.6「更快、更省额度」） | `qaModelChoices` = 目录 ∩ `broker.routeAliases()`（`:66-74`）；缺省 `ZR_QA_ROUTE ?? "legal/k3"`（`packages/kernel/src/index.ts:618`）。 |
| 任务引擎（写死 K3） | `packages/kap-host/src/engine-config.ts:13-14`（`MAIN_MODEL="legal/k3"`、`SECONDARY_MODEL="legal/k2.6"`）、`:81` default_model、`:96-109` models 两项、`:110` 子 Agent 强制 K2.6 | 发起时显式带模型：`packages/kap-host/src/runtime.ts:520`（run.started 记 `model: MAIN_MODEL`）与 `:526`（`engine.kap.prompt(..., model: MAIN_MODEL)`）。宿主策略拒绝子任务另指定模型：`packages/kap-host/src/policy.ts:343-347`。 |
| 内核自发的模型调用（写死 K3） | `packages/kernel/src/executor/executor.ts:510/528/539`（成果相关步骤）、`:2134`（独立复核）、`:2409`（复核追问） | 都是 `route: "legal/k3"`。 |
| 桌面端显示 | 首页输入框 `apps/desktop/src/components/Composer.tsx:147-148`：`<span className="model-label">K3</span>`（注释“只显示、不做假的下拉”）；问答页 `apps/desktop/src/pages/Chat.tsx:91`（`api.chatModels()`）、`:327`（>1 个才显示 `ModelPicker`，`:379` 起）；`apps/desktop/src/lib/firm-usage.ts:175-176` 别名→中文名写死 | |
| 迁移 0069 | `packages/kernel/src/migrations/0069_v21_qa_message_route.sql`：`qa_messages.route`（每条回答记实际别名，界面显示“由 K2.6 回答”） | 任务侧没有对应字段（runs 只在 run.started 事件里记 `model`）。 |
| 套餐可用模型 | `services/control-plane/src/billing.ts:29-30` `PlanSpec.models: string[] | null`（null=全部启用的）；校验 `:162-163`；控制台套餐页 `apps/console/pages/plans.js:146/173/187`（“可用模型别名，逗号分隔”） | 网关**只在领租约时**按套餐挡：控制面 `POST /v1/quota/lease` `server.ts:4146-4147`（`model_not_allowed`），返回 `allowed_aliases`（`:4159`）；网关租约缓存里再挡一次 `services/legal-gateway/src/quota.ts:360`。 |

### A.2 从“桌面端选模型”到“网关调用上游”的完整链路

**问答（已经能选，K3/K2.6）**

1. 界面 `Chat.tsx:91` → `api.chatModels()`（`apps/desktop/src/api.ts:1315`，invoke `chat.models`）。
2. 内核 `packages/kernel/src/api/w1.ts:175-179` → `QaChatService.modelChoices()`（`qa-chat.ts:474-476`）= 写死目录 ∩ 本机 broker 别名。**不问云端**。
3. 发送：`chat.send` 带 `route`（`w1.ts:207-222`）→ `QaChatService.send` 校验 route 在可选列表里（不认识即 validation 拒绝，D-200）。
4. `index.ts:620-628`：`broker.resolveRoute(alias)` → 请求体 `model: route.alias`（即 `"legal/k3"`，**发的是别名，不是上游型号**）+ `thinkingParams(route, deep)`。
5. 经 `qaGate`（`index.ts:608-612`）→ 出站闸门（egress-gate 子进程，Unix socket）`packages/egress-gate/src/server.ts:646-656`：标准端点问答 → `${gateway}/qa/chat/completions`，头 `authorization: Bearer <席位令牌>`、`x-kwl-data-level`、`x-kwl-request-id`；`prepare: (b) => b`（**别名原样透传**）。BYOK/私有端点才在闸门把别名换成上游型号（`:669-678`，`d.models`）。
6. 网关 `services/legal-gateway/src/gateway.ts:349-356`：`alias = body.model` → `snap.models.get(alias)`；未登记 `model_not_routed`(400)、停用 `model_disabled`(400)、路由未就绪 `routing_unavailable`(503)。
7. 预占：`gateway.ts:365-383`，按候选上游型号里最贵的一档预占（`reserveRatesFor` `usage.ts:117`）→ `quota.reserve`（租约，套餐不含别名 → `model_not_allowed` 403，`quota.ts:360`）。
8. 选目标：`candidatesOf(route, snap)` 按 priority 与上游健康 → `OpenAICompatProvider`（`providers.ts`）带解封后的上游密钥请求上游；**请求体里的 model 在这里换成 target.model**。
9. 计量：`gateway.ts:742` 记 `upstream_model: served.model`，按实际服务的上游型号计价（price basis=model，第 62 批）；回报控制面账本 `services/control-plane/src/usage-ledger.ts:50-52/80-83`（alias、upstream_model、price_basis、price_key），聚合 `byModelDay`(按别名)、`byUpstreamDay`(按上游型号) `:272-274`。

**任务（只用 K3）**

1. 首页 `Composer.tsx:148` 固定显示“K3”，发起任务请求里**没有模型字段**。
2. kap-host `runtime.ts:526` `prompt(..., model: MAIN_MODEL)`；引擎配置 `engine-config.ts:87-109` 的 provider `kwl-gate` base_url = `http://gate.kwl/m/<matter>/v1`。
3. 宿主出口 `packages/kap-host/src/host-egress.ts:233` 记 route=model → 内核出站闸门（任务令牌）→ `${gateway}/chat/completions`，头多带 `x-kwl-anon-matter`（`egress-gate/src/server.ts:659-663`）。
4. 网关同问答第 6～9 步（另做事项匿名摘要二次检查 `gateway.ts:309-334`）。
5. 子 Agent：引擎 `secondary_model.force` + 宿主 `policy.ts:343-347` 双重强制 K2.6；内核自发复核 `executor.ts:2134` 固定 K3。

**计量按什么型号计价**：第 62 批起按**实际服务的上游型号**（`kimi-k3.1-pro` 等，`routing.ts(cp):92-107` PriceTable.basis="model"、`OFFICIAL_PRICES` `:131-138`），预占按候选最贵型号；旧版本按别名 `items`（派生，给旧网关读）。账本同时保留 alias（律师选的“名字”）与 upstream_model（实际花钱的型号）。

### A.3 关键现状判断

1. **网关已经是“别名 → 上游型号”的动态路由**，运营已能在控制台增改别名、改目标、启停、设缺省（`upsertModel` `routing.ts(cp):669-705`），15 秒内到网关。要做的不是新路由系统，而是：**让客户端看得到并能选这些别名**，以及**任务也传所选别名**。
2. 但客户端有三道“写死”：内核 broker 只有两个别名（`config.ts:72-100`），问答目录写死两项（`qa-chat.ts:52-55`），任务写死 `MAIN_MODEL`（`engine-config.ts:13`、`runtime.ts:526`）。运营新增别名（如 `legal/k3-fast`）客户端看不到也发不出——`broker.resolveRoute` 直接 422。
3. **套餐“可用模型”只在网关领租约时生效**，客户端拿不到“我能用哪些模型”；网关 `GET /v1/models`（`gateway.ts:840-843`）返回全部启用别名，**不按套餐过滤**，且该路径不在出站闸门登记里（`docs/privacy/egress-paths.json` 的 egress-gate/server.ts 通道只有 `/chat/completions`、`/qa/chat/completions` 两条），客户端拿不到。
4. 能力差异写死在客户端：K3 用 `reasoning_effort`、K2.6 用 `thinking.type`（`model-broker/src/config.ts:79-96`）；`thinkingParams` 按 `thinkingControl` 生成上游参数。新别名必须带“思考控制方式”给客户端，否则只能当“none”。
5. 网关拒绝时客户端已有说人话的分支：`qaFailureText` `qa-chat.ts:175-180`（`price_unconfigured / model_not_routed / model_disabled / model_not_allowed / upstream_unavailable`），但文案写死“请换 K3”；任务侧对应的失败文案在 kap-host/内核另处（需同步改为“请换缺省模型”）。

### A.4 改法（最小、正确）

**(1) 云端模型目录——不另起新表，扩 `ModelRouteRecord`**（`services/control-plane/src/routing.ts:46-55`）。别名就是模型 id（客户端只认别名，上游型号与密钥永不下发）。建议新增字段：

```ts
interface ModelRouteRecord {
  alias: string;            // 模型 id，如 "legal/k3"、"legal/k3-fast"（已有）
  label: string;            // 显示名“K3”（已有）
  enabled: boolean;         // 状态（已有）；另加 visibility 见下
  is_default: boolean;      // 缺省（已有；全表唯一）
  targets: RouteTarget[];   // 上游路由（已有；只给网关，不给客户端）
  allow_cross_vendor: boolean; default_max_tokens: number; updated_at: string; // 已有
  // —— 新增 ——
  description?: string | null;          // 说明“适合复杂问题”（≤60 字）
  sort?: number;                        // 排序（小者在前，缺省 100）
  thinking?: "effort" | "toggle" | "none"; // 能力：深度思考的控制方式（替代 model-broker 里按别名写死）
  efforts?: ("low"|"high"|"max")[];     // effort 型允许的档位
  capabilities?: ("tool_use"|"thinking"|"long_context")[]; // 能力标签（任务需要 tool_use 才能被选作任务模型）
  scopes?: ("qa"|"task")[];             // 在哪些入口可选（子任务别名 legal/k2.6 只给 qa 或不给）
  client_visible?: boolean;             // false = 只作内部别名（如子任务、复核），不出现在选择器
  max_context?: number | null;          // 给引擎的 max_context_size（缺省 262144）
}
```

“可用套餐”不放在模型上，沿用现有 `PlanSpec.models`（`billing.ts:30`，别名白名单、null=全部），避免两处真相；若产品更想按模型配，可在控制台模型页反查展示“哪些套餐可用”。

**(2) 控制面运营接口与控制台**：已有 `GET /v1/ops/routing`、`PUT/DELETE /v1/ops/routing/models/:alias`（`server.ts:2813-2843`，权限 `route.read/route.manage`），控制台页 `apps/console/pages/routing.js`（模型与路由，有 models tab）、`plans.js`（可用模型别名）、`pricing.js`（按型号价）。改动：`upsertModel` 接受并校验上面新增字段（`routing.ts(cp):669-694`），`routingView` 带出；`routing.js` 模型编辑表单加说明/排序/思考方式/入口/客户端可见；`BUILTIN_ALIASES` 的“不可删”保留（旧客户端写死了它们）。

**(3) 客户端拉取接口（建议）**：控制面新增 **`GET /v1/models`**（账号会话 `x-kwl-session` 或设备签名，与 `/v1/quota` 同一鉴权），返回**签名信封** `kwl-model-catalog`：

```json
{ "version": 37, "issued_at": "...", "tid": "...", "uid": "...",
  "default": "legal/k3",
  "models": [ { "id":"legal/k3", "label":"K3", "description":"适合复杂问题", "sort":10,
               "thinking":"effort", "efforts":["low","high","max"], "capabilities":["tool_use","thinking"],
               "scopes":["qa","task"], "available": true, "reason": null } ] }
```

过滤规则（服务端算）：`enabled && client_visible !== false`；`available = 套餐允许(plan.models) && 有可用目标 && (金额套餐时已定价)`；不可用的也可下发但标 `reason`（`not_in_plan` / `unpriced` / `no_route`），界面置灰并说明。**绝不含 targets、provider、base_url、key_hint、上游型号**。

不建议客户端直接调网关 `GET /v1/models`：要新增闸门出站路径、且网关不知道套餐（套餐在控制面）。走控制面也省一条外发通道。

**(4) 内核缓存与校验**：
- 新增内核服务（建议 `packages/kernel/src/services/model-catalog.ts`）：经出站闸门 cp-relay 拉 `/v1/models`，用控制面信封公钥验签（与 `/v1/quota` 的 `kwl-quota-view` 同法），按 `version` 只进不退，缓存在内核 DB（或内存 + 磁盘 JSON，记 `fetched_at`），登录成功、每 10 分钟、以及收到网关 `model_*` 拒绝时刷新；离线用最后一版，从未取到用内置两项（`legal/k3`、`legal/k2.6`）兜底。
- `model-broker` 从“两项写死”改为“内置两项 + 目录动态项”：`buildRoutes` 生成内置；新增 `broker.setCatalog(list)` 把目录里的别名补成 `RouteDef`（`provider: upstream`、`providerModel=alias`、`thinkingControl` 取目录的 `thinking`、`allowedEfforts` 取 `efforts`）。`resolveRoute` 只认“目录里 available 的 + 内置”。
- `QA_MODEL_CATALOG`（`qa-chat.ts:52-55`）删掉，`qaModelChoices` 改为读目录 `scopes` 含 `qa` 的项；缺省用目录 `default`，ZR_QA_ROUTE 只作开发覆盖。
- 新增 `models.list`（或扩 `chat.models` 加 `scope` 参数）给首页与问答共用；`kernel.status.model_choices` 同源。
- **任务也要带模型**：`runs.start`（`packages/kernel/src/api/index.ts:1730`）新增 `model` 参数 → 内核校验在目录中、`scopes` 含 `task`、`capabilities` 含 `tool_use` → 写进 run 记录（建议迁移 **0073**（当前最后一个是 `0072_v51_authorization_evidence.sql`）加 `runs.model text`）→ kap-host `StartRunRequest` 加 `model`（`runtime.ts:144`）→ `runtime.ts:520/526` 用 `req.model ?? MAIN_MODEL`；`buildEngineConfig` 的 `models` 段需包含该别名（`engine-config.ts:96-109` 按所选别名动态生成一项，`capabilities` 按目录），`default_model` 设为所选别名。子 Agent 仍强制 `SECONDARY_MODEL`（policy.ts 不动）。内核自发复核 `executor.ts:2134/2409` 是否跟随所选模型需产品拍板（建议跟随任务模型，或固定“缺省模型”而非字面 `legal/k3`）。
- 同一会话“继续任务/修改轮”沿用 run 记录的 model（`continue_session_id` 路径），避免中途换模型。
- 首页 `Composer.tsx:147-148` 换成真正的选择器（复用 `Chat.tsx:379` 的 `ModelPicker`），只列 `scopes` 含 task 的；文案“具体型号由云端路由决定”保留。

**(5) 网关按所选模型路由并拒绝未授权模型**：路由已是按别名（`gateway.ts:351-356`），无需改。要补的是**拒绝未授权**不只靠租约缓存：
- 目前 `model_not_allowed` 只在租约（控制面 `server.ts:4146`、网关 `quota.ts:360`）判；`take()` 循环里先判 `units===null` 再判 allowedAliases（`quota.ts:358-360`），金额套餐下未定价的别名会先报 `price_unconfigured` 而不是 `model_not_allowed`——顺序宜对调（先权限后价格），让客户端提示准确。
- 网关已有座位令牌 → 租户；套餐变化经租约 TTL 生效（租约过期才重新领）。如要求“运营停用即刻生效”，`model_disabled` 由路由订阅 15 秒内生效已满足；“套餐撤掉某模型”最长要等现有租约到期（`allowedAliases` 存在租约上），可接受或在 `/v1/feed/gateway` 里加“租户套餐版本”让网关作废租约。
- 网关 `/v1/models`（`gateway.ts:840-843`）可保留给运维，不作客户端入口。

**(6) 必须同时改的门禁 / 出站登记**
- `packages/egress-gate/src/cp-relay.ts:20-60` PATHS 加 `/^\/v1\/models$/`；`docs/privacy/egress-paths.json` 的 cp-relay 通道 `paths` 同步加（`packages/egress-gate/test/egress-paths.test.ts:28-38` 会逐条比对，不登记即失败），`what` 文案补“可用模型目录”。数据类编号沿用 /v1/quota 那类（只出身份与设备签名，不出案卷内容）。
- 若选择“任务也走所选模型”：出站闸门 `modelTarget` 标准端点 `prepare: (b) => b` 不改（别名透传）；BYOK/私有端点的 `d.models`（`egress-gate/src/server.ts:674-675`、`kernel-gate.ts:69`）只映射两项内置别名——新别名在 BYOK/私有端点会原样发给上游而失败，需在 `gateBody`/内核层对非标准端点拒绝“非内置别名”或要求映射。
- 控制面 `routingFeedBody`（`routing.ts(cp):764`）只给网关需要的字段，新增的展示字段不必进网关订阅；客户端目录接口单独组装，**单元用例断言目录里不含 targets/base_url/key_* 字段**（防密钥或上游信息下发）。
- 内核 `qaFailureText`（`qa-chat.ts:175-180`）“请换 K3”改为“请换 {缺省模型显示名}”；`apps/desktop/src/lib/firm-usage.ts:175-176` 别名→名称改为读目录 label。
- 偏离登记：D-200 的“任务只读显示 K3”“问答只此两个”要登记新偏离（取消 D-200 的这两句）。

---

## B. 设备：登记、上限、入组批准、改法

### B.1 现状（控制面）

| 环节 | 位置 | 说明 |
|---|---|---|
| 设备上限 | `services/control-plane/src/accounts.ts:104` `MAX_DEVICES_PER_ACCOUNT = 9`；`server.ts:1585` `deviceLimitOf(a) = min(9, a.device_limit ?? 套餐.device_limit ?? settings.default_device_limit)`；套餐缺省 `device_limit: 2`、试用 `1`（`billing.ts:116/127/134`）；注册设置 `default_device_limit`（`billing.ts:41`） | 登录时 `onboardingOf` 判满即 `device_limit`（`server.ts:1721`、编号用尽 `:1727`）；入组申请再挡一次（`server.ts:4046`）。 |
| 登录后状态机 | `server.ts:1707-1731` `onboardingOf`：`ready`（带有效设备签名且属本人）/ `device_mismatch` / `waiting_founder` / `needs_founder_setup`（律所还没根公钥，管理员本人生成 founder 认领）/ `device_limit` / `needs_device_join`（分配 `dev_<所>_<成员>_D<n>` 编号并生成 member 认领 `accountClaim(...,"member",deviceId)`） | |
| 新电脑入组申请 | `POST /v1/join-requests` `server.ts:4029-4075`：认领凭据 + 设备签名公钥/加密公钥 + 持有证明；账号来源（D-186）不带 HMAC | 状态 `pending`，7 天有效。 |
| 批准（另一台电脑） | 控制面 `POST /v1/join-requests/:id/approve` `server.ts:4460-4502`：**证书必须由律所根签发**（`verifyDeviceCertificate(cert, t.root_public_key_pem)` `:4473`），并带 `firm_bundle`（恢复公钥 + 根签名，`:4483-4490`）；内核批准方 `packages/kernel/src/services/onboarding.ts:836-875`：只有持**律所根私钥**的电脑能批准（`getFirmRootPrivateKey` `:845-847`，否则“需要在律所开通时的那台电脑上操作”），本机签发 365 天设备证书 `:851-860`。界面：`apps/desktop/src/components/MembersAdmin.tsx:90-126`（“入组核对码，请对方念出”）。 | 新电脑取回：`/v1/join-requests/:id/fetch` → 内核 `onboarding.ts:571-591` 验证书、验 firm_bundle、写 `join-approved.json`，重启后 `packages/kernel/src/devices.ts:244-270` 落 `firm_identity`（根公钥 + 恢复公钥）与设备证书。 |
| 设备登记 | `POST /v1/devices/register` `server.ts:3926-3960`：证书须由租户根签发（`:3933`）、设备签名有效；已吊销回签名吊销通知（`:3940-3944`） | |
| 设备鉴权 | `authDevice` `server.ts:1324-1336`；未知或已吊销 → `device_unknown_or_revoked`（`packages/firm-trust/src/request-auth.ts:77`）→ 有效签名的已吊销设备得到 `kwl-device-revoked` 通知（`server.ts:1311-1322`）；内核 `packages/kernel/src/control-plane/client.ts:202` 应用通知进入退出模式（`index.ts:899/1107`）。 | |
| 账号闸（会话 ↔ 设备） | `accountGate` `server.ts:1342-1356`：会话所属成员须是证书成员；会话首次用即绑定 `device_id`，此后换设备 `session_invalid` | 席位令牌、各服务凭据都经此闸。 |
| 席位令牌绑定设备 | `packages/seat-token/src/index.ts:17`（claims `dev`）、`:75`（`revokedDevices` 命中即 `device_revoked`）；网关订阅 `revoked_devices` / `suspended_devices`（控制面 `server.ts:1401-1422`） | |
| 解绑 / 下线 | 解绑：`POST /v1/auth/devices/:id/unbind`（须密码，`server.ts:3862-3875`）= 吊销设备 + 撤该设备会话；下线：`/v1/auth/sessions/ses_*/revoke`；`/v1/auth/me` 列设备与会话（`server.ts:3788-3796`）；界面 `apps/desktop/src/components/AccountPanel.tsx:405-548`（“我的电脑”“已登记 N 台，最多 M 台”、会话“下线”）；文案 `packages/kernel/src/account-session.ts:224-225/298-316` | |
| 现有风控 | 失败 10 次锁 15 分钟（`accounts.ts:101-103/201-213`）；网关按账号停用/会话失效确定性拒绝（D-201）；1 小时异常消耗告警（`server.ts:1873-1878`）；平台人员登录来源留痕（`server.ts:336`） | **没有**“新设备登录提醒”“异地登录提醒”“设备首次出现需二次验证”。 |

### B.2 为什么“另一台批准”存在——关键约束

设备证书只能由**律所根私钥**签发，而根私钥只在开通时那台电脑上（`devices.ts` 文件头 + `index.ts:428-436` “创始工作区持律所根私钥”）。控制面设计成“不能替管理员签发或改任何一项”（`server.ts:4474` 注释）。所以新电脑入组的本质是**把新设备公钥拿给持根私钥的电脑签名**，顺带把 `firm_bundle`（恢复公钥 + 根签名）传过去；**根私钥与恢复私钥都不传**（恢复私钥只在律师的恢复包里）。新电脑拿到的只有：自己的证书、根公钥、恢复公钥。案卷与本机数据本来就不同步，**个人工作区本来就各机独立**；新电脑用恢复公钥给本机事项密钥做托管包（`member-log.ts:889`），以后用同一份恢复包可恢复。

因此“取消另一台批准”只要解决**谁给新电脑签证书**，不需要搬任何私钥。

### B.3 改法（推荐：账号设备由控制面签发，仅限个人账号）

前提：先定义“普通个人账号”=租户只有 1 名成员且该成员是管理员（自助注册的试用/个人律所），建议在租户上加显式标记 `personal: true`（注册时置；成员数变 >1 或开通团队共享时自动转为 false 并恢复批准流程）。多人律所的成员仍走现有入组批准——团队事项密钥按设备公钥包发（`member-log.ts`），让云端能签多人律所的设备证书等于让云端能冒充成员收团队案卷密钥，不能放开。

1. **控制面新增“账号设备签发钥”**（cp-signer 里新的一把 Ed25519，与信封钥分开，kid 进 `/v1/meta`），租户记录加 `account_device_ca: { kid, public_key_pem } | null`（个人租户开通时写入）。
2. **登录即签发**：`onboardingOf`（`server.ts:1707-1731`）对个人租户、`live < 9`（只保留防滥用硬上限，见下）时返回新状态 `needs_device_auto`，带 `device_id`（沿用 `_D<n>` 编号规则 `:1722-1728`）；新增 `POST /v1/auth/devices/enroll`（会话鉴权，`x-kwl-session` + 新设备公钥 + `joinProofBytes` 持有证明），控制面核：会话新鲜（登录 10 分钟内）、账号 active、租户 personal → 用账号设备签发钥签 365 天证书 → 直接 `t.devices.set(...)` 并返回 `{ cert, root_public_key_pem, firm_bundle, ca_kid }`。`firm_bundle` 是公开数据（根签名），**控制面需在开通时存一份**：`/v1/enroll`（`server.ts:3898-3922`）让创始设备同时上传 firm_bundle；存量租户由创始设备下次同步补传（或首次批准时 `server.ts:4494` 已在 jr 里留了一份，可回填）。
3. **证书验证点接受第二信任锚**（只对该租户）：控制面 `server.ts:1043`、`:3933`；内核 `devices.ts:258/355`、`index.ts:1005`、`api/index.ts:4928`、`services/onboarding.ts:571`、`control-plane/governance.ts:417/723/1040`。建议在 `@zr-legal/firm-trust` 加 `verifyDeviceCertificateAny(cert, [root, accountCa])`，证书里写 `issuer: "firm_root" | "account_ca"`；**团队共享、成员日志、管理员动作只认 firm_root 签发的证书**（`requireAdmin`/`requireRevoker` 对 account_ca 设备照常可用于本人账号自助动作，但批准成员、发布策略仍要根私钥那台）。
4. **取消数量上限**：个人租户 `deviceLimitOf` 返回硬上限（保留 `MAX_DEVICES_PER_ACCOUNT` 防刷，建议提到 20，且**超过时自动吊销最久未用的一台**而不是拒绝登录——对律师无感；或干脆不限、只告警）。套餐 `device_limit`（`billing.ts:25/134`）对个人租户不再生效；控制台套餐页“电脑数”标“仅多人律所”。`server.ts:4046` 的入组上限检查同步放开。
5. **会话不再“粘死”设备**：`accountGate`（`server.ts:1350-1355`）保留“会话绑定首台设备”的语义即可（会话是每台电脑各自登录产生的，不跨设备共享），无需改。
6. **新电脑拿什么**：证书（控制面签）、根公钥、firm_bundle（含恢复公钥）。不拿根私钥、不拿恢复私钥、不拿任何案卷。内核侧把 `needs_device_join` 的等待页换成 `needs_device_auto` 的自动流程：复用 `onboarding.ts:571-591` 的“取回已批准结果 → 写 join-approved.json → 重启”路径，只是来源从 `/fetch` 换成 `/v1/auth/devices/enroll` 的应答。cp-relay 白名单加 `/^\/v1\/auth\/devices\/enroll$/`（`packages/egress-gate/src/cp-relay.ts:46-47` 那组），`docs/privacy/egress-paths.json` 同步。
7. **保留的风控**：
   - 会话列表与“让这处下线”（已有，`AccountPanel.tsx:519`、`/v1/auth/sessions/*/revoke`）；“我的电脑”改名“登录过的电脑”，“解绑”改为“移除这台电脑”（= 吊销证书 + 撤会话，已有 `server.ts:3862-3875`），去掉“最多 M 台”。
   - **新增新设备登录提醒**：自动签发时写审计 `device.auto_enroll`（含客户端版本、来源 IP 段），给账号的其他会话推一条“新电脑登录”提示（控制面已有告警表 `server.ts:177`，加 kind `new_device`），并在 `/v1/auth/me` 返回最近 5 次登录（时间、设备、IP 归属城市粗粒度）。
   - **异常登录**：沿用失败锁定；新增“新设备 + 短时间内多地 IP”或“24 小时内自动签发 >3 台”触发：暂停自动签发、要求短信验证码二次确认（短信通道已有，`services/control-plane/src/sms.ts`）。
   - 吊销照旧：吊销设备 → 网关 `revoked_devices` 订阅 → 席位令牌失效（`seat-token/src/index.ts:75`）→ 内核退出模式。
8. **内核 device_unknown_or_revoked**：保持（未登记设备 401、已吊销设备 403 + 签名通知）。注意自动签发后若用户在旧电脑“移除这台电脑”，旧电脑上本机数据不动、只是进入退出模式——与现在一致。

**替代方案（不推荐）**：每台电脑各自当“创始设备”生成独立律所根（控制面允许个人租户多根）。好处是控制面仍不签证书；坏处是每台电脑一份恢复包、律师要保管多份恢复码，且所有验证点要改成“多根任一”，改动面与推荐方案相当、体验更差。

**要登记的偏离**：推翻 D-186 的“批准方核对 12 位核对码”（仅对个人租户）与“控制面不签发设备证书”的原则（限个人租户），写明风险与补偿控制（新设备提醒、短信二次验证、团队功能只认律所根证书）。

---

## C. 额度：控制面模型、接口字段、桌面端位置、个人视图缺口

### C.1 控制面额度模型（`services/control-plane/src/quota.ts`）

- 套餐（`billing.ts:13-33`）：`quota_unit`（tokens | cny）、`seat_quota`（每席位每期）、`period`（month | week）、`burst`（任意 hours 小时内至多用本期总额度 pct%，试用 5 小时 50%，`billing.ts:116/127`）、`enforce_seat_quota`（个人额度是否硬性生效，缺省 false：个人只显示比例，额度全所共用）、`models`、`device_limit`、`alert_thresholds`。
- 全所总额：`totalsOf` `quota.ts:156`（allowance = seat_quota × 席位或 `allowance_override`；`boost` 加量；`cap` 律所上限%）。
- 个人：`memberLimitOf` `quota.ts:227-231`（账号个人上限 `account_limit` 优先，否则 `seat_quota`）；可用量 `availability(q, ctx, sid, uid)` `quota.ts:236-250` 取 allowance / cap / burst / seat 四者最小，`limited_by` 说明被谁卡住——**这正是“我还能用多少”的真实值**。
- 5 小时窗口：`windowUsed(ctx, uid)` `quota.ts:202-207`，视图里只算全所（`uid=null`，`:377`）；`windowResetAt` 给恢复时刻。
- 租约：`POST /v1/quota/lease`（服务凭据，网关用）`server.ts:4134-4160`；结算 `/v1/quota/settle` `:4161`。
- 用量来源：逐请求账本 `usage-ledger.ts`（按租户/成员/别名/上游型号/日聚合 `:272-274`，`member()` `:298`、`memberModels()` `:342`、`window()` `:303`、`query()` `:357` 支持 uid/alias/outcome 过滤）——**全部是网关回报的真实调用记录**，估算行（`usage_source=estimated`、`reconcile=pending`）不计入额度。

### C.2 `GET /v1/quota` 返回字段（设备签名，`kwl-quota-view` 签名信封，`server.ts:4250-4279`；视图 `quotaView` `quota.ts:369-422`）

`{ tid, issued_at, plan:{id,label}, account:{aid,email,name}, accounts_required, unit, unit_label, period:{kind,key,start,resets_at}, firm:{used_ratio, remaining_ratio, in_flight_ratio, paused, cap_pct, cap_set_at, boost_pct, legacy_used_ratio, used*, total*, seats, denominator}, burst:{hours,pct,used_ratio,resets_at}（全所口径）, own:{used_ratio, denominator, enforced, used, total, requests, tokens, value_cny, estimated_rows}, history:[{period, used_ratio, legacy}]（全所）, models:[{alias,label,used,share,requests}]（全所按别名）, own_recent:[20 条：at, kind(qa/task), alias, label, tokens_in/cached/out, charge, charge_ratio, unit, value_cny, outcome, partial, estimated, pending], by_member*/boosts*/unreconciled_leases*（*仅管理员/合伙人） }`

另有 **`GET /v1/me/usage`**（账号会话鉴权，网页控制台用，`server.ts:4544-4562`）：`own`（同上 + `estimated_share`）、`firm`（摘要）、`burst`、`daily`（最近 N 天本人逐日）、`by_model`（**本人按模型**，`book.memberModels`）。它**没签名**、**不在 cp-relay 白名单**（`cp-relay.ts` 只有 `/v1/quota$`），桌面端目前不用。

内核：`quota.status` `packages/kernel/src/api/index.ts:3771-3781`（经 `control-plane/client.ts:540` 调 `/v1/quota`，验签后原样给界面 + 本机姓名）。

### C.3 桌面端要改的位置

| 要去掉 / 改的 | 位置 | 现状 |
|---|---|---|
| 用户菜单“本所本月已用 X% · 12-01 重置” | `apps/desktop/src/lib/quota-notice.ts:64-69` `quotaMenuLine`（用 `q.firm.used_ratio`）；调用 `apps/desktop/src/components/Sidebar.tsx:458`、菜单项 `:484-492`（“套餐与用量”→ `/connections/usage`） | 改为个人口径：“本月已用 X% · MM-DD 重置”，取下文 `personal.used_ratio`。 |
| “本机运行 · 防护正常” | `apps/desktop/src/lib/user-card.ts:19-34` `sidebarFoot`（正常态 `:33`；代码分析不可用 `:32`）；`Sidebar.tsx:190-192` 组装用户卡 | 正常态返回空（不显示这一行）；异常态（联网记录待核对、入组申请、代码分析不可用、启动中）保留或挪到设置→本机状态。`deviceSafetyTile`（`lib/device-status.ts`，`pages/Connections.tsx:19`）的“本机防护”卡片如需同步去掉另议。 |
| “套餐与用量”页 | `apps/desktop/src/pages/FirmUsage.tsx`：本所额度大卡 `:100-127`、5 小时窗口 `:128-137`（全所口径）、本人卡 `:150-162`、本人明细 `:171-205`、按模型（全所份额）`:209-216`、按成员 `:255-300`、历史（全所）`:301-315`；“本所用量”文案 `:66/74/75` | 只留：**个人套餐权益**（套餐名、每期额度说明、周期、频率限制规则、可用模型）、**个人消耗%与剩余%**、**统计周期与重置时间**、**5 小时窗口（个人可感知的）**、**本人按模型**、**本人用量明细（可翻页）**。全所卡、按成员、全所历史移到网页控制台“本所用量”（已有 `apps/console/pages/firm-usage.js`）。 |
| 额度提示条文案 | `apps/desktop/src/lib/quota-notice.ts:40-62`（“本所{本月}额度已不足 10%”`:59`、个人上限两条 `:58/60`）；`apps/desktop/src/lib/firm-usage.ts:156-168`（“试用版：不统计本所用量”“本所本期额度已用完…”）；`lib/start-block.ts:42` “查看本所用量”；内核 `qa-chat.ts:181` “本所 AI 额度暂时用到限制” | 统一改个人说法：“你的 AI 额度…”（暂停原因仍按 `paused`/`limited_by` 说清）。 |
| 模型名写死 | `apps/desktop/src/lib/firm-usage.ts:175-176` | 用接口里的 `label`。 |

### C.4 个人视图需要的字段：已有 / 缺

| 需要 | 现状 | 缺什么 |
|---|---|---|
| 本人消耗 % | `own.used_ratio`（分母 = 个人上限或 seat_quota） | 当 `enforce_seat_quota=false` 且多人律所时，`own.used_ratio` 不是“真正卡住你的”比例（全所池先用完你也会停）。**加 `personal` 块**：`{ used_ratio, remaining_ratio, limited_by: "allowance"|"cap"|"burst"|"seat"|null, paused }`，用 `availability(q, ctx, sid, uid)`（`quota.ts:236`）折算：`remaining_ratio = avail / 个人分母`（封顶 1）。个人租户（1 席位）里 firm 与 own 分母一致，二者相等。 |
| 剩余 % | 只有 `firm.remaining_ratio` | 同上 `personal.remaining_ratio`。 |
| 统计周期、重置时间 | `period.start/resets_at`（已有，`quota.ts:390`） | 无。 |
| 5 小时窗口 | `burst` 是全所窗口（`windowUsed(ctx, null)`，`quota.ts:377`） | 个人租户等价；多人律所若要个人口径，加 `burst.own_used_ratio = windowUsed(ctx, uid)/阈值`（`book.window` 已支持 uid，`usage-ledger.ts:303`）。 |
| 权益 | 只有 `plan:{id,label}` | 加 `plan.note`、`plan.period`、`plan.burst`、`plan.models`（可用模型显示名，与 A 的模型目录同源）、`quota_unit`；**不下发金额与单价**（律师端只显示百分比，D-198/D-199 口径），也不引入积分。 |
| 按模型明细（本人） | `/v1/quota` 的 `models` 是**全所**份额；`/v1/me/usage` 有本人 `by_model` | 在 `/v1/quota` 加 `own_models`（`book.memberModels`，`server.ts:4552` 同法），字段 `{alias,label,share,requests}`，比例不给金额。 |
| 用量明细 | `own_recent` 固定 20 条、本期内 | 加翻页：建议新增 `GET /v1/quota/usage?before=<iso>&limit=50`（设备签名 + 会话，签名信封 `kwl-usage-page`），或 `/v1/quota` 收 `own_limit`。**新路径要同时加进 `cp-relay.ts` PATHS（带查询串的正则）与 `docs/privacy/egress-paths.json`**。 |
| 历史（本人各期） | `history` 是全所 | 如需本人历史：`book.member(tid, uid, 前几期区间)` 现算（账本保留期内即可），加 `own_history`。 |

建议做法：**不改 `/v1/quota` 已有字段**（旧客户端与管理员视图在用），只追加 `personal`、`own_models`、`plan.{note,period,burst,models}`；新客户端只渲染个人块；旧控制面没有这些字段时回退到 `own`。

---

## D. 本机全栈真实联调：怎么拉起（照做清单）

### D.1 组成与端口

- 云端：`platform/scripts/stack-local.mjs`（生产入口 `cloud-serve.mjs` 拉起 cp-signer、control-plane、legal-gateway、search；同进程发统一控制台静态页）。端口 = `--base-port`（缺省 18400）起：签名服务 18400、控制面 18401、网关 18402、控制台 18403、检索 18404（`stack-local.mjs:45-46`）。与生产唯一差别是回环地址不走 TLS（`--tls` 可开本机 CA + mTLS）。
- 上游密钥：`stack-local.mjs:149` 依次取 `--key-file` → 环境变量 `KWL_MOONSHOT_API_KEY` → **macOS 钥匙串**（账号 `kwl-demo`、服务 `kwl-demo-maas-key`，可用 `KWL_EVAL_KEYCHAIN_ACCOUNT/_SERVICE` 改），只经**文件描述符 3** 交给网关进程（`upstream.api_key_file: /dev/fd/3`，`:127/140/166`），不落盘、不进命令行与子进程环境。**推荐直接跑 stack-local 让它自己读钥匙串**；`demo-launch.mjs` 会把密钥放进 stack-local 的环境变量（`demo-launch.mjs:104-107`），且同步交付文件时用 `security add-generic-password -w` 把密钥放进命令行参数——要换密钥先用钥匙串自带界面或 store_key 方式写好，不走 demo-launch 的同步。
- 路由引导：控制面首次启动按 `routing.bootstrap` 建上游 `maas`（`use_local_key`，即网关 fd 3 那把）与两个内置别名都指向 `--model`（`stack-local.mjs:117`）；网关 `allow_hosts` 只放上游主机（`:128`）。要测“多模型”，在控制台“模型与路由”里新增别名（目标选 `maas` + 另一个 MaaS 型号），15 秒内到网关。
- 状态：全部在 `--dir` 下（`data/`、`cfg/`、`init/`（密钥，0700）、`logs/`（已遮盖密钥）、`console-dist/`），重启保留；`client.env`（0600）给桌面端；`console-login.txt`（0600）是控制台系统管理员登录信息——**不要 cat 到终端或贴进报告**，在浏览器登录时自己打开看。
- 律师端两种形态：
  - **网页形态**（真实联调首选，界面走查快）：`apps/desktop` 的 `npm run dev:web` = vite（5173）+ 开发桥 `node dev/bridge.ts`（7720，`/invoke` 与事件流，令牌由 `dev/bridge-token.ts` 经 vite define 注入，`vite.config.ts:44-45`）。开发桥在进程里 `createKernel()`，读当前环境变量。**必须用全新工作区**（`ZR_KERNEL_DATA_DIR` 指向新空目录）：演示工作区库是页级加密，纯 Node 桥打不开（`demo-launch.mjs:181` 注释）。`ZR_ONBOARDING=1`（client.env 已给）= 待激活模式，从注册/登录开始。
  - **Electron 窗口**：`demo-launch.mjs` 第 ⑥ 步同法（vite + `npm run build:kernel` + `electron .`），可沿用演示工作区。
- client.env 的值里有 JSON（`ZR_CONTROL_PLANE_KEYS`、`ZR_SEAT_KEYS`），**不能 `source`**（shell 会吃掉双引号）；按 `demo-launch.mjs:144-151` 的方式逐行 `^([A-Z_][A-Z0-9_]*)=(.*)$` 解析。

### D.2 命令清单（在本 worktree 的 `platform/` 下；不读取、不打印任何密钥）

```bash
cd "/Users/wangzeyu/Documents/Coding/Kimi Work Legal/.claude/worktrees/kimi-legal-b66-ux/platform"

# 0. 依赖与内容产物（新 worktree 必查；缺了内核会挂起不报错）
npm ci                                   # 已有 node_modules 可跳过
node scripts/check-test-prereqs.mjs      # 缺什么照提示补：npm run pretest；content/keys、content/ocr-models 从主检出复制
#   本 worktree 现状：lawdb.sqlite、content-signing-dev.json、OCR 模型、skills.manifest 都在；electron/kernel.bundle.cjs 不在（只 Electron 形态需要）

# 1. 确认钥匙串里有密钥（只看是否存在，不加 -w，不打印值）
security find-generic-password -a kwl-demo -s kwl-demo-maas-key >/dev/null && echo "钥匙串密钥在"

# 2. 云端本机栈（前台运行，Ctrl-C 停；单独开一个终端）
STACK="$PWD/output/b66-stack"            # 新目录 = 全新云端状态；沿用演示状态用 output/demo-cloud/stack
env -u KWL_MOONSHOT_API_KEY node scripts/stack-local.mjs --dir "$STACK" --base-port 18400 \
  --upstream https://maas.jointpilot.com/v1 --model kimi-k3.1-pro
#   就绪标志：打印“[stack] 桌面端环境变量：$STACK/client.env”与“[stack] 控制台账号：$STACK/console-login.txt”
curl -s http://127.0.0.1:18401/v1/meta   # 自检（无鉴权）

# 3. 律师端网页形态（另一个终端；全新工作区）
WS="$(mktemp -d /private/tmp/kwl-b66-ws.XXXXXX)"   # 或放在会话 scratchpad
node -e '
const fs=require("fs"),cp=require("child_process"),crypto=require("crypto");
const env={...process.env};
for (const l of fs.readFileSync(process.argv[1],"utf8").split("\n")) { const m=/^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(l); if (m) env[m[1]]=m[2]; }
Object.assign(env,{ ZR_KERNEL_DATA_DIR:process.argv[2], ZR_FIRM_SLUG:"local-firm", ZR_USER_SLUG:"local-lawyer",
  ZR_MODEL_PROVIDER:"upstream", ZR_INTERNAL_SECRET:crypto.randomBytes(24).toString("base64url"),
  ZR_BACKUP_TIMER:"off", ZR_DEMO_SAMPLES:"0", KWL_DEV_WEB_PORT:"5173", ZR_DEV_BRIDGE_PORT:"7720" });
cp.spawn("npm",["run","dev:web"],{cwd:"apps/desktop",env,stdio:"inherit"});
' "$STACK/client.env" "$WS"
#   打开 http://127.0.0.1:5173/ → 注册（开放注册时不需码）→ 开通 → 进入工作区；端口被占可改 5175/7721

# 4. 控制台（浏览器）：http://127.0.0.1:18403/ ，账号见 $STACK/console-login.txt（自己打开看，不要贴出）
#   模型与路由：ops/routing（models 标签）；套餐：ops/plans（可用模型别名）；价目：ops/pricing；本所用量：firm-usage

# 5.（可选）Electron 窗口形态：沿用 demo-launch 的做法
#   cd apps/desktop && npm run build:kernel && （同第 3 步的环境）npx vite --port 5173 --strictPort --host 127.0.0.1 & ../../node_modules/.bin/electron .
#   或只用 demo-launch 拉桌面：node scripts/demo-launch.mjs --no-browser（注意它自带云端，且会把密钥经环境变量交给 stack-local）
```

### D.3 本批联调要验的点（与 A～C 对应）

1. 控制台新增别名 `legal/k3-fast`（目标 maas + `kimi-k3.1-pro-highspeed`，说明、排序、思考方式）→ 不重启客户端，首页与问答选择器 ≤1 次刷新内出现；选它发问答/任务 → 控制台“用量”按模型出现该别名、账本 `upstream_model=kimi-k3.1-pro-highspeed`（D-200 的 0069 记录 route 同步）。
2. 套餐“可用模型”去掉该别名 → 客户端置灰并说明“套餐不含”；绕过界面直接发（开发桥 `/invoke chat.send route=…`）→ 内核拒、网关 `model_not_allowed`。
3. 停用别名 → 15 秒内网关 `model_disabled`；客户端提示换缺省模型。
4. 同一账号在第二个全新工作区（`WS2`，开发桥换端口 7721/5175）登录 → 直接进入工作区，无“等待批准”；第一个工作区“登录过的电脑”出现新电脑、有新设备提醒；移除后第二个工作区进入退出模式。
5. 套餐与用量页只见个人块；消耗%与控制面 `/v1/quota` 的 `personal.used_ratio` 一致；明细条数与账本 `uid` 过滤一致；用户菜单无“本所本月已用”、用户卡无“本机运行 · 防护正常”。
