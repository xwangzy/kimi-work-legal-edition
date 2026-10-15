/**
 * 控制面通道（v9 第 04 篇 §5.1 表“控制面、更新、中继｜主进程、同步客户端｜目的地固定；只出元数据或密文｜中软云”；
 * §1.2 第 3 条“出站闸门是唯一出口”）。
 *
 * 内核不直接联网：席位、许可、目录、策略、连接器目录、租户盐与事项匿名摘要的请求经 IPC 交给闸门，由闸门发往**本机配置固定的**
 * 控制面地址。只有内核持有 IPC 通道（Agent 宿主与执行域都到不了这里）；路径、方法与请求头按白名单，请求体与响应大小有上限。
 * 闸门不解析、不记录请求与响应内容（内容是元数据与签名文档，核验在内核）。
 */
import { transportFailureReason, type TransportCheck } from "./tls-policy.ts";

export interface CpRelayRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

export type CpRelayResult = { ok: true; status: number; body: string } | { ok: false; reason: string };

const PATHS: readonly RegExp[] = [
  /^\/v1\/enroll$/,
  /^\/v1\/devices\/register$/,
  /^\/v1\/directory$/,
  /^\/v1\/license$/,
  /^\/v1\/tenant-salt$/,
  /^\/v1\/seat-token$/,
  /^\/v1\/policy$/,
  /^\/v1\/connectors$/,
  /^\/v1\/connectors\/[a-z][a-z0-9_-]{1,40}$/,
  /^\/v1\/drafts$/,
  /^\/v1\/drafts\/drf_[0-9a-f]{16}(?:\/signatures|\/publish)?$/,
  /^\/v1\/anon-matters\/[A-Za-z0-9_-]{16,64}$/,
  /^\/v1\/devices\/[A-Za-z0-9_-]{1,200}\/revoke$/,
  /^\/v1\/seats\/[A-Za-z0-9_-]{1,200}\/revoke$/,
  // 第 9 批：用量与上限（S3）、中软侧操作记录（S14，只许这一种查询串）
  /^\/v1\/quota$/,
  /^\/v1\/support-token$/,
  /^\/v1\/quota\/cap$/,
  /^\/v1\/audit\?after=\d{1,15}&limit=\d{1,3}$/,
];
const METHODS = new Set(["GET", "POST", "PUT", "DELETE"]);
const HEADERS = new Set(["x-kwl-tenant", "x-kwl-device", "x-kwl-ts", "x-kwl-nonce", "x-kwl-sig"]);
export const CP_MAX_REQUEST_BYTES = 256 * 1024;
/** 响应上限（设备目录约 0.6 KB/台：8 MiB 约一万三千台；分页或增量下发在 G1——复核 S6-B23）。 */
export const CP_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** 请求是否在控制面通道的白名单内（纯函数，便于用例覆盖）。 */
export function cpRelayAllowed(req: CpRelayRequest): string | null {
  if (!METHODS.has(String(req.method).toUpperCase())) return "cp_method_not_allowed";
  if (typeof req.path !== "string" || req.path.length > 300 || req.path.includes("..") || !PATHS.some((re) => re.test(req.path))) return "cp_path_not_allowed";
  if (!req.headers || typeof req.headers !== "object") return "cp_headers_invalid";
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HEADERS.has(k.toLowerCase()) || typeof v !== "string" || v.length > 512 || /[\r\n]/.test(v)) return "cp_header_not_allowed";
  }
  if (typeof req.body !== "string" || Buffer.byteLength(req.body) > CP_MAX_REQUEST_BYTES) return "cp_body_too_large";
  return null;
}

export async function relayControlPlane(
  req: CpRelayRequest,
  o: { baseUrl: string | null; fetchImpl?: typeof fetch; timeoutMs?: number; transport?: TransportCheck },
): Promise<CpRelayResult> {
  if (!o.baseUrl) return { ok: false, reason: "cp_not_configured" };
  // 传输（审计 S5）：控制面地址须 https（开发形态的回环除外），安装包形态须带内置钉住集
  if (o.transport?.state === "invalid") return { ok: false, reason: `cp_${o.transport.reason ?? "upstream_tls_required"}` };
  const bad = cpRelayAllowed(req);
  if (bad) return { ok: false, reason: bad };
  const base = o.baseUrl.replace(/\/+$/, "");
  // 以 URL 归一化之后的路径为准（复核 S6-B16：编码的点段会被解析成上一级目录）；查询串原样保留（白名单只许 /v1/audit 的一种）
  try {
    const u = new URL(`${base}${req.path}`);
    if (`${u.pathname}${u.search}` !== `${new URL(base).pathname.replace(/\/+$/, "")}${req.path}`) return { ok: false, reason: "cp_path_not_allowed" };
  } catch {
    return { ok: false, reason: "cp_path_not_allowed" };
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), o.timeoutMs ?? 15_000);
  try {
    const method = req.method.toUpperCase();
    const r = await (o.fetchImpl ?? globalThis.fetch)(`${base}${req.path}`, {
      method,
      headers: { ...req.headers, ...(method === "GET" ? {} : { "content-type": "application/json" }) },
      ...(method === "GET" ? {} : { body: req.body }),
      redirect: "error",
      signal: ac.signal,
    });
    const reader = r.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > CP_MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => {});
          return { ok: false, reason: "cp_response_too_large" };
        }
        chunks.push(value);
      }
    }
    return { ok: true, status: r.status, body: Buffer.concat(chunks).toString("utf8") };
  } catch (e) {
    if (ac.signal.aborted) return { ok: false, reason: "cp_timeout" };
    const r = transportFailureReason(e, false);
    return { ok: false, reason: r.startsWith("tls_") ? `cp_${r}` : "cp_unreachable" };
  } finally {
    clearTimeout(timer);
  }
}
