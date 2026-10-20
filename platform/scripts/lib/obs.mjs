/**
 * 云端服务的可观测性（v9.3 A-9；Y2 §6.1“只计量不留内容”、§6.2 首批指标；评审 Z4 P0-8“云端零可观测”）。生产入口 cloud-serve.mjs 用它包住每个服务：
 *
 * - 访问日志：每个请求一行 JSON，**按白名单重建再写**——时刻、角色、方法、路径（去掉查询串，至多 200 字）、状态码、耗时、闸门请求编号（形状合格才记）、
 *   来源地址网段（IPv4 /24、IPv6 /48）。不记查询串、请求头（含 authorization、x-kwl-sig）、请求体与响应体。按天分文件，超过保留期的删除。
 * - 错误日志：进程级未处理异常只记错误代码与类别，不记异常消息（消息里可能有用户输入）。
 * - 健康检查：/healthz（进程活着）、/readyz（控制面以外的角色：吊销集在 2 分钟内取到过；控制面：就绪）——不需凭据，不含任何内容。
 * - 指标：Prometheus 文本格式，只在单独的监听上给（缺省只听本机回环；监听其他地址须带令牌），内容只有计数与耗时。
 *
 * 本模块只用 Node 标准库，不发起任何网络连接。
 */
import { appendFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";
import { join } from "node:path";

/** 访问日志的字段（白名单；测试按这张表核对落盘的每一行）。 */
export const ACCESS_FIELDS = ["at", "role", "method", "path", "status", "latency_ms", "client_request_id", "net"];
/** 错误日志的字段。 */
export const ERROR_FIELDS = ["at", "role", "kind", "code"];
const BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];
const FEED_STALE_MS = 120_000;
const METHODS = new Set(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]);

/** 来源地址只留网段：IPv4 /24、IPv6 /48；IPv4 映射的 IPv6 按 IPv4 处理；认不出的记 null。 */
export function netOf(addr) {
  const a = String(addr ?? "").replace(/^::ffff:/i, "");
  if (isIPv4(a)) return `${a.split(".").slice(0, 3).join(".")}.0/24`;
  if (isIPv6(a)) {
    const full = expandV6(a);
    return full ? `${full.slice(0, 3).join(":")}::/48` : null;
  }
  return null;
}

function expandV6(a) {
  const [head, tail] = a.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined ? (tail ? tail.split(":") : []) : null;
  if (t === null) return h.length === 8 ? h : null;
  const fill = 8 - h.length - t.length;
  if (fill < 0) return null;
  return [...h, ...Array(fill).fill("0"), ...t].map((x) => x.toLowerCase().replace(/^0+(?=.)/, ""));
}

/** 路径：去掉查询串与片段、控制字符，至多 200 字。 */
export function pathOf(url) {
  return String(url ?? "")
    .split(/[?#]/)[0]
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .slice(0, 200);
}

/** 闸门请求编号（x-kwl-request-id）：形状合格才记（与网关 clientRequestIdOf 同一口径）。 */
export function requestIdOf(v) {
  return typeof v === "string" && /^[A-Za-z0-9_-]{1,96}$/.test(v) ? v : null;
}

function pick(fields, rec) {
  const out = {};
  for (const k of fields) out[k] = rec[k] ?? null;
  return out;
}

/**
 * @param {{ role: string, dir: string | null, retentionDays?: number, feed?: { lastOk?: number | null, currentVersion?: number } | null, certPem?: string | null, now?: () => number }} o
 */
export function createObs(o) {
  const now = o.now ?? Date.now;
  const role = String(o.role);
  if (o.dir) mkdirSync(o.dir, { recursive: true, mode: 0o700 });
  const retentionDays = Number.isInteger(o.retentionDays) && o.retentionDays > 0 ? o.retentionDays : 190;
  const certExpiry = (() => {
    try {
      return o.certPem ? Date.parse(new X509Certificate(o.certPem).validTo) : null;
    } catch {
      return null;
    }
  })();
  const counts = new Map(); // "2xx" → n
  const hist = BUCKETS.map(() => 0);
  let histInf = 0;
  let histSum = 0;
  let inFlight = 0;
  let writeErrors = 0;
  const errors = new Map(); // code → n

  const day = () => new Date(now()).toISOString().slice(0, 10);
  const write = (kind, rec) => {
    if (!o.dir) return;
    try {
      appendFileSync(join(o.dir, `${kind}-${day()}.jsonl`), `${JSON.stringify(rec)}\n`, { mode: 0o600 });
    } catch {
      writeErrors += 1;
    }
  };

  /** 删除超过保留期的日志文件（只认本模块写的文件名）。 */
  const prune = () => {
    if (!o.dir) return 0;
    const cutoff = new Date(now() - retentionDays * 86_400_000).toISOString().slice(0, 10);
    let n = 0;
    for (const f of readdirSync(o.dir)) {
      const m = /^(access|error)-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
      if (m && m[2] < cutoff) {
        rmSync(join(o.dir, f), { force: true });
        n += 1;
      }
    }
    return n;
  };

  const feedAgeMs = () => (o.feed ? (o.feed.lastOk ? now() - o.feed.lastOk : Infinity) : null);

  /** 健康检查：命中返回 true（已应答）。 */
  const probe = (req, res) => {
    const path = pathOf(req.url);
    if (req.method !== "GET" || (path !== "/healthz" && path !== "/readyz")) return false;
    let ok = true;
    let reason = null;
    if (path === "/readyz") {
      const age = feedAgeMs();
      if (age !== null && age > FEED_STALE_MS) {
        ok = false;
        reason = "feed_stale";
      }
    }
    res.writeHead(ok ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(ok ? { ok: true } : { ok: false, reason }));
    return true;
  };

  /** 包住服务的请求处理：记访问日志与指标；健康检查在这里应答。 */
  const wrap = (handle) => (req, res) => {
    const t0 = now();
    const at = new Date(t0).toISOString();
    const method = METHODS.has(String(req.method)) ? String(req.method) : "OTHER";
    const path = pathOf(req.url);
    const clientRequestId = requestIdOf(req.headers?.["x-kwl-request-id"]);
    const net = netOf(req.socket?.remoteAddress);
    inFlight += 1;
    let done = false;
    res.once("close", () => {
      if (done) return;
      done = true;
      inFlight -= 1;
      const latency = now() - t0;
      const status = res.statusCode || 0;
      const cls = status >= 100 && status < 600 ? `${Math.floor(status / 100)}xx` : "other";
      counts.set(cls, (counts.get(cls) ?? 0) + 1);
      const s = latency / 1000;
      histSum += s;
      const i = BUCKETS.findIndex((b) => s <= b);
      if (i >= 0) hist[i] += 1;
      else histInf += 1;
      write("access", pick(ACCESS_FIELDS, { at, role, method, path, status, latency_ms: latency, client_request_id: clientRequestId, net }));
    });
    if (probe(req, res)) return;
    handle(req, res);
  };

  /** 进程级未处理异常：只记代码与类别。 */
  const recordError = (kind, e) => {
    const code = typeof e?.code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(e.code) ? e.code : typeof e?.name === "string" && /^[A-Za-z]{1,40}$/.test(e.name) ? e.name : "Error";
    errors.set(code, (errors.get(code) ?? 0) + 1);
    write("error", pick(ERROR_FIELDS, { at: new Date(now()).toISOString(), role, kind, code }));
  };

  /** Prometheus 文本格式的指标（只有计数、耗时与时效）。 */
  const metricsText = () => {
    const L = `role="${role}"`;
    const lines = [
      "# HELP kwl_requests_total 请求数（按状态码类别）",
      "# TYPE kwl_requests_total counter",
      ...[...counts].map(([c, n]) => `kwl_requests_total{${L},code_class="${c}"} ${n}`),
      "# HELP kwl_request_duration_seconds 请求耗时",
      "# TYPE kwl_request_duration_seconds histogram",
    ];
    let cum = 0;
    BUCKETS.forEach((b, i) => {
      cum += hist[i];
      lines.push(`kwl_request_duration_seconds_bucket{${L},le="${b}"} ${cum}`);
    });
    cum += histInf;
    lines.push(`kwl_request_duration_seconds_bucket{${L},le="+Inf"} ${cum}`, `kwl_request_duration_seconds_sum{${L}} ${histSum.toFixed(3)}`, `kwl_request_duration_seconds_count{${L}} ${cum}`);
    lines.push("# TYPE kwl_in_flight_requests gauge", `kwl_in_flight_requests{${L}} ${inFlight}`);
    const age = feedAgeMs();
    if (age !== null) {
      lines.push("# HELP kwl_feed_age_seconds 距上次取到控制面吊销集的时间（撤权传播的上限）", "# TYPE kwl_feed_age_seconds gauge", `kwl_feed_age_seconds{${L}} ${Number.isFinite(age) ? (age / 1000).toFixed(1) : "+Inf"}`);
      if (typeof o.feed?.currentVersion === "number") lines.push("# TYPE kwl_feed_version gauge", `kwl_feed_version{${L}} ${o.feed.currentVersion}`);
    }
    if (certExpiry !== null) lines.push("# HELP kwl_tls_cert_expiry_seconds 服务证书剩余有效期", "# TYPE kwl_tls_cert_expiry_seconds gauge", `kwl_tls_cert_expiry_seconds{${L}} ${Math.round((certExpiry - now()) / 1000)}`);
    lines.push("# TYPE kwl_process_errors_total counter", ...[...errors].map(([c, n]) => `kwl_process_errors_total{${L},code="${c}"} ${n}`));
    lines.push("# TYPE kwl_log_write_errors_total counter", `kwl_log_write_errors_total{${L}} ${writeErrors}`);
    return `${lines.join("\n")}\n`;
  };

  /** 指标监听的处理函数：GET /metrics；令牌（如配置）按常量时间比较。 */
  const metricsHandler = (token) => (req, res) => {
    if (req.method !== "GET" || pathOf(req.url) !== "/metrics") {
      res.writeHead(404).end();
      return;
    }
    if (token) {
      const got = String(req.headers?.authorization ?? "");
      const want = `Bearer ${token}`;
      let diff = got.length ^ want.length;
      for (let i = 0; i < want.length; i += 1) diff |= (got.charCodeAt(i) || 0) ^ want.charCodeAt(i);
      if (diff !== 0) {
        res.writeHead(401).end();
        return;
      }
    }
    res.writeHead(200, { "content-type": "text/plain; version=0.0.4", "cache-control": "no-store" });
    res.end(metricsText());
  };

  return { wrap, probe, recordError, metricsText, metricsHandler, prune };
}
