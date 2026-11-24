# 第 62 批契约：模型定价与计费体系（给控制台同事）

> 版本：b62（2026-11-24）。后端实现：`services/control-plane/src/{routing,billing,quota,usage-ledger,server}.ts`、`services/legal-gateway/src/{usage,gateway,routing,providers}.ts`。
> 用例：`services/control-plane/test/b62-pricing.test.ts`、`services/legal-gateway/test/b62-usage-billing.test.ts`。
> 控制台（`apps/console/`）本批未改，按本文改造；旧页面在改造前仍能用，例外见 §2.4。

## 0. 口径（用户拍板）

1. 云端是用量、配额、计费的唯一可信来源；保留“百分比用量与配额”，不引入积分 / 点数。律师端（桌面）只看百分比。
2. 额度按价目加权扣减：每次请求扣“折算金额”（售价口径，缓存命中按命中价）。套餐额度按金额设定（`quota_unit: "cny"`，内部微元）。
3. 成本价按上游真实型号定，缺省取 Kimi 官方价；售价 = 成本 × 加价倍率（全局缺省 1.0，可按型号覆盖）或显式售价。别名切到别的型号（如 highspeed），售价与成本跟着型号走。价目变更即新版本、下一请求起生效，历史行不改写。
4. 价目生效前的历史行（线上 580 行）不改写，汇总里如实标“价目生效前”，另给“按现行价估算”一列（只读）。

单位：单价 **元 / 百万 token**；金额内部 **微元**（1 元 = 1,000,000 微元；1 元/百万 token × 1 token = 1 微元）；接口里的 `*_cny` 为元、保留 4 位小数，逐行的精确值看 `value_micro` / `cost_micro`。账期按北京时间（自然月）。

## 1. 计费 token 与金额

上游 usage（Kimi Chat Completions，2026-11-24 对中软 MaaS 实测）：`prompt_tokens` 含缓存命中与缓存写入（三者之和 = 总输入）；`completion_tokens` 含推理。

| 档 | 来源 | 单价字段 | 缺价回退 |
|---|---|---|---|
| 未命中输入 `uncached` | `prompt_tokens − cached − cache_write` | `input` | —（缺即未定价） |
| 缓存命中 `cached` | `prompt_tokens_details.cached_tokens`（旧版顶层 `cached_tokens`） | `cached_input` | `input` |
| 缓存写入 5 分钟 `cache_write_5m` | `prompt_tokens_details.cache_write_tokens` − 1 小时部分 | `cache_write` | `input` |
| 缓存写入 1 小时 `cache_write_1h` | 响应头 `Msh-Usage-Cache-Write-Tokens-1h`；无头时请求 `prompt_cache_options.ttl = "1h"` 即全部写入算 1 小时 | `cache_write_1h` | `cache_write` → `input` |
| 输出 `output` | `completion_tokens`（含推理） | `output` | —（缺即未定价） |
| 推理 `reasoning` | `completion_tokens_details.reasoning_tokens` | 只记录，不另计费 | |

金额（微元）= `round(uncached×input + cached×cached_input + cache_write_5m×cache_write + cache_write_1h×cache_write_1h + output×output)`。
依据：官方“K3 系列缓存写入按 TTL（5min / 1h）单独计费；缓存命中只按命中价，不再重复收写入费”；TTL 缺省 5 分钟（本产品客户端不传 TTL，写入价 = 未命中输入价）。

官方价（成本缺省，`OFFICIAL_PRICES`，来源 https://platform.kimi.com/docs/pricing/chat ，2026-11-24 抓取）：

| 型号 | 输入 | 命中 | 写入 5min | 写入 1h | 输出 |
|---|---|---|---|---|---|
| kimi-k3.1-pro | 13 | 1.3 | 13 | 26 | 68 |
| kimi-k3.1-pro-highspeed | 26 | 1.3 | 26 | 52 | 136 |
| kimi-k3 | 20 | 2 | 20 | 40 | 100 |
| kimi-k2.7-code | 6.5 | 1.3 | — | — | 27 |
| kimi-k2.7-code-highspeed | 13 | 2.6 | — | — | 54 |
| kimi-k2.6 | 6.5 | 1.1 | — | — | 27 |

## 2. 价目接口

### 2.1 `GET /v1/ops/pricing`（权限 `route.read`）

```jsonc
{
  "version": 3, "effective_at": "…", "by": "stf_…|migration:b62|bootstrap:official",
  "basis": "model",            // model = 按上游型号（第 62 批）；alias = 旧版本（按别名）
  "markup": 1,                 // 整表加价倍率（basis=alias 时 null）
  "note": "…|null",
  "models": [{
    "model": "kimi-k3.1-pro", "label": "Kimi K3.1 Pro",
    "cost": { "input": 13, "cached_input": 1.3, "cache_write": 13, "cache_write_1h": 26, "output": 68 },   // 成本价（null = 该行未存）
    "cost_source": "Kimi 官方定价 https://platform.kimi.com/docs/pricing/chat（2026-11-24 抓取）|运营录入|迁移自第 N 版…",
    "markup": null,                     // 按型号覆盖的倍率；null = 用整表
    "sale_override": null,              // 显式售价（逐项；null 项按 成本×倍率）
    "effective": { "sale": { …五档… }, "cost": { …五档… }, "markup": 1 },   // 生效值（null = 本版本没有这一行）
    "priced": true,                     // 售价的输入与输出都有
    "used_by": [{ "alias": "legal/k3", "primary": true }],
    "official": { …五档…, "source": "…" } | null
  }],
  "aliases": [{ "alias": "legal/k3", "enabled": true, "primary_model": "kimi-k3.1-pro", "targets": ["kimi-k3.1-pro"], "effective": { "basis": "model", "key": "kimi-k3.1-pro", "sale": {…}, "cost": {…} } | null }],
  "official": { "source": "…", "models": { "kimi-k3.1-pro": { "label": "…", …五档… } } },
  "history": [{ "version": 3, "effective_at": "…", "by": "…", "basis": "model", "note": "…" }]   // 新的在前
}
```

`models` 列出本版本有的型号与路由里被引用、但本版本没有的型号（后者 `effective: null, priced: false`，界面标“未定价”）。

### 2.2 `PUT /v1/ops/pricing`（权限 `price.manage`，危险操作：10 分钟内复核过）

整表替换、产生新版本、下一请求起生效（网关每 15 秒取一次路由订阅；每行记它发起时网关所持的版本）。

```jsonc
{
  "markup": 1.0,                       // 可选，0.01–100，缺省 1.0
  "note": "…",                         // 可选，≤ 200 字
  "models": {                          // 必填，≤ 64 个型号
    "kimi-k3.1-pro": {},               // cost 不给 → 官方价（cost_source 写官方来源与日期）；官方价表没有的型号 → 未定价
    "kimi-k3.1-pro-highspeed": { "markup": 1.5 },
    "kimi-k2.6": { "sale": { "output": 30 } },                    // 显式售价：只覆盖给了的项
    "my-model": { "label": "自建", "cost": { "input": 1, "output": 2 }, "cost_source": "合同价 2026-12" }
  }
}
```

- 单价 0–100000（元/百万 token），保留 4 位小数；留空 = null。
- 应答：`{ ok, version, pricing: <同 GET> }`。
- 错误：`400 pricing_invalid`（形状、范围）；`409 prices_required_by_plan`（有金额套餐要用的别名会失去售价——别名的**每个**目标型号都要有售价，`error.plan`、`error.aliases` 列出）。被拒不产生新版本。

### 2.3 金额套餐的定价前置（D-222 沿用）

`PUT /v1/ops/plans/:id` 保存 `quota_unit: "cny"` 的套餐时，可用别名（`models`，null = 全部启用的）的每个目标型号都要有售价，否则 `409 plan_models_unpriced`（`error.aliases`）。网关预占时若有候选型号未定价，金额租户 `503 price_unconfigured`（不按 0 元放行）。

### 2.4 旧接口

- `PUT /v1/ops/routing/prices { items }`（按别名）：**只在当前版本仍按别名时可用**；已按型号管理时 `409 pricing_basis_model`（防止悄悄改回按别名）。迁移后旧控制台的“价目表”保存会被拒——请改调 §2.2。
- `GET /v1/ops/routing` 的 `prices` 增加 `basis`；`prices.items` 在按型号的版本里是派生值（别名 → 首选目标型号的售价 / 成本），只读参考；`price_history[]` 增加 `basis`。

## 3. 账本行（`GET /v1/ops/usage/records`、CSV）

既有字段不变。第 62 批新增（可选字段，旧行没有）：

| 字段 | 含义 |
|---|---|
| `usage.cache_write` / `usage.cache_write_1h` | 缓存写入总数 / 其中 1 小时（为 0 时不出现） |
| `price_basis` / `price_key` | `model` + 上游型号（如 `kimi-k3.1-pro-highspeed`），或 `alias` + 别名（旧版本） |
| `markup` | 这一行适用的加价倍率（按别名的旧版本为 null） |
| `billed` | 计费 token 明细 `{ uncached, cached, cache_write_5m, cache_write_1h, output, reasoning }` |
| `reconcile: "pending"` | 上游没给真实 usage、网关按估算——**不计入额度、售价记 0、成本记 null**，待与上游账单对账 |
| `est_usage` / `est_value_micro` / `est_cost_micro` | 估算的用量与按当时价目折的售价 / 成本（不计入任何合计） |
| 视图：`est_value_cny` / `est_cost_cny` | 同上（元） |
| 视图：`unpriced_est_value_cny` / `unpriced_est_cost_cny` | 价目生效前（`usage` 有、`value_micro` 为 null）的行按**现行**价目的只读估算 |

`billing_note`（显示用）：`价目生效前（未定价）`、`上游未给出用量，按估算（不计费，待对账）`、`服务出错，用量按估算（不计费，成本待对账）`、`服务出错（已产生成本，不计费）`（partial 且拿到真实 usage）、`历史补录`、`重试`。

追溯一行的金额：`upstream_model`（实际服务的型号）+ `price_version`（价目版本）+ `billed`（明细）+ `value_micro` / `cost_micro`。

CSV 新列（追加在末尾）：计价依据、计价键、加价倍率、未命中输入token、缓存写入token(5分钟)、缓存写入token(1小时)、推理token、估算售价(元,待对账)、估算成本(元,待对账)。

## 4. 汇总与账单

### 4.1 `GET /v1/ops/usage/summary?group=day|model|upstream|tenant|account`（`usage.read`）

- 新分组 `upstream`：按实际服务的上游型号（成本对账用；`key` 为型号，空串 = 未到达上游）。
- 每行与 `totals` 新增：`tokens_cache_write`、`pending_reconcile`（待对账行数）、`est_value_cny`、`est_cost_cny`（估算，不计入 `value_cny` / `cost_cny`）、`unpriced_note`（有价目生效前的行时为 `"价目生效前"`）、`unpriced_est_value_cny` / `unpriced_est_cost_cny`（按现行价估算，只读；没有这类行为 null）、`unpriced_still`（按现行价仍未定价的行数）。
- 顶层新增 `price_version`（现行版本）与 `notes.unpriced`、`notes.pending_reconcile`（界面说明文字）。

### 4.2 `GET /v1/ops/billing[.csv]`（`billing.read`）

每行新增：`unpriced_note`、`unpriced_est_value_cny`、`unpriced_est_cost_cny`、`pending_reconcile`、`est_value_cny`、`est_cost_cny`。`value_cny` / `cost_cny` 仍只含已定价、实测的行。

### 4.3 `GET /v1/ops/overview`

`totals` 新增 `tokens_cache_write`、`pending_reconcile`（无 `usage.read` 时裁掉）、`est_value_cny`、`est_cost_cny`（无 `billing.read` 时裁掉）。

## 5. 套餐金额额度与迁移

### 5.1 套餐

`quota_unit: "cny"` 时 `seat_quota` 单位为**元**（内部 × 10⁶ 微元）；`tokens` 仍支持（运营显式选择）。账号个人上限 `quota_limit` 同套餐单位（cny 为元）。
生产入口（给了 `billing` 段）新建状态的缺省目录（`CNY_CATALOG`）：标准 210、专业 525、旗舰 1,260、试用 84 元（试用含 5 小时 50% 窗口）。新部署的价目按型号、官方价 × 1.0（`by: "bootstrap:official"`），开箱可用。

### 5.2 读回迁移（第 62 批之前写下的状态，升级后首次启动自动做一次）

折算系数 **4.2 元 / 百万 token**（`B62_CNY_PER_MTOK`）：线上账本 607 行（输入 6,049 万含命中 5,362 万、输出 148 万）按 v2 价 = 259.66 元 ÷ 6,197 万 token = 4.19，向上取一位小数（换算后额度不少于原额度的等价金额）。

1. 价目：按别名的当前版本 → 新版本（`basis: "model"`、`by: "migration:b62"`）；官方价表的型号成本取官方价；原别名售价落到它的目标型号——与“成本 × 1.0”一致的不设覆盖（线上 v2 即如此），不一致的记显式售价。
2. 套餐：`tokens` 套餐 → `cny`，`seat_quota = tokens × 4.2 / 10⁶`（标准 5,000 万 → 210，试用 2,000 万 → 84），说明改为“原每席位 N 万 token，按 4.2 元/百万 token 折算”。
3. 律所：自定额度 `allowance_override` 同系数；本期账本里价目生效前（未定价）的行按同系数折成“迁移前已用”（`quota.legacy.used_units`，按成员另记 `members`），已定价的行按售价照常计入——百分比连续；tokens 单位的在途租约收回（网关下次回报得知，按金额重领）。
4. 账号：个人上限同系数（tokens → 元）。
5. 记录 `catalog.migrations.b62_billing`：`{ status: "applied", at, coefficient_cny_per_mtok, price_version_from/to, plans[], tenants[], accounts[] }`（原值留存）。迁完立即写盘；写不进去即启动失败。

幂等：有记录（`native` / `applied` / `reverted`）即不再迁。账本行一律不改写。

### 5.3 查看与还原

- `GET /v1/ops/billing/migrations`（`billing.read`）→ `{ b62_billing: <记录> | null }`。新建状态为 `{ status: "native" }`。
- `POST /v1/ops/billing/migrations/b62/revert`（`plan.manage`，危险操作）→ `{ ok, restored_plans, skipped, migration }`：套餐、律所自定额度、个人上限回到 tokens 原值（**只还原仍是迁移值的项**，迁移后又改过的列在 `skipped`），迁移前已用回到迁移前，收回在途租约；状态 `reverted`，读回不再自动迁移。价目不还原（按型号的版本对 tokens 套餐的额度无影响）。`409 migration_not_applied`：没有可还原的。
- 只回滚代码（不还原数据）也可：金额套餐第 56 批起就支持；按型号的版本里保留派生的按别名 `items`，旧版控制面与网关照旧计价（别名 → 首选目标型号的价）；`legacy.used_ratio` 仍在（旧版按比例读）。

## 6. 网关与入账口径（核对过的边界）

- **预占**：按别名各候选型号里逐项最贵的售价 × 估算（输入 = 请求 JSON 长度 / 2，按未命中价；输出 = max_tokens 或缺省）；有候选未定价 → 金额租户 503。
- **结算**：按实际服务的上游型号的售价；控制面按记录里的价目版本与型号重算（权威），网关的 `charge_units` 只用于本机租约余量。
- **usage 采集**：流式逐行全程解析（含 `choices[].usage`，不只看末块或尾部 64 KiB）；非流式大响应只留尾部时按括号配对取 `usage`；`stream_options.include_usage` 由网关强制打开。
- **缺真实 usage**（`usage_source: "estimated"`）：不扣额度、不计售价与成本，另记估算、待对账，运营告警 `usage_missing`（每上游每小时一条）。
- **partial（D-194）**：流式已转发内容后上游出错 / 块间隔超时——不扣律师额度、售价 0；拿到真实 usage 时成本按真实记，没拿到时成本记 null、估算另记待对账。
- **上游 4xx / 5xx / 429、连接失败、头超时**：没有 usage，不计不扣；429 不计入熔断。
- **切换与重试**：同一请求在网关内换目标只产生一条记录（只有成功的那次有 usage）；回报与重放按 `request_id` 去重（并发回报同样）；客户端（闸门）重发是新的请求编号，每次都真实调用上游、各自计费。
- **客户端断开**：网关继续读至多 60 秒 / 8 MiB 拿真实 usage（`drained`），照常计费；读不到即估算、待对账。

## 7. 律师端（桌面）

- 单位为元时只显示百分比（本所、本人、按模型、按成员、剩余）；不显示金额、不用 `charge` 折算。
- `GET /v1/quota` 的 `own_recent[]` 新增 `charge_ratio`（这一条占本人分母的比例，控制面算）与 `pending`（待对账、未计入）。

## 8. 控制台改造清单（建议）

1. 价目页改按上游型号：读 §2.1，写 §2.2；成本列标来源（官方价带日期），倍率（全局 + 按型号）、显式售价可选；“被哪些别名用”“首选”。
2. 套餐页：金额套餐的额度单位“元 / 席位 / 月”；旧的“按 token”选项保留但不作缺省。
3. 用量页：结果徽章——`reconcile: "pending"` 显示“待对账（不计费）”；`partial` 的说明改为“服务出错，不计费”（原文“按已转发内容估算计费”与实际口径不符）。
4. 汇总 / 账单：加“价目生效前”标记与“按现行价估算（只读）”列、“待对账”与估算金额列；分组加“上游型号”。
5. 系统页：显示 `billing/migrations` 状态；还原按钮（危险操作，二次确认，说明“只还原仍是迁移值的项”）。
6. 告警：新种类 `usage_missing`。

## 9. 真实调用对账（2026-11-24，中软 MaaS）

本机起控制面（生产入口同形：金额试用套餐 84 元、按型号官方价）+ 网关（租约 v2、路由订阅、本机密钥），上游 `https://maas.jointpilot.com/v1`；客户端从响应里自己解析 usage，与账本逐行比对，金额按官方价手算：

- 18 次调用：k3.1-pro 非流式 3 / 流式 3 / 流式 ttl=1h 2、k2.6 非流式 2、上游 400 1、客户端收到首块即断开 2、别名切到 highspeed 3（其中 1 次真实 429）、加价 1.2 后 1。
- 16 行计费：客户端所见 usage 与账本 usage 逐项一致（输入、命中、写入、输出）；账本金额与手算一致 16 / 16，合计 1,167,827 微元（1.1678 元）。
- 首次请求 `cache_write_tokens = 8960`、之后命中 8960；ttl=1h 的写入按 26 元计（255,401 微元）；切到 highspeed 不改价目即按 26 / 1.3 / 136 计；加价后的一行记 `price_version 2`、`markup 1.2`，之前的行不变。
- 上游 400、429：有行、不计不扣；客户端断开的两次由网关继续读到真实 usage（`drained`），照常计费。
