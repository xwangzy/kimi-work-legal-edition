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

/** 事项里“客户授权”一句话（事项头、事项列表共用）。 */
export function authorizationLine(m: { consent_status?: string; basis_complete?: boolean; basis_source?: string | null; data_level?: string }): string {
  if (m.consent_status === "refused" || m.data_level === "L3b") return "客户要求不上云";
  if (!m.basis_complete) return "尚未记录客户授权";
  return m.basis_source === "engagement_terms" ? "已取得 · 按委托合同条款" : m.basis_source === "confirmed" ? "已取得 · 律师确认" : "已取得";
}

