/**
 * 逐请求用量记录与计量单位（V19 第 44 批，主文 §4.1–4.2）。
 *
 * - 一把尺子：额度单位只有两种——`tokens`（上游 usage 原样：输入 + 输出）与 `cny`（按路由订阅里该别名的售价 × 实际 usage，
 *   内部整数微元；1 元/百万 token = 1 微元/token，所以 charge = round((输入−缓存)·p_in + 缓存·p_cached + 输出·p_out)）。
 * - 网关算出的 charge_units 只用于本地扣减租约余量；控制面结算时按同一价目版本重算、按 request_id 去重入账。
 * - 记录只有编号、token 数与状态：不含正文、错误体、上游密钥。
 */

export type QuotaUnit = "tokens" | "cny";

export interface UsageTokens {
  /** 上游 prompt_tokens（Kimi Chat Completions 口径：含缓存命中与缓存写入，三者之和 = 总输入）。 */
  input: number;
  /** 缓存命中（prompt_tokens_details.cached_tokens，旧版顶层 cached_tokens）。 */
  cached: number;
  /** completion_tokens（含推理）。 */
  output: number;
  reasoning: number;
  /** 第 62 批：缓存写入总数（prompt_tokens_details.cache_write_tokens）；为 0 时不带这个字段。 */
  cache_write?: number;
  /** 第 62 批：其中 1 小时 TTL 的写入（响应头 Msh-Usage-Cache-Write-Tokens-1h，或请求 prompt_cache_options.ttl = "1h"）；为 0 时不带。 */
  cache_write_1h?: number;
}

export type UsageOutcome = "ok" | "client_gone" | "upstream_error" | "timeout" | "blocked";
export type UsageSource = "upstream" | "drained" | "estimated" | "none";

export interface UsageAttempt {
  provider: string;
  /** 上游 HTTP 状态；连接失败、头超时为 null。 */
  status: number | null;
  /** 短代码（connect / header_timeout / upstream_503 …），不含上游正文。 */
  error: string | null;
  ms: number;
}

/** 逐请求记录（网关 → 控制面 settle；也整条写进 meter.jsonl 的 settle 行，作发件箱）。 */
export interface UsageRecord {
  request_id: string;
  client_request_id: string | null;
  upstream_request_id: string | null;
  started_at: string;
  at: string;
  tid: string;
  sid: string;
  uid: string;
  dev: string;
  alias: string;
  provider: string | null;
  upstream_model: string | null;
  stream: boolean;
  qa: boolean;
  status: number | null;
  outcome: UsageOutcome;
  usage: UsageTokens | null;
  usage_source: UsageSource;
  reserved_units: number;
  charge_units: number;
  latency_ms: number;
  attempts: UsageAttempt[];
  finish_reason: string | null;
  lease_id: string | null;
  /** 网关算 charge_units 用的价目版本（路由订阅的 prices.version；兜底时取租约应答的 price_version）：控制面按它重算。 */
  price_version: number | string | null;
  /** 第 46 批：流式已转发部分内容后上游出错或超时——usage 为估算，不扣律师额度，控制面只记成本。 */
  partial?: boolean;
}

/** 一组单价（第 62 批；元/百万 token；null = 未定价；缺价回退同控制面 routing.ts Rates）。 */
export interface Rates {
  input: number | null;
  cached_input: number | null;
  cache_write: number | null;
  cache_write_1h: number | null;
  output: number | null;
}

/** 价目（按别名的旧格式；元/百万 token；null = 未定价）。 */
export interface PriceItem {
  input: number | null;
  cached_input: number | null;
  output: number | null;
  cost_input: number | null;
  cost_cached_input: number | null;
  cost_output: number | null;
}

export interface PriceTable {
  version: number | string;
  effective_at: string | null;
  /** 按别名（第 44 批起；第 62 批起在 basis = model 的版本里是派生的旧格式，新版网关不按它计价）。 */
  items: Readonly<Record<string, PriceItem>>;
  /** 第 62 批：计价依据（缺省 alias = 旧版控制面）。 */
  basis?: "alias" | "model";
  /** 第 62 批：按上游真实型号的生效售价与成本（控制面已按加价倍率算好）。 */
  models?: Readonly<Record<string, { sale: Rates; cost: Rates }>>;
}

/** 售价是否齐（输入与输出都有；缓存输入缺省按输入价）。 */
export function isPriced(item: PriceItem | Rates | null | undefined): item is (PriceItem | Rates) & { input: number; output: number } {
  return !!item && typeof item.input === "number" && typeof item.output === "number";
}

/** 旧格式（别名）→ 售价 Rates。 */
export const itemRates = (it: PriceItem): Rates => ({ input: it.input, cached_input: it.cached_input, cache_write: null, cache_write_1h: null, output: it.output });

/** 某次请求的售价（第 62 批）：按型号的版本取实际服务的上游型号；按别名的旧版本取别名。找不到 = null（未定价）。 */
export function saleRatesFor(prices: PriceTable | null | undefined, alias: string, model: string | null): Rates | null {
  if (!prices) return null;
  if (prices.basis === "model" && prices.models) return model ? (prices.models[model]?.sale ?? null) : null;
  const it = prices.items[alias];
  return it ? itemRates(it) : null;
}

/** 预占用的售价：别名各候选型号里逐项取最贵（请求可能切到更贵的备用目标）；有候选没定价即 null。 */
export function reserveRatesFor(prices: PriceTable | null | undefined, alias: string, models: readonly string[]): Rates | null {
  if (!prices) return null;
  if (prices.basis !== "model" || !prices.models) return saleRatesFor(prices, alias, null);
  if (!models.length) return null;
  const out: Rates = { input: 0, cached_input: 0, cache_write: 0, cache_write_1h: 0, output: 0 };
  for (const m of models) {
    const r = prices.models[m]?.sale;
    if (!isPriced(r)) return null;
    for (const f of ["input", "cached_input", "cache_write", "cache_write_1h", "output"] as const) out[f] = Math.max(out[f]!, r[f] ?? r.input);
  }
  return out;
}

/** 计费 token 明细（与控制面 routing.ts billedOf 同一口径：未命中 + 命中 + 5 分钟写入 + 1 小时写入 = prompt_tokens）。 */
export function billedTokens(u: { input: number; cached?: number; output: number; cache_write?: number; cache_write_1h?: number }) {
  const nn = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  const input = nn(u.input);
  const cached = Math.min(input, nn(u.cached));
  const writes = Math.min(input - cached, nn(u.cache_write));
  const w1h = Math.min(writes, nn(u.cache_write_1h));
  return { uncached: input - cached - writes, cached, cache_write_5m: writes - w1h, cache_write_1h: w1h, output: nn(u.output) };
}

/**
 * 把一份 token 用量折成租户的额度单位。tokens：输入 + 输出（缓存 token 已含在输入里）；
 * cny：微元，按售价（第 62 批：未命中、命中、5 分钟写入、1 小时写入、输出五档；缺价回退同控制面）。cny 而未定价 → null（调用方据此拒绝 `price_unconfigured`）。
 */
export function unitsOf(unit: QuotaUnit, u: { input: number; cached?: number; output: number; cache_write?: number; cache_write_1h?: number }, price: PriceItem | Rates | null | undefined): number | null {
  const b = billedTokens(u);
  if (unit === "tokens") return b.uncached + b.cached + b.cache_write_5m + b.cache_write_1h + b.output;
  if (!isPriced(price)) return null;
  const p: Rates = "cache_write" in price ? price : itemRates(price);
  const ci = p.cached_input ?? p.input!;
  const w5 = p.cache_write ?? p.input!;
  const w1 = p.cache_write_1h ?? w5;
  return Math.max(0, Math.round(b.uncached * p.input! + b.cached * ci + b.cache_write_5m * w5 + b.cache_write_1h * w1 + b.output * p.output!));
}

/** 预占用的输入估算：`JSON.stringify({messages, tools})` 的长度 / 2（工具定义也算进输入）。 */
export function estimateInputTokens(body: Record<string, unknown>): number {
  return Math.ceil(JSON.stringify({ messages: body.messages, tools: body.tools }).length / 2);
}

/** 预占用的输出估算：max_tokens → max_completion_tokens → 别名的 default_max_tokens。 */
export function estimateOutputTokens(body: Record<string, unknown>, defaultMaxTokens: number): number {
  const pick = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : null);
  return pick(body.max_tokens) ?? pick(body.max_completion_tokens) ?? defaultMaxTokens;
}

type ParsedUsage = { input: number; output: number; cached: number; reasoning: number; cache_write?: number };

/**
 * 一个 OpenAI 兼容响应对象里的 usage（顶层或 choices[].usage——Kimi 流式在带 finish_reason 的那块的 choices[0].usage 里给一次，
 * 随后一块顶层再给一次；第 62 批起另认 prompt_tokens_details.cache_write_tokens）。没有 prompt_tokens 的不采信。
 */
export function usageFromObject(o: any): ParsedUsage | null {
  const u = o?.usage ?? (Array.isArray(o?.choices) ? o.choices.find((c: any) => c?.usage)?.usage : undefined);
  if (!u || typeof u.prompt_tokens !== "number") return null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  const cw = n(u.prompt_tokens_details?.cache_write_tokens);
  return { input: n(u.prompt_tokens), output: n(u.completion_tokens), cached: n(u.prompt_tokens_details?.cached_tokens ?? u.cached_tokens), reasoning: n(u.completion_tokens_details?.reasoning_tokens), ...(cw > 0 ? { cache_write: cw } : {}) };
}

/** 文本里最后一个能解析的 "usage": {…} 对象（括号配对、跳过字符串）——非流式响应只留尾部、开头被截断时用（第 62 批）。 */
function lastUsageObject(text: string): ParsedUsage | null {
  let at = text.length;
  for (let tries = 0; tries < 8; tries++) {
    const k = text.lastIndexOf('"usage"', at - 1);
    if (k < 0) return null;
    at = k;
    const open = text.indexOf("{", k + 7);
    if (open < 0 || !/^\s*:\s*$/.test(text.slice(k + 7, open))) continue;
    let depth = 0;
    let inStr = false;
    for (let i = open; i < text.length; i++) {
      const c = text[i]!;
      if (inStr) {
        if (c === "\\") i += 1;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "{") depth += 1;
      else if (c === "}" && --depth === 0) {
        try {
          const u = usageFromObject({ usage: JSON.parse(text.slice(open, i + 1)) });
          if (u) return u;
        } catch {
          // 不是完整对象：再往前找
        }
        break;
      }
    }
  }
  return null;
}

/** 从 OpenAI 兼容的 JSON 或 SSE 文本中取 usage（顶层或 choices[].usage；流式取最后一条带 usage 的 data 行）。 */
export function extractUsage(text: string): ParsedUsage | null {
  const trimmed = text.trim();
  // 非流式：整段是一个 JSON。解析不成功不能就此放弃——流式响应只留最后 64 KiB，截断点恰好落在某个“{”上时
  // 整段看起来也以“{”开头（第 44 批真实验收发现：工具调用参数的流每行有五六个“{”，丢掉末尾那行 usage 就退回了估算）
  if (trimmed.startsWith("{")) {
    try {
      return usageFromObject(JSON.parse(trimmed));
    } catch {
      // 落到下面逐行扫
    }
  }
  let found: ParsedUsage | null = null;
  let sse = false;
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    // SSE 允许“data:”后不带空格
    if (!line.startsWith("data:")) continue;
    sse = true;
    const payload = line.slice(5).trimStart();
    if (payload === "[DONE]") continue;
    try {
      found = usageFromObject(JSON.parse(payload)) ?? found;
    } catch {
      // 非 JSON 行（或被截断的首行）
    }
  }
  // 第 62 批：非流式的大响应（> 64 KiB）只留了尾部、开头被截断——整段解析不了、也没有 data 行：按括号配对找最后一个 usage 对象
  // （改前这种响应一律退回估算：长文书非流式输出拿不到真实 usage）
  return found ?? (sse ? null : lastUsageObject(text));
}

/**
 * 流式全程取 usage（第 62 批；MaaS 账单核查的教训：只看末块顶层 usage、或只看尾部窗口，会漏掉 choices[].usage 与“usage 之后还有大块”的情形）：
 * 逐行看每一条 data 行，凡带 usage 的都解析，留最后一个。只缓存当前这一行（超过 1 MiB 的行丢弃——usage 行很短）。
 */
export class UsageTap {
  private parts: string[] = [];
  private len = 0;
  private skipping = false;
  usage: ParsedUsage | null = null;
  /** 见过的带 usage 的块数（诊断）。 */
  seen = 0;
  feed(piece: string): void {
    let start = 0;
    for (;;) {
      const nl = piece.indexOf("\n", start);
      if (nl < 0) {
        if (!this.skipping && start < piece.length) {
          const rest = piece.slice(start);
          this.parts.push(rest);
          this.len += rest.length;
          if (this.len > 1 << 20) {
            this.skipping = true;
            this.parts = [];
            this.len = 0;
          }
        }
        return;
      }
      if (!this.skipping) {
        this.parts.push(piece.slice(start, nl));
        this.line(this.parts.join(""));
      }
      this.parts = [];
      this.len = 0;
      this.skipping = false;
      start = nl + 1;
    }
  }
  /** 流结束：最后一行没有换行也要看。 */
  end(): ParsedUsage | null {
    if (!this.skipping && this.parts.length) this.line(this.parts.join(""));
    this.parts = [];
    this.len = 0;
    return this.usage;
  }
  private line(raw: string): void {
    const line = raw.trimEnd();
    if (!line.startsWith("data:") || !line.includes('"usage"')) return;
    try {
      const u = usageFromObject(JSON.parse(line.slice(5).trimStart()));
      if (u) {
        this.usage = u;
        this.seen += 1;
      }
    } catch {
      // 非 JSON
    }
  }
}

/** 响应头里的缓存写入按 TTL 拆分（Msh-Usage-Cache-Write-Tokens-5m / -1h）；没有或形状不对 = null。 */
export function cacheWriteHeaders(h: Readonly<Record<string, string>>): { w5m: number; w1h: number } | null {
  const n = (v: string | undefined) => (typeof v === "string" && /^\d{1,12}$/.test(v.trim()) ? Number(v.trim()) : null);
  const a = n(h["msh-usage-cache-write-tokens-5m"]);
  const b = n(h["msh-usage-cache-write-tokens-1h"]);
  return a === null && b === null ? null : { w5m: a ?? 0, w1h: b ?? 0 };
}

/** 请求要的缓存 TTL（Kimi：prompt_cache_options.ttl = "5m" | "1h"，缺省 5m）。 */
export function requestedCacheTtl(body: Record<string, unknown>): "5m" | "1h" {
  const o = body.prompt_cache_options as { ttl?: unknown } | undefined;
  return o && typeof o === "object" && o.ttl === "1h" ? "1h" : "5m";
}

/** 响应尾部最后一个 finish_reason（流式取最后一个非空值；非流式取第一个选择）。 */
export function extractFinishReason(text: string): string | null {
  let found: string | null = null;
  for (const m of text.matchAll(/"finish_reason"\s*:\s*"([a-z_]{1,32})"/g)) found = m[1]!;
  return found;
}

const UPSTREAM_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

/** 上游请求编号：响应头 x-oneapi-request-id → x-request-id → 响应体（或首个 SSE 块）的 id；形状不对的不采信。 */
export function upstreamRequestIdOf(headers: Readonly<Record<string, string>>, head: string): string | null {
  for (const k of ["x-oneapi-request-id", "x-request-id"]) {
    const v = headers[k];
    if (typeof v === "string" && UPSTREAM_ID_RE.test(v)) return v;
  }
  const m = /"id"\s*:\s*"([^"\\]{1,128})"/.exec(head);
  return m && UPSTREAM_ID_RE.test(m[1]!) ? m[1]! : null;
}

const OUTCOMES: readonly UsageOutcome[] = ["ok", "client_gone", "upstream_error", "timeout", "blocked"];
const SOURCES: readonly UsageSource[] = ["upstream", "drained", "estimated", "none"];

/** 按白名单重建一条记录（落盘与外送前都过一遍：调用方误塞的字段不会出去）。 */
export function cleanUsageRecord(r: UsageRecord): UsageRecord {
  const s = (v: unknown, max = 200): string | null => (typeof v === "string" ? v.slice(0, max) : null);
  const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const ni = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const u = r.usage;
  return {
    request_id: String(r.request_id),
    client_request_id: s(r.client_request_id, 96),
    upstream_request_id: s(r.upstream_request_id, 128),
    started_at: String(r.started_at),
    at: String(r.at),
    tid: String(r.tid),
    sid: String(r.sid),
    uid: String(r.uid ?? ""),
    dev: String(r.dev ?? ""),
    alias: String(r.alias),
    provider: s(r.provider, 32),
    upstream_model: s(r.upstream_model, 128),
    stream: r.stream === true,
    qa: r.qa === true,
    status: ni(r.status),
    outcome: OUTCOMES.includes(r.outcome) ? r.outcome : "upstream_error",
    usage: u ? { input: n(u.input), cached: n(u.cached), output: n(u.output), reasoning: n(u.reasoning), ...(n(u.cache_write) > 0 ? { cache_write: n(u.cache_write) } : {}), ...(n(u.cache_write_1h) > 0 ? { cache_write_1h: n(u.cache_write_1h) } : {}) } : null,
    usage_source: SOURCES.includes(r.usage_source) ? r.usage_source : "none",
    reserved_units: n(r.reserved_units),
    charge_units: n(r.charge_units),
    latency_ms: n(r.latency_ms),
    attempts: (Array.isArray(r.attempts) ? r.attempts : []).slice(0, 8).map((a) => ({ provider: String(a?.provider ?? "").slice(0, 32), status: ni(a?.status), error: s(a?.error, 48), ms: n(a?.ms) })),
    finish_reason: s(r.finish_reason, 32),
    lease_id: s(r.lease_id, 96),
    price_version: typeof r.price_version === "number" && Number.isFinite(r.price_version) ? r.price_version : s(r.price_version, 64),
    ...(r.partial === true ? { partial: true } : {}),
  };
}
