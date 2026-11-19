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
  input: number;
  cached: number;
  output: number;
  reasoning: number;
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

/** 价目（元/百万 token；null = 未定价）。 */
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
  items: Readonly<Record<string, PriceItem>>;
}

/** 售价是否齐（输入与输出都有；缓存输入缺省按输入价）。 */
export function isPriced(item: PriceItem | null | undefined): item is PriceItem & { input: number; output: number } {
  return !!item && typeof item.input === "number" && typeof item.output === "number";
}

/**
 * 把一份 token 用量折成租户的额度单位。tokens：输入 + 输出（缓存 token 已含在输入里）；
 * cny：微元，按售价。cny 而该别名未定价 → null（调用方据此拒绝 `price_unconfigured`）。
 */
export function unitsOf(unit: QuotaUnit, u: { input: number; cached?: number; output: number }, item: PriceItem | null | undefined): number | null {
  const input = Math.max(0, Math.floor(u.input));
  const output = Math.max(0, Math.floor(u.output));
  const cached = Math.min(input, Math.max(0, Math.floor(u.cached ?? 0)));
  if (unit === "tokens") return input + output;
  if (!isPriced(item)) return null;
  const pc = typeof item.cached_input === "number" ? item.cached_input : item.input;
  return Math.max(0, Math.round((input - cached) * item.input + cached * pc + output * item.output));
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

/** 从 OpenAI 兼容的 JSON 或 SSE 文本中取 usage（顶层或 choices[].usage；流式取最后一条带 usage 的 data 行）。 */
export function extractUsage(text: string): { input: number; output: number; cached: number; reasoning: number } | null {
  const pick = (o: any) => {
    const u = o?.usage ?? o?.choices?.find?.((c: any) => c?.usage)?.usage;
    if (!u || typeof u.prompt_tokens !== "number") return null;
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
    return { input: n(u.prompt_tokens), output: n(u.completion_tokens), cached: n(u.prompt_tokens_details?.cached_tokens ?? u.cached_tokens), reasoning: n(u.completion_tokens_details?.reasoning_tokens) };
  };
  const trimmed = text.trim();
  // 非流式：整段是一个 JSON。解析不成功不能就此放弃——流式响应只留最后 64 KiB，截断点恰好落在某个“{”上时
  // 整段看起来也以“{”开头（第 44 批真实验收发现：工具调用参数的流每行有五六个“{”，丢掉末尾那行 usage 就退回了估算）
  if (trimmed.startsWith("{")) {
    try {
      return pick(JSON.parse(trimmed));
    } catch {
      // 落到下面逐行扫
    }
  }
  let found: { input: number; output: number; cached: number; reasoning: number } | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    // SSE 允许“data:”后不带空格
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trimStart();
    if (payload === "[DONE]") continue;
    try {
      found = pick(JSON.parse(payload)) ?? found;
    } catch {
      // 非 JSON 行（或被截断的首行）
    }
  }
  return found;
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
    usage: u ? { input: n(u.input), cached: n(u.cached), output: n(u.output), reasoning: n(u.reasoning) } : null,
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
