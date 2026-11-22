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
}

export interface PriceItem {
  input: number | null;
  cached_input: number | null;
  output: number | null;
  cost_input: number | null;
  cost_cached_input: number | null;
  cost_output: number | null;
}

export interface PriceTable {
  version: number;
  effective_at: string;
  by: string | null;
  items: Record<string, PriceItem>;
}

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
export function bootstrapRouting(t: number, b?: { provider?: { id?: string; label?: string; vendor?: string; base_url?: string }; models?: Record<string, string>; prices?: Record<string, Partial<PriceItem>> }): RoutingState {
  const r = emptyRouting(t);
  const at = new Date(t).toISOString();
  const p = b?.provider;
  const base = p ? validBaseUrl(p.base_url) : null;
  const pid = p?.id && PROVIDER_ID_RE.test(p.id) ? p.id : "maas";
  if (base) r.providers.push({ id: pid, label: p?.label ?? "中软 MaaS", vendor: p?.vendor && VENDOR_RE.test(p.vendor) ? p.vendor : "csi-maas", base_url: base, enabled: true, key_sealed: null, key_hint: null, key_set_at: null, key_set_by: null, use_local_key: true, max_concurrency: 64, header_timeout_ms: null, idle_timeout_ms: null, probe_requested_at: null, created_at: at, updated_at: at });
  const defaults: Record<string, string> = { "legal/k3": "kimi-k3.1-pro", "legal/k2.6": "kimi-k3.1-pro" };
  for (const alias of BUILTIN_ALIASES) {
    const model = b?.models?.[alias] ?? defaults[alias]!;
    r.models.push({ alias, label: alias === "legal/k3" ? "主任务模型" : "子任务模型", enabled: true, is_default: alias === "legal/k3", targets: base && MODEL_RE.test(model) ? [{ provider: pid, model, priority: 1 }] : [], allow_cross_vendor: false, default_max_tokens: 8192, updated_at: at });
  }
  if (b?.prices) r.prices[0]!.items = validatePrices(b.prices);
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
 */
export function unpricedAliases(r: Pick<RoutingState, "models">, items: Record<string, PriceItem>, models: readonly string[] | null): string[] {
  const enabled = r.models.filter((m) => m.enabled).map((m) => m.alias);
  const need = models === null ? enabled : models.filter((a) => enabled.includes(a));
  return need.filter((a) => typeof items[a]?.input !== "number" || typeof items[a]?.output !== "number").sort();
}

/** 新价目版本（整表替换）。 */
export function setPrices(r: RoutingState, items: unknown, t: number, by: string | null): number {
  const table: PriceTable = { version: currentPrices(r).version + 1, effective_at: new Date(t).toISOString(), by, items: validatePrices(items) };
  r.prices.push(table);
  if (r.prices.length > 200) r.prices.splice(0, r.prices.length - 200);
  bump(r, t, by);
  return table.version;
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
  const rec: ModelRouteRecord = { alias, label: (label as string).trim(), enabled, is_default: isDefault, targets: targets.sort((a, b2) => a.priority - b2.priority), allow_cross_vendor: cross, default_max_tokens: maxTok, updated_at: at };
  if (isDefault) for (const m of r.models) if (m.alias !== alias) m.is_default = false;
  if (cur) Object.assign(cur, rec);
  else {
    if (r.models.length >= 32) throw new RoutingError(409, "too_many_models", "模型别名过多（至多 32 个）");
    r.models.push(rec);
  }
  bump(r, t, by);
  return !cur;
}

export function deleteModel(r: RoutingState, alias: string, t: number, by: string | null): void {
  if ((BUILTIN_ALIASES as readonly string[]).includes(alias)) throw new RoutingError(409, "builtin_alias", "内置别名不能删除（客户端写死了这个名字），可以停用或改目标");
  const i = r.models.findIndex((m) => m.alias === alias);
  if (i < 0) throw new RoutingError(404, "model_unknown", "没有这个模型别名");
  r.models.splice(i, 1);
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
    prices: { version: p.version, effective_at: p.effective_at, items: p.items },
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
    models: r.models.map((m) => ({ ...m, builtin: (BUILTIN_ALIASES as readonly string[]).includes(m.alias) })),
    prices: { version: p.version, effective_at: p.effective_at, items: p.items },
    price_history: r.prices.map((x) => ({ version: x.version, effective_at: x.effective_at, by: x.by })).reverse(),
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
  const calc = (pin: number | null, pc: number | null, pout: number | null): number | null => {
    if (pin === null || pout === null) return null;
    const cached = Math.min(Math.max(0, u.cached), u.input);
    return Math.round((u.input - cached) * pin + cached * (pc ?? pin) + u.output * pout);
  };
  if (!item) return { value_micro: null, cost_micro: null };
  return { value_micro: calc(item.input, item.cached_input, item.output), cost_micro: calc(item.cost_input, item.cost_cached_input, item.cost_output) };
}
