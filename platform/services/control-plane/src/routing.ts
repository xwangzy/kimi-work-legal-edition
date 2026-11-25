/**
 * API 路由登记（第 44 批，主文 §3）：上游（地址、厂商、密钥密文与尾号）、模型别名（目标与优先级）、价目表（版本化）。
 *
 * - 控制面**看不到上游密钥明文**：运营控制台在浏览器里用网关路由公钥加密（ECDH P-256 + HKDF-SHA256 + AES-256-GCM），
 *   这里只存密文 `key_sealed` 与尾号 `key_hint`；也可选 `use_local_key`（密钥只放在网关服务器文件里）。
 * - 别名是客户端写死的稳定名字（`legal/k3` 主任务、`legal/k2.6` 子任务）：内置别名不可删、不可改名，只改“别名 → 上游与型号”。
 * - 价目表每次修改产生新版本（旧版本保留，账本行按版本重算费用）；单价单位：元 / 百万 token，`null` = 未定价。
 * - 下发：`routingFeedBody` 由控制面签名（信封种类 kwl-routing-feed），网关每 15 秒取一次；网关本机另有上游主机白名单，
 *   控制面被攻破也不能把案卷请求改投名单外的主机。
 */

export interface SealedKey {
  alg: "ECDH-P256+HKDF-SHA256+A256GCM";
  kid: string;
  epk: string;
  iv: string;
  ct: string;
}

export interface ProviderRecord {
  id: string;
  label: string;
  vendor: string;
  base_url: string;
  enabled: boolean;
  key_sealed: SealedKey | null;
  key_hint: string | null;
  key_set_at: string | null;
  key_set_by: string | null;
  /** 用网关服务器本机配置的密钥文件（upstream.api_key_file）；key_sealed 非空时以密文为准。 */
  use_local_key: boolean;
  max_concurrency: number;
  header_timeout_ms: number | null;
  idle_timeout_ms: number | null;
  probe_requested_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RouteTarget {
  provider: string;
  model: string;
  priority: number;
}

export interface ModelRouteRecord {
  alias: string;
  label: string;
  enabled: boolean;
  is_default: boolean;
  targets: RouteTarget[];
  allow_cross_vendor: boolean;
  default_max_tokens: number;
  updated_at: string;
  // —— 第 66 批（V40）：客户端模型目录的展示与能力字段（只经 GET /v1/models 下发给客户端；网关订阅不带）。缺省值见 modelMetaOf ——
  /** 给律师看的一句说明（如“适合复杂问题”，≤ 60 字）。 */
  description?: string | null;
  /** 排序（小者在前；缺省 100）。 */
  sort?: number;
  /** 深度思考怎么控制：effort = 始终思考、调强度（K3 系列）；toggle = 开 / 关（K2.6）；none = 不可控。 */
  thinking?: ThinkingControl;
  /** effort 型允许的档位。 */
  efforts?: ModelEffort[];
  /** 能力标签（任务入口要求 tool_use）。 */
  capabilities?: ModelCapability[];
  /** 在哪些入口可选：qa = 问答，task = 任务。 */
  scopes?: ModelScope[];
  /** false = 只作内部别名（不出现在客户端选择器、不下发）。 */
  client_visible?: boolean;
  /** 给任务引擎的上下文窗口（token；null = 缺省 262144）。 */
  max_context?: number | null;
}

export type ThinkingControl = "effort" | "toggle" | "none";
export type ModelEffort = "low" | "high" | "max";
export type ModelCapability = "tool_use" | "thinking" | "long_context";
export type ModelScope = "qa" | "task";
export const THINKING_CONTROLS: readonly ThinkingControl[] = ["effort", "toggle", "none"];
export const MODEL_EFFORTS: readonly ModelEffort[] = ["low", "high", "max"];
export const MODEL_CAPABILITIES: readonly ModelCapability[] = ["tool_use", "thinking", "long_context"];
export const MODEL_SCOPES: readonly ModelScope[] = ["qa", "task"];

/** 模型展示与能力的完整取值（缺省已补齐）。 */
export interface ModelMeta {
  label: string;
  description: string | null;
  sort: number;
  thinking: ThinkingControl;
  efforts: ModelEffort[];
  capabilities: ModelCapability[];
  scopes: ModelScope[];
  client_visible: boolean;
  max_context: number | null;
}

/**
 * 内置别名的缺省展示与能力（按第 65 批之前客户端写死的口径）：K3 问答与任务都可选、按强度思考；K2.6 只在问答可选、开关思考
 * （任务里它是子 Agent 的模型，主任务不选它——任务入口只列 scopes 含 task 的）。
 */
export const BUILTIN_MODEL_META: Readonly<Record<string, Omit<ModelMeta, "label"> & { label: string }>> = Object.freeze({
  "legal/k3": { label: "K3", description: "适合复杂问题", sort: 10, thinking: "effort", efforts: ["low", "high", "max"], capabilities: ["tool_use", "thinking", "long_context"], scopes: ["qa", "task"], client_visible: true, max_context: 262_144 },
  "legal/k2.6": { label: "K2.6", description: "更快、更省额度，复杂问题效果略弱", sort: 20, thinking: "toggle", efforts: [], capabilities: ["tool_use", "thinking"], scopes: ["qa"], client_visible: true, max_context: 262_144 },
});
/** 首次部署时内置别名的占位名称（第 44 批）：给律师看时换成 K3 / K2.6。 */
const PLACEHOLDER_LABELS = new Set(["主任务模型", "子任务模型"]);

/** 补齐缺省值后的展示与能力（旧状态里没有这些字段：内置别名按 BUILTIN_MODEL_META，其余按“只在问答可选、不可控思考”）。 */
export function modelMetaOf(m: ModelRouteRecord): ModelMeta {
  const b = BUILTIN_MODEL_META[m.alias];
  return {
    label: b && PLACEHOLDER_LABELS.has(m.label) ? b.label : m.label,
    description: m.description !== undefined ? m.description : (b?.description ?? null),
    sort: m.sort ?? b?.sort ?? 100,
    thinking: m.thinking ?? b?.thinking ?? "none",
    efforts: m.efforts ?? b?.efforts ?? [],
    capabilities: m.capabilities ?? b?.capabilities ?? [],
    scopes: m.scopes ?? b?.scopes ?? ["qa"],
    client_visible: m.client_visible ?? b?.client_visible ?? true,
    max_context: m.max_context !== undefined ? m.max_context : (b?.max_context ?? null),
  };
}

export interface PriceItem {
  input: number | null;
  cached_input: number | null;
  output: number | null;
  cost_input: number | null;
  cost_cached_input: number | null;
  cost_output: number | null;
}

/**
 * 一组单价（第 62 批；元 / 百万 token；null = 未定价）。计费 token 四档互斥、相加等于上游 prompt_tokens + completion_tokens：
 * 未命中输入、缓存命中、缓存写入（按 TTL 分 5 分钟 / 1 小时）、输出（含推理）。缺价的回退：缓存命中价、5 分钟写入价缺 → 按未命中输入价；
 * 1 小时写入价缺 → 按 5 分钟写入价（再缺按未命中输入价）。依据：Kimi 官方定价“K3 系列缓存写入按 TTL 单独计费；缓存命中的输入只按命中价、
 * 不再重复收写入费”，TTL 缺省 5 分钟（请求 prompt_cache_options.ttl = "5m" | "1h"）。
 */
export interface Rates {
  input: number | null;
  cached_input: number | null;
  cache_write: number | null;
  cache_write_1h: number | null;
  output: number | null;
}

/** 按上游真实型号的价目一行（第 62 批）：成本价（缺省取官方价）+ 加价倍率或显式售价。 */
export interface ModelPrice {
  label: string | null;
  cost: Rates;
  /** 成本价来源（官方价写明网址与抓取日期；运营改过写“运营录入”）。 */
  cost_source: string | null;
  /** 按型号覆盖的加价倍率；null = 用整表的 markup。 */
  markup: number | null;
  /** 显式售价（逐项覆盖：给了的项按它，没给的项按 成本 × 倍率）；null = 全按倍率。 */
  sale: Rates | null;
}

export interface PriceTable {
  version: number;
  effective_at: string;
  by: string | null;
  /**
   * 按别名的价目（第 44 批起）。basis = "alias" 的版本（第 62 批之前的全部版本、旧接口 PUT /v1/ops/routing/prices）按它计价；
   * basis = "model" 的版本里它由 models 按各别名的首选目标派生，**只给旧版网关与回滚后的旧版控制面读**，新版不按它计价。
   */
  items: Record<string, PriceItem>;
  /** 第 62 批：计价依据（缺省 = alias，即旧版本）。 */
  basis?: "alias" | "model";
  /** 第 62 批：整表缺省加价倍率（售价 = 成本 × 倍率；缺省 1.0）。 */
  markup?: number;
  /** 第 62 批：按上游真实型号（kimi-k3.1-pro、kimi-k3.1-pro-highspeed…）的价目。 */
  models?: Record<string, ModelPrice>;
  note?: string | null;
}

/** 某次请求实际适用的单价（售价与成本）。 */
export interface EffectiveRates {
  sale: Rates;
  cost: Rates;
  /** 本型号的加价倍率（按别名计价的旧版本为 null）。 */
  markup: number | null;
}

/** 计价结果：按哪种依据、哪个键（上游型号或别名）。 */
export interface PriceResolution {
  basis: "alias" | "model";
  key: string;
  rates: EffectiveRates;
}

/**
 * 官方价（成本价缺省值；第 62 批）。来源：Kimi 开放平台定价页 https://platform.kimi.com/docs/pricing/chat ，2026-11-24 抓取；
 * 元 / 百万 token；K3 系列缓存写入按 TTL 计（5 分钟 = 未命中输入价，1 小时 = 2 倍）；K2 系列没有单列的写入价（上游也不报写入 token）。
 * Batch（60%）本产品不用。K2 系列 2026 年 12 月底下线。运营可在控制台逐项改（改了即记“运营录入”）。
 */
export const OFFICIAL_PRICE_SOURCE = "Kimi 官方定价 https://platform.kimi.com/docs/pricing/chat（2026-11-24 抓取）";
export const OFFICIAL_PRICES: Readonly<Record<string, Readonly<Rates & { label: string }>>> = Object.freeze({
  "kimi-k3.1-pro": { label: "Kimi K3.1 Pro", input: 13, cached_input: 1.3, cache_write: 13, cache_write_1h: 26, output: 68 },
  "kimi-k3.1-pro-highspeed": { label: "Kimi K3.1 Pro 高速", input: 26, cached_input: 1.3, cache_write: 26, cache_write_1h: 52, output: 136 },
  "kimi-k3": { label: "Kimi K3", input: 20, cached_input: 2, cache_write: 20, cache_write_1h: 40, output: 100 },
  "kimi-k2.7-code": { label: "Kimi K2.7 Code", input: 6.5, cached_input: 1.3, cache_write: null, cache_write_1h: null, output: 27 },
  "kimi-k2.7-code-highspeed": { label: "Kimi K2.7 Code 高速", input: 13, cached_input: 2.6, cache_write: null, cache_write_1h: null, output: 54 },
  "kimi-k2.6": { label: "Kimi K2.6", input: 6.5, cached_input: 1.1, cache_write: null, cache_write_1h: null, output: 27 },
});
export const RATE_FIELDS = ["input", "cached_input", "cache_write", "cache_write_1h", "output"] as const;
export const DEFAULT_MARKUP = 1;

export interface ProviderHealth {
  state: "up" | "degraded" | "down" | "blocked_by_allowlist" | "key_unusable" | "disabled";
  latency_ms: number | null;
  last_ok_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
  inflight: number;
  probed_at: string | null;
}

export interface RoutingState {
  version: number;
  updated_at: string;
  updated_by: string | null;
  providers: ProviderRecord[];
  models: ModelRouteRecord[];
  /** 当前价目表在最后；全部历史版本保留（体量小）。 */
  prices: PriceTable[];
  /** 各网关实例最近一次上报的健康（按 holder）。 */
  health: Record<string, { at: string; providers: Record<string, ProviderHealth> }>;
}

export class RoutingError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const BUILTIN_ALIASES = ["legal/k3", "legal/k2.6"] as const;
const PROVIDER_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
const ALIAS_RE = /^[a-z0-9][a-z0-9._/-]{1,47}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,95}$/;
const VENDOR_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const B64U_RE = /^[A-Za-z0-9_-]+$/;
const HOLDER_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const PRICE_FIELDS = ["input", "cached_input", "output", "cost_input", "cost_cached_input", "cost_output"] as const;

const text = (v: unknown, lo: number, hi: number): v is string => typeof v === "string" && v.trim().length >= lo && v.length <= hi;

/** https、不带用户名口令、不带查询与片段；路径保留（如 /v1）。 */
export function validBaseUrl(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 300) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || !u.hostname) return null;
  return u.toString().replace(/\/+$/, "");
}

export function emptyRouting(t: number): RoutingState {
  return { version: 1, updated_at: new Date(t).toISOString(), updated_by: null, providers: [], models: [], prices: [{ version: 1, effective_at: new Date(t).toISOString(), by: null, items: {} }], health: {} };
}

/**
 * 初始路由（控制面首次启动、状态里还没有 routing 时）：按配置 `routing.bootstrap` 导入一个上游（密钥用网关本机文件）与两个内置别名。
 * 没有配置 = 只有内置别名、没有目标（网关用本机兜底上游，直到运营在控制台配好）。
 */
export function bootstrapRouting(t: number, b?: { provider?: { id?: string; label?: string; vendor?: string; base_url?: string }; models?: Record<string, string>; prices?: Record<string, Partial<PriceItem>>; /** 第 62 批：新部署按上游型号、官方价起步（生产入口给）。 */ pricing?: "official" }): RoutingState {
  const r = emptyRouting(t);
  const at = new Date(t).toISOString();
  const p = b?.provider;
  const base = p ? validBaseUrl(p.base_url) : null;
  const pid = p?.id && PROVIDER_ID_RE.test(p.id) ? p.id : "maas";
  if (base) r.providers.push({ id: pid, label: p?.label ?? "中软 MaaS", vendor: p?.vendor && VENDOR_RE.test(p.vendor) ? p.vendor : "csi-maas", base_url: base, enabled: true, key_sealed: null, key_hint: null, key_set_at: null, key_set_by: null, use_local_key: true, max_concurrency: 64, header_timeout_ms: null, idle_timeout_ms: null, probe_requested_at: null, created_at: at, updated_at: at });
  const defaults: Record<string, string> = { "legal/k3": "kimi-k3.1-pro", "legal/k2.6": "kimi-k3.1-pro" };
  for (const alias of BUILTIN_ALIASES) {
    const model = b?.models?.[alias] ?? defaults[alias]!;
    r.models.push({ alias, label: BUILTIN_MODEL_META[alias]!.label, enabled: true, is_default: alias === "legal/k3", targets: base && MODEL_RE.test(model) ? [{ provider: pid, model, priority: 1 }] : [], allow_cross_vendor: false, default_max_tokens: 8192, updated_at: at });
  }
  if (b?.prices) r.prices[0]!.items = validatePrices(b.prices);
  else if (b?.pricing === "official") r.prices[0] = officialPricingTable(r, 1, t);
  return r;
}

export function currentPrices(r: RoutingState): PriceTable {
  return r.prices[r.prices.length - 1]!;
}

export function priceTableOf(r: RoutingState, version: unknown): PriceTable {
  return (typeof version === "number" ? r.prices.find((p) => p.version === version) : undefined) ?? currentPrices(r);
}

const money = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100_000;

export function validatePrices(raw: unknown): Record<string, PriceItem> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new RoutingError(400, "prices_invalid", "价目表须为“别名 → 单价”对象");
  const out: Record<string, PriceItem> = {};
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > 64) throw new RoutingError(400, "prices_invalid", "价目表条目过多");
  for (const [alias, v] of entries) {
    if (!ALIAS_RE.test(alias)) throw new RoutingError(400, "prices_invalid", `别名不合法：${alias.slice(0, 48)}`);
    const x = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
    const item = {} as PriceItem;
    for (const f of PRICE_FIELDS) {
      const n = x[f];
      if (n === undefined || n === null) item[f] = null;
      else if (money(n)) item[f] = Math.round(n * 10_000) / 10_000;
      else throw new RoutingError(400, "prices_invalid", `${alias} 的 ${f} 须为 0–100000 的数（元/百万 token）或留空`);
    }
    // 未单列缓存价的按未缓存价计（上游不打折时如此）；运营可显式填 0 表示免费
    out[alias] = item;
  }
  return out;
}

/**
 * 按金额计费的套餐要用到的别名里，哪些还没有售价（第 56 批，D-222）。
 * 金额额度 = 售价 × 实际用量：未缓存输入价与输出价缺一不可；缓存命中价可以不单列（按未缓存输入价计，chargeOf 同一口径）。
 * models 为 null 表示“全部启用的别名”。停用的别名不算（网关不路由它）。
 * 本函数是按别名的旧口径（items）；按上游型号计价的版本用 unpricedAliasesIn。
 */
export function unpricedAliases(r: Pick<RoutingState, "models">, items: Record<string, PriceItem>, models: readonly string[] | null): string[] {
  const enabled = r.models.filter((m) => m.enabled).map((m) => m.alias);
  const need = models === null ? enabled : models.filter((a) => enabled.includes(a));
  return need.filter((a) => typeof items[a]?.input !== "number" || typeof items[a]?.output !== "number").sort();
}

/**
 * 同上，按一个价目版本判断（第 62 批）：按上游型号计价时，别名的**每一个**目标型号都要有售价——请求可能切到备用目标，
 * 备用目标没价就会按 0 元放行（金额套餐）。
 */
export function unpricedAliasesIn(r: Pick<RoutingState, "models">, table: PriceTable, models: readonly string[] | null): string[] {
  if (table.basis !== "model") return unpricedAliases(r, table.items, models);
  const enabled = r.models.filter((m) => m.enabled);
  const need = models === null ? enabled : enabled.filter((m) => models.includes(m.alias));
  return need
    .filter((m) => m.targets.length === 0 || m.targets.some((x) => !salePriced(table, x.model)))
    .map((m) => m.alias)
    .sort();
}

const salePriced = (table: PriceTable, model: string): boolean => {
  const e = modelRates(table, model);
  return !!e && typeof e.sale.input === "number" && typeof e.sale.output === "number";
};

/** 新价目版本（整表替换；按别名的旧口径——第 62 批起只为旧控制台与旧用例保留，见 setPricing）。 */
export function setPrices(r: RoutingState, items: unknown, t: number, by: string | null): number {
  const table: PriceTable = { version: currentPrices(r).version + 1, effective_at: new Date(t).toISOString(), by, items: validatePrices(items), basis: "alias" };
  pushTable(r, table, t, by);
  return table.version;
}

function pushTable(r: RoutingState, table: PriceTable, t: number, by: string | null): void {
  r.prices.push(table);
  if (r.prices.length > 200) r.prices.splice(0, r.prices.length - 200);
  bump(r, t, by);
}

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
const MARKUP_OK = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0.01 && v <= 100;

function ratesOf(raw: unknown, where: string): Rates {
  const x = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const out = {} as Rates;
  for (const f of RATE_FIELDS) {
    const n = x[f];
    if (n === undefined || n === null) out[f] = null;
    else if (money(n)) out[f] = round4(n);
    else throw new RoutingError(400, "pricing_invalid", `${where} 的 ${f} 须为 0–100000 的数（元/百万 token）或留空`);
  }
  return out;
}

const officialCost = (model: string): Rates | null => {
  const o = OFFICIAL_PRICES[model];
  return o ? { input: o.input, cached_input: o.cached_input, cache_write: o.cache_write, cache_write_1h: o.cache_write_1h, output: o.output } : null;
};

/**
 * 校验按上游型号的价目（第 62 批，PUT /v1/ops/pricing）：{ markup?, note?, models: { 型号: { label?, cost?, cost_source?, markup?, sale? } } }。
 * - cost 不给：官方价表里有的型号取官方价（cost_source 写官方来源与日期），没有的全部留空（未定价）；给了即按给的（逐项，留空 = 未定价）。
 * - sale 不给或 null：售价全按 成本 × 倍率；给了即逐项覆盖（留空的项仍按倍率）。
 * - markup：0.01–100；型号的 markup 留空 = 用整表的。
 */
export function validatePricing(raw: unknown): { markup: number; note: string | null; models: Record<string, ModelPrice> } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new RoutingError(400, "pricing_invalid", "价目须为 { markup, models } 对象");
  const b = raw as Record<string, unknown>;
  const markup = b.markup === undefined || b.markup === null ? DEFAULT_MARKUP : b.markup;
  if (!MARKUP_OK(markup)) throw new RoutingError(400, "pricing_invalid", "加价倍率须为 0.01–100 的数");
  if (b.note !== undefined && b.note !== null && (typeof b.note !== "string" || b.note.length > 200)) throw new RoutingError(400, "pricing_invalid", "说明至多 200 个字符");
  const ms = b.models;
  if (!ms || typeof ms !== "object" || Array.isArray(ms)) throw new RoutingError(400, "pricing_invalid", "models 须为“上游型号 → 价目”对象");
  const entries = Object.entries(ms as Record<string, unknown>);
  if (entries.length > 64) throw new RoutingError(400, "pricing_invalid", "价目条目过多（至多 64 个型号）");
  const models: Record<string, ModelPrice> = {};
  for (const [model, v] of entries) {
    if (!MODEL_RE.test(model)) throw new RoutingError(400, "pricing_invalid", `上游型号不合法：${model.slice(0, 48)}`);
    const x = (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
    if (x.label !== undefined && x.label !== null && !text(x.label, 1, 40)) throw new RoutingError(400, "pricing_invalid", `${model} 的名称须为 1–40 个字符`);
    if (x.markup !== undefined && x.markup !== null && !MARKUP_OK(x.markup)) throw new RoutingError(400, "pricing_invalid", `${model} 的加价倍率须为 0.01–100 的数`);
    if (x.cost_source !== undefined && x.cost_source !== null && !text(x.cost_source, 1, 200)) throw new RoutingError(400, "pricing_invalid", `${model} 的成本来源至多 200 个字符`);
    const off = officialCost(model);
    const cost = x.cost === undefined ? (off ?? ratesOf({}, model)) : ratesOf(x.cost, `${model} 的成本价`);
    const costSource = typeof x.cost_source === "string" ? x.cost_source.trim() : x.cost === undefined ? (off ? OFFICIAL_PRICE_SOURCE : null) : off && RATE_FIELDS.every((f) => cost[f] === off[f]) ? OFFICIAL_PRICE_SOURCE : "运营录入";
    const sale = x.sale === undefined || x.sale === null ? null : ratesOf(x.sale, `${model} 的售价`);
    models[model] = { label: typeof x.label === "string" ? x.label.trim() : (OFFICIAL_PRICES[model]?.label ?? null), cost, cost_source: costSource, markup: typeof x.markup === "number" ? round4(x.markup) : null, sale: sale && RATE_FIELDS.some((f) => sale[f] !== null) ? sale : null };
  }
  return { markup: round4(markup as number), note: typeof b.note === "string" ? b.note : null, models };
}

/** 某型号在某价目版本下的售价与成本（按上游型号计价的版本；没有这一行 = null）。 */
export function modelRates(table: PriceTable, model: string): EffectiveRates | null {
  const mp = table.models?.[model];
  if (!mp) return null;
  const k = mp.markup ?? table.markup ?? DEFAULT_MARKUP;
  const sale = {} as Rates;
  for (const f of RATE_FIELDS) {
    const o = mp.sale?.[f];
    sale[f] = typeof o === "number" ? o : mp.cost[f] === null ? null : round4(mp.cost[f]! * k);
  }
  return { sale, cost: { ...mp.cost }, markup: k };
}

const fromItem = (it: PriceItem): EffectiveRates => ({
  sale: { input: it.input, cached_input: it.cached_input, cache_write: null, cache_write_1h: null, output: it.output },
  cost: { input: it.cost_input, cached_input: it.cost_cached_input, cache_write: null, cache_write_1h: null, output: it.cost_output },
  markup: null,
});

/** 别名的首选目标型号（按当前路由）。 */
export function primaryModelOf(r: Pick<RoutingState, "models">, alias: string | null): string | null {
  const m = alias ? r.models.find((x) => x.alias === alias) : undefined;
  return m && m.targets.length ? [...m.targets].sort((a, b) => a.priority - b.priority)[0]!.model : null;
}

/**
 * 一次请求按哪一行计价（第 62 批）：
 * - 按上游型号的版本：键 = 实际服务的上游型号（网关记录的 upstream_model；没有时取别名当前的首选目标）。别名切到 highspeed，售价与成本跟着型号走。
 * - 按别名的旧版本：键 = 别名（与第 44～61 批相同）。
 * 找不到 = null（未定价）。
 */
export function resolvePrice(table: PriceTable, r: Pick<RoutingState, "models">, alias: string | null, upstreamModel: string | null): PriceResolution | null {
  if (table.basis === "model") {
    const key = upstreamModel ?? primaryModelOf(r, alias);
    const rates = key ? modelRates(table, key) : null;
    return key && rates ? { basis: "model", key, rates } : null;
  }
  const it = alias ? table.items[alias] : undefined;
  return alias && it ? { basis: "alias", key: alias, rates: fromItem(it) } : null;
}

/** 计费 token 明细（第 62 批）：四档互斥，未命中 + 命中 + 写入（5 分钟 + 1 小时）= 上游 prompt_tokens；输出含推理。 */
export interface BilledTokens {
  uncached: number;
  cached: number;
  cache_write_5m: number;
  cache_write_1h: number;
  output: number;
  reasoning: number;
}

const nn = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

/**
 * 上游 usage → 计费明细。usage.input = prompt_tokens（含命中与写入，Kimi Chat Completions 口径：三者之和等于总输入）；
 * cached = 命中；cache_write = 写入总数（prompt_tokens_details.cache_write_tokens），其中 cache_write_1h 为 1 小时 TTL 的部分
 * （响应头 Msh-Usage-Cache-Write-Tokens-1h，或请求带 ttl=1h）。不一致的数按“命中 → 1 小时写入 → 5 分钟写入”依次夹到不超过输入。
 */
export function billedOf(u: { input: number; cached?: number; output: number; reasoning?: number; cache_write?: number; cache_write_1h?: number }): BilledTokens {
  const input = nn(u.input);
  const cached = Math.min(input, nn(u.cached));
  const writes = Math.min(input - cached, nn(u.cache_write));
  const w1h = Math.min(writes, nn(u.cache_write_1h));
  return { uncached: input - cached - writes, cached, cache_write_5m: writes - w1h, cache_write_1h: w1h, output: nn(u.output), reasoning: Math.min(nn(u.reasoning), nn(u.output)) };
}

/**
 * 金额（微元；1 元/百万 token = 1 微元/token）= 未命中 × 输入价 + 命中 × 命中价 + 5 分钟写入 × 写入价 + 1 小时写入 × 1 小时写入价 + 输出 × 输出价。
 * 输入价或输出价缺 = null（未定价）；其余缺价按 Rates 注释回退。
 */
export function amountOf(p: Rates, b: BilledTokens): number | null {
  if (p.input === null || p.output === null) return null;
  const ci = p.cached_input ?? p.input;
  const w5 = p.cache_write ?? p.input;
  const w1 = p.cache_write_1h ?? w5;
  return Math.round(b.uncached * p.input + b.cached * ci + b.cache_write_5m * w5 + b.cache_write_1h * w1 + b.output * p.output);
}

/** 按“这一行”的售价与成本算金额。 */
export function moneyOf(e: EffectiveRates | null | undefined, b: BilledTokens): { value_micro: number | null; cost_micro: number | null } {
  if (!e) return { value_micro: null, cost_micro: null };
  return { value_micro: amountOf(e.sale, b), cost_micro: amountOf(e.cost, b) };
}

/** 别名的全部目标型号（按优先级）。 */
const targetModels = (r: Pick<RoutingState, "models">, alias: string): string[] => [...(r.models.find((m) => m.alias === alias)?.targets ?? [])].sort((a, b) => a.priority - b.priority).map((x) => x.model);

/**
 * 预占用的单价（第 62 批）：按上游型号计价时取别名各目标型号里最贵的一档（逐项取大）——请求可能切到更贵的备用目标；
 * 有目标没定价即 null（金额套餐据此 price_unconfigured，不按 0 元放行）。
 */
export function reserveRates(table: PriceTable, r: Pick<RoutingState, "models">, alias: string): Rates | null {
  if (table.basis !== "model") {
    const it = table.items[alias];
    return it ? fromItem(it).sale : null;
  }
  const ms = targetModels(r, alias);
  if (!ms.length) return null;
  const out: Rates = { input: 0, cached_input: 0, cache_write: 0, cache_write_1h: 0, output: 0 };
  for (const m of ms) {
    const e = modelRates(table, m);
    if (!e || e.sale.input === null || e.sale.output === null) return null;
    for (const f of RATE_FIELDS) out[f] = Math.max(out[f]!, e.sale[f] ?? e.sale.input);
  }
  return out;
}

/** 由按型号的价目派生“按别名”的旧格式（别名 → 首选目标型号的售价与成本），给旧版网关与回滚后的旧版控制面读。 */
export function deriveAliasItems(r: Pick<RoutingState, "models">, table: PriceTable): Record<string, PriceItem> {
  const out: Record<string, PriceItem> = {};
  for (const m of r.models) {
    const model = primaryModelOf(r, m.alias);
    const e = model ? modelRates(table, model) : null;
    if (!e) continue;
    out[m.alias] = { input: e.sale.input, cached_input: e.sale.cached_input, output: e.sale.output, cost_input: e.cost.input, cost_cached_input: e.cost.cached_input, cost_output: e.cost.output };
  }
  return out;
}

/** 新价目版本（按上游型号；整表替换）。 */
export function setPricing(r: RoutingState, raw: unknown, t: number, by: string | null): number {
  const v = validatePricing(raw);
  const table: PriceTable = { version: currentPrices(r).version + 1, effective_at: new Date(t).toISOString(), by, items: {}, basis: "model", markup: v.markup, models: v.models, note: v.note };
  table.items = deriveAliasItems(r, table);
  pushTable(r, table, t, by);
  return table.version;
}

/** 别名改了目标（如切到 highspeed）：当前按型号的版本里派生的旧格式跟着重算（计价本身按型号，不受影响；不产生新版本）。 */
export function syncDerivedItems(r: RoutingState): void {
  const cur = currentPrices(r);
  if (cur.basis === "model") cur.items = deriveAliasItems(r, cur);
}

/**
 * 迁移（第 62 批）：按别名的当前版本 → 按上游型号的新版本。官方价表里的型号成本取官方价；原表里别名的售价落到它的各目标型号上——
 * 与“成本 × 1.0”一致的不另设覆盖（以后别名切换型号即跟着型号的价走）；不一致的记为该型号的显式售价；原表给了成本价的记为该型号的成本（来源“迁移自第 N 版”）。
 * 几个别名指向同一型号而售价不同：以“把它当首选目标”的别名为准，其余写进 note。幂等：当前版本已按型号即不动，返回 null。
 */
export function migratePricingToModels(r: RoutingState, t: number): { from: number; to: number; note: string } | null {
  const cur = currentPrices(r);
  if (cur.basis === "model") return null;
  const models: Record<string, ModelPrice> = {};
  for (const [m, o] of Object.entries(OFFICIAL_PRICES)) models[m] = { label: o.label, cost: officialCost(m)!, cost_source: OFFICIAL_PRICE_SOURCE, markup: null, sale: null };
  const conflicts: string[] = [];
  const owner = new Map<string, string>();
  // 首选目标的别名先占位
  const order = [...r.models].sort((a, b) => Number(BUILTIN_ALIASES.includes(b.alias as never)) - Number(BUILTIN_ALIASES.includes(a.alias as never)));
  for (const pass of ["primary", "other"] as const) {
    for (const m of order) {
      const it = cur.items[m.alias];
      if (!it) continue;
      const all = targetModels(r, m.alias);
      for (const model of pass === "primary" ? all.slice(0, 1) : all.slice(1)) {
        const prev = owner.get(model);
        const e = fromItem(it);
        if (prev) {
          if (prev !== m.alias) conflicts.push(`${m.alias}→${model}（沿用 ${prev} 的价）`);
          continue;
        }
        owner.set(model, m.alias);
        const row = models[model] ?? { label: null, cost: { input: null, cached_input: null, cache_write: null, cache_write_1h: null, output: null }, cost_source: null, markup: null, sale: null };
        if (e.cost.input !== null || e.cost.output !== null) row.cost = { ...row.cost, input: e.cost.input, cached_input: e.cost.cached_input, output: e.cost.output };
        if (e.cost.input !== null || e.cost.output !== null) row.cost_source = `迁移自第 ${cur.version} 版（按别名 ${m.alias}）`;
        const sale: Rates = { input: null, cached_input: null, cache_write: null, cache_write_1h: null, output: null };
        let differs = false;
        // 旧口径：缓存命中价留空 = 按未命中输入价；缓存写入不单列 = 按未命中输入价（与 K3 的 5 分钟写入价同一口径）——迁移后照旧口径记
        const want = { input: e.sale.input, cached_input: e.sale.cached_input ?? e.sale.input, cache_write: e.sale.input, output: e.sale.output };
        for (const f of ["input", "cached_input", "cache_write", "output"] as const) {
          const w = want[f];
          // 写入价没单列（K2 系列）：金额本就按售价的未命中输入价回退，不必另记
          if (w === null || (f === "cache_write" && row.cost.cache_write === null)) continue;
          if (row.cost[f] === null || round4(row.cost[f]!) !== w) {
            sale[f] = w;
            differs = true;
          }
        }
        // 原表只有售价（没有成本）、而这个型号也没有官方价：售价全部显式记下
        if (row.cost.input === null && row.cost.output === null) for (const f of ["input", "cached_input", "cache_write", "output"] as const) sale[f] = want[f];
        row.sale = differs || (row.cost.input === null && row.cost.output === null) ? sale : null;
        models[model] = row;
      }
    }
  }
  const note = `第 62 批迁移：由第 ${cur.version} 版（按别名）转为按上游型号；成本缺省取官方价${conflicts.length ? `；同一型号多个别名售价不同：${conflicts.join("、")}` : ""}`.slice(0, 200);
  const table: PriceTable = { version: cur.version + 1, effective_at: new Date(t).toISOString(), by: "migration:b62", items: {}, basis: "model", markup: DEFAULT_MARKUP, models, note };
  table.items = deriveAliasItems(r, table);
  r.prices.push(table);
  if (r.prices.length > 200) r.prices.splice(0, r.prices.length - 200);
  r.version += 1;
  r.updated_at = new Date(t).toISOString();
  return { from: cur.version, to: table.version, note };
}

/** 新部署（生产入口）的初始价目：按上游型号、官方价、倍率 1.0。 */
export function officialPricingTable(r: Pick<RoutingState, "models">, version: number, t: number): PriceTable {
  const models: Record<string, ModelPrice> = {};
  for (const [m, o] of Object.entries(OFFICIAL_PRICES)) models[m] = { label: o.label, cost: officialCost(m)!, cost_source: OFFICIAL_PRICE_SOURCE, markup: null, sale: null };
  const table: PriceTable = { version, effective_at: new Date(t).toISOString(), by: "bootstrap:official", items: {}, basis: "model", markup: DEFAULT_MARKUP, models, note: "初始价目：成本取官方价，售价 = 成本 × 1.0" };
  table.items = deriveAliasItems(r, table);
  return table;
}

/** 运营视图（第 62 批）：当前版本按型号展开（成本、倍率、售价、生效值、被哪些别名用），另给官方价参考。 */
export function pricingView(r: RoutingState) {
  const cur = currentPrices(r);
  const usedBy = (model: string) => r.models.filter((m) => m.targets.some((x) => x.model === model)).map((m) => ({ alias: m.alias, primary: primaryModelOf(r, m.alias) === model }));
  const referenced = new Set(r.models.flatMap((m) => m.targets.map((x) => x.model)));
  const keys = cur.basis === "model" ? [...new Set([...Object.keys(cur.models ?? {}), ...referenced])] : [...referenced];
  return {
    version: cur.version,
    effective_at: cur.effective_at,
    by: cur.by,
    basis: cur.basis ?? "alias",
    markup: cur.basis === "model" ? (cur.markup ?? DEFAULT_MARKUP) : null,
    note: cur.note ?? null,
    models: keys.sort().map((model) => {
      const mp = cur.models?.[model] ?? null;
      const e = cur.basis === "model" ? modelRates(cur, model) : null;
      return { model, label: mp?.label ?? OFFICIAL_PRICES[model]?.label ?? null, cost: mp?.cost ?? null, cost_source: mp?.cost_source ?? null, markup: mp?.markup ?? null, sale_override: mp?.sale ?? null, effective: e ? { sale: e.sale, cost: e.cost, markup: e.markup } : null, priced: !!e && e.sale.input !== null && e.sale.output !== null, used_by: usedBy(model), official: OFFICIAL_PRICES[model] ? { ...officialCost(model)!, source: OFFICIAL_PRICE_SOURCE } : null };
    }),
    aliases: r.models.map((m) => {
      const model = primaryModelOf(r, m.alias);
      const res = resolvePrice(cur, r, m.alias, null);
      return { alias: m.alias, enabled: m.enabled, primary_model: model, targets: m.targets.map((x) => x.model), effective: res ? { basis: res.basis, key: res.key, sale: res.rates.sale, cost: res.rates.cost } : null };
    }),
    official: { source: OFFICIAL_PRICE_SOURCE, models: Object.fromEntries(Object.keys(OFFICIAL_PRICES).map((m) => [m, { label: OFFICIAL_PRICES[m]!.label, ...officialCost(m)! }])) },
    history: r.prices.map((x) => ({ version: x.version, effective_at: x.effective_at, by: x.by, basis: x.basis ?? "alias", note: x.note ?? null })).reverse(),
  };
}

function bump(r: RoutingState, t: number, by: string | null): void {
  r.version += 1;
  r.updated_at = new Date(t).toISOString();
  r.updated_by = by;
}

function validSealed(v: unknown): SealedKey | null {
  const s = v as Record<string, unknown> | null;
  if (!s || typeof s !== "object") return null;
  if (s.alg !== "ECDH-P256+HKDF-SHA256+A256GCM") return null;
  if (typeof s.kid !== "string" || !/^[0-9a-f]{8,64}$/.test(s.kid)) return null;
  for (const k of ["epk", "iv", "ct"] as const) if (typeof s[k] !== "string" || !B64U_RE.test(s[k] as string) || (s[k] as string).length > 4096) return null;
  // epk 65 字节未压缩点 = 87 位 b64u；iv 12 字节 = 16 位；密文至少含 16 字节标签
  if ((s.epk as string).length !== 87 || (s.iv as string).length !== 16 || (s.ct as string).length < 22) return null;
  return { alg: "ECDH-P256+HKDF-SHA256+A256GCM", kid: s.kid, epk: s.epk as string, iv: s.iv as string, ct: s.ct as string };
}

/** 新增或修改上游；返回是否新建。key_sealed 不给 = 不改密钥；给 null = 清除密文。 */
export function upsertProvider(r: RoutingState, id: string, b: Record<string, unknown>, t: number, by: string | null, keyId: string | null): boolean {
  if (!PROVIDER_ID_RE.test(id)) throw new RoutingError(400, "provider_id_invalid", "上游编号只许小写字母、数字与连字符（2–32 位，字母开头）");
  const at = new Date(t).toISOString();
  const cur = r.providers.find((p) => p.id === id);
  const label = b.label ?? cur?.label;
  if (!text(label, 1, 40)) throw new RoutingError(400, "provider_label_invalid", "上游名称须为 1–40 个字符");
  const vendor = b.vendor ?? cur?.vendor;
  if (typeof vendor !== "string" || !VENDOR_RE.test(vendor)) throw new RoutingError(400, "provider_vendor_invalid", "厂商标识只许小写字母、数字与连字符");
  const base = validBaseUrl(b.base_url ?? cur?.base_url);
  if (!base) throw new RoutingError(400, "provider_base_url_invalid", "地址须为 https，不能带用户名、口令、查询串");
  const enabled = b.enabled === undefined ? (cur?.enabled ?? true) : b.enabled;
  if (typeof enabled !== "boolean") throw new RoutingError(400, "provider_enabled_invalid", "enabled 须为 true 或 false");
  const useLocal = b.use_local_key === undefined ? (cur?.use_local_key ?? false) : b.use_local_key;
  if (typeof useLocal !== "boolean") throw new RoutingError(400, "provider_key_invalid", "use_local_key 须为 true 或 false");
  const intOr = (v: unknown, dflt: number | null, lo: number, hi: number, what: string): number | null => {
    if (v === undefined) return dflt;
    if (v === null) return null;
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < lo || v > hi) throw new RoutingError(400, "provider_param_invalid", `${what}须为 ${lo}–${hi} 的整数`);
    return v;
  };
  const maxc = intOr(b.max_concurrency, cur?.max_concurrency ?? 64, 1, 10_000, "并发上限") ?? 64;
  const hdr = intOr(b.header_timeout_ms, cur?.header_timeout_ms ?? null, 5_000, 900_000, "首包超时（毫秒）");
  const idle = intOr(b.idle_timeout_ms, cur?.idle_timeout_ms ?? null, 5_000, 900_000, "流式间隔超时（毫秒）");
  let sealed = cur?.key_sealed ?? null;
  let hint = cur?.key_hint ?? null;
  let setAt = cur?.key_set_at ?? null;
  let setBy = cur?.key_set_by ?? null;
  if (b.key_sealed !== undefined) {
    if (b.key_sealed === null) {
      sealed = null;
      hint = null;
    } else {
      const s = validSealed(b.key_sealed);
      if (!s) throw new RoutingError(400, "provider_key_invalid", "密钥密文格式不对（须由控制台用网关路由公钥加密）");
      if (keyId && s.kid !== keyId) throw new RoutingError(400, "provider_key_kid_mismatch", "密钥是用另一把网关路由公钥加密的：请刷新控制台配置后重新输入");
      if (typeof b.key_hint !== "string" || !/^…[\x21-\x7e]{1,4}$/.test(b.key_hint)) throw new RoutingError(400, "provider_key_hint_invalid", "密钥尾号格式不对");
      sealed = s;
      hint = b.key_hint;
    }
    setAt = at;
    setBy = by;
  }
  const rec: ProviderRecord = { id, label: (label as string).trim(), vendor, base_url: base, enabled, key_sealed: sealed, key_hint: hint, key_set_at: setAt, key_set_by: setBy, use_local_key: useLocal, max_concurrency: maxc, header_timeout_ms: hdr, idle_timeout_ms: idle, probe_requested_at: cur?.probe_requested_at ?? null, created_at: cur?.created_at ?? at, updated_at: at };
  if (cur) Object.assign(cur, rec);
  else {
    if (r.providers.length >= 32) throw new RoutingError(409, "too_many_providers", "上游过多（至多 32 个）");
    r.providers.push(rec);
  }
  bump(r, t, by);
  return !cur;
}

export function deleteProvider(r: RoutingState, id: string, t: number, by: string | null): void {
  const i = r.providers.findIndex((p) => p.id === id);
  if (i < 0) throw new RoutingError(404, "provider_unknown", "没有这个上游");
  const users = r.models.filter((m) => m.targets.some((x) => x.provider === id)).map((m) => m.alias);
  if (users.length) throw new RoutingError(409, "provider_in_use", `这个上游仍被模型引用：${users.join("、")}`);
  r.providers.splice(i, 1);
  for (const h of Object.values(r.health)) delete h.providers[id];
  bump(r, t, by);
}

export function requestProbe(r: RoutingState, id: string, t: number): string {
  const p = r.providers.find((x) => x.id === id);
  if (!p) throw new RoutingError(404, "provider_unknown", "没有这个上游");
  p.probe_requested_at = new Date(t).toISOString();
  r.version += 1;
  return p.probe_requested_at;
}

export function upsertModel(r: RoutingState, alias: string, b: Record<string, unknown>, t: number, by: string | null): boolean {
  if (!ALIAS_RE.test(alias)) throw new RoutingError(400, "alias_invalid", "别名只许小写字母、数字与 . _ / -（2–48 位）");
  const at = new Date(t).toISOString();
  const cur = r.models.find((m) => m.alias === alias);
  const label = b.label ?? cur?.label;
  if (!text(label, 1, 40)) throw new RoutingError(400, "model_label_invalid", "模型名称须为 1–40 个字符");
  const enabled = b.enabled === undefined ? (cur?.enabled ?? true) : b.enabled;
  const isDefault = b.is_default === undefined ? (cur?.is_default ?? false) : b.is_default;
  const cross = b.allow_cross_vendor === undefined ? (cur?.allow_cross_vendor ?? false) : b.allow_cross_vendor;
  if (typeof enabled !== "boolean" || typeof isDefault !== "boolean" || typeof cross !== "boolean") throw new RoutingError(400, "model_flag_invalid", "启用、默认、跨厂商切换须为 true 或 false");
  const maxTok = b.default_max_tokens === undefined ? (cur?.default_max_tokens ?? 8192) : b.default_max_tokens;
  if (typeof maxTok !== "number" || !Number.isSafeInteger(maxTok) || maxTok < 256 || maxTok > 262_144) throw new RoutingError(400, "model_max_tokens_invalid", "缺省输出上限须为 256–262144 的整数");
  const rawTargets = b.targets ?? cur?.targets ?? [];
  if (!Array.isArray(rawTargets) || rawTargets.length > 4) throw new RoutingError(400, "model_targets_invalid", "目标须为 0–4 个");
  const targets: RouteTarget[] = rawTargets.map((x: any, i: number) => {
    if (!x || typeof x.provider !== "string" || !r.providers.some((p) => p.id === x.provider)) throw new RoutingError(400, "model_targets_invalid", `第 ${i + 1} 个目标的上游不存在`);
    if (typeof x.model !== "string" || !MODEL_RE.test(x.model)) throw new RoutingError(400, "model_targets_invalid", `第 ${i + 1} 个目标的上游型号不合法`);
    const pr = x.priority === undefined ? i + 1 : x.priority;
    if (typeof pr !== "number" || !Number.isSafeInteger(pr) || pr < 1 || pr > 99) throw new RoutingError(400, "model_targets_invalid", "优先级须为 1–99 的整数");
    return { provider: x.provider, model: x.model, priority: pr };
  });
  if (enabled && targets.length === 0) throw new RoutingError(400, "model_targets_invalid", "启用的模型至少要有一个目标");
  // 跨厂商切换须显式打开（“不静默跨供应商”）：目标跨厂商而开关没开 → 拒绝，提示运营确认
  const vendors = new Set(targets.map((x) => r.providers.find((p) => p.id === x.provider)!.vendor));
  if (vendors.size > 1 && !cross) throw new RoutingError(400, "cross_vendor_not_allowed", "目标分属不同厂商：须同时打开“允许跨厂商切换”（并更新对外的数据去向说明）");
  const meta = validateModelMeta(b, cur);
  const rec: ModelRouteRecord = { alias, label: (label as string).trim(), enabled, is_default: isDefault, targets: targets.sort((a, b2) => a.priority - b2.priority), allow_cross_vendor: cross, default_max_tokens: maxTok, updated_at: at, ...meta };
  // 第 66 批：设为缺省时，它要让律师在问答与任务里都能选到（客户端没选时按它发）；事故中停用缺省模型照常允许（客户端按目录改用其他可用模型）
  if (b.is_default === true && (modelMetaOf(rec).client_visible === false || !modelMetaOf(rec).scopes.includes("task"))) throw new RoutingError(400, "model_default_invalid", "缺省模型须对客户端可见、且能在任务入口选（入口勾选“任务”）");
  if (isDefault) for (const m of r.models) if (m.alias !== alias) m.is_default = false;
  if (cur) Object.assign(cur, rec);
  else {
    if (r.models.length >= 32) throw new RoutingError(409, "too_many_models", "模型别名过多（至多 32 个）");
    r.models.push(rec);
  }
  // 第 62 批：计价按型号，别名改目标即跟着型号的价走；给旧版网关的派生格式同步重算
  syncDerivedItems(r);
  bump(r, t, by);
  return !cur;
}

/**
 * 第 66 批：校验模型的展示与能力字段（给了才改，没给沿用当前值；旧记录没有的字段保持未设，读时按 modelMetaOf 补缺省）。
 */
function validateModelMeta(b: Record<string, unknown>, cur: ModelRouteRecord | undefined): Partial<ModelRouteRecord> {
  const out: Partial<ModelRouteRecord> = {};
  const pick = <K extends keyof ModelRouteRecord>(k: K): unknown => (b[k] === undefined ? cur?.[k] : b[k]);
  const desc = pick("description");
  if (desc !== undefined) {
    if (desc !== null && !(typeof desc === "string" && desc.length <= 60)) throw new RoutingError(400, "model_description_invalid", "说明须为至多 60 个字符");
    out.description = desc === null || !(desc as string).trim() ? null : (desc as string).trim();
  }
  const sort = pick("sort");
  if (sort !== undefined) {
    if (typeof sort !== "number" || !Number.isSafeInteger(sort) || sort < 0 || sort > 9999) throw new RoutingError(400, "model_sort_invalid", "排序须为 0–9999 的整数");
    out.sort = sort;
  }
  const thinking = pick("thinking");
  if (thinking !== undefined) {
    if (!(THINKING_CONTROLS as readonly unknown[]).includes(thinking)) throw new RoutingError(400, "model_thinking_invalid", "思考方式须为 effort（调强度）、toggle（开关）或 none（不可控）");
    out.thinking = thinking as ThinkingControl;
  }
  const set = <T extends string>(k: "efforts" | "capabilities" | "scopes", all: readonly T[], msg: string): void => {
    const v = pick(k);
    if (v === undefined) return;
    if (!Array.isArray(v) || v.length > all.length || v.some((x) => !(all as readonly unknown[]).includes(x))) throw new RoutingError(400, `model_${k}_invalid`, msg);
    (out as Record<string, unknown>)[k] = all.filter((x) => v.includes(x));
  };
  set("efforts", MODEL_EFFORTS, "档位只能是 low、high、max");
  set("capabilities", MODEL_CAPABILITIES, "能力只能是 tool_use、thinking、long_context");
  set("scopes", MODEL_SCOPES, "入口只能是 qa（问答）、task（任务）");
  const th = out.thinking ?? cur?.thinking;
  if (th !== undefined && th !== "effort" && (out.efforts ?? []).length > 0) throw new RoutingError(400, "model_efforts_invalid", "只有“调强度”的模型才有档位");
  if ((out.scopes ?? []).includes("task") && out.capabilities !== undefined && !out.capabilities.includes("tool_use")) throw new RoutingError(400, "model_scopes_invalid", "任务入口要求模型支持工具调用（能力勾选 tool_use）");
  const vis = pick("client_visible");
  if (vis !== undefined) {
    if (typeof vis !== "boolean") throw new RoutingError(400, "model_flag_invalid", "客户端可见须为 true 或 false");
    out.client_visible = vis;
  }
  const ctx = pick("max_context");
  if (ctx !== undefined) {
    if (ctx !== null && (typeof ctx !== "number" || !Number.isSafeInteger(ctx) || ctx < 8192 || ctx > 2_000_000)) throw new RoutingError(400, "model_max_context_invalid", "上下文窗口须为 8192–2000000 的整数");
    out.max_context = ctx as number | null;
  }
  return out;
}

/** 客户端模型目录里一项“为什么不可用”。 */
export type CatalogReason = "not_in_plan" | "unpriced" | "no_route" | "disabled";

/** 客户端模型目录的一项（第 66 批）：只有展示与能力字段——绝不含目标、上游、地址、密钥或上游型号。 */
export interface ClientCatalogModel {
  id: string;
  label: string;
  description: string | null;
  sort: number;
  thinking: ThinkingControl;
  efforts: ModelEffort[];
  capabilities: ModelCapability[];
  scopes: ModelScope[];
  max_context: number | null;
  default: boolean;
  available: boolean;
  reason: CatalogReason | null;
}

/**
 * 某个律所的客户端模型目录（签名前的文档，信封 kwl-model-catalog；纯函数）。
 * - 只列对客户端可见的别名（client_visible !== false）；停用的也列、标 disabled（律师记住的选择被停用时界面能说清）；
 * - available = 启用 && 有启用的上游目标（没有目标 = 未配上游、网关用本机兜底，不算缺线路）&& 套餐允许（PlanSpec.models，null = 全部）&& （金额套餐时）每个目标型号都已定价；
 * - version = 路由版本（运营改模型、目标、价目都会升）；同一版本内套餐变化按 issued_at 先后（客户端按 (version, issued_at) 只进不退）。
 */
export function modelCatalogBody(r: RoutingState, plan: { models: readonly string[] | null; quota_unit: "tokens" | "cny" }, t: number, who: { tid: string; uid: string | null }) {
  const table = currentPrices(r);
  const live = new Set(r.providers.filter((p) => p.enabled).map((p) => p.id));
  const def = r.models.find((m) => m.is_default)?.alias ?? "legal/k3";
  const models: ClientCatalogModel[] = r.models
    .map((m) => ({ m, meta: modelMetaOf(m) }))
    .filter(({ meta }) => meta.client_visible)
    .map(({ m, meta }) => {
      let reason: CatalogReason | null = null;
      if (!m.enabled) reason = "disabled";
      // 没有目标的只可能是“首次部署未配上游”的内置别名：网关此时用本机兜底上游，不算没有线路
      else if (m.targets.length > 0 && !m.targets.some((x) => live.has(x.provider))) reason = "no_route";
      else if (plan.models && !plan.models.includes(m.alias)) reason = "not_in_plan";
      else if (plan.quota_unit === "cny" && unpricedAliasesIn(r, table, [m.alias]).length > 0) reason = "unpriced";
      return { id: m.alias, label: meta.label, description: meta.description, sort: meta.sort, thinking: meta.thinking, efforts: [...meta.efforts], capabilities: [...meta.capabilities], scopes: [...meta.scopes], max_context: meta.max_context, default: m.alias === def, available: reason === null, reason };
    })
    .sort((a, b) => a.sort - b.sort || a.id.localeCompare(b.id));
  return { version: r.version, issued_at: new Date(t).toISOString(), tid: who.tid, uid: who.uid, default: def, models };
}

export function deleteModel(r: RoutingState, alias: string, t: number, by: string | null): void {
  if ((BUILTIN_ALIASES as readonly string[]).includes(alias)) throw new RoutingError(409, "builtin_alias", "内置别名不能删除（客户端写死了这个名字），可以停用或改目标");
  const i = r.models.findIndex((m) => m.alias === alias);
  if (i < 0) throw new RoutingError(404, "model_unknown", "没有这个模型别名");
  r.models.splice(i, 1);
  syncDerivedItems(r);
  bump(r, t, by);
}

export function recordHealth(r: RoutingState, body: Record<string, unknown>, t: number): void {
  const holder = body.holder;
  if (typeof holder !== "string" || !HOLDER_RE.test(holder)) throw new RoutingError(400, "holder_invalid", "网关实例标识不合法");
  const ps = body.providers;
  if (!ps || typeof ps !== "object" || Array.isArray(ps)) throw new RoutingError(400, "health_invalid", "健康上报不合法");
  const out: Record<string, ProviderHealth> = {};
  const states = new Set(["up", "degraded", "down", "blocked_by_allowlist", "key_unusable", "disabled"]);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 1e9 ? Math.round(v) : null);
  const str = (v: unknown, n: number) => (typeof v === "string" && v.length <= n ? v : null);
  for (const [id, v] of Object.entries(ps as Record<string, unknown>).slice(0, 64)) {
    if (!PROVIDER_ID_RE.test(id)) continue;
    const h = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
    if (typeof h.state !== "string" || !states.has(h.state)) continue;
    out[id] = {
      state: h.state as ProviderHealth["state"],
      latency_ms: num(h.latency_ms),
      last_ok_at: str(h.last_ok_at, 40),
      // 只收短代码（不收上游原文）
      last_error: typeof h.last_error === "string" && /^[a-z0-9_:.-]{1,64}$/i.test(h.last_error) ? h.last_error : null,
      consecutive_failures: num(h.consecutive_failures) ?? 0,
      inflight: num(h.inflight) ?? 0,
      probed_at: str(h.probed_at, 40),
    };
  }
  r.health[holder] = { at: new Date(t).toISOString(), providers: out };
  // 只留最近 1 小时内上报过的实例（网关重启换了 holder，旧的自然淘汰）
  for (const [k, v] of Object.entries(r.health)) if (Date.parse(v.at) + 3600_000 < t) delete r.health[k];
}

/** 各上游的合并健康：取最近上报的那个实例（多实例时状态最差者优先显示）。 */
export function mergedHealth(r: RoutingState, id: string): (ProviderHealth & { holder: string; updated_at: string }) | null {
  const rank: Record<ProviderHealth["state"], number> = { down: 0, key_unusable: 1, blocked_by_allowlist: 2, degraded: 3, disabled: 4, up: 5 };
  let best: (ProviderHealth & { holder: string; updated_at: string }) | null = null;
  for (const [holder, h] of Object.entries(r.health)) {
    const p = h.providers[id];
    if (!p) continue;
    if (!best || rank[p.state] < rank[best.state] || (rank[p.state] === rank[best.state] && h.at > best.updated_at)) best = { ...p, holder, updated_at: h.at };
  }
  return best;
}

/** 网关订阅（签名前的文档）：不含健康，含密文（只有网关解得开）。 */
export function routingFeedBody(r: RoutingState, t: number) {
  const p = currentPrices(r);
  return {
    version: r.version,
    issued_at: new Date(t).toISOString(),
    providers: r.providers.map((x) => ({ id: x.id, label: x.label, vendor: x.vendor, base_url: x.base_url, enabled: x.enabled, key_sealed: x.key_sealed, key_hint: x.key_hint, use_local_key: x.use_local_key, max_concurrency: x.max_concurrency, header_timeout_ms: x.header_timeout_ms, idle_timeout_ms: x.idle_timeout_ms, probe_requested_at: x.probe_requested_at })),
    models: r.models.map((m) => ({ alias: m.alias, label: m.label, enabled: m.enabled, is_default: m.is_default, targets: m.targets, allow_cross_vendor: m.allow_cross_vendor, default_max_tokens: m.default_max_tokens })),
    // 第 62 批：basis = model 时另给按上游型号的生效价（售价已按倍率算好）；items 是派生的旧格式（旧版网关读它）
    prices: { version: p.version, effective_at: p.effective_at, items: p.items, basis: p.basis ?? "alias", ...(p.basis === "model" ? { models: Object.fromEntries(Object.keys(p.models ?? {}).map((m) => [m, modelRates(p, m)!])) } : {}) },
  };
}

/** 运营视图：不含密文，只给“是否已设”与尾号。 */
export function routingView(r: RoutingState, keyId: string | null) {
  const p = currentPrices(r);
  return {
    version: r.version,
    updated_at: r.updated_at,
    updated_by: r.updated_by,
    routing_key_id: keyId,
    providers: r.providers.map((x) => ({ id: x.id, label: x.label, vendor: x.vendor, base_url: x.base_url, enabled: x.enabled, key_set: x.key_sealed !== null, use_local_key: x.use_local_key, key_hint: x.key_hint, key_set_at: x.key_set_at, max_concurrency: x.max_concurrency, header_timeout_ms: x.header_timeout_ms, idle_timeout_ms: x.idle_timeout_ms, probe_requested_at: x.probe_requested_at, health: mergedHealth(r, x.id) })),
    // 第 66 批：展示与能力字段按缺省补齐后给控制台（旧记录没有这些字段）
    models: r.models.map((m) => ({ ...m, ...modelMetaOf(m), label: m.label, builtin: (BUILTIN_ALIASES as readonly string[]).includes(m.alias) })),
    prices: { version: p.version, effective_at: p.effective_at, items: p.items, basis: p.basis ?? "alias" },
    price_history: r.prices.map((x) => ({ version: x.version, effective_at: x.effective_at, by: x.by, basis: x.basis ?? "alias" })).reverse(),
  };
}

export function migrateRouting(raw: unknown, t: number, bootstrap?: Parameters<typeof bootstrapRouting>[1]): RoutingState {
  const r = raw as RoutingState | undefined;
  if (!r || typeof r !== "object" || !Array.isArray(r.providers) || !Array.isArray(r.models) || !Array.isArray(r.prices) || r.prices.length === 0) return bootstrapRouting(t, bootstrap);
  return { ...r, health: r.health && typeof r.health === "object" ? r.health : {} };
}

/**
 * 一次请求的售价金额与成本（微元：1 元 = 1,000,000；1 元/百万 token = 1 微元/token）。未定价 → null。
 * 缓存输入未单列价的按未缓存输入价计。
 */
export function chargeOf(item: PriceItem | undefined, u: { input: number; cached: number; output: number }): { value_micro: number | null; cost_micro: number | null } {
  return moneyOf(item ? fromItem(item) : null, billedOf(u));
}
