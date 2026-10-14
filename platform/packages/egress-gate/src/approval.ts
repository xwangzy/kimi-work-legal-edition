/**
 * 出站批准凭据（v9 第 02 篇 §9.5：批准绑定主体、事项、动作、参数摘要、对象、目的地、期限与 nonce；执行前重验，范围变化即重新批准；
 * §9.2：每个强制点独立强制，不相信别处的“已批准”）。收敛偏离 D-16。
 *
 * - 律师在可信界面确认跨边界动作（含当事人的检索、新域名抓取、图像原样送模型）后，内核以本机设备签名密钥签发凭据；
 * - 出站闸门在原本要拒绝的那一刻，按（运行、用途、出站内容摘要、目的地）向内核取凭据，并用设备公钥**独立核验**签名与每个绑定字段；
 *   宿主与模型文本里的“已批准”不构成任何凭据；
 * - 序列化只有这一份（内核签名与闸门验签共用），键按字典序、值只含字符串、数字与 null。
 */
import { verify as cryptoVerify } from "node:crypto";
import { createHash } from "node:crypto";

export type ApprovalPurpose = "search" | "fetch" | "media";

export interface ApprovalCredential {
  v: 1;
  approval_id: string;
  tid: string;
  uid: string;
  mid: string;
  rid: string;
  /** 签名设备（闸门按此取公钥）。 */
  dev: string;
  /** 批准渠道（desktop / office / mobile）。 */
  channel: string;
  purpose: ApprovalPurpose;
  /**
   * 出站内容摘要：检索 = egressDigest("WebSearch", 查询)；抓取 = egressDigest("FetchURL", URL)；“本任务内”为 null；
   * 图像在首次使用时由内核绑定为载荷摘要并**重新签名**（复核 S5-B05：绑定值在签名之内），未绑定时为 null（闸门不受理）。
   */
  digest: string | null;
  /** 目的地：检索 = search_service；抓取 = 主机名；图像 = model。 */
  dest: string;
  /** 检索：原文放行（只保留明文书写的机构名称）或改写后放行（泛化）；“本任务内”的检索只能是改写后（第 02 篇 §8.3）。 */
  variant: "original" | "generalized" | null;
  scope: "once" | "task";
  nonce: string;
  /** 截止时间（ISO）。 */
  exp: string;
  /**
   * 签发时事项的审批策略指纹（复核 S5-B02/B18）：只由与批准有关的事项字段（密级、同意状态、四项依据、端点、全部化名、协作范围）算出——
   * 这些变化后旧批准失效、须重新确认；当事人词典的增改（只影响令牌化，闸门出站时按当前词典重筛）不使批准失效。
   */
  pol: string;
}

export interface SignedApproval {
  credential: ApprovalCredential;
  /** Ed25519 签名（base64url），签名内容为 canonicalCredential(credential)。 */
  signature: string;
}

/** G0 能作出确认的渠道（第 02 篇 §9.6：桌面；Word/WPS 与手机随 G1/G2 接入，各自有确认范围）。 */
export const APPROVAL_CHANNELS: readonly string[] = ["desktop"];

/** 出站内容摘要（与 kap-host 宿主策略、宿主出口同一算法）。 */
export function egressDigest(tool: "WebSearch" | "FetchURL", value: string): string {
  return createHash("sha256").update(`${tool}\u0000${value}`).digest("hex");
}

export function canonicalCredential(c: ApprovalCredential): string {
  const keys = Object.keys(c).sort() as (keyof ApprovalCredential)[];
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const v = c[k];
    if (v !== null && typeof v !== "string" && typeof v !== "number") throw new Error(`批准凭据字段 ${k} 不是标量`);
    out[k] = v;
  }
  return JSON.stringify(out);
}

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export interface ApprovalExpectation {
  tid: string;
  /** 运行发起人（任务令牌里的用户）：批准人须是发起人本人（第 02 篇 §9.6 桌面渠道“本人事项内”）。 */
  uid: string;
  mid: string;
  rid: string;
  purpose: ApprovalPurpose;
  /** 闸门按实际出站内容算出的摘要（检索、抓取）；图像为载荷摘要。 */
  digest: string;
  /** 实际目的地（检索 = search_service；抓取 = 本跳主机；图像 = model）。 */
  dest: string;
  /** 当前事项的审批策略指纹（与凭据签发时一致才有效）。 */
  pol: string;
  /** 只接受“本次”（L3a 检索逐条确认；第 02 篇 §8.2）。 */
  requireOnce?: boolean;
  /** 可作出确认的渠道（缺省 APPROVAL_CHANNELS）。 */
  channels?: readonly string[];
  now?: number;
}

/**
 * 闸门侧核验：签名（设备公钥）、版本、租户与批准人、渠道、事项与运行、用途、目的地、期限、审批策略指纹、范围，
 * 以及摘要（“本次”检索与抓取 = 出站内容；图像 = 已签名绑定的载荷）。nonce 随签名固定，“本次”的一次性由闸门按凭据记账（server.ts）与内核原子消费双重保证。
 * 任一不符即拒绝（失败关闭），返回原因码写入去向记录。
 */
export function verifyApproval(s: SignedApproval | null | undefined, publicKeys: Readonly<Record<string, string>>, e: ApprovalExpectation): { ok: true; credential: ApprovalCredential } | { ok: false; reason: string } {
  if (!s || !s.credential || typeof s.signature !== "string") return { ok: false, reason: "approval_missing" };
  const c = s.credential;
  const pem = publicKeys[c.dev];
  if (!pem) return { ok: false, reason: "approval_unknown_device" };
  let valid = false;
  try {
    valid = cryptoVerify(null, Buffer.from(canonicalCredential(c), "utf8"), pem, b64urlDecode(s.signature));
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "approval_bad_signature" };
  if (c.v !== 1) return { ok: false, reason: "approval_version" };
  if (c.tid !== e.tid || c.mid !== e.mid || c.rid !== e.rid) return { ok: false, reason: "approval_scope_mismatch" };
  if (c.uid !== e.uid) return { ok: false, reason: "approval_subject_mismatch" };
  if (!(e.channels ?? APPROVAL_CHANNELS).includes(c.channel)) return { ok: false, reason: "approval_channel_not_allowed" };
  if (c.purpose !== e.purpose) return { ok: false, reason: "approval_purpose_mismatch" };
  if (c.dest !== e.dest) return { ok: false, reason: "approval_destination_mismatch" };
  const exp = Date.parse(c.exp);
  if (!Number.isFinite(exp) || exp <= (e.now ?? Date.now())) return { ok: false, reason: "approval_expired" };
  if (typeof c.pol !== "string" || c.pol !== e.pol) return { ok: false, reason: "approval_policy_changed" };
  if (c.scope === "task" && e.requireOnce) return { ok: false, reason: "approval_scope_mismatch" };
  if (e.purpose === "media") {
    // 图像只能逐次批准；绑定的载荷摘要在签名之内
    if (c.scope !== "once") return { ok: false, reason: "approval_scope_mismatch" };
    if (c.digest === null) return { ok: false, reason: "approval_unbound" };
    if (c.digest !== e.digest) return { ok: false, reason: "approval_digest_mismatch" };
  } else if (c.scope === "once") {
    if (c.digest !== e.digest) return { ok: false, reason: "approval_digest_mismatch" };
  } else {
    if (c.digest !== null) return { ok: false, reason: "approval_scope_mismatch" };
    // “本任务内”的检索只能是改写后放行（第 02 篇 §8.3：任务级授权只有“本任务泛化后放行”）
    if (c.purpose === "search" && c.variant !== "generalized") return { ok: false, reason: "approval_variant_not_allowed" };
  }
  return { ok: true, credential: c };
}
