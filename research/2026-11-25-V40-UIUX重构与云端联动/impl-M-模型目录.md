# 第 66 批（V40）实施记录 M：云端模型目录与所选模型真实路由

- 依据：`audit-A-云端模型账号额度.md` A.4 (1)～(6)。分支 `claude/kimi-legal-b66-ux`，**未提交**（同 worktree 有主会话与另一代理在改别的文件）。
- 偏离：**D-291**（取消 D-200 中“问答只此两项”“任务只读显示 K3”），登记在 `platform/docs/v9-开发计划与进度.md` 偏离表 D-277 之后。D-278～D-290 为第 65 批（另一 worktree，未提交）所占，本批未再用其他号。
- 迁移：**0073** `packages/kernel/src/migrations/0073_v40_run_model_prefs.sql`（`runs.model` + 表 `model_prefs`）。下一号 0074、偏离下一号 D-292。

## 1. 改动文件

| 层 | 文件 | 内容 |
|---|---|---|
| 控制面 | `services/control-plane/src/routing.ts` | `ModelRouteRecord` 加 description / sort / thinking / efforts / capabilities / scopes / client_visible / max_context；`BUILTIN_MODEL_META`（K3：qa+task、effort、low/high/max；K2.6：只 qa、toggle）；`modelMetaOf` 补缺省（首次部署占位名“主任务模型 / 子任务模型”给律师看时换成 K3 / K2.6；bootstrap 改为直接用 K3 / K2.6）；`upsertModel` 逐项校验（`validateModelMeta`）；设为缺省须可见且入口含 task；`routingView` 带出（补缺省）；新增 `modelCatalogBody`（客户端目录，纯函数）。`routingFeedBody`（网关订阅）不变 |
| 控制面 | `services/control-plane/src/server.ts` | 新增 `GET /v1/models`（设备签名区，与 `/v1/quota` 同一鉴权），`seal("kwl-model-catalog", modelCatalogBody(routing, ctx.plan, …))` |
| 控制面 | `services/control-plane/src/signer.ts`、`services/cp-signer/src/index.ts` | 信封种类加 `kwl-model-catalog`；签名服务按种类核：结构、时限、≤32 项，**条目里出现 targets / provider / base_url / key_sealed / key_hint / upstream_model 即拒签** |
| 网关 | `services/legal-gateway/src/quota.ts` | 租约 `take()` 先判 `allowedAliases`（model_not_allowed 403）后判价格（price_unconfigured 503） |
| 控制台 | `apps/console/pages/routing.js` | 模型表加“客户端入口”“排序”列；编辑抽屉加说明、排序、思考方式（下拉）、档位、能力、入口（问答 / 任务）、对客户端可见、上下文窗口；前端拦“任务入口须有 tool_use”。沿用现有 field/note/badge 风格 |
| 出站 | `packages/egress-gate/src/cp-relay.ts`、`docs/privacy/egress-paths.json` | 控制面通道白名单加 `^\/v1\/models$`，登记表同步、`what` 补说明（数据类不变 24/25/29） |
| 驻留面 | `docs/privacy/ledger-tables.json`、`docs/privacy/residency.json` | 新表 `model_prefs` 记第 19 类；写盘点 `services/model-catalog.ts`（renameSync、writeFileSync）记第 19 类 |
| 日志 | `packages/safe-log/src/events.ts` | 新事件 `KERNEL_MODEL_CATALOG`（outcome：fetch_failed / invalid / stale / cache_failed；trigger） |
| 模型路由 | `packages/model-broker/src/broker.ts` | 内置两项 + 目录动态项：`setCatalog(list)`（只收 available 的非内置项；thinking/efforts 取目录；provider 随内置 K3）；`isBuiltinRoute`；`gateCall` 对自带密钥 / 私有端点的**非内置别名**直接拒绝（中文说明，不发给上游） |
| 内核 | `packages/kernel/src/services/model-catalog.ts`（新） | `ModelCatalogService`：经 `controlPlane.modelCatalogEnvelope()` 拉取、`governance.openSigned(…,"kwl-model-catalog")` 验签、`sanitizeCatalog` 只取已知字段（整份不合格不收）、按 (version, issued_at) 只进不退、缓存 `<工作区>/model-catalog.json`（存原信封与 fetched_at，读回重验）、`list/check/defaultFor/labelOf`、`refresh`（单飞、可限频）、`start/stop`；`BUILTIN_CATALOG`、`catalogReasonText`、`isModelRejection` |
| 内核 | `packages/kernel/src/services/model-prefs.ts`（新） | `selectedModelOf` / `saveModelPref`（按 tenant、user、scope） |
| 内核 | `packages/kernel/src/control-plane/client.ts` | `modelCatalogEnvelope()`（GET /v1/models，原样返回信封） |
| 内核 | `packages/kernel/src/index.ts` | 建 `modelCatalog`（有控制面才拉取；无控制面只内置两项）→ `broker.setCatalog`；登录成功（`accountDeps.save`）后刷新；`onModelRejection` 遇 model_* / price_unconfigured / upstream_unavailable 刷新（≥30 秒一次）；每 10 分钟（`ZR_MODEL_CATALOG_MS` 可调或 off；`ZR_CONTROL_PLANE_SYNC_MS=off` 时也不自动拉，除非显式给了 `ZR_MODEL_CATALOG_MS`）；问答的 catalog / selectedRoute / defaultRoute 改读目录；`workflowDeps.modelSpecOf` |
| 内核 | `packages/kernel/src/services/qa-chat.ts` | 删 `QA_MODEL_CATALOG`；`qaModelChoices(…, catalog = BUILTIN_CATALOG)` 读目录（入口含 qa 且可用且 broker 认得）；`qaRouteLabel(alias, catalog)`；`qaFailureText(msg, route, { labelOf, defaultAlias })`——“请换 K3”改为“请换 {缺省模型显示名}”；`chat.send` 不带 route 时先用律师在问答记住的模型 |
| 内核 | `packages/kernel/src/api/index.ts` | 新方法 `models.list`、`models.select`；`runs.start` 加 `model`（校验、追问沿用、写 `runs.model`、返回 model / model_label）；`runs.get` 的 run 带 `model`、`model_label` |
| 内核 | `packages/kernel/src/executor/{executor,agent-client,kap-agent-client}.ts` | `runModelId`；交给宿主 `model` + `model_spec`（首轮、修订稿段、修改轮三处）；s1 审查分析、独立复核、复核追问的路由跟随任务模型（本机路由已不认时退回 legal/k3；推理强度只在该模型支持时带） |
| 宿主 | `packages/kap-host/src/{engine-config,matter-engine,runtime}.ts` | `StartRunRequest.model / model_spec`；`TaskModelSpec`、`sanitizeTaskModel`、`engineCapabilitiesOf`；`buildEngineConfig` 的 models 段按 `taskModels` 动态加一项（provider 仍是闸门）；`runtime.startRunReserved` 用 `req.model ?? MAIN_MODEL`（run.started 事件与 prompt 都用它），引擎配置里没有该别名时关掉本事项引擎按新配置重开（同一事项同时只发起一个运行）；子 Agent 仍强制 K2.6（policy.ts 未动） |
| 桌面 | `apps/desktop/src/api.ts` | 只追加：类型 `ModelScope`、`ModelOption`、`ModelCatalogView`；方法 `modelsList`、`modelsSelect`；`startRun` body 类型加可选 `model`、返回加 `model/model_label`（不改调用方式） |
| 桌面 | `apps/desktop/src/components/RunSheet.tsx`、`src/lib/pending-options.ts` | `PendingStart.model?`、`prepareStart(…, { model })`、`launchRun` 带上 `model`；重新估价沿用 |
| 文档 | `platform/docs/v9-开发计划与进度.md` | D-291 |

没有方法白名单需要登记（开发桥 / preload / 主进程按方法名转发，`chat.models` 也未登记）。

## 2. 接口与字段

**控制面 `GET /v1/models`**（设备签名；信封 `kwl-model-catalog`）

```json
{ "version": 37, "issued_at": "…", "tid": "ten_…", "uid": "usr_…", "default": "legal/k3",
  "models": [ { "id": "legal/k3-fast", "label": "K3 高速", "description": "更快出结果", "sort": 15,
                "thinking": "effort", "efforts": ["low","high"], "capabilities": ["tool_use","thinking"],
                "scopes": ["qa","task"], "max_context": null, "default": false,
                "available": false, "reason": "not_in_plan" } ] }
```

- 只列 `client_visible !== false`；停用的也列、标 `disabled`。
- reason：`disabled`（停用）→ `no_route`（有目标但目标的上游都停用；**没有目标 = 首次部署未配上游、网关用本机兜底，不算**）→ `not_in_plan`（`PlanSpec.models`）→ `unpriced`（金额套餐且目标型号未定售价，同 `unpricedAliasesIn`）。
- `version` = 路由版本；套餐变化不升版本，靠 `issued_at` 更晚区分——客户端按 (version, issued_at) 只进不退。

**内核 `models.list({ scope: "task"|"qa", refresh?: true })`** → `{ scope, version, source: "cloud"|"cache"|"builtin", fetched_at, default, selected, selected_unavailable?, models: [{ id, label, description, sort, thinking, efforts, capabilities, scopes, max_context, default, available, reason, reason_text }] }`
- task 入口只列 scopes 含 task 的；不含 tool_use 的标 `no_tool_use`。
- `selected` = 律师在该入口记住的（仍可用）否则缺省；记住的不可用时给 `selected_unavailable`（含中文原因）。

**`models.select({ scope, id })`** → `{ ok, scope, selected, label }`；不可选拒绝（validation，消息可直接显示：“不能选这个模型：本所套餐不含这个模型”等）。

**`runs.start({ …, model? })`**：缺省 = 律师在首页记住的（仍可用）→ 目录任务缺省；校验在目录中、可用、入口含 task、能力含 tool_use；自带密钥 / 私有端点只认内置两项；追问沿用上一轮（给了不同的拒绝；上一轮模型现已不可用也拒绝并说明“请重新发起任务并选别的模型”）。被拒时顺带刷新一次目录。返回加 `model`、`model_label`。

**中文原因**：not_in_plan“本所套餐不含这个模型”；unpriced“这个模型尚未定价，暂不能用”；no_route“这个模型暂时没有可用线路”；disabled“这个模型已停用”；no_tool_use“这个模型不支持任务需要的工具调用，只能在问答里用”；not_in_scope；unknown“没有这个模型（可能已下线）”；byok_builtin_only。

## 3. 给主会话：界面怎么接

```ts
import { api, type ModelCatalogView, type ModelOption } from "../api.ts";
const cat: ModelCatalogView = await api.modelsList("task", { refresh: true }); // 打开选择器时 refresh；首屏可不带
// 列 cat.models（available=false 的置灰并显示 reason_text；reason==="disabled" 的可隐藏），选中 cat.selected
await api.modelsSelect("task", id);                    // 律师换模型时记住（失败消息可直接显示）
const p = await prepareStart(matter, value, { …, model: id }); // RunSheet：把所选模型带进确认卡
await launchRun(p);                                     // → runs.start({ …, model })
// 场景开始面板若自己调 api.startRun，直接在 body 里加 model。
// 问答：api.modelsList("qa") 与 chat.models 同源；发送仍用 chatSendWithModel({ route: id })；
// localStorage 的 kwl.chat.model 可在首次 models.list("qa") 时迁一次：selected 为缺省且本地有值 → modelsSelect("qa", 值)。
```

`runs.get` 的 `run.model_label` 可在执行页显示“由 K3 完成”。

## 4. 用例与结果

新增：
- `services/control-plane/test/b66-model-catalog.test.ts`（5 例）：目录过滤与排序、内置缺省、**JSON 与每项键集合不含 targets / base_url / provider / key_* / 上游型号 / 上游主机**；not_in_plan / unpriced / no_route；新字段逐项校验与运营视图、网关订阅键集合不变；签名服务拒签夹带上游信息与过时的目录；HTTP：设备签名取目录、运营新增别名版本升、改套餐同版本更晚签发且置灰、篡改验签失败、无签名拒绝。
- `services/legal-gateway/test/b66-model-order.test.ts`（1 例）：先权限后价格。
- `packages/kernel/test/b66-model-catalog.test.ts`（7 例）：验签、未知字段丢弃、只进不退（旧版本、同版本更早签发都不收，同版本更晚签发收）、篡改 / 别家租户 / 换钥不收、取不到用最后一版、缓存读回重验；broker 动态项与 BYOK 拒绝；问答读目录与失败说明；引擎配置按所选别名加一项；`models.list/select`；`runs.start` 拒绝 K2.6 / 未知 / 非字符串，合格的写 `runs.model`、执行器交给宿主 `model: legal/k3`、宿主 `agent.started` 事件带 `model: legal/k3`、追问换模型被拒。

跑过（`node --test --test-reporter=tap`）：
- 上述新增 13 例全过；`packages/model-broker/test/*`、`packages/kernel/test/b47-qa-model-choice.test.ts` 全过。
- `packages/egress-gate/test/*.test.ts` + `packages/safe-log/test/*` + `services/cp-signer/test/*` + control-plane `b44-ops-api` / `b56-cny-pricing` / `b44-accounts-routing-ledger` + gateway `gateway-routing` / `gateway-quota`：191 例全过（出网面用例曾因依赖字段名 `fetch` 误报，已改名 `pull`）。
- kap-host `embed-drift` / `p1-kap-host`，kernel `b46-client-polish` / `b52-cloud-connection` / `qa-stream` / `b38-independent-review` / `kap-a1` / `b47-account-disabled-model` / `privacy-residency`：除下列两条外全过。
- `apps/desktop/test/*.test.ts`：564 例全过。
- 类型检查：`npx tsc -p tsconfig.check.json --noEmit`、`apps/desktop` `npx tsc --noEmit` 均 0 错。

未过、与本批无关（未改）：
1. `privacy-residency`“渲染存储”：`apps/desktop/src/pages/Home.tsx` 用了未登记的 localStorage 键 `kwl.home.lastMatter`（主会话在改 Home.tsx，须在 residency 清单登记该键）。
2. kernel `control-plane.test.ts` 第 11 例：`client_seen_on` 按 UTC 日期比本机日期（运行时为北京时间 0 点 30 分，UTC 仍是前一天）——时区相关的存量用例问题。

3. control-plane `staff-console.test.ts`“客户端最低版本”：`/v1/meta` 多出 `account_device_ca` 字段（另一代理的“账号设备由控制面签发”改动，非本批）；该例失败后整个文件挂住不退出（`ops-console` 因此未跑完）。

## 5. 未做与风险

- 选择器界面（首页 Composer、问答页、场景开始面板）未改（主会话做）；`apps/desktop/src/lib/firm-usage.ts` 的别名→中文名写死未改（用量页可改读 `api.modelsList("qa")` 的 label，或沿用控制面 `/v1/quota` 已带的 label）。
- 套餐撤掉某模型：客户端目录下次刷新即置灰，但网关要等现有租约到期（`allowedAliases` 在租约上）才拒绝。
- 引擎配置 `default_model` 仍为 legal/k3（引擎按事项长驻；所选模型由每次 prompt 显式指定，宿主 run.started 记的是所选模型）；换到引擎配置里没有的新别名时会关掉本事项引擎重开一次（会话在盘上，追问照常恢复），首轮会多几秒。
- 独立复核跟随任务模型：若运营给任务模型配了较弱型号，复核质量随之变化（审计 A.4 留待产品拍板的一项，本批按“跟随”实现）。
- 新别名的 thinking=effort 时引擎声明 thinking 能力（与内置 K3 一致）；toggle / none 只声明 tool_use（与内置 K2.6 一致）。
- `runs.estimate` 与模型无关，未改。
- 迁移 0073 只加列与新表；旧任务 `runs.model` 为空，按 legal/k3 处理。

## 6. 本机联调怎么验（对应审计 D.3 第 1～3 条）

按审计 D.2 拉起本机云端栈（`stack-local.mjs`）与网页形态律师端（全新工作区）；联调时可加 `ZR_MODEL_CATALOG_MS=30000` 让目录 30 秒刷新一次。
1. 控制台“模型与路由 → 模型别名 → 新增”：`legal/k3-fast`，目标 maas + `kimi-k3.1-pro-highspeed`，说明“更快出结果”、排序 15、思考方式“调强度”、档位 low/high、能力勾工具调用与深度思考、入口勾问答与任务。开发桥 `/invoke models.list {"scope":"task","refresh":true}` 应出现它（available=true），无需重启客户端；`runs.start` 带 `model:"legal/k3-fast"` 发起 → 执行页 `run.model_label`=“K3 高速”；控制台用量按模型出现该别名，账本 `upstream_model=kimi-k3.1-pro-highspeed`；问答 `chat.send route=legal/k3-fast` → `qa_messages.route` 记该别名。
2. 套餐“可用模型”去掉它 → `models.list` 里 `available=false, reason=not_in_plan`、`reason_text`=“本所套餐不含这个模型”；直接 `/invoke runs.start … model:"legal/k3-fast"` → 内核拒绝；绕过内核（目录未刷新前）发问答 → 网关 `model_not_allowed`（不再先报 price_unconfigured），内核随即刷新目录。
3. 停用该别名 → 15 秒内网关 `model_disabled`；问答失败说明“K3 高速 这个模型暂不可用……请换 K3 再问”；目录刷新后 `reason=disabled`，记住的选择回落缺省并给 `selected_unavailable`。
