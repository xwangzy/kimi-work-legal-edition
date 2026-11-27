/**
 * 第 73 批（V47，D-309，契约 02 §2.6）：管理员一步开通 / 续期“同事之间同步”（律所策略的 share_relay 放宽项）的纯函数。
 *
 * - 开通：以**当前生效规则**为底稿只改 share_relay（其它项原样带上——不把别的放宽项静默收紧，也不静默放宽）；
 * - 续期：按最后一份已接受的律所策略原样重签（新版本、新有效期；已过期的续期即恢复那一份——界面据 carry_relaxations 写明“续期后仍允许什么”）；
 * - 状态：allowed / not_allowed / pending_second_signature / expired；到期前 7 天提醒。
 * 签名仍在本机管理员设备上做（门限：团队版 1、律所版 2），这里只算底稿、比对草稿、数签名人。
 */
import { canonicalJson } from "@zr-legal/keys";
import { policyRelaxations, validatePolicyBody, type FirmPolicyBody } from "@zr-legal/firm-trust";

export const SHARE_RELAY_EXPIRING_DAYS = 7;
const DAY = 86_400_000;

export type ShareRelayState = "allowed" | "not_allowed" | "pending_second_signature" | "expired";

/** 规范化后的策略体（认不出 → null）。 */
export function normalizedBody(b: unknown): FirmPolicyBody | null {
  const v = validatePolicyBody(b);
  return v.ok ? v.value : null;
}

/** 两份策略体是否一致（规范化后按规范 JSON 比较）。纯函数。 */
export function sameBody(a: unknown, b: unknown): boolean {
  const x = normalizedBody(a);
  const y = normalizedBody(b);
  return !!x && !!y && canonicalJson(x) === canonicalJson(y);
}

/** 开通的底稿：当前生效规则 + share_relay allow（其余字段原样）。纯函数。 */
export function enableBodyOf(effective: FirmPolicyBody): FirmPolicyBody {
  const b = normalizedBody(effective);
  if (!b) throw new Error("生效规则认不出");
  return { ...b, share_relay: "allow" };
}

/** 底稿里随这次签名一并带上的其它放宽项（不含 share_relay 本身）——界面写明“同时仍允许：…”。纯函数。 */
export function carriedRelaxations(body: FirmPolicyBody | null): string[] {
  return body ? policyRelaxations(body).filter((r) => r !== "share_relay:allow") : [];
}

/** 剩余天数（向上取整；已到期为 0）。纯函数。 */
export function daysLeftOf(expiresAt: string | null, now: number): number | null {
  if (!expiresAt) return null;
  const t = Date.parse(expiresAt);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.ceil((t - now) / DAY));
}

/** 是否进入到期提醒（生效中且 ≤ 7 天）。纯函数。 */
export function expiringOf(state: ShareRelayState, expiresAt: string | null, now: number): { days_left: number } | null {
  if (state !== "allowed") return null;
  const d = daysLeftOf(expiresAt, now);
  return d !== null && d <= SHARE_RELAY_EXPIRING_DAYS ? { days_left: d } : null;
}

/** 草稿上已签名的成员数（同一成员多台设备只算一次——门限按成员计）。纯函数。 */
export function signerCount(signedBy: readonly { member_id: string }[]): number {
  return new Set(signedBy.map((s) => s.member_id)).size;
}

/**
 * 状态（纯函数）：生效规则允许 → allowed；有等别的管理员签名的开通草稿 → pending_second_signature；
 * 最后一份已接受策略允许、但现在回退到最严（过期、签名人不足、认不出更新版本）→ expired；其余 not_allowed。
 */
export function shareRelayStateOf(o: { effectiveAllows: boolean; fallback: boolean; latestAllows: boolean; pendingEnable: boolean }): ShareRelayState {
  if (o.effectiveAllows) return "allowed";
  if (o.pendingEnable) return "pending_second_signature";
  if (o.fallback && o.latestAllows) return "expired";
  return "not_allowed";
}

/**
 * 第 73 批（P2-1）：同事之间同步用不了是不是因为没有席位（没分配到，或管理员释放 / 收回了名额）。纯函数。
 * credentialError：中继凭据最近一次申领失败的原因（credential_no_seat / credential_seat_revoked）；
 * seatStep：最近一次控制面同步时席位这一步的结果（no_seat / seat_revoked）；hasSeatToken：本机此刻有没有席位令牌。
 */
export function seatProblemOf(credentialError: string | null, seatStep: string | null | undefined, hasSeatToken: boolean): boolean {
  if (credentialError === "credential_no_seat" || credentialError === "credential_seat_revoked") return true;
  return (seatStep === "no_seat" || seatStep === "seat_revoked") && !hasSeatToken;
}

/**
 * 第 73 批：同事之间同步是不是“开通后又关闭”了（纯函数；只用于显示，再开通与首次开通同一流程——D-311）：现行生效规则来自控制面且明确不允许，而更早某一版允许过。
 * closed_at = 最后一次允许之后第一版不允许的生效时刻。规则回退（过期、签名人不足）不算关闭（那是“已过期”）。
 */
export function shareRelayClosedOf(effectiveFromControlPlane: boolean, effectiveAllows: boolean, history: readonly { version: number; allow: boolean; at: string }[]): { closed: boolean; closed_at: string | null } {
  if (!effectiveFromControlPlane || effectiveAllows) return { closed: false, closed_at: null };
  const sorted = [...history].sort((a, b) => a.version - b.version);
  let lastAllow = -1;
  sorted.forEach((h, i) => {
    if (h.allow) lastAllow = i;
  });
  if (lastAllow < 0) return { closed: false, closed_at: null };
  const firstOff = sorted.slice(lastAllow + 1).find((h) => !h.allow);
  return firstOff ? { closed: true, closed_at: firstOff.at } : { closed: false, closed_at: null };
}
