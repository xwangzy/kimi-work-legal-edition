/**
 * 上游传输安全——纯检查部分（不含网络客户端，内核与界面状态可复用）。
 *
 * 上游传输安全（隐私安全审查 P0-5 / 2026-10-13 审计 S5；第 04 篇 §5.1“目的地固定”）。
 *
 * 闸门发往模型网关、检索服务、自带密钥/私有模型端点与控制面的请求体是令牌化后的案卷内容与席位凭据，过境必须加密且不能被改投：
 *
 * - **只认 https**：非回环地址的 http 一律拒绝；回环地址的 http 只在开发形态允许（`allowLoopbackHttp`，安装包形态为 false）；
 *   地址里带用户名口令的一律拒绝（凭据只经请求头）；
 * - **证书校验不放宽**：始终 `rejectUnauthorized`、TLS ≥ 1.2；闸门进程不继承内核环境（`NODE_TLS_REJECT_UNAUTHORIZED` 等进不来），
 *   启动时若发现被放宽即拒绝工作（main.ts）；
 * - **公钥钉住（SPKI，pin-sha256 语义）**：中软网关、检索服务与控制面的钉住集随客户端构建固定（当前 + 备份），证书链中任一证书的
 *   SubjectPublicKeyInfo 摘要命中即通过，否则在发送任何请求字节之前断开（握手阶段），去向记录写 `tls_pin_mismatch`；
 *   律所私有端点不钉住，可附律所内部 CA（只对该端点生效）。
 *
 * 注意：Node 证书对象的 `pubkey` 对 EC 密钥是裸公钥点而非 SPKI DER（2026-10-13 本机实测），摘要必须取 X509Certificate 导出的 SPKI。
 */
import { createHash, X509Certificate } from "node:crypto";

/** 钉住值的形态：`sha256/<base64 的 32 字节摘要>`（与 HPKP pin-sha256、curl --pinnedpubkey 相同）。 */
export const PIN_RE = /^sha256\/[A-Za-z0-9+/]{43}=$/;

export type TransportState = "pinned" | "tls" | "insecure_loopback" | "invalid" | "none";

export interface TransportCheck {
  state: TransportState;
  /** 拒绝原因（state = invalid 时）。 */
  reason: string | null;
}

/** 证书的 SPKI 钉住值。 */
export function spkiPin(certDer: Buffer): string {
  const spki = new X509Certificate(certDer).publicKey.export({ type: "spki", format: "der" });
  return `sha256/${createHash("sha256").update(spki).digest("base64")}`;
}

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h === "::1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** 规范化钉住集：去空白、去重；任一项形态不合法即整组无效（返回 null）。 */
export function normalizePins(pins: readonly string[] | null | undefined): string[] | null {
  if (!pins) return [];
  const out = new Set<string>();
  for (const raw of pins) {
    const p = String(raw).trim();
    if (!p) continue;
    if (!PIN_RE.test(p)) return null;
    out.add(p);
  }
  return [...out];
}

/**
 * 上游地址是否可用（纯函数）：返回传输状态与拒绝原因。`requirePins`：安装包形态下中软网关、检索服务与控制面必须带钉住集。
 */
export function checkUpstream(
  raw: string | null | undefined,
  o: { allowLoopbackHttp: boolean; pins?: readonly string[] | null; requirePins?: boolean },
): TransportCheck {
  if (!raw) return { state: "none", reason: null };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { state: "invalid", reason: "upstream_url_invalid" };
  }
  if (u.username || u.password) return { state: "invalid", reason: "upstream_url_credentials" };
  const pins = normalizePins(o.pins);
  if (pins === null) return { state: "invalid", reason: "upstream_pins_malformed" };
  if (u.protocol === "http:") {
    if (isLoopbackHost(u.hostname) && o.allowLoopbackHttp) return { state: "insecure_loopback", reason: null };
    return { state: "invalid", reason: "upstream_tls_required" };
  }
  if (u.protocol !== "https:") return { state: "invalid", reason: "upstream_url_invalid" };
  if (pins.length > 0) return { state: "pinned", reason: null };
  if (o.requirePins) return { state: "invalid", reason: "upstream_pins_missing" };
  return { state: "tls", reason: null };
}

