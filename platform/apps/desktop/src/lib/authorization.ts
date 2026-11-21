/**
 * 客户授权的纯函数（第 48 批，D-202；界面见 components/Consent.tsx）。可单测。
 */
import type { MatterBasis } from "../api.ts";

/** 新建事项时这一案的授权情况。 */
export type AuthChoice = "authorized" | "pending" | "local_only";
/** 四项依据怎么记下的（内核 basis_source）。 */
export type BasisSource = "engagement_terms" | "confirmed" | null;

/** 选“已取得”时记录的四项：委托/保密、个人信息、次处理者为已确认；敏感事项的特别条件仍待确认（须逐案确认）。 */
export function basisForChoice(choice: AuthChoice, sensitiveMatter: boolean): MatterBasis {
  if (choice === "authorized") return { engagement: "confirmed", personal_info: "confirmed", sensitive: sensitiveMatter ? "pending" : "not_applicable", subprocessor: "confirmed" };
  return { engagement: "pending", personal_info: "pending", sensitive: sensitiveMatter ? "pending" : "not_applicable", subprocessor: "pending" };
}

/** 开始任务时补记授权：只把待确认的项改为已确认；“不适用”保持；敏感项只在律师勾选了单独同意时确认。 */
export function basisAfterConfirm(cur: MatterBasis | undefined, opts: { general: boolean; sensitive: boolean }): MatterBasis {
  const b: MatterBasis = cur ?? { engagement: "pending", personal_info: "pending", sensitive: "not_applicable", subprocessor: "pending" };
  const up = (v: MatterBasis[keyof MatterBasis], on: boolean) => (on && v === "pending" ? "confirmed" : v);
  return { engagement: up(b.engagement, opts.general), personal_info: up(b.personal_info, opts.general), subprocessor: up(b.subprocessor, opts.general), sensitive: up(b.sensitive, opts.sensitive) };
}

/** 补记时要律师确认哪几项：一般授权（委托/个人信息/次处理者有待确认）与敏感个人信息的单独同意。 */
export function confirmNeeds(b: MatterBasis | undefined): { general: boolean; sensitive: boolean } {
  if (!b) return { general: true, sensitive: false };
  return { general: b.engagement === "pending" || b.personal_info === "pending" || b.subprocessor === "pending", sensitive: b.sensitive === "pending" };
}

/** 事项里“客户授权”一句话（事项头、事项列表共用）。第 51 批：带上依据出处（截短；完整出处在悬停与事项日志里）。 */
export function authorizationLine(m: { consent_status?: string; basis_complete?: boolean; basis_source?: string | null; basis_ref?: string | null; basis_reconfirm?: boolean; data_level?: string }): string {
  if (m.consent_status === "refused" || m.data_level === "L3b") return "客户要求不上云";
  if (!m.basis_complete) return "尚未记录客户授权";
  // 次处理者清单更新后，按旧清单记录的授权须重新确认（内核 basis_reconfirm；下次用 AI 时在开始前确认里处理）
  if (m.basis_reconfirm) return "须重新确认 · AI 次处理者有变化";
  const ref = m.basis_ref ? `（${shortRef(m.basis_ref)}）` : "";
  if (m.basis_source === "engagement_terms") return `已取得 · 按委托合同条款${ref}`;
  if (m.basis_source === "separate_consent") return `已取得 · 客户书面同意${ref}`;
  return m.basis_source === "confirmed" ? "已取得 · 律师确认" : "已取得";
}

/* ── 第 51 批（D-216）：每个事项第一次用 AI 时逐案记录授权依据 ──
   合规核验结论：律师点“确认”不等于客户授权；授权依据是每一份委托合同（或客户的书面同意），不是律师的一次声明。
   所以记录的是“依据类型 + 可核对的出处 + 当时告知的次处理者清单版本”，设置里的常用条款只用来预填。 */

/** 授权依据的类型（内核 basis_source）。 */
export type BasisKind = "engagement_terms" | "separate_consent";
export const BASIS_KIND_LABELS: Record<BasisKind, { label: string; hint: string; placeholder: string }> = {
  engagement_terms: { label: "委托合同中的 AI 条款", hint: "合同里写明使用 AI 辅助及次处理者", placeholder: "合同名称或编号、条款号，如：委托代理合同（2026）沪律字第 123 号 第 9 条" },
  separate_consent: { label: "客户单独书面同意", hint: "补充协议、确认函、邮件等", placeholder: "日期与方式，如：2026-11-18 客户邮件书面同意" },
};
/** 出处最长 200 字（与内核同一上限）。 */
export const BASIS_REF_MAX = 200;

/** 记录表单的状态。 */
export interface AuthRecord {
  kind: BasisKind | null;
  ref: string;
  /** 敏感个人信息已取得单独同意（只在敏感事项要求）。 */
  sensitive: boolean;
}

/**
 * 记录表单的初始值：重新确认（次处理者清单变了）时沿用本事项原来的依据；律师设了常用条款时预选“委托合同中的 AI 条款”并填好出处；
 * 否则不预选（不替律师选）。纯函数。
 */
export function initialRecord(defaults: { engagement_terms?: boolean; default_ref?: string | null } | null | undefined, matter: { basis_source?: string | null; basis_ref?: string | null }): AuthRecord {
  if ((matter.basis_source === "engagement_terms" || matter.basis_source === "separate_consent") && matter.basis_ref) return { kind: matter.basis_source, ref: matter.basis_ref, sensitive: false };
  if (defaults?.engagement_terms && defaults.default_ref) return { kind: "engagement_terms", ref: defaults.default_ref, sensitive: false };
  return { kind: null, ref: "", sensitive: false };
}

/** 能不能提交：选了依据类型、写了出处（不超长），敏感事项另勾了单独同意。纯函数。 */
export function recordReady(r: AuthRecord, needSensitive: boolean): boolean {
  const ref = r.ref.trim();
  return !!r.kind && ref.length > 0 && ref.length <= BASIS_REF_MAX && (!needSensitive || r.sensitive);
}

/** 本事项的授权是否因次处理者清单更新而须重新确认（旧记录没有版本的不算）。纯函数。 */
export function needsReconfirm(m: { basis_notice_version?: string | null }, current: string | null | undefined): boolean {
  return !!m.basis_notice_version && !!current && m.basis_notice_version !== current;
}

/** 出处截短到 24 字（列表与事项头用）。 */
export function shortRef(ref: string): string {
  const t = ref.replace(/\s+/g, " ").trim();
  return t.length > 24 ? `${t.slice(0, 23)}…` : t;
}

