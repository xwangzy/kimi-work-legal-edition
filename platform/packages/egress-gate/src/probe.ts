/**
 * 连接检测（第 52 批（第 50 批 IP 部署虚机演练后补）：证书被换、IP 变了、演示 CA 装进正式包时，律师只看到“AI 服务暂时不可用”，IT 分不清是证书问题还是断网）。
 *
 * 在闸门进程里对每个已配置的中软云端上游发一次 `GET /healthz`（各角色入口都应答、不需凭据、不含内容，见 scripts/lib/obs.mjs）：
 *
 * - **与真实流量同一传输策略**：同样的 checkUpstream 判定、同样的 upstreamFetch（证书校验不放宽、TLS ≥ 1.2、同一钉住集、同一演示 CA）——
 *   不绕过、不放宽任何一项；每次检测新建连接（新的 Agent），必然重新握手，不会被复用的旧连接掩盖证书已换；
 * - **不带任何凭据**：不附席位令牌、会话、设备签名，请求体为空；只取状态码，响应体不读；
 * - 结果只有分类、主机（IP 或域名）与端口、耗时，以及钉住值的短前缀（便于 IT 对照，不给全值）。
 */
import { checkUpstream, upstreamFetch, PIN_MISMATCH_CODE, type TransportCheck } from "./tls-policy.ts";
import type { GateUpstreams } from "./types.ts";

export type ProbeUpstream = "control_plane" | "model" | "search" | "dist" | "support" | "notify" | "relay";

export const PROBE_UPSTREAMS: readonly ProbeUpstream[] = ["control_plane", "model", "search", "dist", "support", "notify", "relay"];

/**
 * 检测分类：ok | unreachable | timeout | tls_verify_failed | tls_pin_mismatch | tls_name_mismatch（证书里没有这个 IP/域名）|
 * http_<状态码> | http_redirect（拒绝跟随）| config_invalid（这个安装包的地址或钉住配置本身不合格，detail 写原因码）| not_configured。
 */
export type ProbeClass =
  | "ok"
  | "unreachable"
  | "timeout"
  | "tls_verify_failed"
  | "tls_pin_mismatch"
  | "tls_name_mismatch"
  | `http_${number}`
  | "http_redirect"
  | "config_invalid"
  | "not_configured";

export interface ProbeItem {
  upstream: ProbeUpstream;
  class: ProbeClass;
  /** 地址里的主机：IP 或域名（未配置为 null）。 */
  host: string | null;
  port: number | null;
  elapsed_ms: number;
  /** config_invalid 的原因码（upstream_tls_required / upstream_pins_missing / upstream_pins_malformed / upstream_url_invalid ……）；其余为 null。 */
  detail: string | null;
  /** 内置钉住集的条数与短前缀（只给前 12 个字符，不给全值）。 */
  pins: string[];
  /** 是否附了中软演示 CA（偏离 D-212：只应出现在测试包）。 */
  cloud_ca: boolean;
  /** 钉住不符时，服务器实际出示的证书链公钥短前缀（便于 IT 对照是否换了密钥）。 */
  presented: string[];
}

/** 钉住值的短前缀：`sha256/` 后 12 个字符加省略号。 */
export function pinPrefix(pin: string): string {
  const m = /^sha256\/(.{12})/.exec(pin);
  return m ? `sha256/${m[1]}…` : "…";
}

/** fetch 失败 → 检测分类（比去向记录的 transportFailureReason 细：另分出主机名不符、超时、拒绝重定向）。纯函数。 */
export function probeFailureClass(e: unknown, timedOut: boolean): { cls: ProbeClass; presented: string[] } {
  if (timedOut) return { cls: "timeout", presented: [] };
  const seen = new Set<unknown>();
  let c: unknown = e;
  let fallback: ProbeClass = "unreachable";
  while (c && typeof c === "object" && !seen.has(c)) {
    seen.add(c);
    const code = (c as { code?: unknown }).code;
    if (code === PIN_MISMATCH_CODE) {
      const p = (c as { presentedPins?: unknown }).presentedPins;
      return { cls: "tls_pin_mismatch", presented: Array.isArray(p) ? p.filter((x): x is string => typeof x === "string").slice(0, 3).map(pinPrefix) : [] };
    }
    if (code === "ERR_TLS_CERT_ALTNAME_INVALID") return { cls: "tls_name_mismatch", presented: [] };
    if (typeof code === "string" && /^(?:CERT_|UNABLE_TO_|DEPTH_ZERO|SELF_SIGNED|ERR_TLS_CERT|ERR_SSL|ERR_TLS)/.test(code)) return { cls: "tls_verify_failed", presented: [] };
    if (code === "UND_ERR_CONNECT_TIMEOUT" || code === "ETIMEDOUT" || code === "UND_ERR_HEADERS_TIMEOUT") fallback = "timeout";
    if (/redirect/i.test(String((c as { message?: unknown }).message ?? ""))) return { cls: "http_redirect", presented: [] };
    c = (c as { cause?: unknown }).cause;
  }
  return { cls: fallback, presented: [] };
}

interface Target {
  upstream: ProbeUpstream;
  baseUrl: string | null;
  pins: readonly string[];
  requirePins: boolean;
}

function targetsOf(u: GateUpstreams): Target[] {
  const req = u.tls?.requirePins ?? false;
  return [
    { upstream: "control_plane", baseUrl: u.controlPlane?.baseUrl ?? null, pins: u.controlPlane?.pins ?? [], requirePins: req },
    { upstream: "model", baseUrl: u.model?.baseUrl ?? null, pins: u.model?.pins ?? [], requirePins: req },
    { upstream: "search", baseUrl: u.search?.baseUrl ?? null, pins: u.search?.pins ?? [], requirePins: req },
    { upstream: "dist", baseUrl: u.dist?.baseUrl ?? null, pins: u.dist?.pins ?? [], requirePins: req },
    { upstream: "support", baseUrl: u.support?.baseUrl ?? null, pins: u.support?.pins ?? [], requirePins: req },
    { upstream: "notify", baseUrl: u.notify?.baseUrl ?? null, pins: u.notify?.pins ?? [], requirePins: req },
    { upstream: "relay", baseUrl: u.relay?.baseUrl ?? null, pins: u.relay?.pins ?? [], requirePins: req },
  ];
}

function hostPort(raw: string): { host: string | null; port: number | null } {
  try {
    const u = new URL(raw);
    const host = u.hostname.replace(/^\[|\]$/g, "");
    return { host, port: u.port ? Number(u.port) : u.protocol === "https:" ? 443 : u.protocol === "http:" ? 80 : null };
  } catch {
    return { host: null, port: null };
  }
}

/** 检测一个上游（transport 与 fetchImpl 由调用方按真实流量的同一策略构造；测试可替换 fetchImpl）。 */
export async function probeOne(
  t: { upstream: ProbeUpstream; baseUrl: string | null; pins: readonly string[]; cloudCa: boolean },
  transport: TransportCheck,
  fetchImpl: typeof fetch,
  timeoutMs = 8_000,
): Promise<ProbeItem> {
  const base = { upstream: t.upstream, pins: t.pins.map(pinPrefix), cloud_ca: t.cloudCa, presented: [] as string[] };
  if (!t.baseUrl || transport.state === "none") return { ...base, class: "not_configured", host: null, port: null, elapsed_ms: 0, detail: null };
  const hp = hostPort(t.baseUrl);
  if (transport.state === "invalid") return { ...base, ...hp, class: "config_invalid", elapsed_ms: 0, detail: transport.reason ?? "upstream_tls_required" };
  let url: string;
  try {
    // 各角色入口在根路径应答 /healthz（地址里带 /v1 之类的前缀也一样）
    url = new URL("/healthz", t.baseUrl).toString();
  } catch {
    return { ...base, ...hp, class: "config_invalid", elapsed_ms: 0, detail: "upstream_url_invalid" };
  }
  const started = Date.now();
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, timeoutMs);
  try {
    const r = await fetchImpl(url, { method: "GET", redirect: "error", signal: ac.signal });
    // 只要状态码：响应体不读、直接丢弃
    await r.body?.cancel().catch(() => {});
    const cls: ProbeClass = r.status >= 200 && r.status < 300 ? "ok" : `http_${r.status}`;
    return { ...base, ...hp, class: cls, elapsed_ms: Date.now() - started, detail: null };
  } catch (e) {
    const f = probeFailureClass(e, timedOut);
    return { ...base, ...hp, class: f.cls, elapsed_ms: Date.now() - started, detail: null, presented: f.presented };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 检测全部中软云端上游（并发）。传输判定与请求实现与闸门真实流量相同：checkUpstream（同一 tls 策略）+ upstreamFetch（同一钉住集、同一演示 CA）。
 * `fetchFor` 只给测试替换；产品形态一律按上游新建 upstreamFetch（新连接、重新握手）。
 */
export async function probeUpstreams(u: GateUpstreams, o: { timeoutMs?: number; fetchFor?: (t: { pins: readonly string[]; caPem: string | null }) => typeof fetch } = {}): Promise<ProbeItem[]> {
  const tls = u.tls ?? { allowLoopbackHttp: true, requirePins: false };
  const caPem = u.cloudCaPem ?? null;
  const mkFetch = o.fetchFor ?? ((x: { pins: readonly string[]; caPem: string | null }) => upstreamFetch({ pins: x.pins, caPem: x.caPem }));
  return Promise.all(
    targetsOf(u).map((t) => {
      const transport = checkUpstream(t.baseUrl, { allowLoopbackHttp: tls.allowLoopbackHttp, pins: t.pins, requirePins: t.requirePins });
      return probeOne({ upstream: t.upstream, baseUrl: t.baseUrl, pins: t.pins, cloudCa: !!caPem }, transport, mkFetch({ pins: t.pins, caPem }), o.timeoutMs);
    }),
  );
}
